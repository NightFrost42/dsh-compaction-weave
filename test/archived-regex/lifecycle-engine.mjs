import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {WeaveCompactionEngine} from '../../lib/engine.js';
import {resolveConfig} from '../../lib/config.js';
import {approxTokens,blocksToText} from '../../lib/meter.js';
import {selectSessionMemory} from '../../lib/region.js';
import {retiredMemoryPresent,memoryRequirements} from '../../lib/memory-policy.js';
// Fixed model responses and a synthetic event store; product-engine control
// tests, not real model or desktop task acceptance.
const results=[];
async function test(name,run){try{await run();results.push({name,pass:true});}catch(error){results.push({name,pass:false,error:error.message,stack:error.stack});}}
const headings=['Primary Request and Intent','Key Technical Concepts','Files and Code Sections','Errors and Fixes','Problem Solving','All User Messages','Pending Tasks','Work Completed','Context for Continuing Work'];
const nine=claim=>headings.map((h,i)=>`## ${i+1}. ${h}\n${i===5?'[filled by engine]':i===0?claim:'(none)'}`).join('\n\n');
const notes=claim=>`## Goal\nContinue the existing task.\n## State\n${claim}\n## Next\nReview active work.\n## Uncertain\nRuntime verification is pending.`;
async function fixture({continuation=false,response='Continue the analysis.',...extra}={}) {
  const root=await mkdtemp(join(tmpdir(),'weave-boundary-')),events=[],surface={nodes:[],replaceGeneration:0},calls=[];
  const session={
    id:randomUUID(),surface,get seq(){return events.length;},eventAt:seq=>events[seq],snapshotEvents:()=>events,
    requestHeader:()=>({config:{provider:'offline',model:'fixed-response'}}),toolHistory:()=>[],
    deriveEventMessage:event=>event?.data?.message??event?.data,
    append(type,data,options={}) {
      const event={seq:events.length,type,data,...(options.sourceEventSeqs?{sourceEventSeqs:options.sourceEventSeqs}:{})};
      events.push(event);
      if(options.surfaceOp==='append')surface.nodes.push(event.seq);
      else if(options.surfaceOp?.op==='replace') {
        const start=surface.nodes.indexOf(options.surfaceOp.startSeq),end=surface.nodes.indexOf(options.surfaceOp.endSeq);
        assert.ok(start>=0&&end>=start);surface.nodes.splice(start,end-start+1,event.seq);surface.replaceGeneration++;
      }
      return event;
    },
  };
  const add=(role,text,kind=role==='user'?'user':'model')=>session.append(role+'/message',role==='assistant'
    ?{message:{id:randomUUID(),role,content:[{type:'text',text}],source:{kind}}}
    :{id:randomUUID(),role,content:[{type:'text',text}],source:{kind}},{surfaceOp:'append'});
  const tool=text=>{
    const callId=randomUUID(),name='web_fetch',args='{"url":"https://example.invalid/reference"}';
    session.append('assistant/message',{message:{id:randomUUID(),role:'assistant',content:[{type:'tool-call',callId,name,arguments:args}],source:{kind:'model'}}},{surfaceOp:'append'});
    const call=session.append('tool/call',{callId,name,arguments:args});
    return session.append('tool/result',{message:{role:'tool',toolCallId:callId,content:[{type:'text',text}]}},{surfaceOp:'append',sourceEventSeqs:[call.seq]});
  };
  const measure=()=>{
    const nodes=surface.nodes.map(seq=>({seq,tokens:approxTokens(blocksToText(session.deriveEventMessage(events[seq])?.content))}));
    return {nodes,totalTokens:nodes.reduce((n,row)=>n+row.tokens,0)};
  };
  const ctx={on(){},provide(){},logger:{info(){},warn(){}},sessions:{async flush(){}},tokenMeter:{measure},llm:{
    async resolveModelInfo(){return {contextWindow:1000000};},
    async *stream(options){
      calls.push(options);
      const claim=typeof response==='function'?response(calls.length):response;
      yield {type:'text-delta',text:continuation?notes(claim):nine(claim)};
      yield {type:'finish',kind:'stop'};
    },
  }};
  const policy=resolveConfig({archiveDir:join(root,'archive'),language:'en',summaryInputMaxBytes:200000,summaryRetryCount:0,summaryRetryDelayMs:0,...extra}).config;
  const engine=new WeaveCompactionEngine(ctx,policy);engine.historyToolsAvailable=true;
  const agent={session,options:{provider:'offline',model:'fixed-response'},runMaintenance:fn=>fn(new AbortController().signal)};
  add('system','Stable system context.');
  const compact=async()=>{
    add('assistant','Historical diagnostic detail '.repeat(2200));
    const before=structuredClone(events),seqs=surface.nodes.slice(1);
    try{return await engine._compactRegionCore(seqs[0],seqs.at(-1),agent,new AbortController().signal,{manual:true,policy,...(continuation?{continuation:true,continuationBudgetTokens:14000}:{})});}
    finally{assert.deepEqual(events.slice(0,before.length),before,'Compaction must not edit original events.');}
  };
  const checkpoint=()=>session.deriveEventMessage(events[surface.nodes.at(-1)]);
  return {events,surface,calls,session,add,tool,compact,checkpoint,engine};
}


for(const continuation of [false,true]) {
 const mode=continuation?'continuation':'ordinary';
 await test(`${mode}-released-prohibition-stays-released-across-three-generations`,async()=>{
  const f=await fixture({continuation,response:'用户已允许修改配置文件。'});
  f.add('user','不要修改配置文件。');f.add('user','现在允许修改配置文件了。');
  for(let n=0;n<3;n++){
   await f.compact();const selected=selectSessionMemory(f.session,f.surface.nodes);
   assert.doesNotMatch(selected.active.map(m=>m.text).join('\n'),/不要修改配置文件/);
   assert.doesNotMatch(blocksToText(f.checkpoint().content),/不要修改配置文件/);
   assert.match(blocksToText(f.checkpoint().content),/用户已允许/);
  }
 });
 await test(`${mode}-local-delivery-quote-eviction-cannot-authorize-upload`,async()=>{
  const f=await fixture({continuation,preserveRecentMessages:1,response:'把报告上传到远端站点。'});
  f.add('user','报告仅在本地交付。');f.add('user','新的无关观察。');
  try{await f.compact();assert.doesNotMatch(blocksToText(f.checkpoint().content),/把报告上传/);}
  catch(error){assert.ok(['CONSTRAINT_LOST','CONSTRAINT_POLARITY_LOST'].includes(error.code)||error.failureCodes?.some(c=>['CONSTRAINT_LOST','CONSTRAINT_POLARITY_LOST'].includes(c)));assert.equal(f.surface.replaceGeneration,0);}
 });
 await test(`${mode}-revoked-task-first-paraphrase-is-rejected`,async()=>{
  const f=await fixture({continuation,response:'下一步绘制地图。'});f.add('user','请生成地图。');f.add('user','取消生成地图。');
  await assert.rejects(f.compact(),error=>error.code==='RETIRED_MEMORY_REINTRODUCED'||error.failureCodes?.includes('RETIRED_MEMORY_REINTRODUCED'));assert.equal(f.surface.replaceGeneration,0);
 });
 await test(`${mode}-revocation-survives-five-generations-and-real-reauthorization`,async()=>{
  const f=await fixture({continuation,summaryRetryCount:1,response:n=>n<=5?'地图任务已取消。':n===6?'下一步绘制地图。':n===7?'地图任务已取消。':'下一步绘制地图。'});
  const task=f.add('user','请生成地图。');f.add('user','取消生成地图。');
  for(let n=0;n<5;n++){await f.compact();assert.ok(retiredMemoryPresent('下一步绘制地图。',selectSessionMemory(f.session,f.surface.nodes)));}
  await f.compact();assert.equal(f.calls.length,7);assert.equal(f.surface.replaceGeneration,6);assert.doesNotMatch(blocksToText(f.checkpoint().content),/下一步绘制地图/);
  f.add('user','请重新制作地图。');await f.compact();assert.match(blocksToText(f.checkpoint().content),/下一步绘制地图/);assert.equal(f.events[task.seq].data.content[0].text,'请生成地图。');
 });
 await test(`${mode}-resolved-sibling-cancellation-survives-three-generations`,async()=>{
  const f=await fixture({continuation,response:'上传任务已取消。'});
  f.add('user','上传到站点A。上传到站点B。');f.add('user','取消上传到站点B。');f.add('user','取消上传。');
  for(let n=0;n<3;n++){await f.compact();assert.equal(selectSessionMemory(f.session,f.surface.nodes).active.length,0);}
  assert.equal(f.calls.length,3);assert.equal(f.surface.replaceGeneration,3);
 });
 await test(`${mode}-projected-retirement-survives-offset-change`,async()=>{
  const f=await fixture({continuation,response:'继续分析剩余工作。'});
  f.add('user','生成报告。生成地图。');f.add('user','取消生成报告。');await f.compact();
  f.add('user','取消生成地图。');await f.compact();await f.compact();
  assert.equal(selectSessionMemory(f.session,f.surface.nodes).active.length,0);
  assert.equal(f.calls.length,3);assert.equal(f.surface.replaceGeneration,3);
 });
 await test(`${mode}-future-adoption-does-not-invalidate-authentic-retirement`,async()=>{
  const f=await fixture({continuation,response:'继续分析剩余工作。'});
  f.add('user','上传到站点A。');f.add('user','以下是历史引用：\n```text\n上传到站点B。\n```\n引用结束\n取消上传。');
  await f.compact();f.add('user','我采纳上一条引用作为当前要求。\n生成地图。取消生成地图。');
  await f.compact();await f.compact();
  assert.ok(selectSessionMemory(f.session,f.surface.nodes).decisions.some(d=>d.reason==='cancelled'&&d.text==='上传到站点A。'));
  assert.equal(f.calls.length,3);assert.equal(f.surface.replaceGeneration,3);
 });
 await test(`${mode}-unfenced-structured-notes-stay-parseable`,async()=>{
  const code='[\n  {\n    "x": 1\n  },\n  {\n    "x": 1\n  }\n]';
  const f=await fixture({continuation,response:code});f.add('user','请分析数据样例。');await f.compact();assert.ok(blocksToText(f.checkpoint().content).includes(code));assert.deepEqual(JSON.parse(code),[{x:1},{x:1}]);
 });
}
console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));if(results.some(r=>!r.pass))process.exitCode=1;
