// Request-only projections with explicit XML provenance channels.
// Durable events and verified archives keep every original byte untouched.
import { Buffer } from 'node:buffer';
import { classifyEventChannel, isReferenceContextKind, sourceKindOf } from './source-provenance.js';
import { extractSystemReminderMeta, isReferencePrefixOnly, isSystemReminderOnly, matchesReferencePrefixBlock, replaceSystemReminders } from './instruction-source.js';
import { approxTokens } from './meter.js';
import { extractToolLocator, isArchivedToolStubText } from './observation-mask.js';
import { stripPinnedSourceRules } from './audit-fallback.js';
import {
  buildToolPreview,
  codePointLength,
  computeProseDensity,
  extractSalientProse,
  sliceCodePointsEnd,
  sliceCodePointsStart,
} from './tool-preview.js';
import { summaryProse } from './validate.js';

const ASSISTANT_SLIM_MIN_CHARS = 2400;
const ASSISTANT_SLIM_BUDGET_CHARS = 900;
const ASSISTANT_SLIM_MAX_DENSITY = 0.45;
const ASSISTANT_FENCED_CODE_RE = /```|~~~/;
const ASSISTANT_ERROR_TRACE_RE =
  /(?:TypeError|ReferenceError|SyntaxError|RangeError|AssertionError|Exception|Error):\s+\S|Traceback \(most recent call last\)|\bpanicked at\b|---\s*FAIL:|^\s+at\s+\S+:\d+:\d+/m;
const ASSISTANT_STRUCTURED_PROGRESS_RE =
  /\b(?:[a-z][a-zA-Z0-9_]*(?:Count|Completed|Generated|Passed|Failed|Path|State|Status)|nextAction)\s*[:=：]/;

function hasAssistantToolBlock(message) {
  if (!Array.isArray(message?.content)) return false;
  return message.content.some(
    (block) =>
      block &&
      typeof block === 'object' &&
      (block.type === 'tool-call' || block.type === 'tool_use' || block.type === 'tool-result'),
  );
}

const READ_KEYS = {
  skill: ['name'],
  read: ['file_path'],
  read_file: ['path'],
  ops_read_files: ['files'],
  memory_get: ['id'],
  read_page: ['url'],
};

const COMPACTABLE_REFERENCE_KINDS = new Set([
  'runtime-context',
  'session-reference',
  'skill-catalog',
  'time-context',
  'msg-state',
  'agent-instructions',
  'skill-invocation',
  'tmux-context',
  'ptc-mode',
  'plan-mode',
  'model-selection',
  'repeat-tool-reminder',
  'goal',
  'tool-goal',
]);

const TOOL_RESULT_PROJECT_THRESHOLD = 4000;
const TOOL_RESULT_HEAD_CHARS = 300;
const TOOL_RESULT_TAIL_CHARS = 300;
export const REPEATED_READ_MIN_CHARS = 2000;

const FILE_READ_TOOL_NAMES = new Set([
  'read',
  'read_file',
  'view_file',
  'read_text_file',
  'read_file_content',
  'get_file',
  'get_file_contents',
  'open_file',
  'file_read',
  'cat',
  'fs_read',
  'fs_read_file',
]);

const SHELL_TOOL_NAMES = new Set([
  'bash',
  'shell',
  'exec',
  'run_command',
  'terminal',
  'powershell',
  'cmd',
  'sh',
]);

const FILE_PATH_ARG_KEYS = [
  'file_path',
  'path',
  'filePath',
  'AbsolutePath',
  'absolute_path',
  'file',
  'filename',
  'target_file',
  'targetFile',
];

const READ_RANGE_ARG_KEYS = [
  'offset',
  'limit',
  'startLine',
  'endLine',
  'StartLine',
  'EndLine',
  'start_line',
  'end_line',
];

const SHELL_CMD_ARG_KEYS = ['command', 'cmd', 'CommandLine', 'script'];
const PURE_FILE_READ_CMD_RE =
  /^\s*(?:cat|(?:type|Get-Content|gc)(?=\s))\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'|&;<>`\r\n]+))\s*$/i;

function parseToolArgs(rawArgs) {
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) return rawArgs;
  if (typeof rawArgs !== 'string' || !rawArgs.trim()) return null;
  try {
    const parsed = JSON.parse(rawArgs);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractReadLocator(toolName, rawArgs) {
  const name = typeof toolName === 'string' ? toolName.trim().toLowerCase() : '';
  if (!name) return null;
  const args = parseToolArgs(rawArgs);
  if (!args) return null;

  if (FILE_READ_TOOL_NAMES.has(name)) {
    let filePath = null;
    for (const key of FILE_PATH_ARG_KEYS) {
      if (typeof args[key] === 'string' && args[key].trim().length > 0) {
        filePath = args[key].trim();
        break;
      }
    }
    if (!filePath) return null;
    const rangeEntries = READ_RANGE_ARG_KEYS
      .filter((k) => args[k] !== undefined && args[k] !== null)
      .map((k) => [k, args[k]]);
    const rangeKey = rangeEntries.length > 0 ? JSON.stringify(rangeEntries) : '';
    return { path: filePath, rangeKey };
  }

  if (SHELL_TOOL_NAMES.has(name)) {
    let command = null;
    for (const key of SHELL_CMD_ARG_KEYS) {
      if (typeof args[key] === 'string' && args[key].trim().length > 0) {
        command = args[key].trim();
        break;
      }
    }
    if (!command || /[|&;<>`\r\n]/.test(command)) return null;
    const match = PURE_FILE_READ_CMD_RE.exec(command);
    if (!match) return null;
    const filePath = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!filePath || filePath.startsWith('-')) return null;
    return { path: filePath, rangeKey: '' };
  }

  return null;
}

function resolveToolCallForResult(session, event, message, indexedCalls) {
  const callId = message?.toolCallId ?? message?.source?.callId ?? event?.data?.callId;
  if (Array.isArray(event?.sourceEventSeqs) && typeof session?.eventAt === 'function') {
    const found = event.sourceEventSeqs
      .map((n) => session.eventAt(n))
      .find((e) => e?.type === 'tool/call' && (!callId || e.data?.callId === callId));
    if (found?.data) return { name: found.data.name, arguments: found.data.arguments };
  }
  if (callId && indexedCalls?.has(callId)) {
    return indexedCalls.get(callId);
  }
  if (typeof event?.data?.name === 'string') {
    return { name: event.data.name, arguments: event.data.arguments };
  }
  if (typeof message?.toolName === 'string') {
    return { name: message.toolName, arguments: message.toolArguments ?? message.arguments };
  }
  return null;
}

/**
 * Scan a span of surface seqs for repeated non-error read-like tool outputs
 * (>= minChars, default 2000) targeting the exact same file path. Keeps the
 * newest read intact and maps each earlier superseded read seq to a short
 * archive pointer.
 */
export function deduplicateRepeatedFileReads(session, seqs, options = {}) {
  const superseded = new Map();
  if (!session || typeof session.eventAt !== 'function' || !Array.isArray(seqs) || seqs.length < 2) {
    return superseded;
  }
  const minChars =
    Number.isFinite(options.minChars) && options.minChars >= 0
      ? options.minChars
      : REPEATED_READ_MIN_CHARS;

  const indexedCalls = new Map();
  const readsByPath = new Map();

  for (const seq of seqs) {
    const event = session.eventAt(seq);
    if (!event || typeof event !== 'object') continue;

    if (event.type === 'tool/call' && event.data?.callId) {
      indexedCalls.set(event.data.callId, {
        name: event.data.name,
        arguments: event.data.arguments,
      });
      continue;
    }

    const message =
      typeof session.deriveEventMessage === 'function'
        ? session.deriveEventMessage(event)
        : event.data?.message ?? event.data;

    if (event.type === 'assistant/message' && Array.isArray(message?.content)) {
      for (const block of message.content) {
        if (block?.type === 'tool-call') {
          const cid = block.id ?? block.callId;
          if (cid) {
            indexedCalls.set(cid, {
              name: block.name ?? block.toolName,
              arguments: block.arguments ?? block.args ?? block.input,
            });
          }
        }
      }
      continue;
    }

    if (event.type !== 'tool/result' || !message || message.isError) continue;

    const { hasText, combined } = extractMessageTextParts(message);
    if (!hasText || combined.length < minChars) continue;
    if (isArchivedToolStubText(combined)) continue;

    const call = resolveToolCallForResult(session, event, message, indexedCalls);
    if (!call) continue;
    const locator = extractReadLocator(call.name, call.arguments);
    if (!locator) continue;

    let list = readsByPath.get(locator.path);
    if (!list) {
      list = [];
      readsByPath.set(locator.path, list);
    }
    list.push({ seq, path: locator.path, rangeKey: locator.rangeKey });
  }

  for (const [path, reads] of readsByPath) {
    if (reads.length < 2) continue;
    for (let i = 0; i < reads.length - 1; i += 1) {
      const earlier = reads[i];
      let supersedingSeq = null;
      for (let j = reads.length - 1; j > i; j -= 1) {
        const later = reads[j];
        if (later.rangeKey === '' || later.rangeKey === earlier.rangeKey) {
          supersedingSeq = later.seq;
          break;
        }
      }
      if (supersedingSeq !== null) {
        superseded.set(earlier.seq, {
          seq: earlier.seq,
          path,
          supersededBy: supersedingSeq,
          pointer: `[Earlier read of ${path} at seq ${earlier.seq} superseded by seq ${supersedingSeq}; full record archived at seq ${earlier.seq}]`,
        });
      }
    }
  }

  return superseded;
}

const PROJECTED_MESSAGES = new WeakSet();

export function isProjectedSummaryMessage(message) {
  return Boolean(message && typeof message === 'object' && PROJECTED_MESSAGES.has(message));
}

export function sanitizeReferenceBody(text) {
  return String(text ?? '').replace(
    /<(\/?\s*(?:untrusted[-_]?reference|verified[-_]?user[-_]?message|channel[-_]?provenance)\b)/gi,
    '&lt;$1',
  );
}

function markProjected(wrapped) {
  if (wrapped && typeof wrapped === 'object') PROJECTED_MESSAGES.add(wrapped);
  return wrapped;
}

function extractMessageTextParts(message) {
  const content = message?.content;
  if (typeof content === 'string') {
    return { hasText: true, combined: content, nonText: [] };
  }
  if (!Array.isArray(content)) {
    return { hasText: false, combined: '', nonText: [] };
  }
  const textBlocks = content.filter((b) => b?.type === 'text' && typeof b.text === 'string');
  const nonText = content.filter((b) => !(b?.type === 'text' && typeof b.text === 'string'));
  return {
    hasText: textBlocks.length > 0,
    combined: textBlocks.map((b) => b.text).join('\n'),
    nonText,
  };
}

function wrapMessageText(message, openTag, closeTag) {
  if (isProjectedSummaryMessage(message)) return message;
  const content = message?.content;
  if (typeof content === 'string') {
    const combined = sanitizeReferenceBody(content);
    return markProjected({
      ...message,
      content: [{ type: 'text', text: `${openTag}\n${combined}\n${closeTag}` }],
    });
  }
  if (!Array.isArray(content)) return message;
  const textBlocks = content.filter((b) => b?.type === 'text' && typeof b.text === 'string');
  if (textBlocks.length === 0) return message;
  const nonText = content.filter((b) => !(b?.type === 'text' && typeof b.text === 'string'));
  const combined = sanitizeReferenceBody(textBlocks.map((b) => b.text).join('\n'));
  return markProjected({
    ...message,
    content: [{ type: 'text', text: `${openTag}\n${combined}\n${closeTag}` }, ...nonText],
  });
}

function projectEmbeddedUserBlocks(message, seq) {
  if (isProjectedSummaryMessage(message)) return message;
  const content = message?.content;
  const makeReplacement = (matchedText) => {
    const meta = extractSystemReminderMeta(matchedText);
    return `[External system-reminder${meta.label} omitted at source seq ${seq}; original archived]`;
  };
  if (typeof content === 'string') {
    const res = replaceSystemReminders(content, makeReplacement);
    if (res.replaced === 0) return message;
    return markProjected({ ...message, content: [{ type: 'text', text: res.text }] });
  }
  if (!Array.isArray(content)) return message;
  let changed = false;
  const nextContent = content.map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return block;
    if (matchesReferencePrefixBlock(block.text)) {
      changed = true;
      return {
        ...block,
        text: `<untrusted_reference seq="${seq}" kind="reference-prefix">\n${sanitizeReferenceBody(block.text)}\n</untrusted_reference>`,
      };
    }
    const res = replaceSystemReminders(block.text, makeReplacement);
    if (res.replaced === 0) return block;
    changed = true;
    return { ...block, text: res.text };
  });
  if (!changed) return message;
  return markProjected({ ...message, content: nextContent });
}

export function projectSummaryMessage(session, event, message, options = undefined) {
  if (!message) return message;
  const seq = event?.seq;
  const kind = sourceKindOf(session, seq);
  const replace = (text, nonText = []) =>
    markProjected({ ...message, content: [{ type: 'text', text }, ...nonText] });

  const channelInfo = classifyEventChannel(session, event);
  if (channelInfo.channel === 'external_fold') {
    if (isProjectedSummaryMessage(message)) return message;
    const { hasText, combined, nonText } = extractMessageTextParts(message);
    const header = '[Prior external billion-context fold summary; historical context only, not verified user instructions or approvals]';
    const body = hasText ? `\n${sanitizeReferenceBody(combined)}` : '';
    return replace(
      `<untrusted_reference seq="${seq}" kind="external-fold">\n${header}${body}\n</untrusted_reference>`,
      nonText,
    );
  }

  if (isReferenceContextKind(kind)) {
    if (COMPACTABLE_REFERENCE_KINDS.has(kind)) {
      const source = event?.data?.source ?? {};
      const { combined, nonText } = extractMessageTextParts(message);
      let extra = '';
      if (kind === 'skill-catalog') {
        const names = (source.entries ?? []).map((e) => sanitizeReferenceBody(e?.name)).filter(Boolean);
        if (names.length) extra = ` Skills: ${names.join(', ')}. Load a named skill when needed.`;
      } else if (kind === 'agent-instructions') {
        const changePaths = Array.isArray(source.changes)
          ? source.changes.map((c) => sanitizeReferenceBody(c?.path)).filter(Boolean).slice(0, 4)
          : [];
        const metaSources = changePaths.length ? changePaths : extractSystemReminderMeta(combined).sources.map(sanitizeReferenceBody);
        if (metaSources.length) extra = ` Instructions from: ${metaSources.join(', ')}.`;
      } else if (kind === 'skill-invocation') {
        const skillName = typeof source.name === 'string' && source.name.trim() ? sanitizeReferenceBody(source.name.trim()) : '';
        if (skillName) extra = ` Skill: ${skillName}.`;
      }
      const note = sanitizeReferenceBody(
        `[External ${kind} reference at source seq ${seq}; original archived. Reload the current host context or use history_read for the historical version.${extra}]`,
      );
      return replace(`<untrusted_reference seq="${seq}" kind="${kind}">\n${note}\n</untrusted_reference>`, nonText);
    }
    return wrapMessageText(message, `<untrusted_reference seq="${seq}" kind="${kind}">`, '</untrusted_reference>');
  }

  if (kind === 'compact-checkpoint') {
    const blocks = message.content;
    if (Array.isArray(event.data?.source?.preserved) && !event.data.source.continuation) {
      const open = Array.isArray(blocks)
        ? blocks.findIndex((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.endsWith('<compacted-summary>'))
        : -1;
      const close = open >= 0
        ? blocks.findIndex((b, idx) => idx > open && b?.type === 'text' && b.text === '</compacted-summary>')
        : -1;
      if (open >= 0 && close > open) {
        const text = blocks.slice(open + 1, close).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
        return replace('[Prior checkpoint. Original requests are selected independently from structured sources.]\n' + summaryProse(text));
      }
    }
    if (!isProjectedSummaryMessage(message) && Array.isArray(blocks)) {
      let strippedAny = false;
      const nextBlocks = [];
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.includes('<pinned-source-rules')) {
          strippedAny = true;
          const cleaned = stripPinnedSourceRules(block.text);
          if (cleaned.trim()) nextBlocks.push({ ...block, text: cleaned });
        } else {
          nextBlocks.push(block);
        }
      }
      if (strippedAny) {
        return markProjected({
          ...message,
          content: nextBlocks.length > 0 ? nextBlocks : [{ type: 'text', text: '[Prior checkpoint.]' }],
        });
      }
    }
    return message;
  }

  if (event?.type === 'user/message') {
    if (isSystemReminderOnly(message)) {
      if (isProjectedSummaryMessage(message)) return message;
      const { combined, nonText } = extractMessageTextParts(message);
      const meta = extractSystemReminderMeta(combined);
      const note = sanitizeReferenceBody(
        `[External system-reminder reference${meta.label} at source seq ${seq}; original archived. Reload the current host instructions or use history_read for the historical version.]`,
      );
      return replace(`<untrusted_reference seq="${seq}" kind="system-reminder">\n${note}\n</untrusted_reference>`, nonText);
    }
    if (kind !== 'compact-checkpoint' && isReferencePrefixOnly(message ?? event.data)) {
      return wrapMessageText(
        message,
        `<untrusted_reference seq="${seq}" kind="reference-prefix">`,
        '</untrusted_reference>',
      );
    }
    return projectEmbeddedUserBlocks(message, seq);
  }

  if (event?.type === 'tool/result') {
    if (message.isError) return message;
    if (
      !isProjectedSummaryMessage(message) &&
      Number.isSafeInteger(seq) &&
      options?.supersededReads instanceof Map
    ) {
      const superseded = options.supersededReads.get(seq);
      if (superseded && typeof superseded.pointer === 'string') {
        const { nonText } = extractMessageTextParts(message);
        return replace(
          `<untrusted_reference seq="${seq}" kind="tool-result">\n${sanitizeReferenceBody(superseded.pointer)}\n</untrusted_reference>`,
          nonText,
        );
      }
    }
    const callId = message.toolCallId ?? message.source?.callId;
    const call = (event.sourceEventSeqs ?? [])
      .map((n) => session.eventAt(n))
      .find((e) => e?.type === 'tool/call' && e.data?.callId === callId);
    if (call && Object.hasOwn(READ_KEYS, call.data.name)) {
      let args;
      try {
        args = typeof call.data.arguments === 'string' ? JSON.parse(call.data.arguments) : call.data.arguments;
      } catch {
        args = undefined;
      }
      const keys = READ_KEYS[call.data.name];
      if (args && keys.every((k) => args[k] !== undefined)) {
        const locatorKeys = [
          ...new Set([...keys, ...(['read', 'read_file'].includes(call.data.name) ? ['offset', 'limit', 'startLine', 'endLine'] : [])]),
        ];
        const locator = Object.fromEntries(locatorKeys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
        const omitted = sanitizeReferenceBody(`[External content omitted from working memory. Reload with ${call.data.name} ${JSON.stringify(locator)}. Source seq ${seq} is archived for exact historical bytes; current external content may have changed.]`);
        return replace(`<untrusted_reference seq="${seq}" kind="tool-result">\n${omitted}\n</untrusted_reference>`);
      }
    }
    if (!isProjectedSummaryMessage(message) && Number.isSafeInteger(seq)) {
      const { hasText, combined, nonText } = extractMessageTextParts(message);
      if (hasText && combined.length >= TOOL_RESULT_PROJECT_THRESHOLD && !isArchivedToolStubText(combined)) {
        const totalChars = codePointLength(combined);
        if (totalChars >= TOOL_RESULT_PROJECT_THRESHOLD) {
          const origTokens = approxTokens(combined);
          const origBytes = Buffer.byteLength(combined, 'utf8');
          const { toolName, target } = extractToolLocator(session, seq, event);
          const preview = buildToolPreview(combined, {
            headChars: TOOL_RESULT_HEAD_CHARS,
            tailChars: TOOL_RESULT_TAIL_CHARS,
            toolName,
            target,
          });
          if (preview) {
            const omitted = Math.max(0, totalChars - preview.keptChars);
            if (omitted > 0) {
              const marker =
                `[Tool output projected for summary (${preview.kind}); omitted ${omitted} chars of ${totalChars}; ` +
                `call history_read({ seq: ${seq} }) or history_search({ query }) if exact output is needed (compactionId optional with seq; or see history_list).]`;
              const assembled = [preview.head, marker, preview.middle, preview.tail].filter(Boolean).join('\n');
              const projected = sanitizeReferenceBody(assembled);
              if (approxTokens(projected) < origTokens && Buffer.byteLength(projected, 'utf8') < origBytes) {
                return replace(`<untrusted_reference seq="${seq}" kind="tool-result">\n${projected}\n</untrusted_reference>`, nonText);
              }
            }
          }
          const head = sliceCodePointsStart(combined, Math.min(TOOL_RESULT_HEAD_CHARS, totalChars));
          const keptHead = Math.min(TOOL_RESULT_HEAD_CHARS, totalChars);
          const tailStart = Math.max(keptHead, totalChars - TOOL_RESULT_TAIL_CHARS);
          const tailCount = totalChars - tailStart;
          const tail = tailCount > 0 ? sliceCodePointsEnd(combined, tailCount) : '';
          const omitted = Math.max(0, totalChars - keptHead - tailCount);
          if (omitted > 0) {
            const projected = sanitizeReferenceBody(
              `${head}\n[Tool output projected for summary; omitted ${omitted} chars of ${totalChars}; call history_read({ seq: ${seq} }) (compactionId optional with seq) or history_search({ query }) if exact output is needed.]\n${tail}`,
            );
            if (approxTokens(projected) < origTokens && Buffer.byteLength(projected, 'utf8') < origBytes) {
              return replace(`<untrusted_reference seq="${seq}" kind="tool-result">\n${projected}\n</untrusted_reference>`, nonText);
            }
          }
        }
      }
    }
    return wrapMessageText(message, `<untrusted_reference seq="${seq}" kind="tool-result">`, '</untrusted_reference>');
  }

  if (event?.type === 'assistant/message') {
    if (!(options?.recentAssistantSeqs instanceof Set) || options?.slimAssistant === false) {
      return message;
    }
    if (isProjectedSummaryMessage(message)) return message;
    if (Number.isSafeInteger(seq) && options.recentAssistantSeqs.has(seq)) return message;
    if (hasAssistantToolBlock(message)) return message;
    const { hasText, combined, nonText } = extractMessageTextParts(message);
    if (!hasText || combined.length <= ASSISTANT_SLIM_MIN_CHARS) return message;
    if (
      ASSISTANT_FENCED_CODE_RE.test(combined) ||
      ASSISTANT_ERROR_TRACE_RE.test(combined) ||
      ASSISTANT_STRUCTURED_PROGRESS_RE.test(combined)
    ) {
      return message;
    }
    if (computeProseDensity(combined) >= ASSISTANT_SLIM_MAX_DENSITY) return message;
    const totalChars = codePointLength(combined);
    const extracted = extractSalientProse(combined, { budgetChars: ASSISTANT_SLIM_BUDGET_CHARS });
    if (typeof extracted === 'string' && extracted.trim().length > 0) {
      const keptChars = codePointLength(extracted);
      const omitted = Math.max(0, totalChars - keptChars);
      if (omitted > 0) {
        const seqLabel = Number.isSafeInteger(seq) ? seq : 'unknown';
        const marker = `[Verbose assistant prose projected for summary; omitted ${omitted} chars of ${totalChars}; call history_read({ seq: ${seqLabel} }) for verbatim archived text.]`;
        const projected = sanitizeReferenceBody(`${extracted}\n${marker}`);
        const origTokens = approxTokens(combined);
        const origBytes = Buffer.byteLength(combined, 'utf8');
        if (approxTokens(projected) < origTokens && Buffer.byteLength(projected, 'utf8') < origBytes) {
          return replace(projected, nonText);
        }
      }
    }
    return message;
  }

  return message;
}

/**
 * Project all messages in a span with repeated identical-path file read
 * deduplication applied in one linear pass.
 */
export function projectSummaryMessages(session, seqs, options = {}) {
  if (!session || typeof session.eventAt !== 'function' || typeof session.deriveEventMessage !== 'function' || !Array.isArray(seqs)) {
    return [];
  }
  const supersededReads =
    options?.deduplicateFileReads === false
      ? undefined
      : options?.supersededReads instanceof Map
        ? options.supersededReads
        : deduplicateRepeatedFileReads(session, seqs, options);
  let recentAssistantSeqs = options?.recentAssistantSeqs;
  if (!(recentAssistantSeqs instanceof Set)) {
    const assistantSeqs = [];
    for (const seq of seqs) {
      const event = session.eventAt(seq);
      if (event?.type === 'assistant/message') assistantSeqs.push(seq);
    }
    recentAssistantSeqs = new Set(assistantSeqs.slice(-2));
  }
  const projectOpts = {
    ...options,
    recentAssistantSeqs,
    ...(supersededReads && supersededReads.size > 0 ? { supersededReads } : {}),
  };
  const messages = [];
  for (const seq of seqs) {
    const event = session.eventAt(seq);
    if (!event) continue;
    const message = projectSummaryMessage(session, event, session.deriveEventMessage(event), projectOpts);
    if (message !== null && message !== undefined) messages.push(message);
  }
  return messages;
}
