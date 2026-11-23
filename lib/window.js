// L1：窗口确定性。
//
// 这是 bili 最严重的问题之一：同一会话中途，`deepseek-flash` 的窗口被判成
// 917504 / 868928 / 1000000 / 750000 四个值来回跳，一次会话里跳了 353 次。
// 窗口一变，阈值就变，压缩决策随之失效。
//
// window 是会话首次解析的固定答案；safetyWindow 是独立的保守预算，后续只收紧。
// 引擎在 SessionStateStore 的写锁内解析并持久化，跨对象/进程保持首次答案。
// 配置映射优先决定 window；适配器较小的容量始终限制 safetyWindow。
// windowClampMin 仅作用于 fallback，不抬高适配器明示的小窗口。
let cache = new WeakMap();
const persistent = new Map(); // bounded process cache; not the durable source of truth

const MAX_ROUTE_RECORDS = 32;

/** 供测试与"会话被彻底删除"时清场。 */
export function forgetLockedWindow(sessionId, provider, model) {
  if (typeof sessionId !== 'string') return;
  const stable = JSON.stringify([sessionId]);
  const hasRoute =
    typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0;
  if (!hasRoute) {
    persistent.delete(stable);
    return;
  }
  const existing = persistent.get(stable);
  if (!existing || typeof existing !== 'object') return;
  const rk = keyOf(provider, model);
  if (existing.byRoute && typeof existing.byRoute === 'object' && Object.hasOwn(existing.byRoute, rk)) {
    const nextByRoute = { ...existing.byRoute };
    delete nextByRoute[rk];
    const remainingKeys = Object.keys(nextByRoute);
    if (remainingKeys.length === 0 && existing.provider === provider && existing.model === model) {
      persistent.delete(stable);
      return;
    }
    if (existing.provider === provider && existing.model === model && remainingKeys.length > 0) {
      const nextPrimary = nextByRoute[remainingKeys[remainingKeys.length - 1]];
      persistent.set(stable, { ...nextPrimary, byRoute: nextByRoute });
      return;
    }
    persistent.set(stable, { ...existing, byRoute: nextByRoute });
    return;
  }
  if (existing.provider === provider && existing.model === model) {
    persistent.delete(stable);
  }
}

/** 供测试用：清掉所有按逻辑标识保存的锁定值。 */
export function resetWindowCache() {
  persistent.clear();
  cache = new WeakMap();
}

function keyOf(provider, model) {
  return `${provider ?? '?'}/${model ?? '?'}`;
}

/**
 * 从适配器声明里取窗口。`resolveModelInfo` 的返回结构在不同版本里
 * 可能是 `info.context.contextWindow` 或 `info.contextWindow`，两种都认。
 * @param {unknown} info
 * @returns {number|undefined}
 */
export function contextWindowOf(info) {
  if (!info || typeof info !== 'object') return undefined;
  const candidates = [
    info.context?.contextWindow,
    info.contextWindow,
    info.context?.window,
    info.window,
    info.model?.contextWindow,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/**
 * 从适配器声明里取默认输出上限。
 * @param {unknown} info
 * @returns {number|undefined}
 */
export function defaultMaxTokensOf(info) {
  if (!info || typeof info !== 'object') return undefined;
  const candidates = [
    info.defaultMaxTokens,
    info.context?.defaultMaxTokens,
    info.model?.defaultMaxTokens,
    info.maxTokens,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function validateWindowRecord(rec) {
  if (
    !rec ||
    typeof rec !== 'object' ||
    !Number.isFinite(rec.window) ||
    !Number.isFinite(rec.safetyWindow) ||
    !(rec.window > 0) ||
    !(rec.safetyWindow > 0) ||
    rec.safetyWindow > rec.window ||
    rec.firstResolved !== rec.window
  ) {
    throw new Error('invalid durable context window');
  }
}

export function isPollutedWindowRecord(rec) {
  if (!rec || typeof rec !== 'object') return false;
  if (rec.source === 'fallback' || rec.trusted === false) return true;
  return (
    rec.provider === undefined &&
    rec.model === undefined &&
    rec.byRoute === undefined &&
    rec.trusted === undefined &&
    rec.safetyWindow === 200000 &&
    (rec.source === 'fallback' || rec.source === 'locked')
  );
}

function isUntrustedWindowRecord(rec, fallbackFloor, hasRoute) {
  if (!rec || typeof rec !== 'object') return false;
  if (rec.source === 'fallback' || rec.trusted === false) return true;
  return Boolean(
    hasRoute &&
      rec.provider === undefined &&
      rec.model === undefined &&
      rec.byRoute === undefined &&
      rec.trusted === undefined &&
      (rec.safetyWindow === fallbackFloor || rec.safetyWindow === 200000) &&
      (rec.source === 'fallback' || rec.source === 'locked'),
  );
}

function extractRouteRecord(stored, provider, model) {
  if (!stored || typeof stored !== 'object') return undefined;
  const hasRoute =
    typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0;
  if (!hasRoute) return stored;
  const rk = keyOf(provider, model);
  if (stored.byRoute && typeof stored.byRoute === 'object') {
    if (Object.hasOwn(stored.byRoute, rk)) return stored.byRoute[rk];
    if (typeof stored.provider === 'string' && stored.provider.length > 0 && typeof stored.model === 'string' && stored.model.length > 0) {
      return stored.provider === provider && stored.model === model ? stored : undefined;
    }
    return stored.provider === undefined && stored.model === undefined ? stored : undefined;
  }
  if (typeof stored.provider === 'string' && stored.provider.length > 0 && typeof stored.model === 'string' && stored.model.length > 0) {
    return stored.provider === provider && stored.model === model ? stored : undefined;
  }
  return stored;
}

export function resolveLockedRouteWindow(stored, provider, model) {
  const entry = extractRouteRecord(stored, provider, model);
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.safetyWindow === 'number' && Number.isFinite(entry.safetyWindow) && entry.safetyWindow > 0) {
    return entry;
  }
  return null;
}

/**
 * 解析并锁定一个会话（及对应模型路由）的上下文窗口。
 *
 * @param {object} args
 * @param {object} args.session            会话对象（用作 WeakMap 键）
 * @param {string|undefined} args.provider
 * @param {string|undefined} args.model
 * @param {number|undefined} args.adapterWindow   适配器声明的窗口
 * @param {Readonly<Record<string, number>>} args.providerMap  配置里的显式映射
 * @param {number} args.fallback
 * @param {number} args.clampMin
 * @returns {{ window: number, safetyWindow: number, source: 'config'|'adapter'|'fallback'|'locked', firstResolved: number, trusted?: boolean, provider?: string, model?: string, byRoute?: Record<string, any> }}
 */
export function lockWindow(args) {
  const { session, provider, model, adapterWindow, providerMap, fallback, clampMin } = args;
  if (!session || typeof session !== 'object') throw new Error('window locking requires a session');
  const stable = typeof session.id === 'string' ? JSON.stringify([session.id]) : undefined;
  const cached = stable ? persistent.get(stable) : cache.get(session)?.locked;
  const stored = args.persisted ?? cached;
  const previous = extractRouteRecord(stored, provider, model);

  const hasRoute =
    typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0;
  const routeKey = hasRoute ? keyOf(provider, model) : null;
  const mapped = providerMap?.[keyOf(provider, model)];
  const trusted = firstKnown(mapped, adapterWindow);
  const source = typeof mapped === 'number' && Number.isFinite(mapped) && mapped > 0 ? 'config' : trusted !== undefined ? 'adapter' : 'fallback';
  const currentIsTrusted = source === 'config' || source === 'adapter';
  const fallbackFloor = Math.max(fallback, clampMin);
  const candidate = trusted ?? fallbackFloor;
  const safetyCandidate = typeof adapterWindow === 'number' && Number.isFinite(adapterWindow) && adapterWindow > 0 ? Math.min(candidate, adapterWindow) : candidate;
  if (!(Number.isFinite(candidate) && candidate > 0)) throw new Error('invalid context window');

  if (stored) validateWindowRecord(stored);
  if (previous && previous !== stored) validateWindowRecord(previous);

  let nextEntry;
  if (!previous) {
    // 1. Fresh lock for this session or newly switched model route.
    nextEntry = {
      window: candidate,
      firstResolved: candidate,
      safetyWindow: safetyCandidate,
      source,
      trusted: currentIsTrusted,
      ...(hasRoute ? { provider, model } : {}),
    };
  } else if (isUntrustedWindowRecord(previous, fallbackFloor, hasRoute)) {
    if (currentIsTrusted) {
      // 2. Replace untrusted fallback / legacy polluted 200k guess with trusted metadata.
      nextEntry = {
        window: candidate,
        firstResolved: candidate,
        safetyWindow: safetyCandidate,
        source,
        trusted: true,
        ...(hasRoute ? { provider, model } : {}),
      };
    } else {
      // 3. Keep fallback status until a trusted source arrives.
      nextEntry = {
        window: previous.window,
        firstResolved: previous.firstResolved,
        safetyWindow: previous.safetyWindow,
        source: 'fallback',
        trusted: false,
        ...(hasRoute ? { provider, model } : {}),
      };
    }
  } else if (!currentIsTrusted) {
    // 4. Never tighten a trusted window lock using an untrusted fallback guess.
    nextEntry = {
      window: previous.window,
      firstResolved: previous.firstResolved,
      safetyWindow: previous.safetyWindow,
      source: 'locked',
      trusted: true,
      ...(hasRoute ? { provider, model } : (previous.provider && previous.model ? { provider: previous.provider, model: previous.model } : {})),
    };
  } else {
    // 5. Same-route trusted update: immutable window, monotonically tightened safetyWindow (Q13).
    nextEntry = {
      window: previous.window,
      firstResolved: previous.firstResolved,
      safetyWindow: Math.min(previous.safetyWindow, safetyCandidate),
      source: 'locked',
      trusted: true,
      ...(hasRoute ? { provider, model } : (previous.provider && previous.model ? { provider: previous.provider, model: previous.model } : {})),
    };
  }

  const nextByRoute = {};
  if (stored?.byRoute && typeof stored.byRoute === 'object') {
    for (const [k, v] of Object.entries(stored.byRoute)) {
      if (v && typeof v === 'object') nextByRoute[k] = { ...v };
    }
  }
  if (
    stored &&
    typeof stored.provider === 'string' &&
    stored.provider.length > 0 &&
    typeof stored.model === 'string' &&
    stored.model.length > 0
  ) {
    const storedRk = keyOf(stored.provider, stored.model);
    if (!Object.hasOwn(nextByRoute, storedRk)) {
      const { byRoute: _nested, ...storedFlat } = stored;
      nextByRoute[storedRk] = storedFlat;
    }
  }
  if (routeKey) {
    if (Object.hasOwn(nextByRoute, routeKey)) delete nextByRoute[routeKey];
    nextByRoute[routeKey] = { ...nextEntry };
    const routeKeys = Object.keys(nextByRoute);
    while (routeKeys.length > MAX_ROUTE_RECORDS) {
      const oldest = routeKeys.shift();
      delete nextByRoute[oldest];
    }
  }

  const record = {
    ...nextEntry,
    ...(Object.keys(nextByRoute).length > 0 ? { byRoute: nextByRoute } : {}),
  };
  cache.set(session, { locked: record });
  if (stable) { persistent.set(stable, record); if (persistent.size > 1024) persistent.delete(persistent.keys().next().value); }
  return { ...record };
}

/** 取第一个「可信」的窗口值：显式映射优先，其次适配器声明。 */
function firstKnown(mapped, adapterWindow) {
  if (typeof mapped === 'number' && Number.isFinite(mapped) && mapped > 0) return mapped;
  if (typeof adapterWindow === 'number' && Number.isFinite(adapterWindow) && adapterWindow > 0) {
    return adapterWindow;
  }
  return undefined;
}

/**
 * 读取一个会话已经锁定的窗口，不触发解析。
 * @param {object} session
 * @param {string|undefined} provider
 * @param {string|undefined} model
 */
export function peekLockedWindow(session, provider, model) {
  const stored = typeof session?.id === 'string' ? persistent.get(JSON.stringify([session.id])) : cache.get(session)?.locked;
  return extractRouteRecord(stored, provider, model)?.window;
}
