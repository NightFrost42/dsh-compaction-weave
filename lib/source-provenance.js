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
