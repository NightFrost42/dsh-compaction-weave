import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { resolveConfig } from '../lib/config.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { failureExplanation } from '../lib/failure-diagnostics.js';
import { detectBiliSession } from '../lib/foreign-fold.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { CompactionProgressTracker } from '../lib/progress-tracker.js';
import { buildCompactionInstruction } from '../lib/prompt.js';
import { publicResumableSummary, readResumableCompaction, writeResumableCompaction } from '../lib/state.js';

const results = [];
async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, pass: true, ms: Date.now() - started });
  } catch (error) {
    results.push({ name, pass: false, ms: Date.now() - started, error: error?.message ?? String(error), stack: error?.stack });
  }
}

const TEST_BASE = process.env.WEAVE_TEST_ROOT ?? tmpdir();
const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

const EN_HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeStructuredSummary(body = 'Continue the task cleanly.') {
  return EN_HEADINGS.map((h, idx) =>
    `${h}\n${idx === 5 ? '[filled by engine]' : idx === 8 ? body : 'Historical details archived; continuing.'}`,
  ).join('\n\n');
}

async function createBiliMigrationFixture({
  extraConfig = {},
  streamImpl,
  windowTokens = 200000,
} = {}) {
  const root = await mkdtemp(join(TEST_BASE, 'weave-issue11-mig-'));
  const sessionId = `sess-bili-${randomUUID()}`;
  const sessionDir = join(root, 'host-sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const logPath = join(sessionDir, 'session.v4.jsonl.zstd');
  writeFileSync(
    logPath,
    Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from(`{"version":4,"id":"${sessionId}"}\n`, 'utf8')]),
  );

  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const hooks = new Map();
  const llmCalls = [];
  const logs = [];

  const session = {
    id: sessionId,
    header: { version: 4, id: sessionId, createdAt: Date.now(), isSeeded: false },
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
      if (event.type === 'system/message') return event.data?.message ?? event.data;
      if (event.type === 'user/message') return event.data;
      if (event.type === 'assistant/message') return event.data?.message;
      if (event.type === 'tool/result') {
        const msg = event.data?.message ?? event.data;
        return {
          role: 'tool',
          toolCallId: msg.toolCallId ?? msg.source?.callId,
          content: msg.content,
          ...(msg.isError ? { isError: true } : {}),
        };
      }
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
        assert.ok(s >= 0 && e >= s, `invalid replace ${options.surfaceOp.startSeq}..${options.surfaceOp.endSeq}`);
        surface.nodes.splice(s, e - s + 1, event.seq);
        surface.replaceGeneration += 1;
      } else if (options.surfaceOp === 'append') {
        surface.nodes.push(event.seq);
      }
      return event;
    },
  };

  const addSystem = (text) =>
    session.append(
      'system/message',
      { message: { id: randomUUID(), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } } },
      { surfaceOp: 'append' },
    );

  const addUser = (text) =>
    session.append(
      'user/message',
      { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
      { surfaceOp: 'append' },
    );

  const addAssistant = (text) =>
    session.append(
      'assistant/message',
      { message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } } },
      { surfaceOp: 'append' },
    );

  const addBiliToolStep = ({ toolName = 'acp_retrieve', args = { ref: 'm1' }, resultText = 'bili result' } = {}) => {
    const callId = `call-bili-${randomUUID().slice(0, 8)}`;
    const argsJson = JSON.stringify(args);
    const asst = session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: {
          id: randomUUID(),
          role: 'assistant',
          source: { kind: 'model', provider: 'p', model: 'm' },
          content: [{ type: 'tool-call', id: callId, name: toolName, arguments: argsJson }],
        },
      },
      { surfaceOp: 'append' },
    );
    const tc = session.append('tool/call', { turn: 1, step: 1, callId, name: toolName, arguments: argsJson });
    const tr = session.append(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: callId,
          source: { kind: 'tool', callId },
          content: [{ type: 'text', text: resultText }],
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [tc.seq] },
    );
    return { asst, tc, tr };
  };

  const backend = {
    locate: (header) => ({ kind: 'jsonl', path: header?.id === sessionId ? logPath : join(root, 'missing.v4.jsonl') }),
  };

  const inbox = {
    nextStep: [],
    nextTurn: [],
    prepend(target, m) {
      assert.equal(target, 'next-step');
      this.nextStep.unshift(m);
    },
  };

  const agent = {
    session,
    inbox,
    options: { provider: 'p', model: 'm' },
    runMaintenance: (fn) => fn(new AbortController().signal),
    cancel() {},
  };

  const measure = (s = session) => {
    const nodes = s.surface.nodes.map((seq) => ({
      seq,
      tokens: approxTokens(blocksToText(s.deriveEventMessage(s.eventAt(seq))?.content)),
    }));
    return { nodes, totalTokens: nodes.reduce((a, b) => a + b.tokens, 0), precision: 'priced' };
  };

  const ctx = {
    on(name, fn) {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push(fn);
      return () => {};
    },
    provide() {},
    logger: {
      info: (m) => logs.push({ level: 'info', msg: String(m) }),
      warn: (m) => logs.push({ level: 'warn', msg: String(m) }),
      error: (m) => logs.push({ level: 'error', msg: String(m) }),
    },
    sessions: {
      flush: async () => {},
      get: (id) => (id === sessionId ? session : undefined),
    },
    sessionPersistence: backend,
    tokenMeter: { measure },
    llm: {
      async resolveModelInfo() {
        return { contextWindow: windowTokens };
      },
      async *stream(req) {
        llmCalls.push(req);
        yield* streamImpl(req, llmCalls.length);
      },
    },
  };

  const config = resolveConfig({
    archiveDir: join(root, 'weave', 'archive'),
    language: 'en',
    failureThreshold: 3,
    summaryRetryCount: 0,
    summaryRetryDelayMs: 0,
    observationMaskingEnabled: false,
    microcompactEnabled: false,
    proactiveEnabled: false,
    continuationEnabled: false,
    ...extraConfig,
  }).config;

  const tracker = new CompactionProgressTracker();
  const engine = new WeaveCompactionEngine(ctx, config);
  engine.progressTracker = tracker;
  engine.historyToolsAvailable = true;

  const runPreStep = async (messages = []) => {
    const handlers = hooks.get('agent/pre-step') ?? [];
    assert.equal(handlers.length, 1);
    let enteredMain = false;
    await handlers[0]({ agent, signal: new AbortController().signal, messages }, async () => {
      enteredMain = true;
      return { kind: 'enter' };
    });
    return { enteredMain };
  };

  const cleanup = async () => {
    engine.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };

  return {
    root,
    session,
    surface,
    agent,
    backend,
    engine,
    tracker,
    llmCalls,
    logs,
    addSystem,
    addUser,
    addAssistant,
    addBiliToolStep,
    runPreStep,
    cleanup,
  };
}

function seedProxyRawBiliHistory(f) {
  f.session.append('turn/start', { turn: 1 });
  f.addSystem('System instructions.');
  f.addUser('Preserve strict WAL durability.');
  f.addBiliToolStep({
    toolName: 'acp_retrieve',
    args: { ref: 'm1' },
    resultText: 'Proxy-raw bili output: ' + 'engineering log detail '.repeat(260),
  });
  f.addAssistant('Analysis note: ' + 'work summary detail '.repeat(260));
  f.addAssistant('Trailing status.');
  f.session.append('turn/end', { turn: 1 });
  const det = detectBiliSession(f.session);
  assert.equal(det.detected, true, 'seeded session must be detected as billion-context');
  assert.equal(det.variant, 'ranxianglei-proxy-raw');
}

function mountClientCard({ language = 'zh', statusValue }) {
  let mod;
  let dictionaries;
  const registeredSlots = new Map();
  let stateIndex = 0;
  let effectIndex = 0;
  const states = [];
  const effects = [];
  const pendingFetches = new Set();

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
      const prev = effects[i];
      const changed = !prev || !prev.deps || !deps || prev.deps.length !== deps.length || prev.deps.some((d, k) => !Object.is(d, deps[k]));
      if (changed) effects[i] = { cb, deps, pending: true, cleanup: prev?.cleanup };
    },
  };

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (decl) => {
          mod = decl.factory(() => React);
        },
      },
    },
    document: { visibilityState: 'visible', hidden: false, addEventListener() {}, removeEventListener() {} },
    console,
    AbortController,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => { throw new Error('no setInterval'); },
    clearInterval() {},
    fetch: () => {
      const task = Promise.resolve({
        status: 200,
        text: async () => JSON.stringify({ ok: true, value: statusValue }),
      });
      pendingFetches.add(task);
      void task.finally(() => pendingFetches.delete(task));
      return task;
    },
  };

  vm.runInNewContext(clientSource, sandbox);
  mod.apply({
    slots: {
      inject: (_n, cb) => cb(),
      register: (d, c) => { registeredSlots.set(d.name, c); return () => {}; },
    },
    effect: (cb) => cb(),
    locale: {
      register: (_ns, vals) => { dictionaries = vals; return () => {}; },
      bind: () => (k) => dictionaries[language][k],
    },
  });

  const Card = registeredSlots.get('conversation.input.dock');
  const render = () => {
    stateIndex = 0;
    effectIndex = 0;
    const tree = Card({ sessionId: 'sess-bili-ui' });
    for (const e of effects) {
      if (e && e.pending) {
        e.pending = false;
        e.cleanup?.();
        e.cleanup = e.cb();
      }
    }
    return tree;
  };
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) {
      if (pendingFetches.size > 0) await Promise.all([...pendingFetches]);
      await new Promise((r) => setImmediate(r));
      render();
    }
    return render();
  };
  const unmount = () => {
    for (const e of effects) e?.cleanup?.();
  };
  const find = (tree, pred) => {
    if (!tree || typeof tree !== 'object') return null;
    if (pred(tree)) return tree;
    for (const ch of tree.children ?? []) {
      const m = find(ch, pred);
      if (m) return m;
    }
    return null;
  };
  const textOf = (tree) => {
    if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
    if (!tree || typeof tree !== 'object') return '';
    return (tree.children ?? []).map(textOf).join(' ');
  };
  return { render, settle, unmount, find, textOf };
}

await test('1-repeated-migration-failures-across-migrateBili-and-pre-step-trip-breaker-and-stop-auto-resume', async () => {
  let failCalls = true;
  const f = await createBiliMigrationFixture({
    extraConfig: { failureThreshold: 3, summaryRetryCount: 0 },
    streamImpl: async function* () {
      if (failCalls) {
        throw Object.assign(new Error('upstream proxy 502'), { code: 'HTTP_502', status: 502 });
      }
      yield { type: 'text-delta', text: makeStructuredSummary('Preserve strict WAL durability.') };
      yield { type: 'finish', kind: 'stop' };
    },
  });
  try {
    seedProxyRawBiliHistory(f);

    // Attempt 1: initial migrateBiliSession fails -> failures = 1, lastFailureCode recorded, resumable = interrupted (canAutoResume = true)
    await assert.rejects(
      f.engine.migrateBiliSession(f.session, { agent: f.agent, backend: f.backend, sessionPersistence: f.backend }),
    );
    const st1 = f.engine.sessionState.read(f.session.id);
    assert.equal(st1.failures, 1, 'failure #1 must increment state.failures exactly once (no double counting)');
    assert.equal(st1.stopped, false);
    assert.ok(st1.lastFailureCode, 'failure #1 must record lastFailureCode');
    const res1 = readResumableCompaction(f.engine.sessionState, f.session.id);
    assert.equal(res1?.status, 'interrupted');
    assert.equal(res1?.consecutiveFailures, 1);
    assert.equal(publicResumableSummary(res1)?.canAutoResume, true);

    // Open a turn so agent/pre-step triggers auto-resume on user turns (below threshold -> allowed to enter main after pause)
    f.session.append('turn/start', { turn: 2 });

    // Attempt 2: agent/pre-step auto-resumes -> fails -> failures = 2, consecutiveFailures = 2 (still interrupted, not yet paused_failure)
    await assert.rejects(f.runPreStep([]), (e) => e?.code === 'COMPACTION_AUTOMATIC_BLOCKED');
    const st2 = f.engine.sessionState.read(f.session.id);
    assert.equal(st2.failures, 2, 'auto-resume failure #2 must increment state.failures to 2');
    assert.equal(st2.stopped, false);
    const res2 = readResumableCompaction(f.engine.sessionState, f.session.id);
    assert.equal(res2?.status, 'interrupted');
    assert.equal(res2?.consecutiveFailures, 2);
    assert.equal(publicResumableSummary(res2)?.canAutoResume, true);

    // Attempt 3: agent/pre-step auto-resumes -> fails -> reaches failureThreshold (3) -> stopped: true, paused_failure, canAutoResume: false!
    await assert.rejects(f.runPreStep([]), (e) => e?.code === 'COMPACTION_AUTOMATIC_BLOCKED');
    const st3 = f.engine.sessionState.read(f.session.id);
    assert.equal(st3.failures, 3, 'failure #3 must increment state.failures to 3');
    assert.equal(st3.stopped, true, 'failure #3 must trip circuit breaker stopped === true');
    assert.ok(st3.lastFailureCode);
    const res3 = readResumableCompaction(f.engine.sessionState, f.session.id);
    assert.equal(res3?.status, 'paused_failure', 'resumableCompaction must transition to paused_failure at failureThreshold');
    assert.equal(res3?.consecutiveFailures, 3);
    assert.equal(publicResumableSummary(res3)?.canAutoResume, false, 'paused_failure MUST set canAutoResume === false');

    // Attempt 4: subsequent agent/pre-step MUST NOT auto-resume or make ANY LLM call (zero infinite loop!)
    const callsBeforeStep4 = f.llmCalls.length;
    const step4 = await f.runPreStep([]);
    assert.equal(step4.enteredMain, true);
    assert.equal(f.llmCalls.length, callsBeforeStep4, 'paused_failure must prevent agent/pre-step from looping LLM calls');

    // Close turn 2 and verify explicit manualRetry: true resets breaker & consecutiveFailures and completes migration!
    f.session.append('turn/end', { turn: 2 });
    failCalls = false;
    const resumed = await f.engine.resumeCompactionFor(f.session, { agent: f.agent, manualRetry: true });
    assert.ok(resumed, 'explicit manualRetry must succeed once model recovers');
    const stAfter = f.engine.sessionState.read(f.session.id);
    assert.equal(stAfter.failures, 0);
    assert.equal(stAfter.stopped, false);
    assert.equal(readResumableCompaction(f.engine.sessionState, f.session.id), null);
  } finally {
    await f.cleanup();
  }
});

await test('2-repeated-recoverPending-on-stale-running-counts-crashes-and-trips-paused_failure-and-breaker', async () => {
  const f = await createBiliMigrationFixture({
    extraConfig: { failureThreshold: 3 },
    streamImpl: async function* () {
      yield { type: 'text-delta', text: makeStructuredSummary() };
      yield { type: 'finish', kind: 'stop' };
    },
  });
  try {
    seedProxyRawBiliHistory(f);
    const seqs = f.surface.nodes.slice(1);

    // Simulate 3 consecutive process crashes leaving status: 'running' on disk
    for (let crash = 1; crash <= 3; crash += 1) {
      const prior = readResumableCompaction(f.engine.sessionState, f.session.id);
      writeResumableCompaction(f.engine.sessionState, f.session.id, {
        jobId: prior?.jobId ?? 'job-crash-loop',
        trigger: 'migration',
        status: 'running',
        remainingSeqs: seqs,
        initialTotalNodes: seqs.length,
        completedNodes: 0,
        initialTotalTokens: 4000,
        completedTokens: 0,
        completedChunks: 0,
        waveCount: 0,
        batchCheckpointSeqs: [],
        consecutiveFailures: prior?.consecutiveFailures ?? 0,
        updatedAt: new Date().toISOString(),
      });

      await f.engine.recoverPending(f.session);

      const job = readResumableCompaction(f.engine.sessionState, f.session.id);
      const state = f.engine.sessionState.read(f.session.id);
      assert.equal(job?.interruptReason, 'crash');
      assert.equal(job?.consecutiveFailures, crash);
      assert.equal(job?.lastErrorCode, 'INTERRUPTED_CRASH');
      assert.equal(state.failures, crash);
      assert.equal(state.lastFailureCode, 'INTERRUPTED_CRASH');

      if (crash < 3) {
        assert.equal(job?.status, 'interrupted');
        assert.equal(state.stopped, false);
        assert.equal(publicResumableSummary(job)?.canAutoResume, true);
      } else {
        assert.equal(job?.status, 'paused_failure', '3rd stale running crash must transition to paused_failure');
        assert.equal(state.stopped, true, '3rd stale running crash must trip breaker stopped === true');
        assert.equal(publicResumableSummary(job)?.canAutoResume, false, 'paused_failure must disable canAutoResume');
      }
    }

    // Verify user-cancelled journal recovery reconciles stale running as cancelled with 0 extra penalty
    const fCancel = await createBiliMigrationFixture({
      extraConfig: { failureThreshold: 3 },
      streamImpl: async function* () {
        yield { type: 'text-delta', text: makeStructuredSummary() };
        yield { type: 'finish', kind: 'stop' };
      },
    });
    try {
      seedProxyRawBiliHistory(fCancel);
      const cid = 'weave-cancelled-job-1';
      const startEv = fCancel.session.append('compaction/start', { compactionId: cid, turn: null });
      fCancel.session.restoreCompactionSurface = () => ({ data: { reason: 'cancelled' } });
      await fCancel.engine.journal.record({
        sessionId: fCancel.session.id,
        compactionId: cid,
        phase: 'started',
        startEventSeq: startEv.seq,
        failuresBefore: 0,
        failureKind: 'cancelled',
      });
      writeResumableCompaction(fCancel.engine.sessionState, fCancel.session.id, {
        jobId: 'job-cancelled-1',
        trigger: 'migration',
        status: 'running',
        remainingSeqs: fCancel.surface.nodes.slice(1),
        initialTotalNodes: fCancel.surface.nodes.length - 1,
        completedNodes: 0,
        initialTotalTokens: 3000,
        completedTokens: 0,
        completedChunks: 0,
        waveCount: 0,
        batchCheckpointSeqs: [],
        consecutiveFailures: 0,
        updatedAt: new Date().toISOString(),
      });

      await fCancel.engine.recoverPending(fCancel.session, false, 'cancelled');
      const cancelledJob = readResumableCompaction(fCancel.engine.sessionState, fCancel.session.id);
      const cancelledState = fCancel.engine.sessionState.read(fCancel.session.id);
      assert.equal(cancelledJob?.status, 'interrupted');
      assert.equal(cancelledJob?.interruptReason, 'cancelled');
      assert.equal(cancelledState.failures, 0, 'cancelled rollback must incur 0 failure penalty');
      assert.equal(cancelledState.stopped, false);
    } finally {
      await fCancel.cleanup();
    }
  } finally {
    await f.cleanup();
  }
});

await test('3-e2e-bili-snapshot-output-triggers-SUMMARY_FOREIGN_BILI_FORMAT-retry-badge-feedback-and-proxy-warning', async () => {
  const seenRetryReasons = [];
  const capturedRepairPrompts = [];
  const f = await createBiliMigrationFixture({
    extraConfig: { failureThreshold: 3, summaryRetryCount: 1 },
    streamImpl: async function* (req, callNo) {
      const promptText = JSON.stringify(req.messages);
      capturedRepairPrompts.push(promptText);
      if (callNo === 2) {
        seenRetryReasons.push(f.tracker.snapshot(f.session.id).retryReasonCode);
      }
      // Always output legacy <bili-snapshot> format (simulating lingering billion-context proxy)
      yield {
        type: 'text-delta',
        text: '<bili-snapshot v1 blocks="1" tokens="42000" />\nOld proxy summary output.',
      };
      yield { type: 'finish', kind: 'stop' };
    },
  });

  try {
    seedProxyRawBiliHistory(f);

    let caughtError = null;
    try {
      await f.engine.migrateBiliSession(f.session, { agent: f.agent, backend: f.backend, sessionPersistence: f.backend });
    } catch (error) {
      caughtError = error;
    }

    assert.ok(caughtError, 'migration must reject when every attempt outputs <bili-snapshot>');
    assert.equal(f.llmCalls.length, 2, 'SUMMARY_FOREIGN_BILI_FORMAT must trigger corrective retry (1 + summaryRetryCount=1)');
    assert.equal(caughtError.code, 'SUMMARY_FOREIGN_BILI_FORMAT', `expected SUMMARY_FOREIGN_BILI_FORMAT, got ${caughtError.code}`);
    assert.deepEqual(
      seenRetryReasons,
      ['SUMMARY_FOREIGN_BILI_FORMAT'],
      'progressTracker must observe retryReasonCode SUMMARY_FOREIGN_BILI_FORMAT during corrective retry',
    );

    // Verify retry prompt injected dedicated anti-bili repair feedback
    assert.match(
      capturedRepairPrompts[1],
      /bili-snapshot|billion-context/i,
      'corrective retry prompt must carry anti-bili repair instructions',
    );

    // Verify failureExplanation warns about residual local bili proxy / baseUrl
    const explanation = failureExplanation(caughtError);
    assert.match(explanation, /billion-context|bili/, 'failureExplanation must identify legacy bili format');
    assert.match(explanation, /127\.0\.0\.1|localhost|baseUrl|代理/, 'failureExplanation must warn about residual proxy/baseUrl');

    // Verify breaker & failure code persisted
    const state = f.engine.sessionState.read(f.session.id);
    assert.equal(state.failures, 1);
    assert.equal(state.lastFailureCode, 'SUMMARY_FOREIGN_BILI_FORMAT');

    // Verify lib/client.js renders both ZH and EN compact badges for SUMMARY_FOREIGN_BILI_FORMAT
    for (const [language, expectedBadge] of [
      ['zh', '上次因输出旧 bili 格式（疑代理残留）重试'],
      ['en', 'Retry: legacy bili format (check proxy)'],
    ]) {
      const card = mountClientCard({
        language,
        statusValue: {
          active: true,
          runId: 'run-bili-retry',
          seq: 5,
          sessionId: 'sess-bili-ui',
          trigger: 'migration',
          phase: 'summarizing',
          elapsedMs: 1200,
          attempt: 2,
          maxAttempts: 3,
          retryReasonCode: 'SUMMARY_FOREIGN_BILI_FORMAT',
          summaryModel: 'p/m',
        },
      });
      try {
        card.render();
        const tree = await card.settle();
        const telemetry = card.find(tree, (n) => n.props?.['data-compaction-telemetry'] === 'true');
        assert.ok(telemetry, `${language}: telemetry element must render`);
        assert.equal(telemetry.props['data-retry-reason'], 'SUMMARY_FOREIGN_BILI_FORMAT');
        assert.ok(
          card.textOf(telemetry).includes(expectedBadge),
          `${language}: expected "${expectedBadge}" inside "${card.textOf(telemetry)}"`,
        );
      } finally {
        card.unmount();
      }
    }
  } finally {
    await f.cleanup();
  }
});

console.log(JSON.stringify({
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
}, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
