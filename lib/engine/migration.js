// Billion-context runtime conflict detection, coexistence blocking, and session migration / fold-adopt.
// All functions accept `engine` as 1st parameter and NEVER import `../engine.js`.

import { combineSignals } from '../abort.js';
import { setBoundedMap } from '../collections.js';
import {
  classifyBiliProxyError,
  detectBiliCoexistence,
  sanitizeBiliConflict,
} from '../bili-conflict.js';
import { DEFAULT_CONFIG } from '../config.js';
import { probeDiskLiveness, renderDiskLivenessNotice } from '../disk-liveness.js';
import {
  collectActiveWorkspaceFiles,
  resolveAdaptiveReinjectLimits,
  selectActiveWorkspaceFiles,
} from '../file-reinject.js';
import { buildBiliMigrationPlan, detectBiliSession } from '../foreign-fold.js';
import { spanEntries } from '../history.js';
import {
  memoryDecisionsForSource,
  memoryRequirements,
  memorySourceRefs,
} from '../memory-policy.js';
import { approxTokens, estimateHostHeuristicSpan } from '../meter.js';
import { collectProgressFacts, progressSourceRefs } from '../progress-facts.js';
import { CHECKPOINT_PREAMBLE } from '../prompt.js';
import {
  assertCompactionInactive,
  buildCheckpointBlocks,
  collectArchivedFiles,
  collectChildArchiveIds,
  inspectCompactionEntryState,
  preservedForSource,
  selectCompactableRange,
  selectSessionMemory,
  validateSurfaceRegion,
} from '../region.js';
import { createSessionBackup, summarizeBackups } from '../session-backup.js';
import { clearBreakerState, clearResumableCompaction, readResumableCompaction } from '../state.js';
import { materializeUserMessageSection } from '../validate.js';
import { collectWorkReport, scopeWorkReport, workReportRef } from '../work-report.js';
import {
  activeTransactions,
  canonicalMessageBytes,
  compactCheckpointSource,
  isAbortError,
  isUnshrinkableTailError,
  isUserCancelledError,
  newMessageId,
  nextMigrationCompactionId,
  safeGetService,
} from './shared.js';

export function noteBiliRuntimeSignal(engine, session, error) {
  const kind = classifyBiliProxyError(error);
  if (!kind) return null;
  const code = kind === 'foreign_bili_format' ? 'SUMMARY_FOREIGN_BILI_FORMAT' : 'BILI_PROXY_CONFLICT';
  const entry = { kind, code, at: new Date().toISOString() };
  const key = typeof session?.id === 'string' && session.id.length > 0 ? session.id : '__global__';
  const prev = engine._biliRuntimeSignals.get(key) ?? [];
  const nextSignals = [...prev.slice(-5), entry];
  if (typeof engine._setBounded === 'function') {
    engine._setBounded(engine._biliRuntimeSignals, key, nextSignals, 64);
  } else {
    setBoundedMap(engine._biliRuntimeSignals, key, nextSignals, 64);
  }
  try {
    engine._runtime?.reportBiliConflict?.(session?.id ?? '', entry);
  } catch {
    /* best-effort runtime signal report */
  }
  return entry;
}

export function getBiliConflict(engine, session) {
  const sid = typeof session?.id === 'string' && session.id.length > 0 ? session.id : null;
  const localSignals = [
    ...(sid ? (engine._biliRuntimeSignals.get(sid) ?? []) : []),
    ...(engine._biliRuntimeSignals.get('__global__') ?? []),
  ];
  let llmSvc = null;
  try {
    llmSvc = typeof engine.ctx?.get === 'function' ? engine.ctx.get('llm') : null;
  } catch {
    llmSvc = null;
  }
  const local = sanitizeBiliConflict(
    detectBiliCoexistence({
      ctx: engine.ctx,
      runtimeSignals: localSignals,
      llmService: llmSvc,
    }),
  );
  let fromRuntime = null;
  try {
    fromRuntime = sanitizeBiliConflict(engine._runtime?.getBiliConflict?.(sid ?? ''));
  } catch {
    fromRuntime = null;
  }
  if (!local) return fromRuntime;
  if (!fromRuntime) return local;
  const activePlugin = local.activePlugin || fromRuntime.activePlugin;
  const proxyResidue = local.proxyResidue || fromRuntime.proxyResidue;
  const latest =
    local.lastSignalAt && (!fromRuntime.lastSignalAt || local.lastSignalAt >= fromRuntime.lastSignalAt)
      ? local
      : fromRuntime;
  return sanitizeBiliConflict({
    detected: true,
    kind: activePlugin && proxyResidue ? 'both' : activePlugin ? 'active_plugin' : 'proxy_residue',
    activePlugin,
    proxyResidue,
    signals: [...local.signals, ...fromRuntime.signals],
    restartRecommended: true,
    lastSignalAt: latest.lastSignalAt ?? local.lastSignalAt ?? fromRuntime.lastSignalAt ?? null,
    lastSignalCode: latest.lastSignalCode ?? local.lastSignalCode ?? fromRuntime.lastSignalCode ?? null,
  });
}

export function assertNoActiveBiliConflict(engine, session, trigger = 'compaction') {
  const conflict = engine._getBiliConflict(session);
  if (conflict?.activePlugin !== true) return;
  engine.log(
    'warn',
    `blocked ${trigger} due to active billion-context coexistence (signals=${conflict.signals.join(',') || 'active'})`,
  );
  const error = new Error(
    'Detected active billion-context plugin alongside dsh-compaction-weave; ' +
      'disable or uninstall billion-context, restore your model provider baseUrl, and fully restart DSH before compacting.',
  );
  error.code = 'BILI_COEXISTENCE_CONFLICT';
  error.failureCode = 'BILI_COEXISTENCE_CONFLICT';
  error.biliConflict = conflict;
  throw error;
}

function resolveMigrationProgressScope(engine, session, plan, initialMeasurement, isFoldAdopt, beforeTokens) {
  const initialLiveNodes = session.surface?.nodes ?? [];
  const migrationTargetStart = plan.startSeq;
  let migrationTargetEnd = plan.endSeq;
  if (!isFoldAdopt && initialMeasurement) {
    const fullRange = selectCompactableRange(session, initialMeasurement, 0);
    if (fullRange) {
      const planEndIdx = initialLiveNodes.indexOf(migrationTargetEnd);
      const fullEndIdx = initialLiveNodes.indexOf(fullRange.end);
      if (fullEndIdx > planEndIdx) migrationTargetEnd = fullRange.end;
    }
  }
  const migrationStartIdx = initialLiveNodes.indexOf(migrationTargetStart);
  const migrationEndIdx = initialLiveNodes.indexOf(migrationTargetEnd);
  const migrationTargetSeqs = isFoldAdopt
    ? [...plan.surfaceRangeSeqs]
    : migrationStartIdx >= 0 && migrationEndIdx >= migrationStartIdx
      ? initialLiveNodes.slice(migrationStartIdx, migrationEndIdx + 1)
      : [...plan.surfaceRangeSeqs];
  return engine._buildProgressScope(session, migrationTargetSeqs, {
    beforeTokens,
    isFoldAdopt,
  });
}

async function createVerifiedMigrationBackup(engine, session, options, runSignal, backupBarrier) {
  // Step 1: Mandatory verified raw-byte full backup BEFORE any mutation.
  const sessions = options.sessions ?? engine.ctx.sessions;
  const backend = options.backend ?? engine.transactionAdapter?.backend ?? safeGetService(engine.ctx, 'sessionPersistence');
  const sessionPersistence = options.sessionPersistence ?? backend;
  let backup;
  try {
    backup = await createSessionBackup(engine.backupStore, {
      session,
      sessions,
      backend,
      sessionPersistence,
      stateStore: engine.sessionState,
      logPath: options.logPath,
      reason: 'bili-migration',
      reuseIdentical: true,
      signal: runSignal,
    });
  } catch (backupError) {
    if (backupError && typeof backupError === 'object' && !backupError.code) {
      backupError.code = 'BILI_BACKUP_FAILED';
    }
    backupBarrier.rejectOnce(backupError);
    throw backupError;
  }
  if (!backup?.ok) {
    const err = Object.assign(new Error('Session backup verification did not succeed; migration aborted.'), {
      code: 'BILI_BACKUP_FAILED',
    });
    backupBarrier.rejectOnce(err);
    throw err;
  }
  const backupSummary = summarizeBackups(engine.backupStore, session.id);
  const originalBackupId = backupSummary.originalBackupId ?? backup.backupId;
  return { backup, originalBackupId };
}

async function closeStaleExternalCompactionLock(engine, session, plan) {
  // Step 2: Close stale non-weave compaction/start lock if present and no live Weave lock owns it.
  const entryState = inspectCompactionEntryState(session);
  if (entryState.openTurn !== null) {
    throw Object.assign(new Error('Session became busy with an open turn before migration started.'), { code: 'busy' });
  }
  if (plan.staleCompactionStartSeq !== null && entryState.unmatchedCompactionStart === plan.staleCompactionStartSeq) {
    const staleStart = session.eventAt(plan.staleCompactionStartSeq);
    const staleId = String(staleStart?.data?.compactionId ?? '');
    if (!staleId.startsWith('weave-')) {
      engine._appendSync(session, 'compaction/end', {
        compactionId: staleId || 'external-stale-compaction',
        ...(staleStart?.data?.sourceCommandId !== undefined
          ? { sourceCommandId: staleStart.data.sourceCommandId }
          : {}),
        turn: staleStart?.data?.turn ?? null,
        error: 'Closed stale external compaction lock prior to Weave compatibility migration.',
      });
      if (typeof engine.ctx.sessions?.flush === 'function') {
        await engine._flushSession(session);
      }
    }
  }
}

async function runProxyRawRollingMigration(engine, session, effectiveAgent, plan, backup, originalBackupId, options, runSignal) {
  // For proxy-raw sessions, cover at least `plan.startSeq..plan.endSeq` (every bili tool)
  // AND extend to the full shrinkable surface range when raw history continues after the
  // last bili tool so oversized raw logs compact in one rolling-wave pass.
  const liveNodes = session.surface?.nodes ?? [];
  const freshForRange = await engine._measure(session);
  const fullRange = freshForRange ? selectCompactableRange(session, freshForRange, 0) : null;
  const targetStart = plan.startSeq;
  let targetEnd = plan.endSeq;
  if (fullRange) {
    const planEndIdx = liveNodes.indexOf(targetEnd);
    const fullEndIdx = liveNodes.indexOf(fullRange.end);
    if (fullEndIdx > planEndIdx) targetEnd = fullRange.end;
  }
  let rollingResult = null;
  let recoveredIds = null;
  try {
    rollingResult = await engine._compactManual(effectiveAgent, runSignal, options.sourceCommandId, false, false, {
      explicitRange: { start: targetStart, end: targetEnd },
      allowForeignFallback: true,
      checkpointMeta: {
        migratedFrom: 'billion-context',
        migrationVariant: plan.variant,
        migrationBackupId: backup.backupId,
      },
      triggerOverride: 'migration',
      originalBackupId,
    });
  } catch (rollingError) {
    if (isUnshrinkableTailError(rollingError) && !detectBiliSession(session).detected) {
      engine.log('info', 'Migration compacted all billion-context nodes; retaining unshrinkable non-bili tail cleanly.');
      recoveredIds = rollingError.compactionIds ?? rollingError.cause?.compactionIds ?? [];
    } else {
      throw rollingError;
    }
  }
  const afterRolling = await engine._measure(session);
  const compactionIds = Array.isArray(recoveredIds)
    ? recoveredIds
    : rollingResult
      ? (rollingResult.compactionIds ?? (rollingResult.compactionId ? [rollingResult.compactionId] : []))
      : [];
  return {
    compactionIds,
    afterTokens: afterRolling?.totalTokens ?? 0,
  };
}

async function finalizeMigrationSuccess(
  engine,
  session,
  runId,
  backup,
  originalBackupId,
  beforeTokens,
  migrationResult,
  backupBarrier,
) {
  const key = engine._keyOf(session);
  engine._failures.delete(key);
  engine._stopped.delete(key);
  try {
    clearResumableCompaction(engine.sessionState, session.id);
  } catch {
    /* best-effort clear */
  }
  try {
    engine.sessionState.update(session.id, (current) => clearBreakerState(current));
  } catch {
    // State already reset inside commit path where available.
  }
  const finalMeasurement = await engine._measure(session);
  const afterTokens = finalMeasurement?.totalTokens ?? migrationResult.afterTokens ?? 0;
  if (finalMeasurement) engine._lastTotal.set(session, afterTokens);
  engine._trackUpdate(session, { currentTokens: afterTokens, stream: null });

  const finalResponse = {
    accepted: true,
    completed: true,
    runId,
    backupId: backup.backupId,
    originalBackupId,
    backupPath: backup.backupPath,
    reusedBackup: backup.reused === true,
    beforeTokens,
    afterTokens,
    compactionIds: migrationResult.compactionIds,
    ...(typeof migrationResult.shadowedTokenCount === 'number'
      ? { shadowedTokenCount: migrationResult.shadowedTokenCount }
      : {}),
    ...(typeof migrationResult.replacementSeq === 'number'
      ? { summarySeq: migrationResult.replacementSeq }
      : {}),
  };
  backupBarrier.resolveOnce(finalResponse);
  return finalResponse;
}

function handleMigrationFailure(engine, session, effectiveAgent, error, runSignal, backupBarrier) {
  backupBarrier.rejectOnce(error);
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
          wasResumed: false,
        });
      }
    } catch {
      /* best-effort resumable persistence */
    }
  }
  engine.log('warn', `billion-context migration failed for ${session.id}: ${error?.message ?? error}`);
}

/**
 * Migrate an active or leftover billion-context session to native Weave compaction format:
 * 1. Mandatory SHA-256 verified full backup BEFORE any mutation
 * 2. Variant C (`fold-adopt`) -> archive + adopt existing billion-context fold into a native Weave checkpoint
 * 3. Variant A/B (`proxy-raw`) -> compact native events in rolling waves (returning after backup when `asyncRollingWave` is requested)
 */
export async function migrateBiliSession(engine, session, options = {}) {
  return engine._runWithActiveSignal(options.signal, (activeSignal) =>
    engine._withConfig(async () => {
      if (!session || typeof session !== 'object' || typeof session.id !== 'string' || !session.id) {
        throw Object.assign(new Error('Migration requires a valid loaded session.'), { code: 'INVALID_SESSION_ID' });
      }
      const transactionKey = `${engine.sessionState.root}:${JSON.stringify(session.id)}`;
      if (engine._busy.has(session) || activeTransactions.has(transactionKey)) {
        throw Object.assign(new Error('Cannot migrate while compaction or migration is already in progress.'), {
          code: 'busy',
        });
      }
      engine._assertNoActiveBiliConflict(session, 'migration');
      engine.sessionMemory?.cancel?.(session.id);

      const detection = detectBiliSession(session);
      if (!detection.detected) {
        throw Object.assign(new Error('No unmigrated billion-context format detected in this session.'), {
          code: 'NOT_BILI_SESSION',
        });
      }
      if (detection.hasOpenTurn) {
        throw Object.assign(new Error('Cannot migrate while a turn is open; wait until the session is idle.'), {
          code: 'busy',
        });
      }
      const plan = buildBiliMigrationPlan(session, detection);
      if (!plan.needed) {
        throw Object.assign(new Error('Session requires no billion-context migration.'), { code: 'NOT_BILI_SESSION' });
      }

      const initialMeasurement = await engine._measure(session);
      const beforeTokens = initialMeasurement?.totalTokens ?? plan.estimatedSurfaceTokens ?? 0;
      const isFoldAdopt = plan.strategy === 'fold-adopt' || plan.hasBrokenToolPairing;
      const progressScope = resolveMigrationProgressScope(
        engine,
        session,
        plan,
        initialMeasurement,
        isFoldAdopt,
        beforeTokens,
      );
      const attachedAgent = engine._resolveLiveAgent(session, options.agent);
      const effectiveAgent = attachedAgent ?? { session, options: {} };
      const useMaintenance = Boolean(
        attachedAgent && typeof attachedAgent.runMaintenance === 'function' && options.insideMaintenance !== true,
      );

      let resolveBackupReady;
      let rejectBackupReady;
      const backupReady = new Promise((resolve, reject) => {
        resolveBackupReady = resolve;
        rejectBackupReady = reject;
      });
      // Mark handled immediately so synchronous paths that await `runPromise`
      // never emit an unhandledRejection if backup fails before `backupReady` is awaited.
      backupReady.catch(() => {});
      let backupSettled = false;
      const backupBarrier = {
        resolveOnce: (value) => {
          if (backupSettled) return;
          backupSettled = true;
          resolveBackupReady(value);
        },
        rejectOnce: (err) => {
          if (backupSettled) return;
          backupSettled = true;
          rejectBackupReady(err);
        },
      };

      const executeMigrationBody = async (runId, runSignal) => {
        const { backup, originalBackupId } = await createVerifiedMigrationBackup(
          engine,
          session,
          options,
          runSignal,
          backupBarrier,
        );
        const useAsyncRolling = !isFoldAdopt && options.asyncRollingWave === true;
        engine._trackUpdate(session, {
          phase: 'migrating',
          overallPercent: isFoldAdopt ? 45 : 12,
          beforeTokens,
          currentTokens: beforeTokens,
        });
        if (useAsyncRolling) {
          backupBarrier.resolveOnce({
            accepted: true,
            completed: false,
            runId,
            backupId: backup.backupId,
            originalBackupId,
            backupPath: backup.backupPath,
            reusedBackup: backup.reused === true,
            beforeTokens,
          });
        }
        await closeStaleExternalCompactionLock(engine, session, plan);
        const migrationResult = isFoldAdopt
          ? await engine._adoptBiliFoldSpan(session, effectiveAgent, plan, backup, runSignal, {
              sourceCommandId: options.sourceCommandId,
            })
          : await runProxyRawRollingMigration(
              engine,
              session,
              effectiveAgent,
              plan,
              backup,
              originalBackupId,
              options,
              runSignal,
            );
        return finalizeMigrationSuccess(
          engine,
          session,
          runId,
          backup,
          originalBackupId,
          beforeTokens,
          migrationResult,
          backupBarrier,
        );
      };

      const runPromise = engine._trackRun(
        session,
        {
          trigger: 'migration',
          phase: 'backing_up',
          beforeTokens,
          currentTokens: beforeTokens,
          overallPercent: isFoldAdopt ? 15 : 5,
          overallProcessedNodes: 0,
          overallTotalNodes: progressScope.totalNodes,
          overallProcessedTokens: 0,
          overallTotalTokens: progressScope.totalTokens,
        },
        (runId) =>
          engine._progressScope.run(progressScope, () =>
            engine._runWithCancel(session, runId, activeSignal, async (runSignal) => {
              engine._busy.add(session);
              engine._agentBySession.set(session, effectiveAgent);
              try {
                if (useMaintenance) {
                  return await attachedAgent.runMaintenance(async (agentSignal) => {
                    const merged = combineSignals([agentSignal, runSignal]);
                    try {
                      return await executeMigrationBody(runId, merged.signal);
                    } finally {
                      merged.dispose();
                    }
                  });
                }
                return await executeMigrationBody(runId, runSignal);
              } catch (error) {
                handleMigrationFailure(engine, session, effectiveAgent, error, runSignal, backupBarrier);
                throw error;
              } finally {
                engine._busy.delete(session);
              }
            }),
          ),
      );

      if (plan.strategy === 'proxy-raw-rolling' && !plan.hasBrokenToolPairing && options.asyncRollingWave === true) {
        // Attach terminal error sink to the background promise (progressTracker.withRun
        // already marks the run failed and logs the reason) so there is never an unhandled rejection.
        runPromise.catch(() => {});
        return await backupReady;
      }

      const migrationOutcome = await runPromise;
      if (isFoldAdopt && migrationOutcome?.completed) {
        const postHook = await engine._runPostCompactHook({
          session,
          trigger: 'migration',
          manual: true,
          focusInstruction: '',
          result: {
            compactionId: migrationOutcome.compactionIds?.[0] ?? null,
            compactionIds: migrationOutcome.compactionIds ?? [],
            shadowedTokenCount:
              migrationOutcome.shadowedTokenCount ??
              Math.max(0, (migrationOutcome.beforeTokens ?? 0) - (migrationOutcome.afterTokens ?? 0)),
            summarySeq: migrationOutcome.summarySeq ?? null,
          },
          signal: activeSignal,
        });
        if (postHook?.notices?.length > 0) migrationOutcome.hookNotices = postHook.notices;
        if (postHook?.warnings?.length > 0) migrationOutcome.hookWarnings = postHook.warnings;
      }
      return migrationOutcome;
    }),
  );
}

async function prepareAdoptCommitPreconditions(engine, session, agent, plan, options, signal) {
  await engine.recoverPending(session, true);
  signal?.throwIfAborted?.();
  validateSurfaceRegion(session, plan.startSeq, plan.endSeq, { allowUnbalancedPrefix: true });

  const policy = engine._resolvePolicy(agent);
  const budgetSpec =
    options.budgetSpec !== undefined
      ? options.budgetSpec
      : (engine._lastSpec?.get(session) ??
        (await engine._resolveSpec(agent, undefined, signal).catch((err) => {
          if (isAbortError(err, signal)) throw err;
          return null;
        })));
  const strictHost = Boolean(policy?.strictHostFingerprints) || Boolean(engine.requireTransactionAdapter);
  let useAtomicCommit = false;
  if (typeof session.restoreCompactionSurface !== 'function') {
    if (!engine.transactionAdapter) {
      if (strictHost) {
        throw Object.assign(
          new Error('Stock-host transaction adapter is unavailable; migration refused before changing history.'),
          { code: 'RECOVERY_REQUIRED' },
        );
      }
      await engine._assertNoUnrecoveredAtomicJournal(session);
      engine._warnHostFallbackOnce('stock transaction adapter unavailable');
    } else {
      const probe = engine.transactionAdapter.probeSupport(session);
      if (probe.ok) useAtomicCommit = true;
      else if (strictHost) throw probe.error;
      else {
        await engine._assertNoUnrecoveredAtomicJournal(session);
        engine._warnHostFallbackOnce(probe.reason);
      }
    }
  }

  const entryState = inspectCompactionEntryState(session);
  assertCompactionInactive(entryState.unmatchedCompactionStart, entryState.latestEndSeedSeq, 'migration');
  if (entryState.openTurn !== null) {
    throw Object.assign(new Error('migration requires an idle session without an open turn'), { code: 'busy' });
  }

  try {
    engine.sessionState.update(session.id, (state) => state);
  } catch (cause) {
    throw Object.assign(new Error(`compaction state unavailable before migration: ${cause?.message ?? cause}`), {
      code: 'STATE_UNAVAILABLE',
      cause,
    });
  }

  return { policy, budgetSpec, useAtomicCommit };
}

async function archiveAdoptSpan(engine, session, policy, compactionId, plan, shadowedSeqs, signal) {
  if (!policy.archiveEnabled) return null;
  const archiveSeqs = plan.totalArchivedSeqs.length > 0 ? plan.totalArchivedSeqs : shadowedSeqs;
  const archiveEntries = spanEntries(session, archiveSeqs, { allowForeignFallback: true });
  const archivePath = await engine.archive.writeSpan({
    sessionId: session.id,
    compactionId,
    entries: archiveEntries,
    signal,
    allowForeignFallback: true,
  });
  if (!archivePath) {
    throw Object.assign(new Error('migration: archiving pre-migration events failed; original session unchanged'), {
      code: 'ARCHIVE_FAILED',
    });
  }
  const verified = await engine.archive.readSpan(session.id, compactionId);
  if (!verified.ok) {
    throw Object.assign(
      new Error(`migration: archive verification failed (${verified.reason}); original session unchanged`),
      { code: 'ARCHIVE_FAILED' },
    );
  }
  return archivePath;
}

function buildAdoptCheckpointMessage(
  engine,
  session,
  policy,
  budgetSpec,
  compactionId,
  plan,
  backup,
  shadowedSeqs,
  shadowedTokenCount,
  options,
) {
  const memorySelection = selectSessionMemory(session, shadowedSeqs, {
    maxMessages: policy.preserveRecentMessages,
    maxTokens: policy.preserveRecentUserTokens,
    approxTokens,
  });
  const preserved = memorySelection.preserved;
  const progressSelection = collectProgressFacts(session, shadowedSeqs);
  const workReport = scopeWorkReport(collectWorkReport(session, shadowedSeqs), progressSelection);
  const baseSummary =
    plan.normalizedSummaryText ??
    `${plan.externalOriginNotice ?? '[Migrated from external billion-context session]'}\n\n## 1. Primary Request and Intent\n- (Migrated from billion-context)\n\n## 2. Key Technical Concepts\n- Migrated into native Weave checkpoint.\n\n## 3. Files and Code Sections\n- Original events archived in ${compactionId}.\n\n## 4. Errors and Fixes\n- (none)\n\n## 5. Problem Solving\n- (none)\n\n## 6. All User Messages\n- [filled by engine]\n\n## 7. Pending Tasks\n- Re-verify active obligations against archived history or verified user messages.\n\n## 8. Work Completed\n- Migrated external billion-context artifacts.\n\n## 9. Context for Continuing Work\n- Use history_read({ compactionId: "${compactionId}" }) for exact pre-migration records.`;
  const summaryText = materializeUserMessageSection(baseSummary, preserved, 'en');
  const shadowedCanonicalBytes = canonicalMessageBytes(
    shadowedSeqs.map((seq) => session.deriveEventMessage(session.eventAt(seq))).filter(Boolean),
  );
  const archivedFiles = collectArchivedFiles(session, shadowedSeqs);
  const childArchiveIds = policy.archiveEnabled ? collectChildArchiveIds(session, shadowedSeqs) : [];
  const archivePointer = policy.archiveEnabled
    ? {
        compactionId,
        startSeq: plan.startSeq,
        endSeq: plan.endSeq,
        files: archivedFiles,
        ...(childArchiveIds.length > 0 ? { childIds: childArchiveIds } : {}),
      }
    : null;

  const buildAdoptBlocks = (notice, active = '') =>
    buildCheckpointBlocks([{ type: 'text', text: summaryText }], preserved, CHECKPOINT_PREAMBLE, {
      originalsInSummary: true,
      workReport,
      progress: progressSelection,
      ...(archivePointer ? { archive: archivePointer } : {}),
      ...(notice ? { diskLiveness: notice } : {}),
      ...(active ? { activeFiles: active } : {}),
    });
  const fitsAdoptBudget = (blocks) =>
    !(shadowedTokenCount > 0 && shadowedCanonicalBytes > 0) ||
    canonicalMessageBytes([{ role: 'user', content: blocks }]) < shadowedCanonicalBytes;

  let diskLiveness = '';
  if ((policy.diskLivenessCheck ?? DEFAULT_CONFIG.diskLivenessCheck) !== false) {
    const probe = probeDiskLiveness({ session, shadowedSeqs, archivedFiles, summaryText });
    const fullNotice = renderDiskLivenessNotice(probe);
    const missingOnlyNotice = renderDiskLivenessNotice(probe, { includeModified: false });
    if (fullNotice) {
      if (fitsAdoptBudget(buildAdoptBlocks(fullNotice))) {
        diskLiveness = fullNotice;
      } else if (missingOnlyNotice && missingOnlyNotice !== fullNotice && fitsAdoptBudget(buildAdoptBlocks(missingOnlyNotice))) {
        diskLiveness = missingOnlyNotice;
      }
    }
  }

  let activeFiles = '';
  let reinjectFiles = 0;
  let reinjectBytes = 0;
  const reinjectEnabled = (policy.postCompactReinjectEnabled ?? DEFAULT_CONFIG.postCompactReinjectEnabled) !== false;
  const adaptiveReinject = reinjectEnabled
    ? resolveAdaptiveReinjectLimits({ policy, spec: engine._getBudgetSpec(session, budgetSpec) })
    : { maxFiles: 0, maxBytes: 0, maxFileBytes: 0, adaptiveApplied: false };
  const effectiveReinjectMaxBytes = adaptiveReinject.maxBytes;
  if (reinjectEnabled && adaptiveReinject.maxBytes > 0) {
    const reinject = collectActiveWorkspaceFiles({
      session,
      shadowedSeqs,
      archivedFiles,
      maxFiles: adaptiveReinject.maxFiles,
      maxBytes: adaptiveReinject.maxBytes,
      maxFileBytes: adaptiveReinject.maxFileBytes,
    });
    if (reinject.files.length > 0) {
      const fullActive = reinject.text;
      const shrunk = selectActiveWorkspaceFiles(reinject, {
        maxFiles: Math.min(2, reinject.files.length),
        maxBytes: Math.min(8192, Math.floor(adaptiveReinject.maxBytes / 3)),
      });
      const shrunkActive = shrunk.text;
      const fitsActiveBudget = (blocks) =>
        fitsAdoptBudget(blocks) && (!(shadowedTokenCount > 0) || engine._estimateCheckpointTokens(blocks) < shadowedTokenCount);
      if (fullActive && fitsActiveBudget(buildAdoptBlocks(diskLiveness, fullActive))) {
        activeFiles = fullActive;
        reinjectFiles = reinject.files.length;
        reinjectBytes = reinject.totalBytes;
      } else if (shrunkActive && shrunkActive !== fullActive && fitsActiveBudget(buildAdoptBlocks(diskLiveness, shrunkActive))) {
        activeFiles = shrunkActive;
        reinjectFiles = shrunk.files.length;
        reinjectBytes = shrunk.totalBytes;
      }
    }
  }
  engine._emitReinjectMeasured(session, { reinjectFiles, reinjectBytes, effectiveReinjectMaxBytes });

  const checkpointBlocks = buildAdoptBlocks(diskLiveness, activeFiles);
  const sourceMemory = {
    progressFacts: progressSourceRefs(progressSelection),
    summaryScope: progressSelection?.scope,
    workReport: workReportRef(workReport),
    memoryRequirements: preservedForSource(memoryRequirements(memorySelection.active)) ?? [],
    memorySources: memorySourceRefs(memorySelection.active, session),
    memoryDecisions: memoryDecisionsForSource(memorySelection.decisions, session),
  };
  const checkpointMessage = {
    id: newMessageId(),
    role: 'user',
    content: checkpointBlocks,
    source: Object.freeze({
      ...compactCheckpointSource(compactionId, options.sourceCommandId, preservedForSource(preserved)),
      preserved: preservedForSource(preserved) ?? [],
      ...sourceMemory,
      migratedFrom: 'billion-context',
      migrationVariant: plan.variant,
      migrationBackupId: backup.backupId,
      externalSummaryUnverified: true,
    }),
  };
  return { summaryText, checkpointMessage };
}

async function commitAdoptTransaction(
  engine,
  session,
  policy,
  compactionId,
  plan,
  shadowedSeqs,
  summaryText,
  checkpointMessage,
  useAtomicCommit,
  options,
  signal,
) {
  validateSurfaceRegion(session, plan.startSeq, plan.endSeq, { allowUnbalancedPrefix: true });
  const liveNodesBeforeCommit = session.surface?.nodes ?? [];
  const liveStartIdx = liveNodesBeforeCommit.indexOf(plan.startSeq);
  const liveEndIdx = liveNodesBeforeCommit.indexOf(plan.endSeq);
  const liveSlice =
    liveStartIdx >= 0 && liveEndIdx >= liveStartIdx ? liveNodesBeforeCommit.slice(liveStartIdx, liveEndIdx + 1) : null;
  if (!liveSlice || liveSlice.length !== shadowedSeqs.length || liveSlice.some((seq, i) => seq !== shadowedSeqs[i])) {
    throw Object.assign(new Error('migration span changed before commit; retry migration'), { code: 'SPAN_CHANGED' });
  }
  engine._trackUpdate(session, { phase: 'committing', overallPercent: 85, stream: null });
  const lifecycle = {
    compactionId,
    ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }),
    turn: null,
  };
  const startEvent = await engine._append(session, 'compaction/start', lifecycle);
  let closing = false;
  let closed = false;
  let replaced = false;
  let stockCommitted = false;
  let replacement;
  try {
    await engine._journalRecord(session, compactionId, 'started', plan.startSeq, plan.endSeq);
    const eventShadowedTokenCount = estimateHostHeuristicSpan(session, shadowedSeqs);
    const summaryPayload = {
      compactionId,
      ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }),
      summary: [{ type: 'text', text: summaryText }],
      rawOutput: [{ type: 'text', text: summaryText }],
      shadowedRange: { start: plan.startSeq, end: plan.endSeq },
      shadowedSeqs,
      shadowedTokenCount: eventShadowedTokenCount,
      provider: 'weave-migration',
      model: 'fold-adopt',
      maxTokens: policy.maxTokens ?? 8192,
    };
    if (typeof engine.ctx.sessions?.flush === 'function') {
      await engine._flushSession(session);
    }
    await engine._journalRecord(session, compactionId, 'committing', plan.startSeq, plan.endSeq);
    signal?.throwIfAborted?.();

    const commitProbe =
      useAtomicCommit && engine.transactionAdapter && typeof session.restoreCompactionSurface !== 'function'
        ? engine.transactionAdapter.probeSupport(session)
        : { ok: false };
    if (commitProbe.ok) {
      const staged = engine.transactionAdapter.stage(session, (shadow) => {
        const summaryEvent = engine._appendSync(shadow, 'compaction/summary', summaryPayload);
        const rep = engine._appendSync(shadow, 'user/message', checkpointMessage, {
          surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
          sourceEventSeqs: [
            ...new Set([startEvent?.seq, summaryEvent?.seq, ...shadowedSeqs].filter((s) => typeof s === 'number')),
          ],
        });
        const endEv = engine._appendSync(shadow, 'compaction/end', lifecycle);
        return { summaryEvent, replacement: rep, endEvent: endEv };
      });
      const record = (await engine.journal.pending(session.id)).find((r) => r.compactionId === compactionId);
      if (!record || record.corrupt || record.phase !== 'committing') {
        throw new Error('durable preparation journal is missing for migration');
      }
      const committed = await engine.transactionAdapter.commit(engine, session, record, staged, signal);
      replacement = committed.replacement;
      stockCommitted = true;
      closing = true;
      closed = true;
    } else {
      const strictHost = Boolean(policy?.strictHostFingerprints) || Boolean(engine.requireTransactionAdapter);
      if (strictHost) {
        throw (
          commitProbe.error ??
          Object.assign(
            new Error('Stock-host transaction adapter unavailable before migration commit; migration refused.'),
            { code: 'RECOVERY_REQUIRED' },
          )
        );
      }
      await engine._assertNoUnrecoveredAtomicJournal(session);
      engine._warnHostFallbackOnce(commitProbe.reason ?? 'stock transaction adapter unavailable before migration commit');
      const summaryEvent = engine._appendSync(session, 'compaction/summary', summaryPayload);
      const sourceEventSeqs = [
        ...new Set([startEvent?.seq, summaryEvent?.seq, ...shadowedSeqs].filter((s) => typeof s === 'number')),
      ];
      replacement = engine._appendSync(session, 'user/message', checkpointMessage, {
        surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
        sourceEventSeqs,
      });
      replaced = true;
      closing = true;
      try {
        engine._appendSync(session, 'compaction/end', lifecycle);
        closed = true;
      } catch (endError) {
        engine.log(
          'warn',
          `migration compaction/end failed after surface replace: ${endError?.message ?? endError}; retrying once to close the lock`,
        );
        engine._appendSync(session, 'compaction/end', {
          ...lifecycle,
          error: `compaction/end failed once and was retried: ${(endError?.message ?? String(endError)).slice(0, 1900)}`,
        });
        closed = true;
      }
    }
  } catch (error) {
    if (!closing) {
      closing = true;
      const closeText = `${error?.code ? `${error.code}: ` : ''}${error?.message ?? String(error)}`;
      try {
        await engine._append(session, 'compaction/end', { ...lifecycle, error: closeText.slice(0, 2000) });
        closed = true;
      } catch {
        /* best-effort lifecycle close */
      }
    }
    let flushed = typeof engine.ctx.sessions?.flush !== 'function';
    if (!stockCommitted && closed && !flushed) {
      try {
        await engine._flushSession(session);
        flushed = true;
      } catch {
        /* best-effort flush */
      }
    }
    if (closed && flushed && !replaced) {
      await engine.journal.clear(session.id, compactionId).catch(() => {});
    }
    throw error;
  }

  if (!stockCommitted) {
    if (closed && typeof engine.ctx.sessions?.flush === 'function') {
      await engine._flushSession(session);
    }
    await engine._journalRecord(session, compactionId, 'committed', plan.startSeq, plan.endSeq);
    engine.sessionState.update(session.id, (current) => clearBreakerState(current));
  }
  await engine.journal.clear(session.id, compactionId);
  engine._resetSessionMemoryCycle(session.id);
  return replacement;
}

export async function adoptBiliFoldSpan(engine, session, agent, plan, backup, extSignal, options = {}) {
  return engine._runWithActiveSignal(extSignal, async (signal) => {
    const transactionKey = `${engine.sessionState.root}:${JSON.stringify(session.id)}`;
    if (activeTransactions.has(transactionKey)) {
      throw Object.assign(new Error('compaction already active for this logical session'), { code: 'busy' });
    }
    activeTransactions.add(transactionKey);
    try {
      const { policy, budgetSpec, useAtomicCommit } = await prepareAdoptCommitPreconditions(
        engine,
        session,
        agent,
        plan,
        options,
        signal,
      );
      const compactionId = nextMigrationCompactionId();
      const shadowedSeqs = [...plan.surfaceRangeSeqs];
      const shadowedTokenCount = engine._shadowedTokens(session, shadowedSeqs);

      // Step 1: Archive surface fold nodes + dead bili tool nodes + bounded shadowed durable originals.
      const archivePath = await archiveAdoptSpan(engine, session, policy, compactionId, plan, shadowedSeqs, signal);

      // Step 2: Build native Weave checkpoint carrying external-origin notice + verified post-fold user messages.
      const { summaryText, checkpointMessage } = buildAdoptCheckpointMessage(
        engine,
        session,
        policy,
        budgetSpec,
        compactionId,
        plan,
        backup,
        shadowedSeqs,
        shadowedTokenCount,
        options,
      );

      // Step 3: Commit standard DSH v4 compaction events via StockTransactionAdapter (or safe fallback).
      const replacement = await commitAdoptTransaction(
        engine,
        session,
        policy,
        compactionId,
        plan,
        shadowedSeqs,
        summaryText,
        checkpointMessage,
        useAtomicCommit,
        options,
        signal,
      );
      const after = await engine._measure(session);
      return {
        compactionId,
        compactionIds: [compactionId],
        replacementSeq: replacement?.seq,
        archivePath,
        shadowedSeqs,
        shadowedTokenCount,
        afterTokens: after?.totalTokens ?? 0,
      };
    } finally {
      activeTransactions.delete(transactionKey);
    }
  });
}
