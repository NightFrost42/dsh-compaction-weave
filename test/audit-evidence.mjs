import assert from 'node:assert/strict';
import {auditCompaction} from '../lib/audit.js';
import {summarizeWithChain} from '../lib/summary.js';
import {buildSummaryRequest} from '../lib/summary-budget.js';
import {buildCompactionInstruction,renderRepairFeedback} from '../lib/prompt.js';
import {validateSummaryStructure} from '../lib/validate.js';
const results=[];
async function test(id,fn){try{await fn();results.push({id,pass:true});}catch(e){results.push({id,pass:false,error:e.message});}}
const cases=[
 ['nested-read','不要改 profile','改为 `$j.dsh.profile.bundles` 后读到 44 条',false],
 ['nested-read-inline','不要改 `profile`','读取 `$j.dsh.profile.bundles`',false],
 ['direct-edit','不要改 profile','改 profile',true],
 ['nested-edit','不要改 `$j.dsh.profile.bundles`','改 `$j.dsh.profile.bundles`',true],
 ['different-properties','不要改 `$j.dsh.profile.bundles`','改 `$j.dsh.profile.plugins`',false],
 ['code-locations','`lib/engine.js:198` 要建 state 目录','`lib/engine.js:1514` `return { ...current, failures, stopped: failures >= this.config.failureThreshold };`',false],
 ['code-locations-config','`lib/config.js:108` 首行 `if (value === undefined || value === null || value === 0) return null;`','`lib/config.js:19-23` `summarizationProvider: null`',false],
 ['same-claim-wrong-line','必须在 `lib/engine.js:198` 建 state 目录','必须在 `lib/engine.js:1514` 建 state 目录',true],
 ['same-claim-wrong-file','必须在 `lib/engine.js:198` 建 state 目录','必须在 `lib/config.js:198` 建 state 目录',true],
 ['code-plus-numeric','必须在 `lib/config.js:108` 设置 timeout=30','必须在 `lib/config.js:108` 设置 timeout=60',true],
 ['code-plus-polarity','不要修改 `lib/config.js:108`','修改 `lib/config.js:108`',true],
 ['intro-condition-narrative','代价是以后如果你在 profile 里手动跑 `pnpm install`，pnpm 会把这个不在 lockfile 里的包删掉——那时候重新双击一次 `install.cmd` 就行','安装已由用户手动执行完毕',false],
 ['intro-condition-row-noun','代价是以后如果你在 profile 里手动跑 `pnpm install`，pnpm 会把这个不在 lockfile 里的包删掉——那时候重新双击一次 `install.cmd` 就行','插件替换 `compaction-basic` 行',false],
 ['intro-condition-action-lost','说明以后如果测试失败，不要发布版本','不要发布版本',true],
 ['intro-condition-negation','说明以后如果测试失败，不要发布版本','说明以后如果测试失败，发布版本',true],
 ['separate-condition','如果报告提到它，不要写库','安装已完成',false],
 ['condition-drop','如果报告提到它，不要写库','不要写库',true],
 ['condition-flip','如果报告提到它，不要写库','报告提到它就写库',true],
 ['condition-paraphrase','如果报告提到它，不要写库','报告若提到它也不要写库',false],
 ['condition-paraphrase-when','如果报告提到它，不要写库','当报告提到它时，不要写库',false],
 ['condition-and-or','如果测试成功且用户批准，不要部署','如果测试成功或用户批准，不要部署',true],
 ['numeric-value','Always retain logs for 30 days','Always retain logs for 7 days',true],
 ['numeric-unit','Always retain logs for 30 days','Always retain logs for 30 hours',true],
 ['direction','Copy A to B','Copy B to A',true],
 ['polarity-with-correct-copy','Do not delete production data','Do not delete production data. Delete production data.',true],
];
for(const [id,source,candidate,reject] of cases)await test(id,()=>{const a=auditCompaction({userMessages:[{seq:1,text:source}],summaryText:candidate,checkpointText:source+'\n'+candidate});assert.equal(a.lost.length>0,reject,JSON.stringify(a));});
await test('conditional-owners-use-evidence-within-tier',()=>{
 const userMessages=[{seq:1,text:'If alpha check fails, do not deploy package.'},{seq:2,text:'If beta validation succeeds, do not deploy package.'}];
 const summaryText='If beta validation fails, do not deploy package.';
 const audit=auditCompaction({userMessages,summaryText,checkpointText:userMessages.map(m=>m.text).join('\n')+'\n'+summaryText});
 assert.deepEqual(audit.lost.map(x=>[x.seq,x.reason]),[[2,'condition']]);
});
await test('conditional-owner-exact-copy-keeps-scope',()=>{
 const userMessages=[{seq:1,text:'If alpha check fails, do not deploy package.'},{seq:2,text:'If beta validation succeeds, do not deploy package.'}];
 const summaryText=userMessages[1].text;
 assert.equal(auditCompaction({userMessages,summaryText,checkpointText:userMessages.map(m=>m.text).join('\n')}).lost.length,0);
});
await test('conditional-owner-nearby-polarity-still-rejected',()=>{
 const userMessages=[{seq:1,text:'If alpha check fails, do not deploy package.'},{seq:2,text:'If beta validation succeeds, do not deploy package.'}];
 const summaryText='If beta validation succeeds, deploy package.';
 const audit=auditCompaction({userMessages,summaryText,checkpointText:userMessages.map(m=>m.text).join('\n')+'\n'+summaryText});
 assert.deepEqual(audit.lost.map(x=>[x.seq,x.reason]),[[2,'polarity']]);
});
await test('missing-source-still-rejected',()=>assert.ok(auditCompaction({userMessages:[{seq:1,text:'不要改 profile'}],summaryText:'安装完成'}).lost.length));
const headings=buildCompactionInstruction('en').split('\n').filter(x=>x.startsWith('## '));
const good=headings.map(h=>h+'\n'+(h.startsWith('## 6.')?'[filled by engine]':'Evidence retained.')).join('\n\n');
const input={messages:[{role:'user',content:[{type:'text',text:'Do not delete production data.'}]}]};
function harness(output,extra={}){
 const calls=[],rejections=[];let n=0;
 const ctx={llm:{async *stream(options){calls.push(options);const text=await output(options,n++);yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};}}};
 const args={ctx,agent:{},input,chain:{targets:[{provider:'one',model:'model'},{provider:'two',model:'model'}]},options:{retryDelayMs:0,maxTokens:8192,timeoutMs:5000,language:'en',validate:r=>validateSummaryStructure(r.rawText,{language:r.language}),onRejected:x=>{rejections.push(x);},...extra.options},signal:extra.signal??new AbortController().signal};
 if(extra.chain)args.chain=extra.chain;
 return {calls,rejections,run:()=>summarizeWithChain(args)};
}
await test('normal-fallback-before-repair',async()=>{const h=harness((o,n)=>n===1?good:'Done.');await h.run();assert.deepEqual(h.calls.map(x=>x.provider),['one','two']);assert.equal(h.rejections.length,1);});
await test('repair-feedback-regenerates',async()=>{const h=harness((o,n)=>n===2?good:'Done.');await h.run();assert.deepEqual(h.calls.map(x=>x.provider),['one','two','one']);assert.match(h.calls[2].messages.at(-1).content[0].text,/REPAIR REQUEST/);assert.equal(h.rejections[0].modelRawText,'Done.');assert.equal(h.rejections[0].attempt,1);});
await test('repair-never-autoaccepts',async()=>{const h=harness(()=>good,{options:{validate:()=>({ok:false,code:'CONSTRAINT_POLARITY_LOST',audit:{lost:[{seq:1,line:'Do not delete production data.',candidate:'Delete production data.',reason:'polarity'}]}})}});await assert.rejects(h.run(),e=>e.code==='CONSTRAINT_POLARITY_LOST');assert.equal(h.calls.length,3);assert.equal(h.rejections.at(-1).attempt,3);assert.match(h.calls[2].messages.at(-1).content[0].text,/Do not delete production data/);});
await test('network-retries-with-common-cap',async()=>{const h=harness(()=>{throw Object.assign(new Error('offline'),{code:'NETWORK'});});await assert.rejects(h.run());assert.equal(h.calls.length,3);});
await test('nonshrinking-uses-common-retry-cap',async()=>{const h=harness(()=>good,{options:{validate:()=>({ok:false,code:'SUMMARY_NOT_SMALLER'})}});await assert.rejects(h.run());assert.equal(h.calls.length,3);});
await test('cancel-before-repair',async()=>{const c=new AbortController();const h=harness(()=>good,{signal:c.signal,options:{validate:()=>{c.abort(new Error('cancelled'));return {ok:false,code:'SUMMARY_STRUCTURE_INVALID'};}}});await assert.rejects(h.run());assert.equal(h.calls.length,1);});
await test('diagnostic-failure-irrelevant',async()=>{const h=harness((o,n)=>n===2?good:'Done.',{options:{onRejected:()=>{throw new Error('disk unavailable');}}});assert.ok(await h.run());});
await test('repair-complete-request-budget',()=>{const base=buildSummaryRequest(input,{language:'en'}),repair=buildSummaryRequest(input,{language:'en',repairFeedback:{code:'CONSTRAINT_LOST',issues:[{line:'必须保留精确条件。'}]}});assert.ok(repair.inputUnits>base.inputUnits);assert.equal(repair.inputUnits,Buffer.byteLength(JSON.stringify({messages:repair.messages,tools:repair.tools}),'utf8'));});
await test('feedback-bounded-whole-records',()=>{const feedback=renderRepairFeedback({code:'CONSTRAINT_LOST',issues:Array.from({length:100},()=>({line:'中'.repeat(4000),candidate:'x',reason:'coverage'}))});assert.ok(Buffer.byteLength(feedback)<=8192);const parsed=JSON.parse(feedback.split('\n').at(-1));assert.equal(parsed.issues.length,0);});
await test('repair-overflow-never-sent',async()=>{const first=buildSummaryRequest(input,{language:'en'}).inputUnits;const h=harness(()=> 'Done.',{chain:{targets:[{provider:'one',model:'model'}]},options:{capacity:{targets:[{key:JSON.stringify(['one','model']),window:1e6,output:8192,margin:0,inputRatio:1,maxInputBytes:first+10,scale:1}],shrinkLimit:Infinity}}});await assert.rejects(h.run(),e=>e.failureCodes.includes('CONTEXT_WINDOW_EXCEEDED'));assert.equal(h.calls.length,1);});
console.log(JSON.stringify({passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,results},null,2));if(results.some(x=>!x.pass))process.exitCode=1;
