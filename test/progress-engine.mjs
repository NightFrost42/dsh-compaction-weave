import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {WeaveCompactionEngine} from '../lib/engine.js';import {resolveConfig} from '../lib/config.js';import {approxTokens,blocksToText} from '../lib/meter.js';
import {collectProgressFacts} from '../lib/progress-facts.js';import {diagnosticFor} from '../lib/failure-diagnostics.js';
const rows=[];async function test(name,fn){try{await fn();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.stack});}}
const state='最新进度：本批110个文件已完成扫描和格式检查。报告尚未生成，图表尚未生成，下一步生成本地报告。不上传。';
const notes=value=>`## Goal\n继续本地报告工作。\n## State\n${value}\n## Next\n沿用后续消息中的当前安排。\n## Uncertain\n生产环境未验证。`;
const nine=value=>['Primary Request and Intent','Key Technical Concepts','Files and Code Sections','Errors and Fixes','Problem Solving','All User Messages','Pending Tasks','Work Completed','Context for Continuing Work'].map((h,i)=>`## ${i+1}. ${h}\n${i===5?'[filled by engine]':i===7?value:'Local historical evidence; follow newer messages.'}`).join('\n\n');
async function fixture(response,extra={}){
 const root=await mkdtemp(join(tmpdir(),'weave-progress-')),events=[],surface={nodes:[],replaceGeneration:0},calls=[];
 const session={id:randomUUID(),get seq(){return events.length},surface,eventAt:n=>events[n],snapshotEvents:()=>events,requestHeader:()=>({config:{provider:'test',model:'flash'}}),toolHistory:()=>[],deriveEventMessage:e=>e?.type.endsWith('/message')?e.data.message??e.data:null,append(type,data,options={}){const event={seq:events.length,type,data};events.push(event);const op=options.surfaceOp;if(op==='append')surface.nodes.push(event.seq);else if(op?.op==='replace'){const a=surface.nodes.indexOf(op.startSeq),b=surface.nodes.indexOf(op.endSeq);surface.nodes.splice(a,b-a+1,event.seq);surface.replaceGeneration++;}return event;}};
 const add=(role,text,source={kind:role==='assistant'?'model':'user'})=>session.append(role+'/message',role==='user'?{id:randomUUID(),role,content:[{type:'text',text}],source}:{message:{id:randomUUID(),role,content:[{type:'text',text}],source}},{surfaceOp:'append'}).seq;
 const measure=()=>{const nodes=surface.nodes.map(seq=>({seq,tokens:approxTokens(blocksToText(session.deriveEventMessage(events[seq])?.content))}));return {nodes,totalTokens:nodes.reduce((n,x)=>n+x.tokens,0)};};
 const ctx={on(){},provide(){},logger:{info(){},warn(){}},sessions:{async flush(){}},tokenMeter:{measure},llm:{async resolveModelInfo(){return {contextWindow:1000000}},async *stream(o){calls.push(structuredClone({...o,signal:undefined}));yield {type:'text-delta',text:await response(o,calls.length)};yield {type:'finish',kind:'stop'};}}};
 const config=resolveConfig({archiveDir:join(root,'archive'),language:'en',summaryInputMaxBytes:200000,summaryRetryCount:2,summaryRetryDelayMs:0,...extra}).config;
 const engine=new WeaveCompactionEngine(ctx,config);engine.historyToolsAvailable=true;
 const agent={session,options:{provider:'test',model:'flash'},runMaintenance:fn=>fn(new AbortController().signal)};
 add('system','Stable system');
 const compact=(start,end,continuation=false)=>engine.diagnostics.run(session,{trigger:'test'},()=>engine._compactRegionCore(start,end,agent,new AbortController().signal,{manual:true,policy:config,continuation,continuationBudgetTokens:18000}));
 return {root,events,surface,session,calls,add,engine,agent,compact};
}
for(const continuation of [false,true]){
 await test((continuation?'paged':'normal')+'-conflict-retries-with-prefix-identical',async()=>{
  const render=continuation?notes:nine,f=await fixture((_o,n)=>render(n===1?'checkedFileCount: null。':'本区间只有历史诊断日志。'));
  const old=f.add('assistant','历史证据：测试用日志。'.repeat(1800)),tail=f.add('assistant',state),before=structuredClone(f.events);
  const result=await f.compact(old,old,continuation);assert.ok(result);assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0].messages.slice(0,-1),f.calls[1].messages.slice(0,-1));assert.match(JSON.stringify(f.calls[1].messages.at(-1)),/PROGRESS_FACT_CONFLICT/);assert.ok(f.surface.nodes.includes(tail));assert.deepEqual(f.events.slice(0,before.length),before);
  const cp=f.events.findLast(e=>e.data?.source?.kind==='compact-checkpoint');assert.equal(cp.data.source.summaryScope.start,old);assert.deepEqual(cp.data.source.progressFacts.sources,[]);assert.doesNotMatch(blocksToText(cp.data.content),/checkedFileCount: null/);
 });
 await test((continuation?'paged':'normal')+'-retry-exhaustion-retains-originals-and-diagnostics',async()=>{
  const render=continuation?notes:nine,f=await fixture(()=>render('checkedFileCount: null。'));
  const start=f.add('assistant',state),end=f.add('assistant','原始诊断细节。'.repeat(3000)),before=[...f.surface.nodes];let error;
  try{await f.compact(start,end,continuation);}catch(e){error=e;}
  assert.equal(error?.code,'PROGRESS_FACT_CONFLICT');assert.equal(f.calls.length,3);assert.deepEqual(f.surface.nodes,before);assert.equal(f.events.filter(e=>e.data?.source?.kind==='compact-checkpoint').length,0);
  const receipt=diagnosticFor(error);assert.equal(receipt.status,'saved');assert.match(receipt.explanation,/进度事实冲突/);const report=JSON.parse(await readFile(receipt.path,'utf8'));assert.equal(report.totalAttempts,3);assert.equal(report.retryLimit,3);assert.equal(report.auditReports.length,3);
  for(const item of report.auditReports){const detail=JSON.parse(await readFile(item.path,'utf8'));assert.equal(detail.audit.kind,'progress');assert.ok(detail.audit.lost.some(x=>x.key==='checkedFileCount'));}
 });
}
await test('eight-compactions-and-cold-restore-keep-count-and-newest-status',async()=>{
 let current=110;const f=await fixture(()=>notes(`已检查${current}个文件。`));f.add('assistant',state);
 for(let i=0;i<8;i++){
  if(i===4){current=117;f.add('assistant','更正：本批117个文件已完成扫描和格式检查。');}
  const start=f.surface.nodes[1],end=f.add('assistant','diagnostic evidence '.repeat(2000));await f.compact(start,end,true);
  const cold={...f.session,surface:{...f.surface,nodes:[...f.surface.nodes]},eventAt:n=>structuredClone(f.events[n])};const facts=collectProgressFacts(cold,cold.surface.nodes);assert.equal(facts.local.find(x=>x.key==='checkedFileCount').value,current);
  const cp=f.session.deriveEventMessage(f.events[f.surface.nodes[1]]);assert.ok(Buffer.byteLength(JSON.stringify(cp))<12000);assert.equal(f.surface.nodes.length,2);
 }
 assert.equal(f.calls.length,8);
});
await test('newer-tail-progress-during-request-is-checked-before-commit',async()=>{
 let f;f=await fixture(()=>{f.add('assistant','更正：本批已检查117个文件。');return nine('已检查110个文件。');});
 const start=f.add('assistant',state),end=f.add('assistant','diagnostic evidence '.repeat(2000)),before=[...f.surface.nodes];
 await assert.rejects(f.compact(start,end),e=>e.code==='PROGRESS_FACT_CONFLICT');assert.deepEqual(f.surface.nodes.slice(0,before.length),before);assert.equal(f.events.filter(e=>e.data?.source?.kind==='compact-checkpoint').length,0);
});
console.log(JSON.stringify({passed:rows.filter(x=>x.pass).length,failed:rows.filter(x=>!x.pass).length,results:rows},null,2));if(rows.some(x=>!x.pass))process.exitCode=1;
