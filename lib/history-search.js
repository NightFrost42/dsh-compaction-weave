// Zero-I/O bilingual (CJK + ASCII/code) BM25F + exact-phrase archive search engine.
import { extractSalientProse } from './tool-preview.js';

const CJK_RUN_RE = /[\u4e00-\u9fff\u3400-\u4dbf]+/g;
const IDENT_RE = /[A-Za-z0-9]+(?:(?:[:]{2}|[._:/-])[A-Za-z0-9]+)*/g;
const SEGMENT_SPLIT_RE = /::|[/.:_-]/;

const CJK_STOPWORDS = new Set(
  '的了着过地得吗呢吧啊呀哦嘛之个些这那其此于与及和或而在是有为以从向把被让给就都也还又很',
);

const ENGLISH_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'by',
  'from',
  'as',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'we',
  'you',
  'he',
  'she',
  'they',
  'i',
  'my',
  'our',
  'your',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
]);

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
    if (!filterStopwords || !ENGLISH_STOPWORDS.has(fullLower)) {
      emit(`a${fullLower}`);
    }

    const segments = raw.split(SEGMENT_SPLIT_RE).filter(Boolean);
    for (const seg of segments) {
      const segLower = seg.toLowerCase();
      if (!filterStopwords || !ENGLISH_STOPWORDS.has(segLower)) {
        emit(`a${segLower}`);
      }
      const subwords = splitCamelAndDigits(seg);
      for (const sub of subwords) {
        const subLower = sub.toLowerCase();
        if (!subLower) continue;
        if (filterStopwords && ENGLISH_STOPWORDS.has(subLower)) continue;
        emit(`a${subLower}`);
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
   * Execute hybrid exact-phrase + BM25F search.
   *
   * @param {string} query
   * @param {{ limit?: number, excerptFn?: (text: string, at: number, len: number) => string }} [options]
   * @returns {{ hits: object[] }}
   */
  search(query, { limit = 20, excerptFn } = {}) {
    const effectiveLimit = Number.isInteger(limit) && limit > 0 ? limit : 20;
    const rawQuery = String(query ?? '');
    const needle = rawQuery.trim().toLowerCase();
    const N = this._docs.length;
    if (!needle || N === 0) return { hits: [] };

    const makeExcerpt = typeof excerptFn === 'function' ? excerptFn : defaultExcerptAround;
    const queryTerms = [...new Set(needle.split(/\s+/).filter(Boolean))];
    const queryTokens = [...new Set(tokenizeForSearch(rawQuery, { filterStopwords: true, isQuery: true }))];
    const atomicCompound = isAtomicCompoundIdentifier(rawQuery, queryTokens);

    // 1. Score BM25F across postings.
    const bm25Scores = new Float64Array(N);
    const matchedCount = new Uint16Array(N);
    const bestTokenIdx = new Int32Array(N).fill(-1);
    const bestTokenIdf = new Float64Array(N);

    for (let qi = 0; qi < queryTokens.length; qi += 1) {
      const posting = this.postings.get(queryTokens[qi]);
      if (!posting) continue;
      const df = posting.length >>> 1;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let k = 0; k < posting.length; k += 2) {
        const docId = posting[k];
        const tfTilde = posting[k + 1];
        const contrib = idf * ((tfTilde * (BM25F_K1 + 1)) / (tfTilde + BM25F_K1));
        bm25Scores[docId] += contrib;
        matchedCount[docId] += 1;
        if (idf > bestTokenIdf[docId]) {
          bestTokenIdf[docId] = idf;
          bestTokenIdx[docId] = qi;
        }
      }
    }

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

    // 3. Precision Guard for BM25F-only (non-exact) candidates.
    const minScore = Math.max(0.15, top1Bm25 * 0.12);
    const bm25Candidates = [];
    const passedDocSet = new Set(exactDocs);

    for (let docId = 0; docId < N; docId += 1) {
      if (exactDocs.has(docId)) continue;
      const score = bm25Scores[docId];
      if (score <= 0 || score < minScore) continue;

      const overlap = matchedCount[docId];
      if (atomicCompound) {
        if (exactDocs.size > 0) continue;
        if (queryTokens.length > 0 && overlap / queryTokens.length < 0.5) continue;
      }
      if (queryTokens.length >= 3) {
        const coverage = overlap / queryTokens.length;
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

      // Same-span entry index ± 1 and seq ± 1.
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

      // Shared callId neighbors.
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

    // 5. Rank candidates and select Top-K.
    const ranked = [...exactCandidates, ...bm25Candidates].sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      if (a.doc.spanIdx !== b.doc.spanIdx) return a.doc.spanIdx - b.doc.spanIdx;
      const aSeq = Number.isFinite(a.doc.seq) ? a.doc.seq : -Infinity;
      const bSeq = Number.isFinite(b.doc.seq) ? b.doc.seq : -Infinity;
      if (bSeq !== aSeq) return bSeq - aSeq;
      return a.matchAt - b.matchAt;
    });

    if (ranked.length === 0) return { hits: [] };

    const selected = ranked.slice(0, effectiveLimit);

    // 6. Latest Update Anchor (`newerUpdate: true`).
    if (ranked.length > effectiveLimit) {
      let maxSelectedSeq = -Infinity;
      const selectedDocIds = new Set();
      for (const item of selected) {
        selectedDocIds.add(item.doc.docId);
        if (Number.isFinite(item.doc.seq) && item.doc.seq > maxSelectedSeq) {
          maxSelectedSeq = item.doc.seq;
        }
      }

      if (Number.isFinite(maxSelectedSeq)) {
        const anchorThreshold = Math.max(minScore, top1Bm25 * 0.25);
        const scanBound = Math.min(ranked.length, 40);
        let bestAnchor = null;
        for (let i = effectiveLimit; i < scanBound; i += 1) {
          const cand = ranked[i];
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

        if (bestAnchor) {
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
      }
    }

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
        ...(item.newerUpdate ? { newerUpdate: true } : {}),
      };
    });

    return { hits };
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
