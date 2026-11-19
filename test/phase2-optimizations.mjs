import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { resolveConfig } from '../lib/config.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { CompactionArchive } from '../lib/history.js';
import { buildCompactionInstruction } from '../lib/prompt.js';
import { OBSERVATION_MASK_MARKER, planObservationMask } from '../lib/observation-mask.js';
import { selectMemoryMessages, memoryDecisionsForSource, restoreRetiredDecisions } from '../lib/memory-policy.js';
import { auditCompaction, coverageOf } from '../lib/audit.js';

const results = [];
async function test(name, fn) {
  const start = performance.now();
  try {
    await fn();
    results.push({ name, pass: true, ms: Math.round(performance.now() - start) });
  } catch (error) {
    results.push({ name, pass: false, ms: Math.round(performance.now() - start), error: error.message, stack: error.stack });
  }
}

const HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeSummary(extra = 'Keep integer cents.') {
  return HEADINGS.map((h, idx) => `${h}\n${idx === 5 ? '[filled by engine]' : idx === 8 ? extra : 'Evidence archived; continuing task.'}`).join('\n\n');
}

function createFixture({ extraConfig = {}, summaryText = makeSummary(), pruner } = {}) {
  const root = join(process.env.WEAVE_TEST_ROOT, 'test-tmp', `phase2-${randomUUID()}`);
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const calls = [];
  const session = {
    id: `sess-${randomUUID()}`,
    surface,
    get seq() { return events.length; },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    toolHistory: () => [],
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (event.type === 'assistant/message') return event.data.message;
      if (event.type === 'tool/result') {
        return {
          role: 'tool',
          toolCallId: event.data.message.toolCallId,
          content: event.data.message.content,
          ...(event.data.message.isError ? { isError: true } : {}),
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
        data,
        ...(Array.isArray(options.sourceEventSeqs) ? { sourceEventSeqs: [...options.sourceEventSeqs] } : {}),
      };
      events.push(event);
      const op = options.surfaceOp;
      if (op?.op === 'replace') {
        const start = surface.nodes.indexOf(op.startSeq);
        const end = surface.nodes.indexOf(op.endSeq);
        assert.ok(start >= 0 && end >= start, 'invalid replace range');
        if (type === 'tool/result') {
          assert.equal(start, end, 'tool/result rewrite must target single node');
        }
        surface.nodes.splice(start, end - start + 1, event.seq);
        surface.replaceGeneration += 1;
      } else if (options.surfaceOp === 'append') {
        surface.nodes.push(event.seq);
      }
      return event;
    },
  };

  const addUser = (text, kind = 'user') =>
    session.append('user/message', { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind } }, { surfaceOp: 'append' });
  const addAssistant = (text) =>
    session.append('assistant/message', { message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } } }, { surfaceOp: 'append' });
  const addSystem = (text) =>
    session.append('system/message', { message: { id: randomUUID(), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' });
  const addToolPair = (toolName, args, body, { isError = false } = {}) => {
    const callId = `call-${randomUUID()}`;
    const callEvent = session.append('tool/call', { callId, name: toolName, arguments: JSON.stringify(args) });
    const assistantCall = session.append('assistant/message', {
      message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool-call', callId, toolName, args }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, { surfaceOp: 'append' });
    const resultEvent = session.append('tool/result', {
      message: {
        id: randomUUID(),
        role: 'tool',
        toolCallId: callId,
        content: [{ type: 'text', text: body }],
        source: { kind: 'tool-result', callId },
        ...(isError ? { isError: true } : {}),
      },
      extraTag: 'preserve-me',
    }, { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] });
    return { callEvent, assistantCall, resultEvent };
  };

  const measure = () => {
    const nodes = surface.nodes.map((seq) => ({ seq, tokens: approxTokens(blocksToText(session.deriveEventMessage(events[seq])?.content)) }));
    return { nodes, totalTokens: nodes.reduce((sum, item) => sum + item.tokens, 0) };
  };

  const ctx = {
    on() {},
    provide() {},
    get: (name) => (name === 'toolResultPruner' ? pruner : undefined),
    logger: { info() {}, warn() {} },
    sessions: { async flush() {} },
    tokenMeter: { measure },
    llm: {
      async resolveModelInfo() { return { contextWindow: 100000 }; },
      async *stream(opts) {
        calls.push(opts);
        const text = typeof summaryText === 'function' ? summaryText(opts, calls.length) : summaryText;
        yield { type: 'text-delta', text };
        yield { type: 'finish', kind: 'stop' };
      },
    },
  };

  const config = resolveConfig({
    archiveDir: join(root, 'archive'),
    language: 'en',
    headroomTokens: 0,
    thresholdRatio: 0.1,
    minimumReductionRatio: 0.2,
    ...(extraConfig.retainTokens === undefined ? { retainRatio: 0.08 } : {}),
    windowFallback: 100000,
    windowClampMin: 4096,
    summaryInputMaxBytes: 120000,
    maxTokens: 2048,
    observationMaskThresholdChars: 1000,
    observationMaskHeadChars: 120,
    observationMaskTailChars: 120,
    ...extraConfig,
  }).config;

  session.append('turn/start', { turn: 1 });
  const engine = new WeaveCompactionEngine(ctx, config);
  engine.historyToolsAvailable = true;
  const agent = { session, options: { provider: 'p', model: 'm' }, runMaintenance: (fn) => fn(new AbortController().signal) };

  return { root, events, surface, calls, session, engine, agent, addSystem, addUser, addAssistant, addToolPair };
}

await test('stage1-observation-mask-resolves-pressure-without-llm-and-preserves-error-and-tail', async () => {
  const f = createFixture({ extraConfig: { retainTokens: 600 } });
  try {
    f.addSystem('Stable system prompt.');
    f.addUser('Keep integer cents.');
    const headMarker = 'HEAD_SLICE_START_';
    const tailMarker = '_TAIL_SLICE_END';
    const bigBody = `${headMarker}${'A'.repeat(40000)}${tailMarker}`;
    const big = f.addToolPair('read_file', { path: 'src/big.js' }, bigBody);
    const err = f.addToolPair('bash', { command: 'npm test' }, `ERROR_NEEDLE_PRESERVED ${'E'.repeat(2000)}`, { isError: true });
    f.addUser('Current working user question. '.repeat(25)); // ~190 tokens
    const recentBody = `RECENT_TAIL_UNMASKED ${'R'.repeat(1600)}`;
    const recent = f.addToolPair('read_file', { path: 'src/recent.js' }, recentBody);
    f.addAssistant('Analyzing recent file now. '.repeat(25)); // ~170 tokens

    const result = await f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal);
    assert.ok(result);
    assert.equal(result.mode, 'observation-mask');
    assert.equal(result.maskedCount, 1);
    assert.equal(f.calls.length, 0, 'Stage 1 should avoid LLM summary call');
    assert.deepEqual(result.maskedSeqs, [big.resultEvent.seq]);

    // Original node was replaced in surface by new tool/result preserving metadata & non-content fields.
    const replacedSeq = f.surface.nodes.find((seq) => {
      const ev = f.session.eventAt(seq);
      return ev?.type === 'tool/result' && ev.data?.message?.toolCallId === big.resultEvent.data.message.toolCallId;
    });
    assert.ok(replacedSeq !== undefined && replacedSeq > big.resultEvent.seq);
    const replacedEvent = f.session.eventAt(replacedSeq);
    assert.equal(replacedEvent.data.extraTag, 'preserve-me');
    assert.equal(replacedEvent.data.message.id, big.resultEvent.data.message.id);
    assert.deepEqual(replacedEvent.data.message.source, big.resultEvent.data.message.source);
    assert.deepEqual(replacedEvent.sourceEventSeqs, [big.resultEvent.seq]);

    const maskedText = blocksToText(replacedEvent.data.message.content);
    assert.ok(maskedText.startsWith(headMarker));
    assert.ok(maskedText.endsWith(tailMarker));
    assert.ok(maskedText.includes(OBSERVATION_MASK_MARKER));
    assert.ok(maskedText.includes('read_file "src/big.js"'));
    assert.ok(maskedText.includes(`history_read({ compactionId: ${JSON.stringify(result.compactionId)}, seq: ${big.resultEvent.seq} })`));

    // Emit compaction/prune accounting before replacement.
    const pruneEvent = f.events.find((ev) => ev.type === 'compaction/prune');
    assert.ok(pruneEvent);
    assert.deepEqual(pruneEvent.data.shadowedSeqs, [big.resultEvent.seq]);

    // Error result and recent tail remain verbatim.
    assert.ok(f.surface.nodes.includes(err.resultEvent.seq));
    assert.equal(blocksToText(f.session.eventAt(err.resultEvent.seq).data.message.content).includes('ERROR_NEEDLE_PRESERVED'), true);
    assert.ok(f.surface.nodes.includes(recent.resultEvent.seq));

    // Archive verification recovers the complete original 16KB body.
    const archive = new CompactionArchive({ root: f.engine.archive.root });
    const recovered = await archive.readSpan(f.session.id, result.compactionId);
    assert.equal(recovered.ok, true);
    const origEntry = recovered.entries.find((e) => e.seq === big.resultEvent.seq);
    assert.equal(origEntry?.text, bigBody);

    // Re-planning skips already masked output.
    const replan = planObservationMask(f.session, await f.engine._measure(f.session), 600, {
      compactionId: 'recheck',
      thresholdChars: 1000,
    });
    assert.equal(replan, null);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

await test('stage1-cadoc-gate-defers-small-savings-and-overflow-masks-before-prune', async () => {
  // Pressure case: small tool savings (< minimumReductionRatio target) should NOT commit Stage 1 before Stage 2.
  const f = createFixture({ extraConfig: { retainTokens: 200, observationMaskThresholdChars: 800 } });
  try {
    f.addSystem('Stable system.');
    f.addUser('Keep integer cents.');
    const smallTool = f.addToolPair('read_file', { path: 'src/helper.js' }, `HELPER_BODY ${'H'.repeat(1200)}`); // ~300 tokens
    for (let i = 0; i < 6; i += 1) {
      f.addAssistant(`Detailed analysis note ${i}. ` + 'Detail line. '.repeat(520)); // ~1700 tokens each (~10200 total)
    }

    const res = await f.engine.compactIfNeeded(f.agent, 'pressure', new AbortController().signal);
    assert.ok(res?.compactionId);
    assert.equal(res.mode, undefined, 'Should run Stage 2 LLM compaction rather than Stage 1');
    assert.equal(f.calls.length, 1);
    assert.equal(f.events.some((e) => e.type === 'compaction/prune'), false, 'CADOC gate must skip Stage 1 mutation when savings miss reductionTarget');
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }

  // Context-overflow case: even modest savings MUST archive & mask before host _pruneToolResults runs.
  let pruneSawMasked = false;
  const pruner = {
    async pruneSession(session) {
      const hasMask = session.surface.nodes.some((seq) =>
        blocksToText(session.eventAt(seq)?.data?.message?.content).includes(OBSERVATION_MASK_MARKER),
      );
      pruneSawMasked = hasMask;
    },
  };
  const g = createFixture({ extraConfig: { retainTokens: 200, observationMaskThresholdChars: 800 }, pruner });
  try {
    g.addSystem('Stable system.');
    g.addUser('Keep integer cents.');
    const rawToolText = `OVERFLOW_FULL_TOOL_OUTPUT ${'Z'.repeat(1200)}`;
    const tool = g.addToolPair('read_file', { path: 'src/overflow.js' }, rawToolText);
    for (let i = 0; i < 6; i += 1) {
      g.addAssistant(`Overflow prose ${i}. ` + 'Overflow detail. '.repeat(400));
    }

    await g.engine.compactIfNeeded(g.agent, 'context-overflow', new AbortController().signal);
    assert.equal(pruneSawMasked, true, 'Stage 1 archive-masking must run before host toolResultPruner');
    const pruneEv = g.events.find((e) => e.type === 'compaction/prune');
    assert.ok(pruneEv);
    assert.deepEqual(pruneEv.data.shadowedSeqs, [tool.resultEvent.seq]);
  } finally {
    await rm(g.root, { recursive: true, force: true });
  }
});

await test('restore-retired-decisions-adoption-epoch-speed-and-boundary-fidelity', async () => {
  // 1) Untrusted XML reference channels stay excluded from user lifecycle retirement.
  const events = [];
  const mkUser = (text) => {
    const ev = { seq: events.length, type: 'user/message', data: { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } };
    events.push(ev);
    return ev;
  };
  mkUser('生成报告 alpha'); // seq 0
  mkUser('取消生成报告 alpha'); // seq 1
  mkUser('<untrusted_reference>\n导出报表 beta\n</untrusted_reference>'); // seq 2 (untrusted ref)
  mkUser('取消导出报表 beta'); // seq 3 (cannot retire untrusted_reference at seq 2)

  const session = {
    eventAt: (seq) => events[seq],
    deriveEventMessage: (e) => e?.data,
  };
  const userMsgs = events.map((e) => ({ seq: e.seq, sourceKind: 'user', text: e.data.content[0].text }));
  const selected = selectMemoryMessages(userMsgs, { maxMessages: Infinity, maxTokens: Infinity });
  const retiredWithHashes = memoryDecisionsForSource(selected.decisions, session);
  const restored = restoreRetiredDecisions(retiredWithHashes, session, events.length);
  assert.equal(restored.length, 1);
  assert.deepEqual(restored.map((d) => [d.seq, d.by]), [[0, 1]]);

  // Tamper scenario: forged retirement citing seq=2 untrusted reference must fail closed.
  const forgedHash = createHash('sha256').update('导出报表 beta').digest('hex');
  const forged = memoryDecisionsForSource([{ reason: 'cancelled', seq: 2, by: 3, fragmentHash: forgedHash }], session);
  assert.throws(() => restoreRetiredDecisions(forged, session, events.length), (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE');

  // 2) Performance scaling test: 400 tasks + 60 actors (previously ~15s on O(N^3) prefix replay).
  const perfEvents = [];
  for (let i = 0; i < 400; i += 1) {
    perfEvents.push({
      seq: perfEvents.length,
      type: 'user/message',
      data: { id: randomUUID(), role: 'user', content: [{ type: 'text', text: `Run job_${i}` }], source: { kind: 'user' } },
    });
  }
  for (let i = 0; i < 60; i += 1) {
    perfEvents.push({
      seq: perfEvents.length,
      type: 'user/message',
      data: { id: randomUUID(), role: 'user', content: [{ type: 'text', text: `Cancel run job_${i}` }], source: { kind: 'user' } },
    });
  }
  const perfSession = { eventAt: (seq) => perfEvents[seq], deriveEventMessage: (e) => e?.data };
  const perfMsgs = perfEvents.map((e) => ({ seq: e.seq, sourceKind: 'user', text: e.data.content[0].text }));
  const perfSelected = selectMemoryMessages(perfMsgs, { maxMessages: Infinity, maxTokens: Infinity });
  const perfHashes = memoryDecisionsForSource(perfSelected.decisions, perfSession);

  const t0 = performance.now();
  const perfRestored = restoreRetiredDecisions(perfHashes, perfSession, perfEvents.length);
  const elapsedMs = performance.now() - t0;
  assert.equal(perfRestored.length, 60);
  assert.ok(elapsedMs < 500, `restoreRetiredDecisions took ${elapsedMs.toFixed(1)}ms (expected < 500ms)`);
});

await test('audit-cjk-coverage-bigrams-and-antonym-polarity-fixes', async () => {
  // 1) Unpunctuated Chinese rule paraphrase coverage
  const sourceLine = '生产环境的数据库连接池上限必须保持在五十以内';
  const paraphrase = '生产环境数据库连接池上限必须保持50以内';
  assert.ok(coverageOf(sourceLine, paraphrase) >= 0.6, `expected >= 0.6, got ${coverageOf(sourceLine, paraphrase)}`);
  assert.equal(coverageOf(sourceLine, 'evidence archived continuing task'), 0);

  const zhHeadings = buildCompactionInstruction('zh')
    .split('\n')
    .filter((line) => /^## [1-9]\./.test(line));
  const buildZhSummary = (body) =>
    zhHeadings.map((h, i) => `${h}\n${i === 5 ? '[由引擎填充]' : i === 0 ? body : '已按要求继续推进。'}`).join('\n\n');

  const cjkPass = auditCompaction({
    userMessages: [{ seq: 1, text: sourceLine }],
    summaryText: buildZhSummary(paraphrase),
  });
  assert.equal(cjkPass.lost.length, 0, JSON.stringify(cjkPass.lost));

  // 2) Equivalent antonym polarity pairs must pass
  const equivalentPairs = [
    ['不要漏掉任何错误日志', '必须完整保留所有错误日志'],
    ['必须完整保留所有错误日志', '不要漏掉任何错误日志'],
    ['Do not omit error logs', 'Must preserve all error logs'],
    ['不要出现任何报错', '必须保证零报错'],
  ];
  for (const [src, cand] of equivalentPairs) {
    const res = auditCompaction({
      userMessages: [{ seq: 1, text: src }],
      summaryText: /[\u4e00-\u9fff]/.test(src) ? buildZhSummary(cand) : makeSummary(cand),
    });
    assert.equal(res.lost.length, 0, `expected pass for ${src} -> ${cand}, got ${JSON.stringify(res.lost)}`);
  }

  // 3) Genuine polarity reversals must still be rejected
  const conflictPairs = [
    ['不要漏掉错误日志', '允许漏掉错误日志'],
    ['不要删除错误日志', '可以删除错误日志'],
    ['不要保留测试缓存', '必须保留测试缓存'],
  ];
  for (const [src, cand] of conflictPairs) {
    const res = auditCompaction({
      userMessages: [{ seq: 1, text: src }],
      summaryText: buildZhSummary(cand),
    });
    assert.ok(res.lost.some((x) => x.reason === 'polarity'), `expected polarity conflict for ${src} -> ${cand}, got ${JSON.stringify(res.lost)}`);
  }

  // Cross-verb reversal without checkpoint must also be rejected (coverage or polarity).
  const crossVerbReject = auditCompaction({
    userMessages: [{ seq: 1, text: '不要漏掉任何错误日志' }],
    summaryText: buildZhSummary('可以删除所有错误日志'),
  });
  assert.ok(crossVerbReject.lost.length > 0);
});

await test('idle-compaction-min-tokens-and-retain-tokens-guardrails', async () => {
  // 1) Below idleCompactionMinTokens: skips cleanly with zero LLM calls
  const f = createFixture({ extraConfig: { idleCompactionMinutes: 30, idleCompactionMinTokens: 32000 } });
  try {
    f.addSystem('Stable system.');
    f.addUser('Keep integer cents.');
    f.addAssistant('Short reply. '.repeat(200));

    const res = await f.engine._compactManual(f.agent, new AbortController().signal, undefined, false, true, { idle: true });
    assert.equal(res, null);
    assert.equal(f.calls.length, 0);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }

  // 2) Above idleCompactionMinTokens with idleRetainTokens > 0: compacts older prefix while preserving tail
  const g = createFixture({ extraConfig: { idleCompactionMinutes: 30, idleCompactionMinTokens: 2000, idleRetainTokens: 1500 } });
  try {
    g.addSystem('Stable system.');
    g.addUser('Keep integer cents.');
    const oldAssistant = g.addAssistant('Old completed research notes. '.repeat(800)); // ~6000 tokens
    const tailUser = g.addUser('Recent active follow-up question. '.repeat(90)); // ~765 tokens
    const tailAssistant = g.addAssistant('Recent active working context tail. '.repeat(95)); // ~855 tokens (sum 1620 >= 1500)

    const res = await g.engine._compactManual(g.agent, new AbortController().signal, undefined, false, true, { idle: true });
    assert.ok(res?.compactionId);
    assert.equal(g.calls.length, 1);
    assert.ok(!g.surface.nodes.includes(oldAssistant.seq), 'Older prefix should be compacted');
    assert.ok(g.surface.nodes.includes(tailUser.seq), 'Recent user tail should be retained');
    assert.ok(g.surface.nodes.includes(tailAssistant.seq), 'Recent assistant tail within idleRetainTokens should be retained');
  } finally {
    await rm(g.root, { recursive: true, force: true });
  }
});

console.log(JSON.stringify({ passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, results }, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
