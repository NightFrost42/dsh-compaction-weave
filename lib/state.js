import {atomicReplaceSync} from './atomic-replace.js';
// Durable, per-session policy state. No model data or credentials are stored here.
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, readFileSync, openSync, writeFileSync, writeSync, ftruncateSync, fstatSync, fsyncSync, closeSync, renameSync, unlinkSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { threadId } from 'node:worker_threads';
import { isPollutedWindowRecord } from './window.js';
import { redactCredentials } from './redact.js';
import { setBoundedMap } from './collections.js';

const STALE_UNPARSEABLE_LOCK_MS = 5000;
const STALE_FOREIGN_WORKER_LOCK_MS = 30000;
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

    let focusInstruction = null;
    if (raw.focusInstruction !== null && raw.focusInstruction !== undefined && raw.focusInstruction !== '') {
      if (typeof raw.focusInstruction !== 'string') return null;
      const trimmedFocus = raw.focusInstruction.trim();
      if (trimmedFocus.length > 500) return null;
      focusInstruction = trimmedFocus || null;
    }
    const softenCoverageForFocus = raw.softenCoverageForFocus === true;

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
      focusInstruction,
      softenCoverageForFocus,
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

const ACTIVE_LOCK_TOKENS = (globalThis[Symbol.for('dsh-compaction-weave.activeLockTokens')] ??= new Set());

function sameFileIdentity(a, b) {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
}

function inspectStaleLockAction(lockPath) {
  let stat;
  let raw;
  try {
    stat = statSync(lockPath, { bigint: true });
    raw = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { action: 'retry', stat: null };
    return { action: 'locked', stat: null };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (isPlainObject(parsed) && parsed.released === true) {
    return { action: 'unlink', stat };
  }
  const validSchema =
    isPlainObject(parsed) &&
    Number.isSafeInteger(parsed.pid) &&
    parsed.pid > 0 &&
    (parsed.threadId === undefined || (Number.isSafeInteger(parsed.threadId) && parsed.threadId >= 0)) &&
    (parsed.at === undefined || (typeof parsed.at === 'string' && Number.isFinite(Date.parse(parsed.at)))) &&
    (parsed.token === undefined || (typeof parsed.token === 'string' && parsed.token.length > 0));

  if (!validSchema) {
    const ageMs = Date.now() - Number(stat.mtimeMs);
    return { action: Number.isFinite(ageMs) && ageMs >= STALE_UNPARSEABLE_LOCK_MS ? 'unlink' : 'locked', stat };
  }

  if (parsed.pid === process.pid) {
    if (
      parsed.threadId === threadId &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0
    ) {
      return { action: ACTIVE_LOCK_TOKENS.has(parsed.token) ? 'locked' : 'unlink', stat };
    }
    const mtimeAgeMs = Date.now() - Number(stat.mtimeMs);
    const parsedAtMs = typeof parsed.at === 'string' ? Date.parse(parsed.at) : Number.NaN;
    const parsedAgeMs = Number.isFinite(parsedAtMs) ? Date.now() - parsedAtMs : Number.NaN;
    const ageMs =
      Number.isFinite(mtimeAgeMs) && Number.isFinite(parsedAgeMs)
        ? Math.max(mtimeAgeMs, parsedAgeMs)
        : Number.isFinite(mtimeAgeMs)
          ? mtimeAgeMs
          : parsedAgeMs;
    return { action: Number.isFinite(ageMs) && ageMs >= STALE_FOREIGN_WORKER_LOCK_MS ? 'unlink' : 'locked', stat };
  }
  try {
    process.kill(parsed.pid, 0);
    // Process is still alive.
    return { action: 'locked', stat };
  } catch (error) {
    if (error?.code === 'ESRCH') return { action: 'unlink', stat };
    // EPERM (active process owned by another user) or any unknown error fails closed.
    return { action: 'locked', stat };
  }
}

function reclaimStaleFile(targetPath, expectedStat, makeLockedError) {
  try {
    const preStat = statSync(targetPath, { bigint: true });
    if (!sameFileIdentity(preStat, expectedStat)) {
      throw makeLockedError(new Error('lock file identity changed before stale reclaim'));
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error?.code === 'STATE_LOCKED') throw error;
    throw makeLockedError(error);
  }
  const staleTmp = `${targetPath}.dead.${process.pid}.${randomUUID()}`;
  try {
    renameSync(targetPath, staleTmp);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error?.code === 'EBUSY') throw makeLockedError(error);
    throw makeLockedError(error);
  }
  try {
    const movedStat = statSync(staleTmp, { bigint: true });
    if (!sameFileIdentity(movedStat, expectedStat)) {
      if (!existsSync(targetPath)) {
        try { renameSync(staleTmp, targetPath); } catch {}
      }
      throw makeLockedError(new Error('lock file identity changed during stale reclaim'));
    }
    unlinkSync(staleTmp);
  } catch (error) {
    if (error?.code === 'STATE_LOCKED') throw error;
    if (error?.code !== 'ENOENT') throw makeLockedError(error);
  }
}

function releaseOwnedLock(targetPath, fd, token, ownerStat) {
  try {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    let unlinked = false;
    try {
      const curStat = statSync(targetPath, { bigint: true });
      if (!sameFileIdentity(curStat, ownerStat)) return;
      unlinkSync(targetPath);
      unlinked = true;
    } catch (unlinkErr) {
      if (unlinkErr?.code === 'ENOENT') return;
    }
    if (!unlinked) {
      let markFd;
      try {
        markFd = openSync(targetPath, 'r+');
        if (sameFileIdentity(fstatSync(markFd, { bigint: true }), ownerStat)) {
          ftruncateSync(markFd, 0);
          writeSync(markFd, JSON.stringify({ released: true, pid: process.pid, token, at: new Date().toISOString() }), 0, 'utf8');
        }
      } catch {} finally {
        if (markFd !== undefined) {
          try { closeSync(markFd); } catch {}
        }
      }
    }
  } finally {
    if (token) ACTIVE_LOCK_TOKENS.delete(token);
  }
}

export function withExclusiveFileLock(
  lock,
  fn,
  { makeLockedError, staleUnparseableMs = STALE_UNPARSEABLE_LOCK_MS } = {},
) {
  let lockFd;
  let lockToken = null;
  let lockOwnerStat = null;
  const toLockedError =
    typeof makeLockedError === 'function'
      ? makeLockedError
      : (cause) => {
          const locked = new Error(`compaction state is locked; preserve and inspect the lock after all writers stop: ${lock}`);
          locked.code = 'STATE_LOCKED';
          locked.cause = cause;
          return locked;
        };
  const acquireOwnedLock = () => {
    const fd = openSync(lock, 'wx', 0o600);
    const token = randomUUID();
    ACTIVE_LOCK_TOKENS.add(token);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, threadId, token, at: new Date().toISOString() }));
      const ownerStat = fstatSync(fd, { bigint: true });
      lockFd = fd;
      lockToken = token;
      lockOwnerStat = ownerStat;
    } catch (err) {
      ACTIVE_LOCK_TOKENS.delete(token);
      try { closeSync(fd); } catch {}
      try { unlinkSync(lock); } catch {}
      throw err;
    }
  };
  try {
    // Concurrent writers fail closed; stale locks from dead PIDs (ESRCH) or
    // unparseable crash stubs (>= staleUnparseableMs old) are reclaimed once safely.
    try { acquireOwnedLock(); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const inspected = inspectStaleLockAction(lock);
      if (
        inspected.action === 'locked' &&
        staleUnparseableMs !== STALE_UNPARSEABLE_LOCK_MS &&
        inspected.stat
      ) {
        const ageMs = Date.now() - Number(inspected.stat.mtimeMs);
        if (Number.isFinite(ageMs) && ageMs >= staleUnparseableMs) {
          inspected.action = 'unlink';
        }
      }
      if (inspected.action === 'locked') throw toLockedError(error);
      if (inspected.action === 'unlink') {
        const reclaimGate = `${lock}.reclaim`;
        let reclaimFd;
        let reclaimToken = null;
        let reclaimOwnerStat = null;
        const acquireReclaimGate = () => {
          const fd = openSync(reclaimGate, 'wx', 0o600);
          const token = randomUUID();
          ACTIVE_LOCK_TOKENS.add(token);
          try {
            writeFileSync(fd, JSON.stringify({ pid: process.pid, threadId, token, at: new Date().toISOString() }));
            const ownerStat = fstatSync(fd, { bigint: true });
            reclaimFd = fd;
            reclaimToken = token;
            reclaimOwnerStat = ownerStat;
          } catch (err) {
            ACTIVE_LOCK_TOKENS.delete(token);
            try { closeSync(fd); } catch {}
            try { unlinkSync(reclaimGate); } catch {}
            throw err;
          }
        };
        try {
          acquireReclaimGate();
        } catch (gateError) {
          if (gateError?.code !== 'EEXIST') throw toLockedError(gateError);
          const gateCheck = inspectStaleLockAction(reclaimGate);
          if (gateCheck.action === 'locked') throw toLockedError(gateError);
          if (gateCheck.action === 'unlink') {
            reclaimStaleFile(reclaimGate, gateCheck.stat, toLockedError);
          }
          try {
            acquireReclaimGate();
          } catch (retryGateErr) {
            throw toLockedError(retryGateErr);
          }
        }
        try {
          if (!sameFileIdentity(statSync(reclaimGate, { bigint: true }), reclaimOwnerStat)) {
            throw toLockedError(error);
          }
          const rechecked = inspectStaleLockAction(lock);
          if (rechecked.action === 'locked') throw toLockedError(error);
          if (rechecked.action === 'unlink') {
            reclaimStaleFile(lock, rechecked.stat, toLockedError);
          }
          if (!sameFileIdentity(statSync(reclaimGate, { bigint: true }), reclaimOwnerStat)) {
            throw toLockedError(error);
          }
          try { acquireOwnedLock(); }
          catch (retryError) {
            if (retryError.code === 'EEXIST') throw toLockedError(retryError);
            throw retryError;
          }
        } finally {
          releaseOwnedLock(reclaimGate, reclaimFd, reclaimToken, reclaimOwnerStat);
        }
      } else {
        try { acquireOwnedLock(); }
        catch (retryError) {
          if (retryError.code === 'EEXIST') throw toLockedError(retryError);
          throw retryError;
        }
      }
      return fn();
    }
    return fn();
  } finally {
    if (lockFd !== undefined) {
      releaseOwnedLock(lock, lockFd, lockToken, lockOwnerStat);
    }
  }
}

export class SessionStateStore {
  constructor(root) {
    this.root = resolve(root);
    this._readCache = new Map();
    this._stepCache = new AsyncLocalStorage();
  }
  withStepReadCache(fn) {
    if (this._stepCache.getStore()) return fn();
    return this._stepCache.run(new Map(), fn);
  }
  file(id) {
    if (typeof id !== 'string' || !id) {
      throw Object.assign(new Error('durable compaction state requires a session id'), { code: 'STATE_INVALID' });
    }
    return join(this.root, createHash('sha256').update(id).digest('hex') + '.json');
  }
  read(id, { bypassCache = false } = {}) {
    const file = this.file(id);
    const stepMap = !bypassCache ? this._stepCache.getStore() : null;
    if (stepMap && stepMap.has(id)) {
      return structuredClone(stepMap.get(id));
    }
    let stamp = null;
    if (!bypassCache) {
      try {
        const st = statSync(file, { bigint: true });
        stamp = `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;
        const cached = this._readCache.get(id);
        if (cached && cached.stamp === stamp) {
          const cloned = structuredClone(cached.data);
          stepMap?.set(id, structuredClone(cloned));
          return cloned;
        }
      } catch (err) {
        this._readCache.delete(id);
        if (err?.code === 'ENOENT') {
          const empty = normalizeBreakerFields({ failures: 0, stopped: false });
          stepMap?.set(id, structuredClone(empty));
          return empty;
        }
        throw Object.assign(new Error(`compaction state unreadable: ${err.message}`), { code: 'STATE_UNAVAILABLE', cause: err });
      }
    }
    let record;
    try {
      record = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      this._readCache.delete(id);
      if (e.code === 'ENOENT') {
        const empty = normalizeBreakerFields({ failures: 0, stopped: false });
        stepMap?.set(id, structuredClone(empty));
        return empty;
      }
      throw Object.assign(new Error(`compaction state unreadable: ${e.message}`), { code: 'STATE_UNAVAILABLE', cause: e });
    }
    if (!record || typeof record !== 'object' || record.kind !== 'compaction-weave/state' || record.version !== 1 || record.sessionId !== id || !record.data || typeof record.data !== 'object' || record.checksum !== createHash('sha256').update(JSON.stringify(record.data)).digest('hex')) {
      this._readCache.delete(id);
      stepMap?.delete(id);
      throw Object.assign(new Error('compaction state identity or checksum mismatch'), { code: 'STATE_INVALID' });
    }
    if (!Number.isSafeInteger(record.data.failures) || record.data.failures < 0 || typeof record.data.stopped !== 'boolean') {
      this._readCache.delete(id);
      stepMap?.delete(id);
      throw Object.assign(new Error('compaction state has invalid failure counters'), { code: 'STATE_INVALID' });
    }
    const normalized = normalizeBreakerFields(record.data);
    if (!bypassCache && stamp !== null) {
      setBoundedMap(this._readCache, id, { stamp, data: structuredClone(normalized) }, 128);
      stepMap?.set(id, structuredClone(normalized));
    }
    return normalized;
  }
  _withLock(id, fn) {
    mkdirSync(this.root, { recursive: true });
    const file = this.file(id), lock = file + '.lock';
    return withExclusiveFileLock(lock, () => fn(file));
  }
  _writeRecordSync(file, id, data) {
    const temp = file + '.' + randomUUID() + '.tmp';
    let fd;
    try {
      const record = { kind: 'compaction-weave/state', version: 1, sessionId: id, data, checksum: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
      fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined;
      atomicReplaceSync(temp, file);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch {}
      this._readCache.delete(id);
      this._stepCache.getStore()?.delete(id);
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
