import assert from 'node:assert/strict';
import {measureSummaryRange,planSummaryRange} from '../lib/summary-budget.js';
const results=[];
async function test(name,fn){try{await fn();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:e.stack});}}
const text=t=>[{type:'text',text:t}];
const user=(kind,body)=>({type:'user/message',data:{role:'user',source:{kind},content:text(body)}});
function fixture(extra){const events=[{type:'system/message',data:{message:{role:'system',content:text('stable system')}}},...extra].map((e,seq)=>({...e,seq}));return {surface:{nodes:events.map(e=>e.seq)},eventAt:n=>events[n],deriveEventMessage:e=>e?.data.message??e?.data,requestHeader:()=>({})};}
function measure(s,pricedInput){return measureSummaryRange(s,{start:1,end:s.surface.nodes.at(-1)},{language:'en',pricedInput});}
await test('unchanged-input-keeps-host-priced-nontext-and-request-overhead',()=>{
 const s=fixture([user('user','hello'),{type:'assistant/message',data:{message:{role:'assistant',content:text('x'.repeat(1000))}}}]);
 const seen=[];const r=measure(s,seqs=>{seen.push(seqs);return 155000;});
 assert.deepEqual(seen,[[1,2]]);assert.equal(r.inputUnits,155000+r.requestUnits-r.sourceBytes);assert.ok(r.inputUnits>155000);
});
await test('external-reference-body-does-not-reintroduce-its-old-price',()=>{
 const s=fixture([user('runtime-context','external '.repeat(100000))]);
 const r=measure(s,()=>{throw new Error('projected content must not use its old price');});
 assert.equal(r.inputUnits,r.requestUnits);assert.ok(r.inputUnits<12000);assert.ok(r.sourceBytes>800000);
});
await test('retained-image-keeps-price-alongside-omitted-reference',()=>{
 const image={role:'user',source:{kind:'user'},content:[...text('Inspect image.'),{type:'image',url:'https://example.invalid/large.png'}]};
 const s=fixture([user('runtime-context','external '.repeat(100000)),{type:'user/message',data:image}]);
 const r=measure(s,seqs=>{assert.deepEqual(seqs,[2]);return 155000;});
 const imageBytes=Buffer.byteLength(JSON.stringify([{role:image.role,content:image.content}]));
 assert.equal(r.inputUnits,155000+r.requestUnits-imageBytes);assert.ok(r.inputUnits>155000);
 const capacity={targets:[{inputRatio:1,window:120000,output:0,margin:0,maxInputBytes:120000,scale:1}],shrinkLimit:Infinity};
 const plan=planSummaryRange(s,{start:1,end:2},capacity,{pricedInput:seqs=>seqs.includes(2)?155000:0});
 assert.equal(plan.end,1,'expensive image must not fit because its URL is short');
});
await test('successful-skill-body-is-projected-but-failed-read-remains-priced',()=>{
 for(const isError of [false,true]){
  const s=fixture([{type:'tool/call',data:{callId:'read1',name:'skill',arguments:{name:'release-check'}}},{type:'tool/result',sourceEventSeqs:[1],data:{message:{role:'tool',toolCallId:'read1',content:text('skill instructions '.repeat(10000)),isError}}}]);
  s.surface.nodes=[0,2];let calls=0;
  const r=measureSummaryRange(s,{start:2,end:2},{language:'en',pricedInput:seqs=>{calls++;assert.deepEqual(seqs,[2]);return 500000;}});
  assert.equal(calls,isError?1:0);assert.equal(r.inputUnits>500000,isError);
 }
});
console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));if(results.some(r=>!r.pass))process.exitCode=1;
