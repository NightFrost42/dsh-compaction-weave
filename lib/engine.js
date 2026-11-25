// Main compaction engine coordinator delegating domain logic to acyclic `lib/engine/*` modules.
// Preserves the public 4 module exports and all WeaveCompactionEngine prototype methods.

import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { combineSignals } from './abort.js';
import {
  isBiliProxyPreflightError,
  isBiliProxyResidualError,
  isNonSnippableCompactionError,
  isWindowOverflowError,
} from './bili-conflict.js';
import { addBoundedSet, setBoundedMap } from './collections.js';
import { DEFAULT_CONFIG, resolveTargetPolicy } from './config.js';
import { FailureDiagnostics, diagnosticContext, noteDiagnosticMeasurement } from './failure-diagnostics.js';
import { isExternalFoldEvent } from './foreign-fold.js';
import { CompactionArchive } from './history.js';
import { runPostCompactHooks, runPreCompactHooks } from './hooks.js';
import { idleResumeDue } from './idle-compaction.js';
import { isUpstreamMultimodal400Error, measureVisibleImages } from './image-budget.js';
import { CompactionJournal } from './journal.js';
import { asHostManualError } from './manual-error.js';
import { ProactiveCompaction } from './proactive.js';
import { CompactionProgressTracker } from './progress-tracker.js';
import { sanitizeAdditionalContext, sanitizeFocusInstruction } from './prompt.js';
import { inspectCompactionEntryState } from './region.js';
import { SessionBackupStore, summarizeBackups } from './session-backup.js';
import { SessionMemoryManager, computeSessionMemoryPolicyFingerprint } from './session-memory.js';
import { setExternalFoldClassifier, withReferencePolicy } from './source-provenance.js';
import { isStageTraceEnabled, withStageTraceContext } from './stage-trace.js';
import { SessionStateStore, publicResumableSummary, readResumableCompaction } from './state.js';
import { summaryTimeoutInfo } from './summary-timeout.js';
import {
  compactBeforeResume,
  compactIfNeededInner,
  emergencySnip,
  idleContinuationCanShrink,
  makeAuditExhaustionFallback,
  runContextCollapse,
  splitAuditLost,
  buildProvenanceError,
  validateSessionMemoryReuse,
  audit,
} from './engine/fallback-guards.js';
import {
  adoptBiliFoldSpan,
  assertNoActiveBiliConflict,
  getBiliConflict,
  migrateBiliSession,
  noteBiliRuntimeSignal,
} from './engine/migration.js';
import {
  buildPrecomputedSliceSpec,
  buildSpanCheckpointWithMetadata,
  compactChunksConcurrent,
  compactManualInner,
  generateValidatedPrecomputedSpan,
  runContinuationWaves,
  selectContinuationWaveForSession,
  tryHierarchicalFold,
} from './engine/parallel-fold.js';
import {
  assertNoUnrecoveredAtomicJournal,
  automaticFailure,
  clearInMemoryBreaker,
  diagnosticReceiptFields,
  extractFailureCode,
  flushSession,
  journalRecord,
  recordFailure,
  recordFailureDiagnostic,
  recoverPending,
  recoverPendingInner,
  resetBreakerFor,
  restoreSessionBackupFor,
  restoreState,
  setBreakerBypassFor,
  visibleFailure,
} from './engine/recovery.js';
import {
  allowPausedBelowThreshold,
  buildProgressScope,
  computeCompressionProgress,
  discardResumableFor,
  persistResumableInterrupted,
  persistResumableRunning,
  readPendingContinuationAcceptedPages,
  resumeCompactionFor,
  retryCompactionFor,
  sourceHashForSeqs,
  syncProgressScopeAfterMask,
  validateAndAdvanceResumable,
  withProgressScope,
} from './engine/resumable.js';
import {
  activeModelSelection,
  dispatchSummaryError,
  estimateCheckpointTokens,
  guardRequestBudget,
  guardVisibleImageBudget,
  isRecoverable,
  measure,
  measureInner,
  pruneToolResults,
  reactiveRetry,
  reservedCompletionTokens,
  resolvePolicy,
  resolveSpec,
  resolveSummaryTargetsForEngine,
  resolveTargetRoute,
  restoreClaimedInput,
  shadowedTokens,
  spillTailToolOutputs,
} from './engine/routing-budget.js';
import {
  activeTransactions,
  describeResult,
  findAgentForSession,
  isAbortError,
  safeGetService,
} from './engine/shared.js';
import { compactRegionCore, compactRegionInner, compactSpan } from './engine/span-commit.js';

export {
  canonicalMessageBytes,
  compactCheckpointSource,
  isCompactCheckpointSource,
} from './engine/shared.js';

// Wire external-fold classifier at module load so standalone tests importing
// WeaveCompactionEngine also classify billion-context folds accurately.
setExternalFoldClassifier(isExternalFoldEvent);

/**
 * Stateful coordinator implementing the DSH CompactionEngine duck-type contract
 * (`compactIfNeeded`, `compactNow`, `compactRegion`) over modular `lib/engine/*` workers.
 */
export class WeaveCompactionEngine {
  /**
   * @param {object} ctx
   * @param {Readonly<Record<string, any>>} config
   */
  constructor(ctx, config) {
    this.ctx = ctx;
    this._configScope = new AsyncLocalStorage();
    this._progressScope = new AsyncLocalStorage();
    this._preStepCache = new AsyncLocalStorage();
    this._stepModelSelection = new AsyncLocalStorage();
    this.config = config;
    this.name = 'compaction';

    this._failures = new Map();
    this._overflowRetries = new WeakMap();
    this._lastTotal = new WeakMap();
    this._stopped = new Map();
    this._busy = new Set();
    this._recoveryBlocked = new Set();
    this._hostFallbackWarned = new Set();
    this._activeControllers = new Set();
    this._disposed = false;
    this._runtime = null;
    this.hookBus = null;
    this._biliRuntimeSignals = new Map();
    this._lastPostCompactHook = new Map();
    this._snipAttemptedAt = new WeakMap();
    this._agentBySession = new WeakMap();
    this._lastPriced = new WeakMap();
    this._lastPrecision = new WeakMap();
    this._lastSpec = new WeakMap();

    this.archive = new CompactionArchive({ root: config.archiveDir });
    this.diagnostics = new FailureDiagnostics(dirname(this.archive.root), {
      onFailureReceipt: (session, receipt, error) => this._recordFailureDiagnostic(session, receipt, error),
    });
    this.journal = CompactionJournal.alongside(this.archive.root);
    this.sessionState = new SessionStateStore(join(dirname(this.archive.root), 'state'));
    this.progressTracker = new CompactionProgressTracker();
    this.backupStore = SessionBackupStore.alongside(this.archive.root);
    this.proactive = new ProactiveCompaction(this);
    this.sessionMemory = new SessionMemoryManager(this);
    this.sessionMemoryWaitMs = 4000;
    this._serviceProvided = this._provideService();
    if (this._serviceProvided) {
      this._registerHooks();
    }
  }

  get config() { return this._configScope.getStore() ?? this._defaultConfig; }
  set config(value) { this._defaultConfig = value; }

  /** Refresh default config snapshot after a settings RPC save without mutating in-flight runs. */
  refreshLiveConfig() {
    if (!this.readLiveConfig) return this.config;
    const prev = this._defaultConfig;
    const next = this.readLiveConfig();
    this._defaultConfig = next;
    if (this.sessionMemory) {
      const turnedOff = prev?.sessionMemoryEnabled === true && next?.sessionMemoryEnabled !== true;
      const policyChanged =
        prev?.sessionMemoryEnabled === true &&
        next?.sessionMemoryEnabled === true &&
        computeSessionMemoryPolicyFingerprint(prev) !== computeSessionMemoryPolicyFingerprint(next);
      if (turnedOff || policyChanged) {
        const activeIds = new Set([
          ...this.sessionMemory.inFlight.keys(),
          ...this.sessionMemory._scheduling.keys(),
        ]);
        for (const sid of activeIds) this.sessionMemory.cancel(sid);
      }
    }
    return next;
  }

  /** Return sanitized, allowlisted session-memory telemetry with zero disk I/O when disabled. */
  sessionMemoryStatusFor(sessionId) {
    const cfg = this.config ?? DEFAULT_CONFIG;
    const enabled = cfg.sessionMemoryEnabled === true;
    const maxCalls = Number.isSafeInteger(cfg.sessionMemoryMaxCallsPerSession) && cfg.sessionMemoryMaxCallsPerSession >= 0
      ? cfg.sessionMemoryMaxCallsPerSession
      : DEFAULT_CONFIG.sessionMemoryMaxCallsPerSession;
    const id = typeof sessionId === 'string' ? sessionId : '';
    if (!enabled || !this.sessionMemory || !id) {
      return {
        enabled,
        ready: false,
        updating: Boolean(id && this.sessionMemory?.inFlight?.has(id)),
        coveredNodes: 0,
        coveredThroughSeq: null,
        updatedAt: null,
        callsUsed: 0,
        totalCallsUsed: 0,
        maxCalls,
      };
    }
    return this.sessionMemory.status(id, cfg);
  }

  _scheduleSessionMemory(session, agent = null, measurement = null) {
    if (!this.sessionMemory || !session || typeof session.id !== 'string' || !session.id) return null;
    if (this.config?.sessionMemoryEnabled !== true) return null;
    if (this._busy.has(session) || this._stopped.has(this._keyOf(session))) return null;
    if (this.progressTracker?.hasActiveRun?.(session.id)) return null;
    try {
      const entryState = inspectCompactionEntryState(session);
      if (
        entryState.unmatchedCompactionStart !== null &&
        (entryState.latestEndSeedSeq === null || entryState.unmatchedCompactionStart > entryState.latestEndSeedSeq)
      ) {
        return null;
      }
      const effectiveAgent = agent ?? this._resolveLiveAgent(session) ?? { session, options: {} };
      const promise = this._withConfig(() => {
        const policy = this._resolvePolicy(effectiveAgent);
        if (policy?.sessionMemoryEnabled !== true) return null;
        return this.sessionMemory.maybeSchedule({
          session,
          agent: effectiveAgent,
          ...(measurement ? { measurement } : {}),
          policy,
        });
      });
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
      return promise;
    } catch {
      return null;
    }
  }

  _invalidateSessionMemory(sessionId) {
    if (!this.sessionMemory || typeof sessionId !== 'string' || !sessionId) return false;
    this.sessionMemory.cancel(sessionId);
    try {
      const store = this.sessionMemory._store();
      if (!existsSync(store.file(sessionId))) return false;
      return this.sessionMemory.clear(sessionId, { keepBillingCounter: true });
    } catch {
      return false;
    }
  }

  /** Reset current-cycle session-memory billing counter after a Weave or fold-adopt commit. */
  _resetSessionMemoryCycle(sessionId) {
    if (!this.sessionMemory || typeof sessionId !== 'string' || !sessionId) return false;
    this.sessionMemory.cancel(sessionId);
    try {
      const store = this.sessionMemory._store();
      if (!existsSync(store.file(sessionId))) return false;
      return this.sessionMemory.resetCycle(sessionId);
    } catch {
      return false;
    }
  }

  /** Wait briefly for a compatible in-flight background session memory refresh before compaction. */
  async _awaitOrCancelSessionMemory(session, policy, signal, options = {}) {
    const sessionId = session?.id;
    if (!this.sessionMemory || typeof sessionId !== 'string' || !sessionId) return { status: 'none' };
    const focusText = sanitizeFocusInstruction(options.focusInstruction ?? '');
    const hookAdditionalText = sanitizeAdditionalContext(options.additionalContext ?? '');
    const eligible =
      policy?.sessionMemoryEnabled === true &&
      !options.precomputed &&
      !options.continuation &&
      !options.allowForeignFallback &&
      !options.snip &&
      options.trigger !== 'context-overflow' &&
      options.progressPhase !== 'folding' &&
      focusText.length === 0 &&
      hookAdditionalText.length === 0;
    if (!eligible) {
      this.sessionMemory.cancel(sessionId);
      return { status: 'ineligible' };
    }
    if (!this.sessionMemory.inFlight?.has?.(sessionId)) {
      this.sessionMemory.cancel(sessionId);
      return { status: 'none' };
    }
    this._trackUpdate(session, { phase: 'planning' });
    const timeoutMs = Number.isFinite(this.sessionMemoryWaitMs) && this.sessionMemoryWaitMs >= 0
      ? this.sessionMemoryWaitMs
      : 4000;
    const outcome = await this.sessionMemory.waitForWithin(sessionId, {
      timeoutMs,
      signal,
      policy,
      expectedStartSeq: options.expectedStartSeq,
      session,
    });
    if (outcome.status !== 'completed') this.sessionMemory.cancel(sessionId);
    return outcome;
  }

  _trackRun(session, meta, fn) {
    const sessionId = typeof session === 'string' ? session : session?.id;
    if (!this.progressTracker || typeof sessionId !== 'string' || !sessionId) return fn(null);
    return this.progressTracker.withRun(sessionId, meta, fn);
  }

  _trackUpdate(session, patch, options = {}) {
    const sessionId = typeof session === 'string' ? session : session?.id;
    if (!this.progressTracker || typeof sessionId !== 'string' || !sessionId) return false;
    return this.progressTracker.update(sessionId, patch, options);
  }

  _trackStream(session, streamPatch) {
    const sessionId = typeof session === 'string' ? session : session?.id;
    if (!this.progressTracker || typeof sessionId !== 'string' || !sessionId) return false;
    return this.progressTracker.updateStream(sessionId, streamPatch);
  }

  _emitAuxUsage(session, usage) {
    if (!usage || typeof usage !== 'object') return false;
    const patch = {};
    if (Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0) patch.auxInputTokens = Math.floor(usage.inputTokens);
    if (Number.isFinite(usage.reasoningTokens) && usage.reasoningTokens >= 0) patch.auxReasoningTokens = Math.floor(usage.reasoningTokens);
    const cacheRead = usage.cacheReadTokens ?? usage.cachedInputTokens;
    if (Number.isFinite(cacheRead) && cacheRead >= 0) patch.auxCacheReadTokens = Math.floor(cacheRead);
    const cacheWrite = usage.cacheWriteTokens ?? usage.cacheCreationTokens ?? usage.cacheCreationInputTokens;
    if (Number.isFinite(cacheWrite) && cacheWrite >= 0) patch.auxCacheWriteTokens = Math.floor(cacheWrite);
    if (Object.keys(patch).length === 0) return false;
    return this._trackUpdate(session, patch, { accumulateAuxUsage: true });
  }

  _emitReinjectMeasured(session, info) {
    if (!info || typeof info !== 'object') return;
    const reinjectFiles = Number.isSafeInteger(info.reinjectFiles) && info.reinjectFiles >= 0 ? info.reinjectFiles : 0;
    const reinjectBytes = Number.isSafeInteger(info.reinjectBytes) && info.reinjectBytes >= 0 ? info.reinjectBytes : 0;
    const effectiveReinjectMaxBytes =
      Number.isSafeInteger(info.effectiveReinjectMaxBytes) && info.effectiveReinjectMaxBytes >= 0
        ? info.effectiveReinjectMaxBytes
        : 0;
    this._trackUpdate(session, { reinjectFiles, reinjectBytes });
    noteDiagnosticMeasurement({ reinjectFiles, reinjectBytes, effectiveReinjectMaxBytes }, { stage: 'reinject' });
  }

  _getBudgetSpec(session, explicitSpec = null) {
    if (explicitSpec !== undefined && explicitSpec !== null) return explicitSpec;
    return session && typeof session === 'object' ? (this._lastSpec?.get(session) ?? null) : null;
  }

  listSessionBackupsFor(sessionId) { return this.backupStore.list(sessionId); }
  summarizeBackupsFor(sessionId) { return summarizeBackups(this.backupStore, sessionId); }

  cancelActiveCompactionFor(sessionId, reason) {
    if (!this.progressTracker || typeof this.progressTracker.cancelRun !== 'function') {
      return { cancelled: false, runId: null };
    }
    return this.progressTracker.cancelRun(sessionId, reason);
  }

  discardResumableFor(sessionId) { return discardResumableFor(this, sessionId); }
  _readPendingContinuationAcceptedPages(session, pendingContinuation) { return readPendingContinuationAcceptedPages(this, session, pendingContinuation); }
  async _allowPausedBelowThreshold(agent, error, signal) { return allowPausedBelowThreshold(this, agent, error, signal); }

  async _runPreCompactHook({
    session,
    trigger,
    manual,
    focusInstruction = '',
    totalTokens = null,
    range = null,
    continuation = false,
    signal,
  }) {
    const userFocus = sanitizeFocusInstruction(focusInstruction ?? '');
    const preHook = await runPreCompactHooks(
      this.ctx,
      {
        sessionId: session.id,
        trigger,
        manual: Boolean(manual),
        focusInstruction: userFocus,
        totalTokens: Number.isFinite(totalTokens) ? totalTokens : null,
        range: range ? { start: range.start, end: range.end } : null,
        continuation: Boolean(continuation),
      },
      {
        bus: this.hookBus ?? this._runtime?.hookBus ?? undefined,
        signal,
        log: (lvl, msg) => this.log(lvl, msg),
      },
    );
    if (preHook.cancelled) {
      const reason = preHook.reason || 'cancelled by weave/pre-compact hook';
      if (!manual) {
        this.log('info', `${trigger} compaction skipped by weave/pre-compact hook: ${reason}`);
        return { cancelled: true, reason, userFocus, effectiveFocus: userFocus, softenCoverageForFocus: false };
      }
      throw Object.assign(
        new Error(`compaction cancelled by weave/pre-compact hook: ${reason}`),
        { code: 'cancelled', hookCancelled: true, hookReason: reason, userCancelled: true },
      );
    }
    const effectiveFocus = sanitizeFocusInstruction([userFocus, preHook.focusInstruction].filter(Boolean).join(' | '));
    const additionalContext = sanitizeAdditionalContext(preHook.additionalContext ?? '');
    return {
      cancelled: false,
      reason: null,
      userFocus,
      effectiveFocus,
      additionalContext,
      softenCoverageForFocus: Boolean(manual && userFocus.length > 0),
    };
  }

  async _runPostCompactHook({ session, trigger, manual, focusInstruction = '', result, signal }) {
    if (!result || !session?.id) return { notices: [], warnings: [] };
    try {
      const compactionIds = Array.isArray(result.compactionIds) && result.compactionIds.length > 0
        ? result.compactionIds
        : (result.compactionId ? [result.compactionId] : []);
      const hookRes = await runPostCompactHooks(
        this.ctx,
        {
          sessionId: session.id,
          trigger,
          manual: Boolean(manual),
          focusInstruction: sanitizeFocusInstruction(focusInstruction ?? ''),
          compactionId: result.compactionId ?? compactionIds[0] ?? null,
          compactionIds,
          shadowedTokenCount: Number.isFinite(result.shadowedTokenCount) ? result.shadowedTokenCount : null,
          summarySeq: result.summarySeq ?? result.replacementSeq ?? null,
        },
        {
          bus: this.hookBus ?? this._runtime?.hookBus ?? undefined,
          signal,
          log: (lvl, msg) => this.log(lvl, msg),
        },
      );
      const notices = Array.isArray(hookRes?.notices) ? hookRes.notices.filter((n) => typeof n === 'string' && n.length > 0) : [];
      const warnings = Array.isArray(hookRes?.warnings) ? hookRes.warnings.filter((w) => typeof w === 'string' && w.length > 0) : [];
      for (const notice of notices) {
        const singleLine = notice.replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
        if (singleLine) this.log('info', `weave/post-compact notice (${trigger}): ${singleLine}`);
      }
      if (typeof result === 'object' && !Object.isFrozen(result)) {
        if (notices.length > 0) result.hookNotices = notices;
        if (warnings.length > 0) result.hookWarnings = warnings;
      }
      if (notices.length > 0 || warnings.length > 0) {
        this._setBounded(this._lastPostCompactHook, session.id, {
          compactionId: result.compactionId ?? compactionIds[0] ?? null,
          trigger,
          notices,
          warnings,
          at: new Date().toISOString(),
        });
      }
      return { notices, warnings };
    } catch {
      return { notices: [], warnings: [] };
    }
  }

  async _runWithCancel(session, runId, callerSignal, fn) {
    if (this._disposed) throw Object.assign(new Error('compaction engine disposed'), { code: 'cancelled' });
    const controller = new AbortController();
    this._activeControllers.add(controller);
    const merged = combineSignals([callerSignal, controller.signal]);
    const sessionId = typeof session === 'string' ? session : session?.id;
    if (sessionId && runId && typeof this.progressTracker?.registerCancel === 'function') {
      this.progressTracker.registerCancel(sessionId, runId, controller);
    }
    try {
      return await fn(merged.signal, controller);
    } finally {
      this._activeControllers.delete(controller);
      merged.dispose();
    }
  }

  async _runWithActiveSignal(externalSignal, fn) {
    if (this._disposed) throw Object.assign(new Error('compaction engine disposed'), { code: 'cancelled' });
    const controller = new AbortController();
    this._activeControllers.add(controller);
    const merged = combineSignals([externalSignal, controller.signal]);
    try {
      return await fn(merged.signal);
    } finally {
      this._activeControllers.delete(controller);
      merged.dispose();
    }
  }

  _resolveLiveAgent(session, explicitAgent = null) {
    if (explicitAgent) return explicitAgent;
    if (!session) return null;
    const cached = this._agentBySession.get(session);
    if (cached) return cached;
    const agents = safeGetService(this.ctx, 'agents');
    if (!agents) return null;
    if (typeof agents.get === 'function') {
      const found = agents.get(session.id) ?? agents.get(session);
      if (found) { this._agentBySession.set(session, found); return found; }
    }
    if (typeof agents.forSession === 'function') {
      const found = agents.forSession(session.id) ?? agents.forSession(session);
      if (found) { this._agentBySession.set(session, found); return found; }
    }
    const iter = typeof agents.values === 'function' ? agents.values() : Array.isArray(agents) ? agents : null;
    if (iter) {
      for (const candidate of iter) {
        if (candidate?.session === session || (session.id && candidate?.session?.id === session.id)) {
          this._agentBySession.set(session, candidate);
          return candidate;
        }
      }
    }
    return null;
  }

  _sourceHashForSeqs(session, seqs) { return sourceHashForSeqs(this, session, seqs); }
  _validateAndAdvanceResumable(session, rawJob) { return validateAndAdvanceResumable(this, session, rawJob); }
  _persistResumableRunning(session, job) { return persistResumableRunning(this, session, job); }
  _persistResumableInterrupted(session, job, error, signal, opts = {}) { return persistResumableInterrupted(this, session, job, error, signal, opts); }
  _buildProgressScope(session, targetSeqs, opts = {}) { return buildProgressScope(this, session, targetSeqs, opts); }
  _withProgressScope(session, targetSeqs, opts, fn) { return withProgressScope(this, session, targetSeqs, opts, fn); }
  _syncProgressScopeAfterMask(scope, session, nextTargetSeqs, maskedTokensSaved = 0) { return syncProgressScopeAfterMask(this, scope, session, nextTargetSeqs, maskedTokensSaved); }
  _computeCompressionProgress(session, shadowedSeqs = [], activeSubFraction = 0, opts = {}) { return computeCompressionProgress(this, session, shadowedSeqs, activeSubFraction, opts); }

  _withConfig(operation, onConfigError) {
    if (this._configScope.getStore()) return operation();
    if (!this.readLiveConfig) return withReferencePolicy(this.config, operation);
    let config;
    try { config = this.readLiveConfig(); }
    catch (error) { onConfigError?.(error); throw error; }
    this.config = config;
    return this._configScope.run(config, () => withReferencePolicy(config, operation));
  }

  /** Clear in-memory controllers and caches when unloading the plugin. */
  dispose() {
    this._disposed = true;
    const disposeReason = new Error('compaction engine disposed');
    for (const controller of [...this._activeControllers]) {
      try { controller.abort(disposeReason); } catch {}
    }
    this._activeControllers.clear();
    this.proactive.dispose();
    this.sessionMemory?.dispose?.();
    this._busy.clear();
    this._recoveryBlocked.clear();
    this._stopped.clear();
    this._failures.clear();
    this._biliRuntimeSignals.clear();
    this._hostFallbackWarned.clear();
    this._lastPostCompactHook.clear();
    this._snipAttemptedAt = new WeakMap();
    this._overflowRetries = new WeakMap();
    this._lastTotal = new WeakMap();
    this._lastPriced = new WeakMap();
    this._lastPrecision = new WeakMap();
    this._lastSpec = new WeakMap();
    this._agentBySession = new WeakMap();
  }

  _setBounded(map, key, value, maxSize = 512) { return setBoundedMap(map, key, value, maxSize); }
  _addBounded(set, key, maxSize = 512) { return addBoundedSet(set, key, maxSize); }

  _keyOf(session) {
    const id = session?.id;
    return typeof id === 'string' && id.length > 0 ? id : session;
  }

  _noteBiliRuntimeSignal(session, error) { return noteBiliRuntimeSignal(this, session, error); }
  _getBiliConflict(session) { return getBiliConflict(this, session); }
  _assertNoActiveBiliConflict(session, trigger = 'compaction') { return assertNoActiveBiliConflict(this, session, trigger); }

  _provideService() {
    const ctx = this.ctx;
    try {
      if (typeof ctx.provide === 'function') { ctx.provide('compaction', this); return true; }
      if (typeof ctx.reflect?.provide === 'function') { ctx.reflect.provide('compaction', this); return true; }
      this.log('warn', 'ctx.provide is unavailable; the compaction service was not registered');
      return true;
    } catch (error) {
      this.log('warn', `compaction service registration skipped: ${error?.message ?? error}`);
      return false;
    }
  }

  _registerHooks() {
    const ctx = this.ctx;
    if (typeof ctx.on !== 'function') {
      this.log('warn', 'ctx.on is unavailable; compaction lifecycle hooks will not be registered');
      return;
    }
    this._registerPreStepHook(ctx);
    this._registerSessionLifecycleHooks(ctx);
    this._registerRequestErrorHook(ctx);
  }

  _registerPreStepHook(ctx) {
    ctx.on('agent/pre-step', (payload, next) => this._withConfig(async () => {
      const agent = payload?.agent;
      const signal = payload?.signal;
      if (agent?.session) this._agentBySession.set(agent.session, agent);
      if (agent && signal && !signal.aborted) {
        const rawSel = payload?.modelSelection;
        const hasStepSel =
          rawSel &&
          typeof rawSel === 'object' &&
          typeof rawSel.provider === 'string' &&
          rawSel.provider.trim().length > 0 &&
          typeof rawSel.model === 'string' &&
          rawSel.model.trim().length > 0;
        const runStepScoped = (fn) =>
          hasStepSel ? this._stepModelSelection.run({ agent, session: agent?.session, selection: rawSel }, fn) : fn();
        await runStepScoped(async () => {
          try {
            await this.recoverPending(agent.session);
          } catch (error) {
            const blocked = new Error(`compaction recovery must complete before another model request: ${error?.message ?? error}`);
            blocked.code = 'RECOVERY_REQUIRED';
            blocked.compactionStage = 'commit';
            blocked.cause = error;
            this._restoreClaimedInput(agent, payload.messages);
            await this.diagnostics.capture(agent.session, blocked, { trigger: 'recovery', reportContext: this._diagnosticContext(agent) });
            throw this._visibleFailure(blocked);
          }
          await this._preStepCache.run({ measures: new Map(), specs: new Map() }, async () => {
            try {
              let handledResumableStep = false;
              let skipPressureIfBelowThreshold = false;
              const pendingResumable = readResumableCompaction(this.sessionState, agent.session.id);
              if (pendingResumable) {
                const summary = publicResumableSummary(pendingResumable);
                if (summary?.canAutoResume) {
                  try {
                    const resumed = await this.diagnostics.run(
                      agent.session,
                      { trigger: 'resume', signal, reportContext: this._diagnosticContext(agent) },
                      () => this.resumeCompactionFor(agent.session, { agent, signal, insidePreStep: true, allowPolicyRestart: true }),
                    );
                    if (resumed !== null) {
                      handledResumableStep = true;
                      this.log('info', `auto-resumed interrupted compaction before step: ${describeResult(resumed)}`);
                    }
                  } catch (resumeError) {
                    if (await this._allowPausedBelowThreshold(agent, resumeError, signal)) {
                      handledResumableStep = true;
                      skipPressureIfBelowThreshold = true;
                    } else {
                      throw resumeError;
                    }
                  }
                } else if (pendingResumable.status === 'paused_budget' || pendingResumable.status === 'paused_failure') {
                  handledResumableStep = true;
                  skipPressureIfBelowThreshold = true;
                }
              }
              if (!handledResumableStep) {
                await this._spillTailToolOutputs(agent, signal);
                await this._guardVisibleImageBudget(agent, signal);
              }
              const proactive = handledResumableStep
                ? null
                : await this.diagnostics.run(agent.session, { trigger: 'proactive', signal, reportContext: this._diagnosticContext(agent) }, () => this.proactive.consume(agent, signal, payload.messages));
              const checkPressure = !proactive || ['skipped', 'cancelled'].includes(proactive.status);
              const idle = !handledResumableStep && checkPressure ? await this._compactBeforeResume(agent, signal, payload.messages) : null;
              const idleSkippedByBreaker =
                idle === null &&
                !handledResumableStep &&
                checkPressure &&
                this.config.idleCompactionMinutes > 0 &&
                this._stopped.has(this._keyOf(agent.session)) &&
                Boolean(idleResumeDue(agent.session, payload.messages, this.config.idleCompactionMinutes));
              let result = null;
              if (checkPressure && this.config.auto) {
                let skipPressure = false;
                if (skipPressureIfBelowThreshold) {
                  const preMeasure = await this._measure(agent.session);
                  const preSpec = preMeasure ? await this._resolveSpec(agent, preMeasure, signal).catch(() => null) : null;
                  if (preMeasure && preSpec && Number.isFinite(preSpec.thresholdTokens) && preMeasure.totalTokens < preSpec.thresholdTokens) {
                    skipPressure = true;
                    this.log('warn', `skipping automatic pressure compaction while ${pendingResumable.status} below threshold (${preMeasure.totalTokens} < ${preSpec.thresholdTokens})`);
                  }
                }
                if (!skipPressure) {
                  try {
                    result = await this.compactIfNeeded(agent, 'pressure', signal);
                  } catch (pressureError) {
                    this._noteBiliRuntimeSignal(agent.session, pressureError);
                    if (!(await this._allowPausedBelowThreshold(agent, pressureError, signal))) {
                      let rescuedBySnip = false;
                      if (!isAbortError(pressureError, signal) && !isNonSnippableCompactionError(pressureError)) {
                        const fresh = await this._measure(agent.session);
                        const freshSpec = fresh ? await this._resolveSpec(agent, fresh, signal).catch(() => null) : null;
                        if (fresh && freshSpec && Number.isFinite(freshSpec.messageBudgetTokens) && fresh.totalTokens >= Math.floor(freshSpec.messageBudgetTokens * 0.95)) {
                          const snipped = await this._emergencySnip(agent, freshSpec, signal, 'pressure-wall');
                          if (snipped) {
                            const afterSnip = await this._measure(agent.session);
                            if (afterSnip && afterSnip.totalTokens < freshSpec.messageBudgetTokens) {
                              rescuedBySnip = true;
                              this.log('warn', `pressure compaction failed (${pressureError?.code ?? 'error'}); emergency snip rescued context to ${afterSnip.totalTokens}/${freshSpec.messageBudgetTokens} tok`);
                            }
                          }
                        }
                      }
                      if (!rescuedBySnip) throw pressureError;
                    }
                  }
                }
              }
              if (result) this.log('info', `pressure compaction done: ${describeResult(result)}`);
              if (this.config.auto || idle || idleSkippedByBreaker) await this._guardRequestBudget(agent, signal, this.config.auto);
              signal.throwIfAborted?.();
            } catch (error) {
              if (!isAbortError(error, signal)) await this.diagnostics.capture(agent.session, error, { trigger: 'automatic', reportContext: this._diagnosticContext(agent) });
              if (summaryTimeoutInfo(error)) { this._restoreClaimedInput(agent, payload.messages); throw this._automaticFailure(agent.session, error); }
              if (['RECOVERY_REQUIRED', 'COMPACTION_CAPACITY_BLOCKED'].includes(error?.code)) { this._restoreClaimedInput(agent, payload.messages); throw this._visibleFailure(error); }
              if (isAbortError(error, signal)) { this._restoreClaimedInput(agent, payload.messages); throw error; }
              this.log('warn', `step compaction failed: ${error?.message ?? error}; stopping before the model request`);
              this._restoreClaimedInput(agent, payload.messages);
              throw this._automaticFailure(agent.session, error);
            }
          });
        });
      }
      return next();
    }, () => this._restoreClaimedInput(payload?.agent, payload?.messages)));
  }

  _registerSessionLifecycleHooks(ctx) {
    ctx.on('agent/status', (payload) => {
      const agent = payload?.agent;
      if (!agent) return;
      if (agent.session) this._agentBySession.set(agent.session, agent);
      if (payload.status === 'running') {
        const session = agent.session;
        const transactionKey = session?.id ? `${this.sessionState.root}:${JSON.stringify(session.id)}` : null;
        if ((session && this._busy.has(session)) || (transactionKey && activeTransactions.has(transactionKey))) {
          agent.cancel(
            { kind: 'hook', reason: 'Compaction or migration is currently in progress; queued input will run once it finishes.' },
            { keepInbox: true },
          );
          this.log('warn', 'Active compaction or migration blocks a racing turn; input remains queued.');
          return;
        }
        const { unmatchedCompactionStart: open, latestEndSeedSeq } = inspectCompactionEntryState(session);
        const ownOpen =
          open !== null &&
          (latestEndSeedSeq === null || open > latestEndSeedSeq) &&
          String(session.eventAt(open)?.data?.compactionId ?? '').startsWith('weave-');
        if (this._recoveryBlocked.has(this._keyOf(session)) || ownOpen) {
          agent.cancel({ kind: 'hook', reason: 'Compaction recovery must complete before another turn. Use /compact to inspect recovery.' }, { keepInbox: true });
          this.log('warn', 'Pending compaction blocks a new turn; input remains queued. Recovery journal is retained.');
        }
      } else if (payload.status === 'idle') {
        this._overflowRetries.delete(agent);
        if (agent.session) this._scheduleSessionMemory(agent.session, agent);
      }
    });

    ctx.on('agent/post-step', (payload) => {
      const agent = payload?.agent;
      const session = payload?.session ?? agent?.session;
      if (agent?.session) this._agentBySession.set(agent.session, agent);
      if (session) this._scheduleSessionMemory(session, agent ?? null);
    });

    ctx.on('session/event', (session, event) => {
      if (!session || !event) return;
      if (event.type === 'assistant/message') {
        const agent = this._agentBySession.get(session);
        if (agent) this._overflowRetries.delete(agent);
        return;
      }
      if (
        (event.surfaceOp && event.surfaceOp !== 'append') ||
        event.type === 'image/offload' ||
        event.type === 'session/restored' ||
        event.type === 'session/reset'
      ) {
        this._invalidateSessionMemory(session.id);
        if (event.type === 'image/offload') this._lastTotal.delete(session);
        return;
      }
      if (
        event.type === 'step/end' ||
        (event.type === 'turn/end' && !['error', 'cancelled'].includes(event.data?.reason?.kind))
      ) {
        this._scheduleSessionMemory(session, this._agentBySession.get(session) ?? null);
      }
    });

    ctx.on('session/disposed', (payload) => {
      const sessionObj =
        payload && typeof payload === 'object' && payload.session && typeof payload.session === 'object'
          ? payload.session
          : payload && typeof payload === 'object' && !('sessionId' in payload)
            ? payload
            : null;
      const rawId =
        typeof payload === 'string'
          ? payload
          : (payload?.sessionId ?? sessionObj?.id ?? payload?.id ?? null);
      const sid = typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim() : null;
      const key = sid ?? (sessionObj ? this._keyOf(sessionObj) : null);
      for (const k of [key, sessionObj].filter((v) => v !== null && v !== undefined)) {
        this._failures.delete(k);
        this._stopped.delete(k);
        this._recoveryBlocked.delete(k);
        this._hostFallbackWarned.delete(k);
        this._biliRuntimeSignals.delete(k);
        this._lastPostCompactHook.delete(k);
      }
      if (sessionObj) {
        const mappedAgent = this._agentBySession.get(sessionObj);
        if (mappedAgent) this._overflowRetries?.delete?.(mappedAgent);
        this._busy.delete(sessionObj);
        this._agentBySession.delete(sessionObj);
        this._lastSpec?.delete?.(sessionObj);
        this._lastTotal?.delete?.(sessionObj);
        this._lastPriced?.delete?.(sessionObj);
        this._lastPrecision?.delete?.(sessionObj);
        this._overflowRetries?.delete?.(sessionObj);
        this._snipAttemptedAt?.delete?.(sessionObj);
      }
      if (sid && this.sessionMemory) {
        this.sessionMemory.cancel?.(sid);
        this.sessionMemory.lastRunAt?.delete?.(sid);
      }
    });

    ctx.on('compaction/summary-error', (payload, next) => this._withConfig(async () => {
      const session = payload?.session;
      if (!session) return next();
      if (['SUMMARY_TIMEOUT', 'SUMMARY_ALL_FAILED', 'IMAGE_OFFLOAD_REQUIRED'].includes(payload?.error?.code)) {
        return next();
      }
      const agent = findAgentForSession(this, session);
      if (!agent) return next();
      try {
        const retried = await this._reactiveRetry(agent, payload?.signal);
        return retried === true;
      } catch (error) {
        this.log('warn', `reactive compaction retry failed: ${error?.message ?? error}`);
        return next();
      }
    }));
  }

  _registerRequestErrorHook(ctx) {
    ctx.on('agent/request-error', (payload, next) => this._withConfig(async () => {
      const agent = payload?.agent;
      const failure = payload?.failure;
      const signal = payload?.signal;
      if (!agent || signal?.aborted) return next();
      if (isBiliProxyPreflightError(failure)) {
        const conflictError = Object.assign(
          new Error(
            `billion-context local proxy preflight rejected the request (${failure?.message ?? 'preflight_compress_failed'}); ` +
            'disable billion-context, restore your provider baseUrl, and fully restart DSH.',
          ),
          { code: 'BILI_PROXY_CONFLICT', failureCode: 'BILI_PROXY_CONFLICT', cause: failure },
        );
        this._noteBiliRuntimeSignal(agent.session, conflictError);
        await this.diagnostics.capture(agent.session, conflictError, {
          trigger: 'context-overflow',
          reportContext: this._diagnosticContext(agent),
        });
        this._recordFailure(agent, agent.session, conflictError);
        throw this._visibleFailure(conflictError);
      }
      const isOverflow = isWindowOverflowError(failure);
      const isMultimodal400 = !isOverflow && isUpstreamMultimodal400Error(failure);
      if (!isOverflow && !isMultimodal400) return next();
      if (!this.config.auto) return next();

      const target = this._resolveTargetRoute(agent, { preferRequestHeader: true });
      const policy = resolveTargetPolicy(this.config, target.provider, target.model);
      const retries = this._overflowRetries.get(agent) ?? 0;
      if (retries >= policy.maxOverflowRetries) return next();

      if (isMultimodal400) {
        const imgStats = measureVisibleImages(agent.session);
        if (imgStats.visibleImageCount <= 0) return next();
        const offloaded = await this._guardVisibleImageBudget(agent, signal, {
          force: true,
          keepHotImages: Math.min(1, Math.max(0, imgStats.visibleImageCount - 1)),
        }).catch(() => null);
        if (signal?.aborted) return next();
        const afterImgStats = measureVisibleImages(agent.session);
        if (offloaded && afterImgStats.visibleImageCount < imgStats.visibleImageCount) {
          this._overflowRetries.set(agent, retries + 1);
          return { kind: 'retry' };
        }
        try {
          const genBefore = agent.session?.surface?.replaceGeneration ?? 0;
          const res = await this.compactIfNeeded(agent, 'context-overflow', signal);
          if (signal?.aborted) return next();
          if ((agent.session?.surface?.replaceGeneration ?? 0) > genBefore || res !== null) {
            this._overflowRetries.set(agent, retries + 1);
            return { kind: 'retry' };
          }
        } catch {
          return next();
        }
        return next();
      }

      const generation = agent.session?.surface?.replaceGeneration ?? 0;
      let snipAttempted = false;
      const tryOverflowSnip = async () => {
        if (snipAttempted || signal?.aborted) return false;
        snipAttempted = true;
        const fresh = await this._measure(agent.session).catch(() => null);
        const overflowSpec = fresh ? await this._resolveSpec(agent, fresh, signal).catch(() => null) : null;
        if (!overflowSpec) return false;
        const snipped = await this._emergencySnip(agent, overflowSpec, signal, 'context-overflow');
        return Boolean(snipped && (agent.session?.surface?.replaceGeneration ?? 0) > generation);
      };
      try {
        const result = await this.compactIfNeeded(agent, 'context-overflow', signal);
        if (signal?.aborted) return next();
        const advanced = (agent.session?.surface?.replaceGeneration ?? 0) > generation;
        if (!advanced && result === null) {
          if (await tryOverflowSnip()) {
            this._overflowRetries.set(agent, retries + 1);
            return { kind: 'retry' };
          }
          return next();
        }
        this._overflowRetries.set(agent, retries + 1);
        return { kind: 'retry' };
      } catch (error) {
        if (signal?.aborted || isAbortError(error, signal)) return next();
        if (isBiliProxyResidualError(error)) this._noteBiliRuntimeSignal(agent.session, error);
        await this.diagnostics.capture(agent.session, error, {
          trigger: 'context-overflow',
          reportContext: this._diagnosticContext(agent),
        });
        if (error?.code === 'RECOVERY_REQUIRED') throw this._visibleFailure(error);
        if (!signal?.aborted && !error?.surfaceRestored && (agent.session?.surface?.replaceGeneration ?? 0) > generation) {
          this.log('warn', `context-overflow compaction failed after in-memory surface replacement: ${error?.message ?? error}; retrying from the replacement surface`);
          this._overflowRetries.set(agent, retries + 1);
          return { kind: 'retry' };
        }
        if (!snipAttempted && !isNonSnippableCompactionError(error)) {
          try {
            if (await tryOverflowSnip()) {
              this._overflowRetries.set(agent, retries + 1);
              return { kind: 'retry' };
            }
          } catch (snipError) {
            if (signal?.aborted || isAbortError(snipError, signal)) return next();
            if (snipError?.surfaceMutated && (agent.session?.surface?.replaceGeneration ?? 0) > generation) {
              this.log('warn', `context-overflow emergency snip failed after surface replacement: ${snipError?.message ?? snipError}`);
              throw this._visibleFailure(snipError, '上下文超限后的压缩补救未完成。');
            }
            this.log('warn', `context-overflow emergency snip failed: ${snipError?.message ?? snipError}`);
          }
        }
        if (error?.code === 'COMPACTION_CAPACITY_BLOCKED') throw this._visibleFailure(error);
        this.log('warn', `context-overflow compaction failed: ${error?.message ?? error}`);
        throw this._visibleFailure(error, '上下文超限后的压缩补救未完成。');
      }
    }));
  }

  async _reactiveRetry(agent, signal) { return reactiveRetry(this, agent, signal); }
  _restoreClaimedInput(agent, messages) { return restoreClaimedInput(this, agent, messages); }
  failureForCommand(session, commandId) { return this.diagnostics.forCommand(session, commandId); }
  _visibleFailure(error, prefix = '') { return visibleFailure(this, error, prefix); }
  _automaticFailure(session, error) { return automaticFailure(this, session, error); }
  async _guardRequestBudget(agent, signal, pressure = true) { return guardRequestBudget(this, agent, signal, pressure); }
  async _emergencySnip(agent, spec, signal, reason = 'budget-wall') { return emergencySnip(this, agent, spec, signal, reason); }
  async _spillTailToolOutputs(agent, signal) { return spillTailToolOutputs(this, agent, signal); }
  async _guardVisibleImageBudget(agent, signal, options = {}) { return guardVisibleImageBudget(this, agent, signal, options); }
  async _runContextCollapse(agent, plan, policy, signal, beforeTokens = null) { return runContextCollapse(this, agent, plan, policy, signal, beforeTokens); }
  async _compactBeforeResume(agent, extSignal, messages) { return compactBeforeResume(this, agent, extSignal, messages); }
  _idleContinuationCanShrink(session, range, policy) { return idleContinuationCanShrink(this, session, range, policy); }

  async compactIfNeeded(agent, trigger, signal) {
    return this._runWithActiveSignal(signal, (activeSignal) =>
      this._withConfig(() =>
        withStageTraceContext(
          {
            enabled: isStageTraceEnabled(this.config),
            storageRoot: dirname(this.archive.root),
            sessionId: agent?.session?.id,
          },
          () => this.diagnostics.run(agent?.session, { trigger, signal: activeSignal, reportContext: this._diagnosticContext(agent) }, () => this._compactIfNeededInner(agent, trigger, activeSignal)),
        ),
      ),
    );
  }

  _diagnosticContext(agent) {
    try { return diagnosticContext(agent, this._resolvePolicy(agent)); }
    catch { return diagnosticContext(agent, this.config); }
  }

  async _compactIfNeededInner(agent, trigger, signal) { return compactIfNeededInner(this, agent, trigger, signal); }

  async compactNow(agent, signal, sourceCommandId, continuation = false, options = {}) {
    try {
      return await this._runWithActiveSignal(signal, (activeSignal) =>
        this._withConfig(() =>
          withStageTraceContext(
            {
              enabled: isStageTraceEnabled(this.config),
              storageRoot: dirname(this.archive.root),
              sessionId: agent?.session?.id,
            },
            () => this.diagnostics.run(agent?.session, { trigger: continuation ? 'manual-continuation' : 'manual', commandId: sourceCommandId, signal: activeSignal, reportContext: this._diagnosticContext(agent) }, () => this._compactNowInner(agent, activeSignal, sourceCommandId, continuation, options)),
          ),
        ),
      );
    } catch (error) {
      throw await asHostManualError(this.ctx, error, error?.compactionStage);
    }
  }

  async _compactNowInner(agent, signal, sourceCommandId, continuation = false, options = {}) {
    const userFocus = sanitizeFocusInstruction(options?.focusInstruction ?? '');
    const runMaintenance = agent?.runMaintenance;
    if (typeof runMaintenance !== 'function') {
      throw Object.assign(new Error('manual compaction requires an agent that supports maintenance tasks'), { code: 'busy' });
    }
    let entered = false;
    let maintenanceSignal;
    let combinedSignal;
    try {
      return await runMaintenance.call(agent, async (agentSignal) => {
        entered = true;
        maintenanceSignal = agentSignal;
        const merged = combineSignals([agentSignal, signal]);
        combinedSignal = merged.signal;
        try {
          if (!continuation && !userFocus && agent?.session?.id) {
            const existingResumable = readResumableCompaction(this.sessionState, agent.session.id);
            if (existingResumable && existingResumable.status !== 'running') {
              const resumed = await this.resumeCompactionFor(agent.session, {
                agent,
                signal: merged.signal,
                sourceCommandId,
                manualRetry: true,
                insideMaintenance: true,
                allowPolicyRestart: true,
              });
              if (resumed) return resumed;
            }
          }
          return await this._compactManual(agent, merged.signal, sourceCommandId, continuation, false, {
            ...(userFocus ? { focusInstruction: userFocus } : {}),
          });
        } finally {
          merged.dispose();
        }
      });
    } catch (error) {
      if (!entered) {
        const busy = new Error('manual compaction requires an idle agent with no waking queued work');
        busy.code = 'busy';
        busy.cause = error;
        throw busy;
      }
      if (maintenanceSignal?.aborted === true && combinedSignal?.reason === maintenanceSignal.reason) {
        const cancelled = new Error(error.compactionIds?.length
          ? `manual compaction was cancelled after ${error.compactionIds.length} committed chunk(s); remaining history retained`
          : 'manual compaction was cancelled');
        cancelled.compactionIds = error.compactionIds;
        cancelled.code = 'cancelled';
        cancelled.cause = error;
        throw cancelled;
      }
      throw error;
    }
  }

  async _compactManual(agent, signal, sourceCommandId, continuation = false, proactive = false, options = {}) {
    return withStageTraceContext(
      {
        enabled: isStageTraceEnabled(this.config),
        storageRoot: dirname(this.archive.root),
        sessionId: agent?.session?.id,
      },
      () => this._compactManualInner(agent, signal, sourceCommandId, continuation, proactive, options),
    );
  }

  async _compactManualInner(agent, signal, sourceCommandId, continuation = false, proactive = false, options = {}) { return compactManualInner(this, agent, signal, sourceCommandId, continuation, proactive, options); }
  _buildSpanCheckpointWithMetadata(opts) { return buildSpanCheckpointWithMetadata(this, opts); }
  _buildPrecomputedSliceSpec(session, seqs, policy, opts = {}) { return buildPrecomputedSliceSpec(this, session, seqs, policy, opts); }
  _makeAuditExhaustionFallback(opts) { return makeAuditExhaustionFallback(this, opts); }
  async _generateValidatedPrecomputedSpan(opts) { return generateValidatedPrecomputedSpan(this, opts); }
  async _compactChunksConcurrent(opts) { return compactChunksConcurrent(this, opts); }
  async _runContinuationWaves(opts) { return runContinuationWaves(this, opts); }
  async _selectContinuationWaveForSession(session, agent, policy, maxTokens, signal, capacityContext, opts = {}) { return selectContinuationWaveForSession(this, session, agent, policy, maxTokens, signal, capacityContext, opts); }
  async _tryHierarchicalFold(opts) { return tryHierarchicalFold(this, opts); }

  async compactRegion(start, end, agent, signal, sourceCommandId) {
    return this._runWithActiveSignal(signal, (activeSignal) =>
      this._withConfig(() => this.diagnostics.run(agent?.session, { trigger: 'region', commandId: sourceCommandId, signal: activeSignal, reportContext: this._diagnosticContext(agent) }, () => this._compactRegionInner(start, end, agent, activeSignal, sourceCommandId))),
    );
  }

  async _compactRegionInner(start, end, agent, signal, sourceCommandId, options = {}) { return compactRegionInner(this, start, end, agent, signal, sourceCommandId, options); }
  _validateSessionMemoryReuse(session, match, policy, options = {}) { return validateSessionMemoryReuse(this, session, match, policy, options); }
  async _compactRegionCore(start, end, agent, extSignal, options) { return compactRegionCore(this, start, end, agent, extSignal, options); }
  async _compactSpan(start, end, agent, signal, options, attempt) { return compactSpan(this, start, end, agent, signal, options, attempt); }

  async migrateBiliSession(session, options = {}) { return migrateBiliSession(this, session, options); }
  async resumeCompactionFor(session, options = {}) { return resumeCompactionFor(this, session, options); }
  _clearInMemoryBreaker(sessionId, session = null) { return clearInMemoryBreaker(this, sessionId, session); }
  async resetBreakerFor(sessionOrId) { return resetBreakerFor(this, sessionOrId); }
  setBreakerBypassFor(sessionId, bypassed) { return setBreakerBypassFor(this, sessionId, bypassed); }
  async retryCompactionFor(session, options = {}) { return retryCompactionFor(this, session, options); }
  async _adoptBiliFoldSpan(session, agent, plan, backup, extSignal, options = {}) { return adoptBiliFoldSpan(this, session, agent, plan, backup, extSignal, options); }
  async restoreSessionBackupFor(sessionId, options = {}) { return restoreSessionBackupFor(this, sessionId, options); }

  _isRecoverable(error) { return isRecoverable(this, error); }
  async _dispatchSummaryError(session, sourceEventSeqs, error, signal) { return dispatchSummaryError(this, session, sourceEventSeqs, error, signal); }
  _estimateCheckpointTokens(blocks) { return estimateCheckpointTokens(this, blocks); }
  async _flushSession(session) { return flushSession(this, session); }
  _splitAuditLost(lost, policy) { return splitAuditLost(this, lost, policy); }
  _buildProvenanceError(provenanceSummary, baseMessage) { return buildProvenanceError(this, provenanceSummary, baseMessage); }
  _extractFailureCode(error, receipt) { return extractFailureCode(this, error, receipt); }
  _diagnosticReceiptFields(receipt) { return diagnosticReceiptFields(this, receipt); }
  _recordFailureDiagnostic(session, receipt, error) { return recordFailureDiagnostic(this, session, receipt, error); }
  _recordFailure(agent, session, error) { return recordFailure(this, agent, session, error); }
  _audit(session, shadowedSeqs, summaryTextValue, compactionId, checkpointBlocks, policy = this.config) { return audit(this, session, shadowedSeqs, summaryTextValue, compactionId, checkpointBlocks, policy); }
  _shadowedTokens(session, shadowedSeqs) { return shadowedTokens(this, session, shadowedSeqs); }
  async _measure(session) { return measure(this, session); }
  async _measureInner(session) { return measureInner(this, session); }
  _activeModelSelection(agent) { return activeModelSelection(this, agent); }
  _resolveSummaryTargets(policy, agent) { return resolveSummaryTargetsForEngine(this, policy, agent); }
  _resolveTargetRoute(agent, opts = {}) { return resolveTargetRoute(this, agent, opts); }
  _resolvePolicy(agent) { return resolvePolicy(this, agent); }
  async _resolveSpec(agent, measurement, signal, opts = {}) { return resolveSpec(this, agent, measurement, signal, opts); }
  _reservedCompletionTokens(agent, defaultMaxTokens, targetProvider = undefined, targetModel = undefined) { return reservedCompletionTokens(this, agent, defaultMaxTokens, targetProvider, targetModel); }
  async _journalRecord(session, compactionId, phase, start, end) { return journalRecord(this, session, compactionId, phase, start, end); }
  async recoverPending(session, owned = false, failureKind = 'interrupted') { return recoverPending(this, session, owned, failureKind); }
  async _recoverPendingInner(session, owned = false, failureKind = 'interrupted') { return recoverPendingInner(this, session, owned, failureKind); }
  _restoreState(session) { return restoreState(this, session); }
  async _pruneToolResults(session) { return pruneToolResults(this, session); }

  /** Synchronous append helper; must NEVER be async so commit triples never yield. */
  _append(session, type, data, options) {
    if (typeof session.append !== 'function') {
      throw new Error(`session.append is unavailable; cannot record ${type}`);
    }
    return options === undefined ? session.append(type, data) : session.append(type, data, options);
  }

  /** Guarded synchronous append used inside atomic/sync surface replacement commits. */
  _appendSync(session, type, data, options) {
    const result = this._append(session, type, data, options);
    if (result && typeof result.then === 'function') {
      throw new Error(`session.append returned a promise for ${type}; the commit段 requires synchronous appends`);
    }
    return result;
  }

  _warnHostFallbackOnce(reason) {
    const key = String(reason || 'unknown');
    if (this._hostFallbackWarned.has(key)) return;
    this._hostFallbackWarned.add(key);
    this.log('warn', `host internal fingerprint changed (${key}); falling back to public Session.append replace while keeping pre-replace archive and flush guards`);
  }

  async _assertNoUnrecoveredAtomicJournal(session) { return assertNoUnrecoveredAtomicJournal(this, session); }

  log(level, message) {
    try {
      const logger = this.ctx?.logger;
      const text = `[compaction-weave] ${message}`;
      if (logger && typeof logger[level] === 'function') logger[level](text);
      else if (logger && typeof logger.info === 'function') logger.info(text);
    } catch {}
  }
}
