// Request-only projections. Durable events and verified archives keep every byte.
// Only recognized reads with explicit retrieval coordinates omit their bodies.
import {sourceKindOf} from './source-provenance.js';
import {summaryProse} from './validate.js';
const READ_KEYS={skill:['name'],read:['file_path'],read_file:['path'],ops_read_files:['files'],memory_get:['id'],read_page:['url']};
export function projectSummaryMessage(session,event,message) {
  if(!message)return message;
  const seq=event.seq,kind=sourceKindOf(session,seq);
  const replace=text=>({...message,content:[{type:'text',text}]});
  if(['runtime-context','session-reference','skill-catalog','time-context','msg-state'].includes(kind)){
    const source=event.data.source;
    const names=kind==='skill-catalog'?(source.entries??[]).map(e=>e.name).filter(Boolean):undefined;
    return replace(`[External ${kind} reference at source seq ${seq}; original archived. Reload the current host context or use history_read for the historical version.${names?.length?' Skills: '+names.join(', ')+'. Load a named skill when needed.':''}]`);
  }
  if(kind==='compact-checkpoint'&&Array.isArray(event.data?.source?.preserved)&&!event.data.source.continuation){
    const blocks=message.content;
    const close=Array.isArray(blocks)?blocks.findIndex(b=>b.type==='text'&&b.text==='</compacted-summary>'):-1;
    if(close>0&&blocks[0]?.text?.endsWith('<compacted-summary>')){
      const text=blocks.slice(1,close).filter(b=>b.type==='text').map(b=>b.text).join('\n');
      return replace('[Prior checkpoint. Original requests are selected independently from structured sources.]\n'+summaryProse(text));
    }
  }
  if(event.type!=='tool/result'||message.isError)return message;
  const callId=message.toolCallId??message.source?.callId;
  const call=(event.sourceEventSeqs??[]).map(n=>session.eventAt(n)).find(e=>e?.type==='tool/call'&&e.data?.callId===callId);
  if(!call||!READ_KEYS[call.data.name])return message;
  let args;try{args=typeof call.data.arguments==='string'?JSON.parse(call.data.arguments):call.data.arguments;}catch{return message;}
  const keys=READ_KEYS[call.data.name];if(!args||!keys.every(k=>args[k]!==undefined))return message;
  const locatorKeys=[...new Set([...keys,...(['read','read_file'].includes(call.data.name)?['offset','limit','startLine','endLine']:[])])];
  const locator=Object.fromEntries(locatorKeys.filter(k=>args[k]!==undefined).map(k=>[k,args[k]]));
  return replace(`[External content omitted from working memory. Reload with ${call.data.name} ${JSON.stringify(locator)}. Source seq ${seq} is archived for exact historical bytes; current external content may have changed.]`);
}
