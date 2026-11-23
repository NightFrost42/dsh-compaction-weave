// Stage-1 zero-LLM-cost observation masking backed by CompactionArchive.
// Replaces oversized successful tool outputs outside the retain tail with
// archive pointers (keeping head/tail slices & non-text blocks intact) and
// preserves the DSH assertToolResultRewrite invariant (only message.content
// changes on replacement tool/result events).

import { Buffer } from 'node:buffer';
import { rm } from 'node:fs/promises';
import { approxTokens, blocksToText, estimateHostHeuristicMessage } from './meter.js';
import { spanEntries } from './history.js';
import { inspectCompactionEntryState, selectCompactableRange } from './region.js';
import {
  buildToolPreview,
  codePointLength,
  sliceCodePointsEnd,
  sliceCodePointsStart,
} from './tool-preview.js';

export const OBSERVATION_MASK_MARKER = '[Output masked; archived at ';
export const PERSISTED_OUTPUT_MARKER = '[Large tool output persisted; archived at ';
export const MICROCOMPACT_SUPERSEDED_MARKER = '[Earlier read of ';
export const MAX_MASK_SOURCE_DEPTH = 63;
export const MAX_MASK_STAGE_REFS = 3840;

export function isArchivedToolStubText(text) {
  if (typeof text !== 'string') return false;
  return (
    text.includes(OBSERVATION_MASK_MARKER) ||
    text.includes(PERSISTED_OUTPUT_MARKER) ||
    (text.includes(MICROCOMPACT_SUPERSEDED_MARKER) && text.includes('history_read('))
  );
}

function errDetail(error) {
  try {
    const raw = error instanceof Error ? error.message : error;
    return typeof raw === 'string' ? raw : String(raw);
  } catch {
    return 'unknown error';
  }
}

function callIdOf(event) {
  if (event?.type === 'tool/call') {
    return typeof event.data?.callId === 'string' && event.data.callId.length > 0 ? event.data.callId : null;
  }
  if (event?.type !== 'tool/result') return null;
  const message = event.data?.message;
  const id = message?.toolCallId ?? message?.source?.callId;
  if (
    message?.toolCallId !== undefined &&
    message?.source?.callId !== undefined &&
    message.toolCallId !== message.source.callId
  ) {
    return null;
  }
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function toolSourceStats(session, rootSeq, refLimit = MAX_MASK_STAGE_REFS) {
  if (!session || typeof session.eventAt !== 'function') {
    return { depth: Infinity, refs: Infinity };
  }
  if (!Number.isSafeInteger(rootSeq) || rootSeq < 0 || Object.is(rootSeq, -0)) {
    return { depth: Infinity, refs: Infinity };
  }
  const visited = new Set([rootSeq]);
  const queue = [rootSeq];
  const expanded = [];
  let refs = 0;

  for (let head = 0; head < queue.length; head += 1) {
    const seq = queue[head];
    const event = session.eventAt(seq);
    if (!event || event.seq !== seq) return { depth: Infinity, refs: Infinity };
    if (event.type === 'tool/call') continue;
    if (event.type !== 'tool/result') return { depth: Infinity, refs: Infinity };
    if (event.sourceEventSeqs === undefined) continue;
    if (!Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length === 0) {
      return { depth: Infinity, refs: Infinity };
    }
    const id = callIdOf(event);
    if (!id) return { depth: Infinity, refs: Infinity };
    refs += event.sourceEventSeqs.length;
    if (refs > refLimit || visited.size > refLimit) {
      return { depth: Infinity, refs: Infinity };
    }
    expanded.push(seq);
    const unique = new Set();
    for (const sourceSeq of event.sourceEventSeqs) {
      if (!Number.isSafeInteger(sourceSeq) || sourceSeq < 0 || Object.is(sourceSeq, -0) || sourceSeq >= seq || unique.has(sourceSeq)) {
        return { depth: Infinity, refs: Infinity };
      }
      unique.add(sourceSeq);
      const source = session.eventAt(sourceSeq);
      if (!source || source.seq !== sourceSeq) return { depth: Infinity, refs: Infinity };
      if ((source.type !== 'tool/result' && source.type !== 'tool/call') || callIdOf(source) !== id) {
        return { depth: Infinity, refs: Infinity };
      }
      if (!visited.has(sourceSeq)) {
        visited.add(sourceSeq);
        queue.push(sourceSeq);
      }
    }
  }

  // Topological longest-path computation (matches historySourceSeqs) so a node
  // directly citing an ancient predecessor cannot disguise an unsafe chain depth.
  expanded.sort((a, b) => a - b);
  const depths = new Map();
  let maxDepth = 0;
  for (const seq of expanded) {
    let depth = 0;
    for (const sourceSeq of session.eventAt(seq).sourceEventSeqs) {
      depth = Math.max(depth, 1 + (depths.get(sourceSeq) ?? 0));
    }
    if (depth >= MAX_MASK_SOURCE_DEPTH) return { depth: Infinity, refs };
    depths.set(seq, depth);
    maxDepth = Math.max(maxDepth, depth);
  }
  return { depth: maxDepth, refs };
}

const LOCATOR_KEYS = [
  'path',
  'file_path',
  'filePath',
  'target_file',
  'targetFile',
  'TargetFile',
  'AbsolutePath',
  'absolute_path',
  'file',
  'filename',
  'DirectoryPath',
  'directory',
  'pattern',
  'Pattern',
  'query',
  'command',
  'CommandLine',
  'url',
];

function findToolLocator(session, seq, toolResultEvent) {
  const callId = toolResultEvent?.data?.message?.toolCallId ?? toolResultEvent?.data?.message?.source?.callId;
  let callEvent;
  if (Array.isArray(toolResultEvent?.sourceEventSeqs) && typeof session?.eventAt === 'function') {
    for (let i = toolResultEvent.sourceEventSeqs.length - 1; i >= 0; i -= 1) {
      const candidate = session.eventAt(toolResultEvent.sourceEventSeqs[i]);
      if (candidate?.type === 'tool/call') {
        callEvent = candidate;
        break;
      }
    }
  }
  if (!callEvent && callId && typeof session?.eventAt === 'function') {
    const floor = Math.max(0, seq - 32);
    for (let s = seq - 1; s >= floor; s -= 1) {
      const candidate = session.eventAt(s);
      if (candidate?.type === 'tool/call' && candidate.data?.callId === callId) {
        callEvent = candidate;
        break;
      }
      if (candidate?.type === 'assistant/message') {
        const blocks = candidate.data?.message?.content;
        if (Array.isArray(blocks)) {
          const match = blocks.find(
            (b) => b?.type === 'tool-call' && (b.callId === callId || b.id === callId),
          );
          if (match) {
            callEvent = {
              type: 'tool/call',
              data: { name: match.toolName ?? match.name, arguments: match.args ?? match.arguments ?? match.input },
            };
            break;
          }
        }
      }
    }
  }
  if (!callEvent) {
    if (typeof toolResultEvent?.data?.name === 'string') {
      callEvent = {
        type: 'tool/call',
        data: { name: toolResultEvent.data.name, arguments: toolResultEvent.data.arguments },
      };
    } else if (typeof toolResultEvent?.data?.message?.toolName === 'string') {
      const msg = toolResultEvent.data.message;
      callEvent = {
        type: 'tool/call',
        data: { name: msg.toolName, arguments: msg.toolArguments ?? msg.arguments },
      };
    }
  }

  const toolName = callEvent?.data?.name ?? '';
  let args = callEvent?.data?.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = undefined;
    }
  }
  let target = '';
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    for (const key of LOCATOR_KEYS) {
      const value = args[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        target = value.trim().slice(0, 120);
        break;
      }
    }
  }
  return { toolName, target };
}

function buildMaskedBlockText(text, options = {}) {
  const {
    compactionId,
    seq,
    toolName = '',
    target = '',
    thresholdChars = 4000,
    headChars = 300,
    tailChars = 300,
    markerPrefix = OBSERVATION_MASK_MARKER,
  } = options;
  const minChars = Number.isFinite(thresholdChars) ? thresholdChars : 0;
  if (typeof text !== 'string' || text.length < minChars) return null;
  if (isArchivedToolStubText(text)) return null;
  const totalChars = codePointLength(text);
  if (totalChars < minChars) return null;

  const safeHead = Number.isFinite(headChars) && headChars > 0 ? Math.floor(headChars) : 0;
  const safeTail = Number.isFinite(tailChars) && tailChars > 0 ? Math.floor(tailChars) : 0;
  const prefix = typeof markerPrefix === 'string' && markerPrefix.length > 0 ? markerPrefix : OBSERVATION_MASK_MARKER;
  const meta = [toolName, target ? JSON.stringify(target) : ''].filter(Boolean).join(' ');
  const origTokens = approxTokens(text);
  const origBytes = Buffer.byteLength(text, 'utf8');

  const preview = buildToolPreview(text, {
    headChars: safeHead,
    tailChars: safeTail,
    toolName,
    target,
  });
  if (preview) {
    const omitted = Math.max(0, totalChars - preview.keptChars);
    if (omitted > 0) {
      const marker =
        `${prefix}${compactionId} seq=${seq}` +
        `${meta ? ` (${meta})` : ''}; preview=${preview.kind}; omitted ${omitted} chars of ${totalChars}. ` +
        `Call history_read({ compactionId: ${JSON.stringify(compactionId)}, seq: ${seq} }) or history_search({ query }) if exact output is needed.]`;
      const masked = [preview.head, marker, preview.middle, preview.tail].filter(Boolean).join('\n');
      if (approxTokens(masked) < origTokens && Buffer.byteLength(masked, 'utf8') < origBytes) {
        return masked;
      }
    }
  }

  const head = safeHead > 0 ? sliceCodePointsStart(text, Math.min(safeHead, totalChars)) : '';
  const keptHead = Math.min(safeHead, totalChars);
  const tailStart = Math.max(keptHead, totalChars - safeTail);
  const tailCount = totalChars - tailStart;
  const tail = safeTail > 0 && tailCount > 0 ? sliceCodePointsEnd(text, tailCount) : '';
  const omitted = Math.max(0, totalChars - keptHead - tailCount);
  if (omitted <= 0) return null;

  const marker =
    `${prefix}${compactionId} seq=${seq}` +
    `${meta ? ` (${meta})` : ''}; omitted ${omitted} chars of ${totalChars}. ` +
    `Call history_read({ compactionId: ${JSON.stringify(compactionId)}, seq: ${seq} }) if exact output is needed.]`;
  const masked = `${head ? `${head}\n` : ''}${marker}${tail ? `\n${tail}` : ''}`;
  if (approxTokens(masked) >= origTokens || Buffer.byteLength(masked, 'utf8') >= origBytes) return null;
  return masked;
}

export function inspectMaskSourceStats(session, rootSeq, refLimit = MAX_MASK_STAGE_REFS) {
  return toolSourceStats(session, rootSeq, refLimit);
}

export function extractToolLocator(session, seq, toolResultEvent) {
  return findToolLocator(session, seq, toolResultEvent);
}

export function formatMaskedToolText(text, options = {}) {
  return buildMaskedBlockText(text, options);
}

/**
 * Plan deterministic Stage-1 observation masking outside the retain tail.
 * Does not mutate `session` or write to `archive`.
 */
export function planObservationMask(session, measurement, retainTokens, options = {}) {
  if (!session || !measurement || typeof session.eventAt !== 'function') return null;
  const nodes = session.surface?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  const compactionId = options.compactionId;
  if (typeof compactionId !== 'string' || compactionId.length === 0) return null;

  const range = selectCompactableRange(session, measurement, retainTokens ?? 0);
  if (!range) return null;

  const startIdx = nodes.indexOf(range.start);
  const endIdx = nodes.indexOf(range.end);
  if (startIdx < 0 || endIdx < startIdx) return null;

  const thresholdChars = Number.isFinite(options.thresholdChars) ? options.thresholdChars : 4000;
  const headChars = Number.isFinite(options.headChars) ? options.headChars : 300;
  const tailChars = Number.isFinite(options.tailChars) ? options.tailChars : 300;
  const maxBatchRefs =
    Number.isSafeInteger(options.maxBatchRefs) && options.maxBatchRefs > 0
      ? Math.min(options.maxBatchRefs, MAX_MASK_STAGE_REFS)
      : MAX_MASK_STAGE_REFS;

  const targets = [];
  let batchRefs = 0;
  let hasMore = false;
  let totalTokensSaved = 0;

  for (let i = startIdx; i <= endIdx; i += 1) {
    const seq = nodes[i];
    const event = session.eventAt(seq);
    if (!event || event.type !== 'tool/result') continue;
    const message = event.data?.message;
    if (!message || message.isError === true || !Array.isArray(message.content)) continue;

    // Skip individually invalid, unmappable, or over-depth tool/result nodes
    // rather than aborting observation masking for the entire span.
    const stats = toolSourceStats(session, seq, maxBatchRefs);
    if (!Number.isFinite(stats.refs) || !Number.isFinite(stats.depth) || stats.depth >= MAX_MASK_SOURCE_DEPTH) {
      continue;
    }
    const targetRefs = stats.refs + 1;
    if (targetRefs > maxBatchRefs) continue;

    const { toolName, target } = findToolLocator(session, seq, event);
    let changed = false;
    const nextContent = message.content.map((block) => {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') return block;
      const masked = buildMaskedBlockText(block.text, {
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

    const deltaTokens = Math.max(0, approxTokens(blocksToText(message.content)) - approxTokens(blocksToText(nextContent)));
    const pricedNodeTokens = measurement.pricedBySeq?.get(seq);
    const savedTokens =
      typeof pricedNodeTokens === 'number' && Number.isFinite(pricedNodeTokens)
        ? Math.min(pricedNodeTokens, deltaTokens)
        : deltaTokens;
    if (savedTokens <= 0) continue;

    // Bound provenance ref count across SELECTED targets only so sessions with
    // >3,840 tool results can be masked cleanly across multiple passes.
    if (batchRefs + targetRefs > maxBatchRefs) {
      hasMore = true;
      if (batchRefs >= maxBatchRefs) break;
      continue;
    }

    targets.push({ seq, nextContent, savedTokens });
    batchRefs += targetRefs;
    totalTokensSaved += savedTokens;
  }

  if (targets.length === 0 || totalTokensSaved <= 0) return null;
  return {
    compactionId,
    range,
    targets,
    totalTokensSaved,
    batchRefs,
    hasMore,
    precision: measurement.precision ?? 'heuristic',
  };
}

/**
 * Archive targeted tool outputs and commit synchronized surface replacements.
 */
export async function commitObservationMask({ session, plan, archive, log, flushSession, signal }) {
  if (!session || !plan || !Array.isArray(plan.targets) || plan.targets.length === 0 || !archive) {
    return null;
  }
  // DSH V4 payload/relationship validation (requireTurn) forbids appending ANY
  // `tool/result` event — including surfaceOp: replace — outside an open turn.
  // Idle /compact and bili-migrate have openTurn === null and rely instead on
  // in-request tool projection without mutating disk tool/result events.
  if (inspectCompactionEntryState(session).openTurn === null) {
    return null;
  }
  signal?.throwIfAborted?.();

  const collectReady = () => {
    const live = new Set(session.surface?.nodes ?? []);
    const out = [];
    for (const item of plan.targets) {
      if (!live.has(item.seq)) continue;
      const event = session.eventAt(item.seq);
      if (!event || event.type !== 'tool/result' || !event.data?.message || typeof event.data.message !== 'object') {
        continue;
      }
      out.push({ item, event });
    }
    return out;
  };

  const initialReady = collectReady();
  if (initialReady.length === 0) return null;

  const seqs = initialReady.map(({ item }) => item.seq);
  const entries = spanEntries(session, seqs);
  const archivePath = await archive.writeSpan({
    sessionId: session.id,
    compactionId: plan.compactionId,
    entries,
    signal,
  });
  if (!archivePath) return null;

  try {
    signal?.throwIfAborted?.();
  } catch (abortError) {
    await rm(archivePath, { force: true }).catch(() => {});
    throw abortError;
  }
  const ready = collectReady();
  if (ready.length === 0) {
    await rm(archivePath, { force: true }).catch(() => {});
    return null;
  }

  const operations = ready.map(({ item, event }) => {
    const origMessage =
      typeof session.deriveEventMessage === 'function'
        ? session.deriveEventMessage(event)
        : (event?.data?.message ?? event?.data);
    return {
      item,
      grossShadowedTokens: estimateHostHeuristicMessage(origMessage),
      nextData: {
        ...event.data,
        message: {
          ...event.data.message,
          content: item.nextContent,
        },
      },
    };
  });

  const maskedSeqs = [];
  let shadowedTokenCount = 0;

  // Synchronous append batch: emit prune accounting + single-node replacement
  // with zero awaits in between so no surface write can interleave.
  try {
    for (const { item, grossShadowedTokens, nextData } of operations) {
      session.append('compaction/prune', {
        shadowedRange: { start: item.seq, end: item.seq },
        shadowedSeqs: [item.seq],
        shadowedTokenCount: grossShadowedTokens,
      });
      session.append('tool/result', nextData, {
        surfaceOp: { op: 'replace', startSeq: item.seq, endSeq: item.seq },
        sourceEventSeqs: [item.seq],
      });
      maskedSeqs.push(item.seq);
      shadowedTokenCount += item.savedTokens;
    }
  } catch (error) {
    const appendErr = new Error('observation mask surface rewrite failed');
    appendErr.code = 'commit';
    appendErr.compactionStage = 'commit';
    appendErr.surfaceMutated = true;
    appendErr.cause = error;
    const detail = errDetail(error);
    if (detail) appendErr.message = `observation mask surface rewrite failed: ${detail}`;
    throw appendErr;
  }

  if (maskedSeqs.length === 0) return null;

  if (typeof flushSession === 'function') {
    try {
      await flushSession(session);
    } catch (error) {
      const detail = errDetail(error);
      const flushErr = new Error(`observation mask flush failed: ${detail}`);
      flushErr.code = 'commit';
      flushErr.compactionStage = 'commit';
      flushErr.surfaceMutated = true;
      flushErr.cause = error;
      try {
        log?.('warn', `observation mask flush failed: ${detail}`);
      } catch {
        /* never preempt tagged commit failure after surface mutation */
      }
      throw flushErr;
    }
  }

  return {
    compactionId: plan.compactionId,
    mode: 'observation-mask',
    maskedCount: maskedSeqs.length,
    maskedSeqs,
    shadowedRange: { start: maskedSeqs[0], end: maskedSeqs.at(-1) },
    shadowedSeqs: maskedSeqs,
    shadowedTokenCount,
    shadowedTokenPrecision: plan.precision ?? 'heuristic',
    summary: [],
    provider: 'local',
    model: 'observation-mask',
    archivePath,
  };
}
