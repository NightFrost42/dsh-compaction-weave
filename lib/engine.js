import {collectProgressFacts, progressSourceRefs, renderProgressFacts, renderSummaryScope, validateProgressFacts} from './progress-facts.js';
import {FailureDiagnostics,diagnosticFor,diagnosticText,failureExplanation,transferDiagnostic,diagnosticContext,noteDiagnosticMeasurement} from './failure-diagnostics.js';
import {collectWorkReport, workReportRef, scopeWorkReport} from './work-report.js';
import {ProactiveCompaction} from './proactive.js';
import {selectCachePreservingRange} from './cache-policy.js';
import {sourceBreakerRecoverable} from './source-recovery.js';
import {readPendingContinuation,assertPendingSource,freezeContinuation,bindContinuationProgress,settleContinuation,releaseUnstartedContinuation} from './continuation-pending.js';
import {continuationBudgetInfo,continuationBudgetText} from './continuation-budget.js';
import { prepareContinuation, planContinuationMemory, residentConstraints, hasContinuation, continuationEligible, selectContinuationRange } from './continuation.js';
import { Buffer } from 'node:buffer';
import { resolveSummaryCapacity, planSummaryRange, measureSummaryRange, combineCompactionResults } from './summary-budget.js';
import { combineSignals } from './abort.js';
import { SessionStateStore } from './state.js';
import { dirname, join } from 'node:path';
const activeTransactions = new Set();
import { materializeUserMessageSection } from './validate.js';
import { reconstructDisputedLines } from './reconstruct.js';
// 压缩引擎主体。
//
// 本文件不 import 任何 `@deepseek-ai/*` 包。插件目录与 profile 目录都解析不到
// 这些包（本地是 junction 安装，target 已失效，裸导入在加载期即
// ERR_MODULE_NOT_FOUND）。宿主侧也不对引擎做 `instanceof CompactionEngine`
// 检查，所以鸭子类型实现三个方法即可被 `/compact` 和 agent-loop 正常消费。
//
// 三个方法（与官方 CompactionEngine 抽象接口一致）：
//   compactIfNeeded(agent, trigger, signal) → CompactionResult | null
//   compactNow(agent, signal, sourceCommandId?) → CompactionResult | null
//   compactRegion(start, end, agent, signal?) → CompactionResult
//
// 七层落点：
//   L1 窗口      → lib/window.js（固定 window，独立 safetyWindow 单调收紧）
//   L2 触发      → compactIfNeeded 里 thresholdTokens 判定
//   L3 摘要模型  → lib/summary.js（目标链 + 超时 + 降级）
//   L4 模板      → lib/prompt.js（九段式，近期原话只渲染一份）
//   L5 保留      → collectInstructionMessages + buildCheckpointBlocks
//   L6 溢出收敛  → compaction/summary-error waterfall（多留一组再试）
//   L7 失败熔断  → failureThreshold + 每次成功后清零

import { resolveCompactSpec, resolveTargetPolicy } from './config.js';
import { lockWindow, contextWindowOf, defaultMaxTokensOf } from './window.js';
import {memoryRequirements, memorySourceRefs, memoryPolicyInstruction, deduplicateNotes, retiredMemoryPresent} from './memory-policy.js';
import { approxTokens, blocksToText } from './meter.js';
import { dumpAuditRejection } from './audit-reject.js';
import {
  selectCompactableRange,
  validateSurfaceRegion,
  inspectCompactionEntryState,
  assertCompactionInactive,
  buildSummarizationInput,
  collectInstructionMessages,
  selectSessionMemory,
  buildCheckpointBlocks,
  preservedForSource,
  systemHead,
} from './region.js';
import { summarizeWithChain, resolveSummaryTargets, latestDurableTarget } from './summary.js';
import { asHostManualError } from './manual-error.js';
import {summaryTimeoutInfo,summaryTimeoutText} from './summary-timeout.js';
import { CHECKPOINT_PREAMBLE } from './prompt.js';
import { CompactionArchive, spanEntries } from './history.js';
import { CompactionJournal } from './journal.js';
import {auditMemorySelection} from './constraint-scope.js';
import {
  validateSummaryStructure,
  validateCheckpointCoverage,
  validateUserMessageSection,
} from './validate.js';

const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED';

const COMPACT_CHECKPOINT_KIND = 'compact-checkpoint';

/**
 * 这次失败是不是"被取消"而不是"出错"。
 *
 * 两种来源都要认：
 * - 错误对象自己带 `ABORTED`（`lib/summary.js` 里超时/中止时这么标）；
 * - 传入的 signal 已经 aborted，且错误就是那个 reason（agent 收回维护窗口、
 *   用户按 Esc）。
 *
 * 判错的代价不对称：把取消当故障计入熔断，连续三次取消就会让这个会话
 * **永久**不再自动压缩（`_stopped`），而用户其实什么都没做错。
 */
function isAbortError(error, signal) {
  if (!error) return false;
  if (error.code === 'ABORTED' || error.name === 'AbortError') return true;
  if (signal?.aborted === true && (error === signal.reason || error?.cause === signal.reason)) return true;
  return false;
}

/**
 * `expected` 里有、但 `preserved` 里没有的那些用户消息的 seq。
 *
 * 两份列表来自同一次扫描，`preserved` 只是按上限从**最新往前**截出来的后缀，
 * 所以"少了哪些"就是被截掉的那个前缀。用 `seq + 正文` 当身份：跨代续传的
 * 老原话 seq 可能是 -1，单看 seq 会把它们全判成同一条。
 */
function missingPreservedSeqs(expected, preserved) {
  const key = (item) =>
    `${typeof item?.seq === 'number' ? item.seq : -1}\u0000${typeof item?.text === 'string' ? item.text : ''}`;
  const kept = new Set((Array.isArray(preserved) ? preserved : []).map(key));
  const missing = [];
  for (const item of Array.isArray(expected) ? expected : []) {
    if (kept.has(key(item))) continue;
    const seq = typeof item?.seq === 'number' ? item.seq : -1;
    if (!missing.includes(seq)) missing.push(seq);
  }
  return missing;
}

/**
 * 官方 `compactCheckpointSource` 的等价实现（纯函数）。
 *
 * 与官方相比多带一个可选的 `preserved`：被压区间里用户原话的**结构化**副本。
 * 没有它，下一代压缩只能从渲染后的文本里反解析原话（分隔符、块边界、用户
 * 原文里恰好出现 `--- seq N ---` 都会让解析出错），或者干脆把最早的原话丢掉
 * —— 两种都会让"逐字保留"在一两代之后名存实亡。
 *
 * `kind` 仍是 `compact-checkpoint`，宿主 `isCompactCheckpointSource` 照常认得；
 * 多出来的字段不影响识别（宿主只检查 `source.kind`）。
 */
export function compactCheckpointSource(compactionId, sourceCommandId, preserved) {
  const source = { kind: COMPACT_CHECKPOINT_KIND, compactionId };
  if (sourceCommandId !== undefined) source.sourceCommandId = sourceCommandId;
  if (Array.isArray(preserved) && preserved.length > 0) source.preserved = preserved;
  return Object.freeze(source);
}

export function isCompactCheckpointSource(source) {
  return Boolean(source) && source.kind === COMPACT_CHECKPOINT_KIND;
}

let compactionCounter = 0;
function nextCompactionId() {
  compactionCounter += 1;
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `weave-${stamp}-${rand}-${compactionCounter}`;
}

/**
 * 生成一个消息 id。宿主用 `randomUUID()` 造消息身份
 * （`createMessage` 里 `id: brandString(randomUUID())`），而 `user/message`
 * 事件的校验强制要求非空 `id`。这里不 import `node:crypto` 的具名导出以外的东西，
 * 保持零运行时依赖。
 */
let messageCounter = 0;
function newMessageId() {
  messageCounter += 1;
  const globalCrypto = globalThis.crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `msg-${stamp}-${rand}-${messageCounter}`;
}

export class WeaveCompactionEngine {
  /**
   * @param {object} ctx
   * @param {Readonly<Record<string, any>>} config
   */
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.name = 'compaction';

    /**
     * ⚠️ 失败计数与熔断必须按**逻辑会话**记，不能按对象记。
     *
     * 会话对象会被宿主重建：进程重启后从磁盘恢复、UI 里切一次分支、
     * 或者 agent 被重新组装，拿到的都是新对象。按对象记的后果是：
     * 每次重建计数器归零、熔断闸门消失 —— 一个"每次都失败"的会话
     * 只要用户重开一次就又能白试三轮，永远到不了"连续三次就别再试了"。
     *
     * 所以键取 `session.id`；拿不到稳定 id 时才退回对象身份（那时也确实
     * 没有别的办法判断"是不是同一个会话"）。
     *
     * @type {Map<object|string, number>} 连续失败次数
     */
    this._failures = new Map();
    /** @type {WeakMap<object, number>} 溢出重试次数 */
    this._overflowRetries = new WeakMap();
    /** @type {WeakMap<object, number>} 上次压缩后的 token 数，用于 minGrowthTokens */
    this._lastTotal = new WeakMap();
    /** @type {WeakMap<object, string|null>} 上次摘要正文，用于 PRIOR checkpoint 合并 */
    this._lastSummary = new WeakMap();
    /** @type {Map<object|string, true>} 已停压的会话（键同 `_failures`） */
    this._stopped = new Map();
    /** @type {Set<object>} 正在压缩的会话，防重入 */
    this._busy = new Set();
    this._recoveryBlocked = new Set();
    /** @type {WeakMap<object, object>} session → 正在为它压缩的 agent */
    this._agentBySession = new WeakMap();

    /** @type {WeakMap<object, Map<number, number>>} 最近一次计价的 per-seq token */
    this._lastPriced = new WeakMap();

    /**
     * @type {WeakMap<object, 'priced'|'heuristic'|'mixed'|'unknown'>}
     * 最近一次计量的口径。必须**跟着数字一起往下传**：下游拿 `shadowedTokenCount`
     * 去跟摘要比大小、去算压缩比，如果不知道这个数是实测还是 4 字符一 token 的
     * 粗估，就没法判断"压完只小了一点点"到底是真的还是估算噪声。
     */
    this._lastPrecision = new WeakMap();

    this.archive = new CompactionArchive({ root: config.archiveDir });
    this.diagnostics = new FailureDiagnostics(dirname(this.archive.root));
    /** Durable decisions and stock-adapter backup metadata. Successful stock
     * transactions publish only after this journal records committed; cold
     * recovery runs in the root adapter before Session construction. */
    this.journal = CompactionJournal.alongside(this.archive.root);
    this.sessionState = new SessionStateStore(join(dirname(this.archive.root), 'state'));
    this.proactive = new ProactiveCompaction(this);
    this._registerHooks();
    this._provideService();
  }

  /**
   * 插件卸载时调用。这里不主动删 surface 上的任何事件（压缩是持久事实，
   * 卸载插件不应该回滚已经写进会话的历史），只把内存态清掉。
   */
  dispose() {
    this.proactive.dispose();
    this._busy.clear();
    this._recoveryBlocked.clear();
    this._stopped.clear();
    this._failures.clear();
    this._overflowRetries = new WeakMap();
    this._lastTotal = new WeakMap();
    this._lastSummary = new WeakMap();
    this._lastPriced = new WeakMap();
    this._lastPrecision = new WeakMap();
    this._agentBySession = new WeakMap();
  }

  /**
   * 熔断与失败计数用的键：优先用稳定逻辑标识（`session.id`），
   * 拿不到才退回对象本身。见构造函数里 `_failures` 的说明。
   * @param {object|undefined} session
   */
  _keyOf(session) {
    const id = session?.id;
    if (typeof id === 'string' && id.length > 0) return id;
    return session;
  }

  // ────────────────────────────────────────────────────────────── 服务注册

  _provideService() {
    const ctx = this.ctx;
    try {
      if (typeof ctx.provide === 'function') {
        ctx.provide('compaction', this);
        return;
      }
      if (typeof ctx.reflect?.provide === 'function') {
        ctx.reflect.provide('compaction', this);
        return;
      }
      this.log('warn', 'ctx.provide is unavailable; the compaction service was not registered');
    } catch (error) {
      // 组内可能已经有官方实例（isolate 隔离），此时本引擎只作为备用不被采用。
      this.log('warn', `compaction service registration skipped: ${error?.message ?? error}`);
    }
  }

  // ────────────────────────────────────────────────────────────── 自动钩子

  _registerHooks() {
    const ctx = this.ctx;
    if (typeof ctx.on !== 'function') return;

    ctx.on('agent/pre-step', async (payload, next) => {
      const agent = payload?.agent;
      const signal = payload?.signal;
      if (agent && signal && !signal.aborted) {
        // 上一次进程（或上一次崩溃）可能留了一把没关上的压缩锁。补 end 是
        // 幂等的，且必须**早于**任何压缩尝试 —— 否则 `assertCompactionInactive`
        // 会把这次压缩挡回去，锁永远打不开。
        try {
          await this.recoverPending(agent.session);
        } catch (error) {
          const blocked = new Error(`compaction recovery must complete before another model request: ${error?.message ?? error}`);
          blocked.code = 'RECOVERY_REQUIRED'; blocked.compactionStage = 'commit'; blocked.cause = error; this._restoreClaimedInput(agent,payload.messages);
          await this.diagnostics.capture(agent.session,blocked,{trigger:'recovery',reportContext:this._diagnosticContext(agent)});
          throw this._visibleFailure(blocked);
        }
        try {
          const proactive = await this.diagnostics.run(agent.session,{trigger:'proactive',signal,reportContext:this._diagnosticContext(agent)},()=>this.proactive.consume(agent, signal, payload.messages));
          const checkPressure = !proactive || ['skipped','cancelled'].includes(proactive.status);
          const result = checkPressure && this.config.auto ? await this.compactIfNeeded(agent, 'pressure', signal) : null;
          if (result) this.log('info', `pressure compaction done: ${describeResult(result)}`);
          if(this.config.auto) await this._guardRequestBudget(agent,signal);
        } catch (error) {
          if (!isAbortError(error,signal)) await this.diagnostics.capture(agent.session,error,{trigger:'automatic',reportContext:this._diagnosticContext(agent)});
          if (summaryTimeoutInfo(error)) { this._restoreClaimedInput(agent,payload.messages); throw this._automaticFailure(agent.session,error); }
          if (['RECOVERY_REQUIRED', 'COMPACTION_CAPACITY_BLOCKED'].includes(error?.code)) { this._restoreClaimedInput(agent,payload.messages); throw this._visibleFailure(error); }
          if (isAbortError(error,signal)) throw error;
          this.log('warn', `step compaction failed: ${error?.message ?? error}; stopping before the model request`);
          this._restoreClaimedInput(agent,payload.messages);
          throw this._automaticFailure(agent.session,error);
        }
      }
      return next();
    });

    ctx.on('agent/status', (payload) => {
      const agent = payload?.agent;
      if (!agent) return;
      if (payload.status === 'running') {
        const session = agent.session;
        const open = inspectCompactionEntryState(session).unmatchedCompactionStart;
        const ownOpen = open !== null && String(session.eventAt(open)?.data?.compactionId ?? '').startsWith('weave-');
        // Public status notification precedes turn/start. Prevent a new turn
        // crossing an unfinished compaction, which the stock reader rejects.
        if (this._recoveryBlocked.has(this._keyOf(session)) || ownOpen) {
          agent.cancel({ kind: 'hook', reason: 'Compaction recovery must complete before another turn. Use /compact to inspect recovery.' }, { keepInbox: true });
          this.log('warn', 'Pending compaction blocks a new turn; input remains queued. Recovery journal is retained.');
        }
      } else if (payload.status === 'idle') this._overflowRetries.delete(agent);
    });

    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'assistant/message') return;
      // `_busy` 里放的是 session，不是 agent；agent 只能从 `_agentBySession` 取。
      const agent = this._agentBySession.get(session);
      if (agent) this._overflowRetries.delete(agent);
    });

    ctx.on('agent/request-error', async (payload, next) => {
      const agent = payload?.agent;
      const failure = payload?.failure;
      const signal = payload?.signal;
      if (!agent || signal?.aborted) return next();
      if (failure?.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next();
      if (!this.config.auto) return next();

      // 溢出重试上限也要走**逐模型策略**。宿主就是这么做的：
      // `routedTarget(agent.session)` → `resolveTargetPolicy(this.config, target)`
      // → 比较 `policy.maxOverflowRetries`
      // （`dsh-compaction-basic/lib/index.js:861-868`）。
      // 只读全局值的话，给某个模型单独配 `maxOverflowRetries: 0`（明确禁止为它
      // 溢出压缩）会被全局值盖掉，配置写了等于没写。
      const target = latestDurableTarget(agent);
      const policy =
        target === undefined ? this.config : resolveTargetPolicy(this.config, target.provider, target.model);

      const retries = this._overflowRetries.get(agent) ?? 0;
      if (retries >= policy.maxOverflowRetries) return next();

      const generation = agent.session?.surface?.replaceGeneration ?? 0;
      try {
        const result = await this.compactIfNeeded(agent, 'context-overflow', signal);
        if (signal?.aborted) return next();
        const advanced = (agent.session?.surface?.replaceGeneration ?? 0) > generation;
        if (!advanced && result === null) return next();
        this._overflowRetries.set(agent, retries + 1);
        return { kind: 'retry' };
      } catch (error) {
        if (signal?.aborted) return next();
        await this.diagnostics.capture(agent.session,error,{trigger:'context-overflow',reportContext:this._diagnosticContext(agent)});
        if (['RECOVERY_REQUIRED', 'COMPACTION_CAPACITY_BLOCKED'].includes(error?.code)) throw this._visibleFailure(error);
        if (!signal?.aborted && !error?.surfaceRestored && (agent.session?.surface?.replaceGeneration ?? 0) > generation) {
          this.log(
            'warn',
            `context-overflow compaction failed after in-memory surface replacement: ${error?.message ?? error}; retrying from the replacement surface`,
          );
          this._overflowRetries.set(agent, retries + 1);
          return { kind: 'retry' };
        }
        this.log('warn', `context-overflow compaction failed: ${error?.message ?? error}`);
        throw this._visibleFailure(error,'上下文超限后的压缩补救未完成。');
      }
    });

    // L6：官方把这条做成 waterfall，返回 true = "已同步记录了持久变更，可以重试"。
    // 我们的策略：把保留尾多留一组（reactiveStep 条），重算范围后再压一次。
    ctx.on('compaction/summary-error', async (payload, next) => {
      const session = payload?.session;
      if (!session) return next();
      if (payload?.error?.code === 'SUMMARY_TIMEOUT' || payload?.error?.code === 'SUMMARY_ALL_FAILED') {
        return next();
      }
      const agent = findAgentForSession(this, session);
      if (!agent) return next();
      try {
        const retried = await this._reactiveRetry(agent, payload?.signal);
        return retried === true;
      } catch (error) {
        this.log('warn', `reactive compaction retry failed: ${error?.message ?? error}`);
        return next();
      }
    });
  }

  /**
   * 溢出/prompt-too-long 时的渐进收敛：每次多保留一组最近消息，少压一点。
   * @param {object} agent
   * @param {AbortSignal|undefined} signal
   */
  async _reactiveRetry(agent, signal) {
    const session = agent?.session;
    if (!session) return false;
    // ⚠️ 熔断闸门必须在**每一个**自动/恢复入口上复查。
    // 这个方法是 `compaction/summary-error` 的监听器调进来的，而那条 waterfall
    // 是外部（宿主或别的插件）发起的 —— 它不知道我们已经"连续三次失败、
    // 别再试了"。少了这一行，用户会看到第 4 次、第 5 次摘要请求照发不误，
    // 每一次都注定失败，只是把失败计数继续往上推。
    this._restoreState(session);
    if (this._stopped.has(this._keyOf(session))) return false;
    // 我们自己正在压这个会话时绝不重入：`_compactSpan` 已经在 catch 路径上
    // 做过渐进收敛了，这里再压一次会和外层事务抢同一个 surface 锁。
    if (this._busy.has(session)) return false;
    const nodes = session.surface?.nodes ?? [];
    if (nodes.length < 3) return false;

    const measurement = await this._measure(session);
    if (!measurement) return false;

    let spec;
    try { spec = await this._resolveSpec(agent, measurement, signal); }
    catch (error) { if (!isAbortError(error, signal)) this._recordFailure(agent, session, error); throw error; }
    if (!spec) return false;

    // ⚠️ 这里的重试也必须**严格缩小**跨度，理由与 `compactIfNeeded` 里的
    // `reselect` 完全相同：`extra` 只把保留量往上推，如果推完选出来的还是
    // 同一段（大尾节点把可压前缀卡住时很常见），这次重试就是拿一模一样的
    // 输入再烧一次摘要调用 —— 三次重试全打在同一段上，最后照样失败，
    // 只是多花了两轮钱。
    let previousEndIdx = -1;
    for (let extra = 1; extra <= this.config.reactiveStep; extra += 1) {
      if (signal?.aborted) return false;
      // 每一轮重试前复查熔断：上一轮的失败可能刚好把它推过了阈值。
      this._restoreState(session);
    if (this._stopped.has(this._keyOf(session))) return false;
      let retain = spec.retainTokens + extra * Math.max(1024, Math.floor(spec.retainTokens * 0.25));
      let range = null;
      for (let step = 0; step < 64; step += 1) {
        const remeasured = step === 0 ? measurement : await this._measure(session);
        if (!remeasured) return false;
        const candidate = selectCompactableRange(session, remeasured, retain);
        if (!candidate) break;
        const endIdx = nodes.indexOf(candidate.end);
        if (previousEndIdx < 0 || (endIdx >= 0 && endIdx < previousEndIdx)) {
          range = candidate;
          break;
        }
        retain = Math.ceil(retain * 1.5) + 1024;
      }
      if (!range) {
        this.log('warn', 'reactive recovery found no strictly smaller span; giving up instead of repeating the same request');
        return false;
      }
      try {
        await this.compactRegion(range.start, range.end, agent, signal);
        this.log('info', `reactive compaction succeeded with retainTokens=${retain}`);
        return true;
      } catch (error) {
        if (signal?.aborted) return false;
        const endIdx = nodes.indexOf(range.end);
        if (endIdx >= 0) previousEndIdx = endIdx;
        this.log('warn', `reactive attempt ${extra} failed: ${error?.message ?? error}`);
      }
    }
    return false;
  }

  _restoreClaimedInput(agent,messages) {
    // pre-step runs after Inbox.claim and before user/message is committed.
    // Requeue through the host's durable Inbox API without waking the driver.
    if(!Array.isArray(messages)||!messages.length)return;
    if(typeof agent.inbox?.prepend!=='function')throw new Error('Compaction stopped; host inbox cannot restore claimed input.');
    for(const message of [...messages].reverse()){
      if([...(agent.inbox.nextStep??[]),...(agent.inbox.nextTurn??[])].some(m=>m.id===message.id))continue;
      agent.inbox.prepend('next-step',message);
    }
  }

  failureForCommand(session,commandId) { return this.diagnostics.forCommand(session,commandId); }

  _visibleFailure(error,prefix='') {
    const visible=new Error(prefix+failureExplanation(error)+diagnosticText(error));
    visible.code=error?.code??'COMPACTION_FAILED';
    visible.compactionStage=error?.compactionStage;
    return transferDiagnostic(error,visible);
  }

  _automaticFailure(session, error) {
    if(error?.code==='COMPACTION_AUTOMATIC_BLOCKED'){
      if(diagnosticFor(error)&&!error.message.includes('诊断编号：'))error.message+=diagnosticText(error);
      return error;
    }
    const key=this._keyOf(session), stopped=this._stopped.has(key);
    const code=typeof error?.code==='string'&&/^[A-Z_]{1,64}$/.test(error.code)?error.code:'COMPACTION_FAILED';
    // AgentLoop records the thrown error in native turn/end; trajectory renders
    // reason.error.message. No synthetic command or unsupported event is used.
    const timeoutText=summaryTimeoutText(error);
    const budgetText=continuationBudgetText(error);
    if(budgetText)return transferDiagnostic(error,Object.assign(new Error(`${budgetText}本轮尚未发送主对话请求。${diagnosticText(error)}`),{code:'COMPACTION_AUTOMATIC_BLOCKED',failureCode:'CONTINUATION_CALL_BUDGET'}));
    const blocked=new Error(timeoutText ? `${timeoutText}本轮尚未发送主对话请求。${stopped?'自动压缩已熔断。':''}` : `自动压缩未能完成，本轮已在发送模型请求前停止（${code}）。${stopped?'自动压缩已熔断。':''}原始会话保留；可用 /compact 重试。`);
    if(diagnosticFor(error)) blocked.message=(timeoutText??failureExplanation(error))+`本轮尚未发送主对话请求。${stopped?'自动压缩已熔断。':''}`+'检查后可用 /compact 重试。'+diagnosticText(error);
    blocked.code='COMPACTION_AUTOMATIC_BLOCKED';
    blocked.failureCode=code;
    if(timeoutText){blocked.failureCode='SUMMARY_TIMEOUT';blocked.timeoutMs=summaryTimeoutInfo(error).timeoutMs;}
    return transferDiagnostic(error,blocked);
  }

  async _guardRequestBudget(agent,signal) {
    const measurement=await this._measure(agent.session);
    if(!measurement || signal?.aborted)return;
    const spec=await this._resolveSpec(agent,measurement,signal);
    if(spec && measurement.totalTokens>=spec.messageBudgetTokens){
      throw this._automaticFailure(agent.session,{code:'COMPACTION_REQUEST_BUDGET_EXCEEDED'});
    }
  }

  // ────────────────────────────────────────────────────────────── 三个方法

  /**
   * 自动压缩入口。
   * @param {object} agent
   * @param {'pressure'|'context-overflow'} trigger
   * @param {AbortSignal} signal
   */
  async compactIfNeeded(agent, trigger, signal) {
    return this.diagnostics.run(agent?.session,{trigger,signal,reportContext:this._diagnosticContext(agent)},()=>this._compactIfNeededInner(agent,trigger,signal));
  }

  _diagnosticContext(agent) {
    // Logging must remain observational even if host model-policy lookup fails.
    try {return diagnosticContext(agent,this._resolvePolicy(agent));}
    catch {return diagnosticContext(agent,this.config);}
  }

  async _compactIfNeededInner(agent, trigger, signal) {
    const session = agent?.session;
    if (!session) return null;
    this._restoreState(session);
    const stopped = this._stopped.has(this._keyOf(session));
    if (this._busy.has(session)) return null;
    if (signal?.aborted) return null;
    let pendingContinuation = readPendingContinuation(this.sessionState, session);
    if (pendingContinuation) { await this.recoverPending(session); pendingContinuation = readPendingContinuation(this.sessionState, session); }

    const measurement = await this._measure(session);
    if (!measurement) return null;

    let spec;
    try { spec = await this._resolveSpec(agent, measurement, signal); }
    catch (error) { if (!stopped && !isAbortError(error, signal)) this._recordFailure(agent, session, error); throw error; }
    if (!spec) return null;

    const total = measurement.totalTokens;
    noteDiagnosticMeasurement(measurement,{thresholdTokens:spec.thresholdTokens});
    if (stopped) {
      if (pendingContinuation || (trigger === 'pressure' && total >= spec.thresholdTokens)) throw this._automaticFailure(session,{code:'COMPACTION_STOPPED'});
      return null;
    }
    if (trigger === 'pressure' && !pendingContinuation) {
      if (total < spec.thresholdTokens) return null;
      // 计量口径不精确时，把"离阈值还有多远"写进日志。
      // 这是唯一能让用户自己判断"我的会话是不是其实早就该压了"的信息 ——
      // 数字本身看不出来它是真分词还是 4 字符/token 的粗估。
      if (measurement.precision !== 'priced' && this.config.debug) {
        this.log(
          'info',
          `token measurement is ${measurement.precision} (not exact); total ${total} vs threshold ${spec.thresholdTokens}`,
        );
      }
      // 把**同一套容量口径**写进日志：触发判定用的是"输入侧实测/粗估总量"，
      // 而窗口预算扣的是"这次请求实际会用的输出上限"（`requestHeader` 里的
      // `maxTokens`，缺省回退适配器默认值）。两者必须能对上账，否则用户看到
      // 的"还有余量"和供应商那边的 413 会是两回事，无从判断该调哪个参数。
      if (this.config.debug) {
        this.log(
          'info',
          `capacity: window ${spec.contextWindow}, reserved output ${spec.contextWindow - spec.messageBudgetTokens}, ` +
            `message budget ${spec.messageBudgetTokens}, headroom ${spec.messageBudgetTokens - spec.pressureBudgetTokens}, ` +
            `trigger at ${spec.thresholdTokens}, current input ${total}`,
        );
      }
      if (this.config.minGrowthTokens > 0) {
        const last = this._lastTotal.get(session);
        if (typeof last === 'number' && total - last < this.config.minGrowthTokens) return null;
      }
    }

    // 溢出时先把超长工具结果剪一遍，再压——这比直接吞整个前缀便宜得多。
    // ⚠️ 裁剪会替换/追加 surface 节点，所以**必须重新计量**：`selectCompactableRange`
    // 会逐项比对 `measurement.nodes` 与 `session.surface.nodes`，拿裁剪前的计量去选区
    // 必然抛 `token-meter surface does not match the current session surface`，
    // 表现为"溢出路径一次摘要都没调就失败"。
    let currentMeasurement = measurement;
    if (trigger === 'context-overflow' && !pendingContinuation) {
      await this._pruneToolResults(session);
      const afterPrune = await this._measure(session);
      if (afterPrune) currentMeasurement = afterPrune;
    }

    const reductionTarget = Math.min(spec.thresholdTokens - 1, Math.floor(currentMeasurement.totalTokens * (1 - (spec.policy.minimumReductionRatio ?? 0.2))));
    noteDiagnosticMeasurement(currentMeasurement,{thresholdTokens:spec.thresholdTokens,targetTokens:reductionTarget});
    const continuationBudget = async range => {
      const fresh = await this._measure(session);
      const nodes = session.surface.nodes;
      const startIndex = nodes.indexOf(range.start), endIndex = nodes.indexOf(range.end);
      const archivedTokens = this._shadowedTokens(session, nodes.slice(startIndex, endIndex + 1));
      const retainedTokens = Math.max(0, (fresh?.totalTokens ?? currentMeasurement.totalTokens) - archivedTokens);
      const available = Math.min(Math.floor(spec.thresholdTokens / 2), reductionTarget - retainedTokens);
      if (available <= 0) throw Object.assign(new Error('Protected system context leaves insufficient room for the requested minimum reduction.'), {code:'CONTINUATION_TOO_LARGE'});
      return available;
    };
    this._busy.add(session);
    this._agentBySession.set(session, agent);
    try {
      // ⚠️ 溢出也**从保留区起步**，不是一上来 retain=0。
      // 设计目标是"不要一次性全部折叠，每次多保留一组再试"：retain=0 意味着一次
      // 吞掉尽可能大的前缀，正好与"渐进收敛"相反。保留区给不出可压缩跨度时，
      // 无合法边界时保留原尾部；不能靠吞掉最新消息伪造压缩成功。
      if (pendingContinuation || (spec.policy.continuationEnabled && hasContinuation(session))) {
        let range = pendingContinuation ? {start:pendingContinuation.seqs[0],end:pendingContinuation.seqs.at(-1)} : selectCachePreservingRange(session,currentMeasurement,spec.retainTokens,spec.policy,reductionTarget,{continuation:true}) ?? selectContinuationRange(session);
        if (range) {
          let budget;
          const preflight=candidate=>{
            const nodes=session.surface.nodes,seqs=nodes.slice(nodes.indexOf(candidate.start),nodes.indexOf(candidate.end)+1);
            const selected=selectSessionMemory(session,seqs),progress=collectProgressFacts(session,seqs);
            planContinuationMemory(residentConstraints(selected.active,session),spec.policy,{budgetTokens:budget,estimateTokens:blocks=>this._estimateCheckpointTokens(blocks),workReport:scopeWorkReport(collectWorkReport(session,seqs),progress),progress});
          };
          try {
            budget=pendingContinuation?.budgetTokens ?? await continuationBudget(range);
            if(!pendingContinuation)preflight(range);
          }
          catch(error) {
            // Re-select only before starting a transaction or paid request.
            // Frozen progress must keep its original range and call receipts.
            if(pendingContinuation||!['CONTINUATION_TOO_LARGE','CONTINUATION_REQUIREMENTS_TOO_LARGE'].includes(error.code))throw error;
            const full=selectContinuationRange(session);
            if(!full||full.start===range.start&&full.end===range.end)throw error;
            range=full;budget=await continuationBudget(range);preflight(range);
          }
          return await this._compactRegionCore(range.start,range.end,agent,signal,{manual:false,policy:spec.policy,continuation:true,continuationBudgetTokens:budget});
        }
      }
      let retainTokens = spec.retainTokens;
      let attempts = 0;
      const maxAttempts = this.config.maxSummaryChunks;
      let lastResult = null;
      let pendingOriginals;
      const chunkResults = [];
      const capacityContext = {}; // Keep provider overflow feedback across this batch.
      const finishBatch = measured => {
        if (lastResult && measured && spec.policy.continuationEnabled && this.historyToolsAvailable && measured.totalTokens > reductionTarget) throw Object.assign(new Error('Compaction leaves too little headroom for stable prefix reuse; switching to bounded continuation.'), {code:'COMPACTION_CAPACITY_BLOCKED'});
        if (measured && (measured.totalTokens >= spec.messageBudgetTokens || (spec.policy.continuationEnabled && this.historyToolsAvailable && measured.totalTokens >= spec.thresholdTokens))) {
          const error = new Error(`compaction cannot fit the next main request: ${measured.totalTokens} estimated input tokens >= ${spec.messageBudgetTokens} message budget; ${chunkResults.length} chunks committed, remaining history retained; use /compact or a larger-capacity target`);
          error.code = 'COMPACTION_CAPACITY_BLOCKED';
          error.compactionIds = chunkResults.flatMap(r => r.compactionIds ?? [r.compactionId]);
          throw error;
        }
        return lastResult;
      };

      while (attempts < maxAttempts) {
        attempts += 1;
        if (signal?.aborted) return lastResult;

        const fresh = attempts === 1 ? currentMeasurement : await this._measure(session);
        if (!fresh) return lastResult;
        if (fresh.totalTokens < spec.thresholdTokens && lastResult !== null) return finishBatch(fresh);

        let range;
        if (pendingOriginals) {
          const live = new Set(session.surface.nodes);
          pendingOriginals = pendingOriginals.filter(seq => live.has(seq));
          if (!pendingOriginals.length) return finishBatch(fresh);
          range = { start: pendingOriginals[0], end: pendingOriginals.at(-1) };
        } else range = selectCachePreservingRange(session, fresh, retainTokens, spec.policy, reductionTarget) ?? selectCompactableRange(session, fresh, retainTokens);
        if (range && !pendingOriginals?.length) {
          const currentNodes = session.surface.nodes;
          pendingOriginals = currentNodes.slice(currentNodes.indexOf(range.start), currentNodes.indexOf(range.end)+1);
        }
        if (!range) {
          // No legal smaller span: preserve the configured recent groups and stop.
          return finishBatch(fresh);
        }

        try {
          lastResult = await this._compactRegionCore(range.start, range.end, agent, signal, {
            manual: false,
            // 摘要输出上限来自**按 provider/model 合并过**的 spec，不是全局配置。
            maxTokens: spec.maxTokens,
            // 合并后的整份策略一起带下去：摘要目标、超时、语言、保留尾都按
            // 同一个 provider/model 解析，不能一半按目标一半按全局。
            policy: spec.policy,
            capacityContext,
          });
          if (lastResult) { chunkResults.push(lastResult); lastResult = combineCompactionResults(chunkResults); }
        } catch (error) {
          if (signal?.aborted) return lastResult;
          const message = error?.message ?? String(error);
          if (/not a balanced boundary|not found in surface/.test(message)) {
            this.log('warn', `range rejected by the surface (${message}); keeping remaining history`);
            return finishBatch(await this._measure(session));
          }
          if (error?.code === 'RECOVERY_REQUIRED') throw error;
          // Keep the original cause while refusing a known-oversized main request.
          try { finishBatch(await this._measure(session)); }
          catch (blocked) { blocked.cause = error; throw blocked; }
          if (chunkResults.length) {
            error.message = `${chunkResults.length} summary chunk(s) committed; remaining history retained: ${error.message}`;
            error.compactionIds = chunkResults.map(r => r.compactionId);
          }
          throw error;
        }

        const after = await this._measure(session);
        if (!after) return lastResult;
        this._lastTotal.set(session, after.totalTokens);
        if (after.totalTokens < spec.thresholdTokens) return finishBatch(after);
      }

      const after = await this._measure(session);
      if (after && after.totalTokens >= spec.thresholdTokens) {
        this.log(
          'warn',
          `compaction still above threshold after ${attempts} attempt(s) (${after.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
        );
      }
      return finishBatch(after);
    } catch (error) {
      if (spec.policy.continuationEnabled && spec.policy.archiveEnabled && this.historyToolsAvailable && continuationEligible(error) && !signal?.aborted) {
        const fresh = await this._measure(session);
        const range = selectContinuationRange(session);
        if (range) return await this._compactRegionCore(range.start, range.end, agent, signal, {manual:false,policy:spec.policy,continuation:true,continuationBudgetTokens:await continuationBudget(range)});
      }
      throw error;
    } finally {
      this._busy.delete(session);
    }
  }

  /**
   * 手动 `/compact`。
   * @param {object} agent
   * @param {AbortSignal} signal
   * @param {string} [sourceCommandId]
   */
  async compactNow(agent, signal, sourceCommandId, continuation = false) {
    try {
      return await this.diagnostics.run(agent?.session,{trigger:continuation?'manual-continuation':'manual',commandId:sourceCommandId,signal,reportContext:this._diagnosticContext(agent)},()=>this._compactNowInner(agent, signal, sourceCommandId, continuation));
    } catch (error) {
      // ⚠️ 手动路径的**唯一出口**。宿主的 `/compact` 只把 `ManualCompactionError`
      // 翻译成人话，其它任何 Error 都原样 rethrow（`dsh-command-compact/lib/index.js:65-72`），
      // 用户看到的是命令层未处理异常，而不是"这次为什么没压成"。
      // 收敛点放在这一层，而不是在每个 throw 点各写一遍：手动压缩要穿过四层，
      // 逐点改造时任何一处新增 throw 都会重新长出未处理异常。
      //
      // 而且必须是**宿主那个类**的实例：`instanceof` 只认同一个类对象，
      // 自己声明一个同名同码的类在这里是无效的（见 `manual-error.js`）。
      throw await asHostManualError(this.ctx, error, error?.compactionStage);
    }
  }

  async _compactNowInner(agent, signal, sourceCommandId, continuation = false) {
    const runMaintenance = agent?.runMaintenance;
    if (typeof runMaintenance !== 'function') {
      const error = new Error('manual compaction requires an agent that supports maintenance tasks');
      error.code = 'busy';
      throw error;
    }

    // ⚠️ 必须区分两种失败：
    //   (a) `runMaintenance` 自己拒绝——agent 不空闲、有排队工作。这才是 busy。
    //   (b) 压缩过程里真正的业务错误——鉴权失败、摘要超时、持久化失败。
    // 把 (b) 也一律包成 busy（"agent 不空闲"），用户看到的是一句完全不相关
    // 的话，真实原因只躺在 `cause` 里。
    let entered = false;
    // ⚠️ 维护窗口的 signal 要留到 catch 里用。合并后的 `combined` 只能告诉你
    // "中止了"，但看不出是**谁**中止的：agent 收回维护窗口（用户按了 Esc、
    // 或同一会话要开始新的一轮）与压缩本身出错，对用户是两件事。
    // 宿主 `dsh-compaction-basic/lib/index.js:1003-1005` 判据是
    // `agentSignal.aborted && operationSignal.reason === agentSignal.reason`：
    // reason 相同说明触发中止的正是维护控制器，而不是命令自己的 signal。
    let maintenanceSignal;
    let combinedSignal;
    try {
      return await runMaintenance.call(agent, async (agentSignal) => {
        entered = true;
        maintenanceSignal = agentSignal;
        const merged = combineSignals([agentSignal, signal]);
        combinedSignal = merged.signal;
        try { return await this._compactManual(agent, merged.signal, sourceCommandId, continuation); }
        finally { merged.dispose(); }
      });
    } catch (error) {
      if (!entered) {
        // 回调根本没跑起来 = 维护窗口没抢到，这确实是 busy。
        const busy = new Error('manual compaction requires an idle agent with no waking queued work');
        busy.code = 'busy';
        busy.cause = error;
        throw busy;
      }
      // 维护窗口被收回 = 取消，不是失败。
      // 不认这一条会有两个后果：用户看到的是"摘要失败"这种完全不对路的提示；
      // 而且取消会被 `_recordFailure` 计入熔断，按三次取消就让会话永久停压。
      const ownerAborted =
        maintenanceSignal?.aborted === true && combinedSignal?.reason === maintenanceSignal.reason;
      if (ownerAborted) {
        const cancelled = new Error(error.compactionIds?.length
          ? `manual compaction was cancelled after ${error.compactionIds.length} committed chunk(s); remaining history retained`
          : 'manual compaction was cancelled');
        cancelled.compactionIds = error.compactionIds;
        cancelled.code = 'cancelled';
        cancelled.cause = error;
        throw cancelled;
      }
      // 已经进入压缩流程：原样抛出，保留真实 code / message / cause，
      // 由 `compactNow` 统一转成官方形状。
      throw error;
    }
  }

  async _compactManual(agent, signal, sourceCommandId, continuation = false, proactive = false) {
    const manual = !proactive;
    const session = agent?.session;
    if (!session) return null;
    if (this._busy.has(session)) {
      const error = new Error('manual compaction: compaction already in progress');
      error.code = 'busy';
      throw error;
    }

    this._busy.add(session);
    this._agentBySession.set(session, agent);
    try {
      const measurement = await this._measure(session);
      if (!measurement) return null;
      noteDiagnosticMeasurement(measurement);
      // ⚠️ 手动压缩**不能**经过 `_resolveSpec`。
      //
      // `_resolveSpec` 算的是"自动压力压缩该在什么水位触发"：它要
      // `contextWindow − reserved − headroomTokens` 必须为正，否则抛
      // `no pressure budget`。那是自动入口的前置条件，跟"我现在想把已有历史
      // 主动压一遍"没有关系。小窗口 + 大 headroom（例如 32768 窗口配默认
      // headroomTokens=33000）时自动预算必然无效，此时手动入口如果也走这条
      // 路，就会在**一个摘要请求都没发**的情况下报"摘要失败"，用户看到的是
      // 一个和实际原因完全不相干的错误。
      //
      // 官方 `compactNow`（`dsh-compaction-basic/lib/index.js:985-1001`）就是
      // 以 `retainTokens = 0` 直接选区进事务，不先求压力 spec。
      //
      // 手动压缩要的只有两样：目标策略（决定摘要发给谁、输出上限多少）和
      // 一个选区。策略用不抛错的 `_resolvePolicy`，选区按 0 保留量。
      const policy = this._resolvePolicy(agent);
      let pendingContinuation = readPendingContinuation(this.sessionState, session);
      if (pendingContinuation) { await this.recoverPending(session); pendingContinuation = readPendingContinuation(this.sessionState, session); }
      const rollover = pendingContinuation || continuation || (policy.continuationEnabled && hasContinuation(session));
      const cacheRetain=policy.retainTokens??Math.max(4096,Math.floor(measurement.totalTokens*policy.retainRatio));
      const cacheRange=pendingContinuation?null:selectCachePreservingRange(session,measurement,cacheRetain,policy,undefined,{continuation:!!rollover});
      const range = pendingContinuation ? {start:pendingContinuation.seqs[0],end:pendingContinuation.seqs.at(-1)} : cacheRange ?? (rollover ? selectContinuationRange(session) : selectCompactableRange(session, measurement, 0));
      if (!range) return null;
      if (rollover) return await this._compactRegionCore(range.start, range.end, agent, signal, {manual,sourceCommandId,policy,continuation:true});
      const originalNodes = session.surface.nodes;
      let pending = originalNodes.slice(originalNodes.indexOf(range.start), originalNodes.indexOf(range.end)+1);
      const results = [];
      const capacityContext = {};
      try {
        for (let chunk = 0; chunk < this.config.maxSummaryChunks; chunk++) {
          signal?.throwIfAborted?.();
          const live = new Set(session.surface.nodes); pending = pending.filter(seq => live.has(seq));
          if (!pending.length) return combineCompactionResults(results);
          if (results.length) {
            const remainder = measureSummaryRange(session, { start: pending[0], end: pending.at(-1) }, { language: policy.language });
            if (remainder.minimumCheckpointBytes >= remainder.sourceBytes) {
              this.log('info', 'Remaining messages cannot shrink with the selected memory; keeping them on the surface.');
              return { ...combineCompactionResults(results), retainedOriginalSeqs: pending };
            }
          }
          const result = await this._compactRegionCore(pending[0], pending.at(-1), agent, signal, {
            manual, maxTokens: policy.maxTokens, policy, capacityContext,
            ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
          });
          results.push(result);
        }
        if (pending.some(seq => session.surface.nodes.includes(seq))) throw Object.assign(new Error(`manual compaction reached maxSummaryChunks=${this.config.maxSummaryChunks}; completed chunks remain committed`), { code: 'SUMMARY_BATCH_LIMIT' });
        return combineCompactionResults(results);
      } catch (error) {
        if (policy.continuationEnabled && policy.archiveEnabled && this.historyToolsAvailable && continuationEligible(error) && !signal?.aborted) {
          const fresh = await this._measure(session);
          const rest = selectContinuationRange(session);
          if (rest) return await this._compactRegionCore(rest.start, rest.end, agent, signal, {manual,sourceCommandId,policy,continuation:true});
        }
        if (results.length) {
          const partial = new Error(`${results.length} summary chunk(s) committed; remaining history retained: ${error.message}`, { cause: error });
          partial.code = 'commit'; partial.compactionStage = 'commit'; partial.compactionIds = results.map(r => r.compactionId); throw partial;
        }
        throw error;
      }
    } finally {
      this._busy.delete(session);
    }
  }

  /**
   * 压一个明确的 surface 区间。
   *
   * 这是 `CompactionEngine` 的抽象方法，语义上只服务于**自动**压缩
   * （官方在 `compactIfNeeded` 里以 `owner: 'current-turn'` 调用它）。
   * 手动 `/compact` 走 `_compactManual` → `_compactRegionCore(..., manual: true)`，
   * 与官方 `compactSurfaceRegion({owner: null})` 的分工一致。
   *
   * @param {number} start
   * @param {number} end
   * @param {object} agent
   * @param {AbortSignal} [signal]
   * @param {string} [sourceCommandId]
   */
  async compactRegion(start,end,agent,signal,sourceCommandId) {
    return this.diagnostics.run(agent?.session,{trigger:'region',commandId:sourceCommandId,signal,reportContext:this._diagnosticContext(agent)},()=>this._compactRegionInner(start,end,agent,signal,sourceCommandId));
  }

  async _compactRegionInner(start, end, agent, signal, sourceCommandId) {
    // ⚠️ 这条公开入口也要走 `modelPolicies`。它不只是给外部调用的：
    // 本插件的 `_reactiveRetry`（溢出恢复）就是走这条路进来的。只给
    // `_compactManual` / `compactIfNeeded` 传 policy 时，同一个模型在
    // "自动压力压缩"下用目标策略、在"溢出恢复"下退回全局配置 ——
    // 用户看到的是同一个模型时好时坏。
    //
    // ⚠️ 策略解析与预算解析必须分开做（见 `_resolvePolicy`）。区间压缩本身
    // 不依赖自动压力预算：窗口太小、headroom 太大、保留量组合越界都会让
    // `_resolveSpec` 抛错，但"摘要发给哪个模型、输出上限多少"依然是有确定答案的。
    // 早先这里把整个 `_resolveSpec` 的异常吞成 undefined，于是预算一失败就
    // 连带丢掉目标策略，摘要静默改道到全局模型。
    const session = agent?.session;
    this._restoreState(session);
    if (this._stopped.has(this._keyOf(session))) return null;
    const policy = this._resolvePolicy(agent);
    const spec = await this._resolveSpec(agent, undefined, signal).catch(error => {
      if (error?.code === 'STATE_UNAVAILABLE' || isAbortError(error, signal)) throw error;
      return undefined; // Explicit region selection does not require a pressure budget.
    });
    return this._compactRegionCore(start, end, agent, signal, {
      manual: false,
      ...(spec?.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens }),
      policy,
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
    });
  }

  /**
   * @param {number} start
   * @param {number} end
   * @param {object} agent
   * @param {AbortSignal|undefined} signal
   * @param {{manual: boolean, sourceCommandId?: string}} options
   */
  async _compactRegionCore(start, end, agent, signal, options) {
    const { manual } = options;
    const sourceCommandId = options.sourceCommandId;
    const session = agent?.session;
    if (!session) {
      throw new Error('compactRegion: no session');
    }
    signal?.throwIfAborted?.();
    const transactionKey = `${this.sessionState.root}:${JSON.stringify(session.id)}`;
    if (activeTransactions.has(transactionKey)) { const e = new Error('compaction already active for this logical session'); e.code = 'busy'; throw e; }
    activeTransactions.add(transactionKey);
    try {
      await this.recoverPending(session, true);
      signal?.throwIfAborted?.();
      const pendingContinuation = readPendingContinuation(this.sessionState, session);
      if (pendingContinuation) {
        assertPendingSource(session, pendingContinuation);
        if (!options.continuation) throw Object.assign(new Error('Finish the saved continuation before starting another compaction.'), {code:'CONTINUATION_PENDING_RANGE'});
      }
      validateSurfaceRegion(session, start, end);
    if (this.requireTransactionAdapter && typeof session.restoreCompactionSurface !== 'function') {
      if (!this.transactionAdapter) { const e = new Error('Stock-host transaction adapter is unavailable; compression is refused before changing history.'); e.code = 'RECOVERY_REQUIRED'; throw e; }
      this.transactionAdapter.assertSupported(session);
    }


    const entryState = inspectCompactionEntryState(session);
    assertCompactionInactive(entryState.unmatchedCompactionStart, entryState.latestEndSeedSeq, 'compaction');

    if (manual && entryState.openTurn !== null) {
      const error = new Error('manual compaction: the session already has an open turn');
      error.code = 'busy';
      throw error;
    }
    if (!manual && entryState.openTurn === null) {
      // 自动压缩必须包在一个 turn 里，否则写进 surface 的事件没有归属。
      // 抛错会被 agent/pre-step 的处理器接住并降级为"这一轮不压"，不会打断对话。
      throw new Error('compactRegion: no open turn — automatic compaction events must be enclosed in a turn');
    }

    // Prove policy state can be durably written before replacing any context.
    // A later disk failure still needs the retained journal; this is not rollback.
    try { this.sessionState.update(session.id, state => state); }
    catch (cause) {
      const error = new Error(`compaction state unavailable before replacement: ${cause?.message ?? cause}`);
      error.code = 'STATE_UNAVAILABLE'; error.cause = cause; throw error;
    }

    const policy = options.policy ?? this.config;
    if (options.continuation && (!policy.archiveEnabled || !this.historyToolsAvailable)) throw Object.assign(new Error('同会话接续需要可用的完整历史归档和三个历史查询工具；原上下文保留。'), {code:'CONTINUATION_HISTORY_UNAVAILABLE'});
    const capacity = options.capacityContext?.current ?? await resolveSummaryCapacity(this.ctx, resolveSummaryTargets({ config: policy, agent }), { ...policy, maxTokens: options.maxTokens ?? policy.maxTokens }, signal);
    if (options.capacityContext) options.capacityContext.current = capacity;
    const planning = { policy, language: policy.language, pricedInput: seqs => this._shadowedTokens(session, seqs) };
    let planned;
    try { planned = options.continuation ? {start,end,limited:false} : planSummaryRange(session, { start, end }, capacity, planning); }
    catch (error) { if (!isAbortError(error, signal)) this._recordFailure(agent, session, error); throw error; }
    if (planned.limited) this.log('info', `summary capacity split: ${start}-${end} -> ${planned.start}-${planned.end}, ${planned.inputUnits}/${planned.inputLimit} conservative input units`);
    const reselect = async (_extra, previous) => {
      const prior = measureSummaryRange(session, previous, planning);
      capacity.shrinkLimit = Math.min(capacity.shrinkLimit, Math.floor((prior.inputUnits ?? planned.inputUnits) / 2));
      let next;
      try { next = planSummaryRange(session, previous, capacity, planning); }
      catch (error) { if (['SUMMARY_GROUP_TOO_LARGE','SUMMARY_NOT_SMALLER'].includes(error.code)) return null; throw error; }
      return next.end !== previous.end ? next : null;
    };
    if (options.continuation) {
      const nodes=session.surface.nodes;
      const pending=freezeContinuation(this.sessionState,session,nodes.slice(nodes.indexOf(planned.start),nodes.indexOf(planned.end)+1),options.continuationBudgetTokens);
      options={...options,continuationPending:pending,continuationBudgetTokens:pending.budgetTokens};
    }
    const replaceGenerationBefore = session.surface?.replaceGeneration ?? 0;
    try {
      return await this._compactSpan(planned.start, planned.end, agent, signal, {
        ...options, capacity, reselect: options.continuation ? undefined : reselect,
        turn: manual ? null : (entryState.openTurn ?? null),
      }, 0);
    } catch (error) {
      if (options.continuationPending) releaseUnstartedContinuation(this.sessionState, session, options.continuationPending.id);
      if (typeof session.restoreCompactionSurface === 'function'
          || (session.surface?.replaceGeneration ?? 0) > replaceGenerationBefore) {
        // Stock hosts must also inspect the journal: closing a lifecycle is not
        // restoration. A changed unresolved surface blocks further model calls.
        try {
          const recovery = await this.recoverPending(session, true, isAbortError(error, signal) ? 'cancelled' : 'failed');
          if (recovery.restored > 0 && error && typeof error === 'object') error.surfaceRestored = true;
        } catch (recoveryError) {
          this._recoveryBlocked.add(this._keyOf(session));
          const blocked = new AggregateError([error, recoveryError], 'compaction failed and restoration must finish before another model request');
          blocked.code = 'RECOVERY_REQUIRED'; blocked.compactionStage = 'commit'; blocked.cause = error; throw blocked;
        }
      }
      throw error;
    }
    } finally { activeTransactions.delete(transactionKey); }
  }

  /**
   * 压一个已经校验过的 span，失败时按 `reactiveStep` 做**渐进收敛**重试。
   *
   * 这是 L6 真正的落点。官方把恢复做成 `compaction/summary-error` waterfall，
   * 但**派发点是 provider 自己的 `regionDependencies().recover`**，不是 agent-loop
   * 自动提供的 —— 我们换掉引擎之后没有人派发，所以"渐进重试"必须自己接在
   * catch 路径上，否则永远不可达。
   *
   * 事务边界：每次尝试都以 `compaction/start` 开锁、以 `compaction/end` 关锁。
   * 重试会**重新开一次事务**，而不是带着未结束的锁继续写 —— 这样即使进程崩溃，
   * 留下的也只是可被 `assertCompactionInactive` 识别的孤儿锁。
   *
   * @param {number} start
   * @param {number} end
   * @param {object} agent
   * @param {AbortSignal|undefined} signal
   * @param {{manual: boolean, sourceCommandId?: string, turn: number|null, reselect?: (extra: number) => {start:number,end:number}|null}} options
   * @param {number} attempt
   */
  async _compactSpan(start, end, agent, signal, options, attempt) {
    const { manual } = options;
    const sourceCommandId = options.sourceCommandId;
    const session = agent.session;
    const compactionId = nextCompactionId();
    const nodes = session.surface?.nodes ?? [];
    const startIdx = nodes.indexOf(start);
    const endIdx = nodes.indexOf(end);
    const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);
    const shadowedSpanSnapshot = [...shadowedSeqs];

    // 被覆盖范围的 token 数**在这里冻结一次**。提交后重新 `_measure` 只会看到
    // 新的 surface（旧 seq 已经不在了），再用旧 seq 去查价格 Map 会全部拿到 0，
    // 于是 `/compact` 报"压缩了 0 个 token"—— 用户看到的就是"压了但没省"。
    const shadowedTokenCount = this._shadowedTokens(session, shadowedSeqs);
    const shadowedCanonicalBytes = canonicalMessageBytes(shadowedSeqs.map(seq => session.deriveEventMessage(session.eventAt(seq))).filter(Boolean));
    // 这个数是实测还是粗估，必须一起交出去（见 `_lastPrecision` 的注释）。
    // 缺省 `unknown` 而不是 `priced`：不知道就别假装知道。
    const shadowedTokenPrecision = this._lastPrecision?.get(session) ?? 'unknown';

    const lifecycle = {
      compactionId,
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      turn: options.turn ?? null,
    };
    const startEvent = await this._append(session, 'compaction/start', lifecycle);

    // ⚠️ 开锁之后立刻落一笔持久记录。
    // 这一步比 `compaction/start` 事件更强：事件留在会话日志里，但"这次压缩
    // 到底走到哪一步"要跨进程读得出来，才能在下一次启动时判断有没有留下
    // 一把没关上的锁。日志写失败立即阻断提交，进入生命周期收尾。
    // Journal write is inside the lifecycle cleanup boundary below.

    let stage = 'summary';
    // 事务收尾状态机。见下面「统一收尾」一段：`closing` = 已经开始收尾，
    // `closed` = `compaction/end` 确实写成功了。
    let closing = false;
    let closed = false;
    let replaced = false;
    let failure;
    let flushFailure;
    let committed = null;
    let stockCommitted = false;
    try {
      await this._journalRecord(session, compactionId, 'started', start, end);
      const policy = options.policy ?? this.config;
      let summarized, preserved, checkpointBlocks, memorySelection, progressSelection;
      if (options.continuation) {
        ({summarized,preserved,checkpointBlocks} = await prepareContinuation({ctx:this.ctx,agent,session,seqs:shadowedSeqs,policy,capacity:options.capacity,chain:resolveSummaryTargets({config:policy,agent}),compactionId,signal,archiveRoot:this.archive.root,checkpointBudgetTokens:options.continuationBudgetTokens,estimateCheckpointTokens:blocks=>this._estimateCheckpointTokens(blocks),manualRetry:manual,requestId:options.sourceCommandId??compactionId,onProgressIdentity:key=>bindContinuationProgress(this.sessionState,session,options.continuationPending.id,key,{manualRetry:manual,requestId:options.sourceCommandId??compactionId})}));
        Object.assign(summarized.continuation,{pendingId:options.continuationPending.id,pendingSourceSha256:options.continuationPending.sourceSha256});
        const tokens = this._estimateCheckpointTokens(checkpointBlocks);
        if (tokens >= shadowedTokenCount || canonicalMessageBytes([{role:'user',content:checkpointBlocks}]) >= shadowedCanonicalBytes) throw Object.assign(new Error('Continuation would not reduce the current context; original history retained.'), {code:'CONTINUATION_NOT_SMALLER'});
        if (options.continuationBudgetTokens && tokens >= options.continuationBudgetTokens) throw Object.assign(new Error('Continuation requirements exceed the available main-request budget.'), {code:'CONTINUATION_TOO_LARGE'});
      } else {
      const input = buildSummarizationInput(session, shadowedSeqs);
      progressSelection=input.progress;
      const previousSummary = shadowedSeqs.some(seq => session.deriveEventMessage(session.eventAt(seq))?.source?.kind === 'compact-checkpoint') ? 'inline checkpoint' : null;
      // ⚠️ 用**按 provider/model 合并过的**策略解析摘要目标，不能用全局配置。
      // 否则 `modelPolicies[i].summarizationProvider/Model` 永远进不了摘要链：
      // 预算、输出上限按目标模型算，摘要却发给全局默认模型，两套口径对不上。
      const chain = resolveSummaryTargets({ config: policy, agent });

      memorySelection = selectSessionMemory(session, shadowedSeqs, {
        maxMessages: policy.preserveRecentMessages, maxTokens: policy.preserveRecentUserTokens, approxTokens,
      });
      const expectedUserMessages = [...memorySelection.active,...memorySelection.retained];
      preserved = memorySelection.preserved;
      if (memorySelection.decisions.some(d=>d.reason==='oldest-quote-evicted') && !policy.archiveEnabled) {
        throw Object.assign(new Error('Memory selection requires a verified source archive.'), {code:'MEMORY_ARCHIVE_REQUIRED'});
      }
      input.messages.push({role:'user',content:[{type:'text',text:memoryPolicyInstruction(memorySelection)}]});

      summarized = await summarizeWithChain({
        ctx: this.ctx,
        agent,
        input,
        chain,
        options: {
          // ⚠️ 必须用 spec 上的值，不能用 `this.config.maxTokens`：
          // 前者已经按 provider/model 合并过 `modelPolicies`，后者只是全局默认。
          maxTokens: options.maxTokens ?? policy.maxTokens,
          singleTarget: true,
          timeoutMs: policy.summaryTimeoutMs,
          retryCount: policy.summaryRetryCount,
          retryDelayMs: policy.summaryRetryDelayMs,
          language: policy.language,
          previousSummary,
          capacity: options.capacity,
          // 把来源区间的用户消息清单交给模型；最终第六节由引擎逐字生成。
          // 这张清单和下面校验用的是**同一个** `expectedUserMessages` —— 列给模型看
          // 的和拿来验收的必须是同一份，否则就是让模型去猜我们的标准。
          userMessages: preserved,
          // ⚠️ 内容校验必须放在**目标链内部**跑，不能等链跑完再查。
          // 三个摘要是按能力排的：主模型只回 `Done.` 时，下一个目标本来还有机会，
          // 但校验在链外时第一个目标就被判死，整次压缩直接失败 —— 降级链白写了。
          // 每个目标先生成完整 checkpoint，再校验结构、原话覆盖、体积和约束。
          // 不合格时继续下一个目标，避免降级链被链外检查提前截断。
          reconstruct: ({result, verdict, modelRawText}) => {
            if(verdict.code==='PROGRESS_FACT_CONFLICT')return null;
            const rebuilt = reconstructDisputedLines({text: modelRawText, userMessages: expectedUserMessages, audit: verdict.audit, language: result.language});
            if (!rebuilt) return null;
            const receipts = [...(result.reconstruction ?? []), ...rebuilt.receipts];
            if (new Set(receipts.flatMap(r=>r.removedLineSha256)).size > 16) return null;
            return { ...result, rawText: rebuilt.text, summary: [{type:'text',text:rebuilt.text}], reconstruction: receipts };
          },
          onRejected: ({ result, verdict, modelRawText, attempt }) => dumpAuditRejection({
            storageRoot: dirname(this.archive.root), sessionId: session?.id,
            compactionId, target: `${result?.provider ?? '?'}/${result?.model ?? '?'}`,
            code: verdict.code, message: verdict.message, attempt,
            modelRawText, auditedText: result.rawText,
            report: verdict.audit, userMessages: expectedUserMessages,
            checkpointBlocks: verdict.audit ? buildCheckpointBlocks(result.summary, preserved, CHECKPOINT_PREAMBLE, {originalsInSummary:true,workReport:input.workReport,progress:input.progress}) : undefined,
          }),
          validate: (result) => {
            const language = result?.language ?? (policy.language === 'zh' ? 'zh' : 'en');
            const structure = validateSummaryStructure(result?.rawText ?? '', { language });
            if (!structure.ok) return structure;
            // 第六节由选定的近期原话确定性生成，模型只需占位。
            result.modelRawOutput ??= result.summary;
            const retired = retiredMemoryPresent(result.rawText, memorySelection);
            if (retired) return {ok:false,code:'RETIRED_MEMORY_REINTRODUCED',message:`Remove the ${retired.reason} request from seq ${retired.seq}; it is no longer active.`};
            result.rawText = materializeUserMessageSection(deduplicateNotes(result.rawText, preserved), preserved, language);
            result.summary = [{ type: 'text', text: result.rawText }];
            const compiled = validateSummaryStructure(result.rawText, { language });
            const listed = validateUserMessageSection(compiled.userSectionBody, preserved);
            if (!listed.ok) return listed;
            const blocks = buildCheckpointBlocks(result.summary, preserved, CHECKPOINT_PREAMBLE, {originalsInSummary:true,workReport:input.workReport,progress:input.progress});
            const coverage = validateCheckpointCoverage(blocks, preserved, { expected: preserved });
            if (!coverage.ok) return coverage;
            if (this._estimateCheckpointTokens(blocks) >= shadowedTokenCount) return { ok: false, code: 'SUMMARY_NOT_SMALLER', message: 'complete checkpoint is not smaller than its source span' };
            if (canonicalMessageBytes([{ role: 'user', content: blocks }]) >= shadowedCanonicalBytes) return { ok: false, code: 'SUMMARY_NOT_SMALLER', message: 'complete checkpoint does not reduce canonical UTF-8 message bytes' };
            const progressVerdict=validateProgressFacts(result.rawText,progressSelection);
            if(!progressVerdict.ok)return progressVerdict;
            if (policy.auditEnabled) {
              const audit = this._audit(session, shadowedSeqs, result.rawText, compactionId, blocks, policy);
              if (audit.polarityFlips) return { ok: false, audit, code: 'CONSTRAINT_POLARITY_LOST', message: `summary contradicts a source constraint (seq=${audit.lost.find(item => item.reason === 'polarity')?.seq ?? 'unknown'}, reason=polarity)` };
              if (policy.auditBlockOnLoss && audit.lost.length) return { ok: false, audit, code: 'CONSTRAINT_LOST', message: `summary failed source constraint audit (seq=${audit.lost[0].seq}, reason=${audit.lost[0].reason})` };
            }
            return listed;
          },
        },
        signal: signal ?? new AbortController().signal,
      });

      // L5：把选定的近期原话逐字补回；旧原话留在归档，有效要求仍审计
      // checkpoint。span 之外的消息本来就在 surface 上原样存在，再抄一遍只是
      // 把同一段话放两份。
      //
      // `preserved` 已经在上面和 `expectedUserMessages` 一起算好了：两份列表
      // 必须同源、同一次扫描，否则"裁剪后还剩哪些"和"本来有哪些"会各说各话。
      checkpointBlocks = buildCheckpointBlocks(summarized.summary, preserved, CHECKPOINT_PREAMBLE, {originalsInSummary:true,workReport:input.workReport,progress:input.progress});

      // ⚠️ 提交前校验：不通过就抛错，走安全失败路径（不替换 surface）。
      //
      // 模板里"必须九节""必须列出每一条用户消息"只是**请求**，不是保证。
      // 模型回一句 `Done.`，模板一个字都不管用 —— 缺了这层校验它会照样被提交，
      // 而 surface 一旦替换，原文只剩归档，模型再也读不到。
      //
      // 结构与第六节的校验已经在目标链内部跑过一遍（为了让降级链生效）。
      // 这里**再查一次**是有意的：`summarizeWithChain` 可能因为所有目标都不合规
      // 而抛聚合错误，也可能被将来的改动绕过注入点，而这一段是提交前的最后关口。
      const structure = validateSummaryStructure(summarized.rawText, {
        language: summarized.language ?? (policy.language === 'zh' ? 'zh' : 'en'),
      });
      if (!structure.ok) {
        const error = new Error(structure.message);
        error.code = structure.code;
        throw error;
      }
      // 第六节必须**逐条**交代来源区间里的用户消息。
      // 只查"这一节非空"不够：写一句"用户希望继续"也是非空，但三条要求里
      // 有两条根本没被提到，下一个模型读摘要时不会有任何线索知道它们存在。
      const userSection = validateUserMessageSection(structure.userSectionBody, preserved);
      if (!userSection.ok) {
        const error = new Error(userSection.message);
        error.code = userSection.code;
        throw error;
      }
      // 原话覆盖查的是**拼好的 checkpoint**，不是模型返回的正文：
      // 原话是直接从事件里取的，模型再怎么概括也改不掉它，所以这条不依赖模型守规矩。
      //
      // ⚠️ 必须把**来源全集**也交进去。只比对 `preserved`（我们自己挑出来的
      // 那份列表）等于自己给自己判卷：挑漏一条，列表和检查点一起漏，
      // 校验照样通过。`expected` 是"区间里真实存在的用户消息"，与来源无关。
      const coverage = validateCheckpointCoverage(checkpointBlocks, preserved, {
        expected: preserved,
      });
      if (!coverage.ok) {
        const error = new Error(coverage.message);
        error.code = coverage.code;
        throw error;
      }

      // ⚠️ 缩小检查必须在**完整 checkpoint 构造之后**做。
      // 只量"摘要正文"是不够的：L5 保留的用户原话可以远超摘要本身
      // （摘要 94 tokens、保留 30000 tokens 时，最终 checkpoint 比原文还大），
      // 于是会出现"压完更大"。
      const checkpointTokens = this._estimateCheckpointTokens(checkpointBlocks);
      if (checkpointTokens >= shadowedTokenCount) {
        const error = new Error(
          `summary is not smaller than the shadowed content (${checkpointTokens} estimated checkpoint tokens >= ${shadowedTokenCount}, measurement precision: ${shadowedTokenPrecision})`,
        );
        error.code = 'SUMMARY_NOT_SMALLER';
        throw error;
      }

      const checkpointCanonicalBytes = canonicalMessageBytes([{ role: 'user', content: checkpointBlocks }]);
      if (checkpointCanonicalBytes >= shadowedCanonicalBytes) {
        const error = new Error(`checkpoint UTF-8 message bytes did not shrink (${checkpointCanonicalBytes} >= ${shadowedCanonicalBytes})`);
        error.code = 'SUMMARY_NOT_SMALLER'; throw error;
      }

      // 审计：摘要/检查点是否丢了用户约束。
      //
      // ⚠️ 审计结果必须能**阻止提交**。以前它只 `log('warn')`，异常还被
      // `catch {}` 吞掉 —— 于是"约束被反转"这件事只存在于日志里，用户永远
      // 不会看到，模型下一轮就按被反转的约束干活。
      //
      // 两种发现的处置不同：
      // - **极性反转**（`Do not delete` → `Delete`）：按同源句配对检查，属于词法判断，
      //   一旦命中就中止这次压缩（原文留在 surface 上，用户可以重试）。
      // - **词覆盖不足**：同义改写会误报，因此默认**也中止**（`auditBlockOnLoss`），
      //   但可以显式关掉。理由是代价不对称：误报的代价是"这次没压成、用户可以重试"，
      //   漏报的代价是"约束静默消失、后面整段对话都按错的约束走"。
      if (policy.auditEnabled) {
        const report = this._audit(session, shadowedSeqs, summarized.rawText, compactionId, checkpointBlocks, policy);
        if (report.polarityFlips > 0 || (policy.auditBlockOnLoss && report.lost.filter((item) => item.reason !== 'polarity').length > 0)) {
          // Diagnostic only: persist the full evidence before throwing.
          // The await is inside a try that cannot fail the compaction.
          try {
            await dumpAuditRejection({
              storageRoot: dirname(this.archive.root),
              sessionId: session?.id,
              compactionId,
              target: `${summarized?.provider ?? '?'}/${summarized?.model ?? '?'}`,
              code: report.polarityFlips > 0 ? 'CONSTRAINT_POLARITY_LOST' : 'CONSTRAINT_LOST',
              message: report.polarityFlips > 0 ? 'summary reverses a user constraint' : 'summary failed source constraint audit',
              modelRawText: blocksToText(summarized.modelRawOutput ?? summarized.summary ?? []),
              auditedText: summarized.rawText,
              checkpointBlocks,
              report,
              userMessages: collectInstructionMessages(session, shadowedSeqs, { approxTokens }),
            });
          } catch {
            /* diagnostics must never change the outcome */
          }
        }
        if (report.polarityFlips > 0) {
          const error = new Error(
            `compaction: the summary reverses ${report.polarityFlips} user constraint(s) ` +
              `(first: "${report.lost.find((item) => item.reason === 'polarity')?.line.slice(0, 120) ?? ''}"); ` +
              'refusing to replace the original messages with a summary that says the opposite',
          );
          error.code = 'CONSTRAINT_POLARITY_LOST';
          throw error;
        }
        const coverageLost = report.lost.filter((item) => item.reason !== 'polarity');
        if (policy.auditBlockOnLoss && coverageLost.length > 0) {
          const error = new Error(
            `compaction: ${coverageLost.length}/${report.checked} user constraint line(s) are missing from the checkpoint ` +
              `(worst coverage ${report.worstCoverage}; first: "${coverageLost[0].line.slice(0, 120)}"); ` +
              'refusing to replace the original messages rather than silently dropping a constraint. ' +
              'Set auditBlockOnLoss: false to accept this tradeoff.',
          );
          error.code = 'CONSTRAINT_LOST';
          throw error;
        }
      }

      // 原文落盘，供 history_* 工具回查。
      //
      }

      // ⚠️ 写失败必须**中止压缩**，不能带着 `archivePath: null` 继续提交。
      // 压缩一旦提交，被折叠的那些消息就从 surface 上消失了 —— 此时 `history_*`
      // 是唯一还能读到原文的入口。归档悄悄失败却照样替换，等于把"可回查"
      // 这个保证单方面作废：用户以为历史还在，实际已经读不到了。
      const finalProgress=validateProgressFacts(summarized.rawText,collectProgressFacts(session,shadowedSeqs));
      if(!finalProgress.ok)throw Object.assign(new Error(finalProgress.message),{code:finalProgress.code});
      let archivePath = null;
      if (policy.archiveEnabled) {
        archivePath = await this.archive.writeSpan({
          sessionId: session.id,
          compactionId,
          entries: spanEntries(session, shadowedSeqs),
          signal,
        });
        if (!archivePath) {
          const error = new Error(
            'compaction: archiving the shadowed span failed; refusing to replace it on the surface',
          );
          error.code = 'ARCHIVE_FAILED';
          throw error;
        }
      }

      if (options.continuation || policy.archiveEnabled && memorySelection?.decisions.length) {
        const verified = await this.archive.readSpan(session.id, compactionId);
        if (!verified.ok || verified.entries.length !== shadowedSeqs.length || verified.entries.some((entry,i)=>entry.seq!==shadowedSeqs[i])) throw Object.assign(new Error('Source archive verification failed; original context retained.'), {code:'CONTINUATION_ARCHIVE_INVALID'});
      }
      stage = 'commit';

      // ── 提交段（前半：可失败的部分都在替换之前）────────────────────────────
      // ⚠️ surface 替换是**不可逆**的：宿主的事件日志只追加，`surfaceOp.replace`
      // 把一段节点收成一个，没有任何"摊开"的操作（`dsh-session/lib/index.js` 里
      // 找不到 rollback / revert）。所以顺序必须是"能在替换前失败的，全部放在
      // 替换前"：摘要事件写进去、手动路径先等一次持久化边界，都确认成功了，
      // 才做那个收不回来的替换。
      //
      // `user/message` 的事件数据**就是消息本身**（不是 `{message}` 包装），
      // 而且 `assertMessageEventShape` 要求它带非空 `id`、`role === 'user'`、
      // `source.kind` 非空、`content` 是数组。少了 `id` 会直接抛
      // "session event ... lacks an identified message"，压缩在最后一步失败。
      const sourceMemory = memorySelection ? {
        progressFacts:progressSourceRefs(progressSelection),summaryScope:progressSelection?.scope,
        workReport:workReportRef(collectWorkReport(session,shadowedSeqs)),
        memoryRequirements: preservedForSource(memoryRequirements(memorySelection.active)) ?? [],
        memorySources: memorySourceRefs(memorySelection.active, session),
        memoryDecisions: memorySelection.decisions.map(({text, ...decision}) => decision),
      } : summarized.sourceMemory ?? {};
      const checkpointMessage = {
        id: newMessageId(),
        role: 'user',
        content: checkpointBlocks,
        // 第三参数把原话的结构化副本挂到 source 上，供下一代压缩续传。
        source: options.continuation ? Object.freeze({...sourceMemory,...compactCheckpointSource(compactionId,sourceCommandId,preservedForSource(preserved)),preserved:preservedForSource(preserved) ?? [],continuation:summarized.continuation}) : Object.freeze({...compactCheckpointSource(compactionId, sourceCommandId, preservedForSource(preserved)),preserved:preservedForSource(preserved) ?? [],...sourceMemory}),
      };

      // 这里先写 `compaction/summary`：它带 summary / rawOutput / shadowedSeqs，
      // 就算后面替换失败，这条事件也已经把"这次压缩想做什么"记在日志里了。
      const summaryEvent = this._appendSync(session, 'compaction/summary', {
        compactionId,
        ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
        summary: summarized.summary,
        rawOutput: summarized.modelRawOutput ?? summarized.summary,
        ...(summarized.reconstruction ? { reconstruction: summarized.reconstruction } : {}),
        ...(summarized.continuation ? {continuation:summarized.continuation} : {}),
        llmStreamCall: true,
        shadowedRange: { start, end },
        shadowedSeqs,
        shadowedTokenCount,
        provider: summarized.provider,
        model: summarized.model,
        maxTokens: summarized.maxTokens,
        ...(summarized.usage === null || summarized.usage === undefined ? {} : { usage: summarized.usage }),
      });

      // 替换前的持久化检查点。磁盘满这类故障在这里就会被拦下，
      // 而此时 surface 一个字节都没动 —— 用户看到的是"这次没压成"，
      // 而不是"压成了但历史读不到了"。
      if (typeof this.ctx.sessions?.flush === 'function') {
        try {
          await this._flushSession(session);
        } catch (error) {
          const error2 = new Error(
            `compaction persistence failed before the surface was replaced: ${error?.message ?? error}`,
          );
          error2.code = 'commit';
          error2.compactionStage = 'commit';
          error2.cause = error;
          throw error2;
        }
      }

      // ⚠️ 替换之前落一笔**持久**的事务记录。
      // 宿主没有回滚（`applySurfacePlan` 对 replace 做 splice，收进去摊不回来），
      // 所以"替换之后失败"唯一能补救的，是让下一次启动知道这次事务走到哪了：
      // 记下 compactionId，下次就能判断"这个会话是不是留了一把没关上的锁"。
      // 这一步必须在替换**之前** —— 替换和 end 之间不允许有 await。
      await this._journalRecord(session, compactionId, 'committing', start, end);

      // 替换之前最后确认一次跨度还在（预检查点是一次 await，surface 可能变了）。
      if (options.continuationPending) assertPendingSource(session, options.continuationPending);
      const nodesBeforeCommit = session.surface?.nodes ?? [];
      const sliceBeforeCommit = nodesBeforeCommit.slice(startIdx, endIdx + 1);
      if (
        sliceBeforeCommit.length !== shadowedSpanSnapshot.length ||
        sliceBeforeCommit.some((seq, i) => seq !== shadowedSpanSnapshot[i])
      ) {
        const error = new Error(
          'compaction: the selected span changed while the summary was being generated',
        );
        error.code = 'SPAN_CHANGED';
        throw error;
      }

      // ⚠️ 替换前**最后一次**确认取消状态。
      // 上面那次 `flush` 是 await：等待期间用户可能按了 Esc、agent 也可能
      // 收回维护窗口。surface 替换收不回来，所以"取消"必须在它之前生效 ——
      // 一旦替换执行了，用户得到的回复是 cancelled，历史却被改掉了，
      // 那是比"压缩失败"严重得多的事。宿主官方实现同样在提交前复查
      // （`dsh-compaction-basic/lib/index.js:477-485`）。
      if (signal?.aborted) {
        const cancelled = new Error('manual compaction was cancelled before the surface was replaced');
        cancelled.code = 'cancelled';
        cancelled.cause = signal.reason;
        throw cancelled;
      }
      signal?.throwIfAborted?.();

      // ⚠️ 从替换到 end 写完**不允许有 await**：中途让出事件循环，别的写入
      // （用户插话、工具结果）会把 surface 改掉，替换边界就失效了 —— 官方
      // 的实现也是在同一同步段里连写 replacement / end。
      if (this.transactionAdapter && typeof session.restoreCompactionSurface !== 'function') {
        const staged = this.transactionAdapter.stage(session, shadow => {
          const replacement = this._appendSync(shadow, 'user/message', checkpointMessage, {
            surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
            sourceEventSeqs: [startEvent?.seq, summaryEvent?.seq, ...shadowedSeqs].filter(seq => typeof seq === 'number'),
          });
          const endEvent = this._appendSync(shadow, 'compaction/end', lifecycle);
          return { replacement, endEvent };
        });
        const record = (await this.journal.pending(session.id)).find(r => r.compactionId === compactionId);
        if (!record || record.corrupt || record.phase !== 'committing') throw new Error('durable preparation journal is missing');
        const { replacement, endEvent } = await this.transactionAdapter.commit(this, session, record, staged, signal);
        stockCommitted = true; replaced = true; closing = true; closed = true;
        committed = { summarized, preserved, archivePath, summaryEvent, replacement, endEvent, checkpointBlocks };
      } else {
      const replacement = this._appendSync(session, 'user/message', checkpointMessage, {
        surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
        sourceEventSeqs: [startEvent?.seq, summaryEvent?.seq, ...shadowedSeqs].filter(
          (seq) => typeof seq === 'number',
        ),
      });
      replaced = true;

      // ⚠️ 关闭动作只做一次：先立 `closing`，写成功才置 `closed`。
      // 但**替换已经发生**之后 end 写失败是例外：那时锁会永远开着，会话带着
      // 孤儿锁一路涨到 413。这种情况下必须再补一次（只补一次），把锁关上 ——
      // 宁可多一条 end，也不能留下一把永远打不开的锁。
      closing = true;
      let endEvent;
      try {
        endEvent = this._appendSync(session, 'compaction/end', lifecycle);
        closed = true;
      } catch (endError) {
        this.log('warn', `compaction/end failed after the surface was replaced: ${endError?.message ?? endError}; retrying once to close the lock`);
        endEvent = this._appendSync(session, 'compaction/end', {
          ...lifecycle,
          error: `compaction/end failed once and was retried: ${(endError?.message ?? String(endError)).slice(0, 1900)}`,
        });
        closed = true;
      }
      committed = { summarized, preserved, archivePath, summaryEvent, replacement, endEvent, checkpointBlocks };
      }
    } catch (error) {
      failure = { error, stage: closing ? 'commit' : stage };
      if (!closing) {
        closing = true;
        // `compaction/end.error` 在事件 schema 里是 **string**，不是对象
        // （`'compaction/end': { compactionId; sourceCommandId?; turn; error?: string }`）。
        // 塞对象会被 `validateSessionEventData` 直接拒掉，等于连"失败"都记不下来，
        // 会话就会带着一个永远不闭合的 compaction/start 锁（孤儿锁）一路涨到 413。
        const closeText = `${error?.code ? `${error.code}: ` : ''}${error?.message ?? String(error)}`;
        try {
          await this._append(session, 'compaction/end', { ...lifecycle, error: closeText.slice(0, 2000) });
          closed = true;
        } catch (closeError) {
          // end 都写不进去：真正的失败原因换成它，并按提交段归类。
          failure = { error: closeError, stage: 'commit' };
        }
      }
    }

    // ── 统一收尾 ───────────────────────────────────────────────────────────
    // 不管成功还是失败，只要 end 已经落盘就等一次持久化边界。宿主 JSONL 后端
    // 把普通事件放进后台队列，只有 `session/flush` 会真的 drain + fsync ——
    // "返回成功"必须意味着已经落盘。官方同样把 flush 放在事务外统一做
    // （`dsh-compaction-basic/lib/index.js:511-513`）。
    if (!stockCommitted && closed && typeof this.ctx.sessions?.flush === 'function') {
      try {
        await this._flushSession(session);
      } catch (error) {
        flushFailure = error;
      }
    }

    // ⚠️ 持久化等待期间，维护窗口可能已经被收回（`agent.cancel`、用户 Esc）。
    // flush 是异步的，`await` 之后必须重新确认这次操作还算不算数 —— 否则手动
    // 命令会在"已经被取消"的情况下回一条 `Compacted …` 成功消息，与宿主的
    // 取消协议相反。宿主在 flush 之后同样重新检查（`dsh-compaction-basic/lib/index.js:513`）。
    //
    // 只对**已提交**的手动事务做这个检查：没提交成功时下面的 failure 分支
    // 自己会抛，不该被取消语义盖掉真实原因。已经写进去的事件不回滚 —— 取消
    // 只能决定"这次操作算不算成功"，不能撤销已经落盘的 surface 替换。
    if (!stockCommitted && committed !== null && manual && flushFailure === undefined) {
      try {
        signal?.throwIfAborted?.();
      } catch (abortError) {
        const cancelled = new Error('manual compaction was cancelled');
        cancelled.code = 'cancelled';
        cancelled.cause = abortError;
        throw cancelled;
      }
    }

    if (failure !== undefined) {
      if (failure.error?.code === 'RECOVERY_REQUIRED') { this._recoveryBlocked.add(this._keyOf(session)); throw failure.error; }
      const error = failure.error;
      const failedStage = failure.stage;
      const errorText = `${error?.code ? `${error.code}: ` : ''}${error?.message ?? String(error)}`;

      // 取消不是故障。agent 收回维护窗口、用户按 Esc 都会走到这里，
      // 计入熔断的后果是"连续取消三次 → 这个会话永久不再自动压缩"。
      if (!isAbortError(error, signal)) {
        this._recordFailure(agent, session, error);
      }
      if (!replaced && closed && flushFailure === undefined) await this.journal.clear(session.id, compactionId);

      // ── L6：渐进收敛 ──────────────────────────────────────────────────────
      // 只有在"少压一点可能就能成"的失败上才重试；超时/全部目标失败/摘要不比
      // 原文小，重试也是白烧一次调用。
      //
      // ⚠️ 上面 `_recordFailure` 可能刚刚把会话打入熔断（第 3 次失败）。
      // 熔断的意义是"别再试了"——如果这里不复查，第 3 次失败之后仍会因为
      // `attempt < reactiveStep` 而再发一次摘要请求，等于把"3 次封顶"变成 4 次，
      // 而第 4 次注定失败，只是把账单和延迟都翻倍。
      if (
        !replaced &&
        closed &&
        flushFailure === undefined &&
        attempt < this.config.reactiveStep &&
        !signal?.aborted &&
        !this._stopped.has(this._keyOf(session)) &&
        this._isRecoverable(error) &&
        typeof options.reselect === 'function'
      ) {
        // 先让观察者知道这次摘要失败了（官方语义：返回 true = 已同步记录持久变更）。
        await this._dispatchSummaryError(session, shadowedSeqs, error, signal);

        const next = await options.reselect(attempt + 1, { start, end });
        if (next) {
          this.log(
            'warn',
            `summary failed (${errorText.slice(0, 160)}); retrying with a smaller span ${next.start}-${next.end} (attempt ${attempt + 2})`,
          );
          return this._compactSpan(next.start, next.end, agent, signal, options, attempt + 1);
        }
      }

      // 记下失败发生在哪一段：手动路径要靠它把未知错误码归类
      // （提交段的未知错误 = commit，其它 = summary）。属性挂在错误对象上而不是
      // 再包一层，自动压缩路径完全不受影响。
      if (error && typeof error === 'object' && error.compactionStage === undefined) {
        error.compactionStage = failedStage;
      }
      throw error;
    }

    if (flushFailure !== undefined) {
      const flushError = new Error(`compaction persistence failed: ${flushFailure?.message ?? flushFailure}`);
      flushError.code = 'persistence';
      flushError.cause = flushFailure;
      // ⚠️ 持久化失败也要计入熔断。它是"这次压缩没落盘"的**真实失败**，
      // 前面只把 summary/commit 阶段计进去，于是同一台机器磁盘一直满、
      // 每一轮都失败、每一轮都不计数 —— 永远触发不了"连续 3 次就别再试了"。
      this._recordFailure(agent, session, flushError);
      throw flushError;
    }
    if (committed === null) {
      throw new Error('compaction committed without a result');
    }
    const { summarized, preserved, archivePath, summaryEvent, replacement, endEvent, checkpointBlocks } =
      committed;

    // Native patched fallback only; stock adapter already committed this state.
    if (!stockCommitted) {
    // 先完成持久策略更新；写失败仍保留 journal 和原事件快照。
    try {
      this.sessionState.update(session.id, state => ({ ...state, failures: 0, stopped: false }));
    } catch (cause) {
      const error = new Error(`compaction replaced history but could not save policy state: ${cause?.message ?? cause}`);
      error.code = 'commit'; error.compactionStage = 'commit'; error.cause = cause;
      throw error;
    }

    // The durable success decision is owned by the plugin on EVERY host.
    // Cleanup failure must not turn a successful stock-host commit into an
    // unresolved transaction, nor depend on a companion core patch.
    signal?.throwIfAborted?.();
    await this._journalRecord(session, compactionId, 'committed', start, end);
    }

    // 事务走完了：把持久痕迹清掉。留着的文件天然意味着"上次没走完"，
    // 下次启动会被 `recoverPending` 拿去收尾。
    if (this.journal && typeof this.journal.clear === 'function') {
      await this.journal.clear(session.id, compactionId);
    }

    if (options.continuation) settleContinuation(this.sessionState, session);

    this._failures.delete(this._keyOf(session));
    // ⚠️ 熔断必须能解除。`_stopped` 是"连续失败太多次，别再自动压了"的闸门，
    // 但成功的这次证明压缩链是通的 —— 如果只清计数不清闸门，一次瞬时故障
    // （比如一次网络抖动）就会让这个会话**永久**不再自动压缩，一路涨到 413。
    this._stopped.delete(this._keyOf(session));
    this._lastSummary.set(session, summarized.rawText);
    const after = await this._measure(session);
    noteDiagnosticMeasurement(after,{stage:'after'});
    if (after) this._lastTotal.set(session, after.totalTokens);

    // 注意：CompactionResult 的 startSeq / summarySeq / endSeq 是**事件 seq**，
    // 不是 surface 位置。官方 `commitCompactionBody` 返回的是 `startEvent.seq`
    // 与 `completeCompaction` 补上的 `endEvent.seq`。被覆盖的范围另由
    // `shadowedRange` 表达。
    const result = {
      compactionId,
      ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
      startSeq: startEvent?.seq ?? start,
      summarySeq: summaryEvent?.seq ?? replacement?.seq ?? start,
      endSeq: endEvent?.seq ?? end,
      summary: checkpointBlocks,
      shadowedRange: { start, end },
      shadowedSeqs,
      shadowedTokenCount,
      // 这个数有多可信，一并交给调用方：`/compact` 的输出、日志、审计都要用。
      // 只给数字不给口径，等于让下游把粗估当实测。
      shadowedTokenPrecision,
      provider: summarized.provider,
      model: summarized.model,
      ...(summarized.continuation ? {continuation:summarized.continuation} : {}),
      preservedUserMessages: preserved.length,
      archivePath,
    };

    if (this.config.debug) {
      this.log('info', `compacted ${shadowedSeqs.length} seq(s) via ${summarized.provider}/${summarized.model}`);
    }
    return result;
  }

  /** 哪些失败值得"少压一点再试一次"。 */
  _isRecoverable(error) {
    const code = error?.code;
    if (error?.summaryRetryExhausted) return false;
    // 聚合错误要先看它自己带出来的 recoverable 标记：目标链里只要有一条是
    // "窗口撑爆"，缩小跨度就还有救；否则整体放弃。
    if (code === 'SUMMARY_ALL_FAILED') return error?.recoverable === true;
    if (code === 'SUMMARY_TIMEOUT' || code === 'NO_SUMMARY_TARGET') return false;
    if (code === 'SUMMARY_NOT_SMALLER') return false;
    if (code === 'ABORTED') return false;
    if (code === 'MAX_TOKENS' || code === 'UNSUPPORTED_CONTENT') return true;
    // 窗口溢出要按 code 认，不能只靠 message 正则：适配器给出的原文常常是
    // "request failed" 之类的通用文案，关键词一个都不在里面。
    if (code === 'CONTEXT_WINDOW_EXCEEDED') return true;
    const message = error?.message ?? '';
    if (/context length|context window|too long|CONTEXT_WINDOW_EXCEEDED/i.test(message)) return true;
    return false;
  }

  async _dispatchSummaryError(session, sourceEventSeqs, error, signal) {
    if (typeof this.ctx.waterfall !== 'function') return false;
    try {
      const accepted = this.ctx.waterfall(
        'compaction/summary-error',
        { session, sourceEventSeqs, error, ...(signal === undefined ? {} : { signal }) },
        () => false,
      );
      return typeof accepted?.then === 'function' ? await accepted : accepted;
    } catch {
      return false;
    }
  }

  /**
   * 估算一段 checkpoint 内容的 token。
   *
   * 优先用宿主 `tokenMeter.estimateMessage`（当前宿主使用字符粗估，非模型 tokenizer），
   * 退化为本地粗估。**必须**用同一个口径去比"是否比原文小"，否则两套口径
   * 各算各的，检查会形同虚设。
   */
  _estimateCheckpointTokens(blocks) {
    const meter = this.ctx.tokenMeter;
    if (meter && typeof meter.estimateMessage === 'function') {
      try {
        const value = meter.estimateMessage({ id: 'estimate', role: 'user', content: blocks });
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
      } catch {
        // 退化到本地估算
      }
    }
    return approxTokens(blocksToText(blocks));
  }

  // ────────────────────────────────────────────────────────────── 内部工具

  async _flushSession(session) {
    const participated = await this.ctx.sessions.flush(session);
    // Real SessionStore returns false when no durability listener owns this session.
    if (participated === false) {
      const error = new Error('compaction requires a session persistence listener; flush did not persist the session');
      error.code = 'persistence'; throw error;
    }
    return participated;
  }

  _recordFailure(agent, session, error) {
    // Rechecking a spent budget without a new request is a free pause. If this
    // operation did spend requests before exhausting it, a failed request was
    // consumed (e.g. audit rejection before a blocked corrective request).
    // Count that failed operation once; never exempt it because the final
    // error happens to be the budget guard. Legacy errors have no new-call
    // evidence and keep the conservative free-pause behavior.
    const budget=continuationBudgetInfo(error);
    if(budget&&!(budget.requestsThisAttempt>0))return;
    const key = this._keyOf(session);
    this._restoreState(session);
    const state = this.sessionState.update(session.id, current => {
      const failures = current.failures + 1;
      return { ...current, failures, stopped: failures >= this.config.failureThreshold };
    });
    const next = state.failures;
    this._failures.set(key, next);
    if (next >= this.config.failureThreshold && !this._stopped.has(key)) {
      this._stopped.set(key, true);
      this.log(
        'warn',
        `compaction disabled for this session after ${next} consecutive failures (last: ${error?.message ?? error}); ` +
          'automatic retries are stopped; inspect the error and retained recovery journal for commit status',
      );
    }
  }

  _audit(session, shadowedSeqs, summaryTextValue, compactionId, checkpointBlocks, policy=this.config) {
    let selection;
    try {
      selection = selectSessionMemory(session, shadowedSeqs, {approxTokens});
    } catch (error) {
      const failure = new Error(`compaction: constraint audit could not read source messages: ${error?.message ?? error}`);
      failure.code = 'AUDIT_UNAVAILABLE'; failure.cause = error; throw failure;
    }

    const report = auditMemorySelection({
      selection,
      summaryText: summaryTextValue,
      // ⚠️ 必须把完整检查点也交进去。用户原话被逐字保留在检查点末尾时，
      // 摘要正文里当然没有它 —— 那不是丢失。只看摘要正文会把"原文就在
      // 下游模型能读到的地方"报成约束丢失。
      checkpointText: Array.isArray(checkpointBlocks)
        ? checkpointBlocks.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
        : undefined,
      threshold: policy.auditCoverageThreshold,
      includeAllConflicts: true,
    });

    const flips = report.lost.filter((item) => item.reason === 'polarity');
    if (report.lost.length > 0) {
      this.log(
        'warn',
        `constraint audit ${compactionId}: ${report.lost.length}/${report.checked} source sentence(s) failed audit ` +
          `(${flips.length} polarity reversal(s), worst coverage ${report.worstCoverage}); ` +
          `seq=${report.lost[0].seq}, reason=${report.lost[0].reason}; source: ${JSON.stringify(report.lost[0].line.slice(0, 120))}; ` +
          `candidate: ${JSON.stringify(report.lost[0].candidate?.slice(0, 120) ?? null)}`,
      );
    } else if (report.checked > 0 && this.config.debug) {
      this.log('info', `constraint audit ${compactionId}: all ${report.checked} source sentence(s) preserved`);
    }
    return report;
  }

  _shadowedTokens(session, shadowedSeqs) {
    const priced = this._lastPriced?.get(session);
    let total = 0;
    for (const seq of shadowedSeqs) {
      // ⚠️ 缺价时不能用 0 顶替。写 `priced.get(seq) ?? 0` 意味着"没有计价 = 这段
      // 不占 token"，于是被折叠区间的原始体量被系统性低估，"摘要必须比原文小"
      // 这道门的基准也就跟着虚低 —— 判据还在，但它比的是错的分母。
      // 没有真实计价就退回字符估算，宁可估算，也不要凭空当零。
      const cost = priced?.get(seq);
      if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) {
        total += cost;
        continue;
      }
      const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
      const message =
        typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : undefined;
      total += approxTokens(blocksToText(message?.content));
    }
    return total;
  }

  async _measure(session) {
    const meter = this.ctx.tokenMeter;
    if (!meter || typeof meter.measure !== 'function') return null;
    try {
      const measurement = await meter.measure(session);
      if (!measurement || typeof measurement !== 'object') return null;

      // 宿主真实口径：`measure()` 是**同步**的，返回
      // `{logRevision, baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes}`，
      // 其中 `nodes[]` 元素是 `{seq, tokens, heuristicTokens}` —— 不是裸 seq 数字。
      // 这里统一归一化成"序号数组 + seq→tokens 的 Map"，下游只认这一种形态。
      const rawNodes = Array.isArray(measurement.nodes) ? measurement.nodes : [];
      const nodes = [];
      const priced = new Map();
      for (const node of rawNodes) {
        if (typeof node === 'number') {
          nodes.push(node);
          continue;
        }
        if (!node || typeof node !== 'object' || typeof node.seq !== 'number') continue;
        nodes.push(node.seq);
        const cost = typeof node.tokens === 'number' && Number.isFinite(node.tokens) ? node.tokens : node.heuristicTokens;
        if (typeof cost === 'number' && Number.isFinite(cost)) priced.set(node.seq, cost);
      }
      if (nodes.length === 0 && Array.isArray(session.surface?.nodes)) {
        nodes.push(...session.surface.nodes);
      }

      const totalTokens =
        typeof measurement.totalTokens === 'number'
          ? measurement.totalTokens
          : typeof measurement.total === 'number'
            ? measurement.total
            : 0;

      // 计量口径要**跟着数字一起交出去**，不能让下游把估算当实测。
      //
      // ⚠️ 判断依据不是"`tokens` 这个字段在不在"。宿主 `priceSurface`
      // （`dsh-token-meter/lib/index.js:611-668`）**总会**返回 `tokens`：
      // 没有路由图片/文件定价时它就是 `heuristicTokens` 的副本
      // （`tokens: node.heuristicTokens`），节点本身只有 `heuristicTokens`
      // 是"4 字符一个 token"的粗估（`analyzeNode` 只算 `estimateMessage`）。
      // 所以"有 `tokens` 字段"等于什么信息都没有 —— 按它判会把整场粗估
      // 标成 `priced`，顺带把那句"非精确"的提示也抑制掉。
      //
      // 真正的信号有两个，都不在节点上：
      // - **节点级**：`tokens !== heuristicTokens`，说明路由定价（图片/文件
      //   的请求投影）真的替换了粗估；
      // - **整体级**：`baseline.kind === 'usage'`，说明总量里含真实响应 usage。
      let pricedCount = 0;
      let heuristicCount = 0;
      for (const node of rawNodes) {
        if (!node || typeof node !== 'object') continue;
        const heuristic = node.heuristicTokens;
        const tokens = node.tokens;
        const hasTokens = typeof tokens === 'number' && Number.isFinite(tokens);
        const hasHeuristic = typeof heuristic === 'number' && Number.isFinite(heuristic);
        if (!hasTokens && !hasHeuristic) continue;
        if (!hasTokens) {
          // 只有粗估：宿主没给它任何实数价格。
          heuristicCount += 1;
          continue;
        }
        // 只有 `tokens` 没有 `heuristicTokens`：宿主不这样返回，但外部计量服务
        // （或测试桩）给了实数就当它报了实数。两个都有时，相等 = 粗估副本，
        // 不等 = 路由定价（图片/文件投影）插过手。
        if (!hasHeuristic || tokens !== heuristic) pricedCount += 1;
        else heuristicCount += 1;
      }
      const baselineKind = measurement.baseline?.kind;
      const precision = pricedCount === 0 && heuristicCount === 0
        ? baselineKind === 'usage'
          ? 'priced'
          : 'unknown'
        : heuristicCount === 0
          ? 'priced'
          : pricedCount === 0
            ? baselineKind === 'usage'
              ? 'mixed'
              : 'heuristic'
            : 'mixed';

      this._lastPriced = this._lastPriced ?? new WeakMap();
      this._lastPriced.set(session, priced);
      this._lastPrecision = this._lastPrecision ?? new WeakMap();
      this._lastPrecision.set(session, precision);
      return { nodes, pricedBySeq: priced, totalTokens, precision, raw: measurement };
    } catch (error) {
      this.log('warn', `token measurement failed: ${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * 只解析"这个会话该用哪份策略"，不碰预算。
   *
   * ⚠️ 必须和 `_resolveSpec` 分开。预算计算会因为"窗口太小 / 预留太大 /
   * 保留量组合越界"抛错，而**摘要该发给谁**跟预算没关系。两者揉在一个函数里，
   * 任何预算异常都会连带把已经算好的 provider/model 策略丢掉，摘要退回全局
   * 配置 —— 用户配了 `modelPolicies[i].summarizationProvider` 却被静默改道，
   * 这种回退比直接报错更糟。
   *
   * 同步、无副作用、不抛错（provider/model 缺失时只是匹配不到覆盖项）。
   */
  _resolvePolicy(agent) {
    const durable = latestDurableTarget(agent);
    const provider = durable?.provider ?? agent?.options?.provider;
    const model = durable?.model ?? agent?.options?.model;
    return resolveTargetPolicy(this.config, provider, model);
  }

  async _resolveSpec(agent, measurement, signal) {
    const session = agent?.session;
    const durable = latestDurableTarget(agent);
    const provider = durable?.provider ?? agent?.options?.provider;
    const model = durable?.model ?? agent?.options?.model;

    let adapterInfo;
    try {
      if (provider && model && typeof this.ctx.llm?.resolveModelInfo === 'function') {
        adapterInfo = await this.ctx.llm.resolveModelInfo(provider, model, signal);
      }
    } catch {
      adapterInfo = undefined;
    }

    signal?.throwIfAborted?.();
    let locked;
    try {
      this.sessionState.update(session.id, state => {
        locked = lockWindow({
          session, persisted: state.window, provider, model,
          adapterWindow: contextWindowOf(adapterInfo),
          providerMap: this.config.windowProviderMap,
          fallback: this.config.windowFallback, clampMin: this.config.windowClampMin,
        });
        return { ...state, window: locked };
      });
    } catch (cause) {
      const error = new Error(`durable compaction policy is unavailable: ${cause.message}`);
      error.code = 'STATE_UNAVAILABLE'; error.cause = cause; throw error;
    }
    const reserved = this._reservedCompletionTokens(agent, defaultMaxTokensOf(adapterInfo));
    // 按 provider+model 应用 `modelPolicies` 覆盖项。
    // ⚠️ 顺序不能反：先拿到 provider/model（上面从 durable target 解析出来的），
    // 再拿它去查覆盖项，最后才用合并后的配置算 spec。直接用全局配置算 spec 时，
    // `modelPolicies` 里的 maxTokens / 阈值会全部静默失效。
    const effective = resolveTargetPolicy(this.config, provider, model);
    return {
      ...resolveCompactSpec(effective, locked.safetyWindow, reserved),
      windowSource: locked.source,
      lockedWindow: locked.window,
      safetyWindow: locked.safetyWindow,
      provider,
      model,
      // 合并后的整份策略要跟着 spec 一起往下传：摘要目标、超时、语言、保留尾
      // 也都按同一个 provider/model 解析，否则会出现"预算按目标模型算、
      // 摘要却发给全局配置的模型"这种自相矛盾的状态。
      policy: effective,
    };
  }

  /**
   * 预留多少 token 给模型输出。
   *
   * ⚠️ 必须与宿主逐字对齐，只认两个来源：
   * `requestHeader().config.maxTokens`（这次请求实际会用的输出上限，用户在 UI
   * 里改的就是它）和适配器报出来的默认上限，两者都没有就是 **0**。
   *
   * 两个常见的"想当然"都会算错：
   * - 把适配器默认值排在 header 前面 → header 写 4096、适配器默认 65536 时
   *   预留 65536，凭空少算 6 万 token，压缩线被人为抬高一大截。
   * - 拿不到 header 时退回 `agent.options.maxTokens` 或插件自己的摘要
   *   `maxTokens` → 前者是 agent 创建时的初始值，不等于这次请求；后者是
   *   **摘要请求**的输出上限，跟对话请求的预留毫无关系，8192 是凭空的。
   *
   * 宿主实现：`dsh-compaction-basic/lib/index.js:757-759`
   * `agent.session.requestHeader()?.config.maxTokens ?? defaultMaxTokens ?? 0`
   */
  _reservedCompletionTokens(agent, defaultMaxTokens) {
    const header = typeof agent?.session?.requestHeader === 'function' ? agent.session.requestHeader() : undefined;
    const headerMax = header?.config?.maxTokens;
    const candidate = headerMax ?? defaultMaxTokens ?? 0;
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) return candidate;
    return 0;
  }

  /**
   * 落一笔事务日志。
   *
   * 写失败必须抛出，阻止不可恢复提交；错误在生命周期边界内统一收尾。
   */
  async _journalRecord(session, compactionId, phase, start, end) {
    if (!this.journal || typeof this.journal.record !== 'function') return;
    try {
      await this.journal.record({
        sessionId: session?.id,
        compactionId,
        phase,
        failuresBefore: this.sessionState.read(session.id).failures,
        ...(phase === 'started' ? { startEventSeq: session.seq - 1 } : {}),
        ...(start === undefined ? {} : { startSeq: start }),
        ...(end === undefined ? {} : { endSeq: end }),
        ...(phase !== 'committing' ? {} : { snapshot: (session.surface?.nodes ?? []).map(seq => ({ seq, event: session.eventAt(seq), message: session.deriveEventMessage(session.eventAt(seq)) })) }),
      });
    } catch (error) {
      this.log('warn', `compaction journal write failed (${phase}): ${error?.message ?? error}`);
      error.code ??= 'persistence';
      throw error;
    }
  }

  /**
   * 收尾上一次没走完的事务。
   *
   * review.5 原装事务由根适配器在加载前恢复；此处完成生命周期/日志收尾。
   * 历史补丁路径仍可使用 rollback；旧版已发布但无备份的未决替换必须阻断。
   * committed 是成功决策；恢复失败保留日志，前置钩子阻止后续模型请求。
   * 重复恢复幂等，取消不计失败，其余恢复以 failuresBefore 保留熔断次数。
   * @param {object} session
   */
  async recoverPending(session, owned = false, failureKind = 'interrupted') {
    if (!session?.id || !this.journal) return { recovered: 0 };
    if (this.transactionAdapter?.blocked.has(session.id)) { const error = new Error('Session writer is quarantined; restart DSH to restore the verified transaction backup.'); error.code = 'RECOVERY_REQUIRED'; throw error; }
    const key = `${this.sessionState.root}:${JSON.stringify(session.id)}`;
    if (!owned && activeTransactions.has(key)) return { recovered: 0, busy: true };
    if (!owned) activeTransactions.add(key);
    try {
      const pending = await this.journal.pending(session.id);
      let recovered = 0, restored = 0;
      for (const record of pending) {
        if (record.corrupt) throw new Error(`compaction recovery journal is corrupt; preserved for repair: ${record.file}`);
        const events = Array.from({ length: session.seq }, (_, i) => session.eventAt(i));
        const start = events.find(e => e?.type === 'compaction/start' && e.data?.compactionId === record.compactionId);
        const end = events.find(e => e?.type === 'compaction/end' && e.data?.compactionId === record.compactionId);
        if (!start) {
          const state = inspectCompactionEntryState(session);
          // No destructive operation can precede its start event. A fully replayed
          // prefix ending before the recorded start is an interrupted pre-publication.
          if (record.phase === 'started' && Number.isSafeInteger(record.startEventSeq) && (session.firstLiveSeq ?? session.seq) <= record.startEventSeq && state.unmatchedCompactionStart === null) {
            await this._flushSession(session); await this.journal.clear(session.id, record.compactionId); continue;
          }
          throw new Error(`pending compaction ${record.compactionId} is absent from the loaded log; recovery requires the complete session`);
        }
        if (record.phase !== 'committed' && typeof session.restoreCompactionSurface !== 'function') {
          const replacement = events.find(event => event?.type === 'user/message'
            && event.data?.source?.kind === 'compact-checkpoint'
            && event.data.source.compactionId === record.compactionId
            && event.surfaceOp && event.surfaceOp !== 'append');
          if (replacement) {
            this._recoveryBlocked.add(this._keyOf(session));
            if (!end) {
              const open = inspectCompactionEntryState(session).unmatchedCompactionStart;
              if (open === null || session.eventAt(open)?.data?.compactionId !== record.compactionId) throw new Error('pending journal does not match the active compaction; refusing to close another transaction');
              this._appendSync(session, 'compaction/end', { ...start.data, error: 'Compaction failed after replacement; lifecycle closed only. Original surface is NOT restored; recovery is required.' });
              await this._flushSession(session);
            }
            const reason = record.failureKind ?? failureKind;
            if (record.failureKind === undefined) await this.journal.record({ ...record, sessionId: session.id, failureKind: reason });
            if (reason !== 'cancelled' && Number.isSafeInteger(record.failuresBefore)) {
              this.sessionState.update(session.id, current => {
                const failures = Math.max(current.failures, record.failuresBefore + 1);
                return { ...current, failures, stopped: failures >= this.config.failureThreshold };
              });
              this._restoreState(session);
            }
            const error = new Error(`compaction ${record.compactionId} changed the surface without a durable success decision; this host has no supported restoration API. Original events and recovery journal are retained; further model requests are blocked.`);
            error.code = 'RECOVERY_REQUIRED'; error.compactionStage = 'commit';
            error.compactionId = record.compactionId; error.replacementSeq = replacement.seq;
            throw error;
          }
        }
        if (record.phase !== 'committed' && typeof session.restoreCompactionSurface === 'function') {
          const rolledBack = session.restoreCompactionSurface(record.compactionId, record.failureKind ?? failureKind);
          if (rolledBack) {
            restored++;
            if (rolledBack.data?.reason !== 'cancelled' && Number.isSafeInteger(record.failuresBefore)) {
              this.sessionState.update(session.id, current => {
                const failures = Math.max(current.failures, record.failuresBefore + 1);
                return { ...current, failures, stopped: failures >= this.config.failureThreshold };
              });
              this._restoreState(session);
            }
          }
        }
        if (!end) {
          const state = inspectCompactionEntryState(session);
          const open = state.unmatchedCompactionStart;
          if (open === null || session.eventAt(open)?.data?.compactionId !== record.compactionId) throw new Error('pending journal does not match the active compaction; refusing to close another transaction');
          this._appendSync(session, 'compaction/end', { ...start.data, error: `recovered interrupted compaction (${record.phase}); surface restoration ${typeof session.restoreCompactionSurface === 'function' ? 'checked through host protocol' : 'unavailable on this host'}` });
          recovered++;
        }
        if (typeof this.ctx.sessions?.flush !== 'function') throw new Error('cannot clear recovery journal without a durability checkpoint');
        await this._flushSession(session);
        await this.journal.clear(session.id, record.compactionId);
      }
      settleContinuation(this.sessionState, session);
      this._recoveryBlocked.delete(this._keyOf(session));
      return { recovered, restored };
    } finally { if (!owned) activeTransactions.delete(key); }
  }

  _restoreState(session) {
    if (!session?.id) return;
    let state = this.sessionState.read(session.id);
    const key = this._keyOf(session);
    if(!this._recoveryBlocked.has(key)&&sourceBreakerRecoverable(session,state)){
      const expectedFailures=state.failures;
      state=this.sessionState.update(session.id,current=>current.stopped&&current.failures===expectedFailures&&!current.sourceFragmentRecovery
        ? {...current,failures:0,stopped:false,sourceFragmentRecovery:{version:2,previousFailures:expectedFailures,at:new Date().toISOString()}}
        : current);
      if(!state.stopped)this.log('info','Recovered the legacy memory-source circuit breaker after verifying every surviving source; original conversation unchanged.');
    }
    this._failures.set(key, state.failures);
    if (state.stopped) this._stopped.set(key, true);
    else this._stopped.delete(key);
    return state;
  }

  async _pruneToolResults(session) {
    try {
      const pruner = typeof this.ctx.get === 'function' ? this.ctx.get('toolResultPruner') : undefined;
      if (pruner && typeof pruner.pruneSession === 'function') {
        await pruner.pruneSession(session);
      }
    } catch (error) {
      this.log('warn', `tool-result pruning failed: ${error?.message ?? error}`);
    }
  }

  /**
   * 写一条会话事件。
   *
   * 这个函数**不能**是 `async`：`session.append` 是同步 API（返回深冻结的
   * 事件对象），而提交段依赖"三个事件之间不让出事件循环"。声明成 `async`
   * 会让返回值无条件变成 Promise，`_appendSync` 的守卫就会把每一次正常提交
   * 都判成误用。需要等待的调用点直接 `await this._append(...)` —— 对非
   * Promise 的 `await` 是恒等操作。
   */
  _append(session, type, data, options) {
    if (typeof session.append !== 'function') {
      throw new Error(`session.append is unavailable; cannot record ${type}`);
    }
    return options === undefined ? session.append(type, data) : session.append(type, data, options);
  }

  /**
   * 同步版本：提交段要求"三个事件之间不让出事件循环"。
   * `session.append` 本身就是同步的（返回深冻结事件对象），这里只是把
   * "返回 Promise" 这种误用挡住 —— 一旦有人在提交段里 `await`，别的写入
   * 就会插进来把 surface 改掉。
   */
  _appendSync(session, type, data, options) {
    const result = this._append(session, type, data, options);
    if (result && typeof result.then === 'function') {
      throw new Error(
        `session.append returned a promise for ${type}; the commit段 requires synchronous appends`,
      );
    }
    return result;
  }

  log(level, message) {
    const logger = this.ctx.logger;
    const text = `[compaction-weave] ${message}`;
    if (logger && typeof logger[level] === 'function') logger[level](text);
    else if (logger && typeof logger.info === 'function') logger.info(text);
  }
}

function findAgentForSession(engine, session) {
  return engine._agentBySession?.get(session);
}

function describeResult(result) {
  const count = Array.isArray(result?.shadowedSeqs) ? result.shadowedSeqs.length : 0;
  return `${result?.compactionId ?? '?'} (${count} seq(s), ${result?.provider ?? '?'}/${result?.model ?? '?'})`;
}

/** Canonical UTF-8 message payload, excluding source/log-only metadata; not an exact provider tokenizer. */
export function canonicalMessageBytes(messages) {
  const projected = messages.map(message => ({ role: message.role, content: message.content, ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }) }));
  return Buffer.byteLength(JSON.stringify(projected), 'utf8');
}
