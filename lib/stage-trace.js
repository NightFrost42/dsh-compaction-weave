// Opt-in lightweight synchronous stage tracer for compaction performance diagnostics.
// Zero disk I/O and zero trace-object allocations when disabled.
// Privacy contract: NEVER emit conversation prose, file paths, prompts, or secrets.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, renameSync, statSync, truncateSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { containsSecretCredential, hasSecretPrefix } from './redact.js';

const MAX_TRACE_BYTES = 4 * 1024 * 1024;
const MAX_ENSURED_DIRS = 64;
const SAFE_CODE_RE = /^[A-Za-z0-9._:-]{1,48}$/;

const SAFE_COUNT_KEYS = new Set([
  'checkpoints',
  'decisions',
  'maxBy',
  'scanned',
  'restored',
  'surfaceLen',
  'rangeLen',
  'candidateCount',
  'probes',
  'probed',
  'possible',
  'possiblePlanning',
  'stride',
  'topScan',
  'nonShrinkable',
  'active',
  'retained',
  'governing',
  'preserved',
  'retired',
  'inherited',
  'total',
  'count',
  'entries',
  'rules',
  'cancellations',
  'hits',
  'misses',
  'skipped',
  'external',
  'depth',
  'seq',
  'startSeq',
  'endSeq',
  'minSeq',
  'maxSeq',
  'lastSeq',
  'sourceBytes',
  'minimumCheckpointBytes',
  'inputUnits',
  'requestUnits',
  'limit',
  'planningLimit',
  'bytes',
  'size',
  'chunks',
  'batches',
  'facts',
  'messages',
  'nodes',
  'events',
  'retries',
  'attempt',
  'attempts',
  'maxScanProbes',
  'summaryCount',
  'checkpointCount',
  'errorCount',
  'step',
]);

const SAFE_BOOL_KEYS = new Set([
  'hitCache',
  'cached',
  'fitting',
  'limited',
  'precheck',
  'earlyStop',
  'earlyStopped',
  'stale',
  'externalFold',
  'externalScript',
  'ok',
  'truncated',
  'replayed',
  'hasCache',
  'bypassed',
  'verbatim',
  'continuation',
  'manual',
  'idle',
]);

const SAFE_CODE_KEYS = new Set([
  'code',
  'errorCode',
  'reason',
  'mode',
  'kind',
  'variant',
  'language',
  'status',
  'outcome',
  'trigger',
  'op',
]);

const traceContextStorage = new AsyncLocalStorage();
const ensuredDirs = new Set();

function isActive() {
  if (process.env.WEAVE_TRACE_STAGES === '1') return true;
  const store = traceContextStorage.getStore();
  return store?.enabled === true;
}

function hashSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
}

function safeStageName(stage) {
  return typeof stage === 'string' && SAFE_CODE_RE.test(stage) ? stage : 'unknown';
}

function sanitizeEndMeta(endMetaFn, result) {
  if (typeof endMetaFn !== 'function') return null;
  try {
    return endMetaFn(result);
  } catch {
    return null;
  }
}

function resolveTracePath(store) {
  if (typeof store?.filePath === 'string' && store.filePath.length > 0) return store.filePath;
  const envPath = process.env.WEAVE_TRACE_STAGES_PATH;
  if (typeof envPath === 'string' && envPath.length > 0) return envPath;
  if (typeof store?.storageRoot === 'string' && store.storageRoot.length > 0) {
    return join(store.storageRoot, 'stage-trace.jsonl');
  }
  return null;
}

function writeTraceRecord(record) {
  const store = traceContextStorage.getStore();
  if (typeof store?.onEvent === 'function') {
    try {
      store.onEvent(record);
    } catch {
      // Never break compaction on trace listener failure.
    }
  }
  const targetPath = resolveTracePath(store);
  if (!targetPath) return;
  try {
    const dir = dirname(targetPath);
    if (!ensuredDirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      if (ensuredDirs.size >= MAX_ENSURED_DIRS) ensuredDirs.clear();
      ensuredDirs.add(dir);
    }
    try {
      const st = statSync(targetPath);
      if (st.size >= MAX_TRACE_BYTES) {
        try {
          renameSync(targetPath, `${targetPath}.1`);
        } catch {
          truncateSync(targetPath, 0);
        }
      }
    } catch {
      // Trace file does not exist yet; appendFileSync creates it.
    }
    appendFileSync(targetPath, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Swallow I/O errors so tracing never breaks compaction.
  }
}

function emitTraceEvent(stage, phase, meta, extra) {
  const store = traceContextStorage.getStore();
  const cleanMeta = sanitizeStageMeta(meta);
  const cleanExtra = extra ? sanitizeStageMeta(extra) : null;
  const record = {
    ...cleanMeta,
    ...(cleanExtra ?? {}),
    ts: new Date().toISOString(),
    stage: safeStageName(stage),
    phase,
    ...(store?.sessionHash ? { sessionHash: store.sessionHash } : {}),
  };
  if (extra && typeof extra.ok === 'boolean') record.ok = extra.ok;
  if (extra && typeof extra.elapsedMs === 'number' && Number.isFinite(extra.elapsedMs)) {
    record.elapsedMs = extra.elapsedMs;
  }
  writeTraceRecord(record);
}

/**
 * Return true when stage tracing is enabled via env (`WEAVE_TRACE_STAGES=1`),
 * active AsyncLocalStorage context, or explicit config/options flags (`debug: true` / `enabled: true`).
 */
export function isStageTraceEnabled(configOrOptions) {
  if (isActive()) return true;
  if (configOrOptions && typeof configOrOptions === 'object') {
    if (configOrOptions.enabled === true || configOrOptions.debug === true) return true;
    if (configOrOptions.config?.debug === true || configOrOptions.policy?.debug === true) return true;
  }
  return false;
}

/**
 * Run `fn` inside an AsyncLocalStorage-isolated stage trace context.
 */
export function withStageTraceContext(context, fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('withStageTraceContext requires a callback function');
  }
  const parent = traceContextStorage.getStore();
  const opts = context && typeof context === 'object' ? context : {};
  const next = {
    enabled: opts.enabled !== undefined ? Boolean(opts.enabled) : Boolean(parent?.enabled),
    filePath: opts.filePath !== undefined ? opts.filePath : (parent?.filePath ?? null),
    storageRoot: opts.storageRoot !== undefined ? opts.storageRoot : (parent?.storageRoot ?? null),
    sessionHash:
      opts.sessionId !== undefined
        ? hashSessionId(opts.sessionId)
        : (parent?.sessionHash ?? null),
    onEvent: typeof opts.onEvent === 'function' ? opts.onEvent : (opts.onEvent === null ? null : (parent?.onEvent ?? null)),
  };
  return traceContextStorage.run(next, fn);
}

/**
 * Filter metadata strictly to whitelisted numeric counts, booleans, and short safe codes.
 * Strips all prose, file paths, prompts, secrets, and envelope fields.
 */
export function sanitizeStageMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const out = {};
  for (const [k, value] of Object.entries(meta)) {
    if (SAFE_COUNT_KEYS.has(k)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[k] = value;
      continue;
    }
    if (SAFE_BOOL_KEYS.has(k)) {
      if (typeof value === 'boolean') out[k] = value;
      continue;
    }
    if (SAFE_CODE_KEYS.has(k)) {
      if (
        typeof value === 'string' &&
        SAFE_CODE_RE.test(value) &&
        !hasSecretPrefix(value) &&
        !containsSecretCredential(value)
      ) {
        out[k] = value;
      }
    }
  }
  return out;
}

/**
 * Trace a synchronous stage boundary. Executes `fn()` directly with zero allocations when disabled.
 */
export function traceStageSync(stage, meta, fn, endMetaFn) {
  if (!isActive()) return fn();
  const resolvedMeta = typeof meta === 'function' ? meta() : meta;
  emitTraceEvent(stage, 'start', resolvedMeta, null);
  const started = performance.now();
  try {
    const result = fn();
    const elapsedMs = Math.max(0, Math.round((performance.now() - started) * 100) / 100);
    const endMeta = sanitizeEndMeta(endMetaFn, result);
    emitTraceEvent(stage, 'end', endMeta, { ok: true, elapsedMs });
    return result;
  } catch (error) {
    const elapsedMs = Math.max(0, Math.round((performance.now() - started) * 100) / 100);
    const errMeta = typeof error?.code === 'string' ? { code: error.code } : null;
    emitTraceEvent(stage, 'end', errMeta, { ok: false, elapsedMs });
    throw error;
  }
}

/**
 * Trace an asynchronous stage boundary. Executes `fn()` with zero trace overhead when disabled.
 */
export async function traceStageAsync(stage, meta, fn, endMetaFn) {
  if (!isActive()) return await fn();
  const resolvedMeta = typeof meta === 'function' ? meta() : meta;
  emitTraceEvent(stage, 'start', resolvedMeta, null);
  const started = performance.now();
  try {
    const result = await fn();
    const elapsedMs = Math.max(0, Math.round((performance.now() - started) * 100) / 100);
    const endMeta = sanitizeEndMeta(endMetaFn, result);
    emitTraceEvent(stage, 'end', endMeta, { ok: true, elapsedMs });
    return result;
  } catch (error) {
    const elapsedMs = Math.max(0, Math.round((performance.now() - started) * 100) / 100);
    const errMeta = typeof error?.code === 'string' ? { code: error.code } : null;
    emitTraceEvent(stage, 'end', errMeta, { ok: false, elapsedMs });
    throw error;
  }
}

/**
 * Emit a single-point trace event when stage tracing is active. No-op when disabled.
 */
export function traceStagePoint(stage, meta) {
  if (!isActive()) return;
  const resolvedMeta = typeof meta === 'function' ? meta() : meta;
  emitTraceEvent(stage, 'point', resolvedMeta, null);
}
