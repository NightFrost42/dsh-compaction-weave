// Pure leaf tool-stub markers and call/argument locator extraction (ZERO local imports).
// Shared by observation-mask.js and reference-input.js without cycling through region.js.

export const OBSERVATION_MASK_MARKER = '[Output masked; archived at ';
export const PERSISTED_OUTPUT_MARKER = '[Large tool output persisted; archived at ';
export const MICROCOMPACT_SUPERSEDED_MARKER = '[Earlier read of ';

/** Check whether `text` already contains an archive-backed masked/persisted/superseded stub. */
export function isArchivedToolStubText(text) {
  if (typeof text !== 'string') return false;
  return (
    text.includes(OBSERVATION_MASK_MARKER) ||
    text.includes(PERSISTED_OUTPUT_MARKER) ||
    (text.includes(MICROCOMPACT_SUPERSEDED_MARKER) && text.includes('history_read('))
  );
}

export const LOCATOR_KEYS = [
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

/** Resolve `{ toolName, target }` from a `tool/result` event or its matching `tool/call` event. */
export function findToolLocator(session, seq, toolResultEvent) {
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

/** Public wrapper returning `{ toolName, target }` for a tool result node. */
export function extractToolLocator(session, seq, toolResultEvent) {
  return findToolLocator(session, seq, toolResultEvent);
}
