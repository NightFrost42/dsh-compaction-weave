import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {StockTransactionAdapter} from '../../lib/transaction.js';
import {WeaveCompactionEngine} from '../../lib/engine.js';
import {readResumableCompaction,writeResumableCompaction} from '../../lib/state.js';
import {detectBiliSession} from '../../lib/foreign-fold.js';
import {planObservationMask,commitObservationMask,PERSISTED_OUTPUT_MARKER,MICROCOMPACT_SUPERSEDED_MARKER,OBSERVATION_MASK_MARKER} from '../../lib/observation-mask.js';
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

async function fixture({compression='none',seedDefaultTurn=true,cwd}={}){
  const directory=fs.mkdtempSync(path.join(process.env.WEAVE_TEST_ROOT,'test-tmp','transaction-'));
  const root=new Context();
  const mounting=root.plugin({name:'weave-transaction-fixture',async apply(ctx){
    new SessionStore(ctx);
    await persistence.apply(ctx,{root:path.join(directory,'host-sessions'),compression});
  }});
  await mounting.await();
  const backend=root.sessionPersistence,store=root.sessions;
  const sessionId='transaction-'+randomUUID();
  const session=cwd===undefined
    ?Session.create(sessionId)
    :Session.create(sessionId,undefined,{...Session.create(sessionId).header,cwd});
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
function nonLockEntries(dir){
  const entries=fs.readdirSync(dir);
  return process.platform==='win32'?entries:entries.filter(name=>name!=='session.lock');
}
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
    assert.deepEqual(nonLockEntries(path.dirname(targetPath)),[path.basename(targetPath)],'zero foreign files allowed inside DSH session dir');

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
      assert.deepEqual(nonLockEntries(path.dirname(targetPath)),[path.basename(targetPath)],'zero foreign files after backup restore');
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
    assert.deepEqual(nonLockEntries(path.dirname(targetPath)),[path.basename(targetPath)]);

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
await test('native-transaction-zstd-disk-liveness-zero-empty-spins-and-reopen',async()=>{
  const workspaceDir=fs.mkdtempSync(path.join(process.env.WEAVE_TEST_ROOT??os.tmpdir(),'weave-v4-disk-'));
  try{
    fs.mkdirSync(path.join(workspaceDir,'src'),{recursive:true});
    const existingFile=path.join(workspaceDir,'src','existing.js');
    const deletedFile=path.join(workspaceDir,'src','deleted-deliverable.js');
    const oldTime=new Date(Date.now()-120000);
    fs.writeFileSync(existingFile,'export const ok = true;\n','utf8');
    fs.utimesSync(existingFile,oldTime,oldTime);
    fs.writeFileSync(deletedFile,'export const temp = true;\n','utf8');
    fs.unlinkSync(deletedFile);

    const f=await fixture({compression:'zstd',seedDefaultTurn:false,cwd:workspaceDir});
    try{
      assert.equal(f.session.header.cwd,workspaceDir);
      f.session.append('turn/start',{turn:1});
      f.session.append('step/start',{turn:1,step:1});
      f.add('system','Stable system prefix.',1,1);
      f.add('user','Continue the test task.',1,1);
      const callKeep='call-disk-keep-1',callDeleted='call-disk-del-1';
      f.session.append('assistant/message',{turn:1,step:1,stream:[],usage:{inputTokens:0,outputTokens:0},message:{
        id:randomUUID(),role:'assistant',source:{kind:'model',provider:'p',model:'m'},
        content:[
          {type:'tool-call',id:callKeep,name:'read_file',arguments:JSON.stringify({path:'src/existing.js'})},
          {type:'tool-call',id:callDeleted,name:'write_file',arguments:JSON.stringify({path:'src/deleted-deliverable.js'})},
        ],
      }},{surfaceOp:'append'});
      const tcKeep=f.session.append('tool/call',{turn:1,step:1,callId:callKeep,name:'read_file',arguments:JSON.stringify({path:'src/existing.js'})});
      f.session.append('tool/result',{turn:1,step:1,message:{
        id:randomUUID(),role:'tool',toolCallId:callKeep,source:{kind:'tool',callId:callKeep},
        content:[{type:'text',text:'export const ok = true;\n'}],
      }},{surfaceOp:'append',sourceEventSeqs:[tcKeep.seq]});
      const tcDeleted=f.session.append('tool/call',{turn:1,step:1,callId:callDeleted,name:'write_file',arguments:JSON.stringify({path:'src/deleted-deliverable.js'})});
      f.session.append('tool/result',{turn:1,step:1,message:{
        id:randomUUID(),role:'tool',toolCallId:callDeleted,source:{kind:'tool',callId:callDeleted},
        content:[{type:'text',text:'Wrote src/deleted-deliverable.js'}],
      }},{surfaceOp:'append',sourceEventSeqs:[tcDeleted.seq]});
      f.session.append('step/end',{turn:1,step:1});
      f.session.append('step/start',{turn:1,step:2});
      f.add('assistant','Work notes for deliverables. '.repeat(2500),1,2);
      f.session.append('step/end',{turn:1,step:2});
      f.session.append('turn/end',{turn:1});
      await f.store.flush(f.session);

      const targetPath=f.backend.locate(f.session.header).path;
      assert.ok(targetPath.endsWith('.v4.jsonl.zstd'),`expected .v4.jsonl.zstd, got ${targetPath}`);

      const result=await f.compact();
      assert.ok(result.compactionId);
      assert.equal(f.calls(),1);
      assert.deepEqual([...fs.readFileSync(targetPath).subarray(0,4)],[0x28,0xb5,0x2f,0xfd],'must persist a real Zstandard frame');

      const checkpoint=f.session.deriveEventMessage(f.session.eventAt(f.session.surface.nodes.at(-1)));
      const cpText=blocksToText(checkpoint.content);
      const diskMatch=cpText.match(/<disk-state-check\b[^>]*>[\s\S]*?<\/disk-state-check>/);
      assert.ok(diskMatch,`expected <disk-state-check> in checkpoint:\n${cpText}`);
      assert.ok(diskMatch[0].includes('src/deleted-deliverable.js'),'deleted deliverable must be listed in <disk-state-check>');
      assert.ok(!diskMatch[0].includes('src/existing.js'),'existing unchanged file must not be listed in <disk-state-check>');

      const events=f.session.snapshotEvents();
      const startCount=events.filter(e=>e.type==='compaction/start').length;
      const summaryCount=events.filter(e=>e.type==='compaction/summary').length;
      const endCount=events.filter(e=>e.type==='compaction/end').length;
      assert.equal(startCount,1);
      assert.equal(startCount,summaryCount);
      assert.equal(summaryCount,endCount);

      assert.deepEqual(nonLockEntries(path.dirname(targetPath)),[path.basename(targetPath)],'zero leftover plugin files allowed inside DSH session dir');
      assert.equal((await f.engine.journal.pending(f.session.id)).length,0);

      const expectedEvents=events;
      const expectedNodes=[...f.session.surface.nodes];
      f.detach();
      await f.closeHandle();

      const reopened=await f.backend.open(f.session.id,'write');
      try{
        const stored=await reopened.read();
        assert.deepEqual(stored.events,expectedEvents);
        const replay=Session.fromRestore(f.session.id,stored.events,reopened.header,reopened.inheritedEventCount,'detached',f.store.messageProjections);
        assert.deepEqual(replay.surface.nodes,expectedNodes);
        assert.equal(replay.header.cwd,workspaceDir);
      }finally{await reopened.close();}
    }finally{await f.close();}
  }finally{fs.rmSync(workspaceDir,{recursive:true,force:true});}
});
await test('native-transaction-zstd-phase-a-reinject-focus-and-cordis-hooks-reopen',async()=>{
  const workspaceDir=fs.mkdtempSync(path.join(process.env.WEAVE_TEST_ROOT??os.tmpdir(),'weave-v4-phase-a-'));
  try{
    fs.mkdirSync(path.join(workspaceDir,'src'),{recursive:true});
    const appFile=path.join(workspaceDir,'src','billing.js');
    fs.writeFileSync(appFile,'export const PRECISION = "integer-cents";\n','utf8');
    fs.writeFileSync(path.join(workspaceDir,'AGENTS.md'),'HOST_RESIDENT_MUST_SKIP\n','utf8');
    fs.writeFileSync(path.join(workspaceDir,'.env'),'API_SECRET=must-never-reinject\n','utf8');

    const f=await fixture({compression:'zstd',seedDefaultTurn:false,cwd:workspaceDir});
    let siblingPlugin;
    try{
      // Wire real Cordis root Context so sibling plugin listeners receive weave/pre-compact & weave/post-compact!
      f.engine.ctx.root=f.root;
      const seenPre=[],seenPost=[];
      let lastRequestText='';
      const origStream=f.engine.ctx.llm.stream;
      f.engine.ctx.llm.stream=async function*(req){
        lastRequestText=blocksToText(req?.messages?.at?.(-1)?.content);
        for await(const chunk of origStream(req))yield chunk;
      };
      siblingPlugin=f.root.plugin({
        name:'phase-a-sibling-hooks',
        apply(pctx){
          pctx.on('weave/pre-compact',payload=>{
            seenPre.push(payload);
            return {additionalContext:'sibling-hook-v4-note'};
          });
          pctx.on('weave/post-compact',payload=>{
            seenPost.push(payload);
            return {notice:'post-hook-ok'};
          });
        },
      });
      await siblingPlugin.await();

      f.session.append('turn/start',{turn:1});
      f.session.append('step/start',{turn:1,step:1});
      f.add('system','Stable system prefix.',1,1);
      f.add('user','Continue the test task.',1,1);
      const callWrite='call-phasea-write-1',callAgents='call-phasea-agents-1',callEnv='call-phasea-env-1';
      f.session.append('assistant/message',{turn:1,step:1,stream:[],usage:{inputTokens:0,outputTokens:0},message:{
        id:randomUUID(),role:'assistant',source:{kind:'model',provider:'p',model:'m'},
        content:[
          {type:'tool-call',id:callWrite,name:'write_file',arguments:JSON.stringify({path:'src/billing.js'})},
          {type:'tool-call',id:callAgents,name:'read_file',arguments:JSON.stringify({path:'AGENTS.md'})},
          {type:'tool-call',id:callEnv,name:'read_file',arguments:JSON.stringify({path:'.env'})},
        ],
      }},{surfaceOp:'append'});
      const tcWrite=f.session.append('tool/call',{turn:1,step:1,callId:callWrite,name:'write_file',arguments:JSON.stringify({path:'src/billing.js'})});
      f.session.append('tool/result',{turn:1,step:1,message:{
        id:randomUUID(),role:'tool',toolCallId:callWrite,source:{kind:'tool',callId:callWrite},
        content:[{type:'text',text:'Wrote src/billing.js'}],
      }},{surfaceOp:'append',sourceEventSeqs:[tcWrite.seq]});
      const tcAgents=f.session.append('tool/call',{turn:1,step:1,callId:callAgents,name:'read_file',arguments:JSON.stringify({path:'AGENTS.md'})});
      f.session.append('tool/result',{turn:1,step:1,message:{
        id:randomUUID(),role:'tool',toolCallId:callAgents,source:{kind:'tool',callId:callAgents},
        content:[{type:'text',text:'Read AGENTS.md'}],
      }},{surfaceOp:'append',sourceEventSeqs:[tcAgents.seq]});
      const tcEnv=f.session.append('tool/call',{turn:1,step:1,callId:callEnv,name:'read_file',arguments:JSON.stringify({path:'.env'})});
      f.session.append('tool/result',{turn:1,step:1,message:{
        id:randomUUID(),role:'tool',toolCallId:callEnv,source:{kind:'tool',callId:callEnv},
        content:[{type:'text',text:'Read .env'}],
      }},{surfaceOp:'append',sourceEventSeqs:[tcEnv.seq]});
      f.session.append('step/end',{turn:1,step:1});
      f.session.append('step/start',{turn:1,step:2});
      f.add('assistant','Detailed work trace for billing module. '.repeat(2500),1,2);
      f.session.append('step/end',{turn:1,step:2});
      f.session.append('turn/end',{turn:1});
      f.session.append('turn/start',{turn:2});
      f.session.append('step/start',{turn:2,step:1});
      f.add('user','Ready for the next step.',2,1);
      f.add('assistant','Acknowledged, ready to proceed.',2,1);
      f.session.append('step/end',{turn:2,step:1});
      f.session.append('turn/end',{turn:2});
      await f.store.flush(f.session);

      const targetPath=f.backend.locate(f.session.header).path;
      assert.ok(targetPath.endsWith('.v4.jsonl.zstd'),`expected .v4.jsonl.zstd, got ${targetPath}`);

      const result=await f.engine.compactNow(
        f.agent,
        new AbortController().signal,
        'cmd-v4-phase-a',
        false,
        {focusInstruction:'prioritize integer-cents billing'},
      );
      assert.ok(result?.compactionId);
      assert.equal(f.calls(),1);
      assert.deepEqual([...fs.readFileSync(targetPath).subarray(0,4)],[0x28,0xb5,0x2f,0xfd],'must persist a real Zstandard frame');

      assert.equal(seenPre.length,1,'real Cordis sibling plugin must receive weave/pre-compact once');
      assert.equal(seenPost.length,1,'real Cordis sibling plugin must receive weave/post-compact once');
      assert.equal(seenPre[0].sessionId,f.session.id);
      assert.equal(seenPre[0].manual,true);
      assert.equal(seenPre[0].focusInstruction,'prioritize integer-cents billing');
      assert.equal(seenPost[0].compactionId,result.compactionId);
      assert.ok(lastRequestText.includes('prioritize integer-cents billing'),'focusInstruction must reach LLM prompt');
      assert.ok(lastRequestText.includes('sibling-hook-v4-note'),'pre-compact hook additionalContext must reach LLM prompt');

      const cpSeq=f.session.surface.nodes.find(seq=>f.session.deriveEventMessage(f.session.eventAt(seq))?.source?.kind==='compact-checkpoint');
      assert.ok(typeof cpSeq==='number','expected compact-checkpoint on live surface');
      const checkpoint=f.session.deriveEventMessage(f.session.eventAt(cpSeq));
      const cpText=blocksToText(checkpoint.content);
      assert.match(cpText,/<active-workspace-files\b[^>]*scope="local-workspace">/);
      assert.ok(cpText.includes('path="src/billing.js"'),'edited billing.js must be reinjected');
      assert.ok(cpText.includes('PRECISION = "integer-cents"'),'fresh disk content must be embedded');
      assert.ok(!cpText.includes('HOST_RESIDENT_MUST_SKIP'),'AGENTS.md must be excluded');
      assert.ok(!cpText.includes('must-never-reinject'),'.env secret must be excluded');

      assert.deepEqual(nonLockEntries(path.dirname(targetPath)),[path.basename(targetPath)],'zero leftover plugin files allowed inside DSH session dir');
      assert.equal((await f.engine.journal.pending(f.session.id)).length,0);

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
        const replayedCp=replay.deriveEventMessage(replay.eventAt(cpSeq));
        assert.match(blocksToText(replayedCp.content),/<active-workspace-files\b[^>]*>/);
        assert.ok(blocksToText(replayedCp.content).includes('PRECISION = "integer-cents"'));
      }finally{await reopened.close();}
    }finally{
      if(siblingPlugin)await siblingPlugin.dispose();
      await f.close();
    }
  }finally{fs.rmSync(workspaceDir,{recursive:true,force:true});}
});
await test('native-transaction-zstd-phase-b-persisted-output-and-microcompact-reopen',async()=>{
  const f=await fixture({compression:'zstd',seedDefaultTurn:false});
  const realNow=Date.now;
  let phaseBEngine=null;
  try{
    const hooks=new Map();
    let llmCalls=0;
    const phaseBCtx={
      on(name,fn){hooks.set(name,fn);return ()=>hooks.delete(name);},
      provide(){},
      get(){return undefined;},
      logger:{info(){},warn(){}},
      sessions:{flush:s=>f.store.flush(s),get:id=>f.store.get(id)},
      sessionPersistence:f.backend,
      tokenMeter:{
        measure(s){
          const nodes=s.surface.nodes.map(seq=>{
            const tokens=Math.max(1,approxTokens(blocksToText(s.deriveEventMessage(s.eventAt(seq))?.content)));
            return {seq,tokens,heuristicTokens:tokens};
          });
          return {nodes,totalTokens:nodes.reduce((n,x)=>n+x.tokens,0),baseline:{kind:'heuristic'}};
        },
        estimateMessage(m){return Math.max(1,approxTokens(blocksToText(m?.content)));},
      },
      llm:{
        async resolveModelInfo(){return {contextWindow:200000,maxOutputTokens:4096};},
        async *stream(){llmCalls++;yield {type:'text-delta',text:summary};yield {type:'finish',kind:'stop'};},
      },
    };
    const cfg=resolveConfig({
      archiveDir:path.join(f.directory,'weave-phase-b','archive'),
      language:'en',
      auto:false,
      proactiveEnabled:false,
      idleCompactionMinutes:30,
      persistedOutputEnabled:true,
      persistedOutputThresholdChars:32768,
      persistedOutputHeadChars:1200,
      persistedOutputTailChars:1200,
      microcompactEnabled:true,
      microcompactKeepRecentTools:2,
      microcompactThresholdChars:2000,
      microcompactHeadChars:200,
      microcompactTailChars:200,
      microcompactRepeatedReadMinChars:2000,
      minimumReductionRatio:0.2,
      idleFullSummaryEnabled:true,
    }).config;
    phaseBEngine=new WeaveCompactionEngine(phaseBCtx,cfg);
    phaseBEngine.transactionAdapter=f.adapter;
    phaseBEngine.requireTransactionAdapter=true;
    phaseBEngine.historyToolsAvailable=true;

    const agent={
      session:f.session,
      inbox:{nextStep:[],nextTurn:[],prepend(target,m){this.nextStep.unshift(m);}},
      options:{provider:'p',model:'m'},
      runMaintenance:fn=>fn(new AbortController().signal),
    };
    const preStep=hooks.get('agent/pre-step');
    assert.equal(typeof preStep,'function');

    const dupOldText='V4_DUP_OLD_V1_'+'D'.repeat(6000);
    const oldShellText='V4_OLD_SHELL_HEAD_'+'S'.repeat(6000)+'_V4_OLD_SHELL_TAIL';
    const dupNewText='V4_DUP_NEW_V2_'+'N'.repeat(2500);
    const hugeTailText='V4_TAIL_SPILL_HEAD_'+'X'.repeat(38000)+'_V4_TAIL_SPILL_TAIL';

    let trDupOld,trOldShell,trDupNew,trHugeTail;
    const callDupOld='call-v4-dup-old',callOldShell='call-v4-old-shell',callDupNew='call-v4-dup-new',callHugeTail='call-v4-huge-tail';

    // Turn 1 runs 40 minutes ago: test Persisted-Output tail spill against real DSH V4 Session.append!
    Date.now=()=>realNow()-40*60_000;
    try{
      f.session.append('turn/start',{turn:1});
      f.session.append('step/start',{turn:1,step:1});
      f.add('system','Stable system prefix.',1,1);
      f.add('user','Inspect workspace logs and source files.',1,1);
      f.session.append('assistant/message',{turn:1,step:1,stream:[],usage:{inputTokens:0,outputTokens:0},message:{
        id:randomUUID(),role:'assistant',source:{kind:'model',provider:'p',model:'m'},
        content:[
          {type:'tool-call',id:callDupOld,name:'read_file',arguments:JSON.stringify({path:'src/dup.js'})},
          {type:'tool-call',id:callOldShell,name:'run_command',arguments:JSON.stringify({command:'npm run lint'})},
        ],
      }},{surfaceOp:'append'});
      const tcDupOld=f.session.append('tool/call',{turn:1,step:1,callId:callDupOld,name:'read_file',arguments:JSON.stringify({path:'src/dup.js'})});
      trDupOld=f.session.append('tool/result',{turn:1,step:1,message:{
        id:randomUUID(),role:'tool',toolCallId:callDupOld,source:{kind:'tool',callId:callDupOld},
        content:[{type:'text',text:dupOldText}],
      }},{surfaceOp:'append',sourceEventSeqs:[tcDupOld.seq]});
      const tcOldShell=f.session.append('tool/call',{turn:1,step:1,callId:callOldShell,name:'run_command',arguments:JSON.stringify({command:'npm run lint'})});
      trOldShell=f.session.append('tool/result',{turn:1,step:1,message:{
        id:randomUUID(),role:'tool',toolCallId:callOldShell,source:{kind:'tool',callId:callOldShell},
        content:[{type:'text',text:oldShellText}],
      }},{surfaceOp:'append',sourceEventSeqs:[tcOldShell.seq]});
      f.session.append('step/end',{turn:1,step:1});

      f.session.append('step/start',{turn:1,step:2});
      f.session.append('assistant/message',{turn:1,step:2,stream:[],usage:{inputTokens:0,outputTokens:0},message:{
        id:randomUUID(),role:'assistant',source:{kind:'model',provider:'p',model:'m'},
        content:[
          {type:'tool-call',id:callDupNew,name:'read_file',arguments:JSON.stringify({path:'src/dup.js'})},
          {type:'tool-call',id:callHugeTail,name:'run_command',arguments:JSON.stringify({command:'cat huge.log'})},
        ],
      }},{surfaceOp:'append'});
      const tcDupNew=f.session.append('tool/call',{turn:1,step:2,callId:callDupNew,name:'read_file',arguments:JSON.stringify({path:'src/dup.js'})});
      trDupNew=f.session.append('tool/result',{turn:1,step:2,message:{
        id:randomUUID(),role:'tool',toolCallId:callDupNew,source:{kind:'tool',callId:callDupNew},
        content:[{type:'text',text:dupNewText}],
      }},{surfaceOp:'append',sourceEventSeqs:[tcDupNew.seq]});
      const tcHugeTail=f.session.append('tool/call',{turn:1,step:2,callId:callHugeTail,name:'run_command',arguments:JSON.stringify({command:'cat huge.log'})});
      trHugeTail=f.session.append('tool/result',{turn:1,step:2,message:{
        id:randomUUID(),role:'tool',toolCallId:callHugeTail,source:{kind:'tool',callId:callHugeTail},
        content:[{type:'text',text:hugeTailText}],
      }},{surfaceOp:'append',sourceEventSeqs:[tcHugeTail.seq]});

      // Fire real agent/pre-step inside open Turn 1 right after Step 2 tool results landed -> Persisted-Output spills hugeTail!
      let step1Entered=false;
      await preStep({agent,signal:new AbortController().signal,messages:[]},async()=>{step1Entered=true;return {kind:'enter'};});
      assert.equal(step1Entered,true);
      assert.equal(llmCalls,0);
      // Historical step 1 tool results untouched; huge tail spilled!
      assert.ok(f.session.surface.nodes.includes(trDupOld.seq),'prior step dup read must stay untouched by Persisted-Output');
      assert.ok(f.session.surface.nodes.includes(trOldShell.seq),'prior step shell must stay untouched by Persisted-Output');
      assert.ok(f.session.surface.nodes.includes(trDupNew.seq),'under-threshold tail read must stay untouched');
      assert.ok(!f.session.surface.nodes.includes(trHugeTail.seq),'huge tail tool/result must be spilled');

      f.session.append('step/end',{turn:1,step:2});
      f.session.append('step/start',{turn:1,step:3});
      f.add('assistant','Turn 1 complete.',1,3);
      f.session.append('step/end',{turn:1,step:3});
      f.session.append('turn/end',{turn:1});
      await f.store.flush(f.session);
    }finally{
      Date.now=realNow;
    }

    // Turn 2 arrives 40 minutes later -> Time-Based Microcompact folds dupOld + oldShell with 0 LLM calls!
    const resumeMsg={id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:'Resume after 40 minutes.'}]};
    f.session.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:0,inserted:[resumeMsg]});
    f.session.append('turn/start',{turn:2});
    let step2Entered=false;
    await preStep({agent,signal:new AbortController().signal,messages:[resumeMsg]},async()=>{step2Entered=true;return {kind:'enter'};});
    assert.equal(step2Entered,true);
    assert.equal(llmCalls,0,'Time-Based Microcompact must skip full idle LLM summary (0 LLM calls)');
    f.session.append('step/start',{turn:2,step:1});
    f.add('assistant','Continuing cleanly after microcompact.',2,1);
    f.session.append('step/end',{turn:2,step:1});
    f.session.append('turn/end',{turn:2});
    await f.store.flush(f.session);

    const targetPath=f.backend.locate(f.session.header).path;
    assert.ok(targetPath.endsWith('.v4.jsonl.zstd'),`expected .v4.jsonl.zstd, got ${targetPath}`);
    assert.deepEqual([...fs.readFileSync(targetPath).subarray(0,4)],[0x28,0xb5,0x2f,0xfd],'must persist a real Zstandard frame');

    // Verify all 3 rewritten tool results + preserved hot tool result on live surface AND exact archived originals!
    const findToolText=(callId)=>{
      const seq=f.session.surface.nodes.find(s=>{
        const ev=f.session.eventAt(s);
        return ev?.type==='tool/result'&&ev.data?.message?.toolCallId===callId;
      });
      assert.ok(typeof seq==='number',`expected live tool/result for ${callId}`);
      return blocksToText(f.session.deriveEventMessage(f.session.eventAt(seq)).content);
    };
    const spilledStub=findToolText(callHugeTail);
    const dupStub=findToolText(callDupOld);
    const shellStub=findToolText(callOldShell);
    const hotDupText=findToolText(callDupNew);

    assert.ok(spilledStub.includes(PERSISTED_OUTPUT_MARKER),'huge tail must have PERSISTED_OUTPUT_MARKER');
    assert.ok(spilledStub.includes('V4_TAIL_SPILL_HEAD_')&&spilledStub.includes('_V4_TAIL_SPILL_TAIL'));
    assert.ok(dupStub.includes(MICROCOMPACT_SUPERSEDED_MARKER),'older duplicate read must have MICROCOMPACT_SUPERSEDED_MARKER');
    assert.ok(shellStub.includes(OBSERVATION_MASK_MARKER),'older oversized shell must have OBSERVATION_MASK_MARKER');
    assert.equal(hotDupText,dupNewText,'newest hot read must stay verbatim on surface');

    const spillId=/compactionId:\s*"([^"]+)"/.exec(spilledStub)?.[1];
    const microId=/compactionId:\s*"([^"]+)"/.exec(dupStub)?.[1];
    assert.ok(spillId&&microId);
    const spillArchive=await phaseBEngine.archive.readSpan(f.session.id,spillId);
    assert.equal(spillArchive.ok,true);
    assert.equal(spillArchive.entries.find(e=>e.seq===trHugeTail.seq)?.text,hugeTailText);
    const microArchive=await phaseBEngine.archive.readSpan(f.session.id,microId);
    assert.equal(microArchive.ok,true);
    assert.equal(microArchive.entries.find(e=>e.seq===trDupOld.seq)?.text,dupOldText);
    assert.equal(microArchive.entries.find(e=>e.seq===trOldShell.seq)?.text,oldShellText);

    assert.deepEqual(nonLockEntries(path.dirname(targetPath)),[path.basename(targetPath)],'zero leftover plugin files allowed inside DSH session dir');

    // Reopen from real .v4.jsonl.zstd and verify exact Session.fromRestore replay!
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
    }finally{await reopened.close();}
  }finally{
    Date.now=realNow;
    phaseBEngine?.dispose();
    await f.close();
  }
});
await test('native-transaction-zstd-phase-c-session-memory-reuse-prestep-and-reopen',async()=>{
  const f=await fixture({compression:'zstd',seedDefaultTurn:false});
  let phaseCEngine=null;
  try{
    const hooks=new Map();
    let llmCalls=0;
    const smSummary=['Primary Request and Intent','Key Technical Concepts','Files and Code Sections','Errors and Fixes','Problem Solving','All User Messages','Pending Tasks','Work Completed','Context for Continuing Work']
      .map((h,i)=>`## ${i+1}. ${h}\n${i===0?'Preserve integer cents in all ledgers.':i===5?'[filled by engine]':i===8?'Keep integer cents in all ledgers and continue cleanly.':'(none)'}`).join('\n\n');
    const phaseCCtx={
      on(name,fn){if(!hooks.has(name))hooks.set(name,[]);hooks.get(name).push(fn);return ()=>{};},
      provide(){},
      get(){return undefined;},
      logger:{info(){},warn(){}},
      sessions:{flush:s=>f.store.flush(s),get:id=>f.store.get(id)},
      sessionPersistence:f.backend,
      tokenMeter:{
        measure(s){
          const nodes=s.surface.nodes.map(seq=>{
            const tokens=Math.max(1,approxTokens(blocksToText(s.deriveEventMessage(s.eventAt(seq))?.content)));
            return {seq,tokens,heuristicTokens:tokens};
          });
          return {nodes,totalTokens:nodes.reduce((n,x)=>n+x.tokens,0),baseline:{kind:'heuristic'}};
        },
        estimateMessage(m){return Math.max(1,approxTokens(blocksToText(m?.content)));},
      },
      llm:{
        async resolveModelInfo(){return {contextWindow:65536,maxOutputTokens:4096};},
        async *stream(){llmCalls++;yield {type:'text-delta',text:smSummary};yield {type:'finish',kind:'stop',usage:{inputTokens:100,outputTokens:50}};},
      },
    };
    const cfg=resolveConfig({
      archiveDir:path.join(f.directory,'weave-phase-c-sm','archive'),
      language:'en',
      auto:true,
      proactiveEnabled:false,
      headroomTokens:4096,
      thresholdRatio:0.25, // ~14336 tok threshold
      retainTokens:2048,
      cachePreservePrefix:false,
      summaryRetryCount:0,
      summaryConcurrency:1,
      sessionMemoryEnabled:true,
      sessionMemoryMinTokens:4096,
      sessionMemoryUpdateIntervalTokens:50000,
      sessionMemoryUpdateIntervalTurns:10,
      sessionMemoryCooldownMs:0,
    }).config;
    phaseCEngine=new WeaveCompactionEngine(phaseCCtx,cfg);
    f.adapter.register(phaseCEngine.journal,phaseCEngine.sessionState,cfg.failureThreshold,phaseCEngine.backupStore);
    phaseCEngine.transactionAdapter=f.adapter;
    phaseCEngine.requireTransactionAdapter=true;
    phaseCEngine.historyToolsAvailable=true;

    const agent={
      session:f.session,
      inbox:{nextStep:[],nextTurn:[],prepend(_t,m){this.nextStep.unshift(m);}},
      options:{provider:'p',model:'m'},
      runMaintenance:fn=>fn(new AbortController().signal),
    };

    // Turn 1: seed multi-message prefix + retained tail, then settle via agent/status: 'idle'
    f.session.append('turn/start',{turn:1});
    f.session.append('step/start',{turn:1,step:1});
    f.add('system','Stable system prefix.',1,1);
    f.add('user','Preserve integer cents in all ledgers.',1,1);
    f.add('assistant','Ledger work phase 1. '.repeat(680),1,1); // ~3500 tok
    f.add('user','Continue ledger validation.',1,1);
    f.add('assistant','Ledger work phase 2. '.repeat(680),1,1); // ~3500 tok
    f.add('user','Finish ledger migration.',1,1);
    f.add('assistant','Ledger work phase 3. '.repeat(680),1,1); // ~3500 tok
    const midTailU=f.add('user','Mid tail note. '.repeat(320),1,1); // ~1200 tok
    const midTailA=f.add('assistant','Mid tail reply. '.repeat(320),1,1); // ~1200 tok
    f.session.append('step/end',{turn:1,step:1});
    f.session.append('turn/end',{turn:1});
    await f.store.flush(f.session);

    for(const fn of hooks.get('agent/status')??[])fn({agent,status:'idle'});
    for(let i=0;i<15;i++){
      await new Promise(r=>setTimeout(r,15));
      const p=phaseCEngine.sessionMemory.waitFor(f.session.id);
      if(p)await p;
      if(!phaseCEngine.sessionMemory.inFlight.has(f.session.id)&&!phaseCEngine.sessionMemory._scheduling.has(f.session.id))break;
    }
    assert.equal(llmCalls,1,'settled idle turn must trigger exactly 1 background session memory call');
    const readyStatus=phaseCEngine.sessionMemoryStatusFor(f.session.id);
    assert.equal(readyStatus.ready,true);
    assert.equal(readyStatus.callsUsed,1);
    assert.ok(Number.isSafeInteger(readyStatus.coveredThroughSeq));

    // Turn 2: add critical tail constraint + final tail pushing over pressure threshold -> real agent/pre-step!
    f.session.append('turn/start',{turn:2});
    f.session.append('step/start',{turn:2,step:1});
    const tailRule=f.add('user','TAIL_V4_RULE: Never expose raw API secrets in logs.',2,1);
    const tailReply=f.add('assistant','Acknowledged TAIL_V4_RULE. '.repeat(80),2,1);
    f.add('user','Final turn input. '.repeat(320),2,1);
    f.add('assistant','Final turn response. '.repeat(320),2,1);

    let enteredMain=false;
    const preStep=(hooks.get('agent/pre-step')??[])[0];
    assert.equal(typeof preStep,'function');
    await preStep({agent,signal:new AbortController().signal,messages:[]},async()=>{enteredMain=true;return {kind:'enter'};});
    assert.equal(enteredMain,true);
    assert.equal(llmCalls,1,'foreground pressure compaction must reuse verified session memory prefix with 0 additional LLM calls');

    // Verify TAIL_V4_RULE and midTail nodes survived verbatim on live surface!
    assert.ok(f.session.surface.nodes.includes(midTailU.seq));
    assert.ok(f.session.surface.nodes.includes(midTailA.seq));
    assert.ok(f.session.surface.nodes.includes(tailRule.seq),'tail rule after watermark must stay verbatim on live surface');
    assert.ok(f.session.surface.nodes.includes(tailReply.seq));

    // Verify emitted compaction/summary omits llmStreamCall (DSH V4 compliance) & archive verifies!
    const cpSeq=f.session.surface.nodes.find(seq=>f.session.deriveEventMessage(f.session.eventAt(seq))?.source?.kind==='compact-checkpoint');
    assert.ok(typeof cpSeq==='number','expected committed compact-checkpoint');
    const cpId=f.session.deriveEventMessage(f.session.eventAt(cpSeq)).source.compactionId;
    const summaryEv=f.session.snapshotEvents().find(e=>e.type==='compaction/summary'&&e.data?.compactionId===cpId);
    assert.ok(summaryEv);
    assert.equal('llmStreamCall' in summaryEv.data,false,'reused session-memory compaction/summary must omit llmStreamCall');
    const archived=await phaseCEngine.archive.readSpan(f.session.id,cpId);
    assert.equal(archived.ok,true);
    assert.ok(archived.entries.some(e=>e.text.includes('Preserve integer cents in all ledgers.')));

    // Stored memory invalidated while monotonic callsUsed fuse remains 1!
    const postStatus=phaseCEngine.sessionMemoryStatusFor(f.session.id);
    assert.equal(postStatus.ready,false);
    assert.equal(postStatus.callsUsed,1);

    f.session.append('step/end',{turn:2,step:1});
    f.session.append('turn/end',{turn:2});
    await f.store.flush(f.session);

    const targetPath=f.backend.locate(f.session.header).path;
    assert.ok(targetPath.endsWith('.v4.jsonl.zstd'));
    assert.deepEqual([...fs.readFileSync(targetPath).subarray(0,4)],[0x28,0xb5,0x2f,0xfd]);
    assert.deepEqual(nonLockEntries(path.dirname(targetPath)),[path.basename(targetPath)]);
    assert.equal((await phaseCEngine.journal.pending(f.session.id)).length,0);

    // Cold reopen through real DSH V4 Zstandard decoder + Session.fromRestore!
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
    }finally{await reopened.close();}
  }finally{
    phaseCEngine?.dispose();
    await f.close();
  }
});
await test('native-transaction-zstd-phase-c-expired-ttl-context-collapse-and-reopen',async()=>{
  const f=await fixture({compression:'zstd',seedDefaultTurn:false});
  const realNow=Date.now;
  let phaseCEngine=null;
  try{
    const hooks=new Map();
    let llmCalls=0;
    const collapseSummary=['Primary Request and Intent','Key Technical Concepts','Files and Code Sections','Errors and Fixes','Problem Solving','All User Messages','Pending Tasks','Work Completed','Context for Continuing Work']
      .map((h,i)=>`## ${i+1}. ${h}\n${i===0?'Keep WAL checkpointing enabled.':i===5?'[filled by engine]':i===8?'Keep WAL checkpointing enabled and continue cleanly.':'(none)'}`).join('\n\n');
    const phaseCCtx={
      on(name,fn){if(!hooks.has(name))hooks.set(name,[]);hooks.get(name).push(fn);return ()=>{};},
      provide(){},
      get(){return undefined;},
      logger:{info(){},warn(){}},
      sessions:{flush:s=>f.store.flush(s),get:id=>f.store.get(id)},
      sessionPersistence:f.backend,
      tokenMeter:{
        measure(s){
          const nodes=s.surface.nodes.map(seq=>{
            const tokens=Math.max(1,approxTokens(blocksToText(s.deriveEventMessage(s.eventAt(seq))?.content)));
            return {seq,tokens,heuristicTokens:tokens};
          });
          return {nodes,totalTokens:nodes.reduce((n,x)=>n+x.tokens,0),baseline:{kind:'heuristic'}};
        },
        estimateMessage(m){return Math.max(1,approxTokens(blocksToText(m?.content)));},
      },
      llm:{
        async resolveModelInfo(){return {contextWindow:200000,maxOutputTokens:4096};},
        async *stream(){llmCalls++;yield {type:'text-delta',text:collapseSummary};yield {type:'finish',kind:'stop',usage:{inputTokens:100,outputTokens:50}};},
      },
    };
    const cfg=resolveConfig({
      archiveDir:path.join(f.directory,'weave-phase-c-cc','archive'),
      language:'en',
      auto:false,
      proactiveEnabled:false,
      idleCompactionMinutes:30,
      minimumReductionRatio:0.2,
      microcompactEnabled:true,
      microcompactKeepRecentTools:2,
      microcompactThresholdChars:2000,
      microcompactHeadChars:200,
      microcompactTailChars:200,
      microcompactRepeatedReadMinChars:2000,
      contextCollapseEnabled:true,
      contextCollapseMinTokens:8192,
      contextCollapseMaxSpanTokens:16384,
      contextCollapseKeepRecentTokens:2048,
      contextCollapseKeepRecentTurns:2,
      idleFullSummaryEnabled:true,
    }).config;
    phaseCEngine=new WeaveCompactionEngine(phaseCCtx,cfg);
    f.adapter.register(phaseCEngine.journal,phaseCEngine.sessionState,cfg.failureThreshold,phaseCEngine.backupStore);
    phaseCEngine.transactionAdapter=f.adapter;
    phaseCEngine.requireTransactionAdapter=true;
    phaseCEngine.historyToolsAvailable=true;

    const agent={
      session:f.session,
      inbox:{nextStep:[],nextTurn:[],prepend(_t,m){this.nextStep.unshift(m);}},
      options:{provider:'p',model:'m'},
      runMaintenance:fn=>fn(new AbortController().signal),
    };
    const preStep=(hooks.get('agent/pre-step')??[])[0];
    assert.equal(typeof preStep,'function');

    let oldU1,tailU1,tailA1,tailU2,tailA2;
    const callOld='call-v4-cc-old',callHot1='call-v4-cc-hot1',callHot2='call-v4-cc-hot2';
    Date.now=()=>realNow()-45*60_000;
    try{
      f.session.append('turn/start',{turn:1});
      f.session.append('step/start',{turn:1,step:1});
      f.add('system','Stable system prefix.',1,1);
      oldU1=f.add('user','Keep WAL checkpointing enabled. '+'P1 '.repeat(2000),1,1);
      f.add('assistant','Old phase 1 analysis. '+'A1 '.repeat(2600),1,1);
      f.add('user','Phase 2 detail. '+'P2 '.repeat(2000),1,1);
      f.add('assistant','Old phase 2 analysis. '+'A2 '.repeat(2600),1,1);
      // Old oversized tool output (folded by Tier 1 Microcompact, saving < 20% alone)
      f.session.append('assistant/message',{turn:1,step:1,stream:[],usage:{inputTokens:0,outputTokens:0},message:{
        id:randomUUID(),role:'assistant',source:{kind:'model',provider:'p',model:'m'},
        content:[{type:'tool-call',id:callOld,name:'run_command',arguments:JSON.stringify({command:'npm test'})}],
      }},{surfaceOp:'append'});
      const tcOld=f.session.append('tool/call',{turn:1,step:1,callId:callOld,name:'run_command',arguments:JSON.stringify({command:'npm test'})});
      f.session.append('tool/result',{turn:1,step:1,message:{
        id:randomUUID(),role:'tool',toolCallId:callOld,source:{kind:'tool',callId:callOld},
        content:[{type:'text',text:'V4_CC_OLD_TOOL_'+'X'.repeat(10000)+'_END'}],
      }},{surfaceOp:'append',sourceEventSeqs:[tcOld.seq]});
      f.session.append('step/end',{turn:1,step:1});

      // Protected tail: 2 authentic user turns + 2 hot tools
      f.session.append('step/start',{turn:1,step:2});
      tailU1=f.add('user','Protected tail turn 1. '+'T1 '.repeat(1100),1,2);
      f.session.append('assistant/message',{turn:1,step:2,stream:[],usage:{inputTokens:0,outputTokens:0},message:{
        id:randomUUID(),role:'assistant',source:{kind:'model',provider:'p',model:'m'},
        content:[
          {type:'tool-call',id:callHot1,name:'read_file',arguments:JSON.stringify({path:'src/a.js'})},
          {type:'tool-call',id:callHot2,name:'read_file',arguments:JSON.stringify({path:'src/b.js'})},
        ],
      }},{surfaceOp:'append'});
      const tcH1=f.session.append('tool/call',{turn:1,step:2,callId:callHot1,name:'read_file',arguments:JSON.stringify({path:'src/a.js'})});
      f.session.append('tool/result',{turn:1,step:2,message:{
        id:randomUUID(),role:'tool',toolCallId:callHot1,source:{kind:'tool',callId:callHot1},
        content:[{type:'text',text:'HOT_1_'+'H'.repeat(1200)}],
      }},{surfaceOp:'append',sourceEventSeqs:[tcH1.seq]});
      const tcH2=f.session.append('tool/call',{turn:1,step:2,callId:callHot2,name:'read_file',arguments:JSON.stringify({path:'src/b.js'})});
      f.session.append('tool/result',{turn:1,step:2,message:{
        id:randomUUID(),role:'tool',toolCallId:callHot2,source:{kind:'tool',callId:callHot2},
        content:[{type:'text',text:'HOT_2_'+'K'.repeat(1200)}],
      }},{surfaceOp:'append',sourceEventSeqs:[tcH2.seq]});
      tailA1=f.add('assistant','Protected tail reply 1. '+'R1 '.repeat(1100),1,2);
      tailU2=f.add('user','Protected tail turn 2. '+'T2 '.repeat(1100),1,2);
      tailA2=f.add('assistant','Protected tail reply 2. '+'R2 '.repeat(1100),1,2);
      f.session.append('step/end',{turn:1,step:2});
      f.session.append('turn/end',{turn:1});
      await f.store.flush(f.session);
    }finally{
      Date.now=realNow;
    }

    // Turn 2 arrives 45 minutes later -> Tier 1 Microcompact + Tier 2 Context Collapse -> skips Tier 3!
    const resumeMsg={id:randomUUID(),role:'user',source:{kind:'user'},content:[{type:'text',text:'Resume after 45 minutes.'}]};
    f.session.append('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:0,inserted:[resumeMsg]});
    f.session.append('turn/start',{turn:2});
    let enteredMain=false;
    await preStep({agent,signal:new AbortController().signal,messages:[resumeMsg]},async()=>{enteredMain=true;return {kind:'enter'};});
    assert.equal(enteredMain,true);
    assert.equal(llmCalls,1,'Tier 2 Context Collapse must commit in 1 LLM call and skip Tier 3 Full Idle Summary');

    const collapseCpSeq=f.session.surface.nodes.find(seq=>f.session.deriveEventMessage(f.session.eventAt(seq))?.source?.contextCollapse===true);
    assert.ok(typeof collapseCpSeq==='number','expected Tier 2 Context Collapse checkpoint on surface');
    assert.equal(f.session.surface.nodes.includes(oldU1.seq),false,'older prefix must be collapsed');
    assert.ok(f.session.surface.nodes.includes(tailU1.seq),'protected tail turn 1 must stay verbatim');
    assert.ok(f.session.surface.nodes.includes(tailA1.seq),'protected tail reply 1 must stay verbatim');
    assert.ok(f.session.surface.nodes.includes(tailU2.seq),'protected tail turn 2 must stay verbatim');
    assert.ok(f.session.surface.nodes.includes(tailA2.seq),'protected tail reply 2 must stay verbatim');

    const cpId=f.session.deriveEventMessage(f.session.eventAt(collapseCpSeq)).source.compactionId;
    const archived=await phaseCEngine.archive.readSpan(f.session.id,cpId);
    assert.equal(archived.ok,true);
    assert.ok(archived.entries.some(e=>e.text.includes('Keep WAL checkpointing enabled.')));

    f.session.append('step/start',{turn:2,step:1});
    f.add('assistant','Continuing cleanly after expired-TTL Context Collapse.',2,1);
    f.session.append('step/end',{turn:2,step:1});
    f.session.append('turn/end',{turn:2});
    await f.store.flush(f.session);

    const targetPath=f.backend.locate(f.session.header).path;
    assert.ok(targetPath.endsWith('.v4.jsonl.zstd'));
    assert.deepEqual([...fs.readFileSync(targetPath).subarray(0,4)],[0x28,0xb5,0x2f,0xfd]);
    assert.deepEqual(nonLockEntries(path.dirname(targetPath)),[path.basename(targetPath)]);
    assert.equal((await phaseCEngine.journal.pending(f.session.id)).length,0);

    // Cold reopen from real .v4.jsonl.zstd and verify exact Session.fromRestore replay!
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
    }finally{await reopened.close();}
  }finally{
    Date.now=realNow;
    phaseCEngine?.dispose();
    await f.close();
  }
});

console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));
if(results.some(r=>!r.pass))process.exitCode=1;
