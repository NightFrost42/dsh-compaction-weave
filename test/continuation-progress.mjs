import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {prepareContinuation} from '../lib/continuation.js';
import {ContinuationProgressStore} from '../lib/continuation-progress.js';
import {resolveConfig} from '../lib/config.js';
const rows=[];async function test(name,fn){try{await fn();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.message,stack:e.stack});}}
const NOTES='## Goal\nContinue diagnostics.\n## State\nEvidence is in the source archive.\n## Next\nRead evidence, no database writes.\n## Uncertain\nUnverified runtime outcome.';
async function fixture(extra={}){
 const root=await mkdtemp(join(tmpdir(),'weave-resume-'));const events=[{seq:0,type:'user/message',data:{role:'user',content:[{type:'text',text:'不要写库。'}]}},{seq:1,type:'assistant/message',data:{message:{role:'assistant',content:[{type:'text',text:Array.from({length:5500},(_,i)=>`Recorded observation ${i}: evidence held in archive.`).join('\n')}]}}}];
 const session={id:randomUUID(),deriveEventMessage(e){return e.type==='assistant/message'?e.data.message:e.data;},eventAt:i=>events[i],toolHistory:()=>[{forbiddenHistory:true}]};
 let handler=()=>NOTES;const calls=[];
 const ctx={llm:{async *stream(o){calls.push(o);const response=await handler(o,calls.length);if(response instanceof Error)throw response;yield {type:'text-delta',text:response};yield {type:'usage',usage:{inputTokens:100,outputTokens:10,totalTokens:110}};yield {type:'finish',kind:'stop'};}}};
 const policy={...resolveConfig({summaryRetryCount:0,summaryRetryDelayMs:0,archiveEnabled:true,maxSummaryChunks:32,summaryInputMaxBytes:48000,continuationMemoryBytes:4096,...extra}).config};
 const capacity={targets:[{key:JSON.stringify(['p','m']),window:1000000,output:8192,margin:0,inputRatio:1,maxInputBytes:48000,scale:1}],shrinkLimit:Infinity};
 const chain={targets:[{provider:'p',model:'m',reasoningEffort:'max'}],source:'session'};
 const run=(id=randomUUID(),options={})=>prepareContinuation({ctx,agent:{session},session,seqs:events.map(e=>e.seq),policy,capacity,chain,compactionId:id,signal:new AbortController().signal,archiveRoot:join(root,'archive'),...options});
 const records=async()=>{const folder=join(root,'continuation-progress',createHash('sha256').update(session.id).digest('hex'));return Promise.all((await readdir(folder)).filter(n=>n.endsWith('.json')).map(async name=>({path:join(folder,name),record:JSON.parse(await readFile(join(folder,name),'utf8'))})));};
 return {root,events,session,calls,policy,chain,run,records,setHandler:fn=>handler=fn};
}
await test('accepted-pages-survive-later-timeout-and-resume',async()=>{const f=await fixture();f.setHandler((o,n)=>n===3?Object.assign(new Error('timeout'),{code:'SUMMARY_TIMEOUT'}):NOTES);await assert.rejects(f.run());const first=(await f.records())[0].record;assert.equal(first.data.next,2);assert.equal(first.data.calls.length,3);assert.equal(first.data.calls[2].usage,null);f.setHandler(()=>NOTES);const n=f.calls.length;const result=await f.run();assert.equal(result.summarized.continuation.resumedPages,2);assert.equal(f.calls.length-n,result.summarized.continuation.pages.length-2);assert.equal(result.summarized.continuation.totalRequests,result.summarized.continuation.pages.length+1);assert.equal(result.summarized.continuation.unknownUsage,1);});
await test('fully-prepared-notes-reuse-with-new-transaction-id',async()=>{const f=await fixture();const one=await f.run();const n=f.calls.length;const two=await f.run();assert.equal(f.calls.length,n);assert.equal(two.summarized.continuation.resumedPages,one.summarized.continuation.pages.length);assert.notEqual(one.checkpointBlocks[0].text,two.checkpointBlocks[0].text);});
await test('source-change-invalidates-progress',async()=>{const f=await fixture();await f.run();const n=f.calls.length;f.events[1].data.message.content[0].text+='\nFresh observation';const r=await f.run();assert.equal(r.summarized.continuation.resumedPages,0);assert.ok(f.calls.length>n);});
await test('route-or-reasoning-change-invalidates-progress',async()=>{const f=await fixture();await f.run();f.chain.targets[0].reasoningEffort='high';const r=await f.run();assert.equal(r.summarized.continuation.resumedPages,0);});
await test('audit-policy-change-invalidates-progress',async()=>{const f=await fixture();await f.run();f.policy.auditCoverageThreshold=.7;const r=await f.run();assert.equal(r.summarized.continuation.resumedPages,0);});
await test('corrupt-cache-blocks-before-provider',async()=>{const f=await fixture();await f.run();const [{path,record}]=await f.records();record.data.memory='forged';await writeFile(path,JSON.stringify(record));const n=f.calls.length;await assert.rejects(f.run(),e=>e.code==='CONTINUATION_PROGRESS_INVALID');assert.equal(f.calls.length,n);});
await test('checksum-valid-invalid-note-is-reaudited',async()=>{const f=await fixture();const r=await f.run();const store=new ContinuationProgressStore(join(f.root,'continuation-progress'),f.session.id,r.summarized.continuation.progressKey);const row=store.read();row.data.memory='## Goal\n写库。\n## State\nDone.\n## Next\n写库。\n## Uncertain\nNone.';row.data.last.rawText=row.data.memory;store.write(row.data,row.revision);const n=f.calls.length;await assert.rejects(f.run(),e=>e.code==='CONTINUATION_PROGRESS_INVALID');assert.equal(f.calls.length,n);});
await test('gap-in-saved-source-partition-is-rejected',async()=>{const f=await fixture();const r=await f.run();const store=new ContinuationProgressStore(join(f.root,'continuation-progress'),f.session.id,r.summarized.continuation.progressKey);const row=store.read();row.data.segments[0].start=1;store.write(row.data,row.revision);await assert.rejects(f.run(),e=>e.code==='CONTINUATION_PROGRESS_INVALID');});
await test('source-page-receipt-mismatch-is-rejected',async()=>{const f=await fixture();const r=await f.run();const store=new ContinuationProgressStore(join(f.root,'continuation-progress'),f.session.id,r.summarized.continuation.progressKey);const row=store.read();row.data.receipts[0].sourceSha256='f'.repeat(64);store.write(row.data,row.revision);await assert.rejects(f.run(),e=>e.code==='CONTINUATION_PROGRESS_INVALID');});
await test('repeated-invalid-output-has-persistent-extra-call-budget',async()=>{const f=await fixture({continuationMaxExtraCalls:1,summaryRetryCount:1});f.setHandler(()=>'<｜｜DSML｜｜ calls>invalid');for(let i=0;i<4;i++)await assert.rejects(f.run());assert.equal(f.calls.length,2);const [r]=await f.records();assert.equal(r.record.data.calls.length,2);assert.equal(r.record.data.next,0);});
await test('format-correction-uses-bounded-provider-retry',async()=>{const f=await fixture({summaryRetryCount:1});f.setHandler((o,n)=>n===1?'Unstructured notes':NOTES);const r=await f.run();assert.equal(r.summarized.continuation.totalRequests,r.summarized.continuation.pages.length+1);assert.match(f.calls[1].messages.at(-1).content[0].text,/Previous attempt rejected/);});
await test('zero-retries-leaves-transport-failure-for-manual-resume',async()=>{const f=await fixture();f.setHandler(()=>Object.assign(new Error('transport'),{code:'ECONNRESET'}));await assert.rejects(f.run());assert.equal(f.calls.length,1);});
await test('storage-unavailable-spends-no-request',async()=>{const f=await fixture();await writeFile(join(f.root,'continuation-progress'),'blocked');await assert.rejects(f.run());assert.equal(f.calls.length,0);});
await test('optimistic-writer-cannot-overwrite-newer-progress',async()=>{const f=await fixture();const r=await f.run();const store=new ContinuationProgressStore(join(f.root,'continuation-progress'),f.session.id,r.summarized.continuation.progressKey);const row=store.read();store.write(row.data,row.revision);assert.throws(()=>store.write(row.data,row.revision),e=>e.code==='CONTINUATION_PROGRESS_CHANGED');});
await test('isolated-summary-has-system-instruction-and-no-tools-history',async()=>{const f=await fixture();await f.run();for(const c of f.calls){assert.equal(c.messages[0].role,'system');assert.match(c.messages[0].content[0].text,/dedicated history summarizer/);assert.equal(c.toolHistory,undefined);assert.equal(c.tools,undefined);assert.equal(c.reasoningEffort,'max');}});
await test('new-progress-settings-are-bounded',()=>{const d=resolveConfig({summaryRetryCount:0,summaryRetryDelayMs:0,}).config;assert.equal(d.continuationMaxExtraCalls,4);assert.equal(d.continuationMemoryBytes,12288);const c=resolveConfig({summaryRetryCount:0,summaryRetryDelayMs:0,continuationMaxExtraCalls:999,continuationMemoryBytes:999999}).config;assert.equal(c.continuationMaxExtraCalls,32);assert.equal(c.continuationMemoryBytes,24576);});
await test('accepted-checkpoint-preserves-exact-user-requirement',async()=>{const f=await fixture();const r=await f.run();assert.match(r.checkpointBlocks[0].text,/不要写库。/);assert.ok(r.summarized.continuation.requestUsage.every(c=>c.usage.totalTokens===110));});
await test('near-budget-transaction-id-length-does-not-reset-pages',async()=>{const f=await fixture({continuationMaxBytes:8192,continuationMemoryBytes:12288});const one=await f.run('a');const n=f.calls.length;const two=await f.run('longer-transaction-identifier-for-the-same-source');assert.equal(f.calls.length,n);assert.equal(two.summarized.continuation.progressKey,one.summarized.continuation.progressKey);});
await test('manual-renewal-resumes-accepted-pages-and-retains-ledger',async()=>{
 const f=await fixture({continuationMaxExtraCalls:1});f.setHandler((o,n)=>n<=2?NOTES:Object.assign(new Error('transport'),{code:'ECONNRESET'}));
 await assert.rejects(f.run());await assert.rejects(f.run());await assert.rejects(f.run(),e=>e.code==='CONTINUATION_CALL_BUDGET');
 const before=(await f.records())[0].record;assert.equal(before.data.next,2);assert.equal(before.data.calls.length,4);
 f.setHandler(()=>NOTES);const r=await f.run('manual-retry',{manualRetry:true});const after=(await f.records())[0].record;
 assert.equal(r.summarized.continuation.progressKey,before.key);assert.equal(r.summarized.continuation.resumedPages,2);
 assert.equal(r.summarized.continuation.requestsThisAttempt,r.summarized.continuation.pages.length-2);
 assert.deepEqual(after.data.calls.slice(0,4),before.data.calls);assert.deepEqual(after.data.receipts.slice(0,2),before.data.receipts);
 assert.equal(after.data.budgetGrants.length,1);assert.equal(after.data.budgetGrants[0].calls,4);
});
await test('one-manual-command-cannot-renew-again-inside-repair-loop',async()=>{
 const f=await fixture({continuationMaxExtraCalls:1,summaryRetryCount:1});f.setHandler(()=>'<tool_call>bad');await assert.rejects(f.run());
 await assert.rejects(f.run('same-command',{manualRetry:true}));assert.equal(f.calls.length,4);
 await assert.rejects(f.run('same-command',{manualRetry:true}),e=>e.code==='CONTINUATION_CALL_BUDGET');assert.equal(f.calls.length,4);
 await assert.rejects(f.run('automatic'),e=>e.code==='CONTINUATION_CALL_BUDGET');assert.equal(f.calls.length,4);
 await assert.rejects(f.run('new-command',{manualRetry:true}));assert.equal(f.calls.length,6);
});
await test('manual-run-with-remaining-budget-does-not-renew',async()=>{
 const f=await fixture();f.setHandler(()=>Object.assign(new Error('transport'),{code:'ECONNRESET'}));await assert.rejects(f.run());
 f.setHandler(()=>NOTES);await f.run('manual',{manualRetry:true});assert.equal((await f.records())[0].record.data.budgetGrants,undefined);
});
await test('corrupt-budget-grant-is-refused-before-provider',async()=>{
 const f=await fixture();const r=await f.run();const store=new ContinuationProgressStore(join(f.root,'continuation-progress'),f.session.id,r.summarized.continuation.progressKey);const row=store.read();
 row.data.budgetGrants=[{calls:999,next:0,requestId:'forged'}];store.write(row.data,row.revision);const n=f.calls.length;
 await assert.rejects(f.run('manual',{manualRetry:true}),e=>e.code==='CONTINUATION_PROGRESS_INVALID');assert.equal(f.calls.length,n);
});
await test('cancelled-manual-entry-cannot-renew-budget',async()=>{
 const f=await fixture({continuationMaxExtraCalls:1,summaryRetryCount:1});f.setHandler(()=>'<tool_call>bad');await assert.rejects(f.run());
 const c=new AbortController();c.abort();await assert.rejects(f.run('manual',{manualRetry:true,signal:c.signal}));
 assert.equal((await f.records())[0].record.data.budgetGrants,undefined);assert.equal(f.calls.length,2);
});
await test('cancelled-entry-cannot-publish-a-new-progress-identity',async()=>{
 const f=await fixture(),c=new AbortController();c.abort();let published=0;
 await assert.rejects(f.run('cancelled',{signal:c.signal,onProgressIdentity:()=>{published++;}}));assert.equal(published,0);assert.equal(f.calls.length,0);
});
await test('invalid-cached-notes-cannot-publish-progress-identity',async()=>{
 const f=await fixture(),r=await f.run(),store=new ContinuationProgressStore(join(f.root,'continuation-progress'),f.session.id,r.summarized.continuation.progressKey),row=store.read();
 row.data.memory='invalid';row.data.last.rawText='invalid';store.write(row.data,row.revision);const before=f.calls.length;let published=0;
 await assert.rejects(f.run('invalid',{onProgressIdentity:()=>{published++;}}),e=>e.code==='CONTINUATION_PROGRESS_INVALID');assert.equal(published,0);assert.equal(f.calls.length,before);
});
console.log(JSON.stringify({passed:rows.filter(x=>x.pass).length,failed:rows.filter(x=>!x.pass).length,results:rows},null,2));if(rows.some(x=>!x.pass))process.exitCode=1;
