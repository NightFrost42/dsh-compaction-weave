import {auditCompaction} from './audit.js';
import {isReferenceContextKind,sourceKindOf} from './source-provenance.js';
import {blocksToText} from './meter.js';

// Tool evidence is useful for facts, never proof of a new user permission.
// Read immutable event identities directly; a generated checkpoint's claimed
// source seq/kind cannot upgrade its text to an authoritative user instruction.
export function collectReferenceMessages(session, seqs) {
  const seen=new Set(),references=[],pending=[...seqs].reverse();
  while(pending.length) {
    const seq=pending.pop();
    if(!Number.isSafeInteger(seq)||seen.has(seq))continue;
    seen.add(seq);
    const event=session.eventAt(seq);
    if(!event)continue;
    if(event.type==='tool/result'||isReferenceContextKind(sourceKindOf(session,seq))) {
      const message=session.deriveEventMessage(event);
      const text=typeof message?.content==='string'?message.content:blocksToText(message?.content);
      if(text)references.push({seq,text});
    }
    // Edges are durable host-event metadata, not a generated notes field.
    // Follow only earlier events so malformed cycles cannot enlarge traversal.
    const parents=[...event.sourceEventSeqs??[],...(event.type==='compaction/summary'?event.data?.shadowedSeqs??[]:[])];
    for(let index=parents.length-1;index>=0;index--)if(parents[index]<seq)pending.push(parents[index]);
  }
  return references;
}

// Requirements outside the replacement span stay visible in their original
// messages. They need no duplicate quote in the new checkpoint, but generated
// notes must still respect their polarity, values, conditions and object scope.
export function auditMemorySelection({selection,...options}) {
  const local=new Set(selection.active.map(message=>message.seq));
  const userMessages=[...selection.active,...selection.retained??[]].sort((a,b)=>a.seq-b.seq);
  const report=auditCompaction({...options,userMessages});
  return {...report,lost:report.lost.filter(item=>item.reason!=='coverage'||local.has(item.seq))};
}
