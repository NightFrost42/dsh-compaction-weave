import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { WeaveCompactionEngine } from '../lib/engine.js';
import { apply as mountGate, SUMMARY_RPC_PATH } from '../lib/index.js';
import { resolveConfig } from '../lib/config.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { buildCompactionInstruction } from '../lib/prompt.js';
import { OBSERVATION_MASK_MARKER } from '../lib/observation-mask.js';
import { PLUGIN_VERSION } from '../lib/version.js';
import { MAX_BODY_BYTES, handleSummaryConfigRpc } from '../lib/summary-config.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error?.message ?? String(error), stack: error?.stack });
  }
}

const HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeSummary(goalLine = 'Keep integer cents.', extraLine = 'Proceed safely.') {
  return HEADINGS.map((h, idx) => {
    if (idx === 5) return `${h}\n[filled by engine]`;
    if (idx === 0) return `${h}\n${goalLine}`;
    if (idx === 8) return `${h}\n${extraLine}`;
    return `${h}\nEvidence archived; continuing task.`;
  }).join('\n\n');
}

const CONT_NOTES =
  '## Goal\nKeep integer cents.\n## State\nEvidence archived cleanly.\n## Next\nContinue verification.\n## Uncertain\nLive runtime not executed.';

function createEngineFixture({
  extraConfig = {},
  headerTarget = { provider: 'p', model: 'm', reasoningEffort: 'high' },
  windowTokens = 200000,
  thresholdRatio = 0.8,
  streamHandler,
} = {}) {
  const baseTmp = process.env.WEAVE_TEST_ROOT ?? tmpdir();
  const root = join(baseTmp, `weave-billing-${randomUUID()}`);
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const calls = [];
  const hooks = new Map();
  const waterfallHooks = new Map();
  const waterfalls = [];
  const provided = new Map();

  const session = {
    id: `sess-${randomUUID()}`,
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => events,
    requestHeader: () => ({ config: headerTarget }),
    toolHistory: () => [],
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (event.type === 'assistant/message') return event.data.message;
      if (event.type === 'tool/result') {
        const msg = event.data.message;
        return {
          role: 'tool',
          toolCallId: msg.toolCallId,
          content: msg.content,
          ...(msg.isError ? { isError: true } : {}),
        };
      }
      if (event.type === 'system/message') return event.data.message;
      if (event.type === 'user/message') return event.data;
      return undefined;
    },
    append(type, data, options = {}) {
      const event = {
        seq: events.length,
        type,
        time: options.time ?? Date.now(),
        data,
        ...(Array.isArray(options.sourceEventSeqs) ? { sourceEventSeqs: [...options.sourceEventSeqs] } : {}),
      };
      events.push(event);
      const op = options.surfaceOp;
      if (op?.op === 'replace') {
        const start = surface.nodes.indexOf(op.startSeq);
        const end = surface.nodes.indexOf(op.endSeq);
        assert.ok(start >= 0 && end >= start, `Invalid replace span ${op.startSeq}..${op.endSeq}`);
        surface.nodes.splice(start, end - start + 1, event.seq);
        surface.replaceGeneration += 1;
      } else if (op === 'append' || op?.op === 'append') {
        surface.nodes.push(event.seq);
      }
      return event;
    },
  };

  const addSystem = (text, time) =>
    session.append(
      'system/message',
      { message: { id: randomUUID(), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } } },
      { surfaceOp: 'append', time },
    );

  const addUser = (text, kind = 'user', time, explicitId) =>
    session.append(
      'user/message',
      { id: explicitId ?? randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind } },
      { surfaceOp: 'append', time },
    );

  const addAssistant = (text, time) =>
    session.append(
      'assistant/message',
      { message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } } },
      { surfaceOp: 'append', time },
    );

  const addToolPair = (filePath, body, { isError = false, time } = {}) => {
    const callId = `call-${randomUUID()}`;
    const callEvent = session.append(
      'tool/call',
      { callId, name: 'read_file', arguments: JSON.stringify({ path: filePath, startLine: 1, endLine: 200 }) },
      { time },
    );
    const assistantCall = session.append(
      'assistant/message',
      {
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'tool-call', callId, toolName: 'read_file', args: { path: filePath } }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
      { surfaceOp: 'append', time },
    );
    const resultEvent = session.append(
      'tool/result',
      {
        message: {
          role: 'tool',
          toolCallId: callId,
          content: [{ type: 'text', text: body }],
          ...(isError ? { isError: true } : {}),
          source: { kind: 'tool-result', callId },
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq], time },
    );
    return { callEvent, assistantCall, resultEvent };
  };

  const measure = () => {
    const nodes = surface.nodes.map((seq) => ({
      seq,
      tokens: approxTokens(blocksToText(session.deriveEventMessage(events[seq])?.content)),
    }));
    return { nodes, totalTokens: nodes.reduce((sum, item) => sum + item.tokens, 0) };
  };

  const ctx = {
    on(name, fn) {
      if (name === 'compaction/summary-error') waterfallHooks.set(name, fn);
      else hooks.set(name, fn);
    },
    provide(name, value) {
      provided.set(name, value);
    },
    async waterfall(name, payload, fallback) {
      waterfalls.push({ name, payload });
      const handler = waterfallHooks.get(name);
      return handler ? await handler(payload, fallback) : fallback();
    },
    logger: { info() {}, warn() {} },
    sessions: { async flush() { return true; } },
    tokenMeter: { measure },
    llm: {
      async resolveModelInfo() {
        return { contextWindow: windowTokens };
      },
      async *stream(opts) {
        calls.push(opts);
        if (streamHandler) {
          const out = await streamHandler(opts, calls.length);
          if (out && typeof out === 'object' && out.error) throw out.error;
          const text = typeof out === 'string' ? out : makeSummary();
          yield { type: 'text-delta', text };
          yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 } };
          yield { type: 'finish', kind: 'stop' };
          return;
        }
        yield { type: 'text-delta', text: makeSummary() };
        yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 } };
        yield { type: 'finish', kind: 'stop' };
      },
    },
  };

  const config = resolveConfig({
    archiveDir: join(root, 'archive'),
    language: 'en',
    auto: true,
    windowFallback: windowTokens,
    thresholdRatio,
    maxTokens: 4096,
    headroomTokens: 4000,
    summaryInputMaxBytes: 120000,
    summaryRetryCount: 2,
    summaryRetryDelayMs: 0,
    failureThreshold: 3,
    ...extraConfig,
  }).config;

  const engine = new WeaveCompactionEngine(ctx, config);
  engine.historyToolsAvailable = true;
  const inbox = {
    nextStep: [],
    nextTurn: [],
    prepend(bucket, msg) {
      if (bucket === 'next-step') this.nextStep.unshift(msg);
      else this.nextTurn.unshift(msg);
    },
  };
  const agent = {
    session,
    inbox,
    options: { provider: headerTarget.provider, model: headerTarget.model },
    runMaintenance: (fn) => fn(new AbortController().signal),
  };

  return {
    root,
    events,
    surface,
    calls,
    hooks,
    waterfalls,
    session,
    inbox,
    agent,
    engine,
    measure,
    addSystem,
    addUser,
    addAssistant,
    addToolPair,
  };
}

// ── 1. Stage-1 Zero-LLM Observation Masking Money & Idempotency Guard ───────
await test('stage1-zero-llm-masking-saves-model-call-and-is-idempotent', async () => {
  const f = createEngineFixture({
    windowTokens: 60000,
    thresholdRatio: 0.8,
    extraConfig: {
      headroomTokens: 4000,
      minimumReductionRatio: 0.2,
      retainTokens: 200,
      observationMaskingEnabled: true,
      observationMaskThresholdChars: 4000,
    },
  });
  try {
    f.addSystem('Stable system rules.');
    f.addUser('Keep integer cents.');
    const bigBodyA = `HEADER-A\n${'LOG_LINE_SUCCESS '.repeat(2400)}\nTAIL-A`;
    const bigBodyB = `HEADER-B\n${'BUILD_TRACE_OK '.repeat(2400)}\nTAIL-B`;
    const errBody = `ERR-START\n${'STACK_TRACE_DETAIL '.repeat(400)}\nERR-END`;
    const pairA = f.addToolPair('logs/a.log', bigBodyA);
    const pairB = f.addToolPair('logs/b.log', bigBodyB);
    const pairErr = f.addToolPair('logs/err.log', errBody, { isError: true });
    f.addAssistant('Recent answer kept in tail.');
    // Ensure measurement crosses thresholdTokens = min(48000, 60000 - 4096 - 4000) = 48000 tokens
    // Push more oversized logs if needed so totalTokens >= 48000.
    let guard = 0;
    while (f.measure().totalTokens < 49000 && guard++ < 10) {
      f.addToolPair(`logs/extra-${guard}.log`, `EX-${guard}\n${'TRACE_ROW '.repeat(2200)}\nEND-${guard}`);
    }
    const before = f.measure();
    assert.ok(before.totalTokens >= 48000);
    f.session.append('turn/start', { turn: 1 });

    const first = await f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal);
    assert.ok(first?.mode === 'observation-mask', `expected Stage 1 masking, got ${JSON.stringify(first)}`);
    assert.equal(f.calls.length, 0, 'Stage 1 must spend ZERO LLM calls when target reached');

    const after = f.measure();
    assert.ok(after.totalTokens < 48000 * 0.5, `expected huge drop, got ${after.totalTokens}`);

    // Verify original raw bytes of pairA & pairB are intact in archive, while error output remained unmasked.
    const span = await f.engine.archive.readSpan(f.session.id, first.compactionId);
    assert.equal(span.ok, true);
    const archivedA = span.entries.find((e) => e.seq === pairA.resultEvent.seq);
    const archivedB = span.entries.find((e) => e.seq === pairB.resultEvent.seq);
    assert.ok(archivedA && archivedA.text.includes('HEADER-A') && archivedA.text.includes('TAIL-A'));
    assert.ok(archivedB && archivedB.text.includes('HEADER-B') && archivedB.text.includes('TAIL-B'));
    assert.ok(f.surface.nodes.includes(pairErr.resultEvent.seq), 'error tool/result must NOT be masked');

    // Second pressure check at same surface: zero LLM calls, zero surface changes (idempotent).
    const genAfterFirst = f.surface.replaceGeneration;
    const second = await f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal);
    assert.equal(second, null);
    assert.equal(f.calls.length, 0);
    assert.equal(f.surface.replaceGeneration, genAfterFirst);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

await test('stage1-skips-surface-mutation-when-savings-alone-cannot-reach-target', async () => {
  const f = createEngineFixture({
    windowTokens: 200000,
    thresholdRatio: 0.8,
    extraConfig: {
      headroomTokens: 4000,
      summaryInputRatio: 1.0,
      summaryInputMaxBytes: 800000,
      maxSummaryChunks: 8,
      minimumReductionRatio: 0.2,
      retainTokens: 200,
      observationMaskingEnabled: true,
      observationMaskThresholdChars: 4000,
    },
  });
  try {
    f.addSystem('Stable system.');
    f.addUser('Keep integer cents.');
    // One moderate maskable tool result (~1,400 tokens) + several balanced turns (~165k tokens total).
    // Masking the tool result alone (~1,400 tokens) cannot achieve the 20% reduction target (~33k tokens),
    // so Stage 1 must NOT dirty the surface before Stage 2 runs (preserving verbatim KV prefix).
    const pair = f.addToolPair('small/trace.log', 'PREFIX\n' + 'OK_ROW '.repeat(800) + '\nSUFFIX');
    for (let i = 0; i < 46; i += 1) {
      f.addAssistant(`Turn ${i} analysis block sentence for context testing. `.repeat(280));
    }
    const genBefore = f.surface.replaceGeneration;
    while (f.measure().totalTokens < 165000) {
      f.addAssistant('Additional unmasked assistant commentary block. '.repeat(260));
    }
    f.addUser('Short recent question.');
    const tailReply = f.addAssistant('Short tail.');
    f.session.append('turn/start', { turn: 1 });

    const res = await f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal);
    assert.ok(res?.compactionId);
    assert.ok(f.calls.length >= 1);
    // Verify NO compaction/prune event was written prior to Stage 2
    assert.equal(f.events.some((e) => e.type === 'compaction/prune'), false, 'Stage 1 must not mutate prefix when insufficient');
    assert.equal(genBefore, 0);
    // And Stage 2 received the original unmasked tool result in its verbatim prefix!
    const sent = JSON.stringify(f.calls[0].messages.slice(0, -1));
    assert.ok(!sent.includes(OBSERVATION_MASK_MARKER));
    assert.ok(sent.includes('OK_ROW'));
    assert.ok(f.surface.nodes.includes(tailReply.seq));
    assert.ok(pair.resultEvent.seq < f.surface.nodes.at(-1));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ── 2. Same-Route preservePrefixCache Verbatim Invariance & Fallback Safety ─
await test('same-route-overflow-falls-back-cleanly-and-cross-route-strips-reasoning-controls', async () => {
  // (a) Same-route attempt 0 hits provider CONTEXT_WINDOW_EXCEEDED -> falls back to projected span without infinite loop.
  let overflowCount = 0;
  const f = createEngineFixture({
    extraConfig: { summaryInputMaxBytes: 120000, summaryRetryCount: 2 },
    streamHandler(opts) {
      if (overflowCount === 0 && !JSON.stringify(opts.messages).includes('External content omitted')) {
        overflowCount += 1;
        return { error: Object.assign(new Error('maximum context length exceeded'), { code: 'CONTEXT_WINDOW_EXCEEDED', status: 400 }) };
      }
      return makeSummary();
    },
  });
  try {
    f.addSystem('Stable system.');
    f.addReadPair = f.addToolPair;
    f.addToolPair('src/huge.js', 'const line = 1;\n'.repeat(1600)); // ~25 KB raw
    f.addUser('Keep integer cents.');
    f.addAssistant('Analysis complete. '.repeat(300));

    const res = await f.engine._compactRegionCore(f.surface.nodes[1], f.surface.nodes.at(-1), f.agent, new AbortController().signal, {
      manual: true,
      policy: f.engine.config,
    });
    assert.ok(res?.compactionId);
    assert.equal(overflowCount, 1);
    assert.equal(f.calls.length, 2, 'must overflow once on verbatim and succeed immediately on projected fallback');
    assert.ok(!JSON.stringify(f.calls[0].messages.slice(0, -1)).includes('External content omitted'));
    assert.match(JSON.stringify(f.calls[1].messages.slice(0, -1)), /External content omitted from working memory/);
    assert.equal(f.calls[0].reasoningEffort, 'low', 'same-route default summaryReasoningEffort="low" downgrades high effort');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }

  // (a2) Explicit summaryReasoningEffort="inherit" preserves primary reasoningEffort verbatim on same-route.
  const inheritFx = createEngineFixture({
    extraConfig: { summaryInputMaxBytes: 120000, summaryReasoningEffort: 'inherit' },
  });
  try {
    inheritFx.addSystem('Stable system.');
    inheritFx.addUser('Keep integer cents.');
    inheritFx.addAssistant('Details. '.repeat(300));
    await inheritFx.engine._compactRegionCore(inheritFx.surface.nodes[1], inheritFx.surface.nodes.at(-1), inheritFx.agent, new AbortController().signal, {
      manual: true,
      policy: inheritFx.engine.config,
    });
    assert.equal(inheritFx.calls.length, 1);
    assert.equal(inheritFx.calls[0].reasoningEffort, 'high', 'same-route with summaryReasoningEffort="inherit" preserves primary reasoningEffort');
  } finally {
    await rm(inheritFx.root, { recursive: true, force: true });
  }

  // (b) Cross-route summary model NEVER receives unsupported primary reasoningEffort and disables verbatim prefix.
  const cross = createEngineFixture({
    headerTarget: { provider: 'primary-p', model: 'primary-m', reasoningEffort: 'xhigh', temperature: 0.2 },
    extraConfig: {
      summarizationProvider: 'cheap-p',
      summarizationModel: 'cheap-m',
    },
  });
  try {
    cross.addSystem('Stable system.');
    cross.addToolPair('src/invoice.js', 'export const x = 1;\n'.repeat(50));
    cross.addUser('Keep integer cents.');
    cross.addAssistant('Details. '.repeat(300));

    await cross.engine._compactRegionCore(cross.surface.nodes[1], cross.surface.nodes.at(-1), cross.agent, new AbortController().signal, {
      manual: true,
      policy: cross.engine.config,
    });
    assert.equal(cross.calls.length, 1);
    assert.equal(cross.calls[0].provider, 'cheap-p');
    assert.equal(cross.calls[0].model, 'cheap-m');
    assert.equal(cross.calls[0].reasoningEffort, 'low', 'cross-route forwards configured/default direct low policy rather than primary xhigh');
    assert.equal('temperature' in cross.calls[0], false, 'cross-route must NOT forward primary temperature');
    assert.match(JSON.stringify(cross.calls[0].messages.slice(0, -1)), /External content omitted from working memory/);
  } finally {
    await rm(cross.root, { recursive: true, force: true });
  }

  // (b2) Under summaryReasoningEffort="inherit", cross-route summary model NEVER receives primary reasoningEffort.
  const inheritCross = createEngineFixture({
    headerTarget: { provider: 'primary-p', model: 'primary-m', reasoningEffort: 'xhigh', temperature: 0.2 },
    extraConfig: {
      summarizationProvider: 'cheap-p',
      summarizationModel: 'cheap-m',
      summaryReasoningEffort: 'inherit',
    },
  });
  try {
    inheritCross.addSystem('Stable system.');
    inheritCross.addToolPair('src/invoice.js', 'export const x = 1;\n'.repeat(50));
    inheritCross.addUser('Keep integer cents.');
    inheritCross.addAssistant('Details. '.repeat(300));

    await inheritCross.engine._compactRegionCore(inheritCross.surface.nodes[1], inheritCross.surface.nodes.at(-1), inheritCross.agent, new AbortController().signal, {
      manual: true,
      policy: inheritCross.engine.config,
    });
    assert.equal(inheritCross.calls.length, 1);
    assert.equal(inheritCross.calls[0].provider, 'cheap-p');
    assert.equal(inheritCross.calls[0].model, 'cheap-m');
    assert.equal('reasoningEffort' in inheritCross.calls[0], false, 'cross-route inherit must NOT forward primary xhigh reasoningEffort');
    assert.equal('temperature' in inheritCross.calls[0], false, 'cross-route inherit must NOT forward primary temperature');
  } finally {
    await rm(inheritCross.root, { recursive: true, force: true });
  }
});

// ── 3. Hard Call Caps & Circuit Breaker Money Protection ────────────────────
await test('circuit-breaker-caps-retries-and-blocks-free-waterfall-reentry', async () => {
  const f = createEngineFixture({
    windowTokens: 200000,
    thresholdRatio: 0.8,
    extraConfig: {
      headroomTokens: 4000,
      retainTokens: 200,
      summaryRetryCount: 2,
      failureThreshold: 3,
      reactiveStep: 2,
      continuationEnabled: false,
    },
    // Persistent invalid output -> stops at 1 + 2 = 3 calls per compaction attempt.
    streamHandler: () => 'Done.',
  });
  try {
    f.addSystem('Stable system.');
    f.addUser('Keep integer cents.');
    for (let i = 0; i < 50; i += 1) {
      f.addAssistant(`Trace turn ${i} engineering detail output. `.repeat(320));
    }
    while (f.measure().totalTokens < 162000) {
      f.addAssistant('Extra trace tokens for threshold. '.repeat(280));
    }
    f.addAssistant('Short tail.');
    f.session.append('turn/start', { turn: 1 });

    // 3 automatic failure cycles reach failureThreshold = 3 (each cycle bounded to 3 calls = 9 total).
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await assert.rejects(f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal));
      assert.equal(f.calls.length, cycle * 3, `cycle ${cycle} must strictly stop at 3 calls`);
    }
    assert.equal(f.engine._stopped.has(f.session.id), true, 'circuit breaker must trip after 3 failures');

    // Subsequent automatic calls (pressure, context-overflow, idle, waterfall summary-error) execute ZERO LLM calls.
    await assert.rejects(
      f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal),
      (e) => e.code === 'COMPACTION_AUTOMATIC_BLOCKED' && e.failureCode === 'COMPACTION_STOPPED',
    );
    const overflowRes = await f.engine.compactIfNeeded(f.agent, 'context-overflow', new AbortController().signal);
    assert.equal(overflowRes, null);
    const waterfallRes = await f.engine._reactiveRetry(f.agent, new AbortController().signal);
    assert.equal(waterfallRes, false);
    assert.equal(f.calls.length, 9, 'Circuit breaker must block all further paid LLM calls across all automatic paths');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

await test('credential-401-error-aborts-immediately-on-first-call-without-retrying', async () => {
  const f = createEngineFixture({
    extraConfig: { summaryRetryCount: 4 },
    streamHandler: () => ({ error: Object.assign(new Error('Unauthorized API key'), { status: 401, code: 'HTTP_ERROR' }) }),
  });
  try {
    f.addSystem('Stable system.');
    f.addUser('Keep integer cents.');
    f.addAssistant('Work done. '.repeat(350));

    await assert.rejects(
      f.engine._compactRegionCore(f.surface.nodes[1], f.surface.nodes.at(-1), f.agent, new AbortController().signal, {
        manual: true,
        policy: f.engine.config,
      }),
    );
    assert.equal(f.calls.length, 1, '401 auth error must NEVER burn retryCount retries');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

await test('continuation-call-cap-halts-and-resumes-without-rebilling-saved-pages', async () => {
  let failPage2 = true;
  const f = createEngineFixture({
    extraConfig: {
      summaryInputMaxBytes: 36000,
      continuationMemoryBytes: 4096,
      continuationMaxExtraCalls: 0,
      summaryRetryCount: 2,
      maxSummaryChunks: 32,
    },
    streamHandler() {
      // Page 0 succeeds cleanly; Page 1 fails once -> maxExtraCalls=0 immediately halts retry #1!
      if (f.calls.length >= 2 && failPage2) return 'Done.';
      return CONT_NOTES;
    },
  });
  try {
    f.addSystem('Stable system.');
    f.addUser('Keep integer cents.\n' + 'archiveblob '.repeat(8000));
    f.addAssistant('evidence '.repeat(5000));

    // Attempt 1 with continuationMaxExtraCalls=0 & summaryRetryCount=2:
    // Page 0 accepted (call 1), Page 1 attempt 0 fails (call 2), Retry #1 blocked BEFORE dispatch by CONTINUATION_CALL_BUDGET!
    await assert.rejects(
      f.engine._compactNowInner(f.agent, new AbortController().signal, 'cmd-cont-1', true),
      (e) => e.code === 'CONTINUATION_CALL_BUDGET' && e.continuationProgress?.acceptedPages === 1,
    );
    const callsAfterFirst = f.calls.length;
    assert.equal(callsAfterFirst, 2, '1 accepted page + maxExtraCalls=0 must block retry #1 BEFORE dispatch (2 calls total)');

    // Attempt 2 (manual /compact with a new commandId): grants renewal AND reuses Page 0 (0 duplicate calls for Page 0)!
    failPage2 = false;
    const resumed = await f.engine._compactNowInner(f.agent, new AbortController().signal, 'cmd-cont-2', true);
    assert.ok(resumed?.continuation);
    assert.equal(resumed.continuation.resumedPages, 1, 'resumed continuation must reuse accepted Page 0 without re-billing');
    assert.equal(resumed.continuation.totalRequests, f.calls.length);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

// ── 4. Idle Compaction Money & User-Input Preservation Guard ────────────────
await test('idle-compaction-skips-tiny-history-for-zero-calls-and-preserves-input-on-failure', async () => {
  const MINUTE = 60_000;
  const now = 1_000 * MINUTE;

  // (a) Tiny history below idleCompactionMinTokens spends ZERO LLM calls & does NOT increment failures.
  const tiny = createEngineFixture({
    extraConfig: { idleCompactionMinutes: 5, idleCompactionMinTokens: 5000, auto: false },
  });
  try {
    tiny.addSystem('Stable system.');
    tiny.addUser('Short question.', 'user', now - 40 * MINUTE);
    tiny.addAssistant('Short answer.', now - 30 * MINUTE);
    tiny.session.append('turn/end', {}, { time: now - 29 * MINUTE });
    const nextMsg = { id: 'u-tiny', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Next step?' }] };
    tiny.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [nextMsg] }, { time: now });
    tiny.session.append('turn/start', { turn: 2 }, { time: now });

    let proceeded = 0;
    await tiny.hooks.get('agent/pre-step')({ agent: tiny.agent, signal: new AbortController().signal, messages: [nextMsg] }, async () => {
      proceeded += 1;
    });
    assert.equal(proceeded, 1);
    assert.equal(tiny.calls.length, 0);
    assert.equal(tiny.engine.sessionState.read(tiny.session.id).failures, 0);
  } finally {
    await rm(tiny.root, { recursive: true, force: true });
  }

  // (b) Idle compaction failure restores user inbox message intact & does not lose it!
  const failing = createEngineFixture({
    extraConfig: {
      idleCompactionMinutes: 5,
      idleCompactionMinTokens: 100,
      auto: false,
      summaryRetryCount: 0,
      failureThreshold: 1,
    },
    streamHandler: () => 'Done.',
  });
  try {
    failing.addSystem('Stable system.');
    failing.addUser('Keep integer cents.', 'user', now - 40 * MINUTE);
    failing.addAssistant('Long idle session body. '.repeat(400), now - 30 * MINUTE);
    failing.session.append('turn/end', {}, { time: now - 29 * MINUTE });
    const userMsg = { id: 'u-preserve', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Please check deployment status.' }] };
    failing.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [userMsg] }, { time: now });
    failing.session.append('turn/start', { turn: 2 }, { time: now });

    let proceeded = 0;
    await assert.rejects(
      failing.hooks.get('agent/pre-step')({ agent: failing.agent, signal: new AbortController().signal, messages: [userMsg] }, async () => {
        proceeded += 1;
      }),
      (e) => e.code === 'COMPACTION_AUTOMATIC_BLOCKED',
    );
    assert.equal(proceeded, 0);
    assert.equal(failing.calls.length, 1);
    assert.equal(failing.inbox.nextStep.length, 1);
    assert.equal(failing.inbox.nextStep[0].id, 'u-preserve', 'failed idle compaction MUST preserve user queued input');

    // Second step with same stopped session burns ZERO extra LLM calls & skips idle compaction safely!
    await failing.hooks.get('agent/pre-step')(
      { agent: failing.agent, signal: new AbortController().signal, messages: [userMsg] },
      async () => {
        proceeded += 1;
      },
    );
    assert.equal(proceeded, 1, 'stopped idle session skips idle compaction and lets turn continue within budget');
    assert.equal(failing.calls.length, 1);
  } finally {
    await rm(failing.root, { recursive: true, force: true });
  }
});

// ── 5. Package Exports, Settings RPC Guard, Version & Cordis Manifest Check ──
await test('exports-version-locale-cordis-and-settings-rpc-guards-hold', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = dirname(here);
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(PLUGIN_VERSION, pkg.version, 'PLUGIN_VERSION must match package.json version');
  assert.equal(pkg.license, 'MIT');

  // Verify every declared export resolves and loads without throwing.
  for (const [key, rel] of Object.entries(pkg.exports)) {
    if (key.includes('*')) {
      for (const file of ['zh.json', 'en.json']) {
        const parsed = JSON.parse(readFileSync(join(repoRoot, rel.replace('*', file.replace('.json', ''))), 'utf8'));
        assert.ok(parsed && typeof parsed === 'object');
      }
      continue;
    }
    const target = join(repoRoot, rel);
    assert.ok(existsSync(target), `Missing export target: ${rel}`);
    if (key === './client') {
      let registered = null;
      const sandbox = {
        console,
        window: {
          __ModuleLoader__: {
            load(entry) {
              registered = entry;
            },
          },
        },
      };
      vm.runInNewContext(readFileSync(target, 'utf8'), sandbox);
      assert.equal(registered?.id, 'dsh-compaction-weave');
      const clientExports = registered.factory((name) => {
        if (name === 'react') return { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {} };
        throw new Error(`Unexpected web require: ${name}`);
      });
      assert.equal(typeof clientExports?.apply, 'function');
      assert.deepEqual([...clientExports.inject], ['slots', 'locale']);
    } else if (rel.endsWith('.js')) {
      const mod = await import(new URL(`../${rel}`, import.meta.url).href);
      assert.ok(mod && typeof mod === 'object', `Module ${rel} did not export an object`);
    }
  }

  // Verify cordis.patch.yml wires gate and all 4 official presets.
  const patchText = readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8');
  assert.match(patchText, /name:\s*dsh-compaction-weave/);
  for (const preset of ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis']) {
    assert.match(patchText, new RegExp(`id:\\s*${preset}[\\s\\S]*?compactionWeaveGate`));
  }

  // Verify settings RPC validation & disk integrity on rejection.
  const baseTmp = process.env.WEAVE_TEST_ROOT ?? tmpdir();
  const cfgRoot = await mkdtemp(join(baseTmp, 'weave-rpc-guard-'));
  try {
    const cfgPath = join(cfgRoot, 'summary-config.json');
    const saved = await handleSummaryConfigRpc(
      { method: 'set', params: { provider: 'p1', model: 'm1', maxTokens: 4096, thresholdRatio: 0.75, idleCompactionMinutes: 30 } },
      cfgPath,
    );
    assert.equal(saved.restartRequired, false);
    const digestBefore = createHash('sha256').update(readFileSync(cfgPath)).digest('hex');

    await assert.rejects(
      handleSummaryConfigRpc({ method: 'set', params: { provider: 'bad model with space', model: 'm1' } }, cfgPath),
      (e) => e.code === 'INVALID_PROVIDER',
    );
    await assert.rejects(
      handleSummaryConfigRpc({ method: 'set', params: { idleCompactionMinutes: 43201 } }, cfgPath),
      (e) => e.code === 'INVALID_IDLE_COMPACTION_MINUTES',
    );
    await assert.rejects(
      handleSummaryConfigRpc({ method: 'set', params: { thresholdRatio: 0.99 } }, cfgPath),
      (e) => e.code === 'INVALID_THRESHOLD_RATIO',
    );
    const digestAfter = createHash('sha256').update(readFileSync(cfgPath)).digest('hex');
    assert.equal(digestAfter, digestBefore, 'invalid settings save must leave previous valid config byte-for-byte intact');
    assert.ok(MAX_BODY_BYTES === 64 * 1024);
  } finally {
    await rm(cfgRoot, { recursive: true, force: true });
  }
});

// ── 6. HTTP RPC Guard (Cross-Site, Method, Payload Cap, Status) & Reactive Non-Repeat Guard ──
await test('http-rpc-enforces-same-origin-method-size-and-reactive-never-repeats-identical-span', async () => {
  const baseTmp = process.env.WEAVE_TEST_ROOT ?? tmpdir();
  const home = await mkdtemp(join(baseTmp, 'weave-http-rpc-'));
  const priorHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    let registeredRoute = null;
    const disposeGate = mountGate(
      {
        on() {},
        provide() {},
        inject(deps, fn) {
          if (Array.isArray(deps) && deps.includes('webServer')) {
            return fn({
              effect(cb) {
                cb();
                return () => {};
              },
              webServer: {
                register(route) {
                  registeredRoute = route;
                  return () => {};
                },
              },
            });
          }
        },
        logger: { info() {}, warn() {} },
      },
      { engine: { archiveDir: join(home, 'archive') }, receiptPath: join(home, 'receipts.jsonl') },
    );
    try {
      assert.equal(registeredRoute?.path, SUMMARY_RPC_PATH);
      const invoke = (method, headers, body) =>
        new Promise((resolve) => {
          const req = new EventEmitter();
          req.method = method;
          req.headers = headers;
          req.destroy = () => {};
          const resHeaders = {};
          let bodyOut = '';
          const res = {
            statusCode: 0,
            setHeader(k, v) {
              resHeaders[k.toLowerCase()] = v;
            },
            end(text) {
              bodyOut = text ?? '';
              resolve({ status: res.statusCode, headers: resHeaders, body: bodyOut ? JSON.parse(bodyOut) : null });
            },
          };
          const done = registeredRoute.handler(req, res);
          if (body !== undefined) req.emit('data', Buffer.from(body));
          req.emit('end');
          Promise.resolve(done).catch(() => {});
        });

      const crossSite = await invoke('POST', { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, '{}');
      assert.equal(crossSite.status, 403);

      const badMethod = await invoke('GET', { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' }, undefined);
      assert.equal(badMethod.status, 405);

      const oversized = await invoke('POST', { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' }, 'x'.repeat(MAX_BODY_BYTES + 1));
      assert.equal(oversized.status, 413);
      assert.equal(oversized.body?.error?.code, 'payload-too-large');

      const statusRes = await invoke('POST', { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' }, JSON.stringify({ method: 'status', params: { sessionId: 's1' } }));
      assert.equal(statusRes.status, 200);
      assert.equal(statusRes.body?.ok, true);
      assert.equal(statusRes.body?.value?.active, false);
    } finally {
      disposeGate?.();
    }

    // Reactive retry must NEVER dispatch two LLM calls on the exact same unshrinkable tail span.
    const r = createEngineFixture({
      windowTokens: 50000,
      thresholdRatio: 0.8,
      extraConfig: { headroomTokens: 2000, maxTokens: 2000, retainTokens: 3000, reactiveStep: 3, summaryRetryCount: 0 },
      streamHandler: () => ({ error: Object.assign(new Error('maximum context length exceeded'), { code: 'CONTEXT_WINDOW_EXCEEDED', status: 400 }) }),
    });
    try {
      r.addSystem('Stable system.');
      r.addUser('Keep integer cents.');
      r.addAssistant('Mid-session trace block '.repeat(350)); // ~2100 tokens
      r.addAssistant('Tail context block '.repeat(950));     // ~4512 tokens (> 4024 on extra=1, < 5048 on extra=2!)
      r.session.append('turn/start', { turn: 1 });
      const retried = await r.engine._reactiveRetry(r.agent, new AbortController().signal);
      assert.equal(retried, false);
      assert.equal(r.calls.length, 1, 'reactiveRetry must stop at 1 call rather than re-sending the exact same unshrinkable span');
    } finally {
      await rm(r.root, { recursive: true, force: true });
    }
  } finally {
    if (priorHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = priorHome;
    await rm(home, { recursive: true, force: true });
  }
});

console.log(JSON.stringify({ passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, results }, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
