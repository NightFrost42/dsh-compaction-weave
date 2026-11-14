import assert from 'node:assert/strict';
import {auditCompaction} from '../lib/audit.js';
import {extractProgressFacts,validateProgressFacts} from '../lib/progress-facts.js';
const results=[];
function test(name,fn){try{fn();results.push({name,pass:true});}catch(error){results.push({name,pass:false,error:error.stack});}}
const selection={effective:extractProgressFacts('最新进度：本批149个文件已完成扫描和格式检查。报告尚未生成，图表尚未生成。下一步生成本地报告。',{seq:188})};
for(const text of [
 'seq=159/167–177 等较早的“142个文件、报告图表已生成、nextAction=package-and-verify”快照已被 seq=188 时序取代（时序更新，非冲突）。',
 'seq 167–177 曾按当时的最新进度返回 JSON（checkedFileCount=142、reportGenerated=true、chartGenerated=true、nextAction="package-and-verify"），这些快照已被 seq 188 取代，不再代表当前状态。',
]){
 test('superseded-source-attribution-'+text,()=>assert.equal(validateProgressFacts(text,selection).ok,true));
 for(const conflict of ['当前报告已生成。','当前 checkedFileCount=142。','当前 nextAction=package-and-verify。'])test('attribution-keeps-current-conflict-'+text+conflict,()=>assert.equal(validateProgressFacts(text+conflict,selection).ok,false));
}
for(const text of [
 'seq167 当时的最新进度为 reportGenerated=true，但现在 reportGenerated=true。',
 'seq167 曾按当时的最新进度返回 JSON（当前 reportGenerated=true），但当前报告已生成。',
 'seq159 的旧快照不会被 seq188 取代，当前 checkedFileCount=142。',
 'seq159 的旧快照已被 seq188 取代，但当前 checkedFileCount=142。',
 'seq159 等较早的“当前报告已生成”快照已被 seq188 时序取代。',
 'seq159 等较早的“现在 checkedFileCount=142”快照已被 seq188 时序取代。',
])test('current-assertions-remain-rejected-'+text,()=>assert.equal(validateProgressFacts(text,selection).ok,false));
const source='不得修改生产环境。不得删除已有文件。';
const audit=text=>auditCompaction({userMessages:[{seq:5,text:source}],summaryText:text,checkpointText:source+'\n'+text,includeAllConflicts:true});
for(const text of [
 '必须确认实际输入及不会删除已有文件或修改生产环境的安全输出路径。',
 '实际输入及不会删除已有文件或修改生产环境的安全输出路径。',
 '确认不会修改生产环境或删除已有文件的输出位置。',
 '不会修改生产环境，不会删除已有文件。',
])test('future-negation-keeps-prohibition-'+text,()=>assert.equal(audit(text).lost.length,0));
for(const text of [
 '不会删除已有文件，但现在修改生产环境。',
 '不会修改生产环境。下一步删除已有文件。',
 '不会修改生产环境，但随后删除已有文件。',
 '下一步修改生产环境，然后不会删除已有文件。',
 '确认不会删除已有文件的输出路径，随后修改生产环境。',
 '不会删除已有文件或修改生产环境，但现在修改生产环境。',
])test('future-negation-does-not-authorize-new-action-'+text,()=>assert.ok(audit(text).lost.some(row=>row.reason==='polarity')));
for(const text of [
 '较早进度快照（seq130 的135个文件及报告已生成）均已被 seq188 的最新进度取代。',
 '较早进度记录（seq101 的128个文件；seq130 自报报告已生成）均已被 seq188 的最新原始进度按时序取代。',
 '按 seq188 的下一步安排，先生成当前批次（checkedFileCount=149）的本地报告，随后依次生成图表，再打包校验。',
]){
 test('backward-source-attribution-and-first-action-'+text,()=>assert.equal(validateProgressFacts(text,selection).ok,true));
 test('later-current-claim-is-still-checked-'+text,()=>assert.equal(validateProgressFacts(text+'当前报告已生成。',selection).ok,false));
}
for(const text of [
 '较早进度（seq130 当前报告已生成）均已被 seq188 的最新报告取代。',
 '较早进度（seq130 报告已生成）尚未被 seq188 的最新进度取代，当前报告已生成。',
 '较早进度（seq130 报告已生成）均已被 seq188 的最新报告取代，但当前报告已生成。',
 '下一步生成当前批次的本地图表，随后生成报告。',
])test('historical-list-does-not-mask-actual-conflict-'+text,()=>assert.equal(validateProgressFacts(text,selection).ok,false));
console.log(JSON.stringify({passed:results.filter(row=>row.pass).length,failed:results.filter(row=>!row.pass).length,results},null,2));
if(results.some(row=>!row.pass))process.exitCode=1;
