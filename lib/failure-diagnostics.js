// Failure reports contain allowlisted metadata, never prompts, responses,
// credentials, arbitrary provider messages or raw stacks. They stay off the
// conversation surface and are correlated with the exact operation/command.
import {PLUGIN_VERSION} from './version.js';
import {readFileSync} from 'node:fs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID, createHash} from 'node:crypto';
import {mkdir, open, rename, readdir, stat, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {summaryTimeoutText} from './summary-timeout.js';
import {continuationBudgetText} from './continuation-budget.js';
import {CONTENT_RETRY_CODES} from './summary-retry.js';

const scopes = new AsyncLocalStorage();
const receipts = new WeakMap();
const MAX_REPORTS = 40, MAX_ATTEMPTS = 256, MAX_BYTES = 256 * 1024;
const SUPPORTED_DSH_VERSION = JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).engines?.dsh ?? null;
const settingNumbers = ['maxTokens','thresholdRatio','minimumReductionRatio','idleCompactionMinutes','idleCompactionMinTokens','idleRetainTokens','headroomTokens','retainRatio','retainTokens','preserveRecentMessages','preserveRecentUserTokens','summaryRetryCount','summaryRetryDelayMs','summaryTimeoutMs','summaryInputRatio','summaryInputMaxBytes','cacheMaxCheckpoints','cacheMinSavingsTokens','maxSummaryChunks','continuationMemoryBytes','continuationMaxBytes','continuationMaxExtraCalls','observationMaskThresholdChars','observationMaskHeadChars','observationMaskTailChars','auditCoverageThreshold','failureThreshold'];
const settingBooleans = ['auto','cachePreservePrefix','continuationEnabled','archiveEnabled','observationMaskingEnabled','auditEnabled','auditBlockOnLoss','auditProvenanceBlock','proactiveEnabled','strictHostFingerprints'];
const numericKeys = ['elapsedMs','firstChunkMs','lastChunkMs','firstTextMs','lastTextMs','firstProgressMs','lastProgressMs','idleMs','textIdleMs','maxProgressGapMs','chunks','textChars','reasoningChars','acceptedPages','totalPages','requests','requestsThisAttempt','acceptedPagesThisAttempt','unknownUsage','resumedPages'];
const safeCode = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : 'UNKNOWN';
const safeRoute = value => typeof value === 'string' && /^[A-Za-z0-9@][A-Za-z0-9._/@:+-]{0,199}$/.test(value) && !/^(sk-|gh[pousr]_)/.test(value) ? value : null;
const hashId = value => typeof value === 'string' ? createHash('sha256').update(value).digest('hex') : null;
function route(value) {return {provider:safeRoute(value?.provider),model:safeRoute(value?.model)};}
function safeSettings(policy={}) {
  const settings={};
  for(const key of settingNumbers)if(policy[key]===null||typeof policy[key]==='number'&&Number.isFinite(policy[key])&&policy[key]>=0)settings[key]=policy[key];
  for(const key of settingBooleans)if(typeof policy[key]==='boolean')settings[key]=policy[key];
  if(['auto','zh','en'].includes(policy.language))settings.language=policy.language;
  if(['confirm','degrade','block'].includes(policy.pressureBreakerAction))settings.pressureBreakerAction=policy.pressureBreakerAction;
  return settings;
}
function safeContext(value) {
  const fallback=diagnosticContext();
  return {environment:fallback.environment,conversation:route(value?.conversation),summary:{...route(value?.summary),selection:['configured','session','agent'].includes(value?.summary?.selection)?value.summary.selection:'unknown'},settings:safeSettings(value?.settings)};
}
export function diagnosticContext(agent,policy={}) {
  // Take only explicit allowlisted values; never retain request headers, config
  // objects, paths, credentials, messages, tool definitions or transcript text.
  let header;
  try {header=agent?.session?.requestHeader?.();} catch {}
  const durable=route(header?.config),declared=route(agent?.options),configured=route({provider:policy.summarizationProvider,model:policy.summarizationModel});
  const conversation=durable.provider&&durable.model?durable:declared;
  const summary=configured.provider&&configured.model?configured:conversation;
  return {environment:{nodeVersion:process.version,platform:process.platform,architecture:process.arch,supportedDshVersion:SUPPORTED_DSH_VERSION,actualDshVersion:null},conversation,summary:{...summary,selection:configured.provider&&configured.model?'configured':durable.provider&&durable.model?'session':'agent'},settings:safeSettings(policy)};
}
export function noteDiagnosticMeasurement(measurement,{stage='before',thresholdTokens,targetTokens}={}) {
  const scope=scopes.getStore();if(!scope)return;
  const value={};
  if(Number.isFinite(measurement?.totalTokens)&&measurement.totalTokens>=0)value.estimatedInputTokens=measurement.totalTokens;
  if(['priced','heuristic','mixed','unknown'].includes(measurement?.precision))value.precision=measurement.precision;
  if(Array.isArray(measurement?.nodes))value.visibleMessages=measurement.nodes.length;
  for(const [key,n] of Object.entries({thresholdTokens,targetTokens}))if(Number.isFinite(n)&&n>=0)value[key]=n;
  if(!Object.keys(value).length)return;
  scope.measurements??={};
  if(stage==='before'){scope.measurements.before??=value;Object.assign(scope.measurements.before,value);}
  else if(stage==='after')scope.measurements.after=value;
}
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
    maxTokens:settings.maxTokens,timeoutMs:settings.timeoutMs,retryCount:settings.retryCount,retryDelayMs:settings.retryDelayMs??0,requestStarted:false,usageKnown:false,outcome:'pending'};
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
  if(meta.error){
    row.errors=causes(meta.error);
    const codes=row.errors.map(e=>e.code);
    row.failureKind=codes.some(code=>CONTENT_RETRY_CODES.has(code)||code==='AUDIT_UNAVAILABLE'||/^(?:CONSTRAINT|COVERAGE|SUMMARY_STRUCTURE|PROGRESS_FACT)_/.test(code))?'content-validation'
      :codes.some(code=>/^(?:CONTINUATION_(?:PROGRESS|PERSIST|CALL_BUDGET)|STATE_(?:UNAVAILABLE|INVALID|LOCKED)|ENOSPC|EACCES|EPERM|EIO)/.test(code))?'local-storage-or-budget'
      :row.requestStarted?'request':'local-preflight';
  }
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
function errorChainMessages(error) {
  const parts = [], seen = new Set();
  for (let e = error; e && parts.length < 8 && !seen.has(e); e = e.cause) {
    seen.add(e);
    if (typeof e.message === 'string' && e.message) parts.push(e.message);
  }
  return parts.join('\n');
}
function busyExplanation(error) {
  const msg = errorChainMessages(error);
  if (/open\s+turn/i.test(msg)) return '当前会话存在未结束的对话回合，请等待回复完成后再试。';
  if (/session\s+compaction\s+lock/i.test(msg)) return '检测到当前会话存在未闭合的压缩锁，请先重新打开会话或重试 /compact 自动恢复。';
  if (/already\s+in\s+progress|already\s+active\s+for\s+this\s+logical\s+session/i.test(msg)) return '当前会话已有压缩或迁移任务正在运行，请等待完成或在进度卡片中暂停后再试。';
  return '当前会话正在工作或已有压缩进行中，请空闲后再试。';
}
function extractConstraintMeta(error) {
  const seen = new Set();
  let seq = null;
  let source = null;
  for (let e = error; e && seen.size < 8 && !seen.has(e); e = e.cause) {
    seen.add(e);
    if (seq === null && Number.isSafeInteger(e.constraintSeq) && e.constraintSeq >= 0) seq = e.constraintSeq;
    if (source === null && typeof e.constraintSourceKind === 'string' && /^[A-Za-z0-9@._/:+-]{1,80}$/.test(e.constraintSourceKind)) {
      source = e.constraintSourceKind;
    }
    if ((seq === null || source === null) && typeof e.message === 'string') {
      const m = /\bseq=(\d+)\b(?:,\s*source=([A-Za-z0-9@._/:+-]{1,80}))?/.exec(e.message);
      if (m) {
        if (seq === null && Number.isSafeInteger(Number(m[1]))) seq = Number(m[1]);
        if (source === null && m[2]) source = m[2];
      }
    }
    if (seq !== null && source !== null) break;
  }
  return { seq, source };
}
function extractProvenanceMeta(error) {
  const seen = new Set();
  const inspect = (e) => {
    if (!e || typeof e !== 'object') return null;
    let reason = e.constraintReason === 'provenance' ? 'provenance' : null;
    let line = typeof e.provenanceLine === 'string' && e.provenanceLine.trim() ? e.provenanceLine.trim() : null;
    let kind = typeof e.provenanceKind === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(e.provenanceKind) ? e.provenanceKind : null;
    if (typeof e.message === 'string') {
      const m = /\breason=provenance,\s*kind=([A-Za-z0-9_-]{1,64}),\s*line="([^"]*)"/.exec(e.message);
      if (m) {
        reason = 'provenance';
        kind ??= m[1];
        if (!line && m[2]) line = m[2].trim();
      } else if (/\breason=provenance\b/i.test(e.message)) {
        reason = 'provenance';
      }
    }
    return reason === 'provenance' ? { kind: kind ?? 'missing-source', line: line ?? '' } : null;
  };
  for (let e = error; e && seen.size < 8 && !seen.has(e); e = e.cause) {
    seen.add(e);
    const direct = inspect(e);
    if (direct) return direct;
    if (Array.isArray(e.failures)) {
      for (const sub of e.failures) {
        const subMeta = inspect(sub);
        if (subMeta) return subMeta;
      }
    }
  }
  return null;
}

function findHookCancellation(error) {
  const seen = new Set();
  for (let e = error; e && seen.size < 8 && !seen.has(e); e = e.cause) {
    seen.add(e);
    if (e.hookCancelled === true) return e;
  }
  return null;
}
export function failureExplanation(error) {
  const hookCancel = findHookCancellation(error);
  if (hookCancel) {
    const detail = String(hookCancel.hookReason ?? hookCancel.message ?? '')
      .replace(/^compaction cancelled by weave\/pre-compact hook:\s*/i, '')
      .trim();
    return detail
      ? `本次压缩已被插件钩子（weave/pre-compact）取消：${detail}`
      : '本次压缩已被插件钩子（weave/pre-compact）取消。';
  }
  const budget=continuationBudgetText(error);if(budget)return budget;
  const codes=causes(error).flatMap(x=>[x.code,...(x.failureCodes??[])]);
  const code=codes.find(x=>!['UNKNOWN','summary','commit','persistence','SUMMARY_ALL_FAILED','COMPACTION_AUTOMATIC_BLOCKED','COMPACTION_CAPACITY_BLOCKED'].includes(x))??codes[0]??'UNKNOWN';
  if(codes.includes('RECOVERY_REQUIRED')||error?.compactionStage==='commit'||['commit','persistence'].includes(error?.code))return `压缩未能正常提交或保存（${code}）。部分步骤可能已完成，请先检查保留的恢复记录，再决定是否重试。`;
  const timeout=summaryTimeoutText(error);if(timeout)return timeout;
  if(codes.some(c=>/^(?:TIMEOUT|ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)$/.test(c)))return `摘要服务连接或响应超时（${code}），本次压缩未完成。请查看诊断中的尝试次数和用量。`;
  if(code==='COMPACTION_INVALID_BUDGET'||codes.includes('COMPACTION_INVALID_BUDGET'))return '上下文窗口消息预算不足（COMPACTION_INVALID_BUDGET）：模型窗口（contextWindow）扣除预留输出上限（maxTokens）后剩余可用消息预算小于或等于 0。请检查当前会话模型的 contextWindow、请求或默认 maxTokens 预留输出上限，或在配置中通过 windowProviderMap 为该模型指定正确的上下文窗口大小后重试。';
  if(code==='COMPACTION_RETAIN_EXCEEDS_THRESHOLD'||codes.includes('COMPACTION_RETAIN_EXCEEDS_THRESHOLD'))return '压缩保留预算大于或等于触发阈值（COMPACTION_RETAIN_EXCEEDS_THRESHOLD）：retainTokens（或按 retainRatio 计算的保留量）必须严格小于压缩触发线 thresholdTokens。请检查并调低 retainTokens / retainRatio，或调高 thresholdRatio、contextWindow / windowProviderMap，或检查 maxTokens 预留输出上限是否过大后重试。';
  if(code==='busy')return busyExplanation(error);
  if(code==='SPAN_CHANGED'||code==='changed')return '压缩期间会话内容发生变化，本次替换已停止，请稍后重试。';
  if(code==='PROGRESS_FACT_CONFLICT')return '摘要与已有进度事实冲突，已按设置重试；未提交不合格摘要，原上下文保留。';
  if(/PROGRESS_SOURCE|PROGRESS_SELECTION/.test(code))return `进度事实的原始来源无法可靠核验（${code}），已停止本次压缩并保留原上下文。`;
  if(code==='CHECKPOINT_PRESERVED_UNREADABLE')return '无法解析历史检查点中的保留来源（CHECKPOINT_PRESERVED_UNREADABLE）。若当前会话曾使用 billion-context 等外部压缩插件，请先在界面点击「兼容转换为 Weave」（自动备份后迁移），再执行压缩。';
  if(code==='CONTINUATION_TOOL_GROUP_OPEN')return '当前会话尾部存在未闭合的工具调用组（CONTINUATION_TOOL_GROUP_OPEN），无法在工具调用中途执行续传压缩；请等待当前工具调用完成或修复工具配对后重试。';
  if(code==='ARCHIVE_SOURCE_INVALID')return '归档工具调用引用超出单次上限或无法核验（ARCHIVE_SOURCE_INVALID）；已停止提交并保留原上下文，建议分波压缩或通过兼容迁移归档旧历史。';
  if(code==='BACKUP_RESTORE_UNAVAILABLE')return '当前宿主事务适配器不可用，无法在线挂载备份还原（BACKUP_RESTORE_UNAVAILABLE）。请完全关闭 DSH 后再执行离线还原。';
  if(code==='BILI_BACKUP_FAILED'||/^BACKUP_(?:VERIFICATION_FAILED|ENCODING_MISMATCH|RESTORE_INVALID|NOT_FOUND)$/.test(code))return `会话备份或校验未通过（${code}），已中止操作且未改动原会话文件。请检查磁盘空间、文件权限或编码匹配后重试。`;
  if(code==='BILI_MIGRATION_FAILED')return 'billion-context 会话兼容迁移未完成（BILI_MIGRATION_FAILED）。迁移前已创建的完整备份保留在本地，可根据提示还原。';
  if(code==='TOOL_PAIRING_BROKEN'||code==='TOOL_PAIRING_IMBALANCED'||(code==='UNKNOWN'&&typeof error?.message==='string'&&/tool-pairing balance/i.test(error.message)))return '检测到会话工具调用与结果配对失衡（TOOL_PAIRING_BROKEN），常见于外部插件局部折叠打断了 tool-call/tool-result；已停止压缩并保留原上下文，请先通过「兼容转换为 Weave」整体封装修复。';
  if(code==='UNSUPPORTED_REASONING_EFFORT'||codes.includes('UNSUPPORTED_REASONING_EFFORT'))return '摘要模型不支持当前推理强度参数（UNSUPPORTED_REASONING_EFFORT），自动降档后仍未成功。请前往「设置 → 摘要模型 → 摘要推理强度」设为 none 或该模型支持的档位后重试。';
  if(code==='CONSTRAINT_POLARITY_LOST'||codes.includes('CONSTRAINT_POLARITY_LOST')){
    const meta=extractConstraintMeta(error);
    const details=[meta.seq!==null?`seq=${meta.seq}`:null,meta.source?`source=${meta.source}`:null].filter(Boolean).join(', ');
    const where=details?`（${details}）`:'';
    return `摘要未通过约束极性保留检查（CONSTRAINT_POLARITY_LOST${where}）。为防止把禁止/要求改写成相反含义，即使关闭了 auditBlockOnLoss（auditBlockOnLoss: false），极性拦截仍会强制阻断提交；请查看诊断中的 audit-reject 文件定位对应原话，若触发消息来自第三方消息桥接或非用户通道，可将其 source.kind 加入 extraReferenceSourceKinds（或裸前缀加入 extraReferencePrefixes），也可切换更稳定的摘要模型，或在极端历史会话兼容场景临时设置 auditEnabled: false 后重试。`;
  }
  const prov=extractProvenanceMeta(error);
  if(prov){
    const kindLabel=prov.kind==='untrusted-source'?'非可信注入或外部通道':prov.kind==='revoked'?'已被用户撤回的旧授权':'未匹配到用户原始授权';
    const lineDetail=prov.line?`；触发摘要句：「${prov.line}」`:'';
    const guidance=prov.kind==='untrusted-source'||prov.kind==='revoked'
      ? '此类命中（untrusted-source / revoked）属于强拦截，即使关闭 auditBlockOnLoss 或 auditProvenanceBlock 仍会阻断提交；请查看诊断中的 audit-reject 文件定位对应原话，将非用户桥接通道的 source.kind 加入 extraReferenceSourceKinds 或裸前缀加入 extraReferencePrefixes，或更换更遵守边界的摘要模型。'
      : '仅关闭 auditBlockOnLoss 不会跳过来源审计（provenance）；请查看诊断中的 audit-reject 文件核对是否需要改用更遵守边界的摘要模型，若确认为口语误报且仅需降级为警告，可在配置中设置 auditProvenanceBlock: false（对非可信来源与已撤回授权仍保持强拦截）。';
    return `摘要未通过指令来源审计（${code}，reason=provenance，类型=${kindLabel}［${prov.kind}］${lineDetail}）。${guidance}`;
  }
  if(/CONSTRAINT|COVERAGE|AUDIT|RETIRED_MEMORY/.test(code))return `摘要未通过要求保留检查（${code}），未提交不合格摘要。`;
  if(/STRUCTURE|EMPTY_SUMMARY|SUMMARY_INVALID|NOT_SMALLER|TOO_LARGE|MAX_TOKENS/.test(code))return `摘要格式、长度或压缩效果未通过检查（${code}），未提交不合格摘要。`;
  if(codes.some(c=>/CONTINUATION_(PROGRESS|PERSIST)|ARCHIVE|STATE_(?:UNAVAILABLE|INVALID|LOCKED)|ENOSPC|EACCES|EPERM|EBUSY|EIO/.test(c)))return `压缩进度或历史记录无法可靠读取、保存（${code}）。已停止自动重试，请检查存储状态。`;
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
  return `${count}诊断编号：${r.id}。${r.status==='saved'?`诊断日志：${r.path}。`:`诊断日志保存失败（${r.writeError}），请保留本条提示；错误码：${r.code}，阶段：${r.stage}。`}${audit}提交日志是可选的，相关日志通常能更快定位问题；日志或关联审计材料可能含私人路径、模型标识及对话内容，分享前请检查并脱敏。AI 脱敏也可能遗漏隐私。`;
}

export class FailureDiagnostics {
  constructor(storageRoot,{timeoutMs=2000,onFailureReceipt=null}={}){this.root=join(storageRoot,'diagnostics');this.commands=new WeakMap();this.timeoutMs=timeoutMs;this.onFailureReceipt=typeof onFailureReceipt==='function'?onFailureReceipt:null;}
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
        if(!scope.terminal&&(scope.attempts.some(x=>x.outcome==='failed')||scope.auditReports.length||scope.pendingAudits.length))await this.write(scope,null,'recovered');
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
    const existing=diagnosticFor(error);
    if(existing){
      try{this.onFailureReceipt?.(session,existing,error);}catch{}
      return existing;
    }
    const active=scopes.getStore();
    const scope=active?.owner===this&&active.session===session?active:{owner:this,session,id:randomUUID(),context,startedAt:new Date().toISOString(),attempts:[],totalAttempts:0,omittedAttempts:0,auditReports:[],pendingAudits:[]};
    scope.terminal=true;
    const receipt=await this.write(scope,error,'failed');
    if(error&&typeof error==='object')receipts.set(error,receipt);
    this.remember(session,context.commandId??scope.context.commandId,receipt);
    try{this.onFailureReceipt?.(session,receipt,error);}catch{}
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
    const payload={kind:'compaction-weave/failure-diagnostic',version:2,pluginVersion:PLUGIN_VERSION,id:scope.id,outcome,
      startedAt:scope.startedAt,endedAt:new Date().toISOString(),sessionHash:hashId(scope.session?.id),commandHash:hashId(scope.context.commandId),trigger:safeCode(scope.context.trigger),stage,
      context:safeContext(scope.context.reportContext),measurements:scope.measurements??null,
      errors:chain,attempts:scope.attempts,totalAttempts:scope.totalAttempts,omittedAttempts:scope.omittedAttempts,auditReports:scope.auditReports,
      retryLimit:error?.summaryAttemptLimit??null,committedChunks:Array.isArray(error?.compactionIds)?error.compactionIds.length:null,
      sharing:{optional:true,mayContainPrivateMetadata:true,relatedAuditMayContainConversationText:true,automaticRedactionGuaranteed:false}};
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
