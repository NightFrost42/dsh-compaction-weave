import {measureSummaryRange} from '../lib/summary-budget.js';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {WeaveCompactionEngine} from '../lib/engine.js';import {resolveConfig} from '../lib/config.js';import {approxTokens,blocksToText} from '../lib/meter.js';
import {hasContinuation,residentConstraints,sourcePages,continuationEligible} from '../lib/continuation.js';import {auditCompaction,sourceConstraintEvidence} from '../lib/audit.js';import {collectInstructionMessages,selectSessionMemory,collectRecentUserMessages} from '../lib/region.js';import {__test as toolsTest} from '../lib/tools.js';
const rows=[];async function test(name,fn){try{await fn();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.message,stack:e.stack});}}
const NOTES='## Goal\nContinue the diagnostics.\n## State\nEvidence remains archived.\n## Next\nReview results.\n## Uncertain\nPending runtime verification.';
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

const NINE=['Primary Request and Intent','Key Technical Concepts','Files and Code Sections','Errors and Fixes','Problem Solving','All User Messages','Pending Tasks','Work Completed','Context for Continuing Work'].map((h,i)=>`## ${i+1}. ${h}\n${i===0?'Repair compaction with archived evidence.':i===5?'[filled by engine]':i===8?'Do not delete records.':'Evidence remains archived; runtime verification is pending.'}`).join('\n\n');
async function empty(extra={},response=NINE){const f=await fixture({language:'en',...extra},response);f.events.splice(1);f.surface.nodes.splice(1);return f;}
const compact=f=>f.engine._compactRegionCore(f.surface.nodes[1],f.surface.nodes.at(-1),f.agent,new AbortController().signal,{manual:true,policy:f.engine.config});
await test('ten-generations-keep-requirement-archive-and-one-current-checkpoint',async()=>{
 const f=await empty({preserveRecentMessages:1});const original=f.add('Do not delete records.');let maxBytes=0;
 for(let i=0;i<10;i++){
  const ref=f.add('Reference material '.repeat(2000));ref.data.source.kind='runtime-context';
  f.add('latest observation '+String.fromCharCode(65+i));f.add('verified diagnostics '.repeat(1500),'assistant');
  const before=[...f.surface.nodes].slice(1);const result=await compact(f);
  assert.deepEqual(result.shadowedSeqs,before);assert.equal(f.surface.nodes.length,2);
  const active=collectInstructionMessages(f.session,f.surface.nodes);assert.ok(active.some(m=>m.seq===original.seq&&m.text.includes('Do not delete records')));
  const checkpoint=f.request().at(-1),text=checkpoint.content.map(b=>b.text).join('\n');
  assert.ok(!text.includes('Reference material'));assert.ok(text.includes('Do not delete records'));
  assert.equal(checkpoint.source.preserved.length,1);assert.equal((text.match(/latest observation/g)||[]).length,1);
  const archive=await f.engine.archive.readSpan(f.session.id,result.compactionId);assert.ok(archive.ok);assert.deepEqual(archive.entries.map(e=>e.seq),before);assert.ok(archive.entries.some(e=>e.seq===ref.seq&&e.text.includes('Reference material')));
  maxBytes=Math.max(maxBytes,Buffer.byteLength(text));
 }
 assert.equal(f.events.filter(e=>e.data?.source?.kind==='compact-checkpoint').length,10);assert.ok(maxBytes<6000);
 const prefix=JSON.stringify(f.request());f.add('small new observation');await f.engine.compactIfNeeded(f.agent,'pressure',new AbortController().signal);assert.equal(JSON.stringify(f.request().slice(0,-1)),prefix);
});
await test('resolved-value-is-preserved-once-and-old-value-archived',async()=>{
 const f=await empty({},NINE.replace('Do not delete records.','Timeout must be 55 seconds.'));
 const old=f.add('Timeout must be 35 seconds.');const latest=f.add('Timeout must be 55 seconds.');f.add('evidence '.repeat(2000),'assistant');
 const r=await compact(f);const checkpoint=f.request().at(-1);assert.ok(!JSON.stringify(checkpoint.content).includes('35 seconds'));
 assert.deepEqual(checkpoint.source.preserved.map(m=>m.seq),[latest.seq]);const archive=await f.engine.archive.readSpan(f.session.id,r.compactionId);assert.ok(archive.entries.some(e=>e.seq===old.seq&&e.text.includes('35 seconds')));
});
await test('cancelled-request-and-cancellation-never-enter-checkpoint',async()=>{
 const f=await empty();f.add('生成地图。');f.add('取消生成地图。');f.add('evidence '.repeat(2000),'assistant');await compact(f);
 const cp=f.request().at(-1);assert.deepEqual(cp.source.preserved,[]);assert.ok(!JSON.stringify(cp.content).includes('生成地图'));assert.ok(cp.source.memoryDecisions.some(d=>d.reason==='cancellation-applied'));
 f.add('more evidence '.repeat(2000),'assistant');await compact(f);assert.ok(!JSON.stringify(f.request()).includes('生成地图'));
});
await test('archive-failure-keeps-original-active-context',async()=>{
 const f=await empty({preserveRecentMessages:1});f.add('older observation');f.add('latest observation');f.add('evidence '.repeat(2000),'assistant');const before=[...f.surface.nodes];f.engine.archive.writeSpan=async()=>null;await assert.rejects(compact(f),e=>e.code==='ARCHIVE_FAILED');assert.deepEqual(f.surface.nodes,before);
});
await test('a-quote-budget-does-not-silently-drop-an-active-requirement',async()=>{
 const f=await empty({preserveRecentMessages:1},NINE.replace('Do not delete records.','No facts verified.'));f.add('Retain logs for 35 days.');f.add('latest observation');f.add('evidence '.repeat(2000),'assistant');const before=[...f.surface.nodes];
 try{await compact(f);assert.match(JSON.stringify(f.request()),/35/);}catch(e){assert.deepEqual(f.surface.nodes,before);assert.ok(/CONSTRAINT|SUMMARY/.test(e.code));}
});

await test('evicted-nonmodal-task-can-still-be-cancelled-in-a-later-generation',async()=>{
 const f=await empty({preserveRecentMessages:1});const task=f.add('生成地图。');f.add('新的观察记录。');f.add('evidence '.repeat(2000),'assistant');await compact(f);
 let cp=f.request().at(-1);assert.ok(!cp.source.preserved.some(m=>m.seq===task.seq));assert.ok(cp.source.memorySources.some(m=>m.seq===task.seq));
 f.add('取消生成地图。不要删除记录。');f.add('evidence '.repeat(2000),'assistant');await compact(f);
 cp=f.request().at(-1);assert.ok(!cp.source.memorySources.some(m=>m.seq===task.seq));assert.ok(!JSON.stringify(cp.content).includes('生成地图'));assert.ok(JSON.stringify(cp.content).includes('不要删除记录'));
});


await test('chinese-parameter-revision-survives-three-generations',async()=>{
 const f=await empty();f.add('生产环境超时55秒。');f.add('测试环境超时55秒。');f.add('备份上限25G。');
 for(const value of [75,90,120]){
  f.add(`测试环境超时改为${value}秒。`);f.add('evidence '.repeat(2000),'assistant');await compact(f);
  const active=collectInstructionMessages(f.session,f.surface.nodes).map(m=>m.text).join('\n');
  assert.match(active,/生产环境超时55秒/);assert.match(active,/备份上限25G/);assert.match(active,new RegExp(`测试环境超时改为${value}秒`));
  assert.equal((active.match(/测试环境/g)||[]).length,1);
 }
});
await test('explicit-parameter-list-revision-survives-five-real-continuation-generations',async()=>{
 const f=await empty({},NOTES),old='生产环境超时必须为35秒，测试环境超时必须为12秒，备份上限必须为8GB。不上传。',revision='生产环境超时改为55秒，替代先前35秒的要求。';
 const original=f.add(old);
 f.add('evidence '.repeat(2000),'assistant');
 const run=()=>f.engine._compactRegionCore(f.surface.nodes[1],f.surface.nodes.at(-1),f.agent,new AbortController().signal,{manual:true,policy:f.engine.config,continuation:true,continuationBudgetTokens:10000});
 await run();const correction=f.add(revision);
 for(let i=0;i<5;i++){
  f.add('evidence '.repeat(2000),'assistant');await run();
  const cp=f.request().at(-1),text=cp.content[0].text,active=collectInstructionMessages(f.session,f.surface.nodes).map(m=>m.text).join('\n');
  assert.match(text,/生产环境超时改为55秒/);assert.match(text,/测试环境超时必须为12秒/);assert.match(text,/备份上限必须为8GB/);assert.match(text,/不上传/);assert.doesNotMatch(text,/生产环境超时必须为35秒/);
  assert.match(active,/生产环境超时改为55秒/);assert.ok(cp.source.memorySources.some(ref=>ref.seq===correction.seq));
  assert.equal(f.events[original.seq].data.content[0].text,old);
 }
});

await test('partial-task-cancellation-survives-three-generations-and-archive',async()=>{
 const f=await empty();const original=f.add('请生成报告并上传到测试站点。');f.add('evidence '.repeat(2000),'assistant');await compact(f);
 f.add('取消上传，保留生成本地报告。');
 for(let i=0;i<3;i++){
  f.add('evidence '.repeat(2000),'assistant');await compact(f);
  const active=collectInstructionMessages(f.session,f.surface.nodes).map(m=>m.text).join('\n');
  assert.match(active,/请生成报告/);assert.match(active,/保留生成本地报告/);assert.doesNotMatch(active,/上传/);
  assert.equal(f.events[original.seq].data.content[0].text,'请生成报告并上传到测试站点。');
 }
});
await test('bare-parameter-conflict-is-repaired-without-another-model-call',async()=>{
 const f=await empty({},NINE.replace('Do not delete records.','测试环境超时75秒。'));
 f.add('测试环境超时55秒。');f.add('evidence '.repeat(2000),'assistant');
 await compact(f);const text=f.request().at(-1).content.map(b=>b.text).join('\n');
 assert.match(text,/测试环境超时55秒/);assert.doesNotMatch(text,/75秒/);assert.equal(f.calls.length,1);
 assert.equal(auditCompaction({userMessages:[{seq:1,text:'测试环境超时55秒。'}],summaryText:text,checkpointText:text}).lost.length,0);
});

await test('cancel-previous-after-archived-nudge-keeps-older-rule',async()=>{
 const f=await empty();f.add('不要删除已有文件。');f.add('继续');
 for(let i=0;i<3;i++){f.add('evidence '.repeat(2000),'assistant');await compact(f);}
 f.add('取消上一条。');f.add('evidence '.repeat(2000),'assistant');await compact(f);
 const active=collectInstructionMessages(f.session,f.surface.nodes).map(m=>m.text);
 assert.deepEqual(active,['不要删除已有文件。']);
});

await test('stale-model-notes-are-retried-and-latest-work-report-survives-three-generations',async()=>{
 const stale=NINE.replace('Do not delete records.','报告已生成，但尚未打包；下一步打包并校验。');
 const f=await empty({summaryRetryDelayMs:0},(_o,n)=>n%2===1?stale:NINE);f.add('请创建离线诊断报告。');
 const text='报告 work/report-final.json 和统计图 work/chart.svg 均已完成。离线包 work/delivery.zip 已完成打包及哈希校验。全部任务完成，没有剩余动作。';
 const status=f.add(text,'assistant');
 for(let i=0;i<3;i++){
  f.add('reference '.repeat(2000),'assistant');await compact(f);const cp=f.request().at(-1);
  assert.equal(cp.source.workReport.seq,status.seq);assert.ok(cp.content.at(-1).text.includes(text));assert.match(cp.content.at(-1).text,/not independently re-verified/);
  assert.ok(f.calls.at(-1).messages.at(-1).content[0].text.includes(text));assert.equal(f.calls.length,(i+1)*2);assert.match(f.calls.at(-1).messages.at(-1).content[0].text,/PROGRESS_FACT_CONFLICT/);
 }
 f.events[status.seq].data.message.content[0].text='changed source';f.add('reference '.repeat(2000),'assistant');
 await assert.rejects(compact(f),e=>['WORK_REPORT_SOURCE_UNAVAILABLE','PROGRESS_SOURCE_UNAVAILABLE'].includes(e.code));
});

await test('paged-continuation-carries-latest-work-report-through-cold-source-restoration',async()=>{
 const f=await empty({},NOTES);f.add('Do not delete records.');const status=f.add('报告已完成，尚未测试；下一步测试报告。','assistant');
 for(let i=0;i<2;i++){
  f.add('reference '.repeat(2000),'assistant');const seqs=f.surface.nodes.slice(1);
  await f.engine._compactRegionCore(seqs[0],seqs.at(-1),f.agent,new AbortController().signal,{manual:true,policy:f.engine.config,continuation:true,continuationBudgetTokens:10000});
  const cp=f.request().at(-1);assert.equal(cp.source.workReport.seq,status.seq);assert.match(cp.content[0].text,/报告已完成，尚未测试/);
 }
});
await test('oversized-report-identity-survives-paged-continuation-and-fails-closed-on-tampering',async()=>{
 const f=await empty({},NOTES);f.add('Do not delete records.');const status=f.add('报告已完成，尚未测试。'+'详细记录'.repeat(1100),'assistant');
 const run=()=>f.engine._compactRegionCore(f.surface.nodes[1],f.surface.nodes.at(-1),f.agent,new AbortController().signal,{manual:true,policy:f.engine.config,continuation:true,continuationBudgetTokens:10000});
 for(let i=0;i<2;i++){f.add('reference '.repeat(2000),'assistant');await run();const cp=f.request().at(-1);assert.equal(cp.source.workReport.seq,status.seq);assert.match(cp.content[0].text,/exceeds the verbatim allowance/);assert.doesNotMatch(cp.content[0].text,/详细记录/);assert.ok(Buffer.byteLength(JSON.stringify(cp))<6000);}
 f.events[status.seq].data.message.content[0].text+='tampered';f.add('reference '.repeat(2000),'assistant');const before=[...f.surface.nodes],calls=f.calls.length;await assert.rejects(run(),e=>['WORK_REPORT_SOURCE_UNAVAILABLE','PROGRESS_SOURCE_UNAVAILABLE'].includes(e.code));assert.deepEqual(f.surface.nodes,before);assert.equal(f.calls.length,calls);
});
await test('shorter-current-report-allows-one-complete-summary-without-fallback',async()=>{const f=await empty();const old='已完成检查。'+'x'.repeat(2900),current='已完成全部检查，尚未部署。';f.add(old,'assistant');const latest=f.add(current,'assistant');const measured=measureSummaryRange(f.session,{start:1,end:latest.seq},{language:'en',policy:f.engine.config});f.engine.config={...f.engine.config,summaryInputMaxBytes:measured.inputUnits};const original=structuredClone(f.events);const result=await compact(f);assert.deepEqual(result.shadowedSeqs,[1,latest.seq]);assert.equal(f.calls.length,1);assert.ok(f.calls[0].messages.some(m=>m.content?.some(b=>b.text===old)));assert.ok(f.calls[0].messages.some(m=>m.content?.some(b=>b.text===current)));assert.equal(f.request().at(-1).source.workReport.seq,latest.seq);assert.deepEqual(f.events.slice(0,original.length),original);});
await test('partial-compaction-does-not-silently-choose-an-ambiguous-cancellation-target',async()=>{const f=await empty();const a=f.add('上传到测试站点A。'),b=f.add('上传到测试站点B。');f.add('reference '.repeat(2000),'assistant');const cancel=f.add('取消上传。');const before=JSON.stringify(f.events[a.seq]);await f.engine._compactRegionCore(b.seq,cancel.seq,f.agent,new AbortController().signal,{manual:true,policy:f.engine.config});const cp=f.request().at(-1);assert.equal(JSON.stringify(f.events[a.seq]),before);assert.ok(f.surface.nodes.includes(a.seq));assert.deepEqual(cp.source.memorySources.map(r=>r.seq),[b.seq,cancel.seq]);assert.ok(!cp.source.memoryDecisions.some(d=>d.reason==='cancelled'));assert.deepEqual(selectSessionMemory(f.session,f.surface.nodes).active.map(m=>m.seq),[a.seq,b.seq,cancel.seq]);});
console.log(JSON.stringify({passed:rows.filter(x=>x.pass).length,failed:rows.filter(x=>!x.pass).length,results:rows},null,2));if(rows.some(x=>!x.pass))process.exitCode=1;
