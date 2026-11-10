// 配置解析：既接受官方 BasicCompactionConfig 的键（方便迁移），也接受本插件扩展的键。
// 未知键不报错，只收集到 unknown 里由调用方决定是否告警——因为这一行的 config
// 可能来自别人（例如 bili 曾经往 compaction-basic 行写过 auto:false）。

export const DEFAULT_CONFIG = Object.freeze({
  // ---- L2 触发 ----
  auto: true,
  thresholdRatio: 0.8,
  minimumReductionRatio: 0.2, // Target total-input reduction per automatic compaction.
  headroomTokens: 33000, // Reserve room for the next response and tool results.
  cachePreservePrefix: true,
  cacheMaxCheckpoints: 4,
  cacheMinSavingsTokens: 4096,
  minGrowthTokens: 0, // 0 = 每次达线都压；>0 表示自上次压缩以来至少增长这么多才压

  // ---- L1 窗口 ----
  windowFallback: 200000,
  windowClampMin: 65536,
  // { "provider/model": 1234567 }
  windowProviderMap: Object.freeze({}),

  // ---- L3 摘要模型 ----
  summarizationProvider: null,
  summarizationModel: null,
  maxTokens: 8192,
  // Independent complete-request limits. Bytes are planning units, not provider tokens.
  summaryInputRatio: 0.75,
  summaryInputMaxBytes: 458752,
  compactionRetries: 1,
  summaryTimeoutMs: 180000,
  summaryRetryCount: 2, // Additional attempts per unfinished summary/page, including corrective requests.
  summaryRetryDelayMs: 1000, // Exponential delay between attempts, capped at 30 seconds.
  language: 'auto', // 'auto' | 'zh' | 'en'

  // ---- L5 保留 ----
  retainRatio: 0.16,
  retainTokens: null,
  // Recent raw quotes are bounded and evicted oldest-first. Current requirements
  // remain audited independently; all original events remain in verified archives.
  preserveRecentMessages: 32,
  preserveRecentUserTokens: 4096,

  // ---- L6 溢出 ----
  maxOverflowRetries: 1,
  reactiveStep: 1,
  maxSummaryChunks: 32, // Successful bounded chunks, separate from failure retries.

  // ---- L7 失败 ----
  failureThreshold: 3,

  // ---- 附加 ----
  proactiveEnabled: true,
  proactiveMinTokens: 8192,
  proactiveMinGrowthTokens: 4096,
  continuationEnabled: true,
  continuationMaxBytes: 98304,
  continuationMemoryBytes: 12288, // Bounded working notes; exact requirements remain separate.
  continuationMaxExtraCalls: 4, // Persistent extra-call allowance; only a new manual command may renew an exhausted budget.
  archiveEnabled: true,
  archiveDir: null,
  auditEnabled: true,
  auditCoverageThreshold: 0.6,
  // ⚠️ 审计发现"约束行不见了"时，默认**中止这次压缩**，不是记条日志了事。
  // 只 warn 的后果是：约束真的丢了，用户却看到压缩"成功"，模型下一轮就按
  // 缺了约束的摘要干活 —— 这种损失在对话里是静默的，事后根本追不回来。
  // 可以显式关掉（`auditBlockOnLoss: false`）来换取"宁可压缩成功"的取舍，
  // 但那是一个需要用户自己做的决定，不是默认行为。
  auditBlockOnLoss: true,
  debug: false,
});

/** 官方 CompactionPolicyConfig 的键，原样接受。 */
const OFFICIAL_KEYS = new Set([
  'auto',
  'thresholdRatio',
  'headroomTokens',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'modelPolicies',
]);

const KNOWN_KEYS = new Set([...OFFICIAL_KEYS, ...Object.keys(DEFAULT_CONFIG)]);

function num(value, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  let v = integer ? Math.round(value) : value;
  if (v < min) v = min;
  if (v > max) v = max;
  return v;
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 顶层 `maxTokens` 的归一化。
 *
 * ⚠️ 不能走 `num(..., { min: 256 })`：那个函数会把低于下限的输入**悄悄抬到下限**，
 * 于是用户写 128 实际跑 256 —— 请求的输出上限被单方面改大，用户以为设生效了。
 * 宿主对同名官方字段用的是 `assertPositiveInteger`（`value <= 0` 才拒，见
 * `dsh-compaction-basic/lib/index.js:59-74`），显式正整数原样保留、非法值直接拒。
 * 这里与宿主、也与本文件 `modelPolicies[].maxTokens`（下限 1）保持一致。
 */
function normalizeMaxTokens(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`compaction-weave: maxTokens (${String(value)}) must be a positive integer`);
  }
  return value;
}

/** Positive quote budget; legacy zero is represented as null, which selection
 * resolves to the automatic budget. No unlimited raw-memory mode is implicit. */
function optionalLimit(value, name, bounds) {
  if (value === undefined || value === null || value === 0) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`compaction-weave: ${name} (${String(value)}) must be an integer or null`);
  }
  if (typeof bounds.min === 'number' && value < bounds.min) {
    throw new Error(`compaction-weave: ${name} (${String(value)}) must be an integer >= ${bounds.min}`);
  }
  if (typeof bounds.max === 'number' && value > bounds.max) {
    throw new Error(`compaction-weave: ${name} (${String(value)}) must be an integer <= ${bounds.max}`);
  }
  return value;
}

function str(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function ratio(value, fallback) {
  return num(value, fallback, { min: 0.01, max: 0.99 });
}

function normalizeProviderMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return Object.freeze({});
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = num(v, NaN, { min: 1, integer: true });
    if (Number.isFinite(n)) out[k] = n;
  }
  return Object.freeze(out);
}

/**
 * 单条 `modelPolicies` 允许出现的键（官方 `ModelCompactPolicyConfig` 的键集）。
 * 注意这里**不含** `auto`：`auto` 只在顶层生效，出现在单条策略里属于拼错或误解。
 */
const MODEL_POLICY_KEYS = new Set([
  'provider',
  'model',
  'thresholdRatio',
  'headroomTokens',
  'retainRatio',
  'retainTokens',
  'summarizationProvider',
  'summarizationModel',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
]);

// 宿主的合法区间是**开区间下端** `(0, 1]`（`assertRatio`：`value <= 0 || value > 1` 才拒）。
// 接受 0 的后果不是"保守一点"，而是 `thresholdRatio: 0` 会让压缩线落在 0 —— 永远不触发；
// `retainRatio: 0` 则会在保留量校验里与 0 阈值直接冲突。
function assertRatio(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`compaction-weave: ${name} must be a number in (0, 1]`);
  }
}

function assertInteger(name, value, min) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    throw new Error(`compaction-weave: ${name} must be an integer >= ${min}`);
  }
}

/**
 * 官方 `modelPolicies` 的归一化与校验。
 *
 * ⚠️ 这里**必须抛错而不是静默丢弃**。静默丢弃的失败模式是：用户写了一条覆盖
 * 策略，插件照常启动、日志一切正常，但那条策略从来没生效过 —— 用户只会觉得
 * "这个插件不听话"。宿主自己的 `resolveModelPolicies` / `assertModelPolicy` /
 * `validatePolicy` 在加载期就抛，我们保持同一语义。
 *
 * 校验项与宿主一致：
 * - 每条必须是对象，只允许官方键集（未知键 = 拼错）
 * - `provider` / `model` 必须是非空字符串
 * - 同一 `provider/model` 不允许出现两次（后一条永远命中不到，属于静默失效）
 * - `retainRatio` 与 `retainTokens` 互斥（同时给时哪一个赢没有直觉答案）
 * - `summarizationProvider` / `summarizationModel` 必须成对
 *
 * @param {unknown} raw
 * @returns {ReadonlyArray<Readonly<Record<string, any>>>}
 */
function normalizeModelPolicies(raw) {
  if (raw === undefined || raw === null) return Object.freeze([]);
  if (!Array.isArray(raw)) {
    throw new Error('compaction-weave: modelPolicies must be an array');
  }
  const seen = new Set();
  const out = [];
  for (let index = 0; index < raw.length; index += 1) {
    const name = `modelPolicies[${index}]`;
    const item = raw[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`compaction-weave: ${name} must be an object`);
    }
    for (const key of Object.keys(item)) {
      if (!MODEL_POLICY_KEYS.has(key)) {
        throw new Error(`compaction-weave: ${name}: unknown key "${key}"`);
      }
    }
    const provider = item.provider;
    const model = item.model;
    if (typeof provider !== 'string' || provider.length === 0) {
      throw new Error(`compaction-weave: ${name}.provider must be a non-empty string`);
    }
    if (typeof model !== 'string' || model.length === 0) {
      throw new Error(`compaction-weave: ${name}.model must be a non-empty string`);
    }
    const key = `${provider}/${model}`;
    if (seen.has(key)) {
      throw new Error(`compaction-weave: duplicate model policy for ${key}`);
    }
    seen.add(key);

    const policy = { provider, model };
    if (item.thresholdRatio !== undefined) {
      assertRatio(`${name}.thresholdRatio`, item.thresholdRatio);
      policy.thresholdRatio = item.thresholdRatio;
    }
    if (item.headroomTokens !== undefined) {
      assertInteger(`${name}.headroomTokens`, item.headroomTokens, 0);
      policy.headroomTokens = item.headroomTokens;
    }
    if (item.retainRatio !== undefined && item.retainTokens !== undefined) {
      throw new Error(`compaction-weave: ${name}: retainRatio and retainTokens are mutually exclusive`);
    }
    if (item.retainRatio !== undefined) {
      assertRatio(`${name}.retainRatio`, item.retainRatio);
      policy.retainRatio = item.retainRatio;
    }
    if (item.retainTokens !== undefined) {
      assertInteger(`${name}.retainTokens`, item.retainTokens, 0);
      policy.retainTokens = item.retainTokens;
    }
    if (item.maxTokens !== undefined) {
      // 宿主只要求正整数（`assertPositiveInteger`：`value <= 0` 才拒）。
      // 这里卡 256 会拒掉宿主合法的 1–255，而 `normalizeModelPolicies` 在
      // `apply()` 阶段抛错 = 整行引擎加载失败，用户只是给某个模型配了个小输出上限。
      assertInteger(`${name}.maxTokens`, item.maxTokens, 1);
      policy.maxTokens = item.maxTokens;
    }
    if (item.compactionRetries !== undefined) {
      assertInteger(`${name}.compactionRetries`, item.compactionRetries, 0);
      policy.compactionRetries = item.compactionRetries;
    }
    if (item.maxOverflowRetries !== undefined) {
      assertInteger(`${name}.maxOverflowRetries`, item.maxOverflowRetries, 0);
      policy.maxOverflowRetries = item.maxOverflowRetries;
    }
    const sumProvider = item.summarizationProvider;
    const sumModel = item.summarizationModel;
    if (sumProvider !== undefined || sumModel !== undefined) {
      if (
        typeof sumProvider !== 'string' ||
        typeof sumModel !== 'string' ||
        (sumProvider.length === 0) !== (sumModel.length === 0)
      ) {
        throw new Error(
          `compaction-weave: ${name}: summarizationProvider and summarizationModel must be set together as an empty or non-empty pair`,
        );
      }
      policy.summarizationProvider = sumProvider;
      policy.summarizationModel = sumModel;
    }
    out.push(Object.freeze(policy));
  }
  return Object.freeze(out);
}

/**
 * 逐条策略在**与全局默认合并之后**再校验一次保留量。
 *
 * 只看单条字段的类型是不够的：`{thresholdRatio: 0.2}` 这条策略自己完全合法，
 * 但配上全局 `retainRatio: 0.3` 就成了"保留区比压缩线还大"。这种组合在加载期
 * 是查不出来的 —— 要等到真的命中这个模型、真的去算 spec 时才抛
 * `retainTokens (…) must be less than threshold tokens …`，而那时摘要请求一次都
 * 没发出去。用户看到的是"配了个策略，从此这个模型再也不压缩"。
 *
 * 官方的 `validateRatioRetention` 就是在 `resolveConfig` 里对每条 policy 做完
 * 合并后校验的（`dsh-compaction-basic/lib/index.js:220-235`）。
 *
 * 绝对 token 数（`retainTokens`）与窗口大小有关，容量无关阶段判不了，留给
 * `resolveCompactSpec` 的运行时检查。
 *
 * @param {ReadonlyArray<Record<string, any>>} policies
 * @param {Record<string, any>} config 已归一化、已兜底的全局配置
 */
function validateModelPolicyRetention(policies, config) {
  if (policies.length === 0) return;
  const baseThreshold = config.thresholdRatio;
  const baseRetainTokens = config.retainTokens === null ? undefined : config.retainTokens;
  const baseRetainRatio = baseRetainTokens === undefined ? config.retainRatio : undefined;
  for (let index = 0; index < policies.length; index += 1) {
    const policy = policies[index];
    const name = `modelPolicies[${index}]`;
    const thresholdRatio = policy.thresholdRatio ?? baseThreshold;
    // 与官方 `resolveRetention` 的互斥继承一致：目标给了 retainTokens 就只看它，
    // 给了 retainRatio 就用它，都没给才继承全局。
    let retainRatio;
    let retainTokens;
    if (policy.retainTokens !== undefined) {
      retainTokens = policy.retainTokens;
    } else if (policy.retainRatio !== undefined) {
      retainRatio = policy.retainRatio;
    } else {
      retainTokens = baseRetainTokens;
      retainRatio = baseRetainRatio;
    }
    if (retainTokens !== undefined) continue;
    if (retainRatio !== undefined && retainRatio >= thresholdRatio) {
      throw new Error(
        `compaction-weave: ${name}: retainRatio (${retainRatio}) must be less than the resolved thresholdRatio (${thresholdRatio})`,
      );
    }
  }
}

/**
 * @param {Record<string, unknown>|undefined} raw
 * @returns {{ config: Readonly<Record<string, any>>, unknown: string[] }}
 */
export function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const unknown = [];
  for (const key of Object.keys(input)) {
    if (!KNOWN_KEYS.has(key)) unknown.push(key);
  }

  // 顶层同样适用官方的保留量互斥规则（`validatePolicy` 对默认值和覆盖项一视同仁）。
  // 默认配置里 `retainTokens` 是 null（"没设"），所以只有用户真的给了数字才算冲突。
  if (input.retainRatio !== undefined && input.retainTokens !== undefined && input.retainTokens !== null) {
    throw new Error('compaction-weave: retainRatio and retainTokens are mutually exclusive');
  }

  const modelPolicies = normalizeModelPolicies(input.modelPolicies);

  const config = {
    auto: bool(input.auto, DEFAULT_CONFIG.auto),
    proactiveEnabled: input.proactiveEnabled !== false,
    proactiveMinTokens: num(input.proactiveMinTokens, DEFAULT_CONFIG.proactiveMinTokens, {min:1024,integer:true}),
    proactiveMinGrowthTokens: num(input.proactiveMinGrowthTokens, DEFAULT_CONFIG.proactiveMinGrowthTokens, {min:512,integer:true}),
    continuationEnabled: bool(input.continuationEnabled, DEFAULT_CONFIG.continuationEnabled),
    continuationMaxBytes: num(input.continuationMaxBytes, DEFAULT_CONFIG.continuationMaxBytes, { min: 4096, max: 262144, integer: true }),
    continuationMemoryBytes: num(input.continuationMemoryBytes, DEFAULT_CONFIG.continuationMemoryBytes, { min: 2048, max: 24576, integer: true }),
    continuationMaxExtraCalls: num(input.continuationMaxExtraCalls, DEFAULT_CONFIG.continuationMaxExtraCalls, { min: 0, max: 32, integer: true }),
    thresholdRatio: ratio(input.thresholdRatio, DEFAULT_CONFIG.thresholdRatio),
    minimumReductionRatio: num(input.minimumReductionRatio, DEFAULT_CONFIG.minimumReductionRatio, { min: 0.05, max: 0.9 }),
    headroomTokens: num(input.headroomTokens, DEFAULT_CONFIG.headroomTokens, {
      min: 0,
      integer: true,
    }),
    minGrowthTokens: num(input.minGrowthTokens, DEFAULT_CONFIG.minGrowthTokens, {
      min: 0,
      integer: true,
    }),

    windowFallback: num(input.windowFallback, DEFAULT_CONFIG.windowFallback, {
      min: 1024,
      integer: true,
    }),
    windowClampMin: num(input.windowClampMin, DEFAULT_CONFIG.windowClampMin, {
      min: 1024,
      integer: true,
    }),
    windowProviderMap: normalizeProviderMap(input.windowProviderMap),

    summarizationProvider: str(input.summarizationProvider, null),
    summarizationModel: str(input.summarizationModel, null),
    maxTokens: normalizeMaxTokens(input.maxTokens, DEFAULT_CONFIG.maxTokens),
    summaryInputRatio: num(input.summaryInputRatio, DEFAULT_CONFIG.summaryInputRatio, { min: 0.05, max: 1 }),
    summaryInputMaxBytes: num(input.summaryInputMaxBytes, DEFAULT_CONFIG.summaryInputMaxBytes, { min: 4096, max: 16777216, integer: true }),
    compactionRetries: num(input.compactionRetries, DEFAULT_CONFIG.compactionRetries, {
      min: 0,
      max: 8,
      integer: true,
    }),
    summaryRetryCount: num(input.summaryRetryCount, DEFAULT_CONFIG.summaryRetryCount, {min:0,max:4,integer:true}),
    summaryRetryDelayMs: num(input.summaryRetryDelayMs, DEFAULT_CONFIG.summaryRetryDelayMs, {min:0,max:30000,integer:true}),
    summaryTimeoutMs: num(input.summaryTimeoutMs, DEFAULT_CONFIG.summaryTimeoutMs, {
      min: 5000,
      integer: true,
    }),
    language: ['auto', 'zh', 'en'].includes(input.language) ? input.language : 'auto',

    retainRatio: ratio(input.retainRatio, DEFAULT_CONFIG.retainRatio),
    retainTokens:
      typeof input.retainTokens === 'number' && Number.isFinite(input.retainTokens)
        ? num(input.retainTokens, null, { min: 0, integer: true })
        : null,
    // 旧配置 0 使用自动预算并记录迁移警告。原话超预算按最旧优先归档；
    // 仍有效的要求独立审计，不能随原话预算被静默删除。
    preserveRecentMessages: optionalLimit(input.preserveRecentMessages ?? DEFAULT_CONFIG.preserveRecentMessages, 'preserveRecentMessages', {
      min: 1,
      max: 100000,
      integer: true,
    }),
    preserveRecentUserTokens: optionalLimit(input.preserveRecentUserTokens ?? DEFAULT_CONFIG.preserveRecentUserTokens, 'preserveRecentUserTokens', {
      min: 1,
      integer: true,
    }),

    maxOverflowRetries: num(input.maxOverflowRetries, DEFAULT_CONFIG.maxOverflowRetries, {
      min: 0,
      max: 8,
      integer: true,
    }),
    reactiveStep: num(input.reactiveStep, DEFAULT_CONFIG.reactiveStep, {
      min: 1,
      max: 8,
      integer: true,
    }),

    failureThreshold: num(input.failureThreshold, DEFAULT_CONFIG.failureThreshold, {
      min: 1,
      max: 20,
      integer: true,
    }),

    maxSummaryChunks: num(input.maxSummaryChunks, DEFAULT_CONFIG.maxSummaryChunks, { min: 1, max: 128, integer: true }),

    cachePreservePrefix: bool(input.cachePreservePrefix, DEFAULT_CONFIG.cachePreservePrefix),
    cacheMaxCheckpoints: num(input.cacheMaxCheckpoints, DEFAULT_CONFIG.cacheMaxCheckpoints, {min:1,max:8,integer:true}),
    cacheMinSavingsTokens: num(input.cacheMinSavingsTokens, DEFAULT_CONFIG.cacheMinSavingsTokens, {min:1024,integer:true}),
    archiveEnabled: bool(input.archiveEnabled, DEFAULT_CONFIG.archiveEnabled),
    archiveDir: str(input.archiveDir, null),
    auditEnabled: bool(input.auditEnabled, DEFAULT_CONFIG.auditEnabled),
    auditCoverageThreshold: num(
      input.auditCoverageThreshold,
      DEFAULT_CONFIG.auditCoverageThreshold,
      { min: 0, max: 1 },
    ),
    auditBlockOnLoss: bool(input.auditBlockOnLoss, DEFAULT_CONFIG.auditBlockOnLoss),
    debug: bool(input.debug, DEFAULT_CONFIG.debug),

    // 官方按 provider/model 的覆盖策略。这里必须**保留**它（而不是收下就扔），
    // 由 `resolveTargetPolicy` 在解析出真实路由后再合并。
    modelPolicies,
  };

  // retainRatio 必须小于 thresholdRatio，否则保留区比压缩线还大，永远压不动。
  if (config.retainRatio >= config.thresholdRatio) {
    config.retainRatio = Math.max(0.05, Math.min(0.5, config.thresholdRatio * 0.5));
  }
  // headroomTokens 不能吃掉整个窗口。
  if (config.headroomTokens >= config.windowFallback) {
    config.headroomTokens = Math.floor(config.windowFallback / 4);
  }

  // 全局兜底之后，再逐条校验"目标覆盖 + 全局继承"合并出来的保留量。
  // 必须在兜底**之后**做：否则拿还没修正的全局值去比，会误报。
  validateModelPolicyRetention(config.modelPolicies, config);

  return { config: Object.freeze(config), unknown, migrations: ['preserveRecentMessages', 'preserveRecentUserTokens'].filter(key => input[key] === 0).map(key => `${key}=0 migrated to the automatic recent-quote budget`) };
}

/**
 * 官方 resolveCompactSpec 的等价实现。
 * @param {{thresholdRatio:number, headroomTokens:number, retainRatio:number, retainTokens:number|null}} policy
 * @param {number} contextWindow
 * @param {number} reservedCompletionTokens
 */
export function resolveCompactSpec(policy, contextWindow, reservedCompletionTokens) {
  const messageBudgetTokens = contextWindow - reservedCompletionTokens;
  if (messageBudgetTokens <= 0) {
    throw new Error(
      `compaction-weave: contextWindow ${contextWindow} leaves no message budget after reserving ${reservedCompletionTokens} completion tokens`,
    );
  }
  // ⚠️ headroom 大于整条消息预算时**不能抛错**。
  // 32000 级的小窗口配上默认 33000 headroom 是真实配置（不是用户写错），
  // 抛错等于"自动压缩永不触发"，而恰恰是这种小窗口最容易撞上供应商的
  // 上下文上限。这里的语义是"提前量"，不是"硬性门槛"：提前量超过窗口
  // 本身时就按窗口的四分之一收敛，压缩线仍然严格早于阻断线。
  const effectiveHeadroom =
    policy.headroomTokens >= messageBudgetTokens
      ? Math.floor(messageBudgetTokens * 0.25)
      : policy.headroomTokens;
  const pressureBudgetTokens = messageBudgetTokens - effectiveHeadroom;
  const thresholdTokens = Math.floor(
    Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens),
  );
  const retainTokens =
    policy.retainTokens ?? Math.floor(messageBudgetTokens * policy.retainRatio);
  if (retainTokens >= thresholdTokens) {
    throw new Error(
      `compaction-weave: retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens}`,
    );
  }
  // 官方 `resolveCompactSpec` 会把重试次数、输出上限一并带进 spec
  // （`dsh-compaction-basic/lib/index.js:135-145`）。调用方读的是 spec 上的
  // `compactionRetries`，如果这里不返回，`spec.compactionRetries + 1` 就是 NaN，
  // `while (attempts < NaN)` 一次都不跑 —— 表现为"两种触发都返回 null，
  // 一次压缩都没发生"，但日志里一切正常。
  return {
    contextWindow,
    messageBudgetTokens,
    pressureBudgetTokens,
    thresholdTokens,
    retainTokens,
    maxTokens: policy.maxTokens,
    compactionRetries: policy.compactionRetries,
    maxOverflowRetries: policy.maxOverflowRetries,
  };
}

/**
 * 按 provider/model 找官方 `modelPolicies` 里的覆盖项，并合并到基础配置上。
 *
 * 官方语义（`ModelCompactPolicyConfig`）：`{provider, model, ...CompactionPolicyConfig}`，
 * 精确匹配 provider+model，命中后覆盖阈值、保留量、摘要模型、输出上限、重试次数。
 * 收进"已知键"却不使用等于静默丢弃 —— 比报错更糟，因为用户会以为配置生效了。
 *
 * ⚠️ 保留量**不能简单浅合并**。`resolveCompactSpec` 里是
 * `policy.retainTokens ?? Math.floor(messageBudget * policy.retainRatio)`，
 * `retainTokens` 优先级更高。全局配了 `retainTokens: 1000`、目标只想改成
 * `retainRatio: 0.3` 时，浅合并会留下全局的 1000，目标的 0.3 永远读不到 ——
 * 用户改了个"能生效"的键，实际一点没变。
 *
 * 官方 `resolveRetention(config, fallback)` 的规则是：目标给了 `retainTokens`
 * 就用它，给了 `retainRatio` 就用比例，都没给才继承全局；并且两者互斥。
 * 所以合并时必须**把另一个键抹掉**，不能只覆盖。
 *
 * @param {Readonly<Record<string, any>>} config
 * @param {string|undefined} provider
 * @param {string|undefined} model
 * @returns {Readonly<Record<string, any>>}
 */
export function resolveTargetPolicy(config, provider, model) {
  const policies = config.modelPolicies;
  if (!Array.isArray(policies) || policies.length === 0) return config;
  for (const policy of policies) {
    if (!policy || typeof policy !== 'object') continue;
    if (policy.provider !== provider || policy.model !== model) continue;
    const merged = { ...config };
    for (const key of Object.keys(policy)) {
      if (key === 'provider' || key === 'model') continue;
      if (policy[key] === undefined) continue;
      merged[key] = policy[key];
    }
    // 保留量按官方 `resolveRetention` 的互斥语义收口：目标选了其中一种，
    // 另一种就必须从合并结果里消失，否则全局那个会一直赢。
    if (policy.retainTokens !== undefined) {
      delete merged.retainRatio;
    } else if (policy.retainRatio !== undefined) {
      delete merged.retainTokens;
    }
    return merged;
  }
  return config;
}
