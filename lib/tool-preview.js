// Pure, zero-dependency, latency-guarded high-entropy preview extractor for
// oversized non-error tool outputs. Reallocates existing head/tail budgets
// across four deterministic priority tiers without ever emitting charOffset:
//   Tier 1 (diagnostic): mid-text error/traceback/compiler clusters with [L<n>]
//   Tier 2 (code-skeleton): extension-allowlisted declaration skeleton with [L<n>]
//   Tier 3 (json-outline): <= 160 KiB shallow 2-level JSON object/array outline
//   Tier 4 (salient-prose): high-entropy prose/heading/decision extraction

import { Buffer } from 'node:buffer';

export const LARGE_PREVIEW_INPUT_BYTES = 512 * 1024;
export const MAX_PREVIEW_SCAN_BYTES = 256 * 1024;
export const MAX_PREVIEW_SCAN_LINES = 8000;
export const MAX_JSON_PREVIEW_BYTES = 160 * 1024;
const MAX_PREVIEW_MS = 15;
const MIN_TOTAL_BUDGET = 240;

const SHELL_TOOL_NAMES = new Set([
  'bash',
  'shell',
  'exec',
  'run_command',
  'terminal',
  'powershell',
  'cmd',
  'sh',
]);

const PURE_READ_SHELL_RE =
  /^\s*(?:cat|(?:type|Get-Content|gc)(?=\s))\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'|&;<>`\r\n]+))\s*$/i;

const CODE_EXTENSION_FAMILY = new Map([
  ['.js', 'js'],
  ['.jsx', 'js'],
  ['.ts', 'js'],
  ['.tsx', 'js'],
  ['.mjs', 'js'],
  ['.cjs', 'js'],
  ['.mts', 'js'],
  ['.cts', 'js'],
  ['.py', 'py'],
  ['.pyi', 'py'],
  ['.go', 'go'],
  ['.rs', 'rs'],
  ['.java', 'c_like'],
  ['.kt', 'c_like'],
  ['.kts', 'c_like'],
  ['.scala', 'c_like'],
  ['.c', 'c_like'],
  ['.h', 'c_like'],
  ['.cc', 'c_like'],
  ['.cpp', 'c_like'],
  ['.cxx', 'c_like'],
  ['.hh', 'c_like'],
  ['.hpp', 'c_like'],
  ['.hxx', 'c_like'],
  ['.cs', 'c_like'],
  ['.swift', 'c_like'],
  ['.m', 'c_like'],
  ['.mm', 'c_like'],
  ['.rb', 'rb_php'],
  ['.php', 'rb_php'],
]);

const STRONG_DIAGNOSTIC_RE =
  /(?:(?:^|[\s([{"'`])(?:[A-Za-z_][A-Za-z0-9_]{0,64}(?:Error|Exception):\s+\S|[^\s:]{1,200}\.[A-Za-z0-9]{1,8}:\d+(?::\d+)?(?:\s+-\s+|:)\s*(?:fatal\s+)?error\b|[^\s(]{1,200}\(\d+,\d+\):\s*error\b)|\b(?:AssertionError|Traceback \(most recent call last\)|Caused by:)|^\s*Traceback\b|\berror\s+TS\d+:|\berror\[[A-Z]\d+\]:|\bthread\s+'[^'\r\n]{1,120}'\s+panicked at\b|\bpanicked at\s|\bfatal error:\s*\S|\bgoroutine\s+\d+\s+\[running\]:)/;
const GENERAL_DIAGNOSTIC_RE =
  /(?:^|\s)(?:---\s*FAIL:\s*\S|FAIL[ \t]|FAILED\b|panic:\s*\S|ERR!\s*\S|FATAL\b|ERROR:\s+\S)/;
const BENIGN_ZERO_DIAGNOSTIC_RE =
  /(?:\b0+\s+(?:failed|errors?|failures?|warnings?)\b|\b(?:failed|errors?|failures?)\s*[:=]\s*0+\b)/i;
const STACK_FRAME_CONTINUATION_RE =
  /^\s*(?:at\s+(?:\S{1,120}\s+\([^)\r\n]{1,200}:\d+(?::\d+)?\)|[^\s()]{1,200}:\d+(?::\d+)?|async\s+\S+)|File\s+"[^"\r\n]{1,240}",\s+line\s+\d+|-->\s+\S{1,200}:\d+:\d+|\d+:\s+(?:0x[0-9a-f]+\s+-\s+)?[A-Za-z_][\w:<>]{0,160}|[^\s:]{1,200}\.go:\d+(?:\s+\+0x[0-9a-f]+)?\b|(?:[A-Za-z_][\w/-]{0,64}\.)+[A-Za-z_]\w{0,64}\([^)\r\n]{0,200}\)\s*$)/;

const LINE_NUMBERED_RE = /^\s*(\d+)(?:: ?| ?\| ?|\t|\u2192)(.*)$/;
const CONTROL_KEYWORD_RE =
  /^(?:if|for|while|switch|catch|return|else|try|finally|do|throw|with|sizeof|typeof|delete|await|yield|case|default)\b/;

/**
 * Count Unicode code points in `str` without allocating a character array.
 * @param {string} str
 * @returns {number}
 */
export function codePointLength(str) {
  if (typeof str !== 'string' || str.length === 0) return 0;
  let count = 0;
  const len = str.length;
  for (let i = 0; i < len; i += 1) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

/**
 * Return the first `maxCodePoints` Unicode code points of `str`.
 * @param {string} str
 * @param {number} maxCodePoints
 * @returns {string}
 */
export function sliceCodePointsStart(str, maxCodePoints) {
  if (typeof str !== 'string' || !Number.isFinite(maxCodePoints) || maxCodePoints <= 0) return '';
  const target = Math.floor(maxCodePoints);
  const len = str.length;
  let count = 0;
  let i = 0;
  while (i < len && count < target) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < len) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    i += 1;
    count += 1;
  }
  return str.slice(0, i);
}

/**
 * Return the last `maxCodePoints` Unicode code points of `str`.
 * @param {string} str
 * @param {number} maxCodePoints
 * @returns {string}
 */
export function sliceCodePointsEnd(str, maxCodePoints) {
  if (typeof str !== 'string' || !Number.isFinite(maxCodePoints) || maxCodePoints <= 0) return '';
  const target = Math.floor(maxCodePoints);
  let count = 0;
  let i = str.length;
  while (i > 0 && count < target) {
    i -= 1;
    const code = str.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff && i > 0) {
      const prev = str.charCodeAt(i - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) i -= 1;
    }
    count += 1;
  }
  return str.slice(i);
}

function clipSingleLine(line, maxCodePoints) {
  if (!line || maxCodePoints <= 0) return '';
  if (codePointLength(line) <= maxCodePoints) return line;
  if (maxCodePoints <= 3) return sliceCodePointsStart(line, maxCodePoints);
  return `${sliceCodePointsStart(line, maxCodePoints - 3)}...`;
}

function trimTrailingCr(str) {
  return str.endsWith('\r') ? str.slice(0, -1) : str;
}

function scanLinesBounded(text, scanLimit, deadlineMs) {
  const lines = [];
  const bounded = scanLimit < text.length ? text.slice(0, scanLimit) : text;
  let pos = 0;
  let lineNo = 1;
  while (pos < bounded.length && lines.length < MAX_PREVIEW_SCAN_LINES) {
    if ((lines.length & 511) === 511 && performance.now() > deadlineMs) {
      return { lines, timedOut: true };
    }
    const nl = bounded.indexOf('\n', pos);
    const rawEnd = nl === -1 ? bounded.length : nl;
    let end = rawEnd;
    if (end > pos && bounded.charCodeAt(end - 1) === 0x0d) end -= 1;
    lines.push({ lineNo, start: pos, end });
    lineNo += 1;
    if (nl === -1) break;
    pos = nl + 1;
  }
  return { lines, timedOut: false };
}

function isDiagnosticLine(lineText) {
  const sample = lineText.length > 512 ? lineText.slice(0, 512) : lineText;
  if (!sample.trim()) return false;
  if (STRONG_DIAGNOSTIC_RE.test(sample)) return true;
  if (GENERAL_DIAGNOSTIC_RE.test(sample)) {
    return !BENIGN_ZERO_DIAGNOSTIC_RE.test(sample);
  }
  return false;
}

function diagnosticSignature(lineText) {
  return lineText
    .trim()
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

function formatClusterLines(text, lines, cluster, clusterBudget) {
  const firstIdx = cluster.matchIndices[0];
  const lastMatchIdx = cluster.matchIndices[cluster.matchIndices.length - 1];
  const lineTextAt = (idx, cap) => {
    const { start, end } = lines[idx];
    const sliceEnd = end - start > cap * 2 ? start + cap * 2 : end;
    return clipSingleLine(text.slice(start, sliceEnd).trimEnd(), cap);
  };

  // Start with the matched span (cap to 4 lines if cluster matches are consecutive)
  const coreEndIdx = Math.min(lastMatchIdx, firstIdx + 3);
  const perLineCap = Math.max(80, Math.min(220, Math.floor(clusterBudget / Math.max(1, coreEndIdx - firstIdx + 1)) - 12));
  const picked = [];
  for (let i = firstIdx; i <= coreEndIdx; i += 1) {
    picked.push({ lineNo: lines[i].lineNo, text: lineTextAt(i, perLineCap) });
  }

  const renderPicked = (items) => {
    if (items.length === 1) return `[L${items[0].lineNo}] ${items[0].text}`;
    return `[L${items[0].lineNo}-L${items[items.length - 1].lineNo}]\n${items.map((x) => x.text).join('\n')}`;
  };

  // Ensure the primary diagnostic line always fits even inside tight cluster budgets
  while (picked.length > 1 && codePointLength(renderPicked(picked)) > clusterBudget) {
    picked.pop();
  }
  if (codePointLength(renderPicked(picked)) > clusterBudget) {
    const prefix = `[L${picked[0].lineNo}] `;
    const room = clusterBudget - codePointLength(prefix);
    if (room < 24) return '';
    picked[0].text = clipSingleLine(picked[0].text, room);
  }

  // Try adding 1 leading context line + up to 2 trailing context lines within budget
  const candidates = [
    { pos: 'before', idx: firstIdx - 1 },
    { pos: 'after', idx: coreEndIdx + 1 },
    { pos: 'after', idx: coreEndIdx + 2 },
  ];
  for (const step of candidates) {
    if (step.idx < 0 || step.idx >= lines.length) continue;
    const lineContent = lineTextAt(step.idx, 160);
    if (!lineContent.trim()) continue;
    const trial =
      step.pos === 'before'
        ? [{ lineNo: lines[step.idx].lineNo, text: lineContent }, ...picked]
        : [...picked, { lineNo: lines[step.idx].lineNo, text: lineContent }];
    if (codePointLength(renderPicked(trial)) <= clusterBudget) {
      if (step.pos === 'before') picked.unshift(trial[0]);
      else picked.push(trial[trial.length - 1]);
    }
  }

  const formatted = renderPicked(picked);
  return codePointLength(formatted) <= clusterBudget ? formatted : '';
}

function tryDiagnosticPreview(text, scanLimit, truncatedScan, safeHead, safeTail, deadlineMs) {
  const totalBudget = safeHead + safeTail;
  let headBudget = 0;
  let tailBudget = 0;
  let midBudget = 0;
  if (safeHead > 0 && safeTail > 0) {
    headBudget = Math.floor(totalBudget / 3);
    midBudget = Math.floor((totalBudget * 5) / 12);
    tailBudget = totalBudget - headBudget - midBudget;
  } else if (safeHead > 0) {
    headBudget = Math.floor(totalBudget / 2);
    midBudget = totalBudget - headBudget;
  } else {
    tailBudget = Math.floor(totalBudget / 2);
    midBudget = totalBudget - tailBudget;
  }
  if (midBudget < 120) return null;

  const stdHeadStr = sliceCodePointsStart(text, safeHead);
  const stdTailStr = sliceCodePointsEnd(text, safeTail);
  const stdHeadEnd = stdHeadStr.length;
  const stdTailStart = text.length - stdTailStr.length;
  if (stdTailStart <= stdHeadEnd) return null;

  const { lines, timedOut } = scanLinesBounded(text, scanLimit, deadlineMs);
  if (timedOut || lines.length === 0) return null;

  const clusters = [];
  const seenSigs = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if ((i & 255) === 255 && performance.now() > deadlineMs) return null;
    const line = lines[i];
    if (line.end <= stdHeadEnd) continue;
    if (line.start >= stdTailStart) break;
    const rawLine = text.slice(line.start, Math.min(line.end, line.start + 512));
    const isDiag = isDiagnosticLine(rawLine);
    const last = clusters[clusters.length - 1];
    const lastMatchLineNo = last ? lines[last.matchIndices[last.matchIndices.length - 1]].lineNo : -1;
    const isStackFrame =
      !isDiag &&
      last &&
      line.lineNo - lastMatchLineNo <= 2 &&
      STACK_FRAME_CONTINUATION_RE.test(rawLine) &&
      !BENIGN_ZERO_DIAGNOSTIC_RE.test(rawLine);
    if (!isDiag && !isStackFrame) continue;

    if (last && line.lineNo - lastMatchLineNo <= 3) {
      if (last.matchIndices.length < 4) last.matchIndices.push(i);
      continue;
    }
    const sig = diagnosticSignature(rawLine);
    if (seenSigs.has(sig)) continue;
    seenSigs.add(sig);
    clusters.push({ matchIndices: [i] });
    if (clusters.length >= 2 && last && line.lineNo - lines[last.matchIndices[0]].lineNo > 4) {
      // Already have 2 distinct non-adjacent diagnostic clusters
      if (clusters.length >= 2) break;
    }
  }
  if (clusters.length === 0) return null;

  const selected = clusters.slice(0, 2);
  const separator = '\n...\n';
  const perClusterBudget =
    selected.length === 1
      ? midBudget
      : Math.max(80, Math.floor((midBudget - separator.length) / selected.length));

  const parts = [];
  for (const cluster of selected) {
    const part = formatClusterLines(text, lines, cluster, perClusterBudget);
    if (part) parts.push(part);
  }
  if (parts.length === 0) return null;

  let middle = parts.join(separator);
  if (parts.length === 2 && codePointLength(middle) > midBudget) {
    middle = parts[0];
  }
  if (!middle || codePointLength(middle) > midBudget) return null;

  const head = sliceCodePointsStart(text, headBudget);
  const tail = sliceCodePointsEnd(text, tailBudget);
  const keptChars = codePointLength(head) + codePointLength(middle) + codePointLength(tail);
  if (keptChars > totalBudget) return null;

  return { kind: 'diagnostic', head, middle, tail, keptChars, truncatedScan };
}

function resolveCodeFamily(toolName, target) {
  if (typeof target !== 'string' || !target.trim() || target.length > 1024) return null;
  let candidatePath = target.trim();
  const normalizedTool = typeof toolName === 'string' ? toolName.trim().toLowerCase() : '';
  if (SHELL_TOOL_NAMES.has(normalizedTool)) {
    if (/[|&;<>`\r\n]/.test(candidatePath)) return null;
    const match = PURE_READ_SHELL_RE.exec(candidatePath);
    if (!match) return null;
    candidatePath = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!candidatePath || candidatePath.startsWith('-')) return null;
  } else {
    candidatePath = candidatePath
      .replace(/^["']|["']$/g, '')
      .replace(/:\d+(?:-\d+)?$/, '')
      .trim();
  }
  const clean = candidatePath.split(/[?#]/)[0];
  const dotIdx = clean.lastIndexOf('.');
  const slashIdx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  if (dotIdx <= slashIdx || dotIdx < 0) return null;
  const ext = clean.slice(dotIdx).toLowerCase();
  return CODE_EXTENSION_FAMILY.get(ext) ?? null;
}

function detectLineNumberPrefix(text, lines) {
  let checked = 0;
  let matched = 0;
  let prevNum = 0;
  for (let i = 0; i < lines.length && checked < 10; i += 1) {
    const lineText = text.slice(lines[i].start, Math.min(lines[i].end, lines[i].start + 256));
    if (!lineText.trim()) continue;
    checked += 1;
    const m = LINE_NUMBERED_RE.exec(lineText);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isSafeInteger(n) && n > prevNum) {
        matched += 1;
        prevNum = n;
      }
    }
  }
  return checked >= 3 && matched / checked >= 0.6;
}

function cleanDeclHeader(rawTrimmed) {
  let out = rawTrimmed.replace(/\s+/g, ' ');
  const braceIdx = out.indexOf(' {');
  if (braceIdx > 8) out = out.slice(0, braceIdx);
  else if (out.endsWith('{')) out = out.slice(0, -1).trimEnd();
  return clipSingleLine(out, 110);
}

function isImportLine(trimmed, family, indentWidth) {
  if (indentWidth > 0) return false;
  if (family === 'js') {
    return /^(?:import\s|export\s+(?:\*|\{[^}]+\})\s+from\b)/.test(trimmed);
  }
  if (family === 'py') {
    return /^(?:import\s+[A-Za-z_]|from\s+[A-Za-z_.][\w.]*\s+import\b)/.test(trimmed);
  }
  if (family === 'go') {
    return /^(?:package\s+[A-Za-z_]|import\s+(?:"|\())/.test(trimmed);
  }
  if (family === 'rs') {
    return /^(?:use\s+[A-Za-z_]|pub\s+use\s+[A-Za-z_]|mod\s+[A-Za-z_]+;|extern\s+crate\b)/.test(trimmed);
  }
  if (family === 'c_like') {
    return /^(?:#include\s+[<"]|package\s+[\w.]+;|import\s+(?:static\s+)?[\w.*]+;|using\s+(?:static\s+)?[\w.]+=?;|using\s+[\w.]+\s*;)/.test(trimmed);
  }
  if (family === 'rb_php') {
    return /^(?:require(?:_relative|_once)?|include(?:_once)?|use\s+[A-Za-z_\\]|namespace\s+[A-Za-z_\\])/.test(trimmed);
  }
  return false;
}

function matchDeclarationHeader(trimmed, family, indentWidth) {
  if (!trimmed || indentWidth > 4) return null;
  if (/^(?:\/\/|\/\*|\*\/|\*(?:\s|$)|#\s|#\s*$)/.test(trimmed)) return null;
  if (CONTROL_KEYWORD_RE.test(trimmed)) return null;

  if (family === 'js') {
    if (/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\*?\s+[A-Za-z_$][\w$]*\s*\(/.test(trimmed)) {
      return cleanDeclHeader(trimmed);
    }
    if (/^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+[A-Za-z_$][\w$]*/.test(trimmed)) {
      return cleanDeclHeader(trimmed);
    }
    if (/^(?:export\s+)?(?:interface|type|enum|namespace|declare\s+(?:function|class|const|type|interface|module))\s+[A-Za-z_$][\w$]*/.test(trimmed)) {
      return cleanDeclHeader(trimmed);
    }
    if (indentWidth === 0 && /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(trimmed)) {
      return cleanDeclHeader(trimmed);
    }
    if (indentWidth === 0 && /^export\s+(?:const|let|var)\s+[A-Za-z_$][\w$]*/.test(trimmed)) {
      return cleanDeclHeader(trimmed);
    }
    if (
      indentWidth > 0 &&
      /^(?:(?:public|private|protected|static|readonly|override|async)\s+)*(?:get\s+|set\s+)?[A-Za-z_$][\w$]*\s*(?:<[^>\n]{1,40}>)?\([^)\n]*\)\s*(?::\s*[^={\n]+)?\{?$/.test(trimmed) &&
      trimmed.includes('{')
    ) {
      return cleanDeclHeader(trimmed);
    }
    return null;
  }

  if (family === 'py') {
    if (/^(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/.test(trimmed)) return cleanDeclHeader(trimmed);
    if (/^class\s+[A-Za-z_]\w*(?:\s*\([^)]*\))?:/.test(trimmed)) return cleanDeclHeader(trimmed);
    return null;
  }

  if (family === 'go') {
    if (/^func\s+(?:\([^)]+\)\s*)?[A-Za-z_]\w*\s*(?:\[[^\]]+\])?\(/.test(trimmed)) return cleanDeclHeader(trimmed);
    if (/^type\s+[A-Za-z_]\w*\s+(?:struct|interface|=|[A-Za-z_[])/.test(trimmed)) return cleanDeclHeader(trimmed);
    if (indentWidth === 0 && /^(?:const|var)\s+[A-Za-z_(]/.test(trimmed)) return cleanDeclHeader(trimmed);
    return null;
  }

  if (family === 'rs') {
    if (/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:extern\s+(?:"[^"]+"\s+)?)?fn\s+[A-Za-z_]\w*/.test(trimmed)) {
      return cleanDeclHeader(trimmed);
    }
    if (/^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|mod|type)\s+[A-Za-z_]\w*/.test(trimmed)) {
      return cleanDeclHeader(trimmed);
    }
    if (/^(?:unsafe\s+)?impl(?:<[^>\n]{1,60}>)?\s+[A-Za-z_][\w:<>\s,]*\{?$/.test(trimmed)) {
      return cleanDeclHeader(trimmed);
    }
    return null;
  }

  if (family === 'c_like') {
    if (/^(?:(?:public|private|protected|internal|export|abstract|final|sealed|static|partial)\s+)*(?:class|struct|interface|enum|record|namespace|protocol|extension)\s+[A-Za-z_]\w*/.test(trimmed)) {
      return cleanDeclHeader(trimmed);
    }
    if (/^template\s*<[^>\n]+>\s*(?:class|struct|[A-Za-z_])/.test(trimmed)) {
      return cleanDeclHeader(trimmed);
    }
    if (
      /^(?:(?:public|private|protected|internal|static|virtual|override|abstract|final|async|inline|constexpr|extern|synchronized|native)\s+)*(?:[A-Za-z_][\w:<>,*\[\]&\s?]{1,48})\s+[A-Za-z_~]\w*\s*\([^)\n]*\)\s*(?:const\s*)?(?:throws\s+[\w,\s]+)?(?:=>|\{|;)?$/.test(trimmed) &&
      (trimmed.includes('{') || trimmed.includes('=>') || indentWidth > 0)
    ) {
      return cleanDeclHeader(trimmed);
    }
    return null;
  }

  if (family === 'rb_php') {
    if (/^(?:class|module|interface|trait)\s+[A-Za-z_\\]\w*/.test(trimmed)) return cleanDeclHeader(trimmed);
    if (/^(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?[A-Za-z_]\w*\s*\(/.test(trimmed)) {
      return cleanDeclHeader(trimmed);
    }
    if (/^def\s+(?:self\.)?[A-Za-z_]\w*[?!=]?/.test(trimmed)) return cleanDeclHeader(trimmed);
    return null;
  }

  return null;
}

function tryCodeSkeletonPreview(text, scanLimit, truncatedScan, safeHead, safeTail, toolName, target, deadlineMs) {
  const family = resolveCodeFamily(toolName, target);
  if (!family) return null;

  const { lines, timedOut } = scanLinesBounded(text, scanLimit, deadlineMs);
  if (timedOut || lines.length < 4) return null;

  const totalBudget = safeHead + safeTail;
  const lineNumbered = detectLineNumberPrefix(text, lines);
  const imports = [];
  const decls = [];

  for (let i = 0; i < lines.length; i += 1) {
    if ((i & 255) === 255 && performance.now() > deadlineMs) return null;
    const line = lines[i];
    const sliceEnd = line.end - line.start > 512 ? line.start + 512 : line.end;
    let body = text.slice(line.start, sliceEnd);
    let displayLineNo = line.lineNo;

    if (lineNumbered) {
      const m = LINE_NUMBERED_RE.exec(body);
      if (m) {
        displayLineNo = Number.parseInt(m[1], 10);
        body = m[2];
      }
    }

    const indentMatch = /^([ \t]*)(.*)$/.exec(body);
    if (!indentMatch) continue;
    const rawIndent = indentMatch[1];
    let indentWidth = 0;
    for (let k = 0; k < rawIndent.length; k += 1) {
      indentWidth += rawIndent.charCodeAt(k) === 9 ? 4 : 1;
    }
    if (indentWidth > 4) continue;
    const trimmed = indentMatch[2].trim();
    if (!trimmed) continue;

    if (imports.length < 64 && decls.length === 0 && isImportLine(trimmed, family, indentWidth)) {
      imports.push(clipSingleLine(trimmed, 96));
      continue;
    }
    const header = matchDeclarationHeader(trimmed, family, indentWidth);
    if (header) {
      decls.push({ lineNo: displayLineNo, header });
    }
  }

  if (decls.length < 2) return null;

  const tailBudget = safeTail > 0 ? Math.min(safeTail, Math.max(80, Math.floor(totalBudget * 0.2))) : 0;
  const tail = tailBudget > 0 ? sliceCodePointsEnd(text, tailBudget) : '';
  const tailUsed = codePointLength(tail);
  const skeletonBudget = totalBudget - tailUsed;
  if (skeletonBudget < 120) return null;

  const outLines = [];
  let usedChars = 0;
  const importBudget = Math.floor(skeletonBudget * 0.22);
  let shownImports = 0;
  for (const imp of imports) {
    if (shownImports >= 4) break;
    const cost = codePointLength(imp) + (outLines.length > 0 ? 1 : 0);
    if (usedChars + cost > importBudget) break;
    outLines.push(imp);
    usedChars += cost;
    shownImports += 1;
  }
  if (imports.length > shownImports && shownImports > 0) {
    const moreImp = `... (+${imports.length - shownImports} more imports)`;
    if (usedChars + 1 + codePointLength(moreImp) <= importBudget + 32) {
      outLines.push(moreImp);
      usedChars += 1 + codePointLength(moreImp);
    }
  }

  let shownDecls = 0;
  for (let i = 0; i < decls.length; i += 1) {
    const entry = `[L${decls[i].lineNo}] ${decls[i].header}`;
    const remainingAfter = decls.length - (shownDecls + 1);
    const footerReserve = remainingAfter > 0 ? codePointLength(`\n... +${remainingAfter} more declarations archived`) : 0;
    const addCost = codePointLength(entry) + (outLines.length > 0 ? 1 : 0);
    if (usedChars + addCost + footerReserve > skeletonBudget) break;
    outLines.push(entry);
    usedChars += addCost;
    shownDecls += 1;
  }

  if (shownDecls < 2) return null;
  if (shownDecls < decls.length) {
    const footer = `... +${decls.length - shownDecls} more declarations archived`;
    if (usedChars + 1 + codePointLength(footer) <= skeletonBudget) {
      outLines.push(footer);
    }
  }

  const middle = outLines.join('\n');
  const keptChars = codePointLength(middle) + tailUsed;
  if (keptChars > totalBudget) return null;

  return { kind: 'code-skeleton', head: '', middle, tail, keptChars, truncatedScan };
}

function describeAtom(val) {
  if (val === null) return 'null';
  const t = typeof val;
  if (t === 'boolean' || t === 'number') return String(val);
  if (t === 'string') {
    const clean = val.replace(/\s+/g, ' ').trim();
    const len = codePointLength(val);
    if (len <= 24) return JSON.stringify(clean);
    return `string(${len} chars)`;
  }
  if (Array.isArray(val)) return `array(${val.length})`;
  if (t === 'object') return `object(${Object.keys(val).length} keys)`;
  return t;
}

function describeShallowJson(val) {
  if (val === null || typeof val !== 'object') return describeAtom(val);
  if (Array.isArray(val)) {
    if (val.length === 0) return 'array(0)';
    const first = val[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const itemKeys = Object.keys(first);
      const previewKeys = itemKeys.slice(0, 4).join(', ') + (itemKeys.length > 4 ? ', ...' : '');
      return `array(len=${val.length}${previewKeys ? `; item keys: ${previewKeys}` : ''})`;
    }
    return `array(len=${val.length}; [0]=${describeAtom(first)})`;
  }
  const keys = Object.keys(val);
  if (keys.length === 0) return 'object(0 keys)';
  const preview = keys.slice(0, 5).join(', ') + (keys.length > 5 ? ', ...' : '');
  return `object(${keys.length} keys: ${preview})`;
}

function tryJsonOutlinePreview(text, safeHead, safeTail) {
  if (text.length > MAX_JSON_PREVIEW_BYTES || Buffer.byteLength(text, 'utf8') > MAX_JSON_PREVIEW_BYTES) {
    return null;
  }
  const trimmed = text.trim();
  const isObj = trimmed.startsWith('{') && trimmed.endsWith('}');
  const isArr = trimmed.startsWith('[') && trimmed.endsWith(']');
  if (!isObj && !isArr) return null;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const totalBudget = safeHead + safeTail;
  const lines = [];
  let usedChars = 0;

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return null;
    lines.push(`JSON array (length=${parsed.length}):`);
    usedChars = codePointLength(lines[0]);
    const firstLine = `  [0]: ${describeShallowJson(parsed[0])}`;
    if (usedChars + 1 + codePointLength(firstLine) > totalBudget) return null;
    lines.push(firstLine);
    usedChars += 1 + codePointLength(firstLine);

    if (parsed.length > 1) {
      const lastLine = `  [${parsed.length - 1}]: ${describeShallowJson(parsed[parsed.length - 1])}`;
      const midNote = parsed.length > 2 ? `  ... (${parsed.length - 2} middle items archived)` : '';
      const extraCost =
        (midNote ? 1 + codePointLength(midNote) : 0) + 1 + codePointLength(lastLine);
      if (usedChars + extraCost <= totalBudget) {
        if (midNote) lines.push(midNote);
        lines.push(lastLine);
      } else if (usedChars + 1 + codePointLength(lastLine) <= totalBudget) {
        lines.push(lastLine);
      }
    }
  } else {
    const keys = Object.keys(parsed);
    if (keys.length === 0) return null;
    const header = `JSON object (${keys.length} keys):`;
    if (codePointLength(header) >= totalBudget) return null;
    lines.push(header);
    usedChars = codePointLength(header);

    let shownKeys = 0;
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      const line = `  ${clipSingleLine(key, 48)}: ${describeShallowJson(parsed[key])}`;
      const remaining = keys.length - (shownKeys + 1);
      const footerReserve = remaining > 0 ? codePointLength(`\n  ... +${remaining} more keys archived`) : 0;
      if (usedChars + 1 + codePointLength(line) + footerReserve > totalBudget) break;
      lines.push(line);
      usedChars += 1 + codePointLength(line);
      shownKeys += 1;
    }
    if (shownKeys === 0) return null;
    if (shownKeys < keys.length) {
      const footer = `  ... +${keys.length - shownKeys} more keys archived`;
      if (usedChars + 1 + codePointLength(footer) <= totalBudget) {
        lines.push(footer);
      }
    }
  }

  const middle = lines.join('\n');
  const keptChars = codePointLength(middle);
  if (!middle || keptChars > totalBudget) return null;
  return { kind: 'json-outline', head: '', middle, tail: '', keptChars, truncatedScan: false };
}

const MAX_DENSITY_SCAN_CHARS = 24 * 1024;
const PROSE_ABBREVIATIONS = new Set([
  'e.g',
  'i.e',
  'etc',
  'vs',
  'dr',
  'mr',
  'mrs',
  'ms',
  'prof',
  'fig',
  'no',
  'inc',
  'ltd',
  'approx',
  'min',
  'max',
  'st',
  'al',
]);

const PATH_SIGNAL_RE =
  /(?:^|[\s(`"'])(?:[A-Za-z]:[\\/]|\/|[A-Za-z0-9_-]{1,48}(?:\.[A-Za-z0-9_-]{1,24})?\/)(?:[A-Za-z0-9_-]{1,48}[\\/]){0,10}[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9]{1,8}\b|(?:^|[\s(`"'])[A-Za-z0-9_-]{1,48}(?:\.[A-Za-z0-9_-]{1,24}){0,4}\.(?:js|ts|mjs|cjs|jsx|tsx|py|go|rs|java|json|yaml|yml|toml|sql|sh|md)\b/g;
const URL_SIGNAL_RE = /https?:\/\/[^\s)>"']{1,240}/gi;
const BACKTICK_SIGNAL_RE = /`[^`\r\n]{2,80}`/g;
const CLI_FLAG_RE = /(?:^|\s)--?[A-Za-z][A-Za-z0-9_-]{1,32}/g;
const VERSION_OR_METRIC_RE =
  /\bv?\d{1,12}(?:\.\d{1,12}){1,3}\b|\b0x[0-9a-f]{1,16}\b|\b\d{1,12}(?:\.\d{1,6})?\s*(?:ms|s|kb|mb|gb|b|%|tok|tokens|hz|fps)\b|\b\d{1,12}(?:\.\d{1,6})?\b/gi;
const CODE_IDENT_SIGNAL_RE =
  /\b[a-z]{1,40}[A-Z][A-Za-z0-9]{0,64}\b|\b[A-Za-z]{1,40}_[A-Za-z0-9_]{1,64}\b|\b[A-Za-z_]\w{0,48}::[A-Za-z_]\w{0,48}\b/g;
const CONSTRAINT_DECISION_CUE_RE =
  /\b(?:must|never|always|forbid|forbidden|prohibit|prohibited|require|required|shall|error|failed|exception|invariant|constraint|deadline|timeout|rejected|decided|decision|fixed|fix|bug|warning|architecture|schema|checksum)\b|必须|禁止|不得|不要|不可|务必|错误|异常|失败|修复|约束|限制|决定|决策|架构|校验/gi;
const HEADING_CUE_RE =
  /\b(?:decision|decisions|constraint|constraints|rule|rules|error|errors|fix|fixes|bug|bugs|architecture|design|requirement|requirements|pending|todo|invariant|warning|summary|key|findings|root cause)\b|决策|决定|约束|规则|错误|修复|架构|设计|需求|待办|关键|结论|根因|总结/i;
const FILLER_CUE_RE =
  /\b(?:i understand|let me|i will now|i'm going to|thank you|happy to help|sure thing|step by step|as requested|let's carefully|moving on to|in summary|overall|basically|essentially|please note|feel free|looks good|everything seems|working trace|filler|padding|carefully review|check everything|proceed smoothly)\b|好的|明白|了解|接下来我将|让我们|一步步|请注意|没问题|非常感谢|总体来说|基本上|仔细检查/gi;
const STRUCTURED_KV_LINE_RE =
  /^\s*(?:[-*+]\s+)?(?:[a-zA-Z][a-zA-Z0-9_.-]{1,40}|[\u4e00-\u9fff]{2,10})\s*[:=：]\s*\S/;
const CODE_STATEMENT_LINE_RE =
  /^\s*(?:import\s+|export\s+|const\s+|let\s+|var\s+|function\s+|return\b|if\s*\(|for\s*\(|while\s*\(|class\s+|def\s+|func\s+|pub\s+|use\s+|package\s+)/;

function countMatches(re, str, cap = Infinity) {
  re.lastIndex = 0;
  let count = 0;
  while (count < cap && re.exec(str) !== null) {
    count += 1;
  }
  return count;
}

function collectLexicalUnits(text) {
  const units = [];
  for (const m of text.matchAll(/[A-Za-z0-9_]{2,}/g)) {
    units.push(m[0].toLowerCase());
  }
  for (const m of text.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]+/g)) {
    const run = m[0];
    if (run.length === 1) {
      units.push(run);
    } else {
      for (let i = 0; i < run.length - 1; i += 1) {
        units.push(run.slice(i, i + 2));
      }
    }
  }
  return units;
}

/**
 * Compute a bounded-time `[0, 1]` technical information density score for prose.
 * Repetitive/verbose filler scores `< 0.35`; dense technical/decision/code prose scores `>= 0.55`.
 *
 * @param {string} text
 * @returns {number}
 */
export function computeProseDensity(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const sample = text.length > MAX_DENSITY_SCAN_CHARS ? text.slice(0, MAX_DENSITY_SCAN_CHARS) : text;
  if (!sample.trim()) return 0;

  const lexical = collectLexicalUnits(sample);
  const totalUnits = lexical.length;
  if (totalUnits === 0) return 0;
  const uniqueUnits = new Set(lexical);
  const rawUniqueRatio = uniqueUnits.size / totalUnits;

  // Penalize repeated lines / uniform padding blocks.
  const nonEmptyLines = sample.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let lineUniqueness = 1;
  if (nonEmptyLines.length >= 4) {
    const uniqueLineSet = new Set(nonEmptyLines);
    lineUniqueness = uniqueLineSet.size / nonEmptyLines.length;
  }
  const diversityScore = Math.min(1, Math.pow(rawUniqueRatio, 0.75)) * (lineUniqueness < 0.6 ? Math.max(0.15, lineUniqueness * 1.4) : 1);

  const pathCount = countMatches(PATH_SIGNAL_RE, sample);
  const urlCount = countMatches(URL_SIGNAL_RE, sample);
  const tickCount = countMatches(BACKTICK_SIGNAL_RE, sample);
  const flagCount = countMatches(CLI_FLAG_RE, sample);
  const versionMetricCount = countMatches(VERSION_OR_METRIC_RE, sample);
  const identCount = countMatches(CODE_IDENT_SIGNAL_RE, sample);
  const cueCount = countMatches(CONSTRAINT_DECISION_CUE_RE, sample);

  const weightedSignals =
    pathCount * 2.2 +
    urlCount * 2.0 +
    tickCount * 1.6 +
    flagCount * 1.6 +
    versionMetricCount * 1.1 +
    identCount * 1.2 +
    cueCount * 1.5;

  const nonWsChars = sample.replace(/\s+/g, '').length;
  const techSignalScore = Math.min(1, (weightedSignals * 18) / Math.max(120, nonWsChars));

  let structureHits = 0;
  let fenceActive = false;
  for (let i = 0; i < nonEmptyLines.length && i < 200; i += 1) {
    const line = nonEmptyLines[i];
    const lineHead = line.length > 512 ? line.slice(0, 512) : line;
    if (/^(?:```+|~~~+)/.test(lineHead)) {
      fenceActive = !fenceActive;
      structureHits += 2;
      continue;
    }
    if (fenceActive || STACK_FRAME_CONTINUATION_RE.test(lineHead) || STRONG_DIAGNOSTIC_RE.test(lineHead)) {
      structureHits += 1.5;
    } else if (STRUCTURED_KV_LINE_RE.test(lineHead)) {
      structureHits += 1.0;
    }
  }
  const structureBonus = Math.min(0.25, (structureHits / Math.max(4, Math.min(nonEmptyLines.length, 40))) * 0.25);

  const fillerCount = countMatches(FILLER_CUE_RE, sample);
  const fillerRate = (fillerCount * 85) / Math.max(120, nonWsChars);
  const repetitionPenalty = lineUniqueness < 0.5 ? (0.5 - lineUniqueness) * 0.4 : 0;
  const fillerPenalty = Math.min(0.32, fillerRate * 0.22 + repetitionPenalty);

  const raw = 0.35 * diversityScore + 0.45 * techSignalScore + structureBonus - fillerPenalty;
  const clamped = Math.max(0, Math.min(1, raw));
  return Math.round(clamped * 1000) / 1000;
}

function isSentenceBoundary(line, idx) {
  const ch = line[idx];
  if (ch === '。' || ch === '！' || ch === '？' || ch === '；') {
    return true;
  }
  if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== ';') return false;
  const next = idx + 1 < line.length ? line[idx + 1] : '';
  if (next && !/\s/.test(next)) return false;
  if (ch === '.') {
    if (idx > 0 && /\d/.test(line[idx - 1])) {
      // Keep numbered markers intact if anything slipped through, and protect trailing digits.
      const before = line.slice(Math.max(0, idx - 6), idx);
      if (/\bv?\d+(?:\.\d+)*$/.test(before)) return false;
    }
    const wordMatch = /([A-Za-z]+(?:\.[A-Za-z]+)*)$/.exec(line.slice(Math.max(0, idx - 16), idx));
    if (wordMatch) {
      const w = wordMatch[1].toLowerCase();
      if (w.length === 1 || PROSE_ABBREVIATIONS.has(w)) return false;
    }
  }
  return true;
}

function splitParagraphSentences(paragraph, deadlineMs = Infinity) {
  const trimmed = paragraph.trim();
  if (!trimmed) return [];
  const out = [];
  let start = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    if ((i & 4095) === 4095 && performance.now() > deadlineMs) break;
    if (isSentenceBoundary(trimmed, i)) {
      const seg = trimmed.slice(start, i + 1).trim();
      if (seg) out.push(seg);
      start = i + 1;
      while (start < trimmed.length && /\s/.test(trimmed[start])) start += 1;
      i = start - 1;
    }
  }
  if (start < trimmed.length) {
    const tail = trimmed.slice(start).trim();
    if (tail) out.push(tail);
  }
  return out;
}

function splitProseUnits(text, deadlineMs) {
  const rawLines = text.split(/\r?\n/);
  const units = [];
  let fenceLines = null;
  let fenceMarker = '';
  let paraLines = [];

  const flushParagraph = () => {
    if (paraLines.length === 0) return;
    const joined = paraLines.join(' ').replace(/\s+/g, ' ').trim();
    paraLines = [];
    if (!joined) return;
    for (const sentence of splitParagraphSentences(joined, deadlineMs)) {
      units.push({ index: units.length, kind: 'sentence', text: sentence });
    }
  };

  for (let i = 0; i < rawLines.length && i < MAX_PREVIEW_SCAN_LINES; i += 1) {
    if (performance.now() > deadlineMs) break;
    const line = rawLines[i];
    const trimmed = line.trim();
    const head512 = trimmed.length > 512 ? trimmed.slice(0, 512) : trimmed;

    if (fenceLines !== null) {
      fenceLines.push(line);
      const closeMatch = /^(```+|~~~+)\s*$/.exec(head512);
      if (closeMatch && closeMatch[1][0] === fenceMarker[0] && closeMatch[1].length >= fenceMarker.length) {
        units.push({ index: units.length, kind: 'fence', text: fenceLines.join('\n') });
        fenceLines = null;
        fenceMarker = '';
      }
      continue;
    }

    const openMatch = /^(```+|~~~+)/.exec(head512);
    if (openMatch) {
      flushParagraph();
      fenceLines = [line];
      fenceMarker = openMatch[1];
      continue;
    }

    if (!trimmed || (trimmed.length <= 128 && /^(?:[-*_]{3,}|={3,})$/.test(trimmed))) {
      flushParagraph();
      continue;
    }

    if (/^#{1,6}\s+\S/.test(head512) || (trimmed.length <= 96 && /^\*\*[^*\r\n]{2,80}\*\*:?\s*$/.test(trimmed))) {
      flushParagraph();
      units.push({ index: units.length, kind: 'heading', text: trimmed });
      continue;
    }

    if (/^(?:[-*+]|\d+[.)])\s+\S/.test(head512)) {
      flushParagraph();
      units.push({ index: units.length, kind: 'list', text: trimmed });
      continue;
    }

    if (
      STRUCTURED_KV_LINE_RE.test(head512) ||
      STRONG_DIAGNOSTIC_RE.test(head512) ||
      STACK_FRAME_CONTINUATION_RE.test(head512)
    ) {
      flushParagraph();
      units.push({ index: units.length, kind: 'structured', text: trimmed });
      continue;
    }

    paraLines.push(trimmed);
  }

  if (fenceLines !== null && fenceLines.length > 0) {
    units.push({ index: units.length, kind: 'fence', text: fenceLines.join('\n') });
  }
  flushParagraph();
  return units;
}

const QUERY_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'it', 'its',
  'this', 'that', 'these', 'those', 'we', 'you', 'he', 'she', 'they', 'i',
  'my', 'our', 'your', 'has', 'have', 'had', 'do', 'does', 'did',
  'into', 'about', 'over', 'after', 'before', 'between', 'through', 'during',
  'without', 'would', 'could', 'should', 'can', 'may', 'might', 'must', 'will',
  'not', 'no', 'all', 'any', 'some', 'more', 'most', 'other', 'such', 'only',
  'just', 'also', 'even', 'still', 'very', 'really', 'actually', 'then', 'than',
  'there', 'here', 'what', 'when', 'where', 'which', 'who', 'why', 'how',
]);

function normalizeQueryMatchList(queryTokens) {
  if (!Array.isArray(queryTokens) || queryTokens.length === 0) return [];
  const terms = new Map();
  const stoppable = new Set();
  const add = (term, weight, stopKey = term) => {
    if (!term) return;
    const prev = terms.get(term) ?? 0;
    if (weight > prev) terms.set(term, weight);
    if (QUERY_STOPWORDS.has(stopKey)) stoppable.add(term);
  };
  for (const raw of queryTokens) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (/^b([\u4e00-\u9fff\u3400-\u4dbf]{2})$/.test(t)) {
      add(t.slice(1), 2.5, '');
    } else if (/^c([\u4e00-\u9fff\u3400-\u4dbf])$/.test(t)) {
      add(t.slice(1), 0.75, '');
    } else if (/^a([a-z0-9][a-z0-9._:/-]+)$/.test(t)) {
      const bare = t.slice(1);
      add(bare, 2.4, bare);
      add(t, 2.2, bare);
    } else if (/^s([a-z]{3,})$/.test(t)) {
      const stem = t.slice(1);
      add(stem, 1.8, stem);
    } else {
      add(t, 2.4, t);
    }
  }
  const all = [...terms.entries()];
  const filtered = all.filter(([term]) => !stoppable.has(term));
  return filtered.length > 0 ? filtered : all;
}

function measureUnitQueryMatch(lower, queryEntries) {
  let score = 0;
  const matchedTerms = [];
  for (let i = 0; i < queryEntries.length; i += 1) {
    const [term, weight] = queryEntries[i];
    if (lower.includes(term)) {
      score += weight;
      matchedTerms.push(term);
    }
  }
  if (matchedTerms.length <= 1) {
    return { score, hits: matchedTerms.length };
  }
  // Collapse stem/surface duplicates (e.g. "connect" inside "connections") so 1 word counts as 1 hit.
  matchedTerms.sort((a, b) => b.length - a.length);
  const distinct = [];
  for (const t of matchedTerms) {
    if (!distinct.some((longer) => longer.includes(t))) {
      distinct.push(t);
    }
  }
  return { score, hits: distinct.length };
}

function unitTokenSet(text) {
  return new Set(collectLexicalUnits(text));
}

function isNearDuplicateUnit(candTokens, selectedSets, candNorm, selectedNorms) {
  if (selectedNorms.has(candNorm)) return true;
  if (candTokens.size < 4) return false;
  for (const existing of selectedSets) {
    if (existing.size < 4) continue;
    let inter = 0;
    for (const tok of candTokens) {
      if (existing.has(tok)) inter += 1;
    }
    const union = candTokens.size + existing.size - inter;
    if (union > 0 && inter / union >= 0.78) return true;
  }
  return false;
}

function scoreProseUnits(units, queryEntries, deadlineMs) {
  let maxHeadingQueryScore = 0;
  if (queryEntries.length > 0) {
    for (let i = 0; i < units.length; i += 1) {
      if ((i & 63) === 63 && performance.now() > deadlineMs) break;
      const unit = units[i];
      if (unit.kind !== 'heading') continue;
      const scanText = unit.text.length > 4096 ? unit.text.slice(0, 4096) : unit.text;
      const { score: qScore } = measureUnitQueryMatch(scanText.toLowerCase(), queryEntries);
      if (qScore > maxHeadingQueryScore) maxHeadingQueryScore = qScore;
    }
  }

  let activeHeadingBoost = 0;
  let itemsUnderHeading = 0;

  for (let i = 0; i < units.length; i += 1) {
    if (performance.now() > deadlineMs) break;
    const unit = units[i];
    const text = unit.text;
    const scanText = text.length > 4096 ? text.slice(0, 4096) : text;
    const head512 = text.length > 512 ? text.slice(0, 512) : text;
    const lower = scanText.toLowerCase();

    const { score: queryScore, hits: queryHits } = measureUnitQueryMatch(lower, queryEntries);

    if (unit.kind === 'heading') {
      const hasHeadingCue = HEADING_CUE_RE.test(head512);
      const headingGatePass =
        queryEntries.length === 0 ||
        maxHeadingQueryScore <= 0 ||
        queryScore >= maxHeadingQueryScore * 0.6 ||
        queryHits >= 2;
      activeHeadingBoost = headingGatePass
        ? 0.75 + (queryScore > 0 ? 1.1 : 0) + (hasHeadingCue ? 0.9 : 0)
        : 0;
      itemsUnderHeading = 0;
      unit.score = 0.6 + queryScore + (hasHeadingCue ? 1.0 : 0);
      continue;
    }

    const headingBoost =
      activeHeadingBoost > 0 && itemsUnderHeading < 6
        ? activeHeadingBoost * (itemsUnderHeading < 3 ? 1.0 : 0.55)
        : 0;
    if (activeHeadingBoost > 0) itemsUnderHeading += 1;

    const pathHits = countMatches(PATH_SIGNAL_RE, scanText, 2);
    const urlHits = countMatches(URL_SIGNAL_RE, scanText, 2);
    const tickHits = countMatches(BACKTICK_SIGNAL_RE, scanText, 2);
    const flagHits = countMatches(CLI_FLAG_RE, scanText, 2);
    const verHits = countMatches(VERSION_OR_METRIC_RE, scanText, 2);
    const identHits = countMatches(CODE_IDENT_SIGNAL_RE, scanText, 2);
    const cueHits = countMatches(CONSTRAINT_DECISION_CUE_RE, scanText, 2);
    const fillerHits = countMatches(FILLER_CUE_RE, scanText, 2);

    let score =
      queryScore +
      headingBoost +
      pathHits * 1.4 +
      urlHits * 1.3 +
      tickHits * 0.9 +
      flagHits * 0.9 +
      verHits * 0.75 +
      identHits * 0.7 +
      cueHits * 1.45 -
      fillerHits * 1.2;

    if (unit.kind === 'fence') score += 1.25;
    else if (unit.kind === 'structured') score += 1.15;
    else if (unit.kind === 'list') score += 0.35;

    if (STRONG_DIAGNOSTIC_RE.test(head512)) score += 1.8;
    if (text.length <= 16 && /^(?:\(none\)|none|ok|done|n\/a)\.?$/i.test(text.trim())) score -= 4.0;
    else if (fillerHits === 0 && codePointLength(scanText) >= 12) score += 0.05;
    if (codePointLength(scanText) < 12 && queryScore === 0 && cueHits === 0 && pathHits === 0 && verHits === 0) {
      score -= 0.8;
    }

    unit.score = score;
  }
}

/**
 * Extract highest-salience prose units strictly within `budgetChars` (code points)
 * and `deadlineMs`, preserving original document order and decimal/abbreviation/code-fence integrity.
 *
 * @param {string} text
 * @param {{ budgetChars?: number, queryTokens?: readonly string[], deadlineMs?: number }} [options]
 * @returns {string}
 */
export function extractSalientProse(text, { budgetChars = 900, queryTokens = [], deadlineMs } = {}) {
  if (typeof text !== 'string' || text.length === 0) return '';
  if (!Number.isFinite(budgetChars) || budgetChars <= 0) return '';
  const budget = Math.floor(budgetChars);
  const deadline = Number.isFinite(deadlineMs) ? deadlineMs : performance.now() + MAX_PREVIEW_MS;

  const bounded = text.length > MAX_PREVIEW_SCAN_BYTES ? text.slice(0, MAX_PREVIEW_SCAN_BYTES) : text;
  const units = splitProseUnits(bounded, deadline);
  if (units.length === 0) return '';

  const queryEntries = normalizeQueryMatchList(queryTokens);
  scoreProseUnits(units, queryEntries, deadline);

  const ranked = units
    .filter((u) => typeof u.score === 'number')
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));

  const selected = [];
  const selectedSets = [];
  const selectedNorms = new Set();
  let usedChars = 0;

  for (const unit of ranked) {
    if (performance.now() > deadline) break;
    if (unit.score <= 0) continue;
    const norm = unit.text.toLowerCase().replace(/\s+/g, ' ').trim();
    const tokSet = unitTokenSet(unit.text);
    if (isNearDuplicateUnit(tokSet, selectedSets, norm, selectedNorms)) continue;

    const unitLen = codePointLength(unit.text);
    const sepLen = selected.length > 0 ? 1 : 0;
    if (usedChars + sepLen + unitLen <= budget) {
      selected.push(unit);
      selectedSets.push(tokSet);
      selectedNorms.add(norm);
      usedChars += sepLen + unitLen;
    } else if (unit.score >= 3.0) {
      const rem = budget - usedChars - sepLen;
      if (rem >= 72) {
        const truncated = clipSingleLine(unit.text, rem);
        const truncLen = codePointLength(truncated);
        if (truncLen > 0 && usedChars + sepLen + truncLen <= budget) {
          selected.push({ ...unit, text: truncated });
          selectedSets.push(tokSet);
          selectedNorms.add(norm);
          usedChars += sepLen + truncLen;
        }
      }
    }
  }

  if (selected.length === 0 && ranked.length > 0) {
    const best = ranked[0];
    if (best.score > 0 || units.length > 0) {
      return clipSingleLine(best.text.replace(/\s+/g, ' ').trim(), budget);
    }
    return '';
  }

  selected.sort((a, b) => a.index - b.index);
  return selected.map((u) => u.text).join('\n');
}

function trySalientProsePreview(text, scanLimit, truncatedScan, safeHead, safeTail, toolName, target, deadlineMs) {
  const totalBudget = safeHead + safeTail;
  const bounded = scanLimit < text.length ? text.slice(0, scanLimit) : text;
  if (bounded.length < 1200) return null;

  const { lines, timedOut } = scanLinesBounded(text, scanLimit, deadlineMs);
  if (timedOut || lines.length === 0) return null;

  // Preserve fail-open `null` behavior on line-numbered code dumps, code files, and single-line minified blobs.
  if (detectLineNumberPrefix(text, lines)) return null;
  if (resolveCodeFamily(toolName, target) !== null) return null;
  if (lines.length < 4 && bounded.length >= 1200) {
    const sentences = splitParagraphSentences(bounded, deadlineMs);
    if (sentences.length < 6) return null;
  }

  let nonEmptyCount = 0;
  let codeLikeCount = 0;
  let inFence = false;
  for (let i = 0; i < lines.length && i < 300; i += 1) {
    const line = text.slice(lines[i].start, Math.min(lines[i].end, lines[i].start + 256)).trim();
    if (!line) continue;
    nonEmptyCount += 1;
    if (/^(?:```+|~~~+)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    const lastCh = line[line.length - 1];
    if (!inFence && (CODE_STATEMENT_LINE_RE.test(line) || lastCh === '{' || lastCh === '}' || lastCh === ';')) {
      codeLikeCount += 1;
    }
  }
  if (nonEmptyCount > 0 && codeLikeCount / nonEmptyCount > 0.45) return null;

  const units = splitProseUnits(bounded, deadlineMs);
  if (units.length < 6) return null;
  if (performance.now() > deadlineMs) return null;

  scoreProseUnits(units, [], deadlineMs);
  const scores = units.map((u) => u.score ?? 0).sort((a, b) => a - b);
  const uniqueNorms = new Set(units.map((u) => u.text.toLowerCase().replace(/\s+/g, ' ').trim()));
  if (uniqueNorms.size < 4) return null;

  const midIdx = Math.floor(scores.length / 2);
  const median = scores.length % 2 === 1 ? scores[midIdx] : (scores[midIdx - 1] + scores[midIdx]) / 2;
  const topKCount = Math.min(3, Math.max(1, Math.ceil(scores.length * 0.2)));
  let topSum = 0;
  for (let i = 0; i < topKCount; i += 1) {
    topSum += scores[scores.length - 1 - i];
  }
  const topMean = topSum / topKCount;

  if (topMean < 1.5 || topMean < median * 1.4) return null;

  const middle = extractSalientProse(bounded, { budgetChars: totalBudget, deadlineMs });
  if (!middle) return null;
  const keptChars = codePointLength(middle);
  if (keptChars === 0 || keptChars > totalBudget || keptChars >= codePointLength(bounded)) return null;

  return { kind: 'salient-prose', head: '', middle, tail: '', keptChars, truncatedScan };
}

/**
 * Build a high-entropy preview for oversized non-error tool output strictly
 * within `headChars + tailChars`. Returns `null` when no tier matches, times out,
 * or lacks enough signal so callers fail open to standard head/tail slicing.
 *
 * @param {string} text
 * @param {{ headChars?: number, tailChars?: number, toolName?: string, target?: string }} [options]
 * @returns {{ kind: 'diagnostic'|'code-skeleton'|'json-outline'|'salient-prose', head: string, middle: string, tail: string, keptChars: number, truncatedScan: boolean } | null}
 */
export function buildToolPreview(text, options = {}) {
  try {
    if (typeof text !== 'string' || text.length === 0) return null;
    const safeHead =
      Number.isFinite(options?.headChars) && options.headChars > 0 ? Math.floor(options.headChars) : 0;
    const safeTail =
      Number.isFinite(options?.tailChars) && options.tailChars > 0 ? Math.floor(options.tailChars) : 0;
    if (safeHead + safeTail < MIN_TOTAL_BUDGET) return null;

    const deadlineMs = performance.now() + MAX_PREVIEW_MS;
    const isLarge =
      text.length > LARGE_PREVIEW_INPUT_BYTES ||
      Buffer.byteLength(text, 'utf8') > LARGE_PREVIEW_INPUT_BYTES;
    let scanLimit = text.length;
    if (isLarge && scanLimit > MAX_PREVIEW_SCAN_BYTES) {
      const lastNl = text.lastIndexOf('\n', MAX_PREVIEW_SCAN_BYTES);
      if (lastNl > 0) {
        scanLimit = lastNl + 1;
      } else {
        scanLimit = MAX_PREVIEW_SCAN_BYTES;
        if (
          scanLimit > 0 &&
          scanLimit < text.length &&
          text.charCodeAt(scanLimit - 1) >= 0xd800 &&
          text.charCodeAt(scanLimit - 1) <= 0xdbff
        ) {
          scanLimit -= 1;
        }
      }
    }
    const truncatedScan = scanLimit < text.length;

    const diag = tryDiagnosticPreview(text, scanLimit, truncatedScan, safeHead, safeTail, deadlineMs);
    if (diag) return diag;

    if (performance.now() <= deadlineMs) {
      const skeleton = tryCodeSkeletonPreview(
        text,
        scanLimit,
        truncatedScan,
        safeHead,
        safeTail,
        options?.toolName ?? '',
        options?.target ?? '',
        deadlineMs,
      );
      if (skeleton) return skeleton;
    }

    if (performance.now() <= deadlineMs) {
      const jsonOutline = tryJsonOutlinePreview(text, safeHead, safeTail);
      if (jsonOutline) return jsonOutline;
    }

    if (performance.now() <= deadlineMs) {
      const salient = trySalientProsePreview(
        text,
        scanLimit,
        truncatedScan,
        safeHead,
        safeTail,
        options?.toolName ?? '',
        options?.target ?? '',
        deadlineMs,
      );
      if (salient) return salient;
    }

    return null;
  } catch {
    return null;
  }
}
