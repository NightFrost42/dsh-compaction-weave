import {copySourceLayout} from './source-refs.js';
// User messages can contain both instructions and quoted data. Resolve those
// boundaries from the original text; generated source/kind labels confer no
// authority. Unmarked text (including fences) remains strict for compatibility.
// These are explicit quotation grammars, not a natural-language trust oracle.
const boundaries = new WeakMap();
const blocksOf = message => message.blocks?.length ? message.blocks : [{text:message.text ?? ''}];
const referenceLead = /(?:^(?:\s*(?:[-*+]\s+|#{1,6}\s*))?(?:以下|下列|下面|这里|这是|这段|所附|粘贴|贴出)[^\n。！？]{0,80}(?:引用|历史|旧文档|原文|摘录|样例|示例|日志|网页|工具输出|注入片段)|^(?:\s*)(?:旧文档引用|历史引用|引用(?:内容|开始)?|摘录|样例|示例|网页引用|工具输出)\s*[:：]|\b(?:the following|below is|here is|pasted|quoted|historical|old document)[^\n.!?]{0,100}\b(?:quote|quoted|quotation|excerpt|transcript|document|log|example|reference|note|instructions?|injection attempt)\b|\b(?:archived|obsolete|quoted)[^\n.!?]{0,80}\b(?:instructions?|note|text|exchange|commands?)\b[^\n.!?]{0,80}(?:only|not|without)|^\s*(?:quote|quotation|historical excerpt|old document|tool output)\s*:)/i;
const analysisLead = /(?:只|仅)(?:做)?(?:分析|概述|讨论|解释|审阅|评析)[^\n。！？]{0,40}(?:引用|历史|文档|日志|网页|下列|下面|这段|说明|以下|示例|样例)/i;
const englishAnalysisLead = line => /\b(?:only|without carrying out|do not (?:execute|carry))\b/i.test(line)&&/\b(?:analy[sz]e|summari[sz]e|discuss|inspect|review)\b/i.test(line)&&/\b(?:following|below|quoted|archived|excerpt|quotation|transcript|sample|example)\b/i.test(line);
const adoption = /^(?:(?:请|现在|本次|本轮|以下|下列|下面|这次|这些|这是|我|的要求|的规则|内容|规则|要求|指令|代码块|围栏|引用|仍|也|作为|[\s:：，,。]){0,40})(?:按[^\n。！？]{0,40}(?:执行|遵守)|采用|采纳|遵守|执行以下|执行下列|执行下面|作为[^\n。！？]{0,20}(?:要求|规则|指令))|\b(?:follow|adopt|apply|execute|use)\b[^\n.!?]{0,60}\b(?:following|below|rules?|instructions?|requirements?|quoted)\b/i;
const endReference = /^\s*(?:(?:以上)?(?:引用|引文|历史引用|摘录)(?:结束|完毕)|(?:end (?:of )?(?:quote|quotation|excerpt|reference|transcript)))[。.!！:：\s-]*$/i;
const referenceTag = /^\s*<(quoted[-_]?text|untrusted[-_]?text|reference|blockquote)>\s*$/i;
const adoptsAbove = text => /^(?:(?:我|请|现在|正式|明确|本次|本轮|并|也|已经|[\s，,])*)(?:把)?(?:上面|以上|上述|前面)[^\n。！？]{0,40}(?:采纳|采用|作为[^\n。！？]{0,20}(?:要求|规则|指令))|^(?:(?:我|请|现在|正式|明确|本次|本轮|并|也|[\s，,])*)(?:采纳|采用)[^\n。！？]{0,30}(?:上面|以上|上述|前面)|^\s*i\s+(?:explicitly\s+)?(?:adopt|apply|use)\s+(?:the\s+)?(?:block|fenced text|quoted text)\s+above\s+as\s+(?:my\s+|the\s+)?(?:current\s+)?(?:instructions|requirements|rules)/i.test(text);
const adoptsPrevious = text => /^(?:(?:我|请|现在|正式|明确|本次|本轮|并|也|[\s，,])*)(?:把)?(?:上一条|上一则)[^\n。！？]{0,40}(?:采纳|采用|作为[^\n。！？]{0,20}(?:要求|规则|指令))|^(?:(?:我|请|现在|正式|明确|本次|本轮|并|也|[\s，,])*)(?:采纳|采用)[^\n。！？]{0,30}(?:上一条|上一则)|^\s*i\s+(?:explicitly\s+)?adopt\s+(?:the\s+)?(?:fenced|quoted)\s+(?:text|block)\s+(?:in|from)\s+(?:my\s+|the\s+)?previous\s+message/i.test(text);

function textRanges(text) {
  const excluded=[];
  const lines=text.match(/[^\n]*\n|[^\n]+$/g)??[];
  const trailing=new Set();
  for(let index=1;index<lines.length;index++)if(/^\s*(?:the (?:preceding|previous) line is (?:a )?(?:quotation|quote|historical excerpt)|上一行(?:只是|是)(?:历史)?引用)/i.test(lines[index]))trailing.add(index-1);
  let tail=false, fence=null, tags=[], adopted=false, quoted=false, offset=0,lastQuote=null;
  const exclude=(start,end)=>{if(end>start)excluded.push({start,end,reference:true});};
  for(const [lineIndex,physical] of lines.entries()) {
    const line=physical.replace(/\r?\n$/,''),end=offset+physical.length;
    const marker=/^\s*(`{3,}|~{3,})/.exec(line);
    if(quoted&&!/^\s*>/.test(line)){quoted=false;tail=false;}
    if(trailing.has(lineIndex)) {
      exclude(offset,end);
    } else if(tags.length) {
      exclude(offset,end);
      const open=referenceTag.exec(line);
      if(open)tags.push(open[1].toLowerCase());
      else if(new RegExp('^\\s*</'+tags.at(-1)+'>\\s*$','i').test(line)) {tags.pop();if(!tags.length)tail=false;}
    } else if(fence) {
      if(fence.reference)exclude(offset,end);
      if(marker && marker[1][0]===fence.character && marker[1].length>=fence.length && /^\s*(?:`+|~+)\s*$/.test(line)) {lastQuote={start:fence.start,end};fence=null;tail=false;adopted=false;}
    } else if(marker) {
      fence={character:marker[1][0],length:marker[1].length,reference:tail,start:offset};
      if(tail)exclude(offset,end);
    } else if(endReference.test(line)) {
      exclude(offset,end);tail=false;adopted=false;
    } else if(tail) {
      const open=referenceTag.exec(line);
      if(open)tags.push(open[1].toLowerCase());
      if(/^\s*>/.test(line))quoted=true;
      exclude(offset,end);
    } else if(referenceTag.test(line)) {
      tags.push(referenceTag.exec(line)[1].toLowerCase());exclude(offset,end);
    } else if(lastQuote&&adoptsAbove(line)) {
      for(let index=excluded.length-1;index>=0;index--)if(excluded[index].start>=lastQuote.start&&excluded[index].end<=lastQuote.end)excluded.splice(index,1);
      adopted=false;lastQuote=null;
    } else if(adoption.test(line) && !/(?:不要|不得|不能|禁止|do not|don't|never)\s*(?:采用|采纳|遵守|执行|follow|adopt|apply|execute)/i.test(line)) {
      adopted=true;
    } else if(referenceLead.test(line) || analysisLead.test(line) || englishAnalysisLead(line)) {
      // A paired inline quotation has a precise end. Its suffix remains a
      // real user instruction; an unbounded pasted excerpt ends only at a
      // structural closing marker, never at a self-claimed "now authorized".
      const colon=/[:：]/.exec(line);
      const quoted=colon && /^\s*([“「『"])([\s\S]*)/.exec(line.slice(colon.index+1));
      const closes={'“':'”','「':'」','『':'』','"':'"'};
      const start=quoted ? line.indexOf(quoted[1],colon.index+1) : -1;
      const close=start>=0 ? line.indexOf(closes[quoted[1]],start+1) : -1;
      if(close>=0)exclude(offset+start,offset+close+1);
      else {
        if(colon && line.slice(colon.index+1).trim())exclude(offset+colon.index+1,end);
        tail=true;adopted=false;
      }
    }
    offset=end;
  }
  const result=[];let cursor=0;
  for(const range of excluded) {
    if(range.start>cursor)result.push({start:cursor,end:range.start,reference:false});
    result.push(range);cursor=range.end;
  }
  if(cursor<text.length)result.push({start:cursor,end:text.length,reference:false});
  return result;
}

export function instructionRanges(message) {
  if(boundaries.has(message))return boundaries.get(message);
  const blocks=blocksOf(message).map(b=>String(b.text??''));
  const ranges=textRanges(blocks.join('\n'));let offset=0;
  const result=blocks.map(text=>{
    const selected=ranges.filter(r=>r.start<offset+text.length && r.end>offset).map(r=>({start:Math.max(0,r.start-offset),end:Math.min(text.length,r.end-offset),reference:r.reference}));
    offset+=text.length+1;return selected;
  });
  boundaries.set(message,result);return result;
}

export function instructionText(message) {
  const blocks=blocksOf(message),ranges=instructionRanges(message);
  return blocks.flatMap((block,index)=>ranges[index].filter(r=>!r.reference).map(r=>String(block.text??'').slice(r.start,r.end))).join('\n');
}

// Exact trusted slices with message-string offsets for reconstruction receipts.
// Keeping the occurrence matters when a quote and a real rule have equal text.
export function instructionSlices(message) {
  const blocks=blocksOf(message),ranges=instructionRanges(message);let offset=0;
  return blocks.flatMap((block,index)=>{
    const text=String(block.text??'');
    const result=ranges[index].filter(r=>!r.reference).map(r=>({text:text.slice(r.start,r.end),start:offset+r.start}));
    offset+=text.length+1;return result;
  });
}

export function referenceTexts(message) {
  const blocks=blocksOf(message),ranges=instructionRanges(message);
  return blocks.flatMap((block,index)=>ranges[index].filter(r=>r.reference).map(r=>String(block.text??'').slice(r.start,r.end))).filter(text=>text.trim());
}

export function copyInstructionBoundaries(original, selected) {
  boundaries.set(selected,instructionRanges(original));return copySourceLayout(original,selected);
}

// A later explicit adoption can activate one quoted block in the immediately
// preceding real-user message. Resolve it again from carried originals on each
// selection; no checkpoint-supplied trust flag or guessed target is accepted.
export function resolveInstructionAdoptions(messages) {
  const resolved=messages.map(message=>copyInstructionBoundaries(message,{...message}));
  let previous;
  for(const message of resolved) {
    if(message.sourceKind!==undefined&&message.sourceKind!=='user')continue;
    if(previous&&adoptsPrevious(instructionText(message))) {
      const ranges=instructionRanges(previous);
      const reference=ranges.flat().filter(r=>r.reference);
      const text=referenceTexts(previous).join('');
      // Multiple independent fenced blocks make "previous block" ambiguous.
      const opens=text.match(/^\s*(?:`{3,}|~{3,})[^\n]*$/gm)??[];
      if(reference.length&&opens.length===2)boundaries.set(previous,ranges.map(block=>block.map(range=>({...range,reference:false}))));
    }
    previous=message;
  }
  return resolved;
}

// Call only with a source layout already verified against immutable originals,
// or with slices constructed by our selector. Never deserialize trust labels.
// Rebase original boundaries rather than reclassifying a filtered projection:
// the explanatory quotation prefix may have been retired in a later generation.
export function projectInstructionBoundaries(selected, original, layout) {
  const source=instructionRanges(original);
  const projected=layout.blocks.map(block=>{
    let offset=0;const ranges=[];
    for(const part of block.parts) {
      if(typeof part.space==='string'){offset+=part.space.length;continue;}
      for(const range of source[part.block]??[]) {
        const start=Math.max(part.start,range.start),end=Math.min(part.end,range.end);
        if(end>start)ranges.push({start:offset+start-part.start,end:offset+end-part.start,reference:range.reference});
      }
      offset+=part.end-part.start;
    }
    return ranges;
  });
  boundaries.set(selected,projected);return selected;
}
