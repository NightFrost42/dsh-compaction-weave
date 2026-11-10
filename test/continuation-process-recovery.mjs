import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync,spawn} from 'node:child_process';
import {prepareContinuation} from '../lib/continuation.js';
import {ContinuationProgressStore} from '../lib/continuation-progress.js';
import {SessionStateStore} from '../lib/state.js';
import {freezeContinuation,bindContinuationProgress} from '../lib/continuation-pending.js';
import {resolveConfig} from '../lib/config.js';
const NOTES='## Goal\nContinue diagnostics.\n## State\nTwo verified results in evidence.json.\n## Next\nCheck remaining entries without changing production.\n## Uncertain\nRuntime validation still pending.';
const sessionId='synthetic-process-recovery',file=fileURLToPath(import.meta.url);
const [mode,root]=process.argv.slice(2);
if(mode){
 if(mode==='concurrent'){
  const store=new ContinuationProgressStore(root,sessionId,'f'.repeat(64));
  process.send('ready');process.once('message',()=>{try{store.write({writer:process.pid},1);process.send({status:'written'});}catch(e){process.send({status:e.code});}process.disconnect();});
 }else{
  const events=[{seq:0,type:'user/message',data:{role:'user',content:[{type:'text',text:'不要修改生产数据。必须保留证据路径 evidence.json。'}]}},{seq:1,type:'assistant/message',data:{message:{role:'assistant',content:[{type:'text',text:Array.from({length:5500},(_,i)=>`Observation ${i} retained in the evidence archive.`).join('\n')}]}}}];
  const session={id:sessionId,surface:{nodes:[0,1]},eventAt:i=>events[i],deriveEventMessage:e=>e.type==='assistant/message'?e.data.message:e.data};
  const state=new SessionStateStore(join(root,'state')),pending=freezeContinuation(state,session,[0,1]);
  const policy=resolveConfig({archiveEnabled:true,maxSummaryChunks:32,summaryInputMaxBytes:48000,continuationMemoryBytes:4096}).config;
  const capacity={targets:[{key:JSON.stringify(['p','m']),window:1000000,output:8192,margin:0,inputRatio:1,maxInputBytes:48000,scale:1}],shrinkLimit:Infinity};
  const chain={targets:[{provider:'p',model:'m',reasoningEffort:'max'}],source:'session'};
  const requests=join(root,'requests.jsonl');let count=0;
  const ctx={llm:{async *stream(options){fs.appendFileSync(requests,JSON.stringify({process:process.pid,pageRequest:++count})+'\n');if(mode==='crash-during-third-request'&&count===3)process.exit(77);yield {type:'text-delta',text:NOTES};yield {type:'usage',usage:{inputTokens:100,outputTokens:30,totalTokens:130}};yield {type:'finish',kind:'stop'};}}};
  const result=await prepareContinuation({ctx,agent:{session},session,seqs:[0,1],policy,capacity,chain,compactionId:'child-'+process.pid,signal:new AbortController().signal,archiveRoot:join(root,'archive'),onProgressIdentity:key=>{
   if(mode==='crash-before-bind'){
    const progress=new ContinuationProgressStore(join(root,'continuation-progress'),sessionId,key).read();
    if(!progress||progress.data.calls.length!==0)process.exit(79);
    fs.writeFileSync(join(root,'unbound-key.txt'),key);process.exit(78);
   }
   return bindContinuationProgress(state,session,pending.id,key);
  }});
  fs.writeFileSync(join(root,'completed.json'),JSON.stringify(result));
 }
}else{
 const rows=[];async function test(name,fn){try{await fn();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.message,stack:e.stack});}}
 const child=(mode,dir)=>{const r=spawnSync(process.execPath,[file,mode,dir],{windowsHide:true,encoding:'utf8',timeout:30000});if(r.error)throw r.error;return r;};
 const load=dir=>{const p=new SessionStateStore(join(dir,'state')).read(sessionId).continuationPending;return new ContinuationProgressStore(join(dir,'continuation-progress'),sessionId,p.progressKey).read();};
 await test('actual-process-exit-resumes-paid-pages-and-unknown-usage-ledger',()=>{
  const dir=fs.mkdtempSync(join(tmpdir(),'weave-process-resume-'));assert.equal(child('crash-during-third-request',dir).status,77);
  const before=load(dir);assert.equal(before.data.next,2);assert.equal(before.data.calls.length,3);assert.equal(before.data.calls[2].usage,null);assert.equal(before.data.calls[2].endedAt,undefined);
  const resume=child('resume',dir);assert.equal(resume.status,0,resume.stderr);const after=load(dir),r=JSON.parse(fs.readFileSync(join(dir,'completed.json')));
  assert.equal(r.summarized.continuation.resumedPages,2);assert.equal(r.summarized.continuation.requestsThisAttempt,after.data.segments.length-2);assert.equal(r.summarized.continuation.totalRequests,after.data.segments.length+1);assert.equal(r.summarized.continuation.unknownUsage,1);
  assert.deepEqual(after.data.calls.slice(0,3),before.data.calls);assert.deepEqual(after.data.receipts.slice(0,2),before.data.receipts);assert.match(r.checkpointBlocks[0].text,/不要修改生产数据。/);assert.match(r.checkpointBlocks[0].text,/evidence\.json/);
  const requests=fs.readFileSync(join(dir,'requests.jsonl'),'utf8');const again=child('resume',dir);assert.equal(again.status,0,again.stderr);assert.equal(fs.readFileSync(join(dir,'requests.jsonl'),'utf8'),requests);
 });
 await test('actual-exit-between-durable-progress-and-binding-leaves-reusable-unpaid-work',()=>{
  const dir=fs.mkdtempSync(join(tmpdir(),'weave-process-unbound-'));assert.equal(child('crash-before-bind',dir).status,78);
  const pending=new SessionStateStore(join(dir,'state')).read(sessionId).continuationPending;assert.equal(pending.progressKey,undefined);assert.equal(fs.existsSync(join(dir,'requests.jsonl')),false);
  const key=fs.readFileSync(join(dir,'unbound-key.txt'),'utf8'),store=new ContinuationProgressStore(join(dir,'continuation-progress'),sessionId,key);assert.equal(store.read().data.calls.length,0);assert.equal(fs.existsSync(store.file+'.lock'),false);
  const resume=child('resume',dir);assert.equal(resume.status,0,resume.stderr);const r=JSON.parse(fs.readFileSync(join(dir,'completed.json')));assert.equal(r.summarized.continuation.progressKey,key);assert.equal(r.summarized.continuation.resumedPages,0);assert.equal(r.summarized.continuation.totalRequests,r.summarized.continuation.pages.length);
 });
 await test('concurrent-real-processes-cannot-both-publish-the-same-revision',async()=>{
  const dir=fs.mkdtempSync(join(tmpdir(),'weave-process-writers-')),store=new ContinuationProgressStore(dir,sessionId,'f'.repeat(64));store.write({next:2},0);
  const workers=[0,1].map(()=>{let ready,done;const readyPromise=new Promise(r=>ready=r),donePromise=new Promise((r,j)=>done={r,j});const child=spawn(process.execPath,[file,'concurrent',dir],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});let result,stderr='';const timer=setTimeout(()=>{child.kill();done.j(new Error('child timeout'));},20000);child.stderr.on('data',b=>stderr+=b);child.on('message',m=>{if(m==='ready')ready();else result=m;});child.on('error',e=>{ready();done.j(e);});child.on('exit',code=>{clearTimeout(timer);ready();code===0?done.r(result):done.j(new Error(stderr||'child exit '+code));});return {child,ready:readyPromise,done:donePromise};});
  await Promise.all(workers.map(w=>w.ready));for(const w of workers)w.child.send('go');const results=await Promise.all(workers.map(w=>w.done));assert.equal(results.filter(r=>r.status==='written').length,1);assert.ok(results.some(r=>['CONTINUATION_PROGRESS_CHANGED','CONTINUATION_PROGRESS_LOCKED'].includes(r.status)));assert.equal(store.read().revision,2);assert.equal(fs.existsSync(store.file+'.lock'),false);
 });
 console.log(JSON.stringify({passed:rows.filter(x=>x.pass).length,failed:rows.filter(x=>!x.pass).length,results:rows},null,2));if(rows.some(x=>!x.pass))process.exitCode=1;
}
