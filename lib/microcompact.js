// Zero-LLM expired-TTL microcompact planner & committer.
// Protects the newest K successful tool outputs in the live surface tail,
// deduplicates older repeated file reads (even when superseded by a read in
// the protected tail), and masks older oversized successful tool results.

import { approxTokens, blocksToText } from './meter.js';
import { inspectCompactionEntryState } from './region.js';
import { deduplicateRepeatedFileReads } from './reference-input.js';
import {
  MAX_MASK_SOURCE_DEPTH,
  MAX_MASK_STAGE_REFS,
  commitObservationMask,
  extractToolLocator,
  formatMaskedToolText,
  inspectMaskSourceStats,
  isArchivedToolStubText,
} from './observation-mask.js';

export const DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS = 4;
export const DEFAULT_MICROCOMPACT_THRESHOLD_CHARS = 2000;
export const DEFAULT_MICROCOMPACT_HEAD_CHARS = 200;
export const DEFAULT_MICROCOMPACT_TAIL_CHARS = 200;
export const DEFAULT_MICROCOMPACT_REPEATED_READ_MIN_CHARS = 2000;

function computeSavedTokens(measurement, seq, prevContent, nextContent) {
  const deltaTokens = Math.max(
    0,
    approxTokens(blocksToText(prevContent)) - approxTokens(blocksToText(nextContent)),
  );
  const pricedNodeTokens = measurement?.pricedBySeq?.get?.(seq);
  return typeof pricedNodeTokens === 'number' && Number.isFinite(pricedNodeTokens)
    ? Math.min(pricedNodeTokens, deltaTokens)
    : deltaTokens;
}

/**
 * Plan 0-LLM expired-TTL microcompaction across live surface `tool/result` nodes.
 * Protects the newest `keepRecentTools` successful tool outputs and never touches
 * user, assistant, system, or error tool messages.
 */
export function planMicrocompact(session, measurement, options = {}) {
  if (!session || typeof session.eventAt !== 'function') return null;

  const compactionId = options?.compactionId;
  if (typeof compactionId !== 'string' || compactionId.length === 0) return null;
  if (inspectCompactionEntryState(session).openTurn === null) return null;

  const nodes = session.surface?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  const keepRecentTools =
    Number.isFinite(options.keepRecentTools) && options.keepRecentTools >= 0
      ? Math.floor(options.keepRecentTools)
      : DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS;
  const thresholdChars =
    Number.isFinite(options.thresholdChars) && options.thresholdChars > 0
      ? options.thresholdChars
      : DEFAULT_MICROCOMPACT_THRESHOLD_CHARS;
  const headChars =
    Number.isFinite(options.headChars) && options.headChars >= 0
      ? options.headChars
      : DEFAULT_MICROCOMPACT_HEAD_CHARS;
  const tailChars =
    Number.isFinite(options.tailChars) && options.tailChars >= 0
      ? options.tailChars
      : DEFAULT_MICROCOMPACT_TAIL_CHARS;
  const repeatedReadMinChars =
    Number.isFinite(options.repeatedReadMinChars) && options.repeatedReadMinChars >= 0
      ? options.repeatedReadMinChars
      : DEFAULT_MICROCOMPACT_REPEATED_READ_MIN_CHARS;
  const maxBatchRefs =
    Number.isSafeInteger(options.maxBatchRefs) && options.maxBatchRefs > 0
      ? Math.min(options.maxBatchRefs, MAX_MASK_STAGE_REFS)
      : MAX_MASK_STAGE_REFS;

  // Protect the newest K successful tool/result outputs on the live surface.
  const hotToolSeqs = new Set();
  if (keepRecentTools > 0) {
    for (let i = nodes.length - 1; i >= 0 && hotToolSeqs.size < keepRecentTools; i -= 1) {
      const seq = nodes[i];
      const event = session.eventAt(seq);
      if (!event || event.type !== 'tool/result') continue;
      const message = event.data?.message;
      if (!message || message.isError === true) continue;
      hotToolSeqs.add(seq);
    }
  }

  const liveSet = new Set(nodes);
  const candidates = [];
  const passASeqs = new Set();

  // Pass A: Deduplicate older same-path file reads across all nodes (so a read in
  // the protected hot tail can supersede an older duplicate read).
  const supersededReads = deduplicateRepeatedFileReads(session, nodes, { minChars: repeatedReadMinChars });
  for (const [seq, info] of supersededReads) {
    if (hotToolSeqs.has(seq) || !liveSet.has(seq)) continue;
    const event = session.eventAt(seq);
    if (!event || event.type !== 'tool/result') continue;
    const message = event.data?.message;
    if (!message || message.isError === true || !Array.isArray(message.content)) continue;

    const textBlocks = message.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string');
    if (textBlocks.length === 0) continue;
    if (textBlocks.some((b) => isArchivedToolStubText(b.text)) || isArchivedToolStubText(blocksToText(message.content))) {
      continue;
    }

    const stats = inspectMaskSourceStats(session, seq, maxBatchRefs);
    if (!Number.isFinite(stats.refs) || !Number.isFinite(stats.depth) || stats.depth >= MAX_MASK_SOURCE_DEPTH) {
      continue;
    }
    const targetRefs = stats.refs + 1;
    if (targetRefs > maxBatchRefs) continue;

    const nonText = message.content.filter((b) => !(b && b.type === 'text' && typeof b.text === 'string'));
    const stubText =
      `[Earlier read of ${info.path} at seq ${seq} superseded by seq ${info.supersededBy}; ` +
      `archived at ${compactionId} seq=${seq}. Call history_read({ compactionId: ${JSON.stringify(compactionId)}, seq: ${seq} }) if exact output is needed.]`;
    const nextContent = [{ type: 'text', text: stubText }, ...nonText];

    const savedTokens = computeSavedTokens(measurement, seq, message.content, nextContent);
    if (savedTokens <= 0) continue;

    passASeqs.add(seq);
    candidates.push({ seq, nextContent, savedTokens, targetRefs, kind: 'repeated-read' });
  }

  // Pass B: Mask remaining older oversized successful tool outputs outside hotToolSeqs.
  for (const seq of nodes) {
    if (hotToolSeqs.has(seq) || passASeqs.has(seq)) continue;
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
      });
      if (masked === null) return block;
      changed = true;
      return { ...block, text: masked };
    });
    if (!changed) continue;

    const savedTokens = computeSavedTokens(measurement, seq, message.content, nextContent);
    if (savedTokens <= 0) continue;

    candidates.push({ seq, nextContent, savedTokens, targetRefs, kind: 'masked-tool' });
  }

  candidates.sort((a, b) => a.seq - b.seq);

  const targets = [];
  let batchRefs = 0;
  let hasMore = false;
  let totalTokensSaved = 0;
  let repeatedReadCount = 0;
  let maskedToolCount = 0;

  for (const candidate of candidates) {
    if (batchRefs + candidate.targetRefs > maxBatchRefs) {
      hasMore = true;
      if (batchRefs >= maxBatchRefs) break;
      continue;
    }
    targets.push({
      seq: candidate.seq,
      nextContent: candidate.nextContent,
      savedTokens: candidate.savedTokens,
    });
    batchRefs += candidate.targetRefs;
    totalTokensSaved += candidate.savedTokens;
    if (candidate.kind === 'repeated-read') repeatedReadCount += 1;
    else maskedToolCount += 1;
  }

  if (targets.length === 0 || totalTokensSaved <= 0) return null;
  return {
    compactionId,
    targets,
    totalTokensSaved,
    batchRefs,
    hasMore,
    repeatedReadCount,
    maskedToolCount,
    precision: measurement?.precision ?? 'heuristic',
  };
}

/**
 * Archive targeted tool outputs and commit microcompact surface replacements.
 */
export async function commitMicrocompact({ session, plan, archive, log, flushSession, signal } = {}) {
  const committed = await commitObservationMask({ session, plan, archive, log, flushSession, signal });
  if (!committed) return null;
  return {
    ...committed,
    repeatedReadCount: plan.repeatedReadCount ?? 0,
    maskedToolCount: plan.maskedToolCount ?? 0,
  };
}
