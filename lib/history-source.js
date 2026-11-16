// Only immutable tool-result provenance is expanded. Checkpoint provenance can
// cover older conversations; following it would silently widen this span.
const MAX_TOOL_SOURCE_EVENTS = 4096;
const MAX_TOOL_SOURCE_DEPTH = 64;

function sourceError(message) {
  return Object.assign(new Error(`archive tool source ${message}`), { code: 'ARCHIVE_SOURCE_INVALID' });
}

export function toolResultMessage(event) {
  return event?.type === 'tool/result' ? event.data?.message : undefined;
}

function callIdOf(event) {
  if (event?.type === 'tool/call') return event.data?.callId;
  const message = toolResultMessage(event);
  const id = message?.toolCallId ?? message?.source?.callId;
  if (message?.toolCallId !== undefined && message?.source?.callId !== undefined
      && message.toolCallId !== message.source.callId) throw sourceError(`event ${event.seq} has conflicting call IDs`);
  return id;
}

/** Selected seqs remain a prefix; each earlier result/call source is added once. */
export function historySourceSeqs(session, seqs) {
  const selected = new Set();
  const events = new Map();
  const read = seq => {
    if (events.has(seq)) return events.get(seq);
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
    if (!event) throw new Error(`archive source event ${seq} is missing`);
    if (event.seq !== seq) throw sourceError(`event ${seq} has a mismatched sequence`);
    events.set(seq, event);
    return event;
  };
  for (const seq of seqs) {
    if (!Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0) || selected.has(seq)) throw sourceError('selection must contain unique non-negative safe sequence numbers');
    selected.add(seq);
    read(seq);
  }
  const sources = new Set();
  const expanded = new Set();
  const pending = [...selected];
  let inspected = 0;
  while (pending.length) {
    const seq = pending.pop();
    const event = read(seq);
    if (event.type !== 'tool/result' || event.sourceEventSeqs === undefined || expanded.has(seq)) continue;
    expanded.add(seq);
    const refs = event.sourceEventSeqs;
    if (!Array.isArray(refs) || refs.length === 0 || refs.length > MAX_TOOL_SOURCE_EVENTS - inspected) throw sourceError(`event ${seq} has invalid or over-budget sourceEventSeqs`);
    const id = callIdOf(event);
    if (typeof id !== 'string' || id.length === 0) throw sourceError(`event ${seq} has no tool call ID`);
    const unique = new Set();
    for (const sourceSeq of refs) {
      if (!Number.isSafeInteger(sourceSeq) || sourceSeq < 0 || Object.is(sourceSeq, -0) || sourceSeq >= seq || unique.has(sourceSeq)) throw sourceError(`event ${seq} must cite unique earlier sequence numbers`);
      unique.add(sourceSeq);
      inspected += 1;
      const source = read(sourceSeq);
      if (!['tool/result', 'tool/call'].includes(source.type) || callIdOf(source) !== id) throw sourceError(`event ${seq} cites a different tool call at ${sourceSeq}`);
      if (!selected.has(sourceSeq)) sources.add(sourceSeq);
      pending.push(sourceSeq);
    }
  }
  // Strictly earlier references give a topological order. Measure the longest
  // chain after collection so overlapping selected roots cannot bypass depth.
  const depths = new Map();
  for (const seq of [...expanded].sort((a, b) => a - b)) {
    let depth = 0;
    for (const sourceSeq of read(seq).sourceEventSeqs) depth = Math.max(depth, 1 + (depths.get(sourceSeq) ?? 0));
    if (depth > MAX_TOOL_SOURCE_DEPTH) throw sourceError(`chain exceeds ${MAX_TOOL_SOURCE_DEPTH} links`);
    depths.set(seq, depth);
  }
  return { selected: [...selected], sources: [...sources].sort((a, b) => a - b) };
}
