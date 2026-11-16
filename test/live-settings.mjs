import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {apply as mountEngine} from '../lib/engine-entry.js';
import {apply as mountGate} from '../lib/index.js';
import {defaultSummaryConfigPath, handleSummaryConfigRpc} from '../lib/summary-config.js';
import {MAX_IDLE_COMPACTION_MINUTES} from '../lib/config.js';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({name, pass:true}); }
  catch (error) { results.push({name, pass:false, error:error.message, stack:error.stack}); }
}
const root = mkdtempSync(join(tmpdir(), 'weave-live-settings-'));
let count = 0;
function fixture(base = {}, home) {
  process.env.DSH_HOME = home ?? join(root, String(++count));
  const file = defaultSummaryConfigPath(), hooks = new Map(), services = new Map();
  const ctx = {on:(name, fn) => hooks.set(name, fn), provide:(name, value) => services.set(name, value), logger:{info(){},warn(){}}};
  const dispose = mountEngine(ctx, {auto:false, archiveDir:join(process.env.DSH_HOME, 'archive'), ...base});
  const engine = services.get('compaction');
  engine.recoverPending = async () => ({recovered:0});
  engine._guardRequestBudget = async () => {};
  const set = async params => {
    const result = await handleSummaryConfigRpc({method:'set', params}, file);
    assert.equal(result.restartRequired, false);
    return result;
  };
  const peek = () => engine._withConfig(() => engine.config);
  return {engine, hooks, file, set, peek, dispose};
}
function userTurn(id, ageMinutes = 31) {
  const now = Date.now();
  const input = {id:`new-${id}`, role:'user', source:{kind:'user'}, content:[{type:'text', text:'Continue.'}]};
  const events = [
    {type:'assistant/message', time:now-ageMinutes*60000, data:{}},
    {type:'turn/end', time:now-ageMinutes*60000, data:{}},
    {type:'agent/inbox/spliced', time:now, data:{inserted:[input]}},
    {type:'turn/start', time:now, data:{turn:2}},
  ].map((e,seq) => ({...e,seq}));
  const session = {id,seq:events.length,eventAt:seq=>events[seq],surface:{nodes:[]}};
  const inbox = {nextStep:[],nextTurn:[],prepend(_,message){this.nextStep.unshift(message);}};
  return {agent:{session,inbox},signal:new AbortController().signal,messages:[input]};
}
const priorHome = process.env.DSH_HOME;
try {
  await test('existing-engine-enables-disables-and-changes-idle-without-restart', async () => {
    const f=fixture(); let summaries=0, main=0;
    f.engine._compactManual=async()=>{summaries++;return {compactionId:'fixture'};};
    const step=()=>f.hooks.get('agent/pre-step')(userTurn(`idle-${main}`),async()=>{main++;});
    try {
      await step(); assert.equal(summaries,0);
      await f.set({idleCompactionMinutes:30}); await step(); assert.equal(summaries,1);
      await f.set({idleCompactionMinutes:43200}); await step(); assert.equal(summaries,1);
      await f.set({idleCompactionMinutes:0}); await step(); assert.equal(summaries,1); assert.equal(main,4);
    } finally { f.dispose(); }
  });
  await test('all-panel-fields-refresh-on-the-same-engine', async () => {
    const f=fixture();
    try {
      await f.set({provider:'provider',model:'summary',maxTokens:2048,thresholdRatio:.9,minimumReductionRatio:.3,summaryRetryCount:0,summaryRetryDelayMs:0,summaryTimeoutMs:9000,idleCompactionMinutes:17});
      const c=f.peek();
      for(const [key,value] of Object.entries({summarizationProvider:'provider',summarizationModel:'summary',maxTokens:2048,thresholdRatio:.9,minimumReductionRatio:.3,summaryRetryCount:0,summaryRetryDelayMs:0,summaryTimeoutMs:9000,idleCompactionMinutes:17}))assert.equal(c[key],value,key);
    } finally {f.dispose();}
  });
  await test('clearing-model-restores-original-inherited-config-not-saved-model', async () => {
    const f=fixture({summarizationProvider:'base',summarizationModel:'original',maxTokens:3000,thresholdRatio:.85});
    try {
      await f.set({provider:'override',model:'new',maxTokens:5000,idleCompactionMinutes:30,thresholdRatio:.9});
      assert.equal(f.peek().summarizationModel,'new');
      await f.set({provider:'',model:'',maxTokens:null,thresholdRatio:null});
      const c=f.peek(); assert.equal(c.summarizationProvider,'base'); assert.equal(c.summarizationModel,'original');
      assert.equal(c.maxTokens,3000); assert.equal(c.thresholdRatio,.85); assert.equal(c.idleCompactionMinutes,30);
    } finally {f.dispose();}
  });
  await test('gate-does-not-bake-saved-model-into-inherited-row', async () => {
    const f=fixture();
    try {
      await f.set({provider:'saved',model:'old',idleCompactionMinutes:30});
      const hooks=new Map();
      mountGate({on:(name,fn)=>hooks.set(name,fn),provide(){}},{engine:{archiveDir:join(root,'gate-archive')},receiptPath:join(root,'receipts.jsonl')});
      const row=hooks.get('internal/config')({},()=>({plugins:[{name:'@deepseek-ai/dsh-compaction-basic',config:{thresholdRatio:.85}}]})).plugins[0];
      assert.equal(row.name,'dsh-compaction-weave/engine'); assert.equal(row.config.summarizationModel,undefined);
      const g=fixture(row.config,process.env.DSH_HOME);
      try { assert.equal(g.peek().summarizationModel,'old'); await g.set({provider:'',model:''}); assert.equal(g.peek().summarizationModel,null); }
      finally {g.dispose();}
    } finally {f.dispose();}
  });
  await test('concurrent-session-and-nested-retry-keep-their-own-config-snapshot', async () => {
    const f=fixture(); let release, started;
    const entered=new Promise(resolve=>started=resolve), barrier=new Promise(resolve=>release=resolve);
    f.engine._compactIfNeededInner=async agent=>{
      const before=f.engine.config.summarizationModel;
      if(agent.session.id==='old'){started();await barrier;}
      const nested=await f.engine.compactRegion(0,1,agent);
      return [before,f.engine.config.summarizationModel,nested];
    };
    f.engine._compactRegionInner=async()=>f.engine.config.summarizationModel;
    try {
      await f.set({provider:'p',model:'old'});
      const old=f.engine.compactIfNeeded({session:{id:'old'}},'pressure'); await entered;
      await f.set({provider:'p',model:'new'});
      assert.deepEqual(await f.engine.compactIfNeeded({session:{id:'new'}},'pressure'),['new','new','new']);
      release(); assert.deepEqual(await old,['old','old','old']);
      assert.equal(f.peek().summarizationModel,'new');
    } finally {release?.();f.dispose();}
  });
  await test('pre-step-and-main-gate-share-snapshot-while-new-operation-sees-save', async () => {
    const f=fixture(); let entered, release;
    const ready=new Promise(resolve=>entered=resolve), barrier=new Promise(resolve=>release=resolve);
    f.engine._compactManual=async()=>{entered();await barrier;assert.equal(f.engine.config.idleCompactionMinutes,30);return {compactionId:'fixture'};};
    try {
      await f.set({idleCompactionMinutes:30});
      const pending=f.hooks.get('agent/pre-step')(userTurn('pending'),async()=>f.engine.config.idleCompactionMinutes);
      await ready; await f.set({idleCompactionMinutes:0}); assert.equal(f.peek().idleCompactionMinutes,0);
      release(); assert.equal(await pending,30);
      assert.equal(await f.hooks.get('agent/pre-step')(userTurn('next'),async()=>f.engine.config.idleCompactionMinutes),0);
    } finally {release?.();f.dispose();}
  });
  for(const entry of ['compactIfNeeded','compactNow','compactRegion'])await test(`${entry}-refreshes-at-public-entry`,async()=>{
    const f=fixture();
    f.engine._compactIfNeededInner=f.engine._compactNowInner=f.engine._compactRegionInner=async()=>f.engine.config.idleCompactionMinutes;
    try {await f.set({idleCompactionMinutes:43200});const agent={session:{id:entry}}; assert.equal(await(entry==='compactRegion'?f.engine[entry](0,1,agent):f.engine[entry](agent)),43200);}
    finally {f.dispose();}
  });
  await test('overflow-hook-and-reactive-hook-refresh-before-delegating',async()=>{
    const f=fixture({auto:true}), payload=userTurn('hooks');
    try {
      await f.set({idleCompactionMinutes:43200});
      assert.equal(await f.hooks.get('agent/request-error')({...payload,failure:{code:'other'}},async()=>f.engine.config.idleCompactionMinutes),43200);
      await f.set({idleCompactionMinutes:5});
      assert.equal(await f.hooks.get('compaction/summary-error')({},async()=>f.engine.config.idleCompactionMinutes),5);
    }finally{f.dispose();}
  });
  await test('month-cap-invalid-save-preserves-last-valid-config',async()=>{
    const f=fixture();
    try {assert.equal(MAX_IDLE_COMPACTION_MINUTES,43200);await f.set({idleCompactionMinutes:43200});await assert.rejects(f.set({idleCompactionMinutes:43201}),e=>e.code==='INVALID_IDLE_COMPACTION_MINUTES');assert.equal(f.peek().idleCompactionMinutes,43200);}
    finally{f.dispose();}
  });
  await test('invalid-inherited-combination-keeps-claimed-input',async()=>{
    const f=fixture({thresholdRatio:.85,modelPolicies:[{provider:'p',model:'m',retainRatio:.6}]}),payload=userTurn('invalid');let main=0;
    try {await f.set({thresholdRatio:.5});await assert.rejects(async()=>f.hooks.get('agent/pre-step')(payload,async()=>{main++;}),/retainRatio/);assert.equal(main,0);assert.deepEqual(payload.agent.inbox.nextStep,payload.messages);}
    finally{f.dispose();}
  });
  await test('multiple-engines-observe-same-save-with-independent-base-configs',async()=>{
    const a=fixture({thresholdRatio:.85}), b=fixture({thresholdRatio:.9},process.env.DSH_HOME);
    try {await a.set({idleCompactionMinutes:30});assert.equal(a.peek().idleCompactionMinutes,30);assert.equal(b.peek().idleCompactionMinutes,30);assert.equal(a.peek().thresholdRatio,.85);assert.equal(b.peek().thresholdRatio,.9);}
    finally{a.dispose();b.dispose();}
  });
  await test('corrupt-settings-block-request-preserve-input-and-recover-after-save',async()=>{
    const f=fixture(),payload=userTurn('corrupt');let main=0;
    try{
      await f.set({provider:'chosen',model:'summary',idleCompactionMinutes:30});assert.equal(f.peek().summarizationModel,'summary');
      writeFileSync(f.file,'{"version":');
      await assert.rejects(async()=>f.hooks.get('agent/pre-step')(payload,async()=>{main++;}),e=>e.code==='INVALID_SAVED_SETTINGS');
      assert.equal(main,0);assert.deepEqual(payload.agent.inbox.nextStep,payload.messages);assert.equal(f.engine.config.summarizationModel,'summary');
      await f.set({provider:'chosen',model:'repaired',idleCompactionMinutes:0});
      await f.hooks.get('agent/pre-step')(payload,async()=>{main++;});assert.equal(main,1);assert.equal(f.peek().summarizationModel,'repaired');
    }finally{f.dispose();}
  });
  await test('invalid-persisted-values-never-clear-live-override',async()=>{
    const f=fixture();
    try{
      await f.set({provider:'chosen',model:'summary'});assert.equal(f.peek().summarizationModel,'summary');
      for(const value of [null,[],{version:99},{idleCompactionMinutes:43201},{maxTokens:'bad'},{thresholdRatio:3},{summarizationProvider:'one-sided'},{summarizationProvider:17,summarizationModel:18}]){
        writeFileSync(f.file,JSON.stringify(value));assert.throws(()=>f.peek(),e=>e.code==='INVALID_SAVED_SETTINGS');
        assert.equal(f.engine.config.summarizationModel,'summary');
      }
    }finally{f.dispose();}
  });
  await test('missing-settings-restores-inherited-values',async()=>{
    const f=fixture({idleCompactionMinutes:60});
    try{await f.set({idleCompactionMinutes:30});assert.equal(f.peek().idleCompactionMinutes,30);unlinkSync(f.file);assert.equal(f.peek().idleCompactionMinutes,60);}
    finally{f.dispose();}
  });
  await test('damaged-settings-at-mount-can-be-repaired-without-remounting',async()=>{
    const f=fixture();let g;
    try{
      await f.set({idleCompactionMinutes:30});writeFileSync(f.file,'{broken');
      g=fixture({},process.env.DSH_HOME);assert.ok(g.engine);
      assert.throws(()=>g.peek(),e=>e.code==='INVALID_SAVED_SETTINGS');
      await g.set({idleCompactionMinutes:43200});assert.equal(g.peek().idleCompactionMinutes,43200);
    }finally{g?.dispose();f.dispose();}
  });
} finally {
  if(priorHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=priorHome;
}
console.log(JSON.stringify({passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,results},null,2));
if(results.some(x=>!x.pass))process.exitCode=1;
