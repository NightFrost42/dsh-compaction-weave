import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

import { resolveConfig } from '../lib/config.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { selectContextCollapseSpan } from '../lib/context-collapse.js';
import { detectBiliSession, buildBiliMigrationPlan } from '../lib/foreign-fold.js';
import { planObservationMask, OBSERVATION_MASK_MARKER } from '../lib/observation-mask.js';
import { buildCompactionInstruction } from '../lib/prompt.js';
import { createSessionBackup } from '../lib/session-backup.js';
import { SessionMemoryStore } from '../lib/session-memory.js';
import { handleSummaryConfigRpc } from '../lib/summary-config.js';

const TEST_BASE = process.env.WEAVE_TEST_ROOT ?? tmpdir();
const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error?.message ?? String(error), stack: error?.stack });
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for: ${label}`)), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

const EN_HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeSummary(section9 = 'Preserve all active rules and continue cleanly.') {
  return EN_HEADINGS.map((h, idx) =>
    `${h}\n${idx === 5 ? '[filled by engine]' : idx === 8 ? section9 : 'Historical details archived; continuing work.'}`,
  ).join('\n\n');
}

function tokensStr(tokenCount, label = 'detail') {
  const unit = `${label} `;
  const targetChars = Math.max(4, tokenCount * 4);
  return unit.repeat(Math.ceil(targetChars / unit.length)).slice(0, targetChars);
}

function createFixture({
  root,
  extraConfig = {},
  windowTokens = 24000,
  summaryText = makeSummary(),
  streamImpl = null,
  baseTime = Date.now() - 45 * 60_000,
  dispatchSessionEvents = true,
} = {}) {
  const logs = [];
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const hooks = new Map();
  const llmCalls = [];
  let seqClock = baseTime;

  const emitEvent = (name, ...args) => {
    for (const fn of hooks.get(name) ?? []) fn(...args);
  };

  const session = {
    id: `sess-${randomUUID()}`,
    header: { version: 4, id: 'placeholder', createdAt: baseTime, isSeeded: false },
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
      if (event.type === 'tool/result') {
        const msg = event.data.message ?? event.data;
        return {
          role: 'tool',
          toolCallId: msg.toolCallId ?? msg.source?.callId,
          content: msg.content,
          ...(msg.isError ? { isError: true } : {}),
        };
      }
      if (event.type === 'system/message') return event.data.message;
      if (event.type === 'user/message') return event.data;
      return undefined;
    },
    append(type, data, options = {}) {
      const time = typeof options.time === 'number' ? options.time : (seqClock += 10);
      const event = {
        seq: events.length,
        time,
        type,
        data,
        ...(options.surfaceOp !== undefined ? { surfaceOp: options.surfaceOp } : {}),
        ...(Array.isArray(options.sourceEventSeqs) ? { sourceEventSeqs: [...options.sourceEventSeqs] } : {}),
      };
      events.push(event);
      const op = options.surfaceOp;
      if (op?.op === 'replace') {
        const start = surface.nodes.indexOf(op.startSeq);
        const end = surface.nodes.indexOf(op.endSeq);
        assert.ok(start >= 0 && end >= start, `invalid replace ${op.startSeq}..${op.endSeq}`);
        surface.nodes.splice(start, end - start + 1, event.seq);
        surface.replaceGeneration += 1;
      } else if (op === 'append') {
        surface.nodes.push(event.seq);
      }
      if (dispatchSessionEvents) emitEvent('session/event', session, event);
      return event;
    },
  };
  session.header.id = session.id;

  const addSystem = (text, time) =>
    session.append(
      'system/message',
      { message: { id: randomUUID(), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } } },
      { surfaceOp: 'append', ...(time === undefined ? {} : { time }) },
    );

  const addUser = (text, { time, source = { kind: 'user' } } = {}) =>
    session.append(
      'user/message',
      { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source },
      { surfaceOp: 'append', ...(time === undefined ? {} : { time }) },
    );

  const addAssistant = (text, time) =>
    session.append(
      'assistant/message',
      { message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } } },
      { surfaceOp: 'append', ...(time === undefined ? {} : { time }) },
    );

  const addToolStep = ({ turn = 1, step = 1, toolName = 'read_file', args = { path: 'src/a.js' }, resultText, isError = false, time }) => {
    const callId = `call-${randomUUID().slice(0, 8)}`;
    const argsJson = JSON.stringify(args);
    const asst = session.append(
      'assistant/message',
      {
        turn,
        step,
        message: {
          id: randomUUID(),
          role: 'assistant',
          source: { kind: 'model', provider: 'p', model: 'm' },
          content: [{ type: 'tool-call', id: callId, name: toolName, arguments: argsJson }],
        },
      },
      { surfaceOp: 'append', ...(time === undefined ? {} : { time }) },
    );
    const tc = session.append('tool/call', { turn, step, callId, name: toolName, arguments: argsJson });
    const tr = session.append(
      'tool/result',
      {
        turn,
        step,
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: callId,
          source: { kind: 'tool', callId },
          content: [{ type: 'text', text: resultText }],
          ...(isError ? { isError: true } : {}),
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [tc.seq], ...(time === undefined ? {} : { time: time + 2 }) },
    );
    return { asst, tc, tr, callId };
  };

  const ctx = {
    on(eventName, fn) {
      if (!hooks.has(eventName)) hooks.set(eventName, []);
      hooks.get(eventName).push(fn);
      return () => {};
    },
    provide() {},
    get() {
      return undefined;
    },
    logger: Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, message => logs.push(String(message))])),
    tokenMeter: {
      measure(s) {
        const nodes = s.surface.nodes.map((seq) => {
          const msg = s.deriveEventMessage(s.eventAt(seq));
          const tokens = Math.max(1, approxTokens(blocksToText(msg?.content)));
          return { seq, tokens, heuristicTokens: tokens };
        });
        const totalTokens = nodes.reduce((sum, n) => sum + n.tokens, 0);
        return { totalTokens, surfaceTokens: totalTokens, nodes, baseline: { kind: 'heuristic' } };
      },
      estimateMessage(message) {
        return Math.max(1, approxTokens(blocksToText(message?.content)));
      },
    },
    llm: {
      resolveModelInfo: async () => ({ contextWindow: windowTokens, maxOutputTokens: 4096 }),
      async *stream(req) {
        llmCalls.push({ req, signal: req?.signal });
        if (typeof streamImpl === 'function') {
          yield* streamImpl(req, req?.signal, llmCalls.length);
          return;
        }
        const text = typeof summaryText === 'function' ? summaryText(req, llmCalls.length) : summaryText;
        yield { type: 'text-delta', text };
        yield { type: 'finish', kind: 'stop', usage: { inputTokens: 80, outputTokens: 40 } };
      },
    },
    sessions: {
      flush: async () => true,
      get: (id) => (id === session.id ? session : null),
    },
    tools: { register: () => () => {} },
  };

  const cfg = resolveConfig({
    archiveDir: join(root, 'archive'),
    proactiveEnabled: false,
    summaryRetryCount: 0,
    summaryConcurrency: 1,
    headroomTokens: 2048,
    thresholdRatio: 0.5,
    ...(extraConfig.retainTokens === undefined ? { retainRatio: 0.1 } : {}),
    language: 'en',
    ...extraConfig,
  }).config;

  const engine = new WeaveCompactionEngine(ctx, cfg);
  engine.historyToolsAvailable = true;

  const agent = {
    session,
    inbox: { nextStep: [], nextTurn: [], prepend() {} },
    options: { provider: 'p', model: 'm' },
    async runMaintenance(fn) {
      return await fn(new AbortController().signal);
    },
  };

  const runPreStep = async (messages = [], signal = new AbortController().signal) => {
    let entered = false;
    const list = hooks.get('agent/pre-step') ?? [];
    assert.ok(list.length > 0);
    await list[0]({ agent, signal, messages }, async () => {
      entered = true;
      return { kind: 'enter' };
    });
    return { entered };
  };

  const cleanup = async () => {
    const pending = [...engine.sessionMemory.inFlight.values()].map(entry => entry.promise);
    engine.dispose();
    await Promise.allSettled(pending);
  };

  return {
    root,
    session,
    agent,
    engine,
    events,
    surface,
    hooks,
    llmCalls, logs, emitEvent,
    addSystem,
    addUser,
    addAssistant,
    addToolStep,
    runPreStep,
    cleanup,
  };
}

const signal = () => new AbortController().signal;
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const bounded = promise => withTimeout(promise, 5000, 'regression operation');

// Gates guarantee that foreground entry occurs while a real refresh is running.
async function withFixture({ config = {}, windowTokens = 200000, failStream = false, dispatch = false } = {}, fn) {
  const gates = [], timers = new Set();
  const root = await mkdtemp(join(TEST_BASE, 'weave-sm-w2-'));
  let f;
  try {
    f = createFixture({
      root, windowTokens, dispatchSessionEvents: dispatch,
      extraConfig: {
        auto: false, proactiveEnabled: false, idleCompactionMinutes: 0,
        idleFullSummaryEnabled: false, microcompactEnabled: false,
        contextCollapseEnabled: false, persistedOutputEnabled: false,
        summaryRetryCount: 0, summaryConcurrency: 1, thresholdRatio: 0.25,
        headroomTokens: 4096, retainTokens: 2048, cachePreservePrefix: false,
        sessionMemoryEnabled: true, sessionMemoryMinTokens: 4096,
        sessionMemoryCooldownMs: 0, sessionMemoryUpdateIntervalTurns: 1,
        sessionMemoryUpdateIntervalTokens: 2048, sessionMemoryMaxCallsPerSession: 8,
        observationMaskingEnabled: true, observationMaskThresholdChars: 2000,
        observationMaskHeadChars: 200, observationMaskTailChars: 200, ...config,
      },
      streamImpl: async function* (req) {
        const gate = gates.find(item => !item.claimed);
        if (gate) {
          gate.claimed = true; gate.started.resolve();
          const onAbort = () => { gate.aborted = true; gate.release.resolve(); };
          req.signal?.addEventListener('abort', onAbort, { once: true });
          try {
            req.signal?.throwIfAborted(); await gate.release.promise; req.signal?.throwIfAborted();
          } finally { req.signal?.removeEventListener('abort', onAbort); }
        }
        if (failStream) throw Object.assign(new Error('simulated background failure'), { code: 'ECONNRESET' });
        yield { type: 'text-delta', text: makeSummary() };
        yield { type: 'finish', kind: 'stop', usage: { inputTokens: 100, outputTokens: 60 } };
      },
    });
    f.gate = () => {
      const gate = { release: deferred(), started: deferred(), claimed: false, aborted: false };
      gates.push(gate); return gate;
    };
    f.later = (fn, ms) => {
      const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
      timers.add(timer); return timer;
    };
    f.addTool = (n, path = 'src/example.js') => f.addToolStep({ args: { path }, resultText: tokensStr(n) }).tr;
    f.measure = () => f.engine.ctx.tokenMeter.measure(f.session);
    f.preStep = async () => { assert.equal((await f.runPreStep()).entered, true); };
    await fn(f);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    try {
      if (f) await f.cleanup();
    } finally {
      for (const gate of gates) gate.release.resolve();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}
function seed(f, { assistantTokens = 6000, toolTokens = 2500, closed = false } = {}) {
  f.session.append('turn/start', { turn: 1 }); f.addSystem('System prompt.');
  for (let i = 0; i < 3; i++) { f.addUser(`Continue task ${i}.`); f.addAssistant(tokensStr(assistantTokens)); }
  if (toolTokens) f.addTool(toolTokens);
  f.addUser(tokensStr(1200)); f.addAssistant(tokensStr(1200));
  if (closed) f.session.append('turn/end', { turn: 1 });
}
const status = f => f.engine.sessionMemoryStatusFor(f.session.id);
function counters(f, callsUsed, totalCallsUsed = callsUsed) {
  const s = status(f);
  assert.equal(s.callsUsed, callsUsed, 'per-cycle callsUsed');
  assert.equal(s.totalCallsUsed, totalCallsUsed, 'lifetime totalCallsUsed');
  assert.equal(s.maxCalls, f.engine.config.sessionMemoryMaxCallsPerSession);
  assert.equal(typeof s.ready, 'boolean'); assert.equal(typeof s.updating, 'boolean');
}
function charge(f, count = 2) {
  for (let i = 0; i < count; i++) f.engine.sessionMemory._store().recordAttempt(f.session.id);
  counters(f, count);
}
async function schedule(f, gate = null) {
  const res = await f.engine.sessionMemory.maybeSchedule({ session: f.session, agent: f.agent });
  assert.equal(res.scheduled, true, JSON.stringify(res));
  if (gate) { await bounded(gate.started.promise); assert.equal(status(f).updating, true); }
  else assert.equal((await bounded(res.promise)).ok, true);
  return res;
}
function assertIdle(f) {
  assert.equal(f.engine.sessionMemory.inFlight.has(f.session.id), false);
  assert.equal(f.engine.sessionMemory._scheduling.has(f.session.id), false);
  assert.equal(status(f).updating, false);
}
function noBreakerFailures(f) {
  assert.equal(f.engine._failures.get(f.session.id) ?? 0, 0);
  assert.equal(f.engine.sessionState.read(f.session.id).failures, 0);
  assert.equal(f.engine._stopped.has(f.session.id), false);
}
function snapshot(f) {
  return JSON.stringify({ surface: f.surface, messages: f.surface.nodes.map(seq => f.session.deriveEventMessage(f.session.eventAt(seq))) });
}
function maskPlan(f) {
  const p = f.engine.config;
  const plan = planObservationMask(f.session, f.measure(), p.retainTokens, {
    compactionId: 'test-preview', thresholdChars: p.observationMaskThresholdChars,
    headChars: p.observationMaskHeadChars, tailChars: p.observationMaskTailChars,
  });
  assert.ok(plan?.targets.length, 'fixture must include a maskable output'); return plan;
}
async function foreground(f, mode) {
  if (mode === 'manual') return bounded(f.engine.compactNow(f.agent, signal()));
  const original = f.engine.compactIfNeeded.bind(f.engine); let res;
  f.engine.compactIfNeeded = async (...args) => { res = await original(...args); return res; };
  try { await bounded(f.preStep()); return res; }
  finally { f.engine.compactIfNeeded = original; }
}

// 1. Compatible refreshes are reused before Stage 1 can mutate the surface.
for (const mode of ['pressure', 'manual']) {
  await test(`${mode}-waits-before-stage1-and-reuses-in-flight-with-zero-sync-calls`, () => withFixture({
    windowTokens: mode === 'pressure' ? 65536 : 1000000,
    config: { auto: mode === 'pressure', ...(mode === 'manual' ? { retainTokens: 0 } : {}) },
  }, async f => {
    assert.equal(f.engine.sessionMemoryWaitMs, 4000); f.engine.sessionMemoryWaitMs = 400;
    seed(f, { assistantTokens: mode === 'manual' ? 23000 : 4500, closed: mode === 'manual' });
    const plan = maskPlan(f), measurement = f.measure();
    if (mode === 'pressure') {
      const spec = await f.engine._resolveSpec(f.agent, measurement, signal());
      const target = Math.min(spec.thresholdTokens - 1, Math.floor(measurement.totalTokens * (1 - spec.policy.minimumReductionRatio)));
      assert.ok(measurement.totalTokens - plan.totalTokensSaved > target);
    }
    const gate = f.gate(), scheduled = await schedule(f, gate), before = snapshot(f);
    const manager = f.engine.sessionMemory, wait = manager.waitForWithin.bind(manager);
    let waits = 0, outcome;
    manager.waitForWithin = async (sid, options) => {
      waits++; assert.equal(snapshot(f), before, 'Stage 1 mutated the surface before wait');
      assert.equal(options.timeoutMs, 400); assert.equal(options.expectedStartSeq, scheduled.range.start);
      const pending = wait(sid, options); f.later(() => gate.release.resolve(), 15);
      outcome = await pending; assert.equal(snapshot(f), before, 'surface changed during wait'); return outcome;
    };
    const res = await foreground(f, mode);
    assert.equal(waits, 1, JSON.stringify({ measurement: measurement.totalTokens, calls: f.llmCalls.length, logs: f.logs })); assert.equal(outcome.status, 'completed'); assert.equal(outcome.result.ok, true);
    assert.ok(res?.compactionId);
    assert.ok(res.sessionMemoryReused, JSON.stringify({ calls: f.llmCalls.length, keys: Object.keys(res), logs: f.logs }));
    assert.equal(f.llmCalls.length, 1); assert.equal(gate.aborted, false);
    assert.equal(f.events.some(e => e.type === 'compaction/prune'), false);
    assertIdle(f); noBreakerFailures(f);
  }));
}
await test('pressure-mask-alone-skips-wait-and-cancels-in-flight-immediately', () => withFixture({
  windowTokens: 65536, config: { auto: true },
}, async f => {
  seed(f, { assistantTokens: 100, toolTokens: 18000 });
  const plan = maskPlan(f), measurement = f.measure(), spec = await f.engine._resolveSpec(f.agent, measurement, signal());
  const target = Math.min(spec.thresholdTokens - 1, Math.floor(measurement.totalTokens * (1 - spec.policy.minimumReductionRatio)));
  assert.ok(measurement.totalTokens - plan.totalTokensSaved <= target);
  const gate = f.gate(), scheduled = await schedule(f, gate), manager = f.engine.sessionMemory;
  manager.waitForWithin = () => assert.fail('mask-only branch must never wait');
  const cancel = manager.cancel.bind(manager); let cancellations = 0;
  manager.cancel = sid => { const t = performance.now(); const res = cancel(sid); assert.ok(performance.now() - t < 50); cancellations++; return res; };
  await foreground(f, 'pressure');
  assert.ok(cancellations > 0); assert.equal(gate.aborted, true); assert.equal((await scheduled.promise).reason, 'aborted');
  assert.ok(f.events.some(e => e.type === 'compaction/prune'));
  assert.ok(f.surface.nodes.some(seq => blocksToText(f.session.deriveEventMessage(f.session.eventAt(seq))?.content).includes(OBSERVATION_MASK_MARKER)));
  assert.ok(f.measure().totalTokens <= target); assert.equal(f.llmCalls.length, 1);
  counters(f, 1); assertIdle(f); noBreakerFailures(f);
}));

// 2. Timeout, abort, focus, compatibility, and planning-only skips.
for (const mode of ['pressure', 'manual']) {
  await test(`${mode}-timeout-cancels-background-and-falls-back-with-zero-breaker-failures`, () => withFixture({
    windowTokens: mode === 'pressure' ? 65536 : 200000, config: { auto: mode === 'pressure', observationMaskingEnabled: false },
  }, async f => {
    seed(f, { toolTokens: 0, closed: mode === 'manual' }); f.engine.sessionMemoryWaitMs = 80;
    const gate = f.gate(), scheduled = await schedule(f, gate), wait = f.engine.sessionMemory.waitForWithin.bind(f.engine.sessionMemory);
    let outcome, elapsed;
    f.engine.sessionMemory.waitForWithin = async (...args) => {
      const t = performance.now(); outcome = await wait(...args); elapsed = performance.now() - t; return outcome;
    };
    const res = await foreground(f, mode);
    assert.equal(outcome.status, 'timeout'); assert.ok(elapsed >= 60 && elapsed < 400, `timeout took ${elapsed}ms`);
    assert.equal(gate.aborted, true); assert.equal((await scheduled.promise).reason, 'aborted');
    assert.ok(res?.compactionId); assert.equal(res.sessionMemoryReused, undefined); assert.equal(f.llmCalls.length, 2);
    assertIdle(f); noBreakerFailures(f);
  }));
}
await test('wait-aborts-under-100ms-with-zero-leaked-timers-or-listeners', () => withFixture({}, async f => {
  seed(f); const gate = f.gate(), scheduled = await schedule(f, gate), controller = new AbortController();
  const reason = Object.assign(new Error('test wait abort'), { name: 'AbortError' });
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout, active = new Set(); let created = 0;
  globalThis.setTimeout = (fn, ms, ...args) => { const timer = realSet(fn, ms, ...args); if (ms === 10000) { active.add(timer); created++; } return timer; };
  globalThis.clearTimeout = timer => { active.delete(timer); return realClear(timer); };
  try {
    const pending = f.engine.sessionMemory.waitForWithin(f.session.id, { timeoutMs: 10000, signal: controller.signal });
    assert.equal(active.size, 1); assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    const t = performance.now(); controller.abort(reason);
    await assert.rejects(pending, e => e === reason); assert.ok(performance.now() - t < 100);
    assert.equal(active.size, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await assert.rejects(f.engine.sessionMemory.waitForWithin(f.session.id, { signal: controller.signal }), e => e === reason);
    assert.equal(created, 1, 'already-aborted wait must not arm another timer');
  } finally {
    globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; for (const timer of active) realClear(timer);
  }
  f.engine.sessionMemory.cancel(f.session.id); assert.equal((await scheduled.promise).reason, 'aborted'); assertIdle(f);
}));
await test('focused-compact-skips-wait-under-50ms-and-cancels-cleanly', () => withFixture({ config: { observationMaskingEnabled: false } }, async f => {
  seed(f, { closed: true }); f.engine.sessionMemoryWaitMs = 10000;
  const gate = f.gate(), scheduled = await schedule(f, gate), manager = f.engine.sessionMemory;
  manager.waitForWithin = () => assert.fail('/compact <focus> must never wait');
  const t = performance.now();
  assert.deepEqual(await f.engine._awaitOrCancelSessionMemory(f.session, f.engine.config, signal(), { focusInstruction: 'Focus on next steps.' }), { status: 'ineligible' });
  assert.ok(performance.now() - t < 50); assert.equal((await scheduled.promise).reason, 'aborted');
  const nextGate = f.gate(), next = await schedule(f, nextGate), cancel = manager.cancel.bind(manager); let cancelMs;
  manager.cancel = sid => { const start = performance.now(); const res = cancel(sid); cancelMs = performance.now() - start; return res; };
  const res = await bounded(f.engine.compactNow(f.agent, signal(), undefined, false, { focusInstruction: 'Focus on next steps.' }));
  assert.ok(res?.compactionId); assert.equal(res.sessionMemoryReused, undefined);
  assert.ok(cancelMs < 50); assert.equal(nextGate.aborted, true); assert.equal((await next.promise).reason, 'aborted');
  assert.equal(f.llmCalls.length, 3); assertIdle(f); noBreakerFailures(f);
}));
for (const mismatch of ['policy', 'start-seq']) {
  await test(`${mismatch}-mismatch-skips-under-50ms-and-cancels-cleanly`, () => withFixture({}, async f => {
    seed(f); f.engine.sessionMemoryWaitMs = 10000;
    const gate = f.gate(), scheduled = await schedule(f, gate);
    const policy = mismatch === 'policy' ? { ...f.engine.config, language: 'zh' } : f.engine.config;
    const expectedStartSeq = scheduled.range.start + (mismatch === 'start-seq' ? 1 : 0);
    const expected = { status: 'incompatible', reason: mismatch === 'policy' ? 'policy-mismatch' : 'start-seq-mismatch' };
    let t = performance.now();
    assert.deepEqual(await f.engine.sessionMemory.waitForWithin(f.session.id, { timeoutMs: 10000, policy, expectedStartSeq }), expected);
    assert.ok(performance.now() - t < 50); t = performance.now();
    assert.deepEqual(await f.engine._awaitOrCancelSessionMemory(f.session, policy, signal(), { expectedStartSeq }), expected);
    assert.ok(performance.now() - t < 50); assert.equal((await scheduled.promise).reason, 'aborted');
    assert.equal(gate.aborted, true); assertIdle(f); noBreakerFailures(f);
  }));
}
await test('idle-and-pure-scheduling-skip-under-50ms-and-cancel-planning', () => withFixture({}, async f => {
  seed(f); const manager = f.engine.sessionMemory; let t = performance.now();
  assert.deepEqual(await manager.waitForWithin(f.session.id, { timeoutMs: 10000 }), { status: 'none' });
  assert.ok(performance.now() - t < 50);
  const entered = deferred(), release = deferred(), measure = f.engine._measure.bind(f.engine);
  f.engine._measure = async session => { entered.resolve(); await release.promise; return measure(session); };
  const pending = manager.maybeSchedule({ session: f.session, agent: f.agent });
  try {
    await bounded(entered.promise); assert.equal(manager._scheduling.has(f.session.id), true); assert.equal(manager.inFlight.has(f.session.id), false);
    t = performance.now(); assert.deepEqual(await manager.waitForWithin(f.session.id, { timeoutMs: 10000 }), { status: 'none' });
    assert.ok(performance.now() - t < 50); t = performance.now();
    assert.deepEqual(await f.engine._awaitOrCancelSessionMemory(f.session, f.engine.config, signal()), { status: 'none' });
    assert.ok(performance.now() - t < 50); assert.equal(manager._scheduling.get(f.session.id).signal.aborted, true);
  } finally { release.resolve(); f.engine._measure = measure; await bounded(pending); }
  assert.equal((await pending).reason, 'aborted'); assert.equal(f.llmCalls.length, 0); assertIdle(f);
}));

// 3. Successful durable checkpoints alone reset the cycle.
await test('weave-commit-resets-cycle-and-resumes-after-two-call-fuse', () => withFixture({
  config: { sessionMemoryMaxCallsPerSession: 2, observationMaskingEnabled: false },
}, async f => {
  seed(f, { toolTokens: 0, closed: true }); await schedule(f); counters(f, 1);
  f.engine.sessionMemory.clear(f.session.id); await schedule(f); counters(f, 2);
  const refused = await f.engine.sessionMemory.maybeSchedule({ session: f.session, agent: f.agent });
  assert.equal(refused.scheduled, false); assert.equal(refused.reason, 'max-calls-reached'); assert.equal(f.llmCalls.length, 2);
  const res = await foreground(f, 'manual'); assert.ok(res?.compactionId);
  assert.equal(f.session.deriveEventMessage(f.session.eventAt(res.replacementSeq)).source.kind, 'compact-checkpoint');
  assert.ok(f.events.some(e => e.type === 'compaction/end' && e.data.compactionId === res.compactionId && !e.data.error));
  counters(f, 0, 2); assert.equal(status(f).ready, false);
  f.addUser('Continue next cycle.'); f.addAssistant(tokensStr(9000)); f.addUser(tokensStr(1200)); f.addAssistant(tokensStr(1200));
  await schedule(f); counters(f, 1, 3); assert.equal(status(f).ready, true); assertIdle(f);
}));
await test('bili-fold-adopt-commit-resets-cycle-and-preserves-total', () => withFixture({}, async f => {
  f.addSystem('System prompt.'); f.session.append('turn/start', { turn: 1 });
  f.session.append('user/message', {
    id: randomUUID(), role: 'user', source: { kind: 'compact-checkpoint', compactionId: 'bili-authored-1' },
    content: [{ type: 'text', text: '[Compressed conversation section]\nEarlier task details.' }, { type: 'text', text: '<bili-snapshot v1 blocks="1" tokens="42000" />' }],
  }, { surfaceOp: 'append' });
  f.addUser('Continue the task.'); f.addAssistant('Acknowledged.'); f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); charge(f);
  const detection = detectBiliSession(f.session); assert.equal(detection.detected, true);
  assert.equal(buildBiliMigrationPlan(f.session, detection).strategy, 'fold-adopt');
  const logPath = join(f.root, 'session.v4.jsonl');
  await writeFile(logPath, `${JSON.stringify(f.session.header)}\n${f.events.map(e => JSON.stringify(e)).join('\n')}\n`);
  const res = await f.engine.migrateBiliSession(f.session, { logPath, sessions: f.engine.ctx.sessions, asyncRollingWave: false });
  assert.equal(res.completed, true); assert.equal(res.accepted, true);
  assert.ok(f.events.some(e => e.type === 'compaction/summary' && e.data.model === 'fold-adopt'));
  assert.equal(detectBiliSession(f.session).detected, false); counters(f, 0, 2); assert.equal(f.llmCalls.length, 0);
  f.engine.sessionMemory._store().recordAttempt(f.session.id); counters(f, 1, 3);
}));

// 4. Each negative guard must actually perform its named operation.
await test('default-clear-and-keep-billing-counter-never-reset-cycle', () => withFixture({}, async f => {
  seed(f); await schedule(f); const store = f.engine.sessionMemory._store(), memory = store.read(f.session.id).memory; store.recordAttempt(f.session.id);
  for (const options of [{ keepBillingCounter: true }, undefined]) {
    store.saveMemory(f.session.id, memory); assert.equal(status(f).ready, true);
    assert.equal(f.engine.sessionMemory.clear(f.session.id, options), true); assert.equal(status(f).ready, false); counters(f, 2);
  }
}));
await test('session-reset-and-restored-events-invalidate-without-resetting-cycle', () => withFixture({ dispatch: true }, async f => {
  seed(f); await schedule(f); const store = f.engine.sessionMemory._store(), memory = store.read(f.session.id).memory; store.recordAttempt(f.session.id);
  for (const event of ['session/reset', 'session/restored']) {
    store.saveMemory(f.session.id, memory); assert.equal(status(f).ready, true);
    f.session.append(event, {}); assert.equal(status(f).ready, false); counters(f, 2);
  }
}));
await test('restore-backup-invalidates-memory-without-resetting-cycle', () => withFixture({}, async f => {
  seed(f); await schedule(f); f.engine.sessionMemory._store().recordAttempt(f.session.id);
  const logPath = join(f.root, 'backup-session.v4.jsonl'), original = '{"seq":0}\n'; await writeFile(logPath, original);
  const backup = await createSessionBackup(f.engine.backupStore, { session: f.session, logPath, reason: 'cycle-test' }); assert.equal(backup.ok, true);
  await writeFile(logPath, '{"seq":1}\n');
  const res = await f.engine.restoreSessionBackupFor(f.session.id, { backupId: backup.backupId, sessions: { get: () => null }, logPath });
  assert.equal(res.status, 'restored'); assert.equal(await readFile(logPath, 'utf8'), original); assert.equal(status(f).ready, false); counters(f, 2);
}));
await test('recover-pending-rolls-back-surface-without-resetting-cycle', () => withFixture({}, async f => {
  seed(f); await schedule(f); f.engine.sessionMemory._store().recordAttempt(f.session.id);
  const before = [...f.surface.nodes], start = before[1], end = before.at(-1), id = 'weave-rollback-cycle';
  f.session.append('compaction/start', { compactionId: id, turn: 1 });
  await f.engine._journalRecord(f.session, id, 'started', start, end); await f.engine._journalRecord(f.session, id, 'committing', start, end);
  f.session.append('user/message', { id: randomUUID(), role: 'user', source: { kind: 'compact-checkpoint', compactionId: id }, content: [{ type: 'text', text: 'uncommitted' }] }, { surfaceOp: { op: 'replace', startSeq: start, endSeq: end } });
  f.session.restoreCompactionSurface = (compactionId, reason) => {
    assert.equal(compactionId, id); f.surface.nodes.splice(0, f.surface.nodes.length, ...before); f.surface.replaceGeneration++;
    return f.session.append('compaction/rollback', { compactionId, reason });
  };
  assert.notDeepEqual(f.surface.nodes, before); const res = await f.engine.recoverPending(f.session);
  assert.ok(res.restored > 0); assert.ok(res.recovered > 0); assert.deepEqual(f.surface.nodes, before);
  assert.deepEqual(await f.engine.journal.pending(f.session.id), []); assert.equal(status(f).ready, false); counters(f, 2);
}));
await test('tier1-microcompact-mutates-tools-without-resetting-cycle', () => withFixture({ config: {
  idleCompactionMinutes: 30, microcompactEnabled: true, microcompactKeepRecentTools: 1,
  microcompactThresholdChars: 2000, microcompactHeadChars: 200, microcompactTailChars: 200,
} }, async f => {
  seed(f, { assistantTokens: 100, toolTokens: 14000 }); f.addTool(500, 'src/hot.js'); charge(f); f.session.append('turn/end', { turn: 1 });
  const now = Date.now(), incoming = { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue.' }] };
  f.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [incoming] }, { time: now - 1 });
  f.session.append('turn/start', { turn: 2 }, { time: now });
  const res = await f.engine._compactBeforeResume(f.agent, signal(), [incoming]);
  assert.equal(res?.status, 'microcompacted'); assert.ok(res.result.maskedCount > 0); assert.ok(f.events.some(e => e.type === 'compaction/prune'));
  counters(f, 2); assert.equal(f.llmCalls.length, 0);
}));
await test('tier2-context-collapse-checkpoint-never-resets-cycle', () => withFixture({ config: {
  contextCollapseEnabled: true, contextCollapseMinTokens: 8192, contextCollapseMaxSpanTokens: 16384,
  contextCollapseKeepRecentTokens: 2048, contextCollapseKeepRecentTurns: 2,
} }, async f => {
  seed(f, { toolTokens: 0 }); charge(f); const measurement = f.measure();
  const plan = selectContextCollapseSpan(f.session, f.surface.nodes, f.engine.config, { measurement }); assert.ok(plan?.seqs.length);
  const res = await f.engine._runContextCollapse(f.agent, plan, f.engine.config, signal(), measurement.totalTokens); assert.ok(res?.compactionId);
  assert.equal(f.session.deriveEventMessage(f.session.eventAt(res.replacementSeq)).source.contextCollapse, true);
  assert.ok(f.events.some(e => e.type === 'compaction/end' && e.data.compactionId === res.compactionId && !e.data.error));
  counters(f, 2); assert.equal(f.llmCalls.length, 1);
}));
await test('persisted-output-spills-tool-without-resetting-cycle', () => withFixture({ config: {
  persistedOutputEnabled: true, persistedOutputThresholdChars: 2048, persistedOutputHeadChars: 200, persistedOutputTailChars: 200,
} }, async f => {
  seed(f, { toolTokens: 0 }); const tool = f.addTool(10000); charge(f);
  const res = await f.engine._spillTailToolOutputs(f.agent, signal()); assert.ok(res?.maskedSeqs.includes(tool.seq));
  assert.ok(res.shadowedTokenCount > 0); assert.equal(f.surface.nodes.includes(tool.seq), false); counters(f, 2); assert.equal(f.llmCalls.length, 0);
}));
await test('observation-masking-prunes-without-resetting-cycle', () => withFixture({ windowTokens: 65536 }, async f => {
  seed(f, { assistantTokens: 100, toolTokens: 18000 }); charge(f); maskPlan(f);
  const res = await f.engine.compactIfNeeded(f.agent, 'pressure', signal());
  assert.ok(res?.compactionId); assert.ok(f.events.some(e => e.type === 'compaction/prune')); counters(f, 2); assert.equal(f.llmCalls.length, 0);
}));
await test('emergency-snip-prunes-history-without-resetting-cycle', () => withFixture({ config: {
  snipEnabled: true, snipKeepRecentTurns: 1, snipKeepRecentTokens: 2048, snipMinSavingsTokens: 1024,
} }, async f => {
  f.addSystem('System prompt.');
  for (let turn = 1; turn <= 5; turn++) {
    f.session.append('turn/start', { turn }); f.addUser(`Continue task ${turn}.`); f.addAssistant(tokensStr(4000));
    f.session.append('turn/end', { turn, reason: { kind: 'completed' } });
  }
  f.session.append('turn/start', { turn: 6 }); f.addUser('Continue.'); charge(f);
  const before = f.measure().totalTokens;
  const res = await f.engine._emergencySnip(f.agent, { policy: f.engine.config, messageBudgetTokens: 10000, thresholdTokens: 8000 }, signal());
  assert.ok(res?.compactionId); assert.equal(res.mode, 'snip');
  assert.ok(res.stubSeqs.some(seq => f.session.deriveEventMessage(f.session.eventAt(seq))?.source?.snip === true));
  assert.ok(f.measure().totalTokens < before); assert.ok(f.measure().totalTokens < 10000); counters(f, 2); assert.equal(f.llmCalls.length, 0);
}));
await test('failed-background-retries-charge-both-counters-and-stop-at-fuse', () => withFixture({ failStream: true, config: { sessionMemoryMaxCallsPerSession: 2 } }, async f => {
  seed(f); const store = f.engine.sessionMemory._store(), record = store.recordAttempt.bind(store); let attempts = 0;
  f.engine.sessionMemory._store = () => store;
  store.recordAttempt = (...args) => { attempts++; return record(...args); };
  for (let n = 1; n <= 2; n++) {
    const res = await f.engine.sessionMemory.maybeSchedule({ session: f.session, agent: f.agent }); assert.equal(res.scheduled, true);
    const outcome = await bounded(res.promise); assert.equal(outcome.ok, false); assert.notEqual(outcome.reason, 'aborted');
    counters(f, n); assert.equal(attempts, n); assert.equal(status(f).ready, false); assertIdle(f);
  }
  const refused = await f.engine.sessionMemory.maybeSchedule({ session: f.session, agent: f.agent });
  assert.equal(refused.reason, 'max-calls-reached'); assert.equal(f.llmCalls.length, 2); counters(f, 2); noBreakerFailures(f);
}));

// ── 5. Legacy v1 disk compatibility + Settings UI disambiguation (ZH & EN) ───

await test('legacy-v1-checksum-infers-total-and-reset-cycle-preserves-it', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-sm-legacy-'));
  try {
    const store = new SessionMemoryStore(join(root, 'session-memory'));
    const sid = 'sess-legacy-v1';
    await mkdir(store.root, { recursive: true });
    const payload = {
      kind: 'compaction-weave/session-memory',
      version: 1,
      sessionId: sid,
      data: { callsUsed: 3, memory: null },
    };
    const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await writeFile(store.file(sid), `${JSON.stringify({ ...payload, checksum })}\n`, 'utf8');

    const loaded = store.read(sid);
    assert.deepEqual(loaded, { callsUsed: 3, totalCallsUsed: 3, memory: null });

    assert.equal(store.resetCycle(sid), true);
    const afterReset = store.read(sid);
    assert.deepEqual(afterReset, { callsUsed: 0, totalCallsUsed: 3, memory: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }

});

for (const language of ['zh', 'en']) {
  await test(`${language}-settings-labels-muted-editable-field-and-1-to-100-validation`, async () => {
    const uiRoot = await mkdtemp(join(TEST_BASE, `weave-sm-ui-${language}-`));
    const uiTimers = new Set();
    const uiCleanups = [];
    const pendingFetches = new Set();
    try {
      const cfgFile = join(uiRoot, 'summary-config.json');
      let mod;
      let Section;
      let dictionaries;
      let stateIndex = 0;
      let effectIndex = 0;
      const states = [];
      const effects = [];
      const requests = [];

      const React = {
        createElement: (type, props, ...children) => ({
          type,
          props: props ?? {},
          children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
        }),
        useState: (initial) => {
          const i = stateIndex++;
          if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
          return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v; }];
        },
        useEffect: (cb, deps) => {
          const i = effectIndex++;
          if (!effects[i] || (deps && deps.length > 0)) effects[i] = { callback: cb, pending: true };
        },
      };

      const sandbox = {
        window: {
          __ModuleLoader__: {
            load: (decl) => {
              mod = decl.factory((name) => {
                assert.equal(name, 'react');
                return React;
              });
            },
          },
        },
        console,
        AbortController,
        setTimeout(fn, ms, ...args) { const timer = setTimeout(() => { uiTimers.delete(timer); fn(...args); }, ms); uiTimers.add(timer); return timer; },
        clearTimeout(timer) { uiTimers.delete(timer); clearTimeout(timer); },
        setInterval: () => { throw new Error('no setInterval'); },
        clearInterval: () => {},
        fetch: (url, opts) => {
          assert.equal(url, '/plugins/dsh-compaction-weave/rpc');
          const payload = JSON.parse(opts.body);
          requests.push(payload);
          const task = (async () => {
            const value = payload.method === 'models'
              ? { providers: [{ provider: 'p', name: 'P', models: [{ id: 'm' }] }] }
              : await handleSummaryConfigRpc(payload, cfgFile);
            return { status: 200, text: async () => JSON.stringify({ ok: true, value }) };
          })();
          pendingFetches.add(task);
          task.then(() => pendingFetches.delete(task), () => pendingFetches.delete(task));
          return task;
        },
      };

      vm.runInNewContext(clientSource, sandbox);
      mod.apply({
        slots: {
          inject: (_n, cb) => cb(),
          register: (desc, comp) => { if (desc.name === 'settings.section') Section = comp; return () => {}; },
        },
        effect: (cb) => cb(),
        locale: {
          register: (_ns, vals) => { dictionaries = vals; return () => {}; },
          bind: () => (k) => dictionaries[language][k],
        },
      });

      const render = () => {
        stateIndex = 0;
        effectIndex = 0;
        const tree = Section();
        for (const s of effects) {
          if (s?.pending) { s.pending = false; const cleanup = s.callback(); if (typeof cleanup === 'function') uiCleanups.push(cleanup); }
        }
        return tree;
      };
      const settle = async () => {
        for (let i = 0; i < 4; i += 1) {
          if (pendingFetches.size > 0) await Promise.all([...pendingFetches]);
          await new Promise((r) => setImmediate(r));
          render();
        }
        return render();
      };
      render();
      const tree = await settle();

      const find = (node, pred) => {
        if (!node || typeof node !== 'object') return null;
        if (pred(node)) return node;
        for (const ch of node.children ?? []) {
          const hit = find(ch, pred);
          if (hit) return hit;
        }
        return null;
      };
      const textOf = (node) => {
        if (typeof node === 'string' || typeof node === 'number') return String(node);
        if (!node || typeof node !== 'object') return '';
        return (node.children ?? []).map(textOf).join(' ');
      };

      assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort());
      const expectedLabels = language === 'zh'
        ? ['非后台定时压缩', '回合间隙后台预生成摘要', '单轮压缩前后台预热上限（1–100）']
        : ['Not scheduled in the background', 'Pre-generate summaries in background between turns', 'Background memory pre-warm limit per cycle (1–100)'];
      assert.ok(dictionaries[language].idleCompactionHint.startsWith(expectedLabels[0]));
      assert.equal(dictionaries[language].sessionMemoryEnabledToggle, expectedLabels[1]);
      assert.equal(dictionaries[language].sessionMemoryMaxCalls, expectedLabels[2]);
      const pageText = textOf(tree);
      if (language === 'zh') {
        assert.match(pageText, /非后台定时压缩/);
        assert.match(pageText, /回合间隙后台预生成摘要/);
        assert.match(pageText, /单轮压缩前后台预热上限（1–100）/);
        assert.match(pageText, /每次成功压缩后自动清零重算/);
      } else {
        assert.match(pageText, /Not scheduled in the background/);
        assert.match(pageText, /Pre-generate summaries in background between turns/);
        assert.match(pageText, /Background memory pre-warm limit per cycle \(1–100\)/);
        assert.match(pageText, /automatically resets after each successful compaction commit/);
      }

      // Disabled toggle visually mutes max-calls wrapper (opacity: 0.65) while keeping input editable
      const maxCallsWrapperOff = find(
        tree,
        (n) => n.type === 'div' && find(n, (c) => c.props?.id === 'weave-session-memory-max-calls') && !find(n, (c) => c.props?.id === 'weave-session-memory-enabled'),
      );
      assert.equal(maxCallsWrapperOff?.props?.style?.opacity, 0.65);
      const maxCallsInputOff = find(tree, (n) => n.props?.id === 'weave-session-memory-max-calls');
      assert.ok(!maxCallsInputOff.props.disabled, 'max-calls input must remain editable when disabled');

      // Toggle on -> opacity returns to unmuted (undefined)
      const checkbox = find(tree, (n) => n.props?.id === 'weave-session-memory-enabled');
      assert.equal(checkbox.props.checked, false);
      maxCallsInputOff.props.onChange({ target: { value: '9' } });
      assert.equal(find(render(), n => n.props?.id === 'weave-session-memory-max-calls').props.value, '9');
      checkbox.props.onChange({ target: { checked: true } });
      const enabledTree = render();
      const maxCallsWrapperOn = find(
        enabledTree,
        (n) => n.type === 'div' && find(n, (c) => c.props?.id === 'weave-session-memory-max-calls') && !find(n, (c) => c.props?.id === 'weave-session-memory-enabled'),
      );
      assert.equal(maxCallsWrapperOn?.props?.style?.opacity, undefined);

      // Reject out-of-range/noninteger input, then persist both inclusive bounds.
      const beforeSets = requests.filter((r) => r.method === 'set').length;
      assert.equal(maxCallsInputOff.props.min, 1); assert.equal(maxCallsInputOff.props.max, 100); assert.equal(maxCallsInputOff.props.step, 1);
      for (const bad of ['', '0', '101', '1.5', '-1', 'abc']) {
        find(render(), (n) => n.props?.id === 'weave-session-memory-max-calls').props.onChange({ target: { value: bad } });
        const freshTree = render();
        const saveBtn = find(freshTree, (n) => n.type === 'button' && n.children.includes(dictionaries[language].save));
        saveBtn.props.onClick();
        const errTree = await settle();
        assert.match(textOf(errTree), language === 'zh' ? /1–100 之间的整数/ : /integer between 1 and 100/);
      }
      assert.equal(requests.filter((r) => r.method === 'set').length, beforeSets);
      for (const value of [1, 100]) {
        find(render(), n => n.props?.id === 'weave-session-memory-max-calls').props.onChange({ target: { value: String(value) } });
        const before = requests.filter(r => r.method === 'set').length;
        find(render(), n => n.type === 'button' && n.children.includes(dictionaries[language].save)).props.onClick();
        await settle();
        const sets = requests.filter(r => r.method === 'set');
        assert.equal(sets.length, before + 1); assert.equal(sets.at(-1).params.sessionMemoryMaxCallsPerSession, value);
        assert.equal((await handleSummaryConfigRpc({ method: 'get' }, cfgFile)).config.sessionMemoryMaxCallsPerSession, value);
      }
    } finally {
      try {
        for (const cleanup of uiCleanups) cleanup();
        for (const timer of uiTimers) clearTimeout(timer);
        await Promise.allSettled([...pendingFetches]);
      } finally {
        await rm(uiRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    }
  });
}

const passed = results.filter(result => result.pass).length;
const failed = results.length - passed;
console.log(JSON.stringify({ passed, failed, results }, null, 2));
if (failed > 0) process.exitCode = 1;
