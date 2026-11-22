import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import {
  MICROCOMPACT_SUPERSEDED_MARKER,
  OBSERVATION_MASK_MARKER,
  PERSISTED_OUTPUT_MARKER,
} from '../lib/observation-mask.js';
import { buildCompactionInstruction } from '../lib/prompt.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message, stack: error.stack });
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

async function createPreStepFixture({
  extraConfig = {},
  windowTokens = 65536,
  summaryText = makeSummary(),
  baseTime = Date.now() - 45 * MINUTE,
} = {}) {
  const root = await mkdtemp(join(TEST_BASE, 'weave-phase-b-e2e-'));
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const hooks = new Map();
  const llmCalls = [];
  const logs = [];
  let flushes = 0;
  let seqClock = baseTime;

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

  const addUser = (text, time) =>
    session.append(
      'user/message',
      { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
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
          ...(isError ? { isError: true } : {}),
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
      if (target === 'next-step') this.nextStep.unshift(message);
      else this.nextTurn.unshift(message);
    },
  };

  const ctx = {
    on(eventName, fn) {
      hooks.set(eventName, fn);
      return () => hooks.delete(eventName);
    },
    provide() {},
    get() {
      return undefined;
    },
    logger: {
      info: (msg) => logs.push({ level: 'info', msg: String(msg) }),
      warn: (msg) => logs.push({ level: 'warn', msg: String(msg) }),
      error: (msg) => logs.push({ level: 'error', msg: String(msg) }),
      debug: (msg) => logs.push({ level: 'debug', msg: String(msg) }),
    },
    tokenMeter: {
      measure(s) {
        const nodes = s.surface.nodes.map((seq) => {
          const msg = s.deriveEventMessage(s.eventAt(seq));
          const tokens = Math.max(1, approxTokens(blocksToText(msg?.content)));
          return { seq, tokens, heuristicTokens: tokens };
        });
        const totalTokens = nodes.reduce((sum, n) => sum + n.tokens, 0);
        return {
          totalTokens,
          surfaceTokens: totalTokens,
          nodes,
          baseline: { kind: 'heuristic' },
        };
      },
      estimateMessage(message) {
        return Math.max(1, approxTokens(blocksToText(message?.content)));
      },
    },
    llm: {
      resolveModelInfo: async () => ({ contextWindow: windowTokens, maxOutputTokens: 4096 }),
      async *stream(req) {
        llmCalls.push(req);
        yield { type: 'text-delta', text: summaryText };
        yield { type: 'finish', kind: 'stop', usage: { inputTokens: 100, outputTokens: 50 } };
      },
    },
    sessions: {
      flush: async () => {
        flushes += 1;
        return true;
      },
      get: (id) => (id === session.id ? session : null),
    },
    tools: {
      register: () => () => {},
    },
  };

  const engine = new WeaveCompactionEngine(
    ctx,
    resolveConfig({
      archiveDir: join(root, 'archive'),
      proactiveEnabled: false,
      summaryRetryCount: 0,
      summaryConcurrency: 1,
      headroomTokens: 4096,
      thresholdRatio: 0.5,
      retainRatio: 0.1,
      ...extraConfig,
    }).config,
  );
  engine.historyToolsAvailable = true;

  const agent = {
    session,
    inbox,
    options: { provider: 'p', model: 'm' },
    async runMaintenance(fn) {
      return await fn(new AbortController().signal);
    },
  };

  const runPreStep = async (messages = [], signal = new AbortController().signal) => {
    let enteredMain = false;
    const preStep = hooks.get('agent/pre-step');
    assert.equal(typeof preStep, 'function', 'agent/pre-step hook must be registered');
    const out = await preStep({ agent, signal, messages }, async () => {
      enteredMain = true;
      return { kind: 'enter' };
    });
    return { enteredMain, out };
  };

  return {
    root,
    session,
    agent,
    inbox,
    engine,
    events,
    llmCalls,
    logs,
    get flushes() {
      return flushes;
    },
    addSystem,
    addUser,
    addAssistant,
    addToolStep,
    runPreStep,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

// ── (a) Persisted-Output in agent/pre-step ───────────────────────────────────

await test('persisted-output-spills-huge-tail-before-pressure-leaves-prior-and-errors-untouched', async () => {
  // Window 65536 - 4096 output - 4096 headroom = 57344 pressure budget; thresholdRatio 0.35 -> ~20070 tokens!
  // Tail tool output is ~100KB (~25000 tokens -> OVER thresholdTokens!).
  // Spilling tail before pressure brings total down to ~9500 tokens (< thresholdTokens) -> 0 LLM calls!
  const f = await createPreStepFixture({
    windowTokens: 65536,
    extraConfig: {
      auto: true,
      thresholdRatio: 0.35,
      persistedOutputEnabled: true,
      persistedOutputThresholdChars: 32768,
      persistedOutputHeadChars: 1200,
      persistedOutputTailChars: 1200,
    },
  });
  try {
    const priorLargeBody = 'PRIOR_PREFIX_HEAD_' + 'P'.repeat(35000) + '_PRIOR_PREFIX_TAIL';
    const tailHugeBody = 'TAIL_SPILL_HEAD_' + 'T'.repeat(96000) + '_TAIL_SPILL_TAIL';
    const tailErrorBody = 'TAIL_ERROR_HEAD_' + 'E'.repeat(40000) + '_TAIL_ERROR_TAIL';

    f.session.append('turn/start', { turn: 1 });
    f.addSystem('System prompt.');
    f.addUser('Inspect logs and continue.');
    // Step 1: large tool output BEFORE a subsequent assistant/message (historical prefix — MUST NOT be touched!)
    const priorTool = f.addToolStep({
      turn: 1,
      step: 1,
      toolName: 'run_command',
      args: { command: 'cat build.log' },
      resultText: priorLargeBody,
    });
    // Step 2: assistant emits two tool calls (one huge normal result, one huge isError result) — newly landed tail!
    const callNormal = 'call-tail-ok';
    const callErr = 'call-tail-err';
    f.session.append(
      'assistant/message',
      {
        turn: 1,
        step: 2,
        message: {
          id: randomUUID(),
          role: 'assistant',
          source: { kind: 'model', provider: 'p', model: 'm' },
          content: [
            { type: 'tool-call', id: callNormal, name: 'read_file', arguments: JSON.stringify({ path: 'logs/app.log' }) },
            { type: 'tool-call', id: callErr, name: 'run_command', arguments: JSON.stringify({ command: 'npm test' }) },
          ],
        },
      },
      { surfaceOp: 'append' },
    );
    const tcNormal = f.session.append('tool/call', { turn: 1, step: 2, callId: callNormal, name: 'read_file', arguments: JSON.stringify({ path: 'logs/app.log' }) });
    const trNormal = f.session.append(
      'tool/result',
      {
        turn: 1,
        step: 2,
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: callNormal,
          source: { kind: 'tool', callId: callNormal },
          content: [{ type: 'text', text: tailHugeBody }],
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [tcNormal.seq] },
    );
    const tcErr = f.session.append('tool/call', { turn: 1, step: 2, callId: callErr, name: 'run_command', arguments: JSON.stringify({ command: 'npm test' }) });
    const trErr = f.session.append(
      'tool/result',
      {
        turn: 1,
        step: 2,
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: callErr,
          source: { kind: 'tool', callId: callErr },
          isError: true,
          content: [{ type: 'text', text: tailErrorBody }],
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [tcErr.seq] },
    );

    const { enteredMain } = await f.runPreStep([]);
    assert.equal(enteredMain, true, 'pre-step must proceed to main model request');
    assert.equal(f.llmCalls.length, 0, 'tail spill before pressure check must avoid LLM pressure compaction');

    // Prior tool result before assistant/message MUST stay 100% untouched (zero prefix-cache invalidation!)
    assert.ok(f.session.surface.nodes.includes(priorTool.tr.seq), 'prior step tool/result seq must remain unchanged on surface');
    assert.equal(blocksToText(f.session.deriveEventMessage(f.session.eventAt(priorTool.tr.seq)).content), priorLargeBody);

    // isError tail tool result MUST remain 100% untouched
    assert.ok(f.session.surface.nodes.includes(trErr.seq), 'isError tail tool/result must remain unchanged');
    assert.equal(blocksToText(f.session.deriveEventMessage(f.session.eventAt(trErr.seq)).content), tailErrorBody);

    // Huge normal tail tool result MUST be replaced with PERSISTED_OUTPUT_MARKER stub + archived cleanly
    assert.ok(!f.session.surface.nodes.includes(trNormal.seq), 'huge tail tool/result seq must be replaced');
    const replacementSeq = f.session.surface.nodes.find((seq) => {
      const ev = f.session.eventAt(seq);
      return ev?.type === 'tool/result' && ev.data?.message?.toolCallId === callNormal;
    });
    assert.ok(typeof replacementSeq === 'number', 'replacement tool/result must be on surface');
    const stubText = blocksToText(f.session.deriveEventMessage(f.session.eventAt(replacementSeq)).content);
    assert.ok(stubText.includes(PERSISTED_OUTPUT_MARKER), `expected persisted output marker in stub:\n${stubText.slice(0, 200)}`);
    assert.ok(stubText.includes('TAIL_SPILL_HEAD_'), 'head excerpt must be preserved');
    assert.ok(stubText.includes('_TAIL_SPILL_TAIL'), 'tail excerpt must be preserved');
    const idMatch = /compactionId:\s*"([^"]+)"/.exec(stubText);
    assert.ok(idMatch, 'stub must reference compactionId');
    const archived = await f.engine.archive.readSpan(f.session.id, idMatch[1]);
    assert.equal(archived.ok, true);
    const archivedEntry = archived.entries.find((e) => e.seq === trNormal.seq);
    assert.ok(archivedEntry, 'original tail tool/result seq must be in archive');
    assert.equal(archivedEntry.text, tailHugeBody, 'archived original text must match byte-for-byte');
  } finally {
    await f.cleanup();
  }
});

await test('persisted-output-fails-open-on-archive-error-and-respects-disabled-flag', async () => {
  // 1. Fail-open on archive write error: does NOT block turn, does NOT mutate history, does NOT increment failure breaker
  const fFail = await createPreStepFixture({
    windowTokens: 200000,
    extraConfig: { auto: false, persistedOutputEnabled: true, persistedOutputThresholdChars: 4096 },
  });
  try {
    fFail.session.append('turn/start', { turn: 1 });
    fFail.addSystem('System.');
    fFail.addUser('Run.');
    const huge = fFail.addToolStep({ turn: 1, step: 1, resultText: 'X'.repeat(40000) });
    fFail.engine.archive.writeSpan = async () => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    };
    const nodesBefore = [...fFail.session.surface.nodes];

    const { enteredMain } = await fFail.runPreStep([]);
    assert.equal(enteredMain, true, 'pre-mutation archive error must fail open and let main step run');
    assert.deepEqual(fFail.session.surface.nodes, nodesBefore, 'surface must stay completely untouched on archive error');
    assert.ok(fFail.session.surface.nodes.includes(huge.tr.seq));
    assert.equal(fFail.engine._failures.get(fFail.engine._keyOf(fFail.session)) ?? 0, 0, 'fail-open spill must not trip failure breaker');
    assert.ok(fFail.logs.some((l) => l.level === 'warn' && /persisted-output archive failed/i.test(l.msg)));
  } finally {
    await fFail.cleanup();
  }

  // 2. Disabled via persistedOutputEnabled: false leaves huge tail untouched
  const fOff = await createPreStepFixture({
    windowTokens: 200000,
    extraConfig: { auto: false, persistedOutputEnabled: false, persistedOutputThresholdChars: 4096 },
  });
  try {
    fOff.session.append('turn/start', { turn: 1 });
    fOff.addSystem('System.');
    fOff.addUser('Run.');
    const huge = fOff.addToolStep({ turn: 1, step: 1, resultText: 'Y'.repeat(40000) });
    const nodesBefore = [...fOff.session.surface.nodes];

    const { enteredMain } = await fOff.runPreStep([]);
    assert.equal(enteredMain, true);
    assert.deepEqual(fOff.session.surface.nodes, nodesBefore, 'disabled persistedOutput must leave tail untouched');
    assert.equal(blocksToText(fOff.session.deriveEventMessage(fOff.session.eventAt(huge.tr.seq)).content), 'Y'.repeat(40000));
  } finally {
    await fOff.cleanup();
  }
});

// ── (b) Time-Based Microcompact via shared idleCompactionMinutes ─────────────

function seedIdleSessionWithTools(f, { activityTime, arrivalTime, oldToolChars = 8000, hotToolChars = 2500, proseChars = 200 }) {
  const newInput = {
    id: `user-resume-${randomUUID().slice(0, 8)}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Continue after break.' }],
  };
  f.session.append('turn/start', { turn: 1 }, { time: activityTime - 2000 });
  f.addSystem('System prompt.', activityTime - 1900);
  const u1 = f.addUser('Preserve strict integer cents. ' + 'U'.repeat(proseChars), activityTime - 1800);
  // Old read #1 of src/app.js (superseded by hot read #2 of src/app.js)
  const oldDupRead = f.addToolStep({
    turn: 1,
    step: 1,
    toolName: 'read_file',
    args: { path: 'src/app.js' },
    resultText: 'DUP_OLD_V1_' + 'A'.repeat(oldToolChars),
    time: activityTime - 1500,
  });
  // Old oversized shell output (outside newest K=2 hot tools)
  const oldOversized = f.addToolStep({
    turn: 1,
    step: 2,
    toolName: 'run_command',
    args: { command: 'npm run lint' },
    resultText: 'OLD_TOOL_HEAD_' + 'B'.repeat(oldToolChars) + '_OLD_TOOL_TAIL',
    time: activityTime - 1200,
  });
  // Hot tool #1 (newest K=2 protected!)
  const hot1 = f.addToolStep({
    turn: 1,
    step: 3,
    toolName: 'run_command',
    args: { command: 'git status' },
    resultText: 'HOT_1_' + 'H'.repeat(hotToolChars),
    time: activityTime - 900,
  });
  // Hot tool #2 (newest K=2 protected, also supersedes oldDupRead on src/app.js!)
  const hot2 = f.addToolStep({
    turn: 1,
    step: 4,
    toolName: 'read_file',
    args: { path: 'src/app.js' },
    resultText: 'HOT_2_LATEST_APP_' + 'L'.repeat(hotToolChars),
    time: activityTime - 600,
  });
  const a1 = f.addAssistant('Analysis prose stays intact. ' + 'M'.repeat(proseChars), activityTime);
  f.session.append('turn/end', { turn: 1 }, { time: activityTime + 10 });
  // New user arrival + open turn 2
  f.session.append(
    'agent/inbox/spliced',
    { target: 'next-turn', start: 0, inserted: [newInput] },
    { time: arrivalTime },
  );
  f.session.append('turn/start', { turn: 2 }, { time: arrivalTime + 1 });
  return { newInput, u1, a1, oldDupRead, oldOversized, hot1, hot2 };
}

await test('microcompact-inactive-while-warm-and-folds-expired-tools-with-zero-llm-calls', async () => {
  const now = Date.now();

  // 1. Warm cache (elapsed = 15 min <= 30 min): stays 100% inactive!
  const fWarm = await createPreStepFixture({
    windowTokens: 200000,
    extraConfig: {
      auto: false,
      idleCompactionMinutes: 30,
      microcompactEnabled: true,
      microcompactKeepRecentTools: 2,
      microcompactThresholdChars: 2000,
      microcompactRepeatedReadMinChars: 2000,
      minimumReductionRatio: 0.2,
    },
  });
  try {
    const seeded = seedIdleSessionWithTools(fWarm, {
      activityTime: now - 15 * MINUTE,
      arrivalTime: now,
    });
    const nodesBefore = [...fWarm.session.surface.nodes];
    const { enteredMain } = await fWarm.runPreStep([seeded.newInput]);
    assert.equal(enteredMain, true);
    assert.deepEqual(fWarm.session.surface.nodes, nodesBefore, 'warm cache (< idleCompactionMinutes) must remain untouched');
    assert.equal(fWarm.llmCalls.length, 0);
  } finally {
    await fWarm.cleanup();
  }

  // 2. Expired TTL (elapsed = 45 min > 30 min): folds old duplicate read + old oversized tool with 0 LLM calls,
  //    preserves newest K=2 hot tools & all user/assistant prose, skips Tier 3 when reducedRatio >= minimumReductionRatio!
  const fCold = await createPreStepFixture({
    windowTokens: 200000,
    extraConfig: {
      auto: false,
      idleCompactionMinutes: 30,
      microcompactEnabled: true,
      microcompactKeepRecentTools: 2,
      microcompactThresholdChars: 2000,
      microcompactHeadChars: 200,
      microcompactTailChars: 200,
      microcompactRepeatedReadMinChars: 2000,
      minimumReductionRatio: 0.2,
      idleFullSummaryEnabled: true,
    },
  });
  try {
    const seeded = seedIdleSessionWithTools(fCold, {
      activityTime: now - 45 * MINUTE,
      arrivalTime: now,
      oldToolChars: 8000,
      hotToolChars: 2500,
      proseChars: 200,
    });
    const { enteredMain } = await fCold.runPreStep([seeded.newInput]);
    assert.equal(enteredMain, true);
    assert.equal(fCold.llmCalls.length, 0, 'sufficient microcompact reduction must skip full idle LLM summary (0 LLM calls)');

    // Old duplicate read folded with MICROCOMPACT_SUPERSEDED_MARKER
    assert.ok(!fCold.session.surface.nodes.includes(seeded.oldDupRead.tr.seq));
    const dupRepSeq = fCold.session.surface.nodes.find((seq) => {
      const ev = fCold.session.eventAt(seq);
      return ev?.type === 'tool/result' && ev.data?.message?.toolCallId === seeded.oldDupRead.callId;
    });
    const dupStub = blocksToText(fCold.session.deriveEventMessage(fCold.session.eventAt(dupRepSeq)).content);
    assert.ok(dupStub.includes(MICROCOMPACT_SUPERSEDED_MARKER), `expected superseded marker:\n${dupStub}`);
    assert.ok(dupStub.includes(`superseded by seq ${seeded.hot2.tr.seq}`), 'stub must point to newer read seq');

    // Old oversized tool folded with OBSERVATION_MASK_MARKER
    assert.ok(!fCold.session.surface.nodes.includes(seeded.oldOversized.tr.seq));
    const maskRepSeq = fCold.session.surface.nodes.find((seq) => {
      const ev = fCold.session.eventAt(seq);
      return ev?.type === 'tool/result' && ev.data?.message?.toolCallId === seeded.oldOversized.callId;
    });
    const maskStub = blocksToText(fCold.session.deriveEventMessage(fCold.session.eventAt(maskRepSeq)).content);
    assert.ok(maskStub.includes(OBSERVATION_MASK_MARKER), `expected observation mask marker:\n${maskStub}`);
    assert.ok(maskStub.includes('OLD_TOOL_HEAD_') && maskStub.includes('_OLD_TOOL_TAIL'));

    // Archive holds exact originals
    const compId = /compactionId:\s*"([^"]+)"/.exec(dupStub)?.[1];
    assert.ok(compId);
    const archived = await fCold.engine.archive.readSpan(fCold.session.id, compId);
    assert.equal(archived.ok, true);
    assert.ok(archived.entries.some((e) => e.seq === seeded.oldDupRead.tr.seq && e.text.includes('DUP_OLD_V1_')));
    assert.ok(archived.entries.some((e) => e.seq === seeded.oldOversized.tr.seq && e.text.includes('OLD_TOOL_HEAD_')));

    // Newest K=2 hot tools & conversation prose are 100% preserved untouched!
    assert.ok(fCold.session.surface.nodes.includes(seeded.hot1.tr.seq), 'hot tool #1 must stay intact');
    assert.ok(fCold.session.surface.nodes.includes(seeded.hot2.tr.seq), 'hot tool #2 must stay intact');
    assert.ok(fCold.session.surface.nodes.includes(seeded.u1.seq), 'user prose must stay untouched');
    assert.ok(fCold.session.surface.nodes.includes(seeded.a1.seq), 'assistant prose must stay untouched');
    assert.ok(
      fCold.logs.some((l) => l.level === 'info' && /skipping full idle summary/i.test(l.msg)),
      'should log skipping full idle summary when microcompact achieved minimumReductionRatio',
    );
  } finally {
    await fCold.cleanup();
  }
});

await test('microcompact-tier3-gates-minTokens-idleFullSummaryEnabled-and-fallback-to-llm', async () => {
  const now = Date.now();

  // 1. idleFullSummaryEnabled: false -> runs Tier 1 microcompact and NEVER runs Tier 3 LLM even with tiny reduction!
  const fNoFull = await createPreStepFixture({
    windowTokens: 200000,
    extraConfig: {
      auto: false,
      idleCompactionMinutes: 30,
      microcompactEnabled: true,
      microcompactKeepRecentTools: 2,
      microcompactThresholdChars: 2000,
      minimumReductionRatio: 0.9, // unreachable by microcompact alone
      idleFullSummaryEnabled: false,
    },
  });
  try {
    const seeded = seedIdleSessionWithTools(fNoFull, {
      activityTime: now - 45 * MINUTE,
      arrivalTime: now,
      oldToolChars: 3000,
      hotToolChars: 1000,
      proseChars: 12000,
    });
    const { enteredMain } = await fNoFull.runPreStep([seeded.newInput]);
    assert.equal(enteredMain, true);
    assert.equal(fNoFull.llmCalls.length, 0, 'idleFullSummaryEnabled: false must never call LLM');
    assert.ok(!fNoFull.session.surface.nodes.includes(seeded.oldOversized.tr.seq), 'Tier 1 microcompact still folded older tools');
  } finally {
    await fNoFull.cleanup();
  }

  // 2. afterMicro.totalTokens < idleCompactionMinTokens -> skips Tier 3 LLM even when reducedRatio < minimumReductionRatio!
  const fMinTok = await createPreStepFixture({
    windowTokens: 200000,
    extraConfig: {
      auto: false,
      idleCompactionMinutes: 30,
      idleCompactionMinTokens: 50000,
      microcompactEnabled: true,
      microcompactKeepRecentTools: 2,
      microcompactThresholdChars: 2000,
      minimumReductionRatio: 0.9,
      idleFullSummaryEnabled: true,
    },
  });
  try {
    const seeded = seedIdleSessionWithTools(fMinTok, {
      activityTime: now - 45 * MINUTE,
      arrivalTime: now,
      oldToolChars: 3000,
      hotToolChars: 1000,
      proseChars: 12000,
    });
    const { enteredMain } = await fMinTok.runPreStep([seeded.newInput]);
    assert.equal(enteredMain, true);
    assert.equal(fMinTok.llmCalls.length, 0, 'afterMicro < idleCompactionMinTokens must skip Tier 3 LLM');
    assert.ok(!fMinTok.session.surface.nodes.includes(seeded.oldOversized.tr.seq));
  } finally {
    await fMinTok.cleanup();
  }

  // 3. Microcompact alone is insufficient (reducedRatio < minimumReductionRatio) -> falls back cleanly to Tier 3 full idle LLM summary!
  const fFallback = await createPreStepFixture({
    windowTokens: 200000,
    extraConfig: {
      auto: false,
      idleCompactionMinutes: 30,
      microcompactEnabled: true,
      microcompactKeepRecentTools: 2,
      microcompactThresholdChars: 2000,
      minimumReductionRatio: 0.5, // huge prose dominates so microcompact only saves ~15% -> triggers Tier 3
      idleFullSummaryEnabled: true,
    },
  });
  try {
    const seeded = seedIdleSessionWithTools(fFallback, {
      activityTime: now - 45 * MINUTE,
      arrivalTime: now,
      oldToolChars: 2400,
      hotToolChars: 500,
      proseChars: 16000,
    });
    const { enteredMain } = await fFallback.runPreStep([seeded.newInput]);
    assert.equal(enteredMain, true);
    assert.equal(fFallback.llmCalls.length, 1, 'insufficient microcompact reduction must fall back to Tier 3 idle LLM summary');
    assert.ok(
      fFallback.session.surface.nodes.some(
        (seq) => fFallback.session.deriveEventMessage(fFallback.session.eventAt(seq))?.source?.kind === 'compact-checkpoint',
      ),
      'Tier 3 fallback must commit a compact-checkpoint',
    );
  } finally {
    await fFallback.cleanup();
  }
});

// ── (c) microcompactEnabled: false + abort & circuit-breaker invariants ──────

await test('microcompact-disabled-runs-tier3-and-preserves-abort-and-breaker-invariants', async () => {
  const now = Date.now();

  // 1. microcompactEnabled: false skips Tier 1 and runs Tier 3 directly
  const fOff = await createPreStepFixture({
    windowTokens: 200000,
    extraConfig: {
      auto: false,
      idleCompactionMinutes: 30,
      microcompactEnabled: false,
      idleFullSummaryEnabled: true,
    },
  });
  try {
    const seeded = seedIdleSessionWithTools(fOff, {
      activityTime: now - 45 * MINUTE,
      arrivalTime: now,
      oldToolChars: 8000,
      hotToolChars: 2500,
      proseChars: 200,
    });
    const { enteredMain } = await fOff.runPreStep([seeded.newInput]);
    assert.equal(enteredMain, true);
    assert.equal(fOff.llmCalls.length, 1, 'microcompactEnabled: false must bypass Tier 1 and run Tier 3 LLM');
    assert.ok(!fOff.logs.some((l) => /idle microcompact/i.test(l.msg)), 'must not log microcompact when disabled');
  } finally {
    await fOff.cleanup();
  }

  // 2. Abort during microcompact propagates abort without incrementing failure breaker & restores claimed input
  const fAbort = await createPreStepFixture({
    windowTokens: 200000,
    extraConfig: {
      auto: false,
      idleCompactionMinutes: 30,
      microcompactEnabled: true,
      microcompactKeepRecentTools: 2,
      microcompactThresholdChars: 2000,
    },
  });
  try {
    const seeded = seedIdleSessionWithTools(fAbort, {
      activityTime: now - 45 * MINUTE,
      arrivalTime: now,
      oldToolChars: 8000,
    });
    const controller = new AbortController();
    const abortErr = Object.assign(new Error('user aborted'), { name: 'AbortError' });
    fAbort.engine.archive.writeSpan = async () => {
      controller.abort(abortErr);
      throw abortErr;
    };
    await assert.rejects(fAbort.runPreStep([seeded.newInput], controller.signal), (err) => err === abortErr);
    assert.equal(fAbort.engine._failures.get(fAbort.engine._keyOf(fAbort.session)) ?? 0, 0, 'abort must never increment failure breaker');
    assert.deepEqual(fAbort.inbox.nextStep, [seeded.newInput], 'claimed input must be restored on abort');
  } finally {
    await fAbort.cleanup();
  }

  // 3. Non-abort microcompact archive error records failure toward breaker; persisted stopped breaker throws COMPACTION_STOPPED before Tier 1!
  const fFail = await createPreStepFixture({
    windowTokens: 200000,
    extraConfig: {
      auto: false,
      idleCompactionMinutes: 30,
      microcompactEnabled: true,
      microcompactKeepRecentTools: 2,
      microcompactThresholdChars: 2000,
      failureThreshold: 2,
    },
  });
  try {
    const seeded = seedIdleSessionWithTools(fFail, {
      activityTime: now - 45 * MINUTE,
      arrivalTime: now,
      oldToolChars: 8000,
    });
    let writeCalls = 0;
    fFail.engine.archive.writeSpan = async () => {
      writeCalls += 1;
      throw Object.assign(new Error('disk error'), { code: 'EIO' });
    };
    await assert.rejects(fFail.runPreStep([seeded.newInput]), (e) => e.code === 'COMPACTION_AUTOMATIC_BLOCKED');
    assert.equal(writeCalls, 1);
    assert.equal(fFail.engine._failures.get(fFail.engine._keyOf(fFail.session)), 1, 'non-abort microcompact error must increment failure counter');
    assert.deepEqual(fFail.inbox.nextStep, [seeded.newInput], 'claimed input must be restored on failure');

    // Trip breaker -> subsequent pre-step skips idle compaction & Tier 1 without blocking main step!
    fFail.engine.sessionState.update(fFail.session.id, (s) => ({ ...s, failures: 2, stopped: true }));
    const { enteredMain } = await fFail.runPreStep([seeded.newInput]);
    assert.equal(enteredMain, true, 'tripped breaker must skip idle compaction & Tier 1 microcompact without blocking main step');
    assert.equal(writeCalls, 1, 'stopped breaker must short-circuit before Tier 1 microcompact');
    assert.ok(fFail.logs.some((l) => l.level === 'warn' && /idle compaction skipped because circuit breaker is active/i.test(l.msg)));
  } finally {
    await fFail.cleanup();
  }
});

// ── (d) minGrowthTokens > 0 must NOT be debounced by tail spill or Tier 1 microcompact ──

await test('minGrowthTokens-does-not-suppress-same-step-pressure-after-spill-or-microcompact', async () => {
  const now = Date.now();

  // 1. After _spillTailToolOutputs leaves session STILL >= thresholdTokens with minGrowthTokens: 4096,
  //    compactIfNeeded('pressure') MUST still run in the same agent/pre-step!
  const fSpill = await createPreStepFixture({
    windowTokens: 65536,
    extraConfig: {
      auto: true,
      thresholdRatio: 0.2, // thresholdTokens ~= 11468
      retainRatio: 0.05,
      minGrowthTokens: 4096,
      persistedOutputEnabled: true,
      persistedOutputThresholdChars: 32768,
    },
  });
  try {
    fSpill.session.append('turn/start', { turn: 1 });
    fSpill.addSystem('System.');
    fSpill.addUser('Keep strict integer cents.');
    // Three normal-sized prose messages (~54KB total ~= 13500 tokens > thresholdTokens even after tail spill!)
    fSpill.addAssistant('Prior analysis prose block 1. '.repeat(600));
    fSpill.addUser('Continue analysis.');
    fSpill.addAssistant('Prior analysis prose block 2. '.repeat(600));
    fSpill.addUser('Keep going.');
    fSpill.addAssistant('Prior analysis prose block 3. '.repeat(600));
    const tail = fSpill.addToolStep({
      turn: 1,
      step: 1,
      toolName: 'run_command',
      args: { command: 'cat big.log' },
      resultText: 'SPILL_HEAD_' + 'Z'.repeat(36000) + '_SPILL_TAIL',
    });

    const { enteredMain } = await fSpill.runPreStep([]);
    assert.equal(enteredMain, true);
    assert.ok(!fSpill.session.surface.nodes.includes(tail.tr.seq), 'tail tool/result must still be spilled');
    assert.ok(
      fSpill.llmCalls.length >= 1,
      'pressure compaction MUST still run when remaining tokens >= thresholdTokens even with minGrowthTokens: 4096',
    );
    assert.ok(
      fSpill.session.surface.nodes.some(
        (seq) => fSpill.session.deriveEventMessage(fSpill.session.eventAt(seq))?.source?.kind === 'compact-checkpoint',
      ),
      'pressure compaction must commit a compact-checkpoint in the same pre-step',
    );
  } finally {
    await fSpill.cleanup();
  }

  // 2. After Tier 1 idle microcompact (with idleFullSummaryEnabled: false) leaves session STILL >= thresholdTokens
  //    with minGrowthTokens: 4096, compactIfNeeded('pressure') MUST still run in the same agent/pre-step!
  const fMicro = await createPreStepFixture({
    windowTokens: 65536,
    extraConfig: {
      auto: true,
      thresholdRatio: 0.2, // thresholdTokens = 11468
      retainRatio: 0.05,
      minGrowthTokens: 4096,
      idleCompactionMinutes: 30,
      microcompactEnabled: true,
      microcompactKeepRecentTools: 2,
      microcompactThresholdChars: 2000,
      idleFullSummaryEnabled: false,
    },
  });
  try {
    const newInput = {
      id: `user-resume-growth-${randomUUID().slice(0, 8)}`,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Continue after break.' }],
    };
    const activityTime = now - 45 * MINUTE;
    fMicro.session.append('turn/start', { turn: 1 }, { time: activityTime - 2000 });
    fMicro.addSystem('System prompt.', activityTime - 1900);
    fMicro.addUser('Preserve strict integer cents.', activityTime - 1800);
    // 3 normal-sized assistant prose blocks (~54KB total ~= 13500 tokens > thresholdTokens 11468 even after microcompact!)
    fMicro.addAssistant('Detailed analysis section 1. '.repeat(620), activityTime - 1700);
    fMicro.addAssistant('Detailed analysis section 2. '.repeat(620), activityTime - 1600);
    const oldOversized = fMicro.addToolStep({
      turn: 1,
      step: 1,
      toolName: 'run_command',
      args: { command: 'npm run lint' },
      resultText: 'OLD_LINT_HEAD_' + 'B'.repeat(8000) + '_OLD_LINT_TAIL',
      time: activityTime - 1200,
    });
    fMicro.addToolStep({
      turn: 1,
      step: 2,
      toolName: 'run_command',
      args: { command: 'git status' },
      resultText: 'HOT_1_' + 'H'.repeat(1000),
      time: activityTime - 900,
    });
    fMicro.addToolStep({
      turn: 1,
      step: 3,
      toolName: 'read_file',
      args: { path: 'src/app.js' },
      resultText: 'HOT_2_' + 'L'.repeat(1000),
      time: activityTime - 600,
    });
    fMicro.addAssistant('Detailed analysis section 3. '.repeat(620), activityTime);
    fMicro.session.append('turn/end', { turn: 1 }, { time: activityTime + 10 });
    fMicro.session.append(
      'agent/inbox/spliced',
      { target: 'next-turn', start: 0, inserted: [newInput] },
      { time: now },
    );
    fMicro.session.append('turn/start', { turn: 2 }, { time: now + 1 });

    const { enteredMain } = await fMicro.runPreStep([newInput]);
    assert.equal(enteredMain, true);
    assert.ok(!fMicro.session.surface.nodes.includes(oldOversized.tr.seq), 'Tier 1 microcompact must fold old tool first');
    assert.ok(
      fMicro.llmCalls.length >= 1,
      'pressure compaction MUST still run after Tier 1 microcompact when remaining tokens >= thresholdTokens even with minGrowthTokens: 4096',
    );
    assert.ok(
      fMicro.session.surface.nodes.some(
        (seq) => fMicro.session.deriveEventMessage(fMicro.session.eventAt(seq))?.source?.kind === 'compact-checkpoint',
      ),
      'pressure compaction must commit a compact-checkpoint in the same pre-step',
    );
  } finally {
    await fMicro.cleanup();
  }
});

console.log(JSON.stringify({ passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, results }, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
