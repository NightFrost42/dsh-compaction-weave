// Persist exact source coordinates, independently of future sentence splitting.
// Legacy projections are accepted only when every non-whitespace character can
// be traced, in order, to the immutable original user event.
import {createHash} from 'node:crypto';
import {sourceEvidenceSentences} from './audit.js';
const digest = value => createHash('sha256').update(value).digest('hex');
const blocksOf = message => message.blocks?.length ? message.blocks : [{type:'text',text:message.text??''}];
const unavailable = () => Object.assign(new Error('Memory source fragments are unavailable.'), {code:'MEMORY_SOURCE_UNAVAILABLE'});
const layouts=new WeakMap();

// Selection already knows which occurrence it removed. Keep that coordinate
// proof through partial projections instead of searching equal strings again.
export function projectSourceLayout(selected, parent, projection) {
  const parentBlocks=blocksOf(parent).map(b=>String(b.text??''));
  const base=layouts.get(parent)??{version:2,originSha256:digest(JSON.stringify(parentBlocks)),blocks:parentBlocks.map((text,block)=>({parts:text?[{block,start:0,end:text.length,sha256:digest(text)}]:[]}))};
  const texts=blocksOf(selected).map(b=>String(b.text??''));
  const blocks=projection.blocks.map((block,index)=>{
    const parts=[];
    for(const slice of block.parts) {
      if(typeof slice.space==='string'){parts.push({space:slice.space});continue;}
      let cursor=0;
      for(const part of base.blocks[slice.block].parts) {
        const length=typeof part.space==='string'?part.space.length:part.end-part.start;
        const start=Math.max(slice.start,cursor),end=Math.min(slice.end,cursor+length);
        if(end>start) {
          if(typeof part.space==='string')parts.push({space:part.space.slice(start-cursor,end-cursor)});
          else {
            const text=parentBlocks[slice.block].slice(start,end);
            parts.push({block:part.block,start:part.start+start-cursor,end:part.start+end-cursor,sha256:digest(text)});
          }
        }
        cursor+=length;
      }
    }
    return {sha256:digest(texts[index]),parts};
  });
  layouts.set(selected,{version:2,originSha256:base.originSha256,blocks});return selected;
}

// Resolve one current policy slice to its immutable original occurrence. A
// discontinuous projection cannot be represented by one sourcePart; reject it
// rather than guessing a matching substring with the same bytes.
export function sourcePartCoordinates(message, {blockIndex,start,end}) {
  const text=String(blocksOf(message)[blockIndex]?.text??'');
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>text.length)throw unavailable();
  const selected={blocks:[{type:'text',text:text.slice(start,end)}]};
  projectSourceLayout(selected,message,{blocks:[{parts:[{block:blockIndex,start,end}]}]});
  const parts=layouts.get(selected).blocks[0].parts;
  if(!parts.length||parts.some(part=>typeof part.space==='string'))throw unavailable();
  let last=parts[0];
  for(const part of parts.slice(1)) {
    if(part.block!==last.block||part.start!==last.end)throw unavailable();
    last=part;
  }
  return {block:parts[0].block,start:parts[0].start,end:last.end};
}

export function sourceLayout(selected, original) {
  const originals=blocksOf(original).map(b=>String(b.text??''));
  const known=layouts.get(selected);
  if(known) {
    if(known.originSha256!==digest(JSON.stringify(originals)))throw unavailable();
    const restored=restoreSourceLayout(original,known);
    if(JSON.stringify(blocksOf(restored))!==JSON.stringify(blocksOf(selected)))throw unavailable();
    return structuredClone(known);
  }
  // A complete identical message has fixed block coordinates even when its
  // text repeats. Partial legacy projections have no such occurrence proof.
  const selectedTexts=blocksOf(selected).map(b=>String(b.text??''));
  if(JSON.stringify(selectedTexts)===JSON.stringify(originals))return {
    version:2,originSha256:digest(JSON.stringify(originals)),
    blocks:originals.map((text,block)=>({sha256:digest(text),parts:text?[{block,start:0,end:text.length,sha256:digest(text)}]:[]})),
  };
  let sourceBlock=0,sourceOffset=0;
  const locate = text => {
    let found;
    for(let index=sourceBlock;index<originals.length;index++){
      const start=originals[index].indexOf(text,index===sourceBlock?sourceOffset:0);
      if(start<0)continue;
      // Choosing the first equal string can turn a surviving historical quote
      // into a cancelled real instruction. Without exact persisted offsets,
      // refuse ambiguity rather than infer a trust boundary from equal bytes.
      if(found||originals[index].indexOf(text,start+1)>=0)throw unavailable();
      found={block:index,start,end:start+text.length,sha256:digest(text)};
    }
    if(!found)throw unavailable();
    sourceBlock=found.block;sourceOffset=found.end;return found;
  };
  const blocks=blocksOf(selected).map(block=>{
    const text=String(block.text??'');
    // Whole literal/code blocks remain whole whenever possible.
    const before=[sourceBlock,sourceOffset];
    try{return {sha256:digest(text),parts:text?[locate(text)]:[]};}
    catch{[sourceBlock,sourceOffset]=before;}
    const parts=[];let cursor=0;
    for(const piece of sourceEvidenceSentences(text)){
      const at=text.indexOf(piece,cursor);
      if(at<cursor)throw unavailable();
      const space=text.slice(cursor,at);
      if(space){if(!/^\s*$/.test(space))throw unavailable();parts.push({space});}
      parts.push(locate(piece));cursor=at+piece.length;
    }
    const space=text.slice(cursor);
    if(space){if(!/^\s*$/.test(space))throw unavailable();parts.push({space});}
    return {sha256:digest(text),parts};
  });
  return {version:2,originSha256:digest(JSON.stringify(originals)),blocks};
}

export function restoreSourceLayout(original, layout) {
  const originals=blocksOf(original).map(b=>String(b.text??''));
  if(layout?.version!==2||layout.originSha256!==digest(JSON.stringify(originals))||!Array.isArray(layout.blocks))throw unavailable();
  let lastBlock=0,lastEnd=0;
  const blocks=layout.blocks.map(block=>{
    if(!Array.isArray(block.parts))throw unavailable();
    const text=block.parts.map(part=>{
      if(typeof part.space==='string'){
        if(!/^\s*$/.test(part.space))throw unavailable();
        return part.space;
      }
      const {block:index,start,end,sha256}=part;
      if(!Number.isSafeInteger(index)||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||index<lastBlock||start<0||end<=start||index===lastBlock&&start<lastEnd||typeof originals[index]!=='string'||end>originals[index].length)throw unavailable();
      const piece=originals[index].slice(start,end);
      if(digest(piece)!==sha256)throw unavailable();
      lastBlock=index;lastEnd=end;return piece;
    }).join('');
    if(digest(text)!==block.sha256)throw unavailable();
    return {type:'text',text};
  });
  if(!blocks.length)return null;
  const restored={...original,blocks,text:blocks.map(b=>b.text).join('\n')};
  layouts.set(restored,structuredClone(layout));return restored;
}

export function copySourceLayout(original, selected) {
  if(layouts.has(original))layouts.set(selected,layouts.get(original));return selected;
}
