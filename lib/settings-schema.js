// Canonical single source of truth for compaction configuration bounds, enums,
// and declarative hot-setting descriptors shared across config.js & summary-config.js.
// Pure leaf module: zero internal imports.

export const MIN_THRESHOLD_RATIO = 0.5;
export const MAX_THRESHOLD_RATIO = 0.95;
export const MIN_REDUCTION_RATIO = 0.05;
export const MAX_REDUCTION_RATIO = 0.9;
export const MAX_TOKENS_LIMIT = 1_000_000;

export const MAX_IDLE_COMPACTION_MINUTES = 30 * 24 * 60;
export const MIN_SUMMARY_CONCURRENCY = 1;
export const MAX_SUMMARY_CONCURRENCY = 6;
export const MIN_SUMMARY_CJK_TOKENS_PER_CHAR = 0.5;
export const MAX_SUMMARY_CJK_TOKENS_PER_CHAR = 1.5;

export const MAX_EXTRA_REFERENCE_SOURCE_KINDS = 64;
export const MAX_EXTRA_REFERENCE_PREFIXES = 64;
export const MIN_EXTRA_REFERENCE_PREFIX_LENGTH = 2;
export const MAX_EXTRA_REFERENCE_PREFIX_LENGTH = 200;

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

export const LANGUAGE_OPTIONS = Object.freeze(['auto', 'zh', 'en']);
export const REASONING_EFFORT_LADDER = Object.freeze([
  'max',
  'xhigh',
  'high',
  'medium',
  'low',
  'minimal',
  'none',
]);
export const SUMMARY_REASONING_EFFORTS = Object.freeze([
  'auto',
  'low',
  'none',
  'inherit',
  'minimal',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export const PRESSURE_BREAKER_ACTIONS = Object.freeze(['confirm', 'degrade', 'block']);
export const AUDIT_EXHAUSTION_POLICIES = Object.freeze(['fallback', 'block']);
export const AUDIT_COVERAGE_SCOPES = Object.freeze(['recent', 'span-new', 'all']);

export const SUMMARY_RETRY_SETTINGS = Object.freeze({
  summaryRetryCount: Object.freeze({ min: 0, max: 4 }),
  summaryRetryDelayMs: Object.freeze({ min: 0, max: 30000 }),
  summaryTimeoutMs: Object.freeze({ min: 5000, max: 3600000 }),
});

export const HOT_BOOLEAN_TOGGLE_SPECS = Object.freeze([
  Object.freeze({
    key: 'observationMaskingEnabled',
    defaultValue: true,
    errorCode: 'INVALID_OBSERVATION_MASKING_ENABLED',
    errorMessage: 'compaction-weave: observationMaskingEnabled must be a boolean',
  }),
  Object.freeze({
    key: 'postCompactReinjectEnabled',
    defaultValue: true,
    errorCode: 'INVALID_POST_COMPACT_REINJECT_ENABLED',
    errorMessage: 'compaction-weave: postCompactReinjectEnabled must be a boolean',
  }),
  Object.freeze({
    key: 'persistedOutputEnabled',
    defaultValue: true,
    errorCode: 'INVALID_PERSISTED_OUTPUT_ENABLED',
    errorMessage: 'compaction-weave: persistedOutputEnabled must be a boolean',
  }),
  Object.freeze({
    key: 'microcompactEnabled',
    defaultValue: true,
    errorCode: 'INVALID_MICROCOMPACT_ENABLED',
    errorMessage: 'compaction-weave: microcompactEnabled must be a boolean',
  }),
  Object.freeze({
    key: 'snipEnabled',
    defaultValue: true,
    errorCode: 'INVALID_SNIP_ENABLED',
    errorMessage: 'compaction-weave: snipEnabled must be a boolean',
  }),
  Object.freeze({
    key: 'sessionMemoryEnabled',
    defaultValue: false,
    errorCode: 'INVALID_SESSION_MEMORY_ENABLED',
    errorMessage: 'compaction-weave: sessionMemoryEnabled must be a boolean',
  }),
  Object.freeze({
    key: 'contextCollapseEnabled',
    defaultValue: false,
    errorCode: 'INVALID_CONTEXT_COLLAPSE_ENABLED',
    errorMessage: 'compaction-weave: contextCollapseEnabled must be a boolean',
  }),
]);

export const STANDALONE_BOOLEAN_SPECS = Object.freeze([
  Object.freeze({
    key: 'auditBlockOnLoss',
    defaultValue: true,
    errorCode: 'INVALID_AUDIT_BLOCK_ON_LOSS',
    errorMessage: 'auditBlockOnLoss must be a boolean',
  }),
  Object.freeze({
    key: 'auditProvenanceBlock',
    defaultValue: true,
    errorCode: 'INVALID_AUDIT_PROVENANCE_BLOCK',
    errorMessage: 'auditProvenanceBlock must be a boolean',
  }),
]);

export const HOT_NUMERIC_FIELD_SPECS = Object.freeze([
  Object.freeze({
    key: 'idleCompactionMinutes',
    defaultValue: 0,
    min: 0,
    max: MAX_IDLE_COMPACTION_MINUTES,
    integer: true,
    acceptDigitString: true,
    errorCode: 'INVALID_IDLE_COMPACTION_MINUTES',
    errorMessage: `compaction-weave: idleCompactionMinutes must be an integer between 0 and ${MAX_IDLE_COMPACTION_MINUTES} (0 disables it)`,
  }),
  Object.freeze({
    key: 'summaryConcurrency',
    defaultValue: 2,
    min: MIN_SUMMARY_CONCURRENCY,
    max: MAX_SUMMARY_CONCURRENCY,
    integer: true,
    acceptDigitString: true,
    errorCode: 'INVALID_SUMMARY_CONCURRENCY',
    errorMessage: `compaction-weave: summaryConcurrency must be an integer between ${MIN_SUMMARY_CONCURRENCY} and ${MAX_SUMMARY_CONCURRENCY}`,
  }),
  Object.freeze({
    key: 'summaryCjkTokensPerChar',
    defaultValue: 0.75,
    min: MIN_SUMMARY_CJK_TOKENS_PER_CHAR,
    max: MAX_SUMMARY_CJK_TOKENS_PER_CHAR,
    integer: false,
    roundHundredths: true,
    ignoreBlankOrNull: true,
    errorCode: 'INVALID_SUMMARY_CJK_TOKENS_PER_CHAR',
    errorMessage: `compaction-weave: summaryCjkTokensPerChar must be a finite number between ${MIN_SUMMARY_CJK_TOKENS_PER_CHAR} and ${MAX_SUMMARY_CJK_TOKENS_PER_CHAR}`,
  }),
  Object.freeze({
    key: 'sessionMemoryMaxCallsPerSession',
    defaultValue: 8,
    min: MIN_SESSION_MEMORY_MAX_CALLS_PER_SESSION,
    max: MAX_SESSION_MEMORY_MAX_CALLS_PER_SESSION,
    integer: true,
    acceptDigitString: true,
    errorCode: 'INVALID_SESSION_MEMORY_MAX_CALLS_PER_SESSION',
    errorMessage: `compaction-weave: sessionMemoryMaxCallsPerSession must be an integer between ${MIN_SESSION_MEMORY_MAX_CALLS_PER_SESSION} and ${MAX_SESSION_MEMORY_MAX_CALLS_PER_SESSION}`,
  }),
  Object.freeze({
    key: 'archiveWarnBytes',
    defaultValue: DEFAULT_ARCHIVE_WARN_BYTES,
    min: 1,
    max: MAX_ARCHIVE_WARN_BYTES,
    integer: true,
    allowZero: true,
    acceptDigitString: true,
    errorCode: 'INVALID_ARCHIVE_WARN_BYTES',
    errorMessage: `compaction-weave: archiveWarnBytes must be an integer between 1 and ${MAX_ARCHIVE_WARN_BYTES}`,
  }),
  Object.freeze({
    key: 'maxVisibleAttachmentBytes',
    defaultValue: DEFAULT_MAX_VISIBLE_ATTACHMENT_BYTES,
    min: 1,
    max: MAX_VISIBLE_ATTACHMENT_BYTES,
    integer: true,
    allowZero: true,
    acceptDigitString: true,
    errorCode: 'INVALID_MAX_VISIBLE_ATTACHMENT_BYTES',
    errorMessage: `compaction-weave: maxVisibleAttachmentBytes must be an integer between 1 and ${MAX_VISIBLE_ATTACHMENT_BYTES}`,
  }),
  Object.freeze({
    key: 'maxVisibleImages',
    defaultValue: DEFAULT_MAX_VISIBLE_IMAGES,
    min: 1,
    max: MAX_VISIBLE_IMAGES,
    integer: true,
    allowZero: true,
    acceptDigitString: true,
    errorCode: 'INVALID_MAX_VISIBLE_IMAGES',
    errorMessage: `compaction-weave: maxVisibleImages must be an integer between 1 and ${MAX_VISIBLE_IMAGES}`,
  }),
]);

export const HOT_ENUM_FIELD_SPECS = Object.freeze([
  Object.freeze({
    key: 'summaryReasoningEffort',
    defaultValue: 'auto',
    values: SUMMARY_REASONING_EFFORTS,
    errorCode: 'INVALID_SUMMARY_REASONING_EFFORT',
    errorMessage: `compaction-weave: summaryReasoningEffort must be one of ${SUMMARY_REASONING_EFFORTS.join(', ')}`,
  }),
  Object.freeze({
    key: 'pressureBreakerAction',
    defaultValue: 'confirm',
    values: PRESSURE_BREAKER_ACTIONS,
    errorCode: 'INVALID_PRESSURE_BREAKER_ACTION',
    errorMessage: `compaction-weave: pressureBreakerAction must be one of ${PRESSURE_BREAKER_ACTIONS.join(', ')}`,
  }),
  Object.freeze({
    key: 'auditExhaustionPolicy',
    defaultValue: 'fallback',
    values: AUDIT_EXHAUSTION_POLICIES,
    errorCode: 'INVALID_AUDIT_EXHAUSTION_POLICY',
    errorMessage: `compaction-weave: auditExhaustionPolicy must be one of ${AUDIT_EXHAUSTION_POLICIES.join(', ')}`,
  }),
  Object.freeze({
    key: 'auditCoverageScope',
    defaultValue: 'recent',
    values: AUDIT_COVERAGE_SCOPES,
    errorCode: 'INVALID_AUDIT_COVERAGE_SCOPE',
    errorMessage: `compaction-weave: auditCoverageScope must be one of ${AUDIT_COVERAGE_SCOPES.join(', ')}`,
  }),
]);
