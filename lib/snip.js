// Phase D (Item 8) Snip: zero-LLM last-resort emergency pruning backed by
// CompactionArchive. Never modifies system head, protected recent turns/tokens,
// verified user messages, active memory rules, or checkpoints; keeps strict
// DSH V4 tool-call/result pairing and archives spans before surface mutation.

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isExternalFoldEvent as isForeignFoldEvent } from './foreign-fold.js';
import { spanEntries } from './history.js';
import { isUserInput } from './idle-compaction.js';
import { approxTokens, blocksToText } from './meter.js';
import { isExternalScriptCheckpoint, progressSourceRefs } from './progress-facts.js';
import {
  collectArchivedFiles,
  collectChildArchiveIds,
  inspectCheckpointPreserved,
  inspectCompactionEntryState,
  selectSessionMemory,
  systemHead,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from './region.js';
import {
  isExternalFoldEvent as isProvenanceExternalFoldEvent,
  withReferencePolicy,
} from './source-provenance.js';

export const DEFAULT_SNIP_KEEP_RECENT_TURNS = 2;
export const DEFAULT_SNIP_KEEP_RECENT_TOKENS = 8192;
export const DEFAULT_SNIP_MIN_SAVINGS_TOKENS = 1024;
export const DEFAULT_SNIP_MAX_SPANS_PER_RESCUE = 4;
export const DEFAULT_SNIP_COMPACTION_ID_PREFIX = 'weave-snip';
export const DEFAULT_SNIP_STUB_TOKENS = 120;
export const MAX_SNIP_STUB_TEXT_BYTES = 550;
export const MAX_SNIP_STUB_BYTES = 600;

let snipCounter = 0;

function nextSnipCompactionId(prefix = DEFAULT_SNIP_COMPACTION_ID_PREFIX) {
  snipCounter += 1;
  const cleanPrefix =
    typeof prefix === 'string' && prefix.trim().length > 0
      ? prefix.trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
      : DEFAULT_SNIP_COMPACTION_ID_PREFIX;
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${cleanPrefix}-${stamp}-${rand}-${snipCounter}`;
}

function errDetail(error) {
  try {
    const raw = error instanceof Error ? error.message : error;
    return typeof raw === 'string' ? raw : String(raw);
  } catch {
    return 'unknown error';
  }
}

function deriveMessage(session, event) {
  if (!event || typeof event !== 'object') return undefined;
  if (typeof session?.deriveEventMessage === 'function') {
    const derived = session.deriveEventMessage(event);
    if (derived !== undefined) return derived;
  }
  if (event.type === 'system/message' || event.type === 'assistant/message' || event.type === 'tool/result') {
    return event.data?.message ?? event.data;
  }
  if (event.type === 'user/message') {
    if (event.data?.role === 'user' || event.data?.content !== undefined) return event.data;
    return event.data?.message ?? event.data;
  }
  return undefined;
}

function messageTextForTokens(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) return blocksToText(message.content);
  if (typeof message.text === 'string') return message.text;
  return '';
}

function framedMessageBytes(session, event) {
  const message = deriveMessage(session, event);
  if (message && typeof message === 'object') {
    return {
      role: message.role,
      content: message.content,
      ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    };
  }
  return event ? { type: event.type, data: event.data } : null;
}

function computeSourceBytes(session, seqs) {
  const framed = [];
  for (const seq of seqs) {
    const item = framedMessageBytes(session, session.eventAt(seq));
    if (item !== null) framed.push(item);
  }
  return Buffer.byteLength(JSON.stringify(framed), 'utf8');
}

function stubMessageBytes(stubText) {
  return Buffer.byteLength(
    JSON.stringify([{ role: 'user', content: [{ type: 'text', text: stubText }] }]),
    'utf8',
  );
}

function ingestPriceMap(target, source) {
  if (!source) return;
  if (source instanceof Map) {
    for (const [seq, tokens] of source) {
      if (typeof seq === 'number' && typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) {
        target.set(seq, tokens);
      }
    }
    return;
  }
  if (typeof source === 'object' && !Array.isArray(source)) {
    for (const [rawSeq, tokens] of Object.entries(source)) {
      const seq = Number(rawSeq);
      if (Number.isInteger(seq) && typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) {
        target.set(seq, tokens);
      }
    }
  }
}

function ingestMeasuredNodes(target, nodes) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || typeof node.seq !== 'number') continue;
    const cost =
      typeof node.tokens === 'number' && Number.isFinite(node.tokens) && node.tokens >= 0
        ? node.tokens
        : typeof node.heuristicTokens === 'number' && Number.isFinite(node.heuristicTokens) && node.heuristicTokens >= 0
          ? node.heuristicTokens
          : null;
    if (cost !== null) target.set(node.seq, cost);
  }
}

function buildPricedMap(measurement) {
  const pricedBySeq = new Map();
  if (!measurement || typeof measurement !== 'object') return pricedBySeq;
  ingestPriceMap(pricedBySeq, measurement.pricedBySeq);
  ingestMeasuredNodes(pricedBySeq, measurement.nodes);
  ingestMeasuredNodes(pricedBySeq, measurement.pricedNodes);
  return pricedBySeq;
}

function measurementMatchesSurface(measurement, nodes) {
  if (!measurement || typeof measurement !== 'object') return false;
  if (typeof measurement.totalTokens !== 'number' || !Number.isFinite(measurement.totalTokens) || measurement.totalTokens < 0) {
    return false;
  }
  if (!Array.isArray(measurement.nodes)) return true;
  if (measurement.nodes.length !== nodes.length) return false;
  for (let i = 0; i < nodes.length; i += 1) {
    const item = measurement.nodes[i];
    const seq = typeof item === 'number' ? item : item?.seq;
    if (seq !== nodes[i]) return false;
  }
  return true;
}

function isCheckpointEvent(event, message) {
  if (!event || event.type !== 'user/message') return false;
  const source = event.data?.source ?? message?.source;
  return Boolean(source && typeof source === 'object' && source.kind === 'compact-checkpoint');
}

function isVerifiedUserInput(session, event, derivedMessage) {
  if (!event || event.type !== 'user/message') return false;
  if (isCheckpointEvent(event, derivedMessage)) return false;
  if (isForeignFoldEvent(event) || isProvenanceExternalFoldEvent(event, session)) return false;
  if (isExternalScriptCheckpoint(event)) return false;
  const candidate = derivedMessage ?? event.data?.message ?? event.data;
  if (!candidate || typeof candidate !== 'object') return false;
  const source = event.data?.source ?? candidate.source;
  const externalFold = event.data?.externalFold ?? candidate.externalFold;
  const normalized = {
    ...candidate,
    role: candidate.role ?? 'user',
    ...(source !== undefined ? { source } : {}),
    ...(externalFold !== undefined ? { externalFold } : {}),
  };
  return isUserInput(normalized);
}

function isPinnedNode(session, seq, event, message, activeSeqs) {
  if (!event || typeof event !== 'object') return true;
  if (event.type === 'system/message') return true;
  if (activeSeqs.has(seq)) return true;
  if (isForeignFoldEvent(event) || isProvenanceExternalFoldEvent(event, session)) return true;

  if (isCheckpointEvent(event, message)) {
    const source = event.data?.source ?? message?.source;
    if (source?.snip === true) return true;
    if (Array.isArray(source?.preserved) && source.preserved.length > 0) return true;
    if (Array.isArray(source?.memorySources) && source.memorySources.length > 0) return true;
    if (Array.isArray(source?.memoryRequirements) && source.memoryRequirements.length > 0) return true;
    if (isExternalScriptCheckpoint(event)) return true;
    const inspected = inspectCheckpointPreserved(event);
    if (!inspected.ok || inspected.preserved.length > 0) return true;
    if (messageTextForTokens(message).trim().length > 0) return true;
    return true;
  }

  if (event.type === 'user/message') {
    return isVerifiedUserInput(session, event, message);
  }
  if (event.type === 'assistant/message' || event.type === 'tool/result') {
    return false;
  }
  return true;
}

function nodeHasToolActivity(event, message) {
  if (!event || typeof event !== 'object') return false;
  if (event.type === 'tool/result') return true;
  if (event.type === 'assistant/message') {
    const content = message?.content;
    if (Array.isArray(content) && content.some((b) => b && typeof b === 'object' && b.type === 'tool-call')) {
      return true;
    }
  }
  return false;
}

function buildSnipStubText({ compactionId, startSeq, endSeq, count, files = [], childIds = [] }) {
  const core =
    `[History archived via emergency Snip (${compactionId}, seq ${startSeq}-${endSeq}, ${count} ${count === 1 ? 'entry' : 'entries'}). ` +
    `Call history_read(compactionId="${compactionId}") for original content.]`;

  const fits = (candidate) =>
    Buffer.byteLength(candidate, 'utf8') <= MAX_SNIP_STUB_TEXT_BYTES &&
    stubMessageBytes(candidate) < MAX_SNIP_STUB_BYTES;

  let text = core;
  const appendList = (label, items) => {
    if (!Array.isArray(items) || items.length === 0) return;
    const kept = [];
    for (const raw of items) {
      const clean = typeof raw === 'string' ? raw.trim() : '';
      if (!clean) continue;
      const suffix = ` ${label}: ${[...kept, clean].join(', ')}.`;
      if (fits(`${text}${suffix}`)) {
        kept.push(clean);
      } else {
        break;
      }
    }
    if (kept.length > 0) {
      text += ` ${label}: ${kept.join(', ')}.`;
    }
  };

  appendList('Archived files', files);
  appendList('Folded archives', childIds);
  return text;
}

function freshBalanceSession(session, nodes = session?.surface?.nodes ?? []) {
  return {
    eventAt: (seq) => session.eventAt(seq),
    deriveEventMessage:
      typeof session?.deriveEventMessage === 'function'
        ? (event) => session.deriveEventMessage(event)
        : undefined,
    surface: { nodes, replaceGeneration: 0 },
  };
}

function collectActiveRuleSeqs(session, nodes) {
  const memorySession =
    typeof session.deriveEventMessage === 'function'
      ? session
      : {
          ...session,
          eventAt: (seq) => session.eventAt(seq),
          deriveEventMessage: (event) => deriveMessage(session, event),
          surface: session.surface ?? { nodes },
        };
  try {
    const selection = selectSessionMemory(memorySession, nodes, {
      maxMessages: Infinity,
      maxTokens: Infinity,
    });
    return new Set((selection?.active ?? []).map((item) => item?.seq).filter((seq) => Number.isSafeInteger(seq)));
  } catch {
    return new Set();
  }
}

function resolveReferencePolicyOption(options) {
  if (options?.referencePolicy !== undefined) return options.referencePolicy;
  if (options?.extraReferenceSourceKinds !== undefined || options?.extraReferencePrefixes !== undefined) {
    return {
      ...(options.extraReferenceSourceKinds !== undefined ? { extraReferenceSourceKinds: options.extraReferenceSourceKinds } : {}),
      ...(options.extraReferencePrefixes !== undefined ? { extraReferencePrefixes: options.extraReferencePrefixes } : {}),
    };
  }
  return undefined;
}

function runWithOptionalReferencePolicy(policy, fn) {
  if (
    policy &&
    typeof policy === 'object' &&
    (policy.extraReferenceSourceKinds !== undefined || policy.extraReferencePrefixes !== undefined)
  ) {
    return withReferencePolicy(policy, fn);
  }
  return fn();
}

function planSnipCore(session, measurement, options = {}) {
  if (!session || typeof session.eventAt !== 'function') return null;
  const nodes = session.surface?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  const targetTokens =
    typeof options.targetTokens === 'number' && Number.isFinite(options.targetTokens) && options.targetTokens >= 0
      ? options.targetTokens
      : undefined;
  const keepRecentTurns =
    typeof options.keepRecentTurns === 'number' && Number.isFinite(options.keepRecentTurns) && options.keepRecentTurns >= 0
      ? Math.max(1, Math.floor(options.keepRecentTurns))
      : DEFAULT_SNIP_KEEP_RECENT_TURNS;
  const keepRecentTokens =
    typeof options.keepRecentTokens === 'number' && Number.isFinite(options.keepRecentTokens) && options.keepRecentTokens >= 0
      ? Math.floor(options.keepRecentTokens)
      : DEFAULT_SNIP_KEEP_RECENT_TOKENS;
  const minSavingsTokens =
    typeof options.minSavingsTokens === 'number' && Number.isFinite(options.minSavingsTokens) && options.minSavingsTokens >= 0
      ? Math.floor(options.minSavingsTokens)
      : DEFAULT_SNIP_MIN_SAVINGS_TOKENS;
  const maxSpansPerRescue =
    typeof options.maxSpansPerRescue === 'number' && Number.isFinite(options.maxSpansPerRescue)
      ? Math.floor(options.maxSpansPerRescue)
      : DEFAULT_SNIP_MAX_SPANS_PER_RESCUE;
  if (maxSpansPerRescue <= 0) return null;
  const compactionIdPrefix =
    typeof options.compactionIdPrefix === 'string' && options.compactionIdPrefix.trim().length > 0
      ? options.compactionIdPrefix.trim()
      : DEFAULT_SNIP_COMPACTION_ID_PREFIX;

  const pricedBySeq = buildPricedMap(measurement);
  const tokenCache = new Map();
  const tokensOf = (seq) => {
    if (tokenCache.has(seq)) return tokenCache.get(seq);
    const priced = pricedBySeq.get(seq);
    let tokens;
    if (typeof priced === 'number' && priced > 0) {
      tokens = priced;
    } else {
      const event = session.eventAt(seq);
      const message = deriveMessage(session, event);
      const computed = approxTokens(messageTextForTokens(message));
      tokens = typeof priced === 'number' && computed === 0 ? priced : computed;
    }
    tokenCache.set(seq, tokens);
    return tokens;
  };

  let sumSurfaceTokens = 0;
  for (const seq of nodes) {
    sumSurfaceTokens += tokensOf(seq);
  }
  const totalTokens = measurementMatchesSurface(measurement, nodes) ? measurement.totalTokens : sumSurfaceTokens;

  if (targetTokens !== undefined && totalTokens < targetTokens) {
    return null;
  }

  const firstEligibleIdx = systemHead(session, nodes[0]) !== undefined ? 1 : 0;
  if (firstEligibleIdx >= nodes.length) return null;

  const eventMeta = new Array(nodes.length);
  const userTurnIndices = [];
  for (let i = firstEligibleIdx; i < nodes.length; i += 1) {
    const seq = nodes[i];
    const event = session.eventAt(seq);
    const message = deriveMessage(session, event);
    eventMeta[i] = { seq, event, message };
    if (isVerifiedUserInput(session, event, message)) {
      userTurnIndices.push(i);
    }
  }

  const turnStartIdx =
    userTurnIndices.length > 0
      ? userTurnIndices[Math.max(0, userTurnIndices.length - keepRecentTurns)]
      : nodes.length;
  const latestUserIdx = userTurnIndices.length > 0 ? userTurnIndices.at(-1) : nodes.length;
  const effectiveKeepRecentTokens =
    targetTokens !== undefined && targetTokens > 0
      ? Math.min(keepRecentTokens, Math.floor(targetTokens * 0.4))
      : keepRecentTokens;

  let tokenStartIdx = nodes.length;
  let keptTokens = 0;
  for (let i = nodes.length - 1; i >= firstEligibleIdx; i -= 1) {
    keptTokens += tokensOf(nodes[i]);
    tokenStartIdx = i;
    if (keptTokens >= effectiveKeepRecentTokens) break;
  }

  let protectedStartIdx = Math.min(turnStartIdx, tokenStartIdx, latestUserIdx);
  const balanceSession = freshBalanceSession(session, nodes);
  try {
    if (protectedStartIdx < nodes.length) {
      while (protectedStartIdx > firstEligibleIdx && !toolPairingBalancedBefore(balanceSession, nodes[protectedStartIdx])) {
        protectedStartIdx -= 1;
      }
    }
  } catch {
    return null;
  }

  if (protectedStartIdx <= firstEligibleIdx) return null;

  const activeSeqs = collectActiveRuleSeqs(session, nodes);

  // Split eligible prefix [firstEligibleIdx .. protectedStartIdx - 1] into
  // maximal contiguous runs bounded by pinned nodes.
  const runs = [];
  let runStart = -1;
  for (let i = firstEligibleIdx; i < protectedStartIdx; i += 1) {
    const { seq, event, message } = eventMeta[i];
    const pinned = isPinnedNode(session, seq, event, message, activeSeqs);
    if (!pinned) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      runs.push([runStart, i - 1]);
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    runs.push([runStart, protectedStartIdx - 1]);
  }
  if (runs.length === 0) return null;

  const candidates = [];
  for (const [rawStart, rawEnd] of runs) {
    let s = rawStart;
    let e = rawEnd;
    try {
      while (s <= e && !toolPairingBalancedBefore(balanceSession, nodes[s])) {
        s += 1;
      }
      while (e >= s && !toolPairingBalancedAfter(balanceSession, nodes[e])) {
        e -= 1;
      }
    } catch {
      return null;
    }
    if (s > e) continue;

    const seqs = nodes.slice(s, e + 1);
    const startSeq = seqs[0];
    const endSeq = seqs.at(-1);
    let spanTokens = 0;
    let hasTools = false;
    for (let i = s; i <= e; i += 1) {
      spanTokens += tokensOf(nodes[i]);
      if (!hasTools && nodeHasToolActivity(eventMeta[i].event, eventMeta[i].message)) {
        hasTools = true;
      }
    }

    const compactionId = nextSnipCompactionId(compactionIdPrefix);
    const files = collectArchivedFiles(session, seqs);
    const childIds = collectChildArchiveIds(session, seqs);
    const stubText = buildSnipStubText({
      compactionId,
      startSeq,
      endSeq,
      count: seqs.length,
      files,
      childIds,
    });
    const stubTokens = Math.max(DEFAULT_SNIP_STUB_TOKENS, approxTokens(stubText));
    const savedTokens = spanTokens - stubTokens;
    if (savedTokens <= 0 || savedTokens < minSavingsTokens) continue;

    const sourceBytes = computeSourceBytes(session, seqs);
    const stubBytes = stubMessageBytes(stubText);
    if (stubBytes >= MAX_SNIP_STUB_BYTES || stubBytes >= sourceBytes) continue;

    candidates.push({
      compactionId,
      startIdx: s,
      endIdx: e,
      startSeq,
      endSeq,
      seqs,
      hasTools,
      spanTokens,
      stubTokens,
      savedTokens,
      sourceBytes,
      stubBytes,
      stubText,
      files,
      childIds,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.hasTools !== b.hasTools) return a.hasTools ? -1 : 1;
    return a.startIdx - b.startIdx;
  });

  const selected = [];
  let projectedRemainingTokens = totalTokens;
  let totalTokensSaved = 0;

  for (const candidate of candidates) {
    if (selected.length >= maxSpansPerRescue) break;
    if (targetTokens !== undefined && projectedRemainingTokens < targetTokens) break;
    selected.push(candidate);
    totalTokensSaved += candidate.savedTokens;
    projectedRemainingTokens = Math.max(0, projectedRemainingTokens - candidate.savedTokens);
  }

  if (selected.length === 0) return null;

  return {
    mode: 'snip',
    spans: selected.map(({ startIdx: _s, endIdx: _e, ...rest }) => rest),
    totalTokens,
    targetTokens: targetTokens ?? null,
    totalTokensSaved,
    projectedRemainingTokens,
    protectedTailSeqs: nodes.slice(protectedStartIdx),
    hasMore: selected.length < candidates.length,
    precision: measurement?.precision ?? 'heuristic',
  };
}

/**
 * Plan zero-LLM emergency Snip pruning of contiguous old tool loops, developer
 * scaffolding, and untrusted reference spans outside protected boundaries.
 * Does not mutate `session` or write to `archive`.
 */
export function planSnip(session, measurement, options = {}) {
  const referencePolicy = resolveReferencePolicyOption(options);
  return runWithOptionalReferencePolicy(referencePolicy, () => planSnipCore(session, measurement, options));
}

function isLiveContiguousSpan(session, seqs) {
  if (!Array.isArray(seqs) || seqs.length === 0) return false;
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return false;
  const seen = new Set();
  for (const seq of seqs) {
    if (!Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0) || seen.has(seq)) return false;
    seen.add(seq);
  }
  const sysHead = systemHead(session, nodes[0]);
  if (sysHead !== undefined && seen.has(nodes[0])) return false;

  const startIdx = nodes.indexOf(seqs[0]);
  if (startIdx < 0 || startIdx + seqs.length > nodes.length) return false;
  for (let i = 0; i < seqs.length; i += 1) {
    if (nodes[startIdx + i] !== seqs[i]) return false;
  }

  try {
    const balanceSession = freshBalanceSession(session, nodes);
    if (!toolPairingBalancedBefore(balanceSession, seqs[0])) return false;
    if (!toolPairingBalancedAfter(balanceSession, seqs.at(-1))) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Archive planned Snip spans first and commit synchronized `compaction/prune`
 * and compact `compact-checkpoint` stub replacements onto the live surface.
 */
export async function commitSnip({ session, plan, archive, log, flushSession, signal } = {}) {
  if (
    !session ||
    typeof session.append !== 'function' ||
    !plan ||
    !Array.isArray(plan.spans) ||
    plan.spans.length === 0 ||
    !archive ||
    typeof archive.writeSpan !== 'function'
  ) {
    return null;
  }
  const hasOpenCompaction = (st) =>
    st.unmatchedCompactionStart !== null &&
    (st.latestEndSeedSeq === null || st.unmatchedCompactionStart > st.latestEndSeedSeq);
  const initialEntryState = inspectCompactionEntryState(session);
  if (initialEntryState.openTurn === null || hasOpenCompaction(initialEntryState)) {
    return null;
  }
  signal?.throwIfAborted?.();

  // Process spans in descending startSeq order so earlier surface splice
  // operations never shift indices of remaining spans.
  const ordered = plan.spans
    .map((span, planIndex) => ({ span, planIndex }))
    .filter(({ span }) => span && Array.isArray(span.seqs) && span.seqs.length > 0)
    .sort((a, b) => (b.span.startSeq ?? b.span.seqs[0]) - (a.span.startSeq ?? a.span.seqs[0]));

  const committedEntries = [];
  let surfaceMutated = false;

  const tagMutationError = (error, messagePrefix) => {
    const detail = errDetail(error);
    const tagged = new Error(detail ? `${messagePrefix}: ${detail}` : messagePrefix);
    tagged.code = 'commit';
    tagged.compactionStage = 'commit';
    tagged.surfaceMutated = true;
    tagged.cause = error;
    return tagged;
  };

  for (const { span, planIndex } of ordered) {
    signal?.throwIfAborted?.();
    const preEntryState = inspectCompactionEntryState(session);
    if (preEntryState.openTurn === null || hasOpenCompaction(preEntryState)) break;
    if (!isLiveContiguousSpan(session, span.seqs)) continue;

    const compactionId =
      typeof span.compactionId === 'string' && span.compactionId.length > 0
        ? span.compactionId
        : nextSnipCompactionId();
    const startSeq = span.startSeq ?? span.seqs[0];
    const endSeq = span.endSeq ?? span.seqs.at(-1);
    const savedTokens =
      typeof span.savedTokens === 'number' && Number.isFinite(span.savedTokens) && span.savedTokens > 0
        ? span.savedTokens
        : 0;

    let entries;
    try {
      entries = spanEntries(session, span.seqs);
    } catch (error) {
      log?.('warn', `snip span ${compactionId} skipped before archive: ${errDetail(error)}`);
      continue;
    }

    const archivePath = await archive.writeSpan({
      sessionId: session.id,
      compactionId,
      entries,
      signal,
    });
    if (!archivePath) {
      try {
        signal?.throwIfAborted?.();
      } catch (abortError) {
        if (surfaceMutated && abortError && typeof abortError === 'object') {
          try { abortError.surfaceMutated = true; } catch { /* frozen */ }
        }
        throw abortError;
      }
      log?.('warn', `snip archive write failed for ${compactionId}; skipping span`);
      continue;
    }

    try {
      signal?.throwIfAborted?.();
    } catch (abortError) {
      await rm(archivePath, { force: true }).catch(() => {});
      if (surfaceMutated && abortError && typeof abortError === 'object') {
        try { abortError.surfaceMutated = true; } catch { /* frozen */ }
      }
      throw abortError;
    }

    const postEntryState = inspectCompactionEntryState(session);
    if (postEntryState.openTurn === null || hasOpenCompaction(postEntryState)) {
      await rm(archivePath, { force: true }).catch(() => {});
      break;
    }
    if (!isLiveContiguousSpan(session, span.seqs)) {
      await rm(archivePath, { force: true }).catch(() => {});
      continue;
    }
    const openTurn = postEntryState.openTurn;

    const files = Array.isArray(span.files) ? span.files : collectArchivedFiles(session, span.seqs);
    const childIds = Array.isArray(span.childIds) ? span.childIds : collectChildArchiveIds(session, span.seqs);
    const stubText =
      typeof span.stubText === 'string' &&
      span.stubText.length > 0 &&
      Buffer.byteLength(span.stubText, 'utf8') <= MAX_SNIP_STUB_TEXT_BYTES
        ? span.stubText
        : buildSnipStubText({
            compactionId,
            startSeq,
            endSeq,
            count: span.seqs.length,
            files,
            childIds,
          });

    const stubData = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: stubText }],
      source: {
        kind: 'compact-checkpoint',
        compactionId,
        provider: 'local',
        model: 'weave-snip',
        snip: true,
        preserved: [],
        memorySources: [],
        memoryDecisions: [],
        progressFacts: progressSourceRefs(),
        shadowedRange: { start: startSeq, end: endSeq },
        shadowedCount: span.seqs.length,
      },
    };

    // Synchronous V4 compaction envelope (zero awaits between appends so no
    // surface write can interleave and DSH V4 stored-log validation passes).
    let startEvent;
    let summaryEvent;
    let stubEvent;
    let endEvent;
    try {
      startEvent = session.append('compaction/start', { compactionId, turn: openTurn });
      surfaceMutated = true;
      summaryEvent = session.append('compaction/summary', {
        compactionId,
        summary: [{ type: 'text', text: stubText }],
        shadowedRange: { start: startSeq, end: endSeq },
        shadowedSeqs: [...span.seqs],
        shadowedTokenCount: savedTokens,
        provider: 'local',
        model: 'weave-snip',
      });
      stubEvent = session.append('user/message', stubData, {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...span.seqs],
      });
    } catch (error) {
      if (startEvent !== undefined) {
        try {
          session.append('compaction/end', {
            compactionId,
            turn: openTurn,
            error: (errDetail(error) || 'snip surface rewrite failed').slice(0, 2000),
          });
        } catch {
          /* best-effort lock closure */
        }
      }
      throw tagMutationError(error, 'snip surface rewrite failed');
    }
    try {
      endEvent = session.append('compaction/end', { compactionId, turn: openTurn });
    } catch (endError) {
      try {
        endEvent = session.append('compaction/end', {
          compactionId,
          turn: openTurn,
          error: `compaction/end failed once and was retried: ${errDetail(endError) || 'unknown error'}`.slice(0, 2000),
        });
      } catch {
        /* best-effort retry after surface replacement */
      }
      throw tagMutationError(endError, 'snip compaction/end failed');
    }

    committedEntries.push({
      planIndex,
      result: {
        compactionId,
        startSeq,
        endSeq,
        shadowedSeqs: [...span.seqs],
        shadowedRange: { start: startSeq, end: endSeq },
        shadowedTokenCount: savedTokens,
        startSeqEvent: startEvent.seq,
        summarySeq: summaryEvent.seq,
        stubSeq: stubEvent.seq,
        endSeqEvent: endEvent.seq,
        archivePath,
        stubBytes: Buffer.byteLength(stubText, 'utf8'),
      },
    });
  }

  if (committedEntries.length === 0) return null;

  if (typeof flushSession === 'function') {
    try {
      await flushSession(session);
    } catch (error) {
      const flushErr = tagMutationError(error, 'snip flush failed');
      try {
        log?.('warn', flushErr.message);
      } catch {
        /* never preempt tagged commit failure after surface mutation */
      }
      throw flushErr;
    }
  }

  committedEntries.sort((a, b) => a.planIndex - b.planIndex);
  const results = committedEntries.map((entry) => entry.result);
  const shadowedSeqs = results.flatMap((r) => r.shadowedSeqs).sort((a, b) => a - b);
  const shadowedRange = { start: shadowedSeqs[0], end: shadowedSeqs.at(-1) };
  const shadowedTokenCount = results.reduce((sum, r) => sum + r.shadowedTokenCount, 0);
  const compactionIds = results.map((r) => r.compactionId);
  const archivePaths = results.map((r) => r.archivePath);
  const stubSeqs = results.map((r) => r.stubSeq);

  return {
    compactionId: results[0].compactionId,
    compactionIds,
    mode: 'snip',
    snippedSpans: results,
    shadowedSeqs,
    shadowedRange,
    shadowedTokenCount,
    shadowedTokenPrecision: plan.precision ?? 'heuristic',
    archivePaths,
    provider: 'local',
    model: 'weave-snip',
    stubSeqs,
  };
}
