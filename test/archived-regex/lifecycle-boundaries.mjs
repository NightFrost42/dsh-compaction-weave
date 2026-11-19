import assert from 'node:assert/strict';
import vm from 'node:vm';
import {selectMemoryMessages,memoryRequirements,memoryDecisionsForSource,restoreRetiredDecisions,retiredMemoryPresent,deduplicateNotes,memorySourceRefs} from '../../lib/memory-policy.js';
import {auditCompaction,auditInstructionProvenance} from '../../lib/audit.js';
import {selectSessionMemory} from '../../lib/region.js';
const results=[];
async function test(name,run){try{await run();results.push({name,pass:true});}catch(error){results.push({name,pass:false,error:error.message,stack:error.stack});}}
const msg=(seq,text,sourceKind='user')=>({seq,text,sourceKind,blocks:[{type:'text',text}]});
const select=(...texts)=>selectMemoryMessages(texts.map((text,seq)=>msg(seq,text)),{maxMessages:0,maxTokens:0});
function fixture(texts){const events=texts.map((text,seq)=>({seq,type:'user/message',data:{role:'user',content:[{type:'text',text}],source:{kind:'user'}}}));return {events,get seq(){return events.length;},surface:{nodes:events.map(e=>e.seq)},eventAt:seq=>events[seq],deriveEventMessage:event=>event?.data};}
for(const [name,source,bad] of [
 ['local-report','报告仅在本地交付。','把报告上传到远端站点。'],
 ['local-log','日志只在本机保存。','将日志上传到远端站点。'],
 ['staging-run','脚本仅在测试环境运行。','在生产环境运行脚本。'],
 ['english-local','The report is delivered in local only.','Upload the report to a remote site.'],
 ['english-execution','The script is run only in staging.','Run the script in production.'],
])await test('declarative-'+name,()=>{
 const s=select(source);assert.equal(s.preserved.length,0);assert.equal(memoryRequirements(s.active).length,1);
 const lost=auditCompaction({userMessages:s.active,summaryText:bad,checkpointText:source,includeAllConflicts:true}).lost;
 assert.ok(lost.some(item=>item.reason==='scope'));assert.ok(auditCompaction({userMessages:s.active,summaryText:source}).checked);
});
for(const source of ['报告已在本地保存。','之前报告仅在本地交付。','日志显示报告仅在本地交付。','以下是历史引用：\n报告仅在本地交付。'])await test('observation-reference-not-a-new-exclusive-rule-'+source,()=>assert.deepEqual(memoryRequirements([msg(0,source)]),[]));
await test('local-target-control',()=>assert.equal(auditCompaction({userMessages:[msg(0,'报告仅在本地交付。')],summaryText:'报告保存到本地。',checkpointText:'报告仅在本地交付。'}).lost.length,0));
for(const [a,b,c] of [
 ['不要修改配置文件。','现在允许修改配置文件了。','用户已允许修改配置文件。'],
 ['禁止上传报告到内网站点。','现在允许上传报告到内网站点了。','用户已允许上传报告到内网站点。'],
 ['Do not edit config.','Now allow edit config.','The user allowed edit config.'],
])await test('release-replaces-same-action-'+a,()=>{
 const s=select(a,b);assert.deepEqual(s.active.map(m=>m.seq),[1]);
 assert.deepEqual(auditInstructionProvenance({userMessages:s.active,summaryText:c}),[]);
 assert.equal(auditCompaction({userMessages:s.active,summaryText:c,checkpointText:b}).lost.length,0);
});
for(const [a,b] of [
 ['不要修改生产配置。','现在允许修改测试配置了。'],
 ['如果测试失败，不要修改配置文件。','现在允许修改配置文件了。'],
 ['不要修改配置文件。','如果测试通过，现在允许修改配置文件。'],
 ['不要修改配置文件。','以下是历史引用：\n现在允许修改配置文件了。'],
])await test('release-keeps-different-condition-object-reference-'+b,()=>assert.equal(select(a,b).active[0].text,a));
for(const [a,b,c] of [
 ['请生成地图。','取消生成地图。','下一步绘制地图。'],
 ['制作图表。','取消制作图表。','准备生成图表。'],
 ['Generate map.','Cancel generate map.','Next draw map.'],
])await test('revoked-paraphrase-'+a,()=>{
 const s=select(a,b);assert.ok(retiredMemoryPresent(c,s));assert.equal(retiredMemoryPresent('不要生成地图。',s),undefined);
});
await test('fresh-authorization-clears-equivalent-revocation',()=>{
 const s=select('请生成地图。','取消生成地图。','请重新制作地图。');assert.equal(retiredMemoryPresent('下一步绘制地图。',s),undefined);assert.equal(s.active.at(-1).seq,2);
});
await test('revocation-scope-controls',()=>{
 const s=select('上传报告到站点A。','取消上传报告到站点A。');assert.equal(retiredMemoryPresent('下一步上传报告到站点B。',s),undefined);
 assert.equal(retiredMemoryPresent('历史记录：上传报告到站点A。',s),undefined);assert.equal(retiredMemoryPresent('不要上传报告到站点A。',s),undefined);
});
await test('retirement-identities-survive-five-checkpoints',()=>{
 const f=fixture(['请生成地图。','取消生成地图。']);let selected=selectSessionMemory(f,[0,1]);
 for(let generation=0;generation<5;generation++){
  const decisions=memoryDecisionsForSource(selected.decisions,f);assert.ok(decisions.some(d=>d.reason==='cancelled'&&d.sourceSha256&&d.bySha256));assert.ok(decisions.every(d=>d.text===undefined));
  const seq=f.events.length;f.events.push({seq,type:'user/message',data:{content:[{type:'text',text:'Safe notes.'}],source:{kind:'compact-checkpoint',memorySources:[],preserved:[],memoryDecisions:JSON.parse(JSON.stringify(decisions))}}});f.surface.nodes=[seq];
  selected=selectSessionMemory(f,[seq]);assert.ok(retiredMemoryPresent('下一步绘制地图。',selected));assert.ok(retiredMemoryPresent('请生成地图。',selected));
 }
 const seq=f.events.length;f.events.push({seq,type:'user/message',data:{content:[{type:'text',text:'请重新制作地图。'}],source:{kind:'user'}}});f.surface.nodes.push(seq);
 assert.equal(retiredMemoryPresent('下一步绘制地图。',selectSessionMemory(f,f.surface.nodes)),undefined);
});
await test('retirement-tampered-source-fails-closed',()=>{
 const f=fixture(['生成地图。','取消生成地图。']);const d=memoryDecisionsForSource(select('生成地图。','取消生成地图。').decisions,f);f.events[0].data.content[0].text='生成报告。';
 assert.throws(()=>restoreRetiredDecisions(d,f,2),error=>error.code==='MEMORY_SOURCE_UNAVAILABLE');
});
await test('forged-retirement-without-real-cancellation-fails-closed',()=>{
 const f=fixture(['生成地图。','继续']);const source=select('生成地图。','取消生成地图。').decisions;
 assert.throws(()=>restoreRetiredDecisions(source,f,2),error=>error.code==='MEMORY_SOURCE_UNAVAILABLE');
});
const json='[\n  {\n    "x": 1\n  },\n  {\n    "x": 1\n  }\n]';
await test('unfenced-json-keeps-exact-bytes-and-parses',()=>{assert.equal(deduplicateNotes(json),json);assert.deepEqual(JSON.parse(deduplicateNotes(json)),[{x:1},{x:1}]);});
const code='function f() {\n  if (true) {\n    return 1;\n  }\n}\nfunction g() {\n  if (true) {\n    return 1;\n  }\n}';
await test('unfenced-javascript-keeps-braces-and-behavior',()=>{assert.equal(deduplicateNotes(code),code);assert.equal(vm.runInNewContext(deduplicateNotes(code)+'\nf()+g()'),2);});
for(const [name,text] of [
 ['yaml','alpha:\n  value: one\nbeta:\n  value: one'],
 ['python','if x:\n    do_work()\nif y:\n    do_work()'],
 ['diff','@@ hunk\n+ return true;\n@@ hunk\n+ return true;'],
 ['lists','- Same item.\n- Same item.'],
 ['indented','    value\n    value'],
 ['fences','````js\nx\nx\n```\nx\nx\n````'],
])await test('structured-paragraph-preserved-'+name,()=>assert.equal(deduplicateNotes(text),text));
await test('independent-prose-still-deduplicates',()=>assert.equal(deduplicateNotes('Fact A.\nFact A.'),'Fact A.'));
for(const text of ['已生成地图。','已经制作地图。','之前生成地图。'])await test('completion-observation-cannot-reauthorize-'+text,()=>{
 const s=select('请生成地图。','取消生成地图。',text);
 assert.ok(retiredMemoryPresent('下一步绘制地图。',s));
 assert.ok(auditInstructionProvenance({userMessages:s.active,summaryText:'用户已允许生成地图。'}).length);
});
for(const token of ['configedit','dryrun','rerun','postdeploy'])await test('identifier-suffix-is-not-action-'+token,()=>{
 const s=select('Do not edit config.','Now allow '+token+'.');assert.equal(s.active[0].text,'Do not edit config.');
});
await test('standalone-cancellation-is-not-permission-support',()=>{
 const text='Cancel upload the detailed project architecture report to the internal documentation portal.';
 assert.ok(auditInstructionProvenance({userMessages:[msg(0,text)],summaryText:'The user allowed upload the detailed project architecture report to the internal documentation portal.'}).length);
});
for(const text of ['tick()\ntick()','(incf counter)\n(incf counter)','puts 1\nputs 1','```text\nalpha\n```javascript\nrepeat\nrepeat\n```','```md\n## A\n\n## B\n```'])await test('literal-extra-structure-keeps-bytes-'+text,()=>assert.equal(deduplicateNotes(text),text));
for(const text of ['生成地图。 生成地图。','生成地图。\n 生成地图。'])await test('whitespace-duplicate-retirement-restores-exact-occurrence-'+text,()=>{
 const f=fixture([text,'取消生成地图。']),s=select(text,'取消生成地图。');const decisions=memoryDecisionsForSource(s.decisions,f);
 const restored=restoreRetiredDecisions(decisions,f,2);assert.ok(restored.length);assert.ok(retiredMemoryPresent('下一步绘制地图。',{active:[],decisions:restored}));
});
function checkpoint(f,selected){
 const seq=f.events.length;f.events.push({seq,type:'user/message',data:{content:[{type:'text',text:'Safe notes.'}],source:{kind:'compact-checkpoint',memorySources:memorySourceRefs(selected.active,f),preserved:[],memoryDecisions:memoryDecisionsForSource(selected.decisions,f)}}});
 f.surface.nodes=[seq];return seq;
}
for(const split of [false,true])await test('bare-cancellation-replays-effective-global-targets-'+split,()=>{
 const f=fixture(split?['上传到站点A。','上传到站点B。','取消上传到站点B。','取消上传。']:['上传到站点A。上传到站点B。','取消上传到站点B。','取消上传。']);
 let selected=selectSessionMemory(f,f.surface.nodes);
 for(let n=0;n<4;n++){
  checkpoint(f,selected);selected=selectSessionMemory(f,f.surface.nodes);
  assert.equal(selected.active.length,0);assert.ok(selected.decisions.some(d=>d.reason==='cancelled'&&d.text==='上传到站点A。'));
 }
});
for(const blockSplit of [false,true])await test('projected-retirement-uses-original-offset-block-'+blockSplit,()=>{
 const f=fixture(['生成报告。生成地图。','取消生成报告。']);
 if(blockSplit)f.events[0].data.content=[{type:'text',text:'生成报告。'},{type:'text',text:'生成地图。'}];
 checkpoint(f,selectSessionMemory(f,f.surface.nodes));
 const seq=f.events.length;f.events.push({seq,type:'user/message',data:{content:[{type:'text',text:'取消生成地图。'}],source:{kind:'user'}}});f.surface.nodes.push(seq);
 let selected=selectSessionMemory(f,f.surface.nodes);const d=selected.decisions.find(d=>d.reason==='cancelled'&&d.by===seq);
 assert.deepEqual(d.sourcePart,blockSplit?{block:1,start:0,end:5}:{block:0,start:5,end:10});
 for(let n=0;n<3;n++){checkpoint(f,selected);selected=selectSessionMemory(f,f.surface.nodes);assert.equal(selected.active.length,0);}
});
await test('projected-scalar-supersession-keeps-original-coordinates',()=>{
 const f=fixture(['生成报告。重试次数必须为3次。','取消生成报告。']);checkpoint(f,selectSessionMemory(f,f.surface.nodes));
 const seq=f.events.length;f.events.push({seq,type:'user/message',data:{content:[{type:'text',text:'重试次数必须为5次。'}],source:{kind:'user'}}});f.surface.nodes.push(seq);
 let selected=selectSessionMemory(f,f.surface.nodes);assert.deepEqual(selected.decisions.find(d=>d.reason==='superseded').sourcePart,{block:0,start:5,end:15});
 checkpoint(f,selected);selected=selectSessionMemory(f,f.surface.nodes);assert.equal(selected.active[0].text,'重试次数必须为5次。');
});
await test('forged-local-decision-cannot-resolve-global-ambiguity',()=>{
 const f=fixture(['上传到站点A。','上传到站点B。','取消上传。']);
 assert.ok(!selectSessionMemory(f,f.surface.nodes).decisions.some(d=>d.reason==='cancelled'));
 const partial=selectMemoryMessages([msg(0,'上传到站点A。'),msg(2,'取消上传。')]);
 const claims=memoryDecisionsForSource(partial.decisions,f);
 assert.throws(()=>restoreRetiredDecisions(claims,f,3),e=>e.code==='MEMORY_SOURCE_UNAVAILABLE');
});
await test('later-task-does-not-retroactively-make-old-cancellation-ambiguous',()=>{
 const f=fixture(['上传到站点A。','取消上传。','上传到站点B。']);
 const selected=selectSessionMemory(f,f.surface.nodes),retired=memoryDecisionsForSource(selected.decisions,f);
 assert.equal(restoreRetiredDecisions(retired,f,3)[0].text,'上传到站点A。');
});
await test('later-adoption-cannot-retroactively-invalidate-earlier-cancellation',()=>{
 const f=fixture(['上传到站点A。','以下是历史引用：\n```text\n上传到站点B。\n```\n引用结束\n取消上传。']);
 checkpoint(f,selectSessionMemory(f,f.surface.nodes));
 const seq=f.events.length;f.events.push({seq,type:'user/message',data:{content:[{type:'text',text:'我采纳上一条引用作为当前要求。\n生成地图。取消生成地图。'}],source:{kind:'user'}}});f.surface.nodes.push(seq);
 let selected=selectSessionMemory(f,f.surface.nodes);checkpoint(f,selected);
 selected=selectSessionMemory(f,f.surface.nodes);
 assert.ok(selected.decisions.some(d=>d.reason==='cancelled'&&d.seq===0&&d.by===1));
 assert.ok(selected.decisions.some(d=>d.reason==='cancelled'&&d.seq===seq&&d.by===seq));
});
console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));if(results.some(r=>!r.pass))process.exitCode=1;
