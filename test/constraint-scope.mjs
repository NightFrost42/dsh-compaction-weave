import assert from 'node:assert/strict';
import {auditCompaction, scalarRequirement} from '../lib/audit.js';
import {auditMemorySelection} from '../lib/constraint-scope.js';
const rows=[];function test(name,fn){try{fn();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.message});}}
const audit=(local,retained,notes,checkpoint=notes)=>auditMemorySelection({selection:{active:local.map((text,i)=>({seq:i+10,text})),retained:retained.map((text,i)=>({seq:i+1,text}))},summaryText:notes,checkpointText:checkpoint,includeAllConflicts:true});
test('unchanged-prefix-requirement-needs-no-duplicate-quote',()=>assert.deepEqual(audit([],['Do not delete records.'],'Continue diagnostics.').lost,[]));
test('new-notes-cannot-reverse-prefix-prohibition',()=>assert.ok(audit([],['Do not delete records.'],'Delete records.').lost.some(x=>x.reason==='polarity')));
test('retained-tail-number-cannot-change',()=>assert.ok(audit([],['必须使用25G。'],'必须使用20G。').lost.some(x=>x.reason==='value')));
test('retained-condition-cannot-be-omitted',()=>assert.ok(audit([],['如果语义变了，事务提交逻辑要跟着改。'],'事务提交逻辑要跟着改。').lost.some(x=>x.reason==='condition')));
test('local-coverage-is-still-required',()=>assert.ok(audit(['Do not delete records.'],[],'Continue diagnostics.').lost.some(x=>x.reason==='coverage')));
test('outside-exact-preservation-cannot-mask-reversal',()=>assert.ok(audit([],['Do not delete records.'],'Delete records.','Do not delete records.').lost.length));
test('quoted-reference-does-not-become-an-external-command',()=>{
 const r=auditMemorySelection({selection:{active:[],retained:[{seq:1,text:'Do not delete records.',sourceKind:'runtime-context'}]},summaryText:'Delete records.',checkpointText:'Delete records.'});
 assert.deepEqual(r.lost,[]);
});
for(const [source,candidate] of [['25G','20G'],['512MiB','256MiB'],['180ms','120ms']])test('compact-quantity-'+source,()=>assert.ok(audit([],['Must use '+source+'.'],'Must use '+candidate+'.').lost.some(x=>x.reason==='value')));
test('identical-compact-quantity-remains-valid',()=>assert.deepEqual(audit([],['Must use 25G.'],'Must use 25G.').lost,[]));
test('identifier-digits-not-a-quantity-rule',()=>assert.deepEqual(audit([],['Do not delete file25G.'],'Keep file20G.').lost,[]));
for(const text of ['3D？','3D','5G？','2D 还是 3D？','用 3D？','用 5G？','支持 5G 网络','3M','6S','2H']){
 test('tech-term-not-audited-'+text,()=>{
  const r=auditCompaction({userMessages:[{seq:1,text}],summaryText:'无关的摘要内容。'});
  assert.equal(r.checked,0,JSON.stringify(r));
  assert.equal(scalarRequirement(text),null);
 });
}
test('issue1-3d-question-against-summary-with-line-number',()=>{
 const r=auditCompaction({userMessages:[{seq:1,text:'等别的功能是等什么？3D？'}],summaryText:'**3D 技术选型与性能预算**：属 ADR（[TODO.md:53](TODO.md)）'});
 assert.equal(r.checked,0,JSON.stringify(r));
 assert.deepEqual(r.lost,[]);
});
test('instruction-with-3d-not-false-value-conflict',()=>{
 const r=auditCompaction({userMessages:[{seq:1,text:'必须支持 3D 渲染。'}],summaryText:'必须支持 3D 渲染（见 TODO.md:53）。'});
 assert.deepEqual(r.lost,[]);
});
test('5g-with-size-context-still-enforced',()=>{
 assert.ok(audit([],['备份上限 5G。'],'备份上限 10G。').lost.some(x=>x.reason==='value'));
 assert.deepEqual(scalarRequirement('备份上限 5G。'),{subject:'备份上限',family:'size',value:5,unit:'gb'});
});
test('lowercase-duration-and-5gb-still-enforced',()=>{
 assert.ok(audit([],['必须保留 3d。'],'必须保留 5d。').lost.some(x=>x.reason==='value'));
 assert.ok(audit([],['Must use 5GB.'],'Must use 10GB.').lost.some(x=>x.reason==='value'));
});
console.log(JSON.stringify({passed:rows.filter(x=>x.pass).length,failed:rows.filter(x=>!x.pass).length,results:rows},null,2));if(rows.some(x=>!x.pass))process.exitCode=1;
