import assert from 'node:assert/strict';
import {extractProgressFacts,validateProgressFacts} from '../lib/progress-facts.js';
const results=[];
const test=(name,fn)=>{try{fn();results.push({name,pass:true});}catch(e){results.push({name,pass:false,error:e.stack});}};
const selection={effective:extractProgressFacts('最新进度：本批135个文件已完成扫描和格式检查。报告已生成，图表尚未生成。下一步生成图表。',{seq:130})};
const valid=[
 '- 此前多次针对“返回 JSON 对象”请求的答复（如 seq 109/111/113/115/117/119）使用了旧进度（checkedFileCount=128、reportGenerated=false），与 seq 130 的当前状态不符；这些是历史答复，不是当前进度。',
 '- 历史 JSON 回复（seq109/111/113/115/117/119）中的 128 与 reportGenerated=false 为过期进度，与 seq130 不一致；应以 seq130 为准。',
 '- seq101 曾报告 128 个文件完成扫描、报告未生成；seq109/111/113/115/117/119 的状态对象中 checkedFileCount=128、reportGenerated=false。上述均为过期进度，已由 seq130 取代，不应作为当前状态。',
];
for(let n=0;n<valid.length;n++)test('saved-old-reply-attribution-'+n,()=>assert.equal(validateProgressFacts(valid[n],selection).ok,true));
const invalid=[
 '历史 JSON 回复中的 reportGenerated=false，但当前报告未生成。',
 '此前答复与 seq130 的当前状态不符，但目前 checkedFileCount=128。',
 '历史 JSON 回复为过期进度；当前报告未生成。',
 '旧快照是过期进度。seq109/111/113/115/117/119 的状态对象中 reportGenerated=false。',
 'seq101 曾报告报告未生成；当前 seq109/111/113 的状态对象中 reportGenerated=false。',
 'seq101 曾报告报告未生成；reportGenerated=false。',
 '过期进度不适用，最新报告未生成。',
];
for(let n=0;n<invalid.length;n++)test('current-conflict-remains-rejected-'+n,()=>assert.equal(validateProgressFacts(invalid[n],selection).ok,false));
const pending={effective:extractProgressFacts('最新进度：本批149个文件已完成扫描和格式检查。报告尚未生成，图表尚未生成。下一步生成本地报告。',{seq:188})};
for(const text of [
 'seq 188取代较早的seq 159（曾报本批142个文件、报告与图表已生成、nextAction=package-and-verify），同一工作项按时间顺序更新。',
 'seq 188按时间顺序取代更早的seq 159（曾报142个文件、报告与图表已生成、nextAction=package-and-verify）。',
 'seq 167/169/171/173/175/177为基于旧状态的重复JSON回答（checkedFileCount=142、reportGenerated=true等），已被seq 188更新，不得再作为当前状态引用。',
 '该报告由原说话者自述，为最新时序状态，取代更早的进度记录（如 seq 159/167–177 所示的本批142、报告与图表已生成、nextAction=package-and-verify 的历史状态快照）。',
 '是否存在本摘要范围外更新的原始进度报告未知；若出现更新报告应以其为准。',
 'seq188 是最新自报进度，已取代 seq159 的“142个文件、报告已生成、图表已生成、下一步打包并校验”。',
 '这些值在报告和图表生成前不应改为已完成。',
 '该进度取代同工作项的 seq=159（本批142、报告与图表已生成、nextAction=package-and-verify）及更早的 seq=72（121）。',
 '此为最新自报进度，并取代同工作项较早进度（seq=159 的142个/报告图表已生成/package-and-verify；seq=130 的135个）。',
 'seq 167、169、171 的状态JSON基于 seq 188 之前的旧进度（142个文件、报告和图表已生成），不是当前进度。',
 'seq 188 取代较早的自报快照：seq101（128个，报告未生成）、seq130（135个，报告已生成）、seq159（142个，报告和图表已生成，nextAction=package-and-verify）。',
 '不要沿用 seq159/seq177 的142个文件及“报告和图表已生成”状态。',
 '生成本地报告（seq 188 指定的下一步），随后生成图表，再打包并使用SHA-256校验。',
 '该进度取代同工作项的更早进度（seq=159 的142个/报告图表已生成/package-and-verify，及 seq=130 的135个）。',
 'seq=160 起重复的JSON状态回答采用 checkedFileCount=142、chartGenerated=true，已被 seq=188 时序取代，不再作为当前状态。',
])test('saved-latest-supersedes-earlier-'+text,()=>assert.equal(validateProgressFacts(text,pending).ok,true));
for(const text of [
 'seq 188取代较早的seq 159（曾报报告已生成），但当前报告已生成。',
 'seq 188不会取代较早的seq 159（报告已生成），当前 checkedFileCount=142。',
 '不得再作为当前状态引用，但目前 reportGenerated=true。',
 'seq 188取代更早的seq 159（nextAction=package-and-verify），当前 nextAction=package-and-verify。',
 'seq 188取代更早的seq 159（当前 reportGenerated=true）。',
 '取代更早的进度记录（如 seq 159 的旧状态），当前报告已生成。',
 '是否存在本摘要范围外更新的原始进度报告未知；当前 reportGenerated=true。',
 'seq188 取代 seq159 的“当前 reportGenerated=true”。',
 '这些值在报告和图表生成前不应改为已完成，但当前图表已生成。',
 '取代同工作项的 seq=159（当前 reportGenerated=true）。',
 'seq=160 的JSON回答已过时，但目前 chartGenerated=true。',
 '该进度取代同工作项的更早进度（seq=159 的旧值），当前 checkedFileCount=142。',
 '当前报告已生成；这取代了 seq159（当前图表已生成）。',
 '不要沿用 seq159 的旧状态，但当前报告已生成。',
 '下一步打包并校验（seq188 指定的下一步）。',
])test('earlier-snapshot-does-not-hide-current-conflict-'+text,()=>assert.equal(validateProgressFacts(text,pending).ok,false));
for(const text of [
 '不得把报告或图表描述为已完成。',
 '在上报完成前不得把报告或图表标为已生成。',
 '打包和校验完成前，报告与图表均不得标为已生成，nextAction保持generate-report。',
 '不要将报告标记为已完成。',
 '图表不得标注为已完成。',
])test('saved-prohibited-completion-label-'+text,()=>assert.equal(validateProgressFacts(text,pending).ok,true));
for(const text of [
 '不得把报告描述为已完成，但当前报告已生成。',
 '报告不得标为已生成，当前 chartGenerated=true。',
 '不要将图表标记为已生成，但是目前图表已生成。',
 '报告标为已生成。',
 '不得把报告标为已生成，nextAction=package-and-verify。',
])test('prohibited-label-does-not-hide-a-real-claim-'+text,()=>assert.equal(validateProgressFacts(text,pending).ok,false));
test('durable-source-extraction-is-unchanged',()=>{
 const source='最新进度：本批135个文件已完成扫描和格式检查。报告已生成，图表尚未生成。下一步生成图表。';
 const facts=extractProgressFacts(source,{seq:130});assert.deepEqual(Object.fromEntries(facts.map(f=>[f.key,f.value])),{checkedFileCount:135,scanCompleted:true,reportGenerated:true,chartGenerated:false,nextAction:'generate-chart'});
});
console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));if(results.some(r=>!r.pass))process.exitCode=1;
