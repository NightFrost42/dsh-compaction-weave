// A spent budget pauses automatic work; a new explicit manual command may
// renew it without discarding accepted pages or the lifetime usage ledger.
const fail = (code, message) => Object.assign(new Error(message), {code});
export function continuationCallBudget(state, extra, {manualRetry = false, requestId} = {}) {
  const grants = state.budgetGrants ?? [];
  const invalid = () => fail('CONTINUATION_PROGRESS_INVALID', 'Invalid saved continuation budget grants; original context and receipts retained.');
  if (!Array.isArray(grants)) throw invalid();
  let previousCalls = -1, previousNext = 0;
  const ids = new Set();
  for (const grant of grants) {
    if (!grant || !Number.isSafeInteger(grant.calls) || grant.calls <= previousCalls || grant.calls > state.calls.length ||
        !Number.isSafeInteger(grant.next) || grant.next < previousNext || grant.next > state.next || grant.next > grant.calls ||
        typeof grant.requestId !== 'string' || !grant.requestId || ids.has(grant.requestId)) throw invalid();
    previousCalls = grant.calls; previousNext = grant.next; ids.add(grant.requestId);
  }
  const used = () => {
    const base = grants.at(-1) ?? {calls:0,next:0};
    return {calls:state.calls.length-base.calls, accepted:state.next-base.next, limit:state.segments.length-base.next+extra};
  };
  const exhausted = () => { const u=used(); return u.calls>=u.limit || u.calls-u.accepted>extra; };
  let renewed = false;
  // One grant at entry, never from an automatic trigger or inside a retry loop.
  if (state.next < state.segments.length && exhausted() && manualRetry === true && typeof requestId === 'string' && requestId && !ids.has(requestId)) {
    grants.push({calls:state.calls.length,next:state.next,requestId,at:new Date().toISOString()});
    state.budgetGrants = grants; renewed = true;
  }
  return {renewed, assertAvailable() {
    if (!exhausted()) return;
    const message = `Continuation call budget exhausted; acceptedPages=${state.next}, totalPages=${state.segments.length}, requests=${state.calls.length}, extraCalls=${extra}. Accepted pages and usage are saved. A new manual /compact or /context-continue renews a bounded budget and resumes the first unfinished page.`;
    throw Object.assign(fail('CONTINUATION_CALL_BUDGET',message),{continuationProgress:{acceptedPages:state.next,totalPages:state.segments.length,requests:state.calls.length,extraCalls:extra}});
  }};
}

export function continuationBudgetInfo(error) {
  const seen = new Set();
  for(let e=error,n=0;e&&n<8&&!seen.has(e);e=e.cause,n++) {
    seen.add(e);
    if(e.code==='CONTINUATION_CALL_BUDGET') {
      const values={};
      for(const key of ['acceptedPages','totalPages','requests','extraCalls','requestsThisAttempt','acceptedPagesThisAttempt']) {
        const parsed=new RegExp(`\\b${key}=(\\d+)`).exec(e.message??'');
        const value=e.continuationProgress?.[key]??(parsed?Number(parsed[1]):undefined);
        if(Number.isSafeInteger(value)&&value>=0)values[key]=value;
      }
      return values;
    }
    if(e.code==='SUMMARY_ALL_FAILED' && e.failures?.length && e.failures.every(f=>f.code==='CONTINUATION_CALL_BUDGET'))return continuationBudgetInfo(e.failures[0]);
  }
  return null;
}
export function continuationBudgetText(error) {
  const info=continuationBudgetInfo(error);if(!info)return null;
  const pages=Number.isSafeInteger(info.acceptedPages)&&Number.isSafeInteger(info.totalPages)?`已保存 ${info.acceptedPages}/${info.totalPages} 页，`:'';
  const calls=Number.isSafeInteger(info.requests)?`累计调用 ${info.requests} 次。`:'';
  const attempt=Number.isSafeInteger(info.requestsThisAttempt)&&Number.isSafeInteger(info.acceptedPagesThisAttempt)?`本次新调用 ${info.requestsThisAttempt} 次，接受 ${info.acceptedPagesThisAttempt} 页。`:'';
  return `接续调用预算已耗尽，${pages}${calls}${attempt}原上下文和已接受页面均保留。自动处理已暂停；手动执行 /compact 或 /context-continue 可授予一份新的有限额度，从未完成页继续，可能产生新的摘要费用。`;
}
export function budgetForCommand(session,commandId) {
  if(!commandId||typeof session?.eventAt!=='function'||!Number.isSafeInteger(session.seq))return null;
  for(let seq=session.seq-1;seq>=0;seq--) {
    const e=session.eventAt(seq);
    if(e?.type==='compaction/end'&&e.data?.sourceCommandId===commandId) {
      const text=e.data.error;
      return typeof text==='string'&&text.startsWith('CONTINUATION_CALL_BUDGET:')?{code:'CONTINUATION_CALL_BUDGET',message:text}:null;
    }
    if(e?.type==='command/run'&&e.data?.commandId===commandId)break;
  }
  return null;
}
