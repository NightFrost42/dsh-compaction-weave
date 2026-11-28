import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  DEFAULT_CONFIG,
  MIN_SUMMARY_CONCURRENCY,
  MAX_SUMMARY_CONCURRENCY,
  SUMMARY_REASONING_EFFORTS,
  normalizeSummaryConcurrency,
  normalizeSummaryReasoningEffort,
  resolveConfig,
  resolveTargetPolicy,
} from '../lib/config.js';
import {
  defaultSummaryConfigPath,
  handleSummaryConfigRpc,
  mergeSummaryConfig,
  readSummaryConfig,
  validateSummaryConfig,
  writeSummaryConfig,
} from '../lib/summary-config.js';
import { apply as mountEngine } from '../lib/engine-entry.js';
import { resolveReasoningEffort, summarizeWithChain } from '../lib/summary.js';
import { isFatalAuthError, isRateLimitError, runConcurrentPool } from '../lib/concurrency.js';
import { prepareContinuation } from '../lib/continuation.js';
import { CompactionProgressTracker } from '../lib/progress-tracker.js';
import { CompactionArchive } from '../lib/history.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message, stack: error.stack });
  }
}

// ── 1. Config & Hot-Applied Summary-Config Speed Settings ───────────────────

await test('config-defaults-validation-and-model-policy-merging', () => {
  assert.equal(MIN_SUMMARY_CONCURRENCY, 1);
  assert.equal(MAX_SUMMARY_CONCURRENCY, 6);
  assert.deepEqual(SUMMARY_REASONING_EFFORTS, ['auto', 'low', 'none', 'inherit', 'minimal', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(DEFAULT_CONFIG.summaryConcurrency, 2);
  assert.equal(DEFAULT_CONFIG.summaryReasoningEffort, 'auto');

  const base = resolveConfig({});
  assert.deepEqual(base.unknown, []);
  assert.equal(base.config.summaryConcurrency, 2);
  assert.equal(base.config.summaryReasoningEffort, 'auto');

  for (const concurrency of [1, 2, 3, 4, 5, 6]) {
    const resolved = resolveConfig({ summaryConcurrency: concurrency });
    assert.deepEqual(resolved.unknown, []);
    assert.equal(resolved.config.summaryConcurrency, concurrency);
    assert.equal(normalizeSummaryConcurrency(concurrency), concurrency);
  }
  for (const bad of [0, -1, 7, 1.5, NaN, Infinity, '2', null, false, true, {}, []]) {
    assert.throws(() => resolveConfig({ summaryConcurrency: bad }), /summaryConcurrency/);
  }

  for (const effort of ['auto', 'low', 'none', 'inherit', 'minimal', 'medium', 'high', 'xhigh', 'max']) {
    const resolved = resolveConfig({ summaryReasoningEffort: effort });
    assert.deepEqual(resolved.unknown, []);
    assert.equal(resolved.config.summaryReasoningEffort, effort);
    assert.equal(normalizeSummaryReasoningEffort(effort), effort);
  }
  for (const bad of ['ultra', '', ' ', null, 1, false, {}, []]) {
    assert.throws(() => resolveConfig({ summaryReasoningEffort: bad }), /summaryReasoningEffort/);
  }

  // Model-policy validation and merging
  const withPolicies = resolveConfig({
    summaryConcurrency: 2,
    summaryReasoningEffort: 'low',
    modelPolicies: [
      { provider: 'fast', model: 'flash', summaryConcurrency: 5, summaryReasoningEffort: 'none' },
      { provider: 'strict', model: 'pro', summaryConcurrency: 1, summaryReasoningEffort: 'inherit' },
      { provider: 'deep', model: 'reasoner', summaryReasoningEffort: 'high' },
    ],
  }).config;
  const fastPolicy = resolveTargetPolicy(withPolicies, 'fast', 'flash');
  assert.equal(fastPolicy.summaryConcurrency, 5);
  assert.equal(fastPolicy.summaryReasoningEffort, 'none');
  const strictPolicy = resolveTargetPolicy(withPolicies, 'strict', 'pro');
  assert.equal(strictPolicy.summaryConcurrency, 1);
  assert.equal(strictPolicy.summaryReasoningEffort, 'inherit');
  const deepPolicy = resolveTargetPolicy(withPolicies, 'deep', 'reasoner');
  assert.equal(deepPolicy.summaryReasoningEffort, 'high');
  const fallbackPolicy = resolveTargetPolicy(withPolicies, 'other', 'model');
  assert.equal(fallbackPolicy.summaryConcurrency, 2);
  assert.equal(fallbackPolicy.summaryReasoningEffort, 'low');

  assert.throws(
    () => resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', summaryConcurrency: 9 }] }),
    /summaryConcurrency/,
  );
  assert.throws(
    () => resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', summaryReasoningEffort: 'ultra' }] }),
    /summaryReasoningEffort/,
  );
});

await test('summary-config-speed-settings-validation-persistence-clear-and-hot-apply', async () => {
  // Guardrail: absent speed settings are omitted (never invented).
  const omitted = validateSummaryConfig({ provider: 'p', model: 'm', maxTokens: 4096 });
  assert.equal(omitted.ok, true);
  assert.deepEqual(omitted.value, { provider: 'p', model: 'm', maxTokens: 4096, thresholdRatio: null });
  assert.equal(Object.hasOwn(omitted.value, 'summaryConcurrency'), false);
  assert.equal(Object.hasOwn(omitted.value, 'summaryReasoningEffort'), false);

  // Valid numeric and integer-form text inputs
  for (const raw of [1, 6, '1', ' 4 ']) {
    const v = validateSummaryConfig({ summaryConcurrency: raw });
    assert.equal(v.ok, true);
    assert.equal(v.value.summaryConcurrency, Number(String(raw).trim()));
  }
  for (const raw of ['low', 'none', 'inherit', 'minimal', 'medium', 'high', 'xhigh', 'max', ' none ', ' high ']) {
    const v = validateSummaryConfig({ summaryReasoningEffort: raw });
    assert.equal(v.ok, true);
    assert.equal(v.value.summaryReasoningEffort, raw.trim());
  }

  // Invalid inputs rejected cleanly
  for (const bad of [0, 7, -2, 2.5, '0', '7', '2.5', '', ' ', null, false, {}, []]) {
    const v = validateSummaryConfig({ summaryConcurrency: bad });
    assert.equal(v.ok, false, `bad summaryConcurrency=${String(bad)}`);
    assert.equal(v.code, 'INVALID_SUMMARY_CONCURRENCY');
  }
  for (const bad of ['ultra', '', ' ', null, 2, false, {}, []]) {
    const v = validateSummaryConfig({ summaryReasoningEffort: bad });
    assert.equal(v.ok, false, `bad summaryReasoningEffort=${String(bad)}`);
    assert.equal(v.code, 'INVALID_SUMMARY_REASONING_EFFORT');
  }

  const root = await mkdtemp(join(tmpdir(), 'weave-w3-speed-cfg-'));
  const priorHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = root;
    const file = defaultSummaryConfigPath();

    // Persist speed settings without model override
    const setRes = await handleSummaryConfigRpc(
      { method: 'set', params: { summaryConcurrency: 4, summaryReasoningEffort: 'none' } },
      file,
    );
    assert.equal(setRes.cleared, false);
    assert.equal(setRes.restartRequired, false);
    assert.equal(setRes.config.summaryConcurrency, 4);
    assert.equal(setRes.config.summaryReasoningEffort, 'none');

    const got = await handleSummaryConfigRpc({ method: 'get' }, file);
    assert.equal(got.config.summaryConcurrency, 4);
    assert.equal(got.config.summaryReasoningEffort, 'none');
    assert.equal(readSummaryConfig(file, { strict: true }).summaryConcurrency, 4);
    assert.equal(readSummaryConfig(file, { strict: true }).summaryReasoningEffort, 'none');

    // Merge over inherited base config
    const merged = resolveConfig(
      mergeSummaryConfig({ summaryConcurrency: 1, summaryReasoningEffort: 'inherit' }, got.config),
    ).config;
    assert.equal(merged.summaryConcurrency, 4);
    assert.equal(merged.summaryReasoningEffort, 'none');

    // Invalid merge / direct write throws typed SummaryConfigError
    assert.throws(
      () => mergeSummaryConfig({}, { summaryConcurrency: 99 }),
      { code: 'INVALID_SUMMARY_CONCURRENCY' },
    );
    assert.throws(
      () => mergeSummaryConfig({}, { summaryReasoningEffort: 'ultra' }),
      { code: 'INVALID_SUMMARY_REASONING_EFFORT' },
    );
    assert.throws(
      () => writeSummaryConfig(file, { summaryConcurrency: 0 }),
      { code: 'INVALID_SUMMARY_CONCURRENCY' },
    );

    // Invalid RPC never overwrites existing valid file
    const beforeRaw = await readFile(file, 'utf8');
    await assert.rejects(
      handleSummaryConfigRpc({ method: 'set', params: { summaryConcurrency: 9 } }, file),
      { code: 'INVALID_SUMMARY_CONCURRENCY' },
    );
    await assert.rejects(
      handleSummaryConfigRpc({ method: 'set', params: { summaryReasoningEffort: 'ultra' } }, file),
      { code: 'INVALID_SUMMARY_REASONING_EFFORT' },
    );
    assert.equal(await readFile(file, 'utf8'), beforeRaw);

    // Model-only save and clear preserve independent speed settings
    await handleSummaryConfigRpc({ method: 'set', params: { provider: 'p', model: 'm' } }, file);
    assert.equal(readSummaryConfig(file).summaryConcurrency, 4);
    assert.equal(readSummaryConfig(file).summaryReasoningEffort, 'none');
    const clearRes = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '' } }, file);
    assert.equal(clearRes.cleared, false);
    assert.equal(clearRes.config.summaryConcurrency, 4);
    assert.equal(clearRes.config.summaryReasoningEffort, 'none');

    // Hot-apply onto live mounted engine without restart
    const hooks = new Map();
    const services = new Map();
    const ctx = {
      on: (name, fn) => hooks.set(name, fn),
      provide: (name, value) => services.set(name, value),
      logger: { info() {}, warn() {} },
    };
    const dispose = mountEngine(ctx, { auto: false, archiveDir: join(root, 'archive') });
    try {
      const engine = services.get('compaction');
      const peek = () => engine._withConfig(() => engine.config);
      assert.equal(peek().summaryConcurrency, 4);
      assert.equal(peek().summaryReasoningEffort, 'none');

      await handleSummaryConfigRpc(
        { method: 'set', params: { summaryConcurrency: 1, summaryReasoningEffort: 'inherit' } },
        file,
      );
      assert.equal(peek().summaryConcurrency, 1);
      assert.equal(peek().summaryReasoningEffort, 'inherit');

      // Corrupt persisted value rejected by strict read
      await writeFile(file, JSON.stringify({ version: 1, summaryConcurrency: 99 }));
      assert.equal(readSummaryConfig(file), null);
      assert.throws(() => readSummaryConfig(file, { strict: true }), { code: 'INVALID_SAVED_SETTINGS' });
    } finally {
      dispose();
    }
  } finally {
    if (priorHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = priorHome;
    await rm(root, { recursive: true, force: true });
  }
});

// ── 2. Summary Reasoning Effort Downgrade Policy ────────────────────────────

await test('summary-reasoning-effort-policy-low-none-inherit-and-cross-route', async () => {
  // Direct helper coverage
  assert.equal(resolveReasoningEffort('high', 'low'), 'low');
  assert.equal(resolveReasoningEffort('xhigh', 'low'), 'low');
  assert.equal(resolveReasoningEffort('medium', 'low'), 'low');
  assert.equal(resolveReasoningEffort('max', 'low'), 'low');
  assert.equal(resolveReasoningEffort('low', 'low'), 'low');
  assert.equal(resolveReasoningEffort('minimal', 'low'), 'minimal');
  assert.equal(resolveReasoningEffort('none', 'low'), 'none');
  assert.equal(resolveReasoningEffort(undefined, 'low'), 'low');
  assert.equal(resolveReasoningEffort('high', 'none'), undefined);
  assert.equal(resolveReasoningEffort('low', 'none'), undefined);
  assert.equal(resolveReasoningEffort('xhigh', 'inherit'), 'xhigh');

  const runSummary = async (primaryEffort, policyKey, policyVal, targetsOverride) => {
    const calls = [];
    const ctx = {
      llm: {
        async *stream(opts) {
          calls.push(opts);
          if (opts.provider === 'fail-first') {
            throw Object.assign(new Error('context length exceeded'), { code: 'CONTEXT_WINDOW_EXCEEDED' });
          }
          yield { type: 'text-delta', text: 'Summary body.' };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    };
    const targets = targetsOverride ?? [
      {
        provider: 'p',
        model: 'm',
        ...(primaryEffort === undefined ? {} : { reasoningEffort: primaryEffort }),
        temperature: 0.3,
      },
    ];
    await summarizeWithChain({
      ctx,
      agent: { session: { id: 'effort-test' } },
      input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'History.' }] }] },
      chain: { targets, source: 'session' },
      options: {
        retryCount: targetsOverride ? 1 : 0,
        retryDelayMs: 0,
        maxTokens: 4096,
        timeoutMs: 10000,
        language: 'en',
        ...(policyKey ? { [policyKey]: policyVal } : {}),
      },
      signal: new AbortController().signal,
    });
    return calls;
  };

  // Same-route 'low' downgrades high/xhigh/medium/max -> 'low', preserves low/minimal/none
  for (const effort of ['high', 'xhigh', 'medium', 'max']) {
    const calls = await runSummary(effort, 'reasoningEffortPolicy', 'low');
    assert.equal(calls[0].reasoningEffort, 'low', `downgrade ${effort}`);
    assert.equal(calls[0].temperature, 0.3);
  }
  for (const effort of ['low', 'minimal', 'none']) {
    const calls = await runSummary(effort, 'summaryReasoningEffort', 'low');
    assert.equal(calls[0].reasoningEffort, effort, `preserve ${effort}`);
  }
  const undefCalls = await runSummary(undefined, 'reasoningEffortPolicy', 'low');
  assert.equal(undefCalls[0].reasoningEffort, 'low');

  // Same-route 'none' omits reasoningEffort completely
  const noneCalls = await runSummary('xhigh', 'reasoningEffortPolicy', 'none');
  assert.equal('reasoningEffort' in noneCalls[0], false);
  assert.equal(noneCalls[0].temperature, 0.3);

  // Same-route 'inherit' copies verbatim
  const inheritCalls = await runSummary('xhigh', 'summaryReasoningEffort', 'inherit');
  assert.equal(inheritCalls[0].reasoningEffort, 'xhigh');

  // Legacy omitted policy stays backward-compatible
  const legacyCalls = await runSummary('max', null, null);
  assert.equal(legacyCalls[0].reasoningEffort, 'max');

  // Cross-route forwards configured direct 'low' (never primary 'xhigh') while 'none' and 'inherit' omit reasoningEffort
  for (const policyVal of ['low', 'none', 'inherit']) {
    const calls = await runSummary('xhigh', 'reasoningEffortPolicy', policyVal, [
      { provider: 'fail-first', model: 'primary', reasoningEffort: 'xhigh', temperature: 0.2 },
      { provider: 'fallback-p', model: 'fallback-m' },
    ]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].provider, 'fallback-p');
    if (policyVal === 'low') {
      assert.equal(calls[1].reasoningEffort, 'low', 'cross-route forwards direct low policy instead of dropping it');
    } else {
      assert.equal('reasoningEffort' in calls[1], false, `cross-route must omit reasoningEffort under ${policyVal}`);
    }
    assert.equal('temperature' in calls[1], false);
  }
});

// ── 3. Reusable Bounded Concurrency Pool (lib/concurrency.js) ───────────────

await test('error-classifiers-rate-limit-and-fatal-auth-with-causes-and-cycles', () => {
  // Rate-limit positives
  assert.equal(isRateLimitError({ status: 429 }), true);
  assert.equal(isRateLimitError({ statusCode: 429 }), true);
  assert.equal(isRateLimitError({ response: { status: 429 } }), true);
  assert.equal(isRateLimitError({ code: 'rate_limit_exceeded' }), true);
  assert.equal(isRateLimitError(new Error('HTTP 429 Too Many Requests')), true);
  assert.equal(isRateLimitError(new Error('Exceeded RPM quota for model')), true);
  assert.equal(isRateLimitError(new Error('TPM limit hit')), true);
  assert.equal(
    isRateLimitError(Object.assign(new Error('wrapped'), { cause: new Error('provider rate limit reached') })),
    true,
  );
  assert.equal(
    isRateLimitError({ code: 'SUMMARY_ALL_FAILED', failures: [{ code: 'RATE_LIMIT', message: 'slow down' }] }),
    true,
  );

  // Rate-limit negatives & cycle safety
  assert.equal(isRateLimitError(null), false);
  assert.equal(isRateLimitError({ status: 401 }), false);
  assert.equal(isRateLimitError(new Error('socket hang up')), false);
  const cyclic = new Error('loop');
  cyclic.cause = cyclic;
  assert.equal(isRateLimitError(cyclic), false);

  // Fatal auth positives
  assert.equal(isFatalAuthError({ status: 401 }), true);
  assert.equal(isFatalAuthError({ statusCode: 403 }), true);
  assert.equal(isFatalAuthError({ response: { status: 403 } }), true);
  assert.equal(isFatalAuthError({ code: 'AUTH_FAILED' }), true);
  assert.equal(isFatalAuthError({ code: 'CREDENTIAL_EXPIRED' }), true);
  assert.equal(isFatalAuthError({ code: 'PERMISSION_DENIED' }), true);
  assert.equal(isFatalAuthError(new Error('HTTP 401 Unauthorized')), true);
  assert.equal(isFatalAuthError(new Error('AUTH: key revoked')), true);
  assert.equal(
    isFatalAuthError(Object.assign(new Error('outer'), { cause: { status: 403 } })),
    true,
  );

  // Fatal auth negatives (must NOT false-positive on Weave's CONSTRAINT_LOST prose!)
  assert.equal(isFatalAuthError(null), false);
  assert.equal(isFatalAuthError({ status: 429 }), false);
  assert.equal(isFatalAuthError(cyclic), false);
  assert.equal(
    isFatalAuthError(
      Object.assign(
        new Error('Continuation notes claim permissions or instructions lacking a verified user source.'),
        { code: 'CONSTRAINT_LOST' },
      ),
    ),
    false,
  );
});

await test('pool-bounded-concurrency-ordered-commit-and-overlapping-workers', async () => {
  const empty = await runConcurrentPool([], { concurrency: 4, worker: async () => 1 });
  assert.deepEqual(empty, { results: [], completedCount: 0, effectiveConcurrency: 4, rateLimited: false });

  // Clamping check: 99 -> 6, 0 -> 1
  const clampedHigh = await runConcurrentPool([], { concurrency: 99, worker: async () => 1 });
  assert.equal(clampedHigh.effectiveConcurrency, 6);
  const clampedLow = await runConcurrentPool([], { concurrency: 0, worker: async () => 1 });
  assert.equal(clampedLow.effectiveConcurrency, 1);

  const items = ['a', 'b', 'c', 'd', 'e', 'f'];
  // Deliberately finish later indices faster than earlier ones to prove strict ordering.
  const durations = [45, 25, 5, 35, 15, 5];
  let active = 0;
  let maxActive = 0;
  let workerRanDuringCommit = false;
  let commitInFlight = false;
  const committed = [];
  const stateChanges = [];

  const res = await runConcurrentPool(items, {
    concurrency: 3,
    onStateChange: (s) => stateChanges.push(s),
    worker: async (item, index) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(durations[index]);
      if (commitInFlight) workerRanDuringCommit = true;
      active -= 1;
      return `${index}:${item.toUpperCase()}`;
    },
    onItemReadyInOrder: async (value, item, index) => {
      commitInFlight = true;
      await delay(20);
      committed.push({ index, item, value });
      commitInFlight = false;
    },
  });

  assert.equal(maxActive, 3);
  assert.equal(res.completedCount, 6);
  assert.equal(res.effectiveConcurrency, 3);
  assert.equal(res.rateLimited, false);
  assert.deepEqual(
    committed.map((c) => c.index),
    [0, 1, 2, 3, 4, 5],
  );
  assert.deepEqual(res.results, ['0:A', '1:B', '2:C', '3:D', '4:E', '5:F']);
  assert.equal(workerRanDuringCommit, true, 'sibling workers should continue running while commit callback runs');
  assert.ok(stateChanges.some((s) => s.activeWorkers === 3));
  assert.equal(stateChanges.at(-1).activeWorkers, 0);
});

await test('pool-429-aimd-drops-to-serial-with-cooldown-and-optional-retry', async () => {
  // (a) Worker signals 429 via poolControl.noteRateLimit()
  const items = [0, 1, 2, 3, 4];
  const starts = [];
  let maxAfterRateLimit = 0;
  let rateLimitTime = 0;
  const states = [];

  const res = await runConcurrentPool(items, {
    concurrency: 3,
    rateLimitCooldownMs: 60,
    onStateChange: (s) => states.push(s),
    worker: async (item, index, _sig, control) => {
      starts.push({ index, at: Date.now(), active: control.activeWorkers, eff: control.effectiveConcurrency });
      if (index === 0) {
        rateLimitTime = Date.now();
        control.noteRateLimit();
        await delay(10);
        return 'ok-0';
      }
      if (index >= 3) {
        maxAfterRateLimit = Math.max(maxAfterRateLimit, control.activeWorkers);
      }
      await delay(15);
      return `ok-${index}`;
    },
  });

  assert.equal(res.completedCount, 5);
  assert.equal(res.effectiveConcurrency, 1);
  assert.equal(res.rateLimited, true);
  assert.equal(maxAfterRateLimit, 1, 'items launched after 429 must run strictly serially');
  const item3Start = starts.find((s) => s.index === 3);
  assert.ok(item3Start.at - rateLimitTime >= 50, `expected >=50ms cooldown before item 3, got ${item3Start.at - rateLimitTime}ms`);
  assert.ok(states.some((s) => s.rateLimited === true && s.effectiveConcurrency === 1));

  // (b) Worker throws HTTP 429 with maxRateLimitRetries: 1 -> retries cleanly at concurrency 1
  let attemptsOn1 = 0;
  const retryRes = await runConcurrentPool([0, 1, 2], {
    concurrency: 3,
    rateLimitCooldownMs: 30,
    maxRateLimitRetries: 1,
    worker: async (_item, index) => {
      if (index === 1 && attemptsOn1 === 0) {
        attemptsOn1 += 1;
        throw Object.assign(new Error('HTTP 429 Too Many Requests'), { status: 429 });
      }
      await delay(5);
      return `done-${index}`;
    },
  });
  assert.equal(attemptsOn1, 1);
  assert.equal(retryRes.rateLimited, true);
  assert.equal(retryRes.effectiveConcurrency, 1);
  assert.deepEqual(retryRes.results, ['done-0', 'done-1', 'done-2']);
});

await test('pool-aborts-siblings-immediately-on-signal-fatal-auth-and-commit-error', async () => {
  // (a) External AbortSignal aborts all in-flight siblings
  const external = new AbortController();
  let abortedCount = 0;
  const pExternal = runConcurrentPool([0, 1, 2, 3], {
    concurrency: 3,
    signal: external.signal,
    worker: async (_item, index, sig) => {
      if (index === 2) {
        setTimeout(() => external.abort(Object.assign(new Error('user paused'), { code: 'ABORTED' })), 15);
      }
      try {
        await delay(5000, undefined, { signal: sig });
      } catch (err) {
        if (sig.aborted) abortedCount += 1;
        throw err;
      }
    },
  });
  await assert.rejects(pExternal, (err) => err.code === 'ABORTED');
  assert.equal(abortedCount, 3, 'all 3 in-flight workers must be aborted immediately');

  // (b) Fatal 401 auth error aborts siblings and prevents launching queued items
  let authSiblingsAborted = 0;
  let launchedIndex3 = false;
  const pAuth = runConcurrentPool([0, 1, 2, 3], {
    concurrency: 3,
    worker: async (_item, index, sig) => {
      if (index === 3) launchedIndex3 = true;
      if (index === 0) {
        await delay(10);
        throw Object.assign(new Error('HTTP 401 Unauthorized'), { status: 401 });
      }
      try {
        await delay(5000, undefined, { signal: sig });
      } catch (err) {
        if (sig.aborted) authSiblingsAborted += 1;
        throw err;
      }
    },
  });
  await assert.rejects(pAuth, (err) => err.status === 401);
  assert.equal(authSiblingsAborted, 2);
  assert.equal(launchedIndex3, false);

  // (c) Throwing inside onItemReadyInOrder aborts in-flight sibling workers
  let commitSiblingsAborted = 0;
  const pCommit = runConcurrentPool([0, 1, 2], {
    concurrency: 3,
    worker: async (_item, index, sig) => {
      if (index === 0) return 'ready-0';
      try {
        await delay(5000, undefined, { signal: sig });
      } catch (err) {
        if (sig.aborted) commitSiblingsAborted += 1;
        throw err;
      }
    },
    onItemReadyInOrder: async () => {
      throw Object.assign(new Error('disk full during commit'), { code: 'ENOSPC' });
    },
  });
  await assert.rejects(pCommit, (err) => err.code === 'ENOSPC');
  assert.equal(commitSiblingsAborted, 2);
});

await test('pool-drains-cooperative-cleanup-bounds-uncooperative-workers-and-aborts-writeSpan', async () => {
  // (a) Cooperative sibling cleanup (~30ms, longer than setImmediate) must finish BEFORE pool rejects
  const ext = new AbortController();
  let cleanupFinished = false;
  const pCoop = runConcurrentPool([0, 1], {
    concurrency: 2,
    signal: ext.signal,
    worker: async (_item, index, sig) => {
      if (index === 0) {
        await delay(5);
        ext.abort(Object.assign(new Error('early stop'), { code: 'ABORTED' }));
        throw ext.signal.reason;
      }
      try {
        await delay(5000, undefined, { signal: sig });
      } finally {
        await delay(30);
        cleanupFinished = true;
      }
    },
  });
  await assert.rejects(pCoop, (err) => err.code === 'ABORTED');
  assert.equal(cleanupFinished, true, 'cooperative sibling async cleanup must finish before pool settles');

  // (b) Uncooperative worker ignoring signal still settles within abortDrainTimeoutMs without hanging
  const extBounded = new AbortController();
  let releaseStubborn = null;
  const stubbornDone = new Promise((resolve) => {
    releaseStubborn = resolve;
  });
  const startedAt = Date.now();
  const pBounded = runConcurrentPool([0, 1], {
    concurrency: 2,
    signal: extBounded.signal,
    abortDrainTimeoutMs: 40,
    worker: async (_item, index) => {
      if (index === 0) {
        await delay(5);
        extBounded.abort(Object.assign(new Error('stop now'), { code: 'ABORTED' }));
        return 'ok';
      }
      await stubbornDone;
      return 'stubborn';
    },
  });
  await assert.rejects(pBounded, (err) => err.code === 'ABORTED');
  const elapsedMs = Date.now() - startedAt;
  releaseStubborn?.();
  await delay(10);
  assert.ok(elapsedMs < 1000, `bounded drain must not hang on uncooperative workers (elapsed=${elapsedMs}ms)`);

  // (c) CompactionArchive.writeSpan returns null immediately on aborted signal with zero disk writes
  const archiveRoot = await mkdtemp(join(tmpdir(), 'weave-w3-abort-archive-'));
  try {
    const archive = new CompactionArchive({ root: archiveRoot });
    const ac = new AbortController();
    ac.abort(Object.assign(new Error('aborted before writeSpan'), { code: 'ABORTED' }));
    const wrote = await archive.writeSpan({
      sessionId: 'sess-aborted-write',
      compactionId: 'weave-aborted-span',
      entries: [{ seq: 0, type: 'user/message', role: 'user', text: 'hello' }],
      signal: ac.signal,
    });
    assert.equal(wrote, null, 'aborted writeSpan must return null');
    const rootEntries = await readdir(archiveRoot);
    assert.deepEqual(rootEntries, [], 'aborted writeSpan must not leave span files or index.jsonl on disk');
  } finally {
    await rm(archiveRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ── 4. Continuation Optional Map-Reduce Concurrency ─────────────────────────

const VALID_NOTES =
  '## Goal\nContinue diagnostics safely.\n## State\nEvidence retained in archive; verified progress: tasksCompleted: 5.\n## Next\nReview evidence without database writes.\n## Uncertain\nLive runtime outcome pending.';
const INTERMEDIATE_NOTES =
  '## Goal\nContinue diagnostics safely.\n## State\nPartial page evidence retained in archive.\n## Next\nReview remaining pages without database writes.\n## Uncertain\nLater page status unseen.';

async function makeContinuationFixture(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'weave-w3-cont-'));
  const events = [
    {
      seq: 0,
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: '不要写库。必须保留全部证据。' }] },
    },
    {
      seq: 1,
      type: 'assistant/message',
      data: {
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text:
                Array.from({ length: 3000 }, (_, i) => `Page observation ${i}: archived metric payload retained.`).join(
                  '\n',
                ) + '\ntasksCompleted: 5\n',
            },
          ],
        },
      },
    },
  ];
  const session = {
    id: randomUUID(),
    surface: { nodes: [0, 1] },
    eventAt: (i) => events[i],
    deriveEventMessage: (e) => (e.type === 'assistant/message' ? e.data.message : e.data),
    toolHistory: () => [],
  };
  const policy = resolveConfig({
    archiveEnabled: true,
    maxSummaryChunks: 32,
    summaryInputMaxBytes: 48000,
    continuationMemoryBytes: 4096,
    summaryRetryCount: 0,
    summaryRetryDelayMs: 0,
    summaryConcurrency: 3,
    summaryReasoningEffort: 'low',
    ...extra,
  }).config;
  const capacity = {
    targets: [
      {
        key: JSON.stringify(['p', 'm']),
        window: 1_000_000,
        output: 8192,
        margin: 0,
        inputRatio: 1,
        maxInputBytes: 48000,
        scale: 1,
      },
    ],
    shrinkLimit: Infinity,
  };
  const chain = { targets: [{ provider: 'p', model: 'm', reasoningEffort: 'xhigh' }], source: 'session' };
  return { root, session, policy, capacity, chain };
}

await test('continuation-map-reduce-parallel-pages-reasoning-downgrade-and-429-aimd', async () => {
  const f = await makeContinuationFixture({ summaryRetryCount: 1, summaryRetryDelayMs: 5, summaryConcurrency: 3 });
  try {
    let active = 0;
    let maxActive = 0;
    let injected429 = false;
    const calls = [];
    const concurrencyStates = [];
    const ctx = {
      llm: {
        async *stream(opts) {
          calls.push(opts);
          const callNumber = calls.length;
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            const promptText = JSON.stringify(opts.messages);
            const isMap = promptText.includes('Independent notes for page');
            await delay(isMap ? 25 : 10);
            if (isMap && !injected429 && callNumber === 1) {
              injected429 = true;
              throw Object.assign(new Error('HTTP 429 rate limit exceeded'), { status: 429 });
            }
            yield { type: 'text-delta', text: isMap ? INTERMEDIATE_NOTES : VALID_NOTES };
            yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
            yield { type: 'finish', kind: 'stop' };
          } finally {
            active -= 1;
          }
        },
      },
    };

    const result = await prepareContinuation({
      ctx,
      agent: { session: f.session },
      session: f.session,
      seqs: [0, 1],
      policy: f.policy,
      capacity: f.capacity,
      chain: f.chain,
      compactionId: 'weave-mr-1',
      signal: new AbortController().signal,
      archiveRoot: join(f.root, 'archive'),
      parallelContinuation: true,
      reasoningEffortPolicy: f.policy.summaryReasoningEffort,
      rateLimitCooldownMs: 30,
      onConcurrencyChange: (s) => concurrencyStates.push(s),
    });

    const pages = result.summarized.continuation.pages.length;
    assert.ok(pages >= 4, `expected >=4 pages, got ${pages}`);
    assert.ok(maxActive >= 2, `expected parallel Map workers (maxActive=${maxActive})`);
    assert.equal(injected429, true);
    assert.ok(
      concurrencyStates.some((s) => s.rateLimited === true && s.effectiveConcurrency === 1),
      '429 inside Map attempt must drop pool concurrency to 1',
    );
    // Total requests = pages (map) + 1 (429 retry) + 1 (reduce)
    assert.equal(result.summarized.continuation.totalRequests, pages + 2);
    // All calls had xhigh downgraded to low
    assert.ok(calls.every((c) => c.reasoningEffort === 'low'));
    assert.match(result.checkpointBlocks[0].text, /不要写库/);
    assert.match(result.summarized.summary[0].text, /tasksCompleted: 5/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

await test('fresh-P2-5-reduce-splits-notes-larger-than-source-page-budget', async () => {
  const f = await makeContinuationFixture({ continuationMemoryBytes: 10000, continuationMaxExtraCalls: 32, summaryConcurrency: 2 });
  f.capacity.targets[0].maxInputBytes = 24000;
  f.session.eventAt(1).data.message.content[0].text = 'Page evidence retained. '.repeat(500) + '\ntasksCompleted: 5\n';
  const largeNotes = INTERMEDIATE_NOTES.replace('Partial page evidence retained in archive.', '证据。'.repeat(800));
  let maps = 0, reduces = 0;
  try {
    const ctx = { llm: { async *stream(request) {
      const isMap = JSON.stringify(request.messages).includes('Independent notes for page');
      if (isMap) maps++; else reduces++;
      yield { type: 'text-delta', text: isMap ? largeNotes : VALID_NOTES };
      yield { type: 'finish', kind: 'stop' };
    } } };
    const result = await prepareContinuation({ ctx, agent: { session: f.session }, session: f.session, seqs: [0, 1], policy: f.policy, capacity: f.capacity, chain: f.chain,
      compactionId: 'fresh-reduce', signal: new AbortController().signal, archiveRoot: join(f.root, 'archive'), parallelContinuation: true });
    assert.ok(maps >= 2); assert.ok(reduces > maps, `expected split reduce groups, got maps=${maps} reduce=${reduces}`);
    assert.ok(result.summarized.rawText.includes('tasksCompleted: 5'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

await test('continuation-map-reduce-resume-after-reduce-failure-reuses-all-mapped-pages', async () => {
  const f = await makeContinuationFixture({ summaryConcurrency: 3 });
  try {
    let failReduce = true;
    let totalStreamCalls = 0;
    const ctx = {
      llm: {
        async *stream(opts) {
          totalStreamCalls += 1;
          const promptText = JSON.stringify(opts.messages);
          const isMap = promptText.includes('Independent notes for page');
          await delay(5);
          if (!isMap && failReduce) {
            throw Object.assign(new Error('transient reduce timeout'), { code: 'SUMMARY_TIMEOUT' });
          }
          yield { type: 'text-delta', text: isMap ? INTERMEDIATE_NOTES : VALID_NOTES };
          yield { type: 'usage', usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    };

    const commonArgs = {
      ctx,
      agent: { session: f.session },
      session: f.session,
      seqs: [0, 1],
      policy: f.policy,
      capacity: f.capacity,
      chain: f.chain,
      archiveRoot: join(f.root, 'archive'),
      parallelContinuation: true,
      rateLimitCooldownMs: 20,
    };

    await assert.rejects(
      prepareContinuation({ ...commonArgs, compactionId: 'mr-run-1', signal: new AbortController().signal }),
      (err) => err.code === 'SUMMARY_TIMEOUT',
    );
    const callsAfterFirst = totalStreamCalls;
    assert.ok(callsAfterFirst >= 5, 'map pages + failed reduce should have run');

    // Resume: must NOT re-run any already-accepted map pages; runs ONLY the 1 Reduce call!
    failReduce = false;
    const resumed = await prepareContinuation({
      ...commonArgs,
      compactionId: 'mr-run-2',
      signal: new AbortController().signal,
    });
    assert.equal(totalStreamCalls, callsAfterFirst + 1, 'resume should run only the single Reduce call');
    assert.equal(resumed.summarized.continuation.resumedPages, resumed.summarized.continuation.pages.length);
    assert.equal(resumed.summarized.continuation.requestsThisAttempt, 1);

    // Second resume after completion spends 0 calls!
    const reused = await prepareContinuation({
      ...commonArgs,
      compactionId: 'mr-run-3',
      signal: new AbortController().signal,
    });
    assert.equal(totalStreamCalls, callsAfterFirst + 1, 'fully reduced continuation must spend 0 calls on reuse');
    assert.equal(reused.summarized.continuation.requestsThisAttempt, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

await test('continuation-map-reduce-mid-map-failure-persists-ordered-prefix-and-enforces-budget', async () => {
  const f = await makeContinuationFixture({ summaryConcurrency: 2, continuationMaxExtraCalls: 4 });
  try {
    let failPage3 = true;
    let totalCalls = 0;
    let resolvePage2;
    const page2Done = new Promise((resolve) => { resolvePage2 = resolve; });
    const ctx = {
      llm: {
        async *stream(opts) {
          totalCalls += 1;
          const promptText = JSON.stringify(opts.messages);
          const isMap = promptText.includes('Independent notes for page');
          if (isMap && failPage3) {
            if (promptText.includes('Independent notes for page 1 ')) {
              await delay(5);
            } else if (promptText.includes('Independent notes for page 2 ')) {
              await delay(10);
              resolvePage2();
            } else if (promptText.includes('Independent notes for page 3 ')) {
              await page2Done;
              await delay(25);
              throw Object.assign(new Error('page 3 transport error'), { code: 'ECONNRESET' });
            } else {
              // Hold page 4+ until worker pool aborts on page 3 failure so fast 1ms Linux timers never race ahead.
              await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, 1000);
                opts.signal?.addEventListener('abort', () => {
                  clearTimeout(timer);
                  reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORTED' }));
                }, { once: true });
              });
            }
          }
          yield { type: 'text-delta', text: isMap ? INTERMEDIATE_NOTES : VALID_NOTES };
          yield { type: 'usage', usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    };
    const commonArgs = {
      ctx,
      agent: { session: f.session },
      session: f.session,
      seqs: [0, 1],
      policy: f.policy,
      capacity: f.capacity,
      chain: f.chain,
      archiveRoot: join(f.root, 'archive'),
      parallelContinuation: true,
      rateLimitCooldownMs: 20,
    };
    let firstErr;
    try {
      await prepareContinuation({ ...commonArgs, compactionId: 'mid-1', signal: new AbortController().signal });
    } catch (err) {
      firstErr = err;
    }
    assert.ok(firstErr);
    assert.equal(firstErr.continuationProgress.acceptedPages, 2, 'pages 1 and 2 must be persisted before page 3 fails');

    failPage3 = false;
    const beforeResume = totalCalls;
    const resumed = await prepareContinuation({
      ...commonArgs,
      compactionId: 'mid-2',
      signal: new AbortController().signal,
    });
    const totalPages = resumed.summarized.continuation.pages.length;
    assert.equal(resumed.summarized.continuation.resumedPages, 2);
    assert.equal(totalCalls - beforeResume, totalPages - 2 + 1, 'resume maps only remaining pages plus 1 Reduce');

    // Enforce continuationCallBudget strictly under concurrent invalid output
    const fBudget = await makeContinuationFixture({
      summaryConcurrency: 3,
      continuationMaxExtraCalls: 1,
      summaryRetryCount: 1,
      summaryRetryDelayMs: 0,
    });
    try {
      let budgetCalls = 0;
      const badCtx = {
        llm: {
          async *stream() {
            budgetCalls += 1;
            yield { type: 'text-delta', text: '<tool_call>invalid' };
            yield { type: 'finish', kind: 'stop' };
          },
        },
      };
      await assert.rejects(
        prepareContinuation({
          ctx: badCtx,
          agent: { session: fBudget.session },
          session: fBudget.session,
          seqs: [0, 1],
          policy: fBudget.policy,
          capacity: fBudget.capacity,
          chain: fBudget.chain,
          compactionId: 'budget-1',
          signal: new AbortController().signal,
          archiveRoot: join(fBudget.root, 'archive'),
          parallelContinuation: true,
        }),
        (err) => err.code === 'CONTINUATION_CALL_BUDGET' || err.code === 'CONTINUATION_TOOL_OUTPUT',
      );
      // extraCalls = 1 -> at most 2 calls allowed with 0 accepted pages!
      assert.ok(budgetCalls <= 2, `concurrency must never exceed continuationCallBudget (spent ${budgetCalls})`);
    } finally {
      await rm(fBudget.root, { recursive: true, force: true });
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

await test('continuation-stays-sequential-when-parallel-not-opted-in-or-concurrency-1', async () => {
  const f = await makeContinuationFixture({ summaryConcurrency: 3 });
  try {
    let active = 0;
    let maxActive = 0;
    const calls = [];
    const ctx = {
      llm: {
        async *stream(opts) {
          calls.push(opts);
          active += 1;
          maxActive = Math.max(maxActive, active);
          await delay(5);
          active -= 1;
          yield { type: 'text-delta', text: VALID_NOTES };
          yield { type: 'usage', usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    };
    const res = await prepareContinuation({
      ctx,
      agent: { session: f.session },
      session: f.session,
      seqs: [0, 1],
      policy: f.policy,
      capacity: f.capacity,
      chain: f.chain,
      compactionId: 'seq-default',
      signal: new AbortController().signal,
      archiveRoot: join(f.root, 'archive'),
    });
    assert.equal(maxActive, 1);
    assert.equal(calls.length, res.summarized.continuation.pages.length);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ── 5. Progress Tracker Cancellation Registry & Telemetry ───────────────────

await test('progress-tracker-cancel-registry-concurrency-and-resumable-telemetry', async () => {
  let now = 100_000;
  const tracker = new CompactionProgressTracker({ clock: () => now, doneTtlMs: 30_000, errorTtlMs: 30_000 });

  // Idle defaults
  const idle = tracker.snapshot('sess-1');
  assert.equal(idle.cancellable, false);
  assert.equal(idle.concurrency, null);
  assert.equal(idle.activeWorkers, null);
  assert.equal(idle.rateLimited, false);
  assert.equal(idle.resumable, null);
  assert.equal(tracker.isCancellable('sess-1'), false);
  assert.deepEqual(tracker.cancelRun('sess-1', 'none'), { cancelled: false, runId: null });

  // Active run cancellation registration, stale runId rejection, abort, and cleanup
  let observedRunId = null;
  let capturedReason = null;
  const controller = new AbortController();

  await tracker.withRun('sess-1', { trigger: 'manual', phase: 'summarizing', concurrency: 3, activeWorkers: 2 }, async (runId) => {
    observedRunId = runId;
    assert.equal(tracker.registerCancel('sess-1', 'wrong-run-id', controller), false);
    assert.equal(tracker.isCancellable('sess-1'), false);

    assert.equal(tracker.registerCancel('sess-1', runId, controller), true);
    assert.equal(tracker.isCancellable('sess-1'), true);

    tracker.update('sess-1', { activeWorkers: 3, rateLimited: false });
    const live = tracker.snapshot('sess-1');
    assert.equal(live.cancellable, true);
    assert.equal(live.concurrency, 3);
    assert.equal(live.activeWorkers, 3);
    assert.equal(live.rateLimited, false);
    assert.equal(live.resumable, null);

    // Rate-limit telemetry update
    tracker.update('sess-1', { concurrency: 1, activeWorkers: 1, rateLimited: true });
    const rl = tracker.snapshot('sess-1');
    assert.equal(rl.concurrency, 1);
    assert.equal(rl.activeWorkers, 1);
    assert.equal(rl.rateLimited, true);

    // Cancel active run
    controller.signal.addEventListener('abort', () => {
      capturedReason = controller.signal.reason;
    });
    const cancelResult = tracker.cancelRun('sess-1', 'user clicked pause');
    assert.deepEqual(cancelResult, { cancelled: true, runId });
    assert.equal(controller.signal.aborted, true);
    assert.equal(capturedReason?.code, 'ABORTED');
    assert.equal(capturedReason?.userCancelled, true);
    assert.equal(tracker.isCancellable('sess-1'), false);
    assert.equal(tracker.snapshot('sess-1').cancellable, false);

    // Repeat cancel is a clean no-op
    assert.deepEqual(tracker.cancelRun('sess-1'), { cancelled: false, runId: null });
  });

  // After run finishes: activeWorkers reset to 0, cancellable false
  const doneSnap = tracker.snapshot('sess-1');
  assert.equal(doneSnap.phase, 'done');
  assert.equal(doneSnap.cancellable, false);
  assert.equal(doneSnap.activeWorkers, 0);

  // Auto-cleanup on finish() without explicit cancelRun
  const ctrl2 = new AbortController();
  await tracker.withRun('sess-2', { trigger: 'migration', phase: 'migrating' }, async (runId) => {
    assert.equal(tracker.registerCancel('sess-2', runId, ctrl2), true);
    assert.equal(tracker.isCancellable('sess-2'), true);
  });
  assert.equal(tracker.isCancellable('sess-2'), false);
  assert.deepEqual(tracker.cancelRun('sess-2'), { cancelled: false, runId: null });

  // Auto-cleanup on clear()
  const ctrl3 = new AbortController();
  let release3;
  const hold3 = new Promise((r) => { release3 = r; });
  const p3 = tracker.withRun('sess-3', { trigger: 'manual', phase: 'planning' }, async (runId) => {
    tracker.registerCancel('sess-3', runId, ctrl3);
    assert.equal(tracker.isCancellable('sess-3'), true);
    tracker.clear('sess-3');
    assert.equal(tracker.isCancellable('sess-3'), false);
    await hold3;
  });
  release3();
  await p3;

  // Resumable snapshot sanitization (strict allowlist + secret redaction)
  const fakeKey = 'sk-' + 'secretleak1234567890';
  const idleWithResumable = tracker.snapshot('sess-resumable', {
    resumable: {
      jobId: 'job-2026-001',
      trigger: 'migration',
      status: 'paused_user',
      interruptReason: 'user_cancel',
      overallPercent: 47.4,
      completedChunks: 3,
      remainingNodes: 42,
      remainingTokens: 120000,
      initialTotalTokens: 250000,
      completedTokens: 130000,
      updatedAt: '2026-11-22T06:00:00.000Z',
      canAutoResume: false,
      lastErrorCode: 'ABORTED',
      lastErrorMessage: `Paused while using ${fakeKey}`,
      secretPrompt: 'PRIVATE_TRANSCRIPT',
      extraJunk: [1, 2, 3],
    },
  });
  assert.equal(idleWithResumable.resumable.jobId, 'job-2026-001');
  assert.equal(idleWithResumable.resumable.trigger, 'migration');
  assert.equal(idleWithResumable.resumable.status, 'paused_user');
  assert.equal(idleWithResumable.resumable.overallPercent, 47);
  assert.equal(idleWithResumable.resumable.completedChunks, 3);
  assert.equal(idleWithResumable.resumable.remainingNodes, 42);
  assert.equal(idleWithResumable.resumable.canAutoResume, false);
  assert.equal(idleWithResumable.resumable.lastErrorCode, 'ABORTED');
  assert.equal(idleWithResumable.resumable.secretPrompt, undefined);
  assert.equal(idleWithResumable.resumable.extraJunk, undefined);
  assert.doesNotMatch(JSON.stringify(idleWithResumable), /secretleak|PRIVATE_TRANSCRIPT/);

  // Invalid resumable (missing/bad jobId) sanitizes to null
  assert.equal(tracker.snapshot('sess-bad', { resumable: { status: 'paused' } }).resumable, null);
  assert.equal(tracker.snapshot('sess-bad', { resumable: 'invalid' }).resumable, null);
  assert.ok(observedRunId);
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
