// Leaf shared constants, transaction lock registry, error predicates, and snapshot/ID helpers
// for the compaction engine. Zero `lib/engine/*` or `../engine.js` imports.

import { Buffer } from 'node:buffer';
import { DEFAULT_CONFIG } from '../config.js';
import { capacityLimit, combineCompactionResults } from '../summary-budget.js';
import { summaryTimeoutInfo } from '../summary-timeout.js';

export const activeTransactions = new Set();
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED';
export const COMPACT_CHECKPOINT_KIND = 'compact-checkpoint';

/**
 * Check whether an error represents cancellation/abort rather than a model/storage failure.
 */
export function isAbortError(error, signal) {
  if (!error) return false;
  if (error.code === 'ABORTED' || error.name === 'AbortError') return true;
  if (signal?.aborted === true && (error === signal.reason || error?.cause === signal.reason)) return true;
  return false;
}

/**
 * Equivalent pure implementation of host `compactCheckpointSource`, attaching
 * optional structured `preserved` user messages for multi-generation fidelity.
 */
export function compactCheckpointSource(compactionId, sourceCommandId, preserved) {
  const source = { kind: COMPACT_CHECKPOINT_KIND, compactionId };
  if (sourceCommandId !== undefined) source.sourceCommandId = sourceCommandId;
  if (Array.isArray(preserved) && preserved.length > 0) source.preserved = preserved;
  return Object.freeze(source);
}

export function isCompactCheckpointSource(source) {
  return Boolean(source) && source.kind === COMPACT_CHECKPOINT_KIND;
}

let compactionCounter = 0;

export function nextCompactionId() {
  compactionCounter += 1;
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `weave-${stamp}-${rand}-${compactionCounter}`;
}

export function nextMigrationCompactionId() {
  compactionCounter += 1;
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `weave-migrate-${stamp}-${rand}-${compactionCounter}`;
}

export function safeGetService(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

export function isUnshrinkableTailError(error) {
  const seen = new Set();
  for (let cur = error, depth = 0; cur && depth < 5 && !seen.has(cur); cur = cur.cause, depth += 1) {
    seen.add(cur);
    if (cur.code === 'SUMMARY_NOT_SMALLER' || cur.code === 'CONTINUATION_NOT_SMALLER') {
      return true;
    }
    if (
      cur.code === 'SUMMARY_ALL_FAILED' &&
      Array.isArray(cur.failures) &&
      cur.failures.length > 0 &&
      cur.failures.every((f) => f?.code === 'SUMMARY_NOT_SMALLER' || f?.code === 'CONTINUATION_NOT_SMALLER')
    ) {
      return true;
    }
  }
  return false;
}

export function isBudgetExhaustedError(error) {
  const seen = new Set();
  for (let cur = error, depth = 0; cur && depth < 6 && !seen.has(cur); cur = cur.cause, depth += 1) {
    seen.add(cur);
    if (cur.code === 'CONTINUATION_CALL_BUDGET' || cur.failureCode === 'CONTINUATION_CALL_BUDGET') {
      return true;
    }
  }
  return false;
}

export function isUserCancelledError(error, signal) {
  if (isAbortError(error, signal)) return true;
  const seen = new Set();
  for (let cur = error, depth = 0; cur && depth < 6 && !seen.has(cur); cur = cur.cause, depth += 1) {
    seen.add(cur);
    if (cur.userCancelled === true || cur.code === 'cancelled' || cur.code === 'ABORTED' || cur.name === 'AbortError') {
      return true;
    }
  }
  return false;
}

export function isTimeoutFailureError(error) {
  if (summaryTimeoutInfo(error)) return true;
  const seen = new Set();
  for (let cur = error, depth = 0; cur && depth < 6 && !seen.has(cur); cur = cur.cause, depth += 1) {
    seen.add(cur);
    if (cur.code === 'SUMMARY_TIMEOUT' || cur.failureCode === 'SUMMARY_TIMEOUT') return true;
    if (Array.isArray(cur.failures) && cur.failures.length > 0 && cur.failures.every((f) => f?.code === 'SUMMARY_TIMEOUT')) {
      return true;
    }
  }
  return false;
}

export function combineBatchResults(rawResults, foldResults = []) {
  const combined = combineCompactionResults(rawResults);
  if (!combined) return combineCompactionResults(foldResults);
  if (!foldResults.length) return combined;
  const allResults = [...rawResults, ...foldResults];
  const mergedFallback = combineCompactionResults(allResults)?.auditFallback;
  const allIds = allResults.flatMap((r) => r.compactionIds ?? [r.compactionId]);
  return {
    ...combined,
    compactionId: foldResults.at(-1)?.compactionId ?? combined.compactionId,
    compactionIds: allIds,
    foldedWaves: foldResults.length,
    ...(mergedFallback ? { auditFallback: mergedFallback } : {}),
  };
}

export function resolveBulkFoldThreshold(policy, totalPlannedChunks) {
  const configured = policy?.cacheMaxCheckpoints ?? DEFAULT_CONFIG.cacheMaxCheckpoints;
  const base = Math.max(2, configured);
  if (configured === DEFAULT_CONFIG.cacheMaxCheckpoints && Number.isFinite(totalPlannedChunks) && totalPlannedChunks >= 8) {
    return 6;
  }
  return base;
}

export function estimateBulkChunkCount(session, seqs, _policy, capacity) {
  if (!session || !Array.isArray(seqs) || seqs.length === 0) return 0;
  const limit = capacity ? capacityLimit(capacity, { singleTarget: true }) : null;
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  let totalBytes = 0;
  for (const seq of seqs) {
    const event = session.eventAt?.(seq);
    const message = event ? session.deriveEventMessage?.(event) : undefined;
    if (!message) continue;
    totalBytes += canonicalMessageBytes([message]);
  }
  if (totalBytes <= 0) return 0;
  return Math.ceil(totalBytes / Math.max(1, limit));
}

let messageCounter = 0;

/**
 * Generate a non-empty message id compatible with DSH `user/message` schema.
 */
export function newMessageId() {
  messageCounter += 1;
  const globalCrypto = globalThis.crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `msg-${stamp}-${rand}-${messageCounter}`;
}

export function sameNodeList(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function captureSessionSurfaceSnapshot(session) {
  const nodes = Array.isArray(session?.surface?.nodes) ? [...session.surface.nodes] : null;
  return {
    id: session?.id ?? null,
    seq: Number.isSafeInteger(session?.seq) ? session.seq : null,
    replaceGeneration: session?.surface?.replaceGeneration ?? 0,
    nodes,
  };
}

export function sameSessionSurfaceSnapshot(snap, session) {
  if (!snap || !session) return false;
  if ((session.id ?? null) !== snap.id) return false;
  if ((Number.isSafeInteger(session.seq) ? session.seq : null) !== snap.seq) return false;
  if ((session.surface?.replaceGeneration ?? 0) !== snap.replaceGeneration) return false;
  const curNodes = session.surface?.nodes;
  if (snap.nodes === null) return !Array.isArray(curNodes);
  return sameNodeList(snap.nodes, curNodes);
}

/**
 * Canonical UTF-8 message payload, excluding source/log-only metadata.
 */
export function canonicalMessageBytes(messages) {
  const projected = messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
  }));
  return Buffer.byteLength(JSON.stringify(projected), 'utf8');
}

export function findAgentForSession(engine, session) {
  return engine._agentBySession?.get(session);
}

export function describeResult(result) {
  const count = Array.isArray(result?.shadowedSeqs) ? result.shadowedSeqs.length : 0;
  return `${result?.compactionId ?? '?'} (${count} seq(s), ${result?.provider ?? '?'}/${result?.model ?? '?'})`;
}
