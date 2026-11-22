import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveConfig } from '../lib/config.js';
import { continuationBudgetInfo } from '../lib/continuation-budget.js';
import { freezeContinuation, bindContinuationProgress, readPendingContinuation } from '../lib/continuation-pending.js';
import { ContinuationProgressStore } from '../lib/continuation-progress.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { buildCompactionInstruction } from '../lib/prompt.js';
import { clearResumableCompaction, readResumableCompaction, writeResumableCompaction } from '../lib/state.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error?.message ?? String(error), stack: error?.stack });
  }
}

const HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeSummary(note = 'Preserve strict integer cents.') {
  return HEADINGS.map((h, i) => {
    if (i === 5) return `${h}\n[filled by engine]`;
    return `${h}\n${note}`;
  }).join('\n\n');
}

const CONT_NOTES = [
  '## Goal',
  'Preserve strict integer cents.',
  '## State',
  'Earlier evidence archived cleanly.',
  '## Next',
  'Continue remaining steps.',
  '## Uncertain',
  'No unresolved disputes.',
].join('\n');

async function createTrapFixture({
  extraConfig = {},
  windowTokens = 200000,
  thresholdRatio = 0.8,
  streamHandler = null,
} = {}) {
  const baseTmp = process.env.WEAVE_TEST_ROOT ?? tmpdir();
  const root = await mkdtemp(join(baseTmp, 'weave-hotfix-041-'));
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const calls = [];
  const hooks = new Map();
  const inboxQueue = [];

  const session = {
    id: `hf041-${randomUUID().slice(0, 8)}`,
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => [...events],
    requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: 4096 } }),
    toolHistory: () => [],
    deriveEventMessage(ev) {
      if (!ev) return undefined;
      if (ev.type === 'user/message') return ev.data;
      if (ev.type === 'system/message' || ev.type === 'assistant/message' || ev.type === 'tool/result') {
        return ev.data?.message;
      }
      return undefined;
    },
    append(type, data, opts = {}) {
      const ev = { seq: events.length, time: Date.now(), type, data, ...opts };
      events.push(ev);
      const op = opts.surfaceOp;
      if (op === 'append' || op?.op === 'append') {
        surface.nodes.push(ev.seq);
      } else if (op?.op === 'replace') {
        const sIdx = surface.nodes.indexOf(op.startSeq);
        const eIdx = surface.nodes.indexOf(op.endSeq);
        assert.ok(sIdx >= 0 && eIdx >= sIdx, `Invalid replace span ${op.startSeq}..${op.endSeq}`);
        surface.nodes.splice(sIdx, eIdx - sIdx + 1, ev.seq);
        surface.replaceGeneration += 1;
      }
      return ev;
    },
  };

  const addSystem = (text) =>
    session.append(
      'system/message',
      { message: { id: randomUUID(), role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] } },
      { surfaceOp: 'append' },
    );

  const addUser = (text) =>
    session.append(
      'user/message',
      { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
      { surfaceOp: 'append' },
    );

  const addAssistant = (text) =>
    session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text }] },
      },
      { surfaceOp: 'append' },
    );

  const measure = () => {
    const nodes = surface.nodes.map((seq) => ({
      seq,
      tokens: approxTokens(blocksToText(session.deriveEventMessage(events[seq])?.content)),
    }));
    return { nodes, totalTokens: nodes.reduce((sum, item) => sum + item.tokens, 0) };
  };

  const ctx = {
    on(name, fn) {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push(fn);
    },
    provide() {},
    logger: { info() {}, warn() {}, error() {} },
    sessions: {
      get: (id) => (id === session.id ? session : undefined),
      async flush() {
        return true;
      },
    },
    tokenMeter: {
      estimateMessage: (m) => approxTokens(blocksToText(m?.content)),
      measure,
    },
    llm: {
      async resolveModelInfo() {
        return { contextWindow: windowTokens, defaultMaxTokens: 8192 };
      },
      async *stream(opts) {
        const idx = calls.length;
        calls.push({ idx, messages: opts.messages, provider: opts.provider, model: opts.model });
        if (streamHandler) {
          yield* streamHandler(opts, idx, calls);
          return;
        }
        const sysText = JSON.stringify(opts.messages?.[0] ?? '');
        const text = sysText.includes('working notes') || sysText.includes('Previous accepted working notes') || sysText.includes('four exact nonempty')
          ? CONT_NOTES
          : makeSummary();
        yield { type: 'text-delta', text };
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 } };
        yield { type: 'finish', kind: 'stop' };
      },
    },
  };

  const config = resolveConfig({
    archiveDir: join(root, 'archive'),
    language: 'en',
    auto: true,
    windowFallback: windowTokens,
    thresholdRatio,
    headroomTokens: 4000,
    maxTokens: 4096,
    summaryRetryCount: 0,
    summaryRetryDelayMs: 0,
    maxSummaryChunks: 32,
    ...extraConfig,
  }).config;

  const engine = new WeaveCompactionEngine(ctx, config);
  engine.historyToolsAvailable = true;
  engine.log = () => {};

  const agent = {
    session,
    options: { provider: 'p', model: 'm' },
    inbox: {
      nextStep: inboxQueue,
      nextTurn: [],
      prepend(_slot, msg) {
        inboxQueue.unshift(msg);
      },
    },
    runMaintenance: (fn) => fn(new AbortController().signal),
  };

  return {
    root,
    session,
    events,
    surface,
    calls,
    hooks,
    inboxQueue,
    engine,
    agent,
    measure,
    addSystem,
    addUser,
    addAssistant,
    async dispose() {
      engine.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

// ── 1. Multi-chunk compactIfNeeded continues past threshold until <= reductionTarget (serial & concurrent)
for (const concurrency of [1, 2]) {
  await test(`1-multichunk-compactIfNeeded-continues-until-reductionTarget-concurrency-${concurrency}`, async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const f = await createTrapFixture({
      windowTokens: 200000,
      thresholdRatio: 0.8,
      extraConfig: {
        summaryConcurrency: concurrency,
        summaryInputMaxBytes: 78000,
        minimumReductionRatio: 0.4,
        retainTokens: 200,
        cacheMaxCheckpoints: 10,
      },
      streamHandler: async function* (opts) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (concurrency > 1) await new Promise((r) => setTimeout(r, 15));
          const sys = JSON.stringify(opts.messages?.[0] ?? '');
          const isCont = sys.includes('working notes') || sys.includes('four headings') || sys.includes('## Goal');
          assert.equal(isCont, false, 'multi-chunk normal compaction must NOT trigger continuation rollover');
          yield { type: 'text-delta', text: makeSummary() };
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 } };
          yield { type: 'finish', kind: 'stop' };
        } finally {
          inFlight -= 1;
        }
      },
    });
    try {
      f.addSystem('Stable system prompt.');
      // 10 groups * ~68,000 chars (~17,000 tokens each) -> ~170,000 total tokens (> 160,000 threshold).
      // Reduction target = floor(170,000 * 0.6) ~= 102,000.
      // Chunk 0 drops total to ~153,000 (< 160,000 thresholdTokens, > 102,000 reductionTarget).
      for (let i = 0; i < 10; i += 1) {
        f.addUser(`Step ${i}: Preserve strict integer cents.`);
        f.addAssistant(`Trace group ${i}: ` + 'a'.repeat(68000));
      }
      f.addUser('Keep tail message.');
      f.session.append('turn/start', { turn: 1 });

      const before = f.measure().totalTokens;
      assert.ok(before >= 160000, `expected >= 160000 initial tokens, got ${before}`);
      const reductionTarget = Math.min(159999, Math.floor(before * 0.6));

      const result = await f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal);
      assert.ok(result, 'compactIfNeeded must commit chunks');
      assert.ok(!result.continuation, 'must complete with normal chunked compaction, zero continuation triggers');

      const after = f.measure().totalTokens;
      assert.ok(after <= reductionTarget, `final tokens (${after}) must reach <= reductionTarget (${reductionTarget})`);
      assert.ok(f.calls.length >= 4, `expected multi-chunk calls >= 4, got ${f.calls.length}`);
      assert.equal(readPendingContinuation(f.engine.sessionState, f.session), null);
      if (concurrency > 1) {
        assert.ok(maxInFlight >= 2, `concurrent batch should overlap workers (maxInFlight=${maxInFlight})`);
      }
    } finally {
      await f.dispose();
    }
  });
}

// ── 2. Optional auto-rollover failing at Page 0 after chunk 0 < thresholdTokens clears 0-progress lock
await test('2-optional-auto-rollover-fail-at-page0-below-threshold-clears-pendingContinuation', async () => {
  const f = await createTrapFixture({
    windowTokens: 200000,
    thresholdRatio: 0.8,
    extraConfig: {
      summaryConcurrency: 1,
      summaryInputMaxBytes: 120000,
      minimumReductionRatio: 0.5,
      retainTokens: 140000,
      continuationMaxExtraCalls: 0,
      summaryRetryCount: 0,
    },
    streamHandler: async function* (_opts, idx) {
      if (idx === 0) {
        yield { type: 'text-delta', text: makeSummary() };
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 } };
        yield { type: 'finish', kind: 'stop' };
        return;
      }
      // Page 0 of optional auto-rollover fails before accepting any page (acceptedPages === 0).
      throw Object.assign(new Error('HTTP 401 Unauthorized on continuation page 0'), { status: 401, code: 'UNAUTHORIZED' });
    },
  });
  try {
    f.addSystem('Stable system prompt.');
    // Chunk 0 (~20,000 tokens) sits before the retained ~146,000-token tail.
    f.addUser('Initial requirement: Preserve strict integer cents.');
    f.addAssistant('Chunk 0 payload: ' + 'b'.repeat(80000));
    f.addUser('Large retained tail: ' + 'c'.repeat(584000));
    f.session.append('turn/start', { turn: 1 });

    const before = f.measure().totalTokens;
    assert.ok(before >= 160000, `expected >= 160000 initial tokens, got ${before}`);

    await assert.rejects(() => f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal));

    // Chunk 0 committed & dropped totalTokens < 160000; rollover failed at Page 0 -> lock MUST be cleared!
    assert.equal(f.surface.replaceGeneration, 1, 'chunk 0 must remain committed');
    const afterFail = f.measure().totalTokens;
    assert.ok(afterFail < 160000, `expected tokens < 160000 after chunk 0, got ${afterFail}`);
    assert.equal(
      readPendingContinuation(f.engine.sessionState, f.session),
      null,
      '0-accepted-page continuationPending from failed optional auto-rollover must be cleared',
    );

    // Confirm session is not trapped on subsequent pre-step turns below threshold
    let nextCalls = 0;
    const preStep = f.hooks.get('agent/pre-step')[0];
    await preStep({ agent: f.agent, signal: new AbortController().signal, messages: [] }, async () => {
      nextCalls += 1;
    });
    assert.equal(nextCalls, 1, 'session must not remain trapped after failed optional auto-rollover');
  } finally {
    await f.dispose();
  }
});

// ── 3. Ordinary manual /compact: 0-progress clears lock (+ exhausted 5/5 budget), 2-page preserves, corrupt fails closed
await test('3-ordinary-manual-compact-zero-page-unlocks-paid-resumes-corrupt-fails-closed', async () => {
  // (a) Seeded acceptedPages === 0 with exhausted 5/5 call budget -> ordinary /compact clears lock & finishes normal chunked compaction
  const fxZero = await createTrapFixture({
    extraConfig: { summaryInputMaxBytes: 50000, summaryConcurrency: 1 },
  });
  try {
    fxZero.addSystem('Stable system.');
    const u1 = fxZero.addUser('Preserve strict integer cents.\n' + 'x'.repeat(28000));
    const a1 = fxZero.addAssistant('Evidence 1: ' + 'y'.repeat(28000));
    const u2 = fxZero.addUser('Step 2: Preserve strict integer cents.\n' + 'z'.repeat(28000));
    const a2 = fxZero.addAssistant('Evidence 2: ' + 'w'.repeat(28000));
    const targetSeqs = [u1.seq, a1.seq, u2.seq, a2.seq];

    const pending = freezeContinuation(fxZero.engine.sessionState, fxZero.session, targetSeqs);
    const progressKey = createHash('sha256').update('seeded-zero-page-exhausted').digest('hex');
    bindContinuationProgress(fxZero.engine.sessionState, fxZero.session, pending.id, progressKey);

    const progressRoot = join(fxZero.root, 'continuation-progress');
    const pStore = new ContinuationProgressStore(progressRoot, fxZero.session.id, progressKey);
    const exhaustedCalls = Array.from({ length: 5 }, (_, i) => ({
      page: 0,
      target: 'p/m',
      startedAt: new Date().toISOString(),
      completed: false,
      errorCode: `ERR_${i}`,
      usage: null,
    }));
    pStore.write(
      {
        segments: [
          { page: 0, start: 0, end: 100 },
          { page: 1, start: 0, end: 100 },
        ],
        next: 0,
        memory: '',
        last: null,
        receipts: [],
        calls: exhaustedCalls,
      },
      0,
    );
    assert.ok(existsSync(pStore.file), 'progress file must exist before ordinary /compact');

    const res = await fxZero.engine.compactNow(fxZero.agent, new AbortController().signal, 'cmd-zero-unlock', false);
    assert.ok(res, 'ordinary manual /compact must succeed after clearing 0-page lock');
    assert.ok(!res.continuation, 'ordinary /compact should run normal chunked compaction, not continuation');
    assert.equal(readPendingContinuation(fxZero.engine.sessionState, fxZero.session), null, 'continuationPending lock must be cleared');
    assert.equal(existsSync(pStore.file), true, 'disk continuation-progress ledger must stay intact on disk');
    const diskRecord = pStore.read();
    assert.equal(diskRecord.data.calls.length, 5, 'disk usage ledger must remain intact');
  } finally {
    await fxZero.dispose();
  }

  // (b) Seeded/interrupted acceptedPages === 2 paid pages -> ordinary /compact preserves lock and resumes continuation
  let failPage3Once = true;
  const fxPaid = await createTrapFixture({
    extraConfig: { summaryInputMaxBytes: 50000, summaryConcurrency: 1, summaryRetryCount: 0 },
    streamHandler: async function* (_opts, idx) {
      if (idx === 2 && failPage3Once) {
        failPage3Once = false;
        throw Object.assign(new Error('transient error at page 3'), { code: 'ECONNRESET' });
      }
      yield { type: 'text-delta', text: CONT_NOTES };
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 } };
      yield { type: 'finish', kind: 'stop' };
    },
  });
  try {
    fxPaid.addSystem('Stable system.');
    fxPaid.addUser('Preserve strict integer cents.\n' + 'archiveblob '.repeat(6000));
    fxPaid.addAssistant('evidence '.repeat(4000));

    await assert.rejects(() => fxPaid.engine.compactNow(fxPaid.agent, new AbortController().signal, 'cmd-paid-start', true));
    const savedPending = readPendingContinuation(fxPaid.engine.sessionState, fxPaid.session);
    assert.ok(savedPending?.progressKey, 'continuationPending must be saved after 2 accepted pages');
    const accepted = fxPaid.engine._readPendingContinuationAcceptedPages(fxPaid.session, savedPending);
    assert.equal(accepted, 2, 'must read acceptedPages === 2 from disk progress');

    const callsBeforeResume = fxPaid.calls.length;
    const resumed = await fxPaid.engine.compactNow(fxPaid.agent, new AbortController().signal, 'cmd-paid-ordinary', false);
    assert.ok(resumed?.continuation, 'ordinary /compact must preserve paid pages and resume continuation');
    assert.equal(resumed.continuation.pendingId, savedPending.id);
    assert.equal(resumed.continuation.resumedPages, 2, 'must resume from the 2 paid pages');
    assert.equal(fxPaid.calls.length - callsBeforeResume, resumed.continuation.pages.length - 2);
    assert.equal(readPendingContinuation(fxPaid.engine.sessionState, fxPaid.session), null);
  } finally {
    await fxPaid.dispose();
  }

  // (c) Corrupt continuation-progress file -> fails closed WITHOUT clearing continuationPending
  const fxCorrupt = await createTrapFixture({
    extraConfig: { summaryInputMaxBytes: 50000, summaryConcurrency: 1 },
  });
  try {
    fxCorrupt.addSystem('Stable system.');
    const u1 = fxCorrupt.addUser('Preserve strict integer cents.\n' + 'k'.repeat(28000));
    const a1 = fxCorrupt.addAssistant('Evidence: ' + 'm'.repeat(28000));
    const pending = freezeContinuation(fxCorrupt.engine.sessionState, fxCorrupt.session, [u1.seq, a1.seq]);
    const progressKey = createHash('sha256').update('corrupt-progress-key').digest('hex');
    bindContinuationProgress(fxCorrupt.engine.sessionState, fxCorrupt.session, pending.id, progressKey);

    const pStore = new ContinuationProgressStore(join(fxCorrupt.root, 'continuation-progress'), fxCorrupt.session.id, progressKey);
    await mkdir(join(pStore.file, '..'), { recursive: true });
    await writeFile(pStore.file, '{"corrupt": true, "checksum": "bad"}\n', 'utf8');

    const callsBefore = fxCorrupt.calls.length;
    await assert.rejects(
      () => fxCorrupt.engine.compactNow(fxCorrupt.agent, new AbortController().signal, 'cmd-corrupt', false),
      (err) => err?.code === 'CONTINUATION_PROGRESS_INVALID' || err?.cause?.code === 'CONTINUATION_PROGRESS_INVALID' || /continuation/i.test(err?.message ?? ''),
    );
    assert.equal(fxCorrupt.calls.length, callsBefore, 'corrupt continuation-progress must fail closed before LLM call');
    assert.equal(
      readPendingContinuation(fxCorrupt.engine.sessionState, fxCorrupt.session)?.id,
      pending.id,
      'corrupt continuation-progress must NEVER clear continuationPending',
    );
  } finally {
    await fxCorrupt.dispose();
  }
});

// ── 4. agent/pre-step non-blocking below thresholdTokens for exhausted budget / paused_budget / paused_failure, blocking >= thresholdTokens
await test('4-agent-pre-step-non-blocking-below-threshold-and-blocking-above-threshold', async () => {
  // (a) Exhausted CONTINUATION_CALL_BUDGET (requestsThisAttempt === 0) via pendingContinuation
  const fxBudget = await createTrapFixture({
    windowTokens: 200000,
    thresholdRatio: 0.8,
    extraConfig: {
      auto: true,
      summaryInputMaxBytes: 120000,
      continuationMaxExtraCalls: 0,
      summaryRetryCount: 0,
    },
    streamHandler: async function* () {
      throw Object.assign(new Error('transport failure'), { code: 'ECONNRESET' });
    },
  });
  try {
    fxBudget.addSystem('Stable system.');
    fxBudget.addUser('Preserve strict integer cents.\n' + 'archiveblob '.repeat(24000)); // ~72k tokens
    fxBudget.addAssistant('evidence '.repeat(32000)); // ~72k tokens -> ~144k total (< 160k)

    // Exhaust budget via manual continuation (1 failed call with extraCalls=0).
    await assert.rejects(() => fxBudget.engine.compactNow(fxBudget.agent, new AbortController().signal, 'cmd-exhaust', true));
    const pending = readPendingContinuation(fxBudget.engine.sessionState, fxBudget.session);
    assert.ok(pending?.progressKey);

    const beforeTotal = fxBudget.measure().totalTokens;
    assert.ok(beforeTotal > 130000 && beforeTotal < 160000, `expected 130k..160k below threshold, got ${beforeTotal}`);

    // Below thresholdTokens: agent/pre-step MUST allow chat turns through with 0 LLM calls
    // (both via resumableCompaction transition and directly via compactIfNeeded('pressure')).
    fxBudget.session.append('turn/start', { turn: 2 });
    const callsBefore = fxBudget.calls.length;
    let nextCalls = 0;
    const preStep = fxBudget.hooks.get('agent/pre-step')[0];
    const msgBelow = { id: 'msg-below', role: 'user', content: [{ type: 'text', text: 'Normal follow-up?' }] };
    await preStep({ agent: fxBudget.agent, signal: new AbortController().signal, messages: [msgBelow] }, async () => {
      nextCalls += 1;
      return { kind: 'enter' };
    });
    assert.equal(nextCalls, 1, 'pre-step must let chat proceed when totalTokens < thresholdTokens');
    assert.equal(fxBudget.calls.length, callsBefore, 'spent budget check must make 0 LLM calls');

    // Now clear resumableCompaction so pre-step invokes compactIfNeeded('pressure') directly on exhausted continuationPending:
    clearResumableCompaction(fxBudget.engine.sessionState, fxBudget.session.id);
    const msgBelowDirect = { id: 'msg-below-direct', role: 'user', content: [{ type: 'text', text: 'Another below-threshold turn' }] };
    await preStep({ agent: fxBudget.agent, signal: new AbortController().signal, messages: [msgBelowDirect] }, async () => {
      nextCalls += 1;
      return { kind: 'enter' };
    });
    assert.equal(nextCalls, 2, 'pre-step must also allow chat when compactIfNeeded throws zero-new-request CONTINUATION_CALL_BUDGET below threshold');
    assert.equal(fxBudget.calls.length, callsBefore, 'direct pressure check below threshold must make 0 LLM calls');

    // Above thresholdTokens: agent/pre-step MUST STILL block with COMPACTION_AUTOMATIC_BLOCKED and restore claimed input.
    while (fxBudget.measure().totalTokens < 161000) {
      fxBudget.addAssistant('Oversize context growth: ' + 'g'.repeat(80000));
    }
    const msgAbove = { id: 'msg-above', role: 'user', content: [{ type: 'text', text: 'Over threshold turn' }] };
    await assert.rejects(
      () => preStep({ agent: fxBudget.agent, signal: new AbortController().signal, messages: [msgAbove] }, async () => {
        nextCalls += 1;
      }),
      (e) => e.code === 'COMPACTION_AUTOMATIC_BLOCKED' && e.failureCode === 'CONTINUATION_CALL_BUDGET',
    );
    assert.equal(nextCalls, 2, 'pre-step MUST block turn when totalTokens >= thresholdTokens');
    assert.equal(fxBudget.inboxQueue[0]?.id, 'msg-above', 'claimed input must be restored on block');
  } finally {
    await fxBudget.dispose();
  }

  // (b) resumableCompaction.status === 'paused_budget'
  const fxPausedBudget = await createTrapFixture({
    windowTokens: 200000,
    thresholdRatio: 0.8,
    extraConfig: { auto: true, summaryInputMaxBytes: 120000, continuationMaxExtraCalls: 0 },
    streamHandler: async function* () {
      throw Object.assign(new Error('transport failure'), { code: 'ECONNRESET' });
    },
  });
  try {
    fxPausedBudget.addSystem('Stable system.');
    const u = fxPausedBudget.addUser('Preserve strict integer cents.\n' + 'p'.repeat(288000)); // ~72k tokens
    const a = fxPausedBudget.addAssistant('Detail: ' + 'q'.repeat(288000)); // ~72k tokens -> ~144k total (< 160k)
    const seqs = [u.seq, a.seq];
    await assert.rejects(() => fxPausedBudget.engine.compactNow(fxPausedBudget.agent, new AbortController().signal, 'cmd-paused-budget', true));
    assert.ok(readPendingContinuation(fxPausedBudget.engine.sessionState, fxPausedBudget.session)?.progressKey);
    writeResumableCompaction(fxPausedBudget.engine.sessionState, fxPausedBudget.session.id, {
      jobId: 'job-paused-budget',
      trigger: 'pressure',
      status: 'paused_budget',
      interruptReason: 'budget_exhausted',
      remainingSeqs: seqs,
      remainingSourceSha256: fxPausedBudget.engine._sourceHashForSeqs(fxPausedBudget.session, seqs),
      initialTotalNodes: seqs.length,
      completedNodes: 0,
      initialTotalTokens: 144000,
      completedTokens: 0,
      completedChunks: 0,
      waveCount: 0,
      batchCheckpointSeqs: [],
      consecutiveFailures: 1,
    });

    fxPausedBudget.session.append('turn/start', { turn: 2 });
    const preStep = fxPausedBudget.hooks.get('agent/pre-step')[0];
    let nextCalls = 0;
    const callsBefore = fxPausedBudget.calls.length;
    await preStep({ agent: fxPausedBudget.agent, signal: new AbortController().signal, messages: [] }, async () => {
      nextCalls += 1;
    });
    assert.equal(nextCalls, 1, 'paused_budget below thresholdTokens must allow chat turn');
    assert.equal(fxPausedBudget.calls.length, callsBefore);

    while (fxPausedBudget.measure().totalTokens < 161000) {
      fxPausedBudget.addAssistant('Push past threshold: ' + 'r'.repeat(80000));
    }
    await assert.rejects(
      () => preStep({ agent: fxPausedBudget.agent, signal: new AbortController().signal, messages: [] }, async () => {
        nextCalls += 1;
      }),
      (e) => e.code === 'COMPACTION_AUTOMATIC_BLOCKED' && e.failureCode === 'CONTINUATION_CALL_BUDGET',
    );
    assert.equal(nextCalls, 1);
  } finally {
    await fxPausedBudget.dispose();
  }

  // (c) resumableCompaction.status === 'paused_failure' (with circuit breaker tripped)
  const fxPausedFailure = await createTrapFixture({
    windowTokens: 200000,
    thresholdRatio: 0.8,
    extraConfig: { auto: true, failureThreshold: 3 },
  });
  try {
    fxPausedFailure.addSystem('Stable system.');
    const u = fxPausedFailure.addUser('Preserve strict integer cents.');
    const a = fxPausedFailure.addAssistant('Detail: ' + 's'.repeat(20000));
    const seqs = [u.seq, a.seq];
    fxPausedFailure.engine.sessionState.update(fxPausedFailure.session.id, (s) => ({ ...s, failures: 3, stopped: true }));
    writeResumableCompaction(fxPausedFailure.engine.sessionState, fxPausedFailure.session.id, {
      jobId: 'job-paused-failure',
      trigger: 'pressure',
      status: 'paused_failure',
      interruptReason: 'error',
      remainingSeqs: seqs,
      remainingSourceSha256: fxPausedFailure.engine._sourceHashForSeqs(fxPausedFailure.session, seqs),
      initialTotalNodes: seqs.length,
      completedNodes: 0,
      initialTotalTokens: 5000,
      completedTokens: 0,
      completedChunks: 0,
      waveCount: 0,
      batchCheckpointSeqs: [],
      consecutiveFailures: 3,
    });

    fxPausedFailure.session.append('turn/start', { turn: 2 });
    const preStep = fxPausedFailure.hooks.get('agent/pre-step')[0];
    let nextCalls = 0;
    await preStep({ agent: fxPausedFailure.agent, signal: new AbortController().signal, messages: [] }, async () => {
      nextCalls += 1;
    });
    assert.equal(nextCalls, 1, 'paused_failure below thresholdTokens must allow chat turn');
    assert.equal(fxPausedFailure.calls.length, 0);

    while (fxPausedFailure.measure().totalTokens < 161000) {
      fxPausedFailure.addAssistant('Push past threshold: ' + 't'.repeat(160000));
    }
    await assert.rejects(
      () => preStep({ agent: fxPausedFailure.agent, signal: new AbortController().signal, messages: [] }, async () => {
        nextCalls += 1;
      }),
      (e) => e.code === 'COMPACTION_AUTOMATIC_BLOCKED' && e.failureCode === 'COMPACTION_STOPPED',
    );
    assert.equal(nextCalls, 1);
  } finally {
    await fxPausedFailure.dispose();
  }
});

// ── 5. Direct compactIfNeeded('pressure') on exhausted pendingContinuation still throws CONTINUATION_CALL_BUDGET
await test('5-direct-compactIfNeeded-pressure-on-exhausted-pending-still-throws', async () => {
  const f = await createTrapFixture({
    windowTokens: 200000,
    thresholdRatio: 0.8,
    extraConfig: {
      auto: true,
      summaryInputMaxBytes: 50000,
      continuationMaxExtraCalls: 0,
      summaryRetryCount: 0,
    },
    streamHandler: async function* () {
      throw Object.assign(new Error('transport failure'), { code: 'ECONNRESET' });
    },
  });
  try {
    f.addSystem('Stable system.');
    f.addUser('Preserve strict integer cents.\n' + 'archiveblob '.repeat(4000));
    f.addAssistant('evidence '.repeat(2500));

    await assert.rejects(() => f.engine.compactNow(f.agent, new AbortController().signal, 'cmd-direct-exhaust', true));
    assert.ok(readPendingContinuation(f.engine.sessionState, f.session));
    assert.ok(f.measure().totalTokens < 160000);

    const callsBefore = f.calls.length;
    f.session.append('turn/start', { turn: 2 });
    const err = await f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal).then(
      () => assert.fail('Expected direct compactIfNeeded to reject'),
      (e) => e,
    );
    assert.equal(err.code, 'CONTINUATION_CALL_BUDGET');
    assert.equal(continuationBudgetInfo(err)?.requestsThisAttempt, 0);
    assert.equal(f.calls.length, callsBefore, 'direct compactIfNeeded must issue 0 LLM calls on exhausted budget');
  } finally {
    await f.dispose();
  }
});

console.log(
  JSON.stringify(
    {
      passed: results.filter((r) => r.pass).length,
      failed: results.filter((r) => !r.pass).length,
      results,
    },
    null,
    2,
  ),
);
if (results.some((r) => !r.pass)) process.exitCode = 1;
