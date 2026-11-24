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
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
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

const HOT_BOOLEAN_TOGGLES = Object.freeze([
  ['observationMaskingEnabled', normalizeObservationMaskingEnabled, 'INVALID_OBSERVATION_MASKING_ENABLED'],
  ['postCompactReinjectEnabled', normalizePostCompactReinjectEnabled, 'INVALID_POST_COMPACT_REINJECT_ENABLED'],
  ['persistedOutputEnabled', normalizePersistedOutputEnabled, 'INVALID_PERSISTED_OUTPUT_ENABLED'],
  ['microcompactEnabled', normalizeMicrocompactEnabled, 'INVALID_MICROCOMPACT_ENABLED'],
  ['snipEnabled', normalizeSnipEnabled, 'INVALID_SNIP_ENABLED'],
  ['sessionMemoryEnabled', normalizeSessionMemoryEnabled, 'INVALID_SESSION_MEMORY_ENABLED'],
  ['contextCollapseEnabled', normalizeContextCollapseEnabled, 'INVALID_CONTEXT_COLLAPSE_ENABLED'],
]);

export const CONFIG_VERSION = 1;
export const MAX_BODY_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 200;
const MAX_TOKENS_LIMIT = 1_000_000;
export const MIN_THRESHOLD_RATIO = 0.5;
export const MAX_THRESHOLD_RATIO = 0.95;

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
  for (const key of ['summaryRetryCount', 'summaryRetryDelayMs', 'summaryTimeoutMs']) {
    if (Number.isInteger(savedSummary[key])) config[key] = savedSummary[key];
  }
  if (savedSummary.idleCompactionMinutes !== undefined) config.idleCompactionMinutes = normalizeIdleCompactionMinutes(savedSummary.idleCompactionMinutes);
  if (savedSummary.auditBlockOnLoss !== undefined) {
    if (typeof savedSummary.auditBlockOnLoss !== 'boolean') {
      throw new SummaryConfigError('INVALID_AUDIT_BLOCK_ON_LOSS', 'auditBlockOnLoss must be a boolean');
    }
    config.auditBlockOnLoss = savedSummary.auditBlockOnLoss;
  }
  if (savedSummary.auditProvenanceBlock !== undefined) {
    if (typeof savedSummary.auditProvenanceBlock !== 'boolean') {
      throw new SummaryConfigError('INVALID_AUDIT_PROVENANCE_BLOCK', 'auditProvenanceBlock must be a boolean');
    }
    config.auditProvenanceBlock = savedSummary.auditProvenanceBlock;
  }
  if (savedSummary.auditExhaustionPolicy !== undefined) {
    try {
      const normalized =
        typeof savedSummary.auditExhaustionPolicy === 'string'
          ? savedSummary.auditExhaustionPolicy.trim()
          : savedSummary.auditExhaustionPolicy;
      config.auditExhaustionPolicy = normalizeAuditExhaustionPolicy(normalized);
    } catch (error) {
      throw new SummaryConfigError('INVALID_AUDIT_EXHAUSTION_POLICY', error.message);
    }
  }
  if (savedSummary.extraReferencePrefixes !== undefined) {
    try {
      config.extraReferencePrefixes = normalizeExtraReferencePrefixes(savedSummary.extraReferencePrefixes);
    } catch (error) {
      throw new SummaryConfigError('INVALID_EXTRA_REFERENCE_PREFIXES', error.message);
    }
  }
  if (savedSummary.summaryConcurrency !== undefined) {
    try {
      config.summaryConcurrency = normalizeSummaryConcurrency(savedSummary.summaryConcurrency);
    } catch (error) {
      throw new SummaryConfigError('INVALID_SUMMARY_CONCURRENCY', error.message);
    }
  }
  if (savedSummary.summaryReasoningEffort !== undefined) {
    try {
      const normalized =
        typeof savedSummary.summaryReasoningEffort === 'string'
          ? savedSummary.summaryReasoningEffort.trim()
          : savedSummary.summaryReasoningEffort;
      config.summaryReasoningEffort = normalizeSummaryReasoningEffort(normalized);
    } catch (error) {
      throw new SummaryConfigError('INVALID_SUMMARY_REASONING_EFFORT', error.message);
    }
  }
  if (savedSummary.summaryCjkTokensPerChar !== undefined) {
    try {
      config.summaryCjkTokensPerChar = normalizeSummaryCjkTokensPerChar(savedSummary.summaryCjkTokensPerChar);
    } catch (error) {
      throw new SummaryConfigError('INVALID_SUMMARY_CJK_TOKENS_PER_CHAR', error.message);
    }
  }
  if (savedSummary.pressureBreakerAction !== undefined) {
    try {
      const normalized =
        typeof savedSummary.pressureBreakerAction === 'string'
          ? savedSummary.pressureBreakerAction.trim()
          : savedSummary.pressureBreakerAction;
      config.pressureBreakerAction = normalizePressureBreakerAction(normalized);
    } catch (error) {
      throw new SummaryConfigError('INVALID_PRESSURE_BREAKER_ACTION', error.message);
    }
  }
  for (const [key, normalize, errorCode] of HOT_BOOLEAN_TOGGLES) {
    if (savedSummary[key] !== undefined) {
      try {
        config[key] = normalize(savedSummary[key]);
      } catch (error) {
        throw new SummaryConfigError(errorCode, error.message);
      }
    }
  }
  if (savedSummary.sessionMemoryMaxCallsPerSession !== undefined) {
    try {
      config.sessionMemoryMaxCallsPerSession = normalizeSessionMemoryMaxCallsPerSession(
        savedSummary.sessionMemoryMaxCallsPerSession,
      );
    } catch (error) {
      throw new SummaryConfigError('INVALID_SESSION_MEMORY_MAX_CALLS_PER_SESSION', error.message);
    }
  }
  if (savedSummary.archiveWarnBytes !== undefined) {
    try {
      config.archiveWarnBytes = normalizeArchiveWarnBytes(savedSummary.archiveWarnBytes);
    } catch (error) {
      throw new SummaryConfigError('INVALID_ARCHIVE_WARN_BYTES', error.message);
    }
  }
  if (savedSummary.maxVisibleAttachmentBytes !== undefined) {
    try {
      config.maxVisibleAttachmentBytes = normalizeMaxVisibleAttachmentBytes(
        savedSummary.maxVisibleAttachmentBytes,
      );
    } catch (error) {
      throw new SummaryConfigError('INVALID_MAX_VISIBLE_ATTACHMENT_BYTES', error.message);
    }
  }
  if (savedSummary.maxVisibleImages !== undefined) {
    try {
      config.maxVisibleImages = normalizeMaxVisibleImages(savedSummary.maxVisibleImages);
    } catch (error) {
      throw new SummaryConfigError('INVALID_MAX_VISIBLE_IMAGES', error.message);
    }
  }
  for (const key of ['minimumReductionRatio', 'thresholdRatio']) {
    if (typeof savedSummary[key] === 'number' && Number.isFinite(savedSummary[key])) config[key] = savedSummary[key];
  }
  return config;
}
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
  return Number.isFinite(number) && number >= 0.05 && number <= 0.9 ? Math.round(number * 100) / 100 : null;
}

function invalidThresholdRatioInput(input) {
  const value = input?.thresholdRatio;
  if (value === undefined || value === null) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  return thresholdRatioOf(value) === null;
}

export const SUMMARY_RETRY_SETTINGS = Object.freeze({
  summaryRetryCount: {min:0,max:4},
  summaryRetryDelayMs: {min:0,max:30000},
  summaryTimeoutMs: {min:5000,max:3600000},
});
function retrySettingsOf(input) {
  const value={};
  for(const [key,range] of Object.entries(SUMMARY_RETRY_SETTINGS)) {
    const raw=input?.[key];
    if(raw===undefined||raw===null||typeof raw==='string'&&raw.trim()==='')continue;
    const n=typeof raw==='number'?raw:typeof raw==='string'?Number(raw):NaN;
    if(!Number.isInteger(n)||n<range.min||n>range.max)return {ok:false,code:'INVALID_'+key.replace(/[A-Z]/g,m=>'_'+m).toUpperCase(),message:`${key} must be an integer between ${range.min} and ${range.max}`};
    value[key]=n;
  }
  return {ok:true,value};
}

function idleSettingsOf(input) {
  const raw = input?.idleCompactionMinutes;
  // Absence inherits the engine config; an explicit zero disables the feature.
  if (raw === undefined) return { ok: true, value: {} };
  const number = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  try {
    return { ok: true, value: { idleCompactionMinutes: normalizeIdleCompactionMinutes(number) } };
  } catch (error) {
    return { ok: false, code: 'INVALID_IDLE_COMPACTION_MINUTES', message: error.message };
  }
}

function auditSettingsOf(input) {
  const value = {};
  const raw = input?.auditBlockOnLoss;
  // Absence inherits the engine config (default true).
  if (raw !== undefined) {
    if (typeof raw !== 'boolean') {
      return { ok: false, code: 'INVALID_AUDIT_BLOCK_ON_LOSS', message: 'auditBlockOnLoss must be a boolean' };
    }
    value.auditBlockOnLoss = raw;
  }
  const rawProvenance = input?.auditProvenanceBlock;
  if (rawProvenance !== undefined) {
    if (typeof rawProvenance !== 'boolean') {
      return { ok: false, code: 'INVALID_AUDIT_PROVENANCE_BLOCK', message: 'auditProvenanceBlock must be a boolean' };
    }
    value.auditProvenanceBlock = rawProvenance;
  }
  const rawExhaustionPolicy = input?.auditExhaustionPolicy;
  if (rawExhaustionPolicy !== undefined) {
    const normalized =
      typeof rawExhaustionPolicy === 'string'
        ? rawExhaustionPolicy.trim()
        : rawExhaustionPolicy;
    try {
      value.auditExhaustionPolicy = normalizeAuditExhaustionPolicy(normalized);
    } catch (error) {
      return { ok: false, code: 'INVALID_AUDIT_EXHAUSTION_POLICY', message: error.message };
    }
  }
  return { ok: true, value };
}

function referencePrefixSettingsOf(input) {
  const raw = input?.extraReferencePrefixes;
  if (raw === undefined) return { ok: true, value: {} };
  try {
    return { ok: true, value: { extraReferencePrefixes: [...normalizeExtraReferencePrefixes(raw)] } };
  } catch (error) {
    return { ok: false, code: 'INVALID_EXTRA_REFERENCE_PREFIXES', message: error.message };
  }
}

function speedSettingsOf(input) {
  const value = {};
  const rawConcurrency = input?.summaryConcurrency;
  if (rawConcurrency !== undefined) {
    const number =
      typeof rawConcurrency === 'string' && /^\d+$/.test(rawConcurrency.trim())
        ? Number(rawConcurrency.trim())
        : rawConcurrency;
    try {
      value.summaryConcurrency = normalizeSummaryConcurrency(number);
    } catch (error) {
      return { ok: false, code: 'INVALID_SUMMARY_CONCURRENCY', message: error.message };
    }
  }
  const rawEffort = input?.summaryReasoningEffort;
  if (rawEffort !== undefined) {
    const normalized = typeof rawEffort === 'string' ? rawEffort.trim() : rawEffort;
    try {
      value.summaryReasoningEffort = normalizeSummaryReasoningEffort(normalized);
    } catch (error) {
      return { ok: false, code: 'INVALID_SUMMARY_REASONING_EFFORT', message: error.message };
    }
  }
  const rawCjkWeight = input?.summaryCjkTokensPerChar;
  if (rawCjkWeight !== undefined && rawCjkWeight !== null && !(typeof rawCjkWeight === 'string' && rawCjkWeight.trim() === '')) {
    const number =
      typeof rawCjkWeight === 'number'
        ? rawCjkWeight
        : typeof rawCjkWeight === 'string'
          ? Number(rawCjkWeight.trim())
          : NaN;
    try {
      value.summaryCjkTokensPerChar = normalizeSummaryCjkTokensPerChar(number);
    } catch (error) {
      return { ok: false, code: 'INVALID_SUMMARY_CJK_TOKENS_PER_CHAR', message: error.message };
    }
  }
  return { ok: true, value };
}

function breakerSettingsOf(input) {
  const raw = input?.pressureBreakerAction;
  if (raw === undefined) return { ok: true, value: {} };
  const normalized = typeof raw === 'string' ? raw.trim() : raw;
  try {
    return { ok: true, value: { pressureBreakerAction: normalizePressureBreakerAction(normalized) } };
  } catch (error) {
    return { ok: false, code: 'INVALID_PRESSURE_BREAKER_ACTION', message: error.message };
  }
}

function hotBooleanSettingsOf(input) {
  const value = {};
  for (const [key, normalize, code] of HOT_BOOLEAN_TOGGLES) {
    const raw = input?.[key];
    if (raw === undefined) continue;
    try {
      value[key] = normalize(raw);
    } catch (error) {
      return { ok: false, code, message: error.message };
    }
  }
  return { ok: true, value };
}

function sessionMemorySettingsOf(input) {
  const raw = input?.sessionMemoryMaxCallsPerSession;
  if (raw === undefined) return { ok: true, value: {} };
  const number = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  try {
    return {
      ok: true,
      value: { sessionMemoryMaxCallsPerSession: normalizeSessionMemoryMaxCallsPerSession(number) },
    };
  } catch (error) {
    return {
      ok: false,
      code: 'INVALID_SESSION_MEMORY_MAX_CALLS_PER_SESSION',
      message: error.message,
    };
  }
}

function archiveWarnSettingsOf(input) {
  const raw = input?.archiveWarnBytes;
  if (raw === undefined) return { ok: true, value: {} };
  const number = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  try {
    return { ok: true, value: { archiveWarnBytes: normalizeArchiveWarnBytes(number) } };
  } catch (error) {
    return {
      ok: false,
      code: 'INVALID_ARCHIVE_WARN_BYTES',
      message: error.message,
    };
  }
}

function imageBudgetSettingsOf(input) {
  const value = {};
  if (input?.maxVisibleAttachmentBytes !== undefined) {
    const raw = input.maxVisibleAttachmentBytes;
    const number = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
    try {
      value.maxVisibleAttachmentBytes = normalizeMaxVisibleAttachmentBytes(number);
    } catch (error) {
      return {
        ok: false,
        code: 'INVALID_MAX_VISIBLE_ATTACHMENT_BYTES',
        message: error.message,
      };
    }
  }
  if (input?.maxVisibleImages !== undefined) {
    const raw = input.maxVisibleImages;
    const number = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
    try {
      value.maxVisibleImages = normalizeMaxVisibleImages(number);
    } catch (error) {
      return {
        ok: false,
        code: 'INVALID_MAX_VISIBLE_IMAGES',
        message: error.message,
      };
    }
  }
  return { ok: true, value };
}

/**
 * Validate a settings submission. Both ids empty = clear the model override
 * (follow the session model); one empty = reject rather than guess.
 * thresholdRatio, idleCompactionMinutes, auditBlockOnLoss, summaryConcurrency,
 * summaryReasoningEffort, pressureBreakerAction, postCompactReinjectEnabled,
 * persistedOutputEnabled, microcompactEnabled, snipEnabled, sessionMemoryEnabled,
 * sessionMemoryMaxCallsPerSession, and contextCollapseEnabled are independent of the model override.
 */
export function validateSummaryConfig(input) {
  const retry=retrySettingsOf(input);if(!retry.ok)return retry;
  const idle = idleSettingsOf(input);
  if (!idle.ok) return idle;
  const audit = auditSettingsOf(input);
  if (!audit.ok) return audit;
  const referencePrefixes = referencePrefixSettingsOf(input);
  if (!referencePrefixes.ok) return referencePrefixes;
  const speed = speedSettingsOf(input);
  if (!speed.ok) return speed;
  const breaker = breakerSettingsOf(input);
  if (!breaker.ok) return breaker;
  const hotBooleans = hotBooleanSettingsOf(input);
  if (!hotBooleans.ok) return hotBooleans;
  const sessionMemory = sessionMemorySettingsOf(input);
  if (!sessionMemory.ok) return sessionMemory;
  const archiveWarn = archiveWarnSettingsOf(input);
  if (!archiveWarn.ok) return archiveWarn;
  const imageBudget = imageBudgetSettingsOf(input);
  if (!imageBudget.ok) return imageBudget;
  const provider = textOf(input?.provider ?? input?.summarizationProvider);
  const model = textOf(input?.model ?? input?.summarizationModel);
  const maxTokens = maxTokensOf(input?.maxTokens);
  const thresholdRatio = thresholdRatioOf(input?.thresholdRatio);
  const minimumReductionRatio = minimumReductionRatioOf(input?.minimumReductionRatio);
  if (input?.minimumReductionRatio !== undefined && input?.minimumReductionRatio !== null && !(typeof input.minimumReductionRatio === 'string' && input.minimumReductionRatio.trim() === '') && minimumReductionRatio === null) return {ok:false,code:'INVALID_MINIMUM_REDUCTION_RATIO',message:'minimumReductionRatio must be a number between 0.05 and 0.9'};
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
    return { ok: true, value: { provider: '', model: '', maxTokens, thresholdRatio, ...retry.value, ...idle.value, ...audit.value, ...referencePrefixes.value, ...speed.value, ...breaker.value, ...hotBooleans.value, ...sessionMemory.value, ...archiveWarn.value, ...imageBudget.value, ...(minimumReductionRatio === null ? {} : {minimumReductionRatio}) } };
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
  return { ok: true, value: { provider, model, maxTokens, thresholdRatio, ...retry.value, ...idle.value, ...audit.value, ...referencePrefixes.value, ...speed.value, ...breaker.value, ...hotBooleans.value, ...sessionMemory.value, ...archiveWarn.value, ...imageBudget.value, ...(minimumReductionRatio === null ? {} : {minimumReductionRatio}) } };
}

/** Strict engine reads distinguish an absent override from a broken file.
 * The settings UI can still open a damaged file and replace it with a save. */
export function readSummaryConfig(file = defaultSummaryConfigPath(), {strict = false} = {}) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (strict && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      (parsed.version !== undefined && parsed.version !== CONFIG_VERSION))) throw new Error('Invalid settings document.');
    if (!parsed || typeof parsed !== 'object') return null;
    if (strict) {
      for (const key of ['summarizationProvider', 'summarizationModel']) {
        if (parsed[key] !== undefined && typeof parsed[key] !== 'string') throw new Error(`Invalid ${key}.`);
      }
      const verdict = validateSummaryConfig({...parsed, provider:parsed.summarizationProvider, model:parsed.summarizationModel});
      if (!verdict.ok) throw new Error(verdict.message);
    }
    const retry=retrySettingsOf(parsed);if(!retry.ok)return null;
    const idle = idleSettingsOf(parsed);
    if (!idle.ok) return null;
    const audit = auditSettingsOf(parsed);
    if (!audit.ok) return null;
    const referencePrefixes = referencePrefixSettingsOf(parsed);
    if (!referencePrefixes.ok) return null;
    const speed = speedSettingsOf(parsed);
    if (!speed.ok) return null;
    const breaker = breakerSettingsOf(parsed);
    if (!breaker.ok) return null;
    const hotBooleans = hotBooleanSettingsOf(parsed);
    if (!hotBooleans.ok) return null;
    const sessionMemory = sessionMemorySettingsOf(parsed);
    if (!sessionMemory.ok) return null;
    const archiveWarn = archiveWarnSettingsOf(parsed);
    if (!archiveWarn.ok) return null;
    const imageBudget = imageBudgetSettingsOf(parsed);
    if (!imageBudget.ok) return null;
    const provider = textOf(parsed.summarizationProvider);
    const model = textOf(parsed.summarizationModel);
    const thresholdRatio = thresholdRatioOf(parsed.thresholdRatio);
    const minimumReductionRatio = minimumReductionRatioOf(parsed.minimumReductionRatio);
    const maxTokens = maxTokensOf(parsed.maxTokens);
    // Trigger/retry/idle/audit/reference/speed/breaker/hot-boolean/session-memory settings are valid without a model override,
    // including idle=0, auditBlockOnLoss=false, or any hot boolean toggle set to false.
    if (
      !provider &&
      !model &&
      thresholdRatio === null &&
      minimumReductionRatio === null &&
      maxTokens === null &&
      Object.keys(retry.value).length === 0 &&
      idle.value.idleCompactionMinutes === undefined &&
      audit.value.auditBlockOnLoss === undefined &&
      audit.value.auditProvenanceBlock === undefined &&
      audit.value.auditExhaustionPolicy === undefined &&
      referencePrefixes.value.extraReferencePrefixes === undefined &&
      speed.value.summaryConcurrency === undefined &&
      speed.value.summaryReasoningEffort === undefined &&
      speed.value.summaryCjkTokensPerChar === undefined &&
      breaker.value.pressureBreakerAction === undefined &&
      Object.keys(hotBooleans.value).length === 0 &&
      sessionMemory.value.sessionMemoryMaxCallsPerSession === undefined &&
      archiveWarn.value.archiveWarnBytes === undefined &&
      imageBudget.value.maxVisibleAttachmentBytes === undefined &&
      imageBudget.value.maxVisibleImages === undefined
    ) return null;
    if ((provider === '') !== (model === '')) return null;
    if (provider && (provider.length > MAX_ID_LENGTH || !ID_RE.test(provider))) return null;
    if (model && (model.length > MAX_ID_LENGTH || !ID_RE.test(model))) return null;
    return { provider, model, maxTokens, thresholdRatio, ...retry.value, ...idle.value, ...audit.value, ...referencePrefixes.value, ...speed.value, ...breaker.value, ...hotBooleans.value, ...sessionMemory.value, ...archiveWarn.value, ...imageBudget.value, ...(minimumReductionRatio === null ? {} : {minimumReductionRatio}) };
  } catch (cause) {
    if (strict && cause?.code !== 'ENOENT') {
      const error = new SummaryConfigError('INVALID_SAVED_SETTINGS', 'Compaction settings could not be read safely. Open Summary model settings and save them again; the pending input is retained.');
      error.cause = cause;
      throw error;
    }
    return null;
  }
}

/** Write the override file. Invalid input must never reach this function. */
export function writeSummaryConfig(file, value) {
  const retry=retrySettingsOf(value);if(!retry.ok)throw new SummaryConfigError(retry.code,retry.message);
  const idle = idleSettingsOf(value);
  if (!idle.ok) throw new SummaryConfigError(idle.code, idle.message);
  const audit = auditSettingsOf(value);
  if (!audit.ok) throw new SummaryConfigError(audit.code, audit.message);
  const referencePrefixes = referencePrefixSettingsOf(value);
  if (!referencePrefixes.ok) throw new SummaryConfigError(referencePrefixes.code, referencePrefixes.message);
  const speed = speedSettingsOf(value);
  if (!speed.ok) throw new SummaryConfigError(speed.code, speed.message);
  const breaker = breakerSettingsOf(value);
  if (!breaker.ok) throw new SummaryConfigError(breaker.code, breaker.message);
  const hotBooleans = hotBooleanSettingsOf(value);
  if (!hotBooleans.ok) throw new SummaryConfigError(hotBooleans.code, hotBooleans.message);
  const sessionMemory = sessionMemorySettingsOf(value);
  if (!sessionMemory.ok) throw new SummaryConfigError(sessionMemory.code, sessionMemory.message);
  const archiveWarn = archiveWarnSettingsOf(value);
  if (!archiveWarn.ok) throw new SummaryConfigError(archiveWarn.code, archiveWarn.message);
  const imageBudget = imageBudgetSettingsOf(value);
  if (!imageBudget.ok) throw new SummaryConfigError(imageBudget.code, imageBudget.message);
  const provider = textOf(value?.provider);
  const model = textOf(value?.model);
  const maxTokens = maxTokensOf(value?.maxTokens);
  const thresholdRatio = thresholdRatioOf(value?.thresholdRatio);
  const minimumReductionRatio = minimumReductionRatioOf(value?.minimumReductionRatio);
  const payload = {
    version: CONFIG_VERSION,
    ...retry.value,
    ...idle.value,
    ...audit.value,
    ...referencePrefixes.value,
    ...speed.value,
    ...breaker.value,
    ...hotBooleans.value,
    ...sessionMemory.value,
    ...archiveWarn.value,
    ...imageBudget.value,
    updatedAt: new Date().toISOString(),
    ...(provider && model ? { summarizationProvider: provider, summarizationModel: model } : {}),
    ...(maxTokens === null ? {} : { maxTokens }),
    ...(thresholdRatio === null ? {} : { thresholdRatio }),
    ...(minimumReductionRatio === null ? {} : { minimumReductionRatio }),
  };
  const body = JSON.stringify(payload, null, 2) + '\n';
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, body, 'utf8');
  try {
    renameSync(temporary, file);
  } catch {
    // Windows can refuse rename-over-existing; a direct rewrite is still safe
    // for this small, single-writer file, and readSummaryConfig ignores junk.
    writeFileSync(file, body, 'utf8');
    try { unlinkSync(temporary); } catch { /* best effort */ }
  }
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
          .filter(model => model && typeof model.id === 'string' && model.id.length > 0)
          .map(model => ({ id: model.id, name: typeof model.name === 'string' && model.name ? model.name : model.id })),
      });
    }
    return { providers };
  }
  if (method === 'set') {
    const verdict = validateSummaryConfig(payload?.params ?? {});
    if (!verdict.ok) throw new SummaryConfigError(verdict.code, verdict.message);
    const value = verdict.value;
    // Older clients and model-only clears omit independent settings.
    // Keep them until the user explicitly replaces them.
    if (
      value.idleCompactionMinutes === undefined ||
      value.auditBlockOnLoss === undefined ||
      value.auditProvenanceBlock === undefined ||
      value.auditExhaustionPolicy === undefined ||
      value.extraReferencePrefixes === undefined ||
      value.summaryConcurrency === undefined ||
      value.summaryReasoningEffort === undefined ||
      value.summaryCjkTokensPerChar === undefined ||
      value.pressureBreakerAction === undefined ||
      value.sessionMemoryMaxCallsPerSession === undefined ||
      value.archiveWarnBytes === undefined ||
      value.maxVisibleAttachmentBytes === undefined ||
      value.maxVisibleImages === undefined ||
      HOT_BOOLEAN_TOGGLES.some(([key]) => value[key] === undefined)
    ) {
      const previous = readSummaryConfig(file);
      if (value.idleCompactionMinutes === undefined && previous?.idleCompactionMinutes !== undefined) {
        value.idleCompactionMinutes = previous.idleCompactionMinutes;
      }
      if (value.auditBlockOnLoss === undefined && previous?.auditBlockOnLoss !== undefined) {
        value.auditBlockOnLoss = previous.auditBlockOnLoss;
      }
      if (value.auditProvenanceBlock === undefined && previous?.auditProvenanceBlock !== undefined) {
        value.auditProvenanceBlock = previous.auditProvenanceBlock;
      }
      if (value.auditExhaustionPolicy === undefined && previous?.auditExhaustionPolicy !== undefined) {
        value.auditExhaustionPolicy = previous.auditExhaustionPolicy;
      }
      if (value.extraReferencePrefixes === undefined && previous?.extraReferencePrefixes !== undefined) {
        value.extraReferencePrefixes = previous.extraReferencePrefixes;
      }
      if (value.summaryConcurrency === undefined && previous?.summaryConcurrency !== undefined) {
        value.summaryConcurrency = previous.summaryConcurrency;
      }
      if (value.summaryReasoningEffort === undefined && previous?.summaryReasoningEffort !== undefined) {
        value.summaryReasoningEffort = previous.summaryReasoningEffort;
      }
      if (value.summaryCjkTokensPerChar === undefined && previous?.summaryCjkTokensPerChar !== undefined) {
        value.summaryCjkTokensPerChar = previous.summaryCjkTokensPerChar;
      }
      if (value.pressureBreakerAction === undefined && previous?.pressureBreakerAction !== undefined) {
        value.pressureBreakerAction = previous.pressureBreakerAction;
      }
      if (
        value.sessionMemoryMaxCallsPerSession === undefined &&
        previous?.sessionMemoryMaxCallsPerSession !== undefined
      ) {
        value.sessionMemoryMaxCallsPerSession = previous.sessionMemoryMaxCallsPerSession;
      }
      if (value.archiveWarnBytes === undefined && previous?.archiveWarnBytes !== undefined) {
        value.archiveWarnBytes = previous.archiveWarnBytes;
      }
      if (value.maxVisibleAttachmentBytes === undefined && previous?.maxVisibleAttachmentBytes !== undefined) {
        value.maxVisibleAttachmentBytes = previous.maxVisibleAttachmentBytes;
      }
      if (value.maxVisibleImages === undefined && previous?.maxVisibleImages !== undefined) {
        value.maxVisibleImages = previous.maxVisibleImages;
      }
      for (const [key] of HOT_BOOLEAN_TOGGLES) {
        if (value[key] === undefined && previous?.[key] !== undefined) {
          value[key] = previous[key];
        }
      }
    }
    if (!value.provider && !value.model) {
      writeSummaryConfig(file, value);
      const cleared =
        value.maxTokens === null &&
        value.thresholdRatio === null &&
        value.minimumReductionRatio === undefined &&
        value.idleCompactionMinutes === undefined &&
        value.auditBlockOnLoss === undefined &&
        value.auditProvenanceBlock === undefined &&
        value.auditExhaustionPolicy === undefined &&
        value.extraReferencePrefixes === undefined &&
        value.summaryConcurrency === undefined &&
        value.summaryReasoningEffort === undefined &&
        value.summaryCjkTokensPerChar === undefined &&
        value.pressureBreakerAction === undefined &&
        value.sessionMemoryMaxCallsPerSession === undefined &&
        value.archiveWarnBytes === undefined &&
        value.maxVisibleAttachmentBytes === undefined &&
        value.maxVisibleImages === undefined &&
        HOT_BOOLEAN_TOGGLES.every(([key]) => value[key] === undefined) &&
        Object.keys(SUMMARY_RETRY_SETTINGS).every(key=>value[key]===undefined);
      return {
        config: cleared ? null : value,
        cleared,
        restartRequired: false,
      };
    }
    writeSummaryConfig(file, value);
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
      ...(previous.minimumReductionRatio !== undefined ? { minimumReductionRatio: previous.minimumReductionRatio } : {}),
      ...(previous.summaryRetryCount !== undefined ? { summaryRetryCount: previous.summaryRetryCount } : {}),
      ...(previous.summaryRetryDelayMs !== undefined ? { summaryRetryDelayMs: previous.summaryRetryDelayMs } : {}),
      ...(previous.summaryTimeoutMs !== undefined ? { summaryTimeoutMs: previous.summaryTimeoutMs } : {}),
      ...(previous.idleCompactionMinutes !== undefined ? { idleCompactionMinutes: previous.idleCompactionMinutes } : {}),
      ...(previous.auditBlockOnLoss !== undefined ? { auditBlockOnLoss: previous.auditBlockOnLoss } : {}),
      ...(previous.auditProvenanceBlock !== undefined ? { auditProvenanceBlock: previous.auditProvenanceBlock } : {}),
      ...(previous.auditExhaustionPolicy !== undefined ? { auditExhaustionPolicy: previous.auditExhaustionPolicy } : {}),
      ...(previous.extraReferencePrefixes !== undefined ? { extraReferencePrefixes: previous.extraReferencePrefixes } : {}),
      ...(previous.summaryConcurrency !== undefined ? { summaryConcurrency: previous.summaryConcurrency } : {}),
      ...(previous.summaryReasoningEffort !== undefined ? { summaryReasoningEffort: previous.summaryReasoningEffort } : {}),
      ...(previous.summaryCjkTokensPerChar !== undefined ? { summaryCjkTokensPerChar: previous.summaryCjkTokensPerChar } : {}),
      ...(previous.pressureBreakerAction !== undefined ? { pressureBreakerAction: previous.pressureBreakerAction } : {}),
      ...(previous.sessionMemoryMaxCallsPerSession !== undefined
        ? { sessionMemoryMaxCallsPerSession: previous.sessionMemoryMaxCallsPerSession }
        : {}),
      ...(previous.archiveWarnBytes !== undefined ? { archiveWarnBytes: previous.archiveWarnBytes } : {}),
      ...(previous.maxVisibleAttachmentBytes !== undefined
        ? { maxVisibleAttachmentBytes: previous.maxVisibleAttachmentBytes }
        : {}),
      ...(previous.maxVisibleImages !== undefined ? { maxVisibleImages: previous.maxVisibleImages } : {}),
    };
    for (const [key] of HOT_BOOLEAN_TOGGLES) {
      if (previous[key] !== undefined) clearedValue[key] = previous[key];
    }
    writeSummaryConfig(file, clearedValue);
    const cleared =
      clearedValue.maxTokens === null &&
      clearedValue.thresholdRatio === null &&
      clearedValue.minimumReductionRatio === undefined &&
      clearedValue.idleCompactionMinutes === undefined &&
      clearedValue.auditBlockOnLoss === undefined &&
      clearedValue.auditProvenanceBlock === undefined &&
      clearedValue.auditExhaustionPolicy === undefined &&
      clearedValue.extraReferencePrefixes === undefined &&
      clearedValue.summaryConcurrency === undefined &&
      clearedValue.summaryReasoningEffort === undefined &&
      clearedValue.summaryCjkTokensPerChar === undefined &&
      clearedValue.pressureBreakerAction === undefined &&
      clearedValue.sessionMemoryMaxCallsPerSession === undefined &&
      clearedValue.archiveWarnBytes === undefined &&
      clearedValue.maxVisibleAttachmentBytes === undefined &&
      clearedValue.maxVisibleImages === undefined &&
      HOT_BOOLEAN_TOGGLES.every(([key]) => clearedValue[key] === undefined) &&
      Object.keys(SUMMARY_RETRY_SETTINGS).every(key => clearedValue[key] === undefined);
    return {
      config: cleared ? null : clearedValue,
      cleared,
      restartRequired: false,
    };
  }
  throw new SummaryConfigError('UNKNOWN_METHOD', `unknown settings method: ${method || '(empty)'}`);
}
