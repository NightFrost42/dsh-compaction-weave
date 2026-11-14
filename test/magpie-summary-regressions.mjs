import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {auditCompaction,scalarRequirement,sourceConstraintEvidence} from '../lib/audit.js';
import {reconstructDisputedLines} from '../lib/reconstruct.js';
import {extractProgressFacts,validateProgressFacts} from '../lib/progress-facts.js';
import {summarizeWithChain} from '../lib/summary.js';
import {FailureDiagnostics,diagnosticFor} from '../lib/failure-diagnostics.js';
import {memoryRequirements,selectMemoryMessages,memorySourceRefs,restoreMemorySource} from '../lib/memory-policy.js';
import {buildCheckpointBlocks} from '../lib/region.js';

const results=[];
async function test(name,fn){try{await fn();results.push({name,pass:true});}catch(error){results.push({name,pass:false,error:error.message});}}
const params='生产环境超时必须为35秒，测试环境超时必须为12秒，备份上限必须为8GB。';
const audit=(source,candidate)=>auditCompaction({userMessages:[{seq:2,text:source}],summaryText:candidate,checkpointText:source+'\n'+candidate,includeAllConflicts:true});
for(const candidate of [params,'“'+params+'”','用户要求（seq=2 逐字）：'+params])await test('timeout-parameter-with-source-framing',()=>assert.equal(audit(params,candidate).lost.length,0));
for(const [source,candidate,reason] of [
 [params,'生产环境超时必须为55秒，测试环境超时必须为12秒，备份上限必须为8GB。','value'],
 ['如果生产环境超时，必须运行恢复程序。','必须运行恢复程序。','condition'],
 ['生产环境超时时必须运行恢复程序。','必须运行恢复程序。','condition'],
 ['部署时必须使用35秒超时。','必须使用35秒超时。','condition'],
 ['不得删除已有文件。','删除已有文件。','polarity'],
 ['不得修改生产环境。','构成修改生产环境的授权。','polarity'],
 ['不得修改生产环境。','不构成修改生产环境的授权，但现在修改生产环境。','polarity'],
 ['不得删除已有文件。','未见删除已有文件的操作记录，但下一步删除已有文件。','polarity'],
])await test('real-conflict-'+reason,()=>assert.ok(audit(source,candidate).lost.some(x=>x.reason===reason)));
for(const [source,candidate] of [
 ['不得修改生产环境。','也不构成修改生产环境的授权。'],
 ['不得删除已有文件。','本页未见任何生产环境变更或删除已有文件的操作记录。'],
  ['不得删除已有文件。不上传。','本页没有生产修改、删除已有文件或上传的证据，也不能据此宣称已完成约束遵守核验。'],
  ['不得删除已有文件。不上传。','尚无生产修改、删除已有文件、上传的操作记录。'],
])await test('negative-statement-not-positive-permission',()=>assert.equal(audit(source,candidate).lost.length,0));
for(const candidate of [
 '本页没有生产修改、删除已有文件或上传的证据，但下一步上传。',
 '本页没有生产修改、删除已有文件或上传的证据，随后删除已有文件。',
 '本页没有生产修改、下一步删除已有文件，然后补齐证据。',
 '本页没有生产修改证据，删除已有文件并上传。',
 '没有备份，删除已有文件并上传。',
])await test('missing-evidence-scope-does-not-hide-new-actions',()=>assert.ok(audit('不得删除已有文件。不上传。',candidate).lost.some(x=>x.reason==='polarity')));
const progress='最新进度：本批107个文件已完成扫描和格式检查。报告尚未生成，图表尚未生成。下一步生成本地报告。不上传。';
const selection={effective:extractProgressFacts(progress,{seq:9})};
for(const candidate of [
 '生成本地报告（source seq 9 所列下一步），随后生成图表，最后做打包验证；',
 '生成本地报告（seq=9 所述下一步），随后生成图表。',
])await test('source-citation-keeps-first-action',()=>assert.equal(validateProgressFacts(candidate,selection).ok,true));
for(const candidate of ['下一步生成图表。','下一步打包并校验。','当前 nextAction=generate-chart。','checkedFileCount: null。','已检查420个文件。'])await test('current-progress-change-still-rejected',()=>assert.equal(validateProgressFacts(candidate,selection).ok,false));

await test('explicit-next-action-conflict-not-masked-by-citation',()=>{
 const candidate='nextAction=generate-chart，生成本地报告（source seq 9 所列下一步），随后生成图表。';
 assert.equal(validateProgressFacts(candidate,selection).ok,false);
});
await test('reported-file-scan-is-not-report-artifact-completion',()=>{
 const candidate='source seq=5 报告本批107个文件已完成扫描和格式检查；';
 assert.equal(validateProgressFacts(candidate,selection).ok,true);
 assert.equal(validateProgressFacts('source seq=5 当前报告已生成。',selection).ok,false);
});
for(const action of ['上传','下载','发送','联网','覆盖','发布','修改','删除','写入','写库'])await test('bare-prohibition-retained-'+action,()=>{
 const source='不'+action+'。',request={seq:2,text:source};
 assert.ok(memoryRequirements([request])[0].text.includes(source));
 assert.equal(audit(source,source).lost.length,0);
 assert.ok(audit(source,action+'。').lost.some(x=>x.reason==='polarity'));
});
await test('no-upload-survives-repeated-requirement-projection',()=>{
 let requests=[{seq:2,text:'请完成本地报告、图表和打包验证。不得修改生产环境。不上传。诊断日志格式必须使用JSONL。'}];
 for(let i=0;i<8;i++){
  requests=memoryRequirements(selectMemoryMessages(requests).active);
  assert.ok(requests.some(m=>m.text.includes('不上传。')),'generation '+i);
  const blocks=buildCheckpointBlocks([{type:'text',text:'Continue the local work.'}],requests,'Checkpoint');
  assert.match(JSON.stringify(blocks),/不上传/);
 }
});

const replacement='生产环境超时改为55秒，替代先前35秒的要求。';
await test('explicit-revision-with-old-value-is-a-current-scalar-requirement',()=>{
 assert.deepEqual(scalarRequirement(replacement),{subject:'生产环境超时',value:'55',unit:'秒',family:'time'});
 assert.deepEqual(sourceConstraintEvidence(replacement),[replacement]);
 assert.equal(audit(replacement,'生产环境超时55秒。').lost.length,0);
 assert.ok(audit(replacement,'生产环境超时35秒。').lost.some(x=>x.reason==='value'));
 assert.ok(audit(replacement,'当前生产环境超时35秒，以原先要求为准。').lost.some(x=>x.reason==='value'));
});
await test('revising-one-parameter-retains-peers-and-exact-source-layout',()=>{
 const original={seq:5,text:'生产环境超时必须为35秒，测试环境超时必须为12秒，备份上限必须为8GB。不得修改生产环境。不上传。'};
 const revision={seq:65,text:replacement};
 const chosen=selectMemoryMessages([original,revision]);
 assert.equal(chosen.active[0].text,'测试环境超时必须为12秒，备份上限必须为8GB。不得修改生产环境。不上传。');
 assert.equal(chosen.active[1].text,replacement);
 assert.equal(chosen.decisions.filter(d=>d.reason==='superseded').length,1);
 const source={content:[{type:'text',text:original.text}],seq:original.seq};
 const ref=memorySourceRefs([chosen.active[0]],{eventAt:()=>({type:'user/message'}),deriveEventMessage:()=>source})[0];
 assert.equal(restoreMemorySource(original,ref).text,chosen.active[0].text);
});
await test('explicit-revision-remains-a-requirement-through-eight-projections',()=>{
 let requests=[{seq:5,text:params+'不得修改生产环境。不上传。'},{seq:65,text:replacement}];
 for(let i=0;i<8;i++){
  requests=memoryRequirements(selectMemoryMessages(requests).active);
  const all=requests.map(m=>m.text).join('\n');
  assert.match(all,/生产环境超时改为55秒/);
  assert.match(all,/测试环境超时必须为12秒/);
  assert.match(all,/备份上限必须为8GB/);
  assert.match(all,/不上传/);
  assert.doesNotMatch(all,/生产环境超时必须为35秒/);
 }
});
for(const value of [
 '如果报告完成，生产环境超时改为55秒，替代先前35秒的要求。',
 '生产环境超时改为55秒，测试环境超时为12秒。',
 '生产环境超时改为55秒，替代测试环境35秒的要求。',
 '生产环境超时已为55秒。',
 '日志称生产环境超时改为55秒，替代先前35秒的要求。',
])await test('ambiguous-or-observed-scalar-not-a-replacement-'+value.slice(0,20),()=>assert.equal(scalarRequirement(value),null));
await test('revision-does-not-retire-another-environment',()=>{
 const selected=selectMemoryMessages([{seq:1,text:'测试环境超时必须为35秒。'},{seq:2,text:replacement}]);
 assert.equal(selected.active.length,2);
});
for(const candidate of [
 '- 已被取代的旧进度（仅作历史）：seq 12（107 个文件、报告与图表均未生成）、seq 42（114 个、报告已生成）、seq 72（121 个、报告与图表已生成）、seq 101（128 个、报告与图表均未生成）；',
 '- seq=130 的 135 个文件计数、报告已生成和图表未生成均为助手自述，未独立复核；',
])await test('second-cycle-attribution-keeps-distinct-current-objects',()=>{
 const selection={effective:extractProgressFacts('本批135个文件已完成扫描。报告已生成，图表尚未生成。',{seq:130})};
 assert.equal(validateProgressFacts(candidate,selection).ok,true);
 assert.equal(validateProgressFacts('旧进度不适用，但目前报告未生成。',selection).ok,false);
 assert.equal(validateProgressFacts('报告未生成和当前图表已生成。',selection).ok,false);
});

const cacheRetestCorpus=JSON.parse(readFileSync(new URL('./fixtures/magpie-cache-retest-candidates.json',import.meta.url),'utf8'));
for(const sample of cacheRetestCorpus)await test(sample.name,()=>{
 const verdict=validateProgressFacts(sample.candidate,{effective:extractProgressFacts(sample.source,{seq:sample.seq})});
 assert.equal(verdict.ok,true,JSON.stringify(verdict));
});
const retestProgress={effective:extractProgressFacts('最新进度：本批114个文件已完成扫描和格式检查。报告已生成，图表尚未生成。下一步生成图表。',{seq:42})};
for(const candidate of [
 '1. 生成图表，并确认图表数据来源与已生成的报告一致。',
 '1. 生成图表，并确认图表数据来源与已生成的报告一致（seq=42）。',
 '- 图表与已生成报告的数据一致性尚未验证；',
 '图表须与已生成报告的数据来源一致，未验证结果必须标注。',
 '报告已生成和图表未生成。',
 '报告已生成并且当前图表尚未生成。',
])await test('candidate-completion-predicate-belongs-to-its-object-'+candidate.slice(0,28),()=>{
 assert.equal(validateProgressFacts(candidate,retestProgress).ok,true);
 assert.ok(!extractProgressFacts(candidate,{candidate:true}).some(f=>f.key==='chartGenerated'&&f.value===true));
});
for(const candidate of [
 '报告与图表均已生成。',
 '图表与报告均已生成。',
 '报告已生成和图表已生成。',
 '图表已生成并确认图表来源与已生成的报告一致。',
 '图表来源与报告一致，当前图表已生成。',
 '生成图表，并确认图表来源与已生成的报告一致，但当前 chartGenerated=true。',
 '报告未生成和图表未生成。',
])await test('object-scoping-still-rejects-completion-conflicts-'+candidate.slice(0,28),()=>assert.equal(validateProgressFacts(candidate,retestProgress).ok,false));
await test('object-scoping-keeps-shared-negative-predicates',()=>{
 const facts=extractProgressFacts('报告与图表均未生成。',{candidate:true});
 assert.deepEqual(facts.map(f=>[f.key,f.value]),[['reportGenerated',false],['chartGenerated',false]]);
 assert.equal(validateProgressFacts('报告与图表均未生成。',selection).ok,true);
 assert.equal(validateProgressFacts('报告与图表均未生成。',retestProgress).ok,false);
});
for(const candidate of [
 '- 历史状态（非当前进度）：seq 28/30 的快照为 `checkedFileCount=107`、`reportGenerated=false`、`nextAction=generate-report`，已被 seq 42 取代。',
 '- 以 seq 28 和 seq 30 为来源的状态快照报告为“107 个文件、报告未生成”，该状态已被 seq 42 取代，不再作为当前进度。',
 '3. 打包验证完成后判定 `nextAction=none`；',
 '3. 图表生成后再判定 nextAction=package-and-verify。',
 '- seq 42 的 nextAction=generate-chart 已覆盖旧快照；但更晚是否已生成图表、报告文件的实际存放路径，本段内均无证据。',
])await test('retest-source-and-future-attribution-'+candidate.slice(0,20),()=>assert.equal(validateProgressFacts(candidate,retestProgress).ok,true));
for(const candidate of [
 '历史状态（非当前进度）不再适用，但目前 checkedFileCount=107。',
 '以 seq 28 和 seq 30 为来源的状态已被 seq 42 取代，但当前报告未生成。',
 '打包验证完成后判定 nextAction=none，但当前 nextAction=none。',
 '打包验证完成后判定 nextAction=none，checkedFileCount: 999。',
 '当前判定 nextAction=none。',
 'seq 42 的 nextAction=generate-chart 已覆盖旧快照；但更晚是否有更新未知，checkedFileCount: 999。',
 'seq 42 的 nextAction=generate-chart 已覆盖旧快照；但更晚的当前状态：图表已生成。',
 'seq 28 的 nextAction=generate-report 是旧快照；但更晚是否已生成图表，本段内均无证据。',
 'seq 42 的 nextAction=generate-chart 已覆盖旧快照。\n但更晚是否已生成图表，本段内均无证据。',
])await test('retest-current-conflict-not-hidden-'+candidate.slice(0,20),()=>assert.equal(validateProgressFacts(candidate,retestProgress).ok,false));

for(const candidate of [
 '1. 生成图表，使 chartGenerated=true，并在完成后核验图表内容与未验证标注。',
 '1. 生成图表，使 `chartGenerated=true`，并核验图表内容；',
 '- 历史上 seq28/30 的状态快照曾记录107个文件、报告未生成、下一步生成报告，但已被 seq42 对同一工作项的最新进度取代，不再作为当前状态。',
])await test('future-artifact-action-and-superseded-reference',()=>assert.equal(validateProgressFacts(candidate,retestProgress).ok,true));
for(const candidate of [
 '1. 生成图表，使 chartGenerated=true，但当前 chartGenerated=true。',
 '1. 生成图表，使 chartGenerated=true，checkedFileCount=999。',
 '当前 chartGenerated=true，下一步生成图表。',
 '已生成图表，使 chartGenerated=true。',
 '生成报告，使 chartGenerated=true。',
 '历史上图表已生成，但目前图表已生成。',
 '旧快照已被 seq42 的最新进度取代，但当前报告未生成。',
])await test('future-action-does-not-mask-current-conflicts-'+candidate.slice(0,24),()=>assert.equal(validateProgressFacts(candidate,retestProgress).ok,false));
await test('source-declared-next-action-remains-the-first-action',()=>{
 assert.equal(validateProgressFacts('生成本地报告（seq=9 声明的下一步），随后生成图表。',selection).ok,true);
});

const chronologyCorpus=JSON.parse(readFileSync(new URL('./fixtures/magpie-chronology-candidates.json',import.meta.url),'utf8'));
for(const sample of chronologyCorpus)await test(sample.name,()=>{
 const verdict=validateProgressFacts(sample.candidate,{effective:extractProgressFacts(sample.source,{seq:sample.seq})});
 assert.equal(verdict.ok,true,JSON.stringify(verdict));
});
for(const candidate of [
 'seq=42 是最新进度，取代旧快照：seq=28（报告未生成、图表已生成、nextAction=generate-report），不得复制为当前状态。',
 'seq=42 取代旧进度：seq=28（报告未生成）、seq=30（图表已生成）。',
 '当前进度取代 seq 28（报告未生成、图表已生成），这些是历史状态。',
 'seq28 所述报告未生成，已被 seq42 的进度取代，不应作为当前状态。',
 '更早 seq=28 称报告未生成、nextAction=generate-report；',
 '较早 seq=28 称报告未生成、nextAction=generate-report；',
])await test('superseded-source-snapshot-is-not-current-'+candidate.slice(0,25),()=>assert.equal(validateProgressFacts(candidate,retestProgress).ok,true));
for(const candidate of [
 'seq=42 取代旧快照：seq=28（报告未生成），但当前报告未生成。',
 'seq=42 取代旧快照：seq=28（图表已生成），chartGenerated=true。',
 'seq=42 取代旧快照：seq=28（nextAction=generate-report），当前 nextAction=generate-report。',
 'seq=42 取代旧快照：seq=28（报告未生成）；当前 seq=42（报告未生成）。',
 'seq=42 取代旧快照：seq=28（报告未生成），当前 seq=42（报告未生成）。',
 'seq28 所述报告未生成，已被 seq42 取代，不应作为当前状态，但目前报告未生成。',
 '当前记录不能取代 seq28（报告未生成）。',
 '更早 seq=28 称报告未生成，但当前报告未生成。',
 '更早 seq=28 称报告已生成、当前 chartGenerated=true。',
 'nextAction=generate-chart，生成报告（seq=9 计划的下一步），之后生成图表。',
])await test('chronology-does-not-hide-current-conflict-'+candidate.slice(0,25),()=>{
 const expected=candidate.includes('计划的下一步')?selection:retestProgress;
 assert.equal(validateProgressFacts(candidate,expected).ok,false);
});
await test('planned-source-next-action-keeps-first-step',()=>assert.equal(validateProgressFacts('生成报告（seq=9 计划的下一步），之后生成图表，再做打包验证。',selection).ok,true));

const corpus=JSON.parse(readFileSync(new URL('./fixtures/magpie-summary-candidates.json',import.meta.url),'utf8'));
for(const sample of corpus)await test(sample.name,()=>{
 const v=auditCompaction({userMessages:sample.requirements,summaryText:sample.candidate,checkpointText:sample.requirements.map(m=>m.text).join('\n')+'\n'+sample.candidate,includeAllConflicts:true});
 // The newly retained no-upload rule can reject an old summary's upload
 // uncertainty. Its original sentence must be recoverable and pass re-audit.
 if(v.lost.length){
  assert.ok(v.lost.every(x=>x.line==='不上传'),JSON.stringify(v));
  const rebuilt=reconstructDisputedLines({text:sample.candidate,userMessages:sample.requirements,audit:v,language:'zh',format:'continuation'});assert.ok(rebuilt);
  const restored=auditCompaction({userMessages:sample.requirements,summaryText:rebuilt.text,checkpointText:sample.requirements.map(m=>m.text).join('\n')+'\n'+rebuilt.text});assert.equal(restored.lost.length,0,JSON.stringify(restored));
 }
 if(sample.progress)assert.equal(validateProgressFacts(sample.candidate,{effective:extractProgressFacts(sample.progress.text,{seq:sample.progress.seq})}).ok,true);
});
for(const [name,usage,known] of [
 ['synthetic-zero-terminal-error',{inputTokens:0,outputTokens:0,totalTokens:0},false],
 ['positive-terminal-error',{inputTokens:17,outputTokens:0,totalTokens:17},true],
 ['cache-only-terminal-error',{inputTokens:0,outputTokens:0,cacheReadTokens:32,totalTokens:32},true],
])await test(name,async()=>{
 const session={id:'isolated-error-'+name},d=new FailureDiagnostics(await mkdtemp(join(tmpdir(),'weave-magpie-error-')));let error;
 try{await d.run(session,{trigger:'manual',commandId:name},()=>summarizeWithChain({ctx:{llm:{async *stream(){yield {type:'usage',usage};yield {type:'finish',reason:{kind:'error',failure:{code:'SERVER',message:'service temporarily unavailable (503)'}}};}}},agent:{session},input:{messages:[]},chain:{targets:[{provider:'fixture',model:'fixture'}]},options:{maxTokens:1000,timeoutMs:5000,retryCount:0,retryDelayMs:0}}));}catch(e){error=e;}
 assert.ok(error);const receipt=diagnosticFor(error);assert.equal(receipt.status,'saved');const report=JSON.parse(await readFile(receipt.path,'utf8'));assert.equal(report.totalAttempts,1);assert.equal(report.attempts[0].requestStarted,true);assert.equal(report.attempts[0].usageKnown,known);if(!known)assert.equal(report.attempts[0].usage,undefined);
});
console.log(JSON.stringify({passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,results},null,2));if(results.some(x=>!x.pass))process.exitCode=1;
