import {collectInstructionMessages,inspectCompactionEntryState} from './region.js';
import {memorySourceRefs} from './memory-policy.js';
// A one-time migration for the proven legacy source-reference incompatibility.
// Network, audit, archive, partial-commit and unknown failures stay stopped.
export function sourceBreakerRecoverable(session, state) {
  if(!state?.stopped||!state.failures||state.sourceFragmentRecovery?.version===2||!Number.isSafeInteger(session?.seq)||typeof session.eventAt!=='function')return false;
  try {
    if(inspectCompactionEntryState(session).unmatchedCompactionStart!==null)return false;
    let matching=0;
    for(let seq=session.seq-1;seq>=0&&matching<state.failures;seq--){
      const event=session.eventAt(seq);
      if(event?.type!=='compaction/end')continue;
      if(event.data?.error!=='Memory source fragments are unavailable.')return false;
      matching++;
    }
    if(matching!==state.failures)return false;
    const sources=collectInstructionMessages(session,session.surface?.nodes);
    if(!sources.length)return false;
    memorySourceRefs(sources,session); // Prove every source can be emitted and restored.
    return true;
  }catch{return false;}
}
