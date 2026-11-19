// Audited envelopes emitted by DSH 0.2.2-rc.1 and the installed status plugin.
// These are historical/context data, not instructions authored by the user.
// Keep the allowlist explicit: unknown kinds (including plugin:*), absent
// provenance and real user messages remain strict. Checkpoints are handled
// structurally by region.js and must never be exempted wholesale here.
const REFERENCE_CONTEXT_KINDS = new Set([
  'runtime-context',
  'session-reference',
  'skill-catalog',
  'agent-message',
  'subagent-settled',
  'tool-jobs',
  'time-context',
  'msg-state',
  'weave-compaction-status',
]);
export const isReferenceContextKind = kind => REFERENCE_CONTEXT_KINDS.has(kind);

// Resolve carried originals from the durable event, not a checkpoint's claimed
// kind or a provenance-looking sentence in its text. Missing originals stay strict.
export function sourceKindOf(session, seq) {
  const event = session?.eventAt?.(seq);
  return event?.type === 'user/message' ? event.data?.source?.kind : undefined;
}

/** Classify a durable event into verified user input vs untrusted reference channel. */
export function classifyEventChannel(session, event) {
  if (!event) return { channel: 'other', kind: 'other' };
  if (event.type === 'tool/result') {
    return { channel: 'untrusted_reference', kind: 'tool-result' };
  }
  if (event.type === 'user/message') {
    const kind = sourceKindOf(session, event.seq);
    if (isReferenceContextKind(kind)) return { channel: 'untrusted_reference', kind };
    if (kind === 'compact-checkpoint') return { channel: 'checkpoint', kind };
    return { channel: 'verified_user_message', kind: kind ?? 'user' };
  }
  return { channel: event.type ?? 'other', kind: event.type ?? 'other' };
}

/** Render an explicit channel provenance summary block for verbatim-cache requests. */
export function renderChannelProvenance(session, seqs) {
  if (!session || !Array.isArray(seqs) || seqs.length === 0 || typeof session.eventAt !== 'function') return '';
  const verified = [];
  const untrusted = [];
  for (const seq of seqs) {
    const event = session.eventAt(seq);
    const { channel, kind } = classifyEventChannel(session, event);
    if (channel === 'verified_user_message') verified.push(seq);
    else if (channel === 'untrusted_reference') untrusted.push(`${seq}:${kind}`);
  }
  if (untrusted.length === 0) return '';
  const lines = ['<channel-provenance>'];
  if (verified.length > 0) lines.push(`<verified_user_message seqs="${verified.join(',')}" />`);
  if (untrusted.length > 0) lines.push(`<untrusted_reference entries="${untrusted.join(', ')}" />`);
  lines.push('</channel-provenance>');
  return lines.join('\n');
}
