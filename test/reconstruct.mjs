import assert from 'node:assert/strict';
import {reconstructDisputedLines} from '../lib/reconstruct.js';
import {auditCompaction} from '../lib/audit.js';
import {buildCompactionInstruction} from '../lib/prompt.js';
import {materializeUserMessageSection,validateSummaryStructure,validateUserMessageSection} from '../lib/validate.js';
import {summarizeWithChain} from '../lib/summary.js';
const headings=buildCompactionInstruction('en').split('\n').filter(x=>x.startsWith('## '));
const frame=s=>headings.map((h,i)=>h+'\n'+(i===0?s:i===5?'[filled by engine]':'(none)')).join('\n\n');
const results=[];async function test(id,fn){try{await fn();results.push({id,pass:true});}catch(e){results.push({id,pass:false,error:e.message});}}
for(const [id,source,candidate] of [
 ['polarity','不要改 profile。','改 profile。'],
 ['condition','如果报告提到它，不要写库。','不要写库。'],
 ['unknown-paraphrase','如果报告提到它，不要写库。','如果最终报告提到该包/相关事项，不要写库。'],
 ['value','Always retain logs for 30 days.','Always retain logs for 7 days.'],
 ['casing','Do not delete `ImportantData`.','Delete `ImportantData`.'],
 ['reference','必须在 `lib/engine.js:198` 建 state 目录。','必须在 `lib/engine.js:1514` 建 state 目录。'],
 ['mixed-claims','不要改 profile。','改 profile，状态已核实。'],
 ['intro','说明以后如果测试失败，不要发布版本。','不要发布版本。']
])await test(id,()=>{
 const userMessages=[{seq:4,text:source}];const text=frame(candidate);
 const audit=auditCompaction({userMessages,summaryText:text,checkpointText:source+'\n'+text});
 assert.ok(audit.lost.length,'raw contradiction must still be rejected');
 const rebuilt=reconstructDisputedLines({text,userMessages,audit,language:'en'});assert.ok(rebuilt);
 assert.ok(rebuilt.text.includes('> '+source));assert.ok(!rebuilt.text.split('\n').includes(candidate));
 const compiled=materializeUserMessageSection(rebuilt.text,userMessages,'en');
 const after=auditCompaction({userMessages,summaryText:compiled,checkpointText:compiled});assert.equal(after.lost.length,0,JSON.stringify(after));
 assert.ok(validateUserMessageSection(validateSummaryStructure(compiled,{language:'en'}).userSectionBody,userMessages).ok);
 assert.equal(rebuilt.receipts[0].sourceSha256.length,64);
});
await test('long-physical-line-keeps-whole-rule',()=>{
 const rule='如果用户批准，才运行 `Install.cmd`，不要改 `Profile`。';
 const source='历史说明。'.repeat(9000)+rule+'后续备注。'.repeat(9000);
 const text=frame('不要改 `Profile`。');
 const r=reconstructDisputedLines({text,userMessages:[{seq:1,text:source}],audit:{lost:[{seq:1,line:'不要改 `profile`',candidate:'不要改 `profile`',reason:'condition'}]},language:'en'});
 assert.ok(r);assert.ok(r.text.includes(rule));assert.ok(r.text.length<3000);
 assert.equal(source.slice(r.receipts[0].sourceStart,r.receipts[0].sourceStart+r.receipts[0].sourceLength),rule);
});
await test('code-semicolon-does-not-truncate-source',()=>{
 const source='如果测试成功，必须运行 `run(A); run(B);`，再保留全部日志。';
 const text=frame('必须运行 `run(A); run(B);`。');
 const r=reconstructDisputedLines({text,userMessages:[{seq:1,text:source}],audit:{lost:[{seq:1,line:'必须运行 `run(a); run(b);`',candidate:'必须运行 `run(a); run(b);`',reason:'condition'}]},language:'en'});
 assert.ok(r);assert.ok(r.text.includes(source));
});
await test('case-ambiguity-fails-closed',()=>assert.equal(reconstructDisputedLines({text:frame('Delete DATA'),userMessages:[{seq:1,text:'Do not delete DATA.\nDo not delete data.'}],audit:{lost:[{seq:1,line:'do not delete data',candidate:'delete data',reason:'polarity'}]},language:'en'}),null));
await test('no-coverage-repair',()=>assert.equal(reconstructDisputedLines({text:frame('irrelevant'),userMessages:[{seq:1,text:'Must keep data'}],audit:{lost:[{seq:1,line:'Must keep data',reason:'coverage'}]},language:'en'}),null));
await test('no-invented-source',()=>assert.equal(reconstructDisputedLines({text:frame('Delete data'),userMessages:[{seq:1,text:'No different instruction'}],audit:{lost:[{seq:1,line:'Do not delete data',candidate:'Delete data',reason:'polarity'}]},language:'en'}),null));
await test('ambiguous-source-not-guessed',()=>assert.equal(reconstructDisputedLines({text:frame('delete data'),userMessages:[{seq:1,text:'Do not delete data unless A.\nDo not delete data unless B.'}],audit:{lost:[{seq:1,line:'do not delete data',candidate:'delete data',reason:'polarity'}]},language:'en'}),null));
await test('many-issues-one-line-repaired',()=>assert.ok(reconstructDisputedLines({text:frame('Delete data'),userMessages:[{seq:1,text:'Do not delete data'}],audit:{lost:Array(9).fill({seq:1,line:'do not delete data',candidate:'Delete data',reason:'polarity'})},language:'en'})));
await test('no-heading-synthesis',()=>assert.equal(reconstructDisputedLines({text:'Done.',userMessages:[],audit:{lost:[{candidate:'Done.'}]},language:'en'}),null));
await test('repeated-conflicts-batched-with-existing-line-budget',()=>{
 const userMessages=[{seq:1,text:'If tests pass, do not deploy package.'}];
 let text=frame(Array.from({length:12},(_,i)=>`Do not deploy package (diagnostic ${i}).`).join('\n'));
 const removed=new Set();let rounds=0;
 for(;rounds<8;rounds++){
  const compiled=materializeUserMessageSection(text,userMessages,'en');
  const audit=auditCompaction({userMessages,summaryText:compiled,checkpointText:compiled,includeAllConflicts:true});
  if(!audit.lost.length)break;
  const rebuilt=reconstructDisputedLines({text,userMessages,audit,language:'en'});assert.ok(rebuilt);
  const hashes=new Set(rebuilt.receipts.flatMap(r=>r.removedLineSha256));assert.ok(hashes.size<=8);
  hashes.forEach(h=>removed.add(h));text=rebuilt.text;
 }
 assert.equal(rounds,2);assert.equal(removed.size,12);assert.ok(removed.size<=16);
 assert.ok(!text.includes('(diagnostic'));
});
await test('unprocessed-conflicts-still-fail-full-audit',()=>{
 const userMessages=[{seq:1,text:'If tests pass, do not deploy package.'}];
 let text=frame(Array.from({length:17},(_,i)=>`Do not deploy package (diagnostic ${i}).`).join('\n'));
 const removed=new Set();
 for(let round=0;round<2;round++){
  const compiled=materializeUserMessageSection(text,userMessages,'en');
  const audit=auditCompaction({userMessages,summaryText:compiled,checkpointText:compiled,includeAllConflicts:true});
  const rebuilt=reconstructDisputedLines({text,userMessages,audit,language:'en'});assert.ok(rebuilt);
  rebuilt.receipts.flatMap(r=>r.removedLineSha256).forEach(h=>removed.add(h));text=rebuilt.text;
 }
 assert.equal(removed.size,16);
 const compiled=materializeUserMessageSection(text,userMessages,'en');
 assert.ok(auditCompaction({userMessages,summaryText:compiled,checkpointText:compiled}).lost.length);
});
await test('conflict-details-do-not-change-audit-verdict',()=>{
 const userMessages=[{seq:1,text:'If tests pass, do not deploy package.'}];
 const summaryText=frame('Deploy package.\nDo not deploy package.');
 const args={userMessages,summaryText,checkpointText:userMessages[0].text+'\n'+summaryText};
 const plain=auditCompaction(args),detailed=auditCompaction({...args,includeAllConflicts:true});
 assert.equal(detailed.lost[0].conflicts.length,2);
 assert.deepEqual({...detailed,lost:detailed.lost.map(({conflicts,...rest})=>rest)},plain);
});
await test('source-case-preserved',()=>{const text=frame('Delete ImportantData');const userMessages=[{seq:1,text:'Do not delete ImportantData'}];const audit=auditCompaction({userMessages,summaryText:text,checkpointText:userMessages[0].text});const r=reconstructDisputedLines({text,userMessages,audit,language:'en'});assert.ok(r.text.includes('Do not delete ImportantData'));assert.ok(!r.text.includes('importantdata'));});
await test('reconstruction-runs-validator-again',async()=>{
 let calls=0,validations=0,rejected=0;const raw=frame('Delete data'),fixed=frame('Do not delete data');
 const result=await summarizeWithChain({ctx:{llm:{async *stream(){calls++;yield {type:'text-delta',index:0,text:raw};yield {type:'finish',reason:{kind:'stop'}};}}},agent:{},input:{messages:[]},chain:{targets:[{provider:'fixture',model:'fixture'}]},options:{retryCount:1,retryDelayMs:0,maxTokens:8192,timeoutMs:5000,language:'en',validate:r=>{validations++;return {ok:r.rawText===fixed,code:'CONSTRAINT_POLARITY_LOST'};},reconstruct:({result})=>({...result,rawText:fixed}),onRejected:()=>{rejected++;}},signal:new AbortController().signal});
 assert.equal(result.rawText,fixed);assert.equal(calls,1);assert.equal(validations,2);assert.equal(rejected,1);
});
await test('failed-reconstruction-never-accepted',async()=>{
 let calls=0,validations=0;await assert.rejects(summarizeWithChain({ctx:{llm:{async *stream(){calls++;yield {type:'text-delta',index:0,text:frame('wrong')};yield {type:'finish',reason:{kind:'stop'}};}}},agent:{},input:{messages:[]},chain:{targets:[{provider:'fixture',model:'fixture'}]},options:{retryCount:1,retryDelayMs:0,maxTokens:8192,timeoutMs:5000,language:'en',validate:()=>{validations++;return {ok:false,code:'CONSTRAINT_POLARITY_LOST'};},reconstruct:({result})=>({...result,rawText:frame('still wrong')})},signal:new AbortController().signal}));assert.equal(calls,2);assert.equal(validations,4);
});

await test('unrelated-sentence-preserved-byte-for-byte',()=>{
 const userMessages=[{seq:1,text:'Do not delete data.'}],suffix=' Useful result: CaseSensitivePath passed 17 tests.';
 const text=frame('Delete data.'+suffix),audit=auditCompaction({userMessages,summaryText:text,checkpointText:userMessages[0].text});
 const rebuilt=reconstructDisputedLines({text,userMessages,audit,language:'en'});assert.ok(rebuilt);assert.ok(rebuilt.text.includes(suffix));assert.ok(!rebuilt.text.includes('Delete data.'));
});
await test('ten-unique-issues-use-two-line-batches',()=>{
 const userMessages=Array.from({length:10},(_,i)=>({seq:i,text:`Do not delete resource${i}.`}));
 let text=frame(userMessages.map(m=>m.text.replace('Do not delete','Delete')).join('\n')),rounds=0;
 for(;rounds<3;rounds++){
  const compiled=materializeUserMessageSection(text,userMessages,'en');const audit=auditCompaction({userMessages,summaryText:compiled,checkpointText:compiled,includeAllConflicts:true});
  if(!audit.lost.length)break;
  if(!rounds)assert.equal(audit.lost.length,10);
  const r=reconstructDisputedLines({text,userMessages,audit,language:'en'});assert.ok(r);assert.ok(new Set(r.receipts.flatMap(x=>x.removedLineSha256)).size<=8);text=r.text;
 }
 assert.equal(rounds,2);
});
await test('multiple-sentences-do-not-drop-safe-prose',()=>{
 const userMessages=[{seq:1,text:'Do not delete A. Do not delete B.'}];const text=frame('Delete A. Test result retained. Delete B. Another result retained.');
 const audit=auditCompaction({userMessages,summaryText:text,checkpointText:userMessages[0].text});const r=reconstructDisputedLines({text,userMessages,audit,language:'en'});assert.ok(r);assert.ok(r.text.includes('Test result retained.'));assert.ok(r.text.includes('Another result retained.'));
});
console.log(JSON.stringify({passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,results},null,2));if(results.some(x=>!x.pass))process.exitCode=1;
