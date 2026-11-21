// Real-time, cross-isolate compaction & migration progress telemetry tracker.
//
// Strictly allowlisted metadata ONLY: never stores or exposes raw prompts,
// message prose, draft summary text, reasoning text, credentials, or arbitrary errors.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { failureExplanation } from './failure-diagnostics.js';

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

const SECRET_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{8,})\b/gi;
const SECRET_TEST_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{8,})\b/i;
const SAFE_CODE_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const SAFE_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_ROUTE_RE = /^[A-Za-z0-9@][A-Za-z0-9._/@:+-]{0,199}$/;

function safeNonNegInt(value) {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return undefined;
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
  if (!trimmed || !SAFE_ROUTE_RE.test(trimmed) || /^(?:sk-|gh[pousr]_)/i.test(trimmed)) {
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
  const cleaned = value.replace(SECRET_RE, '<redacted>').replace(/[\r\n]+/g, ' ').trim();
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
    } else if (typeof v === 'string' && v.length <= 80 && !SECRET_TEST_RE.test(v)) {
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

function idleSnapshot(sessionId, extras = {}) {
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
    summaryModel: null,
    stream: null,
    messageKey: null,
    messageParams: null,
    message: null,
    error: null,
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
        if (this._records.size <= this.maxSessions) return;
      }
    }
    // Evict oldest inactive records next.
    for (const [id, rec] of this._records) {
      if (!rec.active) {
        this._records.delete(id);
        if (this._records.size <= this.maxSessions) return;
      }
    }
    // Last resort: evict oldest LRU record to strictly honor the bounded map cap.
    while (this._records.size > this.maxSessions) {
      const oldest = this._records.keys().next().value;
      this._records.delete(oldest);
    }
  }

  _getValidRecord(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    const rec = this._records.get(sessionId);
    if (!rec) return null;
    const now = this._clock();
    if (!rec.active && rec.expiresAt !== null && now >= rec.expiresAt) {
      this._records.delete(sessionId);
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

  _applyAllowlistedPatch(record, patch) {
    if (!patch || typeof patch !== 'object') return;

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
      'beforeTokens',
      'currentTokens',
      'targetTokens',
      'maskedCount',
      'maskedTokensSaved',
    ]) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      const v = safeNonNegInt(patch[key]);
      if (v !== undefined) record[key] = v;
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
      summaryModel: null,
      stream: null,
      messageKey: null,
      messageParams: null,
      message: null,
      error: null,
    };
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
    this._applyAllowlistedPatch(rec, patch);
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
    rec.finishedAt = now;
    rec.updatedAt = now;
    rec.expiresAt = now + this.doneTtlMs;
    rec.seq += 1;
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
    rec.error = safeErrorObject(error);
    rec.messageKey = 'phase_error';
    rec.message = rec.error.message;
    rec.finishedAt = now;
    rec.updatedAt = now;
    rec.expiresAt = now + this.errorTtlMs;
    rec.seq += 1;
    this._touchLru(sessionId, rec);
    return true;
  }

  hasActiveRun(sessionId) {
    const rec = this._getValidRecord(sessionId);
    return Boolean(rec && rec.active === true);
  }

  clear(sessionId) {
    if (typeof sessionId === 'string') this._records.delete(sessionId);
  }

  /**
   * Return the unified backward-compatible `status` RPC snapshot for `sessionId`.
   */
  snapshot(sessionId, extras = {}) {
    const rec = this._getValidRecord(sessionId);
    if (!rec) return idleSnapshot(sessionId, extras);
    const now = this._clock();
    const endTime = rec.finishedAt ?? now;
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
      summaryModel: rec.summaryModel,
      stream: rec.stream ? { ...rec.stream } : null,
      messageKey: rec.messageKey,
      messageParams: rec.messageParams ? { ...rec.messageParams } : null,
      message: rec.message,
      error: rec.error ? { ...rec.error } : null,
      ...(extras.bili !== undefined ? { bili: extras.bili } : {}),
      ...(extras.backup !== undefined ? { backup: extras.backup } : {}),
    };
  }
}
