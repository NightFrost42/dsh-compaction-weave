import {atomicReplaceSync} from './atomic-replace.js';
// Durable, per-session policy state. No model data or credentials are stored here.
import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isPollutedWindowRecord } from './window.js';
import { redactCredentials } from './redact.js';
import { setBoundedMap } from './collections.js';

const STALE_UNPARSEABLE_LOCK_MS = 5000;
const RESUMABLE_VERSION = 1;
const RESUMABLE_STATUSES = new Set(['running', 'paused', 'interrupted', 'paused_budget', 'paused_failure']);
const SAFE_CODE_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const SAFE_DIAGNOSTIC_ID_RE = /^[A-Za-z0-9_.-]{1,120}$/;
const SAFE_TRIGGER_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function normalizeFailureCode(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return SAFE_CODE_RE.test(trimmed) ? trimmed : null;
}

function normalizeDiagnosticId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return SAFE_DIAGNOSTIC_ID_RE.test(trimmed) ? trimmed : null;
}

function normalizeDiagnosticPath(value) {
  if (typeof value !== 'string') return null;
  if (/[\r\n]/.test(value)) return null;
  const cleaned = redactCredentials(value, {
    pemReplacement: '[redacted-private-key]',
    tokenReplacement: '[redacted]',
  }).trim();
  if (!cleaned || cleaned.length > 512) return null;
  return cleaned;
}

function normalizeBreakerFields(data) {
  return {
    ...data,
    breakerBypassed: data?.breakerBypassed === true,
    lastFailureCode: normalizeFailureCode(data?.lastFailureCode),
    lastDiagnosticId: normalizeDiagnosticId(data?.lastDiagnosticId),
    lastDiagnosticPath: normalizeDiagnosticPath(data?.lastDiagnosticPath),
  };
}

export function clearBreakerState(state = {}) {
  const base = isPlainObject(state) ? { ...state } : {};
  delete base.lastFailureCode;
  delete base.lastFailureAt;
  delete base.lastDiagnosticId;
  delete base.lastDiagnosticPath;
  delete base.bypassed;
  delete base.bypassedAt;
  return {
    ...base,
    failures: 0,
    stopped: false,
    breakerBypassed: false,
  };
}

export function publicBreakerSummary(state, pressureBreakerAction = 'confirm') {
  return {
    stopped: Boolean(state?.stopped),
    failures: Number.isSafeInteger(state?.failures) && state.failures >= 0 ? state.failures : 0,
    breakerBypassed: state?.breakerBypassed === true,
    pressureBreakerAction:
      typeof pressureBreakerAction === 'string' && pressureBreakerAction ? pressureBreakerAction : 'confirm',
    lastFailureCode: normalizeFailureCode(state?.lastFailureCode),
    lastDiagnosticId: normalizeDiagnosticId(state?.lastDiagnosticId),
    lastDiagnosticPath: normalizeDiagnosticPath(state?.lastDiagnosticPath),
  };
}

function sanitizeErrorMessage(value, maxLen = 320) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const cleaned = redactCredentials(value, {
    pemReplacement: '[redacted-private-key]',
    tokenReplacement: '[redacted]',
  })
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateNonNegIntArray(raw, { unique = false, maxLen = 200000 } = {}) {
  if (!Array.isArray(raw) || raw.length > maxLen) return null;
  const out = [];
  const seen = unique ? new Set() : null;
  for (const item of raw) {
    if (!Number.isSafeInteger(item) || item < 0) return null;
    if (seen) {
      if (seen.has(item)) return null;
      seen.add(item);
    }
    out.push(item);
  }
  return out;
}

function cloneSafeMeta(raw) {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) return undefined;
  try {
    const json = JSON.stringify(raw);
    if (!json || Buffer.byteLength(json, 'utf8') > 16384) return undefined;
    const parsed = JSON.parse(json);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validate and sanitize a durable `resumableCompaction` record (version 1).
 * Never throws: returns `null` for corrupt data or unknown versions so a bad
 * breakpoint can never break `SessionStateStore.read()`.
 */
export function validateResumableCompaction(raw) {
  try {
    if (!isPlainObject(raw) || raw.version !== RESUMABLE_VERSION) return null;
    if (typeof raw.jobId !== 'string') return null;
    const jobId = raw.jobId.trim();
    if (!jobId || jobId.length > 160) return null;
    if (typeof raw.trigger !== 'string') return null;
    const trigger = raw.trigger.trim();
    if (!SAFE_TRIGGER_RE.test(trigger)) return null;
    if (typeof raw.status !== 'string' || !RESUMABLE_STATUSES.has(raw.status)) return null;

    let interruptReason = null;
    if (raw.interruptReason !== null && raw.interruptReason !== undefined && raw.interruptReason !== '') {
      if (typeof raw.interruptReason !== 'string' || raw.interruptReason.trim().length > 80) return null;
      interruptReason = raw.interruptReason.trim();
    }

    if (typeof raw.createdAt !== 'string' || !raw.createdAt.trim() || raw.createdAt.length > 64) return null;
    if (typeof raw.updatedAt !== 'string' || !raw.updatedAt.trim() || raw.updatedAt.length > 64) return null;

    const remainingSeqs = validateNonNegIntArray(raw.remainingSeqs, { unique: true, maxLen: 200000 });
    if (!remainingSeqs) return null;

    let remainingSourceSha256 = null;
    if (raw.remainingSourceSha256 !== null && raw.remainingSourceSha256 !== undefined) {
      if (typeof raw.remainingSourceSha256 !== 'string' || !SHA256_RE.test(raw.remainingSourceSha256)) return null;
      remainingSourceSha256 = raw.remainingSourceSha256;
    }

    const intFields = ['initialTotalNodes', 'completedNodes', 'completedChunks', 'waveCount', 'consecutiveFailures'];
    const ints = {};
    for (const key of intFields) {
      const v = raw[key];
      if (!Number.isSafeInteger(v) || v < 0) return null;
      ints[key] = v;
    }

    const initialTotalTokens = raw.initialTotalTokens;
    const completedTokens = raw.completedTokens;
    if (
      typeof initialTotalTokens !== 'number' || !Number.isFinite(initialTotalTokens) || initialTotalTokens < 0 ||
      typeof completedTokens !== 'number' || !Number.isFinite(completedTokens) || completedTokens < 0
    ) {
      return null;
    }

    const batchCheckpointSeqs =
      raw.batchCheckpointSeqs === undefined
        ? []
        : validateNonNegIntArray(raw.batchCheckpointSeqs, { unique: false, maxLen: 4096 });
    if (!batchCheckpointSeqs) return null;

    if (typeof raw.allowForeignFallback !== 'boolean') return null;

    const checkpointMeta = cloneSafeMeta(raw.checkpointMeta);
    if (checkpointMeta === undefined) return null;

    let originalBackupId = null;
    if (raw.originalBackupId !== null && raw.originalBackupId !== undefined && raw.originalBackupId !== '') {
      if (typeof raw.originalBackupId !== 'string' || raw.originalBackupId.trim().length > 160) return null;
      originalBackupId = raw.originalBackupId.trim();
    }

    let lastErrorCode = null;
    if (raw.lastErrorCode !== null && raw.lastErrorCode !== undefined && raw.lastErrorCode !== '') {
      if (typeof raw.lastErrorCode !== 'string' || !SAFE_CODE_RE.test(raw.lastErrorCode.trim())) return null;
      lastErrorCode = raw.lastErrorCode.trim();
    }

    const lastErrorMessage = sanitizeErrorMessage(raw.lastErrorMessage, 320);

    return {
      version: RESUMABLE_VERSION,
      jobId,
      trigger,
      status: raw.status,
      interruptReason,
      createdAt: raw.createdAt.trim(),
      updatedAt: raw.updatedAt.trim(),
      remainingSeqs,
      remainingSourceSha256,
      initialTotalNodes: ints.initialTotalNodes,
      completedNodes: ints.completedNodes,
      initialTotalTokens,
      completedTokens,
      completedChunks: ints.completedChunks,
      waveCount: ints.waveCount,
      batchCheckpointSeqs,
      allowForeignFallback: raw.allowForeignFallback,
      checkpointMeta,
      originalBackupId,
      consecutiveFailures: ints.consecutiveFailures,
      lastErrorCode,
      lastErrorMessage,
    };
  } catch {
    return null;
  }
}

export function readResumableCompaction(store, sessionId) {
  if (!store || typeof store.read !== 'function' || typeof sessionId !== 'string' || !sessionId) return null;
  const state = store.read(sessionId);
  return validateResumableCompaction(state?.resumableCompaction);
}

export function writeResumableCompaction(store, sessionId, job) {
  if (!store || typeof store.update !== 'function' || typeof sessionId !== 'string' || !sessionId) {
    throw Object.assign(new Error('resumable compaction requires a valid state store and sessionId'), { code: 'RESUMABLE_COMPACTION_INVALID' });
  }
  const now = new Date().toISOString();
  const candidate = isPlainObject(job)
    ? {
        version: job.version ?? RESUMABLE_VERSION,
        jobId: job.jobId,
        trigger: job.trigger,
        status: job.status,
        interruptReason: job.interruptReason ?? null,
        createdAt: job.createdAt ?? now,
        updatedAt: job.updatedAt ?? now,
        remainingSeqs: job.remainingSeqs,
        remainingSourceSha256: job.remainingSourceSha256 ?? null,
        initialTotalNodes: job.initialTotalNodes ?? (Array.isArray(job.remainingSeqs) ? job.remainingSeqs.length : 0),
        completedNodes: job.completedNodes ?? 0,
        initialTotalTokens: job.initialTotalTokens ?? 0,
        completedTokens: job.completedTokens ?? 0,
        completedChunks: job.completedChunks ?? 0,
        waveCount: job.waveCount ?? 0,
        batchCheckpointSeqs: job.batchCheckpointSeqs ?? [],
        allowForeignFallback: job.allowForeignFallback ?? false,
        checkpointMeta: job.checkpointMeta ?? null,
        originalBackupId: job.originalBackupId ?? null,
        consecutiveFailures: job.consecutiveFailures ?? 0,
        lastErrorCode: job.lastErrorCode ?? null,
        lastErrorMessage: job.lastErrorMessage ?? null,
      }
    : null;
  const validated = validateResumableCompaction(candidate);
  if (!validated) {
    throw Object.assign(new Error('invalid resumableCompaction record; refusing to persist'), { code: 'RESUMABLE_COMPACTION_INVALID' });
  }
  store.update(sessionId, (state) => ({ ...state, resumableCompaction: validated }));
  return validated;
}

export function clearResumableCompaction(store, sessionId) {
  if (!store || typeof store.read !== 'function' || typeof store.update !== 'function' || typeof sessionId !== 'string' || !sessionId) {
    return false;
  }
  const current = store.read(sessionId);
  if (!Object.hasOwn(current, 'resumableCompaction') || current.resumableCompaction === undefined) {
    return false;
  }
  let removed = false;
  store.update(sessionId, (state) => {
    if (!Object.hasOwn(state, 'resumableCompaction') || state.resumableCompaction === undefined) {
      return state;
    }
    removed = true;
    const next = { ...state };
    delete next.resumableCompaction;
    return next;
  });
  return removed;
}

export function publicResumableSummary(job) {
  const valid = validateResumableCompaction(job);
  if (!valid || valid.status === 'running') return null;
  const remainingNodes = valid.remainingSeqs.length;
  const remainingTokens = Math.max(0, valid.initialTotalTokens - valid.completedTokens);
  const cap = remainingNodes > 0 ? 99 : 100;
  let overallPercent = 0;
  if (valid.initialTotalTokens > 0) {
    overallPercent = Math.max(0, Math.min(cap, Math.round((valid.completedTokens / valid.initialTotalTokens) * 100)));
  } else if (valid.initialTotalNodes > 0) {
    overallPercent = Math.max(0, Math.min(cap, Math.round((valid.completedNodes / valid.initialTotalNodes) * 100)));
  }
  const canAutoResume =
    valid.status === 'interrupted' &&
    valid.consecutiveFailures < 3;
  return {
    jobId: valid.jobId,
    trigger: valid.trigger,
    status: valid.status,
    interruptReason: valid.interruptReason,
    overallPercent,
    completedChunks: valid.completedChunks,
    remainingNodes,
    remainingTokens,
    initialTotalTokens: valid.initialTotalTokens,
    completedTokens: valid.completedTokens,
    updatedAt: valid.updatedAt,
    canAutoResume,
    lastErrorCode: valid.lastErrorCode,
    lastErrorMessage: sanitizeErrorMessage(valid.lastErrorMessage, 240),
  };
}

function inspectStaleLockAction(lockPath) {
  let stat;
  let raw;
  try {
    stat = statSync(lockPath);
    raw = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return 'retry';
    return 'locked';
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const validSchema =
    isPlainObject(parsed) &&
    Number.isSafeInteger(parsed.pid) &&
    parsed.pid > 0 &&
    (parsed.at === undefined || (typeof parsed.at === 'string' && Number.isFinite(Date.parse(parsed.at))));

  if (!validSchema) {
    const ageMs = Date.now() - stat.mtimeMs;
    return Number.isFinite(ageMs) && ageMs >= STALE_UNPARSEABLE_LOCK_MS ? 'unlink' : 'locked';
  }

  if (parsed.pid === process.pid) return 'locked';
  try {
    process.kill(parsed.pid, 0);
    // Process is still alive.
    return 'locked';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'unlink';
    // EPERM (active process owned by another user) or any unknown error fails closed.
    return 'locked';
  }
}

export class SessionStateStore {
  constructor(root) {
    this.root = resolve(root);
    this._readCache = new Map();
  }
  file(id) {
    if (typeof id !== 'string' || !id) {
      throw Object.assign(new Error('durable compaction state requires a session id'), { code: 'STATE_INVALID' });
    }
    return join(this.root, createHash('sha256').update(id).digest('hex') + '.json');
  }
  read(id, { bypassCache = false } = {}) {
    const file = this.file(id);
    let stamp = null;
    if (!bypassCache) {
      try {
        const st = statSync(file, { bigint: true });
        stamp = `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;
        const cached = this._readCache.get(id);
        if (cached && cached.stamp === stamp) {
          return structuredClone(cached.data);
        }
      } catch (err) {
        this._readCache.delete(id);
        if (err?.code === 'ENOENT') return normalizeBreakerFields({ failures: 0, stopped: false });
        throw Object.assign(new Error(`compaction state unreadable: ${err.message}`), { code: 'STATE_UNAVAILABLE', cause: err });
      }
    }
    let record;
    try {
      record = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      this._readCache.delete(id);
      if (e.code === 'ENOENT') return normalizeBreakerFields({ failures: 0, stopped: false });
      throw Object.assign(new Error(`compaction state unreadable: ${e.message}`), { code: 'STATE_UNAVAILABLE', cause: e });
    }
    if (!record || typeof record !== 'object' || record.kind !== 'compaction-weave/state' || record.version !== 1 || record.sessionId !== id || !record.data || typeof record.data !== 'object' || record.checksum !== createHash('sha256').update(JSON.stringify(record.data)).digest('hex')) {
      this._readCache.delete(id);
      throw Object.assign(new Error('compaction state identity or checksum mismatch'), { code: 'STATE_INVALID' });
    }
    if (!Number.isSafeInteger(record.data.failures) || record.data.failures < 0 || typeof record.data.stopped !== 'boolean') {
      this._readCache.delete(id);
      throw Object.assign(new Error('compaction state has invalid failure counters'), { code: 'STATE_INVALID' });
    }
    const normalized = normalizeBreakerFields(record.data);
    if (!bypassCache && stamp !== null) {
      setBoundedMap(this._readCache, id, { stamp, data: structuredClone(normalized) }, 128);
    }
    return normalized;
  }
  _withLock(id, fn) {
    mkdirSync(this.root, { recursive: true });
    const file = this.file(id), lock = file + '.lock';
    let lockFd;
    const makeLockedError = (cause) => {
      const locked = new Error(`compaction state is locked; preserve and inspect the lock after all writers stop: ${lock}`);
      locked.code = 'STATE_LOCKED';
      locked.cause = cause;
      return locked;
    };
    try {
      // Concurrent writers fail closed; stale locks from dead PIDs (ESRCH) or
      // unparseable crash stubs (>= 5s old) are reclaimed once safely.
      try { lockFd = openSync(lock, 'wx'); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const action = inspectStaleLockAction(lock);
        if (action === 'locked') throw makeLockedError(error);
        if (action === 'unlink') {
          const reclaimGate = `${lock}.reclaim`;
          let reclaimFd;
          try {
            reclaimFd = openSync(reclaimGate, 'wx', 0o600);
          } catch (gateError) {
            if (gateError?.code !== 'EEXIST') throw makeLockedError(gateError);
            const gateAction = inspectStaleLockAction(reclaimGate);
            if (gateAction === 'locked') throw makeLockedError(gateError);
            if (gateAction === 'unlink') {
              try {
                unlinkSync(reclaimGate);
              } catch (gateUnlinkErr) {
                if (gateUnlinkErr?.code !== 'ENOENT' && gateUnlinkErr?.code !== 'EBUSY') {
                  throw makeLockedError(gateUnlinkErr);
                }
              }
            }
            try {
              reclaimFd = openSync(reclaimGate, 'wx', 0o600);
            } catch (retryGateErr) {
              throw makeLockedError(retryGateErr);
            }
          }
          try {
            writeFileSync(reclaimFd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
            const rechecked = inspectStaleLockAction(lock);
            if (rechecked === 'locked') throw makeLockedError(error);
            if (rechecked === 'unlink') {
              try {
                unlinkSync(lock);
              } catch (reclaimError) {
                if (reclaimError?.code !== 'ENOENT') throw makeLockedError(reclaimError);
              }
            }
            try {
              lockFd = openSync(lock, 'wx');
            } catch (retryError) {
              if (retryError.code === 'EEXIST') throw makeLockedError(retryError);
              throw retryError;
            }
            writeFileSync(lockFd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
          } finally {
            try { closeSync(reclaimFd); } catch {}
            try { unlinkSync(reclaimGate); } catch {}
          }
        } else {
          try { lockFd = openSync(lock, 'wx'); }
          catch (retryError) {
            if (retryError.code === 'EEXIST') throw makeLockedError(retryError);
            throw retryError;
          }
          writeFileSync(lockFd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        }
        return fn(file);
      }
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return fn(file);
    } finally {
      if (lockFd !== undefined) { closeSync(lockFd); try { unlinkSync(lock); } catch {} }
    }
  }
  _writeRecordSync(file, id, data) {
    const temp = file + '.' + randomUUID() + '.tmp';
    let fd;
    try {
      const record = { kind: 'compaction-weave/state', version: 1, sessionId: id, data, checksum: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
      fd = openSync(temp, 'wx'); writeFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined;
      atomicReplaceSync(temp, file);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch {}
      this._readCache.delete(id);
    }
  }
  update(id, change) {
    return this._withLock(id, (file) => {
      const existed = existsSync(file);
      const prev = this.read(id, { bypassCache: true });
      const prevJson = existed ? JSON.stringify(prev) : null;
      const data = change(prev);
      if (existed && JSON.stringify(data) === prevJson) {
        return data;
      }
      this._writeRecordSync(file, id, data);
      return data;
    });
  }
  resetBreaker(id, { rebuildOnInvalid = true, clearWindow = false } = {}) {
    return this._withLock(id, (file) => {
      try {
        const previous = this.read(id, { bypassCache: true });
        const hadBreakerState = Boolean(
          previous.stopped ||
          previous.failures > 0 ||
          previous.breakerBypassed ||
          previous.lastFailureCode ||
          previous.lastFailureAt ||
          previous.lastDiagnosticId ||
          previous.lastDiagnosticPath ||
          previous.bypassed ||
          previous.bypassedAt
        );
        const windowCleared = Boolean(
          previous.window && (clearWindow === true || isPollutedWindowRecord(previous.window)),
        );
        if (!hadBreakerState && !windowCleared) {
          return {
            reset: false,
            rebuilt: false,
            windowCleared: false,
            previousFailures: 0,
            wasStopped: false,
            state: previous,
          };
        }
        const next = clearBreakerState(previous);
        if (windowCleared) {
          delete next.window;
        }
        this._writeRecordSync(file, id, next);
        return {
          reset: true,
          rebuilt: false,
          windowCleared,
          previousFailures: previous.failures,
          wasStopped: previous.stopped,
          state: normalizeBreakerFields(next),
        };
      } catch (error) {
        if (
          rebuildOnInvalid === true &&
          (error?.code === 'STATE_INVALID' || (error?.code === 'STATE_UNAVAILABLE' && error?.cause instanceof SyntaxError))
        ) {
          const next = clearBreakerState({ failures: 0, stopped: false });
          this._writeRecordSync(file, id, next);
          return {
            reset: true,
            rebuilt: true,
            windowCleared: true,
            previousErrorCode: error.code,
            previousFailures: null,
            wasStopped: null,
            state: normalizeBreakerFields(next),
          };
        }
        throw error;
      } finally {
        this._readCache.delete(id);
      }
    });
  }
}
