import {diagnosticText,failureExplanation} from './failure-diagnostics.js';
// 引擎的 cordis 插件入口。
//
// `lib/index.js` 的 `internal/config` 钩子会把配置树里
// `name === '@deepseek-ai/dsh-compaction-basic'` 的行改写成
// `name === 'dsh-compaction-weave/engine'`，于是 DSH 在那个 realm（宿主平面或
// 某个 agent preset 的 isolate 组）里加载的就是本文件 —— 每个 realm 一个引擎
// 实例，正好对应官方"one implementation per context"的约定。
//
// 这里只做四件事：解析配置、造引擎、注册回查工具、把清理函数交回去。
//
// ⚠️ 关于 `inject`：cordis 的 ctx 是**受控代理**，没有声明注入的服务，
// 读属性本身就会抛 `cannot get property "X" without inject`
// （`cordis/src/reflect.ts:144`），`ctx.tools?.register` 里的可选链**拦不住**。
// 而且这个异常发生在 apply 顶层，会让整个引擎 fiber 加载失败、已注册的
// compaction 服务随失败一起清理，最终把 preset 的 mount 审计也拖挂。
// 所以：`tools` 必须走独立的 `ctx.inject(['tools'], ...)` 子 fiber，
// 让它"晚到就等、缺席就不装工具"，而不是让主入口依赖它。

import { WeaveCompactionEngine } from './engine.js';
import { resolveConfig } from './config.js';
import { registerHistoryTools } from './tools.js';
import {registerCompactionTool} from './proactive.js';
import { withCommandHeartbeat } from './command-heartbeat.js';

export const name = 'compaction-weave-engine';

/**
 * 引擎本体的依赖。
 *
 * `llm` 与 `tokenMeter` 是压缩的必需品；`sessions` 用于手动与自动提交及恢复时等待持久化
 * 边界（`flush`），但**必须在这里声明**：cordis 的 ctx 是受控代理，未声明注入的
 * 服务，读属性本身就抛 `cannot get property "X" without inject`
 * （`cordis/src/reflect.ts:144`），`this.ctx.sessions?.flush` 里的可选链拦不住 ——
 * 它拦的是 `flush` 为 null，不是 `sessions` 这个属性读取被拒。
 * 官方引擎同样注入这三项（`dsh-compaction-basic/lib/index.js:801-805`）。
 */
export const inject = ['llm', 'tokenMeter', 'sessions'];

export function apply(ctx, rawConfig = {}) {
  const { config, unknown, migrations = [] } = resolveConfig(rawConfig ?? {});
  for (const message of migrations) ctx.logger?.warn?.(`[compaction-weave] config migration: ${message}`);
  if (unknown.length > 0) {
    ctx.logger?.warn?.(`[compaction-weave] ignoring unknown config key(s): ${unknown.join(', ')}`);
  }

  const engine = new WeaveCompactionEngine(ctx, config);
  engine.requireTransactionAdapter = true;
  ctx.inject?.(['compactionWeaveTransactions'], transactionCtx => {
    engine.transactionAdapter = transactionCtx.compactionWeaveTransactions;
    engine.transactionAdapter.register(engine.journal, engine.sessionState, config.failureThreshold);
    return () => { engine.transactionAdapter = undefined; };
  });


  // Only the declared child fiber reads the optional host attachment service.
  if (typeof ctx.inject === 'function') ctx.inject(['attachments'], (attachmentCtx) => {
    const provider = attachmentCtx.attachments;
    engine.archive.attachments = provider;
    return () => { if (engine.archive.attachments === provider) engine.archive.attachments = undefined; };
  });

  // 回查工具是可选能力：单独开一个带 `tools` 注入的子 fiber。
  // 这样 tools 平面缺席时只是少三个工具，不会把压缩引擎一起带走。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], (toolsCtx) => {
        engine.historyToolsAvailable = registerHistoryTools(toolsCtx, config, engine.archive);
        registerCompactionTool(toolsCtx, engine);
        return () => { engine.historyToolsAvailable = false; };
      });
    } catch (error) {
      ctx.logger?.warn?.(
        `[compaction-weave] history tools were not registered: ${error?.message ?? error}`,
      );
    }
  }

  ctx.inject?.(['commands'], commandCtx => commandCtx.commands.register({
    definitionId: 'dsh-compaction-weave/context-continue',
    name: 'context-continue',
    description: '在当前会话归档旧上下文并接续',
    async handler(invocation) {
      if (invocation.rawInput.trim()) return {kind:'error',text:'用法：/context-continue（不带参数）'};
      try {
        const result = await withCommandHeartbeat(invocation, () => engine.compactNow(invocation.agent, invocation.signal, invocation.commandId, true));
        return result ? {kind:'success',text:'已在当前会话接续。旧上下文已归档；后续请求仅携带接续记录和新消息。',sourceEventSeq:result.summarySeq} : {kind:'success',text:'目前没有可接续的历史。'};
      } catch (error) {
        return {kind:'error',text:invocation.signal.aborted ? '接续已取消。' : failureExplanation(error)+diagnosticText(error)};
      }
    }
  }));

  ctx.logger?.info?.(
    `[compaction-weave] engine ready (thresholdRatio=${config.thresholdRatio}, ` +
      `headroomTokens=${config.headroomTokens}, windowFallback=${config.windowFallback}, auto=${config.auto})`,
  );

  return () => {
    try {
      engine.dispose();
    } catch {
      // 卸载阶段吞掉清理错误，避免挡住其它插件的卸载
    }
  };
}

export default { name, inject, apply };
