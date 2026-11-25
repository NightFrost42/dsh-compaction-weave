// Token measurement, target/policy routing, spec resolution, and budget/overflow guards.
// All functions accept `engine` as 1st parameter and NEVER import `../engine.js`.

import {
  isBiliProxyPreflightError,
  isNonSnippableCompactionError,
  isWindowOverflowError,
} from '../bili-conflict.js';
import { DEFAULT_CONFIG, resolveCompactSpec, resolveTargetPolicy } from '../config.js';
import {
  commitVisibleImageOffload,
  isImageOffloadRequiredError,
  isUpstreamMultimodal400Error,
  planVisibleImageOffload,
} from '../image-budget.js';
import { estimateContentTokens, estimateHostHeuristicMessage } from '../meter.js';
import { commitPersistedOutput, planPersistedOutput } from '../persisted-output.js';
import { inspectCompactionEntryState, selectCompactableRange } from '../region.js';
import { traceStageAsync } from '../stage-trace.js';
import { latestDurableTarget, liveModelSelectionTarget, resolveSummaryTargets } from '../summary.js';
import { contextWindowOf, defaultMaxTokensOf, lockWindow } from '../window.js';
import {
  captureSessionSurfaceSnapshot,
  isAbortError,
  nextCompactionId,
  sameSessionSurfaceSnapshot,
} from './shared.js';

export async function measure(engine, session) {
  const store = engine._preStepCache?.getStore();
  if (store && session && typeof session === 'object') {
    const entry = store.measures.get(session);
    if (
      entry &&
      entry.meter === engine.ctx.tokenMeter &&
      entry.measureFn === engine.ctx.tokenMeter?.measure &&
      sameSessionSurfaceSnapshot(entry.snap, session)
    ) {
      return entry.result;
    }
  }
  const snapBefore =
    store && session && typeof session === 'object' ? captureSessionSurfaceSnapshot(session) : null;
  const result = await traceStageAsync(
    'measure',
    { surfaceLen: session?.surface?.nodes?.length ?? 0 },
    () => engine._measureInner(session),
    (res) => (res ? { nodes: res.nodes?.length ?? 0, total: res.totalTokens } : { ok: false }),
  );
  if (
    result !== null &&
    store &&
    snapBefore &&
    session &&
    typeof session === 'object' &&
    sameSessionSurfaceSnapshot(snapBefore, session)
  ) {
    store.measures.set(session, {
      meter: engine.ctx.tokenMeter,
      measureFn: engine.ctx.tokenMeter?.measure,
      snap: snapBefore,
      result,
    });
  }
  return result;
}

export async function measureInner(engine, session) {
  const meter = engine.ctx.tokenMeter;
  if (!meter || typeof meter.measure !== 'function') return null;
  try {
    const measurement = await meter.measure(session);
    if (!measurement || typeof measurement !== 'object') return null;

    const rawNodes = Array.isArray(measurement.nodes) ? measurement.nodes : [];
    const nodes = [];
    const priced = new Map();
    for (const node of rawNodes) {
      if (typeof node === 'number') {
        nodes.push(node);
        continue;
      }
      if (!node || typeof node !== 'object' || typeof node.seq !== 'number') continue;
      nodes.push(node.seq);
      const cost =
        typeof node.tokens === 'number' && Number.isFinite(node.tokens) ? node.tokens : node.heuristicTokens;
      if (typeof cost === 'number' && Number.isFinite(cost)) priced.set(node.seq, cost);
    }
    if (nodes.length === 0 && Array.isArray(session.surface?.nodes)) {
      nodes.push(...session.surface.nodes);
    }

    const totalTokens =
      typeof measurement.totalTokens === 'number'
        ? measurement.totalTokens
        : typeof measurement.total === 'number'
          ? measurement.total
          : 0;

    let pricedCount = 0;
    let heuristicCount = 0;
    for (const node of rawNodes) {
      if (!node || typeof node !== 'object') continue;
      const heuristic = node.heuristicTokens;
      const tokens = node.tokens;
      const hasTokens = typeof tokens === 'number' && Number.isFinite(tokens);
      const hasHeuristic = typeof heuristic === 'number' && Number.isFinite(heuristic);
      if (!hasTokens && !hasHeuristic) continue;
      if (!hasTokens) {
        heuristicCount += 1;
        continue;
      }
      if (!hasHeuristic || tokens !== heuristic) pricedCount += 1;
      else heuristicCount += 1;
    }
    const baselineKind = measurement.baseline?.kind;
    const precision =
      pricedCount === 0 && heuristicCount === 0
        ? baselineKind === 'usage'
          ? 'priced'
          : 'unknown'
        : heuristicCount === 0
          ? 'priced'
          : pricedCount === 0
            ? baselineKind === 'usage'
              ? 'mixed'
              : 'heuristic'
            : 'mixed';

    engine._lastPriced = engine._lastPriced ?? new WeakMap();
    engine._lastPriced.set(session, priced);
    engine._lastPrecision = engine._lastPrecision ?? new WeakMap();
    engine._lastPrecision.set(session, precision);
    return { nodes, pricedBySeq: priced, totalTokens, precision, raw: measurement };
  } catch (error) {
    engine.log('warn', `token measurement failed: ${error?.message ?? error}`);
    return null;
  }
}

export function shadowedTokens(engine, session, shadowedSeqs) {
  const priced = engine._lastPriced?.get(session);
  let total = 0;
  for (const seq of shadowedSeqs) {
    const cost = priced?.get(seq);
    if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) {
      total += cost;
      continue;
    }
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
    const message =
      typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : undefined;
    const meter = engine.ctx?.tokenMeter;
    if (message && meter && typeof meter.estimateMessage === 'function') {
      try {
        const est = meter.estimateMessage(message);
        if (typeof est === 'number' && Number.isFinite(est) && est >= 0) {
          total += est;
          continue;
        }
      } catch {
        /* fall back to host heuristic */
      }
    }
    total += estimateHostHeuristicMessage(message);
  }
  return total;
}

export function activeModelSelection(engine, agent) {
  const store = engine?._stepModelSelection?.getStore();
  if (!store?.selection) return undefined;
  if (store.agent && agent && store.agent === agent) return store.selection;
  if (store.session && agent?.session && store.session === agent.session) return store.selection;
  return undefined;
}

export function resolveSummaryTargetsForEngine(engine, policy, agent) {
  return resolveSummaryTargets({
    config: policy,
    agent,
    modelSelection: engine._activeModelSelection(agent),
  });
}

export function resolveTargetRoute(engine, agent, { preferRequestHeader = false } = {}) {
  if (preferRequestHeader) {
    const headerTarget = latestDurableTarget(agent);
    if (headerTarget) return { provider: headerTarget.provider, model: headerTarget.model };
  }
  const selected = liveModelSelectionTarget(agent, engine._activeModelSelection(agent));
  if (selected) {
    return { provider: selected.provider, model: selected.model };
  }
  const durable = latestDurableTarget(agent);
  if (durable) {
    return { provider: durable.provider, model: durable.model };
  }
  const liveProvider = typeof agent?.options?.provider === 'string' ? agent.options.provider.trim() : '';
  const liveModel = typeof agent?.options?.model === 'string' ? agent.options.model.trim() : '';
  return {
    provider: liveProvider || undefined,
    model: liveModel || undefined,
  };
}

export function resolvePolicy(engine, agent) {
  const { provider, model } = engine._resolveTargetRoute(agent);
  return resolveTargetPolicy(engine.config, provider, model);
}

export async function resolveSpec(engine, agent, measurement, signal, { budgetOnly = false } = {}) {
  const session = agent?.session;
  const { provider, model } = engine._resolveTargetRoute(agent);
  const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined;
  const headerMax = header?.config?.maxTokens;
  const headerProvider = typeof header?.config?.provider === 'string' ? header.config.provider : '';
  const headerModel = typeof header?.config?.model === 'string' ? header.config.model : '';
  const store = engine._preStepCache?.getStore();
  if (store && session && typeof session === 'object') {
    const cached = store.specs.get(session);
    if (
      cached &&
      cached.llm === engine.ctx.llm &&
      cached.resolveInfoFn === engine.ctx.llm?.resolveModelInfo &&
      cached.config === engine.config &&
      cached.provider === (provider ?? '') &&
      cached.model === (model ?? '') &&
      cached.headerProvider === headerProvider &&
      cached.headerModel === headerModel &&
      cached.headerMax === headerMax &&
      sameSessionSurfaceSnapshot(cached.snap, session)
    ) {
      signal?.throwIfAborted?.();
      if (budgetOnly && cached.budgetSpec) return cached.budgetSpec;
      if (!budgetOnly && cached.fullSpec) {
        engine._lastSpec = engine._lastSpec ?? new WeakMap();
        engine._lastSpec.set(session, cached.fullSpec);
        return cached.fullSpec;
      }
    }
  }
  const snapBefore =
    store && session && typeof session === 'object' ? captureSessionSurfaceSnapshot(session) : null;

  let adapterInfo;
  try {
    if (provider && model && typeof engine.ctx.llm?.resolveModelInfo === 'function') {
      adapterInfo = await engine.ctx.llm.resolveModelInfo(provider, model, signal);
    }
  } catch {
    adapterInfo = undefined;
  }

  signal?.throwIfAborted?.();
  let locked;
  try {
    const lockPersistedWindow = (persisted) => lockWindow({
      session,
      persisted,
      provider,
      model,
      adapterWindow: contextWindowOf(adapterInfo),
      providerMap: engine.config.windowProviderMap,
      fallback: engine.config.windowFallback,
      clampMin: engine.config.windowClampMin,
    });
    let cached;
    try {
      cached = engine.sessionState.read(session.id);
      locked = lockPersistedWindow(cached?.window);
    } catch {
      // Preserve the locked update/error path when the optimistic read fails.
      cached = undefined;
      locked = undefined;
    }
    if (!cached?.window || JSON.stringify(cached.window) !== JSON.stringify(locked)) {
      engine.sessionState.update(session.id, (state) => {
        // Reconcile another writer's update while holding the durable state lock.
        if (!locked || JSON.stringify(state.window) !== JSON.stringify(cached?.window)) {
          locked = lockPersistedWindow(state.window);
        }
        return { ...state, window: locked };
      });
    }
  } catch (cause) {
    const error = new Error(`durable compaction policy is unavailable: ${cause.message}`);
    error.code = 'STATE_UNAVAILABLE';
    error.cause = cause;
    throw error;
  }
  const reserved = engine._reservedCompletionTokens(agent, defaultMaxTokensOf(adapterInfo), provider, model);
  const effective = resolveTargetPolicy(engine.config, provider, model);
  if (budgetOnly) {
    const messageBudgetTokens = locked.safetyWindow - reserved;
    if (messageBudgetTokens <= 0) {
      throw Object.assign(new Error('No message budget remains after reserving completion tokens.'), {
        code: 'COMPACTION_REQUEST_BUDGET_EXCEEDED',
      });
    }
    const budgetSpec = { messageBudgetTokens, policy: effective };
    if (store && snapBefore && session && typeof session === 'object' && sameSessionSurfaceSnapshot(snapBefore, session)) {
      const prev = store.specs.get(session);
      store.specs.set(session, {
        llm: engine.ctx.llm,
        resolveInfoFn: engine.ctx.llm?.resolveModelInfo,
        config: engine.config,
        provider: provider ?? '',
        model: model ?? '',
        headerProvider,
        headerModel,
        headerMax,
        snap: snapBefore,
        budgetSpec,
        fullSpec: prev && prev.snap && sameSessionSurfaceSnapshot(prev.snap, session) ? prev.fullSpec : null,
      });
    }
    return budgetSpec;
  }
  const fullSpec = {
    ...resolveCompactSpec(effective, locked.safetyWindow, reserved),
    windowSource: locked.source,
    lockedWindow: locked.window,
    safetyWindow: locked.safetyWindow,
    provider,
    model,
    policy: effective,
  };
  if (store && snapBefore && session && typeof session === 'object' && sameSessionSurfaceSnapshot(snapBefore, session)) {
    store.specs.set(session, {
      llm: engine.ctx.llm,
      resolveInfoFn: engine.ctx.llm?.resolveModelInfo,
      config: engine.config,
      provider: provider ?? '',
      model: model ?? '',
      headerProvider,
      headerModel,
      headerMax,
      snap: snapBefore,
      budgetSpec: { messageBudgetTokens: fullSpec.messageBudgetTokens, policy: effective },
      fullSpec,
    });
  }
  if (session && typeof session === 'object') {
    engine._lastSpec = engine._lastSpec ?? new WeakMap();
    engine._lastSpec.set(session, fullSpec);
  }
  return fullSpec;
}

/**
 * Resolve reserved completion tokens for `agent` without crashing when called directly
 * on `WeaveCompactionEngine.prototype` (where `engine` lacks instance fields).
 */
export function reservedCompletionTokens(
  engine,
  agent,
  defaultMaxTokens,
  targetProvider = undefined,
  targetModel = undefined,
) {
  const header = typeof agent?.session?.requestHeader === 'function' ? agent.session.requestHeader() : undefined;
  const hCfg = header?.config;
  const headerMax = hCfg?.maxTokens;
  let resolvedProvider = typeof targetProvider === 'string' && targetProvider.trim() ? targetProvider.trim() : '';
  let resolvedModel = typeof targetModel === 'string' && targetModel.trim() ? targetModel.trim() : '';
  if ((!resolvedProvider || !resolvedModel) && agent) {
    const selected = liveModelSelectionTarget(
      agent,
      typeof engine?._activeModelSelection === 'function' ? engine._activeModelSelection(agent) : undefined,
    );
    if (selected) {
      resolvedProvider = selected.provider;
      resolvedModel = selected.model;
    } else {
      const liveProvider = typeof agent?.options?.provider === 'string' ? agent.options.provider.trim() : '';
      const liveModel = typeof agent?.options?.model === 'string' ? agent.options.model.trim() : '';
      if (liveProvider && liveModel) {
        resolvedProvider = liveProvider;
        resolvedModel = liveModel;
      }
    }
  }
  const hProvider = typeof hCfg?.provider === 'string' ? hCfg.provider.trim() : '';
  const hModel = typeof hCfg?.model === 'string' ? hCfg.model.trim() : '';
  const routeMismatch =
    Boolean(resolvedProvider && resolvedModel) &&
    ((Boolean(hProvider) && hProvider !== resolvedProvider) || (Boolean(hModel) && hModel !== resolvedModel));
  const candidate = (routeMismatch ? undefined : headerMax) ?? defaultMaxTokens ?? 0;
  if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) return candidate;
  return 0;
}

export function estimateCheckpointTokens(engine, blocks) {
  return estimateContentTokens(blocks, 'user', engine?.ctx?.tokenMeter);
}

export function isRecoverable(_engine, error) {
  if (isBiliProxyPreflightError(error) || isNonSnippableCompactionError(error)) return false;
  if (isImageOffloadRequiredError(error) || isUpstreamMultimodal400Error(error)) return true;
  const code = error?.code;
  if (error?.summaryRetryExhausted) return false;
  if (code === 'SUMMARY_ALL_FAILED') return error?.recoverable === true;
  if (code === 'SUMMARY_TIMEOUT' || code === 'NO_SUMMARY_TARGET') return false;
  if (code === 'SUMMARY_NOT_SMALLER') return false;
  if (code === 'ABORTED') return false;
  if (code === 'MAX_TOKENS' || code === 'UNSUPPORTED_CONTENT' || code === 'IMAGE_OFFLOAD_REQUIRED') return true;
  if (isWindowOverflowError(error)) return true;
  return false;
}

export async function dispatchSummaryError(engine, session, sourceEventSeqs, error, signal) {
  if (typeof engine.ctx?.waterfall !== 'function') return false;
  try {
    const accepted = engine.ctx.waterfall(
      'compaction/summary-error',
      { session, sourceEventSeqs, error, ...(signal === undefined ? {} : { signal }) },
      () => false,
    );
    return typeof accepted?.then === 'function' ? await accepted : accepted;
  } catch {
    return false;
  }
}

export async function guardRequestBudget(engine, agent, signal, pressure = true) {
  let measurement = await engine._measure(agent.session);
  if (!measurement || signal?.aborted) return;
  const spec = await engine._resolveSpec(agent, measurement, signal, { budgetOnly: !pressure });
  if (spec && measurement.totalTokens >= spec.messageBudgetTokens) {
    const snipped = await engine._emergencySnip(agent, spec, signal, 'budget-wall');
    if (snipped) {
      const afterSnip = await engine._measure(agent.session);
      if (afterSnip) measurement = afterSnip;
    }
    if (measurement.totalTokens >= spec.messageBudgetTokens) {
      throw engine._automaticFailure(agent.session, { code: 'COMPACTION_REQUEST_BUDGET_EXCEEDED' });
    }
  }
}

export async function guardVisibleImageBudget(engine, agent, signal, options = {}) {
  if (engine._disposed) return null;
  const session = agent?.session;
  if (!session || (engine._busy.has(session) && !options.allowWhileBusy) || signal?.aborted) {
    return null;
  }
  const policy = engine._resolvePolicy(agent);
  const plan = planVisibleImageOffload(session, {
    maxVisibleAttachmentBytes: policy.maxVisibleAttachmentBytes,
    maxVisibleImages: policy.maxVisibleImages,
    ...(options.keepHotImages === undefined ? {} : { keepHotImages: options.keepHotImages }),
    force: options.force === true,
  });
  if (!plan) return null;

  const flushSession =
    typeof engine.ctx.sessions?.flush === 'function' ? (targetSession) => engine._flushSession(targetSession) : null;
  const committed = await commitVisibleImageOffload({
    session,
    plan,
    archive: engine.archive,
    policy,
    log: (lvl, msg) => engine.log(lvl, msg),
    flushSession,
    signal,
  });
  if (!committed) return null;

  engine._invalidateSessionMemory(session.id);
  engine._lastTotal.delete(session);
  engine.log(
    'info',
    `visible-image budget (${committed.mode}, reason=${committed.reason}): offloaded ${committed.offloadCount} image(s), kept ${committed.remainingCount} hot`,
  );
  return committed;
}

export async function spillTailToolOutputs(engine, agent, signal) {
  if (engine._disposed) return null;
  const session = agent?.session;
  if (!session || engine._busy.has(session) || signal?.aborted) return null;
  const policy = engine._resolvePolicy(agent);
  if (
    (policy.persistedOutputEnabled ?? DEFAULT_CONFIG.persistedOutputEnabled) === false ||
    !policy.archiveEnabled ||
    !engine.historyToolsAvailable ||
    inspectCompactionEntryState(session).openTurn === null
  ) {
    return null;
  }
  const plan = planPersistedOutput(session, {
    compactionId: nextCompactionId(),
    thresholdChars: policy.persistedOutputThresholdChars,
    headChars: policy.persistedOutputHeadChars,
    tailChars: policy.persistedOutputTailChars,
  });
  if (!plan) return null;
  const flushSession =
    typeof engine.ctx.sessions?.flush === 'function' ? (targetSession) => engine._flushSession(targetSession) : null;
  const committed = await commitPersistedOutput({
    session,
    plan,
    archive: engine.archive,
    log: (lvl, msg) => engine.log(lvl, msg),
    flushSession,
    signal,
  });
  if (!committed) return null;
  engine._invalidateSessionMemory(session.id);
  engine.log(
    'info',
    `persisted-output spilled ${committed.maskedSeqs.length} tail tool result(s), saved ~${committed.shadowedTokenCount} tok`,
  );
  return committed;
}

export async function pruneToolResults(engine, session) {
  try {
    const pruner = typeof engine.ctx.get === 'function' ? engine.ctx.get('toolResultPruner') : undefined;
    if (pruner && typeof pruner.pruneSession === 'function') {
      await pruner.pruneSession(session);
    }
  } catch (error) {
    engine.log('warn', `tool-result pruning failed: ${error?.message ?? error}`);
  }
}

export async function reactiveRetry(engine, agent, signal) {
  const session = agent?.session;
  if (!session) return false;
  engine._restoreState(session);
  if (engine._stopped.has(engine._keyOf(session))) return false;
  if (engine._busy.has(session)) return false;
  const nodes = session.surface?.nodes ?? [];
  if (nodes.length < 3) return false;

  const measurement = await engine._measure(session);
  if (!measurement) return false;

  let spec;
  try {
    spec = await engine._resolveSpec(agent, measurement, signal);
  } catch (error) {
    if (!isAbortError(error, signal)) engine._recordFailure(agent, session, error);
    throw error;
  }
  if (!spec) return false;

  let previousEndIdx = -1;
  for (let extra = 1; extra <= engine.config.reactiveStep; extra += 1) {
    if (signal?.aborted) return false;
    engine._restoreState(session);
    if (engine._stopped.has(engine._keyOf(session))) return false;
    let retain = spec.retainTokens + extra * Math.max(1024, Math.floor(spec.retainTokens * 0.25));
    let range = null;
    for (let step = 0; step < 64; step += 1) {
      const remeasured = step === 0 ? measurement : await engine._measure(session);
      if (!remeasured) return false;
      const candidate = selectCompactableRange(session, remeasured, retain);
      if (!candidate) break;
      const endIdx = nodes.indexOf(candidate.end);
      if (previousEndIdx < 0 || (endIdx >= 0 && endIdx < previousEndIdx)) {
        range = candidate;
        break;
      }
      retain = Math.ceil(retain * 1.5) + 1024;
    }
    if (!range) {
      engine.log('warn', 'reactive recovery found no strictly smaller span; giving up instead of repeating the same request');
      return false;
    }
    try {
      const compacted = await engine.compactRegion(range.start, range.end, agent, signal);
      if (!compacted) {
        engine.log('info', `reactive compaction skipped with retainTokens=${retain}`);
        return false;
      }
      engine.log('info', `reactive compaction succeeded with retainTokens=${retain}`);
      return true;
    } catch (error) {
      if (signal?.aborted) return false;
      const endIdx = nodes.indexOf(range.end);
      if (endIdx >= 0) previousEndIdx = endIdx;
      engine.log('warn', `reactive attempt ${extra} failed: ${error?.message ?? error}`);
    }
  }
  return false;
}

export function restoreClaimedInput(_engine, agent, messages) {
  if (!Array.isArray(messages) || !messages.length) return;
  if (typeof agent.inbox?.prepend !== 'function') {
    throw new Error('Compaction stopped; host inbox cannot restore claimed input.');
  }
  for (const message of [...messages].reverse()) {
    if ([...(agent.inbox.nextStep ?? []), ...(agent.inbox.nextTurn ?? [])].some((m) => m.id === message.id)) continue;
    agent.inbox.prepend('next-step', message);
  }
}
