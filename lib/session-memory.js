// Opt-in, billing-bounded background session memory store and manager.
// Zero circular dependencies: never imports engine.js, never mutates session
// surface or compaction lifecycle/breaker state.

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { atomicReplaceSync } from './atomic-replace.js';
import { auditInstructionProvenance, summarizeProvenanceFailures } from './audit.js';
import { selectCachePreservingRange } from './cache-policy.js';
import { DEFAULT_CONFIG, resolveCompactSpec } from './config.js';
import { auditMemorySelection, collectReferenceMessages } from './constraint-scope.js';
import { readPendingContinuation } from './continuation-pending.js';
import { isUserInput } from './idle-compaction.js';
import { deduplicateNotes, memoryPolicyInstruction, retiredMemoryPresent } from './memory-policy.js';
import { approxTokens, blocksToText } from './meter.js';
import { validateProgressFacts } from './progress-facts.js';
import { CHECKPOINT_PREAMBLE } from './prompt.js';
import { reconstructDisputedLines } from './reconstruct.js';
import {
  buildCheckpointBlocks,
  buildSummarizationInput,
  selectCompactableRange,
  selectSessionMemory,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from './region.js';
import { isExternalFoldEvent, sourceKindOf, withReferencePolicy } from './source-provenance.js';
import { readResumableCompaction } from './state.js';
import {
  capacityLimit,
  DEFAULT_MAX_CHUNK_TOOL_SOURCE_REFS,
  measureSummaryRange,
  planSummaryRange,
  resolveSummaryCapacity,
} from './summary-budget.js';
import { latestDurableTarget, resolveSummaryTargets, summarizeWithChain } from './summary.js';
import {
  materializeUserMessageSection,
  validateCheckpointCoverage,
  validateSummaryStructure,
  validateUserMessageSection,
} from './validate.js';

const SESSION_MEMORY_KIND = 'compaction-weave/session-memory';
const SESSION_MEMORY_VERSION = 1;
const MAX_SESSION_MEMORY_BYTES = 4 * 1024 * 1024;
const STALE_UNPARSEABLE_LOCK_MS = 5000;
const SHA256_RE = /^[a-f0-9]{64}$/;

export const DEFAULT_SESSION_MEMORY_MIN_TOKENS = 24576;
export const DEFAULT_SESSION_MEMORY_UPDATE_INTERVAL_TOKENS = 16384;
export const DEFAULT_SESSION_MEMORY_UPDATE_INTERVAL_TURNS = 4;
export const DEFAULT_SESSION_MEMORY_COOLDOWN_MS = 60000;
export const DEFAULT_SESSION_MEMORY_MAX_BYTES = 12288;
export const DEFAULT_SESSION_MEMORY_MAX_CALLS_PER_SESSION = 8;

const DEFAULT_BG_MAX_TOKENS = 4096;

const digest = (value) => createHash('sha256').update(value).digest('hex');
const isPlainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

function makeError(code, message, extra = undefined) {
  return Object.assign(new Error(message), { code, ...(extra ?? {}) });
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
    return 'locked';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'unlink';
    return 'locked';
  }
}

/**
 * Validate a persisted or candidate session memory payload, enforcing exact
 * `coveredThroughSeq` watermark alignment with `coveredSeqs.at(-1)` and `range.end`.
 * @param {unknown} memory
 * @returns {boolean}
 */
export function validateMemoryPayload(memory) {
  if (!isPlainObject(memory)) return false;
  if (typeof memory.sourceHash !== 'string' || !SHA256_RE.test(memory.sourceHash)) return false;
  if (typeof memory.policyFingerprint !== 'string' || !SHA256_RE.test(memory.policyFingerprint)) return false;
  if (
    !Array.isArray(memory.coveredSeqs) ||
    memory.coveredSeqs.length === 0 ||
    memory.coveredSeqs.some((s) => !Number.isSafeInteger(s) || s < 0) ||
    new Set(memory.coveredSeqs).size !== memory.coveredSeqs.length
  ) {
    return false;
  }
  if (!Number.isSafeInteger(memory.coveredThroughSeq) || memory.coveredThroughSeq < 0) return false;
  if (memory.coveredThroughSeq !== memory.coveredSeqs.at(-1)) return false;
  if (typeof memory.rawText !== 'string' || memory.rawText.trim().length === 0) return false;
  if (memory.range !== undefined) {
    if (
      !isPlainObject(memory.range) ||
      !Number.isSafeInteger(memory.range.start) ||
      !Number.isSafeInteger(memory.range.end) ||
      memory.range.start !== memory.coveredSeqs[0] ||
      memory.range.end !== memory.coveredSeqs.at(-1) ||
      memory.range.end !== memory.coveredThroughSeq
    ) {
      return false;
    }
  }
  if (memory.language !== undefined && memory.language !== 'zh' && memory.language !== 'en') return false;
  if (memory.provider !== undefined && memory.provider !== null && typeof memory.provider !== 'string') return false;
  if (memory.model !== undefined && memory.model !== null && typeof memory.model !== 'string') return false;
  if (memory.usage !== undefined && memory.usage !== null && !isPlainObject(memory.usage)) return false;
  if (
    memory.tokens !== undefined &&
    (typeof memory.tokens !== 'number' || !Number.isFinite(memory.tokens) || memory.tokens < 0)
  ) {
    return false;
  }
  if (memory.updatedAt !== undefined && (typeof memory.updatedAt !== 'string' || memory.updatedAt.trim().length === 0)) {
    return false;
  }
  return true;
}

function mergePolicy(baseConfig, overridePolicy) {
  const merged = { ...DEFAULT_CONFIG };
  if (isPlainObject(baseConfig)) {
    for (const [k, v] of Object.entries(baseConfig)) {
      if (v !== undefined) merged[k] = v;
    }
  }
  if (isPlainObject(overridePolicy)) {
    for (const [k, v] of Object.entries(overridePolicy)) {
      if (v !== undefined) merged[k] = v;
    }
    if (overridePolicy.retainTokens !== undefined && overridePolicy.retainRatio === undefined) {
      merged.retainRatio = DEFAULT_CONFIG.retainRatio;
    } else if (overridePolicy.retainRatio !== undefined && overridePolicy.retainTokens === undefined) {
      merged.retainTokens = null;
    }
  }
  return merged;
}

function resolveMaxCalls(policy) {
  return Number.isSafeInteger(policy?.sessionMemoryMaxCallsPerSession) && policy.sessionMemoryMaxCallsPerSession >= 0
    ? policy.sessionMemoryMaxCallsPerSession
    : DEFAULT_SESSION_MEMORY_MAX_CALLS_PER_SESSION;
}

function resolveMaxBytes(policy) {
  return Number.isSafeInteger(policy?.sessionMemoryMaxBytes) && policy.sessionMemoryMaxBytes > 0
    ? policy.sessionMemoryMaxBytes
    : DEFAULT_SESSION_MEMORY_MAX_BYTES;
}

function resolveRetainTokens(engine, session, agent, measurement, policy) {
  if (typeof policy.retainTokens === 'number' && Number.isFinite(policy.retainTokens) && policy.retainTokens >= 0) {
    return policy.retainTokens;
  }
  let persistedWindow = null;
  try {
    if (engine?.sessionState && typeof engine.sessionState.read === 'function' && session?.id) {
      const state = engine.sessionState.read(session.id);
      if (typeof state?.window?.safetyWindow === 'number' && Number.isFinite(state.window.safetyWindow)) {
        persistedWindow = state.window.safetyWindow;
      }
    }
  } catch {
    /* read-only fallback */
  }
  const durable = latestDurableTarget(agent);
  const provider = durable?.provider ?? agent?.options?.provider;
  const model = durable?.model ?? agent?.options?.model;
  const mappedWindow = provider && model ? policy.windowProviderMap?.[`${provider}/${model}`] : undefined;
  const fallbackWindow = Math.max(
    policy.windowClampMin ?? DEFAULT_CONFIG.windowClampMin,
    policy.windowFallback ?? DEFAULT_CONFIG.windowFallback,
  );
  const window = persistedWindow ?? mappedWindow ?? fallbackWindow;
  const headerMax = typeof session?.requestHeader === 'function' ? session.requestHeader()?.config?.maxTokens : undefined;
  const reserved = typeof headerMax === 'number' && Number.isFinite(headerMax) && headerMax >= 0 ? headerMax : 0;
  try {
    return resolveCompactSpec(policy, window, reserved).retainTokens;
  } catch {
    return Math.max(0, Math.floor((measurement?.totalTokens ?? 0) * (policy.retainRatio ?? DEFAULT_CONFIG.retainRatio)));
  }
}

/**
 * Durable per-session store for background session memory and monotonic per-session
 * billing counters (`callsUsed`). Verifies SHA-256 checksums and fails closed on corruption.
 */
export class SessionMemoryStore {
  /** @param {string} root */
  constructor(root) {
    if (typeof root !== 'string' || !root.trim()) {
      throw makeError('SESSION_MEMORY_INVALID', 'SessionMemoryStore requires a root directory.');
    }
    this.root = resolve(root);
  }

  /** @param {string} sessionId */
  file(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) {
      throw makeError('SESSION_MEMORY_INVALID', 'session memory requires a non-empty session id');
    }
    return join(this.root, `${digest(sessionId)}.json`);
  }

  /**
   * Read and verify the stored session memory record for `sessionId`.
   * Returns `null` if absent (`ENOENT`), and throws fail-closed (`SESSION_MEMORY_CORRUPT`)
   * if unreadable, malformed, or checksum/identity/watermark verification fails.
   * @param {string} sessionId
   * @returns {{ callsUsed: number, memory: object|null } | null}
   */
  read(sessionId) {
    const file = this.file(sessionId);
    let record;
    try {
      const stat = statSync(file);
      if (stat.size > MAX_SESSION_MEMORY_BYTES) {
        throw makeError('SESSION_MEMORY_CORRUPT', 'session memory record exceeds storage bound');
      }
      record = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error?.code === 'SESSION_MEMORY_CORRUPT') throw error;
      throw makeError('SESSION_MEMORY_CORRUPT', `session memory unreadable: ${error?.message ?? error}`);
    }
    if (!isPlainObject(record)) {
      throw makeError('SESSION_MEMORY_CORRUPT', 'session memory record must be an object');
    }
    const { kind, version, sessionId: storedId, data, checksum } = record;
    if (
      kind !== SESSION_MEMORY_KIND ||
      version !== SESSION_MEMORY_VERSION ||
      storedId !== sessionId ||
      !isPlainObject(data) ||
      typeof checksum !== 'string' ||
      checksum !== digest(JSON.stringify({ kind, version, sessionId: storedId, data }))
    ) {
      throw makeError('SESSION_MEMORY_CORRUPT', 'session memory identity or checksum mismatch');
    }
    if (!Number.isSafeInteger(data.callsUsed) || data.callsUsed < 0) {
      throw makeError('SESSION_MEMORY_CORRUPT', 'session memory has invalid callsUsed counter');
    }
    const totalCallsUsed = data.totalCallsUsed === undefined ? data.callsUsed : data.totalCallsUsed;
    if (!Number.isSafeInteger(totalCallsUsed) || totalCallsUsed < data.callsUsed) {
      throw makeError('SESSION_MEMORY_CORRUPT', 'session memory has invalid totalCallsUsed counter');
    }
    if (data.memory !== null && !validateMemoryPayload(data.memory)) {
      throw makeError('SESSION_MEMORY_CORRUPT', 'session memory payload failed schema validation');
    }
    return {
      callsUsed: data.callsUsed,
      totalCallsUsed,
      memory: data.memory === null ? null : JSON.parse(JSON.stringify(data.memory)),
    };
  }

  _withLock(sessionId, fn) {
    mkdirSync(this.root, { recursive: true });
    const file = this.file(sessionId);
    const lock = `${file}.lock`;
    let lockFd;
    const makeLockedError = (cause) =>
      makeError('SESSION_MEMORY_LOCKED', `session memory store is locked: ${lock}`, { cause });
    try {
      try {
        lockFd = openSync(lock, 'wx', 0o600);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const action = inspectStaleLockAction(lock);
        if (action === 'locked') throw makeLockedError(error);
        if (action === 'unlink') {
          try {
            unlinkSync(lock);
          } catch (unlinkError) {
            if (unlinkError?.code !== 'ENOENT') throw makeLockedError(error);
          }
        }
        try {
          lockFd = openSync(lock, 'wx', 0o600);
        } catch (retryError) {
          if (retryError?.code === 'EEXIST') throw makeLockedError(retryError);
          throw retryError;
        }
      }
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return fn(file);
    } finally {
      if (lockFd !== undefined) {
        try {
          closeSync(lockFd);
        } catch {}
        try {
          unlinkSync(lock);
        } catch {}
      }
    }
  }

  _writeAtomic(file, sessionId, callsUsed, memory, options = {}) {
    if (!Number.isSafeInteger(callsUsed) || callsUsed < 0) {
      throw makeError('SESSION_MEMORY_INVALID', 'callsUsed must be a non-negative safe integer');
    }
    if (memory !== null && !validateMemoryPayload(memory)) {
      throw makeError('SESSION_MEMORY_INVALID', 'session memory payload is invalid');
    }
    let snapshotMemory = null;
    if (memory !== null) {
      try {
        snapshotMemory = JSON.parse(JSON.stringify(memory));
      } catch {
        throw makeError('SESSION_MEMORY_INVALID', 'session memory payload is not JSON-serializable');
      }
      if (!validateMemoryPayload(snapshotMemory)) {
        throw makeError('SESSION_MEMORY_INVALID', 'session memory payload is invalid after serialization');
      }
      const maxBytes = options?.maxBytes;
      if (Number.isSafeInteger(maxBytes) && maxBytes > 0) {
        const entryBytes = Buffer.byteLength(JSON.stringify(snapshotMemory), 'utf8');
        if (entryBytes > maxBytes) {
          throw makeError(
            'SESSION_MEMORY_TOO_LARGE',
            `session memory payload (${entryBytes} bytes) exceeds sessionMemoryMaxBytes (${maxBytes})`,
            { bytes: entryBytes, maxBytes },
          );
        }
      }
    }
    const totalCallsUsed = options?.totalCallsUsed === undefined ? callsUsed : options.totalCallsUsed;
    if (!Number.isSafeInteger(totalCallsUsed) || totalCallsUsed < callsUsed) {
      throw makeError('SESSION_MEMORY_INVALID', 'totalCallsUsed must be a safe integer >= callsUsed');
    }
    const data = { callsUsed, totalCallsUsed, memory: snapshotMemory };
    const payload = {
      kind: SESSION_MEMORY_KIND,
      version: SESSION_MEMORY_VERSION,
      sessionId,
      data,
    };
    const record = { ...payload, checksum: digest(JSON.stringify(payload)) };
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SESSION_MEMORY_BYTES) {
      throw makeError('SESSION_MEMORY_INVALID', 'session memory record exceeds storage bound');
    }
    const temp = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, serialized);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      atomicReplaceSync(temp, file);
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {}
      }
      try {
        unlinkSync(temp);
      } catch {}
    }
    return { callsUsed, totalCallsUsed, memory: snapshotMemory };
  }

  /**
   * Atomically increment per-cycle `callsUsed` and monotonic `totalCallsUsed`
   * (enforcing `maxCalls` against `callsUsed`) and optionally persist a new `memory` payload.
   * @param {string} sessionId
   * @param {((current:{callsUsed:number,nextCallsUsed:number,totalCallsUsed:number,nextTotalCallsUsed:number,memory:object|null})=>any)|{maxCalls?:number,memory?:object|null}} [updater]
   * @param {{ maxCalls?: number, maxBytes?: number }} [options]
   */
  recordAttempt(sessionId, updater = undefined, options = {}) {
    return this._withLock(sessionId, (file) => {
      const current = this.read(sessionId) ?? { callsUsed: 0, totalCallsUsed: 0, memory: null };
      const optionMax = isPlainObject(updater) && updater.maxCalls !== undefined ? updater.maxCalls : options?.maxCalls;
      if (Number.isSafeInteger(optionMax) && optionMax >= 0 && current.callsUsed >= optionMax) {
        throw makeError(
          'SESSION_MEMORY_MAX_CALLS',
          `session memory max calls (${optionMax}) reached for session`,
          { callsUsed: current.callsUsed, maxCalls: optionMax },
        );
      }
      const nextCalls = current.callsUsed + 1;
      const baseTotal = Math.max(current.totalCallsUsed ?? current.callsUsed, current.callsUsed);
      const nextTotalCalls = baseTotal + 1;
      let nextMemory = current.memory;
      if (typeof updater === 'function') {
        const res = updater({
          callsUsed: current.callsUsed,
          nextCallsUsed: nextCalls,
          totalCallsUsed: baseTotal,
          nextTotalCallsUsed: nextTotalCalls,
          memory: current.memory ? JSON.parse(JSON.stringify(current.memory)) : null,
        });
        if (isPlainObject(res)) {
          if (Number.isSafeInteger(res.maxCalls) && res.maxCalls >= 0 && current.callsUsed >= res.maxCalls) {
            throw makeError(
              'SESSION_MEMORY_MAX_CALLS',
              `session memory max calls (${res.maxCalls}) reached for session`,
              { callsUsed: current.callsUsed, maxCalls: res.maxCalls },
            );
          }
          if ('memory' in res && res.memory !== undefined) {
            nextMemory = res.memory;
          } else if ('sourceHash' in res && 'rawText' in res) {
            nextMemory = res;
          }
        }
      } else if (isPlainObject(updater) && 'memory' in updater && updater.memory !== undefined) {
        nextMemory = updater.memory;
      }
      return this._writeAtomic(file, sessionId, nextCalls, nextMemory, { ...options, totalCallsUsed: nextTotalCalls });
    });
  }

  /**
   * Atomically update stored `memory` without incrementing `callsUsed`.
   * @param {string} sessionId
   * @param {object|null} memory
   * @param {{ maxBytes?: number }} [options]
   */
  saveMemory(sessionId, memory, options = {}) {
    return this._withLock(sessionId, (file) => {
      const current = this.read(sessionId) ?? { callsUsed: 0, totalCallsUsed: 0, memory: null };
      const totalCallsUsed = Math.max(current.totalCallsUsed ?? current.callsUsed, current.callsUsed);
      return this._writeAtomic(file, sessionId, current.callsUsed, memory, { ...options, totalCallsUsed });
    });
  }

  /**
   * Clear stored `memory` while preserving `callsUsed` by default so deleting cached
   * memory cannot reset the per-cycle billing fuse unless `resetCycle: true` (after a
   * committed compaction checkpoint) or explicit `keepBillingCounter: false` is passed.
   * @param {string} sessionId
   * @param {{ keepBillingCounter?: boolean, resetCycle?: boolean }} [options]
   */
  clear(sessionId, { keepBillingCounter = true, resetCycle = false } = {}) {
    return this._withLock(sessionId, (file) => {
      const current = this.read(sessionId);
      if (current === null) return false;
      const currentTotal = Math.max(current.totalCallsUsed ?? current.callsUsed, current.callsUsed);
      if (resetCycle === true) {
        this._writeAtomic(file, sessionId, 0, null, { totalCallsUsed: currentTotal });
        return true;
      }
      if (keepBillingCounter === false) {
        this._writeAtomic(file, sessionId, 0, null, { totalCallsUsed: 0 });
        return true;
      }
      this._writeAtomic(file, sessionId, current.callsUsed, null, { totalCallsUsed: currentTotal });
      return true;
    });
  }

  /** Reset current-cycle `callsUsed` to 0 after a committed compaction while keeping monotonic `totalCallsUsed`. */
  resetCycle(sessionId) {
    return this.clear(sessionId, { resetCycle: true });
  }

  /** Explicitly remove all persisted session memory records and billing counters under `this.root`. */
  resetAll() {
    if (!existsSync(this.root)) return 0;
    let removed = 0;
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith('.json') && !name.endsWith('.tmp') && !name.endsWith('.lock')) continue;
      try {
        unlinkSync(join(this.root, name));
        if (name.endsWith('.json')) removed += 1;
      } catch {}
    }
    return removed;
  }
}

/**
 * Compute a deterministic SHA-256 digest over `(seq, event.type, derivedMessage)` for `seqs`.
 * @param {object} session
 * @param {readonly number[]} seqs
 * @returns {string|null}
 */
export function computeSessionMemorySourceHash(session, seqs) {
  if (!session || !Array.isArray(seqs)) return null;
  const payload = seqs.map((seq) => {
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
    const message =
      event && typeof session.deriveEventMessage === 'function'
        ? (session.deriveEventMessage(event) ?? null)
        : null;
    return [seq, event?.type ?? null, message];
  });
  return digest(JSON.stringify(payload));
}

/**
 * Compute a deterministic SHA-256 fingerprint over the summary/memory-relevant policy fields.
 * @param {Record<string, unknown>|undefined} policy
 * @returns {string}
 */
export function computeSessionMemoryPolicyFingerprint(policy) {
  const p = isPlainObject(policy) ? policy : {};
  const extraKinds = Array.isArray(p.extraReferenceSourceKinds)
    ? [...new Set(p.extraReferenceSourceKinds.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))].sort()
    : [];
  const extraPrefixes = Array.isArray(p.extraReferencePrefixes)
    ? [...new Set(p.extraReferencePrefixes.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))].sort()
    : [];
  const canonical = {
    language: p.language ?? DEFAULT_CONFIG.language,
    retainRatio: p.retainRatio ?? DEFAULT_CONFIG.retainRatio,
    retainTokens: p.retainTokens ?? DEFAULT_CONFIG.retainTokens,
    preserveRecentMessages: p.preserveRecentMessages ?? DEFAULT_CONFIG.preserveRecentMessages,
    preserveRecentUserTokens: p.preserveRecentUserTokens ?? DEFAULT_CONFIG.preserveRecentUserTokens,
    auditEnabled: p.auditEnabled ?? DEFAULT_CONFIG.auditEnabled,
    auditCoverageThreshold: p.auditCoverageThreshold ?? DEFAULT_CONFIG.auditCoverageThreshold,
    auditBlockOnLoss: p.auditBlockOnLoss ?? DEFAULT_CONFIG.auditBlockOnLoss,
    auditProvenanceBlock: p.auditProvenanceBlock ?? DEFAULT_CONFIG.auditProvenanceBlock,
    archiveEnabled: p.archiveEnabled ?? DEFAULT_CONFIG.archiveEnabled,
    summarizationProvider: p.summarizationProvider ?? DEFAULT_CONFIG.summarizationProvider,
    summarizationModel: p.summarizationModel ?? DEFAULT_CONFIG.summarizationModel,
    maxTokens: p.maxTokens ?? DEFAULT_CONFIG.maxTokens,
    extraReferenceSourceKinds: extraKinds,
    extraReferencePrefixes: extraPrefixes,
  };
  return digest(JSON.stringify(canonical));
}

/**
 * Count authentic user conversation turns across `seqs` using `isUserInput`
 * (ignoring assistant/tool/system messages, checkpoints, external folds,
 * system-reminders, bare reference prefixes, built-in bridges like `wechat`/`qq`,
 * and any active `extraReferenceSourceKinds`/`extraReferencePrefixes`).
 *
 * @param {object} session
 * @param {readonly number[]} seqs
 * @param {{ extraReferenceSourceKinds?: readonly string[], extraReferencePrefixes?: readonly string[] }} [options]
 * @returns {number}
 */
export function countConversationTurns(session, seqs, options = undefined) {
  if (!session || typeof session.eventAt !== 'function' || !Array.isArray(seqs) || seqs.length === 0) {
    return 0;
  }
  const run = () => {
    let turns = 0;
    for (const seq of seqs) {
      if (!Number.isSafeInteger(seq) || seq < 0) continue;
      const event = session.eventAt(seq);
      if (!event || event.type !== 'user/message') continue;
      if (isExternalFoldEvent(event, session)) continue;
      const derived =
        typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : event.data;
      const source = event.data?.source ?? derived?.source;
      const message =
        derived && typeof derived === 'object'
          ? (source ? { ...derived, source } : derived)
          : event.data;
      if (isUserInput(message)) {
        turns += 1;
      }
    }
    return turns;
  };
  if (
    options &&
    (options.extraReferenceSourceKinds !== undefined || options.extraReferencePrefixes !== undefined)
  ) {
    return withReferencePolicy(options, run);
  }
  return run();
}

/**
 * Validate whether stored session memory applies to `candidateSeqs` (either an exact match
 * or a contiguous tool-pairing-balanced prefix) under the current `policy`.
 * Returns `null` on missing, mismatched, unbalanced, or corrupt records.
 *
 * @param {SessionMemoryStore} store
 * @param {object} session
 * @param {readonly number[]} candidateSeqs
 * @param {Record<string, unknown>|undefined} policy
 * @returns {null | { kind: 'exact', record: object, memory: object, coveredSeqs: number[], deltaSeqs: number[], coveredThroughSeq: number } | { kind: 'prefix', record: object, memory: object, coveredSeqs: number[], deltaSeqs: number[], coveredThroughSeq: number }}
 */
export function readValidSessionMemory(store, session, candidateSeqs, policy) {
  if (!store || typeof store.read !== 'function' || !session?.id) return null;
  if (!Array.isArray(candidateSeqs) || candidateSeqs.length === 0) return null;

  const verify = () => {
    let record;
    try {
      record = store.read(session.id);
    } catch {
      return null;
    }
    const memory = record?.memory;
    if (!memory || !validateMemoryPayload(memory)) return null;
    if (memory.policyFingerprint !== computeSessionMemoryPolicyFingerprint(policy)) return null;

    const covered = memory.coveredSeqs;
    const coveredThroughSeq = memory.coveredThroughSeq;
    if (!Number.isSafeInteger(coveredThroughSeq) || coveredThroughSeq !== covered.at(-1)) return null;
    if (covered.length > candidateSeqs.length) return null;
    for (let i = 0; i < covered.length; i += 1) {
      if (candidateSeqs[i] !== covered[i]) return null;
    }

    let balanced = false;
    try {
      balanced =
        toolPairingBalancedBefore(session, covered[0]) &&
        toolPairingBalancedAfter(session, coveredThroughSeq);
    } catch {
      return null;
    }
    if (!balanced) return null;

    const actualHash = computeSessionMemorySourceHash(session, covered);
    if (!actualHash || actualHash !== memory.sourceHash) return null;

    if (covered.length === candidateSeqs.length) {
      return {
        kind: 'exact',
        record,
        memory,
        coveredSeqs: [...covered],
        deltaSeqs: [],
        coveredThroughSeq,
      };
    }

    return {
      kind: 'prefix',
      record,
      memory,
      coveredSeqs: [...covered],
      deltaSeqs: candidateSeqs.slice(covered.length),
      coveredThroughSeq,
    };
  };

  if (
    policy &&
    (policy.extraReferenceSourceKinds !== undefined || policy.extraReferencePrefixes !== undefined)
  ) {
    return withReferencePolicy(policy, verify);
  }
  return verify();
}

/**
 * Coordinates opt-in background session memory refreshes with strict single-flight,
 * cooldown, turn/token thresholds, payload size bounds, and hard per-session billing caps.
 * Never modifies session surface or compaction breaker state.
 */
export class SessionMemoryManager {
  /** @param {object} engine */
  constructor(engine) {
    this.engine = engine;
    /** @type {Map<string, { controller: AbortController, promise: Promise<any>, cleared?: boolean }>} */
    this.inFlight = new Map();
    /** @type {Map<string, AbortController>} */
    this._scheduling = new Map();
    /** @type {Map<string, number>} */
    this.lastRunAt = new Map();
    this.disposed = false;
  }

  _store() {
    const archiveRoot = this.engine?.archive?.root ?? this.engine?.config?.archiveDir;
    let root;
    if (typeof this.engine?.sessionMemoryRoot === 'string' && this.engine.sessionMemoryRoot.trim()) {
      root = this.engine.sessionMemoryRoot;
    } else if (typeof archiveRoot === 'string' && archiveRoot.trim()) {
      root = join(dirname(resolve(archiveRoot)), 'session-memory');
    } else if (typeof this.engine?.sessionState?.root === 'string' && this.engine.sessionState.root.trim()) {
      root = join(dirname(resolve(this.engine.sessionState.root)), 'session-memory');
    } else {
      throw makeError('SESSION_MEMORY_UNAVAILABLE', 'unable to resolve session memory storage root');
    }
    return new SessionMemoryStore(root);
  }

  _log(level, message) {
    try {
      if (typeof this.engine?.log === 'function') {
        this.engine.log(level, message);
      } else {
        this.engine?.ctx?.logger?.[level]?.(`[compaction-weave] ${message}`);
      }
    } catch {}
  }

  _seqTokens(session, measurement, seqs) {
    const costs = new Map();
    if (measurement?.pricedBySeq instanceof Map) {
      for (const [seq, tok] of measurement.pricedBySeq) {
        if (typeof seq === 'number' && Number.isFinite(tok)) costs.set(seq, tok);
      }
    }
    if (Array.isArray(measurement?.nodes)) {
      for (const node of measurement.nodes) {
        if (!node || typeof node !== 'object' || typeof node.seq !== 'number') continue;
        const tok = typeof node.tokens === 'number' && Number.isFinite(node.tokens)
          ? node.tokens
          : node.heuristicTokens;
        if (typeof tok === 'number' && Number.isFinite(tok)) costs.set(node.seq, tok);
      }
    }
    if (Array.isArray(measurement?.pricedNodes)) {
      for (const node of measurement.pricedNodes) {
        if (node && typeof node.seq === 'number' && typeof node.tokens === 'number' && Number.isFinite(node.tokens)) {
          costs.set(node.seq, node.tokens);
        }
      }
    }
    let total = 0;
    for (const seq of seqs) {
      const known = costs.get(seq);
      if (typeof known === 'number' && known > 0) {
        total += known;
        continue;
      }
      const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
      const message = typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : undefined;
      total += approxTokens(blocksToText(message?.content));
    }
    return total;
  }

  _estimateTokens(blocks) {
    if (typeof this.engine?._estimateCheckpointTokens === 'function') {
      try {
        const value = this.engine._estimateCheckpointTokens(blocks);
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
      } catch {}
    }
    return approxTokens(blocksToText(blocks));
  }

  /** @param {Record<string, unknown>|undefined} [policy] */
  isEnabled(policy = undefined) {
    return mergePolicy(this.engine?.config, policy).sessionMemoryEnabled === true;
  }

  /**
   * @param {string} sessionId
   * @param {Record<string, unknown>|undefined} [policy]
   */
  status(sessionId, policy = undefined) {
    const effectivePolicy = mergePolicy(this.engine?.config, policy);
    const enabled = effectivePolicy.sessionMemoryEnabled === true;
    const maxCalls = resolveMaxCalls(effectivePolicy);
    const updating = typeof sessionId === 'string' && sessionId.length > 0 ? this.inFlight.has(sessionId) : false;
    if (typeof sessionId !== 'string' || !sessionId) {
      return {
        enabled,
        ready: false,
        updating: false,
        coveredNodes: 0,
        coveredThroughSeq: null,
        updatedAt: null,
        callsUsed: 0,
        totalCallsUsed: 0,
        maxCalls,
      };
    }
    let record = null;
    try {
      record = this._store().read(sessionId);
    } catch {
      return {
        enabled,
        ready: false,
        updating,
        coveredNodes: 0,
        coveredThroughSeq: null,
        updatedAt: null,
        callsUsed: 0,
        totalCallsUsed: 0,
        maxCalls,
      };
    }
    const mem = record?.memory ?? null;
    const callsUsed = record?.callsUsed ?? 0;
    return {
      enabled,
      ready: Boolean(mem),
      updating,
      coveredNodes: mem?.coveredSeqs?.length ?? 0,
      coveredThroughSeq: Number.isSafeInteger(mem?.coveredThroughSeq) ? mem.coveredThroughSeq : null,
      updatedAt: mem?.updatedAt ?? null,
      callsUsed,
      totalCallsUsed: record?.totalCallsUsed ?? callsUsed,
      maxCalls,
    };
  }

  /** @param {string} sessionId */
  cancel(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    let cancelled = false;
    const planningController = this._scheduling.get(sessionId);
    if (planningController) {
      planningController.abort(makeError('ABORTED', 'session memory update cancelled'));
      cancelled = true;
    }
    const entry = this.inFlight.get(sessionId);
    if (entry) {
      entry.controller.abort(makeError('ABORTED', 'session memory update cancelled'));
      cancelled = true;
    }
    return cancelled;
  }

  /** @param {string} sessionId */
  async waitFor(sessionId) {
    const entry = typeof sessionId === 'string' && sessionId ? this.inFlight.get(sessionId) : null;
    if (!entry) return null;
    return entry.promise;
  }

  /**
   * Short-timeout wait for an already-in-flight background refresh so foreground compaction
   * can reuse nearly-finished work when compatible, or cancel and fall back cleanly.
   * Returns 0ms immediately when idle/planning (`none`) or incompatible (`incompatible`).
   *
   * @param {string} sessionId
   * @param {{ timeoutMs?: number, signal?: AbortSignal, policy?: Record<string, unknown>, expectedStartSeq?: number }} [options]
   * @returns {Promise<{ status: 'completed', result: any } | { status: 'timeout' } | { status: 'none' } | { status: 'incompatible', reason: string }>}
   */
  async waitForWithin(sessionId, { timeoutMs = 4000, signal, policy, expectedStartSeq, session } = {}) {
    if (typeof sessionId !== 'string' || !sessionId || !this.inFlight.has(sessionId)) {
      return { status: 'none' };
    }
    const entry = this.inFlight.get(sessionId);
    if (!entry || !entry.promise || entry.cleared || entry.controller?.signal?.aborted) {
      return { status: 'none' };
    }
    const liveSession = session ?? entry.session;
    if (
      liveSession &&
      ((liveSession.surface?.replaceGeneration ?? 0) !== entry.surfaceGeneration ||
        (liveSession.surface?.contentGeneration ?? 0) !== entry.contentGeneration)
    ) {
      return { status: 'incompatible', reason: 'surface-generation-mismatch' };
    }
    if (policy !== undefined) {
      const expectedFp = computeSessionMemoryPolicyFingerprint(mergePolicy(this.engine?.config, policy));
      if (entry.policyFingerprint && expectedFp !== entry.policyFingerprint) {
        return { status: 'incompatible', reason: 'policy-mismatch' };
      }
    }
    if (
      Number.isSafeInteger(expectedStartSeq) &&
      Number.isSafeInteger(entry.startSeq) &&
      entry.startSeq !== expectedStartSeq
    ) {
      return { status: 'incompatible', reason: 'start-seq-mismatch' };
    }
    if (signal?.aborted) {
      throw signal.reason ?? makeError('ABORTED', 'session memory wait aborted');
    }
    const waitMs = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Math.floor(timeoutMs) : 4000;
    if (waitMs === 0) {
      return { status: 'timeout' };
    }

    let timer;
    let onAbort;
    try {
      const racers = [
        entry.promise.then((result) => ({ status: 'completed', result })),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ status: 'timeout' }), waitMs);
          timer.unref?.();
        }),
      ];
      if (signal && typeof signal.addEventListener === 'function') {
        racers.push(
          new Promise((_resolve, reject) => {
            onAbort = () => reject(signal.reason ?? makeError('ABORTED', 'session memory wait aborted'));
            signal.addEventListener('abort', onAbort, { once: true });
          }),
        );
      }
      return await Promise.race(racers);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener?.('abort', onAbort);
    }
  }

  dispose() {
    this.disposed = true;
    for (const controller of this._scheduling.values()) {
      try {
        controller.abort(makeError('ABORTED', 'session memory manager disposed'));
      } catch {}
    }
    this._scheduling.clear();
    for (const entry of this.inFlight.values()) {
      try {
        entry.controller.abort(makeError('ABORTED', 'session memory manager disposed'));
      } catch {}
    }
    this.inFlight.clear();
    this.lastRunAt.clear();
  }

  /**
   * @param {string} sessionId
   * @param {{ keepBillingCounter?: boolean, resetCycle?: boolean }} [options]
   */
  clear(sessionId, options) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    const entry = this.inFlight.get(sessionId);
    if (entry) entry.cleared = true;
    this.cancel(sessionId);
    this.lastRunAt.delete(sessionId);
    return this._store().clear(sessionId, options);
  }

  /**
   * Clear stored memory and reset the current cycle billing counter to 0 while keeping
   * monotonic `totalCallsUsed`. Intended strictly for committed compaction checkpoints.
   * @param {string} sessionId
   */
  resetCycle(sessionId) {
    return this.clear(sessionId, { resetCycle: true });
  }

  /**
   * Look up verified cached session memory for `candidateSeqs` when opt-in is enabled.
   * Re-verifies checksum, sessionId, sourceHash, policyFingerprint, `coveredThroughSeq`,
   * and `toolPairingBalancedAfter`. Degrades corrupt files safely to `null`.
   *
   * @param {object} session
   * @param {readonly number[]} candidateSeqs
   * @param {Record<string, unknown>|undefined} [policy]
   * @param {{ allowPrefixSplit?: boolean }} [options]
   * @returns {null | { mode: 'exact', memory: object, coveredSeqs: number[], tailSeqs: [], coveredThroughSeq: number } | { mode: 'prefix', memory: object, coveredSeqs: number[], tailSeqs: number[], coveredThroughSeq: number }}
   */
  matchForSpan(session, candidateSeqs, policy = undefined, { allowPrefixSplit = false } = {}) {
    const effectivePolicy = mergePolicy(this.engine?.config, policy);
    if (effectivePolicy.sessionMemoryEnabled !== true) {
      return null;
    }
    if (!session || typeof session.id !== 'string' || !session.id) {
      return null;
    }
    if (!Array.isArray(candidateSeqs) || candidateSeqs.length === 0) {
      return null;
    }

    return withReferencePolicy(effectivePolicy, () => {
      let record;
      try {
        record = this._store().read(session.id);
      } catch {
        return null;
      }

      const memory = record?.memory;
      if (!memory || !validateMemoryPayload(memory)) {
        return null;
      }
      if (memory.policyFingerprint !== computeSessionMemoryPolicyFingerprint(effectivePolicy)) {
        return null;
      }

      const covered = memory.coveredSeqs;
      const coveredThroughSeq = memory.coveredThroughSeq;
      if (!Number.isSafeInteger(coveredThroughSeq) || coveredThroughSeq !== covered.at(-1)) {
        return null;
      }
      if (memory.range && (memory.range.start !== covered[0] || memory.range.end !== coveredThroughSeq)) {
        return null;
      }
      if (covered.length > candidateSeqs.length) {
        return null;
      }
      for (let i = 0; i < covered.length; i += 1) {
        if (candidateSeqs[i] !== covered[i]) {
          return null;
        }
      }

      let balanced = false;
      try {
        balanced =
          toolPairingBalancedBefore(session, covered[0]) &&
          toolPairingBalancedAfter(session, coveredThroughSeq);
      } catch {
        return null;
      }
      if (!balanced) {
        return null;
      }

      const actualHash = computeSessionMemorySourceHash(session, covered);
      if (!actualHash || actualHash !== memory.sourceHash) {
        return null;
      }

      if (covered.length === candidateSeqs.length) {
        return {
          mode: 'exact',
          memory,
          coveredSeqs: [...covered],
          tailSeqs: [],
          coveredThroughSeq,
        };
      }

      if (allowPrefixSplit !== true) {
        return null;
      }

      return {
        mode: 'prefix',
        memory,
        coveredSeqs: [...covered],
        tailSeqs: candidateSeqs.slice(covered.length),
        coveredThroughSeq,
      };
    });
  }

  /**
   * Schedule an asynchronous background session memory refresh when all opt-in,
   * safety, cooldown, budget, and turn/delta-token guards pass.
   *
   * @param {{ session?: object, agent?: object, measurement?: object, policy?: Record<string, unknown> }} args
   */
  async maybeSchedule({ session, agent, measurement, policy } = {}) {
    // 1. Strict opt-in + disposed guard (0 I/O, 0 LLM calls, 0 store mutations).
    const effectivePolicy = mergePolicy(this.engine?.config, policy);
    if (this.disposed || effectivePolicy.sessionMemoryEnabled !== true) {
      return { scheduled: false, skipped: 'disabled', reason: 'disabled' };
    }

    const targetSession = session ?? agent?.session;
    if (!targetSession || typeof targetSession.id !== 'string' || !targetSession.id) {
      return { scheduled: false, reason: 'invalid-session' };
    }
    const effectiveAgent = agent
      ? (agent.session ? agent : { ...agent, session: targetSession })
      : { session: targetSession };
    const sessionId = targetSession.id;

    // 2. Active compaction or tripped breaker guard.
    const sessionKey =
      typeof this.engine?._keyOf === 'function' ? this.engine._keyOf(targetSession) : sessionId;
    if (this.engine?._busy?.has(targetSession) || this.engine?._stopped?.has(sessionKey)) {
      return { scheduled: false, reason: 'busy-or-stopped' };
    }

    // 3. Pending continuation or resumable compaction guard.
    if (this.engine?.sessionState && typeof this.engine.sessionState.read === 'function') {
      try {
        const persistedState = this.engine.sessionState.read(sessionId);
        if (persistedState?.stopped === true) {
          return { scheduled: false, reason: 'busy-or-stopped' };
        }
        if (
          readPendingContinuation(this.engine.sessionState, targetSession) ||
          readResumableCompaction(this.engine.sessionState, sessionId)
        ) {
          return { scheduled: false, reason: 'pending-compaction' };
        }
      } catch {
        return { scheduled: false, reason: 'pending-compaction' };
      }
    }

    // 4. Single-flight guard (covers both planning awaits and background execution).
    if (this.inFlight.has(sessionId) || this._scheduling.has(sessionId)) {
      return { scheduled: false, reason: 'already-updating' };
    }

    const planningController = new AbortController();
    this._scheduling.set(sessionId, planningController);

    try {
      // 5. Minimum context tokens pre-guard.
      const minTokens =
        Number.isSafeInteger(effectivePolicy.sessionMemoryMinTokens) && effectivePolicy.sessionMemoryMinTokens >= 0
          ? effectivePolicy.sessionMemoryMinTokens
          : DEFAULT_SESSION_MEMORY_MIN_TOKENS;
      let activeMeasurement = measurement;
      if (!activeMeasurement && typeof this.engine?._measure === 'function') {
        activeMeasurement = await this.engine._measure(targetSession);
      }
      if (this.disposed || planningController.signal.aborted) {
        return { scheduled: false, reason: 'aborted' };
      }
      if (!activeMeasurement || typeof activeMeasurement.totalTokens !== 'number' || activeMeasurement.totalTokens < minTokens) {
        return { scheduled: false, reason: 'below-min-tokens' };
      }
      if (!Array.isArray(activeMeasurement.nodes) && Array.isArray(targetSession.surface?.nodes)) {
        activeMeasurement = { ...activeMeasurement, nodes: [...targetSession.surface.nodes] };
      }

      // 6. Cooldown guard.
      const cooldownMs =
        Number.isFinite(effectivePolicy.sessionMemoryCooldownMs) && effectivePolicy.sessionMemoryCooldownMs >= 0
          ? effectivePolicy.sessionMemoryCooldownMs
          : DEFAULT_SESSION_MEMORY_COOLDOWN_MS;
      const lastAt = this.lastRunAt.get(sessionId);
      if (cooldownMs > 0 && typeof lastAt === 'number' && Date.now() - lastAt < cooldownMs) {
        return { scheduled: false, reason: 'cooldown' };
      }

      // 7. Hard billing fuse: verify store cleanly; refuse on corruption or exhausted cap.
      const maxCalls = resolveMaxCalls(effectivePolicy);
      const maxBytes = resolveMaxBytes(effectivePolicy);
      let store;
      let existingRecord;
      try {
        store = this._store();
        existingRecord = store.read(sessionId);
      } catch (error) {
        this._log('warn', `session memory store unreadable for ${sessionId}: ${error?.message ?? error}`);
        return { scheduled: false, reason: 'store-corrupt' };
      }
      const callsUsed = existingRecord?.callsUsed ?? 0;
      if (callsUsed >= maxCalls) {
        return { scheduled: false, reason: 'max-calls-reached' };
      }

      // 8. Span planning + turn/token gating + source collection inside reference source-kind scope.
      return await withReferencePolicy(effectivePolicy, async () => {
        const retainTokens = resolveRetainTokens(
          this.engine,
          targetSession,
          effectiveAgent,
          activeMeasurement,
          effectivePolicy,
        );

        let candidateRange = null;
        try {
          candidateRange =
            selectCachePreservingRange(targetSession, activeMeasurement, retainTokens, effectivePolicy) ??
            selectCompactableRange(targetSession, activeMeasurement, retainTokens);
        } catch {
          return { scheduled: false, reason: 'up-to-date' };
        }
        if (!candidateRange) {
          return { scheduled: false, reason: 'up-to-date' };
        }

        const liveNodes = targetSession.surface?.nodes ?? [];
        const rangeStartIdx = liveNodes.indexOf(candidateRange.start);
        const rangeEndIdx = liveNodes.indexOf(candidateRange.end);
        if (rangeStartIdx < 0 || rangeEndIdx < rangeStartIdx) {
          return { scheduled: false, reason: 'up-to-date' };
        }
        const compactableTokens = this._seqTokens(
          targetSession,
          activeMeasurement,
          liveNodes.slice(rangeStartIdx, rangeEndIdx + 1),
        );
        if (compactableTokens < minTokens) {
          return { scheduled: false, reason: 'below-min-tokens' };
        }

        const targets = resolveSummaryTargets({ config: effectivePolicy, agent: effectiveAgent });
        if (!Array.isArray(targets?.targets) || targets.targets.length === 0) {
          return { scheduled: false, reason: 'no-summary-target' };
        }

        const bgMaxTokens = Math.min(effectivePolicy.maxTokens ?? DEFAULT_BG_MAX_TOKENS, DEFAULT_BG_MAX_TOKENS);
        const planning = {
          policy: effectivePolicy,
          language: effectivePolicy.language,
          historyToolsAvailable: Boolean(this.engine?.historyToolsAvailable),
          pricedInput: (seqs) => this._seqTokens(targetSession, activeMeasurement, seqs),
          singleTarget: true,
          boundedWave: true,
          maxToolSourceRefs: DEFAULT_MAX_CHUNK_TOOL_SOURCE_REFS,
        };

        let capacity;
        let planned;
        try {
          capacity = await resolveSummaryCapacity(
            this.engine?.ctx,
            targets,
            { ...effectivePolicy, maxTokens: bgMaxTokens },
            planningController.signal,
            { singleTarget: true },
          );
          if (this.disposed || planningController.signal.aborted) {
            return { scheduled: false, reason: 'aborted' };
          }
          planned = planSummaryRange(targetSession, candidateRange, capacity, planning);
        } catch {
          if (this.disposed || planningController.signal.aborted) {
            return { scheduled: false, reason: 'aborted' };
          }
          return { scheduled: false, reason: 'up-to-date' };
        }
        if (!planned) {
          return { scheduled: false, reason: 'up-to-date' };
        }

        const startIdx = liveNodes.indexOf(planned.start);
        const endIdx = liveNodes.indexOf(planned.end);
        if (startIdx < 0 || endIdx < startIdx) {
          return { scheduled: false, reason: 'up-to-date' };
        }
        const candidateSeqs = liveNodes.slice(startIdx, endIdx + 1);
        if (candidateSeqs.length === 0) {
          return { scheduled: false, reason: 'up-to-date' };
        }

        const shadowedTokenCount = this._seqTokens(targetSession, activeMeasurement, candidateSeqs);

        const totalTurns = countConversationTurns(targetSession, candidateSeqs);
        const existing = readValidSessionMemory(store, targetSession, candidateSeqs, effectivePolicy);
        if (existing?.kind === 'exact') {
          return { scheduled: false, reason: 'up-to-date' };
        }
        if (existing?.kind === 'prefix') {
          const deltaSeqs = existing.deltaSeqs;
          if (!Array.isArray(deltaSeqs) || deltaSeqs.length === 0) {
            return { scheduled: false, reason: 'up-to-date' };
          }
          const intervalTokens =
            Number.isSafeInteger(effectivePolicy.sessionMemoryUpdateIntervalTokens) &&
            effectivePolicy.sessionMemoryUpdateIntervalTokens >= 0
              ? effectivePolicy.sessionMemoryUpdateIntervalTokens
              : DEFAULT_SESSION_MEMORY_UPDATE_INTERVAL_TOKENS;
          const intervalTurns =
            Number.isSafeInteger(effectivePolicy.sessionMemoryUpdateIntervalTurns) &&
            effectivePolicy.sessionMemoryUpdateIntervalTurns >= 0
              ? effectivePolicy.sessionMemoryUpdateIntervalTurns
              : DEFAULT_SESSION_MEMORY_UPDATE_INTERVAL_TURNS;
          const deltaTokens = this._seqTokens(targetSession, activeMeasurement, deltaSeqs);
          const deltaTurns = countConversationTurns(targetSession, deltaSeqs);
          const tokenThresholdMet = deltaTokens >= intervalTokens;
          const turnThresholdMet = intervalTurns > 0 && deltaTurns >= intervalTurns;
          if (!tokenThresholdMet && !turnThresholdMet) {
            return { scheduled: false, reason: 'up-to-date' };
          }
        }

        let memorySelection;
        let input;
        let referenceMessages;
        let auditSelection;
        let previousSummary;
        try {
          let preservePrefixCache = false;
          const durable = latestDurableTarget(effectiveAgent);
          const primary = targets.targets[0];
          if (durable && primary && primary.provider === durable.provider && primary.model === durable.model) {
            const verbatim = measureSummaryRange(
              targetSession,
              { start: planned.start, end: planned.end },
              { ...planning, preservePrefixCache: true },
            );
            if (verbatim.inputUnits <= capacityLimit(capacity, { singleTarget: true })) {
              preservePrefixCache = true;
            }
          }
          memorySelection = selectSessionMemory(targetSession, candidateSeqs, {
            maxMessages: effectivePolicy.preserveRecentMessages,
            maxTokens: effectivePolicy.preserveRecentUserTokens,
            approxTokens,
          });
          if (
            !effectivePolicy.archiveEnabled &&
            memorySelection.decisions.some((d) => d.reason === 'oldest-quote-evicted')
          ) {
            return { scheduled: false, reason: 'archive-required' };
          }
          input = buildSummarizationInput(targetSession, candidateSeqs, { preservePrefixCache });
          input.messages.push({ role: 'user', content: [{ type: 'text', text: memoryPolicyInstruction(memorySelection) }] });
          previousSummary = candidateSeqs.some(
            (seq) => targetSession.deriveEventMessage?.(targetSession.eventAt?.(seq))?.source?.kind === 'compact-checkpoint',
          )
            ? 'inline checkpoint'
            : null;
          referenceMessages = collectReferenceMessages(targetSession, liveNodes);
          auditSelection = effectivePolicy.auditEnabled
            ? selectSessionMemory(targetSession, candidateSeqs, { approxTokens })
            : null;
        } catch {
          return { scheduled: false, reason: 'up-to-date' };
        }

        const sourceHash = computeSessionMemorySourceHash(targetSession, candidateSeqs);
        const policyFingerprint = computeSessionMemoryPolicyFingerprint(effectivePolicy);
        const coveredThroughSeq = candidateSeqs.at(-1);
        const surfaceGeneration = targetSession.surface?.replaceGeneration ?? 0;
        const contentGeneration = targetSession.surface?.contentGeneration ?? 0;
        const expectedUserMessages = [...memorySelection.active, ...memorySelection.retained];
        const preserved = memorySelection.preserved;
        const progressSelection = input.progress;
        const controller = new AbortController();
        this.lastRunAt.set(sessionId, Date.now());

        const entry = {
          controller,
          promise: null,
          cleared: false,
          session: targetSession,
          policyFingerprint,
          coveredSeqs: [...candidateSeqs],
          startSeq: candidateSeqs[0],
          coveredThroughSeq,
          surfaceGeneration,
          contentGeneration,
        };
        const runPromise = withReferencePolicy(effectivePolicy, async () => {
          try {
            controller.signal.throwIfAborted?.();
            const summarized = await summarizeWithChain({
              ctx: this.engine?.ctx,
              agent: effectiveAgent,
              input,
              chain: targets,
              options: {
                maxTokens: bgMaxTokens,
                singleTarget: true,
                timeoutMs: effectivePolicy.summaryTimeoutMs ?? DEFAULT_CONFIG.summaryTimeoutMs,
                retryCount: 0,
                retryDelayMs: 0,
                language: effectivePolicy.language ?? DEFAULT_CONFIG.language,
                previousSummary,
                capacity,
                reasoningEffortPolicy: effectivePolicy.summaryReasoningEffort ?? 'low',
                userMessages: preserved,
                beforeRequest: async () => {
                  controller.signal.throwIfAborted?.();
                  if (this.disposed) throw makeError('ABORTED', 'session memory manager disposed');
                  store.recordAttempt(sessionId, { maxCalls });
                },
                reconstruct: ({ result, verdict, modelRawText }) =>
                  withReferencePolicy(effectivePolicy, () => {
                    if (verdict.code === 'PROGRESS_FACT_CONFLICT') return null;
                    const rebuilt = reconstructDisputedLines({
                      text: modelRawText,
                      userMessages: expectedUserMessages,
                      audit: verdict.audit,
                      language: result.language,
                    });
                    if (!rebuilt) return null;
                    const receipts = [...(result.reconstruction ?? []), ...rebuilt.receipts];
                    if (new Set(receipts.flatMap((r) => r.removedLineSha256)).size > 16) return null;
                    return {
                      ...result,
                      rawText: rebuilt.text,
                      summary: [{ type: 'text', text: rebuilt.text }],
                      reconstruction: receipts,
                    };
                  }),
                validate: (result) =>
                  withReferencePolicy(effectivePolicy, () => {
                    const language = result?.language ?? (effectivePolicy.language === 'zh' ? 'zh' : 'en');
                    const structure = validateSummaryStructure(result?.rawText ?? '', { language });
                    if (!structure.ok) return structure;
                    const retired = retiredMemoryPresent(result.rawText, memorySelection);
                    if (retired) {
                      return {
                        ok: false,
                        code: 'RETIRED_MEMORY_REINTRODUCED',
                        message: `Remove the ${retired.reason} request from seq ${retired.seq}; it is no longer active.`,
                      };
                    }
                    result.rawText = materializeUserMessageSection(
                      deduplicateNotes(result.rawText, preserved),
                      preserved,
                      language,
                    );
                    result.summary = [{ type: 'text', text: result.rawText }];
                    const compiled = validateSummaryStructure(result.rawText, { language });
                    if (!compiled.ok) return compiled;
                    const listed = validateUserMessageSection(compiled.userSectionBody, preserved);
                    if (!listed.ok) return listed;
                    const blocks = buildCheckpointBlocks(result.summary, preserved, CHECKPOINT_PREAMBLE, {
                      originalsInSummary: true,
                      workReport: input.workReport,
                      progress: progressSelection,
                    });
                    const coverage = validateCheckpointCoverage(blocks, preserved, { expected: preserved });
                    if (!coverage.ok) return coverage;
                    const checkpointTokens = this._estimateTokens(blocks);
                    if (shadowedTokenCount > 0 && checkpointTokens >= shadowedTokenCount) {
                      return {
                        ok: false,
                        code: 'SUMMARY_NOT_SMALLER',
                        message: 'session memory checkpoint is not smaller than shadowed span',
                      };
                    }
                    const progressVerdict = validateProgressFacts(result.rawText, progressSelection);
                    if (!progressVerdict.ok) return progressVerdict;
                    const provenance = auditInstructionProvenance({
                      userMessages: expectedUserMessages,
                      summaryText: result.rawText,
                      referenceMessages,
                    });
                    if (provenance.length > 0) {
                      const provSummary = summarizeProvenanceFailures(provenance);
                      if (provSummary.hardProvenance.length > 0 || effectivePolicy.auditProvenanceBlock !== false) {
                        return {
                          ok: false,
                          code: 'CONSTRAINT_LOST',
                          constraintReason: 'provenance',
                          provenanceLine: provSummary.provenanceLine,
                          provenanceKind: provSummary.provenanceKind,
                          message:
                            'Generated instructions or permissions have no matching user source. ' +
                            `(reason=provenance, kind=${provSummary.provenanceKind}, line="${provSummary.provenanceLine}")`,
                          audit: { lost: provenance },
                        };
                      }
                      this._log(
                        'warn',
                        `session-memory soft provenance warning allowed by auditProvenanceBlock: false (kind=${provSummary.provenanceKind})`,
                      );
                    }
                    if (effectivePolicy.auditEnabled && auditSelection) {
                      const checkpointText = blocks
                        .filter((b) => b?.type === 'text')
                        .map((b) => b.text)
                        .join('\n');
                      const audit = auditMemorySelection({
                        selection: auditSelection,
                        summaryText: result.rawText,
                        checkpointText,
                        threshold: effectivePolicy.auditCoverageThreshold ?? DEFAULT_CONFIG.auditCoverageThreshold,
                        includeAllConflicts: true,
                        referenceMessages,
                      });
                      const flips = audit.lost.filter((item) => item.reason === 'polarity');
                      if (flips.length > 0) {
                        const seq = flips[0]?.seq;
                        const sourceKind = sourceKindOf(targetSession, seq) ?? 'user';
                        return {
                          ok: false,
                          audit,
                          code: 'CONSTRAINT_POLARITY_LOST',
                          constraintSeq: seq ?? null,
                          constraintSourceKind: sourceKind,
                          message: `summary contradicts a source constraint (seq=${seq ?? 'unknown'}, source=${sourceKind}, reason=polarity)`,
                        };
                      }
                      const provenanceLost = audit.lost.filter((item) => item.reason === 'provenance');
                      if (provenanceLost.length > 0) {
                        const provSummary = summarizeProvenanceFailures(provenanceLost);
                        if (provSummary.hardProvenance.length > 0 || effectivePolicy.auditProvenanceBlock !== false) {
                          return {
                            ok: false,
                            audit,
                            code: 'CONSTRAINT_LOST',
                            constraintReason: 'provenance',
                            provenanceLine: provSummary.provenanceLine,
                            provenanceKind: provSummary.provenanceKind,
                            message:
                              'Generated instructions or permissions have no matching user source. ' +
                              `(reason=provenance, kind=${provSummary.provenanceKind}, line="${provSummary.provenanceLine}")`,
                          };
                        }
                      }
                      const coverageLost = audit.lost.filter((item) => item.reason !== 'polarity' && item.reason !== 'provenance');
                      if ((effectivePolicy.auditBlockOnLoss ?? true) && coverageLost.length > 0) {
                        return {
                          ok: false,
                          audit,
                          code: 'CONSTRAINT_LOST',
                          message: `summary failed source constraint audit (seq=${coverageLost[0].seq}, reason=${coverageLost[0].reason})`,
                        };
                      }
                    }
                    return { ok: true };
                  }),
              },
              signal: controller.signal,
            });

            controller.signal.throwIfAborted?.();
            if (this.disposed) return { ok: false, reason: 'disposed' };

            const currentNodes = targetSession.surface?.nodes ?? [];
            const currentStartIdx = currentNodes.indexOf(candidateSeqs[0]);
            const stillLive =
              (targetSession.surface?.replaceGeneration ?? 0) === surfaceGeneration &&
              (targetSession.surface?.contentGeneration ?? 0) === contentGeneration &&
              currentStartIdx >= 0 &&
              candidateSeqs.every((seq, idx) => currentNodes[currentStartIdx + idx] === seq) &&
              computeSessionMemorySourceHash(targetSession, candidateSeqs) === sourceHash;
            if (!stillLive) {
              return { ok: false, reason: 'surface-drifted' };
            }

            const memoryPayload = {
              sourceHash,
              policyFingerprint,
              coveredSeqs: [...candidateSeqs],
              coveredThroughSeq,
              range: { start: candidateSeqs[0], end: coveredThroughSeq },
              rawText: summarized.rawText,
              language: summarized.language,
              provider: summarized.provider,
              model: summarized.model,
              usage: summarized.usage ?? null,
              tokens: this._estimateTokens(summarized.summary ?? [{ type: 'text', text: summarized.rawText }]),
              updatedAt: new Date().toISOString(),
            };

            const payloadBytes = Buffer.byteLength(JSON.stringify(memoryPayload), 'utf8');
            if (payloadBytes > maxBytes) {
              this._log(
                'warn',
                `skipping oversized session memory for ${sessionId}: ${payloadBytes} bytes > max ${maxBytes} bytes`,
              );
              return { ok: false, reason: 'oversized', bytes: payloadBytes, maxBytes };
            }

            store.saveMemory(sessionId, memoryPayload, { maxBytes });
            return { ok: true, memory: memoryPayload };
          } catch (error) {
            const aborted = controller.signal.aborted || error?.code === 'ABORTED' || error?.name === 'AbortError';
            if (!aborted) {
              this._log('warn', `background session memory refresh failed: ${error?.message ?? error}`);
            }
            return {
              ok: false,
              reason: aborted ? 'aborted' : (error?.code ?? 'error'),
              error: error?.message ?? String(error),
            };
          } finally {
            if (this.inFlight.get(sessionId) === entry) {
              this.inFlight.delete(sessionId);
            }
            if (!this.disposed && !entry.cleared) {
              this.lastRunAt.set(sessionId, Date.now());
            }
          }
        });

        entry.promise = runPromise;
        this.inFlight.set(sessionId, entry);
        return {
          scheduled: true,
          range: { start: candidateSeqs[0], end: coveredThroughSeq },
          coveredSeqs: candidateSeqs,
          coveredThroughSeq,
          turns: totalTurns,
          promise: runPromise,
        };
      });
    } finally {
      if (this._scheduling.get(sessionId) === planningController) {
        this._scheduling.delete(sessionId);
      }
    }
  }
}
