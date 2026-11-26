// Layer 0: pure lexical normalization, masking, negation, and token coverage helpers.
// Zero internal imports (strict DAG root).

export const NON_NEGATIVE_AVOID_RE =
  /(?:(?:不可|不能|难以|难于|无法|无从|并非|不是|不必|不用|无需|不要|不得|别)避免|避免(?:不了|不得|不掉)|(?:为(?:了)?|以)(?:避免|杜绝))/g;
export const INEVITABILITY_MODAL_RE =
  /(?:(?:不可|不能|难以|难于|无法|无从)避免(?:地|的)?|避免(?:不了|不得|不掉)(?:的)?|不得不)/g;

export const CN_MODAL =
  /不允许|不应(?:当|该)?|不(?=修改|删除|运行|调用|安装|部署|上传|下载|发送|联网|覆盖|发布|写入|写库|重启|终止|降低|改)|必须|不要(?!求)|不能|不得|禁止|记得|务必|只能|一定要|(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人)|需要|请|注意|不可(?!逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越)|无需|不准|不许|严禁|勿|(?<!为了?|以)杜绝|免于|(?<!不可|不能|难以|难于|无法|无从|并非|不是|不必|不用|无需|不要|不得|别|为了?|以)避免(?!不了|不得|不掉)|只有|仅当|如果|除非|每当|一旦/;
export const EN_MODAL =
  /\b(?:must|shall|never|always|only|ensure|remember|required(?:\s+to)?|forbid(?:s|den|ding)?|disallow(?:s|ed|ing)?|ban(?:s|ned|ning)?|prohibit(?:s|ed|ing)?(?:\s+from)?|ought\s+(?:not\s+)?to|avoid|should|shouldn't|mustn't|cannot|can't|won't|wouldn't|please|unless|if|when)\b|\b(?:may\s+not|do\s+not|don't|will\s+not|would\s+not|can\s+not|should\s+not)\b/i;
export const COMMAND =
  /^(?:you\s+)?(?:use|run|keep|retain|preserve|delete|remove|restart|deploy|copy|move|sync|transfer|output|format|enable|disable)\b|^(?:保留|删除|运行|使用|发布|重启|复制|输出|(?:取消|撤销|解除)?(?:禁用|停用|启用)|跑\s)/;
export const LABEL =
  /^(?:output(?:\s+format)?|format|port|timeout|retention|limit|输出格式|输出|端口|超时|保留时间|限制)\s*[:：]/;

export const NEGATION =
  /不允许|不应(?:当|该)?|不要(?!求)|不能|不得|不必|不用|禁止|(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人)|无需|不可(?!逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越)|不准|不许|严禁|勿|(?<!为了?|以)杜绝|免于|(?:取消|撤销|解除)(?=(?:禁用|停用|关闭|阻断))|(?<!不可|不能|难以|难于|无法|无从|并非|不是|不必|不用|无需|不要|不得|别|为了?|以)避免(?!不了|不得|不掉)|没有|尚未|并未|未曾|不(?:实际|直接|擅自)|不(?![同仅但过论管断少足安便光止久妨料然如至]|得不|可(?:逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越))(?=[\u4e00-\u9fff])|未(?=执行|运行|调用|修改|删除|写入|安装|重启|强停|改|降|提|kill|restart|append)|\b(?:must\s+not|mustn't|shall\s+not|may\s+not|ought\s+not\s+to|prohibited\s+from|do\s+not|don't|cannot|can't|can\s+not|should\s+not|shouldn't|won't|will\s+not|wouldn't|would\s+not|never|forbid(?:s|den|ding)?|disallow(?:s|ed|ing)?|ban(?:s|ned|ning)?|prohibit(?:s|ed|ing)?|avoid|no(?!-op\b|-ops\b)|not)\b/g;

export const CJK_RUN = /[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g;
export const CONDITIONAL_PREFIX_RE =
  /^(?:(?:说明|注意|另外|后续|以后|其实|因此|当前)[^,，。；;\n]{0,12}?)?(?:(only\s+)?(if|when|unless)\s+(.+?)|(只有当|只有|只要|仅当|如果|倘若|假如|除非|若|每当|一旦|当)(.+?))[,，]\s*(.+)$/i;
export const TEMPORAL_CONDITIONAL_PREFIX_RE =
  /^(?:(?:说明|注意|另外|后续|以后|其实|因此|当前)[^,，。；;\n]{0,12}?)?(?:(在)([^,，。；;\n]{2,80}?(?:完毕(?:之|以)?后|完成(?:之|以)?后|结束(?:之|以)?后|之后|以后|之前|以前|的时候|(?<![超实及暂随同定临长短])时))|(等到?)([^,，。；;\n]{2,80}?(?:完毕(?:之|以)?后|完成(?:之|以)?后|结束(?:之|以)?后|之后|以后|的时候|(?<![超实及暂随同定临长短])时|后)))[,，]\s*(.+)$/;
export const PAST_NARRATIVE_TIME_RE =
  /(?:昨天|前天|昨晚|刚才|刚刚|上次|上回|上周|上个月|去年|那天|那时|当时|此前|先前|曾经|当初|今天(?:早上|上午|中午|下午|晚上)|\d{4}\s*[-/年]\s*\d{1,2}(?:\s*[-/月]\s*\d{1,2})?)/;
export const CONDITIONAL_SUFFIX_RE =
  /^(?:>\s*)*(?:only\s+)?(.+?)\s+(?:only\s+)?(if|when|unless)\s+([^.,;!?\n]+)[.!?;]*$/i;

/**
 * Linear-time O(n) inline backtick span replacement (never spans newlines and
 * never backtracks catastrophically on long unclosed backtick runs).
 */
export function replaceInlineBackticks(text, replacer, { exactTickCount = false, maxInnerChars = Infinity } = {}) {
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

export const CODE_SPLIT_MASK = (text, literals) => {
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

export function unmask(text, literals) {
  return text.replace(/\uE000(\d+)\uE001/g, (_, idx) => literals[Number(idx)] ?? '');
}

export function proseOnly(text) {
  const unticked = replaceInlineBackticks(String(text ?? ''), (_value, inner) =>
    /^(?:do\s+not\s+|must\s+|shall\s+|may\s+not\s+|ought\s+|never\s+|always\s+|不要(?!求)|必须|不能)/i.test(inner)
      ? inner
      : ' ',
  );
  return unticked.replace(/--[a-z][\w-]*|\bnot\s+null\b/gi, ' ');
}

const normalizeCache = new Map();

export function normalize(text) {
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

export const DOUBLE_NEGATION_RE =
  /(?:不要|不能|不得|不可(?!逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越)|切勿|严禁|(?<![分区识个特级差类性鉴告离甄辨判派])别)\s*(?:不(?![同仅但过论管断少足安便光止久妨料然如至])|没(?:有)?|未)|不得不|\b(?:do\s+not|don't|must\s+not|shall\s+not|may\s+not|ought\s+not\s+to|never|cannot|can't)\s+(?:avoid\s+\w+ing\b|not\b|fail\s+to\b)/i;

const DOUBLE_NEGATION_GLOBAL_RE = new RegExp(DOUBLE_NEGATION_RE.source, 'gi');

export const UNIT_SUFFIX_OPT_RE =
  '(?:\\s*(?:ms|s|sec|seconds?|months?|m|min|minutes?|h|hours?|d|days?|weeks?|years?|yrs?|gb|gib|mb|mib|kb|kib|tb|tib|bytes?|b|g|%|毫秒|秒|分钟?|小时|天|个月|周|星期|年|字节|个|次|条))?';
export const EXPLICIT_PAREN_DISAVOWAL_RE = new RegExp(
  `[（(]\\s*(?:(?:不是|并非|而非|而不是|非|不再用|不是之前的|不是原先的|不是旧的|\\b(?:not|instead\\s+of|rather\\s+than)\\b)\\s*-?\\d+(?:\\.\\d+)?${UNIT_SUFFIX_OPT_RE}|(?:was|previously|formerly|originally|原(?:为|是)?|旧(?:值)?(?:为)?)\\s*-?\\d+(?:\\.\\d+)?${UNIT_SUFFIX_OPT_RE}\\s*[,，;]\\s*(?:replaced\\s+by|updated\\s+to|changed\\s+to|superseded\\s+by|now|(?:已|现)?(?:改为|改成|替换为|替代为))\\s*-?\\d+(?:\\.\\d+)?${UNIT_SUFFIX_OPT_RE})\\s*[)）]`,
  'gi',
);
export const EXPLICIT_INLINE_DISAVOWAL_RE = new RegExp(
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

export const QUOTE_REVOCATION_PREFIX_RE =
  /(?:取消|撤销|废除|解除|终止|停止|放弃|免除|放开|松绑|打破|突破|不再|不(?:需要|必|用)?再|别再|不要再|不能再|不得再|禁止再|无需再)[^。！？;；\n「『]{0,12}$/i;
export const OUTER_PROHIBIT_BEFORE_REVOCATION_RE =
  /(?:不允许|不应(?:当|该)?|不要(?!求)|不能|不得|不可(?!逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越)|禁止|严禁|切勿|勿|(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人))\s*(?:取消|撤销|废除|解除|终止|停止|放弃|免除|放开|松绑)/;
export const QUOTE_RESTRICTION_HEAD_RE = /^(?:的)?(?:限制|约束|禁令|门禁|封锁)/;

export function ruleNegative(line) {
  const text = proseOnly(stripExplicitValueCorrection(line)).toLowerCase();
  const scrubbed = text
    .replace(DOUBLE_NEGATION_GLOBAL_RE, ' ')
    .replace(/(?:取消|撤销|解除)(?:禁止|严禁|不许|不得)/g, ' ');
  if (/[「『][^」』]{1,80}[」』]/.test(scrubbed) && !OUTER_PROHIBIT_BEFORE_REVOCATION_RE.test(scrubbed)) {
    const quoteMatch = /[「『]([^」』]{1,80})[」』]/.exec(scrubbed);
    if (quoteMatch) {
      const beforeQuote = scrubbed.slice(0, quoteMatch.index).trimEnd();
      const afterQuote = scrubbed.slice(quoteMatch.index + quoteMatch[0].length);
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
  return negationsOf(scrubbed).length > 0;
}

export function tokens(text) {
  return normalize(text)
    .split(/[\s,.;:!?()[\]{}"'`/\\|<>+=*&^%$#@~…，。、；：！？（）【】《》「」『』“”]+/)
    .filter((token) => token.length > 0);
}

const coverageTokenCache = new Map();
export const ASCII_TOKEN_RE = /^[a-zA-Z0-9_]+$/;
export const ASCII_WORD_RUN_RE = /[a-zA-Z0-9_]+/g;
export const asciiWordCache = new Map();

/**
 * Tokenize for constraint coverage checks: keep `tokens()` intact for
 * descriptor matching while splitting unpunctuated CJK runs (>= 3 chars)
 * into overlapping 2-char bigrams.
 */
export function coverageTokens(text) {
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

export const CJK_BIGRAM_RE = /^[\u4e00-\u9fff\u3400-\u4dbf]{2}$/;
const cjkBigramCache = new Map();
const coverageMemo = new Map();
const MAX_COVERAGE_CACHE_CHARS = 65536;

export function asciiWordsOf(text) {
  const cacheable = text.length <= MAX_COVERAGE_CACHE_CHARS;
  let words = cacheable ? asciiWordCache.get(text) : null;
  if (!words) {
    const matches = text.match(ASCII_WORD_RUN_RE);
    words = matches ? new Set(matches.map((w) => w.toLowerCase())) : new Set();
    if (cacheable) {
      if (asciiWordCache.size >= 2048) asciiWordCache.delete(asciiWordCache.keys().next().value);
      asciiWordCache.set(text, words);
    }
  }
  return words;
}

export function cjkBigramsOf(text) {
  const cacheable = text.length <= MAX_COVERAGE_CACHE_CHARS;
  let bigrams = cacheable ? cjkBigramCache.get(text) : null;
  if (!bigrams) {
    bigrams = new Set();
    for (const m of text.matchAll(CJK_RUN)) {
      const run = m[0];
      for (let i = 0; i < run.length - 1; i += 1) {
        bigrams.add(run.slice(i, i + 2));
      }
    }
    if (cacheable) {
      if (cjkBigramCache.size >= 2048) cjkBigramCache.delete(cjkBigramCache.keys().next().value);
      cjkBigramCache.set(text, bigrams);
    }
  }
  return bigrams;
}

export function coverageOf(line, summaryNormalized) {
  const lineKey = String(line ?? '');
  const haystack = String(summaryNormalized ?? '');
  const memoizable = lineKey.length <= 2048 && haystack.length <= MAX_COVERAGE_CACHE_CHARS;
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
      } else if (CJK_BIGRAM_RE.test(token) && haystack.length <= MAX_COVERAGE_CACHE_CHARS) {
        cjkBigrams ??= cjkBigramsOf(haystack);
        matched = cjkBigrams.has(token);
      } else {
        const startDigit = token.charCodeAt(0) >= 48 && token.charCodeAt(0) <= 57;
        const endDigit = token.charCodeAt(token.length - 1) >= 48 && token.charCodeAt(token.length - 1) <= 57;
        if (!startDigit && !endDigit) {
          matched = haystack.includes(token);
        } else {
          matched = false;
          let pos = haystack.indexOf(token);
          while (pos !== -1) {
            const prev = pos > 0 ? haystack.charCodeAt(pos - 1) : 0;
            const next = pos + token.length < haystack.length ? haystack.charCodeAt(pos + token.length) : 0;
            if ((!startDigit || prev < 48 || prev > 57) && (!endDigit || next < 48 || next > 57)) {
              matched = true;
              break;
            }
            pos = haystack.indexOf(token, pos + 1);
          }
        }
      }
      seen.set(token, matched);
    }
    if (matched) hit += 1;
  }
  const score = hit / parts.length;
  if (memoizable) {
    if (!innerMemo) {
      if (coverageMemo.size >= 512) coverageMemo.delete(coverageMemo.keys().next().value);
      innerMemo = new Map();
      coverageMemo.set(haystack, innerMemo);
    }
    if (innerMemo.size >= 2048) innerMemo.delete(innerMemo.keys().next().value);
    innerMemo.set(lineKey, score);
  }
  return score;
}

export const SEQ_CITATION_RE =
  /(?:\[\s*seqs?\s+\d+(?:\s*[-–,]\s*\d+)*\s*\]|[（(]\s*seqs?\s+\d+(?:\s*[-–,]\s*\d+)*\s*[)）]|\bseqs?\s*#?\s*\d+(?:\s*[-–,]\s*\d+)*\b|\bseqs?\s*[=:]\s*\d+\b|\bphase\s*#?\d+\b|>\s*user source\s*\(seq\s+\d+\),\s*verbatim:)/gi;

export const stripSeqCitations = (text) => String(text ?? '').replace(SEQ_CITATION_RE, ' ');

export function stripListPrefix(text) {
  return String(text ?? '').replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim();
}

export function stripMarkdownEmphasis(text, replacement = '') {
  return String(text ?? '').replace(/\*\*|__/g, replacement);
}

export const OUTER_QUOTE_PAIRS = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['"', '"'],
  ["'", "'"],
];

export function stripOuterQuotes(text) {
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

export function stripInlineMarkdownFormatting(text) {
  return replaceInlineBackticks(
    String(text ?? ''),
    (_full, inner) => ` ${inner} `,
    { exactTickCount: true, maxInnerChars: 256 },
  ).replace(/(?<![a-z0-9_])(\*\*|__)([^\n]{1,160}?)\1(?![a-z0-9_])/gi, (full, marker, inner) =>
    /^\s|\s$/.test(inner) || inner.includes(marker) ? full : ` ${inner} `,
  );
}

export function stripFencedCodeBlocks(text) {
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

export const QUANTITY_WITH_UNIT_TOKEN_RE =
  /(?<![a-z0-9_-])-?\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds?|months?|m|min|minutes?|h|hours?|d|days?|weeks?|years?|yrs?|gb|gib|mb|mib|kb|kib|tb|tib|bytes?|b|g|%|毫秒|秒|分钟?|小时|天|个月|周|星期|年|字节)(?![a-z0-9_-])/gi;

export function stripQuantityTokens(text) {
  return normalize(String(text ?? '').replace(QUANTITY_WITH_UNIT_TOKEN_RE, ' '));
}

export const CANDIDATE_SEQ_CITE_RE =
  /(?:\[\s*seqs?\s+([\d\s,–-]+)\s*\]|[（(]\s*seqs?\s+([\d\s,–-]+)\s*[)）]|\bseqs?\s*[:#=]?\s*(\d+)\b)/gi;

export function candidateSeqCitations(text) {
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

export const MODAL_STRIP =
  /(?:必须|务必|应当|应该|需要|可以|允许|请|先|\bmust\b|\bshall\b|\bought\s+to\b|\brequired\s+to\b|\bshould\b|\bcan\b|\bmay\b|\bplease\b)/gi;

export const stripNegAndModal = (t) =>
  proseOnly(normalize(t))
    .replace(INEVITABILITY_MODAL_RE, ' ')
    .replace(NEGATION, ' ')
    .replace(MODAL_STRIP, ' ')
    .replace(/[「」『』。.!！?？;；，,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function stripNumbersForTopic(text) {
  return String(text ?? '')
    .replace(/(?<![a-z0-9_])-?\d+(?:\.\d+)?(?![a-z0-9_])/gi, ' ')
    .replace(/\*\*|__/g, ' ')
    .replace(/[「」『』。.!！?？;；，,:=×+\-*/()（）[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
