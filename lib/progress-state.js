// Domain-agnostic progress signal detector used to select latest assistant work reports.
// Structured progress facts are extracted explicitly as key/value claims in progress-facts.js.

const PROGRESS_SIGNAL_RE =
  /完成|已完成|尚未|未完成|未验证|未部署|未测试|下一步|继续|检查|失败|报错|成功|\b(?:complete[ds]?|done|pending|next|verif(?:y|ied)|unverified|fail(?:ed|ure)?|error|passed|succeeded|running)\b/i;

export function hasProgressSignals(text) {
  const value = String(text ?? '');
  try {
    if (typeof JSON.parse(value) === 'object') return false;
  } catch {
    /* ordinary prose */
  }
  if (/^(?:Same-session continuation\.|This is an automatically generated checkpoint)/.test(value)) {
    return false;
  }
  let fence = null;
  for (const line of value.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (fence === marker[1][0]) fence = null;
      continue;
    }
    if (!fence && !/^\s*>/.test(line) && PROGRESS_SIGNAL_RE.test(line)) {
      return true;
    }
  }
  return false;
}
