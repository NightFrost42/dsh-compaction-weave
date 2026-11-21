import assert from 'node:assert/strict';
import {
  BILI_UNIQUE_TOOLS,
  BILI_GENERIC_TOOLS,
  isExternalFoldEvent,
  detectBiliSession,
  buildBiliMigrationPlan,
} from '../lib/foreign-fold.js';
import { collectProgressFacts } from '../lib/progress-facts.js';
import { collectWorkReport } from '../lib/work-report.js';
import { failureExplanation } from '../lib/failure-diagnostics.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message, stack: error.stack });
  }
}

function createFixture() {
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const session = {
    id: 'session-bili-test',
    get seq() {
      return events.length;
    },
    surface,
    eventAt(seq) {
      return events[seq];
    },
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (event.type === 'user/message') return event.data;
      return event.data?.message;
    },
  };

  function pushRaw(event, onSurface = false) {
    const seq = events.length;
    const full = { seq, time: 1700000000000 + seq * 1000, ...event };
    events.push(full);
    if (onSurface) surface.nodes.push(seq);
    return seq;
  }

  function addSystem(text) {
    return pushRaw(
      {
        type: 'system/message',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: `sys-${events.length}`,
            role: 'system',
            content: [{ type: 'text', text }],
            source: { kind: 'system-prompt' },
          },
        },
        surfaceOp: 'append',
      },
      true,
    );
  }

  function addUser(content, source = { kind: 'user' }, onSurface = true) {
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    return pushRaw(
      {
        type: 'user/message',
        data: {
          id: `usr-${events.length}`,
          role: 'user',
          content: blocks,
          source,
        },
        surfaceOp: 'append',
      },
      onSurface,
    );
  }

  function addAssistant(blocks, onSurface = true) {
    const content = typeof blocks === 'string' ? [{ type: 'text', text: blocks }] : blocks;
    return pushRaw(
      {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: `ast-${events.length}`,
            role: 'assistant',
            content,
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
        surfaceOp: 'append',
      },
      onSurface,
    );
  }

  function addToolResult(callId, text, onSurface = true) {
    return pushRaw(
      {
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: `tr-${events.length}`,
            role: 'tool',
            toolCallId: callId,
            content: [{ type: 'text', text }],
            source: { kind: 'tool', callId },
          },
        },
        surfaceOp: 'append',
      },
      onSurface,
    );
  }

  return { session, events, surface, pushRaw, addSystem, addUser, addAssistant, addToolResult };
}

await test('tool-sets-match-verified-billion-context-0.1.216-names', () => {
  assert.equal(BILI_UNIQUE_TOOLS.has('acp_read_original_image'), true);
  assert.equal(BILI_UNIQUE_TOOLS.has('read_original_image'), false);
  for (const name of [
    'acp_status',
    'acp_cache',
    'acp_rule',
    'acp_retrieve',
    'acp_retire',
    'acp_restore',
    'acp_rewrite',
    'acp_read_original_image',
  ]) {
    assert.equal(BILI_UNIQUE_TOOLS.has(name), true, `missing unique tool ${name}`);
  }
  for (const name of ['compress', 'decompress', 'search_context', 'absorb']) {
    assert.equal(BILI_GENERIC_TOOLS.has(name), true, `missing generic tool ${name}`);
  }
});

await test('authored-checkpoint-detected-across-multi-block-frameSummary-content1', () => {
  const f = createFixture();
  f.addSystem('System prompt.');
  // Exact 3-block shape emitted by dsh-compaction-basic frameSummary():
  // content[0] = preamble + <compacted-summary>, content[1] = <bili-snapshot v1 .../>, content[2] = </compacted-summary>
  const cpSeq = f.addUser(
    [
      {
        type: 'text',
        text: 'This is an automatically generated checkpoint condensing an earlier span of the conversation.\n\n<compacted-summary>',
      },
      {
        type: 'text',
        text: '<bili-snapshot v1 conv="conv-abc" seq="42" blocks="b1+b2" />\n\n[Compressed conversation section] — Database refactor\nUpdated schema.',
      },
      { type: 'text', text: '</compacted-summary>' },
    ],
    { kind: 'compact-checkpoint', compactionId: 'basic-001' },
  );
  f.addUser('Continue with tests.');

  const fold = isExternalFoldEvent(f.events[cpSeq]);
  assert.ok(fold);
  assert.equal(fold.variant, 'ranxianglei-authored-checkpoint');
  assert.equal(fold.reason, 'bili_snapshot_checkpoint');

  const det = detectBiliSession(f.session);
  assert.equal(det.detected, true);
  assert.equal(det.variant, 'ranxianglei-authored-checkpoint');
  assert.equal(det.foldBlockCount, 1);
  assert.equal(det.biliToolCount, 0);
  assert.equal(det.canConvert, true);
  assert.equal(det.needsBackup, true);
  assert.equal(det.hasOpenTurn, false);
  assert.deepEqual(det.foldSeqs, [cpSeq]);
  assert.ok(det.reasons.includes('bili_snapshot_checkpoint'));
});

await test('zero-false-positives-on-ordinary-chat-native-weave-and-generic-compress-tool', () => {
  const f = createFixture();
  f.addSystem('System prompt.');
  // User discussing billion-context tags in plain prose.
  f.addUser(
    'Please explain <bili-snapshot v1 conv="x" seq="1" blocks="b1" /> and [Compressed conversation section] in billion-context.',
  );
  // Assistant discussing it and calling an unrelated generic `compress` MCP tool.
  f.addAssistant([
    { type: 'text', text: 'Sure, billion-context uses <bili-chain /> markers.' },
    {
      type: 'tool-call',
      id: 'call-zip-1',
      name: 'compress',
      arguments: JSON.stringify({ file: 'report.tar', format: 'gzip' }),
    },
  ]);
  f.addToolResult('call-zip-1', 'Wrote report.tar.gz (1420 bytes).');
  // Native Weave checkpoint quoting the user discussion.
  f.addUser(
    [
      { type: 'text', text: 'Preamble\n\n<compacted-summary>' },
      { type: 'text', text: '<bili-snapshot v1 conv="quoted" seq="1" blocks="b1" /> discussed by user.' },
      { type: 'text', text: '</compacted-summary>' },
    ],
    { kind: 'compact-checkpoint', compactionId: 'weave-001', memorySources: [] },
  );
  // compaction/summary with model='bili-authored-compaction' MUST NOT trigger by itself.
  f.pushRaw(
    {
      type: 'compaction/summary',
      data: {
        compactionId: 'weave-001',
        provider: 'deepseek',
        model: 'bili-authored-compaction',
        summary: [{ type: 'text', text: 'summary' }],
        shadowedSeqs: [],
      },
    },
    false,
  );

  for (const event of f.events) {
    assert.equal(isExternalFoldEvent(event), null);
  }
  const det = detectBiliSession(f.session);
  assert.equal(det.detected, false);
  assert.equal(det.variant, null);
  assert.equal(det.foldBlockCount, 0);
  assert.equal(det.biliToolCount, 0);
  assert.equal(det.canConvert, false);
  assert.equal(det.needsBackup, false);
  assert.deepEqual(det.reasons, []);
});

await test('tier1-unique-tools-and-tier2-corroborated-generic-tools-detected', () => {
  const f1 = createFixture();
  f1.addUser('Inspect screenshot.');
  const callSeq = f1.addAssistant([
    { type: 'tool-call', id: 'c1', name: 'acp_read_original_image', arguments: '{"ref":"m00004"}' },
  ]);
  const resSeq = f1.addToolResult('c1', '[bili] 原图已读取');

  const d1 = detectBiliSession(f1.session);
  assert.equal(d1.detected, true);
  assert.equal(d1.variant, 'ranxianglei-proxy-raw');
  assert.equal(d1.biliToolCount, 2);
  assert.deepEqual(d1.biliToolSeqs, [callSeq, resSeq]);

  // Tier 2 generic `compress` corroborated by [acp-result: PARTIAL ...] marker.
  const f2 = createFixture();
  f2.addUser('Fold older messages.');
  const c2Seq = f2.addAssistant([
    { type: 'tool-call', id: 'c2', name: 'compress', arguments: '{"ranges":[{"startRef":"m00001","endRef":"m00008"}]}' },
  ]);
  const r2Seq = f2.addToolResult('c2', '[acp-result: PARTIAL — 1 block(s) created; some requested range(s) were NOT folded.]');
  const d2 = detectBiliSession(f2.session);
  assert.equal(d2.detected, true);
  assert.equal(d2.variant, 'ranxianglei-proxy-raw');
  assert.deepEqual(d2.biliToolSeqs, [c2Seq, r2Seq]);
});

await test('tyan-billion-context-dsh-and-v3-to-v4-plugin-acp-block-and-post-migration-clear', () => {
  for (const eventType of ['acp/block', 'plugin:acp/block']) {
    const f = createFixture();
    f.addSystem('System');
    f.pushRaw({ type: eventType, data: { blockId: 'b1' }, ignorable: true }, false);
    const foldSeq = f.addUser(
      '[Model-written summary — not user words; re-verify any obligations before relying on them]\nEarlier work summary.',
      { kind: 'compact-checkpoint', compactionId: 'bili-dsh-1' },
    );
    const det = detectBiliSession(f.session);
    assert.equal(det.detected, true);
    assert.equal(det.variant, 'billion-context-dsh');
    assert.deepEqual(det.foldSeqs, [foldSeq]);
    assert.ok(det.reasons.includes('bili_acp_block_event'));
    assert.ok(det.reasons.includes('bili_dsh_model_summary'));

    // Simulate migration replacing surface fold node with a native Weave migrated checkpoint.
    const migratedSeq = f.addUser(
      'Migrated checkpoint body',
      {
        kind: 'compact-checkpoint',
        compactionId: 'weave-migrate-001',
        migratedFrom: 'billion-context',
        externalSummaryUnverified: true,
      },
      false,
    );
    f.surface.nodes = [f.surface.nodes[0], migratedSeq];
    f.surface.replaceGeneration += 1;

    const after = detectBiliSession(f.session);
    assert.equal(after.detected, false, `must clear detected after migration for ${eventType}`);
    assert.equal(after.canConvert, false);
    assert.equal(after.variant, null);
  }
});

await test('tombstone-sources-open-turn-broken-tool-pairing-and-mixed-variant', () => {
  const f = createFixture();
  f.addSystem('System');
  f.pushRaw({ type: 'turn/start', data: { turn: 3 } }, false);
  const tombSeq = f.addUser('[pruned]', { kind: 'plugin:billion-context-dsh' });
  const nudgeSeq = f.addUser('[nudge]', { kind: 'plugin:acp-nudge' });
  // Orphan tool/result whose matching tool-call was shadowed by bili fold.
  const orphanSeq = f.addToolResult('missing-call-id', 'stale tool output');
  const uniqueSeq = f.addAssistant([
    { type: 'tool-call', id: 'acp-1', name: 'acp_status', arguments: '{}' },
  ]);
  const uniqueResSeq = f.addToolResult('acp-1', '📦 [ACP] acp_status result: 4 blocks');

  const det = detectBiliSession(f.session);
  assert.equal(det.detected, true);
  assert.equal(det.variant, 'mixed');
  assert.equal(det.hasOpenTurn, true);
  assert.equal(det.canConvert, false);
  assert.equal(det.hasBrokenToolPairing, true);
  assert.deepEqual(det.foldSeqs, [tombSeq, nudgeSeq]);
  assert.deepEqual(det.biliToolSeqs, [uniqueSeq, uniqueResSeq]);
  assert.ok(det.reasons.includes('broken_tool_pairing'));
  assert.ok(det.reasons.every((r) => /^[a-z0-9_]+$/.test(r)));
  assert.ok(orphanSeq >= 0);
});

await test('migration-plan-bounds-shadowed-originals-to-2000-and-encapsulates-broken-prefix', () => {
  const f = createFixture();
  f.addSystem('System');
  // 2500 shadowed durable messages NOT on surface.
  for (let i = 0; i < 2500; i += 1) {
    f.addUser(`Shadowed turn ${i}`, { kind: 'user' }, false);
  }
  const foldSeq = f.addUser(
    [
      { type: 'text', text: '<compacted-summary>' },
      { type: 'text', text: '<bili-snapshot v1 conv="c" seq="2500" blocks="b1" />\n[Compressed conversation section] — Old work\nDone.' },
      { type: 'text', text: '</compacted-summary>' },
    ],
    { kind: 'compact-checkpoint', compactionId: 'bili-x' },
    true,
  );
  // Broken orphan tool/result right after fold, then a clean post-fold turn.
  const orphanRes = f.addToolResult('lost-call', 'orphan output', true);
  const postUser = f.addUser('Verified post-fold user instruction.', { kind: 'user' }, true);
  const tailCall = f.addAssistant([{ type: 'tool-call', id: 'ok-1', name: 'read_file', arguments: '{}' }], true);
  const tailRes = f.addToolResult('ok-1', 'file contents', true);

  // Also simulate a stale foreign compaction/start lock in durable log.
  const staleStart = f.pushRaw(
    { type: 'compaction/start', data: { compactionId: 'foreign-1', turn: null } },
    false,
  );

  const det = detectBiliSession(f.session);
  const plan = buildBiliMigrationPlan(f.session, det);
  assert.equal(plan.needed, true);
  assert.equal(plan.strategy, 'fold-adopt');
  assert.equal(plan.startSeq, foldSeq);
  // Encapsulates through orphanRes so trailing [postUser, tailCall, tailRes] is 100% tool-pair balanced!
  assert.equal(plan.endSeq, orphanRes);
  assert.equal(plan.archivedOriginalsSeqs.length, 2000);
  assert.equal(plan.truncatedOriginalsCount, 500);
  assert.equal(plan.staleCompactionStartSeq, staleStart);
  assert.equal(plan.staleCompactionId, 'foreign-1');
  assert.match(plan.normalizedSummaryText, /not independently verified by Weave/);
  assert.match(plan.normalizedSummaryText, /Old work/);
  assert.equal(plan.checkpointSourceMeta.migratedFrom, 'billion-context');
  assert.equal(plan.checkpointSourceMeta.externalSummaryUnverified, true);
  assert.ok(postUser > orphanRes && tailCall > postUser && tailRes > tailCall);
});

await test('progress-facts-and-work-report-skip-external-folds-cleanly', () => {
  const f = createFixture();
  f.addSystem('System');
  // Foreign bili checkpoint with broken/missing shadowed history and bogus workReport ref.
  const foldSeq = f.addUser(
    [
      { type: 'text', text: '<compacted-summary>' },
      { type: 'text', text: '<bili-snapshot v1 conv="c" seq="99" blocks="b1" />\ncompletedCount: 999' },
      { type: 'text', text: '</compacted-summary>' },
    ],
    {
      kind: 'compact-checkpoint',
      compactionId: 'bili-cp-broken',
      workReport: { seq: 9999, sha256: 'deadbeef' },
    },
  );
  const realAssistant = f.addAssistant('已完成迁移准备，completedCount: 3，下一步运行测试。');

  const progress = collectProgressFacts(f.session, [foldSeq, realAssistant]);
  assert.equal(progress.effective.length, 1);
  assert.equal(progress.effective[0].key, 'completedCount');
  assert.equal(progress.effective[0].value, 3);

  const report = collectWorkReport(f.session, [foldSeq, realAssistant]);
  assert.ok(report);
  assert.equal(report.seq, realAssistant);
  assert.match(report.text, /已完成迁移准备/);
});

await test('normal-dsh-compaction-basic-checkpoint-not-flagged-and-proxy-raw-plan-works', () => {
  // Normal DSH compaction-basic checkpoint (no bili markers) must NOT trigger detection.
  const f1 = createFixture();
  f1.addSystem('System');
  f1.addUser(
    [
      { type: 'text', text: 'This is an automatically generated checkpoint.\n\n<compacted-summary>' },
      { type: 'text', text: '## Primary Request and Intent\n- Refactor login handler.\n\n## Current Work\n- Tests green.' },
      { type: 'text', text: '</compacted-summary>' },
    ],
    { kind: 'compact-checkpoint', compactionId: 'basic-999' },
  );
  assert.equal(detectBiliSession(f1.session).detected, false);

  // Proxy-raw session (no fold checkpoints, only bili tools) -> strategy === 'proxy-raw-rolling'.
  const f2 = createFixture();
  f2.addSystem('System');
  const u1 = f2.addUser('Long task start.');
  const a1 = f2.addAssistant([{ type: 'tool-call', id: 'st-1', name: 'acp_status', arguments: '{}' }]);
  const r1 = f2.addToolResult('st-1', '📦 [ACP] acp_status result: active=0');
  f2.addUser('Keep going.');
  const det = detectBiliSession(f2.session);
  assert.equal(det.detected, true);
  assert.equal(det.variant, 'ranxianglei-proxy-raw');
  const plan = buildBiliMigrationPlan(f2.session, det);
  assert.equal(plan.needed, true);
  assert.equal(plan.strategy, 'proxy-raw-rolling');
  assert.equal(plan.startSeq, u1);
  assert.equal(plan.endSeq, r1);
  assert.equal(plan.normalizedSummaryText, null);
  assert.ok(a1 > u1);

  // Legacy V3 { kind: 'plugin', plugin: 'compact' } with Tyan header.
  const f3 = createFixture();
  const legacySeq = f3.addUser(
    '[Model-written summary — not user words; re-verify any obligations before relying on them]\nSummary body.',
    { kind: 'plugin', plugin: 'compact' },
  );
  assert.equal(isExternalFoldEvent(f3.events[legacySeq])?.variant, 'billion-context-dsh');
});

await test('failure-diagnostics-explanations-cover-new-bili-and-pairing-codes', () => {
  const cases = [
    ['CHECKPOINT_PRESERVED_UNREADABLE', /兼容转换为 Weave/],
    ['CONTINUATION_TOOL_GROUP_OPEN', /未闭合的工具调用组/],
    ['ARCHIVE_SOURCE_INVALID', /归档工具调用引用/],
    ['BILI_BACKUP_FAILED', /会话备份或校验未通过/],
    ['BACKUP_VERIFICATION_FAILED', /会话备份或校验未通过/],
    ['BILI_MIGRATION_FAILED', /兼容迁移未完成/],
    ['TOOL_PAIRING_BROKEN', /工具调用与结果配对失衡/],
  ];
  for (const [code, pattern] of cases) {
    const msg = failureExplanation(Object.assign(new Error('raw'), { code }));
    assert.match(msg, pattern, `expected ${code} explanation to match ${pattern}, got: ${msg}`);
    assert.doesNotMatch(msg, /^压缩未完成（/);
  }
  const pairingByMsg = failureExplanation(
    new Error('tool-pairing balance: tool/result at surface seq 7 has no matching tool-call'),
  );
  assert.match(pairingByMsg, /工具调用与结果配对失衡/);
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
