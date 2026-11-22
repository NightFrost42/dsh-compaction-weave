import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const imageBytes = Buffer.alloc(1024, 7);
const fileBytes = Buffer.alloc(512, 9);
const imageId = 'sha256:' + createHash('sha256').update(imageBytes).digest('hex');
const fileId = 'sha256:' + createHash('sha256').update(fileBytes).digest('hex');
const attachmentFixture = {
  async readImage() {
    return { data: imageBytes };
  },
  async *readFileStream() {
    yield fileBytes;
  },
};

import { CompactionArchive } from '../lib/history.js';
import { blocksToText } from '../lib/meter.js';
import {
  MAX_MASK_STAGE_REFS,
  MICROCOMPACT_SUPERSEDED_MARKER,
  OBSERVATION_MASK_MARKER,
  PERSISTED_OUTPUT_MARKER,
  extractToolLocator,
  formatMaskedToolText,
  inspectMaskSourceStats,
  isArchivedToolStubText,
  planObservationMask,
} from '../lib/observation-mask.js';
import {
  DEFAULT_PERSISTED_OUTPUT_HEAD_CHARS,
  DEFAULT_PERSISTED_OUTPUT_TAIL_CHARS,
  DEFAULT_PERSISTED_OUTPUT_THRESHOLD_CHARS,
  commitPersistedOutput,
  findTailToolResultSeqs,
  planPersistedOutput,
} from '../lib/persisted-output.js';
import {
  DEFAULT_MICROCOMPACT_HEAD_CHARS,
  DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS,
  DEFAULT_MICROCOMPACT_REPEATED_READ_MIN_CHARS,
  DEFAULT_MICROCOMPACT_TAIL_CHARS,
  DEFAULT_MICROCOMPACT_THRESHOLD_CHARS,
  commitMicrocompact,
  planMicrocompact,
} from '../lib/microcompact.js';
import { deduplicateRepeatedFileReads } from '../lib/reference-input.js';

const results = [];
async function test(name, fn) {
  const start = performance.now();
  try {
    await fn();
    results.push({ name, pass: true, ms: Math.round(performance.now() - start) });
  } catch (error) {
    results.push({
      name,
      pass: false,
      ms: Math.round(performance.now() - start),
      error: error?.message ?? String(error),
      stack: error?.stack,
    });
  }
}

function makeSession({ openTurn = 1 } = {}) {
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  let turnOpen = openTurn !== null;

  const session = {
    id: `sess-${randomUUID()}`,
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => [...events],
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (event.type === 'system/message') return event.data?.message;
      if (event.type === 'user/message') return event.data;
      if (event.type === 'assistant/message') return event.data?.message;
      if (event.type === 'tool/result') return event.data?.message;
      return undefined;
    },
    append(type, data, options = {}) {
      if (type === 'turn/start') turnOpen = true;
      if (type === 'turn/end') turnOpen = false;
      const op = options.surfaceOp;
      if (type === 'tool/result' && op?.op === 'replace') {
        assert.equal(turnOpen, true, 'DSH V4 forbids tool/result replace outside open turn');
        assert.equal(op.startSeq, op.endSeq, 'assertToolResultRewrite requires single-node replace');
        const prev = events[op.startSeq];
        assert.ok(prev && prev.type === 'tool/result', 'replace target must be tool/result');
        assert.deepEqual(options.sourceEventSeqs, [op.startSeq], 'must cite replaced seq');
        const { message: prevMsg, ...prevRest } = prev.data;
        const { message: nextMsg, ...nextRest } = data;
        assert.deepEqual(nextRest, prevRest, 'assertToolResultRewrite: non-message fields must stay identical');
        const { content: _pc, ...prevMeta } = prevMsg;
        const { content: _nc, ...nextMeta } = nextMsg;
        assert.deepEqual(nextMeta, prevMeta, 'assertToolResultRewrite: only message.content may change');
      }

      const event = {
        seq: events.length,
        type,
        data,
        ...(Array.isArray(options.sourceEventSeqs) ? { sourceEventSeqs: [...options.sourceEventSeqs] } : {}),
      };
      events.push(event);
      if (op?.op === 'replace') {
        const start = surface.nodes.indexOf(op.startSeq);
        const end = surface.nodes.indexOf(op.endSeq);
        assert.ok(start >= 0 && end >= start, 'invalid replace range');
        surface.nodes.splice(start, end - start + 1, event.seq);
        surface.replaceGeneration += 1;
      } else if (op === 'append') {
        surface.nodes.push(event.seq);
      }
      return event;
    },
  };

  if (openTurn !== null) {
    session.append('turn/start', { turn: openTurn });
  }

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
      { message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } },
      { surfaceOp: 'append' },
    );

  const addAssistantToolCall = (calls) => {
    const callEvents = [];
    const blocks = [];
    for (const c of calls) {
      const callId = c.callId ?? `call-${randomUUID()}`;
      const argsJson = typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {});
      const ce = session.append('tool/call', { callId, name: c.name, arguments: argsJson });
      callEvents.push(ce);
      blocks.push({ type: 'tool-call', id: callId, callId, name: c.name, toolName: c.name, arguments: argsJson, args: c.args ?? {} });
    }
    const assistantEvent = session.append(
      'assistant/message',
      { message: { id: randomUUID(), role: 'assistant', content: blocks, source: { kind: 'model' } } },
      { surfaceOp: 'append' },
    );
    return { callEvents, assistantEvent };
  };

  const addToolResult = (callEvent, textOrBlocks, { isError = false, extraSources = [], customSourceSeqs } = {}) => {
    const content = Array.isArray(textOrBlocks)
      ? textOrBlocks
      : [{ type: 'text', text: textOrBlocks }];
    const callId = callEvent.data.callId;
    const sourceEventSeqs = customSourceSeqs ?? [callEvent.seq, ...extraSources];
    return session.append(
      'tool/result',
      {
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: callId,
          content,
          source: { kind: 'tool-result', callId },
          ...(isError ? { isError: true } : {}),
        },
        extraTag: 'preserve-me',
      },
      {
        surfaceOp: 'append',
        ...(sourceEventSeqs !== null ? { sourceEventSeqs } : {}),
      },
    );
  };

  const measure = (overridePriced = null) => {
    const pricedBySeq = new Map();
    const nodes = surface.nodes.map((seq) => {
      const msg = session.deriveEventMessage(events[seq]);
      const tokens = overridePriced?.get(seq) ?? Math.ceil(blocksToText(msg?.content).length / 4);
      pricedBySeq.set(seq, tokens);
      return { seq, tokens };
    });
    return {
      nodes,
      pricedBySeq,
      totalTokens: nodes.reduce((s, n) => s + n.tokens, 0),
      precision: 'heuristic',
    };
  };

  return {
    session,
    events,
    surface,
    addSystem,
    addUser,
    addAssistant,
    addAssistantToolCall,
    addToolResult,
    measure,
  };
}

const baseRoot = process.env.WEAVE_TEST_ROOT ?? tmpdir();

await test('shared-stub-detection-and-reference-input-dedup-skip', () => {
  assert.equal(OBSERVATION_MASK_MARKER, '[Output masked; archived at ');
  assert.equal(PERSISTED_OUTPUT_MARKER, '[Large tool output persisted; archived at ');
  assert.equal(MICROCOMPACT_SUPERSEDED_MARKER, '[Earlier read of ');

  const maskStub = `${OBSERVATION_MASK_MARKER}c1 seq=2; omitted 5000 chars of 5600. Call history_read({ compactionId: "c1", seq: 2 }) if exact output is needed.]`;
  const persistStub = `${PERSISTED_OUTPUT_MARKER}c2 seq=4; omitted 30000 chars of 32400. Call history_read({ compactionId: "c2", seq: 4 }) if exact output is needed.]`;
  const supersedeStub = `${MICROCOMPACT_SUPERSEDED_MARKER}src/app.js at seq 6 superseded by seq 12; archived at c3 seq=6. Call history_read({ compactionId: "c3", seq: 6 }) if exact output is needed.]`;
  const decoyWithoutHistoryRead = `${MICROCOMPACT_SUPERSEDED_MARKER}src/app.js in prose only without tool call`;

  assert.equal(isArchivedToolStubText(maskStub), true);
  assert.equal(isArchivedToolStubText(persistStub), true);
  assert.equal(isArchivedToolStubText(supersedeStub), true);
  assert.equal(isArchivedToolStubText(decoyWithoutHistoryRead), false);
  assert.equal(isArchivedToolStubText(null), false);
  assert.equal(isArchivedToolStubText(undefined), false);
  assert.equal(isArchivedToolStubText(42), false);

  // formatMaskedToolText refuses to double-mask any already-stubbed text (even if >= thresholdChars)
  assert.equal(
    formatMaskedToolText(persistStub + 'X'.repeat(5000), {
      compactionId: 're-mask',
      seq: 4,
      thresholdChars: 1000,
      headChars: 100,
      tailChars: 100,
    }),
    null,
  );
  assert.equal(
    formatMaskedToolText(supersedeStub + 'Y'.repeat(5000), {
      compactionId: 're-mask',
      seq: 6,
      thresholdChars: 1000,
      headChars: 100,
      tailChars: 100,
    }),
    null,
  );

  // deduplicateRepeatedFileReads skips persisted-output & microcompact stubs
  const f = makeSession();
  const c1 = f.addAssistantToolCall([{ name: 'read_file', args: { path: 'src/dup.js' } }]);
  const r1 = f.addToolResult(c1.callEvents[0], `${persistStub}${'P'.repeat(2500)}`);
  const c2 = f.addAssistantToolCall([{ name: 'read_file', args: { path: 'src/dup.js' } }]);
  const r2 = f.addToolResult(c2.callEvents[0], `${supersedeStub}${'S'.repeat(2500)}`);
  const c3 = f.addAssistantToolCall([{ name: 'read_file', args: { path: 'src/dup.js' } }]);
  const r3 = f.addToolResult(c3.callEvents[0], 'REAL_READ_CONTENT_'.repeat(200));

  const dedup = deduplicateRepeatedFileReads(f.session, f.surface.nodes);
  assert.equal(dedup.has(r1.seq), false, 'persisted-output stub must be skipped by dedup');
  assert.equal(dedup.has(r2.seq), false, 'microcompact superseded stub must be skipped by dedup');
  assert.equal(dedup.has(r3.seq), false);

  // Also test extractToolLocator & inspectMaskSourceStats exports
  const loc = extractToolLocator(f.session, r3.seq, r3);
  assert.equal(loc.toolName, 'read_file');
  assert.equal(loc.target, 'src/dup.js');
  const stats = inspectMaskSourceStats(f.session, r3.seq);
  assert.deepEqual(stats, { depth: 1, refs: 1 });
});

await test('persisted-output-tail-boundary-and-turn-safety', () => {
  assert.equal(DEFAULT_PERSISTED_OUTPUT_THRESHOLD_CHARS, 32768);
  assert.equal(DEFAULT_PERSISTED_OUTPUT_HEAD_CHARS, 1200);
  assert.equal(DEFAULT_PERSISTED_OUTPUT_TAIL_CHARS, 1200);

  // Idle session (openTurn === null) returns empty tail & null plan
  const idle = makeSession({ openTurn: null });
  const ceIdle = idle.session.append('tool/call', { callId: 'c0', name: 'bash', arguments: '{"command":"ls"}' });
  idle.addToolResult(ceIdle, 'Z'.repeat(40000));
  assert.deepEqual(findTailToolResultSeqs(idle.session), []);
  assert.equal(planPersistedOutput(idle.session, { compactionId: 'po-idle' }), null);

  // Open turn: test every boundary type: assistant/message, assistant/attempt, turn/start, step/start, turn/end
  for (const boundaryType of ['assistant/message', 'assistant/attempt', 'turn/start', 'step/start']) {
    const f = makeSession({ openTurn: 1 });
    const cOld = f.addAssistantToolCall([{ name: 'read_file', args: { path: 'old.txt' } }]);
    const oldRes = f.addToolResult(cOld.callEvents[0], 'OLD_GIANT_'.repeat(5000));
    if (boundaryType === 'turn/start') {
      f.session.append('turn/start', { turn: 2 });
    } else if (boundaryType === 'assistant/message') {
      f.addAssistant('Step note');
    } else {
      f.session.append(boundaryType, {});
    }
    const cNewCall = f.session.append('tool/call', { callId: 'c-new', name: 'bash', arguments: '{"command":"cat big.log"}' });
    const newRes = f.addToolResult(cNewCall, 'NEW_GIANT_'.repeat(5000));

    const tail = findTailToolResultSeqs(f.session);
    assert.deepEqual(tail, [newRes.seq], `boundary ${boundaryType} must exclude historical ${oldRes.seq}`);

    const plan = planPersistedOutput(f.session, { compactionId: `po-${boundaryType}` });
    assert.ok(plan);
    assert.deepEqual(
      plan.targets.map((t) => t.seq),
      [newRes.seq],
    );
  }

  // After turn/end, openTurn becomes null again -> returns [] / null
  const closed = makeSession({ openTurn: 1 });
  const c1 = closed.addAssistantToolCall([{ name: 'bash', args: { command: 'echo big' } }]);
  closed.addToolResult(c1.callEvents[0], 'B'.repeat(40000));
  closed.session.append('turn/end', { turn: 1 });
  assert.deepEqual(findTailToolResultSeqs(closed.session), []);
  assert.equal(planPersistedOutput(closed.session, { compactionId: 'po-closed' }), null);
});

await test('persisted-output-spill-recovery-idempotency-and-error-nontext', async () => {
  const root = await mkdtemp(join(baseRoot, 'weave-po-'));
  try {
    const f = makeSession({ openTurn: 1 });
    f.addSystem('System instructions.');
    f.addUser('Inspect logs.');

    // Historical oversized tool/result before assistant/message boundary -> NEVER spilled
    const histCall = f.addAssistantToolCall([{ name: 'read_file', args: { path: 'hist.log' } }]);
    const histBody = 'HIST_HEAD_' + 'H'.repeat(38000) + '_HIST_TAIL';
    const histRes = f.addToolResult(histCall.callEvents[0], histBody);

    // Next model turn emits 3 tool calls; results land at the tail
    const tailCalls = f.addAssistantToolCall([
      { name: 'read_file', args: { path: 'small.txt' } },
      { name: 'bash', args: { command: 'npm test' } },
      { name: 'read_file', args: { path: 'huge.log' } },
    ]);
    const smallRes = f.addToolResult(tailCalls.callEvents[0], 'small ok output');
    const errRes = f.addToolResult(tailCalls.callEvents[1], 'ERR_HEAD_' + 'E'.repeat(40000), { isError: true });

    // Multi-block with surrogate pair chars + non-text image block
    const hugeHead = '🚀HEAD_'.repeat(300); // 6 code points * 300 = 1800 code points
    const hugeTail = '_TAIL🧩'.repeat(300);
    const hugeBody = `${hugeHead}${'X'.repeat(32000)}${hugeTail}`;
    const imageBlock = {
      type: 'image',
      attachment: { attachmentId: imageId, bytes: imageBytes.length },
      mimeType: 'image/png',
    };
    const hugeRes = f.addToolResult(tailCalls.callEvents[2], [{ type: 'text', text: hugeBody }, imageBlock]);

    // Missing compactionId -> null
    assert.equal(planPersistedOutput(f.session, {}), null);

    const plan = planPersistedOutput(f.session, { compactionId: 'weave-po-1' });
    assert.ok(plan);
    assert.equal(plan.compactionId, 'weave-po-1');
    assert.deepEqual(
      plan.targets.map((t) => t.seq),
      [hugeRes.seq],
    );
    assert.ok(plan.totalTokensSaved > 7000);
    assert.equal(plan.hasMore, false);

    // Commit with verified attachment backup
    const archive = new CompactionArchive({ root: join(root, 'archive') });
    archive.attachments = attachmentFixture;
    const committed = await commitPersistedOutput({ session: f.session, plan, archive });
    assert.ok(committed);
    assert.deepEqual(committed.maskedSeqs, [hugeRes.seq]);
    assert.equal(committed.maskedCount, 1);

    // Historical, small, and error results remain untouched on surface
    assert.ok(f.surface.nodes.includes(histRes.seq));
    assert.ok(f.surface.nodes.includes(smallRes.seq));
    assert.ok(f.surface.nodes.includes(errRes.seq));
    assert.equal(blocksToText(f.session.eventAt(histRes.seq).data.message.content), histBody);
    assert.ok(blocksToText(f.session.eventAt(errRes.seq).data.message.content).startsWith('ERR_HEAD_'));

    // Replaced tail node uses PERSISTED_OUTPUT_MARKER & keeps non-text block intact
    const replacedSeq = f.surface.nodes.find((s) => s > hugeRes.seq);
    assert.ok(replacedSeq !== undefined);
    const replacedMsg = f.session.eventAt(replacedSeq).data.message;
    assert.equal(replacedMsg.content.length, 2);
    assert.deepEqual(replacedMsg.content[1], imageBlock);
    const stubText = replacedMsg.content[0].text;
    assert.ok(stubText.includes(PERSISTED_OUTPUT_MARKER));
    assert.ok(stubText.includes(`history_read({ compactionId: "weave-po-1", seq: ${hugeRes.seq} })`));
    assert.ok(stubText.includes('read_file "huge.log"'));
    assert.ok(stubText.startsWith(Array.from(hugeBody).slice(0, 1200).join('')));
    assert.ok(stubText.endsWith(Array.from(hugeBody).slice(-1200).join('')));
    assert.equal(isArchivedToolStubText(stubText), true);

    // Exact recovery from archive
    const span = await archive.readSpan(f.session.id, 'weave-po-1');
    assert.equal(span.ok, true);
    const recovered = span.entries.find((e) => e.seq === hugeRes.seq);
    assert.equal(recovered?.event?.data?.message?.content?.[0]?.text, hugeBody);
    assert.deepEqual(recovered?.event?.data?.message?.content?.[1], imageBlock);

    // Idempotency & non-chaining: re-running persisted-output returns null, and
    // observation-mask never targets the persisted-output replacement node.
    assert.equal(planPersistedOutput(f.session, { compactionId: 'weave-po-2' }), null);
    const omAfterPo = planObservationMask(f.session, f.measure(), 10, {
      compactionId: 'om-after-po',
      thresholdChars: 500,
    });
    assert.ok(omAfterPo, 'only unmasked historical histRes remains eligible');
    assert.deepEqual(
      omAfterPo.targets.map((t) => t.seq),
      [histRes.seq],
    );
    assert.equal(omAfterPo.targets.some((t) => t.seq === replacedSeq), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('persisted-output-fail-open-pre-mutation-vs-abort-and-post-mutation', async () => {
  const root = await mkdtemp(join(baseRoot, 'weave-po-fail-'));
  try {
    const f = makeSession({ openTurn: 1 });
    const tc = f.addAssistantToolCall([{ name: 'bash', args: { command: 'dump' } }]);
    const big = f.addToolResult(tc.callEvents[0], 'D'.repeat(35000));
    const plan = planPersistedOutput(f.session, { compactionId: 'po-fail' });
    assert.ok(plan);

    // 1. Pre-mutation thrown archive error -> logs warn & returns null (fail-open)
    const warnings = [];
    const throwingArchive = {
      async writeSpan() {
        throw new Error('EACCES archive failure');
      },
    };
    const eventsBefore = f.events.length;
    const nodesBefore = [...f.surface.nodes];
    const failOpenRes = await commitPersistedOutput({
      session: f.session,
      plan,
      archive: throwingArchive,
      log: (level, msg) => warnings.push({ level, msg }),
    });
    assert.equal(failOpenRes, null);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, 'warn');
    assert.equal(f.events.length, eventsBefore);
    assert.deepEqual(f.surface.nodes, nodesBefore);

    // 2. Real CompactionArchive on unwritable path (file blocking dir) -> returns null cleanly
    const blockerFile = join(root, 'not-a-dir');
    await writeFile(blockerFile, 'blocker', 'utf8');
    const badArchive = new CompactionArchive({ root: blockerFile });
    const badArchiveRes = await commitPersistedOutput({
      session: f.session,
      plan,
      archive: badArchive,
      log: (level, msg) => warnings.push({ level, msg }),
    });
    assert.equal(badArchiveRes, null);
    assert.equal(f.events.length, eventsBefore);

    // 3. Aborted signal -> rethrows
    const ac = new AbortController();
    ac.abort(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
    await assert.rejects(
      commitPersistedOutput({
        session: f.session,
        plan,
        archive: throwingArchive,
        signal: ac.signal,
      }),
      (err) => err?.code === 'ABORTED',
    );

    // 4. Error with name === 'AbortError' even if signal not passed -> rethrows
    const abortArchive = {
      async writeSpan() {
        throw Object.assign(new Error('abort'), { name: 'AbortError' });
      },
    };
    await assert.rejects(
      commitPersistedOutput({ session: f.session, plan, archive: abortArchive }),
      (err) => err?.name === 'AbortError',
    );

    // 5. Post-mutation error (surfaceMutated === true via flushSession throw) -> rethrows
    const okArchive = new CompactionArchive({ root: join(root, 'ok-archive') });
    await assert.rejects(
      commitPersistedOutput({
        session: f.session,
        plan,
        archive: okArchive,
        flushSession: async () => {
          throw new Error('flush failed');
        },
      }),
      (err) => err?.surfaceMutated === true,
    );
    assert.ok(!f.surface.nodes.includes(big.seq), 'surface was mutated before flush failed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('persisted-output-invalid-provenance-and-batch-cap', () => {
  const f = makeSession({ openTurn: 1 });
  const c = f.addAssistantToolCall([
    { name: 'bash', args: { command: 'bad' } },
    { name: 'bash', args: { command: 'good1' } },
    { name: 'bash', args: { command: 'good2' } },
  ]);
  f.addToolResult(c.callEvents[0], 'X'.repeat(35000), { customSourceSeqs: [] }); // invalid provenance
  const g1 = f.addToolResult(c.callEvents[1], 'G1_'.repeat(12000));
  const g2 = f.addToolResult(c.callEvents[2], 'G2_'.repeat(12000));

  const plan = planPersistedOutput(f.session, { compactionId: 'po-cap', maxBatchRefs: 2 });
  assert.ok(plan);
  assert.deepEqual(
    plan.targets.map((t) => t.seq),
    [g1.seq],
  );
  assert.equal(plan.batchRefs, 2);
  assert.equal(plan.hasMore, true);
  assert.ok(g2.seq > g1.seq);
});

await test('microcompact-hot-k-protection-repeated-read-supersede-and-masking', async () => {
  assert.equal(DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS, 4);
  assert.equal(DEFAULT_MICROCOMPACT_THRESHOLD_CHARS, 2000);
  assert.equal(DEFAULT_MICROCOMPACT_HEAD_CHARS, 200);
  assert.equal(DEFAULT_MICROCOMPACT_TAIL_CHARS, 200);
  assert.equal(DEFAULT_MICROCOMPACT_REPEATED_READ_MIN_CHARS, 2000);

  const root = await mkdtemp(join(baseRoot, 'weave-mc-'));
  try {
    // 1. openTurn === null safety
    const idle = makeSession({ openTurn: null });
    const idleCall = idle.session.append('tool/call', { callId: 'c0', name: 'bash', arguments: '{}' });
    idle.addToolResult(idleCall, 'I'.repeat(5000));
    assert.equal(planMicrocompact(idle.session, idle.measure(), { compactionId: 'mc-idle' }), null);
    assert.equal(
      await commitMicrocompact({
        session: idle.session,
        plan: { compactionId: 'mc-idle', targets: [{ seq: 1, nextContent: [{ type: 'text', text: 'x' }], savedTokens: 1 }] },
        archive: new CompactionArchive({ root: join(root, 'idle-arch') }),
      }),
      null,
    );

    // 2. Active session testing all Pass A + Pass B + Hot-K + error/prose protection
    const f = makeSession({ openTurn: 1 });
    f.addSystem('System prompt must stay untouched.');
    const userMsg = f.addUser('Important user prompt prose. '.repeat(500)); // > 10k chars user prose
    const asstProse = f.addAssistant('Important assistant analysis prose. '.repeat(500)); // > 10k chars assistant prose

    // Older tools (outside hot-4):
    // (a) Older read of src/config.js (3000 chars) + non-text attachment, later superseded by hot read!
    const oldReadCall = f.addAssistantToolCall([{ name: 'read_file', args: { path: 'src/config.js' } }]);
    const oldReadBody = 'OLD_CONFIG_V1_' + 'C'.repeat(3000) + '_END_V1';
    const attBlock = {
      type: 'file',
      attachment: { attachmentId: fileId, bytes: fileBytes.length },
      name: 'config.bin',
    };
    const oldReadRes = f.addToolResult(oldReadCall.callEvents[0], [{ type: 'text', text: oldReadBody }, attBlock]);

    // (b) Distinct slice of src/sliced.js (startLine 1..50) -> NOT superseded by startLine 51..100, so Pass B masks it
    const slice1Call = f.addAssistantToolCall([{ name: 'read_file', args: { path: 'src/sliced.js', startLine: 1, endLine: 50 } }]);
    const slice1Body = 'SLICE1_HEAD_' + 'S'.repeat(2500) + '_SLICE1_TAIL';
    const slice1Res = f.addToolResult(slice1Call.callEvents[0], slice1Body);

    // (c) Older non-read bash output >= 2000 chars -> Pass B masks it
    const oldBashCall = f.addAssistantToolCall([{ name: 'bash', args: { command: 'npm run build' } }]);
    const oldBashBody = 'BUILD_HEAD_' + 'B'.repeat(3500) + '_BUILD_TAIL';
    const oldBashRes = f.addToolResult(oldBashCall.callEvents[0], oldBashBody);

    // (d) Older small tool output (< 2000 chars) -> untouched
    const smallCall = f.addAssistantToolCall([{ name: 'bash', args: { command: 'pwd' } }]);
    const smallRes = f.addToolResult(smallCall.callEvents[0], '/workspace/project');

    // (e) Older error tool output (>= 2000 chars, isError: true) -> untouched AND must NOT consume a hot-K slot!
    const errCall = f.addAssistantToolCall([{ name: 'bash', args: { command: 'npm test' } }]);
    const errRes = f.addToolResult(errCall.callEvents[0], 'ERR_OLD_' + 'E'.repeat(3000), { isError: true });

    // Newest 4 successful tool outputs (protected hot-K = 4) + 1 interleaved error tool:
    const hot1Call = f.addAssistantToolCall([{ name: 'read_file', args: { path: 'src/sliced.js', startLine: 51, endLine: 100 } }]);
    const hot1Res = f.addToolResult(hot1Call.callEvents[0], 'HOT_SLICE2_' + '2'.repeat(3000));

    // Hot #2 is an earlier read of src/hot-dup.js, AND Hot #4 is a later read of src/hot-dup.js:
    // Because BOTH are in hot-4, Hot #2 MUST remain protected and NOT be superseded!
    const hot2Call = f.addAssistantToolCall([{ name: 'read_file', args: { path: 'src/hot-dup.js' } }]);
    const hot2Res = f.addToolResult(hot2Call.callEvents[0], 'HOT_DUP_FIRST_' + 'D'.repeat(2500));

    // Interleaved error inside tail: must NOT consume one of the 4 successful slots!
    const tailErrCall = f.addAssistantToolCall([{ name: 'bash', args: { command: 'lint' } }]);
    const tailErrRes = f.addToolResult(tailErrCall.callEvents[0], 'ERR_TAIL_' + 'F'.repeat(3000), { isError: true });

    // Hot #3 supersedes oldReadRes!
    const hot3Call = f.addAssistantToolCall([{ name: 'read_file', args: { path: 'src/config.js' } }]);
    const hot3Res = f.addToolResult(hot3Call.callEvents[0], 'HOT_CONFIG_V2_' + 'N'.repeat(2500));

    // Hot #4
    const hot4Call = f.addAssistantToolCall([{ name: 'read_file', args: { path: 'src/hot-dup.js' } }]);
    const hot4Res = f.addToolResult(hot4Call.callEvents[0], 'HOT_DUP_SECOND_' + 'M'.repeat(2500));

    // Verify missing compactionId returns null
    assert.equal(planMicrocompact(f.session, f.measure(), {}), null);

    // Check pricedBySeq bounding: cap oldBashRes priced tokens to 100
    const customPriced = new Map([[oldBashRes.seq, 100]]);
    const m = f.measure(customPriced);
    const plan = planMicrocompact(f.session, m, { compactionId: 'mc-1' });
    assert.ok(plan);
    assert.equal(plan.repeatedReadCount, 1);
    assert.equal(plan.maskedToolCount, 2);
    assert.deepEqual(
      plan.targets.map((t) => t.seq),
      [oldReadRes.seq, slice1Res.seq, oldBashRes.seq],
    );
    const bashTarget = plan.targets.find((t) => t.seq === oldBashRes.seq);
    assert.equal(bashTarget.savedTokens, 100, 'savedTokens must be bounded by measurement.pricedBySeq');

    const archive = new CompactionArchive({ root: join(root, 'archive') });
    archive.attachments = attachmentFixture;
    const committed = await commitMicrocompact({ session: f.session, plan, archive });
    assert.ok(committed);
    assert.equal(committed.repeatedReadCount, 1);
    assert.equal(committed.maskedToolCount, 2);
    assert.equal(committed.maskedCount, 3);

    // User, assistant, system, small, errors, and all 4 hot tools stay verbatim on surface
    assert.ok(f.surface.nodes.includes(userMsg.seq));
    assert.ok(f.surface.nodes.includes(asstProse.seq));
    assert.ok(f.surface.nodes.includes(smallRes.seq));
    assert.ok(f.surface.nodes.includes(errRes.seq));
    assert.ok(f.surface.nodes.includes(tailErrRes.seq));
    for (const hot of [hot1Res, hot2Res, hot3Res, hot4Res]) {
      assert.ok(f.surface.nodes.includes(hot.seq), `hot tool seq ${hot.seq} must remain untouched`);
    }

    // Check superseded stub on oldReadRes replacement
    const replacedOldReadSeq = f.surface.nodes.find((s) => {
      const ev = f.session.eventAt(s);
      return ev?.type === 'tool/result' && ev.data?.message?.toolCallId === oldReadRes.data.message.toolCallId;
    });
    assert.ok(replacedOldReadSeq > oldReadRes.seq);
    const replacedOldReadMsg = f.session.eventAt(replacedOldReadSeq).data.message;
    assert.equal(replacedOldReadMsg.content.length, 2);
    assert.deepEqual(replacedOldReadMsg.content[1], attBlock);
    assert.equal(
      replacedOldReadMsg.content[0].text,
      `[Earlier read of src/config.js at seq ${oldReadRes.seq} superseded by seq ${hot3Res.seq}; archived at mc-1 seq=${oldReadRes.seq}. Call history_read({ compactionId: "mc-1", seq: ${oldReadRes.seq} }) if exact output is needed.]`,
    );
    assert.equal(isArchivedToolStubText(replacedOldReadMsg.content[0].text), true);

    // Check Pass B mask on oldBashRes replacement (200-char head & tail)
    const replacedBashSeq = f.surface.nodes.find((s) => {
      const ev = f.session.eventAt(s);
      return ev?.type === 'tool/result' && ev.data?.message?.toolCallId === oldBashRes.data.message.toolCallId;
    });
    const bashStubText = f.session.eventAt(replacedBashSeq).data.message.content[0].text;
    assert.ok(bashStubText.includes(OBSERVATION_MASK_MARKER));
    assert.ok(bashStubText.startsWith(oldBashBody.slice(0, 200)));
    assert.ok(bashStubText.endsWith(oldBashBody.slice(-200)));

    // Archive recovers all 3 original payloads verbatim
    const span = await archive.readSpan(f.session.id, 'mc-1');
    assert.equal(span.ok, true);
    assert.equal(span.entries.find((e) => e.seq === oldReadRes.seq)?.event?.data?.message?.content?.[0]?.text, oldReadBody);
    assert.equal(span.entries.find((e) => e.seq === slice1Res.seq)?.text, slice1Body);
    assert.equal(span.entries.find((e) => e.seq === oldBashRes.seq)?.text, oldBashBody);

    // Idempotency: immediate re-plan returns null, and observation-mask never re-masks microcompact stubs
    assert.equal(planMicrocompact(f.session, f.measure(), { compactionId: 'mc-2' }), null);
    const replacedSlice1Seq = f.surface.nodes.find((s) => {
      const ev = f.session.eventAt(s);
      return ev?.type === 'tool/result' && ev.data?.message?.toolCallId === slice1Res.data.message.toolCallId;
    });
    const omAfterMc = planObservationMask(f.session, f.measure(), 10, {
      compactionId: 'om-after-mc',
      thresholdChars: 100,
    });
    assert.ok(omAfterMc);
    for (const stubSeq of [replacedOldReadSeq, replacedSlice1Seq, replacedBashSeq]) {
      assert.equal(
        omAfterMc.targets.some((t) => t.seq === stubSeq),
        false,
        `observation-mask must not re-mask microcompact stub seq ${stubSeq}`,
      );
    }

    // With keepRecentTools = 0 and null measurement, hot tools (including hot2Res superseded by hot4Res!) become eligible
    const zeroKeepPlan = planMicrocompact(f.session, null, { compactionId: 'mc-zero-keep', keepRecentTools: 0 });
    assert.ok(zeroKeepPlan);
    assert.equal(zeroKeepPlan.repeatedReadCount, 1); // hot2Res superseded by hot4Res
    assert.equal(zeroKeepPlan.maskedToolCount, 3); // hot1Res, hot3Res, hot4Res
    assert.deepEqual(
      zeroKeepPlan.targets.map((t) => t.seq),
      [hot1Res.seq, hot2Res.seq, hot3Res.seq, hot4Res.seq],
    );
    const zeroKeepCommit = await commitMicrocompact({ session: f.session, plan: zeroKeepPlan, archive });
    assert.ok(zeroKeepCommit);
    assert.equal(
      planObservationMask(f.session, f.measure(), 10, { compactionId: 'om-all-stubbed', thresholdChars: 100 }),
      null,
      'once all tool outputs are microcompacted, observation-mask must find nothing to re-mask',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('microcompact-maxBatchRefs-hasMore-ascending-order-across-passes', async () => {
  const root = await mkdtemp(join(baseRoot, 'weave-mc-cap-'));
  try {
    const f = makeSession({ openTurn: 1 });
    // Create interleaved Pass B & Pass A candidates:
    // seq A (Pass B bash), seq B (Pass A read1), seq C (Pass B bash2), seq D (hot read1 superseding seq B)
    const c1 = f.addAssistantToolCall([{ name: 'bash', args: { command: 'step1' } }]);
    const r1 = f.addToolResult(c1.callEvents[0], 'S1_'.repeat(1000)); // Pass B

    const c2 = f.addAssistantToolCall([{ name: 'read_file', args: { path: 'src/repeat.js' } }]);
    const r2 = f.addToolResult(c2.callEvents[0], 'R1_'.repeat(1000)); // Pass A

    const c3 = f.addAssistantToolCall([{ name: 'bash', args: { command: 'step2' } }]);
    const r3 = f.addToolResult(c3.callEvents[0], 'S2_'.repeat(1000)); // Pass B

    const c4 = f.addAssistantToolCall([{ name: 'read_file', args: { path: 'src/repeat.js' } }]);
    const r4 = f.addToolResult(c4.callEvents[0], 'R2_'.repeat(1000)); // hot-1 superseding r2

    // Each target has 1 sourceEventSeq -> targetRefs = 2. maxBatchRefs = 4 allows exactly 2 targets!
    const plan1 = planMicrocompact(f.session, f.measure(), {
      compactionId: 'mc-cap-1',
      keepRecentTools: 1,
      maxBatchRefs: 4,
    });
    assert.ok(plan1);
    assert.equal(plan1.batchRefs, 4);
    assert.equal(plan1.hasMore, true);
    assert.deepEqual(
      plan1.targets.map((t) => t.seq),
      [r1.seq, r2.seq],
      'must select combined Pass A + Pass B candidates in ascending seq order',
    );
    assert.equal(plan1.maskedToolCount, 1);
    assert.equal(plan1.repeatedReadCount, 1);

    const archive = new CompactionArchive({ root: join(root, 'archive') });
    const committed1 = await commitMicrocompact({ session: f.session, plan: plan1, archive });
    assert.ok(committed1);

    // Pass 2 picks up the remaining r3 target and sets hasMore: false
    const plan2 = planMicrocompact(f.session, f.measure(), {
      compactionId: 'mc-cap-2',
      keepRecentTools: 1,
      maxBatchRefs: 4,
    });
    assert.ok(plan2);
    assert.equal(plan2.hasMore, false);
    assert.deepEqual(
      plan2.targets.map((t) => t.seq),
      [r3.seq],
    );
    assert.equal(plan2.maskedToolCount, 1);
    assert.equal(plan2.repeatedReadCount, 0);
    assert.ok(f.surface.nodes.includes(r4.seq));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
console.log(JSON.stringify({ passed, failed, results }, null, 2));
if (failed > 0) process.exitCode = 1;
