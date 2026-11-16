import assert from 'node:assert/strict';
import {selectMemoryMessages,memoryDecisionsForSource,restoreRetiredDecisions} from '../lib/memory-policy.js';
import {instructionText} from '../lib/instruction-source.js';

const results=[];
const msg=(seq,text,sourceKind='user')=>({seq,text,sourceKind,blocks:[{type:'text',text}]});
const select=messages=>selectMemoryMessages(messages,{maxMessages:Infinity,maxTokens:Infinity});
const retired=selection=>selection.decisions.filter(d=>['cancelled','superseded'].includes(d.reason));
function test(name,run){try{run();results.push({name,pass:true});}catch(error){results.push({name,pass:false,error:error.message,stack:error.stack});}}

test('normalization-does-not-replace-exact-retired-wording',()=>{
  const first='Mode: Cafe\u0301',second='Mode: Café',third='Mode: Tea';
  const s=select([first,second,third].map((text,seq)=>msg(seq,text)));
  assert.deepEqual(s.active.map(m=>m.text),[third]);
  assert.deepEqual(retired(s).map(d=>({seq:d.seq,by:d.by,text:d.text,sourcePart:d.sourcePart})),[
    {seq:1,by:2,text:second,sourcePart:{block:0,start:0,end:second.length}},
  ]);
});

test('scope-and-identifier-parsing-preserves-exact-objects',()=>{
  const texts=['Retry limit for server1: 3','Retry limit for server2: 7','Retry limit for server1: 9',
    'production timeout: 30','staging timeout: 90','production timeout: 45',
    'Config: `Key` old','Config: `key` other','Config: `Key` new'];
  const s=select(texts.map((text,seq)=>msg(seq,text)));
  assert.deepEqual(s.active.map(m=>m.seq),[1,2,4,5,7,8]);
  assert.deepEqual(retired(s).map(d=>[d.seq,d.by,d.reason]),[[0,2,'superseded'],[3,5,'superseded'],[6,8,'superseded']]);
});

test('same-text-in-reference-and-live-message-keeps-separate-authority',()=>{
  const instruction='生成地图。',reference='以下是历史引用：\n```text\n生成地图。\n```';
  const originals=[msg(0,instruction),msg(1,reference),msg(2,'取消生成地图。')];
  const s=select(originals);
  assert.deepEqual(retired(s).map(d=>[d.seq,d.by]),[[0,2]]);
  assert.deepEqual(s.active.map(m=>m.seq),[1]);
  assert.ok(s.active[0].text.includes(instruction));assert.ok(!instructionText(s.active[0]).includes(instruction));
  const adopted=select([originals[1],msg(3,'我采纳上一条引用作为当前要求。')]);
  assert.ok(adopted.active.map(instructionText).join('\n').includes(instruction));
  assert.deepEqual(retired(select(originals)).map(d=>[d.seq,d.by]),[[0,2]]);
  assert.ok(!instructionText(originals[1]).includes(instruction));
});

test('fresh-calls-do-not-reuse-other-session-lifecycle-state',()=>{
  const texts=['生成地图。','取消生成地图。'];
  const original=select(texts.map((text,seq)=>msg(seq,text)));
  assert.equal(retired(original).length,1);
  const other=select([msg(0,texts[0]),msg(1,texts[1],'agent-message')]);
  assert.deepEqual(other.active.map(m=>m.seq),[0]);assert.equal(retired(other).length,0);
  assert.equal(retired(select(texts.map((text,seq)=>msg(seq,text)))).length,1);
});

test('many-distinct-texts-retain-later-cancellation-and-revision',()=>{
  const messages=[];
  for(let i=0;i<1100;i++){
    messages.push(msg(messages.length,`Generate map-item-${i}.`));
    messages.push(msg(messages.length,`Cancel generate map-item-${i}.`));
  }
  const first=messages.length;messages.push(msg(first,'Retry limit: 3'),msg(first+1,'Retry limit: 7'));
  const s=select(messages);
  assert.equal(retired(s).length,1101);assert.deepEqual(s.active.map(m=>m.text),['Retry limit: 7']);
  for(let i=0;i<1100;i++)assert.ok(s.decisions.some(d=>d.reason==='cancelled'&&d.seq===i*2&&d.by===i*2+1&&d.text===`Generate map-item-${i}.`));
  assert.ok(s.decisions.some(d=>d.reason==='superseded'&&d.seq===first&&d.by===first+1));
});

test('large-total-text-and-oversized-fragments-keep-exact-decisions',()=>{
  const messages=[];
  for(let i=0;i<110;i++){
    const target=`Generate object-${i}-`+'x'.repeat(2900)+'.';
    messages.push(msg(messages.length,target),msg(messages.length+1,'Cancel '+target));
  }
  const first=messages.length,old='Configuration: '+'a'.repeat(5000),next='Configuration: '+'b'.repeat(5000);
  messages.push(msg(first,old),msg(first+1,next));
  const s=select(messages);
  assert.equal(retired(s).length,111);assert.deepEqual(s.active.map(m=>m.text),[next]);
  const d=retired(s).at(-1);assert.equal(d.text,old);assert.equal(d.reason,'superseded');
  assert.deepEqual(d.sourcePart,{block:0,start:0,end:old.length});
});

test('retirement-rechecks-source-between-independent-restores',()=>{
  const messages=[msg(0,'生成地图。'),msg(1,'取消生成地图。')];
  const events=messages.map(m=>({seq:m.seq,type:'user/message',data:{content:m.blocks,source:{kind:'user'}}}));
  const session={eventAt:seq=>events[seq],deriveEventMessage:e=>e?.data};
  const decisions=memoryDecisionsForSource(select(messages).decisions,session);
  assert.equal(restoreRetiredDecisions(decisions,session,2)[0].text,'生成地图。');
  events[0].data.content=[{type:'text',text:'生成报告。'}];
  assert.throws(()=>restoreRetiredDecisions(decisions,session,2),e=>e.code==='MEMORY_SOURCE_UNAVAILABLE');
  events[0].data.content=[{type:'text',text:'生成地图。'}];
  assert.equal(restoreRetiredDecisions(decisions,session,2)[0].text,'生成地图。');
});

console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));
if(results.some(r=>!r.pass))process.exitCode=1;
