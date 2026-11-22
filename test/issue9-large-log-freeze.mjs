import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { buildCompactionInstruction } from '../lib/prompt.js';
import { selectCachePreservingRange } from '../lib/cache-policy.js';
import {
  memoryDecisionsForSource,
  memorySourceRefs,
  restoreRetiredDecisions,
  restoreRetiredDecisionsBatch,
  selectMemoryMessages,
} from '../lib/memory-policy.js';
import {
  createProgressSelector,
  extractProgressFacts,
  isExternalScriptCheckpoint,
  progressSourceRefs,
} from '../lib/progress-facts.js';
import {
  buildCheckpointBlocks,
  collectRecentUserMessages,
  createSessionMemorySelector,
  preservedForSource,
} from '../lib/region.js';
import {
  isStageTraceEnabled,
  sanitizeStageMeta,
  traceStageAsync,
  traceStagePoint,
  traceStageSync,
  withStageTraceContext,
} from '../lib/stage-trace.js';
import { measureSummaryRange, planSummaryRange } from '../lib/summary-budget.js';
import { CHECKPOINT_PREAMBLE } from '../lib/prompt.js';

const results = [];
async function test(name, fn) {
  const started = performance.now();
  try {
    await fn();
    results.push({ name, pass: true, ms: Math.round(performance.now() - started) });
  } catch (error) {
    results.push({
      name,
      pass: false,
      ms: Math.round(performance.now() - started),
      error: error?.message ?? String(error),
      stack: error?.stack,
    });
  }
}

function makeTempRoot(prefix) {
  const base = process.env.WEAVE_TEST_ROOT ? join(process.env.WEAVE_TEST_ROOT, 'test-tmp') : tmpdir();
  return mkdtempSync(join(base, prefix));
}

function createLargeSessionFixture() {
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const session = {
    id: 'issue9-large-session',
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (event.type === 'system/message') return event.data?.message;
      if (event.type === 'assistant/message') return event.data?.message;
      if (event.type === 'user/message') return event.data;
      if (event.type === 'tool/result') {
        const msg = event.data?.message ?? event.data;
        return {
          role: 'tool',
          toolCallId: msg.toolCallId,
          content: msg.content,
          ...(msg.isError ? { isError: true } : {}),
        };
      }
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
      if (options.surfaceOp?.op === 'replace') {
        const start = surface.nodes.indexOf(options.surfaceOp.startSeq);
        const end = surface.nodes.indexOf(options.surfaceOp.endSeq);
        assert.ok(start >= 0 && end >= start, 'invalid surface replace range');
        surface.nodes.splice(start, end - start + 1, event.seq);
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
      { message: { role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } } },
      { surfaceOp: 'append' },
    );
  const addUser = (text, source = { kind: 'user' }, onSurface = true) =>
    session.append(
      'user/message',
      { id: `u-${events.length}`, role: 'user', content: [{ type: 'text', text }], source },
      onSurface ? { surfaceOp: 'append' } : {},
    );
  const addAssistant = (text, onSurface = true) =>
    session.append(
      'assistant/message',
      { message: { id: `a-${events.length}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } } },
      onSurface ? { surfaceOp: 'append' } : {},
    );
  const addToolPair = (callId, body, onSurface = true) => {
    const callEv = session.append('tool/call', { callId, name: 'read_file', arguments: JSON.stringify({ path: `src/f-${callId}.js` }) });
    const asstEv = session.append(
      'assistant/message',
      { message: { id: `a-${events.length}`, role: 'assistant', content: [{ type: 'tool-call', id: callId, callId, toolName: 'read_file', args: { path: `src/f-${callId}.js` } }], source: { kind: 'model', provider: 'p', model: 'm' } } },
      onSurface ? { surfaceOp: 'append' } : {},
    );
    const resEv = session.append(
      'tool/result',
      { message: { id: `t-${events.length}`, role: 'tool', toolCallId: callId, content: [{ type: 'text', text: body }], source: { kind: 'tool-result', callId } } },
      onSurface ? { surfaceOp: 'append', sourceEventSeqs: [callEv.seq] } : { sourceEventSeqs: [callEv.seq] },
    );
    return { callEv, asstEv, resEv };
  };

  return { events, surface, session, addSystem, addUser, addAssistant, addToolPair };
}

await test('large-63k-log-with-4-weave-checkpoints-non-monotonic-surface-and-external-date-fold', () => {
  const f = createLargeSessionFixture();
  f.addSystem('System policy prompt.');

  // Seed initial active rule and an early tool pair whose result will later be replaced
  // by tail events (seq >= 63683) to produce a non-monotonic surface.
  const rootRule = f.addUser('Keep integer cents for all invoice totals.');
  const earlyTool = f.addToolPair('early-stub-0', 'Initial large file contents '.repeat(200));

  const weaveCheckpoints = [];
  const eras = 4;
  const eventsPerEra = 15800; // 4 * 15800 = 63,200+ events

  for (let era = 0; era < eras; era += 1) {
    // Insert an external local-script / date-fold checkpoint between era 1 and era 2
    if (era === 2) {
      const extCid = 'local-date-fold-20261122';
      const bogusShadowedSeqs = Array.from({ length: 4500 }, (_, k) => 1000 + k);
      f.session.append('compaction/summary', {
        compactionId: extCid,
        provider: 'local-script',
        model: 'date-fold',
        shadowedRange: { start: 50000, end: 10000 },
        shadowedSeqs: bogusShadowedSeqs,
        summary: [{ type: 'text', text: 'External date-fold summary.' }],
      });
      f.addUser(
        [
          { type: 'text', text: 'External date-fold summary node.\n<compacted-summary>\nFolded 2026-11-22.\n</compacted-summary>' },
        ],
        {
          kind: 'compact-checkpoint',
          compactionId: extCid,
          provider: 'local-script',
          model: 'date-fold',
        },
        true,
      );
      // Also test a second external script checkpoint without provider/model on source
      // (identified via linked compaction/summary shadowedRange: start > end).
      const extCid2 = 'date-fold-summary-only';
      f.session.append('compaction/summary', {
        compactionId: extCid2,
        shadowedRange: { start: 50000, end: 10000 },
        shadowedSeqs: [10, 20],
        summary: [{ type: 'text', text: 'External reversed-range fold.' }],
      });
      f.addUser(
        'Legacy-shaped external fold checkpoint.',
        {
          kind: 'compact-checkpoint',
          compactionId: extCid2,
        },
        true,
      );
    }

    const eraStart = f.events.length;
    const ruleMsg = f.addUser(`Deploy era_${era} artifact to staging.`, { kind: 'user' }, false);
    const cancelMsg = f.addUser(`Cancel deploy era_${era} artifact to staging.`, { kind: 'user' }, false);
    const surviveMsg = f.addUser(`Retain era_${era} audit trail.`, { kind: 'user' }, false);
    const asstProgress = f.addAssistant(`Era ${era} milestone: verifiedCount: ${era + 1}.`, false);

    // Fill bulk of era with shadowed tool/call + assistant + tool/result events
    while (f.events.length - eraStart < eventsPerEra) {
      const idx = f.events.length;
      if (idx % 3 === 0) {
        f.addToolPair(`call-${idx}`, `Tool output ${idx}`, false);
      } else {
        f.addAssistant(`Assistant step ${idx}.`, false);
      }
    }

    // Build authentic Weave checkpoint referencing this era's decisions and progress facts
    const selection = selectMemoryMessages(
      [
        { seq: ruleMsg.seq, sourceKind: 'user', text: ruleMsg.data.content[0].text, blocks: ruleMsg.data.content },
        { seq: cancelMsg.seq, sourceKind: 'user', text: cancelMsg.data.content[0].text, blocks: cancelMsg.data.content },
        { seq: surviveMsg.seq, sourceKind: 'user', text: surviveMsg.data.content[0].text, blocks: surviveMsg.data.content },
      ],
      { maxMessages: Infinity, maxTokens: Infinity },
    );
    const decisions = memoryDecisionsForSource(selection.decisions, f.session);
    const memRefs = memorySourceRefs(
      [{ seq: surviveMsg.seq, text: surviveMsg.data.content[0].text, blocks: surviveMsg.data.content }],
      f.session,
    );
    // Keep one legacy-style fragment ref without layout to exercise restoreCheckpointMemory index
    if (era === 0) delete memRefs[0].layout;
    const facts = extractProgressFacts(`Era ${era} milestone: verifiedCount: ${era + 1}.`, {
      seq: asstProgress.seq,
      sha256: progressSourceRefs({
        local: extractProgressFacts(`Era ${era} milestone: verifiedCount: ${era + 1}.`, {
          seq: asstProgress.seq,
          sha256: 'placeholder',
        }),
      }).sources?.[0]?.sha256 ?? '',
    });
    // Use createProgressSelector on [asstProgress.seq] to compute real sha256 progressSourceRefs
    const tmpProgress = createProgressSelector({
      surface: { nodes: [asstProgress.seq], replaceGeneration: 0 },
      eventAt: f.session.eventAt,
      deriveEventMessage: f.session.deriveEventMessage,
      seq: f.session.seq,
    })([asstProgress.seq]);
    const pRefs = progressSourceRefs(tmpProgress);
    assert.ok(facts.length >= 1 && pRefs.sources.length === 1);

    const cpId = `weave-cp-${era}`;
    f.session.append('compaction/summary', {
      compactionId: cpId,
      shadowedRange: { start: eraStart, end: f.events.length - 1 },
      shadowedSeqs: [ruleMsg.seq, cancelMsg.seq, surviveMsg.seq, asstProgress.seq],
      summary: [{ type: 'text', text: `Summary for era ${era}.` }],
    });
    const preserved = preservedForSource([
      { seq: surviveMsg.seq, blocks: surviveMsg.data.content, text: surviveMsg.data.content[0].text },
    ]);
    const blocks = buildCheckpointBlocks(
      [{ type: 'text', text: `## 1. Primary Request and Intent\n- Retain era_${era} audit trail.` }],
      preserved,
      CHECKPOINT_PREAMBLE,
    );
    const cpEv = f.addUser(
      blocks,
      {
        kind: 'compact-checkpoint',
        compactionId: cpId,
        memorySources: memRefs,
        preserved,
        memoryDecisions: decisions,
        progressFacts: pRefs,
      },
      true,
    );
    weaveCheckpoints.push(cpEv.seq);
  }

  // Add live working tail nodes + push session length >= 63,700
  while (f.events.length < 63400) {
    f.addAssistant(`Historical filler event ${f.events.length}`, false);
  }
  const liveUser = f.addUser('Preserve deterministic JSON output. verifiedCount: 99.', { kind: 'user' }, true);
  for (let i = 0; i < 295; i += 1) {
    f.addAssistant(`Surface live step ${i}: incremental evidence details.`, true);
  }
  const liveAsst1 = f.addAssistant('Working analysis block. '.repeat(260), true);
  const liveAsst2 = f.addAssistant('Follow-up progress note. '.repeat(260), true);
  const liveTailUser = f.addUser('Continue final check.', { kind: 'user' }, true);

  // Place tail replacement stubs (seq >= 63,683+) early on surface.nodes -> non-monotonic surface!
  const replaceStub = f.session.append(
    'tool/result',
    {
      message: {
        id: 'stub-replaced-early',
        role: 'tool',
        toolCallId: 'early-stub-0',
        content: [{ type: 'text', text: '[Tool output archived: stub]' }],
        source: { kind: 'tool-result', callId: 'early-stub-0' },
      },
    },
    { surfaceOp: { op: 'replace', startSeq: earlyTool.resEv.seq, endSeq: earlyTool.resEv.seq }, sourceEventSeqs: [earlyTool.resEv.seq] },
  );
  assert.ok(f.events.length >= 63700, `expected >= 63700 events, got ${f.events.length}`);
  assert.ok(replaceStub.seq >= 63683, `expected tail replace stub >= 63683, got ${replaceStub.seq}`);
  assert.ok(f.surface.nodes.indexOf(replaceStub.seq) < f.surface.nodes.indexOf(weaveCheckpoints[0]));
  assert.equal(weaveCheckpoints.length, 4);

  // 1a. createSessionMemorySelector cold & warm timings
  const tMem0 = performance.now();
  const memSelector = createSessionMemorySelector(f.session);
  const memColdMs = performance.now() - tMem0;
  assert.ok(memColdMs < 1000, `createSessionMemorySelector cold took ${memColdMs.toFixed(1)}ms`);

  const tMemWarm0 = performance.now();
  const memSelectorCached = createSessionMemorySelector(f.session);
  const memWarmMs = performance.now() - tMemWarm0;
  assert.ok(memWarmMs < 50, `createSessionMemorySelector cached took ${memWarmMs.toFixed(1)}ms`);

  const selectedAll = memSelector(f.surface.nodes, { maxMessages: 32, maxTokens: 4096 });
  assert.ok(selectedAll.active.some((m) => m.seq === rootRule.seq));
  assert.ok(selectedAll.active.some((m) => m.seq === liveUser.seq));
  assert.equal(selectedAll.decisions.filter((d) => d.reason === 'cancelled').length, 4);

  const selectedCached = memSelectorCached(f.surface.nodes, { maxMessages: 32, maxTokens: 4096 });
  assert.equal(selectedCached.decisions.length, selectedAll.decisions.length);

  // 1b. createProgressSelector cold & warm timings + external script skip
  const tProg0 = performance.now();
  const progSelector = createProgressSelector(f.session);
  const progColdMs = performance.now() - tProg0;
  assert.ok(progColdMs < 1000, `createProgressSelector cold took ${progColdMs.toFixed(1)}ms`);

  const tProgWarm0 = performance.now();
  const progSelectorCached = createProgressSelector(f.session);
  const progWarmMs = performance.now() - tProgWarm0;
  assert.ok(progWarmMs < 50, `createProgressSelector cached took ${progWarmMs.toFixed(1)}ms`);

  const progResult = progSelector(f.surface.nodes);
  assert.ok(progResult.effective.some((fact) => fact.key === 'verifiedCount' && fact.value === 99));
  assert.equal(progSelectorCached(f.surface.nodes).effective.length, progResult.effective.length);

  // Ensure collectRecentUserMessages also skips external date-fold checkpoints cleanly
  const recentUsers = collectRecentUserMessages(f.session, f.surface.nodes, { maxMessages: 32, maxTokens: 16384 });
  assert.ok(recentUsers.some((u) => u.seq === liveTailUser.seq));

  // 1c. selectCachePreservingRange timing (with cacheMaxCheckpoints raised so full path runs)
  const measurement = {
    nodes: f.surface.nodes.map((seq) => ({
      seq,
      tokens: approxTokens(blocksToText(f.session.deriveEventMessage(f.session.eventAt(seq))?.content)) + (seq === liveAsst1.seq || seq === liveAsst2.seq ? 12000 : 50),
    })),
  };
  measurement.totalTokens = measurement.nodes.reduce((sum, n) => sum + n.tokens, 0);
  const cfg = resolveConfig({ cacheMaxCheckpoints: 10, cacheMinSavingsTokens: 2048, maxTokens: 2048, preserveRecentUserTokens: 1024 }).config;
  const tCache0 = performance.now();
  const cacheRange = selectCachePreservingRange(f.session, measurement, 10, cfg, 16000);
  const cacheMs = performance.now() - tCache0;
  assert.ok(cacheMs < 1000, `selectCachePreservingRange took ${cacheMs.toFixed(1)}ms`);
  assert.ok(cacheRange !== null);

  // 1d. planSummaryRange timing
  const capacity = {
    targets: [{ provider: 'p', model: 'm', window: 200000, output: 2048, margin: 4096, inputRatio: 0.75, maxInputBytes: 200000, scale: 1 }],
    shrinkLimit: Infinity,
  };
  const tPlan0 = performance.now();
  const plan = planSummaryRange(
    f.session,
    { start: f.surface.nodes[1], end: f.surface.nodes.at(-1) },
    capacity,
    { language: 'en' },
  );
  const planMs = performance.now() - tPlan0;
  assert.ok(planMs < 1000, `planSummaryRange took ${planMs.toFixed(1)}ms`);
  assert.ok(plan.end !== undefined);
});

await test('selectMemoryMessages-4-index-cancellation-speed-and-exact-semantics', () => {
  const messages = [];
  for (let i = 0; i < 650; i += 1) {
    messages.push({ seq: messages.length, sourceKind: 'user', text: `Generate report_item_${i}.`, blocks: [{ type: 'text', text: `Generate report_item_${i}.` }] });
  }
  for (let i = 0; i < 60; i += 1) {
    messages.push({ seq: messages.length, sourceKind: 'user', text: `Cancel generate report_item_${i}.`, blocks: [{ type: 'text', text: `Cancel generate report_item_${i}.` }] });
  }
  // actionState canonical equivalence + prohibition protection (!orig.negative)
  const seqAlpha = messages.length;
  messages.push({ seq: seqAlpha, sourceKind: 'user', text: '请生成alpha模块。', blocks: [{ type: 'text', text: '请生成alpha模块。' }] });
  messages.push({ seq: messages.length, sourceKind: 'user', text: '取消生成alpha模块。', blocks: [{ type: 'text', text: '取消生成alpha模块。' }] });
  const seqNeg = messages.length;
  messages.push({ seq: seqNeg, sourceKind: 'user', text: '不要删除审计日志。', blocks: [{ type: 'text', text: '不要删除审计日志。' }] });
  messages.push({ seq: messages.length, sourceKind: 'user', text: '取消删除审计日志。', blocks: [{ type: 'text', text: '取消删除审计日志。' }] });
  // Unique 2-char prefix match
  const seqPrefixUnique = messages.length;
  messages.push({ seq: seqPrefixUnique, sourceKind: 'user', text: '部署灰度集群七号。', blocks: [{ type: 'text', text: '部署灰度集群七号。' }] });
  messages.push({ seq: messages.length, sourceKind: 'user', text: '取消部署灰度。', blocks: [{ type: 'text', text: '取消部署灰度。' }] });
  // Ambiguous 2-char prefix rejection
  const seqAmb1 = messages.length;
  messages.push({ seq: seqAmb1, sourceKind: 'user', text: '上传到节点Alpha。', blocks: [{ type: 'text', text: '上传到节点Alpha。' }] });
  const seqAmb2 = messages.length;
  messages.push({ seq: seqAmb2, sourceKind: 'user', text: '上传到节点Beta。', blocks: [{ type: 'text', text: '上传到节点Beta。' }] });
  const seqAmbCancel = messages.length;
  messages.push({ seq: seqAmbCancel, sourceKind: 'user', text: '取消上传。', blocks: [{ type: 'text', text: '取消上传。' }] });
  // previous cancellation
  const seqPrev = messages.length;
  messages.push({ seq: seqPrev, sourceKind: 'user', text: '生成临时图表。', blocks: [{ type: 'text', text: '生成临时图表。' }] });
  messages.push({ seq: messages.length, sourceKind: 'user', text: '取消上一条。', blocks: [{ type: 'text', text: '取消上一条。' }] });

  const t0 = performance.now();
  const result = selectMemoryMessages(messages, { maxMessages: Infinity, maxTokens: Infinity });
  const elapsedMs = performance.now() - t0;
  assert.ok(elapsedMs < 500, `selectMemoryMessages with 700+ rules took ${elapsedMs.toFixed(1)}ms`);

  const activeSeqs = new Set(result.active.map((m) => m.seq));
  for (let i = 0; i < 60; i += 1) assert.equal(activeSeqs.has(i), false);
  for (let i = 60; i < 650; i += 1) assert.equal(activeSeqs.has(i), true);
  assert.equal(activeSeqs.has(seqAlpha), false, 'canonical actionState cancellation');
  assert.equal(activeSeqs.has(seqNeg), true, 'negative prohibition must not be cancelled by cancel');
  assert.equal(activeSeqs.has(seqPrefixUnique), false, 'unique 2-char prefix must cancel');
  assert.equal(activeSeqs.has(seqAmb1), true, 'ambiguous prefix target 1 must survive');
  assert.equal(activeSeqs.has(seqAmb2), true, 'ambiguous prefix target 2 must survive');
  assert.equal(activeSeqs.has(seqAmbCancel), true, 'unapplied ambiguous cancel remains active');
  assert.equal(activeSeqs.has(seqPrev), false, 'previous cancellation must cancel immediate prior task');
});

await test('tampered-sha256-and-in-place-mutations-fail-closed-even-with-cache', () => {
  // Large session with seq >= 600 and maxBy >= 300 (replay cache active)
  const events = [];
  for (let i = 0; i < 600; i += 1) {
    events.push({
      seq: i,
      type: 'user/message',
      data: { id: `u-${i}`, role: 'user', content: [{ type: 'text', text: i === 10 ? '生成地图。' : i === 350 ? '取消生成地图。' : `Rule item ${i}.` }], source: { kind: 'user' } },
    });
  }
  const session = {
    surface: { nodes: [599], replaceGeneration: 0 },
    get seq() { return events.length; },
    eventAt: (seq) => events[seq],
    deriveEventMessage: (e) => e?.data,
  };
  const selected = selectMemoryMessages(
    [
      { seq: 10, sourceKind: 'user', text: '生成地图。', blocks: [{ type: 'text', text: '生成地图。' }] },
      { seq: 350, sourceKind: 'user', text: '取消生成地图。', blocks: [{ type: 'text', text: '取消生成地图。' }] },
    ],
    { maxMessages: Infinity, maxTokens: Infinity },
  );
  const decisions = memoryDecisionsForSource(selected.decisions, session);
  const cancelled = decisions.find((d) => d.reason === 'cancelled');
  assert.ok(cancelled);

  // Warm cache & confirm cache hit via stage-trace
  const seenEvents = [];
  withStageTraceContext({ enabled: true, onEvent: (ev) => seenEvents.push(ev) }, () => {
    const r1 = restoreRetiredDecisions([cancelled], session, 600);
    const r2 = restoreRetiredDecisionsBatch([{ checkpointSeq: 600, decisions: [cancelled] }], session);
    assert.equal(r1[0].text, '生成地图。');
    assert.equal(r2[0].text, '生成地图。');
  });
  const ends = seenEvents.filter((e) => e.stage === 'restoreRetiredDecisions' && e.phase === 'end');
  assert.equal(ends.length, 2);
  assert.equal(ends[0].hitCache, false);
  assert.equal(ends[1].hitCache, true);

  // 1) Tampered sourceSha256 & bySha256 fail closed
  assert.throws(
    () => restoreRetiredDecisions([{ ...cancelled, sourceSha256: '0'.repeat(64) }], session, 600),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE',
  );
  assert.throws(
    () => restoreRetiredDecisions([{ ...cancelled, bySha256: 'f'.repeat(64) }], session, 600),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE',
  );

  // 2) In-place mutation of events[10] fails closed even without sha fields on legacy decision
  const legacyNoHash = { ...cancelled };
  delete legacyNoHash.sourceSha256;
  delete legacyNoHash.bySha256;
  events[10].data.content = [{ type: 'text', text: '生成报告。' }];
  assert.throws(
    () => restoreRetiredDecisions([cancelled], session, 600),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE',
  );
  assert.throws(
    () => restoreRetiredDecisions([legacyNoHash], session, 600),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE',
  );
  events[10].data.content = [{ type: 'text', text: '生成地图。' }];
  assert.equal(restoreRetiredDecisions([cancelled], session, 600)[0].text, '生成地图。');

  // 3) In-place mutation of actor events[350] fails closed
  events[350].data.content = [{ type: 'text', text: '继续执行。' }];
  assert.throws(
    () => restoreRetiredDecisions([legacyNoHash], session, 600),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE',
  );
  events[350].data.content = [{ type: 'text', text: '取消生成地图。' }];

  // 4) Mock session WITHOUT session.seq mutating events[0] in place
  const smallEvents = [
    { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: '生成地图。' }], source: { kind: 'user' } } },
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '取消生成地图。' }], source: { kind: 'user' } } },
  ];
  const smallSession = { eventAt: (seq) => smallEvents[seq], deriveEventMessage: (e) => e?.data };
  const smallDecisions = memoryDecisionsForSource(
    selectMemoryMessages(
      smallEvents.map((e) => ({ seq: e.seq, sourceKind: 'user', text: e.data.content[0].text, blocks: e.data.content })),
      { maxMessages: Infinity, maxTokens: Infinity },
    ).decisions,
    smallSession,
  );
  assert.equal(restoreRetiredDecisions(smallDecisions, smallSession, 2)[0].text, '生成地图。');
  smallEvents[0].data.content = [{ type: 'text', text: '生成表格。' }];
  assert.throws(
    () => restoreRetiredDecisions(smallDecisions, smallSession, 2),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE',
  );
});

await test('planSummaryRange-bounded-probes-on-200-plus-non-shrinkable-and-checkpoint-precheck', () => {
  const f = createLargeSessionFixture();
  f.addSystem('System.');
  // 220 short user constraints: each individual/cumulative span is < checkpoint overhead, so non-shrinkable
  for (let i = 0; i < 220; i += 1) {
    f.addUser(`Rule ${i}: ok.`);
  }
  const capacity = {
    targets: [{ provider: 'p', model: 'm', window: 1_000_000, output: 2048, margin: 4096, inputRatio: 1, maxInputBytes: 1_000_000, scale: 1 }],
    shrinkLimit: Infinity,
  };
  let probes = 0;
  const t0 = performance.now();
  assert.throws(
    () =>
      planSummaryRange(f.session, { start: 1, end: 220 }, capacity, {
        language: 'en',
        policy: { preserveRecentMessages: 500, preserveRecentUserTokens: 500_000 },
        pricedInput: () => {
          probes += 1;
          return 0;
        },
      }),
    (err) => err?.code === 'SUMMARY_NOT_SMALLER' && err?.localCapacityRejection === true,
  );
  const elapsedMs = performance.now() - t0;
  assert.ok(probes > 0 && probes <= 64, `expected bounded probes <= 64, got ${probes}`);
  assert.ok(elapsedMs < 500, `220 non-shrinkable candidates took ${elapsedMs.toFixed(1)}ms`);

  // Gentle pre-check on single compact-checkpoint span
  const g = createLargeSessionFixture();
  g.addSystem('System.');
  const u = g.addUser('Short rule.', { kind: 'user' }, false);
  const cpText = 'Compact note.';
  const cp = g.addUser(
    [{ type: 'text', text: cpText }],
    {
      kind: 'compact-checkpoint',
      compactionId: 'weave-single-cp',
      memorySources: memorySourceRefs([{ seq: u.seq, text: 'Short rule.', blocks: u.data.content }], g.session),
      preserved: preservedForSource([{ seq: u.seq, blocks: u.data.content, text: 'Short rule.' }]),
    },
    true,
  );
  let precheckProbes = 0;
  assert.throws(
    () =>
      planSummaryRange(g.session, { start: cp.seq, end: cp.seq }, capacity, {
        language: 'en',
        pricedInput: () => {
          precheckProbes += 1;
          return 0;
        },
      }),
    (err) => err?.code === 'SUMMARY_NOT_SMALLER' && err?.localCapacityRejection === true,
  );
  assert.ok(precheckProbes <= 1, `expected <= 1 probe on single non-shrinkable checkpoint, got ${precheckProbes}`);

  // External script checkpoint classifier direct edge coverage
  assert.equal(
    isExternalScriptCheckpoint(
      { data: { source: { kind: 'compact-checkpoint' } } },
      { data: { shadowedSeqs: Array.from({ length: 80 }, (_, k) => (k === 70 ? 5 : k)) } },
    ),
    true,
  );
  assert.equal(
    isExternalScriptCheckpoint(
      { data: { source: { kind: 'compact-checkpoint', progressFacts: { version: 2, sources: [] } } } },
      { data: { shadowedRange: { start: 100, end: 10 } } },
    ),
    false,
  );
});

await test('stage-trace-zero-io-disabled-sync-jsonl-privacy-sanitizer-and-rotation', async () => {
  const root = makeTempRoot('issue9-trace-');
  const priorEnv = process.env.WEAVE_TRACE_STAGES;
  const priorPath = process.env.WEAVE_TRACE_STAGES_PATH;
  try {
    delete process.env.WEAVE_TRACE_STAGES;
    delete process.env.WEAVE_TRACE_STAGES_PATH;

    // 1) Disabled: zero disk I/O
    assert.equal(isStageTraceEnabled(), false);
    assert.equal(isStageTraceEnabled({ debug: false }), false);
    assert.equal(isStageTraceEnabled({ debug: true }), true);
    const disabledDir = join(root, 'disabled-dir');
    const disabledVal = withStageTraceContext({ enabled: false, storageRoot: disabledDir, sessionId: 'raw-secret-sid' }, () => {
      traceStagePoint('noopPoint', { checkpoints: 1, text: 'SECRET_PROSE' });
      return traceStageSync('noopSync', { surfaceLen: 5 }, () => 42);
    });
    assert.equal(disabledVal, 42);
    assert.equal(existsSync(disabledDir), false, 'disabled tracer must create no directory or file');

    // 2) Sanitizer unit verification
    const fakeSecret = 'sk-' + 'secretvalue1234567890'.repeat(2);
    const clean = sanitizeStageMeta({
      checkpoints: 4,
      decisions: 12,
      hitCache: true,
      code: 'SUMMARY_NOT_SMALLER',
      text: 'Do not delete production backups.',
      prompt: 'SENSITIVE_PROMPT_TEXT',
      filePath: 'C:/Users/Public/secret-folder/file.js',
      path: '/home/user/private.key',
      sessionId: 'raw-session-id',
      token: fakeSecret,
      secret: 'top-secret',
      codeBad: 'invalid/path/like',
      ts: 'spoof-ts',
      stage: 'spoof-stage',
      phase: 'spoof-phase',
      elapsedMs: 99999,
      sessionHash: 'spoofhash',
    });
    assert.deepEqual(clean, {
      checkpoints: 4,
      decisions: 12,
      hitCache: true,
      code: 'SUMMARY_NOT_SMALLER',
    });

    // 3) Enabled via withStageTraceContext & WEAVE_TRACE_STAGES=1 -> synchronous JSONL on disk, zero prose/paths/secrets
    const traceRoot = join(root, 'trace-enabled');
    const secretProse = 'SENSITIVE_USER_SECRET_PROMPT_XYZ';
    const secretPath = 'C:/Users/Public/secret-folder/credential.txt';
    await withStageTraceContext(
      { enabled: true, storageRoot: traceRoot, sessionId: 'secret-session-id-123' },
      async () => {
        traceStagePoint('pointCheck', {
          checkpoints: 3,
          prompt: secretProse,
          filePath: secretPath,
          token: fakeSecret,
        });
        await traceStageAsync(
          'asyncCheck',
          { rangeLen: 10, text: secretProse },
          async () => 'ok',
          () => ({ scanned: 7, cached: true, message: secretProse }),
        );
        // Run real selector under trace context with sensitive prose in session
        const f = createLargeSessionFixture();
        f.addSystem('System.');
        f.addUser(`${secretProse} ${secretPath}`);
        createSessionMemorySelector(f.session);
        createProgressSelector(f.session);
      },
    );

    const traceFile = join(traceRoot, 'stage-trace.jsonl');
    assert.equal(existsSync(traceFile), true, 'stage-trace.jsonl must be flushed synchronously');
    const raw = readFileSync(traceFile, 'utf8');
    assert.equal(raw.includes(secretProse), false);
    assert.equal(raw.includes('secret-folder'), false);
    assert.equal(raw.includes('secret-session-id-123'), false);
    assert.equal(raw.includes(fakeSecret), false);

    const lines = raw.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(lines.some((l) => l.stage === 'pointCheck' && l.phase === 'point' && l.checkpoints === 3));
    assert.ok(lines.some((l) => l.stage === 'asyncCheck' && l.phase === 'start' && l.rangeLen === 10));
    assert.ok(
      lines.some(
        (l) =>
          l.stage === 'asyncCheck' &&
          l.phase === 'end' &&
          l.ok === true &&
          typeof l.elapsedMs === 'number' &&
          l.scanned === 7 &&
          l.cached === true,
      ),
    );
    assert.ok(lines.some((l) => l.stage === 'createSessionMemorySelector' && l.phase === 'end'));
    assert.ok(lines.some((l) => l.stage === 'createProgressSelector' && l.phase === 'end'));
    for (const line of lines) {
      assert.match(line.sessionHash, /^[a-f0-9]{12}$/);
      assert.ok(['start', 'end', 'point'].includes(line.phase));
      assert.ok(typeof line.ts === 'string');
    }

    // 4) WEAVE_TRACE_STAGES=1 + WEAVE_TRACE_STAGES_PATH + 4 MiB rotation + unwritable path safety
    const rotPath = join(root, 'rot', 'custom-trace.jsonl');
    process.env.WEAVE_TRACE_STAGES = '1';
    process.env.WEAVE_TRACE_STAGES_PATH = rotPath;
    withStageTraceContext({ enabled: false }, () => {
      traceStagePoint('envActive', { count: 1 });
    });
    assert.equal(existsSync(rotPath), true);
    writeFileSync(rotPath, Buffer.alloc(4 * 1024 * 1024 + 64, 0x78));
    traceStagePoint('afterRotate', { count: 2 });
    assert.equal(existsSync(`${rotPath}.1`), true, 'oversized trace file (> 4 MiB) must rotate');
    assert.ok(readFileSync(rotPath, 'utf8').includes('afterRotate'));

    // Unwritable filePath (parent is an existing regular file) must swallow I/O error cleanly
    const blockingFile = join(root, 'blocking-file');
    writeFileSync(blockingFile, 'not-a-dir');
    const safeResult = withStageTraceContext(
      { enabled: true, filePath: join(blockingFile, 'nested', 'stage-trace.jsonl') },
      () => traceStageSync('swallowIo', { count: 1 }, () => 'compaction-survived'),
    );
    assert.equal(safeResult, 'compaction-survived');
  } finally {
    if (priorEnv === undefined) delete process.env.WEAVE_TRACE_STAGES;
    else process.env.WEAVE_TRACE_STAGES = priorEnv;
    if (priorPath === undefined) delete process.env.WEAVE_TRACE_STAGES_PATH;
    else process.env.WEAVE_TRACE_STAGES_PATH = priorPath;
    rmSync(root, { recursive: true, force: true });
  }
});

await test('engine-secondary-compaction-63k-with-stage-trace-and-precheck', async () => {
  const root = makeTempRoot('weave-issue9-e2e-');
  const priorEnv = process.env.WEAVE_TRACE_STAGES;
  const priorPath = process.env.WEAVE_TRACE_STAGES_PATH;
  try {
    const f = createLargeSessionFixture();
    f.session.header = { version: 4, id: 'issue9-e2e-sess', createdAt: Date.now() };
    f.addSystem('System policy prompt.');
    const earlyTool = f.addToolPair('e2e-stub-0', 'Initial large tool body '.repeat(60));

    // Populate 63,500+ events across 4 Weave checkpoints + external local-script/date-fold
    for (let era = 0; era < 4; era += 1) {
      if (era === 2) {
        const extCid = 'e2e-local-date-fold';
        f.session.append('compaction/summary', {
          compactionId: extCid,
          provider: 'local-script',
          model: 'date-fold',
          shadowedRange: { start: 50000, end: 10000 },
          shadowedSeqs: Array.from({ length: 4500 }, (_, k) => 1000 + k),
          summary: [{ type: 'text', text: 'External date-fold summary.' }],
        });
        f.addUser(
          [{ type: 'text', text: 'External date-fold summary node.' }],
          {
            kind: 'compact-checkpoint',
            compactionId: extCid,
            provider: 'local-script',
            model: 'date-fold',
          },
          true,
        );
      }
      const eraStart = f.events.length;
      const ruleMsg = f.addUser(`Deploy e2e_${era} service to staging.`, { kind: 'user' }, false);
      const cancelMsg = f.addUser(`Cancel deploy e2e_${era} service to staging.`, { kind: 'user' }, false);
      const keepMsg = f.addUser(`Keep e2e_${era} integer cents.`, { kind: 'user' }, false);
      const progMsg = f.addAssistant(`Milestone e2e_${era}: verifiedCount: ${era + 1}.`, false);
      while (f.events.length - eraStart < 15950) {
        f.addAssistant(`Historical filler ${f.events.length}`, false);
      }
      const sel = selectMemoryMessages(
        [
          { seq: ruleMsg.seq, sourceKind: 'user', text: ruleMsg.data.content[0].text, blocks: ruleMsg.data.content },
          { seq: cancelMsg.seq, sourceKind: 'user', text: cancelMsg.data.content[0].text, blocks: cancelMsg.data.content },
          { seq: keepMsg.seq, sourceKind: 'user', text: keepMsg.data.content[0].text, blocks: keepMsg.data.content },
        ],
        { maxMessages: Infinity, maxTokens: Infinity },
      );
      const decisions = memoryDecisionsForSource(sel.decisions, f.session);
      const memRefs = memorySourceRefs(
        [{ seq: keepMsg.seq, text: keepMsg.data.content[0].text, blocks: keepMsg.data.content }],
        f.session,
      );
      const tmpProg = createProgressSelector({
        surface: { nodes: [progMsg.seq], replaceGeneration: 0 },
        eventAt: f.session.eventAt,
        deriveEventMessage: f.session.deriveEventMessage,
        seq: f.session.seq,
      })([progMsg.seq]);
      const pRefs = progressSourceRefs(tmpProg);
      const cpId = `e2e-cp-${era}`;
      f.session.append('compaction/summary', {
        compactionId: cpId,
        shadowedRange: { start: eraStart, end: f.events.length - 1 },
        shadowedSeqs: [ruleMsg.seq, cancelMsg.seq, keepMsg.seq, progMsg.seq],
        summary: [{ type: 'text', text: `Summary era ${era}` }],
      });
      const preserved = preservedForSource([
        { seq: keepMsg.seq, blocks: keepMsg.data.content, text: keepMsg.data.content[0].text },
      ]);
      const blocks = buildCheckpointBlocks(
        [{ type: 'text', text: `## 1. Primary Request and Intent\n- Keep e2e_${era} integer cents.` }],
        preserved,
        CHECKPOINT_PREAMBLE,
      );
      f.addUser(
        blocks,
        {
          kind: 'compact-checkpoint',
          compactionId: cpId,
          memorySources: memRefs,
          preserved,
          memoryDecisions: decisions,
          progressFacts: pRefs,
        },
        true,
      );
    }

    // Non-monotonic surface stub at seq >= 63,500
    f.session.append(
      'tool/result',
      {
        message: {
          id: 'tail-stub',
          role: 'tool',
          toolCallId: 'e2e-stub-0',
          content: [{ type: 'text', text: 'Replaced early tool stub.' }],
          source: { kind: 'tool-result', callId: 'e2e-stub-0' },
        },
      },
      {
        surfaceOp: { op: 'replace', startSeq: earlyTool.resEv.seq, endSeq: earlyTool.resEv.seq },
        sourceEventSeqs: [earlyTool.callEv.seq],
      },
    );

    const secretProse = 'SECRET-E2E-PROSE-NEVER-TRACE-991';
    for (let k = 0; k < 10; k += 1) {
      f.addAssistant(`Large new analysis block ${k} `.repeat(320), true);
    }
    f.addUser(`Keep integer cents and ${secretProse}.`, { kind: 'user' }, true);
    f.addAssistant('Large recent tail analysis block '.repeat(220), true);
    f.addUser('Final check.', { kind: 'user' }, true);
    f.session.append('turn/start', { turn: 99 });
    assert.ok(f.events.length >= 63500);

    const headings = buildCompactionInstruction('en')
      .split('\n')
      .filter((line) => /^## [1-9]\./.test(line));
    const keptConstraints = [
      'Keep e2e_0 integer cents.',
      'Keep e2e_1 integer cents.',
      'Keep e2e_2 integer cents.',
      'Keep e2e_3 integer cents.',
      'Keep integer cents.',
    ].join(' ');
    const llmSummary = headings
      .map((h, i) => `${h}\n${i === 2 ? keptConstraints : i === 5 ? '[filled by engine]' : i === 8 ? 'Next: continue.' : 'Summary ok.'}`)
      .join('\n\n');

    const tracePath = join(root, 'stage-trace.jsonl');
    process.env.WEAVE_TRACE_STAGES = '1';
    process.env.WEAVE_TRACE_STAGES_PATH = tracePath;

    let llmCalls = 0;
    const forceHighSessions = new WeakMap();
    const ctx = {
      on() { return () => {}; },
      provide() {},
      get() { return undefined; },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      tokenMeter: {
        measure(s) {
          if (forceHighSessions.has(s)) {
            const forced = forceHighSessions.get(s);
            const nodes = s.surface.nodes.map((seq) => ({ seq, tokens: 3000, heuristicTokens: 3000 }));
            return { totalTokens: forced, surfaceTokens: forced, nodes, baseline: { kind: 'heuristic' } };
          }
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
        resolveModelInfo: async () => ({ contextWindow: 65536, maxOutputTokens: 4096 }),
        async *stream() {
          llmCalls += 1;
          yield { type: 'text-delta', text: llmSummary };
          yield { type: 'finish', kind: 'stop', usage: { inputTokens: 100, outputTokens: 40 } };
        },
      },
      sessions: {
        flush: async () => true,
        get: (id) => (id === f.session.id ? f.session : null),
      },
      tools: { register: () => () => {} },
    };

    const config = resolveConfig({
      archiveDir: join(root, 'archive'),
      proactiveEnabled: false,
      auto: true,
      headroomTokens: 4096,
      maxTokens: 4096,
      thresholdRatio: 0.3,
      retainTokens: 1500,
      minimumReductionRatio: 0.1,
      continuationEnabled: false,
      postCompactReinjectEnabled: false,
      persistedOutputEnabled: false,
      microcompactEnabled: false,
      diskLivenessCheck: false,
      summaryRetryCount: 0,
      language: 'en',
    }).config;

    const engine = new WeaveCompactionEngine(ctx, config);
    engine.historyToolsAvailable = true;
    const agent = {
      session: f.session,
      options: { provider: 'p', model: 'm' },
      async runMaintenance(fn) { return await fn(new AbortController().signal); },
    };

    const started = performance.now();
    const res = await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal);
    const elapsedMs = performance.now() - started;
    assert.ok(res && res.compactionId, '63k secondary compaction must succeed');
    assert.ok(llmCalls >= 1 && llmCalls <= 6, `expected bounded LLM calls, got ${llmCalls}`);
    assert.ok(elapsedMs < 3000, `expected bounded <3000ms secondary compaction, got ${elapsedMs.toFixed(1)}ms`);

    const traceRaw = readFileSync(tracePath, 'utf8');
    assert.equal(traceRaw.includes(secretProse), false, 'stage trace must never leak conversation prose');
    const stagesSeen = new Set(traceRaw.trim().split('\n').map((l) => JSON.parse(l).stage));
    for (const expectedStage of [
      'measure',
      'selectCachePreservingRange',
      'planSummaryRange',
      'createSessionMemorySelector',
      'restoreRetiredDecisions',
      'createProgressSelector',
      'beforeRequest',
    ]) {
      assert.equal(stagesSeen.has(expectedStage), true, `missing expected trace stage: ${expectedStage}`);
    }

    // Also confirm recoverPending emits trace when called
    await engine.recoverPending(f.session);
    const afterRecoverRaw = readFileSync(tracePath, 'utf8');
    const stagesAfterRecover = new Set(afterRecoverRaw.trim().split('\n').map((l) => JSON.parse(l).stage));
    assert.equal(stagesAfterRecover.has('recoverPending'), true);

    // Gentle pre-check: checkpoint-only surface bails gently without spinning or calling LLM
    const cpOnly = createLargeSessionFixture();
    cpOnly.session.header = { version: 4, id: 'issue9-precheck-only-cp', createdAt: Date.now() };
    cpOnly.addSystem('Sys.');
    cpOnly.addUser(
      buildCheckpointBlocks([{ type: 'text', text: '## 1. Intent\nDone.' }], [], CHECKPOINT_PREAMBLE),
      { kind: 'compact-checkpoint', compactionId: 'cp-only-1' },
      true,
    );
    forceHighSessions.set(cpOnly.session, 24000);
    const callsBeforePrecheck = llmCalls;
    const precheckRes = await engine.compactIfNeeded(
      { session: cpOnly.session, options: { provider: 'p', model: 'm' }, runMaintenance: (fn) => fn(new AbortController().signal) },
      'pressure',
      new AbortController().signal,
    );
    assert.equal(precheckRes, null, 'checkpoint-only surface should bail gently');
    assert.equal(llmCalls, callsBeforePrecheck, 'gentle pre-check must make 0 LLM calls');
    const finalTraceLines = readFileSync(tracePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(finalTraceLines.some((l) => l.stage === 'secondaryPrecheck' && l.precheck === true && l.reason === 'checkpoint-only'));
  } finally {
    if (priorEnv === undefined) delete process.env.WEAVE_TRACE_STAGES;
    else process.env.WEAVE_TRACE_STAGES = priorEnv;
    if (priorPath === undefined) delete process.env.WEAVE_TRACE_STAGES_PATH;
    else process.env.WEAVE_TRACE_STAGES_PATH = priorPath;
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
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
