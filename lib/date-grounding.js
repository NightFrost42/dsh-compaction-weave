// Pure, zero-I/O relative date grounding helper for archived and summarized messages.
// Converts unambiguous CN/EN relative date expressions into explicit ISO YYYY-MM-DD anchors
// using each message's recorded timestamp, skipping code fences, inline code, and mock epochs.

import { isExternalFoldEvent, isReferenceContextKind } from './source-provenance.js';
import { instructionText, isReferencePrefixOnly, isSystemReminderOnly } from './instruction-source.js';

export const MIN_VALID_EPOCH_MS = 946684800000; // 2000-01-01T00:00:00.000Z
export const MAX_VALID_EPOCH_MS = 4102444800000; // 2100-01-01T00:00:00.000Z
export const MAX_ANCHORS_PER_MESSAGE = 4;
export const MAX_GROUNDED_ENTRIES_PER_SPAN = 12;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

const CN_WEEKDAYS = Object.freeze({
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
});

const EN_WEEKDAYS = Object.freeze({
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
});

const CN_WEEK_OFFSETS = Object.freeze({
  上上周: -14,
  上上星期: -14,
  本周: 0,
  这周: 0,
  本星期: 0,
  这星期: 0,
  上周: -7,
  上星期: -7,
  下周: 7,
  下星期: 7,
  下下周: 14,
  下下星期: 14,
});

const EN_WEEK_OFFSETS = Object.freeze({
  this: 0,
  last: -7,
  next: 7,
});

const CN_FIXED_OFFSETS = Object.freeze({
  前天: -2,
  昨天: -1,
  昨晚: -1,
  今天: 0,
  今晚: 0,
  今早: 0,
  今日: 0,
  明天: 1,
  明早: 1,
  明晚: 1,
  明日: 1,
  后天: 2,
  大后天: 3,
});

const EN_FIXED_OFFSETS = Object.freeze({
  yesterday: -1,
  today: 0,
  tonight: 0,
  tomorrow: 1,
});

// Single-pass ordered alternation covering unambiguous CN and EN relative date phrases.
const RELATIVE_DATE_RE = new RegExp(
  [
    '(?<cnWeek>(?:上上周|上上星期|下下周|下下星期|本周|这周|上周|下周|本星期|这星期|上星期|下星期)([一二三四五六日天]))',
    '(?<cnDaysAgo>(?<![\\d第.])([1-9]\\d{0,2})\\s*天前)',
    '(?<cnDaysLater>(?<![\\d第.])([1-9]\\d{0,2})\\s*天后)',
    '(?<cnFixed>大后天|(?<!大)前天|昨天|昨晚|今天|今晚|今早|今日|明天|明早|明晚|明日|后天(?!性))',
    '\\b(?<enWeek>(last|this|next)\\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))\\b',
    '(?<!\\.)\\b(?<enDaysAgo>([1-9]\\d{0,2})\\s+days?\\s+ago)\\b',
    '\\b(?<enDaysLater>in\\s+([1-9]\\d{0,2})\\s+days?(?!\\s+ago\\b))\\b',
    '\\b(?<enFixed>yesterday|today|tonight|tomorrow)\\b',
  ].join('|'),
  'gi',
);

function isValidTimestampMs(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_VALID_EPOCH_MS &&
    value <= MAX_VALID_EPOCH_MS
  );
}

function resolveOffsetMinutes(timestampMs, tzOffsetMinutes) {
  if (typeof tzOffsetMinutes === 'number' && Number.isFinite(tzOffsetMinutes) && tzOffsetMinutes >= -840 && tzOffsetMinutes <= 840) {
    return Math.trunc(tzOffsetMinutes);
  }
  return -new Date(timestampMs).getTimezoneOffset();
}

function formatUtcIsoDate(utcMs) {
  const d = new Date(utcMs);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Mask fenced code blocks (``` / ~~~) and inline backtick spans (`...`) with spaces
 * in linear time so relative date words inside code literals are never anchored.
 */
function maskCodeWithSpaces(text) {
  if (!text.includes('`') && !text.includes('~')) return text;

  // Step 1: mask fenced code blocks line-by-line (linear-time, handles unclosed EOF fences).
  const lines = text.split('\n');
  let fenceChar = '';
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const hasCr = rawLine.endsWith('\r');
    const line = hasCr ? rawLine.slice(0, -1) : rawLine;
    const trimmedStart = line.replace(/^[ ]{0,3}/, '');

    if (fenceChar) {
      let closeCount = 0;
      while (closeCount < trimmedStart.length && trimmedStart[closeCount] === fenceChar) {
        closeCount += 1;
      }
      const rest = trimmedStart.slice(closeCount);
      lines[i] = ' '.repeat(line.length) + (hasCr ? '\r' : '');
      if (closeCount >= fenceLen && /^[ \t]*$/.test(rest)) {
        fenceChar = '';
        fenceLen = 0;
      }
      continue;
    }

    if (trimmedStart.startsWith('```') || trimmedStart.startsWith('~~~')) {
      const ch = trimmedStart[0];
      let openCount = 0;
      while (openCount < trimmedStart.length && trimmedStart[openCount] === ch) {
        openCount += 1;
      }
      const info = trimmedStart.slice(openCount);
      if (ch === '~' || !info.includes('`')) {
        fenceChar = ch;
        fenceLen = openCount;
        lines[i] = ' '.repeat(line.length) + (hasCr ? '\r' : '');
      }
    }
  }

  const afterFences = lines.join('\n');
  if (!afterFences.includes('`')) return afterFences;

  // Step 2: mask inline backtick spans without crossing line boundaries.
  let out = '';
  let i = 0;
  const n = afterFences.length;
  while (i < n) {
    const nextTick = afterFences.indexOf('`', i);
    if (nextTick < 0) {
      out += afterFences.slice(i);
      break;
    }
    if (nextTick > i) {
      out += afterFences.slice(i, nextTick);
      i = nextTick;
    }
    let openEnd = i;
    while (openEnd < n && afterFences[openEnd] === '`') openEnd += 1;
    const tickCount = openEnd - i;
    const lineEndRaw = afterFences.indexOf('\n', openEnd);
    const lineEnd = lineEndRaw < 0 ? n : lineEndRaw;

    let closeStart = -1;
    let pos = openEnd;
    while (pos < lineEnd) {
      const tickPos = afterFences.indexOf('`', pos);
      if (tickPos < 0 || tickPos >= lineEnd) break;
      let runEnd = tickPos;
      while (runEnd < lineEnd && afterFences[runEnd] === '`') runEnd += 1;
      if (runEnd - tickPos === tickCount) {
        closeStart = tickPos;
        break;
      }
      pos = runEnd;
    }

    if (closeStart >= 0) {
      const closeEnd = closeStart + tickCount;
      out += ' '.repeat(closeEnd - i);
      i = closeEnd;
    } else {
      out += afterFences.slice(i, openEnd);
      i = openEnd;
    }
  }

  return out;
}

function resolveDeltaDays(match, anchorIsoDow) {
  const g = match.groups;
  if (!g) return null;

  if (g.cnWeek) {
    const weekPrefix = g.cnWeek.slice(0, -1);
    const dayChar = g.cnWeek.slice(-1);
    const weekOffset = CN_WEEK_OFFSETS[weekPrefix];
    const targetIsoDow = CN_WEEKDAYS[dayChar];
    if (weekOffset === undefined || targetIsoDow === undefined) return null;
    return targetIsoDow - anchorIsoDow + weekOffset;
  }

  if (g.cnDaysAgo) {
    const n = Number.parseInt(g.cnDaysAgo, 10);
    return Number.isInteger(n) && n >= 1 && n <= 365 ? -n : null;
  }

  if (g.cnDaysLater) {
    const n = Number.parseInt(g.cnDaysLater, 10);
    return Number.isInteger(n) && n >= 1 && n <= 365 ? n : null;
  }

  if (g.cnFixed) {
    const delta = CN_FIXED_OFFSETS[g.cnFixed];
    return delta === undefined ? null : delta;
  }

  if (g.enWeek) {
    const parts = g.enWeek.toLowerCase().split(/\s+/);
    const weekOffset = EN_WEEK_OFFSETS[parts[0]];
    const targetIsoDow = EN_WEEKDAYS[parts[1]];
    if (weekOffset === undefined || targetIsoDow === undefined) return null;
    return targetIsoDow - anchorIsoDow + weekOffset;
  }

  if (g.enDaysAgo) {
    const m = /^(\d{1,3})\b/.exec(g.enDaysAgo);
    const n = m ? Number.parseInt(m[1], 10) : NaN;
    return Number.isInteger(n) && n >= 1 && n <= 365 ? -n : null;
  }

  if (g.enDaysLater) {
    const m = /\b(\d{1,3})\b/.exec(g.enDaysLater);
    const n = m ? Number.parseInt(m[1], 10) : NaN;
    return Number.isInteger(n) && n >= 1 && n <= 365 ? n : null;
  }

  if (g.enFixed) {
    const delta = EN_FIXED_OFFSETS[g.enFixed.toLowerCase()];
    return delta === undefined ? null : delta;
  }

  return null;
}

/**
 * Extract unambiguous relative date anchors from `text` relative to `timestampMs`.
 * Returns `null` if `timestampMs` is missing/invalid/out-of-range or if no anchors match.
 *
 * @param {string} text
 * @param {number} timestampMs
 * @param {{ tzOffsetMinutes?: number, maxAnchors?: number }} [options]
 * @returns {{ anchorDate: string, anchors: { phrase: string, date: string }[] } | null}
 */
export function extractDateGroundings(text, timestampMs, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return null;
  if (!isValidTimestampMs(timestampMs)) return null;

  const cap =
    Number.isInteger(options?.maxAnchors) && options.maxAnchors > 0
      ? options.maxAnchors
      : MAX_ANCHORS_PER_MESSAGE;

  const offsetMin = resolveOffsetMinutes(timestampMs, options?.tzOffsetMinutes);
  const shifted = new Date(timestampMs + offsetMin * MS_PER_MINUTE);
  const anchorUtcMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  const anchorDate = formatUtcIsoDate(anchorUtcMs);
  const anchorIsoDow = ((shifted.getUTCDay() + 6) % 7) + 1;

  const masked = maskCodeWithSpaces(text);
  const anchors = [];
  const seen = new Set();

  RELATIVE_DATE_RE.lastIndex = 0;
  for (const match of masked.matchAll(RELATIVE_DATE_RE)) {
    const phrase = match[0].replace(/\s+/g, ' ').trim();
    const key = phrase.toLowerCase();
    if (!phrase || seen.has(key)) continue;

    const deltaDays = resolveDeltaDays(match, anchorIsoDow);
    if (deltaDays === null) continue;

    seen.add(key);
    anchors.push({
      phrase,
      date: formatUtcIsoDate(anchorUtcMs + deltaDays * MS_PER_DAY),
    });
    if (anchors.length >= cap) break;
  }

  if (anchors.length === 0) return null;
  return { anchorDate, anchors };
}

/**
 * Format inline relative date groundings (`phrase=YYYY-MM-DD, ...`) or `''` if none.
 *
 * @param {string} text
 * @param {number} timestampMs
 * @param {{ tzOffsetMinutes?: number, maxAnchors?: number }} [options]
 * @returns {string}
 */
export function formatInlineDateGrounding(text, timestampMs, options = {}) {
  const result = extractDateGroundings(text, timestampMs, options);
  if (!result) return '';
  return result.anchors.map((a) => `${a.phrase}=${a.date}`).join(', ');
}

function messageTextOf(session, event) {
  const message =
    typeof session?.deriveEventMessage === 'function'
      ? session.deriveEventMessage(event)
      : (event?.data?.message ?? event?.data);
  if (message?.source?.kind === 'compact-checkpoint') return null;

  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join('\n');
  }
  if (typeof event?.data?.text === 'string') return event.data.text;
  if (typeof event?.text === 'string') return event.text;
  return '';
}

/**
 * Render `<date-grounding>` context block for summary calls from `shadowedSeqs`.
 * Skips `system/message`, `tool/result`, `compact-checkpoint`, and invalid/mock timestamps.
 *
 * @param {object} session
 * @param {readonly number[]} shadowedSeqs
 * @param {{ tzOffsetMinutes?: number, maxEntries?: number, maxAnchors?: number }} [options]
 * @returns {string}
 */
export function renderDateGrounding(session, shadowedSeqs, options = {}) {
  if (!session || typeof session.eventAt !== 'function') return '';
  if (!Array.isArray(shadowedSeqs) || shadowedSeqs.length === 0) return '';

  const maxEntries =
    Number.isInteger(options?.maxEntries) && options.maxEntries > 0
      ? options.maxEntries
      : MAX_GROUNDED_ENTRIES_PER_SPAN;

  const lines = [];
  for (const seq of shadowedSeqs) {
    const event = session.eventAt(seq);
    if (!event) continue;
    if (event.type === 'system/message' || event.type === 'tool/result') continue;
    if (event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint') continue;
    if (event.data?.message?.source?.kind === 'compact-checkpoint') continue;
    if (isExternalFoldEvent(event, session)) continue;

    const durableKind = event.data?.source?.kind ?? event.data?.message?.source?.kind;
    if (isReferenceContextKind(durableKind)) continue;
    const rawMsg =
      typeof session.deriveEventMessage === 'function'
        ? session.deriveEventMessage(event)
        : (event.data?.message ?? event.data);
    if (rawMsg?.source?.kind && isReferenceContextKind(rawMsg.source.kind)) continue;
    if (isSystemReminderOnly(rawMsg) || isReferencePrefixOnly(rawMsg)) continue;

    const rawText = messageTextOf(session, event);
    const hasStructuredUserMsg =
      rawMsg &&
      typeof rawMsg === 'object' &&
      (Array.isArray(rawMsg.content) || Array.isArray(rawMsg.blocks) || typeof rawMsg.content === 'string' || typeof rawMsg.text === 'string');
    if (!rawText && !hasStructuredUserMsg) continue;
    const normalizedMsg = (() => {
      const source = rawMsg?.source ?? event.data?.source;
      if (Array.isArray(rawMsg?.blocks) && rawMsg.blocks.length > 0) {
        return { ...rawMsg, source };
      }
      if (Array.isArray(rawMsg?.content) && rawMsg.content.length > 0) {
        const blocks = rawMsg.content
          .filter((b) => b && typeof b === 'object' && typeof b.text === 'string')
          .map((b) => ({ type: b.type ?? 'text', text: b.text }));
        if (blocks.length > 0) return { ...rawMsg, blocks, source };
      }
      if (typeof rawMsg?.content === 'string') {
        return { ...rawMsg, text: rawMsg.content, source };
      }
      return { text: rawText, source };
    })();
    const text = instructionText(normalizedMsg);
    if (!text) continue;

    const grounded = extractDateGroundings(text, event.time, options);
    if (!grounded) continue;

    const pairs = grounded.anchors.map((a) => `${a.phrase}=${a.date}`).join(', ');
    lines.push(`seq ${seq} (${grounded.anchorDate}): ${pairs}`);
  }

  if (lines.length === 0) return '';
  const bounded = lines.length > maxEntries ? lines.slice(-maxEntries) : lines;
  return `<date-grounding>\n${bounded.join('\n')}\n</date-grounding>`;
}
