import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {WeaveCompactionEngine} from '../lib/engine.js';import {resolveConfig} from '../lib/config.js';
import {registerCompactionTool} from '../lib/proactive.js';
const rows=[];async function test(name,fn){try{await fn();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.message,stack:e.stack});}}
async function fixture(config={}){
 const events=[],surface={nodes:[],replaceGeneration:0},hooks=new Map(),signal=new AbortController();let tokens=20000,calls=0,nextCalls=0;
 const session={id:'phase',surface,get seq(){return events.length;},eventAt:i=>events[i],snapshotEvents:()=>events,deriveEventMessage:e=>e?.type==='assistant/message'?e.data.message:e?.data,
 append(type,data,options={}){const e={seq:events.length,type,data};events.push(e);if(options.surfaceOp==='append')surface.nodes.push(e.seq);return e;}};
 session.append('turn/start',{turn:0});session.append('user/message',{role:'user',source:{kind:'user'},content:[{type:'text',text:'task'}]},{surfaceOp:'append'});
 const ctx={on:(n,f)=>hooks.set(n,f),provide(){},logger:{warn(){},info(){}}};
 const engine=new WeaveCompactionEngine(ctx,resolveConfig({auto:false,archiveDir:join(await mkdtemp(join(tmpdir(),'weave-phase-')),'history'),...config}).config);engine.historyToolsAvailable=true;engine.recoverPending=async()=>({recovered:0});
 engine._measure=async()=>({totalTokens:tokens,nodes:surface.nodes.map(seq=>({seq,tokens:tokens/surface.nodes.length}))});
 engine._compactManual=async(_a,_s,_id,cont,proactive)=>{assert.equal(cont,false);assert.equal(proactive,true);calls++;return {compactionId:'c1'};};
 const agent={session};let tool;registerCompactionTool({tools:{register(spec){tool=spec;}}},engine);
 const request=(reason='Stage one complete')=>tool.execute({reason},{agent,signal:signal.signal});
 const step=(messages=[])=>hooks.get('agent/pre-step')({agent,signal:signal.signal,messages},async()=>{nextCalls++;return {kind:'enter'};});
 return {engine,session,events,agent,tool,request,step,signal,set tokens(n){tokens=n;},get calls(){return calls;},get nextCalls(){return nextCalls;}};
}
await test('queued-not-completed-inside-running-tool',async()=>{const f=await fixture();assert.equal(JSON.parse(await f.request()).status,'queued');assert.equal(f.calls,0);await f.step();assert.equal(f.calls,1);assert.equal(f.session.eventAt(f.session.surface.nodes.at(-1)).data.source.status,'compacted');assert.equal(f.nextCalls,1);});
await test('duplicate-tool-requests-coalesce-and-run-once',async()=>{const f=await fixture();const a=JSON.parse(await f.request()),b=JSON.parse(await f.request());assert.equal(a.requestId,b.requestId);await f.step();await f.step();assert.equal(f.calls,1);});
await test('small-context-keeps-prefix-with-zero-model-calls',async()=>{const f=await fixture();f.tokens=100;const old=JSON.stringify(f.events);await f.request();await f.step();assert.equal(f.calls,0);assert.equal(JSON.stringify(f.events.slice(0,-1)),old);assert.equal(f.events.at(-1).data.source.status,'skipped');});
await test('little-new-material-after-attempt-is-skipped',async()=>{const f=await fixture();await f.request();await f.step();await f.request();await f.step();assert.equal(f.calls,1);assert.equal(f.events.at(-1).data.source.status,'skipped');});
await test('failed-attempt-does-not-loop-or-claim-success',async()=>{const f=await fixture();let count=0;f.engine._compactManual=async()=>{count++;throw Object.assign(new Error('bad output'),{code:'CONSTRAINT_LOST'});};await f.request();await f.step();assert.equal(f.events.at(-1).data.source.status,'failed');await f.request();await f.step();assert.equal(count,1);});
await test('circuit-breaker-is-not-reset-by-tool',async()=>{const f=await fixture();f.engine.sessionState.update('phase',s=>({...s,failures:3,stopped:true}));assert.equal(JSON.parse(await f.request()).status,'blocked');await f.step();assert.equal(f.calls,0);assert.equal(f.engine.sessionState.read('phase').failures,3);});
await test('new-user-input-takes-precedence',async()=>{const f=await fixture();await f.request();await f.step([{source:{kind:'user'},content:[{type:'text',text:'Cancel previous task.'}]}]);assert.equal(f.calls,0);assert.equal(f.events.at(-1).data.source.status,'skipped');});
await test('aborted-tool-does-not-queue-work',async()=>{const f=await fixture();f.signal.abort();await assert.rejects(f.request());assert.equal(f.calls,0);});
await test('turn-change-cancels-stale-request',async()=>{const f=await fixture();await f.request();f.session.append('turn/end',{turn:0});f.session.append('turn/start',{turn:1});await f.step();assert.equal(f.calls,0);});
await test('requires-archive-and-history-tools',async()=>{const f=await fixture();f.engine.historyToolsAvailable=false;assert.equal(JSON.parse(await f.request()).status,'blocked');});
await test('explicit-configuration-can-disable-ai-entry',async()=>{const f=await fixture({proactiveEnabled:false});assert.equal(f.tool,undefined);});
await test('missing-agent-and-invalid-reason-are-clear',async()=>{const f=await fixture();assert.equal(JSON.parse(await f.tool.execute({reason:'done'},{})).status,'unavailable');assert.equal(JSON.parse(await f.request('')).status,'invalid');});
await test('no-idle-maintenance-reentry',async()=>{const f=await fixture();f.agent.runMaintenance=()=>assert.fail('tool must not enter idle maintenance');await f.request();await f.step();assert.equal(f.calls,1);});
await test('native-normalized-meter-recognizes-new-phase-growth',async()=>{
 const f=await fixture();await f.request();await f.step();assert.equal(f.calls,1);
 f.session.append('assistant/message',{message:{role:'assistant',content:[{type:'text',text:'Verified new phase evidence. '.repeat(3000)}]}},{surfaceOp:'append'});
 f.engine.ctx.tokenMeter={measure:()=>({totalTokens:32000,nodes:f.session.surface.nodes.map(seq=>({seq,tokens:8000,heuristicTokens:8000}))})};
 f.engine._measure=WeaveCompactionEngine.prototype._measure;await f.request();await f.step();assert.equal(f.calls,2);assert.equal(f.events.at(-1).data.source.status,'compacted');
});
await test('native-normalized-meter-still-skips-tiny-growth',async()=>{
 const f=await fixture();await f.request();await f.step();
 f.session.append('assistant/message',{message:{role:'assistant',content:[{type:'text',text:'Small update.'}]}},{surfaceOp:'append'});
 f.engine.ctx.tokenMeter={measure:()=>({totalTokens:32000,nodes:f.session.surface.nodes.map(seq=>({seq,tokens:20,heuristicTokens:20}))})};
 f.engine._measure=WeaveCompactionEngine.prototype._measure;await f.request();await f.step();assert.equal(f.calls,1);assert.equal(f.events.at(-1).data.source.status,'skipped');
});
await test('skipped-phase-still-runs-pressure-check-on-same-step',async()=>{
 const f=await fixture({auto:true});let pressure=0;f.engine.compactIfNeeded=async()=>{pressure++;return null;};f.engine._guardRequestBudget=async()=>{};f.tokens=100;
 await f.request();await f.step();assert.equal(f.calls,0);assert.equal(pressure,1);assert.equal(f.nextCalls,1);
});
await test('failed-phase-does-not-trigger-an-immediate-paid-retry',async()=>{
 const f=await fixture({auto:true});let pressure=0;f.engine.compactIfNeeded=async()=>{pressure++;};f.engine._guardRequestBudget=async()=>{};f.engine._compactManual=async()=>{throw new Error('controlled failure');};
 await f.request();await f.step();assert.equal(pressure,0);assert.equal(f.events.at(-1).data.source.status,'failed');
});
console.log(JSON.stringify({passed:rows.filter(r=>r.pass).length,failed:rows.filter(r=>!r.pass).length,results:rows},null,2));if(rows.some(r=>!r.pass))process.exitCode=1;
