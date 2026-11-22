// Expired-TTL progressive Context Collapse span selector and idle summary skip
// predicate. Runs strictly on uncollapsed raw prefixes (never collapsing leading
// system prompts or checkpoints), preserves balanced tool-call pairs and the
// strictest recent working tail, and keeps zero circular imports with engine.js.

import { DEFAULT_CONFIG } from './config.js';
import { isExternalFoldEvent as isForeignFoldEvent } from './foreign-fold.js';
import { isUserInput } from './idle-compaction.js';
import { approxTokens, blocksToText } from './meter.js';
import {
  systemHead,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from './region.js';
import {
  isExternalFoldEvent as isProvenanceExternalFoldEvent,
  withReferencePolicy,
} from './source-provenance.js';

export const DEFAULT_CONTEXT_COLLAPSE_ENABLED = false;
export const DEFAULT_CONTEXT_COLLAPSE_MIN_TOKENS = 49152;
export const DEFAULT_CONTEXT_COLLAPSE_MAX_SPAN_TOKENS = 32768;
export const DEFAULT_CONTEXT_COLLAPSE_KEEP_RECENT_TOKENS = 8192;
export const DEFAULT_CONTEXT_COLLAPSE_KEEP_RECENT_TURNS = 2;
export const DEFAULT_CONTEXT_COLLAPSE_MIN_SPAN_NODES = 4;
export const DEFAULT_CONTEXT_COLLAPSE_MIN_SPAN_TOKENS = 4096;

function pickNonNegativeFinite(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

function pickPositiveFinite(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return null;
}

function resolveNonNegativeInt(overrideVal, policyVal, fallback) {
  for (const candidate of [overrideVal, policyVal]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
      return Math.floor(candidate);
    }
  }
  return fallback;
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

function deriveMessage(session, event) {
  if (!event || typeof event !== 'object') return undefined;
  if (typeof session.deriveEventMessage === 'function') {
    return session.deriveEventMessage(event);
  }
  if (event.type === 'system/message' || event.type === 'assistant/message' || event.type === 'tool/result') {
    return event.data?.message ?? event.data;
  }
  if (event.type === 'user/message') {
    return event.data;
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

function isCheckpointOrExternalFold(event, session) {
  if (!event || typeof event !== 'object') return false;
  const derived = deriveMessage(session, event);
  const source = event.data?.source ?? derived?.source;
  if (source && typeof source === 'object' && source.kind === 'compact-checkpoint') {
    return true;
  }
  if (isForeignFoldEvent(event)) return true;
  if (isProvenanceExternalFoldEvent(event, session)) return true;
  return false;
}

function isAuthenticUserTurn(session, event) {
  if (!event || event.type !== 'user/message') return false;
  if (isCheckpointOrExternalFold(event, session)) return false;
  const derived = deriveMessage(session, event);
  const candidate = derived ?? event.data?.message ?? event.data;
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

function sameNodeArray(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sessionForBalance(session, nodes) {
  if (sameNodeArray(session?.surface?.nodes, nodes)) {
    return session;
  }
  return {
    eventAt: (seq) => session.eventAt(seq),
    deriveEventMessage:
      typeof session.deriveEventMessage === 'function'
        ? (event) => session.deriveEventMessage(event)
        : undefined,
    surface: { nodes, replaceGeneration: 0 },
  };
}

function normalizeSurfaceInput(session, surfaceNodes, options) {
  const measurementArg =
    surfaceNodes && !Array.isArray(surfaceNodes) && typeof surfaceNodes === 'object' && Array.isArray(surfaceNodes.nodes)
      ? surfaceNodes
      : null;
  const rawNodes = Array.isArray(surfaceNodes)
    ? surfaceNodes
    : measurementArg
      ? measurementArg.nodes
      : surfaceNodes == null && Array.isArray(session?.surface?.nodes)
        ? session.surface.nodes
        : [];

  const pricedBySeq = new Map();
  ingestMeasuredNodes(pricedBySeq, rawNodes);
  if (measurementArg) {
    ingestPriceMap(pricedBySeq, measurementArg.pricedBySeq);
  }
  if (options?.measurement) {
    ingestPriceMap(pricedBySeq, options.measurement.pricedBySeq);
    ingestMeasuredNodes(pricedBySeq, options.measurement.nodes);
  }
  ingestPriceMap(pricedBySeq, options?.pricedBySeq);
  ingestPriceMap(pricedBySeq, options?.tokensBySeq);
  ingestPriceMap(pricedBySeq, options?.nodeTokens);

  const nodes = [];
  for (const item of rawNodes) {
    if (typeof item === 'number' && Number.isInteger(item)) {
      nodes.push(item);
    } else if (item && typeof item === 'object' && typeof item.seq === 'number' && Number.isInteger(item.seq)) {
      nodes.push(item.seq);
    }
  }

  return { nodes, pricedBySeq, measurementArg };
}

function inspectContextCollapseSpanCore(session, surfaceNodes, policy, options = {}) {
  if (policy?.contextCollapseEnabled !== true) {
    return { ok: false, reason: 'disabled', plan: null };
  }
  if (!session || typeof session.eventAt !== 'function') {
    return { ok: false, reason: 'invalid-session', plan: null };
  }

  const { nodes, pricedBySeq, measurementArg } = normalizeSurfaceInput(session, surfaceNodes, options);
  if (nodes.length === 0) {
    return { ok: false, reason: 'empty-surface', plan: null, totalTokens: 0 };
  }

  const minTokens = resolveNonNegativeInt(
    options?.minTokens,
    policy?.contextCollapseMinTokens,
    DEFAULT_CONTEXT_COLLAPSE_MIN_TOKENS,
  );
  const keepRecentTokens = resolveNonNegativeInt(
    options?.keepRecentTokens,
    policy?.contextCollapseKeepRecentTokens,
    DEFAULT_CONTEXT_COLLAPSE_KEEP_RECENT_TOKENS,
  );
  const keepRecentTurns = resolveNonNegativeInt(
    options?.keepRecentTurns,
    policy?.contextCollapseKeepRecentTurns,
    DEFAULT_CONTEXT_COLLAPSE_KEEP_RECENT_TURNS,
  );
  const minSpanNodes = resolveNonNegativeInt(
    options?.minSpanNodes,
    policy?.contextCollapseMinSpanNodes,
    DEFAULT_CONTEXT_COLLAPSE_MIN_SPAN_NODES,
  );
  const minSpanTokens = resolveNonNegativeInt(
    options?.minSpanTokens,
    policy?.contextCollapseMinSpanTokens,
    DEFAULT_CONTEXT_COLLAPSE_MIN_SPAN_TOKENS,
  );
  const maxSpanTokens = resolveNonNegativeInt(
    options?.maxSpanTokens,
    policy?.contextCollapseMaxSpanTokens,
    DEFAULT_CONTEXT_COLLAPSE_MAX_SPAN_TOKENS,
  );

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

  const measurementSource = options?.measurement ?? measurementArg;
  const measurementMatchesNodes =
    measurementSource &&
    typeof measurementSource.totalTokens === 'number' &&
    Number.isFinite(measurementSource.totalTokens) &&
    measurementSource.totalTokens >= 0 &&
    (!Array.isArray(measurementSource.nodes) ||
      (measurementSource.nodes.length === nodes.length &&
        measurementSource.nodes.every((node, idx) => {
          const seq = typeof node === 'number' ? node : node?.seq;
          return seq === nodes[idx];
        })));

  const totalTokens = pickNonNegativeFinite(
    options?.totalTokens,
    measurementMatchesNodes ? measurementSource.totalTokens : null,
    sumSurfaceTokens,
  );

  if (totalTokens < minTokens) {
    return {
      ok: false,
      reason: 'below-min-tokens',
      plan: null,
      totalTokens,
      minTokens,
    };
  }

  let eligibleStartIdx = systemHead(session, nodes[0]) !== undefined ? 1 : 0;
  while (eligibleStartIdx < nodes.length) {
    const event = session.eventAt(nodes[eligibleStartIdx]);
    if (!isCheckpointOrExternalFold(event, session)) break;
    eligibleStartIdx += 1;
  }
  if (eligibleStartIdx >= nodes.length) {
    return {
      ok: false,
      reason: 'no-uncollapsed-nodes',
      plan: null,
      totalTokens,
      protectedTailSeqs: [],
    };
  }

  let tokenCutoffIdx = nodes.length;
  if (keepRecentTokens > 0) {
    let keptTokens = 0;
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      keptTokens += tokensOf(nodes[i]);
      tokenCutoffIdx = i;
      if (keptTokens >= keepRecentTokens) break;
    }
  }

  let turnCutoffIdx = nodes.length;
  if (keepRecentTurns > 0) {
    let turnsSeen = 0;
    let matched = false;
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const event = session.eventAt(nodes[i]);
      if (!isAuthenticUserTurn(session, event)) continue;
      turnsSeen += 1;
      if (turnsSeen >= keepRecentTurns) {
        turnCutoffIdx = i;
        matched = true;
        break;
      }
    }
    if (!matched) {
      turnCutoffIdx = 0;
    }
  }

  const protectedStartIdx = Math.min(tokenCutoffIdx, turnCutoffIdx);
  const protectedTailSeqs = nodes.slice(protectedStartIdx);
  if (protectedStartIdx <= eligibleStartIdx) {
    return {
      ok: false,
      reason: 'protected-tail',
      plan: null,
      totalTokens,
      protectedTailSeqs,
    };
  }

  const balanceSession = sessionForBalance(session, nodes);
  let startBalanced = false;
  try {
    startBalanced = toolPairingBalancedBefore(balanceSession, nodes[eligibleStartIdx]);
  } catch {
    return {
      ok: false,
      reason: 'unbalanced-tool-pairing',
      plan: null,
      totalTokens,
      protectedTailSeqs,
    };
  }
  if (!startBalanced) {
    return {
      ok: false,
      reason: 'unbalanced-tool-pairing',
      plan: null,
      totalTokens,
      protectedTailSeqs,
    };
  }

  const eligibleEndLimit = protectedStartIdx - 1;
  let greedyEndIdx = eligibleStartIdx - 1;
  let accumulatedTokens = 0;
  for (let i = eligibleStartIdx; i <= eligibleEndLimit; i += 1) {
    const event = session.eventAt(nodes[i]);
    if (isCheckpointOrExternalFold(event, session)) break;
    const nodeTokens = tokensOf(nodes[i]);
    if (accumulatedTokens + nodeTokens > maxSpanTokens) break;
    accumulatedTokens += nodeTokens;
    greedyEndIdx = i;
  }

  if (greedyEndIdx < eligibleStartIdx) {
    return {
      ok: false,
      reason: 'exceeds-max-span-tokens',
      plan: null,
      totalTokens,
      protectedTailSeqs,
    };
  }

  let finalEndIdx = greedyEndIdx;
  try {
    while (finalEndIdx >= eligibleStartIdx && !toolPairingBalancedAfter(balanceSession, nodes[finalEndIdx])) {
      finalEndIdx -= 1;
    }
  } catch {
    return {
      ok: false,
      reason: 'unbalanced-tool-pairing',
      plan: null,
      totalTokens,
      protectedTailSeqs,
    };
  }

  if (finalEndIdx < eligibleStartIdx) {
    return {
      ok: false,
      reason: 'unbalanced-tool-pairing',
      plan: null,
      totalTokens,
      protectedTailSeqs,
    };
  }

  const seqs = nodes.slice(eligibleStartIdx, finalEndIdx + 1);
  if (seqs.length < minSpanNodes) {
    return {
      ok: false,
      reason: 'below-min-span-nodes',
      plan: null,
      totalTokens,
      protectedTailSeqs,
      candidateNodes: seqs.length,
      minSpanNodes,
    };
  }

  let spanTokens = 0;
  for (const seq of seqs) {
    spanTokens += tokensOf(seq);
  }
  if (spanTokens < minSpanTokens) {
    return {
      ok: false,
      reason: 'below-min-span-tokens',
      plan: null,
      totalTokens,
      protectedTailSeqs,
      candidateTokens: spanTokens,
      minSpanTokens,
    };
  }

  const plan = {
    startSeq: seqs[0],
    endSeq: seqs.at(-1),
    seqs,
    tokens: spanTokens,
    protectedTailSeqs,
    minSpanTokens,
    maxSpanTokens,
    totalTokens,
  };

  return {
    ok: true,
    plan,
    ...plan,
  };
}

/**
 * Inspect whether an expired-TTL surface has an eligible uncollapsed raw prefix
 * for progressive Context Collapse, returning `{ ok, reason?, plan, ... }`.
 */
export function inspectContextCollapseSpan(session, surfaceNodes, policy, options = {}) {
  const extraKinds = options?.extraReferenceSourceKinds ?? policy?.extraReferenceSourceKinds;
  const extraPrefixes = options?.extraReferencePrefixes ?? policy?.extraReferencePrefixes;
  if (extraKinds !== undefined || extraPrefixes !== undefined) {
    return withReferencePolicy(
      {
        ...(extraKinds !== undefined ? { extraReferenceSourceKinds: extraKinds } : {}),
        ...(extraPrefixes !== undefined ? { extraReferencePrefixes: extraPrefixes } : {}),
      },
      () => inspectContextCollapseSpanCore(session, surfaceNodes, policy, options),
    );
  }
  return inspectContextCollapseSpanCore(session, surfaceNodes, policy, options);
}

/**
 * Select an eligible progressive Context Collapse prefix plan or return `null`.
 */
export function selectContextCollapseSpan(session, surfaceNodes, policy, options = {}) {
  const inspection = inspectContextCollapseSpan(session, surfaceNodes, policy, options);
  return inspection.ok ? inspection.plan : null;
}

/**
 * Determine whether Tier 3 full idle LLM summary should be skipped after Tier 1
 * microcompact and/or Tier 2 Context Collapse, matching `_compactBeforeResume`
 * semantics in `lib/engine.js` against original pre-idle total tokens.
 */
export function shouldSkipFullIdleSummaryAfterCollapse({
  beforeTokens,
  afterTokens,
  beforeMicroTokens,
  policy,
  microResult,
  collapseResult,
  thresholdTokens,
} = {}) {
  if ((policy?.idleFullSummaryEnabled ?? DEFAULT_CONFIG.idleFullSummaryEnabled) === false) {
    return true;
  }

  const microApplied = Boolean(
    microResult &&
      ((typeof microResult.maskedCount === 'number' && microResult.maskedCount > 0) ||
        (typeof microResult.shadowedTokenCount === 'number' && microResult.shadowedTokenCount > 0)),
  );
  const collapseApplied = Boolean(
    collapseResult &&
      collapseResult !== false &&
      collapseResult?.status !== 'skipped' &&
      collapseResult?.skipped !== true,
  );
  const hasExplicitResults = microResult !== undefined || collapseResult !== undefined;
  if (hasExplicitResults && !microApplied && !collapseApplied) {
    return false;
  }

  const finalAfterTokens = pickNonNegativeFinite(afterTokens, collapseResult?.afterTokens);
  const idleMinTokens = pickNonNegativeFinite(policy?.idleCompactionMinTokens) ?? 0;
  if (idleMinTokens > 0 && finalAfterTokens !== null && finalAfterTokens < idleMinTokens) {
    return true;
  }

  const originalBeforeTokens = pickPositiveFinite(beforeMicroTokens, beforeTokens, collapseResult?.beforeTokens);
  if (originalBeforeTokens === null || finalAfterTokens === null) {
    return false;
  }

  const effectiveThreshold = pickPositiveFinite(
    thresholdTokens,
    policy?.idleCompactionThresholdTokens,
    policy?.thresholdTokens,
  );
  const netDelta = Math.max(0, originalBeforeTokens - finalAfterTokens);
  const savedTokens = collapseApplied
    ? netDelta
    : Math.max(netDelta, pickNonNegativeFinite(microResult?.shadowedTokenCount) ?? 0);
  const reducedRatio = savedTokens / originalBeforeTokens;
  const minRatio =
    typeof policy?.minimumReductionRatio === 'number' && Number.isFinite(policy.minimumReductionRatio)
      ? policy.minimumReductionRatio
      : DEFAULT_CONFIG.minimumReductionRatio;

  return reducedRatio >= minRatio && (effectiveThreshold === null || finalAfterTokens < effectiveThreshold);
}
