import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {WeaveCompactionEngine} from '../lib/engine.js';import {resolveConfig} from '../lib/config.js';import {approxTokens,blocksToText} from '../lib/meter.js';
import {planContinuationMemory} from '../lib/continuation.js';
const rows=[];async function test(name,fn){try{await fn();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.message,stack:e.stack});}}
const NOTES='## Goal\nContinue diagnostics.\n## State\nVerified evidence remains archived.\n## Next\nReview pending results.\n## Uncertain\nRuntime verification remains pending.';
async function fixture(extra={},response=NOTES){
 const root=await mkdtemp(join(tmpdir(),'weave-cont-'));const events=[];const surface={nodes:[],replaceGeneration:0};
 const session={id:randomUUID(),surface,get seq(){return events.length;},eventAt:i=>events[i],snapshotEvents:()=>events,requestHeader:()=>({config:{provider:'p',model:'m'}}),toolHistory:()=>[],deriveEventMessage(e){return e?.type==='assistant/message'?e.data.message:e?.type==='tool/result'?{role:'tool',content:e.data.content}:e?.type.endsWith('/message')?e.data:undefined;},append(type,data,options={}){const e={seq:events.length,type,data};events.push(e);const op=options.surfaceOp;if(op?.op==='replace'){const a=surface.nodes.indexOf(op.startSeq),b=surface.nodes.indexOf(op.endSeq);assert.ok(a>=0&&b>=a);surface.nodes.splice(a,b-a+1,e.seq);surface.replaceGeneration++;}else if(options.surfaceOp==='append')surface.nodes.push(e.seq);return e;}};
 const add=(text,role='user')=>session.append(role+'/message',role==='assistant'?{message:{id:randomUUID(),role,content:[{type:'text',text}],source:{kind:'fixture'}}}:{id:randomUUID(),role,content:[{type:'text',text}],source:{kind:'user'}},{surfaceOp:'append'});
 add('Stable system','system');add('如果报告提到它，不要写库。\n'+'archiveblob '.repeat(6000));add('evidence '.repeat(4000),'assistant');
 const calls=[];const measure=()=>{const nodes=surface.nodes.map(seq=>({seq,tokens:approxTokens(blocksToText(session.deriveEventMessage(events[seq])?.content))}));return {nodes,totalTokens:nodes.reduce((n,x)=>n+x.tokens,0)};};
 const ctx={on(){},provide(){},logger:{info(){},warn(){}},sessions:{async flush(){}},tokenMeter:{measure},llm:{async resolveModelInfo(){return {contextWindow:1000000};},async *stream(options){calls.push(options);yield {type:'text-delta',text:typeof response==='function'?response(options,calls.length):response};yield {type:'finish',kind:'stop'};}}};
 const engine=new WeaveCompactionEngine(ctx,resolveConfig({archiveDir:join(root,'archive'),summaryInputMaxBytes:50000,maxSummaryChunks:32,windowFallback:1000000,...extra}).config);engine.historyToolsAvailable=true;
 const agent={session,options:{provider:'p',model:'m'},runMaintenance:fn=>fn(new AbortController().signal)};
 const run=()=>engine._compactNowInner(agent,new AbortController().signal,undefined,true);
 const request=()=>surface.nodes.map(seq=>session.deriveEventMessage(events[seq]));
 return {root,engine,session,events,surface,add,agent,run,request,calls};
}

const defaults=resolveConfig({}).config;
await test('normal-budget-preserves-note-and-requirement-allowance',()=>{
 const req=[{seq:1,text:'Do not delete records.'}],before=JSON.stringify(req),plan=planContinuationMemory(req,defaults);
 assert.equal(plan.memoryLimit,defaults.continuationMemoryBytes);assert.equal(JSON.stringify(req),before);assert.match(plan.base,/Do not delete records/);assert.ok(plan.reservedTokens>plan.memoryLimit);
});
await test('available-request-budget-bounds-generated-notes',()=>{
 const p=planContinuationMemory([{seq:1,text:'Keep evidence.'}],defaults,{budgetTokens:6000});assert.ok(p.memoryLimit>=2048&&p.memoryLimit<6000);assert.ok(p.reservedTokens<=6000);
});
await test('requirements-never-truncated-to-force-fit',()=>{
 const req=[{seq:1,text:'Do not delete records.\n'.repeat(10000)}],before=JSON.stringify(req);assert.throws(()=>planContinuationMemory(req,defaults),e=>e.code==='CONTINUATION_REQUIREMENTS_TOO_LARGE');assert.equal(JSON.stringify(req),before);
});
await test('too-small-note-budget-refused-before-spending',async()=>{
 const f=await fixture(),before=[...f.surface.nodes];
 await assert.rejects(f.engine._compactRegionCore(before[1],before.at(-1),f.agent,new AbortController().signal,{manual:true,policy:f.engine.config,continuation:true,continuationBudgetTokens:500}),e=>e.code==='CONTINUATION_TOO_LARGE');
 assert.equal(f.calls.length,0);assert.deepEqual(f.surface.nodes,before);assert.equal(f.engine.sessionState.read(f.session.id).continuationPending,undefined);
 const success=await f.engine._compactRegionCore(before[1],before.at(-1),f.agent,new AbortController().signal,{manual:true,policy:f.engine.config,continuation:true,continuationBudgetTokens:6000});assert.ok(success.continuation);assert.ok(f.calls.length>0);
});
await test('oversized-note-repair-never-saves-rejected-page',async()=>{
 const f=await fixture({},(_options,count)=>count===1?NOTES.replace('Review pending results.','Review pending results. '+ 'plain evidence '.repeat(800)):NOTES);
 const nodes=[...f.surface.nodes],result=await f.engine._compactRegionCore(nodes[1],nodes.at(-1),f.agent,new AbortController().signal,{manual:true,policy:f.engine.config,continuation:true,continuationBudgetTokens:6000});
 assert.ok(f.calls.length>result.continuation.pages.length);assert.ok(result.continuation.pages.every(p=>p.memoryBytes<6000));assert.ok(!JSON.stringify(f.request()).includes('plain evidence plain evidence'));
});
await test('host-meter-checks-complete-checkpoint-before-accepting-page',async()=>{
 const f=await fixture({},(_options,count)=>count===1?NOTES.replace('Review pending results.','Review token-heavy-marker.'):NOTES);
 f.engine.ctx.tokenMeter.estimateMessage=m=>blocksToText(m.content).includes('token-heavy-marker')?9000:approxTokens(blocksToText(m.content));
 const nodes=[...f.surface.nodes],r=await f.engine._compactRegionCore(nodes[1],nodes.at(-1),f.agent,new AbortController().signal,{manual:true,policy:f.engine.config,continuation:true,continuationBudgetTokens:6000});
 assert.ok(f.calls.length>r.continuation.pages.length);assert.ok(!JSON.stringify(f.request()).includes('token-heavy-marker'));
});
for(const continuation of [true,false])await test('incremental-'+(continuation?'continuation':'normal')+'-respects-old-checkpoint-rule',async()=>{
 let poison=false;
 const structured=['Primary Request and Intent','Key Technical Concepts','Files and Code Sections','Errors and Fixes','Problem Solving','All User Messages','Pending Tasks','Work Completed','Context for Continuing Work'].map((h,i)=>`## ${i+1}. ${h}\n${i===0?'Continue diagnostics.':i===5?'[filled by engine]':i===6?'可以写库。':'(none)'}`).join('\n\n');
 const f=await fixture({summaryInputMaxBytes:500000},()=>!poison?NOTES:continuation?NOTES.replace('Review pending results.','可以写库。'):structured);
 await f.run();const prefix=[...f.surface.nodes],frozen=prefix.map(seq=>JSON.stringify(f.session.deriveEventMessage(f.events[seq])));poison=true;
 const a=f.add('Verified evidence '.repeat(6000),'assistant');f.add('More confirmed results '.repeat(3000),'assistant');
 const start=a.seq,end=f.surface.nodes.at(-1),before=f.surface.replaceGeneration;let error;
 try{await f.engine._compactRegionCore(start,end,f.agent,new AbortController().signal,{manual:true,policy:f.engine.config,continuation});}catch(e){error=e;}
 assert.deepEqual(f.surface.nodes.slice(0,prefix.length),prefix);assert.deepEqual(prefix.map(seq=>JSON.stringify(f.session.deriveEventMessage(f.events[seq]))),frozen);
 if(error){assert.equal(f.surface.replaceGeneration,before);assert.ok(f.surface.nodes.includes(start));}
 else{assert.ok(!JSON.stringify(f.request()).includes('可以写库'));assert.ok(JSON.stringify(f.request()).includes('不要写库'));}
 assert.ok(f.calls.some(c=>JSON.stringify(c.messages).includes('Other active requirements already visible outside this span')));
});
console.log(JSON.stringify({passed:rows.filter(r=>r.pass).length,failed:rows.filter(r=>!r.pass).length,results:rows},null,2));if(rows.some(r=>!r.pass))process.exitCode=1;
