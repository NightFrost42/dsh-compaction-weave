// Domain-agnostic clause action normalization shared by lifecycle selection and
// simple polarity comparison. Compound clauses, quotes, and conditionals return null.

const normalize = (text) =>
  String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/[。.!！?？;；，,]+$/, '')
    .replace(/\s+/g, ' ');

const FORBIDDEN = /[`"“”‘’「」『』，,；;]|(?<![a-z])'|'(?![a-z])|如果|除非|只有|仅当|否则|或者|要么|(?:^|[，,])\s*(?:若|当)|并且|然后|同时|以及|\b(?:if|when|unless|either|except|and|or|then)\b/i;
const RETROSPECTIVE = /^(?:已(?:经)?|曾(?:经)?|之前|此前|据|根据|\b(?:already|previously|earlier)\b)/i;
const REFERENCE_HEAD = /^(?:历史|旧文档|引用|网页|工具|日志|文档|样例|示例|the\s+(?:tool|document|log)|historical)/i;
const CN_NEG_WORDS = '(?:不允许|不要再|不用再|不要(?!求)|不得|不能|不必|不再|不用|禁止|(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人)|无需|取消|撤销|尚未|并未|未曾|还未|没有|不(?:实际|直接|擅自)?|未)';
const EN_NEG_WORDS = '(?:do not|don\'t|does not|doesn\'t|must not|cannot|can\'t|never|cancel(?:l?ed)?|no longer|not|no)';
const CN_POS_WORDS = '(?:允许|可以|批准|授权|同意)';
const EN_POS_WORDS = '(?:allow(?:ed)?|permit(?:ted)?|authori[sz](?:e|ed)|approv(?:e|ed))';
const NEG_RE = new RegExp(`^(?:${CN_NEG_WORDS}|${EN_NEG_WORDS}(?:\\s+|$))`, 'i');
const OPERATOR_RE = new RegExp(
  `^(?:(?:用户|我|你|助手|我们)\\s*)?(?:现在|已经|已|明确|现已)?\\s*(?:(${CN_POS_WORDS}|${CN_NEG_WORDS})\\s*|(${EN_POS_WORDS}|${EN_NEG_WORDS})(?:\\s+|$))|^(?:(?:the user|i|you|we)\\s+)?(?:(?:has|have)\\s+)?(?:now\\s+|already\\s+)?(?:(${CN_POS_WORDS}|${CN_NEG_WORDS})\\s*|(${EN_POS_WORDS}|${EN_NEG_WORDS})(?:\\s+|$))`,
  'i',
);

const actionStateCache = new Map();

export function actionState(text, { summary = false } = {}) {
  const raw = String(text ?? '');
  const cacheable = raw.length <= 512;
  const cacheKey = cacheable ? `${summary ? '1' : '0'}\0${raw}` : '';
  if (cacheable && actionStateCache.has(cacheKey)) {
    return actionStateCache.get(cacheKey);
  }
  let value = normalize(raw).replace(/^[「『]([^「」『』]+)[」』]$/, '$1').trim();
  if (!value || value.length > 512 || FORBIDDEN.test(value)) {
    if (cacheable) {
      if (actionStateCache.size >= 2048) actionStateCache.clear();
      actionStateCache.set(cacheKey, null);
    }
    return null;
  }
  if (RETROSPECTIVE.test(value) || REFERENCE_HEAD.test(value)) {
    if (cacheable) {
      if (actionStateCache.size >= 2048) actionStateCache.clear();
      actionStateCache.set(cacheKey, null);
    }
    return null;
  }

  let negative = false;
  let permission = false;
  value = value.replace(/^(?:当前|目前|现行)?(?:用户)?(?:要求|指令|规则|任务)\s*[:：]\s*/, '');
  if (summary) {
    value = value.replace(/^(?:下一步|接下来|然后|现在|计划|准备|待|将要|将|继续)\s*[:：]?\s*|^(?:next(?:\s+step)?|plan(?:ned)?(?:\s+to)?|will|then)\s*:?\s*/i, '');
  }
  value = value.replace(/^(?:(?:请|帮我|麻烦|必须|务必|现在|重新|还是|才(?:可(?:以)?|能)?)\s*|(?:please|must|always|now|again)\s+)+/i, '');

  const match = OPERATOR_RE.exec(value);
  if (match) {
    const op = match[1] ?? match[2] ?? match[3] ?? match[4];
    negative = NEG_RE.test(op);
    permission = !negative;
    value = value.slice(match[0].length).replace(/^(?:to\s+|实际|直接|擅自|重新|再\s*)/i, '').trim();
    if (NEG_RE.test(value)) {
      if (cacheable) {
        if (actionStateCache.size >= 2048) actionStateCache.clear();
        actionStateCache.set(cacheKey, null);
      }
      return null;
    }
  }

  const stem = value
    .replace(/^(?:to\s+|把\s*|将\s*)/i, '')
    .replace(/(?:的)?(?:任务|请求|操作)$/, '')
    .replace(/(?:了|吧)$/, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    .trim();
  if (!stem) {
    if (cacheable) {
      if (actionStateCache.size >= 2048) actionStateCache.clear();
      actionStateCache.set(cacheKey, null);
    }
    return null;
  }

  const out = Object.freeze({ verb: stem, object: '', negative, permission, key: stem });
  if (cacheable) {
    if (actionStateCache.size >= 2048) actionStateCache.clear();
    actionStateCache.set(cacheKey, out);
  }
  return out;
}

export function sameAction(a, b) {
  return Boolean(a && b && a.key === b.key);
}
