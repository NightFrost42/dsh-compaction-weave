import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js';
import { prepareContinuation } from '../lib/continuation.js';
import {
  extractCandidatePaths,
  probeDiskLiveness,
  renderDiskLivenessNotice,
  resolveSessionWorkspaceRoots,
} from '../lib/disk-liveness.js';
import { canonicalMessageBytes, WeaveCompactionEngine } from '../lib/engine.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { materializeUserMessageSection } from '../lib/validate.js';
import {
  buildCompactionInstruction,
  CHECKPOINT_PREAMBLE,
  INTERMEDIATE_SUMMARY_TARGET_CHARS,
  SUMMARY_TARGET_CHARS,
} from '../lib/prompt.js';
import {
  buildCheckpointBlocks,
  collectArchivedFiles,
  collectChildArchiveIds,
  renderArchivePointer,
} from '../lib/region.js';
import { resolveSummaryCapacity } from '../lib/summary-budget.js';
import { resolveSummaryTargets } from '../lib/summary.js';

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

const EN_HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeSummary(extra = 'Preserve strict integer cents.') {
  return EN_HEADINGS.map((h, idx) =>
    `${h}\n${idx === 5 ? '[filled by engine]' : idx === 8 ? extra : 'Evidence archived; continuing task.'}`,
  ).join('\n\n');
}

function makeContinuationNotes(extra = 'Preserve strict integer cents.') {
  return [
    `## Goal\n${extra}`,
    '## State\nHistorical progress archived cleanly.',
    '## Next\nVerify workspace deliverables on disk before editing.',
    '## Uncertain\nConfirm disk state against historical checkpoint.',
  ].join('\n\n');
}

async function createEngineFixture({
  extraConfig = {},
  cwd = undefined,
  summaryText = makeSummary(),
  streamHandler = null,
  windowTokens = 200000,
  headerTarget = { provider: 'p', model: 'm' },
  eventsBaseTime = Date.now() - 60_000,
} = {}) {
  const root = await mkdtemp(join(TEST_BASE, 'weave-disk-eff-'));
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const calls = [];
  let seqClock = eventsBaseTime;

  const session = {
    id: `sess-${randomUUID()}`,
    header: {
      version: 4,
      id: 'header-placeholder',
      createdAt: eventsBaseTime,
      isSeeded: false,
      ...(cwd === undefined ? {} : { cwd }),
    },
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => [...events],
    requestHeader: () => ({ config: headerTarget }),
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
      seqClock += 10;
      const event = {
        seq: events.length,
        time: typeof options.time === 'number' ? options.time : seqClock,
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

  const addSystem = (text) =>
    session.append(
      'system/message',
      { message: { id: randomUUID(), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } } },
      { surfaceOp: 'append' },
    );

  const addUser = (text, kind = 'user', extraSource = {}) =>
    session.append(
      'user/message',
      { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind, ...extraSource } },
      { surfaceOp: 'append' },
    );

  const addAssistant = (text) =>
    session.append(
      'assistant/message',
      {
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'text', text }],
          source: { kind: 'model', provider: headerTarget.provider, model: headerTarget.model },
        },
      },
      { surfaceOp: 'append' },
    );

  const addToolPair = (toolName, args, body) => {
    const callId = `call-${randomUUID()}`;
    const callEvent = session.append('tool/call', { callId, name: toolName, arguments: JSON.stringify(args) });
    const assistantCall = session.append(
      'assistant/message',
      {
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'tool-call', callId, toolName, args }],
          source: { kind: 'model', provider: headerTarget.provider, model: headerTarget.model },
        },
      },
      { surfaceOp: 'append' },
    );
    const resultEvent = session.append(
      'tool/result',
      {
        message: {
          role: 'tool',
          toolCallId: callId,
          content: [{ type: 'text', text: body }],
          source: { kind: 'tool-result', callId },
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] },
    );
    return { callEvent, assistantCall, resultEvent };
  };

  const estimateMessage = (m) => approxTokens(blocksToText(m?.content));
  const measure = () => {
    const nodes = surface.nodes.map((seq) => ({
      seq,
      tokens: estimateMessage(session.deriveEventMessage(events[seq])),
    }));
    return { nodes, totalTokens: nodes.reduce((sum, item) => sum + item.tokens, 0) };
  };

  const ctx = {
    on() {},
    provide() {},
    logger: { info() {}, warn() {}, error() {} },
    sessions: { async flush() { return true; } },
    tokenMeter: { estimateMessage, measure },
    llm: {
      async resolveModelInfo() {
        return { contextWindow: windowTokens, defaultMaxTokens: 8192 };
      },
      async *stream(opts) {
        const callIndex = calls.length;
        calls.push(opts);
        if (streamHandler) {
          yield* streamHandler(opts, callIndex, calls);
          return;
        }
        const text = typeof summaryText === 'function' ? summaryText(opts, callIndex + 1) : summaryText;
        yield { type: 'text-delta', text };
        yield { type: 'finish', kind: 'stop' };
      },
    },
  };

  const config = resolveConfig({
    archiveDir: join(root, 'archive'),
    language: 'en',
    summaryInputMaxBytes: 120000,
    windowFallback: windowTokens,
    maxTokens: 4096,
    summaryRetryCount: 0,
    summaryRetryDelayMs: 10,
    ...extraConfig,
  }).config;

  const engine = new WeaveCompactionEngine(ctx, config);
  engine.historyToolsAvailable = true;
  engine.log = () => {};
  const agent = {
    session,
    options: { ...headerTarget },
    runMaintenance: (fn) => fn(new AbortController().signal),
  };

  return {
    root,
    events,
    surface,
    calls,
    session,
    engine,
    agent,
    ctx,
    config,
    addSystem,
    addUser,
    addAssistant,
    addToolPair,
    async dispose() {
      engine.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

// ── 1. Config ────────────────────────────────────────────────────────────────
await test('config-disk-liveness-check-default-and-override', () => {
  assert.equal(DEFAULT_CONFIG.diskLivenessCheck, true);

  const def = resolveConfig({});
  assert.equal(def.config.diskLivenessCheck, true);
  assert.deepEqual(def.unknown, []);

  const disabled = resolveConfig({ diskLivenessCheck: false });
  assert.equal(disabled.config.diskLivenessCheck, false);
  assert.deepEqual(disabled.unknown, []);

  const invalidFallback = resolveConfig({ diskLivenessCheck: 'false' });
  assert.equal(invalidFallback.config.diskLivenessCheck, true);
  assert.deepEqual(invalidFallback.unknown, []);
});

// ── 2. Prompt & Region ───────────────────────────────────────────────────────
await test('prompt-and-region-historical-warnings-and-folded-metadata', () => {
  assert.ok(
    CHECKPOINT_PREAMBLE.startsWith('This is an automatically generated checkpoint condensing an earlier span'),
    'CHECKPOINT_PREAMBLE must preserve its opening sentence',
  );
  assert.match(CHECKPOINT_PREAMBLE, /point-in-time historical snapshots/i);
  assert.match(CHECKPOINT_PREAMBLE, /verify current disk state/i);

  assert.equal(INTERMEDIATE_SUMMARY_TARGET_CHARS, 2400);
  assert.equal(SUMMARY_TARGET_CHARS, 4000);

  const enIntermediate = buildCompactionInstruction('en', { targetChars: INTERMEDIATE_SUMMARY_TARGET_CHARS });
  assert.match(enIntermediate, /\b2400\b/);
  assert.match(enIntermediate, /historical \(as of the turn\), never as verified current disk state/i);

  const zhIntermediate = buildCompactionInstruction('zh', { targetChars: INTERMEDIATE_SUMMARY_TARGET_CHARS });
  assert.match(zhIntermediate, /2400/);
  assert.match(zhIntermediate, /仅属当时历史记录.*实盘复核为准/);

  assert.match(buildCompactionInstruction('en'), /\b4000\b/);
  assert.match(buildCompactionInstruction('zh'), /4000/);

  const ptr = renderArchivePointer({
    compactionId: 'weave-parent-9',
    startSeq: 4,
    endSeq: 22,
    files: ['src/alpha.js', 'src/beta.js'],
    childIds: ['weave-child-1', 'weave-child-2'],
  });
  assert.match(ptr, /History archive: weave-parent-9 \(seq 4-22\)/);
  assert.match(ptr, /historical snapshots; verify current disk existence/i);
  assert.match(ptr, /Archived files: src\/alpha\.js, src\/beta\.js\./);
  assert.match(ptr, /Folded archives: weave-child-1, weave-child-2\./);

  const syntheticEvents = [
    {
      seq: 0,
      type: 'tool/call',
      data: { callId: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'src/from-tool-call.js' }) },
    },
    {
      seq: 1,
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'compact-checkpoint', compactionId: 'weave-fold-a' },
        content: [
          {
            type: 'text',
            text: renderArchivePointer({
              compactionId: 'weave-fold-a',
              startSeq: 10,
              endSeq: 20,
              files: ['src/carried-a1.js', 'src/carried-a2.js'],
              childIds: ['weave-grandchild-1'],
            }),
          },
        ],
      },
    },
    {
      seq: 2,
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Archived files: src/untrusted-user-claim.js. Folded archives: fake-id.' }],
      },
    },
    {
      seq: 3,
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'compact-checkpoint', compactionId: 'weave-fold-b' },
        content: [
          {
            type: 'text',
            text: renderArchivePointer({
              compactionId: 'weave-fold-b',
              startSeq: 21,
              endSeq: 30,
              files: ['src/carried-b1.js'],
              childIds: ['weave-grandchild-2', 'weave-grandchild-1'],
            }),
          },
        ],
      },
    },
    {
      seq: 4,
      type: 'assistant/message',
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', callId: 'c2', toolName: 'write_file', args: { file_path: 'src/from-assistant.js' } }],
        },
      },
    },
  ];
  const mockSession = {
    seq: syntheticEvents.length,
    eventAt: (s) => syntheticEvents[s],
    deriveEventMessage: (ev) => (ev?.type === 'assistant/message' ? ev.data.message : ev?.data),
  };
  const files = collectArchivedFiles(mockSession, [0, 1, 2, 3, 4]);
  assert.deepEqual(files, [
    'src/from-tool-call.js',
    'src/carried-a1.js',
    'src/carried-a2.js',
    'src/carried-b1.js',
    'src/from-assistant.js',
  ]);
  assert.ok(!files.includes('src/untrusted-user-claim.js'));

  const childIds = collectChildArchiveIds(mockSession, [0, 1, 2, 3, 4]);
  assert.deepEqual(childIds, ['weave-fold-a', 'weave-grandchild-1', 'weave-fold-b', 'weave-grandchild-2']);
  assert.ok(!childIds.includes('fake-id'));
});

// ── 3. lib/disk-liveness.js ──────────────────────────────────────────────────
await test('disk-liveness-workspace-roots-changes-traversal-tags-and-truncation', async () => {
  const base = await mkdtemp(join(TEST_BASE, 'weave-dl-unit-'));
  try {
    const ws1 = join(base, 'ws-one');
    const ws2 = join(base, 'ws-two');
    const outsideDir = join(base, 'outside-dir');
    await mkdir(join(ws1, 'sub'), { recursive: true });
    await mkdir(join(ws2, 'src'), { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    const spanEndMs = Date.now() - 60_000;
    const oldTime = new Date(spanEndMs - 20_000);
    const newerThan5s = new Date(spanEndMs + 20_000);

    const unchangedWs1 = join(ws1, 'sub', 'keep-ws1.txt');
    const deletedWs1 = join(ws1, 'sub', 'deleted-ws1.txt');
    await writeFile(unchangedWs1, 'ws1 unchanged');
    await utimes(unchangedWs1, oldTime, oldTime);

    const unchangedWs2 = join(ws2, 'src', 'keep.js');
    const modifiedWs2 = join(ws2, 'src', 'edited.js');
    const deletedWs2 = join(ws2, 'src', 'gone.js');
    await writeFile(unchangedWs2, 'export const keep = 1;\n');
    await utimes(unchangedWs2, oldTime, oldTime);
    await writeFile(modifiedWs2, 'export const edited = 2;\n');
    await utimes(modifiedWs2, newerThan5s, newerThan5s);
    await writeFile(deletedWs2, 'temp');
    await unlink(deletedWs2);

    const outsideExisting = join(outsideDir, 'secret-outside.txt');
    await writeFile(outsideExisting, 'outside');
    const outsideMissing = join(outsideDir, 'missing-outside.txt');

    const events = [
      { seq: 0, time: spanEndMs - 10_000, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'start' }] } },
      { seq: 1, time: spanEndMs - 5_000, type: 'working-directory/change', data: { cwd: ws2 } },
      { seq: 2, time: spanEndMs, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } },
    ];
    const session = {
      header: { version: 4, id: 'dl-1', cwd: ws1 },
      get seq() { return events.length; },
      eventAt: (seq) => events[seq],
    };

    const roots = resolveSessionWorkspaceRoots(session);
    assert.equal(roots.length, 2);

    const summaryText = [
      `Checked \`src/keep.js\`, \`src/edited.js\`, \`src/gone.js\`, and ${unchangedWs1} plus ${deletedWs1}.`,
      `Ignored traversal \`../outside-dir/secret-outside.txt\`, \`src/../../outside-dir/missing-outside.txt\`, and ${outsideExisting} and ${outsideMissing}.`,
      '<untrusted_reference seq="0" kind="session-reference">\nCheck `src/ref-only-missing.js`.\n</untrusted_reference>',
      '<quoted_text>\nCheck `src/quote-only-missing.js`.\n</quoted_text>',
      '```\n`src/fence-only-missing.js`\n```',
    ].join('\n');

    const probe = probeDiskLiveness({
      session,
      shadowedSeqs: [0, 1, 2],
      archivedFiles: ['src/keep.js', 'src/gone.js', '../outside-dir/secret-outside.txt'],
      summaryText,
    });

    assert.ok(probe.checked >= 5);
    assert.ok(probe.missing.includes('src/gone.js'));
    assert.ok(probe.missing.some((p) => p.replaceAll('\\', '/').endsWith('/sub/deleted-ws1.txt')));
    assert.ok(!probe.missing.some((p) => p.includes('ref-only-missing') || p.includes('quote-only-missing') || p.includes('fence-only-missing')));
    assert.ok(!probe.missing.some((p) => p.includes('outside')));
    assert.deepEqual(probe.modified, ['src/edited.js']);
    assert.ok(probe.existing.includes('src/keep.js'));
    assert.ok(!probe.existing.includes('src/gone.js'));
    assert.ok(!probe.existing.some((p) => p.includes('outside')));

    const extracted = extractCandidatePaths({ session, summaryText: '`../escape.js` `src/../../escape2.js`' });
    assert.deepEqual(extracted, []);

    const pointerWithChildren = renderArchivePointer({
      compactionId: 'weave-p-dl',
      startSeq: 1,
      endSeq: 5,
      files: ['src/keep.js'],
      childIds: ['weave-c1', 'weave-c2'],
    });
    const probeFromPointer = probeDiskLiveness({
      session,
      shadowedSeqs: [0, 1, 2],
      summaryText: pointerWithChildren,
    });
    assert.deepEqual(probeFromPointer.missing, []);
    assert.ok(probeFromPointer.existing.includes('src/keep.js'));

    const fullNotice = renderDiskLivenessNotice(probe);
    assert.match(fullNotice, /^<disk-state-check checked-at="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z" scope="local-workspace">/);
    assert.match(fullNotice, /- Missing on disk at compaction:.*src\/gone\.js/);
    assert.match(fullNotice, /- Modified on disk after compacted turns:.*src\/edited\.js/);

    const missingOnly = renderDiskLivenessNotice(probe, { includeModified: false });
    assert.match(missingOnly, /- Missing on disk at compaction:/);
    assert.doesNotMatch(missingOnly, /Modified on disk after compacted turns:/);

    assert.equal(renderDiskLivenessNotice({ missing: [], modified: ['src/edited.js'] }, { includeModified: false }), '');

    const truncated = renderDiskLivenessNotice(
      {
        checkedAt: '2026-11-22T01:30:00.000Z',
        missing: ['m1.js', 'm2.js', 'm3.js', 'm4.js'],
        modified: ['d1.js', 'd2.js', 'd3.js'],
      },
      { maxMissing: 2, maxModified: 1 },
    );
    assert.match(truncated, /- Missing on disk at compaction: m1\.js, m2\.js, \(\+2 more\)/);
    assert.match(truncated, /- Modified on disk after compacted turns: d1\.js, \(\+2 more\)/);

    // Synthetic / remote / non-existent workspace
    for (const badCwd of [undefined, join(base, 'non-existent-workspace'), '\\\\remote-server\\share\\workspace']) {
      const remoteSession = { header: badCwd === undefined ? { version: 4, id: 'syn' } : { version: 4, id: 'syn', cwd: badCwd }, seq: 0, eventAt: () => undefined };
      const skipped = probeDiskLiveness({ session: remoteSession, archivedFiles: ['src/a.js'], summaryText: '`src/b.js`' });
      assert.equal(skipped.checked, 0);
      assert.deepEqual(skipped.missing, []);
      assert.deepEqual(skipped.modified, []);
      assert.equal(skipped.skippedReason, 'no-local-workspace');
      assert.equal(renderDiskLivenessNotice(skipped), '');
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ── 4a. Engine integration: Disk liveness in compaction + toggle ─────────────
await test('engine-disk-liveness-in-compaction-and-disable-flag', async () => {
  const ws = await mkdtemp(join(TEST_BASE, 'weave-ws-compact-'));
  try {
    await mkdir(join(ws, 'src'), { recursive: true });
    const existingPath = join(ws, 'src', 'keep.js');
    const deletedPath = join(ws, 'src', 'deleted.js');
    const oldDate = new Date(Date.now() - 120_000);
    await writeFile(existingPath, 'export const keep = true;\n');
    await utimes(existingPath, oldDate, oldDate);
    await writeFile(deletedPath, 'temp');
    await unlink(deletedPath);

    // Default: diskLivenessCheck = true
    const f = await createEngineFixture({
      cwd: ws,
      summaryText: makeSummary('Preserve strict integer cents. Checked `src/keep.js` and `src/deleted.js`.'),
    });
    try {
      f.addSystem('Stable system.');
      f.addUser('Preserve strict integer cents.');
      f.addToolPair('read_file', { path: 'src/keep.js' }, 'export const keep = true;\n');
      f.addToolPair('write_file', { path: 'src/deleted.js' }, 'written earlier');
      f.addAssistant('Detailed analysis. '.repeat(350));

      const res = await f.engine._compactRegionCore(f.surface.nodes[1], f.surface.nodes.at(-1), f.agent, new AbortController().signal, {
        manual: true,
        policy: f.engine.config,
      });
      assert.ok(res.compactionId);
      const cpText = blocksToText(f.session.deriveEventMessage(f.events[res.replacementSeq]).content);
      const match = cpText.match(/<disk-state-check\b[^>]*>[\s\S]*?<\/disk-state-check>/);
      assert.ok(match, `expected <disk-state-check> block in checkpoint:\n${cpText}`);
      assert.ok(match[0].includes('src/deleted.js'), 'deleted path must appear in <disk-state-check>');
      assert.ok(!match[0].includes('src/keep.js'), 'existing unchanged path must NOT appear in <disk-state-check>');
    } finally {
      await f.dispose();
    }

    // Disabled: diskLivenessCheck = false
    const fOff = await createEngineFixture({
      cwd: ws,
      extraConfig: { diskLivenessCheck: false },
      summaryText: makeSummary('Preserve strict integer cents. Checked `src/keep.js` and `src/deleted.js`.'),
    });
    try {
      fOff.addSystem('Stable system.');
      fOff.addUser('Preserve strict integer cents.');
      fOff.addToolPair('read_file', { path: 'src/keep.js' }, 'export const keep = true;\n');
      fOff.addToolPair('write_file', { path: 'src/deleted.js' }, 'written earlier');
      fOff.addAssistant('Detailed analysis. '.repeat(350));

      const res = await fOff.engine._compactRegionCore(fOff.surface.nodes[1], fOff.surface.nodes.at(-1), fOff.agent, new AbortController().signal, {
        manual: true,
        policy: fOff.engine.config,
      });
      assert.ok(res.compactionId);
      const cpText = blocksToText(fOff.session.deriveEventMessage(fOff.events[res.replacementSeq]).content);
      assert.doesNotMatch(cpText, /<disk-state-check/);
    } finally {
      await fOff.dispose();
    }
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ── 4b. Engine integration: Tight span drops/shrinks <disk-state-check> ──────
await test('engine-tight-span-gracefully-drops-or-shrinks-disk-liveness', async () => {
  const ws = await mkdtemp(join(TEST_BASE, 'weave-ws-tight-'));
  try {
    await mkdir(join(ws, 'src'), { recursive: true });
    const summaryText = makeSummary('Preserve strict integer cents.');
    const userItem = [{ seq: 1, blocks: [{ type: 'text', text: 'Preserve strict integer cents.' }], text: 'Preserve strict integer cents.' }];
    const materializedSummary = materializeUserMessageSection(summaryText, userItem, 'en');
    const mockScope = { scope: { start: 1, end: 5, count: 4 } };

    // Case 1: Missing-only notice still breaks shrinkage -> disk check dropped completely, compaction succeeds
    const missingPaths = [
      'src/missing-tight-deliverable-artifact-01.js',
      'src/missing-tight-deliverable-artifact-02.js',
      'src/missing-tight-deliverable-artifact-03.js',
      'src/missing-tight-deliverable-artifact-04.js',
    ];
    const probeBaselineBlocks = buildCheckpointBlocks(
      [{ type: 'text', text: materializedSummary }],
      userItem,
      CHECKPOINT_PREAMBLE,
      {
        originalsInSummary: true,
        progress: mockScope,
        archive: { compactionId: 'weave-sample-000000-1', startSeq: 1, endSeq: 5, files: missingPaths },
      },
    );
    const baselineBytes = canonicalMessageBytes([{ role: 'user', content: probeBaselineBlocks }]);
    const baselineTokens = approxTokens(blocksToText(probeBaselineBlocks));
    const fullDiskNotice = renderDiskLivenessNotice({
      checkedAt: new Date().toISOString(),
      missing: missingPaths,
      modified: [],
    });
    const withDiskBlocks = buildCheckpointBlocks(
      [{ type: 'text', text: materializedSummary }],
      userItem,
      CHECKPOINT_PREAMBLE,
      {
        originalsInSummary: true,
        progress: mockScope,
        archive: { compactionId: 'weave-sample-000000-1', startSeq: 1, endSeq: 5, files: missingPaths },
        diskLiveness: fullDiskNotice,
      },
    );
    const withDiskBytes = canonicalMessageBytes([{ role: 'user', content: withDiskBlocks }]);
    const withDiskTokens = approxTokens(blocksToText(withDiskBlocks));
    assert.ok(withDiskBytes > baselineBytes + 120);
    assert.ok(withDiskTokens > baselineTokens + 40);

    const fTight = await createEngineFixture({ cwd: ws, summaryText });
    try {
      fTight.addSystem('Stable system.');
      fTight.addUser('Preserve strict integer cents.');
      fTight.addToolPair('batch_check', { files: missingPaths }, 'ok');
      const existingSeqs = fTight.surface.nodes.slice(1);
      const existingBytes = canonicalMessageBytes(
        existingSeqs.map((seq) => fTight.session.deriveEventMessage(fTight.events[seq])),
      );
      const existingTokens = existingSeqs.reduce(
        (sum, seq) => sum + approxTokens(blocksToText(fTight.session.deriveEventMessage(fTight.events[seq])?.content)),
        0,
      );
      const targetTokens = baselineTokens + 20;
      const neededAsstChars = Math.max(
        baselineBytes + 100 - existingBytes,
        (targetTokens - existingTokens) * 4,
      );
      fTight.addAssistant('t'.repeat(neededAsstChars));

      const spanSeqs = fTight.surface.nodes.slice(1);
      const spanBytes = canonicalMessageBytes(
        spanSeqs.map((seq) => fTight.session.deriveEventMessage(fTight.events[seq])),
      );
      const spanTokens = spanSeqs.reduce(
        (sum, seq) => sum + approxTokens(blocksToText(fTight.session.deriveEventMessage(fTight.events[seq])?.content)),
        0,
      );
      assert.ok(spanBytes > baselineBytes, `expected ${spanBytes} > ${baselineBytes}`);
      assert.ok(
        spanTokens > baselineTokens && spanTokens < withDiskTokens,
        `expected ${baselineTokens} < ${spanTokens} < ${withDiskTokens}`,
      );

      const res = await fTight.engine._compactRegionCore(spanSeqs[0], spanSeqs.at(-1), fTight.agent, new AbortController().signal, {
        manual: true,
        policy: fTight.engine.config,
      });
      assert.ok(res.compactionId, 'tight compaction must succeed when <disk-state-check> is dropped');
      assert.equal(fTight.surface.replaceGeneration, 1);
      const cpText = blocksToText(fTight.session.deriveEventMessage(fTight.events[res.replacementSeq]).content);
      assert.doesNotMatch(cpText, /<disk-state-check/);
      assert.match(cpText, /History archive:/);
    } finally {
      await fTight.dispose();
    }

    // Case 2: fullNotice (missing + modified) breaks shrinkage while missingOnlyNotice fits
    const shortMissing = 'src/m.js';
    const modPaths = [
      'src/modified-tight-deliverable-artifact-01.js',
      'src/modified-tight-deliverable-artifact-02.js',
      'src/modified-tight-deliverable-artifact-03.js',
    ];
    const futureDate = new Date(Date.now() + 60_000);
    for (const p of modPaths) {
      await writeFile(join(ws, p), 'modified content');
      await utimes(join(ws, p), futureDate, futureDate);
    }
    const allPaths = [shortMissing, ...modPaths];
    const missingOnlyNotice = renderDiskLivenessNotice(
      { checkedAt: new Date().toISOString(), missing: [shortMissing], modified: modPaths },
      { includeModified: false },
    );
    const bothNotice = renderDiskLivenessNotice(
      { checkedAt: new Date().toISOString(), missing: [shortMissing], modified: modPaths },
      { includeModified: true },
    );
    const missingOnlyBlocks = buildCheckpointBlocks(
      [{ type: 'text', text: materializedSummary }],
      userItem,
      CHECKPOINT_PREAMBLE,
      {
        originalsInSummary: true,
        progress: mockScope,
        archive: { compactionId: 'weave-sample-000000-2', startSeq: 1, endSeq: 5, files: allPaths },
        diskLiveness: missingOnlyNotice,
      },
    );
    const bothBlocks = buildCheckpointBlocks(
      [{ type: 'text', text: materializedSummary }],
      userItem,
      CHECKPOINT_PREAMBLE,
      {
        originalsInSummary: true,
        progress: mockScope,
        archive: { compactionId: 'weave-sample-000000-2', startSeq: 1, endSeq: 5, files: allPaths },
        diskLiveness: bothNotice,
      },
    );
    const withMissingOnlyBytes = canonicalMessageBytes([{ role: 'user', content: missingOnlyBlocks }]);
    const withMissingOnlyTokens = approxTokens(blocksToText(missingOnlyBlocks));
    const withBothBytes = canonicalMessageBytes([{ role: 'user', content: bothBlocks }]);
    const withBothTokens = approxTokens(blocksToText(bothBlocks));
    assert.ok(withBothBytes > withMissingOnlyBytes + 120);
    assert.ok(withBothTokens > withMissingOnlyTokens + 30);

    const fShrink = await createEngineFixture({ cwd: ws, summaryText });
    try {
      fShrink.addSystem('Stable system.');
      fShrink.addUser('Preserve strict integer cents.');
      fShrink.addToolPair('batch_check', { files: allPaths }, 'ok');
      const existingSeqs = fShrink.surface.nodes.slice(1);
      const existingBytes = canonicalMessageBytes(
        existingSeqs.map((seq) => fShrink.session.deriveEventMessage(fShrink.events[seq])),
      );
      const existingTokens = existingSeqs.reduce(
        (sum, seq) => sum + approxTokens(blocksToText(fShrink.session.deriveEventMessage(fShrink.events[seq])?.content)),
        0,
      );
      const targetTokens = withMissingOnlyTokens + 15;
      const neededAsstChars = Math.max(
        withMissingOnlyBytes + 80 - existingBytes,
        (targetTokens - existingTokens) * 4,
      );
      fShrink.addAssistant('m'.repeat(neededAsstChars));

      const spanSeqs = fShrink.surface.nodes.slice(1);
      const spanTokens = spanSeqs.reduce(
        (sum, seq) => sum + approxTokens(blocksToText(fShrink.session.deriveEventMessage(fShrink.events[seq])?.content)),
        0,
      );
      assert.ok(
        spanTokens > withMissingOnlyTokens && spanTokens < withBothTokens,
        `expected ${withMissingOnlyTokens} < ${spanTokens} < ${withBothTokens}`,
      );

      const res = await fShrink.engine._compactRegionCore(spanSeqs[0], spanSeqs.at(-1), fShrink.agent, new AbortController().signal, {
        manual: true,
        policy: fShrink.engine.config,
      });
      assert.ok(res.compactionId);
      const cpText = blocksToText(fShrink.session.deriveEventMessage(fShrink.events[res.replacementSeq]).content);
      assert.match(cpText, /<disk-state-check/);
      assert.match(cpText, /Missing on disk at compaction:.*src\/m\.js/);
      assert.doesNotMatch(cpText, /Modified on disk after compacted turns:/);
    } finally {
      await fShrink.dispose();
    }
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ── 4c. prepareContinuation: <disk-state-check>, Folded archives, tight budgets
await test('prepare-continuation-disk-liveness-folded-archives-and-tight-budgets', async () => {
  const ws = await mkdtemp(join(TEST_BASE, 'weave-ws-cont-'));
  try {
    await mkdir(join(ws, 'src'), { recursive: true });
    const existingFile = join(ws, 'src', 'existing-cont.js');
    const oldDate = new Date(Date.now() - 120_000);
    await writeFile(existingFile, 'export const contOk = true;\n');
    await utimes(existingFile, oldDate, oldDate);

    const defaultNotes = makeContinuationNotes();
    const runContinuationCase = async (extraOpts = {}) => {
      const notes = extraOpts.notes ?? defaultNotes;
      const f = await createEngineFixture({
        cwd: ws,
        summaryText: notes,
        extraConfig: { summaryInputMaxBytes: 50000, ...extraOpts.config },
      });
      try {
        f.addSystem('Stable system.');
        f.session.append(
          'user/message',
          {
            id: randomUUID(),
            role: 'user',
            source: { kind: 'compact-checkpoint', compactionId: 'weave-prior-cont-1', preserved: [] },
            content: [
              {
                type: 'text',
                text: `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>\n${makeSummary()}\n</compacted-summary>\n\nHistory archive: weave-prior-cont-1 (seq 1-5). Folded archives: weave-prior-cont-0.`,
              },
            ],
          },
          { surfaceOp: 'append' },
        );
        f.addUser('Preserve strict integer cents.');
        f.addToolPair('read_file', { path: 'src/existing-cont.js' }, 'export const contOk = true;\n');
        f.addToolPair('write_file', { path: 'src/missing-cont-deliverable-artifact.js' }, 'created earlier');
        f.addAssistant('Continuation working payload. '.repeat(350));

        const seqs = f.surface.nodes.slice(1);
        const chain = resolveSummaryTargets({ config: f.config, agent: f.agent });
        const capacity = await resolveSummaryCapacity(f.ctx, chain, f.config, new AbortController().signal, { singleTarget: true });
        const res = await prepareContinuation({
          ctx: f.ctx,
          agent: f.agent,
          session: f.session,
          seqs,
          policy: f.config,
          capacity,
          chain,
          compactionId: 'weave-cont-test-1',
          signal: new AbortController().signal,
          archiveRoot: f.engine.archive.root,
          estimateCheckpointTokens: (blocks) => f.engine._estimateCheckpointTokens(blocks),
          ...extraOpts.prepareArgs,
        });
        return { text: blocksToText(res.checkpointBlocks) };
      } finally {
        await f.dispose();
      }
    };

    // Normal budget: includes BOTH <disk-state-check> and Folded archives:
    const normal = await runContinuationCase();
    const diskMatch = normal.text.match(/<disk-state-check\b[^>]*>[\s\S]*?<\/disk-state-check>/);
    assert.ok(diskMatch, `expected <disk-state-check> in continuation checkpoint:\n${normal.text}`);
    assert.ok(diskMatch[0].includes('src/missing-cont-deliverable-artifact.js'));
    assert.ok(!diskMatch[0].includes('src/existing-cont.js'));
    assert.match(normal.text, /Folded archives: weave-prior-cont-1, weave-prior-cont-0\./);

    // Measure exact bare baseline without <disk-state-check> or <active-workspace-files>
    const noDisk = await runContinuationCase({ config: { diskLivenessCheck: false, postCompactReinjectEnabled: false } });
    const baseWithFoldedBytes = canonicalMessageBytes([{ role: 'user', content: [{ type: 'text', text: noDisk.text }] }]);
    const normalBytes = canonicalMessageBytes([{ role: 'user', content: [{ type: 'text', text: normal.text }] }]);
    assert.ok(normalBytes > baseWithFoldedBytes + 100);

    // Tight shadowedCanonicalBytes: fits baseWithFoldedBytes, smaller than normalBytes -> drops <active-workspace-files> and <disk-state-check>
    const tightBytesRes = await runContinuationCase({
      prepareArgs: { shadowedCanonicalBytes: baseWithFoldedBytes + 40 },
    });
    assert.doesNotMatch(tightBytesRes.text, /<active-workspace-files/);
    assert.doesNotMatch(tightBytesRes.text, /<disk-state-check/);
    assert.match(tightBytesRes.text, /Folded archives: weave-prior-cont-1, weave-prior-cont-0\./);

    // Tight checkpointBudgetTokens: use conservative byte-scale token estimator (1 byte = 1 token)
    // and notes fitting <= memoryLimit while <disk-state-check> (~260B) exceeds the 128B reserve.
    const rawPadNotes = makeContinuationNotes('Preserve strict integer cents. ' + 'x'.repeat(1830));
    assert.ok(Buffer.byteLength(rawPadNotes, 'utf8') <= 2050, `notes len=${Buffer.byteLength(rawPadNotes, 'utf8')}`);
    const byteEstimator = (blocks) => Buffer.byteLength(blocksToText(blocks), 'utf8');
    const fixedCompactionId = 'weave-' + 'c'.repeat(96);
    const longNoDisk = await runContinuationCase({
      notes: rawPadNotes,
      config: { diskLivenessCheck: false, postCompactReinjectEnabled: false },
      prepareArgs: { compactionId: fixedCompactionId, estimateCheckpointTokens: byteEstimator },
    });
    const longWithoutFolded = longNoDisk.text.replace(/\n\nFolded archives:[^\n]+/, '');
    const longBaseTokens = byteEstimator([{ type: 'text', text: longWithoutFolded }]);
    const tightBudgetTokens = longBaseTokens + 150;
    const longWithDisk = await runContinuationCase({
      notes: rawPadNotes,
      prepareArgs: { compactionId: fixedCompactionId, estimateCheckpointTokens: byteEstimator },
    });
    assert.ok(byteEstimator([{ type: 'text', text: longWithDisk.text }]) >= tightBudgetTokens);

    const tightTokRes = await runContinuationCase({
      notes: rawPadNotes,
      prepareArgs: {
        compactionId: fixedCompactionId,
        estimateCheckpointTokens: byteEstimator,
        checkpointBudgetTokens: tightBudgetTokens,
      },
    });
    assert.doesNotMatch(tightTokRes.text, /<active-workspace-files/);
    assert.doesNotMatch(tightTokRes.text, /<disk-state-check/);
    assert.match(tightTokRes.text, /Folded archives: weave-prior-cont-1, weave-prior-cont-0\./);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// ── 4d. Zero empty compaction/start + compaction/end spins ──────────────────
await test('zero-empty-compaction-start-end-spins', async () => {
  // (a) _tryHierarchicalFold skipping an unshrinkable fold leaves 0 start/end events & 0 failures
  const fUnshrinkable = await createEngineFixture();
  try {
    fUnshrinkable.addSystem('Stable system.');
    const u1 = fUnshrinkable.addUser('Preserve strict integer cents.');
    const longQuote = 'Keep full constraint wording intact: ' + 'R'.repeat(1600);
    const u2 = fUnshrinkable.addUser(longQuote);
    // Two tiny compact-checkpoint nodes carrying large preserved originals so minimumCheckpointBytes >= sourceBytes
    const cp1 = fUnshrinkable.session.append(
      'user/message',
      {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: 'tiny cp1' }],
        source: {
          kind: 'compact-checkpoint',
          compactionId: 'weave-tiny-1',
          preserved: [{ seq: u1.seq, blocks: [{ type: 'text', text: 'Preserve strict integer cents.' }] }],
        },
      },
      { surfaceOp: 'append' },
    );
    const cp2 = fUnshrinkable.session.append(
      'user/message',
      {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: 'tiny cp2' }],
        source: {
          kind: 'compact-checkpoint',
          compactionId: 'weave-tiny-2',
          preserved: [{ seq: u2.seq, blocks: [{ type: 'text', text: longQuote }] }],
        },
      },
      { surfaceOp: 'append' },
    );
    const eventsBefore = fUnshrinkable.events.length;
    const foldResult = await fUnshrinkable.engine._tryHierarchicalFold({
      session: fUnshrinkable.session,
      agent: fUnshrinkable.agent,
      signal: new AbortController().signal,
      batchCheckpointSeqs: [cp1.seq, cp2.seq],
      policy: fUnshrinkable.config,
      manual: true,
      maxTokens: fUnshrinkable.config.maxTokens,
      capacityContext: {},
      waveIndex: 1,
    });
    assert.equal(foldResult, null);
    assert.equal(fUnshrinkable.calls.length, 0);
    const added = fUnshrinkable.events.slice(eventsBefore);
    assert.equal(added.filter((e) => e.type === 'compaction/start').length, 0);
    assert.equal(added.filter((e) => e.type === 'compaction/end').length, 0);
    assert.equal(fUnshrinkable.engine.sessionState.read(fUnshrinkable.session.id).failures, 0);
  } finally {
    await fUnshrinkable.dispose();
  }

  // (b) _tryHierarchicalFold hitting a simulated provider failure leaves 0 start/end events & failures === 0
  let foldAttempted = 0;
  const fFoldFail = await createEngineFixture({
    extraConfig: { summaryConcurrency: 1, cacheMaxCheckpoints: 2, summaryInputMaxBytes: 60000 },
    streamHandler: async function* (opts) {
      const serialized = JSON.stringify(opts.messages.slice(0, -1));
      const instrText = blocksToText(opts.messages.at(-1)?.content);
      if (
        serialized.includes('This is an automatically generated checkpoint condensing an earlier span') &&
        !instrText.includes('Incremental span:')
      ) {
        foldAttempted += 1;
        throw new Error('simulated fold provider outage');
      }
      yield { type: 'text-delta', text: makeSummary('Preserve strict integer cents. ' + 'Detailed architectural checkpoint notes. '.repeat(25)) };
      yield { type: 'finish', kind: 'stop' };
    },
  });
  try {
    fFoldFail.addSystem('Stable system.');
    for (let i = 0; i < 4; i += 1) {
      fFoldFail.addUser('Preserve strict integer cents.');
      fFoldFail.addAssistant(`Batch chunk ${i}: ` + 'x'.repeat(50000));
    }
    fFoldFail.addUser('Final tail message.');

    const res = await fFoldFail.engine.compactNow(fFoldFail.agent, new AbortController().signal);
    assert.ok(res);
    assert.ok(foldAttempted >= 1, 'fold must have been attempted and hit simulated failure');
    const starts = fFoldFail.events.filter((e) => e.type === 'compaction/start');
    const summaries = fFoldFail.events.filter((e) => e.type === 'compaction/summary');
    const ends = fFoldFail.events.filter((e) => e.type === 'compaction/end');
    assert.equal(starts.length, summaries.length, 'zero empty compaction/start spins on failed fold');
    assert.equal(ends.length, summaries.length, 'zero empty compaction/end spins on failed fold');
    assert.equal(fFoldFail.engine.sessionState.read(fFoldFail.session.id).failures, 0);
  } finally {
    await fFoldFail.dispose();
  }

  // (c) archiveEnabled: false + quote eviction -> MEMORY_ARCHIVE_REQUIRED throws with 0 compaction/start & 0 compaction/end
  for (const mode of ['regionCore', 'compactNow']) {
    const fNoArchive = await createEngineFixture({
      extraConfig: { archiveEnabled: false, preserveRecentMessages: 1, continuationEnabled: false },
    });
    try {
      fNoArchive.addSystem('Stable system.');
      fNoArchive.addUser('First strict requirement that will be evicted: retain integer cents.');
      fNoArchive.addAssistant('Analysis part 1. '.repeat(400));
      fNoArchive.addUser('Second requirement kept in recent quote slot: verify outputs.');
      fNoArchive.addAssistant('Analysis part 2. '.repeat(400));
      if (mode === 'compactNow') fNoArchive.addUser('Tail prompt.');

      const startSeq = fNoArchive.surface.nodes[1];
      const endSeq = mode === 'compactNow' ? fNoArchive.surface.nodes.at(-2) : fNoArchive.surface.nodes.at(-1);

      if (mode === 'regionCore') {
        await assert.rejects(
          () => fNoArchive.engine._compactRegionCore(startSeq, endSeq, fNoArchive.agent, new AbortController().signal, {
            manual: true,
            policy: fNoArchive.config,
          }),
          (err) => err?.code === 'MEMORY_ARCHIVE_REQUIRED',
        );
      } else {
        await assert.rejects(
          () => fNoArchive.engine.compactNow(fNoArchive.agent, new AbortController().signal),
          (err) => err?.code === 'MEMORY_ARCHIVE_REQUIRED' || err?.cause?.code === 'MEMORY_ARCHIVE_REQUIRED',
        );
      }
      assert.equal(fNoArchive.calls.length, 0);
      assert.equal(fNoArchive.events.filter((e) => e.type === 'compaction/start').length, 0);
      assert.equal(fNoArchive.events.filter((e) => e.type === 'compaction/end').length, 0);
    } finally {
      await fNoArchive.dispose();
    }
  }
});

// ── 4e. Bulk fold threshold widening + intermediate 2400 char target ─────────
await test('bulk-fold-thresholds-and-intermediate-target-chars', async () => {
  // (a) >= 8 planned chunks with default cacheMaxCheckpoints: 4 -> widens fold threshold to 6,
  //     concurrent chunks (>= 4 totalChunks) receive 2400 targetChars, hierarchical folds receive 4000,
  //     and folded checkpoint preserves Folded archives: + merged Archived files:.
  const bulkCalls = [];
  const fBulk = await createEngineFixture({
    extraConfig: {
      summaryConcurrency: 2,
      summaryInputMaxBytes: 60000,
      cacheMaxCheckpoints: 4,
    },
    streamHandler: async function* (opts) {
      const priorText = JSON.stringify(opts.messages.slice(0, -1));
      const instrText = blocksToText(opts.messages.at(-1)?.content);
      const isFold =
        priorText.includes('This is an automatically generated checkpoint condensing an earlier span') &&
        !instrText.includes('Incremental span:');
      bulkCalls.push({ isFold, instrText });
      yield { type: 'text-delta', text: makeSummary('Preserve strict integer cents.') };
      yield { type: 'finish', kind: 'stop' };
    },
  });
  try {
    fBulk.addSystem('Stable system.');
    for (let i = 0; i < 10; i += 1) {
      fBulk.addUser('Preserve strict integer cents.');
      fBulk.addToolPair('read_file', { path: `src/mod-${i}.js` }, `export const m${i} = ${i};`);
      fBulk.addAssistant(`Bulk group ${i} payload: ` + 'b'.repeat(45000));
    }
    fBulk.addUser('Final tail turn.');

    const res = await fBulk.engine.compactNow(fBulk.agent, new AbortController().signal);
    assert.ok(res);

    const summaryEvents = fBulk.events.filter((e) => e.type === 'compaction/summary');
    const cpEvents = fBulk.events.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'compact-checkpoint');
    assert.ok(summaryEvents.length >= 10, `expected >= 10 compaction/summary events, got ${summaryEvents.length}`);

    // Identify the fold summary event (all its shadowedSeqs are prior compact-checkpoint user/messages)
    const cpSeqSet = new Set(cpEvents.map((e) => e.seq));
    const foldSummaries = summaryEvents.filter(
      (ev) => Array.isArray(ev.data?.shadowedSeqs) && ev.data.shadowedSeqs.length >= 2 && ev.data.shadowedSeqs.every((s) => cpSeqSet.has(s)),
    );
    assert.ok(foldSummaries.length >= 1, 'expected at least 1 hierarchical fold');
    assert.equal(foldSummaries[0].data.shadowedSeqs.length, 6, `default cacheMaxCheckpoints=4 with >=8 chunks must widen fold threshold to 6, got ${foldSummaries[0].data.shadowedSeqs.length}`);

    const foldCpEvent = cpEvents.find((e) => e.data?.source?.compactionId === foldSummaries[0].data.compactionId);
    assert.ok(foldCpEvent);
    const foldCpText = blocksToText(foldCpEvent.data.content);
    const expectedChildIds = foldSummaries[0].data.shadowedSeqs.map((seq) => fBulk.events[seq].data.source.compactionId);
    assert.match(foldCpText, /Folded archives:/);
    for (const cid of expectedChildIds) {
      assert.ok(foldCpText.includes(cid), `folded checkpoint must preserve child archive id ${cid}`);
    }
    assert.match(foldCpText, /Archived files:/);
    for (let i = 0; i < 6; i += 1) {
      assert.ok(foldCpText.includes(`src/mod-${i}.js`), `folded checkpoint must merge src/mod-${i}.js into Archived files`);
    }

    // Concurrent chunk calls (>= 4 chunks) use 2400; fold calls keep 4000
    const nonFoldCalls = bulkCalls.filter((c) => !c.isFold);
    const foldCalls = bulkCalls.filter((c) => c.isFold);
    assert.ok(nonFoldCalls.length >= 9);
    // Chunk 0 runs serially first; chunks 1..N run via _compactChunksConcurrent with 2400
    const concurrentChunkCalls = nonFoldCalls.slice(1);
    assert.ok(
      concurrentChunkCalls.every((c) => c.instrText.includes('2400') && !c.instrText.includes('4000')),
      'concurrent bulk chunk calls must pass 2400 targetChars',
    );
    assert.ok(foldCalls.length >= 1);
    assert.ok(
      foldCalls.every((c) => c.instrText.includes('4000') && !c.instrText.includes('2400')),
      'hierarchical fold calls must keep 4000 targetChars',
    );
  } finally {
    await fBulk.dispose();
  }

  // (b) Explicit custom cacheMaxCheckpoints: 2 still folds at 2 even when planned chunks >= 8
  const fCustom = await createEngineFixture({
    extraConfig: {
      summaryConcurrency: 2,
      summaryInputMaxBytes: 60000,
      cacheMaxCheckpoints: 2,
    },
  });
  try {
    fCustom.addSystem('Stable system.');
    for (let i = 0; i < 9; i += 1) {
      fCustom.addUser('Preserve strict integer cents.');
      fCustom.addAssistant(`Custom fold ${i} payload: ` + 'c'.repeat(45000));
    }
    fCustom.addUser('Final tail turn.');

    const res = await fCustom.engine.compactNow(fCustom.agent, new AbortController().signal);
    assert.ok(res);
    const cpSeqSet = new Set(
      fCustom.events
        .filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'compact-checkpoint')
        .map((e) => e.seq),
    );
    const foldSummaries = fCustom.events.filter(
      (e) =>
        e.type === 'compaction/summary' &&
        Array.isArray(e.data?.shadowedSeqs) &&
        e.data.shadowedSeqs.length >= 2 &&
        e.data.shadowedSeqs.every((s) => cpSeqSet.has(s)),
    );
    assert.ok(foldSummaries.length >= 1);
    assert.equal(foldSummaries[0].data.shadowedSeqs.length, 2, 'explicit custom cacheMaxCheckpoints=2 must still fold at 2');
  } finally {
    await fCustom.dispose();
  }

  // (c) Small concurrent batch (< 4 chunks) keeps 4000 targetChars
  const smallCalls = [];
  const fSmall = await createEngineFixture({
    extraConfig: {
      summaryConcurrency: 2,
      summaryInputMaxBytes: 60000,
    },
    streamHandler: async function* (opts) {
      smallCalls.push(blocksToText(opts.messages.at(-1)?.content));
      yield { type: 'text-delta', text: makeSummary('Preserve strict integer cents.') };
      yield { type: 'finish', kind: 'stop' };
    },
  });
  try {
    fSmall.addSystem('Stable system.');
    for (let i = 0; i < 3; i += 1) {
      fSmall.addUser('Preserve strict integer cents.');
      fSmall.addAssistant(`Small batch ${i} payload: ` + 's'.repeat(45000));
    }
    fSmall.addUser('Final tail turn.');

    const res = await fSmall.engine.compactNow(fSmall.agent, new AbortController().signal);
    assert.ok(res);
    assert.equal(smallCalls.length, 3, `expected 3 chunks in small batch, got ${smallCalls.length}`);
    assert.ok(
      smallCalls.every((txt) => txt.includes('4000') && !txt.includes('2400')),
      'small batches (< 4 chunks) must keep 4000 targetChars',
    );
  } finally {
    await fSmall.dispose();
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
