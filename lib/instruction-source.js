// Structural channel and explicit XML quotation boundary resolution.
// Trusts only host event provenance (`sourceKind` / `role`) and explicit XML
// containers (`<untrusted_reference>`, `<quoted_text>`, etc.) instead of
// guessing natural-language citation prose.

import { copySourceLayout } from './source-refs.js';
import { isReferenceContextKind } from './source-provenance.js';

const boundaries = new WeakMap();
const blocksOf = (message) => (message?.blocks?.length ? message.blocks : [{ text: message?.text ?? '' }]);

const SYSTEM_REMINDER_TAG_RE = /<(\/?)system[-_]?reminder(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?>/gi;
const REFERENCE_TAG_RE = /<(\/?)(untrusted[-_]?reference|quoted[-_]?text|untrusted[-_]?text|reference|blockquote)(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?>/gi;
const VERIFIED_TAG_RE = /<\/?verified[-_]?user[-_]?message(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?>/gi;

function textBlocksOf(message) {
  if (typeof message === 'string') return [message];
  if (!message || typeof message !== 'object') return [];
  if (Array.isArray(message.blocks) && message.blocks.length > 0) {
    return message.blocks
      .filter((b) => b && typeof b === 'object' && typeof b.text === 'string')
      .map((b) => b.text);
  }
  if (typeof message.content === 'string') return [message.content];
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text);
  }
  if (typeof message.text === 'string') return [message.text];
  return [];
}

/**
 * Isolated per-block pass for `<system-reminder>...</system-reminder>`.
 * Kept separate from REFERENCE_TAG_RE so literal `<reference>` or `<blockquote>`
 * inside injected docs (e.g. AGENTS.md) cannot break closing `</system-reminder>`
 * or swallow subsequent real user instructions. Unclosed tags fail closed only
 * through the end of their own block.
 */
export function systemReminderSpans(text) {
  const value = String(text ?? '');
  if (!/<\/?system[-_]?reminder\b/i.test(value)) return [];
  const excluded = [];
  let depth = 0;
  let openStart = -1;
  for (const match of value.matchAll(SYSTEM_REMINDER_TAG_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    const isClosing = match[1] === '/';
    const isSelfClosing = !isClosing && match[0].endsWith('/>');
    if (isSelfClosing) {
      if (depth === 0 && end > start) excluded.push({ start, end, reference: true, systemReminder: true });
      continue;
    }
    if (!isClosing) {
      if (depth === 0) openStart = start;
      depth += 1;
      continue;
    }
    if (depth > 0) {
      depth -= 1;
      if (depth === 0 && end > openStart) {
        excluded.push({ start: openStart, end, reference: true, systemReminder: true });
        openStart = -1;
      }
    } else if (end > start) {
      excluded.push({ start, end, reference: true, systemReminder: true });
    }
  }
  if (depth > 0 && openStart >= 0 && value.length > openStart) {
    excluded.push({ start: openStart, end: value.length, reference: true, systemReminder: true });
  }
  return excluded;
}

export function isSystemReminderOnly(message) {
  const blocks = textBlocksOf(message);
  if (blocks.length === 0) return false;
  let sawReminder = false;
  let sawNonWhitespace = false;
  for (const text of blocks) {
    if (text.trim().length > 0) sawNonWhitespace = true;
    const spans = systemReminderSpans(text);
    if (spans.length > 0) sawReminder = true;
    let cursor = 0;
    for (const span of spans) {
      if (text.slice(cursor, span.start).trim().length > 0) return false;
      cursor = span.end;
    }
    if (text.slice(cursor).trim().length > 0) return false;
  }
  return sawReminder && sawNonWhitespace;
}

export function extractSystemReminderMeta(text) {
  const value = String(text ?? '');
  const sources = [];
  const seen = new Set();
  for (const match of value.matchAll(/Instructions\s+from:\s*([^\r\n]{1,200})/gi)) {
    const cleaned = match[1].trim().replace(/\s+/g, ' ');
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      sources.push(cleaned);
      if (sources.length >= 4) break;
    }
  }
  const label = sources.length > 0 ? ` (Instructions from: ${sources.join(', ')})` : '';
  return { sources, label, chars: value.length };
}

export function replaceSystemReminders(text, replacer) {
  const value = String(text ?? '');
  const spans = systemReminderSpans(value);
  if (spans.length === 0) return { text: value, replaced: 0 };
  let out = '';
  let cursor = 0;
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i];
    out += value.slice(cursor, span.start);
    out += replacer(value.slice(span.start, span.end), i, span);
    cursor = span.end;
  }
  out += value.slice(cursor);
  return { text: out, replaced: spans.length };
}

function mergeExcluded(excluded) {
  excluded.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const item of excluded) {
    const prev = merged.at(-1);
    if (prev && item.start <= prev.end) {
      prev.end = Math.max(prev.end, item.end);
    } else {
      merged.push({ start: item.start, end: item.end });
    }
  }
  return merged;
}

function textRanges(text, reminderSpans = []) {
  const value = String(text ?? '');
  let scanTarget = value;
  if (reminderSpans.length > 0) {
    let masked = '';
    let cursor = 0;
    for (const span of reminderSpans) {
      masked += value.slice(cursor, span.start) + ' '.repeat(span.end - span.start);
      cursor = span.end;
    }
    masked += value.slice(cursor);
    scanTarget = masked;
  }

  const excluded = [];
  const stack = [];
  for (const match of scanTarget.matchAll(REFERENCE_TAG_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    const tag = match[2].toLowerCase().replace(/-/g, '_');
    const isClosing = match[1] === '/';
    const isSelfClosing = !isClosing && match[0].endsWith('/>');
    if (isSelfClosing) {
      if (stack.length === 0 && end > start) excluded.push({ start, end });
      continue;
    }
    if (!isClosing) {
      stack.push({ tag, start });
      continue;
    }
    if (stack.length > 0 && stack.at(-1).tag === tag) {
      const opened = stack.pop();
      if (stack.length === 0 && end > opened.start) {
        excluded.push({ start: opened.start, end });
      }
    } else if (stack.length > 0) {
      // Malformed nesting inside an open reference tag fails closed through end of message.
      break;
    } else if (end > start) {
      excluded.push({ start, end });
    }
  }
  if (stack.length > 0 && scanTarget.length > stack[0].start) {
    excluded.push({ start: stack[0].start, end: scanTarget.length });
  }
  for (const match of scanTarget.matchAll(VERIFIED_TAG_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    if (end > start) excluded.push({ start, end });
  }

  const refSpans = mergeExcluded(excluded);
  const remSpans = mergeExcluded(reminderSpans);

  if (remSpans.length === 0) {
    const result = [];
    let cursor = 0;
    for (const range of refSpans) {
      if (range.start > cursor) result.push({ start: cursor, end: range.start, reference: false, systemReminder: false });
      result.push({ start: range.start, end: range.end, reference: true, systemReminder: false });
      cursor = range.end;
    }
    if (cursor < value.length) result.push({ start: cursor, end: value.length, reference: false, systemReminder: false });
    return result;
  }

  const points = new Set([0, value.length]);
  for (const r of refSpans) { points.add(r.start); points.add(r.end); }
  for (const r of remSpans) { points.add(r.start); points.add(r.end); }
  const sorted = [...points].sort((a, b) => a - b);
  const result = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (end <= start) continue;
    const inRem = remSpans.some((r) => r.start <= start && r.end >= end);
    const inRef = refSpans.some((r) => r.start <= start && r.end >= end);
    const reference = inRem || inRef;
    const systemReminder = inRem && !inRef;
    const prev = result.at(-1);
    if (prev && prev.end === start && prev.reference === reference && prev.systemReminder === systemReminder) {
      prev.end = end;
    } else {
      result.push({ start, end, reference, systemReminder });
    }
  }
  return result;
}

export function instructionRanges(message) {
  if (boundaries.has(message)) return boundaries.get(message);
  const blocks = blocksOf(message).map((b) => String(b?.text ?? ''));
  if (isReferenceContextKind(message?.sourceKind) || message?.role === 'tool' || message?.externalFold === true) {
    const refOnly = blocks.map((text) =>
      text.length > 0 ? [{ start: 0, end: text.length, reference: true, systemReminder: false }] : [],
    );
    boundaries.set(message, refOnly);
    return refOnly;
  }
  const globalReminders = [];
  let blockOffset = 0;
  for (const text of blocks) {
    for (const span of systemReminderSpans(text)) {
      globalReminders.push({ start: blockOffset + span.start, end: blockOffset + span.end });
    }
    blockOffset += text.length + 1;
  }
  const ranges = textRanges(blocks.join('\n'), globalReminders);
  let offset = 0;
  const result = blocks.map((text) => {
    const selected = ranges
      .filter((r) => r.start < offset + text.length && r.end > offset)
      .map((r) => ({
        start: Math.max(0, r.start - offset),
        end: Math.min(text.length, r.end - offset),
        reference: r.reference,
        systemReminder: Boolean(r.systemReminder),
      }));
    offset += text.length + 1;
    return selected;
  });
  boundaries.set(message, result);
  return result;
}

export function instructionText(message) {
  const blocks = blocksOf(message);
  const ranges = instructionRanges(message);
  return blocks
    .flatMap((block, index) =>
      ranges[index].filter((r) => !r.reference).map((r) => String(block.text ?? '').slice(r.start, r.end)),
    )
    .join('\n');
}

export function instructionSlices(message) {
  const blocks = blocksOf(message);
  const ranges = instructionRanges(message);
  let offset = 0;
  return blocks.flatMap((block, index) => {
    const text = String(block.text ?? '');
    const result = ranges[index]
      .filter((r) => !r.reference)
      .map((r) => ({ text: text.slice(r.start, r.end), start: offset + r.start }));
    offset += text.length + 1;
    return result;
  });
}

export function referenceTexts(message) {
  const blocks = blocksOf(message);
  const ranges = instructionRanges(message);
  return blocks
    .flatMap((block, index) =>
      ranges[index].filter((r) => r.reference).map((r) => String(block.text ?? '').slice(r.start, r.end)),
    )
    .filter((text) => text.trim());
}

export function copyInstructionBoundaries(original, selected) {
  boundaries.set(selected, instructionRanges(original));
  return copySourceLayout(original, selected);
}

export function projectInstructionBoundaries(selected, original, layout) {
  const source = instructionRanges(original);
  const projected = layout.blocks.map((block) => {
    let offset = 0;
    const ranges = [];
    for (const part of block.parts) {
      if (typeof part.space === 'string') {
        offset += part.space.length;
        continue;
      }
      for (const range of source[part.block] ?? []) {
        const start = Math.max(part.start, range.start);
        const end = Math.min(part.end, range.end);
        if (end > start) {
          ranges.push({
            start: offset + start - part.start,
            end: offset + end - part.start,
            reference: range.reference,
            systemReminder: Boolean(range.systemReminder),
          });
        }
      }
      offset += part.end - part.start;
    }
    return ranges;
  });
  boundaries.set(selected, projected);
  return selected;
}
