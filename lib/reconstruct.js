import {createHash} from 'node:crypto';
import {summaryProse,validateSummaryStructure} from './validate.js';
import {sourceEvidenceSentences} from './audit.js';
import {instructionSlices} from './instruction-source.js';
import {isReferenceContextKind} from './source-provenance.js';

const normalized = value => String(value ?? '').toLowerCase().replace(/\*\*|__/g,'').replace(/\s+/g,' ').trim();
const digest = value => createHash('sha256').update(value).digest('hex');

const LEADING_LIST_MARKER_RE = /^\s*(?:[-*•+]|\d+[.)、])\s+/;
const TRAILING_SENTENCE_PUNCT_RE = /[。！？.!?;；]+$/;
const OUTER_QUOTE_PAIRS = [
  ['「', '」'],
  ['『', '』'],
  ['"', '"'],
  ['“', '”'],
  ['‘', '’'],
];

function unwrapMatchingOuterQuotes(text) {
  let cur = text.trim();
  let changed = true;
  while (changed && cur.length >= 2) {
    changed = false;
    for (const [open, close] of OUTER_QUOTE_PAIRS) {
      if (cur.startsWith(open) && cur.endsWith(close) && cur.length > open.length + close.length) {
        const inner = cur.slice(open.length, cur.length - close.length).trim();
        if (inner && !inner.includes(close)) {
          cur = inner;
          changed = true;
          break;
        }
      }
    }
  }
  return cur;
}

/**
 * Case-preserving canonical key for grouping equivalent verbatim copies of the
 * same source instruction across minor Markdown/bullet/punctuation formatting
 * variations. Case differences remain distinct so case-ambiguity fails closed.
 */
export function equivalentSourceKey(value) {
  let cur = String(value ?? '').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
  cur = cur.replace(LEADING_LIST_MARKER_RE, '').trim();
  cur = unwrapMatchingOuterQuotes(cur);
  cur = cur.replace(TRAILING_SENTENCE_PUNCT_RE, '').trim();
  return cur;
}

/**
 * Tolerant lowercase normalization used only after exact `normalized()` matching
 * misses due to split quotes, seq citations, bold markers, or full-width punctuation.
 */
export function relaxedNormalized(value) {
  return String(value ?? '')
    .replace(/\[seq\s*#?\d+\]/gi, ' ')
    .replace(/[（(]\s*seq\s*#?\d+\s*[)）]/gi, ' ')
    .replace(/\*\*|__|[*`]/g, '')
    .replace(/[「」『』"“”‘’]/g, '')
    .replace(/[，、]/g, ',')
    .replace(/[。．]/g, '.')
    .replace(/；/g, ';')
    .replace(/：/g, ':')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[.,;!?]+$/, '')
    .trim();
}

export function matchesCandidate(haystack, needle) {
  const exactNeedle = normalized(needle);
  if (!exactNeedle) return false;
  if (normalized(haystack).includes(exactNeedle)) return true;
  const relaxedNeedle = relaxedNormalized(needle);
  if (relaxedNeedle.length < 4) return false;
  return relaxedNormalized(haystack).includes(relaxedNeedle);
}

function selectPreferredSourceMatch(matches) {
  const cleaned = matches.find(m => !/^\s*(?:[-*•+]|\d+[.)、]\s|\*\*|__)/.test(m.text));
  return cleaned ?? matches[0];
}

/**
 * Reconstruct disputed MODEL sentences from complete ORIGINAL user sentences. This is
 * not an audit exemption: the caller must re-run every commit validator.
 * Never copy the auditor's normalized text (which may have lowercased code).
 * No fuzzy source lookup, no arbitrary truncation and no repair of missing
 * originals. The rejected model response remains available in rawOutput.
 */
export function reconstructDisputedLines({text,userMessages,audit,language,format}) {
  const structured = format === 'continuation' ? JSON.stringify(text.match(/^## .+$/gm)) === JSON.stringify(['## Goal','## State','## Next','## Uncertain']) : validateSummaryStructure(text,{language}).ok;
  if (!audit?.lost?.length || !structured) return null;
  const prose = summaryProse(text);
  const fencedProseLineSet = new Set();
  {
    let fenceChar = '';
    let fenceLen = 0;
    for (const rawLine of prose.split('\n')) {
      const trimmedStart = rawLine.replace(/^[ ]{0,3}/, '');
      if (fenceChar) {
        fencedProseLineSet.add(rawLine);
        let closeCount = 0;
        while (closeCount < trimmedStart.length && trimmedStart[closeCount] === fenceChar) closeCount += 1;
        const rest = trimmedStart.slice(closeCount);
        if (closeCount >= fenceLen && /^[ \t]*$/.test(rest)) {
          fenceChar = '';
          fenceLen = 0;
        }
        continue;
      }
      if (trimmedStart.startsWith('```') || trimmedStart.startsWith('~~~')) {
        const ch = trimmedStart[0];
        let openCount = 0;
        while (openCount < trimmedStart.length && trimmedStart[openCount] === ch) openCount += 1;
        const info = trimmedStart.slice(openCount);
        if (ch === '~' || !info.includes('`')) {
          fenceChar = ch;
          fenceLen = openCount;
          fencedProseLineSet.add(rawLine);
        }
      }
    }
  }
  const proseLines = new Set(prose.split('\n').filter((line) => !fencedProseLineSet.has(line)));
  const replacements = new Map();
  const wholeLineReplacements = new Set();
  const receipts = [];
  for (const item of audit.lost) {
    // Skip non-reconstructable coverage/provenance entries so mixed audit.lost batches
    // can still repair blocking conflicts cleanly.
    if (!item.candidate || ['coverage','provenance'].includes(item.reason)) continue;
    const messages = userMessages.filter(m=>m.seq===item.seq&&!isReferenceContextKind(m.sourceKind));
    // A pasted transcript can be one enormous physical line. Preserve the
    // entire logical sentence, including commas and conditions, using the
    // auditor's literal-aware boundaries. Never excerpt only the matched verb.
    const matches=messages.flatMap(owner=>instructionSlices(owner).flatMap(slice=>{
      let cursor=0;
      return sourceEvidenceSentences(slice.text).map(text=>{
        const at=slice.text.indexOf(text,cursor);cursor=at+text.length;
        return {text,owner,start:slice.start+at};
      });
    })).filter(source=>matchesCandidate(source.text, item.line));
    const groups = new Map();
    for (const m of matches) {
      const trimmed = m.text.trim();
      if (!trimmed) continue;
      const key = equivalentSourceKey(m.text);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    if (groups.size !== 1) return null;
    const [onlyGroup] = groups.values();
    const chosen = selectPreferredSourceMatch(onlyGroup);
    const chosenSourceText = chosen?.text;
    const owner = chosen?.owner;
    if (!chosenSourceText || !chosenSourceText.trim() || !owner) return null;
    const conflicts = item.conflicts?.length ? item.conflicts : [item];
    const candidates = [...proseLines].filter(line=>!/^\s*#{1,6}\s/.test(line) && line !== `> ${chosenSourceText}` && !/^\s*>\s*User source \(seq \d+\), verbatim:/.test(line) && conflicts.some(conflict=>conflict.candidate && matchesCandidate(line, conflict.candidate)));
    if (!candidates.length) return null;
    for (const candidate of candidates) {
      if (!replacements.has(candidate)) replacements.set(candidate,new Map());
      const lineFragments = sourceEvidenceSentences(candidate);
      let fragments = lineFragments.filter(fragment=>conflicts.some(conflict=>conflict.candidate&&matchesCandidate(fragment, conflict.candidate)));
      if (!fragments.length && lineFragments.length <= 1 && conflicts.some(conflict=>conflict.candidate&&matchesCandidate(candidate, conflict.candidate))) {
        fragments = [candidate];
        wholeLineReplacements.add(candidate);
      }
      if(!fragments.length)return null;
      for(const fragment of fragments){
        if(!replacements.get(candidate).has(fragment))replacements.get(candidate).set(fragment,new Map());
        replacements.get(candidate).get(fragment).set(`${item.seq}\0${chosenSourceText}`,{seq:item.seq,text:chosenSourceText});
      }
    }
    receipts.push({seq:item.seq,reason:item.reason,sourceMessageSha256:digest(owner.text),sourceSha256:digest(chosenSourceText),sourceStart:chosen.start,sourceLength:chosenSourceText.length,removedLineSha256:candidates.map(digest)});
  }
  if (replacements.size === 0) return null;
  // Keep eight physical lines per pass (independent of issue count) and the engine's sixteen-line lifetime
  // budget. Any unprocessed conflict must still fail the next full audit.
  const selected = new Map([...replacements].slice(0,8));
  const selectedHashes = new Set([...selected.keys()].map(digest));
  const selectedReceipts = receipts.map(r=>({...r,removedLineSha256:r.removedLineSha256.filter(h=>selectedHashes.has(h))})).filter(r=>r.removedLineSha256.length);
  // Preserve section 6 byte-for-byte by operating on the original model
  // response (its placeholder), not on the materialized full checkpoint.
  const renderVerbatim = (sourceMap) => '\n'+[...sourceMap.values()].map(source=>`> User source (seq ${source.seq}), verbatim:\n> ${source.text}`).join('\n')+'\n';
  let rebuildFenceChar = '';
  let rebuildFenceLen = 0;
  const rebuilt = text.split('\n').map(line => {
    const trimmedStart = line.replace(/^[ ]{0,3}/, '');
    if (rebuildFenceChar) {
      let closeCount = 0;
      while (closeCount < trimmedStart.length && trimmedStart[closeCount] === rebuildFenceChar) closeCount += 1;
      const rest = trimmedStart.slice(closeCount);
      if (closeCount >= rebuildFenceLen && /^[ \t]*$/.test(rest)) {
        rebuildFenceChar = '';
        rebuildFenceLen = 0;
      }
      return line;
    }
    if (trimmedStart.startsWith('```') || trimmedStart.startsWith('~~~')) {
      const ch = trimmedStart[0];
      let openCount = 0;
      while (openCount < trimmedStart.length && trimmedStart[openCount] === ch) openCount += 1;
      const info = trimmedStart.slice(openCount);
      if (ch === '~' || !info.includes('`')) {
        rebuildFenceChar = ch;
        rebuildFenceLen = openCount;
        return line;
      }
    }
    if (!selected.has(line)) return line;
    const byFragment = selected.get(line);
    if (wholeLineReplacements.has(line) && byFragment.has(line)) {
      return renderVerbatim(byFragment.get(line));
    }
    const lineFragments = sourceEvidenceSentences(line);
    if (!lineFragments.length && byFragment.has(line)) {
      return renderVerbatim(byFragment.get(line));
    }
    return lineFragments.map(fragment=>byFragment.has(fragment) ? renderVerbatim(byFragment.get(fragment)) : fragment).join('');
  }).join('\n');
  if (rebuilt===text || Buffer.byteLength(rebuilt,'utf8')-Buffer.byteLength(text,'utf8')>8192) return null;
  return {text:rebuilt,receipts:selectedReceipts};
}
