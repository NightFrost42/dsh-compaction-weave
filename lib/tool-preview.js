// Pure, zero-dependency, latency-guarded high-entropy preview extractor for
// oversized non-error tool outputs. Reallocates existing head/tail budgets
// across three deterministic priority tiers without ever emitting charOffset:
//   Tier 1 (diagnostic): mid-text error/traceback/compiler clusters with [L<n>]
//   Tier 2 (code-skeleton): extension-allowlisted declaration skeleton with [L<n>]
//   Tier 3 (json-outline): <= 160 KiB shallow 2-level JSON object/array outline

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
  /(?:(?:^|[\s([{"'`])(?:[A-Za-z_][A-Za-z0-9_]*Error|Exception):\s+\S|\b(?:AssertionError|Traceback \(most recent call last\)|Caused by:)|^\s*Traceback\b|[^\s:]+\.[A-Za-z0-9]{1,8}:\d+(?::\d+)?:\s*(?:fatal\s+)?error\b|[^\s(]+\(\d+,\d+\):\s*error\b|\berror\[[A-Z]\d+\]:|\bpanicked at\s)/;
const GENERAL_DIAGNOSTIC_RE =
  /(?:^|\s)(?:FAIL |FAILED\b|panic:\s*\S|ERR!\s*\S|FATAL\b|ERROR:\s+\S)/;
const BENIGN_ZERO_DIAGNOSTIC_RE =
  /(?:\b0+\s+(?:failed|errors?|failures?|warnings?)\b|\b(?:failed|errors?|failures?)\s*[:=]\s*0+\b)/i;

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
    if (!isDiagnosticLine(rawLine)) continue;

    const last = clusters[clusters.length - 1];
    if (last && line.lineNo - lines[last.matchIndices[last.matchIndices.length - 1]].lineNo <= 3) {
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
  if (typeof target !== 'string' || !target.trim()) return null;
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

/**
 * Build a high-entropy preview for oversized non-error tool output strictly
 * within `headChars + tailChars`. Returns `null` when no tier matches, times out,
 * or lacks enough signal so callers fail open to standard head/tail slicing.
 *
 * @param {string} text
 * @param {{ headChars?: number, tailChars?: number, toolName?: string, target?: string }} [options]
 * @returns {{ kind: 'diagnostic'|'code-skeleton'|'json-outline', head: string, middle: string, tail: string, keptChars: number, truncatedScan: boolean } | null}
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

    return null;
  } catch {
    return null;
  }
}
