import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {fileURLToPath,pathToFileURL} from 'node:url';
import {WeaveCompactionEngine} from '../../lib/engine.js';import {resolveConfig} from '../../lib/config.js';import {approxTokens,blocksToText} from '../../lib/meter.js';
const root=process.env.WEAVE_TEST_ROOT;
const {Session}=await import(pathToFileURL(path.join(process.env.DSH_TEST_NODE_MODULES,'@deepseek-ai/dsh-session/lib/index.js')));
const report=[];
const session=Session.create('session-'+randomUUID());
const add=(role,text,kind='user')=>{const message={id:randomUUID(),role,content:[{type:'text',text}],source:role==='user'?{kind}:role==='system'?{kind:'system-prompt'}:{kind:'model',provider:'p',model:'m'}};return session.append(role+'/message',role==='user'?message:{message,...(role==='assistant'?{turn:0,step:0,stream:[],usage:{inputTokens:0,outputTokens:0}}:{})},{surfaceOp:'append'});};
add('system','Stable system prefix.');add('user','Timeout must be 35 seconds.');add('user','Timeout must be 55 seconds.');add('user','Reference document '.repeat(2000),'runtime-context');add('assistant','Verified work '.repeat(2000));
const summary=['Primary Request and Intent','Key Technical Concepts','Files and Code Sections','Errors and Fixes','Problem Solving','All User Messages','Pending Tasks','Work Completed','Context for Continuing Work'].map((h,i)=>`## ${i+1}. ${h}\n${i===0?'Repair compaction.':i===5?'[filled by engine]':'(none)'}`).join('\n\n');
let calls=0;const ctx={on(){},provide(){},logger:{info(){},warn(){}},sessions:{async flush(){}},tokenMeter:{measure(){const nodes=session.surface.nodes.map(seq=>({seq,tokens:approxTokens(blocksToText(session.deriveEventMessage(session.eventAt(seq))?.content))}));return {nodes,totalTokens:nodes.reduce((n,x)=>n+x.tokens,0)};}},llm:{async resolveModelInfo(){return {contextWindow:1000000};},async *stream(){calls++;yield {type:'text-delta',text:summary};yield {type:'finish',kind:'stop'};}}};
const engine=new WeaveCompactionEngine(ctx,resolveConfig({archiveDir:path.join(root,'test-tmp','native-'+Date.now(),'archive'),language:'en'}).config);engine.historyToolsAvailable=true;
const agent={session,options:{provider:'p',model:'m'},runMaintenance:fn=>fn(new AbortController().signal)};
const source=[...session.surface.nodes].slice(1);
try {
 const r=await engine._compactRegionCore(source[0],source.at(-1),agent,new AbortController().signal,{manual:true,policy:engine.config});
 assert.deepEqual(r.shadowedSeqs,source);assert.equal(session.surface.nodes.length,2);
 const checkpoint=session.deriveEventMessage(session.eventAt(session.surface.nodes.at(-1)));
 assert.ok(!JSON.stringify(checkpoint.content).includes('35 seconds'));assert.ok(JSON.stringify(checkpoint.content).includes('55 seconds'));
 const archived=await engine.archive.readSpan(session.id,r.compactionId);assert.ok(archived.ok);assert.deepEqual(archived.entries.map(e=>e.seq),source);
 const clone=Session.create(session.id,session.snapshotEvents(),session.header);
 assert.deepEqual(clone.surface.nodes,session.surface.nodes);
 report.push({name:'native-Session-commit-archive-and-replay',pass:true,calls,checkpointBytes:Buffer.byteLength(JSON.stringify(checkpoint.content)),sourceEvents:source.length});
}catch(e){report.push({name:'native-Session-commit-archive-and-replay',pass:false,error:e.message,code:e.code,stack:e.stack});process.exitCode=1;}
fs.writeFileSync(path.join(root,'validation','native-host.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
