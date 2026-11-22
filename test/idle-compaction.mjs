import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {idleResumeDue} from '../lib/idle-compaction.js';
import {WeaveCompactionEngine} from '../lib/engine.js';
import {resolveConfig} from '../lib/config.js';

const rows=[];
async function test(name,fn){try{await fn();rows.push({name,pass:true});}catch(error){rows.push({name,pass:false,error:error.message,stack:error.stack});}}
const MINUTE=60000, now=100*MINUTE;
const input={id:'new-user',role:'user',source:{kind:'user'},content:[{type:'text',text:'Continue with the current file.'}]};
const event=(type,time,data={})=>({type,time,data});
const user=(time,id='old-user',kind='user')=>event('user/message',time,{id,role:'user',source:{kind},content:[{type:'text',text:'Earlier instruction.'}]});
const assistant=time=>event('assistant/message',time,{message:{id:'reply',role:'assistant',source:{kind:'model'},content:[{type:'text',text:'Earlier response.'}]}});
const arrival=(time,messages=[input])=>event('agent/inbox/spliced',time,{target:'next-turn',start:0,inserted:messages});
function session(events){
  const log=events.map((e,seq)=>({...e,seq}));
  return {id:'idle-fixture',seq:log.length,eventAt:seq=>log[seq],surface:{nodes:log.filter(e=>e.type.endsWith('/message')).map(e=>e.seq)}};
}
const resumed=(last=now-31*MINUTE)=>session([user(last-10),assistant(last),event('turn/end',last+1),arrival(now),event('turn/start',now,{turn:2})]);

await test('strict-threshold-and-disabled',()=>{
  assert.equal(idleResumeDue(resumed(),[input],0,now),null);
  assert.equal(idleResumeDue(resumed(now-30*MINUTE),[input],30,now),null);
  assert.equal(idleResumeDue(resumed(now-29*MINUTE),[input],30,now),null);
  assert.equal(idleResumeDue(resumed(),[input],30,now).elapsedMs,31*MINUTE);
});
await test('only-real-new-user-input',()=>{
  for(const messages of [[],[{...input,role:'tool'}],[{...input,source:{kind:'runtime-context'}}],[{...input,source:{kind:'agent-message'}}],[{...input,source:{kind:'compact-checkpoint'}}]])assert.equal(idleResumeDue(resumed(),messages,30,now),null);
  assert.ok(idleResumeDue(resumed(),[{...input,source:undefined}],30,now));
});
await test('new-conversation-never-compacts',()=>{
  assert.equal(idleResumeDue(session([arrival(now),event('turn/start',now)]),[input],30,now),null);
});
await test('missing-or-invalid-arrival-does-not-guess-from-wall-clock',()=>{
  for(const time of [undefined,null,'2000',NaN,Infinity,-1,now+1]){
    assert.equal(idleResumeDue(session([assistant(0),arrival(time),event('turn/start',now)]),[input],30,now),null);
  }
  assert.equal(idleResumeDue(session([assistant(0),event('turn/start',now)]),[input],30,now),null);
  assert.equal(idleResumeDue(resumed(),[{...input,id:undefined}],30,now),null);
});
await test('last-assistant-and-tool-time-reset-conversation-gap',()=>{
  for(const type of ['assistant/message','tool/result','tool/call']){
    const s=session([user(now-60*MINUTE),event(type,now-MINUTE),arrival(now),event('turn/start',now)]);
    assert.equal(idleResumeDue(s,[input],30,now),null);
  }
});
await test('first-step-only-and-no-open-turn',()=>{
  for(const tail of ['step/start','assistant/message','tool/result','tool/call','turn/end']){
    const s=session([user(0),event('turn/start',MINUTE),event(tail,2*MINUTE),arrival(now)]);
    assert.equal(idleResumeDue(s,[input],30,now),null);
  }
  assert.equal(idleResumeDue(session([user(0),arrival(now)]),[input],30,now),null);
});
await test('startup-reminders-and-model-selection-do-not-refresh-clock',()=>{
  const s=session([user(0),assistant(MINUTE),event('session/end-seed',now),user(now,'reminder','time-context'),event('model/selected',now),arrival(now),event('turn/start',now)]);
  assert.equal(idleResumeDue(s,[input],30,now).lastActivityAt,MINUTE);
});
await test('invalid-last-activity-does-not-fall-back-to-older-time',()=>{
  for(const t of [undefined,null,'2000',NaN,Infinity,-1,now+1]){
    const s=session([user(0),assistant(t),arrival(now),event('turn/start',now)]);
    assert.equal(idleResumeDue(s,[input],30,now),null);
  }
});
await test('time-spent-waiting-in-inbox-does-not-trigger',()=>{
  const s=session([assistant(MINUTE),arrival(2*MINUTE),event('turn/start',now)]);
  assert.equal(idleResumeDue(s,[input],30,now),null);
  const queuedWhileBusy=session([user(0),arrival(2*MINUTE),assistant(3*MINUTE),event('turn/end',4*MINUTE),event('turn/start',now)]);
  assert.equal(idleResumeDue(queuedWhileBusy,[input],30,now),null);
});
await test('requeue-keeps-original-arrival-time-across-failed-turns',()=>{
  const s=session([assistant(MINUTE),arrival(2*MINUTE),event('turn/start',2*MINUTE),
    event('agent/inbox/spliced',2*MINUTE,{target:'next-turn',start:0,removedCount:1,inserted:[]}),
    arrival(50*MINUTE),event('turn/end',50*MINUTE),event('turn/start',now)]);
  assert.equal(idleResumeDue(s,[input],30,now),null);
});
await test('earliest-input-in-a-batch-bounds-idle-time',()=>{
  const other={...input,id:'other'};
  const s=session([assistant(MINUTE),arrival(2*MINUTE,[input]),arrival(now,[other]),event('turn/start',now)]);
  assert.equal(idleResumeDue(s,[input,other],30,now),null);
});
await test('successful-compaction-without-new-work-is-not-repeated',()=>{
  const events=[user(0),event('compaction/end',2*MINUTE,{compactionId:'weave-previous'}),arrival(now),event('turn/start',now)];
  assert.equal(idleResumeDue(session(events),[input],30,now),null);
  events[1].data.error='failed';assert.ok(idleResumeDue(session(events),[input],30,now));
  events[1].data.error=undefined;events.splice(2,0,assistant(3*MINUTE));assert.ok(idleResumeDue(session(events),[input],30,now));
});
await test('partial-compaction-does-not-hide-a-later-failure',()=>{
  const s=session([user(0),event('compaction/end',MINUTE),event('compaction/end',2*MINUTE,{error:'failed second chunk'}),arrival(now),event('turn/start',now)]);
  assert.ok(idleResumeDue(s,[input],30,now));
});
await test('reopened-session-has-the-same-decision-without-process-state',()=>{
  const a=resumed(), b=session(Array.from({length:a.seq},(_,i)=>JSON.parse(JSON.stringify(a.eventAt(i)))));
  assert.deepEqual(idleResumeDue(a,[input],30,now),idleResumeDue(b,[input],30,now));
});
await test('recent-and-exact-threshold-history-stop-at-latest-activity',()=>{
  for(const gap of [MINUTE,30*MINUTE]){
    const s=session([...Array.from({length:10000},()=>assistant(0)),assistant(now-gap),event('turn/end',now-gap),arrival(now),event('turn/start',now)]);
    let reads=0;const read=s.eventAt;s.eventAt=seq=>{reads++;return read(seq);};
    assert.equal(idleResumeDue(s,[input],30,now),null);assert.equal(reads,4);
  }
});
await test('expired-latest-arrival-still-checks-original-requeue-time',()=>{
  const s=session([assistant(MINUTE),arrival(2*MINUTE),event('turn/start',2*MINUTE),event('turn/end',3*MINUTE),arrival(now),event('turn/start',now)]);
  assert.equal(idleResumeDue(s,[input],30,now),null);
});
await test('short-gap-does-not-require-old-missing-arrivals-to-prove-no-trigger',()=>{
  const other={...input,id:'not-found'},s=session([assistant(now-MINUTE),arrival(now),event('turn/start',now)]);
  assert.equal(idleResumeDue(s,[input,other],30,now),null);
});

async function fixture({auto=false,minutes=30}={}){
  const hooks=new Map(),ctx={provide(){},on:(name,fn)=>hooks.set(name,fn),logger:{info(){},warn(){}}};
  const engine=new WeaveCompactionEngine(ctx,{...resolveConfig({auto,archiveDir:join(await mkdtemp(join(tmpdir(),'weave-idle-')),'archive')}).config,idleCompactionMinutes:minutes});
  const t=Date.now(),s=session([user(t-32*MINUTE),assistant(t-31*MINUTE),arrival(t),event('turn/start',t,{turn:2})]);
  const inbox={nextStep:[],nextTurn:[],prepend(target,message){assert.equal(target,'next-step');this.nextStep.unshift(message);}};
  const agent={session:s,inbox},controller=new AbortController(),calls=[];
  engine.recoverPending=async()=>({recovered:0});
  engine._guardRequestBudget=async()=>calls.push('guard');
  engine.compactIfNeeded=async()=>{calls.push('pressure');return null;};
  engine._compactManual=async(...args)=>{calls.push('idle');assert.equal(args[4],true);assert.deepEqual(args[5],{idle:true});return {compactionId:'test'};};
  return {engine,agent,controller,calls,async call(messages=[input]){return hooks.get('agent/pre-step')({agent,signal:controller.signal,messages},async()=>{calls.push('main');return {kind:'enter'};});}};
}
await test('idle-independent-of-pressure-auto-and-awaited-before-main',async()=>{
  const f=await fixture();let release;
  f.engine._compactManual=async()=>{f.calls.push('idle-start');await new Promise(r=>release=r);f.calls.push('idle-end');return {compactionId:'test'};};
  const pending=f.call();await new Promise(r=>setTimeout(r,10));assert.deepEqual(f.calls,['idle-start']);release();await pending;
  assert.deepEqual(f.calls,['idle-start','idle-end','guard','main']);
});
await test('pressure-can-still-run-after-idle',async()=>{
  const f=await fixture({auto:true});await f.call();assert.deepEqual(f.calls,['idle','pressure','guard','main']);
});
await test('disabled-idle-preserves-old-hook-behavior',async()=>{
  const f=await fixture({minutes:0});await f.call();assert.deepEqual(f.calls,['main']);
});
await test('idle-failure-blocks-and-restores-input-once-in-order',async()=>{
  const f=await fixture(),second={...input,id:'second'};f.engine._compactManual=async()=>{throw Object.assign(new Error('bad summary'),{code:'CONSTRAINT_LOST'});};
  const old=f.agent.session;
  f.agent.session=session([...Array.from({length:old.seq-1},(_,i)=>old.eventAt(i)),arrival(Date.now(),[second]),old.eventAt(old.seq-1)]);
  await assert.rejects(f.call([input,second]),e=>e.code==='COMPACTION_AUTOMATIC_BLOCKED');
  await assert.rejects(f.call([input,second]));assert.deepEqual(f.agent.inbox.nextStep,[input,second]);assert.deepEqual(f.calls,[]);
});
await test('idle-cancellation-keeps-claimed-input-and-does-not-count-as-failure',async()=>{
  const f=await fixture(),error=Object.assign(new Error('cancelled'),{name:'AbortError'});
  f.engine._compactManual=async()=>{f.controller.abort(error);throw error;};
  await assert.rejects(f.call(),e=>e===error);assert.deepEqual(f.agent.inbox.nextStep,[input]);assert.equal(f.engine._failures.get(f.agent.session.id)??0,0);assert.deepEqual(f.calls,[]);
});
await test('cancellation-after-compaction-during-budget-check-retains-input',async()=>{
  const f=await fixture(),error=Object.assign(new Error('cancel at request gate'),{name:'AbortError'});
  f.engine._guardRequestBudget=async()=>{f.controller.abort(error);throw error;};
  await assert.rejects(f.call(),e=>e===error);assert.deepEqual(f.agent.inbox.nextStep,[input]);assert.deepEqual(f.calls,['idle']);
});
await test('silent-cancellation-during-final-check-cannot-enter-main',async()=>{
  const f=await fixture(),error=Object.assign(new Error('cancel at request gate'),{name:'AbortError'});
  f.engine._guardRequestBudget=async()=>{f.controller.abort(error);};
  await assert.rejects(f.call(),e=>e===error);assert.deepEqual(f.agent.inbox.nextStep,[input]);assert.deepEqual(f.calls,['idle']);
});
await test('idle-honors-persisted-breaker-without-new-summary-call',async()=>{
  const f=await fixture();f.engine.sessionState.update(f.agent.session.id,s=>({...s,failures:3,stopped:true}));
  await f.call();assert.deepEqual(f.calls,['guard','main']);assert.equal(f.agent.inbox.nextStep.length,0);
});
await test('no-shrinkable-history-allows-main-after-budget-check',async()=>{
  const f=await fixture();f.engine._compactManual=async()=>null;await f.call();assert.deepEqual(f.calls,['guard','main']);
});
console.log(JSON.stringify({passed:rows.filter(r=>r.pass).length,failed:rows.filter(r=>!r.pass).length,results:rows},null,2));
if(rows.some(r=>!r.pass))process.exitCode=1;
