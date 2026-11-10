import assert from 'node:assert/strict';
import {selectMemoryMessages,memorySourceRefs,restoreMemorySource,removeConsumedCancellations,memoryRequirements} from '../lib/memory-policy.js';
import {auditCompaction} from '../lib/audit.js';
const results=[];
async function test(name,fn){try{await fn();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:e.message});}}
const msg=(seq,text,sourceKind='user')=>({seq,text,sourceKind,blocks:[{type:'text',text}]});
const select=(...texts)=>selectMemoryMessages(texts.map((text,seq)=>msg(seq,text)),{maxMessages:Infinity,maxTokens:Infinity});
await test('bare-chinese-parameter-is-audited',()=>{
 for(const [a,b] of [['测试环境超时55秒。','测试环境超时75秒。'],['备份上限25G。','备份上限30G。']]){
  assert.ok(memoryRequirements([msg(0,a)]).length);
  assert.ok(auditCompaction({userMessages:[msg(0,a)],summaryText:b,checkpointText:a}).lost.length);
 }
});
await test('same-scope-bare-parameter-replaced',()=>assert.deepEqual(select('测试环境超时55秒。','测试环境超时改为75秒。').active.map(m=>m.text),['测试环境超时改为75秒。']));
await test('different-environments-survive-successive-revisions',()=>{
 const s=select('生产环境超时55秒。','测试环境超时55秒。','测试环境超时改为75秒。','测试环境超时改为90秒；生产环境仍保持55秒。');
 assert.ok(s.active.some(m=>m.text.includes('生产环境')));assert.ok(s.active.some(m=>m.text.includes('90秒')));
 assert.ok(!s.active.some(m=>/测试环境超时(?:55|改为75)/.test(m.text)));
});
await test('continuation-with-change-retires-only-obsolete-value',()=>{
 const s=select('备份上限25G。','继续，但备份上限改为30G。');assert.equal(s.active.length,1);assert.match(s.active[0].text,/备份上限改为30G/);assert.doesNotMatch(s.active[0].text,/继续/);
});
await test('comma-cancellation-preserves-local-delivery',()=>{
 const s=select('报告完成后上传到测试站点。','取消上传到测试站点的任务，报告仅在本地交付。');
 assert.deepEqual(s.active.map(m=>m.text),['报告仅在本地交付。']);assert.ok(s.decisions.some(d=>d.reason==='cancelled'));
});
await test('cancel-one-compound-task-keeps-sibling',()=>{
 const s=select('请生成报告并上传到测试站点。','取消上传，保留生成本地报告。');
 assert.ok(s.active.some(m=>m.text.includes('请生成报告')));assert.ok(s.active.some(m=>m.text.includes('保留生成本地报告')));assert.ok(!s.active.some(m=>m.text.includes('上传')));
});
await test('partial-cancellation-restores-from-exact-original-layout',()=>{
 const original=[msg(0,'请生成报告并上传到测试站点。'),msg(1,'取消上传，保留生成本地报告。')];
 const s=selectMemoryMessages(original);const session={eventAt:seq=>({type:'user/message',data:{content:original[seq].blocks}}),deriveEventMessage:e=>e.data};
 for(const ref of memorySourceRefs(s.active,session))assert.equal(restoreMemorySource(original[ref.seq],ref).text,s.active.find(m=>m.seq===ref.seq).text);
});
await test('consumed-comma-cancellation-does-not-repeat-next-generation',()=>{
 const original=[msg(0,'报告完成后上传到测试站点。'),msg(1,'取消上传到测试站点的任务，报告仅在本地交付。')];const s=selectMemoryMessages(original);
 for(let i=0;i<3;i++)assert.deepEqual(removeConsumedCancellations([original[1]],s.decisions).map(m=>m.text),['报告仅在本地交付。']);
});
for(const [name,texts] of [
 ['conditional-values',['如果测试通过，超时55秒。','如果测试失败，超时改为75秒。']],
 ['numbered-objects',['服务器1超时55秒。','服务器2超时改为75秒。']],
 ['quoted-data',['示例：“测试环境超时55秒”。','测试环境超时改为75秒。']],
 ['code',['```\n测试环境超时55秒。\n```','测试环境超时改为75秒。']],
 ['different-parameters',['备份上限25G。','日志上限改为30G。']],
 ['different-bounds',['备份上限25G。','备份下限改为30G。']],
 ['negated-compound',['不要生成报告并上传到测试站点。','取消上传，保留生成本地报告。']],
 ['ambiguous-upload',['上传到测试站点。','上传到归档站点。','取消上传。']],
 ['conditional-cancellation',['上传到测试站点。','如果测试失败，取消上传。']],
 ['qualified-cancellation-condition',['上传到测试站点。','取消上传，但只在测试失败时。']],
 ['reference-cancellation',['请生成报告并上传到测试站点。','旧文档引用：取消上传。']],
 ['alternative-tasks',['生成报告或者上传到测试站点。','取消上传。']],
 ['shared-prerequisite',['只有生成报告后才能上传到测试站点。','取消生成报告。']],
 ['literal-comma',['上传到 `https://test.invalid/a,b`。','取消上传到测试站点。']]
])await test('conservative-'+name,()=>{const s=select(...texts);assert.equal(s.active[0].text,texts[0]);});
await test('plugin-injection-cannot-retire-user-scalar',()=>{const s=selectMemoryMessages([msg(0,'备份上限25G。'),msg(1,'备份上限改为30G。','plugin:x')]);assert.equal(s.active[0].text,'备份上限25G。');});
await test('reference-context-cannot-retire-user-scalar',()=>{const s=selectMemoryMessages([msg(0,'备份上限25G。'),msg(1,'备份上限改为30G。','runtime-context')]);assert.deepEqual(s.active.map(m=>m.text),['备份上限25G。']);});
await test('cancellation-alone-is-preserved',()=>assert.deepEqual(select('取消上传，保留生成本地报告。').active.map(m=>m.text),['取消上传，保留生成本地报告。']));
await test('same-parameter-different-units-remains-distinct-unless-explicitly-revised',()=>{const s=select('备份上限25G。','备份上限30天。');assert.equal(s.active.length,2);});

await test('cancel-previous-after-empty-continuation-does-not-cancel-older-rule',()=>{
 const s=select('不要删除已有文件。','继续','取消上一条。');assert.deepEqual(s.active.map(m=>m.text),['不要删除已有文件。']);
 assert.ok(s.decisions.some(d=>d.reason==='cancellation-applied'&&d.seq===2));
 const replay=removeConsumedCancellations([msg(0,'不要删除已有文件。'),msg(2,'取消上一条。')],s.decisions);
 assert.deepEqual(selectMemoryMessages(replay).active.map(m=>m.text),['不要删除已有文件。']);
});
await test('cancellation-after-unknown-nudge-keeps-real-user-addressing',()=>{
 const s=selectMemoryMessages([msg(0,'生成报告。'),msg(1,'继续','plugin:x'),msg(2,'取消上一条。')]);assert.equal(s.active.length,0);
});
await test('very-long-conjunction-prose-stays-atomic',()=>{const text='请生成报告'+('并有历史说明'.repeat(12000))+'。';assert.equal(select(text,'取消上传。').active[0].text,text);});
await test('unscoped-bare-timeout-is-audited',()=>assert.ok(auditCompaction({userMessages:[msg(0,'超时55秒。')],summaryText:'超时75秒。',checkpointText:'超时55秒。'}).lost.length));

await test('semicolon-separated-bare-parameters-are-both-audited',()=>{
 const text='测试环境超时改为90秒；生产环境仍保持55秒。';assert.match(memoryRequirements([msg(0,text)])[0].text,/90秒/);
 assert.ok(auditCompaction({userMessages:[msg(0,text)],summaryText:'测试环境超时75秒；生产环境超时55秒。',checkpointText:text}).lost.length);
});
console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));if(results.some(r=>!r.pass))process.exitCode=1;
