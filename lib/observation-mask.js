// Stage-1 zero-LLM-cost observation masking backed by CompactionArchive.
// Replaces oversized successful tool outputs outside the retain tail with
// archive pointers (keeping head/tail slices & non-text blocks intact) and
// preserves the DSH assertToolResultRewrite invariant (only message.content
// changes on replacement tool/result events).

import { rm } from 'node:fs/promises';
import { approxTokens, blocksToText } from './meter.js';
import { spanEntries } from './history.js';
import { selectCompactableRange } from './region.js';

export const OBSERVATION_MASK_MARKER = '[Output masked; archived at ';
const MAX_MASK_SOURCE_DEPTH = 63;
const MAX_MASK_STAGE_REFS = 3840;

function errDetail(error) {
  try {
    const raw = error instanceof Error ? error.message : error;
    return typeof raw === 'string' ? raw : String(raw);
  } catch {
    return 'unknown error';
  }
}

function toolSourceStats(session, rootSeq) {
  if (!Number.isSafeInteger(rootSeq) || rootSeq < 0) return { depth: Infinity, refs: Infinity };
  const visited = new Set([rootSeq]);
  const queue = [rootSeq];
  const expanded = [];
  let refs = 0;

  for (let head = 0; head < queue.length; head += 1) {
    const seq = queue[head];
    const event = session.eventAt(seq);
    if (!event) return { depth: Infinity, refs: Infinity };
    if (event.type === 'tool/call') continue;
    if (event.type !== 'tool/result') return { depth: Infinity, refs: Infinity };
    if (event.sourceEventSeqs === undefined) continue;
    if (!Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length === 0) {
      return { depth: Infinity, refs: Infinity };
    }
    refs += event.sourceEventSeqs.length;
    if (refs > MAX_MASK_STAGE_REFS || visited.size > MAX_MASK_STAGE_REFS) {
      return { depth: Infinity, refs: Infinity };
    }
    expanded.push(seq);
    for (const sourceSeq of event.sourceEventSeqs) {
      if (!Number.isSafeInteger(sourceSeq) || sourceSeq < 0 || sourceSeq >= seq) {
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
  'TargetFile',
  'AbsolutePath',
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
  if (Array.isArray(toolResultEvent?.sourceEventSeqs)) {
    for (let i = toolResultEvent.sourceEventSeqs.length - 1; i >= 0; i -= 1) {
      const candidate = session.eventAt?.(toolResultEvent.sourceEventSeqs[i]);
      if (candidate?.type === 'tool/call') {
        callEvent = candidate;
        break;
      }
    }
  }
  if (!callEvent && callId && typeof session.eventAt === 'function') {
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
              data: { name: match.toolName ?? match.name, arguments: match.args ?? match.arguments },
            };
            break;
          }
        }
      }
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

function buildMaskedBlockText(text, { compactionId, seq, toolName, target, thresholdChars, headChars, tailChars }) {
  if (typeof text !== 'string' || text.length < thresholdChars) return null;
  if (text.includes(OBSERVATION_MASK_MARKER)) return null;
  const cps = Array.from(text);
  if (cps.length < thresholdChars) return null;

  const head = headChars > 0 ? cps.slice(0, headChars).join('') : '';
  const tailStart = Math.max(headChars, cps.length - tailChars);
  const tail = tailChars > 0 && tailStart < cps.length ? cps.slice(tailStart).join('') : '';
  const omitted = Math.max(0, cps.length - headChars - (cps.length - tailStart));
  if (omitted <= 0) return null;

  const meta = [toolName, target ? JSON.stringify(target) : ''].filter(Boolean).join(' ');
  const marker =
    `${OBSERVATION_MASK_MARKER}${compactionId} seq=${seq}` +
    `${meta ? ` (${meta})` : ''}; omitted ${omitted} chars of ${cps.length}. ` +
    `Call history_read({ compactionId: ${JSON.stringify(compactionId)}, seq: ${seq} }) if exact output is needed.]`;
  const masked = `${head ? `${head}\n` : ''}${marker}${tail ? `\n${tail}` : ''}`;
  if (approxTokens(masked) >= approxTokens(text)) return null;
  return masked;
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

  let baseSpanRefs = 0;
  const candidateStats = new Map();
  for (let i = startIdx; i <= endIdx; i += 1) {
    const seq = nodes[i];
    const event = session.eventAt(seq);
    if (!event || event.type !== 'tool/result') continue;
    const stats = toolSourceStats(session, seq);
    candidateStats.set(seq, stats);
    if (!Number.isFinite(stats.refs)) return null;
    baseSpanRefs += stats.refs;
  }
  if (baseSpanRefs >= MAX_MASK_STAGE_REFS) return null;

  const targets = [];
  let addedMaskRefs = 0;
  let totalTokensSaved = 0;

  for (let i = startIdx; i <= endIdx; i += 1) {
    const seq = nodes[i];
    const event = session.eventAt(seq);
    if (!event || event.type !== 'tool/result') continue;
    const message = event.data?.message;
    if (!message || message.isError === true || !Array.isArray(message.content)) continue;
    const stats = candidateStats.get(seq) ?? toolSourceStats(session, seq);
    if (stats.depth >= MAX_MASK_SOURCE_DEPTH) continue;
    if (baseSpanRefs + addedMaskRefs + 1 > MAX_MASK_STAGE_REFS) continue;

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

    targets.push({ seq, nextContent, savedTokens });
    addedMaskRefs += 1;
    totalTokensSaved += savedTokens;
  }

  if (targets.length === 0 || totalTokensSaved <= 0) return null;
  return {
    compactionId,
    range,
    targets,
    totalTokensSaved,
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

  const operations = ready.map(({ item, event }) => ({
    item,
    nextData: {
      ...event.data,
      message: {
        ...event.data.message,
        content: item.nextContent,
      },
    },
  }));

  const maskedSeqs = [];
  let shadowedTokenCount = 0;

  // Synchronous append batch: emit prune accounting + single-node replacement
  // with zero awaits in between so no surface write can interleave.
  try {
    for (const { item, nextData } of operations) {
      session.append('compaction/prune', {
        shadowedRange: { start: item.seq, end: item.seq },
        shadowedSeqs: [item.seq],
        shadowedTokenCount: item.savedTokens,
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
