// Deterministic, zero-LLM local workspace disk-state check at compaction time.
// Compaction summaries capture point-in-time historical turns; deliverables or
// paths mentioned in older turns can be deleted or altered outside the session.
// Checking local workspace paths strictly inside verified session directories
// prevents handoff checkpoints from presenting missing files as still on disk.

import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)\]]+/gi;
const FENCE_RE = /```[\s\S]*?```/g;
const REF_TAG_RE = /<untrusted_reference\b[^>]*>[\s\S]*?<\/untrusted_reference>/gi;
const QUOTED_TAG_RE = /<quoted_text\b[^>]*>[\s\S]*?<\/quoted_text>/gi;
const DISK_CHECK_TAG_RE = /<disk-state-check\b[^>]*>[\s\S]*?<\/disk-state-check>/gi;
const ACTIVE_FILES_TAG_RE = /<active-workspace-files\b[^>]*>[\s\S]*?<\/active-workspace-files>/gi;

const WIN_ABS_PATH_RE = /[A-Za-z]:[/\\][^\s"'`<>|*?\])},;：，。(\[]+/g;
const POSIX_KNOWN_PREFIX_RE =
  /(?:^|[\s"'`(（[,:：])(\/(?:home|Users|tmp|var|private|opt|srv|mnt|data|workspace|work|app|root|etc|usr)\/[^\s"'`<>|*?\])},;：，。(\[]+)/g;
const POSIX_ABS_TOKEN_RE = /\/[^\s"'`<>|*?\])},;：，。(\[]+/g;
const BACKTICK_REL_PATH_RE = /`([^`\r\n]{2,180})`/g;

const ARCHIVED_FILES_LINE_RE = /Archived files:\s*((?:(?!\.\s*Folded archives:)[^\r\n])+)/g;

function normalizeCompareKey(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isDisallowedPathRoot(raw) {
  if (typeof raw !== 'string') return true;
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (/^(\\\\|\/\/)/.test(trimmed)) return true;
  if (/^\\\\[.?]\\/.test(trimmed)) return true;
  return !isAbsolute(trimmed);
}

function addVerifiedRoot(raw, out, seen) {
  if (isDisallowedPathRoot(raw)) return;
  const trimmed = raw.trim();
  const abs = resolve(trimmed);
  let real = abs;
  try {
    const st = statSync(abs);
    if (!st.isDirectory()) return;
    real = realpathSync(abs);
  } catch {
    return;
  }
  const key = normalizeCompareKey(real);
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ rawAbs: abs, real });
}

export function resolveSessionRootRecords(session, explicitRoots = []) {
  const records = [];
  const seen = new Set();
  const candidates = [];

  if (Array.isArray(explicitRoots)) {
    for (const root of explicitRoots) candidates.push(root);
  }
  if (typeof session?.header?.cwd === 'string') {
    candidates.push(session.header.cwd);
  }
  if (typeof session?.eventAt === 'function' && Number.isSafeInteger(session?.seq)) {
    for (let seq = 0; seq < session.seq; seq += 1) {
      const ev = session.eventAt(seq);
      if (ev?.type !== 'working-directory/change') continue;
      const dir = ev.data?.cwd ?? ev.data?.path ?? ev.data?.directory ?? ev.data?.next ?? ev.data?.to;
      if (typeof dir === 'string') candidates.push(dir);
    }
  }

  for (const candidate of candidates) {
    addVerifiedRoot(candidate, records, seen);
  }
  return records;
}

/**
 * Resolve verified local workspace directory roots for a session.
 * Returns `[]` when no local workspace directory can be verified (remote/synthetic).
 *
 * @param {object} session
 * @param {readonly string[]} [explicitRoots]
 * @returns {string[]}
 */
export function resolveSessionWorkspaceRoots(session, explicitRoots = []) {
  return resolveSessionRootRecords(session, explicitRoots).map((entry) => entry.real);
}

function cleanCandidateToken(rawToken) {
  if (typeof rawToken !== 'string') return null;
  let token = rawToken.trim();
  if (!token || token.length > 220) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return null;
  if (/^(\\\\|\/\/)/.test(token) || /^\\\\[.?]\\/.test(token)) return null;
  if (/[*?<>]/.test(token) || token.includes('${')) return null;

  token = token.replace(/[.,;:)\]）】。，；、]+$/, '');
  token = token.replace(/(?::\d+(?:-\d+)?|#L\d+(?:-L\d+)?)$/, '');
  token = token.replace(/[.,;:)\]）】。，；、]+$/, '');
  if (!token || token.length < 2) return null;

  const endsWithSlash = /[\\/]$/.test(token);
  return { token, endsWithSlash };
}

function isInsideRoot(rootPath, candidatePath) {
  const rel = relative(normalizeCompareKey(rootPath), normalizeCompareKey(candidatePath));
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
}

function toDisplayPath(resolved, primaryRoot, endsWithSlash) {
  let display;
  if (primaryRoot && isInsideRoot(primaryRoot.real, resolved)) {
    display = relative(primaryRoot.real, resolved);
  } else if (primaryRoot && primaryRoot.rawAbs !== primaryRoot.real && isInsideRoot(primaryRoot.rawAbs, resolved)) {
    display = relative(primaryRoot.rawAbs, resolved);
  } else {
    display = resolved;
  }
  display = display.replaceAll('\\', '/');
  if (endsWithSlash && !display.endsWith('/')) display += '/';
  return display;
}

function canonicalWorkspacePath(candidate) {
  let current = candidate;
  const suffix = [];
  for (;;) {
    try { return { path: resolve(realpathSync(current), ...suffix), exists: suffix.length === 0 }; }
    catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return null;
      const parent = dirname(current);
      if (parent === current) return null;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function resolveInsideWorkspace(tokenInfo, rootRecords) {
  if (!tokenInfo || !rootRecords.length) return null;
  const { token, endsWithSlash } = tokenInfo;
  const sensitive = token.replaceAll('\\', '/').toLowerCase();
  if (/(?:^|\/)\.+(?:env(?:rc|[._-].*)?|npmrc|netrc|pgpass|vault-token)$/.test(sensitive) ||
      /(?:secret|credential)|\.(?:pem|key|p12|pfx|p8|ppk|keystore)$/.test(sensitive)) return null;
  let missing = null;
  for (const root of [...rootRecords].reverse()) {
    const candidate = isAbsolute(token) ? resolve(token) : resolve(root.real, token);
    if (!rootRecords.some(r => isInsideRoot(r.real, candidate) || isInsideRoot(r.rawAbs, candidate))) continue;
    const canonical = canonicalWorkspacePath(candidate);
    if (!canonical) continue;
    if (!rootRecords.some(r => isInsideRoot(r.real, canonical.path))) return null;
    const result = { resolved: canonical.path, display: toDisplayPath(candidate, root, endsWithSlash) };
    if (canonical.exists) return result;
    missing ??= result;
  }
  return missing;
}

/**
 * Clean and resolve a raw candidate path strictly inside verified workspace root records.
 * Returns `{ resolved, display }` or `null` when outside workspace or disallowed.
 *
 * @param {string} rawPath
 * @param {readonly { rawAbs: string, real: string }[]} rootRecords
 * @returns {{ resolved: string, display: string } | null}
 */
export function resolvePathInsideWorkspace(rawPath, rootRecords) {
  if (!Array.isArray(rootRecords) || rootRecords.length === 0) return null;
  const tokenInfo = cleanCandidateToken(rawPath);
  if (!tokenInfo) return null;
  return resolveInsideWorkspace(tokenInfo, rootRecords);
}

function stripNonAuthoritativeProse(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(ACTIVE_FILES_TAG_RE, ' ')
    .replace(FENCE_RE, ' ')
    .replace(REF_TAG_RE, ' ')
    .replace(QUOTED_TAG_RE, ' ')
    .replace(DISK_CHECK_TAG_RE, ' ')
    .replace(URL_RE, ' ');
}

function extractArchivedFilesFromProse(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const match of text.matchAll(ARCHIVED_FILES_LINE_RE)) {
    const rawList = String(match[1] ?? '').trim().replace(/\.$/, '');
    if (!rawList) continue;
    for (const part of rawList.split(',')) {
      const cleaned = part.trim();
      if (cleaned) out.push(cleaned);
    }
  }
  return out;
}

/**
 * Extract bounded, strictly workspace-contained file/directory candidates from
 * cleaned summary prose and archived file lists.
 */
export function extractCandidatePaths({
  session = null,
  archivedFiles = [],
  summaryText = '',
  workspaceRoots = [],
  maxPaths = 24,
} = {}) {
  if (!Number.isSafeInteger(maxPaths) || maxPaths <= 0) return [];
  const rootRecords =
    Array.isArray(workspaceRoots) && workspaceRoots.length > 0
      ? (() => {
          const out = [];
          const seen = new Set();
          for (const root of workspaceRoots) addVerifiedRoot(root, out, seen);
          return out;
        })()
      : resolveSessionRootRecords(session);

  if (rootRecords.length === 0) return [];

  const cleaned = stripNonAuthoritativeProse(summaryText);
  const rawCandidates = [];

  for (const m of cleaned.matchAll(WIN_ABS_PATH_RE)) {
    rawCandidates.push(m[0]);
  }

  const hasPosixRoot = rootRecords.some((r) => r.real.startsWith('/') || r.rawAbs.startsWith('/'));
  if (hasPosixRoot) {
    for (const m of cleaned.matchAll(POSIX_KNOWN_PREFIX_RE)) {
      if (m[1]) rawCandidates.push(m[1]);
    }
    const posixRoots = rootRecords
      .flatMap((r) => [r.real, r.rawAbs])
      .filter((r) => r.startsWith('/'));
    for (const m of cleaned.matchAll(POSIX_ABS_TOKEN_RE)) {
      const tok = m[0];
      if (posixRoots.some((root) => tok === root || tok.startsWith(`${root}/`))) {
        rawCandidates.push(tok);
      }
    }
  }

  for (const m of cleaned.matchAll(BACKTICK_REL_PATH_RE)) {
    const inner = m[1].trim();
    if (!inner || isAbsolute(inner) || !/[\\/]/.test(inner)) continue;
    const cleanedInner = cleanCandidateToken(inner);
    if (!cleanedInner) continue;
    if (cleanedInner.endsWithSlash || /[A-Za-z0-9_-]\.[A-Za-z0-9]{1,12}$/.test(cleanedInner.token)) {
      rawCandidates.push(inner);
    }
  }

  for (const file of extractArchivedFilesFromProse(cleaned)) {
    rawCandidates.push(file);
  }
  if (Array.isArray(archivedFiles)) {
    for (const file of archivedFiles) rawCandidates.push(file);
  }

  const out = [];
  const seen = new Set();
  for (const raw of rawCandidates) {
    if (out.length >= maxPaths) break;
    const cleanedTok = cleanCandidateToken(raw);
    const resolvedEntry = resolveInsideWorkspace(cleanedTok, rootRecords);
    if (!resolvedEntry) continue;
    const key = normalizeCompareKey(resolvedEntry.resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolvedEntry);
  }
  return out;
}

/**
 * Probe existence and post-turn modification of referenced workspace paths.
 * Strictly read-only, local-workspace-bounded, and silent on permission errors.
 */
export function probeDiskLiveness({
  session = null,
  shadowedSeqs = [],
  archivedFiles = [],
  summaryText = '',
  workspaceRoots = [],
  maxPaths = 24,
  spanEndTimeMs = null,
} = {}) {
  const resolvedRoots =
    Array.isArray(workspaceRoots) && workspaceRoots.length > 0
      ? (() => {
          const out = [];
          const seen = new Set();
          for (const root of workspaceRoots) addVerifiedRoot(root, out, seen);
          return out.map((entry) => entry.real);
        })()
      : resolveSessionWorkspaceRoots(session);

  if (resolvedRoots.length === 0) {
    return {
      checked: 0,
      missing: [],
      modified: [],
      existing: [],
      skippedReason: 'no-local-workspace',
    };
  }

  let spanEndMs = Number.isFinite(spanEndTimeMs) ? spanEndTimeMs : null;
  if (spanEndMs === null && typeof session?.eventAt === 'function' && Array.isArray(shadowedSeqs)) {
    let maxTime = null;
    for (const seq of shadowedSeqs) {
      const t = session.eventAt(seq)?.time;
      if (typeof t === 'number' && Number.isFinite(t) && t > 0) {
        if (maxTime === null || t > maxTime) maxTime = t;
      }
    }
    spanEndMs = maxTime;
  }

  const candidates = extractCandidatePaths({
    session,
    archivedFiles,
    summaryText,
    workspaceRoots: resolvedRoots,
    maxPaths,
  });

  const missing = [];
  const modified = [];
  const existing = [];

  for (const { resolved, display } of candidates) {
    let st;
    try {
      st = statSync(resolved);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        missing.push(display);
      }
      continue;
    }
    existing.push(display);
    if (
      !st.isDirectory() &&
      spanEndMs !== null &&
      spanEndMs > 0 &&
      typeof st.mtimeMs === 'number' &&
      Number.isFinite(st.mtimeMs) &&
      st.mtimeMs > spanEndMs + 5000
    ) {
      modified.push(display);
    }
  }

  return {
    checked: candidates.length,
    missing,
    modified,
    existing,
    checkedAt: new Date().toISOString(),
  };
}

function formatTruncatedPathList(items, limit) {
  if (!Array.isArray(items) || items.length === 0) return '';
  if (items.length <= limit) return items.join(', ');
  return `${items.slice(0, limit).join(', ')}, (+${items.length - limit} more)`;
}

/**
 * Render a concise `<disk-state-check>` metadata block when any referenced path
 * is missing or modified on disk; returns `''` when everything still matches.
 */
export function renderDiskLivenessNotice(probe, { maxMissing = 12, maxModified = 8, includeModified = true } = {}) {
  if (!probe) return '';
  const missing = Array.isArray(probe.missing) ? probe.missing : [];
  const modified = includeModified && Array.isArray(probe.modified) ? probe.modified : [];
  if (missing.length === 0 && modified.length === 0) return '';

  const iso = typeof probe.checkedAt === 'string' && probe.checkedAt.length >= 16
    ? `${probe.checkedAt.slice(0, 16)}Z`
    : `${new Date().toISOString().slice(0, 16)}Z`;

  const lines = [
    `<disk-state-check checked-at="${iso}" scope="local-workspace">`,
    'Deterministic local disk check at compaction time (may change further after compaction; verify before citing deliverables or editing):',
  ];
  if (missing.length > 0) {
    lines.push(`- Missing on disk at compaction: ${formatTruncatedPathList(missing, maxMissing)}`);
  }
  if (modified.length > 0) {
    lines.push(`- Modified on disk after compacted turns: ${formatTruncatedPathList(modified, maxModified)}`);
  }
  lines.push('</disk-state-check>');
  return lines.join('\n');
}
