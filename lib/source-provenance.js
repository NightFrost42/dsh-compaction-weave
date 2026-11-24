// Audited envelopes emitted by DSH V4 first-party plugins and the installed status plugin.
// These are historical/context/reminder data, not instructions authored by the user.
// Keep the allowlist explicit: unknown kinds (including plugin:*), absent
// provenance and real user messages remain strict. Checkpoints are handled
// structurally by region.js / external fold classifiers and must never be
// exempted wholesale here.
import { isReferencePrefixOnly, isSystemReminderOnly } from './instruction-source.js';
import {
  withExtraReferenceSourceKinds,
  getExtraReferenceSourceKinds,
  withExtraReferencePrefixes,
  getExtraReferencePrefixes,
  getExtraReferenceContextKey,
  withReferencePolicy,
  isReferenceContextKind,
} from './reference-policy.js';

export {
  withExtraReferenceSourceKinds,
  getExtraReferenceSourceKinds,
  withExtraReferencePrefixes,
  getExtraReferencePrefixes,
  getExtraReferenceContextKey,
  withReferencePolicy,
  isReferenceContextKind,
};

let externalFoldClassifier = null;

/** Injectable external-fold classifier (wired by engine/entry to lib/foreign-fold.js). */
export function setExternalFoldClassifier(fn) {
  if (fn !== null && fn !== undefined && typeof fn !== 'function') {
    throw new TypeError('externalFoldClassifier must be a function or null');
  }
  externalFoldClassifier = fn ?? null;
}

export function getExternalFoldClassifier() {
  return externalFoldClassifier;
}

export function classifyExternalFold(event, session) {
  if (typeof externalFoldClassifier !== 'function' || !event) return null;
  const match = externalFoldClassifier(event, session);
  if (!match) return null;
  if (match === true) return { kind: 'external-fold' };
  if (typeof match === 'object') {
    return { ...match, kind: typeof match.kind === 'string' && match.kind ? match.kind : 'external-fold' };
  }
  return { kind: 'external-fold' };
}

export function isExternalFoldEvent(event, session) {
  return classifyExternalFold(event, session) !== null;
}

// Resolve carried originals from the durable event, not a checkpoint's claimed
// kind or a provenance-looking sentence in its text. Missing originals stay strict.
export function sourceKindOf(session, seq) {
  const event = session?.eventAt?.(seq);
  return event?.type === 'user/message' ? event.data?.source?.kind : undefined;
}

/** Classify a durable event into verified user input vs untrusted reference / external fold channel. */
export function classifyEventChannel(session, event) {
  if (!event) return { channel: 'other', kind: 'other' };
  const externalFold = classifyExternalFold(event, session);
  if (externalFold) {
    return { channel: 'external_fold', kind: externalFold.kind };
  }
  if (event.type === 'tool/result') {
    return { channel: 'untrusted_reference', kind: 'tool-result' };
  }
  if (event.type === 'user/message') {
    const kind = sourceKindOf(session, event.seq) ?? event.data?.source?.kind;
    if (isReferenceContextKind(kind)) return { channel: 'untrusted_reference', kind };
    if (kind === 'compact-checkpoint') return { channel: 'checkpoint', kind };
    const derived = typeof session?.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : event.data;
    if (isSystemReminderOnly(derived ?? event.data)) {
      return { channel: 'untrusted_reference', kind: 'system-reminder' };
    }
    if (isReferencePrefixOnly(derived ?? event.data)) {
      return { channel: 'untrusted_reference', kind: 'reference-prefix' };
    }
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
    else if (channel === 'untrusted_reference' || channel === 'external_fold') untrusted.push(`${seq}:${kind}`);
  }
  if (untrusted.length === 0) return '';
  const lines = ['<channel-provenance>'];
  if (verified.length > 0) lines.push(`<verified_user_message seqs="${verified.join(',')}" />`);
  if (untrusted.length > 0) lines.push(`<untrusted_reference entries="${untrusted.join(', ')}" />`);
  lines.push('</channel-provenance>');
  return lines.join('\n');
}
