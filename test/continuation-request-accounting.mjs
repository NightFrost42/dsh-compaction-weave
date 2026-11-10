import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID,createHash} from 'node:crypto';
import {ContinuationProgressStore} from '../lib/continuation-progress.js';
import {prepareContinuation} from '../lib/continuation.js';import {resolveConfig} from '../lib/config.js';
import {summarizeWithChain} from '../lib/summary.js';
const rows=[];async function test(name,fn){try{await fn();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.message,stack:e.stack});}}
const NOTES='## Goal\nContinue diagnostics.\n## State\nTwo verified checks saved in evidence.json.\n## Next\nReview remaining entries.\n## Uncertain\nLive runtime outcome is unknown.';
function fixture(extra={}){
 const root=fs.mkdtempSync(join(tmpdir(),'weave-request-accounting-')),events=[{seq:0,type:'user/message',data:{role:'user',content:[{type:'text',text:'不要写库。必须保留证据路径 evidence.json。'}]}},{seq:1,type:'assistant/message',data:{message:{role:'assistant',content:[{type:'text',text:Array.from({length:3600},(_,i)=>`Observation ${i}: archived evidence retained for later examination.`).join('\n')}]}}}];
 const session={id:randomUUID(),eventAt:i=>events[i],deriveEventMessage:e=>e.type==='assistant/message'?e.data.message:e.data},calls=[];let response=()=>NOTES;
 const ctx={llm:{async *stream(o){calls.push(o);const text=await response(o,calls.length);if(text instanceof Error)throw text;yield {type:'text-delta',text};yield {type:'usage',usage:{inputTokens:100,outputTokens:30,totalTokens:130}};yield {type:'finish',kind:'stop'};}}};
 const policy=resolveConfig({summaryRetryCount:0,summaryRetryDelayMs:0,archiveEnabled:true,maxSummaryChunks:32,summaryInputMaxBytes:48000,continuationMemoryBytes:4096,continuationMaxExtraCalls:1,...extra}).config;
 const capacity={targets:[{key:JSON.stringify(['p','m']),window:1000000,output:8192,margin:0,inputRatio:1,maxInputBytes:48000,scale:1}],shrinkLimit:Infinity},chain={targets:[{provider:'p',model:'m'}],source:'session'};
 const run=(options={})=>prepareContinuation({ctx,agent:{session},session,seqs:[0,1],policy,capacity,chain,compactionId:randomUUID(),signal:new AbortController().signal,archiveRoot:join(root,'archive'),...options});
 const record=()=>{const folder=join(root,'continuation-progress',createHash('sha256').update(session.id).digest('hex'));const name=fs.readdirSync(folder).find(n=>n.endsWith('.json'));return JSON.parse(fs.readFileSync(join(folder,name)));};
 return {root,events,ctx,session,calls,run,record,setResponse:fn=>response=fn};
}
async function interceptReservations(f,action,fn){
 const rename=fs.renameSync;
 fs.renameSync=(from,to)=>{
  if(String(to).startsWith(join(f.root,'continuation-progress'))&&String(to).endsWith('.json')){
   const next=JSON.parse(fs.readFileSync(from));const prior=fs.existsSync(to)?JSON.parse(fs.readFileSync(to)):null;
   if(next.data.calls.length>(prior?.data.calls.length??0))return action({from,to,next,prior,rename});
  }
  return rename(from,to);
 };syncBuiltinESMExports();
 try{return await fn();}finally{fs.renameSync=rename;syncBuiltinESMExports();}
}
await test('uncommitted-reservation-failure-does-not-charge-a-provider-call',async()=>{
 const f=fixture();let refused=false,error;
 await interceptReservations(f,({from,to,rename})=>{if(!refused){refused=true;throw Object.assign(new Error('synthetic disk full'),{code:'ENOSPC'});}return rename(from,to);},async()=>{try{await f.run();}catch(e){error=e;}});
 assert.ok(error);assert.equal(f.calls.length,0);assert.equal(f.record().data.calls.length,0);assert.equal(error.continuationProgress.requestsThisAttempt,0);
 const r=await f.run();assert.equal(r.summarized.continuation.totalRequests,f.calls.length);assert.equal(r.summarized.continuation.unknownUsage,0);
});
await test('repeated-uncommitted-storage-failures-do-not-exhaust-provider-budget',async()=>{
 const f=fixture();
 for(let i=0;i<4;i++){
  let refused=false,error;await interceptReservations(f,({from,to,rename})=>{if(!refused){refused=true;throw Object.assign(new Error('synthetic disk full'),{code:'ENOSPC'});}return rename(from,to);},async()=>{try{await f.run();}catch(e){error=e;}});
  assert.ok(refused);assert.ok(error);assert.notEqual(error.code,'CONTINUATION_CALL_BUDGET');assert.equal(f.record().data.calls.length,0);
 }
 assert.equal(f.calls.length,0);const r=await f.run();assert.equal(r.summarized.continuation.totalRequests,r.summarized.continuation.pages.length);assert.equal(f.record().data.budgetGrants,undefined);
});
await test('later-reservation-failure-keeps-accepted-pages-without-a-phantom-call',async()=>{
 const f=fixture();let refused=false;
 await interceptReservations(f,({from,to,rename})=>{if(f.calls.length===2&&!refused){refused=true;throw Object.assign(new Error('synthetic disk full'),{code:'ENOSPC'});}return rename(from,to);},async()=>{await assert.rejects(f.run());});
 const before=f.record();assert.equal(f.calls.length,2);assert.equal(before.data.next,2);assert.equal(before.data.calls.length,2);
 const r=await f.run(),after=f.record();assert.equal(r.summarized.continuation.resumedPages,2);assert.equal(r.summarized.continuation.totalRequests,r.summarized.continuation.pages.length);assert.deepEqual(after.data.calls.slice(0,2),before.data.calls);assert.deepEqual(after.data.receipts.slice(0,2),before.data.receipts);
});
await test('cancel-after-durable-reservation-before-dispatch-refunds-only-the-unsent-reservation',async()=>{
 const f=fixture(),c=new AbortController();let cancelled=false;
 await interceptReservations(f,({from,to,rename})=>{const result=rename(from,to);if(!cancelled){cancelled=true;c.abort();}return result;},async()=>{await assert.rejects(f.run({signal:c.signal}));});
 assert.ok(cancelled);assert.equal(f.calls.length,0);assert.equal(f.record().data.calls.length,0);
 const r=await f.run();assert.equal(r.summarized.continuation.totalRequests,r.summarized.continuation.pages.length);assert.equal(r.summarized.continuation.unknownUsage,0);
});
await test('refund-save-failure-keeps-durable-unknown-reservation-and-stops',async()=>{
 const f=fixture(),c=new AbortController(),rename=fs.renameSync;let refundAttempted=false;
 fs.renameSync=(from,to)=>{
  if(String(to).startsWith(join(f.root,'continuation-progress'))&&String(to).endsWith('.json')){
   const next=JSON.parse(fs.readFileSync(from));if(fs.existsSync(to)){
    const prior=JSON.parse(fs.readFileSync(to));
    if(next.data.calls.length>prior.data.calls.length){const r=rename(from,to);c.abort();return r;}
    if(next.data.calls.length<prior.data.calls.length){refundAttempted=true;throw Object.assign(new Error('synthetic refund disk full'),{code:'ENOSPC'});}
   }
  }return rename(from,to);
 };syncBuiltinESMExports();try{await assert.rejects(f.run({signal:c.signal}));}finally{fs.renameSync=rename;syncBuiltinESMExports();}
 assert.ok(refundAttempted);assert.equal(f.calls.length,0);assert.equal(f.record().data.calls.length,1);assert.equal(f.record().data.calls[0].usage,null);
});
for(const [name,stream] of [
 ['synchronous-adapter-throw',()=>{throw Object.assign(new Error('adapter may already have sent'),{code:'ECONNRESET'});}],
 ['iterator-initialization-throw',()=>({[Symbol.asyncIterator](){throw Object.assign(new Error('iterator unavailable'),{code:'ECONNRESET'});}})],
 ['first-read-failure',()=>({[Symbol.asyncIterator](){return this;},next(){throw Object.assign(new Error('transport failed'),{code:'ECONNRESET'});}})]
])await test(name+'-keeps-possibly-sent-unknown-usage',async()=>{
 const f=fixture();let invoked=0;f.ctx.llm.stream=(...args)=>{invoked++;return stream(...args);};await assert.rejects(f.run());assert.equal(invoked,1);assert.equal(f.record().data.calls.length,1);assert.equal(f.record().data.calls[0].usage,null);assert.equal(f.record().data.calls[0].completed,false);
});
await test('stream-terminal-metadata-distinguishes-local-preflight-from-dispatch',async()=>{
 let dispatched=0;const records=[],error=Object.assign(new Error('local reservation denied'),{code:'ENOSPC'});
 const args={ctx:{llm:{stream(){dispatched++;throw Object.assign(new Error('adapter failure'),{code:'ECONNRESET'});}}},agent:{session:{toolHistory:()=>[]}},chain:{targets:[{provider:'p',model:'m'}]},input:{messages:[{role:'user',content:[{type:'text',text:'synthetic history'}]}]},signal:new AbortController().signal,options:{retryCount:0,retryDelayMs:0,singleTarget:true,maxTokens:512,timeoutMs:5000,beforeRequest:()=>{throw error;},afterRequest:r=>records.push(r)}};
 await assert.rejects(summarizeWithChain(args));assert.equal(dispatched,0);assert.equal(records[0].requestStarted,false);
 delete args.options.beforeRequest;await assert.rejects(summarizeWithChain(args));assert.equal(dispatched,1);assert.equal(records[1].requestStarted,true);
});
await test('cancellation-after-adapter-invocation-retains-unknown-call',async()=>{
 const f=fixture(),c=new AbortController();f.setResponse(()=>{c.abort();return NOTES;});await assert.rejects(f.run({signal:c.signal}));
 assert.equal(f.calls.length,1);assert.equal(f.record().data.calls.length,1);assert.equal(f.record().data.calls[0].usage,null);assert.equal(f.record().data.next,0);
});
await test('cancelling-an-unsent-reservation-preserves-all-earlier-usage',async()=>{
 const f=fixture();f.setResponse(()=>Object.assign(new Error('transport uncertainty'),{code:'ECONNRESET'}));await assert.rejects(f.run());const before=f.record(),c=new AbortController();
 await interceptReservations(f,({from,to,rename})=>{const r=rename(from,to);c.abort();return r;},async()=>{await assert.rejects(f.run({signal:c.signal}));});
 assert.equal(f.calls.length,1);assert.deepEqual(f.record().data.calls,before.data.calls);assert.equal(f.record().data.next,before.data.next);
});
await test('concurrent-progress-change-prevents-removing-an-unsent-reservation',async()=>{
 const f=fixture(),c=new AbortController(),write=ContinuationProgressStore.prototype.write;let changed=false,newer;
 ContinuationProgressStore.prototype.write=function(data,revision){
  const current=this.read();
  if(!changed&&current&&data.calls.length<current.data.calls.length){
   changed=true;const next=structuredClone(current.data);next.otherWriterMarker='preserve newer record';newer=write.call(this,next,revision);
  }
  return write.call(this,data,revision);
 };
 try{await interceptReservations(f,({from,to,rename})=>{const r=rename(from,to);c.abort();return r;},async()=>{await assert.rejects(f.run({signal:c.signal}));});}finally{ContinuationProgressStore.prototype.write=write;}
 assert.ok(changed);assert.equal(f.calls.length,0);assert.deepEqual(f.record(),newer);assert.equal(f.record().data.calls.length,1);
});
async function withClock(fn){
 const own=Object.getOwnPropertyDescriptor(performance,'now');let at=0;Object.defineProperty(performance,'now',{configurable:true,value:()=>at});
 try{return await fn(value=>at=value);}finally{if(own)Object.defineProperty(performance,'now',own);else delete performance.now;}
}
for(const accepted of [0,2])await test('slow-reservation-after-'+accepted+'-accepted-pages-never-starts-expired-request',async()=>{
 const f=fixture({summaryTimeoutMs:5000});let error;
 await withClock(async set=>{
  await interceptReservations(f,({from,to,rename})=>{const r=rename(from,to);if(f.calls.length===accepted)set(5001);return r;},async()=>{try{await f.run();}catch(e){error=e;}});
 });
 assert.equal(error?.code,'SUMMARY_TIMEOUT');assert.equal(f.calls.length,accepted);const saved=f.record();assert.equal(saved.data.next,accepted);assert.equal(saved.data.calls.length,accepted);assert.equal(error.continuationProgress.requestsThisAttempt,accepted);
 const r=await f.run();assert.equal(r.summarized.continuation.resumedPages,accepted);assert.equal(r.summarized.continuation.totalRequests,r.summarized.continuation.pages.length);assert.equal(r.summarized.continuation.unknownUsage,0);assert.deepEqual(f.record().data.receipts.slice(0,accepted),saved.data.receipts);
});
await test('slow-adapter-initialization-remains-a-possibly-sent-call-without-reading',async()=>{
 const f=fixture({summaryTimeoutMs:5000});let invoked=0,reads=0,closed=0;
 await withClock(async set=>{
  f.ctx.llm.stream=()=>{invoked++;set(5001);return {[Symbol.asyncIterator](){return this;},async next(){reads++;return {done:true};},async return(){closed++;return {done:true};}};};
  await assert.rejects(f.run(),e=>e.code==='SUMMARY_TIMEOUT');
 });
 assert.equal(invoked,1);assert.equal(reads,0);assert.equal(closed,1);assert.equal(f.record().data.calls.length,1);assert.equal(f.record().data.calls[0].usage,null);assert.equal(f.record().data.next,0);
});
console.log(JSON.stringify({passed:rows.filter(x=>x.pass).length,failed:rows.filter(x=>!x.pass).length,results:rows},null,2));if(rows.some(x=>!x.pass))process.exitCode=1;
