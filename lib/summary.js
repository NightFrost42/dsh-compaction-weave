import {summaryRetryPolicy,retryableSummaryError as baseRetryableSummaryError,waitForSummaryRetry,CONTENT_RETRY_CODES as BASE_CONTENT_RETRY_CODES} from './summary-retry.js';
import { isBiliProxyPreflightError, isWindowOverflowError } from './bili-conflict.js';
import { isImageOffloadRequiredError, isUpstreamMultimodal400Error } from './image-budget.js';
const CONTENT_RETRY_CODES=new Set([...BASE_CONTENT_RETRY_CODES,'SUMMARY_FOREIGN_BILI_FORMAT']);
const retryableSummaryError=error=>!isBiliProxyPreflightError(error)&&(error?.code==='SUMMARY_FOREIGN_BILI_FORMAT'||baseRetryableSummaryError(error));
import {beginDiagnosticAttempt,finishDiagnosticAttempt,noteDiagnosticAuditFallback,trackAuditDiagnostic} from './failure-diagnostics.js';
import { diagnoseHeuristicFallbackVerdict, MAX_AUDIT_FALLBACK_CONFLICTS } from './audit-fallback.js';
import { combineSignals } from './abort.js';
import { buildFittedSummaryRequest, assertSummaryCapacity, observeSummaryOverflow } from './summary-budget.js';
import { REASONING_EFFORT_LADDER } from './config.js';
import { traceStagePoint } from './stage-trace.js';
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
import { unwrapJsonSectionMap } from './validate.js';

export { REASONING_EFFORT_LADDER };

const COMPACTION_PURPOSE = 'compaction';
const DEFAULT_PROGRESS_THROTTLE_MS = 500;

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
  // Prefer the agent's live declared route over stale session requestHeader()
  // so model switches take effect immediately while merging same-route controls.
  push(declared ? { ...declared, ...reusableControls(declared, durable) } : undefined, 'agent');
  push(durable, 'session');

  return { targets, source: targets[0]?.source ?? 'none' };
}

const LOW_OR_LOWER_EFFORTS = new Set(['low', 'minimal', 'none']);
const DIRECT_REASONING_EFFORTS = new Set(['low', 'minimal', 'medium', 'high', 'xhigh', 'max']);
const UNSUPPORTED_REASONING_EFFORT_RE =
  /UNSUPPORTED_REASONING_EFFORT|does not support reasoning effort|unsupported[_ -]?reasoning[_ -]?effort|invalid[_ -]?reasoning[_ -]?effort/i;

const rejectedEffortByLlmWeak = new WeakMap();
const rejectedEffortByLlmMap = new Map();
const MAX_CACHED_EFFORT_ROUTES = 128;

function rejectedEffortRoutesFor(llm) {
  const isObj = llm !== null && (typeof llm === 'object' || typeof llm === 'function');
  const store = isObj ? rejectedEffortByLlmWeak : rejectedEffortByLlmMap;
  if (!isObj && !store.has(llm) && store.size >= MAX_CACHED_EFFORT_ROUTES) {
    store.delete(store.keys().next().value);
  }
  let routes = store.get(llm);
  if (!routes) {
    routes = new Map();
    store.set(llm, routes);
  }
  return routes;
}

function getRejectedEfforts(llm, routeKey) {
  if (!llm || !routeKey) return null;
  return rejectedEffortRoutesFor(llm).get(routeKey) ?? null;
}

function rememberRejectedEffort(llm, routeKey, effort) {
  if (!llm || !routeKey || typeof effort !== 'string') return;
  const normalized = effort.trim().toLowerCase();
  if (!normalized) return;
  const routes = rejectedEffortRoutesFor(llm);
  let set = routes.get(routeKey);
  if (!set) {
    if (routes.size >= MAX_CACHED_EFFORT_ROUTES) {
      routes.delete(routes.keys().next().value);
    }
    set = new Set();
    routes.set(routeKey, set);
  } else {
    routes.delete(routeKey);
    routes.set(routeKey, set);
  }
  set.add(normalized);
}

/**
 * Detect whether an error (or anything in its `.cause` chain, depth <= 6)
 * signals that the provider/model rejected the requested `reasoningEffort`.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isUnsupportedReasoningEffortError(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth <= 6 && !seen.has(current); depth += 1) {
    if (typeof current === 'object' || typeof current === 'function') {
      seen.add(current);
      if (current.code === 'UNSUPPORTED_REASONING_EFFORT') return true;
      if (typeof current.message === 'string' && UNSUPPORTED_REASONING_EFFORT_RE.test(current.message)) {
        return true;
      }
      current = current.cause;
    } else if (typeof current === 'string') {
      return UNSUPPORTED_REASONING_EFFORT_RE.test(current);
    } else {
      break;
    }
  }
  return false;
}

/**
 * Build the strict downward `reasoningEffort` fallback sequence after `requestedEffort`,
 * always ending with `undefined` (omit the parameter).
 *
 * @param {unknown} requestedEffort
 * @param {{ supportedEfforts?: readonly unknown[] }} [options]
 * @returns {(string|undefined)[]}
 */
export function buildReasoningEffortFallbackChain(requestedEffort, { supportedEfforts } = {}) {
  let rawChain;
  if (typeof requestedEffort === 'string' && requestedEffort.trim().length > 0) {
    const normalized = requestedEffort.trim().toLowerCase();
    const idx = REASONING_EFFORT_LADDER.indexOf(normalized);
    rawChain = idx >= 0 ? [...REASONING_EFFORT_LADDER.slice(idx + 1), undefined] : ['low', 'minimal', 'none', undefined];
  } else {
    rawChain = [undefined];
  }

  if (Array.isArray(supportedEfforts)) {
    if (supportedEfforts.length === 0) return [undefined];
    const allowed = new Set(
      supportedEfforts
        .map((entry) =>
          typeof entry === 'string'
            ? entry.trim().toLowerCase()
            : typeof entry?.id === 'string'
              ? entry.id.trim().toLowerCase()
              : '',
        )
        .filter(Boolean),
    );
    if (allowed.size === 0) return [undefined];
    const filtered = [];
    const seen = new Set();
    for (const candidate of rawChain) {
      if (candidate === undefined) continue;
      if (allowed.has(candidate) && !seen.has(candidate)) {
        seen.add(candidate);
        filtered.push(candidate);
      }
    }
    filtered.push(undefined);
    return filtered;
  }

  return rawChain;
}

/**
 * Resolve the effective `reasoningEffort` for a same-route summary request.
 * Defaults to `'low'` to avoid burning slow high/xhigh reasoning tokens during compaction.
 *
 * @param {unknown} effort
 * @param {'low'|'none'|'inherit'|'minimal'|'medium'|'high'|'xhigh'|'max'} [policy='low']
 */
export function resolveReasoningEffort(effort, policy = 'low') {
  if (policy === 'none') return undefined;
  if (policy === 'inherit') return effort === null ? undefined : effort;
  if (policy === 'low') {
    if (typeof effort === 'string' && LOW_OR_LOWER_EFFORTS.has(effort.trim().toLowerCase())) {
      return effort;
    }
    return 'low';
  }
  if (DIRECT_REASONING_EFFORTS.has(policy)) return policy;
  if (effort === undefined || effort === null) return undefined;
  if (typeof effort === 'string' && LOW_OR_LOWER_EFFORTS.has(effort.trim().toLowerCase())) {
    return effort;
  }
  return 'low';
}

/**
 * 只在同一个 provider/model 上复用采样参数——跨路由复用会话 reasoningEffort 会把
 * 一个不支持的档位塞给另一个模型，直接 400；直接指定的档位（含默认 `'low'`）
 * 会跨路由下发，若目标模型不支持则由 `summarizeWithTarget` 自动降级并按路由缓存。
 */
function reusableControls(target, primary, reasoningEffortPolicy) {
  const sameRoute = Boolean(primary && target.provider === primary.provider && target.model === primary.model);
  if (!sameRoute) {
    return DIRECT_REASONING_EFFORTS.has(reasoningEffortPolicy)
      ? { reasoningEffort: reasoningEffortPolicy }
      : {};
  }
  const out = {};
  if (reasoningEffortPolicy === undefined) {
    if (primary.reasoningEffort !== undefined) out.reasoningEffort = primary.reasoningEffort;
  } else {
    const effort = resolveReasoningEffort(primary.reasoningEffort, reasoningEffortPolicy);
    if (effort !== undefined) out.reasoningEffort = effort;
  }
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

  const request = buildFittedSummaryRequest(input, options, options.capacity, target);
  assertSummaryCapacity(request, options.capacity, target);
  const { messages, language } = request;

  const reasoningEffortPolicy = options?.reasoningEffortPolicy ?? options?.summaryReasoningEffort;
  const llmOptions = {
    provider: target.provider,
    model: target.model,
    messages,
    maxTokens: options.maxTokens,
    purpose: COMPACTION_PURPOSE,
    ...(typeof agent?.session?.id === 'string' ? { sessionId: agent.session.id } : {}),
    ...reusableControls(target, options.primary, reasoningEffortPolicy),
    ...(!options.isolatedTranscript && typeof agent?.session?.toolHistory === 'function' ? { toolHistory: agent.session.toolHistory() } : {}),
    ...(Array.isArray(input.tools) && input.tools.length > 0 ? { tools: [...input.tools] } : {}),
  };

  let supportedEfforts;
  if (llmOptions.reasoningEffort !== undefined && typeof ctx?.llm?.resolveModelInfo === 'function') {
    signal?.throwIfAborted?.();
    let info;
    try {
      info = await ctx.llm.resolveModelInfo(target.provider, target.model, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    signal?.throwIfAborted?.();
    if (info && typeof info === 'object') {
      const explicitlyLacksReasoning =
        (Object.hasOwn(info, 'reasoning') && (info.reasoning == null || info.reasoning === false)) ||
        (typeof info.id === 'string' &&
          info.id.length > 0 &&
          typeof info.provider === 'string' &&
          info.provider.length > 0 &&
          info.reasoning === undefined);
      if (explicitlyLacksReasoning) {
        delete llmOptions.reasoningEffort;
      } else if (Array.isArray(info?.reasoning?.efforts)) {
        supportedEfforts = info.reasoning.efforts
          .map((entry) =>
            typeof entry === 'string'
              ? entry.trim().toLowerCase()
              : typeof entry?.id === 'string'
                ? entry.id.trim().toLowerCase()
                : '',
          )
          .filter(Boolean);
        const normalizedCurrent =
          typeof llmOptions.reasoningEffort === 'string'
            ? llmOptions.reasoningEffort.trim().toLowerCase()
            : '';
        if (!normalizedCurrent || !supportedEfforts.includes(normalizedCurrent)) {
          const next = buildReasoningEffortFallbackChain(llmOptions.reasoningEffort, { supportedEfforts })[0];
          if (next === undefined) delete llmOptions.reasoningEffort;
          else llmOptions.reasoningEffort = next;
        }
      }
    }
  }

  const routeKey = target?.provider && target?.model ? `${target.provider}/${target.model}` : null;
  const rejectedEfforts = getRejectedEfforts(ctx?.llm, routeKey);
  let candidateEfforts;
  if (llmOptions.reasoningEffort === undefined) {
    candidateEfforts = [undefined];
  } else {
    const initial = llmOptions.reasoningEffort;
    const rawCandidates = [
      initial,
      ...buildReasoningEffortFallbackChain(initial, supportedEfforts ? { supportedEfforts } : undefined),
    ];
    const deduped = [];
    const seen = new Set();
    for (const candidate of rawCandidates) {
      if (candidate === undefined) continue;
      const normalized = typeof candidate === 'string' ? candidate.trim().toLowerCase() : candidate;
      if (rejectedEfforts && rejectedEfforts.has(normalized)) continue;
      if (!seen.has(normalized)) {
        seen.add(normalized);
        deduped.push(candidate);
      }
    }
    deduped.push(undefined);
    candidateEfforts = deduped;
  }

  const timeoutMs = Math.max(5000, options.timeoutMs);
  let assembler = new SummaryAssembler();
  let progress = new SummaryProgress();
  const onProgress = typeof options?.onProgress === 'function' ? options.onProgress : null;
  const progressThrottleMs =
    Number.isFinite(options?.progressThrottleMs) && options.progressThrottleMs >= 0
      ? Math.min(options.progressThrottleMs, DEFAULT_PROGRESS_THROTTLE_MS)
      : DEFAULT_PROGRESS_THROTTLE_MS;
  const modelLabel = target?.provider && target?.model ? `${target.provider}/${target.model}` : String(target?.model ?? '');
  const attemptNumber = Number.isSafeInteger(options?.attempt) && options.attempt > 0 ? options.attempt : 1;
  const maxAttemptsNumber =
    Number.isSafeInteger(options?.maxAttempts) && options.maxAttempts > 0 ? options.maxAttempts : attemptNumber;
  let lastProgressEmitMs = -Infinity;
  let emittedFirstChunk = false;
  const emitProgress = (force = false) => {
    if (!onProgress) return;
    const snap = progress.snapshot();
    const isFirstChunk = !emittedFirstChunk && snap.firstChunkMs !== null;
    if (!force && !isFirstChunk && snap.elapsedMs - lastProgressEmitMs < progressThrottleMs) return;
    if (snap.firstChunkMs !== null) emittedFirstChunk = true;
    lastProgressEmitMs = snap.elapsedMs;
    try {
      // Strictly metadata only — never expose draft/reasoning/prompt text.
      onProgress({
        chunks: assembler.chunkCount,
        textChars: assembler.text.length,
        reasoningChars: assembler.reasoningChars,
        firstChunkMs: snap.firstChunkMs,
        idleMs: snap.idleMs,
        model: modelLabel,
        attempt: attemptNumber,
        maxAttempts: maxAttemptsNumber,
      });
    } catch {
      /* best-effort telemetry must never interrupt summarization */
    }
  };
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
  const deadlineStartMs = performance.now();
  const timeoutController = new AbortController();
  const timeoutSignal = timeoutController.signal;
  const combinedSignals = combineSignals([signal, timeoutSignal]);
  const combined = combinedSignals.signal;
  llmOptions.signal = combined;
  const checkDeadline = () => {
    // Synchronous persistence/adapter work and hot microtasks can defer the
    // timer. Check the same monotonic deadline before dispatch or another read,
    // not only after a response arrives. Caller cancellation keeps its reason.
    if (performance.now() - deadlineStartMs >= timeoutMs && !signal?.aborted && !timeoutSignal.aborted) {
      timeoutController.abort(timeoutError());
    }
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
  let completed = false;
  let requestStarted = false;
  let streamFailure;
  try {
    traceStagePoint('beforeRequest', {
      bytes: request.inputUnits,
      attempt: options.attempt ?? 1,
      ...(Number.isInteger(options.maxTokens) ? { limit: options.maxTokens } : {}),
    });
    await options.beforeRequest?.({target,maxTokens:options.maxTokens,requestBytes:request.inputUnits});
    checkDeadline();
    // Invocation can dispatch immediately or throw after dispatch. From this
    // point on, missing usage is unknown, never proof that nothing was sent.
    requestStarted = true;
    for (let stepIdx = 0; stepIdx < candidateEfforts.length; stepIdx += 1) {
      const effort = candidateEfforts[stepIdx];
      const stepOptions = { ...llmOptions };
      if (effort === undefined) delete stepOptions.reasoningEffort;
      else stepOptions.reasoningEffort = effort;

      assembler = new SummaryAssembler();
      progress = new SummaryProgress();
      lastProgressEmitMs = -Infinity;
      emittedFirstChunk = false;
      completed = false;
      streamFailure = undefined;

      let iterator;
      let streamDone = false;
      try {
        checkDeadline();
        emitProgress(true);
        iterator = ctx.llm.stream(stepOptions)[Symbol.asyncIterator]();
        for (;;) {
          checkDeadline();
          const step = await Promise.race([iterator.next(), abortPromise]);
          checkDeadline();
          if (step.done) {
            streamDone = true;
            break;
          }
          progress.observe(assembler.push(step.value));
          emitProgress(false);
        }
        // 迟到结果拒收：走到这里说明流跑完了，但可能是在超时之后才跑完的。
        if (timeoutSignal.aborted && !signal?.aborted) {
          throw timeoutError();
        }
        if (signal?.aborted) {
          throw Object.assign(new Error('summarization was cancelled'), { code: 'ABORTED', cause: signal.reason });
        }
        assembler.throwIfFailed();
        completed = true;
        emitProgress(true);
        break;
      } catch (error) {
        if (!streamDone && iterator && typeof iterator.return === 'function') {
          // 抢回控制权之后主动收尾：不 await（底层可能永远不结束），只求把
          // 取消信号传下去，别让请求挂在后台继续烧额度。
          try {
            Promise.resolve(iterator.return()).catch(() => {});
          } catch {
            /* 迭代器已经死了 */
          }
        }
        if (
          isUnsupportedReasoningEffortError(error) &&
          effort !== undefined &&
          stepIdx + 1 < candidateEfforts.length &&
          !signal?.aborted &&
          !timeoutSignal.aborted
        ) {
          rememberRejectedEffort(ctx?.llm, routeKey, effort);
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    streamFailure = error;
    if (error?.code === 'SUMMARY_TIMEOUT' || (timeoutSignal.aborted && !signal?.aborted)) {
      throw error?.code === 'SUMMARY_TIMEOUT' ? error : timeoutError(error);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) combined?.removeEventListener?.('abort', onAbort);
    combinedSignals.dispose();
    const failedFinish=['error','aborted'].includes(assembler.finish?.kind);
    // Adapters can synthesize zero usage for a terminal service error. That
    // cannot establish zero spend after dispatch; preserve positive reported
    // usage, but account an all-zero failed attempt as unknown.
    const unknownFailureUsage=(streamFailure||failedFinish)&&assembler.usage&&Object.values(assembler.usage).every(value=>value===0);
    await options.afterRequest?.({target,usage:unknownFailureUsage?null:assembler.usage??null,completed,requestStarted,diagnostics:streamDiagnostics(),errorCode:timeoutSignal.aborted?'SUMMARY_TIMEOUT':streamFailure?.code??assembler.finish?.failure?.code??(streamFailure||failedFinish?'ERROR':null)});
  }

  const rawText = unwrapJsonSectionMap(assembler.text, { language });
  const summary = rawText !== assembler.text ? [{ type: 'text', text: rawText }] : summaryText(assembler.blocks());
  return {
    summary,
    rawText,
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
  const attemptedTargets = new Set();
  let correctiveRetriesRan = 0;
  const fallbackCandidates = [];
  const fallbackRejectedCandidates = [];
  const fallbackEligibilityOpts =
    args.options?.auditFallbackEligibility ??
    args.options?.onExhaustionFallback?.eligibilityOpts ??
    {};
  let sawForeignBili = false;
  let lastError;
  for(let index=0;index<attempts.length && index<limit;index++) {
    const {target,feedback}=attempts[index];
    args.signal?.throwIfAborted?.();
    attemptedTargets.add(`${target.provider}/${target.model}`);
    if (feedback) correctiveRetriesRan += 1;
    const retryDelayMs=index>0?await waitForSummaryRetry(retry.delayMs,index,args.signal):0;
    const record=beginDiagnosticAttempt(target,{maxTokens:args.options?.maxTokens,timeoutMs:args.options?.timeoutMs,retryCount:retry.count,retryDelayMs});
    let localFailure=false,nextFeedback=feedback;
    try {
      const result=await summarizeWithTarget({ctx:args.ctx,agent:args.agent,input:args.input,target,signal:args.signal,
        options:{...args.options,primary,repairFeedback:feedback,attempt:index+1,maxAttempts:limit,
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
        if (verdict.code === 'SUMMARY_FOREIGN_BILI_FORMAT') sawForeignBili = true;
        let finalRejectedResult = result;
        let finalRejectedVerdict = verdict;
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
          finalRejectedResult = rejectedResult;
          finalRejectedVerdict = rejectedVerdict;
          if (rejectedResult !== result) try { trackAuditDiagnostic(Promise.resolve(args.options?.onRejected?.({result:rejectedResult, verdict:rejectedVerdict, modelRawText, attempt:'reconstruction'}))).catch(() => {}); } catch {}
        }
        if (typeof args.options?.onExhaustionFallback === 'function' && finalRejectedVerdict) {
          const diag = diagnoseHeuristicFallbackVerdict(finalRejectedVerdict, fallbackEligibilityOpts);
          if (!sawForeignBili && diag.eligible) {
            fallbackCandidates.push({
              result: finalRejectedResult,
              verdict: finalRejectedVerdict,
              modelRawText,
              blockingCount: diag.blockingCount,
              totalLost: diag.totalLost,
              attemptIndex: index,
            });
          } else {
            fallbackRejectedCandidates.push({
              skippedReason: sawForeignBili ? 'foreign_format' : diag.skippedReason,
              blockingCount: diag.blockingCount,
              maxConflicts: diag.maxConflicts,
              attemptIndex: index,
            });
          }
        }
        if (CONTENT_RETRY_CODES.has(verdict.code)) nextFeedback={code:verdict.code,message:verdict.message,issues:verdict.audit?.lost??[],...(verdict.foreignBiliFormat?{foreignBiliFormat:verdict.foreignBiliFormat}:{})};
        const invalid = new Error(verdict.message ?? 'the summary did not pass content validation');
        invalid.code = verdict.code ?? 'SUMMARY_INVALID';
        if (verdict.constraintSeq !== undefined) invalid.constraintSeq = verdict.constraintSeq;
        if (verdict.constraintSourceKind !== undefined) invalid.constraintSourceKind = verdict.constraintSourceKind;
        if (verdict.constraintReason !== undefined) invalid.constraintReason = verdict.constraintReason;
        if (verdict.provenanceLine !== undefined) invalid.provenanceLine = verdict.provenanceLine;
        if (verdict.provenanceKind !== undefined) invalid.provenanceKind = verdict.provenanceKind;
        throw invalid;
      }
      args.signal?.throwIfAborted?.();
      finishDiagnosticAttempt(record,{outcome:'accepted',diagnostics:result.diagnostics});
      return result;
    } catch(error) {
      if (error?.code === 'SUMMARY_FOREIGN_BILI_FORMAT' || isBiliProxyPreflightError(error)) {
        sawForeignBili = true;
      }
      if (isBiliProxyPreflightError(error) && error && typeof error === 'object' && error.code !== 'BILI_PROXY_CONFLICT') {
        try {
          if (!error.code || error.code === 'CONTEXT_WINDOW_EXCEEDED') error.code = 'BILI_PROXY_CONFLICT';
          error.failureCode = 'BILI_PROXY_CONFLICT';
        } catch { /* frozen */ }
      }
      finishDiagnosticAttempt(record,{outcome:'failed',error});
      try { args.options?.onAttemptError?.(error, { target, attempt: index + 1 }); } catch {}
      if(args.signal?.aborted || localFailure || error?.code==='CONTINUATION_CALL_BUDGET')throw error;
      lastError=error;
      if(isBiliProxyPreflightError(error)) {
        if (!error.failures) error.failures=[{target:`${target.provider}/${target.model}`,code:'BILI_PROXY_CONFLICT',message:error?.message??String(error)}];
        error.failureCodes ??= ['BILI_PROXY_CONFLICT'];
        error.recoverable = false;
        error.code = 'BILI_PROXY_CONFLICT';
        throw error;
      }
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
  if (
    typeof args.options?.onExhaustionFallback === 'function' &&
    !args.signal?.aborted &&
    retry.count >= 1 &&
    correctiveRetriesRan >= 1 &&
    attemptedTargets.size >= targets.length
  ) {
    const emitFallbackSkipped = (meta) => {
      const skipMeta = {
        used: false,
        skippedReason: meta?.skippedReason ?? 'ineligible_verdict',
        blockingCount: Number.isSafeInteger(meta?.blockingCount) && meta.blockingCount >= 0 ? meta.blockingCount : 0,
        maxConflicts:
          Number.isSafeInteger(meta?.maxConflicts) && meta.maxConflicts > 0
            ? meta.maxConflicts
            : MAX_AUDIT_FALLBACK_CONFLICTS,
      };
      try { noteDiagnosticAuditFallback(skipMeta); } catch {}
      try { args.options.onExhaustionFallback.onSkipped?.(skipMeta); } catch {}
    };

    if (sawForeignBili) {
      emitFallbackSkipped({
        skippedReason: 'foreign_format',
        blockingCount: 0,
        maxConflicts: MAX_AUDIT_FALLBACK_CONFLICTS,
      });
    } else {
      fallbackCandidates.sort(
        (a, b) => a.blockingCount - b.blockingCount || a.totalLost - b.totalLost || b.attemptIndex - a.attemptIndex,
      );
      let primarySkip = null;
      for (const candidate of fallbackCandidates) {
        let candidateSkip = null;
        const fallbackResult = await args.options.onExhaustionFallback({
          ...candidate,
          recordSkip: (info) => {
            if (info && typeof info === 'object') candidateSkip = info;
          },
        });
        if (fallbackResult) {
          try { noteDiagnosticAuditFallback(fallbackResult.auditFallback); } catch {}
          return fallbackResult;
        }
        if (!primarySkip) {
          primarySkip = candidateSkip ?? {
            skippedReason: 'ineligible_verdict',
            blockingCount: candidate.blockingCount,
            maxConflicts: MAX_AUDIT_FALLBACK_CONFLICTS,
          };
        }
      }
      if (primarySkip || fallbackRejectedCandidates.length > 0) {
        let chosen = primarySkip;
        if (!chosen) {
          const exceeds = fallbackRejectedCandidates
            .filter((c) => c.skippedReason === 'exceeds_max_conflicts')
            .sort((a, b) => a.blockingCount - b.blockingCount || b.attemptIndex - a.attemptIndex);
          if (exceeds.length > 0) {
            chosen = exceeds[0];
          } else {
            const hardProv = fallbackRejectedCandidates.filter((c) => c.skippedReason === 'hard_provenance');
            const hardPol = fallbackRejectedCandidates.filter((c) => c.skippedReason === 'hard_polarity');
            chosen =
              hardProv.length > 0
                ? hardProv.at(-1)
                : hardPol.length > 0
                  ? hardPol.at(-1)
                  : fallbackRejectedCandidates.at(-1);
          }
        }
        emitFallbackSkipped(chosen);
      }
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
  const contentCodes = new Set(['PROGRESS_FACT_CONFLICT', 'SUMMARY_NOT_SMALLER', 'CONSTRAINT_LOST', 'CONSTRAINT_POLARITY_LOST', 'AUDIT_UNAVAILABLE', 'SUMMARY_FOREIGN_BILI_FORMAT']);
  const commonCode = failures[0]?.code;
  error.code = commonCode && contentCodes.has(commonCode) && failures.every(f => f.code === commonCode) ? commonCode : onlyStructure ? 'SUMMARY_STRUCTURE_INVALID' : 'SUMMARY_ALL_FAILED';
  error.failures = failures;
  error.cause = lastError;
  if (lastError?.constraintSeq !== undefined) error.constraintSeq = lastError.constraintSeq;
  if (lastError?.constraintSourceKind !== undefined) error.constraintSourceKind = lastError.constraintSourceKind;
  if (lastError?.constraintReason !== undefined) error.constraintReason = lastError.constraintReason;
  if (lastError?.provenanceLine !== undefined) error.provenanceLine = lastError.provenanceLine;
  if (lastError?.provenanceKind !== undefined) error.provenanceKind = lastError.provenanceKind;
  error.summaryAttempts = failures.length;
  error.summaryAttemptLimit = limit;
  error.summaryRetryExhausted = failures.length >= limit && retryableSummaryError(lastError);
  // ⚠️ 聚合之后必须把"是否值得少压一点再试"这个信息**带出来**。
  // 否则调用方只看到一个笼统的 SUMMARY_ALL_FAILED，只能整体放弃 —— 那正是
  // "渐进收敛写了却永远不可达"的原因：真正能靠缩小跨度救回来的窗口溢出，
  // 被聚合错误抹平成了不可恢复失败。
  error.recoverable =
    !isBiliProxyPreflightError(lastError) &&
    !error.summaryRetryExhausted &&
    (isImageOffloadRequiredError(lastError) ||
      isUpstreamMultimodal400Error(lastError) ||
      failures.some(
        (f) =>
          f.code === 'MAX_TOKENS' ||
          f.code === 'UNSUPPORTED_CONTENT' ||
          f.code === 'IMAGE_OFFLOAD_REQUIRED' ||
          isWindowError(f),
      ));
  error.failureCodes = failures.map((f) => f.code);
  throw error;
}

// 内容不合规（不是"请求失败"）。这类失败换一个目标模型值得再试一次：
// 同一条提示词，一个模型只回 `Done.`，另一个可能老老实实写满九节。
const STRUCTURE_CODES = new Set([
  'CONTINUATION_STRUCTURE',
  'CONTINUATION_TOOL_OUTPUT',
  'CONTINUATION_TOO_LARGE',
  'SUMMARY_STRUCTURE_INVALID',
  'SUMMARY_FOREIGN_BILI_FORMAT',
  'CHECKPOINT_COVERAGE_INCOMPLETE',
  'EMPTY_SUMMARY',
  'CONSTRAINT_POLARITY_LOST',
]);

function isWindowError(error) {
  return isWindowOverflowError(error);
}
