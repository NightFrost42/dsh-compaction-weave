import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { resolveConfig } from '../lib/config.js';
import { prepareContinuation } from '../lib/continuation.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { CompactionProgressTracker, normalizeRetryReasonCode } from '../lib/progress-tracker.js';
import { buildCompactionInstruction } from '../lib/prompt.js';
import { resolveSummaryCapacity } from '../lib/summary-budget.js';

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
const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

const EN_HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeSummary(extra = 'Continue engineering work cleanly.') {
  return EN_HEADINGS.map((h, idx) =>
    `${h}\n${idx === 5 ? '[filled by engine]' : idx === 8 ? extra : 'Archived details preserved.'}`,
  ).join('\n\n');
}

const VALID_CONTINUATION_NOTES = [
  '## Goal',
  'Keep strict WAL durability.',
  '',
  '## State',
  'Completed initial scan of archived tool logs.',
  '',
  '## Next',
  'Continue remaining verification steps.',
  '',
  '## Uncertain',
  'None.',
].join('\n');

const SECRET_SK = ['sk', 'liveTest987654'].join('-');
const SECRET_GH = ['ghp', 'liveTest987654'].join('_');
const SECRET_PREFIXED = ['err', 'sk', 'liveTest987654'].join('-');
const SECRET_BEARER = `Bearer ${'abc123456789'}`;

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of tree.children ?? []) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

function textOf(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (!tree || typeof tree !== 'object') return '';
  return (tree.children ?? []).map(textOf).join(' ');
}

function depsChanged(prev, next) {
  if (prev === undefined || next === undefined) return true;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i += 1) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

function mountProgressCard({ language = 'zh', handler } = {}) {
  let mod;
  let dictionaries;
  const registeredSlots = new Map();
  let stateIndex = 0;
  let effectIndex = 0;
  const states = [];
  const effects = [];
  const pendingFetches = new Set();
  const timers = new Map();
  let nextTimerId = 1;

  const doc = {
    visibilityState: 'visible',
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
  };

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
    }),
    useState: (initialState) => {
      const index = stateIndex++;
      if (!(index in states)) {
        states[index] = typeof initialState === 'function' ? initialState() : initialState;
      }
      return [
        states[index],
        (value) => {
          states[index] = typeof value === 'function' ? value(states[index]) : value;
        },
      ];
    },
    useEffect: (callback, deps) => {
      const index = effectIndex++;
      const prev = effects[index];
      if (!prev || depsChanged(prev.deps, deps)) {
        effects[index] = { callback, deps, pending: true, cleanup: prev?.cleanup };
      }
    },
  };

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (declaration) => {
          mod = declaration.factory((name) => {
            assert.equal(name, 'react');
            return React;
          });
        },
      },
    },
    document: doc,
    console,
    AbortController,
    setTimeout: (fn, delay) => {
      const id = nextTimerId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    setInterval: () => {
      throw new Error('setInterval not allowed');
    },
    clearInterval: () => {},
    fetch: (_url, options) => {
      const payload = JSON.parse(options.body);
      const task = (async () => {
        const result = await handler(payload);
        return { status: 200, text: async () => JSON.stringify({ ok: true, value: result }) };
      })();
      pendingFetches.add(task);
      void task.finally(() => pendingFetches.delete(task));
      return task;
    },
  };

  vm.runInNewContext(clientSource, sandbox);
  mod.apply({
    slots: {
      inject: (_name, cb) => cb(),
      register: (descriptor, component) => {
        registeredSlots.set(descriptor.name, { descriptor, component });
        return () => {};
      },
    },
    effect: (cb) => cb(),
    locale: {
      register: (_ns, values) => {
        dictionaries = values;
        return () => {};
      },
      bind: () => (key) => {
        assert.equal(typeof dictionaries?.[language]?.[key], 'string', `Missing ${language} translation: ${key}`);
        return dictionaries[language][key];
      },
    },
  });

  const Card = registeredSlots.get('conversation.input.dock').component;
  let lastProps = {};

  const flushEffects = () => {
    for (const slot of effects) {
      if (slot && slot.pending) {
        slot.pending = false;
        if (typeof slot.cleanup === 'function') slot.cleanup();
        slot.cleanup = slot.callback();
      }
    }
  };

  const render = (props = lastProps) => {
    lastProps = props;
    stateIndex = 0;
    effectIndex = 0;
    const tree = Card(props);
    flushEffects();
    return tree;
  };

  const settle = async () => {
    for (let i = 0; i < 6; i += 1) {
      if (pendingFetches.size > 0) await Promise.all([...pendingFetches]);
      await new Promise((resolve) => setImmediate(resolve));
      render(lastProps);
    }
    return render(lastProps);
  };

  const fireNextTimer = async () => {
    const first = timers.entries().next();
    assert.ok(!first.done, 'Expected a scheduled poll timer');
    const [id, entryTimer] = first.value;
    timers.delete(id);
    entryTimer.fn();
    return settle();
  };

  const unmount = () => {
    for (const slot of effects) {
      if (typeof slot?.cleanup === 'function') slot.cleanup();
    }
  };

  return { dictionaries, render, settle, fireNextTimer, unmount };
}

function createFakeSession() {
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const session = {
    id: `sess-${randomUUID()}`,
    header: { version: 4, id: 'placeholder', createdAt: Date.now(), isSeeded: false },
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => [...events],
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    toolHistory: () => [],
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (event.type === 'assistant/message') return event.data.message;
      if (event.type === 'system/message') return event.data.message;
      if (event.type === 'user/message') return event.data;
      return undefined;
    },
    append(type, data, options = {}) {
      const event = {
        seq: events.length,
        time: Date.now() + events.length,
        type,
        data,
        ...(options.surfaceOp !== undefined ? { surfaceOp: options.surfaceOp } : {}),
        ...(Array.isArray(options.sourceEventSeqs) ? { sourceEventSeqs: [...options.sourceEventSeqs] } : {}),
      };
      events.push(event);
      if (options.surfaceOp?.op === 'replace') {
        const s = surface.nodes.indexOf(options.surfaceOp.startSeq);
        const e = surface.nodes.indexOf(options.surfaceOp.endSeq);
        assert.ok(s >= 0 && e >= s);
        surface.nodes.splice(s, e - s + 1, event.seq);
        surface.replaceGeneration += 1;
      } else if (options.surfaceOp === 'append') {
        surface.nodes.push(event.seq);
      }
      return event;
    },
  };
  session.header.id = session.id;
  return {
    session,
    addSystem: (text) =>
      session.append(
        'system/message',
        { message: { id: randomUUID(), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } } },
        { surfaceOp: 'append' },
      ),
    addUser: (text) =>
      session.append(
        'user/message',
        { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
        { surfaceOp: 'append' },
      ),
    addAssistant: (text) =>
      session.append(
        'assistant/message',
        { message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } } },
        { surfaceOp: 'append' },
      ),
  };
}

await test('progress-tracker-whitelist-sanitization-auto-reset-and-finish', async () => {
  let now = 1000;
  const tracker = new CompactionProgressTracker({ clock: () => now, doneTtlMs: 60_000 });
  const sid = 'sess-tracker-1';

  // Idle snapshot includes retryReasonCode: null
  assert.equal(tracker.snapshot(sid).retryReasonCode, null);

  await tracker.withRun(sid, { trigger: 'manual', phase: 'summarizing' }, async () => {
    assert.equal(tracker.snapshot(sid).retryReasonCode, null);

    // Valid codes accepted
    tracker.update(sid, { chunkIndex: 1, chunkTotal: 3, attempt: 1, maxAttempts: 3 });
    tracker.update(sid, { retryReasonCode: 'CONSTRAINT_LOST' });
    assert.equal(tracker.snapshot(sid).retryReasonCode, 'CONSTRAINT_LOST');

    // Same chunkIndex on attempt 2 preserves retryReasonCode
    tracker.update(sid, { chunkIndex: 1, attempt: 2 });
    assert.equal(tracker.snapshot(sid).retryReasonCode, 'CONSTRAINT_LOST');

    // Reject prose, generic names, secrets, overlong strings, and non-strings
    for (const bad of [
      'prose with spaces',
      'Error',
      'TypeError',
      'RangeError',
      'ERROR',
      'UNKNOWN',
      SECRET_SK,
      SECRET_GH,
      SECRET_PREFIXED,
      SECRET_BEARER,
      'A'.repeat(81),
      123,
      true,
      { code: 'CONSTRAINT_LOST' },
      '',
    ]) {
      tracker.update(sid, { retryReasonCode: bad });
      assert.equal(
        tracker.snapshot(sid).retryReasonCode,
        'CONSTRAINT_LOST',
        `rejected value ${JSON.stringify(bad)} must not overwrite valid retryReasonCode`,
      );
    }

    // Explicit null clears retryReasonCode
    tracker.update(sid, { retryReasonCode: null });
    assert.equal(tracker.snapshot(sid).retryReasonCode, null);

    // Auto-clear when chunkIndex advances to a new non-null index
    tracker.update(sid, { retryReasonCode: 'SUMMARY_TIMEOUT' });
    assert.equal(tracker.snapshot(sid).retryReasonCode, 'SUMMARY_TIMEOUT');
    tracker.update(sid, { chunkIndex: 2, attempt: 1 });
    assert.equal(tracker.snapshot(sid).retryReasonCode, null, 'chunkIndex transition must auto-clear retryReasonCode');

    // Auto-clear when pageIndex advances
    tracker.update(sid, { pageIndex: 1, retryReasonCode: 'CONTINUATION_STRUCTURE' });
    assert.equal(tracker.snapshot(sid).retryReasonCode, 'CONTINUATION_STRUCTURE');
    tracker.update(sid, { pageIndex: 1, attempt: 2 });
    assert.equal(tracker.snapshot(sid).retryReasonCode, 'CONTINUATION_STRUCTURE');
    tracker.update(sid, { pageIndex: 2, attempt: 1 });
    assert.equal(tracker.snapshot(sid).retryReasonCode, null, 'pageIndex transition must auto-clear retryReasonCode');

    // Auto-clear when waveIndex advances, even if patch supplies a rejected retryReasonCode
    tracker.update(sid, { waveIndex: 1, retryReasonCode: 'RATE_LIMITED' });
    assert.equal(tracker.snapshot(sid).retryReasonCode, 'RATE_LIMITED');
    tracker.update(sid, { waveIndex: 2, retryReasonCode: SECRET_SK });
    assert.equal(tracker.snapshot(sid).retryReasonCode, null, 'waveIndex transition with rejected code must clear stale code');

    // Explicit valid retryReasonCode alongside index advance is honored
    tracker.update(sid, { waveIndex: 3, retryReasonCode: 'MAX_TOKENS' });
    assert.equal(tracker.snapshot(sid).retryReasonCode, 'MAX_TOKENS');

    // Explicit finish() clears retryReasonCode to null
    now += 500;
    tracker.finish(sid);
    assert.equal(tracker.snapshot(sid).phase, 'done');
    assert.equal(tracker.snapshot(sid).retryReasonCode, null, 'finish() must clear retryReasonCode to null');
  });
});

await test('normalizeRetryReasonCode-maps-rate-limit-all-known-codes-and-rejects-prose-secrets', () => {
  // Rate limit detection via isRateLimitError and HTTP 429 variants
  assert.equal(normalizeRetryReasonCode({ status: 429 }), 'RATE_LIMITED');
  assert.equal(normalizeRetryReasonCode({ httpStatus: 429 }), 'RATE_LIMITED');
  assert.equal(normalizeRetryReasonCode({ statusCode: 429 }), 'RATE_LIMITED');
  assert.equal(normalizeRetryReasonCode({ cause: { status: 429 } }), 'RATE_LIMITED');
  assert.equal(normalizeRetryReasonCode(new Error('HTTP 429 Too Many Requests')), 'RATE_LIMITED');
  assert.equal(normalizeRetryReasonCode({ code: 'rate_limit_exceeded' }), 'RATE_LIMITED');
  assert.equal(normalizeRetryReasonCode('TPM quota exceeded'), 'RATE_LIMITED');

  // All 12 known codes
  const knownCodes = [
    'CONSTRAINT_LOST',
    'CONSTRAINT_POLARITY_LOST',
    'SUMMARY_NOT_SMALLER',
    'SUMMARY_STRUCTURE_INVALID',
    'CONTINUATION_STRUCTURE',
    'PROGRESS_FACT_CONFLICT',
    'RETIRED_MEMORY_REINTRODUCED',
    'EMPTY_SUMMARY',
    'MAX_TOKENS',
    'SUMMARY_TIMEOUT',
    'RATE_LIMITED',
    'CONTEXT_WINDOW_EXCEEDED',
  ];
  for (const code of knownCodes) {
    assert.equal(normalizeRetryReasonCode({ code }), code);
    assert.equal(normalizeRetryReasonCode({ failureCode: code }), code);
  }

  // Context window aliases & HTTP 413
  assert.equal(normalizeRetryReasonCode({ code: 'context_length_exceeded' }), 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(normalizeRetryReasonCode({ httpStatus: 413 }), 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(normalizeRetryReasonCode(new Error('maximum context length exceeded')), 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(normalizeRetryReasonCode({ code: 'ECONNRESET' }), 'ECONNRESET');

  // Rejections: generic errors, prose, secrets, null/undefined
  assert.equal(normalizeRetryReasonCode(null), null);
  assert.equal(normalizeRetryReasonCode(undefined), null);
  assert.equal(normalizeRetryReasonCode(new Error('raw private transcript text')), null);
  assert.equal(normalizeRetryReasonCode(new TypeError('cannot read property')), null);
  assert.equal(normalizeRetryReasonCode({ code: 'Error' }), null);
  assert.equal(normalizeRetryReasonCode({ code: 'TypeError' }), null);
  assert.equal(normalizeRetryReasonCode({ code: 'UNKNOWN' }), null);
  assert.equal(normalizeRetryReasonCode({ code: 'freeform prose reason' }), null);
  assert.equal(normalizeRetryReasonCode({ code: SECRET_SK }), null);
  assert.equal(normalizeRetryReasonCode({ code: SECRET_GH }), null);
  assert.equal(normalizeRetryReasonCode({ code: SECRET_PREFIXED }), null);
  assert.equal(normalizeRetryReasonCode({ code: SECRET_BEARER }), null);
});

await test('engine-direct-and-concurrent-chunks-report-retryReasonCode-and-clear-on-commit', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-retry-engine-'));
  try {
    // 1. Direct _compactSpan path: attempt 1 -> SUMMARY_STRUCTURE_INVALID, attempt 2 -> 429 RATE_LIMITED, attempt 3 -> valid summary
    const f1 = createFakeSession();
    f1.addSystem('System.');
    f1.addUser('Keep strict integer cents.');
    f1.addAssistant('Detailed engineering output. '.repeat(400));
    f1.addAssistant('Short tail.');

    const tracker = new CompactionProgressTracker();
    const observedDuringAttempts = [];
    let attemptNum = 0;

    const ctx1 = {
      on() {},
      provide() {},
      logger: { info() {}, warn() {}, error() {} },
      sessions: { flush: async () => {}, get: (id) => (id === f1.session.id ? f1.session : undefined) },
      tokenMeter: {
        measure: (s) => {
          const nodes = s.surface.nodes.map((seq) => ({
            seq,
            tokens: approxTokens(blocksToText(s.deriveEventMessage(s.eventAt(seq))?.content)),
          }));
          return { nodes, totalTokens: nodes.reduce((a, b) => a + b.tokens, 0), precision: 'priced' };
        },
      },
      llm: {
        async resolveModelInfo() {
          return { contextWindow: 200000 };
        },
        async *stream() {
          attemptNum += 1;
          observedDuringAttempts.push({
            attempt: attemptNum,
            retryReasonCode: tracker.snapshot(f1.session.id).retryReasonCode,
            rateLimited: tracker.snapshot(f1.session.id).rateLimited,
          });
          if (attemptNum === 1) {
            yield { type: 'text-delta', text: 'Done.' };
            yield { type: 'finish', kind: 'stop' };
            return;
          }
          if (attemptNum === 2) {
            throw Object.assign(new Error('HTTP 429 Too Many Requests'), { status: 429, code: 'RATE_LIMIT' });
          }
          yield { type: 'text-delta', text: makeSummary('Keep strict integer cents.') };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    };

    const cfg1 = resolveConfig({
      archiveDir: join(root, 'archive-1'),
      language: 'en',
      summaryRetryCount: 2,
      summaryRetryDelayMs: 0,
      observationMaskingEnabled: false,
      microcompactEnabled: false,
      proactiveEnabled: false,
    }).config;

    const engine1 = new WeaveCompactionEngine(ctx1, cfg1);
    engine1.progressTracker = tracker;
    engine1.historyToolsAvailable = true;
    const agent1 = { session: f1.session, options: { provider: 'p', model: 'm' }, runMaintenance: (fn) => fn(new AbortController().signal) };

    const res1 = await engine1.compactNow(agent1, new AbortController().signal);
    assert.ok(res1, 'direct compaction should succeed on attempt 3');
    assert.equal(attemptNum, 3);
    assert.equal(observedDuringAttempts[0].retryReasonCode, null, 'attempt 1 starts with null retryReasonCode');
    assert.equal(observedDuringAttempts[1].retryReasonCode, 'SUMMARY_STRUCTURE_INVALID', 'attempt 2 must show attempt 1 structure failure code');
    assert.equal(observedDuringAttempts[2].retryReasonCode, 'RATE_LIMITED', 'attempt 3 must show attempt 2 RATE_LIMITED code');
    assert.equal(observedDuringAttempts[2].rateLimited, true, 'HTTP 429 retry must also flag rateLimited');
    assert.equal(tracker.snapshot(f1.session.id).retryReasonCode, null, 'finished run must clear retryReasonCode to null');
    engine1.dispose();

    // 2. Concurrent multi-chunk path (_compactChunksConcurrent): chunk retry reports retryReasonCode and clears on commit
    const f2 = createFakeSession();
    f2.addSystem('System.');
    f2.addUser('Preserve deterministic output ordering.');
    for (let i = 0; i < 6; i += 1) {
      f2.addAssistant(`Chunk payload ${i}: ${'engineering trace '.repeat(260)}`);
    }
    f2.addAssistant('Short tail.');

    const tracker2 = new CompactionProgressTracker();
    const seenReasons = [];
    const origUpdate = tracker2.update.bind(tracker2);
    tracker2.update = (sid, patch, opts) => {
      const ok = origUpdate(sid, patch, opts);
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'retryReasonCode')) {
        seenReasons.push(tracker2.snapshot(sid).retryReasonCode);
      }
      return ok;
    };

    let callIndex = 0;
    const ctx2 = {
      on() {},
      provide() {},
      logger: { info() {}, warn() {}, error() {} },
      sessions: { flush: async () => {}, get: (id) => (id === f2.session.id ? f2.session : undefined) },
      tokenMeter: ctx1.tokenMeter,
      llm: {
        async resolveModelInfo() {
          return { contextWindow: 200000 };
        },
        async *stream() {
          callIndex += 1;
          // Chunk 0 (call 1) succeeds cleanly; first concurrent worker (call 2) fails once with 429 then succeeds!
          if (callIndex === 2) {
            throw Object.assign(new Error('HTTP 429 rate limit'), { status: 429 });
          }
          yield { type: 'text-delta', text: makeSummary('Preserve deterministic output ordering.') };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    };

    const cfg2 = resolveConfig({
      archiveDir: join(root, 'archive-2'),
      language: 'en',
      summaryConcurrency: 2,
      summaryInputMaxBytes: 24000,
      summaryRetryCount: 2,
      summaryRetryDelayMs: 0,
      observationMaskingEnabled: false,
      microcompactEnabled: false,
      proactiveEnabled: false,
      cacheMaxCheckpoints: 10,
    }).config;

    const engine2 = new WeaveCompactionEngine(ctx2, cfg2);
    engine2.progressTracker = tracker2;
    engine2.historyToolsAvailable = true;
    const agent2 = { session: f2.session, options: { provider: 'p', model: 'm' }, runMaintenance: (fn) => fn(new AbortController().signal) };

    const res2 = await engine2.compactNow(agent2, new AbortController().signal);
    assert.ok(res2, 'concurrent compaction should succeed');
    assert.ok(seenReasons.includes('RATE_LIMITED'), `expected RATE_LIMITED in concurrent retry telemetry, got ${JSON.stringify(seenReasons)}`);
    assert.equal(seenReasons.at(-1), null, 'last retryReasonCode update before finish must clear to null');
    assert.equal(tracker2.snapshot(f2.session.id).retryReasonCode, null);
    engine2.dispose();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

await test('prepareContinuation-serial-and-parallel-report-retryReasonCode-and-clear-on-commit', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-retry-cont-'));
  try {
    // 1. Serial continuation pass: page 1 attempt 1 fails with CONTINUATION_STRUCTURE -> retryReasonCode reported & cleared
    const fSerial = createFakeSession();
    fSerial.addSystem('System.');
    const u1 = fSerial.addUser('Keep strict WAL durability.');
    const a1 = fSerial.addAssistant(`Large body 1: ${'alpha '.repeat(2600)}`);
    const a2 = fSerial.addAssistant(`Large body 2: ${'beta '.repeat(2600)}`);
    const seqsSerial = [u1.seq, a1.seq, a2.seq];

    const serialEvents = [];
    let serialCalls = 0;
    const serialCtx = {
      llm: {
        async resolveModelInfo() {
          return { contextWindow: 200000 };
        },
        async *stream() {
          serialCalls += 1;
          if (serialCalls === 1) {
            yield { type: 'text-delta', text: 'Not valid 4-section continuation notes' };
            yield { type: 'finish', kind: 'stop' };
            return;
          }
          yield { type: 'text-delta', text: VALID_CONTINUATION_NOTES };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    };

    const serialPolicy = resolveConfig({
      archiveDir: join(root, 'archive-serial'),
      language: 'en',
      summaryRetryCount: 2,
      summaryRetryDelayMs: 0,
      summaryInputMaxBytes: 32768,
    }).config;

    const serialChain = { targets: [{ provider: 'p', model: 'm' }], source: 'test' };
    const serialCapacity = await resolveSummaryCapacity(serialCtx, serialChain, serialPolicy, new AbortController().signal, { singleTarget: true });

    await prepareContinuation({
      ctx: serialCtx,
      agent: { session: fSerial.session, options: { provider: 'p', model: 'm' } },
      session: fSerial.session,
      seqs: seqsSerial,
      policy: serialPolicy,
      capacity: serialCapacity,
      chain: serialChain,
      compactionId: 'weave-cont-serial-1',
      signal: new AbortController().signal,
      archiveRoot: join(root, 'archive-serial'),
      requestId: 'req-serial-1',
      onProgress: (ev) => serialEvents.push(ev),
    });

    assert.ok(
      serialEvents.some((e) => e.retryReasonCode === 'CONTINUATION_STRUCTURE'),
      `expected CONTINUATION_STRUCTURE in serial continuation progress, got ${JSON.stringify(serialEvents.map((e) => e.retryReasonCode))}`,
    );
    const lastSerialWithReason = [...serialEvents].reverse().find((e) => Object.prototype.hasOwnProperty.call(e, 'retryReasonCode'));
    assert.equal(lastSerialWithReason?.retryReasonCode, null, 'serial continuation must clear retryReasonCode to null on page commit');

    // 2. Parallel map+reduce continuation pass: map hits 429 RATE_LIMITED, reduce hits CONTINUATION_STRUCTURE, final clears null
    const fPar = createFakeSession();
    fPar.addSystem('System.');
    const pu1 = fPar.addUser('Keep strict WAL durability.');
    const pa1 = fPar.addAssistant(`Parallel page 1: ${'gamma '.repeat(5000)}`);
    const pa2 = fPar.addAssistant(`Parallel page 2: ${'delta '.repeat(5000)}`);
    const seqsPar = [pu1.seq, pa1.seq, pa2.seq];

    const parEvents = [];
    let mapCalls = 0;
    let reduceCalls = 0;
    const parCtx = {
      llm: {
        async resolveModelInfo() {
          return { contextWindow: 200000 };
        },
        async *stream(req) {
          const text = JSON.stringify(req.messages);
          const isReduce = text.includes('[Page 1/');
          if (!isReduce) {
            mapCalls += 1;
            if (mapCalls === 1) {
              throw Object.assign(new Error('HTTP 429 Too Many Requests'), { status: 429 });
            }
            yield { type: 'text-delta', text: VALID_CONTINUATION_NOTES };
            yield { type: 'finish', kind: 'stop' };
            return;
          }
          reduceCalls += 1;
          if (reduceCalls === 1) {
            yield { type: 'text-delta', text: 'Incomplete reduce output' };
            yield { type: 'finish', kind: 'stop' };
            return;
          }
          yield { type: 'text-delta', text: VALID_CONTINUATION_NOTES };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    };

    const parPolicy = resolveConfig({
      archiveDir: join(root, 'archive-par'),
      language: 'en',
      summaryConcurrency: 2,
      summaryRetryCount: 2,
      summaryRetryDelayMs: 0,
      summaryInputMaxBytes: 32768,
    }).config;

    const parChain = { targets: [{ provider: 'p', model: 'm' }], source: 'test' };
    const parCapacity = await resolveSummaryCapacity(parCtx, parChain, parPolicy, new AbortController().signal, { singleTarget: true });

    await prepareContinuation({
      ctx: parCtx,
      agent: { session: fPar.session, options: { provider: 'p', model: 'm' } },
      session: fPar.session,
      seqs: seqsPar,
      policy: parPolicy,
      capacity: parCapacity,
      chain: parChain,
      compactionId: 'weave-cont-par-1',
      signal: new AbortController().signal,
      archiveRoot: join(root, 'archive-par'),
      requestId: 'req-par-1',
      parallelContinuation: true,
      rateLimitCooldownMs: 0,
      onProgress: (ev) => parEvents.push(ev),
    });

    assert.ok(reduceCalls >= 2, 'parallel reduce pass should have retried once');
    assert.ok(
      parEvents.some((e) => e.retryReasonCode === 'RATE_LIMITED' && e.rateLimited === true),
      'parallel map 429 must emit retryReasonCode RATE_LIMITED and rateLimited true',
    );
    assert.ok(
      parEvents.some((e) => e.retryReasonCode === 'CONTINUATION_STRUCTURE'),
      'parallel reduce malformed output must emit retryReasonCode CONTINUATION_STRUCTURE',
    );
    const lastParWithReason = [...parEvents].reverse().find((e) => Object.prototype.hasOwnProperty.call(e, 'retryReasonCode'));
    assert.equal(lastParWithReason?.retryReasonCode, null, 'parallel continuation must clear retryReasonCode to null after reduce');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

await test('client-ui-renders-all-cn-en-retry-badges-sanitizes-and-diffs-statusChanged', async () => {
  const expectedLabels = [
    ['CONSTRAINT_LOST', '上次因约束校验未通过重试', 'Retry: constraint audit failed'],
    ['CONSTRAINT_POLARITY_LOST', '上次因约束极性冲突重试', 'Retry: polarity conflict'],
    ['SUMMARY_NOT_SMALLER', '上次因摘要体积未缩小重试', 'Retry: summary not smaller'],
    ['SUMMARY_STRUCTURE_INVALID', '上次因摘要结构不完整重试', 'Retry: invalid structure'],
    ['CONTINUATION_STRUCTURE', '上次因摘要结构不完整重试', 'Retry: invalid structure'],
    ['PROGRESS_FACT_CONFLICT', '上次因进度事实冲突重试', 'Retry: progress fact conflict'],
    ['RETIRED_MEMORY_REINTRODUCED', '上次因引入已取消要求重试', 'Retry: retired requirement'],
    ['EMPTY_SUMMARY', '上次因返回空摘要重试', 'Retry: empty summary'],
    ['MAX_TOKENS', '上次因输出触达上限重试', 'Retry: output truncated'],
    ['SUMMARY_TIMEOUT', '上次因响应超时重试', 'Retry: timeout'],
    ['RATE_LIMITED', '上次因触发限流重试', 'Retry: rate limited'],
    ['CONTEXT_WINDOW_EXCEEDED', '上次因超输入上限重试', 'Retry: input limit exceeded'],
    ['ECONNRESET', '上次因 ECONNRESET 重试', 'Retry: ECONNRESET'],
  ];

  for (const [language, labelIdx, attemptPrefix] of [
    ['zh', 1, '第 2/3 次尝试'],
    ['en', 2, 'Attempt 2/3'],
  ]) {
    let currentRetryReasonCode = null;
    const h = mountProgressCard({
      language,
      handler: () => ({
        active: true,
        runId: 'run-retry-ui',
        seq: 10, // intentionally constant to verify statusChanged diffs retryReasonCode itself!
        sessionId: 'sess-ui-1',
        trigger: 'manual',
        phase: 'summarizing',
        elapsedMs: 1200,
        chunkIndex: 1,
        chunkTotal: 2,
        attempt: 2,
        maxAttempts: 3,
        retryReasonCode: currentRetryReasonCode,
        summaryModel: 'p/m',
      }),
    });

    try {
      // 1. retryReasonCode === null -> renders ZERO extra retry badge
      let tree = h.render({ sessionId: 'sess-ui-1' });
      tree = await h.settle();
      let telemetry = find(tree, (n) => n.props?.['data-compaction-telemetry'] === 'true');
      assert.ok(telemetry, `${language}: telemetry row should exist`);
      assert.equal(telemetry.props['data-retry-reason'], undefined, `${language}: null retryReasonCode must omit data-retry-reason`);
      const baselineText = textOf(telemetry);
      assert.ok(baselineText.includes(attemptPrefix), `${language}: expected ${attemptPrefix} in ${baselineText}`);
      assert.equal(baselineText.includes('上次因'), false);
      assert.equal(baselineText.includes('Retry:'), false);

      // 2. Every known code + generic fallback renders exact label via statusChanged diff (even with constant seq!)
      for (const entry of expectedLabels) {
        const [code, , ] = entry;
        const expected = entry[labelIdx];
        currentRetryReasonCode = code;
        tree = await h.fireNextTimer();
        telemetry = find(tree, (n) => n.props?.['data-compaction-telemetry'] === 'true');
        assert.ok(telemetry, `${language}/${code}: telemetry row must render`);
        assert.equal(telemetry.props['data-retry-reason'], code);
        const text = textOf(telemetry);
        assert.ok(
          text.includes(`${attemptPrefix} · ${expected}`),
          `${language}/${code}: expected "${attemptPrefix} · ${expected}" inside "${text}"`,
        );
      }

      // 3. Returning to null via statusChanged clears badge cleanly
      currentRetryReasonCode = null;
      tree = await h.fireNextTimer();
      telemetry = find(tree, (n) => n.props?.['data-compaction-telemetry'] === 'true');
      assert.equal(telemetry.props['data-retry-reason'], undefined);
      assert.equal(textOf(telemetry), baselineText, `${language}: clearing to null must restore exact baseline telemetry`);

      // 4. Secret, prose, or generic JS error names injected via RPC are stripped by client normalizeStatus
      for (const bad of [SECRET_SK, SECRET_GH, 'some private prose', 'Error', 'TypeError']) {
        currentRetryReasonCode = bad;
        tree = await h.fireNextTimer();
        telemetry = find(tree, (n) => n.props?.['data-compaction-telemetry'] === 'true');
        assert.equal(telemetry.props['data-retry-reason'], undefined, `${language}: bad code ${bad} must be stripped`);
        assert.equal(textOf(telemetry), baselineText, `${language}: bad code ${bad} must render zero extra badge`);
      }
    } finally {
      h.unmount();
    }
  }
});

console.log(JSON.stringify({
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
}, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
