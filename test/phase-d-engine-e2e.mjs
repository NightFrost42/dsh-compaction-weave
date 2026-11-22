import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { freezeContinuation, readPendingContinuation } from '../lib/continuation-pending.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { buildCompactionInstruction } from '../lib/prompt.js';

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
const MINUTE = 60_000;

const EN_HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeSummary(section9 = 'Preserve all active rules and continue the task.') {
  return EN_HEADINGS.map((h, idx) =>
    `${h}\n${idx === 5 ? '[filled by engine]' : idx === 8 ? section9 : 'Historical details archived; continuing work.'}`,
  ).join('\n\n');
}

function tokensStr(tokenCount, label = 'detail') {
  const unit = `${label} `;
  const targetChars = Math.max(4, tokenCount * 4);
  return unit.repeat(Math.ceil(targetChars / unit.length)).slice(0, targetChars);
}

async function createPhaseDFixture({
  extraConfig = {},
  windowTokens = 65536,
  defaultMaxTokens = 4096,
  summaryText = makeSummary(),
  streamImpl = null,
  baseTime = Date.now() - 45 * MINUTE,
} = {}) {
  const root = await mkdtemp(join(TEST_BASE, 'weave-phase-d-e2e-'));
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const hooks = new Map();
  const llmCalls = [];
  const logs = [];
  let flushes = 0;
  let seqClock = baseTime;

  const session = {
    id: `sess-${randomUUID()}`,
    header: {
      version: 4,
      id: 'placeholder',
      createdAt: baseTime,
      isSeeded: false,
    },
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => [...events],
    requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: defaultMaxTokens } }),
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

  const addAssistant = (text, timeOrOpts) => {
    const time = typeof timeOrOpts === 'number' ? timeOrOpts : timeOrOpts?.time;
    return session.append(
      'assistant/message',
      { message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } } },
      { surfaceOp: 'append', ...(time === undefined ? {} : { time }) },
    );
  };

  const addToolStep = ({ turn = 1, step = 1, toolName = 'read_file', args = { path: 'src/a.js' }, resultText, time }) => {
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
    const tc = session.append(
      'tool/call',
      { turn, step, callId, name: toolName, arguments: argsJson },
      { ...(time === undefined ? {} : { time: time + 1 }) },
    );
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
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [tc.seq], ...(time === undefined ? {} : { time: time + 2 }) },
    );
    return { asst, tc, tr, callId };
  };

  const inbox = {
    nextStep: [],
    nextTurn: [],
    prepend(target, message) {
      assert.equal(target, 'next-step');
      this.nextStep.unshift(message);
    },
  };

  const agent = {
    session,
    inbox,
    options: { provider: 'p', model: 'm' },
    runMaintenance: (fn) => fn(new AbortController().signal),
    cancel() {},
  };

  const measure = () => {
    const nodes = surface.nodes.map((seq) => {
      const msg = session.deriveEventMessage(session.eventAt(seq));
      return { seq, tokens: approxTokens(blocksToText(msg?.content)) };
    });
    return {
      nodes,
      totalTokens: nodes.reduce((sum, n) => sum + n.tokens, 0),
      precision: 'priced',
    };
  };

  const ctx = {
    on(event, fn) {
      if (!hooks.has(event)) hooks.set(event, []);
      hooks.get(event).push(fn);
      return () => {
        const list = hooks.get(event) ?? [];
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    provide() {},
    logger: {
      info: (m) => logs.push({ level: 'info', msg: String(m) }),
      warn: (m) => logs.push({ level: 'warn', msg: String(m) }),
      error: (m) => logs.push({ level: 'error', msg: String(m) }),
    },
    sessions: {
      flush: async () => {
        flushes += 1;
      },
      get: (id) => (id === session.id ? session : undefined),
    },
    tokenMeter: { measure: () => measure() },
    llm: {
      async resolveModelInfo() {
        return { contextWindow: windowTokens, defaultMaxTokens };
      },
      async *stream(req) {
        llmCalls.push(req);
        if (typeof streamImpl === 'function') {
          yield* streamImpl(req, llmCalls.length);
          return;
        }
        yield { type: 'text-delta', text: summaryText };
        yield { type: 'finish', kind: 'stop', usage: { inputTokens: 100, outputTokens: 80 } };
      },
    },
  };

  const config = resolveConfig({
    archiveDir: join(root, 'archive'),
    language: 'en',
    proactiveEnabled: false,
    persistedOutputEnabled: false,
    microcompactEnabled: false,
    observationMaskingEnabled: false,
    summaryRetryCount: 0,
    summaryRetryDelayMs: 0,
    headroomTokens: 4096,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    snipEnabled: true,
    snipKeepRecentTurns: 2,
    snipKeepRecentTokens: 4096,
    snipMinSavingsTokens: 1024,
    snipMaxSpansPerRescue: 4,
    ...extraConfig,
  }).config;

  const engine = new WeaveCompactionEngine(ctx, config);
  engine.historyToolsAvailable = true;

  const snipStubs = () =>
    surface.nodes
      .map((seq) => ({ seq, msg: session.deriveEventMessage(session.eventAt(seq)) }))
      .filter(({ msg }) => msg?.source?.kind === 'compact-checkpoint' && msg?.source?.snip === true);

  const runPreStep = async (messages = [], signal = new AbortController().signal) => {
    const handlers = hooks.get('agent/pre-step') ?? [];
    assert.equal(handlers.length, 1);
    let enteredMain = false;
    await handlers[0]({ agent, signal, messages }, async () => {
      enteredMain = true;
      return { kind: 'enter' };
    });
    return { enteredMain };
  };

  const runRequestError = async (
    failure = { code: 'CONTEXT_WINDOW_EXCEEDED', message: '413 prompt too long' },
    signal = new AbortController().signal,
  ) => {
    const handlers = hooks.get('agent/request-error') ?? [];
    assert.equal(handlers.length, 1);
    let fellThrough = false;
    const outcome = await handlers[0]({ agent, signal, failure }, async () => {
      fellThrough = true;
      return { kind: 'original-error' };
    });
    return { outcome, fellThrough };
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
    inbox,
    engine,
    logs,
    llmCalls,
    measure,
    addSystem,
    addUser,
    addAssistant,
    addToolStep,
    snipStubs,
    runPreStep,
    runRequestError,
    get flushes() {
      return flushes;
    },
    cleanup,
  };
}

/**
 * Populate a session with a protected system head, Turn 1 rule + big old tool loop
 * (snipable), and 2 protected recent user turns.
 * With `windowTokens=65536`, `defaultMaxTokens=4096` -> `messageBudgetTokens=61440`.
 * `thresholdTokens = floor((61440 - 4096) * 0.8) = 45875`.
 * `0.95 * messageBudgetTokens = 58368`.
 */
function seedSnipableHistory(f, { oldToolTokens = 32000, tailTurnTokens = 16000, turnOpen = true } = {}) {
  const t0 = Date.now() - 40 * MINUTE;
  f.session.append('turn/start', { turn: 1 }, { time: t0 });
  const sys = f.addSystem('Stable system instructions.', t0 + 10);
  const ruleUser = f.addUser('Keep WAL checkpointing enabled at all times.', { time: t0 + 20 });
  const half = Math.floor(oldToolTokens / 2);
  const tool1 = f.addToolStep({
    turn: 1,
    step: 1,
    toolName: 'read_file',
    args: { path: 'src/heavy-a.js' },
    resultText: `SNIP_ARCHIVE_MARKER_A_${tokensStr(half, 'heavyA')}_END_A`,
    time: t0 + 30,
  });
  const tool2 = f.addToolStep({
    turn: 1,
    step: 2,
    toolName: 'run_command',
    args: { command: 'npm test' },
    resultText: `SNIP_ARCHIVE_MARKER_B_${tokensStr(half, 'heavyB')}_END_B`,
    time: t0 + 40,
  });
  f.session.append('turn/end', { turn: 1 }, { time: t0 + 50 });

  f.session.append('turn/start', { turn: 2 }, { time: t0 + 60 });
  const recentU1 = f.addUser(`Recent user turn 1: keep SQLite strict. ${tokensStr(Math.floor(tailTurnTokens / 2), 'u1')}`, { time: t0 + 70 });
  const recentA1 = f.addAssistant(`Recent assistant reply 1. ${tokensStr(Math.floor(tailTurnTokens / 2), 'a1')}`, t0 + 80);
  f.session.append('turn/end', { turn: 2 }, { time: t0 + 90 });

  f.session.append('turn/start', { turn: 3 }, { time: t0 + 100 });
  const recentU2 = f.addUser(`Recent user turn 2: verify output schema. ${tokensStr(Math.floor(tailTurnTokens / 2), 'u2')}`, { time: t0 + 110 });
  const recentA2 = f.addAssistant(`Recent assistant reply 2. ${tokensStr(Math.floor(tailTurnTokens / 2), 'a2')}`, t0 + 120);
  if (!turnOpen) {
    f.session.append('turn/end', { turn: 3 }, { time: t0 + 130 });
  }
  return { sys, ruleUser, tool1, tool2, recentU1, recentA1, recentU2, recentA2 };
}

await test('(a) snip-never-runs-on-warm-cache-idle-resume-or-pressure-below-95pct-wall', async () => {
  // a1: Warm cache below threshold -> 0 snip calls, 0 LLM calls
  const fWarm = await createPhaseDFixture();
  try {
    seedSnipableHistory(fWarm, { oldToolTokens: 10000, tailTurnTokens: 4000, turnOpen: true });
    assert.ok(fWarm.measure().totalTokens < 45875, 'warm fixture must stay below threshold');
    let snipCalls = 0;
    const origSnip = fWarm.engine._emergencySnip.bind(fWarm.engine);
    fWarm.engine._emergencySnip = async (...args) => {
      snipCalls += 1;
      return origSnip(...args);
    };
    const { enteredMain } = await fWarm.runPreStep([]);
    assert.equal(enteredMain, true);
    assert.equal(snipCalls, 0, 'warm cache must invoke 0 _emergencySnip calls');
    assert.equal(fWarm.snipStubs().length, 0);
    assert.equal(fWarm.llmCalls.length, 0);
  } finally {
    await fWarm.cleanup();
  }

  // a2: Idle resume below hard budget -> normal idle summary runs, 0 snip calls
  const fIdle = await createPhaseDFixture({
    extraConfig: {
      auto: false,
      idleCompactionMinutes: 30,
      idleCompactionMinTokens: 4096,
      idleFullSummaryEnabled: true,
    },
  });
  try {
    const oldTime = Date.now() - 45 * MINUTE;
    fIdle.session.append('turn/start', { turn: 1 }, { time: oldTime - 1000 });
    fIdle.addSystem('System.', oldTime - 900);
    fIdle.addUser('Idle requirement: keep deterministic ids.', { time: oldTime - 800 });
    fIdle.addToolStep({ turn: 1, step: 1, resultText: tokensStr(10000, 'idletool'), time: oldTime - 700 });
    fIdle.addUser('Follow-up idle turn.', { time: oldTime - 500 });
    fIdle.addAssistant(tokensStr(4000, 'idleasst'), oldTime - 400);
    fIdle.session.append('turn/end', { turn: 1 }, { time: oldTime });

    const resumeMsg = { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Resume now.' }] };
    fIdle.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [resumeMsg] }, { time: Date.now() });
    fIdle.session.append('turn/start', { turn: 2 }, { time: Date.now() + 1 });

    let snipCalls = 0;
    const origSnip = fIdle.engine._emergencySnip.bind(fIdle.engine);
    fIdle.engine._emergencySnip = async (...args) => {
      snipCalls += 1;
      return origSnip(...args);
    };
    const { enteredMain } = await fIdle.runPreStep([resumeMsg]);
    assert.equal(enteredMain, true);
    assert.equal(snipCalls, 0, 'idle resume below hard budget must invoke 0 _emergencySnip calls');
    assert.equal(fIdle.snipStubs().length, 0);
  } finally {
    await fIdle.cleanup();
  }

  // a3: Normal pressure failure above threshold (52428) and below 95% budget wall (58368) -> NO snip!
  const fPressureMid = await createPhaseDFixture({
    extraConfig: { continuationEnabled: false },
    streamImpl: async function* () {
      throw Object.assign(new Error('upstream 500'), { code: 'HTTP_500', status: 500 });
    },
  });
  try {
    // Total ~ 28k + 2 * 14k = ~56k -> >= thresholdTokens (52428), strictly < 0.95 * 61440 (58368)
    seedSnipableHistory(fPressureMid, { oldToolTokens: 28000, tailTurnTokens: 14000, turnOpen: true });
    const total = fPressureMid.measure().totalTokens;
    assert.ok(total >= 52428 && total < Math.floor(61440 * 0.95), `expected total in [52428, 58368), got ${total}`);
    let snipCalls = 0;
    const origSnip = fPressureMid.engine._emergencySnip.bind(fPressureMid.engine);
    fPressureMid.engine._emergencySnip = async (...args) => {
      snipCalls += 1;
      return origSnip(...args);
    };
    const nodesBefore = [...fPressureMid.surface.nodes];
    await assert.rejects(
      fPressureMid.runPreStep([]),
      (err) => err?.code === 'COMPACTION_AUTOMATIC_BLOCKED' || err?.code === 'COMPACTION_CAPACITY_BLOCKED',
    );
    assert.ok(fPressureMid.llmCalls.length >= 1, 'pressure summary must have been attempted');
    assert.equal(snipCalls, 0, 'pressure failure below 95% budget wall must NOT invoke _emergencySnip');
    assert.equal(fPressureMid.snipStubs().length, 0);
    assert.deepEqual(fPressureMid.surface.nodes, nodesBefore);
  } finally {
    await fPressureMid.cleanup();
  }
});

await test('(b) snip-rescues-pre-step-pressure-wall-and-budget-wall-with-zero-llm-and-valid-archive', async () => {
  // b1: Pressure summary failure at/above messageBudgetTokens -> Site 2 emergency Snip rescues cleanly
  const fPressureWall = await createPhaseDFixture({
    extraConfig: { continuationEnabled: false },
    streamImpl: async function* () {
      throw Object.assign(new Error('upstream unavailable'), { code: 'HTTP_503', status: 503 });
    },
  });
  try {
    // ~36k old tools + ~28k recent turns = ~64k >= messageBudgetTokens (61440)
    const seeded = seedSnipableHistory(fPressureWall, { oldToolTokens: 36000, tailTurnTokens: 14000, turnOpen: true });
    assert.ok(fPressureWall.measure().totalTokens >= 61440, 'fixture must start at/above messageBudgetTokens');

    let llmCallsBeforeSnip = -1;
    let llmCallsAfterSnip = -1;
    const origSnip = fPressureWall.engine._emergencySnip.bind(fPressureWall.engine);
    fPressureWall.engine._emergencySnip = async (...args) => {
      llmCallsBeforeSnip = fPressureWall.llmCalls.length;
      const res = await origSnip(...args);
      llmCallsAfterSnip = fPressureWall.llmCalls.length;
      return res;
    };

    const { enteredMain } = await fPressureWall.runPreStep([]);
    assert.equal(enteredMain, true, 'pre-step must rescue via emergency Snip and enter main');
    assert.ok(llmCallsBeforeSnip >= 1, 'pressure summary ran before failing');
    assert.equal(llmCallsAfterSnip, llmCallsBeforeSnip, 'Snip itself MUST make 0 LLM calls');
    assert.ok(fPressureWall.measure().totalTokens < 61440, 'tokens after Snip must be strictly below messageBudgetTokens');

    const stubs = fPressureWall.snipStubs();
    assert.ok(stubs.length >= 1, 'expected at least one snip stub on surface');
    const cpId = stubs[0].msg.source.compactionId;
    assert.ok(cpId.startsWith('weave-snip-'));

    // Archive is readable and contains exact snipped tool loop content
    const archived = await fPressureWall.engine.archive.readSpan(fPressureWall.session.id, cpId);
    assert.equal(archived.ok, true);
    assert.ok(archived.entries.some((e) => e.text.includes('SNIP_ARCHIVE_MARKER_A_')));
    assert.ok(archived.entries.some((e) => e.text.includes('SNIP_ARCHIVE_MARKER_B_')));

    // Verified user rule & protected recent turns stay intact on surface
    assert.ok(fPressureWall.surface.nodes.includes(seeded.sys.seq));
    assert.ok(fPressureWall.surface.nodes.includes(seeded.ruleUser.seq));
    assert.ok(fPressureWall.surface.nodes.includes(seeded.recentU1.seq));
    assert.ok(fPressureWall.surface.nodes.includes(seeded.recentA1.seq));
    assert.ok(fPressureWall.surface.nodes.includes(seeded.recentU2.seq));
    assert.ok(fPressureWall.surface.nodes.includes(seeded.recentA2.seq));
    assert.equal(fPressureWall.surface.nodes.includes(seeded.tool1.tr.seq), false);
    assert.equal(fPressureWall.surface.nodes.includes(seeded.tool2.tr.seq), false);
    assert.ok(fPressureWall.flushes >= 1, 'Snip must flush session persistence');
  } finally {
    await fPressureWall.cleanup();
  }

  // b2: Direct Site 1 (_guardRequestBudget) rescue when compactIfNeeded returned null -> 0 total LLM calls!
  const fBudgetWall = await createPhaseDFixture();
  try {
    const seeded = seedSnipableHistory(fBudgetWall, { oldToolTokens: 36000, tailTurnTokens: 14000, turnOpen: true });
    assert.ok(fBudgetWall.measure().totalTokens >= 61440);
    fBudgetWall.engine.compactIfNeeded = async () => null;

    const { enteredMain } = await fBudgetWall.runPreStep([]);
    assert.equal(enteredMain, true);
    assert.equal(fBudgetWall.llmCalls.length, 0, 'budget-wall Snip rescue must invoke 0 LLM calls');
    assert.ok(fBudgetWall.measure().totalTokens < 61440);
    const stubs = fBudgetWall.snipStubs();
    assert.equal(stubs.length, 1);
    const archived = await fBudgetWall.engine.archive.readSpan(fBudgetWall.session.id, stubs[0].msg.source.compactionId);
    assert.equal(archived.ok, true);
    assert.ok(archived.entries.some((e) => e.text.includes('SNIP_ARCHIVE_MARKER_A_')));
    assert.ok(fBudgetWall.surface.nodes.includes(seeded.ruleUser.seq));
    assert.ok(fBudgetWall.surface.nodes.includes(seeded.recentU1.seq));
    assert.ok(fBudgetWall.surface.nodes.includes(seeded.recentU2.seq));
  } finally {
    await fBudgetWall.cleanup();
  }
});

await test('(c) snip-rescues-agent-request-error-context-overflow-and-returns-retry', async () => {
  // c1: compactIfNeeded('context-overflow') throws -> emergency Snip rescues -> { kind: 'retry' }
  const fThrow = await createPhaseDFixture({
    extraConfig: { continuationEnabled: false },
    streamImpl: async function* () {
      throw Object.assign(new Error('summary target failed 502'), { code: 'HTTP_502', status: 502 });
    },
  });
  try {
    // Even when local meter is below messageBudgetTokens, provider 413 must still be rescued by Snip!
    const seeded = seedSnipableHistory(fThrow, { oldToolTokens: 28000, tailTurnTokens: 10000, turnOpen: true });
    assert.ok(fThrow.measure().totalTokens < 61440, 'simulate provider 413 below local estimate');
    const genBefore = fThrow.surface.replaceGeneration;

    const { outcome, fellThrough } = await fThrow.runRequestError({ code: 'CONTEXT_WINDOW_EXCEEDED' });
    assert.equal(fellThrough, false);
    assert.deepEqual(outcome, { kind: 'retry' });
    assert.ok(fThrow.surface.replaceGeneration > genBefore, 'Snip must advance surface replaceGeneration');
    const stubs = fThrow.snipStubs();
    assert.equal(stubs.length, 1);
    assert.equal(fThrow.surface.nodes.includes(seeded.tool1.tr.seq), false);
    assert.ok(fThrow.surface.nodes.includes(seeded.recentU2.seq));
    const archived = await fThrow.engine.archive.readSpan(fThrow.session.id, stubs[0].msg.source.compactionId);
    assert.equal(archived.ok, true);
    assert.ok(archived.entries.some((e) => e.text.includes('SNIP_ARCHIVE_MARKER_A_')));
  } finally {
    await fThrow.cleanup();
  }

  // c2: compactIfNeeded('context-overflow') returns null (tripped breaker) -> Snip rescues with 0 LLM calls
  const fNull = await createPhaseDFixture();
  try {
    seedSnipableHistory(fNull, { oldToolTokens: 28000, tailTurnTokens: 10000, turnOpen: true });
    fNull.engine.sessionState.update(fNull.session.id, (s) => ({ ...s, failures: 3, stopped: true }));
    fNull.engine._stopped.set(fNull.session.id, true);

    const { outcome, fellThrough } = await fNull.runRequestError({ code: 'CONTEXT_WINDOW_EXCEEDED' });
    assert.equal(fellThrough, false);
    assert.deepEqual(outcome, { kind: 'retry' });
    assert.equal(fNull.llmCalls.length, 0);
    assert.equal(fNull.snipStubs().length, 1);
    assert.equal(fNull.engine._stopped.has(fNull.session.id), true, 'Snip must NOT clear tripped breaker');
    assert.equal(fNull.engine.sessionState.read(fNull.session.id).stopped, true);
  } finally {
    await fNull.cleanup();
  }
});

await test('(d) snipEnabled-false-disables-rescue-and-hard-budget-still-blocks', async () => {
  const f = await createPhaseDFixture({
    extraConfig: { snipEnabled: false, continuationEnabled: false },
    streamImpl: async function* () {
      throw Object.assign(new Error('summary down'), { code: 'HTTP_503', status: 503 });
    },
  });
  try {
    seedSnipableHistory(f, { oldToolTokens: 36000, tailTurnTokens: 14000, turnOpen: true });
    assert.ok(f.measure().totalTokens >= 61440);
    const nodesBefore = [...f.surface.nodes];

    // Site 2: pressure wall does not snip -> rejects
    await assert.rejects(
      f.runPreStep([]),
      (err) => err?.code === 'COMPACTION_AUTOMATIC_BLOCKED' || err?.code === 'COMPACTION_CAPACITY_BLOCKED',
    );
    assert.equal(f.snipStubs().length, 0);
    assert.deepEqual(f.surface.nodes, nodesBefore);

    // Site 1: budget wall strictly throws COMPACTION_REQUEST_BUDGET_EXCEEDED
    f.engine.compactIfNeeded = async () => null;
    await assert.rejects(
      f.runPreStep([]),
      (err) => err?.code === 'COMPACTION_AUTOMATIC_BLOCKED' && err?.failureCode === 'COMPACTION_REQUEST_BUDGET_EXCEEDED',
    );
    assert.equal(f.snipStubs().length, 0);
    assert.deepEqual(f.surface.nodes, nodesBefore);

    // Site 3: context-overflow does not snip when disabled
    f.engine.compactIfNeeded = async () => {
      throw Object.assign(new Error('overflow summary failed'), { code: 'HTTP_503' });
    };
    await assert.rejects(f.runRequestError({ code: 'CONTEXT_WINDOW_EXCEEDED' }), /超限后的压缩补救未完成/);
    assert.equal(f.snipStubs().length, 0);
    assert.deepEqual(f.surface.nodes, nodesBefore);
  } finally {
    await f.cleanup();
  }
});

await test('(e) protected-only-user-turns-over-budget-never-dropped-and-blocks-strictly', async () => {
  const f = await createPhaseDFixture();
  try {
    const t0 = Date.now() - 20 * MINUTE;
    f.session.append('turn/start', { turn: 1 }, { time: t0 });
    f.addSystem('System prompt.', t0 + 1);
    const u1 = f.addUser(`User turn 1 specification: ${tokensStr(22000, 'spec1')}`, { time: t0 + 10 });
    const u2 = f.addUser(`User turn 2 specification: ${tokensStr(22000, 'spec2')}`, { time: t0 + 20 });
    const u3 = f.addUser(`User turn 3 specification: ${tokensStr(22000, 'spec3')}`, { time: t0 + 30 });
    assert.ok(f.measure().totalTokens >= 61440, 'protected-only context must exceed messageBudgetTokens');
    const nodesBefore = [...f.surface.nodes];

    // Even when compactIfNeeded returns null at budget wall, Snip MUST NOT drop verified user messages
    f.engine.compactIfNeeded = async () => null;
    await assert.rejects(
      f.runPreStep([]),
      (err) => err?.code === 'COMPACTION_AUTOMATIC_BLOCKED' && err?.failureCode === 'COMPACTION_REQUEST_BUDGET_EXCEEDED',
    );
    assert.equal(f.snipStubs().length, 0, 'zero snip stubs allowed for user-only context');
    assert.deepEqual(f.surface.nodes, nodesBefore);
    assert.ok(f.surface.nodes.includes(u1.seq));
    assert.ok(f.surface.nodes.includes(u2.seq));
    assert.ok(f.surface.nodes.includes(u3.seq));
  } finally {
    await f.cleanup();
  }
});

await test('(f) RECOVERY_REQUIRED-and-pendingContinuation-are-never-bypassed-by-snip', async () => {
  // f1: RECOVERY_REQUIRED on pre-step and request-error
  const fRec = await createPhaseDFixture();
  try {
    seedSnipableHistory(fRec, { oldToolTokens: 36000, tailTurnTokens: 14000, turnOpen: true });
    const nodesBefore = [...fRec.surface.nodes];
    fRec.engine.recoverPending = async () => {
      throw Object.assign(new Error('unreconciled journal'), { code: 'RECOVERY_REQUIRED' });
    };
    await assert.rejects(fRec.runPreStep([]), (err) => err?.code === 'RECOVERY_REQUIRED');
    assert.equal(fRec.snipStubs().length, 0);
    assert.deepEqual(fRec.surface.nodes, nodesBefore);

    fRec.engine.compactIfNeeded = async () => {
      throw Object.assign(new Error('unreconciled journal'), { code: 'RECOVERY_REQUIRED' });
    };
    await assert.rejects(fRec.runRequestError({ code: 'CONTEXT_WINDOW_EXCEEDED' }), (err) => err?.code === 'RECOVERY_REQUIRED');
    assert.equal(fRec.snipStubs().length, 0);
    assert.deepEqual(fRec.surface.nodes, nodesBefore);
  } finally {
    await fRec.cleanup();
  }

  // f2: pendingContinuation active -> Snip refuses to mutate surface at all 3 sites
  const fCont = await createPhaseDFixture();
  try {
    const seeded = seedSnipableHistory(fCont, { oldToolTokens: 36000, tailTurnTokens: 14000, turnOpen: true });
    const nodesBefore = [...fCont.surface.nodes];
    freezeContinuation(fCont.engine.sessionState, fCont.session, [seeded.ruleUser.seq, seeded.tool1.asst.seq, seeded.tool1.tr.seq]);
    assert.ok(readPendingContinuation(fCont.engine.sessionState, fCont.session));

    // Site 2: pressure error with pendingContinuation
    fCont.engine.compactIfNeeded = async () => {
      throw Object.assign(new Error('continuation budget hit'), { code: 'CONTINUATION_CALL_BUDGET' });
    };
    await assert.rejects(fCont.runPreStep([]), (err) => err?.code === 'COMPACTION_AUTOMATIC_BLOCKED');
    assert.equal(fCont.snipStubs().length, 0);
    assert.deepEqual(fCont.surface.nodes, nodesBefore);
    assert.ok(readPendingContinuation(fCont.engine.sessionState, fCont.session), 'pendingContinuation must remain intact');

    // Site 1: budget wall with pendingContinuation
    fCont.engine.compactIfNeeded = async () => null;
    await assert.rejects(
      fCont.runPreStep([]),
      (err) => err?.code === 'COMPACTION_AUTOMATIC_BLOCKED' && err?.failureCode === 'COMPACTION_REQUEST_BUDGET_EXCEEDED',
    );
    assert.equal(fCont.snipStubs().length, 0);
    assert.deepEqual(fCont.surface.nodes, nodesBefore);

    // Site 3: context-overflow with pendingContinuation
    fCont.engine.compactIfNeeded = async () => {
      throw Object.assign(new Error('overflow during continuation'), { code: 'HTTP_503' });
    };
    await assert.rejects(fCont.runRequestError({ code: 'CONTEXT_WINDOW_EXCEEDED' }), /超限后的压缩补救未完成/);
    assert.equal(fCont.snipStubs().length, 0);
    assert.deepEqual(fCont.surface.nodes, nodesBefore);
  } finally {
    await fCont.cleanup();
  }
});

await test('(g) tripped-breaker-stopped-is-not-cleared-by-snip', async () => {
  const f = await createPhaseDFixture();
  try {
    seedSnipableHistory(f, { oldToolTokens: 36000, tailTurnTokens: 14000, turnOpen: true });
    assert.ok(f.measure().totalTokens >= 61440);

    // Trip the circuit breaker in both memory and persisted session state
    f.engine.sessionState.update(f.session.id, (s) => ({
      ...s,
      failures: 3,
      stopped: true,
      lastFailureCode: 'SUMMARY_TIMEOUT',
    }));
    f.engine._stopped.set(f.session.id, true);

    const { enteredMain } = await f.runPreStep([]);
    assert.equal(enteredMain, true, 'Snip should rescue hard budget wall with 0 LLM calls even while breaker is tripped');
    assert.equal(f.llmCalls.length, 0, 'tripped breaker + Snip rescue must invoke 0 LLM calls');
    assert.equal(f.snipStubs().length, 1);
    assert.ok(f.measure().totalTokens < 61440);

    // Breaker MUST remain tripped in memory AND persisted state
    assert.equal(f.engine._stopped.has(f.session.id), true, 'in-memory _stopped must NOT be cleared by Snip');
    const persisted = f.engine.sessionState.read(f.session.id);
    assert.equal(persisted.stopped, true, 'persisted stopped must NOT be cleared by Snip');
    assert.equal(persisted.failures, 3, 'persisted failure count must NOT be cleared by Snip');
    assert.equal(persisted.lastFailureCode, 'SUMMARY_TIMEOUT', 'root failure code must stay preserved');
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
