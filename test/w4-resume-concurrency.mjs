import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { WeaveCompactionEngine } from '../lib/engine.js';
import { resolveConfig } from '../lib/config.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { buildCompactionInstruction } from '../lib/prompt.js';
import {
  readResumableCompaction,
  writeResumableCompaction,
  publicResumableSummary,
} from '../lib/state.js';
import { freezeContinuation, readPendingContinuation } from '../lib/continuation-pending.js';
import { createSessionBackup, summarizeBackups } from '../lib/session-backup.js';
import { apply as applyRootPlugin, SUMMARY_RPC_PATH } from '../lib/index.js';
import { apply as applyCompactCommand } from '../lib/command-compact.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message, stack: error.stack });
  }
}

const HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeValidSummary(note = 'Preserve strict integer cents.') {
  return HEADINGS.map((h, i) => `${h}\n${i === 5 ? '[filled by engine]' : note}`).join('\n\n');
}

function makeValidContinuation(note = 'Preserve strict integer cents.') {
  return [
    `## Goal\n${note}`,
    '## State\nEarlier turns archived cleanly.',
    '## Next\nContinue remaining implementation.',
    '## Uncertain\nNo unresolved conflicts.',
  ].join('\n\n');
}

function makeFakeSession(id, initialEvents = []) {
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };

  function applySurface(ev, surfaceOp) {
    if (!surfaceOp) return;
    if (surfaceOp === 'append' || surfaceOp.op === 'append') {
      surface.nodes.push(ev.seq);
    } else if (surfaceOp.op === 'replace') {
      const sIdx = surface.nodes.indexOf(surfaceOp.startSeq);
      const eIdx = surface.nodes.indexOf(surfaceOp.endSeq);
      if (sIdx < 0 || eIdx < sIdx) {
        throw new Error(`not found in surface: ${surfaceOp.startSeq}-${surfaceOp.endSeq}`);
      }
      surface.nodes.splice(sIdx, eIdx - sIdx + 1, ev.seq);
      surface.replaceGeneration += 1;
    }
  }

  const session = {
    id,
    surface,
    get seq() {
      return events.length;
    },
    eventAt(seq) {
      return events[seq];
    },
    snapshotEvents() {
      return [...events];
    },
    deriveEventMessage(ev) {
      if (!ev) return undefined;
      if (ev.type === 'user/message') return ev.data;
      if (ev.type === 'system/message' || ev.type === 'assistant/message' || ev.type === 'tool/result') {
        return ev.data?.message;
      }
      return undefined;
    },
    toolHistory() {
      return [];
    },
    requestHeader() {
      return this._header;
    },
    _header: {
      config: { provider: 'p', model: 'm', maxTokens: 4096, reasoningEffort: 'high' },
      tools: [],
    },
    append(type, data, opts = {}) {
      const ev = { seq: events.length, time: Date.now(), type, data, ...opts };
      events.push(ev);
      applySurface(ev, opts.surfaceOp);
      return ev;
    },
  };
  for (const item of initialEvents) {
    session.append(item.type, item.data, item.opts);
  }
  return session;
}

function addSystem(session, text = 'System prompt.') {
  return session.append(
    'system/message',
    { message: { id: randomUUID(), role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] } },
    { surfaceOp: 'append' },
  );
}

function addUser(session, text) {
  return session.append(
    'user/message',
    { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
    { surfaceOp: 'append' },
  );
}

function addAssistant(session, text, { provider = 'p', model = 'm' } = {}) {
  return session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider, model }, content: [{ type: 'text', text }] },
    },
    { surfaceOp: 'append' },
  );
}

function addToolPair(session, name, outputText) {
  const callId = `call-${randomUUID().slice(0, 8)}`;
  const asst = session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: {
        id: randomUUID(),
        role: 'assistant',
        source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'tool-call', callId, toolName: name, args: {} }],
      },
    },
    { surfaceOp: 'append' },
  );
  const tc = session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' });
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
        content: [{ type: 'text', text: outputText }],
      },
    },
    { surfaceOp: 'append', sourceEventSeqs: [tc.seq] },
  );
  return { asst, tc, tr };
}

async function createFixture({
  config = {},
  windowTokens = 200000,
  streamHandler = null,
  headerConfig = null,
  groups = 6,
  groupSize = 55000,
  openTurn = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'weave-w4-'));
  const sessionId = `w4-${randomUUID().slice(0, 8)}`;
  const session = makeFakeSession(sessionId);
  if (headerConfig) {
    session._header = { config: { provider: 'p', model: 'm', maxTokens: 4096, ...headerConfig }, tools: [] };
  }

  addSystem(session, 'Stable system context.');
  if (openTurn) session.append('turn/start', { turn: 1 });
  for (let i = 0; i < groups; i += 1) {
    addUser(session, `Task step ${i}: Preserve strict integer cents.`);
    addAssistant(session, `Chunk ${i} payload: ` + 'x'.repeat(groupSize));
  }
  addUser(session, 'Continue working on the final tail.');

  const listeners = new Map();
  const calls = [];
  const flushes = [];
  const cancelRecords = [];
  const inboxQueue = [];

  const ctx = {
    provide() {},
    get() {
      return undefined;
    },
    on(eventName, fn) {
      if (!listeners.has(eventName)) listeners.set(eventName, []);
      listeners.get(eventName).push(fn);
    },
    logger: { info() {}, warn() {}, error() {} },
    sessions: {
      get: (id) => (id === session.id ? session : undefined),
      async flush(s) {
        flushes.push(s.id);
        return true;
      },
    },
    tokenMeter: {
      estimateMessage: (m) => approxTokens(blocksToText(m?.content)),
      measure(s) {
        const nodes = s.surface.nodes.map((seq) => {
          const msg = s.deriveEventMessage(s.eventAt(seq));
          return { seq, tokens: approxTokens(blocksToText(msg?.content)) };
        });
        return { nodes, totalTokens: nodes.reduce((sum, n) => sum + n.tokens, 0) };
      },
    },
    llm: {
      async resolveModelInfo() {
        return { contextWindow: windowTokens, defaultMaxTokens: 8192 };
      },
      async *stream(opts) {
        const idx = calls.length;
        calls.push({
          idx,
          provider: opts.provider,
          model: opts.model,
          reasoningEffort: opts.reasoningEffort,
          messages: opts.messages,
          signal: opts.signal,
        });
        if (streamHandler) {
          yield* streamHandler(opts, idx, calls);
          return;
        }
        yield { type: 'text-delta', text: makeValidSummary() };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  };

  const resolved = resolveConfig({
    archiveDir: join(root, 'archive'),
    language: 'en',
    summaryRetryCount: 0,
    summaryRetryDelayMs: 10,
    ...config,
  }).config;

  const engine = new WeaveCompactionEngine(ctx, resolved);
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
    cancel(reason, opts) {
      cancelRecords.push({ reason, opts });
    },
    async runMaintenance(fn) {
      return fn(new AbortController().signal);
    },
  };

  return {
    root,
    session,
    engine,
    ctx,
    agent,
    calls,
    flushes,
    listeners,
    cancelRecords,
    inboxQueue,
    async dispose() {
      engine.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function createRpcHarness(root, engine, session) {
  const registeredRoutes = [];
  const providedServices = new Map();
  const rootListeners = new Map();
  const sessionLogPath = join(root, 'host-sessions', `${session.id}.v4.jsonl`);

  const rootCtx = {
    logger: { info() {}, warn() {}, error() {} },
    on(name, fn) {
      if (!rootListeners.has(name)) rootListeners.set(name, []);
      rootListeners.get(name).push(fn);
    },
    provide(name, svc) {
      providedServices.set(name, svc);
    },
    get(name) {
      if (name === 'sessions') return { get: (id) => (id === session.id ? session : undefined), flush: async () => true };
      if (name === 'sessionPersistence') {
        return {
          locate: () => ({ kind: 'jsonl', path: sessionLogPath }),
          findLog: async () => ({ currentPath: sessionLogPath }),
          tracker: { writers: new Map() },
        };
      }
      return providedServices.get(name);
    },
    inject(deps, cb) {
      if (deps.includes('webServer')) {
        cb({
          effect: (fn) => fn(),
          webServer: {
            register(route) {
              registeredRoutes.push(route);
            },
          },
        });
      }
    },
  };

  applyRootPlugin(rootCtx, {
    summaryConfigPath: join(root, 'summary-config.json'),
    engine: { archiveDir: join(root, 'archive') },
    logPath: join(root, 'gate.jsonl'),
  });

  const runtime = providedServices.get('compactionWeaveRuntime');
  assert.ok(runtime, 'compactionWeaveRuntime must be provided');
  engine.progressTracker = runtime.progressTracker;
  engine.backupStore = runtime.backupStore;
  runtime.registerEngine(engine);

  const route = registeredRoutes.find((r) => r.path === SUMMARY_RPC_PATH);
  assert.ok(route, 'single RPC route must be registered');

  async function rpc(method, params = {}) {
    const body = Buffer.from(JSON.stringify({ method, params }), 'utf8');
    const req = new EventEmitter();
    req.method = 'POST';
    req.headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' };
    let statusCode = 200;
    let payload = '';
    const headers = new Map();
    const res = {
      get statusCode() {
        return statusCode;
      },
      set statusCode(code) {
        statusCode = code;
      },
      setHeader(k, v) {
        headers.set(String(k).toLowerCase(), v);
      },
      writeHead(code) {
        statusCode = code;
      },
      end(chunk) {
        if (chunk) payload += String(chunk);
      },
    };
    const done = route.handler(req, res);
    req.emit('data', body);
    req.emit('end');
    await done;
    const parsed = JSON.parse(payload);
    return { statusCode, ok: parsed.ok, body: parsed.value, error: parsed.error };
  }

  return { rpc, runtime, sessionLogPath };
}

// ── 1. Interrupted manual /compact -> auto-resumes in agent/pre-step (even with auto: false)
await test('w4-01-interrupted-manual-auto-resumes-in-pre-step-with-auto-false', async () => {
  let failOnce = true;
  const f = await createFixture({
    config: { auto: false, summaryConcurrency: 1, summaryRetryCount: 0 },
    groups: 5,
    groupSize: 55000,
    streamHandler: async function* (_opts, idx) {
      if (idx === 1 && failOnce) {
        failOnce = false;
        throw Object.assign(new Error('transient upstream drop'), { code: 'SUMMARY_TIMEOUT' });
      }
      yield { type: 'text-delta', text: makeValidSummary() };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  try {
    await assert.rejects(() => f.engine.compactNow(f.agent, new AbortController().signal));
    assert.equal(f.session.surface.replaceGeneration, 1, 'chunk 0 must remain committed');

    const saved = readResumableCompaction(f.engine.sessionState, f.session.id);
    assert.ok(saved, 'resumableCompaction must be persisted after mid-batch failure');
    assert.equal(saved.status, 'interrupted');
    assert.equal(saved.interruptReason, 'timeout');
    assert.equal(saved.completedChunks, 1);
    assert.equal(publicResumableSummary(saved).canAutoResume, true);

    // Spy on proactive.consume and _compactBeforeResume to verify both are skipped on auto-resume step
    let proactiveCalled = false;
    let idleCalled = false;
    f.engine.proactive.consume = async () => {
      proactiveCalled = true;
      return null;
    };
    f.engine._compactBeforeResume = async () => {
      idleCalled = true;
      return null;
    };

    // Simulate next user turn starting: turn/start is open, new message is in pre-step payload
    f.session.append('turn/start', { turn: 2 });
    const newUserMsg = { id: 'new-msg-1', role: 'user', content: [{ type: 'text', text: 'Next user turn question' }] };
    const preStep = f.listeners.get('agent/pre-step')[0];
    let nextCalled = false;
    await preStep({ agent: f.agent, signal: new AbortController().signal, messages: [newUserMsg] }, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true, 'pre-step must proceed to model request after auto-resuming');
    assert.equal(proactiveCalled, false, 'proactive must be skipped on resumable step');
    assert.equal(idleCalled, false, 'idle resume must be skipped on resumable step');
    assert.equal(readResumableCompaction(f.engine.sessionState, f.session.id), null, 'resumable job must clear on completion');
    assert.ok(f.session.surface.replaceGeneration >= 2, 'remaining chunks must commit during pre-step auto-resume');
    assert.equal(f.inboxQueue.length, 0, 'claimed input must not be requeued on success');
  } finally {
    await f.dispose();
  }
});

// ── 2. Interrupted pressure -> UI resume-compaction RPC (openTurn === null, NO disk observation mask)
await test('w4-02-interrupted-pressure-resumes-via-ui-rpc-idle-no-disk-mask', async () => {
  let failChunk1 = true;
  const f = await createFixture({
    openTurn: true,
    windowTokens: 120000,
    config: { auto: true, thresholdRatio: 0.5, headroomTokens: 4000, summaryConcurrency: 1, summaryRetryCount: 0 },
    groups: 5,
    groupSize: 55000,
    streamHandler: async function* (opts, idx) {
      if (idx === 1 && failChunk1) {
        failChunk1 = false;
        throw Object.assign(new Error('simulated mid-pressure timeout'), { code: 'SUMMARY_TIMEOUT' });
      }
      const sysText = JSON.stringify(opts.messages?.[0] ?? '');
      const text = sysText.includes('## Goal') ? makeValidContinuation() : makeValidSummary();
      yield { type: 'text-delta', text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  try {
    // Also append a large tool pair so Stage 1 masking WOULD trigger if not guarded on idle/resume
    addToolPair(f.session, 'read_file', 'LARGE_TOOL_OUTPUT '.repeat(800));

    await assert.rejects(() => f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal));
    assert.ok(f.session.surface.replaceGeneration >= 1);

    // Close the turn so session is now idle (openTurn === null)
    f.session.append('turn/end', { turn: 1 });
    const saved = readResumableCompaction(f.engine.sessionState, f.session.id);
    assert.ok(saved, 'pressure interruption must persist resumableCompaction');
    assert.equal(saved.status, 'interrupted');

    const harness = createRpcHarness(f.root, f.engine, f.session);
    const st1 = await harness.rpc('status', { sessionId: f.session.id });
    assert.equal(st1.statusCode, 200);
    assert.equal(st1.body.resumable?.status, 'interrupted');
    assert.equal(st1.body.resumable?.canAutoResume, true);

    const eventsBeforeResume = f.session.snapshotEvents().length;
    const resumed = await harness.rpc('resume-compaction', { sessionId: f.session.id });
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.body.accepted, true);
    assert.equal(resumed.body.alreadyRunning, false);

    // Wait until background asyncRollingWave finishes
    for (let i = 0; i < 100 && harness.runtime.progressTracker.hasActiveRun(f.session.id); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }

    const st2 = await harness.rpc('status', { sessionId: f.session.id });
    assert.equal(st2.body.active, false);
    assert.equal(st2.body.resumable, null, 'resumable must be null after RPC resume completes');

    const newEvents = f.session.snapshotEvents().slice(eventsBeforeResume);
    assert.equal(
      newEvents.some((ev) => ev.type === 'tool/result' || ev.type === 'compaction/prune'),
      false,
      'idle RPC resume with openTurn === null must NEVER write observation mask or tool/result events',
    );
  } finally {
    await f.dispose();
  }
});

// ── 3. Active cancel-compaction RPC stops in-flight compaction without rolling back committed chunk
await test('w4-03-active-cancel-compaction-rpc-pauses-without-rollback', async () => {
  let resolveChunk1Started;
  const chunk1Started = new Promise((r) => {
    resolveChunk1Started = r;
  });

  const f = await createFixture({
    config: { summaryConcurrency: 1, summaryRetryCount: 0 },
    groups: 5,
    groupSize: 55000,
    streamHandler: async function* (opts, idx) {
      if (idx === 1) {
        resolveChunk1Started();
        await new Promise((resolve, reject) => {
          if (opts.signal?.aborted) {
            reject(opts.signal.reason ?? Object.assign(new Error('aborted'), { code: 'ABORTED' }));
            return;
          }
          opts.signal?.addEventListener(
            'abort',
            () => reject(opts.signal.reason ?? Object.assign(new Error('aborted'), { code: 'ABORTED' })),
            { once: true },
          );
        });
      }
      yield { type: 'text-delta', text: makeValidSummary() };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  try {
    const harness = createRpcHarness(f.root, f.engine, f.session);
    const outerAbort = new AbortController();
    const compactPromise = f.engine.compactNow(f.agent, outerAbort.signal);
    compactPromise.catch(() => {});
    try {
      await chunk1Started;

      // Duplicate resume while running must return alreadyRunning: true
      const dup = await harness.rpc('resume-compaction', { sessionId: f.session.id });
      assert.equal(dup.ok, true);
      assert.equal(dup.body.accepted, true);
      assert.equal(dup.body.alreadyRunning, true);

      const cancelRes = await harness.rpc('cancel-compaction', { sessionId: f.session.id });
      assert.equal(cancelRes.ok, true);
      assert.equal(cancelRes.body.cancelled, true);
      assert.ok(cancelRes.body.runId);

      await assert.rejects(() => compactPromise);
    } finally {
      outerAbort.abort();
    }
    assert.equal(f.session.surface.replaceGeneration, 1, 'already-committed chunk 0 must NOT be rolled back');

    const saved = readResumableCompaction(f.engine.sessionState, f.session.id);
    assert.ok(saved, 'cancelled run must persist resumableCompaction');
    assert.equal(saved.status, 'interrupted');
    assert.equal(saved.interruptReason, 'cancelled');
    assert.equal(saved.completedChunks, 1);

    // Resume completes remaining chunks cleanly
    const finished = await f.engine.resumeCompactionFor(f.session, { agent: f.agent, manualRetry: true });
    assert.ok(finished);
    assert.equal(readResumableCompaction(f.engine.sessionState, f.session.id), null);
    assert.ok(f.session.surface.replaceGeneration >= 2);
  } finally {
    await f.dispose();
  }
});

// ── 4. discard-resume clears BOTH resumableCompaction & continuationPending while keeping originalBackupId intact
await test('w4-04-discard-resume-clears-both-and-preserves-original-backup', async () => {
  const f = await createFixture({ groups: 3, groupSize: 10000 });
  try {
    const harness = createRpcHarness(f.root, f.engine, f.session);
    await mkdir(join(f.root, 'host-sessions'), { recursive: true });
    await writeFile(harness.sessionLogPath, '{"header":true}\n', 'utf8');

    const backup = await createSessionBackup(harness.runtime.backupStore, {
      session: f.session,
      logPath: harness.sessionLogPath,
      reason: 'bili-migration',
    });
    assert.equal(backup.ok, true);
    const originalBackupId = summarizeBackups(harness.runtime.backupStore, f.session.id).originalBackupId;
    assert.equal(originalBackupId, backup.backupId);

    const targetSeqs = f.session.surface.nodes.slice(1, -1);
    freezeContinuation(f.engine.sessionState, f.session, targetSeqs, 10000);
    writeResumableCompaction(f.engine.sessionState, f.session.id, {
      jobId: 'job-discard-1',
      trigger: 'migration',
      status: 'interrupted',
      interruptReason: 'cancelled',
      remainingSeqs: targetSeqs,
      remainingSourceSha256: f.engine._sourceHashForSeqs(f.session, targetSeqs),
      initialTotalNodes: targetSeqs.length,
      completedNodes: 0,
      initialTotalTokens: 5000,
      completedTokens: 0,
      completedChunks: 0,
      waveCount: 0,
      batchCheckpointSeqs: [],
      originalBackupId,
      consecutiveFailures: 0,
    });
    assert.ok(readPendingContinuation(f.engine.sessionState, f.session));
    assert.ok(readResumableCompaction(f.engine.sessionState, f.session.id));

    // Missing confirmDiscard must be rejected
    const denied = await harness.rpc('discard-resume', { sessionId: f.session.id });
    assert.equal(denied.ok, false);
    assert.equal(denied.error?.code, 'CONFIRMATION_REQUIRED');

    // Confirmed discard clears BOTH while preserving original backup on disk
    const cleared = await harness.rpc('discard-resume', { sessionId: f.session.id, confirmDiscard: true });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.body.discarded, true);
    assert.equal(cleared.body.clearedContinuation, true);
    assert.equal(readResumableCompaction(f.engine.sessionState, f.session.id), null);
    assert.equal(readPendingContinuation(f.engine.sessionState, f.session), null);
    assert.equal(summarizeBackups(harness.runtime.backupStore, f.session.id).originalBackupId, originalBackupId);
    assert.equal(existsSync(backup.backupPath), true, 'original backup file must remain untouched on disk');
  } finally {
    await f.dispose();
  }
});

// ── 5. paused_budget does NOT auto-resume on agent/pre-step; resumes only on explicit /compact or RPC
await test('w4-05-paused-budget-skips-pre-step-auto-resume-and-resumes-on-explicit-manual', async () => {
  const f = await createFixture({ config: { auto: false, summaryConcurrency: 1 }, groups: 3, groupSize: 20000 });
  try {
    const seqs = f.session.surface.nodes.slice(1, -1);
    writeResumableCompaction(f.engine.sessionState, f.session.id, {
      jobId: 'job-budget-1',
      trigger: 'manual',
      status: 'paused_budget',
      interruptReason: 'budget_exhausted',
      remainingSeqs: seqs,
      remainingSourceSha256: f.engine._sourceHashForSeqs(f.session, seqs),
      initialTotalNodes: seqs.length + 2,
      completedNodes: 2,
      initialTotalTokens: 20000,
      completedTokens: 8000,
      completedChunks: 1,
      waveCount: 0,
      batchCheckpointSeqs: [],
      consecutiveFailures: 0,
    });
    assert.equal(publicResumableSummary(readResumableCompaction(f.engine.sessionState, f.session.id)).canAutoResume, false);

    // Pre-step must NOT auto-resume paused_budget and must NOT charge any LLM calls
    f.session.append('turn/start', { turn: 2 });
    let nextCalled = false;
    await f.listeners.get('agent/pre-step')[0](
      { agent: f.agent, signal: new AbortController().signal, messages: [] },
      () => {
        nextCalled = true;
      },
    );
    assert.equal(nextCalled, true);
    assert.equal(f.calls.length, 0, 'paused_budget must never trigger hidden LLM calls on pre-step');
    assert.equal(readResumableCompaction(f.engine.sessionState, f.session.id)?.status, 'paused_budget');

    // Close turn and invoke explicit manual /compact -> resumes & completes
    f.session.append('turn/end', { turn: 2 });
    const res = await f.engine.compactNow(f.agent, new AbortController().signal);
    assert.ok(res);
    assert.ok(f.calls.length >= 1);
    assert.equal(readResumableCompaction(f.engine.sessionState, f.session.id), null);
  } finally {
    await f.dispose();
  }
});

// ── 6. paused_failure stops blocking chat after failureThreshold; recovers cleanly on manual retry
await test('w4-06-paused-failure-stops-blocking-chat-and-recovers-on-manual-resume', async () => {
  let broken = true;
  const f = await createFixture({
    config: { auto: false, failureThreshold: 2, summaryConcurrency: 1, summaryRetryCount: 0 },
    groups: 4,
    groupSize: 55000,
    streamHandler: async function* (_opts, idx) {
      if (broken && idx >= 1) {
        throw new Error('simulated model outage');
      }
      yield { type: 'text-delta', text: makeValidSummary() };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  try {
    // 1st run: chunk 0 commits, chunk 1 fails -> consecutiveFailures = 1, status = 'interrupted'
    await assert.rejects(() => f.engine.compactNow(f.agent, new AbortController().signal));
    const after1 = readResumableCompaction(f.engine.sessionState, f.session.id);
    assert.equal(after1?.status, 'interrupted');
    assert.equal(after1?.consecutiveFailures, 1);

    // 2nd run (auto-resume attempt via pre-step): fails again -> reaches failureThreshold=2 -> paused_failure!
    f.session.append('turn/start', { turn: 2 });
    await assert.rejects(() =>
      f.listeners.get('agent/pre-step')[0](
        { agent: f.agent, signal: new AbortController().signal, messages: [] },
        () => {},
      ),
    );
    const after2 = readResumableCompaction(f.engine.sessionState, f.session.id);
    assert.equal(after2?.status, 'paused_failure');
    assert.equal(after2?.consecutiveFailures, 2);
    assert.equal(publicResumableSummary(after2).canAutoResume, false);

    // 3rd turn: pre-step must NOT block chat or send LLM calls while paused_failure!
    const callsBefore3 = f.calls.length;
    let nextCalled = false;
    await f.listeners.get('agent/pre-step')[0](
      { agent: f.agent, signal: new AbortController().signal, messages: [] },
      () => {
        nextCalled = true;
      },
    );
    assert.equal(nextCalled, true, 'paused_failure must allow normal chat to proceed unblocked');
    assert.equal(f.calls.length, callsBefore3, 'paused_failure must not issue automatic retries');

    // User fixes model -> explicit manual resume resets consecutiveFailures & breaker and succeeds
    f.session.append('turn/end', { turn: 2 });
    broken = false;
    const resumed = await f.engine.resumeCompactionFor(f.session, { agent: f.agent, manualRetry: true });
    assert.ok(resumed);
    assert.equal(readResumableCompaction(f.engine.sessionState, f.session.id), null);
    assert.equal(f.engine.sessionState.read(f.session.id).stopped, false);
  } finally {
    await f.dispose();
  }
});

// ── 7. Idempotent committed-prefix advancement (crash between chunk commit & state update) + drift safety
await test('w4-07-idempotent-committed-prefix-advancement-and-drift-invalidation', async () => {
  const f = await createFixture({ config: { summaryConcurrency: 1 }, groups: 4, groupSize: 20000 });
  try {
    const allRange = f.session.surface.nodes.slice(1, -1);
    const chunk0End = allRange[3]; // first 2 user/assistant pairs
    const preCommitSeqs = [...allRange];

    // Commit chunk 0 directly (places a native weave- compact-checkpoint before chunk 1 seqs)
    const c0 = await f.engine._compactRegionCore(preCommitSeqs[0], chunk0End, f.agent, new AbortController().signal, {
      manual: true,
      policy: f.engine.config,
    });
    assert.ok(c0?.compactionId?.startsWith('weave-'));
    const callsAfterChunk0 = f.calls.length;

    // Simulate crash between chunk 0 commit and resumableCompaction state update:
    // remainingSeqs STILL contains chunk 0's already-replaced seqs followed by chunk 1's live seqs.
    writeResumableCompaction(f.engine.sessionState, f.session.id, {
      jobId: 'job-idempotent-prefix',
      trigger: 'manual',
      status: 'interrupted',
      interruptReason: 'crash',
      remainingSeqs: preCommitSeqs,
      remainingSourceSha256: '0'.repeat(64), // stale pre-commit hash for full span
      initialTotalNodes: preCommitSeqs.length,
      completedNodes: 0,
      initialTotalTokens: 30000,
      completedTokens: 0,
      completedChunks: 0,
      waveCount: 0,
      batchCheckpointSeqs: [],
      consecutiveFailures: 0,
    });

    const resumed = await f.engine.resumeCompactionFor(f.session, { agent: f.agent, manualRetry: true });
    assert.ok(resumed, 'must advance past Weave-committed prefix and resume remaining tail');
    assert.equal(f.calls.length, callsAfterChunk0 + 1, 'must only summarize remaining tail, never re-summarize chunk 0');
    assert.equal(readResumableCompaction(f.engine.sessionState, f.session.id), null);

    // Negative drift check: a non-Weave or non-contiguous history change must invalidate & clear stale resumable job
    const drifted = writeResumableCompaction(f.engine.sessionState, f.session.id, {
      jobId: 'job-drifted',
      trigger: 'manual',
      status: 'interrupted',
      interruptReason: 'crash',
      remainingSeqs: [999, f.session.surface.nodes.at(-1)],
      remainingSourceSha256: 'f'.repeat(64),
      initialTotalNodes: 2,
      completedNodes: 0,
      initialTotalTokens: 1000,
      completedTokens: 0,
      completedChunks: 0,
      waveCount: 0,
      batchCheckpointSeqs: [],
      consecutiveFailures: 0,
    });
    assert.ok(drifted);
    const driftRes = await f.engine.resumeCompactionFor(f.session, { agent: f.agent, manualRetry: true });
    assert.equal(driftRes, null, 'drifted resumable job must be invalidated rather than corrupting history');
    assert.equal(readResumableCompaction(f.engine.sessionState, f.session.id), null);
  } finally {
    await f.dispose();
  }
});

// ── 8. Multi-chunk concurrent execution: overlap, strictly ordered commits, 429 AIMD, 401 abort, effort='low'
await test('w4-08-concurrent-overlap-ordered-commit-429-aimd-401-abort-and-effort-low', async () => {
  // (a) Overlap + strictly ordered commits + reasoningEffort downgrade ('high' -> 'low')
  let inFlight = 0;
  let maxInFlight = 0;
  const delays = [5, 70, 35, 10, 10, 10]; // chunk 3 finishes fastest, chunk 1 slowest
  const fxA = await createFixture({
    config: { summaryConcurrency: 3, summaryReasoningEffort: 'low', cacheMaxCheckpoints: 10 },
    headerConfig: { reasoningEffort: 'high' },
    groups: 8,
    groupSize: 55000,
    streamHandler: async function* (_opts, idx) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, delays[idx] ?? 10));
        yield { type: 'text-delta', text: makeValidSummary() };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } finally {
        inFlight -= 1;
      }
    },
  });
  try {
    const chunkUpdates = [];
    const tokenUpdates = [];
    const origUpdateA = fxA.engine.progressTracker.update.bind(fxA.engine.progressTracker);
    fxA.engine.progressTracker.update = (sid, patch, opts) => {
      if (Number.isInteger(patch?.chunkIndex)) {
        chunkUpdates.push({ index: patch.chunkIndex, total: patch.chunkTotal ?? null, phase: patch.phase ?? null });
      }
      if (Number.isFinite(patch?.currentTokens)) {
        tokenUpdates.push(patch.currentTokens);
      }
      return origUpdateA(sid, patch, opts);
    };
    const res = await fxA.engine.compactNow(fxA.agent, new AbortController().signal);
    assert.ok(res);
    assert.ok(fxA.calls.length >= 4, `expected >= 4 chunks, got ${fxA.calls.length}`);
    assert.ok(maxInFlight >= 2, `expected parallel worker overlap (maxInFlight >= 2), got ${maxInFlight}`);
    assert.ok(
      fxA.calls.every((c) => c.reasoningEffort === 'low'),
      `all same-route summary calls must downgrade reasoningEffort high->low, got ${fxA.calls.map((c) => c.reasoningEffort)}`,
    );

    // Verify chunkIndex/chunkTotal and currentTokens advance monotonically as concurrent chunks commit
    const concurrentIndices = chunkUpdates.filter((u) => u.total !== null && u.total >= 4);
    const distinctIndices = [...new Set(concurrentIndices.map((u) => u.index))];
    assert.ok(
      distinctIndices.length >= 3 && distinctIndices.includes(2) && distinctIndices.includes(3) && distinctIndices.includes(4),
      `chunkIndex must advance monotonically (2 -> 3 -> 4...), got ${JSON.stringify(concurrentIndices)}`,
    );
    for (let i = 1; i < concurrentIndices.length; i += 1) {
      assert.ok(
        concurrentIndices[i].index >= concurrentIndices[i - 1].index,
        `chunkIndex must never regress during concurrent commits: ${JSON.stringify(concurrentIndices)}`,
      );
      assert.equal(concurrentIndices[i].total, concurrentIndices[0].total, 'chunkTotal must stay stable across concurrent wave');
    }
    assert.ok(
      tokenUpdates.length >= 2 && tokenUpdates.at(-1) < tokenUpdates[0],
      `currentTokens must refresh downward across commits, got ${JSON.stringify(tokenUpdates)}`,
    );

    // Verify strictly ascending shadowedRange commit order in session event log
    const summaryEvents = fxA.session.snapshotEvents().filter((e) => e.type === 'compaction/summary');
    assert.ok(summaryEvents.length >= 4);
    for (let i = 1; i < summaryEvents.length; i += 1) {
      assert.ok(
        summaryEvents[i].data.shadowedRange.start > summaryEvents[i - 1].data.shadowedRange.end,
        `commits must be strictly ascending: prev=${JSON.stringify(summaryEvents[i - 1].data.shadowedRange)} cur=${JSON.stringify(summaryEvents[i].data.shadowedRange)}`,
      );
    }
  } finally {
    await fxA.dispose();
  }

  // (b) HTTP 429 AIMD drop to concurrency 1 + recovery
  let threw429 = false;
  let observedRateLimited = false;
  let observedDropToOne = false;
  const fx429 = await createFixture({
    config: { summaryConcurrency: 3, summaryRetryCount: 1, summaryRetryDelayMs: 25, cacheMaxCheckpoints: 10 },
    groups: 8,
    groupSize: 55000,
    streamHandler: async function* (_opts, idx) {
      if (idx === 1 && !threw429) {
        threw429 = true;
        throw Object.assign(new Error('HTTP 429 Too Many Requests'), { status: 429, code: 'RATE_LIMIT' });
      }
      await new Promise((r) => setTimeout(r, 15));
      yield { type: 'text-delta', text: makeValidSummary() };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  try {
    const origUpdate = fx429.engine.progressTracker.update.bind(fx429.engine.progressTracker);
    fx429.engine.progressTracker.update = (sid, patch, opts) => {
      if (patch?.rateLimited === true) observedRateLimited = true;
      if (observedRateLimited && patch?.concurrency === 1) observedDropToOne = true;
      return origUpdate(sid, patch, opts);
    };
    const res = await fx429.engine.compactNow(fx429.agent, new AbortController().signal);
    assert.ok(res);
    assert.equal(threw429, true);
    assert.equal(observedRateLimited, true, '429 must mark progress tracker rateLimited=true');
    assert.equal(observedDropToOne, true, '429 AIMD must drop concurrency to 1');
  } finally {
    await fx429.dispose();
  }

  // (c) Fatal 401 auth error aborts sibling workers immediately and pauses with paused_failure
  const siblingAborted = [];
  const fx401 = await createFixture({
    config: { summaryConcurrency: 3, summaryRetryCount: 0, cacheMaxCheckpoints: 10 },
    groups: 8,
    groupSize: 55000,
    streamHandler: async function* (opts, idx) {
      if (idx === 0) {
        yield { type: 'text-delta', text: makeValidSummary() };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      if (idx === 1) {
        await new Promise((r) => setTimeout(r, 15));
        throw Object.assign(new Error('HTTP 401 Unauthorized: Invalid API key'), { status: 401, code: 'UNAUTHORIZED' });
      }
      // Sibling workers (idx >= 2): wait to observe immediate abort from pool
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          siblingAborted.push(idx);
          reject(opts.signal.reason ?? Object.assign(new Error('aborted'), { code: 'ABORTED' }));
        };
        if (opts.signal?.aborted) onAbort();
        else opts.signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  });
  try {
    await assert.rejects(() => fx401.engine.compactNow(fx401.agent, new AbortController().signal));
    assert.equal(fx401.session.surface.replaceGeneration, 1, 'chunk 0 stays committed; sibling chunks must not commit');
    assert.ok(siblingAborted.length >= 1, 'in-flight sibling workers must be aborted immediately on 401');
    const saved = readResumableCompaction(fx401.engine.sessionState, fx401.session.id);
    assert.equal(saved?.status, 'paused_failure', 'fatal 401 auth error must persist paused_failure');
  } finally {
    await fx401.dispose();
  }
});

// ── 9. P0 guards (concurrent turn cancel, post-end-seed orphan lock) + _tryHierarchicalFold resilience + CLI subcommands
await test('w4-09-p0-guards-hierarchical-fold-resilience-and-cli-subcommands', async () => {
  // (a) Cold-session bili-migrate concurrent turn guard (agent/status cancels racing turn with keepInbox: true)
  const f = await createFixture({ groups: 2, groupSize: 10000 });
  try {
    const statusHook = f.listeners.get('agent/status')[0];
    f.engine._busy.add(f.session);
    statusHook({ status: 'running', agent: f.agent });
    f.engine._busy.delete(f.session);
    assert.equal(f.cancelRecords.length, 1, 'running turn during active _busy compaction/migration must be cancelled');
    assert.equal(f.cancelRecords[0].opts?.keepInbox, true, 'must preserve inbox (keepInbox: true)');

    // (b) agent/status post-end-seed orphan lock non-deadlock:
    // Unmatched weave- compaction/start BEFORE session/end-seed must NOT deadlock turns
    f.cancelRecords.length = 0;
    f.session.append('compaction/start', { compactionId: 'weave-historic-orphan', turn: null });
    f.session.append('session/end-seed', {});
    statusHook({ status: 'running', agent: f.agent });
    assert.equal(f.cancelRecords.length, 0, 'pre-end-seed orphan compaction/start must NOT deadlock new turns');

    // Unmatched weave- compaction/start AFTER session/end-seed MUST still block new turns
    f.session.append('compaction/start', { compactionId: 'weave-live-orphan', turn: null });
    statusHook({ status: 'running', agent: f.agent });
    assert.equal(f.cancelRecords.length, 1, 'post-end-seed unmatched weave compaction/start must block new turns');
    assert.equal(f.cancelRecords[0].opts?.keepInbox, true);
  } finally {
    await f.dispose();
  }

  // (c) _tryHierarchicalFold skips wrapped SUMMARY_ALL_FAILED without aborting compaction or tripping breaker
  let foldFailuresTriggered = 0;
  const richSummary = makeValidSummary(
    'Preserve strict integer cents. ' + 'Detailed architectural checkpoint notes covering verified module boundaries. '.repeat(25),
  );
  const fxFold = await createFixture({
    config: { summaryConcurrency: 1, cacheMaxCheckpoints: 2, summaryRetryCount: 0 },
    groups: 8,
    groupSize: 55000,
    streamHandler: async function* (opts) {
      // Detect folding call: its input messages contain the inline compact checkpoint preamble
      const serialized = JSON.stringify(opts.messages);
      const isFoldCall = serialized.includes('This is an automatically generated checkpoint condensing an earlier span');
      if (isFoldCall) {
        foldFailuresTriggered += 1;
        throw new Error('simulated fold provider failure');
      }
      yield { type: 'text-delta', text: richSummary };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  });
  try {
    const res = await fxFold.engine.compactNow(fxFold.agent, new AbortController().signal);
    assert.ok(res, 'compaction must still succeed when optional hierarchical fold fails');
    assert.ok(foldFailuresTriggered >= 1, 'must have actually entered _tryHierarchicalFold and hit failure');
    assert.equal(
      fxFold.engine.sessionState.read(fxFold.session.id).failures,
      0,
      'skipped optional fold failure must NOT increment failure breaker count',
    );
  } finally {
    await fxFold.dispose();
  }

  // (d) /compact resume | cancel | discard CLI subcommands in lib/command-compact.js
  const fxCli = await createFixture({ groups: 2, groupSize: 10000 });
  try {
    let wrappedHandler = null;
    const cmdCtx = {
      commands: {
        register(def) {
          wrappedHandler = def.handler;
          return () => {};
        },
      },
      compaction: fxCli.engine,
      effect(fn) {
        return fn();
      },
      loader: {
        async import() {
          return {
            apply(hostCtx) {
              hostCtx.commands.register({
                name: 'compact',
                handler: async () => ({ kind: 'success', text: 'host' }),
              });
            },
          };
        },
      },
    };
    await applyCompactCommand(cmdCtx);
    assert.ok(wrappedHandler, 'command-compact must wrap /compact handler');

    // /compact cancel when idle
    const cancelIdle = await wrappedHandler({ rawArgs: 'cancel', agent: fxCli.agent, signal: new AbortController().signal });
    assert.equal(cancelIdle.kind, 'success');

    // /compact resume when nothing pending
    const resumeNone = await wrappedHandler({ rawArgs: 'resume', agent: fxCli.agent, signal: new AbortController().signal });
    assert.equal(resumeNone.kind, 'success');

    // /compact discard clears saved resumable job
    const targetSeqs = fxCli.session.surface.nodes.slice(1, -1);
    writeResumableCompaction(fxCli.engine.sessionState, fxCli.session.id, {
      jobId: 'job-cli-1',
      trigger: 'manual',
      status: 'interrupted',
      interruptReason: 'cancelled',
      remainingSeqs: targetSeqs,
      remainingSourceSha256: fxCli.engine._sourceHashForSeqs(fxCli.session, targetSeqs),
      initialTotalNodes: targetSeqs.length,
      completedNodes: 0,
      initialTotalTokens: 3000,
      completedTokens: 0,
      completedChunks: 0,
      waveCount: 0,
      batchCheckpointSeqs: [],
      consecutiveFailures: 0,
    });
    const discardRes = await wrappedHandler({ rawArgs: 'discard', agent: fxCli.agent, signal: new AbortController().signal });
    assert.equal(discardRes.kind, 'success');
    assert.equal(readResumableCompaction(fxCli.engine.sessionState, fxCli.session.id), null);
  } finally {
    await fxCli.dispose();
  }
});

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
console.log(JSON.stringify({ passed, failed, results }, null, 2));
if (failed > 0) process.exitCode = 1;
