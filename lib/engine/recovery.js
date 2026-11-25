// Transaction/journal recovery, circuit breaker state, backup restoration, and failure recording.
// All functions accept `engine` as 1st parameter and NEVER import `../engine.js`.

import { isBiliProxyResidualError } from '../bili-conflict.js';
import { continuationBudgetInfo, continuationBudgetText } from '../continuation-budget.js';
import { settleContinuation } from '../continuation-pending.js';
import {
  classifyRuntimeError,
  diagnosticFor,
  diagnosticText,
  failureExplanation,
  transferDiagnostic,
} from '../failure-diagnostics.js';
import { inspectCompactionEntryState } from '../region.js';
import { restoreSessionBackup } from '../session-backup.js';
import { sourceBreakerRecoverable } from '../source-recovery.js';
import { traceStageAsync } from '../stage-trace.js';
import {
  clearBreakerState,
  publicBreakerSummary,
  readResumableCompaction,
  writeResumableCompaction,
} from '../state.js';
import { summaryTimeoutInfo, summaryTimeoutText } from '../summary-timeout.js';
import { forgetLockedWindow } from '../window.js';
import { activeTransactions, safeGetService } from './shared.js';

export async function journalRecord(engine, session, compactionId, phase, start, end) {
  if (!engine.journal || typeof engine.journal.record !== 'function') return;
  try {
    await engine.journal.record({
      sessionId: session?.id,
      compactionId,
      phase,
      failuresBefore: engine.sessionState.read(session.id).failures,
      ...(phase === 'started' ? { startEventSeq: session.seq - 1 } : {}),
      ...(start === undefined ? {} : { startSeq: start }),
      ...(end === undefined ? {} : { endSeq: end }),
      ...(phase !== 'committing'
        ? {}
        : {
            snapshot: (session.surface?.nodes ?? []).map((seq) => ({
              seq,
              event: session.eventAt(seq),
              message: session.deriveEventMessage(session.eventAt(seq)),
            })),
          }),
    });
  } catch (error) {
    engine.log('warn', `compaction journal write failed (${phase}): ${error?.message ?? error}`);
    error.code ??= 'persistence';
    throw error;
  }
}

export async function recoverPending(engine, session, owned = false, failureKind = 'interrupted') {
  return traceStageAsync(
    'recoverPending',
    { ...(owned ? { mode: 'owned' } : {}) },
    () => engine._recoverPendingInner(session, owned, failureKind),
    (result) => ({ ok: !result?.busy, count: result?.recovered ?? 0 }),
  );
}

function reconcileStaleRunningResumable(engine, session, { journalWasCancelled, journalCountedFailure }) {
  const stale = readResumableCompaction(engine.sessionState, session.id);
  if (!stale || stale.status !== 'running') return;
  if (journalWasCancelled) {
    try {
      writeResumableCompaction(engine.sessionState, session.id, {
        ...stale,
        status: 'interrupted',
        interruptReason: 'cancelled',
        updatedAt: new Date().toISOString(),
      });
    } catch {
      /* best-effort stale running reconciliation */
    }
    return;
  }
  const nextConsecutive = (stale.consecutiveFailures ?? 0) + 1;
  const nextStatus = nextConsecutive >= engine.config.failureThreshold ? 'paused_failure' : 'interrupted';
  const crashCode = stale.lastErrorCode || 'INTERRUPTED_CRASH';
  try {
    writeResumableCompaction(engine.sessionState, session.id, {
      ...stale,
      status: nextStatus,
      interruptReason: 'crash',
      consecutiveFailures: nextConsecutive,
      lastErrorCode: crashCode,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    /* best-effort stale running reconciliation */
  }
  if (!journalCountedFailure) {
    try {
      engine.sessionState.update(session.id, (current) => {
        const failures = current.failures + 1;
        const stopped = failures >= engine.config.failureThreshold;
        const preserveRoot = current.stopped === true && Boolean(current.lastFailureCode);
        return {
          ...current,
          failures,
          stopped,
          ...(preserveRoot ? {} : { lastFailureCode: crashCode }),
        };
      });
      engine._restoreState(session);
    } catch {
      /* best-effort breaker accounting for crashed run */
    }
  }
}

export async function recoverPendingInner(engine, session, owned = false, failureKind = 'interrupted') {
  if (!session?.id || !engine.journal) return { recovered: 0 };
  if (engine.transactionAdapter?.blocked.has(session.id)) {
    const error = new Error('Session writer is quarantined; restart DSH to restore the verified transaction backup.');
    error.code = 'RECOVERY_REQUIRED';
    throw error;
  }
  const key = `${engine.sessionState.root}:${JSON.stringify(session.id)}`;
  if (!owned && activeTransactions.has(key)) return { recovered: 0, busy: true };
  if (!owned) activeTransactions.add(key);
  try {
    const pending = await engine.journal.pending(session.id);
    let recovered = 0;
    let restored = 0;
    let journalCountedFailure = false;
    let journalWasCancelled = false;
    for (const record of pending) {
      if (record.corrupt) {
        throw new Error(`compaction recovery journal is corrupt; preserved for repair: ${record.file}`);
      }
      if (record.atomic && record.phase !== 'committed' && record.atomic.restored !== true && !engine.transactionAdapter) {
        throw new Error(
          `pending compaction ${record.compactionId} has an unrecovered atomic backup; restart DSH with a compatible writer or inspect ${record.file}`,
        );
      }
      const events = Array.from({ length: session.seq }, (_, i) => session.eventAt(i));
      const start = events.find((e) => e?.type === 'compaction/start' && e.data?.compactionId === record.compactionId);
      const end = events.find((e) => e?.type === 'compaction/end' && e.data?.compactionId === record.compactionId);
      if (!start) {
        const state = inspectCompactionEntryState(session);
        if (
          record.phase === 'started' &&
          Number.isSafeInteger(record.startEventSeq) &&
          (session.firstLiveSeq ?? session.seq) <= record.startEventSeq &&
          state.unmatchedCompactionStart === null
        ) {
          await engine._flushSession(session);
          await engine.journal.clear(session.id, record.compactionId);
          continue;
        }
        throw new Error(
          `pending compaction ${record.compactionId} is absent from the loaded log; recovery requires the complete session`,
        );
      }
      if (record.phase !== 'committed' && typeof session.restoreCompactionSurface !== 'function') {
        const replacement = events.find(
          (event) =>
            event?.type === 'user/message' &&
            event.data?.source?.kind === 'compact-checkpoint' &&
            event.data.source.compactionId === record.compactionId &&
            event.surfaceOp &&
            event.surfaceOp !== 'append',
        );
        if (replacement) {
          engine._addBounded(engine._recoveryBlocked, engine._keyOf(session));
          if (!end) {
            const open = inspectCompactionEntryState(session).unmatchedCompactionStart;
            if (open === null || session.eventAt(open)?.data?.compactionId !== record.compactionId) {
              throw new Error('pending journal does not match the active compaction; refusing to close another transaction');
            }
            engine._appendSync(session, 'compaction/end', {
              ...start.data,
              error: 'Compaction failed after replacement; lifecycle closed only. Original surface is NOT restored; recovery is required.',
            });
            await engine._flushSession(session);
          }
          const reason = record.failureKind ?? failureKind;
          if (record.failureKind === undefined) {
            await engine.journal.record({ ...record, sessionId: session.id, failureKind: reason });
          }
          if (reason === 'cancelled') {
            journalWasCancelled = true;
          } else if (Number.isSafeInteger(record.failuresBefore)) {
            engine.sessionState.update(session.id, (current) => {
              const failures = Math.max(current.failures, record.failuresBefore + 1);
              return { ...current, failures, stopped: failures >= engine.config.failureThreshold };
            });
            journalCountedFailure = true;
            engine._restoreState(session);
          }
          const error = new Error(
            `compaction ${record.compactionId} changed the surface without a durable success decision; this host has no supported restoration API. Original events and recovery journal are retained; further model requests are blocked.`,
          );
          error.code = 'RECOVERY_REQUIRED';
          error.compactionStage = 'commit';
          error.compactionId = record.compactionId;
          error.replacementSeq = replacement.seq;
          error._failureRecorded = true;
          throw error;
        }
      }
      if (record.phase !== 'committed' && typeof session.restoreCompactionSurface === 'function') {
        const rolledBack = session.restoreCompactionSurface(record.compactionId, record.failureKind ?? failureKind);
        if (rolledBack) {
          restored++;
          const rbReason = rolledBack.data?.reason ?? record.failureKind ?? failureKind;
          if (rbReason === 'cancelled') {
            journalWasCancelled = true;
          } else if (Number.isSafeInteger(record.failuresBefore)) {
            engine.sessionState.update(session.id, (current) => {
              const failures = Math.max(current.failures, record.failuresBefore + 1);
              return { ...current, failures, stopped: failures >= engine.config.failureThreshold };
            });
            journalCountedFailure = true;
            engine._restoreState(session);
          }
        }
      }
      if (!end) {
        const state = inspectCompactionEntryState(session);
        const open = state.unmatchedCompactionStart;
        if (open === null || session.eventAt(open)?.data?.compactionId !== record.compactionId) {
          throw new Error('pending journal does not match the active compaction; refusing to close another transaction');
        }
        engine._appendSync(session, 'compaction/end', {
          ...start.data,
          error: `recovered interrupted compaction (${record.phase}); surface restoration ${typeof session.restoreCompactionSurface === 'function' ? 'checked through host protocol' : 'unavailable on this host'}`,
        });
        recovered++;
      }
      if (typeof engine.ctx.sessions?.flush !== 'function') {
        throw new Error('cannot clear recovery journal without a durability checkpoint');
      }
      await engine._flushSession(session);
      if (record.phase === 'committed') {
        engine.sessionState.update(session.id, (state) => clearBreakerState(state));
        engine._restoreState(session);
      }
      await engine.journal.clear(session.id, record.compactionId);
    }
    settleContinuation(engine.sessionState, session);
    if (!owned && !engine._busy.has(session) && !engine.progressTracker?.hasActiveRun?.(session.id)) {
      reconcileStaleRunningResumable(engine, session, { journalWasCancelled, journalCountedFailure });
    }
    if (restored > 0) engine._invalidateSessionMemory(session.id);
    engine._recoveryBlocked.delete(engine._keyOf(session));
    return { recovered, restored };
  } finally {
    if (!owned) activeTransactions.delete(key);
  }
}

export function restoreState(engine, session) {
  if (!session?.id) return;
  let state = engine.sessionState.read(session.id);
  const key = engine._keyOf(session);
  if (!engine._recoveryBlocked.has(key) && sourceBreakerRecoverable(session, state)) {
    const expectedFailures = state.failures;
    state = engine.sessionState.update(session.id, (current) =>
      current.stopped && current.failures === expectedFailures && !current.sourceFragmentRecovery
        ? {
            ...clearBreakerState(current),
            sourceFragmentRecovery: {
              version: 2,
              previousFailures: expectedFailures,
              at: new Date().toISOString(),
            },
          }
        : current,
    );
    if (!state.stopped) {
      engine.log(
        'info',
        'Recovered the legacy memory-source circuit breaker after verifying every surviving source; original conversation unchanged.',
      );
    }
  }
  engine._setBounded(engine._failures, key, state.failures);
  if (state.stopped) engine._setBounded(engine._stopped, key, true);
  else engine._stopped.delete(key);
  return state;
}

export async function assertNoUnrecoveredAtomicJournal(engine, session) {
  const records = await engine.journal?.pending?.(session.id);
  if (!Array.isArray(records)) return;
  for (const record of records) {
    if (record.corrupt || (record.atomic && record.phase !== 'committed' && record.atomic.restored !== true)) {
      const error = new Error('compaction recovery journal has an unrecovered atomic backup; refusing fallback modification');
      error.code = 'RECOVERY_REQUIRED';
      throw error;
    }
  }
}

export async function flushSession(engine, session) {
  const participated = await engine.ctx.sessions.flush(session);
  if (participated === false) {
    const error = new Error('compaction requires a session persistence listener; flush did not persist the session');
    error.code = 'persistence';
    throw error;
  }
  return participated;
}

export async function restoreSessionBackupFor(engine, sessionId, options = {}) {
  return engine._withConfig(async () => {
    if (typeof sessionId !== 'string' || !sessionId) {
      throw Object.assign(new Error('Restore requires a non-empty sessionId.'), { code: 'BACKUP_RESTORE_INVALID' });
    }
    const sessions = options.sessions ?? engine.ctx.sessions;
    const liveSession = typeof sessions?.get === 'function' ? sessions.get(sessionId) : null;
    if (liveSession && engine._busy.has(liveSession)) {
      throw Object.assign(new Error('Cannot restore while compaction or migration is active on this session.'), {
        code: 'busy',
      });
    }
    engine.sessionMemory?.cancel?.(sessionId);
    const backend =
      options.backend ?? engine.transactionAdapter?.backend ?? safeGetService(engine.ctx, 'sessionPersistence');
    const sessionPersistence = options.sessionPersistence ?? backend;
    const stockAdapter = options.stockAdapter ?? engine.transactionAdapter;
    return engine._trackRun(
      { id: sessionId },
      { trigger: 'restore', phase: 'restoring', overallPercent: 20 },
      async () => {
        const result = await restoreSessionBackup(engine.backupStore, {
          sessionId,
          backupId: options.backupId,
          sessions,
          backend,
          sessionPersistence,
          stockAdapter,
          stateStore: engine.sessionState,
          journal: engine.journal,
          logPath: options.logPath,
          signal: options.signal,
        });
        if (result.status === 'restored' || result.status === 'armed') {
          engine._invalidateSessionMemory(sessionId);
        }
        if (result.status === 'restored') {
          engine._failures.delete(sessionId);
          engine._stopped.delete(sessionId);
          engine._recoveryBlocked.delete(sessionId);
        }
        return result;
      },
    );
  });
}

export function clearInMemoryBreaker(engine, sessionId, session = null) {
  const id = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
  if (id) {
    engine._failures.delete(id);
    engine._stopped.delete(id);
    engine._recoveryBlocked.delete(id);
  }
  const keysToClear = [];
  if (session && typeof session === 'object') {
    keysToClear.push(session);
    const agent = engine._agentBySession?.get?.(session);
    if (agent) engine._overflowRetries.delete(agent);
    engine._overflowRetries.delete(session);
  }
  if (id) {
    for (const s of engine._failures.keys()) {
      if (s && typeof s === 'object' && s.id === id) keysToClear.push(s);
    }
    for (const s of engine._stopped.keys()) {
      if (s && typeof s === 'object' && s.id === id) keysToClear.push(s);
    }
    for (const s of engine._recoveryBlocked) {
      if (s && typeof s === 'object' && s.id === id) keysToClear.push(s);
    }
  }
  for (const s of keysToClear) {
    const mappedAgent = engine._agentBySession?.get?.(s);
    if (mappedAgent) engine._overflowRetries.delete(mappedAgent);
    const k = engine._keyOf(s);
    engine._failures.delete(k);
    engine._stopped.delete(k);
    engine._recoveryBlocked.delete(k);
  }
}

export async function resetBreakerFor(engine, sessionOrId) {
  return engine._withConfig(async () => {
    const explicitSession = sessionOrId && typeof sessionOrId === 'object' ? sessionOrId : null;
    const rawId = explicitSession ? explicitSession.id : sessionOrId;
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id) {
      throw Object.assign(new Error('sessionId is required.'), { code: 'INVALID_SESSION_ID' });
    }
    let liveSession = explicitSession;
    if (!liveSession) {
      try {
        if (typeof engine.ctx?.sessions?.get === 'function') {
          liveSession = engine.ctx.sessions.get(id);
        }
      } catch {
        liveSession = null;
      }
    }
    const transactionKey = `${engine.sessionState.root}:${JSON.stringify(id)}`;
    const isBusy =
      activeTransactions.has(transactionKey) ||
      Boolean(engine.progressTracker?.hasActiveRun?.(id)) ||
      Boolean(liveSession && engine._busy.has(liveSession)) ||
      [...engine._busy].some((s) => s?.id === id);
    if (isBusy) {
      throw Object.assign(
        new Error('Compaction or migration is currently active for this session; pause or wait for it to finish before resetting.'),
        { code: 'busy' },
      );
    }
    activeTransactions.add(transactionKey);
    try {
      if (engine.transactionAdapter?.blocked?.has?.(id)) {
        throw Object.assign(
          new Error('Session writer is quarantined; restart DSH to restore the verified transaction backup before resetting.'),
          { code: 'RECOVERY_REQUIRED' },
        );
      }
      if (engine._recoveryBlocked.has(id) || (liveSession && engine._recoveryBlocked.has(engine._keyOf(liveSession)))) {
        throw Object.assign(
          new Error('Session has an unrecovered compaction transaction; recover or restart DSH before resetting.'),
          { code: 'RECOVERY_REQUIRED' },
        );
      }
      const pending =
        engine.journal && typeof engine.journal.pending === 'function' ? await engine.journal.pending(id) : [];
      if (Array.isArray(pending) && pending.length > 0) {
        throw Object.assign(
          new Error('Pending compaction recovery journal exists for this session; recover or restart DSH before resetting.'),
          { code: 'RECOVERY_REQUIRED' },
        );
      }
      if (liveSession && typeof liveSession.eventAt === 'function') {
        const entryState = inspectCompactionEntryState(liveSession);
        if (entryState?.unmatchedCompactionStart !== null) {
          throw Object.assign(
            new Error('Session has an open compaction lifecycle event without matching compaction/end; recover before resetting.'),
            { code: 'RECOVERY_REQUIRED' },
          );
        }
      }
      const key = liveSession ? engine._keyOf(liveSession) : id;
      const prevMemFailures = Math.max(
        Number(engine._failures.get(id) ?? 0),
        Number(engine._failures.get(key) ?? 0),
      );
      const prevMemStopped = Boolean(engine._stopped.has(id) || engine._stopped.has(key));
      const res = engine.sessionState.resetBreaker(id, { rebuildOnInvalid: true });
      if (res.windowCleared || res.rebuilt) {
        forgetLockedWindow(id);
      }
      engine._clearInMemoryBreaker(id, liveSession);
      const action = engine.config?.pressureBreakerAction ?? 'confirm';
      return {
        ok: true,
        sessionId: id,
        reset: Boolean(res.reset || prevMemStopped || prevMemFailures > 0),
        rebuilt: res.rebuilt === true,
        windowCleared: Boolean(res.windowCleared || res.rebuilt),
        previousFailures: res.rebuilt ? null : Math.max(res.previousFailures ?? 0, prevMemFailures),
        wasStopped: res.rebuilt ? null : Boolean(res.wasStopped || prevMemStopped),
        ...publicBreakerSummary(res.state, action),
      };
    } finally {
      activeTransactions.delete(transactionKey);
    }
  });
}

export function setBreakerBypassFor(engine, sessionId, bypassed) {
  return engine._withConfig(() => {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) {
      throw Object.assign(new Error('sessionId is required.'), { code: 'INVALID_SESSION_ID' });
    }
    const nextBypass = Boolean(bypassed);
    const action = engine.config.pressureBreakerAction ?? 'confirm';
    if (nextBypass === true && action === 'block') {
      throw Object.assign(
        new Error('pressureBreakerAction is set to block; bypassing the circuit breaker is disabled.'),
        { code: 'BREAKER_BLOCK_POLICY' },
      );
    }
    const nextState = engine.sessionState.update(id, (current) => ({
      ...current,
      breakerBypassed: current.stopped ? nextBypass : false,
    }));
    const liveSession = typeof engine.ctx?.sessions?.get === 'function' ? engine.ctx.sessions.get(id) : null;
    if (liveSession) {
      engine._restoreState(liveSession);
    }
    return publicBreakerSummary(nextState, action);
  });
}

export function extractFailureCode(_engine, error, receipt) {
  const candidates = [];
  const seen = new Set();
  for (let e = error; e && seen.size < 8 && !seen.has(e); e = e.cause) {
    seen.add(e);
    if (typeof e?.failureCode === 'string') candidates.push(e.failureCode);
    if (typeof e?.code === 'string') candidates.push(e.code);
    if (Array.isArray(e?.failureCodes)) candidates.push(...e.failureCodes);
    if (Array.isArray(e?.failures)) {
      for (const sub of e.failures) {
        if (typeof sub?.failureCode === 'string') candidates.push(sub.failureCode);
        if (typeof sub?.code === 'string') candidates.push(sub.code);
      }
    }
    const runtimeClass = classifyRuntimeError(e);
    if (runtimeClass?.code) candidates.push(runtimeClass.code);
  }
  if (typeof receipt?.code === 'string') candidates.push(receipt.code);
  const safe = candidates
    .map((c) => (typeof c === 'string' ? c.trim() : ''))
    .filter((c) => /^[A-Za-z0-9_.-]{1,80}$/.test(c));
  return (
    safe.find(
      (c) =>
        ![
          'UNKNOWN',
          'SUMMARY_ALL_FAILED',
          'COMPACTION_AUTOMATIC_BLOCKED',
          'COMPACTION_CAPACITY_BLOCKED',
        ].includes(c),
    ) ??
    safe[0] ??
    null
  );
}

export function diagnosticReceiptFields(_engine, receipt) {
  if (!receipt || typeof receipt !== 'object') return {};
  const diagId =
    typeof receipt.id === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(receipt.id.trim()) ? receipt.id.trim() : null;
  const rawPath = receipt.status === 'saved' && typeof receipt.path === 'string' ? receipt.path : null;
  const diagPath =
    rawPath && !/[\r\n]/.test(rawPath) && rawPath.trim().length > 0 && rawPath.trim().length <= 512
      ? rawPath.trim()
      : null;
  return diagId ? { lastDiagnosticId: diagId, lastDiagnosticPath: diagPath } : {};
}

export function recordFailureDiagnostic(engine, session, receipt, error) {
  if (!session?.id || !engine.sessionState) return;
  const code = engine._extractFailureCode(error, receipt);
  const receiptFields = engine._diagnosticReceiptFields(receipt);
  if (!code && Object.keys(receiptFields).length === 0) return;
  try {
    engine.sessionState.update(session.id, (current) => {
      if (current.stopped === true && current.lastFailureCode && code === 'COMPACTION_STOPPED') {
        return current;
      }
      return {
        ...current,
        ...(code ? { lastFailureCode: code } : {}),
        ...receiptFields,
      };
    });
  } catch {
    /* best-effort diagnostic receipt recording must never mask errors */
  }
}

export function recordFailure(engine, agent, session, error) {
  if (error?.hookCancelled === true) return;
  if (isBiliProxyResidualError(error)) engine._noteBiliRuntimeSignal(session, error);
  if (error && typeof error === 'object' && (error._failureRecorded === true || error.cause?._failureRecorded === true)) {
    return;
  }
  const budget = continuationBudgetInfo(error);
  if (budget && !(budget.requestsThisAttempt > 0)) return;
  const key = engine._keyOf(session);
  engine._restoreState(session);
  const receipt = diagnosticFor(error);
  const code = engine._extractFailureCode(error, receipt);
  const receiptFields = engine._diagnosticReceiptFields(receipt);
  const state = engine.sessionState.update(session.id, (current) => {
    const failures = current.failures + 1;
    const stopped = failures >= engine.config.failureThreshold;
    const preserveRoot = current.stopped === true && Boolean(current.lastFailureCode) && code === 'COMPACTION_STOPPED';
    return {
      ...current,
      failures,
      stopped,
      ...(preserveRoot
        ? {}
        : {
            ...(code ? { lastFailureCode: code } : {}),
            ...receiptFields,
          }),
    };
  });
  try {
    if (error && typeof error === 'object') error._failureRecorded = true;
  } catch {}
  const next = state.failures;
  engine._setBounded(engine._failures, key, next);
  if (next >= engine.config.failureThreshold && !engine._stopped.has(key)) {
    engine._setBounded(engine._stopped, key, true);
    engine.log(
      'warn',
      `compaction disabled for this session after ${next} consecutive failures (last: ${error?.message ?? error}); ` +
        'automatic retries are stopped; inspect the error and retained recovery journal for commit status',
    );
  }
}

export function visibleFailure(_engine, error, prefix = '') {
  const visible = new Error(prefix + failureExplanation(error) + diagnosticText(error));
  visible.code = error?.code ?? 'COMPACTION_FAILED';
  visible.compactionStage = error?.compactionStage;
  return transferDiagnostic(error, visible);
}

export function automaticFailure(engine, session, error) {
  if (error?.code === 'COMPACTION_AUTOMATIC_BLOCKED') {
    if (diagnosticFor(error) && !error.message.includes('诊断编号：')) error.message += diagnosticText(error);
    return error;
  }
  const key = engine._keyOf(session);
  const stopped = engine._stopped.has(key);
  const code = typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'COMPACTION_FAILED';
  const timeoutText = summaryTimeoutText(error);
  const budgetText = continuationBudgetText(error);
  if (budgetText) {
    return transferDiagnostic(
      error,
      Object.assign(new Error(`${budgetText}本轮尚未发送主对话请求。${diagnosticText(error)}`), {
        code: 'COMPACTION_AUTOMATIC_BLOCKED',
        failureCode: 'CONTINUATION_CALL_BUDGET',
      }),
    );
  }
  const blocked = new Error(
    timeoutText
      ? `${timeoutText}本轮尚未发送主对话请求。${stopped ? '自动压缩已熔断。' : ''}`
      : `自动压缩未能完成，本轮已在发送模型请求前停止（${code}）。${stopped ? '自动压缩已熔断。' : ''}原始会话保留；可用 /compact 重试。`,
  );
  if (diagnosticFor(error)) {
    blocked.message =
      (timeoutText ?? failureExplanation(error)) +
      `本轮尚未发送主对话请求。${stopped ? '自动压缩已熔断。' : ''}` +
      '检查后可用 /compact 重试。' +
      diagnosticText(error);
  }
  blocked.code = 'COMPACTION_AUTOMATIC_BLOCKED';
  blocked.failureCode = code;
  if (timeoutText) {
    blocked.failureCode = 'SUMMARY_TIMEOUT';
    blocked.timeoutMs = summaryTimeoutInfo(error).timeoutMs;
  }
  return transferDiagnostic(error, blocked);
}
