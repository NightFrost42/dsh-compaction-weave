// Zero-I/O bilingual (CJK + ASCII/code) BM25F + exact-phrase archive search engine.
import { extractSalientProse } from './tool-preview.js';

const CJK_RUN_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7a3]+/g;
const IDENT_RE = /[A-Za-z0-9]+(?:(?:[:]{2}|[._:/-])[A-Za-z0-9]+)*/g;
const SEGMENT_SPLIT_RE = /::|[/.:_-]/;

const CJK_STOPWORDS = new Set(
  '的了着过地得吗呢吧啊呀哦嘛之个些这那其此于与及和或而在是有为以从向把被让给就都也还又很',
);

const ENGLISH_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'it', 'its',
  'this', 'that', 'these', 'those', 'we', 'you', 'he', 'she', 'they', 'i',
  'my', 'our', 'your', 'has', 'have', 'had', 'do', 'does', 'did',
  'into', 'about', 'over', 'after', 'before', 'between', 'through', 'during',
  'without', 'would', 'could', 'should', 'can', 'may', 'might', 'must', 'will',
  'not', 'no', 'all', 'any', 'some', 'more', 'most', 'other', 'such', 'only',
  'just', 'also', 'even', 'still', 'very', 'really', 'actually', 'then', 'than',
  'there', 'here', 'what', 'when', 'where', 'which', 'who', 'why', 'how',
  'but', 'if', 'so', 'me', 'him', 'her', 'us', 'them', 'their', 'am', 'being',
]);

const PREFIX_WEIGHTS = Object.freeze({
  a: 1.0,
  b: 1.15,
  c: 0.85,
  s: 0.55,
});

const PURE_LOWER_WORD_RE = /^[a-z]{4,}$/;
const PURE_ALPHA_3PLUS_RE = /^[a-z]{3,}$/;
const HYPHEN_PAIR_RE = /\b([a-z]{2,})-([a-z]{2,})\b/g;

/**
 * Conservative English stemmer for lexical indexing (`[a-z]{4,}` -> stem >= 3 chars).
 * Handles conservative plurals, `-ies/-ied -> -y`, `-ing/-ed` (with vowel checks &
 * `[bdfglmnprt]` double-consonant reduction), `-ization`/`-tion`, and silent trailing `-e`.
 *
 * @param {string} word
 * @returns {string}
 */
export function lightEnglishStem(word) {
  if (typeof word !== 'string') return '';
  const orig = word.toLowerCase();
  if (!PURE_LOWER_WORD_RE.test(orig)) return orig;
  let w = orig;

  if (w.length >= 5 && (w.endsWith('ies') || w.endsWith('ied'))) {
    w = `${w.slice(0, -3)}y`;
  } else if (w.length >= 5 && /(?:sses|shes|ches|xes|zes)$/.test(w)) {
    w = w.slice(0, -2);
  } else if (
    w.length >= 4 &&
    w.endsWith('s') &&
    !w.endsWith('ss') &&
    !w.endsWith('us') &&
    !w.endsWith('is')
  ) {
    w = w.slice(0, -1);
  }

  let strippedVerb = false;
  if (w.length >= 5 && w.endsWith('ing')) {
    const base = w.slice(0, -3);
    if (base.length >= 3 && /[aeiouy]/.test(base)) {
      w = base;
      strippedVerb = true;
    }
  } else if (w.length >= 5 && w.endsWith('ed') && !w.endsWith('eed')) {
    const base = w.slice(0, -2);
    if (base.length >= 3 && /[aeiouy]/.test(base)) {
      w = base;
      strippedVerb = true;
    }
  }

  if (strippedVerb && w.length >= 4 && /([bdfglmnprt])\1$/.test(w)) {
    w = w.slice(0, -1);
  }

  if (w.length >= 9 && w.endsWith('ization')) {
    w = `${w.slice(0, -7)}iz`;
  } else if (w.length >= 8 && w.endsWith('tion')) {
    w = w.slice(0, -3);
  }

  if (
    w.length >= 5 &&
    w.endsWith('e') &&
    !/[aeiouy]e$/.test(w) &&
    /[aeiouy]/.test(w.slice(0, -1))
  ) {
    w = w.slice(0, -1);
  }

  return w.length >= 3 ? w : orig;
}

const FIELD_WEIGHTS = Object.freeze({
  user: 1.0,
  assistant: 0.72,
  tool: 0.45,
  causal: 0.35,
});

const FIELD_B = Object.freeze({
  user: 0.72,
  assistant: 0.75,
  tool: 0.65,
  causal: 0.65,
});

const BM25F_K1 = 1.5;
const MAX_CAUSAL_TOKENS = 24;
const MAX_CONTEXT_SNIPPET_CHARS = 48;
const MAX_ISOLATED_CHARS = 24;
const DEICTIC_FOLLOWUP_RE =
  /这|那|该|此|它|上述|上面|前面|同样|照旧|照此|按此|改成|改为|换成|调成|调到|设为|加到|减到|改回|同意|确认|好的|行吧|可以|不要|\b(?:it|its|this|that|these|those|same|above|former|instead|otherwise|confirm|agreed|yes|ok|okay)\b/i;

function isDeicticFollowUp(primary, role, effectiveChars) {
  if (effectiveChars <= 0) return false;
  if (DEICTIC_FOLLOWUP_RE.test(primary)) return true;
  return role === 'user' && effectiveChars <= 6;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function splitCamelAndDigits(segment) {
  const camelSplit = segment
    .replace(/([a-z0-9])([A-Z])/g, '$1\0$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1\0$2')
    .split('\0')
    .filter(Boolean);

  const out = [];
  for (const part of camelSplit) {
    const ldParts = part
      .replace(/([A-Za-z])(\d)/g, '$1\0$2')
      .replace(/(\d)([A-Za-z])/g, '$1\0$2')
      .split('\0')
      .filter(Boolean);
    if (ldParts.length <= 1) {
      out.push(part);
      continue;
    }
    for (const sub of ldParts) {
      if (sub.length >= 2 || /^\d+$/.test(sub)) {
        out.push(sub);
      }
    }
  }
  return out;
}

function emitWordAndStem(emit, lower, filterStopwords) {
  if (!lower || (filterStopwords && ENGLISH_STOPWORDS.has(lower))) return;
  emit(`a${lower}`);
  if (PURE_ALPHA_3PLUS_RE.test(lower)) {
    emit(`s${lightEnglishStem(lower)}`);
  }
}

function collectTokens(text, filterStopwords) {
  const tokens = [];
  if (typeof text !== 'string' || !text) return tokens;

  for (const m of text.matchAll(CJK_RUN_RE)) {
    const run = m[0];
    if (run.length === 1) {
      if (!filterStopwords || !CJK_STOPWORDS.has(run)) {
        tokens.push(`c${run}`);
      }
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      tokens.push(`b${run[i]}${run[i + 1]}`);
    }
    for (let i = 0; i < run.length; i += 1) {
      const ch = run[i];
      if (!filterStopwords || !CJK_STOPWORDS.has(ch)) {
        tokens.push(`c${ch}`);
      }
    }
  }

  for (const m of text.matchAll(IDENT_RE)) {
    const raw = m[0];
    const emittedThisMatch = new Set();
    const emit = (tok) => {
      if (!emittedThisMatch.has(tok)) {
        emittedThisMatch.add(tok);
        tokens.push(tok);
      }
    };

    const fullLower = raw.toLowerCase();
    emitWordAndStem(emit, fullLower, filterStopwords);

    const segments = raw.split(SEGMENT_SPLIT_RE).filter(Boolean);
    for (const seg of segments) {
      const segLower = seg.toLowerCase();
      emitWordAndStem(emit, segLower, filterStopwords);
      const subwords = splitCamelAndDigits(seg);
      for (const sub of subwords) {
        emitWordAndStem(emit, sub.toLowerCase(), filterStopwords);
      }
    }

    HYPHEN_PAIR_RE.lastIndex = 0;
    for (const hm of fullLower.matchAll(HYPHEN_PAIR_RE)) {
      const joined = `${hm[1]}${hm[2]}`;
      if (!filterStopwords || !ENGLISH_STOPWORDS.has(joined)) {
        emit(`a${joined}`);
        if (PURE_ALPHA_3PLUS_RE.test(joined)) {
          emit(`s${lightEnglishStem(joined)}`);
        }
      }
    }
  }

  return tokens;
}

/**
 * Tokenize CJK runs (2-char bigrams + content unigrams) and ASCII/code identifiers
 * (`::`, `/`, `.`, `-`, `_`, `camelCase`, `PascalCase`, letter-digit boundaries).
 *
 * @param {string} text
 * @param {{ filterStopwords?: boolean, isQuery?: boolean }} [options]
 * @returns {string[]}
 */
export function tokenizeForSearch(text, options = {}) {
  const { filterStopwords = true, isQuery = false } = options ?? {};
  const tokens = collectTokens(text, Boolean(filterStopwords));
  if (isQuery && filterStopwords && tokens.length === 0) {
    return collectTokens(text, false);
  }
  return tokens;
}

function addTokensToTf(tfMap, tokens) {
  for (const tok of tokens) {
    tfMap.set(tok, (tfMap.get(tok) ?? 0) + 1);
  }
}

function collectCallIds(entry) {
  const ids = new Set();
  const pushId = (val) => {
    if (typeof val === 'string' && val.length > 0) ids.add(val);
  };
  const inspectToolRef = (ref) => {
    if (!ref || typeof ref !== 'object') return;
    pushId(ref.callId);
    pushId(ref.toolCallId);
    pushId(ref.id);
  };

  if (Array.isArray(entry?.tool)) {
    for (const ref of entry.tool) inspectToolRef(ref);
  } else if (entry?.tool && typeof entry.tool === 'object') {
    inspectToolRef(entry.tool);
  }
  if (Array.isArray(entry?.blocks)) {
    for (const block of entry.blocks) inspectToolRef(block);
  }
  pushId(entry?.event?.data?.callId);
  pushId(entry?.event?.data?.message?.toolCallId);
  pushId(entry?.event?.data?.message?.source?.callId);
  return [...ids];
}

function buildCausalTokens(precedingPrimaryTokenLists) {
  const nonUnigram = [];
  const unigram = [];
  const seen = new Set();
  for (const list of precedingPrimaryTokenLists) {
    for (const tok of list) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      if (tok.startsWith('c')) unigram.push(tok);
      else nonUnigram.push(tok);
    }
  }
  const combined = [...nonUnigram, ...unigram].slice(0, MAX_CAUSAL_TOKENS);
  const tf = new Map();
  for (const tok of combined) {
    tf.set(tok, 1);
  }
  return tf;
}

function defaultExcerptAround(text, at, length) {
  const pad = 120;
  const from = Math.max(0, at - pad);
  const to = Math.min(text.length, at + length + pad);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < text.length ? '…' : '';
  return prefix + text.slice(from, to).replace(/\s+/g, ' ') + suffix;
}

/**
 * Preprocess a span's entries into zero-I/O searchable field structures.
 *
 * @param {{ compactionId: string, entries: object[], incomplete?: string | null }} span
 * @returns {object}
 */
export function prepareSpanForSearch({ compactionId, entries, incomplete = null }) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const docs = [];
  const primaryTokensByIndex = new Array(safeEntries.length);
  let lastNonEmptySnippet = '';

  for (let i = 0; i < safeEntries.length; i += 1) {
    const entry = safeEntries[i] ?? {};
    const seq = entry.seq;
    const role = entry.role;
    const primary = typeof entry.text === 'string' ? entry.text : '';
    const meta = [
      safeJsonStringify(entry?.blocks ?? []),
      safeJsonStringify(entry?.source ?? {}),
      safeJsonStringify(entry?.tool ?? []),
    ].join('\n');

    const primaryTokens = tokenizeForSearch(primary, { filterStopwords: true });
    const metaTokens = tokenizeForSearch(meta, { filterStopwords: true });
    primaryTokensByIndex[i] = primaryTokens;

    const userTf = new Map();
    const assistantTf = new Map();
    const toolTf = new Map();
    let userLen = 0;
    let assistantLen = 0;
    let toolLen = 0;

    if (role === 'user') {
      addTokensToTf(userTf, primaryTokens);
      userLen = primaryTokens.length;
      addTokensToTf(toolTf, metaTokens);
      toolLen = metaTokens.length;
    } else if (role === 'assistant') {
      addTokensToTf(assistantTf, primaryTokens);
      assistantLen = primaryTokens.length;
      addTokensToTf(toolTf, metaTokens);
      toolLen = metaTokens.length;
    } else {
      addTokensToTf(toolTf, primaryTokens);
      addTokensToTf(toolTf, metaTokens);
      toolLen = primaryTokens.length + metaTokens.length;
    }

    const prevNonEmptySnippet = lastNonEmptySnippet;
    const trimmed = primary.trim();
    const effectiveChars = primary.replace(/\s+/g, '').length;

    // Collect tokens from up to 2 immediately preceding user/tool entries in the same span
    // when the current entry is a short or pronoun/deictic follow-up.
    const precedingLists = [];
    if (isDeicticFollowUp(primary, role, effectiveChars)) {
      for (let j = i - 1; j >= 0 && j >= i - 4 && precedingLists.length < 2; j -= 1) {
        const prevRole = safeEntries[j]?.role;
        if (prevRole === 'user' || prevRole === 'tool') {
          const list = primaryTokensByIndex[j];
          if (list && list.length > 0) precedingLists.push(list);
        }
      }
    }
    const causalTf = precedingLists.length > 0 ? buildCausalTokens(precedingLists) : new Map();
    const causalLen = causalTf.size;

    if (trimmed.length > 0) {
      const collapsed = primary.replace(/\s+/g, ' ').trim();
      lastNonEmptySnippet =
        collapsed.length > MAX_CONTEXT_SNIPPET_CHARS
          ? collapsed.slice(0, MAX_CONTEXT_SNIPPET_CHARS).trimEnd()
          : collapsed;
    }

    docs.push({
      compactionId,
      incomplete: incomplete ?? null,
      entryIndex: i,
      seq,
      role,
      primary,
      meta,
      primaryLower: primary.toLowerCase(),
      metaLower: meta.toLowerCase(),
      callIds: collectCallIds(entry),
      prevNonEmptySnippet,
      effectiveChars,
      trimmedLength: trimmed.length,
      userTf,
      assistantTf,
      toolTf,
      causalTf,
      userLen,
      assistantLen,
      toolLen,
      causalLen,
    });
  }

  return {
    compactionId,
    incomplete: incomplete ?? null,
    docs,
  };
}

function isAtomicCompoundIdentifier(rawQuery, queryTokens) {
  const trimmed = rawQuery.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(trimmed)) return false;
  if (!/^[A-Za-z0-9]+(?:(?:[:]{2}|[._:/-])[A-Za-z0-9]+)*$/.test(trimmed)) return false;
  const fullTok = `a${trimmed.toLowerCase()}`;
  const subtokens = queryTokens.filter((t) => t !== fullTok);
  return subtokens.length >= 2;
}

function compareRankedCandidates(a, b) {
  if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
  if (a.doc.spanIdx !== b.doc.spanIdx) return a.doc.spanIdx - b.doc.spanIdx;
  const aSeq = Number.isFinite(a.doc.seq) ? a.doc.seq : -Infinity;
  const bSeq = Number.isFinite(b.doc.seq) ? b.doc.seq : -Infinity;
  if (bSeq !== aSeq) return bSeq - aSeq;
  return a.matchAt - b.matchAt;
}

function aspectKeyOfToken(tok) {
  if (!tok || tok.length < 2) return tok;
  const prefix = tok[0];
  const body = tok.slice(1);
  if (prefix === 's') return `w:${body}`;
  if (prefix === 'a' && PURE_ALPHA_3PLUS_RE.test(body)) return `w:${lightEnglishStem(body)}`;
  return `${prefix}:${body}`;
}

function buildQueryAspectTable(rawQuery, queryTokens, postings, N) {
  const aspects = [];
  const aspectIndexByKey = new Map();
  const tokenToAspectIndices = new Array(queryTokens.length);
  const perAspectDocs = [];

  for (let qi = 0; qi < queryTokens.length; qi += 1) {
    const tok = queryTokens[qi];
    const key = aspectKeyOfToken(tok);
    let ai = aspectIndexByKey.get(key);
    if (ai === undefined) {
      ai = aspects.length;
      aspectIndexByKey.set(key, ai);
      aspects.push({ key, tokens: [], df: 0, idf: 0 });
      perAspectDocs.push(new Set());
    }
    aspects[ai].tokens.push(tok);
    tokenToAspectIndices[qi] = ai;
  }

  // Track hyphenated pair equivalence (`rate-limit` -> `w:ratelimit` covers `w:rate` + `w:limit` in Precision Guard).
  const hyphenCreditMap = new Map();
  const rawLower = rawQuery.toLowerCase();
  HYPHEN_PAIR_RE.lastIndex = 0;
  for (const hm of rawLower.matchAll(HYPHEN_PAIR_RE)) {
    const joinedKey = `w:${lightEnglishStem(`${hm[1]}${hm[2]}`)}`;
    const p1Key = `w:${lightEnglishStem(hm[1])}`;
    const p2Key = `w:${lightEnglishStem(hm[2])}`;
    const jIdx = aspectIndexByKey.get(joinedKey);
    const p1Idx = aspectIndexByKey.get(p1Key);
    const p2Idx = aspectIndexByKey.get(p2Key);
    if (jIdx !== undefined && (p1Idx !== undefined || p2Idx !== undefined)) {
      const list = [];
      if (p1Idx !== undefined && p1Idx !== jIdx) list.push(p1Idx);
      if (p2Idx !== undefined && p2Idx !== jIdx) list.push(p2Idx);
      if (list.length > 0) hyphenCreditMap.set(jIdx, list);
    }
  }

  const bm25Scores = new Float64Array(N);
  const bestTokenIdx = new Int32Array(N).fill(-1);
  const bestTokenWeight = new Float64Array(N);
  const docAspectSets = new Map();

  for (let qi = 0; qi < queryTokens.length; qi += 1) {
    const tok = queryTokens[qi];
    const posting = postings.get(tok);
    if (!posting) continue;
    const df = posting.length >>> 1;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const pw = PREFIX_WEIGHTS[tok[0]] ?? 1.0;
    const weightedIdf = idf * pw;
    const ai = tokenToAspectIndices[qi];
    const aspectDocs = perAspectDocs[ai];

    for (let k = 0; k < posting.length; k += 2) {
      const docId = posting[k];
      const tfTilde = posting[k + 1];
      const contrib = weightedIdf * ((tfTilde * (BM25F_K1 + 1)) / (tfTilde + BM25F_K1));
      bm25Scores[docId] += contrib;
      aspectDocs.add(docId);
      let aset = docAspectSets.get(docId);
      if (!aset) docAspectSets.set(docId, (aset = new Set()));
      aset.add(ai);
      if (weightedIdf > bestTokenWeight[docId]) {
        bestTokenWeight[docId] = weightedIdf;
        bestTokenIdx[docId] = qi;
      }
    }
  }

  for (let ai = 0; ai < aspects.length; ai += 1) {
    const df = perAspectDocs[ai].size;
    aspects[ai].df = df;
    aspects[ai].idf = df > 0 ? Math.log(1 + (N - df + 0.5) / (df + 0.5)) : 0;
  }

  return { aspects, aspectIndexByKey, hyphenCreditMap, bm25Scores, bestTokenIdx, docAspectSets };
}

function effectiveOverlapCount(docAspectSet, hyphenCreditMap) {
  if (!docAspectSet || docAspectSet.size === 0) return 0;
  if (hyphenCreditMap.size === 0) return docAspectSet.size;
  const credited = new Set(docAspectSet);
  for (const [jIdx, parts] of hyphenCreditMap) {
    if (docAspectSet.has(jIdx)) {
      for (const pIdx of parts) credited.add(pIdx);
    }
  }
  return credited.size;
}

function selectCrossSpanTwoHop({
  docs,
  postings,
  N,
  spanCount,
  atomicCompound,
  exactDocs,
  effectiveLimit,
  rankedDirect,
  bm25Scores,
  top1Bm25,
  queryTokens,
  aspectIndexByKey,
  passedDocSet,
  docAspectSets,
  aspects,
}) {
  if (N < 12 || spanCount < 2 || atomicCompound || exactDocs.size >= effectiveLimit || rankedDirect.length === 0) {
    return [];
  }
  if (top1Bm25 < 3.0) return [];

  const top5 = [0, 0, 0, 0, 0];
  for (let i = 0; i < N; i += 1) {
    const s = bm25Scores[i];
    if (s <= top5[4]) continue;
    top5[4] = s;
    for (let j = 4; j > 0 && top5[j] > top5[j - 1]; j -= 1) {
      const tmp = top5[j - 1];
      top5[j - 1] = top5[j];
      top5[j] = tmp;
    }
  }
  const top5Median = top5[2];
  const sharp = top5Median <= 0 ? top1Bm25 >= 3.0 : top1Bm25 / top5Median >= 1.45;
  if (!sharp) return [];

  const rareLimit = Math.max(8, Math.floor(N * 0.03));
  let rareQueryCount = 0;
  for (const a of aspects) {
    if (a.df > 0 && a.df <= rareLimit) rareQueryCount += 1;
  }
  if (rareQueryCount < 2) return [];

  const byBm25 = [];
  const seenDocIds = new Set();
  for (const cand of [...rankedDirect].sort((a, b) => b.bm25Score - a.bm25Score || b.totalScore - a.totalScore)) {
    if (seenDocIds.has(cand.doc.docId)) continue;
    seenDocIds.add(cand.doc.docId);
    byBm25.push(cand);
  }
  const seed1 = byBm25[0];
  if (!seed1 || seed1.bm25Score < 3.0) return [];
  const seeds = [seed1];
  if (byBm25[1] && byBm25[1].bm25Score >= 0.86 * seed1.bm25Score) {
    seeds.push(byBm25[1]);
  }
  const seedDocIds = new Set(seeds.map((s) => s.doc.docId));
  const seedSpanIndices = new Set(seeds.map((s) => s.doc.spanIdx));
  const lookAlikes = byBm25.slice(1, 10).filter((c) => !seedDocIds.has(c.doc.docId));

  const lookAlikeAspectCounts = new Map();
  for (const la of lookAlikes) {
    const laAspects = new Set();
    for (const tok of tokenizeForSearch(la.doc.primary, { filterStopwords: true })) {
      laAspects.add(aspectKeyOfToken(tok));
    }
    for (const ak of laAspects) {
      lookAlikeAspectCounts.set(ak, (lookAlikeAspectCounts.get(ak) ?? 0) + 1);
    }
  }

  const queryTokenSet = new Set(queryTokens);
  const maxBridgeDf = Math.max(14, Math.floor(N * 0.035));
  const bestBridgeByAspect = new Map();

  for (const seed of seeds) {
    for (const tok of tokenizeForSearch(seed.doc.primary, { filterStopwords: true })) {
      if (tok.length < 3) continue;
      const prefix = tok[0];
      if (prefix !== 'a' && prefix !== 's' && prefix !== 'b') continue;
      if (queryTokenSet.has(tok)) continue;
      const ak = aspectKeyOfToken(tok);
      if (aspectIndexByKey.has(ak)) continue;
      if (lookAlikes.length > 0 && (lookAlikeAspectCounts.get(ak) ?? 0) >= lookAlikes.length * 0.5) continue;

      const posting = postings.get(tok);
      if (!posting) continue;
      const df = posting.length >>> 1;
      if (df < 2 || df > maxBridgeDf) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const pw = PREFIX_WEIGHTS[prefix] ?? 1.0;
      const prev = bestBridgeByAspect.get(ak);
      if (!prev || idf * pw > prev.sortWeight) {
        bestBridgeByAspect.set(ak, { tok, ak, df, idf, pw, sortWeight: idf * pw, posting });
      }
    }
  }

  const bridges = [...bestBridgeByAspect.values()]
    .sort((a, b) => b.idf - a.idf || b.pw - a.pw || a.tok.localeCompare(b.tok))
    .slice(0, 6);
  if (bridges.length === 0) return [];

  const ultraRareDf = Math.max(6, Math.floor(N * 0.015));
  const bridgeScore = new Map();
  const bridgeHitCounts = new Map();
  const bridgeHasUltraRare = new Map();

  for (const br of bridges) {
    const posting = br.posting;
    const isUltra = br.df <= ultraRareDf;
    for (let k = 0; k < posting.length; k += 2) {
      const docId = posting[k];
      if (passedDocSet.has(docId)) continue;
      const doc = docs[docId];
      if (seedSpanIndices.has(doc.spanIdx)) continue;
      if ((docAspectSets.get(docId)?.size ?? 0) < 1) continue;

      const tfTilde = posting[k + 1];
      const contrib = br.pw * br.idf * ((tfTilde * (BM25F_K1 + 1)) / (tfTilde + BM25F_K1));
      bridgeScore.set(docId, (bridgeScore.get(docId) ?? 0) + contrib);
      bridgeHitCounts.set(docId, (bridgeHitCounts.get(docId) ?? 0) + 1);
      if (isUltra) bridgeHasUltraRare.set(docId, true);
    }
  }

  const qualifying = [];
  for (const [docId, bCount] of bridgeHitCounts) {
    if (bCount < 2 && !bridgeHasUltraRare.get(docId)) continue;
    qualifying.push({
      doc: docs[docId],
      rawScore: (bridgeScore.get(docId) ?? 0) + bm25Scores[docId],
    });
  }
  if (qualifying.length === 0) return [];

  qualifying.sort((a, b) => {
    if (b.rawScore !== a.rawScore) return b.rawScore - a.rawScore;
    if (a.doc.spanIdx !== b.doc.spanIdx) return a.doc.spanIdx - b.doc.spanIdx;
    const aSeq = Number.isFinite(a.doc.seq) ? a.doc.seq : -Infinity;
    const bSeq = Number.isFinite(b.doc.seq) ? b.doc.seq : -Infinity;
    return bSeq - aSeq;
  });

  const bestPerSpan = [];
  const usedSpans = new Set();
  for (const q of qualifying) {
    if (usedSpans.has(q.doc.spanIdx)) continue;
    usedSpans.add(q.doc.spanIdx);
    bestPerSpan.push(q);
    if (bestPerSpan.length >= 2) break;
  }

  const ceilingAnchor = rankedDirect[Math.min(rankedDirect.length - 1, 8)].totalScore;
  return bestPerSpan.map((item, hopRank) => {
    const ceiling = ceilingAnchor * (0.99 - 0.02 * hopRank);
    const totalScore = Math.min(item.rawScore, ceiling);
    return {
      doc: item.doc,
      matchKind: 'bm25f',
      secondHop: true,
      bm25Score: bm25Scores[item.doc.docId],
      directScore: totalScore,
      totalScore,
      haystack: null,
      matchAt: 0,
      matchLen: 0,
    };
  });
}

function selectSubmodularDiverse({ ranked, effectiveLimit, aspects, docAspectSets, N, top1Bm25 }) {
  const maxEligibleDf = Math.max(12, Math.floor(N * 0.35));
  const eligible = [];
  for (let ai = 0; ai < aspects.length; ai += 1) {
    const a = aspects[ai];
    if (a.df > 0 && a.df <= maxEligibleDf) eligible.push({ aspectIdx: ai, idf: a.idf });
  }
  if (eligible.length < 2 || ranked.length <= effectiveLimit) {
    return ranked.slice(0, effectiveLimit);
  }

  const pool = ranked.slice(0, 64);
  const sumQueryIdf = eligible.reduce((sum, e) => sum + e.idf, 0);
  const scaleScore = top1Bm25 > 0 ? top1Bm25 : (pool[0]?.totalScore ?? 1);
  const selected = [];
  const picked = new Uint8Array(pool.length);
  const spanCounts = new Map();
  const covCounts = new Int32Array(eligible.length);

  while (selected.length < effectiveLimit && selected.length < pool.length) {
    let bestIdx = -1;
    let bestGain = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      if (picked[i]) continue;
      const cand = pool[i];
      const spanCount = spanCounts.get(cand.doc.spanIdx) ?? 0;
      const decay = 0.86 ** Math.max(0, spanCount - 2);
      const exactFloor = cand.matchKind === 'exact'
        ? (cand.directScore >= 1000 ? 800 : 400) + cand.bm25Score * decay
        : 0;
      const decayedBase = Math.max(cand.totalScore * decay, exactFloor);

      let mg = 0;
      if (selected.length >= 1 && sumQueryIdf > 0) {
        const docSet = docAspectSets.get(cand.doc.docId);
        if (docSet) {
          for (let ei = 0; ei < eligible.length; ei += 1) {
            if (!docSet.has(eligible[ei].aspectIdx)) continue;
            const cov = covCounts[ei];
            if (cov === 0) mg += eligible[ei].idf;
            else if (cov === 1) mg += 0.15 * eligible[ei].idf;
          }
        }
      }
      const gain = decayedBase + (selected.length >= 1 && sumQueryIdf > 0 ? 0.14 * scaleScore * (mg / sumQueryIdf) : 0);
      if (gain > bestGain) {
        bestGain = gain;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    picked[bestIdx] = 1;
    const chosen = pool[bestIdx];
    selected.push(chosen);
    spanCounts.set(chosen.doc.spanIdx, (spanCounts.get(chosen.doc.spanIdx) ?? 0) + 1);
    const chosenSet = docAspectSets.get(chosen.doc.docId);
    if (chosenSet) {
      for (let ei = 0; ei < eligible.length; ei += 1) {
        if (chosenSet.has(eligible[ei].aspectIdx)) covCounts[ei] += 1;
      }
    }
  }
  return selected;
}

function applyLatestUpdateAnchor({ ranked, selected, effectiveLimit, minScore, top1Bm25 }) {
  if (ranked.length <= effectiveLimit) return;
  let maxSelectedSeq = -Infinity;
  const selectedDocIds = new Set();
  for (const item of selected) {
    selectedDocIds.add(item.doc.docId);
    if (Number.isFinite(item.doc.seq) && item.doc.seq > maxSelectedSeq) {
      maxSelectedSeq = item.doc.seq;
    }
  }
  if (!Number.isFinite(maxSelectedSeq)) return;

  const anchorThreshold = Math.max(minScore, top1Bm25 * 0.25);
  const scanBound = Math.min(ranked.length, 40);
  let bestAnchor = null;
  for (let i = 0; i < scanBound; i += 1) {
    const cand = ranked[i];
    if (cand.secondHop) continue;
    if (selectedDocIds.has(cand.doc.docId)) continue;
    if (!Number.isFinite(cand.doc.seq) || cand.doc.seq <= maxSelectedSeq) continue;
    if (cand.matchKind !== 'exact' && cand.bm25Score < anchorThreshold) continue;
    if (
      !bestAnchor ||
      cand.totalScore > bestAnchor.totalScore ||
      (cand.totalScore === bestAnchor.totalScore && cand.doc.seq > bestAnchor.doc.seq)
    ) {
      bestAnchor = cand;
    }
  }
  if (!bestAnchor) return;

  let replaceIdx = -1;
  for (let i = selected.length - 1; i >= 0; i -= 1) {
    if (selected[i].matchKind !== 'exact') {
      replaceIdx = i;
      break;
    }
  }
  if (replaceIdx === -1 && effectiveLimit > 1) {
    replaceIdx = selected.length - 1;
  }
  if (replaceIdx >= 0) {
    selected[replaceIdx] = { ...bestAnchor, newerUpdate: true };
  }
}

function emptyFunnel() {
  return {
    exactDocIds: [],
    bm25TopDocIds: [],
    secondHopDocIds: [],
    selectedDocIds: [],
    newerUpdateDocIds: [],
  };
}

/**
 * Compact multi-field BM25F + exact-phrase search index across prepared spans.
 * Stores `df === 1` postings as 2-element `[docId, tfTilde]` arrays and expands
 * to flat `[docId0, tf0, docId1, tf1, ...]` arrays only when `df >= 2`.
 */
export class CompactBM25FIndex {
  /**
   * @param {readonly object[]} preparedSpans
   */
  constructor(preparedSpans = []) {
    const spans = Array.isArray(preparedSpans) ? preparedSpans : [];
    const docs = [];
    const callIdToDocs = new Map();
    let totalUserLen = 0;
    let totalAssistantLen = 0;
    let totalToolLen = 0;
    let totalCausalLen = 0;
    let countUserDocs = 0;
    let countAssistantDocs = 0;
    let countToolDocs = 0;
    let countCausalDocs = 0;

    for (let s = 0; s < spans.length; s += 1) {
      const span = spans[s];
      const spanDocs = Array.isArray(span?.docs) ? span.docs : [];
      for (let e = 0; e < spanDocs.length; e += 1) {
        const d = spanDocs[e];
        const docId = docs.length;
        const uLen = d.userLen ?? 0;
        const aLen = d.assistantLen ?? 0;
        const tLen = d.toolLen ?? 0;
        const cLen = d.causalLen ?? 0;
        docs.push({
          docId,
          spanIdx: s,
          entryIndex: d.entryIndex ?? e,
          compactionId: d.compactionId ?? span.compactionId,
          incomplete: d.incomplete ?? span.incomplete ?? null,
          seq: d.seq,
          role: d.role,
          primary: d.primary,
          meta: d.meta,
          primaryLower: d.primaryLower,
          metaLower: d.metaLower,
          callIds: d.callIds ?? [],
          prevNonEmptySnippet: d.prevNonEmptySnippet ?? '',
          effectiveChars: d.effectiveChars ?? 0,
          trimmedLength: d.trimmedLength ?? 0,
          userLen: uLen,
          assistantLen: aLen,
          toolLen: tLen,
          causalLen: cLen,
        });
        if (uLen > 0) {
          totalUserLen += uLen;
          countUserDocs += 1;
        }
        if (aLen > 0) {
          totalAssistantLen += aLen;
          countAssistantDocs += 1;
        }
        if (tLen > 0) {
          totalToolLen += tLen;
          countToolDocs += 1;
        }
        if (cLen > 0) {
          totalCausalLen += cLen;
          countCausalDocs += 1;
        }
        for (const cid of d.callIds ?? []) {
          let list = callIdToDocs.get(cid);
          if (!list) callIdToDocs.set(cid, (list = []));
          list.push(docId);
        }
      }
    }

    const avgdl = {
      user: countUserDocs > 0 ? totalUserLen / countUserDocs : 0,
      assistant: countAssistantDocs > 0 ? totalAssistantLen / countAssistantDocs : 0,
      tool: countToolDocs > 0 ? totalToolLen / countToolDocs : 0,
      causal: countCausalDocs > 0 ? totalCausalLen / countCausalDocs : 0,
    };

    const postings = new Map();
    const docTerms = new Set();

    // Build postings in O(total tokens) using linear docId counter.
    let nextDocId = 0;
    for (let s = 0; s < spans.length; s += 1) {
      const spanDocs = Array.isArray(spans[s]?.docs) ? spans[s].docs : [];
      for (let e = 0; e < spanDocs.length; e += 1) {
        const d = spanDocs[e];
        const docId = nextDocId;
        nextDocId += 1;

        docTerms.clear();
        for (const k of d.userTf.keys()) docTerms.add(k);
        for (const k of d.assistantTf.keys()) docTerms.add(k);
        for (const k of d.toolTf.keys()) docTerms.add(k);
        for (const k of d.causalTf.keys()) docTerms.add(k);

        const normU = avgdl.user > 0 ? (1 - FIELD_B.user) + FIELD_B.user * (d.userLen / avgdl.user) : 1;
        const normA =
          avgdl.assistant > 0 ? (1 - FIELD_B.assistant) + FIELD_B.assistant * (d.assistantLen / avgdl.assistant) : 1;
        const normT = avgdl.tool > 0 ? (1 - FIELD_B.tool) + FIELD_B.tool * (d.toolLen / avgdl.tool) : 1;
        const normC = avgdl.causal > 0 ? (1 - FIELD_B.causal) + FIELD_B.causal * (d.causalLen / avgdl.causal) : 1;

        const dampTf = (tf) => tf / (1 + 0.6 * (tf - 1));
        for (const term of docTerms) {
          let tfTilde = 0;
          if (avgdl.user > 0) {
            const tf = d.userTf.get(term);
            if (tf) tfTilde += (FIELD_WEIGHTS.user * dampTf(tf)) / normU;
          }
          if (avgdl.assistant > 0) {
            const tf = d.assistantTf.get(term);
            if (tf) tfTilde += (FIELD_WEIGHTS.assistant * dampTf(tf)) / normA;
          }
          if (avgdl.tool > 0) {
            const tf = d.toolTf.get(term);
            if (tf) tfTilde += (FIELD_WEIGHTS.tool * dampTf(tf)) / normT;
          }
          if (avgdl.causal > 0) {
            const tf = d.causalTf.get(term);
            if (tf) tfTilde += (FIELD_WEIGHTS.causal * dampTf(tf)) / normC;
          }
          if (tfTilde <= 0) continue;

          const existing = postings.get(term);
          if (!existing) {
            // Compact df === 1 representation: 2-element flat tuple [docId, tfTilde].
            postings.set(term, [docId, tfTilde]);
          } else {
            existing.push(docId, tfTilde);
          }
        }
      }
    }

    let df1Count = 0;
    for (const posting of postings.values()) {
      if (posting.length === 2) df1Count += 1;
    }

    this._docs = docs;
    this._callIdToDocs = callIdToDocs;
    this._avgdl = avgdl;
    this.postings = postings;
    this._df1Count = df1Count;
    this._spanCount = new Set(docs.map((d) => d.spanIdx)).size;
  }

  /**
   * Lightweight index statistics including compact `df === 1` term counts.
   */
  stats() {
    return {
      docCount: this._docs.length,
      termCount: this.postings.size,
      df1Count: this._df1Count,
      multiDocTermCount: this.postings.size - this._df1Count,
      avgdl: { ...this._avgdl },
    };
  }

  /**
   * Execute hybrid exact-phrase + BM25F + 2-hop + submodular search.
   *
   * @param {string} query
   * @param {{ limit?: number, excerptFn?: (text: string, at: number, len: number) => string, debug?: boolean }} [options]
   * @returns {{ hits: object[], funnel?: object }}
   */
  search(query, { limit = 20, excerptFn, debug = false } = {}) {
    const effectiveLimit = Number.isInteger(limit) && limit > 0 ? limit : 20;
    const rawQuery = String(query ?? '');
    const needle = rawQuery.trim().toLowerCase();
    const N = this._docs.length;
    if (!needle || N === 0) return debug ? { hits: [], funnel: emptyFunnel() } : { hits: [] };

    const makeExcerpt = typeof excerptFn === 'function' ? excerptFn : defaultExcerptAround;
    const queryTerms = [...new Set(needle.split(/\s+/).filter(Boolean))];
    const queryTokens = [...new Set(tokenizeForSearch(rawQuery, { filterStopwords: true, isQuery: true }))];
    const atomicCompound = isAtomicCompoundIdentifier(rawQuery, queryTokens);

    // 1. Score BM25F across postings with prefix weights and aspect grouping.
    const {
      aspects,
      aspectIndexByKey,
      hyphenCreditMap,
      bm25Scores,
      bestTokenIdx,
      docAspectSets,
    } = buildQueryAspectTable(rawQuery, queryTokens, this.postings, N);

    let top1Bm25 = 0;
    for (let i = 0; i < N; i += 1) {
      if (bm25Scores[i] > top1Bm25) top1Bm25 = bm25Scores[i];
    }

    // 2. Exact phrase & multi-term exact scanning.
    const exactDocs = new Set();
    const exactCandidates = [];

    const scanSubstringOccurrences = (doc, haystack, haystackLower, baseBoost) => {
      if (!haystackLower) return false;
      let found = false;
      let from = 0;
      let occ = 0;
      while (from <= haystackLower.length && occ < effectiveLimit) {
        const at = haystackLower.indexOf(needle, from);
        if (at < 0) break;
        found = true;
        exactDocs.add(doc.docId);
        exactCandidates.push({
          doc,
          matchKind: 'exact',
          bm25Score: bm25Scores[doc.docId],
          directScore: baseBoost + bm25Scores[doc.docId],
          totalScore: baseBoost + bm25Scores[doc.docId] - occ * 0.001,
          haystack,
          matchAt: at,
          matchLen: needle.length,
        });
        occ += 1;
        from = at + Math.max(needle.length, 80);
      }
      return found;
    };

    for (let docId = 0; docId < N; docId += 1) {
      const doc = this._docs[docId];
      const roleBoost = doc.role === 'user' ? 1050 : doc.role === 'assistant' ? 1020 : 1000;
      if (scanSubstringOccurrences(doc, doc.primary, doc.primaryLower, roleBoost)) continue;
      if (scanSubstringOccurrences(doc, doc.meta, doc.metaLower, roleBoost - 50)) continue;
      if (queryTerms.length > 1) {
        const combined = doc.primary ? `${doc.primary}\n${doc.meta}` : doc.meta;
        const combinedLower = doc.primaryLower ? `${doc.primaryLower}\n${doc.metaLower}` : doc.metaLower;
        if (queryTerms.every((t) => combinedLower.includes(t))) {
          const firstTerm = queryTerms[0];
          const at = combinedLower.indexOf(firstTerm);
          exactDocs.add(docId);
          exactCandidates.push({
            doc,
            matchKind: 'exact',
            bm25Score: bm25Scores[docId],
            directScore: 500 + (doc.role === 'user' ? 20 : 0) + bm25Scores[docId],
            totalScore: 500 + (doc.role === 'user' ? 20 : 0) + bm25Scores[docId],
            haystack: combined,
            matchAt: at,
            matchLen: firstTerm.length,
          });
        }
      }
    }

    // 3. Precision Guard with deduplicated word-aspect overlap counting.
    const minScore = Math.max(0.15, top1Bm25 * 0.12);
    const bm25Candidates = [];
    const passedDocSet = new Set(exactDocs);
    const queryAspectCount = aspects.length;

    for (let docId = 0; docId < N; docId += 1) {
      if (exactDocs.has(docId)) continue;
      const score = bm25Scores[docId];
      if (score <= 0 || score < 0.15) continue;

      const docSet = docAspectSets.get(docId);
      const overlap = effectiveOverlapCount(docSet, hyphenCreditMap);
      const matchedJoinedCompound =
        hyphenCreditMap.size > 0 &&
        Boolean(docSet) &&
        [...hyphenCreditMap.keys()].some((jIdx) => docSet.has(jIdx));
      if (!matchedJoinedCompound && score < minScore) continue;
      if (atomicCompound) {
        if (exactDocs.size > 0 && !matchedJoinedCompound) continue;
        if (queryAspectCount > 0 && overlap / queryAspectCount < 0.5) continue;
      }
      if (queryAspectCount >= 3) {
        const coverage = overlap / queryAspectCount;
        if (overlap < 2 && coverage < 0.5) continue;
      }

      passedDocSet.add(docId);
      bm25Candidates.push({
        doc: this._docs[docId],
        matchKind: 'bm25f',
        bm25Score: score,
        directScore: score,
        totalScore: score,
        haystack: null,
        matchAt: 0,
        matchLen: 0,
      });
    }

    // 4. Local Adjacency Cohesion (bounded <= top1Bm25 * 0.20, ONLY for passed candidates).
    const maxCohesionBoost = top1Bm25 * 0.2;
    const applyCohesion = (candidate) => {
      if (maxCohesionBoost <= 0) return;
      const doc = candidate.doc;
      const neighborIds = new Set();

      for (let j = doc.docId - 1; j >= 0; j -= 1) {
        const other = this._docs[j];
        if (other.spanIdx !== doc.spanIdx) break;
        if (
          Math.abs(other.entryIndex - doc.entryIndex) === 1 ||
          (Number.isFinite(doc.seq) && Number.isFinite(other.seq) && Math.abs(other.seq - doc.seq) === 1)
        ) {
          neighborIds.add(other.docId);
        } else if (doc.entryIndex - other.entryIndex > 4) {
          break;
        }
      }
      for (let j = doc.docId + 1; j < N; j += 1) {
        const other = this._docs[j];
        if (other.spanIdx !== doc.spanIdx) break;
        if (
          Math.abs(other.entryIndex - doc.entryIndex) === 1 ||
          (Number.isFinite(doc.seq) && Number.isFinite(other.seq) && Math.abs(other.seq - doc.seq) === 1)
        ) {
          neighborIds.add(other.docId);
        } else if (other.entryIndex - doc.entryIndex > 4) {
          break;
        }
      }

      for (const cid of doc.callIds) {
        const linked = this._callIdToDocs.get(cid);
        if (!linked) continue;
        for (const otherId of linked) {
          if (otherId !== doc.docId) neighborIds.add(otherId);
        }
      }

      let boost = 0;
      for (const nid of neighborIds) {
        if (!passedDocSet.has(nid)) continue;
        const nScore = bm25Scores[nid];
        if (nScore > 0) boost += 0.12 * nScore;
      }
      if (boost > 0) {
        candidate.totalScore += Math.min(boost, maxCohesionBoost);
      }
    };

    for (const c of exactCandidates) applyCohesion(c);
    for (const c of bm25Candidates) applyCohesion(c);

    // 5a. Direct ranking + 5-Gate Cross-Span 2-Hop Retrieval.
    const rankedDirect = [...exactCandidates, ...bm25Candidates].sort(compareRankedCandidates);
    const hopCandidates = selectCrossSpanTwoHop({
      docs: this._docs,
      postings: this.postings,
      N,
      spanCount: this._spanCount,
      atomicCompound,
      exactDocs,
      effectiveLimit,
      rankedDirect,
      bm25Scores,
      top1Bm25,
      queryTokens,
      aspectIndexByKey,
      passedDocSet,
      docAspectSets,
      aspects,
    });
    const ranked = hopCandidates.length > 0
      ? [...rankedDirect, ...hopCandidates].sort(compareRankedCandidates)
      : rankedDirect;

    if (ranked.length === 0) return debug ? { hits: [], funnel: emptyFunnel() } : { hits: [] };

    // 5b. Submodular Uncovered Query-Aspect Greedy Selection + Same-Span Decay.
    const selected = selectSubmodularDiverse({
      ranked,
      effectiveLimit,
      aspects,
      docAspectSets,
      N,
      top1Bm25,
    });

    // 6. Latest Update Anchor (`newerUpdate: true`).
    applyLatestUpdateAnchor({ ranked, selected, effectiveLimit, minScore, top1Bm25 });

    // 7. Build excerpts, contextHints, and sort chronologically ascending (`seq` asc).
    const buildBm25Excerpt = (doc) => {
      if (typeof doc.primary === 'string' && doc.primary.length > 400) {
        const salient = extractSalientProse(doc.primary, {
          budgetChars: 260,
          queryTokens: [...queryTerms, ...queryTokens],
          deadlineMs: performance.now() + 8,
        });
        if (salient) {
          const singleLine = salient.replace(/\s+/g, ' ').trim();
          if (singleLine.length > 0) {
            return singleLine.length > 280 ? `${singleLine.slice(0, 277)}...` : singleLine;
          }
        }
      }
      const surfaces = [];
      const bIdx = bestTokenIdx[doc.docId];
      if (bIdx >= 0 && queryTokens[bIdx]) {
        surfaces.push(queryTokens[bIdx].slice(1));
      }
      for (const qt of queryTokens) {
        const s = qt.slice(1);
        if (s && !surfaces.includes(s)) surfaces.push(s);
      }
      for (const s of surfaces) {
        const at = doc.primaryLower.indexOf(s);
        if (at >= 0) {
          return makeExcerpt(doc.primary, at, Math.min(s.length, 40));
        }
      }
      for (const s of surfaces) {
        const at = doc.metaLower.indexOf(s);
        if (at >= 0) {
          return makeExcerpt(doc.meta, at, Math.min(s.length, 40));
        }
      }
      if (doc.primary.trim().length > 0) {
        return makeExcerpt(doc.primary, 0, Math.min(doc.primary.length, 40));
      }
      return makeExcerpt(doc.meta, 0, Math.min(doc.meta.length, 40));
    };

    selected.sort((a, b) => {
      const aSeq = Number.isFinite(a.doc.seq) ? a.doc.seq : Infinity;
      const bSeq = Number.isFinite(b.doc.seq) ? b.doc.seq : Infinity;
      if (aSeq !== bSeq) return aSeq - bSeq;
      if (a.doc.spanIdx !== b.doc.spanIdx) return a.doc.spanIdx - b.doc.spanIdx;
      if (a.doc.entryIndex !== b.doc.entryIndex) return a.doc.entryIndex - b.doc.entryIndex;
      return a.matchAt - b.matchAt;
    });

    const hits = selected.map((item) => {
      const doc = item.doc;
      const rawExcerpt =
        item.matchKind === 'exact'
          ? makeExcerpt(item.haystack, item.matchAt, item.matchLen)
          : buildBm25Excerpt(doc);
      const excerpt = String(rawExcerpt ?? '').replace(/\s+/g, ' ').trim();
      const contextHint =
        doc.trimmedLength > 0 && doc.effectiveChars <= MAX_ISOLATED_CHARS && doc.prevNonEmptySnippet
          ? doc.prevNonEmptySnippet
          : '';
      return {
        compactionId: doc.compactionId,
        seq: doc.seq,
        role: doc.role,
        excerpt,
        matchKind: item.matchKind,
        ...(doc.incomplete ? { incomplete: doc.incomplete } : {}),
        ...(contextHint ? { contextHint } : {}),
        ...(item.secondHop ? { secondHop: true } : {}),
        ...(item.newerUpdate ? { newerUpdate: true } : {}),
      };
    });

    if (!debug) return { hits };

    const exactDocIds = [...new Set(rankedDirect.filter((c) => c.matchKind === 'exact').map((c) => c.doc.docId))];
    const bm25TopDocIds = [
      ...new Set(rankedDirect.filter((c) => c.matchKind === 'bm25f').slice(0, Math.max(effectiveLimit, 20)).map((c) => c.doc.docId)),
    ];
    const secondHopDocIds = hopCandidates.map((c) => c.doc.docId);
    const selectedDocIds = selected.map((c) => c.doc.docId);
    const newerUpdateDocIds = selected.filter((c) => c.newerUpdate).map((c) => c.doc.docId);
    return {
      hits,
      funnel: {
        exactDocIds,
        bm25TopDocIds,
        secondHopDocIds,
        selectedDocIds,
        newerUpdateDocIds,
      },
    };
  }
}

/**
 * Convenience helper to search prepared spans directly without persisting an index.
 *
 * @param {readonly object[]} preparedSpans
 * @param {string} query
 * @param {{ limit?: number, excerptFn?: (text: string, at: number, len: number) => string }} [options]
 * @returns {{ hits: object[] }}
 */
export function searchPreparedSpans(preparedSpans, query, options = {}) {
  const index = new CompactBM25FIndex(preparedSpans);
  return index.search(query, options);
}
