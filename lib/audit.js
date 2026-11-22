// Domain-agnostic constraint, polarity, numeric/condition, and provenance auditor.
// Zero LLM calls; operates on summaryProse() so verbatim Section 6 cannot mask prose reversals.

import { summaryProse } from './validate.js';
import { actionState, sameAction } from './action-state.js';
import { isReferenceContextKind } from './source-provenance.js';
import { instructionText, isReferencePrefixOnly, isSystemReminderOnly, referenceTexts } from './instruction-source.js';

const CN_MODAL = /不允许|不应(?:当|该)?|不(?=修改|删除|运行|调用|安装|部署|上传|下载|发送|联网|覆盖|发布|写入|写库|重启|终止|降低|改)|必须|不要(?!求)|不能|不得|禁止|记得|务必|只能|一定要|(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人)|需要|请|注意|不可(?!逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越)|无需|不准|严禁|勿|只有|仅当|如果|除非/;
const EN_MODAL = /\b(?:must|never|always|only|ensure|remember|required|forbidden|avoid|should|please|unless|if|when)\b|\bdo not\b|\bdon't\b/;
const COMMAND = /^(?:you\s+)?(?:use|run|keep|retain|preserve|delete|remove|restart|deploy|copy|move|sync|transfer|output|format)\b|^(?:保留|删除|运行|使用|发布|重启|复制|输出|跑\s)/;
const LABEL = /^(?:output(?:\s+format)?|format|port|timeout|retention|limit|输出格式|输出|端口|超时|保留时间|限制)\s*[:：]/;

const NEGATION =
  /不允许|不应(?:当|该)?|不要(?!求)|不能|不得|不必|不用|禁止|(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人)|无需|不可(?!逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越)|不准|严禁|勿|没有|尚未|并未|未曾|不(?:实际|直接|擅自)|不(?![同仅但过论管断少足安便光止久妨料然如至]|得不|可(?:逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越))(?=[\u4e00-\u9fff])|未(?=执行|运行|调用|修改|删除|写入|安装|重启|强停|改|降|提|kill|restart|append)|\b(?:must not|do not|don't|never|forbidden|avoid|no|not)\b/g;

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
  /(?:不要|不能|不得|不可(?!逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越)|切勿|严禁|(?<![分区识个特级差类性鉴告离甄辨判派])别)\s*(?:不(?![同仅但过论管断少足安便光止久妨料然如至])|没(?:有)?|未)|不得不|\b(?:do\s+not|don't|must\s+not|never|cannot|can't)\s+(?:avoid\s+\w+ing\b|not\b|fail\s+to\b)/i;

const UNIT_SUFFIX_OPT_RE =
  '(?:\\s*(?:ms|s|sec|seconds?|m|min|minutes?|h|hours?|d|days?|gb|gib|mb|mib|kb|kib|tb|bytes?|b|g|%|毫秒|秒|分钟?|小时|天|字节|个|次|条))?';
const EXPLICIT_PAREN_DISAVOWAL_RE = new RegExp(
  `[（(]\\s*(?:(?:不是|并非|而非|而不是|非|不再用|不是之前的|不是原先的|不是旧的|\\b(?:not|instead\\s+of|rather\\s+than)\\b)\\s*-?\\d+(?:\\.\\d+)?${UNIT_SUFFIX_OPT_RE}|(?:was|previously|formerly|originally|原(?:为|是)?|旧(?:值)?(?:为)?)\\s*-?\\d+(?:\\.\\d+)?${UNIT_SUFFIX_OPT_RE}\\s*[,，;]\\s*(?:replaced\\s+by|updated\\s+to|changed\\s+to|superseded\\s+by|now|(?:已|现)?(?:改为|改成|替换为|替代为))\\s*-?\\d+(?:\\.\\d+)?${UNIT_SUFFIX_OPT_RE})\\s*[)）]`,
  'gi',
);
const EXPLICIT_INLINE_DISAVOWAL_RE = new RegExp(
  `(?:[，,;；]\\s*(?:不是|并非|而非|而不是|不再用|不是之前的|不是原先的|不是旧的|\\bnot\\b)|(?:而非|而不是)|(?:,\\s*|\\s+)(?:instead\\s+of|rather\\s+than)\\b)\\s*-?\\d+(?:\\.\\d+)?${UNIT_SUFFIX_OPT_RE}(?=$|[\\s，,。；;！!？?)）])`,
  'gi',
);

export function stripExplicitValueCorrection(text) {
  const raw = String(text ?? '');
  if (!raw) return raw;
  const stripped = raw
    .replace(EXPLICIT_PAREN_DISAVOWAL_RE, ' ')
    .replace(EXPLICIT_INLINE_DISAVOWAL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || raw.trim();
}

const QUOTE_REVOCATION_PREFIX_RE =
  /(?:取消|撤销|废除|解除|终止|停止|放弃|免除|放开|松绑|打破|突破|不再|不(?:需要|必|用)?再|别再|不要再|不能再|不得再|禁止再|无需再)[^。！？;；\n「『]{0,12}$/i;
const OUTER_PROHIBIT_BEFORE_REVOCATION_RE =
  /(?:不允许|不应(?:当|该)?|不要(?!求)|不能|不得|不可(?!逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越)|禁止|严禁|切勿|勿|(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人))\s*(?:取消|撤销|废除|解除|终止|停止|放弃|免除|放开|松绑)/;
const QUOTE_RESTRICTION_HEAD_RE = /^(?:的)?(?:限制|约束|禁令|门禁|封锁)/;

function ruleNegative(line) {
  const text = proseOnly(stripExplicitValueCorrection(line)).toLowerCase();
  if (DOUBLE_NEGATION_RE.test(text)) return false;
  if (/[「『][^」』]{1,80}[」』]/.test(text) && !OUTER_PROHIBIT_BEFORE_REVOCATION_RE.test(text)) {
    const quoteMatch = /[「『]([^」』]{1,80})[」』]/.exec(text);
    if (quoteMatch) {
      const beforeQuote = text.slice(0, quoteMatch.index).trimEnd();
      const afterQuote = text.slice(quoteMatch.index + quoteMatch[0].length);
      if (QUOTE_REVOCATION_PREFIX_RE.test(beforeQuote)) {
        const innerNeg = ruleNegative(quoteMatch[1]);
        const isRestrictionLift = /放开|松绑|打破/.test(beforeQuote) || QUOTE_RESTRICTION_HEAD_RE.test(afterQuote);
        if (innerNeg || isRestrictionLift) {
          const remainder = `${beforeQuote.replace(QUOTE_REVOCATION_PREFIX_RE, ' ')} ${afterQuote}`.trim();
          return remainder ? negationsOf(remainder).length > 0 : false;
        }
        return true;
      }
    }
  }
  return negationsOf(text).length > 0;
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
  /(?:内存|显存|硬盘|磁盘|存储|空间|容量|体积|大小|字节|上限|下限|配额|限额|限制|缓存|缓冲|备份|文件|日志|带宽|流量|最大|最小|至少|不超过|小于|大于|低于|高于|\b(?:ram|vram|mem(?:ory)?|disk|storage|space|size|bytes?|cap(?:acity)?|limit|quota|backup|cache|buffer|heap|max|min|at\s+least|at\s+most|under|over|below|above)\b)/i;

function isNonQuantityTechTerm(numText, space, rawUnit, contextText) {
  if (space || !rawUnit) return false;
  // Compact uppercase single-letter duration symbols (e.g. 3D, 2D, 3M, 6S, 2H) are tech terms, not durations.
  if (/^[DSMH]$/.test(rawUnit)) return true;
  // Compact uppercase "B" (e.g. 2B, 4B, 14B, 70B, 671B model parameter sizes / 2B SaaS) without byte/size context is not bytes.
  if (rawUnit === 'B' && !SIZE_CONTEXT_RE.test(contextText)) return true;
  // Bare "2G"-"6G" without storage/memory/quota context is typically telecom/WiFi generation rather than GB.
  if (rawUnit === 'G' && /^[2-6]$/.test(numText) && !SIZE_CONTEXT_RE.test(contextText)) return true;
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
  const raw = stripExplicitValueCorrection(String(text ?? '').trim());
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
    .split(/[\s,.;:!?()[\]{}"'`/\\|<>+=*&^%$#@~…，。、；：！？（）【】《》「」『』“”]+/)
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
      if (run.length < 3 && run.length === token.length) continue;
      expanded = true;
      if (match.index > last) out.push(token.slice(last, match.index));
      if (run.length < 3) {
        out.push(run);
      } else {
        for (let i = 0; i < run.length - 1; i += 1) {
          out.push(run.slice(i, i + 2));
        }
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

function stripFencedCodeBlocks(text) {
  const value = String(text ?? '');
  if (!/```|~~~/.test(value)) return value;
  const lines = value.split(/\r?\n/);
  const out = [];
  let fence = null;
  for (const line of lines) {
    if (!fence) {
      const open = /^\s*(`{3,}|~{3,})/.exec(line);
      if (open) {
        const char = open[1][0];
        const len = open[1].length;
        const rest = line.slice(open.index + open[0].length);
        // Keep single-line inline triple-backtick spans intact.
        if (char === '`' && rest.includes('`'.repeat(len))) {
          out.push(line);
          continue;
        }
        fence = { char, len };
        continue;
      }
      out.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length >= fence.len && trimmed === fence.char.repeat(trimmed.length)) {
      fence = null;
    }
  }
  return out.join('\n');
}

const STRONG_DIRECTIVE_RE =
  /必须|务必|一定要|禁止|严禁|不得|不能|不要(?!求)|不允许|不可(?!逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越)|不准|勿|请(?!问)|\b(?:must(?:\s+not)?|never|forbidden|do\s+not|don't|please)\b/i;
const QUESTION_STARTER_RE =
  /^(?:为什么|为何|怎么|怎样|如何|请问|是否|是不是|能否|可否|能不能|可不可以|要不要|需不需要|有没有|会不会|建议|\b(?:why|what|how|when|where|who|whom|whose|which|should|would|could|can|may|might|must|do|does|did|is|are|was|were|have|has|had|will|shall)\b)/i;
const POLITE_IMPERATIVE_Q_RE =
  /^(?:(?:can|could|would|will)\s+you\s+please\b|please\b|请(?!问)|麻烦你?帮?我?|帮我)/i;
const CN_QUESTION_CUE_RE =
  /(?:[吗呢么]\s*[?？]\s*$|为什么|为何|怎么|怎样|如何|是否|是不是|能否|可否|能不能|可不可以|要不要|需不需要|有没有|会不会|行不行|好不好|对不对|什么|哪(?:个|些|里|儿|种)|多少)/;

function hasPreClauseDirective(pre) {
  const norm = normalize(pre);
  if (!norm || QUESTION_STARTER_RE.test(norm)) return false;
  return (
    STRONG_DIRECTIVE_RE.test(norm) ||
    COMMAND.test(norm) ||
    LABEL.test(norm) ||
    scalarRequirement(pre.trim()) !== null
  );
}

function isPureQuestion(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!/[?？]\s*$/.test(trimmed)) return false;
  if (POLITE_IMPERATIVE_Q_RE.test(trimmed) && !/[吗呢么]\s*[?？]\s*$/.test(trimmed)) {
    return false;
  }
  const commaMatch = /^(.+?)[,，;；]\s*([^,，;；]+)$/.exec(trimmed);
  if (commaMatch && hasPreClauseDirective(commaMatch[1])) {
    return false;
  }
  if (QUESTION_STARTER_RE.test(trimmed) || CN_QUESTION_CUE_RE.test(trimmed)) {
    return true;
  }
  const norm = normalize(trimmed);
  if (!STRONG_DIRECTIVE_RE.test(norm) && scalarRequirement(trimmed) === null) {
    return true;
  }
  return false;
}

function isInstructionLine(line) {
  const raw = String(line ?? '').trim();
  const lower = normalize(raw);
  if (!lower) return false;
  if (/^\s*#{1,6}\s/.test(lower)) return false;
  if (isPureQuestion(raw)) return false;
  return CN_MODAL.test(lower) || EN_MODAL.test(lower) || COMMAND.test(lower) || LABEL.test(lower) || scalarRequirement(line) !== null;
}

const SEQ_CITATION_RE =
  /(?:\[\s*seqs?\s+\d+(?:\s*[-–,]\s*\d+)*\s*\]|[（(]\s*seqs?\s+\d+(?:\s*[-–,]\s*\d+)*\s*[)）]|\bseqs?\s*#?\s*\d+(?:\s*[-–,]\s*\d+)*\b|\bseqs?\s*[=:]\s*\d+\b|\bphase\s*#?\d+\b|>\s*user source\s*\(seq\s+\d+\),\s*verbatim:)/gi;

const stripSeqCitations = (text) => String(text ?? '').replace(SEQ_CITATION_RE, ' ');

const LOC_REF_RE = /(?<![a-z0-9_./-])([a-z0-9_./-]{1,120}\.[a-z]{1,6}):(\d+(?:-\d+)?)/gi;
const NON_QUANTITY_NUM_RE =
  /(?<![a-z0-9_./-])\d{4}\/\d{1,2}\/\d{1,2}(?![a-z0-9_./-])|(?<![a-z0-9_./-])(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?![a-z0-9_./-])|(?<![a-z0-9_])#\d+\b|(?<![a-z0-9_.-])v\d+(?:\.\d+)+(?![a-z0-9_.-])/gi;

function numericFacts(text) {
  const out = [];
  const cleaned = stripExplicitValueCorrection(stripSeqCitations(text));
  const locs = [];
  const withoutLocs = cleaned.replace(LOC_REF_RE, (_full, file, lines) => {
    locs.push(`loc:${file.toLowerCase()}:${lines}`);
    return ' ';
  });
  const withoutMeta = withoutLocs.replace(NON_QUANTITY_NUM_RE, ' ');
  const value = withoutMeta.replace(/(?<!\d)\d{1,3}(?:,\d{3})+(?!\d)/g, (m) => m.replaceAll(',', ''));
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
  out.push(...locs);
  return out;
}

const NUMERIC_ASSIGNMENT_CUE_RE =
  /(?:[:=：]\s*-?\d|设为|设置为|改为|改成|调为|调成|定为|保持(?:为)?|限制(?:为|在)?|控制在|上限|下限|配额|限额|阈值|预算|\b(?:set\s+\S+\s+to|limit(?:ed)?\s+to|cap(?:ped)?\s+at|max(?:imum)?|min(?:imum)?|threshold|quota|budget|timeout|port|retries|retention)\b)/i;
const ANECDOTAL_OBSERVATION_RE =
  /(?:跑了|试了|等了|花了|卡了|停了|拖了|聊了|写了|改了|看了|过了|大概|差不多|好像|似乎|疑似|已经|刚才|刚刚|之前|以前|先前|昨天|今天|上午|下午|晚上|我有|我们有|一共|总共|结果|卡住|报错|崩溃|失败了|\b(?:took|spent|waited|tried|ran\s+for|already|yesterday|today|about|around|seems?|looks?\s+like|stuck|failed|crashed|i\s+have|we\s+have)\b)/i;

function hasRequirementNumericCue(line) {
  const raw = String(line ?? '').trim();
  if (!raw || /^\s*#{1,6}\s/.test(raw)) return false;
  if (isPureQuestion(raw)) return false;
  const facts = numericFacts(raw);
  if (facts.length === 0) return false;
  const stripped = stripSeqCitations(raw).replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim();
  if (stripExplicitValueCorrection(stripped) !== stripped) return true;
  if (scalarRequirement(stripped) !== null) return true;
  if (LOWER_BOUND_RE.test(raw) || UPPER_BOUND_RE.test(raw)) return true;
  if (NUMERIC_ASSIGNMENT_CUE_RE.test(raw)) return true;
  const commaParts = stripped.split(/[，,]\s*/).filter(Boolean);
  if (commaParts.length > 1 && commaParts.every((p) => scalarRequirement(p) !== null)) return true;
  if (!ANECDOTAL_OBSERVATION_RE.test(raw) && facts.some((f) => !f.startsWith('loc:') && /[a-z%]$/.test(f))) {
    return true;
  }
  return false;
}

export function extractConstraintLines(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const raw of sourceEvidenceSentences(stripFencedCodeBlocks(text))) {
    const sentence = raw.trim();
    if (!isInstructionLine(sentence)) continue;
    if (seen.has(sentence)) continue;
    seen.add(sentence);
    out.push(sentence);
  }
  return out;
}

export function sourceConstraintEvidence(text) {
  return stripFencedCodeBlocks(text)
    .split(/\r?\n/)
    .filter((line) => extractConstraintLines(line).length > 0)
    .flatMap((line) => sourceEvidenceSentences(line))
    .filter((raw) => {
      const sentence = raw.trim();
      return isInstructionLine(sentence) || hasRequirementNumericCue(sentence);
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

function stripNumbersForTopic(text) {
  return String(text ?? '')
    .replace(/(?<![a-z0-9_])-?\d+(?:\.\d+)?(?![a-z0-9_])/gi, ' ')
    .replace(/\*\*|__/g, ' ')
    .replace(/[「」『』。.!！?？;；，,:=×+\-*/()（）[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scalarSubjectsIncompatible(sScalar, cScalar) {
  if (!sScalar || !cScalar) return false;
  const sSubj = stripNegAndModal(sScalar.subject);
  const cSubj = stripNegAndModal(cScalar.subject);
  if (!sSubj || !cSubj || sSubj === cSubj) return false;
  return coverageOf(sSubj, cSubj) < 0.5 && coverageOf(cSubj, sSubj) < 0.5;
}

function clauseMatchesSingle(source, candidate, limit) {
  if (!scopesCompatible(source, candidate)) return false;
  const sa = actionState(source);
  const ca = actionState(candidate);
  if (sa && ca && sameAction(sa, ca)) return true;
  const stripLeadingBullet = (t) => stripSeqCitations(t).replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim();
  const sScalar = scalarRequirement(stripLeadingBullet(source));
  const cScalar = scalarRequirement(stripLeadingBullet(candidate));
  if (sScalar && cScalar && sScalar.subject === cScalar.subject) return true;
  if (scalarSubjectVerdict(source, candidate) !== null) return true;
  if (scalarSubjectsIncompatible(sScalar, cScalar)) return false;
  const sNorm = normalize(source);
  const cNorm = normalize(candidate);
  if (coverageOf(source, cNorm) >= limit) return true;
  const srcNoCorrection = stripExplicitValueCorrection(source);
  if (srcNoCorrection !== source && coverageOf(srcNoCorrection, cNorm) >= limit) return true;
  const subClauses = splitContrastClauses(source);
  if (
    subClauses.length > 1 &&
    subClauses.some((sub) => isInstructionLine(sub) && coverageOf(sub, cNorm) >= limit)
  ) {
    return true;
  }
  const sNoNum = stripNumbersForTopic(proseOnly(sNorm));
  const cNoNum = stripNumbersForTopic(proseOnly(cNorm));
  const hasNonNumOverlap =
    coverageTokens(cNoNum).length === 0 ||
    coverageTokens(sNoNum).length === 0 ||
    coverageOf(cNoNum, sNoNum) >= Math.min(limit, 0.35) ||
    coverageOf(sNoNum, cNoNum) >= 0.25;
  if (
    hasNonNumOverlap &&
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

function clauseMatchesSource(source, candidate, limit) {
  if (clauseMatchesSingle(source, candidate, limit)) return true;
  const segments = localPolaritySegments(candidate);
  if (segments.length > 1 && segments.some((seg) => clauseMatchesSingle(source, seg, limit))) {
    return true;
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

function factUnitFamily(token) {
  if (token.startsWith('loc:')) return 'loc';
  const m = /^(-?\d+(?:\.\d+)?)([a-z%个次条]*)$/.exec(token);
  if (!m) return 'other';
  return unitFamily(m[2]).family;
}

function singleNumericFactMatches(sTok, cTok, sImplied, cImplied) {
  if (sTok === cTok) return true;
  const splitNum = (token) => {
    const m = /^(-?\d+(?:\.\d+)?)([a-z%个次条]*)$/.exec(token);
    return m ? { val: m[1], unit: m[2] } : null;
  };
  const sp = splitNum(sTok);
  const cp = splitNum(cTok);
  if (!sp || !cp || sp.val !== cp.val) return false;
  if (!sp.unit && cp.unit && sImplied.has(cp.unit)) return true;
  if (!cp.unit && sp.unit && cImplied.has(sp.unit)) return true;
  return false;
}

function numericFactsEquivalent(source, candidate, sNums, cNums) {
  if (JSON.stringify(sNums) === JSON.stringify(cNums)) return true;
  if (sNums.length > cNums.length) return false;
  const sImplied = identifierImpliedUnits(source);
  const cImplied = identifierImpliedUnits(candidate);
  if (sNums.length === cNums.length) {
    let positionalOk = true;
    for (let i = 0; i < sNums.length; i += 1) {
      if (!singleNumericFactMatches(sNums[i], cNums[i], sImplied, cImplied)) {
        positionalOk = false;
        break;
      }
    }
    if (positionalOk) return true;
    // Allow reordered facts only when every source fact belongs to a distinct unit family.
    const sFams = sNums.map(factUnitFamily);
    if (new Set(sFams).size !== sFams.length) return false;
    const used = new Set();
    for (const sTok of sNums) {
      const idx = cNums.findIndex((cTok, j) => !used.has(j) && singleNumericFactMatches(sTok, cTok, sImplied, cImplied));
      if (idx < 0) return false;
      used.add(idx);
    }
    return true;
  }
  // sNums.length < cNums.length: allow combined multi-number bullets only when
  // every source fact matches in order and every extra candidate fact belongs
  // to a strictly distinct unit family (e.g. scalar + duration, duration + size, or loc).
  const matchedIndices = new Set();
  const matchedTokens = [];
  let cursor = 0;
  for (const sTok of sNums) {
    let found = -1;
    for (let j = cursor; j < cNums.length; j += 1) {
      if (singleNumericFactMatches(sTok, cNums[j], sImplied, cImplied)) {
        found = j;
        break;
      }
    }
    if (found < 0) return false;
    matchedIndices.add(found);
    matchedTokens.push(cNums[found]);
    cursor = found + 1;
  }
  const sourceFamilies = new Set();
  for (const sTok of sNums) sourceFamilies.add(factUnitFamily(sTok));
  for (const cTok of matchedTokens) sourceFamilies.add(factUnitFamily(cTok));
  for (const u of sImplied) sourceFamilies.add(unitFamily(u).family);
  const candNorm = normalize(candidate);
  for (let j = 0; j < cNums.length; j += 1) {
    if (matchedIndices.has(j)) continue;
    const extra = cNums[j];
    const extraFamily = factUnitFamily(extra);
    if (sourceFamilies.has(extraFamily)) return false;
    if (extraFamily === 'scalar') {
      if (extra.startsWith('-')) return false;
      for (const mTok of matchedTokens) {
        const numMatch = /^(-?\d+(?:\.\d+)?)/.exec(mTok);
        if (!numMatch) continue;
        const escVal = numMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rangeOrAlt = new RegExp(
          `${escVal}\\s*${UNIT_OPT_RE}\\s*(?:[-–~+*/^]|(?:\\b(?:to|or)\\b|或)\\s*-?\\d)`,
          'i',
        );
        if (rangeOrAlt.test(candNorm)) return false;
      }
    }
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
  const strippedSrc = stripExplicitValueCorrection(stripSeqCitations(activeSource).replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim());
  const sScalar = scalarRequirement(strippedSrc);
  if (!sScalar || sScalar.subject.length < 2) return null;
  const esc = sScalar.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const candClean = normalize(stripInlineMarkdownFormatting(stripExplicitValueCorrection(stripSeqCitations(candidate))));
  const re = new RegExp(
    `(?<![a-z0-9_])${esc}(?:\\s*[:=：]?\\s*-?\\d+(?:\\.\\d+)?\\s*(?:->|→|=>)\\s*|\\s*(?:[:=：]|为|是|设为|设置为|保持(?:为)?|改为|改成|\\bmust\\s+be|\\bis|\\bset\\s+to)\\s*|\\s+)(-?\\d+(?:\\.\\d+)?)\\s*(ms|s|sec|seconds?|m|min|minutes?|h|hours?|d|days?|gb|gib|mb|mib|kb|kib|tb|bytes?|b|g|%|毫秒|秒|分钟?|小时|天|字节|个|次|条)?(?![a-z0-9_]|\\.[a-z0-9]|\\s*(?:->|→|=>))`,
    'gi',
  );
  const matches = [...candClean.matchAll(re)];
  if (matches.length === 0) return null;
  const sToken = `${sScalar.value}${sScalar.unit}`;
  for (const m of matches) {
    const after = candClean.slice(m.index + m[0].length);
    if (
      /^\s*(?:[*+÷×^/]|[-–](?=\S)|[-–]\s*[-\d(]|~|\.\.|\bto\s+[-\d(]|(?:\bor\b|或)\s*-?\d)/i.test(after) ||
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

const POLARITY_MAJOR_SPLIT_RE =
  /\s*(?:→|->|=>|⇒)\s*|[；;，]|(?<!\d),(?!\d)|(?=\s*(?:而不是|而非))|\s*(?:并且|而且|但是|不过|然而|反而)\s*|(?<![暂尚姑并而])且|(?<!不)但|(?<![从进因然反视一概取])而(?![已论定])/i;

const GOVERNING_NEG_BEFORE_BRACKET_RE =
  /(?:不允许|不应(?:当|该)?|不要(?!求)|不能|不得|不必|不用|禁止|(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人)|无需|不可(?!逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越)|不准|严禁|勿|没有|尚未|并未|未曾|并非|不再|取消|撤销|避免|免于|不(?![同仅但过论管断少足安便光止久妨料然如至]|得不)|未|\b(?:must\s+not|do\s+not|don't|never|forbidden|avoid|no|not|without)\b)\s*(?:包含|含有|含|附带|附|使用|用|执行|做|改|修改|删除|安装|装|允许|保留|给|写|启动|重启|部署)?\s*$/i;

function splitParentheticalSegments(clause) {
  const value = String(clause ?? '');
  if (!/[（(]/.test(value)) return [value];
  const opens = [];
  const spans = [];
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '（' || ch === '(') {
      opens.push({ ch, index: i });
    } else if (ch === '）' || ch === ')') {
      const expected = ch === '）' ? '（' : '(';
      if (opens.length > 0 && opens.at(-1).ch === expected) {
        const open = opens.pop();
        if (opens.length === 0) {
          spans.push({ start: open.index, end: i + 1, innerStart: open.index + 1, innerEnd: i });
        }
      }
    }
  }
  if (opens.length > 0) {
    const firstUnclosed = opens[0];
    const tail = value.slice(firstUnclosed.index + 1);
    if (tail.trim().length >= 4 && (/[「『]/.test(tail) || /\bseq\s*\d+/i.test(tail) || isInstructionLine(tail) || ruleNegative(tail))) {
      spans.push({ start: firstUnclosed.index, end: value.length, innerStart: firstUnclosed.index + 1, innerEnd: value.length });
    }
  }
  if (spans.length === 0) return [value];
  const out = [];
  let outer = '';
  let cursor = 0;
  for (const span of spans) {
    const before = value.slice(cursor, span.start);
    const prefix = (outer + before).trimEnd();
    const rawSpan = value.slice(span.start, span.end);
    EXPLICIT_PAREN_DISAVOWAL_RE.lastIndex = 0;
    if (GOVERNING_NEG_BEFORE_BRACKET_RE.test(prefix) || EXPLICIT_PAREN_DISAVOWAL_RE.test(rawSpan)) {
      outer += value.slice(cursor, span.end);
      cursor = span.end;
      continue;
    }
    outer += before + ' ';
    const inner = value.slice(span.innerStart, span.innerEnd).trim();
    if (inner) out.push(inner);
    cursor = span.end;
  }
  outer += value.slice(cursor);
  const outerClean = outer.replace(/\s+/g, ' ').trim();
  return outerClean ? [outerClean, ...out] : out;
}

function splitClauseEnumeration(segment) {
  const value = String(segment ?? '');
  if (!value.includes('、')) return [value];
  const parts = value.split('、').map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return [value];
  const merged = [parts[0]];
  for (let i = 1; i < parts.length; i += 1) {
    const item = parts[i];
    const act = actionState(item);
    const isClauseItem =
      /[「『]/.test(item) ||
      /\bseq\s*\d+/i.test(item) ||
      ruleNegative(item) ||
      isInstructionLine(item) ||
      Boolean(act && (act.negative || act.permission)) ||
      /[:：]/.test(item);
    if (isClauseItem) merged.push(item);
    else merged[merged.length - 1] += `、${item}`;
  }
  return merged;
}

const NOMINAL_RULE_HEAD_RE =
  /^(?:的|纪律|规范|原则|红线|约束|底线|禁令|守则|规则|条款|标准|要求|机制|策略|门禁|制度|前置条件|前提|检查|核对|清单)/;
const QUOTE_PERMISSION_OR_REVERSAL_RE =
  /(?:允许|可以|准许|放行|批准|授权|同意|放开|取消|撤销|废除|解除|不再|不必再|不用再|不要再|不能再|不得再|\b(?:allow(?:ed)?|permit(?:ted)?|approv(?:e|ed)|authori[sz](?:e|ed)|cancel|revoke)\b)/i;

function splitQuoteSegments(segment) {
  const value = String(segment ?? '');
  if (!/[「『]/.test(value)) return [value];
  const spans = [];
  let open = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (!open && (ch === '「' || ch === '『')) {
      open = { ch, index: i };
    } else if (open && ((open.ch === '「' && ch === '」') || (open.ch === '『' && ch === '』'))) {
      spans.push({ start: open.index, end: i + 1, innerStart: open.index + 1, innerEnd: i });
      open = null;
    }
  }
  if (open) {
    const tail = value.slice(open.index + 1);
    if (tail.trim().length >= 4 && (isInstructionLine(tail) || ruleNegative(tail))) {
      spans.push({ start: open.index, end: value.length, innerStart: open.index + 1, innerEnd: value.length });
    }
  }
  if (spans.length === 0) return [value];
  const detached = [];
  let outer = '';
  let cursor = 0;
  for (const span of spans) {
    const before = value.slice(cursor, span.start);
    const afterTail = value.slice(span.end);
    const prefix = (outer + before).trimEnd();
    const inner = value.slice(span.innerStart, span.innerEnd).trim();
    const hasPermissionOrReversalVerb =
      QUOTE_PERMISSION_OR_REVERSAL_RE.test(inner) ||
      (!ruleNegative(inner) && /直接/.test(inner));
    const inlineModifier =
      inner.length < 4 ||
      (NOMINAL_RULE_HEAD_RE.test(afterTail) && !hasPermissionOrReversalVerb);
    if (inlineModifier || GOVERNING_NEG_BEFORE_BRACKET_RE.test(prefix)) {
      outer += value.slice(cursor, span.end);
      cursor = span.end;
      continue;
    }
    outer += before + ' ';
    if (inner) detached.push(inner);
    cursor = span.end;
  }
  outer += value.slice(cursor);
  if (detached.length === 0) return [value];
  const outerStripped = stripSeqCitations(outer).replace(/[:：\s]+/g, ' ').trim();
  if (!outerStripped) return detached.length === 1 ? [value] : detached;
  return [outer.replace(/\s+/g, ' ').trim(), ...detached];
}

function localPolaritySegments(text) {
  const raw = stripExplicitValueCorrection(String(text ?? '').trim());
  if (!raw) return [];
  const literals = [];
  const masked = CODE_SPLIT_MASK(raw, literals);
  const majorParts = masked
    .split(POLARITY_MAJOR_SPLIT_RE)
    .map((p) => unmask(p, literals).trim())
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  const push = (seg) => {
    const cleaned = seg.trim();
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    out.push(cleaned);
  };
  for (const part of majorParts) {
    for (const parenSeg of splitParentheticalSegments(part)) {
      for (const enumSeg of splitClauseEnumeration(parenSeg)) {
        for (const quoteSeg of splitQuoteSegments(enumSeg)) {
          push(quoteSeg);
        }
      }
    }
  }
  return out;
}

const AFFIRMATIVE_GOVERNANCE_PRESERVATION_RE =
  /(?:维持|保持|遵守|恪守|坚守|严守|遵循|坚持|牢记|谨记|重申|强调|贯彻)[^。！？;；\n]{0,6}[「『]([^」』]{2,40})[」』](?:的)?(?:纪律|规范|原则|红线|约束|底线|禁令|守则|规则|门禁|制度)/;

function isAffirmativeGovernancePreservation(text) {
  const raw = String(text ?? '');
  const match = AFFIRMATIVE_GOVERNANCE_PRESERVATION_RE.exec(raw);
  if (!match) return false;
  const quotedInner = match[1];
  if (QUOTE_PERMISSION_OR_REVERSAL_RE.test(quotedInner) || (!ruleNegative(quotedInner) && /直接/.test(quotedInner))) {
    return false;
  }
  const outsideQuotes = raw.replace(/[「『][^」』]*[」』]/g, ' ').trim();
  if (ruleNegative(outsideQuotes)) return false;
  if (/(?:取消|撤销|废除|解除|放开|松绑|打破|突破|停止|终止|放弃|免除|不再|不必再|不用再|不要再|不能再|不得再)/i.test(outsideQuotes)) {
    return false;
  }
  return true;
}

function hasPolarityTopicOverlapSingle(srcText, candSeg, limit, contextSource = srcText) {
  const stripLeadingBullet = (t) => stripSeqCitations(t).replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim();
  const cleanSrc = stripExplicitValueCorrection(stripLeadingBullet(srcText));
  const cleanCand = stripExplicitValueCorrection(stripLeadingBullet(candSeg));
  const cleanContext =
    contextSource && contextSource !== srcText
      ? stripExplicitValueCorrection(stripLeadingBullet(contextSource))
      : cleanSrc;
  const sScalar = scalarRequirement(cleanSrc);
  const cScalar = scalarRequirement(cleanCand);
  if (scalarSubjectsIncompatible(sScalar, cScalar)) return false;
  const sa = actionState(srcText);
  const ca = actionState(candSeg);
  if (sa && ca && sameAction(sa, ca) && /[a-z\u4e00-\u9fff]/i.test(sa.key)) {
    return true;
  }
  if (scalarSubjectVerdict(srcText, candSeg) === 'match') {
    return true;
  }
  const sNormNoNum = stripNumbersForTopic(proseOnly(normalize(cleanSrc)));
  const sContextNormNoNum =
    cleanContext === cleanSrc ? sNormNoNum : stripNumbersForTopic(proseOnly(normalize(cleanContext)));
  const cNormNoNum = stripNumbersForTopic(proseOnly(normalize(cleanCand)));
  const sCore = stripNumbersForTopic(stripNegAndModal(cleanSrc));
  const cCore = stripNumbersForTopic(stripNegAndModal(cleanCand));
  const sCoreTokens = coverageTokens(sCore);
  const cCoreTokens = coverageTokens(cCore);
  if (
    sCoreTokens.length > 0 &&
    cCoreTokens.length > 0 &&
    coverageOf(sCore, cNormNoNum) >= Math.min(limit, 0.45) &&
    coverageOf(cCore, sContextNormNoNum) >= 0.25
  ) {
    return true;
  }
  if (
    coverageTokens(sNormNoNum).length > 0 &&
    coverageTokens(cNormNoNum).length > 0 &&
    coverageOf(sNormNoNum, cNormNoNum) >= limit
  ) {
    return true;
  }
  return false;
}

function hasPolarityTopicOverlap(normativeSource, candSeg, limit, contextSource = normativeSource) {
  if (hasPolarityTopicOverlapSingle(normativeSource, candSeg, limit, contextSource)) return true;
  const srcOuter = splitParentheticalSegments(normativeSource)[0];
  if (srcOuter && srcOuter !== normativeSource) {
    return hasPolarityTopicOverlapSingle(srcOuter, candSeg, limit, contextSource);
  }
  return false;
}

function isSegmentPolarityConflict(normativeSource, candSeg, srcNeg, limit, contextSource = normativeSource) {
  const candNeg = ruleNegative(candSeg);
  if (candNeg === srcNeg) return false;
  if (equivalentAntonymPolarity(normativeSource, candSeg, srcNeg, candNeg, limit)) return false;
  if (srcNeg && !candNeg && isAffirmativeGovernancePreservation(candSeg)) return false;
  return hasPolarityTopicOverlap(normativeSource, candSeg, limit, contextSource);
}

function hasSingleSourcePolarityConflict(
  normativeSource,
  candForPolarity,
  srcNeg,
  limit,
  segments,
  contextSource = normativeSource,
) {
  if (segments.length <= 1) {
    return isSegmentPolarityConflict(normativeSource, candForPolarity, srcNeg, limit, contextSource);
  }
  const matching = segments.filter((seg) => clauseMatchesSingle(normativeSource, seg, limit));
  if (matching.length === 0) {
    return isSegmentPolarityConflict(normativeSource, candForPolarity, srcNeg, limit, contextSource);
  }
  const sNorm = normalize(normativeSource);
  const sa = actionState(normativeSource);
  const scored = matching.map((seg) => {
    const segNorm = normalize(seg);
    const ca = actionState(seg);
    const sameAct = Boolean(sa && ca && sameAction(sa, ca));
    const fwd = coverageOf(normativeSource, segNorm);
    const rev = coverageOf(seg, sNorm);
    const score = (sameAct ? 2 : 0) + fwd + rev;
    const conflict = isSegmentPolarityConflict(normativeSource, seg, srcNeg, limit, contextSource);
    return { seg, sameAct, fwd, rev, score, conflict };
  });
  const bestScore = Math.max(...scored.map((x) => x.score));
  const top = scored.filter((x) => x.score >= bestScore - 0.35 || x.sameAct);
  return top.some((x) => x.conflict);
}

function hasPolarityConflict(normativeSource, candForPolarity, srcNeg, limit, contextSource = normativeSource) {
  const segments = localPolaritySegments(candForPolarity);
  if (segments.length > 1) {
    const srcSegments = localPolaritySegments(normativeSource);
    const srcHasMixedPolarity =
      srcSegments.length > 1 && new Set(srcSegments.map((s) => ruleNegative(s))).size > 1;
    if (srcHasMixedPolarity && coverageOf(normativeSource, normalize(candForPolarity)) >= 0.9) {
      return srcSegments.some((sub) => {
        if (!isInstructionLine(sub) && !ruleNegative(sub)) return false;
        return hasSingleSourcePolarityConflict(sub, candForPolarity, ruleNegative(sub), limit, segments, contextSource);
      });
    }
  }
  return hasSingleSourcePolarityConflict(normativeSource, candForPolarity, srcNeg, limit, segments, contextSource);
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
  const candForPolarity = cEx ? stripException(candNormative) : candNormative;

  if (isInstructionLine(normativeSource) && hasPolarityConflict(normativeSource, candForPolarity, srcNeg, limit, activeSource)) {
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

const UNIT_OPT_RE = '(?:ms|s|sec|seconds?|m|min|minutes?|h|hours?|d|days?|gb|gib|mb|mib|kb|kib|tb|bytes?|b|g|%|毫秒|秒|分钟?|小时|天|字节|个|次|条)?';
const HIST_TAG_ONLY_RE =
  '(?:previously|formerly|originally|initially|superseded|deprecated|retired|replaced|当时|原值|旧值|已修订|已取代|已弃用|已废弃|已替换|不再用|非现行)';

function isBoundHistoricalValue(sourceLine, candidate) {
  const strippedSrc = stripSeqCitations(sourceLine).replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim();
  const sScalar = scalarRequirement(strippedSrc);
  if (!sScalar || sScalar.subject.length < 2) return false;
  const esc = sScalar.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const candClean = normalize(stripSeqCitations(candidate)).replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim();
  const histLeadPrefix = '(?:(?:轮已输出|历史记录|历史快照)\\s*[:：]\\s*)?';
  const escActiveVal = String(sScalar.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (
    new RegExp(
      `^${histLeadPrefix}${esc}\\s*(?:was|were|原(?:为|是)?|曾(?:为|是)?)\\s*(?:[:=：]\\s*)?(?:null|-?\\d+(?:\\.\\d+)?\\s*${UNIT_OPT_RE})\\s*[,，;]\\s*(?:replaced\\s+by|updated\\s+to|changed\\s+to|superseded\\s+by|(?:已|现)?(?:改为|改成|替换为|替代为))\\s*${escActiveVal}\\s*${UNIT_OPT_RE}\\s*[。.!！;；]?$`,
      'i',
    ).test(candClean)
  ) {
    return true;
  }
  if (new Set(numericFacts(candidate)).size > 1) return false;
  const histTrailSuffix = `(?:\\s*[(（]\\s*(?:${HIST_TAG_ONLY_RE}|(?:不是|并非|not)\\s*-?\\d+(?:\\.\\d+)?\\s*${UNIT_OPT_RE})\\s*[)）]|\\s+\\b(?:was|is)\\s+(?:superseded|deprecated|retired|replaced)\\b)?\\s*[。.!！;；]?$`;
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
      `^${histLeadPrefix}${esc}\\s*[:=：]?\\s*(?:null|-?\\d+(?:\\.\\d+)?\\s*${UNIT_OPT_RE})\\s*(?:[(（]\\s*${HIST_TAG_ONLY_RE}\\s*[)）]|\\b(?:was|is)\\s+(?:superseded|deprecated|retired|replaced)\\b)\\s*[。.!！;；]?$`,
      'i',
    ).test(candClean)
  );
}

const ACTIVE_FILES_TAG_RE = /<active-workspace-files\b[^>]*>[\s\S]*?<\/active-workspace-files>/gi;

export function auditCompaction({ userMessages, summaryText, checkpointText, threshold, includeAllConflicts = false, referenceMessages = [] }) {
  const originalMessages = userMessages ?? [];
  const trustedMessages = originalMessages
    .filter((message) => !isReferenceContextKind(message.sourceKind) && !message.externalFold && !isSystemReminderOnly(message) && !isReferencePrefixOnly(message))
    .map((message) => ({ ...message, text: instructionText(message) }));

  const limit = typeof threshold === 'number' && Number.isFinite(threshold) ? threshold : 0.6;
  const rawCheckpoint = String(checkpointText ?? summaryText).replace(ACTIVE_FILES_TAG_RE, ' ');
  const haystack = normalize(rawCheckpoint.replace(/\*\*|__/g, ''));
  const summaryClauses = splitContrastClauses(summaryText ? summaryProse(summaryText) : '');
  const messageLines = trustedMessages.map((message) => ({
    message,
    lines: sourceEvidenceSentences(stripFencedCodeBlocks(message.text)).filter(
      (line) => isInstructionLine(line) || hasRequirementNumericCue(line),
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
      const lineNoCorrection = stripExplicitValueCorrection(line);
      let coverage = Math.max(
        coverageOf(line, haystack),
        lineNoCorrection !== line ? coverageOf(lineNoCorrection, haystack) : 0,
      );
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

const APPROVAL_SEQ_CITATION_RE =
  /(?:(?:(?<!现)在|(?<![关于对属基])于)\s*|\bin\s+)?(?:[（(\[]\s*)?(?:\bin\s+)?\bseqs?\s*#?\s*\d+(?:\s*[-–,]\s*\d+)*(?:\s*[）)\]])?\s*(?:中|里)?/gi;

function stripSeqCitationsForApproval(text) {
  return String(text ?? '')
    .replace(APPROVAL_SEQ_CITATION_RE, ' ')
    .replace(SEQ_CITATION_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const APPROVAL_CLAIM_RE =
  /(?:用户\s*(?:现在|已经|已|明确|现已)?\s*(?:批准|授权|同意|允许)|(?:已|已经)(?:获(?:得)?|得到)用户(?:授权|批准|同意)|\b(?:the\s+)?user\s+(?:has\s+)?(?:already\s+|explicitly\s+|now\s+)?(?:approved|authorized|authorised|permitted|allowed|consented|granted\s+permission)|\b(?:approved|authorized|authorised|permitted)\s+by\s+(?:the\s+)?user\b)/i;
const DIRECT_USER_APPROVAL_RE =
  /(?:^\s*(?:我\s*(?:现在|已经|已|明确|现已)?\s*(?:批准|授权|同意|允许)|i\s+(?:hereby\s+)?(?:authorize|authorise|approve|allow|permit|consent\s+to)\b))/im;
const UNTRUSTED_APPROVAL_SIGNAL_RE =
  /(?:(?:现已|已经|已|明确)?(?:批准|授权|同意|允许)|\b(?:approved|authorized|authorised|permitted|allowed|consented)\b)/i;
const NEGATED_OR_PENDING_APPROVAL_RE =
  /(?:未|不|没有得到|没有获得|没有|尚无|尚未|并非|等待|等候|待|如(?:果)?|只有|仅当|除非|前置条件|前提(?:是|为)?|须先|需先|必须先|先经|先获|未经|未获|若无|若未|如无|如未)[^。！？;；\n]{0,35}(?:授权|批准|允许|同意)|(?:授权|批准|允许|同意)[^。！？;；\n]{0,12}(?:之?前(?:不得|不能|不要|禁止|不可|须|需)|后(?:才|方)(?:可|能|允许))|\b(?:if|unless|pending|awaiting|not|no|without|prerequisite|precondition|requires?|must\s+first|before|prior\s+to|only\s+(?:if|when|after))\b[^.!?\n;]{0,55}\b(?:approval|permission|consent|approved|authorized|authorised|approve|authorize|authorise|permit|allow)\b/i;

const COLLOQUIAL_USER_APPROVAL_RE =
  /(?:(?:^|[，,]\s*)(?:(?:你|你们|助手|现在|那就)\s*)?(?:可以直接|可直接|可以|准许|放行|确认|(?:行|好的?|没问题)(?:\s*[，,]\s*(?:请|你|你们|直接|可以|那就)?|\s+))(?:你|你们|去|直接|现在|继续|再|先)?\s*[\u4e00-\u9fffa-z0-9]|\b(?:you\s+(?:can|may)(?:\s+(?:now|just|directly))?\s+[a-z]|ok(?:ay)?\s+to\s+[a-z]|go\s+ahead\s+(?:and|with|to)\s+[a-z]|feel\s+free\s+to\s+[a-z]|confirmed\s+(?:to|for)\s+[a-z]|yes,\s+(?:please\s+|you\s+(?:can|may)\s+|go\s+ahead\s+(?:and|with|to)\s+)?[a-z]))/i;
const COLLOQUIAL_NON_GRANT_RE =
  /(?:是否|能否|可否|能不能|可不可以|行不行|好不好|对不对|为什么|为何|怎么|如何|如果|倘若|假如|除非|只有|仅当|一旦|前提|前置条件|待确认|先确认|需确认|须确认|请确认|确认一下|不确定|先问我|问我|再定|暂缓|先等等|未必|谁说|难道|吗\s*$|\b(?:if|unless|whether|only\s+(?:if|when|after)|not\s+sure|uncertain|unsure|ask\s+me|confirm\s+with\s+me|before\s+confirming|wait\s+until)\b)/i;
const STANDALONE_AFFIRMATION_RE =
  /^(?:好的?|行|没问题|同意|批准|授权|允许|确认|可以|准许|ok(?:ay)?|yes|sure|agreed|confirmed)[。.!！\s]*$/i;
const ADVISORY_OR_OBSERVATION_PREFIX_RE =
  /^(?:注意|切记|切勿|谨记|提醒|提示|小心|别忘了|记得|顺便提一下|顺便说|另外注意|说明|备注|刚才|之前|以前|曾经|原来|当时|目前看来|好像|似乎|感觉|\b(?:note|caution|warning|reminder|remember|be\s+careful|fyi|btw|earlier|previously|currently|seems?)\b)/i;
const ACTION_DIRECTIVE_RE =
  /(?:^(?:请|麻烦|帮我|直接|顺便把|顺便|然后把|然后|接着把|接着|再把|再|并把|把|将)|(?:把|将)\S{1,24}(?:放进|放入|放到|放|移入|移到|存入|存进|存到|提交到?|推送到?|推上去|写进|写入|改为|改成|设为|设置为|删掉|删除|迁移到?|复制到?|同步到?)|(?:做|弄|搞)(?:一个|个)?[^\n。！？;；]{0,20}(?:私有)?(?:仓库|代码库|库|\brepo)|(?:发布|部署|推送|推上去|放进|放入|放到|创建|新建|建立|生成|删除|删掉|移除|清理|清除|保留|留存|修改|更新|调整|运行|执行|跑|测试|安装|配置|同步|迁移|复制|移动|提交|合并|写入|写进|打开|关闭|重启|整理|归档|上传|下载|备份|恢复)|\b(?:please|publish|deploy|push|put|place|store|create|make|add|delete|remove|clean|keep|retain|modify|update|run|execute|test|install|configure|sync|migrate|copy|move|commit|merge|write|open|close|restart|upload|download|backup|restore)\b)/i;

const APPROVAL_BOILERPLATE_RE =
  /(?:(?:我|用户)\s*(?:现在|已经|已|明确|现已|在此)?\s*(?:批准|授权|同意|允许)|(?:已|已经)?(?:获(?:得)?|得到)用户(?:授权|批准|同意)|\b(?:the\s+)?user\s+(?:has\s+)?(?:already\s+|explicitly\s+|now\s+)?(?:approved|authorized|authorised|permitted|allowed|consented|granted\s+permission(?:\s+(?:to|for))?)|\bi\s+(?:hereby\s+)?(?:authorize|authorise|approve|allow|permit|consent\s+to)|\b(?:approved|authorized|authorised|permitted)\s+by\s+(?:the\s+)?user|\bto\b|\bfor\b|\bthe\b)/gi;

const COLLOQUIAL_GRANT_STRIP_RE =
  /^(?:(?:你|你们|助手|现在|那就)\s*)?(?:可直接|可以直接|可以|准许|放行|确认|(?:好的?|行|没问题)(?:\s*[，,]\s*)?)+(?:请|你|你们|去|直接|现在|继续|再|先)?|^(?:yes[,\s]+(?:please\s+)?|ok(?:ay)?\s+to\s+|you\s+(?:can|may)(?:\s+(?:now|just|directly))?\s+|go\s+ahead\s+(?:and|with|to)\s+|feel\s+free\s+to\s+|confirmed\s+(?:to|for)\s+|please\s+)/gi;

const TEMPORAL_DIRECTIVE_LEAD_RE =
  /^(?:在\s*)?(?:[^\s，,。；;]{1,12}?(?:完成后|完毕后|结束后)|完成[^\s，,。；;]{1,12}?后(?![半续面边方端台期置退果悔代者来缀])|完成后|完毕后|结束后|之后|随后|然后|接着|再|请|麻烦|帮我|直接)\s*/i;

const REVOCATION_APPROVAL_RE =
  /\b(?:revoke|withdraw|cancel|rescind|reject|deny|forbid)\s+(?:my\s+|the\s+|this\s+)?(?:prior\s+|previous\s+)?(?:approval|authorization|authorisation|permission|consent)\b|\b(?:do\s+not|don't|no\s+longer|not)\s+(?:approve|authorize|authorise|permit|allow|consent)\b|(?:撤销|取消|收回|撤回|作废|不再|不|不要|禁止|拒绝)(?:之前|刚才|上述|先前的?)?(?:的)?(?:批准|授权|同意|允许)/i;

const COLLOQUIAL_REVOCATION_RE =
  /(?:(?:先不要|不要再|暂不|先?(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人|忘了|忘记)|取消|撤回|撤销)\s*(?:[\u4e00-\u9fffa-z0-9_/.-]|(?=\S))|^\s*cancel\s+(?:the\s+|this\s+|my\s+)?[a-z])/i;

const REVOCATION_BOILERPLATE_RE =
  /(?:(?:(?:我|用户)\s*)?(?:现在|已经|已|明确|现已|在此)?\s*(?:撤销|取消|收回|撤回|作废|不再|禁止|拒绝|先不要|不要再|暂不|不要|先?(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人|忘了|忘记)|不)\s*(?:之前|刚才|上述|先前的?)?(?:对)?(?:的)?(?:批准|授权|同意|允许)?|(?:之前|刚才|上述|先前的?)?(?:的)?(?:批准|授权|同意|允许)|\b(?:(?:i|the\s+user)\s+)?(?:hereby\s+)?(?:revoke|withdraw|cancel|rescind|reject|deny|forbid|do\s+not|don't|no\s+longer|not)\s+(?:my\s+|the\s+|this\s+)?(?:prior\s+|previous\s+)?(?:approval|authorization|authorisation|permission|consent|approve|authorize|authorise|permit|allow)?\b|\b(?:of|for|on|to|the|my|this)\b)/gi;

const COMPOUND_CLAIM_SPLIT_RE =
  /(?:并且|并在|(?<![一合兼吞归相])并(?![且不未无非]|购|入|发(?!送|布|起|出)|行(?!动|事)|列(?!出)|排(?!查|除)|存(?!档|储|放)|吞|网|联(?!系)|拢|肩|重|举|蒂|案)|以及|同时|\band\b)/i;

const PRIVATE_VISIBILITY_RE =
  /(?:私有|私密|不公开|非公开|\b(?:private|non-?public|unlisted)\b)/i;
const PUBLIC_VISIBILITY_RE =
  /(?:(?<![不非未])公开|公共|\b(?<!non-)(?<!not\s)public\b)/i;

const VERB_FAMILY_RES = [
  ['read', /(?:查看|读取|读|检查|检索|查询|浏览|只看|\b(?:read|view|inspect|list|check|search|query|browse)\b)/i],
  ['draft', /(?:起草|草拟|拟定|打草稿|草稿|\b(?:draft|compose|outline)\b)/i],
  ['write', /(?:写入|写进|修改|编辑|更新|更改|覆盖|保存|改动|\b(?:write|edit|modify|update|change|patch|overwrite|save)\b)/i],
  ['delete', /(?:删除|删掉|移除|清空|销毁|抹除|丢弃|清理|清除|\b(?:delete|drop|remove|purge|wipe|destroy|erase|rm|truncate)\b)/i],
  ['publish', /(?:发布|上线|部署|推送|推上去|(?<![不非未])公开|\b(?:publish|release|deploy|ship|push|broadcast)\b)/i],
  ['exec', /(?:执行|运行|重跑|重运行|启动|调用|\b(?:exec|execute|run|rerun|invoke|eval|launch|start)\b)/i],
  ['test', /(?:测试|单测|验证|校验|\b(?:test|tests|verify)\b)/i],
  ['repo_setup', /(?:放进|放入|放到|存进|存入|存到|移入|移到|创建|新建|建立|(?:做|弄|搞)(?:一个|个)?(?=[^\n。！？;；]{0,20}(?:私有)?(?:仓库|代码库|库|\brepo))|\b(?:put|place|store|create|make|init|initialize|setup|set\s+up)\b)/i],
];

const INCOMPATIBLE_VERB_FAMILY_PAIRS = new Set([
  'draft\0publish', 'publish\0draft',
  'read\0write', 'write\0read',
  'read\0delete', 'delete\0read',
  'read\0publish', 'publish\0read',
  'read\0exec', 'exec\0read',
  'exec\0delete', 'delete\0exec',
  'write\0delete', 'delete\0write',
  'write\0publish', 'publish\0write',
  'publish\0delete', 'delete\0publish',
  'repo_setup\0delete', 'delete\0repo_setup',
  'repo_setup\0publish', 'publish\0repo_setup',
  'test\0delete', 'delete\0test',
  'test\0publish', 'publish\0test',
  'test\0write', 'write\0test',
]);

const REPO_SETUP_STRIP_RE =
  /(?:把|将|源码|代码|工程|项目|文件|资料|一个|到|进|入|里|中|在|向|往|放进|放入|放到|放|存进|存入|存到|移入|移到|创建|新建|建立|\b(?:put|place|store|create|make|init|initialize|setup|set\s+up|push|source|code|files?|a|an|the|to|into|in|on|for)\b)/gi;

const stripApprovalBoilerplate = (text) =>
  normalize(stripSeqCitationsForApproval(text))
    .replace(APPROVAL_BOILERPLATE_RE, ' ')
    .replace(/(?:^|\s)[:：]+|[:：]+(?=\s|$)/g, ' ')
    .replace(/[。.!！?？;；，,…]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function stripTemporalDirectiveLead(text) {
  let value = normalize(text);
  if (/^(?:如果|倘若|假如|除非|只有|仅当|若|\b(?:if|unless)\b)/i.test(value)) return value;
  let prev;
  do {
    prev = value;
    value = value.replace(TEMPORAL_DIRECTIVE_LEAD_RE, '').trim();
  } while (value && value !== prev && !/^(?:如果|倘若|假如|除非|只有|仅当|若|\b(?:if|unless)\b)/i.test(value));
  return value || normalize(text);
}

function stripGrantBoilerplate(text) {
  let value = stripApprovalBoilerplate(text);
  let prev;
  do {
    prev = value;
    value = value
      .replace(COLLOQUIAL_GRANT_STRIP_RE, ' ')
      .replace(/^(?:(?:我|用户|你|你们)\s*)?(?:现已|已经|已|明确)?\s*(?:批准|授权|同意|允许|确认)\s*/i, ' ')
      .replace(/^\b(?:approved|authorized|authorised|permitted|allowed|consented)(?:\s+(?:to|for))?\b/i, ' ')
      .replace(/^(?:直接|去)\s+/i, ' ')
      .replace(/(?:^|\s)[:：]+|[:：]+(?=\s|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } while (value !== prev);
  return stripTemporalDirectiveLead(value);
}

const stripRevocationBoilerplate = (text) =>
  normalize(stripSeqCitationsForApproval(text))
    .replace(REVOCATION_BOILERPLATE_RE, ' ')
    .replace(/(?:^|\s)[:：]+|[:：]+(?=\s|$)/g, ' ')
    .replace(/[。.!！?？;；，,…]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function normApprovalInflections(text) {
  return normalize(text).replace(/\b([a-z]{3,})\b/g, (w) => {
    if (/(?:runn|sett|putt|shipp|stopp|dropp|gett|cutt|swapp|tagg|logg|committ)ing$/.test(w)) {
      return w.slice(0, -4);
    }
    if (/(?:creat|delet|updat|plac|stor|writ|remov|execut|configur|initiat|mov|merg|sav|eras|purg|truncat|approv|authori[sz]|enabl|disabl)ing$/.test(w)) {
      return `${w.slice(0, -3)}e`;
    }
    if (/ing$/.test(w) && w.length >= 6) return w.slice(0, -3);
    return w;
  });
}

function verbFamiliesOf(text) {
  const value = normApprovalInflections(text);
  const families = new Set();
  for (const [name, re] of VERB_FAMILY_RES) {
    if (re.test(value)) families.add(name);
  }
  return families;
}

function hasIncompatibleVerbFamily(srcText, claimText) {
  const sf = verbFamiliesOf(srcText);
  const cf = verbFamiliesOf(claimText);
  if (sf.size === 0 || cf.size === 0) return false;
  for (const a of sf) {
    for (const b of cf) {
      if (a === b) continue;
      if (INCOMPATIBLE_VERB_FAMILY_PAIRS.has(`${a}\0${b}`) && !sf.has(b) && !cf.has(a)) {
        return true;
      }
    }
  }
  return false;
}

function hasVisibilityConflict(a, b) {
  const pa = PRIVATE_VISIBILITY_RE.test(a);
  const pb = PRIVATE_VISIBILITY_RE.test(b);
  const ua = PUBLIC_VISIBILITY_RE.test(a);
  const ub = PUBLIC_VISIBILITY_RE.test(b);
  return (pa && ub) || (ua && pb);
}

function concreteTargetEntities(text) {
  const cleaned = normalize(text).replace(REPO_SETUP_STRIP_RE, ' ').replace(/\s+/g, ' ').trim();
  const entities = new Set();
  for (const m of cleaned.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = m[0];
    if (run.length >= 4) {
      entities.add(run);
      for (let i = 0; i <= run.length - 4; i += 1) {
        entities.add(run.slice(i, i + 4));
      }
    }
  }
  for (const m of cleaned.matchAll(/[a-z0-9][a-z0-9_.-]{2,}/g)) {
    entities.add(m[0]);
  }
  return { cleaned, entities };
}

const GENERIC_REPO_WORDS = new Set([
  'private', 'public', 'non-public', 'nonpublic', 'unlisted', 'local', 'internal', 'repo', 'repository', 'code', 'source', 'git', 'remote', 'push', 'the', 'and', 'to', 'into', 'for',
]);

function extraNamedEntitiesMatched(srcText, claimText) {
  const sNorm = normApprovalInflections(srcText);
  const cNorm = normApprovalInflections(claimText);
  for (const m of cNorm.matchAll(/[a-z0-9][a-z0-9_.-]{2,}/g)) {
    const tok = m[0];
    if (GENERIC_REPO_WORDS.has(tok)) continue;
    if (!sNorm.includes(tok)) return false;
  }
  return true;
}

function repoSetupParaphraseMatch(srcCore, claimCore) {
  const sf = verbFamiliesOf(srcCore);
  const cf = verbFamiliesOf(claimCore);
  if (!sf.has('repo_setup') || !cf.has('repo_setup')) return false;
  if (hasVisibilityConflict(srcCore, claimCore)) return false;
  if (!extraNamedEntitiesMatched(srcCore, claimCore)) return false;
  const a = concreteTargetEntities(srcCore);
  const b = concreteTargetEntities(claimCore);
  const hasSharedContainer =
    (/(?:仓库|代码库|库|\brepo(?:sitory)?\b)/i.test(srcCore) && /(?:仓库|代码库|库|\brepo(?:sitory)?\b)/i.test(claimCore)) ||
    (/(?:目录|文件夹|\bfolder\b|\bdir(?:ectory)?\b)/i.test(srcCore) && /(?:目录|文件夹|\bfolder\b|\bdir(?:ectory)?\b)/i.test(claimCore));
  if (hasSharedContainer && PRIVATE_VISIBILITY_RE.test(srcCore) && PRIVATE_VISIBILITY_RE.test(claimCore)) {
    return true;
  }
  for (const ent of a.entities) {
    if (ent.length >= 4 && b.entities.has(ent)) {
      if (/^(?:github|gitlab|gitee|bitbucket|private|local|internal)$/i.test(ent)) {
        if (hasSharedContainer) return true;
        continue;
      }
      return true;
    }
  }
  return false;
}

function samePushDirectiveMatch(srcCore, claimCore) {
  const sf = verbFamiliesOf(srcCore);
  const cf = verbFamiliesOf(claimCore);
  if (!sf.has('publish') || !cf.has('publish')) return false;
  if (hasVisibilityConflict(srcCore, claimCore)) return false;
  if (!extraNamedEntitiesMatched(srcCore, claimCore)) return false;
  const hasPush = (s) => /(?:推送|推上去|\bpush\b)/i.test(s);
  const hasCode = (s) => /(?:代码|源码|\bcode\b|\bsource\b)/i.test(s);
  return hasPush(srcCore) && hasPush(claimCore) && hasCode(srcCore) && hasCode(claimCore);
}

const QUALIFYING_SCOPE_RE =
  /(?:测试|生产|预发|本地|线上|正式|(?<![a-z])(?:staging|prod(?:uction)?|dev(?:elopment)?|local|test(?:ing)?)(?![a-z]))/i;
const QUALIFYING_EXCEPTION_RE =
  /(?:除了|除外|不含|不包括|不涉及|\b(?:except|excluding|without)\b)/i;
const QUALIFYING_CONDITIONAL_RE =
  /(?:如果|倘若|假如|除非|只有|仅当|前提|前置|\b(?:if|unless|only)\b)/i;

const PROVENANCE_CONDITIONAL_CUE_RE =
  /(?:如果|倘若|假如|除非|只有|仅当|\b(?:if|unless|only\s+(?:if|when|after))\b)/i;
const PROVENANCE_TRAILING_ADVISORY_RE =
  /(?<=[)）])\s*(?=注意|切记|提醒|记得|别忘了)/;

function extractClosedParens(text) {
  const value = String(text ?? '');
  if (!/[（(]/.test(value)) return [];
  const opens = [];
  const spans = [];
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '（' || ch === '(') {
      opens.push({ ch, index: i });
    } else if (ch === '）' || ch === ')') {
      const expected = ch === '）' ? '（' : '(';
      if (opens.length > 0 && opens.at(-1).ch === expected) {
        const open = opens.pop();
        if (opens.length === 0) {
          spans.push({ start: open.index, end: i + 1, inner: value.slice(open.index + 1, i) });
        }
      }
    }
  }
  return spans;
}

function scopeKeysOf(text) {
  const keys = new Set();
  const str = String(text ?? '');
  if (/(?:生产|线上|正式|(?<![a-z])prod(?:uction)?(?![a-z]))/i.test(str)) keys.add('prod');
  if (/(?:预发(?:布)?|(?<![a-z])staging(?![a-z]))/i.test(str)) keys.add('staging');
  if (/(?:测试|(?<![a-z])test(?:ing)?(?![a-z]))/i.test(str)) keys.add('test');
  if (/(?:本地|(?<![a-z])local(?![a-z]))/i.test(str)) keys.add('local');
  if (/(?<![a-z])dev(?:elopment)?(?![a-z])/i.test(str)) keys.add('dev');
  return keys;
}

function nonParenScopeKeysOf(text) {
  const keys = new Set();
  const str = String(text ?? '');
  if (/(?:生产|线上|正式|(?<![a-z])prod(?:uction)?(?![a-z]))/i.test(str)) keys.add('prod');
  if (/(?:预发(?:布)?|(?<![a-z])staging(?![a-z]))/i.test(str)) keys.add('staging');
  if (/(?:测试环境|仅测试|(?<![a-z])test\s+env(?:ironment)?(?![a-z]))/i.test(str)) keys.add('test');
  if (/(?:本地环境|仅本地|(?<![a-z])local\s+env(?:ironment)?(?![a-z]))/i.test(str)) keys.add('local');
  if (/(?:开发环境|(?<![a-z])dev(?:elopment)?\s+env(?:ironment)?(?![a-z]))/i.test(str)) keys.add('dev');
  return keys;
}

function isQualifyingParenBody(inner) {
  const body = String(inner ?? '').trim();
  if (!body) return false;
  if (QUALIFYING_SCOPE_RE.test(body)) return true;
  if (QUALIFYING_EXCEPTION_RE.test(body) || exceptionTarget(body) !== null) return true;
  if (numericFacts(body).length > 0) return true;
  if (QUALIFYING_CONDITIONAL_RE.test(body)) return true;
  if (PRIVATE_VISIBILITY_RE.test(body) || PUBLIC_VISIBILITY_RE.test(body)) return true;
  if (negationsOf(body).length > 0) return true;
  if (allTransferPairs(body).length > 0) return true;
  return false;
}

function stripNonQualifyingParens(text) {
  const value = String(text ?? '');
  const spans = extractClosedParens(value);
  if (spans.length === 0) return value;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += value.slice(cursor, span.start);
    if (isQualifyingParenBody(span.inner)) {
      out += value.slice(span.start, span.end);
    } else {
      out += ' ';
    }
    cursor = span.end;
  }
  out += value.slice(cursor);
  return out.replace(/\s+/g, ' ').trim();
}

const BARE_APPROVAL_VERB_RE =
  /^(?:(?:去|继续)\s*)?(?:发布|上线|部署|删除|删掉|移除|清理|清除|执行|运行|重跑|启动|调用|写入|写进|修改|更改|更新|覆盖|推送|推上去|创建|新建|建立|安装|配置|publish|release|deploy|ship|delete|remove|drop|purge|rm|run|exec|execute|write|edit|modify|update|push|create|make|install)$/i;
const APPROVAL_LEADING_VERB_RE =
  /^(?:发布|上线|部署|删除|删掉|移除|清理|清除|执行|运行|重跑|启动|调用|写入|写进|修改|更改|更新|覆盖|推送|推上去|创建|新建|建立|安装|配置|publish|release|deploy|ship|delete|remove|drop|purge|rm|run|exec|execute|write|edit|modify|update|push|create|make|install)(?:\s+|$|(?=[\u4e00-\u9fffa-z0-9（(]))/i;
const GENERIC_RELEASE_OBJECT_RE =
  /^(?:更新|新版|新版本|版本|变更|改动|(?:the\s+|this\s+|new\s+)?(?:updates?|releases?|changes?))$/i;

function isBareApprovalVerb(core) {
  const value = normalize(core)
    .replace(/[。.!！?？;；，,…]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return false;
  return BARE_APPROVAL_VERB_RE.test(value) || BARE_APPROVAL_VERB_RE.test(normApprovalInflections(value));
}

function hasConcreteApprovalObject(strippedSCore) {
  let rest = normalize(strippedSCore)
    .replace(/[。.!！?？;；，,…]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!rest) return false;
  const inflected = normApprovalInflections(rest);
  if (APPROVAL_LEADING_VERB_RE.test(rest)) {
    rest = rest.replace(APPROVAL_LEADING_VERB_RE, '').trim();
  } else if (APPROVAL_LEADING_VERB_RE.test(inflected)) {
    rest = inflected.replace(APPROVAL_LEADING_VERB_RE, '').trim();
  } else {
    rest = rest
      .replace(/^(?:把|将)\s*/, '')
      .replace(/(?:发布|上线|部署|删除|删掉|移除|清理|清除|执行|运行|写入|修改|更改|更新|推送|创建|新建)$/, '')
      .trim();
  }
  if (!rest) return false;
  return !GENERIC_RELEASE_OBJECT_RE.test(rest);
}

function approvalTargetsMatch(srcCore, srcClause, claimCore, claimSentence, { isRevocation = false } = {}) {
  const sCore = isRevocation ? srcCore : stripTemporalDirectiveLead(srcCore);
  const cCore = isRevocation ? claimCore : stripTemporalDirectiveLead(claimCore);
  if (!sCore || !cCore) return false;
  if (!scopesCompatible(srcClause, claimSentence)) return false;
  const sDirs = allTransferPairs(sCore);
  const cDirs = allTransferPairs(cCore);
  const srcPairs = sDirs.length ? sDirs : allTransferPairs(srcClause);
  const claimPairs = cDirs.length ? cDirs : allTransferPairs(claimSentence);
  if ((srcPairs.length > 0 || claimPairs.length > 0) && JSON.stringify(srcPairs) !== JSON.stringify(claimPairs)) {
    return false;
  }
  const sEx = exceptionTarget(sCore) ?? exceptionTarget(srcClause);
  const cEx = exceptionTarget(cCore) ?? exceptionTarget(claimSentence);
  if (isRevocation) {
    if (cEx && sEx !== cEx) return false;
  } else if ((sEx || cEx) && sEx !== cEx) {
    return false;
  }
  const sNums = numericFacts(sCore);
  const cNums = numericFacts(cCore);
  if (isRevocation ? cNums.length > 0 && JSON.stringify(sNums) !== JSON.stringify(cNums) : JSON.stringify(sNums) !== JSON.stringify(cNums)) {
    return false;
  }
  if (!isRevocation && hasIncompatibleVerbFamily(sCore, cCore)) {
    return false;
  }
  if (!isRevocation && hasVisibilityConflict(sCore, cCore)) {
    return false;
  }
  if (!isRevocation && !extraNamedEntitiesMatched(srcClause, cCore)) {
    return false;
  }

  const cleanSrcClause = normalize(stripSeqCitationsForApproval(srcClause));
  const punctNormSrcClause = cleanSrcClause.replace(/[、，,]+/g, ' ').replace(/\s+/g, ' ').trim();
  const strippedSrcClause = stripNonQualifyingParens(punctNormSrcClause);
  const punctNormSCore = normalize(sCore).replace(/[、，,]+/g, ' ').replace(/\s+/g, ' ').trim();
  const strippedSCore = stripNonQualifyingParens(punctNormSCore);
  const punctNormCCore = normalize(cCore).replace(/[、，,]+/g, ' ').replace(/\s+/g, ' ').trim();

  if (!isRevocation) {
    const srcNonParenScope = nonParenScopeKeysOf(srcClause);
    const claimAllScope = scopeKeysOf(claimSentence);
    for (const k of srcNonParenScope) {
      if (!claimAllScope.has(k)) return false;
    }
    for (const k of claimAllScope) {
      if (/^(?:prod|staging)$/.test(k) && !scopeKeysOf(srcClause).has(k)) return false;
    }
    const claimNorm = normalize(claimSentence);
    for (const span of extractClosedParens(strippedSCore)) {
      const inner = span.inner.trim();
      if (!inner) continue;
      for (const k of scopeKeysOf(inner)) {
        if (!claimAllScope.has(k)) return false;
      }
      if (QUALIFYING_CONDITIONAL_RE.test(inner)) {
        if (!QUALIFYING_CONDITIONAL_RE.test(claimSentence) || coverageOf(inner, claimNorm) < 0.7) {
          return false;
        }
      }
      const innerNegView = inner.replace(/(?:不公开|非公开)/g, ' ');
      if (negationsOf(innerNegView).length > 0) {
        if (negationsOf(claimSentence).length === 0 || coverageOf(inner, claimNorm) < 0.7) {
          return false;
        }
      }
      if (PRIVATE_VISIBILITY_RE.test(inner) && !PRIVATE_VISIBILITY_RE.test(claimSentence)) {
        return false;
      }
      if (PUBLIC_VISIBILITY_RE.test(inner) && !PUBLIC_VISIBILITY_RE.test(claimSentence)) {
        return false;
      }
    }
    if (PROVENANCE_CONDITIONAL_CUE_RE.test(srcClause) && !PROVENANCE_CONDITIONAL_CUE_RE.test(claimSentence)) {
      return false;
    }
    for (const span of extractClosedParens(cCore)) {
      const inner = span.inner.trim();
      if (!inner) continue;
      const innerNorm = inner.replace(/[、，,]+/g, ' ').replace(/\s+/g, ' ').trim();
      const cov = Math.max(
        coverageOf(innerNorm, punctNormSrcClause),
        coverageOf(normApprovalInflections(innerNorm), normApprovalInflections(punctNormSrcClause)),
      );
      if (cov < 0.75) {
        return false;
      }
    }
    const sfAll = verbFamiliesOf(sCore);
    const cfAll = verbFamiliesOf(cCore);
    if (cfAll.has('delete') && !sfAll.has('delete')) {
      return false;
    }
    if (isBareApprovalVerb(cCore) && hasConcreteApprovalObject(strippedSCore)) {
      return false;
    }
  }

  const sa = actionState(sCore) ?? actionState(strippedSCore);
  const ca = actionState(cCore);
  if (isRevocation && coverageOf(sEx ? stripException(sCore) : sCore, normalize(cCore)) >= 0.7) return true;
  if (sa && ca) {
    if (sa.negative !== ca.negative) return false;
    if (sameAction(sa, ca)) return true;
  }
  if (!isRevocation && (repoSetupParaphraseMatch(sCore, cCore) || samePushDirectiveMatch(sCore, cCore))) {
    return true;
  }
  if (sa && ca && sa.verb !== ca.verb) {
    const sf = verbFamiliesOf(sCore);
    const cf = verbFamiliesOf(cCore);
    const sharedFamily = [...sf].some((f) => cf.has(f));
    if (!sharedFamily) return false;
  }
  const srcTargets = [cleanSrcClause, punctNormSrcClause, strippedSrcClause];
  for (const target of srcTargets) {
    if (
      coverageOf(cCore, target) >= 0.75 ||
      coverageOf(punctNormCCore, target) >= 0.75 ||
      coverageOf(normApprovalInflections(cCore), normApprovalInflections(target)) >= 0.75 ||
      coverageOf(normApprovalInflections(punctNormCCore), normApprovalInflections(target)) >= 0.75
    ) {
      return true;
    }
  }
  return false;
}

function rawMessageText(m) {
  if (typeof m?.text === 'string') return m.text;
  if (Array.isArray(m?.blocks)) return m.blocks.map((b) => String(b?.text ?? '')).join('\n');
  if (typeof m?.content === 'string') return m.content;
  if (Array.isArray(m?.content)) {
    return m.content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n');
  }
  return '';
}

function splitCompoundClaimParts(claimCore) {
  const value = String(claimCore ?? '').trim();
  if (!value) return [];
  return value.split(COMPOUND_CLAIM_SPLIT_RE).map((p) => p.trim()).filter(Boolean);
}

const REPO_CONTEXT_FOR_PRIVATE_MOD_RE =
  /(?:仓库|代码库|源码|存放|github|gitlab|gitee|\brepo(?:s|sitor(?:y|ies))?\b)/i;
const REPO_PAREN_PRIVATE_MOD_RE =
  /[（(]\s*(?:(?:私有|私密|不公开|非公开|\b(?:private|non-?public|unlisted)\b)(?:\s*[、，,/]\s*|\s+))*(?:不公开|非公开)(?:(?:\s*[、，,/]\s*|\s+)(?:私有|私密|不公开|非公开|\b(?:private|non-?public|unlisted)\b))*\s*[)）]/gi;
const REPO_AFTER_VERB_PRIVATE_MOD_RE =
  /(?<=(?:仓库|代码库|存放|创建|新建|建立|放进|放入|放到|设为|设置为)(?:为|的|一个|个)?\s*)[不非]公开/g;

function stripRepoPrivateModifierForNegCheck(clause) {
  const value = String(clause ?? '');
  if (!REPO_CONTEXT_FOR_PRIVATE_MOD_RE.test(value)) return value;
  return value
    .replace(REPO_PAREN_PRIVATE_MOD_RE, ' ')
    .replace(REPO_AFTER_VERB_PRIVATE_MOD_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function maskBalancedParensForSplit(text, parens) {
  const value = String(text ?? '');
  const spans = extractClosedParens(value);
  if (spans.length === 0) return value;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += value.slice(cursor, span.start);
    parens.push(value.slice(span.start, span.end));
    out += `\uE002${parens.length - 1}\uE003`;
    cursor = span.end;
  }
  out += value.slice(cursor);
  return out;
}

function unmaskParens(text, parens) {
  return text.replace(/\uE002(\d+)\uE003/g, (_, idx) => parens[Number(idx)] ?? '');
}

function maskBackticksForSplit(text, literals) {
  return String(text ?? '').replace(/`+[^`\n]*`+/g, (part) => {
    literals.push(part);
    return `\uE004${literals.length - 1}\uE005`;
  });
}

function unmaskBackticks(text, literals) {
  return text.replace(/\uE004(\d+)\uE005/g, (_, idx) => literals[Number(idx)] ?? '');
}

function splitProvenanceClauses(sent) {
  const raw = String(sent ?? '').trim();
  if (!raw || /^\s*#{1,6}\s/.test(raw)) return [];
  if (conditionParts(raw) || PROVENANCE_CONDITIONAL_CUE_RE.test(raw)) return [raw];
  const codeLiterals = [];
  const codeMasked = maskBackticksForSplit(raw, codeLiterals);
  const parens = [];
  const parenMasked = maskBalancedParensForSplit(codeMasked, parens);
  const out = [];
  for (const piece of splitContrastClauses(parenMasked)) {
    const withParens = unmaskParens(piece, parens).trim();
    if (!withParens) continue;
    const unmaskedFull = unmaskBackticks(withParens, codeLiterals).trim();
    if (conditionParts(unmaskedFull) || PROVENANCE_CONDITIONAL_CUE_RE.test(unmaskedFull)) {
      out.push(unmaskedFull);
      continue;
    }
    for (const sub of withParens.split(PROVENANCE_TRAILING_ADVISORY_RE)) {
      const clean = unmaskBackticks(sub, codeLiterals).trim();
      if (clean) out.push(clean);
    }
  }
  return out;
}

const LEADING_APPROVAL_CLAIM_RE = new RegExp(`^(?:${APPROVAL_CLAIM_RE.source})`, 'i');
const PAREN_APPROVAL_CLAIM_RE = new RegExp(`[（(]\\s*(?=${APPROVAL_CLAIM_RE.source})`, 'i');

function extractParenWrappedClaim(cleanSentence) {
  const value = String(cleanSentence ?? '').trim();
  if (!value || LEADING_APPROVAL_CLAIM_RE.test(value)) return null;
  const match = PAREN_APPROVAL_CLAIM_RE.exec(value);
  if (!match) return null;
  const openIdx = match.index;
  const outerPrefix = value.slice(0, openIdx).trim();
  const openCh = value[openIdx];
  const closeCh = openCh === '（' ? '）' : ')';
  let depth = 1;
  let closeIdx = -1;
  for (let i = openIdx + 1; i < value.length; i += 1) {
    if (value[i] === openCh) depth += 1;
    else if (value[i] === closeCh) {
      depth -= 1;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx >= 0) {
    const trailing = value.slice(closeIdx + 1).trim();
    if (trailing && !/^[。.!！?？;；…]+$/.test(trailing)) return null;
    const inner = value.slice(openIdx + 1, closeIdx).trim();
    return inner ? { outerPrefix, inner } : null;
  }
  const inner = value.slice(openIdx + 1).trim();
  return inner ? { outerPrefix, inner } : null;
}

/**
 * Channel-based compaction laundering defense:
 * rejects summary claims of user approval/authorization unless a matching,
 * unrevoked verified user channel approval backs that specific action/scope.
 */
export function auditInstructionProvenance({ userMessages = [], referenceMessages = [], summaryText }) {
  const isUntrustedSource = (m) =>
    isReferenceContextKind(m.sourceKind) ||
    Boolean(m.externalFold) ||
    isSystemReminderOnly(m) ||
    isReferencePrefixOnly(m);
  const verifiedMessages = userMessages
    .filter((m) => !isUntrustedSource(m))
    .slice()
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  let activeGrants = [];
  let revokedGrants = [];
  const pushGrant = (clause, core) => {
    if (!core) return;
    activeGrants.push({ clause, core });
    if (
      allTransferPairs(clause).length === 0 &&
      !conditionParts(clause) &&
      !exceptionTarget(clause) &&
      !/(?:如果|除非|只有|仅当|\bif\b|\bunless\b)/i.test(clause)
    ) {
      const parts = splitCompoundClaimParts(core);
      if (parts.length >= 2) {
        for (const part of parts) {
          const cleanPart = stripTemporalDirectiveLead(part);
          if (cleanPart) activeGrants.push({ clause, core: cleanPart });
        }
      }
    }
  };

  for (const m of verifiedMessages) {
    const rawText = stripFencedCodeBlocks(instructionText(m));
    const msgEntries = [];
    let messageHasGrant = false;

    for (const sent of sourceEvidenceSentences(rawText)) {
      const cleanSent = stripSeqCitationsForApproval(sent);
      const sentQuestion = isPureQuestion(sent) || /[?？]\s*$/.test(sent.trim());
      const sentHasConditional = PROVENANCE_CONDITIONAL_CUE_RE.test(cleanSent);

      for (const clause of splitProvenanceClauses(sent)) {
        const cleanClause = stripSeqCitationsForApproval(clause);
        const exTarget = exceptionTarget(cleanClause);
        const clauseNegView = stripRepoPrivateModifierForNegCheck(
          exTarget ? stripException(cleanClause) : cleanClause,
        );
        const clauseQuestion = sentQuestion || isPureQuestion(clause) || /[?？]\s*$/.test(clause.trim());
        const isFormalClaim = APPROVAL_CLAIM_RE.test(cleanClause) || DIRECT_USER_APPROVAL_RE.test(cleanClause);
        const isRevoke =
          REVOCATION_APPROVAL_RE.test(cleanClause) ||
          COLLOQUIAL_REVOCATION_RE.test(cleanClause) ||
          (isFormalClaim && NEGATED_OR_PENDING_APPROVAL_RE.test(cleanClause));
        if (isRevoke) {
          const revCore = stripRevocationBoilerplate(cleanClause);
          revokedGrants.push({ seq: m.seq, clause: cleanClause, core: revCore });
          activeGrants = activeGrants.filter((g) => {
            if (!scopesCompatible(cleanClause, g.clause)) return true;
            if (!revCore) return false;
            return !approvalTargetsMatch(g.core, g.clause, revCore, cleanClause, { isRevocation: true });
          });
          msgEntries.push({ clause, cleanClause, kind: 'revoke' });
          continue;
        }
        const isFormalGrant = isFormalClaim && !NEGATED_OR_PENDING_APPROVAL_RE.test(cleanClause);
        const isColloquialGrant =
          !clauseQuestion &&
          !sentHasConditional &&
          !NEGATED_OR_PENDING_APPROVAL_RE.test(cleanClause) &&
          !ruleNegative(clauseNegView) &&
          !COLLOQUIAL_NON_GRANT_RE.test(cleanClause) &&
          COLLOQUIAL_USER_APPROVAL_RE.test(cleanClause);
        if (isFormalGrant || isColloquialGrant) {
          messageHasGrant = true;
          const core = stripGrantBoilerplate(cleanClause);
          pushGrant(cleanClause, core);
          msgEntries.push({ clause, cleanClause, kind: 'grant' });
          continue;
        }
        if (!clauseQuestion && !sentHasConditional && STANDALONE_AFFIRMATION_RE.test(cleanClause)) {
          messageHasGrant = true;
          msgEntries.push({ clause, cleanClause, kind: 'affirmation' });
          continue;
        }
        msgEntries.push({ clause, cleanClause, kind: 'other', clauseQuestion, sentHasConditional });
      }
    }

    if (messageHasGrant) {
      for (const entry of msgEntries) {
        if (entry.kind !== 'other') continue;
        const { cleanClause, clauseQuestion, sentHasConditional } = entry;
        if (clauseQuestion || sentHasConditional) continue;
        const exTarget = exceptionTarget(cleanClause);
        const clauseNegView = stripRepoPrivateModifierForNegCheck(
          exTarget ? stripException(cleanClause) : cleanClause,
        );
        if (!cleanClause || ruleNegative(clauseNegView) || NEGATED_OR_PENDING_APPROVAL_RE.test(cleanClause)) continue;
        if (COLLOQUIAL_NON_GRANT_RE.test(cleanClause) || conditionParts(cleanClause)) continue;
        if (ADVISORY_OR_OBSERVATION_PREFIX_RE.test(cleanClause)) continue;
        if (!ACTION_DIRECTIVE_RE.test(cleanClause)) continue;
        const core = stripGrantBoilerplate(cleanClause);
        if (core) pushGrant(cleanClause, core);
      }
    }
  }

  const untrustedRefs = [
    ...userMessages.flatMap((m) =>
      (isUntrustedSource(m) ? [rawMessageText(m)] : referenceTexts(m)).map((text) => ({ seq: m.seq, text })),
    ),
    ...referenceMessages.map((m) => ({ seq: m.seq ?? -1, text: m.text })),
  ];
  const refSeq =
    untrustedRefs.find((r) => {
      const clean = stripSeqCitationsForApproval(r.text);
      return (
        !NEGATED_OR_PENDING_APPROVAL_RE.test(clean) &&
        (APPROVAL_CLAIM_RE.test(clean) || DIRECT_USER_APPROVAL_RE.test(clean) || UNTRUSTED_APPROVAL_SIGNAL_RE.test(clean))
      );
    })?.seq ??
    untrustedRefs[0]?.seq ??
    -1;

  const grantMatchesClaim = (claimCore, claimSentence, outerPrefix = '') =>
    activeGrants.some((g) => {
      if (!scopesCompatible(g.clause, claimSentence)) return false;
      if (outerPrefix) {
        if (ruleNegative(outerPrefix) || hasIncompatibleVerbFamily(g.core, outerPrefix)) return false;
      }
      if (!claimCore) return true;
      return approvalTargetsMatch(g.core, g.clause, claimCore, claimSentence);
    });

  const lost = [];
  for (const sentence of splitContrastClauses(summaryText ? summaryProse(summaryText) : '')) {
    const cleanSentence = stripSeqCitationsForApproval(sentence);
    if (!APPROVAL_CLAIM_RE.test(cleanSentence)) continue;
    if (NEGATED_OR_PENDING_APPROVAL_RE.test(cleanSentence)) continue;

    const claimCore = stripApprovalBoilerplate(cleanSentence);
    if (grantMatchesClaim(claimCore, cleanSentence)) continue;

    const parenWrapped = extractParenWrappedClaim(cleanSentence);
    const innerClaimCore = parenWrapped ? stripApprovalBoilerplate(parenWrapped.inner) : '';
    if (innerClaimCore) {
      if (grantMatchesClaim(innerClaimCore, cleanSentence, parenWrapped.outerPrefix)) continue;
      const innerHasTransfer =
        allTransferPairs(parenWrapped.inner).length > 0 || allTransferPairs(innerClaimCore).length > 0;
      if (!innerHasTransfer) {
        const innerParts = splitCompoundClaimParts(innerClaimCore);
        if (
          innerParts.length >= 2 &&
          innerParts.every((part) => grantMatchesClaim(part, cleanSentence, parenWrapped.outerPrefix))
        ) {
          continue;
        }
      }
    }

    let unbackedParts = claimCore ? [claimCore] : [];
    const hasTransfer = allTransferPairs(cleanSentence).length > 0 || allTransferPairs(claimCore).length > 0;
    if (claimCore && !hasTransfer) {
      const parts = splitCompoundClaimParts(claimCore);
      if (parts.length >= 2) {
        const missing = parts.filter((part) => !grantMatchesClaim(part, cleanSentence));
        if (missing.length === 0) continue;
        unbackedParts = missing;
      }
    }
    if (innerClaimCore && !unbackedParts.includes(innerClaimCore)) {
      unbackedParts = [...unbackedParts, innerClaimCore];
    }

    let matchedUntrustedSeq = null;
    const untrustedSourceMatch = untrustedRefs.some((ref) => {
      const refRaw = String(ref.text ?? '');
      for (const rcSent of sourceEvidenceSentences(stripFencedCodeBlocks(refRaw))) {
        for (const rc of splitProvenanceClauses(rcSent)) {
          const cleanRc = stripSeqCitationsForApproval(rc);
          if (NEGATED_OR_PENDING_APPROVAL_RE.test(cleanRc)) continue;
          if (
            !(
              APPROVAL_CLAIM_RE.test(cleanRc) ||
              DIRECT_USER_APPROVAL_RE.test(cleanRc) ||
              COLLOQUIAL_USER_APPROVAL_RE.test(cleanRc) ||
              UNTRUSTED_APPROVAL_SIGNAL_RE.test(cleanRc)
            )
          ) {
            continue;
          }
          const rcCore = stripGrantBoilerplate(cleanRc);
          if (!claimCore || !rcCore) {
            matchedUntrustedSeq = ref.seq;
            return true;
          }
          const targetHit =
            approvalTargetsMatch(rcCore, cleanRc, claimCore, cleanSentence) ||
            unbackedParts.some((part) => approvalTargetsMatch(rcCore, cleanRc, part, cleanSentence)) ||
            coverageOf(claimCore, normalize(cleanRc)) >= 0.5 ||
            unbackedParts.some((part) => coverageOf(part, normalize(cleanRc)) >= 0.5);
          if (targetHit) {
            matchedUntrustedSeq = ref.seq;
            return true;
          }
        }
      }
      return false;
    });

    const revokedMatch = revokedGrants.some((r) => {
      if (!scopesCompatible(r.clause, cleanSentence)) return false;
      if (!r.core) return true;
      return (
        approvalTargetsMatch(r.core, r.clause, claimCore, cleanSentence, { isRevocation: true }) ||
        unbackedParts.some((part) => approvalTargetsMatch(r.core, r.clause, part, cleanSentence, { isRevocation: true }))
      );
    });

    lost.push({
      seq: matchedUntrustedSeq ?? refSeq,
      line: sentence,
      candidate: sentence,
      coverage: 0,
      reason: 'provenance',
      untrustedSourceMatch,
      revokedMatch,
    });
  }
  return lost;
}

const PROVENANCE_SECRET_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{8,})\b/gi;

function sanitizeProvenanceExcerpt(text, maxLen = 160) {
  const cleaned = String(text ?? '')
    .replace(PROVENANCE_SECRET_RE, '[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

/** Summarize provenance audit findings into hard (untrusted/revoked) vs soft diagnostics. */
export function summarizeProvenanceFailures(provenanceLost) {
  const items = Array.isArray(provenanceLost) ? provenanceLost : [];
  const hardProvenance = items.filter((item) => item?.untrustedSourceMatch === true || item?.revokedMatch === true);
  const softProvenance = items.filter((item) => !(item?.untrustedSourceMatch === true || item?.revokedMatch === true));
  const first = hardProvenance[0] ?? softProvenance[0] ?? null;
  const provenanceKind = first?.untrustedSourceMatch
    ? 'untrusted-source'
    : first?.revokedMatch
      ? 'revoked'
      : 'missing-source';
  const provenanceLine = sanitizeProvenanceExcerpt(first?.line ?? first?.candidate ?? '');
  return { hardProvenance, softProvenance, provenanceKind, provenanceLine };
}
