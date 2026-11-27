// Checkpoint assembly, concurrent chunk pooling, rolling-wave hierarchical folding,
// continuation wave scheduling, and manual compaction orchestration.
// Every exported function takes `engine` as its first argument and NEVER imports `../engine.js`.

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { DEFAULT_CONFIG } from '../config.js';
import { clearResumableCompaction, writeResumableCompaction } from '../state.js';
import { clearPendingContinuation, readPendingContinuation } from '../continuation-pending.js';
import {
  DEFAULT_CONTINUATION_WAVE_TOOL_SOURCE_REFS,
  continuationEligible,
  hasContinuation,
  selectContinuationRange,
  selectContinuationWave,
} from '../continuation.js';
import { selectCachePreservingRange } from '../cache-policy.js';
import { detectBiliSession } from '../foreign-fold.js';
import { isImageOffloadRequiredError, isUpstreamMultimodal400Error } from '../image-budget.js';
import { isBiliProxyPreflightError } from '../bili-conflict.js';
import { probeDiskLiveness, renderDiskLivenessNotice } from '../disk-liveness.js';
import {
  collectActiveWorkspaceFiles,
  resolveAdaptiveReinjectLimits,
  selectActiveWorkspaceFiles,
} from '../file-reinject.js';
import { noteDiagnosticMeasurement } from '../failure-diagnostics.js';
import { sourceKindOf, withReferencePolicy } from '../source-provenance.js';
import { isRateLimitError, runConcurrentPool } from '../concurrency.js';
import { combineSignals } from '../abort.js';
import { dumpAuditRejection } from '../audit-reject.js';
import { reconstructDisputedLines } from '../reconstruct.js';
import { normalizeRetryReasonCode } from '../progress-tracker.js';
import { approxTokens, blocksToText } from '../meter.js';
import {
  materializeUserMessageSection,
  summaryProse,
  validateCheckpointCoverage,
  validateSummaryStructure,
  validateUserMessageSection,
} from '../validate.js';
import { auditInstructionProvenance, summarizeProvenanceFailures } from '../audit.js';
import { auditMemorySelection, collectReferenceMessages } from '../constraint-scope.js';
import {
  CHECKPOINT_PREAMBLE,
  INTERMEDIATE_SUMMARY_TARGET_CHARS,
  SUMMARY_TARGET_CHARS,
  sanitizeFocusInstruction,
} from '../prompt.js';
import {
  deduplicateNotes,
  memoryDecisionsForSource,
  memoryPolicyInstruction,
  memoryRequirements,
  memorySourceRefs,
  retiredMemoryPresent,
} from '../memory-policy.js';
import { progressSourceRefs, validateProgressFacts } from '../progress-facts.js';
import { collectWorkReport, workReportRef } from '../work-report.js';
import {
  DEFAULT_MAX_CHUNK_TOOL_SOURCE_REFS,
  fitsCapacity,
  measureSummaryRange,
  planSummaryRange,
  resolveSummaryCapacity,
} from '../summary-budget.js';
import { latestDurableTarget, summarizeWithChain } from '../summary.js';
import { spanEntries } from '../history.js';
import { commitObservationMask, planObservationMask } from '../observation-mask.js';
import {
  assertCompactionInactive,
  buildCheckpointBlocks,
  buildSummarizationInput,
  collectArchivedFiles,
  collectChildArchiveIds,
  inspectCompactionEntryState,
  preservedForSource,
  selectCompactableRange,
  selectSessionMemory,
  systemHead,
  validateSurfaceRegion,
} from '../region.js';
import {
  canonicalMessageBytes,
  cleanupUncommittedArchive,
  combineBatchResults,
  estimateBulkChunkCount,
  isAbortError,
  isUnshrinkableTailError,
  nextCompactionId,
  resolveBulkFoldThreshold,
} from './shared.js';

/**
 * Build checkpoint blocks with archive pointer, bounded disk-liveness notice, and
 * adaptive active workspace file reinjection fitting under shadowed size bounds.
 * @param {object} engine
 * @param {object} opts
 */
export function buildSpanCheckpointWithMetadata(
  engine,
  {
    session,
    shadowedSeqs,
    policy,
    compactionId,
    summaryBlocks,
    summaryText = '',
    pinnedRules = '',
    preserved,
    workReport,
    progress,
    shadowedTokenCount,
    shadowedCanonicalBytes,
    archivedFiles = [],
    childArchiveIds = [],
    budgetSpec = null,
    spanIoCache = null,
    onReinjectMeasured = null,
    suppressTelemetry = false,
  },
) {
  const cleanPinnedRules = typeof pinnedRules === 'string' && pinnedRules.trim().length > 0 ? pinnedRules.trim() : '';
  const safeFiles = Array.isArray(archivedFiles) ? archivedFiles : [];
  const safeChildIds = Array.isArray(childArchiveIds) ? childArchiveIds : [];
  const archiveBase = policy?.archiveEnabled && engine.historyToolsAvailable
    ? {
        compactionId,
        startSeq: shadowedSeqs[0],
        endSeq: shadowedSeqs.at(-1),
        files: safeFiles,
        ...(safeChildIds.length > 0 ? { childIds: safeChildIds } : {}),
      }
    : null;

  let fullNotice = '';
  let missingOnlyNotice = '';
  if ((policy?.diskLivenessCheck ?? DEFAULT_CONFIG.diskLivenessCheck) !== false) {
    const resolvedSummaryText = summaryText || blocksToText(summaryBlocks);
    let cachedLiveness = spanIoCache?.livenessBySummary?.get(resolvedSummaryText);
    if (!cachedLiveness) {
      const probe = probeDiskLiveness({
        session,
        shadowedSeqs,
        archivedFiles: safeFiles,
        summaryText: resolvedSummaryText,
      });
      cachedLiveness = {
        fullNotice: renderDiskLivenessNotice(probe),
        missingOnlyNotice: renderDiskLivenessNotice(probe, { includeModified: false }),
      };
      if (spanIoCache?.livenessBySummary) {
        if (spanIoCache.livenessBySummary.size >= 16) spanIoCache.livenessBySummary.clear();
        spanIoCache.livenessBySummary.set(resolvedSummaryText, cachedLiveness);
      }
    }
    fullNotice = cachedLiveness.fullNotice;
    missingOnlyNotice = cachedLiveness.missingOnlyNotice;
  }

  const reinjectEnabled = (policy?.postCompactReinjectEnabled ?? DEFAULT_CONFIG.postCompactReinjectEnabled) !== false;
  const adaptive = reinjectEnabled
    ? resolveAdaptiveReinjectLimits({ policy, spec: engine._getBudgetSpec(session, budgetSpec) })
    : { maxFiles: 0, maxBytes: 0, maxFileBytes: 0, adaptiveApplied: false };
  const effectiveReinjectMaxBytes = adaptive.maxBytes;

  let fullActiveFiles = '';
  let fullReinjectFiles = 0;
  let fullReinjectBytes = 0;
  let shrunkActiveFiles = '';
  let shrunkReinjectFiles = 0;
  let shrunkReinjectBytes = 0;
  if (reinjectEnabled && adaptive.maxBytes > 0) {
    const reinjectKey = `${adaptive.maxFiles}:${adaptive.maxBytes}:${adaptive.maxFileBytes}`;
    let cachedReinject = spanIoCache?.reinjectByLimits?.get(reinjectKey);
    if (!cachedReinject) {
      const reinject = collectActiveWorkspaceFiles({
        session,
        shadowedSeqs,
        archivedFiles: safeFiles,
        maxFiles: adaptive.maxFiles,
        maxBytes: adaptive.maxBytes,
        maxFileBytes: adaptive.maxFileBytes,
      });
      let shrunkText = '';
      let shrunkFiles = 0;
      let shrunkBytes = 0;
      if (reinject.files.length > 0) {
        const shrunk = selectActiveWorkspaceFiles(reinject, {
          maxFiles: Math.min(2, reinject.files.length),
          maxBytes: Math.min(8192, Math.floor(adaptive.maxBytes / 3)),
        });
        shrunkText = shrunk.text;
        shrunkFiles = shrunk.files.length;
        shrunkBytes = shrunk.totalBytes;
      }
      cachedReinject = {
        fullActiveFiles: reinject.text,
        fullReinjectFiles: reinject.files.length,
        fullReinjectBytes: reinject.totalBytes,
        shrunkActiveFiles: shrunkText,
        shrunkReinjectFiles: shrunkFiles,
        shrunkReinjectBytes: shrunkBytes,
      };
      if (spanIoCache?.reinjectByLimits) {
        if (spanIoCache.reinjectByLimits.size >= 8) spanIoCache.reinjectByLimits.clear();
        spanIoCache.reinjectByLimits.set(reinjectKey, cachedReinject);
      }
    }
    fullActiveFiles = cachedReinject.fullActiveFiles;
    fullReinjectFiles = cachedReinject.fullReinjectFiles;
    fullReinjectBytes = cachedReinject.fullReinjectBytes;
    shrunkActiveFiles = cachedReinject.shrunkActiveFiles;
    shrunkReinjectFiles = cachedReinject.shrunkReinjectFiles;
    shrunkReinjectBytes = cachedReinject.shrunkReinjectBytes;
  }

  const build = (archive, diskLiveness, activeFiles = '') =>
    buildCheckpointBlocks(summaryBlocks, preserved, CHECKPOINT_PREAMBLE, {
      originalsInSummary: true,
      workReport,
      progress,
      ...(cleanPinnedRules ? { pinnedRules: cleanPinnedRules } : {}),
      ...(archive ? { archive } : {}),
      ...(diskLiveness ? { diskLiveness } : {}),
      ...(activeFiles ? { activeFiles } : {}),
    });

  const fits = (blocks) =>
    engine._estimateCheckpointTokens(blocks) < shadowedTokenCount &&
    canonicalMessageBytes([{ role: 'user', content: blocks }]) < shadowedCanonicalBytes;

  const emitAndReturn = (blocks, reinjectFiles = 0, reinjectBytes = 0) => {
    const info = { reinjectFiles, reinjectBytes, effectiveReinjectMaxBytes };
    if (typeof onReinjectMeasured === 'function') {
      onReinjectMeasured(info);
    }
    if (!suppressTelemetry) {
      engine._emitReinjectMeasured(session, info);
    }
    return blocks;
  };

  const tryWithActiveFiles = (archive, diskLiveness) => {
    if (fullActiveFiles) {
      const withFullActive = build(archive, diskLiveness, fullActiveFiles);
      if (fits(withFullActive)) {
        return { blocks: withFullActive, reinjectFiles: fullReinjectFiles, reinjectBytes: fullReinjectBytes };
      }
    }
    if (shrunkActiveFiles && shrunkActiveFiles !== fullActiveFiles) {
      const withShrunkActive = build(archive, diskLiveness, shrunkActiveFiles);
      if (fits(withShrunkActive)) {
        return { blocks: withShrunkActive, reinjectFiles: shrunkReinjectFiles, reinjectBytes: shrunkReinjectBytes };
      }
    }
    const withoutActive = build(archive, diskLiveness, '');
    if (fits(withoutActive)) return { blocks: withoutActive, reinjectFiles: 0, reinjectBytes: 0 };
    return null;
  };

  if (archiveBase) {
    const withFull = tryWithActiveFiles(archiveBase, fullNotice);
    if (withFull) return emitAndReturn(withFull.blocks, withFull.reinjectFiles, withFull.reinjectBytes);
    if (missingOnlyNotice && missingOnlyNotice !== fullNotice) {
      const withMissingOnly = build(archiveBase, missingOnlyNotice, '');
      if (fits(withMissingOnly)) return emitAndReturn(withMissingOnly);
    }
    if (fullNotice || missingOnlyNotice) {
      const withoutLiveness = build(archiveBase, '', '');
      if (fits(withoutLiveness)) return emitAndReturn(withoutLiveness);
    }
    if (archiveBase.files.length > 0) {
      const withoutFiles = build({ ...archiveBase, files: [] }, '', '');
      if (fits(withoutFiles)) return emitAndReturn(withoutFiles);
    }
    if (Array.isArray(archiveBase.childIds) && archiveBase.childIds.length > 0) {
      const bareArchive = build({ compactionId, startSeq: shadowedSeqs[0], endSeq: shadowedSeqs.at(-1), files: [] }, '', '');
      if (fits(bareArchive)) return emitAndReturn(bareArchive);
    }
    return emitAndReturn(build(null, '', ''));
  }

  const withoutArchive = tryWithActiveFiles(null, fullNotice);
  if (withoutArchive) {
    return emitAndReturn(withoutArchive.blocks, withoutArchive.reinjectFiles, withoutArchive.reinjectBytes);
  }
  if (missingOnlyNotice && missingOnlyNotice !== fullNotice) {
    const withMissingOnly = build(null, missingOnlyNotice, '');
    if (fits(withMissingOnly)) return emitAndReturn(withMissingOnly);
  }
  return emitAndReturn(build(null, '', ''));
}

/**
 * Snapshot read-only inputs and metadata for a span before off-session generation.
 * @param {object} engine
 * @param {object} session
 * @param {number[]} seqs
 * @param {object} policy
 * @param {object} [opts]
 */
export function buildPrecomputedSliceSpec(
  engine,
  session,
  seqs,
  policy,
  { allowForeignFallback = false, snapshotPrecision = null, preservePrefixCache = false } = {},
) {
  const shadowedSeqs = [...seqs];
  const shadowedTokenCount = engine._shadowedTokens(session, shadowedSeqs);
  const shadowedCanonicalBytes = canonicalMessageBytes(
    shadowedSeqs.map((seq) => session.deriveEventMessage(session.eventAt(seq))).filter(Boolean),
  );
  const input = buildSummarizationInput(session, shadowedSeqs, {
    preservePrefixCache: Boolean(preservePrefixCache),
    policy,
  });
  const previousSummary = shadowedSeqs.some(
    (seq) => session.deriveEventMessage(session.eventAt(seq))?.source?.kind === 'compact-checkpoint',
  )
    ? 'inline checkpoint'
    : null;
  const memorySelection = selectSessionMemory(session, shadowedSeqs, {
    maxMessages: policy.preserveRecentMessages,
    maxTokens: policy.preserveRecentUserTokens,
    approxTokens,
  });
  const archivedFiles = collectArchivedFiles(session, shadowedSeqs);
  const childArchiveIds = policy.archiveEnabled && engine.historyToolsAvailable
    ? collectChildArchiveIds(session, shadowedSeqs)
    : [];
  const archiveEntries = policy.archiveEnabled
    ? spanEntries(session, shadowedSeqs, allowForeignFallback ? { allowForeignFallback: true } : undefined)
    : [];
  const workReport = collectWorkReport(session, shadowedSeqs);
  const progressSelection = input.progress;
  const sourceMemory = {
    progressFacts: progressSourceRefs(progressSelection),
    summaryScope: progressSelection?.scope,
    workReport: workReportRef(workReport),
    memoryRequirements: preservedForSource(memoryRequirements(memorySelection.active)) ?? [],
    memorySources: memorySourceRefs(memorySelection.active, session),
    memoryDecisions: memoryDecisionsForSource(memorySelection.decisions, session),
  };
  const auditSelection = policy.auditEnabled
    ? selectSessionMemory(session, shadowedSeqs, {
        approxTokens,
        coverageMaxMessages: policy.preserveRecentMessages,
        coverageMaxTokens: policy.preserveRecentUserTokens,
        includeRecentDirectSpan: true,
      })
    : null;
  return {
    start: shadowedSeqs[0],
    end: shadowedSeqs.at(-1),
    seqs: shadowedSeqs,
    shadowedSeqs,
    shadowedTokenCount,
    shadowedCanonicalBytes,
    shadowedTokenPrecision: snapshotPrecision ?? engine._lastPrecision?.get(session) ?? 'unknown',
    input,
    previousSummary,
    memorySelection,
    archivedFiles,
    childArchiveIds,
    archiveEntries,
    progressSelection,
    sourceMemory,
    auditSelection,
  };
}

function createPrecomputedSpanValidator(
  engine,
  {
    session,
    policy,
    compactionId,
    spec,
    preserved,
    expectedUserMessages,
    referenceMessages,
    memorySelection,
    progressSelection,
    progressPhase,
    softenCoverageForFocus,
    buildSpanCheckpoint,
  },
) {
  const { shadowedSeqs, shadowedTokenCount, shadowedCanonicalBytes } = spec;
  return (result) => {
    if (progressPhase === 'folding') {
      engine._trackUpdate(session, {
        phase: 'auditing',
        ...engine._computeCompressionProgress(session, shadowedSeqs, 0.90),
      });
    }
    const language = result?.language ?? (policy.language === 'zh' ? 'zh' : 'en');
    const structure = validateSummaryStructure(result?.rawText ?? '', { language });
    if (!structure.ok) return structure;
    result.modelRawOutput ??= result.summary;
    const retired = retiredMemoryPresent(result.rawText, memorySelection);
    if (retired) {
      return {
        ok: false,
        code: 'RETIRED_MEMORY_REINTRODUCED',
        message: `Remove the ${retired.reason} request from seq ${retired.seq}; it is no longer active.`,
      };
    }
    result.rawText = materializeUserMessageSection(deduplicateNotes(result.rawText, preserved), preserved, language);
    result.summary = [{ type: 'text', text: result.rawText }];
    const compiled = validateSummaryStructure(result.rawText, { language });
    const listed = validateUserMessageSection(compiled.userSectionBody, preserved);
    if (!listed.ok) return listed;
    let reinjectInfo = null;
    const blocks = buildSpanCheckpoint(result.summary, result.rawText, '', {
      suppressTelemetry: true,
      onReinjectMeasured: (info) => { reinjectInfo = info; },
    });
    const coverage = validateCheckpointCoverage(blocks, preserved, { expected: preserved });
    if (!coverage.ok) return coverage;
    const checkpointTokens = engine._estimateCheckpointTokens(blocks);
    const checkpointBytes = canonicalMessageBytes([{ role: 'user', content: blocks }]);
    if (checkpointTokens >= shadowedTokenCount || checkpointBytes >= shadowedCanonicalBytes) {
      const currentProseBytes = Buffer.byteLength(summaryProse(result.rawText), 'utf8');
      const fixedEnvelopeBytes = Math.max(0, checkpointBytes - currentProseBytes);
      const maxBytesFromCanonical = Math.max(0, shadowedCanonicalBytes - fixedEnvelopeBytes - 1);
      const tokenExcess = Math.max(0, checkpointTokens - shadowedTokenCount + 1);
      const maxBytesFromTokens = checkpointTokens >= shadowedTokenCount
        ? Math.max(0, currentProseBytes - tokenExcess * 4)
        : maxBytesFromCanonical;
      const maxSummaryBytes = Math.min(maxBytesFromCanonical, maxBytesFromTokens);
      const reduceByBytes = Math.max(1, currentProseBytes - maxSummaryBytes);
      const message = checkpointTokens >= shadowedTokenCount
        ? `complete checkpoint is not smaller than its source span (${checkpointTokens} >= ${shadowedTokenCount} tokens, ${checkpointBytes}/${shadowedCanonicalBytes} bytes; maxSummaryBytes=${maxSummaryBytes}, reduce summary prose by at least ${reduceByBytes} UTF-8 bytes)`
        : `complete checkpoint does not reduce canonical UTF-8 message bytes (${checkpointBytes} >= ${shadowedCanonicalBytes} bytes; maxSummaryBytes=${maxSummaryBytes}, reduce summary prose by at least ${reduceByBytes} UTF-8 bytes)`;
      return { ok: false, code: 'SUMMARY_NOT_SMALLER', message, maxSummaryBytes };
    }
    const progressVerdict = validateProgressFacts(result.rawText, progressSelection);
    if (!progressVerdict.ok) return progressVerdict;
    const provenance = auditInstructionProvenance({
      userMessages: memorySelection?.provenanceUserMessages ?? expectedUserMessages,
      retiredDecisions: memorySelection?.provenanceRetiredDecisions ?? memorySelection?.decisions,
      summaryText: result.rawText,
      referenceMessages,
    });
    if (provenance.length) {
      const provSummary = summarizeProvenanceFailures(provenance);
      if (provSummary.hardProvenance.length > 0 || policy.auditProvenanceBlock !== false) {
        const built = engine._buildProvenanceError(
          provSummary,
          'Generated instructions or permissions have no matching user source.',
        );
        return { ok: false, ...built.meta, message: built.message, audit: { lost: provenance } };
      }
      engine.log('warn', `soft provenance warning allowed by auditProvenanceBlock: false (kind=${provSummary.provenanceKind})`);
    }
    if (policy.auditEnabled && spec.auditSelection) {
      const checkpointText = Array.isArray(blocks)
        ? blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
        : undefined;
      const audit = auditMemorySelection({
        selection: spec.auditSelection,
        summaryText: result.rawText,
        checkpointText,
        threshold: policy.auditCoverageThreshold,
        coverageScope: policy?.auditCoverageScope ?? DEFAULT_CONFIG.auditCoverageScope,
        includeAllConflicts: true,
        referenceMessages,
      });
      if (audit.softCoverageCount > 0 && audit.lost.length === 0) {
        engine.log(
          'warn',
          `constraint audit ${compactionId}: ${audit.softCoverageCount} out-of-window (${audit.coverageScope}) ordinary coverage gap(s) allowed without blocking`,
        );
      }
      const split = engine._splitAuditLost(audit.lost, policy);
      if (split.polarity.length > 0) {
        const seq = split.polarity[0]?.seq;
        const sourceKind = sourceKindOf(session, seq) ?? 'user';
        return {
          ok: false,
          audit,
          code: 'CONSTRAINT_POLARITY_LOST',
          constraintSeq: seq ?? null,
          constraintSourceKind: sourceKind,
          message: `summary contradicts a source constraint (seq=${seq ?? 'unknown'}, source=${sourceKind}, reason=polarity)`,
        };
      }
      if (split.provenanceBlocked) {
        const built = engine._buildProvenanceError(
          split.provenanceSummary,
          'Generated instructions or permissions have no matching user source.',
        );
        return { ok: false, audit, ...built.meta, message: built.message };
      }
      const hardConflicts = split.conflictOther ?? split.other.filter((item) => item?.reason !== 'coverage');
      const coverageOnly = split.coverageOther ?? split.other.filter((item) => item?.reason === 'coverage');
      if (hardConflicts.length > 0 || (policy.auditBlockOnLoss && coverageOnly.length > 0)) {
        if (softenCoverageForFocus && hardConflicts.length === 0) {
          engine.log(
            'warn',
            `focus-mode constraint audit ${compactionId}: softened ${coverageOnly.length}/${audit.checked} non-polarity coverage gap(s) ` +
              `(worst coverage ${audit.worstCoverage}) during explicit manual /compact <focus>`,
          );
        } else {
          const firstConflict = hardConflicts[0] ?? coverageOnly[0] ?? split.other[0];
          return { ok: false, audit, code: 'CONSTRAINT_LOST', message: `summary failed source constraint audit (seq=${firstConflict.seq}, reason=${firstConflict.reason})` };
        }
      }
    }
    result._validated = { rawText: result.rawText, blocks, reinjectInfo };
    return listed;
  };
}

async function archiveVerifiedPrecomputedSpan(
  engine,
  { session, compactionId, spec, memorySelection, policy, allowForeignFallback, signal },
) {
  if (!policy.archiveEnabled) return null;
  signal?.throwIfAborted?.();
  const archivePath = await engine.archive.writeSpan({
    sessionId: session.id,
    compactionId,
    entries: spec.archiveEntries,
    signal,
    ...(allowForeignFallback ? { allowForeignFallback: true } : {}),
  });
  if (!archivePath) {
    throw Object.assign(new Error('compaction: archiving the shadowed span failed; refusing to replace it on the surface'), { code: 'ARCHIVE_FAILED' });
  }
  try {
    signal?.throwIfAborted?.();
    if (memorySelection.decisions.length > 0) {
      signal?.throwIfAborted?.();
      const verified = await engine.archive.readSpan(session.id, compactionId);
      if (!verified.ok || verified.entries.length !== spec.archiveEntries.length || verified.entries.some((entry, i) => entry.seq !== spec.archiveEntries[i].seq)) {
        throw Object.assign(new Error('Source archive verification failed; original context retained.'), { code: 'CONTINUATION_ARCHIVE_INVALID' });
      }
    }
    return archivePath;
  } catch (err) {
    await cleanupUncommittedArchive(engine, session, compactionId);
    throw err;
  }
}

async function runPrecomputedSummarizeChain(
  engine,
  {
    session,
    agent,
    policy,
    targets,
    capacity,
    maxTokens,
    signal,
    spec,
    workerInput,
    compactionId,
    preserved,
    expectedUserMessages,
    targetChars,
    focusInstruction,
    additionalContext,
    trigger,
    onAttemptError,
    onProgress,
    onExhaustionFallback,
    validate,
    buildSpanCheckpoint,
  },
) {
  const runChunkSummarize = (stripImagesForSummary) =>
    summarizeWithChain({
      ctx: engine.ctx,
      agent,
      input: workerInput,
      chain: targets,
      options: {
        maxTokens: maxTokens ?? policy.maxTokens,
        singleTarget: true,
        ...(stripImagesForSummary ? { stripImagesForSummary: true } : {}),
        timeoutMs: policy.summaryTimeoutMs,
        retryCount: policy.summaryRetryCount,
        retryDelayMs: policy.summaryRetryDelayMs,
        language: policy.language,
        previousSummary: spec.previousSummary,
        capacity,
        reasoningEffortPolicy: policy.summaryReasoningEffort,
        ...(targetChars !== undefined ? { targetChars } : {}),
        ...(focusInstruction ? { focusInstruction } : {}),
        ...(additionalContext ? { additionalContext } : {}),
        userMessages: preserved,
        onAttemptError: (attemptErr, meta) => {
          if (typeof onAttemptError === 'function') onAttemptError(attemptErr, meta);
          const retryReasonCode = normalizeRetryReasonCode(attemptErr);
          if (retryReasonCode) {
            engine._trackUpdate(session, {
              retryReasonCode,
              ...(retryReasonCode === 'RATE_LIMITED' ? { rateLimited: true } : {}),
            });
          }
        },
        ...(typeof onProgress === 'function' ? { onProgress } : {}),
        reconstruct: ({ result, verdict, modelRawText }) => {
          if (verdict.code === 'PROGRESS_FACT_CONFLICT') return null;
          const rebuilt = reconstructDisputedLines({
            text: modelRawText,
            userMessages: expectedUserMessages,
            audit: verdict.audit,
            language: result.language,
          });
          if (!rebuilt) return null;
          const receipts = [...(result.reconstruction ?? []), ...rebuilt.receipts];
          if (new Set(receipts.flatMap((r) => r.removedLineSha256)).size > 16) return null;
          return { ...result, rawText: rebuilt.text, summary: [{ type: 'text', text: rebuilt.text }], reconstruction: receipts };
        },
        onRejected: ({ result, verdict, modelRawText, attempt }) => dumpAuditRejection({
          storageRoot: dirname(engine.archive.root),
          sessionId: session?.id,
          compactionId,
          trigger,
          target: `${result?.provider ?? '?'}/${result?.model ?? '?'}`,
          code: verdict.code,
          message: verdict.message,
          attempt,
          modelRawText,
          auditedText: result.rawText,
          report: verdict.audit,
          userMessages: expectedUserMessages,
          checkpointBlocks: verdict.audit ? buildSpanCheckpoint(result.summary, result.rawText, '', { suppressTelemetry: true }) : undefined,
          coverageThreshold: policy.auditCoverageThreshold,
          softCoverageCount: verdict?.audit?.softCoverageCount ?? 0,
          auditFallbackSkippedReason: result?.auditFallback?.skippedReason ?? null,
        }),
        ...(onExhaustionFallback ? { onExhaustionFallback } : {}),
        validate,
      },
      signal: signal ?? new AbortController().signal,
    });

  try {
    return await runChunkSummarize(false);
  } catch (summaryErr) {
    if (
      !signal?.aborted &&
      !isAbortError(summaryErr, signal) &&
      !isBiliProxyPreflightError(summaryErr) &&
      (isImageOffloadRequiredError(summaryErr) || isUpstreamMultimodal400Error(summaryErr))
    ) {
      return await runChunkSummarize(true);
    }
    throw summaryErr;
  }
}

/**
 * Generate, validate, audit, and archive a span off-session before touching compaction locks.
 * @param {object} engine
 * @param {object} opts
 */
export async function generateValidatedPrecomputedSpan(
  engine,
  {
    session,
    agent,
    policy,
    budgetSpec = null,
    targets,
    capacity,
    maxTokens,
    signal,
    spec,
    referenceMessages,
    allowForeignFallback = false,
    progressPhase = 'summarizing',
    targetChars = SUMMARY_TARGET_CHARS,
    focusInstruction = '',
    additionalContext = '',
    softenCoverageForFocus = false,
    trigger = null,
    onAttemptError = null,
    onProgress = null,
  },
) {
  signal?.throwIfAborted?.();
  const compactionId = nextCompactionId();
  const {
    shadowedSeqs,
    shadowedTokenCount,
    shadowedCanonicalBytes,
    memorySelection,
    progressSelection,
    archivedFiles,
    childArchiveIds,
  } = spec;
  const preserved = memorySelection.preserved;
  const expectedUserMessages = [...memorySelection.active, ...memorySelection.retained];
  if (memorySelection.decisions.some((d) => d.reason === 'oldest-quote-evicted') && !policy.archiveEnabled) {
    throw Object.assign(new Error('Memory selection requires a verified source archive.'), { code: 'MEMORY_ARCHIVE_REQUIRED' });
  }

  const workerInput = {
    ...spec.input,
    messages: [
      ...spec.input.messages,
      { role: 'user', content: [{ type: 'text', text: memoryPolicyInstruction(memorySelection) }] },
    ],
  };

  const resolvedBudgetSpec = engine._getBudgetSpec(session, budgetSpec);
  const spanIoCache = { livenessBySummary: new Map(), reinjectByLimits: new Map() };
  let lastReinjectMeasured = null;
  const buildSpanCheckpoint = (summaryBlocks, summaryText = '', pinnedRules = '', checkpointOpts = undefined) =>
    engine._buildSpanCheckpointWithMetadata({
      session,
      shadowedSeqs,
      policy,
      compactionId,
      summaryBlocks,
      summaryText,
      pinnedRules,
      preserved,
      workReport: spec.input.workReport,
      progress: progressSelection,
      shadowedTokenCount,
      shadowedCanonicalBytes,
      archivedFiles,
      childArchiveIds,
      budgetSpec: resolvedBudgetSpec,
      spanIoCache,
      suppressTelemetry: checkpointOpts?.suppressTelemetry === true,
      onReinjectMeasured: checkpointOpts?.onReinjectMeasured
        ?? (checkpointOpts?.suppressTelemetry === true ? null : (info) => { lastReinjectMeasured = info; }),
    });

  const onExhaustionFallback = engine._makeAuditExhaustionFallback({
    session,
    policy,
    compactionId,
    shadowedSeqs,
    shadowedTokenCount,
    shadowedCanonicalBytes,
    preserved,
    expectedUserMessages,
    memorySelection,
    progressSelection,
    referenceMessages,
    softenCoverageForFocus,
    auditSelection: spec.auditSelection,
    buildSpanCheckpoint,
  });

  const validate = createPrecomputedSpanValidator(engine, {
    session,
    policy,
    compactionId,
    spec,
    preserved,
    expectedUserMessages,
    referenceMessages,
    memorySelection,
    progressSelection,
    progressPhase,
    softenCoverageForFocus,
    buildSpanCheckpoint,
  });

  const summarized = await runPrecomputedSummarizeChain(engine, {
    session,
    agent,
    policy,
    targets,
    capacity,
    maxTokens,
    signal,
    spec,
    workerInput,
    compactionId,
    preserved,
    expectedUserMessages,
    targetChars,
    focusInstruction,
    additionalContext,
    trigger,
    onAttemptError,
    onProgress,
    onExhaustionFallback,
    validate,
    buildSpanCheckpoint,
  });

  const checkpointBlocks = summarized?._validated?.blocks ?? buildSpanCheckpoint(
    summarized.summary,
    summarized.rawText,
    summarized?.pinnedRulesBlock ?? '',
    { suppressTelemetry: true, onReinjectMeasured: (info) => { lastReinjectMeasured = info; } },
  );
  const reinjectMeasurement = summarized?._validated?.reinjectInfo ?? lastReinjectMeasured;
  const archivePath = await archiveVerifiedPrecomputedSpan(engine, {
    session,
    compactionId,
    spec,
    memorySelection,
    policy,
    allowForeignFallback,
    signal,
  });

  return {
    compactionId,
    shadowedSeqs,
    shadowedTokenCount,
    shadowedTokenPrecision: spec.shadowedTokenPrecision,
    summarized,
    preserved,
    checkpointBlocks,
    memorySelection,
    progressSelection,
    sourceMemory: spec.sourceMemory,
    archivePath,
    reinjectMeasurement,
  };
}

async function planConcurrentChunkSlices(engine, { session, agent, signal, remaining, policy, maxTokens, capacityContext, maxSlices, results, baseCompletedChunks, allowForeignFallback, focusInstruction, additionalContext }) {
  const targets = engine._resolveSummaryTargets(policy, agent);
  const capacity = capacityContext?.current ?? await resolveSummaryCapacity(
    engine.ctx,
    targets,
    { ...policy, maxTokens: maxTokens ?? policy.maxTokens },
    signal,
    { singleTarget: true },
  );
  if (capacityContext) capacityContext.current = capacity;

  const planning = {
    policy,
    language: policy.language,
    historyToolsAvailable: Boolean(engine.historyToolsAvailable),
    pricedInput: (seqs) => engine._shadowedTokens(session, seqs),
    singleTarget: true,
    boundedWave: true,
    maxToolSourceRefs: DEFAULT_MAX_CHUNK_TOOL_SOURCE_REFS,
    ...(allowForeignFallback === true ? { allowForeignFallback: true } : {}),
    ...(focusInstruction ? { focusInstruction } : {}),
    ...(additionalContext ? { additionalContext } : {}),
  };

  const slices = [];
  let cursor = [...remaining];
  const sliceLimit = Math.max(0, Math.min(maxSlices, engine.config.maxSummaryChunks));
  while (cursor.length > 0 && slices.length < sliceLimit) {
    let planned;
    try {
      planned = planSummaryRange(session, { start: cursor[0], end: cursor.at(-1) }, capacity, planning);
    } catch {
      break;
    }
    if ((slices.length >= 1 || results.length > 0 || baseCompletedChunks > 0) && !planned.limited) {
      const tailMeasure = measureSummaryRange(session, { start: planned.start, end: planned.end }, planning);
      if (tailMeasure.minimumCheckpointBytes >= tailMeasure.sourceBytes) break;
    }
    const sIdx = cursor.indexOf(planned.start);
    const eIdx = cursor.indexOf(planned.end);
    if (sIdx !== 0 || eIdx < 0) break;
    slices.push({ start: planned.start, end: planned.end, seqs: cursor.slice(0, eIdx + 1) });
    cursor = cursor.slice(eIdx + 1);
    if (!planned.limited) break;
  }
  return { targets, capacity, slices, planning };
}

export async function handleConcurrentSliceReady(
  engine,
  {
    prepared,
    spec,
    commitSignal,
    session,
    agent,
    manual,
    trigger,
    maxTokens,
    policy,
    budgetSpec,
    capacityContext,
    deferCapacityFailureRecord,
    allowForeignFallback,
    checkpointMeta,
    sourceCommandId,
    results,
    foldResults,
    sliceSpecsLength,
    chunkBase,
    totalChunks,
    primaryModelLabel,
    stopBelowTokens,
    earlyStopController,
    effectiveFoldThreshold,
    maxWaves,
    focusInstruction,
    additionalContext,
    softenCoverageForFocus,
    onAfterCommit,
    state,
  },
) {
  commitSignal?.throwIfAborted?.();
  let commitResult;
  state.commitStarted = true;
  try {
    commitResult = await engine._compactRegionCore(spec.start, spec.end, agent, commitSignal, {
      manual,
      trigger: trigger ?? (manual ? 'manual' : 'auto'),
      maxTokens,
      policy,
      budgetSpec: engine._getBudgetSpec(session, budgetSpec),
      capacityContext,
      skipPlan: true,
      precomputed: prepared,
      deferCapacityFailureRecord,
      ...(allowForeignFallback ? { allowForeignFallback: true } : {}),
      ...(checkpointMeta ? { checkpointMeta } : {}),
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    });
  } catch (commitError) {
    if (commitError && typeof commitError === 'object') commitError._fromOrderedCommit = true;
    throw commitError;
  }
  if (!commitResult) return;
  state.committedCount += 1;
  results.push(commitResult);
  if (typeof commitResult.replacementSeq === 'number') {
    state.currentBatchCps.push(commitResult.replacementSeq);
  }
  const liveAfter = new Set(session.surface.nodes);
  state.remaining = state.remaining.filter((seq) => liveAfter.has(seq));
  if (commitSignal?.aborted) return;
  onAfterCommit?.({ pending: state.remaining, waveCount: state.currentWaveCount, batchCheckpointSeqs: state.currentBatchCps });

  const nextRemainingSlices = Math.max(0, sliceSpecsLength - state.committedCount);
  const measuredAfter = await engine._measure(session);
  if (commitSignal?.aborted) return;
  if (measuredAfter) engine._lastTotal.set(session, measuredAfter.totalTokens);
  engine._trackUpdate(session, {
    phase: nextRemainingSlices > 0 ? 'summarizing' : 'committing',
    summaryModel: primaryModelLabel,
    chunkIndex: Math.min(totalChunks, chunkBase + results.length + (nextRemainingSlices > 0 ? 1 : 0)),
    chunkTotal: totalChunks,
    retryReasonCode: null,
    ...(measuredAfter ? { currentTokens: measuredAfter.totalTokens } : {}),
    stream: null,
    ...engine._computeCompressionProgress(session, [], 0, { committing: nextRemainingSlices === 0 }),
  });

  if (stopBelowTokens !== null && measuredAfter && measuredAfter.totalTokens < stopBelowTokens) {
    state.stoppedEarly = true;
    earlyStopController.abort(new Error('STOP_BELOW_TOKENS'));
    return;
  }

  if (state.currentBatchCps.length >= effectiveFoldThreshold && state.remaining.length > 0 && state.currentWaveCount < maxWaves) {
    commitSignal?.throwIfAborted?.();
    state.currentWaveCount += 1;
    const folded = await engine._tryHierarchicalFold({
      session,
      agent,
      signal: commitSignal,
      batchCheckpointSeqs: state.currentBatchCps,
      policy,
      budgetSpec: engine._getBudgetSpec(session, budgetSpec),
      manual,
      maxTokens,
      capacityContext,
      sourceCommandId,
      waveIndex: state.currentWaveCount,
      allowForeignFallback,
      checkpointMeta,
      focusInstruction,
      additionalContext,
      softenCoverageForFocus,
    });
    let afterFoldMeasure = null;
    if (folded) {
      foldResults.push(folded);
      state.currentBatchCps = typeof folded.replacementSeq === 'number' ? [folded.replacementSeq] : [];
      if (commitSignal?.aborted) return;
      onAfterCommit?.({ pending: state.remaining, waveCount: state.currentWaveCount, batchCheckpointSeqs: state.currentBatchCps });
      afterFoldMeasure = await engine._measure(session);
      if (commitSignal?.aborted) return;
      if (afterFoldMeasure) engine._lastTotal.set(session, afterFoldMeasure.totalTokens);
    } else {
      if (commitSignal?.aborted) return;
      state.currentBatchCps = [];
    }
    if (nextRemainingSlices > 0) {
      engine._trackUpdate(session, {
        phase: 'summarizing',
        summaryModel: primaryModelLabel,
        chunkIndex: Math.min(totalChunks, chunkBase + results.length + 1),
        chunkTotal: totalChunks,
        retryReasonCode: null,
        ...(afterFoldMeasure ? { currentTokens: afterFoldMeasure.totalTokens } : {}),
        stream: null,
        ...engine._computeCompressionProgress(session, [], 0),
      });
    }
  }
}

function runConcurrentChunkPool(
  engine,
  {
    sliceSpecs,
    requestedConcurrency,
    poolSignals,
    rateLimitCooldownMs,
    session,
    agent,
    policy,
    budgetSpec,
    targets,
    capacity,
    maxTokens,
    referenceMessages,
    allowForeignFallback,
    trigger,
    manual,
    chunkTargetChars,
    focusInstruction,
    additionalContext,
    softenCoverageForFocus,
    currentChunkIndex,
    totalChunks,
    maxRetryAttempts,
    signal,
    capacityContext,
    deferCapacityFailureRecord,
    checkpointMeta,
    sourceCommandId,
    results,
    foldResults,
    chunkBase,
    primaryModelLabel,
    stopBelowTokens,
    earlyStopController,
    effectiveFoldThreshold,
    maxWaves,
    onAfterCommit,
    state,
  },
) {
  return runConcurrentPool(sliceSpecs, {
    onDiscard: prepared => prepared?.compactionId
      ? cleanupUncommittedArchive(engine, session, prepared.compactionId) : undefined,
    concurrency: requestedConcurrency,
    signal: poolSignals.signal,
    rateLimitCooldownMs,
    maxRateLimitRetries: policy.summaryRetryCount === 0 ? 1 : 0,
    onStateChange: (st) => {
      engine._trackUpdate(session, {
        concurrency: st.effectiveConcurrency,
        activeWorkers: st.activeWorkers,
        rateLimited: st.rateLimited,
      });
    },
    worker: async (spec, _idx, workerSignal, poolControl) => {
      const prepared = await engine._generateValidatedPrecomputedSpan({
        session,
        agent,
        policy,
        budgetSpec: engine._getBudgetSpec(session, budgetSpec),
        targets,
        capacity,
        maxTokens,
        signal: workerSignal,
        spec,
        referenceMessages,
        allowForeignFallback,
        progressPhase: 'summarizing',
        trigger: trigger ?? (manual ? 'manual' : 'auto'),
        targetChars: chunkTargetChars,
        focusInstruction,
        additionalContext,
        softenCoverageForFocus,
        onAttemptError: (attemptErr) => {
          if (isRateLimitError(attemptErr)) poolControl.noteRateLimit();
        },
        onProgress: (telemetry) => {
          if (workerSignal.aborted) return;
          const subFraction = Math.min(
            0.85,
            0.05 + 0.80 * Math.min(1, ((telemetry.textChars ?? 0) + (telemetry.reasoningChars ?? 0) * 0.25) / 3000),
          );
          engine._trackUpdate(session, {
            phase: 'summarizing',
            ...(telemetry.model ? { summaryModel: telemetry.model } : {}),
            attempt: telemetry.attempt,
            maxAttempts: telemetry.maxAttempts ?? maxRetryAttempts,
            chunkIndex: currentChunkIndex(),
            chunkTotal: totalChunks,
            concurrency: poolControl.effectiveConcurrency,
            activeWorkers: poolControl.activeWorkers,
            rateLimited: poolControl.rateLimited,
            ...engine._computeCompressionProgress(session, spec.shadowedSeqs, subFraction),
          });
          engine._trackStream(session, {
            chunks: telemetry.chunks,
            textChars: telemetry.textChars,
            reasoningChars: telemetry.reasoningChars,
            firstChunkMs: telemetry.firstChunkMs,
            idleMs: telemetry.idleMs,
          });
        },
      });
      if (prepared?.archivePath && prepared?.compactionId) {
        if (workerSignal.aborted) {
          await cleanupUncommittedArchive(engine, session, prepared.compactionId);
          workerSignal.throwIfAborted();
        }
        state.preparedArchiveIds?.add(prepared.compactionId);
      }
      return prepared;
    },
    onItemReadyInOrder: async (prepared, spec, _idx, poolControl) =>
      handleConcurrentSliceReady(engine, {
        prepared,
        spec,
        commitSignal: poolControl?.signal ?? signal,
        session,
        agent,
        manual,
        trigger,
        maxTokens,
        policy,
        budgetSpec,
        capacityContext,
        deferCapacityFailureRecord,
        allowForeignFallback,
        checkpointMeta,
        sourceCommandId,
        results,
        foldResults,
        sliceSpecsLength: sliceSpecs.length,
        chunkBase,
        totalChunks,
        primaryModelLabel,
        stopBelowTokens,
        earlyStopController,
        effectiveFoldThreshold,
        maxWaves,
        focusInstruction,
        additionalContext,
        softenCoverageForFocus,
        onAfterCommit,
        state,
      }),
  });
}

/**
 * Generate summaries and archives for disjoint contiguous chunks concurrently,
 * committing strictly in ascending order via `_compactRegionCore`.
 * @param {object} engine
 * @param {object} opts
 */
export async function compactChunksConcurrent(
  engine,
  {
    session,
    agent,
    signal,
    pending,
    policy,
    budgetSpec = null,
    manual,
    maxTokens,
    capacityContext,
    maxSlices,
    baseCompletedChunks = 0,
    results,
    foldResults,
    batchCheckpointSeqs,
    waveCount,
    maxWaves,
    foldThreshold,
    stopBelowTokens = null,
    allowForeignFallback = false,
    checkpointMeta = null,
    sourceCommandId = undefined,
    trigger = null,
    focusInstruction = '',
    additionalContext = '',
    softenCoverageForFocus = false,
    deferCapacityFailureRecord = false,
    onAfterCommit = null,
  },
) {
  return withReferencePolicy(policy ?? engine.config, async () => {
    const requestedConcurrency = Number.isInteger(policy.summaryConcurrency)
      ? Math.max(1, Math.min(6, policy.summaryConcurrency))
      : 1;
    const state = {
      currentBatchCps: Array.isArray(batchCheckpointSeqs) ? batchCheckpointSeqs : [],
      currentWaveCount: waveCount ?? 0,
      remaining: [],
      stoppedEarly: false,
      committedCount: 0,
      commitStarted: false,
      preparedArchiveIds: new Set(),
    };
    if (requestedConcurrency <= 1 || !Array.isArray(pending) || pending.length < 2 || maxSlices < 2) {
      return { used: false, pending, waveCount: state.currentWaveCount, batchCheckpointSeqs: state.currentBatchCps, committedCount: 0 };
    }

    const liveNodes = session.surface?.nodes ?? [];
    const liveSet = new Set(liveNodes);
    state.remaining = pending.filter((seq) => liveSet.has(seq));
    if (state.remaining.length < 2) {
      return { used: false, pending: state.remaining, waveCount: state.currentWaveCount, batchCheckpointSeqs: state.currentBatchCps, committedCount: 0 };
    }

    const { targets, capacity, slices, planning } = await planConcurrentChunkSlices(engine, {
      session,
      agent,
      signal,
      remaining: state.remaining,
      policy,
      maxTokens,
      capacityContext,
      maxSlices,
      results,
      baseCompletedChunks,
      allowForeignFallback,
      focusInstruction,
      additionalContext,
    });
    if (slices.length < 2) {
      return { used: false, pending: state.remaining, waveCount: state.currentWaveCount, batchCheckpointSeqs: state.currentBatchCps, committedCount: 0 };
    }

    const referenceMessages = collectReferenceMessages(session, liveNodes);
    const snapshotPrecision = engine._lastPrecision?.get(session) ?? 'unknown';
    const primaryTarget = targets?.targets?.[0];
    const durable = latestDurableTarget(agent);
    const preservePrefixCache = Boolean(policy.cachePreservePrefix) &&
      Boolean(durable && primaryTarget && primaryTarget.provider === durable.provider && primaryTarget.model === durable.model) &&
      fitsCapacity(
        measureSummaryRange(session, slices[0], { ...planning, preservePrefixCache: true }),
        capacity,
        { singleTarget: true },
      );
    const sliceSpecs = slices.map((slice, sliceIdx) =>
      engine._buildPrecomputedSliceSpec(session, slice.seqs, policy, {
        allowForeignFallback,
        snapshotPrecision,
        preservePrefixCache: sliceIdx === 0 && preservePrefixCache,
      }),
    );

    const primaryModelLabel = primaryTarget?.provider && primaryTarget?.model
      ? `${primaryTarget.provider}/${primaryTarget.model}`
      : null;
    const maxRetryAttempts = (Number.isSafeInteger(policy.summaryRetryCount) && policy.summaryRetryCount >= 0 ? policy.summaryRetryCount : 0) + 1;
    const rateLimitCooldownMs = Math.min(5000, Math.max(0, Number.isFinite(policy.summaryRetryDelayMs) ? policy.summaryRetryDelayMs : 1500));

    const earlyStopController = new AbortController();
    const poolSignals = combineSignals([signal, earlyStopController.signal]);
    const chunkBase = Number.isSafeInteger(baseCompletedChunks) && baseCompletedChunks > 0 ? baseCompletedChunks : 0;
    const totalChunks = chunkBase + results.length + sliceSpecs.length;
    const currentChunkIndex = () => Math.min(totalChunks, chunkBase + results.length + 1);
    const effectiveFoldThreshold = Math.max(foldThreshold, resolveBulkFoldThreshold(policy, totalChunks));
    const chunkTargetChars = totalChunks >= 4 ? INTERMEDIATE_SUMMARY_TARGET_CHARS : SUMMARY_TARGET_CHARS;

    engine._trackUpdate(session, {
      phase: 'summarizing',
      summaryModel: primaryModelLabel,
      chunkIndex: currentChunkIndex(),
      chunkTotal: totalChunks,
      retryReasonCode: null,
      concurrency: requestedConcurrency,
      activeWorkers: 0,
      rateLimited: false,
      ...engine._computeCompressionProgress(session, [], 0),
    });

    const resultsBeforePool = results.length;
    try {
      await runConcurrentChunkPool(engine, {
        sliceSpecs,
        requestedConcurrency,
        poolSignals,
        rateLimitCooldownMs,
        session,
        agent,
        policy,
        budgetSpec,
        targets,
        capacity,
        maxTokens,
        referenceMessages,
        allowForeignFallback,
        trigger,
        manual,
        chunkTargetChars,
        focusInstruction,
        additionalContext,
        softenCoverageForFocus,
        currentChunkIndex,
        totalChunks,
        maxRetryAttempts,
        signal,
        capacityContext,
        deferCapacityFailureRecord,
        checkpointMeta,
        sourceCommandId,
        results,
        foldResults,
        chunkBase,
        primaryModelLabel,
        stopBelowTokens,
        earlyStopController,
        effectiveFoldThreshold,
        maxWaves,
        onAfterCommit,
        state,
      });
    } catch (poolError) {
      if (state.stoppedEarly && !signal?.aborted) {
        return { used: true, pending: state.remaining, waveCount: state.currentWaveCount, batchCheckpointSeqs: state.currentBatchCps, committedCount: state.committedCount };
      }
      const isCapacityFailure = (error, depth = 0) => {
        if (!error || depth >= 8) return false;
        if (error.code === 'CONTEXT_WINDOW_EXCEEDED' || error.code === 'MAX_TOKENS') return true;
        return error.code === 'SUMMARY_ALL_FAILED' && Array.isArray(error.failures) && error.failures.length > 0 &&
          error.failures.every((failure) => isCapacityFailure(failure, depth + 1));
      };
      if (
        !state.commitStarted && results.length === resultsBeforePool &&
        !poolError?._fromOrderedCommit && !signal?.aborted && !isAbortError(poolError, signal) &&
        isCapacityFailure(poolError)
      ) {
        // The pool has drained without starting a commit. Let the caller use
        // serial span shrinking with the capacity observations from this wave.
        engine._trackUpdate(session, { concurrency: 1, activeWorkers: 0, rateLimited: false });
        return { used: false, pending: state.remaining, waveCount: state.currentWaveCount, batchCheckpointSeqs: state.currentBatchCps, committedCount: 0 };
      }
      if (!poolError?._fromOrderedCommit && !isAbortError(poolError, signal)) {
        if (deferCapacityFailureRecord && continuationEligible(poolError)) {
          if (poolError && typeof poolError === 'object') poolError._deferredFailureRecord = true;
        } else {
          engine._recordFailure(agent, session, poolError);
        }
      }
      if (state.committedCount > 0) {
        try {
          onAfterCommit?.({
            pending: state.remaining,
            waveCount: state.currentWaveCount,
            batchCheckpointSeqs: state.currentBatchCps,
          });
        } catch {}
      }
      throw poolError;
    } finally {
      poolSignals.dispose();
      engine._trackUpdate(session, { activeWorkers: 0 });
      if (state.preparedArchiveIds.size > 0) {
        await Promise.all(
          Array.from(state.preparedArchiveIds, (cid) => cleanupUncommittedArchive(engine, session, cid)),
        );
      }
    }

    return { used: true, pending: state.remaining, waveCount: state.currentWaveCount, batchCheckpointSeqs: state.currentBatchCps, committedCount: state.committedCount };
  });
}

/**
 * Execute sequential bounded continuation waves until threshold or non-shrinkable boundary.
 * @param {object} engine
 * @param {object} opts
 */
export async function runContinuationWaves(
  engine,
  {
    session,
    agent,
    policy,
    maxTokens,
    signal,
    capacityContext,
    manual,
    sourceCommandId,
    idle = false,
    allowForeignFallback = false,
    checkpointMeta = null,
    allowPolicyRestart = false,
    manualRetry = false,
    maxWaves = 12,
    stopBelowTokens = null,
    continuationBudgetFor = null,
    recordSelectionFailure = false,
    collector = null,
    focusInstruction = '',
    additionalContext = '',
    softenCoverageForFocus = false,
    trigger = null,
    onWaveCommitted = null,
  },
) {
  const waveResults = Array.isArray(collector) ? collector : [];
  let entered = false;
  let lastReplacementSeq = null;
  let prevRangeKey = null;
  const parallelContinuation =
    (Number.isInteger(policy.summaryConcurrency) ? policy.summaryConcurrency : 1) > 1 &&
    (Number.isInteger(policy.continuationMaxExtraCalls) ? policy.continuationMaxExtraCalls : 4) >= 1;

  for (let waveIndex = 1; waveIndex <= maxWaves; waveIndex += 1) {
    signal?.throwIfAborted?.();
    await engine._measure(session);
    let wave = null;
    try {
      wave = await engine._selectContinuationWaveForSession(
        session,
        agent,
        policy,
        maxTokens,
        signal,
        capacityContext,
        { allowForeignFallback, focusInstruction, additionalContext },
      );
    } catch (waveErr) {
      if (['ARCHIVE_SOURCE_INVALID', 'CONTINUATION_BATCH_LIMIT', 'CONTINUATION_TOOL_GROUP_OPEN', 'CONTINUATION_CAPACITY'].includes(waveErr?.code)) {
        if (recordSelectionFailure && !isAbortError(waveErr, signal)) {
          engine._recordFailure(agent, session, waveErr);
        }
        if (entered && waveErr && typeof waveErr === 'object') waveErr._enteredContinuation = true;
        throw waveErr;
      }
      wave = selectContinuationRange(session);
    }
    if (!wave) break;
    if (waveResults.length > 0) {
      if (Array.isArray(wave.seqs) && wave.seqs.length <= 1) break;
      if (lastReplacementSeq !== null && wave.start === lastReplacementSeq && wave.end === lastReplacementSeq) break;
      const rangeKey = `${wave.start}:${wave.end}`;
      if (rangeKey === prevRangeKey) break;
      prevRangeKey = rangeKey;
    } else {
      prevRangeKey = `${wave.start}:${wave.end}`;
    }
    if (idle && !engine._idleContinuationCanShrink(session, wave, policy)) {
      return { entered, results: waveResults, idleSkipped: true };
    }

    entered = true;
    engine._trackUpdate(session, {
      phase: 'continuing',
      waveIndex,
      waveTotal: null,
      pageIndex: null,
      pageTotal: wave.pages ?? null,
      retryReasonCode: null,
      ...engine._computeCompressionProgress(session, wave.seqs ?? [], 0),
    });

    const continuationBudgetTokens = typeof continuationBudgetFor === 'function'
      ? await continuationBudgetFor(wave)
      : undefined;
    let contResult;
    try {
      contResult = await engine._compactRegionCore(wave.start, wave.end, agent, signal, {
        manual,
        trigger: trigger ?? (idle ? 'idle' : manual ? 'manual' : 'auto'),
        ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
        policy,
        continuation: true,
        ...(continuationBudgetTokens === undefined ? {} : { continuationBudgetTokens }),
        capacityContext,
        waveIndex,
        parallelContinuation,
        allowPolicyRestart,
        manualRetry: manualRetry || manual,
        ...(focusInstruction ? { focusInstruction } : {}),
        ...(additionalContext ? { additionalContext } : {}),
        ...(softenCoverageForFocus ? { softenCoverageForFocus: true } : {}),
        ...(allowForeignFallback ? { allowForeignFallback: true } : {}),
        ...(checkpointMeta ? { checkpointMeta } : {}),
      });
    } catch (contErr) {
      if (contErr?.code === 'CONTINUATION_NOT_SMALLER' && waveResults.length > 0) {
        engine.log('info', `continuation wave ${waveIndex} did not shrink further; keeping ${waveResults.length} committed wave(s)`);
        break;
      }
      if (contErr && typeof contErr === 'object') contErr._enteredContinuation = true;
      throw contErr;
    }

    waveResults.push(contResult);
    if (typeof contResult?.replacementSeq === 'number') {
      lastReplacementSeq = contResult.replacementSeq;
    }
    onWaveCommitted?.(contResult);
    const afterWave = await engine._measure(session);
    if (afterWave) {
      engine._lastTotal.set(session, afterWave.totalTokens);
      engine._trackUpdate(session, {
        currentTokens: afterWave.totalTokens,
        stream: null,
        retryReasonCode: null,
        ...engine._computeCompressionProgress(session, [], 0),
      });
      if (stopBelowTokens !== null && afterWave.totalTokens < stopBelowTokens) {
        break;
      }
    } else {
      engine._trackUpdate(session, { stream: null, retryReasonCode: null });
    }
    if (wave.limited !== true) break;
  }

  return { entered, results: waveResults, idleSkipped: false };
}

/**
 * Select the next bounded continuation wave using target capacity.
 * @param {object} engine
 * @param {object} session
 * @param {object} agent
 * @param {object} policy
 * @param {number|undefined} maxTokens
 * @param {AbortSignal|undefined} signal
 * @param {object} capacityContext
 * @param {object} [opts]
 */
export async function selectContinuationWaveForSession(
  engine,
  session,
  agent,
  policy,
  maxTokens,
  signal,
  capacityContext,
  { allowForeignFallback = false, focusInstruction = '', additionalContext = '' } = {},
) {
  const targets = engine._resolveSummaryTargets(policy, agent);
  const capacity = capacityContext?.current ?? await resolveSummaryCapacity(
    engine.ctx,
    targets,
    { ...policy, maxTokens: maxTokens ?? policy.maxTokens },
    signal,
    { singleTarget: true },
  ).catch(() => undefined);
  if (capacityContext && capacity) capacityContext.current = capacity;
  return selectContinuationWave(session, {
    policy,
    capacity,
    maxPages: policy.maxSummaryChunks,
    maxToolSourceRefs: DEFAULT_CONTINUATION_WAVE_TOOL_SOURCE_REFS,
    allowForeignFallback,
    ...(focusInstruction ? { focusInstruction } : {}),
    ...(additionalContext ? { additionalContext } : {}),
  });
}

async function prepareHierarchicalFoldSpec(
  engine,
  { session, agent, signal, batchCheckpointSeqs, policy, maxTokens, capacityContext, allowForeignFallback, focusInstruction, additionalContext },
) {
  const liveNodes = session.surface?.nodes ?? [];
  if (batchCheckpointSeqs.length < 2) return null;
  const firstIdx = liveNodes.indexOf(batchCheckpointSeqs[0]);
  const lastIdx = liveNodes.indexOf(batchCheckpointSeqs.at(-1));
  if (firstIdx < 0 || lastIdx <= firstIdx) return null;
  const slice = liveNodes.slice(firstIdx, lastIdx + 1);
  if (slice.length !== batchCheckpointSeqs.length || slice.some((seq, i) => seq !== batchCheckpointSeqs[i])) {
    return null;
  }

  const targets = engine._resolveSummaryTargets(policy, agent);
  if (!Array.isArray(targets?.targets) || targets.targets.length === 0) return null;
  const planning = {
    policy,
    language: policy.language,
    historyToolsAvailable: Boolean(engine.historyToolsAvailable),
    pricedInput: (seqs) => engine._shadowedTokens(session, seqs),
    singleTarget: true,
    boundedWave: true,
    maxToolSourceRefs: DEFAULT_MAX_CHUNK_TOOL_SOURCE_REFS,
    ...(allowForeignFallback === true ? { allowForeignFallback: true } : {}),
    ...(focusInstruction ? { focusInstruction } : {}),
    ...(additionalContext ? { additionalContext } : {}),
  };

  let capacity;
  let foldSeqs;
  try {
    capacity = capacityContext?.current ?? await resolveSummaryCapacity(
      engine.ctx,
      targets,
      { ...policy, maxTokens: maxTokens ?? policy.maxTokens },
      signal,
      { singleTarget: true },
    );
    if (capacityContext && capacity) capacityContext.current = capacity;
    const planned = planSummaryRange(session, { start: slice[0], end: slice.at(-1) }, capacity, planning);
    if (!planned || planned.start === planned.end) return null;
    const pStartIdx = liveNodes.indexOf(planned.start);
    const pEndIdx = liveNodes.indexOf(planned.end);
    if (pStartIdx < 0 || pEndIdx <= pStartIdx) return null;
    foldSeqs = liveNodes.slice(pStartIdx, pEndIdx + 1);
    if (foldSeqs.length < 2) return null;
    const foldMeasure =
      typeof planned.sourceBytes === 'number' && typeof planned.minimumCheckpointBytes === 'number'
        ? planned
        : measureSummaryRange(session, { start: foldSeqs[0], end: foldSeqs.at(-1) }, planning);
    if (!(foldMeasure.sourceBytes > foldMeasure.minimumCheckpointBytes)) {
      engine.log('info', `rolling-wave fold skipped (${foldSeqs.length} checkpoints did not shrink further); continuing remaining chunks`);
      return null;
    }
  } catch (planError) {
    if (isAbortError(planError, signal)) throw planError;
    engine.log('info', `rolling-wave fold skipped (${planError?.code ?? 'error'}: ${planError?.message ?? planError}); continuing remaining chunks`);
    return null;
  }

  let preservePrefixCache = false;
  const durable = latestDurableTarget(agent);
  const primary = targets.targets[0];
  if (durable && primary && primary.provider === durable.provider && primary.model === durable.model) {
    const verbatim = measureSummaryRange(
      session,
      { start: foldSeqs[0], end: foldSeqs.at(-1) },
      { ...planning, preservePrefixCache: true },
    );
    if (fitsCapacity(verbatim, capacity, { singleTarget: true })) {
      preservePrefixCache = true;
    }
  }

  const foldSpec = engine._buildPrecomputedSliceSpec(session, foldSeqs, policy, { allowForeignFallback, preservePrefixCache });
  if (!policy.archiveEnabled && foldSpec.memorySelection.decisions.some((d) => d.reason === 'oldest-quote-evicted')) {
    engine.log('info', 'rolling-wave fold skipped (archive disabled while oldest quote would be evicted); continuing remaining chunks');
    return null;
  }
  return { targets, capacity, foldSeqs, foldSpec, referenceMessages: collectReferenceMessages(session, liveNodes) };
}

/**
 * Attempt an optional rolling-wave hierarchical fold over consecutive checkpoint seqs.
 * @param {object} engine
 * @param {object} opts
 */
export async function tryHierarchicalFold(
  engine,
  {
    session,
    agent,
    signal,
    batchCheckpointSeqs,
    policy,
    budgetSpec = null,
    manual,
    maxTokens,
    capacityContext,
    sourceCommandId,
    waveIndex,
    allowForeignFallback = false,
    checkpointMeta = null,
    focusInstruction = '',
    additionalContext = '',
    softenCoverageForFocus = false,
    trigger = 'fold',
  },
) {
  if (batchCheckpointSeqs.length < 2) return null;
  try {
    signal?.throwIfAborted?.();
    const liveNodes = session.surface?.nodes ?? [];
    const firstIdx = liveNodes.indexOf(batchCheckpointSeqs[0]);
    const lastIdx = liveNodes.indexOf(batchCheckpointSeqs.at(-1));
    if (firstIdx < 0 || lastIdx <= firstIdx) return null;
    const slice = liveNodes.slice(firstIdx, lastIdx + 1);
    validateSurfaceRegion(session, slice[0], slice.at(-1));
    const entryState = inspectCompactionEntryState(session);
    assertCompactionInactive(entryState.unmatchedCompactionStart, entryState.latestEndSeedSeq, 'folding');
    if ((manual && entryState.openTurn !== null) || (!manual && entryState.openTurn === null)) return null;
    if (readPendingContinuation(engine.sessionState, session)) return null;
  } catch (preError) {
    if (isAbortError(preError, signal)) throw preError;
    engine.log('warn', `rolling-wave fold pre-check skipped (${preError?.code ?? 'error'}: ${preError?.message ?? preError}); continuing remaining chunks`);
    return null;
  }

  const preparedPlan = await prepareHierarchicalFoldSpec(engine, {
    session,
    agent,
    signal,
    batchCheckpointSeqs,
    policy,
    maxTokens,
    capacityContext,
    allowForeignFallback,
    focusInstruction,
    additionalContext,
  });
  if (!preparedPlan) return null;

  const { targets, capacity, foldSeqs, foldSpec, referenceMessages } = preparedPlan;
  const primaryTarget = targets?.targets?.[0];
  const primaryModelLabel = primaryTarget?.provider && primaryTarget?.model ? `${primaryTarget.provider}/${primaryTarget.model}` : null;
  const maxRetryAttempts = (Number.isSafeInteger(policy.summaryRetryCount) && policy.summaryRetryCount >= 0 ? policy.summaryRetryCount : 0) + 1;

  engine._trackUpdate(session, {
    phase: 'folding',
    waveIndex,
    waveTotal: null,
    chunkIndex: null,
    chunkTotal: null,
    summaryModel: primaryModelLabel,
    attempt: 1,
    maxAttempts: maxRetryAttempts,
    retryReasonCode: null,
    stream: { chunks: 0, textChars: 0, reasoningChars: 0, firstChunkMs: null, idleMs: 0 },
    ...engine._computeCompressionProgress(session, foldSeqs, 0.05),
  });

  try {
    const resolvedBudgetSpec = engine._getBudgetSpec(session, budgetSpec);
    const precomputed = await engine._generateValidatedPrecomputedSpan({
      session,
      agent,
      policy,
      budgetSpec: resolvedBudgetSpec,
      targets,
      capacity,
      maxTokens,
      signal,
      spec: foldSpec,
      referenceMessages,
      allowForeignFallback,
      progressPhase: 'folding',
      trigger,
      targetChars: SUMMARY_TARGET_CHARS,
      focusInstruction,
      additionalContext,
      softenCoverageForFocus,
      onProgress: (telemetry) => {
        const subFraction = Math.min(
          0.85,
          0.05 + 0.80 * Math.min(1, ((telemetry.textChars ?? 0) + (telemetry.reasoningChars ?? 0) * 0.25) / 3000),
        );
        engine._trackUpdate(session, {
          phase: 'folding',
          waveIndex,
          waveTotal: null,
          chunkIndex: null,
          chunkTotal: null,
          ...(telemetry.model ? { summaryModel: telemetry.model } : {}),
          attempt: telemetry.attempt,
          maxAttempts: telemetry.maxAttempts ?? maxRetryAttempts,
          ...engine._computeCompressionProgress(session, foldSeqs, subFraction),
        });
        engine._trackStream(session, {
          chunks: telemetry.chunks,
          textChars: telemetry.textChars,
          reasoningChars: telemetry.reasoningChars,
          firstChunkMs: telemetry.firstChunkMs,
          idleMs: telemetry.idleMs,
        });
      },
    });
    return await engine._compactRegionCore(foldSeqs[0], foldSeqs.at(-1), agent, signal, {
      manual,
      maxTokens,
      policy,
      budgetSpec: resolvedBudgetSpec,
      capacityContext,
      skipPlan: true,
      precomputed,
      progressPhase: 'folding',
      trigger,
      skipUnshrinkable: true,
      suppressFailureRecord: true,
      ...(allowForeignFallback ? { allowForeignFallback: true } : {}),
      ...(checkpointMeta ? { checkpointMeta } : {}),
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    });
  } catch (error) {
    if (
      !isAbortError(error, signal) &&
      !['RECOVERY_REQUIRED', 'commit', 'STATE_UNAVAILABLE', 'STATE_LOCKED'].includes(error?.code)
    ) {
      engine.log('warn', `rolling-wave fold skipped (${error?.code ?? 'error'}: ${error?.message ?? error}); continuing remaining chunks`);
      return null;
    }
    throw error;
  }
}

async function prepareManualCompactionSetup(
  engine,
  { session, agent, signal, manual, hookManual = manual, idle, proactive, continuation, hookTrigger, explicitRange, allowPolicyRestart, resumableJob, userFocus, hooksHandled, softenCoverageForFocus: softenCoverageOverride },
) {
  await engine.recoverPending(session);
  const measurement = await engine._measure(session);
  if (!measurement) return null;
  noteDiagnosticMeasurement(measurement);
  const resolvedPolicy = engine._resolvePolicy(agent);
  const policy = idle ? { ...resolvedPolicy, cachePreservePrefix: false } : resolvedPolicy;
  const budgetSpec = await engine._resolveSpec(agent, measurement, signal).catch((err) => {
    if (isAbortError(err, signal)) throw err;
    return null;
  });
  let pendingContinuation = readPendingContinuation(engine.sessionState, session);
  if (
    pendingContinuation &&
    manual &&
    !continuation &&
    !idle &&
    !proactive &&
    (!explicitRange || (resumableJob && resumableJob.trigger !== 'migration')) &&
    !hasContinuation(session)
  ) {
    const acceptedPages = engine._readPendingContinuationAcceptedPages(session, pendingContinuation);
    if (acceptedPages === 0) {
      clearPendingContinuation(engine.sessionState, session.id);
      engine.log('info', 'Cleared 0-accepted-page continuationPending lock for normal /compact; disk continuation-progress ledger retained.');
      pendingContinuation = null;
    }
  }
  if (idle && !pendingContinuation && (policy.idleCompactionMinTokens ?? 0) > 0 && measurement.totalTokens < policy.idleCompactionMinTokens) {
    return null;
  }
  const rollover = pendingContinuation || continuation || (!explicitRange && policy.continuationEnabled && hasContinuation(session));
  const cacheRetain = policy.retainTokens ?? Math.max(4096, Math.floor(measurement.totalTokens * policy.retainRatio));
  const cacheRange = pendingContinuation || explicitRange
    ? null
    : selectCachePreservingRange(session, measurement, cacheRetain, policy, undefined, { continuation: !!rollover });
  const baseRetain = idle ? (policy.idleRetainTokens ?? 0) : 0;
  const range = pendingContinuation
    ? { start: pendingContinuation.seqs[0], end: pendingContinuation.seqs.at(-1) }
    : (explicitRange ?? (cacheRange ?? (rollover ? selectContinuationRange(session) : selectCompactableRange(session, measurement, baseRetain))));
  if (!range) return null;
  let idleContinuationTarget = null;
  if (idle && !pendingContinuation) {
    const size = measureSummaryRange(session, range, { policy, language: policy.language });
    if (rollover || size.minimumCheckpointBytes >= size.sourceBytes) {
      if (!policy.continuationEnabled || !policy.archiveEnabled || !engine.historyToolsAvailable) return null;
      const next = rollover ? range : selectContinuationRange(session);
      if (!next || !engine._idleContinuationCanShrink(session, next, policy)) return null;
      idleContinuationTarget = next;
    }
  }
  let effectiveFocus = userFocus;
  let additionalContext = '';
  let softenCoverageForFocus = Boolean((manual && userFocus.length > 0) || softenCoverageOverride === true);
  if (!hooksHandled) {
    const preHook = await engine._runPreCompactHook({
      session,
      trigger: hookTrigger,
      manual: Boolean(hookManual),
      focusInstruction: userFocus,
      totalTokens: measurement.totalTokens,
      range: idleContinuationTarget ?? range,
      continuation: Boolean(idleContinuationTarget || rollover),
      signal,
    });
    if (preHook.cancelled) return null;
    effectiveFocus = preHook.effectiveFocus;
    additionalContext = preHook.additionalContext;
    softenCoverageForFocus = preHook.softenCoverageForFocus || softenCoverageOverride === true;
  }
  return {
    measurement,
    policy,
    budgetSpec,
    rollover,
    cacheRetain,
    baseRetain,
    range,
    idleContinuationTarget,
    effectiveFocus,
    additionalContext,
    softenCoverageForFocus,
  };
}

async function runManualStage1PreMasking(
  engine,
  {
    session,
    agent,
    policy,
    triggerName,
    idle,
    proactive,
    rollover,
    resumableJob,
    allowForeignFallback,
    effectiveFocus,
    additionalContext,
    initialManualSeqs,
    measurement: initMeasurement,
    range: initRange,
    explicitRange,
    cacheRetain,
    baseRetain,
    capacityContext,
    progressScope,
    runSignal,
  },
) {
  let measurement = initMeasurement;
  let range = initRange;
  let skipManualMaskForSessionMemory = false;
  if (
    !idle &&
    !rollover &&
    !allowForeignFallback &&
    !resumableJob &&
    !effectiveFocus &&
    !additionalContext &&
    policy?.sessionMemoryEnabled === true
  ) {
    await engine._awaitOrCancelSessionMemory(session, policy, runSignal, {
      trigger: triggerName,
      continuation: false,
      focusInstruction: effectiveFocus,
      additionalContext,
      allowForeignFallback,
      expectedStartSeq: range?.start,
    });
    if (
      initialManualSeqs.length > 0 &&
      engine.sessionMemory?.matchForSpan?.(session, initialManualSeqs, policy, { allowPrefixSplit: true })
    ) {
      skipManualMaskForSessionMemory = true;
    }
  } else {
    engine.sessionMemory?.cancel?.(session.id);
  }
  if (
    !skipManualMaskForSessionMemory &&
    !idle &&
    !proactive &&
    !resumableJob &&
    policy.observationMaskingEnabled !== false &&
    policy.archiveEnabled &&
    engine.historyToolsAvailable &&
    inspectCompactionEntryState(session).openTurn !== null
  ) {
    const flushSession = typeof engine.ctx.sessions?.flush === 'function' ? (targetSession) => engine._flushSession(targetSession) : null;
    let totalMaskedCount = 0;
    let totalMaskedSaved = 0;
    for (let maskPass = 0; maskPass < 4; maskPass += 1) {
      runSignal?.throwIfAborted?.();
      const maskPlan = planObservationMask(session, measurement, baseRetain, {
        compactionId: nextCompactionId(),
        thresholdChars: policy.observationMaskThresholdChars,
        headChars: policy.observationMaskHeadChars,
        tailChars: policy.observationMaskTailChars,
      });
      if (!maskPlan) break;
      let shouldPreMask = measurement.totalTokens >= 65536 && maskPlan.totalTokensSaved >= 4096;
      if (!shouldPreMask && maskPass === 0) {
        try {
          const targets = engine._resolveSummaryTargets(policy, agent);
          if (targets.targets.length > 0) {
            const cap = capacityContext.current ?? await resolveSummaryCapacity(
              engine.ctx,
              targets,
              { ...policy, maxTokens: policy.maxTokens },
              runSignal,
              { singleTarget: true },
            );
            capacityContext.current = cap;
            const rangeMeasure = measureSummaryRange(session, range, { policy, language: policy.language });
            if (!fitsCapacity(rangeMeasure, cap, { singleTarget: true })) shouldPreMask = true;
          }
        } catch {}
      }
      if (!shouldPreMask) break;
      engine._trackUpdate(session, {
        phase: 'masking',
        overallPercent: Math.min(11, 6 + maskPass * 2),
        maskedCount: totalMaskedCount,
        maskedTokensSaved: totalMaskedSaved,
        overallProcessedTokens: totalMaskedSaved,
        currentTokens: measurement.totalTokens,
      });
      const masked = await commitObservationMask({
        session,
        plan: maskPlan,
        archive: engine.archive,
        log: (level, msg) => engine.log(level, msg),
        flushSession,
        signal: runSignal,
      });
      if (!masked) break;
      engine._invalidateSessionMemory(session.id);
      totalMaskedCount += maskPlan.targets.length;
      totalMaskedSaved += masked.shadowedTokenCount ?? maskPlan.totalTokensSaved;
      const afterMask = await engine._measure(session);
      if (!afterMask) break;
      measurement = afterMask;
      engine._lastTotal.set(session, afterMask.totalTokens);
      noteDiagnosticMeasurement(measurement);
      engine._trackUpdate(session, {
        phase: 'masking',
        overallPercent: Math.min(12, 8 + maskPass * 2),
        maskedCount: totalMaskedCount,
        maskedTokensSaved: totalMaskedSaved,
        overallProcessedTokens: totalMaskedSaved,
        currentTokens: afterMask.totalTokens,
      });
      if (!explicitRange) {
        const nextCacheRange = selectCachePreservingRange(session, measurement, cacheRetain, policy, undefined, { continuation: false });
        range = nextCacheRange ?? selectCompactableRange(session, measurement, baseRetain);
        if (!range) return { hasEarlyReturn: true, earlyReturn: masked, measurement, range };
      } else {
        const liveNodes = session.surface?.nodes ?? [];
        const firstIdx = liveNodes.length > 0 && systemHead(session, liveNodes[0]) ? 1 : 0;
        if (firstIdx >= liveNodes.length) return { hasEarlyReturn: true, earlyReturn: masked, measurement, range };
        const safeRange = selectCompactableRange(session, measurement, 0);
        const nextStart = liveNodes.includes(range.start) ? range.start : (safeRange?.start ?? liveNodes[firstIdx]);
        const nextEnd = liveNodes.includes(range.end) ? range.end : (safeRange?.end ?? liveNodes.at(-1));
        const nextStartIdx = liveNodes.indexOf(nextStart);
        const nextEndIdx = liveNodes.indexOf(nextEnd);
        if (nextStartIdx < 0 || nextEndIdx < nextStartIdx) {
          if (!safeRange) return { hasEarlyReturn: true, earlyReturn: masked, measurement, range };
          range = safeRange;
        } else {
          range = { start: nextStart, end: nextEnd };
        }
      }
      if (!maskPlan.hasMore) break;
    }
    if (totalMaskedCount > 0 && range) {
      const postMaskNodes = session.surface?.nodes ?? [];
      const postMaskSeqs = postMaskNodes.slice(postMaskNodes.indexOf(range.start), postMaskNodes.indexOf(range.end) + 1);
      engine._syncProgressScopeAfterMask(progressScope, session, postMaskSeqs, totalMaskedSaved);
    }
  }
  return { hasEarlyReturn: false, measurement, range };
}

async function runManualSummaryBatchLoop(
  engine,
  {
    session,
    agent,
    policy,
    budgetSpec,
    manual,
    triggerName,
    idle,
    baseCompletedChunks,
    allowForeignFallback,
    checkpointMeta,
    sourceCommandId,
    effectiveFocus,
    additionalContext,
    softenCoverageForFocus,
    capacityContext,
    runSignal,
    initOrSyncJob,
    clearActiveJob,
    state,
  },
) {
  const maxWaves = 8;
  const foldThreshold = Math.max(2, policy.cacheMaxCheckpoints ?? 4);
  const canFallbackContinuation = Boolean(policy.continuationEnabled && policy.archiveEnabled && engine.historyToolsAvailable);
  const requestedConcurrency = Number.isInteger(policy.summaryConcurrency)
    ? Math.max(1, Math.min(6, policy.summaryConcurrency))
    : 1;

  for (let chunk = 0; chunk < engine.config.maxSummaryChunks; chunk++) {
    runSignal?.throwIfAborted?.();
    const live = new Set(session.surface.nodes);
    state.pending = state.pending.filter((seq) => live.has(seq));
    if (!state.pending.length) {
      clearActiveJob();
      return combineBatchResults(state.results, state.foldResults);
    }
    if (state.results.length || baseCompletedChunks > 0) {
      const remainder = measureSummaryRange(session, { start: state.pending[0], end: state.pending.at(-1) }, { policy, language: policy.language });
      if (remainder.minimumCheckpointBytes >= remainder.sourceBytes) {
        engine.log('info', 'Remaining messages cannot shrink with the selected memory; keeping them on the surface.');
        clearActiveJob();
        return { ...combineBatchResults(state.results, state.foldResults), retainedOriginalSeqs: state.pending };
      }
    }

    const remainingSlots = Math.max(0, engine.config.maxSummaryChunks - chunk);
    if (
      requestedConcurrency > 1 &&
      (state.results.length >= 1 || baseCompletedChunks > 0) &&
      state.pending.length >= 2 &&
      remainingSlots >= 2
    ) {
      const bulkFoldThreshold = Math.max(
        foldThreshold,
        resolveBulkFoldThreshold(
          policy,
          baseCompletedChunks + state.results.length + estimateBulkChunkCount(session, state.pending, policy, capacityContext.current),
        ),
      );
      const concurrentOutcome = await engine._compactChunksConcurrent({
        session,
        agent,
        signal: runSignal,
        pending: state.pending,
        policy,
        budgetSpec,
        manual,
        trigger: triggerName,
        maxTokens: policy.maxTokens,
        capacityContext,
        maxSlices: remainingSlots,
        baseCompletedChunks,
        results: state.results,
        foldResults: state.foldResults,
        batchCheckpointSeqs: state.batchCheckpointSeqs,
        waveCount: state.waveCount,
        maxWaves,
        foldThreshold: bulkFoldThreshold,
        allowForeignFallback,
        checkpointMeta,
        sourceCommandId,
        focusInstruction: effectiveFocus,
        additionalContext,
        softenCoverageForFocus,
        deferCapacityFailureRecord: canFallbackContinuation,
        onAfterCommit: ({ pending: nextPending, waveCount: nextWave, batchCheckpointSeqs: nextCps }) => {
          state.pending = nextPending;
          state.waveCount = nextWave;
          state.batchCheckpointSeqs = nextCps;
          initOrSyncJob(state.pending, baseCompletedChunks + state.results.length, state.waveCount, state.batchCheckpointSeqs);
        },
      });
      if (concurrentOutcome.used) {
        state.pending = concurrentOutcome.pending;
        state.waveCount = concurrentOutcome.waveCount;
        state.batchCheckpointSeqs = concurrentOutcome.batchCheckpointSeqs;
        chunk += Math.max(0, concurrentOutcome.committedCount - 1);
        continue;
      }
    }

    engine._trackUpdate(session, {
      phase: 'planning',
      chunkIndex: baseCompletedChunks + state.results.length + 1,
      chunkTotal: null,
      waveIndex: state.waveCount > 0 ? state.waveCount + 1 : null,
      retryReasonCode: null,
      ...engine._computeCompressionProgress(session, [], 0),
    });
    const result = await engine._compactRegionCore(state.pending[0], state.pending.at(-1), agent, runSignal, {
      manual,
      trigger: triggerName,
      maxTokens: policy.maxTokens,
      policy,
      budgetSpec,
      capacityContext,
      skipUnshrinkable: idle,
      idle: Boolean(idle),
      deferCapacityFailureRecord: canFallbackContinuation,
      ...(effectiveFocus ? { focusInstruction: effectiveFocus } : {}),
      ...(additionalContext ? { additionalContext } : {}),
      softenCoverageForFocus,
      ...(allowForeignFallback ? { allowForeignFallback: true } : {}),
      ...(checkpointMeta ? { checkpointMeta } : {}),
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    });
    if (!result) {
      clearActiveJob();
      return combineBatchResults(state.results, state.foldResults);
    }
    state.results.push(result);
    if (typeof result.replacementSeq === 'number') state.batchCheckpointSeqs.push(result.replacementSeq);
    const liveAfter = new Set(session.surface.nodes);
    state.pending = state.pending.filter((seq) => liveAfter.has(seq));
    engine._trackUpdate(session, { retryReasonCode: null, ...engine._computeCompressionProgress(session, [], 0) });
    initOrSyncJob(state.pending, baseCompletedChunks + state.results.length, state.waveCount, state.batchCheckpointSeqs);
    const serialFoldThreshold = Math.max(
      foldThreshold,
      resolveBulkFoldThreshold(
        policy,
        baseCompletedChunks + state.results.length + estimateBulkChunkCount(session, state.pending, policy, capacityContext.current),
      ),
    );
    if (state.batchCheckpointSeqs.length >= serialFoldThreshold && state.pending.length > 0 && state.waveCount < maxWaves && chunk + 1 < engine.config.maxSummaryChunks) {
      state.waveCount += 1;
      const folded = await engine._tryHierarchicalFold({
        session,
        agent,
        signal: runSignal,
        batchCheckpointSeqs: state.batchCheckpointSeqs,
        policy,
        budgetSpec,
        manual,
        maxTokens: policy.maxTokens,
        capacityContext,
        sourceCommandId,
        waveIndex: state.waveCount,
        allowForeignFallback,
        checkpointMeta,
        focusInstruction: effectiveFocus,
        additionalContext,
        softenCoverageForFocus,
      });
      if (folded) {
        state.foldResults.push(folded);
        state.batchCheckpointSeqs = typeof folded.replacementSeq === 'number' ? [folded.replacementSeq] : [];
        initOrSyncJob(state.pending, baseCompletedChunks + state.results.length, state.waveCount, state.batchCheckpointSeqs);
      } else {
        state.batchCheckpointSeqs = [];
      }
    }
  }
  if (state.pending.some((seq) => session.surface.nodes.includes(seq))) {
    throw Object.assign(new Error(`manual compaction reached maxSummaryChunks=${engine.config.maxSummaryChunks}; completed chunks remain committed`), {
      code: 'SUMMARY_BATCH_LIMIT',
    });
  }
  clearActiveJob();
  return combineBatchResults(state.results, state.foldResults);
}

async function handleManualBatchError(
  engine,
  {
    error,
    session,
    agent,
    policy,
    manual,
    idle,
    triggerOverride,
    hookTrigger,
    sourceCommandId,
    resumableJob,
    baseCompletedChunks,
    allowForeignFallback,
    checkpointMeta,
    allowPolicyRestart,
    manualRetry,
    effectiveFocus,
    additionalContext,
    softenCoverageForFocus,
    capacityContext,
    runSignal,
    cancelController,
    initOrSyncJob,
    clearActiveJob,
    state,
  },
) {
  if (
    triggerOverride === 'migration' &&
    (state.results.length + baseCompletedChunks) > 0 &&
    isUnshrinkableTailError(error) &&
    !detectBiliSession(session).detected
  ) {
    engine.log('info', 'Migration cleared all billion-context nodes; retaining unshrinkable non-bili tail on surface.');
    clearActiveJob();
    return { ...combineBatchResults(state.results, state.foldResults), retainedOriginalSeqs: state.pending };
  }
  let finalError = error;
  const contResults = [];
  if (policy.continuationEnabled && policy.archiveEnabled && engine.historyToolsAvailable && continuationEligible(error) && !runSignal?.aborted) {
    try {
      const contRun = await engine._runContinuationWaves({
        session,
        agent,
        policy,
        maxTokens: policy.maxTokens,
        signal: runSignal,
        capacityContext,
        manual,
        trigger: hookTrigger,
        sourceCommandId,
        idle: Boolean(idle),
        allowForeignFallback,
        checkpointMeta,
        allowPolicyRestart,
        manualRetry: manualRetry || manual,
        maxWaves: 12,
        collector: contResults,
        focusInstruction: effectiveFocus,
        additionalContext,
        softenCoverageForFocus,
        onWaveCommitted: () => {
          const liveNow = new Set(session.surface.nodes);
          state.pending = state.pending.filter((seq) => liveNow.has(seq));
          initOrSyncJob(state.pending, baseCompletedChunks + state.results.length + contResults.length, state.waveCount + contResults.length, []);
        },
      });
      if (contRun.idleSkipped) {
        clearActiveJob();
        return combineBatchResults([...state.results, ...contResults], state.foldResults);
      }
      if (contResults.length > 0) {
        clearActiveJob();
        return state.results.length === 0 && state.foldResults.length === 0 && contResults.length === 1
          ? contResults[0]
          : combineBatchResults([...state.results, ...contResults], state.foldResults);
      }
    } catch (contError) {
      finalError = contError;
    }
  }
  if (
    triggerOverride === 'migration' &&
    (state.results.length + contResults.length + baseCompletedChunks) > 0 &&
    isUnshrinkableTailError(finalError) &&
    !detectBiliSession(session).detected
  ) {
    engine.log('info', 'Migration cleared all billion-context nodes; retaining unshrinkable non-bili tail on surface.');
    clearActiveJob();
    return { ...combineBatchResults([...state.results, ...contResults], state.foldResults), retainedOriginalSeqs: state.pending };
  }
  if (idle && finalError.code === 'SUMMARY_NOT_SMALLER' && finalError.localCapacityRejection) {
    clearActiveJob();
    return combineBatchResults([...state.results, ...contResults], state.foldResults);
  }
  if (
    !runSignal?.aborted &&
    !isAbortError(finalError, runSignal) &&
    !cancelController.signal.aborted &&
    finalError?.code !== 'cancelled' &&
    finalError?.code !== 'RECOVERY_REQUIRED' &&
    finalError?.code !== 'STATE_UNAVAILABLE' &&
    finalError?.code !== 'commit' &&
    finalError?.hookCancelled !== true
  ) {
    try { engine._recordFailure(agent, session, finalError); } catch {}
  }
  if (state.activeJob) {
    const liveFail = new Set(session.surface.nodes);
    state.pending = state.pending.filter((seq) => liveFail.has(seq));
    state.activeJob = {
      ...state.activeJob,
      remainingSeqs: state.pending,
      batchCheckpointSeqs: state.batchCheckpointSeqs.filter((s) => liveFail.has(s)),
    };
    engine._persistResumableInterrupted(session, state.activeJob, finalError, runSignal, {
      userCancelled: cancelController.signal.aborted,
      wasResumed: Boolean(resumableJob),
    });
  }
  const committedAll = [...state.results, ...contResults];
  if (committedAll.length) {
    const allIds = [...committedAll, ...state.foldResults].flatMap((r) => r.compactionIds ?? [r.compactionId]);
    const partial = new Error(`${committedAll.length} summary chunk(s) committed; remaining history retained: ${finalError.message}`, {
      cause: finalError,
    });
    partial.code = 'commit';
    partial.compactionStage = 'commit';
    partial.compactionIds = allIds;
    throw partial;
  }
  throw finalError;
}

function createManualJobTracker(
  engine,
  session,
  {
    shouldTrackResumable,
    triggerName,
    progressScope,
    initMeasurement,
    resumableJob,
    originalBackupId,
    allowForeignFallback,
    checkpointMeta,
    effectiveFocus = '',
    softenCoverageForFocus = false,
    state,
  },
) {
  const initOrSyncJob = (seqs, completedChunksCount, nextWaveCount, batchCps) => {
    if (!shouldTrackResumable) return;
    if (!Array.isArray(seqs) || seqs.length === 0) {
      if (state.activeJob) {
        try { clearResumableCompaction(engine.sessionState, session.id); } catch {}
        state.activeJob = null;
      }
      return;
    }
    if (!state.activeJob) {
      state.activeJob = engine._persistResumableRunning(session, resumableJob
        ? {
            ...resumableJob,
            status: 'running',
            interruptReason: null,
            remainingSeqs: [...seqs],
            completedChunks: completedChunksCount,
            waveCount: nextWaveCount,
            batchCheckpointSeqs: [...batchCps],
            ...(resumableJob.focusInstruction || effectiveFocus
              ? { focusInstruction: resumableJob.focusInstruction ?? effectiveFocus }
              : {}),
            ...(resumableJob.softenCoverageForFocus || softenCoverageForFocus
              ? { softenCoverageForFocus: Boolean(resumableJob.softenCoverageForFocus || softenCoverageForFocus) }
              : {}),
            ...(originalBackupId && !resumableJob.originalBackupId ? { originalBackupId } : {}),
          }
        : {
            jobId: `job-${randomUUID().slice(0, 12)}`,
            trigger: triggerName,
            status: 'running',
            remainingSeqs: [...seqs],
            initialTotalNodes: progressScope.totalNodes || seqs.length,
            completedNodes: progressScope.doneNodes ?? 0,
            initialTotalTokens: progressScope.totalTokens || initMeasurement.totalTokens,
            completedTokens: progressScope.doneTokens ?? 0,
            completedChunks: completedChunksCount,
            waveCount: nextWaveCount,
            batchCheckpointSeqs: [...batchCps],
            allowForeignFallback: allowForeignFallback === true,
            checkpointMeta: checkpointMeta && typeof checkpointMeta === 'object' ? { ...checkpointMeta } : null,
            originalBackupId: originalBackupId ?? checkpointMeta?.migrationBackupId ?? null,
            focusInstruction: effectiveFocus || null,
            softenCoverageForFocus: Boolean(softenCoverageForFocus),
            consecutiveFailures: 0,
          });
      return;
    }
    const doneNodes = Math.max(
      state.activeJob.completedNodes ?? 0,
      Math.min(state.activeJob.initialTotalNodes, state.activeJob.initialTotalNodes - seqs.length),
    );
    const doneTokens = Math.max(
      state.activeJob.completedTokens ?? 0,
      Math.min(state.activeJob.initialTotalTokens, progressScope.doneTokens ?? 0),
    );
    state.activeJob = engine._persistResumableRunning(session, {
      ...state.activeJob,
      remainingSeqs: [...seqs],
      completedNodes: doneNodes,
      completedTokens: doneTokens,
      completedChunks: completedChunksCount,
      waveCount: nextWaveCount,
      batchCheckpointSeqs: [...batchCps],
    });
  };
  const clearActiveJob = () => {
    if (state.activeJob || resumableJob) {
      try { clearResumableCompaction(engine.sessionState, session.id); } catch {}
      state.activeJob = null;
    }
  };
  return { initOrSyncJob, clearActiveJob };
}

async function executeManualRolloverFlow(
  engine,
  {
    session,
    agent,
    initRange,
    initialManualSeqs,
    baseCompletedChunks,
    resumableJob,
    manual,
    hookTrigger,
    sourceCommandId,
    policy,
    budgetSpec,
    idle,
    capacityContext,
    manualRetry,
    allowPolicyRestart,
    effectiveFocus,
    additionalContext,
    softenCoverageForFocus,
    allowForeignFallback,
    checkpointMeta,
    runSignal,
    cancelController,
    initOrSyncJob,
    clearActiveJob,
    state,
  },
) {
  if (initialManualSeqs.length > 0) {
    initOrSyncJob(resumableJob?.remainingSeqs ?? initialManualSeqs, baseCompletedChunks, resumableJob?.waveCount ?? 0, resumableJob?.batchCheckpointSeqs ?? []);
  }
  try {
    const rolloverResult = await engine._compactRegionCore(initRange.start, initRange.end, agent, runSignal, {
      manual,
      trigger: hookTrigger,
      sourceCommandId,
      policy,
      budgetSpec,
      continuation: true,
      idle: Boolean(idle),
      capacityContext,
      manualRetry: manualRetry || manual,
      allowPolicyRestart,
      ...(effectiveFocus ? { focusInstruction: effectiveFocus } : {}),
      ...(additionalContext ? { additionalContext } : {}),
      softenCoverageForFocus,
      ...(allowForeignFallback ? { allowForeignFallback: true } : {}),
      ...(checkpointMeta ? { checkpointMeta } : {}),
    });
    const live = new Set(session.surface.nodes);
    const remaining = (resumableJob?.remainingSeqs ?? initialManualSeqs).filter(seq => live.has(seq));
    if (remaining.length) {
      initOrSyncJob(remaining, baseCompletedChunks + 1, (resumableJob?.waveCount ?? 0) + 1, []);
      state.activeJob = writeResumableCompaction(engine.sessionState, session.id, { ...state.activeJob, status: 'interrupted' });
    } else {
      clearActiveJob();
    }
    return rolloverResult;
  } catch (rolloverError) {
    if (state.activeJob) {
      engine._persistResumableInterrupted(session, state.activeJob, rolloverError, runSignal, {
        userCancelled: cancelController.signal.aborted,
        wasResumed: Boolean(resumableJob),
      });
    }
    throw rolloverError;
  }
}

async function runManualTrackedFlow(
  engine,
  {
    session,
    agent,
    signal,
    manual,
    idle,
    proactive,
    rollover,
    measurement: initMeasurement,
    policy,
    budgetSpec,
    cacheRetain,
    baseRetain,
    range: initRange,
    explicitRange,
    sourceCommandId,
    triggerOverride,
    hookTrigger,
    resumableJob,
    allowForeignFallback,
    allowPolicyRestart,
    manualRetry,
    checkpointMeta,
    originalBackupId,
    effectiveFocus,
    additionalContext,
    softenCoverageForFocus,
  },
) {
  const triggerName = triggerOverride ?? (idle ? 'idle' : proactive ? 'proactive' : 'manual');
  const initialManualNodes = session.surface?.nodes ?? [];
  const initialManualSeqs = initialManualNodes.slice(
    initialManualNodes.indexOf(initRange.start),
    initialManualNodes.indexOf(initRange.end) + 1,
  );
  const scopeOpts = {
    beforeTokens: initMeasurement.totalTokens,
    ...(resumableJob
      ? {
          priorCompletedNodes: resumableJob.completedNodes ?? 0,
          priorCompletedTokens: resumableJob.completedTokens ?? 0,
          initialTotalNodes: resumableJob.initialTotalNodes ?? 0,
          initialTotalTokens: resumableJob.initialTotalTokens ?? 0,
        }
      : {}),
  };
  return engine._withProgressScope(session, initialManualSeqs, scopeOpts, (progressScope) =>
    engine._trackRun(
      session,
      {
        trigger: triggerName,
        phase: triggerOverride === 'migration' ? 'migrating' : 'detecting',
        beforeTokens: initMeasurement.totalTokens,
        currentTokens: initMeasurement.totalTokens,
        overallPercent: resumableJob
          ? Math.max(12, Math.min(95, Math.round(12 + 84 * (progressScope.doneNodes / Math.max(1, progressScope.totalNodes)))))
          : (triggerOverride === 'migration' ? 12 : 2),
        overallProcessedNodes: progressScope.doneNodes,
        overallTotalNodes: progressScope.totalNodes,
        overallProcessedTokens: progressScope.doneTokens,
        overallTotalTokens: progressScope.totalTokens,
      },
      (runId) => engine._runWithCancel(session, runId, signal, async (runSignal, cancelController) => {
        const capacityContext = {};
        const shouldTrackResumable = Boolean(resumableJob) || (!idle && !proactive);
        const baseCompletedChunks = resumableJob?.completedChunks ?? 0;
        const state = {
          activeJob: null,
          pending: [],
          results: [],
          foldResults: [],
          batchCheckpointSeqs: [],
          waveCount: 0,
        };
        const { initOrSyncJob, clearActiveJob } = createManualJobTracker(engine, session, {
          shouldTrackResumable,
          triggerName,
          progressScope,
          initMeasurement,
          resumableJob,
          originalBackupId,
          allowForeignFallback,
          checkpointMeta,
          effectiveFocus,
          softenCoverageForFocus,
          state,
        });

        if (rollover) {
          return await executeManualRolloverFlow(engine, {
            session,
            agent,
            initRange,
            initialManualSeqs,
            baseCompletedChunks,
            resumableJob,
            manual,
            hookTrigger,
            sourceCommandId,
            policy,
            budgetSpec,
            idle,
            capacityContext,
            manualRetry,
            allowPolicyRestart,
            effectiveFocus,
            additionalContext,
            softenCoverageForFocus,
            allowForeignFallback,
            checkpointMeta,
            runSignal,
            cancelController,
            initOrSyncJob,
            clearActiveJob,
            state,
          });
        }

        const stage1 = await runManualStage1PreMasking(engine, {
          session,
          agent,
          policy,
          triggerName,
          idle,
          proactive,
          rollover,
          resumableJob,
          allowForeignFallback,
          effectiveFocus,
          additionalContext,
          initialManualSeqs,
          measurement: initMeasurement,
          range: initRange,
          explicitRange,
          cacheRetain,
          baseRetain,
          capacityContext,
          progressScope,
          runSignal,
        });
        if (stage1.hasEarlyReturn) return stage1.earlyReturn;

        const range = stage1.range;
        const originalNodes = session.surface.nodes;
        state.pending = originalNodes.slice(originalNodes.indexOf(range.start), originalNodes.indexOf(range.end) + 1);
        const initialLiveSet = new Set(originalNodes);
        state.batchCheckpointSeqs = Array.isArray(resumableJob?.batchCheckpointSeqs)
          ? resumableJob.batchCheckpointSeqs.filter((seq) => initialLiveSet.has(seq))
          : [];
        state.waveCount = Number.isInteger(resumableJob?.waveCount) && resumableJob.waveCount >= 0
          ? resumableJob.waveCount
          : 0;
        initOrSyncJob(state.pending, baseCompletedChunks, state.waveCount, state.batchCheckpointSeqs);
        try {
          return await runManualSummaryBatchLoop(engine, {
            session,
            agent,
            policy,
            budgetSpec,
            manual,
            triggerName,
            idle,
            baseCompletedChunks,
            allowForeignFallback,
            checkpointMeta,
            sourceCommandId,
            effectiveFocus,
            additionalContext,
            softenCoverageForFocus,
            capacityContext,
            runSignal,
            initOrSyncJob,
            clearActiveJob,
            state,
          });
        } catch (error) {
          return await handleManualBatchError(engine, {
            error,
            session,
            agent,
            policy,
            manual,
            idle,
            triggerOverride,
            hookTrigger,
            sourceCommandId,
            resumableJob,
            baseCompletedChunks,
            allowForeignFallback,
            checkpointMeta,
            allowPolicyRestart,
            manualRetry,
            effectiveFocus,
            additionalContext,
            softenCoverageForFocus,
            capacityContext,
            runSignal,
            cancelController,
            initOrSyncJob,
            clearActiveJob,
            state,
          });
        }
      }),
    ),
  );
}

/**
 * Core manual, proactive, idle-full, or migration compaction pipeline.
 * @param {object} engine
 * @param {object} agent
 * @param {AbortSignal|undefined} signal
 * @param {string|undefined} sourceCommandId
 * @param {boolean} [continuation=false]
 * @param {boolean} [proactive=false]
 * @param {object} [opts]
 */
export async function compactManualInner(
  engine,
  agent,
  signal,
  sourceCommandId,
  continuation = false,
  proactive = false,
  {
    idle = false,
    explicitRange = null,
    allowForeignFallback = false,
    checkpointMeta = null,
    triggerOverride = null,
    manualOverride = null,
    resumableJob = null,
    allowPolicyRestart = false,
    manualRetry = false,
    originalBackupId = resumableJob?.originalBackupId ?? null,
    focusInstruction = '',
    hooksHandled = false,
    hookManual = null,
    softenCoverageForFocus = undefined,
    busyAlreadyHeld = false,
  } = {},
) {
  const manual = manualOverride !== null ? Boolean(manualOverride) : !proactive;
  const effectiveHookManual = hookManual !== null ? Boolean(hookManual) : manual;
  const session = agent?.session;
  if (!session) return null;
  const ownedBusy = !engine._busy.has(session);
  if (!ownedBusy && !triggerOverride && !busyAlreadyHeld) {
    throw Object.assign(new Error('manual compaction: compaction already in progress'), { code: 'busy' });
  }

  const hookTrigger = triggerOverride ?? (proactive ? 'proactive' : idle ? 'idle' : continuation ? 'manual-continuation' : 'manual');
  engine._assertNoActiveBiliConflict(session, hookTrigger);
  const userFocus = sanitizeFocusInstruction(focusInstruction ?? '');
  let manualResult = null;
  if (ownedBusy) engine._busy.add(session);
  engine._agentBySession.set(session, agent);
  if (idle || continuation || userFocus.length > 0 || allowForeignFallback) {
    engine.sessionMemory?.cancel?.(session.id);
  }
  try {
    const setup = await prepareManualCompactionSetup(engine, {
      session,
      agent,
      signal,
      manual,
      hookManual: effectiveHookManual,
      idle,
      proactive,
      continuation,
      hookTrigger,
      explicitRange,
      allowPolicyRestart,
      resumableJob,
      userFocus,
      hooksHandled,
      softenCoverageForFocus,
    });
    if (!setup) return null;

    if (setup.idleContinuationTarget) {
      const next = setup.idleContinuationTarget;
      const idleNodes = session.surface?.nodes ?? [];
      const idleTargetSeqs = idleNodes.slice(idleNodes.indexOf(next.start), idleNodes.indexOf(next.end) + 1);
      manualResult = await engine._withProgressScope(session, idleTargetSeqs, { beforeTokens: setup.measurement.totalTokens }, (idleScope) =>
        engine._trackRun(
          session,
          {
            trigger: 'idle',
            phase: 'continuing',
            beforeTokens: setup.measurement.totalTokens,
            currentTokens: setup.measurement.totalTokens,
            overallPercent: 12,
            overallProcessedNodes: 0,
            overallTotalNodes: idleScope.totalNodes,
            overallProcessedTokens: 0,
            overallTotalTokens: idleScope.totalTokens,
          },
          (runId) =>
            engine._runWithCancel(session, runId, signal, (runSignal) =>
              engine._compactRegionCore(next.start, next.end, agent, runSignal, {
                manual,
                trigger: hookTrigger,
                sourceCommandId,
                policy: setup.policy,
                budgetSpec: setup.budgetSpec,
                continuation: true,
                idle: Boolean(idle),
                manualRetry: manualRetry || manual,
                allowPolicyRestart,
                ...(setup.effectiveFocus ? { focusInstruction: setup.effectiveFocus } : {}),
                ...(setup.additionalContext ? { additionalContext: setup.additionalContext } : {}),
                softenCoverageForFocus: setup.softenCoverageForFocus,
              }),
            ),
        ),
      );
    } else {
      manualResult = await runManualTrackedFlow(engine, {
        session,
        agent,
        signal,
        manual,
        idle,
        proactive,
        rollover: setup.rollover,
        measurement: setup.measurement,
        policy: setup.policy,
        budgetSpec: setup.budgetSpec,
        cacheRetain: setup.cacheRetain,
        baseRetain: setup.baseRetain,
        range: setup.range,
        explicitRange,
        sourceCommandId,
        triggerOverride,
        hookTrigger,
        resumableJob,
        allowForeignFallback,
        allowPolicyRestart,
        manualRetry,
        checkpointMeta,
        originalBackupId,
        effectiveFocus: setup.effectiveFocus,
        additionalContext: setup.additionalContext,
        softenCoverageForFocus: setup.softenCoverageForFocus,
      });
    }
  } finally {
    if (ownedBusy) engine._busy.delete(session);
  }
  if (!hooksHandled && manualResult != null) {
    await engine._runPostCompactHook({
      session,
      trigger: hookTrigger,
      manual: effectiveHookManual,
      focusInstruction: userFocus,
      result: manualResult,
      signal,
    });
  }
  return manualResult;
}
