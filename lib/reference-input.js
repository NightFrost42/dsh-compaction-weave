// Request-only projections with explicit XML provenance channels.
// Durable events and verified archives keep every original byte untouched.
import { classifyEventChannel, isReferenceContextKind, sourceKindOf } from './source-provenance.js';
import { extractSystemReminderMeta, isSystemReminderOnly, replaceSystemReminders } from './instruction-source.js';
import { summaryProse } from './validate.js';

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

function projectEmbeddedSystemReminders(message, seq) {
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
  let totalReplaced = 0;
  const nextContent = content.map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return block;
    const res = replaceSystemReminders(block.text, makeReplacement);
    if (res.replaced === 0) return block;
    totalReplaced += res.replaced;
    return { ...block, text: res.text };
  });
  if (totalReplaced === 0) return message;
  return markProjected({ ...message, content: nextContent });
}

export function projectSummaryMessage(session, event, message) {
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

  if (kind === 'compact-checkpoint' && Array.isArray(event.data?.source?.preserved) && !event.data.source.continuation) {
    const blocks = message.content;
    const close = Array.isArray(blocks) ? blocks.findIndex((b) => b.type === 'text' && b.text === '</compacted-summary>') : -1;
    if (close > 0 && blocks[0]?.text?.endsWith('<compacted-summary>')) {
      const text = blocks.slice(1, close).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      return replace('[Prior checkpoint. Original requests are selected independently from structured sources.]\n' + summaryProse(text));
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
    return projectEmbeddedSystemReminders(message, seq);
  }

  if (event?.type === 'tool/result') {
    if (message.isError) return message;
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
      if (hasText && combined.length >= TOOL_RESULT_PROJECT_THRESHOLD && !combined.includes('[Output masked; archived at ')) {
        const chars = Array.from(combined);
        if (chars.length >= TOOL_RESULT_PROJECT_THRESHOLD) {
          const head = chars.slice(0, TOOL_RESULT_HEAD_CHARS).join('');
          const tail = chars.slice(-TOOL_RESULT_TAIL_CHARS).join('');
          const omitted = Math.max(0, chars.length - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS);
          const projected = sanitizeReferenceBody(
            `${head}\n[Tool output projected for summary; omitted ${omitted} chars of ${chars.length}; call history_read({ seq: ${seq} }) if exact output is needed.]\n${tail}`,
          );
          return replace(`<untrusted_reference seq="${seq}" kind="tool-result">\n${projected}\n</untrusted_reference>`, nonText);
        }
      }
    }
    return wrapMessageText(message, `<untrusted_reference seq="${seq}" kind="tool-result">`, '</untrusted_reference>');
  }

  return message;
}
