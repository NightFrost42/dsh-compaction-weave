import assert from 'node:assert/strict';import {mkdtemp,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DEFAULT_CONFIG,resolveConfig} from '../lib/config.js';import {mergeSummaryConfig} from '../lib/index.js';import {validateSummaryConfig,handleSummaryConfigRpc,readSummaryConfig} from '../lib/summary-config.js';
const rows=[];async function test(name,fn){try{await fn();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.message});}}
await test('default-is-user-requested-twenty-percent',()=>assert.equal(DEFAULT_CONFIG.minimumReductionRatio,.2));
await test('engine-recognizes-range-setting',()=>{const r=resolveConfig({minimumReductionRatio:.47});assert.equal(r.config.minimumReductionRatio,.47);assert.ok(!r.unknown.includes('minimumReductionRatio'));});
await test('bounds-five-and-ninety-accepted',()=>{for(const v of [.05,.9])assert.equal(validateSummaryConfig({minimumReductionRatio:v}).value.minimumReductionRatio,v);});
await test('bad-setting-rejected',()=>{for(const v of [0,.01,.91,NaN,Infinity,'oops',false,[],{}])assert.equal(validateSummaryConfig({minimumReductionRatio:v}).ok,false);});
await test('whole-percentage-normalization',()=>assert.equal(validateSummaryConfig({minimumReductionRatio:'0.47000000001'}).value.minimumReductionRatio,.47));
await test('independent-of-provider-choice',()=>{const x=validateSummaryConfig({minimumReductionRatio:.2});assert.ok(x.ok);assert.equal(x.value.provider,'');});
await test('saved-setting-wins-without-changing-trigger',()=>assert.deepEqual(mergeSummaryConfig({thresholdRatio:.85,minimumReductionRatio:.2},{minimumReductionRatio:.5}),{thresholdRatio:.85,minimumReductionRatio:.5}));
await test('missing-setting-keeps-engine-value',()=>assert.equal(mergeSummaryConfig({minimumReductionRatio:.3},{thresholdRatio:.8}).minimumReductionRatio,.3));
const dir=await mkdtemp(join(tmpdir(),'weave-slider-')),file=join(dir,'summary.json');
await test('rpc-write-and-read-persist-slider',async()=>{await handleSummaryConfigRpc({method:'set',params:{minimumReductionRatio:.4,thresholdRatio:.85}},file);assert.equal((await handleSummaryConfigRpc({method:'get'},file)).config.minimumReductionRatio,.4);assert.equal(readSummaryConfig(file).thresholdRatio,.85);});
await test('clear-model-keeps-both-sliders',async()=>{const r=await handleSummaryConfigRpc({method:'set',params:{provider:'',model:'',minimumReductionRatio:.2,thresholdRatio:.8}},file);assert.equal(r.cleared,false);assert.equal(readSummaryConfig(file).minimumReductionRatio,.2);});
await test('invalid-rpc-does-not-change-disk',async()=>{const before=await readFile(file,'utf8');await assert.rejects(handleSummaryConfigRpc({method:'set',params:{minimumReductionRatio:2}},file));assert.equal(await readFile(file,'utf8'),before);});
await test('legacy-config-keeps-old-output-shape',()=>assert.deepEqual(validateSummaryConfig({thresholdRatio:.8}).value,{provider:'',model:'',maxTokens:null,thresholdRatio:.8}));
console.log(JSON.stringify({passed:rows.filter(x=>x.pass).length,failed:rows.filter(x=>!x.pass).length,results:rows},null,2));if(rows.some(x=>!x.pass))process.exitCode=1;
