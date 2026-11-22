// Audited envelopes emitted by DSH V4 first-party plugins and the installed status plugin.
// These are historical/context/reminder data, not instructions authored by the user.
// Keep the allowlist explicit: unknown kinds (including plugin:*), absent
// provenance and real user messages remain strict. Checkpoints are handled
// structurally by region.js / external fold classifiers and must never be
// exempted wholesale here.
import { AsyncLocalStorage } from 'node:async_hooks';
import { isReferencePrefixOnly, isSystemReminderOnly } from './instruction-source.js';

const RESERVED_USER_SOURCE_KINDS = new Set(['user', 'compact-checkpoint']);
const extraReferenceKindsScope = new AsyncLocalStorage();
const extraReferencePrefixesScope = new AsyncLocalStorage();
const EMPTY_PREFIXES = Object.freeze([]);

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
  // Verified first-party DSH V4 host-injected user/message source kinds:
  'agent-instructions',
  'skill-invocation',
  'tmux-context',
  'ptc-mode',
  'plan-mode',
  'model-selection',
  'repeat-tool-reminder',
  'user-approval',
  'hooks-codex',
  'hooks-claude-code',
  'tool-cordis',
  'cordis-host-runner',
  'dsh-session-title-llm',
  'schedule',
  'coordinator',
  'subagent-report',
  'team-message',
  'webhook',
  'goal',
  'tool-goal',
  'working-directory',
  'agent-teams',
  // Verified third-party IM bridge channels (user-configurable extensions via extraReferenceSourceKinds):
  'wechat',
  'qq',
  'wechat-bridge',
  'qq-bridge',
  'im-bridge',
]);

/**
 * Run `fn` with an AsyncLocalStorage-isolated set of additional `source.kind`
 * values treated as untrusted reference context instead of verified user instructions.
 * Reserved kinds (`'user'`, `'compact-checkpoint'`) are always ignored here.
 */
export function withExtraReferenceSourceKinds(kinds, fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('withExtraReferenceSourceKinds requires a callback function');
  }
  const set = new Set();
  if (kinds != null && typeof kinds !== 'string' && typeof kinds[Symbol.iterator] === 'function') {
    for (const item of kinds) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (!trimmed || RESERVED_USER_SOURCE_KINDS.has(trimmed)) continue;
      set.add(trimmed);
    }
  }
  return extraReferenceKindsScope.run(set, fn);
}

/**
 * Run `fn` with an AsyncLocalStorage-isolated list of custom bare non-user
 * text prefixes (trimmed, deduplicated, length >= 2) treated as untrusted reference context.
 */
export function withExtraReferencePrefixes(prefixes, fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('withExtraReferencePrefixes requires a callback function');
  }
  const seen = new Set();
  const out = [];
  if (prefixes != null && typeof prefixes !== 'string' && typeof prefixes[Symbol.iterator] === 'function') {
    for (const item of prefixes) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed.length < 2 || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return extraReferencePrefixesScope.run(Object.freeze(out), fn);
}

export function getExtraReferencePrefixes() {
  return extraReferencePrefixesScope.getStore() ?? EMPTY_PREFIXES;
}

export function getExtraReferenceContextKey() {
  const extraKinds = extraReferenceKindsScope.getStore();
  const extraPrefixes = extraReferencePrefixesScope.getStore();
  const hasKinds = Boolean(extraKinds && extraKinds.size > 0);
  const hasPrefixes = Boolean(extraPrefixes && extraPrefixes.length > 0);
  if (!hasKinds && !hasPrefixes) return '';
  return JSON.stringify([
    hasKinds ? [...extraKinds].sort() : [],
    hasPrefixes ? extraPrefixes : [],
  ]);
}

/**
 * Run `fn` with both `extraReferenceSourceKinds` and `extraReferencePrefixes`
 * isolated to the active policy snapshot.
 */
export function withReferencePolicy(policy, fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('withReferencePolicy requires a callback function');
  }
  return withExtraReferenceSourceKinds(policy?.extraReferenceSourceKinds, () =>
    withExtraReferencePrefixes(policy?.extraReferencePrefixes, fn),
  );
}

export function isReferenceContextKind(kind) {
  if (typeof kind !== 'string' || kind.length === 0) return false;
  if (REFERENCE_CONTEXT_KINDS.has(kind)) return true;
  if (RESERVED_USER_SOURCE_KINDS.has(kind)) return false;
  const extra = extraReferenceKindsScope.getStore();
  return Boolean(extra && extra.has(kind));
}

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
