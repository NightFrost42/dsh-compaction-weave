import {collectWorkReport,renderWorkReport} from '../lib/work-report.js';
import {approxTokens} from '../lib/meter.js';
import assert from 'node:assert/strict';
import {selectMemoryMessages,memorySourceRefs,restoreMemorySource,isEmptyContinuation} from '../lib/memory-policy.js';
import {sourceLayout,restoreSourceLayout} from '../lib/source-refs.js';
import {collectInstructionMessages,selectSessionMemory} from '../lib/region.js';
import {selectCachePreservingRange} from '../lib/cache-policy.js';
import {resolveConfig} from '../lib/config.js';
const results=[];async function test(name,fn){try{await fn();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:e.message,stack:e.stack});}}
const m=(seq,text)=>({seq,text,blocks:[{type:'text',text}]});
function fixture(){
 const events=[],surface={nodes:[],replaceGeneration:0};
 const session={id:'source-cache',surface,get seq(){return events.length;},eventAt:seq=>events[seq],snapshotEvents:()=>events,deriveEventMessage:e=>e?.data?.message??e?.data};
 const add=(role,text,source={kind:role==='user'?'user':'model'},visible=true)=>{const seq=events.length;events.push({seq,type:role+'/message',data:{role,content:[{type:'text',text}],source}});if(visible)surface.nodes.push(seq);return seq;};
 add('system','stable-system');
 return {session,events,surface,add};
}
for(const text of ['继续','继续。','请继续','继续执行','继续吧！','continue','Please continue.','go on'])await test('drop-empty-'+text,()=>{assert.ok(isEmptyContinuation(text));assert.equal(selectMemoryMessages([m(1,text)]).active.length,0);});
for(const text of ['继续，但不要删除原始文件。','继续使用25G。','继续核对未完成的三项要求。','不要继续。','同意','可以执行','取消上一条','输出文字“继续”','`continue`','```js\ncontinue;\n```','保留原文。\n继续'])await test('keep-meaningful-'+text.slice(0,20),()=>{assert.ok(!isEmptyContinuation(text));assert.equal(selectMemoryMessages([m(1,text)]).active.length,1);});
await test('v2-roundtrip-after-deletion-keeps-condition-and-code',()=>{
 const f=fixture(),seq=f.add('user','Timeout must be 35 seconds. Keep records.\n```js\nconst x=1;\n```');
 const original=m(seq,f.events[seq].data.content[0].text),selected=m(seq,'Keep records.\n```js\nconst x=1;\n```');
 const ref=memorySourceRefs([selected],f.session)[0];assert.equal(ref.layout.version,2);assert.equal(restoreMemorySource(original,ref).text,selected.text);
});
await test('v2-references-do-not-depend-on-future-sentence-splitting',()=>{const x=m(1,'Do not delete records. Keep backups.');const layout=sourceLayout(x,x);assert.equal(restoreSourceLayout(x,layout).text,x.text);assert.equal(restoreMemorySource(x,{layout,fragments:['legacy-parser-no-longer-used']}).text,x.text);});
await test('v2-rejects-changed-source',()=>{const x=m(1,'Do not delete records.');assert.throws(()=>restoreSourceLayout(m(1,'Delete records.'),sourceLayout(x,x)),e=>e.code==='MEMORY_SOURCE_UNAVAILABLE');});
await test('v2-rejects-invented-content',()=>assert.throws(()=>sourceLayout(m(1,'You may delete production.'),m(1,'Do not delete production.'))));
await test('v2-rejects-reordered-projection',()=>assert.throws(()=>sourceLayout(m(1,'Second. First.'),m(1,'First. Second.'))));
await test('v2-rejects-instruction-in-whitespace-field',()=>{const x=m(1,'Keep records.'),layout=sourceLayout(x,x);layout.blocks[0].parts.unshift({space:'Delete records.'});assert.throws(()=>restoreSourceLayout(x,layout));});
function legacy(){
 const f=fixture(),raw='Original objective.\nDo not delete records.\nExtra background.\n```js\nkeep();\n```',projection='Do not delete records.\n```js\nkeep();\n```';
 const seq=f.add('user',raw,{kind:'user'},false),part=m(seq,projection),ref=memorySourceRefs([part])[0];
 const cp=f.add('user','Prior notes',{kind:'compact-checkpoint',preserved:[part],memorySources:[ref]});
 return {...f,seq,cp,raw,projection};
}
await test('legacy-projected-hash-restores-from-verified-original',()=>{const f=legacy();const before=JSON.stringify(f.events);const found=collectInstructionMessages(f.session,f.surface.nodes);assert.equal(found[0].text,f.projection);assert.equal(JSON.stringify(f.events),before);});
await test('legacy-blocks-only-source-normalizes-text',()=>{const f=legacy();delete f.events[f.cp].data.source.preserved[0].text;assert.equal(collectInstructionMessages(f.session,f.surface.nodes)[0].text,f.projection);});
await test('legacy-projection-upgrades-and-survives-ten-generations',()=>{
 const f=legacy();for(let i=0;i<10;i++){
  const active=selectSessionMemory(f.session,f.surface.nodes).active;
  assert.equal(active[0].text,f.projection);
  const memorySources=memorySourceRefs(active,f.session);assert.equal(memorySources[0].layout.version,2);
  const cp=f.add('user','Working notes',{kind:'compact-checkpoint',memorySources,preserved:[]});f.surface.nodes=[0,cp];
 }
});
await test('legacy-unknown-hash-never-gets-dropped-silently',()=>{const f=legacy();f.events[f.cp].data.source.memorySources[0].fragments=['0'.repeat(64)];assert.throws(()=>collectInstructionMessages(f.session,f.surface.nodes),e=>e.code==='MEMORY_SOURCE_UNAVAILABLE');});
await test('legacy-hash-with-fabricated-requirement-is-rejected',()=>{const f=legacy(),fake=m(f.seq,'Delete records.\n```js\nkeep();\n```');f.events[f.cp].data.source.preserved=[fake];f.events[f.cp].data.source.memorySources=memorySourceRefs([fake]);assert.throws(()=>collectInstructionMessages(f.session,f.surface.nodes));});
await test('evicted-legacy-projection-can-use-authoritative-ancestor',()=>{const f=legacy(),ref=f.events[f.cp].data.source.memorySources[0];const newer=f.add('user','Later notes',{kind:'compact-checkpoint',memorySources:[ref],preserved:[]});f.surface.nodes=[0,newer];assert.equal(collectInstructionMessages(f.session,f.surface.nodes)[0].text,f.projection);});
await test('filtered-nudges-never-change-adjacent-cancellation-target',()=>{const s=selectMemoryMessages([m(1,'生成地图。'),m(2,'继续'),m(3,'取消上一条')]);assert.deepEqual(s.active.map(m=>m.text),['生成地图。']);});
function cached(){
 const f=fixture(),seq=f.add('user','Do not delete records.',{kind:'user'},false);
 const cp=f.add('user','Stable notes and requirement: Do not delete records.',{kind:'compact-checkpoint',memorySources:memorySourceRefs([m(seq,'Do not delete records.')],f.session),preserved:[]});
 const a=f.add('assistant','old verified work '.repeat(3000)),b=f.add('assistant','more old work '.repeat(3000)),last=f.add('user','Recent task details.');
 const cost=new Map([[0,100],[cp,4000],[a,30000],[b,30000],[last,5000]]);
 const measure=()=>({nodes:f.surface.nodes.map(seq=>({seq,tokens:cost.get(seq)??5000})),totalTokens:f.surface.nodes.reduce((n,s)=>n+(cost.get(s)??5000),0)});
 return {...f,cp,a,b,last,cost,measure,policy:resolveConfig({maxTokens:8192,preserveRecentUserTokens:4096}).config};
}
await test('cache-preserves-checkpoint-prefix-and-recent-tail',()=>{const f=cached(),before=JSON.stringify(f.events);assert.deepEqual(selectCachePreservingRange(f.session,f.measure(),5000,f.policy,45000),{start:f.a,end:f.b});assert.equal(JSON.stringify(f.events),before);});
await test('cache-keeps-longest-safe-prefix',()=>{const f=cached();assert.deepEqual(selectCachePreservingRange(f.session,f.measure(),5000,f.policy),{start:f.b,end:f.b});});
await test('cache-falls-back-when-saving-insufficient',()=>{const f=cached();assert.equal(selectCachePreservingRange(f.session,f.measure(),5000,f.policy,1000),null);});
await test('cache-falls-back-on-explicit-revision',()=>{const f=cached();f.add('user','Delete records.');assert.equal(selectCachePreservingRange(f.session,f.measure(),5000,f.policy),null);});
await test('cache-falls-back-on-cancellation',()=>{const f=cached();f.add('user','Cancel Do not delete records.');assert.equal(selectCachePreservingRange(f.session,f.measure(),5000,f.policy),null);});
await test('cache-respects-checkpoint-count-limit',()=>{const f=cached();assert.equal(selectCachePreservingRange(f.session,f.measure(),5000,{...f.policy,cacheMaxCheckpoints:1}),null);});
await test('cache-can-be-disabled',()=>{const f=cached();assert.equal(selectCachePreservingRange(f.session,f.measure(),5000,{...f.policy,cachePreservePrefix:false}),null);});
await test('cache-leaves-pressure-capacity-policy-unchanged',()=>{const c=resolveConfig({thresholdRatio:.8,minimumReductionRatio:.3}).config;assert.equal(c.thresholdRatio,.8);assert.equal(c.minimumReductionRatio,.3);assert.equal(c.auditBlockOnLoss,true);assert.equal(c.preserveRecentUserTokens,4096);});
await test('legacy-local-projection-does-not-rescan-unrelated-history',()=>{
 const f=legacy(),eventAt=f.session.eventAt;let unrelated=0;f.session.eventAt=seq=>{if(seq!==0&&seq!==f.seq&&seq!==f.cp)unrelated++;return eventAt(seq);};
 assert.equal(collectInstructionMessages(f.session,f.surface.nodes)[0].text,f.projection);assert.equal(unrelated,0);
});
await test('cache-candidate-reserves-continuation-requirements-before-spending',()=>{
 const f=cached();f.cost.set(f.a,13000);f.cost.set(f.b,13000);const policy={...f.policy,maxTokens:128,preserveRecentUserTokens:128};
 assert.deepEqual(selectCachePreservingRange(f.session,f.measure(),5000,policy,undefined,{continuation:true}),{start:f.a,end:f.b});
});
await test('cache-choice-is-the-latest-legal-start-across-160-budget-shapes',()=>{
 for(let trial=0;trial<160;trial++){
  const f=cached();f.surface.nodes=f.surface.nodes.slice(0,2);const work=[];
  for(let i=0;i<4+trial%11;i++){const seq=f.add('assistant','Verified work.');f.cost.set(seq,1200+((trial*97+i*541)%9000));work.push(seq);}
  const tail=f.add('user','Latest request.');f.cost.set(tail,5000);
  const measured=f.measure(),target=Math.floor(measured.totalTokens*(.4+(trial%4)*.1)),required=Math.max(f.policy.cacheMinSavingsTokens,measured.totalTokens-target),overhead=f.policy.maxTokens+f.policy.preserveRecentUserTokens+approxTokens(renderWorkReport(collectWorkReport(f.session,work)));
  let best=null,sum=0;for(let i=work.length-1;i>=0;i--){sum+=f.cost.get(work[i]);if(sum-overhead>=required){best={start:work[i],end:work.at(-1)};break;}}
  assert.deepEqual(selectCachePreservingRange(f.session,measured,5000,f.policy,target),best,'trial '+trial);
 }
});
await test('long-unbroken-source-is-kept-without-quadratic-identifier-scan',()=>{
 const raw='u'.repeat(250000),r=selectMemoryMessages([m(1,raw),m(2,'Do not delete records.')]);assert.equal(r.active[0].text,raw);assert.equal(r.active[1].text,'Do not delete records.');
});
await test('digit-identifiers-keep-distinct-scopes-after-scan-optimization',()=>{
 for(const [a,b] of [['server1','server2'],['node-v1','node-v2'],['config.v1','config.v2'],['C:/v1/settings','C:/v2/settings']]){
  const r=selectMemoryMessages([m(1,`Must use ${a}: 20.`),m(2,`Must use ${b}: 25.`)]);assert.equal(r.active.length,2);
 }
});
await test('partial-span-cannot-resolve-an-ambiguous-global-cancellation',()=>{const f=fixture();const a=f.add('user','上传到测试站点A。'),b=f.add('user','上传到测试站点B。'),cancel=f.add('user','取消上传。');const whole=selectSessionMemory(f.session,f.surface.nodes);assert.deepEqual(whole.active.map(m=>m.seq),[a,b,cancel]);const local=selectSessionMemory(f.session,[b,cancel],{maxMessages:1,maxTokens:4096});assert.deepEqual(local.active.map(m=>m.seq),[b,cancel]);assert.deepEqual(local.preserved.map(m=>m.seq),[cancel]);assert.ok(local.retained.some(m=>m.seq===a));assert.ok(!local.decisions.some(d=>d.reason==='cancelled'));});
console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));if(results.some(r=>!r.pass))process.exitCode=1;
