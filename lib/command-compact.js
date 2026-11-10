import {diagnosticText} from './failure-diagnostics.js';
// Keep host validation, cancellation and success. Decorate failures using only
// this invocation's diagnostic receipt, with durable timeout/budget fallback.
import { summaryTimeoutText, timeoutForCommand } from './summary-timeout.js';
import { withCommandHeartbeat } from './command-heartbeat.js';
import {continuationBudgetText,budgetForCommand} from './continuation-budget.js';
export const name = 'compaction-weave-command-compact';
export const inject = ['commands','compaction','loader'];

export function decorateCompactCommand(definition, compaction) {
  if (definition?.name !== 'compact' || typeof definition.handler !== 'function') return definition;
  return {...definition, async handler(invocation) {
    let result;
    try { result = await withCommandHeartbeat(invocation, () => definition.handler(invocation)); }
    catch(error) {
      const diagnostic=compaction?.failureForCommand?.(invocation.agent?.session,invocation.commandId);
      if(invocation.signal?.aborted || !diagnostic)throw error;
      return {kind:'error',text:diagnostic.explanation+diagnosticText(diagnostic)};
    }
    if (result?.kind !== 'error' || invocation.signal?.aborted) return result;
    const diagnostic=compaction?.failureForCommand?.(invocation.agent?.session,invocation.commandId);
    if(diagnostic)return {...result,text:diagnostic.explanation+diagnosticText(diagnostic)};
    const budget=budgetForCommand(invocation.agent?.session,invocation.commandId);
    if(budget)return {...result,text:continuationBudgetText(budget)};
    const timeout = timeoutForCommand(invocation.agent?.session, invocation.commandId);
    return timeout ? {...result,text:summaryTimeoutText(timeout)} : result;
  }};
}
export async function apply(ctx) {
  const host = await ctx.loader.import('@deepseek-ai/dsh-command-compact', () => '');
  if (typeof host?.apply !== 'function') throw new Error('Host compact command implementation is unavailable.');
  return host.apply({
    compaction:ctx.compaction,
    commands:{register:definition=>ctx.commands.register(decorateCompactCommand(definition,ctx.compaction))},
    effect:ctx.effect.bind(ctx),
  });
}
export default {name,inject,apply};
