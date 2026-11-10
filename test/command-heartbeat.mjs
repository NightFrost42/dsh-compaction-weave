import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {setTimeout as sleep} from 'node:timers/promises';
import {createCommandHeartbeatScope,withCommandHeartbeat,installCommandHeartbeat,COMMAND_HEARTBEAT_MS} from '../lib/command-heartbeat.js';
import {decorateCompactCommand} from '../lib/command-compact.js';
const rows=[];
async function test(name,fn){try{await fn();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.message,stack:e.stack});}}
function fixture(options={}){
 const response=Object.assign(new EventEmitter(),{pulses:0,headersSent:false,destroyed:false,writableEnded:false,writeProcessing(){this.pulses++;}});
 const scope=createCommandHeartbeatScope({intervalMs:5});
 const controller=new AbortController();
 const invocation={rawInput:'',signal:controller.signal};
 const request={method:'POST',url:'/api/commands/execute',...options};
 return {response,scope,controller,invocation,request,run:fn=>scope.handle(request,response,()=>withCommandHeartbeat(invocation,fn))};
}
await test('production-heartbeat-interval-is-fifteen-seconds',()=>assert.equal(COMMAND_HEARTBEAT_MS,15000));
await test('minimal-non-web-host-does-not-need-lifecycle-hooks',()=>{assert.doesNotThrow(()=>installCommandHeartbeat({on(){throw new Error('unexpected registration');}}));});
await test('no-http-scope-keeps-direct-command-result',async()=>{const r={kind:'success',text:'ok'};assert.equal(await withCommandHeartbeat({rawInput:''},()=>r),r);});
await test('active-command-emits-informational-pulses-only',async()=>{const f=fixture();const r={kind:'success'};assert.equal(await f.run(async()=>{await sleep(22);return r;}),r);assert.ok(f.response.pulses>=2);assert.equal(f.response.headersSent,false);assert.equal(f.response.writableEnded,false);});
await test('completed-command-removes-timer-and-listeners',async()=>{const f=fixture();await f.run(()=>null);const n=f.response.pulses;await sleep(18);assert.equal(f.response.pulses,n);assert.equal(f.response.listenerCount('close'),0);assert.equal(f.response.listenerCount('finish'),0);});
await test('handler-rejection-keeps-original-error-and-cleans-up',async()=>{const f=fixture(),e=new Error('native failure');await assert.rejects(f.run(()=>{throw e;}),x=>x===e);const n=f.response.pulses;await sleep(15);assert.equal(f.response.pulses,n);assert.equal(f.response.listenerCount('close'),0);});
await test('unsupported-writeProcessing-keeps-command-working',async()=>{const f=fixture();delete f.response.writeProcessing;assert.equal(await f.run(()=>17),17);assert.equal(f.response.pulses,0);});
for(const key of ['headersSent','destroyed','writableEnded'])await test(key+'-response-is-not-touched',async()=>{const f=fixture();f.response[key]=true;assert.equal(await f.run(()=>7),7);assert.equal(f.response.pulses,0);});
await test('invalid-command-arguments-do-not-start-heartbeats',async()=>{const f=fixture();f.invocation.rawInput='unexpected';await f.run(()=>undefined);assert.equal(f.response.pulses,0);});
await test('already-aborted-command-is-not-kept-alive',async()=>{const f=fixture();f.controller.abort();await f.run(()=>undefined);assert.equal(f.response.pulses,0);});
await test('caller-abort-stops-heartbeats-with-original-signal',async()=>{const f=fixture();const promise=f.run(async()=>{assert.equal(f.invocation.signal,f.controller.signal);await sleep(100,undefined,{signal:f.invocation.signal});});await sleep(12);f.controller.abort();await assert.rejects(promise,e=>e.name==='AbortError');const n=f.response.pulses;await sleep(15);assert.equal(f.response.pulses,n);});
await test('client-disconnect-stops-heartbeats',async()=>{const f=fixture();await f.run(async()=>{await sleep(10);f.response.destroyed=true;f.response.emit('close');const n=f.response.pulses;await sleep(18);assert.equal(f.response.pulses,n);});});
await test('final-response-stops-heartbeats-before-handler-retires',async()=>{const f=fixture();await f.run(async()=>{f.response.headersSent=true;f.response.emit('finish');const n=f.response.pulses;await sleep(18);assert.equal(f.response.pulses,n);});});
await test('writeProcessing-error-does-not-replace-native-outcome',async()=>{const f=fixture();f.response.writeProcessing=()=>{throw new Error('socket closed');};assert.equal(await f.run(()=>19),19);assert.equal(f.response.listenerCount('close'),0);});
for(const request of [{method:'GET'},{url:'/api/commands/other'},{url:'/other/api/commands/execute'}])await test('unrelated-request-bypasses-scope-'+JSON.stringify(request),async()=>{const f=fixture(request);await f.run(async()=>sleep(12));assert.equal(f.response.pulses,0);});
await test('ordinary-command-on-same-endpoint-has-no-opt-in',async()=>{const f=fixture();await f.scope.handle(f.request,f.response,async()=>sleep(15));assert.equal(f.response.pulses,0);});
await test('concurrent-requests-do-not-share-response-state',async()=>{const a=fixture(),b=fixture();await Promise.all([a.run(async()=>{await sleep(8);a.response.emit('close');}),b.run(async()=>sleep(30))]);assert.ok(b.response.pulses>a.response.pulses);});
await test('scope-disposal-stops-active-and-future-pulses',async()=>{const f=fixture();await f.run(async()=>{await sleep(10);f.scope.dispose();const n=f.response.pulses;await sleep(18);assert.equal(f.response.pulses,n);});const n=f.response.pulses;await f.run(()=>null);assert.equal(f.response.pulses,n);});
await test('native-compact-wrapper-retains-identity-and-outcome',async()=>{const f=fixture();const result={kind:'success',text:'done',sourceEventSeq:9};const definition=decorateCompactCommand({name:'compact',definitionId:'native',handler:async i=>{assert.equal(i,f.invocation);await sleep(15);return result;}});assert.equal(await f.scope.handle(f.request,f.response,()=>definition.handler(f.invocation)),result);assert.ok(f.response.pulses>0);assert.equal(definition.definitionId,'native');});
await test('non-compact-definition-remains-untouched',()=>{const d={name:'other',handler(){}};assert.equal(decorateCompactCommand(d),d);});
console.log(JSON.stringify({passed:rows.filter(r=>r.pass).length,failed:rows.filter(r=>!r.pass).length,results:rows},null,2));
if(rows.some(r=>!r.pass))process.exitCode=1;
