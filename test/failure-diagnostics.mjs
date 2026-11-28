import assert from 'node:assert/strict';import {existsSync} from 'node:fs';import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';
import {FailureDiagnostics,diagnosticFor,diagnosticText,failureExplanation,diagnosticContext,noteDiagnosticMeasurement,sanitizeWindowLookupFailure} from '../lib/failure-diagnostics.js';import {summarizeWithChain} from '../lib/summary.js';import {dumpAuditRejection} from '../lib/audit-reject.js';import {decorateCompactCommand} from '../lib/command-compact.js';import {resolveSummaryCapacity,assertSummaryCapacity} from '../lib/summary-budget.js';import {resolveConfig} from '../lib/config.js';import {buildCompactionInstruction} from '../lib/prompt.js';import {WeaveCompactionEngine} from '../lib/engine.js';
const results=[];async function test(name,fn){try{await fn();results.push({name,pass:true});}catch(error){results.push({name,pass:false,error:error.message,stack:error.stack});}}
const root=await mkdtemp(join(tmpdir(),'weave-failure-reports-'));
const err=(code,extras={})=>Object.assign(new Error('PRIVATE_TRANSCRIPT sk-'+'x'.repeat(30)),{code,...extras});
const session={id:'private-session-identity'};
async function rejected(p){try{await p;}catch(e){return e;}assert.fail('expected failure');}
function args(response,extra={}){let calls=0;return {ctx:{llm:{async *stream(){const text=response(++calls);if(text instanceof Error)throw text;yield {type:'text-delta',text};yield {type:'finish',kind:'stop'};}}},agent:{session},input:{messages:[]},chain:{targets:[{provider:'local',model:'fixture'}]},options:{maxTokens:1000,timeoutMs:5000,retryDelayMs:0,...extra}};}
await test('terminal-report-contains-each-attempt-no-transcript-or-credentials',async()=>{
 const d=new FailureDiagnostics(join(root,'terminal'));const e=await rejected(d.run(session,{trigger:'manual',commandId:'cmd'},()=>summarizeWithChain(args(()=>err('ECONNRESET')))));
 const r=diagnosticFor(e),text=await readFile(r.path,'utf8'),log=JSON.parse(text);assert.equal(r.status,'saved');assert.equal(log.totalAttempts,3);assert.equal(log.attempts.filter(a=>a.requestStarted).length,3);assert.ok(log.attempts.every(a=>a.outcome==='failed'&&!a.usageKnown));assert.equal(log.errors[0].code,'SUMMARY_ALL_FAILED');assert.doesNotMatch(text,/PRIVATE_TRANSCRIPT|sk-xxx|private-session-identity/);assert.equal(d.forCommand(session,'cmd'),r);assert.equal(d.forCommand(session,'other'),null);assert.match(diagnosticText(e),/诊断编号.*诊断日志/s);
});
await test('successful-retry-retains-attempt-trace-without-failure-outcome',async()=>{const d=new FailureDiagnostics(join(root,'recovered'));const r=await d.run(session,{trigger:'automatic'},()=>summarizeWithChain(args(n=>n===1?err('ECONNRESET'):'accepted')));assert.equal(r.rawText,'accepted');const files=await readdir(d.root);const log=JSON.parse(await readFile(join(d.root,files[0]),'utf8'));assert.equal(log.outcome,'recovered');assert.deepEqual(log.attempts.map(x=>x.outcome),['failed','accepted']);});
await test('diagnostic-disk-failure-is-explicit-and-preserves-original-error',async()=>{const bad=join(root,'not-directory');await writeFile(bad,'x');const d=new FailureDiagnostics(bad),original=err('ECONNRESET');const e=await rejected(d.run(session,{trigger:'manual',commandId:'disk'},()=>{throw original;}));assert.equal(e,original);const r=diagnosticFor(e);assert.equal(r.status,'failed');assert.match(diagnosticText(e),/诊断日志保存失败/);assert.match(diagnosticText(e),/ECONNRESET/);assert.ok(!r.path);});
await test('audit-rejection-file-is-linked-and-ready-before-notification',async()=>{const dir=join(root,'audit');const d=new FailureDiagnostics(dir);const e=await rejected(d.run(session,{trigger:'manual'},()=>summarizeWithChain(args(()=> 'bad',{retryCount:0,validate:()=>({ok:false,code:'CONSTRAINT_LOST'}),onRejected:()=>dumpAuditRejection({storageRoot:dir,sessionId:session.id,compactionId:'test',modelRawText:'LOCAL_SOURCE'})}))));const log=JSON.parse(await readFile(diagnosticFor(e).path,'utf8'));assert.equal(log.auditReports.length,1);assert.equal(log.auditReports[0].saved,true);assert.match(await readFile(log.auditReports[0].path,'utf8'),/LOCAL_SOURCE/);});
await test('audit-write-failure-is-mentioned-in-main-notice',async()=>{const dir=join(root,'audit-disk');const d=new FailureDiagnostics(dir);await writeFile(join(root,'audit-blocker'),'x');const e=await rejected(d.run(session,{trigger:'manual'},()=>summarizeWithChain(args(()=> 'bad',{retryCount:0,validate:()=>({ok:false,code:'CONSTRAINT_LOST'}),onRejected:()=>dumpAuditRejection({storageRoot:join(root,'audit-blocker'),sessionId:session.id,compactionId:'test'})}))));assert.match(diagnosticText(e),/详细审计记录保存失败/);assert.equal(diagnosticFor(e).auditWriteFailures,1);});
await test('nested-operations-produce-one-file',async()=>{const d=new FailureDiagnostics(join(root,'nested')),original=err('ENOSPC');const e=await rejected(d.run(session,{trigger:'manual',commandId:'a'},()=>d.run(session,{trigger:'region'},()=>{throw original;})));assert.equal((await readdir(d.root)).length,1);assert.equal(d.forCommand(session,'a'),diagnosticFor(e));});
await test('concurrent-sessions-do-not-mix-attempts',async()=>{const d=new FailureDiagnostics(join(root,'concurrent'));const es=await Promise.all([1,2].map(i=>{const s={id:'session-'+i},a=args(()=>err(i===1?'ECONNRESET':'EPIPE'),{retryCount:i});a.agent.session=s;return rejected(d.run(s,{trigger:'manual',commandId:'same'},()=>summarizeWithChain(a)));}));const logs=await Promise.all(es.map(e=>readFile(diagnosticFor(e).path,'utf8').then(JSON.parse)));assert.deepEqual(logs.map(x=>x.totalAttempts),[2,3]);assert.notEqual(logs[0].sessionHash,logs[1].sessionHash);});
await test('no-report-for-user-cancellation',async()=>{const d=new FailureDiagnostics(join(root,'cancel')),reason=err('ABORTED');await rejected(d.run(session,{trigger:'manual',commandId:'cancel',signal:AbortSignal.abort(reason)},()=>{throw reason;}));assert.equal(diagnosticFor(reason),null);assert.equal(d.forCommand(session,'cancel'),null);});
await test('retention-does-not-delete-foreign-files',async()=>{const d=new FailureDiagnostics(join(root,'retention'));await d.capture(session,err('ERROR'));await writeFile(join(d.root,'user-note.json'),'retain');for(let i=0;i<44;i++)await d.capture(session,err('ERROR'));const files=await readdir(d.root);assert.equal(files.length,41);assert.equal(await readFile(join(d.root,'user-note.json'),'utf8'),'retain');});
await test('manual-command-gets-only-its-own-diagnostic-and-preserves-success',async()=>{const d=new FailureDiagnostics(join(root,'command'));await rejected(d.run(session,{trigger:'manual',commandId:'current'},()=>{throw err('ENOSPC');}));const stock={kind:'error',text:'generic'},compaction={failureForCommand:(s,id)=>d.forCommand(s,id)};const cmd=decorateCompactCommand({name:'compact',handler:async()=>stock},compaction);const invocation={agent:{session},commandId:'current',signal:new AbortController().signal};assert.match((await cmd.handler(invocation)).text,/诊断编号/);assert.equal(await cmd.handler({...invocation,commandId:'old'}),stock);const ok={kind:'success',text:'ok'};assert.equal(await decorateCompactCommand({name:'compact',handler:async()=>ok},compaction).handler(invocation),ok);});
await test('commit-failure-does-not-claim-entire-original-unchanged',()=>{const text=failureExplanation(err('commit',{compactionStage:'commit'}));assert.match(text,/部分步骤可能已完成/);assert.doesNotMatch(text,/原始会话保留|原上下文仍保留/);});
await test('reported-route-and-timing-are-bounded-metadata',async()=>{const d=new FailureDiagnostics(join(root,'timing'));const e=await rejected(d.run(session,{trigger:'manual'},()=>summarizeWithChain(args(()=>err('SUMMARY_TIMEOUT',{timeoutMs:5000,diagnostics:{textChars:42,firstProgressMs:10,raw:'SECRET'}}),{retryCount:0}))));const log=await readFile(diagnosticFor(e).path,'utf8');assert.doesNotMatch(log,/SECRET/);assert.match(log,/textChars/);});
await test('slow-diagnostic-writer-cannot-block-error-presentation',async()=>{const d=new FailureDiagnostics(join(root,'slow'),{timeoutMs:25});d._write=()=>new Promise(()=>{});const original=err('ENOSPC'),start=performance.now();const e=await rejected(d.run(session,{trigger:'manual',commandId:'slow'},()=>{throw original;}));assert.equal(e,original);assert.ok(performance.now()-start<1000);assert.match(diagnosticText(e),/DIAGNOSTIC_TIMEOUT/);});
await test('handled-failure-is-never-mislabeled-as-recovered',async()=>{const d=new FailureDiagnostics(join(root,'handled'));await d.run(session,{trigger:'proactive'},async()=>{try{await summarizeWithChain(args(()=>err('ECONNRESET'),{retryCount:0}));}catch(error){await d.capture(session,error);return {status:'failed'};}});const files=await readdir(d.root);assert.equal(files.length,1);assert.equal(JSON.parse(await readFile(join(d.root,files[0]),'utf8')).outcome,'failed');});
await test('host-error-class-fallback-still-displays-own-command-diagnostic',async()=>{const d=new FailureDiagnostics(join(root,'host-fallback'));await rejected(d.run(session,{trigger:'manual',commandId:'fallback'},()=>{throw err('ENOSPC');}));const command=decorateCompactCommand({name:'compact',handler:async()=>{throw new Error('Host class unavailable');}},{failureForCommand:(s,id)=>d.forCommand(s,id)});const r=await command.handler({agent:{session},commandId:'fallback',signal:new AbortController().signal});assert.equal(r.kind,'error');assert.match(r.text,/诊断编号/);assert.doesNotMatch(r.text,/Host class unavailable/);});
await test('provider-timeout-explains-root-cause-after-retry-exhaustion',async()=>{const d=new FailureDiagnostics(join(root,'provider-timeout'));const e=await rejected(d.run(session,{trigger:'manual'},()=>summarizeWithChain(args(()=>err('TIMEOUT')))));assert.match(failureExplanation(e),/摘要服务连接或响应超时/);const report=JSON.parse(await readFile(diagnosticFor(e).path,'utf8'));assert.equal(report.totalAttempts,3);assert.match(diagnosticText(e),/诊断日志/);});
await test('provider-transport-error-explanation-does-not-hide-auth-rejection',()=>{assert.match(failureExplanation(err('TRANSPORT')),/连接或响应流中断/);assert.match(failureExplanation(err('TRANSPORT',{status:401})),/拒绝访问/);});
await test('support-context-includes-effective-settings-without-private-header-or-config',async()=>{
 const privateValue='DO_NOT_SHARE_PERSONAL_TEXT';const agent={session:{requestHeader:()=>({config:{provider:'gateway',model:'chat-model',apiKey:privateValue,messages:[privateValue]}})},options:{provider:'fallback',model:'fallback-model',cwd:privateValue}};
 const context=diagnosticContext(agent,{summarizationProvider:'summary-gateway',summarizationModel:'summary-model',maxTokens:8192,thresholdRatio:.8,summaryRetryCount:2,archiveDir:privateValue,apiKey:privateValue,language:'zh',auto:true});
 assert.deepEqual(context.conversation,{provider:'gateway',model:'chat-model'});assert.equal(context.summary.model,'summary-model');assert.equal(context.summary.selection,'configured');assert.equal(context.settings.thresholdRatio,.8);assert.equal(context.environment.nodeVersion,process.version);assert.equal(context.environment.actualDshVersion,null);assert.equal(context.environment.supportedDshVersion,'>=0.2.2-rc.1 <1.0.0-0');assert.doesNotMatch(JSON.stringify(context),/DO_NOT_SHARE|apiKey|messages|archiveDir|cwd/);
 const d=new FailureDiagnostics(join(root,'context'));const e=await rejected(d.run(session,{trigger:'manual',reportContext:context},()=>{throw err('ENOSPC');}));const log=JSON.parse(await readFile(diagnosticFor(e).path,'utf8'));assert.deepEqual(log.context,context);assert.equal(log.sharing.optional,true);assert.equal(log.sharing.automaticRedactionGuaranteed,false);
});
await test('host-header-unavailable-and-private-routes-do-not-break-reporting',()=>{
 const context=diagnosticContext({session:{requestHeader:()=>{throw Error('private host failure');}},options:{provider:'sk-'+'x'.repeat(30),model:'C:\\private\\model'}},{summarizationProvider:'provider',summarizationModel:'model',language:'secret',maxTokens:NaN,archiveEnabled:false});assert.equal(context.conversation.provider,null);assert.equal(context.conversation.model,null);assert.equal(context.summary.selection,'configured');assert.deepEqual(context.settings,{archiveEnabled:false});
});
await test('arbitrary-context-fields-cannot-bypass-the-diagnostic-allowlist',async()=>{
 const d=new FailureDiagnostics(join(root,'context-allowlist'));const reportContext={environment:{nodeVersion:'PRIVATE_TEXT',messages:'PRIVATE_TEXT'},conversation:{provider:'route',model:'model',apiKey:'PRIVATE_TEXT'},summary:{provider:'route',model:'summary',selection:'configured',prompt:'PRIVATE_TEXT'},settings:{maxTokens:8192,password:'PRIVATE_TEXT',archiveDir:'PRIVATE_TEXT'},transcript:'PRIVATE_TEXT'};
 const e=await rejected(d.run(session,{trigger:'manual',reportContext},()=>{throw err('ENOSPC');}));const text=await readFile(diagnosticFor(e).path,'utf8');assert.doesNotMatch(text,/PRIVATE_TEXT|password|archiveDir|transcript/);const log=JSON.parse(text);assert.equal(log.context.environment.nodeVersion,process.version);assert.equal(log.context.settings.maxTokens,8192);assert.equal(log.context.summary.model,'summary');
});
await test('support-measurements-store-numbers-and-precision-without-source-messages',async()=>{
 const d=new FailureDiagnostics(join(root,'measurements'));const e=await rejected(d.run(session,{trigger:'pressure'},()=>{noteDiagnosticMeasurement({totalTokens:170000,precision:'heuristic',nodes:[{text:'PRIVATE_MESSAGE'}]},{thresholdTokens:158808,targetTokens:136000});noteDiagnosticMeasurement({totalTokens:120000,precision:'mixed',nodes:[1,2]},{stage:'after'});throw err('COMPACTION_FAILED');}));const text=await readFile(diagnosticFor(e).path,'utf8');const log=JSON.parse(text);assert.equal(log.measurements.before.estimatedInputTokens,170000);assert.equal(log.measurements.before.targetTokens,136000);assert.equal(log.measurements.after.estimatedInputTokens,120000);assert.equal(log.measurements.after.precision,'mixed');assert.doesNotMatch(text,/PRIVATE_MESSAGE/);
});
await test('content-rejections-and-network-failures-remain-distinct-in-usage-trace',async()=>{
 const d=new FailureDiagnostics(join(root,'failure-kinds'));let attempted=0;const a=args(()=> 'bad',{retryCount:1,validate:()=>({ok:false,code:'CONSTRAINT_LOST'})});a.ctx.llm.stream=async function*(){if(++attempted===1)throw err('ECONNRESET');yield {type:'text-delta',text:'bad'};yield {type:'usage',usage:{inputTokens:30,outputTokens:10,totalTokens:40}};yield {type:'finish',kind:'stop'};};
 const e=await rejected(d.run(session,{trigger:'manual'},()=>summarizeWithChain(a)));const log=JSON.parse(await readFile(diagnosticFor(e).path,'utf8'));assert.deepEqual(log.attempts.map(x=>x.failureKind),['request','content-validation']);assert.equal(log.attempts[0].usageKnown,false);assert.equal(log.attempts[1].usage.outputTokens,10);assert.deepEqual(log.attempts.map(x=>x.retryDelayMs),[0,0]);
});
await test('zero-failure-accepted-reconstruction-does-not-write-recovered-diagnostic',async()=>{
 const dir=join(root,'reconstruction');const d=new FailureDiagnostics(dir);let dumpPromise=null;const result=await d.run(session,{trigger:'manual'},()=>summarizeWithChain(args(()=> 'bad',{retryCount:0,validate:r=>({ok:r.rawText==='repaired',code:'CONSTRAINT_LOST'}),reconstruct:({result})=>({...result,rawText:'repaired'}),onRejected:()=> (dumpPromise=dumpAuditRejection({storageRoot:dir,sessionId:session.id,compactionId:'reconstruction',modelRawText:'bad'}))})));
 assert.equal(result.rawText,'repaired');
 const files=existsSync(d.root)?await readdir(d.root):[];
 assert.equal(files.length,0,'single-attempt accepted-after-reconstruction with zero failed attempts must not emit recovered diagnostic');
 const auditPath=await dumpPromise;
 assert.ok(auditPath,'audit-reject artifact can still be persisted asynchronously');
 assert.match(diagnosticText({id:'test',status:'saved',attempts:1,path:'local'}),/提交日志是可选/);
 assert.match(diagnosticText({id:'test',status:'saved',attempts:1,path:'local'}),/AI 脱敏也可能遗漏隐私/);
});
await test('multi-attempt-failure-before-reconstruction-retains-recovered-diagnostic-and-linked-audit',async()=>{
 const dir=join(root,'reconstruction-after-failure');const d=new FailureDiagnostics(dir);
 let attempt=0;
 const result=await d.run(session,{trigger:'manual'},()=>summarizeWithChain(args(()=>{
  attempt++;
  if(attempt===1)throw err('ECONNRESET');
  return 'bad';
 },{
  retryCount:1,
  validate:r=>({ok:r.rawText==='repaired',code:'CONSTRAINT_LOST'}),
  reconstruct:({result})=>({...result,rawText:'repaired'}),
  onRejected:()=>dumpAuditRejection({storageRoot:dir,sessionId:session.id,compactionId:'reconstruction-after-failure',modelRawText:'bad'}),
 })));
 assert.equal(result.rawText,'repaired');
 const files=await readdir(d.root);
 assert.equal(files.length,1);
 const log=JSON.parse(await readFile(join(d.root,files[0]),'utf8'));
 assert.equal(log.outcome,'recovered');
 assert.deepEqual(log.attempts.map(x=>x.outcome),['failed','accepted-after-reconstruction']);
 assert.equal(log.auditReports[0].saved,true);
});
await test('window-lookup-failure-is-recorded-sanitized-and-surfaced-on-local-capacity-rejection',async()=>{
 const cfg=resolveConfig({}).config;
 const capMissing=await resolveSummaryCapacity({llm:{}},{targets:[{provider:'local',model:'fixture'}]},cfg);
 assert.equal(capMissing.targets[0].source,'configured-fallback');
 assert.equal(capMissing.targets[0].window,200000);
 assert.equal(capMissing.windowLookupFailure?.reason,'missing-resolver');
 assert.equal(capMissing.windowLookupFailure?.code,null);
 assert.equal(capMissing.windowLookupFailure?.fallbackWindow,200000);
 assert.equal(capMissing.windowLookupFailure?.usedFallback,true);

 const boom=Object.assign(new Error('PRIVATE_LOOKUP_TOKEN failed lookup'),{code:'EHOSTDOWN'});
 const capErr=await resolveSummaryCapacity({llm:{resolveModelInfo:async()=>{throw boom;}}},{targets:[{provider:'local',model:'fixture'}]},cfg);
 assert.equal(capErr.windowLookupFailure?.reason,'lookup-error');
 assert.equal(capErr.windowLookupFailure?.code,'EHOSTDOWN');
 assert.equal(capErr.windowLookupFailure?.name,'Error');
 assert.equal(capErr.windowLookupFailure?.usedFallback,true);
 assert.doesNotMatch(JSON.stringify(capErr.windowLookupFailure),/PRIVATE_LOOKUP_TOKEN/);

 const capTimeout=await resolveSummaryCapacity({llm:{resolveModelInfo:()=>new Promise(()=>{})}},{targets:[{provider:'local',model:'fixture'}]},{...cfg,summaryTimeoutMs:20});
 assert.equal(capTimeout.windowLookupFailure?.reason,'lookup-error');
 assert.equal(capTimeout.windowLookupFailure?.code,'RESOLVE_MODEL_INFO_TIMEOUT');
 assert.equal(capTimeout.windowLookupFailure?.usedFallback,true);

 const capMapped=await resolveSummaryCapacity({llm:{}},{targets:[{provider:'local',model:'fixture'}]},resolveConfig({windowProviderMap:{'local/fixture':128000}}).config);
 assert.equal(capMapped.targets[0].window,128000);
 assert.equal(capMapped.windowLookupFailure?.usedFallback,false);

 const d=new FailureDiagnostics(join(root,'window-lookup-cap'));
 const e=await rejected(d.run(session,{trigger:'manual',reportContext:diagnosticContext({session,options:{provider:'local',model:'fixture'}},cfg)},async()=>{
  const cap=await resolveSummaryCapacity({llm:{resolveModelInfo:async()=>{throw boom;}}},{targets:[{provider:'local',model:'fixture'}]},cfg);
  assertSummaryCapacity({inputUnits:1000000,inputBytes:1000000,inputTokens:300000},cap,{provider:'local',model:'fixture'});
 }));
 assert.equal(e.code,'CONTEXT_WINDOW_EXCEEDED');
 assert.equal(e.localCapacityRejection,true);
 assert.equal(e.windowLookupFailure?.code,'EHOSTDOWN');
 const diagTextRaw=await readFile(diagnosticFor(e).path,'utf8');
 assert.doesNotMatch(diagTextRaw,/PRIVATE_LOOKUP_TOKEN/);
 const log=JSON.parse(diagTextRaw);
 assert.equal(log.context.windowLookupFailure?.reason,'lookup-error');
 assert.equal(log.context.windowLookupFailure?.code,'EHOSTDOWN');
 assert.equal(log.context.windowLookupFailure?.fallbackWindow,200000);
 assert.equal(log.errors[0].localCapacityRejection,true);
 assert.equal(log.errors[0].windowLookupFailure?.code,'EHOSTDOWN');
 const explanation=diagnosticFor(e).explanation;
 assert.match(explanation,/localCapacityRejection/);
 assert.match(explanation,/EHOSTDOWN/);
 assert.match(explanation,/windowFallback=200000/);
 assert.match(failureExplanation(Object.assign(new Error('local rejection'),{code:'CONTEXT_WINDOW_EXCEEDED',localCapacityRejection:true,windowLookupFailure:capMissing.windowLookupFailure})),/missing-resolver/);
});
await test('engine-resolveSpec-tracks-and-clears-windowLookupFailure-in-diagnosticContext',async()=>{
 const engineDir=join(root,'engine-wlf');
 const makeEngine=(resolveModelInfo)=>new WeaveCompactionEngine(
  {on(){},provide(){},logger:{info(){},warn(){}},llm:{...(resolveModelInfo?{resolveModelInfo}:{})}},
  resolveConfig({archiveDir:join(engineDir,'archive-'+Math.random().toString(36).slice(2))}).config,
 );
 const s1={id:'wlf-missing',surface:{nodes:[0],replaceGeneration:0},requestHeader:()=>({})};
 const e1=makeEngine(null);
 const spec1=await e1._resolveSpec({session:s1,options:{provider:'p',model:'m'}},null,new AbortController().signal);
 assert.equal(spec1.windowLookupFailure?.reason,'missing-resolver');
 assert.equal(spec1.windowLookupFailure?.usedFallback,true);
 assert.equal(e1._diagnosticContext({session:s1,options:{provider:'p',model:'m'}}).windowLookupFailure?.reason,'missing-resolver');

 const s2={id:'wlf-err',surface:{nodes:[0],replaceGeneration:0},requestHeader:()=>({})};
 const e2=makeEngine(async()=>{throw Object.assign(new Error('bad metadata'),{code:'ENOTFOUND'});});
 const spec2=await e2._resolveSpec({session:s2,options:{provider:'p',model:'m'}},null,new AbortController().signal);
 assert.equal(spec2.windowLookupFailure?.reason,'lookup-error');
 assert.equal(spec2.windowLookupFailure?.code,'ENOTFOUND');
 assert.equal(e2._diagnosticContext({session:s2,options:{provider:'p',model:'m'}}).windowLookupFailure?.code,'ENOTFOUND');

 const e3=makeEngine(async()=>({contextWindow:256000}));
 const s3={id:'wlf-ok',surface:{nodes:[0],replaceGeneration:0},requestHeader:()=>({})};
 e3._lastWindowLookupFailure=new WeakMap([[s3,spec2.windowLookupFailure]]);
 const spec3=await e3._resolveSpec({session:s3,options:{provider:'p',model:'m'}},null,new AbortController().signal);
 assert.equal(spec3.windowLookupFailure,undefined);
 assert.equal(e3._diagnosticContext({session:s3,options:{provider:'p',model:'m'}}).windowLookupFailure,undefined);
});
await test('provenance-untrusted-and-revoked-guidance-qualifies-external-bridge-config',()=>{
 for(const provenanceKind of['untrusted-source','revoked']){
  const text=failureExplanation(err('CONSTRAINT_LOST',{constraintReason:'provenance',provenanceKind,provenanceLine:'用户已同意改为每晚发两条评论。'}));
  assert.match(text,/仅当 audit-reject 显示命中源确实属于第三方外部桥接通道/);
  assert.match(text,/普通主对话用户请勿盲目填写/);
  assert.match(text,/extraReferenceSourceKinds/);
  assert.match(text,/extraReferencePrefixes/);
 }
});
await test('extractPluginStackFrame-captures-lib-subdirectory-frames-and-filters-external-paths',async()=>{
 const d=new FailureDiagnostics(join(root,'subdir-frames'));
 const makeStackErr=(frameLine)=>Object.assign(new Error('opaque failure'),{stack:`Error: opaque failure\n    at evalAudit (${frameLine})`});
 const eHit=await rejected(d.run(session,{trigger:'manual'},()=>{throw makeStackErr('/mirror-checkout/lib/audit/compaction.js:42:7');}));
 const logHit=JSON.parse(await readFile(diagnosticFor(eHit).path,'utf8'));
 assert.equal(logHit.errors[0].pluginFrame,'lib/audit/compaction.js:42:7');

 for(const extFrame of ['/mirror/node_modules/other/lib/audit/compaction.js:12:3','/mirror/lib/nonexistent/foo.js:9:1']){
  const eExt=await rejected(d.run(session,{trigger:'manual'},()=>{throw makeStackErr(extFrame);}));
  const logExt=JSON.parse(await readFile(diagnosticFor(eExt).path,'utf8'));
  assert.equal(logExt.errors[0].pluginFrame,undefined,`external/unknown frame must be omitted: ${extFrame}`);
 }
});
await test('sanitizeWindowLookupFailure-allowlists-codes-and-blocks-secret-prefixes',async()=>{
 for(const code of ['UNKNOWN_MODEL','RESOLVE_MODEL_INFO_TIMEOUT','TIMEOUT','ABORTED','NO_ADAPTER','CORDIS_CONTEXT_ERROR','ETIMEDOUT','ENOTFOUND','EHOSTDOWN']){
  const sanitized=sanitizeWindowLookupFailure({reason:'lookup-error',code,name:'TimeoutError',provider:'p',model:'m',fallbackWindow:200000,source:'summary-capacity',usedFallback:true});
  assert.equal(sanitized?.code,code);
  assert.equal(sanitized?.name,'TimeoutError');
 }
 const lower=sanitizeWindowLookupFailure({reason:'lookup-error',code:'timeout',name:'Error'});
 assert.equal(lower?.code,'TIMEOUT');
 assert.equal(lower?.name,'Error');

 const custom=sanitizeWindowLookupFailure({reason:'lookup-error',code:'VENDOR_INTERNAL_CODE_99',name:'ThirdPartySecretError'});
 assert.equal(custom?.code,'OTHER');
 assert.equal(custom?.name,null);

 const secretSk='sk'+'-'+'live_secret1234567890abcdef';
 const secretGhp='ghp'+'_'+'1234567890abcdef123456';
 const secretBearer='Bearer'+' '+'topSecretToken123456';
 const secretPem=['-----','BEGIN PRIVATE KEY','-----'].join('');
 for(const leaked of [secretSk,secretGhp,secretBearer,secretPem,'prefix_'+secretSk]){
  const fromCode=sanitizeWindowLookupFailure({reason:'lookup-error',code:leaked,name:leaked,provider:'p',model:'m'});
  assert.equal(fromCode?.code,'UNKNOWN',`secret code must collapse: ${leaked}`);
  assert.equal(fromCode?.name,null,`secret name must collapse: ${leaked}`);
 }

 const cfg=resolveConfig({windowFallback:200000}).config;
 const dirtyErr=Object.assign(new Error('lookup failed'),{code:secretSk,name:'VendorCustomFailure'});
 const cap=await resolveSummaryCapacity({llm:{resolveModelInfo:async()=>{throw dirtyErr;}}},{targets:[{provider:'local',model:'fixture'}]},cfg);
 assert.equal(cap.windowLookupFailure?.code,'UNKNOWN');
 assert.equal(cap.windowLookupFailure?.name,null);

 const d=new FailureDiagnostics(join(root,'wlf-allowlist-diag'));
 const e=await rejected(d.run(session,{trigger:'manual',reportContext:diagnosticContext({session,options:{provider:'local',model:'fixture'}},cfg)},()=>{
  assertSummaryCapacity({inputUnits:1000000,inputBytes:1000000,inputTokens:300000},cap,{provider:'local',model:'fixture'});
 }));
 const raw=await readFile(diagnosticFor(e).path,'utf8');
 assert.equal(raw.includes(secretSk),false);
 assert.equal(raw.includes('VendorCustomFailure'),false);
 const parsed=JSON.parse(raw);
 assert.equal(parsed.context.windowLookupFailure?.code,'UNKNOWN');
 assert.equal(parsed.context.windowLookupFailure?.name,null);
 assert.equal(parsed.errors[0].windowLookupFailure?.code,'UNKNOWN');
 assert.match(diagnosticFor(e).explanation,/code=UNKNOWN/);
 assert.equal(diagnosticFor(e).explanation.includes('VendorCustomFailure'),false);
});
await test('issue25-COMPACTION_CAPACITY_BLOCKED-explanation-and-root-cause-precedence',()=>{
  const pureTarget=failureExplanation(err('COMPACTION_CAPACITY_BLOCKED',{
    capacityReason:'reduction-target-not-met',
    measuredTokens:142000,
    targetTokens:120000,
    messageBudgetTokens:191808,
    thresholdTokens:158808,
    retainTokens:30689,
    retainedTailTokens:45000,
    minimumReductionRatio:0.2,
    committedChunks:1,
  }));
  assert.match(pureTarget,/COMPACTION_CAPACITY_BLOCKED/);
  assert.match(pureTarget,/142000 tokens/);
  assert.match(pureTarget,/120000 tokens/);
  assert.match(pureTarget,/45000 tokens/);
  assert.match(pureTarget,/30689 tokens/);
  assert.match(pureTarget,/最小压缩幅度 20%/);
  assert.match(pureTarget,/\/compact/);
  assert.match(pureTarget,/retainRatio \/ retainTokens/);
  assert.match(pureTarget,/minimumReductionRatio/);
  assert.match(pureTarget,/新会话/);
  assert.doesNotMatch(pureTarget,/preserveRecentMessages/);

  const wrappedAuto=failureExplanation(err('COMPACTION_AUTOMATIC_BLOCKED',{
    failureCode:'COMPACTION_CAPACITY_BLOCKED',
    cause:err('COMPACTION_CAPACITY_BLOCKED',{
      capacityReason:'over-message-budget',
      measuredTokens:195000,
      targetTokens:150000,
      messageBudgetTokens:191808,
      thresholdTokens:158808,
      retainTokens:30689,
      retainedTailTokens:194000,
      committedChunks:0,
    }),
  }));
  assert.match(wrappedAuto,/COMPACTION_CAPACITY_BLOCKED/);
  assert.match(wrappedAuto,/195000 tokens/);
  assert.match(wrappedAuto,/191808 tokens/);
  assert.match(wrappedAuto,/194000 tokens/);
  assert.doesNotMatch(wrappedAuto,/preserveRecentMessages/);

  const wrappedApi=failureExplanation(err('COMPACTION_CAPACITY_BLOCKED',{
    measuredTokens:170000,
    targetTokens:136000,
    cause:err('PI_AI_ERROR'),
  }));
  assert.match(wrappedApi,/PI_AI_ERROR/);
  assert.doesNotMatch(wrappedApi,/尾部保留区/);
});
await test('issue25-finishAutoBatch-attaches-capacity-details-and-preserves-cause-end-to-end',async()=>{
  const validSummary=buildCompactionInstruction('en')
    .split('\n')
    .filter(line=>/^## [1-9]\./.test(line))
    .map((heading,idx)=>`${heading}\n${idx===5?'[filled by engine]':'Compact earlier turn.'}`)
    .join('\n\n');
  const makeSession=(id,tailTokens)=>{
    const events=[];
    const surface={nodes:[],replaceGeneration:0};
    const nodeTokens=new Map();
    const s={
      id,
      surface,
      get seq(){return events.length;},
      eventAt:seq=>events[seq],
      snapshotEvents:()=>[...events],
      requestHeader:()=>({config:{provider:'local',model:'fixture'}}),
      toolHistory:()=>[],
      deriveEventMessage:ev=>ev?.type==='user/message'?ev.data:ev?.data?.message,
      append(type,data,opts={}){
        const ev={seq:events.length,time:Date.now(),type,data,...opts};
        events.push(ev);
        if(opts.surfaceOp==='append')surface.nodes.push(ev.seq);
        else if(opts.surfaceOp?.op==='replace'){
          const a=surface.nodes.indexOf(opts.surfaceOp.startSeq),b=surface.nodes.indexOf(opts.surfaceOp.endSeq);
          assert.ok(a>=0&&b>=a);
          surface.nodes.splice(a,b-a+1,ev.seq);
          surface.replaceGeneration++;
        }
        return ev;
      },
    };
    const pushNode=(role,text,tok)=>{
      const msg={role,content:[{type:'text',text}],source:role==='assistant'?{kind:'model',provider:'local',model:'fixture'}:{kind:role==='system'?'system-prompt':'user'}};
      const ev=s.append(`${role}/message`,role==='user'?msg:{message:msg},{surfaceOp:'append'});
      nodeTokens.set(ev.seq,tok);
      return ev;
    };
    pushNode('system','System.',20);
    s.append('turn/start',{turn:1});
    pushNode('user','Compact earlier turn cleanly.\n'+'Archived historical context detail from earlier investigation step. '.repeat(60),10000);
    pushNode('assistant','Large retained tail turn.',tailTokens);
    s.append('turn/end',{turn:1});
    s.append('turn/start',{turn:2});
    s.append('step/start',{turn:2,step:1});
    return {s,surface,nodeTokens};
  };

  // Case A: pure capacity block when continuation is disabled and uncompacted tail exceeds messageBudgetTokens
  const caseA=makeSession('issue25-cap-pure',95000);
  const engA=new WeaveCompactionEngine({
    on(){},provide(){},logger:{info(){},warn(){}},
    sessions:{get:id=>id===caseA.s.id?caseA.s:null,async flush(){return true;}},
    tokenMeter:{
      measure(){
        const nodes=caseA.surface.nodes.map(seq=>({seq,tokens:caseA.nodeTokens.get(seq)??80}));
        return {nodes,totalTokens:nodes.reduce((sum,n)=>sum+n.tokens,0),precision:'priced'};
      },
    },
    llm:{
      async resolveModelInfo(){return {contextWindow:100000,maxTokens:8192};},
      async *stream(){yield {type:'text-delta',text:validSummary};yield {type:'finish',kind:'stop'};},
    },
  },resolveConfig({
    archiveDir:join(root,'issue25-archive-a'),
    language:'en',
    thresholdRatio:0.8,
    headroomTokens:20000,
    minimumReductionRatio:0.2,
    retainRatio:0.16,
    continuationEnabled:false,
    summaryRetryCount:0,
    summaryRetryDelayMs:0,
    sessionMemoryEnabled:false,
    observationMaskingEnabled:false,
  }).config);
  engA.historyToolsAvailable=true;
  const agentA={session:caseA.s,options:{provider:'local',model:'fixture'},runMaintenance:fn=>fn(new AbortController().signal)};
  const thrownA=await rejected(engA.diagnostics.run(caseA.s,{trigger:'automatic',reportContext:engA._diagnosticContext(agentA)},()=>engA.compactIfNeeded(agentA,'pressure',new AbortController().signal)));
  assert.equal(thrownA.code,'COMPACTION_CAPACITY_BLOCKED');
  assert.equal(thrownA.capacityReason,'over-message-budget');
  assert.equal(thrownA.committedChunks,1);
  assert.ok(Number.isSafeInteger(thrownA.measuredTokens)&&thrownA.measuredTokens>=95000);
  assert.ok(Number.isSafeInteger(thrownA.targetTokens)&&thrownA.targetTokens>0);
  assert.equal(thrownA.messageBudgetTokens,91808);
  assert.ok(Number.isSafeInteger(thrownA.thresholdTokens)&&thrownA.thresholdTokens>0);
  assert.ok(Number.isSafeInteger(thrownA.retainTokens)&&thrownA.retainTokens>0);
  assert.equal(thrownA.retainedTailTokens,95000);
  assert.equal(thrownA.minimumReductionRatio,0.2);

  const diagRecA=diagnosticFor(thrownA);
  assert.equal(diagRecA?.status,'saved');
  const diagJsonA=JSON.parse(await readFile(diagRecA.path,'utf8'));
  assert.equal(diagJsonA.errors[0].code,'COMPACTION_CAPACITY_BLOCKED');
  assert.equal(diagJsonA.errors[0].capacityReason,'over-message-budget');
  assert.equal(diagJsonA.errors[0].retainedTailTokens,95000);
  assert.equal(diagJsonA.errors[0].messageBudgetTokens,91808);
  assert.equal(diagJsonA.errors[0].committedChunks,1);
  assert.match(diagRecA.explanation,/COMPACTION_CAPACITY_BLOCKED/);
  assert.match(diagRecA.explanation,/95000 tokens/);
  assert.match(diagRecA.explanation,/91808 tokens/);
  assert.match(diagRecA.explanation,/\/compact/);
  assert.match(diagRecA.explanation,/retainRatio \/ retainTokens/);
  assert.match(diagRecA.explanation,/minimumReductionRatio/);
  assert.doesNotMatch(diagRecA.explanation,/preserveRecentMessages/);
  engA.dispose();

  // Case B: COMPACTION_CAPACITY_BLOCKED wrapping an underlying API failure preserves cause & surfaces root cause
  const caseB=makeSession('issue25-cap-api',80000);
  const engB=new WeaveCompactionEngine({
    on(){},provide(){},logger:{info(){},warn(){}},
    sessions:{get:id=>id===caseB.s.id?caseB.s:null,async flush(){return true;}},
    tokenMeter:{
      measure(){
        const nodes=caseB.surface.nodes.map(seq=>({seq,tokens:caseB.nodeTokens.get(seq)??80}));
        return {nodes,totalTokens:nodes.reduce((sum,n)=>sum+n.tokens,0),precision:'priced'};
      },
    },
    llm:{
      async resolveModelInfo(){return {contextWindow:100000,maxTokens:8192};},
      async *stream(){throw Object.assign(new Error('provider api failure'),{code:'PI_AI_ERROR'});},
    },
  },resolveConfig({
    archiveDir:join(root,'issue25-archive-b'),
    language:'en',
    thresholdRatio:0.8,
    headroomTokens:20000,
    minimumReductionRatio:0.2,
    retainRatio:0.16,
    continuationEnabled:true,
    summaryRetryCount:0,
    summaryRetryDelayMs:0,
    sessionMemoryEnabled:false,
    observationMaskingEnabled:false,
  }).config);
  engB.historyToolsAvailable=true;
  const agentB={session:caseB.s,options:{provider:'local',model:'fixture'},runMaintenance:fn=>fn(new AbortController().signal)};
  const thrownB=await rejected(engB.diagnostics.run(caseB.s,{trigger:'automatic',reportContext:engB._diagnosticContext(agentB)},()=>engB.compactIfNeeded(agentB,'pressure',new AbortController().signal)));
  assert.equal(thrownB.code,'COMPACTION_CAPACITY_BLOCKED');
  assert.equal(thrownB.capacityReason,'over-threshold');
  assert.equal(thrownB.cause?.code,'SUMMARY_ALL_FAILED');
  assert.ok(thrownB.cause?.failureCodes?.includes('PI_AI_ERROR')||thrownB.cause?.cause?.code==='PI_AI_ERROR');
  assert.ok(Number.isSafeInteger(thrownB.measuredTokens)&&thrownB.measuredTokens>=90000);
  assert.equal(thrownB.retainedTailTokens,90000);
  const diagRecB=diagnosticFor(thrownB);
  assert.equal(diagRecB?.status,'saved');
  assert.match(diagRecB.explanation,/PI_AI_ERROR/);
  assert.doesNotMatch(diagRecB.explanation,/尾部保留区/);
  engB.dispose();
});
console.log(JSON.stringify({passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,results},null,2));if(results.some(x=>!x.pass))process.exitCode=1;
