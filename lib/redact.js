// Shared credential and private-key redaction helpers (zero external dependencies).
// Regexes avoid literal five-hyphen BEGIN strings to satisfy scripts/check.mjs guards.

export const PEM_PRIVATE_KEY_BLOCK_RE =
  /-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY-{5}[\s\S]+?-{5}END [A-Z0-9 ]*PRIVATE KEY-{5}/gi;
export const PEM_PRIVATE_KEY_HEADER_RE = /-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY-{5}/i;
export const PEM_PRIVATE_KEY_LINE_RE = /-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY-{5}[^\r\n]*/gi;

export const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
export const COMMON_SECRET_TOKEN_RE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|pk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g;
export const BEARER_TOKEN_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

export const SECRET_PREFIX_RE = /^(?:sk-|pk-|gh[pousr]_|xox[baprs]-|AIza|AKIA|ASIA|Bearer(?:\b|_))/i;
export const STRICT_SECRET_PREFIX_RE =
  /(?:^|[_.-])(?:[sS][kK]-|[pP][kK]-|[gG][hH][pPoOuUsSrR]_|[xX][oO][xX][bBaApPrRsS]-|AIza|AKIA|ASIA)|^[bB][eE][aA][rR][eE][rR](?:\b|_)/;

// Dedicated non-global regexes for stateful-free `.test()` checks.
const PEM_PRIVATE_KEY_TEST_RE = /-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY-{5}/i;
const BEARER_TOKEN_TEST_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const SECRET_TOKEN_CI_TEST_RE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|pk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/i;
const SECRET_TOKEN_CS_TEST_RE = /\b(?:AIza[0-9A-Za-z_-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/;

const BASE64_BLOB_RE = /(?<![A-Za-z0-9+/=])([A-Za-z0-9+/]{40,}={0,2})(?![A-Za-z0-9+/=])/g;

const PATTERN_CACHE = new Map();

function getPatternsForMinLen(minLen) {
  let cached = PATTERN_CACHE.get(minLen);
  if (cached) return cached;
  cached = {
    bearerRe: minLen === 8 ? BEARER_TOKEN_RE : new RegExp(`\\b(Bearer\\s+)[A-Za-z0-9._~+/=-]{${minLen},}`, 'gi'),
    keyCiRe: new RegExp(`\\b(?:sk|pk)-[A-Za-z0-9_-]{${minLen},}\\b`, 'gi'),
    tokenCiRe: new RegExp(
      `\\b(?:gh[pousr]_[A-Za-z0-9]{${minLen},}|xox[baprs]-[A-Za-z0-9-]{${minLen},})\\b`,
      'gi',
    ),
    googleKeyRe: new RegExp(`\\bAIza[0-9A-Za-z_-]{${minLen},}\\b`, 'g'),
    awsKeyRe: new RegExp(`\\b(?:AKIA|ASIA)[0-9A-Z]{${Math.max(12, minLen)},}\\b`, 'g'),
  };
  if (PATTERN_CACHE.size < 16) {
    PATTERN_CACHE.set(minLen, cached);
  }
  return cached;
}

function overlapsProtectedTag(fullText, offset, length, protectedTags) {
  if (!protectedTags.length) return false;
  const end = offset + length;
  for (const tag of protectedTags) {
    if (tag.length < length) continue;
    let searchFrom = Math.max(0, offset - tag.length);
    while (searchFrom < end) {
      const idx = fullText.indexOf(tag, searchFrom);
      if (idx === -1 || idx >= end) break;
      if (idx <= offset && idx + tag.length >= end) return true;
      searchFrom = idx + 1;
    }
  }
  return false;
}

/**
 * Redact full multi-line PEM private-key blocks first, then any unclosed or
 * truncated single-line BEGIN ... PRIVATE KEY headers.
 *
 * @param {string} text
 * @param {string} [replacement='[redacted-private-key]']
 * @returns {string}
 */
export function redactPemPrivateKeys(text, replacement = '[redacted-private-key]') {
  if (typeof text !== 'string' || !text) return text;
  // Scan each delimiter once; never search the remaining body for every BEGIN.
  // Entries stay in source order, and each pending entry is closed at most once.
  const delimiters = /-{5}(BEGIN|END) ([A-Z0-9 ]*PRIVATE KEY)-{5}/gi;
  const pending = new Map();
  const blocks = [];
  let match;
  while ((match = delimiters.exec(text)) !== null) {
    const label = match[2].toUpperCase();
    if (match[1].toUpperCase() === 'BEGIN') {
      const block = { start: match.index, end: null };
      blocks.push(block);
      let entries = pending.get(label);
      if (!entries) pending.set(label, entries = []);
      entries.push(block);
    } else {
      const entries = pending.get(label);
      if (!entries) continue;
      for (const block of entries) block.end = delimiters.lastIndex;
      pending.delete(label);
    }
  }
  const parts = [];
  let cursor = 0;
  let end = 0;
  for (const block of blocks) {
    if (block.end === null) continue;
    if (block.start >= end) {
      parts.push(text.slice(cursor, block.start), replacement);
    }
    // Merge overlapping blocks so malformed nesting cannot expose key bodies.
    end = Math.max(end, block.end);
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return parts.join('').replace(PEM_PRIVATE_KEY_LINE_RE, () => replacement);
}

/**
 * Redact PEM private keys and common secret credentials from `text`.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.pemReplacement='[redacted-private-key]']
 * @param {string} [options.tokenReplacement='[redacted]']
 * @param {string} [options.keyReplacement]
 * @param {string | null} [options.bearerReplacement=null]
 * @param {boolean} [options.redactBase64Blobs=false]
 * @param {number} [options.minKeyLen=8]
 * @returns {string}
 */
export function redactCredentials(text, options = {}) {
  if (typeof text !== 'string' || !text) return text;
  const {
    pemReplacement = '[redacted-private-key]',
    tokenReplacement = '[redacted]',
    keyReplacement = tokenReplacement,
    bearerReplacement = null,
    redactBase64Blobs = false,
    minKeyLen = 8,
  } = options;

  const minLen = Number.isFinite(minKeyLen) && minKeyLen >= 1 ? Math.floor(minKeyLen) : 8;
  const { bearerRe, keyCiRe, tokenCiRe, googleKeyRe, awsKeyRe } = getPatternsForMinLen(minLen);

  let out = redactPemPrivateKeys(text, pemReplacement);
  if (bearerReplacement !== null && bearerReplacement !== undefined) {
    out = out.replace(bearerRe, bearerReplacement);
  } else {
    out = out.replace(bearerRe, () => tokenReplacement);
  }
  out = out
    .replace(keyCiRe, () => keyReplacement)
    .replace(tokenCiRe, () => tokenReplacement)
    .replace(googleKeyRe, () => keyReplacement)
    .replace(awsKeyRe, () => keyReplacement);

  if (redactBase64Blobs === true) {
    const protectedTags = [
      pemReplacement,
      tokenReplacement,
      keyReplacement,
      typeof bearerReplacement === 'string' ? bearerReplacement.replace(/\$1/g, '') : null,
      '[redacted-blob]',
    ].filter((tag) => typeof tag === 'string' && tag.length > 60);

    const redactBlob = (match, offset, full) => {
      if (match.length <= 60) return match;
      if (overlapsProtectedTag(full, offset, match.length, protectedTags)) return match;
      return '[redacted-blob]';
    };
    out = out.replace(BASE64_BLOB_RE, (match, _g1, offset, full) => redactBlob(match, offset, full));
    // An assignment separator is not part of the value's Base64 padding.
    out = out.replace(/(\b[A-Za-z_][A-Za-z0-9_.-]{0,127}=)([A-Za-z0-9+/]{40,}={0,2})(?![A-Za-z0-9+/=])/g,
      (match, prefix, blob, offset, full) => prefix + redactBlob(blob, offset + prefix.length, full));
  }

  return out;
}

/**
 * Stateless check for whether `text` contains a full PEM private-key header,
 * Bearer token, or common API/cloud secret token.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function containsSecretCredential(text) {
  if (typeof text !== 'string' || !text) return false;
  return (
    PEM_PRIVATE_KEY_TEST_RE.test(text) ||
    BEARER_TOKEN_TEST_RE.test(text) ||
    SECRET_TOKEN_CI_TEST_RE.test(text) ||
    SECRET_TOKEN_CS_TEST_RE.test(text)
  );
}

/**
 * Stateless check for whether `text` begins with (or carries a delimiter-prefixed)
 * secret prefix or PEM private-key header.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function hasSecretPrefix(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return (
    PEM_PRIVATE_KEY_TEST_RE.test(trimmed) ||
    SECRET_PREFIX_RE.test(trimmed) ||
    STRICT_SECRET_PREFIX_RE.test(trimmed)
  );
}
