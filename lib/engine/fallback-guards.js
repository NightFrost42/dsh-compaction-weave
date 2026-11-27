// Emergency guards, idle resume tiers, session-memory validation, constraint audit,
// and automatic pressure/overflow compaction loop extracted from WeaveCompactionEngine.
// Every exported function takes `engine` as its first argument and NEVER imports `../engine.js`.

import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG } from '../config.js';
import { redactCredentials } from '../redact.js';
import { clearResumableCompaction, readResumableCompaction } from '../state.js';
import {
  buildSummarizationInput,
  collectArchivedFiles,
  collectChildArchiveIds,
  inspectCompactionEntryState,
  selectCompactableRange,
  selectSessionMemory,
  systemHead,
  validateSurfaceRegion,
} from '../region.js';
import { spanEntries } from '../history.js';
import { planObservationMask, commitObservationMask } from '../observation-mask.js';
import { planMicrocompact, commitMicrocompact } from '../microcompact.js';
import { planSnip, commitSnip } from '../snip.js';
import { selectContextCollapseSpan, shouldSkipFullIdleSummaryAfterCollapse } from '../context-collapse.js';
import { selectCachePreservingRange } from '../cache-policy.js';
import { idleResumeDue } from '../idle-compaction.js';
import {
  continuationEligible,
  hasContinuation,
  planContinuationMemory,
  residentConstraints,
  selectContinuationRange,
} from '../continuation.js';
import { clearPendingContinuation, readPendingContinuation } from '../continuation-pending.js';
import {
  collectProgressFacts,
  isExternalScriptCheckpoint,
  progressSourceRefs,
  validateProgressFacts,
} from '../progress-facts.js';
import { collectWorkReport, scopeWorkReport, workReportRef } from '../work-report.js';
import {
  deduplicateNotes,
  memoryDecisionsForSource,
  memoryRequirements,
  memorySourceRefs,
  retiredMemoryPresent,
} from '../memory-policy.js';
import { preservedForSource } from '../region.js';
import { isExternalFoldEvent } from '../foreign-fold.js';
import { noteDiagnosticMeasurement } from '../failure-diagnostics.js';
import { withReferencePolicy } from '../source-provenance.js';
import { traceStagePoint } from '../stage-trace.js';
import { approxTokens } from '../meter.js';
import {
  materializeUserMessageSection,
  validateCheckpointCoverage,
  validateSummaryStructure,
  validateUserMessageSection,
} from '../validate.js';
import { auditInstructionProvenance, summarizeProvenanceFailures } from '../audit.js';
import { auditMemorySelection, collectReferenceMessages } from '../constraint-scope.js';
import {
  MAX_AUDIT_FALLBACK_CONFLICTS,
  buildAuditFallbackPayloadDetailed,
  classifyBlockingAuditLost,
  diagnoseHeuristicFallbackVerdict,
} from '../audit-fallback.js';
import {
  COMPACT_CHECKPOINT_KIND,
  canonicalMessageBytes,
  combineBatchResults,
  estimateBulkChunkCount,
  isAbortError,
  nextCompactionId,
  resolveBulkFoldThreshold,
} from './shared.js';

/**
 * Last-resort zero-LLM emergency Snip rescue invoked ONLY at the hard budget
 * wall, pressure-wall failure (>= 95% budget), or context-overflow (413).
 * @param {object} engine
 * @param {object} agent
 * @param {object} spec
 * @param {AbortSignal|undefined} signal
 * @param {string} [reason='budget-wall']
 */
export async function emergencySnip(engine, agent, spec, signal, reason = 'budget-wall') {
  if (engine._disposed) return null;
  const session = agent?.session;
  if (!session || engine._busy.has(session) || signal?.aborted) return null;
  const policy = spec?.policy ?? engine._resolvePolicy(agent);
  if (
    (policy.snipEnabled ?? DEFAULT_CONFIG.snipEnabled) === false ||
    !policy.archiveEnabled ||
    !engine.historyToolsAvailable
  ) {
    return null;
  }
  if (engine._recoveryBlocked.has(engine._keyOf(session))) return null;
  const entryState = inspectCompactionEntryState(session);
  if (entryState.openTurn === null) return null;
  if (
    entryState.unmatchedCompactionStart !== null &&
    (entryState.latestEndSeedSeq === null || entryState.unmatchedCompactionStart > entryState.latestEndSeedSeq)
  ) {
    return null;
  }
  if (readPendingContinuation(engine.sessionState, session)) return null;

  const snipSig = `${entryState.openTurn}:${session.surface?.replaceGeneration ?? 0}:${session.surface?.nodes?.length ?? 0}`;
  if (engine._snipAttemptedAt.get(session) === snipSig) return null;
  engine._snipAttemptedAt.set(session, snipSig);

  const measurement = await engine._measure(session);
  if (!measurement || signal?.aborted) return null;
  if (!spec || !Number.isFinite(spec.messageBudgetTokens) || spec.messageBudgetTokens <= 1) return null;

  const budgetTarget = Math.max(1, spec.messageBudgetTokens);
  let targetTokens = budgetTarget;
  if (measurement.totalTokens < budgetTarget) {
    if (reason === 'pressure-wall') {
      targetTokens = Math.min(
        budgetTarget,
        Number.isFinite(spec.thresholdTokens) && spec.thresholdTokens > 0
          ? Math.min(spec.thresholdTokens, Math.max(1, measurement.totalTokens - 1))
          : Math.max(1, Math.floor(measurement.totalTokens * 0.8)),
      );
    } else if (reason === 'context-overflow') {
      targetTokens = Math.min(budgetTarget, Math.max(1, Math.floor(measurement.totalTokens * 0.8)));
    }
  }

  const plan = withReferencePolicy(policy, () =>
    planSnip(session, measurement, {
      targetTokens,
      keepRecentTurns: policy.snipKeepRecentTurns,
      keepRecentTokens: policy.snipKeepRecentTokens,
      minSavingsTokens: policy.snipMinSavingsTokens,
      maxSpansPerRescue: policy.snipMaxSpansPerRescue,
      allowAdaptiveMaxSpans: true,
      compactionIdPrefix: 'weave-snip',
    }),
  );
  if (!plan || !Array.isArray(plan.spans) || plan.spans.length === 0) return null;

  const projected = Number.isFinite(plan.projectedRemainingTokens)
    ? plan.projectedRemainingTokens
    : Math.max(0, measurement.totalTokens - (plan.totalTokensSaved ?? 0));
  if (measurement.totalTokens >= spec.messageBudgetTokens) {
    if (projected >= spec.messageBudgetTokens) {
      engine.log(
        'warn',
        `emergency snip (${reason}) aborted before write: planned pruning (${plan.totalTokensSaved ?? 0} tok) leaves ${projected} tok >= budget ${spec.messageBudgetTokens}`,
      );
      return null;
    }
  } else if (!((plan.totalTokensSaved ?? 0) > 0 && projected < measurement.totalTokens && projected < spec.messageBudgetTokens)) {
    engine.log(
      'warn',
      `emergency snip (${reason}) aborted before write: insufficient projected savings (${measurement.totalTokens} -> ${projected} tok)`,
    );
    return null;
  }

  const flushSession = typeof engine.ctx.sessions?.flush === 'function'
    ? (targetSession) => engine._flushSession(targetSession)
    : null;

  engine.sessionMemory?.cancel?.(session.id);
  engine._busy.add(session);
  let committed = null;
  try {
    committed = await commitSnip({
      session,
      plan,
      archive: engine.archive,
      log: (lvl, msg) => engine.log(lvl, msg),
      flushSession,
      signal,
    });
  } catch (error) {
    if (isAbortError(error, signal) || error?.surfaceMutated) throw error;
    engine.log('warn', `emergency snip (${reason}) aborted before surface mutation: ${error?.message ?? error}`);
    return null;
  } finally {
    engine._busy.delete(session);
  }
  if (!committed) return null;

  engine._invalidateSessionMemory(session.id);
  traceStagePoint('emergencySnip', {
    count: committed.shadowedSeqs.length,
    total: committed.shadowedTokenCount,
    reason,
  });
  engine.log(
    'warn',
    `emergency snip (${reason}) pruned ${committed.snippedSpans.length} span(s) ` +
      `(${committed.shadowedSeqs.length} node(s), ~${committed.shadowedTokenCount} tok) with 0 LLM calls; archives preserved`,
  );
  return committed;
}

/**
 * Run Tier-2 idle expired-TTL context collapse without warming prefix cache or failing on unshrinkable spans.
 * @param {object} engine
 * @param {object} agent
 * @param {object} plan
 * @param {object} policy
 * @param {AbortSignal|undefined} signal
 * @param {number|null} [beforeTokens=null]
 */
export async function runContextCollapse(engine, agent, plan, policy, signal, beforeTokens = null) {
  const session = agent?.session;
  if (!session || !plan || !Array.isArray(plan.seqs) || plan.seqs.length === 0) return null;
  if (engine._busy.has(session)) return null;
  signal?.throwIfAborted?.();
  const collapsePolicy = { ...policy, cachePreservePrefix: false };
  const preHook = await engine._runPreCompactHook({
    session,
    trigger: 'idle',
    manual: false,
    focusInstruction: '',
    totalTokens: beforeTokens,
    range: { start: plan.startSeq, end: plan.endSeq },
    continuation: false,
    signal,
  });
  if (preHook.cancelled) return null;
  const effectiveFocus = preHook.effectiveFocus;
  const additionalContext = preHook.additionalContext;
  const prevLastTotal = engine._lastTotal.get(session);
  engine._busy.add(session);
  engine._agentBySession.set(session, agent);
  let collapseResult = null;
  try {
    collapseResult = await engine._withProgressScope(
      session,
      plan.seqs,
      { beforeTokens: beforeTokens ?? plan.totalTokens ?? 0 },
      (progressScope) =>
        engine._trackRun(
          session,
          {
            trigger: 'idle',
            phase: 'planning',
            beforeTokens: beforeTokens ?? plan.totalTokens ?? null,
            currentTokens: beforeTokens ?? plan.totalTokens ?? null,
            overallPercent: 10,
            overallProcessedNodes: 0,
            overallTotalNodes: progressScope.totalNodes,
            overallProcessedTokens: 0,
            overallTotalTokens: progressScope.totalTokens,
          },
          (runId) =>
            engine._runWithCancel(session, runId, signal, async (runSignal) => {
              try {
                return await engine._compactRegionCore(plan.startSeq, plan.endSeq, agent, runSignal, {
                  manual: false,
                  policy: collapsePolicy,
                  maxTokens: collapsePolicy.maxTokens,
                  idle: true,
                  trigger: 'idle',
                  skipUnshrinkable: true,
                  checkpointMeta: { contextCollapse: true },
                  ...(effectiveFocus ? { focusInstruction: effectiveFocus } : {}),
                  ...(additionalContext ? { additionalContext } : {}),
                  softenCoverageForFocus: false,
                });
              } catch (err) {
                if (err?.code === 'SUMMARY_NOT_SMALLER' && err?.localCapacityRejection) {
                  engine.log('info', 'idle context collapse span is not locally shrinkable; skipping Tier 2 collapse');
                  if (session?.id) engine.progressTracker?.clear?.(session.id);
                  return null;
                }
                throw err;
              }
            }),
        ),
    );
  } finally {
    engine._busy.delete(session);
  }
  if (collapseResult != null) {
    if ((policy.idleFullSummaryEnabled ?? DEFAULT_CONFIG.idleFullSummaryEnabled) === false) {
      const afterCollapse = await engine._measure(session).catch(() => null);
      const spec = afterCollapse ? await engine._resolveSpec(agent, afterCollapse, signal).catch(() => null) : null;
      if (afterCollapse && spec && afterCollapse.totalTokens >= spec.thresholdTokens) {
        if (prevLastTotal === undefined) engine._lastTotal.delete(session);
        else engine._lastTotal.set(session, prevLastTotal);
      }
    }
    await engine._runPostCompactHook({
      session,
      trigger: 'idle',
      manual: false,
      focusInstruction: '',
      result: collapseResult,
      signal,
    });
  }
  return collapseResult;
}

async function runIdleMicrocompactPasses(engine, agent, session, policy, interval, signal) {
  if (
    (policy.microcompactEnabled ?? DEFAULT_CONFIG.microcompactEnabled) === false ||
    !policy.archiveEnabled ||
    !engine.historyToolsAvailable ||
    inspectCompactionEntryState(session).openTurn === null
  ) {
    return { beforeMeasure: null, afterMicro: null, microResult: null };
  }
  const beforeMeasure = await engine._measure(session);
  const flushSession = typeof engine.ctx.sessions?.flush === 'function'
    ? (targetSession) => engine._flushSession(targetSession)
    : null;
  const microIds = [];
  let totalMaskedCount = 0;
  let totalRepeatedReads = 0;
  let totalMaskedTools = 0;
  let totalMicroSaved = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    signal?.throwIfAborted?.();
    const passMeasure = pass === 0 ? beforeMeasure : await engine._measure(session);
    const microPlan = planMicrocompact(session, passMeasure, {
      compactionId: nextCompactionId(),
      keepRecentTools: policy.microcompactKeepRecentTools,
      thresholdChars: policy.microcompactThresholdChars,
      headChars: policy.microcompactHeadChars,
      tailChars: policy.microcompactTailChars,
      repeatedReadMinChars: policy.microcompactRepeatedReadMinChars,
    });
    if (!microPlan) break;
    let committed;
    try {
      committed = await commitMicrocompact({
        session,
        plan: microPlan,
        archive: engine.archive,
        log: (lvl, msg) => engine.log(lvl, msg),
        flushSession,
        signal,
      });
    } catch (microError) {
      if (!isAbortError(microError, signal)) engine._recordFailure(agent, session, microError);
      throw microError;
    }
    if (!committed) break;
    microIds.push(committed.compactionId);
    totalMaskedCount += microPlan.targets.length;
    totalRepeatedReads += committed.repeatedReadCount ?? microPlan.repeatedReadCount ?? 0;
    totalMaskedTools += committed.maskedToolCount ?? microPlan.maskedToolCount ?? 0;
    totalMicroSaved += committed.shadowedTokenCount ?? microPlan.totalTokensSaved ?? 0;
    if (!microPlan.hasMore) break;
  }
  if (microIds.length === 0) {
    return { beforeMeasure, afterMicro: null, microResult: null };
  }
  engine._invalidateSessionMemory(session.id);
  const microResult = {
    compactionId: microIds[0],
    compactionIds: microIds,
    maskedCount: totalMaskedCount,
    repeatedReadCount: totalRepeatedReads,
    maskedToolCount: totalMaskedTools,
    shadowedTokenCount: totalMicroSaved,
  };
  const afterMicro = await engine._measure(session);
  engine.log(
    'info',
    `idle microcompact after ${Math.floor(interval.elapsedMs / 60000)} minute(s): ` +
      `folded ${totalMaskedCount} tool output(s) (${totalRepeatedReads} repeated read(s), ${totalMaskedTools} oversized), ` +
      `saved ~${totalMicroSaved} tok (0 LLM calls)`,
  );
  return { beforeMeasure, afterMicro, microResult };
}

/**
 * Tiered idle-resume pipeline: Tier 1 Microcompact -> Tier 2 Context Collapse -> Tier 3 Full Idle Summary.
 * @param {object} engine
 * @param {object} agent
 * @param {AbortSignal|undefined} extSignal
 * @param {Array} messages
 */
export async function compactBeforeResume(engine, agent, extSignal, messages) {
  return engine._runWithActiveSignal(extSignal, async (signal) => {
    const interval = idleResumeDue(agent.session, messages, engine.config.idleCompactionMinutes);
    if (!interval) return null;
    signal?.throwIfAborted?.();
    engine._restoreState(agent.session);
    if (engine._stopped.has(engine._keyOf(agent.session))) {
      engine.log('warn', 'idle compaction skipped because circuit breaker is active for this session');
      return null;
    }

    const policy = engine._resolvePolicy(agent);
    const session = agent.session;
    engine.sessionMemory?.cancel?.(session.id);

    let { beforeMeasure, afterMicro, microResult } = await runIdleMicrocompactPasses(
      engine,
      agent,
      session,
      policy,
      interval,
      signal,
    );

    if (microResult && microResult.maskedCount > 0) {
      const microSpec = afterMicro ? await engine._resolveSpec(agent, afterMicro, signal).catch(() => null) : null;
      if (
        shouldSkipFullIdleSummaryAfterCollapse({
          beforeTokens: beforeMeasure?.totalTokens,
          beforeMicroTokens: beforeMeasure?.totalTokens,
          afterTokens: afterMicro?.totalTokens,
          policy: { ...policy, idleFullSummaryEnabled: true },
          microResult,
          collapseResult: null,
          thresholdTokens: microSpec?.thresholdTokens,
        })
      ) {
        engine.log('info', 'idle microcompact reduced context cleanly; skipping full idle summary');
        return { status: 'microcompacted', result: microResult };
      }
    }

    let collapseResult = null;
    let afterCollapse = afterMicro ?? beforeMeasure;
    if (policy.contextCollapseEnabled === true) {
      signal?.throwIfAborted?.();
      if (!beforeMeasure) {
        beforeMeasure = await engine._measure(session);
        afterCollapse = beforeMeasure;
      }
      const preCollapseMeasure = afterMicro ?? beforeMeasure;
      const beforeCollapseTokens = preCollapseMeasure?.totalTokens ?? null;
      const collapsePlan = selectContextCollapseSpan(
        session,
        session.surface?.nodes ?? [],
        policy,
        preCollapseMeasure ? { measurement: preCollapseMeasure } : undefined,
      );
      if (collapsePlan && collapsePlan.seqs.length > 0) {
        const collapsed = await engine.diagnostics.run(
          session,
          { trigger: 'idle', signal, reportContext: engine._diagnosticContext(agent) },
          () => engine._runContextCollapse(agent, collapsePlan, policy, signal, beforeCollapseTokens),
        );
        signal?.throwIfAborted?.();
        if (collapsed) {
          collapseResult = collapsed;
          afterCollapse = await engine._measure(session);
          engine.log(
            'info',
            `idle context collapse after ${Math.floor(interval.elapsedMs / 60000)} minute(s): ` +
              `collapsed ${collapsePlan.seqs.length} node(s) (${collapsePlan.startSeq}..${collapsePlan.endSeq}), ` +
              `protected ${collapsePlan.protectedTailSeqs.length} tail node(s)`,
          );
        }
      }
    }

    if ((policy.idleFullSummaryEnabled ?? DEFAULT_CONFIG.idleFullSummaryEnabled) === false) {
      if (collapseResult) return { status: 'collapsed', result: collapseResult, ...(microResult ? { microResult } : {}) };
      return microResult ? { status: 'microcompacted', result: microResult } : { status: 'skipped', result: null };
    }
    if (microResult || collapseResult) {
      const postTier2Measure = afterCollapse ?? (await engine._measure(session));
      const spec = postTier2Measure ? await engine._resolveSpec(agent, postTier2Measure, signal).catch(() => null) : null;
      const skipTier3 = shouldSkipFullIdleSummaryAfterCollapse({
        beforeTokens: (afterMicro ?? beforeMeasure)?.totalTokens ?? beforeMeasure?.totalTokens,
        beforeMicroTokens: beforeMeasure?.totalTokens,
        afterTokens: postTier2Measure?.totalTokens,
        policy,
        microResult,
        collapseResult,
        thresholdTokens: spec?.thresholdTokens,
      });
      if (skipTier3) {
        if (collapseResult) {
          engine.log('info', 'idle context collapse reduced context cleanly; skipping full idle summary');
          return { status: 'collapsed', result: collapseResult, ...(microResult ? { microResult } : {}) };
        }
        engine.log('info', 'idle microcompact reduced context cleanly; skipping full idle summary');
        return { status: 'microcompacted', result: microResult };
      }
    }

    const result = await engine.diagnostics.run(
      session,
      { trigger: 'idle', signal, reportContext: engine._diagnosticContext(agent) },
      () => engine._compactManual(agent, signal, undefined, false, true, { idle: true }),
    );
    signal?.throwIfAborted?.();
    engine.log('info', `idle resume after ${Math.floor(interval.elapsedMs / 60000)} minute(s): ${result ? 'compaction committed' : 'no shrinkable history'}`);
    if (!result && collapseResult) {
      return { status: 'collapsed', result: collapseResult, ...(microResult ? { microResult } : {}) };
    }
    if (!result && microResult) {
      return { status: 'microcompacted', result: microResult };
    }
    return {
      status: result ? 'compacted' : 'skipped',
      result,
      ...(collapseResult ? { collapseResult } : {}),
      ...(microResult ? { microResult } : {}),
    };
  });
}

/**
 * Check whether an idle continuation checkpoint can shrink the selected span.
 * @param {object} engine
 * @param {object} session
 * @param {{start:number,end:number}} range
 * @param {object} policy
 */
export function idleContinuationCanShrink(engine, session, range, policy) {
  const nodes = session.surface.nodes;
  const seqs = nodes.slice(nodes.indexOf(range.start), nodes.indexOf(range.end) + 1);
  const selection = selectSessionMemory(session, seqs, {
    maxMessages: policy.preserveRecentMessages,
    maxTokens: policy.preserveRecentUserTokens,
    approxTokens,
  });
  const progress = collectProgressFacts(session, seqs);
  const workReport = scopeWorkReport(collectWorkReport(session, seqs), progress);
  const preserved = residentConstraints(selection.active, session);
  let base;
  try {
    ({ base } = planContinuationMemory(preserved, policy, { workReport, progress }));
  } catch (error) {
    if (error.code === 'CONTINUATION_REQUIREMENTS_TOO_LARGE') return false;
    throw error;
  }
  const blocks = [{ type: 'text', text: base }];
  const source = seqs.map((seq) => session.deriveEventMessage(session.eventAt(seq))).filter(Boolean);
  return (
    canonicalMessageBytes([{ role: 'user', content: blocks }]) < canonicalMessageBytes(source) &&
    engine._estimateCheckpointTokens(blocks) < engine._shadowedTokens(session, seqs)
  );
}

/** Split audit losses into polarity, provenance, conflict, and coverage buckets. */
export function splitAuditLost(_engine, lost, policy) {
  const polarity = [];
  const provenance = [];
  const conflictOther = [];
  const coverageOther = [];
  const other = [];
  for (const item of lost ?? []) {
    if (item?.reason === 'polarity') polarity.push(item);
    else if (item?.reason === 'provenance') provenance.push(item);
    else {
      other.push(item);
      if (item?.reason === 'coverage') coverageOther.push(item);
      else conflictOther.push(item);
    }
  }
  const provenanceSummary = provenance.length ? summarizeProvenanceFailures(provenance) : null;
  const provenanceBlocked = Boolean(
    provenanceSummary && (provenanceSummary.hardProvenance.length > 0 || policy?.auditProvenanceBlock !== false),
  );
  return { polarity, provenance, other, conflictOther, coverageOther, provenanceSummary, provenanceBlocked };
}

/** Build structured provenance failure payload and message. */
export function buildProvenanceError(_engine, provenanceSummary, baseMessage) {
  const message =
    `${baseMessage} (reason=provenance, kind=${provenanceSummary.provenanceKind}, ` +
    `line="${provenanceSummary.provenanceLine}")`;
  return {
    message,
    meta: {
      code: 'CONSTRAINT_LOST',
      constraintReason: 'provenance',
      provenanceLine: provenanceSummary.provenanceLine,
      provenanceKind: provenanceSummary.provenanceKind,
    },
  };
}

/**
 * Audit a candidate summary/checkpoint against source user constraints.
 * @param {object} engine
 * @param {object} session
 * @param {number[]} shadowedSeqs
 * @param {string} summaryTextValue
 * @param {string} compactionId
 * @param {Array} checkpointBlocks
 * @param {object} [policy]
 */
export function audit(engine, session, shadowedSeqs, summaryTextValue, compactionId, checkpointBlocks, policy = engine.config) {
  return withReferencePolicy(policy ?? engine.config, () => {
    let selection;
    try {
      selection = selectSessionMemory(session, shadowedSeqs, {
        approxTokens,
        coverageMaxMessages: policy?.preserveRecentMessages,
        coverageMaxTokens: policy?.preserveRecentUserTokens,
        includeRecentDirectSpan: true,
      });
    } catch (error) {
      const failure = new Error(redactCredentials(`compaction: constraint audit could not read source messages: ${error?.message ?? error}`));
      failure.code = 'AUDIT_UNAVAILABLE';
      failure.cause = error;
      throw failure;
    }

    const report = auditMemorySelection({
      selection,
      summaryText: summaryTextValue,
      checkpointText: Array.isArray(checkpointBlocks)
        ? checkpointBlocks.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
        : undefined,
      threshold: policy.auditCoverageThreshold,
      coverageScope: policy?.auditCoverageScope ?? DEFAULT_CONFIG.auditCoverageScope,
      includeAllConflicts: true,
      referenceMessages: collectReferenceMessages(session, session.surface.nodes),
    });

    const flips = report.lost.filter((item) => item.reason === 'polarity');
    if (report.lost.length > 0) {
      engine.log(
        'warn',
        `constraint audit ${compactionId}: ${report.lost.length}/${report.checked} source sentence(s) failed audit ` +
          `(${flips.length} polarity reversal(s), worst coverage ${report.worstCoverage}); ` +
          `seq=${report.lost[0].seq}, reason=${report.lost[0].reason}; source: ${JSON.stringify(redactCredentials(report.lost[0].line).slice(0, 120))}; ` +
          `candidate: ${JSON.stringify(redactCredentials(report.lost[0].candidate)?.slice(0, 120) ?? null)}`,
      );
    } else if (report.softCoverageCount > 0) {
      engine.log(
        'warn',
        `constraint audit ${compactionId}: ${report.softCoverageCount} out-of-window (${report.coverageScope}) ordinary coverage gap(s) allowed without blocking`,
      );
    } else if (report.checked > 0 && engine.config.debug) {
      engine.log('info', `constraint audit ${compactionId}: all ${report.checked} source sentence(s) preserved`);
    }
    return report;
  });
}

/**
 * Build the controlled heuristic-audit exhaustion fallback callback for a span.
 * @param {object} engine
 * @param {object} params
 */
export function makeAuditExhaustionFallback(
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
    memorySelection,
    progressSelection,
    referenceMessages,
    softenCoverageForFocus = false,
    auditSelection = null,
    preSummarySurfaceNodes = null,
    preSummaryReplaceGen = null,
    buildSpanCheckpoint,
  },
) {
  if ((policy?.auditExhaustionPolicy ?? DEFAULT_CONFIG.auditExhaustionPolicy) === 'block') {
    return null;
  }
  const eligibilityOpts = {
    auditBlockOnLoss: policy?.auditBlockOnLoss !== false,
    auditProvenanceBlock: policy?.auditProvenanceBlock !== false,
    softenCoverageForFocus,
  };
  const fallbackFn = ({ result, verdict, recordSkip } = {}) => {
    const skip = (skippedReason, blockingCount = 0) => {
      try {
        recordSkip?.({ skippedReason, blockingCount, maxConflicts: MAX_AUDIT_FALLBACK_CONFLICTS });
      } catch {}
      return null;
    };
    const verdictDiag = diagnoseHeuristicFallbackVerdict(verdict, eligibilityOpts);
    if (!verdictDiag.eligible) return skip(verdictDiag.skippedReason, verdictDiag.blockingCount);

    const language = result?.language ?? (policy?.language === 'zh' ? 'zh' : 'en');
    const structure = validateSummaryStructure(result?.rawText ?? '', { language });
    if (!structure.ok) return skip('structure_invalid', verdictDiag.blockingCount);
    if (retiredMemoryPresent(result.rawText, memorySelection)) return skip('retired_memory', verdictDiag.blockingCount);

    result.modelRawOutput ??= result.summary;
    const rawText = materializeUserMessageSection(deduplicateNotes(result.rawText, preserved), preserved, language);
    const summary = [{ type: 'text', text: rawText }];
    const compiled = validateSummaryStructure(rawText, { language });
    if (!compiled.ok) return skip('structure_invalid', verdictDiag.blockingCount);
    if (!validateUserMessageSection(compiled.userSectionBody, preserved).ok) {
      return skip('structure_invalid', verdictDiag.blockingCount);
    }

    const baseBlocks = buildSpanCheckpoint(summary, rawText, '', { suppressTelemetry: true });
    const provenance = auditInstructionProvenance({
      userMessages: memorySelection?.provenanceUserMessages ?? expectedUserMessages,
      retiredDecisions: memorySelection?.provenanceRetiredDecisions ?? memorySelection?.decisions,
      summaryText: rawText,
      referenceMessages,
    });
    if (provenance.length > 0 && summarizeProvenanceFailures(provenance).hardProvenance.length > 0) {
      return skip('hard_provenance', verdictDiag.blockingCount);
    }

    let combinedLost = [];
    if (policy?.auditEnabled) {
      const baseAudit = auditSelection
        ? auditMemorySelection({
            selection: auditSelection,
            summaryText: rawText,
            checkpointText: baseBlocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n'),
            threshold: policy.auditCoverageThreshold,
            coverageScope: policy?.auditCoverageScope ?? DEFAULT_CONFIG.auditCoverageScope,
            includeAllConflicts: true,
            referenceMessages,
          })
        : engine._audit(session, shadowedSeqs, rawText, compactionId, baseBlocks, policy);
      combinedLost = [...(baseAudit?.lost ?? [])];
    }
    if (provenance.length > 0) {
      const seen = new Set(combinedLost.map((item) => `${item?.reason ?? ''}\0${item?.seq ?? ''}\0${item?.line ?? ''}`));
      for (const p of provenance) {
        const key = `${p?.reason ?? ''}\0${p?.seq ?? ''}\0${p?.line ?? ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          combinedLost.push(p);
        }
      }
    }

    const { polarity, hardProvenance, blockingLost } = classifyBlockingAuditLost(combinedLost, eligibilityOpts);
    if (hardProvenance.length > 0) return skip('hard_provenance', blockingLost.length);
    if (polarity.length > 0) return skip('hard_polarity', blockingLost.length);
    if (blockingLost.length === 0) return skip('ineligible_verdict', 0);
    if (blockingLost.length > MAX_AUDIT_FALLBACK_CONFLICTS) return skip('exceeds_max_conflicts', blockingLost.length);

    const built = buildAuditFallbackPayloadDetailed({ blockingLost, session, userMessages: expectedUserMessages, language });
    if (!built.ok) return skip(built.skippedReason, built.blockingCount);
    const payload = built.payload;

    let reinjectInfo = null;
    const blocks = buildSpanCheckpoint(summary, rawText, payload.pinnedRulesBlock, {
      suppressTelemetry: true,
      onReinjectMeasured: (info) => { reinjectInfo = info; },
    });
    if (!validateCheckpointCoverage(blocks, preserved, { expected: preserved }).ok) {
      return skip('structure_invalid', blockingLost.length);
    }
    const checkpointTokens = engine._estimateCheckpointTokens(blocks);
    const checkpointBytes = canonicalMessageBytes([{ role: 'user', content: blocks }]);
    if (checkpointTokens >= shadowedTokenCount || checkpointBytes >= shadowedCanonicalBytes) {
      return skip('not_smaller', blockingLost.length);
    }
    if (!validateProgressFacts(rawText, progressSelection).ok) {
      return skip('progress_conflict', blockingLost.length);
    }

    const curFallbackCount =
      typeof engine.progressTracker?.snapshot === 'function'
        ? (engine.progressTracker.snapshot(session?.id)?.auditFallbackCount ?? 0)
        : 0;
    const addedCount = payload.auditFallback.pinnedCount || payload.auditFallback.count || 1;
    engine._trackUpdate(session, { auditFallbackCount: curFallbackCount + addedCount });
    engine.log(
      'warn',
      `audit exhaustion fallback activated for ${compactionId} ` +
        `(codes=${payload.auditFallback.codes.join(',')}, seqs=${payload.auditFallback.seqs.join(',')}, ` +
        `pinned=${payload.auditFallback.pinnedCount}, bytes=${payload.auditFallback.bytes})`,
    );

    return {
      ...result,
      rawText,
      summary,
      pinnedRulesBlock: payload.pinnedRulesBlock,
      pinnedRules: payload.pinnedRules,
      auditFallback: payload.auditFallback,
      _validated: {
        rawText,
        blocks,
        reinjectInfo,
        ...(Array.isArray(preSummarySurfaceNodes)
          ? { surfaceNodes: preSummarySurfaceNodes, replaceGeneration: preSummaryReplaceGen ?? 0 }
          : {}),
      },
    };
  };
  fallbackFn.eligibilityOpts = eligibilityOpts;
  fallbackFn.onSkipped = (skipMeta) => {
    engine.log(
      'warn',
      `audit exhaustion fallback skipped for ${compactionId} ` +
        `(reason=${skipMeta.skippedReason}, blocking=${skipMeta.blockingCount}, max=${skipMeta.maxConflicts})`,
    );
  };
  return fallbackFn;
}

function verifySessionMemoryReuseGates(
  engine,
  {
    session,
    coveredSeqs,
    rawText,
    preserved,
    expectedUserMessages,
    provenanceUserMessages,
    provenanceRetiredDecisions,
    referenceMessages,
    progressSelection,
    policy,
    compactionId,
    checkpointBlocks,
    shadowedTokenCount,
    shadowedCanonicalBytes,
  },
) {
  const coverage = validateCheckpointCoverage(checkpointBlocks, preserved, { expected: preserved });
  if (!coverage.ok) {
    engine.log('warn', `session memory reuse rejected (${coverage.code}); falling back to live LLM summary`);
    return null;
  }
  const checkpointTokens = engine._estimateCheckpointTokens(checkpointBlocks);
  const checkpointBytes = canonicalMessageBytes([{ role: 'user', content: checkpointBlocks }]);
  if (checkpointTokens >= shadowedTokenCount || checkpointBytes >= shadowedCanonicalBytes) {
    engine.log('warn', 'session memory reuse rejected (SUMMARY_NOT_SMALLER); falling back to live LLM summary');
    return null;
  }

  const progressVerdict = validateProgressFacts(rawText, progressSelection);
  if (!progressVerdict.ok) {
    engine.log('warn', `session memory reuse rejected (${progressVerdict.code}); falling back to live LLM summary`);
    return null;
  }
  const provenance = auditInstructionProvenance({
    userMessages: provenanceUserMessages ?? expectedUserMessages,
    retiredDecisions: provenanceRetiredDecisions,
    summaryText: rawText,
    referenceMessages,
  });
  if (provenance.length > 0) {
    const provSummary = summarizeProvenanceFailures(provenance);
    if (provSummary.hardProvenance.length > 0 || policy.auditProvenanceBlock !== false) {
      engine.log(
        'warn',
        `session memory reuse rejected (provenance kind=${provSummary.provenanceKind}); falling back to live LLM summary`,
      );
      return null;
    }
    engine.log(
      'warn',
      `session memory reuse soft provenance warning allowed by auditProvenanceBlock: false (kind=${provSummary.provenanceKind})`,
    );
  }
  if (policy.auditEnabled) {
    let report;
    try {
      report = engine._audit(session, coveredSeqs, rawText, compactionId, checkpointBlocks, policy);
    } catch (auditErr) {
      engine.log(
        'warn',
        `session memory reuse rejected (audit error: ${auditErr?.message ?? auditErr}); falling back to live LLM summary`,
      );
      return null;
    }
    const split = engine._splitAuditLost(report.lost, policy);
    if (split.polarity.length > 0) {
      engine.log('warn', 'session memory reuse rejected (CONSTRAINT_POLARITY_LOST); falling back to live LLM summary');
      return null;
    }
    if (split.provenanceBlocked) {
      engine.log(
        'warn',
        `session memory reuse rejected (audit provenance kind=${split.provenanceSummary?.provenanceKind}); falling back to live LLM summary`,
      );
      return null;
    }
    if (split.provenanceSummary && !split.provenanceBlocked) {
      engine.log(
        'warn',
        `session memory reuse soft provenance warning allowed by auditProvenanceBlock: false (kind=${split.provenanceSummary.provenanceKind})`,
      );
    }
    if (policy.auditBlockOnLoss && split.other.length > 0) {
      engine.log(
        'warn',
        `session memory reuse rejected (CONSTRAINT_LOST seq=${split.other[0]?.seq}); falling back to live LLM summary`,
      );
      return null;
    }
  }

  let archiveEntries = [];
  if (policy.archiveEnabled) {
    try {
      archiveEntries = spanEntries(session, coveredSeqs);
    } catch (archiveErr) {
      engine.log(
        'warn',
        `session memory reuse rejected (archive entries error: ${archiveErr?.message ?? archiveErr}); falling back to live LLM summary`,
      );
      return null;
    }
    const selectedEntries = archiveEntries.filter((entry) => entry?.snapshot?.scope === 'selected');
    if (
      selectedEntries.length !== coveredSeqs.length ||
      selectedEntries.some((entry, idx) => entry.seq !== coveredSeqs[idx])
    ) {
      engine.log('warn', 'session memory reuse rejected (archive span mismatch); falling back to live LLM summary');
      return null;
    }
  }
  return { archiveEntries };
}

/**
 * Validate a cached session-memory entry against foreground gates before zero-LLM commit.
 * @param {object} engine
 * @param {object} session
 * @param {object} match
 * @param {object} policy
 * @param {object} [options={}]
 */
export function validateSessionMemoryReuse(engine, session, match, policy, options = {}) {
  if (!session || !match || !Array.isArray(match.coveredSeqs) || match.coveredSeqs.length === 0) {
    return null;
  }
  const coveredSeqs = [...match.coveredSeqs];
  try {
    validateSurfaceRegion(session, coveredSeqs[0], coveredSeqs.at(-1));
  } catch (err) {
    engine.log(
      'warn',
      `session memory reuse skipped (invalid surface region: ${err?.message ?? err}); falling back to live LLM summary`,
    );
    return null;
  }

  const compactionId = nextCompactionId();
  const shadowedTokenCount = engine._shadowedTokens(session, coveredSeqs);
  const shadowedCanonicalBytes = canonicalMessageBytes(
    coveredSeqs.map((seq) => session.deriveEventMessage(session.eventAt(seq))).filter(Boolean),
  );
  const shadowedTokenPrecision = engine._lastPrecision?.get(session) ?? 'unknown';
  const input = buildSummarizationInput(session, coveredSeqs, { preservePrefixCache: false, policy });
  const progressSelection = input.progress;
  const memorySelection = selectSessionMemory(session, coveredSeqs, {
    maxMessages: policy.preserveRecentMessages,
    maxTokens: policy.preserveRecentUserTokens,
    approxTokens,
  });
  if (memorySelection.decisions.some((d) => d.reason === 'oldest-quote-evicted') && !policy.archiveEnabled) {
    engine.log(
      'warn',
      'session memory reuse skipped (archive required for evicted quotes); falling back to live LLM summary',
    );
    return null;
  }

  const expectedUserMessages = [...memorySelection.active, ...memorySelection.retained];
  const referenceMessages = collectReferenceMessages(session, session.surface?.nodes ?? []);
  const preserved = memorySelection.preserved;
  const archivedFiles = collectArchivedFiles(session, coveredSeqs);
  const childArchiveIds = policy.archiveEnabled && engine.historyToolsAvailable
    ? collectChildArchiveIds(session, coveredSeqs)
    : [];

  const language = match.memory.language ?? (policy.language === 'zh' ? 'zh' : 'en');
  const originalRawText = match.memory.rawText;
  const structure = validateSummaryStructure(originalRawText, { language });
  if (!structure.ok) {
    engine.log('warn', `session memory reuse rejected (${structure.code}); falling back to live LLM summary`);
    return null;
  }
  const retired = retiredMemoryPresent(originalRawText, memorySelection);
  if (retired) {
    engine.log(
      'warn',
      `session memory reuse rejected (RETIRED_MEMORY_REINTRODUCED seq=${retired.seq}); falling back to live LLM summary`,
    );
    return null;
  }
  const rawText = materializeUserMessageSection(deduplicateNotes(originalRawText, preserved), preserved, language);
  const summaryBlocks = [{ type: 'text', text: rawText }];
  const compiled = validateSummaryStructure(rawText, { language });
  if (!compiled.ok) {
    engine.log('warn', `session memory reuse rejected (${compiled.code}); falling back to live LLM summary`);
    return null;
  }
  const listed = validateUserMessageSection(compiled.userSectionBody, preserved);
  if (!listed.ok) {
    engine.log('warn', `session memory reuse rejected (${listed.code}); falling back to live LLM summary`);
    return null;
  }

  let lastReinjectMeasured = null;
  const checkpointBlocks = engine._buildSpanCheckpointWithMetadata({
    session,
    shadowedSeqs: coveredSeqs,
    policy,
    compactionId,
    summaryBlocks,
    summaryText: rawText,
    preserved,
    workReport: input.workReport,
    progress: progressSelection,
    shadowedTokenCount,
    shadowedCanonicalBytes,
    archivedFiles,
    childArchiveIds,
    budgetSpec: engine._getBudgetSpec(session, options.budgetSpec),
    suppressTelemetry: true,
    onReinjectMeasured: (info) => { lastReinjectMeasured = info; },
  });

  const verified = verifySessionMemoryReuseGates(engine, {
    session,
    coveredSeqs,
    rawText,
    preserved,
    expectedUserMessages,
    provenanceUserMessages: memorySelection?.provenanceUserMessages ?? expectedUserMessages,
    provenanceRetiredDecisions: memorySelection?.provenanceRetiredDecisions ?? memorySelection?.decisions,
    referenceMessages,
    progressSelection,
    policy,
    compactionId,
    checkpointBlocks,
    shadowedTokenCount,
    shadowedCanonicalBytes,
  });
  if (!verified) return null;

  const workReport = collectWorkReport(session, coveredSeqs);
  const sourceMemory = {
    progressFacts: progressSourceRefs(progressSelection),
    summaryScope: progressSelection?.scope,
    workReport: workReportRef(workReport),
    memoryRequirements: preservedForSource(memoryRequirements(memorySelection.active)) ?? [],
    memorySources: memorySourceRefs(memorySelection.active, session),
    memoryDecisions: memoryDecisionsForSource(memorySelection.decisions, session),
  };

  const summarized = {
    summary: summaryBlocks,
    rawText,
    modelRawOutput: [{ type: 'text', text: originalRawText }],
    provider: match.memory.provider ?? 'session-memory',
    model: match.memory.model ?? 'cached',
    maxTokens: options.maxTokens ?? policy.maxTokens ?? DEFAULT_CONFIG.maxTokens,
    language,
    usage: match.memory.usage ?? null,
    fromSessionMemory: true,
    sessionMemoryMode: match.mode,
  };

  return {
    compactionId,
    shadowedSeqs: coveredSeqs,
    shadowedTokenCount,
    shadowedTokenPrecision,
    summarized,
    preserved,
    checkpointBlocks,
    memorySelection,
    progressSelection,
    sourceMemory,
    archiveEntries: verified.archiveEntries,
    archivePath: null,
    archivePending: true,
    fromSessionMemory: true,
    sessionMemoryMode: match.mode,
    reinjectMeasurement: lastReinjectMeasured,
  };
}

async function prepareAutoCompaction(engine, agent, session, trigger, signal) {
  engine._restoreState(session);
  const stopped = engine._stopped.has(engine._keyOf(session));
  if (engine._busy.has(session) || signal?.aborted) return null;
  let pendingContinuation = readPendingContinuation(engine.sessionState, session);
  if (pendingContinuation) {
    await engine.recoverPending(session);
    pendingContinuation = readPendingContinuation(engine.sessionState, session);
  }

  const measurement = await engine._measure(session);
  if (!measurement) return null;

  let spec;
  try {
    spec = await engine._resolveSpec(agent, measurement, signal);
  } catch (error) {
    if (!stopped && !isAbortError(error, signal)) engine._recordFailure(agent, session, error);
    throw error;
  }
  if (!spec) return null;

  const total = measurement.totalTokens;
  noteDiagnosticMeasurement(measurement, { thresholdTokens: spec.thresholdTokens });
  if (stopped) {
    const state = engine._restoreState(session);
    if (pendingContinuation || (trigger === 'pressure' && total >= spec.thresholdTokens)) {
      const action = engine.config.pressureBreakerAction ?? 'confirm';
      const bypassed = state?.breakerBypassed === true;
      const canBypass =
        !pendingContinuation &&
        trigger === 'pressure' &&
        total < spec.messageBudgetTokens &&
        (action === 'degrade' || (action === 'confirm' && bypassed));
      if (canBypass) {
        engine.log(
          'warn',
          `pressure compaction skipped under active circuit breaker (action=${action}, bypassed=${bypassed}, total=${total} < budget=${spec.messageBudgetTokens})`,
        );
        return null;
      }
      throw engine._automaticFailure(session, { code: 'COMPACTION_STOPPED' });
    }
    return null;
  }
  if (trigger === 'pressure' && !pendingContinuation) {
    if (total < spec.thresholdTokens) return null;
    if (measurement.precision !== 'priced' && engine.config.debug) {
      engine.log('info', `token measurement is ${measurement.precision} (not exact); total ${total} vs threshold ${spec.thresholdTokens}`);
    }
    if (engine.config.debug) {
      engine.log(
        'info',
        `capacity: window ${spec.contextWindow}, reserved output ${spec.contextWindow - spec.messageBudgetTokens}, ` +
          `message budget ${spec.messageBudgetTokens}, headroom ${spec.messageBudgetTokens - spec.pressureBudgetTokens}, ` +
          `trigger at ${spec.thresholdTokens}, current input ${total}`,
      );
    }
    if (engine.config.minGrowthTokens > 0) {
      const last = engine._lastTotal.get(session);
      const prevThreshold = engine._lastThreshold?.get(session);
      const windowShrank = typeof prevThreshold === 'number' && spec.thresholdTokens < prevThreshold;
      if (
        !windowShrank &&
        typeof last === 'number' &&
        last < spec.thresholdTokens &&
        total < spec.messageBudgetTokens &&
        total - last < engine.config.minGrowthTokens
      ) {
        return null;
      }
    }
    engine._lastThreshold?.set(session, spec.thresholdTokens);
  }

  engine._assertNoActiveBiliConflict(session, trigger);

  const initialReductionTarget = Math.min(spec.thresholdTokens - 1, Math.floor(measurement.totalTokens * (1 - (spec.policy.minimumReductionRatio ?? 0.2))));
  noteDiagnosticMeasurement(measurement, { thresholdTokens: spec.thresholdTokens, targetTokens: initialReductionTarget });
  const entryTurn = inspectCompactionEntryState(session).openTurn;
  const initialSurfaceNodes = session.surface?.nodes ?? [];
  if (!pendingContinuation && trigger === 'pressure' && total < spec.messageBudgetTokens && !spec.policy.continuationEnabled) {
    let weaveCheckpoints = 0;
    let shrinkableNonCheckpoint = 0;
    for (let i = 0; i < initialSurfaceNodes.length; i += 1) {
      const seq = initialSurfaceNodes[i];
      if (i === 0 && systemHead(session, seq)) continue;
      const ev = session.eventAt(seq);
      if (isExternalFoldEvent(ev, session) || isExternalScriptCheckpoint(ev)) continue;
      if (ev?.type === 'user/message' && ev?.data?.source?.kind === COMPACT_CHECKPOINT_KIND) weaveCheckpoints += 1;
      else shrinkableNonCheckpoint += 1;
    }
    if (weaveCheckpoints <= 1 && shrinkableNonCheckpoint === 0) {
      traceStagePoint('secondaryPrecheck', { precheck: true, reason: 'checkpoint-only', checkpointCount: weaveCheckpoints });
      engine.log('info', 'pressure compaction skipped: surface has only the latest checkpoint with no new shrinkable history');
      return null;
    }
  }

  engine._busy.add(session);
  engine._agentBySession.set(session, agent);
  if (trigger === 'context-overflow' || pendingContinuation || spec.policy?.sessionMemoryEnabled !== true) {
    engine.sessionMemory?.cancel?.(session.id);
  }
  let initialTargetRange = pendingContinuation
    ? { start: pendingContinuation.seqs[0], end: pendingContinuation.seqs.at(-1) }
    : (selectCachePreservingRange(session, measurement, spec.retainTokens, spec.policy, initialReductionTarget) ??
        selectCompactableRange(session, measurement, spec.retainTokens));
  if (!initialTargetRange) {
    try { initialTargetRange = selectContinuationRange(session); } catch { initialTargetRange = null; }
  }
  let preHookResult;
  try {
    preHookResult = await engine._runPreCompactHook({
      session,
      trigger,
      manual: false,
      focusInstruction: '',
      totalTokens: measurement.totalTokens,
      range: initialTargetRange,
      continuation: Boolean(pendingContinuation),
      signal,
    });
  } catch (hookErr) {
    engine._busy.delete(session);
    throw hookErr;
  }
  if (preHookResult.cancelled) {
    engine._busy.delete(session);
    return null;
  }
  const initialTargetSeqs = initialTargetRange
    ? initialSurfaceNodes.slice(initialSurfaceNodes.indexOf(initialTargetRange.start), initialSurfaceNodes.indexOf(initialTargetRange.end) + 1)
    : initialSurfaceNodes.filter((seq, idx) => !(idx === 0 && systemHead(session, seq)));
  return {
    measurement,
    spec,
    pendingContinuation,
    initialReductionTarget,
    entryTurn,
    preHookResult,
    initialTargetRange,
    initialTargetSeqs,
  };
}

async function runAutoStage1Masking(
  engine,
  {
    agent,
    session,
    spec,
    trigger,
    pendingContinuation,
    currentMeasurement,
    initialReductionTarget,
    initialTargetRange,
    initialTargetSeqs,
    effectiveFocus,
    additionalContext,
    progressScope,
    runSignal,
  },
) {
  let measurement = currentMeasurement;
  let reductionTarget = initialReductionTarget;
  let skipStage1ForSessionMemory = false;
  if (trigger === 'pressure' && !pendingContinuation && spec.policy?.sessionMemoryEnabled === true && !effectiveFocus) {
    const canMaskStage1 = spec.policy.observationMaskingEnabled !== false && spec.policy.archiveEnabled && engine.historyToolsAvailable;
    const previewMaskPlan = canMaskStage1
      ? planObservationMask(session, measurement, spec.retainTokens, {
          compactionId: 'preview-mask-check',
          thresholdChars: spec.policy.observationMaskThresholdChars,
          headChars: spec.policy.observationMaskHeadChars,
          tailChars: spec.policy.observationMaskTailChars,
        })
      : null;
    const maskAloneReachesTarget = Boolean(
      previewMaskPlan && measurement.totalTokens - previewMaskPlan.totalTokensSaved <= initialReductionTarget,
    );
    if (maskAloneReachesTarget) {
      engine.sessionMemory?.cancel?.(session.id);
    } else {
      if (engine.sessionMemory?.inFlight?.has?.(session.id)) {
        await engine._awaitOrCancelSessionMemory(session, spec.policy, runSignal, {
          trigger,
          continuation: false,
          focusInstruction: effectiveFocus,
          additionalContext,
          expectedStartSeq: initialTargetRange?.start,
        });
      }
      if (
        initialTargetSeqs.length > 0 &&
        engine.sessionMemory?.matchForSpan?.(session, initialTargetSeqs, spec.policy, { allowPrefixSplit: true })
      ) {
        skipStage1ForSessionMemory = true;
      }
    }
  }
  if (!skipStage1ForSessionMemory && !pendingContinuation && spec.policy.observationMaskingEnabled !== false && spec.policy.archiveEnabled && engine.historyToolsAvailable) {
    const flushSession = typeof engine.ctx.sessions?.flush === 'function' ? (targetSession) => engine._flushSession(targetSession) : null;
    let totalMaskedCount = 0;
    let totalMaskedSaved = 0;
    let lastMasked = null;
    const maskedIds = [];
    for (let maskPass = 0; maskPass < 4; maskPass += 1) {
      runSignal?.throwIfAborted?.();
      const maskPlan = planObservationMask(session, measurement, spec.retainTokens, {
        compactionId: nextCompactionId(),
        thresholdChars: spec.policy.observationMaskThresholdChars,
        headChars: spec.policy.observationMaskHeadChars,
        tailChars: spec.policy.observationMaskTailChars,
      });
      if (!maskPlan) break;
      if (maskPass === 0 && trigger === 'pressure') {
        const maskAloneReachesTarget = measurement.totalTokens - maskPlan.totalTokensSaved <= initialReductionTarget;
        const oversizedPreMask = measurement.totalTokens >= spec.messageBudgetTokens;
        if (!maskAloneReachesTarget && !oversizedPreMask) break;
      } else if (maskPass > 0 && trigger === 'pressure' && measurement.totalTokens <= initialReductionTarget) {
        break;
      }
      engine._trackUpdate(session, {
        phase: 'masking',
        overallPercent: Math.min(11, 6 + maskPass * 2),
        maskedCount: totalMaskedCount,
        maskedTokensSaved: totalMaskedSaved,
        overallProcessedTokens: totalMaskedSaved,
        currentTokens: measurement.totalTokens,
        targetTokens: initialReductionTarget,
      });
      let masked;
      try {
        masked = await commitObservationMask({
          session,
          plan: maskPlan,
          archive: engine.archive,
          log: (level, msg) => engine.log(level, msg),
          flushSession,
          signal: runSignal,
        });
      } catch (error) {
        if (!isAbortError(error, runSignal)) engine._recordFailure(agent, session, error);
        throw error;
      }
      if (!masked) break;
      engine._invalidateSessionMemory(session.id);
      lastMasked = masked;
      maskedIds.push(masked.compactionId);
      totalMaskedCount += maskPlan.targets.length;
      totalMaskedSaved += masked.shadowedTokenCount ?? maskPlan.totalTokensSaved;
      const afterMask = await engine._measure(session);
      if (!afterMask) break;
      measurement = afterMask;
      engine._lastTotal.set(session, afterMask.totalTokens);
      reductionTarget = Math.min(
        spec.thresholdTokens - 1,
        Math.floor(measurement.totalTokens * (1 - (spec.policy.minimumReductionRatio ?? 0.2))),
      );
      noteDiagnosticMeasurement(measurement, { thresholdTokens: spec.thresholdTokens, targetTokens: reductionTarget });
      engine._trackUpdate(session, {
        phase: 'masking',
        overallPercent: Math.min(12, 8 + maskPass * 2),
        maskedCount: totalMaskedCount,
        maskedTokensSaved: totalMaskedSaved,
        overallProcessedTokens: totalMaskedSaved,
        currentTokens: afterMask.totalTokens,
        targetTokens: reductionTarget,
      });
      if (afterMask.totalTokens < spec.thresholdTokens && afterMask.totalTokens <= initialReductionTarget) {
        return {
          hasEarlyReturn: true,
          earlyReturn: maskedIds.length > 1
            ? { ...lastMasked, compactionIds: maskedIds, shadowedTokenCount: totalMaskedSaved }
            : lastMasked,
        };
      }
      if (!maskPlan.hasMore && measurement.totalTokens <= initialReductionTarget) break;
    }
    if (totalMaskedCount > 0) {
      const postMaskNodes = session.surface?.nodes ?? [];
      const postMaskRange =
        selectCachePreservingRange(session, measurement, spec.retainTokens, spec.policy, reductionTarget) ??
        selectCompactableRange(session, measurement, spec.retainTokens);
      const postMaskSeqs = postMaskRange
        ? postMaskNodes.slice(postMaskNodes.indexOf(postMaskRange.start), postMaskNodes.indexOf(postMaskRange.end) + 1)
        : postMaskNodes.filter((seq, idx) => !(idx === 0 && systemHead(session, seq)));
      engine._syncProgressScopeAfterMask(progressScope, session, postMaskSeqs, totalMaskedSaved);
    }
  }
  return { hasEarlyReturn: false, currentMeasurement: measurement, reductionTarget };
}

function finishAutoBatch(engine, session, spec, state, measured, batchCause = null) {
  if (state.lastResult && measured && spec.policy.continuationEnabled && engine.historyToolsAvailable && measured.totalTokens > state.reductionTarget) {
    throw Object.assign(new Error('Compaction leaves too little headroom for stable prefix reuse; switching to bounded continuation.'), {
      code: 'COMPACTION_CAPACITY_BLOCKED',
    });
  }
  if (measured && (measured.totalTokens >= spec.messageBudgetTokens || (spec.policy.continuationEnabled && engine.historyToolsAvailable && measured.totalTokens >= spec.thresholdTokens))) {
    const overMessageBudget = measured.totalTokens >= spec.messageBudgetTokens;
    const limitDesc = overMessageBudget
      ? `${spec.messageBudgetTokens} message budget`
      : `${spec.thresholdTokens} compaction threshold (message budget ${spec.messageBudgetTokens})`;
    const suffix = batchCause?.message ? ` (cause: ${batchCause.message})` : '';
    const error = new Error(
      `compaction cannot fit the next main request: ${measured.totalTokens} estimated input tokens >= ${limitDesc}; ${state.chunkResults.length} chunks committed, remaining history retained; use /compact or a larger-capacity target${suffix}`,
    );
    error.code = 'COMPACTION_CAPACITY_BLOCKED';
    error.compactionIds = [...state.chunkResults, ...state.foldResults].flatMap((r) => r.compactionIds ?? [r.compactionId]);
    throw error;
  }
  if (state.resumableJob) {
    try { clearResumableCompaction(engine.sessionState, session.id); } catch {}
    state.resumableJob = null;
  }
  if (!state.lastResult && session?.id) engine.progressTracker?.clear?.(session.id);
  return state.lastResult;
}

async function runAutoSingleChunkAndFold(
  engine,
  {
    agent,
    session,
    spec,
    trigger,
    runSignal,
    cancelController,
    fresh,
    range,
    pendingBefore,
    capacityContext,
    maxAttempts,
    maxWaves,
    foldThreshold,
    canFallbackContinuation,
    effectiveFocus,
    additionalContext,
    softenCoverageForFocus,
    syncAutoResumable,
    state,
  },
) {
  let chunkResult;
  let madeProgress = false;
  try {
    chunkResult = await engine._compactRegionCore(range.start, range.end, agent, runSignal, {
      manual: false,
      trigger,
      maxTokens: spec.maxTokens,
      policy: spec.policy,
      budgetSpec: spec,
      capacityContext,
      ...(effectiveFocus ? { focusInstruction: effectiveFocus } : {}),
      ...(additionalContext ? { additionalContext } : {}),
      softenCoverageForFocus,
      deferCapacityFailureRecord: canFallbackContinuation,
    });
    if (chunkResult) {
      state.chunkResults.push(chunkResult);
      if (typeof chunkResult.replacementSeq === 'number') {
        state.batchCheckpointSeqs.push(chunkResult.replacementSeq);
      }
      state.lastResult = combineBatchResults(state.chunkResults, state.foldResults);
      const liveNow = new Set(session.surface.nodes);
      state.pendingOriginals = state.pendingOriginals.filter((seq) => liveNow.has(seq));
      madeProgress = state.pendingOriginals.length < pendingBefore;
      syncAutoResumable(state.pendingOriginals, state.chunkResults.length, state.waveCount, state.batchCheckpointSeqs);
    }
  } catch (error) {
    if (runSignal?.aborted) {
      if (state.resumableJob) {
        engine._persistResumableInterrupted(session, state.resumableJob, error, runSignal, {
          userCancelled: cancelController.signal.aborted,
        });
      }
      if (cancelController.signal.aborted) throw error;
      return { done: true, result: state.lastResult };
    }
    const message = error?.message ?? String(error);
    if (/not a balanced boundary|not found in surface/.test(message)) {
      engine.log('warn', `range rejected by the surface (${message}); keeping remaining history`);
      return { done: true, result: finishAutoBatch(engine, session, spec, state, await engine._measure(session)) };
    }
    if (error?.code === 'RECOVERY_REQUIRED') throw error;
    try {
      finishAutoBatch(engine, session, spec, state, await engine._measure(session), error);
    } catch (blocked) {
      blocked.cause = error;
      if (error?._deferredFailureRecord) blocked._deferredFailureRecord = true;
      throw blocked;
    }
    if (state.chunkResults.length) {
      error.message = `${state.chunkResults.length} summary chunk(s) committed; remaining history retained: ${error.message}`;
      error.compactionIds = [...state.chunkResults, ...state.foldResults].flatMap((r) => r.compactionIds ?? [r.compactionId]);
    }
    throw error;
  }

  const after = await engine._measure(session);
  if (!after) return { done: true, result: state.lastResult };
  engine._lastTotal.set(session, after.totalTokens);
  engine._trackUpdate(session, { currentTokens: after.totalTokens, stream: null, retryReasonCode: null });
  if (
    after.totalTokens <= state.reductionTarget ||
    (after.totalTokens < spec.thresholdTokens && (!state.pendingOriginals.length || !madeProgress))
  ) {
    return { done: true, result: finishAutoBatch(engine, session, spec, state, after) };
  }

  const liveSet = new Set(session.surface.nodes);
  const rawRemaining = Array.isArray(state.pendingOriginals) && state.pendingOriginals.some((seq) => liveSet.has(seq));
  const serialFoldThreshold = Math.max(
    foldThreshold,
    resolveBulkFoldThreshold(
      spec.policy,
      state.chunkResults.length + estimateBulkChunkCount(session, state.pendingOriginals, spec.policy, capacityContext.current),
    ),
  );
  if (state.batchCheckpointSeqs.length >= serialFoldThreshold && rawRemaining && state.waveCount < maxWaves && state.attempts < maxAttempts) {
    state.waveCount += 1;
    const folded = await engine._tryHierarchicalFold({
      session,
      agent,
      signal: runSignal,
      batchCheckpointSeqs: state.batchCheckpointSeqs,
      policy: spec.policy,
      budgetSpec: spec,
      manual: false,
      maxTokens: spec.maxTokens,
      capacityContext,
      waveIndex: state.waveCount,
      focusInstruction: effectiveFocus,
      additionalContext,
      softenCoverageForFocus,
    });
    if (folded) {
      state.foldResults.push(folded);
      state.batchCheckpointSeqs = typeof folded.replacementSeq === 'number' ? [folded.replacementSeq] : [];
      state.lastResult = combineBatchResults(state.chunkResults, state.foldResults);
      syncAutoResumable(state.pendingOriginals, state.chunkResults.length, state.waveCount, state.batchCheckpointSeqs);
      const afterFold = await engine._measure(session);
      if (afterFold) {
        engine._lastTotal.set(session, afterFold.totalTokens);
        engine._trackUpdate(session, { currentTokens: afterFold.totalTokens, stream: null, retryReasonCode: null });
        if (
          afterFold.totalTokens <= state.reductionTarget ||
          (afterFold.totalTokens < spec.thresholdTokens && !state.pendingOriginals.length)
        ) {
          return { done: true, result: finishAutoBatch(engine, session, spec, state, afterFold) };
        }
      }
    } else {
      state.batchCheckpointSeqs = [];
    }
  }
  return { done: false };
}

async function runAutoSummaryBatchLoop(
  engine,
  {
    agent,
    session,
    spec,
    trigger,
    currentMeasurement,
    progressScope,
    runSignal,
    cancelController,
    capacityContext,
    effectiveFocus,
    additionalContext,
    softenCoverageForFocus,
    syncAutoResumable,
    state,
  },
) {
  let retainTokens = spec.retainTokens;
  const maxAttempts = engine.config.maxSummaryChunks;
  const maxWaves = 8;
  const foldThreshold = Math.max(2, spec.policy.cacheMaxCheckpoints ?? 4);
  const canFallbackContinuation = Boolean(spec.policy.continuationEnabled && spec.policy.archiveEnabled && engine.historyToolsAvailable);

  while (state.attempts < maxAttempts) {
    state.attempts += 1;
    if (runSignal?.aborted) {
      if (state.resumableJob) {
        engine._persistResumableInterrupted(session, state.resumableJob, runSignal.reason, runSignal, {
          userCancelled: cancelController.signal.aborted,
        });
      }
      if (cancelController.signal.aborted) throw runSignal.reason ?? Object.assign(new Error('compaction cancelled by user'), { code: 'ABORTED', userCancelled: true });
      return state.lastResult;
    }

    const fresh = state.attempts === 1 ? currentMeasurement : await engine._measure(session);
    if (!fresh) return state.lastResult;
    if (fresh.totalTokens <= state.reductionTarget && state.lastResult !== null) {
      return finishAutoBatch(engine, session, spec, state, fresh);
    }

    let range;
    if (state.pendingOriginals) {
      const live = new Set(session.surface.nodes);
      state.pendingOriginals = state.pendingOriginals.filter((seq) => live.has(seq));
      if (!state.pendingOriginals.length) return finishAutoBatch(engine, session, spec, state, fresh);
      range = { start: state.pendingOriginals[0], end: state.pendingOriginals.at(-1) };
    } else {
      range =
        selectCachePreservingRange(session, fresh, retainTokens, spec.policy, state.reductionTarget) ??
        selectCompactableRange(session, fresh, retainTokens);
    }
    if (range && !state.pendingOriginals?.length) {
      const currentNodes = session.surface.nodes;
      state.pendingOriginals = currentNodes.slice(currentNodes.indexOf(range.start), currentNodes.indexOf(range.end) + 1);
    }
    if (!range) return finishAutoBatch(engine, session, spec, state, fresh);

    if (!state.resumableJob && Array.isArray(state.pendingOriginals) && state.pendingOriginals.length > 0) {
      state.resumableJob = engine._persistResumableRunning(session, {
        jobId: `job-${randomUUID().slice(0, 12)}`,
        trigger,
        status: 'running',
        remainingSeqs: [...state.pendingOriginals],
        initialTotalNodes: progressScope.totalNodes || state.pendingOriginals.length,
        completedNodes: 0,
        initialTotalTokens: progressScope.totalTokens || fresh.totalTokens,
        completedTokens: 0,
        completedChunks: 0,
        waveCount: 0,
        batchCheckpointSeqs: [],
        allowForeignFallback: false,
        checkpointMeta: null,
        originalBackupId: null,
        consecutiveFailures: 0,
      });
    }

    const pendingBefore = state.pendingOriginals.length;
    const requestedConcurrency = Number.isInteger(spec.policy.summaryConcurrency)
      ? Math.max(1, Math.min(6, spec.policy.summaryConcurrency))
      : 1;
    if (state.chunkResults.length >= 1 && requestedConcurrency > 1 && Array.isArray(state.pendingOriginals) && state.pendingOriginals.length >= 2) {
      const remainingSlots = Math.max(0, maxAttempts - state.attempts + 1);
      if (remainingSlots >= 2) {
        const bulkFoldThreshold = Math.max(
          foldThreshold,
          resolveBulkFoldThreshold(
            spec.policy,
            state.chunkResults.length + estimateBulkChunkCount(session, state.pendingOriginals, spec.policy, capacityContext.current),
          ),
        );
        const concurrentOutcome = await engine._compactChunksConcurrent({
          session,
          agent,
          signal: runSignal,
          pending: state.pendingOriginals,
          policy: spec.policy,
          budgetSpec: spec,
          manual: false,
          trigger,
          maxTokens: spec.maxTokens,
          capacityContext,
          maxSlices: remainingSlots,
          results: state.chunkResults,
          foldResults: state.foldResults,
          batchCheckpointSeqs: state.batchCheckpointSeqs,
          waveCount: state.waveCount,
          maxWaves,
          foldThreshold: bulkFoldThreshold,
          stopBelowTokens: state.reductionTarget + 1,
          focusInstruction: effectiveFocus,
          additionalContext,
          softenCoverageForFocus,
          deferCapacityFailureRecord: canFallbackContinuation,
          onAfterCommit: ({ pending: nextPending, waveCount: nextWave, batchCheckpointSeqs: nextCps }) => {
            state.pendingOriginals = nextPending;
            state.waveCount = nextWave;
            state.batchCheckpointSeqs = nextCps;
            state.lastResult = combineBatchResults(state.chunkResults, state.foldResults);
            syncAutoResumable(state.pendingOriginals, state.chunkResults.length, state.waveCount, state.batchCheckpointSeqs);
          },
        });
        if (concurrentOutcome.used) {
          const madeProgress = concurrentOutcome.pending.length < pendingBefore;
          state.pendingOriginals = concurrentOutcome.pending;
          state.waveCount = concurrentOutcome.waveCount;
          state.batchCheckpointSeqs = concurrentOutcome.batchCheckpointSeqs;
          state.attempts += Math.max(0, concurrentOutcome.committedCount - 1);
          if (state.chunkResults.length) state.lastResult = combineBatchResults(state.chunkResults, state.foldResults);
          const afterConcurrent = await engine._measure(session);
          if (afterConcurrent) {
            engine._lastTotal.set(session, afterConcurrent.totalTokens);
            engine._trackUpdate(session, { currentTokens: afterConcurrent.totalTokens, stream: null });
            if (
              afterConcurrent.totalTokens <= state.reductionTarget ||
              (afterConcurrent.totalTokens < spec.thresholdTokens && (!state.pendingOriginals.length || !madeProgress))
            ) {
              return finishAutoBatch(engine, session, spec, state, afterConcurrent);
            }
          }
          continue;
        }
      }
    }

    engine._trackUpdate(session, {
      phase: 'planning',
      chunkIndex: state.attempts,
      chunkTotal: null,
      waveIndex: state.waveCount > 0 ? state.waveCount + 1 : null,
      retryReasonCode: null,
      currentTokens: fresh.totalTokens,
      targetTokens: state.reductionTarget,
      ...engine._computeCompressionProgress(session, [], 0),
    });

    const step = await runAutoSingleChunkAndFold(engine, {
      agent,
      session,
      spec,
      trigger,
      runSignal,
      cancelController,
      fresh,
      range,
      pendingBefore,
      capacityContext,
      maxAttempts,
      maxWaves,
      foldThreshold,
      canFallbackContinuation,
      effectiveFocus,
      additionalContext,
      softenCoverageForFocus,
      syncAutoResumable,
      state,
    });
    if (step.done) return step.result;
  }

  const after = await engine._measure(session);
  if (after && after.totalTokens >= spec.thresholdTokens) {
    engine.log(
      'warn',
      `compaction still above threshold after ${state.attempts} attempt(s) (${after.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
    );
  }
  return finishAutoBatch(engine, session, spec, state, after);
}

async function handleAutoBatchFailure(
  engine,
  {
    error,
    agent,
    session,
    spec,
    trigger,
    runSignal,
    cancelController,
    capacityContext,
    continuationBudget,
    effectiveFocus,
    additionalContext,
    softenCoverageForFocus,
    syncAutoResumable,
    hadPendingContinuationAtEntry,
    state,
  },
) {
  let enteredContinuation = false;
  if (!error?.surfaceMutated && spec.policy.continuationEnabled && spec.policy.archiveEnabled && engine.historyToolsAvailable && continuationEligible(error) && !runSignal?.aborted) {
    try {
      const contRun = await engine._runContinuationWaves({
        session,
        agent,
        policy: spec.policy,
        maxTokens: spec.maxTokens,
        signal: runSignal,
        capacityContext,
        manual: false,
        trigger,
        stopBelowTokens: spec.thresholdTokens,
        continuationBudgetFor: continuationBudget,
        recordSelectionFailure: true,
        focusInstruction: effectiveFocus,
        additionalContext,
        softenCoverageForFocus,
        onWaveCommitted: () => {
          if (state.resumableJob) {
            const liveNow = session.surface?.nodes ?? [];
            const rem = liveNow.filter((seq, idx) => !(idx === 0 && systemHead(session, seq)));
            syncAutoResumable(rem, (state.resumableJob.completedChunks ?? 0) + 1, (state.resumableJob.waveCount ?? 0) + 1, []);
          }
        },
      });
      enteredContinuation = contRun.entered;
      if (contRun.results.length > 0) {
        try { clearResumableCompaction(engine.sessionState, session.id); } catch {}
        state.resumableJob = null;
        return contRun.results.length === 1 ? contRun.results[0] : combineBatchResults(contRun.results, []);
      }
    } catch (contErr) {
      if (!hadPendingContinuationAtEntry && state.chunkResults.length > 0) {
        const afterRolloverFail = await engine._measure(session).catch(() => null);
        if (afterRolloverFail && afterRolloverFail.totalTokens < spec.thresholdTokens) {
          try {
            const curPending = readPendingContinuation(engine.sessionState, session);
            if (curPending && engine._readPendingContinuationAcceptedPages(session, curPending) === 0) {
              clearPendingContinuation(engine.sessionState, session.id);
            }
          } catch {}
        }
      }
      if (state.resumableJob) {
        engine._persistResumableInterrupted(session, state.resumableJob, contErr, runSignal, {
          userCancelled: cancelController.signal.aborted,
        });
      }
      throw contErr;
    }
  }
  if (state.resumableJob) {
    engine._persistResumableInterrupted(session, state.resumableJob, error, runSignal, {
      userCancelled: cancelController.signal.aborted,
    });
  }
  if (!enteredContinuation && (error?._deferredFailureRecord || error?.cause?._deferredFailureRecord) && !isAbortError(error, runSignal)) {
    engine._recordFailure(agent, session, error?.cause?._deferredFailureRecord ? error.cause : error);
  }
  throw error;
}

async function tryAutoContinuationRegion(
  engine,
  { agent, session, spec, trigger, pendingContinuation, currentMeasurement, continuationBudget, capacityContext, effectiveFocus, additionalContext, softenCoverageForFocus, runSignal, state },
) {
  let range = pendingContinuation
    ? { start: pendingContinuation.seqs[0], end: pendingContinuation.seqs.at(-1) }
    : (selectCachePreservingRange(session, currentMeasurement, spec.retainTokens, spec.policy, state.reductionTarget, { continuation: true }) ??
        selectContinuationRange(session));
  if (!range) return { handled: false };
  let budget;
  const preflight = (candidate) => {
    const nodes = session.surface.nodes;
    const seqs = nodes.slice(nodes.indexOf(candidate.start), nodes.indexOf(candidate.end) + 1);
    const selected = selectSessionMemory(session, seqs, { approxTokens });
    const progress = collectProgressFacts(session, seqs);
    planContinuationMemory(residentConstraints(selected.active, session), spec.policy, {
      budgetTokens: budget,
      estimateTokens: (blocks) => engine._estimateCheckpointTokens(blocks),
      workReport: scopeWorkReport(collectWorkReport(session, seqs), progress),
      progress,
    });
  };
  try {
    budget = pendingContinuation?.budgetTokens ?? (await continuationBudget(range));
    if (!pendingContinuation) preflight(range);
  } catch (error) {
    if (pendingContinuation || !['CONTINUATION_TOO_LARGE', 'CONTINUATION_REQUIREMENTS_TOO_LARGE'].includes(error.code)) {
      throw error;
    }
    const full = selectContinuationRange(session);
    if (!full || (full.start === range.start && full.end === range.end)) throw error;
    range = full;
    budget = await continuationBudget(range);
    preflight(range);
  }
  const contDone = await engine._compactRegionCore(range.start, range.end, agent, runSignal, {
    manual: false,
    trigger,
    policy: spec.policy,
    budgetSpec: spec,
    continuation: true,
    continuationBudgetTokens: budget,
    capacityContext,
    ...(effectiveFocus ? { focusInstruction: effectiveFocus } : {}),
    ...(additionalContext ? { additionalContext } : {}),
    softenCoverageForFocus,
  });
  try { clearResumableCompaction(engine.sessionState, session.id); } catch {}
  return { handled: true, result: contDone };
}

/**
 * Core automatic pressure / context-overflow compaction implementation.
 * @param {object} engine
 * @param {object} agent
 * @param {'pressure'|'context-overflow'} trigger
 * @param {AbortSignal|undefined} signal
 */
export async function compactIfNeededInner(engine, agent, trigger, signal) {
  const session = agent?.session;
  if (!session) return null;
  const prep = await prepareAutoCompaction(engine, agent, session, trigger, signal);
  if (!prep) return null;

  const {
    measurement: currentMeasurementStart,
    spec,
    pendingContinuation,
    initialReductionTarget,
    entryTurn,
    preHookResult,
    initialTargetRange,
    initialTargetSeqs,
  } = prep;
  const { effectiveFocus, additionalContext } = preHookResult;
  const softenCoverageForFocus = false;
  const progressScope = engine._buildProgressScope(session, initialTargetSeqs, {
    beforeTokens: currentMeasurementStart.totalTokens,
  });

  const autoResult = await engine._trackRun(
    session,
    {
      trigger,
      phase: 'detecting',
      turn: entryTurn,
      beforeTokens: currentMeasurementStart.totalTokens,
      currentTokens: currentMeasurementStart.totalTokens,
      targetTokens: initialReductionTarget,
      overallPercent: 2,
      overallProcessedNodes: 0,
      overallTotalNodes: progressScope.totalNodes,
      overallProcessedTokens: 0,
      overallTotalTokens: progressScope.totalTokens,
    },
    (runId) => engine._progressScope.run(progressScope, () => engine._runWithCancel(session, runId, signal, async (runSignal, cancelController) => {
      const capacityContext = {};
      const hadPendingContinuationAtEntry = Boolean(pendingContinuation);
      const state = {
        attempts: 0,
        lastResult: null,
        pendingOriginals: undefined,
        batchCheckpointSeqs: [],
        waveCount: 0,
        resumableJob: null,
        chunkResults: [],
        foldResults: [],
        reductionTarget: initialReductionTarget,
      };
      const continuationBudget = async (range) => {
        const fresh = await engine._measure(session);
        const nodes = session.surface.nodes;
        const archivedTokens = engine._shadowedTokens(session, nodes.slice(nodes.indexOf(range.start), nodes.indexOf(range.end) + 1));
        const retainedTokens = Math.max(0, (fresh?.totalTokens ?? currentMeasurementStart.totalTokens) - archivedTokens);
        const available = Math.min(Math.floor(spec.thresholdTokens / 2), state.reductionTarget - retainedTokens);
        if (available <= 0) {
          throw Object.assign(new Error('Protected system context leaves insufficient room for the requested minimum reduction.'), {
            code: 'CONTINUATION_TOO_LARGE',
          });
        }
        return available;
      };
      const syncAutoResumable = (remaining, chunksCount, wavesCount, batchCps) => {
        if (!state.resumableJob) return;
        const liveSet = new Set(session.surface?.nodes ?? []);
        const liveRem = (remaining ?? []).filter((seq) => liveSet.has(seq));
        state.resumableJob.remainingSeqs = liveRem;
        state.resumableJob.completedNodes = Math.max(state.resumableJob.completedNodes, Math.max(0, state.resumableJob.initialTotalNodes - liveRem.length));
        state.resumableJob.completedTokens = Math.max(state.resumableJob.completedTokens, progressScope.doneTokens);
        state.resumableJob.completedChunks = chunksCount;
        state.resumableJob.waveCount = wavesCount;
        state.resumableJob.batchCheckpointSeqs = (batchCps ?? []).filter((seq) => liveSet.has(seq));
        if (liveRem.length > 0) {
          state.resumableJob = engine._persistResumableRunning(session, state.resumableJob);
        } else {
          try { clearResumableCompaction(engine.sessionState, session.id); } catch {}
          state.resumableJob = null;
        }
      };
      try {
        const stage1 = await runAutoStage1Masking(engine, {
          agent,
          session,
          spec,
          trigger,
          pendingContinuation,
          currentMeasurement: currentMeasurementStart,
          initialReductionTarget,
          initialTargetRange,
          initialTargetSeqs,
          effectiveFocus,
          additionalContext,
          progressScope,
          runSignal,
        });
        if (stage1.hasEarlyReturn) return stage1.earlyReturn;
        let currentMeasurement = stage1.currentMeasurement;
        state.reductionTarget = stage1.reductionTarget;

        if (trigger === 'context-overflow' && !pendingContinuation) {
          await engine._pruneToolResults(session);
          const afterPrune = await engine._measure(session);
          if (afterPrune) {
            currentMeasurement = afterPrune;
            state.reductionTarget = Math.min(spec.thresholdTokens - 1, Math.floor(currentMeasurement.totalTokens * (1 - (spec.policy.minimumReductionRatio ?? 0.2))));
            noteDiagnosticMeasurement(currentMeasurement, { thresholdTokens: spec.thresholdTokens, targetTokens: state.reductionTarget });
            engine._trackUpdate(session, { currentTokens: afterPrune.totalTokens, targetTokens: state.reductionTarget });
          }
        }
        if (pendingContinuation || (spec.policy.continuationEnabled && hasContinuation(session))) {
          const contOutcome = await tryAutoContinuationRegion(engine, {
            agent,
            session,
            spec,
            trigger,
            pendingContinuation,
            currentMeasurement,
            continuationBudget,
            capacityContext,
            effectiveFocus,
            additionalContext,
            softenCoverageForFocus,
            runSignal,
            state,
          });
          if (contOutcome.handled) return contOutcome.result;
        }
        return await runAutoSummaryBatchLoop(engine, {
          agent,
          session,
          spec,
          trigger,
          currentMeasurement,
          progressScope,
          runSignal,
          cancelController,
          capacityContext,
          effectiveFocus,
          additionalContext,
          softenCoverageForFocus,
          syncAutoResumable,
          state,
        });
      } catch (error) {
        return await handleAutoBatchFailure(engine, {
          error,
          agent,
          session,
          spec,
          trigger,
          runSignal,
          cancelController,
          capacityContext,
          continuationBudget,
          effectiveFocus,
          additionalContext,
          softenCoverageForFocus,
          syncAutoResumable,
          hadPendingContinuationAtEntry,
          state,
        });
      } finally {
        engine._busy.delete(session);
      }
    })),
  );
  if (autoResult != null) {
    await engine._runPostCompactHook({ session, trigger, manual: false, focusInstruction: '', result: autoResult, signal });
  }
  return autoResult;
}
