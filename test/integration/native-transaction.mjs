import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {StockTransactionAdapter} from '../../lib/transaction.js';
import {WeaveCompactionEngine} from '../../lib/engine.js';
import {readResumableCompaction,writeResumableCompaction} from '../../lib/state.js';
import {detectBiliSession} from '../../lib/foreign-fold.js';
import {planObservationMask,commitObservationMask} from '../../lib/observation-mask.js';
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

async function fixture({compression='none',seedDefaultTurn=true}={}){
  const directory=fs.mkdtempSync(path.join(process.env.WEAVE_TEST_ROOT,'test-tmp','transaction-'));
  const root=new Context();
  const mounting=root.plugin({name:'weave-transaction-fixture',async apply(ctx){
    new SessionStore(ctx);
    await persistence.apply(ctx,{root:path.join(directory,'host-sessions'),compression});
  }});
  await mounting.await();
  const backend=root.sessionPersistence,store=root.sessions;
  const session=Session.create('transaction-'+randomUUID());
  const handle=await backend.create(session.header);
  let detach=store.enter(session),expectedHandleCloseFailure=false,handleClosed=false;store.announce(session);
  const add=(role,text,turn=1,step=1)=>session.append(role+'/message',role==='user'
    ?{id:randomUUID(),role,content:[{type:'text',text}],source:{kind:'user'}}
    :{turn,step,...(role==='assistant'?{stream:[],usage:{inputTokens:0,outputTokens:0}}:{}),message:{id:randomUUID(),role,content:[{type:'text',text}],source:role==='system'?{kind:'system-prompt'}:{kind:'model',provider:'p',model:'m'}}},{surfaceOp:'append'});
  if(seedDefaultTurn){
    session.append('turn/start',{turn:1});
    session.append('step/start',{turn:1,step:1});
    add('system','Stable system prefix.');
    add('user','Timeout must be 35 seconds.');
    add('user','Timeout must be 55 seconds.');
    add('assistant','Work notes. '.repeat(6000));
    session.append('step/end',{turn:1,step:1});
    session.append('turn/end',{turn:1});
    await store.flush(session);
  }
  let calls=0;const warnings=[];
  const ctx={on(){},provide(){},logger:{info(){},warn(m){warnings.push(String(m));}},sessions:{flush:s=>store.flush(s),get:id=>store.get(id)},sessionPersistence:backend,
    tokenMeter:{measure(s){const nodes=s.surface.nodes.map(seq=>({seq,tokens:approxTokens(blocksToText(s.deriveEventMessage(s.eventAt(seq))?.content))}));return {nodes,totalTokens:nodes.reduce((n,x)=>n+x.tokens,0)};}},
    llm:{async resolveModelInfo(){return {contextWindow:1000000};},async *stream(){calls++;yield {type:'text-delta',text:summary};yield {type:'finish',kind:'stop'};}}};
  const engine=new WeaveCompactionEngine(ctx,resolveConfig({archiveDir:path.join(directory,'weave','archive'),language:'en'}).config);
  const adapter=new StockTransactionAdapter(backend,store,ctx.logger);
  adapter.register(engine.journal,engine.sessionState,engine.config.failureThreshold,engine.backupStore);
  engine.transactionAdapter=adapter;engine.requireTransactionAdapter=true;engine.historyToolsAvailable=true;
  const agent={session,options:{provider:'p',model:'m'},runMaintenance:fn=>fn(new AbortController().signal)};
  return {directory,root,backend,store,session,handle,engine,adapter,agent,add,calls:()=>calls,warnings:()=>warnings,
    async compact(){const seqs=session.surface.nodes.slice(1);return engine._compactRegionCore(seqs[0],seqs.at(-1),agent,new AbortController().signal,{manual:true,policy:engine.config});},
    detach(){detach?.();detach=null;},
    async closeHandle(){if(!handleClosed){handleClosed=true;await handle.close();}},
    expectQuarantinedClose(){expectedHandleCloseFailure=true;},
    async close(){delete adapter.checkpoint;engine.dispose();adapter.dispose();detach?.();if(!handleClosed){handleClosed=true;if(expectedHandleCloseFailure)await assert.rejects(handle.close(),/writer quarantined/);else await handle.close();}await mounting.dispose();}};
}

await test('host-version-range-admits-rc1-rc2-rc3-and-03x-until-10',()=>{
  for(const version of ['0.2.2-rc.1','0.2.2-rc.2','0.2.2-rc.3','0.2.2','0.2.3-rc.1','0.2.9','0.3.0-alpha.1','0.3.0-rc.1','0.3.0','0.9.9'])assert.equal(evaluatePluginCompatibility(pkg,{},version),undefined,version);
});
await test('host-version-range-refuses-old-and-10-major',()=>{
  for(const version of ['0.2.1-rc.5','0.2.2-alpha.3','0.2.2-rc.0','1.0.0-alpha.1','1.0.0'])assert.ok(evaluatePluginCompatibility(pkg,{},version),version);
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
await test('native-transaction-minor-host-update-gracefully-falls-back-by-default',async()=>{
  const f=await fixture();
  try{
    assert.equal(f.engine.config.strictHostFingerprints,false);
    f.engine.requireTransactionAdapter=false;
    const original=Object.getPrototypeOf(f.session),changed=Object.create(original);
    changed.append=function(...args){void 'harmless host telemetry tweak';return original.append.apply(this,args);};
    Object.setPrototypeOf(f.session,changed);
    try{
      const result=await f.compact();
      assert.equal(f.calls(),1);
      assert.equal(f.warnings().filter(w=>/falling back to public Session\.append replace/.test(w)).length,1);
      assert.equal(f.session.surface.nodes.length,2);
      const checkpoint=f.session.deriveEventMessage(f.session.eventAt(f.session.surface.nodes.at(-1)));
      assert.match(JSON.stringify(checkpoint.content),/55 seconds/);
      assert.equal((await f.engine.archive.readSpan(f.session.id,result.compactionId)).ok,true);
      const stored=await f.backend.readStoredLog(f.backend.locate(f.session.header).path,f.session.id);
      assert.deepEqual(stored.events,f.session.snapshotEvents());
      const replay=Session.fromRestore(f.session.id,stored.events,stored.meta,stored.inheritedEventCount,'detached',f.store.messageProjections);
      assert.deepEqual(replay.surface.nodes,f.session.surface.nodes);
      assert.equal((await f.engine.journal.pending(f.session.id)).length,0);
    }finally{Object.setPrototypeOf(f.session,original);}
  }finally{await f.close();}
});
await test('native-transaction-adapter-unavailable-falls-back-by-default',async()=>{
  const f=await fixture();
  try{
    f.engine.requireTransactionAdapter=false;
    f.engine.transactionAdapter=undefined;
    const result=await f.compact();
    assert.equal(f.calls(),1);
    assert.equal(f.warnings().filter(w=>/falling back to public Session\.append replace/.test(w)).length,1);
    assert.equal(f.session.surface.nodes.length,2);
    assert.equal((await f.engine.archive.readSpan(f.session.id,result.compactionId)).ok,true);
    const stored=await f.backend.readStoredLog(f.backend.locate(f.session.header).path,f.session.id);
    assert.deepEqual(stored.events,f.session.snapshotEvents());
    assert.equal((await f.engine.journal.pending(f.session.id)).length,0);
  }finally{await f.close();}
});
await test('native-transaction-bili-fold-adopt-zstd-reopen-and-backup-restore',async()=>{
  const f=await fixture({compression:'zstd',seedDefaultTurn:false});
  const sha=buf=>createHash('sha256').update(buf).digest('hex');
  try{
    // Turn 1: initial history later replaced by a foreign ranxianglei-authored-checkpoint
    f.session.append('turn/start',{turn:1});
    f.session.append('step/start',{turn:1,step:1});
    f.add('system','Stable system prefix.',1,1);
    const oldUser=f.add('user','Original pre-fold detail: secret-ticket-7741.',1,1);
    const oldAsst=f.add('assistant','Handled secret-ticket-7741.',1,1);
    f.session.append('step/end',{turn:1,step:1});
    f.session.append('turn/end',{turn:1});

    // Foreign ranxianglei-authored-checkpoint lifecycle (<bili-snapshot v1 ... /> in content[1])
    const biliId='bili-authored-zstd-1';
    const biliStart=f.session.append('compaction/start',{compactionId:biliId,turn:null});
    const biliSummary=f.session.append('compaction/summary',{
      compactionId:biliId,
      summary:[{type:'text',text:'[Compressed conversation section]\nWorked on ticket 7741.'}],
      shadowedRange:{start:oldUser.seq,end:oldAsst.seq},
      shadowedSeqs:[oldUser.seq,oldAsst.seq],
      shadowedTokenCount:120,
      provider:'p',
      model:'m',
    });
    f.session.append('user/message',{
      id:randomUUID(),
      role:'user',
      content:[
        {type:'text',text:'[Compressed conversation section]\nWorked on ticket 7741.'},
        {type:'text',text:'<bili-snapshot v1 blocks="1" tokens="42000" />'},
      ],
      source:{kind:'compact-checkpoint',compactionId:biliId},
    },{
      surfaceOp:{op:'replace',startSeq:oldUser.seq,endSeq:oldAsst.seq},
      sourceEventSeqs:[biliStart.seq,biliSummary.seq,oldUser.seq,oldAsst.seq],
    });
    f.session.append('compaction/end',{compactionId:biliId,turn:null});

    // Turn 2: verified post-fold user message that must remain intact on the surface
    f.session.append('turn/start',{turn:2});
    f.session.append('step/start',{turn:2,step:1});
    const postFoldUser=f.add('user','Post-fold verified requirement: keep audit logs enabled.',2,1);
    f.add('assistant','Acknowledged.',2,1);
    f.session.append('step/end',{turn:2,step:1});
    f.session.append('turn/end',{turn:2});
    await f.store.flush(f.session);

    const targetPath=f.backend.locate(f.session.header).path;
    assert.ok(targetPath.endsWith('.v4.jsonl.zstd'),`expected .v4.jsonl.zstd, got ${targetPath}`);
    const preMigrateBytes=fs.readFileSync(targetPath);
    assert.deepEqual([...preMigrateBytes.subarray(0,4)],[0x28,0xb5,0x2f,0xfd],'must be a real Zstandard frame');
    const preMigrateSha=sha(preMigrateBytes);

    const beforeDet=detectBiliSession(f.session);
    assert.equal(beforeDet.detected,true);
    assert.equal(beforeDet.variant,'ranxianglei-authored-checkpoint');

    // Run real fold-adopt migration under StockTransactionAdapter
    const migrated=await f.engine.migrateBiliSession(f.session,{
      agent:f.agent,
      sessions:f.store,
      backend:f.backend,
      sessionPersistence:f.backend,
    });
    assert.equal(migrated.completed,true);
    assert.equal(f.calls(),0,'fold-adopt must use 0 LLM calls');
    assert.equal(sha(fs.readFileSync(migrated.backupPath)),preMigrateSha,'backup SHA-256 must match pre-migration .v4.jsonl.zstd');
    assert.deepEqual(fs.readdirSync(path.dirname(targetPath)),[path.basename(targetPath)],'zero foreign files allowed inside DSH session dir');

    // Verify emitted compaction/summary omits llmStreamCall (DSH V4 payload validator rejects false)
    const migratedCpId=migrated.compactionIds[0];
    const summaryEv=f.session.snapshotEvents().find(e=>e.type==='compaction/summary'&&e.data?.compactionId===migratedCpId);
    assert.ok(summaryEv,'fold-adopt must emit compaction/summary');
    assert.equal(summaryEv.data.llmStreamCall,undefined);
    assert.equal('llmStreamCall' in summaryEv.data,false);
    assert.equal(detectBiliSession(f.session).detected,false);
    assert.ok(f.session.surface.nodes.includes(postFoldUser.seq));
    const archived=await f.engine.archive.readSpan(f.session.id,migratedCpId);
    assert.equal(archived.ok,true);
    assert.ok(archived.entries.some(e=>e.text.includes('secret-ticket-7741')));
    assert.equal((await f.engine.journal.pending(f.session.id)).length,0);

    // Real cold reopen through DSH V4 Zstandard decoder + V4 payload/relationship validator!
    const expectedEvents=f.session.snapshotEvents();
    const expectedNodes=[...f.session.surface.nodes];
    f.detach();
    await f.closeHandle();
    const reopened=await f.backend.open(f.session.id,'write');
    let reopenedClosed=false;
    try{
      const stored=await reopened.read();
      assert.deepEqual(stored.events,expectedEvents);
      const replay=Session.fromRestore(f.session.id,stored.events,reopened.header,reopened.inheritedEventCount,'detached',f.store.messageProjections);
      assert.deepEqual(replay.surface.nodes,expectedNodes);
      assert.equal(detectBiliSession(replay).detected,false);

      // Path B armed restore while writer is open -> close -> StockTransactionAdapter.recoverBeforeOpen restores .v4.jsonl.zstd byte-for-byte
      const armed=await f.engine.restoreSessionBackupFor(f.session.id,{
        backupId:migrated.backupId,
        sessions:f.store,
        backend:f.backend,
        sessionPersistence:f.backend,
        stockAdapter:f.adapter,
      });
      assert.equal(armed.status,'armed');
      assert.equal(armed.requiresReopen,true);
      assert.equal(f.adapter.blocked.has(f.session.id),true,'live writer must be quarantined while restore is armed');
      await assert.rejects(reopened.persistContiguous(),/writer quarantined/);
      reopenedClosed=true;
      await reopened.close();
    }finally{
      if(!reopenedClosed)await reopened.close();
    }

    const restoredHandle=await f.backend.open(f.session.id,'write');
    try{
      assert.equal(f.adapter.blocked.has(f.session.id),false,'cold restore on reopen must clear quarantine');
      assert.equal(sha(fs.readFileSync(targetPath)),preMigrateSha,'cold reopen must restore pre-migration .v4.jsonl.zstd byte-for-byte');
      assert.deepEqual(fs.readdirSync(path.dirname(targetPath)),[path.basename(targetPath)],'zero foreign files after backup restore');
      const restoredStored=await restoredHandle.read();
      const restoredReplay=Session.fromRestore(f.session.id,restoredStored.events,restoredHandle.header,restoredHandle.inheritedEventCount,'detached',f.store.messageProjections);
      assert.equal(detectBiliSession(restoredReplay).detected,true);
    }finally{
      await restoredHandle.close();
    }
  }finally{await f.close();}
});
await test('native-transaction-idle-proxy-raw-bili-migrate-and-mask-outside-turn-safety',async()=>{
  const f=await fixture({compression:'zstd',seedDefaultTurn:false});
  const sha=buf=>createHash('sha256').update(buf).digest('hex');
  try{
    // Seed a realistic idle ranxianglei-proxy-raw session with oversized acp_* tool outputs inside closed turns
    f.session.append('turn/start',{turn:1});
    f.session.append('step/start',{turn:1,step:1});
    f.add('system','Stable system prefix.',1,1);
    f.add('user','Continue the test task.',1,1);
    const call1Id='call-acp-1',call2Id='call-acp-2';
    f.session.append('assistant/message',{turn:1,step:1,stream:[],usage:{inputTokens:0,outputTokens:0},message:{
      id:randomUUID(),role:'assistant',source:{kind:'model',provider:'p',model:'m'},
      content:[
        {type:'tool-call',id:call1Id,name:'acp_status',arguments:'{}'},
        {type:'tool-call',id:call2Id,name:'acp_read_original_image',arguments:'{"ref":"m001"}'},
      ],
    }},{surfaceOp:'append'});
    const tc1=f.session.append('tool/call',{turn:1,step:1,callId:call1Id,name:'acp_status',arguments:'{}'});
    f.session.append('tool/result',{turn:1,step:1,message:{
      id:randomUUID(),role:'tool',toolCallId:call1Id,source:{kind:'tool',callId:call1Id},
      content:[{type:'text',text:'[ACP] acp_status result: active=true\n'+'status-detail '.repeat(800)}],
    }},{surfaceOp:'append',sourceEventSeqs:[tc1.seq]});
    const tc2=f.session.append('tool/call',{turn:1,step:1,callId:call2Id,name:'acp_read_original_image',arguments:'{"ref":"m001"}'});
    f.session.append('tool/result',{turn:1,step:1,message:{
      id:randomUUID(),role:'tool',toolCallId:call2Id,source:{kind:'tool',callId:call2Id},
      content:[{type:'text',text:'[bili] original image metadata\n'+'image-meta '.repeat(800)}],
    }},{surfaceOp:'append',sourceEventSeqs:[tc2.seq]});
    f.session.append('step/end',{turn:1,step:1});
    f.session.append('step/start',{turn:1,step:2});
    f.add('assistant','Work notes. '.repeat(2500),1,2);
    f.session.append('step/end',{turn:1,step:2});
    f.session.append('turn/end',{turn:1});

    f.session.append('turn/start',{turn:2});
    f.session.append('step/start',{turn:2,step:1});
    f.add('user','Keep the tail turn intact.',2,1);
    f.add('assistant','Acknowledged.',2,1);
    f.session.append('step/end',{turn:2,step:1});
    f.session.append('turn/end',{turn:2});
    await f.store.flush(f.session);

    const targetPath=f.backend.locate(f.session.header).path;
    assert.ok(targetPath.endsWith('.v4.jsonl.zstd'));
    const preMigrateSha=sha(fs.readFileSync(targetPath));

    // Direct guard check: commitObservationMask MUST return null when openTurn === null (DSH V4 forbids outside-turn tool/result)
    const idleMeas=await f.engine._measure(f.session);
    const maskPlan=planObservationMask(f.session,idleMeas,20,{compactionId:'weave-idle-guard-check',thresholdChars:1000});
    assert.ok(maskPlan&&maskPlan.targets.length>=2,'expected eligible tool results for planObservationMask');
    const eventsBeforeMask=f.session.seq;
    const idleMaskResult=await commitObservationMask({session:f.session,plan:maskPlan,archive:f.engine.archive});
    assert.equal(idleMaskResult,null,'commitObservationMask must skip disk writes outside an open turn');
    assert.equal(f.session.seq,eventsBeforeMask,'idle session log must remain untouched by commitObservationMask');

    // Idle proxy-raw-rolling migrateBiliSession must succeed without outside-turn tool/result writes
    assert.equal(detectBiliSession(f.session).variant,'ranxianglei-proxy-raw');
    const migrated=await f.engine.migrateBiliSession(f.session,{
      agent:f.agent,sessions:f.store,backend:f.backend,sessionPersistence:f.backend,asyncRollingWave:false,
    });
    assert.equal(migrated.completed,true);
    assert.equal(detectBiliSession(f.session).detected,false);
    assert.equal(f.session.snapshotEvents().some(e=>e.type==='compaction/prune'),false,'idle proxy-raw migration must not write compaction/prune');
    assert.equal(sha(fs.readFileSync(migrated.backupPath)),preMigrateSha);
    assert.deepEqual(fs.readdirSync(path.dirname(targetPath)),[path.basename(targetPath)]);

    // Real DSH V4 cold reopen + payload/relationship validation (would throw SessionFormatError if any tool/result landed outside a turn!)
    const expectedEvents=f.session.snapshotEvents();
    const expectedNodes=[...f.session.surface.nodes];
    f.detach();
    await f.closeHandle();
    const reopened=await f.backend.open(f.session.id,'write');
    try{
      const stored=await reopened.read();
      assert.deepEqual(stored.events,expectedEvents);
      const replay=Session.fromRestore(f.session.id,stored.events,reopened.header,reopened.inheritedEventCount,'detached',f.store.messageProjections);
      assert.deepEqual(replay.surface.nodes,expectedNodes);
      assert.equal(detectBiliSession(replay).detected,false);
    }finally{await reopened.close();}

    // Path A cold backup restore verifies byte-for-byte restoration of .v4.jsonl.zstd
    const restored=await f.engine.restoreSessionBackupFor(f.session.id,{
      backupId:migrated.backupId,sessions:f.store,backend:f.backend,sessionPersistence:f.backend,stockAdapter:f.adapter,
    });
    assert.equal(restored.status,'restored');
    assert.equal(sha(fs.readFileSync(targetPath)),preMigrateSha);
    const verifyHandle=await f.backend.open(f.session.id,'write');
    try{
      const restoredStored=await verifyHandle.read();
      const restoredReplay=Session.fromRestore(f.session.id,restoredStored.events,verifyHandle.header,verifyHandle.inheritedEventCount,'detached',f.store.messageProjections);
      assert.equal(detectBiliSession(restoredReplay).detected,true);
    }finally{await verifyHandle.close();}
  }finally{await f.close();}
});
await test('native-transaction-started-crash-cold-recovery-closes-lock-before-end-seed-and-resumes',async()=>{
  const f=await fixture({compression:'zstd',seedDefaultTurn:true});
  try{
    const targetPath=f.backend.locate(f.session.header).path;
    assert.ok(targetPath.endsWith('.v4.jsonl.zstd'));
    const remainingSeqs=f.session.surface.nodes.slice(1);
    assert.ok(remainingSeqs.length>=3);

    // Simulate hard process crash mid-summarization (phase: 'started'):
    // 1. Live session appended compaction/start and flushed to .v4.jsonl.zstd.
    // 2. Journal recorded phase: 'started' (no atomic rollback files yet).
    // 3. Session state recorded resumableCompaction with status: 'running'.
    const crashId='weave-crash-started-'+randomUUID();
    const startEv=f.session.append('compaction/start',{compactionId:crashId,turn:null});
    await f.store.flush(f.session);
    f.engine.journal.recordSync({
      sessionId:f.session.id,
      compactionId:crashId,
      phase:'started',
      startEventSeq:startEv.seq,
      failuresBefore:0,
      startSeq:remainingSeqs[0],
      endSeq:remainingSeqs.at(-1),
    });
    writeResumableCompaction(f.engine.sessionState,f.session.id,{
      jobId:'job-crash-zstd-1',
      trigger:'manual',
      status:'running',
      remainingSeqs,
      remainingSourceSha256:f.engine._sourceHashForSeqs(f.session,remainingSeqs),
      initialTotalNodes:remainingSeqs.length,
      completedNodes:0,
      initialTotalTokens:10000,
      completedTokens:0,
      completedChunks:0,
      waveCount:0,
      batchCheckpointSeqs:[],
      consecutiveFailures:0,
    });

    // Crash / hard exit: detach live session and close writer without closing compaction/start.
    f.detach();
    await f.closeHandle();

    // Cold reopen: StockTransactionAdapter.recoverBeforeOpen MUST close compaction/start
    // before DSH can append session/end-seed, clear the started journal, and mark resumableCompaction interrupted/crash.
    const reopenedHandle=await f.backend.open(f.session.id,'write');
    let detachReopened=null;
    try{
      const storedAfterRecovery=await reopenedHandle.read();
      const closedEnd=storedAfterRecovery.events.find(e=>e.type==='compaction/end'&&e.data?.compactionId===crashId);
      assert.ok(closedEnd,'recoverBeforeOpen must append compaction/end for phase=started crash');
      assert.equal(storedAfterRecovery.events.some(e=>e.type==='session/end-seed'&&e.seq<closedEnd.seq&&e.seq>startEv.seq),false,'compaction/end must precede any session/end-seed');
      assert.equal((await f.engine.journal.pending(f.session.id)).length,0,'started journal must be cleared on cold recovery');

      const resumable=readResumableCompaction(f.engine.sessionState,f.session.id);
      assert.ok(resumable,'resumableCompaction must survive cold crash recovery');
      assert.equal(resumable.status,'interrupted');
      assert.equal(resumable.interruptReason,'crash');

      // Re-mount the recovered live session on SessionStore (mirroring real DSH restore:
      // Session.fromRestore appends session/end-seed, then persistence appends that marker
      // before entering & announcing the live session) and resume cleanly via resumeCompactionFor!
      const liveSession=Session.fromRestore(
        f.session.id,
        storedAfterRecovery.events,
        reopenedHandle.header,
        reopenedHandle.inheritedEventCount,
        'detached',
        f.store.messageProjections,
      );
      const restoreDelta=liveSession.snapshotEvents(storedAfterRecovery.events.length);
      if(restoreDelta.length>0)await reopenedHandle.append(restoreDelta);
      detachReopened=f.store.enter(liveSession);
      f.store.announce(liveSession);
      const liveAgent={session:liveSession,options:{provider:'p',model:'m'},runMaintenance:fn=>fn(new AbortController().signal)};

      const resumed=await f.engine.resumeCompactionFor(liveSession,{agent:liveAgent,manualRetry:true});
      assert.ok(resumed,'resumeCompactionFor must complete the crashed job cleanly');
      assert.equal(readResumableCompaction(f.engine.sessionState,f.session.id),null,'resumableCompaction must be cleared on clean completion');
      assert.equal(liveSession.surface.nodes.length,2,'surface should now hold [system, compact-checkpoint]');
      assert.equal((await f.engine.journal.pending(f.session.id)).length,0);

      // Final cold reopen verifies the resumed .v4.jsonl.zstd log replays cleanly under DSH V4 validation.
      const finalEvents=liveSession.snapshotEvents();
      const finalNodes=[...liveSession.surface.nodes];
      detachReopened();detachReopened=null;
      await reopenedHandle.close();

      const verifyHandle=await f.backend.open(f.session.id,'write');
      try{
        const finalStored=await verifyHandle.read();
        assert.deepEqual(finalStored.events,finalEvents);
        const replay=Session.fromRestore(f.session.id,finalStored.events,verifyHandle.header,verifyHandle.inheritedEventCount,'detached',f.store.messageProjections);
        assert.deepEqual(replay.surface.nodes,finalNodes);
      }finally{await verifyHandle.close();}
    }finally{
      detachReopened?.();
      try{await reopenedHandle.close();}catch{}
    }
  }finally{await f.close();}
});

console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));
if(results.some(r=>!r.pass))process.exitCode=1;
