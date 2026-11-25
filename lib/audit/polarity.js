// Layer 3a: CLI-flag, boolean-switch, clause-matching, and polarity conflict detection.

import { actionState, sameAction } from '../action-state.js';
import {
  ASCII_TOKEN_RE,
  CJK_BIGRAM_RE,
  INEVITABILITY_MODAL_RE,
  MODAL_STRIP,
  NEGATION,
  asciiWordsOf,
  cjkBigramsOf,
  coverageOf,
  coverageTokens,
  negationsOf,
  normalize,
  proseOnly,
  ruleNegative,
  stripExplicitValueCorrection,
  stripInlineMarkdownFormatting,
  stripNegAndModal,
  stripNumbersForTopic,
  stripSeqCitations,
} from './normalize.js';
import {
  LOC_REF_RE,
  NON_QUANTITY_NUM_RE,
  identifierImpliedUnits,
  numericFacts,
  numericFactsEquivalent,
  scalarRequirement,
  scalarSubjectVerdict,
  singleNumericFactMatches,
} from './numeric.js';
import {
  AFFIRMATIVE_DISABLE,
  ANTONYM_BOILERPLATE,
  BARE_ENABLE,
  LOWER_BOUND_RE,
  NEGATED_DISABLE,
  NEGATED_ENABLE,
  QUOTE_PERMISSION_OR_REVERSAL_RE,
  STRICT_LOWER_BOUND_RE,
  STRICT_UPPER_BOUND_RE,
  UPPER_BOUND_RE,
  allTransferPairs,
  conditionParts,
  equivalentAntonymPolarity,
  exceptionTarget,
  isInstructionLine,
  localPolaritySegments,
  normalizeConditionalInput,
  scalarSubjectsIncompatible,
  scopesCompatible,
  splitContrastClauses,
  splitParentheticalSegments,
  stripException,
  stripPurposeAvoidClause,
} from './clauses.js';

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

const stripBulletPrefix = (text) =>
  stripSeqCitations(text).replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim();

/** Extract effective `key: true|false` switch polarities from `text` (bounded LRU cache). */
export function extractBooleanSwitches(text) {
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

/** Extract effective `--flag` / `--no-flag` polarities from `text` (bounded LRU cache). */
export function extractCliFlags(text) {
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

/** Return true when `source` and `candidate` agree on unambiguous CLI flags or boolean switches. */
export function sharesPreservedCliOrBoolPolarity(source, candidate) {
  if (!scopesCompatible(source, candidate)) return false;
  const sFlags = extractCliFlags(source);
  const cFlags = extractCliFlags(candidate);
  if (mapsShareUnambiguousOpposite(sFlags, cFlags)) return false;
  const sBools = extractBooleanSwitches(source);
  const cBools = extractBooleanSwitches(candidate);
  if (mapsShareUnambiguousOpposite(sBools, cBools)) return false;
  return mapsShareUnambiguousEqual(sFlags, cFlags) || mapsShareUnambiguousEqual(sBools, cBools);
}

/** Determine whether a single `candidate` clause corresponds to `source`. */
export function clauseMatchesSingle(source, candidate, limit) {
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
  const sScalar = scalarRequirement(stripBulletPrefix(source));
  const cScalar = scalarRequirement(stripBulletPrefix(candidate));
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
  if (hasLexicalDisableEnableConflict(source, candidate, limit, { negated: ruleNegative(source) })) return true;
  return false;
}

const normativeSourceSegmentsCache = new Map();

/** Split `source` into normative sub-segments for compound polarity matching (bounded cache). */
export function normativeSourceSegments(source) {
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

/** Determine whether `source` and `candidate` match across segmented clauses. */
export function clauseMatchesSource(source, candidate, limit) {
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
  const cleanSrc = stripExplicitValueCorrection(stripBulletPrefix(srcText));
  const cleanCand = stripExplicitValueCorrection(stripBulletPrefix(candSeg));
  const cleanContext =
    contextSource && contextSource !== srcText
      ? stripExplicitValueCorrection(stripBulletPrefix(contextSource))
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

function hasLexicalDisableEnableConflict(normativeSource, candSeg, limit, { negated = false } = {}) {
  const cleanSrc = stripExplicitValueCorrection(stripBulletPrefix(normativeSource));
  const cleanCand = stripExplicitValueCorrection(stripBulletPrefix(candSeg));
  if (negated ? (!ruleNegative(cleanSrc) || !ruleNegative(cleanCand)) : (ruleNegative(cleanSrc) || ruleNegative(cleanCand))) {
    return false;
  }
  if (!scopesCompatible(cleanSrc, cleanCand)) return false;
  if (scalarSubjectsIncompatible(scalarRequirement(cleanSrc), scalarRequirement(cleanCand))) return false;
  const sNorm = normalize(cleanSrc);
  const cNorm = normalize(cleanCand);
  if (negated) {
    const sNegDis = NEGATED_DISABLE.test(sNorm) && !NEGATED_ENABLE.test(sNorm);
    const cNegDis = NEGATED_DISABLE.test(cNorm) && !NEGATED_ENABLE.test(cNorm);
    const sNegEn = NEGATED_ENABLE.test(sNorm) && !NEGATED_DISABLE.test(sNorm);
    const cNegEn = NEGATED_ENABLE.test(cNorm) && !NEGATED_DISABLE.test(cNorm);
    if (!((sNegDis && cNegEn) || (sNegEn && cNegDis))) return false;
  } else {
    const sDis = AFFIRMATIVE_DISABLE.test(sNorm) && !BARE_ENABLE.test(sNorm) && !NEGATED_ENABLE.test(sNorm);
    const cDis = AFFIRMATIVE_DISABLE.test(cNorm) && !BARE_ENABLE.test(cNorm) && !NEGATED_ENABLE.test(cNorm);
    const sEn = BARE_ENABLE.test(sNorm) && !AFFIRMATIVE_DISABLE.test(sNorm) && !NEGATED_ENABLE.test(sNorm);
    const cEn = BARE_ENABLE.test(cNorm) && !AFFIRMATIVE_DISABLE.test(cNorm) && !NEGATED_ENABLE.test(cNorm);
    if (!((sDis && cEn) || (sEn && cDis))) return false;
  }
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
    if (hasLexicalDisableEnableConflict(normativeSource, candSeg, limit, { negated: srcNeg })) return true;
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
        const neg = ruleNegative(sub);
        const conflict = isSegmentPolarityConflict(sub, candSeg, neg, limit, sub);
        return { sub, idx, sameAct, fwd, score, neg, conflict };
      });
      const bestScore = Math.max(...scored.map((x) => x.score));
      const top = scored.filter((x) => x.score >= bestScore - 0.35 || x.sameAct);
      if (
        top.some((x) => x.conflict) ||
        scored.some((x) => x.conflict && x.neg && x.fwd >= Math.max(limit, 0.75))
      ) {
        return true;
      }
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

/** Return true if `normativeSource` is only a bare modal/command verb without an object. */
export function isBareShortVerbSource(normativeSource, activeSource = normativeSource) {
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

/** Compare `source` and `candidate` for polarity, condition, range, relation, exception, or value conflict. */
export function conflictForPair(source, candidate, limit) {
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
        const conflictingSub =
          matchingNormSubs.length > 1
            ? matchingNormSubs.find((sub) => {
                const subCond = conditionParts(sub);
                const subEx = exceptionTarget(sub);
                const subPurpose = !subCond ? stripPurposeAvoidClause(sub) : null;
                const normSub = subCond ? subCond.consequence : (subPurpose ?? sub);
                const subNeg = ruleNegative(subEx ? stripException(normSub) : normSub);
                if (!isInstructionLine(normSub) || isBareShortVerbSource(normSub, sub)) return false;
                return candPool.some((candSeg) => {
                  if (!clauseMatchesSingle(sub, candSeg, limit)) return false;
                  const candEx = exceptionTarget(candSeg);
                  const candCond = conditionParts(candSeg);
                  const candPurpose = !candCond ? stripPurposeAvoidClause(candSeg) : null;
                  const candNormSub = candCond ? candCond.consequence : (candPurpose ?? candSeg);
                  const candPol = candEx ? stripException(candNormSub) : candNormSub;
                  return hasPolarityConflict(normSub, candPol, subNeg, limit, sub);
                });
              })
            : null;
        if (conflictingSub) {
          activeSource = conflictingSub;
        } else {
          const scoreSub = (sub) => coverageOf(sub, candNorm) + coverageOf(candidate, normalize(sub));
          matchingNormSubs.sort((a, b) => scoreSub(b) - scoreSub(a));
          activeSource = matchingNormSubs[0];
        }
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
  {
    const sLow = LOWER_BOUND_RE.test(activeSource);
    const sSLow = STRICT_LOWER_BOUND_RE.test(activeSource);
    const sHigh = UPPER_BOUND_RE.test(activeSource);
    const sSHigh = STRICT_UPPER_BOUND_RE.test(activeSource);
    const cLow = LOWER_BOUND_RE.test(candidate);
    const cSLow = STRICT_LOWER_BOUND_RE.test(candidate);
    const cHigh = UPPER_BOUND_RE.test(candidate);
    const cSHigh = STRICT_UPPER_BOUND_RE.test(candidate);
    const sAnyLow = sLow || sSLow;
    const sAnyHigh = sHigh || sSHigh;
    const cAnyLow = cLow || cSLow;
    const cAnyHigh = cHigh || cSHigh;
    if (
      (sAnyLow && cAnyHigh && !cAnyLow) ||
      (sAnyHigh && cAnyLow && !cAnyHigh) ||
      (sSHigh && !sHigh && cHigh && !cSHigh) ||
      (sSLow && !sLow && cLow && !cSLow) ||
      (sHigh && !sSHigh && cSHigh && !cHigh) ||
      (sLow && !sSLow && cSLow && !cLow)
    ) {
      return { reason: 'range', candidate };
    }
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

export const NORMATIVE_OR_CURRENT_CLAIM_RE =
  /(?:仍(?:然|旧)?|继续|现行|当前|目前|依然|有效|生效|批准|允许|保持|维持|遵循|采用|\b(?:still|current(?:ly)?|now|active|valid|effective|approved|authorized|permitted|enforced|kept|retained|maintain(?:ed)?|use[ds]?|apply|applies)\b)/i;

const DISTINGUISHING_IDENT_RE = /[a-z][a-z0-9_.-]*[_\d][a-z0-9_.-]*|[a-z0-9_.-]+\.[a-z]{1,6}/gi;

/** Return true when numeric facts, boolean switches, CLI flags, and identifiers from `line` survive in `targetText`. */
export function lineFactsPreservedIn(line, targetText, targetNorm) {
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

export const DISABLE_ENABLE_CUE_RE = /(?:禁用|关闭|停用|阻断|启用|开启|打开|允许|放行|\b(?:disable|enable|turn\s+off|turn\s+on|allow|permit)\b)/i;

/** Extract inverted-index feature tokens (ASCII runs + CJK 2-grams) from `text`. */
export function queryFeatureTokens(text) {
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

/** Build sub-queries with minimum feature hit thresholds for candidate clause pre-filtering. */
export function subQueriesForLine(line, limit) {
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
    const sScalar = scalarRequirement(stripExplicitValueCorrection(stripBulletPrefix(s)));
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
