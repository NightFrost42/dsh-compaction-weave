import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CONFIG, resolveCompactSpec, resolveConfig } from '../lib/config.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { FailureDiagnostics, failureExplanation } from '../lib/failure-diagnostics.js';
import { SessionStateStore } from '../lib/state.js';
import { resetWindowCache } from '../lib/window.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message, stack: error.stack });
  }
}

const testBaseRoot = process.env.WEAVE_TEST_ROOT ?? tmpdir();

// ── 1. Deadzone Sweep & Exact Boundary Points ────────────────────────────────

await test('deadzone-sweep-32000-to-42000-and-exact-points-never-throw-and-preserve-order', () => {
  const policy = {
    thresholdRatio: DEFAULT_CONFIG.thresholdRatio,
    headroomTokens: DEFAULT_CONFIG.headroomTokens,
    retainRatio: DEFAULT_CONFIG.retainRatio,
    retainTokens: null,
  };

  const budgets = new Set();
  for (let b = 32000; b <= 42000; b += 250) budgets.add(b);
  for (const exact of [32000, 33000, 33001, 33536, 36000, 39000, 39285, 39286, 42000]) {
    budgets.add(exact);
  }

  for (const reserved of [8192, 4000, 0]) {
    for (const budget of [...budgets].sort((a, b) => a - b)) {
      const contextWindow = budget + reserved;
      const spec = resolveCompactSpec(policy, contextWindow, reserved);
      assert.equal(spec.messageBudgetTokens, budget, `budget=${budget}, reserved=${reserved}`);
      assert.ok(spec.retainTokens >= 0, `retainTokens >= 0 at budget=${budget}`);
      assert.ok(
        spec.retainTokens < spec.thresholdTokens,
        `retain (${spec.retainTokens}) < threshold (${spec.thresholdTokens}) at budget=${budget}, reserved=${reserved}`,
      );
      assert.ok(
        spec.thresholdTokens < spec.messageBudgetTokens,
        `threshold (${spec.thresholdTokens}) < budget (${spec.messageBudgetTokens}) at budget=${budget}, reserved=${reserved}`,
      );
    }
  }

  // Tight ratioMode edge case: retainRatio 0.78 < thresholdRatio 0.8 -> still satisfies 0 <= retain < threshold < budget
  const tightSpec = resolveCompactSpec(
    { thresholdRatio: 0.8, headroomTokens: 33000, retainRatio: 0.78, retainTokens: null },
    100000,
    0,
  );
  assert.equal(tightSpec.messageBudgetTokens, 100000);
  assert.equal(tightSpec.retainTokens, 78000);
  assert.ok(tightSpec.retainTokens < tightSpec.thresholdTokens);
  assert.ok(tightSpec.thresholdTokens < tightSpec.messageBudgetTokens);
});

// ── 2. Exact Invariance of 128k / 200k / 1M Baselines & C02 ──────────────────

await test('128k-200k-1m-and-c02-baselines-remain-bit-exact', () => {
  const policy = {
    thresholdRatio: DEFAULT_CONFIG.thresholdRatio,
    headroomTokens: DEFAULT_CONFIG.headroomTokens,
    retainRatio: DEFAULT_CONFIG.retainRatio,
    retainTokens: null,
  };

  // 128k (128000 and 131072, reserved = 8192)
  const s128a = resolveCompactSpec(policy, 128000, 8192);
  assert.equal(s128a.messageBudgetTokens, 128000 - 8192);
  assert.equal(s128a.messageBudgetTokens, 119808);
  assert.equal(s128a.messageBudgetTokens - s128a.pressureBudgetTokens, 33000);
  assert.equal(s128a.pressureBudgetTokens, 119808 - 33000);
  assert.equal(s128a.thresholdTokens, 119808 - 33000);

  const s128b = resolveCompactSpec(policy, 131072, 8192);
  assert.equal(s128b.messageBudgetTokens, 131072 - 8192);
  assert.equal(s128b.messageBudgetTokens - s128b.pressureBudgetTokens, 33000);
  assert.equal(s128b.pressureBudgetTokens, 131072 - 8192 - 33000);

  // 200k (200000, reserved = 8192)
  const s200 = resolveCompactSpec(policy, 200000, 8192);
  assert.equal(s200.messageBudgetTokens, 191808);
  assert.equal(s200.pressureBudgetTokens, 158808);
  assert.equal(s200.messageBudgetTokens - s200.pressureBudgetTokens, 33000);
  assert.equal(s200.thresholdTokens, 158808);
  assert.equal(s200.retainTokens, Math.floor(191808 * 0.16));

  // 1M (1048576, reserved = 8192)
  const s1m = resolveCompactSpec(policy, 1048576, 8192);
  assert.equal(s1m.messageBudgetTokens, 1040384);
  assert.equal(s1m.messageBudgetTokens - s1m.pressureBudgetTokens, 33000);
  assert.equal(s1m.pressureBudgetTokens, 1040384 - 33000);
  assert.equal(s1m.thresholdTokens, Math.floor(1048576 * 0.8));

  // C02 (10000, reserved = 8192)
  const sc02 = resolveCompactSpec(policy, 10000, 8192);
  assert.equal(sc02.messageBudgetTokens, 1808);
  assert.equal(sc02.pressureBudgetTokens, 1808 - 452);
  assert.equal(sc02.thresholdTokens, 1808 - 452);
  assert.ok(sc02.retainTokens >= 0 && sc02.retainTokens < sc02.thresholdTokens);
});

// ── 3. Explicit Error Codes & Preserved Regexes on Config & State ────────────

await test('resolveCompactSpec-and-SessionStateStore-attach-explicit-error-codes', async () => {
  // resolveCompactSpec error codes + existing message regexes
  assert.throws(
    () => resolveCompactSpec({ thresholdRatio: 0.8, headroomTokens: 1000, retainRatio: 0.16, retainTokens: null }, 10000, 12000),
    (err) =>
      err?.code === 'COMPACTION_INVALID_BUDGET' &&
      /no message budget/.test(err.message) &&
      err.contextWindow === 10000 &&
      err.reservedCompletionTokens === 12000,
  );
  assert.throws(
    () => resolveCompactSpec({ thresholdRatio: 0.8, headroomTokens: 1000, retainRatio: 0.16, retainTokens: 170000 }, 200000, 0),
    (err) =>
      err?.code === 'COMPACTION_RETAIN_EXCEEDS_THRESHOLD' &&
      /must be less than threshold tokens/.test(err.message) &&
      err.contextWindow === 200000 &&
      err.reservedCompletionTokens === 0 &&
      err.retainTokens === 170000 &&
      err.thresholdTokens === 160000,
  );
  // Explicit retainTokens >= thresholdTokens in deadzone-adjusted window still throws COMPACTION_RETAIN_EXCEEDS_THRESHOLD
  assert.throws(
    () => resolveCompactSpec({ thresholdRatio: 0.8, headroomTokens: 33000, retainRatio: 0.16, retainTokens: 27000 }, 40000, 4000),
    (err) => err?.code === 'COMPACTION_RETAIN_EXCEEDS_THRESHOLD' && /must be less than threshold tokens/.test(err.message),
  );

  // SessionStateStore error codes + existing messages
  const root = await mkdtemp(join(testBaseRoot, 'weave-issue10-state-'));
  try {
    const store = new SessionStateStore(join(root, 'state'));
    await mkdir(store.root, { recursive: true });

    for (const badId of ['', null, undefined, 123]) {
      assert.throws(
        () => store.file(badId),
        (err) => err?.code === 'STATE_INVALID' && /requires a session id/.test(err.message),
      );
    }

    // Corrupt JSON -> STATE_UNAVAILABLE with SyntaxError cause
    const badJsonSid = 'sess-bad-json';
    await writeFile(store.file(badJsonSid), '{not valid json', 'utf8');
    assert.throws(
      () => store.read(badJsonSid),
      (err) => err?.code === 'STATE_UNAVAILABLE' && err.cause instanceof SyntaxError && /compaction state unreadable/.test(err.message),
    );

    // Non-object JSON ('null') -> STATE_INVALID
    const nullJsonSid = 'sess-null-json';
    await writeFile(store.file(nullJsonSid), 'null', 'utf8');
    assert.throws(
      () => store.read(nullJsonSid),
      (err) => err?.code === 'STATE_INVALID' && /identity or checksum mismatch/.test(err.message),
    );

    // Checksum / identity mismatch -> STATE_INVALID
    const mismatchSid = 'sess-mismatch';
    const data = { failures: 0, stopped: false };
    await writeFile(
      store.file(mismatchSid),
      JSON.stringify({
        kind: 'compaction-weave/state',
        version: 1,
        sessionId: 'wrong-id',
        data,
        checksum: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
      }),
      'utf8',
    );
    assert.throws(
      () => store.read(mismatchSid),
      (err) => err?.code === 'STATE_INVALID' && /identity or checksum mismatch/.test(err.message),
    );

    // Invalid failure counters with valid checksum -> STATE_INVALID
    const badCountersSid = 'sess-bad-counters';
    const badData = { failures: -1, stopped: 'yes' };
    await writeFile(
      store.file(badCountersSid),
      JSON.stringify({
        kind: 'compaction-weave/state',
        version: 1,
        sessionId: badCountersSid,
        data: badData,
        checksum: createHash('sha256').update(JSON.stringify(badData)).digest('hex'),
      }),
      'utf8',
    );
    assert.throws(
      () => store.read(badCountersSid),
      (err) => err?.code === 'STATE_INVALID' && /invalid failure counters/.test(err.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 4. Engine agent/pre-step First User Message Pass-Through (40k/4k & 64k/32k)

for (const { label, contextWindow, maxTokens, expectedBudget } of [
  { label: '40000-4000-budget-36000', contextWindow: 40000, maxTokens: 4000, expectedBudget: 36000 },
  { label: '65536-32000-budget-33536', contextWindow: 65536, maxTokens: 32000, expectedBudget: 33536 },
]) {
  await test(`engine-prestep-allows-first-user-message-for-${label}`, async () => {
    const root = await mkdtemp(join(testBaseRoot, `weave-issue10-prestep-${label}-`));
    resetWindowCache();
    try {
      const hooks = new Map();
      const events = [];
      const surface = { nodes: [], replaceGeneration: 0 };
      const llmCalls = [];
      const firstMessage = {
        id: randomUUID(),
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Hello, explain how the project works.' }],
      };

      const session = {
        id: `issue10-${label}-${randomUUID().slice(0, 8)}`,
        surface,
        get seq() {
          return events.length;
        },
        eventAt: (seq) => events[seq],
        snapshotEvents: () => [...events],
        requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens } }),
        toolHistory: () => [],
        deriveEventMessage: (ev) => ev?.data?.message ?? ev?.data,
        append(type, data, opts = {}) {
          const ev = { seq: events.length, time: Date.now(), type, data, ...opts };
          events.push(ev);
          if (opts.surfaceOp === 'append' || opts.surfaceOp?.op === 'append') surface.nodes.push(ev.seq);
          return ev;
        },
      };

      const ctx = {
        logger: { info() {}, warn() {}, error() {} },
        provide() {},
        on(name, fn) {
          const list = hooks.get(name) ?? [];
          list.push(fn);
          hooks.set(name, list);
        },
        sessions: {
          get: (id) => (id === session.id ? session : null),
          flush: async () => true,
        },
        llm: {
          async resolveModelInfo() {
            return { contextWindow, maxTokens };
          },
          async *stream(req) {
            llmCalls.push(req);
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        },
        tokenMeter: {
          async measure(s) {
            const nodes = s.surface.nodes.map((seq) => ({ seq, tokens: 24 }));
            return {
              nodes,
              totalTokens: nodes.reduce((sum, n) => sum + n.tokens, 0) + 18,
              precision: 'priced',
            };
          },
          async countMessages() {
            return 18;
          },
        },
      };

      const cfg = resolveConfig({
        archiveDir: join(root, 'archive'),
        proactiveEnabled: false,
      }).config;

      const engine = new WeaveCompactionEngine(ctx, cfg);
      const inbox = {
        nextStep: [],
        nextTurn: [],
        prepend(target, msg) {
          if (target === 'next-step') this.nextStep.unshift(msg);
        },
      };
      const agent = {
        session,
        inbox,
        options: { provider: 'p', model: 'm' },
        async runMaintenance(fn) {
          return fn(new AbortController().signal);
        },
      };

      try {
        const spec = await engine._resolveSpec(agent, null, undefined);
        assert.equal(spec.messageBudgetTokens, expectedBudget);
        assert.ok(spec.retainTokens >= 0 && spec.retainTokens < spec.thresholdTokens && spec.thresholdTokens < spec.messageBudgetTokens);

        const preStepHandlers = hooks.get('agent/pre-step') ?? [];
        assert.ok(preStepHandlers.length > 0);

        let enteredMain = false;
        const result = await preStepHandlers[0](
          { agent, signal: new AbortController().signal, messages: [firstMessage] },
          async () => {
            enteredMain = true;
            return { kind: 'enter' };
          },
        );

        assert.equal(enteredMain, true);
        assert.deepEqual(result, { kind: 'enter' });
        assert.equal(llmCalls.length, 0);
        assert.equal(inbox.nextStep.length, 0);
        assert.deepEqual(engine.sessionState.read(session.id), {
          failures: 0,
          stopped: false,
          breakerBypassed: false,
          lastFailureCode: null,
          lastDiagnosticId: null,
          lastDiagnosticPath: null,
          window: {
            window: contextWindow,
            firstResolved: contextWindow,
            safetyWindow: contextWindow,
            source: 'locked',
            provider: 'p',
            model: 'm',
            trusted: true,
            byRoute: {
              'p/m': {
                window: contextWindow,
                firstResolved: contextWindow,
                safetyWindow: contextWindow,
                source: 'locked',
                provider: 'p',
                model: 'm',
                trusted: true,
              },
            },
          },
        });
        const diagFiles = await readdir(join(root, 'diagnostics')).catch(() => []);
        assert.equal(diagFiles.length, 0);
      } finally {
        engine.dispose();
      }
    } finally {
      resetWindowCache();
      await rm(root, { recursive: true, force: true });
    }
  });
}

// ── 5. FailureDiagnostics.capture & failureExplanation Coverage ──────────────

await test('failure-diagnostics-captures-explicit-codes-and-chinese-explanations', async () => {
  const root = await mkdtemp(join(testBaseRoot, 'weave-issue10-diag-'));
  try {
    const diag = new FailureDiagnostics(root);
    const session = { id: `diag-${randomUUID()}` };

    let invalidBudgetErr;
    try {
      resolveCompactSpec({ thresholdRatio: 0.8, headroomTokens: 1000, retainRatio: 0.16, retainTokens: null }, 4096, 8192);
    } catch (e) {
      invalidBudgetErr = e;
    }

    let retainExceedsErr;
    try {
      resolveCompactSpec({ thresholdRatio: 0.8, headroomTokens: 1000, retainRatio: 0.16, retainTokens: 170000 }, 200000, 0);
    } catch (e) {
      retainExceedsErr = e;
    }

    const store = new SessionStateStore(join(root, 'state'));
    await mkdir(store.root, { recursive: true });
    await writeFile(store.file('corrupt'), '{broken', 'utf8');
    let stateUnavailErr;
    try {
      store.read('corrupt');
    } catch (e) {
      stateUnavailErr = e;
    }

    let stateInvalidErr;
    try {
      store.file('');
    } catch (e) {
      stateInvalidErr = e;
    }

    const cases = [
      {
        err: invalidBudgetErr,
        expectedCode: 'COMPACTION_INVALID_BUDGET',
        patterns: [/COMPACTION_INVALID_BUDGET/, /contextWindow=4096/, /reservedCompletionTokens=8192/, /maxTokens/, /windowProviderMap/],
        expectedErrorFields: { contextWindow: 4096, reservedCompletionTokens: 8192 },
      },
      {
        err: retainExceedsErr,
        expectedCode: 'COMPACTION_RETAIN_EXCEEDS_THRESHOLD',
        patterns: [/COMPACTION_RETAIN_EXCEEDS_THRESHOLD/, /retainTokens=170000/, /thresholdTokens=160000/, /contextWindow=200000/, /reservedCompletionTokens=0/, /retainRatio/, /thresholdRatio/, /windowProviderMap/, /maxTokens/],
        expectedErrorFields: { retainTokens: 170000, thresholdTokens: 160000, contextWindow: 200000, reservedCompletionTokens: 0 },
      },
      {
        err: stateUnavailErr,
        expectedCode: 'STATE_UNAVAILABLE',
        patterns: [/STATE_UNAVAILABLE/, /读取|保存/, /存储状态/],
      },
      {
        err: stateInvalidErr,
        expectedCode: 'STATE_INVALID',
        patterns: [/STATE_INVALID/, /读取|保存/, /存储状态/],
      },
    ];

    for (const item of cases) {
      const receipt = await diag.capture(session, item.err, { trigger: 'automatic' });
      assert.equal(receipt.code, item.expectedCode);
      assert.notEqual(receipt.code, 'UNKNOWN');
      assert.equal(receipt.status, 'saved');
      for (const pat of item.patterns) {
        assert.match(receipt.explanation, pat, `${item.expectedCode} explanation match ${pat}`);
      }
      const saved = JSON.parse(await readFile(receipt.path, 'utf8'));
      assert.equal(saved.errors[0].code, item.expectedCode);
      if (item.expectedErrorFields) {
        for (const [k, v] of Object.entries(item.expectedErrorFields)) {
          assert.equal(saved.errors[0][k], v, `diagnostics errors[0].${k}`);
        }
      }
    }

    // STATE_LOCKED & wrapped COMPACTION_AUTOMATIC_BLOCKED causes also produce targeted Chinese guidance
    assert.match(failureExplanation(Object.assign(new Error('locked'), { code: 'STATE_LOCKED' })), /STATE_LOCKED.*存储状态/);
    const wrappedBudget = Object.assign(new Error('automatic blocked'), {
      code: 'COMPACTION_AUTOMATIC_BLOCKED',
      cause: invalidBudgetErr,
    });
    assert.match(failureExplanation(wrappedBudget), /COMPACTION_INVALID_BUDGET.*contextWindow=4096.*reservedCompletionTokens=8192/);
    assert.match(failureExplanation(wrappedBudget), /windowProviderMap/);

    const wrappedRetain = Object.assign(new Error('automatic blocked'), {
      code: 'COMPACTION_AUTOMATIC_BLOCKED',
      cause: retainExceedsErr,
    });
    assert.match(failureExplanation(wrappedRetain), /COMPACTION_RETAIN_EXCEEDS_THRESHOLD.*retainTokens=170000.*thresholdTokens=160000/);
    assert.match(failureExplanation(wrappedRetain), /thresholdRatio/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log(JSON.stringify({
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
}, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
