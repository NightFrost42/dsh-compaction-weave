// Only immutable tool-result provenance is expanded. Checkpoint provenance can
// cover older conversations; following it would silently widen this span.
export const MAX_TOOL_SOURCE_EVENTS = 4096;
export const MAX_TOOL_SOURCE_DEPTH = 64;

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

function safeCallIdOf(event) {
  try {
    return callIdOf(event);
  } catch {
    return undefined;
  }
}

function isValidSeq(seq) {
  return Number.isSafeInteger(seq) && seq >= 0 && !Object.is(seq, -0);
}

/**
 * Incremental O(nodes + edges) tracker for tool-result provenance ref budgets.
 * Mirrors `historySourceSeqs` validation rules strictly by default, and supports
 * opt-in bounded fallback (`allowForeignFallback: true`) for migration spans.
 */
export function createToolSourceBudgetTracker(session, options = {}) {
  const maxRefs = Number.isSafeInteger(options?.maxRefs) && options.maxRefs > 0
    ? options.maxRefs
    : MAX_TOOL_SOURCE_EVENTS;
  const maxDepth = Number.isSafeInteger(options?.maxDepth) && options.maxDepth > 0
    ? options.maxDepth
    : MAX_TOOL_SOURCE_DEPTH;
  const allowForeignFallback = options?.allowForeignFallback === true;

  const selected = new Set();
  const events = new Map();
  const sources = new Set();
  const expanded = new Set();
  const depths = new Map();
  let inspected = 0;
  let observedMaxDepth = 0;
  let fallbackUsed = false;
  let failure = null;

  const readStrict = (seq) => {
    if (events.has(seq)) return events.get(seq);
    const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : undefined;
    if (!event) throw new Error(`archive source event ${seq} is missing`);
    if (event.seq !== seq) throw sourceError(`event ${seq} has a mismatched sequence`);
    events.set(seq, event);
    return event;
  };

  const readSafe = (seq) => {
    if (events.has(seq)) return events.get(seq);
    const event = typeof session?.eventAt === 'function' ? session.eventAt(seq) : undefined;
    if (!event || event.seq !== seq) return null;
    events.set(seq, event);
    return event;
  };

  const failState = (reason, error, requiredRefs = inspected) => {
    failure = { ok: false, reason, error, refs: requiredRefs, maxRefs, sources: sources.size, maxDepth: observedMaxDepth };
    return failure;
  };

  const okState = () => ({
    ok: true,
    refs: inspected,
    maxRefs,
    sources: sources.size,
    maxDepth: observedMaxDepth,
    ...(allowForeignFallback ? { fallback: fallbackUsed } : {}),
  });

  const add = (rootSeq) => {
    if (failure) return failure;
    if (!isValidSeq(rootSeq) || selected.has(rootSeq)) {
      return failState('invalid', sourceError('selection must contain unique non-negative safe sequence numbers'));
    }
    let rootEvent;
    try {
      rootEvent = readStrict(rootSeq);
    } catch (error) {
      return failState('invalid', error);
    }
    selected.add(rootSeq);
    sources.delete(rootSeq);

    if (rootEvent.type !== 'tool/result' || rootEvent.sourceEventSeqs === undefined) {
      return okState();
    }

    if (allowForeignFallback) {
      const queue = [{ seq: rootSeq, hop: 0 }];
      for (let head = 0; head < queue.length; head += 1) {
        const { seq, hop } = queue[head];
        const event = readSafe(seq);
        if (!event || event.type !== 'tool/result' || event.sourceEventSeqs === undefined || expanded.has(seq)) continue;
        if (hop >= maxDepth) {
          fallbackUsed = true;
          continue;
        }
        expanded.add(seq);
        const refs = event.sourceEventSeqs;
        if (!Array.isArray(refs) || refs.length === 0) {
          fallbackUsed = true;
          continue;
        }
        const id = safeCallIdOf(event);
        if (typeof id !== 'string' || id.length === 0) {
          fallbackUsed = true;
          continue;
        }
        const unique = new Set();
        for (const sourceSeq of refs) {
          if (inspected >= maxRefs) {
            fallbackUsed = true;
            break;
          }
          if (!isValidSeq(sourceSeq) || sourceSeq >= seq || unique.has(sourceSeq)) {
            fallbackUsed = true;
            continue;
          }
          unique.add(sourceSeq);
          const source = readSafe(sourceSeq);
          if (!source) {
            fallbackUsed = true;
            continue;
          }
          const srcId = safeCallIdOf(source);
          if (!['tool/result', 'tool/call'].includes(source.type) || srcId !== id) {
            fallbackUsed = true;
            continue;
          }
          inspected += 1;
          observedMaxDepth = Math.max(observedMaxDepth, hop + 1);
          if (!selected.has(sourceSeq)) sources.add(sourceSeq);
          queue.push({ seq: sourceSeq, hop: hop + 1 });
        }
      }
      return okState();
    }

    const pending = [rootSeq];
    const newlyExpanded = [];
    while (pending.length) {
      const seq = pending.pop();
      let event;
      try {
        event = readStrict(seq);
      } catch (error) {
        return failState('invalid', error);
      }
      if (event.type !== 'tool/result' || event.sourceEventSeqs === undefined || expanded.has(seq)) continue;
      expanded.add(seq);
      newlyExpanded.push(seq);
      const refs = event.sourceEventSeqs;
      if (!Array.isArray(refs) || refs.length === 0) {
        return failState('invalid', sourceError(`event ${seq} has invalid or over-budget sourceEventSeqs`));
      }
      if (refs.length > maxRefs - inspected) {
        return failState('budget', sourceError(`event ${seq} has invalid or over-budget sourceEventSeqs`), inspected + refs.length);
      }
      let id;
      try {
        id = callIdOf(event);
      } catch (error) {
        return failState('invalid', error);
      }
      if (typeof id !== 'string' || id.length === 0) {
        return failState('invalid', sourceError(`event ${seq} has no tool call ID`));
      }
      const unique = new Set();
      for (const sourceSeq of refs) {
        if (!isValidSeq(sourceSeq) || sourceSeq >= seq || unique.has(sourceSeq)) {
          return failState('invalid', sourceError(`event ${seq} must cite unique earlier sequence numbers`));
        }
        unique.add(sourceSeq);
        inspected += 1;
        let source;
        try {
          source = readStrict(sourceSeq);
          if (!['tool/result', 'tool/call'].includes(source.type) || callIdOf(source) !== id) {
            return failState('invalid', sourceError(`event ${seq} cites a different tool call at ${sourceSeq}`));
          }
        } catch (error) {
          return failState('invalid', error);
        }
        if (!selected.has(sourceSeq)) sources.add(sourceSeq);
        pending.push(sourceSeq);
      }
    }

    newlyExpanded.sort((a, b) => a - b);
    for (const seq of newlyExpanded) {
      let depth = 0;
      for (const sourceSeq of events.get(seq).sourceEventSeqs) {
        depth = Math.max(depth, 1 + (depths.get(sourceSeq) ?? 0));
      }
      if (depth > maxDepth) {
        return failState('depth', sourceError(`chain exceeds ${maxDepth} links`));
      }
      depths.set(seq, depth);
      observedMaxDepth = Math.max(observedMaxDepth, depth);
    }
    return okState();
  };

  return {
    add,
    get ok() { return failure === null; },
    get refs() { return inspected; },
    get sources() { return sources.size; },
    get maxDepth() { return observedMaxDepth; },
    get fallback() { return fallbackUsed; },
    get error() { return failure?.error ?? null; },
    get reason() { return failure?.reason ?? null; },
  };
}

/** Non-throwing pre-LLM inspection of tool-source ref budget and validity. */
export function inspectToolSourceBudget(session, seqs, options = {}) {
  const tracker = createToolSourceBudgetTracker(session, options);
  let last = {
    ok: true,
    refs: 0,
    maxRefs: Number.isSafeInteger(options?.maxRefs) && options.maxRefs > 0 ? options.maxRefs : MAX_TOOL_SOURCE_EVENTS,
    sources: 0,
    maxDepth: 0,
    ...(options?.allowForeignFallback === true ? { fallback: false } : {}),
  };
  for (const seq of seqs ?? []) {
    last = tracker.add(seq);
    if (!last.ok) return last;
  }
  return last;
}

/** Selected seqs remain a prefix; each earlier result/call source is added once. */
export function historySourceSeqs(session, seqs, options = {}) {
  const allowForeignFallback = options?.allowForeignFallback === true;
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
  const readSafe = seq => {
    if (events.has(seq)) return events.get(seq);
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
    if (!event || event.seq !== seq) return null;
    events.set(seq, event);
    return event;
  };
  for (const seq of seqs) {
    if (!isValidSeq(seq) || selected.has(seq)) throw sourceError('selection must contain unique non-negative safe sequence numbers');
    selected.add(seq);
    read(seq);
  }
  const sources = new Set();
  const expanded = new Set();
  let inspected = 0;

  if (allowForeignFallback) {
    // Bounded BFS fallback for migrated/foreign tool/result chains: preserve the
    // nearest valid provenance links within budget and depth without throwing.
    const queue = [...selected].map(seq => ({ seq, hop: 0 }));
    for (let head = 0; head < queue.length; head += 1) {
      const { seq, hop } = queue[head];
      const event = readSafe(seq);
      if (!event || event.type !== 'tool/result' || event.sourceEventSeqs === undefined || expanded.has(seq)) continue;
      if (hop >= MAX_TOOL_SOURCE_DEPTH) continue;
      expanded.add(seq);
      const refs = event.sourceEventSeqs;
      if (!Array.isArray(refs) || refs.length === 0) continue;
      const id = safeCallIdOf(event);
      if (typeof id !== 'string' || id.length === 0) continue;
      const unique = new Set();
      for (const sourceSeq of refs) {
        if (inspected >= MAX_TOOL_SOURCE_EVENTS) break;
        if (!isValidSeq(sourceSeq) || sourceSeq >= seq || unique.has(sourceSeq)) continue;
        unique.add(sourceSeq);
        const source = readSafe(sourceSeq);
        if (!source) continue;
        const srcId = safeCallIdOf(source);
        if (!['tool/result', 'tool/call'].includes(source.type) || srcId !== id) continue;
        inspected += 1;
        if (!selected.has(sourceSeq)) sources.add(sourceSeq);
        queue.push({ seq: sourceSeq, hop: hop + 1 });
      }
    }
    return { selected: [...selected], sources: [...sources].sort((a, b) => a - b) };
  }

  const pending = [...selected];
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
      if (!isValidSeq(sourceSeq) || sourceSeq >= seq || unique.has(sourceSeq)) throw sourceError(`event ${seq} must cite unique earlier sequence numbers`);
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
