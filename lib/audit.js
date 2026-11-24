// Domain-agnostic constraint, polarity, numeric/condition, and provenance auditor.
// Zero LLM calls; operates on summaryProse() so verbatim Section 6 cannot mask prose reversals.

import { summaryProse } from './validate.js';
import { actionState, sameAction } from './action-state.js';
import { isReferenceContextKind } from './source-provenance.js';
import { instructionText, isReferencePrefixOnly, isSystemReminderOnly, referenceTexts } from './instruction-source.js';

const NON_NEGATIVE_AVOID_RE =
  /(?:(?:不可|不能|难以|难于|无法|无从|并非|不是|不必|不用|无需|不要|不得|别)避免|避免(?:不了|不得|不掉)|(?:为(?:了)?|以)(?:避免|杜绝))/g;
const INEVITABILITY_MODAL_RE =
  /(?:(?:不可|不能|难以|难于|无法|无从)避免(?:地|的)?|避免(?:不了|不得|不掉)(?:的)?|不得不)/g;

const CN_MODAL = /不允许|不应(?:当|该)?|不(?=修改|删除|运行|调用|安装|部署|上传|下载|发送|联网|覆盖|发布|写入|写库|重启|终止|降低|改)|必须|不要(?!求)|不能|不得|禁止|记得|务必|只能|一定要|(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人)|需要|请|注意|不可(?!逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越)|无需|不准|不许|严禁|勿|(?<!为了?|以)杜绝|免于|(?<!不可|不能|难以|难于|无法|无从|并非|不是|不必|不用|无需|不要|不得|别|为了?|以)避免(?!不了|不得|不掉)|只有|仅当|如果|除非|每当|一旦/;
const EN_MODAL = /\b(?:must|shall|never|always|only|ensure|remember|required(?:\s+to)?|forbid(?:s|den|ding)?|disallow(?:s|ed|ing)?|ban(?:s|ned|ning)?|prohibit(?:s|ed|ing)?(?:\s+from)?|ought\s+(?:not\s+)?to|avoid|should|please|unless|if|when)\b|\b(?:may\s+not|do\s+not|don't)\b/i;
const COMMAND = /^(?:you\s+)?(?:use|run|keep|retain|preserve|delete|remove|restart|deploy|copy|move|sync|transfer|output|format)\b|^(?:保留|删除|运行|使用|发布|重启|复制|输出|跑\s)/;
const LABEL = /^(?:output(?:\s+format)?|format|port|timeout|retention|limit|输出格式|输出|端口|超时|保留时间|限制)\s*[:：]/;

const NEGATION =
  /不允许|不应(?:当|该)?|不要(?!求)|不能|不得|不必|不用|禁止|(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人)|无需|不可(?!逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越)|不准|不许|严禁|勿|(?<!为了?|以)杜绝|免于|(?<!不可|不能|难以|难于|无法|无从|并非|不是|不必|不用|无需|不要|不得|别|为了?|以)避免(?!不了|不得|不掉)|没有|尚未|并未|未曾|不(?:实际|直接|擅自)|不(?![同仅但过论管断少足安便光止久妨料然如至]|得不|可(?:逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越))(?=[\u4e00-\u9fff])|未(?=执行|运行|调用|修改|删除|写入|安装|重启|强停|改|降|提|kill|restart|append)|\b(?:must\s+not|shall\s+not|may\s+not|ought\s+not\s+to|prohibited\s+from|do\s+not|don't|never|forbid(?:s|den|ding)?|disallow(?:s|ed|ing)?|ban(?:s|ned|ning)?|prohibit(?:s|ed|ing)?|avoid|no|not)\b/g;

const CJK_RUN = /[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g;
const CONDITIONAL_PREFIX_RE =
  /^(?:(?:说明|注意|另外|后续|以后|其实|因此|当前)[^,，。；;\n]{0,12}?)?(?:(only\s+)?(if|when|unless)\s+(.+?)|(只有当|只有|只要|仅当|如果|倘若|假如|除非|若|每当|一旦|当)(.+?))[,，]\s*(.+)$/i;
const TEMPORAL_CONDITIONAL_PREFIX_RE =
  /^(?:(?:说明|注意|另外|后续|以后|其实|因此|当前)[^,，。；;\n]{0,12}?)?(?:(在)([^,，。；;\n]{2,80}?(?:完毕(?:之|以)?后|完成(?:之|以)?后|结束(?:之|以)?后|之后|以后|之前|以前|的时候|(?<![超实及暂随同定临长短])时))|(等到?)([^,，。；;\n]{2,80}?(?:完毕(?:之|以)?后|完成(?:之|以)?后|结束(?:之|以)?后|之后|以后|的时候|(?<![超实及暂随同定临长短])时|后)))[,，]\s*(.+)$/;
const PAST_NARRATIVE_TIME_RE =
  /(?:昨天|前天|昨晚|刚才|刚刚|上次|上回|上周|上个月|去年|那天|那时|当时|此前|先前|曾经|当初|今天(?:早上|上午|中午|下午|晚上)|\d{4}\s*[-/年]\s*\d{1,2}(?:\s*[-/月]\s*\d{1,2})?)/;
const CONDITIONAL_SUFFIX_RE =
  /^(?:>\s*)*(?:only\s+)?(.+?)\s+(?:only\s+)?(if|when|unless)\s+([^.,;!?\n]+)[.!?;]*$/i;

/**
 * Linear-time O(n) inline backtick span replacement (never spans newlines and
 * never backtracks catastrophically on long unclosed backtick runs).
 */
function replaceInlineBackticks(text, replacer, { exactTickCount = false, maxInnerChars = Infinity } = {}) {
  const src = String(text ?? '');
  if (!src.includes('`')) return src;
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const nextTick = src.indexOf('`', i);
    if (nextTick < 0) {
      out += src.slice(i);
      break;
    }
    if (nextTick > i) {
      out += src.slice(i, nextTick);
      i = nextTick;
    }
    let openEnd = i;
    while (openEnd < n && src[openEnd] === '`') openEnd += 1;
    const tickCount = openEnd - i;
    const lineEndRaw = src.indexOf('\n', openEnd);
    const lineEnd = lineEndRaw < 0 ? n : lineEndRaw;
    const searchLimit = Number.isFinite(maxInnerChars)
      ? Math.min(lineEnd, openEnd + maxInnerChars + tickCount + 8)
      : lineEnd;

    let matchCloseStart = -1;
    let matchCloseEnd = -1;
    let scan = openEnd;
    while (scan < searchLimit) {
      const cand = src.indexOf('`', scan);
      if (cand < 0 || cand >= searchLimit) break;
      let candEnd = cand;
      while (candEnd < lineEnd && src[candEnd] === '`') candEnd += 1;
      const candLen = candEnd - cand;
      if (!exactTickCount) {
        if (!Number.isFinite(maxInnerChars) || cand - openEnd <= maxInnerChars) {
          matchCloseStart = cand;
          matchCloseEnd = candEnd;
          break;
        }
      } else if (candLen === tickCount && cand > openEnd && cand - openEnd <= maxInnerChars) {
        matchCloseStart = cand;
        matchCloseEnd = candEnd;
        break;
      }
      scan = candEnd;
    }

    if (matchCloseStart >= 0) {
      const full = src.slice(i, matchCloseEnd);
      const inner = src.slice(openEnd, matchCloseStart);
      out += replacer(full, inner, src.slice(i, openEnd));
      i = matchCloseEnd;
    } else {
      out += src.slice(i, openEnd);
      i = openEnd;
    }
  }
  return out;
}

const CODE_SPLIT_MASK = (text, literals) => {
  const ticksMasked = replaceInlineBackticks(String(text ?? ''), (part) => {
    literals.push(part);
    return `\uE000${literals.length - 1}\uE001`;
  });
  return ticksMasked.replace(
    /(?:[a-z]:[/\\]|https?:\/\/)[^\s`，。；（）]*[^\s`，。；（）.!?]|(?<![\w.])\d+(?:[.,]\d+)+(?:[a-z%]+(?![\w])|(?![\w.]))|\b[a-z_]\w*(?:\.[a-z0-9_-]+)+\b/gi,
    (part) => {
      literals.push(part);
      return `\uE000${literals.length - 1}\uE001`;
    },
  );
};

function unmask(text, literals) {
  return text.replace(/\uE000(\d+)\uE001/g, (_, idx) => literals[Number(idx)] ?? '');
}

function proseOnly(text) {
  const unticked = replaceInlineBackticks(String(text ?? ''), (_value, inner) =>
    /^(?:do\s+not\s+|must\s+|shall\s+|may\s+not\s+|ought\s+|never\s+|always\s+|不要(?!求)|必须|不能)/i.test(inner)
      ? inner
      : ' ',
  );
  return unticked.replace(/--[a-z][\w-]*|\bnot\s+null\b/gi, ' ');
}

const normalizeCache = new Map();

function normalize(text) {
  const raw = String(text ?? '');
  if (raw.length <= 512) {
    const cached = normalizeCache.get(raw);
    if (cached !== undefined) return cached;
  }
  const out = raw
    .normalize('NFC')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (raw.length <= 512) {
    if (normalizeCache.size >= 4096) normalizeCache.clear();
    normalizeCache.set(raw, out);
  }
  return out;
}

export function negationsOf(line) {
  const text = proseOnly(line).toLowerCase().replace(NON_NEGATIVE_AVOID_RE, ' ');
  return [...new Set([...text.matchAll(NEGATION)].map((m) => m[0]))];
}

const DOUBLE_NEGATION_RE =
  /(?:不要|不能|不得|不可(?!逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越)|切勿|严禁|(?<![分区识个特级差类性鉴告离甄辨判派])别)\s*(?:不(?![同仅但过论管断少足安便光止久妨料然如至])|没(?:有)?|未)|不得不|\b(?:do\s+not|don't|must\s+not|shall\s+not|may\s+not|ought\s+not\s+to|never|cannot|can't)\s+(?:avoid\s+\w+ing\b|not\b|fail\s+to\b)/i;

const UNIT_SUFFIX_OPT_RE =
  '(?:\\s*(?:ms|s|sec|seconds?|months?|m|min|minutes?|h|hours?|d|days?|weeks?|years?|yrs?|gb|gib|mb|mib|kb|kib|tb|tib|bytes?|b|g|%|毫秒|秒|分钟?|小时|天|个月|周|星期|年|字节|个|次|条))?';
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
  ['week', 'w'], ['weeks', 'w'], ['周', 'w'], ['星期', 'w'],
  ['month', 'mo'], ['months', 'mo'], ['个月', 'mo'],
  ['yr', 'y'], ['yrs', 'y'], ['year', 'y'], ['years', 'y'], ['年', 'y'],
  ['b', 'b'], ['byte', 'b'], ['bytes', 'b'], ['字节', 'b'],
  ['kb', 'kb'], ['kib', 'kib'], ['mb', 'mb'], ['mib', 'mib'], ['g', 'gb'], ['gb', 'gb'], ['gib', 'gib'], ['tb', 'tb'], ['tib', 'tib'],
  ['%', '%'],
]);

const UNIT_BASE_FACTOR = new Map([
  ['ms', { family: 'duration', factor: 1 }],
  ['s', { family: 'duration', factor: 1000 }],
  ['min', { family: 'duration', factor: 60000 }],
  ['h', { family: 'duration', factor: 3600000 }],
  ['d', { family: 'duration', factor: 86400000 }],
  ['w', { family: 'duration', factor: 604800000 }],
  ['b', { family: 'size', factor: 1 }],
  ['kb', { family: 'size', factor: 1024 }],
  ['kib', { family: 'size', factor: 1024 }],
  ['mb', { family: 'size', factor: 1048576 }],
  ['mib', { family: 'size', factor: 1048576 }],
  ['gb', { family: 'size', factor: 1073741824 }],
  ['gib', { family: 'size', factor: 1073741824 }],
  ['tb', { family: 'size', factor: 1099511627776 }],
  ['tib', { family: 'size', factor: 1099511627776 }],
]);

function splitNumUnit(token) {
  const m = /^(-?\d+(?:\.\d+)?)([a-z%个次条]*)$/.exec(String(token ?? ''));
  return m ? { val: m[1], unit: m[2] } : null;
}

function canonicalQuantity(numStr, unit) {
  const spec = UNIT_BASE_FACTOR.get(unit);
  if (!spec) return null;
  const n = Number(numStr);
  if (!Number.isFinite(n)) return null;
  return { family: spec.family, baseValue: n * spec.factor };
}

function canonicalValuesEqual(a, b) {
  return Math.abs(a - b) <= Math.max(1e-9, Math.max(Math.abs(a), Math.abs(b)) * 1e-12);
}

function canonicalFactToken(token) {
  const parts = splitNumUnit(token);
  if (!parts) return String(token ?? '');
  const canon = canonicalQuantity(parts.val, parts.unit);
  if (!canon) return token;
  const rounded =
    Math.abs(canon.baseValue - Math.round(canon.baseValue)) <= 1e-9
      ? Math.round(canon.baseValue)
      : Number(canon.baseValue.toPrecision(12));
  return `${canon.family}:${rounded}`;
}

function canonicalNumsKey(text) {
  return numericFacts(text).map(canonicalFactToken).join(',');
}

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
  if (['ms', 's', 'min', 'h', 'd', 'w', 'mo', 'y'].includes(u)) return { family: 'duration', unit: u };
  if (['b', 'kb', 'kib', 'mb', 'mib', 'gb', 'gib', 'tb', 'tib'].includes(u)) return { family: 'size', unit: u };
  return { family: u ? 'unit' : 'scalar', unit: u };
}

const scalarRequirementCache = new Map();

/** Parse simple `<subject> [= | 改为 | must be | ...] <number><unit?>` scalar assignments. */
export function scalarRequirement(text) {
  const input = String(text ?? '').trim();
  const cacheable = input.length <= 512;
  if (cacheable && scalarRequirementCache.has(input)) {
    return scalarRequirementCache.get(input);
  }
  const cacheAndReturn = (val) => {
    if (cacheable) {
      if (scalarRequirementCache.size >= 2048) scalarRequirementCache.clear();
      scalarRequirementCache.set(input, val);
    }
    return val;
  };
  const raw = stripExplicitValueCorrection(input);
  if (!raw || raw.length > 512) return cacheAndReturn(null);
  let value = raw
    .replace(/^(?:当前|目前|现行(?:有效)?|仍生效的?)(?:\s*[:：]\s*)?/, '')
    .replace(/[。.!！?？;；，,]+$/, '');
  if (!value || value.length > 256) return cacheAndReturn(null);
  if (/[`"'“”‘’「」『』<>{}[\]/\\]|如果|除非|只有|仅当|否则|或者|要么|(?:^|[，,])\s*(?:若|当)/.test(value)) return cacheAndReturn(null);
  value = value.replace(/[，,]\s*(?:替代|取代)(?:先前|原先|之前|此前|旧的)?\s*-?\d+(?:\.\d+)?[^\n。；;]*$/, '').trim();
  const match =
    /^(.{1,80}?)\s*(必须为|设为|设置为|保持(?:为)?|改为|改成|是|为|[:=：]|\bmust\s+be|\bshall\s+be|\bis|\bset\s+to)?\s*(-?\d+(?:\.\d+)?)(\s*)(ms|s|sec|seconds?|months?|m|min|minutes?|h|hours?|d|days?|weeks?|years?|yrs?|gb|gib|mb|mib|kb|kib|tb|tib|bytes?|b|g|%|毫秒|秒|分钟?|小时|天|个月|周|星期|年|字节|个|次|条)?$/i.exec(
      value,
    );
  if (!match) return cacheAndReturn(null);
  const rawSubject = match[1];
  const explicitOp = Boolean(match[2]);
  const rawUnit = match[5] ?? '';
  if (isNonQuantityTechTerm(match[3], match[4], rawUnit, value)) return cacheAndReturn(null);
  if (rawUnit && /第\s*$/.test(rawSubject)) return cacheAndReturn(null);
  if (rawUnit === '年' && /^(?:19|20)\d{2}$/.test(match[3])) return cacheAndReturn(null);
  if (!explicitOp && !rawUnit) return cacheAndReturn(null);
  const hasLeadingSpace = !explicitOp && (/\s$/.test(rawSubject) || /\s(?=-?\d)/.test(value.slice(rawSubject.length)));
  if (!explicitOp && !hasLeadingSpace && /[a-z0-9_.-]$/i.test(rawSubject)) return cacheAndReturn(null);
  const subject = normalize(rawSubject).replace(/\s+/g, ' ');
  const num = Number(match[3]);
  if (!subject || !Number.isFinite(num)) return cacheAndReturn(null);
  const normalizedNum = /^-?\d+$/.test(match[3]) && !Number.isSafeInteger(num) ? match[3] : num;
  const { family, unit } = unitFamily(rawUnit);
  return cacheAndReturn(Object.freeze({ subject, family, value: normalizedNum, unit }));
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
  if (coverageTokenCache.size >= 4096) coverageTokenCache.clear();
  const frozen = Object.freeze(out);
  coverageTokenCache.set(key, frozen);
  return frozen;
}

const CJK_BIGRAM_RE = /^[\u4e00-\u9fff\u3400-\u4dbf]{2}$/;
const cjkBigramCache = new Map();
const coverageMemo = new Map();

function asciiWordsOf(text) {
  let words = asciiWordCache.get(text);
  if (!words) {
    if (asciiWordCache.size >= 2048) asciiWordCache.clear();
    const matches = text.match(ASCII_WORD_RUN_RE);
    words = matches ? new Set(matches.map((w) => w.toLowerCase())) : new Set();
    asciiWordCache.set(text, words);
  }
  return words;
}

function cjkBigramsOf(text) {
  let bigrams = cjkBigramCache.get(text);
  if (!bigrams) {
    if (cjkBigramCache.size >= 2048) cjkBigramCache.clear();
    bigrams = new Set();
    for (const m of text.matchAll(CJK_RUN)) {
      const run = m[0];
      for (let i = 0; i < run.length - 1; i += 1) {
        bigrams.add(run.slice(i, i + 2));
      }
    }
    cjkBigramCache.set(text, bigrams);
  }
  return bigrams;
}

export function coverageOf(line, summaryNormalized) {
  const lineKey = String(line ?? '');
  const haystack = String(summaryNormalized ?? '');
  const memoizable = lineKey.length <= 512 && haystack.length <= 512;
  let innerMemo;
  if (memoizable) {
    innerMemo = coverageMemo.get(haystack);
    if (innerMemo) {
      const hitScore = innerMemo.get(lineKey);
      if (hitScore !== undefined) return hitScore;
    }
  }
  const parts = coverageTokens(lineKey);
  if (parts.length === 0) return 1;
  const seen = new Map();
  let asciiWords = null;
  let cjkBigrams = null;
  let hit = 0;
  for (const token of parts) {
    let matched = seen.get(token);
    if (matched === undefined) {
      if (ASCII_TOKEN_RE.test(token)) {
        asciiWords ??= asciiWordsOf(haystack);
        matched = asciiWords.has(token.toLowerCase());
      } else if (CJK_BIGRAM_RE.test(token) && haystack.length <= 2048) {
        cjkBigrams ??= cjkBigramsOf(haystack);
        matched = cjkBigrams.has(token);
      } else {
        matched = haystack.includes(token);
      }
      seen.set(token, matched);
    }
    if (matched) hit += 1;
  }
  const score = hit / parts.length;
  if (memoizable) {
    if (!innerMemo) {
      if (coverageMemo.size >= 512) coverageMemo.clear();
      innerMemo = new Map();
      coverageMemo.set(haystack, innerMemo);
    }
    if (innerMemo.size >= 512) innerMemo.clear();
    innerMemo.set(lineKey, score);
  }
  return score;
}

const SOURCE_EVIDENCE_PART_RE =
  /[^.!?。！？；;]+[.!?。！？；;]*[」』”’"']*|[」』”’"']*[^.!?。！？；;]+$/g;
const LEGACY_SOURCE_EVIDENCE_PART_RE =
  /[^.!?。！？；;]+[.!?。！？；;]*|[^.!?。！？；;]+$/g;

function splitSourceEvidenceSentences(text, partRe) {
  const literals = [];
  const masked = CODE_SPLIT_MASK(text, literals);
  const out = [];
  for (const line of masked.split(/\r?\n/)) {
    const strippedLine = line.replace(/^\s*(?:\d+[.)](?=\s)|\(\d+\)\s+|[-*•+]\s+)/, '');
    if (!strippedLine.trim()) continue;
    const parts = strippedLine.match(partRe) ?? [strippedLine];
    for (const part of parts) {
      const restored = unmask(part, literals);
      if (restored.trim()) out.push(restored);
    }
  }
  return out;
}

export function sourceEvidenceSentences(text) {
  return splitSourceEvidenceSentences(text, SOURCE_EVIDENCE_PART_RE);
}

export function sourceEvidenceSentencesLegacyQuoteSplit(text) {
  return splitSourceEvidenceSentences(text, LEGACY_SOURCE_EVIDENCE_PART_RE);
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
  /必须|务必|一定要|禁止|严禁|不得|不能|不要(?!求)|不允许|不可(?!逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越)|不准|不许|勿|请(?!问)|\b(?:must(?:\s+not)?|shall(?:\s+not)?|may\s+not|ought\s+(?:not\s+)?to|required\s+to|prohibited\s+from|never|forbid(?:s|den|ding)?|disallow(?:s|ed|ing)?|ban(?:s|ned|ning)?|prohibit(?:s|ed|ing)?|do\s+not|don't|please)\b/i;
const QUESTION_STARTER_RE =
  /^(?:为什么|为何|怎么|怎样|如何|请问|是否|是不是|能否|可否|能不能|可不可以|要不要|需不需要|有没有|会不会|建议|\b(?:why|what|how|when|where|who|whom|whose|which|should|would|could|can|may|might|must|do|does|did|is|are|was|were|have|has|had|will|shall|ought)\b)/i;
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

const UNPUNCTUATED_CN_PARTICLE_Q_RE = /[吗呢么]\s*$/;
const CN_A_NOT_A_Q_RE = /(?:能不能|可不可以|是不是|要不要|需不需要|有没有|会不会|行不行|好不好|对不对|能否|可否)/g;
const CN_WH_Q_START_RE =
  /^(?:为什么|为何|怎么|怎样|如何|请问|是否|是不是|能否|可否|能不能|可不可以|要不要|需不需要|有没有|会不会)/;
const CN_WH_PURE_START_RE = /^(?:为什么|为何|请问)/;

function isPureQuestion(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return false;
  const hasQuestionMark = /[?？]\s*$/.test(trimmed);
  const endsDeclarative = /[。.!！;；]\s*$/.test(trimmed);
  const hasUnpunctuatedTailQ = !hasQuestionMark && !endsDeclarative && UNPUNCTUATED_CN_PARTICLE_Q_RE.test(trimmed);
  const hasUnpunctuatedFormQ =
    !hasQuestionMark &&
    !endsDeclarative &&
    !conditionParts(trimmed) &&
    (CN_A_NOT_A_Q_RE.test(trimmed) || CN_WH_Q_START_RE.test(trimmed));
  CN_A_NOT_A_Q_RE.lastIndex = 0;

  if (!hasQuestionMark && !hasUnpunctuatedTailQ && !hasUnpunctuatedFormQ) return false;
  if (POLITE_IMPERATIVE_Q_RE.test(trimmed) && !/[吗呢么]\s*[?？]?\s*$/.test(trimmed)) {
    return false;
  }
  const commaMatch = /^(.+?)[,，;；]\s*([^,，;；]+)$/.exec(trimmed);
  if (commaMatch && hasPreClauseDirective(commaMatch[1])) {
    return false;
  }
  if (hasUnpunctuatedTailQ) {
    return true;
  }
  if (hasUnpunctuatedFormQ) {
    const withoutANotA = normalize(trimmed).replace(CN_A_NOT_A_Q_RE, ' ').replace(/\s+/g, ' ').trim();
    if (CN_WH_PURE_START_RE.test(trimmed) && !LABEL.test(withoutANotA)) {
      return true;
    }
    if (STRONG_DIRECTIVE_RE.test(withoutANotA) || COMMAND.test(withoutANotA) || LABEL.test(withoutANotA)) {
      return false;
    }
    return true;
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

const TEMPORAL_CONSEQUENCE_ACTION_RE =
  /^(?:再|才|就|先|立即|马上|直接|然后|随后|接着)?(?:合并|推送|发布|部署|执行|检查|通知|总结|归纳|备份|回滚|清理|删除|保留|关闭|开启|重启|修改|更新|运行|跑\b|stop\b|merge\b|push\b|deploy\b|run\b|check\b|notify\b)/i;
const PAST_OBSERVATION_TAIL_RE = /(?:看到|发现|注意到|遇到|出现|报错|崩溃|卡住|成功了|失败了|通过了|结束了)/;

function isInstructionLine(line) {
  const raw = String(line ?? '').trim();
  const lower = normalize(raw);
  if (!lower) return false;
  if (/^\s*#{1,6}\s/.test(lower)) return false;
  if (isPureQuestion(raw)) return false;
  if (CN_MODAL.test(lower) || EN_MODAL.test(lower) || COMMAND.test(lower) || LABEL.test(lower) || scalarRequirement(line) !== null) {
    return true;
  }
  const cond = conditionParts(raw);
  return Boolean(
    cond &&
      TEMPORAL_CONSEQUENCE_ACTION_RE.test(cond.consequence.trim()) &&
      !PAST_OBSERVATION_TAIL_RE.test(cond.consequence),
  );
}

const SEQ_CITATION_RE =
  /(?:\[\s*seqs?\s+\d+(?:\s*[-–,]\s*\d+)*\s*\]|[（(]\s*seqs?\s+\d+(?:\s*[-–,]\s*\d+)*\s*[)）]|\bseqs?\s*#?\s*\d+(?:\s*[-–,]\s*\d+)*\b|\bseqs?\s*[=:]\s*\d+\b|\bphase\s*#?\d+\b|>\s*user source\s*\(seq\s+\d+\),\s*verbatim:)/gi;

const stripSeqCitations = (text) => String(text ?? '').replace(SEQ_CITATION_RE, ' ');

const LOC_REF_RE = /(?<![a-z0-9_./-])([a-z0-9_./-]{1,120}\.[a-z]{1,6}):(\d+(?:-\d+)?)/gi;
const NON_QUANTITY_NUM_RE =
  /(?<![a-z0-9_./-])\d{4}\/\d{1,2}\/\d{1,2}(?![a-z0-9_./-])|(?<!\d)\d{4}\s*年\s*(?:1[0-2]|0?[1-9])\s*月(?:\s*(?:3[01]|[12]\d|0?[1-9])\s*[日号])?|(?<!\d)(?:1[0-2]|0?[1-9])\s*月\s*(?:3[01]|[12]\d|0?[1-9])\s*[日号]|(?<!\d)(?:19|20)\d{2}\s*年|第\s*\d+\s*(?:年|个月|周|星期|天|日|季度|月)|(?:^|[\s(（\[【])(?:规则|条款|条件|要点|要求|原则|约束|步骤|阶段|项目|条目|注意事项|说明|问题|任务|事项|rule|step|item|point|requirement)\s*#?\d+\s*[:：、.)）]|第\s*\d+\s*(?:条|项|点|步|款|章|节)\s*[:：、.)）]|(?:^|\n)\s*\d+\s*(?:\.(?!\d)\s+|[)）、]\s*)|(?<![a-z0-9_./-])(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?![a-z0-9_./-])|(?<![a-z0-9_])#\d+\b|(?<![a-z0-9_.-])v\d+(?:\.\d+)+(?![a-z0-9_.-])/gi;

const numericFactsCache = new Map();

function numericFacts(text) {
  const input = String(text ?? '');
  const cacheable = input.length <= 512;
  if (cacheable && numericFactsCache.has(input)) {
    return numericFactsCache.get(input);
  }
  const out = [];
  const cleaned = stripExplicitValueCorrection(stripSeqCitations(input));
  const locs = [];
  const withoutLocs = cleaned.replace(LOC_REF_RE, (_full, file, lines) => {
    locs.push(`loc:${file.toLowerCase()}:${lines}`);
    return ' ';
  });
  const withoutMeta = withoutLocs.replace(NON_QUANTITY_NUM_RE, ' ');
  const value = withoutMeta.replace(/(?<!\d)\d{1,3}(?:,\d{3})+(?!\d)/g, (m) => m.replaceAll(',', ''));
  const re =
    /(?<![a-z0-9_-]|[a-z0-9]\.)(-?\d+(?:\.\d+)?)(\s*)(ms|s|sec|seconds?|months?|m|min|minutes?|h|hours?|d|days?|weeks?|years?|yrs?|gb|gib|mb|mib|kb|kib|tb|tib|bytes?|b|g|%|毫秒|秒|分钟?|小时|天|个月|周|星期|年|字节)?(?![a-z0-9_-]|\.[a-z0-9])/gi;
  for (const m of value.matchAll(re)) {
    const rawUnit = m[3] ?? '';
    if (isNonQuantityTechTerm(m[1], m[2], rawUnit, value)) continue;
    const num = Number(m[1]);
    if (!Number.isFinite(num)) continue;
    const { unit } = unitFamily(rawUnit);
    out.push(`${num}${unit}`);
  }
  out.push(...locs);
  const frozen = Object.freeze(out);
  if (cacheable) {
    if (numericFactsCache.size >= 2048) numericFactsCache.clear();
    numericFactsCache.set(input, frozen);
  }
  return frozen;
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

const CN_AFFIRMATIVE_MODAL_OVERRIDE_RE =
  /^(?:(?:仍(?:然|旧)?|依旧|依然|照常|照旧|转而|改为|改而)\s*(?:需要|需|须|必须|务必|允许|可以|准许|放行|批准|授权|同意|应当|应该|将会|会|要)?|(?:现(?:在|已)?|已(?:经)?|还是)\s*(?:需要|需|须|必须|务必|允许|可以|准许|放行|批准|授权|同意|应当|应该|将会|会|要)|(?:允许|可以|准许|放行|批准|授权|同意|必须|务必|需要|应当|应该|一定要|将会|仍需|仍要|仍会|仍可|仍应|仍须|仍将|还要))/;
const CN_COORD_OVERRIDE_SPLIT_RE =
  /(?:或者?|以及|及|与|和|并)\s*(?=(?:(?:仍(?:然|旧)?|依旧|依然|照常|照旧|转而|改为|改而)\s*(?:需要|需|须|必须|务必|允许|可以|准许|放行|批准|授权|同意|应当|应该|将会|会|要)?|(?:现(?:在|已)?|已(?:经)?|还是)\s*(?:需要|需|须|必须|务必|允许|可以|准许|放行|批准|授权|同意|应当|应该|将会|会|要)|(?:允许|可以|准许|放行|批准|授权|同意|必须|务必|需要|应当|应该|一定要|将会|仍需|仍要|仍会|仍可|仍应|仍须|仍将|还要)))/g;
const CN_COMMA_NEG_COORD_HEAD_RE = /^(?:或者?|以及|及)(?=[\u4e00-\u9fffa-z0-9`])/;
const CN_COMMA_CLAUSE_BREAK_HEAD_RE =
  /^(?:如果|倘若|假如|除非|只有|仅当|一旦|每当|若|当|随后|然后|接着|继而|并且|而且|但是?|不过|然而|反而)/;

function splitCommaClausesPreservingNegCoord(masked, literals) {
  const rawParts = String(masked ?? '').split(/(?:(?<!\d),|,(?!\d)|，)/);
  const out = [];
  for (let i = 0; i < rawParts.length; i += 1) {
    let trimmed = rawParts[i].trim();
    if (!trimmed) continue;
    if (out.length > 0) {
      const adversativeMatch = /^(?:但是?|不过|然而|\bbut\b)\s+/i.exec(trimmed);
      if (adversativeMatch) {
        trimmed = trimmed.slice(adversativeMatch[0].length).trim();
        if (trimmed) out.push(trimmed);
        continue;
      }
      const advCompact = /^(?:但是?|不过|然而)/.exec(trimmed);
      if (advCompact) {
        trimmed = trimmed.slice(advCompact[0].length).trim();
        if (trimmed) out.push(trimmed);
        continue;
      }
      const prevText = unmask(out[out.length - 1], literals);
      const nextText = unmask(trimmed, literals);
      if (ruleNegative(prevText) && CN_COMMA_NEG_COORD_HEAD_RE.test(nextText)) {
        const afterCoord = nextText.replace(/^(?:或者?|以及|及)\s*/, '').trim();
        if (
          afterCoord &&
          !CN_AFFIRMATIVE_MODAL_OVERRIDE_RE.test(afterCoord) &&
          !CN_COMMA_CLAUSE_BREAK_HEAD_RE.test(afterCoord) &&
          !/[「『]/.test(afterCoord) &&
          !/\bseq\s*\d+/i.test(afterCoord) &&
          !/[:：]/.test(afterCoord) &&
          !ruleNegative(afterCoord)
        ) {
          out[out.length - 1] = `${out[out.length - 1]}，${trimmed}`;
          continue;
        }
      }
    }
    out.push(trimmed);
  }
  return out;
}

const CONDITIONAL_SEMICOLON_CONTINUATION_RE =
  /^(?:不许|不得|不能|不要|不可|禁止|严禁|勿|必须|务必|只能|只允许|仅允许|且|并|同时|否则|\b(?:must|shall|do\s+not|don't|never|only|otherwise)\b)/i;

function splitContrastClauses(text) {
  const rawSentences = sourceEvidenceSentences(text);
  const mergedSentences = [];
  for (let i = 0; i < rawSentences.length; i += 1) {
    const curr = rawSentences[i];
    if (
      /[；;]\s*$/.test(curr) &&
      conditionParts(curr) &&
      i + 1 < rawSentences.length &&
      !conditionParts(rawSentences[i + 1]) &&
      CONDITIONAL_SEMICOLON_CONTINUATION_RE.test(rawSentences[i + 1].trim())
    ) {
      mergedSentences.push(`${curr.trim()} ${rawSentences[i + 1].trim()}`);
      i += 1;
    } else {
      mergedSentences.push(curr);
    }
  }
  const out = [];
  for (const sentence of mergedSentences) {
    if (/^\s*#{1,6}\s/.test(sentence)) continue;
    if (conditionParts(sentence)) {
      out.push(sentence);
      continue;
    }
    const literals = [];
    const masked = CODE_SPLIT_MASK(sentence, literals);
    const quoteSegments = masked.split(/(?<=[」』])\s*(?:(?:与|和|及|以及|、|\band\b)\s*)?(?=[「『])/i);
    for (const seg of quoteSegments) {
      const unmaskedSeg = unmask(seg, literals).trim();
      if (!unmaskedSeg) continue;
      if (conditionParts(unmaskedSeg)) {
        out.push(unmaskedSeg);
        continue;
      }
      const parts = splitCommaClausesPreservingNegCoord(seg, literals);
      for (const part of parts) {
        const clean = unmask(part, literals).trim();
        if (clean) out.push(clean);
      }
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

const scopeSetCache = new Map();

function scopeSetOf(text) {
  const s = String(text ?? '');
  const cacheable = s.length <= 512;
  if (cacheable && scopeSetCache.has(s)) return scopeSetCache.get(s);
  const out = new Set([
    ...[...s.matchAll(/\b(?:production|staging|development|test)\b|生产|测试|预发布/gi)].map((m) => m[0].toLowerCase()),
    ...[...s.matchAll(/(?:服务器|第|阶段|轮|批|步)\s*\d+/g)].map((m) => m[0].replace(/\s+/g, '')),
    ...[...s.matchAll(/\b(?:phase|stage|round|cycle|batch|step|turn|iteration)\s*#?\d+\b/gi)].map((m) =>
      m[0].toLowerCase().replace(/[\s#]+/g, ''),
    ),
  ]);
  if (cacheable) {
    if (scopeSetCache.size >= 2048) scopeSetCache.clear();
    scopeSetCache.set(s, out);
  }
  return out;
}

function scopesCompatible(a, b) {
  const sa = scopeSetOf(a);
  const sb = scopeSetOf(b);
  for (const k of sa) {
    if (sb.size > 0 && !sb.has(k)) return false;
  }
  for (const k of sb) {
    if (sa.size > 0 && !sa.has(k)) return false;
  }
  return true;
}

const NEGATED_PRIVATIVE = /(?:不要|不能|不得|不可|禁止|切勿|严禁|免于|避免|杜绝|\bdo\s+not\b|\bdon't\b|\bmust\s+not\b|\bshall\s+not\b|\bmay\s+not\b|\bought\s+not\s+to\b|\bprohibited\s+from\b|\bnever\b|\bavoid\b)[^。！？；;\n]{0,80}?(?:漏掉|遗漏|漏记|丢失|丢掉|丢弃|省略|略过|忽略|跳过|忘掉|删掉|删除|\bomit\b|\bdrop\b|\bskip\b|\bmiss\b|\bignore\b|\bforget\b|\bdelete\b|\bdiscard\b)/iu;
const BARE_PRIVATIVE = /(?:漏掉|遗漏|漏记|丢失|丢掉|丢弃|省略|略过|跳过|删掉|删除|\bomit\b|\bdrop\b|\bskip\b|\bmiss\b|\bforget\b|\bdelete\b|\bignore\b|\bdiscard\b)/iu;
const AFFIRMATIVE_KEEP = /(?:保留|留存|保存|存留|完整记录|包含|涵盖|纳入|覆盖|执行|\bkeep\b|\bretain\b|\bpreserve\b|\binclude\b|\benforce\b)/iu;
const NEGATED_DEFECT = /(?:不得|不能|不要|禁止|避免|杜绝|免于|\bno\b|\bnever\b|\bmust\s+not\b|\bshall\s+not\b|\bmay\s+not\b|\bought\s+not\s+to\b|\bprohibited\s+from\b|\bwithout\b)[^。！？；;\n]{0,80}?(?:报错|错误|异常|漏洞|失败|缺陷|\berrors?|\bfailures?\b|\bbugs?\b|\bdefects?\b|\bexceptions?\b)/iu;
const DEFECT_FREE = /(?:零错误|零报错|零缺陷|无报错|无错误|无异常|zero\s+(?:errors?|defects?|bugs?)|error[-\s]?free|bug[-\s]?free|defect[-\s]?free)/iu;
const NEGATED_ENABLE = /(?:不要|不能|不得|不可|禁止|切勿|严禁|避免|杜绝|\bdo\s+not\b|\bdon't\b|\bmust\s+not\b|\bshall\s+not\b|\bmay\s+not\b|\bought\s+not\s+to\b|\bprohibited\s+from\b|\bnever\b|\bavoid\b)[^。！？；;\n]{0,80}?(?:启用|开启|打开|允许|放行|\benable\b|\bturn\s+on\b|\ballow\b|\bpermit\b)/iu;
const BARE_ENABLE = /(?:启用|开启|打开|允许|放行|\benable\b|\bturn\s+on\b|\ballow\b|\bpermit\b)/iu;
const AFFIRMATIVE_DISABLE = /(?:禁用|关闭|停用|阻断|\bdisable\b|\bturn\s+off\b)/iu;
const ANTONYM_BOILERPLATE =
  /(?:不要|不能|不得|不可|禁止|切勿|严禁|免于|避免|杜绝|必须|务必|应当|需要|应该|保证|确保|完整|全面|始终|永远|任何|所有|全部|一点|一丝|出现|漏掉|遗漏|漏记|丢失|丢掉|丢弃|省略|略过|忽略|跳过|忘掉|删掉|删除|保留|留存|保存|存留|包含|涵盖|纳入|覆盖|执行|启用|开启|打开|允许|放行|禁用|关闭|停用|阻断|\bdo\s+not\b|\bdon't\b|\bmust\s+not\b|\bshall\s+not\b|\bmay\s+not\b|\bought\s+(?:not\s+)?to\b|\brequired\s+to\b|\bprohibited\s+from\b|\bnever\b|\bavoid\b|\bmust\b|\bshall\b|\balways\b|\bensure\b|\ball\b|\bany\b|\bomit\b|\bdrop\b|\bskip\b|\bmiss\b|\bignore\b|\bforget\b|\bdelete\b|\bdiscard\b|\bkeep\b|\bretain\b|\bpreserve\b|\binclude\b|\benforce\b|\benable\b|\bdisable\b|\bturn\s+on\b|\bturn\s+off\b|\ballow\b|\bpermit\b)/giu;

function oneWayAntonymMatch(negNorm, posNorm) {
  if (NEGATED_PRIVATIVE.test(negNorm) && AFFIRMATIVE_KEEP.test(posNorm) && !BARE_PRIVATIVE.test(posNorm)) return true;
  if (NEGATED_DEFECT.test(negNorm) && DEFECT_FREE.test(posNorm)) return true;
  if (NEGATED_ENABLE.test(negNorm) && AFFIRMATIVE_DISABLE.test(posNorm) && !BARE_ENABLE.test(posNorm)) return true;
  return false;
}

function equivalentAntonymPolarity(source, candidate, sourceNegative, candNegative, limit = 0.6) {
  if (sourceNegative === candNegative) return false;
  const cleanSrc = stripSeqCitations(source).replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim();
  const cleanCand = stripSeqCitations(candidate).replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim();
  const sNorm = normalize(cleanSrc);
  const cNorm = normalize(cleanCand);
  const matched = sourceNegative ? oneWayAntonymMatch(sNorm, cNorm) : oneWayAntonymMatch(cNorm, sNorm);
  if (!matched) return false;
  const core = sNorm.replace(ANTONYM_BOILERPLATE, ' ').replace(/\s+/g, ' ').trim();
  if (!core || coverageTokens(core).length === 0) return false;
  return coverageOf(core, cNorm) >= limit;
}

const OUTER_QUOTE_PAIRS = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['"', '"'],
  ["'", "'"],
];

const LEADING_SEQ_CITATION_RE =
  /^(?:\[\s*seqs?\s+\d+(?:\s*[-–,]\s*\d+)*\s*\]|[（(]\s*seqs?\s+\d+(?:\s*[-–,]\s*\d+)*\s*[)）]|seqs?\s*#?\s*\d+(?:\s*[-–,]\s*\d+)*(?:\s*[:：])?|>\s*user\s+source\s*\(seq\s+\d+\),\s*verbatim:)\s*/i;
const TRAILING_SEQ_CITATION_RE =
  /(?:\s*(?:\[\s*seqs?\s+\d+(?:\s*[-–,]\s*\d+)*\s*\]|[（(]\s*seqs?\s+\d+(?:\s*[-–,]\s*\d+)*\s*[)）]))+\s*$/i;

function stripOuterQuotePair(text) {
  let out = String(text ?? '').trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const core = out.replace(/[。.!！;；]+$/, '').trim();
    let stripped = false;
    for (const [open, close] of OUTER_QUOTE_PAIRS) {
      if (core.startsWith(open) && core.endsWith(close) && core.length > open.length + close.length) {
        const inner = core.slice(open.length, core.length - close.length).trim();
        // Do not unwrap when multiple quoted items share one line (e.g. 「cond」「rule2」).
        if (!inner.includes(close)) {
          out = inner;
          stripped = true;
          break;
        }
      }
      if (
        (open === '「' || open === '『' || open === '“') &&
        core.startsWith(open) &&
        !core.includes(close) &&
        core.length > open.length
      ) {
        out = core.slice(open.length).trim();
        stripped = true;
        break;
      }
    }
    if (!stripped) break;
  }
  return out;
}

function normalizeConditionalInput(text) {
  let out = String(text ?? '').replace(/\*\*|__/g, '').trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const next = stripOuterQuotePair(
      out
        .replace(/^(?:>\s*)+/, '')
        .replace(/^(?:[-*•+]|\d+[.)])\s+/, '')
        .replace(LEADING_SEQ_CITATION_RE, '')
        .replace(/^[:：—–-]\s*/, '')
        .replace(TRAILING_SEQ_CITATION_RE, '')
        .trim(),
    );
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

const conditionPartsCache = new Map();

export function conditionParts(text) {
  const raw = String(text ?? '');
  const cacheable = raw.length <= 1024;
  if (cacheable && conditionPartsCache.has(raw)) {
    return conditionPartsCache.get(raw);
  }
  const cacheCond = (val) => {
    if (cacheable) {
      if (conditionPartsCache.size >= 2048) conditionPartsCache.clear();
      conditionPartsCache.set(raw, val);
    }
    return val;
  };
  const stripTemporal = (p, kw = '') => {
    let out = p.replace(/(?:的话|的时候)$/, '').trim();
    if (kw === '当' || kw === '每当' || kw === '在' || kw === '等' || kw === '等到') {
      out = out.replace(/(?<![超实及暂随同定临长短])时$/, '').trim();
    }
    return out || p;
  };
  const cleaned = normalizeConditionalInput(raw);
  if (!cleaned || cleaned.length > 1024) return cacheCond(null);
  const m = CONDITIONAL_PREFIX_RE.exec(cleaned);
  if (m) {
    const kw = m[4] ?? '';
    const rawPred = (m[3] ?? m[5] ?? '').trim();
    const consequence = (m[6] ?? '').trim();
    if (!(kw === '当' && PAST_NARRATIVE_TIME_RE.test(rawPred))) {
      const predicate = stripTemporal(rawPred, kw);
      if (predicate && consequence) return cacheCond(Object.freeze({ predicate, consequence }));
    }
  }
  const tm = TEMPORAL_CONDITIONAL_PREFIX_RE.exec(cleaned);
  if (tm) {
    const kw = tm[1] ?? tm[3] ?? '';
    const rawPred = (tm[2] ?? tm[4] ?? '').trim();
    const consequence = (tm[5] ?? '').trim();
    const coreBeforeCloser = rawPred
      .replace(/(?:完毕(?:之|以)?后|完成(?:之|以)?后|结束(?:之|以)?后|之后|以后|之前|以前|的时候|时|后)$/, '')
      .trim();
    if (coreBeforeCloser.length >= 2 && !PAST_NARRATIVE_TIME_RE.test(rawPred)) {
      const predicate = stripTemporal(rawPred, kw);
      if (predicate && consequence) return cacheCond(Object.freeze({ predicate, consequence }));
    }
  }
  const s = CONDITIONAL_SUFFIX_RE.exec(cleaned);
  if (s) {
    const consequence = s[1].trim();
    const predicate = stripTemporal(s[3].trim());
    if (predicate && consequence) return cacheCond(Object.freeze({ predicate, consequence }));
  }
  return cacheCond(null);
}

const PURPOSE_AVOID_PREFIX_RE =
  /^(?:(?:说明|注意|另外|后续|以后|其实|因此|当前)[^,，。；;\n]{0,12}?)?(?:为(?:了)?|以)(?:避免|杜绝)[^，,。；;\n]{1,30}[，,]\s*(.+)$/;
const PURPOSE_AVOID_SUFFIX_RE =
  /^(.+?)[，,]\s*(?:为(?:了)?|以)(?:避免|杜绝)[^，,。；;\n]{1,30}[。.!！;；]?$/;

function stripPurposeAvoidClause(text) {
  const cleaned = normalizeConditionalInput(text);
  if (!cleaned || cleaned.length > 1024) return null;
  const prefixMatch = PURPOSE_AVOID_PREFIX_RE.exec(cleaned);
  if (prefixMatch && prefixMatch[1]?.trim()) return prefixMatch[1].trim();
  const suffixMatch = PURPOSE_AVOID_SUFFIX_RE.exec(cleaned);
  if (suffixMatch && suffixMatch[1]?.trim()) return suffixMatch[1].trim();
  return null;
}

const MODAL_STRIP = /(?:必须|务必|应当|应该|需要|可以|允许|请|先|\bmust\b|\bshall\b|\bought\s+to\b|\brequired\s+to\b|\bshould\b|\bcan\b|\bmay\b|\bplease\b)/gi;
const stripNegAndModal = (t) =>
  proseOnly(normalize(t))
    .replace(INEVITABILITY_MODAL_RE, ' ')
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

const EMPTY_BOOL_SWITCH_MAP = Object.freeze(new Map());
const EMPTY_CLI_FLAG_MAP = Object.freeze(new Map());
const booleanSwitchCache = new Map();
const cliFlagCache = new Map();

const BOOL_SWITCH_RE =
  /(?<![a-z0-9_.-])(["']?)(?:--)?([a-z_][a-z0-9_.-]{1,63})\1\s*[:=：]\s*(["']?)\b(true|false)\b\3(?![a-z0-9_-]|\.[a-z0-9_])/gi;
const BOOL_HISTORICAL_BEFORE_RE =
  /(?:previously|formerly|originally|initially|was|were|not|instead\s+of|rather\s+than|原为|曾为|旧值(?:为)?|不是|并非|而非)\s*$/i;
const BOOL_HISTORICAL_AFTER_RE =
  /^\s*(?:[(（]\s*(?:previously|formerly|superseded|deprecated|retired|replaced|原值|旧值|已取代|已弃用)\s*[)）]|\s+was\s+(?:superseded|deprecated|retired|replaced)\b)/i;
const BOOL_ALT_AFTER_RE = /^\s*(?:\/|\||\bor\b|或)\s*(?:true|false)\b/i;

const CLI_FLAG_RE =
  /(?<![a-z0-9_-])--([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![a-z0-9_-]|\s*=\s*(?:true|false)\b(?![a-z0-9_-]|\.[a-z0-9_]))/gi;
const FLAG_PRIVATIVE_ONLY_RE =
  /(?:\b(?:without|omit(?:ting|ted)?|drop(?:ping|ped)?|remove(?:d|s)?|removing|skip(?:ping|ped)?|disable(?:d|s)?|disabling|exclude(?:d|s)?|excluding|strip(?:ping|ped)?)\b|(?:去掉|移除|删除|省略|跳过|禁用|关闭))\s*(?:the\s+|flag\s+|option\s+|参数\s*|选项\s*)?$/i;

function extractBooleanSwitches(text) {
  const input = String(text ?? '');
  if (!/(?:true|false)/i.test(input) || !/[:=：]/.test(input)) return EMPTY_BOOL_SWITCH_MAP;
  const cacheable = input.length <= 512;
  if (cacheable && booleanSwitchCache.has(input)) return booleanSwitchCache.get(input);

  const out = new Map();
  const cleaned = stripInlineMarkdownFormatting(stripSeqCitations(input));
  for (const seg of localPolaritySegments(cleaned)) {
    const segNeg = ruleNegative(seg);
    BOOL_SWITCH_RE.lastIndex = 0;
    for (const m of seg.matchAll(BOOL_SWITCH_RE)) {
      const key = m[2].toLowerCase();
      if (key === 'true' || key === 'false') continue;
      const before = seg.slice(Math.max(0, m.index - 28), m.index);
      const after = seg.slice(m.index + m[0].length);
      if (BOOL_ALT_AFTER_RE.test(after)) continue;
      const arrowMatch = /^\s*(?:->|→|=>)\s*(["']?)\b(true|false)\b\1(?![a-z0-9_-]|\.[a-z0-9_])/i.exec(after);
      let literal;
      if (arrowMatch) {
        literal = arrowMatch[2].toLowerCase() === 'true';
      } else {
        if (BOOL_HISTORICAL_BEFORE_RE.test(before) || BOOL_HISTORICAL_AFTER_RE.test(after)) continue;
        literal = m[4].toLowerCase() === 'true';
      }
      const effective = segNeg ? !literal : literal;
      let set = out.get(key);
      if (!set) {
        set = new Set();
        out.set(key, set);
      }
      set.add(effective);
    }
  }

  if (cacheable) {
    if (booleanSwitchCache.size >= 2048) booleanSwitchCache.clear();
    booleanSwitchCache.set(input, out);
  }
  return out;
}

function extractCliFlags(text) {
  const input = String(text ?? '');
  if (!input.includes('--')) return EMPTY_CLI_FLAG_MAP;
  const cacheable = input.length <= 512;
  if (cacheable && cliFlagCache.has(input)) return cliFlagCache.get(input);

  const out = new Map();
  const cleaned = stripInlineMarkdownFormatting(stripSeqCitations(input));
  for (const seg of localPolaritySegments(cleaned)) {
    if (!seg.includes('--')) continue;
    const surroundingNeg = ruleNegative(seg);
    let prevMatchEnd = 0;
    CLI_FLAG_RE.lastIndex = 0;
    for (const m of seg.matchAll(CLI_FLAG_RE)) {
      const name = m[1].toLowerCase();
      const negatedFlag = name.startsWith('no-') && name.length > 3;
      const stem = negatedFlag ? name.slice(3) : name;
      const beforeWindowStart = Math.max(prevMatchEnd, m.index - 32);
      const before = seg.slice(beforeWindowStart, m.index);
      const flagPrivative = FLAG_PRIVATIVE_ONLY_RE.test(before);
      const effective = !((negatedFlag ? 1 : 0) ^ (surroundingNeg ? 1 : 0) ^ (flagPrivative ? 1 : 0));
      let set = out.get(stem);
      if (!set) {
        set = new Set();
        out.set(stem, set);
      }
      set.add(effective);
      prevMatchEnd = m.index + m[0].length;
    }
  }

  if (cacheable) {
    if (cliFlagCache.size >= 2048) cliFlagCache.clear();
    cliFlagCache.set(input, out);
  }
  return out;
}

function mapsShareUnambiguousOpposite(sMap, cMap) {
  if (sMap.size === 0 || cMap.size === 0) return false;
  for (const [k, sVals] of sMap.entries()) {
    if (sVals.size !== 1) continue;
    const cVals = cMap.get(k);
    if (!cVals || cVals.size !== 1) continue;
    const [sv] = sVals;
    const [cv] = cVals;
    if (sv !== cv) return true;
  }
  return false;
}

function mapsShareUnambiguousEqual(sMap, cMap) {
  if (sMap.size === 0 || cMap.size === 0) return false;
  for (const [k, sVals] of sMap.entries()) {
    if (sVals.size !== 1) continue;
    const cVals = cMap.get(k);
    if (!cVals || cVals.size !== 1) continue;
    const [sv] = sVals;
    const [cv] = cVals;
    if (sv === cv) return true;
  }
  return false;
}

function hasBooleanSwitchConflict(source, candidate) {
  return scopesCompatible(source, candidate) && mapsShareUnambiguousOpposite(extractBooleanSwitches(source), extractBooleanSwitches(candidate));
}

function hasCliFlagConflict(source, candidate) {
  return scopesCompatible(source, candidate) && mapsShareUnambiguousOpposite(extractCliFlags(source), extractCliFlags(candidate));
}

function sharesPreservedCliOrBoolPolarity(source, candidate) {
  if (!scopesCompatible(source, candidate)) return false;
  const sFlags = extractCliFlags(source);
  const cFlags = extractCliFlags(candidate);
  if (mapsShareUnambiguousOpposite(sFlags, cFlags)) return false;
  const sBools = extractBooleanSwitches(source);
  const cBools = extractBooleanSwitches(candidate);
  if (mapsShareUnambiguousOpposite(sBools, cBools)) return false;
  return mapsShareUnambiguousEqual(sFlags, cFlags) || mapsShareUnambiguousEqual(sBools, cBools);
}

function clauseMatchesSingle(source, candidate, limit) {
  if (!scopesCompatible(source, candidate)) return false;
  const sBools = extractBooleanSwitches(source);
  const cBools = extractBooleanSwitches(candidate);
  for (const k of sBools.keys()) {
    if (cBools.has(k)) return true;
  }
  const sFlags = extractCliFlags(source);
  const cFlags = extractCliFlags(candidate);
  for (const stem of sFlags.keys()) {
    if (cFlags.has(stem)) return true;
  }
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
    t
      .replace(INEVITABILITY_MODAL_RE, ' ')
      .replace(NEGATION, ' ')
      .replace(MODAL_STRIP, ' ')
      .replace(/\*\*|__/g, '')
      .replace(/[。.!！?？;；，,]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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
  const purposeMain = stripPurposeAvoidClause(source);
  if (purposeMain && isInstructionLine(purposeMain)) {
    const candPurposeMain = stripPurposeAvoidClause(candidate) ?? candidate;
    if (clauseMatchesSingle(purposeMain, candPurposeMain, limit)) {
      return true;
    }
  }
  if (hasLexicalDisableEnableConflict(source, candidate, limit)) return true;
  return false;
}

const normativeSourceSegmentsCache = new Map();

function normativeSourceSegments(source) {
  const input = String(source ?? '');
  const cacheable = input.length <= 512;
  if (cacheable && normativeSourceSegmentsCache.has(input)) {
    return normativeSourceSegmentsCache.get(input);
  }
  const cacheAndReturn = (val) => {
    const frozen = Object.freeze(val);
    if (cacheable) {
      if (normativeSourceSegmentsCache.size >= 2048) normativeSourceSegmentsCache.clear();
      normativeSourceSegmentsCache.set(input, frozen);
    }
    return frozen;
  };
  if (!source || conditionParts(source) || stripPurposeAvoidClause(source)) return cacheAndReturn([source]);
  const parts = localPolaritySegments(source);
  if (parts.length <= 1) return cacheAndReturn([source]);
  const filtered = parts.filter((sub) => {
    if (!isInstructionLine(sub) && !ruleNegative(sub)) return false;
    if (isBareShortVerbSource(sub, source)) return false;
    return actionState(sub) !== null || coverageTokens(stripNegAndModal(sub)).length >= 2;
  });
  return cacheAndReturn(filtered.length > 0 ? filtered : [source]);
}

function clauseMatchesSource(source, candidate, limit) {
  if (clauseMatchesSingle(source, candidate, limit)) return true;
  const candSegments = localPolaritySegments(candidate);
  if (candSegments.length > 1 && candSegments.some((seg) => clauseMatchesSingle(source, seg, limit))) {
    return true;
  }
  const srcSegments = normativeSourceSegments(source);
  if (srcSegments.length > 0 && !(srcSegments.length === 1 && srcSegments[0] === source)) {
    const candPool = candSegments.length > 1 ? candSegments : [candidate];
    if (srcSegments.some((srcSeg) => candPool.some((candSeg) => clauseMatchesSingle(srcSeg, candSeg, limit)))) {
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
  for (const m of str.matchAll(/(?:_|-|(?<=[a-z0-9]))(milliseconds?|millis|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|yrs?|bytes?|kb|mb|gb|tb|tib|pct|percent)\b/gi)) {
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
  const sp = splitNumUnit(sTok);
  const cp = splitNumUnit(cTok);
  if (!sp || !cp) return false;
  if (sp.val === cp.val) {
    if (!sp.unit && cp.unit && sImplied.has(cp.unit)) return true;
    if (!cp.unit && sp.unit && cImplied.has(sp.unit)) return true;
  }
  const sUnits = sp.unit ? [sp.unit] : [...sImplied];
  const cUnits = cp.unit ? [cp.unit] : [...cImplied];
  for (const su of sUnits) {
    const sCanon = canonicalQuantity(sp.val, su);
    if (!sCanon) continue;
    for (const cu of cUnits) {
      const cCanon = canonicalQuantity(cp.val, cu);
      if (cCanon && cCanon.family === sCanon.family && canonicalValuesEqual(sCanon.baseValue, cCanon.baseValue)) {
        return true;
      }
    }
  }
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
  return replaceInlineBackticks(
    String(text ?? ''),
    (_full, inner) => ` ${inner} `,
    { exactTickCount: true, maxInnerChars: 256 },
  ).replace(/(?<![a-z0-9_])(\*\*|__)([^\n]{1,160}?)\1(?![a-z0-9_])/gi, (full, marker, inner) =>
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
    `(?<![a-z0-9_])${esc}(?:\\s*[:=：]?\\s*-?\\d+(?:\\.\\d+)?\\s*(?:->|→|=>)\\s*|\\s*(?:[:=：]|为|是|设为|设置为|保持(?:为)?|改为|改成|\\bmust\\s+be|\\bshall\\s+be|\\bis|\\bset\\s+to)\\s*|\\s+)(-?\\d+(?:\\.\\d+)?)\\s*(ms|s|sec|seconds?|months?|m|min|minutes?|h|hours?|d|days?|weeks?|years?|yrs?|gb|gib|mb|mib|kb|kib|tb|tib|bytes?|b|g|%|毫秒|秒|分钟?|小时|天|个月|周|星期|年|字节|个|次|条)?(?![a-z0-9_]|\\.[a-z0-9]|\\s*(?:->|→|=>))`,
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
  /\s*(?:→|->|=>|⇒)\s*|[；;]|(?=\s*(?:而不是|而非))|\s*(?:并且|而且|但是|不过|然而|反而|随后|然后|接着|继而)\s*|(?<![暂尚姑并而])且|(?<!不)但|(?<![从进因然反视一概取])而(?![已论定])/i;

const GOVERNING_NEG_BEFORE_BRACKET_RE =
  /(?:不允许|不应(?:当|该)?|不要(?!求)|不能|不得|不必|不用|禁止|(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人)|无需|不可(?!逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越)|不准|不许|严禁|勿|没有|尚未|并未|未曾|并非|不再|取消|撤销|(?<!为了?|以)(?:避免|杜绝)|免于|不(?![同仅但过论管断少足安便光止久妨料然如至]|得不)|未|\b(?:must\s+not|shall\s+not|may\s+not|ought\s+not\s+to|prohibited\s+from|do\s+not|don't|never|forbid(?:s|den|ding)?|disallow(?:s|ed|ing)?|ban(?:s|ned|ning)?|prohibit(?:s|ed|ing)?|avoid|no|not|without)\b)\s*(?:包含|含有|含|附带|附|使用|用|执行|做|改|修改|删除|安装|装|允许|保留|给|写|启动|重启|部署)?\s*$/i;

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
    const prevNegative = ruleNegative(merged[merged.length - 1]);
    const itemNorm = normalize(item);
    const hasExplicitClauseCue =
      CN_MODAL.test(itemNorm) ||
      EN_MODAL.test(itemNorm) ||
      LABEL.test(itemNorm) ||
      scalarRequirement(item) !== null ||
      CN_AFFIRMATIVE_MODAL_OVERRIDE_RE.test(item);
    const isClauseItem =
      /[「『]/.test(item) ||
      /\bseq\s*\d+/i.test(item) ||
      ruleNegative(item) ||
      (prevNegative ? hasExplicitClauseCue : isInstructionLine(item)) ||
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
    const isNormativeQuote =
      hasPermissionOrReversalVerb ||
      isInstructionLine(inner) ||
      ruleNegative(inner);
    const inlineModifier =
      inner.length < 4 ||
      !isNormativeQuote ||
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

const localPolaritySegmentsCache = new Map();

function localPolaritySegments(text) {
  const input = String(text ?? '');
  const cacheable = input.length <= 512;
  if (cacheable && localPolaritySegmentsCache.has(input)) {
    return localPolaritySegmentsCache.get(input);
  }
  const raw = stripExplicitValueCorrection(input.trim());
  if (!raw) return [];
  const literals = [];
  const masked = CODE_SPLIT_MASK(raw, literals);
  const majorParts = [];
  for (const commaPart of splitCommaClausesPreservingNegCoord(masked, literals)) {
    for (const seg of commaPart.split(POLARITY_MAJOR_SPLIT_RE)) {
      const part = unmask(seg, literals).trim();
      if (!part) continue;
      if (/(?:或者?|以及|及|与|和|并)/.test(part)) {
        CN_COORD_OVERRIDE_SPLIT_RE.lastIndex = 0;
        for (const sub of part.split(CN_COORD_OVERRIDE_SPLIT_RE)) {
          const clean = sub.trim();
          if (clean) majorParts.push(clean);
        }
      } else {
        majorParts.push(part);
      }
    }
  }
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
  const frozen = Object.freeze(out);
  if (cacheable) {
    if (localPolaritySegmentsCache.size >= 2048) localPolaritySegmentsCache.clear();
    localPolaritySegmentsCache.set(input, frozen);
  }
  return frozen;
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

function hasLexicalDisableEnableConflict(normativeSource, candSeg, limit) {
  const stripLeadingBullet = (t) => stripSeqCitations(t).replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim();
  const cleanSrc = stripExplicitValueCorrection(stripLeadingBullet(normativeSource));
  const cleanCand = stripExplicitValueCorrection(stripLeadingBullet(candSeg));
  if (ruleNegative(cleanSrc) || ruleNegative(cleanCand)) return false;
  if (!scopesCompatible(cleanSrc, cleanCand)) return false;
  if (scalarSubjectsIncompatible(scalarRequirement(cleanSrc), scalarRequirement(cleanCand))) return false;
  const sNorm = normalize(cleanSrc);
  const cNorm = normalize(cleanCand);
  const sDis = AFFIRMATIVE_DISABLE.test(sNorm) && !BARE_ENABLE.test(sNorm) && !NEGATED_ENABLE.test(sNorm);
  const cDis = AFFIRMATIVE_DISABLE.test(cNorm) && !BARE_ENABLE.test(cNorm) && !NEGATED_ENABLE.test(cNorm);
  const sEn = BARE_ENABLE.test(sNorm) && !AFFIRMATIVE_DISABLE.test(sNorm) && !NEGATED_ENABLE.test(sNorm);
  const cEn = BARE_ENABLE.test(cNorm) && !AFFIRMATIVE_DISABLE.test(cNorm) && !NEGATED_ENABLE.test(cNorm);
  if (!((sDis && cEn) || (sEn && cDis))) return false;
  const sCore = sNorm.replace(ANTONYM_BOILERPLATE, ' ').replace(/\s+/g, ' ').trim();
  const cCore = cNorm.replace(ANTONYM_BOILERPLATE, ' ').replace(/\s+/g, ' ').trim();
  if (sCore.length < 2 || cCore.length < 2) return false;
  if (coverageTokens(sCore).length === 0 || coverageTokens(cCore).length === 0) return false;
  return coverageOf(sCore, cNorm) >= limit && coverageOf(cCore, sNorm) >= limit;
}

function isSegmentPolarityConflict(normativeSource, candSeg, srcNeg, limit, contextSource = normativeSource) {
  if (hasBooleanSwitchConflict(normativeSource, candSeg) || hasCliFlagConflict(normativeSource, candSeg)) {
    return true;
  }
  if (sharesPreservedCliOrBoolPolarity(normativeSource, candSeg)) {
    return false;
  }
  const candNeg = ruleNegative(candSeg);
  if (candNeg === srcNeg) {
    if (!srcNeg && hasLexicalDisableEnableConflict(normativeSource, candSeg, limit)) return true;
    return false;
  }
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
    if (srcHasMixedPolarity && coverageOf(normativeSource, normalize(candForPolarity)) >= Math.max(limit, 0.7)) {
      return srcSegments.some((sub) => {
        if (!isInstructionLine(sub) && !ruleNegative(sub)) return false;
        return hasSingleSourcePolarityConflict(sub, candForPolarity, ruleNegative(sub), limit, segments, contextSource);
      });
    }
  }
  const srcNormSegments = normativeSourceSegments(normativeSource);
  if (
    srcNormSegments.length > 0 &&
    !(srcNormSegments.length === 1 && srcNormSegments[0] === normativeSource)
  ) {
    const candPool = segments.length > 1 ? segments : [candForPolarity];
    let anyMatched = false;
    const matchedSrcIndices = new Set();
    for (const candSeg of candPool) {
      const matchingSubs = srcNormSegments
        .map((sub, idx) => ({ sub, idx }))
        .filter(({ sub }) => clauseMatchesSingle(sub, candSeg, limit));
      if (matchingSubs.length === 0) continue;
      anyMatched = true;
      const candNorm = normalize(candSeg);
      const ca = actionState(candSeg);
      const scored = matchingSubs.map(({ sub, idx }) => {
        const subNorm = normalize(sub);
        const sa = actionState(sub);
        const sameAct = Boolean(sa && ca && sameAction(sa, ca));
        const fwd = coverageOf(sub, candNorm);
        const rev = coverageOf(candSeg, subNorm);
        const score = (sameAct ? 2 : 0) + fwd + rev;
        const conflict = isSegmentPolarityConflict(sub, candSeg, ruleNegative(sub), limit, sub);
        return { sub, idx, sameAct, score, conflict };
      });
      const bestScore = Math.max(...scored.map((x) => x.score));
      const top = scored.filter((x) => x.score >= bestScore - 0.35 || x.sameAct);
      if (top.some((x) => x.conflict)) return true;
      for (const x of top) matchedSrcIndices.add(x.idx);
    }
    const srcNormHasMixedPolarity =
      srcNormSegments.length > 1 && new Set(srcNormSegments.map((s) => ruleNegative(s))).size > 1;
    const allNegSrcSubsMatched = srcNormSegments.every((sub, idx) => !ruleNegative(sub) || matchedSrcIndices.has(idx));
    if (anyMatched && (!conditionParts(contextSource) || (srcNormHasMixedPolarity && allNegSrcSubsMatched))) {
      return false;
    }
  }
  return hasSingleSourcePolarityConflict(normativeSource, candForPolarity, srcNeg, limit, segments, contextSource);
}

const BARE_SHORT_COMMAND_VERB_RE =
  /^(?:(?:保留|删除|运行|使用|发布|重启|复制|输出|跑)|(?:use|run|keep|retain|preserve|delete|remove|restart|deploy|copy|move|sync|transfer|output|format))$/i;
const BARE_ISOLATED_MODAL_RE =
  /(?:需要|必须|务必|只能|一定要|应当|应该|请|记得|注意|\b(?:need|needs|must|shall|ought\s+to|required\s+to|always|only|ensure|remember|required|should|please)\b)/gi;

function isBareShortVerbSource(normativeSource, activeSource = normativeSource) {
  if (conditionParts(activeSource)) return false;
  if (ruleNegative(normativeSource) || negationsOf(normativeSource).length > 0) return false;
  if (numericFacts(normativeSource).length > 0 || scalarRequirement(normativeSource) !== null) return false;
  const cleaned = normalizeConditionalInput(normativeSource)
    .replace(/[。.!！?？;；，,:：\s]+$/g, '')
    .trim();
  if (!cleaned) return false;
  if (BARE_SHORT_COMMAND_VERB_RE.test(cleaned)) return true;
  const remainder = cleaned
    .replace(BARE_ISOLATED_MODAL_RE, ' ')
    .replace(/[。.!！?？;；，,:：、\-–—()（）[\]【】「」『』“”"'`~\s]+/g, '')
    .trim();
  return remainder.length === 0;
}

function conflictForPair(source, candidate, limit) {
  let activeSource = source;
  const candNorm = normalize(candidate);
  if (!conditionParts(source) && coverageOf(source, candNorm) < 1) {
    const subClauses = splitContrastClauses(source);
    if (subClauses.length > 1) {
      const matchingSubs = subClauses.filter((sub) => clauseMatchesSource(sub, candidate, limit));
      if (matchingSubs.length > 0) {
        const instSubs = matchingSubs.filter((sub) => isInstructionLine(sub));
        const pool = instSubs.length > 0 ? instSubs : matchingSubs;
        const scoreSub = (sub) => coverageOf(sub, candNorm) + coverageOf(candidate, normalize(sub));
        pool.sort((a, b) => scoreSub(b) - scoreSub(a));
        activeSource = pool[0];
      }
    }
  }
  if (!conditionParts(activeSource) && !exceptionTarget(activeSource) && coverageOf(activeSource, candNorm) < 1) {
    const normSegs = normativeSourceSegments(activeSource);
    if (normSegs.length > 0 && !(normSegs.length === 1 && normSegs[0] === activeSource)) {
      const candSegs = localPolaritySegments(candidate);
      const candPool = candSegs.length > 1 ? candSegs : [candidate];
      const matchingNormSubs = normSegs.filter((sub) =>
        candPool.some((candSeg) => clauseMatchesSingle(sub, candSeg, limit)),
      );
      if (matchingNormSubs.length > 0) {
        const scoreSub = (sub) => coverageOf(sub, candNorm) + coverageOf(candidate, normalize(sub));
        matchingNormSubs.sort((a, b) => scoreSub(b) - scoreSub(a));
        activeSource = matchingNormSubs[0];
      }
    }
  }
  const sEx = exceptionTarget(activeSource);
  const cEx = exceptionTarget(candidate);
  const cond = conditionParts(activeSource);
  const candCond = conditionParts(candidate);
  const purposeMain = !cond ? stripPurposeAvoidClause(activeSource) : null;
  const candPurposeMain = !candCond ? stripPurposeAvoidClause(candidate) : null;
  const normativeSource = cond ? cond.consequence : (purposeMain ?? activeSource);
  const candNormative = candCond ? candCond.consequence : (candPurposeMain ?? candidate);
  const srcNeg = ruleNegative(sEx ? stripException(normativeSource) : normativeSource);
  const candForPolarity = cEx ? stripException(candNormative) : candNormative;

  if (
    hasBooleanSwitchConflict(activeSource, candidate) ||
    hasCliFlagConflict(activeSource, candidate) ||
    (isInstructionLine(normativeSource) &&
      !isBareShortVerbSource(normativeSource, activeSource) &&
      hasPolarityConflict(normativeSource, candForPolarity, srcNeg, limit, activeSource))
  ) {
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
    const temporalBeforeRe = /(?:之前|以前|\bbefore\b|\bprior\s+to\b)/i;
    const temporalAfterRe = /(?:完毕(?:之|以)?后|完成(?:之|以)?后|结束(?:之|以)?后|之后|以后|\bafter\b|\bonce\b)/i;
    const srcBefore = temporalBeforeRe.test(cond.predicate);
    const candBefore = temporalBeforeRe.test(candCond.predicate);
    const srcAfter = temporalAfterRe.test(cond.predicate);
    const candAfter = temporalAfterRe.test(candCond.predicate);
    const temporalOrderFlip =
      (srcBefore && !srcAfter && candAfter && !candBefore) ||
      (srcAfter && !srcBefore && candBefore && !candAfter);
    if (
      srcUnless !== candUnless ||
      connectorMismatch ||
      droppedTerm ||
      temporalOrderFlip ||
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

const UNIT_OPT_RE = '(?:ms|s|sec|seconds?|months?|m|min|minutes?|h|hours?|d|days?|weeks?|years?|yrs?|gb|gib|mb|mib|kb|kib|tb|tib|bytes?|b|g|%|毫秒|秒|分钟?|小时|天|个月|周|星期|年|字节|个|次|条)?';
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

const DISTINGUISHING_IDENT_RE = /[a-z][a-z0-9_.-]*[_\d][a-z0-9_.-]*|[a-z0-9_.-]+\.[a-z]{1,6}/gi;

function lineFactsPreservedIn(line, targetText, targetNorm) {
  const sClean = stripExplicitValueCorrection(stripSeqCitations(String(line ?? '')));
  const sFacts = numericFacts(sClean);
  if (sFacts.length > 0) {
    const tFacts = numericFacts(targetText);
    if (tFacts.length === 0) return false;
    const sImplied = identifierImpliedUnits(sClean);
    const tImplied = identifierImpliedUnits(targetText);
    for (const sTok of sFacts) {
      if (!tFacts.some((cTok) => singleNumericFactMatches(sTok, cTok, sImplied, tImplied))) {
        return false;
      }
    }
  }
  const sBools = extractBooleanSwitches(sClean);
  if (sBools.size > 0) {
    const tBools = extractBooleanSwitches(targetText);
    for (const [k, sVals] of sBools.entries()) {
      if (sVals.size !== 1) continue;
      const tVals = tBools.get(k);
      if (!tVals || tVals.size !== 1 || [...tVals][0] !== [...sVals][0]) return false;
    }
  }
  const sFlags = extractCliFlags(sClean);
  if (sFlags.size > 0) {
    const tFlags = extractCliFlags(targetText);
    for (const [stem, sVals] of sFlags.entries()) {
      if (sVals.size !== 1) continue;
      const tVals = tFlags.get(stem);
      if (!tVals || tVals.size !== 1 || [...tVals][0] !== [...sVals][0]) return false;
    }
  }
  const sStrippedIds = sClean.replace(LOC_REF_RE, ' ').replace(NON_QUANTITY_NUM_RE, ' ');
  const tAscii = asciiWordsOf(targetNorm);
  for (const m of sStrippedIds.matchAll(DISTINGUISHING_IDENT_RE)) {
    const tok = m[0].toLowerCase();
    if (!tAscii.has(tok) && !targetNorm.includes(tok)) {
      return false;
    }
  }
  return true;
}

const DISABLE_ENABLE_CUE_RE = /(?:禁用|关闭|停用|阻断|启用|开启|打开|允许|放行|\b(?:disable|enable|turn\s+off|turn\s+on|allow|permit)\b)/i;

function queryFeatureTokens(text) {
  const norm = normalize(text);
  const featSet = new Set();
  for (const tok of coverageTokens(norm)) {
    if (ASCII_TOKEN_RE.test(tok) || CJK_BIGRAM_RE.test(tok)) {
      featSet.add(tok);
    } else if (tok.length > 1) {
      let added = false;
      for (const sub of tok.matchAll(/[a-z0-9_]+|[\u4e00-\u9fff\u3400-\u4dbf]{2}/gi)) {
        featSet.add(sub[0].toLowerCase());
        added = true;
      }
      if (!added) featSet.add(tok);
    } else {
      featSet.add(tok);
    }
  }
  for (const tok of asciiWordsOf(norm)) featSet.add(tok);
  for (const bg of cjkBigramsOf(norm)) featSet.add(bg);
  return featSet;
}

function subQueriesForLine(line, limit) {
  const seen = new Map();
  const addSub = (rawSub, weight) => {
    const text = normalize(rawSub);
    if (!text) return;
    const prev = seen.get(text);
    if (prev === undefined || weight < prev) seen.set(text, weight);
  };
  const weightMain = Math.min(limit, 0.35);
  const roots = [line];
  for (const seg of normativeSourceSegments(line)) {
    if (seg !== line) roots.push(seg);
  }
  const purposeMain = stripPurposeAvoidClause(line);
  if (purposeMain && isInstructionLine(purposeMain) && purposeMain !== line) {
    roots.push(purposeMain);
  }

  for (const s of roots) {
    const sNorm = normalize(s);
    addSub(sNorm, weightMain);
    const noCorr = stripExplicitValueCorrection(s);
    if (noCorr !== s) addSub(noCorr, limit);
    for (const sc of splitContrastClauses(s)) {
      if (isInstructionLine(sc)) addSub(sc, limit);
    }
    const coreNorm = stripNegAndModal(proseOnly(sNorm));
    if (coreNorm) addSub(coreNorm, Math.max(limit, 0.75));
    const cond = conditionParts(s);
    if (cond) {
      addSub(cond.consequence, limit);
      const consCore = stripNegAndModal(cond.consequence);
      if (consCore) addSub(consCore, limit);
    }
    const strippedBullet = stripSeqCitations(s).replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim();
    const sScalar = scalarRequirement(stripExplicitValueCorrection(strippedBullet));
    if (sScalar?.subject) addSub(sScalar.subject, 1);
  }

  const out = [];
  for (const [text, weight] of seen.entries()) {
    const toks = coverageTokens(text);
    if (toks.length === 0) continue;
    if (toks.every((t) => t.length === 1 && !ASCII_TOKEN_RE.test(t))) return null;
    const dupes = toks.length - new Set(toks).size;
    const needed = Math.max(1, Math.ceil(weight * toks.length) - dupes);
    out.push({ text, needed });
  }
  return out;
}

const CANDIDATE_SEQ_CITE_RE =
  /(?:\[\s*seqs?\s+([\d\s,–-]+)\s*\]|[（(]\s*seqs?\s+([\d\s,–-]+)\s*[)）]|\bseqs?\s*[:#=]?\s*(\d+)\b)/gi;

function candidateSeqCitations(text) {
  const out = new Set();
  const str = String(text ?? '');
  for (const m of str.matchAll(CANDIDATE_SEQ_CITE_RE)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    for (const num of raw.matchAll(/\d+/g)) {
      const n = Number(num[0]);
      if (Number.isSafeInteger(n) && n >= 0) out.add(n);
    }
  }
  return out;
}

export function auditCompaction({ userMessages, summaryText, checkpointText, threshold, includeAllConflicts = false, referenceMessages = [] }) {
  const originalMessages = userMessages ?? [];
  const trustedMessages = originalMessages
    .filter((message) => !isReferenceContextKind(message.sourceKind) && !message.externalFold && !isSystemReminderOnly(message) && !isReferencePrefixOnly(message))
    .map((message) => ({ ...message, text: instructionText(message) }));

  const limit = typeof threshold === 'number' && Number.isFinite(threshold) ? threshold : 0.6;
  const rawCheckpoint = String(checkpointText ?? summaryText).replace(ACTIVE_FILES_TAG_RE, ' ');
  const haystack = normalize(rawCheckpoint.replace(/\*\*|__/g, ''));
  const summaryProseText = summaryText ? summaryProse(summaryText) : String(rawCheckpoint ?? '');
  const summaryProseNorm = normalize(summaryProseText.replace(/\*\*|__/g, ''));
  const summaryClauses = splitContrastClauses(summaryText ? summaryProse(summaryText) : '');
  const messageLines = trustedMessages.map((message) => ({
    message,
    lines: sourceEvidenceSentences(stripFencedCodeBlocks(message.text)).filter(
      (line) => isInstructionLine(line) || hasRequirementNumericCue(line),
    ),
  }));

  const allTrustedEntries = messageLines.flatMap((entry) =>
    entry.lines.map((peerLine) => ({ seq: entry.message.seq, line: peerLine })),
  );

  const clauseCount = summaryClauses.length;
  const useCandidateIndex = clauseCount >= 12 && limit >= 0.25;
  const clausesByFeat = useCandidateIndex ? new Map() : null;
  const clausesByScalarSubject = useCandidateIndex ? new Map() : null;
  const clausesByActionKey = useCandidateIndex ? new Map() : null;
  const clausesByBoolKey = useCandidateIndex ? new Map() : null;
  const clausesByFlagStem = useCandidateIndex ? new Map() : null;
  const clausesByCanonFact = useCandidateIndex ? new Map() : null;
  const alwaysCheckClauses = useCandidateIndex ? [] : null;
  const clauseMeta = summaryClauses.map((text, ci) => {
    const norm = normalize(text);
    const clean = stripSeqCitations(text);
    const cleanNorm = normalize(clean);
    const featSet = useCandidateIndex ? queryFeatureTokens(cleanNorm || norm) : null;
    const cNums = numericFacts(text);
    if (useCandidateIndex) {
      if (norm.length === 0 || norm.length > 2048 || DISABLE_ENABLE_CUE_RE.test(norm)) {
        alwaysCheckClauses.push(ci);
      }
      for (const feat of featSet) {
        let arr = clausesByFeat.get(feat);
        if (!arr) {
          arr = [];
          clausesByFeat.set(feat, arr);
        }
        arr.push(ci);
      }
      const cStripped = stripExplicitValueCorrection(clean.replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim());
      const cScalar = scalarRequirement(cStripped);
      if (cScalar?.subject) {
        let arr = clausesByScalarSubject.get(cScalar.subject);
        if (!arr) {
          arr = [];
          clausesByScalarSubject.set(cScalar.subject, arr);
        }
        arr.push(ci);
      }
      const cAct = actionState(text) ?? actionState(clean);
      if (cAct?.key) {
        let arr = clausesByActionKey.get(cAct.key);
        if (!arr) {
          arr = [];
          clausesByActionKey.set(cAct.key, arr);
        }
        arr.push(ci);
      }
      for (const seg of localPolaritySegments(text)) {
        const segAct = actionState(seg);
        if (segAct?.key) {
          let arr = clausesByActionKey.get(segAct.key);
          if (!arr) {
            arr = [];
            clausesByActionKey.set(segAct.key, arr);
          }
          if (!arr.includes(ci)) arr.push(ci);
        }
      }
      for (const k of extractBooleanSwitches(text).keys()) {
        let arr = clausesByBoolKey.get(k);
        if (!arr) {
          arr = [];
          clausesByBoolKey.set(k, arr);
        }
        arr.push(ci);
      }
      for (const stem of extractCliFlags(text).keys()) {
        let arr = clausesByFlagStem.get(stem);
        if (!arr) {
          arr = [];
          clausesByFlagStem.set(stem, arr);
        }
        arr.push(ci);
      }
      for (const tok of cNums) {
        const cf = canonicalFactToken(tok);
        if (!cf.includes(':')) continue;
        let arr = clausesByCanonFact.get(cf);
        if (!arr) {
          arr = [];
          clausesByCanonFact.set(cf, arr);
        }
        if (!arr.includes(ci)) arr.push(ci);
      }
    }
    return {
      text,
      norm,
      clean,
      cleanNorm,
      featSet,
      cNums,
      seqs: candidateSeqCitations(text),
      hasNormativeOrCurrentClaim:
        CN_MODAL.test(norm) ||
        EN_MODAL.test(norm) ||
        COMMAND.test(norm) ||
        NORMATIVE_OR_CURRENT_CLAIM_RE.test(norm),
      neg: ruleNegative(text),
      numsKey: canonicalNumsKey(text),
    };
  });

  const lineIdByText = new Map();
  const lineMeta = [];
  const internLine = (line) => {
    let id = lineIdByText.get(line);
    if (id !== undefined) return id;
    id = lineMeta.length;
    lineIdByText.set(line, id);
    const lineNoCorrection = stripExplicitValueCorrection(line);
    const strippedBullet = stripSeqCitations(line).replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim();
    const sScalar = scalarRequirement(stripExplicitValueCorrection(strippedBullet));
    const norm = normalize(line);
    const lineToks = coverageTokens(line);
    const lineUniqueLen = new Set(lineToks).size;
    const sNums = numericFacts(line);
    lineMeta.push({
      line,
      norm,
      lineNoCorrection,
      srcNeg: ruleNegative(line),
      lineIsScalar: sScalar !== null,
      scalarSubject: sScalar?.subject ?? null,
      sNums,
      numsKey: canonicalNumsKey(line),
      minPeerNeeded: lineToks.length === 0 ? 0 : Math.max(1, Math.ceil(0.75 * lineToks.length) - (lineToks.length - lineUniqueLen)),
      factsPreservedInSummary: null,
      matchedIndices: null,
    });
    return id;
  };
  const entryLineIds = allTrustedEntries.map((entry) => internLine(entry.line));
  const uniqueLineCount = lineMeta.length;
  const usePeerEntryIndex = uniqueLineCount >= 12 && clauseCount >= 12;
  const lineIdsByFeat = usePeerEntryIndex ? new Map() : null;
  const alwaysCheckLineIds = usePeerEntryIndex ? [] : null;
  if (usePeerEntryIndex) {
    for (let lid = 0; lid < uniqueLineCount; lid += 1) {
      const lm = lineMeta[lid];
      if (lm.norm.length === 0 || lm.norm.length > 2048 || lm.minPeerNeeded <= 0) {
        alwaysCheckLineIds.push(lid);
        continue;
      }
      const lineToks = coverageTokens(lm.line);
      if (lineToks.every((t) => t.length === 1 && !ASCII_TOKEN_RE.test(t))) {
        alwaysCheckLineIds.push(lid);
        continue;
      }
      for (const feat of queryFeatureTokens(lm.norm)) {
        let arr = lineIdsByFeat.get(feat);
        if (!arr) {
          arr = [];
          lineIdsByFeat.set(feat, arr);
        }
        arr.push(lid);
      }
    }
  }
  const lineEntriesByLineId = usePeerEntryIndex ? Array.from({ length: uniqueLineCount }, () => []) : null;
  if (usePeerEntryIndex) {
    for (let pi = 0; pi < allTrustedEntries.length; pi += 1) {
      lineEntriesByLineId[entryLineIds[pi]].push(pi);
    }
  }
  const peerLineHitCounts = usePeerEntryIndex ? new Uint16Array(uniqueLineCount) : null;
  const peerLineQueued = usePeerEntryIndex ? new Uint8Array(uniqueLineCount) : null;
  const peerLineTouched = usePeerEntryIndex ? [] : null;
  const peerLinePool = usePeerEntryIndex ? [] : null;
  const totalSlots = uniqueLineCount * clauseCount;
  const useFlatMemo = totalSlots > 0 && totalSlots <= 250000;
  const candHitCounts = useCandidateIndex ? new Uint16Array(clauseCount) : null;
  const candQueued = useCandidateIndex ? new Uint8Array(clauseCount) : null;
  const candTouched = useCandidateIndex ? [] : null;
  const candPool = useCandidateIndex ? [] : null;

  const candidateClauseIndicesForLine = (lm) => {
    if (!useCandidateIndex || lm.norm.length > 2048 || DISABLE_ENABLE_CUE_RE.test(lm.norm)) {
      return null;
    }
    const subQueries = subQueriesForLine(lm.line, limit);
    if (!subQueries || subQueries.length === 0) return null;
    candPool.length = 0;

    for (let i = 0; i < alwaysCheckClauses.length; i += 1) {
      const ci = alwaysCheckClauses[i];
      if (!candQueued[ci]) {
        candQueued[ci] = 1;
        candPool.push(ci);
      }
    }
    if (lm.scalarSubject) {
      const list = clausesByScalarSubject.get(lm.scalarSubject);
      if (list) {
        for (let i = 0; i < list.length; i += 1) {
          const ci = list[i];
          if (!candQueued[ci]) {
            candQueued[ci] = 1;
            candPool.push(ci);
          }
        }
      }
    }
    const checkAction = (actText) => {
      const act = actionState(actText);
      if (!act?.key) return;
      const list = clausesByActionKey.get(act.key);
      if (!list) return;
      for (let i = 0; i < list.length; i += 1) {
        const ci = list[i];
        if (!candQueued[ci]) {
          candQueued[ci] = 1;
          candPool.push(ci);
        }
      }
    };
    checkAction(lm.line);
    const cond = conditionParts(lm.line);
    if (cond?.consequence) checkAction(cond.consequence);
    for (const seg of normativeSourceSegments(lm.line)) checkAction(seg);
    for (const k of extractBooleanSwitches(lm.line).keys()) {
      const list = clausesByBoolKey.get(k);
      if (list) {
        for (let i = 0; i < list.length; i += 1) {
          const ci = list[i];
          if (!candQueued[ci]) {
            candQueued[ci] = 1;
            candPool.push(ci);
          }
        }
      }
    }
    for (const stem of extractCliFlags(lm.line).keys()) {
      const list = clausesByFlagStem.get(stem);
      if (list) {
        for (let i = 0; i < list.length; i += 1) {
          const ci = list[i];
          if (!candQueued[ci]) {
            candQueued[ci] = 1;
            candPool.push(ci);
          }
        }
      }
    }
    for (const tok of lm.sNums) {
      const cf = canonicalFactToken(tok);
      if (!cf.includes(':')) continue;
      const list = clausesByCanonFact.get(cf);
      if (list) {
        for (let i = 0; i < list.length; i += 1) {
          const ci = list[i];
          if (!candQueued[ci]) {
            candQueued[ci] = 1;
            candPool.push(ci);
          }
        }
      }
    }

    for (let qi = 0; qi < subQueries.length; qi += 1) {
      const { text, needed } = subQueries[qi];
      const feats = queryFeatureTokens(text);
      if (feats.size === 0) continue;
      candTouched.length = 0;
      for (const feat of feats) {
        const list = clausesByFeat.get(feat);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 1) {
          const ci = list[i];
          const next = candHitCounts[ci] + 1;
          if (next === 1) candTouched.push(ci);
          candHitCounts[ci] = next;
        }
      }
      for (let i = 0; i < candTouched.length; i += 1) {
        const ci = candTouched[i];
        if (candHitCounts[ci] >= needed && !candQueued[ci]) {
          candQueued[ci] = 1;
          candPool.push(ci);
        }
        candHitCounts[ci] = 0;
      }
    }
    for (let i = 0; i < candPool.length; i += 1) {
      candQueued[candPool[i]] = 0;
    }
    candPool.sort((a, b) => a - b);
    return candPool;
  };

  const conflictFlat = useFlatMemo ? new Array(totalSlots).fill(false) : null;
  const conflictSparse = useFlatMemo ? null : new Map();
  const getConflict = (lineId, ci) => {
    const slot = lineId * clauseCount + ci;
    if (useFlatMemo) {
      const cached = conflictFlat[slot];
      if (cached !== false) return cached;
      const computed = conflictForPair(lineMeta[lineId].line, clauseMeta[ci].text, limit);
      conflictFlat[slot] = computed;
      return computed;
    }
    if (conflictSparse.has(slot)) return conflictSparse.get(slot);
    const computed = conflictForPair(lineMeta[lineId].line, clauseMeta[ci].text, limit);
    conflictSparse.set(slot, computed);
    return computed;
  };

  const scopeFlat = useFlatMemo ? new Uint8Array(totalSlots) : null;
  const scopeSparse = useFlatMemo ? null : new Map();
  const getScopes = (lineId, ci) => {
    const slot = lineId * clauseCount + ci;
    if (useFlatMemo) {
      const cached = scopeFlat[slot];
      if (cached !== 0) return cached === 2;
      const ok = scopesCompatible(lineMeta[lineId].line, clauseMeta[ci].text);
      scopeFlat[slot] = ok ? 2 : 1;
      return ok;
    }
    if (scopeSparse.has(slot)) return scopeSparse.get(slot);
    const ok = scopesCompatible(lineMeta[lineId].line, clauseMeta[ci].text);
    scopeSparse.set(slot, ok);
    return ok;
  };

  const scalarFlat = useFlatMemo ? new Uint8Array(totalSlots) : null;
  const scalarSparse = useFlatMemo ? null : new Map();
  const getScalarMatch = (lineId, ci) => {
    const slot = lineId * clauseCount + ci;
    if (useFlatMemo) {
      const cached = scalarFlat[slot];
      if (cached !== 0) return cached === 2 ? 'match' : cached === 3 ? 'mismatch' : null;
      const v = scalarSubjectVerdict(lineMeta[lineId].line, clauseMeta[ci].text);
      scalarFlat[slot] = v === 'match' ? 2 : v === 'mismatch' ? 3 : 1;
      return v;
    }
    if (scalarSparse.has(slot)) return scalarSparse.get(slot);
    const v = scalarSubjectVerdict(lineMeta[lineId].line, clauseMeta[ci].text);
    scalarSparse.set(slot, v);
    return v;
  };

  const covLineInNormFlat = useFlatMemo ? new Float64Array(totalSlots).fill(-1) : null;
  const covLineInNormSparse = useFlatMemo ? null : new Map();
  const getCovLineInNorm = (lineId, ci) => {
    const slot = lineId * clauseCount + ci;
    if (useFlatMemo) {
      const cached = covLineInNormFlat[slot];
      if (cached >= 0) return cached;
      const v = coverageOf(lineMeta[lineId].line, clauseMeta[ci].norm);
      covLineInNormFlat[slot] = v;
      return v;
    }
    if (covLineInNormSparse.has(slot)) return covLineInNormSparse.get(slot);
    const v = coverageOf(lineMeta[lineId].line, clauseMeta[ci].norm);
    covLineInNormSparse.set(slot, v);
    return v;
  };

  const covLineInCleanFlat = useFlatMemo ? new Float64Array(totalSlots).fill(-1) : null;
  const covLineInCleanSparse = useFlatMemo ? null : new Map();
  const getCovLineInClean = (lineId, ci) => {
    const slot = lineId * clauseCount + ci;
    if (useFlatMemo) {
      const cached = covLineInCleanFlat[slot];
      if (cached >= 0) return cached;
      const v = coverageOf(lineMeta[lineId].line, clauseMeta[ci].cleanNorm);
      covLineInCleanFlat[slot] = v;
      return v;
    }
    if (covLineInCleanSparse.has(slot)) return covLineInCleanSparse.get(slot);
    const v = coverageOf(lineMeta[lineId].line, clauseMeta[ci].cleanNorm);
    covLineInCleanSparse.set(slot, v);
    return v;
  };

  const covCleanInLineFlat = useFlatMemo ? new Float64Array(totalSlots).fill(-1) : null;
  const covCleanInLineSparse = useFlatMemo ? null : new Map();
  const getCovCleanInLine = (lineId, ci) => {
    const slot = lineId * clauseCount + ci;
    if (useFlatMemo) {
      const cached = covCleanInLineFlat[slot];
      if (cached >= 0) return cached;
      const v = coverageOf(clauseMeta[ci].clean, lineMeta[lineId].norm);
      covCleanInLineFlat[slot] = v;
      return v;
    }
    if (covCleanInLineSparse.has(slot)) return covCleanInLineSparse.get(slot);
    const v = coverageOf(clauseMeta[ci].clean, lineMeta[lineId].norm);
    covCleanInLineSparse.set(slot, v);
    return v;
  };

  const peerIndexByCi = new Array(clauseCount);
  const getPeerIndex = (ci) => {
    let indexed = peerIndexByCi[ci];
    if (indexed) return indexed;
    const explicitMinCov = Math.max(limit, 0.75);
    const candSeqs = clauseMeta[ci].seqs;
    const explicitEntries = [];
    const topForward = [];
    const topReverse = [];
    const recordTop2 = (top, line, val) => {
      if (top.length > 0 && top[0].line === line) {
        if (val > top[0].val) top[0].val = val;
        return;
      }
      if (top.length > 1 && top[1].line === line) {
        if (val > top[1].val) top[1].val = val;
        if (top[1].val > top[0].val) {
          const tmp = top[0];
          top[0] = top[1];
          top[1] = tmp;
        }
        return;
      }
      if (top.length === 0 || val > top[0].val) {
        top.unshift({ line, val });
        if (top.length > 2) top.length = 2;
      } else if (top.length === 1 || val > top[1].val) {
        top[1] = { line, val };
      }
    };

    const checkPeerEntry = (pi) => {
      const pLineId = entryLineIds[pi];
      const peerCov = getCovLineInClean(pLineId, ci);
      const candInPeer = getCovCleanInLine(pLineId, ci);
      const peerEntry = allTrustedEntries[pi];
      const needExplicit = candSeqs.size > 0 && candSeqs.has(peerEntry.seq) && peerCov >= explicitMinCov;
      const needForward = peerCov >= 0.85;
      const needReverse = candInPeer >= 0.85;
      if (!needExplicit && !needForward && !needReverse) return;
      if (!getScopes(pLineId, ci)) return;
      if (getConflict(pLineId, ci) !== null) return;
      if (needExplicit) {
        explicitEntries.push({ seq: peerEntry.seq, line: peerEntry.line });
      }
      if (needForward) recordTop2(topForward, peerEntry.line, peerCov);
      if (needReverse) recordTop2(topReverse, peerEntry.line, candInPeer);
    };

    const cm = clauseMeta[ci];
    const cleanToks = coverageTokens(cm.clean);
    const canFilterPeers =
      usePeerEntryIndex &&
      cm.cleanNorm.length > 0 &&
      cm.cleanNorm.length <= 2048 &&
      cleanToks.length > 0 &&
      !cleanToks.every((t) => t.length === 1 && !ASCII_TOKEN_RE.test(t));

    if (!canFilterPeers) {
      for (let pi = 0; pi < allTrustedEntries.length; pi += 1) {
        checkPeerEntry(pi);
      }
    } else {
      const candUniqueLen = new Set(cleanToks).size;
      const neededCand = Math.max(1, Math.ceil(0.85 * cleanToks.length) - (cleanToks.length - candUniqueLen));
      const cFeats = cm.featSet ?? queryFeatureTokens(cm.cleanNorm || cm.norm);
      peerLineTouched.length = 0;
      peerLinePool.length = 0;
      for (const feat of cFeats) {
        const list = lineIdsByFeat.get(feat);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 1) {
          const lid = list[i];
          const next = peerLineHitCounts[lid] + 1;
          if (next === 1) peerLineTouched.push(lid);
          peerLineHitCounts[lid] = next;
        }
      }
      for (let i = 0; i < alwaysCheckLineIds.length; i += 1) {
        const lid = alwaysCheckLineIds[i];
        if (!peerLineQueued[lid]) {
          peerLineQueued[lid] = 1;
          peerLinePool.push(lid);
        }
      }
      for (let i = 0; i < peerLineTouched.length; i += 1) {
        const lid = peerLineTouched[i];
        const hits = peerLineHitCounts[lid];
        peerLineHitCounts[lid] = 0;
        if ((hits >= lineMeta[lid].minPeerNeeded || hits >= neededCand) && !peerLineQueued[lid]) {
          peerLineQueued[lid] = 1;
          peerLinePool.push(lid);
        }
      }
      for (let i = 0; i < peerLinePool.length; i += 1) {
        const lid = peerLinePool[i];
        peerLineQueued[lid] = 0;
        const entryIndices = lineEntriesByLineId[lid];
        for (let j = 0; j < entryIndices.length; j += 1) {
          checkPeerEntry(entryIndices[j]);
        }
      }
    }

    indexed = { explicitEntries, topForward, topReverse };
    peerIndexByCi[ci] = indexed;
    return indexed;
  };

  const exactCovThresh = Math.max(limit, 0.8);
  const cleanCovThresh = Math.max(limit, 0.72);
  const lost = [];
  let checked = 0;
  let worst = 1;
  let polarityFlips = 0;

  for (const { message, lines } of messageLines) {
    for (const line of lines) {
      checked += 1;
      const lineId = internLine(line);
      const lm = lineMeta[lineId];
      const lineNoCorrection = lm.lineNoCorrection;
      let coverage = Math.max(
        coverageOf(line, haystack),
        lineNoCorrection !== line ? coverageOf(lineNoCorrection, haystack) : 0,
      );
      const srcNeg = lm.srcNeg;
      const lineIsScalar = lm.lineIsScalar;

      if (lm.matchedIndices === null) {
        const indices = [];
        const candList = candidateClauseIndicesForLine(lm);
        if (candList === null) {
          for (let ci = 0; ci < clauseCount; ci += 1) {
            if (clauseMatchesSource(line, clauseMeta[ci].text, limit)) indices.push(ci);
          }
        } else {
          for (let k = 0; k < candList.length; k += 1) {
            const ci = candList[k];
            if (clauseMatchesSource(line, clauseMeta[ci].text, limit)) indices.push(ci);
          }
        }
        lm.matchedIndices = indices;
      }
      const matchedIndices = lm.matchedIndices;

      let hasExactActiveMatch = false;
      for (const ci of matchedIndices) {
        if (
          getCovLineInNorm(lineId, ci) >= exactCovThresh &&
          getConflict(lineId, ci) === null &&
          (!lineIsScalar || getScalarMatch(lineId, ci) === 'match')
        ) {
          hasExactActiveMatch = true;
          break;
        }
      }
      let hasCleanActiveMatch = hasExactActiveMatch;
      if (!hasCleanActiveMatch) {
        for (const ci of matchedIndices) {
          if (
            getCovLineInClean(lineId, ci) >= cleanCovThresh &&
            getConflict(lineId, ci) === null &&
            (!lineIsScalar || getScalarMatch(lineId, ci) === 'match')
          ) {
            hasCleanActiveMatch = true;
            break;
          }
        }
      }

      const conflicts = [];
      let cachedHasOtherSupport;
      const factsPreservedInSummary = () => {
        if (lm.factsPreservedInSummary === null) {
          lm.factsPreservedInSummary = lineFactsPreservedIn(line, summaryProseText, summaryProseNorm);
        }
        return lm.factsPreservedInSummary;
      };
      for (const ci of matchedIndices) {
        const conflict = getConflict(lineId, ci);
        if (!conflict) continue;
        const cm = clauseMeta[ci];
        if (
          hasExactActiveMatch &&
          conflict.reason === 'value' &&
          !cm.hasNormativeOrCurrentClaim &&
          isBoundHistoricalValue(line, cm.text)
        ) {
          continue;
        }
        if (getScalarMatch(lineId, ci) === 'mismatch') {
          conflicts.push(conflict);
          continue;
        }
        const lineCov = getCovLineInClean(lineId, ci);
        const candInLine = getCovCleanInLine(lineId, ci);
        const candSeqs = cm.seqs;
        const lineSupportedElsewhere = hasCleanActiveMatch;
        const peerIndex = getPeerIndex(ci);
        let ownedByPeer = false;

        if (lineSupportedElsewhere && peerIndex.explicitEntries.length > 0 && !candSeqs.has(message.seq)) {
          for (const p of peerIndex.explicitEntries) {
            if (p.seq !== message.seq && p.line !== line) {
              ownedByPeer = true;
              break;
            }
          }
        }
        if (!ownedByPeer) {
          const bestF = peerIndex.topForward.find((p) => p.line !== line);
          const forwardBetter = Boolean(
            bestF &&
              (bestF.val >= lineCov + 0.05 ||
                (lineSupportedElsewhere && bestF.val > lineCov && (bestF.val >= 0.98 || bestF.val >= lineCov + 0.02))),
          );
          let reverseBetter = false;
          if (!forwardBetter) {
            const bestR = peerIndex.topReverse.find((p) => p.line !== line);
            reverseBetter = Boolean(
              bestR &&
                (bestR.val >= candInLine + 0.05 ||
                  (lineSupportedElsewhere &&
                    bestR.val > candInLine &&
                    (bestR.val >= 0.98 || bestR.val >= candInLine + 0.02))),
            );
          }
          if ((forwardBetter || reverseBetter) && factsPreservedInSummary()) {
            if (lineSupportedElsewhere) {
              ownedByPeer = true;
            } else {
              if (cachedHasOtherSupport === undefined) {
                cachedHasOtherSupport = false;
                for (const oci of matchedIndices) {
                  if (getConflict(lineId, oci) === null) {
                    cachedHasOtherSupport = true;
                    break;
                  }
                }
              }
              ownedByPeer = cachedHasOtherSupport;
            }
          }
        }
        if (!ownedByPeer) conflicts.push(conflict);
      }

      if (coverage < limit && conflicts.length === 0) {
        const sNums = lm.sNums;
        const lineHasCond = conditionParts(line) !== null;
        const lineNonQuant = sNums.length > 0 && !lineHasCond ? stripQuantityTokens(line) : '';
        const lineNonQuantTokens = lineNonQuant ? coverageTokens(lineNonQuant) : [];
        for (let ci = 0; ci < clauseCount; ci += 1) {
          const cm = clauseMeta[ci];
          if (
            lm.numsKey === cm.numsKey &&
            srcNeg !== cm.neg &&
            getScopes(lineId, ci) &&
            equivalentAntonymPolarity(line, cm.text, srcNeg, cm.neg, limit)
          ) {
            coverage = 1;
            break;
          }
          if (!lineHasCond && getScopes(lineId, ci) && getConflict(lineId, ci) === null) {
            if (
              sNums.length > 0 &&
              srcNeg === cm.neg &&
              cm.cNums.length > 0 &&
              numericFactsEquivalent(line, cm.text, sNums, cm.cNums) &&
              (getScalarMatch(lineId, ci) === 'match' ||
                (lineNonQuantTokens.length > 0 && coverageOf(lineNonQuant, cm.norm) >= limit))
            ) {
              coverage = 1;
              break;
            }
            if (sharesPreservedCliOrBoolPolarity(line, cm.text)) {
              coverage = 1;
              break;
            }
          }
        }
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
  /(?:未|不|没有得到|没有获得|没有|尚无|尚未|并非|等待|等候|待|如(?:果)?|只有|仅当|除非|前置条件|前提(?:是|为)?|须先|需先|必须先|先经|先获|未经|未获|若无|若未|如无|如未)[^。！？;；\n]{0,35}(?:授权|批准|允许|同意)|(?:授权|批准|允许|同意)[^。！？;；\n]{0,12}(?:之?前(?:不得|不能|不要|禁止|不可|须|需)|后(?:才|方)(?:可|能|允许))|\b(?:(?:pending|awaiting|prerequisite|precondition)(?:\s*:)?|if|unless|not|no|without|requires?|must\s+first|before|prior\s+to|only\s+(?:if|when|after))\b[^.!?\n;:]{0,55}\b(?:approval|permission|consent|approved|authorized|authorised|approve|authorize|authorise|permit|allow)\b/i;

const COLLOQUIAL_USER_APPROVAL_RE =
  /(?:(?:^|[，,]\s*)(?:(?:你|你们|助手|现在|那就)\s*)?(?:可以直接|可直接|可以|准许|放行|确认|(?:行|好的?|没问题)(?:\s*[，,]\s*(?:请|你|你们|直接|可以|那就)?|\s+))(?:你|你们|去|直接|现在|继续|再|先)?\s*[\u4e00-\u9fffa-z0-9]|\b(?:you\s+(?:can|may)(?:\s+(?:now|just|directly))?\s+[a-z]|ok(?:ay)?\s+to\s+[a-z]|go\s+ahead\s+(?:and|with|to)\s+[a-z]|feel\s+free\s+to\s+[a-z]|confirmed\s+(?:to|for)\s+[a-z]|yes,\s+(?:please\s+|you\s+(?:can|may)\s+|go\s+ahead\s+(?:and|with|to)\s+)?[a-z]))/i;
const COLLOQUIAL_NON_GRANT_RE =
  /(?:是否|能否|可否|能不能|可不可以|行不行|好不好|对不对|为什么|为何|怎么|如何|如果|倘若|假如|除非|只有|仅当|一旦|前提|前置条件|待确认|先确认|需确认|须确认|请确认|确认一下|不确定|先问我|问我|再定|暂缓|先等等|未必|谁说|难道|[吗呢么]\s*$|\b(?:if|unless|whether|only\s+(?:if|when|after)|not\s+sure|uncertain|unsure|ask\s+me|confirm\s+with\s+me|before\s+confirming|wait\s+until)\b)/i;
const STANDALONE_AFFIRMATION_RE =
  /^(?:好的?|行|没问题|同意|批准|授权|允许|确认|可以|准许|ok(?:ay)?|yes|sure|agreed|confirmed)[。.!！\s]*$/i;
const ADVISORY_OR_OBSERVATION_PREFIX_RE =
  /^(?:注意|切记|切勿|谨记|提醒|提示|小心|别忘了|记得|顺便提一下|顺便说|另外注意|说明|备注|刚才|之前|以前|曾经|原来|当时|目前看来|好像|似乎|感觉|\b(?:note|caution|warning|reminder|remember|be\s+careful|fyi|btw|earlier|previously|currently|seems?)\b)/i;
const RETROSPECTIVE_GRANT_PREFIX_RE =
  /^(?:已(?:经)?|曾(?:经)?|之前|此前|正在|刚才|昨天|上次|\b(?:already|previously|earlier|currently|was|were)\b)/i;
const DIRECT_IMPERATIVE_GRANT_RE =
  /(?:^(?:请(?!问)|麻烦|帮我|直接|现在|立即|马上|那就)|吧\s*[。.!！\s]*$|^(?:please|now|go\s+ahead|just)\s+)/i;
const ACTION_DIRECTIVE_RE =
  /(?:^(?:请|麻烦|帮我|直接|顺便把|顺便|然后把|然后|接着把|接着|再把|再|并把|把|将)|(?:把|将)\S{1,24}(?:放进|放入|放到|放|移入|移到|存入|存进|存到|提交到?|推送到?|推上去|写进|写入|改为|改成|设为|设置为|删掉|删除|迁移到?|复制到?|同步到?)|(?:做|弄|搞)(?:一个|个)?[^\n。！？;；]{0,20}(?:私有)?(?:仓库|代码库|库|\brepo)|(?:发布|部署|推送|推上去|放进|放入|放到|创建|新建|建立|生成|删除|删掉|移除|清理|清除|保留|留存|修改|更新|调整|改为|改成|设为|设置为|运行|执行|跑|测试|安装|配置|同步|迁移|复制|移动|提交|合并|写入|写进|打开|关闭|重启|整理|归档|上传|下载|备份|恢复|开始|继续|开工|开跑|启动)|\b(?:please|publish|deploy|push|put|place|store|create|make|add|delete|remove|clean|keep|retain|modify|update|run|execute|test|install|configure|sync|migrate|copy|move|commit|merge|write|open|close|restart|upload|download|backup|restore|start|begin|continue|launch)\b)/i;

const APPROVAL_BOILERPLATE_RE =
  /(?:(?:我|用户)\s*(?:现在|已经|已|明确|现已|在此)?\s*(?:批准|授权|同意|允许)|(?:已|已经)?(?:获(?:得)?|得到)用户(?:授权|批准|同意)|\b(?:the\s+)?user\s+(?:has\s+)?(?:already\s+|explicitly\s+|now\s+)?(?:approved|authorized|authorised|permitted|allowed|consented|granted\s+permission(?:\s+(?:to|for))?)|\bi\s+(?:hereby\s+)?(?:authorize|authorise|approve|allow|permit|consent\s+to)|\b(?:approved|authorized|authorised|permitted)\s+by\s+(?:the\s+)?user|\bto\b|\bfor\b|\bthe\b)/gi;

const COLLOQUIAL_GRANT_STRIP_RE =
  /^(?:(?:你|你们|助手|现在|那就)\s*)?(?:可直接|可以直接|可以|准许|放行|确认|(?:好的?|行|没问题)(?:\s*[，,]\s*)?)+(?:请|你|你们|去|直接|现在|继续|再|先)?|^(?:yes[,\s]+(?:please\s+)?|ok(?:ay)?\s+to\s+|you\s+(?:can|may)(?:\s+(?:now|just|directly))?\s+|go\s+ahead\s+(?:and|with|to)\s+|feel\s+free\s+to\s+|confirmed\s+(?:to|for)\s+|please\s+)/gi;

const TEMPORAL_DIRECTIVE_LEAD_RE =
  /^(?:在\s*)?(?:[^\s，,。；;]{1,12}?(?:完成后|完毕后|结束后)|完成[^\s，,。；;]{1,12}?后(?![半续面边方端台期置退果悔代者来缀])|完成后|完毕后|结束后|之后|随后|然后|接着|再|请|麻烦|帮我|直接)\s*/i;

const REVOCATION_APPROVAL_RE =
  /\b(?:revoke|withdraw|cancel|rescind|reject|deny|forbid|disallow|ban|prohibit)\s+(?:my\s+|the\s+|this\s+)?(?:prior\s+|previous\s+)?(?:approval|authorization|authorisation|permission|consent)\b|\b(?:do\s+not|don't|no\s+longer|not)\s+(?:approve|authorize|authorise|permit|allow|consent)\b|(?:撤销|取消|收回|撤回|作废|不再|不|不要|禁止|拒绝)(?:之前|刚才|上述|先前的?)?(?:的)?(?:批准|授权|同意|允许)/i;

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
  ['exec', /(?:执行|运行|重跑|重运行|启动|调用|开始|开工|开跑|继续|\b(?:exec|execute|run|rerun|invoke|eval|launch|start|begin|continue)\b)/i],
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

const stripApprovalBoilerplate = (text) => {
  const cleaned = normalize(stripSeqCitationsForApproval(text))
    .replace(/\*\*|__/g, ' ')
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(APPROVAL_BOILERPLATE_RE, ' ')
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(/(?:^|\s)[:：]+|[:：]+(?=\s|$)/g, ' ')
    .replace(/^[)）]+|[（(]+$/g, ' ')
    .replace(/[。.!！?？;；，,…]+/g, ' ')
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return coverageTokens(cleaned).length === 0 ? '' : cleaned;
};

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
      .replace(/^(?:(?:直接|去)\s+|(?:现在|立即|马上|那就)\s*(?=[\u4e00-\u9fffa-z0-9]{2,}))/i, ' ')
      .replace(/(?:^|\s)[:：]+|[:：]+(?=\s|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } while (value !== prev);
  const withoutParticle = value.replace(/吧$/, '').trim();
  return stripTemporalDirectiveLead(withoutParticle || value);
}

const stripRevocationBoilerplate = (text) => {
  const cleaned = normalize(stripSeqCitationsForApproval(text))
    .replace(/\*\*|__/g, ' ')
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(REVOCATION_BOILERPLATE_RE, ' ')
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(/(?:^|\s)[:：]+|[:：]+(?=\s|$)/g, ' ')
    .replace(/[。.!！?？;；，,…]+/g, ' ')
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return coverageTokens(cleaned).length === 0 ? '' : cleaned;
};

function normApprovalInflections(text) {
  return normalize(text)
    .replace(/(?:开工|开跑|启动|开始)/g, '开始')
    .replace(/\b([a-z]{3,})\b/g, (w) => {
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
const STAGE_LABEL_ENTITY_RE = /^(?:phase|stage|round|cycle|batch|step|turn|iteration)\d+$/i;

function extraNamedEntitiesMatched(srcText, claimText) {
  const sNorm = normApprovalInflections(srcText);
  const cNorm = normApprovalInflections(claimText);
  for (const m of cNorm.matchAll(/[a-z0-9][a-z0-9_.-]{2,}/g)) {
    const tok = m[0];
    if (GENERIC_REPO_WORDS.has(tok) || STAGE_LABEL_ENTITY_RE.test(tok)) continue;
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

const QUANTITY_WITH_UNIT_TOKEN_RE =
  /(?<![a-z0-9_-])-?\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds?|months?|m|min|minutes?|h|hours?|d|days?|weeks?|years?|yrs?|gb|gib|mb|mib|kb|kib|tb|tib|bytes?|b|g|%|毫秒|秒|分钟?|小时|天|个月|周|星期|年|字节)(?![a-z0-9_-])/gi;

function stripQuantityTokens(text) {
  return normalize(String(text ?? '').replace(QUANTITY_WITH_UNIT_TOKEN_RE, ' '));
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
  const numsMatch = sNums.length === cNums.length && numericFactsEquivalent(sCore, cCore, sNums, cNums);
  if (isRevocation ? cNums.length > 0 && !numsMatch : !numsMatch) {
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
    if (cf.size > 0 && !sharedFamily) return false;
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
  return replaceInlineBackticks(String(text ?? ''), (part) => {
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
    const inner = value.slice(openIdx + 1, closeIdx).trim();
    if (!inner) return null;
    if (!trailing || /^[。.!！?？;；…]+$/.test(trailing)) {
      return { outerPrefix, inner, trailingAfterColon: '' };
    }
    const colonMatch = /^(?:\*\*|__)?\s*[:：]\s*(.+)$/.exec(trailing);
    if (colonMatch && colonMatch[1].trim()) {
      return { outerPrefix, inner, trailingAfterColon: colonMatch[1].trim() };
    }
    return null;
  }
  const inner = value.slice(openIdx + 1).trim();
  return inner ? { outerPrefix, inner, trailingAfterColon: '' } : null;
}

function stripOuterAttributionPrefix(text) {
  return String(text ?? '')
    .replace(/\*\*|__/g, ' ')
    .replace(/^\s*(?:[-*•+]|\d+[.)]|[:：)）]+)+\s*/, '')
    .replace(
      /^(?:(?:phase|stage|round|cycle|batch|step|turn|iteration)\s*#?\d+|第\s*\d+\s*(?:轮|阶段|步|批))(?:\s*(?:于|在|at)\s*\d{1,2}:\d{2}(?::\d{2})?)?\s*/i,
      '',
    )
    .replace(/^(?:于|在)\s*\d{1,2}:\d{2}(?::\d{2})?\s*/, '')
    .replace(/[（(]+$/g, '')
    .replace(/[。.!！?？;；…]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
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
  const pushGrant = (clause, core, seq = null) => {
    if (!core) return;
    activeGrants.push({ seq, clause, core });
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
          if (cleanPart) activeGrants.push({ seq, clause, core: cleanPart });
        }
      }
    }
  };

  for (const m of verifiedMessages) {
    const rawText = stripFencedCodeBlocks(instructionText(m));
    const msgEntries = [];
    let messageHasGrant = false;

    for (const sent of sourceEvidenceSentences(rawText)) {
      const cleanSent = stripSeqCitationsForApproval(sent).replace(/\*\*|__/g, '').trim();
      const sentQuestion = isPureQuestion(sent) || /[?？]\s*$/.test(sent.trim());
      const sentHasConditional = PROVENANCE_CONDITIONAL_CUE_RE.test(cleanSent);

      for (const clause of splitProvenanceClauses(sent)) {
        const cleanClause = stripSeqCitationsForApproval(clause).replace(/\*\*|__/g, '').trim();
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
        const isFormalGrant =
          !clauseQuestion &&
          isFormalClaim &&
          !NEGATED_OR_PENDING_APPROVAL_RE.test(cleanClause);
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
          pushGrant(cleanClause, core, m.seq);
          msgEntries.push({ clause, cleanClause, kind: 'grant' });
          continue;
        }
        if (!clauseQuestion && !sentHasConditional && STANDALONE_AFFIRMATION_RE.test(cleanClause)) {
          messageHasGrant = true;
          msgEntries.push({ clause, cleanClause, kind: 'affirmation' });
          continue;
        }
        const isDirectImperativeGrant =
          !clauseQuestion &&
          !sentHasConditional &&
          !NEGATED_OR_PENDING_APPROVAL_RE.test(cleanClause) &&
          !ruleNegative(clauseNegView) &&
          !COLLOQUIAL_NON_GRANT_RE.test(cleanClause) &&
          !conditionParts(cleanClause) &&
          !ADVISORY_OR_OBSERVATION_PREFIX_RE.test(cleanClause) &&
          !RETROSPECTIVE_GRANT_PREFIX_RE.test(cleanClause) &&
          DIRECT_IMPERATIVE_GRANT_RE.test(cleanClause) &&
          ACTION_DIRECTIVE_RE.test(cleanClause);
        if (isDirectImperativeGrant) {
          messageHasGrant = true;
          const core = stripGrantBoilerplate(cleanClause);
          if (core) pushGrant(cleanClause, core, m.seq);
          msgEntries.push({ clause, cleanClause, kind: 'grant' });
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
        if (ADVISORY_OR_OBSERVATION_PREFIX_RE.test(cleanClause) || RETROSPECTIVE_GRANT_PREFIX_RE.test(cleanClause)) continue;
        if (!ACTION_DIRECTIVE_RE.test(cleanClause)) continue;
        const core = stripGrantBoilerplate(cleanClause);
        if (core) pushGrant(cleanClause, core, m.seq);
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
        const of = verbFamiliesOf(outerPrefix);
        const sf = verbFamiliesOf(g.core);
        if (
          ruleNegative(outerPrefix) ||
          hasIncompatibleVerbFamily(g.core, outerPrefix) ||
          (of.has('delete') && !sf.has('delete')) ||
          (sf.size === 0 && (of.has('delete') || of.has('publish') || of.has('write'))) ||
          !extraNamedEntitiesMatched(g.clause, outerPrefix)
        ) {
          return false;
        }
      }
      if (!claimCore) return true;
      return approvalTargetsMatch(g.core, g.clause, claimCore, claimSentence);
    });

  const lost = [];
  const summarySentences = sourceEvidenceSentences(stripFencedCodeBlocks(summaryText ? summaryProse(summaryText) : ''));
  for (const rawSent of summarySentences) {
    for (const sentence of splitProvenanceClauses(rawSent)) {
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
    } else if (parenWrapped) {
      const outerPart = stripOuterAttributionPrefix(parenWrapped.outerPrefix);
      const colonPart = parenWrapped.trailingAfterColon ? stripOuterAttributionPrefix(parenWrapped.trailingAfterColon) : '';
      const attrTarget = colonPart || outerPart;
      if (attrTarget && grantMatchesClaim(attrTarget, cleanSentence, parenWrapped.outerPrefix)) continue;
    }

    const citedSeqs = candidateSeqCitations(sentence);
    if (citedSeqs.size > 0) {
      const citedTarget = parenWrapped?.trailingAfterColon
        ? stripOuterAttributionPrefix(parenWrapped.trailingAfterColon)
        : stripOuterAttributionPrefix(claimCore);
      if (
        citedTarget &&
        activeGrants.some((g) => {
          if (!Number.isSafeInteger(g.seq) || !citedSeqs.has(g.seq)) return false;
          if (!scopesCompatible(g.clause, cleanSentence)) return false;
          const srcNonParenScope = nonParenScopeKeysOf(g.clause);
          const claimAllScope = scopeKeysOf(cleanSentence);
          for (const k of srcNonParenScope) {
            if (!claimAllScope.has(k)) return false;
          }
          for (const k of claimAllScope) {
            if (/^(?:prod|staging)$/.test(k) && !scopeKeysOf(g.clause).has(k)) return false;
          }
          if (ruleNegative(citedTarget)) return false;
          if (hasVisibilityConflict(g.clause, cleanSentence)) return false;
          if (hasIncompatibleVerbFamily(g.core, citedTarget)) return false;
          const sf = verbFamiliesOf(g.core);
          const cf = verbFamiliesOf(citedTarget);
          if (cf.has('delete') && !sf.has('delete')) return false;
          if (sf.size === 0 || ![...sf].some((f) => cf.has(f))) return false;
          const srcPairs = allTransferPairs(g.core);
          const srcAllPairs = srcPairs.length ? srcPairs : allTransferPairs(g.clause);
          const claimPairs = allTransferPairs(citedTarget);
          const claimAllPairs = claimPairs.length ? claimPairs : allTransferPairs(cleanSentence);
          if ((srcAllPairs.length > 0 || claimAllPairs.length > 0) && JSON.stringify(srcAllPairs) !== JSON.stringify(claimAllPairs)) {
            return false;
          }
          const sEx = exceptionTarget(g.core) ?? exceptionTarget(g.clause);
          const cEx = exceptionTarget(citedTarget) ?? exceptionTarget(cleanSentence);
          if ((sEx || cEx) && sEx !== cEx) return false;
          if (PROVENANCE_CONDITIONAL_CUE_RE.test(g.clause) && !PROVENANCE_CONDITIONAL_CUE_RE.test(cleanSentence)) {
            return false;
          }
          const punctNormSrcClause = normalize(stripSeqCitationsForApproval(g.clause)).replace(/[、，,]+/g, ' ').replace(/\s+/g, ' ').trim();
          const strippedSCore = stripNonQualifyingParens(normalize(g.core).replace(/[、，,]+/g, ' ').replace(/\s+/g, ' ').trim());
          const claimNorm = normalize(cleanSentence);
          for (const span of extractClosedParens(strippedSCore)) {
            const inner = span.inner.trim();
            if (!inner) continue;
            for (const k of scopeKeysOf(inner)) {
              if (!claimAllScope.has(k)) return false;
            }
            if (QUALIFYING_CONDITIONAL_RE.test(inner) && (!QUALIFYING_CONDITIONAL_RE.test(cleanSentence) || coverageOf(inner, claimNorm) < 0.7)) {
              return false;
            }
            const innerNegView = inner.replace(/(?:不公开|非公开)/g, ' ');
            if (negationsOf(innerNegView).length > 0 && (negationsOf(cleanSentence).length === 0 || coverageOf(inner, claimNorm) < 0.7)) {
              return false;
            }
            if (PRIVATE_VISIBILITY_RE.test(inner) && !PRIVATE_VISIBILITY_RE.test(cleanSentence)) return false;
            if (PUBLIC_VISIBILITY_RE.test(inner) && !PUBLIC_VISIBILITY_RE.test(cleanSentence)) return false;
          }
          for (const span of extractClosedParens(citedTarget)) {
            const inner = span.inner.trim();
            if (!inner) continue;
            const innerNorm = inner.replace(/[、，,]+/g, ' ').replace(/\s+/g, ' ').trim();
            const cov = Math.max(
              coverageOf(innerNorm, punctNormSrcClause),
              coverageOf(normApprovalInflections(innerNorm), normApprovalInflections(punctNormSrcClause)),
            );
            if (cov < 0.75) return false;
          }
          const grantAction = (actionState(g.core)?.verb || g.core).trim();
          if (grantAction.length < 2) return false;
          return coverageOf(normApprovalInflections(grantAction), normApprovalInflections(citedTarget)) >= 0.85;
        })
      ) {
        continue;
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
    const claimCoreTokens = claimCore ? coverageTokens(claimCore) : [];
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
          if (!claimCore) {
            if (!rcCore || APPROVAL_CLAIM_RE.test(cleanRc) || DIRECT_USER_APPROVAL_RE.test(cleanRc)) {
              matchedUntrustedSeq = ref.seq;
              return true;
            }
            continue;
          }
          if (!rcCore) continue;
          const targetHit =
            approvalTargetsMatch(rcCore, cleanRc, claimCore, cleanSentence) ||
            unbackedParts.some((part) => approvalTargetsMatch(rcCore, cleanRc, part, cleanSentence)) ||
            (claimCoreTokens.length > 0 && coverageOf(claimCore, normalize(cleanRc)) >= 0.5) ||
            unbackedParts.some((part) => coverageTokens(part).length > 0 && coverageOf(part, normalize(cleanRc)) >= 0.5);
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
