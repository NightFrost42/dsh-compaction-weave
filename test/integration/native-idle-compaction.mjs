// Real host Session, persistence and stock transaction adapter; injected summary
// responses. This is not a provider call or a desktop end-to-end acceptance run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {StockTransactionAdapter} from '../../lib/transaction.js';
import {WeaveCompactionEngine} from '../../lib/engine.js';
import {resolveConfig} from '../../lib/config.js';
import {approxTokens,blocksToText} from '../../lib/meter.js';
import {measureSummaryRange} from '../../lib/summary-budget.js';
import {selectCompactableRange} from '../../lib/region.js';
import {apply as mountEngine} from '../../lib/engine-entry.js';
import {defaultSummaryConfigPath,handleSummaryConfigRpc} from '../../lib/summary-config.js';

const load=file=>import(pathToFileURL(path.join(process.env.DSH_TEST_NODE_MODULES,file)));
const {Context}=await load('@deepseek-ai/cordis/lib/index.js');
const {Session,SessionStore}=await load('@deepseek-ai/dsh-session/lib/index.js');
const persistence=await load('@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js');
const results=[];
async function test(name,fn){try{await fn();results.push({name,pass:true});}catch(error){results.push({name,pass:false,error:error.message,stack:error.stack});}}
const summary=['Primary Request and Intent','Key Technical Concepts','Files and Code Sections','Errors and Fixes','Problem Solving','All User Messages','Pending Tasks','Work Completed','Context for Continuing Work'].map((h,i)=>`## ${i+1}. ${h}\n${i===0?'Continue the test task.':i===5?'[filled by engine]':'(none)'}`).join('\n\n');
const message=(role,text,kind)=>({id:randomUUID(),role,source:{kind:kind??(role==='user'?'user':role==='system'?'system-prompt':'model'),...(role==='assistant'?{provider:'p',model:'m'}:{})},content:[{type:'text',text}]});

async function fixture({minutes=30,small=false,fail=false,closedTools=false,userOnly=false,limitedPrefix=false,hugeRequirement=false,live=false}={}){
  const directory=fs.mkdtempSync(path.join(process.env.WEAVE_TEST_ROOT,'test-tmp','idle-host-'));
  const seed=Session.create('idle-'+randomUUID());
  const add=(role,text,kind)=>seed.append(role+'/message',role==='user'?message(role,text,kind):{message:message(role,text,kind),turn:1,step:1,...(role==='assistant'?{stream:[],usage:{inputTokens:0,outputTokens:0}}:{})},{surfaceOp:'append'});
  seed.append('turn/start',{turn:1});seed.append('step/start',{turn:1,step:1});
  add('system','Stable system prefix.');
  if(limitedPrefix){
    add('user','Do not delete original files.\n'+'rawdata '.repeat(1000));
    add('assistant','Historical observation. '.repeat(2000));
    add('user','Here is the rest of the earlier material.');
  }else if(hugeRequirement){
    add('user','Do not delete the following record: '+'A'.repeat(6000)+'.');
    add('assistant','Ready.');
  }else{
    add('user','Timeout must be 55 seconds.');
    if(userOnly)add('user','Please review these observations:\n'+'observation '.repeat(900));
    else if(!small)add('user','Earlier reference material. '.repeat(2200),'runtime-context');
    add('assistant',small||userOnly?'Ready.':'Evidence note. '.repeat(2400));
  }
  if(closedTools){
    const callId=randomUUID();
    seed.append('assistant/message',{message:{...message('assistant',''),content:[{type:'tool-call',name:'read_file',callId,arguments:{path:'example.js'}}]},turn:1,step:1,stream:[],usage:{inputTokens:0,outputTokens:0}},{surfaceOp:'append'});
    const call=seed.append('tool/call',{turn:1,step:1,callId,name:'read_file',arguments:{path:'example.js'}});
    seed.append('tool/result',{turn:1,step:1,message:{id:randomUUID(),role:'tool',source:{kind:'tool',callId},toolCallId:callId,content:[{type:'text',text:'const value = 55;'}],isError:false}},{surfaceOp:'append',sourceEventSeqs:[call.seq]});
  }
  seed.append('step/end',{turn:1,step:1});seed.append('turn/end',{turn:1});
  const oldTime=Date.now()-31*60000;
  const session=Session.create(seed.id,seed.snapshotEvents().map(e=>({...e,time:oldTime})),seed.header);
  const root=new Context();
  const mounting=root.plugin({name:'weave-idle-fixture',async apply(ctx){new SessionStore(ctx);await persistence.apply(ctx,{root:path.join(directory,'host-sessions'),compression:'none'});}});
  await mounting.await();
  const store=root.sessions,backend=root.sessionPersistence,handle=await backend.create(session.header);
  await handle.append(session.snapshotEvents());
  const detach=store.enter(session);store.announce(session);await store.flush(session);
  const hooks=new Map();let calls=0,mainCalls=0;
  let engine;
  const ctx={provide(name,value){if(name==='compaction')engine=value;},on:(name,fn)=>hooks.set(name,fn),logger:{info(){},warn(){}},sessions:{flush:s=>store.flush(s)},
    tokenMeter:{measure(s){const nodes=s.surface.nodes.map(seq=>({seq,tokens:approxTokens(blocksToText(s.deriveEventMessage(s.eventAt(seq))?.content))}));return {nodes,totalTokens:nodes.reduce((n,x)=>n+x.tokens,0)};}},
    llm:{async resolveModelInfo(){return {contextWindow:1000000};},async *stream(){calls++;if(fail)throw Object.assign(new Error('injected provider failure'),{code:'AUTHENTICATION_FAILED'});yield {type:'text-delta',text:summary};yield {type:'finish',kind:'stop'};}}};
  const rawConfig={auto:false,idleCompactionMinutes:minutes,archiveDir:path.join(directory,'weave','archive'),language:'en',summaryRetryCount:0,compactionRetries:0};
  let settingsPath;
  if(live){
    const previousHome=process.env.DSH_HOME;
    process.env.DSH_HOME=path.join(directory,'settings-home');
    try{settingsPath=defaultSummaryConfigPath();mountEngine(ctx,rawConfig);}
    finally{if(previousHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previousHome;}
  }else engine=new WeaveCompactionEngine(ctx,resolveConfig(rawConfig).config);
  const adapter=new StockTransactionAdapter(backend,store,ctx.logger);adapter.register(engine.journal,engine.sessionState,engine.config.failureThreshold);
  engine.transactionAdapter=adapter;engine.requireTransactionAdapter=true;engine.historyToolsAvailable=true;
  const pending=[];
  const agent={session,options:{provider:'p',model:'m'},inbox:{get nextStep(){return pending;},nextTurn:[],prepend(target,m){assert.equal(target,'next-step');pending.unshift(m);session.append('agent/inbox/spliced',{target,start:0,inserted:[m]});}}};
  const incoming=message('user','Continue using the current file; change the timeout to 75 seconds.');
  session.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[incoming]});
  session.append('turn/start',{turn:2});
  session.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]});
  const original=[...session.surface.nodes];
  return {session,engine,original,incoming,agent,store,backend,adapter,hooks,calls:()=>calls,mainCalls:()=>mainCalls,
    async setSettings(params){return handleSummaryConfigRpc({method:'set',params},settingsPath);},
    async run(){return hooks.get('agent/pre-step')({agent,signal:new AbortController().signal,messages:[incoming]},async()=>{mainCalls++;assert.ok(!session.snapshotEvents().some(e=>e.type==='user/message'&&e.data.id===incoming.id),'new input is not part of the summarized history');return {kind:'enter',messages:[incoming]};});},
    async close(){engine.dispose();adapter.dispose();detach();await handle.close();await mounting.dispose();}};
}

await test('resume-compacts-before-new-input-with-durable-archive-and-reopen',async()=>{
  const f=await fixture();
  try{
    const decision=await f.run();assert.equal(f.calls(),1);assert.equal(f.mainCalls(),1);assert.deepEqual(decision.messages,[f.incoming]);
    const checkpoint=f.session.surface.nodes.map(seq=>f.session.eventAt(seq)).find(e=>e.data?.source?.kind==='compact-checkpoint');assert.ok(checkpoint);
    const text=JSON.stringify(checkpoint.data.content);assert.match(text,/55 seconds/);assert.doesNotMatch(text,/75 seconds/);
    const archived=await f.engine.archive.readSpan(f.session.id,checkpoint.data.source.compactionId);assert.ok(archived.ok);
    assert.ok(archived.entries.some(e=>e.seq===f.original[1]));
    // Commit the claimed input only after compaction, as the host step does.
    f.session.append('step/start',{turn:2,step:1});f.session.append('user/message',f.incoming,{surfaceOp:'append'});
    f.session.append('step/end',{turn:2,step:1});f.session.append('turn/end',{turn:2});await f.store.flush(f.session);
    const stored=await f.backend.readStoredLog(f.backend.locate(f.session.header).path,f.session.id);
    assert.deepEqual(stored.events,f.session.snapshotEvents());
    const reopened=Session.fromRestore(f.session.id,stored.events,stored.meta,stored.inheritedEventCount,'detached',f.store.messageProjections);
    assert.deepEqual(reopened.surface.nodes,f.session.surface.nodes);
    assert.equal(reopened.eventAt(reopened.surface.nodes.at(-1)).data.id,f.incoming.id);
    assert.equal((await f.engine.journal.pending(f.session.id)).length,0);
  }finally{await f.close();}
});
await test('short-history-is-noop-without-summary-or-failure-budget',async()=>{
  const f=await fixture({small:true});try{await f.run();assert.equal(f.calls(),0);assert.equal(f.mainCalls(),1);assert.deepEqual(f.session.surface.nodes,f.original);assert.equal(f.engine.sessionState.read(f.session.id).failures,0);}finally{await f.close();}
});
await test('short-history-does-not-need-summary-capacity-to-skip',async()=>{
  const f=await fixture({small:true});try{
    f.engine.config={...f.engine.config,maxTokens:1024};
    f.engine.ctx.llm.resolveModelInfo=async()=>({contextWindow:4096});
    await f.run();assert.equal(f.calls(),0);assert.equal(f.mainCalls(),1);assert.deepEqual(f.session.surface.nodes,f.original);assert.equal(f.engine.sessionState.read(f.session.id).failures,0);
  }finally{await f.close();}
});
await test('user-only-verbatim-floor-can-use-continuation-at-idle',async()=>{
  const f=await fixture({userOnly:true});try{
    let calls=0;
    f.engine.config={...f.engine.config,preserveRecentUserTokens:100000};
    const range=selectCompactableRange(f.session,await f.engine._measure(f.session),0);
    const size=measureSummaryRange(f.session,range,{policy:f.engine.config,language:'en'});
    assert.ok(size.minimumCheckpointBytes>=size.sourceBytes,JSON.stringify(size));
    f.engine.ctx.llm.stream=async function*(){calls++;yield {type:'text-delta',text:'## Goal\nContinue the task.\n## State\nEarlier evidence is archived.\n## Next\nReview the current request.\n## Uncertain\nFurther work needs verification.'};yield {type:'finish',kind:'stop'};};
    await f.run();assert.ok(calls>0);assert.equal(f.mainCalls(),1);
    const checkpoint=f.session.surface.nodes.map(seq=>f.session.eventAt(seq)).find(e=>e.data?.source?.continuation?.version===1);assert.ok(checkpoint);
    assert.match(JSON.stringify(checkpoint.data.content),/55 seconds/);assert.doesNotMatch(JSON.stringify(checkpoint.data.content),/75 seconds/);
    assert.equal(f.engine.sessionState.read(f.session.id).failures,0);
  }finally{await f.close();}
});
await test('capacity-limited-prefix-can-fall-back-to-continuation',async()=>{
  const f=await fixture({limitedPrefix:true});try{
    let calls=0;
    f.engine.config={...f.engine.config,summaryInputMaxBytes:30000,continuationMemoryBytes:2048};
    f.engine.ctx.llm.stream=async function*(){calls++;yield {type:'text-delta',text:'## Goal\nContinue the task.\n## State\nEarlier evidence is archived.\n## Next\nReview the current request.\n## Uncertain\nFurther work needs verification.'};yield {type:'finish',kind:'stop'};};
    await f.run();assert.ok(calls>0);assert.equal(f.mainCalls(),1);
    const checkpoint=f.session.surface.nodes.map(seq=>f.session.eventAt(seq)).find(e=>e.data?.source?.continuation?.version===1);assert.ok(checkpoint);
    assert.match(JSON.stringify(checkpoint.data.content),/Do not delete original files/);
    assert.equal(f.engine.sessionState.read(f.session.id).failures,0);
    assert.ok((await f.engine.archive.readSpan(f.session.id,checkpoint.data.source.compactionId)).ok);
  }finally{await f.close();}
});
await test('mandatory-requirements-that-cannot-shrink-remain-without-failure',async()=>{
  const f=await fixture({hugeRequirement:true});try{
    f.engine.config={...f.engine.config,continuationMaxBytes:4096};
    await f.run();assert.equal(f.calls(),0);assert.equal(f.mainCalls(),1);
    assert.deepEqual(f.session.surface.nodes,f.original);assert.equal(f.engine.sessionState.read(f.session.id).failures,0);
  }finally{await f.close();}
});
await test('idle-capacity-guard-is-independent-of-pressure-retention',async()=>{
  const f=await fixture({small:true});try{
    f.engine.config={...f.engine.config,retainTokens:90000};
    f.engine.ctx.llm.resolveModelInfo=async()=>({contextWindow:100000});
    await f.run();assert.equal(f.calls(),0);assert.equal(f.mainCalls(),1);assert.deepEqual(f.session.surface.nodes,f.original);
  }finally{await f.close();}
});
await test('idle-still-blocks-an-actually-oversized-main-request',async()=>{
  const f=await fixture({small:true});try{
    const oldGuard=f.engine._guardRequestBudget.bind(f.engine);
    f.engine._guardRequestBudget=async(...args)=>{
      f.engine.ctx.tokenMeter.measure=()=>({nodes:f.session.surface.nodes,totalTokens:100000});
      return oldGuard(...args);
    };
    f.engine.ctx.llm.resolveModelInfo=async()=>({contextWindow:100000});
    await assert.rejects(f.run(),e=>e.failureCode==='COMPACTION_REQUEST_BUDGET_EXCEEDED');
    assert.equal(f.calls(),0);assert.equal(f.mainCalls(),0);assert.deepEqual(f.agent.inbox.nextStep,[f.incoming]);
  }finally{await f.close();}
});
await test('under-threshold-and-disabled-do-not-call-summary',async()=>{
  for(const minutes of [0,60]){const f=await fixture({minutes});try{await f.run();assert.equal(f.calls(),0);assert.equal(f.mainCalls(),1);assert.deepEqual(f.session.surface.nodes,f.original);}finally{await f.close();}}
});
await test('summary-failure-keeps-surface-and-requeues-input-before-main',async()=>{
  const f=await fixture({fail:true});try{
    await assert.rejects(f.run(),e=>e.code==='COMPACTION_AUTOMATIC_BLOCKED');assert.ok(f.calls()>0);assert.equal(f.mainCalls(),0);assert.deepEqual(f.session.surface.nodes,f.original);
    assert.deepEqual(f.agent.inbox.nextStep,[f.incoming]);
    assert.ok(f.session.snapshotEvents().some(e=>e.type==='agent/inbox/spliced'&&e.data.target==='next-step'&&e.data.inserted[0]?.id===f.incoming.id));
  }finally{await f.close();}
});
await test('closed-tool-pair-is-kept-balanced-at-resume',async()=>{
  const f=await fixture({closedTools:true});try{
    const pair=f.original.slice(-2);await f.run();assert.equal(f.calls(),1);assert.equal(f.mainCalls(),1);
    for(const seq of pair)assert.ok(f.session.surface.nodes.includes(seq));
    f.session.append('turn/end',{turn:2});await f.store.flush(f.session);
    assert.deepEqual(Session.create(f.session.id,f.session.snapshotEvents(),f.session.header).surface.nodes,f.session.surface.nodes);
  }finally{await f.close();}
});
await test('cancel-after-commit-during-budget-lookup-retains-new-input',async()=>{
  const f=await fixture(),controller=new AbortController();let budget=false,main=0;
  try{
    const oldGuard=f.engine._guardRequestBudget.bind(f.engine);
    f.engine._guardRequestBudget=async(...args)=>{budget=true;return oldGuard(...args);};
    f.engine.ctx.llm.resolveModelInfo=async()=>{
      if(budget)controller.abort(Object.assign(new Error('cancel after commit'),{name:'AbortError'}));
      return {contextWindow:1000000};
    };
    await assert.rejects(f.hooks.get('agent/pre-step')({agent:f.agent,signal:controller.signal,messages:[f.incoming]},async()=>{main++;}),e=>e.name==='AbortError');
    assert.equal(main,0);assert.equal(f.calls(),1);assert.deepEqual(f.agent.inbox.nextStep,[f.incoming]);
    assert.ok(f.session.surface.nodes.some(seq=>f.session.eventAt(seq)?.data?.source?.kind==='compact-checkpoint'));
    assert.equal((await f.engine.journal.pending(f.session.id)).length,0);
    assert.equal(f.engine.sessionState.read(f.session.id).failures,0);
  }finally{await f.close();}
});
await test('mounted-engine-enables-idle-through-rpc-without-reloading-session',async()=>{
  const f=await fixture({live:true,minutes:0});
  try{
    await f.run();assert.equal(f.calls(),0);
    const saved=await f.setSettings({idleCompactionMinutes:30});assert.equal(saved.restartRequired,false);
    await f.run();assert.equal(f.calls(),1);assert.equal(f.mainCalls(),2);
    assert.ok(f.session.surface.nodes.some(seq=>f.session.eventAt(seq)?.data?.source?.kind==='compact-checkpoint'));
    assert.equal((await f.engine.journal.pending(f.session.id)).length,0);
  }finally{await f.close();}
});
await test('mounted-engine-disables-idle-and-accepts-month-through-rpc',async()=>{
  const f=await fixture({live:true});
  try{
    await f.setSettings({idleCompactionMinutes:0});await f.run();assert.equal(f.calls(),0);
    await f.setSettings({idleCompactionMinutes:43200});await f.run();assert.equal(f.calls(),0);
    assert.deepEqual(f.session.surface.nodes,f.original);assert.equal(f.mainCalls(),2);
  }finally{await f.close();}
});
await test('mounted-engine-summary-stream-keeps-snapshot-after-settings-save',async()=>{
  const f=await fixture({live:true});let before,after;
  try{
    await f.setSettings({idleCompactionMinutes:30,provider:'p',model:'before'});
    const originalStream=f.engine.ctx.llm.stream;
    f.engine.ctx.llm.stream=async function*(...args){
      before=f.engine.config.summarizationModel;
      await f.setSettings({idleCompactionMinutes:0,provider:'p',model:'after'});
      after=f.engine.config.summarizationModel;
      yield* originalStream(...args);
    };
    await f.run();assert.equal(f.calls(),1);assert.equal(before,'before');assert.equal(after,'before');
    assert.equal(f.engine._withConfig(()=>f.engine.config.summarizationModel),'after');
    assert.equal((await f.engine.journal.pending(f.session.id)).length,0);
  }finally{await f.close();}
});
console.log(JSON.stringify({passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,results},null,2));
if(results.some(x=>!x.pass))process.exitCode=1;
