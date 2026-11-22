// Tail-only zero-prefix-cache-invalidation spill for oversized newly landed
// tool/result nodes. Only tool/result events strictly after the latest turn/step
// boundary can be spilled; historical nodes prior to the boundary stay untouched.

import { approxTokens, blocksToText } from './meter.js';
import { inspectCompactionEntryState } from './region.js';
import {
  MAX_MASK_SOURCE_DEPTH,
  MAX_MASK_STAGE_REFS,
  PERSISTED_OUTPUT_MARKER,
  commitObservationMask,
  extractToolLocator,
  formatMaskedToolText,
  inspectMaskSourceStats,
  isArchivedToolStubText,
} from './observation-mask.js';

export const DEFAULT_PERSISTED_OUTPUT_THRESHOLD_CHARS = 32768;
export const DEFAULT_PERSISTED_OUTPUT_HEAD_CHARS = 1200;
export const DEFAULT_PERSISTED_OUTPUT_TAIL_CHARS = 1200;

const BOUNDARY_EVENT_TYPES = new Set([
  'assistant/message',
  'assistant/attempt',
  'turn/start',
  'turn/end',
  'step/start',
]);

function isAbortLike(error, signal) {
  return Boolean(
    signal?.aborted ||
      error?.code === 'ABORTED' ||
      error?.name === 'AbortError',
  );
}

/**
 * Find live surface `tool/result` seqs strictly after the latest turn/step/model
 * boundary inside an open turn, sorted in ascending `seq` order.
 */
export function findTailToolResultSeqs(session) {
  if (!session || typeof session.eventAt !== 'function') return [];
  if (inspectCompactionEntryState(session).openTurn === null) return [];

  const totalSeq = Number.isSafeInteger(session.seq) && session.seq > 0 ? session.seq : 0;
  let lastBoundarySeq = -1;
  for (let seq = totalSeq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq);
    if (event && BOUNDARY_EVENT_TYPES.has(event.type)) {
      lastBoundarySeq = seq;
      break;
    }
  }

  const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : [];
  const tailSeqs = [];
  for (const seq of nodes) {
    if (!Number.isSafeInteger(seq) || seq <= lastBoundarySeq) continue;
    const event = session.eventAt(seq);
    if (event?.type === 'tool/result') {
      tailSeqs.push(seq);
    }
  }
  tailSeqs.sort((a, b) => a - b);
  return tailSeqs;
}

/**
 * Plan deterministic spilling of newly landed oversized `tool/result` tail outputs.
 * Does not mutate `session` or write to `archive`.
 */
export function planPersistedOutput(session, options = {}) {
  if (!session || typeof session.eventAt !== 'function') return null;

  const compactionId = options?.compactionId;
  if (typeof compactionId !== 'string' || compactionId.length === 0) return null;

  const tailSeqs = findTailToolResultSeqs(session);
  if (tailSeqs.length === 0) return null;

  const thresholdChars =
    Number.isFinite(options.thresholdChars) && options.thresholdChars > 0
      ? options.thresholdChars
      : DEFAULT_PERSISTED_OUTPUT_THRESHOLD_CHARS;
  const headChars =
    Number.isFinite(options.headChars) && options.headChars >= 0
      ? options.headChars
      : DEFAULT_PERSISTED_OUTPUT_HEAD_CHARS;
  const tailChars =
    Number.isFinite(options.tailChars) && options.tailChars >= 0
      ? options.tailChars
      : DEFAULT_PERSISTED_OUTPUT_TAIL_CHARS;
  const maxBatchRefs =
    Number.isSafeInteger(options.maxBatchRefs) && options.maxBatchRefs > 0
      ? Math.min(options.maxBatchRefs, MAX_MASK_STAGE_REFS)
      : MAX_MASK_STAGE_REFS;

  const targets = [];
  let batchRefs = 0;
  let hasMore = false;
  let totalTokensSaved = 0;

  for (const seq of tailSeqs) {
    const event = session.eventAt(seq);
    if (!event || event.type !== 'tool/result') continue;
    const message = event.data?.message;
    if (!message || message.isError === true || !Array.isArray(message.content)) continue;

    const stats = inspectMaskSourceStats(session, seq, maxBatchRefs);
    if (!Number.isFinite(stats.refs) || !Number.isFinite(stats.depth) || stats.depth >= MAX_MASK_SOURCE_DEPTH) {
      continue;
    }
    const targetRefs = stats.refs + 1;
    if (targetRefs > maxBatchRefs) continue;

    const { toolName, target } = extractToolLocator(session, seq, event);
    let changed = false;
    const nextContent = message.content.map((block) => {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') return block;
      if (isArchivedToolStubText(block.text)) return block;
      const masked = formatMaskedToolText(block.text, {
        compactionId,
        seq,
        toolName,
        target,
        thresholdChars,
        headChars,
        tailChars,
        markerPrefix: PERSISTED_OUTPUT_MARKER,
      });
      if (masked === null) return block;
      changed = true;
      return { ...block, text: masked };
    });
    if (!changed) continue;

    const deltaTokens = Math.max(
      0,
      approxTokens(blocksToText(message.content)) - approxTokens(blocksToText(nextContent)),
    );
    if (deltaTokens <= 0) continue;

    if (batchRefs + targetRefs > maxBatchRefs) {
      hasMore = true;
      if (batchRefs >= maxBatchRefs) break;
      continue;
    }

    targets.push({ seq, nextContent, savedTokens: deltaTokens });
    batchRefs += targetRefs;
    totalTokensSaved += deltaTokens;
  }

  if (targets.length === 0 || totalTokensSaved <= 0) return null;
  return {
    compactionId,
    targets,
    totalTokensSaved,
    batchRefs,
    hasMore,
  };
}

/**
 * Commit a persisted-output spill plan with fail-open pre-mutation semantics:
 * pre-mutation archive errors log a warning and return `null`, whereas aborts
 * and post-mutation failures are rethrown.
 */
export async function commitPersistedOutput({ session, plan, archive, log, flushSession, signal } = {}) {
  try {
    return await commitObservationMask({ session, plan, archive, log, flushSession, signal });
  } catch (error) {
    if (error?.surfaceMutated === true || isAbortLike(error, signal)) {
      throw error;
    }
    try {
      const detail = error instanceof Error ? error.message : String(error);
      log?.('warn', `persisted-output archive failed before surface mutation; keeping original output: ${detail}`);
    } catch {
      /* ignore logging failures on fail-open pre-mutation path */
    }
    return null;
  }
}
