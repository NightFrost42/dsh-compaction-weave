// 宿主入口：把官方压缩引擎的行「原地换成」本插件。
//
// 为什么不能只靠 cordis.patch.yml：
//   官方把 compaction 放在 agent preset 内部的 isolate 组里
//     - id: preset-standard
//       config:
//         - id: compaction
//           name: cordis:group
//           isolate: { compaction: true, toolResultPruner: true }
//           config:
//             - id: compaction-basic
//               name: '@deepseek-ai/dsh-compaction-basic'
//   profile / bundle 的 patch 层只能按「顶层 id」匹配，进不到 preset 的
//   config.plugins 里（bili 的 dsh.bundle.patch.yml 注释明确写了这一点，
//   见 #1772/#2474/#3354）。
//
// 所以我们用 `internal/config` 全局钩子：配置树解析完成、插件加载之前，
// 把 name 是官方 compaction-basic 的行改写成自己的引擎。bili 用同一个钩子
// 把行改成 disabled:true（billion-context/dist/agent/dsh-compaction-gate.js）；
// 本插件用同一钩子，只把 name 换成自己的引擎入口。
//
// 改写是幂等的：改完 name 就不再匹配，重复解析不会叠加。
// 卸载本插件 = 关掉改写 = 官方引擎原样生效，不会留下半截状态。

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { installStockTransactionAdapter } from './transaction.js';
import { CompactionArchive, defaultArchiveRoot } from './history.js';
import { CompactionJournal } from './journal.js';
import {
  SessionStateStore,
  clearResumableCompaction,
  publicBreakerSummary,
  publicResumableSummary,
  readResumableCompaction,
} from './state.js';
import { clearPendingContinuation } from './continuation-pending.js';
import { forgetLockedWindow } from './window.js';
import { resolveConfig } from './config.js';
import { installCommandHeartbeat } from './command-heartbeat.js';
import { CompactionProgressTracker } from './progress-tracker.js';
import { SessionBackupStore, invalidateBackupSummaryCache, restoreSessionBackup, summarizeBackups } from './session-backup.js';
import { setExternalFoldClassifier } from './source-provenance.js';
import { detectBiliSession, isExternalFoldEvent } from './foreign-fold.js';
import { detectBiliCoexistence, findEnabledBiliPluginRows, sanitizeBiliConflict } from './bili-conflict.js';
import { setBoundedMap } from './collections.js';
import { PLUGIN_VERSION } from './version.js';
import { redactCredentials } from './redact.js';
import {
  MAX_BODY_BYTES,
  defaultSummaryConfigPath,
  handleSummaryConfigRpc,
  mergeSummaryConfig,
  readSummaryConfig,
} from './summary-config.js';

// Wire external-fold classifier at module load so provenance/region/memory modules
// classify foreign billion-context checkpoints without circular imports.
setExternalFoldClassifier(isExternalFoldEvent);

export const name = 'compaction-weave';

/** Settings page RPC; the path follows the `/plugins/<name>/` convention. */
export const SUMMARY_RPC_PATH = '/plugins/dsh-compaction-weave/rpc';

let processRpcToken = null;

function getProcessRpcToken() {
  if (processRpcToken === null) {
    processRpcToken = randomBytes(32).toString('base64url');
  }
  return processRpcToken;
}

/** 本插件只需要能写日志与拿配置树；引擎由被改写出来的那一行自己注入服务。 */
export const inject = [];

/**
 * 加载顺序屏障用的服务名。
 *
 * 为什么需要它：`internal/config` 是**加载期**钩子 —— 每一行在它自己的 fiber
 * 起来时把配置过一遍 waterfall。宿主用 `Promise.all` 并行创建行
 * （`cordis-plugin-loader/src/config/group.ts`），所以"配置树里能看到本插件"
 * 完全不能证明"本插件的监听器已经注册、并且早于目标行解析"。
 *
 * bili 用同一招：它的 `dsh.bundle.patch.yml` 给 `preset-standard/ptc/minimal/cordis`
 * 四行加了 `inject: [biliBasicCompactionPolicy]`，让这些 preset 等它的 gate
 * 就绪后再加载（`billion-context/dist/agent/dsh-compaction-gate.js` 里的
 * `ctx.reflect?.provide?.(BILI_COMPACTION_DISABLE_SERVICE, ...)`）。
 *
 * 我们照抄这个机制：本插件 provide 这个服务，`cordis.patch.yml` 里给四个
 * preset 行加同名的 `inject`。没有它，谁先谁后全看调度运气。
 */
const GATE_SERVICE = 'compactionWeaveGate';
const RUNTIME_SERVICE = 'compactionWeaveRuntime';

const OFFICIAL_ENGINE_PACKAGES = new Set(['@deepseek-ai/dsh-compaction-basic']);

/** Delegate to the official command, decorating only its timeout error text. */
const COMMAND_COMPACT_PACKAGE = '@deepseek-ai/dsh-command-compact';

const ENGINE_SPECIFIER = 'dsh-compaction-weave/engine';
const COMMAND_SPECIFIER = 'dsh-compaction-weave/command-compact';

// Kept as a public re-export for callers that merge configurations directly.
export { mergeSummaryConfig };

export function apply(ctx, rawConfig = {}) {
  const mode = rawConfig?.mode === 'disable-and-inject' ? 'disable-and-inject' : 'replace';
  const summaryConfigPath = defaultSummaryConfigPath();
  const savedSummary = readSummaryConfig(summaryConfigPath);
  // Keep only the inherited row here. Each engine reads the latest settings
  // itself; baking overrides into this row would make cleared values stick.
  const engineConfig = { ...(rawConfig?.engine ?? {}) };
  if (savedSummary?.provider && savedSummary?.model) {
    ctx.logger?.info?.(
      `[compaction-weave] summary model from settings: ${savedSummary.provider}/${savedSummary.model}` +
        (savedSummary.maxTokens === null ? '' : ` (maxTokens=${savedSummary.maxTokens})`),
    );
  }
  const logPath = rawConfig?.receiptPath ?? defaultReceiptPath();
  const state = { rewrites: 0, seenEntries: new Set() };
  installCommandHeartbeat(ctx);

  const progressTracker = new CompactionProgressTracker();
  const defaultArchive = resolveConfig(engineConfig).config.archiveDir ?? defaultArchiveRoot();
  const defaultArchiveStore = new CompactionArchive({ root: defaultArchive });
  const defaultJournalStore = CompactionJournal.alongside(defaultArchive);
  const backupStore = SessionBackupStore.alongside(defaultArchive);
  const defaultStateStore = new SessionStateStore(join(dirname(defaultJournalStore.root), 'state'));
  const liveEngines = new Set();
  const biliDetectCache = new WeakMap();
  let enabledBiliRows = 0;
  const biliRuntimeSignals = new Map();
  let cachedArchiveStorage = null;
  let cachedArchiveAt = 0;
  let archiveStatsPromise = null;

  const recordBiliSignal = (sessionId, entry) => {
    if (!entry || typeof entry !== 'object') return;
    if (entry.kind !== 'foreign_bili_format' && entry.kind !== 'bili_proxy_preflight') return;
    const at = typeof entry.at === 'string' && entry.at ? entry.at : new Date().toISOString();
    const code = typeof entry.code === 'string' && entry.code ? entry.code : null;
    const item = { kind: entry.kind, code, at };
    const appendForKey = key => {
      const list = biliRuntimeSignals.get(key) ?? [];
      biliRuntimeSignals.set(key, [...list.slice(-5), item]);
    };
    if (typeof sessionId === 'string' && sessionId.trim()) {
      appendForKey(sessionId.trim());
    }
    appendForKey('__global__');
    if (biliRuntimeSignals.size > 64) {
      for (const k of biliRuntimeSignals.keys()) {
        if (k !== '__global__' && k !== sessionId) {
          biliRuntimeSignals.delete(k);
          break;
        }
      }
    }
  };

  const computeBiliConflict = (sessionId = '') => {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
    const runtimeSignals = [
      ...(sid ? (biliRuntimeSignals.get(sid) ?? []) : []),
      ...(biliRuntimeSignals.get('__global__') ?? []),
    ];
    return sanitizeBiliConflict(
      detectBiliCoexistence({
        ctx,
        enabledConfigRows: enabledBiliRows,
        runtimeSignals,
        llmService: llmService ?? getLlmService(ctx),
      }),
    );
  };

  const enginePresetOf = engine => {
    const read = fn => { try { return fn(); } catch { return undefined; } };
    const c = read(() => engine?.ctx);
    const presetService = read(() => c?.get?.('agentPreset'));
    const registry = read(() => c?.get?.('agentPresets'));
    const candidates = [
      () => presetService,
      () => presetService?.id,
      () => presetService?.getCurrent?.(),
      () => registry?.composedPreset?.(c),
      () => engine?.presetId,
      () => c?.agentPreset,
      () => c?.config?.agentPreset,
      () => c?.scope?.config?.agentPreset,
      () => c?.scope?.parent?.config?.id,
      () => c?.scope?.parent?.config?.agentPreset,
      () => c?.scope?.parent?.parent?.config?.id,
    ];
    for (const candidate of candidates) {
      const value = read(candidate);
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    // DSH preset revision scopes own the engine before any Agent binds.
    // Cordis exposes fiber ancestry; registry revisions retain that same identity.
    const generations = read(() => registry?.generations);
    if (generations instanceof Map) {
      const ancestors = new Set();
      let fiber = read(() => c?.fiber);
      while (fiber && !ancestors.has(fiber) && ancestors.size < 64) {
        ancestors.add(fiber);
        fiber = read(() => fiber.parent?.fiber);
      }
      for (const generation of generations.values()) {
        const mount = read(() => generation?.mount);
        if (ancestors.has(read(() => mount?.fiber))) {
          const id = read(() => mount?.presetId);
          if (typeof id === 'string' && id.trim()) return id.trim();
        }
      }
    }
    return null;
  };

  const createSafeHookBus = hostCtx => {
    const safeGet = (target, prop) => {
      if (!target || (typeof target !== 'object' && typeof target !== 'function')) return undefined;
      try {
        return target[prop];
      } catch {
        return undefined;
      }
    };
    if (!hostCtx || typeof hostCtx !== 'object') return null;
    const bus = {};
    let hasMethod = false;

    const events = safeGet(hostCtx, 'events');
    const dispatch = safeGet(events, 'dispatch');
    if (typeof dispatch === 'function') {
      bus.events = {
        dispatch(type, args) {
          return dispatch.call(events, type, args);
        },
      };
      hasMethod = true;
    }

    for (const method of ['serial', 'parallel', 'listeners', 'emit']) {
      const fn = safeGet(hostCtx, method);
      if (typeof fn === 'function') {
        bus[method] = (...args) => fn.call(hostCtx, ...args);
        hasMethod = true;
      }
    }

    if (!hasMethod) return null;

    const rawLogger = safeGet(hostCtx, 'logger');
    if (rawLogger && typeof rawLogger === 'object') {
      const safeLogger = {};
      for (const level of ['warn', 'info', 'error', 'debug']) {
        const logFn = safeGet(rawLogger, level);
        if (typeof logFn === 'function') {
          safeLogger[level] = (...args) => logFn.call(rawLogger, ...args);
        }
      }
      if (Object.keys(safeLogger).length > 0) {
        bus.logger = safeLogger;
      }
    }

    return Object.freeze(bus);
  };

  const runtime = {
    progressTracker,
    backupStore,
    hookBus: createSafeHookBus(ctx),
    reportBiliConflict(sessionId, entry) {
      recordBiliSignal(sessionId, entry);
    },
    getBiliConflict(sessionId = '') {
      return computeBiliConflict(sessionId);
    },
    registerEngine(engine) {
      if (engine) liveEngines.add(engine);
    },
    unregisterEngine(engine) {
      liveEngines.delete(engine);
    },
    getEngineForSession(session) {
      if (session) {
        for (const engine of liveEngines) {
          if (
            engine._agentBySession?.has(session) ||
            engine._busy?.has(session) ||
            engine._lastPriced?.has(session)
          ) {
            return engine;
          }
        }
        const preset = typeof session?.header?.agentPreset === 'string' && session.header.agentPreset.trim()
          ? session.header.agentPreset.trim()
          : (typeof session?.agentPreset === 'string' && session.agentPreset.trim() ? session.agentPreset.trim() : null);
        if (preset) {
          for (const engine of liveEngines) {
            const ep = enginePresetOf(engine);
            if (ep && (ep === preset || ep === `preset-${preset}` || `preset-${ep}` === preset)) {
              return engine;
            }
          }
        }
      }
      for (const engine of liveEngines) return engine;
      return null;
    },
    getDefaultEngine() {
      for (const engine of liveEngines) return engine;
      return null;
    },
    refreshAllConfigs() {
      for (const engine of liveEngines) {
        try {
          engine.refreshLiveConfig?.();
        } catch {
          // Keep mount alive if a settings file is invalid; strict check runs at operation boundary.
        }
      }
    },
  };

  // Compaction liveness fallback for the in-composer status card when no tracked
  // Weave run is active on `progressTracker`.
  const activeCompactions = new Map();
  let stockAdapter;
  let llmService = null;
  let sessionsService = null;
  let sessionPersistenceService = null;

  const getSessions = () => sessionsService ?? getOptionalService(ctx, 'sessions');
  const getPersistence = () => sessionPersistenceService ?? stockAdapter?.backend ?? getOptionalService(ctx, 'sessionPersistence');

  const getCachedBiliDetection = session => {
    if (!session || typeof session.eventAt !== 'function') return null;
    const seq = typeof session.seq === 'number' ? session.seq : 0;
    const replaceGeneration = session.surface?.replaceGeneration ?? 0;
    const cached = biliDetectCache.get(session);
    if (cached && cached.seq === seq && cached.replaceGeneration === replaceGeneration) {
      return cached.result;
    }
    const result = detectBiliSession(session);
    biliDetectCache.set(session, { seq, replaceGeneration, result });
    return result;
  };

  const publicBiliInfo = session => {
    const det = getCachedBiliDetection(session);
    if (!det) {
      return {
        detected: false,
        variant: null,
        foldBlockCount: 0,
        biliToolCount: 0,
        hasBrokenToolPairing: false,
        canConvert: false,
        needsBackup: false,
        hasOpenTurn: false,
        reasons: [],
      };
    }
    return {
      detected: det.detected === true,
      variant: det.variant ?? null,
      foldBlockCount: det.foldBlockCount ?? 0,
      biliToolCount: det.biliToolCount ?? 0,
      hasBrokenToolPairing: det.hasBrokenToolPairing === true,
      canConvert: det.canConvert === true,
      needsBackup: det.needsBackup === true,
      hasOpenTurn: det.hasOpenTurn === true,
      reasons: Array.isArray(det.reasons) ? [...det.reasons] : [],
    };
  };

  const backupSummaryFor = (store, sessionId) => summarizeBackups(store, sessionId);

  const effectivePressureBreakerAction = engine => {
    if (typeof engine?.config?.pressureBreakerAction === 'string') {
      return engine.config.pressureBreakerAction;
    }
    try {
      const liveSaved = readSummaryConfig(summaryConfigPath);
      return resolveConfig(mergeSummaryConfig(engineConfig, liveSaved)).config.pressureBreakerAction ?? 'confirm';
    } catch {
      return resolveConfig(engineConfig).config.pressureBreakerAction ?? 'confirm';
    }
  };

  const effectiveArchiveWarnBytes = engine => {
    if (Number.isInteger(engine?.config?.archiveWarnBytes) && engine.config.archiveWarnBytes >= 0) {
      return engine.config.archiveWarnBytes;
    }
    try {
      const liveSaved = readSummaryConfig(summaryConfigPath);
      return resolveConfig(mergeSummaryConfig(engineConfig, liveSaved)).config.archiveWarnBytes ?? (512 * 1024 * 1024);
    } catch {
      return resolveConfig(engineConfig).config.archiveWarnBytes ?? (512 * 1024 * 1024);
    }
  };

  const activeArchiveSessionIds = () => {
    const ids = new Set(activeCompactions.keys());
    for (const engine of liveEngines) {
      if (engine?._busy) {
        for (const sess of engine._busy) {
          if (typeof sess?.id === 'string' && sess.id) ids.add(sess.id);
        }
      }
    }
    return ids;
  };

  const collectArchiveStorageSummary = async (engine = null, { force = false } = {}) => {
    const now = Date.now();
    const warnBytes = effectiveArchiveWarnBytes(engine);
    if (!force && cachedArchiveStorage && now - cachedArchiveAt < 5000) {
      return {
        ...cachedArchiveStorage,
        warnBytes,
        warnExceeded: warnBytes > 0 && cachedArchiveStorage.totalBytes >= warnBytes,
      };
    }
    if (!force && archiveStatsPromise) return archiveStatsPromise;
    const task = (async () => {
      const targetEngine = engine ?? runtime.getDefaultEngine();
      const targetArchive = targetEngine?.archive ?? defaultArchiveStore;
      const targetBackupStore = targetEngine?.backupStore ?? backupStore;
      const targetStateStore = targetEngine?.sessionState ?? defaultStateStore;
      const targetJournal = targetEngine?.journal ?? defaultJournalStore;
      const persistence = getPersistence();
      const raw = await targetArchive.getStorageStats({
        backupRoot: targetBackupStore?.root ?? null,
        stateRoot: targetStateStore?.root ?? null,
        journal: targetJournal,
        sessions: getSessions(),
        backend: persistence,
        sessionPersistence: persistence,
        activeSessionIds: activeArchiveSessionIds(),
      });
      const latestWarnBytes = effectiveArchiveWarnBytes(targetEngine);
      const summary = {
        totalBytes: raw.totalBytes,
        backupBytes: raw.backupBytes,
        sessionCount: raw.sessionCount,
        spanCount: raw.spanCount,
        legacyPlainSpanCount: raw.legacyPlainSpanCount,
        legacyPlainSpanBytes: raw.legacyPlainSpanBytes,
        orphanProbeAvailable: raw.orphanProbeAvailable,
        orphanSessionCount: raw.orphanSessionCount,
        orphanBytes: raw.orphanBytes,
        ambiguousSessionCount: raw.ambiguousSessionCount,
        warnBytes: latestWarnBytes,
        warnExceeded: latestWarnBytes > 0 && raw.totalBytes >= latestWarnBytes,
      };
      cachedArchiveStorage = summary;
      cachedArchiveAt = Date.now();
      return summary;
    })();
    archiveStatsPromise = task;
    try {
      return await task;
    } finally {
      if (archiveStatsPromise === task) archiveStatsPromise = null;
    }
  };

  const publicSessionMemoryInfo = (engine, sessionId) => {
    if (!engine || typeof engine.sessionMemoryStatusFor !== 'function') return null;
    try {
      const raw = engine.sessionMemoryStatusFor(sessionId);
      if (!raw || typeof raw !== 'object') return null;
      return {
        enabled: raw.enabled === true,
        ready: raw.ready === true,
        updating: raw.updating === true,
        coveredNodes: Number.isSafeInteger(raw.coveredNodes) && raw.coveredNodes >= 0 ? raw.coveredNodes : 0,
        coveredThroughSeq: Number.isSafeInteger(raw.coveredThroughSeq) && raw.coveredThroughSeq >= 0 ? raw.coveredThroughSeq : null,
        updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt.length <= 64 ? raw.updatedAt : null,
        callsUsed: Number.isSafeInteger(raw.callsUsed) && raw.callsUsed >= 0 ? raw.callsUsed : 0,
        totalCallsUsed: Number.isSafeInteger(raw.totalCallsUsed) && raw.totalCallsUsed >= 0
          ? raw.totalCallsUsed
          : (Number.isSafeInteger(raw.callsUsed) && raw.callsUsed >= 0 ? raw.callsUsed : 0),
        maxCalls: Number.isSafeInteger(raw.maxCalls) && raw.maxCalls >= 0 ? raw.maxCalls : 0,
      };
    } catch {
      return null;
    }
  };

  const compactionStatus = sessionId => {
    const id = typeof sessionId === 'string' ? sessionId : '';
    const sessions = getSessions();
    const session = id && typeof sessions?.get === 'function' ? sessions.get(id) : null;
    const engine = runtime.getEngineForSession(session);
    const activeBackupStore = engine?.backupStore ?? backupStore;
    const activeStateStore = engine?.sessionState ?? defaultStateStore;
    const bili = publicBiliInfo(session);
    const backup = backupSummaryFor(activeBackupStore, id);
    const sessionMemory = publicSessionMemoryInfo(engine, id);
    let resumable = null;
    let sessionState = null;
    if (id) {
      try {
        sessionState = activeStateStore.read(id);
      } catch {
        sessionState = null;
      }
      try {
        resumable = publicResumableSummary(readResumableCompaction(activeStateStore, id));
      } catch {
        resumable = null;
      }
    }
    const biliConflict = computeBiliConflict(id);
    const breaker = publicBreakerSummary(sessionState, effectivePressureBreakerAction(engine));
    const liveWarnBytes = effectiveArchiveWarnBytes(engine);
    if (!cachedArchiveStorage || Date.now() - cachedArchiveAt > 15000) {
      void collectArchiveStorageSummary(engine).catch(() => {});
    }
    const archiveWarning =
      cachedArchiveStorage && liveWarnBytes > 0 && cachedArchiveStorage.totalBytes >= liveWarnBytes
        ? {
            totalBytes: cachedArchiveStorage.totalBytes,
            warnBytes: liveWarnBytes,
            legacyPlainSpanCount: cachedArchiveStorage.legacyPlainSpanCount ?? 0,
          }
        : null;
    const snapshot = progressTracker.snapshot(id, { bili, backup, resumable, breaker, biliConflict, archiveWarning });
    const engineActive = Boolean(engine ?? runtime.getDefaultEngine());
    const withSessionMemory = sessionMemory
      ? { ...snapshot, sessionMemory, engineActive }
      : { ...snapshot, engineActive };
    if (!snapshot.active && snapshot.phase === 'idle') {
      const legacy = activeCompactions.get(id);
      if (legacy) {
        return {
          ...withSessionMemory,
          active: true,
          phase: 'summarizing',
          startedAt: legacy.startedAt,
          elapsedMs: Math.max(0, Date.now() - legacy.startedAt),
          turn: legacy.turn,
        };
      }
    }
    return withSessionMemory;
  };

  // Optional: the live provider/model catalog that backs the settings selects.
  ctx.inject?.(['llm'], llmCtx => {
    llmService = llmCtx.llm;
    return () => {
      llmService = null;
    };
  });
  let connectionService = null;
  ctx.inject?.(['connection'], connCtx => {
    connectionService = connCtx.connection;
    return () => {
      if (connectionService === connCtx.connection) connectionService = null;
    };
  });
  const recoveryConfigs = new Map();
  const rememberRecoveryConfig = raw => {
    const config = resolveConfig(raw).config;
    const archiveRoot = config.archiveDir ?? defaultArchiveRoot();
    const journal = CompactionJournal.alongside(archiveRoot);
    const stateStore = new SessionStateStore(join(dirname(journal.root), 'state'));
    const store = SessionBackupStore.alongside(archiveRoot);
    const spec = [journal, stateStore, config.failureThreshold, store];
    setBoundedMap(recoveryConfigs, journal.root, spec, 64);
    stockAdapter?.register(...spec);
  };
  rememberRecoveryConfig(engineConfig);
  const rememberEngineRows = rows => {
    for (const row of rows) {
      if (row?.name === ENGINE_SPECIFIER) rememberRecoveryConfig(row.config ?? {});
      if (Array.isArray(row?.config)) rememberEngineRows(row.config);
      else if (Array.isArray(row?.config?.plugins)) rememberEngineRows(row.config.plugins);
    }
  };
  // Install before the host loads a persisted Session. Unlike engine-scoped
  // hooks, this also runs before failed compaction tails are decoded on resume.
  ctx.inject?.(['sessionPersistence', 'sessions'], recoveryCtx => {
    sessionsService = recoveryCtx.sessions;
    sessionPersistenceService = recoveryCtx.sessionPersistence;
    try {
      const adapter = installStockTransactionAdapter(recoveryCtx.sessionPersistence, recoveryCtx.sessions, recoveryCtx.logger);
      stockAdapter = adapter;
      for (const spec of recoveryConfigs.values()) adapter.register(...spec);
      adapter.registerBackupStore(backupStore);
      recoveryCtx.provide('compactionWeaveTransactions', adapter);
      return () => {
        if (sessionsService === recoveryCtx.sessions) sessionsService = null;
        if (sessionPersistenceService === recoveryCtx.sessionPersistence) sessionPersistenceService = null;
        if (stockAdapter === adapter) stockAdapter = undefined;
        adapter.dispose();
      };
    } catch (error) {
      recoveryCtx.logger?.warn?.(`[compaction-weave] stock transaction support unavailable: ${error.message}`);
      return () => {
        if (sessionsService === recoveryCtx.sessions) sessionsService = null;
        if (sessionPersistenceService === recoveryCtx.sessionPersistence) sessionPersistenceService = null;
      };
    }
  });

  // Allow RPC status/bili inspection when only `sessions` is available.
  ctx.inject?.(['sessions'], sCtx => {
    if (!sessionsService) sessionsService = sCtx.sessions;
    return () => {
      if (sessionsService === sCtx.sessions) sessionsService = null;
    };
  });

  const handleRuntimeRpc = async payload => {
    const method = typeof payload?.method === 'string' ? payload.method : '';
    const params = payload?.params && typeof payload.params === 'object' ? payload.params : {};
    if (method === 'status') {
      return compactionStatus(typeof params.sessionId === 'string' ? params.sessionId : '');
    }
    if (method === 'bili-inspect') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
      if (!sessionId) throw makeRpcError('INVALID_SESSION_ID', 'sessionId is required');
      const sessions = getSessions();
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : null;
      const engine = runtime.getEngineForSession(session);
      const activeBackupStore = engine?.backupStore ?? backupStore;
      const bili = publicBiliInfo(session);
      const backups = activeBackupStore.list(sessionId);
      const busy = Boolean(
        progressTracker.hasActiveRun(sessionId) ||
          (session && engine?._busy?.has(session)) ||
          activeCompactions.has(sessionId),
      );
      return { bili, backups, busy, hasOpenTurn: bili.hasOpenTurn };
    }
    if (method === 'bili-migrate') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
      if (!sessionId) throw makeRpcError('INVALID_SESSION_ID', 'sessionId is required');
      if (params.confirmIrreversible !== true) {
        throw makeRpcError(
          'CONFIRMATION_REQUIRED',
          'Irreversible conversion requires confirmIrreversible: true.',
        );
      }
      const sessions = getSessions();
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : null;
      if (!session) {
        throw makeRpcError('SESSION_NOT_FOUND', `Session "${sessionId}" is not loaded.`);
      }
      const engine = runtime.getEngineForSession(session);
      if (!engine || typeof engine.migrateBiliSession !== 'function') {
        throw makeRpcError('ENGINE_UNAVAILABLE', 'Weave compaction engine is not ready for this session.');
      }
      if (progressTracker.hasActiveRun(sessionId) || engine._busy?.has(session)) {
        throw makeRpcError('busy', 'Compaction or migration is already in progress for this session.');
      }
      const det = detectBiliSession(session);
      if (!det.detected) {
        throw makeRpcError('NOT_BILI_SESSION', 'No unmigrated billion-context format detected in this session.');
      }
      if (det.hasOpenTurn) {
        throw makeRpcError('busy', 'Cannot convert while a turn is open; wait until the session is idle.');
      }
      const persistence = getPersistence();
      const result = await engine.migrateBiliSession(session, {
        asyncRollingWave: true,
        sessions,
        backend: persistence,
        sessionPersistence: persistence,
      });
      biliDetectCache.delete(session);
      return result;
    }
    if (method === 'backup-list') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
      if (!sessionId) throw makeRpcError('INVALID_SESSION_ID', 'sessionId is required');
      const sessions = getSessions();
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : null;
      const engine = runtime.getEngineForSession(session);
      const activeBackupStore = engine?.backupStore ?? backupStore;
      const summary = summarizeBackups(activeBackupStore, sessionId);
      return {
        backups: activeBackupStore.list(sessionId),
        pendingRestore: activeBackupStore.readPendingRestore(sessionId),
        originalBackupId: summary.originalBackupId,
        latestBackupId: summary.latestBackupId,
        items: summary.items,
      };
    }
    if (method === 'backup-restore') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
      if (!sessionId) throw makeRpcError('INVALID_SESSION_ID', 'sessionId is required');
      if (params.confirmRestore !== true) {
        throw makeRpcError('CONFIRMATION_REQUIRED', 'Backup restore requires confirmRestore: true.');
      }
      const backupId = typeof params.backupId === 'string' && params.backupId.trim() ? params.backupId.trim() : undefined;
      const sessions = getSessions();
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : null;
      const engine = runtime.getEngineForSession(session);
      const persistence = getPersistence();
      let res;
      if (engine && typeof engine.restoreSessionBackupFor === 'function') {
        res = await engine.restoreSessionBackupFor(sessionId, {
          backupId,
          sessions,
          backend: persistence,
          sessionPersistence: persistence,
          stockAdapter,
        });
      } else {
        const defaultSpec = [...recoveryConfigs.values()][0];
        res = await progressTracker.withRun(
          sessionId,
          { trigger: 'restore', phase: 'restoring', overallPercent: 20 },
          () =>
            restoreSessionBackup(backupStore, {
              sessionId,
              backupId,
              sessions,
              backend: persistence,
              sessionPersistence: persistence,
              stockAdapter,
              stateStore: defaultSpec?.[1],
              journal: defaultSpec?.[0],
            }),
        );
      }
      if (session) biliDetectCache.delete(session);
      return {
        status: res.status,
        requiresReopen: res.requiresReopen === true,
        backupId: res.backupId,
        backupPath: res.backupPath,
        targetPath: res.targetPath,
      };
    }
    if (method === 'cancel-compaction') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
      if (!sessionId) throw makeRpcError('INVALID_SESSION_ID', 'sessionId is required');
      const sessions = getSessions();
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : null;
      const engine = runtime.getEngineForSession(session);
      const res = typeof engine?.cancelActiveCompactionFor === 'function'
        ? engine.cancelActiveCompactionFor(sessionId)
        : progressTracker.cancelRun(sessionId);
      return {
        cancelled: res?.cancelled === true,
        runId: res?.runId ?? null,
      };
    }
    if (method === 'resume-compaction') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
      if (!sessionId) throw makeRpcError('INVALID_SESSION_ID', 'sessionId is required');
      const sessions = getSessions();
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : null;
      const engine = runtime.getEngineForSession(session);
      if (progressTracker.hasActiveRun(sessionId) || (session && engine?._busy?.has(session))) {
        return {
          accepted: true,
          alreadyRunning: true,
          completed: false,
          runId: progressTracker.snapshot(sessionId)?.runId ?? null,
        };
      }
      if (!session) {
        throw makeRpcError('SESSION_NOT_FOUND', `Session "${sessionId}" is not loaded.`);
      }
      if (!engine || typeof engine.resumeCompactionFor !== 'function') {
        throw makeRpcError('ENGINE_UNAVAILABLE', 'Weave compaction engine is not ready for this session.');
      }
      const persistence = getPersistence();
      const res = await engine.resumeCompactionFor(session, {
        manualRetry: true,
        asyncRollingWave: true,
        idempotent: true,
        sessions,
        backend: persistence,
        sessionPersistence: persistence,
      });
      if (!res) {
        throw makeRpcError('NO_RESUMABLE_COMPACTION', 'No resumable compaction job exists for this session.');
      }
      biliDetectCache.delete(session);
      return {
        accepted: true,
        alreadyRunning: res.alreadyRunning === true,
        completed: res.completed === true,
        runId: res.runId ?? null,
      };
    }
    if (method === 'discard-resume') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
      if (!sessionId) throw makeRpcError('INVALID_SESSION_ID', 'sessionId is required');
      if (params.confirmDiscard !== true) {
        throw makeRpcError('CONFIRMATION_REQUIRED', 'Discarding resumable progress requires confirmDiscard: true.');
      }
      const sessions = getSessions();
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : null;
      const engine = runtime.getEngineForSession(session);
      if (progressTracker.hasActiveRun(sessionId) || (session && engine?._busy?.has(session))) {
        throw makeRpcError('busy', 'Compaction is currently active; pause it before discarding saved progress.');
      }
      if (engine && typeof engine.discardResumableFor === 'function') {
        return engine.discardResumableFor(sessionId);
      }
      const activeStateStore = engine?.sessionState ?? defaultStateStore;
      return {
        discarded: clearResumableCompaction(activeStateStore, sessionId),
        clearedContinuation: clearPendingContinuation(activeStateStore, sessionId),
      };
    }
    if (method === 'retry-compaction') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
      if (!sessionId) throw makeRpcError('INVALID_SESSION_ID', 'sessionId is required');
      const sessions = getSessions();
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : null;
      const engine = runtime.getEngineForSession(session);
      if (progressTracker.hasActiveRun(sessionId) || (session && engine?._busy?.has(session))) {
        return {
          accepted: true,
          alreadyRunning: true,
          completed: false,
          runId: progressTracker.snapshot(sessionId)?.runId ?? null,
        };
      }
      if (!session) {
        throw makeRpcError('SESSION_NOT_FOUND', `Session "${sessionId}" is not loaded.`);
      }
      if (!engine || typeof engine.retryCompactionFor !== 'function') {
        throw makeRpcError('ENGINE_UNAVAILABLE', 'Weave compaction engine is not ready for this session.');
      }
      const persistence = getPersistence();
      const res = await engine.retryCompactionFor(session, {
        asyncRollingWave: true,
        idempotent: true,
        sessions,
        backend: persistence,
        sessionPersistence: persistence,
      });
      biliDetectCache.delete(session);
      return {
        accepted: true,
        alreadyRunning: res?.alreadyRunning === true,
        completed: res?.completed === true,
        runId: res?.runId ?? null,
      };
    }
    if (method === 'bypass-breaker') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
      if (!sessionId) throw makeRpcError('INVALID_SESSION_ID', 'sessionId is required');
      const bypass = params.bypass !== false;
      if (bypass === true && params.confirmBypass !== true) {
        throw makeRpcError('CONFIRMATION_REQUIRED', 'Bypassing the circuit breaker requires confirmBypass: true.');
      }
      const sessions = getSessions();
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : null;
      const engine = runtime.getEngineForSession(session);
      const action = effectivePressureBreakerAction(engine);
      if (bypass === true && action === 'block') {
        throw makeRpcError(
          'BREAKER_BLOCK_POLICY',
          'pressureBreakerAction is set to block; bypassing the circuit breaker is disabled.',
        );
      }
      let summary;
      if (engine && typeof engine.setBreakerBypassFor === 'function') {
        summary = engine.setBreakerBypassFor(sessionId, bypass);
      } else {
        const activeStateStore = engine?.sessionState ?? defaultStateStore;
        const nextState = activeStateStore.update(sessionId, current => ({
          ...current,
          breakerBypassed: current.stopped ? Boolean(bypass) : false,
        }));
        summary = publicBreakerSummary(nextState, action);
      }
      return { ok: true, sessionId, ...summary };
    }
    if (method === 'reset-breaker') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
      if (!sessionId) throw makeRpcError('INVALID_SESSION_ID', 'sessionId is required');
      const sessions = getSessions();
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : null;
      const engine = runtime.getEngineForSession(session);
      if (progressTracker.hasActiveRun(sessionId) || (session && engine?._busy?.has(session))) {
        throw makeRpcError(
          'busy',
          'Compaction or migration is currently active for this session; pause or wait for it to finish before resetting.',
        );
      }
      let result;
      if (engine && typeof engine.resetBreakerFor === 'function') {
        result = await engine.resetBreakerFor(session ?? sessionId);
      } else {
        if (stockAdapter?.blocked?.has?.(sessionId)) {
          throw makeRpcError(
            'RECOVERY_REQUIRED',
            'Session writer is quarantined; restart DSH to restore the verified transaction backup before resetting.',
          );
        }
        const pending = await defaultJournalStore.pending(sessionId);
        if (Array.isArray(pending) && pending.length > 0) {
          throw makeRpcError(
            'RECOVERY_REQUIRED',
            'Pending compaction recovery journal exists for this session; recover or restart DSH before resetting.',
          );
        }
        const action = effectivePressureBreakerAction(engine);
        const res = defaultStateStore.resetBreaker(sessionId, { rebuildOnInvalid: true });
        if (res.windowCleared || res.rebuilt) {
          forgetLockedWindow(sessionId);
        }
        result = {
          ok: true,
          sessionId,
          reset: res.reset === true,
          rebuilt: res.rebuilt === true,
          windowCleared: Boolean(res.windowCleared || res.rebuilt),
          previousFailures: res.previousFailures ?? null,
          wasStopped: res.wasStopped ?? null,
          ...publicBreakerSummary(res.state, action),
        };
      }
      for (const liveEngine of liveEngines) {
        liveEngine._clearInMemoryBreaker?.(sessionId, session);
      }
      return result;
    }
    if (method === 'archive-stats') {
      const engine = runtime.getDefaultEngine();
      cachedArchiveAt = 0;
      const storage = await collectArchiveStorageSummary(engine, { force: true });
      return { storage };
    }
    if (method === 'archive-compress-legacy') {
      const engine = runtime.getDefaultEngine();
      const targetArchive = engine?.archive ?? defaultArchiveStore;
      const compressed = await targetArchive.compressLegacySpans();
      cachedArchiveAt = 0;
      const storage = await collectArchiveStorageSummary(engine, { force: true });
      return { ...compressed, storage };
    }
    if (method === 'archive-cleanup-orphans') {
      if (params.confirmDelete !== true) {
        throw makeRpcError('CONFIRMATION_REQUIRED', 'Orphan archive cleanup requires confirmDelete: true.');
      }
      const engine = runtime.getDefaultEngine();
      const targetArchive = engine?.archive ?? defaultArchiveStore;
      const targetBackupStore = engine?.backupStore ?? backupStore;
      const targetStateStore = engine?.sessionState ?? defaultStateStore;
      const targetJournal = engine?.journal ?? defaultJournalStore;
      const persistence = getPersistence();
      const cleaned = await targetArchive.cleanupOrphanArchives({
        confirmDelete: true,
        backupRoot: targetBackupStore?.root ?? null,
        stateRoot: targetStateStore?.root ?? null,
        journal: targetJournal,
        sessions: getSessions(),
        backend: persistence,
        sessionPersistence: persistence,
        activeSessionIds: activeArchiveSessionIds(),
      });
      cachedArchiveAt = 0;
      const storage = await collectArchiveStorageSummary(engine, { force: true });
      return { ...cleaned, storage };
    }
    const result = await handleSummaryConfigRpc(payload, summaryConfigPath, llmService ?? getLlmService(ctx));
    if (method === 'set' || method === 'clear') {
      cachedArchiveAt = 0;
      runtime.refreshAllConfigs();
    }
    if (method === 'get' && result && typeof result === 'object') {
      const biliConflict = computeBiliConflict('');
      const defaultEngine = runtime.getDefaultEngine();
      let archiveStorage = null;
      try {
        archiveStorage = await collectArchiveStorageSummary(defaultEngine);
      } catch {
        archiveStorage = null;
      }
      return {
        ...result,
        engineActive: Boolean(defaultEngine),
        ...(biliConflict ? { biliConflict } : {}),
        ...(archiveStorage ? { archiveStorage } : {}),
      };
    }
    return result;
  };

  // Settings page transport. The host half only reads/writes the plugin-owned
  // JSON file; it never touches the profile patch or the session log.
  ctx.inject?.(['webServer'], host => {
    let disposeIndexInject = null;
    const cleanupIndexInject = () => {
      if (typeof disposeIndexInject === 'function') {
        const fn = disposeIndexInject;
        disposeIndexInject = null;
        fn();
      }
    };
    try {
      const rpcToken = getProcessRpcToken();
      try {
        if (typeof host?.on === 'function') {
          disposeIndexInject = host.on('webserver/index-inject', (table, peer) => {
            if (peer !== undefined && peer?.principal?.kind !== 'owner') return;
            if (
              Array.isArray(table) &&
              !table.some(row => row?.kind === 'global' && row?.name === '__WEAVE_RPC_TOKEN__')
            ) {
              table.push({ kind: 'global', name: '__WEAVE_RPC_TOKEN__', value: rpcToken });
            }
          });
        }
      } catch (injectError) {
        ctx.logger?.warn?.(
          `[compaction-weave] webserver/index-inject unavailable: ${injectError?.message ?? injectError}`,
        );
      }
      const getConnection = () => connectionService ?? getOptionalService(host, 'connection') ?? getOptionalService(ctx, 'connection');
      return host.effect(
        () => {
          const disposeRoute = host.webServer.register({
            kind: 'exact',
            path: SUMMARY_RPC_PATH,
            handler: (request, response) =>
              serveSummaryConfigRpc(
                request,
                response,
                handleRuntimeRpc,
                { getConnection, webServer: host.webServer, rpcToken },
              ),
          });
          return () => {
            try {
              if (typeof disposeRoute === 'function') disposeRoute();
            } finally {
              cleanupIndexInject();
            }
          };
        },
        'compaction-weave: summary settings route',
      );
    } catch (error) {
      try { cleanupIndexInject(); } catch {}
      ctx.logger?.warn?.(
        `[compaction-weave] summary settings route unavailable: ${error?.message ?? error}`,
      );
    }
  });

  // Expose cross-isolate runtime bridge so engines share progressTracker & backupStore.
  provideRuntimeService(ctx, runtime);

  if (typeof ctx.on !== 'function') {
    ctx.logger?.warn?.('[compaction-weave] ctx.on is unavailable; the engine will not be installed');
    return;
  }

  // Fallback liveness tracking for compactions not mediated by `progressTracker`.
  ctx.on('session/event', (session, event) => {
    const type = event?.type;
    if (!session?.id) return;
    if (type === 'compaction/end') {
      activeCompactions.delete(session.id);
      return;
    }
    if (progressTracker.hasActiveRun(session.id)) return;
    if (type === 'compaction/start') {
      setBoundedMap(
        activeCompactions,
        session.id,
        {
          startedAt: Date.now(),
          turn: event.data?.turn ?? null,
        },
        128,
      );
    }
  }, { global: true });

  ctx.on('session/disposed', (payload) => {
    const rawId =
      typeof payload === 'string'
        ? payload
        : (payload?.sessionId ?? payload?.session?.id ?? payload?.id ?? null);
    const sid = typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim() : null;
    if (!sid) return;
    activeCompactions.delete(sid);
    biliRuntimeSignals.delete(sid);
    if (!progressTracker.hasActiveRun(sid)) progressTracker.clear(sid);
    invalidateBackupSummaryCache(backupStore, sid);
  }, { global: true });

  ctx.on(
    'internal/config',
    function onInternalConfig(_raw, next) {
      const resolved = next();
      const rows = pluginRowsOf(resolved);
      if (rows === null) return resolved;

      const biliCount = findEnabledBiliPluginRows(rows);
      if (biliCount > 0) {
        enabledBiliRows = Math.max(enabledBiliRows, biliCount);
        ctx.logger?.warn?.(
          `[compaction-weave] detected ${biliCount} enabled billion-context plugin row(s) in config; disable/uninstall billion-context and restart DSH to avoid compaction and proxy conflicts`,
        );
      }

      const matched = countEngineRows(rows);
      if (matched === 0) return resolved;

      const entryName = readEntryName(this);
      const rewritten =
        mode === 'disable-and-inject'
          ? injectBesideOfficial(rows, engineConfig)
          : renameOfficialRows(rows, engineConfig);

      if (rewritten === null) return resolved;
      rememberEngineRows(rewritten.plugins);

      state.rewrites += 1;
      ctx.logger?.info?.(
        `[compaction-weave] engine installed in ${entryName} (mode=${mode}, ${matched} official row(s) rewritten)`,
      );
      if (rewritten.strippedDisabled > 0) {
        ctx.logger?.warn?.(
          `[compaction-weave] stripped stale disabled: true on ${rewritten.strippedDisabled} replaced compaction row(s) (may be left over from billion-context or another plugin that modifies compaction-basic) so Weave can mount cleanly`,
        );
      }
      if (rewritten.inheritedAutoFalse > 0) {
        ctx.logger?.warn?.(
          `[compaction-weave] detected inherited auto: false on ${rewritten.inheritedAutoFalse} replaced compaction row(s) (may be left over from billion-context or another plugin that modifies compaction-basic); automatic pressure compaction stays disabled unless auto: false is removed or engine.auto: true is configured`,
        );
      }
      // 落一份回执，仅保留计数摘要，绝不写入 sibling 插件配置正文。
      void writeReceipt(logPath, {
        at: new Date().toISOString(),
        entry: entryName,
        mode,
        matched,
        rewritten: {
          rewritten: rewritten.rewritten ?? 0,
          strippedDisabled: rewritten.strippedDisabled ?? 0,
          inheritedAutoFalse: rewritten.inheritedAutoFalse ?? 0,
        },
      }).catch(() => {});

      return withPluginRows(resolved, rewritten.plugins);
    },
    { global: true },
  );

  ctx.logger?.info?.(`[compaction-weave] gate ready (mode=${mode})`);

  // 对外宣告"gate 已就绪"。目标 preset 行在 `cordis.patch.yml` 里声明
  // `inject: [compactionWeaveGate]`，于是它们会等这个服务出现之后才开始解析
  // 自己的配置 —— 那时代理已经装好，改写一定赶得上。
  provideGateService(ctx, state);

  return () => {
    // 服务由 fiber 拥有，卸载时自动注销；这里只留一个显式 disposer 的钩子，
    // 方便测试与将来需要手动撤销的场合。
    liveEngines.clear();
    activeCompactions.clear();
    biliRuntimeSignals.clear();
    recoveryConfigs.clear();
  };
}

function provideRuntimeService(ctx, runtime) {
  try {
    if (typeof ctx.provide === 'function') {
      ctx.provide(RUNTIME_SERVICE, runtime);
      return;
    }
    if (typeof ctx.reflect?.provide === 'function') {
      ctx.reflect.provide(RUNTIME_SERVICE, runtime);
      return;
    }
  } catch (error) {
    ctx.logger?.warn?.(
      `[compaction-weave] could not expose ${RUNTIME_SERVICE}: ${error?.message ?? error}`,
    );
  }
}

/**
 * 把 gate 暴露成一个服务，供 preset 行 `inject` 等待。
 * @param {object} ctx
 * @param {{rewrites: number, seenEntries: Set<string>}} state
 */
function provideGateService(ctx, state) {
  const value = Object.freeze({
    owner: 'dsh-compaction-weave',
    ready: true,
    rewrites: () => state.rewrites,
  });
  try {
    if (typeof ctx.provide === 'function') {
      ctx.provide(GATE_SERVICE, value);
      return;
    }
    if (typeof ctx.reflect?.provide === 'function') {
      ctx.reflect.provide(GATE_SERVICE, value);
      return;
    }
  } catch (error) {
    // 名字被占用、或当前 fiber 没资格 provide：降级为"没有屏障"，
    // 让 gate 仍然能靠 internal/config 生效（只是不保证先后）。
    ctx.logger?.warn?.(
      `[compaction-weave] could not expose ${GATE_SERVICE}: ${error?.message ?? error}; ` +
        'load order is not guaranteed',
    );
  }
}

// ──────────────────────────────────────────────────────────────── 配置树改写

/**
 * 从 `internal/config` 的解析结果里取出插件行数组。
 *
 * 已知形态是 `{ plugins: [...] }`（bili 的 gate 就是这么读的）。但不同 DSH 版本
 * 可能直接传数组，或者包在 `config.plugins` 里，所以这里三种都认；认不出返回 null，
 * 调用方原样返回、不做任何改写 —— 宁可不动，也不要改错结构。
 *
 * @param {unknown} resolved
 * @returns {any[] | null}
 */
function pluginRowsOf(resolved) {
  if (Array.isArray(resolved)) return looksLikePluginRows(resolved) ? resolved : null;
  if (!resolved || typeof resolved !== 'object') return null;
  if (Array.isArray(resolved.plugins)) return resolved.plugins;
  if (Array.isArray(resolved.config?.plugins)) return resolved.config.plugins;
  return null;
}

/**
 * 把改写后的行数组放回原来的容器形状。
 * @param {unknown} resolved
 * @param {any[]} rows
 */
function withPluginRows(resolved, rows) {
  if (Array.isArray(resolved)) return rows;
  if (Array.isArray(resolved.plugins)) return { ...resolved, plugins: rows };
  return { ...resolved, config: { ...resolved.config, plugins: rows } };
}

/**
 * 判断一个 `config` 值是不是「插件行数组」。
 *
 * 官方 group 行会写 `group: true`，但 preset 里包住 group 的那一层不一定声明
 * `group`（`preset-standard` 的 config 就是裸数组）。所以不能只看 `group`
 * 标志，否则会漏掉 preset 内部的嵌套行 —— 那正是我们要改的地方。
 *
 * @param {unknown} value
 */
function looksLikePluginRows(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  let rowLike = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    if (typeof item.name === 'string' || typeof item.id === 'string') rowLike += 1;
  }
  return rowLike > 0;
}

/**
 * 找出一行里嵌套的插件行，并告诉调用方它们挂在哪里。
 *
 * 两种真实形态都要认：
 *   1. `cordis:group` 行 → `config` 直接是行数组
 *        - id: compaction
 *          name: cordis:group
 *          config: [ {id: compaction-basic, ...} ]
 *   2. `@deepseek-ai/dsh-agent-preset` 行 → `config.plugins` 是行数组
 *        - id: preset-cordis
 *          name: '@deepseek-ai/dsh-agent-preset'
 *          config: { id: cordis, order: 4, plugins: [ ... ] }
 *
 * 只认第一种的话，一旦宿主把整棵树（含 preset 声明）交给钩子，preset 内部
 * 就永远改不到 —— 那正是压缩完全没被接管的那种"看起来装上了"的故障。
 *
 * @param {any} row
 * @returns {{ key: 'config'|'plugins', rows: any[] } | null}
 */
function childRowsOf(row) {
  if (!row || typeof row !== 'object') return null;
  if (looksLikePluginRows(row.config)) return { key: 'config', rows: row.config };
  if (row.config && typeof row.config === 'object' && looksLikePluginRows(row.config.plugins)) {
    return { key: 'plugins', rows: row.config.plugins };
  }
  return null;
}

/** 把改写后的子行放回它原来挂的位置。 */
function withChildRows(row, key, rows) {
  if (key === 'config') return { ...row, config: rows };
  return { ...row, config: { ...row.config, plugins: rows } };
}

/**
 * 递归统计配置树里有多少个官方引擎行（含 group / preset 的嵌套 config）。
 * @param {readonly any[]} rows
 */
export function countEngineRows(rows) {
  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (
      typeof row.name === 'string' &&
      (OFFICIAL_ENGINE_PACKAGES.has(row.name) || row.name === COMMAND_COMPACT_PACKAGE)
    ) {
      total += 1;
    }
    const child = childRowsOf(row);
    if (child !== null) total += countEngineRows(child.rows);
  }
  return total;
}

/**
 * 把官方引擎行原地换成我们的引擎，保留 id、位置与 isolate 归属。
 * 原有 config 会被合并进新行（这样 bili 写过的 auto:false 之类不会丢）。
 *
 * @param {readonly any[]} rows
 * @param {Record<string, unknown>} engineConfig
 * @returns {{plugins: any[], rewritten: number} | null}
 */
export function renameOfficialRows(rows, engineConfig) {
  let rewritten = 0;
  let strippedDisabled = 0;
  let inheritedAutoFalse = 0;

  const walk = (list) => {
    let changed = false;
    const out = list.map((row) => {
      if (!row || typeof row !== 'object') return row;

      if (row.name === COMMAND_COMPACT_PACKAGE) {
        changed = true;
        return {...row,name:COMMAND_SPECIFIER};
      }
      if (typeof row.name === 'string' && OFFICIAL_ENGINE_PACKAGES.has(row.name)) {
        rewritten += 1;
        changed = true;
        const merged = {
          ...(row.config && typeof row.config === 'object' ? row.config : {}),
          ...engineConfig,
        };
        const nextRow = { ...row, name: ENGINE_SPECIFIER, config: merged };
        if (nextRow.disabled === true) {
          delete nextRow.disabled;
          strippedDisabled += 1;
        }
        if (merged.auto === false && engineConfig?.auto === undefined) {
          inheritedAutoFalse += 1;
        }
        return nextRow;
      }

      const child = childRowsOf(row);
      if (child !== null) {
        const nested = walk(child.rows);
        if (nested.changed) {
          changed = true;
          return withChildRows(row, child.key, nested.list);
        }
      }
      return row;
    });
    return { list: changed ? out : list, changed };
  };

  const result = walk(rows);
  if (!result.changed) return null;
  return { plugins: result.list, rewritten, strippedDisabled, inheritedAutoFalse };
}

/**
 * 备用模式：不换名，而是把官方行关掉，并在同一层追加我们的引擎行。
 * 只在 `mode: disable-and-inject` 时使用；保留它是为了万一"换名"在某个
 * DSH 版本里不被 loader 接受时，有一条不需要改代码的退路。
 *
 * @param {readonly any[]} rows
 * @param {Record<string, unknown>} engineConfig
 */
export function injectBesideOfficial(rows, engineConfig) {
  let rewritten = 0;
  let inheritedAutoFalse = 0;

  const walk = (list) => {
    const out = [];
    let changed = false;
    for (const row of list) {
      if (!row || typeof row !== 'object') {
        out.push(row);
        continue;
      }
      if (row.name === COMMAND_COMPACT_PACKAGE) {
        changed = true;
        out.push({...row,name:COMMAND_SPECIFIER});
        continue;
      }
      if (typeof row.name === 'string' && OFFICIAL_ENGINE_PACKAGES.has(row.name)) {
        const weaveId = `${typeof row.id === 'string' ? row.id : 'compaction'}-weave`;
        const alreadyInjected =
          list.some((r) => r && typeof r === 'object' && (r.id === weaveId || r.name === ENGINE_SPECIFIER)) ||
          out.some((r) => r && typeof r === 'object' && (r.id === weaveId || r.name === ENGINE_SPECIFIER));
        if (alreadyInjected) {
          if (row.disabled !== true) {
            rewritten += 1;
            changed = true;
            out.push({ ...row, disabled: true });
          } else {
            out.push(row);
          }
          continue;
        }
        rewritten += 1;
        changed = true;
        const merged = {
          ...(row.config && typeof row.config === 'object' ? row.config : {}),
          ...engineConfig,
        };
        if (merged.auto === false && engineConfig?.auto === undefined) {
          inheritedAutoFalse += 1;
        }
        const { disabled: _disabled, ...inheritedRow } = row;
        out.push({ ...row, disabled: true });
        out.push({
          ...inheritedRow,
          id: weaveId,
          name: ENGINE_SPECIFIER,
          config: merged,
        });
        continue;
      }
      const child = childRowsOf(row);
      if (child !== null) {
        const nested = walk(child.rows);
        if (nested.changed) {
          changed = true;
          out.push(withChildRows(row, child.key, nested.list));
          continue;
        }
      }
      out.push(row);
    }
    return { list: changed ? out : list, changed };
  };

  const result = walk(rows);
  if (!result.changed) return null;
  return { plugins: result.list, rewritten, strippedDisabled: 0, inheritedAutoFalse };
}

// ──────────────────────────────────────────────────────────────── 杂项

/**
 * cordis 把监听器的 `this` 指向发事件的 context；bili 用同样的方式拿 entry 名。
 * 拿不到时给一个可读的占位，不影响改写。
 */
function readEntryName(listenerThis) {
  try {
    const raw = listenerThis?.entry?.options?.name;
    if (typeof raw === 'string' && raw.length > 0) return raw.slice(0, 120);
  } catch {
    // 忽略：读不到就用占位名
  }
  return 'unknown-entry';
}

const DUPLICATE_HEADER = Symbol('duplicate-header');

function headerValues(request, name) {
  const headers = request?.headers;
  if (!headers || typeof headers !== 'object') return [];
  const lower = name.toLowerCase();
  const out = [];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== lower) continue;
    const val = headers[key];
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item !== undefined) out.push(item);
      }
    } else {
      out.push(val);
    }
  }
  return out;
}

function singleHeaderOf(request, name) {
  const values = headerValues(request, name);
  if (values.length === 0) return undefined;
  if (values.length > 1) return DUPLICATE_HEADER;
  return values[0];
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

function normalizeHostName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function isLoopbackHostName(hostname) {
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function isLoopbackRemoteAddress(remoteAddress) {
  if (typeof remoteAddress !== 'string' || !remoteAddress.trim()) return false;
  const cleaned = remoteAddress.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const withoutZone = cleaned.includes('%') ? cleaned.slice(0, cleaned.indexOf('%')) : cleaned;
  if (withoutZone === '::1' || withoutZone === 'localhost') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(withoutZone)) return true;
  if (/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(withoutZone)) return true;
  return false;
}

function parseAuthority(hostText, protocol) {
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  let url;
  try {
    url = new URL(`${protocol}//${hostText}`);
  } catch {
    return null;
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    return null;
  }
  return url;
}

function hasValidRpcToken(request, expectedToken) {
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) return false;
  const provided = singleHeaderOf(request, 'x-weave-rpc-token');
  if (typeof provided !== 'string') return false;
  const trimmed = provided.trim();
  if (trimmed.length === 0) return false;
  const providedBuf = Buffer.from(trimmed, 'utf8');
  const expectedBuf = Buffer.from(expectedToken, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

function classifyReferer(request, trimmedHost) {
  const referer = singleHeaderOf(request, 'referer');
  if (referer === undefined) return 'absent';
  if (referer === DUPLICATE_HEADER || typeof referer !== 'string') return 'invalid';
  const trimmed = referer.trim();
  if (!trimmed) return 'absent';
  let refererUrl;
  try {
    refererUrl = new URL(trimmed);
  } catch {
    return 'invalid';
  }
  if (refererUrl.protocol !== 'http:' && refererUrl.protocol !== 'https:') return 'invalid';
  if (refererUrl.username || refererUrl.password) return 'invalid';
  const expectedHost = parseAuthority(trimmedHost, refererUrl.protocol);
  return expectedHost !== null && refererUrl.host === expectedHost.host ? 'same-origin' : 'invalid';
}

/** Same-origin and loopback/bound-host guard for the settings RPC route. */
function allowSameOrigin(
  request,
  response,
  { webServer = null, hostAuthenticated = false, tokenAuthenticated = false, requireLoopbackHost = false } = {},
) {
  const fetchSiteValues = headerValues(request, 'sec-fetch-site');
  const fetchSiteTokens = [];
  for (const raw of fetchSiteValues) {
    if (typeof raw !== 'string') {
      sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'invalid sec-fetch-site header' } });
      return false;
    }
    for (const part of raw.split(',')) {
      const token = part.trim().toLowerCase();
      if (token) fetchSiteTokens.push(token);
    }
  }
  if (fetchSiteTokens.includes('cross-site') || fetchSiteTokens.includes('cross-origin')) {
    sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'cross-site request refused' } });
    return false;
  }
  const hasFetchSite = fetchSiteTokens.length > 0;
  const fetchSite = fetchSiteTokens.length === 1 ? fetchSiteTokens[0] : '';

  const hostHeader = singleHeaderOf(request, 'host');
  if (hostHeader === DUPLICATE_HEADER) {
    sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'invalid host header' } });
    return false;
  }
  if (typeof hostHeader !== 'string' || !hostHeader.trim()) {
    sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'missing host header' } });
    return false;
  }
  const trimmedHost = hostHeader.trim();
  let parsedHost;
  try {
    parsedHost = new URL(`http://${trimmedHost}`);
  } catch {
    sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'unparsable host header' } });
    return false;
  }
  if (parsedHost.username || parsedHost.password || parsedHost.pathname !== '/' || parsedHost.search || parsedHost.hash) {
    sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'invalid host header' } });
    return false;
  }
  if (!hostAuthenticated) {
    const reqHostname = normalizeHostName(parsedHost.hostname);
    const boundHost = normalizeHostName(webServer?.host);
    const isAllowedHost = requireLoopbackHost
      ? isLoopbackHostName(reqHostname)
      : isLoopbackHostName(reqHostname) || (boundHost.length > 0 && reqHostname === boundHost);
    if (!isAllowedHost) {
      sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'untrusted host refused' } });
      return false;
    }
  }
  const origin = singleHeaderOf(request, 'origin');
  if (origin === DUPLICATE_HEADER) {
    sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'invalid origin' } });
    return false;
  }
  if (typeof origin === 'string' && origin.trim().toLowerCase() === 'null') {
    sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'opaque origin refused' } });
    return false;
  }
  if (origin === undefined || origin === '') {
    if (hostAuthenticated || tokenAuthenticated) return true;
    const refererState = classifyReferer(request, trimmedHost);
    const hasSameOriginFetchSite = fetchSite === 'same-origin' && refererState !== 'invalid';
    const hasSameOriginReferer = refererState === 'same-origin' && (!hasFetchSite || fetchSite === 'same-origin');
    if (hasSameOriginFetchSite || hasSameOriginReferer) return true;
    sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'missing origin refused' } });
    return false;
  }
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'unparsable origin' } });
    return false;
  }
  if (
    (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') ||
    (request?.socket !== undefined && originUrl.protocol !== (request.socket?.encrypted === true ? 'https:' : 'http:')) ||
    originUrl.username ||
    originUrl.password ||
    originUrl.pathname !== '/' ||
    originUrl.search ||
    originUrl.hash
  ) {
    sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'invalid origin' } });
    return false;
  }
  const expectedHost = parseAuthority(trimmedHost, originUrl.protocol);
  if (!expectedHost || originUrl.host !== expectedHost.host) {
    sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'origin does not match host' } });
    return false;
  }
  return true;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    request.on('data', chunk => {
      if (tooLarge) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        const error = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
        error.code = 'payload-too-large';
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function makeRpcError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Optional service lookup; a missing service simply returns null. */
function getOptionalService(ctx, serviceName) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(serviceName) : null;
  } catch {
    return null;
  }
}

/** Optional LLM service lookup; a missing service only disables the catalog. */
function getLlmService(ctx) {
  return getOptionalService(ctx, 'llm');
}

async function serveSummaryConfigRpc(request, response, dispatchRpc, guardOpts = {}) {
  const conn = typeof guardOpts?.getConnection === 'function' ? guardOpts.getConnection() : null;
  let hostAuthenticated = false;
  let tokenAllowedFallback = false;
  if (typeof conn?.admit === 'function') {
    let admission;
    try {
      admission = conn.admit(request);
    } catch {
      sendJson(response, 403, {
        ok: false,
        error: { code: 'forbidden', message: 'host connection admission failed' },
      });
      return;
    }
    if (!admission || typeof admission !== 'object' || Array.isArray(admission)) {
      sendJson(response, 403, {
        ok: false,
        error: { code: 'forbidden', message: 'invalid host admission response' },
      });
      return;
    }
    if ('rejection' in admission) {
      if (admission.rejection !== 401) {
        const statusCode =
          Number.isInteger(admission.rejection) && admission.rejection >= 400 && admission.rejection <= 599
            ? admission.rejection
            : 403;
        sendJson(response, statusCode, {
          ok: false,
          error: { code: 'forbidden', message: 'request refused by host connection policy' },
        });
        return;
      }
      // Electron's cookie-stripped loopback transport may use the boot token,
      // and must use a loopback host/socket and satisfy same-origin checks below.
      tokenAllowedFallback = true;
    } else if (admission.peer && typeof admission.peer === 'object' && !Array.isArray(admission.peer)) {
      if (admission.peer.principal?.kind !== 'owner') {
        sendJson(response, 403, {
          ok: false,
          error: { code: 'forbidden', message: 'owner role required' },
        });
        return;
      }
      hostAuthenticated = true;
    } else {
      sendJson(response, 403, {
        ok: false,
        error: { code: 'forbidden', message: 'invalid host admission response' },
      });
      return;
    }
  } else if (typeof conn?.requestRejection === 'function') {
    let rejection;
    try {
      rejection = conn.requestRejection(request);
    } catch {
      sendJson(response, 403, {
        ok: false,
        error: { code: 'forbidden', message: 'host connection policy failed' },
      });
      return;
    }
    if (rejection !== undefined) {
      sendJson(response, rejection, {
        ok: false,
        error: {
          code: rejection === 401 ? 'unauthorized' : 'forbidden',
          message: rejection === 401 ? 'authentication required' : 'request refused by host connection policy',
        },
      });
      return;
    }
    hostAuthenticated = true;
  } else if (conn && typeof conn === 'object') {
    tokenAllowedFallback = true;
  } else if (request?.socket !== undefined && !isLoopbackRemoteAddress(request.socket?.remoteAddress)) {
    sendJson(response, 403, {
      ok: false,
      error: { code: 'forbidden', message: 'non-loopback request refused without host connection service' },
    });
    return;
  }
  if (tokenAllowedFallback && request?.socket !== undefined && !isLoopbackRemoteAddress(request.socket?.remoteAddress)) {
    sendJson(response, 403, {
      ok: false,
      error: { code: 'forbidden', message: 'non-loopback boot-token fallback refused' },
    });
    return;
  }
  const tokenAuthenticated = hasValidRpcToken(request, guardOpts?.rpcToken);
  if (tokenAllowedFallback && !tokenAuthenticated) {
    sendJson(response, 401, {
      ok: false,
      error: { code: 'unauthorized', message: 'authentication required' },
    });
    return;
  }
  if (!allowSameOrigin(request, response, {
    webServer: guardOpts?.webServer ?? null,
    hostAuthenticated,
    tokenAuthenticated,
    requireLoopbackHost: tokenAllowedFallback,
  })) return;
  if (!hostAuthenticated && headerValues(request, 'x-weave-rpc-token').length > 0 && !tokenAuthenticated) {
    sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'invalid rpc token' } });
    return;
  }
  if (request?.method !== 'POST') {
    sendJson(response, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } });
    return;
  }
  const contentType = singleHeaderOf(request, 'content-type');
  const mediaType = typeof contentType === 'string' ? contentType.split(';', 1)[0].trim().toLowerCase() : '';
  if (mediaType !== 'application/json') {
    sendJson(response, 415, {
      ok: false,
      error: { code: 'unsupported-media-type', message: 'content-type must be application/json' },
    });
    return;
  }
  let payload;
  try {
    const raw = await readBody(request);
    payload = raw === '' ? {} : JSON.parse(raw);
  } catch (error) {
    const isTooLarge = error?.code === 'payload-too-large';
    const code = isTooLarge ? 'payload-too-large' : 'bad-request';
    sendJson(response, isTooLarge ? 413 : 400, {
      ok: false,
      error: { code, message: error instanceof Error ? error.message : 'bad request' },
    });
    return;
  }
  try {
    const value = await dispatchRpc(payload);
    sendJson(response, 200, { ok: true, value });
  } catch (error) {
    sendJson(response, 200, {
      ok: false,
      error: {
        code: typeof error?.code === 'string' ? error.code : 'internal-error',
        message: redactCredentials(error instanceof Error ? error.message : String(error)),
      },
    });
  }
}

function defaultReceiptPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'storages', 'dsh-compaction-weave', 'gate-receipts.jsonl');
}

const MAX_RECEIPT_BYTES = 256 * 1024;
const RECEIPT_TRIM_TARGET_BYTES = Math.floor(MAX_RECEIPT_BYTES * 0.75);

async function writeReceipt(file, record) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  const info = await stat(file).catch(() => null);
  if (info && info.size > MAX_RECEIPT_BYTES) {
    const raw = await readFile(file, 'utf8').catch(() => null);
    if (typeof raw === 'string') {
      const lines = raw.split('\n').filter(Boolean);
      const kept = [];
      let bytes = 0;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i] + '\n';
        const lineBytes = Buffer.byteLength(line, 'utf8');
        if (bytes + lineBytes > RECEIPT_TRIM_TARGET_BYTES && kept.length > 0) break;
        kept.push(line);
        bytes += lineBytes;
      }
      kept.reverse();
      const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmpFile, kept.join(''), { encoding: 'utf8', mode: 0o600 });
      await chmod(tmpFile, 0o600).catch(() => {});
      await rename(tmpFile, file);
    }
  }
}

// 注意：不能 `Object.assign(apply, {name})` —— 函数的 `name` 是只读属性，
// 赋值会在模块加载期直接抛 TypeError。这里用普通对象做默认导出。
export default { name, inject, apply };
