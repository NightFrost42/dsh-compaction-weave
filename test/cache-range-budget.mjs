import assert from 'node:assert/strict';
import {selectCachePreservingRange} from '../lib/cache-policy.js';
import {selectCompactableRange,toolPairingBalancedBefore,selectSessionMemory,collectInstructionMessages} from '../lib/region.js';
import {collectWorkReport,renderWorkReport} from '../lib/work-report.js';
import {residentConstraints,planContinuationMemory} from '../lib/continuation.js';
import {memorySourceRefs} from '../lib/memory-policy.js';
import {resolveConfig} from '../lib/config.js';
import {approxTokens} from '../lib/meter.js';
const results=[];async function test(name,fn){try{await fn();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:e.stack});}}
function fixture({nudge=false}={}){
 const events=[],surface={nodes:[],replaceGeneration:0},cost=new Map();
 const session={id:'cache-range-budget',surface,get seq(){return events.length},eventAt:seq=>events[seq],snapshotEvents:()=>events,deriveEventMessage:e=>e?.data?.message??e?.data};
 const add=(role,text,tokens=100,{visible=true,source={kind:role==='user'?'user':'model'},content}={})=>{const seq=events.length,message={role,content:content??[{type:'text',text}],source};events.push({seq,type:role+'/message',data:role==='assistant'?{message}:message});cost.set(seq,tokens);if(visible)surface.nodes.push(seq);return seq;};
 add('system','Stable system.',100);
 const original=add('user','Do not delete records.',20,{visible:false});
 if(nudge)add('user','继续',1,{visible:false});
 const originalMessage={seq:original,text:'Do not delete records.',blocks:[{type:'text',text:'Do not delete records.'}]};
 const cp=add('user','Stable checkpoint; Do not delete records.',1000,{source:{kind:'compact-checkpoint',memorySources:memorySourceRefs([originalMessage],session),preserved:[]}});
 const measure=()=>({nodes:surface.nodes.map(seq=>({seq,tokens:cost.get(seq)})),totalTokens:surface.nodes.reduce((sum,seq)=>sum+cost.get(seq),0)});
 const policy=resolveConfig({maxTokens:128,preserveRecentUserTokens:128,cacheMinSavingsTokens:4096}).config;
 const choose=(options={})=>{const m=measure();return selectCachePreservingRange(session,m,5000,policy,m.totalTokens-4096,options)};
 return {events,surface,cost,session,add,cp,original,measure,policy,choose};
}
await test('report-outside-selected-suffix-does-not-spend-its-budget',()=>{const f=fixture();f.add('assistant','已完成检查。'+'说明'.repeat(350),2200);const b=f.add('assistant','Diagnostic details.',4400);f.add('user','Current request.',5000);assert.deepEqual(f.choose(),{start:b,end:b});});
await test('small-report-cannot-prevent-a-profitable-report-free-suffix',()=>{const f=fixture();f.add('assistant','已完成检查。',10);const b=f.add('assistant','Diagnostic details.',4360);f.add('user','Current request.',5000);assert.deepEqual(f.choose(),{start:b,end:b});});
await test('archived-nudge-is-still-the-relative-cancellation-target',()=>{const f=fixture({nudge:true});const a=f.add('assistant','Detailed evidence.',20000);f.add('user','取消上一条',5000);assert.deepEqual(f.choose(),{start:a,end:a});assert.ok(selectSessionMemory(f.session,f.surface.nodes).active.some(m=>m.seq===f.original));});
await test('real-relative-cancellation-still-forces-checkpoint-merge',()=>{const f=fixture();f.add('assistant','Detailed evidence.',20000);f.add('user','取消上一条',5000);assert.equal(f.choose(),null);});
await test('continuation-only-reserves-requirements-in-its-actual-span',()=>{const f=fixture();f.add('user','Do not delete these records: '+ 'x'.repeat(180000)+'.',45000);const b=f.add('assistant','Detailed evidence.',20000);f.add('user','Current request.',5000);assert.deepEqual(f.choose({continuation:true}),{start:b,end:b});});
await test('continuation-included-requirements-still-block-oversized-checkpoint',()=>{const f=fixture();f.add('assistant','Detailed evidence.',20000);f.add('user','Do not delete these records: '+'x'.repeat(180000)+'.',45000);f.add('user','Current request.',5000);assert.equal(f.choose({continuation:true}),null);});
// Independent exhaustive choice: derive each legal span and price only its own
// report/requirements, never copy the selector's running-budget logic.
await test('longest-safe-prefix-matches-exhaustive-oracle-with-changing-overheads',()=>{
 for(let trial=0;trial<180;trial++){
  const f=fixture(),continuation=trial%2===1,work=[];
  for(let i=0;i<3+trial%9;i++){
   const kind=(trial*11+i*7)%5;
   const text=kind===0?'已完成本地检查，尚未验证远端。'+ '说明'.repeat((trial*29+i*7)%300):kind===1?'Do not delete file-'+i+'.txt.':kind===2?'已完成检查。'+'x'.repeat(4000):'Diagnostic details.';
   work.push(f.add(kind===1?'user':'assistant',text,2000+(trial*71+i*257)%7000));
  }
  f.add('user','Current request.',5000);
  const measured=f.measure(),target=measured.totalTokens-4096,base=selectCompactableRange(f.session,measured,5000),end=f.surface.nodes.indexOf(base.end);
  let expected=null;
  for(let index=end;index>f.surface.nodes.indexOf(f.cp);index--){
   if(!toolPairingBalancedBefore(f.session,f.surface.nodes[index]))continue;
   const seqs=f.surface.nodes.slice(index,end+1),report=collectWorkReport(f.session,seqs);
   let budget=f.policy.maxTokens+f.policy.preserveRecentUserTokens+(report?approxTokens(renderWorkReport(report)):0);
   if(continuation){try{budget=Math.max(budget,planContinuationMemory(residentConstraints(selectSessionMemory(f.session,seqs).active,f.session),f.policy,{workReport:report}).reservedTokens)}catch(e){if(e.code==='CONTINUATION_REQUIREMENTS_TOO_LARGE')continue;throw e;}}
   if(seqs.reduce((n,seq)=>n+f.cost.get(seq),0)-budget<4096)continue;
   const prefix=new Set(collectInstructionMessages(f.session,f.surface.nodes.slice(0,index)).map(m=>m.seq));
   if(selectSessionMemory(f.session,f.surface.nodes).decisions.some(d=>['cancelled','superseded'].includes(d.reason)&&prefix.has(d.seq)))continue;
   expected={start:f.surface.nodes[index],end:base.end};break;
  }
  assert.deepEqual(selectCachePreservingRange(f.session,measured,5000,f.policy,target,{continuation}),expected,'trial '+trial);
 }
});
await test('revision-after-checkpoint-only-expands-to-the-revised-message',()=>{const f=fixture();const a=f.add('user','测试环境超时55秒。',1000);const b=f.add('assistant','Detailed evidence.',20000);f.add('user','测试环境超时75秒。',5000);assert.deepEqual(f.choose(),{start:a,end:b});});
await test('legal-suffix-never-splits-tool-call-from-result',()=>{const f=fixture();f.add('assistant','已完成检查。',30);const call=f.add('assistant','',500,{content:[{type:'tool-call',id:'tool-1',name:'read',arguments:{}}]});const result=f.events.length;f.events.push({seq:result,type:'tool/result',data:{role:'tool',content:[{type:'text',text:'Detailed evidence.'}]}});f.surface.nodes.push(result);f.cost.set(result,5000);f.add('user','Current request.',5000);assert.deepEqual(f.choose(),{start:call,end:result});});
await test('budget-checks-do-not-repeatedly-rescan-thousands-of-reports',()=>{const counts=[];for(const size of [1000,2000]){const f=fixture();for(let i=0;i<size;i++)f.add('assistant',i%11===0?'已完成检查。':'Diagnostic evidence.',1);f.add('user','Current request.',5000);let reads=0;const original=f.session.eventAt;f.session.eventAt=seq=>{reads++;return original(seq)};assert.equal(f.choose({continuation:true}),null);assert.ok(reads<30*size,'event reads '+reads);counts.push(reads);}assert.ok(counts[1]<counts[0]*2.2);});
await test('cache-selection-is-read-only-even-when-it-expands-for-revision',()=>{const f=fixture();f.add('user','测试环境超时55秒。',1000);f.add('assistant','Detailed evidence.',20000);f.add('user','测试环境超时75秒。',5000);const before=structuredClone({events:f.events,surface:f.surface});f.choose();assert.deepEqual({events:f.events,surface:f.surface},before);});
console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));if(results.some(r=>!r.pass))process.exitCode=1;
