// Domain-agnostic constraint, polarity, numeric/condition, and provenance auditor.
// Zero LLM calls; operates on summaryProse() so verbatim Section 6 cannot mask prose reversals.

import { summaryProse } from './validate.js';
import { actionState, sameAction } from './action-state.js';
import { isReferenceContextKind } from './source-provenance.js';
import { instructionText, referenceTexts } from './instruction-source.js';

const CN_MODAL = /不允许|不应(?:当|该)?|不(?=修改|删除|运行|调用|安装|部署|上传|下载|发送|联网|覆盖|发布|写入|写库|重启|终止|降低|改)|必须|不要(?!求)|不能|不得|禁止|记得|务必|只能|一定要|(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人)|需要|请|注意|不可|无需|不准|严禁|勿|只有|仅当|如果|除非/;
const EN_MODAL = /\b(?:must|never|always|only|ensure|remember|required|forbidden|avoid|should|please|unless|if|when)\b|\bdo not\b|\bdon't\b/;
const COMMAND = /^(?:you\s+)?(?:use|run|keep|retain|preserve|delete|remove|restart|deploy|copy|move|sync|transfer|output|format)\b|^(?:保留|删除|运行|使用|发布|重启|复制|输出|跑\s)/;
const LABEL = /^(?:output(?:\s+format)?|format|port|timeout|retention|limit|输出格式|输出|端口|超时|保留时间|限制)\s*[:：]/;

const NEGATION =
  /不允许|不应(?:当|该)?|不要(?!求)|不能|不得|不必|不用|禁止|(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人)|无需|不可|不准|严禁|勿|没有|尚未|并未|未曾|不(?:实际|直接|擅自)|不(?![同仅但过论管断少足安便光止久妨料然如至]|得不)(?=[\u4e00-\u9fff])|未(?=执行|运行|调用|修改|删除|写入|安装|重启|强停|改|降|提|kill|restart|append)|\b(?:must not|do not|don't|never|forbidden|avoid|no|not)\b/g;

const CJK_RUN = /[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g;
const CONDITIONAL_PREFIX_RE =
  /^(?:>\s*)*(?:(?:说明|注意|另外|后续|以后|其实|因此|当前)[^,，。；;\n]{0,12}?)?(?:(only\s+)?(if|when|unless)\s+(.+?)|(只有当|只有|仅当|如果|倘若|假如|除非|若|当)(.+?))[,，]\s*(.+)$/i;
const CONDITIONAL_SUFFIX_RE =
  /^(?:>\s*)*(?:only\s+)?(.+?)\s+(?:only\s+)?(if|when|unless)\s+([^.,;!?\n]+)[.!?;]*$/i;

const CODE_SPLIT_MASK = (text, literals) =>
  String(text ?? '').replace(
    /`+[^`\n]*`+|(?:[a-z]:[/\\]|https?:\/\/)[^\s`，。；（）]*[^\s`，。；（）.!?]|(?<![\w.])\d+(?:[.,]\d+)+(?![\w.])|\b[a-z_]\w*(?:\.[a-z0-9_-]+)+\b/gi,
    (part) => {
      literals.push(part);
      return `\uE000${literals.length - 1}\uE001`;
    },
  );

function unmask(text, literals) {
  return text.replace(/\uE000(\d+)\uE001/g, (_, idx) => literals[Number(idx)] ?? '');
}

function proseOnly(text) {
  return String(text ?? '')
    .replace(/`+[^`\n]*`+/g, (value) => {
      const inner = value.replace(/^`+|`+$/g, '');
      return /^(?:do not |must |never |always |不要(?!求)|必须|不能)/i.test(inner) ? inner : ' ';
    })
    .replace(/--[a-z][\w-]*|\bnot\s+null\b/gi, ' ');
}

function normalize(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function negationsOf(line) {
  const text = proseOnly(line).toLowerCase();
  return [...new Set([...text.matchAll(NEGATION)].map((m) => m[0]))];
}

const DOUBLE_NEGATION_RE =
  /(?:不要|不能|不得|不可|切勿|严禁|(?<![分区识个特级差类性鉴告离甄辨判派])别)\s*(?:不(?![同仅但过论管断少足安便光止久妨料然如至])|没(?:有)?|未)|不得不|\b(?:do\s+not|don't|must\s+not|never|cannot|can't)\s+(?:avoid\s+\w+ing\b|not\b|fail\s+to\b)/i;

function ruleNegative(line) {
  const text = proseOnly(line).toLowerCase();
  if (DOUBLE_NEGATION_RE.test(text)) return false;
  return negationsOf(line).length > 0;
}

const UNIT_NORM = new Map([
  ['s', 's'], ['sec', 's'], ['second', 's'], ['seconds', 's'], ['秒', 's'],
  ['ms', 'ms'], ['毫秒', 'ms'],
  ['m', 'min'], ['min', 'min'], ['minute', 'min'], ['minutes', 'min'], ['分', 'min'], ['分钟', 'min'],
  ['h', 'h'], ['hour', 'h'], ['hours', 'h'], ['小时', 'h'],
  ['d', 'd'], ['day', 'd'], ['days', 'd'], ['天', 'd'],
  ['b', 'b'], ['byte', 'b'], ['bytes', 'b'], ['字节', 'b'],
  ['kb', 'kb'], ['kib', 'kib'], ['mb', 'mb'], ['mib', 'mib'], ['g', 'gb'], ['gb', 'gb'], ['gib', 'gib'], ['tb', 'tb'],
  ['%', '%'],
]);

const SIZE_CONTEXT_RE =
  /(?:内存|显存|硬盘|磁盘|存储|空间|容量|体积|大小|上限|下限|配额|限额|限制|缓存|备份|文件|日志|带宽|流量|最大|最小|至少|不超过|小于|大于|低于|高于|\b(?:ram|vram|mem(?:ory)?|disk|storage|space|size|cap(?:acity)?|limit|quota|backup|cache|buffer|heap|max|min|at\s+least|at\s+most|under|over|below|above)\b)/i;

function isNonQuantityTechTerm(numText, space, rawUnit, contextText) {
  if (space || !rawUnit) return false;
  // Compact uppercase single-letter duration symbols (e.g. 3D, 2D, 3M, 6S, 2H) are tech terms, not durations.
  if (/^[DSMH]$/.test(rawUnit)) return true;
  // Bare "5G" without storage/memory/quota context is typically the telecom/WiFi term rather than 5GB.
  if (rawUnit === 'G' && numText === '5' && !SIZE_CONTEXT_RE.test(contextText)) return true;
  return false;
}

function unitFamily(rawUnit) {
  const u = UNIT_NORM.get(String(rawUnit ?? '').toLowerCase()) ?? String(rawUnit ?? '').toLowerCase();
  if (['ms', 's', 'min', 'h', 'd'].includes(u)) return { family: 'duration', unit: u };
  if (['b', 'kb', 'kib', 'mb', 'mib', 'gb', 'gib', 'tb'].includes(u)) return { family: 'size', unit: u };
  return { family: u ? 'unit' : 'scalar', unit: u };
}

/** Parse simple `<subject> [= | 改为 | must be | ...] <number><unit?>` scalar assignments. */
export function scalarRequirement(text) {
  const raw = String(text ?? '').trim();
  if (!raw || raw.length > 512) return null;
  let value = raw
    .replace(/^(?:当前|目前|现行(?:有效)?|仍生效的?)(?:\s*[:：]\s*)?/, '')
    .replace(/[。.!！?？;；，,]+$/, '');
  if (!value || value.length > 256) return null;
  if (/[`"'“”‘’「」『』<>{}[\]/\\]|如果|除非|只有|仅当|否则|或者|要么|(?:^|[，,])\s*(?:若|当)/.test(value)) return null;
  value = value.replace(/[，,]\s*(?:替代|取代)(?:先前|原先|之前|此前|旧的)?\s*-?\d+(?:\.\d+)?[^\n。；;]*$/, '').trim();
  const match =
    /^(.{1,80}?)\s*(必须为|设为|设置为|保持(?:为)?|改为|改成|是|为|[:=：]|\bmust\s+be|\bis|\bset\s+to)?\s*(-?\d+(?:\.\d+)?)(\s*)(ms|s|sec|seconds?|m|min|minutes?|h|hours?|d|days?|gb|gib|mb|mib|kb|kib|tb|bytes?|b|g|%|毫秒|秒|分钟?|小时|天|字节|个|次|条)?$/i.exec(
      value,
    );
  if (!match) return null;
  const rawSubject = match[1];
  const explicitOp = Boolean(match[2]);
  const rawUnit = match[5] ?? '';
  if (isNonQuantityTechTerm(match[3], match[4], rawUnit, value)) return null;
  if (!explicitOp && !rawUnit) return null;
  const hasLeadingSpace = !explicitOp && (/\s$/.test(rawSubject) || /\s(?=-?\d)/.test(value.slice(rawSubject.length)));
  if (!explicitOp && !hasLeadingSpace && /[a-z0-9_.-]$/i.test(rawSubject)) return null;
  const subject = normalize(rawSubject).replace(/\s+/g, ' ');
  const num = Number(match[3]);
  if (!subject || !Number.isFinite(num)) return null;
  const normalizedNum = /^-?\d+$/.test(match[3]) && !Number.isSafeInteger(num) ? match[3] : num;
  const { family, unit } = unitFamily(rawUnit);
  return { subject, family, value: normalizedNum, unit };
}

function tokens(text) {
  return normalize(text)
    .split(/[\s,.;:!?()[\]{}"'`/\\|<>+=*&^%$#@~，。、；：！？（）【】《》「」『』“”]+/)
    .filter((token) => token.length > 0);
}

/**
 * Tokenize for constraint coverage checks: keep `tokens()` intact for
 * descriptor matching while splitting unpunctuated CJK runs (>= 3 chars)
 * into overlapping 2-char bigrams.
 */
const coverageTokenCache = new Map();
const ASCII_TOKEN_RE = /^[a-zA-Z0-9_]+$/;
const ASCII_WORD_RUN_RE = /[a-zA-Z0-9_]+/g;
const asciiWordCache = new Map();

function coverageTokens(text) {
  const key = String(text ?? '');
  const cached = coverageTokenCache.get(key);
  if (cached) return cached;
  const base = tokens(key);
  const out = [];
  for (const token of base) {
    let last = 0;
    let expanded = false;
    for (const match of token.matchAll(CJK_RUN)) {
      const run = match[0];
      if (run.length < 3) continue;
      expanded = true;
      if (match.index > last) out.push(token.slice(last, match.index));
      for (let i = 0; i < run.length - 1; i += 1) {
        out.push(run.slice(i, i + 2));
      }
      last = match.index + run.length;
    }
    if (!expanded) out.push(token);
    else if (last < token.length) out.push(token.slice(last));
  }
  if (coverageTokenCache.size >= 1024) coverageTokenCache.clear();
  const frozen = Object.freeze(out);
  coverageTokenCache.set(key, frozen);
  return frozen;
}

function asciiWordsOf(text) {
  let words = asciiWordCache.get(text);
  if (!words) {
    if (asciiWordCache.size >= 512) asciiWordCache.clear();
    const matches = text.match(ASCII_WORD_RUN_RE);
    words = matches ? new Set(matches.map((w) => w.toLowerCase())) : new Set();
    asciiWordCache.set(text, words);
  }
  return words;
}

export function coverageOf(line, summaryNormalized) {
  const haystack = String(summaryNormalized ?? '');
  const parts = coverageTokens(line);
  if (parts.length === 0) return 1;
  const seen = new Map();
  let asciiWords = null;
  let hit = 0;
  for (const token of parts) {
    let matched = seen.get(token);
    if (matched === undefined) {
      if (ASCII_TOKEN_RE.test(token)) {
        asciiWords ??= asciiWordsOf(haystack);
        matched = asciiWords.has(token.toLowerCase());
      } else {
        matched = haystack.includes(token);
      }
      seen.set(token, matched);
    }
    if (matched) hit += 1;
  }
  return hit / parts.length;
}

export function sourceEvidenceSentences(text) {
  const literals = [];
  const masked = CODE_SPLIT_MASK(text, literals);
  const out = [];
  for (const line of masked.split(/\r?\n/)) {
    const strippedLine = line.replace(/^\s*(?:\d+[.)](?=\s)|\(\d+\)\s+|[-*•+]\s+)/, '');
    if (!strippedLine.trim()) continue;
    const parts = strippedLine.match(/[^.!?。！？；;]+[.!?。！？；;]*|[^.!?。！？；;]+$/g) ?? [strippedLine];
    for (const part of parts) {
      const restored = unmask(part, literals);
      if (restored.trim()) out.push(restored);
    }
  }
  return out;
}

function isInstructionLine(line) {
  const raw = String(line ?? '').trim();
  const lower = normalize(raw);
  if (!lower) return false;
  if (/^\s*#{1,6}\s/.test(lower)) return false;
  if (/^\s*why\b[^.!\n]*[?？]\s*$/i.test(raw)) return false;
  const whyMatch = /(?:为什么|为何)[^。！!\n]*[?？]\s*$/.exec(raw);
  if (whyMatch) {
    const preWhy = normalize(raw.slice(0, whyMatch.index).replace(/[，,;；:：\s]+$/, ''));
    if (
      !preWhy ||
      (!CN_MODAL.test(preWhy) &&
        !EN_MODAL.test(preWhy) &&
        !COMMAND.test(preWhy) &&
        !LABEL.test(preWhy) &&
        scalarRequirement(preWhy) === null)
    ) {
      return false;
    }
  }
  return CN_MODAL.test(lower) || EN_MODAL.test(lower) || COMMAND.test(lower) || LABEL.test(lower) || scalarRequirement(line) !== null;
}

const SEQ_CITATION_RE =
  /(?:\[\s*seqs?\s+\d+(?:\s*[-–,]\s*\d+)*\s*\]|[（(]\s*seqs?\s+\d+(?:\s*[-–,]\s*\d+)*\s*[)）]|\bseqs?\s*#?\s*\d+(?:\s*[-–,]\s*\d+)*\b|\bseqs?\s*[=:]\s*\d+\b|\bphase\s*#?\d+\b|>\s*user source\s*\(seq\s+\d+\),\s*verbatim:)/gi;

const stripSeqCitations = (text) => String(text ?? '').replace(SEQ_CITATION_RE, ' ');

function numericFacts(text) {
  const out = [];
  const cleaned = stripSeqCitations(text);
  const value = cleaned.replace(/(?<!\d)\d{1,3}(?:,\d{3})+(?!\d)/g, (m) => m.replaceAll(',', ''));
  const re =
    /(?<![a-z0-9_-]|[a-z0-9]\.)(-?\d+(?:\.\d+)?)(\s*)(ms|s|sec|seconds?|m|min|minutes?|h|hours?|d|days?|gb|gib|mb|mib|kb|kib|tb|bytes?|b|g|%|毫秒|秒|分钟?|小时|天|字节)?(?![a-z0-9_-]|\.[a-z0-9])/gi;
  for (const m of value.matchAll(re)) {
    const rawUnit = m[3] ?? '';
    if (isNonQuantityTechTerm(m[1], m[2], rawUnit, value)) continue;
    const num = Number(m[1]);
    if (!Number.isFinite(num)) continue;
    const { unit } = unitFamily(rawUnit);
    out.push(`${num}${unit}`);
  }
  for (const m of cleaned.matchAll(/(?<![a-z0-9_./-])([a-z0-9_./-]{1,120}\.[a-z]{1,6}):(\d+(?:-\d+)?)/gi)) {
    out.push(`loc:${m[1].toLowerCase()}:${m[2]}`);
  }
  return out;
}

export function extractConstraintLines(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const raw of sourceEvidenceSentences(text)) {
    const sentence = raw.trim();
    if (!isInstructionLine(sentence)) continue;
    if (seen.has(sentence)) continue;
    seen.add(sentence);
    out.push(sentence);
  }
  return out;
}

export function sourceConstraintEvidence(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => extractConstraintLines(line).length > 0)
    .flatMap((line) => sourceEvidenceSentences(line))
    .filter((raw) => {
      const sentence = raw.trim();
      return isInstructionLine(sentence) || numericFacts(sentence).length > 0;
    });
}

function splitContrastClauses(text) {
  const out = [];
  for (const sentence of sourceEvidenceSentences(text)) {
    if (/^\s*#{1,6}\s/.test(sentence)) continue;
    if (conditionParts(sentence)) {
      out.push(sentence);
      continue;
    }
    const literals = [];
    const masked = CODE_SPLIT_MASK(sentence, literals);
    const parts = masked
      .split(/(?<=[」』])\s*(?:(?:与|和|及|以及|、|\band\b)\s*)?(?=[「『])|(?:(?<!\d),|,(?!\d)|，)\s*(?:(?:但是?|不过|然而|but)\s+)?/i);
    for (const part of parts) {
      const clean = unmask(part, literals).trim();
      if (clean) out.push(clean);
    }
  }
  return out;
}

const LOWER_BOUND_RE = /\b(?:at\s+least|minimum|no\s+fewer\s+than|no\s+less\s+than)\b|>=|至少|最少|不少于|不低于/i;
const UPPER_BOUND_RE = /\b(?:at\s+most|maximum|no\s+more\s+than|up\s+to)\b|<=|最多|至多|不超过|不高于/i;

const TRANSFER_VERB_RE = /\b(?:copy(?:ing)?|sync(?:ing)?|mov(?:e|ing)|migrat(?:e|ing)|transfer(?:ring)?|replicat(?:e|ing))\b/i;

function allTransferPairs(text) {
  const value = String(text ?? '');
  const found = [];
  if (TRANSFER_VERB_RE.test(value)) {
    for (const m of value.matchAll(
      /\bfrom\s+([a-z0-9_]+(?:[.-][a-z0-9_]+)*)\s+(?:to|into)\s+([a-z0-9_]+(?:[.-][a-z0-9_]+)*)/gi,
    )) {
      found.push({ idx: m.index, pair: [m[1].toLowerCase(), m[2].toLowerCase()] });
    }
    for (const m of value.matchAll(
      /\b(?:copy(?:ing)?|sync(?:ing)?|mov(?:e|ing)|migrat(?:e|ing)|transfer(?:ring)?|replicat(?:e|ing))\s+(?!from\b)([a-z0-9_]+(?:[.-][a-z0-9_]+)*)\s+(?:to|into)\s+([a-z0-9_]+(?:[.-][a-z0-9_]+)*)/gi,
    )) {
      found.push({ idx: m.index, pair: [m[1].toLowerCase(), m[2].toLowerCase()] });
    }
  }
  for (const m of value.matchAll(
    /(?:把|将)\s*([^\s，。；,.;]{1,24}?)\s*(?:复制|同步|迁移|移动|拷贝|导入)(?:到|至|进)\s*([^\s，。；,.;。！!？?]{1,24})/gu,
  )) {
    found.push({ idx: m.index, pair: [m[1].trim().toLowerCase(), m[2].trim().toLowerCase()] });
  }
  for (const m of value.matchAll(
    /从\s*([^\s，。；,.;]{1,24}?)\s*(?:复制|同步|迁移|移动|拷贝)(?:到|至)\s*([^\s，。；,.;。！!？?]{1,24})/gu,
  )) {
    found.push({ idx: m.index, pair: [m[1].trim().toLowerCase(), m[2].trim().toLowerCase()] });
  }
  found.sort((a, b) => a.idx - b.idx);
  return found.map((item) => item.pair);
}

const EXCEPTION_RE =
  /\b(?:except(?:\s+for)?|excluding|other\s+than|aside\s+from|but\s+not|not\s+including)\s+([^.,;!?\n]{1,80})|除(?:了)?\s*([^，。；！!？?\s][^，。；！!？?\n]{0,80}?)\s*(?:以外|之外|外)|(?:不含|不包括|不包含)\s*([^，。；！!？?\s][^，。；！!？?\n]{0,80})/i;

function exceptionTarget(text) {
  const m = EXCEPTION_RE.exec(text);
  return m ? normalize(m[1] ?? m[2] ?? m[3]) : null;
}

const stripException = (text) => String(text ?? '').replace(EXCEPTION_RE, '').trim() || text;

function scopesCompatible(a, b) {
  const scopeSet = (s) =>
    new Set([
      ...[...String(s).matchAll(/\b(?:production|staging|development|test)\b|生产|测试|预发布/gi)].map((m) => m[0].toLowerCase()),
      ...[...String(s).matchAll(/(?:服务器|第|阶段|轮|批|步)\s*\d+/g)].map((m) => m[0].replace(/\s+/g, '')),
      ...[...String(s).matchAll(/\b(?:phase|stage|round|cycle|batch|step|turn|iteration)\s*#?\d+\b/gi)].map((m) =>
        m[0].toLowerCase().replace(/[\s#]+/g, ''),
      ),
    ]);
  const sa = scopeSet(a);
  const sb = scopeSet(b);
  for (const k of sa) {
    if (sb.size > 0 && !sb.has(k)) return false;
  }
  for (const k of sb) {
    if (sa.size > 0 && !sa.has(k)) return false;
  }
  return true;
}

const NEGATED_PRIVATIVE = /(?:不要|不能|不得|不可|禁止|切勿|严禁|免于|避免|\bdo\s+not\b|\bdon't\b|\bmust\s+not\b|\bnever\b|\bavoid\b)[^。！？；;\n]{0,80}?(?:漏掉|遗漏|漏记|丢失|丢掉|丢弃|省略|略过|忽略|跳过|忘掉|删掉|删除|\bomit\b|\bdrop\b|\bskip\b|\bmiss\b|\bignore\b|\bforget\b|\bdelete\b|\bdiscard\b)/iu;
const BARE_PRIVATIVE = /(?:漏掉|遗漏|漏记|丢失|丢掉|丢弃|省略|略过|跳过|删掉|删除|\bomit\b|\bdrop\b|\bskip\b|\bmiss\b|\bforget\b|\bdelete\b|\bignore\b|\bdiscard\b)/iu;
const AFFIRMATIVE_KEEP = /(?:保留|留存|保存|存留|完整记录|包含|涵盖|纳入|覆盖|执行|\bkeep\b|\bretain\b|\bpreserve\b|\binclude\b|\benforce\b)/iu;
const NEGATED_DEFECT = /(?:不得|不能|不要|禁止|避免|\bno\b|\bnever\b|\bmust\s+not\b|\bwithout\b)[^。！？；;\n]{0,80}?(?:报错|错误|异常|漏洞|失败|缺陷|\berrors?\b|\bfailures?\b|\bbugs?\b|\bdefects?\b|\bexceptions?\b)/iu;
const DEFECT_FREE = /(?:零错误|零报错|零缺陷|无报错|无错误|无异常|zero\s+(?:errors?|defects?|bugs?)|error[-\s]?free|bug[-\s]?free|defect[-\s]?free)/iu;
const ANTONYM_BOILERPLATE =
  /(?:不要|不能|不得|不可|禁止|切勿|严禁|免于|避免|必须|务必|应当|需要|应该|保证|确保|完整|全面|始终|永远|任何|所有|全部|一点|一丝|出现|漏掉|遗漏|漏记|丢失|丢掉|丢弃|省略|略过|忽略|跳过|忘掉|删掉|删除|保留|留存|保存|存留|包含|涵盖|纳入|覆盖|执行|\bdo\s+not\b|\bdon't\b|\bmust\s+not\b|\bnever\b|\bavoid\b|\bmust\b|\balways\b|\bensure\b|\ball\b|\bany\b|\bomit\b|\bdrop\b|\bskip\b|\bmiss\b|\bignore\b|\bforget\b|\bdelete\b|\bdiscard\b|\bkeep\b|\bretain\b|\bpreserve\b|\binclude\b|\benforce\b)/giu;

function oneWayAntonymMatch(negNorm, posNorm) {
  if (NEGATED_PRIVATIVE.test(negNorm) && AFFIRMATIVE_KEEP.test(posNorm) && !BARE_PRIVATIVE.test(posNorm)) return true;
  if (NEGATED_DEFECT.test(negNorm) && DEFECT_FREE.test(posNorm)) return true;
  return false;
}

function equivalentAntonymPolarity(source, candidate, sourceNegative, candNegative, limit = 0.6) {
  if (sourceNegative === candNegative) return false;
  const sNorm = normalize(source);
  const cNorm = normalize(candidate);
  const matched = sourceNegative ? oneWayAntonymMatch(sNorm, cNorm) : oneWayAntonymMatch(cNorm, sNorm);
  if (!matched) return false;
  const core = sNorm.replace(ANTONYM_BOILERPLATE, ' ').replace(/\s+/g, ' ').trim();
  if (!core) return false;
  return coverageOf(core, cNorm) >= limit;
}

function conditionParts(text) {
  const stripTemporal = (p, kw = '') => {
    let out = p.replace(/(?:的话|的时候)$/, '').trim();
    if (kw === '当') out = out.replace(/(?<![超实及暂随同定临长短])时$/, '').trim();
    return out || p;
  };
  const trimmed = String(text ?? '').trim();
  if (!trimmed || trimmed.length > 1024) return null;
  const m = CONDITIONAL_PREFIX_RE.exec(trimmed);
  if (m) {
    const predicate = stripTemporal((m[3] ?? m[5] ?? '').trim(), m[4] ?? '');
    const consequence = (m[6] ?? '').trim();
    if (predicate && consequence) return { predicate, consequence };
  }
  const s = CONDITIONAL_SUFFIX_RE.exec(trimmed);
  if (s) {
    const consequence = s[1].trim();
    const predicate = stripTemporal(s[3].trim());
    if (predicate && consequence) return { predicate, consequence };
  }
  return null;
}

const MODAL_STRIP = /(?:必须|务必|应当|应该|需要|可以|允许|请|先|\bmust\b|\bshould\b|\bcan\b|\bmay\b|\bplease\b)/gi;
const stripNegAndModal = (t) =>
  proseOnly(normalize(t))
    .replace(NEGATION, ' ')
    .replace(MODAL_STRIP, ' ')
    .replace(/[「」『』。.!！?？;；，,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function clauseMatchesSource(source, candidate, limit) {
  if (!scopesCompatible(source, candidate)) return false;
  const sa = actionState(source);
  const ca = actionState(candidate);
  if (sa && ca && sameAction(sa, ca)) return true;
  const stripLeadingBullet = (t) => stripSeqCitations(t).replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim();
  const sScalar = scalarRequirement(stripLeadingBullet(source));
  const cScalar = scalarRequirement(stripLeadingBullet(candidate));
  if (sScalar && cScalar && sScalar.subject === cScalar.subject) return true;
  if (scalarSubjectVerdict(source, candidate) !== null) return true;
  const sNorm = normalize(source);
  const cNorm = normalize(candidate);
  if (coverageOf(source, cNorm) >= limit) return true;
  const subClauses = splitContrastClauses(source);
  if (
    subClauses.length > 1 &&
    subClauses.some((sub) => isInstructionLine(sub) && coverageOf(sub, cNorm) >= limit)
  ) {
    return true;
  }
  if (
    coverageTokens(candidate).length >= 2 &&
    coverageOf(candidate, sNorm) >= limit &&
    coverageOf(source, cNorm) >= Math.min(limit, 0.35)
  ) {
    return true;
  }
  const stripNeg = (t) =>
    t.replace(NEGATION, ' ').replace(MODAL_STRIP, ' ').replace(/\*\*|__/g, '').replace(/[。.!！?？;；，,]+/g, ' ').replace(/\s+/g, ' ').trim();
  const sCore = stripNeg(proseOnly(sNorm));
  const cCore = stripNeg(proseOnly(cNorm));
  if (
    sCore &&
    cCore &&
    (sCore === cCore ||
      (coverageOf(sCore, cNorm) >= Math.max(limit, 0.75) &&
        coverageOf(cCore, sNorm) >= 0.4))
  ) {
    return true;
  }
  const cond = conditionParts(source);
  if (cond) {
    const ca2 = actionState(cond.consequence);
    const consCore = stripNegAndModal(cond.consequence);
    if (
      (ca2 && ca && sameAction(ca2, ca)) ||
      coverageOf(cond.consequence, cNorm) >= limit ||
      (coverageOf(cond.predicate, cNorm) >= 0.5 && consCore.length >= 2 && coverageOf(consCore, cNorm) >= limit)
    ) {
      return true;
    }
  }
  return false;
}

function identifierImpliedUnits(text) {
  const units = new Set();
  const str = String(text ?? '');
  for (const _ of str.matchAll(/(?:_|-)ms\b|(?<=[a-z0-9])Ms\b/g)) {
    units.add('ms');
  }
  for (const m of str.matchAll(/(?:_|-|(?<=[a-z0-9]))(milliseconds?|millis|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|bytes?|kb|mb|gb|tb|pct|percent)\b/gi)) {
    const raw = m[1].toLowerCase();
    if (raw === 'millis' || raw === 'millisecond' || raw === 'milliseconds') units.add('ms');
    else if (raw === 'pct' || raw === 'percent') units.add('%');
    else if (raw === 'hrs' || raw === 'hr') units.add('h');
    else if (raw === 'mins') units.add('min');
    else if (raw === 'secs') units.add('s');
    else units.add(unitFamily(raw).unit);
  }
  return units;
}

function numericFactsEquivalent(source, candidate, sNums, cNums) {
  if (JSON.stringify(sNums) === JSON.stringify(cNums)) return true;
  if (sNums.length !== cNums.length) return false;
  const splitNum = (token) => {
    const m = /^(-?\d+(?:\.\d+)?)([a-z%]*)$/.exec(token);
    return m ? { val: m[1], unit: m[2] } : null;
  };
  const sImplied = identifierImpliedUnits(source);
  const cImplied = identifierImpliedUnits(candidate);
  for (let i = 0; i < sNums.length; i += 1) {
    if (sNums[i] === cNums[i]) continue;
    const sp = splitNum(sNums[i]);
    const cp = splitNum(cNums[i]);
    if (!sp || !cp || sp.val !== cp.val) return false;
    if (!sp.unit && cp.unit && sImplied.has(cp.unit)) continue;
    if (!cp.unit && sp.unit && cImplied.has(sp.unit)) continue;
    return false;
  }
  return true;
}

function stripInlineMarkdownFormatting(text) {
  return String(text ?? '')
    .replace(/(`+)([^\n]{1,256}?)\1/g, (_, _ticks, inner) => ` ${inner} `)
    .replace(/(?<![a-z0-9_])(\*\*|__)([^\n]{1,160}?)\1(?![a-z0-9_])/gi, (full, marker, inner) =>
      /^\s|\s$/.test(inner) || inner.includes(marker) ? full : ` ${inner} `,
    );
}

function scalarSubjectVerdict(activeSource, candidate) {
  const strippedSrc = stripSeqCitations(activeSource).replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim();
  const sScalar = scalarRequirement(strippedSrc);
  if (!sScalar || sScalar.subject.length < 2) return null;
  const esc = sScalar.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const candClean = normalize(stripInlineMarkdownFormatting(stripSeqCitations(candidate)));
  const re = new RegExp(
    `(?<![a-z0-9_])${esc}(?:\\s*[:=：]?\\s*-?\\d+(?:\\.\\d+)?\\s*(?:->|→|=>)\\s*|\\s*(?:[:=：]|为|是|设为|设置为|保持(?:为)?|改为|改成|\\bmust\\s+be|\\bis|\\bset\\s+to)\\s*|\\s+)(-?\\d+(?:\\.\\d+)?)\\s*(ms|s|sec|seconds?|m|min|minutes?|h|hours?|d|days?|gb|gib|mb|mib|kb|kib|tb|bytes?|b|g|%|毫秒|秒|分钟?|小时|天|字节)?(?![a-z0-9_]|\\.[a-z0-9]|\\s*(?:->|→|=>))`,
    'gi',
  );
  const matches = [...candClean.matchAll(re)];
  if (matches.length === 0) return null;
  const sToken = `${sScalar.value}${sScalar.unit}`;
  for (const m of matches) {
    const after = candClean.slice(m.index + m[0].length);
    if (
      /^\s*(?:[*+÷×^/]|[-–](?=\S)|[-–]\s*[-\d(]|~|\.\.|\bto\s+[-\d(])/i.test(after) ||
      (m[2] !== '%' && /^\s*%/.test(after)) ||
      (m[2] === '%' && /^\s*[-+\d(]/.test(after) && !/^\s*\([a-z\u4e00-\u9fff]/i.test(after))
    ) {
      return 'mismatch';
    }
    const num = Number(m[1]);
    if (!Number.isFinite(num)) return null;
    const { unit } = unitFamily(m[2] ?? '');
    const cToken = `${num}${unit}`;
    if (!numericFactsEquivalent(activeSource, candidate, [sToken], [cToken])) {
      return 'mismatch';
    }
  }
  return 'match';
}

function conflictForPair(source, candidate, limit) {
  let activeSource = source;
  const candNorm = normalize(candidate);
  if (!conditionParts(source) && coverageOf(source, candNorm) < 1) {
    const subClauses = splitContrastClauses(source);
    if (subClauses.length > 1) {
      const matchingSubs = subClauses.filter((sub) => clauseMatchesSource(sub, candidate, limit));
      if (matchingSubs.length > 0) {
        const scoreSub = (sub) => coverageOf(sub, candNorm) + coverageOf(candidate, normalize(sub));
        matchingSubs.sort((a, b) => scoreSub(b) - scoreSub(a));
        activeSource = matchingSubs[0];
      }
    }
  }
  const sEx = exceptionTarget(activeSource);
  const cEx = exceptionTarget(candidate);
  const cond = conditionParts(activeSource);
  const candCond = conditionParts(candidate);
  const normativeSource = cond ? cond.consequence : activeSource;
  const candNormative = candCond ? candCond.consequence : candidate;
  const srcNeg = ruleNegative(sEx ? stripException(normativeSource) : normativeSource);
  const candNeg = ruleNegative(cEx ? stripException(candNormative) : candNormative);

  if (isInstructionLine(normativeSource) && candNeg !== srcNeg && !equivalentAntonymPolarity(normativeSource, candNormative, srcNeg, candNeg, limit)) {
    return { reason: 'polarity', candidate };
  }
  if (cond && !candCond && coverageOf(cond.predicate, candNorm) < 0.5) {
    return { reason: 'condition', candidate };
  }
  if (cond && candCond) {
    const srcUnless = /\bunless\b|除非/i.test(activeSource);
    const candUnless = /\bunless\b|除非/i.test(candidate);
    const srcPredNeg = ruleNegative(cond.predicate);
    const candPredNeg = ruleNegative(candCond.predicate);
    const hasAnd = (s) => /\band\b|且|并且/i.test(s);
    const hasOr = (s) => /\bor\b|或者?|要么/i.test(s);
    const connectorMismatch =
      (hasAnd(cond.predicate) && !hasAnd(candCond.predicate) && hasOr(candCond.predicate)) ||
      (hasOr(cond.predicate) && !hasOr(candCond.predicate) && hasAnd(candCond.predicate));
    const splitCondTerms = (p) =>
      String(p ?? '')
        .split(/\s*(?:\b(?:and|or)\b|[且与]|并且|或者?|要么|、)\s*/i)
        .map((s) => s.trim())
        .filter(Boolean);
    const srcTerms = splitCondTerms(cond.predicate);
    const candTerms = splitCondTerms(candCond.predicate);
    const droppedTerm =
      srcTerms.length > candTerms.length &&
      srcTerms.some((term) => Math.max(...candTerms.map((ct) => coverageOf(term, normalize(ct)))) < 0.6);
    if (
      srcUnless !== candUnless ||
      connectorMismatch ||
      droppedTerm ||
      (srcPredNeg !== candPredNeg && !equivalentAntonymPolarity(cond.predicate, candCond.predicate, srcPredNeg, candPredNeg, limit)) ||
      coverageOf(cond.predicate, normalize(candCond.predicate)) < limit
    ) {
      return { reason: 'condition', candidate };
    }
  }
  if (
    (LOWER_BOUND_RE.test(activeSource) && UPPER_BOUND_RE.test(candidate) && !LOWER_BOUND_RE.test(candidate)) ||
    (UPPER_BOUND_RE.test(activeSource) && LOWER_BOUND_RE.test(candidate) && !UPPER_BOUND_RE.test(candidate))
  ) {
    return { reason: 'range', candidate };
  }
  const sDirs = allTransferPairs(activeSource);
  const cDirs = allTransferPairs(candidate);
  if (sDirs.length > 0 && cDirs.length > 0 && JSON.stringify(sDirs) !== JSON.stringify(cDirs)) {
    return { reason: 'relation', candidate };
  }
  if (sEx && (!cEx || sEx !== cEx)) {
    return { reason: 'exception', candidate };
  }
  const subjVerdict = scalarSubjectVerdict(activeSource, candidate);
  if (subjVerdict === 'mismatch') {
    return { reason: 'value', candidate };
  }
  if (subjVerdict === 'match') {
    return null;
  }
  const sNums = numericFacts(activeSource);
  const cNums = numericFacts(candidate);
  if (sNums.length > 0) {
    if (cNums.length > 0 && !numericFactsEquivalent(activeSource, candidate, sNums, cNums)) {
      return { reason: 'value', candidate };
    }
    if (cNums.length === 0 && isInstructionLine(activeSource) && !/[零一二两三四五六七八九十百千万亿]/.test(candidate)) {
      const nonNumSource = normalize(activeSource).replace(/-?\d+(?:\.\d+)?/g, ' ').replace(/\s+/g, ' ').trim();
      if (coverageTokens(nonNumSource).length >= 2 && coverageOf(nonNumSource, candNorm) >= Math.max(limit, 0.75)) {
        return { reason: 'value', candidate };
      }
    }
  }
  return null;
}

const NORMATIVE_OR_CURRENT_CLAIM_RE =
  /(?:仍(?:然|旧)?|继续|现行|当前|目前|依然|有效|生效|批准|允许|保持|维持|遵循|采用|\b(?:still|current(?:ly)?|now|active|valid|effective|approved|authorized|permitted|enforced|kept|retained|maintain(?:ed)?|use[ds]?|apply|applies)\b)/i;

const UNIT_OPT_RE = '(?:ms|s|sec|seconds?|m|min|minutes?|h|hours?|d|days?|gb|gib|mb|mib|kb|kib|tb|bytes?|b|g|%|毫秒|秒|分钟?|小时|天|字节)?';
const HIST_TAG_ONLY_RE =
  '(?:previously|formerly|originally|initially|superseded|deprecated|当时|原值|旧值|已修订|已取代)';

function isBoundHistoricalValue(sourceLine, candidate) {
  if (new Set(numericFacts(candidate)).size > 1) return false;
  const strippedSrc = stripSeqCitations(sourceLine).replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim();
  const sScalar = scalarRequirement(strippedSrc);
  if (!sScalar || sScalar.subject.length < 2) return false;
  const esc = sScalar.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const candClean = normalize(stripSeqCitations(candidate)).replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim();
  const histLeadPrefix = '(?:(?:轮已输出|历史记录|历史快照)\\s*[:：]\\s*)?';
  const histTrailSuffix = `(?:\\s*[(（]\\s*${HIST_TAG_ONLY_RE}\\s*[)）]|\\s+\\b(?:was|is)\\s+(?:superseded|deprecated)\\b)?\\s*[。.!！;；]?$`;
  return (
    new RegExp(
      `^${histLeadPrefix}${esc}\\s*(?:当时(?:报|为|是|输出)|曾(?:经)?(?:为|是|报|用|设为)|原(?:先|来)?(?:为|是|设(?:为)?)|(?:之前|此前|早先|先前)(?:为|是|报)|\\b(?:was|were)\\s+(?:previously|formerly|originally|initially)\\b|\\b(?:previously|formerly|originally|initially)\\s+(?:set\\s+to|reported\\s+as|was|were)\\b)\\s*(?:[:=：]\\s*)?(?:null|-?\\d+(?:\\.\\d+)?\\s*${UNIT_OPT_RE})${histTrailSuffix}`,
      'i',
    ).test(candClean) ||
    new RegExp(
      `^${histLeadPrefix}(?:当时|之前|此前|早先|先前|原先)\\s+${esc}\\s*(?:[:=：]|为|是|报)\\s*(?:null|-?\\d+(?:\\.\\d+)?\\s*${UNIT_OPT_RE})${histTrailSuffix}`,
      'i',
    ).test(candClean) ||
    new RegExp(
      `^${histLeadPrefix}${esc}\\s*[:=：]?\\s*(?:null|-?\\d+(?:\\.\\d+)?\\s*${UNIT_OPT_RE})\\s*(?:[(（]\\s*${HIST_TAG_ONLY_RE}\\s*[)）]|\\b(?:was|is)\\s+(?:superseded|deprecated)\\b)\\s*[。.!！;；]?$`,
      'i',
    ).test(candClean)
  );
}

export function auditCompaction({ userMessages, summaryText, checkpointText, threshold, includeAllConflicts = false, referenceMessages = [] }) {
  const originalMessages = userMessages ?? [];
  const trustedMessages = originalMessages
    .filter((message) => !isReferenceContextKind(message.sourceKind))
    .map((message) => ({ ...message, text: instructionText(message) }));

  const limit = typeof threshold === 'number' && Number.isFinite(threshold) ? threshold : 0.6;
  const haystack = normalize(String(checkpointText ?? summaryText).replace(/\*\*|__/g, ''));
  const summaryClauses = splitContrastClauses(summaryText ? summaryProse(summaryText) : '');
  const messageLines = trustedMessages.map((message) => ({
    message,
    lines: sourceEvidenceSentences(message.text).filter(
      (line) => isInstructionLine(line) || numericFacts(line).length > 0,
    ),
  }));
  const allTrustedLines = messageLines.flatMap((entry) => entry.lines);

  const lost = [];
  let checked = 0;
  let worst = 1;
  let polarityFlips = 0;

  for (const { message, lines } of messageLines) {
    for (const line of lines) {
      checked += 1;
      let coverage = coverageOf(line, haystack);
      const srcNeg = ruleNegative(line);

      const matchedCandidates = summaryClauses.filter((c) => clauseMatchesSource(line, c, limit));
      const lineIsScalar =
        scalarRequirement(stripSeqCitations(line).replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim()) !== null;
      const hasExactActiveMatch = matchedCandidates.some(
        (c) =>
          coverageOf(line, normalize(c)) >= Math.max(limit, 0.8) &&
          conflictForPair(line, c, limit) === null &&
          (!lineIsScalar || scalarSubjectVerdict(line, c) === 'match'),
      );
      const conflicts = [];
      for (const candidate of matchedCandidates) {
        const conflict = conflictForPair(line, candidate, limit);
        if (!conflict) continue;
        const candNormForHist = normalize(candidate);
        const hasNormativeOrCurrentClaim =
          CN_MODAL.test(candNormForHist) ||
          EN_MODAL.test(candNormForHist) ||
          COMMAND.test(candNormForHist) ||
          NORMATIVE_OR_CURRENT_CLAIM_RE.test(candNormForHist);
        if (
          hasExactActiveMatch &&
          conflict.reason === 'value' &&
          !hasNormativeOrCurrentClaim &&
          isBoundHistoricalValue(line, candidate)
        ) {
          continue;
        }
        if (scalarSubjectVerdict(line, candidate) === 'mismatch') {
          conflicts.push(conflict);
          continue;
        }
        const cNorm = normalize(candidate);
        const lineCov = coverageOf(line, cNorm);
        const candInLine = coverageOf(candidate, normalize(line));
        const ownedByPeer = allTrustedLines.some((peer) => {
          if (peer === line || !scopesCompatible(peer, candidate)) return false;
          const pNorm = normalize(peer);
          const forwardBetter = coverageOf(peer, cNorm) >= Math.max(0.85, lineCov + 0.05);
          const reverseBetter = coverageOf(candidate, pNorm) >= Math.max(0.85, candInLine + 0.05);
          return (forwardBetter || reverseBetter) && conflictForPair(peer, candidate, limit) === null;
        });
        if (!ownedByPeer) conflicts.push(conflict);
      }

      if (coverage < limit) {
        const antonymMatch = summaryClauses.find(
          (c) =>
            scopesCompatible(line, c) &&
            equivalentAntonymPolarity(line, c, srcNeg, ruleNegative(c), limit) &&
            numericFacts(line).join(',') === numericFacts(c).join(','),
        );
        if (antonymMatch) coverage = 1;
      }
      worst = Math.min(worst, coverage);

      if (conflicts.length > 0) {
        const primary = conflicts[0];
        if (primary.reason === 'polarity') polarityFlips += 1;
        lost.push({
          seq: message.seq,
          line,
          candidate: primary.candidate,
          coverage: Number(coverage.toFixed(3)),
          reason: primary.reason,
          ...(includeAllConflicts ? { conflicts } : {}),
        });
      } else if (coverage < limit) {
        lost.push({
          seq: message.seq,
          line,
          coverage: Number(coverage.toFixed(3)),
          reason: 'coverage',
        });
      }
    }
  }

  const provenance = auditInstructionProvenance({ userMessages: originalMessages, referenceMessages, summaryText });
  return {
    checked,
    lost: [...lost, ...provenance],
    polarityFlips,
    worstCoverage: checked === 0 ? 1 : Number(worst.toFixed(3)),
  };
}

const APPROVAL_CLAIM_RE =
  /(?:用户\s*(?:现在|已经|已|明确|现已)?\s*(?:批准|授权|同意|允许)|(?:已|已经)(?:获(?:得)?|得到)用户(?:授权|批准|同意)|\b(?:the\s+)?user\s+(?:has\s+)?(?:already\s+|explicitly\s+|now\s+)?(?:approved|authorized|authorised|permitted|allowed|consented|granted\s+permission)|\b(?:approved|authorized|authorised|permitted)\s+by\s+(?:the\s+)?user\b)/i;
const DIRECT_USER_APPROVAL_RE =
  /(?:^\s*(?:我\s*(?:现在|已经|已|明确|现已)?\s*(?:批准|授权|同意|允许)|i\s+(?:hereby\s+)?(?:authorize|authorise|approve|allow|permit|consent\s+to)\b))/im;
const NEGATED_OR_PENDING_APPROVAL_RE =
  /(?:未|不|没有|尚无|尚未|并非|等待|等候|待|如(?:果)?|只有|仅当)[^。！？;；\n]{0,30}(?:授权|批准|允许|同意)|\b(?:if|unless|pending|awaiting|not|no|without)\b[^.!?\n;]{0,50}\b(?:approval|permission|consent|approved|authorized|authorised)\b/i;

const APPROVAL_BOILERPLATE_RE =
  /(?:(?:我|用户)\s*(?:现在|已经|已|明确|现已|在此)?\s*(?:批准|授权|同意|允许)|(?:已|已经)?(?:获(?:得)?|得到)用户(?:授权|批准|同意)|\b(?:the\s+)?user\s+(?:has\s+)?(?:already\s+|explicitly\s+|now\s+)?(?:approved|authorized|authorised|permitted|allowed|consented|granted\s+permission(?:\s+(?:to|for))?)|\bi\s+(?:hereby\s+)?(?:authorize|authorise|approve|allow|permit|consent\s+to)|\b(?:approved|authorized|authorised|permitted)\s+by\s+(?:the\s+)?user|\bto\b|\bfor\b|\bthe\b)/gi;

const REVOCATION_APPROVAL_RE =
  /\b(?:revoke|withdraw|cancel|rescind|reject|deny|forbid)\s+(?:my\s+|the\s+|this\s+)?(?:prior\s+|previous\s+)?(?:approval|authorization|authorisation|permission|consent)\b|\b(?:do\s+not|don't|no\s+longer|not)\s+(?:approve|authorize|authorise|permit|allow|consent)\b|(?:撤销|取消|收回|撤回|作废|不再|不|不要|禁止|拒绝)(?:之前|刚才|上述|先前的?)?(?:的)?(?:批准|授权|同意|允许)/i;

const REVOCATION_BOILERPLATE_RE =
  /(?:(?:(?:我|用户)\s*)?(?:现在|已经|已|明确|现已|在此)?\s*(?:撤销|取消|收回|撤回|作废|不再|禁止|拒绝|不要|不)\s*(?:之前|刚才|上述|先前的?)?(?:对)?(?:的)?(?:批准|授权|同意|允许)?|(?:之前|刚才|上述|先前的?)?(?:的)?(?:批准|授权|同意|允许)|\b(?:(?:i|the\s+user)\s+)?(?:hereby\s+)?(?:revoke|withdraw|cancel|rescind|reject|deny|forbid|do\s+not|don't|no\s+longer|not)\s+(?:my\s+|the\s+|this\s+)?(?:prior\s+|previous\s+)?(?:approval|authorization|authorisation|permission|consent|approve|authorize|authorise|permit|allow)\b|\b(?:of|for|on|to|the|my|this)\b)/gi;

const stripApprovalBoilerplate = (text) =>
  normalize(text)
    .replace(APPROVAL_BOILERPLATE_RE, ' ')
    .replace(/[。.!！?？;；，,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const stripRevocationBoilerplate = (text) =>
  normalize(text)
    .replace(REVOCATION_BOILERPLATE_RE, ' ')
    .replace(/[。.!！?？;；，,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function approvalTargetsMatch(srcCore, srcClause, claimCore, claimSentence, { isRevocation = false } = {}) {
  if (!srcCore || !claimCore) return false;
  const sDirs = allTransferPairs(srcCore);
  const cDirs = allTransferPairs(claimCore);
  const srcPairs = sDirs.length ? sDirs : allTransferPairs(srcClause);
  const claimPairs = cDirs.length ? cDirs : allTransferPairs(claimSentence);
  if ((srcPairs.length > 0 || claimPairs.length > 0) && JSON.stringify(srcPairs) !== JSON.stringify(claimPairs)) {
    return false;
  }
  const sEx = exceptionTarget(srcCore) ?? exceptionTarget(srcClause);
  const cEx = exceptionTarget(claimCore) ?? exceptionTarget(claimSentence);
  if (isRevocation) {
    if (cEx && sEx !== cEx) return false;
  } else if ((sEx || cEx) && sEx !== cEx) {
    return false;
  }
  const sNums = numericFacts(srcCore);
  const cNums = numericFacts(claimCore);
  if (isRevocation ? cNums.length > 0 && JSON.stringify(sNums) !== JSON.stringify(cNums) : JSON.stringify(sNums) !== JSON.stringify(cNums)) {
    return false;
  }
  const sa = actionState(srcCore);
  const ca = actionState(claimCore);
  if (isRevocation && coverageOf(sEx ? stripException(srcCore) : srcCore, normalize(claimCore)) >= 0.7) return true;
  if (sa && ca) return sa.negative === ca.negative && sameAction(sa, ca);
  return (
    Math.min(
      coverageOf(claimCore, normalize(srcClause)),
      coverageOf(srcCore, normalize(claimSentence)),
    ) >= 0.7
  );
}

/**
 * Channel-based compaction laundering defense:
 * rejects summary claims of user approval/authorization unless a matching,
 * unrevoked verified user channel approval backs that specific action/scope.
 */
export function auditInstructionProvenance({ userMessages = [], referenceMessages = [], summaryText }) {
  const verifiedMessages = userMessages
    .filter((m) => !isReferenceContextKind(m.sourceKind))
    .slice()
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  let activeGrants = [];
  for (const m of verifiedMessages) {
    for (const clause of splitContrastClauses(instructionText(m))) {
      const isRevoke =
        REVOCATION_APPROVAL_RE.test(clause) ||
        ((APPROVAL_CLAIM_RE.test(clause) || DIRECT_USER_APPROVAL_RE.test(clause)) &&
          NEGATED_OR_PENDING_APPROVAL_RE.test(clause));
      if (isRevoke) {
        const revCore = stripRevocationBoilerplate(clause);
        activeGrants = activeGrants.filter((g) => {
          if (!scopesCompatible(clause, g.clause)) return true;
          if (!revCore) return false;
          return !approvalTargetsMatch(g.core, g.clause, revCore, clause, { isRevocation: true });
        });
        continue;
      }
      if (APPROVAL_CLAIM_RE.test(clause) || DIRECT_USER_APPROVAL_RE.test(clause)) {
        activeGrants.push({ clause, core: stripApprovalBoilerplate(clause) });
      }
    }
  }

  const untrustedRefs = [
    ...userMessages.flatMap((m) =>
      (isReferenceContextKind(m.sourceKind) ? [m.text] : referenceTexts(m)).map((text) => ({ seq: m.seq, text })),
    ),
    ...referenceMessages.map((m) => ({ seq: m.seq ?? -1, text: m.text })),
  ];
  const refSeq = untrustedRefs.find((r) => APPROVAL_CLAIM_RE.test(r.text))?.seq ?? untrustedRefs[0]?.seq ?? -1;

  const lost = [];
  for (const sentence of splitContrastClauses(summaryText ? summaryProse(summaryText) : '')) {
    if (!APPROVAL_CLAIM_RE.test(sentence)) continue;
    if (NEGATED_OR_PENDING_APPROVAL_RE.test(sentence)) continue;

    const claimCore = stripApprovalBoilerplate(sentence);
    const backed = activeGrants.some((g) => {
      if (!scopesCompatible(g.clause, sentence)) return false;
      if (!claimCore) return true;
      return approvalTargetsMatch(g.core, g.clause, claimCore, sentence);
    });
    if (backed) continue;

    lost.push({
      seq: refSeq,
      line: sentence,
      candidate: sentence,
      coverage: 0,
      reason: 'provenance',
    });
  }
  return lost;
}
