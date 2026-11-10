import {summaryRetryPolicy,retryableSummaryError,waitForSummaryRetry,CONTENT_RETRY_CODES} from './summary-retry.js';
import {beginDiagnosticAttempt,finishDiagnosticAttempt,trackAuditDiagnostic} from './failure-diagnostics.js';
import { combineSignals } from './abort.js';
import { buildSummaryRequest, assertSummaryCapacity, observeSummaryOverflow } from './summary-budget.js';
// L3 + L4：摘要调用。
//
// 抄的是 bili 的 `compress.externalSummary` 思路——摘要可以走另一个模型，
// 而且**失败要能降级**，不能因为摘要模型挂了就整个压缩失败。
//
// 与官方 `summarizeWithLlm` 的关键差异：
//   1. 目标是「按优先级排的链」，逐个尝试，第一个成功就用（bili 的做法）。
//   2. 每次尝试有独立超时（官方是整条链路共用一个 signal）。
//   3. 失败原因分类记录，便于用户看清"为什么这次没压成"。
//   4. 摘要指令作为**最后一条 user 消息**追加，前面的对话前缀保持原样，
//      这样 provider 的 KV cache 还能复用（这点官方做对了，照抄）。

import { SummaryAssembler, summaryText } from './meter.js';
import { SummaryProgress } from './summary-progress.js';
import { buildCompactionInstruction, detectLanguage } from './prompt.js';

const COMPACTION_PURPOSE = 'compaction';

/**
 * 从会话的持久路由里拿 provider/model，用于「摘要跟着主对话走」。
 * @param {object} agent
 */
export function latestDurableTarget(agent) {
  const header = typeof agent?.session?.requestHeader === 'function' ? agent.session.requestHeader() : undefined;
  const config = header?.config;
  if (config && typeof config === 'object') {
    const provider = typeof config.provider === 'string' ? config.provider : undefined;
    const model = typeof config.model === 'string' ? config.model : undefined;
    if (provider && model) {
      return {
        provider,
        model,
        reasoningEffort: config.reasoningEffort,
        temperature: config.temperature,
        stop: config.stop,
      };
    }
  }
  return undefined;
}

/**
 * agent 自己声明的目标。
 * @param {object} agent
 */
export function agentTarget(agent) {
  const options = agent?.options;
  if (!options || typeof options !== 'object') return undefined;
  const provider = typeof options.provider === 'string' ? options.provider : undefined;
  const model = typeof options.model === 'string' ? options.model : undefined;
  if (!provider || !model) return undefined;
  return { provider, model, reasoningEffort: options.reasoningEffort, temperature: options.temperature, stop: options.stop };
}

/**
 * 组装按优先级排的摘要目标链。
 *
 * @param {object} args
 * @param {{summarizationProvider: string|null, summarizationModel: string|null}} args.config
 * @param {object} args.agent
 * @returns {{targets: {provider:string, model:string, reasoningEffort?:any, temperature?:any, stop?:any}[], source: string}}
 */
export function resolveSummaryTargets({ config, agent }) {
  const targets = [];
  const seen = new Set();
  const durable = latestDurableTarget(agent);
  const declared = agentTarget(agent);
  const push = (target, source) => {
    if (!target) return false;
    const key = `${target.provider}/${target.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    targets.push({ ...target, source });
    return true;
  };

  if (config.summarizationProvider && config.summarizationModel) {
    const configured = { provider: config.summarizationProvider, model: config.summarizationModel };
    // The configured route has priority, but must retain the active controls
    // when it names that exact route. Deduplication must not erase MAX.
    push({ ...configured, ...reusableControls(configured, declared), ...reusableControls(configured, durable) }, 'config');
  }
  push(durable, 'session');
  push(declared, 'agent');

  return { targets, source: targets[0]?.source ?? 'none' };
}

/**
 * 只在同一个 provider/model 上复用采样参数——跨路由复用 reasoningEffort 会把
 * 一个不支持的档位塞给另一个模型，直接 400。
 */
function reusableControls(target, primary) {
  if (!primary) return {};
  if (target.provider !== primary.provider || target.model !== primary.model) return {};
  const out = {};
  if (primary.reasoningEffort !== undefined) out.reasoningEffort = primary.reasoningEffort;
  if (primary.temperature !== undefined) out.temperature = primary.temperature;
  if (primary.stop !== undefined) out.stop = primary.stop;
  return out;
}

/**
 * 调一次摘要。
 *
 * @param {object} args
 * @param {object} args.ctx
 * @param {object} args.agent
 * @param {{messages: readonly any[], tools?: readonly any[]}} args.input
 * @param {{provider:string, model:string}} args.target
 * @param {{maxTokens:number, timeoutMs:number, language:'auto'|'zh'|'en', previousSummary?:string|null, primary?:any}} args.options
 * @param {AbortSignal} args.signal
 * @returns {Promise<{summary: readonly any[], rawText: string, provider: string, model: string, maxTokens: number, language: 'zh'|'en', usage: any}>}
 */
export async function summarizeWithTarget(args) {
  const { ctx, agent, input, target, options, signal } = args;

  const request = buildSummaryRequest(input, options);
  assertSummaryCapacity(request, options.capacity, target);
  const { messages, language } = request;

  const llmOptions = {
    provider: target.provider,
    model: target.model,
    messages,
    maxTokens: options.maxTokens,
    purpose: COMPACTION_PURPOSE,
    ...(typeof agent?.session?.id === 'string' ? { sessionId: agent.session.id } : {}),
    ...reusableControls(target, options.primary),
    ...(!options.isolatedTranscript && typeof agent?.session?.toolHistory === 'function' ? { toolHistory: agent.session.toolHistory() } : {}),
    ...(Array.isArray(input.tools) && input.tools.length > 0 ? { tools: [...input.tools] } : {}),
  };

  const timeoutMs = Math.max(5000, options.timeoutMs);
  const assembler = new SummaryAssembler();
  const progress = new SummaryProgress();
  const streamDiagnostics = () => ({...progress.snapshot(),chunks:assembler.chunkCount,textChars:assembler.text.length,reasoningChars:assembler.reasoningChars});
  const timeoutError = cause => {
    const diagnostics = streamDiagnostics();
    const fields = Object.entries(diagnostics).map(([key,value])=>`${key}=${value === null ? 'none' : value}`).join(', ');
    return Object.assign(new Error(
      `summarization timed out after ${timeoutMs}ms (${fields})`,
      cause === undefined ? undefined : {cause},
    ), {code:'SUMMARY_TIMEOUT',timeoutMs,target:`${target.provider}/${target.model}`,diagnostics});
  };
  // One deadline owns both the plugin's rejection and adapter cancellation.
  // Two independent timers can otherwise reject before the stream signal aborts.
  const timeoutController = new AbortController();
  const timeoutSignal = timeoutController.signal;
  const combinedSignals = combineSignals([signal, timeoutSignal]);
  const combined = combinedSignals.signal;
  llmOptions.signal = combined;
  const checkDeadline = () => {
    // Synchronous persistence/adapter work and hot microtasks can defer the
    // timer. Check the same monotonic deadline before dispatch or another read,
    // not only after a response arrives. Caller cancellation keeps its reason.
    if (progress.elapsed() >= timeoutMs && !signal?.aborted && !timeoutSignal.aborted) timeoutController.abort(timeoutError());
    combined?.throwIfAborted?.();
  };

  // ⚠️ 传 `signal` 只是**请求**适配器自己停下来，不是保证。
  // 适配器完全可以忽略这个字段、照旧把流吐完（第三方/自建后端都可能），
  // 于是 `for await` 会在超时之后继续等，最终拿到一个迟到几秒的结果并当成成功。
  // 这里必须自己在插件层建硬截止：
  //
  // - `abortPromise` 在超时/调用方取消时立刻 reject，把 await 抢回来；
  // - 流结束后再确认一次"这还算不算数"，迟到的结果一律拒收；
  // - 抢回来之后把迭代器 `return()` 掉，别把底层请求留在后台。
  let timer;
  let onAbort;
  const abortPromise = new Promise((_, reject) => {
    const fire = (reason) => reject(reason);
    timer = setTimeout(() => {
      timeoutController.abort(timeoutError());
    }, timeoutMs);
    // ⚠️ 这个 promise 的拒绝必须**从创建那一刻起就有人接住**。
    // 它只在 `Promise.race` 里被 await；如果初始化阶段就抛错（`ctx.llm.stream`
    // 同步 throw、或者 `[Symbol.asyncIterator]()` 抛），race 根本没跑起来，
    // 计时器到点后这个拒绝就成了 unhandledRejection —— 一次已经被 catch 住的
    // 摘要失败，仍会在几秒后把进程带走。挂一个空的 catch 只是"标记已处理"，
    // 真正的判定仍由上面的 race 负责。
    // ⚠️ 不要 `unref()`。这是个**必须按时触发**的截止计时器：unref 之后
    // 事件循环里没有别的活儿时 Node 会直接退出，留下的表现是
    // "unsettled top-level await" —— 超时根本没发生，硬截止就成了摆设。
    if (combined?.aborted) {
      fire(combined.reason ?? Object.assign(new Error('summarization aborted'), { code: 'ABORTED' }));
    } else if (typeof combined?.addEventListener === 'function') {
      onAbort = () => fire(combined.reason ?? Object.assign(new Error('summarization aborted'), { code: 'ABORTED' }));
      combined.addEventListener('abort', onAbort, { once: true });
    }
  });

  // ⚠️ 上面刚建的 abortPromise 在这里立刻标记为"已处理"。
  // 它在 `Promise.race` 里被 await 时自然有人接；但下面流初始化可能同步抛错，
  // 一旦抛出，race 就没有机会消费这个拒绝，计时器到点后它变成 unhandledRejection。
  // 这条 `catch` 只是把 promise 标记为已处理 —— 判定结果仍然由 race 决定。
  abortPromise.catch(() => {});

  // ⚠️ 流与迭代器的初始化必须放进 try 里。宿主 `llm.stream` 走 waterfall，
  // 中间的监听器允许同步 throw；`[Symbol.asyncIterator]()` 也可能抛。
  // 放在 try 外面时，这两处一抛就直接跳过下面的 finally，计时器与 abort 监听器
  // 都不会被清理，几秒后那次超时以未处理拒绝的形式炸出来。
  let iterator;
  let completed = false;
  let requestStarted = false;
  let streamFailure;
  try {
    await options.beforeRequest?.({target,maxTokens:options.maxTokens,requestBytes:request.inputUnits});
    checkDeadline();
    // Invocation can dispatch immediately or throw after dispatch. From this
    // point on, missing usage is unknown, never proof that nothing was sent.
    requestStarted = true;
    iterator = ctx.llm.stream(llmOptions)[Symbol.asyncIterator]();
    for (;;) {
      checkDeadline();
      const step = await Promise.race([iterator.next(), abortPromise]);
      checkDeadline();
      if (step.done) break;
      progress.observe(assembler.push(step.value));
    }
    completed = true;
  } catch (error) {
    streamFailure=error;
    if (error?.code === 'SUMMARY_TIMEOUT' || (timeoutSignal.aborted && !signal?.aborted)) {
      const wrapped = error?.code === 'SUMMARY_TIMEOUT'
        ? error
        : timeoutError(error);
      throw wrapped;
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) combined?.removeEventListener?.('abort', onAbort);
    combinedSignals.dispose();
    if (!completed && iterator && typeof iterator.return === 'function') {
      // 抢回控制权之后主动收尾：不 await（底层可能永远不结束），只求把
      // 取消信号传下去，别让请求挂在后台继续烧额度。
      try {
        Promise.resolve(iterator.return()).catch(() => {});
      } catch {
        /* 迭代器已经死了 */
      }
    }
    await options.afterRequest?.({target,usage:assembler.usage??null,completed,requestStarted,diagnostics:streamDiagnostics(),errorCode:timeoutSignal.aborted?'SUMMARY_TIMEOUT':streamFailure?.code??(streamFailure?'ERROR':null)});
  }

  // 迟到结果拒收：走到这里说明流跑完了，但可能是在超时之后才跑完的。
  // 宿主拿到 `signal.aborted` 之后不该再提交任何东西（`SUMMARY_TIMEOUT` 也好、
  // 调用方取消也好），否则"插件层硬截止"就只是个摆设。
  if (timeoutSignal.aborted && !signal?.aborted) {
    throw timeoutError();
  }
  if (signal?.aborted) {
    throw Object.assign(new Error('summarization was cancelled'), { code: 'ABORTED', cause: signal.reason });
  }
  assembler.throwIfFailed();

  const summary = summaryText(assembler.blocks());
  return {
    summary,
    rawText: assembler.text,
    provider: target.provider,
    model: target.model,
    maxTokens: options.maxTokens,
    // 把实际选中的语言带出去：调用方要按同一套小节标题做提交前校验，
    // 自己再猜一遍（或按配置里的 `auto` 猜）会校验错模板。
    language,
    usage: assembler.usage,
    diagnostics: streamDiagnostics(),
  };
}

function sampleTextFor(messages) {
  const parts = [];
  for (let i = messages.length - 1; i >= 0 && parts.length < 12; i -= 1) {
    const message = messages[i];
    const content = message?.content;
    if (typeof content === 'string') {
      parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  }
  return parts.join('\n');
}

/**
 * 依次尝试目标链；第一个成功即返回。
 * 全失败时抛一个聚合错误，里面带上每一条的失败原因。
 *
 * @param {object} args
 * @param {object} args.ctx
 * @param {object} args.agent
 * @param {{messages: readonly any[], tools?: readonly any[]}} args.input
 * @param {{targets: readonly any[], source: string}} args.chain
 * @param {{maxTokens:number, timeoutMs:number, language:'auto'|'zh'|'en', previousSummary?:string|null}} args.options
 * @param {AbortSignal} args.signal
 */
export async function summarizeWithChain(args) {
  const { chain } = args;
  if (!Array.isArray(chain.targets) || chain.targets.length === 0) {
    const error = new Error(
      'no provider/model available for summarization: set both summarizationProvider and summarizationModel, ' +
        'route one request on this session, or set both agent provider/model options',
    );
    error.code = 'NO_SUMMARY_TARGET';
    throw error;
  }

  const targets = args.options?.singleTarget === true ? chain.targets.slice(0,1) : chain.targets;
  const primary = targets[0];
  const failures = [];

  const retry=summaryRetryPolicy(args.options);
  const limit=retry.count+1;
  const attempts=targets.map(target=>({target,feedback:null}));
  let lastError;
  for(let index=0;index<attempts.length && index<limit;index++) {
    const {target,feedback}=attempts[index];
    args.signal?.throwIfAborted?.();
    if(index>0)await waitForSummaryRetry(retry.delayMs,index,args.signal);
    const record=beginDiagnosticAttempt(target,{maxTokens:args.options?.maxTokens,timeoutMs:args.options?.timeoutMs,retryCount:retry.count});
    let localFailure=false,nextFeedback=feedback;
    try {
      const result=await summarizeWithTarget({ctx:args.ctx,agent:args.agent,input:args.input,target,signal:args.signal,
        options:{...args.options,primary,repairFeedback:feedback,
          beforeRequest:async meta=>{try{await args.options?.beforeRequest?.(meta);}catch(error){localFailure=true;throw error;}},
          afterRequest:async meta=>{finishDiagnosticAttempt(record,meta);try{await args.options?.afterRequest?.(meta);}catch(error){localFailure=true;throw error;}},
        }});
      // ⚠️ 内容验收必须发生在**目标链内部**，不能等回到调用方再查。
      //
      // 三个摘要目标是按能力排的：主模型写不出合规摘要时，下一个目标（通常
      // 更大或更守规矩）本来还有机会。但校验写在链外时，第一个目标吐出
      // `Done.` 就直接把整次压缩判死 —— 降级链形同虚设，用户看到的是
      // "压缩失败"，而不是"换了个模型成功了"。
      //
      // 校验器由调用方注入（它才知道这次该按中文还是英文的小节标题查）。
      const modelRawText = result.rawText;
      const verdict = typeof args.options?.validate === 'function' ? await args.options.validate(result) : null;
      if (verdict && verdict.ok === false) {
        // Diagnostics are best effort and cannot affect acceptance or timing.
        try { trackAuditDiagnostic(Promise.resolve(args.options?.onRejected?.({result, verdict, modelRawText, attempt:index+1}))).catch(() => {}); } catch {}
        // A deterministic reconstruction is a NEW candidate, never approval
        // of the rejected prose. Validate it from scratch, including shrinkage.
        if (typeof args.options?.reconstruct === 'function') {
          let rejectedResult = result, rejectedVerdict = verdict, rejectedText = modelRawText;
          for (let repair = 0; repair < 8; repair++) {
            const rebuilt = args.options.reconstruct({result: rejectedResult, verdict: rejectedVerdict, modelRawText: rejectedText});
            if (!rebuilt) break;
            const draft = rebuilt.rawText;
            if (draft === rejectedText || Buffer.byteLength(draft,'utf8') - Buffer.byteLength(modelRawText,'utf8') > 8192) break;
            const rebuiltVerdict = await args.options.validate(rebuilt);
            if (rebuiltVerdict?.ok === true) {
              args.signal?.throwIfAborted?.();
              finishDiagnosticAttempt(record,{outcome:'accepted-after-reconstruction',diagnostics:result.diagnostics});
              return rebuilt;
            }
            rejectedResult = rebuilt; rejectedVerdict = rebuiltVerdict; rejectedText = draft;
          }
          if (rejectedResult !== result) try { trackAuditDiagnostic(Promise.resolve(args.options?.onRejected?.({result:rejectedResult, verdict:rejectedVerdict, modelRawText, attempt:'reconstruction'}))).catch(() => {}); } catch {}
        }
        if (CONTENT_RETRY_CODES.has(verdict.code)) nextFeedback={code:verdict.code,message:verdict.message,issues:verdict.audit?.lost??[]};
        const invalid = new Error(verdict.message ?? 'the summary did not pass content validation');
        invalid.code = verdict.code ?? 'SUMMARY_INVALID';
        throw invalid;
      }
      args.signal?.throwIfAborted?.();
      finishDiagnosticAttempt(record,{outcome:'accepted',diagnostics:result.diagnostics});
      return result;
    } catch(error) {
      finishDiagnosticAttempt(record,{outcome:'failed',error});
      if(args.signal?.aborted || localFailure || error?.code==='CONTINUATION_CALL_BUDGET')throw error;
      lastError=error;
      if(error?.code==='SUMMARY_TIMEOUT') {
        error.timeoutMs??=args.options?.timeoutMs;error.target??=`${target.provider}/${target.model}`;
      }
      observeSummaryOverflow(args.options?.capacity,target,error);
      failures.push({target:`${target.provider}/${target.model}`,code:error?.code??'ERROR',message:error?.message??String(error)});
      const retryable=retryableSummaryError(error);
      // A changed-input window repair remains the caller's responsibility.
      // Storage/cancellation/budget errors never enter this network retry loop.
      if(retryable) {
        if(!nextFeedback && CONTENT_RETRY_CODES.has(error?.code))nextFeedback={code:error.code,message:error.message,issues:[]};
        attempts.push({target,feedback:nextFeedback});
      } else if(!isWindowError(error) && error?.code!=='UNSUPPORTED_CONTENT')break;
    }
  }
  if(lastError?.code==='SUMMARY_TIMEOUT') {
    lastError.failures=failures;lastError.failureCodes=failures.map(f=>f.code);lastError.recoverable=false;
    lastError.summaryAttempts=failures.length;lastError.summaryAttemptLimit=limit;lastError.summaryRetryExhausted=true;
    throw lastError;
  }

  // 如果**每一个**目标都是因为内容不合规而失败，那就不该报"所有目标都失败了"。
  // 这两件事对用户和对上层的含义完全不同：
  // - "所有目标都失败" → 像是网络/额度问题，值得重试；
  // - "没有一个目标写出合规摘要" → 是提示词/模型能力问题，重试同样的东西没用，
  //   应该保留原上下文并让用户知道是内容不合格。
  const onlyStructure = failures.length > 0 && failures.every((f) => STRUCTURE_CODES.has(f.code));
  const error = new Error(
    onlyStructure
      ? `no summarization target produced an acceptable summary: ${failures.map((f) => `${f.target} → ${f.code}: ${f.message}`).join(' | ')}`
      : `all summarization targets failed: ${failures.map((f) => `${f.target} → ${f.code}: ${f.message}`).join(' | ')}`,
  );
  const contentCodes = new Set(['PROGRESS_FACT_CONFLICT', 'SUMMARY_NOT_SMALLER', 'CONSTRAINT_LOST', 'CONSTRAINT_POLARITY_LOST', 'AUDIT_UNAVAILABLE']);
  const commonCode = failures[0]?.code;
  error.code = commonCode && contentCodes.has(commonCode) && failures.every(f => f.code === commonCode) ? commonCode : onlyStructure ? 'SUMMARY_STRUCTURE_INVALID' : 'SUMMARY_ALL_FAILED';
  error.failures = failures;
  error.cause = lastError;
  error.summaryAttempts = failures.length;
  error.summaryAttemptLimit = limit;
  error.summaryRetryExhausted = failures.length >= limit && retryableSummaryError(lastError);
  // ⚠️ 聚合之后必须把"是否值得少压一点再试"这个信息**带出来**。
  // 否则调用方只看到一个笼统的 SUMMARY_ALL_FAILED，只能整体放弃 —— 那正是
  // "渐进收敛写了却永远不可达"的原因：真正能靠缩小跨度救回来的窗口溢出，
  // 被聚合错误抹平成了不可恢复失败。
  error.recoverable = !error.summaryRetryExhausted && failures.some(
    (f) =>
      f.code === 'MAX_TOKENS' ||
      f.code === 'UNSUPPORTED_CONTENT' ||
      // ⚠️ 必须查 code。适配器把窗口溢出报成 `CONTEXT_WINDOW_EXCEEDED` 时，
      // message 往往是"request failed"这种不含关键词的通用文案，只看 message
      // 会把最该重试的一类失败判成不可恢复。
      f.code === 'CONTEXT_WINDOW_EXCEEDED' ||
      isWindowMessage(f.message),
  );
  error.failureCodes = failures.map((f) => f.code);
  throw error;
}

const WINDOW_ERROR_RE = /context length|context window|too long|maximum context|CONTEXT_WINDOW_EXCEEDED/i;

// 内容不合规（不是"请求失败"）。这类失败换一个目标模型值得再试一次：
// 同一条提示词，一个模型只回 `Done.`，另一个可能老老实实写满九节。
const STRUCTURE_CODES = new Set([
  'CONTINUATION_STRUCTURE',
  'CONTINUATION_TOOL_OUTPUT',
  'CONTINUATION_TOO_LARGE',
  'SUMMARY_STRUCTURE_INVALID',
  'CHECKPOINT_COVERAGE_INCOMPLETE',
  'EMPTY_SUMMARY',
  'CONSTRAINT_POLARITY_LOST',
]);

function isWindowMessage(message) {
  return typeof message === 'string' && WINDOW_ERROR_RE.test(message);
}

function isWindowError(error) {
  if (isWindowMessage(error?.message)) return true;
  if (error?.code === 'CONTEXT_WINDOW_EXCEEDED') return true;
  // 有些适配器把上游原文塞进 cause 链，往下找两层。
  let cause = error?.cause;
  for (let depth = 0; depth < 3 && cause; depth += 1) {
    if (isWindowMessage(cause.message)) return true;
    if (cause.code === 'CONTEXT_WINDOW_EXCEEDED') return true;
    cause = cause.cause;
  }
  return false;
}
