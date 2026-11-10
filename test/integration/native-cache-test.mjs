import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {fileURLToPath,pathToFileURL} from 'node:url';
import {WeaveCompactionEngine} from '../../lib/engine.js';import {resolveConfig} from '../../lib/config.js';import {approxTokens,blocksToText} from '../../lib/meter.js';import {collectInstructionMessages} from '../../lib/region.js';
const root=process.env.WEAVE_TEST_ROOT;
const {Session}=await import(pathToFileURL(path.join(process.env.DSH_TEST_NODE_MODULES,'@deepseek-ai/dsh-session/lib/index.js')));
const session=Session.create('session-'+randomUUID());
const add=(role,text)=>{const message={id:randomUUID(),role,content:[{type:'text',text}],source:role==='user'?{kind:'user'}:role==='system'?{kind:'system-prompt'}:{kind:'model',provider:'p',model:'m'}};return session.append(role+'/message',role==='user'?message:{message,...(role==='assistant'?{turn:0,step:0,stream:[],usage:{inputTokens:0,outputTokens:0}}:{})},{surfaceOp:'append'});};
const notes='## Goal\nComplete the diagnostics.\n## State\nVerified evidence remains archived.\n## Next\nReview pending results.\n## Uncertain\nRuntime verification remains pending.';
let summary=['Primary Request and Intent','Key Technical Concepts','Files and Code Sections','Errors and Fixes','Problem Solving','All User Messages','Pending Tasks','Work Completed','Context for Continuing Work'].map((h,i)=>`## ${i+1}. ${h}\n${i===0?'Repair compaction.':i===5?'[filled by engine]':'(none)'}`).join('\n\n');
const measure=()=>{const nodes=session.surface.nodes.map(seq=>({seq,tokens:approxTokens(blocksToText(session.deriveEventMessage(session.eventAt(seq))?.content))}));return {nodes,totalTokens:nodes.reduce((n,x)=>n+x.tokens,0)};};
let calls=0;const ctx={on(){},provide(){},logger:{info(){},warn(){}},sessions:{async flush(){}},tokenMeter:{measure},llm:{async resolveModelInfo(){return {contextWindow:1000000};},async *stream(){calls++;yield {type:'text-delta',text:summary};yield {type:'finish',kind:'stop'};}}};
const engine=new WeaveCompactionEngine(ctx,resolveConfig({archiveDir:path.join(root,'test-tmp','native-cache-'+Date.now(),'archive'),language:'en'}).config);engine.historyToolsAvailable=true;
const agent={session,options:{provider:'p',model:'m'},runMaintenance:fn=>fn(new AbortController().signal)};
const results=[];
try{
 add('system','Stable system prefix.');const original=add('user','Do not delete records.');add('assistant','Initial verified diagnostics '.repeat(3500));
 await engine._compactRegionCore(session.surface.nodes[1],session.surface.nodes.at(-1),agent,new AbortController().signal,{manual:true,policy:engine.config});
 const firstCheckpoint=session.surface.nodes[1];summary=notes;
 for(let generation=0;generation<3;generation++){
  for(let i=0;i<8;i++)add('assistant',`Verified phase ${generation} part ${i}. `+'Detailed evidence with reproducible paths. '.repeat(1500));
  add('user','继续');add('assistant','Most recent progress still needs verification.');
  const beforeNodes=[...session.surface.nodes],beforeMessages=beforeNodes.map(seq=>JSON.stringify(session.deriveEventMessage(session.eventAt(seq)))),before=measure().totalTokens;
  const result=await engine._compactManual(agent,new AbortController().signal,undefined,true);
  const firstChanged=beforeNodes.indexOf(result.shadowedSeqs[0]);
  assert.ok(firstChanged>1,'must preserve existing checkpoint and oldest stable prefix');
  assert.deepEqual(session.surface.nodes.slice(0,firstChanged),beforeNodes.slice(0,firstChanged));
  assert.deepEqual(session.surface.nodes.slice(0,firstChanged).map(seq=>JSON.stringify(session.deriveEventMessage(session.eventAt(seq)))),beforeMessages.slice(0,firstChanged));
  const after=measure().totalTokens;assert.ok(after<before*.8,'must meet reduction instead of claiming cache at expense of compaction');
  assert.ok(collectInstructionMessages(session,session.surface.nodes).some(m=>m.seq===original.seq&&m.text==='Do not delete records.'));
  const archive=await engine.archive.readSpan(session.id,result.compactionId);assert.ok(archive.ok);assert.deepEqual(archive.entries.map(e=>e.seq),result.shadowedSeqs);
  const replay=Session.create(session.id,session.snapshotEvents(),session.header);assert.deepEqual(replay.surface.nodes,session.surface.nodes);
  results.push({name:'native-incremental-generation-'+(generation+1),pass:true,preservedPrefixNodes:firstChanged,beforeTokens:before,afterTokens:after,reduction:1-after/before});
 }
 assert.ok(session.surface.nodes.includes(firstCheckpoint));
 // At the cap, consolidate all notes, while still preserving the rule.
 add('assistant','Final diagnostics '.repeat(4000));await engine._compactManual(agent,new AbortController().signal,undefined,true);
 assert.equal(session.surface.nodes.filter(seq=>session.eventAt(seq).data?.source?.kind==='compact-checkpoint').length,1);
 assert.ok(collectInstructionMessages(session,session.surface.nodes).some(m=>m.seq===original.seq&&m.text==='Do not delete records.'));
 results.push({name:'native-consolidation-at-checkpoint-limit',pass:true});
}catch(e){results.push({name:'native-cache-integration',pass:false,error:e.message,code:e.code,stack:e.stack});process.exitCode=1;}
fs.writeFileSync(path.join(root,'test-results','native-cache.json'),JSON.stringify({calls,results},null,2));console.log(JSON.stringify({calls,results},null,2));
