// 手动 `/compact` 的错误协议。
//
// 宿主的 `dsh-command-compact` 只把 `ManualCompactionError` 翻译成人话，
// 其它任何 Error 都**原样 rethrow**（`dsh-command-compact/lib/index.js:65-72`）：
//
//   } catch (error) {
//     if (invocation.signal.aborted) return { kind: 'error', text: 'Compaction cancelled.' };
//     if (error instanceof ManualCompactionError) return expectedFailure(error);
//     throw error;
//   }
//
// 也就是说：抛普通 Error 不会变成"用户看到一句解释"，而是变成命令层的未处理
// 异常。所以引擎在手动路径上抛出的每一个失败，都必须是**宿主那个类的实例**。
//
// ⚠️ 光"长得一样"没用。`instanceof` 只认同一个类对象，自己在本文件里再声明一个
// 同名同码的类，`error instanceof HostClass` 依然是 `false`，仍然会 rethrow。
// 唯一可靠的做法是拿到宿主模块导出的那个构造函数本身。
//
// 插件自己 `import('@deepseek-ai/dsh-compaction')` 解析不到（插件目录与 profile
// 目录都没有可用的 `node_modules`）。但宿主进程里有个现成的加载器：`ctx.loader`
// 由 `cordis-plugin-loader` 在启动时 `provide('loader', this)`，它的
// `import(name, getOuterStack)` 是以**加载器自身位置**为基准解析裸导入的
// （`cordis-plugin-loader/lib/index.js:214-228`），而那个位置就在宿主自己的
// `node_modules` 里 —— 宿主的 `dsh-command-compact` 正是这么拿到这个类的。
//
// 取不到时退回同形实现：至少 `code` 落在 `expectedFailure` 的六个分支内，
// 任何按 `code` 分类的消费方仍能读懂；只是 `instanceof` 这条路过不去。

/** 官方 `ManualCompactionErrorCode` 的封闭取值（`expectedFailure` 的六个分支）。 */
export const MANUAL_CODES = Object.freeze([
  'busy',
  'cancelled',
  'changed',
  'summary',
  'commit',
  'persistence',
]);

/** 同形实现。字段顺序与官方一致：`code` 先声明，`name` 用类字段覆盖。 */
export class ManualCompactionError extends Error {
  code;

  name = 'ManualCompactionError';

  constructor(code, message, options) {
    super(message, options);
    this.code = code;
  }
}

/**
 * 通过宿主加载器取回**真正的** `ManualCompactionError` 构造函数。
 *
 * 全程 best-effort：任何一步不成立（没有 loader、加载器拒绝、导出表里没有这个
 * 名字）都返回 `null`，由调用方退回同形实现。绝不因为拿不到类而让插件加载失败。
 *
 * @param {object} ctx
 * @returns {Promise<Function|null>}
 */
export async function loadHostManualErrorClass(ctx) {
  const loader = typeof ctx?.get === 'function' ? ctx.get('loader') : undefined;
  if (!loader || typeof loader.import !== 'function') return null;
  try {
    // 第二个参数是出错时取外层调用栈的回调，只在异常路径上被调用。
    const mod = await loader.import('@deepseek-ai/dsh-compaction', () => '');
    const ctor = mod?.ManualCompactionError;
    return typeof ctor === 'function' ? ctor : null;
  } catch {
    return null;
  }
}

/** ctx → Promise<类|null>。每个 realm 只解析一次，失败也记住，避免每次失败都重试。 */
const HOST_CLASS_CACHE = new WeakMap();

/**
 * 惰性取宿主类（带缓存）。
 *
 * 放在**抛错那一刻**才解析，而不是插件启动时：拿不到类不影响插件加载，
 * 而失败路径本来就罕见，多一次 await 不构成性能问题。反过来，启动期解析一旦
 * 遇到加载器尚未就绪，就会永久记住 `null`，手动命令的错误协议就再也修不回来。
 */
export function hostManualErrorClass(ctx) {
  if (!ctx || typeof ctx !== 'object') return Promise.resolve(null);
  let pending = HOST_CLASS_CACHE.get(ctx);
  if (pending === undefined) {
    pending = loadHostManualErrorClass(ctx);
    HOST_CLASS_CACHE.set(ctx, pending);
  }
  return pending;
}

export function isManualCompactionError(error) {
  return Boolean(error) && error.name === 'ManualCompactionError' && MANUAL_CODES.includes(error.code);
}

/**
 * 把引擎内部的细分错误码映射到官方六个码。
 *
 * 内部码比官方多（`SPAN_CHANGED`、`SUMMARY_NOT_SMALLER`、`SUMMARY_TIMEOUT`…），
 * 直接抛出去会让 `expectedFailure` 的 `assertNever` 抛
 * `TypeError: unknown manual compaction error code` —— 比原来的普通 Error 更糟。
 */
export function toManualCode(code, stage) {
  switch (code) {
    case 'busy':
      return 'busy';
    case 'cancelled':
    case 'ABORTED':
      return 'cancelled';
    case 'changed':
    case 'SPAN_CHANGED':
      return 'changed';
    case 'commit':
      return 'commit';
    case 'persistence':
      return 'persistence';
    case 'summary':
    case 'SUMMARY_NOT_SMALLER':
    case 'SUMMARY_TIMEOUT':
    case 'SUMMARY_ALL_FAILED':
    case 'NO_SUMMARY_TARGET':
    case 'MAX_TOKENS':
    case 'UNSUPPORTED_CONTENT':
    case 'CONTEXT_WINDOW_EXCEEDED':
    // 归档失败发生在提交之前，但它的后果属于"摘要没能变成可用的替代品"，
    // 归到 `summary` 比 `commit` 更贴切：surface 一个字节都没动。
    case 'ARCHIVE_FAILED':
    // 约束审计拦下的三类同理 —— 都是"这份摘要不能用"，surface 没动过。
    // 真正的细分原因在 `cause` 里，用户从 `/compact` 的输出看不到码，
    // 但日志和 `error.cause.code` 都保留着。
    case 'CONSTRAINT_LOST':
    case 'CONSTRAINT_POLARITY_LOST':
    case 'AUDIT_UNAVAILABLE':
      return 'summary';
    default:
      // 未知码按阶段归类：已经进到提交段 = commit，否则 = summary。
      return stage === 'commit' ? 'commit' : 'summary';
  }
}

/**
 * 把手动压缩路径上的任意失败收敛成官方形状。
 *
 * 用一个统一出口而不是在每个 throw 点各写一遍：手动压缩要穿过
 * `compactNow → _compactManual → _compactRegionCore → _compactSpan` 四层，
 * 中间任何一层新增一个 throw，逐点改造时都会漏。
 *
 * 已经是正确形状的（比如别处抛进来的 ManualCompactionError）原样返回，
 * 这样重试/递归路径上的错误不会被二次包装。
 */
export function asManualError(error, stage) {
  if (isManualCompactionError(error)) return error;
  const code = toManualCode(error?.code, stage ?? error?.compactionStage);
  const message = error?.message ?? String(error);
  return new ManualCompactionError(code, message, { cause: error });
}

/**
 * 优先产出**宿主类**的实例（这才是 `instanceof` 认的那个）。
 *
 * 取不到宿主类时退回 `asManualError` 的同形实现：`instanceof` 过不去，但
 * `code` 仍落在官方六码内，比普通 Error 强。
 *
 * @param {object} ctx
 * @param {unknown} error
 * @param {string} [stage]
 */
export async function asHostManualError(ctx, error, stage) {
  const Host = await hostManualErrorClass(ctx);
  if (!Host) return asManualError(error, stage);
  // 已经是宿主实例：原样返回，避免重试/递归路径上二次包装。
  if (error instanceof Host) return error;
  const code = isManualCompactionError(error)
    ? error.code
    : toManualCode(error?.code, stage ?? error?.compactionStage);
  const message = error?.message ?? String(error);
  return new Host(code, message, { cause: error });
}
