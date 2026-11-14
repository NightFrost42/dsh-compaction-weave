import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {StockTransactionAdapter} from '../../lib/transaction.js';
import {WeaveCompactionEngine} from '../../lib/engine.js';
import {resolveConfig} from '../../lib/config.js';
import {approxTokens,blocksToText} from '../../lib/meter.js';

const modules=process.env.DSH_TEST_NODE_MODULES;
const load=file=>import(pathToFileURL(path.join(modules,file)));
const {Context}=await load('@deepseek-ai/cordis/lib/index.js');
const {Session,SessionStore}=await load('@deepseek-ai/dsh-session/lib/index.js');
const persistence=await load('@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js');
const {evaluatePluginCompatibility}=await load('@deepseek-ai/dsh-app-boot/lib/index.js');
const pkg=JSON.parse(fs.readFileSync(new URL('../../package.json',import.meta.url)));
const results=[];
const summary=['Primary Request and Intent','Key Technical Concepts','Files and Code Sections','Errors and Fixes','Problem Solving','All User Messages','Pending Tasks','Work Completed','Context for Continuing Work'].map((h,i)=>`## ${i+1}. ${h}\n${i===0?'Continue the test task.':i===5?'[filled by engine]':'(none)'}`).join('\n\n');

async function test(name,fn){
  try{await fn();results.push({name,pass:true});}
  catch(error){results.push({name,pass:false,error:error.message,stack:error.stack});}
}

async function fixture(){
  const directory=fs.mkdtempSync(path.join(process.env.WEAVE_TEST_ROOT,'test-tmp','transaction-'));
  const root=new Context();
  const mounting=root.plugin({name:'weave-transaction-fixture',async apply(ctx){
    new SessionStore(ctx);
    await persistence.apply(ctx,{root:path.join(directory,'host-sessions'),compression:'none'});
  }});
  await mounting.await();
  const backend=root.sessionPersistence,store=root.sessions;
  const session=Session.create('transaction-'+randomUUID());
  const handle=await backend.create(session.header);
  let detach=store.enter(session),expectedHandleCloseFailure=false;store.announce(session);
  const add=(role,text)=>session.append(role+'/message',role==='user'
    ?{id:randomUUID(),role,content:[{type:'text',text}],source:{kind:'user'}}
    :{turn:1,step:1,...(role==='assistant'?{stream:[],usage:{inputTokens:0,outputTokens:0}}:{}),message:{id:randomUUID(),role,content:[{type:'text',text}],source:role==='system'?{kind:'system-prompt'}:{kind:'model',provider:'p',model:'m'}}},{surfaceOp:'append'});
  session.append('turn/start',{turn:1});
  session.append('step/start',{turn:1,step:1});
  add('system','Stable system prefix.');
  add('user','Timeout must be 35 seconds.');
  add('user','Timeout must be 55 seconds.');
  add('assistant','Work notes. '.repeat(6000));
  session.append('step/end',{turn:1,step:1});
  session.append('turn/end',{turn:1});
  await store.flush(session);
  let calls=0;
  const ctx={on(){},provide(){},logger:{info(){},warn(){}},sessions:{flush:s=>store.flush(s)},
    tokenMeter:{measure(s){const nodes=s.surface.nodes.map(seq=>({seq,tokens:approxTokens(blocksToText(s.deriveEventMessage(s.eventAt(seq))?.content))}));return {nodes,totalTokens:nodes.reduce((n,x)=>n+x.tokens,0)};}},
    llm:{async resolveModelInfo(){return {contextWindow:1000000};},async *stream(){calls++;yield {type:'text-delta',text:summary};yield {type:'finish',kind:'stop'};}}};
  const engine=new WeaveCompactionEngine(ctx,resolveConfig({archiveDir:path.join(directory,'weave','archive'),language:'en'}).config);
  const adapter=new StockTransactionAdapter(backend,store,ctx.logger);
  adapter.register(engine.journal,engine.sessionState,engine.config.failureThreshold);
  engine.transactionAdapter=adapter;engine.requireTransactionAdapter=true;engine.historyToolsAvailable=true;
  const agent={session,options:{provider:'p',model:'m'},runMaintenance:fn=>fn(new AbortController().signal)};
  return {directory,root,backend,store,session,handle,engine,adapter,agent,add,calls:()=>calls,
    async compact(){const seqs=session.surface.nodes.slice(1);return engine._compactRegionCore(seqs[0],seqs.at(-1),agent,new AbortController().signal,{manual:true,policy:engine.config});},
    detach(){detach?.();detach=null;},
    expectQuarantinedClose(){expectedHandleCloseFailure=true;},
    async close(){delete adapter.checkpoint;engine.dispose();adapter.dispose();detach?.();if(expectedHandleCloseFailure)await assert.rejects(handle.close(),/writer quarantined/);else await handle.close();await mounting.dispose();}};
}

await test('host-version-range-admits-rc1-rc2-rc3-and-later-02',()=>{
  for(const version of ['0.2.2-rc.1','0.2.2-rc.2','0.2.2-rc.3','0.2.2','0.2.3-rc.1','0.2.9'])assert.equal(evaluatePluginCompatibility(pkg,{},version),undefined,version);
});
await test('host-version-range-refuses-old-and-03-prereleases',()=>{
  for(const version of ['0.2.1-rc.5','0.2.2-alpha.3','0.2.2-rc.0','0.3.0-alpha.1','0.3.0','1.0.0'])assert.ok(evaluatePluginCompatibility(pkg,{},version),version);
});
await test('native-transaction-durable-commit-archive-reopen',async()=>{
  const f=await fixture();
  try{
    const result=await f.compact();
    assert.equal(f.calls(),1);assert.equal(f.session.surface.nodes.length,2);
    const checkpoint=f.session.deriveEventMessage(f.session.eventAt(f.session.surface.nodes.at(-1)));
    assert.match(JSON.stringify(checkpoint.content),/55 seconds/);assert.doesNotMatch(JSON.stringify(checkpoint.content),/35 seconds/);
    assert.equal((await f.engine.archive.readSpan(f.session.id,result.compactionId)).ok,true);
    const stored=await f.backend.readStoredLog(f.backend.locate(f.session.header).path,f.session.id);
    assert.deepEqual(stored.events,f.session.snapshotEvents());
    const replay=Session.fromRestore(f.session.id,stored.events,stored.meta,stored.inheritedEventCount,'detached',f.store.messageProjections);
    assert.deepEqual(replay.surface.nodes,f.session.surface.nodes);
    assert.equal((await f.engine.journal.pending(f.session.id)).length,0);
    f.add('user','Continue after the committed checkpoint.');await f.store.flush(f.session);
    assert.deepEqual((await f.backend.readStoredLog(f.backend.locate(f.session.header).path,f.session.id)).events,f.session.snapshotEvents());
  }finally{await f.close();}
});
await test('native-transaction-predecision-failure-restores-history',async()=>{
  const f=await fixture();
  try{
    const before=[...f.session.surface.nodes];
    f.adapter.checkpoint=stage=>{if(stage==='after-append')throw Object.assign(new Error('injected before commit decision'),{code:'EIO'});};
    await assert.rejects(f.compact(),/injected before commit decision/);
    assert.deepEqual(f.session.surface.nodes,before);
    const stored=await f.backend.readStoredLog(f.backend.locate(f.session.header).path,f.session.id);
    assert.deepEqual(stored.events,f.session.snapshotEvents());
    assert.equal(stored.events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='compact-checkpoint').length,0);
    assert.equal((await f.engine.journal.pending(f.session.id)).length,0);
  }finally{await f.close();}
});
await test('native-transaction-postdecision-failure-keeps-durable-success',async()=>{
  const f=await fixture();
  try{
    f.adapter.checkpoint=stage=>{if(stage==='after-decision')throw new Error('injected after durable decision');};
    await assert.rejects(f.compact(),/durable but publication failed/);
    assert.equal(f.adapter.blocked.has(f.session.id),true);
    const stored=await f.backend.readStoredLog(f.backend.locate(f.session.header).path,f.session.id);
    assert.equal(stored.events.filter(e=>e.type==='user/message'&&e.data.source?.kind==='compact-checkpoint').length,1);
    const pending=await f.engine.journal.pending(f.session.id);assert.equal(pending.length,1);assert.equal(pending[0].phase,'committed');
    f.detach();f.expectQuarantinedClose();await assert.rejects(f.handle.close(),/writer quarantined/);delete f.adapter.checkpoint;
    const reopened=await f.backend.open(f.session.id,'write');
    try{
      assert.deepEqual((await reopened.read()).events,stored.events);
      assert.equal((await f.engine.journal.pending(f.session.id)).length,0);
    }finally{await reopened.close();}
  }finally{await f.close();}
});
await test('native-transaction-cold-interruption-restores-and-closes-before-reopen',async()=>{
  const f=await fixture();
  try{
    const before=[...f.session.surface.nodes],id='weave-interrupted-'+randomUUID();
    const start=f.session.append('compaction/start',{compactionId:id,turn:null});
    await f.store.flush(f.session);
    const target=f.backend.locate(f.session.header).path,file=f.engine.journal.fileFor(f.session.id,id);
    const original=fs.readFileSync(target),tail=Buffer.from('partial-transaction-tail');
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file+'.rollback',original);fs.writeFileSync(file+'.tail',tail);
    const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
    f.engine.journal.recordSync({sessionId:f.session.id,compactionId:id,phase:'committing',startEventSeq:start.seq,failuresBefore:0,
      atomic:{version:1,beforeBytes:original.length,beforeHash:hash(original),beforeEvents:f.session.seq,tailBytes:tail.length,tailHash:hash(tail)}});
    fs.appendFileSync(target,tail.subarray(0,8));
    f.detach();await f.handle.close();
    const reopened=await f.backend.open(f.session.id,'write');
    try{
      const stored=await reopened.read();
      assert.equal(stored.events.filter(e=>e.type==='compaction/end'&&e.data.compactionId===id).length,1);
      const replay=Session.fromRestore(f.session.id,stored.events,reopened.header,reopened.inheritedEventCount,'detached',f.store.messageProjections);
      assert.deepEqual(replay.surface.nodes,before);
      assert.equal(f.engine.sessionState.read(f.session.id).failures,1);
      const record=(await f.engine.journal.pending(f.session.id))[0];assert.equal(record.atomic.restored,true);
      await f.engine.journal.clear(f.session.id,id);
    }finally{await reopened.close();}
  }finally{await f.close();}
});
await test('native-transaction-unknown-append-refuses-before-summary',async()=>{
  const f=await fixture();
  try{
    const original=Object.getPrototypeOf(f.session),changed=Object.create(original);
    changed.append=function(){throw new Error('unknown host implementation');};
    Object.setPrototypeOf(f.session,changed);
    try{await assert.rejects(f.compact(),/unsupported session.append/);assert.equal(f.calls(),0);}
    finally{Object.setPrototypeOf(f.session,original);}
  }finally{await f.close();}
});
await test('native-transaction-batch-append-or-single-append-then-compact',async()=>{
  const f=await fixture();
  try{
    const batch=[['user/message',{id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:'Do not publish credentials.'}]},{surfaceOp:'append'}],['user/message',{id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:'Keep the source archive.'}]},{surfaceOp:'append'}]];
    if(typeof f.session.surface.prepareBatch==='function')assert.equal(f.session.append(batch).length,2);
    else for(const input of batch)f.session.append(...input);
    await f.store.flush(f.session);await f.compact();
    const stored=await f.backend.readStoredLog(f.backend.locate(f.session.header).path,f.session.id);
    assert.deepEqual(stored.events,f.session.snapshotEvents());
    assert.match(JSON.stringify(f.session.deriveEventMessage(f.session.eventAt(f.session.surface.nodes.at(-1))).content),/Do not publish credentials/);
  }finally{await f.close();}
});

console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));
if(results.some(r=>!r.pass))process.exitCode=1;
