import {auditCompaction} from './audit.js';
import {isExternalFoldEvent,isReferenceContextKind,sourceKindOf} from './source-provenance.js';
import {isReferencePrefixOnly,isSystemReminderOnly} from './instruction-source.js';
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
    const kind=sourceKindOf(session,seq);
    const knownRef=event.type==='tool/result'||externalFold||isReferenceContextKind(kind);
    let message;
    let reminderOrPrefixOnly=false;
    if(!knownRef&&event.type==='user/message'&&kind!=='compact-checkpoint'){
      message=typeof session.deriveEventMessage==='function'?session.deriveEventMessage(event):event.data;
      reminderOrPrefixOnly=isSystemReminderOnly(message??event.data)||isReferencePrefixOnly(message??event.data);
    }
    if(knownRef||reminderOrPrefixOnly) {
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
export function auditMemorySelection({selection,coverageScope='all',...options}) {
  const isIgnored=(message)=>Boolean(message?.externalFold)||isSystemReminderOnly(message)||isReferencePrefixOnly(message);
  const active=(selection.active??[]).filter(message=>!isIgnored(message));
  const retained=(selection.retained??[]).filter(message=>!isIgnored(message));
  const excluded=[...(selection.active??[]),...(selection.retained??[])].filter(isIgnored);
  const local=new Set(active.map(message=>message.seq));
  const userMessages=[...active,...retained].sort((a,b)=>a.seq-b.seq);
  const referenceMessages=[
    ...(options.referenceMessages??[]),
    ...excluded.map(message=>({seq:message.seq,text:message.text??''})).filter(item=>item.text),
  ];
  const provenanceUserMessages = Array.isArray(selection?.provenanceUserMessages) ? selection.provenanceUserMessages : undefined;
  const report=auditCompaction({...options,userMessages,provenanceUserMessages,referenceMessages});
  const normalizedScope=coverageScope==='recent'||coverageScope==='span-new'||coverageScope==='all'?coverageScope:'all';
  const enforcedCoverageSeqs=normalizedScope==='recent'
    ?(selection.recentWindowSeqs instanceof Set?selection.recentWindowSeqs:local)
    :normalizedScope==='span-new'
      ?(selection.directSpanSeqs instanceof Set?selection.directSpanSeqs:local)
      :local;
  const lost=[];
  const softCoverageLost=[];
  for(const item of report.lost){
    if(item.reason!=='coverage'){
      lost.push(item);
      continue;
    }
    if(!local.has(item.seq))continue;
    if(enforcedCoverageSeqs.has(item.seq))lost.push(item);
    else softCoverageLost.push(item);
  }
  return {
    ...report,
    lost,
    softCoverageLost,
    softCoverageCount:softCoverageLost.length,
    coverageScope:normalizedScope,
  };
}
