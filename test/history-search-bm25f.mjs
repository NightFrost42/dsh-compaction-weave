import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CompactionArchive } from '../lib/history.js';
import {
  CompactBM25FIndex,
  lightEnglishStem,
  prepareSpanForSearch,
  searchPreparedSpans,
  tokenizeForSearch,
} from '../lib/history-search.js';
import { __test as tools } from '../lib/tools.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error?.message ?? String(error), stack: error?.stack });
  }
}

const TEST_BASE = process.env.WEAVE_TEST_ROOT ?? tmpdir();

function makeEntry(seq, role, text, extras = {}) {
  return {
    seq,
    type: role === 'tool' ? 'tool/result' : `${role}/message`,
    role,
    text,
    ...extras,
  };
}

// ── 1. Chinese no-space natural query ───────────────────────────────────────

await test('chinese-nospace-natural-query-matches-via-bm25f', async () => {
  const tokens = tokenizeForSearch('数据库迁移审计日志保留', { isQuery: true });
  assert.ok(tokens.includes('b数据') && tokens.includes('b据库'));
  assert.ok(tokens.includes('b日志') && tokens.includes('b保留'));

  // Stopword-only query falls back cleanly when isQuery: true.
  const stopOnly = tokenizeForSearch('的了在', { isQuery: true });
  assert.ok(stopOnly.length > 0, 'isQuery stopword fallback must emit tokens');

  const root = await mkdtemp(join(TEST_BASE, 'weave-bm25f-cjk-'));
  try {
    const archive = new CompactionArchive({ root });
    const sessionId = 'sess-cjk-1';
    await archive.writeSpan({
      sessionId,
      compactionId: 'cmp-cjk-1',
      entries: [
        makeEntry(1, 'user', '必须保留生产数据库迁移记录与审计日志，禁止跳过事务完整性校验。'),
        makeEntry(2, 'assistant', '好的，今天前端按钮颜色调整为蓝色并更新样式表。'),
        makeEntry(3, 'tool', 'npm run lint exited with code 0 after checking CSS files.'),
      ],
    });

    const res = await archive.search(sessionId, '数据库审计日志保留');
    assert.ok(res.hits.length >= 1, 'natural CJK query without spaces must match');
    assert.equal(res.hits[0].seq, 1);
    assert.equal(res.hits[0].matchKind, 'bm25f');
    assert.equal(res.unreadable.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 2. Noisy repetitive tool/result does NOT drown out concise user rule ────

await test('noisy-repetitive-tool-results-do-not-drown-out-concise-user-constraint', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-bm25f-role-'));
  try {
    const archive = new CompactionArchive({ root });
    const sessionId = 'sess-role-1';
    const noisyLog = '日志记录：数据库备份检查完成，磁盘空间充足。\n'.repeat(45);
    await archive.writeSpan({
      sessionId,
      compactionId: 'cmp-role-1',
      entries: [
        makeEntry(10, 'tool', noisyLog),
        makeEntry(11, 'tool', noisyLog),
        makeEntry(12, 'tool', noisyLog),
        makeEntry(13, 'tool', noisyLog),
        makeEntry(14, 'tool', noisyLog),
        makeEntry(15, 'user', '生产数据库备份必须保留校验约束。'),
      ],
    });

    const res = await archive.search(sessionId, '数据库备份保留校验约束', { limit: 2 });
    assert.ok(res.hits.some((h) => h.seq === 15), `concise user constraint seq=15 must survive limit=2, got ${JSON.stringify(res.hits)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 3. Identifier & path tokenization (camelCase/snake_case/kebab/path/::) ──

await test('identifier-and-path-tokenization-matches-camel-snake-kebab-slash-and-scope', async () => {
  const camelTokens = tokenizeForSearch('getUserProfile');
  const snakeTokens = tokenizeForSearch('get_user_profile');
  const pathTokens = tokenizeForSearch('src/user-profile.ts');
  const scopeTokens = tokenizeForSearch('auth::verifyToken');

  for (const list of [camelTokens, snakeTokens, pathTokens]) {
    assert.ok(list.includes('auser'), `expected auser in ${JSON.stringify(list)}`);
    assert.ok(list.includes('aprofile'), `expected aprofile in ${JSON.stringify(list)}`);
  }
  assert.ok(scopeTokens.includes('aauth'));
  assert.ok(scopeTokens.includes('averify'));
  assert.ok(scopeTokens.includes('atoken'));

  const root = await mkdtemp(join(TEST_BASE, 'weave-bm25f-ident-'));
  try {
    const archive = new CompactionArchive({ root });
    const sessionId = 'sess-ident-1';
    await archive.writeSpan({
      sessionId,
      compactionId: 'cmp-ident-1',
      entries: [
        makeEntry(1, 'assistant', 'Called getUserProfile() to load avatar settings.'),
        makeEntry(2, 'tool', 'SELECT * FROM get_user_profile WHERE active = 1;'),
        makeEntry(3, 'assistant', 'Edited src/user-profile.ts to validate fields.'),
        makeEntry(4, 'assistant', 'Signature verified via auth::verifyToken before commit.'),
        makeEntry(5, 'tool', 'Unrelated build artifact cache cleaned.'),
      ],
    });

    const profileRes = await archive.search(sessionId, 'user profile');
    const profileSeqs = profileRes.hits.map((h) => h.seq);
    assert.deepEqual(profileSeqs, [1, 2, 3], `expected camel/snake/path matches [1, 2, 3], got ${JSON.stringify(profileSeqs)}`);

    const verifyRes = await archive.search(sessionId, 'verifyToken');
    assert.deepEqual(verifyRes.hits.map((h) => h.seq), [4]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 4. Exact phrase boost + precision guard ─────────────────────────────────

await test('exact-phrase-boost-beats-bm25f-and-precision-guard-rejects-partial-subword-noise', () => {
  const span = prepareSpanForSearch({
    compactionId: 'cmp-exact-1',
    entries: [
      makeEntry(1, 'tool', 'Gateway raised ERR_PAYMENT_GATEWAY_TIMEOUT after MIDDLE_EXACT_FAILURE_SENTINEL.'),
      makeEntry(2, 'user', 'Payment gateway latency spiked earlier today.'),
      makeEntry(3, 'assistant', 'Request timeout occurred while waiting on network socket.'),
      makeEntry(4, 'assistant', 'Sentinel health monitor started in middle tier.'),
    ],
  });
  const index = new CompactBM25FIndex([span]);

  const errRes = index.search('ERR_PAYMENT_GATEWAY_TIMEOUT');
  assert.equal(errRes.hits.length, 1, 'precision guard must reject partial-subword noise when exact match exists');
  assert.equal(errRes.hits[0].seq, 1);
  assert.equal(errRes.hits[0].matchKind, 'exact');

  const sentinelRes = index.search('MIDDLE_EXACT_FAILURE_SENTINEL');
  assert.equal(sentinelRes.hits.length, 1);
  assert.equal(sentinelRes.hits[0].seq, 1);
  assert.equal(sentinelRes.hits[0].matchKind, 'exact');

  // Even without an exact hit, < 50% atomic subtoken overlap must be rejected by precision guard.
  const noExactRes = index.search('ALPHA_BETA_GAMMA_DELTA');
  assert.equal(noExactRes.hits.length, 0);

  const partialSpan = prepareSpanForSearch({
    compactionId: 'cmp-partial-only',
    entries: [makeEntry(1, 'user', 'Only mentions alpha once.')],
  });
  assert.equal(searchPreparedSpans([partialSpan], 'ALPHA_BETA_GAMMA_DELTA').hits.length, 0);
});

// ── 5. Causal context bridging + isolated short-sentence contextHint ────────

await test('causal-context-bridging-surfaces-short-followup-with-contextHint-and-tool-rendering', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-bm25f-causal-'));
  try {
    const archive = new CompactionArchive({ root });
    const sessionId = 'sess-causal-1';
    await archive.writeSpan({
      sessionId,
      compactionId: 'cmp-causal-1',
      entries: [
        makeEntry(10, 'user', '请检查 Redis 连接池上限配置，当前线上出现了连接等待。'),
        makeEntry(11, 'user', '改成 64 吧'),
        makeEntry(12, 'assistant', '已记录连接池调整目标。'),
      ],
    });

    const res = await archive.search(sessionId, 'Redis 连接池上限');
    const followup = res.hits.find((h) => h.seq === 11);
    assert.ok(followup, `expected causal context to surface seq=11 follow-up in ${JSON.stringify(res.hits)}`);
    assert.ok(
      typeof followup.contextHint === 'string' && followup.contextHint.includes('Redis 连接池上限'),
      `expected contextHint from preceding snippet, got ${JSON.stringify(followup)}`,
    );

    const toolOutput = await tools.runTool(
      'history_search',
      archive,
      { query: 'Redis 连接池上限' },
      { session: { id: sessionId } },
    );
    assert.match(toolOutput, /改成 64 吧/);
    assert.match(toolOutput, /\(context: .*Redis 连接池上限/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 6. Local adjacency cohesion (bounded <= top1 * 0.20, no zero-match promo) ─

await test('local-adjacency-cohesion-boosts-direct-neighbors-within-cap-and-never-promotes-zero-match', () => {
  // 6a. Same direct match strength: entry with matching seq±1 / shared callId beats isolated entry,
  // while an adjacent entry with ZERO direct match is never promoted.
  const spanA = prepareSpanForSearch({
    compactionId: 'cmp-coh-1',
    entries: [
      makeEntry(1, 'assistant', 'Isolated note mentioning zebra migration checklist.'),
      makeEntry(2, 'assistant', 'Unrelated status log entry.'),
      makeEntry(10, 'tool', 'Running zebra migration script step one.', { tool: [{ kind: 'call', callId: 'call-z1' }] }),
      makeEntry(11, 'tool', 'Completed zebra migration verification step.', { tool: [{ kind: 'result', callId: 'call-z1' }] }),
      makeEntry(12, 'assistant', 'Completely unrelated zero match neighbor next to seq 11.'),
    ],
  });
  const idxA = new CompactBM25FIndex([spanA]);
  const cohRes = idxA.search('zebra migration');
  assert.equal(cohRes.hits.some((h) => h.seq === 12), false, 'zero-match neighbor seq=12 must never be promoted');

  // 6b. Bounded cap <= top1 * 0.20: a lower direct-scoring user entry with matching neighbor/callId
  // cannot leapfrog an isolated entry whose direct BM25F score exceeds it by > top1 * 0.20.
  const spanB = prepareSpanForSearch({
    compactionId: 'cmp-coh-2',
    entries: [
      // seq 1: strong direct match (both query terms repeated in user field, isolated)
      makeEntry(1, 'user', 'quantum telemetry calibration calibration quantum telemetry.'),
      // seq 5..8: weaker direct matches (only 1 term / diluted length) clustered by seq±1 & callId
      makeEntry(5, 'tool', 'quantum unrelated padding words alpha beta gamma delta epsilon zeta eta theta.', {
        tool: [{ kind: 'call', callId: 'call-q' }],
      }),
      makeEntry(6, 'tool', 'telemetry unrelated padding words alpha beta gamma delta epsilon zeta eta theta.', {
        tool: [{ kind: 'result', callId: 'call-q' }],
      }),
    ],
  });
  const idxB = new CompactBM25FIndex([spanB]);
  const top1Only = idxB.search('quantum telemetry', { limit: 1 });
  assert.deepEqual(top1Only.hits.map((h) => h.seq), [1], 'cohesion boost <= 0.20*top1 must not overtake strong top1');
});

// ── 7. Latest update anchor (newerUpdate: true) & chronological seq order ───

await test('latest-update-anchor-sets-newerUpdate-and-preserves-ascending-seq-order', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-bm25f-newer-'));
  try {
    const archive = new CompactionArchive({ root });
    const sessionId = 'sess-newer-1';
    const entries = [
      makeEntry(1, 'user', 'Service listen port server config 8080.'),
      makeEntry(2, 'user', 'Keep listen port server config 8080 for staging.'),
      makeEntry(3, 'user', 'Document listen port server config 8080 in README.'),
    ];
    for (let seq = 4; seq <= 20; seq += 1) {
      entries.push(makeEntry(seq, 'assistant', `Intermediate unrelated step ${seq} checking CSS spacing.`));
    }
    // Later user revision: omits 'server'/'config' so it stays pure BM25F outside Top-3,
    // while still scoring well above anchorThreshold (0.25 * top1Bm25).
    entries.push(makeEntry(30, 'user', 'Update listen port to 9090 instead.'));

    await archive.writeSpan({ sessionId, compactionId: 'cmp-newer-1', entries });

    const res = await archive.search(sessionId, 'listen port server config', { limit: 3 });
    assert.equal(res.hits.length, 3);
    assert.deepEqual(
      res.hits.map((h) => h.seq),
      [1, 2, 30],
      `expected ascending seq with anchored newerUpdate at seq=30, got ${JSON.stringify(res.hits)}`,
    );
    assert.equal(res.hits[2].newerUpdate, true);
    assert.equal(res.hits[0].newerUpdate, undefined);

    const toolOutput = await tools.runTool(
      'history_search',
      archive,
      { query: 'listen port server config', limit: 3 },
      { session: { id: sessionId } },
    );
    assert.match(toolOutput, /\[cmp-newer-1 seq=30 user\] \[newer update\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 8. 8-session LRU cache + read.ok === true only + tamper/delete invalidation ─

await test('lru-8-session-cache-zero-disk-reads-and-write-delete-tamper-invalidation', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-bm25f-cache-'));
  try {
    const archive = new CompactionArchive({ root });

    // 8a. Populate 10 sessions and search each -> LRU caps _searchCache.size <= 8.
    for (let i = 1; i <= 10; i += 1) {
      const sid = `sess-lru-${i}`;
      await archive.writeSpan({
        sessionId: sid,
        compactionId: `cmp-${i}`,
        entries: [makeEntry(1, 'user', `Retention invariant token alpha_${i} must hold.`)],
      });
      await archive.search(sid, `alpha_${i}`);
    }
    assert.equal(archive._searchCache.size, 8);
    assert.equal(archive._searchCache.has('sess-lru-1'), false, 'oldest session 1 should be evicted');
    assert.equal(archive._searchCache.has('sess-lru-2'), false, 'oldest session 2 should be evicted');
    assert.equal(archive._searchCache.has('sess-lru-3'), true);

    // Touch sess-lru-3 before adding sess-lru-11 -> sess-lru-3 stays, sess-lru-4 evicted.
    await archive.search('sess-lru-3', 'alpha_3');
    await archive.writeSpan({
      sessionId: 'sess-lru-11',
      compactionId: 'cmp-11',
      entries: [makeEntry(1, 'user', 'Retention invariant token alpha_11 must hold.')],
    });
    await archive.search('sess-lru-11', 'alpha_11');
    assert.equal(archive._searchCache.size, 8);
    assert.equal(archive._searchCache.has('sess-lru-3'), true, 'recently touched sess-lru-3 must stay cached');
    assert.equal(archive._searchCache.has('sess-lru-4'), false, 'LRU sess-lru-4 must be evicted');

    // 8b. Spy on readSpan: 2nd search on unchanged complete session makes ZERO readSpan calls!
    let readSpanCalls = 0;
    const origReadSpan = archive.readSpan.bind(archive);
    archive.readSpan = async (...args) => {
      readSpanCalls += 1;
      return origReadSpan(...args);
    };

    const hitCache1 = await archive.search('sess-lru-11', 'alpha_11');
    assert.equal(hitCache1.hits.length, 1);
    assert.equal(readSpanCalls, 0, '2nd search on cached complete session must invoke 0 readSpan calls');

    // 8c. writeSpan invalidates session cache.
    await archive.writeSpan({
      sessionId: 'sess-lru-11',
      compactionId: 'cmp-11b',
      entries: [makeEntry(2, 'user', 'Newly added beta_11 invariant.')],
    });
    const afterWrite = await archive.search('sess-lru-11', 'beta_11');
    assert.equal(afterWrite.hits.length, 1);
    assert.ok(readSpanCalls > 0, 'writeSpan must invalidate cache and read updated span');

    // 8d. deleteSpan invalidates session cache.
    await archive.deleteSpan('sess-lru-11', 'cmp-11b');
    const afterDelete = await archive.search('sess-lru-11', 'beta_11');
    assert.equal(afterDelete.hits.length, 0);

    // 8e. External truncation/corruption of cached .jsonl.zstd invalidates cache, never caches !read.ok,
    // and emits unreadable caveat without deterministic negation.
    const zstdPath = join(archive.dirFor('sess-lru-11'), 'cmp-11.jsonl.zstd');
    const beforeStat = await stat(zstdPath);
    assert.ok(beforeStat.size > 16);
    await truncate(zstdPath, Math.max(4, beforeStat.size - 8));

    readSpanCalls = 0;
    const afterTrunc = await archive.search('sess-lru-11', 'alpha_11');
    assert.ok(readSpanCalls > 0, 'external file size/mtime mutation must invalidate cached signature');
    assert.equal(afterTrunc.unreadable.length, 1);
    assert.equal(afterTrunc.hits.length, 0);
    assert.equal(
      archive._searchCache.get('sess-lru-11')?.spans?.has('cmp-11'),
      false,
      '!read.ok span must NEVER be cached',
    );
    const toolCorruptOut = await tools.runTool(
      'history_search',
      archive,
      { query: 'alpha_11' },
      { session: { id: 'sess-lru-11' } },
    );
    assert.match(toolCorruptOut, /No readable archived span contains/);
    assert.match(toolCorruptOut, /could not be read completely/);
    assert.doesNotMatch(toolCorruptOut, /^No archived span contains/);

    // 8f. Partial damaged legacy .jsonl returns hit with incomplete + ⚠️(incomplete archive) and never caches!
    const dmgSession = 'sess-damaged-jsonl';
    await archive.writeSpan({
      sessionId: dmgSession,
      compactionId: 'cmp-dmg-1',
      entries: [makeEntry(1, 'user', 'Keep legacy retention guard active.')],
    });
    const dmgZstd = join(archive.dirFor(dmgSession), 'cmp-dmg-1.jsonl.zstd');
    await unlink(dmgZstd);
    const dmgPlain = join(archive.dirFor(dmgSession), 'cmp-dmg-1.jsonl');
    await writeFile(
      dmgPlain,
      `${JSON.stringify(makeEntry(1, 'user', 'Keep legacy retention guard active.'))}\n{corrupt-json-line\n`,
      'utf8',
    );

    const dmgToolOut = await tools.runTool(
      'history_search',
      archive,
      { query: 'legacy retention' },
      { session: { id: dmgSession } },
    );
    assert.match(dmgToolOut, /⚠️\(incomplete archive\)/);
    assert.match(dmgToolOut, /could not be read completely/);
    assert.equal(archive._searchCache.get(dmgSession)?.spans?.has('cmp-dmg-1'), false);

    // 8g. External unlink of cached .jsonl.zstd is detected via missing file and reports unreadable.
    const delSession = 'sess-unlink-1';
    await archive.writeSpan({
      sessionId: delSession,
      compactionId: 'cmp-unlinked',
      entries: [makeEntry(1, 'user', 'Verify external deletion guard.')],
    });
    await archive.search(delSession, 'deletion');
    assert.equal(archive._searchCache.get(delSession)?.spans?.has('cmp-unlinked'), true);
    await unlink(join(archive.dirFor(delSession), 'cmp-unlinked.jsonl.zstd'));
    const afterUnlink = await archive.search(delSession, 'deletion');
    assert.equal(afterUnlink.unreadable[0]?.reason, 'missing');
    assert.equal(archive._searchCache.get(delSession)?.spans?.has('cmp-unlinked'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 9. Compact df === 1 posting storage & stats() ───────────────────────────

await test('compact-bm25f-index-stores-df1-terms-as-2-element-tuples-and-reports-stats', () => {
  const span = prepareSpanForSearch({
    compactionId: 'cmp-df1',
    entries: [
      makeEntry(1, 'user', 'sharedTerm uniqueAlpha'),
      makeEntry(2, 'assistant', 'sharedTerm uniqueBeta'),
    ],
  });
  const index = new CompactBM25FIndex([span]);
  const st = index.stats();
  assert.equal(st.docCount, 2);
  assert.ok(st.df1Count >= 2, `expected at least 2 df===1 terms, got ${st.df1Count}`);
  assert.ok(st.multiDocTermCount >= 1);
  assert.equal(st.termCount, st.df1Count + st.multiDocTermCount);

  const uniqueAlphaPosting = index.postings.get('auniquealpha');
  const uniqueBetaPosting = index.postings.get('auniquebeta');
  const sharedPosting = index.postings.get('asharedterm');
  assert.ok(Array.isArray(uniqueAlphaPosting) && uniqueAlphaPosting.length === 2, 'df===1 term must be stored as 2-element [docId, tfTilde]');
  assert.ok(Array.isArray(uniqueBetaPosting) && uniqueBetaPosting.length === 2, 'df===1 term must be stored as 2-element [docId, tfTilde]');
  assert.ok(Array.isArray(sharedPosting) && sharedPosting.length === 4, 'df===2 term must expand to 4 elements');
});

// ── 10. B1 Stemming + Hyphenated Compounds + Stopwords + Aspect Overlap Dedup ─

await test('B1-stemming-hyphenated-compounds-stopwords-and-overlap-dedup', () => {
  // 10a. Conservative English stemming parity + protective bounds
  assert.equal(lightEnglishStem('retrying'), lightEnglishStem('retried'));
  assert.equal(lightEnglishStem('retried'), lightEnglishStem('retry'));
  assert.equal(lightEnglishStem('retries'), lightEnglishStem('retry'));
  assert.equal(lightEnglishStem('connections'), 'connect');
  assert.equal(lightEnglishStem('connection'), 'connect');
  assert.equal(lightEnglishStem('connected'), 'connect');
  assert.equal(lightEnglishStem('connecting'), 'connect');
  assert.equal(lightEnglishStem('status'), 'status');
  assert.equal(lightEnglishStem('process'), 'process');
  assert.equal(lightEnglishStem('exceed'), 'exceed');
  assert.equal(lightEnglishStem('thing'), 'thing');

  // 10b. Stopwords expanded + fallback for stopword-only query
  const withStop = tokenizeForSearch('should retrying without would about retry', { isQuery: true });
  assert.equal(withStop.includes('ashould'), false);
  assert.equal(withStop.includes('awould'), false);
  assert.equal(withStop.includes('aabout'), false);
  assert.ok(withStop.includes('sretry'));
  assert.ok(tokenizeForSearch('would about should', { isQuery: true }).length >= 3);

  // 10c. Hyphenated compound + stem cross-matching
  const hypTokens = tokenizeForSearch('rate-limit');
  assert.ok(hypTokens.includes('aratelimit'), `expected aratelimit in ${JSON.stringify(hypTokens)}`);
  assert.ok(hypTokens.includes('sratelimit'), `expected sratelimit in ${JSON.stringify(hypTokens)}`);

  const span = prepareSpanForSearch({
    compactionId: 'cmp-b1',
    entries: [
      makeEntry(1, 'user', 'Must retry database connection pool after failover.'),
      makeEntry(2, 'assistant', 'Enabled global rate-limit protection for billing.'),
      makeEntry(3, 'assistant', 'Only mentions retry once without storage or quorum.'),
      makeEntry(4, 'user', 'Adjusting ratelimits to 120 req/min.'),
    ],
  });
  const idx = new CompactBM25FIndex([span]);

  // Inflected query hits stemmed docs
  const inflected = idx.search('retrying connected database');
  assert.ok(inflected.hits.some((h) => h.seq === 1), 'stemmed retry+connect must hit seq=1');
  // Precision Guard negative control: seq=3 matches only 1 aspect ("retry" -> aretry+sretry counts ONCE, not twice!)
  assert.equal(
    inflected.hits.some((h) => h.seq === 3),
    false,
    'single-word a<w>+s<stem> match must count as 1 aspect and fail 3-aspect precision guard',
  );

  // Hyphenated query <-> unhyphenated joined compound
  const hypQueryRes = idx.search('rate-limit');
  assert.ok(hypQueryRes.hits.some((h) => h.seq === 2));
  assert.ok(hypQueryRes.hits.some((h) => h.seq === 4), 'rate-limit query must match ratelimits');

  const joinedQueryRes = idx.search('ratelimited');
  assert.ok(joinedQueryRes.hits.some((h) => h.seq === 2), 'ratelimited query must match rate-limit');
});

// ── 11. B2 Submodular Uncovered Query-Aspect Selection + Same-Span Decay ───

await test('B2-submodular-diversity-surfaces-uncovered-aspect-and-preserves-exact-recall', () => {
  // Span 0 has 4 stronger entries covering ONLY "alpha"; Span 1 has 1 longer tool entry covering ONLY "beta"
  // (so without B2, top-3 raw BM25F would return 3 redundant Span 0 "alpha" items and crowd out "beta"!).
  const span0 = prepareSpanForSearch({
    compactionId: 'cmp-b2-0',
    entries: [
      makeEntry(1, 'user', 'alpha alpha quota.'),
      makeEntry(2, 'user', 'alpha check rule.'),
      makeEntry(3, 'user', 'alpha step log.'),
      makeEntry(4, 'user', 'alpha note ok.'),
    ],
  });
  const span1 = prepareSpanForSearch({
    compactionId: 'cmp-b2-1',
    entries: [
      makeEntry(
        10,
        'tool',
        'Diagnostics beta fallback check during lengthy routine verification batch across multiple unrelated subsystems ok.',
      ),
    ],
  });
  // Add background corpus so df <= max(12, 0.35*N) and aspect IDFs remain selective.
  const bg = prepareSpanForSearch({
    compactionId: 'cmp-b2-bg',
    entries: Array.from({ length: 12 }, (_, i) => makeEntry(20 + i, 'assistant', `Background CSS step ${i}.`)),
  });

  const idx = new CompactBM25FIndex([span0, span1, bg]);
  const res = idx.search('alpha beta', { limit: 3, debug: true });
  const seqs = res.hits.map((h) => h.seq);
  assert.ok(seqs.includes(10), `expected uncovered aspect beta seq=10 in ${JSON.stringify(seqs)}`);
  assert.ok(seqs.some((s) => s >= 1 && s <= 4), `expected top alpha entry in ${JSON.stringify(seqs)}`);
  assert.equal(res.funnel.selectedDocIds.length, 3);

  // Exact recall floor negative control: 5 exact matches in Span 0 must ALL beat weak non-exact BM25 in Span 1.
  const exactSpan0 = prepareSpanForSearch({
    compactionId: 'cmp-ex-0',
    entries: Array.from({ length: 5 }, (_, i) =>
      makeEntry(100 + i, 'user', `Enforce EXACT_GATE_TOKEN_ALPHA plus zeta policy ${i}.`),
    ),
  });
  const exactWeakSpan1 = prepareSpanForSearch({
    compactionId: 'cmp-ex-1',
    entries: [makeEntry(200, 'assistant', 'Minor note referencing zeta calibration only.')],
  });
  const exactIdx = new CompactBM25FIndex([exactSpan0, exactWeakSpan1, bg]);
  const exactRes = exactIdx.search('EXACT_GATE_TOKEN_ALPHA zeta', { limit: 5 });
  assert.equal(
    exactRes.hits.filter((h) => h.matchKind === 'exact').length,
    5,
    'same-span decay must never drop exact matches below non-exact BM25F',
  );
});

// ── 12. B3 5-Gate Cross-Span 2-Hop Retrieval + B5 Retrieval Funnel ──────────

await test('B3-five-gate-cross-span-two-hop-positive-and-negative-controls-with-B5-funnel', () => {
  // Build corpus with N >= 14 across 3 spans:
  // - Query: "postgresql archival stalled" (3 rare aspects when df<=8)
  // - Span 0 seq=1 (seed): matches ALL 3 query terms + ultra-rare bridge "pg_wal_9918"
  // - Span 1 seq=50 (2-hop target): matches ONLY 1 query term ("archival") -> rejected by 3-term Precision Guard!
  //   Shares ultra-rare bridge "pg_wal_9918" -> rescued by 5-Gate Cross-Span 2-Hop!
  // - Span 1 seq=51 (negative control): matches bridge "pg_wal_9918" ONLY with 0 query tokens -> MUST NOT rescue!
  const span0 = prepareSpanForSearch({
    compactionId: 'cmp-hop-0',
    entries: [
      makeEntry(1, 'user', 'PostgreSQL archival stalled after checkpoint; observed error pg_wal_9918 during WAL rotation.'),
      makeEntry(2, 'assistant', 'PostgreSQL replication status normal on read replica.'),
      makeEntry(3, 'assistant', 'Scheduled stalled job cleanup check.'),
      makeEntry(4, 'assistant', 'Routine vacuum telemetry check finished cleanly.'),
    ],
  });
  const span1 = prepareSpanForSearch({
    compactionId: 'cmp-hop-1',
    entries: [
      makeEntry(50, 'user', 'Mitigation for pg_wal_9918 requires flushing archival segment queue manually.'),
      makeEntry(51, 'tool', 'Incident tag pg_wal_9918 closed without further notes.'),
      makeEntry(52, 'assistant', 'Frontend theme palette updated to slate.'),
      makeEntry(53, 'assistant', 'Updated unit test snapshots for header.'),
      makeEntry(54, 'assistant', 'Linting finished across client module.'),
    ],
  });
  const span2 = prepareSpanForSearch({
    compactionId: 'cmp-hop-2',
    entries: Array.from({ length: 6 }, (_, i) =>
      makeEntry(70 + i, 'assistant', `Independent CSS layout note ${i} in staging.`),
    ),
  });

  const idx = new CompactBM25FIndex([span0, span1, span2]);

  // Default debug=false omits funnel completely
  const noDebug = idx.search('postgresql archival stalled', { limit: 6 });
  assert.equal('funnel' in noDebug, false, 'debug=false must omit funnel');

  // With debug=true returns funnel and surfaces cross-span seq=50 with secondHop: true
  const res = idx.search('postgresql archival stalled', { limit: 6, debug: true });
  assert.ok(res.funnel, 'debug=true must return funnel');
  assert.deepEqual(
    Object.keys(res.funnel).sort(),
    ['bm25TopDocIds', 'exactDocIds', 'newerUpdateDocIds', 'secondHopDocIds', 'selectedDocIds'],
  );
  assert.equal(res.hits[0].seq, 1, 'direct rank-1 seq=1 must never be displaced');
  const hopHit = res.hits.find((h) => h.seq === 50);
  assert.ok(hopHit, `expected cross-span 2-hop hit seq=50 in ${JSON.stringify(res.hits)}`);
  assert.equal(hopHit.secondHop, true);
  assert.equal(res.hits.some((h) => h.seq === 51), false, 'bridge without query content token must fail Gate 3');
  assert.ok(res.funnel.secondHopDocIds.includes(4), 'expected docId=4 (seq=50) in funnel.secondHopDocIds');

  // Also test searchPreparedSpans forwards debug funnel
  const directFn = searchPreparedSpans([span0, span1, span2], 'postgresql archival stalled', { limit: 6, debug: true });
  assert.ok(directFn.funnel && directFn.funnel.secondHopDocIds.length >= 1);

  // Negative controls:
  // (a) Single span (< 2 spans) -> 2-hop must NOT run
  const singleSpanIdx = new CompactBM25FIndex([
    prepareSpanForSearch({
      compactionId: 'cmp-single',
      entries: [
        ...span0.docs.map((d) => makeEntry(d.seq, d.role, d.primary)),
        ...span1.docs.map((d) => makeEntry(d.seq, d.role, d.primary)),
        ...span2.docs.map((d) => makeEntry(d.seq, d.role, d.primary)),
      ],
    }),
  ]);
  const singleRes = singleSpanIdx.search('postgresql archival stalled', { limit: 6, debug: true });
  assert.equal(singleRes.funnel.secondHopDocIds.length, 0, 'single span must suppress 2-hop');

  // (b) N < 12 -> 2-hop must NOT run
  const tinyIdx = new CompactBM25FIndex([span0, span1]);
  assert.equal(tinyIdx.stats().docCount, 9);
  const tinyRes = tinyIdx.search('postgresql archival stalled', { limit: 6, debug: true });
  assert.equal(tinyRes.funnel.secondHopDocIds.length, 0, 'N < 12 must suppress 2-hop');

  // (c) Look-alike suppression negative control: Seed1 is sharp (`top1/top5Median >= 1.45`),
  // while candidate bridge `shared_lookalike_sig` appears in >= 50% of Top-2..10 look-alikes -> MUST be suppressed!
  const lookAlikeEntries0 = [
    makeEntry(1, 'user', 'Cobalt reactor overloaded overloaded cobalt reactor telemetry snapshot alert; shared_lookalike_sig detected.'),
    ...Array.from({ length: 4 }, (_, i) =>
      makeEntry(2 + i, 'tool', `Minor verbose cobalt reactor log padding alpha beta gamma delta ${i}; shared_lookalike_sig present.`),
    ),
  ];
  const laSpan0 = prepareSpanForSearch({ compactionId: 'cmp-la-0', entries: lookAlikeEntries0 });
  const laSpan1 = prepareSpanForSearch({
    compactionId: 'cmp-la-1',
    entries: [
      makeEntry(20, 'user', 'Cobalt check triggered on shared_lookalike_sig fallback.'),
      ...Array.from({ length: 8 }, (_, i) => makeEntry(21 + i, 'assistant', `Filler note ${i} clean.`)),
    ],
  });
  const laIdx = new CompactBM25FIndex([laSpan0, laSpan1]);
  const laRes = laIdx.search('cobalt reactor overloaded', { limit: 8, debug: true });
  assert.equal(laRes.funnel.secondHopDocIds.length, 0, 'look-alike bridge must be suppressed');

  // (d) Flat plateau negative control (`top1Bm25 / top5Median < 1.45`) -> 2-hop must NOT fire
  const flatSpan0 = prepareSpanForSearch({
    compactionId: 'cmp-flat-0',
    entries: Array.from({ length: 5 }, (_, i) =>
      makeEntry(1 + i, 'user', `Zirconia shard overloaded parity error ${i} plus flat_bridge_tok.`),
    ),
  });
  const flatSpan1 = prepareSpanForSearch({
    compactionId: 'cmp-flat-1',
    entries: [
      makeEntry(20, 'user', 'Zirconia note mentioning flat_bridge_tok only.'),
      ...Array.from({ length: 8 }, (_, i) => makeEntry(21 + i, 'assistant', `Unrelated flat note ${i}.`)),
    ],
  });
  const flatIdx = new CompactBM25FIndex([flatSpan0, flatSpan1]);
  const flatRes = flatIdx.search('zirconia shard overloaded', { limit: 8, debug: true });
  assert.equal(flatRes.funnel.secondHopDocIds.length, 0, 'flat score plateau must suppress 2-hop');
});

console.log(JSON.stringify({
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
}, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
