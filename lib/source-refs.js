// Persist exact source coordinates, independently of future sentence splitting.
// Legacy projections are accepted only when every non-whitespace character can
// be traced, in order, to the immutable original user event.
import {createHash} from 'node:crypto';
import {sourceEvidenceSentences} from './audit.js';
const digest = value => createHash('sha256').update(value).digest('hex');
const blocksOf = message => message.blocks?.length ? message.blocks : [{type:'text',text:message.text??''}];
const unavailable = () => Object.assign(new Error('Memory source fragments are unavailable.'), {code:'MEMORY_SOURCE_UNAVAILABLE'});

export function sourceLayout(selected, original) {
  const originals=blocksOf(original).map(b=>String(b.text??''));
  let sourceBlock=0,sourceOffset=0;
  const locate = text => {
    for(let index=sourceBlock;index<originals.length;index++){
      const start=originals[index].indexOf(text,index===sourceBlock?sourceOffset:0);
      if(start<0)continue;
      sourceBlock=index;sourceOffset=start+text.length;
      return {block:index,start,end:sourceOffset,sha256:digest(text)};
    }
    throw unavailable();
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
  return blocks.length?{...original,blocks,text:blocks.map(b=>b.text).join('\n')}:null;
}
