import {createHash} from 'node:crypto';
import {summaryProse,validateSummaryStructure} from './validate.js';
import {sourceEvidenceSentences} from './audit.js';

const normalized = value => String(value ?? '').toLowerCase().replace(/\*\*|__/g,'').replace(/\s+/g,' ').trim();
const digest = value => createHash('sha256').update(value).digest('hex');

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
  const proseLines = new Set(prose.split('\n'));
  const replacements = new Map();
  const receipts = [];
  for (const item of audit.lost) {
    if (!item.candidate || item.reason === 'coverage') return null;
    const messages = userMessages.filter(m=>m.seq===item.seq);
    // A pasted transcript can be one enormous physical line. Preserve the
    // entire logical sentence, including commas and conditions, using the
    // auditor's literal-aware boundaries. Never excerpt only the matched verb.
    const sources = [...new Set(messages.flatMap(m=>sourceEvidenceSentences(m.text)).filter(line=>normalized(line).includes(normalized(item.line))))];
    if (sources.length !== 1 || !sources[0].trim()) return null;
    const owner = messages.find(m=>typeof m.text === 'string' && m.text.includes(sources[0]));
    if (!owner) return null;
    const conflicts = item.conflicts?.length ? item.conflicts : [item];
    const candidates = [...proseLines].filter(line=>!/^\s*#{1,6}\s/.test(line) && line !== `> ${sources[0]}` && conflicts.some(conflict=>conflict.candidate && normalized(line).includes(normalized(conflict.candidate))));
    if (!candidates.length) return null;
    for (const candidate of candidates) {
      if (!replacements.has(candidate)) replacements.set(candidate,new Map());
      const fragments=sourceEvidenceSentences(candidate).filter(fragment=>conflicts.some(conflict=>conflict.candidate&&normalized(fragment).includes(normalized(conflict.candidate))));
      if(!fragments.length)return null;
      for(const fragment of fragments){
        if(!replacements.get(candidate).has(fragment))replacements.get(candidate).set(fragment,new Map());
        replacements.get(candidate).get(fragment).set(`${item.seq}\0${sources[0]}`,{seq:item.seq,text:sources[0]});
      }
    }
    receipts.push({seq:item.seq,reason:item.reason,sourceMessageSha256:digest(owner.text),sourceSha256:digest(sources[0]),sourceStart:owner.text.indexOf(sources[0]),sourceLength:sources[0].length,removedLineSha256:candidates.map(digest)});
  }
  // Keep eight physical lines per pass (independent of issue count) and the engine's sixteen-line lifetime
  // budget. Any unprocessed conflict must still fail the next full audit.
  const selected = new Map([...replacements].slice(0,8));
  const selectedHashes = new Set([...selected.keys()].map(digest));
  const selectedReceipts = receipts.map(r=>({...r,removedLineSha256:r.removedLineSha256.filter(h=>selectedHashes.has(h))})).filter(r=>r.removedLineSha256.length);
  // Preserve section 6 byte-for-byte by operating on the original model
  // response (its placeholder), not on the materialized full checkpoint.
  const rebuilt=text.split('\n').map(line=>selected.has(line)
    ? sourceEvidenceSentences(line).map(fragment=>selected.get(line).has(fragment)
      ? '\n'+[...selected.get(line).get(fragment).values()].map(source=>`> User source (seq ${source.seq}), verbatim:\n> ${source.text}`).join('\n')+'\n'
      : fragment).join('')
    : line).join('\n');
  if (rebuilt===text || Buffer.byteLength(rebuilt,'utf8')-Buffer.byteLength(text,'utf8')>8192) return null;
  return {text:rebuilt,receipts:selectedReceipts};
}
