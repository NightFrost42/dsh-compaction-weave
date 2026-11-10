// Timeout-only presentation. Never expose source text or arbitrary provider errors.
const TIMING_FIELDS = ['elapsedMs','firstChunkMs','lastChunkMs','firstTextMs','lastTextMs','firstProgressMs','lastProgressMs','idleMs','textIdleMs','maxProgressGapMs'];
const COUNT_FIELDS = ['chunks','textChars','reasoningChars'];
function safeProgress(error) {
  const out = {};
  for (const key of [...TIMING_FIELDS,...COUNT_FIELDS]) {
    const parsed = new RegExp(`(?:^|[ (,])${key}=(none|[0-9]+)(?=[ ,)]|$)`).exec(error.message ?? '');
    const value = error.diagnostics && Object.hasOwn(error.diagnostics,key) ? error.diagnostics[key] : (parsed ? parsed[1] === 'none' ? null : Number(parsed[1]) : undefined);
    if (value === null) out[key] = null;
    else if (Number.isSafeInteger(value) && value >= 0 && value <= (TIMING_FIELDS.includes(key) ? 86400000 : 1000000000)) out[key] = value;
  }
  return Number.isSafeInteger(out.textChars) && Object.hasOwn(out,'firstProgressMs') ? out : undefined;
}

export function summaryTimeoutInfo(error) {
  const seen = new Set();
  for (let current = error, depth = 0; current && depth < 8 && !seen.has(current); current = current.cause, depth++) {
    seen.add(current);
    if (current.code === 'SUMMARY_TIMEOUT') {
      const parsed = /timed out after (\d+)ms/.exec(current.message ?? '');
      const ms = Number.isFinite(current.timeoutMs) ? current.timeoutMs : parsed ? Number(parsed[1]) : null;
      const diagnostics = safeProgress(current);
      return {code:'SUMMARY_TIMEOUT', timeoutMs:ms > 0 && ms <= 86400000 ? ms : null, ...(diagnostics ? {diagnostics} : {})};
    }
    if (current.code === 'SUMMARY_ALL_FAILED' && Array.isArray(current.failures) && current.failures.length && current.failures.every(f => f.code === 'SUMMARY_TIMEOUT')) {
      return summaryTimeoutInfo(current.failures[0]);
    }
  }
  return null;
}

// compaction/end serializes errors as strings. Only recognize the native code
// prefix, including the legacy single-target aggregate seen before review.20.
export function timeoutInfoFromEnd(errorText) {
  if (typeof errorText !== 'string') return null;
  if (!/^SUMMARY_TIMEOUT:/.test(errorText) && !/^SUMMARY_ALL_FAILED: all summarization targets failed: [^\n]+ → SUMMARY_TIMEOUT:/.test(errorText)) return null;
  const matches = [...errorText.matchAll(/→ ([A-Z_]+):/g)];
  if (matches.some(m => m[1] !== 'SUMMARY_TIMEOUT')) return null;
  return summaryTimeoutInfo({code:'SUMMARY_TIMEOUT',message:errorText});
}

export function summaryTimeoutText(errorOrInfo) {
  const info = summaryTimeoutInfo(errorOrInfo);
  if (!info) return null;
  const duration = info.timeoutMs === null ? '' : `（${Math.ceil(info.timeoutMs / 1000)} 秒）`;
  const d = info.diagnostics;
  let progress = '';
  if (d?.textChars > 0 && Number.isSafeInteger(d.textIdleMs)) {
    progress = `已收到 ${d.textChars} 字符正文，最后正文进展距今 ${Math.ceil(d.textIdleMs / 1000)} 秒。`;
  } else if (d?.firstChunkMs === null) {
    progress = '尚未收到流分片。';
  } else if (d && d.firstProgressMs === null) {
    progress = '已收到流分片，但尚无可观测的内容进展。';
  } else if (d && Number.isSafeInteger(d.idleMs)) {
    progress = `尚未收到正文，最后可观测内容进展距今 ${Math.ceil(d.idleMs / 1000)} 秒。`;
  }
  return `摘要请求超时${duration}。${progress}本次压缩已停止，未完成区间的原上下文仍保留。请稍后手动执行 /compact 重试。`;
}

export function timeoutForCommand(session, commandId) {
  if (!commandId || typeof session?.eventAt !== 'function' || !Number.isSafeInteger(session.seq)) return null;
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq);
    if (event?.type === 'compaction/end' && event.data?.sourceCommandId === commandId) return timeoutInfoFromEnd(event.data.error);
    if (event?.type === 'command/run' && event.data?.commandId === commandId) break;
  }
  return null;
}
