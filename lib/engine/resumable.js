// Resumable compaction checkpoints, progress scope tracking, resumeCompactionFor, and retryCompactionFor.
// All functions accept `engine` as 1st parameter and NEVER import `../engine.js`.

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { combineSignals } from '../abort.js';
import { isBiliProxyResidualError } from '../bili-conflict.js';
import { isFatalAuthError } from '../concurrency.js';
import { continuationBudgetInfo } from '../continuation-budget.js';
import { clearPendingContinuation, readPendingContinuation } from '../continuation-pending.js';
import { ContinuationProgressStore } from '../continuation-progress.js';
import { failureExplanation } from '../failure-diagnostics.js';
import {
  inspectCompactionEntryState,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '../region.js';
import {
  clearBreakerState,
  clearResumableCompaction,
  readResumableCompaction,
  writeResumableCompaction,
} from '../state.js';
import {
  activeTransactions,
  isAbortError,
  isBudgetExhaustedError,
  isCompactCheckpointSource,
  isTimeoutFailureError,
  isUserCancelledError,
} from './shared.js';

export function discardResumableFor(engine, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) {
    throw Object.assign(new Error('sessionId is required'), { code: 'INVALID_SESSION_ID' });
  }
  const discarded = clearResumableCompaction(engine.sessionState, sessionId);
  const clearedContinuation = clearPendingContinuation(engine.sessionState, sessionId);
  return { discarded, clearedContinuation };
}

export function readPendingContinuationAcceptedPages(engine, session, pendingContinuation) {
  if (!pendingContinuation) return null;
  if (!pendingContinuation.progressKey) return 0;
  const progressRoot = join(dirname(engine.archive.root), 'continuation-progress');
  try {
    const record = new ContinuationProgressStore(progressRoot, session?.id, pendingContinuation.progressKey).read();
    if (record) {
      const next = record.data?.next;
      if (!Number.isSafeInteger(next) || next < 0) return null;
      if (next > 0) return next;
    }
    const history = pendingContinuation.progressHistory ?? [];
    if (!Array.isArray(history)) return null;
    for (const priorKey of history) {
      const priorRecord = new ContinuationProgressStore(progressRoot, session?.id, priorKey).read();
      if (priorRecord) {
        const priorNext = priorRecord.data?.next;
        if (!Number.isSafeInteger(priorNext) || priorNext < 0) return null;
        if (priorNext > 0) return priorNext;
      }
    }
    return 0;
  } catch {
    return null;
  }
}

export async function allowPausedBelowThreshold(engine, agent, error, signal) {
  const bi = continuationBudgetInfo(error);
  const isSpentBudgetZeroNew = Boolean(bi && !(bi.requestsThisAttempt > 0));
  const isStoppedPaused =
    error?.code === 'COMPACTION_AUTOMATIC_BLOCKED' && error?.failureCode === 'COMPACTION_STOPPED';
  if (!isSpentBudgetZeroNew && !isStoppedPaused) return false;
  const curMeasure = await engine._measure(agent.session).catch(() => null);
  // Full _resolveSpec (not budgetOnly: true) is required to obtain thresholdTokens.
  const curSpec = curMeasure ? await engine._resolveSpec(agent, curMeasure, signal).catch(() => null) : null;
  if (curMeasure && curSpec && Number.isFinite(curSpec.thresholdTokens) && curMeasure.totalTokens < curSpec.thresholdTokens) {
    engine.log(
      'warn',
      `paused/exhausted compaction non-blocking below threshold (${curMeasure.totalTokens} < ${curSpec.thresholdTokens}): ${error?.message ?? error}`,
    );
    return true;
  }
  return false;
}

export function sourceHashForSeqs(_engine, session, seqs) {
  if (!session || !Array.isArray(seqs) || seqs.length === 0) return null;
  const payload = seqs.map((seq) => {
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
    const msg = event && typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : null;
    return [seq, msg ?? null];
  });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function advanceWeaveCheckpointPrefix(engine, session, rawJob, nodes, liveSet, seqs, firstLiveIdx, surfaceStartIdx) {
  const liveTail = seqs.slice(firstLiveIdx);
  // Idempotent prefix advancement: allow a missing leading prefix ONLY when a Weave
  // compact-checkpoint sits immediately before `liveTail[0]` on the live surface AND
  // every missing prefix seq was actually shadowed by a Weave compaction in this session
  // (proving a crash happened between chunk commit and state update, not external drift).
  const prevSeq = surfaceStartIdx > 0 ? nodes[surfaceStartIdx - 1] : null;
  const prevEvent = prevSeq !== null ? session.eventAt?.(prevSeq) : null;
  const prevSource = prevEvent?.type === 'user/message' ? prevEvent.data?.source : null;
  const isPrecededByWeaveCp =
    isCompactCheckpointSource(prevSource) &&
    typeof prevSource?.compactionId === 'string' &&
    prevSource.compactionId.startsWith('weave-');
  if (!isPrecededByWeaveCp) {
    clearResumableCompaction(engine.sessionState, session.id);
    return { valid: false, reason: 'drifted' };
  }
  const missingPrefix = seqs.slice(0, firstLiveIdx);
  const weaveShadowed = new Set();
  if (Array.isArray(prevEvent?.sourceEventSeqs)) {
    for (const s of prevEvent.sourceEventSeqs) weaveShadowed.add(s);
  }
  if (missingPrefix.some((s) => !weaveShadowed.has(s))) {
    const totalSeq = Number.isSafeInteger(session.seq) ? session.seq : 0;
    for (let s = 0; s < totalSeq; s += 1) {
      const ev = session.eventAt?.(s);
      if (
        ev?.type === 'compaction/summary' &&
        typeof ev.data?.compactionId === 'string' &&
        ev.data.compactionId.startsWith('weave-') &&
        Array.isArray(ev.data.shadowedSeqs)
      ) {
        for (const shadowed of ev.data.shadowedSeqs) weaveShadowed.add(shadowed);
      }
    }
  }
  if (missingPrefix.some((s) => !weaveShadowed.has(s))) {
    clearResumableCompaction(engine.sessionState, session.id);
    return { valid: false, reason: 'drifted' };
  }
  const balanced = toolPairingBalancedBefore(session, liveTail[0]) && toolPairingBalancedAfter(session, liveTail.at(-1));
  if (!balanced && rawJob.allowForeignFallback !== true) {
    clearResumableCompaction(engine.sessionState, session.id);
    return { valid: false, reason: 'drifted' };
  }
  const advancedTokens = Math.min(
    Math.max(0, rawJob.initialTotalTokens - rawJob.completedTokens),
    engine._shadowedTokens(session, seqs.slice(0, firstLiveIdx)),
  );
  const nextBatchCps = [...(rawJob.batchCheckpointSeqs ?? []).filter((s) => liveSet.has(s))];
  if (typeof prevSeq === 'number' && !nextBatchCps.includes(prevSeq)) nextBatchCps.push(prevSeq);
  const advancedJob = {
    ...rawJob,
    remainingSeqs: liveTail,
    remainingSourceSha256: engine._sourceHashForSeqs(session, liveTail),
    completedNodes: Math.min(rawJob.initialTotalNodes, (rawJob.completedNodes ?? 0) + firstLiveIdx),
    completedTokens: Math.min(rawJob.initialTotalTokens, (rawJob.completedTokens ?? 0) + advancedTokens),
    completedChunks: (rawJob.completedChunks ?? 0) + 1,
    batchCheckpointSeqs: nextBatchCps,
    updatedAt: new Date().toISOString(),
  };
  try {
    writeResumableCompaction(engine.sessionState, session.id, advancedJob);
  } catch {
    /* best-effort persistence before resuming */
  }
  return { valid: true, advanced: true, job: advancedJob };
}

export function validateAndAdvanceResumable(engine, session, rawJob) {
  if (!session?.id || !rawJob || rawJob.status === 'running') {
    return { valid: false, reason: 'none' };
  }
  const nodes = session.surface?.nodes ?? [];
  const liveSet = new Set(nodes);
  const seqs = Array.isArray(rawJob.remainingSeqs) ? rawJob.remainingSeqs : [];
  if (seqs.length === 0) {
    clearResumableCompaction(engine.sessionState, session.id);
    return { valid: false, reason: 'already_completed' };
  }

  const firstLiveIdx = seqs.findIndex((seq) => liveSet.has(seq));
  if (firstLiveIdx < 0) {
    // Every remaining seq is already off the live surface — finished or externally replaced.
    clearResumableCompaction(engine.sessionState, session.id);
    return { valid: false, reason: 'already_completed' };
  }

  const liveTail = seqs.slice(firstLiveIdx);
  const surfaceStartIdx = nodes.indexOf(liveTail[0]);
  const isContiguous =
    surfaceStartIdx >= 0 && liveTail.every((seq, offset) => nodes[surfaceStartIdx + offset] === seq);
  if (!isContiguous) {
    clearResumableCompaction(engine.sessionState, session.id);
    return { valid: false, reason: 'drifted' };
  }

  if (firstLiveIdx > 0) {
    return advanceWeaveCheckpointPrefix(engine, session, rawJob, nodes, liveSet, seqs, firstLiveIdx, surfaceStartIdx);
  }

  // No prefix advancement: verify exact source hash when recorded.
  if (rawJob.remainingSourceSha256) {
    const actualHash = engine._sourceHashForSeqs(session, liveTail);
    if (actualHash !== rawJob.remainingSourceSha256) {
      clearResumableCompaction(engine.sessionState, session.id);
      return { valid: false, reason: 'drifted' };
    }
  }
  return { valid: true, advanced: false, job: rawJob };
}

export function persistResumableRunning(engine, session, job) {
  if (!session?.id || !job || !Array.isArray(job.remainingSeqs) || job.remainingSeqs.length === 0) return job;
  const next = {
    ...job,
    status: 'running',
    interruptReason: null,
    remainingSourceSha256: engine._sourceHashForSeqs(session, job.remainingSeqs),
    updatedAt: new Date().toISOString(),
  };
  try {
    return writeResumableCompaction(engine.sessionState, session.id, next);
  } catch {
    return next;
  }
}

export function persistResumableInterrupted(
  engine,
  session,
  job,
  error,
  signal,
  { userCancelled = false, wasResumed = false } = {},
) {
  if (!session?.id || !job) return null;
  const liveSet = new Set(session.surface?.nodes ?? []);
  const remainingSeqs = (job.remainingSeqs ?? []).filter((seq) => liveSet.has(seq));
  if (remainingSeqs.length === 0) {
    try {
      clearResumableCompaction(engine.sessionState, session.id);
    } catch {}
    return null;
  }
  const budgetExhausted = isBudgetExhaustedError(error);
  const cancelled = userCancelled || isUserCancelledError(error, signal);
  const timedOut = !cancelled && !budgetExhausted && isTimeoutFailureError(error);
  const hasPendingCont = Boolean(readPendingContinuation(engine.sessionState, session));
  const hasProgress = (job.completedChunks ?? 0) > 0 || hasPendingCont;
  const shouldKeep =
    hasProgress || cancelled || budgetExhausted || wasResumed || job.trigger === 'migration';
  if (!shouldKeep) {
    try {
      clearResumableCompaction(engine.sessionState, session.id);
    } catch {}
    return null;
  }

  let status;
  let interruptReason;
  let consecutiveFailures = job.consecutiveFailures ?? 0;
  if (budgetExhausted) {
    status = 'paused_budget';
    interruptReason = 'budget_exhausted';
  } else if (cancelled) {
    status = 'interrupted';
    interruptReason = 'cancelled';
  } else if (timedOut) {
    consecutiveFailures += 1;
    status = consecutiveFailures >= engine.config.failureThreshold ? 'paused_failure' : 'interrupted';
    interruptReason = 'timeout';
  } else {
    consecutiveFailures += 1;
    const fatal = isFatalAuthError(error) || consecutiveFailures >= engine.config.failureThreshold;
    status = fatal ? 'paused_failure' : 'interrupted';
    interruptReason = 'error';
  }

  const rawCode = error?.failureCode ?? error?.code ?? error?.cause?.code ?? null;
  const lastErrorCode = typeof rawCode === 'string' && rawCode.length > 0 ? rawCode.slice(0, 80) : null;
  let lastErrorMessage = null;
  try {
    lastErrorMessage = error ? failureExplanation(error) : null;
  } catch {
    lastErrorMessage = typeof error?.message === 'string' ? error.message.slice(0, 240) : null;
  }

  const batchCheckpointSeqs = (job.batchCheckpointSeqs ?? []).filter((seq) => liveSet.has(seq));
  const record = {
    ...job,
    status,
    interruptReason,
    remainingSeqs,
    remainingSourceSha256: engine._sourceHashForSeqs(session, remainingSeqs),
    batchCheckpointSeqs,
    consecutiveFailures,
    lastErrorCode,
    lastErrorMessage,
    updatedAt: new Date().toISOString(),
  };
  try {
    const persisted = writeResumableCompaction(engine.sessionState, session.id, record);
    if (interruptReason === 'error' || interruptReason === 'timeout') {
      if (isBiliProxyResidualError(error)) engine._noteBiliRuntimeSignal(session, error);
      const key = engine._keyOf(session);
      try {
        const synced = engine.sessionState.update(session.id, (current) => {
          const failures = Math.max(current.failures ?? 0, consecutiveFailures);
          const stopped = Boolean(current.stopped || failures >= engine.config.failureThreshold);
          const preserveRoot =
            current.stopped === true && Boolean(current.lastFailureCode) && lastErrorCode === 'COMPACTION_STOPPED';
          return {
            ...current,
            failures,
            stopped,
            ...(preserveRoot || !lastErrorCode ? {} : { lastFailureCode: lastErrorCode }),
          };
        });
        engine._setBounded(engine._failures, key, synced.failures);
        if (synced.stopped) engine._setBounded(engine._stopped, key, true);
      } catch {
        /* best-effort top-level state sync */
      }
    }
    return persisted;
  } catch {
    return record;
  }
}

export function buildProgressScope(
  engine,
  session,
  targetSeqs,
  {
    beforeTokens = 0,
    isFoldAdopt = false,
    priorCompletedNodes = 0,
    priorCompletedTokens = 0,
    initialTotalNodes = 0,
    initialTotalTokens = 0,
  } = {},
) {
  const uniqueSeqs = [];
  const seqTokens = new Map();
  const seen = new Set();
  for (const seq of Array.isArray(targetSeqs) ? targetSeqs : []) {
    if (typeof seq !== 'number' || seen.has(seq)) continue;
    seen.add(seq);
    uniqueSeqs.push(seq);
    seqTokens.set(seq, engine._shadowedTokens(session, [seq]));
  }
  const sumTokens = [...seqTokens.values()].reduce((acc, n) => acc + n, 0);
  const priorNodes = Number.isFinite(priorCompletedNodes) && priorCompletedNodes > 0 ? Math.floor(priorCompletedNodes) : 0;
  const priorTokens =
    Number.isFinite(priorCompletedTokens) && priorCompletedTokens > 0 ? Math.floor(priorCompletedTokens) : 0;
  const totalNodes = Math.max(
    uniqueSeqs.length + priorNodes,
    Number.isFinite(initialTotalNodes) && initialTotalNodes > 0 ? Math.floor(initialTotalNodes) : 0,
  );
  const totalTokens = Math.max(
    sumTokens + priorTokens,
    Number.isFinite(beforeTokens) && beforeTokens > 0 ? Math.floor(beforeTokens) + priorTokens : 0,
    Number.isFinite(initialTotalTokens) && initialTotalTokens > 0 ? Math.floor(initialTotalTokens) : 0,
  );
  return {
    session,
    isFoldAdopt: Boolean(isFoldAdopt),
    compressionTargetSeqSet: new Set(uniqueSeqs),
    compressionSeqTokens: new Map(seqTokens),
    priorNodes,
    priorTokens,
    totalNodes,
    totalTokens,
    doneNodes: priorNodes,
    doneTokens: priorTokens,
    maskedTokensSaved: 0,
  };
}

export function withProgressScope(engine, session, targetSeqs, opts, fn) {
  const existing = engine._progressScope.getStore();
  if (existing && existing.session === session) {
    return fn(existing);
  }
  const scope = engine._buildProgressScope(session, targetSeqs, opts);
  return engine._progressScope.run(scope, () => fn(scope));
}

export function syncProgressScopeAfterMask(engine, scope, session, nextTargetSeqs, maskedTokensSaved = 0) {
  if (!scope || scope.session !== session || scope.isFoldAdopt) return;
  const uniqueSeqs = [];
  const seqTokens = new Map();
  const seen = new Set();
  for (const seq of Array.isArray(nextTargetSeqs) ? nextTargetSeqs : []) {
    if (typeof seq !== 'number' || seen.has(seq)) continue;
    seen.add(seq);
    uniqueSeqs.push(seq);
    seqTokens.set(seq, engine._shadowedTokens(session, [seq]));
  }
  scope.compressionTargetSeqSet = new Set(uniqueSeqs);
  scope.compressionSeqTokens = seqTokens;
  scope.maskedTokensSaved = Math.max(scope.maskedTokensSaved, Math.floor(maskedTokensSaved || 0));
  scope.totalNodes = Math.max(scope.totalNodes, uniqueSeqs.length + (scope.priorNodes ?? 0));
}

export function computeCompressionProgress(engine, session, shadowedSeqs = [], activeSubFraction = 0, { committing = false } = {}) {
  const scope = engine._progressScope.getStore();
  if (scope && scope.session === session && scope.isFoldAdopt) return {};
  if (!scope || scope.session !== session) {
    if (!committing && !shadowedSeqs?.length) return {};
    const clampedSub = Math.max(0, Math.min(1, Number.isFinite(activeSubFraction) ? activeSubFraction : 0));
    return {
      overallPercent: committing ? 97 : Math.min(96, Math.max(12, Math.round(12 + 84 * clampedSub))),
    };
  }
  const liveSet = new Set(session?.surface?.nodes ?? []);
  let compDoneNodes = 0;
  let compDoneTokens = 0;
  let compTotalTokens = 0;
  for (const seq of scope.compressionTargetSeqSet) {
    const tok = scope.compressionSeqTokens.get(seq) ?? 0;
    compTotalTokens += tok;
    if (!liveSet.has(seq)) {
      compDoneNodes += 1;
      compDoneTokens += tok;
    }
  }
  const priorNodes = scope.priorNodes ?? 0;
  const priorTokens = scope.priorTokens ?? 0;
  const compTotalNodes = Math.max(1, scope.compressionTargetSeqSet.size + priorNodes);
  let activeSpanNodes = 0;
  let activeSpanTokens = 0;
  for (const seq of Array.isArray(shadowedSeqs) ? shadowedSeqs : []) {
    if (scope.compressionTargetSeqSet.has(seq) && liveSet.has(seq)) {
      activeSpanNodes += 1;
      activeSpanTokens += scope.compressionSeqTokens.get(seq) ?? 0;
    }
  }
  const clampedSub = Math.max(0, Math.min(1, Number.isFinite(activeSubFraction) ? activeSubFraction : 0));
  const effectiveDoneNodes = Math.min(compTotalNodes, priorNodes + compDoneNodes + clampedSub * activeSpanNodes);
  const fraction = Math.max(0, Math.min(1, effectiveDoneNodes / compTotalNodes));
  const isFinalSpan = priorNodes + compDoneNodes + activeSpanNodes >= compTotalNodes;
  const overallPercent =
    committing && isFinalSpan ? 97 : Math.min(96, Math.max(12, Math.round(12 + 84 * fraction)));
  const overallTotalNodes = Math.max(scope.totalNodes, compTotalNodes);
  const overallProcessedNodes = Math.min(overallTotalNodes, Math.floor(fraction * overallTotalNodes));
  const overallTotalTokens = Math.max(scope.totalTokens, priorTokens + compTotalTokens + scope.maskedTokensSaved);
  const tokenDone = priorTokens + scope.maskedTokensSaved + compDoneTokens + clampedSub * activeSpanTokens;
  const overallProcessedTokens = Math.min(
    overallTotalTokens,
    Math.floor(Math.max(tokenDone, fraction * overallTotalTokens)),
  );
  scope.doneNodes = Math.max(scope.doneNodes, overallProcessedNodes);
  scope.doneTokens = Math.max(scope.doneTokens, overallProcessedTokens);
  return {
    overallPercent,
    overallProcessedNodes: scope.doneNodes,
    overallTotalNodes,
    overallProcessedTokens: scope.doneTokens,
    overallTotalTokens,
  };
}

function handleResumeFailure(engine, session, effectiveAgent, job, error, runSignal) {
  if (
    !runSignal?.aborted &&
    !isAbortError(error, runSignal) &&
    !isUserCancelledError(error, runSignal) &&
    error?.code !== 'cancelled' &&
    error?.code !== 'RECOVERY_REQUIRED' &&
    error?.code !== 'STATE_UNAVAILABLE' &&
    error?.code !== 'commit' &&
    error?.hookCancelled !== true
  ) {
    try {
      engine._recordFailure(effectiveAgent, session, error);
    } catch {
      /* best-effort failure accounting */
    }
    try {
      const lingering = readResumableCompaction(engine.sessionState, session.id);
      if (lingering && lingering.status === 'running') {
        engine._persistResumableInterrupted(session, lingering, error, runSignal, {
          userCancelled: false,
          wasResumed: Boolean(job ?? false),
        });
      }
    } catch {
      /* best-effort resumable persistence */
    }
  }
}

/**
 * Resume an interrupted, budget-paused, or failure-paused compaction/migration job
 * from its durable `resumableCompaction` checkpoint.
 *
 * Dynamically inspects `inspectCompactionEntryState(session).openTurn`:
 * - `openTurn === null` -> runs in manual mode (with `runMaintenance` when attached & not already inside maintenance)
 * - `openTurn !== null` -> runs in turn-enclosed automatic mode (e.g. from `agent/pre-step`)
 */
export async function resumeCompactionFor(engine, session, options = {}) {
  return engine._runWithActiveSignal(options.signal, (activeSignal) =>
    engine._withConfig(async () => {
      if (!session || typeof session !== 'object' || typeof session.id !== 'string' || !session.id) {
        throw Object.assign(new Error('Resume requires a valid loaded session.'), { code: 'INVALID_SESSION_ID' });
      }
      const transactionKey = `${engine.sessionState.root}:${JSON.stringify(session.id)}`;
      if (engine._busy.has(session) || activeTransactions.has(transactionKey) || engine.progressTracker?.hasActiveRun?.(session.id)) {
        if (options.idempotent === true) {
          return {
            accepted: true,
            alreadyRunning: true,
            completed: false,
            runId: engine.progressTracker?.snapshot?.(session.id)?.runId ?? null,
          };
        }
        throw Object.assign(new Error('Compaction or migration is already in progress for this session.'), {
          code: 'busy',
        });
      }

      await engine.recoverPending(session);
      engine.sessionMemory?.cancel?.(session.id);
      const rawJob = readResumableCompaction(engine.sessionState, session.id);
      if (!rawJob) return null;

      const validated = engine._validateAndAdvanceResumable(session, rawJob);
      if (!validated.valid) return null;
      let job = validated.job;
      engine._assertNoActiveBiliConflict(session, job?.trigger ?? 'resume');

      if (options.manualRetry === true) {
        const key = engine._keyOf(session);
        engine._failures.delete(key);
        engine._stopped.delete(key);
        engine._recoveryBlocked.delete(key);
        job = { ...job, consecutiveFailures: 0, updatedAt: new Date().toISOString() };
        try {
          engine.sessionState.update(session.id, (current) => ({
            ...clearBreakerState(current),
            resumableCompaction: job,
          }));
        } catch {
          /* continue with in-memory breaker reset */
        }
      }

      const entryState = inspectCompactionEntryState(session);
      const effectiveManual = entryState.openTurn === null;
      const attachedAgent = engine._resolveLiveAgent(session, options.agent);
      const effectiveAgent = attachedAgent ?? { session, options: {} };
      const useMaintenance = Boolean(
        effectiveManual &&
          attachedAgent &&
          typeof attachedAgent.runMaintenance === 'function' &&
          options.insideMaintenance !== true &&
          options.insidePreStep !== true,
      );

      const explicitRange = {
        start: job.remainingSeqs[0],
        end: job.remainingSeqs.at(-1),
      };
      const initialMeasurement = await engine._measure(session);
      const beforeTokens = initialMeasurement?.totalTokens ?? 0;
      const progressScope = engine._buildProgressScope(session, job.remainingSeqs, {
        beforeTokens,
        priorCompletedNodes: job.completedNodes ?? 0,
        priorCompletedTokens: job.completedTokens ?? 0,
        initialTotalNodes: job.initialTotalNodes ?? 0,
        initialTotalTokens: job.initialTotalTokens ?? 0,
      });

      const executeResume = async (runSignal) => {
        const result = await engine._compactManual(
          effectiveAgent,
          runSignal,
          options.sourceCommandId,
          false,
          !effectiveManual,
          {
            explicitRange,
            allowForeignFallback: job.allowForeignFallback === true,
            checkpointMeta: job.checkpointMeta ?? null,
            triggerOverride: job.trigger,
            manualOverride: effectiveManual,
            resumableJob: job,
            allowPolicyRestart: options.allowPolicyRestart !== false,
            manualRetry: options.manualRetry === true || effectiveManual,
            originalBackupId: job.originalBackupId ?? null,
          },
        );
        try {
          clearResumableCompaction(engine.sessionState, session.id);
        } catch {}
        if (job.trigger === 'migration') {
          const key = engine._keyOf(session);
          engine._failures.delete(key);
          engine._stopped.delete(key);
          try {
            engine.sessionState.update(session.id, (current) => clearBreakerState(current));
          } catch {}
        }
        return result;
      };

      let resolveStarted;
      const startedPromise = new Promise((resolve) => {
        resolveStarted = resolve;
      });
      const runPromise = engine._trackRun(
        session,
        {
          trigger: job.trigger ?? 'manual',
          phase: job.trigger === 'migration' ? 'migrating' : 'planning',
          beforeTokens,
          currentTokens: beforeTokens,
          overallPercent: Math.max(
            12,
            Math.min(95, Math.round(12 + 84 * (progressScope.doneNodes / Math.max(1, progressScope.totalNodes)))),
          ),
          overallProcessedNodes: progressScope.doneNodes,
          overallTotalNodes: progressScope.totalNodes,
          overallProcessedTokens: progressScope.doneTokens,
          overallTotalTokens: progressScope.totalTokens,
        },
        (runId) => {
          resolveStarted(runId);
          return engine._progressScope.run(progressScope, () =>
            engine._runWithCancel(session, runId, activeSignal, async (runSignal) => {
              engine._busy.add(session);
              engine._agentBySession.set(session, effectiveAgent);
              try {
                if (useMaintenance) {
                  return await attachedAgent.runMaintenance(async (agentSignal) => {
                    const merged = combineSignals([agentSignal, runSignal]);
                    try {
                      return await executeResume(merged.signal);
                    } finally {
                      merged.dispose();
                    }
                  });
                }
                return await executeResume(runSignal);
              } catch (error) {
                handleResumeFailure(engine, session, effectiveAgent, job, error, runSignal);
                throw error;
              } finally {
                engine._busy.delete(session);
              }
            }),
          );
        },
      );

      if (options.asyncRollingWave === true) {
        runPromise.catch(() => {});
        const runId = await startedPromise;
        return {
          accepted: true,
          alreadyRunning: false,
          completed: false,
          runId: runId ?? null,
        };
      }

      return await runPromise;
    }),
  );
}

export async function retryCompactionFor(engine, session, options = {}) {
  return engine._withConfig(async () => {
    if (!session || typeof session !== 'object' || typeof session.id !== 'string' || !session.id) {
      throw Object.assign(new Error('Retry requires a valid loaded session.'), { code: 'INVALID_SESSION_ID' });
    }
    const transactionKey = `${engine.sessionState.root}:${JSON.stringify(session.id)}`;
    if (engine._busy.has(session) || activeTransactions.has(transactionKey) || engine.progressTracker?.hasActiveRun?.(session.id)) {
      if (options.idempotent === true) {
        return {
          accepted: true,
          alreadyRunning: true,
          completed: false,
          runId: engine.progressTracker?.snapshot?.(session.id)?.runId ?? null,
        };
      }
      throw Object.assign(new Error('Compaction or migration is already in progress for this session.'), {
        code: 'busy',
      });
    }

    engine._assertNoActiveBiliConflict(session, 'retry');
    const key = engine._keyOf(session);
    try {
      const recovery = await engine.recoverPending(session);
      if (recovery?.busy) {
        throw Object.assign(new Error('Compaction recovery is already in progress for this session.'), { code: 'busy' });
      }
      if ((await engine.journal.pending(session.id)).length > 0) {
        throw new Error('Unrecovered compaction journal entries remain; retry requires completed recovery.');
      }
    } catch (cause) {
      if (cause?.code === 'busy') throw cause;
      engine._addBounded(engine._recoveryBlocked, key);
      if (cause?.code === 'RECOVERY_REQUIRED') throw cause;
      throw Object.assign(new Error('Compaction recovery must finish before retrying; original journal retained.'), {
        code: 'RECOVERY_REQUIRED', cause,
      });
    }
    engine.sessionMemory?.cancel?.(session.id);
    engine._failures.delete(key);
    engine._stopped.delete(key);
    engine._recoveryBlocked.delete(key);
    try {
      engine.sessionState.update(session.id, (current) => clearBreakerState(current));
    } catch {
      /* continue with in-memory breaker reset */
    }

    const existingResumable = readResumableCompaction(engine.sessionState, session.id);
    if (existingResumable && existingResumable.status !== 'running') {
      const resumed = await engine.resumeCompactionFor(session, {
        ...options,
        manualRetry: true,
      });
      if (resumed) return resumed;
    }

    const attachedAgent = engine._resolveLiveAgent(session, options.agent);
    const effectiveAgent = attachedAgent ?? { session, options: {} };
    const executeRetry = async (runSignal) => {
      if (typeof effectiveAgent.runMaintenance === 'function' && options.insideMaintenance !== true) {
        return await engine.compactNow(effectiveAgent, runSignal, options.sourceCommandId, false);
      }
      return await engine.diagnostics.run(
        session,
        {
          trigger: 'manual',
          commandId: options.sourceCommandId,
          signal: runSignal,
          reportContext: engine._diagnosticContext(effectiveAgent),
        },
        () => engine._compactManual(effectiveAgent, runSignal, options.sourceCommandId, false, false, { manualRetry: true }),
      );
    };

    let resolveStarted;
    const startedPromise = new Promise((resolve) => {
      resolveStarted = resolve;
    });
    const runPromise = engine._trackRun(
      session,
      { trigger: 'manual', phase: 'planning' },
      (runId) => {
        resolveStarted(runId);
        return engine._runWithCancel(session, runId, options.signal, executeRetry);
      },
    );

    if (options.asyncRollingWave === true) {
      runPromise.catch(() => {});
      const runId = await startedPromise;
      return {
        accepted: true,
        alreadyRunning: false,
        completed: false,
        runId: runId ?? null,
      };
    }

    const result = await runPromise;
    return {
      accepted: true,
      alreadyRunning: false,
      completed: true,
      runId: engine.progressTracker?.snapshot?.(session.id)?.runId ?? null,
      result,
    };
  });
}
