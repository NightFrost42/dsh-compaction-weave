import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectProgressFacts,extractProgressFacts,progressSourceRefs,renderProgressFacts,validateProgressFacts} from '../../lib/progress-facts.js';
import {collectWorkReport,scopeWorkReport,workReportRef} from '../../lib/work-report.js';
import {progressFrames} from '../../lib/progress-state.js';
import {WeaveCompactionEngine} from '../../lib/engine.js';
import {resolveConfig} from '../../lib/config.js';
import {approxTokens,blocksToText} from '../../lib/meter.js';

const rows=[];
async function test(name,fn){try{await fn();rows.push({name,pass:true});}catch(error){rows.push({name,pass:false,error:error.stack});}}
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const facts=(text,seq=0)=>extractProgressFacts(text,{seq,semantic:true});
function fixture(){
  const events=[],surface={nodes:[],replaceGeneration:0};
  const session={id:randomUUID(),get seq(){return events.length;},surface,eventAt:n=>events[n],snapshotEvents:()=>events,
    deriveEventMessage:e=>e?.type?.endsWith('/message')?e.data.message??e.data:null,
    requestHeader:()=>({config:{provider:'offline-fixture',model:'fixed-response'}}),toolHistory:()=>[],
    append(type,data,options={}){
      const event={seq:events.length,type,data};events.push(event);
      if(options.surfaceOp==='append')surface.nodes.push(event.seq);
      else if(options.surfaceOp?.op==='replace'){
        const a=surface.nodes.indexOf(options.surfaceOp.startSeq),b=surface.nodes.indexOf(options.surfaceOp.endSeq);
        assert.ok(a>=0&&b>=a);surface.nodes.splice(a,b-a+1,event.seq);surface.replaceGeneration++;
      }
      return event;
    },
  };
  const add=(role,text,kind=role==='assistant'?'model':'user')=>{
    const message={role,content:[{type:'text',text}],source:{kind}};
    return session.append(role+'/message',role==='assistant'?{message}:message,{surfaceOp:'append'}).seq;
  };
  return {session,events,surface,add,select:()=>collectProgressFacts(session,surface.nodes)};
}
const value=(selection,key,scope)=>selection.effective.find(f=>f.key===key&&(!scope||f.scope===scope))?.value;
const valid=(text,selection)=>assert.equal(validateProgressFacts(text,selection).ok,true,JSON.stringify(validateProgressFacts(text,selection)));
const invalid=(text,selection,reason)=>{
  const verdict=validateProgressFacts(text,selection);assert.equal(verdict.ok,false,text);
  if(reason)assert.ok(verdict.audit.lost.some(f=>f.reason===reason),JSON.stringify(verdict));
};
const nine=claim=>['Primary Request and Intent','Key Technical Concepts','Files and Code Sections','Errors and Fixes','Problem Solving','All User Messages','Pending Tasks','Work Completed','Context for Continuing Work'].map((h,i)=>`## ${i+1}. ${h}\n${i===5?'[filled by engine]':i===7?claim:'(none)'}`).join('\n\n');
const notes=claim=>`## Goal\nContinue the current work.\n## State\n${claim}\n## Next\nFollow the original outstanding work.\n## Uncertain\nReported evidence is not independently verified.`;
function engineFixture(response){
  const f=fixture(),calls=[],root=mkdtempSync(join(tmpdir(),'weave-state-semantics-'));
  const measure=()=>{
    const nodes=f.surface.nodes.map(seq=>({seq,tokens:approxTokens(blocksToText(f.session.deriveEventMessage(f.events[seq])?.content))}));
    return {nodes,totalTokens:nodes.reduce((n,f)=>n+f.tokens,0)};
  };
  const ctx={on(){},provide(){},logger:{info(){},warn(){}},sessions:{async flush(){}},tokenMeter:{measure},
    llm:{async resolveModelInfo(){return {contextWindow:1000000};},async *stream(options){calls.push(options);yield {type:'text-delta',text:response};yield {type:'finish',kind:'stop'};}},
  };
  const policy=resolveConfig({archiveDir:join(root,'archive'),language:'en',summaryInputMaxBytes:200000,summaryRetryCount:0,summaryRetryDelayMs:0}).config;
  const engine=new WeaveCompactionEngine(ctx,policy);engine.historyToolsAvailable=true;
  const agent={session:f.session,options:{provider:'offline-fixture',model:'fixed-response'},runMaintenance:fn=>fn(new AbortController().signal)};
  f.add('system','Offline production-engine regression.');
  const compact=async(continuation=false)=>{
    const end=f.add('assistant','Diagnostic details '.repeat(2000)),before=structuredClone(f.events);
    const start=f.surface.nodes[1];
    try{return await engine._compactRegionCore(start,end,agent,new AbortController().signal,{manual:true,policy,continuation,continuationBudgetTokens:18000});}
    finally{assert.deepEqual(f.events.slice(0,before.length),before,'Original source events remain unchanged.');}
  };
  return {...f,engine,calls,compact};
}

await test('D03-natural-correction-keeps-count-negation-role-and-source-hash',()=>{
  const f=fixture(),old=f.add('assistant','最新进度：本批110个文件已完成扫描。报告已生成。');
  const seq=f.add('user','不对，报告尚未生成，实际只检查了105个文件。'),s=f.select();
  assert.equal(value(s,'checkedFileCount'),105);assert.equal(value(s,'reportGenerated'),false);
  assert.equal(s.effective.find(f=>f.key==='checkedFileCount').seq,seq);
  assert.equal(s.effective.find(f=>f.key==='checkedFileCount').role,'user');
  assert.equal(s.effective.find(f=>f.key==='checkedFileCount').sha256,hash(f.events[seq].data.content));
  valid('经用户核实，本批已检查105个文件，报告尚未生成。',s);
  invalid('本批已检查110个文件，报告已生成。',s);
  const report=scopeWorkReport(collectWorkReport(f.session,[old]),s);
  assert.equal(report.supersededBy,seq);assert.equal(report.omitted,true);
});
await test('user-question-future-plan-pasted-history-and-tool-output-do-not-correct-state',()=>{
  const f=fixture();f.add('assistant','已检查110个文件。报告已生成。');
  for(const text of ['实际只检查了105个文件吗？','不对，计划检查105个文件。','以下是历史引用，请只分析。\n不对，实际只检查了105个文件。\n引用结束。','```js\ncheckedFileCount=105\n```'])f.add('user',text);
  f.add('user','不对，实际只检查了105个文件。','runtime-context');
  const seq=f.events.length;f.events.push({seq,type:'tool/result',data:{message:{role:'tool',content:[{type:'text',text:'实际只检查105个文件。'}]}}});f.surface.nodes.push(seq);
  assert.equal(value(f.select(),'checkedFileCount'),110);assert.equal(value(f.select(),'reportGenerated'),true);
});
await test('assistant-pasted-reference-cannot-become-new-observation',()=>{
  const f=fixture();f.add('assistant','任务甲的报告尚未生成。');
  f.add('assistant','以下为历史引用：\n任务甲的报告已生成。\n引用结束。');
  assert.equal(value(f.select(),'reportGenerated','task:%E7%94%B2'),false);
});
await test('D05-future-confirmation-and-conditional-result-are-not-current-completion',()=>{
  const s={effective:facts('报告尚未生成。')};
  for(const plan of ['计划在复核通过后确认报告已生成。','待检查结束后再确认报告已生成。','We plan to confirm the report has been generated after review.','下一步复核报告，确认报告已生成。']){
    valid(plan,s);assert.ok(!extractProgressFacts(plan,{candidate:true}).some(f=>f.key==='reportGenerated'&&f.value===true),plan);
  }
  invalid('计划复核报告，但目前报告已生成。',s);
  invalid('计划复核报告；报告已生成。',s);
});
await test('D05-artifact-completion-does-not-establish-tests-or-independent-verification',()=>{
  const f=fixture();f.add('assistant','报告已完成，尚未测试；下一步测试报告。');const s=f.select();
  assert.equal(value(s,'reportGenerated'),true);
  assert.equal(value(s,'verificationState','current-work/activity:report'),'untested');
  valid('报告已生成，尚未测试。下一步测试报告。',s);
  invalid('报告已生成，已经通过独立测试与验证。',s);
  invalid('报告已生成，已经通过测试。',s);
});
await test('reported-independent-check-remains-attributed-evidence',()=>{
  const f=fixture();f.add('assistant','构建已经通过独立测试。');const s=f.select();
  valid('助手报告构建已经通过独立测试。',s);
  invalid('构建已经通过独立测试。',s,'progress-unsupported-verification');
  assert.ok(s.effective.every(f=>f.verification==='assistant-reported'));
});
await test('D05-build-failure-code-next-action-and-retry-plan-survive',()=>{
  const f=fixture();f.add('assistant','构建失败，原因 E_LOCK；下一步释放锁后重新构建。');const s=f.select();
  assert.equal(value(s,'executionState','current-work/activity:build'),'failed');
  assert.equal(value(s,'failureCode','current-work/activity:build'),'E_LOCK');
  assert.equal(value(s,'nextAction'),'text:释放锁后重新构建');
  invalid('构建已经通过，已完成全部验证，没有剩余动作。',s);
  invalid('构建失败，原因 E_OTHER；下一步释放锁后重新构建。',s);
  valid('构建失败，原因 E_LOCK；下一步释放锁后重新构建。',s);
  f.add('assistant','计划明天重新构建。');assert.equal(value(f.select(),'executionState','current-work/activity:build'),'failed');
});
await test('execution-plan-attempt-running-unknown-and-result-remain-distinct',()=>{
  for(const [source,state] of [
    ['部署已尝试，结果未知。','unknown'],['部署已经启动，仍在运行中。','running'],['部署尚未开始。','not-started'],['部署已经完成。','completed'],['计划明天部署。','planned'],
  ]){
    const f=fixture();f.add('assistant',source);const s=f.select();assert.equal(value(s,'executionState','current-work/activity:deploy'),state,JSON.stringify(s));
    if(state!=='completed')invalid('部署已经完成。',s);
    valid(source,s);
  }
});
await test('open-vocabulary-operation-failure-is-not-limited-to-report-chart-build',()=>{
  for(const operation of ['索引重建','快照归档','资源预热']){
    const f=fixture();f.add('assistant',`${operation}失败，原因 E_BUSY；下一步释放资源后重试。`);
    const s=f.select();assert.ok(s.effective.some(f=>f.key==='executionState'&&f.value==='failed'),operation);
    invalid(`${operation}已完成。`,s);valid(`${operation}失败，原因 E_BUSY；下一步释放资源后重试。`,s);
  }
});
await test('new-success-resolves-old-failure-without-retaining-stale-code',()=>{
  const f=fixture();f.add('assistant','构建失败，原因 E_LOCK。下一步释放锁后重新构建。');
  f.add('assistant','构建重新执行成功。下一步部署。');const s=f.select();
  assert.equal(value(s,'executionState','current-work/activity:build'),'succeeded');
  assert.equal(value(s,'failureCode','current-work/activity:build'),undefined);
  valid('构建已完成。下一步部署。',s);invalid('构建失败，原因 E_LOCK。',s);
});
await test('D06-two-tasks-with-same-artifact-retain-distinct-latest-states',()=>{
  const f=fixture(),a=f.add('assistant','任务甲的报告已生成。');f.add('assistant','任务乙的报告尚未生成。');const s=f.select();
  assert.equal(s.effective.filter(f=>f.key==='reportGenerated').length,2);
  valid('任务甲的报告已生成；任务乙的报告尚未生成。',s);
  invalid('任务甲的报告尚未生成；任务乙的报告尚未生成。',s);
  invalid('报告尚未生成。',s);
  assert.equal(scopeWorkReport(collectWorkReport(f.session,[a]),s).omitted,undefined);
});
await test('object-context-carries-within-message-not-across-unrelated-messages',()=>{
  const f=fixture();f.add('assistant','项目 Atlas：任务导入的报告已生成。图表尚未生成。');
  f.add('assistant','项目 Boreal：任务导入的报告尚未生成。图表已生成。');
  const s=f.select();assert.equal(s.effective.filter(f=>f.key==='reportGenerated').length,2);
  assert.equal(s.effective.filter(f=>f.key==='chartGenerated').length,2);
  valid('项目 Atlas：任务导入的报告已生成。图表尚未生成。\n项目 Boreal：任务导入的报告尚未生成。图表已生成。',s);
  invalid('项目 Atlas：任务导入的报告尚未生成。',s);
});
await test('explicit-batches-remain-distinct-and-do-not-become-file-quantities',()=>{
  const f=fixture();f.add('assistant','批次 A 报告已生成。');f.add('assistant','批次 B 报告尚未生成。');
  const s=f.select();assert.equal(s.effective.filter(f=>f.key==='reportGenerated').length,2);
  valid('批次 A 报告已生成。批次 B 报告尚未生成。',s);invalid('批次 A 报告尚未生成。',s);
  assert.equal(facts('新批次90个文件已完成扫描。')[0].scope,'current-work');
});
await test('v1-fixture-identities-validate-before-semantic-migration',()=>{
  const corpus=JSON.parse(readFileSync(new URL('./fixtures/progress-source-identities.json',import.meta.url),'utf8'));
  for(const fixtureRow of corpus){
    const f=fixture(),seq=f.add('assistant',fixtureRow.text),legacy=extractProgressFacts(fixtureRow.text,{seq});
    const sha256=hash(f.events[seq].data.message.content);
    const cp=f.add('user','Invented completion.', 'compact-checkpoint');
    f.events[cp].data.source.progressFacts={version:1,sources:legacy.length?[{seq,sha256,ids:legacy.map(f=>f.id)}]:[]};
    f.surface.nodes.splice(0,f.surface.nodes.length,cp);
    const restored=f.select();
    if(legacy.length)assert.deepEqual(restored.effective.map(f=>[f.key,f.value,f.scope]),facts(fixtureRow.text).map(f=>[f.key,f.value,f.scope]).sort((a,b)=>a[0].localeCompare(b[0])));
    assert.ok(restored.effective.every(f=>f.seq===seq));
  }
});
await test('v1-task-collapse-migrates-original-object-and-v2-cold-generations-preserve-it',()=>{
  const f=fixture(),seq=f.add('assistant','任务甲的报告已生成。任务乙的报告尚未生成。'),original=structuredClone(f.events[seq]);
  const legacy=extractProgressFacts(blocksToText(original.data.message.content),{seq});
  let cp=f.add('user','Tasks were both completed.','compact-checkpoint');
  f.events[cp].data.source.progressFacts={version:1,sources:[{seq,sha256:hash(original.data.message.content),ids:legacy.map(f=>f.id)}]};
  f.surface.nodes.splice(0,f.surface.nodes.length,cp);
  for(let i=0;i<6;i++){
    const cold={...f.session,eventAt:n=>structuredClone(f.events[n])},s=collectProgressFacts(cold,f.surface.nodes);
    assert.equal(s.effective.filter(f=>f.key==='reportGenerated').length,2);
    const refs=progressSourceRefs(s);assert.equal(refs.version,2);
    cp=f.add('user','Invented state.','compact-checkpoint');f.events[cp].data.source.progressFacts=refs;
    f.surface.nodes.splice(0,f.surface.nodes.length,cp);f.surface.replaceGeneration++;
  }
  assert.deepEqual(f.events[seq],original);
  f.events[seq].data.message.content[0].text+='tampered';
  assert.throws(f.select,e=>e.code==='PROGRESS_SOURCE_UNAVAILABLE');
});
await test('legacy-work-report-only-and-summary-links-recover-state-from-original',()=>{
  for(const kind of ['work-report','summary-link']){
    const f=fixture(),seq=f.add('assistant','构建失败，原因 E_LOCK；下一步释放锁后重新构建。');
    const report=collectWorkReport(f.session,[seq]);assert.ok(report);
    let cp;
    if(kind==='work-report'){
      cp=f.add('user','构建已通过。','compact-checkpoint');f.events[cp].data.source.workReport=workReportRef(report);
    }else{
      const summary=f.events.length;f.events.push({seq:summary,type:'compaction/summary',data:{compactionId:'legacy',shadowedSeqs:[seq]}});
      cp=f.add('user','构建已通过。','compact-checkpoint');f.events[cp].data.source.compactionId='legacy';
    }
    f.surface.nodes.splice(0,f.surface.nodes.length,cp);
    assert.equal(value(f.select(),'failureCode','current-work/activity:build'),'E_LOCK');
  }
});
await test('v2-reference-rejects-forged-id-role-hash-and-bad-version',()=>{
  for(const mutate of [ref=>ref.sources[0].ids[0]='forged',ref=>ref.sources[0].sha256='forged',ref=>ref.sources[0].role='user',ref=>ref.version=3]){
    const f=fixture();f.add('assistant','构建失败。');const refs=progressSourceRefs(f.select());mutate(refs);
    const cp=f.add('user','notes','compact-checkpoint');f.events[cp].data.source.progressFacts=refs;f.surface.nodes.splice(0,f.surface.nodes.length,cp);
    assert.throws(f.select,e=>e.code==='PROGRESS_SOURCE_UNAVAILABLE');
  }
});
await test('independent-object-bounds-and-reported-identity-remain-bounded',()=>{
  const f=fixture();for(let i=0;i<80;i++)f.add('assistant',`任务 T${i} 的构建失败，原因 E_LOCK；下一步释放锁重试。`);
  const s=f.select();assert.ok(s.effective.length<=24);assert.ok(Buffer.byteLength(renderProgressFacts(s))<8500);
});

for(const continuation of [false,true]){
  for(const [name,sources,claim] of [
    ['unverified-result',['报告已完成，尚未测试；下一步测试报告。'],'报告已生成，已经通过独立测试与验证。'],
    ['failed-build',['构建失败，原因 E_LOCK；下一步释放锁后重新构建。'],'构建已经通过，已完成全部验证，没有剩余动作。'],
    ['task-identity',['任务甲的报告已生成。','任务乙的报告尚未生成。'],'任务甲的报告尚未生成；任务乙的报告尚未生成。'],
  ])await test(`${continuation?'paged':'normal'}-production-engine-rejects-${name}`,async()=>{
    const f=engineFixture((continuation?notes:nine)(claim));for(const source of sources)f.add('assistant',source);
    const before=[...f.surface.nodes];await assert.rejects(f.compact(continuation),e=>e.code==='PROGRESS_FACT_CONFLICT');
    assert.deepEqual(f.surface.nodes.slice(0,before.length),before);assert.equal(f.calls.length,1);
    assert.ok(!f.events.some(e=>e.data?.source?.kind==='compact-checkpoint'));
  });
  await test(`${continuation?'paged':'normal'}-production-engine-accepts-corrected-state-and-future-plan`,async()=>{
    const claim='本批已检查105个文件。报告尚未生成。计划在复核通过后确认报告已生成。';
    const f=engineFixture((continuation?notes:nine)(claim));f.add('assistant','本批已检查110个文件。报告已生成。');
    f.add('user','不对，报告尚未生成，实际只检查了105个文件。');
    await f.compact(continuation);assert.equal(f.calls.length,1);
    assert.equal(value(f.select(),'checkedFileCount'),105);assert.equal(value(f.select(),'reportGenerated'),false);
  });
}

await test('absence-of-approval-preconditions-does-not-erase-work',()=>{
 const source=extractProgressFacts('报告尚未生成。下一步生成报告。',{seq:0,semantic:true});
 const selection={effective:source};
 assert.equal(validateProgressFacts('当前无未完成的用户审批前置条件。',selection).ok,true);
 assert.equal(validateProgressFacts('没有剩余动作。',selection).ok,false);
 assert.equal(validateProgressFacts('无未完成任务。',selection).ok,false);
});
await test('requirements-with-error-codes-are-not-execution-failures',()=>{
  for(const text of [
    'qty 必须为正的安全整数，错误 E_QTY。',
    'lines 必须数组，错误 E_LINES；shippingCents 默认 0，须非负安全整数，错误 E_SHIPPING。',
    'parseCents 返回安全整数分；格式错必须抛 RangeError E_MONEY_FORMAT。',
    'CSV 支线先记为待办；它没有实现。先定位已有失败，等后续更正再做最后修复。',
    'The build must reject malformed input, error E_FORMAT.',
  ])assert.ok(!facts(text).some(f=>f.key==='failureCode'||f.key==='executionState'),text);
  const actual=facts('部署实际失败，错误 E_SHIPPING。');
  assert.ok(actual.some(f=>f.key==='executionState'&&f.value==='failed'));
  assert.ok(actual.some(f=>f.key==='failureCode'&&f.value==='E_SHIPPING'));
});
console.log(JSON.stringify({passed:rows.filter(r=>r.pass).length,failed:rows.filter(r=>!r.pass).length,results:rows},null,2));
if(rows.some(r=>!r.pass))process.exitCode=1;
