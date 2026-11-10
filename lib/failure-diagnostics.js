// Failure reports contain allowlisted metadata, never prompts, responses,
// credentials, arbitrary provider messages or raw stacks. They stay off the
// conversation surface and are correlated with the exact operation/command.
import {PLUGIN_VERSION} from './version.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID, createHash} from 'node:crypto';
import {mkdir, open, rename, readdir, stat, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {summaryTimeoutText} from './summary-timeout.js';
import {continuationBudgetText} from './continuation-budget.js';

const scopes = new AsyncLocalStorage();
const receipts = new WeakMap();
const MAX_REPORTS = 40, MAX_ATTEMPTS = 256, MAX_BYTES = 256 * 1024;
const numericKeys = ['elapsedMs','firstChunkMs','lastChunkMs','firstTextMs','lastTextMs','firstProgressMs','lastProgressMs','idleMs','textIdleMs','maxProgressGapMs','chunks','textChars','reasoningChars','acceptedPages','totalPages','requests','requestsThisAttempt','acceptedPagesThisAttempt','unknownUsage','resumedPages'];
const safeCode = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : 'UNKNOWN';
const safeRoute = value => typeof value === 'string' && /^[A-Za-z0-9@][A-Za-z0-9._/@:+-]{0,199}$/.test(value) && !/^(sk-|gh[pousr]_)/.test(value) ? value : null;
const hashId = value => typeof value === 'string' ? createHash('sha256').update(value).digest('hex') : null;
function numbers(value) {
  const out = {};
  for (const key of numericKeys) if (value?.[key] === null || Number.isSafeInteger(value?.[key]) && value[key] >= 0) out[key] = value[key];
  return out;
}
function causes(error) {
  const rows = [], seen = new Set();
  for (let e = error; e && rows.length < 8 && !seen.has(e); e = e.cause) {
    seen.add(e);
    const status = e.status ?? e.statusCode ?? e.response?.status;
    rows.push({code:safeCode(e.failureCode??e.code), name:safeCode(e.name), ...(Number.isInteger(status) && status >= 100 && status <= 599 ? {httpStatus:status} : {}),
      ...(Number.isSafeInteger(e.timeoutMs) ? {timeoutMs:e.timeoutMs} : {}), progress:numbers(e.diagnostics), continuation:numbers(e.continuationProgress),
      ...(Array.isArray(e.failureCodes) ? {failureCodes:e.failureCodes.slice(0,8).map(safeCode)} : {})});
  }
  return rows;
}
export function diagnosticFor(error) {
  const seen = new Set();
  for (let e=error; e && (typeof e==='object'||typeof e==='function') && !seen.has(e); e=e.cause) {
    seen.add(e); const value=receipts.get(e); if(value)return value;
    if(seen.size>=8)break;
  }
  return null;
}
export function transferDiagnostic(from,to) {
  const value=diagnosticFor(from); if(value && to && typeof to==='object')receipts.set(to,value);
  return to;
}
export function beginDiagnosticAttempt(target, settings) {
  const scope=scopes.getStore(); if(!scope)return null;
  scope.totalAttempts++;
  if(scope.attempts.length>=MAX_ATTEMPTS){scope.omittedAttempts++;return null;}
  const row={number:scope.totalAttempts,provider:safeRoute(target.provider),model:safeRoute(target.model),startedAt:new Date().toISOString(),
    maxTokens:settings.maxTokens,timeoutMs:settings.timeoutMs,retryCount:settings.retryCount,requestStarted:false,usageKnown:false,outcome:'pending'};
  scope.attempts.push(row);return row;
}
export function finishDiagnosticAttempt(row,meta={}) {
  if(!row)return;
  if(typeof meta.requestStarted==='boolean')row.requestStarted=meta.requestStarted;
  if(typeof meta.completed==='boolean')row.streamCompleted=meta.completed;
  if(meta.usage && typeof meta.usage==='object') {
    row.usage={};
    for(const key of ['inputTokens','outputTokens','totalTokens','cachedInputTokens','cacheReadTokens'])if(Number.isFinite(meta.usage[key])&&meta.usage[key]>=0)row.usage[key]=meta.usage[key];
    row.usageKnown=Object.keys(row.usage).length>0;
  }
  if(meta.diagnostics)row.progress=numbers(meta.diagnostics);
  if(meta.error)row.errors=causes(meta.error);
  if(meta.outcome)row.outcome=meta.outcome;
  if(Number.isInteger(meta.retryDelayMs))row.retryDelayMs=meta.retryDelayMs;
  row.endedAt=new Date().toISOString();
}
export function noteAuditDiagnostic(path) {
  const scope=scopes.getStore();if(!scope)return;
  scope.auditReports.push(path ? {saved:true,path} : {saved:false});
  if(scope.auditReports.length>64)scope.auditReports.shift();
}
export function trackAuditDiagnostic(promise) {
  const scope=scopes.getStore();
  if(scope)scope.pendingAudits.push(Promise.resolve(promise).catch(()=>null));
  return promise;
}
export function failureExplanation(error) {
  const budget=continuationBudgetText(error);if(budget)return budget;
  const codes=causes(error).flatMap(x=>[x.code,...(x.failureCodes??[])]);
  const code=codes.find(x=>!['UNKNOWN','summary','commit','persistence','SUMMARY_ALL_FAILED','COMPACTION_AUTOMATIC_BLOCKED','COMPACTION_CAPACITY_BLOCKED'].includes(x))??codes[0]??'UNKNOWN';
  if(codes.includes('RECOVERY_REQUIRED')||error?.compactionStage==='commit'||['commit','persistence'].includes(error?.code))return `压缩未能正常提交或保存（${code}）。部分步骤可能已完成，请先检查保留的恢复记录，再决定是否重试。`;
  const timeout=summaryTimeoutText(error);if(timeout)return timeout;
  if(codes.some(c=>/^(?:TIMEOUT|ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)$/.test(c)))return `摘要服务连接或响应超时（${code}），本次压缩未完成。请查看诊断中的尝试次数和用量。`;
  if(code==='busy')return '当前会话正在工作或已有压缩进行中，请空闲后再试。';
  if(code==='SPAN_CHANGED'||code==='changed')return '压缩期间会话内容发生变化，本次替换已停止，请稍后重试。';
  if(code==='PROGRESS_FACT_CONFLICT')return '摘要与已有进度事实冲突，已按设置重试；未提交不合格摘要，原上下文保留。';
  if(/PROGRESS_SOURCE|PROGRESS_SELECTION/.test(code))return `进度事实的原始来源无法可靠核验（${code}），已停止本次压缩并保留原上下文。`;
  if(/CONSTRAINT|COVERAGE|AUDIT|RETIRED_MEMORY/.test(code))return `摘要未通过要求保留检查（${code}），未提交不合格摘要。`;
  if(/STRUCTURE|EMPTY_SUMMARY|SUMMARY_INVALID|NOT_SMALLER|TOO_LARGE|MAX_TOKENS/.test(code))return `摘要格式、长度或压缩效果未通过检查（${code}），未提交不合格摘要。`;
  if(codes.some(c=>/CONTINUATION_(PROGRESS|PERSIST)|ARCHIVE|STATE_UNAVAILABLE|ENOSPC|EACCES|EPERM|EBUSY|EIO/.test(c)))return `压缩进度或历史记录无法可靠读取、保存（${code}）。已停止自动重试，请检查存储状态。`;
  const status=causes(error).find(x=>x.httpStatus)?.httpStatus;
  if(status===401||status===403||/AUTH|CREDENTIAL|PERMISSION/.test(code))return `摘要服务拒绝访问（${status??code}），请检查凭据或权限。`;
  if(codes.some(c=>/^(?:TRANSPORT|ECONNRESET|EPIPE|UND_ERR_SOCKET|STREAM_INTERRUPTED|STREAM_ERROR)$/.test(c)))return `摘要服务连接或响应流中断（${code}），本次压缩未完成。请查看诊断中的尝试次数和用量。`;
  return `压缩未完成（${code}）。请根据诊断记录检查摘要服务或当前会话状态。`;
}
export function diagnosticText(errorOrReceipt) {
  const r=errorOrReceipt?.id && errorOrReceipt?.status ? errorOrReceipt : diagnosticFor(errorOrReceipt);
  if(!r)return '';
  const count=r.attempts>0?`本次记录 ${r.attempts} 次摘要请求尝试。`:'';
  const audit=r.auditWriteFailures>0?`另有 ${r.auditWriteFailures} 份详细审计记录保存失败。`:'';
  return `${count}诊断编号：${r.id}。${r.status==='saved'?`诊断日志：${r.path}`:`诊断日志保存失败（${r.writeError}），请保留本条提示；错误码：${r.code}，阶段：${r.stage}。`}${audit}`;
}

export class FailureDiagnostics {
  constructor(storageRoot,{timeoutMs=2000}={}){this.root=join(storageRoot,'diagnostics');this.commands=new WeakMap();this.timeoutMs=timeoutMs;}
  forCommand(session,id){return session && id ? this.commands.get(session)?.get(id)??null : null;}
  remember(session,id,receipt){
    if(!session||typeof session!=='object'||typeof id!=='string'||!id)return;
    let map=this.commands.get(session);if(!map)this.commands.set(session,map=new Map());
    map.set(id,receipt);while(map.size>16)map.delete(map.keys().next().value);
  }
  async run(session,context,operation){
    const parent=scopes.getStore();
    if(parent?.owner===this&&parent.session===session)return operation();
    const scope={owner:this,session,id:randomUUID(),context,startedAt:new Date().toISOString(),attempts:[],totalAttempts:0,omittedAttempts:0,auditReports:[],pendingAudits:[]};
    if(context.commandId)this.commands.get(session)?.delete(context.commandId);
    return scopes.run(scope,async()=>{
      try {
        const result=await operation();
        if(!scope.terminal&&scope.attempts.some(x=>x.outcome==='failed'))await this.write(scope,null,'recovered');
        return result;
      }catch(error){
        if(context.signal?.aborted||['ABORTED','cancelled'].includes(error?.code)||error?.name==='AbortError')throw error;
        const receipt=await this.capture(session,error,context);
        this.remember(session,context.commandId,receipt);
        throw error;
      }
    });
  }
  async capture(session,error,context={}){
    const existing=diagnosticFor(error);if(existing)return existing;
    const active=scopes.getStore();
    const scope=active?.owner===this&&active.session===session?active:{owner:this,session,id:randomUUID(),context,startedAt:new Date().toISOString(),attempts:[],totalAttempts:0,omittedAttempts:0,auditReports:[],pendingAudits:[]};
    scope.terminal=true;
    const receipt=await this.write(scope,error,'failed');
    if(error&&typeof error==='object')receipts.set(error,receipt);
    this.remember(session,context.commandId??scope.context.commandId,receipt);
    return receipt;
  }
  async write(scope,error,outcome){
    let timer;
    const fallback={id:scope.id,status:'failed',writeError:'DIAGNOSTIC_TIMEOUT',code:safeCode(error?.failureCode??error?.code),
      stage:error?.compactionStage==='commit'?'commit':'preflight-or-summary',attempts:scope.totalAttempts,auditWriteFailures:scope.auditReports.filter(x=>!x.saved).length,
      explanation:error?failureExplanation(error):'摘要重试后完成。'};
    try{return await Promise.race([this._write(scope,error,outcome),new Promise(resolve=>{timer=setTimeout(()=>resolve(fallback),this.timeoutMs);})]);}
    catch{return {...fallback,writeError:'DIAGNOSTIC_ERROR'};}
    finally{clearTimeout(timer);}
  }
  async _write(scope,error,outcome){
    // All audit tasks settle before we claim their files are available. They
    // already catch disk errors; diagnostics never change the compaction verdict.
    await Promise.allSettled(scope.pendingAudits);
    const chain=causes(error),stage=['summary','commit','persistence'].includes(error?.compactionStage)?error.compactionStage:'preflight-or-summary';
    const payload={kind:'compaction-weave/failure-diagnostic',version:1,pluginVersion:PLUGIN_VERSION,id:scope.id,outcome,
      startedAt:scope.startedAt,endedAt:new Date().toISOString(),sessionHash:hashId(scope.session?.id),commandHash:hashId(scope.context.commandId),trigger:safeCode(scope.context.trigger),stage,
      errors:chain,attempts:scope.attempts,totalAttempts:scope.totalAttempts,omittedAttempts:scope.omittedAttempts,auditReports:scope.auditReports,
      retryLimit:error?.summaryAttemptLimit??null,committedChunks:Array.isArray(error?.compactionIds)?error.compactionIds.length:null};
    const receipt={id:scope.id,status:'failed',code:chain[0]?.code??'UNKNOWN',stage,attempts:scope.totalAttempts,auditWriteFailures:scope.auditReports.filter(x=>!x.saved).length,
      explanation:error?failureExplanation(error):'摘要重试后完成。'};
    const file=join(this.root,`${Date.now()}-${scope.id}.json`),temporary=file+'.tmp';let handle;
    try{
      const text=JSON.stringify(payload,null,2)+'\n';if(Buffer.byteLength(text)>MAX_BYTES)throw Object.assign(new Error('report limit'),{code:'REPORT_TOO_LARGE'});
      await mkdir(this.root,{recursive:true});handle=await open(temporary,'wx',0o600);await handle.writeFile(text,'utf8');await handle.sync();await handle.close();handle=null;await rename(temporary,file);
      receipt.status='saved';receipt.path=file;
      // Never delete foreign files; count and prune only our completed reports.
      try{const entries=await readdir(this.root);const files=[];for(const name of entries)if(/^\d+-[0-9a-f-]{36}\.json$/.test(name))files.push({name,time:(await stat(join(this.root,name))).mtimeMs});files.sort((a,b)=>b.time-a.time||b.name.localeCompare(a.name));for(const old of files.slice(MAX_REPORTS))if(old.name!==file.split(/[\\/]/).at(-1))await rm(join(this.root,old.name),{force:true});}catch{}
    }catch(e){receipt.writeError=safeCode(e?.code);try{await handle?.close();await rm(temporary,{force:true});}catch{}}
    return receipt;
  }
}
