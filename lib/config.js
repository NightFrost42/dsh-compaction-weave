// 配置解析：既接受官方 BasicCompactionConfig 的键（方便迁移），也接受本插件扩展的键。
// 未知键不报错，只收集到 unknown 里由调用方决定是否告警——因为这一行的 config
// 可能来自别人（例如 bili 曾经往 compaction-basic 行写过 auto:false）。

export const DEFAULT_CONFIG = Object.freeze({
  // ---- L2 触发 ----
  auto: true,
  idleCompactionMinutes: 0, // Independent of auto; 0 = disabled, checked on a new user turn only.
  idleCompactionMinTokens: 0, // Minimum context tokens before idle resume triggers compaction; 0 = auto.
  idleRetainTokens: 0, // Recent tail tokens preserved on idle resume compaction; 0 = full shrinkable prefix.
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
  // Dual-track complete-request limits: token budget uses conservative per-script
  // token estimation against `(window - output - headroom) * summaryInputRatio`;
  // byte hard cap independently bounds serialized UTF-8 payload size.
  summaryInputRatio: 0.85,
  summaryInputMaxBytes: 2097152,
  summaryCjkTokensPerChar: 0.75,
  // Legacy host-schema/spec compatibility placeholder (unused by runtime retry loops;
  // actual summary retries use `summaryRetryCount` / `summaryRetryDelayMs`).
  compactionRetries: 1,
  summaryTimeoutMs: 180000,
  summaryRetryCount: 2, // Additional attempts per unfinished summary/page, including corrective requests.
  summaryRetryDelayMs: 1000, // Exponential delay between attempts, capped at 30 seconds.
  summaryConcurrency: 2, // Bounded parallel chunk/page summaries (1 = strict serial, 1..6).
  summaryReasoningEffort: 'auto', // 'auto' | 'low' | 'none' | 'inherit' | 'minimal' | 'medium' | 'high' | 'xhigh' | 'max'
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
  pressureBreakerAction: 'confirm', // 'confirm' | 'degrade' | 'block'

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
  archiveWarnBytes: 512 * 1024 * 1024,
  maxVisibleAttachmentBytes: 16 * 1024 * 1024,
  maxVisibleImages: 24,
  observationMaskingEnabled: true,
  observationMaskThresholdChars: 4000,
  observationMaskHeadChars: 300,
  observationMaskTailChars: 300,
  auditEnabled: true,
  auditCoverageThreshold: 0.6,
  // ⚠️ 审计发现"约束行不见了"时，默认**中止这次压缩**，不是记条日志了事。
  // 只 warn 的后果是：约束真的丢了，用户却看到压缩"成功"，模型下一轮就按
  // 缺了约束的摘要干活 —— 这种损失在对话里是静默的，事后根本追不回来。
  // 可以显式关掉（`auditBlockOnLoss: false`）来换取"宁可压缩成功"的取舍，
  // 但那是一个需要用户自己做的决定，不是默认行为。
  auditBlockOnLoss: true,
  auditProvenanceBlock: true,
  auditExhaustionPolicy: 'fallback', // 'fallback' | 'block'
  extraReferenceSourceKinds: Object.freeze([]),
  extraReferencePrefixes: Object.freeze([]),
  diskLivenessCheck: true,
  postCompactReinjectEnabled: true,
  postCompactReinjectMaxFiles: 5,
  postCompactReinjectMaxBytes: 24576,
  postCompactReinjectMaxFileBytes: 6144,
  persistedOutputEnabled: true,
  persistedOutputThresholdChars: 32768,
  persistedOutputHeadChars: 1200,
  persistedOutputTailChars: 1200,
  microcompactEnabled: true,
  microcompactKeepRecentTools: 4,
  microcompactThresholdChars: 2000,
  microcompactHeadChars: 200,
  microcompactTailChars: 200,
  microcompactRepeatedReadMinChars: 2000,
  idleFullSummaryEnabled: true,
  sessionMemoryEnabled: false,
  sessionMemoryMinTokens: 24576,
  sessionMemoryUpdateIntervalTokens: 16384,
  sessionMemoryUpdateIntervalTurns: 4,
  sessionMemoryCooldownMs: 60000,
  sessionMemoryMaxBytes: 12288,
  // Per-compaction-cycle background call fuse (resets `callsUsed` to 0 after a committed
  // Weave checkpoint while preserving monotonic `totalCallsUsed`).
  sessionMemoryMaxCallsPerSession: 8,
  contextCollapseEnabled: false,
  contextCollapseMinTokens: 49152,
  contextCollapseMaxSpanTokens: 32768,
  contextCollapseKeepRecentTokens: 8192,
  contextCollapseKeepRecentTurns: 2,
  snipEnabled: true,
  snipKeepRecentTurns: 2,
  snipKeepRecentTokens: 8192,
  snipMinSavingsTokens: 1024,
  snipMaxSpansPerRescue: 4,
  strictHostFingerprints: false,
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

export const EXPLICIT_CONFIG_KEYS = Symbol.for('dsh-compaction-weave.explicitConfigKeys');
const EXPLICIT_TRACKED_KEYS = Object.freeze([
  'postCompactReinjectMaxFiles',
  'postCompactReinjectMaxBytes',
  'postCompactReinjectMaxFileBytes',
]);

export const MAX_IDLE_COMPACTION_MINUTES = 30 * 24 * 60;
export const MIN_SUMMARY_CONCURRENCY = 1;
export const MAX_SUMMARY_CONCURRENCY = 6;
export const MIN_SUMMARY_CJK_TOKENS_PER_CHAR = 0.5;
export const MAX_SUMMARY_CJK_TOKENS_PER_CHAR = 1.5;
export const REASONING_EFFORT_LADDER = Object.freeze(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']);
export const SUMMARY_REASONING_EFFORTS = Object.freeze(['auto', 'low', 'none', 'inherit', 'minimal', 'medium', 'high', 'xhigh', 'max']);
export const MAX_EXTRA_REFERENCE_SOURCE_KINDS = 64;
export const MAX_EXTRA_REFERENCE_PREFIXES = 64;
export const MIN_EXTRA_REFERENCE_PREFIX_LENGTH = 2;
export const MAX_EXTRA_REFERENCE_PREFIX_LENGTH = 200;
export const PRESSURE_BREAKER_ACTIONS = Object.freeze(['confirm', 'degrade', 'block']);
export const AUDIT_EXHAUSTION_POLICIES = Object.freeze(['fallback', 'block']);
export const MIN_POST_COMPACT_REINJECT_MAX_FILES = 1;
export const MAX_POST_COMPACT_REINJECT_MAX_FILES = 20;
export const MIN_POST_COMPACT_REINJECT_MAX_BYTES = 1024;
export const MAX_POST_COMPACT_REINJECT_MAX_BYTES = 262144;
export const MIN_POST_COMPACT_REINJECT_MAX_FILE_BYTES = 512;
export const MAX_POST_COMPACT_REINJECT_MAX_FILE_BYTES = 65536;
export const MIN_PERSISTED_OUTPUT_THRESHOLD_CHARS = 2048;
export const MAX_PERSISTED_OUTPUT_THRESHOLD_CHARS = 1048576;
export const MIN_PERSISTED_OUTPUT_HEAD_CHARS = 0;
export const MAX_PERSISTED_OUTPUT_HEAD_CHARS = 8192;
export const MIN_PERSISTED_OUTPUT_TAIL_CHARS = 0;
export const MAX_PERSISTED_OUTPUT_TAIL_CHARS = 8192;
export const MIN_MICROCOMPACT_KEEP_RECENT_TOOLS = 0;
export const MAX_MICROCOMPACT_KEEP_RECENT_TOOLS = 50;
export const MIN_MICROCOMPACT_THRESHOLD_CHARS = 500;
export const MAX_MICROCOMPACT_THRESHOLD_CHARS = 262144;
export const MIN_MICROCOMPACT_HEAD_CHARS = 0;
export const MAX_MICROCOMPACT_HEAD_CHARS = 4096;
export const MIN_MICROCOMPACT_TAIL_CHARS = 0;
export const MAX_MICROCOMPACT_TAIL_CHARS = 4096;
export const MIN_MICROCOMPACT_REPEATED_READ_MIN_CHARS = 500;
export const MAX_MICROCOMPACT_REPEATED_READ_MIN_CHARS = 262144;
export const MIN_SESSION_MEMORY_MIN_TOKENS = 4096;
export const MAX_SESSION_MEMORY_MIN_TOKENS = 1000000;
export const MIN_SESSION_MEMORY_UPDATE_INTERVAL_TOKENS = 2048;
export const MAX_SESSION_MEMORY_UPDATE_INTERVAL_TOKENS = 500000;
export const MIN_SESSION_MEMORY_UPDATE_INTERVAL_TURNS = 1;
export const MAX_SESSION_MEMORY_UPDATE_INTERVAL_TURNS = 100;
export const MIN_SESSION_MEMORY_COOLDOWN_MS = 0;
export const MAX_SESSION_MEMORY_COOLDOWN_MS = 3600000;
export const MIN_SESSION_MEMORY_MAX_BYTES = 2048;
export const MAX_SESSION_MEMORY_MAX_BYTES = 65536;
export const MIN_SESSION_MEMORY_MAX_CALLS_PER_SESSION = 1;
export const MAX_SESSION_MEMORY_MAX_CALLS_PER_SESSION = 100;
export const MIN_CONTEXT_COLLAPSE_MIN_TOKENS = 8192;
export const MAX_CONTEXT_COLLAPSE_MIN_TOKENS = 1000000;
export const MIN_CONTEXT_COLLAPSE_MAX_SPAN_TOKENS = 4096;
export const MAX_CONTEXT_COLLAPSE_MAX_SPAN_TOKENS = 500000;
export const MIN_CONTEXT_COLLAPSE_KEEP_RECENT_TOKENS = 1024;
export const MAX_CONTEXT_COLLAPSE_KEEP_RECENT_TOKENS = 200000;
export const MIN_CONTEXT_COLLAPSE_KEEP_RECENT_TURNS = 1;
export const MAX_CONTEXT_COLLAPSE_KEEP_RECENT_TURNS = 20;
export const MIN_SNIP_KEEP_RECENT_TURNS = 1;
export const MAX_SNIP_KEEP_RECENT_TURNS = 50;
export const MIN_SNIP_KEEP_RECENT_TOKENS = 512;
export const MAX_SNIP_KEEP_RECENT_TOKENS = 262144;
export const MIN_SNIP_MIN_SAVINGS_TOKENS = 0;
export const MAX_SNIP_MIN_SAVINGS_TOKENS = 131072;
export const MIN_SNIP_MAX_SPANS_PER_RESCUE = 1;
export const MAX_SNIP_MAX_SPANS_PER_RESCUE = 20;
export const DEFAULT_ARCHIVE_WARN_BYTES = 512 * 1024 * 1024;
export const MAX_ARCHIVE_WARN_BYTES = 100 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_VISIBLE_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_VISIBLE_ATTACHMENT_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_MAX_VISIBLE_IMAGES = 24;
export const MAX_VISIBLE_IMAGES = 500;

const RESERVED_EXTRA_SOURCE_KINDS = new Set(['user', 'compact-checkpoint']);

function assertBooleanValue(value, name) {
  if (typeof value !== 'boolean') {
    throw new Error(`compaction-weave: ${name} must be a boolean`);
  }
  return value;
}

function assertBoundedInteger(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`compaction-weave: ${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Validate post-compact local workspace file re-injection toggle. */
export function normalizePostCompactReinjectEnabled(value = DEFAULT_CONFIG.postCompactReinjectEnabled) {
  return assertBooleanValue(value, 'postCompactReinjectEnabled');
}

/** Validate Stage-1 archive-backed observation masking toggle. */
export function normalizeObservationMaskingEnabled(value = DEFAULT_CONFIG.observationMaskingEnabled) {
  return assertBooleanValue(value, 'observationMaskingEnabled');
}

/** Validate maximum number of workspace files re-injected after compaction without clamping. */
export function normalizePostCompactReinjectMaxFiles(value = DEFAULT_CONFIG.postCompactReinjectMaxFiles) {
  return assertBoundedInteger(
    value,
    'postCompactReinjectMaxFiles',
    MIN_POST_COMPACT_REINJECT_MAX_FILES,
    MAX_POST_COMPACT_REINJECT_MAX_FILES,
  );
}

/** Validate total UTF-8 byte cap for post-compact workspace file re-injection without clamping. */
export function normalizePostCompactReinjectMaxBytes(value = DEFAULT_CONFIG.postCompactReinjectMaxBytes) {
  return assertBoundedInteger(
    value,
    'postCompactReinjectMaxBytes',
    MIN_POST_COMPACT_REINJECT_MAX_BYTES,
    MAX_POST_COMPACT_REINJECT_MAX_BYTES,
  );
}

/** Validate per-file UTF-8 byte cap for post-compact workspace file re-injection without clamping. */
export function normalizePostCompactReinjectMaxFileBytes(value = DEFAULT_CONFIG.postCompactReinjectMaxFileBytes) {
  return assertBoundedInteger(
    value,
    'postCompactReinjectMaxFileBytes',
    MIN_POST_COMPACT_REINJECT_MAX_FILE_BYTES,
    MAX_POST_COMPACT_REINJECT_MAX_FILE_BYTES,
  );
}

/** Validate tail-only persisted-output spill toggle. */
export function normalizePersistedOutputEnabled(value = DEFAULT_CONFIG.persistedOutputEnabled) {
  return assertBooleanValue(value, 'persistedOutputEnabled');
}

/** Validate minimum character threshold for tail persisted-output spilling without clamping. */
export function normalizePersistedOutputThresholdChars(value = DEFAULT_CONFIG.persistedOutputThresholdChars) {
  return assertBoundedInteger(
    value,
    'persistedOutputThresholdChars',
    MIN_PERSISTED_OUTPUT_THRESHOLD_CHARS,
    MAX_PERSISTED_OUTPUT_THRESHOLD_CHARS,
  );
}

/** Validate leading preview character count for tail persisted-output stubs without clamping. */
export function normalizePersistedOutputHeadChars(value = DEFAULT_CONFIG.persistedOutputHeadChars) {
  return assertBoundedInteger(
    value,
    'persistedOutputHeadChars',
    MIN_PERSISTED_OUTPUT_HEAD_CHARS,
    MAX_PERSISTED_OUTPUT_HEAD_CHARS,
  );
}

/** Validate trailing preview character count for tail persisted-output stubs without clamping. */
export function normalizePersistedOutputTailChars(value = DEFAULT_CONFIG.persistedOutputTailChars) {
  return assertBoundedInteger(
    value,
    'persistedOutputTailChars',
    MIN_PERSISTED_OUTPUT_TAIL_CHARS,
    MAX_PERSISTED_OUTPUT_TAIL_CHARS,
  );
}

/** Validate 0-LLM expired-TTL microcompaction toggle. */
export function normalizeMicrocompactEnabled(value = DEFAULT_CONFIG.microcompactEnabled) {
  return assertBooleanValue(value, 'microcompactEnabled');
}

/** Validate number of newest successful tool results protected from microcompaction without clamping. */
export function normalizeMicrocompactKeepRecentTools(value = DEFAULT_CONFIG.microcompactKeepRecentTools) {
  return assertBoundedInteger(
    value,
    'microcompactKeepRecentTools',
    MIN_MICROCOMPACT_KEEP_RECENT_TOOLS,
    MAX_MICROCOMPACT_KEEP_RECENT_TOOLS,
  );
}

/** Validate minimum character threshold for microcompaction folding of older tool outputs without clamping. */
export function normalizeMicrocompactThresholdChars(value = DEFAULT_CONFIG.microcompactThresholdChars) {
  return assertBoundedInteger(
    value,
    'microcompactThresholdChars',
    MIN_MICROCOMPACT_THRESHOLD_CHARS,
    MAX_MICROCOMPACT_THRESHOLD_CHARS,
  );
}

/** Validate leading preview character count for microcompact stubs without clamping. */
export function normalizeMicrocompactHeadChars(value = DEFAULT_CONFIG.microcompactHeadChars) {
  return assertBoundedInteger(
    value,
    'microcompactHeadChars',
    MIN_MICROCOMPACT_HEAD_CHARS,
    MAX_MICROCOMPACT_HEAD_CHARS,
  );
}

/** Validate trailing preview character count for microcompact stubs without clamping. */
export function normalizeMicrocompactTailChars(value = DEFAULT_CONFIG.microcompactTailChars) {
  return assertBoundedInteger(
    value,
    'microcompactTailChars',
    MIN_MICROCOMPACT_TAIL_CHARS,
    MAX_MICROCOMPACT_TAIL_CHARS,
  );
}

/** Validate minimum character length for deduplicating earlier repeated file reads in microcompact without clamping. */
export function normalizeMicrocompactRepeatedReadMinChars(value = DEFAULT_CONFIG.microcompactRepeatedReadMinChars) {
  return assertBoundedInteger(
    value,
    'microcompactRepeatedReadMinChars',
    MIN_MICROCOMPACT_REPEATED_READ_MIN_CHARS,
    MAX_MICROCOMPACT_REPEATED_READ_MIN_CHARS,
  );
}

/** Validate whether idle resume may fall back to a full LLM summary after microcompaction. */
export function normalizeIdleFullSummaryEnabled(value = DEFAULT_CONFIG.idleFullSummaryEnabled) {
  return assertBooleanValue(value, 'idleFullSummaryEnabled');
}

/** Validate opt-in background session memory toggle. */
export function normalizeSessionMemoryEnabled(value = DEFAULT_CONFIG.sessionMemoryEnabled) {
  return assertBooleanValue(value, 'sessionMemoryEnabled');
}

/** Validate minimum compactable token threshold for background session memory without clamping. */
export function normalizeSessionMemoryMinTokens(value = DEFAULT_CONFIG.sessionMemoryMinTokens) {
  return assertBoundedInteger(
    value,
    'sessionMemoryMinTokens',
    MIN_SESSION_MEMORY_MIN_TOKENS,
    MAX_SESSION_MEMORY_MIN_TOKENS,
  );
}

/** Validate token delta threshold for incremental background session memory updates without clamping. */
export function normalizeSessionMemoryUpdateIntervalTokens(value = DEFAULT_CONFIG.sessionMemoryUpdateIntervalTokens) {
  return assertBoundedInteger(
    value,
    'sessionMemoryUpdateIntervalTokens',
    MIN_SESSION_MEMORY_UPDATE_INTERVAL_TOKENS,
    MAX_SESSION_MEMORY_UPDATE_INTERVAL_TOKENS,
  );
}

/** Validate user turn delta threshold for incremental background session memory updates without clamping. */
export function normalizeSessionMemoryUpdateIntervalTurns(value = DEFAULT_CONFIG.sessionMemoryUpdateIntervalTurns) {
  return assertBoundedInteger(
    value,
    'sessionMemoryUpdateIntervalTurns',
    MIN_SESSION_MEMORY_UPDATE_INTERVAL_TURNS,
    MAX_SESSION_MEMORY_UPDATE_INTERVAL_TURNS,
  );
}

/** Validate minimum cooldown interval between background session memory calls without clamping. */
export function normalizeSessionMemoryCooldownMs(value = DEFAULT_CONFIG.sessionMemoryCooldownMs) {
  return assertBoundedInteger(
    value,
    'sessionMemoryCooldownMs',
    MIN_SESSION_MEMORY_COOLDOWN_MS,
    MAX_SESSION_MEMORY_COOLDOWN_MS,
  );
}

/** Validate maximum UTF-8 byte budget for persisted session memory entries without clamping. */
export function normalizeSessionMemoryMaxBytes(value = DEFAULT_CONFIG.sessionMemoryMaxBytes) {
  return assertBoundedInteger(
    value,
    'sessionMemoryMaxBytes',
    MIN_SESSION_MEMORY_MAX_BYTES,
    MAX_SESSION_MEMORY_MAX_BYTES,
  );
}

/** Validate per-session background session memory LLM call fuse without clamping. */
export function normalizeSessionMemoryMaxCallsPerSession(value = DEFAULT_CONFIG.sessionMemoryMaxCallsPerSession) {
  return assertBoundedInteger(
    value,
    'sessionMemoryMaxCallsPerSession',
    MIN_SESSION_MEMORY_MAX_CALLS_PER_SESSION,
    MAX_SESSION_MEMORY_MAX_CALLS_PER_SESSION,
  );
}

/** Validate opt-in expired-TTL context collapse toggle. */
export function normalizeContextCollapseEnabled(value = DEFAULT_CONFIG.contextCollapseEnabled) {
  return assertBooleanValue(value, 'contextCollapseEnabled');
}

/** Validate minimum surface token threshold before context collapse activates without clamping. */
export function normalizeContextCollapseMinTokens(value = DEFAULT_CONFIG.contextCollapseMinTokens) {
  return assertBoundedInteger(
    value,
    'contextCollapseMinTokens',
    MIN_CONTEXT_COLLAPSE_MIN_TOKENS,
    MAX_CONTEXT_COLLAPSE_MIN_TOKENS,
  );
}

/** Validate maximum token span collapsed per progressive step without clamping. */
export function normalizeContextCollapseMaxSpanTokens(value = DEFAULT_CONFIG.contextCollapseMaxSpanTokens) {
  return assertBoundedInteger(
    value,
    'contextCollapseMaxSpanTokens',
    MIN_CONTEXT_COLLAPSE_MAX_SPAN_TOKENS,
    MAX_CONTEXT_COLLAPSE_MAX_SPAN_TOKENS,
  );
}

/** Validate minimum recent working-tail tokens preserved by context collapse without clamping. */
export function normalizeContextCollapseKeepRecentTokens(value = DEFAULT_CONFIG.contextCollapseKeepRecentTokens) {
  return assertBoundedInteger(
    value,
    'contextCollapseKeepRecentTokens',
    MIN_CONTEXT_COLLAPSE_KEEP_RECENT_TOKENS,
    MAX_CONTEXT_COLLAPSE_KEEP_RECENT_TOKENS,
  );
}

/** Validate minimum recent user turns preserved by context collapse without clamping. */
export function normalizeContextCollapseKeepRecentTurns(value = DEFAULT_CONFIG.contextCollapseKeepRecentTurns) {
  return assertBoundedInteger(
    value,
    'contextCollapseKeepRecentTurns',
    MIN_CONTEXT_COLLAPSE_KEEP_RECENT_TURNS,
    MAX_CONTEXT_COLLAPSE_KEEP_RECENT_TURNS,
  );
}

/** Validate 0-LLM last-resort emergency Snip pruning toggle. */
export function normalizeSnipEnabled(value = DEFAULT_CONFIG.snipEnabled) {
  return assertBooleanValue(value, 'snipEnabled');
}

/** Validate minimum recent authentic user turns protected from Snip pruning without clamping. */
export function normalizeSnipKeepRecentTurns(value = DEFAULT_CONFIG.snipKeepRecentTurns) {
  return assertBoundedInteger(
    value,
    'snipKeepRecentTurns',
    MIN_SNIP_KEEP_RECENT_TURNS,
    MAX_SNIP_KEEP_RECENT_TURNS,
  );
}

/** Validate minimum recent working-tail tokens protected from Snip pruning without clamping. */
export function normalizeSnipKeepRecentTokens(value = DEFAULT_CONFIG.snipKeepRecentTokens) {
  return assertBoundedInteger(
    value,
    'snipKeepRecentTokens',
    MIN_SNIP_KEEP_RECENT_TOKENS,
    MAX_SNIP_KEEP_RECENT_TOKENS,
  );
}

/** Validate minimum net token savings required before Snip archives a span without clamping. */
export function normalizeSnipMinSavingsTokens(value = DEFAULT_CONFIG.snipMinSavingsTokens) {
  return assertBoundedInteger(
    value,
    'snipMinSavingsTokens',
    MIN_SNIP_MIN_SAVINGS_TOKENS,
    MAX_SNIP_MIN_SAVINGS_TOKENS,
  );
}

/** Validate maximum contiguous spans archived per emergency Snip rescue pass without clamping. */
export function normalizeSnipMaxSpansPerRescue(value = DEFAULT_CONFIG.snipMaxSpansPerRescue) {
  return assertBoundedInteger(
    value,
    'snipMaxSpansPerRescue',
    MIN_SNIP_MAX_SPANS_PER_RESCUE,
    MAX_SNIP_MAX_SPANS_PER_RESCUE,
  );
}

/** Validate soft archive storage warning threshold in bytes (0 disables warnings). */
export function normalizeArchiveWarnBytes(value = DEFAULT_CONFIG.archiveWarnBytes) {
  if (value === 0) return 0;
  return assertBoundedInteger(value, 'archiveWarnBytes', 1, MAX_ARCHIVE_WARN_BYTES);
}

/** Validate high-watermark visible image byte threshold for batch image/offload (0 disables byte trigger). */
export function normalizeMaxVisibleAttachmentBytes(value = DEFAULT_CONFIG.maxVisibleAttachmentBytes) {
  if (value === 0) return 0;
  return assertBoundedInteger(value, 'maxVisibleAttachmentBytes', 1, MAX_VISIBLE_ATTACHMENT_BYTES);
}

/** Validate high-watermark visible image count threshold for batch image/offload (0 disables count trigger). */
export function normalizeMaxVisibleImages(value = DEFAULT_CONFIG.maxVisibleImages) {
  if (value === 0) return 0;
  return assertBoundedInteger(value, 'maxVisibleImages', 1, MAX_VISIBLE_IMAGES);
}

/** Never round or clamp an explicit idle interval. */
export function normalizeIdleCompactionMinutes(value = DEFAULT_CONFIG.idleCompactionMinutes) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_IDLE_COMPACTION_MINUTES) {
    throw new Error(`compaction-weave: idleCompactionMinutes must be an integer between 0 and ${MAX_IDLE_COMPACTION_MINUTES} (0 disables it)`);
  }
  return value;
}

/** Never silently round or coerce an explicit concurrency value. */
export function normalizeSummaryConcurrency(value = DEFAULT_CONFIG.summaryConcurrency) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_SUMMARY_CONCURRENCY ||
    value > MAX_SUMMARY_CONCURRENCY
  ) {
    throw new Error(
      `compaction-weave: summaryConcurrency must be an integer between ${MIN_SUMMARY_CONCURRENCY} and ${MAX_SUMMARY_CONCURRENCY}`,
    );
  }
  return value;
}

/** Validate reasoning-effort downgrade policy for summary calls. */
export function normalizeSummaryReasoningEffort(value = DEFAULT_CONFIG.summaryReasoningEffort) {
  if (typeof value !== 'string' || !SUMMARY_REASONING_EFFORTS.includes(value)) {
    throw new Error(
      `compaction-weave: summaryReasoningEffort must be one of ${SUMMARY_REASONING_EFFORTS.join(', ')}`,
    );
  }
  return value;
}

/** Validate configurable CJK/Hangul/Kana tokens-per-char conservative weight (default 0.75, range 0.5–1.5). */
export function normalizeSummaryCjkTokensPerChar(value = DEFAULT_CONFIG.summaryCjkTokensPerChar) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < MIN_SUMMARY_CJK_TOKENS_PER_CHAR ||
    value > MAX_SUMMARY_CJK_TOKENS_PER_CHAR
  ) {
    throw new Error(
      `compaction-weave: summaryCjkTokensPerChar must be a finite number between ${MIN_SUMMARY_CJK_TOKENS_PER_CHAR} and ${MAX_SUMMARY_CJK_TOKENS_PER_CHAR}`,
    );
  }
  return Math.round(value * 100) / 100;
}

/** Strict policy selector for automatic pressure compaction failures after circuit breaker trips. */
export function normalizePressureBreakerAction(value = DEFAULT_CONFIG.pressureBreakerAction) {
  if (typeof value !== 'string' || !PRESSURE_BREAKER_ACTIONS.includes(value)) {
    throw new Error(
      `compaction-weave: pressureBreakerAction must be one of ${PRESSURE_BREAKER_ACTIONS.join(', ')}`,
    );
  }
  return value;
}

/** Strict policy selector when heuristic audit rejections exhaust the fallback chain and retries. */
export function normalizeAuditExhaustionPolicy(value = DEFAULT_CONFIG.auditExhaustionPolicy) {
  if (typeof value !== 'string' || !AUDIT_EXHAUSTION_POLICIES.includes(value)) {
    throw new Error(
      `compaction-weave: auditExhaustionPolicy must be one of ${AUDIT_EXHAUSTION_POLICIES.join(', ')}`,
    );
  }
  return value;
}

/** Validate custom third-party bridge/plugin `source.kind` isolation entries. */
export function normalizeExtraReferenceSourceKinds(value = DEFAULT_CONFIG.extraReferenceSourceKinds) {
  if (!Array.isArray(value)) {
    throw new Error('compaction-weave: extraReferenceSourceKinds must be an array of non-empty strings');
  }
  if (value.length > MAX_EXTRA_REFERENCE_SOURCE_KINDS) {
    throw new Error(`compaction-weave: extraReferenceSourceKinds may contain at most ${MAX_EXTRA_REFERENCE_SOURCE_KINDS} entries`);
  }
  const seen = new Set();
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    const raw = value[i];
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new Error(`compaction-weave: extraReferenceSourceKinds[${i}] must be a non-empty string`);
    }
    const trimmed = raw.trim();
    if (RESERVED_EXTRA_SOURCE_KINDS.has(trimmed)) {
      throw new Error(`compaction-weave: extraReferenceSourceKinds cannot include reserved kind "${trimmed}"`);
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return Object.freeze(out);
}

/** Validate custom bare non-user injection prefixes (trimmed length 2..200, max 64 entries). */
export function normalizeExtraReferencePrefixes(value = DEFAULT_CONFIG.extraReferencePrefixes) {
  if (!Array.isArray(value)) {
    throw new Error('compaction-weave: extraReferencePrefixes must be an array of non-empty strings');
  }
  if (value.length > MAX_EXTRA_REFERENCE_PREFIXES) {
    throw new Error(`compaction-weave: extraReferencePrefixes may contain at most ${MAX_EXTRA_REFERENCE_PREFIXES} entries`);
  }
  const seen = new Set();
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    const raw = value[i];
    if (typeof raw !== 'string') {
      throw new Error(`compaction-weave: extraReferencePrefixes[${i}] must be a non-empty string`);
    }
    const trimmed = raw.trim();
    if (trimmed.length < MIN_EXTRA_REFERENCE_PREFIX_LENGTH || trimmed.length > MAX_EXTRA_REFERENCE_PREFIX_LENGTH) {
      throw new Error(
        `compaction-weave: extraReferencePrefixes[${i}] trimmed length must be between ${MIN_EXTRA_REFERENCE_PREFIX_LENGTH} and ${MAX_EXTRA_REFERENCE_PREFIX_LENGTH}`,
      );
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return Object.freeze(out);
}

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
  'summaryConcurrency',
  'summaryReasoningEffort',
  'summaryCjkTokensPerChar',
  'observationMaskingEnabled',
  'postCompactReinjectEnabled',
  'postCompactReinjectMaxFiles',
  'postCompactReinjectMaxBytes',
  'postCompactReinjectMaxFileBytes',
  'snipEnabled',
  'snipKeepRecentTurns',
  'snipKeepRecentTokens',
  'snipMinSavingsTokens',
  'snipMaxSpansPerRescue',
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
    if (item.summaryConcurrency !== undefined) {
      policy.summaryConcurrency = normalizeSummaryConcurrency(item.summaryConcurrency);
    }
    if (item.summaryReasoningEffort !== undefined) {
      policy.summaryReasoningEffort = normalizeSummaryReasoningEffort(item.summaryReasoningEffort);
    }
    if (item.summaryCjkTokensPerChar !== undefined) {
      policy.summaryCjkTokensPerChar = normalizeSummaryCjkTokensPerChar(item.summaryCjkTokensPerChar);
    }
    if (item.observationMaskingEnabled !== undefined) {
      policy.observationMaskingEnabled = normalizeObservationMaskingEnabled(item.observationMaskingEnabled);
    }
    if (item.postCompactReinjectEnabled !== undefined) {
      policy.postCompactReinjectEnabled = normalizePostCompactReinjectEnabled(item.postCompactReinjectEnabled);
    }
    if (item.postCompactReinjectMaxFiles !== undefined) {
      policy.postCompactReinjectMaxFiles = normalizePostCompactReinjectMaxFiles(item.postCompactReinjectMaxFiles);
    }
    if (item.postCompactReinjectMaxBytes !== undefined) {
      policy.postCompactReinjectMaxBytes = normalizePostCompactReinjectMaxBytes(item.postCompactReinjectMaxBytes);
    }
    if (item.postCompactReinjectMaxFileBytes !== undefined) {
      policy.postCompactReinjectMaxFileBytes = normalizePostCompactReinjectMaxFileBytes(item.postCompactReinjectMaxFileBytes);
    }
    if (item.snipEnabled !== undefined) {
      policy.snipEnabled = normalizeSnipEnabled(item.snipEnabled);
    }
    if (item.snipKeepRecentTurns !== undefined) {
      policy.snipKeepRecentTurns = normalizeSnipKeepRecentTurns(item.snipKeepRecentTurns);
    }
    if (item.snipKeepRecentTokens !== undefined) {
      policy.snipKeepRecentTokens = normalizeSnipKeepRecentTokens(item.snipKeepRecentTokens);
    }
    if (item.snipMinSavingsTokens !== undefined) {
      policy.snipMinSavingsTokens = normalizeSnipMinSavingsTokens(item.snipMinSavingsTokens);
    }
    if (item.snipMaxSpansPerRescue !== undefined) {
      policy.snipMaxSpansPerRescue = normalizeSnipMaxSpansPerRescue(item.snipMaxSpansPerRescue);
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
    idleCompactionMinutes: normalizeIdleCompactionMinutes(input.idleCompactionMinutes),
    idleCompactionMinTokens: num(input.idleCompactionMinTokens, DEFAULT_CONFIG.idleCompactionMinTokens, { min: 0, integer: true }),
    idleRetainTokens: num(input.idleRetainTokens, DEFAULT_CONFIG.idleRetainTokens, { min: 0, integer: true }),
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
    summaryCjkTokensPerChar: normalizeSummaryCjkTokensPerChar(input.summaryCjkTokensPerChar),
    // Compatibility placeholder retained for host config normalization & resolveCompactSpec; not used at runtime.
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
    summaryConcurrency: normalizeSummaryConcurrency(input.summaryConcurrency),
    summaryReasoningEffort: normalizeSummaryReasoningEffort(input.summaryReasoningEffort),
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
    pressureBreakerAction: normalizePressureBreakerAction(input.pressureBreakerAction),

    maxSummaryChunks: num(input.maxSummaryChunks, DEFAULT_CONFIG.maxSummaryChunks, { min: 1, max: 128, integer: true }),

    cachePreservePrefix: bool(input.cachePreservePrefix, DEFAULT_CONFIG.cachePreservePrefix),
    cacheMaxCheckpoints: num(input.cacheMaxCheckpoints, DEFAULT_CONFIG.cacheMaxCheckpoints, {min:1,max:8,integer:true}),
    cacheMinSavingsTokens: num(input.cacheMinSavingsTokens, DEFAULT_CONFIG.cacheMinSavingsTokens, {min:1024,integer:true}),
    archiveEnabled: bool(input.archiveEnabled, DEFAULT_CONFIG.archiveEnabled),
    archiveDir: str(input.archiveDir, null),
    archiveWarnBytes: normalizeArchiveWarnBytes(input.archiveWarnBytes),
    maxVisibleAttachmentBytes: normalizeMaxVisibleAttachmentBytes(input.maxVisibleAttachmentBytes),
    maxVisibleImages: normalizeMaxVisibleImages(input.maxVisibleImages),
    observationMaskingEnabled: bool(input.observationMaskingEnabled, DEFAULT_CONFIG.observationMaskingEnabled),
    observationMaskThresholdChars: num(input.observationMaskThresholdChars, DEFAULT_CONFIG.observationMaskThresholdChars, { min: 128, integer: true }),
    observationMaskHeadChars: num(input.observationMaskHeadChars, DEFAULT_CONFIG.observationMaskHeadChars, { min: 0, max: 4096, integer: true }),
    observationMaskTailChars: num(input.observationMaskTailChars, DEFAULT_CONFIG.observationMaskTailChars, { min: 0, max: 4096, integer: true }),
    auditEnabled: bool(input.auditEnabled, DEFAULT_CONFIG.auditEnabled),
    auditCoverageThreshold: num(
      input.auditCoverageThreshold,
      DEFAULT_CONFIG.auditCoverageThreshold,
      { min: 0, max: 1 },
    ),
    auditBlockOnLoss: bool(input.auditBlockOnLoss, DEFAULT_CONFIG.auditBlockOnLoss),
    auditProvenanceBlock: bool(input.auditProvenanceBlock, DEFAULT_CONFIG.auditProvenanceBlock),
    auditExhaustionPolicy: normalizeAuditExhaustionPolicy(input.auditExhaustionPolicy),
    extraReferenceSourceKinds: normalizeExtraReferenceSourceKinds(input.extraReferenceSourceKinds),
    extraReferencePrefixes: normalizeExtraReferencePrefixes(input.extraReferencePrefixes),
    diskLivenessCheck: bool(input.diskLivenessCheck, DEFAULT_CONFIG.diskLivenessCheck),
    postCompactReinjectEnabled: normalizePostCompactReinjectEnabled(input.postCompactReinjectEnabled),
    postCompactReinjectMaxFiles: normalizePostCompactReinjectMaxFiles(input.postCompactReinjectMaxFiles),
    postCompactReinjectMaxBytes: normalizePostCompactReinjectMaxBytes(input.postCompactReinjectMaxBytes),
    postCompactReinjectMaxFileBytes: normalizePostCompactReinjectMaxFileBytes(input.postCompactReinjectMaxFileBytes),
    persistedOutputEnabled: normalizePersistedOutputEnabled(input.persistedOutputEnabled),
    persistedOutputThresholdChars: normalizePersistedOutputThresholdChars(input.persistedOutputThresholdChars),
    persistedOutputHeadChars: normalizePersistedOutputHeadChars(input.persistedOutputHeadChars),
    persistedOutputTailChars: normalizePersistedOutputTailChars(input.persistedOutputTailChars),
    microcompactEnabled: normalizeMicrocompactEnabled(input.microcompactEnabled),
    microcompactKeepRecentTools: normalizeMicrocompactKeepRecentTools(input.microcompactKeepRecentTools),
    microcompactThresholdChars: normalizeMicrocompactThresholdChars(input.microcompactThresholdChars),
    microcompactHeadChars: normalizeMicrocompactHeadChars(input.microcompactHeadChars),
    microcompactTailChars: normalizeMicrocompactTailChars(input.microcompactTailChars),
    microcompactRepeatedReadMinChars: normalizeMicrocompactRepeatedReadMinChars(input.microcompactRepeatedReadMinChars),
    idleFullSummaryEnabled: normalizeIdleFullSummaryEnabled(input.idleFullSummaryEnabled),
    sessionMemoryEnabled: normalizeSessionMemoryEnabled(input.sessionMemoryEnabled),
    sessionMemoryMinTokens: normalizeSessionMemoryMinTokens(input.sessionMemoryMinTokens),
    sessionMemoryUpdateIntervalTokens: normalizeSessionMemoryUpdateIntervalTokens(input.sessionMemoryUpdateIntervalTokens),
    sessionMemoryUpdateIntervalTurns: normalizeSessionMemoryUpdateIntervalTurns(input.sessionMemoryUpdateIntervalTurns),
    sessionMemoryCooldownMs: normalizeSessionMemoryCooldownMs(input.sessionMemoryCooldownMs),
    sessionMemoryMaxBytes: normalizeSessionMemoryMaxBytes(input.sessionMemoryMaxBytes),
    sessionMemoryMaxCallsPerSession: normalizeSessionMemoryMaxCallsPerSession(input.sessionMemoryMaxCallsPerSession),
    contextCollapseEnabled: normalizeContextCollapseEnabled(input.contextCollapseEnabled),
    contextCollapseMinTokens: normalizeContextCollapseMinTokens(input.contextCollapseMinTokens),
    contextCollapseMaxSpanTokens: normalizeContextCollapseMaxSpanTokens(input.contextCollapseMaxSpanTokens),
    contextCollapseKeepRecentTokens: normalizeContextCollapseKeepRecentTokens(input.contextCollapseKeepRecentTokens),
    contextCollapseKeepRecentTurns: normalizeContextCollapseKeepRecentTurns(input.contextCollapseKeepRecentTurns),
    snipEnabled: normalizeSnipEnabled(input.snipEnabled),
    snipKeepRecentTurns: normalizeSnipKeepRecentTurns(input.snipKeepRecentTurns),
    snipKeepRecentTokens: normalizeSnipKeepRecentTokens(input.snipKeepRecentTokens),
    snipMinSavingsTokens: normalizeSnipMinSavingsTokens(input.snipMinSavingsTokens),
    snipMaxSpansPerRescue: normalizeSnipMaxSpansPerRescue(input.snipMaxSpansPerRescue),
    strictHostFingerprints: bool(input.strictHostFingerprints, DEFAULT_CONFIG.strictHostFingerprints),
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

  const explicitKeys = new Set();
  for (const key of EXPLICIT_TRACKED_KEYS) {
    if (input[key] !== undefined) explicitKeys.add(key);
  }
  Object.defineProperty(config, EXPLICIT_CONFIG_KEYS, { value: explicitKeys, enumerable: false });

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
    throw Object.assign(
      new Error(
        `compaction-weave: contextWindow ${contextWindow} leaves no message budget after reserving ${reservedCompletionTokens} completion tokens`,
      ),
      { code: 'COMPACTION_INVALID_BUDGET' },
    );
  }
  // ⚠️ headroom 大于整条消息预算或落在 33,001..39,285 死区时**不能抛错**。
  // 32000–65536 级的小/中窗口（或高 maxTokens 预留）配上默认 33000 headroom 是真实配置，
  // 抛错等于"自动压缩永不触发 / 首条消息即死锁"。这里的语义是"提前量"，不是"硬性门槛"：
  // 当 headroom 超过半数预算或按比例挤压了 retainTokens 时，收敛到四分之一预算（并保留
  // 至少 1 token 净压缩裕量），保证 128k/200k/1M 基线不变且压缩线严格早于阻断线。
  const retainTokens = policy.retainTokens ?? Math.floor(messageBudgetTokens * policy.retainRatio);
  const rawHeadroom = policy.headroomTokens;
  const ratioMode = policy.retainTokens === null || policy.retainTokens === undefined;
  const ratioRetainSqueezed = ratioMode && messageBudgetTokens - rawHeadroom <= retainTokens;
  let effectiveHeadroom =
    rawHeadroom >= messageBudgetTokens ||
    rawHeadroom > Math.floor(messageBudgetTokens * 0.5) ||
    ratioRetainSqueezed
      ? Math.min(rawHeadroom, Math.floor(messageBudgetTokens * 0.25))
      : rawHeadroom;
  if (
    ratioMode &&
    messageBudgetTokens - effectiveHeadroom <= retainTokens &&
    Math.floor(contextWindow * policy.thresholdRatio) > retainTokens
  ) {
    effectiveHeadroom = Math.max(0, Math.min(effectiveHeadroom, messageBudgetTokens - retainTokens - 1));
  }
  const pressureBudgetTokens = messageBudgetTokens - effectiveHeadroom;
  const thresholdTokens = Math.floor(
    Math.min(contextWindow * policy.thresholdRatio, pressureBudgetTokens),
  );
  if (retainTokens >= thresholdTokens) {
    throw Object.assign(
      new Error(
        `compaction-weave: retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens}`,
      ),
      { code: 'COMPACTION_RETAIN_EXCEEDS_THRESHOLD' },
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
    const explicitKeys = new Set(config?.[EXPLICIT_CONFIG_KEYS] ?? []);
    if (policy[EXPLICIT_CONFIG_KEYS]) {
      for (const key of policy[EXPLICIT_CONFIG_KEYS]) explicitKeys.add(key);
    }
    for (const key of EXPLICIT_TRACKED_KEYS) {
      if (policy[key] !== undefined) explicitKeys.add(key);
    }
    Object.defineProperty(merged, EXPLICIT_CONFIG_KEYS, { value: explicitKeys, enumerable: false });
    return merged;
  }
  return config;
}
