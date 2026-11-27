// Span commit lifecycle, region planning/locking, pre-commit audit/archive gates,
// synchronous triple-append / StockTransactionAdapter commit, and L6 reactive recovery.
// Every exported function takes `engine` as its first argument and NEVER imports `../engine.js`.

import { Buffer } from 'node:buffer';
import { dirname } from 'node:path';
import { DEFAULT_CONFIG } from '../config.js';
import { redactCredentials, redactErrorText } from '../redact.js';
import { planSummaryRange, measureSummaryRange, fitsCapacity, resolveSummaryCapacity, DEFAULT_MAX_CHUNK_TOOL_SOURCE_REFS } from '../summary-budget.js';
import { prepareContinuation, continuationEligible } from '../continuation.js';
import { readPendingContinuation, assertPendingSource, freezeContinuation, bindContinuationProgress, settleContinuation, releaseUnstartedContinuation } from '../continuation-pending.js';
import { collectProgressFacts, progressSourceRefs, validateProgressFacts } from '../progress-facts.js';
import { collectWorkReport, workReportRef } from '../work-report.js';
import { noteDiagnosticMeasurement } from '../failure-diagnostics.js';
import { sourceKindOf, withReferencePolicy } from '../source-provenance.js';
import {
  extractRawImageOffloadError,
  isImageOffloadRequiredError,
  isUpstreamMultimodal400Error,
  measureVisibleImages,
  selectOldestImageTargets,
} from '../image-budget.js';
import { isBiliProxyPreflightError } from '../bili-conflict.js';
import { approxTokens, blocksToText, estimateHostHeuristicSpan } from '../meter.js';
import { dumpAuditRejection } from '../audit-reject.js';
import { normalizeRetryReasonCode } from '../progress-tracker.js';
import { reconstructDisputedLines } from '../reconstruct.js';
import { MAX_AUDIT_FALLBACK_CONFLICTS, classifyBlockingAuditLost } from '../audit-fallback.js';
import { clearBreakerState } from '../state.js';
import {
  assertCompactionInactive,
  buildSummarizationInput,
  collectArchivedFiles,
  collectChildArchiveIds,
  collectInstructionMessages,
  inspectCompactionEntryState,
  preservedForSource,
  selectSessionMemory,
  systemHead,
  validateSurfaceRegion,
} from '../region.js';
import {
  deduplicateNotes,
  memoryDecisionsForSource,
  memoryPolicyInstruction,
  memoryRequirements,
  memorySourceRefs,
  retiredMemoryPresent,
} from '../memory-policy.js';
import { auditInstructionProvenance, summarizeProvenanceFailures } from '../audit.js';
import { collectReferenceMessages } from '../constraint-scope.js';
import { sanitizeAdditionalContext, sanitizeFocusInstruction } from '../prompt.js';
import { spanEntries } from '../history.js';
import { latestDurableTarget, summarizeWithChain } from '../summary.js';
import {
  materializeUserMessageSection,
  summaryProse,
  validateCheckpointCoverage,
  validateSummaryStructure,
  validateUserMessageSection,
} from '../validate.js';
import {
  activeTransactions,
  canonicalMessageBytes,
  cleanupUncommittedArchive,
  compactCheckpointSource,
  isAbortError,
  newMessageId,
  nextCompactionId,
} from './shared.js';

/**
 * Region compaction entrypoint honoring modelPolicies and optional hooks.
 * @param {object} engine
 * @param {number} start
 * @param {number} end
 * @param {object} agent
 * @param {AbortSignal|undefined} signal
 * @param {string|undefined} sourceCommandId
 * @param {object} [options={}]
 */
export async function compactRegionInner(engine, start, end, agent, signal, sourceCommandId, options = {}) {
  const session = agent?.session;
  if (!session) throw new Error('compactRegion: no session');
  if (engine._busy.has(session)) {
    throw Object.assign(new Error('compactRegion: compaction already in progress'), { code: 'busy' });
  }
  engine._busy.add(session);
  try {
    engine._restoreState(session);
    if (engine._stopped.has(engine._keyOf(session))) return null;
    const policy = engine._resolvePolicy(agent);
    const spec = await engine._resolveSpec(agent, undefined, signal).catch((error) => {
      if (error?.code === 'STATE_UNAVAILABLE' || isAbortError(error, signal)) throw error;
      return undefined;
    });
    const hooksHandled = options?.hooksHandled === true;
    const userFocus = sanitizeFocusInstruction(options?.focusInstruction ?? '');
    let effectiveFocus = userFocus;
    let additionalContext = '';
    if (!hooksHandled && session) {
      const measurement = await engine._measure(session).catch(() => null);
      const preHook = await engine._runPreCompactHook({
        session,
        trigger: 'region',
        manual: false,
        focusInstruction: userFocus,
        totalTokens: measurement?.totalTokens ?? null,
        range: { start, end },
        continuation: false,
        signal,
      });
      if (preHook.cancelled) return null;
      effectiveFocus = preHook.effectiveFocus;
      additionalContext = preHook.additionalContext;
    }
    const result = await engine._compactRegionCore(start, end, agent, signal, {
      manual: false,
      trigger: 'region',
      ...(spec?.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens }),
      policy,
      budgetSpec: spec ?? null,
      ...(effectiveFocus ? { focusInstruction: effectiveFocus } : {}),
      ...(additionalContext ? { additionalContext } : {}),
      softenCoverageForFocus: false,
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    });
    if (!hooksHandled && result != null && session) {
      await engine._runPostCompactHook({
        session,
        trigger: 'region',
        manual: false,
        focusInstruction: userFocus,
        result,
        signal,
      });
    }
    return result;
  } finally {
    engine._busy.delete(session);
  }
}

async function resolveRegionCommitMode(engine, session, policy) {
  const strictHost = Boolean(policy?.strictHostFingerprints) || Boolean(engine.requireTransactionAdapter);
  let useAtomicCommit = false;
  if (typeof session.restoreCompactionSurface !== 'function') {
    if (!engine.transactionAdapter) {
      if (strictHost) {
        const e = new Error('Stock-host transaction adapter is unavailable; compression is refused before changing history.');
        e.code = 'RECOVERY_REQUIRED';
        throw e;
      }
      await engine._assertNoUnrecoveredAtomicJournal(session);
      engine._warnHostFallbackOnce('stock transaction adapter unavailable');
    } else {
      const probe = engine.transactionAdapter.probeSupport(session);
      if (probe.ok) {
        useAtomicCommit = true;
      } else if (strictHost) {
        throw probe.error;
      } else {
        await engine._assertNoUnrecoveredAtomicJournal(session);
        engine._warnHostFallbackOnce(probe.reason);
      }
    }
  }
  return { strictHost, useAtomicCommit };
}

async function tryRegionSessionMemoryReuse(
  engine,
  { start, end, agent, signal, options, session, policy, budgetSpec, entryState, strictHost, useAtomicCommit },
) {
  const focusText = sanitizeFocusInstruction(options.focusInstruction ?? '');
  const additionalContextText = sanitizeAdditionalContext(options.additionalContext ?? '');
  const canTrySessionMemory =
    policy?.sessionMemoryEnabled === true &&
    engine.sessionMemory &&
    !options.precomputed &&
    !options.continuation &&
    !options.allowForeignFallback &&
    options.progressPhase !== 'folding' &&
    focusText.length === 0 &&
    additionalContextText.length === 0;
  if (!canTrySessionMemory) return { reused: false };

  await engine._awaitOrCancelSessionMemory(session, policy, signal, { ...options, expectedStartSeq: start });
  const liveNodes = session.surface?.nodes ?? [];
  const sIdx = liveNodes.indexOf(start);
  const eIdx = liveNodes.indexOf(end);
  if (sIdx < 0 || eIdx < sIdx) return { reused: false };

  const candidateSeqs = liveNodes.slice(sIdx, eIdx + 1);
  const smMatch = engine.sessionMemory.matchForSpan(session, candidateSeqs, policy, { allowPrefixSplit: true });
  if (!smMatch) return { reused: false };

  const prepared = engine._validateSessionMemoryReuse(session, smMatch, policy, { ...options, budgetSpec });
  if (!prepared) return { reused: false };

  const replaceGenerationBefore = session.surface?.replaceGeneration ?? 0;
  engine.log(
    'info',
    `reusing verified session memory (${smMatch.mode}, coveredThroughSeq=${smMatch.coveredThroughSeq}, 0 LLM calls)`,
  );
  try {
    const result = await engine._compactSpan(
      prepared.shadowedSeqs[0],
      prepared.shadowedSeqs.at(-1),
      agent,
      signal,
      {
        ...options,
        precomputed: prepared,
        preservePrefixCache: false,
        strictHost,
        useAtomicCommit,
        reselect: undefined,
        turn: options.manual ? null : (entryState.openTurn ?? null),
      },
      0,
    );
    return { reused: true, result };
  } catch (error) {
    if (
      typeof session.restoreCompactionSurface === 'function' ||
      (session.surface?.replaceGeneration ?? 0) > replaceGenerationBefore
    ) {
      try {
        const recovery = await engine.recoverPending(
          session,
          true,
          isAbortError(error, signal) ? 'cancelled' : 'failed',
        );
        if (recovery.restored > 0 && error && typeof error === 'object') error.surfaceRestored = true;
      } catch (recoveryError) {
        engine._addBounded(engine._recoveryBlocked, engine._keyOf(session));
        const blocked = new AggregateError(
          [error, recoveryError],
          'compaction failed and restoration must finish before another model request',
        );
        blocked.code = 'RECOVERY_REQUIRED';
        blocked.compactionStage = 'commit';
        blocked.cause = error;
        throw blocked;
      }
    }
    throw error;
  }
}

async function planRegionForCommit(engine, { start, end, agent, signal, options, session, policy }) {
  const targets = engine._resolveSummaryTargets(policy, agent);
  const capacity = options.capacityContext?.current ?? await resolveSummaryCapacity(
    engine.ctx,
    targets,
    { ...policy, maxTokens: options.maxTokens ?? policy.maxTokens },
    signal,
    { singleTarget: true },
  );
  if (options.capacityContext) options.capacityContext.current = capacity;
  const planning = {
    policy,
    language: policy.language,
    historyToolsAvailable: Boolean(engine.historyToolsAvailable),
    pricedInput: (seqs) => engine._shadowedTokens(session, seqs),
    singleTarget: true,
    boundedWave: true,
    maxToolSourceRefs: DEFAULT_MAX_CHUNK_TOOL_SOURCE_REFS,
    ...(options.allowForeignFallback === true ? { allowForeignFallback: true } : {}),
    ...(options.focusInstruction ? { focusInstruction: options.focusInstruction } : {}),
    ...(options.additionalContext ? { additionalContext: options.additionalContext } : {}),
  };
  let planned;
  try {
    planned = options.continuation || (options.skipPlan && options.precomputed)
      ? { start, end, limited: false }
      : planSummaryRange(session, { start, end }, capacity, planning);
  } catch (error) {
    if (options.skipUnshrinkable && error.code === 'SUMMARY_NOT_SMALLER' && error.localCapacityRejection) throw error;
    if (options.deferCapacityFailureRecord && continuationEligible(error)) {
      if (error && typeof error === 'object') error._deferredFailureRecord = true;
      throw error;
    }
    if (!options.suppressFailureRecord && !isAbortError(error, signal)) engine._recordFailure(agent, session, error);
    throw error;
  }
  if (!options.precomputed && !options.continuation && !policy.archiveEnabled) {
    const nodes = session.surface?.nodes ?? [];
    const pStartIdx = nodes.indexOf(planned.start);
    const pEndIdx = nodes.indexOf(planned.end);
    if (pStartIdx >= 0 && pEndIdx >= pStartIdx) {
      const plannedSeqs = nodes.slice(pStartIdx, pEndIdx + 1);
      const preMemory = selectSessionMemory(session, plannedSeqs, {
        maxMessages: policy.preserveRecentMessages,
        maxTokens: policy.preserveRecentUserTokens,
        approxTokens,
      });
      if (preMemory.decisions.some((d) => d.reason === 'oldest-quote-evicted')) {
        const error = Object.assign(new Error('Memory selection requires a verified source archive.'), {
          code: 'MEMORY_ARCHIVE_REQUIRED',
        });
        if (!options.suppressFailureRecord && !isAbortError(error, signal)) {
          engine._recordFailure(agent, session, error);
        }
        throw error;
      }
    }
  }
  let preservePrefixCache = false;
  if (!options.continuation && !options.idle && !options.precomputed) {
    const durable = latestDurableTarget(agent);
    const primary = targets.targets[0];
    if (durable && primary && primary.provider === durable.provider && primary.model === durable.model) {
      const verbatim = measureSummaryRange(session, { start: planned.start, end: planned.end }, { ...planning, preservePrefixCache: true });
      if (fitsCapacity(verbatim, capacity, { singleTarget: true })) preservePrefixCache = true;
    }
  }
  if (planned.limited) {
    engine.log('info', `summary capacity split: ${start}-${end} -> ${planned.start}-${planned.end}, ${planned.inputUnits}/${planned.inputLimit} conservative input units`);
  }
  let activeVerbatim = preservePrefixCache;
  const reselect = async (_extra, previous) => {
    const prior = measureSummaryRange(session, previous, { ...planning, preservePrefixCache: activeVerbatim });
    const wasVerbatim = activeVerbatim;
    activeVerbatim = false;
    capacity.shrinkLimit = Math.min(capacity.shrinkLimit, Math.floor((prior.inputUnits ?? planned.inputUnits) / 2));
    if (Number.isFinite(prior.inputTokens)) {
      capacity.shrinkTokenLimit = Math.min(capacity.shrinkTokenLimit ?? Infinity, Math.floor(prior.inputTokens / 2));
    }
    let next;
    try {
      next = planSummaryRange(session, previous, capacity, planning);
    } catch (error) {
      if (['SUMMARY_GROUP_TOO_LARGE', 'SUMMARY_NOT_SMALLER'].includes(error.code)) return null;
      throw error;
    }
    return (next.end !== previous.end || (wasVerbatim && next.inputUnits < prior.inputUnits)) ? next : null;
  };
  let nextOptions = options;
  if (options.continuation) {
    const nodes = session.surface.nodes;
    const pending = freezeContinuation(engine.sessionState, session, nodes.slice(nodes.indexOf(planned.start), nodes.indexOf(planned.end) + 1), options.continuationBudgetTokens);
    nextOptions = { ...options, continuationPending: pending, continuationBudgetTokens: pending.budgetTokens };
  }
  return { planned, options: nextOptions, preservePrefixCache, capacity, reselect };
}

/**
 * Core region compaction lock, validation, session-memory reuse attempt, planning, and span commit.
 * @param {object} engine
 * @param {number} start
 * @param {number} end
 * @param {object} agent
 * @param {AbortSignal|undefined} extSignal
 * @param {object} options
 */
export async function compactRegionCore(engine, start, end, agent, extSignal, options) {
  return engine._runWithActiveSignal(extSignal, async (signal) => {
    const { manual } = options;
    const session = agent?.session;
    if (!session) throw new Error('compactRegion: no session');
    signal?.throwIfAborted?.();
    const transactionKey = `${engine.sessionState.root}:${JSON.stringify(session.id)}`;
    if (activeTransactions.has(transactionKey)) {
      throw Object.assign(new Error('compaction already active for this logical session'), { code: 'busy' });
    }
    activeTransactions.add(transactionKey);
    try {
      await engine.recoverPending(session, true);
      signal?.throwIfAborted?.();
      const pendingContinuation = readPendingContinuation(engine.sessionState, session);
      if (pendingContinuation) {
        assertPendingSource(session, pendingContinuation);
        if (!options.continuation) {
          throw Object.assign(new Error('Finish the saved continuation before starting another compaction.'), {
            code: 'CONTINUATION_PENDING_RANGE',
          });
        }
      }
      validateSurfaceRegion(session, start, end, options.allowUnbalancedPrefix === true ? { allowUnbalancedPrefix: true } : undefined);
      const policy = options.policy ?? engine.config;
      const budgetSpec =
        options.budgetSpec !== undefined
          ? options.budgetSpec
          : (engine._lastSpec?.get(session) ??
              (await engine._resolveSpec(agent, undefined, signal).catch((err) => {
                if (isAbortError(err, signal)) throw err;
                return null;
              })));
      return await withReferencePolicy(policy ?? engine.config, async () => {
        const { strictHost, useAtomicCommit } = await resolveRegionCommitMode(engine, session, policy);
        const entryState = inspectCompactionEntryState(session);
        assertCompactionInactive(entryState.unmatchedCompactionStart, entryState.latestEndSeedSeq, 'compaction');

        if (manual && entryState.openTurn !== null) {
          throw Object.assign(new Error('manual compaction: the session already has an open turn'), { code: 'busy' });
        }
        if (!manual && entryState.openTurn === null) {
          throw new Error('compactRegion: no open turn — automatic compaction events must be enclosed in a turn');
        }
        try {
          engine.sessionState.update(session.id, (state) => state);
        } catch (cause) {
          const error = new Error(`compaction state unavailable before replacement: ${cause?.message ?? cause}`);
          error.code = 'STATE_UNAVAILABLE';
          error.cause = cause;
          throw error;
        }
        if (options.continuation && (!policy.archiveEnabled || !engine.historyToolsAvailable)) {
          throw Object.assign(new Error('同会话接续需要可用的完整历史归档和三个历史查询工具；原上下文保留。'), {
            code: 'CONTINUATION_HISTORY_UNAVAILABLE',
          });
        }

        const reusedOutcome = await tryRegionSessionMemoryReuse(engine, {
          start,
          end,
          agent,
          signal,
          options,
          session,
          policy,
          budgetSpec,
          entryState,
          strictHost,
          useAtomicCommit,
        });
        if (reusedOutcome.reused) return reusedOutcome.result;

        engine.sessionMemory?.cancel?.(session.id);
        const planResult = await planRegionForCommit(engine, { start, end, agent, signal, options, session, policy });
        const { planned, options: commitOptions, preservePrefixCache, capacity, reselect } = planResult;
        const replaceGenerationBefore = session.surface?.replaceGeneration ?? 0;
        try {
          return await engine._compactSpan(
            planned.start,
            planned.end,
            agent,
            signal,
            {
              ...commitOptions,
              budgetSpec,
              preservePrefixCache,
              capacity,
              strictHost,
              useAtomicCommit,
              reselect: commitOptions.continuation ? undefined : reselect,
              turn: manual ? null : (entryState.openTurn ?? null),
            },
            0,
          );
        } catch (error) {
          if (commitOptions.continuationPending) {
            releaseUnstartedContinuation(engine.sessionState, session, commitOptions.continuationPending.id);
          }
          if (
            typeof session.restoreCompactionSurface === 'function' ||
            (session.surface?.replaceGeneration ?? 0) > replaceGenerationBefore
          ) {
            try {
              const recovery = await engine.recoverPending(
                session,
                true,
                isAbortError(error, signal) ? 'cancelled' : 'failed',
              );
              if (recovery.restored > 0 && error && typeof error === 'object') error.surfaceRestored = true;
            } catch (recoveryError) {
              engine._addBounded(engine._recoveryBlocked, engine._keyOf(session));
              const blocked = new AggregateError(
                [error, recoveryError],
                'compaction failed and restoration must finish before another model request',
              );
              blocked.code = 'RECOVERY_REQUIRED';
              blocked.compactionStage = 'commit';
              blocked.cause = error;
              throw blocked;
            }
          }
          throw error;
        }
      });
    } finally {
      activeTransactions.delete(transactionKey);
    }
  });
}

async function prepareContinuationForSpan(
  engine,
  { session, agent, shadowedSeqs, shadowedTokenCount, shadowedCanonicalBytes, policy, options, compactionId, auditTrigger, manual, signal },
) {
  engine._trackUpdate(session, {
    phase: 'continuing',
    retryReasonCode: null,
    ...engine._computeCompressionProgress(session, shadowedSeqs, 0),
  });
  const { summarized, preserved, checkpointBlocks, reinject } = await prepareContinuation({
    ctx: engine.ctx,
    agent,
    session,
    seqs: shadowedSeqs,
    policy,
    capacity: options.capacity,
    budgetSpec: engine._getBudgetSpec(session, options.budgetSpec),
    chain: engine._resolveSummaryTargets(policy, agent),
    compactionId,
    signal,
    archiveRoot: engine.archive.root,
    checkpointBudgetTokens: options.continuationBudgetTokens,
    estimateCheckpointTokens: (blocks) => engine._estimateCheckpointTokens(blocks),
    shadowedTokenCount,
    shadowedCanonicalBytes,
    manualRetry: options.manualRetry ?? manual,
    requestId: options.sourceCommandId ?? compactionId,
    trigger: auditTrigger,
    allowForeignFallback: options.allowForeignFallback === true,
    parallelContinuation: options.parallelContinuation === true,
    reasoningEffortPolicy: policy.summaryReasoningEffort,
    ...(options.focusInstruction ? { focusInstruction: options.focusInstruction } : {}),
    ...(options.additionalContext ? { additionalContext: options.additionalContext } : {}),
    ...(options.softenCoverageForFocus === true ? { softenCoverageForFocus: true } : {}),
    onSoftAuditWarning: (msg) => engine.log('warn', msg),
    onConcurrencyChange: (st) => {
      engine._trackUpdate(session, {
        concurrency: st.effectiveConcurrency,
        activeWorkers: st.activeWorkers,
        rateLimited: st.rateLimited,
      });
    },
    onProgress: (telemetry) => {
      const pageTotal = Math.max(1, Number.isSafeInteger(telemetry.pageTotal) && telemetry.pageTotal > 0 ? telemetry.pageTotal : 1);
      const completedPages = Math.max(0, (Number.isSafeInteger(telemetry.pageIndex) && telemetry.pageIndex > 0 ? telemetry.pageIndex : 1) - 1);
      const inPageStream = Math.min(0.85, ((telemetry.textChars ?? 0) + (telemetry.reasoningChars ?? 0) * 0.25) / 3000);
      const subFraction = Math.min(0.95, (completedPages + inPageStream) / pageTotal);
      const nextAuditFallbackCount =
        Number.isSafeInteger(telemetry.auditFallbackCount) && telemetry.auditFallbackCount > 0
          ? (engine.progressTracker?.snapshot?.(session?.id)?.auditFallbackCount ?? 0) + telemetry.auditFallbackCount
          : null;
      engine._trackUpdate(session, {
        phase: 'continuing',
        ...(Number.isSafeInteger(options.waveIndex) ? { waveIndex: options.waveIndex } : {}),
        pageIndex: telemetry.pageIndex,
        pageTotal: telemetry.pageTotal,
        ...(telemetry.attempt !== undefined ? { attempt: telemetry.attempt } : {}),
        ...(telemetry.maxAttempts !== undefined ? { maxAttempts: telemetry.maxAttempts } : {}),
        ...(Object.prototype.hasOwnProperty.call(telemetry, 'retryReasonCode') ? { retryReasonCode: telemetry.retryReasonCode } : {}),
        ...(nextAuditFallbackCount !== null ? { auditFallbackCount: nextAuditFallbackCount } : {}),
        ...(typeof telemetry.rateLimited === 'boolean' ? { rateLimited: telemetry.rateLimited } : {}),
        ...(Number.isSafeInteger(telemetry.concurrency) ? { concurrency: telemetry.concurrency } : {}),
        ...(Number.isSafeInteger(telemetry.activeWorkers) ? { activeWorkers: telemetry.activeWorkers } : {}),
        ...(telemetry.model ? { summaryModel: telemetry.model } : {}),
        ...engine._computeCompressionProgress(session, shadowedSeqs, subFraction),
      });
      if (telemetry.chunks !== undefined || telemetry.textChars !== undefined || telemetry.reasoningChars !== undefined) {
        engine._trackStream(session, {
          chunks: telemetry.chunks,
          textChars: telemetry.textChars,
          reasoningChars: telemetry.reasoningChars,
          firstChunkMs: telemetry.firstChunkMs,
          idleMs: telemetry.idleMs,
        });
      }
    },
    onProgressIdentity: (key) => bindContinuationProgress(
      engine.sessionState,
      session,
      options.continuationPending.id,
      key,
      {
        manualRetry: options.manualRetry ?? manual,
        requestId: options.sourceCommandId ?? compactionId,
        allowPolicyRestart: options.allowPolicyRestart === true,
      },
    ),
  });
  Object.assign(summarized.continuation, {
    pendingId: options.continuationPending.id,
    pendingSourceSha256: options.continuationPending.sourceSha256,
  });
  engine._emitAuxUsage(session, summarized?.usage);
  if (reinject) engine._emitReinjectMeasured(session, reinject);
  const tokens = engine._estimateCheckpointTokens(checkpointBlocks);
  if (tokens >= shadowedTokenCount || canonicalMessageBytes([{ role: 'user', content: checkpointBlocks }]) >= shadowedCanonicalBytes) {
    throw Object.assign(new Error('Continuation would not reduce the current context; original history retained.'), {
      code: 'CONTINUATION_NOT_SMALLER',
    });
  }
  if (options.continuationBudgetTokens && tokens >= options.continuationBudgetTokens) {
    throw Object.assign(new Error('Continuation requirements exceed the available main-request budget.'), {
      code: 'CONTINUATION_TOO_LARGE',
    });
  }
  return { summarized, preserved, checkpointBlocks };
}

function createSpanSummaryValidator(
  engine,
  {
    session,
    policy,
    compactionId,
    shadowedSeqs,
    shadowedTokenCount,
    shadowedCanonicalBytes,
    preserved,
    expectedUserMessages,
    referenceMessages,
    memorySelection,
    progressSelection,
    options,
    preSummarySurfaceNodes,
    preSummaryReplaceGen,
    buildSpanCheckpoint,
  },
) {
  return (result) => {
    engine._trackUpdate(session, {
      phase: 'auditing',
      ...engine._computeCompressionProgress(session, shadowedSeqs, 0.90),
    });
    const language = result?.language ?? (policy.language === 'zh' ? 'zh' : 'en');
    const structure = validateSummaryStructure(result?.rawText ?? '', { language });
    if (!structure.ok) return structure;
    result.modelRawOutput ??= result.summary;
    const retired = retiredMemoryPresent(result.rawText, memorySelection);
    if (retired) {
      return { ok: false, code: 'RETIRED_MEMORY_REINTRODUCED', message: `Remove the ${retired.reason} request from seq ${retired.seq}; it is no longer active.` };
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
        const built = engine._buildProvenanceError(provSummary, 'Generated instructions or permissions have no matching user source.');
        return { ok: false, ...built.meta, message: built.message, audit: { lost: provenance } };
      }
      engine.log('warn', `soft provenance warning allowed by auditProvenanceBlock: false (kind=${provSummary.provenanceKind})`);
    }
    if (policy.auditEnabled) {
      const audit = engine._audit(session, shadowedSeqs, result.rawText, compactionId, blocks, policy);
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
        const built = engine._buildProvenanceError(split.provenanceSummary, 'Generated instructions or permissions have no matching user source.');
        return { ok: false, audit, ...built.meta, message: built.message };
      }
      const hardConflicts = split.conflictOther ?? split.other.filter((item) => item?.reason !== 'coverage');
      const coverageOnly = split.coverageOther ?? split.other.filter((item) => item?.reason === 'coverage');
      const enforcedOther = [...hardConflicts, ...(policy.auditBlockOnLoss ? coverageOnly : [])];
      if (enforcedOther.length > 0) {
        if (options.softenCoverageForFocus === true && hardConflicts.length === 0) {
          engine.log(
            'warn',
            `focus-mode constraint audit ${compactionId}: softened ${coverageOnly.length}/${audit.checked} non-polarity coverage gap(s) ` +
              `(worst coverage ${audit.worstCoverage}) during explicit manual /compact <focus>`,
          );
        } else {
          const firstConflict = hardConflicts[0] ?? coverageOnly[0];
          return { ok: false, audit, code: 'CONSTRAINT_LOST', message: `summary failed source constraint audit (seq=${firstConflict.seq}, reason=${firstConflict.reason})` };
        }
      }
    }
    result._validated = { rawText: result.rawText, blocks, reinjectInfo, surfaceNodes: preSummarySurfaceNodes, replaceGeneration: preSummaryReplaceGen };
    return listed;
  };
}

function prepareSpanAttemptContext(
  engine,
  { session, agent, shadowedSeqs, shadowedTokenCount, shadowedCanonicalBytes, policy, options, attempt, compactionId, auditTrigger, stripImagesForSummary, systemSeq0 },
) {
  const preSummarySurfaceNodes = [...(session.surface?.nodes ?? [])];
  const preSummaryReplaceGen = session.surface?.replaceGeneration ?? 0;
  const input = buildSummarizationInput(session, shadowedSeqs, {
    preservePrefixCache: Boolean(options.preservePrefixCache && attempt === 0),
    stripImagesForSummary,
    policy,
  });
  const progressSelection = input.progress;
  const previousSummary = shadowedSeqs.some(
    (seq) => session.deriveEventMessage(session.eventAt(seq))?.source?.kind === 'compact-checkpoint',
  )
    ? 'inline checkpoint'
    : null;
  const chain = engine._resolveSummaryTargets(policy, agent);
  const memorySelection = selectSessionMemory(session, shadowedSeqs, {
    maxMessages: policy.preserveRecentMessages,
    maxTokens: policy.preserveRecentUserTokens,
    approxTokens,
  });
  const expectedUserMessages = [...memorySelection.active, ...memorySelection.retained];
  const referenceMessages = collectReferenceMessages(session, session.surface.nodes);
  const preserved = memorySelection.preserved;
  if (memorySelection.decisions.some((d) => d.reason === 'oldest-quote-evicted') && !policy.archiveEnabled) {
    throw Object.assign(new Error('Memory selection requires a verified source archive.'), {
      code: 'MEMORY_ARCHIVE_REQUIRED',
    });
  }
  input.messages.push({ role: 'user', content: [{ type: 'text', text: memoryPolicyInstruction(memorySelection) }] });

  const archivedFiles = collectArchivedFiles(session, shadowedSeqs);
  const childArchiveIds = policy.archiveEnabled && engine.historyToolsAvailable ? collectChildArchiveIds(session, shadowedSeqs) : [];
  const spanBudgetSpec = engine._getBudgetSpec(session, options.budgetSpec);
  const spanIoCache = { livenessBySummary: new Map(), reinjectByLimits: new Map() };
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
      workReport: input.workReport,
      progress: input.progress,
      shadowedTokenCount,
      shadowedCanonicalBytes,
      archivedFiles,
      childArchiveIds,
      budgetSpec: spanBudgetSpec,
      spanIoCache,
      onReinjectMeasured: checkpointOpts?.onReinjectMeasured ?? null,
      suppressTelemetry: checkpointOpts?.suppressTelemetry === true,
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
    softenCoverageForFocus: options.softenCoverageForFocus === true,
    preSummarySurfaceNodes,
    preSummaryReplaceGen,
    buildSpanCheckpoint,
  });

  const summaryPhase = options.progressPhase ?? 'summarizing';
  const primaryTarget = chain?.targets?.[0];
  const primaryModelLabel = primaryTarget?.provider && primaryTarget?.model ? `${primaryTarget.provider}/${primaryTarget.model}` : null;
  engine._trackUpdate(session, {
    phase: summaryPhase,
    summaryModel: primaryModelLabel,
    attempt: 1,
    maxAttempts: (Number.isSafeInteger(policy.summaryRetryCount) && policy.summaryRetryCount >= 0 ? policy.summaryRetryCount : 0) + 1,
    retryReasonCode: null,
    stream: { chunks: 0, textChars: 0, reasoningChars: 0, firstChunkMs: null, idleMs: 0 },
    ...engine._computeCompressionProgress(session, shadowedSeqs, 0.05),
  });

  const candidateSeqs = (
    Array.isArray(input.verbatimSeqs) && input.verbatimSeqs.length > 0 ? input.verbatimSeqs : shadowedSeqs
  ).filter((seq) => seq !== systemSeq0);
  const beforeImageCount = measureVisibleImages(session, candidateSeqs).visibleImageCount;
  const validate = createSpanSummaryValidator(engine, {
    session,
    policy,
    compactionId,
    shadowedSeqs,
    shadowedTokenCount,
    shadowedCanonicalBytes,
    preserved,
    expectedUserMessages,
    referenceMessages,
    memorySelection,
    progressSelection,
    options,
    preSummarySurfaceNodes,
    preSummaryReplaceGen,
    buildSpanCheckpoint,
  });

  return {
    input,
    progressSelection,
    previousSummary,
    chain,
    memorySelection,
    expectedUserMessages,
    preserved,
    buildSpanCheckpoint,
    onExhaustionFallback,
    summaryPhase,
    candidateSeqs,
    beforeImageCount,
    validate,
    auditTrigger,
  };
}

async function resolveSpanSummaryWithRetry(
  engine,
  { session, agent, shadowedSeqs, shadowedTokenCount, shadowedCanonicalBytes, policy, options, attempt, compactionId, auditTrigger, signal },
) {
  const preSummaryNodesSnapshot = session.surface?.nodes ?? [];
  const systemSeq0 =
    preSummaryNodesSnapshot.length > 0 && Boolean(systemHead(session, preSummaryNodesSnapshot[0]))
      ? preSummaryNodesSnapshot[0]
      : null;
  const MAX_IMAGE_OFFLOAD_RETRIES = 2;
  let imageOffloadRetries = 0;
  let stripImagesForSummary = options.stripImagesForSummary === true;
  let strippedRetryUsed = false;

  for (;;) {
    const ctxData = prepareSpanAttemptContext(engine, {
      session,
      agent,
      shadowedSeqs,
      shadowedTokenCount,
      shadowedCanonicalBytes,
      policy,
      options,
      attempt,
      compactionId,
      auditTrigger,
      stripImagesForSummary,
      systemSeq0,
    });
    const {
      input,
      progressSelection,
      previousSummary,
      chain,
      memorySelection,
      expectedUserMessages,
      preserved,
      buildSpanCheckpoint,
      onExhaustionFallback,
      summaryPhase,
      candidateSeqs,
      beforeImageCount,
      validate,
    } = ctxData;

    try {
      const summarized = await summarizeWithChain({
        ctx: engine.ctx,
        agent,
        input,
        chain,
        options: {
          maxTokens: options.maxTokens ?? policy.maxTokens,
          singleTarget: true,
          ...(stripImagesForSummary ? { stripImagesForSummary: true } : {}),
          timeoutMs: policy.summaryTimeoutMs,
          retryCount: policy.summaryRetryCount,
          retryDelayMs: policy.summaryRetryDelayMs,
          language: policy.language,
          previousSummary,
          capacity: options.capacity,
          reasoningEffortPolicy: policy.summaryReasoningEffort,
          ...(options.targetChars !== undefined ? { targetChars: options.targetChars } : {}),
          ...(options.focusInstruction ? { focusInstruction: options.focusInstruction } : {}),
          ...(options.additionalContext ? { additionalContext: options.additionalContext } : {}),
          onAttemptError: (attemptErr) => {
            const retryReasonCode = normalizeRetryReasonCode(attemptErr);
            if (retryReasonCode) {
              engine._trackUpdate(session, {
                retryReasonCode,
                ...(retryReasonCode === 'RATE_LIMITED' ? { rateLimited: true } : {}),
              });
            }
          },
          onProgress: (telemetry) => {
            const subFraction = Math.min(
              0.85,
              0.05 + 0.80 * Math.min(1, ((telemetry.textChars ?? 0) + (telemetry.reasoningChars ?? 0) * 0.25) / 3000),
            );
            engine._trackUpdate(session, {
              phase: summaryPhase,
              ...(telemetry.model ? { summaryModel: telemetry.model } : {}),
              attempt: telemetry.attempt,
              maxAttempts: telemetry.maxAttempts,
              ...engine._computeCompressionProgress(session, shadowedSeqs, subFraction),
            });
            engine._trackStream(session, {
              chunks: telemetry.chunks,
              textChars: telemetry.textChars,
              reasoningChars: telemetry.reasoningChars,
              firstChunkMs: telemetry.firstChunkMs,
              idleMs: telemetry.idleMs,
            });
          },
          userMessages: preserved,
          reconstruct: ({ result, verdict, modelRawText }) => {
            if (verdict.code === 'PROGRESS_FACT_CONFLICT') return null;
            const rebuilt = reconstructDisputedLines({ text: modelRawText, userMessages: expectedUserMessages, audit: verdict.audit, language: result.language });
            if (!rebuilt) return null;
            const receipts = [...(result.reconstruction ?? []), ...rebuilt.receipts];
            if (new Set(receipts.flatMap((r) => r.removedLineSha256)).size > 16) return null;
            return { ...result, rawText: rebuilt.text, summary: [{ type: 'text', text: rebuilt.text }], reconstruction: receipts };
          },
          onRejected: ({ result, verdict, modelRawText, attempt: rejAttempt }) => dumpAuditRejection({
            storageRoot: dirname(engine.archive.root),
            sessionId: session?.id,
            compactionId,
            trigger: auditTrigger,
            target: `${result?.provider ?? '?'}/${result?.model ?? '?'}`,
            code: verdict.code,
            message: verdict.message,
            attempt: rejAttempt,
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
      engine._emitAuxUsage(session, summarized?.usage);
      return { summarized, preserved, memorySelection, progressSelection, buildSpanCheckpoint };
    } catch (summaryErr) {
      if (signal?.aborted || isAbortError(summaryErr, signal) || isBiliProxyPreflightError(summaryErr)) {
        throw summaryErr;
      }
      if (isImageOffloadRequiredError(summaryErr)) {
        if (!stripImagesForSummary && imageOffloadRetries < MAX_IMAGE_OFFLOAD_RETRIES && candidateSeqs.length > 0) {
          const rawErr = extractRawImageOffloadError(summaryErr);
          let accepted = await engine._dispatchSummaryError(session, candidateSeqs, rawErr, signal);
          let afterImageCount = measureVisibleImages(session, candidateSeqs).visibleImageCount;
          const requestedOffloadCount = rawErr?.failure?.offloadImages ?? rawErr?.offloadImages;
          if (accepted !== true && rawErr?.name !== 'LlmError' && Number.isSafeInteger(requestedOffloadCount) && requestedOffloadCount > 0) {
            const directTargets = selectOldestImageTargets(session, candidateSeqs, requestedOffloadCount);
            if (directTargets.length > 0) {
              try {
                session.append('image/offload', { targets: directTargets });
                accepted = true;
                afterImageCount = measureVisibleImages(session, candidateSeqs).visibleImageCount;
              } catch {}
            }
          }
          if (accepted === true && afterImageCount < beforeImageCount) {
            imageOffloadRetries += 1;
            engine._invalidateSessionMemory(session.id);
            engine._lastTotal.delete(session);
            engine.log('info', `summary hit IMAGE_OFFLOAD_REQUIRED (${beforeImageCount} -> ${afterImageCount} visible images); retrying in place (${imageOffloadRetries}/${MAX_IMAGE_OFFLOAD_RETRIES})`);
            continue;
          }
        }
        if (!stripImagesForSummary && !strippedRetryUsed) {
          stripImagesForSummary = true;
          strippedRetryUsed = true;
          engine.log('warn', `summary falling back to in-memory image placeholder stripping after IMAGE_OFFLOAD_REQUIRED (retries=${imageOffloadRetries})`);
          continue;
        }
      } else if (isUpstreamMultimodal400Error(summaryErr) && !stripImagesForSummary && !strippedRetryUsed) {
        stripImagesForSummary = true;
        strippedRetryUsed = true;
        engine.log('warn', 'summary hit upstream multimodal 400; retrying with in-memory image placeholder stripping');
        continue;
      }
      throw summaryErr;
    }
  }
}

async function auditUnreusedSpan(
  engine,
  { session, shadowedSeqs, policy, compactionId, auditTrigger, options, summarized, checkpointBlocks },
) {
  const softenCoverageForFocus = options.softenCoverageForFocus === true;
  const report = engine._audit(session, shadowedSeqs, summarized.rawText, compactionId, checkpointBlocks, policy);
  const split = engine._splitAuditLost(report.lost, policy);
  const hardConflicts = split.conflictOther ?? split.other.filter((item) => item?.reason !== 'coverage');
  const coverageOnly = split.coverageOther ?? split.other.filter((item) => item?.reason === 'coverage');
  const fallbackAccepted = summarized?.auditFallback?.used === true && policy?.auditExhaustionPolicy !== 'block';
  const fallbackCheck = fallbackAccepted
    ? classifyBlockingAuditLost(report.lost, {
        auditBlockOnLoss: policy.auditBlockOnLoss,
        auditProvenanceBlock: policy.auditProvenanceBlock,
        softenCoverageForFocus,
      })
    : null;
  const bypassHeuristicAudit = Boolean(
    fallbackCheck &&
    split.polarity.length === 0 &&
    (fallbackCheck.polarity?.length ?? 0) === 0 &&
    fallbackCheck.hardProvenance.length === 0 &&
    (fallbackCheck.conflictOther?.length ?? 0) === 0 &&
    fallbackCheck.blockingLost.length <= MAX_AUDIT_FALLBACK_CONFLICTS,
  );
  const shouldBlockOther =
    !bypassHeuristicAudit &&
    (hardConflicts.length > 0 || (policy.auditBlockOnLoss && !softenCoverageForFocus && coverageOnly.length > 0));
  const dumpCode = split.polarity.length > 0 ? 'CONSTRAINT_POLARITY_LOST' : 'CONSTRAINT_LOST';
  const dumpMessage = split.polarity.length > 0
    ? 'summary reverses a user constraint'
    : split.provenanceBlocked
      ? 'summary failed provenance audit'
      : 'summary failed source constraint audit';
  if (!bypassHeuristicAudit && (split.polarity.length > 0 || split.provenanceBlocked || shouldBlockOther)) {
    try {
      await dumpAuditRejection({
        storageRoot: dirname(engine.archive.root),
        sessionId: session?.id,
        compactionId,
        trigger: auditTrigger,
        target: `${summarized?.provider ?? '?'}/${summarized?.model ?? '?'}`,
        code: dumpCode,
        message: dumpMessage,
        modelRawText: blocksToText(summarized.modelRawOutput ?? summarized.summary ?? []),
        auditedText: summarized.rawText,
        checkpointBlocks,
        report,
        userMessages: collectInstructionMessages(session, shadowedSeqs, { approxTokens }),
        coverageThreshold: policy.auditCoverageThreshold,
        softCoverageCount: report.softCoverageCount ?? 0,
        auditFallbackSkippedReason: summarized?.auditFallback?.skippedReason ?? null,
      });
    } catch {}
  }
  if (split.polarity.length > 0 && !bypassHeuristicAudit) {
    const firstFlip = split.polarity[0];
    const seq = firstFlip?.seq;
    const sourceKind = sourceKindOf(session, seq) ?? 'user';
    const error = new Error(
      `compaction: the summary reverses ${report.polarityFlips} user constraint(s) ` +
        `(seq=${seq ?? 'unknown'}, source=${sourceKind}; first: "${redactCredentials(firstFlip?.line)?.slice(0, 120) ?? ''}"); ` +
        'refusing to replace the original messages with a summary that says the opposite',
    );
    error.code = 'CONSTRAINT_POLARITY_LOST';
    error.constraintSeq = seq ?? null;
    error.constraintSourceKind = sourceKind;
    throw error;
  }
  if (split.provenanceBlocked && (!bypassHeuristicAudit || split.provenanceSummary?.hardProvenance?.length > 0)) {
    const built = engine._buildProvenanceError(
      split.provenanceSummary,
      'Generated permissions or instructions lack a current user source; original context retained.',
    );
    throw Object.assign(new Error(redactCredentials(built.message)), built.meta);
  }
  if (split.provenanceSummary && !split.provenanceBlocked) {
    engine.log('warn', `soft provenance warning allowed by auditProvenanceBlock: false (kind=${split.provenanceSummary.provenanceKind})`);
  }
  if (shouldBlockOther) {
    if (hardConflicts.length > 0) {
      const error = new Error(
        `compaction: ${hardConflicts.length}/${report.checked} user constraint line(s) conflict with the checkpoint ` +
          `(reason=${hardConflicts[0].reason}; first: "${redactCredentials(hardConflicts[0].line).slice(0, 120)}"); ` +
          'refusing to replace the original messages rather than silently contradicting a constraint.',
      );
      error.code = 'CONSTRAINT_LOST';
      throw error;
    }
    const error = new Error(
      `compaction: ${coverageOnly.length}/${report.checked} user constraint line(s) are missing from the checkpoint ` +
        `(worst coverage ${report.worstCoverage}; first: "${redactCredentials(coverageOnly[0].line).slice(0, 120)}"); ` +
        'refusing to replace the original messages rather than silently dropping a constraint. ' +
        'Set auditBlockOnLoss: false to accept this tradeoff.',
    );
    error.code = 'CONSTRAINT_LOST';
    throw error;
  }
  if (!bypassHeuristicAudit && policy.auditBlockOnLoss && softenCoverageForFocus && coverageOnly.length > 0) {
    engine.log(
      'warn',
      `focus-mode constraint audit ${compactionId}: softened ${coverageOnly.length}/${report.checked} non-polarity coverage gap(s) ` +
        `(worst coverage ${report.worstCoverage}) during explicit manual /compact <focus>`,
    );
  }
}

async function validateUnreusedSpanSummary(
  engine,
  { session, shadowedSeqs, shadowedTokenCount, shadowedCanonicalBytes, shadowedTokenPrecision, policy, compactionId, auditTrigger, options, summarized, preserved, buildSpanCheckpoint },
) {
  const surfaceNodesNow = session.surface?.nodes ?? [];
  const validated = summarized?._validated;
  const validatedReuse = Boolean(
    validated &&
    validated.rawText === summarized.rawText &&
    (session.surface?.replaceGeneration ?? 0) === validated.replaceGeneration &&
    Array.isArray(validated.surfaceNodes) &&
    validated.surfaceNodes.length === surfaceNodesNow.length &&
    validated.surfaceNodes.every((seq, idx) => seq === surfaceNodesNow[idx]),
  );
  if (validatedReuse) {
    if (validated.reinjectInfo) {
      engine._emitReinjectMeasured(session, validated.reinjectInfo);
    }
    return { validatedReuse: true, checkpointBlocks: validated.blocks };
  }

  const checkpointBlocks = buildSpanCheckpoint(summarized.summary, summarized.rawText, summarized?.pinnedRulesBlock ?? '');
  const structure = validateSummaryStructure(summarized.rawText, {
    language: summarized.language ?? (policy.language === 'zh' ? 'zh' : 'en'),
  });
  if (!structure.ok) throw Object.assign(new Error(structure.message), { code: structure.code });

  const userSection = validateUserMessageSection(structure.userSectionBody, preserved);
  if (!userSection.ok) throw Object.assign(new Error(userSection.message), { code: userSection.code });

  const coverage = validateCheckpointCoverage(checkpointBlocks, preserved, { expected: preserved });
  if (!coverage.ok) throw Object.assign(new Error(coverage.message), { code: coverage.code });

  const checkpointTokens = engine._estimateCheckpointTokens(checkpointBlocks);
  if (checkpointTokens >= shadowedTokenCount) {
    throw Object.assign(
      new Error(`summary is not smaller than the shadowed content (${checkpointTokens} estimated checkpoint tokens >= ${shadowedTokenCount}, measurement precision: ${shadowedTokenPrecision})`),
      { code: 'SUMMARY_NOT_SMALLER' },
    );
  }
  const checkpointCanonicalBytes = canonicalMessageBytes([{ role: 'user', content: checkpointBlocks }]);
  if (checkpointCanonicalBytes >= shadowedCanonicalBytes) {
    throw Object.assign(
      new Error(`checkpoint UTF-8 message bytes did not shrink (${checkpointCanonicalBytes} >= ${shadowedCanonicalBytes})`),
      { code: 'SUMMARY_NOT_SMALLER' },
    );
  }
  if (policy.auditEnabled) {
    await auditUnreusedSpan(engine, { session, shadowedSeqs, policy, compactionId, auditTrigger, options, summarized, checkpointBlocks });
  }
  return { validatedReuse: false, checkpointBlocks };
}

async function validateFinalUnreusedGuards(
  engine,
  { session, shadowedSeqs, policy, compactionId, auditTrigger, summarized, checkpointBlocks },
) {
  const finalSelection = selectSessionMemory(session, shadowedSeqs, { approxTokens });
  const finalRetired = retiredMemoryPresent(summarized.rawText, finalSelection);
  if (finalRetired) {
    throw Object.assign(new Error('Generated notes revive a retired request; original context retained.'), {
      code: 'RETIRED_MEMORY_REINTRODUCED',
    });
  }
  const finalProvenance = auditInstructionProvenance({
    userMessages: finalSelection?.provenanceUserMessages ?? [...finalSelection.active, ...finalSelection.retained],
    retiredDecisions: finalSelection?.provenanceRetiredDecisions ?? finalSelection?.decisions,
    summaryText: summarized.rawText,
    referenceMessages: collectReferenceMessages(session, session.surface.nodes),
  });
  if (finalProvenance.length) {
    const provSummary = summarizeProvenanceFailures(finalProvenance);
    const allowSoftFallbackProvenance = provSummary.hardProvenance.length === 0 && summarized?.auditFallback?.used === true && policy?.auditExhaustionPolicy !== 'block';
    if (provSummary.hardProvenance.length > 0 || (policy.auditProvenanceBlock !== false && !allowSoftFallbackProvenance)) {
      const built = engine._buildProvenanceError(provSummary, 'Generated permissions or instructions lack a current user source; original context retained.');
      try {
        await dumpAuditRejection({
          storageRoot: dirname(engine.archive.root),
          sessionId: session?.id,
          compactionId,
          trigger: auditTrigger,
          target: `${summarized?.provider ?? '?'}/${summarized?.model ?? '?'}`,
          code: 'CONSTRAINT_LOST',
          message: built.message,
          modelRawText: blocksToText(summarized.modelRawOutput ?? summarized.summary ?? []),
          auditedText: summarized.rawText,
          checkpointBlocks,
          report: { lost: finalProvenance },
          userMessages: [...finalSelection.active, ...finalSelection.retained],
          coverageThreshold: policy.auditCoverageThreshold,
          softCoverageCount: 0,
          auditFallbackSkippedReason: summarized?.auditFallback?.skippedReason ?? null,
        });
      } catch {}
      throw Object.assign(new Error(redactCredentials(built.message)), built.meta);
    }
    engine.log('warn', `final soft provenance warning allowed by auditProvenanceBlock: false (kind=${provSummary.provenanceKind})`);
  }
  const finalProgress = validateProgressFacts(summarized.rawText, collectProgressFacts(session, shadowedSeqs));
  if (!finalProgress.ok) throw Object.assign(new Error(finalProgress.message), { code: finalProgress.code });
}

async function archiveUnarchivedSpan(
  engine,
  { session, shadowedSeqs, compactionId, policy, options, precomputed, memorySelection, signal },
) {
  const foreignFallback = options.allowForeignFallback === true;
  const archiveEntries = policy.archiveEnabled
    ? (precomputed?.archiveEntries ??
        spanEntries(session, shadowedSeqs, foreignFallback ? { allowForeignFallback: true } : undefined))
    : [];
  let archivePath = null;
  if (policy.archiveEnabled) {
    archivePath = await engine.archive.writeSpan({
      sessionId: session.id,
      compactionId,
      entries: archiveEntries,
      signal,
      ...(foreignFallback ? { allowForeignFallback: true } : {}),
    });
    if (!archivePath) {
      const error = new Error(
        'compaction: archiving the shadowed span failed; refusing to replace it on the surface',
      );
      error.code = 'ARCHIVE_FAILED';
      throw error;
    }
  }
  if (
    options.continuation ||
    (policy.archiveEnabled && (memorySelection?.decisions.length || precomputed?.fromSessionMemory === true))
  ) {
    try {
      const verified = await engine.archive.readSpan(session.id, compactionId);
      if (!verified.ok || verified.entries.length !== archiveEntries.length || verified.entries.some((entry, i) => entry.seq !== archiveEntries[i].seq)) {
        throw Object.assign(new Error('Source archive verification failed; original context retained.'), {
          code: 'CONTINUATION_ARCHIVE_INVALID',
        });
      }
    } catch (err) {
      if (archivePath) await cleanupUncommittedArchive(engine, session, compactionId);
      throw err;
    }
  }
  return archivePath;
}

/** Synchronous public-surface triple append (`compaction/summary` -> replace `user/message` -> `compaction/end`) with ZERO `await` yields. */
function commitPublicSurfaceSync(
  engine,
  session,
  { start, end, startEvent, shadowedSeqs, summaryPayload, checkpointMessage, lifecycle, summarized, preserved, archivePath, checkpointBlocks, tx },
) {
  const summaryEvent = engine._appendSync(session, 'compaction/summary', summaryPayload);
  const replacement = engine._appendSync(session, 'user/message', checkpointMessage, {
    surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
    sourceEventSeqs: [startEvent?.seq, summaryEvent?.seq, ...shadowedSeqs].filter((seq) => typeof seq === 'number'),
  });
  tx.replaced = true;
  tx.closing = true;
  let endEvent;
  try {
    endEvent = engine._appendSync(session, 'compaction/end', lifecycle);
    tx.closed = true;
  } catch (endError) {
    engine.log('warn', `compaction/end failed after the surface was replaced: ${redactErrorText(endError?.message ?? endError)}; retrying once to close the lock`);
    endEvent = engine._appendSync(session, 'compaction/end', {
      ...lifecycle,
      error: redactErrorText(`compaction/end failed once and was retried: ${endError?.message ?? String(endError)}`),
    });
    tx.closed = true;
  }
  tx.committed = { summarized, preserved, archivePath, summaryEvent, replacement, endEvent, checkpointBlocks };
}

async function commitSpanTransaction(
  engine,
  {
    session,
    start,
    end,
    startIdx,
    endIdx,
    startEvent,
    shadowedSeqs,
    shadowedSpanSnapshot,
    policy,
    options,
    compactionId,
    sourceCommandId,
    lifecycle,
    precomputed,
    summarized,
    preserved,
    checkpointBlocks,
    memorySelection,
    progressSelection,
    archivePath,
    signal,
    tx,
  },
) {
  tx.stage = 'commit';
  engine._trackUpdate(session, {
    phase: 'committing',
    stream: null,
    ...engine._computeCompressionProgress(session, shadowedSeqs, 0.96, { committing: true }),
  });

  const sourceMemory = precomputed?.sourceMemory ?? (memorySelection ? {
    progressFacts: progressSourceRefs(progressSelection),
    summaryScope: progressSelection?.scope,
    workReport: workReportRef(collectWorkReport(session, shadowedSeqs)),
    memoryRequirements: preservedForSource(memoryRequirements(memorySelection.active)) ?? [],
    memorySources: memorySourceRefs(memorySelection.active, session),
    memoryDecisions: memoryDecisionsForSource(memorySelection.decisions, session),
  } : summarized.sourceMemory ?? {});
  const extraMeta = options.checkpointMeta && typeof options.checkpointMeta === 'object' ? options.checkpointMeta : {};
  const auditFallbackMeta = summarized?.auditFallback?.used === true ? { auditFallback: summarized.auditFallback } : {};
  const checkpointMessage = {
    id: newMessageId(),
    role: 'user',
    content: checkpointBlocks,
    source: options.continuation
      ? Object.freeze({ ...sourceMemory, ...compactCheckpointSource(compactionId, sourceCommandId, preservedForSource(preserved)), preserved: preservedForSource(preserved) ?? [], continuation: summarized.continuation, ...auditFallbackMeta, ...extraMeta })
      : Object.freeze({ ...compactCheckpointSource(compactionId, sourceCommandId, preservedForSource(preserved)), preserved: preservedForSource(preserved) ?? [], ...sourceMemory, ...auditFallbackMeta, ...extraMeta }),
  };

  const eventShadowedTokenCount = estimateHostHeuristicSpan(session, shadowedSeqs);
  const summaryPayload = {
    compactionId,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    summary: summarized.summary,
    rawOutput: summarized.modelRawOutput ?? summarized.summary,
    ...(summarized.reconstruction ? { reconstruction: summarized.reconstruction } : {}),
    ...(summarized.continuation ? { continuation: summarized.continuation } : {}),
    ...(summarized.fromSessionMemory ? {} : { llmStreamCall: true }),
    ...auditFallbackMeta,
    shadowedRange: { start, end },
    shadowedSeqs,
    shadowedTokenCount: eventShadowedTokenCount,
    provider: summarized.provider,
    model: summarized.model,
    maxTokens: summarized.maxTokens,
    ...(summarized.usage === null || summarized.usage === undefined ? {} : { usage: summarized.usage }),
  };

  if (typeof engine.ctx.sessions?.flush === 'function') {
    try {
      await engine._flushSession(session);
    } catch (error) {
      const error2 = new Error(`compaction persistence failed before the surface was replaced: ${error?.message ?? error}`);
      error2.code = 'commit';
      error2.compactionStage = 'commit';
      error2.cause = error;
      throw error2;
    }
  }

  await engine._journalRecord(session, compactionId, 'committing', start, end);

  if (options.continuationPending) assertPendingSource(session, options.continuationPending);
  const nodesBeforeCommit = session.surface?.nodes ?? [];
  const sliceBeforeCommit = nodesBeforeCommit.slice(startIdx, endIdx + 1);
  if (
    sliceBeforeCommit.length !== shadowedSpanSnapshot.length ||
    sliceBeforeCommit.some((seq, i) => seq !== shadowedSpanSnapshot[i])
  ) {
    throw Object.assign(new Error('compaction: the selected span changed while the summary was being generated'), {
      code: 'SPAN_CHANGED',
    });
  }

  if (signal?.aborted) {
    const cancelled = new Error('manual compaction was cancelled before the surface was replaced');
    cancelled.code = 'cancelled';
    cancelled.cause = signal.reason;
    throw cancelled;
  }
  signal?.throwIfAborted?.();

  const strictHost = Boolean(options.strictHost ?? (options.policy ?? engine.config)?.strictHostFingerprints) || Boolean(engine.requireTransactionAdapter);
  const useAtomicCommit = options.useAtomicCommit ?? (typeof session.restoreCompactionSurface !== 'function' && Boolean(engine.transactionAdapter));
  const commitProbe = useAtomicCommit && engine.transactionAdapter && typeof session.restoreCompactionSurface !== 'function'
    ? engine.transactionAdapter.probeSupport(session)
    : { ok: false };
  if (!commitProbe.ok && typeof session.restoreCompactionSurface !== 'function') {
    if (strictHost) {
      const fallbackError = new Error('Stock-host transaction adapter is unavailable; compression is refused before changing history.');
      fallbackError.code = 'RECOVERY_REQUIRED';
      throw commitProbe.error ?? fallbackError;
    }
    if (useAtomicCommit) {
      await engine._assertNoUnrecoveredAtomicJournal(session);
      engine._warnHostFallbackOnce(commitProbe.reason ?? 'stock transaction adapter unavailable');
    }
  }
  if (commitProbe.ok) {
    const staged = engine.transactionAdapter.stage(session, (shadow) => {
      const summaryEvent = engine._appendSync(shadow, 'compaction/summary', summaryPayload);
      const replacement = engine._appendSync(shadow, 'user/message', checkpointMessage, {
        surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
        sourceEventSeqs: [startEvent?.seq, summaryEvent?.seq, ...shadowedSeqs].filter((seq) => typeof seq === 'number'),
      });
      const endEvent = engine._appendSync(shadow, 'compaction/end', lifecycle);
      return { summaryEvent, replacement, endEvent };
    });
    const record = (await engine.journal.pending(session.id)).find((r) => r.compactionId === compactionId);
    if (!record || record.corrupt || record.phase !== 'committing') throw new Error('durable preparation journal is missing');
    const { summaryEvent, replacement, endEvent } = await engine.transactionAdapter.commit(engine, session, record, staged, signal);
    tx.stockCommitted = true;
    tx.replaced = true;
    tx.closing = true;
    tx.closed = true;
    tx.committed = { summarized, preserved, archivePath, summaryEvent, replacement, endEvent, checkpointBlocks };
    return;
  }
  commitPublicSurfaceSync(engine, session, {
    start,
    end,
    startEvent,
    shadowedSeqs,
    summaryPayload,
    checkpointMessage,
    lifecycle,
    summarized,
    preserved,
    archivePath,
    checkpointBlocks,
    tx,
  });
}

async function handleSpanCommitFailure(
  engine,
  { failure, start, end, agent, session, shadowedSeqs, compactionId, options, attempt, tx, signal },
) {
  if (failure.error?.code === 'RECOVERY_REQUIRED') {
    engine._addBounded(engine._recoveryBlocked, engine._keyOf(session));
    throw failure.error;
  }
  const error = failure.error;
  const failedStage = failure.stage;
  const errorText = `${error?.code ? `${error.code}: ` : ''}${error?.message ?? String(error)}`;

  const canReselect =
    !tx.replaced &&
    tx.closed &&
    tx.flushFailure === undefined &&
    attempt < engine.config.reactiveStep &&
    !signal?.aborted &&
    !engine._stopped.has(engine._keyOf(session)) &&
    engine._isRecoverable(error) &&
    typeof options.reselect === 'function';
  if (!canReselect && !options.suppressFailureRecord && !isAbortError(error, signal)) {
    engine._recordFailure(agent, session, error);
  }
  if (!tx.replaced && !tx.stockCommitted && tx.archivePath) {
    await cleanupUncommittedArchive(engine, session, compactionId);
  }
  if (!tx.replaced && tx.closed && tx.flushFailure === undefined) {
    await engine.journal.clear(session.id, compactionId);
  }

  if (canReselect) {
    const nodesSnap = session.surface?.nodes ?? [];
    const sysSeq0 = nodesSnap.length > 0 && systemHead(session, nodesSnap[0]) ? nodesSnap[0] : null;
    const notifySeqs = sysSeq0 === null ? shadowedSeqs : shadowedSeqs.filter((s) => s !== sysSeq0);
    await engine._dispatchSummaryError(session, notifySeqs, extractRawImageOffloadError(error), signal);

    const next = await options.reselect(attempt + 1, { start, end });
    if (next) {
      engine.log(
        'warn',
        `summary failed (${errorText.slice(0, 160)}); retrying with a smaller span ${next.start}-${next.end} (attempt ${attempt + 2})`,
      );
      return engine._compactSpan(next.start, next.end, agent, signal, options, attempt + 1);
    }
    if (!options.suppressFailureRecord && !isAbortError(error, signal)) {
      engine._recordFailure(agent, session, error);
    }
  }

  if (error && typeof error === 'object' && error.compactionStage === undefined) {
    error.compactionStage = failedStage;
  }
  throw error;
}

async function finalizeCommittedSpan(
  engine,
  { start, end, startEvent, agent, session, shadowedSeqs, shadowedTokenCount, shadowedTokenPrecision, compactionId, sourceCommandId, options, tx, signal },
) {
  if (tx.flushFailure !== undefined) {
    if (isAbortError(tx.flushFailure, signal) || signal?.aborted === true) {
      const cancelled = new Error(`compaction was cancelled during persistence: ${tx.flushFailure?.message ?? tx.flushFailure}`);
      cancelled.code = 'cancelled';
      cancelled.cause = signal?.aborted ? signal.reason : tx.flushFailure;
      throw cancelled;
    }
    const flushError = new Error(`compaction persistence failed: ${tx.flushFailure?.message ?? tx.flushFailure}`);
    flushError.code = 'persistence';
    flushError.cause = tx.flushFailure;
    engine._recordFailure(agent, session, flushError);
    throw flushError;
  }
  if (tx.committed === null) {
    throw new Error('compaction committed without a result');
  }
  const { summarized, preserved, archivePath, summaryEvent, replacement, endEvent, checkpointBlocks } = tx.committed;

  if (!tx.stockCommitted) {
    await engine._journalRecord(session, compactionId, 'committed', start, end);
    try {
      engine.sessionState.update(session.id, (state) => clearBreakerState(state));
    } catch (cause) {
      const error = new Error(`compaction replaced history but could not save policy state: ${cause?.message ?? cause}`);
      error.code = 'commit';
      error.compactionStage = 'commit';
      error.cause = cause;
      throw error;
    }
  }

  if (engine.journal && typeof engine.journal.clear === 'function') {
    await engine.journal.clear(session.id, compactionId);
  }
  if (options.continuation) settleContinuation(engine.sessionState, session);

  engine._failures.delete(engine._keyOf(session));
  engine._stopped.delete(engine._keyOf(session));
  if (options?.checkpointMeta?.contextCollapse === true) {
    engine._invalidateSessionMemory(session.id);
  } else {
    engine._resetSessionMemoryCycle(session.id);
  }

  if (!tx.stockCommitted && options.manual && signal?.aborted) {
    const cancelled = new Error('manual compaction was cancelled');
    cancelled.code = 'cancelled';
    cancelled.cause = signal.reason;
    throw cancelled;
  }
  const after = await engine._measure(session);
  noteDiagnosticMeasurement(after, { stage: 'after' });
  if (after) {
    engine._lastTotal.set(session, after.totalTokens);
    engine._trackUpdate(session, {
      currentTokens: after.totalTokens,
      stream: null,
      retryReasonCode: null,
      ...engine._computeCompressionProgress(session, [], 0),
    });
  } else {
    engine._trackUpdate(session, { stream: null, retryReasonCode: null });
  }

  const result = {
    compactionId,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    startSeq: startEvent?.seq ?? start,
    summarySeq: summaryEvent?.seq ?? replacement?.seq ?? start,
    ...(typeof replacement?.seq === 'number' ? { replacementSeq: replacement.seq } : {}),
    endSeq: endEvent?.seq ?? end,
    summary: checkpointBlocks,
    shadowedRange: { start, end },
    shadowedSeqs,
    shadowedTokenCount,
    checkpointTokens: engine._estimateCheckpointTokens(checkpointBlocks),
    shadowedTokenPrecision,
    provider: summarized.provider,
    model: summarized.model,
    ...(summarized.continuation ? { continuation: summarized.continuation } : {}),
    ...(summarized.sessionMemoryMode ? { sessionMemoryReused: summarized.sessionMemoryMode } : {}),
    ...(summarized?.auditFallback?.used === true ? { auditFallback: summarized.auditFallback } : {}),
    preservedUserMessages: preserved.length,
    archivePath,
  };

  if (engine.config.debug) {
    engine.log('info', `compacted ${shadowedSeqs.length} seq(s) via ${summarized.provider}/${summarized.model}`);
  }
  return result;
}

/**
 * Compact a validated span inside a `compaction/start` .. `compaction/end` transaction,
 * supporting precomputed bundles, bounded continuation, fresh LLM summaries, atomic/sync commits,
 * and reactive span shrinking on recoverable failure.
 * @param {object} engine
 * @param {number} start
 * @param {number} end
 * @param {object} agent
 * @param {AbortSignal|undefined} signal
 * @param {object} options
 * @param {number} attempt
 */
async function executeSpanTransactionBody(
  engine,
  {
    session,
    agent,
    start,
    end,
    startIdx,
    endIdx,
    startEvent,
    shadowedSeqs,
    shadowedSpanSnapshot,
    shadowedTokenCount,
    shadowedCanonicalBytes,
    shadowedTokenPrecision,
    compactionId,
    sourceCommandId,
    auditTrigger,
    lifecycle,
    precomputed,
    options,
    attempt,
    signal,
    tx,
  },
) {
  await engine._journalRecord(session, compactionId, 'started', start, end);
  const policy = options.policy ?? engine.config;
  let summarized, preserved, checkpointBlocks, memorySelection, progressSelection;
  let validatedReuse = false;
  let archivePath = null;
  if (precomputed) {
    summarized = precomputed.summarized;
    preserved = precomputed.preserved;
    checkpointBlocks = precomputed.checkpointBlocks;
    memorySelection = precomputed.memorySelection;
    progressSelection = precomputed.progressSelection;
    archivePath = precomputed.archivePath ?? null;
    validatedReuse = true;
    engine._emitAuxUsage(session, summarized?.usage);
    if (precomputed.reinjectMeasurement) {
      engine._emitReinjectMeasured(session, precomputed.reinjectMeasurement);
    }
  } else if (options.continuation) {
    ({ summarized, preserved, checkpointBlocks } = await prepareContinuationForSpan(engine, {
      session,
      agent,
      shadowedSeqs,
      shadowedTokenCount,
      shadowedCanonicalBytes,
      policy,
      options,
      compactionId,
      auditTrigger,
      manual: options.manual,
      signal,
    }));
  } else {
    let buildSpanCheckpoint;
    ({ summarized, preserved, memorySelection, progressSelection, buildSpanCheckpoint } =
      await resolveSpanSummaryWithRetry(engine, {
        session,
        agent,
        shadowedSeqs,
        shadowedTokenCount,
        shadowedCanonicalBytes,
        policy,
        options,
        attempt,
        compactionId,
        auditTrigger,
        signal,
      }));
    ({ validatedReuse, checkpointBlocks } = await validateUnreusedSpanSummary(engine, {
      session,
      shadowedSeqs,
      shadowedTokenCount,
      shadowedCanonicalBytes,
      shadowedTokenPrecision,
      policy,
      compactionId,
      auditTrigger,
      options,
      summarized,
      preserved,
      buildSpanCheckpoint,
    }));
  }

  if (!validatedReuse) {
    await validateFinalUnreusedGuards(engine, {
      session,
      shadowedSeqs,
      policy,
      compactionId,
      auditTrigger,
      summarized,
      checkpointBlocks,
    });
  }
  if (!precomputed || precomputed.archivePending) {
    archivePath = await archiveUnarchivedSpan(engine, {
      session,
      shadowedSeqs,
      compactionId,
      policy,
      options,
      precomputed,
      memorySelection,
      signal,
    });
    tx.archivePath = archivePath;
  }
  await commitSpanTransaction(engine, {
    session,
    start,
    end,
    startIdx,
    endIdx,
    startEvent,
    shadowedSeqs,
    shadowedSpanSnapshot,
    policy,
    options,
    compactionId,
    sourceCommandId,
    lifecycle,
    precomputed,
    summarized,
    preserved,
    checkpointBlocks,
    memorySelection,
    progressSelection,
    archivePath,
    signal,
    tx,
  });
}

/**
 * Compact a validated span inside a `compaction/start` .. `compaction/end` transaction,
 * supporting precomputed bundles, bounded continuation, fresh LLM summaries, atomic/sync commits,
 * and reactive span shrinking on recoverable failure.
 * @param {object} engine
 * @param {number} start
 * @param {number} end
 * @param {object} agent
 * @param {AbortSignal|undefined} signal
 * @param {object} options
 * @param {number} attempt
 */
export async function compactSpan(engine, start, end, agent, signal, options, attempt) {
  const { manual, sourceCommandId } = options;
  const auditTrigger = options.trigger ?? (options.progressPhase === 'folding' ? 'fold' : options.continuation ? 'continuation' : options.idle ? 'idle' : manual ? 'manual' : 'auto');
  const session = agent.session;
  const precomputed = options.precomputed ?? null;
  const compactionId = precomputed?.compactionId ?? nextCompactionId();
  const nodes = session.surface?.nodes ?? [];
  const startIdx = nodes.indexOf(start);
  const endIdx = nodes.indexOf(end);
  const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
  const shadowedSpanSnapshot = [...shadowedSeqs];
  if (
    precomputed &&
    (shadowedSeqs.length !== precomputed.shadowedSeqs.length ||
      shadowedSeqs.some((seq, i) => seq !== precomputed.shadowedSeqs[i]))
  ) {
    if (precomputed.archivePath) {
      await cleanupUncommittedArchive(engine, session, compactionId);
    }
    throw Object.assign(
      new Error('compaction: the selected span changed while the concurrent summary was being generated'),
      { code: 'SPAN_CHANGED' },
    );
  }

  const shadowedTokenCount = precomputed?.shadowedTokenCount ?? engine._shadowedTokens(session, shadowedSeqs);
  const shadowedCanonicalBytes = canonicalMessageBytes(shadowedSeqs.map((seq) => session.deriveEventMessage(session.eventAt(seq))).filter(Boolean));
  const shadowedTokenPrecision = precomputed?.shadowedTokenPrecision ?? engine._lastPrecision?.get(session) ?? 'unknown';

  const lifecycle = {
    compactionId,
    ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    turn: options.turn ?? null,
  };
  let startEvent;
  try {
    startEvent = await engine._append(session, 'compaction/start', lifecycle);
  } catch (err) {
    if (precomputed?.archivePath) {
      await cleanupUncommittedArchive(engine, session, compactionId);
    }
    throw err;
  }

  const tx = {
    stage: 'summary',
    closing: false,
    closed: false,
    replaced: false,
    failure: undefined,
    flushFailure: undefined,
    committed: null,
    stockCommitted: false,
    archivePath: precomputed?.archivePath ?? null,
  };
  try {
    await executeSpanTransactionBody(engine, {
      session,
      agent,
      start,
      end,
      startIdx,
      endIdx,
      startEvent,
      shadowedSeqs,
      shadowedSpanSnapshot,
      shadowedTokenCount,
      shadowedCanonicalBytes,
      shadowedTokenPrecision,
      compactionId,
      sourceCommandId,
      auditTrigger,
      lifecycle,
      precomputed,
      options,
      attempt,
      signal,
      tx,
    });
  } catch (error) {
    tx.failure = { error, stage: tx.closing ? 'commit' : tx.stage };
    if (!tx.closing) {
      tx.closing = true;
      const closeText = redactErrorText(`${error?.code ? `${error.code}: ` : ''}${error?.message ?? String(error)}`);
      try {
        await engine._append(session, 'compaction/end', { ...lifecycle, error: closeText });
        tx.closed = true;
      } catch (closeError) {
        tx.failure = { error: closeError, stage: 'commit' };
      }
    }
  }

  if (!tx.stockCommitted && tx.closed && typeof engine.ctx.sessions?.flush === 'function') {
    try {
      await engine._flushSession(session);
    } catch (error) {
      tx.flushFailure = error;
    }
  }

  if (tx.failure !== undefined) {
    return handleSpanCommitFailure(engine, {
      failure: tx.failure,
      start,
      end,
      agent,
      session,
      shadowedSeqs,
      compactionId,
      options,
      attempt,
      tx,
      signal,
    });
  }

  return finalizeCommittedSpan(engine, {
    start,
    end,
    startEvent,
    agent,
    session,
    shadowedSeqs,
    shadowedTokenCount,
    shadowedTokenPrecision,
    compactionId,
    sourceCommandId,
    options,
    tx,
    signal,
  });
}
