import {diagnosticText,failureExplanation} from './failure-diagnostics.js';
// AI requests a phase-boundary compaction; replacement happens only at the next
// pre-step, after the whole tool batch has settled. Never enter idle maintenance
// from a running tool, and never silently renew an exhausted continuation budget.
import {randomUUID} from 'node:crypto';
import {inspectCompactionEntryState} from './region.js';
import {isReferenceContextKind} from './source-provenance.js';
import {selectCachePreservingRange} from './cache-policy.js';
import {approxTokens,blocksToText} from './meter.js';
export const COMPACTION_TOOL_NAME='context_compact';
export const COMPACTION_STATUS_KIND='weave-compaction-status';

export function registerCompactionTool(ctx,engine) {
  if(!engine.config.proactiveEnabled)return false;
  try {
    ctx.tools.register({
      name:COMPACTION_TOOL_NAME,
      description:'Request context compaction after completing a substantial task phase, or before reading the next large batch of material. First state verified progress, remaining work and evidence paths in the conversation. Call once at that boundary, before context is full. This returns queued, not success: compression runs after all current tools settle, before the next model step; a context-compaction receipt reports the actual outcome. Small contexts or insufficient new material are skipped to preserve cache. Do not retry a failed request in a loop; original history and normal safety checks are retained.',
      parameters:{type:'object',properties:{reason:{type:'string',description:'Which task phase finished and why compaction is appropriate now. Do not copy documents or skill bodies.'}},required:['reason'],additionalProperties:false},
      output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
      timeoutMs:15000,
      execute:async(args,exec)=>JSON.stringify(await engine.proactive.request(exec?.agent,args?.reason,exec?.signal)),
    });
    return true;
  }catch(error){ctx.logger?.warn?.(`[compaction-weave] context_compact registration failed: ${error.message}`);return false;}
}

export class ProactiveCompaction {
  constructor(engine){this.engine=engine;this.pending=new WeakMap();}
  dispose(){this.pending=new WeakMap();}
  async request(agent,reason,signal){
    signal?.throwIfAborted?.();
    const session=agent?.session;
    if(!session)return {status:'unavailable',reason:'Requires an active agent session.'};
    if(!this.engine.config.proactiveEnabled)return {status:'disabled'};
    if(typeof reason!=='string'||!reason.trim()||reason.length>240)return {status:'invalid',reason:'Provide a phase reason of 1–240 characters.'};
    const previous=this.pending.get(session);
    if(previous)return {status:'queued',requestId:previous.id,reason:'A request is already queued; do not call again.'};
    this.engine._restoreState(session);
    if(this.engine._stopped.has(this.engine._keyOf(session)))return {status:'blocked',reason:'Compaction is stopped after prior failures; inspect the error or use the manual command. AI requests do not reset it.'};
    if(!this.engine.config.archiveEnabled||!this.engine.historyToolsAvailable)return {status:'blocked',reason:'Verified archives and history retrieval tools are required.'};
    const request={id:randomUUID(),reason:reason.trim(),turn:inspectCompactionEntryState(session).openTurn};
    this.pending.set(session,request);
    return {status:'queued',requestId:request.id,reason:'Will run once at the next safe step after this tool batch. Wait for the context-compaction receipt; compaction has not happened yet.'};
  }
  receipt(session,request,result){
    this.engine._appendSync(session,'user/message',{
      id:randomUUID(),role:'user',source:{kind:COMPACTION_STATUS_KIND,requestId:request.id,status:result.status},
      content:[{type:'text',text:'Context compaction receipt: '+JSON.stringify({requestId:request.id,...result})+' This is engine status, not a new user instruction.'}],
    },{surfaceOp:'append'});
  }
  async consume(agent,signal,claimed=[]){
    const engine=this.engine,session=agent.session,request=this.pending.get(session);
    if(!request)return null;
    this.pending.delete(session); // Exactly one attempt, even if it fails or is cancelled.
    signal?.throwIfAborted?.();
    if(request.turn!==inspectCompactionEntryState(session).openTurn)return {status:'cancelled'};
    let outcome;
    const beforeNodes=[...session.surface.nodes];
    try {
      engine._restoreState(session);
      if(claimed.some(m=>m.source?.kind==='user'||!m.source?.kind)){
        outcome={status:'skipped',reason:'New user input arrived. Incorporate it before requesting another phase compaction.'};
      }else if(engine._stopped.has(engine._keyOf(session))){
        outcome={status:'blocked',reason:'Compaction is stopped; no AI retry was performed.'};
      }else if(engine._busy.has(session)){
        outcome={status:'skipped',reason:'Another compaction is already active.'};
      }else{
        const measurement=await engine._measure(session),nodes=session.surface.nodes;
        let anchor=-1;
        for(let i=0;i<nodes.length;i++){
          const source=session.eventAt(nodes[i])?.data?.source;
          if(source?.kind==='compact-checkpoint'||source?.kind===COMPACTION_STATUS_KIND&&['compacted','failed','partial'].includes(source.status))anchor=i;
        }
        // _measure normalizes node objects to sequence numbers and puts prices
        // in pricedBySeq. Keep both forms usable; absent prices are not zero work.
        const costs=new Map(measurement?.pricedBySeq??[]);
        for(const n of measurement?.nodes??[])if(typeof n==='object'&&Number.isFinite(n.tokens??n.heuristicTokens))costs.set(n.seq,n.tokens??n.heuristicTokens);
        const growth=nodes.slice(anchor+1).reduce((sum,seq)=>{
          const event=session.eventAt(seq),message=session.deriveEventMessage(event);
          if(isReferenceContextKind(message?.source?.kind))return sum;
          if(message?.role==='assistant'&&message.content?.some(b=>b.type==='tool-call'&&b.name===COMPACTION_TOOL_NAME))return sum;
          if(event?.type==='tool/result'&&(event.sourceEventSeqs??[]).some(n=>session.eventAt(n)?.data?.name===COMPACTION_TOOL_NAME))return sum;
          return sum+(costs.get(seq)??approxTokens(blocksToText(message?.content)));
        },0);
        if(!measurement||measurement.totalTokens<engine.config.proactiveMinTokens){
          outcome={status:'skipped',reason:'Context is still small; keeping the existing cached prefix.',minimumTokens:engine.config.proactiveMinTokens};
        }else if(anchor>=0&&growth<engine.config.proactiveMinGrowthTokens){
          outcome={status:'skipped',reason:'Too little new material since the last checkpoint or attempt; keeping the cached prefix.',minimumNewTokens:engine.config.proactiveMinGrowthTokens};
        }else if(engine.config.cachePreservePrefix!==false && anchor>=0 && growth<Math.max(engine.config.proactiveMinGrowthTokens,measurement.totalTokens*0.25) && !selectCachePreservingRange(session,measurement,engine.config.retainTokens??Math.max(4096,Math.floor(measurement.totalTokens*engine.config.retainRatio)),engine.config)){
          outcome={status:'skipped',reason:'This phase would rewrite the cached checkpoint for too little new work. Existing requirements and conversation stay unchanged; normal pressure compaction still applies.'};
        }else{
          const result=await engine._compactManual(agent,signal,undefined,false,true);
          outcome=result?{status:'compacted',compactionIds:result.compactionIds??[result.compactionId],reason:'Compaction committed after archiving and validation. Continue from the checkpoint; use history tools for exact earlier evidence.'}:{status:'skipped',reason:'No balanced, shrinkable earlier span is available.'};
        }
      }
    }catch(error){
      if(signal?.aborted||error.name==='AbortError'||error.code==='ABORTED')throw error;
      await engine.diagnostics.capture(session,error,{trigger:'proactive'});
      const changed=session.surface.nodes.some(seq=>!beforeNodes.includes(seq)&&session.eventAt(seq)?.data?.source?.kind==='compact-checkpoint');
      outcome={status:changed?'partial':'failed',code:error.code??'COMPACTION_FAILED',reason:changed?'Some chunks committed; remaining history is retained. Inspect the failure before retrying.':'Compaction did not commit. Original context is retained. Inspect the failure before retrying.'};
      outcome.reason=failureExplanation(error)+diagnosticText(error);
      if(error.code==='RECOVERY_REQUIRED'||engine._recoveryBlocked.has(engine._keyOf(session)))throw error;
    }
    this.receipt(session,request,outcome);
    return outcome;
  }
}
