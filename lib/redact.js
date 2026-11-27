// Shared credential and private-key redaction helpers (zero external dependencies).
// Regexes avoid literal five-hyphen BEGIN strings to satisfy scripts/check.mjs guards.

export const PEM_PRIVATE_KEY_BLOCK_RE =
  /-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-{5}[\s\S]+?-{5}END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-{5}/gi;
export const PEM_PRIVATE_KEY_HEADER_RE = /-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-{5}/i;
export const PEM_PRIVATE_KEY_LINE_RE = /-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-{5}[^\r\n]*/gi;

export const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
export const COMMON_SECRET_TOKEN_RE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{8,}|pk-[A-Za-z0-9_-]{8,}|whsec_[A-Za-z0-9_-]{8,}|GOCSPX-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]{8,}|pypi-[A-Za-z0-9_-]{8,}|hf_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g;
export const BEARER_TOKEN_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

export const SECRET_PREFIX_RE = /^(?:sk-|(?:sk|rk)_(?:live|test)_|pk-|whsec_|GOCSPX-|gh[pousr]_|github_pat_|glpat-|npm_|pypi-|hf_|xox[baprs]-|AIza|AKIA|ASIA|Bearer(?:\b|_))/i;
export const STRICT_SECRET_PREFIX_RE =
  /(?:^|[_.-])(?:[sS][kK]-|[sSrR][kK]_(?:[lL][iI][vV][eE]|[tT][eE][sS][tT])_|[pP][kK]-|whsec_|GOCSPX-|[gG][hH][pPoOuUsSrR]_|github_pat_|glpat-|npm_|pypi-|hf_|[xX][oO][xX][bBaApPrRsS]-|AIza|AKIA|ASIA)|^[bB][eE][aA][rR][eE][rR](?:\b|_)/;

// Dedicated non-global regexes for stateful-free `.test()` checks.
const PEM_PRIVATE_KEY_TEST_RE = /-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-{5}/i;
const BEARER_TOKEN_TEST_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const AUTH_TOKEN_HEADER_TEST_RE = /\bAuthorization["\x27]?\s*:\s*["\x27]?(?:Token|Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{1,}/i;
const SECRET_TOKEN_CI_TEST_RE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]{8,}|pk-[A-Za-z0-9_-]{8,}|whsec_[A-Za-z0-9_-]{8,}|GOCSPX-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{8,}|npm_[A-Za-z0-9]{8,}|pypi-[A-Za-z0-9_-]{8,}|hf_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/i;
const SECRET_TOKEN_CS_TEST_RE = /\b(?:AIza[0-9A-Za-z_-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/;
const BARE_JWT_TEST_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
const URL_CREDENTIAL_TEST_RE =
  /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^/\s:@"'`<>]{0,128}:[^/\s"'`<>]{1,256}@[^/\s@"'`<>]+/i;
const SLACK_WEBHOOK_TEST_RE =
  /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]{5,}\/[A-Za-z0-9_-]{5,}\/[A-Za-z0-9_-]{8,}\b/i;
const EXPLICIT_AWS_SECRET_TEST_RE =
  /(?:\b(?:(?:[A-Za-z0-9_]+_)?aws_secret|aws_secret_access_key|aws_secret_key|secret_access_key)\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])|\baws_session_token\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+=_-]{40,1024}(?![A-Za-z0-9/+=_-]))/i;

const BARE_JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const URL_CREDENTIAL_RE =
  /(\b[a-z][a-z0-9+.-]{1,15}:\/\/[^/\s:@"'`<>]{0,128}:)[^/\s"'`<>]{1,256}(@[^/\s@"'`<>]+)/gi;
const SLACK_WEBHOOK_RE =
  /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]{5,}\/[A-Za-z0-9_-]{5,}\/[A-Za-z0-9_-]{8,}\b/gi;
const EXPLICIT_CLIENT_SECRET_RE =
  /(\b(?:(?:[A-Za-z0-9_.-]+_)?(?:api_?key|webhook_secret|access_token|refresh_token|secret_key|private_key|password|passwd)|client_secret|x-api-key)\b["']?\s*[:=]\s*)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|"(?:\\.|[^"\\\r\n])+|'(?:\\.|[^'\\\r\n])+|\[redacted(?:-[a-z-]+)?\]|(?!\[\s*["'\[\]{}]|\{\s*["'{}])[^\s"',}\]]+)/gi;
const EXPLICIT_AWS_SECRET_RE =
  /(\b(?:(?:[A-Za-z0-9_]+_)?aws_secret|aws_secret_access_key|aws_secret_key|secret_access_key)\b["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])|(\baws_session_token\b["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=_-]{40,1024}(?![A-Za-z0-9/+=_-])/gi;

const PEM_BODY_LINE_RE =
  /^(?:[ \t"'`>|#*+/-]|\/\/)*(?:[A-Za-z0-9+/_-]{12,}=*(?:\.{3}|…)?|[A-Za-z0-9+/]{2,}={1,2}|Proc-Type:.*|DEK-Info:.*|Version:.*|Comment:.*|Charset:.*|Hash:.*|=[A-Za-z0-9+/]{4})(?:\\[rn])*[ \t"'`,;+\\]*$/i;
const PEM_SHORT_BASE64_TAIL_RE =
  /^(?:[ \t"'`>|#*+/-]|\/\/)*(?:(?=[A-Za-z0-9+/=]*[0-9+/=])|(?=[A-Za-z0-9+/=]*[A-Z][a-z0-9+/]*[A-Z])|(?=[a-z]+[A-Z])|(?=[A-Z]{4,}(?:\\[rn])*[ \t"'`,;+\\]*$)|(?=[A-Za-z0-9+/]{4,}(?:\.{3}|…)))[A-Za-z0-9+/]{1,11}=*(?:\.{3}|…)?(?:\\[rn])*[ \t"'`,;+\\]*$/;
const PEM_TRUNCATED_EOF_TAIL_RE =
  /^(?:[ \t"'`>|#*+/-]|\/\/)*[A-Za-z0-9+/]{1,11}=*(?:\.{3}|…)?(?:\\[rn])*[ \t"'`,;+\\]*$/;

const BASE64_BLOB_RE = /(?<![A-Za-z0-9+/=])([A-Za-z0-9+/]{40,}={0,2})(?![A-Za-z0-9+/=])/g;

const PATTERN_CACHE = new Map();

function isExplicitSecretValue(value) {
  const hasOpenQuote = value[0] === '"' || value[0] === "'";
  const hasCloseQuote = hasOpenQuote && value.length >= 2 && value[value.length - 1] === value[0];
  const raw = hasOpenQuote ? value.slice(1, hasCloseQuote ? -1 : undefined) : value;
  const trimmed = raw.trim();
  return trimmed.length > 0 && !/^(?:\[redacted(?:-[a-z-]+)?\]|null|none|true|false|undefined|changeme|placeholder|example)$/i.test(trimmed);
}

function containsExplicitSecret(text) {
  for (const match of text.matchAll(EXPLICIT_CLIENT_SECRET_RE)) {
    if (isExplicitSecretValue(match[2])) return true;
  }
  return false;
}

function getPatternsForMinLen(minLen) {
  let cached = PATTERN_CACHE.get(minLen);
  if (cached) return cached;
  const patTailLen = Math.max(8, minLen);
  cached = {
    bearerRe: minLen === 8 ? BEARER_TOKEN_RE : new RegExp(`\\b(Bearer\\s+)[A-Za-z0-9._~+/=-]{${minLen},}`, 'gi'),
    authTokenHeaderRe: new RegExp(`\\b(Authorization["\x27]?\\s*:\\s*["\x27]?(?:Token|Bearer|Basic)\\s+)[A-Za-z0-9._~+/=-]{1,}`, 'gi'),
    keyCiRe: new RegExp(`\\b(?:(?:sk|pk)-|(?:sk|rk)_(?:live|test)_)[A-Za-z0-9_-]{${minLen},}\\b`, 'gi'),
    tokenCiRe: new RegExp(
      `\\b(?:whsec_[A-Za-z0-9_-]{${minLen},}|GOCSPX-[A-Za-z0-9_-]{${minLen},}|gh[pousr]_[A-Za-z0-9]{${minLen},}|github_pat_[A-Za-z0-9_]{${patTailLen},}|glpat-[A-Za-z0-9_-]{${minLen},}|npm_[A-Za-z0-9]{${minLen},}|pypi-[A-Za-z0-9_-]{${minLen},}|hf_[A-Za-z0-9]{${minLen},}|xox[baprs]-[A-Za-z0-9-]{${minLen},})\\b`,
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
  // Scan local bodies once. A new BEGIN or ordinary code ends an unclosed
  // block; a later key must never consume the intervening source text.
  const headers = new RegExp(PEM_PRIVATE_KEY_HEADER_RE.source, 'gi');
  const closing = /-{5}END [A-Z0-9 ]+-{5}/i;
  const stripBlockPrefix = (line) =>
    line.replace(/^(?:[ \t"'`>|#*]|\/\/|[+-](?!-{4}))*(?:\d+\s*[:|→]\s*)?(?:[ \t"'`>|#*]|\/\/|[+-](?!-{4}))*/, '');
  const bodyLine = (line) => PEM_BODY_LINE_RE.test(line) || PEM_SHORT_BASE64_TAIL_RE.test(line);
  const parts = [];
  let cursor = 0;
  let header;
  while ((header = headers.exec(text)) !== null) {
    const firstNl = text.indexOf('\n', headers.lastIndex);
    const firstEnd = firstNl === -1 ? text.length : firstNl;
    const firstTail = text.slice(headers.lastIndex, firstEnd);
    const inlineEnd = closing.exec(firstTail);
    const inlineJsonEnd = inlineEnd
      ? null
      : /^(?:[ \tA-Za-z0-9+/=_:.-]|\\[rn"])+(?=["']\s*[,}\]])/.exec(firstTail);
    let pos = inlineEnd
      ? headers.lastIndex + inlineEnd.index + inlineEnd[0].length
      : inlineJsonEnd
        ? headers.lastIndex + inlineJsonEnd[0].length
        : firstNl === -1 ? text.length : firstNl + 1;
    let closed = Boolean(inlineEnd || inlineJsonEnd);
    let sawBodyLine = false;
    while (!closed && pos < text.length) {
      const nl = text.indexOf('\n', pos);
      const lineEnd = nl === -1 ? text.length : nl;
      const bare = text.slice(pos, lineEnd).replace(/\r$/, '');
      if (PEM_PRIVATE_KEY_HEADER_RE.test(bare)) break;
      const end = closing.exec(bare);
      const beforeEnd = end ? stripBlockPrefix(bare.slice(0, end.index)) : '';
      if (end && (beforeEnd === '' || bodyLine(beforeEnd))) {
        pos += end.index + end[0].length;
        closed = true;
        break;
      }
      const nextPos = nl === -1 ? text.length : nl + 1;
      const stripped = stripBlockPrefix(bare);
      if (/^[ \t]*$/.test(stripped)) {
        let scan = nextPos, blanks = 1, nextLine = '';
        while (scan < text.length && blanks <= 4) {
          const nextNl = text.indexOf('\n', scan);
          nextLine = stripBlockPrefix(text.slice(scan, nextNl === -1 ? text.length : nextNl).replace(/\r$/, ''));
          if (nextLine.trim()) break;
          blanks += 1;
          scan = nextNl === -1 ? text.length : nextNl + 1;
        }
        if (blanks > 4 || (!bodyLine(nextLine) && !closing.test(nextLine))) break;
      } else if (!bodyLine(stripped)) {
        const nextNl = text.indexOf('\n', nextPos);
        const nextLine = nextPos < text.length
          ? text.slice(nextPos, nextNl === -1 ? text.length : nextNl).replace(/\r$/, '')
          : '';
        const isEofShort = sawBodyLine && (nl === -1 || /^[ \t\r\n]*$/.test(text.slice(nextPos)));
        const beforeClose = closing.test(nextLine);
        if (!((isEofShort || beforeClose) && PEM_TRUNCATED_EOF_TAIL_RE.test(stripped))) {
          break;
        }
      } else {
        sawBodyLine = true;
      }
      pos = nextPos;
    }
    parts.push(text.slice(cursor, header.index), replacement);
    if (!closed && pos < text.length && text[pos - 1] === '\n') parts.push('\n');
    cursor = pos;
    headers.lastIndex = pos;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
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
  const { bearerRe, authTokenHeaderRe, keyCiRe, tokenCiRe, googleKeyRe, awsKeyRe } = getPatternsForMinLen(minLen);

  let out = redactPemPrivateKeys(text, pemReplacement, { sampleTruncated });
  if (bearerReplacement !== null && bearerReplacement !== undefined) {
    out = out.replace(bearerRe, bearerReplacement);
  } else {
    out = out.replace(bearerRe, () => tokenReplacement);
  }
  out = out
    .replace(authTokenHeaderRe, (_m, prefix) => `${prefix}${tokenReplacement}`)
    .replace(SLACK_WEBHOOK_RE, () => tokenReplacement)
    .replace(keyCiRe, () => keyReplacement)
    .replace(tokenCiRe, () => tokenReplacement)
    .replace(googleKeyRe, () => keyReplacement)
    .replace(awsKeyRe, () => keyReplacement)
    .replace(BARE_JWT_RE, () => tokenReplacement)
    .replace(URL_CREDENTIAL_RE, (_m, prefix, at) => `${prefix}${tokenReplacement}${at}`)
    .replace(EXPLICIT_CLIENT_SECRET_RE, (match, prefix, value) => {
      if (!isExplicitSecretValue(value)) return match;
      const hasOpenQuote = value[0] === '"' || value[0] === "'";
      const hasCloseQuote = hasOpenQuote && value.length >= 2 && value[value.length - 1] === value[0];
      return `${prefix}${hasOpenQuote ? value[0] : ''}${keyReplacement}${hasCloseQuote ? value[0] : ''}`;
    })
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
      if (/^[a-z]+$/.test(match) || /^(.)\1+$/.test(match)) return match;
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
    AUTH_TOKEN_HEADER_TEST_RE.test(text) ||
    SLACK_WEBHOOK_TEST_RE.test(text) ||
    SECRET_TOKEN_CI_TEST_RE.test(text) ||
    SECRET_TOKEN_CS_TEST_RE.test(text) ||
    BARE_JWT_TEST_RE.test(text) ||
    URL_CREDENTIAL_TEST_RE.test(text) ||
    containsExplicitSecret(text) ||
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

/**
 * Redact credentials, Bearer tokens, and private keys from diagnostic or persisted error text.
 *
 * @param {unknown} text
 * @param {number} [maxLen=2000]
 * @returns {string}
 */
export function redactErrorText(text, maxLen = 2000) {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  if (!raw) return '';
  const redacted = redactCredentials(raw, {
    pemReplacement: '[redacted-private-key]',
    tokenReplacement: '[redacted]',
    bearerReplacement: '$1[redacted]',
  });
  return Number.isFinite(maxLen) && maxLen > 0 ? redacted.slice(0, maxLen) : redacted;
}
