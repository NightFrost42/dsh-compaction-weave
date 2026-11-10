// Summary-model configuration for dsh-compaction-weave.
//
// The value is deliberately kept OUT of cordis.patch.yml / the profile manifest:
// the plugin owns a small JSON file under its storage root, the Settings page
// writes it through the host RPC below, and the gate merges it into the engine
// config at startup. This survives bundle updates and never rewrites shared
// profile configuration.
//
// File: <DSH_HOME>/storages/dsh-compaction-weave/summary-config.json
// Shape: { version: 1, summarizationProvider, summarizationModel, maxTokens, thresholdRatio, updatedAt }
//
// thresholdRatio is the auto-compaction trigger line as a fraction of the model
// window (0.5–0.95). It is stored here as well so the Settings page can tune it
// without touching the engine config; null/absent means "use the engine default
// (0.8)".

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const CONFIG_VERSION = 1;
export const MAX_BODY_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 200;
const MAX_TOKENS_LIMIT = 1_000_000;
export const MIN_THRESHOLD_RATIO = 0.5;
export const MAX_THRESHOLD_RATIO = 0.95;
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

/**
 * Validate a settings submission. Both ids empty = clear the model override
 * (follow the session model); one empty = reject rather than guess.
 * thresholdRatio may be set independently of the model override.
 */
export function validateSummaryConfig(input) {
  const retry=retrySettingsOf(input);if(!retry.ok)return retry;
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
    return { ok: true, value: { provider: '', model: '', maxTokens, thresholdRatio, ...retry.value, ...(minimumReductionRatio === null ? {} : {minimumReductionRatio}) } };
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
  return { ok: true, value: { provider, model, maxTokens, thresholdRatio, ...retry.value, ...(minimumReductionRatio === null ? {} : {minimumReductionRatio}) } };
}

/** Read the override file. Missing or unreadable files mean "no override". */
export function readSummaryConfig(file = defaultSummaryConfigPath()) {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const retry=retrySettingsOf(parsed);if(!retry.ok)return null;
    const provider = textOf(parsed.summarizationProvider);
    const model = textOf(parsed.summarizationModel);
    const thresholdRatio = thresholdRatioOf(parsed.thresholdRatio);
    const minimumReductionRatio = minimumReductionRatioOf(parsed.minimumReductionRatio);
    const maxTokens = maxTokensOf(parsed.maxTokens);
    // A file that only carries thresholdRatio (no model override) is valid:
    // the user may want to tune the trigger line and still follow the session model.
    if (!provider && !model && thresholdRatio === null && minimumReductionRatio === null && maxTokens === null && Object.keys(retry.value).length===0) return null;
    if ((provider === '') !== (model === '')) return null;
    if (provider && (provider.length > MAX_ID_LENGTH || !ID_RE.test(provider))) return null;
    if (model && (model.length > MAX_ID_LENGTH || !ID_RE.test(model))) return null;
    return { provider, model, maxTokens, thresholdRatio, ...retry.value, ...(minimumReductionRatio === null ? {} : {minimumReductionRatio}) };
  } catch {
    return null;
  }
}

/** Write the override file. Invalid input must never reach this function. */
export function writeSummaryConfig(file, value) {
  const retry=retrySettingsOf(value);if(!retry.ok)throw new SummaryConfigError(retry.code,retry.message);
  const provider = textOf(value?.provider);
  const model = textOf(value?.model);
  const maxTokens = maxTokensOf(value?.maxTokens);
  const thresholdRatio = thresholdRatioOf(value?.thresholdRatio);
  const minimumReductionRatio = minimumReductionRatioOf(value?.minimumReductionRatio);
  const payload = {
    version: CONFIG_VERSION,
    ...retry.value,
    updatedAt: new Date().toISOString(),
    ...(provider && model ? { summarizationProvider: provider, summarizationModel: model } : {}),
    ...(maxTokens === null ? {} : { maxTokens }),
    ...(thresholdRatio === null ? {} : { thresholdRatio }),
    ...(minimumReductionRatio === null ? {} : { minimumReductionRatio }),
  };
  const body = JSON.stringify(payload, null, 2) + '\n';
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
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
    if (!value.provider && !value.model) {
      writeSummaryConfig(file, value);
      const cleared = value.maxTokens === null && value.thresholdRatio === null && value.minimumReductionRatio === undefined && Object.keys(SUMMARY_RETRY_SETTINGS).every(key=>value[key]===undefined);
      return {
        config: cleared ? null : value,
        cleared,
        restartRequired: true,
      };
    }
    writeSummaryConfig(file, value);
    return { config: value, cleared: false, restartRequired: true };
  }
  throw new SummaryConfigError('UNKNOWN_METHOD', `unknown settings method: ${method || '(empty)'}`);
}
