import assert from 'node:assert/strict';
import {summarizeWithChain} from '../lib/summary.js';
import {SummaryProgress} from '../lib/summary-progress.js';
const rows=[];async function test(name,fn){try{await fn();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.message,stack:e.stack});}}
async function withClock(fn){
 const own=Object.getOwnPropertyDescriptor(performance,'now');let at=0;Object.defineProperty(performance,'now',{configurable:true,value:()=>at});
 try{return await fn(value=>at=value);}finally{if(own)Object.defineProperty(performance,'now',own);else delete performance.now;}
}
function fixture({beforeRequest,signal=new AbortController().signal,onStream,onNext}={}){
 const stats={dispatch:0,reads:0,returns:0,ended:[],signals:[]};
 const args={ctx:{llm:{stream(o){stats.dispatch++;stats.signals.push(o.signal);onStream?.();return {[Symbol.asyncIterator](){return this;},async next(){stats.reads++;onNext?.(stats.reads);return stats.reads===1?{value:{type:'text-delta',text:'Summary ready.'},done:false}:{done:true};},return(){stats.returns++;return Promise.resolve({done:true});}};}}},agent:{session:{toolHistory:()=>[]}},chain:{targets:[{provider:'primary',model:'one'},{provider:'backup',model:'two'}]},input:{messages:[{role:'user',content:[{type:'text',text:'Synthetic evidence.'}]}]},signal,options:{retryCount:0,retryDelayMs:0,maxTokens:512,timeoutMs:5000,beforeRequest,afterRequest:r=>stats.ended.push(r)}};
 return {args,stats,run:()=>summarizeWithChain(args)};
}
for(const elapsed of [5000,5001])await test('deadline-'+elapsed+'-before-dispatch-spends-no-provider-call',()=>withClock(async set=>{
 const f=fixture({beforeRequest:()=>set(elapsed)});await assert.rejects(f.run(),e=>e.code==='SUMMARY_TIMEOUT'&&e.diagnostics.elapsedMs===elapsed);
 assert.equal(f.stats.dispatch,0);assert.equal(f.stats.reads,0);assert.equal(f.stats.ended.length,1);assert.equal(f.stats.ended[0].requestStarted,false);
}));
await test('request-just-before-deadline-is-still-allowed',()=>withClock(async set=>{
 const f=fixture({beforeRequest:()=>set(4999)});const r=await f.run();assert.equal(r.rawText,'Summary ready.');assert.equal(f.stats.dispatch,1);assert.equal(f.stats.ended[0].completed,true);
}));
await test('slow-real-preflight-blocks-past-timer-without-dispatch',async()=>{
 const f=fixture({beforeRequest:()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5050)});
 const started=performance.now();await assert.rejects(f.run(),e=>e.code==='SUMMARY_TIMEOUT');assert.ok(performance.now()-started>=5000);
 assert.equal(f.stats.dispatch,0);assert.equal(f.stats.reads,0);assert.equal(f.stats.ended[0].requestStarted,false);
});
await test('slow-adapter-initialization-stops-before-first-read-and-closes-iterator',()=>withClock(async set=>{
 const f=fixture({onStream:()=>set(5001)});await assert.rejects(f.run(),e=>e.code==='SUMMARY_TIMEOUT');
 assert.equal(f.stats.dispatch,1);assert.equal(f.stats.reads,0);assert.equal(f.stats.returns,1);assert.equal(f.stats.ended[0].requestStarted,true);assert.equal(f.stats.ended[0].usage,null);assert.equal(f.stats.signals[0].aborted,true);
}));
await test('processing-last-chunk-past-deadline-does-not-pull-another-chunk',()=>withClock(async set=>{
 const observe=SummaryProgress.prototype.observe;SummaryProgress.prototype.observe=function(change){observe.call(this,change);set(5001);};const f=fixture();
 try{await assert.rejects(f.run(),e=>e.code==='SUMMARY_TIMEOUT');}finally{SummaryProgress.prototype.observe=observe;}
 assert.equal(f.stats.dispatch,1);assert.equal(f.stats.reads,1);assert.equal(f.stats.returns,1);assert.equal(f.stats.signals[0].aborted,true);
}));
await test('caller-cancellation-is-not-relabelled-as-timeout',()=>withClock(async set=>{
 const c=new AbortController(),reason=Object.assign(new Error('user cancelled'),{code:'ABORTED'}),f=fixture({signal:c.signal,beforeRequest:()=>{set(7000);c.abort(reason);}});
 await assert.rejects(f.run(),e=>e===reason);assert.equal(f.stats.dispatch,0);assert.equal(f.stats.ended[0].errorCode,'ABORTED');
}));
await test('local-storage-error-is-not-hidden-by-expired-time',()=>withClock(async set=>{
 const original=Object.assign(new Error('disk full'),{code:'ENOSPC'}),f=fixture({beforeRequest:()=>{set(7000);throw original;}});f.args.options.singleTarget=true;
 await assert.rejects(f.run(),e=>e===original);assert.equal(f.stats.dispatch,0);assert.equal(f.stats.ended[0].errorCode,'ENOSPC');
}));
await test('no-stream-progress-is-counted-before-late-dispatch-is-refused',()=>withClock(async set=>{
 const f=fixture({beforeRequest:()=>set(9000)});let error;try{await f.run();}catch(e){error=e;}
 assert.equal(error.code,'SUMMARY_TIMEOUT');assert.equal(error.diagnostics.chunks,0);assert.equal(error.diagnostics.firstProgressMs,null);assert.equal(error.diagnostics.textChars,0);assert.equal(f.stats.ended[0].requestStarted,false);
}));
console.log(JSON.stringify({passed:rows.filter(x=>x.pass).length,failed:rows.filter(x=>!x.pass).length,results:rows},null,2));if(rows.some(x=>!x.pass))process.exitCode=1;
