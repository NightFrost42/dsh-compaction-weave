// Layer 1: unit normalization, scalar requirements, numeric facts, and bound historical value checks.
// Imports ONLY from Layer 0 (./normalize.js).

import {
  normalize,
  stripExplicitValueCorrection,
  stripInlineMarkdownFormatting,
  stripListPrefix,
  stripSeqCitations,
} from './normalize.js';

export const UNIT_NORM = new Map([
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

export const UNIT_BASE_FACTOR = new Map([
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

export function splitNumUnit(token) {
  const m = /^(-?\d+(?:\.\d+)?)([a-z%个次条]*)$/.exec(String(token ?? ''));
  return m ? { val: m[1], unit: m[2] } : null;
}

export function canonicalQuantity(numStr, unit) {
  const spec = UNIT_BASE_FACTOR.get(unit);
  if (!spec) return null;
  const n = Number(numStr);
  if (!Number.isFinite(n)) return null;
  return { family: spec.family, baseValue: n * spec.factor };
}

export function canonicalValuesEqual(a, b) {
  return Math.abs(a - b) <= Math.max(1e-9, Math.max(Math.abs(a), Math.abs(b)) * 1e-12);
}

export function canonicalFactToken(token) {
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

export function canonicalNumsKey(text) {
  return numericFacts(text).map(canonicalFactToken).join(',');
}

export const SIZE_CONTEXT_RE =
  /(?:内存|显存|硬盘|磁盘|存储|空间|容量|体积|大小|字节|上限|下限|配额|限额|限制|缓存|缓冲|备份|文件|日志|带宽|流量|最大|最小|至少|不超过|小于|大于|低于|高于|\b(?:ram|vram|mem(?:ory)?|disk|storage|space|size|bytes?|cap(?:acity)?|limit|quota|backup|cache|buffer|heap|max|min|at\s+least|at\s+most|under|over|below|above)\b)/i;

export function isNonQuantityTechTerm(numText, space, rawUnit, contextText) {
  if (space || !rawUnit) return false;
  // Compact uppercase single-letter duration symbols (e.g. 3D, 2D, 3M, 6S, 2H) are tech terms, not durations.
  if (/^[DSMH]$/.test(rawUnit)) return true;
  // Compact uppercase "B" (e.g. 2B, 4B, 14B, 70B, 671B model parameter sizes / 2B SaaS) without byte/size context is not bytes.
  if (rawUnit === 'B' && !SIZE_CONTEXT_RE.test(contextText)) return true;
  // Bare "2G"-"6G" without storage/memory/quota context is typically telecom/WiFi generation rather than GB.
  if (rawUnit === 'G' && /^[2-6]$/.test(numText) && !SIZE_CONTEXT_RE.test(contextText)) return true;
  return false;
}

export function unitFamily(rawUnit) {
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
    .replace(/^\s*(?:\d{1,2}[.)]\s+|\(\d{1,2}\)\s+|[-*•+]\s+)/, '')
    .replace(/^(?:(?:wait\s+no|actually|sorry|correction|revision|revised|update|updated|instead|change(?:\s+that)?\s+to|make\s+that)\s*[,:：\-–—]\s*)+/i, '')
    .replace(/^(?:(?:不好意思|抱歉|不对|更正一下|改一下)\s*[,，:：]\s*)+/, '')
    .replace(/^(?:需求变更|变更说明|规则更新|参数更新|配置变更|更正|修订)\s*[:：]\s*(?:改为|改成|调整为|更新为)?\s*/, '')
    .replace(/^(?:改为|改成|调整为|更新为)\s+(?=[a-zA-Z])/, '')
    .replace(/^(?:当前|目前|现行(?:有效)?|仍生效的?)(?:\s*[:：]\s*)?/, '')
    .replace(/\s*[（(]\s*(?:取消|撤销|替代|取代|原(?:为|值)?|旧(?:为|值)?|instead\s+of|replaces?|cancels?|was|previously|formerly)\s+[^)）]{1,48}[)）]/gi, '')
    .replace(/[。.!！?？;；，,]+$/, '')
    .trim();
  if (!value || value.length > 256) return cacheAndReturn(null);
  if (/[`"'“”‘’「」『』<>{}[\]/\\]|如果|除非|只有|仅当|否则|或者|要么|(?:^|[，,])\s*(?:若|当)/.test(value)) {
    return cacheAndReturn(null);
  }
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

export const LOC_REF_RE = /(?<![a-z0-9_./-])([a-z0-9_./-]{1,120}\.[a-z]{1,6}):(\d+(?:-\d+)?)/gi;
export const NON_QUANTITY_NUM_RE =
  /(?<![a-z0-9_./-])\d{4}\/\d{1,2}\/\d{1,2}(?![a-z0-9_./-])|(?<!\d)\d{4}\s*年\s*(?:1[0-2]|0?[1-9])\s*月(?:\s*(?:3[01]|[12]\d|0?[1-9])\s*[日号])?|(?<!\d)(?:1[0-2]|0?[1-9])\s*月\s*(?:3[01]|[12]\d|0?[1-9])\s*[日号]|(?<!\d)(?:19|20)\d{2}\s*年|第\s*\d+\s*(?:年|个月|周|星期|天|日|季度|月)|(?:^|[\s(（\[【])(?:规则|条款|条件|要点|要求|原则|约束|步骤|阶段|项目|条目|注意事项|说明|问题|任务|事项|rule|step|item|point|requirement)\s*#?\d+\s*[:：、.)）]|第\s*\d+\s*(?:条|项|点|步|款|章|节)\s*[:：、.)）]|(?:^|\n)\s*\d+\s*(?:\.(?!\d)(?:\s+|$)|[)）、](?:\s+|$))|(?<=[;；,，、(（]\s*)\d{1,2}\s*\.(?!\d)(?:\s+|$)|(?<=(?<!(?:port|timeout|retries|limit|max|min|count|size|ratio|level|version|端口|超时|重试|上限|下限|数量|版本)\s*)[:：]\s*)\d{1,2}\s*\.(?!\d)(?:\s+|$)|(?<![a-z0-9_./-])(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?![a-z0-9_./-])|(?<![a-z0-9_])#\d+\b|(?<![a-z0-9_.-])v\d+(?:\.\d+)+(?![a-z0-9_.-])/gi;

const numericFactsCache = new Map();
const ASCII_NUMERIC_RANGE_RE =
  /(?<![a-z0-9_./-])(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)(\s*)(ms|s|sec|seconds?|months?|m|min|minutes?|h|hours?|d|days?|weeks?|years?|yrs?|gb|gib|mb|mib|kb|kib|tb|tib|bytes?|b|g|%|毫秒|秒|分钟?|小时|天|个月|周|星期|年|字节)?(?![a-z0-9_-]|\.[a-z0-9])/gi;

export function numericFacts(text) {
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
  const value = withoutMeta
    .replace(/(?<!\d)\d{1,3}(?:,\d{3})+(?!\d)/g, (m) => m.replaceAll(',', ''))
    // Standalone range endpoints share the trailing unit. Identifier/version
    // hyphens remain excluded by the numeric word boundaries.
    .replace(ASCII_NUMERIC_RANGE_RE, (_full, low, high, space, unit = '') => `${low}${space}${unit} ${high}${space}${unit}`);
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

export function identifierImpliedUnits(text) {
  const units = new Set();
  const str = String(text ?? '');
  for (const _ of str.matchAll(/(?:_|-)ms\b|(?<=[a-z0-9])Ms\b/g)) {
    units.add('ms');
  }
  for (const m of str.matchAll(
    /(?:_|-|(?<=[a-z0-9]))(milliseconds?|millis|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|yrs?|bytes?|kb|mb|gb|tb|tib|pct|percent)\b/gi,
  )) {
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

export function factUnitFamily(token) {
  if (token.startsWith('loc:')) return 'loc';
  const m = /^(-?\d+(?:\.\d+)?)([a-z%个次条]*)$/.exec(token);
  if (!m) return 'other';
  return unitFamily(m[2]).family;
}

export function singleNumericFactMatches(sTok, cTok, sImplied, cImplied) {
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

export const UNIT_OPT_RE =
  '(?:ms|s|sec|seconds?|months?|m|min|minutes?|h|hours?|d|days?|weeks?|years?|yrs?|gb|gib|mb|mib|kb|kib|tb|tib|bytes?|b|g|%|毫秒|秒|分钟?|小时|天|个月|周|星期|年|字节|个|次|条)?';

export function numericFactsEquivalent(source, candidate, sNums, cNums) {
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
    // Allow reordered facts only when every source fact belongs to a distinct unit family (or distinct file path for loc: tokens).
    const distinctFamilyKey = (tok) => {
      if (tok.startsWith('loc:')) {
        const sep = tok.lastIndexOf(':');
        return sep > 4 ? tok.slice(0, sep) : 'loc';
      }
      return factUnitFamily(tok);
    };
    const sFams = sNums.map(distinctFamilyKey);
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

export function scalarSubjectVerdict(activeSource, candidate) {
  const strippedSrc = stripExplicitValueCorrection(stripListPrefix(stripSeqCitations(activeSource)));
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

export const HIST_TAG_ONLY_RE =
  '(?:previously|formerly|originally|initially|superseded|deprecated|retired|replaced|当时|原值|旧值|已修订|已取代|已弃用|已废弃|已替换|不再用|非现行)';

export function isBoundHistoricalValue(sourceLine, candidate) {
  const strippedSrc = stripListPrefix(stripSeqCitations(sourceLine));
  const sScalar = scalarRequirement(strippedSrc);
  if (!sScalar || sScalar.subject.length < 2) return false;
  const esc = sScalar.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const candClean = stripListPrefix(normalize(stripSeqCitations(candidate)));
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
