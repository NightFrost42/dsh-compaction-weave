// DSH plugin event hooks for compaction lifecycle (`weave/pre-compact` & `weave/post-compact`).
// Dispatches on an injected safe `hookBus` (or safely resolved root/fallback bus) so plugins
// outside Weave's isolate group receive hooks cleanly under strict Cordis ReflectService proxies,
// with strict per-listener error, timeout, and abort isolation.

import { sanitizeFocusInstruction } from './prompt.js';

export const PRE_COMPACT_EVENT = 'weave/pre-compact';
export const POST_COMPACT_EVENT = 'weave/post-compact';

const DEFAULT_HOOK_TIMEOUT_MS = 5000;
const MIN_HOOK_TIMEOUT_MS = 50;
const MAX_HOOK_TIMEOUT_MS = 60000;
const MAX_ADDITIONAL_CONTEXT_CHARS = 1000;
const MAX_REASON_CHARS = 500;
const MAX_NOTICE_CHARS = 500;
const MAX_NOTICES = 20;

const isPlainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const CORDIS_ROOT_SYMBOL = Symbol.for('cordis.root');

function safeReadProp(obj, prop, onError) {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined;
  try {
    return obj[prop];
  } catch (error) {
    if (typeof onError === 'function') {
      try { onError(error); } catch {}
    }
    return undefined;
  }
}

function resolveHookBus(ctx, options, onError) {
  const explicit = safeReadProp(options, 'bus');
  if (explicit && typeof explicit === 'object') return explicit;
  const directRoot = safeReadProp(ctx, 'root', onError);
  if (directRoot && typeof directRoot === 'object') return directRoot;
  const symbolRoot = safeReadProp(ctx, CORDIS_ROOT_SYMBOL, onError);
  if (symbolRoot && typeof symbolRoot === 'object') return symbolRoot;
  return ctx;
}

function clampTimeoutMs(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_HOOK_TIMEOUT_MS;
  return Math.max(MIN_HOOK_TIMEOUT_MS, Math.min(MAX_HOOK_TIMEOUT_MS, Math.trunc(raw)));
}

function sanitizeControlText(raw, { preserveNewlines = false, maxChars = MAX_REASON_CHARS } = {}) {
  if (typeof raw !== 'string') return '';
  let text = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  if (preserveNewlines) {
    text = text.replace(/\r\n?/g, '\n').trim();
  } else {
    text = text.replace(/\s+/g, ' ').trim();
  }
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text;
}

function emitLog(log, ctx, level, message) {
  try {
    if (typeof log === 'function') {
      log(level, message);
      return;
    }
    const directLogFn = safeReadProp(log, level);
    if (typeof directLogFn === 'function') {
      directLogFn.call(log, message);
      return;
    }
    const ctxLogger = safeReadProp(ctx, 'logger');
    const ctxLoggerFn = safeReadProp(ctxLogger, level);
    if (typeof ctxLoggerFn === 'function') {
      ctxLoggerFn.call(ctxLogger, `[compaction-weave] ${message}`);
      return;
    }
    const rootCtx = safeReadProp(ctx, 'root') ?? safeReadProp(ctx, CORDIS_ROOT_SYMBOL);
    const rootLogger = safeReadProp(rootCtx, 'logger');
    const rootLoggerFn = safeReadProp(rootLogger, level);
    if (typeof rootLoggerFn === 'function') {
      rootLoggerFn.call(rootLogger, `[compaction-weave] ${message}`);
    }
  } catch {
    /* logging must never interrupt compaction */
  }
}

function abortErrorFor(signal) {
  if (signal?.reason !== undefined) return signal.reason;
  return Object.assign(new Error('compaction hook aborted'), { code: 'ABORTED', name: 'AbortError' });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === 'function') {
    signal.throwIfAborted();
  }
  throw abortErrorFor(signal);
}

async function runBoundedTask(fn, { timeoutMs, signal }) {
  let timer;
  let onAbort;
  let settled = false;
  const taskPromise = Promise.resolve().then(() => fn());
  taskPromise.catch(() => {});

  const guardPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (!settled) {
        reject(Object.assign(new Error(`hook listener timed out after ${timeoutMs}ms`), { code: 'HOOK_TIMEOUT' }));
      }
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) {
        reject(abortErrorFor(signal));
        return;
      }
      onAbort = () => {
        if (!settled) reject(abortErrorFor(signal));
      };
      signal.addEventListener?.('abort', onAbort, { once: true });
    }
  });
  guardPromise.catch(() => {});

  try {
    return await Promise.race([taskPromise, guardPromise]);
  } finally {
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener?.('abort', onAbort);
  }
}

function resolveBusListeners(bus, eventName, payload, { postCompact = false, onProbeError } = {}) {
  if (!bus || typeof bus !== 'object') return { runners: [], matched: false };
  const events = safeReadProp(bus, 'events', onProbeError);
  const dispatch = safeReadProp(events, 'dispatch', onProbeError);
  if (typeof dispatch === 'function') {
    const dispatchArgs = [eventName, payload];
    const dispatched = dispatch.call(events, 'serial', dispatchArgs);
    const list = Array.isArray(dispatched)
      ? dispatched
      : (dispatched && typeof dispatched[Symbol.iterator] === 'function' ? [...dispatched] : []);
    // Real @deepseek-ai/cordis `events.dispatch` shifts `eventName` out of `dispatchArgs`
    // (leaving `[payload]`) and returns callbacks bound only to `thisArg`, expecting `fn(...dispatchArgs)`.
    // Mock buses that do not consume `dispatchArgs` pre-bind `payload` into each callback (`fn()`).
    const consumedEventName = dispatchArgs.length === 1 && dispatchArgs[0] === payload;
    return {
      runners: list
        .filter((fn) => typeof fn === 'function')
        .map((fn) => (consumedEventName ? () => fn(...dispatchArgs) : () => fn())),
      matched: true,
    };
  }
  if (postCompact) {
    const parallel = safeReadProp(bus, 'parallel', onProbeError);
    if (typeof parallel === 'function') return { runners: [() => parallel.call(bus, eventName, payload)], matched: true };
    const serial = safeReadProp(bus, 'serial', onProbeError);
    if (typeof serial === 'function') return { runners: [() => serial.call(bus, eventName, payload)], matched: true };
    const listenersFn = safeReadProp(bus, 'listeners', onProbeError);
    if (typeof listenersFn === 'function') {
      const list = listenersFn.call(bus, eventName);
      if (Array.isArray(list)) {
        return {
          runners: list.filter((fn) => typeof fn === 'function').map((fn) => () => fn(payload)),
          matched: true,
        };
      }
    }
    const emitFn = safeReadProp(bus, 'emit', onProbeError);
    if (typeof emitFn === 'function') return { runners: [() => emitFn.call(bus, eventName, payload)], matched: true };
    return { runners: [], matched: false };
  }
  const serial = safeReadProp(bus, 'serial', onProbeError);
  if (typeof serial === 'function') return { runners: [() => serial.call(bus, eventName, payload)], matched: true };
  const parallel = safeReadProp(bus, 'parallel', onProbeError);
  if (typeof parallel === 'function') return { runners: [() => parallel.call(bus, eventName, payload)], matched: true };
  const listenersFn = safeReadProp(bus, 'listeners', onProbeError);
  if (typeof listenersFn === 'function') {
    const list = listenersFn.call(bus, eventName);
    if (Array.isArray(list)) {
      return {
        runners: list.filter((fn) => typeof fn === 'function').map((fn) => () => fn(payload)),
        matched: true,
      };
    }
  }
  const emitFn = safeReadProp(bus, 'emit', onProbeError);
  if (typeof emitFn === 'function') return { runners: [() => emitFn.call(bus, eventName, payload)], matched: true };
  return { runners: [], matched: false };
}

function appendAdditionalContext(parts, raw) {
  const clean = sanitizeControlText(raw, { preserveNewlines: true, maxChars: MAX_ADDITIONAL_CONTEXT_CHARS });
  if (!clean) return;
  parts.push(clean);
}

function buildAdditionalContext(parts) {
  if (!parts.length) return '';
  const joined = parts.join('\n');
  return joined.length > MAX_ADDITIONAL_CONTEXT_CHARS
    ? joined.slice(0, MAX_ADDITIONAL_CONTEXT_CHARS).trimEnd()
    : joined;
}

/**
 * Run programmatic `weave/pre-compact` Cordis event hooks via `options.bus` or safely resolved bus.
 *
 * @param {object} ctx
 * @param {object} [payload]
 * @param {{ bus?: object, signal?: AbortSignal, timeoutMs?: number, failClosed?: boolean, log?: Function|object }} [options]
 * @returns {Promise<{ cancelled: boolean, reason: string|null, additionalContext: string, focusInstruction: string, warnings: string[] }>}
 */
export async function runPreCompactHooks(ctx, payload = {}, options = {}) {
  const { signal, log, failClosed = false } = options ?? {};
  const timeoutMs = clampTimeoutMs(options?.timeoutMs);
  throwIfAborted(signal);

  const warnings = [];
  const additionalParts = [];
  const focusParts = [];
  const probeErrors = [];

  let resolved;
  try {
    const bus = resolveHookBus(ctx, options, (error) => probeErrors.push(error));
    resolved = resolveBusListeners(bus, PRE_COMPACT_EVENT, payload, {
      postCompact: false,
      onProbeError: (error) => probeErrors.push(error),
    });
  } catch (error) {
    const msg = `${PRE_COMPACT_EVENT} dispatch failed: ${error?.message ?? error}`;
    warnings.push(msg);
    emitLog(log, ctx, 'warn', msg);
    if (failClosed === true) {
      return {
        cancelled: true,
        reason: sanitizeControlText(msg, { maxChars: MAX_REASON_CHARS }),
        additionalContext: '',
        focusInstruction: '',
        warnings,
      };
    }
    return {
      cancelled: false,
      reason: null,
      additionalContext: '',
      focusInstruction: '',
      warnings,
    };
  }

  if (!resolved.matched && probeErrors.length > 0) {
    const err = probeErrors[0];
    const msg = `${PRE_COMPACT_EVENT} dispatch failed: ${err?.message ?? err}`;
    warnings.push(msg);
    emitLog(log, ctx, 'warn', msg);
    if (failClosed === true) {
      return {
        cancelled: true,
        reason: sanitizeControlText(msg, { maxChars: MAX_REASON_CHARS }),
        additionalContext: '',
        focusInstruction: '',
        warnings,
      };
    }
    return {
      cancelled: false,
      reason: null,
      additionalContext: '',
      focusInstruction: '',
      warnings,
    };
  }

  const runners = resolved.runners;

  for (const run of runners) {
    throwIfAborted(signal);
    let result;
    try {
      result = await runBoundedTask(run, { timeoutMs, signal });
    } catch (error) {
      if (signal?.aborted) {
        throwIfAborted(signal);
        throw error;
      }
      const msg = `${PRE_COMPACT_EVENT} listener failed: ${error?.message ?? error}`;
      warnings.push(msg);
      emitLog(log, ctx, 'warn', msg);
      if (failClosed === true) {
        return {
          cancelled: true,
          reason: sanitizeControlText(msg, { maxChars: MAX_REASON_CHARS }),
          additionalContext: buildAdditionalContext(additionalParts),
          focusInstruction: sanitizeFocusInstruction(focusParts.join(' ')),
          warnings,
        };
      }
      continue;
    }

    const items = Array.isArray(result) ? result : [result];
    for (const item of items) {
      if (!isPlainObject(item)) continue;
      if (typeof item.additionalContext === 'string') {
        appendAdditionalContext(additionalParts, item.additionalContext);
      }
      if (typeof item.focusInstruction === 'string') {
        const cleanFocus = sanitizeFocusInstruction(item.focusInstruction);
        if (cleanFocus) focusParts.push(cleanFocus);
      }
      if (item.continue === false || item.cancel === true || item.cancelled === true) {
        const rawReason =
          typeof item.reason === 'string' && item.reason.trim()
            ? item.reason
            : (typeof item.message === 'string' && item.message.trim() ? item.message : 'cancelled by weave/pre-compact hook');
        const reason = sanitizeControlText(rawReason, { maxChars: MAX_REASON_CHARS }) || 'cancelled by weave/pre-compact hook';
        return {
          cancelled: true,
          reason,
          additionalContext: buildAdditionalContext(additionalParts),
          focusInstruction: sanitizeFocusInstruction(focusParts.join(' ')),
          warnings,
        };
      }
    }
  }

  return {
    cancelled: false,
    reason: null,
    additionalContext: buildAdditionalContext(additionalParts),
    focusInstruction: sanitizeFocusInstruction(focusParts.join(' ')),
    warnings,
  };
}

/**
 * Run programmatic `weave/post-compact` Cordis event hooks via `options.bus` or safely resolved bus.
 * Strictly failure-isolated: never throws or fails a committed compaction.
 *
 * @param {object} ctx
 * @param {object} [payload]
 * @param {{ bus?: object, signal?: AbortSignal, timeoutMs?: number, log?: Function|object }} [options]
 * @returns {Promise<{ notices: string[], warnings: string[] }>}
 */
export async function runPostCompactHooks(ctx, payload = {}, options = {}) {
  const { signal, log } = options ?? {};
  const timeoutMs = clampTimeoutMs(options?.timeoutMs);
  const notices = [];
  const warnings = [];
  const probeErrors = [];

  const pushNotice = (raw) => {
    if (notices.length >= MAX_NOTICES) return;
    const clean = sanitizeControlText(raw, { preserveNewlines: true, maxChars: MAX_NOTICE_CHARS });
    if (clean) notices.push(clean);
  };

  const collectFromItem = (item) => {
    if (!isPlainObject(item)) return;
    if (typeof item.notice === 'string') pushNotice(item.notice);
    if (Array.isArray(item.notices)) {
      for (const entry of item.notices) {
        if (typeof entry === 'string') pushNotice(entry);
      }
    }
    if (typeof item.additionalContext === 'string') pushNotice(item.additionalContext);
    if (typeof item.systemMessage === 'string') pushNotice(item.systemMessage);
  };

  try {
    if (signal?.aborted) {
      return { notices, warnings };
    }
    const bus = resolveHookBus(ctx, options, (error) => probeErrors.push(error));
    const resolved = resolveBusListeners(bus, POST_COMPACT_EVENT, payload, {
      postCompact: true,
      onProbeError: (error) => probeErrors.push(error),
    });
    if (!resolved.matched && probeErrors.length > 0) {
      const err = probeErrors[0];
      const msg = `${POST_COMPACT_EVENT} dispatch failed: ${err?.message ?? err}`;
      warnings.push(msg);
      emitLog(log, ctx, 'warn', msg);
      return { notices, warnings };
    }
    for (const run of resolved.runners) {
      if (signal?.aborted) break;
      try {
        const result = await runBoundedTask(run, { timeoutMs, signal });
        const items = Array.isArray(result) ? result : [result];
        for (const item of items) collectFromItem(item);
      } catch (error) {
        const msg = `${POST_COMPACT_EVENT} listener failed: ${error?.message ?? error}`;
        warnings.push(msg);
        emitLog(log, ctx, 'warn', msg);
      }
    }
  } catch (error) {
    const msg = `${POST_COMPACT_EVENT} dispatch failed: ${error?.message ?? error}`;
    warnings.push(msg);
    emitLog(log, ctx, 'warn', msg);
  }

  return { notices, warnings };
}
