// Shared credential and private-key redaction helpers (zero external dependencies).
// Regexes avoid literal five-hyphen BEGIN strings to satisfy scripts/check.mjs guards.

export const PEM_PRIVATE_KEY_BLOCK_RE =
  /-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-{5}[\s\S]+?-{5}END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-{5}/gi;
export const PEM_PRIVATE_KEY_HEADER_RE = /-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-{5}/i;
export const PEM_PRIVATE_KEY_LINE_RE = /-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-{5}[^\r\n]*/gi;

export const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
export const COMMON_SECRET_TOKEN_RE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|pk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g;
export const BEARER_TOKEN_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

export const SECRET_PREFIX_RE = /^(?:sk-|pk-|gh[pousr]_|github_pat_|xox[baprs]-|AIza|AKIA|ASIA|Bearer(?:\b|_))/i;
export const STRICT_SECRET_PREFIX_RE =
  /(?:^|[_.-])(?:[sS][kK]-|[pP][kK]-|[gG][hH][pPoOuUsSrR]_|github_pat_|[xX][oO][xX][bBaApPrRsS]-|AIza|AKIA|ASIA)|^[bB][eE][aA][rR][eE][rR](?:\b|_)/;

// Dedicated non-global regexes for stateful-free `.test()` checks.
const PEM_PRIVATE_KEY_TEST_RE = /-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-{5}/i;
const BEARER_TOKEN_TEST_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const SECRET_TOKEN_CI_TEST_RE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|pk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/i;
const SECRET_TOKEN_CS_TEST_RE = /\b(?:AIza[0-9A-Za-z_-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/;
const BARE_JWT_TEST_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
const URL_CREDENTIAL_TEST_RE =
  /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^/\s:@"'`<>]{1,128}:[^/\s@"'`<>]{1,256}@/i;
const EXPLICIT_AWS_SECRET_TEST_RE =
  /(?:\b(?:aws_secret_access_key|aws_secret_key|secret_access_key)\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])|\baws_session_token\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+=_-]{40,1024}(?![A-Za-z0-9/+=_-]))/i;

const BARE_JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const URL_CREDENTIAL_RE =
  /(\b[a-z][a-z0-9+.-]{1,15}:\/\/[^/\s:@"'`<>]{1,128}:)[^/\s@"'`<>]{1,256}(@)/gi;
const EXPLICIT_AWS_SECRET_RE =
  /(\b(?:aws_secret_access_key|aws_secret_key|secret_access_key)\b["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])|(\baws_session_token\b["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=_-]{40,1024}(?![A-Za-z0-9/+=_-])/gi;

const PEM_BODY_LINE_RE =
  /^[ \t"'`>|#*-]*(?:[A-Za-z0-9+/]{12,}=*|[A-Za-z0-9+/]{2,}={1,2}|Proc-Type:.*|DEK-Info:.*|Version:.*|Comment:.*|Charset:.*|Hash:.*|=[A-Za-z0-9+/]{4})[ \t"'`,;]*$/i;

const BASE64_BLOB_RE = /(?<![A-Za-z0-9+/=])([A-Za-z0-9+/]{40,}={0,2})(?![A-Za-z0-9+/=])/g;

const PATTERN_CACHE = new Map();

function getPatternsForMinLen(minLen) {
  let cached = PATTERN_CACHE.get(minLen);
  if (cached) return cached;
  const patTailLen = Math.max(8, minLen);
  cached = {
    bearerRe: minLen === 8 ? BEARER_TOKEN_RE : new RegExp(`\\b(Bearer\\s+)[A-Za-z0-9._~+/=-]{${minLen},}`, 'gi'),
    keyCiRe: new RegExp(`\\b(?:sk|pk)-[A-Za-z0-9_-]{${minLen},}\\b`, 'gi'),
    tokenCiRe: new RegExp(
      `\\b(?:gh[pousr]_[A-Za-z0-9]{${minLen},}|github_pat_[A-Za-z0-9_]{${patTailLen},}|xox[baprs]-[A-Za-z0-9-]{${minLen},})\\b`,
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
 * Redact full multi-line PEM/PGP private-key blocks (including mismatched END
 * labels), unclosed multi-line bodies (with optional indent/quotes), and any
 * truncated single-line BEGIN ... PRIVATE KEY headers.
 *
 * @param {string} text
 * @param {string} [replacement='[redacted-private-key]']
 * @param {{ sampleTruncated?: boolean }} [options]
 * @returns {string}
 */
export function redactPemPrivateKeys(text, replacement = '[redacted-private-key]', options = {}) {
  if (typeof text !== 'string' || !text) return text;
  const sampleTruncated = options?.sampleTruncated === true;
  // Scan each delimiter once in source order. Any END private-key delimiter
  // closes open BEGIN entries so mismatched END labels cannot expose bodies.
  const delimiters = /-{5}(BEGIN|END) ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-{5}/gi;
  const openBegins = [];
  const blocks = [];
  let match;
  while ((match = delimiters.exec(text)) !== null) {
    if (match[1].toUpperCase() === 'BEGIN') {
      const block = { start: match.index, end: null };
      blocks.push(block);
      openBegins.push(block);
    } else if (openBegins.length > 0) {
      for (const block of openBegins) block.end = delimiters.lastIndex;
      openBegins.length = 0;
    }
  }
  const parts = [];
  let cursor = 0;
  let closedEnd = 0;
  for (const block of blocks) {
    if (block.end === null) continue;
    if (block.start >= closedEnd) {
      parts.push(text.slice(cursor, block.start), replacement);
    }
    closedEnd = Math.max(closedEnd, block.end);
    cursor = closedEnd;
  }
  parts.push(text.slice(cursor));
  let out = parts.join('');

  if (openBegins.length > 0) {
    if (sampleTruncated) {
      delimiters.lastIndex = 0;
      let firstOpen = -1;
      let m;
      while ((m = delimiters.exec(out)) !== null) {
        if (m[1].toUpperCase() === 'BEGIN') {
          firstOpen = m.index;
          break;
        }
      }
      if (firstOpen >= 0) {
        return `${out.slice(0, firstOpen)}${replacement}`;
      }
    }
    const outParts = [];
    let outCursor = 0;
    delimiters.lastIndex = 0;
    let m;
    while ((m = delimiters.exec(out)) !== null) {
      if (m[1].toUpperCase() !== 'BEGIN') continue;
      const start = m.index;
      if (start < outCursor) continue;
      outParts.push(out.slice(outCursor, start));
      const nl0 = out.indexOf('\n', start);
      const bodyStart = nl0 === -1 ? out.length : nl0 + 1;
      let pos = bodyStart;
      while (pos < out.length) {
        const nl = out.indexOf('\n', pos);
        const lineEnd = nl === -1 ? out.length : nl;
        const rawLine = out.slice(pos, lineEnd);
        const bare = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        const nextPos = nl === -1 ? out.length : nl + 1;
        if (/^[ \t]*$/.test(bare)) {
          if (nextPos >= out.length) break;
          const nl2 = out.indexOf('\n', nextPos);
          const rawNext = out.slice(nextPos, nl2 === -1 ? out.length : nl2);
          const nextBare = rawNext.endsWith('\r') ? rawNext.slice(0, -1) : rawNext;
          if (!/^[ \t]*$/.test(nextBare) && PEM_BODY_LINE_RE.test(nextBare)) {
            pos = nextPos;
            continue;
          }
          break;
        }
        if (PEM_BODY_LINE_RE.test(bare)) {
          pos = nextPos;
          continue;
        }
        break;
      }
      const consumedBody = pos > bodyStart;
      outParts.push(replacement);
      if (consumedBody && pos < out.length && out[pos - 1] === '\n') {
        outParts.push('\n');
      }
      outCursor = pos;
      delimiters.lastIndex = pos;
    }
    outParts.push(out.slice(outCursor));
    out = outParts.join('');
  }

  return out.replace(PEM_PRIVATE_KEY_LINE_RE, () => replacement);
}

/**
 * Redact PEM/PGP private keys and common secret credentials from `text`.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.pemReplacement='[redacted-private-key]']
 * @param {string} [options.tokenReplacement='[redacted]']
 * @param {string} [options.keyReplacement]
 * @param {string | null} [options.bearerReplacement=null]
 * @param {boolean} [options.redactBase64Blobs=false]
 * @param {boolean} [options.sampleTruncated=false]
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
    sampleTruncated = false,
    minKeyLen = 8,
  } = options;

  const minLen = Number.isFinite(minKeyLen) && minKeyLen >= 1 ? Math.floor(minKeyLen) : 8;
  const { bearerRe, keyCiRe, tokenCiRe, googleKeyRe, awsKeyRe } = getPatternsForMinLen(minLen);

  let out = redactPemPrivateKeys(text, pemReplacement, { sampleTruncated });
  if (bearerReplacement !== null && bearerReplacement !== undefined) {
    out = out.replace(bearerRe, bearerReplacement);
  } else {
    out = out.replace(bearerRe, () => tokenReplacement);
  }
  out = out
    .replace(keyCiRe, () => keyReplacement)
    .replace(tokenCiRe, () => tokenReplacement)
    .replace(googleKeyRe, () => keyReplacement)
    .replace(awsKeyRe, () => keyReplacement)
    .replace(BARE_JWT_RE, () => tokenReplacement)
    .replace(URL_CREDENTIAL_RE, (_m, prefix, at) => `${prefix}${tokenReplacement}${at}`)
    .replace(EXPLICIT_AWS_SECRET_RE, (_m, g1, g2) => `${g1 ?? g2}${keyReplacement}`);

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
 * Stateless check for whether `text` contains a full PEM/PGP private-key header,
 * Bearer token, bare JWT, URL credentials, or common API/cloud secret token.
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
    SECRET_TOKEN_CS_TEST_RE.test(text) ||
    BARE_JWT_TEST_RE.test(text) ||
    URL_CREDENTIAL_TEST_RE.test(text) ||
    EXPLICIT_AWS_SECRET_TEST_RE.test(text)
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
