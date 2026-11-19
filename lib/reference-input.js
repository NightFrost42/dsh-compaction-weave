// Request-only projections with explicit XML provenance channels.
// Durable events and verified archives keep every original byte untouched.
import { isReferenceContextKind, sourceKindOf } from './source-provenance.js';
import { summaryProse } from './validate.js';

const READ_KEYS = {
  skill: ['name'],
  read: ['file_path'],
  read_file: ['path'],
  ops_read_files: ['files'],
  memory_get: ['id'],
  read_page: ['url'],
};

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

export function projectSummaryMessage(session, event, message) {
  if (!message) return message;
  const seq = event?.seq;
  const kind = sourceKindOf(session, seq);
  const replace = (text) => markProjected({ ...message, content: [{ type: 'text', text }] });

  if (isReferenceContextKind(kind)) {
    if (['runtime-context', 'session-reference', 'skill-catalog', 'time-context', 'msg-state'].includes(kind)) {
      const source = event.data.source;
      const names = kind === 'skill-catalog' ? (source.entries ?? []).map((e) => sanitizeReferenceBody(e.name)).filter(Boolean) : undefined;
      const note = sanitizeReferenceBody(`[External ${kind} reference at source seq ${seq}; original archived. Reload the current host context or use history_read for the historical version.${names?.length ? ' Skills: ' + names.join(', ') + '. Load a named skill when needed.' : ''}]`);
      return replace(`<untrusted_reference seq="${seq}" kind="${kind}">\n${note}\n</untrusted_reference>`);
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
    return wrapMessageText(message, `<untrusted_reference seq="${seq}" kind="tool-result">`, '</untrusted_reference>');
  }

  return message;
}
