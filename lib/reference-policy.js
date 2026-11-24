// Pure leaf AsyncLocalStorage-isolated reference context policy configuration
// (`source.kind` allowlist and user-configured extra untrusted reference kinds/prefixes).
// Zero local imports so both `source-provenance.js` and `instruction-source.js` share it cleanly.

import { AsyncLocalStorage } from 'node:async_hooks';

const RESERVED_USER_SOURCE_KINDS = new Set(['user', 'compact-checkpoint']);
const extraReferenceKindsScope = new AsyncLocalStorage();
const extraReferencePrefixesScope = new AsyncLocalStorage();
const EMPTY_KINDS = Object.freeze(new Set());
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

/** Return the active AsyncLocalStorage-isolated set of extra untrusted source kinds. */
export function getExtraReferenceSourceKinds() {
  return extraReferenceKindsScope.getStore() ?? EMPTY_KINDS;
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

/** Return the active AsyncLocalStorage-isolated list of custom bare reference prefixes. */
export function getExtraReferencePrefixes() {
  return extraReferencePrefixesScope.getStore() ?? EMPTY_PREFIXES;
}

/** Return a canonical cache-key suffix capturing active extra reference kinds and prefixes. */
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

/** Return whether `kind` represents an allowlisted or policy-configured untrusted reference source. */
export function isReferenceContextKind(kind) {
  if (typeof kind !== 'string' || kind.length === 0) return false;
  if (REFERENCE_CONTEXT_KINDS.has(kind)) return true;
  if (RESERVED_USER_SOURCE_KINDS.has(kind)) return false;
  const extra = extraReferenceKindsScope.getStore();
  return Boolean(extra && extra.has(kind));
}
