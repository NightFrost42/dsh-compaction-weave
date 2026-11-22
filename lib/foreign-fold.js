// Foreign fold-block detection (billion-context / billion-context-dsh) and
// bounded migration planning. Kept strictly free of source-provenance/region
// imports to avoid module cycles.
import { approxTokens } from './meter.js';

/** Tier 1: Tool names unique to billion-context (zero collision with generic MCP tools). */
export const BILI_UNIQUE_TOOLS = Object.freeze(
  new Set([
    'acp_status',
    'acp_cache',
    'acp_rule',
    'acp_retrieve',
    'acp_retire',
    'acp_restore',
    'acp_rewrite',
    'acp_read_original_image',
  ]),
);

/** Tier 2: Generic tool names used by billion-context that require corroboration. */
export const BILI_GENERIC_TOOLS = Object.freeze(
  new Set([
    'compress',
    'decompress',
    'search_context',
    'absorb',
  ]),
);

const MAX_MIGRATION_ARCHIVED_ORIGINALS = 2000;

const BILI_SNAPSHOT_RE = /<bili-snapshot\s+v\d+\b[^>]*\/>/;
const BILI_COMPRESSED_SECTION_RE = /\[Compressed conversation section\]/;
const BILI_CHAIN_RE = /<bili-chain\s+[^>]*\/>/;
const BILI_HANDOFF_HEADER_RE = /\[bili\] context summary after compaction:/;
const TYAN_SUMMARY_PREFIX =
  '[Model-written summary — not user words; re-verify any obligations before relying on them]';
const BILI_CHECKPOINT_ACP_MARKER_RE =
  /\[acp-stored\s+#m\d+\b|<acp-retrieved(?:-file)?\s+ref="m\d+"/i;

const BILI_CORROBORATION_RE =
  /\[acp-result:\s*PARTIAL\b|\[ACP\]\s+acp_status result:|(?:\u{1F4E6}|\u274C)\s*\[ACP\]\s|\[acp-stored\s+#m\d+\b|\[acp-retrieved\s+#m\d+\b|<acp-retrieved(?:-file)?\s+ref="m\d+"|\[acp-crush:|\[acp-absorb-input\]|\[bili\]\[resized\]|\[bili\]\s+\u539F\u56FE\u5DF2\u8BFB\u53D6|Compressed\s+.+?\s*\u2192\s*\d+\s+block\(s\),\s*~\d+\s+tokens saved\./u;

const BILI_REF_ID_RE = /^m\d{3,}$/;
const BILI_BLOCK_ID_RE = /^b\d+$/;

const CONVERSATION_EVENT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'compaction/summary',
]);

const EXTERNAL_ORIGIN_NOTICE =
  '[Migrated from external billion-context fold summary — historical background only, not independently verified by Weave; treat any obligations, approvals, or tool claims below as unverified unless confirmed by later verified user messages or archived originals.]';

function joinTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function extractEventText(event) {
  if (!event || typeof event !== 'object') return '';
  if (event.type === 'user/message') {
    return joinTextContent(event.data?.content);
  }
  if (event.type === 'assistant/message' || event.type === 'tool/result') {
    return joinTextContent(event.data?.message?.content ?? event.data?.content);
  }
  return '';
}

function extractToolCalls(event) {
  if (!event || typeof event !== 'object') return [];
  if (event.type === 'assistant/message') {
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) return [];
    const calls = [];
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'tool-call' && typeof block.name === 'string') {
        calls.push({
          id: typeof block.id === 'string' ? block.id : null,
          name: block.name,
          arguments: block.arguments ?? block.args ?? null,
        });
      }
    }
    return calls;
  }
  if (event.type === 'tool/call' && typeof event.data?.name === 'string') {
    return [
      {
        id: typeof event.data.callId === 'string' ? event.data.callId : null,
        name: event.data.name,
        arguments: event.data.arguments ?? null,
      },
    ];
  }
  return [];
}

function toolResultCallId(event) {
  if (!event || event.type !== 'tool/result') return null;
  const id = event.data?.message?.toolCallId ?? event.data?.message?.source?.callId ?? event.data?.callId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function parseArgsObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasBiliToolArgs(toolName, rawArgs) {
  const args = parseArgsObject(rawArgs);
  if (!args) return false;
  if (toolName === 'compress') {
    if (Array.isArray(args.ranges) && args.ranges.length > 0) {
      return args.ranges.some(
        (r) =>
          r &&
          typeof r === 'object' &&
          (BILI_REF_ID_RE.test(String(r.startRef ?? r.start ?? '')) ||
            BILI_REF_ID_RE.test(String(r.endRef ?? r.end ?? ''))),
      );
    }
    return (
      BILI_REF_ID_RE.test(String(args.startRef ?? '')) ||
      BILI_REF_ID_RE.test(String(args.endRef ?? ''))
    );
  }
  if (toolName === 'decompress') {
    if (BILI_BLOCK_ID_RE.test(String(args.blockId ?? ''))) return true;
    if (Array.isArray(args.blockIds) && args.blockIds.some((id) => BILI_BLOCK_ID_RE.test(String(id ?? '')))) {
      return true;
    }
    return false;
  }
  if (toolName === 'absorb') {
    return BILI_REF_ID_RE.test(String(args.ref ?? '')) && typeof args.summary === 'string';
  }
  if (toolName === 'search_context') {
    if (BILI_BLOCK_ID_RE.test(String(args.blockId ?? ''))) return true;
    if (Array.isArray(args.blockIds) && args.blockIds.some((id) => BILI_BLOCK_ID_RE.test(String(id ?? '')))) {
      return true;
    }
    return false;
  }
  return false;
}

function isNativeWeaveCheckpointSource(source) {
  if (!source || typeof source !== 'object') return false;
  if (typeof source.compactionId === 'string' && source.compactionId.startsWith('weave-')) return true;
  if (source.migratedFrom === 'billion-context') return true;
  if (Array.isArray(source.memorySources) || Array.isArray(source.preserved)) return true;
  return false;
}

function isMigratedWeaveCheckpointEvent(event) {
  return (
    event?.type === 'user/message' &&
    event.data?.source?.kind === 'compact-checkpoint' &&
    event.data?.source?.migratedFrom === 'billion-context'
  );
}

export function detectForeignBiliSummaryOutput(text) {
  if (typeof text !== 'string') return null;
  let candidate = text.replace(/^\uFEFF/, '').trimStart();
  while (/^(?:`{3,}|~{3,})[^\r\n]*\r?\n/.test(candidate)) {
    candidate = candidate.replace(/^(?:`{3,}|~{3,})[^\r\n]*\r?\n/, '').trimStart();
  }
  if (/^<bili-snapshot\b/i.test(candidate)) return 'bili_snapshot';
  if (/^\[Compressed conversation section\]/i.test(candidate)) return 'bili_compressed_section';
  return null;
}

function leadingForeignBiliOutputReason(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  if (/^<bili-snapshot\s+v\d+\b[^>]*\/?>/i.test(trimmed)) return 'bili_snapshot_checkpoint';
  if (/^\[Compressed conversation section\]/.test(trimmed)) return 'bili_compressed_section_checkpoint';
  return null;
}

/**
 * Classify whether a single durable SessionEvent is a foreign external fold/tombstone/nudge
 * emitted by billion-context or billion-context-dsh.
 *
 * Returns `null` for ordinary user messages, assistant prose, and native Weave checkpoints.
 * Returns `{ kind, variant, reason }` (truthy) when matched.
 *
 * @param {object|null|undefined} event
 * @returns {{ kind: string, variant: string, reason: string } | null}
 */
export function isExternalFoldEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return null;

  const source =
    event.type === 'assistant/message'
      ? (event.data?.message?.source ?? event.data?.source)
      : event.data?.source;

  // Never classify native Weave checkpoints or already-migrated Weave checkpoints as foreign.
  if (isNativeWeaveCheckpointSource(source)) return null;

  if (event.type === 'assistant/message') {
    if (extractToolCalls(event).length > 0) return null;
    const isMissingOrModelSource =
      !source ||
      typeof source !== 'object' ||
      !source.kind ||
      source.kind === 'model' ||
      source.kind === 'compact-checkpoint' ||
      source.kind === 'plugin' ||
      (typeof source.kind === 'string' && source.kind.startsWith('plugin:'));
    if (!isMissingOrModelSource) return null;
    const text = extractEventText(event);
    const reason = leadingForeignBiliOutputReason(text);
    if (!reason) return null;
    return {
      kind: 'external-fold',
      variant: 'ranxianglei-authored-checkpoint',
      reason,
    };
  }

  // user/message: explicit verified user input stays immune to external-fold classification.
  if (source?.kind === 'user') return null;

  // Tyan66666/billion-context-dsh tombstone / nudge sources (V4 producer-owned & V3 legacy plugin form).
  if (
    source?.kind === 'plugin:billion-context-dsh' ||
    (source?.kind === 'plugin' && source.plugin === 'billion-context-dsh')
  ) {
    return {
      kind: 'plugin:billion-context-dsh',
      variant: 'billion-context-dsh',
      reason: 'bili_dsh_source_kind',
    };
  }
  if (
    source?.kind === 'plugin:acp-nudge' ||
    (source?.kind === 'plugin' && source.plugin === 'acp-nudge')
  ) {
    return {
      kind: 'plugin:acp-nudge',
      variant: 'billion-context-dsh',
      reason: 'bili_acp_nudge_source',
    };
  }

  const isLegacyMissingSource = !source || typeof source !== 'object' || typeof source.kind !== 'string' || !source.kind;
  const isForeignCheckpoint =
    source?.kind === 'compact-checkpoint' ||
    source?.kind === 'plugin:compact' ||
    source?.kind === 'plugin:billion-context' ||
    (source?.kind === 'plugin' && ['compact', 'billion-context', 'bili'].includes(source.plugin));

  if (!isForeignCheckpoint && !isLegacyMissingSource) return null;

  // Join ALL text blocks: dsh-compaction-basic's frameSummary places `<bili-snapshot v1 ... />`
  // in `content[1]`, NOT `content[0]`.
  const text = extractEventText(event);
  if (!text) return null;

  if (isLegacyMissingSource) {
    const blocks = Array.isArray(event.data?.content)
      ? event.data.content
          .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
      : [text];
    const reason =
      leadingForeignBiliOutputReason(text) ??
      blocks.map(leadingForeignBiliOutputReason).find(Boolean) ??
      null;
    if (!reason) return null;
    return {
      kind: 'external-fold',
      variant: 'ranxianglei-authored-checkpoint',
      reason,
    };
  }

  if (BILI_SNAPSHOT_RE.test(text)) {
    return {
      kind: 'external-fold',
      variant: 'ranxianglei-authored-checkpoint',
      reason: 'bili_snapshot_checkpoint',
    };
  }
  if (BILI_COMPRESSED_SECTION_RE.test(text)) {
    return {
      kind: 'external-fold',
      variant: 'ranxianglei-authored-checkpoint',
      reason: 'bili_compressed_section_checkpoint',
    };
  }
  if (BILI_CHAIN_RE.test(text)) {
    return {
      kind: 'external-fold',
      variant: 'ranxianglei-authored-checkpoint',
      reason: 'bili_chain_checkpoint',
    };
  }
  if (BILI_HANDOFF_HEADER_RE.test(text)) {
    return {
      kind: 'external-fold',
      variant: 'ranxianglei-authored-checkpoint',
      reason: 'bili_handoff_checkpoint',
    };
  }
  if (text.includes(TYAN_SUMMARY_PREFIX)) {
    return {
      kind: 'external-fold',
      variant: 'billion-context-dsh',
      reason: 'bili_dsh_model_summary',
    };
  }
  if (BILI_CHECKPOINT_ACP_MARKER_RE.test(text)) {
    return {
      kind: 'external-fold',
      variant: 'ranxianglei-authored-checkpoint',
      reason: 'bili_acp_marker_checkpoint',
    };
  }

  return null;
}

function inspectTailLifecycle(session) {
  const totalSeq = typeof session?.seq === 'number' && session.seq > 0 ? session.seq : 0;
  let openTurn = null;
  let unmatchedCompactionStart = null;
  let unmatchedCompactionId = null;
  let latestEndSeedSeq = null;

  for (let cursor = totalSeq - 1; cursor >= 0; cursor -= 1) {
    const event = typeof session?.eventAt === 'function' ? session.eventAt(cursor) : undefined;
    if (!event) continue;
    if (latestEndSeedSeq === null && event.type === 'session/end-seed') {
      latestEndSeedSeq = cursor;
    }
    if (unmatchedCompactionStart === null) {
      if (event.type === 'compaction/end') {
        unmatchedCompactionStart = false;
      } else if (event.type === 'compaction/start') {
        unmatchedCompactionStart = cursor;
        unmatchedCompactionId =
          typeof event.data?.compactionId === 'string' ? event.data.compactionId : null;
      }
    }
    if (openTurn === null) {
      if (event.type === 'turn/end') {
        openTurn = false;
      } else if (event.type === 'turn/start') {
        openTurn = true;
      }
    }
    if (openTurn !== null && unmatchedCompactionStart !== null && latestEndSeedSeq !== null) break;
  }

  const activeUnmatchedStart =
    typeof unmatchedCompactionStart === 'number' &&
    (latestEndSeedSeq === null || unmatchedCompactionStart > latestEndSeedSeq)
      ? unmatchedCompactionStart
      : null;

  return {
    hasOpenTurn: openTurn === true,
    staleCompactionStartSeq: activeUnmatchedStart,
    staleCompactionId: activeUnmatchedStart !== null ? unmatchedCompactionId : null,
  };
}

function emptyDetection(hasOpenTurn = false) {
  return {
    detected: false,
    variant: null,
    foldBlockCount: 0,
    biliToolCount: 0,
    hasBrokenToolPairing: false,
    canConvert: false,
    needsBackup: false,
    hasOpenTurn,
    reasons: [],
    foldSeqs: [],
    biliToolSeqs: [],
  };
}

/**
 * Inspect a DSH session for unmigrated billion-context / billion-context-dsh artifacts.
 *
 * Strictly zero false positives on ordinary chat prose and native Weave checkpoints.
 * Stops reporting `detected: true` once all bili surface nodes have been replaced by a
 * Weave checkpoint carrying `source.migratedFrom === 'billion-context'`.
 *
 * @param {object} session
 */
export function detectBiliSession(session) {
  if (!session || typeof session.eventAt !== 'function') return emptyDetection(false);

  const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : [];
  const lifecycle = inspectTailLifecycle(session);
  if (nodes.length === 0) return emptyDetection(lifecycle.hasOpenTurn);

  const foldSeqSet = new Set();
  const biliToolSeqSet = new Set();
  const variants = new Set();
  const reasons = new Set();

  // Track tool pairing balance across live surface without throwing on corrupt surfaces.
  let runningDelta = 0;
  let hasBrokenToolPairing = false;
  const openCallIds = new Set();

  // Track bili tool calls & Tier-2 generic calls awaiting corroboration.
  const biliUniqueCallIds = new Set();
  const genericCallsById = new Map();
  const genericCallsList = [];

  let latestMigratedWeaveSeq = -1;
  let nonSystemSurfaceCount = 0;

  for (const seq of nodes) {
    const event = session.eventAt(seq);
    if (!event) continue;

    if (event.type !== 'system/message') nonSystemSurfaceCount += 1;

    if (isMigratedWeaveCheckpointEvent(event)) {
      if (seq > latestMigratedWeaveSeq) latestMigratedWeaveSeq = seq;
      continue;
    }

    const fold = isExternalFoldEvent(event);
    if (fold) {
      foldSeqSet.add(seq);
      variants.add(fold.variant);
      reasons.add(fold.reason);
      continue;
    }

    if (event.type === 'assistant/message') {
      const calls = extractToolCalls(event);
      runningDelta += calls.length;
      for (const call of calls) {
        if (call.id) openCallIds.add(call.id);
        if (BILI_UNIQUE_TOOLS.has(call.name)) {
          if (call.id) biliUniqueCallIds.add(call.id);
          biliToolSeqSet.add(seq);
          variants.add('ranxianglei-proxy-raw');
          reasons.add('bili_unique_tool_call');
        } else if (BILI_GENERIC_TOOLS.has(call.name)) {
          const entry = {
            callId: call.id,
            seq,
            name: call.name,
            hasBiliArgs: hasBiliToolArgs(call.name, call.arguments),
            resultSeq: null,
            resultCorroborated: false,
          };
          genericCallsList.push(entry);
          if (call.id) genericCallsById.set(call.id, entry);
        }
      }
      continue;
    }

    if (event.type === 'tool/result') {
      runningDelta -= 1;
      const callId = toolResultCallId(event);
      if (runningDelta < 0) {
        hasBrokenToolPairing = true;
      }
      if (callId) {
        if (!openCallIds.has(callId)) {
          hasBrokenToolPairing = true;
        } else {
          openCallIds.delete(callId);
        }
      }

      const text = extractEventText(event);
      if (callId && biliUniqueCallIds.has(callId)) {
        biliToolSeqSet.add(seq);
      } else if (callId && genericCallsById.has(callId)) {
        const entry = genericCallsById.get(callId);
        entry.resultSeq = seq;
        if (BILI_CORROBORATION_RE.test(text)) {
          entry.resultCorroborated = true;
        }
      } else if (BILI_CORROBORATION_RE.test(text)) {
        // Orphan or shadowed bili tool result carrying unmistakable ACP/bili markers.
        biliToolSeqSet.add(seq);
        variants.add('ranxianglei-proxy-raw');
        reasons.add('bili_tool_result_marker');
      }
    }
  }

  if (runningDelta !== 0 || openCallIds.size > 0) {
    hasBrokenToolPairing = true;
  }

  // Corroborate Tier-2 generic tools (`compress`, `decompress`, `search_context`, `absorb`).
  const hasTier1Evidence = foldSeqSet.size > 0 || biliToolSeqSet.size > 0;
  for (const entry of genericCallsList) {
    if (entry.resultCorroborated || entry.hasBiliArgs || hasTier1Evidence) {
      biliToolSeqSet.add(entry.seq);
      if (entry.resultSeq !== null) biliToolSeqSet.add(entry.resultSeq);
      variants.add('ranxianglei-proxy-raw');
      reasons.add(entry.resultCorroborated ? 'bili_generic_tool_corroborated' : 'bili_generic_tool_args');
    }
  }

  // Durable-log check for Tyan66666/billion-context-dsh `acp/block` AND V3->V4 migrated `plugin:acp/block`.
  const totalSeq = typeof session.seq === 'number' && session.seq > 0 ? session.seq : 0;
  let latestAcpBlockSeq = -1;
  for (let i = 0; i < totalSeq; i += 1) {
    const event = session.eventAt(i);
    if (event && (event.type === 'acp/block' || event.type === 'plugin:acp/block')) {
      latestAcpBlockSeq = i;
    }
  }

  let hasUnmigratedAcpBlock = false;
  if (latestAcpBlockSeq >= 0) {
    const alreadyMigrated =
      latestMigratedWeaveSeq > latestAcpBlockSeq &&
      foldSeqSet.size === 0 &&
      biliToolSeqSet.size === 0;
    if (!alreadyMigrated && nonSystemSurfaceCount > 0) {
      hasUnmigratedAcpBlock = true;
      variants.add('billion-context-dsh');
      reasons.add('bili_acp_block_event');
    }
  }

  const foldSeqs = [...foldSeqSet].sort((a, b) => a - b);
  const biliToolSeqs = [...biliToolSeqSet].sort((a, b) => a - b);
  const detected = foldSeqs.length > 0 || biliToolSeqs.length > 0 || hasUnmigratedAcpBlock;

  let variant = null;
  if (detected) {
    if (variants.size === 1) {
      variant = [...variants][0];
    } else if (variants.size > 1) {
      variant = 'mixed';
    }
  }

  if (detected && hasBrokenToolPairing) {
    reasons.add('broken_tool_pairing');
  }

  return {
    detected,
    variant,
    foldBlockCount: foldSeqs.length,
    biliToolCount: biliToolSeqs.length,
    hasBrokenToolPairing,
    canConvert: detected && !lifecycle.hasOpenTurn,
    needsBackup: detected,
    hasOpenTurn: lifecycle.hasOpenTurn,
    reasons: [...reasons].sort(),
    foldSeqs,
    biliToolSeqs,
  };
}

function stripForeignWrappers(text) {
  return String(text ?? '')
    .replace(/This is an automatically generated checkpoint[\s\S]*?<compacted-summary>/gi, '')
    .replace(/<\/?compacted-summary>/gi, '')
    .replace(/<bili-snapshot\s+v\d+\b[^>]*\/>\s*/gi, '')
    .replace(/<bili-chain\s+[^>]*\/>\s*/gi, '')
    .replace(TYAN_SUMMARY_PREFIX, '')
    .replace(/\[bili\] context summary after compaction:\s*/gi, '')
    .replace(/^\s*\[Compressed conversation section\](?:\s*[\u2014-]\s*)?/gm, '### ')
    .trim();
}

function findTrailingBalancedEndIndex(session, nodes, startIdx, minEndIdx) {
  // Choose the earliest endIdx >= minEndIdx where the suffix nodes[endIdx+1..] has no
  // orphan tool/result whose matching tool-call lives inside nodes[startIdx..endIdx],
  // and where no tool-call inside nodes[startIdx..endIdx] leaves its result right after endIdx.
  const callsBefore = new Set();
  for (let i = 0; i < startIdx; i += 1) {
    const event = session.eventAt(nodes[i]);
    for (const call of extractToolCalls(event)) {
      if (call.id) callsBefore.add(call.id);
    }
  }

  for (let endIdx = Math.max(startIdx, minEndIdx); endIdx < nodes.length; endIdx += 1) {
    const openInSuffix = new Set(callsBefore);
    let suffixRunning = 0;
    let balanced = true;
    for (let j = endIdx + 1; j < nodes.length; j += 1) {
      const event = session.eventAt(nodes[j]);
      if (!event) continue;
      if (event.type === 'assistant/message') {
        const calls = extractToolCalls(event);
        suffixRunning += calls.length;
        for (const call of calls) {
          if (call.id) openInSuffix.add(call.id);
        }
      } else if (event.type === 'tool/result') {
        suffixRunning -= 1;
        const callId = toolResultCallId(event);
        if (suffixRunning < 0 || (callId && !openInSuffix.has(callId))) {
          balanced = false;
          break;
        }
        if (callId) openInSuffix.delete(callId);
      }
    }
    if (balanced) return endIdx;
  }

  return nodes.length - 1;
}

function buildNormalizedFoldSummary(foldTexts, archiveRangeLabel) {
  const cleaned = foldTexts
    .map((item) => {
      const body = stripForeignWrappers(item.text);
      return body ? `<!-- external-fold seq ${item.seq} -->\n${body}` : '';
    })
    .filter(Boolean)
    .join('\n\n');

  const bodyBlock = cleaned || '(empty external fold summary; inspect archived originals via history_read)';
  const archiveNote = archiveRangeLabel
    ? `Archived pre-migration bili fold blocks and bounded shadowed originals (${archiveRangeLabel}). Use history_search / history_read for exact historical text.`
    : 'Original pre-migration events are archived; use history_search / history_read if exact historical text is needed.';

  return [
    EXTERNAL_ORIGIN_NOTICE,
    '',
    '## 1. Primary Request and Intent',
    '- (Unverified external fold history migrated from billion-context; confirm active requirements against verified user messages below or archived originals.)',
    '',
    '## 2. Key Technical Concepts',
    '- Migrated from external billion-context session format into native Weave compaction checkpoints.',
    '',
    '## 3. Files and Code Sections',
    `- ${archiveNote}`,
    '',
    '## 4. Errors and Fixes',
    '- (none)',
    '',
    '## 5. Problem Solving',
    '- (none)',
    '',
    '## 6. All User Messages',
    '- (See verified post-fold user messages preserved separately; external fold text below is not verified user input.)',
    '',
    '## 7. Pending Tasks',
    '- Re-verify pending obligations against verified user messages and current workspace files before acting.',
    '',
    '## 8. Work Completed',
    bodyBlock,
    '',
    '## 9. Context for Continuing Work',
    `- ${archiveNote}`,
  ].join('\n');
}

/**
 * Compute a safe, backup-first, non-unfolding migration plan for a detected bili session.
 *
 * @param {object} session
 * @param {ReturnType<typeof detectBiliSession>} [detection]
 * @param {{ maxArchivedOriginals?: number }} [options]
 */
export function buildBiliMigrationPlan(session, detection = detectBiliSession(session), options = {}) {
  const maxOriginals = Math.min(
    MAX_MIGRATION_ARCHIVED_ORIGINALS,
    Math.max(0, Math.floor(options.maxArchivedOriginals ?? MAX_MIGRATION_ARCHIVED_ORIGINALS)),
  );

  if (!detection?.detected || !session || typeof session.eventAt !== 'function') {
    return {
      needed: false,
      strategy: null,
      variant: null,
      startSeq: null,
      endSeq: null,
      surfaceRangeSeqs: [],
      foldSeqs: [],
      biliToolSeqs: [],
      archivedOriginalsSeqs: [],
      totalArchivedSeqs: [],
      truncatedOriginalsCount: 0,
      verifiedUserSeqs: [],
      hasBrokenToolPairing: false,
      staleCompactionStartSeq: null,
      staleCompactionId: null,
      externalOriginNotice: null,
      normalizedSummaryText: null,
      estimatedSurfaceTokens: 0,
      checkpointSourceMeta: null,
    };
  }

  const nodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : [];
  const firstIdx =
    nodes.length > 0 && session.eventAt(nodes[0])?.type === 'system/message' ? 1 : 0;

  if (firstIdx >= nodes.length) {
    return {
      needed: false,
      strategy: null,
      variant: detection.variant,
      startSeq: null,
      endSeq: null,
      surfaceRangeSeqs: [],
      foldSeqs: detection.foldSeqs,
      biliToolSeqs: detection.biliToolSeqs,
      archivedOriginalsSeqs: [],
      totalArchivedSeqs: [],
      truncatedOriginalsCount: 0,
      verifiedUserSeqs: [],
      hasBrokenToolPairing: detection.hasBrokenToolPairing,
      staleCompactionStartSeq: null,
      staleCompactionId: null,
      externalOriginNotice: null,
      normalizedSummaryText: null,
      estimatedSurfaceTokens: 0,
      checkpointSourceMeta: null,
    };
  }

  const strategy = detection.foldSeqs.length > 0 ? 'fold-adopt' : 'proxy-raw-rolling';
  const indexBySeq = new Map(nodes.map((seq, idx) => [seq, idx]));

  let minEndIdx = firstIdx;
  for (const seq of [...detection.foldSeqs, ...detection.biliToolSeqs]) {
    const idx = indexBySeq.get(seq);
    if (idx !== undefined && idx > minEndIdx) minEndIdx = idx;
  }
  if (detection.foldSeqs.length === 0 && detection.biliToolSeqs.length === 0) {
    // acp/block-only durable residue: cover the non-system surface prefix.
    minEndIdx = nodes.length - 1;
  }

  const endIdx = findTrailingBalancedEndIndex(session, nodes, firstIdx, minEndIdx);
  const surfaceRangeSeqs = nodes.slice(firstIdx, endIdx + 1);
  const startSeq = surfaceRangeSeqs[0];
  const endSeq = surfaceRangeSeqs[surfaceRangeSeqs.length - 1];
  const surfaceRangeSet = new Set(surfaceRangeSeqs);

  // Collect bounded shadowed originals from durable log (<= 2000) without unfolding onto surface.
  const shadowedCandidates = [];
  const upperBound = typeof endSeq === 'number' ? endSeq : 0;
  for (let seq = 0; seq < upperBound; seq += 1) {
    if (surfaceRangeSet.has(seq)) continue;
    const event = session.eventAt(seq);
    if (!event || !CONVERSATION_EVENT_TYPES.has(event.type)) continue;
    shadowedCandidates.push(seq);
  }

  const truncatedOriginalsCount = Math.max(0, shadowedCandidates.length - maxOriginals);
  const archivedOriginalsSeqs =
    truncatedOriginalsCount > 0
      ? shadowedCandidates.slice(shadowedCandidates.length - maxOriginals)
      : shadowedCandidates;

  const totalArchivedSeqs = [...new Set([...archivedOriginalsSeqs, ...surfaceRangeSeqs])].sort(
    (a, b) => a - b,
  );

  // Collect verified user messages within the replaced span (excluding external folds).
  const verifiedUserSeqs = [];
  const foldTexts = [];
  let estimatedSurfaceTokens = 0;

  for (const seq of surfaceRangeSeqs) {
    const event = session.eventAt(seq);
    if (!event) continue;
    const text = extractEventText(event);
    estimatedSurfaceTokens += approxTokens(text);
    if (detection.foldSeqs.includes(seq)) {
      foldTexts.push({ seq, text });
      continue;
    }
    if (
      event.type === 'user/message' &&
      (!event.data?.source?.kind || event.data.source.kind === 'user') &&
      !isExternalFoldEvent(event)
    ) {
      verifiedUserSeqs.push(seq);
    }
  }

  const lifecycle = inspectTailLifecycle(session);
  const staleForeignStart =
    lifecycle.staleCompactionStartSeq !== null &&
    !(typeof lifecycle.staleCompactionId === 'string' && lifecycle.staleCompactionId.startsWith('weave-'))
      ? lifecycle.staleCompactionStartSeq
      : null;

  const archiveRangeLabel =
    totalArchivedSeqs.length > 0
      ? `seq ${totalArchivedSeqs[0]}-${totalArchivedSeqs[totalArchivedSeqs.length - 1]}, ${totalArchivedSeqs.length} events` +
        (truncatedOriginalsCount > 0 ? `; ${truncatedOriginalsCount} oldest shadowed events omitted by cap` : '')
      : '';

  const normalizedSummaryText =
    strategy === 'fold-adopt' ? buildNormalizedFoldSummary(foldTexts, archiveRangeLabel) : null;

  return {
    needed: true,
    strategy,
    variant: detection.variant,
    startSeq,
    endSeq,
    surfaceRangeSeqs,
    foldSeqs: [...detection.foldSeqs],
    biliToolSeqs: [...detection.biliToolSeqs],
    archivedOriginalsSeqs,
    totalArchivedSeqs,
    truncatedOriginalsCount,
    verifiedUserSeqs,
    hasBrokenToolPairing: detection.hasBrokenToolPairing,
    staleCompactionStartSeq: staleForeignStart,
    staleCompactionId: staleForeignStart !== null ? lifecycle.staleCompactionId : null,
    externalOriginNotice: EXTERNAL_ORIGIN_NOTICE,
    normalizedSummaryText,
    estimatedSurfaceTokens,
    checkpointSourceMeta: {
      migratedFrom: 'billion-context',
      migrationVariant: detection.variant,
      externalSummaryUnverified: true,
    },
  };
}
