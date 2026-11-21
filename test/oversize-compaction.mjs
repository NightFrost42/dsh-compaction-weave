import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CompactionArchive } from '../lib/history.js';
import {
  MAX_TOOL_SOURCE_DEPTH,
  MAX_TOOL_SOURCE_EVENTS,
  historySourceSeqs,
  inspectToolSourceBudget,
} from '../lib/history-source.js';
import { attachmentReferences, preserveAttachments } from '../lib/attachments.js';
import {
  MAX_MASK_STAGE_REFS,
  OBSERVATION_MASK_MARKER,
  commitObservationMask,
  planObservationMask,
} from '../lib/observation-mask.js';
import {
  DEFAULT_MAX_CHUNK_TOOL_SOURCE_REFS,
  buildSummaryRequest,
  capacityLimit,
  planSummaryRange,
  resolveSummaryCapacity,
} from '../lib/summary-budget.js';
import { summarizeWithChain, summarizeWithTarget } from '../lib/summary.js';
import {
  DEFAULT_CONTINUATION_WAVE_TOOL_SOURCE_REFS,
  prepareContinuation,
  selectContinuationWave,
  sourcePages,
} from '../lib/continuation.js';
import { resolveConfig } from '../lib/config.js';
import { approxTokens, blocksToText } from '../lib/meter.js';

const rows = [];
async function test(name, fn) {
  try {
    await fn();
    rows.push({ name, pass: true });
  } catch (error) {
    rows.push({ name, pass: false, error: error.message, stack: error.stack });
  }
}

function makeMockSession() {
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const session = {
    id: randomUUID(),
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    toolHistory: () => [],
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (event.type === 'assistant/message') return event.data?.message;
      if (event.type === 'tool/result') return event.data?.message;
      if (typeof event.type === 'string' && event.type.endsWith('/message')) return event.data;
      return undefined;
    },
    append(type, data, options = {}) {
      const event = {
        seq: events.length,
        type,
        data,
        ...(options.sourceEventSeqs !== undefined ? { sourceEventSeqs: options.sourceEventSeqs } : {}),
      };
      events.push(event);
      const op = options.surfaceOp;
      if (op?.op === 'replace') {
        const startIdx = surface.nodes.indexOf(op.startSeq);
        const endIdx = surface.nodes.indexOf(op.endSeq);
        assert.ok(startIdx >= 0 && endIdx >= startIdx, `replace range ${op.startSeq}..${op.endSeq} missing`);
        surface.nodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
        surface.replaceGeneration += 1;
      } else if (op === 'append') {
        surface.nodes.push(event.seq);
      }
      return event;
    },
  };

  const addSystem = (text) =>
    session.append(
      'system/message',
      { id: randomUUID(), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system' } },
      { surfaceOp: 'append' },
    );

  const addUser = (text, sourceKind = 'user') =>
    session.append(
      'user/message',
      { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: sourceKind } },
      { surfaceOp: 'append' },
    );

  const addAssistant = (text) =>
    session.append(
      'assistant/message',
      { message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'fixture' } } },
      { surfaceOp: 'append' },
    );

  const addToolTurn = (text, { callId = `call-${events.length}`, toolName = 'read_file', extraSources = 0 } = {}) => {
    const callEvent = session.append('tool/call', { callId, name: toolName, arguments: { path: 'src/app.js' } });
    const assistantEvent = session.append(
      'assistant/message',
      {
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'tool-call', callId, toolName, args: { path: 'src/app.js' } }],
          source: { kind: 'fixture' },
        },
      },
      { surfaceOp: 'append' },
    );

    const hiddenSeqs = [];
    for (let i = 0; i < extraSources; i += 1) {
      const hidden = session.append('tool/result', {
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: callId,
          content: [{ type: 'text', text: `hidden-${i}` }],
          source: { kind: 'tool-result', callId },
        },
      });
      hiddenSeqs.push(hidden.seq);
    }

    const resEvent = session.append(
      'tool/result',
      {
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: callId,
          content: [{ type: 'text', text }],
          source: { kind: 'tool-result', callId },
        },
      },
      {
        surfaceOp: 'append',
        ...(hiddenSeqs.length > 0 ? { sourceEventSeqs: hiddenSeqs } : {}),
      },
    );
    return { callEvent, assistantEvent, resEvent, hiddenSeqs };
  };

  const measure = () => {
    const nodes = surface.nodes.map((seq) => {
      const msg = session.deriveEventMessage(events[seq]);
      const text = typeof msg?.content === 'string' ? msg.content : blocksToText(msg?.content);
      return { seq, tokens: Math.max(10, approxTokens(text)) };
    });
    return {
      nodes,
      totalTokens: nodes.reduce((sum, item) => sum + item.tokens, 0),
      precision: 'heuristic',
    };
  };

  return { session, events, surface, addSystem, addUser, addAssistant, addToolTurn, measure };
}

// 1. Batched >3,840-ref observation masking across multiple passes
await test('observation-mask-batched-over-3840-refs-multipass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-oversize-mask-'));
  try {
    const f = makeMockSession();
    f.addSystem('System prompt.');
    f.addUser('Keep production safe.');

    const totalOutputs = MAX_MASK_STAGE_REFS + 160; // 4,000 > 3,840
    const bigText = 'L'.repeat(5000);
    // Group calls into batched assistant turns (200 tool calls per turn) so the
    // surface has valid balanced tool-call / tool-result pairing while keeping
    // the test fast.
    for (let batchStart = 0; batchStart < totalOutputs; batchStart += 200) {
      const batchEnd = Math.min(totalOutputs, batchStart + 200);
      const callBlocks = [];
      for (let i = batchStart; i < batchEnd; i += 1) {
        callBlocks.push({ type: 'tool-call', callId: `c-${i}`, toolName: 'read_file', args: { path: `f-${i}.log` } });
      }
      f.session.append(
        'assistant/message',
        { message: { id: `a-${batchStart}`, role: 'assistant', content: callBlocks, source: { kind: 'fixture' } } },
        { surfaceOp: 'append' },
      );
      for (let i = batchStart; i < batchEnd; i += 1) {
        const callId = `c-${i}`;
        f.session.append(
          'tool/result',
          {
            message: {
              id: `m-${i}`,
              role: 'tool',
              toolCallId: callId,
              content: [{ type: 'text', text: bigText }],
              source: { kind: 'tool-result', callId },
            },
          },
          { surfaceOp: 'append' },
        );
      }
    }
    // Retained tail outside compactable range
    f.addUser('Latest user request in retained tail.');
    f.addAssistant('Latest assistant reply in retained tail.');

    const archive = new CompactionArchive({ root: join(root, 'archive') });

    // Pass 1: should select exactly MAX_MASK_STAGE_REFS (3840) and signal hasMore: true
    const m1 = f.measure();
    const plan1 = planObservationMask(f.session, m1, 20, {
      compactionId: 'weave-mask-pass-1',
      thresholdChars: 1000,
    });
    assert.ok(plan1, 'expected Pass 1 mask plan on 4000-tool-result span');
    assert.equal(plan1.targets.length, MAX_MASK_STAGE_REFS);
    assert.equal(plan1.batchRefs, MAX_MASK_STAGE_REFS);
    assert.equal(plan1.hasMore, true);

    const committed1 = await commitObservationMask({ session: f.session, plan: plan1, archive });
    assert.ok(committed1);
    assert.equal(committed1.maskedCount, MAX_MASK_STAGE_REFS);

    // Pass 2: should select remaining 160 outputs and signal hasMore: false
    const m2 = f.measure();
    const plan2 = planObservationMask(f.session, m2, 20, {
      compactionId: 'weave-mask-pass-2',
      thresholdChars: 1000,
    });
    assert.ok(plan2, 'expected Pass 2 mask plan for remaining 160 tool results');
    assert.equal(plan2.targets.length, 160);
    assert.equal(plan2.batchRefs, 160);
    assert.equal(plan2.hasMore, false);

    const committed2 = await commitObservationMask({ session: f.session, plan: plan2, archive });
    assert.ok(committed2);
    assert.equal(committed2.maskedCount, 160);

    // Pass 3: nothing left to mask
    const plan3 = planObservationMask(f.session, f.measure(), 20, {
      compactionId: 'weave-mask-pass-3',
      thresholdChars: 1000,
    });
    assert.equal(plan3, null);

    // Verify unselected small tool results with many refs do NOT block masking of valid large outputs
    const f2 = makeMockSession();
    f2.addSystem('Sys.');
    f2.addUser('Go.');
    f2.addToolTurn('small ok', { callId: 'small-heavy', extraSources: 50 });
    const validBig = f2.addToolTurn('M'.repeat(5000), { callId: 'valid-big', extraSources: 2 });
    f2.addUser('Tail.');
    f2.addAssistant('Tail reply.');
    const planSmallCap = planObservationMask(f2.session, f2.measure(), 20, {
      compactionId: 'weave-mask-selected-only',
      thresholdChars: 1000,
      maxBatchRefs: 10,
    });
    assert.ok(planSmallCap, 'unselected small node refs must not consume batchRefs budget');
    assert.deepEqual(
      planSmallCap.targets.map((t) => t.seq),
      [validBig.resEvent.seq],
    );
    assert.equal(planSmallCap.batchRefs, 3); // 2 existing refs + 1 new mask ref
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 2. Invalid/unmappable tool/result nodes are skipped individually instead of aborting whole span
await test('observation-mask-skips-invalid-and-unmappable-nodes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-oversize-invalid-'));
  try {
    const f = makeMockSession();
    f.addSystem('System.');
    const userEvent = f.addUser('Keep checks.');
    const good1 = f.addToolTurn('A'.repeat(5000), { callId: 'good-1' });

    // Pair the 4 invalid tool/result nodes with valid surface tool-calls so the
    // surface passes tool-pairing balance while each result's provenance is broken.
    f.session.append(
      'assistant/message',
      {
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [
            { type: 'tool-call', callId: 'bad-empty', toolName: 'bash', args: {} },
            { type: 'tool-call', callId: 'bad-dangling', toolName: 'bash', args: {} },
            { type: 'tool-call', callId: 'bad-wrong-type', toolName: 'bash', args: {} },
            { type: 'tool-call', callId: 'call-a', toolName: 'bash', args: {} },
          ],
          source: { kind: 'fixture' },
        },
      },
      { surfaceOp: 'append' },
    );

    // Invalid #1: empty sourceEventSeqs
    f.session.append(
      'tool/result',
      {
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: 'bad-empty',
          content: [{ type: 'text', text: 'B'.repeat(5000) }],
          source: { kind: 'tool-result', callId: 'bad-empty' },
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [] },
    );

    // Invalid #2: dangling missing seq in sourceEventSeqs
    f.session.append(
      'tool/result',
      {
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: 'bad-dangling',
          content: [{ type: 'text', text: 'C'.repeat(5000) }],
          source: { kind: 'tool-result', callId: 'bad-dangling' },
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [99999] },
    );

    // Invalid #3: cites a user/message instead of tool/result|tool/call
    f.session.append(
      'tool/result',
      {
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: 'bad-wrong-type',
          content: [{ type: 'text', text: 'D'.repeat(5000) }],
          source: { kind: 'tool-result', callId: 'bad-wrong-type' },
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [userEvent.seq] },
    );

    // Invalid #4: conflicting toolCallId vs source.callId
    f.session.append(
      'tool/result',
      {
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: 'call-a',
          content: [{ type: 'text', text: 'E'.repeat(5000) }],
          source: { kind: 'tool-result', callId: 'call-b' },
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [good1.callEvent.seq] },
    );

    const good2 = f.addToolTurn('F'.repeat(5000), { callId: 'good-2' });
    f.addUser('Tail prompt.');
    f.addAssistant('Tail response.');

    const plan = planObservationMask(f.session, f.measure(), 20, {
      compactionId: 'weave-skip-invalid',
      thresholdChars: 1000,
    });
    assert.ok(plan, 'valid nodes must still be masked despite invalid neighbors');
    assert.deepEqual(
      plan.targets.map((t) => t.seq),
      [good1.resEvent.seq, good2.resEvent.seq],
    );

    const archive = new CompactionArchive({ root: join(root, 'archive') });
    const committed = await commitObservationMask({ session: f.session, plan, archive });
    assert.ok(committed);
    assert.equal(committed.maskedCount, 2);
    const maskedText = f.session.deriveEventMessage(f.session.eventAt(f.surface.nodes.find((s) => s > good2.resEvent.seq))).content[0].text;
    assert.ok(maskedText.includes(OBSERVATION_MASK_MARKER));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 3. buildSummaryRequest guards against string m.content and null blocks
await test('summary-budget-guards-string-and-null-content', () => {
  const req = buildSummaryRequest({
    messages: [
      { role: 'user', content: '请保留所有关键配置参数，不要修改生产数据库。' },
      { role: 'assistant', content: null },
      { role: 'user', content: undefined },
      { role: 'assistant', content: [null, undefined, { type: 'text', text: '已确认检查结果。' }, { type: 'text', text: null }] },
    ],
  });
  assert.equal(req.language, 'zh');
  assert.ok(Number.isSafeInteger(req.inputUnits) && req.inputUnits > 0);
  assert.equal(req.messages.length, 5);
});

// 4. Primary-target capacity resolution without smaller fallback clamping (and backward compat)
await test('summary-budget-single-target-capacity-without-clamping', async () => {
  const resolvedCalls = [];
  const ctx = {
    llm: {
      async resolveModelInfo(provider, model) {
        resolvedCalls.push(`${provider}/${model}`);
        if (model === 'primary-1m') return { contextWindow: 1_000_000 };
        if (model === 'fallback-32k') return { contextWindow: 32_000 };
        return {};
      },
    },
  };
  const chain = {
    targets: [
      { provider: 'big', model: 'primary-1m' },
      { provider: 'small', model: 'fallback-32k' },
    ],
    source: 'config',
  };
  const config = {
    ...resolveConfig({ maxTokens: 4096, headroomTokens: 4096, summaryInputRatio: 0.5, summaryInputMaxBytes: 1_000_000 }).config,
  };

  // Default (backward-compatible multi-target): clamps to smaller fallback
  const multiCap = await resolveSummaryCapacity(ctx, chain, config);
  assert.equal(multiCap.targets.length, 2);
  assert.deepEqual(resolvedCalls, ['big/primary-1m', 'small/fallback-32k']);
  const clampedLimit = capacityLimit(multiCap);
  assert.equal(clampedLimit, Math.floor((32_000 - 4096 - 4096) * 0.5));

  // capacityLimit with { singleTarget: true } on an already-resolved multi-target capacity
  const primaryOnlyFromMulti = capacityLimit(multiCap, { singleTarget: true });
  assert.equal(primaryOnlyFromMulti, Math.floor((1_000_000 - 4096 - 4096) * 0.5));
  assert.ok(primaryOnlyFromMulti > clampedLimit * 20);

  // resolveSummaryCapacity with { singleTarget: true }: resolves only primary and stores singleTarget: true
  resolvedCalls.length = 0;
  const singleCap = await resolveSummaryCapacity(ctx, chain, config, undefined, { singleTarget: true });
  assert.equal(singleCap.targets.length, 1);
  assert.equal(singleCap.singleTarget, true);
  assert.deepEqual(resolvedCalls, ['big/primary-1m']);
  assert.equal(capacityLimit(singleCap), primaryOnlyFromMulti);

  // planSummaryRange with { singleTarget: true } on multi-target capacity uses 1M primary instead of clamping to 32k fallback
  const fSpan = makeMockSession();
  fSpan.addSystem('System.');
  const aBig = fSpan.addAssistant('report-payload '.repeat(2500)); // ~37.5KB > clamped 32k fallback limit (~11.9KB), < 1M primary limit
  const spanRange = { start: aBig.seq, end: aBig.seq };
  assert.throws(
    () => planSummaryRange(fSpan.session, spanRange, multiCap),
    (err) => err.code === 'SUMMARY_GROUP_TOO_LARGE',
  );
  const singlePlanned = planSummaryRange(fSpan.session, spanRange, multiCap, { singleTarget: true });
  assert.equal(singlePlanned.end, spanRange.end);
  assert.equal(singlePlanned.limited, false);
});

// 5. planSummaryRange optional maxToolSourceRefs / boundedWave chunk cap
await test('summary-budget-max-tool-source-refs-caps-chunk', () => {
  const f = makeMockSession();
  f.addSystem('System.');
  const u0 = f.addUser('Start investigation.');
  const turns = [];
  for (let t = 0; t < 5; t += 1) {
    turns.push(f.addToolTurn(`turn-${t} ` + 'data '.repeat(600), { callId: `tool-${t}`, extraSources: 10 }));
    f.addAssistant(`Analyzed turn ${t}.`);
  }
  const range = { start: u0.seq, end: f.surface.nodes.at(-1) };
  const hugeCapacity = {
    targets: [
      {
        provider: 'p',
        model: 'm',
        key: JSON.stringify(['p', 'm']),
        window: 1_000_000,
        output: 4096,
        margin: 4096,
        inputRatio: 0.8,
        maxInputBytes: 2_000_000,
        scale: 1,
      },
    ],
    shrinkLimit: Infinity,
  };

  // Without maxToolSourceRefs: fits entire 5-turn span
  const full = planSummaryRange(f.session, range, hugeCapacity);
  assert.equal(full.end, range.end);
  assert.equal(full.limited, false);

  // With maxToolSourceRefs: 25 -> caps after turn 2 (20 refs <= 25; turn 3 would push to 30 > 25)
  const capped = planSummaryRange(f.session, range, hugeCapacity, { maxToolSourceRefs: 25 });
  assert.equal(capped.limited, true);
  assert.ok(capped.toolSourceRefs <= 25);
  assert.equal(capped.toolSourceRefs, 20);
  assert.equal(capped.maxToolSourceRefs, 25);
  assert.ok(capped.end < range.end);

  // When even first group exceeds maxToolSourceRefs: throws SUMMARY_GROUP_TOO_LARGE
  const fBigFirst = makeMockSession();
  fBigFirst.addSystem('System.');
  const firstTool = fBigFirst.addToolTurn('huge '.repeat(500), { callId: 'huge-first', extraSources: 20 });
  assert.throws(
    () =>
      planSummaryRange(
        fBigFirst.session,
        { start: firstTool.assistantEvent.seq, end: firstTool.resEvent.seq },
        hugeCapacity,
        { maxToolSourceRefs: 10 },
      ),
    (err) =>
      err.code === 'SUMMARY_GROUP_TOO_LARGE' &&
      err.requiredToolSourceRefs === 20 &&
      err.maxToolSourceRefs === 10,
  );

  // boundedWave: true uses DEFAULT_MAX_CHUNK_TOOL_SOURCE_REFS (3072)
  assert.equal(DEFAULT_MAX_CHUNK_TOOL_SOURCE_REFS, 3072);
  const fWave = makeMockSession();
  fWave.addSystem('System.');
  const wStart = fWave.addUser('Wave test.');
  for (let i = 0; i < 4; i += 1) {
    fWave.addToolTurn(`wave-${i} ` + 'payload '.repeat(300), { callId: `w-${i}`, extraSources: 1000 });
    fWave.addAssistant(`Done wave ${i}.`);
  }
  const wavePlan = planSummaryRange(
    fWave.session,
    { start: wStart.seq, end: fWave.surface.nodes.at(-1) },
    hugeCapacity,
    { boundedWave: true },
  );
  assert.equal(wavePlan.limited, true);
  assert.equal(wavePlan.maxToolSourceRefs, DEFAULT_MAX_CHUNK_TOOL_SOURCE_REFS);
  assert.equal(wavePlan.toolSourceRefs, 3000);
});

// 6. Throttled summary.js onProgress telemetry — strictly metadata only, zero draft text
await test('summary-stream-onProgress-throttled-and-zero-draft-text', async () => {
  const SECRET_DRAFT = 'SECRET_DRAFT_SENTINEL_DO_NOT_LEAK_98765';
  const SECRET_REASONING = 'SECRET_REASONING_SENTINEL_DO_NOT_LEAK_12345';
  const ALLOWED_KEYS = ['attempt', 'chunks', 'firstChunkMs', 'idleMs', 'maxAttempts', 'model', 'reasoningChars', 'textChars'];

  const events = [];
  const ctx = {
    llm: {
      async *stream() {
        yield { type: 'reasoning-delta', index: 0, text: SECRET_REASONING };
        for (let i = 0; i < 25; i += 1) {
          yield { type: 'text-delta', index: 1, text: `${SECRET_DRAFT}-${i}\n` };
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
        yield { type: 'text-delta', index: 1, text: 'FINAL_PIECE' };
        yield { type: 'finish', kind: 'stop' };
      },
    },
  };

  const result = await summarizeWithTarget({
    ctx,
    agent: {},
    input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize this.' }] }] },
    target: { provider: 'demo', model: 'fast-1m' },
    options: {
      maxTokens: 1024,
      timeoutMs: 5000,
      language: 'en',
      attempt: 2,
      maxAttempts: 4,
      progressThrottleMs: 30,
      onProgress: (info) => events.push(info),
    },
    signal: new AbortController().signal,
  });

  assert.ok(result.rawText.includes(SECRET_DRAFT));
  assert.ok(events.length >= 3, `expected start + first-chunk + throttled/end updates, got ${events.length}`);
  assert.ok(events.length < 15, `expected throttling to coalesce burst of 27 chunks, got ${events.length} events`);

  for (const ev of events) {
    assert.deepEqual(Object.keys(ev).sort(), ALLOWED_KEYS);
    assert.equal(ev.model, 'demo/fast-1m');
    assert.equal(ev.attempt, 2);
    assert.equal(ev.maxAttempts, 4);
  }
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes(SECRET_DRAFT), 'draft text must NEVER leak in onProgress telemetry');
  assert.ok(!serialized.includes(SECRET_REASONING), 'reasoning text must NEVER leak in onProgress telemetry');
  assert.ok(!serialized.includes('FINAL_PIECE'));

  const finalEvent = events.at(-1);
  assert.equal(finalEvent.chunks, 28); // 1 reasoning + 25 text + 1 FINAL_PIECE + 1 finish
  assert.equal(finalEvent.reasoningChars, SECRET_REASONING.length);
  assert.ok(finalEvent.textChars > SECRET_DRAFT.length * 25);
  assert.ok(typeof finalEvent.firstChunkMs === 'number' && finalEvent.firstChunkMs >= 0);

  // Verify summarizeWithChain passes attempt & maxAttempts across retries and survives throwing onProgress
  const chainAttempts = [];
  let streamCall = 0;
  const retryCtx = {
    llm: {
      async *stream() {
        streamCall += 1;
        yield { type: 'text-delta', text: streamCall === 1 ? 'bad' : 'accepted' };
        yield { type: 'finish', kind: 'stop' };
      },
    },
  };
  const chainRes = await summarizeWithChain({
    ctx: retryCtx,
    agent: {},
    input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
    chain: { targets: [{ provider: 'p', model: 'm' }], source: 'config' },
    options: {
      maxTokens: 512,
      timeoutMs: 5000,
      retryCount: 2,
      retryDelayMs: 0,
      language: 'en',
      validate: (r) => (r.rawText === 'accepted' ? { ok: true } : { ok: false, code: 'SUMMARY_INVALID', message: 'retry' }),
      onProgress: (ev) => {
        chainAttempts.push([ev.attempt, ev.maxAttempts]);
        if (ev.chunks === 1) throw new Error('telemetry sink failure must be ignored');
      },
    },
    signal: new AbortController().signal,
  });
  assert.equal(chainRes.rawText, 'accepted');
  assert.ok(chainAttempts.some(([a, m]) => a === 1 && m === 3));
  assert.ok(chainAttempts.some(([a, m]) => a === 2 && m === 3));

  // Verify omitting onProgress is a complete no-op
  const silentRes = await summarizeWithTarget({
    ctx: retryCtx,
    agent: {},
    input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
    target: { provider: 'p', model: 'm' },
    options: { maxTokens: 512, timeoutMs: 5000, language: 'en' },
    signal: new AbortController().signal,
  });
  assert.equal(silentRes.rawText, 'accepted');
});

// 7. continuation sourcePages guards string/null content and deduplicates repeated <system-reminder>
await test('continuation-guards-content-and-dedupes-system-reminders', () => {
  const f = makeMockSession();
  f.addSystem('System.');
  const repeatedReminder = `<system-reminder>\nInstructions from: AGENTS.md\n${'Rule line for project coding conventions.\n'.repeat(120)}</system-reminder>`;
  const u1 = f.addUser(`${repeatedReminder}\nFirst real user task.`);
  const u2 = f.addUser(`${repeatedReminder}\nSecond real user task.`);
  const u3 = f.addUser(`${repeatedReminder}\nThird real user task.`);
  const u4 = f.session.append(
    'user/message',
    { id: randomUUID(), role: 'user', content: 'Plain string user content.', source: { kind: 'user' } },
    { surfaceOp: 'append' },
  );
  const u5 = f.session.append(
    'user/message',
    {
      id: randomUUID(),
      role: 'user',
      content: [null, undefined, { type: 'text', text: 'After null blocks.' }],
      source: { kind: 'user' },
    },
    { surfaceOp: 'append' },
  );
  // Tool result containing literal <system-reminder> must NOT be deduplicated/mutated
  const tool1 = f.addToolTurn(`${repeatedReminder}\nraw tool output`, { callId: 'tool-rem' });

  const seqs = [u1.seq, u2.seq, u3.seq, u4.seq, u5.seq, tool1.resEvent.seq];
  const pages = sourcePages(f.session, seqs, 10000);
  const joined = pages.join('\n');

  assert.ok(joined.includes('First real user task.'));
  assert.ok(joined.includes('Second real user task.'));
  assert.ok(joined.includes('Third real user task.'));
  assert.ok(joined.includes('Plain string user content.'));
  assert.ok(joined.includes('After null blocks.'));
  assert.ok(joined.includes(`Repeated system-reminder; identical content at seq ${u1.seq}`));
  assert.ok(joined.includes('raw tool output'));

  // Without deduplication, 3 user copies + 1 tool copy of 5KB reminder = ~20KB;
  // deduplicating u2 and u3 removes ~10KB of duplicate reminder text.
  const repeatedCount = (joined.match(/Repeated system-reminder; identical content/g) ?? []).length;
  assert.equal(repeatedCount, 2);
});

// 8. selectContinuationWave bounds pages & tool-source refs + pre-LLM check in prepareContinuation
await test('continuation-select-wave-and-pre-llm-ref-check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-oversize-wave-'));
  try {
    assert.equal(DEFAULT_CONTINUATION_WAVE_TOOL_SOURCE_REFS, 3072);

    // 8a. Ref-bounded wave selection
    const f = makeMockSession();
    f.addSystem('System.');
    const u0 = f.addUser('Begin wave audit.');
    for (let i = 0; i < 6; i += 1) {
      f.addToolTurn(`turn-${i} ` + 'x'.repeat(400), { callId: `wave-c-${i}`, extraSources: 20 });
      f.addAssistant(`Summary of turn ${i}.`);
    }

    const waveByRefs = selectContinuationWave(f.session, {
      pageLimit: 20000,
      maxPages: 32,
      maxToolSourceRefs: 45,
    });
    assert.ok(waveByRefs);
    assert.equal(waveByRefs.start, u0.seq);
    assert.equal(waveByRefs.limited, true);
    assert.equal(waveByRefs.toolSourceRefs, 40);
    assert.ok(waveByRefs.remainingCount > 0);

    // 8b. Page-bounded wave selection (both explicit pageLimit and policy+capacity exact refinement)
    const waveByPages = selectContinuationWave(f.session, {
      pageLimit: 1200,
      maxPages: 2,
      maxToolSourceRefs: 3072,
    });
    assert.ok(waveByPages);
    assert.equal(waveByPages.limited, true);
    assert.ok(waveByPages.pages <= 2);
    assert.ok(waveByPages.seqs.length < f.surface.nodes.length - 1);

    const wavePolicy = resolveConfig({
      archiveEnabled: true,
      maxSummaryChunks: 2,
      summaryInputMaxBytes: 30000,
      continuationMemoryBytes: 4096,
      summaryRetryCount: 0,
      summaryRetryDelayMs: 0,
    }).config;
    const waveCap = {
      targets: [
        {
          provider: 'p',
          model: 'm',
          key: JSON.stringify(['p', 'm']),
          window: 1_000_000,
          output: 4096,
          margin: 0,
          inputRatio: 1,
          maxInputBytes: 30000,
          scale: 1,
        },
      ],
      shrinkLimit: Infinity,
    };
    const fBigPages = makeMockSession();
    fBigPages.addSystem('System.');
    fBigPages.addUser('Preserve exact rule: timeout must be 35 seconds.');
    for (let i = 0; i < 6; i += 1) {
      fBigPages.addAssistant(`section-${i} ` + 'detail-record '.repeat(600));
    }
    const exactWave = selectContinuationWave(fBigPages.session, {
      policy: wavePolicy,
      capacity: waveCap,
    });
    assert.ok(exactWave);
    assert.equal(exactWave.limited, true);
    assert.ok(exactWave.pages <= 2);
    assert.ok(exactWave.remainingCount > 0);

    // 8c. Pre-LLM historySourceSeqs ref-count check in prepareContinuation (>4096 refs fails with 0 LLM calls!)
    const fOver = makeMockSession();
    fOver.addSystem('System.');
    fOver.addUser('Do not burn LLM calls when refs exceed 4096.');
    for (let i = 0; i < 5; i += 1) {
      fOver.addToolTurn(`heavy-${i}`, { callId: `over-${i}`, extraSources: 900 });
    }
    let llmCalls = 0;
    const ctx = {
      llm: {
        async *stream() {
          llmCalls += 1;
          yield { type: 'text-delta', text: 'should never run' };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    };
    const policy = resolveConfig({
      archiveEnabled: true,
      maxSummaryChunks: 32,
      summaryInputMaxBytes: 100000,
      summaryRetryCount: 0,
      summaryRetryDelayMs: 0,
    }).config;
    const capacity = {
      targets: [
        {
          provider: 'p',
          model: 'm',
          key: JSON.stringify(['p', 'm']),
          window: 1_000_000,
          output: 4096,
          margin: 4096,
          inputRatio: 0.8,
          maxInputBytes: 100000,
          scale: 1,
        },
      ],
      shrinkLimit: Infinity,
    };

    await assert.rejects(
      prepareContinuation({
        ctx,
        agent: { session: fOver.session },
        session: fOver.session,
        seqs: fOver.surface.nodes.slice(1),
        policy,
        capacity,
        chain: { targets: [{ provider: 'p', model: 'm' }], source: 'config' },
        compactionId: 'weave-preflight-over-refs',
        signal: new AbortController().signal,
        archiveRoot: join(root, 'archive'),
      }),
      (err) =>
        err.code === 'ARCHIVE_SOURCE_INVALID' &&
        err.requiredToolSourceRefs > MAX_TOOL_SOURCE_EVENTS &&
        err.maxToolSourceRefs === MAX_TOOL_SOURCE_EVENTS,
    );
    assert.equal(llmCalls, 0, 'prepareContinuation MUST reject >4096 tool-source refs BEFORE any LLM call');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 9. Intermediate-page validateProgressFacts scoping vs strict final-page enforcement
await test('continuation-intermediate-page-progress-scoping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-oversize-prog-'));
  try {
    const f = makeMockSession();
    f.addUser('Keep tracking build progress carefully.');
    // Page 1 content: tasksCompleted: 1 + large filler so it spans multiple pages
    f.addAssistant('Initial progress report: tasksCompleted: 1\n' + 'early-log-entry '.repeat(2200));
    // Page 2+ content: updated progress tasksCompleted: 5
    f.addAssistant('Final progress report: tasksCompleted: 5\n' + 'later-log-entry '.repeat(2200));

    const intermediateNotes =
      '## Goal\nKeep tracking build progress carefully.\n## State\nCurrent progress: tasksCompleted: 1.\n## Next\nContinue remaining tasks.\n## Uncertain\nLater pages not yet read.';
    const finalNotes =
      '## Goal\nKeep tracking build progress carefully.\n## State\nCurrent progress: tasksCompleted: 5.\n## Next\nReview completed build.\n## Uncertain\nRuntime deployment pending.';

    const calls = [];
    const progressEvents = [];
    const ctx = {
      llm: {
        async *stream(options) {
          calls.push(options);
          const text = calls.length === 1 ? intermediateNotes : finalNotes;
          yield { type: 'text-delta', text };
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    };
    const policy = resolveConfig({
      archiveEnabled: true,
      maxSummaryChunks: 32,
      summaryInputMaxBytes: 42000,
      continuationMemoryBytes: 4096,
      summaryRetryCount: 0,
      summaryRetryDelayMs: 0,
    }).config;
    const capacity = {
      targets: [
        {
          provider: 'p',
          model: 'm',
          key: JSON.stringify(['p', 'm']),
          window: 1_000_000,
          output: 4096,
          margin: 0,
          inputRatio: 1,
          maxInputBytes: 42000,
          scale: 1,
        },
      ],
      shrinkLimit: Infinity,
    };

    const result = await prepareContinuation({
      ctx,
      agent: { session: f.session },
      session: f.session,
      seqs: f.surface.nodes.slice(),
      policy,
      capacity,
      chain: { targets: [{ provider: 'p', model: 'm' }], source: 'config' },
      compactionId: 'weave-scoped-progress',
      signal: new AbortController().signal,
      archiveRoot: join(root, 'archive'),
      progressThrottleMs: 0,
      onProgress: (ev) => progressEvents.push(ev),
    });

    assert.ok(result.summarized.continuation.pages.length >= 2, 'test fixture must span at least 2 pages');
    assert.equal(calls.length, result.summarized.continuation.pages.length, 'page 1 must not be rejected by global progress check');
    assert.ok(result.summarized.summary[0].text.includes('tasksCompleted: 5'));

    // Verify continuation onProgress telemetry shape and zero draft leakage
    assert.ok(progressEvents.length >= 2);
    assert.ok(progressEvents.every((ev) => ev.phase === 'continuing'));
    assert.ok(progressEvents.some((ev) => ev.pageIndex === 1 && ev.pageTotal === result.summarized.continuation.pages.length));
    assert.ok(progressEvents.some((ev) => ev.pageIndex === result.summarized.continuation.pages.length));
    assert.ok(!JSON.stringify(progressEvents).includes('tasksCompleted'));
    assert.ok(!JSON.stringify(progressEvents).includes('early-log-entry'));

    // Verify resuming after page 1 (with intermediate tasksCompleted: 1 saved) succeeds cleanly
    let resumeCalls = 0;
    const resumeCtx = {
      llm: {
        async *stream() {
          resumeCalls += 1;
          if (resumeCalls === 1) {
            yield { type: 'text-delta', text: intermediateNotes };
            yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
            yield { type: 'finish', kind: 'stop' };
            return;
          }
          if (resumeCalls === 2) {
            throw Object.assign(new Error('transient timeout on page 2'), { code: 'SUMMARY_TIMEOUT' });
          }
          yield { type: 'text-delta', text: finalNotes };
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    };
    const resumeArchive = join(root, 'resume', 'archive');
    await assert.rejects(
      prepareContinuation({
        ctx: resumeCtx,
        agent: { session: f.session },
        session: f.session,
        seqs: f.surface.nodes.slice(),
        policy,
        capacity,
        chain: { targets: [{ provider: 'p', model: 'm' }], source: 'config' },
        compactionId: 'weave-resume-mid-1',
        signal: new AbortController().signal,
        archiveRoot: resumeArchive,
      }),
      (err) => err.code === 'SUMMARY_TIMEOUT',
    );
    const resumed = await prepareContinuation({
      ctx: resumeCtx,
      agent: { session: f.session },
      session: f.session,
      seqs: f.surface.nodes.slice(),
      policy,
      capacity,
      chain: { targets: [{ provider: 'p', model: 'm' }], source: 'config' },
      compactionId: 'weave-resume-mid-2',
      signal: new AbortController().signal,
      archiveRoot: resumeArchive,
    });
    assert.equal(resumed.summarized.continuation.resumedPages, 1);
    assert.ok(resumed.summarized.summary[0].text.includes('tasksCompleted: 5'));

    // Now verify that if the FINAL page still reports stale tasksCompleted: 1, it IS rejected with PROGRESS_FACT_CONFLICT
    const staleCtx = {
      llm: {
        async *stream() {
          yield { type: 'text-delta', text: intermediateNotes };
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    };
    await assert.rejects(
      prepareContinuation({
        ctx: staleCtx,
        agent: { session: f.session },
        session: f.session,
        seqs: f.surface.nodes.slice(),
        policy,
        capacity,
        chain: { targets: [{ provider: 'p', model: 'm' }], source: 'config' },
        compactionId: 'weave-stale-final-progress',
        signal: new AbortController().signal,
        archiveRoot: join(root, 'stale', 'archive'),
      }),
      (err) => err.code === 'PROGRESS_FACT_CONFLICT',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 10. Continuation auditBlockOnLoss / auditEnabled parity with strict polarity & provenance
await test('continuation-audit-parity-keeps-polarity-and-provenance-strict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-oversize-audit-'));
  try {
    const runWith = async ({ userText, modelText, auditEnabled = true, auditBlockOnLoss = true }) => {
      const f = makeMockSession();
      f.addUser(userText);
      f.addAssistant('notes '.repeat(100));
      const policy = resolveConfig({
        archiveEnabled: true,
        auditEnabled,
        auditBlockOnLoss,
        maxSummaryChunks: 32,
        summaryInputMaxBytes: 60000,
        continuationMemoryBytes: 4096,
        summaryRetryCount: 0,
        summaryRetryDelayMs: 0,
      }).config;
      const capacity = {
        targets: [
          {
            provider: 'p',
            model: 'm',
            key: JSON.stringify(['p', 'm']),
            window: 1_000_000,
            output: 4096,
            margin: 0,
            inputRatio: 1,
            maxInputBytes: 60000,
            scale: 1,
          },
        ],
        shrinkLimit: Infinity,
      };
      const ctx = {
        llm: {
          async *stream() {
            yield { type: 'text-delta', text: modelText };
            yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 } };
            yield { type: 'finish', kind: 'stop' };
          },
        },
      };
      return prepareContinuation({
        ctx,
        agent: { session: f.session },
        session: f.session,
        seqs: f.surface.nodes.slice(),
        policy,
        capacity,
        chain: { targets: [{ provider: 'p', model: 'm' }], source: 'config' },
        compactionId: `weave-audit-${randomUUID()}`,
        signal: new AbortController().signal,
        archiveRoot: join(root, 'archive-' + randomUUID()),
      });
    };

    // Value mismatch (non-polarity, non-provenance): allowed when auditBlockOnLoss: false
    const valueMismatchNotes =
      '## Goal\nTune service configuration.\n## State\nTimeout must be 55 seconds.\n## Next\nVerify timeout behavior.\n## Uncertain\nProduction load unmeasured.';
    const relaxed = await runWith({
      userText: 'Timeout must be 35 seconds.',
      modelText: valueMismatchNotes,
      auditBlockOnLoss: false,
    });
    assert.ok(relaxed.summarized);

    // Polarity flip: STILL rejected even when auditEnabled: false AND auditBlockOnLoss: false
    const polarityFlipNotes =
      '## Goal\nMaintain database.\n## State\nDatabase is ready.\n## Next\n可以写库。\n## Uncertain\nNone pending.';
    await assert.rejects(
      runWith({
        userText: '不要写库。\n未经审批不要写库。',
        modelText: polarityFlipNotes,
        auditEnabled: false,
        auditBlockOnLoss: false,
      }),
      (err) => err.code === 'CONSTRAINT_POLARITY_LOST',
    );

    // Provenance laundering (unbacked user approval claim): STILL rejected even when auditEnabled: false & auditBlockOnLoss: false
    const launderedApprovalNotes =
      '## Goal\nClean staging files.\n## State\nThe user has approved deleting production tables.\n## Next\nRun cleanup.\n## Uncertain\nNone.';
    await assert.rejects(
      runWith({
        userText: 'Inspect staging tables only.',
        modelText: launderedApprovalNotes,
        auditEnabled: false,
        auditBlockOnLoss: false,
      }),
      (err) => err.code === 'CONSTRAINT_LOST',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 11. history-source.js allowForeignFallback opt-in vs strict default
await test('history-source-allowForeignFallback-opt-in-vs-strict-default', () => {
  // 11a. Valid chain keeps exact { selected, sources } return shape in strict default
  const validEvents = [
    { seq: 0, type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{}' } },
    {
      seq: 1,
      type: 'tool/result',
      sourceEventSeqs: [0],
      data: { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } },
    },
  ];
  const validSession = { eventAt: (s) => validEvents[s] };
  assert.deepEqual(historySourceSeqs(validSession, [1]), { selected: [1], sources: [0] });

  // 11b. Foreign chain with dangling seq, wrong target type, and valid seq
  const mixedEvents = [
    { seq: 0, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { seq: 1, type: 'tool/call', data: { callId: 'c-mix', name: 'bash', arguments: '{}' } },
    {
      seq: 2,
      type: 'tool/result',
      sourceEventSeqs: [999, 0, 1],
      data: { message: { role: 'tool', toolCallId: 'c-mix', content: [{ type: 'text', text: 'res' }] } },
    },
  ];
  const mixedSession = { eventAt: (s) => mixedEvents[s] };
  assert.throws(() => historySourceSeqs(mixedSession, [2]));
  assert.deepEqual(historySourceSeqs(mixedSession, [2], { allowForeignFallback: true }), {
    selected: [2],
    sources: [1],
  });

  // 11c. Over-budget (>4096) foreign tool/result chain
  const overCount = MAX_TOOL_SOURCE_EVENTS + 100;
  const overEvents = [];
  for (let i = 0; i < overCount; i += 1) {
    overEvents.push({
      seq: i,
      type: 'tool/result',
      data: { message: { role: 'tool', toolCallId: 'c-over', content: [{ type: 'text', text: 'x' }] } },
    });
  }
  overEvents.push({
    seq: overCount,
    type: 'tool/result',
    sourceEventSeqs: Array.from({ length: overCount }, (_, i) => i),
    data: { message: { role: 'tool', toolCallId: 'c-over', content: [{ type: 'text', text: 'root' }] } },
  });
  const overSession = { eventAt: (s) => overEvents[s] };
  assert.throws(() => historySourceSeqs(overSession, [overCount]), (e) => e.code === 'ARCHIVE_SOURCE_INVALID');
  assert.equal(inspectToolSourceBudget(overSession, [overCount]).ok, false);

  const truncated = historySourceSeqs(overSession, [overCount], { allowForeignFallback: true });
  assert.deepEqual(truncated.selected, [overCount]);
  assert.equal(truncated.sources.length, MAX_TOOL_SOURCE_EVENTS);
  const fallbackBudget = inspectToolSourceBudget(overSession, [overCount], { allowForeignFallback: true });
  assert.equal(fallbackBudget.ok, true);
  assert.equal(fallbackBudget.refs, MAX_TOOL_SOURCE_EVENTS);
  assert.equal(fallbackBudget.fallback, true);

  // 11d. Over-depth (>64) foreign chain
  const depthLen = MAX_TOOL_SOURCE_DEPTH + 10;
  const deepEvents = [
    { seq: 0, type: 'tool/call', data: { callId: 'c-deep', name: 'bash', arguments: '{}' } },
  ];
  for (let i = 1; i <= depthLen; i += 1) {
    deepEvents.push({
      seq: i,
      type: 'tool/result',
      sourceEventSeqs: [i - 1],
      data: { message: { role: 'tool', toolCallId: 'c-deep', content: [{ type: 'text', text: `d${i}` }] } },
    });
  }
  const deepSession = { eventAt: (s) => deepEvents[s] };
  assert.throws(() => historySourceSeqs(deepSession, [depthLen]), (e) => e.code === 'ARCHIVE_SOURCE_INVALID');
  const deepFallback = historySourceSeqs(deepSession, [depthLen], { allowForeignFallback: true });
  assert.deepEqual(deepFallback.selected, [depthLen]);
  assert.equal(deepFallback.sources.length, MAX_TOOL_SOURCE_DEPTH);
});

// 12. attachments.js allowForeignFallback opt-in vs strict default
await test('attachments-allowForeignFallback-opt-in-vs-strict-default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-oversize-att-'));
  try {
    const payload = Buffer.from('verified binary payload');
    const validHash = createHash('sha256').update(payload).digest('hex');
    const validRef = { attachmentId: `sha256:${validHash}`, bytes: payload.length };
    const missingHash = createHash('sha256').update('missing-blob').digest('hex');
    const missingRef = { attachmentId: `sha256:${missingHash}`, bytes: 12 };

    const entries = [
      {
        blocks: [
          { type: 'image', attachment: { attachmentId: 'foreign-placeholder-img' } },
          { type: 'file', url: 'https://example.invalid/doc.pdf' },
          { type: 'image', attachment: validRef },
          { type: 'file', attachment: missingRef },
        ],
      },
    ];

    // Strict default throws on non-sha256 placeholder
    assert.throws(() => attachmentReferences(entries), /verified host content address/);
    await assert.rejects(
      preserveAttachments(root, entries, null, new AbortController().signal),
      /verified host content address/,
    );

    // Opt-in allowForeignFallback skips non-sha256 placeholders while keeping valid sha256 refs
    const refs = attachmentReferences(entries, { allowForeignFallback: true });
    assert.equal(refs.length, 2);
    assert.deepEqual(
      refs.map((r) => r.ref.attachmentId),
      [validRef.attachmentId, missingRef.attachmentId],
    );

    // Opt-in preserveAttachments with no provider skips cleanly instead of throwing
    const noProviderResult = await preserveAttachments(
      root,
      entries,
      null,
      new AbortController().signal,
      { allowForeignFallback: true },
    );
    assert.deepEqual(noProviderResult, []);

    // Opt-in preserveAttachments with partial provider preserves valid blob and skips missing blob
    const partialProvider = {
      async readImage(ref) {
        if (ref.attachmentId === validRef.attachmentId) return { data: payload };
        throw new Error('blob missing in foreign store');
      },
      async *readFileStream() {
        throw new Error('blob missing in foreign store');
      },
    };
    const partialResult = await preserveAttachments(
      root,
      entries,
      partialProvider,
      new AbortController().signal,
      { allowForeignFallback: true },
    );
    assert.deepEqual(partialResult, [{ type: 'image', attachmentId: validRef.attachmentId, bytes: payload.length }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const passed = rows.filter((r) => r.pass).length;
const failed = rows.filter((r) => !r.pass).length;
console.log(JSON.stringify({ passed, failed, results: rows }, null, 2));
if (failed > 0) process.exitCode = 1;
