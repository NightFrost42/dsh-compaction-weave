import assert from 'node:assert/strict';
import { PROGRESS_PHASES, CompactionProgressTracker } from '../lib/progress-tracker.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message, stack: error.stack });
  }
}

await test('idle-snapshot-matches-pinned-status-schema', () => {
  assert.ok(PROGRESS_PHASES.includes('idle'));
  assert.ok(PROGRESS_PHASES.includes('backing_up'));
  assert.ok(PROGRESS_PHASES.includes('migrating'));
  assert.ok(PROGRESS_PHASES.includes('folding'));
  assert.ok(PROGRESS_PHASES.includes('restoring'));

  const tracker = new CompactionProgressTracker();
  const snap = tracker.snapshot('s-idle');
  assert.equal(snap.active, false);
  assert.equal(snap.runId, null);
  assert.equal(snap.seq, 0);
  assert.equal(snap.sessionId, 's-idle');
  assert.equal(snap.phase, 'idle');
  assert.equal(snap.elapsedMs, 0);
  assert.equal(snap.maskedCount, 0);
  assert.equal(snap.maskedTokensSaved, 0);
  assert.equal(snap.stream, null);
  assert.equal(snap.error, null);
  assert.equal(snap.overallPercent, null);
  assert.equal(snap.overallProcessedTokens, null);
  assert.equal(snap.overallTotalTokens, null);
  assert.equal(snap.overallProcessedNodes, null);
  assert.equal(snap.overallTotalNodes, null);
  assert.equal(tracker.hasActiveRun('s-idle'), false);
});

await test('nested-withRun-joins-parent-runId-without-flicker-or-timer-reset', async () => {
  let now = 10000;
  const tracker = new CompactionProgressTracker({ clock: () => now, doneTtlMs: 60000 });
  const observed = [];

  await tracker.withRun('s1', { trigger: 'manual', turn: 4, phase: 'planning', beforeTokens: 480000 }, async (outerId) => {
    assert.ok(outerId);
    assert.equal(tracker.hasActiveRun('s1'), true);
    now += 1500;

    await tracker.withRun('s1', { phase: 'summarizing', chunkIndex: 1, chunkTotal: 3 }, async (innerId) => {
      assert.equal(innerId, outerId);
      now += 2500;
      tracker.updateStream('s1', { chunks: 12, textChars: 340, reasoningChars: 80, firstChunkMs: 420, idleMs: 50 });
      observed.push(tracker.snapshot('s1'));
    });

    // Inner exit must NOT flip active to false or reset startedAt!
    assert.equal(tracker.hasActiveRun('s1'), true);
    now += 1000;
    tracker.update('s1', { phase: 'folding', waveIndex: 1, waveTotal: 2, currentTokens: 190000 });
    observed.push(tracker.snapshot('s1'));
  });

  assert.equal(observed[0].runId, observed[1].runId);
  assert.equal(observed[0].startedAt, 10000);
  assert.equal(observed[0].elapsedMs, 4000);
  assert.equal(observed[0].stream.textChars, 340);
  assert.equal(observed[1].startedAt, 10000);
  assert.equal(observed[1].elapsedMs, 5000);
  assert.equal(observed[1].phase, 'folding');

  // Auto-finished on outer exit with terminal done TTL.
  const doneSnap = tracker.snapshot('s1');
  assert.equal(doneSnap.active, false);
  assert.equal(doneSnap.phase, 'done');
  assert.equal(doneSnap.finishedAt, 15000);
  assert.equal(doneSnap.elapsedMs, 5000);

  // Advances past doneTtlMs -> reverts cleanly to idle.
  now += 60001;
  assert.equal(tracker.snapshot('s1').phase, 'idle');
  assert.equal(tracker.snapshot('s1').active, false);
});

await test('strict-allowlist-never-leaks-prompts-drafts-or-credentials', async () => {
  let now = 50000;
  const tracker = new CompactionProgressTracker({ clock: () => now, errorTtlMs: 60000 });
  const fakeKeyA = 'sk-' + 'supersecretkey1234567890';
  const fakeKeyB = 'sk-' + 'anothersecret1234567890';

  await assert.rejects(
    tracker.withRun('s-sec', { trigger: 'migration', phase: 'migrating' }, async () => {
      tracker.update('s-sec', {
        phase: 'summarizing',
        summaryModel: 'deepseek/deepseek-v4.1-flash',
        messageKey: 'phase_summarizing',
        messageParams: { chunkIndex: 1, chunkTotal: 4, secretParamA: fakeKeyA, secretParamB: fakeKeyB },
        message: `Using ${fakeKeyA} for summary`,
        prompt: 'PRIVATE_USER_PROMPT',
        draftText: 'PRIVATE_DRAFT_TEXT',
      });
      tracker.updateStream('s-sec', {
        chunks: 5,
        textChars: 120,
        draft: 'PRIVATE_STREAM_DRAFT',
        reasoning: 'PRIVATE_REASONING',
        text: 'PRIVATE_CHUNK',
      });

      const live = tracker.snapshot('s-sec');
      const rawLive = JSON.stringify(live);
      assert.doesNotMatch(rawLive, /PRIVATE_USER_PROMPT|PRIVATE_DRAFT_TEXT|PRIVATE_STREAM_DRAFT|PRIVATE_REASONING|PRIVATE_CHUNK|supersecretkey|anothersecret/);
      assert.equal(live.summaryModel, 'deepseek/deepseek-v4.1-flash');
      assert.equal(live.stream.textChars, 120);
      assert.equal(live.messageParams.chunkIndex, 1);
      assert.equal(live.messageParams.secretParamA, undefined);
      assert.equal(live.messageParams.secretParamB, undefined);

      // Trying to set terminal phase via update() is ignored while active.
      tracker.update('s-sec', { phase: 'done' });
      assert.equal(tracker.snapshot('s-sec').phase, 'summarizing');

      throw Object.assign(new Error(`PRIVATE_TRANSCRIPT ${fakeKeyB}`), {
        code: 'BILI_MIGRATION_FAILED',
      });
    }),
  );

  const errSnap = tracker.snapshot('s-sec');
  assert.equal(errSnap.active, false);
  assert.equal(errSnap.phase, 'error');
  assert.equal(errSnap.error.code, 'BILI_MIGRATION_FAILED');
  assert.match(errSnap.error.message, /兼容迁移未完成/);
  assert.doesNotMatch(JSON.stringify(errSnap), /PRIVATE_TRANSCRIPT|anothersecret/);

  // Expires after errorTtlMs.
  now += 60001;
  assert.equal(tracker.snapshot('s-sec').phase, 'idle');
});

await test('stale-runId-callbacks-are-ignored-and-lru-bound-enforced', async () => {
  let now = 1000;
  const tracker = new CompactionProgressTracker({ maxSessions: 3, clock: () => now, doneTtlMs: 10000 });

  let firstRunId;
  await tracker.withRun('s-race', { phase: 'planning' }, async (runId) => {
    firstRunId = runId;
  });

  await tracker.withRun('s-race', { phase: 'masking' }, async (secondRunId) => {
    assert.notEqual(secondRunId, firstRunId);
    const updated = tracker.update('s-race', { phase: 'summarizing', maskedCount: 99 }, { runId: firstRunId });
    assert.equal(updated, false);
    assert.equal(tracker.snapshot('s-race').phase, 'masking');
    assert.equal(tracker.snapshot('s-race').maskedCount, 0);
  });

  // Bounded LRU maxSessions=3: adding 5 finished sessions keeps at most 3.
  for (let i = 0; i < 5; i += 1) {
    now += 100;
    await tracker.withRun(`lru-${i}`, { phase: 'planning' }, async () => {});
  }
  assert.equal(tracker.snapshot('lru-0').phase, 'idle');
  assert.equal(tracker.snapshot('lru-1').phase, 'idle');
  assert.equal(tracker.snapshot('lru-4').phase, 'done');
});

await test('concurrent-sessions-stay-completely-isolated', async () => {
  const tracker = new CompactionProgressTracker();
  let releaseA;
  const holdA = new Promise((r) => {
    releaseA = r;
  });

  const pA = tracker.withRun('sess-A', { trigger: 'manual', phase: 'summarizing', chunkIndex: 1, chunkTotal: 4 }, async () => {
    await holdA;
  });
  const pB = tracker.withRun('sess-B', { trigger: 'migration', phase: 'backing_up' }, async () => {
    assert.equal(tracker.snapshot('sess-A').phase, 'summarizing');
    assert.equal(tracker.snapshot('sess-B').phase, 'backing_up');
    tracker.update('sess-B', { phase: 'migrating', waveIndex: 1, waveTotal: 3 });
    assert.equal(tracker.snapshot('sess-A').chunkIndex, 1);
    assert.equal(tracker.snapshot('sess-B').waveIndex, 1);
  });

  await pB;
  assert.equal(tracker.snapshot('sess-A').active, true);
  assert.equal(tracker.snapshot('sess-B').active, false);
  assert.equal(tracker.snapshot('sess-B').phase, 'done');
  releaseA();
  await pA;
  assert.equal(tracker.snapshot('sess-A').phase, 'done');
});

await test('overallPercent-is-strictly-monotonic-within-runId-and-hits-100-on-finish', async () => {
  let now = 2000;
  const tracker = new CompactionProgressTracker({ clock: () => now, doneTtlMs: 30000, errorTtlMs: 30000 });

  await tracker.withRun(
    's-mono',
    {
      trigger: 'migration',
      phase: 'backing_up',
      overallPercent: 5,
      overallTotalNodes: 1000,
      overallProcessedNodes: 0,
      overallTotalTokens: 1_000_000,
      overallProcessedTokens: 0,
    },
    async () => {
      assert.equal(tracker.snapshot('s-mono').overallPercent, 5);
      tracker.update('s-mono', { overallPercent: 42, overallProcessedNodes: 400, overallProcessedTokens: 420_000 });
      assert.equal(tracker.snapshot('s-mono').overallPercent, 42);
      assert.equal(tracker.snapshot('s-mono').overallProcessedNodes, 400);
      assert.equal(tracker.snapshot('s-mono').overallProcessedTokens, 420_000);

      // Regression attempts (lower percent, null percent, smaller nested withRun) MUST be ignored!
      tracker.update('s-mono', { overallPercent: 12, overallProcessedNodes: 50, overallProcessedTokens: 10_000 });
      tracker.update('s-mono', { overallPercent: null });
      await tracker.withRun('s-mono', { phase: 'planning', overallPercent: 2, overallTotalNodes: 50 }, async () => {
        const snap = tracker.snapshot('s-mono');
        assert.equal(snap.overallPercent, 42);
        assert.equal(snap.overallTotalNodes, 1000);
        assert.equal(snap.overallProcessedNodes, 400);
        assert.equal(snap.overallProcessedTokens, 420_000);
      });

      // Clamping to totals and advancing forward works cleanly
      tracker.update('s-mono', { overallPercent: 97, overallProcessedNodes: 1500, overallProcessedTokens: 1_500_000 });
      const nearEnd = tracker.snapshot('s-mono');
      assert.equal(nearEnd.overallPercent, 97);
      assert.equal(nearEnd.overallProcessedNodes, 1000);
      assert.equal(nearEnd.overallProcessedTokens, 1_000_000);
    },
  );

  const done = tracker.snapshot('s-mono');
  assert.equal(done.phase, 'done');
  assert.equal(done.overallPercent, 100);
  assert.equal(done.overallProcessedNodes, 1000);
  assert.equal(done.overallProcessedTokens, 1_000_000);

  // Failed run retains last achieved percent (never jumps to 100 or resets to 0)
  await assert.rejects(
    tracker.withRun('s-fail-pct', { phase: 'summarizing', overallPercent: 55 }, async () => {
      throw Object.assign(new Error('mid-run error'), { code: 'PROVIDER_ERROR' });
    }),
  );
  const errSnap = tracker.snapshot('s-fail-pct');
  assert.equal(errSnap.phase, 'error');
  assert.equal(errSnap.overallPercent, 55);
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
