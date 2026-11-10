import {collectWorkReport, renderWorkReport} from './work-report.js';
// Keep committed working notes byte-for-byte and compact only subsequent old
// work, provided it can free enough space. Real capacity and revised requirements
// always take priority over cache reuse. No provider cache hit is assumed here.
import {selectCompactableRange,toolPairingBalancedBefore,collectInstructionMessages,selectSessionMemory} from './region.js';
import {approxTokens,blocksToText} from './meter.js';
import {planContinuationMemory,residentConstraints} from './continuation.js';

export function selectCachePreservingRange(session, measurement, retainTokens, policy, targetTokens, {continuation=false} = {}) {
  if(policy.cachePreservePrefix===false)return null;
  const nodes=session.surface?.nodes??[];
  const checkpoints=nodes.map((seq,index)=>({seq,index,event:session.eventAt(seq)})).filter(n=>n.event?.data?.source?.kind==='compact-checkpoint');
  if(!checkpoints.length||checkpoints.length>=(policy.cacheMaxCheckpoints??4))return null;
  const base=selectCompactableRange(session,measurement,retainTokens);
  if(!base)return null;
  const firstIndex=checkpoints.at(-1).index+1;
  const endIndex=nodes.indexOf(base.end);
  if(firstIndex>endIndex||!toolPairingBalancedBefore(session,nodes[firstIndex]))return null;
  const cost=new Map(measurement.pricedBySeq??[]);
  for(const item of measurement.nodes??[])if(typeof item==='object'&&Number.isFinite(item.tokens??item.heuristicTokens))cost.set(item.seq,item.tokens??item.heuristicTokens);
  const tokens=seq=>cost.get(seq)??approxTokens(blocksToText(session.deriveEventMessage(session.eventAt(seq))?.content));
  const latestReport=collectWorkReport(session,nodes.slice(firstIndex,endIndex+1));
  // This interval follows the LAST checkpoint, so any report is a direct
  // assistant event. It costs nothing when it remains in the untouched prefix.
  const reportIndex=latestReport?nodes.indexOf(latestReport.seq,firstIndex):-1;
  const reportTokens=latestReport?approxTokens(renderWorkReport(latestReport)):0;
  const baseCheckpoint=(policy.maxTokens??8192)+(policy.preserveRecentUserTokens??4096);
  const savingNeeded=Math.max(policy.cacheMinSavingsTokens??4096,Number.isFinite(targetTokens)?measurement.totalTokens-targetTokens:measurement.totalTokens*(policy.minimumReductionRatio??0.2));
  let selection;
  const globalSelection=()=>selection??=(selectSessionMemory(session,nodes,{maxMessages:Infinity,maxTokens:Infinity}));
  const requirements=continuation?new Map(residentConstraints(globalSelection().active,session).map(m=>[m.seq,m])):null;
  const included=[];
  let available=0,footprint=null,footprintDirty=true,latestAllowed=endIndex,conflictsChecked=false;
  for(let index=endIndex;index>=firstIndex;index--){
    available+=tokens(nodes[index]);
    if(requirements?.has(nodes[index])){included.push(requirements.get(nodes[index]));footprintDirty=true;}
    if(index===reportIndex)footprintDirty=true;
    const report=index<=reportIndex?latestReport:null;
    let expectedCheckpoint=baseCheckpoint+(report?reportTokens:0);
    if(index>latestAllowed||available-expectedCheckpoint<savingNeeded||!toolPairingBalancedBefore(session,nodes[index]))continue;
    if(continuation){
      try{
        if(footprintDirty){footprint=planContinuationMemory([...included].reverse(),policy,{workReport:report});footprintDirty=false;}
        expectedCheckpoint=Math.max(expectedCheckpoint,footprint.reservedTokens);
      }catch(error){
        // Earlier starts only add active source requirements (and possibly the
        // latest report), so an already oversized envelope cannot shrink again.
        if(error.code==='CONTINUATION_REQUIREMENTS_TOO_LARGE')return null;
        throw error;
      }
      if(available-expectedCheckpoint<savingNeeded)continue;
    }
    if(!conflictsChecked){
      const prefixSources=new Set(collectInstructionMessages(session,nodes.slice(0,index)).map(m=>m.seq));
      const retired=globalSelection().decisions.filter(d=>['cancelled','superseded'].includes(d.reason)&&prefixSources.has(d.seq));
      const positions=new Map(nodes.map((seq,position)=>[seq,position]));
      for(const decision of retired){
        const position=positions.get(decision.seq);
        // A retired source carried by an older checkpoint requires a merge.
        if(position===undefined||position<firstIndex)return null;
        latestAllowed=Math.min(latestAllowed,position);
      }
      conflictsChecked=true;
      // A revision within new work only needs to include its old source; the
      // stable checkpoint can stay. Shrinking the prefix adds no new conflict.
      if(index>latestAllowed)continue;
    }
    return {start:nodes[index],end:base.end};
  }
  return null;
}
