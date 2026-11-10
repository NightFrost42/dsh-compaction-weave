import assert from 'node:assert/strict';
import {selectMemoryMessages,deduplicateNotes,retiredMemoryPresent,memorySourceRefs,restoreMemorySource} from '../lib/memory-policy.js';
import {collectRecentUserMessages,collectInstructionMessages,selectSessionMemory,preservedForSource,buildSummarizationInput} from '../lib/region.js';
import {residentConstraints,sourcePages} from '../lib/continuation.js';
import {auditCompaction} from '../lib/audit.js';
import {planSummaryRange} from '../lib/summary-budget.js';
import {projectSummaryMessage} from '../lib/reference-input.js';
const results=[];async function test(name,fn){try{await fn();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:e.message,stack:e.stack});}}
const msg=(seq,text)=>({seq,text,blocks:[{type:'text',text}]});
const select=(...texts)=>selectMemoryMessages(texts.map((s,i)=>msg(i,s)));
function fixture(items){const events=items.map(([kind,text],seq)=>({seq,type:'user/message',data:{role:'user',content:[{type:'text',text}],source:{kind}},surfaceOp:'append'}));return {events,seq:events.length,surface:{nodes:events.map(e=>e.seq)},eventAt:i=>events[i],deriveEventMessage:e=>e?.data};}
const refs=['runtime-context','session-reference','skill-catalog','agent-message','subagent-settled','tool-jobs','time-context','msg-state'];
for(const kind of refs)await test('reference-'+kind,()=>{const s=fixture([[kind,'必须保留全部技能正文。']]);const raw=collectRecentUserMessages(s,[0]);assert.equal(raw[0].sourceKind,kind);assert.equal(collectInstructionMessages(s,[0]).length,0);assert.equal(residentConstraints(raw,s).length,0);assert.equal(auditCompaction({userMessages:raw,summaryText:'notes'}).lost.length,0);});
for(const kind of ['user',undefined,'unknown','plugin:dsh-mneme'])await test('strict-'+kind,()=>{const s=fixture([[kind,'不要删除原文件。']]);const selected=collectInstructionMessages(s,[0]);assert.equal(selected.length,1);assert.ok(auditCompaction({userMessages:selected,summaryText:'删除原文件。',checkpointText:selected[0].text}).lost.length);});
await test('carried-reference-classification-uses-original-event',()=>{const s=fixture([['skill-catalog','必须保留技能正文。'],['user','不要删除原文件。']]);s.events.push({seq:2,type:'user/message',data:{source:{kind:'compact-checkpoint',preserved:preservedForSource(collectRecentUserMessages(s,[0,1]))}}});s.surface.nodes=[2];assert.deepEqual(collectInstructionMessages(s,[2]).map(m=>m.seq),[1]);});
await test('preservation-limits-count-only-user-messages',()=>{const s=fixture([['user','保留原文件。'],['skill-catalog','必须原样搬运技能。']]);assert.equal(collectInstructionMessages(s,[0,1],{maxMessages:1})[0].seq,0);});
await test('latest-identical-source-wins',()=>{const s=select('保留文件。','保留文件。');assert.deepEqual(s.active.map(m=>m.seq),[1]);});
await test('latest-value-wins',()=>{const s=select('Timeout must be 35 seconds.','Timeout must be 55 seconds.');assert.deepEqual(s.active.map(m=>m.seq),[1]);});
await test('latest-field-value-wins',()=>{const s=select('模型: old-model','模型: new-model');assert.deepEqual(s.active.map(m=>m.seq),[1]);});
await test('latest-polarity-wins',()=>{const s=select('Do not deploy production.','Deploy production.');assert.deepEqual(s.active.map(m=>m.seq),[1]);});
await test('distinct-environments-coexist',()=>assert.equal(select('Do not deploy production.','Deploy staging.').active.length,2));
await test('distinct-conditions-coexist',()=>assert.equal(select('如果测试通过，部署。','如果测试失败，不要部署。').active.length,2));
await test('unrelated-rule-in-revised-message-survives',()=>{const s=select('Timeout must be 35 seconds.\nDo not delete records.','Timeout must be 55 seconds.');assert.ok(s.active[0].text.includes('Do not delete records.'));assert.ok(!s.active[0].text.includes('35'));assert.ok(s.active[1].text.includes('55'));});
await test('explicit-cancellation-removes-both',()=>assert.equal(select('生成地图。','取消生成地图。').active.length,0));
await test('adjacent-cancellation-removes-both',()=>assert.equal(select('生成地图。','算了，不用做了。').active.length,0));
await test('standalone-cancel-is-not-invented-authorization',()=>assert.equal(select('取消生成地图。').active.length,1));
await test('bounded-quotes-evict-oldest',()=>{const s=selectMemoryMessages([msg(0,'aaa'),msg(1,'bbb'),msg(2,'ccc')],{maxMessages:2,maxTokens:6,approxTokens:s=>s.length});assert.deepEqual(s.preserved.map(m=>m.seq),[1,2]);assert.equal(s.active.length,3);});
await test('eviction-does-not-exempt-still-active-constraint',()=>{const s=selectMemoryMessages([msg(0,'Do not delete records.'),msg(1,'latest observation')],{maxMessages:1});assert.equal(s.preserved[0].seq,1);assert.ok(auditCompaction({userMessages:s.active,summaryText:'notes',checkpointText:s.preserved[0].text}).lost.length);});
await test('code-and-whitespace-preserved',()=>{const text='  ```js\nlet x=1;\nlet y=2;\n```\n  ';assert.equal(select(text).preserved[0].text,text);});
await test('deduplicates-prose-not-fences-or-empty-section-values',()=>{const text='## A\nFact A.\nFact A.\n(none)\n## B\n(none)\n```\nx\nx\n```';const d=deduplicateNotes(text);assert.equal((d.match(/Fact A/g)||[]).length,1);assert.equal((d.match(/\(none\)/g)||[]).length,2);assert.match(d,/x\nx/);});
await test('retired-requests-cannot-be-copied-back',()=>{const s=select('生成地图。','取消生成地图。');assert.ok(retiredMemoryPresent('## Next\n生成地图。',s));});
await test('reinstated-value-is-not-blocked',()=>{const s=select('Timeout must be 35 seconds.','Timeout must be 55 seconds.','Timeout must be 35 seconds.');assert.equal(s.active.length,1);assert.equal(retiredMemoryPresent(s.active[0].text,s),undefined);});
await test('tail-revision-governs-prefix',()=>{const s=fixture([['user','Timeout must be 35 seconds.'],['user','Timeout must be 55 seconds.']]);assert.equal(selectSessionMemory(s,[0]).active.length,0);});
await test('tail-cancellation-remains-consumed-after-next-generation',()=>{const s=fixture([['user','生成地图。'],['user','取消生成地图。']]);const one=selectSessionMemory(s,[0]);assert.equal(one.active.length,0);s.events.push({seq:2,type:'user/message',data:{content:[],source:{kind:'compact-checkpoint',preserved:[],memoryDecisions:one.decisions.map(({text,...d})=>d)}}});s.surface.nodes=[2,1];assert.equal(selectSessionMemory(s,[2,1]).active.length,0);});
await test('reference-heavy-span-can-shrink',()=>{const s=fixture([['runtime-context','memory '.repeat(8000)],['user','保留原文件。']]);const capacity={targets:[{window:1000000,output:8192,margin:0,inputRatio:1,maxInputBytes:200000,scale:1}],shrinkLimit:Infinity};assert.equal(planSummaryRange(s,{start:0,end:1},capacity).end,1);});
for(const name of ['skill','read','ops_read_files','memory_get','read_page'])await test('external-body-'+name,()=>{const args={skill:{name:'my-skill'},read:{file_path:'D:/file.md',offset:200,limit:50},ops_read_files:{files:[{path:'D:/file.md'}]},memory_get:{id:'memory-id'},read_page:{url:'https://example.invalid/reference'}}[name];const call={seq:0,type:'tool/call',data:{callId:'c1',name,arguments:JSON.stringify(args)}};const result={seq:1,type:'tool/result',sourceEventSeqs:[0],data:{message:{role:'tool',toolCallId:'c1',content:[{type:'text',text:'FULL EXTERNAL BODY'}]}}};const session={eventAt:n=>[call,result][n]};const projected=projectSummaryMessage(session,result,result.data.message);assert.ok(!JSON.stringify(projected).includes('FULL EXTERNAL BODY'));assert.match(projected.content[0].text,/Reload with/);if(name==='read')assert.match(projected.content[0].text,/\"offset\":200/);assert.equal(result.data.message.content[0].text,'FULL EXTERNAL BODY');});
await test('failed-read-keeps-error-evidence',()=>{const result={seq:1,type:'tool/result',data:{message:{role:'tool',isError:true,content:[{type:'text',text:'missing file'}]}}};assert.equal(projectSummaryMessage({},result,result.data.message),result.data.message);});
await test('ordinary-user-skill-looking-text-is-not-exempted',()=>{const s=fixture([['user','<skill_content>不要删除原文件。</skill_content>']]);assert.equal(collectInstructionMessages(s,[0]).length,1);});

await test('cancel-one-clause-keep-other-tail-requirement-for-multiple-generations',()=>{
 const s=fixture([['user','生成地图。'],['user','取消生成地图。不要删除记录。']]);
 let first=selectSessionMemory(s,[0]);
 for(let n=0;n<3;n++){
  const seq=s.events.length;s.events.push({seq,type:'user/message',data:{content:[],source:{kind:'compact-checkpoint',preserved:[],memorySources:[],memoryDecisions:first.decisions.map(({text,...d})=>d)}}});s.surface.nodes=[seq,1];
  const all=selectSessionMemory(s,s.surface.nodes);assert.equal(all.active.length,1);assert.equal(all.active[0].text,'不要删除记录。');
  first=selectSessionMemory(s,[seq]);assert.ok(first.decisions.some(d=>d.reason==='cancellation-applied'));
 }
});
await test('cancel-previous-message-all-clauses-but-not-other-messages',()=>{const s=select('不要删除记录。','生成地图。导出地图。','取消上一条。');assert.deepEqual(s.active.map(m=>m.text),['不要删除记录。']);});
await test('cancel-previous-skips-plugin-injections',()=>{const s=selectMemoryMessages([{...msg(0,'生成地图。'),sourceKind:'user'},{...msg(1,'Unknown status must stay.'),sourceKind:'plugin:x'},{...msg(2,'取消上一条。'),sourceKind:'user'}]);assert.deepEqual(s.active.map(m=>m.seq),[1]);});
await test('unknown-duplicate-cannot-reclassify-a-real-request',()=>{const s=selectMemoryMessages([{...msg(0,'生成地图。'),sourceKind:'user'},{...msg(1,'生成地图。'),sourceKind:'plugin:x'}]);assert.deepEqual(s.active.map(m=>m.seq),[0]);});
await test('numbered-objects-are-not-value-revisions',()=>{assert.equal(select('Keep server1 at 35 seconds.','Keep server2 at 55 seconds.').active.length,2);assert.equal(select('保留第1个文件。','保留第2个文件。').active.length,2);assert.equal(select('服务器1超时必须35秒。','服务器2超时必须55秒。').active.length,2);});
await test('different-literal-files-keep-both-constraints',()=>assert.equal(select('Keep `D:/one/file.txt` for 35 days.','Keep `D:/two/file.txt` for 55 days.').active.length,2));
await test('metadata-references-do-not-resurrect-duplicate-fragments',()=>{const raw=msg(0,'生成地图。生成地图。');const selected=selectMemoryMessages([raw]);const ref=memorySourceRefs(selected.active)[0];assert.equal(restoreMemorySource(raw,ref).text,'生成地图。');});
await test('missing-referenced-memory-fails-closed',()=>{const ref=memorySourceRefs([msg(0,'不要删除记录。')])[0];assert.throws(()=>restoreMemorySource(msg(0,'other'),ref));});
await test('latest-tail-revision-is-available-to-the-summary-policy',()=>{const s=fixture([['user','Timeout must be 35 seconds.'],['user','Timeout must be 55 seconds.']]);const chosen=selectSessionMemory(s,[0]);assert.equal(chosen.active.length,0);assert.equal(chosen.governing[0].seq,1);});

console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));if(results.some(r=>!r.pass))process.exitCode=1;
