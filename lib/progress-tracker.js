// Real-time, cross-isolate compaction & migration progress telemetry tracker.
//
// Strictly allowlisted metadata ONLY: never stores or exposes raw prompts,
// message prose, draft summary text, reasoning text, credentials, or arbitrary errors.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isRateLimitError } from './concurrency.js';
import { failureExplanation } from './failure-diagnostics.js';
import { isBiliProxyPreflightError, isWindowOverflowError, sanitizeBiliConflict } from './bili-conflict.js';
import { PLUGIN_VERSION } from './version.js';
import { containsSecretCredential, hasSecretPrefix, redactCredentials } from './redact.js';

export const PROGRESS_PHASES = Object.freeze([
  'idle',
  'detecting',
  'backing_up',
  'masking',
  'planning',
  'summarizing',
  'folding',
  'continuing',
  'auditing',
  'committing',
  'migrating',
  'restoring',
  'done',
  'error',
]);

const PHASE_SET = new Set(PROGRESS_PHASES);
const TRIGGER_SET = new Set([
  'manual',
  'pressure',
  'context-overflow',
  'idle',
  'proactive',
  'migration',
  'restore',
]);

const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_DONE_TTL_MS = 60_000;
const DEFAULT_ERROR_TTL_MS = 60_000;
const MAX_MESSAGE_CHARS = 240;
const MAX_MESSAGE_PARAMS = 16;

const SAFE_CODE_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const SAFE_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_ROUTE_RE = /^[A-Za-z0-9@][A-Za-z0-9._/@:+-]{0,199}$/;
const GENERIC_RETRY_ERROR_CODES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
  'ERROR',
  'UNKNOWN',
]);
const RETRY_CODE_ALIASES = new Map([
  ['context_length_exceeded', 'CONTEXT_WINDOW_EXCEEDED'],
  ['context_window_exceeded', 'CONTEXT_WINDOW_EXCEEDED'],
  ['prompt_too_long', 'CONTEXT_WINDOW_EXCEEDED'],
  ['max_tokens', 'MAX_TOKENS'],
  ['rate_limited', 'RATE_LIMITED'],
  ['rate_limit_exceeded', 'RATE_LIMITED'],
  ['too_many_requests', 'RATE_LIMITED'],
]);

function safeRetryReasonCode(value) {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (
    !trimmed ||
    !SAFE_CODE_RE.test(trimmed) ||
    containsSecretCredential(trimmed) ||
    hasSecretPrefix(trimmed) ||
    GENERIC_RETRY_ERROR_CODES.has(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

/**
 * Extract a strictly sanitized retry reason code from a failed summary attempt
 * error. Never returns raw prose, generic JS error names, or secret-like tokens.
 *
 * @param {unknown} error
 * @returns {string | null}
 */
export function normalizeRetryReasonCode(error) {
  if (!error) return null;
  if (isBiliProxyPreflightError(error)) {
    return 'BILI_PROXY_CONFLICT';
  }
  if (
    isRateLimitError(error) ||
    error?.httpStatus === 429 ||
    error?.status === 429 ||
    error?.statusCode === 429 ||
    error?.cause?.httpStatus === 429
  ) {
    return 'RATE_LIMITED';
  }
  if (typeof error !== 'object') return null;
  const raw = error.failureCode ?? error.code ?? error.cause?.failureCode ?? error.cause?.code ?? null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const aliased = RETRY_CODE_ALIASES.get(trimmed.toLowerCase());
    if (aliased) return aliased;
    const safe = safeRetryReasonCode(trimmed);
    if (safe) return safe;
  }
  if (isWindowOverflowError(error)) {
    return 'CONTEXT_WINDOW_EXCEEDED';
  }
  return null;
}

function safeNonNegInt(value) {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return undefined;
}

function safePositiveInt(value) {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
    return Math.floor(value);
  }
  return undefined;
}

function safeBool(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function safePercent(value) {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }
  return undefined;
}

function safeTrigger(value) {
  if (value === null) return null;
  return typeof value === 'string' && TRIGGER_SET.has(value) ? value : undefined;
}

function safePhase(value) {
  return typeof value === 'string' && PHASE_SET.has(value) ? value : undefined;
}

function safeRoute(value) {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || !SAFE_ROUTE_RE.test(trimmed) || hasSecretPrefix(trimmed) || containsSecretCredential(trimmed)) {
    return null;
  }
  return trimmed;
}

function safeMessageKey(value) {
  if (value === null) return null;
  return typeof value === 'string' && SAFE_KEY_RE.test(value) ? value : undefined;
}

function safeShortText(value) {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const redacted = redactCredentials(value, {
    pemReplacement: '[redacted-private-key]',
    tokenReplacement: '<redacted>',
  });
  const cleaned = redacted.replace(/[\r\n]+/g, ' ').trim();
  return cleaned.length > MAX_MESSAGE_CHARS ? cleaned.slice(0, MAX_MESSAGE_CHARS - 1) + '…' : cleaned;
}

function safeMessageParams(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  let count = 0;
  for (const [k, v] of Object.entries(value)) {
    if (count >= MAX_MESSAGE_PARAMS) break;
    if (!SAFE_KEY_RE.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
      count += 1;
    } else if (typeof v === 'boolean' || v === null) {
      out[k] = v;
      count += 1;
    } else if (
      typeof v === 'string' &&
      v.length <= 80 &&
      !containsSecretCredential(v) &&
      !hasSecretPrefix(v)
    ) {
      out[k] = v;
      count += 1;
    }
  }
  return out;
}

function safeErrorObject(error) {
  if (!error) return { code: 'UNKNOWN', message: '压缩未完成（UNKNOWN）。' };
  const rawCode =
    typeof error === 'object' ? (error.failureCode ?? error.code ?? error.name) : null;
  const code = typeof rawCode === 'string' && SAFE_CODE_RE.test(rawCode) ? rawCode : 'UNKNOWN';
  let message;
  try {
    message = safeShortText(
      typeof error === 'object' ? failureExplanation(error) : `压缩未完成（${code}）。`,
    );
  } catch {
    message = `压缩未完成（${code}）。`;
  }
  return { code, message: message || `压缩未完成（${code}）。` };
}

function sanitizeStreamPatch(prev, patch) {
  if (patch === null) return null;
  if (!patch || typeof patch !== 'object') return prev;
  const base = prev ?? {
    chunks: 0,
    textChars: 0,
    reasoningChars: 0,
    firstChunkMs: null,
    idleMs: 0,
  };
  const next = { ...base };
  for (const key of ['chunks', 'textChars', 'reasoningChars', 'firstChunkMs', 'idleMs']) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const val = safeNonNegInt(patch[key]);
    if (val !== undefined) next[key] = val;
  }
  return next;
}

function sanitizeResumable(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rawJobId = typeof raw.jobId === 'string' ? raw.jobId.trim() : '';
  if (!rawJobId || !SAFE_ID_RE.test(rawJobId) || containsSecretCredential(rawJobId) || hasSecretPrefix(rawJobId)) {
    return null;
  }
  const rawStatus = typeof raw.status === 'string' && SAFE_KEY_RE.test(raw.status) ? raw.status : null;
  const rawReason =
    typeof raw.interruptReason === 'string' && SAFE_KEY_RE.test(raw.interruptReason)
      ? raw.interruptReason
      : null;
  const rawCode =
    typeof raw.lastErrorCode === 'string' && SAFE_CODE_RE.test(raw.lastErrorCode)
      ? raw.lastErrorCode
      : null;
  let updatedAt = null;
  if (typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)) {
    updatedAt = Math.floor(raw.updatedAt);
  } else if (
    typeof raw.updatedAt === 'string' &&
    raw.updatedAt.length > 0 &&
    raw.updatedAt.length <= 64 &&
    !containsSecretCredential(raw.updatedAt) &&
    !hasSecretPrefix(raw.updatedAt)
  ) {
    updatedAt = raw.updatedAt;
  }
  return {
    jobId: rawJobId,
    trigger: safeTrigger(raw.trigger) ?? null,
    status: rawStatus,
    interruptReason: rawReason,
    overallPercent: safePercent(raw.overallPercent) ?? 0,
    completedChunks: safeNonNegInt(raw.completedChunks) ?? 0,
    remainingNodes: safeNonNegInt(raw.remainingNodes) ?? 0,
    remainingTokens: safeNonNegInt(raw.remainingTokens) ?? null,
    initialTotalTokens: safeNonNegInt(raw.initialTotalTokens) ?? null,
    completedTokens: safeNonNegInt(raw.completedTokens) ?? null,
    updatedAt,
    canAutoResume: Boolean(raw.canAutoResume),
    lastErrorCode: rawCode,
    lastErrorMessage: safeShortText(raw.lastErrorMessage) ?? null,
  };
}

function sanitizeDiagnosticPath(value) {
  if (typeof value !== 'string') return null;
  if (/[\r\n]/.test(value)) return null;
  const cleaned = redactCredentials(value, {
    pemReplacement: '[redacted-private-key]',
    tokenReplacement: '<redacted>',
  }).trim();
  if (!cleaned || cleaned.length > 512) return null;
  return cleaned;
}

function sanitizeBreaker(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const stopped = raw.stopped === true;
  const failures = safeNonNegInt(raw.failures) ?? 0;
  const breakerBypassed = raw.breakerBypassed === true;
  const pressureBreakerAction = ['confirm', 'degrade', 'block'].includes(raw.pressureBreakerAction)
    ? raw.pressureBreakerAction
    : 'confirm';
  const lastFailureCode =
    typeof raw.lastFailureCode === 'string' && SAFE_CODE_RE.test(raw.lastFailureCode.trim())
      ? raw.lastFailureCode.trim()
      : null;
  const lastDiagnosticId =
    typeof raw.lastDiagnosticId === 'string' && SAFE_ID_RE.test(raw.lastDiagnosticId.trim())
      ? raw.lastDiagnosticId.trim()
      : null;
  const lastDiagnosticPath = sanitizeDiagnosticPath(raw.lastDiagnosticPath);
  return {
    stopped,
    failures,
    breakerBypassed,
    pressureBreakerAction,
    lastFailureCode,
    lastDiagnosticId,
    lastDiagnosticPath,
  };
}

function sanitizeArchiveWarning(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const totalBytes = safeNonNegInt(raw.totalBytes);
  const warnBytes = safeNonNegInt(raw.warnBytes);
  if (totalBytes === null || warnBytes === null || warnBytes <= 0 || totalBytes < warnBytes) {
    return null;
  }
  const legacyPlainSpanCount = safeNonNegInt(raw.legacyPlainSpanCount) ?? 0;
  return {
    warnExceeded: true,
    totalBytes,
    warnBytes,
    legacyPlainSpanCount,
  };
}

function idleSnapshot(sessionId, extras = {}) {
  const breaker = sanitizeBreaker(extras.breaker);
  const biliConflict = sanitizeBiliConflict(extras.biliConflict);
  const archiveWarning = sanitizeArchiveWarning(extras.archiveWarning);
  return {
    active: false,
    runId: null,
    seq: 0,
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    trigger: null,
    phase: 'idle',
    turn: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    elapsedMs: 0,
    waveIndex: null,
    waveTotal: null,
    chunkIndex: null,
    chunkTotal: null,
    pageIndex: null,
    pageTotal: null,
    attempt: null,
    maxAttempts: null,
    retryReasonCode: null,
    auditFallbackCount: null,
    beforeTokens: null,
    currentTokens: null,
    targetTokens: null,
    overallPercent: null,
    overallProcessedTokens: null,
    overallTotalTokens: null,
    overallProcessedNodes: null,
    overallTotalNodes: null,
    maskedCount: 0,
    maskedTokensSaved: 0,
    auxInputTokens: null,
    auxReasoningTokens: null,
    auxCacheReadTokens: null,
    auxCacheWriteTokens: null,
    reinjectBytes: null,
    reinjectFiles: null,
    summaryModel: null,
    stream: null,
    messageKey: null,
    messageParams: null,
    message: null,
    error: null,
    cancellable: false,
    concurrency: null,
    activeWorkers: null,
    rateLimited: false,
    resumable: sanitizeResumable(extras.resumable),
    breaker,
    stopped: breaker?.stopped === true,
    breakerBypassed: breaker?.breakerBypassed === true,
    pressureBreakerAction: breaker?.pressureBreakerAction ?? 'confirm',
    lastFailureCode: breaker?.lastFailureCode ?? null,
    lastDiagnosticId: breaker?.lastDiagnosticId ?? null,
    lastDiagnosticPath: breaker?.lastDiagnosticPath ?? null,
    pluginVersion: PLUGIN_VERSION,
    ...(biliConflict !== null ? { biliConflict } : {}),
    ...(archiveWarning !== null ? { archiveWarning } : {}),
    ...(extras.bili !== undefined ? { bili: extras.bili } : {}),
    ...(extras.backup !== undefined ? { backup: extras.backup } : {}),
  };
}

export class CompactionProgressTracker {
  /**
   * @param {{ maxSessions?: number, doneTtlMs?: number, errorTtlMs?: number, clock?: () => number }} [options]
   */
  constructor(options = {}) {
    this.maxSessions = Math.max(1, Math.floor(options.maxSessions ?? DEFAULT_MAX_SESSIONS));
    this.doneTtlMs = Math.max(0, Math.floor(options.doneTtlMs ?? DEFAULT_DONE_TTL_MS));
    this.errorTtlMs = Math.max(0, Math.floor(options.errorTtlMs ?? DEFAULT_ERROR_TTL_MS));
    this._clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
    this._records = new Map();
    this._cancels = new Map();
    this._scope = new AsyncLocalStorage();
  }

  _touchLru(sessionId, record) {
    this._records.delete(sessionId);
    this._records.set(sessionId, record);
    this._evictIfNeeded();
  }

  _evictIfNeeded() {
    if (this._records.size <= this.maxSessions) return;
    const now = this._clock();
    // Evict expired terminal records first.
    for (const [id, rec] of this._records) {
      if (!rec.active && rec.expiresAt !== null && now >= rec.expiresAt) {
        this._records.delete(id);
        this._cancels.delete(id);
        if (this._records.size <= this.maxSessions) return;
      }
    }
    // Evict oldest inactive records next.
    for (const [id, rec] of this._records) {
      if (!rec.active) {
        this._records.delete(id);
        this._cancels.delete(id);
        if (this._records.size <= this.maxSessions) return;
      }
    }
    // Last resort: evict oldest LRU record to strictly honor the bounded map cap.
    while (this._records.size > this.maxSessions) {
      const oldest = this._records.keys().next().value;
      this._records.delete(oldest);
      this._cancels.delete(oldest);
    }
  }

  _getValidRecord(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    const rec = this._records.get(sessionId);
    if (!rec) {
      this._cancels.delete(sessionId);
      return null;
    }
    const now = this._clock();
    if (!rec.active && rec.expiresAt !== null && now >= rec.expiresAt) {
      this._records.delete(sessionId);
      this._cancels.delete(sessionId);
      return null;
    }
    return rec;
  }

  _resolveExpectedRunId(sessionId, options) {
    if (typeof options?.runId === 'string' && options.runId.length > 0) return options.runId;
    const scoped = this._scope.getStore();
    if (scoped?.owner === this && scoped.sessionId === sessionId) return scoped.runId;
    return null;
  }

  _applyAllowlistedPatch(record, patch, { accumulateAuxUsage = false } = {}) {
    if (!patch || typeof patch !== 'object') return;

    const prevChunkIndex = record.chunkIndex;
    const prevPageIndex = record.pageIndex;
    const prevWaveIndex = record.waveIndex;

    if (Object.prototype.hasOwnProperty.call(patch, 'trigger')) {
      const v = safeTrigger(patch.trigger);
      if (v !== undefined) record.trigger = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'phase')) {
      const v = safePhase(patch.phase);
      if (v !== undefined) record.phase = v;
    }
    for (const key of [
      'turn',
      'waveIndex',
      'waveTotal',
      'chunkIndex',
      'chunkTotal',
      'pageIndex',
      'pageTotal',
      'attempt',
      'maxAttempts',
      'auditFallbackCount',
      'beforeTokens',
      'currentTokens',
      'targetTokens',
      'maskedCount',
      'maskedTokensSaved',
      'reinjectBytes',
      'reinjectFiles',
    ]) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      const v = safeNonNegInt(patch[key]);
      if (v !== undefined) record[key] = v;
    }
    // Request usage is a delta; ordinary telemetry patches retain snapshot semantics.
    for (const key of ['auxInputTokens', 'auxReasoningTokens', 'auxCacheReadTokens', 'auxCacheWriteTokens']) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      const delta = safeNonNegInt(patch[key]);
      if (delta === undefined) continue;
      if (delta === null) {
        if (!accumulateAuxUsage || !record.active) record[key] = null;
      } else {
        record[key] = accumulateAuxUsage && record.active ? (record[key] ?? 0) + delta : delta;
      }
    }
    const indexAdvanced =
      (record.chunkIndex !== null && record.chunkIndex !== prevChunkIndex) ||
      (record.pageIndex !== null && record.pageIndex !== prevPageIndex) ||
      (record.waveIndex !== null && record.waveIndex !== prevWaveIndex);
    if (Object.prototype.hasOwnProperty.call(patch, 'retryReasonCode')) {
      const v = safeRetryReasonCode(patch.retryReasonCode);
      if (v !== undefined) record.retryReasonCode = v;
      else if (indexAdvanced) record.retryReasonCode = null;
    } else if (indexAdvanced) {
      record.retryReasonCode = null;
    }
    for (const key of ['overallTotalTokens', 'overallTotalNodes']) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      const v = safeNonNegInt(patch[key]);
      if (v === undefined) continue;
      if (v === null) {
        if (!record.active) record[key] = null;
      } else {
        const prev = typeof record[key] === 'number' ? record[key] : 0;
        record[key] = record.active ? Math.max(prev, v) : v;
      }
    }
    for (const [key, totalKey] of [
      ['overallProcessedTokens', 'overallTotalTokens'],
      ['overallProcessedNodes', 'overallTotalNodes'],
    ]) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      const v = safeNonNegInt(patch[key]);
      if (v === undefined) continue;
      if (v === null) {
        if (!record.active) record[key] = null;
      } else {
        const prev = typeof record[key] === 'number' ? record[key] : 0;
        const total = typeof record[totalKey] === 'number' && record[totalKey] > 0 ? record[totalKey] : null;
        const clamped = total !== null ? Math.min(v, total) : v;
        record[key] = record.active ? Math.max(prev, clamped) : clamped;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'overallPercent')) {
      const v = safePercent(patch.overallPercent);
      if (v !== undefined) {
        if (v === null) {
          if (!record.active) record.overallPercent = null;
        } else {
          const prev = typeof record.overallPercent === 'number' ? record.overallPercent : 0;
          record.overallPercent = Math.max(prev, v);
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'summaryModel')) {
      const v = safeRoute(patch.summaryModel);
      if (v !== undefined) record.summaryModel = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'stream')) {
      record.stream = sanitizeStreamPatch(record.stream, patch.stream);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'messageKey')) {
      const v = safeMessageKey(patch.messageKey);
      if (v !== undefined) record.messageKey = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'messageParams')) {
      const v = safeMessageParams(patch.messageParams);
      if (v !== undefined) record.messageParams = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'message')) {
      const v = safeShortText(patch.message);
      if (v !== undefined) record.message = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'concurrency')) {
      const v = safePositiveInt(patch.concurrency);
      if (v !== undefined) record.concurrency = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'activeWorkers')) {
      const v = safeNonNegInt(patch.activeWorkers);
      if (v !== undefined) record.activeWorkers = v;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'rateLimited')) {
      const v = safeBool(patch.rateLimited);
      if (v !== undefined) record.rateLimited = v;
    }
  }

  /**
   * Run an async operation inside a tracked compaction/migration run scope.
   * Nested `withRun` calls for the same session join the parent `runId` so
   * multi-chunk / rolling-wave operations never flicker or reset `startedAt`.
   */
  async withRun(sessionId, meta = {}, fn) {
    if (typeof meta === 'function') {
      fn = meta;
      meta = {};
    }
    if (typeof fn !== 'function') {
      throw new TypeError('CompactionProgressTracker.withRun requires a callback function');
    }
    if (typeof sessionId !== 'string' || !sessionId) {
      return fn(null);
    }

    const parent = this._scope.getStore();
    if (parent?.owner === this && parent.sessionId === sessionId) {
      const existing = this._records.get(sessionId);
      if (existing && existing.runId === parent.runId && existing.active) {
        this._applyAllowlistedPatch(existing, meta);
        existing.seq += 1;
        existing.updatedAt = this._clock();
        this._touchLru(sessionId, existing);
      }
      return fn(parent.runId);
    }

    const now = this._clock();
    const prev = this._records.get(sessionId);
    const runId = randomUUID();
    const record = {
      active: true,
      runId,
      seq: (prev?.seq ?? 0) + 1,
      sessionId,
      trigger: safeTrigger(meta?.trigger) ?? null,
      phase: safePhase(meta?.phase) ?? 'detecting',
      turn: safeNonNegInt(meta?.turn) ?? null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      expiresAt: null,
      waveIndex: null,
      waveTotal: null,
      chunkIndex: null,
      chunkTotal: null,
      pageIndex: null,
      pageTotal: null,
      attempt: null,
      maxAttempts: null,
      retryReasonCode: null,
      auditFallbackCount: null,
      beforeTokens: null,
      currentTokens: null,
      targetTokens: null,
      overallPercent: safePercent(meta?.overallPercent) ?? 0,
      overallProcessedTokens: safeNonNegInt(meta?.overallProcessedTokens) ?? null,
      overallTotalTokens: safeNonNegInt(meta?.overallTotalTokens) ?? null,
      overallProcessedNodes: safeNonNegInt(meta?.overallProcessedNodes) ?? null,
      overallTotalNodes: safeNonNegInt(meta?.overallTotalNodes) ?? null,
      maskedCount: 0,
      maskedTokensSaved: 0,
      auxInputTokens: null,
      auxReasoningTokens: null,
      auxCacheReadTokens: null,
      auxCacheWriteTokens: null,
      reinjectBytes: null,
      reinjectFiles: null,
      summaryModel: null,
      stream: null,
      messageKey: null,
      messageParams: null,
      message: null,
      error: null,
      concurrency: null,
      activeWorkers: null,
      rateLimited: false,
    };
    this._cancels.delete(sessionId);
    this._applyAllowlistedPatch(record, meta);
    this._touchLru(sessionId, record);

    return this._scope.run({ owner: this, sessionId, runId }, async () => {
      try {
        const result = await fn(runId);
        const current = this._records.get(sessionId);
        if (current && current.runId === runId && current.active) {
          this.finish(sessionId, {}, { runId });
        }
        return result;
      } catch (error) {
        const current = this._records.get(sessionId);
        if (current && current.runId === runId && current.active) {
          this.fail(sessionId, error, { runId });
        }
        throw error;
      }
    });
  }

  /**
   * Apply an allowlisted telemetry update to the active run for `sessionId`.
   * Ignores stale updates whose `runId` does not match the current active run.
   */
  update(sessionId, patch = {}, options = {}) {
    const rec = this._getValidRecord(sessionId);
    if (!rec || !rec.active) return false;
    const expectedRunId = this._resolveExpectedRunId(sessionId, options);
    if (expectedRunId !== null && rec.runId !== expectedRunId) return false;

    const prevPhase = rec.phase;
    this._applyAllowlistedPatch(rec, patch, options);
    if (rec.phase === 'done' || rec.phase === 'error' || rec.phase === 'idle') {
      // Terminal state transitions must use finish()/fail() to set TTL cleanly.
      rec.phase = prevPhase;
    }
    rec.seq += 1;
    rec.updatedAt = this._clock();
    this._touchLru(sessionId, rec);
    return true;
  }

  /**
   * Update numeric stream liveness metrics (never retains draft text or reasoning content).
   */
  updateStream(sessionId, streamPatch = {}, options = {}) {
    const rec = this._getValidRecord(sessionId);
    if (!rec || !rec.active) return false;
    const expectedRunId = this._resolveExpectedRunId(sessionId, options);
    if (expectedRunId !== null && rec.runId !== expectedRunId) return false;

    rec.stream = sanitizeStreamPatch(rec.stream, streamPatch);
    rec.seq += 1;
    rec.updatedAt = this._clock();
    this._touchLru(sessionId, rec);
    return true;
  }

  /**
   * Transition an active run to terminal `done` with bounded TTL retention.
   */
  finish(sessionId, patch = {}, options = {}) {
    const rec = this._getValidRecord(sessionId);
    if (!rec) return false;
    const expectedRunId = this._resolveExpectedRunId(sessionId, options);
    if (expectedRunId !== null && rec.runId !== expectedRunId) return false;

    const now = this._clock();
    this._applyAllowlistedPatch(rec, patch);
    rec.active = false;
    rec.phase = 'done';
    rec.overallPercent = 100;
    if (typeof rec.overallTotalTokens === 'number' && rec.overallTotalTokens > 0) {
      rec.overallProcessedTokens = rec.overallTotalTokens;
    }
    if (typeof rec.overallTotalNodes === 'number' && rec.overallTotalNodes > 0) {
      rec.overallProcessedNodes = rec.overallTotalNodes;
    }
    rec.error = null;
    rec.retryReasonCode = null;
    if (rec.activeWorkers !== null) rec.activeWorkers = 0;
    rec.finishedAt = now;
    rec.updatedAt = now;
    rec.expiresAt = now + this.doneTtlMs;
    rec.seq += 1;
    this._cancels.delete(sessionId);
    this._touchLru(sessionId, rec);
    return true;
  }

  /**
   * Transition an active run to terminal `error` with allowlisted error metadata and TTL.
   */
  fail(sessionId, error, options = {}) {
    const rec = this._getValidRecord(sessionId);
    if (!rec) return false;
    const expectedRunId = this._resolveExpectedRunId(sessionId, options);
    if (expectedRunId !== null && rec.runId !== expectedRunId) return false;

    const now = this._clock();
    rec.active = false;
    rec.phase = 'error';
    if (rec.activeWorkers !== null) rec.activeWorkers = 0;
    rec.error = safeErrorObject(error);
    rec.messageKey = 'phase_error';
    rec.message = rec.error.message;
    rec.finishedAt = now;
    rec.updatedAt = now;
    rec.expiresAt = now + this.errorTtlMs;
    rec.seq += 1;
    this._cancels.delete(sessionId);
    this._touchLru(sessionId, rec);
    return true;
  }

  /**
   * Register an AbortController for the active run of `sessionId`.
   * Cleared automatically when the run finishes, fails, is cleared, or is replaced.
   */
  registerCancel(sessionId, runId, controller) {
    if (
      typeof sessionId !== 'string' ||
      !sessionId ||
      typeof runId !== 'string' ||
      !runId ||
      !controller ||
      typeof controller.abort !== 'function'
    ) {
      return false;
    }
    const rec = this._getValidRecord(sessionId);
    if (!rec || !rec.active || rec.runId !== runId) return false;
    this._cancels.set(sessionId, { runId, controller });
    rec.seq += 1;
    rec.updatedAt = this._clock();
    this._touchLru(sessionId, rec);
    return true;
  }

  /**
   * Abort the active run's registered AbortController if present.
   */
  cancelRun(sessionId, reason) {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { cancelled: false, runId: null };
    }
    const rec = this._getValidRecord(sessionId);
    if (!rec || !rec.active) {
      this._cancels.delete(sessionId);
      return { cancelled: false, runId: null };
    }
    const entry = this._cancels.get(sessionId);
    if (!entry || entry.runId !== rec.runId) {
      return { cancelled: false, runId: null };
    }
    this._cancels.delete(sessionId);
    const abortReason =
      reason instanceof Error
        ? reason
        : Object.assign(
            new Error(typeof reason === 'string' && reason.trim() ? reason.trim() : 'compaction cancelled by user'),
            { code: 'ABORTED', userCancelled: true },
          );
    try {
      entry.controller.abort(abortReason);
    } catch {
      /* best-effort abort */
    }
    rec.seq += 1;
    rec.updatedAt = this._clock();
    this._touchLru(sessionId, rec);
    return { cancelled: true, runId: entry.runId };
  }

  isCancellable(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const rec = this._getValidRecord(sessionId);
    if (!rec || !rec.active) {
      this._cancels.delete(sessionId);
      return false;
    }
    const entry = this._cancels.get(sessionId);
    if (!entry || entry.runId !== rec.runId) return false;
    if (entry.controller.signal?.aborted) return false;
    return true;
  }

  hasActiveRun(sessionId) {
    const rec = this._getValidRecord(sessionId);
    return Boolean(rec && rec.active === true);
  }

  clear(sessionId) {
    if (typeof sessionId === 'string') {
      this._records.delete(sessionId);
      this._cancels.delete(sessionId);
    }
  }

  /**
   * Return the unified backward-compatible `status` RPC snapshot for `sessionId`.
   */
  snapshot(sessionId, extras = {}) {
    const rec = this._getValidRecord(sessionId);
    if (!rec) return idleSnapshot(sessionId, extras);
    const now = this._clock();
    const endTime = rec.finishedAt ?? now;
    const breaker = sanitizeBreaker(extras.breaker);
    const biliConflict = sanitizeBiliConflict(extras.biliConflict);
    const archiveWarning = sanitizeArchiveWarning(extras.archiveWarning);
    return {
      active: rec.active,
      runId: rec.runId,
      seq: rec.seq,
      sessionId: rec.sessionId,
      trigger: rec.trigger,
      phase: rec.phase,
      turn: rec.turn,
      startedAt: rec.startedAt,
      updatedAt: rec.updatedAt,
      finishedAt: rec.finishedAt,
      elapsedMs: rec.startedAt === null ? 0 : Math.max(0, endTime - rec.startedAt),
      waveIndex: rec.waveIndex,
      waveTotal: rec.waveTotal,
      chunkIndex: rec.chunkIndex,
      chunkTotal: rec.chunkTotal,
      pageIndex: rec.pageIndex,
      pageTotal: rec.pageTotal,
      attempt: rec.attempt,
      maxAttempts: rec.maxAttempts,
      retryReasonCode: rec.retryReasonCode,
      auditFallbackCount: rec.auditFallbackCount,
      beforeTokens: rec.beforeTokens,
      currentTokens: rec.currentTokens,
      targetTokens: rec.targetTokens,
      overallPercent: rec.overallPercent,
      overallProcessedTokens: rec.overallProcessedTokens,
      overallTotalTokens: rec.overallTotalTokens,
      overallProcessedNodes: rec.overallProcessedNodes,
      overallTotalNodes: rec.overallTotalNodes,
      maskedCount: rec.maskedCount,
      maskedTokensSaved: rec.maskedTokensSaved,
      auxInputTokens: rec.auxInputTokens,
      auxReasoningTokens: rec.auxReasoningTokens,
      auxCacheReadTokens: rec.auxCacheReadTokens,
      auxCacheWriteTokens: rec.auxCacheWriteTokens,
      reinjectBytes: rec.reinjectBytes,
      reinjectFiles: rec.reinjectFiles,
      summaryModel: rec.summaryModel,
      stream: rec.stream ? { ...rec.stream } : null,
      messageKey: rec.messageKey,
      messageParams: rec.messageParams ? { ...rec.messageParams } : null,
      message: rec.message,
      error: rec.error ? { ...rec.error } : null,
      cancellable: this.isCancellable(sessionId),
      concurrency: rec.concurrency,
      activeWorkers: rec.activeWorkers,
      rateLimited: rec.rateLimited,
      resumable: sanitizeResumable(extras.resumable),
      breaker,
      stopped: breaker?.stopped === true,
      breakerBypassed: breaker?.breakerBypassed === true,
      pressureBreakerAction: breaker?.pressureBreakerAction ?? 'confirm',
      lastFailureCode: breaker?.lastFailureCode ?? null,
      lastDiagnosticId: breaker?.lastDiagnosticId ?? null,
      lastDiagnosticPath: breaker?.lastDiagnosticPath ?? null,
      pluginVersion: PLUGIN_VERSION,
      ...(biliConflict !== null ? { biliConflict } : {}),
      ...(archiveWarning !== null ? { archiveWarning } : {}),
      ...(extras.bili !== undefined ? { bili: extras.bili } : {}),
      ...(extras.backup !== undefined ? { backup: extras.backup } : {}),
    };
  }
}
