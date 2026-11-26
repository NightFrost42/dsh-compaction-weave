// Summary-model configuration for dsh-compaction-weave.
//
// The value is deliberately kept OUT of cordis.patch.yml / the profile manifest:
// the plugin owns a small JSON file under its storage root, the Settings page
// writes it through the host RPC below, and the gate merges it into the engine
// config at each operation boundary. This survives bundle updates and never rewrites shared
// profile configuration.
//
// File: <DSH_HOME>/storages/dsh-compaction-weave/summary-config.json
// Shape: { version: 1, summarizationProvider, summarizationModel, maxTokens, thresholdRatio, idleCompactionMinutes?, auditBlockOnLoss?, updatedAt }
//
// thresholdRatio is the auto-compaction trigger line as a fraction of the model
// window (0.5–0.95). It is stored here as well so the Settings page can tune it
// without touching the engine config; null/absent means "use the engine default
// (0.8)".
// idleCompactionMinutes is also independent of the model: absence inherits,
// while zero explicitly disables it. Model-only saves/clears retain its value.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setBoundedMap } from './collections.js';
import {
  normalizeAuditCoverageScope,
  normalizeAuditExhaustionPolicy,
  normalizeExtraReferencePrefixes,
  normalizeArchiveWarnBytes,
  normalizeMaxVisibleAttachmentBytes,
  normalizeMaxVisibleImages,
  normalizeContextCollapseEnabled,
  normalizeIdleCompactionMinutes,
  normalizePressureBreakerAction,
  normalizeMicrocompactEnabled,
  normalizePersistedOutputEnabled,
  normalizePostCompactReinjectEnabled,
  normalizeObservationMaskingEnabled,
  normalizeSessionMemoryEnabled,
  normalizeSessionMemoryMaxCallsPerSession,
  normalizeSnipEnabled,
  normalizeSummaryCjkTokensPerChar,
  normalizeSummaryConcurrency,
  normalizeSummaryReasoningEffort,
} from './config.js';
import {
  HOT_BOOLEAN_TOGGLE_SPECS,
  HOT_ENUM_FIELD_SPECS,
  HOT_NUMERIC_FIELD_SPECS,
  MAX_REDUCTION_RATIO,
  MAX_THRESHOLD_RATIO,
  MAX_TOKENS_LIMIT,
  MIN_REDUCTION_RATIO,
  MIN_THRESHOLD_RATIO,
  STANDALONE_BOOLEAN_SPECS,
  SUMMARY_RETRY_SETTINGS,
} from './settings-schema.js';

export const CONFIG_VERSION = 1;
export const MAX_BODY_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 200;
const MAX_SUMMARY_CONFIG_CACHE_ENTRIES = 32;
const SUMMARY_CONFIG_CACHE = new Map();

function cloneSummaryConfigEntry(value) {
  if (!value || typeof value !== 'object') return value;
  const copy = { ...value };
  if (Array.isArray(copy.extraReferencePrefixes)) {
    copy.extraReferencePrefixes = [...copy.extraReferencePrefixes];
  }
  return copy;
}

/**
 * Invalidate cached `readSummaryConfig` entries for `file`, or clear the entire
 * summary-config cache when omitted.
 */
export function invalidateSummaryConfigCache(file) {
  if (!file) {
    SUMMARY_CONFIG_CACHE.clear();
    return;
  }
  const abs = resolve(file);
  SUMMARY_CONFIG_CACHE.delete(`${abs}\x000`);
  SUMMARY_CONFIG_CACHE.delete(`${abs}\x001`);
}

export {
  MIN_THRESHOLD_RATIO,
  MAX_THRESHOLD_RATIO,
  SUMMARY_RETRY_SETTINGS,
};

const HOT_NORMALIZERS = Object.freeze({
  idleCompactionMinutes: normalizeIdleCompactionMinutes,
  summaryConcurrency: normalizeSummaryConcurrency,
  summaryCjkTokensPerChar: normalizeSummaryCjkTokensPerChar,
  sessionMemoryMaxCallsPerSession: normalizeSessionMemoryMaxCallsPerSession,
  archiveWarnBytes: normalizeArchiveWarnBytes,
  maxVisibleAttachmentBytes: normalizeMaxVisibleAttachmentBytes,
  maxVisibleImages: normalizeMaxVisibleImages,
  summaryReasoningEffort: normalizeSummaryReasoningEffort,
  pressureBreakerAction: normalizePressureBreakerAction,
  auditExhaustionPolicy: normalizeAuditExhaustionPolicy,
  auditCoverageScope: normalizeAuditCoverageScope,
  observationMaskingEnabled: normalizeObservationMaskingEnabled,
  postCompactReinjectEnabled: normalizePostCompactReinjectEnabled,
  persistedOutputEnabled: normalizePersistedOutputEnabled,
  microcompactEnabled: normalizeMicrocompactEnabled,
  snipEnabled: normalizeSnipEnabled,
  sessionMemoryEnabled: normalizeSessionMemoryEnabled,
  contextCollapseEnabled: normalizeContextCollapseEnabled,
});

const RETRY_SETTING_KEYS = Object.freeze(Object.keys(SUMMARY_RETRY_SETTINGS));
const PRESERVED_INDEPENDENT_KEYS = Object.freeze([
  ...STANDALONE_BOOLEAN_SPECS.map((spec) => spec.key),
  ...HOT_ENUM_FIELD_SPECS.map((spec) => spec.key),
  ...HOT_NUMERIC_FIELD_SPECS.map((spec) => spec.key),
  ...HOT_BOOLEAN_TOGGLE_SPECS.map((spec) => spec.key),
  'extraReferencePrefixes',
]);

// Provider/model ids are opaque routing keys, not paths. Keep them printable
// and slash/colon/@ friendly; reject whitespace and control characters.
const ID_RE = /^[A-Za-z0-9@][A-Za-z0-9._/@:+-]*$/;

export class SummaryConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SummaryConfigError';
    this.code = code;
  }
}

/** Merge over the original engine row, never over a previous settings override.
 * Clearing an override must restore that row's inherited value immediately. */
export function mergeSummaryConfig(rawEngine, savedSummary) {
  const config = { ...(rawEngine && typeof rawEngine === 'object' ? rawEngine : {}) };
  if (!savedSummary || typeof savedSummary !== 'object') return config;
  if (savedSummary.provider && savedSummary.model) {
    config.summarizationProvider = savedSummary.provider;
    config.summarizationModel = savedSummary.model;
  }
  if (savedSummary.maxTokens !== null && savedSummary.maxTokens !== undefined) {
    config.maxTokens = savedSummary.maxTokens;
  }
  for (const key of RETRY_SETTING_KEYS) {
    if (Number.isInteger(savedSummary[key])) config[key] = savedSummary[key];
  }
  if (savedSummary.idleCompactionMinutes !== undefined) {
    try {
      config.idleCompactionMinutes = normalizeIdleCompactionMinutes(savedSummary.idleCompactionMinutes);
    } catch (error) {
      throw new SummaryConfigError('INVALID_IDLE_COMPACTION_MINUTES', error.message);
    }
  }
  for (const spec of STANDALONE_BOOLEAN_SPECS) {
    if (savedSummary[spec.key] !== undefined) {
      if (typeof savedSummary[spec.key] !== 'boolean') {
        throw new SummaryConfigError(spec.errorCode, spec.errorMessage);
      }
      config[spec.key] = savedSummary[spec.key];
    }
  }
  for (const spec of HOT_ENUM_FIELD_SPECS) {
    if (savedSummary[spec.key] !== undefined) {
      try {
        const raw = savedSummary[spec.key];
        config[spec.key] = HOT_NORMALIZERS[spec.key](typeof raw === 'string' ? raw.trim() : raw);
      } catch (error) {
        throw new SummaryConfigError(spec.errorCode, error.message);
      }
    }
  }
  if (savedSummary.extraReferencePrefixes !== undefined) {
    try {
      config.extraReferencePrefixes = normalizeExtraReferencePrefixes(savedSummary.extraReferencePrefixes);
    } catch (error) {
      throw new SummaryConfigError('INVALID_EXTRA_REFERENCE_PREFIXES', error.message);
    }
  }
  for (const spec of [...HOT_NUMERIC_FIELD_SPECS, ...HOT_BOOLEAN_TOGGLE_SPECS]) {
    if (spec.key === 'idleCompactionMinutes') continue;
    if (savedSummary[spec.key] !== undefined) {
      try {
        config[spec.key] = HOT_NORMALIZERS[spec.key](savedSummary[spec.key]);
      } catch (error) {
        throw new SummaryConfigError(spec.errorCode, error.message);
      }
    }
  }
  for (const key of ['minimumReductionRatio', 'thresholdRatio']) {
    if (typeof savedSummary[key] === 'number' && Number.isFinite(savedSummary[key])) config[key] = savedSummary[key];
  }
  return config;
}

/** Default location: the plugin's own storage root, next to state/journal. */
export function defaultSummaryConfigPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'storages', 'dsh-compaction-weave', 'summary-config.json');
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function maxTokensOf(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_TOKENS_LIMIT) return null;
  return number;
}

/**
 * Parse a trigger ratio. Returns null when the value is absent/blank, and a
 * rounded fraction when it is a finite number inside the allowed range.
 * Callers that need "invalid vs absent" distinction use validateSummaryConfig.
 */
function thresholdRatioOf(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < MIN_THRESHOLD_RATIO || number > MAX_THRESHOLD_RATIO) return null;
  // The slider speaks whole percents; round away float tails like 0.8000000000000001.
  return Math.round(number * 100) / 100;
}

function minimumReductionRatioOf(value) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) && number >= MIN_REDUCTION_RATIO && number <= MAX_REDUCTION_RATIO
    ? Math.round(number * 100) / 100
    : null;
}

function invalidThresholdRatioInput(input) {
  const value = input?.thresholdRatio;
  if (value === undefined || value === null) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  return thresholdRatioOf(value) === null;
}

function retrySettingsOf(input) {
  const value = {};
  for (const [key, range] of Object.entries(SUMMARY_RETRY_SETTINGS)) {
    const raw = input?.[key];
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) continue;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < range.min || n > range.max) {
      return {
        ok: false,
        code: 'INVALID_' + key.replace(/[A-Z]/g, (m) => '_' + m).toUpperCase(),
        message: `${key} must be an integer between ${range.min} and ${range.max}`,
      };
    }
    value[key] = n;
  }
  return { ok: true, value };
}

function parseHotNumericSpec(raw, spec) {
  if (spec.ignoreBlankOrNull) {
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      return { skip: true };
    }
    const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
    return { skip: false, value: HOT_NORMALIZERS[spec.key](parsed) };
  }
  if (raw === undefined) return { skip: true };
  const parsed =
    spec.acceptDigitString && typeof raw === 'string' && /^\d+$/.test(raw.trim())
      ? Number(raw.trim())
      : raw;
  return { skip: false, value: HOT_NORMALIZERS[spec.key](parsed) };
}

function collectHotSettings(input) {
  const retry = retrySettingsOf(input);
  if (!retry.ok) return retry;

  const value = { ...retry.value };

  for (const spec of STANDALONE_BOOLEAN_SPECS) {
    const raw = input?.[spec.key];
    if (raw === undefined) continue;
    if (typeof raw !== 'boolean') {
      return { ok: false, code: spec.errorCode, message: spec.errorMessage };
    }
    value[spec.key] = raw;
  }

  for (const spec of HOT_ENUM_FIELD_SPECS) {
    const raw = input?.[spec.key];
    if (raw === undefined) continue;
    try {
      value[spec.key] = HOT_NORMALIZERS[spec.key](typeof raw === 'string' ? raw.trim() : raw);
    } catch (error) {
      return { ok: false, code: spec.errorCode, message: error.message };
    }
  }

  if (input?.extraReferencePrefixes !== undefined) {
    try {
      value.extraReferencePrefixes = [...normalizeExtraReferencePrefixes(input.extraReferencePrefixes)];
    } catch (error) {
      return { ok: false, code: 'INVALID_EXTRA_REFERENCE_PREFIXES', message: error.message };
    }
  }

  for (const spec of HOT_NUMERIC_FIELD_SPECS) {
    try {
      const parsed = parseHotNumericSpec(input?.[spec.key], spec);
      if (!parsed.skip) value[spec.key] = parsed.value;
    } catch (error) {
      return { ok: false, code: spec.errorCode, message: error.message };
    }
  }

  for (const spec of HOT_BOOLEAN_TOGGLE_SPECS) {
    const raw = input?.[spec.key];
    if (raw === undefined) continue;
    try {
      value[spec.key] = HOT_NORMALIZERS[spec.key](raw);
    } catch (error) {
      return { ok: false, code: spec.errorCode, message: error.message };
    }
  }

  return { ok: true, value };
}

function isSummaryOverrideCleared(value) {
  return (
    value.maxTokens === null &&
    value.thresholdRatio === null &&
    value.minimumReductionRatio === undefined &&
    PRESERVED_INDEPENDENT_KEYS.every((key) => value[key] === undefined) &&
    RETRY_SETTING_KEYS.every((key) => value[key] === undefined)
  );
}

/**
 * Validate a settings submission. Both ids empty = clear the model override
 * (follow the session model); one empty = reject rather than guess.
 * Independent settings persist separately from the model override.
 */
export function validateSummaryConfig(input) {
  const hot = collectHotSettings(input);
  if (!hot.ok) return hot;
  const provider = textOf(input?.provider ?? input?.summarizationProvider);
  const model = textOf(input?.model ?? input?.summarizationModel);
  const maxTokens = maxTokensOf(input?.maxTokens);
  const thresholdRatio = thresholdRatioOf(input?.thresholdRatio);
  const minimumReductionRatio = minimumReductionRatioOf(input?.minimumReductionRatio);
  if (
    input?.minimumReductionRatio !== undefined &&
    input?.minimumReductionRatio !== null &&
    !(typeof input.minimumReductionRatio === 'string' && input.minimumReductionRatio.trim() === '') &&
    minimumReductionRatio === null
  ) {
    return {
      ok: false,
      code: 'INVALID_MINIMUM_REDUCTION_RATIO',
      message: `minimumReductionRatio must be a number between ${MIN_REDUCTION_RATIO} and ${MAX_REDUCTION_RATIO}`,
    };
  }
  if (maxTokens === null && input?.maxTokens !== undefined && input?.maxTokens !== null && String(input.maxTokens).trim() !== '') {
    return { ok: false, code: 'INVALID_MAX_TOKENS', message: `maxTokens must be an integer between 1 and ${MAX_TOKENS_LIMIT}` };
  }
  if (invalidThresholdRatioInput(input)) {
    return {
      ok: false,
      code: 'INVALID_THRESHOLD_RATIO',
      message: `thresholdRatio must be a number between ${MIN_THRESHOLD_RATIO} and ${MAX_THRESHOLD_RATIO}`,
    };
  }
  if (!provider && !model) {
    return {
      ok: true,
      value: {
        provider: '',
        model: '',
        maxTokens,
        thresholdRatio,
        ...hot.value,
        ...(minimumReductionRatio === null ? {} : { minimumReductionRatio }),
      },
    };
  }
  if (!provider || !model) {
    return { ok: false, code: 'SUMMARY_PAIR_REQUIRED', message: 'provider and model must be set together or left empty together' };
  }
  if (provider.length > MAX_ID_LENGTH || !ID_RE.test(provider)) {
    return { ok: false, code: 'INVALID_PROVIDER', message: 'provider contains unsupported characters or is too long' };
  }
  if (model.length > MAX_ID_LENGTH || !ID_RE.test(model)) {
    return { ok: false, code: 'INVALID_MODEL', message: 'model contains unsupported characters or is too long' };
  }
  return {
    ok: true,
    value: {
      provider,
      model,
      maxTokens,
      thresholdRatio,
      ...hot.value,
      ...(minimumReductionRatio === null ? {} : { minimumReductionRatio }),
    },
  };
}

/** Strict engine reads distinguish an absent override from a broken file.
 * The settings UI can still open a damaged file and replace it with a save. */
export function readSummaryConfig(file = defaultSummaryConfigPath(), { strict = false } = {}) {
  const cacheKey = `${resolve(file)}\x00${strict ? '1' : '0'}`;
  let stamp = null;
  try {
    const st = statSync(file, { bigint: true });
    stamp = `${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;
    const cached = SUMMARY_CONFIG_CACHE.get(cacheKey);
    if (cached && cached.stamp === stamp) {
      return cloneSummaryConfigEntry(cached.value);
    }
  } catch (statError) {
    SUMMARY_CONFIG_CACHE.delete(cacheKey);
    if (statError?.code === 'ENOENT') return null;
    if (strict) {
      const error = new SummaryConfigError(
        'INVALID_SAVED_SETTINGS',
        'Compaction settings could not be read safely. Open Summary model settings and save them again; the pending input is retained.',
      );
      error.cause = statError;
      throw error;
    }
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (
      strict &&
      (!parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        (parsed.version !== undefined && parsed.version !== CONFIG_VERSION))
    ) {
      throw new Error('Invalid settings document.');
    }
    let result = null;
    if (parsed && typeof parsed === 'object') {
      if (strict) {
        for (const key of ['summarizationProvider', 'summarizationModel']) {
          if (parsed[key] !== undefined && typeof parsed[key] !== 'string') throw new Error(`Invalid ${key}.`);
        }
        const verdict = validateSummaryConfig({ ...parsed, provider: parsed.summarizationProvider, model: parsed.summarizationModel });
        if (!verdict.ok) throw new Error(verdict.message);
      }
      const hot = collectHotSettings(parsed);
      if (hot.ok) {
        const provider = textOf(parsed.summarizationProvider);
        const model = textOf(parsed.summarizationModel);
        const thresholdRatio = thresholdRatioOf(parsed.thresholdRatio);
        const minimumReductionRatio = minimumReductionRatioOf(parsed.minimumReductionRatio);
        const maxTokens = maxTokensOf(parsed.maxTokens);
        // Independent settings are valid without a model override, including zero/false values.
        const allEmpty =
          !provider &&
          !model &&
          thresholdRatio === null &&
          minimumReductionRatio === null &&
          maxTokens === null &&
          Object.keys(hot.value).length === 0;
        const mismatchPair = (provider === '') !== (model === '');
        const badProvider = Boolean(provider && (provider.length > MAX_ID_LENGTH || !ID_RE.test(provider)));
        const badModel = Boolean(model && (model.length > MAX_ID_LENGTH || !ID_RE.test(model)));
        if (!allEmpty && !mismatchPair && !badProvider && !badModel) {
          result = {
            provider,
            model,
            maxTokens,
            thresholdRatio,
            ...hot.value,
            ...(minimumReductionRatio === null ? {} : { minimumReductionRatio }),
          };
        }
      }
    }
    setBoundedMap(
      SUMMARY_CONFIG_CACHE,
      cacheKey,
      { stamp, value: cloneSummaryConfigEntry(result) },
      MAX_SUMMARY_CONFIG_CACHE_ENTRIES,
    );
    return cloneSummaryConfigEntry(result);
  } catch (cause) {
    SUMMARY_CONFIG_CACHE.delete(cacheKey);
    if (strict && cause?.code !== 'ENOENT') {
      const error = new SummaryConfigError(
        'INVALID_SAVED_SETTINGS',
        'Compaction settings could not be read safely. Open Summary model settings and save them again; the pending input is retained.',
      );
      error.cause = cause;
      throw error;
    }
    return null;
  }
}

/** Write the override file. Invalid input must never reach this function. */
export function writeSummaryConfig(file, value) {
  const hot = collectHotSettings(value);
  if (!hot.ok) throw new SummaryConfigError(hot.code, hot.message);
  const provider = textOf(value?.provider);
  const model = textOf(value?.model);
  const maxTokens = maxTokensOf(value?.maxTokens);
  const thresholdRatio = thresholdRatioOf(value?.thresholdRatio);
  const minimumReductionRatio = minimumReductionRatioOf(value?.minimumReductionRatio);
  const payload = {
    version: CONFIG_VERSION,
    ...hot.value,
    updatedAt: new Date().toISOString(),
    ...(provider && model ? { summarizationProvider: provider, summarizationModel: model } : {}),
    ...(maxTokens === null ? {} : { maxTokens }),
    ...(thresholdRatio === null ? {} : { thresholdRatio }),
    ...(minimumReductionRatio === null ? {} : { minimumReductionRatio }),
  };
  const body = JSON.stringify(payload, null, 2) + '\n';
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 });
    try {
      renameSync(temporary, file);
    } catch {
      // Windows can refuse rename-over-existing; a direct rewrite is still safe
      // for this small, single-writer file, and readSummaryConfig ignores junk.
      writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
      try { unlinkSync(temporary); } catch { /* best effort */ }
    }
  } finally {
    invalidateSummaryConfigCache(file);
  }
}

async function listCatalogProviders(llm) {
  // The Settings page renders provider/model selects from the host's live
  // LLM catalog, so the dropdowns match what this DSH can actually route.
  if (!llm || typeof llm.listProviders !== 'function') {
    throw new SummaryConfigError('MODELS_UNAVAILABLE', 'the host LLM catalog is unavailable');
  }
  const providers = [];
  for (const info of llm.listProviders() ?? []) {
    const provider = typeof info?.id === 'string' ? info.id : typeof info?.provider === 'string' ? info.provider : '';
    if (!provider) continue;
    let models = [];
    try {
      models = typeof llm.listModels === 'function' ? await llm.listModels(provider) : [];
    } catch {
      models = [];
    }
    providers.push({
      provider,
      name: typeof info?.name === 'string' && info.name ? info.name : provider,
      models: (Array.isArray(models) ? models : [])
        .filter((model) => model && typeof model.id === 'string' && model.id.length > 0)
        .map((model) => ({ id: model.id, name: typeof model.name === 'string' && model.name ? model.name : model.id })),
    });
  }
  return { providers };
}

/**
 * Pure RPC dispatch, kept separate from HTTP so it can be tested offline.
 * Throws SummaryConfigError for invalid methods/values.
 */
export async function handleSummaryConfigRpc(payload, file = defaultSummaryConfigPath(), llm = null) {
  const method = typeof payload?.method === 'string' ? payload.method : '';
  if (method === 'get') {
    return { config: readSummaryConfig(file), cleared: false, restartRequired: false };
  }
  if (method === 'models') {
    return listCatalogProviders(llm);
  }
  if (method === 'set') {
    const verdict = validateSummaryConfig(payload?.params ?? {});
    if (!verdict.ok) throw new SummaryConfigError(verdict.code, verdict.message);
    const value = verdict.value;
    // Older clients, partial saves, and model-only clears omit independent and retry settings.
    // Keep them until the user explicitly replaces them.
    const preservedOnPartialSet = [...RETRY_SETTING_KEYS, ...PRESERVED_INDEPENDENT_KEYS];
    if (preservedOnPartialSet.some((key) => value[key] === undefined)) {
      const previous = readSummaryConfig(file);
      for (const key of preservedOnPartialSet) {
        if (value[key] === undefined && previous?.[key] !== undefined) {
          value[key] = previous[key];
        }
      }
    }
    writeSummaryConfig(file, value);
    if (!value.provider && !value.model) {
      const cleared = isSummaryOverrideCleared(value);
      return { config: cleared ? null : value, cleared, restartRequired: false };
    }
    return { config: value, cleared: false, restartRequired: false };
  }
  if (method === 'clear') {
    const previous = readSummaryConfig(file);
    if (!previous) {
      return { config: null, cleared: true, restartRequired: false };
    }
    const clearedValue = {
      provider: '',
      model: '',
      maxTokens: null,
      thresholdRatio: previous.thresholdRatio ?? null,
    };
    if (previous.minimumReductionRatio !== undefined) {
      clearedValue.minimumReductionRatio = previous.minimumReductionRatio;
    }
    for (const key of [...RETRY_SETTING_KEYS, ...PRESERVED_INDEPENDENT_KEYS]) {
      if (previous[key] !== undefined) clearedValue[key] = previous[key];
    }
    writeSummaryConfig(file, clearedValue);
    const cleared = isSummaryOverrideCleared(clearedValue);
    return { config: cleared ? null : clearedValue, cleared, restartRequired: false };
  }
  throw new SummaryConfigError('UNKNOWN_METHOD', `unknown settings method: ${method || '(empty)'}`);
}
