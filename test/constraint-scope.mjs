import assert from 'node:assert/strict';
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
console.log(JSON.stringify({passed:rows.filter(x=>x.pass).length,failed:rows.filter(x=>!x.pass).length,results:rows},null,2));if(rows.some(x=>!x.pass))process.exitCode=1;
