import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {summarizeWithChain} from '../lib/summary.js';
import {WeaveCompactionEngine} from '../lib/engine.js';
import {resolveConfig} from '../lib/config.js';
import {approxTokens, blocksToText} from '../lib/meter.js';
import {auditCompaction} from '../lib/audit.js';
import {reconstructDisputedLines} from '../lib/reconstruct.js';
import {continuationBudgetInfo, continuationBudgetText, budgetForCommand} from '../lib/continuation-budget.js';

const rows = [], observations = [];
async function test(name, fn) {
  try { await fn(); rows.push({name, pass:true}); }
  catch (error) { rows.push({name, pass:false, error:error.message, stack:error.stack}); }
}
async function rejection(promise) {
  try { await promise; } catch (error) { return error; }
  assert.fail('Expected the operation to reject');
}
const SOURCE = '不要写库。\n未经审批不要写库。';
const NOTES = '## Goal\nContinue diagnostics.\n## State\nEvidence remains archived.\n## Next\nReview results.\n## Uncertain\nPending runtime verification.';
const CONTRADICTION = NOTES.replace('Review results.', '可以写库。');
const budgetError = () => Object.assign(new Error('acceptedPages=0, totalPages=12, requests=1, extraCalls=0'), {code:'CONTINUATION_CALL_BUDGET'});

await test('fixture-is-real-polarity-conflict-and-cannot-be-reconstructed', () => {
  const messages = [{seq:1, text:SOURCE}];
  const audit = auditCompaction({userMessages:messages, summaryText:CONTRADICTION, checkpointText:SOURCE, includeAllConflicts:true});
  assert.ok(audit.lost.some(x => x.reason === 'polarity'));
  assert.equal(reconstructDisputedLines({text:CONTRADICTION, userMessages:messages, audit, format:'continuation'}), null);
});

for (const allowedCalls of [0, 1]) await test('budget-rethrow-preserves-identity-after-' + allowedCalls + '-requests', async () => {
  const original = budgetError(); let calls = 0;
  const error = await rejection(summarizeWithChain({
    ctx:{llm:{async *stream() { calls++; yield {type:'text-delta', text:CONTRADICTION}; yield {type:'finish', kind:'stop'}; }}},
    agent:{}, input:{messages:[]}, chain:{targets:[{provider:'p',model:'m'}, {provider:'unused',model:'m'}]},
    options:{retryDelayMs:0,singleTarget:true, maxTokens:8192, timeoutMs:5000, language:'en',
      beforeRequest:() => { if (calls >= allowedCalls) throw original; },
      validate:() => ({ok:false, code:'CONSTRAINT_LOST', message:'controlled real rejection'})},
    signal:new AbortController().signal,
  }));
  observations.push({case:'summary-propagation', allowedCalls, calls, code:error.code, sameError:error === original});
  assert.equal(error, original);
  assert.equal(error.code, 'CONTINUATION_CALL_BUDGET');
  assert.equal(calls, allowedCalls);
});

async function fixture(extra) {
  const root = await mkdtemp(join(tmpdir(), 'weave-budget-failure-'));
  const events = [], surface = {nodes:[], replaceGeneration:0}, calls = [];
  const session = {id:randomUUID(), surface, get seq() { return events.length; },
    eventAt:i => events[i], snapshotEvents:() => events, requestHeader:() => ({config:{provider:'p',model:'m'}}), toolHistory:() => [],
    deriveEventMessage(e) { return e?.type === 'assistant/message' ? e.data.message : e?.type.endsWith('/message') ? e.data : undefined; },
    append(type, data, options = {}) {
      const event = {seq:events.length, type, data}; events.push(event);
      const op = options.surfaceOp;
      if (op?.op === 'replace') {
        const start = surface.nodes.indexOf(op.startSeq), end = surface.nodes.indexOf(op.endSeq);
        assert.ok(start >= 0 && end >= start); surface.nodes.splice(start, end - start + 1, event.seq); surface.replaceGeneration++;
      } else if (op === 'append') surface.nodes.push(event.seq);
      return event;
    }};
  const add = (text, role = 'user') => session.append(role + '/message', role === 'assistant'
    ? {message:{id:randomUUID(), role, content:[{type:'text',text}], source:{kind:'fixture'}}}
    : {id:randomUUID(), role, content:[{type:'text',text}], source:{kind:'user'}}, {surfaceOp:'append'});
  add('Stable system', 'system'); add(SOURCE + '\n' + 'archiveblob '.repeat(6000)); add('evidence '.repeat(4000), 'assistant');
  let response = (options, count) => count <= 2 ? NOTES : CONTRADICTION;
  const ctx = {on(){}, provide(){}, logger:{info(){}, warn(){}}, sessions:{async flush(){}}, tokenMeter:{measure() {
    const nodes = surface.nodes.map(seq => ({seq, tokens:approxTokens(blocksToText(session.deriveEventMessage(events[seq])?.content))}));
    return {nodes, totalTokens:nodes.reduce((n,x) => n+x.tokens, 0)};
  }}, llm:{async resolveModelInfo(){ return {contextWindow:1000000}; }, async *stream(options) {
    calls.push(options); const text = response(options,calls.length); if (text instanceof Error) throw text;
    yield {type:'text-delta',text}; yield {type:'usage',usage:{inputTokens:100,outputTokens:10,totalTokens:110}}; yield {type:'finish',kind:'stop'};
  }}};
  let engine = new WeaveCompactionEngine(ctx, resolveConfig({summaryRetryCount:1,summaryRetryDelayMs:0,archiveDir:join(root,'archive'), summaryInputMaxBytes:50000,
    maxSummaryChunks:32, windowFallback:1000000, continuationMaxExtraCalls:extra}).config);
  engine.historyToolsAvailable = true;
  const agent = {session, options:{provider:'p',model:'m'}, runMaintenance:fn => fn(new AbortController().signal)};
  const state = () => engine.sessionState.read(session.id);
  const progress = async () => JSON.parse(await readFile(join(root,'continuation-progress', createHash('sha256').update(session.id).digest('hex'), state().continuationPending.progressKey + '.json'), 'utf8'));
  const manual = (id = randomUUID()) => engine.compactNow(agent,new AbortController().signal,id,true);
  const auto = async () => {
    session.append('turn/start',{turn:99});
    try { return await engine.compactIfNeeded(agent,'pressure',new AbortController().signal); }
    finally { session.append('turn/end',{turn:99,reason:{kind:'completed'}}); }
  };
  return {calls, events, surface, state, progress, manual, auto, session, add,
    good:() => { response = () => NOTES; },
    transport:() => { response = () => Object.assign(new Error('controlled transport failure'),{code:'ECONNRESET'}); },
    restart:() => { engine = new WeaveCompactionEngine(ctx,engine.config); engine.historyToolsAvailable = true; },
  };
}

for (const extra of [0,1,4]) await test('persistent-real-rejection-counts-each-new-attempt-extra-' + extra, async () => {
  const f = await fixture(extra), trace = []; let frozen;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const before = f.calls.length, error = await rejection(f.manual());
    const saved = await f.progress(), state = f.state();
    frozen ??= {key:saved.key, receipts:structuredClone(saved.data.receipts), calls:structuredClone(saved.data.calls.slice(0,2))};
    trace.push({attempt, code:error.code, causeCode:error.cause?.code, requestsDelta:f.calls.length-before,
      requestsThisAttempt:continuationBudgetInfo(error)?.requestsThisAttempt ?? null, next:saved.data.next,
      calls:saved.data.calls.length, failures:state.failures, stopped:state.stopped, grants:saved.data.budgetGrants?.length ?? 0});
    assert.equal(saved.key,frozen.key); assert.equal(saved.data.next,2);
    assert.deepEqual(saved.data.receipts,frozen.receipts); assert.deepEqual(saved.data.calls.slice(0,2),frozen.calls);
    assert.equal(f.surface.replaceGeneration,0);
    if (attempt === 3) {
      f.restart(); const n = f.calls.length;
      await rejection(f.auto()); assert.equal(f.calls.length,n);
    }
  }
  observations.push({case:'persistent-real-rejection',extra,trace});
  assert.deepEqual(trace.map(x=>x.failures),[1,2,3,4,5,6]);
  assert.deepEqual(trace.map(x=>x.stopped),[false,false,true,true,true,true]);
  assert.ok(trace.every(x=>x.requestsDelta > 0));
  for (const x of trace.filter(x=>x.causeCode==='CONTINUATION_CALL_BUDGET')) assert.equal(x.requestsThisAttempt,x.requestsDelta);
  const before = f.calls.length; f.good();
  const success = await f.manual();
  assert.equal(success.continuation.resumedPages,2);
  assert.equal(success.continuation.progressKey,frozen.key);
  assert.equal(f.calls.length-before,success.continuation.pages.length-2);
  assert.equal(f.state().failures,0); assert.equal(f.state().stopped,false); assert.equal(f.state().continuationPending,undefined);
});

await test('spent-budget-check-is-free-and-does-not-count-again', async () => {
  const f = await fixture(0);
  const first = await rejection(f.manual('one-command'));
  assert.equal(first.code,'summary'); assert.equal(first.cause.code,'CONTINUATION_CALL_BUDGET');
  const before = f.calls.length, prior = f.state().failures, saved = await f.progress();
  for (let i=0;i<3;i++) {
    const error = await rejection(f.auto()); assert.equal(error.code,'CONTINUATION_CALL_BUDGET');
    assert.equal(continuationBudgetInfo(error).requestsThisAttempt,0);
    assert.equal(f.state().failures,prior); assert.equal(f.calls.length,before);
  }
  assert.deepEqual(await f.progress(),saved); assert.equal(f.state().failures,prior);
  // The first command started with unspent budget. A new command can grant
  // once; only re-entering that granted command must stay free thereafter.
  await rejection(f.manual('renewal-command'));
  const renewed = await f.progress(), afterRenewal = f.calls.length, failureCount = f.state().failures;
  const same = await rejection(f.manual('renewal-command'));
  assert.equal(same.cause.code,'CONTINUATION_CALL_BUDGET'); assert.equal(f.calls.length,afterRenewal);
  assert.deepEqual(await f.progress(),renewed); assert.equal(f.state().failures,failureCount);
});

await test('automatic-failed-request-hits-breaker-even-when-final-error-is-budget', async () => {
  const f = await fixture(4);
  await rejection(f.manual()); await rejection(f.manual());
  assert.equal(f.state().failures,2); const before = f.calls.length;
  const error = await rejection(f.auto());
  assert.equal(error.code,'CONTINUATION_CALL_BUDGET'); assert.equal(f.calls.length,before+1);
  assert.equal(continuationBudgetInfo(error).requestsThisAttempt,1);
  assert.equal(f.state().failures,3); assert.equal(f.state().stopped,true);
  f.restart(); await rejection(f.auto()); assert.equal(f.calls.length,before+1);
  assert.equal(f.state().failures,3); assert.equal(f.surface.replaceGeneration,0);
});

await test('transport-failures-still-count-once-per-failed-operation', async () => {
  const f = await fixture(0); f.transport();
  for (let attempt=1;attempt<=3;attempt++) { await rejection(f.manual()); assert.equal(f.calls.length,attempt); assert.equal(f.state().failures,attempt); }
  assert.equal(f.state().stopped,true);
});

await test('budget-diagnostics-survive-command-text-and-host-wrapper', () => {
  const error = Object.assign(budgetError(), {continuationProgress:{acceptedPages:2,totalPages:12,requests:3,extraCalls:0,requestsThisAttempt:3,acceptedPagesThisAttempt:2}});
  error.message += ', requestsThisAttempt=3, acceptedPagesThisAttempt=2';
  assert.equal(continuationBudgetInfo({code:'summary',cause:error}).requestsThisAttempt,3);
  assert.match(continuationBudgetText(error),/本次新调用 3 次，接受 2 页/);
  const events = [{type:'compaction/end',data:{sourceCommandId:'cmd',error:error.code+': '+error.message}}];
  assert.equal(continuationBudgetInfo(budgetForCommand({seq:1,eventAt:i=>events[i]},'cmd')).requestsThisAttempt,3);
  assert.equal(continuationBudgetInfo({code:'SUMMARY_ALL_FAILED',failures:[error]}).requestsThisAttempt,3);
});

console.log(JSON.stringify({passed:rows.filter(x=>x.pass).length,failed:rows.filter(x=>!x.pass).length,results:rows,observations},null,2));
if (rows.some(x=>!x.pass)) process.exitCode=1;
