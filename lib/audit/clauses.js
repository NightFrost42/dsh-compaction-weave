// Layer 2: sentence/clause splitting, condition/scope/exception/transfer extraction,
// and local polarity segmentation. Imports ONLY from Layers 0–1 and leaf action-state.

import { actionState } from '../action-state.js';
import {
  CN_MODAL,
  CODE_SPLIT_MASK,
  COMMAND,
  CONDITIONAL_PREFIX_RE,
  CONDITIONAL_SUFFIX_RE,
  EN_MODAL,
  EXPLICIT_PAREN_DISAVOWAL_RE,
  LABEL,
  PAST_NARRATIVE_TIME_RE,
  TEMPORAL_CONDITIONAL_PREFIX_RE,
  coverageOf,
  coverageTokens,
  normalize,
  ruleNegative,
  stripExplicitValueCorrection,
  stripFencedCodeBlocks,
  stripListPrefix,
  stripMarkdownEmphasis,
  stripNegAndModal,
  stripOuterQuotes,
  stripSeqCitations,
  unmask,
} from './normalize.js';
import { numericFacts, numericFactsEquivalent, scalarRequirement } from './numeric.js';

const SOURCE_EVIDENCE_PART_RE =
  /[^.!?。！？；;]+[.!?。！？；;]*[」』”’"']*|[」』”’"']*[^.!?。！？；;]+$/g;
const LEGACY_SOURCE_EVIDENCE_PART_RE =
  /[^.!?。！？；;]+[.!?。！？；;]*|[^.!?。！？；;]+$/g;

const INLINE_PARAM_LABEL_RE =
  /(?:port|timeout|retries|limit|max|min|count|size|ratio|level|version|端口|超时|重试|上限|下限|数量|版本)\s*$/i;
const INLINE_ORDINAL_MASK_RE = /(^|[:：;；,，、(（]\s*)(\d{1,2}\.)(?=\s+\S)/g;

export function splitSourceEvidenceSentences(text, partRe = SOURCE_EVIDENCE_PART_RE) {
  const literals = [];
  const masked = CODE_SPLIT_MASK(text, literals);
  const out = [];
  for (const line of masked.split(/\r?\n/)) {
    const strippedLine = line.replace(/^\s*(?:\d+[.)](?=\s)|\(\d+\)\s+|[-*•+]\s+)/, '');
    if (!strippedLine.trim()) continue;
    const ordinalMasked = strippedLine.replace(INLINE_ORDINAL_MASK_RE, (full, prefix, ord, offset) => {
      if (!prefix) return full;
      const beforePrefix = strippedLine.slice(0, offset);
      if (/[:：]/.test(prefix)) {
        if (INLINE_PARAM_LABEL_RE.test(beforePrefix)) return full;
        const tail = strippedLine.slice(offset + full.length);
        const ordNum = Number.parseInt(ord, 10);
        if (ordNum !== 1 && !/(?:^|[:：;；,，、\s])\d{1,2}[.)、]\s+\S/.test(tail)) return full;
      }
      literals.push(ord);
      return `${prefix}\uE000${literals.length - 1}\uE001`;
    });
    const parts = ordinalMasked.match(partRe) ?? [ordinalMasked];
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

export const STRONG_DIRECTIVE_RE =
  /必须|务必|一定要|禁止|严禁|不得|不能|不要(?!求)|不允许|不可(?!逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越)|不准|不许|勿|请(?!问)|\b(?:must(?:\s+not)?|mustn't|shall(?:\s+not)?|may\s+not|ought\s+(?:not\s+)?to|required\s+to|prohibited\s+from|never|forbid(?:s|den|ding)?|disallow(?:s|ed|ing)?|ban(?:s|ned|ning)?|prohibit(?:s|ed|ing)?|cannot|can't|can\s+not|should\s+not|shouldn't|won't|will\s+not|wouldn't|would\s+not|do\s+not|don't|please)\b/i;
export const QUESTION_STARTER_RE =
  /^(?:为什么|为何|怎么|怎样|如何|请问|是否|是不是|能否|可否|能不能|可不可以|要不要|需不需要|有没有|会不会|建议|\b(?:why|what|how|when|where|who|whom|whose|which|should|would|could|can|may|might|must|do|does|did|is|are|was|were|have|has|had|will|shall|ought)\b)/i;
export const POLITE_IMPERATIVE_Q_RE =
  /^(?:(?:can|could|would|will)\s+you\s+please\b|please\b|请(?!问)|麻烦你?帮?我?|帮我)/i;
export const CN_QUESTION_CUE_RE =
  /(?:[吗呢么]\s*[?？]\s*$|为什么|为何|怎么|怎样|如何|是否|是不是|能否|可否|能不能|可不可以|要不要|需不需要|有没有|会不会|行不行|好不好|对不对|什么|哪(?:个|些|里|儿|种)|多少)/;

export function hasPreClauseDirective(pre) {
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

export function isPureQuestion(raw) {
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

export function isInstructionLine(line) {
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

export const LOWER_BOUND_RE = /\b(?:at\s+least|minimum|no\s+fewer\s+than|no\s+less\s+than)\b|>=|≥|至少|最少|不少于|不低于|不小于|大于等于/i;
export const UPPER_BOUND_RE = /\b(?:at\s+most|maximum|(?:no|not)\s+more\s+than|up\s+to|(?:(?:must|shall|should|will|do|does|did|may)\s+not|cannot|can't|mustn't|shouldn't|shan't|won't|don't|doesn't|didn't|never|not)\s+exceed)\b|<=|≤|最多|至多|不超过|不高于|不大于|小于等于|不得超过|不能超过/i;
export const STRICT_LOWER_BOUND_RE =
  /(?<!\bno\s+)(?<!\bnot\s+)(?<!\bcannot\s+)(?<!\bcan't\s+)(?<!\bnever\s+)(?<!\bmustn't\s+)(?<!\bshouldn't\s+)(?<!\bdon't\s+)(?<!\bdoesn't\s+)(?<!\bshan't\s+)(?<!\bwon't\s+)\b(?:more\s+than|greater\s+than|over|above|exceed(?:s|ing)?)\b(?=\s*-?\d)|(?<![-=<>!])>(?!=)(?=\s*-?\d)|(?<!不|不得|不能|不要|不可|禁止|切勿|严禁)(?:大于(?!等于)|超过|高于)/i;
export const STRICT_UPPER_BOUND_RE =
  /(?<!\bno\s+)(?<!\bnot\s+)\b(?:less\s+than|fewer\s+than|under|below)\b(?=\s*-?\d)|(?<![-=<>!])<(?!=)(?=\s*-?\d)|(?<!不)(?:小于(?!等于)|低于)/i;

export const NUMERIC_ASSIGNMENT_CUE_RE =
  /(?:[:=：]\s*-?\d|设为|设置为|改为|改成|调为|调成|定为|保持(?:为)?|限制(?:为|在)?|控制在|上限|下限|配额|限额|阈值|预算|\b(?:set\s+\S+\s+to|limit(?:ed)?\s+to|cap(?:ped)?\s+at|max(?:imum)?|min(?:imum)?|threshold|quota|budget|timeout|port|retries|retention)\b)/i;
export const ANECDOTAL_OBSERVATION_RE =
  /(?:跑了|试了|等了|花了|卡了|停了|拖了|聊了|写了|改了|看了|过了|大概|差不多|好像|似乎|疑似|已经|刚才|刚刚|之前|以前|先前|昨天|今天|上午|下午|晚上|我有|我们有|一共|总共|结果|卡住|报错|崩溃|失败了|\b(?:took|spent|waited|tried|ran\s+for|already|yesterday|today|about|around|seems?|looks?\s+like|stuck|failed|crashed|i\s+have|we\s+have)\b)/i;

export function hasRequirementNumericCue(line) {
  const raw = String(line ?? '').trim();
  if (!raw || /^\s*#{1,6}\s/.test(raw)) return false;
  if (isPureQuestion(raw)) return false;
  const facts = numericFacts(raw);
  if (facts.length === 0) return false;
  const stripped = stripListPrefix(stripSeqCitations(raw));
  if (stripExplicitValueCorrection(stripped) !== stripped) return true;
  if (scalarRequirement(stripped) !== null) return true;
  if (
    LOWER_BOUND_RE.test(raw) ||
    UPPER_BOUND_RE.test(raw) ||
    STRICT_LOWER_BOUND_RE.test(raw) ||
    STRICT_UPPER_BOUND_RE.test(raw)
  ) {
    return true;
  }
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

export const CN_AFFIRMATIVE_MODAL_OVERRIDE_RE =
  /^(?:(?:仍(?:然|旧)?|依旧|依然|照常|照旧|转而|改为|改而)\s*(?:需要|需|须|必须|务必|允许|可以|准许|放行|批准|授权|同意|应当|应该|将会|会|要)?|(?:现(?:在|已)?|已(?:经)?|还是)\s*(?:需要|需|须|必须|务必|允许|可以|准许|放行|批准|授权|同意|应当|应该|将会|会|要)|(?:允许|可以|准许|放行|批准|授权|同意|必须|务必|需要|应当|应该|一定要|将会|仍需|仍要|仍会|仍可|仍应|仍须|仍将|还要))/;
export const CN_COORD_OVERRIDE_SPLIT_RE =
  /(?:或者?|以及|及|与|和|并)\s*(?=(?:(?:仍(?:然|旧)?|依旧|依然|照常|照旧|转而|改为|改而)\s*(?:需要|需|须|必须|务必|允许|可以|准许|放行|批准|授权|同意|应当|应该|将会|会|要)?|(?:现(?:在|已)?|已(?:经)?|还是)\s*(?:需要|需|须|必须|务必|允许|可以|准许|放行|批准|授权|同意|应当|应该|将会|会|要)|(?:允许|可以|准许|放行|批准|授权|同意|必须|务必|需要|应当|应该|一定要|将会|仍需|仍要|仍会|仍可|仍应|仍须|仍将|还要)))/g;
const CN_COMMA_NEG_COORD_HEAD_RE = /^(?:或者?|以及|及)(?=[\u4e00-\u9fffa-z0-9`])/;
const CN_COMMA_CLAUSE_BREAK_HEAD_RE =
  /^(?:如果|倘若|假如|除非|只有|仅当|一旦|每当|若|当|随后|然后|接着|继而|并且|而且|但是?|不过|然而|反而)/;
const BARE_SCOPE_PREFIX_RE =
  /^(?:(?:(?:in|on|for|under|within|during|across|at)\s+)?(?:the\s+)?(?:production|staging|development|test)(?:\s+(?:env|environment|mode|cluster|deployments?|servers?|builds?|runs?))?|(?:(?:in|on|for|during|at)\s+)?(?:the\s+)?(?:phase|stage|round|cycle|batch|step|turn|iteration)\s*#?\d+|(?:在|对于?|针对|进入)?(?:生产|测试|预发布)(?:环境|集群|模式|服)?(?:中|里|下|内|时)?|(?:在|对于?|针对|进入)?(?:服务器|批次?|第|阶段|轮|组|步)\s*\d+(?:阶段|轮|批|组|步)?(?:中|里|下|内|时)?)$/i;
const NON_SCOPE_PREP_PHRASE_RE =
  /^(?:example|instance|reference|clarity|now|today|brief|short|summary|general|particular|addition|contrast|fact|practice|theory|reality|turn|safety|performance|compatibility|simplicity|consistency|brevity|detail|details|total|average|minimum|maximum|default|most|all|none|both|each|every|more|less|sure|good|better|best|first|second|third|last|next|final|end|start|beginning|nowadays|future|past|present|case|cases|reasons?|purposes?|context|note|records?|info|information|testing|review|audit|例如|比如|举例|此外|另外|因此|所以|然而|不过|但是?|其实|实际上|事实上|通常|一般|总体|整体|原则|当前|目前|现在|今后|以后|后续|未来|过去|此前|之前|之后|默认|默认情况|安全|性能|兼容性?|一致性|简洁|清晰|参考|对比|总结|总之|换言之|换句话说|也就是说|顺便|注意|说明|详情|细节|原因|目的|背景|现状|需求|所有|全部|其他|其余|双方|各方|任何|每次|每当|此时|此刻|这时|这里|那里|其中|包括|除外)$/i;
const EN_TARGET_SCOPE_PREFIX_RE =
  /^(?:for|in|on|under|within|across|at|regarding)\s+(?:the\s+)?([a-z0-9][a-z0-9_./-]{0,39})$/i;
const CN_TARGET_SCOPE_PREFIX_RE =
  /^(?:(?:对于?|针对|关于)\s*([a-z0-9][a-z0-9_./-]{0,39}|[\u4e00-\u9fff]{1,6}(?:服务|模块|节点|库|表|端|层|组件|环境|集群|数据库|缓存)?)(?:\s*(?:而言|来说|来讲))?|在\s*([a-z0-9][a-z0-9_./-]{0,39}|[\u4e00-\u9fff]{1,6}(?:服务|模块|节点|库|表|端|层|组件|环境|集群|数据库|缓存)?)\s*(?:中|里|下|内))$/i;

function extractTargetScopeToken(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const en = EN_TARGET_SCOPE_PREFIX_RE.exec(s);
  if (en) {
    const token = en[1].toLowerCase();
    if (NON_SCOPE_PREP_PHRASE_RE.test(token)) return null;
    if (/^\d+$/.test(token)) return null;
    return token;
  }
  const cn = CN_TARGET_SCOPE_PREFIX_RE.exec(s);
  if (cn) {
    const raw = (cn[1] || cn[2] || '').trim();
    const token = raw.toLowerCase();
    if (!token || NON_SCOPE_PREP_PHRASE_RE.test(token)) return null;
    if (/^\d+$/.test(token)) return null;
    return token;
  }
  return null;
}

function isTargetScopePrefix(text) {
  return extractTargetScopeToken(text) !== null;
}

export function splitCommaClausesPreservingNegCoord(masked, literals) {
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
      if (
        (BARE_SCOPE_PREFIX_RE.test(prevText.trim()) &&
          !BARE_SCOPE_PREFIX_RE.test(nextText.trim()) &&
          !CN_COMMA_CLAUSE_BREAK_HEAD_RE.test(nextText)) ||
        (isTargetScopePrefix(prevText) &&
          !isTargetScopePrefix(nextText) &&
          !CN_COMMA_CLAUSE_BREAK_HEAD_RE.test(nextText))
      ) {
        const sep = /[\u4e00-\u9fff]/.test(prevText) ? '，' : ', ';
        out[out.length - 1] = `${out[out.length - 1]}${sep}${trimmed}`;
        continue;
      }
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

const splitContrastClausesCache = new Map();

export function splitContrastClauses(text) {
  const input = String(text ?? '');
  const cacheable = input.length <= 2048;
  if (cacheable && splitContrastClausesCache.has(input)) {
    return splitContrastClausesCache.get(input);
  }
  const rawSentences = sourceEvidenceSentences(input);
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
  const frozen = Object.freeze(out);
  if (cacheable) {
    if (splitContrastClausesCache.size >= 2048) splitContrastClausesCache.delete(splitContrastClausesCache.keys().next().value);
    splitContrastClausesCache.set(input, frozen);
  }
  return frozen;
}

export const TRANSFER_VERB_RE =
  /\b(?:copy(?:ing)?|sync(?:ing)?|mov(?:e|ing)|migrat(?:e|ing)|transfer(?:ring)?|replicat(?:e|ing))\b/i;

export function allTransferPairs(text) {
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

export const EXCEPTION_RE =
  /\b(?:except(?:\s+for)?|excluding|other\s+than|aside\s+from|but\s+not|not\s+including)\s+([^.,;!?\n]{1,80})|除(?:了)?\s*([^，。；！!？?\s][^，。；！!？?\n]{0,80}?)\s*(?:以外|之外|外)|(?:不含|不包括|不包含)\s*([^，。；！!？?\s][^，。；！!？?\n]{0,80})/i;

export function exceptionTarget(text) {
  const m = EXCEPTION_RE.exec(text);
  return m ? normalize(m[1] ?? m[2] ?? m[3]) : null;
}

export const stripException = (text) => String(text ?? '').replace(EXCEPTION_RE, '').trim() || text;

const scopeSetCache = new Map();

export function scopeSetOf(text) {
  const s = String(text ?? '');
  const cacheable = s.length <= 512;
  if (cacheable && scopeSetCache.has(s)) return scopeSetCache.get(s);
  const targetScopes = [];
  for (const m of s.matchAll(/(?:^|[;；\n]\s*)(?:(?:for|in|on|under|within|across|at|regarding)\s+(?:the\s+)?([a-z0-9][a-z0-9_./-]{0,39})|(?:对于?|针对|关于)\s*([a-z0-9][a-z0-9_./-]{0,39}|[\u4e00-\u9fff]{1,6}(?:服务|模块|节点|库|表|端|层|组件|环境|集群|数据库|缓存)?)(?:\s*(?:而言|来说|来讲))?|在\s*([a-z0-9][a-z0-9_./-]{0,39}|[\u4e00-\u9fff]{1,6}(?:服务|模块|节点|库|表|端|层|组件|环境|集群|数据库|缓存)?)\s*(?:中|里|下|内))\s*[,，:：]/gi)) {
    const tok = (m[1] || m[2] || m[3] || '').trim().toLowerCase();
    if (
      tok &&
      !/^\d+$/.test(tok) &&
      !NON_SCOPE_PREP_PHRASE_RE.test(tok) &&
      !/^(?:production|staging|development|test|生产|测试|预发布)$/i.test(tok)
    ) {
      targetScopes.push(`target:${tok}`);
    }
  }
  const out = new Set([
    ...[...s.matchAll(/\b(?:production|staging|development|test)\b|生产|测试|预发布/gi)].map((m) => m[0].toLowerCase()),
    ...[...s.matchAll(/(?:服务器|批次?|第|阶段|轮|组|步)\s*\d+/g)].map((m) => m[0].replace(/\s+/g, '')),
    ...[...s.matchAll(/\b(?:phase|stage|round|cycle|batch|step|turn|iteration)\s*#?\d+\b/gi)].map((m) =>
      m[0].toLowerCase().replace(/[\s#]+/g, ''),
    ),
    ...targetScopes,
  ]);
  if (cacheable) {
    if (scopeSetCache.size >= 2048) scopeSetCache.clear();
    scopeSetCache.set(s, out);
  }
  return out;
}

export function scopesCompatible(a, b) {
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

export const NEGATED_PRIVATIVE =
  /(?:不要|不能|不得|不可|禁止|切勿|严禁|免于|避免|杜绝|\bdo\s+not\b|\bdon't\b|\bmust\s+not\b|\bshall\s+not\b|\bmay\s+not\b|\bought\s+not\s+to\b|\bprohibited\s+from\b|\bnever\b|\bavoid\b)[^。！？；;\n]{0,80}?(?:漏掉|遗漏|漏记|丢失|丢掉|丢弃|省略|略过|忽略|跳过|忘掉|删掉|删除|\bomit(?:s|ted|ting)?\b|\bdrop(?:s|ped|ping)?\b|\bskip(?:s|ped|ping)?\b|\bmiss(?:es|ed|ing)?\b|\bignor(?:e[ds]?|ing)\b|\bforget(?:s|ting)?\b|\bforgot(?:ten)?\b|\bdelet(?:e[ds]?|ing)\b|\bdiscard(?:s|ed|ing)?\b)/iu;
export const BARE_PRIVATIVE =
  /(?:漏掉|遗漏|漏记|丢失|丢掉|丢弃|省略|略过|跳过|删掉|删除|\bomit(?:s|ted|ting)?\b|\bdrop(?:s|ped|ping)?\b|\bskip(?:s|ped|ping)?\b|\bmiss(?:es|ed|ing)?\b|\bforget(?:s|ting)?\b|\bforgot(?:ten)?\b|\bdelet(?:e[ds]?|ing)\b|\bignor(?:e[ds]?|ing)\b|\bdiscard(?:s|ed|ing)?\b)/iu;
export const AFFIRMATIVE_KEEP =
  /(?:保留|留存|保存|存留|完整记录|包含|涵盖|纳入|覆盖|执行|\bkeep\b|\bretain\b|\bpreserve\b|\binclude\b|\benforce\b)/iu;
export const NEGATED_DEFECT =
  /(?:不得|不能|不要|禁止|避免|杜绝|免于|\bno\b|\bnever\b|\bmust\s+not\b|\bshall\s+not\b|\bmay\s+not\b|\bought\s+not\s+to\b|\bprohibited\s+from\b|\bwithout\b)[^。！？；;\n]{0,80}?(?:报错|错误|异常|漏洞|失败|缺陷|\berrors?|\bfailures?\b|\bbugs?\b|\bdefects?\b|\bexceptions?\b)/iu;
export const DEFECT_FREE =
  /(?:零错误|零报错|零缺陷|无报错|无错误|无异常|zero\s+(?:errors?|defects?|bugs?)|error[-\s]?free|bug[-\s]?free|defect[-\s]?free)/iu;
export const NEGATED_ENABLE =
  /(?:(?:不要|不能|不得|不可|禁止|切勿|严禁|避免|杜绝|\bdo\s+not\b|\bdon't\b|\bmust\s+not\b|\bmustn't\b|\bshall\s+not\b|\bmay\s+not\b|\bought\s+not\s+to\b|\bprohibited\s+from\b|\bcannot\b|\bcan't\b|\bcan\s+not\b|\bshould\s+not\b|\bshouldn't\b|\bwon't\b|\bwill\s+not\b|\bwouldn't\b|\bwould\s+not\b|\bnever\b|\bavoid\b)[^。！？；;\n]{0,80}?(?:启用|开启|打开|(?:允许|放行)(?![^。！？；;\n]{0,24}?(?:禁用|关闭|停用|阻断))|\benabl(?:e|es|ed|ing)\b|\bturn(?:ed|s|ing)?\s+on\b|\b(?:allow(?:ed|s|ing)?|permit(?:ted|s|ting)?)\b(?![^.!?\n]{0,24}?\b(?:disabl(?:e|es|ed|ing)|turn(?:ed|s|ing)?\s+off)\b))|(?:启用|开启|打开|允许|放行|\benabl(?:e|es|ed|ing)\b|\bturn(?:ed|s|ing)?\s+on\b)[^。！？；;\n]{0,80}?(?:\bis\s+(?:forbidden|prohibited|disallowed|banned|not\s+allowed|not\s+permitted)\b|被禁止|被严禁|不允许|被禁用))/iu;
export const NEGATED_DISABLE =
  /(?:(?:不要|不能|不得|不可|禁止|切勿|严禁|避免|杜绝|取消|撤销|解除|\bdo\s+not\b|\bdon't\b|\bmust\s+not\b|\bmustn't\b|\bshall\s+not\b|\bmay\s+not\b|\bought\s+not\s+to\b|\bprohibited\s+from\b|\bcannot\b|\bcan't\b|\bcan\s+not\b|\bshould\s+not\b|\bshouldn't\b|\bwon't\b|\bwill\s+not\b|\bwouldn't\b|\bwould\s+not\b|\bnever\b|\bavoid\b)[^。！？；;\n]{0,80}?(?:禁用|关闭|停用|阻断|\b(?:be\s+)?disabl(?:e|es|ed|ing)\b|\b(?:be\s+)?turn(?:ed|s|ing)?\s+off\b)|(?:禁用|关闭|停用|阻断|\bdisabl(?:e|es|ed|ing)\b|\bturn(?:ed|s|ing)?\s+off\b)[^。！？；;\n]{0,80}?(?:\bis\s+(?:forbidden|prohibited|disallowed|banned|not\s+allowed|not\s+permitted)\b|被禁止|被严禁|不允许))/iu;
export const BARE_ENABLE =
  /(?:启用|开启|打开|允许|放行|\benabl(?:e|es|ed|ing)\b|\bturn(?:ed|s|ing)?\s+on\b|\ballow(?:ed|s|ing)?\b|\bpermit(?:ted|s|ting)?\b)/iu;
export const AFFIRMATIVE_DISABLE =
  /(?:禁用|关闭|停用|阻断|\bdisabl(?:e|es|ed|ing)\b|\bturn(?:ed|s|ing)?\s+off\b)/iu;
export const ANTONYM_BOILERPLATE =
  /(?:不要|不能|不得|不可|禁止|切勿|严禁|免于|避免|杜绝|取消|撤销|解除|被禁止|被严禁|被禁用|不允许|必须|务必|应当|需要|应该|保证|确保|保持|完整|全面|始终|永远|任何|所有|全部|一点|一丝|出现|漏掉|遗漏|漏记|丢失|丢掉|丢弃|省略|略过|忽略|跳过|忘掉|删掉|删除|保留|留存|保存|存留|包含|涵盖|纳入|覆盖|执行|启用|开启|打开|允许|放行|禁用|关闭|停用|阻断|\bdo\s+not\b|\bdon't\b|\bmust\s+not\b|\bmustn't\b|\bshall\s+not\b|\bmay\s+not\b|\bought\s+(?:not\s+)?to\b|\brequired\s+to\b|\bprohibited\s+from\b|\bcannot\b|\bcan't\b|\bcan\s+not\b|\bshould\s+not\b|\bshouldn't\b|\bwon't\b|\bwill\s+not\b|\bwouldn't\b|\bwould\s+not\b|\bnever\b|\bavoid\b|\bforbidden\b|\bprohibited\b|\bdisallowed\b|\bbanned\b|\bmust\b|\bshall\b|\balways\b|\bremain\b|\bstay\b|\b(?:be|is)\b|\bensure\b|\ball\b|\bany\b|\bomit\b|\bdrop\b|\bskip\b|\bmiss\b|\bignore\b|\bforget\b|\bdelete\b|\bdiscard\b|\bkeep\b|\bretain\b|\bpreserve\b|\binclude\b|\benforce\b|\benabl(?:e|es|ed|ing)\b|\bdisabl(?:e|es|ed|ing)\b|\bturn(?:ed|s|ing)?\s+on\b|\bturn(?:ed|s|ing)?\s+off\b|\ballow(?:ed|s|ing)?\b|\bpermit(?:ted|s|ting)?\b)/giu;

const ANTONYM_BOILERPLATE_NON_TOGGLE =
  /(?:不要|不能|不得|不可|禁止|切勿|严禁|免于|避免|杜绝|取消|撤销|解除|被禁止|被严禁|被禁用|不允许|必须|务必|应当|需要|应该|保证|确保|保持|完整|全面|始终|永远|任何|所有|全部|一点|一丝|出现|漏掉|遗漏|漏记|丢失|丢掉|丢弃|省略|略过|忽略|跳过|忘掉|删掉|删除|保留|留存|保存|存留|包含|涵盖|纳入|覆盖|执行|\bdo\s+not\b|\bdon't\b|\bmust\s+not\b|\bmustn't\b|\bshall\s+not\b|\bmay\s+not\b|\bought\s+(?:not\s+)?to\b|\brequired\s+to\b|\bprohibited\s+from\b|\bcannot\b|\bcan't\b|\bcan\s+not\b|\bshould\s+not\b|\bshouldn't\b|\bwon't\b|\bwill\s+not\b|\bwouldn't\b|\bwould\s+not\b|\bnever\b|\bavoid\b|\bforbidden\b|\bprohibited\b|\bdisallowed\b|\bbanned\b|\bmust\b|\bshall\b|\balways\b|\bremain\b|\bstay\b|\b(?:be|is)\b|\bensure\b|\ball\b|\bany\b|\bomit\b|\bdrop\b|\bskip\b|\bmiss\b|\bignore\b|\bforget\b|\bdelete\b|\bdiscard\b|\bkeep\b|\bretain\b|\bpreserve\b|\binclude\b|\benforce\b)/giu;

const DEFECT_FREE_MODIFIER_RE =
  /(?:零(?=(?:错误|报错|缺陷))|无(?=(?:报错|错误|异常))|\bzero\s+(?=(?:errors?|defects?|bugs?)\b)|(?<=\b(?:error|bug|defect))[-\s]?free\b)/giu;

export function oneWayAntonymMatch(negNorm, posNorm) {
  if (NEGATED_PRIVATIVE.test(negNorm) && AFFIRMATIVE_KEEP.test(posNorm) && !BARE_PRIVATIVE.test(posNorm)) return 'privative';
  if (NEGATED_DEFECT.test(negNorm) && DEFECT_FREE.test(posNorm)) return 'defect';
  if (NEGATED_ENABLE.test(negNorm) && !NEGATED_DISABLE.test(negNorm) && AFFIRMATIVE_DISABLE.test(posNorm) && !BARE_ENABLE.test(posNorm)) return 'enable-disable';
  if (NEGATED_DISABLE.test(negNorm) && !NEGATED_ENABLE.test(negNorm) && BARE_ENABLE.test(posNorm) && !AFFIRMATIVE_DISABLE.test(posNorm)) return 'enable-disable';
  return false;
}

const NUMERIC_BOUND_PHRASE_RE =
  /(?:\b(?:at\s+most|(?:no|not)\s+more\s+than|up\s+to|(?:(?:must|shall|should|will|do|does|did|may)\s+not|cannot|can't|mustn't|shouldn't|shan't|won't|don't|doesn't|didn't|never|not)\s+exceed|less\s+than|fewer\s+than|under|below)\b|最多|至多|不超过|不得超过|不能超过|不可超过|不高于|不大于|小于等于|<=|≤|<(?!=)|小于|低于|至少|最少|不少于|不得少于|不能少于|不低于|不得低于|不能低于|不小于|大于等于|>=|≥|>(?!=)|大于|超过|高于|\b(?:at\s+least|no\s+(?:less|fewer)\s+than|more\s+than|greater\s+than|over|above|exceed(?:s|ing)?)\b)(?=\s*-?\d)/gi;

const MODAL_COPULA_FILLER_RE = /\b(?:must|shall|should|will|can|be|is|are)\b/g;

export function equivalentNumericBoundPolarity(source, candidate, limit) {
  const sourceBounds = [];
  const candidateBounds = [];
  const canonicalize = (text, bounds) => text.replace(NUMERIC_BOUND_PHRASE_RE, (phrase) => {
    let bound;
    if (STRICT_UPPER_BOUND_RE.test(phrase)) bound = 'strictupperbound';
    else if (UPPER_BOUND_RE.test(phrase) || phrase === '≤') bound = 'upperbound';
    else if (STRICT_LOWER_BOUND_RE.test(phrase)) bound = 'strictlowerbound';
    else bound = 'lowerbound';
    bounds.push(bound);
    return ` ${bound} `;
  });
  const sCore = canonicalize(source, sourceBounds);
  const cCore = canonicalize(candidate, candidateBounds);
  if (
    sourceBounds.length === 0 ||
    JSON.stringify(sourceBounds) !== JSON.stringify(candidateBounds) ||
    ruleNegative(sCore) || ruleNegative(cCore)
  ) return false;
  const sNums = numericFacts(source);
  const cNums = numericFacts(candidate);
  const sCmp = sCore.replace(MODAL_COPULA_FILLER_RE, ' ');
  const cCmp = cCore.replace(MODAL_COPULA_FILLER_RE, ' ');
  return sNums.length > 0 && sNums.length === cNums.length &&
    numericFactsEquivalent(source, candidate, sNums, cNums) &&
    coverageOf(sCmp, normalize(cCmp)) >= limit &&
    coverageOf(cCmp, normalize(sCmp)) >= limit;
}

export function equivalentAntonymPolarity(source, candidate, sourceNegative, candNegative, limit = 0.6) {
  if (sourceNegative === candNegative) return false;
  const cleanSrc = stripListPrefix(stripSeqCitations(source));
  const cleanCand = stripListPrefix(stripSeqCitations(candidate));
  if (!scopesCompatible(cleanSrc, cleanCand)) return false;
  const sNorm = normalize(cleanSrc);
  const cNorm = normalize(cleanCand);
  if (equivalentNumericBoundPolarity(sNorm, cNorm, limit)) return true;
  const matched = sourceNegative ? oneWayAntonymMatch(sNorm, cNorm) : oneWayAntonymMatch(cNorm, sNorm);
  if (!matched) return false;
  const boilerplate = matched === 'enable-disable' ? ANTONYM_BOILERPLATE : ANTONYM_BOILERPLATE_NON_TOGGLE;
  const sPre = matched === 'defect' ? sNorm.replace(DEFECT_FREE_MODIFIER_RE, ' ') : sNorm;
  const cPre = matched === 'defect' ? cNorm.replace(DEFECT_FREE_MODIFIER_RE, ' ') : cNorm;
  const core = sPre.replace(boilerplate, ' ').replace(/\s+/g, ' ').trim();
  if (!core || coverageTokens(core).length === 0) return false;
  if (coverageOf(core, cNorm) < limit) return false;
  const cCore = cPre.replace(boilerplate, ' ').replace(/\s+/g, ' ').trim();
  if (!cCore || coverageTokens(cCore).length === 0) return false;
  return coverageOf(cCore, sNorm) >= limit;
}

export const LEADING_SEQ_CITATION_RE =
  /^(?:\[\s*seqs?\s+\d+(?:\s*[-–,]\s*\d+)*\s*\]|[（(]\s*seqs?\s+\d+(?:\s*[-–,]\s*\d+)*\s*[)）]|seqs?\s*#?\s*\d+(?:\s*[-–,]\s*\d+)*(?:\s*[:：])?|>\s*user\s+source\s*\(seq\s+\d+\),\s*verbatim:)\s*/i;
export const TRAILING_SEQ_CITATION_RE =
  /(?:\s*(?:\[\s*seqs?\s+\d+(?:\s*[-–,]\s*\d+)*\s*\]|[（(]\s*seqs?\s+\d+(?:\s*[-–,]\s*\d+)*\s*[)）]))+\s*$/i;

export const stripOuterQuotePair = stripOuterQuotes;

export function normalizeConditionalInput(text) {
  let out = stripMarkdownEmphasis(text).trim();
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

export const PURPOSE_AVOID_PREFIX_RE =
  /^(?:(?:说明|注意|另外|后续|以后|其实|因此|当前)[^,，。；;\n]{0,12}?)?(?:为(?:了)?|以)(?:避免|杜绝)[^，,。；;\n]{1,30}[，,]\s*(.+)$/;
export const PURPOSE_AVOID_SUFFIX_RE =
  /^(.+?)[，,]\s*(?:为(?:了)?|以)(?:避免|杜绝)[^，,。；;\n]{1,30}[。.!！;；]?$/;

export function stripPurposeAvoidClause(text) {
  const cleaned = normalizeConditionalInput(text);
  if (!cleaned || cleaned.length > 1024) return null;
  const prefixMatch = PURPOSE_AVOID_PREFIX_RE.exec(cleaned);
  if (prefixMatch && prefixMatch[1]?.trim()) return prefixMatch[1].trim();
  const suffixMatch = PURPOSE_AVOID_SUFFIX_RE.exec(cleaned);
  if (suffixMatch && suffixMatch[1]?.trim()) return suffixMatch[1].trim();
  return null;
}

export function scalarSubjectsIncompatible(sScalar, cScalar) {
  if (!sScalar || !cScalar) return false;
  const sSubj = stripNegAndModal(sScalar.subject);
  const cSubj = stripNegAndModal(cScalar.subject);
  if (!sSubj || !cSubj || sSubj === cSubj) return false;
  return coverageOf(sSubj, cSubj) < 0.5 && coverageOf(cSubj, sSubj) < 0.5;
}

export const POLARITY_MAJOR_SPLIT_RE =
  /\s*(?:→|->|=>|⇒)\s*|[；;]|(?=\s*(?:而不是|而非))|\s*(?:并且|而且|但是|不过|然而|反而|随后|然后|接着|继而)\s*|(?<![暂尚姑并而])且|(?<!不)但|(?<![从进因然反视一概取])而(?![已论定])/i;

export const GOVERNING_NEG_BEFORE_BRACKET_RE =
  /(?:不允许|不应(?:当|该)?|不要(?!求)|不能|不得|不必|不用|禁止|(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人)|无需|不可(?!逆(?:转)?|或缺|避免|变|见|达|靠|控|思议|分割|替代|动摇|预知|预计|预测|抗力|恢复|再生|估量|多得|胜数|名状|一世|开交|磨灭|置否|逾越)|不准|不许|严禁|勿|没有|尚未|并未|未曾|并非|不再|取消|撤销|(?<!为了?|以)(?:避免|杜绝)|免于|不(?![同仅但过论管断少足安便光止久妨料然如至]|得不)|未|\b(?:must\s+not|mustn't|shall\s+not|may\s+not|ought\s+not\s+to|prohibited\s+from|do\s+not|don't|cannot|can't|can\s+not|should\s+not|shouldn't|won't|will\s+not|wouldn't|would\s+not|never|forbid(?:s|den|ding)?|disallow(?:s|ed|ing)?|ban(?:s|ned|ning)?|prohibit(?:s|ed|ing)?|avoid|no|not|without)\b)\s*(?:包含|含有|含|附带|附|使用|用|执行|做|改|修改|删除|安装|装|允许|保留|给|写|启动|重启|部署)?\s*$/i;

export function splitParentheticalSegments(clause) {
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
    if (
      tail.trim().length >= 4 &&
      (/[「『]/.test(tail) || /\bseq\s*\d+/i.test(tail) || isInstructionLine(tail) || ruleNegative(tail))
    ) {
      spans.push({
        start: firstUnclosed.index,
        end: value.length,
        innerStart: firstUnclosed.index + 1,
        innerEnd: value.length,
      });
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

export function splitClauseEnumeration(segment) {
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

export const NOMINAL_RULE_HEAD_RE =
  /^(?:的|纪律|规范|原则|红线|约束|底线|禁令|守则|规则|条款|标准|要求|机制|策略|门禁|制度|前置条件|前提|检查|核对|清单)/;
export const QUOTE_PERMISSION_OR_REVERSAL_RE =
  /(?:允许|可以|准许|放行|批准|授权|同意|放开|取消|撤销|废除|解除|不再|不必再|不用再|不要再|不能再|不得再|\b(?:allow(?:ed)?|permit(?:ted)?|approv(?:e|ed)|authori[sz](?:e|ed)|cancel|revoke)\b)/i;

export function splitQuoteSegments(segment) {
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

export function localPolaritySegments(text) {
  const input = String(text ?? '');
  const cacheable = input.length <= 512;
  if (cacheable && localPolaritySegmentsCache.has(input)) {
    return localPolaritySegmentsCache.get(input);
  }
  const raw = stripExplicitValueCorrection(input.trim());
  if (!raw) return [];
  const literals = [];
  let masked = CODE_SPLIT_MASK(raw, literals);
  // Preserve explicit boolean arrow transitions (`debug: false -> true`) across
  // `POLARITY_MAJOR_SPLIT_RE` so pre-arrow `false` is not extracted as active.
  masked = masked.replace(
    /(?<![a-z0-9_.-])(["']?(?:--)?[a-z_][a-z0-9_.-]{1,63}["']?\s*[:=：]\s*["']?\b(?:true|false)\b["']?\s*(?:->|→|=>|⇒)\s*["']?\b(?:true|false)\b["']?(?![a-z0-9_-]|\.[a-z0-9_]))/gi,
    (full) => {
      literals.push(full);
      return `\uE000${literals.length - 1}\uE001`;
    },
  );
  const splitEnglishPolarityAnd = (segment) => {
    if (!/\band\b/i.test(segment)) return [segment];
    const hasSideSignal = (side) => {
      const s = String(side ?? '').trim();
      if (!s) return false;
      if (ruleNegative(s)) return true;
      if (/(?<![a-z0-9_-])--[a-z][a-z0-9-]*/i.test(s)) return true;
      if (/(?<![a-z0-9_.-])[a-z_][a-z0-9_.-]{1,63}\s*[:=：]\s*["']?\b(?:true|false)\b/i.test(s)) return true;
      if (
        /\b(?:always|must|shall|never|do\s+not|don't|cannot|can't|shouldn't|mustn't|won't|wouldn't|enable|disable|keep|retain|pass|use|set|avoid|forbid|prohibit|allow|permit|turn\s+on|turn\s+off)\b/i.test(
          s,
        )
      ) {
        return true;
      }
      return false;
    };
    const isActionVerbHead = (side) =>
      /^(?:please|always|must|shall|should)?\s*(?:delete|remove|drop|destroy|truncate|erase|modify|edit|change|alter|overwrite|update|write|create|add|deploy|publish|push|release|restart|reboot|stop|start|run|execute|exec|call|invoke|send|upload|expose|leak|print|log|skip|bypass|ignore|disable|enable|keep|retain|pass|use|set|avoid|forbid|prohibit|allow|permit|commit|merge|reset|revert|touch|read|access|open|close|kill|terminate|flush|clear|clean|purge|wipe)\b/i.test(
        String(side ?? '').trim(),
      );
    const parts = [];
    let currentStart = 0;
    const andRe = /\s+\band\b\s+/gi;
    let m;
    while ((m = andRe.exec(segment)) !== null) {
      const left = segment.slice(currentStart, m.index).trim();
      const right = segment.slice(andRe.lastIndex).trim();
      if (
        hasSideSignal(left) &&
        (hasSideSignal(right) ||
          (ruleNegative(left) && isActionVerbHead(right) && coverageTokens(stripNegAndModal(left)).length >= 2))
      ) {
        parts.push(left);
        currentStart = andRe.lastIndex;
      }
    }
    const tail = segment.slice(currentStart).trim();
    if (tail) parts.push(tail);
    return parts.length > 0 ? parts : [segment];
  };
  const majorParts = [];
  for (const commaPart of splitCommaClausesPreservingNegCoord(masked, literals)) {
    for (const seg of commaPart.split(POLARITY_MAJOR_SPLIT_RE)) {
      const part = unmask(seg, literals).trim();
      if (!part) continue;
      if (/(?:或者?|以及|及|与|和|并)/.test(part)) {
        CN_COORD_OVERRIDE_SPLIT_RE.lastIndex = 0;
        for (const sub of part.split(CN_COORD_OVERRIDE_SPLIT_RE)) {
          const clean = sub.trim();
          if (!clean) continue;
          for (const enSub of splitEnglishPolarityAnd(clean)) {
            if (enSub) majorParts.push(enSub);
          }
        }
      } else {
        for (const enSub of splitEnglishPolarityAnd(part)) {
          if (enSub) majorParts.push(enSub);
        }
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
