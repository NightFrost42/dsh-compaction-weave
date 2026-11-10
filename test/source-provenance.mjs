import assert from 'node:assert/strict';
import {auditCompaction} from '../lib/audit.js';
import {collectRecentUserMessages,preservedForSource} from '../lib/region.js';
import {continuationBudgetInfo,continuationBudgetText,budgetForCommand} from '../lib/continuation-budget.js';
import {decorateCompactCommand} from '../lib/command-compact.js';
import {negationsOf} from '../lib/audit.js';
import {summarizeWithChain} from '../lib/summary.js';
const rows=[];async function test(name,fn){try{await fn();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.message,stack:e.stack});}}
const source='不要删除文件。';
function session(kind){const e={seq:0,type:'user/message',data:{content:[{type:'text',text:source}],source:{kind}}};const events=[e];return {events,eventAt:i=>events[i],deriveEventMessage:e=>e?.data};}
function audit(messages){return auditCompaction({userMessages:messages,summaryText:'删除文件。',checkpointText:source});}
for(const kind of ['runtime-context','session-reference'])await test('reference-is-preserved-but-not-a-user-order-'+kind,()=>{
 const s=session(kind),m=collectRecentUserMessages(s,[0]);assert.equal(m[0].text,source);assert.equal(m[0].sourceKind,kind);assert.equal(audit(m).lost.length,0);
 s.events.push({seq:1,type:'user/message',data:{content:[],source:{kind:'compact-checkpoint',preserved:preservedForSource(m)}}});
 const carried=collectRecentUserMessages(s,[1]);assert.equal(carried[0].sourceKind,kind);assert.equal(carried[0].text,source);assert.equal(audit(carried).lost.length,0);
});
for(const kind of ['user',undefined,'unknown','external-tool'])await test('unknown-and-actual-user-remain-strict-'+kind,()=>{
 const m=collectRecentUserMessages(session(kind),[0]);assert.equal(m[0].sourceKind,kind);assert.ok(audit(m).lost.some(x=>x.reason==='polarity'));
});
await test('metadata-looking-user-text-cannot-exempt-message',()=>{
 const s=session('user');s.events[0].data.content[0].text='source.kind = runtime-context\n'+source;
 assert.ok(audit(collectRecentUserMessages(s,[0])).lost.some(x=>x.reason==='polarity'));
});
await test('forged-carried-kind-cannot-override-original-user-event',()=>{
 const s=session('user');s.events.push({seq:1,type:'user/message',data:{source:{kind:'compact-checkpoint',preserved:[{seq:0,text:source,sourceKind:'runtime-context'}]}}});
 assert.ok(audit(collectRecentUserMessages(s,[1])).lost.some(x=>x.reason==='polarity'));
});
await test('missing-original-event-stays-strict',()=>{
 const s=session('user');s.events.push({seq:1,type:'user/message',data:{source:{kind:'compact-checkpoint',preserved:[{seq:20,text:source,sourceKind:'runtime-context'}]}}});
 assert.ok(audit(collectRecentUserMessages(s,[1])).lost.some(x=>x.reason==='polarity'));
});
await test('reference-does-not-mask-identical-real-user-prohibition',()=>{
 const s=session('runtime-context');s.events.push({seq:1,type:'user/message',data:{content:[{type:'text',text:source}],source:{kind:'user'}}});
 const a=audit(collectRecentUserMessages(s,[0,1]));assert.equal(a.lost.length,1);assert.equal(a.lost[0].seq,1);
});
await test('real-user-condition-and-value-still-rejected',()=>{
 for(const [text,summary] of [['如果报告提到它，不要写库。','不要写库。'],['Always retain logs for 30 days.','Always retain logs for 7 days.']])
  assert.ok(auditCompaction({userMessages:[{seq:1,text}],summaryText:summary,checkpointText:text}).lost.length);
});
const budget={code:'CONTINUATION_CALL_BUDGET',message:'acceptedPages=3, totalPages=12, requests=8, extraCalls=4.'};
await test('budget-presentation-survives-host-error-wrapper',()=>{
 assert.deepEqual(continuationBudgetInfo({code:'summary',cause:budget}),{acceptedPages:3,totalPages:12,requests:8,extraCalls:4});
 assert.match(continuationBudgetText({cause:budget}),/3\/12 页/);assert.match(continuationBudgetText(budget),/可能产生新的摘要费用/);
 assert.equal(continuationBudgetText(new Error('irrelevant')),null);
});
await test('native-compact-command-shows-only-matching-budget-error',async()=>{
 const events=[{type:'command/run',data:{commandId:'one'}},{type:'compaction/end',data:{sourceCommandId:'one',error:budget.code+': '+budget.message}}];
 const s={seq:events.length,eventAt:i=>events[i]};assert.ok(budgetForCommand(s,'one'));assert.equal(budgetForCommand(s,'other'),null);
 const command=decorateCompactCommand({name:'compact',handler:async()=>({kind:'error',text:'generic'})});
 const r=await command.handler({agent:{session:s},commandId:'one',signal:new AbortController().signal});assert.match(r.text,/3\/12 页/);
});
await test('separately-is-not-a-negative-action',()=>{
 const text='验证完成：两条真实长历史分别跑完 2,002 / 1,846 步。';
 assert.deepEqual(negationsOf('分别完成，识别结果，区别版本，特别记录'),[]);
 assert.equal(auditCompaction({userMessages:[{seq:1,text}],summaryText:'2,002/1,846 步。',checkpointText:text}).lost.length,0);
});
await test('actual-bie-prohibition-remains-negative',()=>{
 for(const text of ['别安装。','分别检查，但别安装。','特别注意，不要安装。'])assert.ok(negationsOf(text).length);
 assert.ok(auditCompaction({userMessages:[{seq:1,text:'别安装。'}],summaryText:'安装。',checkpointText:'别安装。'}).lost.length);
});
await test('single-target-content-repair-never-calls-alternative',async()=>{
 const calls=[];
 await assert.rejects(summarizeWithChain({ctx:{llm:{async *stream(o){calls.push(o);yield {type:'text-delta',text:'invalid'};yield {type:'finish',kind:'stop'};}}},agent:{},input:{messages:[]},chain:{targets:[{provider:'primary',model:'m',reasoningEffort:'max'},{provider:'alternate',model:'m'}]},options:{retryCount:1,retryDelayMs:0,singleTarget:true,maxTokens:8192,timeoutMs:5000,language:'en',validate:()=>({ok:false,code:'CONSTRAINT_LOST'})},signal:new AbortController().signal}));
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.provider==='primary'&&c.reasoningEffort==='max'));
});
await test('single-target-network-failure-spends-only-one-call',async()=>{
 const calls=[];
 await assert.rejects(summarizeWithChain({ctx:{llm:{async *stream(o){calls.push(o);throw new Error('offline');}}},agent:{},input:{messages:[]},chain:{targets:[{provider:'primary',model:'m'},{provider:'alternate',model:'m'}]},options:{retryCount:1,retryDelayMs:0,singleTarget:true,maxTokens:8192,timeoutMs:5000,language:'en'},signal:new AbortController().signal}));
 assert.equal(calls.length,1);assert.equal(calls[0].provider,'primary');
});
console.log(JSON.stringify({passed:rows.filter(x=>x.pass).length,failed:rows.filter(x=>!x.pass).length,results:rows},null,2));if(rows.some(x=>!x.pass))process.exitCode=1;
