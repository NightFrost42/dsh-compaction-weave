import {diagnosticText, failureExplanation} from './failure-diagnostics.js';
// Keep host validation, cancellation and success. Decorate failures using only
// this invocation's diagnostic receipt, with durable timeout/budget fallback.
// Also provide Weave subcommands: /compact migrate, /compact backups, /compact restore [backupId].
import { summaryTimeoutText, timeoutForCommand } from './summary-timeout.js';
import { withCommandHeartbeat } from './command-heartbeat.js';
import {continuationBudgetText,budgetForCommand} from './continuation-budget.js';
import { detectBiliSession } from './foreign-fold.js';
export const name = 'compaction-weave-command-compact';
export const inject = ['commands','compaction','loader'];

function extractCompactArgs(invocation) {
  if (!invocation || typeof invocation !== 'object') return '';
  if (typeof invocation.rawArgs === 'string' && invocation.rawArgs.trim().length > 0) {
    return invocation.rawArgs.trim();
  }
  if (typeof invocation.args === 'string' && invocation.args.trim().length > 0) {
    return invocation.args.trim();
  }
  if (Array.isArray(invocation.args) && invocation.args.length > 0) {
    return invocation.args.map(a => String(a ?? '').trim()).filter(Boolean).join(' ').trim();
  }
  if (typeof invocation.rawInput === 'string' && invocation.rawInput.trim().length > 0) {
    const trimmed = invocation.rawInput.trim();
    const match = /^\/compact(?:\s+([\s\S]*))?$/i.exec(trimmed);
    if (match) return (match[1] ?? '').trim();
  }
  return '';
}

function parseCompactSubcommand(invocation) {
  const argText = extractCompactArgs(invocation);
  if (!argText) return null;
  const parts = argText.split(/\s+/).filter(Boolean);
  const sub = parts[0]?.toLowerCase();
  if (sub === 'migrate' && parts.length === 1) return { kind: 'migrate' };
  if (sub === 'backups' && parts.length === 1) return { kind: 'backups' };
  if (sub === 'restore' && parts.length <= 2) return { kind: 'restore', backupId: parts[1] ?? undefined };
  return null;
}

async function runWeaveSubcommand(sub, invocation, compaction) {
  const session = invocation?.agent?.session;
  if (!session?.id) {
    return { kind: 'error', text: '当前没有可用的活动会话，无法执行该操作。' };
  }
  if (sub.kind === 'backups') {
    const backups = typeof compaction?.listSessionBackupsFor === 'function'
      ? compaction.listSessionBackupsFor(session.id)
      : compaction?.backupStore?.list?.(session.id) ?? [];
    const summary = typeof compaction?.summarizeBackupsFor === 'function'
      ? compaction.summarizeBackupsFor(session.id)
      : compaction?.backupStore?.summarize?.(session.id) ?? null;
    let pending = null;
    try { pending = compaction?.backupStore?.readPendingRestore?.(session.id) ?? null; } catch {}
    const lines = [];
    if (pending) {
      lines.push(`待执行还原：${pending.backupId}（关闭并重新打开当前会话或重载 DSH 后自动生效）。`);
    }
    if (!backups.length) {
      lines.push('当前会话暂无已保存的 Weave 完整会话备份。');
    } else {
      lines.push(`当前会话共有 ${backups.length} 份 Weave 完整备份（最新在前）：`);
      for (const b of backups.slice(0, 10)) {
        const sizeStr = typeof b.bytes === 'number' ? `${b.bytes} B` : '? B';
        const nodeStr = typeof b.surfaceNodeCount === 'number' ? ` | ${b.surfaceNodeCount} 节点` : '';
        const baselineTag = b.isBaseline || (summary?.originalBackupId && b.backupId === summary.originalBackupId) ? ' [原始基线]' : '';
        const statusStr = b.present ? '可用' : '缺失';
        lines.push(`- ${b.backupId}${baselineTag} | ${b.createdAt ?? 'unknown'} | ${b.encoding ?? 'none'} | ${sizeStr}${nodeStr} | ${b.reason ?? 'manual'} | ${statusStr}\n  ${b.backupPath ?? b.backupDir ?? ''}`);
      }
      if (summary?.originalBackupId) {
        lines.push(`可执行 /compact restore 默认还原原始基线备份（${summary.originalBackupId}），或执行 /compact restore <backupId> 指定版本。`);
      } else {
        lines.push(`可执行 /compact restore ${backups[0].backupId} 还原最新备份。`);
      }
    }
    return { kind: 'success', text: lines.join('\n') };
  }
  if (sub.kind === 'migrate') {
    if (typeof compaction?.migrateBiliSession !== 'function') {
      return { kind: 'error', text: 'Weave 兼容转换引擎不可用。' };
    }
    const detection = detectBiliSession(session);
    if (!detection.detected) {
      return { kind: 'success', text: '当前会话未检测到未转换的 billion-context 格式，无需兼容转换。' };
    }
    try {
      const res = await compaction.migrateBiliSession(session, {
        agent: invocation.agent,
        signal: invocation.signal,
        sourceCommandId: invocation.commandId,
        asyncRollingWave: false,
      });
      const tokenSummary = typeof res.afterTokens === 'number'
        ? `${res.beforeTokens} → ${res.afterTokens} tok`
        : `${res.beforeTokens} tok`;
      const restoreHintId = res.originalBackupId ?? res.backupId;
      return {
        kind: 'success',
        text: [
          `已完成 billion-context → Weave 兼容转换（${tokenSummary}）。`,
          `完整备份已校验：${res.backupId}${res.originalBackupId && res.originalBackupId !== res.backupId ? `（原始基线：${res.originalBackupId}）` : ''}`,
          `备份路径：${res.backupPath}`,
          `如需撤销转换，可执行：/compact restore ${restoreHintId}`,
        ].join('\n'),
      };
    } catch (error) {
      if (invocation.signal?.aborted) throw error;
      return { kind: 'error', text: failureExplanation(error) + diagnosticText(error) };
    }
  }
  if (sub.kind === 'restore') {
    if (typeof compaction?.restoreSessionBackupFor !== 'function') {
      return { kind: 'error', text: 'Weave 备份还原引擎不可用。' };
    }
    try {
      const res = await compaction.restoreSessionBackupFor(session.id, {
        backupId: sub.backupId,
        signal: invocation.signal,
      });
      if (res.requiresReopen || res.status === 'armed') {
        return {
          kind: 'success',
          text: [
            `备份还原已就绪（备份编号：${res.backupId}）。`,
            `备份路径：${res.backupPath}`,
            '当前会话已锁定写入；请关闭并重新打开当前会话（或重载 DSH）以自动加载还原后的历史。',
          ].join('\n'),
        };
      }
      return {
        kind: 'success',
        text: [
          `已从备份 ${res.backupId} 完成会话还原。`,
          `备份路径：${res.backupPath}`,
          `目标日志：${res.targetPath}`,
        ].join('\n'),
      };
    } catch (error) {
      if (invocation.signal?.aborted) throw error;
      return { kind: 'error', text: failureExplanation(error) + diagnosticText(error) };
    }
  }
  return null;
}

export function decorateCompactCommand(definition, compaction) {
  if (definition?.name !== 'compact' || typeof definition.handler !== 'function') return definition;
  return {...definition, async handler(invocation) {
    const sub = parseCompactSubcommand(invocation);
    if (sub) {
      return withCommandHeartbeat(invocation, () => runWeaveSubcommand(sub, invocation, compaction));
    }
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
