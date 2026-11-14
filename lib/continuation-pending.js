// One frozen continuation range per logical session. Appended tail messages do
// not change the identity or reset paid-page receipts and retry-call budgets.
import {createHash,randomUUID} from 'node:crypto';
const fail=(code,message)=>Object.assign(new Error(message),{code});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function readPendingContinuation(store,session) {
  const pending=store.read(session.id).continuationPending;
  if(pending===undefined)return null;
  if(pending.version!==1||typeof pending.id!=='string'||!pending.id||!Array.isArray(pending.seqs)||!pending.seqs.length||pending.seqs.some(seq=>!Number.isSafeInteger(seq)||seq<0)||new Set(pending.seqs).size!==pending.seqs.length||!/^[a-f0-9]{64}$/.test(pending.sourceSha256)||(pending.budgetTokens!==undefined&&(!Number.isFinite(pending.budgetTokens)||pending.budgetTokens<=0))||pending.progressKey!==undefined&&!/^[a-f0-9]{64}$/.test(pending.progressKey))throw fail('CONTINUATION_PENDING_INVALID','Saved continuation range is invalid; original context and progress retained.');
  return pending;
}
function sourceHash(session,seqs){return hash(seqs.map(seq=>[seq,session.deriveEventMessage(session.eventAt(seq))]));}
export function assertPendingSource(session,pending) {
  const nodes=session.surface.nodes,start=nodes.indexOf(pending.seqs[0]);
  if(start<0||pending.seqs.some((seq,i)=>nodes[start+i]!==seq)||sourceHash(session,pending.seqs)!==pending.sourceSha256)throw fail('CONTINUATION_PENDING_SOURCE_CHANGED','Saved continuation source changed; refusing to restart paid pages or overwrite another range. Original history and receipts retained.');
}
export function freezeContinuation(store,session,seqs,budgetTokens) {
  let pending=readPendingContinuation(store,session);
  if(pending){assertPendingSource(session,pending);if(JSON.stringify(pending.seqs)!==JSON.stringify(seqs))throw fail('CONTINUATION_PENDING_RANGE','Finish the saved continuation range before compacting another range.');return pending;}
  pending={version:1,id:randomUUID(),seqs:[...seqs],sourceSha256:sourceHash(session,seqs),...(budgetTokens?{budgetTokens}:{})};
  store.update(session.id,state=>{if(state.continuationPending)throw fail('CONTINUATION_PENDING_CHANGED','Another continuation was started; retry without overwriting its progress.');return {...state,continuationPending:pending};});
  return pending;
}
export function bindContinuationProgress(store,session,id,progressKey,{manualRetry=false,requestId}={}) {
  const updated=store.update(session.id,state=>{
    const pending=state.continuationPending;
    if(pending?.id!==id)throw fail('CONTINUATION_PENDING_CHANGED','Continuation identity changed; no provider request sent.');
    const history=pending.progressHistory??[],restarts=pending.policyRestarts??[];
    if(!Array.isArray(history)||history.some(k=>typeof k!=='string'||!/^[a-f0-9]{64}$/.test(k))||!Array.isArray(restarts)||restarts.some(k=>typeof k!=='string'))throw fail('CONTINUATION_PENDING_INVALID','Invalid retained continuation policy history.');
    if(pending.progressKey&&pending.progressKey!==progressKey){
      if(!manualRetry||!requestId||restarts.includes(requestId))throw fail('CONTINUATION_PENDING_POLICY_CHANGED','Memory rules, newer instructions or summary settings changed. Old accepted pages cannot be used under this policy. They and their usage remain saved. Use a new manual /compact to regenerate under the current policy with a bounded budget; this may incur new summary fees.');
      return {...state,continuationPending:{...pending,progressKey,progressHistory:[...new Set([...history,pending.progressKey])],policyRestarts:[...restarts,requestId]}};
    }
    return {...state,continuationPending:{...pending,progressKey}};
  });
  return {priorProgressKeys:(updated.continuationPending.progressHistory??[]).filter(key=>key!==progressKey)};
}
// Called only after transaction recovery/commit establishes durable success.
export function settleContinuation(store,session) {
  const pending=readPendingContinuation(store,session);if(!pending)return false;
  const committed=session.surface.nodes.some(seq=>{
    const source=session.deriveEventMessage(session.eventAt(seq))?.source;
    return source?.kind==='compact-checkpoint'&&source.continuation?.pendingId===pending.id&&source.continuation?.pendingSourceSha256===pending.sourceSha256;
  });
  if(!committed)return false;
  store.update(session.id,state=>{if(state.continuationPending?.id!==pending.id)throw fail('CONTINUATION_PENDING_CHANGED','Continuation identity changed during commit cleanup.');const next={...state};delete next.continuationPending;return next;});
  return true;
}

export function releaseUnstartedContinuation(store,session,id) {
  const pending=readPendingContinuation(store,session);
  if(pending?.id!==id||pending.progressKey)return;
  store.update(session.id,state=>{
    if(state.continuationPending?.id!==id||state.continuationPending.progressKey)return state;
    const next={...state};delete next.continuationPending;return next;
  });
}
