// A spent budget pauses automatic work; a new explicit manual command may
// renew it without discarding accepted pages or the lifetime usage ledger.
const fail = (code, message) => Object.assign(new Error(message), {code});
const invalidProgress = () => fail('CONTINUATION_PROGRESS_INVALID', 'Invalid saved continuation budget grants; original context and receipts retained.');

function validateGrantsList(state, grants, receiptList, hasBufferedMap, bufferedReceipts, initialAcceptedTotal) {
  let previousCalls = -1;
  let previousNext = 0;
  let previousAccepted = 0;
  const ids = new Set();
  for (const grant of grants) {
    if (!grant || (grant.version !== undefined && grant.version !== 2)) throw invalidProgress();
    if (!Number.isSafeInteger(grant.calls) || grant.calls <= previousCalls || grant.calls > state.calls.length ||
        !Number.isSafeInteger(grant.next) || grant.next < previousNext || grant.next > state.next || grant.next > grant.calls ||
        typeof grant.requestId !== 'string' || !grant.requestId || ids.has(grant.requestId)) throw invalidProgress();
    if (grant.version === 2 && !Number.isSafeInteger(grant.accepted)) throw invalidProgress();
    let preGrantBufferedCount = 0;
    const checkReceiptPreGrant = (r) =>
      Boolean(r && Number.isSafeInteger(r.callCount) && r.callCount <= grant.calls);
    for (let idx = grant.next; idx < receiptList.length; idx += 1) {
      if (checkReceiptPreGrant(receiptList[idx])) preGrantBufferedCount += 1;
    }
    for (const r of bufferedReceipts) {
      if (checkReceiptPreGrant(r)) preGrantBufferedCount += 1;
    }
    if (grant.accepted === undefined && preGrantBufferedCount > 0) throw invalidProgress();
    const grantAccepted = grant.accepted === undefined ? grant.next : grant.accepted;
    if (!Number.isSafeInteger(grantAccepted) || grantAccepted < grant.next + preGrantBufferedCount ||
        grantAccepted < previousAccepted || grantAccepted > initialAcceptedTotal || grantAccepted > grant.calls) throw invalidProgress();
    previousCalls = grant.calls;
    previousNext = grant.next;
    previousAccepted = grantAccepted;
    ids.add(grant.requestId);
  }
  return ids;
}

/**
 * Migrate genuine v1 continuation checkpoints (missing `ledgerVersion` and `callCount`s)
 * to `ledgerVersion: 2` by reconstructing 1-to-1 `receipt.callCount` links using the final
 * completed attempt within each page's historical acceptance interval.
 * Fails closed without mutating `state` if any invariant fails.
 */
export function migrateLegacyReceiptCallCounts(state) {
  const grants = state?.budgetGrants ?? [];
  if (
    !state ||
    !Array.isArray(state.calls) ||
    !Array.isArray(state.segments) ||
    !Number.isSafeInteger(state.next) ||
    state.next < 0 ||
    !Array.isArray(grants)
  ) {
    throw invalidProgress();
  }
  if (state.ledgerVersion !== undefined && state.ledgerVersion !== 2) {
    throw invalidProgress();
  }
  if (state.ledgerVersion === 2) return false;
  if (!Array.isArray(state.receipts)) return false;

  const hasBufferedMap =
    state.completedMapPages && typeof state.completedMapPages === 'object' && !Array.isArray(state.completedMapPages);
  const hasV2Grant = grants.some((g) => g && (g.version !== undefined || g.accepted !== undefined));
  const hasAnyCallCount = state.receipts.some((r) => r && r.callCount !== undefined);
  if (hasBufferedMap || hasV2Grant || hasAnyCallCount) {
    return false;
  }

  validateGrantsList(state, grants, state.receipts, false, [], state.next);
  if (state.receipts.length !== state.next) throw invalidProgress();

  const isMapReduce = state.mode === 'map-reduce';
  const assigned = new Array(state.receipts.length);
  const usedCallIdx = new Set();
  let prevAssignedCallIdx = -1;

  for (let idx = 0; idx < state.receipts.length; idx += 1) {
    const r = state.receipts[idx];
    if (!r || typeof r !== 'object') throw invalidProgress();
    let lowerCalls = 0;
    for (const g of grants) {
      if (g.next <= idx) lowerCalls = g.calls;
    }
    let upperCalls = state.calls.length;
    for (const g of grants) {
      if (g.next > idx) {
        upperCalls = g.calls;
        break;
      }
    }
    const minCi = isMapReduce ? lowerCalls : Math.max(lowerCalls, prevAssignedCallIdx + 1);
    if (minCi >= upperCalls) throw invalidProgress();

    let matchIdx = -1;
    if (isMapReduce) {
      for (let ci = upperCalls - 1; ci >= minCi; ci -= 1) {
        const c = state.calls[ci];
        if (!usedCallIdx.has(ci) && c && c.phase === 'map' && c.page === idx && c.completed === true) {
          matchIdx = ci;
          break;
        }
      }
    } else {
      for (let ci = upperCalls - 1; ci >= minCi; ci -= 1) {
        const c = state.calls[ci];
        if (!usedCallIdx.has(ci) && c && c.page === idx && c.completed === true) {
          matchIdx = ci;
          break;
        }
      }
      if (matchIdx < 0) {
        for (let ci = upperCalls - 1; ci >= minCi; ci -= 1) {
          const c = state.calls[ci];
          if (!usedCallIdx.has(ci) && c && c.page === idx && c.completed !== false && !c.errorCode) {
            matchIdx = ci;
            break;
          }
        }
      }
    }
    if (matchIdx < 0) throw invalidProgress();
    usedCallIdx.add(matchIdx);
    assigned[idx] = matchIdx + 1;
    prevAssignedCallIdx = matchIdx;
  }

  for (let idx = 0; idx < state.receipts.length; idx += 1) {
    const callCount = assigned[idx];
    state.receipts[idx].callCount = callCount;
    const call = state.calls[callCount - 1];
    if (call && call.completed === undefined) call.completed = true;
  }
  state.ledgerVersion = 2;
  return true;
}

export function continuationCallBudget(state, extra, {manualRetry = false, requestId, inFlightCount} = {}) {
  const grants = state.budgetGrants ?? [];
  const invalid = invalidProgress;
  if (!state || !Array.isArray(state.calls) || !Array.isArray(state.segments) || !Number.isSafeInteger(state.next) || state.next < 0 || !Array.isArray(grants)) {
    throw invalid();
  }
  if (state.ledgerVersion !== undefined && state.ledgerVersion !== 2) {
    throw invalid();
  }
  const completedOutOfOrder = () =>
    state.completedMapPages && typeof state.completedMapPages === 'object' && !Array.isArray(state.completedMapPages)
      ? Object.keys(state.completedMapPages).length
      : 0;
  const acceptedTotal = () => state.next + completedOutOfOrder();
  const initialAcceptedTotal = acceptedTotal();
  if (state.calls.length < initialAcceptedTotal) throw invalid();
  const activeInFlight = () => {
    const n = typeof inFlightCount === 'function' ? inFlightCount() : 0;
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  };
  const hasBufferedMap =
    state.completedMapPages && typeof state.completedMapPages === 'object' && !Array.isArray(state.completedMapPages);
  const receiptList = Array.isArray(state.receipts) ? state.receipts : [];
  const bufferedReceipts = hasBufferedMap ? Object.values(state.completedMapPages).map((e) => e?.receipt) : [];
  const validateStrictReceipts = () => {
    const seenCallCounts = new Set();
    for (let idx = 0; idx < receiptList.length; idx += 1) {
      const r = receiptList[idx];
      if (!r || !Number.isSafeInteger(r.callCount) || r.callCount < 1 || r.callCount > state.calls.length || seenCallCounts.has(r.callCount)) {
        throw invalid();
      }
      seenCallCounts.add(r.callCount);
      const ce = state.calls[r.callCount - 1];
      if (!ce || (state.mode === 'map-reduce' && ce.phase !== 'map') || ce.page !== idx || ce.completed !== true) {
        throw invalid();
      }
    }
    if (hasBufferedMap) {
      for (const [key, entry] of Object.entries(state.completedMapPages)) {
        const r = entry?.receipt;
        const idx = Number(key);
        if (!r || !Number.isSafeInteger(r.callCount) || r.callCount < 1 || r.callCount > state.calls.length || seenCallCounts.has(r.callCount)) {
          throw invalid();
        }
        seenCallCounts.add(r.callCount);
        const ce = state.calls[r.callCount - 1];
        if (!ce || ce.phase !== 'map' || ce.page !== idx || ce.completed !== true) {
          throw invalid();
        }
      }
    }
  };
  const strictRequired =
    state.ledgerVersion === 2 ||
    hasBufferedMap ||
    grants.some((g) => g?.version === 2) ||
    receiptList.some((r) => r && r.callCount !== undefined);
  if (strictRequired) {
    validateStrictReceipts();
  }
  let ids = validateGrantsList(state, grants, receiptList, hasBufferedMap, bufferedReceipts, initialAcceptedTotal);
  const used = () => {
    const base = grants.at(-1) ?? {calls:0,next:0};
    const baseAccepted = base.accepted ?? base.next;
    return {calls:state.calls.length-base.calls, accepted:acceptedTotal()-baseAccepted, limit:state.segments.length-baseAccepted+extra};
  };
  const exhausted = () => {
    const u=used();
    const settledCalls = Math.max(0, u.calls - activeInFlight());
    return u.calls>=u.limit || settledCalls-u.accepted>extra;
  };
  let renewed = false;
  // One grant at entry, never from an automatic trigger or inside a retry loop.
  if ((acceptedTotal() < state.segments.length || state.reduced === false) && exhausted() && manualRetry === true && typeof requestId === 'string' && requestId && !ids.has(requestId)) {
    if (state.ledgerVersion !== 2 && Array.isArray(state.receipts)) {
      const migrated = migrateLegacyReceiptCallCounts(state);
      if (migrated || state.ledgerVersion === 2 || state.receipts.some((r) => r && r.callCount !== undefined)) {
        validateStrictReceipts();
        ids = validateGrantsList(state, grants, receiptList, hasBufferedMap, bufferedReceipts, initialAcceptedTotal);
      }
    } else if (!strictRequired && state.mode === 'map-reduce') {
      validateStrictReceipts();
    }
    const accepted = acceptedTotal();
    grants.push({version:2,calls:state.calls.length,next:state.next,accepted,requestId,at:new Date().toISOString()});
    state.budgetGrants = grants; renewed = true;
  }
  return {renewed, assertAvailable() {
    if (!exhausted()) return;
    const accepted = acceptedTotal();
    const message = `Continuation call budget exhausted; acceptedPages=${accepted}, totalPages=${state.segments.length}, requests=${state.calls.length}, extraCalls=${extra}. Accepted pages and usage are saved. A new manual /compact renews a bounded budget and resumes the first unfinished page.`;
    throw Object.assign(fail('CONTINUATION_CALL_BUDGET',message),{continuationProgress:{acceptedPages:accepted,totalPages:state.segments.length,requests:state.calls.length,extraCalls:extra}});
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
  return `接续调用预算已耗尽，${pages}${calls}${attempt}原上下文和已接受页面均保留。自动处理已暂停；手动执行 /compact 可授予一份新的有限额度，从未完成页继续，可能产生新的摘要费用。`;
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
