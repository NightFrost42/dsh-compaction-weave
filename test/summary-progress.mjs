import assert from 'node:assert/strict';
import {SummaryProgress} from '../lib/summary-progress.js';
import {SummaryAssembler} from '../lib/meter.js';
import {summarizeWithChain,resolveSummaryTargets} from '../lib/summary.js';
import {buildCompactionInstruction,SUMMARY_TARGET_CHARS} from '../lib/prompt.js';
import {buildSummaryRequest} from '../lib/summary-budget.js';
import {materializeUserMessageSection,validateSummaryStructure,validateUserMessageSection} from '../lib/validate.js';
import {summaryTimeoutInfo,summaryTimeoutText,timeoutInfoFromEnd} from '../lib/summary-timeout.js';

const rows=[];
async function test(name,fn){try{await fn();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.message,stack:e.stack});}}
function timing(){let now=100;const progress=new SummaryProgress(()=>now);const assembler=new SummaryAssembler();return {assembler,progress,at(ms,chunk){now=100+ms;if(chunk!==undefined)progress.observe(assembler.push(chunk));return progress.snapshot();}};}
const text=(value,index=0)=>({type:'text-delta',index,text:value});
const reasoning=value=>({type:'reasoning-delta',index:1,text:value});
const end=(value,index=0)=>({type:'block-end',index,block:{type:'text',text:value}});
const input={messages:[{role:'user',content:[{type:'text',text:'Keep every explicit original request.'}]}]};
function fixture(stream){const calls=[];return {calls,args:{ctx:{llm:{stream(o){calls.push(o);return stream(o);}}},agent:{session:{id:'progress-test'}},input,chain:{targets:[{provider:'shep',model:'deepseek-v4.1-flash',reasoningEffort:'max'},{provider:'unused',model:'fallback'}]},options:{retryCount:0,retryDelayMs:0,maxTokens:32768,timeoutMs:180000,language:'en'}}};}

await test('no-stream-means-no-observable-first-response',()=>{const f=timing(),d=f.at(5000);assert.equal(d.firstChunkMs,null);assert.equal(d.firstProgressMs,null);assert.equal(d.idleMs,5000);assert.equal(d.maxProgressGapMs,null);});
await test('metadata-updates-chunk-time-not-content-time',()=>{const f=timing();f.at(100,{type:'usage',usage:{inputTokens:1}});const d=f.at(200,{type:'finish',kind:'stop'});assert.equal(d.firstChunkMs,100);assert.equal(d.lastChunkMs,200);assert.equal(d.firstProgressMs,null);});
await test('empty-text-deltas-are-not-content-progress',()=>{const f=timing();f.at(500,text(''));const d=f.at(900);assert.equal(d.firstProgressMs,null);assert.equal(d.idleMs,900);});
await test('nonobject-chunks-remain-ignored',()=>{const f=timing();const d=f.at(100,'not a chunk');assert.equal(d.firstChunkMs,null);assert.equal(f.assembler.chunkCount,0);});
await test('first-and-last-body-progress-use-elapsed-monotonic-time',()=>{const f=timing();f.at(300,text('a'));f.at(900,text('b'));const d=f.at(1200);assert.equal(d.firstTextMs,300);assert.equal(d.lastTextMs,900);assert.equal(d.idleMs,300);assert.equal(d.maxProgressGapMs,600);});
await test('reasoning-progress-does-not-pretend-body-progress',()=>{const f=timing();f.at(100,text('body'));const d=f.at(1000,reasoning('hidden'));assert.equal(d.firstProgressMs,100);assert.equal(d.lastProgressMs,1000);assert.equal(d.textIdleMs,900);assert.equal(d.idleMs,0);});
await test('block-end-only-body-is-observable-progress',()=>{const f=timing();const d=f.at(500,end('final'));assert.equal(d.firstTextMs,500);assert.equal(f.assembler.text,'final');});
await test('block-end-only-reasoning-is-observable-progress',()=>{const f=timing();const d=f.at(500,{type:'block-end',index:1,block:{type:'reasoning',text:'hidden'}});assert.equal(d.firstProgressMs,500);assert.equal(d.firstTextMs,null);});
await test('identical-finalization-is-not-new-text',()=>{const f=timing();f.at(100,text('final'));const d=f.at(500,end('final'));assert.equal(d.lastTextMs,100);assert.equal(d.lastChunkMs,500);});
await test('duplicate-finalization-is-not-progress',()=>{const f=timing();f.at(100,end('final'));const d=f.at(500,end('replacement'));assert.equal(d.lastProgressMs,100);assert.equal(f.assembler.text,'final');});
await test('post-finalization-deltas-are-not-progress',()=>{const f=timing();f.at(100,end('final'));const d=f.at(500,text('ignored'));assert.equal(d.lastProgressMs,100);assert.equal(f.assembler.text,'final');});
await test('same-length-final-correction-counts-as-progress',()=>{const f=timing();f.at(100,text('draft'));const d=f.at(500,end('final'));assert.equal(d.lastProgressMs,500);assert.equal(f.assembler.text,'final');});
await test('same-text-at-different-index-is-new-content',()=>{const f=timing();f.at(100,end('same',0));const d=f.at(500,end('same',1));assert.equal(d.lastTextMs,500);assert.equal(f.assembler.text,'same\nsame');});
await test('largest-progress-gap-includes-current-idle-tail',()=>{const f=timing();f.at(100,text('x'));f.at(200,text('y'));assert.equal(f.at(2000).maxProgressGapMs,1800);});
await test('first-output-delay-is-separate-from-inter-output-gap',()=>{const f=timing();f.at(3000,text('x'));const d=f.at(3100);assert.equal(d.firstProgressMs,3000);assert.equal(d.maxProgressGapMs,100);});
await test('successful-result-has-numeric-diagnostics-without-content',async()=>{const f=fixture(async function*(){yield reasoning('SECRET_REASONING');yield text('SECRET_DRAFT');yield {type:'finish',kind:'stop'};});const r=await summarizeWithChain(f.args);assert.equal(r.rawText,'SECRET_DRAFT');assert.equal(r.diagnostics.chunks,3);assert.ok(r.diagnostics.firstTextMs>=0);assert.doesNotMatch(JSON.stringify(r.diagnostics),/SECRET/);assert.equal(f.calls[0].reasoningEffort,'max');assert.equal(f.calls[0].maxTokens,32768);});
await test('active-stream-still-stops-at-fixed-total-deadline',async()=>{
 let returned=0,timer;
 const f=fixture(()=>({[Symbol.asyncIterator](){return {next(){return new Promise(resolve=>{timer=setTimeout(()=>resolve({done:false,value:text('PRIVATE_ACTIVE_DRAFT')}),250);});},return(){clearTimeout(timer);returned++;return Promise.resolve({done:true});}};}}));
 f.args.options.timeoutMs=5000;const started=performance.now();let error;
 try{await summarizeWithChain(f.args);}catch(e){error=e;}
 assert.equal(error?.code,'SUMMARY_TIMEOUT');assert.equal(error.timeoutMs,5000);assert.equal(f.calls.length,1);assert.equal(returned,1);assert.ok(f.calls[0].signal.aborted);
 assert.ok(error.diagnostics.textChars>0);assert.ok(error.diagnostics.textIdleMs<1000);assert.ok(error.diagnostics.firstTextMs>=200);assert.ok(performance.now()-started>=4900&&performance.now()-started<10000);
 assert.doesNotMatch(JSON.stringify(error.diagnostics)+error.message+summaryTimeoutText(error),/PRIVATE/);
 assert.match(summaryTimeoutText(error),/最后正文进展距今/);
 assert.equal(timeoutInfoFromEnd('SUMMARY_TIMEOUT: '+error.message).diagnostics.lastTextMs,error.diagnostics.lastTextMs);
});
await test('legacy-timeout-text-remains-compatible',()=>{assert.equal(summaryTimeoutText({code:'SUMMARY_TIMEOUT',timeoutMs:180000}),'摘要请求超时（180 秒）。本次压缩已停止，未完成区间的原上下文仍保留。请稍后手动执行 /compact 重试。');});
await test('no-response-timeout-survives-info-roundtrip',()=>{const e={code:'SUMMARY_TIMEOUT',timeoutMs:180000,diagnostics:{textChars:0,firstChunkMs:null,firstProgressMs:null,idleMs:180000}};assert.match(summaryTimeoutText(summaryTimeoutInfo(e)),/尚未收到流分片/);});
await test('metadata-only-timeout-does-not-claim-network-silence',()=>{const e={code:'SUMMARY_TIMEOUT',diagnostics:{textChars:0,firstChunkMs:1,firstProgressMs:null,idleMs:180000}};assert.match(summaryTimeoutText(e),/尚无可观测的内容进展/);});
await test('reasoning-only-timeout-does-not-claim-body-output',()=>{const e={code:'SUMMARY_TIMEOUT',diagnostics:{textChars:0,firstChunkMs:1,firstProgressMs:20,idleMs:500}};assert.match(summaryTimeoutText(e),/尚未收到正文，最后可观测内容进展距今 1 秒/);});
await test('old-counts-do-not-fabricate-timing',()=>{const info=timeoutInfoFromEnd('SUMMARY_TIMEOUT: summarization timed out after 180000ms (chunks=12175, textChars=25379, reasoningChars=0)');assert.equal(info.diagnostics,undefined);assert.doesNotMatch(summaryTimeoutText(info),/最后/);});
await test('arbitrary-diagnostic-content-is-never-displayed',()=>{const e={code:'SUMMARY_TIMEOUT',timeoutMs:180000,diagnostics:{firstProgressMs:1,textChars:'SECRET',textIdleMs:2,rawText:'SECRET'}};assert.doesNotMatch(summaryTimeoutText(e),/SECRET/);});
await test('invalid-negative-or-unbounded-timings-are-not-trusted',()=>{const info=summaryTimeoutInfo({code:'SUMMARY_TIMEOUT',diagnostics:{firstProgressMs:1,textChars:20,textIdleMs:-1,lastTextMs:1e20}});assert.equal(info.diagnostics.textIdleMs,undefined);assert.equal(info.diagnostics.lastTextMs,undefined);});
await test('english-target-is-soft-and-retains-engine-owned-originals',()=>{const s=buildCompactionInstruction('en');assert.ok(s.includes(String(SUMMARY_TARGET_CHARS)));assert.match(s,/length target, not permission/);assert.match(s,/engine inserts recent originals/);assert.match(s,/State each fact once/);assert.equal((s.match(/^## [1-9]\./gm)||[]).length,9);});
await test('chinese-target-is-soft-and-retains-engine-owned-originals',()=>{const s=buildCompactionInstruction('zh');assert.ok(s.includes(`${SUMMARY_TARGET_CHARS} 字符`));assert.match(s,/不是遗漏必要事实或削弱约束的许可/);assert.match(s,/不要用生成额度抄写原话/);assert.equal((s.match(/^## [1-9]\./gm)||[]).length,9);});
await test('concise-instruction-does-not-rewrite-the-request-prefix',()=>{const source={messages:[...input.messages,{role:'assistant',content:[{type:'text',text:'Historical evidence.'.repeat(1000)}]}],tools:[{name:'tool'}]};const before=JSON.stringify(source);const r=buildSummaryRequest(source,{language:'en'});assert.deepEqual(r.messages.slice(0,-1),source.messages);assert.equal(JSON.stringify(source),before);assert.equal(r.messages.length,source.messages.length+1);assert.deepEqual(r.tools,source.tools);});
await test('length-target-does-not-add-truncation-or-retry',async()=>{const long='Verified fact. '.repeat(1000);const f=fixture(async function*(){yield text(long);yield {type:'finish',kind:'stop'};});const result=await summarizeWithChain(f.args);assert.equal(result.rawText,long);assert.equal(f.calls.length,1);});
await test('engine-can-fill-originals-longer-than-writing-target',()=>{const titles=buildCompactionInstruction('en').split('\n').filter(x=>/^## [1-9]\./.test(x));const checkpoint=titles.map(h=>h+'\n\n'+(h.startsWith('## 6.')?'[filled by engine]':'(none)')).join('\n\n');const originals=[{seq:7,text:'Keep this original exact. '.repeat(500)}];const final=materializeUserMessageSection(checkpoint,originals,'en');assert.ok(final.length>SUMMARY_TARGET_CHARS);assert.ok(final.includes(originals[0].text));const s=validateSummaryStructure(final,{language:'en'});assert.ok(s.ok);assert.ok(validateUserMessageSection(s.userSectionBody,originals).ok);});

const configuredRoute={summarizationProvider:'shep',summarizationModel:'deepseek-v4.1-flash'};
const route={provider:'shep',model:'deepseek-v4.1-flash'};
await test('configured-same-route-preserves-MAX-in-actual-call',async()=>{
 const f=fixture(async function*(){yield text('Complete.');});
 f.args.agent={session:{id:'route-test',requestHeader:()=>({config:{...route,reasoningEffort:'max'}})}};
 f.args.chain=resolveSummaryTargets({config:configuredRoute,agent:f.args.agent});
 assert.equal(f.args.chain.targets.length,1);assert.equal(f.args.chain.source,'config');
 await summarizeWithChain(f.args);assert.equal(f.calls.length,1);assert.equal(f.calls[0].reasoningEffort,'max');
});
await test('configured-route-can-inherit-agent-controls-without-header',()=>{
 const chain=resolveSummaryTargets({config:configuredRoute,agent:{options:{...route,reasoningEffort:'max'}}});
 assert.equal(chain.targets.length,1);assert.equal(chain.targets[0].reasoningEffort,'max');
});
await test('durable-same-route-controls-win-over-agent-defaults',()=>{
 const chain=resolveSummaryTargets({config:configuredRoute,agent:{options:{...route,reasoningEffort:'low',temperature:0.7},session:{requestHeader:()=>({config:{...route,reasoningEffort:'max',temperature:0.2}})}}});
 assert.equal(chain.targets[0].reasoningEffort,'max');assert.equal(chain.targets[0].temperature,0.2);
});
await test('different-provider-never-transfers-controls-to-configured-route',()=>{
 const chain=resolveSummaryTargets({config:configuredRoute,agent:{options:{provider:'other',model:route.model,reasoningEffort:'max'}}});
 assert.equal(chain.targets[0].reasoningEffort,undefined);assert.equal(chain.targets.length,2);
});
await test('different-model-never-transfers-controls-to-configured-route',()=>{
 const chain=resolveSummaryTargets({config:configuredRoute,agent:{session:{requestHeader:()=>({config:{provider:'shep',model:'other',reasoningEffort:'max'}})}}});
 assert.equal(chain.targets[0].reasoningEffort,undefined);assert.equal(chain.targets.length,2);
});
await test('hot-microtask-stream-cannot-starve-total-deadline',async()=>{
 let returned=0;
 const f=fixture(()=>({[Symbol.asyncIterator](){return {next(){const until=performance.now()+2;while(performance.now()<until){}return Promise.resolve({done:false,value:{type:'usage',usage:{inputTokens:1}}});},return(){returned++;return Promise.resolve({done:true});}};}}));
 f.args.options.timeoutMs=5000;const started=performance.now();let error;
 try{await summarizeWithChain(f.args);}catch(e){error=e;}
 const elapsed=performance.now()-started;
 assert.equal(error?.code,'SUMMARY_TIMEOUT');assert.equal(returned,1);assert.equal(f.calls.length,1);assert.ok(f.calls[0].signal.aborted);
 assert.ok(elapsed>=4900&&elapsed<10000,`hot stream deadline elapsed ${elapsed}ms`);assert.equal(error.diagnostics.textChars,0);
});

console.log(JSON.stringify({passed:rows.filter(r=>r.pass).length,failed:rows.filter(r=>!r.pass).length,results:rows},null,2));
if(rows.some(r=>!r.pass))process.exitCode=1;
