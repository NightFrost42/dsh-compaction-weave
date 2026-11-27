import {diagnosticFor,diagnosticText,failureExplanation} from './failure-diagnostics.js';
// AI requests a phase-boundary compaction; replacement happens only at the next
// pre-step, after the whole tool batch has settled. Never enter idle maintenance
// from a running tool, and never silently renew an exhausted continuation budget.
import {randomUUID} from 'node:crypto';
import {inspectCompactionEntryState} from './region.js';
import {isReferenceContextKind} from './source-provenance.js';
import {isReferencePrefixOnly,isSystemReminderOnly} from './instruction-source.js';
import {selectCachePreservingRange} from './cache-policy.js';
import { estimateHostHeuristicMessage } from './meter.js';
export const COMPACTION_TOOL_NAME='context_compact';
export const COMPACTION_STATUS_KIND='weave-compaction-status';

const ALLOWED_SURFACE_ERROR_CODES = new Set([
  'ABORTED', 'ARCHIVE_FAILED', 'ARCHIVE_SOURCE_INVALID',
  'BACKUP_RESTORE_INVALID', 'BACKUP_RESTORE_UNAVAILABLE',
  'BILI_BACKUP_FAILED', 'BILI_COEXISTENCE_CONFLICT', 'BILI_MIGRATION_FAILED', 'BILI_PROXY_CONFLICT',
  'BREAKER_BLOCK_POLICY', 'CHECKPOINT_PRESERVED_UNREADABLE',
  'COMPACTION_AUTOMATIC_BLOCKED', 'COMPACTION_CANCELLED', 'COMPACTION_CAPACITY_BLOCKED',
  'COMPACTION_FAILED', 'COMPACTION_INVALID_BUDGET', 'COMPACTION_REQUEST_BUDGET_EXCEEDED',
  'COMPACTION_RETAIN_EXCEEDS_THRESHOLD', 'COMPACTION_STOPPED',
  'CONSTRAINT_LOST', 'CONSTRAINT_POLARITY_LOST', 'CONTEXT_WINDOW_EXCEEDED',
  'CONTINUATION_ARCHIVE_INVALID', 'CONTINUATION_ARCHIVE_REQUIRED', 'CONTINUATION_BATCH_LIMIT',
  'CONTINUATION_CALL_BUDGET', 'CONTINUATION_CAPACITY', 'CONTINUATION_EMPTY',
  'CONTINUATION_NOT_SMALLER', 'CONTINUATION_PENDING_CHANGED', 'CONTINUATION_PENDING_INVALID',
  'CONTINUATION_PENDING_POLICY_CHANGED', 'CONTINUATION_PENDING_RANGE',
  'CONTINUATION_PENDING_SOURCE_CHANGED', 'CONTINUATION_PROGRESS_CHANGED',
  'CONTINUATION_PROGRESS_INVALID', 'CONTINUATION_REQUIREMENTS_TOO_LARGE',
  'CONTINUATION_STRUCTURE', 'CONTINUATION_TOOL_GROUP_OPEN', 'CONTINUATION_TOOL_OUTPUT',
  'CONTINUATION_TOO_LARGE', 'CORDIS_CONTEXT_ERROR',
  'EACCES', 'EBUSY', 'ECONNRESET', 'EIO', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'EPERM', 'EPIPE', 'ETIMEDOUT',
  'INVALID_SESSION_ID', 'MAX_TOKENS', 'MEMORY_ARCHIVE_REQUIRED', 'MEMORY_SOURCE_UNAVAILABLE',
  'NOT_BILI_SESSION', 'PROGRESS_FACT_CONFLICT', 'PROVENANCE_LOST',
  'RECOVERY_REQUIRED', 'RETIRED_MEMORY_REINTRODUCED', 'SPAN_CHANGED',
  'STATE_INVALID', 'STATE_LOCKED', 'STATE_UNAVAILABLE',
  'STREAM_ERROR', 'STREAM_INTERRUPTED', 'SUMMARY_ALL_FAILED', 'SUMMARY_BATCH_LIMIT',
  'SUMMARY_FOREIGN_BILI_FORMAT', 'SUMMARY_GROUP_TOO_LARGE', 'SUMMARY_INVALID',
  'SUMMARY_NOT_SMALLER', 'SUMMARY_TIMEOUT', 'TIMEOUT',
  'TOOL_PAIRING_BROKEN', 'TOOL_PAIRING_IMBALANCED', 'TRANSPORT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
  'UNKNOWN', 'UNSUPPORTED_REASONING_EFFORT', 'WORK_REPORT_SOURCE_UNAVAILABLE',
  'busy', 'changed', 'commit', 'persistence', 'summary',
]);

function safeSurfaceErrorCode(error, fallback = 'COMPACTION_FAILED') {
  return typeof error?.code === 'string' && ALLOWED_SURFACE_ERROR_CODES.has(error.code)
    ? error.code
    : fallback;
}

function surfaceFailureReason(error, safeCode, diag) {
  let base;
  if (error?.hookCancelled === true) {
    base = 'Phase compaction was cancelled by the weave/pre-compact hook; original context stays unchanged.';
  } else if (safeCode === 'RECOVERY_REQUIRED' || safeCode === 'commit' || safeCode === 'persistence') {
    base = `Phase compaction could not commit or persist reliably (${safeCode}); inspect recovery status before retrying.`;
  } else if (
    safeCode === 'CONTEXT_WINDOW_EXCEEDED' ||
    safeCode === 'COMPACTION_INVALID_BUDGET' ||
    safeCode === 'COMPACTION_RETAIN_EXCEEDS_THRESHOLD' ||
    safeCode === 'SUMMARY_GROUP_TOO_LARGE' ||
    safeCode === 'COMPACTION_REQUEST_BUDGET_EXCEEDED'
  ) {
    base = `Phase compaction could not run due to context budget constraints (${safeCode}); original context stays unchanged.`;
  } else if (/TIMEOUT/.test(safeCode)) {
    base = `Phase compaction timed out while awaiting the summary target (${safeCode}); original context stays unchanged.`;
  } else if (/CONSTRAINT|COVERAGE|AUDIT|RETIRED_MEMORY|PROVENANCE|PROGRESS_FACT_CONFLICT/.test(safeCode)) {
    base = `Phase compaction did not pass validation (${safeCode}); no summary was committed.`;
  } else if (/CONTINUATION_|ARCHIVE_|STATE_|BACKUP_|CHECKPOINT_|TOOL_PAIRING|MEMORY_SOURCE/.test(safeCode)) {
    base = `Phase compaction stopped because history or state could not be verified (${safeCode}); original context stays unchanged.`;
  } else if (safeCode === 'busy' || safeCode === 'changed' || safeCode === 'SPAN_CHANGED') {
    base = `Phase compaction was deferred because the session changed or was busy (${safeCode}).`;
  } else if (
    safeCode === 'UNSUPPORTED_REASONING_EFFORT' ||
    /STRUCTURE|EMPTY_SUMMARY|SUMMARY_INVALID|NOT_SMALLER|TOO_LARGE|MAX_TOKENS|SUMMARY_FOREIGN/.test(safeCode)
  ) {
    base = `Phase compaction summary output did not meet format or size checks (${safeCode}); original context stays unchanged.`;
  } else {
    base = `Phase compaction failed (${safeCode}); inspect local diagnostics before retrying.`;
  }
  return diag?.id ? `${base} Diagnostic ID: ${diag.id}.` : base;
}

export function registerCompactionTool(ctx,engine) {
  if(!engine.config.proactiveEnabled)return false;
  try {
    ctx.tools.register({
      name:COMPACTION_TOOL_NAME,
      description:'Request phase-boundary compaction after stating verified progress, remaining work, and evidence paths. Call once before context is full; runs at the next step after tools settle (check receipt). Skipped when context is small or gain is too low. Do not retry in a loop.',
      parameters:{type:'object',properties:{reason:{type:'string',description:'Completed phase and why compaction fits now (no pasted docs).'}},required:['reason'],additionalProperties:false},
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
    try { this.engine._restoreState(session); }
    catch (error) { return {status:'blocked',reason:'state_unavailable',code:safeSurfaceErrorCode(error,'STATE_UNAVAILABLE')}; }
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
      try { engine._restoreState(session); }
      catch (error) {
        outcome={status:'blocked',reason:'state_unavailable',code:safeSurfaceErrorCode(error,'STATE_UNAVAILABLE')};
        this.receipt(session,request,outcome);
        return outcome;
      }
      const policy=engine._resolvePolicy(agent);
      if(claimed.some(m=>(m.source?.kind==='user'||!m.source?.kind)&&!isSystemReminderOnly(m)&&!isReferencePrefixOnly(m))){
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
          if(isReferenceContextKind(message?.source?.kind)||isSystemReminderOnly(message)||isReferencePrefixOnly(message))return sum;
          if(message?.role==='assistant'&&message.content?.some(b=>b.type==='tool-call'&&b.name===COMPACTION_TOOL_NAME))return sum;
          if(event?.type==='tool/result'&&(event.sourceEventSeqs??[]).some(n=>session.eventAt(n)?.data?.name===COMPACTION_TOOL_NAME))return sum;
          return sum+(costs.get(seq)??estimateHostHeuristicMessage(message));
        },0);
        if(!measurement||measurement.totalTokens<policy.proactiveMinTokens){
          outcome={status:'skipped',reason:'Context is still small; keeping the existing cached prefix.',minimumTokens:policy.proactiveMinTokens};
        }else if(anchor>=0&&growth<policy.proactiveMinGrowthTokens){
          outcome={status:'skipped',reason:'Too little new material since the last checkpoint or attempt; keeping the cached prefix.',minimumNewTokens:policy.proactiveMinGrowthTokens};
        }else if(policy.cachePreservePrefix!==false && anchor>=0 && growth<Math.max(policy.proactiveMinGrowthTokens,measurement.totalTokens*0.25) && !selectCachePreservingRange(session,measurement,policy.retainTokens??Math.max(4096,Math.floor(measurement.totalTokens*policy.retainRatio)),policy)){
          outcome={status:'skipped',reason:'This phase would rewrite the cached checkpoint for too little new work. Existing requirements and conversation stay unchanged; normal pressure compaction still applies.'};
        }else{
          const result=await engine._compactManual(agent,signal,undefined,false,true);
          outcome=['partial','failed'].includes(result?.status)?result:result?{status:'compacted',compactionIds:result.compactionIds??[result.compactionId],reason:'Compaction committed after archiving and validation. Continue from the checkpoint; use history tools for exact earlier evidence.'}:{status:'skipped',reason:'No balanced, shrinkable earlier span is available.'};
        }
      }
    }catch(error){
      if(signal?.aborted||error.name==='AbortError'||error.code==='ABORTED')throw error;
      await engine.diagnostics.capture(session,error,{trigger:'proactive'});
      const beforeNodeSet=new Set(beforeNodes);
      const changed=session.surface.nodes.some(seq=>!beforeNodeSet.has(seq)&&session.eventAt(seq)?.data?.source?.kind==='compact-checkpoint');
      const diag=diagnosticFor(error);
      engine.log('warn',`proactive compaction failed: ${failureExplanation(error)}${diagnosticText(error)}`);
      const safeCode=safeSurfaceErrorCode(error);
      outcome={
        status:changed?'partial':'failed',
        code:safeCode,
        ...(diag?.id?{diagnosticId:diag.id}:{}),
        reason:surfaceFailureReason(error,safeCode,diag),
      };
      if(error.code==='RECOVERY_REQUIRED'||engine._recoveryBlocked.has(engine._keyOf(session)))throw error;
    }
    this.receipt(session,request,outcome);
    return outcome;
  }
}
