// Shared classifiers for window overflow (HTTP 413 / model window),
// billion-context (bili) coexistence & local-proxy residue, and non-snippable failures.

const WINDOW_MESSAGE_RE =
  /(?:context\s+length|context\s+window|model\s+window|maximum\s+context|too\s+long|payload\s+too\s+large|request\s+entity\s+too\s+large|oversized\s+content|CONTEXT_WINDOW_EXCEEDED|(?:^|[\s:(])(?:HTTP\s+)?413(?:\s*[:(]|\s+Payload\s+Too\s+Large|\s+Request\s+Entity\s+Too\s+Large))/i;

const WINDOW_CODES = new Set([
  'CONTEXT_WINDOW_EXCEEDED',
  'context_length_exceeded',
  'context_window_exceeded',
  'prompt_too_long',
  'payload_too_large',
]);

const BILI_PREFLIGHT_RE =
  /preflight_compress_failed|payload\s+core\s+text\s+alone\s+is\b|no\s+upstream\s+can\s+accept\s+it/i;

const NON_SNIPPABLE_CODES = new Set([
  'RECOVERY_REQUIRED',
  'SUMMARY_FOREIGN_BILI_FORMAT',
  'BILI_PROXY_CONFLICT',
  'BILI_COEXISTENCE_CONFLICT',
  'NO_SUMMARY_TARGET',
  'CONFIG_INVALID',
  'COMPACTION_INVALID_BUDGET',
  'COMPACTION_RETAIN_EXCEEDS_THRESHOLD',
  'STATE_UNAVAILABLE',
  'STATE_INVALID',
  'ARCHIVE_UNAVAILABLE',
  'MEMORY_ARCHIVE_REQUIRED',
]);

const AUTH_STATUSES = new Set([401, 403]);
const AUTH_CODE_RE = /AUTH|CREDENTIAL|PERMISSION/i;
const BILI_PLUGIN_NAME_RE = /^(?:@[^/]+\/)?(?:dsh-)?billion-context(?:-dsh)?(?:$|\/)/i;
const BILI_LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|::1|\[::1\]|0\.0\.0\.0)$/i;
const BILI_HINT_RE = /bili|billion/i;
const SAFE_SIGNAL_RE = /^[a-z0-9_.-]{1,64}$/i;
const SAFE_CODE_RE = /^[A-Za-z0-9_.-]{1,80}$/;

export function extractErrorChain(error, maxDepth = 6) {
  const chain = [];
  const seen = new Set();
  for (let current = error; current && chain.length < maxDepth && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (typeof current === 'string') {
      chain.push({
        code: null,
        failureCode: null,
        httpStatus: null,
        status: null,
        statusCode: null,
        message: current,
        failureCodes: [],
      });
      break;
    }
    if (typeof current !== 'object' && typeof current !== 'function') break;
    chain.push({
      code: typeof current.code === 'string' ? current.code : null,
      failureCode: typeof current.failureCode === 'string' ? current.failureCode : null,
      httpStatus: Number.isInteger(current.httpStatus) ? current.httpStatus : null,
      status: Number.isInteger(current.status) ? current.status : null,
      statusCode: Number.isInteger(current.statusCode) ? current.statusCode : null,
      message: typeof current.message === 'string' ? current.message : '',
      failureCodes: Array.isArray(current.failureCodes)
        ? current.failureCodes.filter((item) => typeof item === 'string')
        : [],
    });
  }
  return chain;
}

export function classifyBiliProxyError(error) {
  const chain = extractErrorChain(error);
  for (const item of chain) {
    if (
      item.code === 'SUMMARY_FOREIGN_BILI_FORMAT' ||
      item.failureCode === 'SUMMARY_FOREIGN_BILI_FORMAT' ||
      item.failureCodes.includes('SUMMARY_FOREIGN_BILI_FORMAT')
    ) {
      return 'foreign_bili_format';
    }
    if (
      item.code === 'BILI_PROXY_CONFLICT' ||
      item.failureCode === 'BILI_PROXY_CONFLICT' ||
      item.failureCodes.includes('BILI_PROXY_CONFLICT') ||
      BILI_PREFLIGHT_RE.test(item.message)
    ) {
      return 'bili_proxy_preflight';
    }
  }
  return null;
}

export function isBiliProxyPreflightError(error) {
  return classifyBiliProxyError(error) === 'bili_proxy_preflight';
}

export function isBiliProxyResidualError(error) {
  return classifyBiliProxyError(error) !== null;
}

export function isWindowOverflowMessage(message) {
  if (typeof message !== 'string' || !message) return false;
  if (BILI_PREFLIGHT_RE.test(message)) return false;
  return WINDOW_MESSAGE_RE.test(message);
}

export function isWindowOverflowError(error) {
  if (!error) return false;
  if (isBiliProxyPreflightError(error)) return false;
  const chain = extractErrorChain(error);
  for (const item of chain) {
    if (
      (item.code && WINDOW_CODES.has(item.code)) ||
      (item.failureCode && WINDOW_CODES.has(item.failureCode)) ||
      item.failureCodes.some((c) => WINDOW_CODES.has(c))
    ) {
      return true;
    }
    if (item.httpStatus === 413 || item.status === 413 || item.statusCode === 413) {
      return true;
    }
    if (isWindowOverflowMessage(item.message)) {
      return true;
    }
  }
  return false;
}

export function isNonSnippableCompactionError(error) {
  if (!error) return false;
  if (isBiliProxyPreflightError(error)) return true;
  const chain = extractErrorChain(error);
  for (const item of chain) {
    for (const c of [item.code, item.failureCode, ...item.failureCodes]) {
      if (!c) continue;
      if (NON_SNIPPABLE_CODES.has(c) || AUTH_CODE_RE.test(c)) return true;
    }
    for (const st of [item.httpStatus, item.status, item.statusCode]) {
      if (st !== null && AUTH_STATUSES.has(st)) return true;
    }
  }
  return false;
}

export function isBiliPluginName(name) {
  return typeof name === 'string' && BILI_PLUGIN_NAME_RE.test(name.trim());
}

export function findEnabledBiliPluginRows(rows, seen = new Set()) {
  if (!Array.isArray(rows)) return 0;
  let count = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || seen.has(row)) continue;
    seen.add(row);
    const disabled = row.disabled === true || row.enabled === false;
    if (!disabled && (isBiliPluginName(row.name) || isBiliPluginName(row.packageName) || isBiliPluginName(row.plugin))) {
      count += 1;
    }
    if (Array.isArray(row.config)) {
      count += findEnabledBiliPluginRows(row.config, seen);
    } else if (row.config && typeof row.config === 'object') {
      if (Array.isArray(row.config.plugins)) count += findEnabledBiliPluginRows(row.config.plugins, seen);
      if (Array.isArray(row.config.rows)) count += findEnabledBiliPluginRows(row.config.rows, seen);
    }
    if (Array.isArray(row.plugins)) {
      count += findEnabledBiliPluginRows(row.plugins, seen);
    }
  }
  return count;
}

export function detectLoopbackBiliProviders(llmService) {
  if (!llmService || typeof llmService.listProviders !== 'function') return [];
  let list;
  try {
    list = llmService.listProviders();
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const matches = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const rawUrl = entry.baseUrl ?? entry.baseURL ?? entry.endpoint ?? entry.url ?? entry.config?.baseUrl ?? entry.config?.baseURL;
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) continue;
    let parsed;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      continue;
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (!BILI_LOOPBACK_HOST_RE.test(hostname)) continue;
    const hints = [
      rawUrl,
      entry.id,
      entry.provider,
      entry.name,
      entry.label,
      entry.proxyTarget,
      entry.via,
      entry.description,
    ]
      .filter((v) => typeof v === 'string')
      .join(' ');
    if (BILI_HINT_RE.test(hints)) {
      matches.push(typeof entry.id === 'string' ? entry.id : typeof entry.provider === 'string' ? entry.provider : rawUrl.trim());
    }
  }
  return matches;
}

function getOptionalBiliService(ctx) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get('biliBasicCompactionPolicy') : null;
  } catch {
    return null;
  }
}

export function detectBiliCoexistence({
  ctx = null,
  enabledConfigRows = 0,
  runtimeSignals = null,
  llmService = null,
  globalObj = globalThis,
} = {}) {
  const signals = [];
  const seen = new Set();
  const pushSignal = (value) => {
    if (typeof value === 'string' && SAFE_SIGNAL_RE.test(value) && !seen.has(value)) {
      seen.add(value);
      signals.push(value);
    }
  };

  let activePlugin = false;
  if (globalObj?.__BILI_DSH_COMPACTION_VERDICT__ === 'active') {
    activePlugin = true;
    pushSignal('bili_verdict_active');
  }
  const telemetry = globalObj?.__BILI_DSH_COMPACTION_GATE_TELEMETRY__;
  if (
    telemetry &&
    typeof telemetry === 'object' &&
    telemetry.active !== false &&
    telemetry.verdict !== 'inactive'
  ) {
    activePlugin = true;
    pushSignal('bili_gate_telemetry');
  }
  if (Number.isInteger(enabledConfigRows) && enabledConfigRows > 0) {
    activePlugin = true;
    pushSignal('bili_config_enabled');
  }
  if (getOptionalBiliService(ctx)) {
    activePlugin = true;
    pushSignal('bili_service_present');
  }

  let proxyResidue = false;
  let lastSignalAt = null;
  let lastSignalCode = null;
  const noteTiming = (at, code) => {
    if (typeof at === 'string' && at.length > 0 && at.length <= 64) {
      if (lastSignalAt === null || at > lastSignalAt) {
        lastSignalAt = at;
        if (typeof code === 'string' && SAFE_CODE_RE.test(code)) lastSignalCode = code;
      }
    } else if (lastSignalCode === null && typeof code === 'string' && SAFE_CODE_RE.test(code)) {
      lastSignalCode = code;
    }
  };

  if (Array.isArray(runtimeSignals)) {
    for (const item of runtimeSignals) {
      if (!item || typeof item !== 'object') continue;
      if (item.kind === 'foreign_bili_format') {
        proxyResidue = true;
        pushSignal('summary_foreign_bili_format');
        noteTiming(item.at, item.code ?? 'SUMMARY_FOREIGN_BILI_FORMAT');
      } else if (item.kind === 'bili_proxy_preflight') {
        proxyResidue = true;
        pushSignal('bili_proxy_preflight_413');
        noteTiming(item.at, item.code ?? 'BILI_PROXY_CONFLICT');
      }
    }
  }

  if (detectLoopbackBiliProviders(llmService).length > 0) {
    proxyResidue = true;
    pushSignal('provider_bili_loopback_proxy');
    if (!lastSignalCode) lastSignalCode = 'BILI_PROXY_CONFLICT';
  }

  const detected = activePlugin || proxyResidue;
  const kind = activePlugin && proxyResidue
    ? 'both'
    : activePlugin
      ? 'active_plugin'
      : proxyResidue
        ? 'proxy_residue'
        : null;

  return {
    detected,
    kind,
    activePlugin,
    proxyResidue,
    signals,
    restartRecommended: detected,
    lastSignalAt,
    lastSignalCode,
  };
}

export function sanitizeBiliConflict(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const detected = raw.detected === true;
  if (!detected) return null;
  const kind = ['active_plugin', 'proxy_residue', 'both'].includes(raw.kind) ? raw.kind : null;
  const activePlugin = raw.activePlugin === true || kind === 'active_plugin' || kind === 'both';
  const proxyResidue = raw.proxyResidue === true || kind === 'proxy_residue' || kind === 'both';
  const normalizedKind = activePlugin && proxyResidue
    ? 'both'
    : activePlugin
      ? 'active_plugin'
      : proxyResidue
        ? 'proxy_residue'
        : kind;
  if (!normalizedKind) return null;
  const signals = Array.isArray(raw.signals)
    ? [...new Set(raw.signals.filter((s) => typeof s === 'string' && SAFE_SIGNAL_RE.test(s)))].slice(0, 12)
    : [];
  const lastSignalAt =
    typeof raw.lastSignalAt === 'string' && raw.lastSignalAt.length > 0 && raw.lastSignalAt.length <= 64
      ? raw.lastSignalAt
      : null;
  const lastSignalCode =
    typeof raw.lastSignalCode === 'string' && SAFE_CODE_RE.test(raw.lastSignalCode.trim())
      ? raw.lastSignalCode.trim()
      : null;
  return {
    detected: true,
    kind: normalizedKind,
    activePlugin,
    proxyResidue,
    signals,
    restartRecommended: raw.restartRecommended !== false,
    lastSignalAt,
    lastSignalCode,
  };
}
