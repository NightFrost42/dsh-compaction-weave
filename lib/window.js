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

/** 供测试与"会话被彻底删除"时清场。 */
export function forgetLockedWindow(sessionId, provider, model) {
  persistent.delete(JSON.stringify([sessionId]));
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

/**
 * 解析并锁定一个会话的上下文窗口。
 *
 * @param {object} args
 * @param {object} args.session            会话对象（用作 WeakMap 键）
 * @param {string|undefined} args.provider
 * @param {string|undefined} args.model
 * @param {number|undefined} args.adapterWindow   适配器声明的窗口
 * @param {Readonly<Record<string, number>>} args.providerMap  配置里的显式映射
 * @param {number} args.fallback
 * @param {number} args.clampMin
 * @returns {{ window: number, source: 'config'|'adapter'|'fallback'|'locked', firstResolved: number }}
 */
export function lockWindow(args) {
  const { session, provider, model, adapterWindow, providerMap, fallback, clampMin } = args;
  if (!session || typeof session !== 'object') throw new Error('window locking requires a session');
  const stable = typeof session.id === 'string' ? JSON.stringify([session.id]) : undefined;
  let previous = args.persisted ?? (stable ? persistent.get(stable) : cache.get(session)?.locked);
  const mapped = providerMap?.[keyOf(provider, model)];
  const trusted = firstKnown(mapped, adapterWindow);
  const source = typeof mapped === 'number' && Number.isFinite(mapped) && mapped > 0 ? 'config' : trusted !== undefined ? 'adapter' : 'fallback';
  const candidate = trusted ?? Math.max(fallback, clampMin);
  const safetyCandidate = typeof adapterWindow === 'number' && Number.isFinite(adapterWindow) && adapterWindow > 0 ? Math.min(candidate, adapterWindow) : candidate;
  if (!(Number.isFinite(candidate) && candidate > 0)) throw new Error('invalid context window');
  if (previous && (!Number.isFinite(previous.window) || !Number.isFinite(previous.safetyWindow) || !(previous.window > 0) || !(previous.safetyWindow > 0) || previous.safetyWindow > previous.window || previous.firstResolved !== previous.window)) throw new Error('invalid durable context window');
  // window is the immutable session answer. safetyWindow is a separate conservative budget.
  const record = previous
    ? { ...previous, safetyWindow: Math.min(previous.safetyWindow, safetyCandidate), source: 'locked' }
    : { window: candidate, firstResolved: candidate, safetyWindow: safetyCandidate, source };
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
  return (typeof session?.id === 'string' ? persistent.get(JSON.stringify([session.id])) : cache.get(session)?.locked)?.window;
}
