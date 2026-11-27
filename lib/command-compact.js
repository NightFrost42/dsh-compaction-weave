import {diagnosticText, failureExplanation} from './failure-diagnostics.js';
// Keep host validation, cancellation and success. Decorate failures using only
// this invocation's diagnostic receipt, with durable timeout/budget fallback.
// Also provide Weave subcommands: /compact migrate, /compact backups, /compact restore [backupId],
// /compact resume, /compact cancel, /compact discard, /compact reset, and one-shot /compact <focus>.
import { summaryTimeoutText, timeoutForCommand } from './summary-timeout.js';
import { withCommandHeartbeat } from './command-heartbeat.js';
import {continuationBudgetText,budgetForCommand} from './continuation-budget.js';
import { detectBiliSession } from './foreign-fold.js';
export const name = 'compaction-weave-command-compact';
export const inject = ['commands','compaction','loader'];

export const MAX_FOCUS_INSTRUCTION_CHARS = 500;

export function sanitizeFocusInstruction(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FOCUS_INSTRUCTION_CHARS)
    .trim();
}

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

export function parseCompactSubcommand(input) {
  const argText = typeof input === 'string' ? input.trim() : extractCompactArgs(input);
  if (!argText) return { kind: 'default' };
  const parts = argText.split(/\s+/).filter(Boolean);
  if (parts[0] === '--') {
    const focusInstruction = sanitizeFocusInstruction(argText.slice(2));
    return focusInstruction ? { kind: 'focus', focusInstruction } : { kind: 'focus-empty' };
  }
  const sub = parts[0]?.toLowerCase();
  if (sub === 'migrate' && parts.length === 1) return { kind: 'migrate' };
  if (sub === 'backups' && parts.length === 1) return { kind: 'backups' };
  if (sub === 'restore' && parts.length <= 2) return { kind: 'restore', backupId: parts[1] ?? undefined };
  if (sub === 'resume' && parts.length === 1) return { kind: 'resume' };
  if (sub === 'cancel' && parts.length === 1) return { kind: 'cancel' };
  if (sub === 'discard' && parts.length === 1) return { kind: 'discard' };
  if (sub === 'reset' && parts.length === 1) return { kind: 'reset' };
  if (sub === 'restore' && parts.length > 2) {
    return { kind: 'usage-error', subcommand: 'restore' };
  }
  const focusInstruction = sanitizeFocusInstruction(argText);
  return focusInstruction ? { kind: 'focus', focusInstruction } : { kind: 'default' };
}

function decorateCompactError(error, invocation, compaction) {
  const session = invocation?.agent?.session;
  const commandId = invocation?.commandId;
  const diagnostic = compaction?.failureForCommand?.(session, commandId);
  if (diagnostic) {
    return { kind: 'error', text: diagnostic.explanation + diagnosticText(diagnostic) };
  }
  const budget = budgetForCommand(session, commandId);
  if (budget) {
    return { kind: 'error', text: continuationBudgetText(budget) };
  }
  const timeout = timeoutForCommand(session, commandId);
  if (timeout) {
    return { kind: 'error', text: summaryTimeoutText(timeout) };
  }
  const directBudget = continuationBudgetText(error);
  if (directBudget) {
    return { kind: 'error', text: directBudget + diagnosticText(error) };
  }
  const directTimeout = summaryTimeoutText(error);
  if (directTimeout) {
    return { kind: 'error', text: directTimeout + diagnosticText(error) };
  }
  return { kind: 'error', text: failureExplanation(error) + diagnosticText(error) };
}

async function runWeaveSubcommand(sub, invocation, compaction) {
  if (sub.kind === 'usage-error') {
    return { kind: 'error', text: `用法：/compact ${sub.subcommand}${sub.subcommand === 'restore' ? ' [backupId]' : ''}。聚焦指令请使用 /compact -- <focus>。` };
  }
  if (sub.kind === 'focus-empty') {
    return { kind: 'error', text: '请在 /compact -- 后输入需要重点保留的聚焦指令（例如：/compact -- 保留 API 协议细节）。' };
  }
  const session = invocation?.agent?.session;
  if (sub.kind === 'focus') {
    if (!session) {
      return { kind: 'error', text: '当前没有可用的活动会话，无法执行聚焦压缩。' };
    }
    try {
      const res = await compaction.compactNow(
        invocation.agent,
        invocation.signal,
        invocation.commandId,
        false,
        { focusInstruction: sub.focusInstruction },
      );
      if (!res) {
        return {
          kind: 'success',
          text: `当前会话暂无可压缩的历史范围（未执行聚焦指令：${sub.focusInstruction}）。`,
        };
      }
      const chunks = Number.isInteger(res.chunks) && res.chunks > 0
        ? res.chunks
        : (Array.isArray(res.compactionIds) && res.compactionIds.length > 0 ? res.compactionIds.length : 1);
      const coveredTokens = typeof res.shadowedTokenCount === 'number' && Number.isFinite(res.shadowedTokenCount)
        ? res.shadowedTokenCount
        : null;
      const checkpointTokens = typeof res.checkpointTokens === 'number' && Number.isFinite(res.checkpointTokens)
        ? res.checkpointTokens
        : null;
      const stats = [`共提交 ${chunks} 段检查点`];
      if (coveredTokens !== null) {
        if (checkpointTokens !== null && coveredTokens >= checkpointTokens) {
          stats.push(`覆盖约 ${coveredTokens} tok（净缩减约 ${coveredTokens - checkpointTokens} tok）`);
        } else {
          stats.push(`覆盖源历史约 ${coveredTokens} tok`);
        }
      }
      if (Array.isArray(res.shadowedSeqs)) stats.push(`覆盖 ${res.shadowedSeqs.length} 个消息节点`);
      if (res.provider && res.model) stats.push(`摘要模型：${res.provider}/${res.model}`);
      return {
        kind: 'success',
        text: `已完成聚焦压缩（聚焦指令：${sub.focusInstruction}）：${stats.join('，')}。`,
        ...(typeof res.summarySeq === 'number' ? { sourceEventSeq: res.summarySeq } : {}),
      };
    } catch (error) {
      if (invocation.signal?.aborted) throw error;
      return decorateCompactError(error, invocation, compaction);
    }
  }
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
  if (sub.kind === 'resume') {
    if (typeof compaction?.resumeCompactionFor !== 'function') {
      return { kind: 'error', text: 'Weave 断点续传引擎不可用。' };
    }
    try {
      const res = await compaction.resumeCompactionFor(session, {
        agent: invocation.agent,
        signal: invocation.signal,
        sourceCommandId: invocation.commandId,
        manualRetry: true,
        asyncRollingWave: false,
      });
      if (!res) {
        return { kind: 'success', text: '当前会话没有待继续的压缩或转换任务。' };
      }
      if (res.alreadyRunning) {
        return { kind: 'success', text: '当前会话已有压缩或转换任务正在进行中。' };
      }
      const ids = res.compactionIds ?? (res.compactionId ? [res.compactionId] : []);
      return {
        kind: 'success',
        text: `已继续并完成剩余压缩任务（共提交 ${ids.length || 1} 段检查点）。`,
      };
    } catch (error) {
      if (invocation.signal?.aborted) throw error;
      return { kind: 'error', text: failureExplanation(error) + diagnosticText(error) };
    }
  }
  if (sub.kind === 'cancel') {
    if (typeof compaction?.cancelActiveCompactionFor !== 'function') {
      return { kind: 'error', text: 'Weave 压缩取消接口不可用。' };
    }
    const res = compaction.cancelActiveCompactionFor(session.id);
    if (res?.cancelled) {
      return {
        kind: 'success',
        text: '已请求暂停当前压缩/转换任务；已提交的分片将保留，稍后可通过 /compact resume 或下一条消息继续。',
      };
    }
    return { kind: 'success', text: '当前会话没有正在进行的压缩或转换任务。' };
  }
  if (sub.kind === 'discard') {
    if (typeof compaction?.discardResumableFor !== 'function') {
      return { kind: 'error', text: 'Weave 断点清理接口不可用。' };
    }
    if (compaction?.progressTracker?.hasActiveRun?.(session.id) || compaction?._busy?.has?.(session)) {
      return { kind: 'error', text: '当前会话有压缩任务正在运行，请先执行 /compact cancel 暂停后再放弃。' };
    }
    const res = compaction.discardResumableFor(session.id);
    if (res?.discarded || res?.clearedContinuation) {
      return {
        kind: 'success',
        text: '已放弃当前会话未完成的压缩断点进度（完整会话备份仍完整保留）。',
      };
    }
    return { kind: 'success', text: '当前会话没有可放弃的未完成压缩进度。' };
  }
  if (sub.kind === 'reset') {
    if (typeof compaction?.resetBreakerFor !== 'function') {
      return { kind: 'error', text: 'Weave 熔断重置接口不可用。' };
    }
    if (compaction?.progressTracker?.hasActiveRun?.(session.id) || compaction?._busy?.has?.(session)) {
      return { kind: 'error', text: '当前会话有压缩或迁移任务正在运行，请先等待完成或执行 /compact cancel 暂停后再重置熔断状态。' };
    }
    try {
      const res = await compaction.resetBreakerFor(session);
      if (res?.rebuilt) {
        return {
          kind: 'success',
          text: '检测到原状态文件损坏（STATE_INVALID），确认无未决恢复事务后已原子重建干净状态并重置熔断（failures=0，stopped=false）。',
        };
      }
      if (res?.reset) {
        const prev = Number.isSafeInteger(res.previousFailures) ? res.previousFailures : 0;
        const stoppedNote = res.wasStopped ? '、已解除 stopped 熔断锁定' : '';
        return {
          kind: 'success',
          text: `已重置当前会话压缩熔断状态（failures 已由 ${prev} 清零${stoppedNote}；window 观测值与未完成断点均已保留）。`,
        };
      }
      return {
        kind: 'success',
        text: '当前会话未处于熔断或连续失败状态（failures=0，stopped=false），无需重置。',
      };
    } catch (error) {
      if (error?.code === 'busy') {
        return { kind: 'error', text: '当前会话有压缩或迁移任务正在运行，请先等待完成或暂停后再执行 /compact reset。' };
      }
      if (error?.code === 'RECOVERY_REQUIRED') {
        return { kind: 'error', text: '检测到当前会话存在未完成的压缩恢复事务（RECOVERY_REQUIRED），已拒绝重置以避免破坏恢复链；请先重载 DSH 或完成恢复后再试。' };
      }
      if (error?.code === 'STATE_LOCKED') {
        return { kind: 'error', text: '状态文件正在被其他写入持有锁（STATE_LOCKED），请稍后重试。' };
      }
      return { kind: 'error', text: failureExplanation(error) + diagnosticText(error) };
    }
  }
  return null;
}

export function decorateCompactCommand(definition, compaction) {
  if (definition?.name !== 'compact' || typeof definition.handler !== 'function') return definition;
  return {...definition, input: {
    ...(definition.input ?? {}),
    hint: '/compact [migrate|backups|restore [backupId]|resume|cancel|discard|reset] 或 /compact -- <focus>',
  }, async handler(invocation) {
    const sub = parseCompactSubcommand(invocation);
    if (sub.kind !== 'default' && !(sub.kind === 'focus' && typeof compaction?.compactNow !== 'function')) {
      const heartbeatInvocation = invocation?.rawInput ? { ...invocation, rawInput: '' } : invocation;
      try {
        return await withCommandHeartbeat(heartbeatInvocation, () => runWeaveSubcommand(sub, invocation, compaction));
      } catch (error) {
        if (invocation?.signal?.aborted) throw error;
        return decorateCompactError(error, invocation, compaction);
      }
    }
    let result;
    const heartbeatInvocation = invocation?.rawInput &&
      (/^\s*\/compact\s*$/i.test(invocation.rawInput) || sub.kind === 'focus')
      ? { ...invocation, rawInput: '' }
      : invocation;
    try { result = await withCommandHeartbeat(heartbeatInvocation, () => definition.handler(invocation)); }
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
