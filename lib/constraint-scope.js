import {auditCompaction} from './audit.js';
import {isExternalFoldEvent,isReferenceContextKind,sourceKindOf} from './source-provenance.js';
import {isSystemReminderOnly} from './instruction-source.js';
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
    const externalFold=isExternalFoldEvent(event,session);
    const knownRef=event.type==='tool/result'||externalFold||isReferenceContextKind(sourceKindOf(session,seq));
    let message;
    let reminderOnly=false;
    if(!knownRef&&event.type==='user/message'){
      message=typeof session.deriveEventMessage==='function'?session.deriveEventMessage(event):event.data;
      reminderOnly=isSystemReminderOnly(message??event.data);
    }
    if(knownRef||reminderOnly) {
      message??=typeof session.deriveEventMessage==='function'?session.deriveEventMessage(event):event.data;
      const text=typeof message?.content==='string'?message.content:blocksToText(message?.content);
      if(text)references.push({seq,text});
    }
    // External fold events are self-contained untrusted historical summaries;
    // do not traverse their foreign sourceEventSeqs edges.
    if(externalFold)continue;
    // Edges are durable host-event metadata, not a generated notes field.
    // Follow only earlier events so malformed cycles cannot enlarge traversal.
    const parents=[...event.sourceEventSeqs??[],...(event.type==='compaction/summary'?event.data?.shadowedSeqs??[]:[])];
    for(let index=parents.length-1;index>=0;index--)if(Number.isSafeInteger(parents[index])&&parents[index]<seq)pending.push(parents[index]);
  }
  return references;
}

// Requirements outside the replacement span stay visible in their original
// messages. They need no duplicate quote in the new checkpoint, but generated
// notes must still respect their polarity, values, conditions and object scope.
export function auditMemorySelection({selection,...options}) {
  const isIgnored=(message)=>Boolean(message?.externalFold)||isSystemReminderOnly(message);
  const active=(selection.active??[]).filter(message=>!isIgnored(message));
  const retained=(selection.retained??[]).filter(message=>!isIgnored(message));
  const excluded=[...(selection.active??[]),...(selection.retained??[])].filter(isIgnored);
  const local=new Set(active.map(message=>message.seq));
  const userMessages=[...active,...retained].sort((a,b)=>a.seq-b.seq);
  const referenceMessages=[
    ...(options.referenceMessages??[]),
    ...excluded.map(message=>({seq:message.seq,text:message.text??''})).filter(item=>item.text),
  ];
  const report=auditCompaction({...options,userMessages,referenceMessages});
  return {...report,lost:report.lost.filter(item=>item.reason!=='coverage'||local.has(item.seq))};
}
