import assert from 'node:assert/strict';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,readFile,readdir} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {WeaveCompactionEngine} from '../lib/engine.js';import {resolveConfig} from '../lib/config.js';import {approxTokens,blocksToText} from '../lib/meter.js';
import {hasContinuation,residentConstraints,sourcePages,continuationEligible,renderRequirements,renderContinuation} from '../lib/continuation.js';import {auditCompaction,sourceConstraintEvidence} from '../lib/audit.js';import {collectRecentUserMessages} from '../lib/region.js';import {__test as toolsTest} from '../lib/tools.js';
const rows=[];async function test(name,fn){try{await fn();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.message,stack:e.stack});}}
const NOTES='## Goal\nContinue the diagnostics.\n## State\nEvidence remains archived.\n## Next\nReview results.\n## Uncertain\nPending runtime verification.';
async function fixture(extra={},response=NOTES){
 const root=await mkdtemp(join(tmpdir(),'weave-cont-'));const events=[];const surface={nodes:[],replaceGeneration:0};
 const session={id:randomUUID(),surface,get seq(){return events.length;},eventAt:i=>events[i],snapshotEvents:()=>events,requestHeader:()=>({config:{provider:'p',model:'m'}}),toolHistory:()=>[],deriveEventMessage(e){return e?.type==='assistant/message'?e.data.message:e?.type==='tool/result'?{role:'tool',content:e.data.content}:e?.type.endsWith('/message')?e.data:undefined;},append(type,data,options={}){const e={seq:events.length,type,data};events.push(e);const op=options.surfaceOp;if(op?.op==='replace'){const a=surface.nodes.indexOf(op.startSeq),b=surface.nodes.indexOf(op.endSeq);assert.ok(a>=0&&b>=a);surface.nodes.splice(a,b-a+1,e.seq);surface.replaceGeneration++;}else if(options.surfaceOp==='append')surface.nodes.push(e.seq);return e;}};
 const add=(text,role='user')=>session.append(role+'/message',role==='assistant'?{message:{id:randomUUID(),role,content:[{type:'text',text}],source:{kind:'fixture'}}}:{id:randomUUID(),role,content:[{type:'text',text}],source:{kind:'user'}},{surfaceOp:'append'});
 add('Stable system','system');add('如果报告提到它，不要写库。\n'+'archiveblob '.repeat(6000));add('evidence '.repeat(4000),'assistant');
 const calls=[];const measure=()=>{const nodes=surface.nodes.map(seq=>({seq,tokens:approxTokens(blocksToText(session.deriveEventMessage(events[seq])?.content))}));return {nodes,totalTokens:nodes.reduce((n,x)=>n+x.tokens,0)};};
 const ctx={on(){},provide(){},logger:{info(){},warn(){}},sessions:{async flush(){}},tokenMeter:{measure},llm:{async resolveModelInfo(){return {contextWindow:1000000};},async *stream(options){calls.push(options);const text=typeof response==='function'?await response(options,calls.length):response;if(text instanceof Error)throw text;yield {type:'text-delta',text};yield {type:'finish',kind:'stop'};}}};
 const engine=new WeaveCompactionEngine(ctx,resolveConfig({summaryRetryCount:0,summaryRetryDelayMs:0,archiveDir:join(root,'archive'),summaryInputMaxBytes:50000,maxSummaryChunks:32,windowFallback:1000000,...extra}).config);engine.historyToolsAvailable=true;
 const agent={session,options:{provider:'p',model:'m'},runMaintenance:fn=>fn(new AbortController().signal)};
 const run=()=>engine._compactNowInner(agent,new AbortController().signal,undefined,true);
 const request=()=>surface.nodes.map(seq=>session.deriveEventMessage(events[seq]));
 return {root,engine,session,events,surface,add,agent,run,request,calls};
}
const interrupted=()=>fixture({},(o,n)=>n===3?Object.assign(new Error('controlled transport failure'),{code:'ECONNRESET'}):NOTES);
const pending=f=>f.engine.sessionState.read(f.session.id).continuationPending;
const resumeAuto=async(f,engine=f.engine)=>{f.session.append('turn/start',{turn:99});try{return await engine.compactIfNeeded(f.agent,'pressure',new AbortController().signal);}finally{f.session.append('turn/end',{turn:99,reason:{kind:'completed'}});}};
await test('append-tail-resumes-before-threshold-without-restarting-pages',async()=>{
 const f=await interrupted();await assert.rejects(f.run());const saved=structuredClone(pending(f)),before=f.calls.length;const tail=f.add('NEW TAIL AFTER FAILURE');
 assert.ok((await f.engine._measure(f.session)).totalTokens<500000);
 const r=await resumeAuto(f);assert.equal(r.continuation.resumedPages,2);assert.equal(r.continuation.totalRequests,r.continuation.pages.length+1);assert.equal(f.calls.length-before,r.continuation.pages.length-2);assert.deepEqual(r.shadowedSeqs,saved.seqs);assert.ok(f.surface.nodes.includes(tail.seq));assert.equal(pending(f),undefined);assert.ok(!JSON.stringify(f.calls.slice(before)).includes('NEW TAIL AFTER FAILURE'));
});
await test('engine-restart-resumes-same-durable-identity-and-budget',async()=>{
 const f=await interrupted();await assert.rejects(f.run());const id=pending(f).id;f.add('TAIL AFTER PROCESS REOPENED');const engine=new WeaveCompactionEngine(f.engine.ctx,f.engine.config);engine.historyToolsAvailable=true;
 const r=await resumeAuto(f,engine);assert.equal(r.continuation.pendingId,id);assert.equal(r.continuation.resumedPages,2);assert.equal(engine.sessionState.read(f.session.id).continuationPending,undefined);
});
await test('pending-source-mutation-blocks-before-provider',async()=>{const f=await interrupted();await assert.rejects(f.run());const n=f.calls.length;f.events[1].data.content[0].text+='changed source';await assert.rejects(resumeAuto(f),e=>e.code==='CONTINUATION_PENDING_SOURCE_CHANGED');assert.equal(f.calls.length,n);assert.equal(f.surface.replaceGeneration,0);});
await test('pending-range-replacement-blocks-before-provider',async()=>{const f=await interrupted();await assert.rejects(f.run());const n=f.calls.length;f.surface.nodes.splice(1,1);await assert.rejects(resumeAuto(f),e=>e.code==='CONTINUATION_PENDING_SOURCE_CHANGED');assert.equal(f.calls.length,n);});
await test('pending-policy-change-cannot-reset-call-budget',async()=>{const f=await interrupted();await assert.rejects(f.run());const n=f.calls.length;const engine=new WeaveCompactionEngine(f.engine.ctx,{...f.engine.config,auditCoverageThreshold:.7});engine.historyToolsAvailable=true;await assert.rejects(resumeAuto(f,engine),e=>e.code==='CONTINUATION_PENDING_POLICY_CHANGED');assert.equal(f.calls.length,n);assert.equal(pending(f).id,engine.sessionState.read(f.session.id).continuationPending.id);});
await test('manual-retry-also-keeps-original-range-and-appended-tail',async()=>{const f=await interrupted();await assert.rejects(f.run());const original=pending(f).seqs;const tail=f.add('TAIL AFTER FAILURE');const r=await f.run();assert.deepEqual(r.shadowedSeqs,original);assert.equal(r.continuation.resumedPages,2);assert.ok(f.surface.nodes.includes(tail.seq));});
await test('automatic-retry-budget-survives-append-and-engine-restart',async()=>{const f=await fixture({continuationMaxExtraCalls:1},()=>Object.assign(new Error('transport'),{code:'ECONNRESET'}));await assert.rejects(f.run());for(let i=0;i<4;i++){f.add('tail '+i);const engine=new WeaveCompactionEngine(f.engine.ctx,f.engine.config);engine.historyToolsAvailable=true;await assert.rejects(resumeAuto(f,engine));}assert.equal(f.calls.length,2);assert.ok(pending(f).progressKey);assert.equal(f.surface.replaceGeneration,0);assert.equal(f.engine.sessionState.read(f.session.id).failures,2);assert.equal(f.engine.sessionState.read(f.session.id).stopped,false);});
await test('storage-failure-while-freezing-spends-zero-requests',async()=>{const f=await fixture();const original=f.engine.sessionState.update.bind(f.engine.sessionState);f.engine.sessionState.update=(id,change)=>original(id,state=>{const next=change(state);if(next.continuationPending)throw new Error('controlled persistence failure');return next;});await assert.rejects(f.run());assert.equal(f.calls.length,0);assert.equal(f.surface.replaceGeneration,0);});
await test('failed-archive-reuses-complete-prepared-notes',async()=>{const f=await fixture();const original=f.engine.archive.readSpan.bind(f.engine.archive);f.engine.archive.readSpan=async()=>({ok:false});await assert.rejects(f.run());const n=f.calls.length;f.engine.archive.readSpan=original;f.add('after archive failure');const r=await f.run();assert.equal(f.calls.length,n);assert.equal(r.continuation.resumedPages,r.continuation.pages.length);});
await test('commit-cleanup-interruption-reconciles-without-new-requests',async()=>{const f=await fixture();const original=f.engine.sessionState.update.bind(f.engine.sessionState);let throwCleanup=true;f.engine.sessionState.update=(id,change)=>original(id,state=>{const next=change(state);if(throwCleanup&&state.continuationPending&&!next.continuationPending){throw new Error('controlled cleanup failure');}return next;});await assert.rejects(f.run());assert.equal(f.surface.replaceGeneration,1);assert.ok(pending(f));const n=f.calls.length;throwCleanup=false;await f.engine.recoverPending(f.session);assert.equal(pending(f),undefined);assert.equal(f.calls.length,n);});
await test('concurrent-tail-during-summary-remains-live',async()=>{let f;f=await fixture({},(o,n)=>{if(n===1)f.add('CONCURRENT TAIL');return NOTES;});const r=await f.run();assert.ok(JSON.stringify(f.request()).includes('CONCURRENT TAIL'));assert.ok(!r.shadowedSeqs.includes(f.surface.nodes.at(-1)));});
await test('concurrent-source-mutation-refused-at-commit',async()=>{let f;f=await fixture({},(o,n)=>{if(n===1)f.events[1].data.content[0].text+='mutation';return NOTES;});await assert.rejects(f.run(),e=>e.code==='CONTINUATION_PENDING_SOURCE_CHANGED');assert.equal(f.surface.replaceGeneration,0);});
await test('cancelled-prepared-work-retains-progress-and-source',async()=>{const c=new AbortController();let f;f=await fixture({},(o,n)=>{if(n===3)c.abort();return NOTES;});await assert.rejects(f.engine._compactNowInner(f.agent,c.signal,undefined,true));assert.equal(f.surface.replaceGeneration,0);assert.ok(pending(f));const r=await f.run();assert.ok(r.continuation.resumedPages>=2);});
await test('preflight-hard-failure-does-not-pin-unpaid-source',async()=>{const f=await fixture({continuationMaxBytes:4096});f.add('必须保留参数 '+ 'A'.repeat(6000));await assert.rejects(f.run());assert.equal(f.calls.length,0);assert.equal(pending(f),undefined);});
await test('reference-requirements-stay-out-of-resident-user-rules',()=>{const messages=[{seq:1,text:'不要删除文件。\n必须保留原记录。'},{seq:2,text:'不要删除文件。\n必须保留原记录。'},{seq:3,text:'不要删除文件。'},{seq:4,text:'不要删除文件。'}];const session={eventAt:seq=>({type:'user/message',data:{source:{kind:seq<3?'runtime-context':seq===3?'user':'unknown'}}})};const residents=residentConstraints(messages,session),text=renderRequirements(residents);assert.equal((text.match(/不要删除文件/g)||[]).length,2);assert.ok(!text.includes('必须保留原记录'));assert.deepEqual(residents.map(x=>x.seq),[3,4]);});
await test('unique-conditional-line-is-never-merged-by-keywords',()=>{const messages=[{seq:1,text:'如果报告提到它，不要写库。'},{seq:2,text:'如果报告未提到它，不要写库。'}];const residents=residentConstraints(messages,{eventAt:()=>({data:{source:{kind:'runtime-context'}}})});const text=renderRequirements(residents);for(const m of messages)assert.ok(text.includes(m.text));});
await test('three-generations-archive-references-and-keep-live-user-rules',async()=>{const f=await fixture();for(let i=0;i<3;i++){const m=f.add('不要删除原始记录。\n必须保留归档。');m.data.source.kind='runtime-context';f.add('observation '.repeat(9000));const result=await f.run();const residents=collectRecentUserMessages(f.session,f.surface.nodes);assert.ok(!residents.some(x=>x.seq===m.seq));const span=await f.engine.archive.readSpan(f.session.id,result.compactionId);assert.ok(span.ok);assert.ok(span.entries.some(x=>x.seq===m.seq&&x.text.includes('不要删除原始记录')));const current=f.request().at(-1).content[0].text;assert.ok(!current.includes('不要删除原始记录'));assert.match(current,/如果报告提到它，不要写库/);}assert.equal(f.surface.replaceGeneration,3);});
for(const [name,source,summary,good] of [
 ['negative-paraphrase','不要跳步。','按顺序不跳步。',true],
 ['using-negative','不要用本地模型判断。','不用本地模型判断。',true],
 ['quoted-independent','大规模替换必须排除标识符。','「不要跳步」「不要一批改十个地方再一起验」「大规模替换必须排除标识符」。',true],
 ['real-reversal','不要跳步。','可以跳步。',false],
 ['quoted-real-reversal','不要写库。','「不要跳步」「必须写库」。',false],
 ['changed-number','表中只有7列。','表中只有8列。',false],
 ['missing-condition','如果报告提到它，不要写库。','不要写库。',false],
 ['conditional-paraphrase','如果报告提到它，不要写库。','当报告提到它时，不要写库。',true],
 ['conditional-reversal','如果报告提到它，不要写库。','报告提到它就顺手写库。',false]
])await test(name,()=>{const r=auditCompaction({userMessages:[{seq:1,text:source}],summaryText:summary,checkpointText:source,includeAllConflicts:true});assert.equal(r.lost.length===0,good,JSON.stringify(r.lost));});
await test('bold-preserved-requirement-satisfies-source-coverage',()=>{const source='不要**跳步**。';assert.equal(auditCompaction({userMessages:[{seq:1,text:source}],summaryText:'Review evidence.',checkpointText:source}).lost.length,0);assert.ok(auditCompaction({userMessages:[{seq:1,text:source}],summaryText:'可以跳步。',checkpointText:source}).lost.some(x=>x.reason==='polarity'));});
await test('unused-observation-is-not-promoted-to-a-command',()=>{const source='真正的问题是**写了不用、存了看不见**。';assert.deepEqual(residentConstraints([{seq:1,text:source}]),[]);});
await test('manual-budget-renewal-completes-and-settles-same-pending-job',async()=>{
 let failing=true;const f=await fixture({continuationMaxExtraCalls:1},(o,n)=>n<=2||!failing?NOTES:Object.assign(new Error('transport'),{code:'ECONNRESET'}));
 await assert.rejects(f.run());const original=pending(f);await assert.rejects(resumeAuto(f));
 const before=f.calls.length,state=f.engine.sessionState.read(f.session.id);assert.equal(state.failures,2);
 await assert.rejects(resumeAuto(f),e=>e.code==='CONTINUATION_CALL_BUDGET');assert.equal(f.calls.length,before);assert.equal(f.engine.sessionState.read(f.session.id).failures,2);
 const tail=f.add('TAIL STILL PRESENT');failing=false;const r=await f.run();
 assert.equal(r.continuation.pendingId,original.id);assert.equal(r.continuation.progressKey,original.progressKey);assert.equal(r.continuation.resumedPages,2);
 assert.equal(r.continuation.requestsThisAttempt,r.continuation.pages.length-2);assert.equal(pending(f),undefined);assert.ok(f.surface.nodes.includes(tail.seq));
 assert.equal(f.engine.sessionState.read(f.session.id).failures,0);assert.equal(f.engine.sessionState.read(f.session.id).stopped,false);
});
await test('automatic-budget-pause-has-actionable-message-and-no-breaker',async()=>{
 const f=await fixture();f.engine.sessionState.update(f.session.id,s=>({...s,failures:2,stopped:false}));
 const e=Object.assign(new Error('acceptedPages=3, totalPages=12, requests=8, extraCalls=4'),{code:'CONTINUATION_CALL_BUDGET'});
 f.engine._recordFailure(f.agent,f.session,e);assert.equal(f.engine.sessionState.read(f.session.id).failures,2);
 const blocked=f.engine._automaticFailure(f.session,e);assert.equal(blocked.failureCode,'CONTINUATION_CALL_BUDGET');assert.match(blocked.message,/3\/12 页/);assert.match(blocked.message,/尚未发送主对话请求/);
});
await test('continuation-content-rejection-never-uses-other-route',async()=>{
 const f=await fixture({summaryRetryCount:1,summarizationProvider:'chosen',summarizationModel:'m'},'<tool_call>invalid');
 await assert.rejects(f.run());assert.equal(f.calls.length,2);assert.ok(f.calls.every(x=>x.provider==='chosen'));
});

await test('manual-policy-migration-keeps-paid-ledger-and-does-not-reuse-old-notes',async()=>{
 let failAfterPage=true;const f=await fixture({},(o,n)=>failAfterPage&&n>1?Object.assign(new Error('transport'),{code:'ECONNRESET'}):NOTES);
 await assert.rejects(f.run());const original=pending(f),count=f.calls.length;
 const engine=new WeaveCompactionEngine(f.engine.ctx,{...f.engine.config,auditCoverageThreshold:.7});engine.historyToolsAvailable=true;
 await assert.rejects(resumeAuto(f,engine),e=>e.code==='CONTINUATION_PENDING_POLICY_CHANGED');assert.equal(f.calls.length,count);
 failAfterPage=false;const r=await engine._compactNowInner(f.agent,new AbortController().signal,'explicit-new-manual-command',true);
 assert.notEqual(r.continuation.progressKey,original.progressKey);assert.equal(r.continuation.resumedPages,0);assert.equal(r.continuation.totalRequests,f.calls.length);assert.ok(r.continuation.priorProgressKeys.includes(original.progressKey));assert.equal(r.continuation.requestUsage.length,f.calls.length);
 const {ContinuationProgressStore}=await import('../lib/continuation-progress.js');const old=new ContinuationProgressStore(join(f.root,'continuation-progress'),f.session.id,original.progressKey).read();assert.equal(old.data.calls.length,count);assert.equal(old.data.next,1);assert.equal(engine.sessionState.read(f.session.id).continuationPending,undefined);
});
await test('new-tail-cancellation-invalidates-paid-notes-without-automatic-restart',async()=>{
 let failAfterPage=true;const f=await fixture({},(o,n)=>failAfterPage&&n>1?Object.assign(new Error('transport'),{code:'ECONNRESET'}):NOTES);
 f.add('生成地图。');await assert.rejects(f.run());const key=pending(f).progressKey,count=f.calls.length;
 f.add('取消生成地图。');await assert.rejects(resumeAuto(f),e=>e.code==='CONTINUATION_PENDING_POLICY_CHANGED');assert.equal(f.calls.length,count);
 failAfterPage=false;const r=await f.run();assert.notEqual(r.continuation.progressKey,key);assert.ok(!JSON.stringify(f.request().filter(m=>m.source?.kind==='compact-checkpoint')).includes('生成地图'));assert.equal(r.continuation.totalRequests,f.calls.length);
});

await test('new-active-tail-requirement-pauses-before-reusing-incompatible-paid-notes',async()=>{
 const f=await interrupted();await assert.rejects(f.run());const old=structuredClone(pending(f)),count=f.calls.length;f.add('Do not restart production.');
 await assert.rejects(resumeAuto(f),e=>e.code==='CONTINUATION_PENDING_POLICY_CHANGED');assert.equal(f.calls.length,count);assert.equal(pending(f).progressKey,old.progressKey);assert.equal(f.surface.replaceGeneration,0);
 const r=await f.run();assert.ok(r.continuation.priorProgressKeys.includes(old.progressKey));assert.equal(r.continuation.totalRequests,f.calls.length);
});
await test('initial-progress-disk-failure-does-not-publish-a-missing-record',async()=>{
 const f=await fixture(),rename=fs.renameSync;let blocked=0;
 fs.renameSync=(from,to)=>{if(String(to).includes('continuation-progress')){blocked++;throw Object.assign(new Error('synthetic disk full'),{code:'ENOSPC'});}return rename(from,to);};syncBuiltinESMExports();
 try{await assert.rejects(f.run());assert.ok(blocked>0);assert.equal(f.calls.length,0);assert.equal(pending(f),undefined);assert.equal(f.surface.replaceGeneration,0);}finally{fs.renameSync=rename;syncBuiltinESMExports();}
 const tail=f.add('必须保留新的测试参数。');const engine=new WeaveCompactionEngine(f.engine.ctx,{...f.engine.config,language:'zh'});engine.historyToolsAvailable=true;
 const r=await engine._compactNowInner(f.agent,new AbortController().signal,undefined,true);assert.ok(r.continuation);assert.equal(r.continuation.resumedPages,0);assert.equal(pending(f),undefined);assert.ok(r.shadowedSeqs.includes(tail.seq));
});
await test('failed-policy-migration-retains-previous-key-pages-and-retry-authority',async()=>{
 const f=await interrupted();await assert.rejects(f.run());const original=structuredClone(pending(f)),before=f.calls.length;
 const engine=new WeaveCompactionEngine(f.engine.ctx,{...f.engine.config,language:'zh'});engine.historyToolsAvailable=true;const rename=fs.renameSync;
 fs.renameSync=(from,to)=>{if(String(to).includes('continuation-progress')&&!String(to).endsWith(original.progressKey+'.json'))throw Object.assign(new Error('synthetic disk full'),{code:'ENOSPC'});return rename(from,to);};syncBuiltinESMExports();
 try{await assert.rejects(engine._compactNowInner(f.agent,new AbortController().signal,undefined,true));assert.equal(f.calls.length,before);assert.deepEqual(pending(f),original);}finally{fs.renameSync=rename;syncBuiltinESMExports();}
 const r=await engine._compactNowInner(f.agent,new AbortController().signal,undefined,true);assert.ok(r.continuation.priorProgressKeys.includes(original.progressKey));assert.equal(r.continuation.totalRequests,before+r.continuation.requestsThisAttempt);assert.equal(pending(f),undefined);
});
await test('transient-page-retries-reuse-accepted-pages-and-identical-input',async()=>{
 const f=await fixture({summaryRetryCount:2},(o,n)=>[3,4].includes(n)?Object.assign(new Error('temporary reset'),{code:'ECONNRESET'}):NOTES);
 const r=await f.run();assert.equal(r.continuation.totalRequests,r.continuation.pages.length+2);assert.deepEqual(f.calls[2].messages,f.calls[3].messages);assert.deepEqual(f.calls[3].messages,f.calls[4].messages);assert.equal(pending(f),undefined);assert.equal(f.engine.sessionState.read(f.session.id).failures,0);
});
await test('terminal-retry-counts-one-operation-failure-and-retains-paid-pages',async()=>{
 const f=await fixture({summaryRetryCount:2},(o,n)=>n>2?Object.assign(new Error('temporary reset'),{code:'ECONNRESET'}):NOTES);
 await assert.rejects(f.engine.compactNow(f.agent,new AbortController().signal,'retry-diagnostic',true));assert.equal(f.calls.length,5);assert.equal(f.engine.sessionState.read(f.session.id).failures,1);assert.ok(pending(f));
 const d=f.engine.failureForCommand(f.session,'retry-diagnostic');assert.equal(d.status,'saved');const report=JSON.parse(await readFile(d.path,'utf8'));assert.equal(report.totalAttempts,5);assert.equal(report.errors.some(x=>x.continuation.acceptedPages===2),true);
});
await test('retry-setting-change-does-not-reset-paid-source-progress',async()=>{
 const f=await interrupted();await assert.rejects(f.run());const before=pending(f);const engine=new WeaveCompactionEngine(f.engine.ctx,resolveConfig({...f.engine.config,summaryRetryCount:2,summaryRetryDelayMs:0}).config);engine.historyToolsAvailable=true;
 const r=await resumeAuto(f,engine);assert.equal(r.continuation.progressKey,before.progressKey);assert.equal(r.continuation.resumedPages,2);
});
console.log(JSON.stringify({passed:rows.filter(x=>x.pass).length,failed:rows.filter(x=>!x.pass).length,results:rows},null,2));if(rows.some(x=>!x.pass))process.exitCode=1;
