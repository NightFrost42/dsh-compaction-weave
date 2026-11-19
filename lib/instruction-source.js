// Structural channel and explicit XML quotation boundary resolution.
// Trusts only host event provenance (`sourceKind` / `role`) and explicit XML
// containers (`<untrusted_reference>`, `<quoted_text>`, etc.) instead of
// guessing natural-language citation prose.

import { copySourceLayout } from './source-refs.js';
import { isReferenceContextKind } from './source-provenance.js';

const boundaries = new WeakMap();
const blocksOf = (message) => (message?.blocks?.length ? message.blocks : [{ text: message?.text ?? '' }]);

const REFERENCE_TAG_RE = /<(\/?)(untrusted[-_]?reference|quoted[-_]?text|untrusted[-_]?text|reference|blockquote)(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?>/gi;
const VERIFIED_TAG_RE = /<\/?verified[-_]?user[-_]?message(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?>/gi;

function textRanges(text) {
  const value = String(text ?? '');
  const excluded = [];
  const stack = [];
  for (const match of value.matchAll(REFERENCE_TAG_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    const tag = match[2].toLowerCase().replace(/-/g, '_');
    const isClosing = match[1] === '/';
    const isSelfClosing = !isClosing && match[0].endsWith('/>');
    if (isSelfClosing) {
      if (stack.length === 0 && end > start) excluded.push({ start, end, reference: true });
      continue;
    }
    if (!isClosing) {
      stack.push({ tag, start });
      continue;
    }
    if (stack.length > 0 && stack.at(-1).tag === tag) {
      const opened = stack.pop();
      if (stack.length === 0 && end > opened.start) {
        excluded.push({ start: opened.start, end, reference: true });
      }
    } else if (stack.length > 0) {
      // Malformed nesting inside an open reference tag fails closed through end of message.
      break;
    } else if (end > start) {
      excluded.push({ start, end, reference: true });
    }
  }
  if (stack.length > 0 && value.length > stack[0].start) {
    excluded.push({ start: stack[0].start, end: value.length, reference: true });
  }
  for (const match of value.matchAll(VERIFIED_TAG_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    if (end > start) excluded.push({ start, end, reference: true });
  }

  excluded.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const item of excluded) {
    const prev = merged.at(-1);
    if (prev && item.start <= prev.end) {
      prev.end = Math.max(prev.end, item.end);
    } else {
      merged.push({ ...item });
    }
  }

  const result = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) result.push({ start: cursor, end: range.start, reference: false });
    result.push(range);
    cursor = range.end;
  }
  if (cursor < value.length) result.push({ start: cursor, end: value.length, reference: false });
  return result;
}

export function instructionRanges(message) {
  if (boundaries.has(message)) return boundaries.get(message);
  const blocks = blocksOf(message).map((b) => String(b.text ?? ''));
  if (isReferenceContextKind(message?.sourceKind) || message?.role === 'tool') {
    const refOnly = blocks.map((text) => (text.length > 0 ? [{ start: 0, end: text.length, reference: true }] : []));
    boundaries.set(message, refOnly);
    return refOnly;
  }
  const ranges = textRanges(blocks.join('\n'));
  let offset = 0;
  const result = blocks.map((text) => {
    const selected = ranges
      .filter((r) => r.start < offset + text.length && r.end > offset)
      .map((r) => ({
        start: Math.max(0, r.start - offset),
        end: Math.min(text.length, r.end - offset),
        reference: r.reference,
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
          ranges.push({ start: offset + start - part.start, end: offset + end - part.start, reference: range.reference });
        }
      }
      offset += part.end - part.start;
    }
    return ranges;
  });
  boundaries.set(selected, projected);
  return selected;
}
