// Layer 4: Constraint coverage, polarity, numeric, and provenance compaction audit.

import { actionState } from '../action-state.js';
import { instructionText, isReferencePrefixOnly, isSystemReminderOnly } from '../instruction-source.js';
import { isReferenceContextKind } from '../source-provenance.js';
import { summaryProse } from '../validate.js';
import {
  ASCII_TOKEN_RE,
  CN_MODAL,
  COMMAND,
  EN_MODAL,
  candidateSeqCitations,
  coverageOf,
  coverageTokens,
  normalize,
  ruleNegative,
  stripExplicitValueCorrection,
  stripFencedCodeBlocks,
  stripQuantityTokens,
  stripSeqCitations,
} from './normalize.js';
import {
  canonicalFactToken,
  canonicalNumsKey,
  isBoundHistoricalValue,
  numericFacts,
  numericFactsEquivalent,
  scalarRequirement,
  scalarSubjectVerdict,
} from './numeric.js';
import {
  conditionParts,
  equivalentAntonymPolarity,
  hasRequirementNumericCue,
  isInstructionLine,
  localPolaritySegments,
  scopesCompatible,
  scopeSetOf,
  sourceEvidenceSentences,
  splitContrastClauses,
} from './clauses.js';
import {
  DISABLE_ENABLE_CUE_RE,
  NORMATIVE_OR_CURRENT_CLAIM_RE,
  clauseMatchesSource,
  conflictForPair,
  extractBooleanSwitches,
  extractCliFlags,
  lineFactsPreservedIn,
  normativeSourceSegments,
  queryFeatureTokens,
  sharesPreservedCliOrBoolPolarity,
  subQueriesForLine,
} from './polarity.js';
import { auditInstructionProvenance } from './provenance.js';

const ACTIVE_FILES_TAG_RE = /<active-workspace-files\b[^>]*>[\s\S]*?<\/active-workspace-files>/gi;

function pushIndexEntry(map, key, value, deduplicate = false) {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  if (!deduplicate || !arr.includes(value)) arr.push(value);
}

function numberedScopesList(text) {
  const out = [];
  for (const scope of scopeSetOf(text)) {
    if (/\d/.test(scope)) out.push(scope);
  }
  return out;
}

function numberedScopesListCompatible(sourceScopes, candidateScopes) {
  return sourceScopes.length === 0 || candidateScopes.length === 0 ||
    (sourceScopes.length === candidateScopes.length && sourceScopes.every((scope) => candidateScopes.includes(scope)));
}

function sameTokenSet(a, b) {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const tok of a) {
    if (!b.has(tok)) return false;
  }
  return true;
}

function getVerifiedExactOwnerIds(ci, cm, memo) {
  if (cm.verifiedExactOwnerIds !== null) return cm.verifiedExactOwnerIds;
  const rawOwners = cm.exactOwnerLineIds;
  if (!rawOwners || rawOwners.length === 0) {
    cm.verifiedExactOwnerIds = [];
    return cm.verifiedExactOwnerIds;
  }
  const verified = [];
  for (let i = 0; i < rawOwners.length; i += 1) {
    const ownerId = rawOwners[i];
    if (memo.getConflict(ownerId, ci) === null) verified.push(ownerId);
  }
  cm.verifiedExactOwnerIds = verified;
  return verified;
}

function buildSummaryIndex(summaryClauses, limit) {
  const clauseCount = summaryClauses.length;
  const useCandidateIndex = clauseCount >= 12 && limit >= 0.25;
  const clausesByFeat = useCandidateIndex ? new Map() : null;
  const clausesByScalarSubject = useCandidateIndex ? new Map() : null;
  const clausesByActionKey = useCandidateIndex ? new Map() : null;
  const clausesByBoolKey = useCandidateIndex ? new Map() : null;
  const clausesByFlagStem = useCandidateIndex ? new Map() : null;
  const clausesByCanonFact = useCandidateIndex ? new Map() : null;
  const alwaysCheckClauses = useCandidateIndex ? [] : null;
  const exactClauseIndicesByNorm = new Map();

  const clauseMeta = summaryClauses.map((text, ci) => {
    const norm = normalize(text);
    const clean = stripSeqCitations(text);
    const cleanNorm = normalize(clean);
    const featSet = useCandidateIndex ? queryFeatureTokens(cleanNorm || norm) : null;
    const cNums = numericFacts(text);
    if (cleanNorm) pushIndexEntry(exactClauseIndicesByNorm, cleanNorm, ci, true);
    if (norm && norm !== cleanNorm) pushIndexEntry(exactClauseIndicesByNorm, norm, ci, true);
    if (useCandidateIndex) {
      if (norm.length === 0 || norm.length > 2048 || DISABLE_ENABLE_CUE_RE.test(norm)) {
        alwaysCheckClauses.push(ci);
      }
      for (const feat of featSet) pushIndexEntry(clausesByFeat, feat, ci);
      const cStripped = stripExplicitValueCorrection(clean.replace(/^\s*(?:[-*•+]|\d+[.)])\s+/, '').trim());
      const cScalar = scalarRequirement(cStripped);
      if (cScalar?.subject) pushIndexEntry(clausesByScalarSubject, cScalar.subject, ci);
      const cAct = actionState(text) ?? actionState(clean);
      if (cAct?.key) pushIndexEntry(clausesByActionKey, cAct.key, ci);
      for (const seg of localPolaritySegments(text)) {
        const segAct = actionState(seg);
        if (segAct?.key) pushIndexEntry(clausesByActionKey, segAct.key, ci, true);
      }
      for (const k of extractBooleanSwitches(text).keys()) pushIndexEntry(clausesByBoolKey, k, ci);
      for (const stem of extractCliFlags(text).keys()) pushIndexEntry(clausesByFlagStem, stem, ci);
      for (const tok of cNums) {
        const cf = canonicalFactToken(tok);
        if (cf.includes(':')) pushIndexEntry(clausesByCanonFact, cf, ci, true);
      }
    }
    return {
      text,
      norm,
      clean,
      cleanNorm,
      featSet,
      cleanTokSet: null,
      cNums,
      numberedScopes: numberedScopesList(text),
      exactOwnerLineIds: null,
      verifiedExactOwnerIds: null,
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

  return {
    clauseCount,
    clauseMeta,
    useCandidateIndex,
    exactClauseIndicesByNorm,
    clausesByFeat,
    clausesByScalarSubject,
    clausesByActionKey,
    clausesByBoolKey,
    clausesByFlagStem,
    clausesByCanonFact,
    alwaysCheckClauses,
    candHitCounts: useCandidateIndex ? new Uint16Array(clauseCount) : null,
    candQueued: useCandidateIndex ? new Uint8Array(clauseCount) : null,
    candTouched: useCandidateIndex ? [] : null,
    candPool: useCandidateIndex ? [] : null,
  };
}

function createLineInterner() {
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
    lineMeta.push({
      line,
      norm,
      lineNoCorrection,
      srcNeg: ruleNegative(line),
      lineIsScalar: sScalar !== null,
      scalarSubject: sScalar?.subject ?? null,
      sNums: numericFacts(line),
      numsKey: canonicalNumsKey(line),
      numberedScopes: numberedScopesList(line),
      tokSet: null,
      minPeerNeeded: lineToks.length === 0 ? 0 : Math.max(1, Math.ceil(0.75 * lineToks.length) - (lineToks.length - lineUniqueLen)),
      factsPreservedInSummary: null,
      matchedIndices: null,
    });
    return id;
  };
  return { lineMeta, internLine };
}

function buildPeerLineIndex(allTrustedEntries, entryLineIds, lineMeta, clauseCount) {
  const uniqueLineCount = lineMeta.length;
  const usePeerEntryIndex = uniqueLineCount >= 12 && clauseCount >= 12;
  const lineIdsByFeat = usePeerEntryIndex ? new Map() : null;
  const alwaysCheckLineIds = usePeerEntryIndex ? [] : null;
  let minPeerNeededFloor = Infinity;
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
      if (lm.minPeerNeeded < minPeerNeededFloor) minPeerNeededFloor = lm.minPeerNeeded;
      for (const feat of queryFeatureTokens(lm.norm)) {
        pushIndexEntry(lineIdsByFeat, feat, lid);
      }
    }
  }
  const lineEntriesByLineId = usePeerEntryIndex ? Array.from({ length: uniqueLineCount }, () => []) : null;
  if (usePeerEntryIndex) {
    for (let pi = 0; pi < allTrustedEntries.length; pi += 1) {
      lineEntriesByLineId[entryLineIds[pi]].push(pi);
    }
  }
  return {
    usePeerEntryIndex,
    lineIdsByFeat,
    alwaysCheckLineIds,
    minPeerNeededFloor: Number.isFinite(minPeerNeededFloor) ? minPeerNeededFloor : 1,
    lineEntriesByLineId,
    peerLineHitCounts: usePeerEntryIndex ? new Uint16Array(uniqueLineCount) : null,
    peerLineQueued: usePeerEntryIndex ? new Uint8Array(uniqueLineCount) : null,
    peerLineTouched: usePeerEntryIndex ? [] : null,
    peerLinePool: usePeerEntryIndex ? [] : null,
  };
}

function createPairMemo(lineMeta, clauseMeta, limit) {
  const clauseCount = clauseMeta.length;
  const totalSlots = lineMeta.length * clauseCount;
  const useFlatMemo = totalSlots > 0 && totalSlots <= 250000;

  const conflictFlat = useFlatMemo ? new Array(totalSlots).fill(false) : null;
  const conflictSparse = useFlatMemo ? null : new Map();
  const scopeFlat = useFlatMemo ? new Uint8Array(totalSlots) : null;
  const scopeSparse = useFlatMemo ? null : new Map();
  const scalarFlat = useFlatMemo ? new Uint8Array(totalSlots) : null;
  const scalarSparse = useFlatMemo ? null : new Map();
  const covLineInNormFlat = useFlatMemo ? new Float64Array(totalSlots).fill(-1) : null;
  const covLineInNormSparse = useFlatMemo ? null : new Map();
  const covLineInCleanFlat = useFlatMemo ? new Float64Array(totalSlots).fill(-1) : null;
  const covLineInCleanSparse = useFlatMemo ? null : new Map();
  const covCleanInLineFlat = useFlatMemo ? new Float64Array(totalSlots).fill(-1) : null;
  const covCleanInLineSparse = useFlatMemo ? null : new Map();

  const memoFloat = (flat, sparse, slot, compute) => {
    if (useFlatMemo) {
      const cached = flat[slot];
      if (cached >= 0) return cached;
      const v = compute();
      flat[slot] = v;
      return v;
    }
    if (sparse.has(slot)) return sparse.get(slot);
    const v = compute();
    sparse.set(slot, v);
    return v;
  };

  return {
    getConflict(lineId, ci) {
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
    },
    getScopes(lineId, ci) {
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
    },
    getScalarMatch(lineId, ci) {
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
    },
    getCovLineInNorm: (lineId, ci) =>
      memoFloat(covLineInNormFlat, covLineInNormSparse, lineId * clauseCount + ci, () =>
        coverageOf(lineMeta[lineId].line, clauseMeta[ci].norm),
      ),
    getCovLineInClean: (lineId, ci) =>
      memoFloat(covLineInCleanFlat, covLineInCleanSparse, lineId * clauseCount + ci, () =>
        coverageOf(lineMeta[lineId].line, clauseMeta[ci].cleanNorm),
      ),
    getCovCleanInLine: (lineId, ci) =>
      memoFloat(covCleanInLineFlat, covCleanInLineSparse, lineId * clauseCount + ci, () =>
        coverageOf(clauseMeta[ci].clean, lineMeta[lineId].norm),
      ),
  };
}

// Pigeonhole-sound frequent posting skip: skip up to `minRequiredHits - 1`
// ultra-frequent lists so any candidate meeting `minRequiredHits` must still hit >= 1 kept list.
function selectiveFeaturePostings(features, minRequiredHits, index, corpusSize) {
  const maxFrequent = Math.max(24, Math.floor(corpusSize * 0.45));
  const lists = [];
  for (const feature of features) {
    const list = index.get(feature);
    if (list) lists.push(list);
  }
  const maxSkip = Math.max(0, Math.min(lists.length - 1, Math.floor(minRequiredHits) - 1));
  if (maxSkip === 0 || lists.length <= 1) return { lists, skipped: 0 };
  lists.sort((a, b) => a.length - b.length);
  if (lists[0].length > maxFrequent) return { lists, skipped: 0 };
  let skipped = 0;
  while (skipped < maxSkip && lists.length > 1 && lists[lists.length - 1].length > maxFrequent) {
    lists.pop();
    skipped += 1;
  }
  return { lists, skipped };
}

function collectCandidateClauseIndices(lm, idx, limit) {
  if (!idx.useCandidateIndex || lm.norm.length > 2048 || DISABLE_ENABLE_CUE_RE.test(lm.norm)) {
    return null;
  }
  const subQueries = subQueriesForLine(lm.line, limit);
  if (!subQueries || subQueries.length === 0) return null;
  const { candPool, candQueued, candHitCounts, candTouched } = idx;
  candPool.length = 0;
  const queueList = (list) => {
    if (!list) return;
    for (let i = 0; i < list.length; i += 1) {
      const ci = list[i];
      if (!candQueued[ci]) {
        candQueued[ci] = 1;
        candPool.push(ci);
      }
    }
  };

  queueList(idx.alwaysCheckClauses);
  if (lm.scalarSubject) queueList(idx.clausesByScalarSubject.get(lm.scalarSubject));
  const checkAction = (actText) => {
    const act = actionState(actText);
    if (act?.key) queueList(idx.clausesByActionKey.get(act.key));
  };
  checkAction(lm.line);
  const cond = conditionParts(lm.line);
  if (cond?.consequence) checkAction(cond.consequence);
  for (const seg of normativeSourceSegments(lm.line)) checkAction(seg);
  for (const k of extractBooleanSwitches(lm.line).keys()) queueList(idx.clausesByBoolKey.get(k));
  for (const stem of extractCliFlags(lm.line).keys()) queueList(idx.clausesByFlagStem.get(stem));
  for (const tok of lm.sNums) {
    const cf = canonicalFactToken(tok);
    if (cf.includes(':')) queueList(idx.clausesByCanonFact.get(cf));
  }

  for (let qi = 0; qi < subQueries.length; qi += 1) {
    const { text, needed } = subQueries[qi];
    const feats = queryFeatureTokens(text);
    if (feats.size === 0) continue;
    candTouched.length = 0;
    const postings = selectiveFeaturePostings(feats, needed, idx.clausesByFeat, idx.clauseCount);
    const selectiveNeeded = Math.max(1, needed - postings.skipped);
    for (const list of postings.lists) {
      for (let i = 0; i < list.length; i += 1) {
        const ci = list[i];
        const next = candHitCounts[ci] + 1;
        if (next === 1) candTouched.push(ci);
        candHitCounts[ci] = next;
      }
    }
    for (let i = 0; i < candTouched.length; i += 1) {
      const ci = candTouched[i];
      if (candHitCounts[ci] >= selectiveNeeded && !candQueued[ci]) {
        candQueued[ci] = 1;
        candPool.push(ci);
      }
      candHitCounts[ci] = 0;
    }
  }
  for (let i = 0; i < candPool.length; i += 1) candQueued[candPool[i]] = 0;
  candPool.sort((a, b) => a - b);
  return candPool;
}

function recordTop2Peer(top, line, val) {
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
}

function buildPeerIndexForClause(ci, { clauseMeta, allTrustedEntries, entryLineIds, lineMeta, peerIdx, memo, limit }) {
  const explicitMinCov = Math.max(limit, 0.75);
  const cm = clauseMeta[ci];
  const candSeqs = cm.seqs;
  const verifiedExactOwners = getVerifiedExactOwnerIds(ci, cm, memo);
  if (verifiedExactOwners.length > 0 && peerIdx.lineEntriesByLineId) {
    const explicitEntries = [];
    const topForward = [];
    const topReverse = [];
    let ownersHaveValidExact = true;
    for (let oi = 0; oi < verifiedExactOwners.length; oi += 1) {
      const ownerId = verifiedExactOwners[oi];
      const ownerCov = memo.getCovLineInClean(ownerId, ci);
      const candInOwner = memo.getCovCleanInLine(ownerId, ci);
      if (ownerCov < 0.85 || candInOwner < 0.85) {
        ownersHaveValidExact = false;
        break;
      }
      const entryIndices = peerIdx.lineEntriesByLineId[ownerId];
      for (let j = 0; j < entryIndices.length; j += 1) {
        const peerEntry = allTrustedEntries[entryIndices[j]];
        if (candSeqs.size > 0 && candSeqs.has(peerEntry.seq) && ownerCov >= explicitMinCov) {
          explicitEntries.push({ seq: peerEntry.seq, line: peerEntry.line });
        }
        recordTop2Peer(topForward, peerEntry.line, ownerCov);
        recordTop2Peer(topReverse, peerEntry.line, candInOwner);
      }
    }
    if (ownersHaveValidExact && (candSeqs.size === 0 || explicitEntries.length > 0 || topForward.length >= 2)) {
      return { explicitEntries, topForward, topReverse };
    }
  }
  const explicitEntries = [];
  const topForward = [];
  const topReverse = [];

  const checkPeerEntry = (pi) => {
    const pLineId = entryLineIds[pi];
    if (!memo.getScopes(pLineId, ci)) return;
    const peerCov = memo.getCovLineInClean(pLineId, ci);
    const candInPeer = memo.getCovCleanInLine(pLineId, ci);
    const peerEntry = allTrustedEntries[pi];
    const needExplicit = candSeqs.size > 0 && candSeqs.has(peerEntry.seq) && peerCov >= explicitMinCov;
    const needForward = peerCov >= 0.85;
    const needReverse = candInPeer >= 0.85;
    if (!needExplicit && !needForward && !needReverse) return;
    if (memo.getConflict(pLineId, ci) !== null) return;
    if (needExplicit) explicitEntries.push({ seq: peerEntry.seq, line: peerEntry.line });
    if (needForward) recordTop2Peer(topForward, peerEntry.line, peerCov);
    if (needReverse) recordTop2Peer(topReverse, peerEntry.line, candInPeer);
  };

  const cleanToks = coverageTokens(cm.clean);
  const canFilterPeers =
    peerIdx.usePeerEntryIndex &&
    cm.cleanNorm.length > 0 &&
    cm.cleanNorm.length <= 2048 &&
    cleanToks.length > 0 &&
    !cleanToks.every((t) => t.length === 1 && !ASCII_TOKEN_RE.test(t));

  if (!canFilterPeers) {
    for (let pi = 0; pi < allTrustedEntries.length; pi += 1) checkPeerEntry(pi);
  } else {
    const { peerLineHitCounts, peerLineQueued, peerLineTouched, peerLinePool } = peerIdx;
    const candUniqueLen = new Set(cleanToks).size;
    const neededCand = Math.max(1, Math.ceil(0.85 * cleanToks.length) - (cleanToks.length - candUniqueLen));
    const cFeats = cm.featSet ?? queryFeatureTokens(cm.cleanNorm || cm.norm);
    peerLineTouched.length = 0;
    peerLinePool.length = 0;
    const peerMinRequired = Math.min(peerIdx.minPeerNeededFloor, neededCand);
    const postings = selectiveFeaturePostings(cFeats, peerMinRequired, peerIdx.lineIdsByFeat, lineMeta.length);
    for (const list of postings.lists) {
      for (let i = 0; i < list.length; i += 1) {
        const lid = list[i];
        const next = peerLineHitCounts[lid] + 1;
        if (next === 1) peerLineTouched.push(lid);
        peerLineHitCounts[lid] = next;
      }
    }
    for (let i = 0; i < peerIdx.alwaysCheckLineIds.length; i += 1) {
      const lid = peerIdx.alwaysCheckLineIds[i];
      if (!peerLineQueued[lid]) {
        peerLineQueued[lid] = 1;
        peerLinePool.push(lid);
      }
    }
    for (let i = 0; i < peerLineTouched.length; i += 1) {
      const lid = peerLineTouched[i];
      const hits = peerLineHitCounts[lid];
      peerLineHitCounts[lid] = 0;
      if (hits >= Math.max(1, Math.min(lineMeta[lid].minPeerNeeded, neededCand) - postings.skipped) && !peerLineQueued[lid]) {
        peerLineQueued[lid] = 1;
        peerLinePool.push(lid);
      }
    }
    for (let i = 0; i < peerLinePool.length; i += 1) {
      const lid = peerLinePool[i];
      peerLineQueued[lid] = 0;
      const entryIndices = peerIdx.lineEntriesByLineId[lid];
      for (let j = 0; j < entryIndices.length; j += 1) checkPeerEntry(entryIndices[j]);
    }
  }
  return { explicitEntries, topForward, topReverse };
}

function isConflictOwnedByPeer({
  ci,
  lineId,
  lm,
  cm,
  messageSeq,
  matchedIndices,
  hasCleanActiveMatch,
  peerIndex,
  memo,
  summaryProseText,
  summaryProseNorm,
}) {
  const line = lm.line;
  const candSeqs = cm.seqs;
  if (hasCleanActiveMatch && peerIndex.explicitEntries.length > 0 && !candSeqs.has(messageSeq)) {
    for (const p of peerIndex.explicitEntries) {
      if (p.seq !== messageSeq && p.line !== line) return true;
    }
  }
  const lineCov = memo.getCovLineInClean(lineId, ci);
  const candInLine = memo.getCovCleanInLine(lineId, ci);
  const bestF = peerIndex.topForward.find((p) => p.line !== line);
  const forwardBetter = Boolean(
    bestF &&
      (bestF.val >= lineCov + 0.05 ||
        (hasCleanActiveMatch && bestF.val > lineCov && (bestF.val >= 0.98 || bestF.val >= lineCov + 0.02))),
  );
  let reverseBetter = false;
  if (!forwardBetter) {
    const bestR = peerIndex.topReverse.find((p) => p.line !== line);
    reverseBetter = Boolean(
      bestR &&
        (bestR.val >= candInLine + 0.05 ||
          (hasCleanActiveMatch && bestR.val > candInLine && (bestR.val >= 0.98 || bestR.val >= candInLine + 0.02))),
    );
  }
  if (!(forwardBetter || reverseBetter)) return false;
  if (lm.factsPreservedInSummary === null) {
    lm.factsPreservedInSummary = lineFactsPreservedIn(line, summaryProseText, summaryProseNorm);
  }
  if (!lm.factsPreservedInSummary) return false;
  if (hasCleanActiveMatch) return true;
  for (const oci of matchedIndices) {
    if (memo.getConflict(lineId, oci) === null) return true;
  }
  return false;
}

function hasAlternativeCoverage(line, lineId, lm, clauseMeta, memo, limit) {
  const sNums = lm.sNums;
  const srcNeg = lm.srcNeg;
  const lineHasCond = conditionParts(line) !== null;
  const lineNonQuant = sNums.length > 0 && !lineHasCond ? stripQuantityTokens(line) : '';
  const lineNonQuantTokens = lineNonQuant ? coverageTokens(lineNonQuant) : [];
  const lineHasCliOrBool = !lineHasCond && (extractCliFlags(line).size > 0 || extractBooleanSwitches(line).size > 0);
  for (let ci = 0; ci < clauseMeta.length; ci += 1) {
    const cm = clauseMeta[ci];
    if (
      lm.numsKey === cm.numsKey &&
      srcNeg !== cm.neg &&
      memo.getScopes(lineId, ci) &&
      equivalentAntonymPolarity(line, cm.text, srcNeg, cm.neg, limit)
    ) {
      return true;
    }
    if (!lineHasCond) {
      if (
        sNums.length > 0 &&
        srcNeg === cm.neg &&
        cm.cNums.length > 0 &&
        numericFactsEquivalent(line, cm.text, sNums, cm.cNums) &&
        memo.getScopes(lineId, ci) &&
        memo.getConflict(lineId, ci) === null &&
        (memo.getScalarMatch(lineId, ci) === 'match' ||
          (lineNonQuantTokens.length > 0 && coverageOf(lineNonQuant, cm.norm) >= limit))
      ) {
        return true;
      }
      if (
        lineHasCliOrBool &&
        sharesPreservedCliOrBoolPolarity(line, cm.text) &&
        memo.getScopes(lineId, ci) &&
        memo.getConflict(lineId, ci) === null
      ) {
        return true;
      }
    }
  }
  return false;
}

function evaluateRequirementLine(message, line, ctx) {
  const { idx, internLine, lineMeta, memo, getPeerIndex, haystack, summaryProseText, summaryProseNorm, limit, includeAllConflicts } = ctx;
  const { clauseMeta, clauseCount } = idx;
  const lineId = internLine(line);
  const lm = lineMeta[lineId];
  const lineNoCorrection = lm.lineNoCorrection;
  let coverage = Math.max(
    coverageOf(line, haystack),
    lineNoCorrection !== line ? coverageOf(lineNoCorrection, haystack) : 0,
  );
  const lineIsScalar = lm.lineIsScalar;

  if (lm.matchedIndices === null) {
    let canSkipPeerOwnedExactState = clauseCount >= 12 ? null : false;
    const canSkipPeerOwnedExact = () => {
      if (canSkipPeerOwnedExactState !== null) return canSkipPeerOwnedExactState;
      const exactCandidates = idx.exactClauseIndicesByNorm.get(lm.norm);
      let preExactActiveMatch = false;
      if (exactCandidates) {
        for (let ei = 0; ei < exactCandidates.length; ei += 1) {
          const exactCi = exactCandidates[ei];
          if (
            memo.getCovLineInNorm(lineId, exactCi) >= Math.max(limit, 0.8) &&
            memo.getConflict(lineId, exactCi) === null &&
            (!lineIsScalar || memo.getScalarMatch(lineId, exactCi) === 'match')
          ) {
            preExactActiveMatch = true;
            break;
          }
        }
      }
      canSkipPeerOwnedExactState =
        preExactActiveMatch &&
        (lm.factsPreservedInSummary ??= lineFactsPreservedIn(line, summaryProseText, summaryProseNorm)) === true;
      return canSkipPeerOwnedExactState;
    };
    const indices = [];
    const candList = collectCandidateClauseIndices(lm, idx, limit);
    const checkCandidate = (ci) => {
      const cm = clauseMeta[ci];
      if (!numberedScopesListCompatible(lm.numberedScopes, cm.numberedScopes)) return;
      if (cm.exactOwnerLineIds !== null && cm.exactOwnerLineIds.some((id) => id !== lineId) && canSkipPeerOwnedExact()) {
        const verifiedOwners = getVerifiedExactOwnerIds(ci, cm, memo);
        let hasDistinctOwner = false;
        for (let oi = 0; oi < verifiedOwners.length; oi += 1) {
          if (verifiedOwners[oi] !== lineId) {
            hasDistinctOwner = true;
            break;
          }
        }
        if (
          hasDistinctOwner &&
          (!lineIsScalar || !lm.scalarSubject || !cm.cleanNorm.includes(lm.scalarSubject)) &&
          !sameTokenSet((lm.tokSet ??= new Set(coverageTokens(line))), (cm.cleanTokSet ??= new Set(coverageTokens(cm.clean)))) &&
          cm.cleanTokSet.size > 0
        ) {
          return;
        }
      }
      if (clauseMatchesSource(line, cm.text, limit)) indices.push(ci);
    };
    if (candList === null) {
      for (let ci = 0; ci < clauseCount; ci += 1) checkCandidate(ci);
    } else {
      for (let k = 0; k < candList.length; k += 1) checkCandidate(candList[k]);
    }
    lm.matchedIndices = indices;
  }
  const matchedIndices = lm.matchedIndices;

  const exactCovThresh = Math.max(limit, 0.8);
  const cleanCovThresh = Math.max(limit, 0.72);
  let hasExactActiveMatch = false;
  for (const ci of matchedIndices) {
    if (
      memo.getCovLineInNorm(lineId, ci) >= exactCovThresh &&
      memo.getConflict(lineId, ci) === null &&
      (!lineIsScalar || memo.getScalarMatch(lineId, ci) === 'match')
    ) {
      hasExactActiveMatch = true;
      break;
    }
  }
  let hasCleanActiveMatch = hasExactActiveMatch;
  if (!hasCleanActiveMatch) {
    for (const ci of matchedIndices) {
      if (
        memo.getCovLineInClean(lineId, ci) >= cleanCovThresh &&
        memo.getConflict(lineId, ci) === null &&
        (!lineIsScalar || memo.getScalarMatch(lineId, ci) === 'match')
      ) {
        hasCleanActiveMatch = true;
        break;
      }
    }
  }

  const conflicts = [];
  for (const ci of matchedIndices) {
    const conflict = memo.getConflict(lineId, ci);
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
    if (memo.getScalarMatch(lineId, ci) === 'mismatch') {
      conflicts.push(conflict);
      continue;
    }
    const owned = isConflictOwnedByPeer({
      ci,
      lineId,
      lm,
      cm,
      messageSeq: message.seq,
      matchedIndices,
      hasCleanActiveMatch,
      peerIndex: getPeerIndex(ci),
      memo,
      summaryProseText,
      summaryProseNorm,
    });
    if (!owned) conflicts.push(conflict);
  }

  if (coverage < limit && conflicts.length === 0 && hasAlternativeCoverage(line, lineId, lm, clauseMeta, memo, limit)) {
    coverage = 1;
  }

  if (conflicts.length > 0) {
    const primary = conflicts[0];
    return {
      coverage,
      isPolarity: primary.reason === 'polarity',
      loss: {
        seq: message.seq,
        line,
        candidate: primary.candidate,
        coverage: Number(coverage.toFixed(3)),
        reason: primary.reason,
        ...(includeAllConflicts ? { conflicts } : {}),
      },
    };
  }
  if (coverage < limit) {
    return {
      coverage,
      isPolarity: false,
      loss: {
        seq: message.seq,
        line,
        coverage: Number(coverage.toFixed(3)),
        reason: 'coverage',
      },
    };
  }
  return { coverage, isPolarity: false, loss: null };
}

/** Audit compacted summary/checkpoint prose against source user constraints and instruction provenance. */
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

  const idx = buildSummaryIndex(summaryClauses, limit);
  const { lineMeta, internLine } = createLineInterner();
  const entryLineIds = allTrustedEntries.map((entry) => internLine(entry.line));
  const exactLineIdsByNorm = new Map();
  for (let lid = 0; lid < lineMeta.length; lid += 1) {
    const norm = lineMeta[lid].norm;
    if (norm) pushIndexEntry(exactLineIdsByNorm, norm, lid);
  }
  for (let ci = 0; ci < idx.clauseMeta.length; ci += 1) {
    const cm = idx.clauseMeta[ci];
    if (cm.cleanNorm) cm.exactOwnerLineIds = exactLineIdsByNorm.get(cm.cleanNorm) ?? null;
  }
  const peerIdx = buildPeerLineIndex(allTrustedEntries, entryLineIds, lineMeta, idx.clauseCount);
  const memo = createPairMemo(lineMeta, idx.clauseMeta, limit);
  const peerIndexByCi = new Array(idx.clauseCount);
  const getPeerIndex = (ci) =>
    (peerIndexByCi[ci] ??= buildPeerIndexForClause(ci, {
      clauseMeta: idx.clauseMeta,
      allTrustedEntries,
      entryLineIds,
      lineMeta,
      peerIdx,
      memo,
      limit,
    }));

  const ctx = { idx, internLine, lineMeta, memo, getPeerIndex, haystack, summaryProseText, summaryProseNorm, limit, includeAllConflicts };
  const lost = [];
  let checked = 0;
  let worst = 1;
  let polarityFlips = 0;

  for (const { message, lines } of messageLines) {
    for (const line of lines) {
      checked += 1;
      const outcome = evaluateRequirementLine(message, line, ctx);
      worst = Math.min(worst, outcome.coverage);
      if (outcome.isPolarity) polarityFlips += 1;
      if (outcome.loss) lost.push(outcome.loss);
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
