import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { resolveConfig } from '../lib/config.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { CompactionArchive, spanEntries } from '../lib/history.js';
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

const HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeSummary(extra = 'Keep integer cents.') {
  return HEADINGS.map((h, idx) => `${h}\n${idx === 5 ? '[filled by engine]' : idx === 8 ? extra : 'Evidence archived; continuing task.'}`).join('\n\n');
}

function createFixture({ extraConfig = {}, headerTarget = { provider: 'p', model: 'm' }, summaryText = makeSummary() } = {}) {
  const root = join(process.env.WEAVE_TEST_ROOT, 'test-tmp', `phase1-${randomUUID()}`);
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const calls = [];
  const session = {
    id: `sess-${randomUUID()}`,
    surface,
    get seq() { return events.length; },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => events,
    requestHeader: () => ({ config: headerTarget }),
    toolHistory: () => [],
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (event.type === 'assistant/message') return event.data.message;
      if (event.type === 'tool/result') return { role: 'tool', toolCallId: event.data.message.toolCallId, content: event.data.message.content, ...(event.data.message.isError ? { isError: true } : {}) };
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
        assert.ok(start >= 0 && end >= start);
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
  const addReadPair = (filePath, body) => {
    const callId = `call-${randomUUID()}`;
    const callEvent = session.append('tool/call', { callId, name: 'read_file', arguments: JSON.stringify({ path: filePath, startLine: 1, endLine: 20 }) });
    const assistantCall = session.append('assistant/message', {
      message: { id: randomUUID(), role: 'assistant', content: [{ type: 'tool-call', callId, toolName: 'read_file', args: { path: filePath } }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, { surfaceOp: 'append' });
    const resultEvent = session.append('tool/result', {
      message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: body }], source: { kind: 'tool-result', callId } },
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
    logger: { info() {}, warn() {} },
    sessions: { async flush() {} },
    tokenMeter: { measure },
    llm: {
      async resolveModelInfo() { return { contextWindow: 200000 }; },
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
    summaryInputMaxBytes: 120000,
    windowFallback: 200000,
    maxTokens: 4096,
    ...extraConfig,
  }).config;

  const engine = new WeaveCompactionEngine(ctx, config);
  engine.historyToolsAvailable = true;
  const agent = { session, options: { provider: 'p', model: 'm' }, runMaintenance: (fn) => fn(new AbortController().signal) };

  return { root, events, surface, calls, session, engine, agent, addSystem, addUser, addAssistant, addReadPair };
}

await test('same-route-preserves-verbatim-prefix-for-full-and-incremental-compaction', async () => {
  const f = createFixture();
  try {
    f.addSystem('Stable system prompt.');
    f.addUser('Runtime context block '.repeat(20), 'runtime-context');
    f.addReadPair('src/invoice.js', 'export function invoiceTotal() { return 100; }\n'.repeat(20));
    f.addUser('Keep integer cents.');
    f.addAssistant('Initial diagnostic work. '.repeat(400));

    const surfaceBefore1 = [...f.surface.nodes];
    const span1End = surfaceBefore1.at(-1);
    const expectedPrefix1 = surfaceBefore1.slice(0, surfaceBefore1.indexOf(span1End) + 1)
      .map((seq) => JSON.stringify(f.session.deriveEventMessage(f.events[seq])));

    const first = await f.engine._compactRegionCore(f.surface.nodes[1], span1End, f.agent, new AbortController().signal, {
      manual: true,
      policy: f.engine.config,
    });
    assert.ok(first.compactionId);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(
      f.calls[0].messages.slice(0, expectedPrefix1.length).map((m) => JSON.stringify(m)),
      expectedPrefix1,
    );
    assert.ok(!JSON.stringify(f.calls[0].messages.slice(0, -1)).includes('External content omitted'));

    // Second generation: incremental compaction starting after the first checkpoint.
    f.addReadPair('src/pricing.js', 'export function price() { return 250; }\n'.repeat(20));
    const gen2Start = f.surface.nodes.at(-2);
    f.addAssistant('Second phase verification. '.repeat(400));
    const gen2End = f.surface.nodes.at(-1);

    const expectedPrefix2 = f.surface.nodes
      .slice(0, f.surface.nodes.indexOf(gen2End) + 1)
      .map((seq) => JSON.stringify(f.session.deriveEventMessage(f.events[seq])));

    const second = await f.engine._compactRegionCore(gen2Start, gen2End, f.agent, new AbortController().signal, {
      manual: true,
      policy: f.engine.config,
    });
    assert.ok(second.compactionId);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(
      f.calls[1].messages.slice(0, expectedPrefix2.length).map((m) => JSON.stringify(m)),
      expectedPrefix2,
    );
    const tailInstruction = f.calls[1].messages.at(-1).content[0].text;
    assert.match(tailInstruction, new RegExp(`Incremental span:.*1 non-system message.*seq ${gen2Start}\\.\\.${gen2End}`));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

await test('different-route-or-tight-budget-falls-back-to-projected-summary-input', async () => {
  const diffRoute = createFixture({
    extraConfig: { summarizationProvider: 'other', summarizationModel: 'small' },
  });
  try {
    diffRoute.addSystem('Stable system.');
    diffRoute.addUser('Runtime context block '.repeat(20), 'runtime-context');
    diffRoute.addReadPair('src/invoice.js', 'BODY '.repeat(100));
    diffRoute.addUser('Keep integer cents.');
    diffRoute.addAssistant('Diagnostic details. '.repeat(350));

    await diffRoute.engine._compactRegionCore(diffRoute.surface.nodes[1], diffRoute.surface.nodes.at(-1), diffRoute.agent, new AbortController().signal, {
      manual: true,
      policy: diffRoute.engine.config,
    });
    const sent = JSON.stringify(diffRoute.calls[0].messages.slice(0, -1));
    assert.match(sent, /External runtime-context reference/);
    assert.match(sent, /External content omitted from working memory/);
  } finally {
    await rm(diffRoute.root, { recursive: true, force: true });
  }

  // Same route, but unprojected read_file exceeds summaryInputMaxBytes while projected fits.
  const tightBudget = createFixture({
    extraConfig: { summaryInputMaxBytes: 12000 },
  });
  try {
    tightBudget.addSystem('Stable system.');
    tightBudget.addReadPair('src/big.js', 'LARGE_RAW_SOURCE '.repeat(900));
    tightBudget.addUser('Keep integer cents.');
    tightBudget.addAssistant('Diagnostic details. '.repeat(120));

    await tightBudget.engine._compactRegionCore(tightBudget.surface.nodes[1], tightBudget.surface.nodes.at(-1), tightBudget.agent, new AbortController().signal, {
      manual: true,
      policy: tightBudget.engine.config,
    });
    assert.equal(tightBudget.calls.length, 1);
    const sent = JSON.stringify(tightBudget.calls[0].messages.slice(0, -1));
    assert.match(sent, /External content omitted from working memory/);
  } finally {
    await rm(tightBudget.root, { recursive: true, force: true });
  }
});

await test('standard-checkpoint-exposes-archive-pointer-only-when-history-tools-active', async () => {
  const enabled = createFixture();
  try {
    enabled.addSystem('Stable system.');
    enabled.addReadPair('src/invoice.js', 'export const x = 1;\n'.repeat(20));
    enabled.addUser('Keep integer cents.');
    enabled.addAssistant('Work completed. '.repeat(350));

    const result = await enabled.engine._compactRegionCore(enabled.surface.nodes[1], enabled.surface.nodes.at(-1), enabled.agent, new AbortController().signal, {
      manual: true,
      policy: enabled.engine.config,
    });
    const cpText = blocksToText(enabled.session.deriveEventMessage(enabled.events[enabled.surface.nodes[1]]).content);
    assert.match(cpText, new RegExp(`History archive: ${result.compactionId} \\(seq ${result.shadowedSeqs[0]}-${result.shadowedSeqs.at(-1)}\\)`));
    assert.match(cpText, /history_search/);
    assert.match(cpText, /history_read/);
    assert.match(cpText, /Archived files: src\/invoice\.js\./);
  } finally {
    await rm(enabled.root, { recursive: true, force: true });
  }

  for (const mode of ['no-tools', 'no-archive']) {
    const f = createFixture({
      extraConfig: mode === 'no-archive' ? { archiveEnabled: false } : {},
    });
    if (mode === 'no-tools') f.engine.historyToolsAvailable = false;
    try {
      f.addSystem('Stable system.');
      f.addReadPair('src/invoice.js', 'export const x = 1;\n'.repeat(20));
      f.addUser('Keep integer cents.');
      f.addAssistant('Work completed. '.repeat(350));

      await f.engine._compactRegionCore(f.surface.nodes[1], f.surface.nodes.at(-1), f.agent, new AbortController().signal, {
        manual: true,
        policy: f.engine.config,
      });
      const cpText = blocksToText(f.session.deriveEventMessage(f.events[f.surface.nodes[1]]).content);
      assert.doesNotMatch(cpText, /History archive:/, mode);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

await test('single-pass-commit-validation-runs-audit-once-per-accepted-summary', async () => {
  const f = createFixture();
  try {
    f.addSystem('Stable system.');
    f.addUser('Keep integer cents.');
    f.addAssistant('Diagnostic work. '.repeat(350));

    let auditCount = 0;
    const origAudit = f.engine._audit.bind(f.engine);
    f.engine._audit = (...args) => {
      auditCount += 1;
      return origAudit(...args);
    };

    await f.engine._compactRegionCore(f.surface.nodes[1], f.surface.nodes.at(-1), f.agent, new AbortController().signal, {
      manual: true,
      policy: f.engine.config,
    });
    assert.equal(auditCount, 1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

await test('history-search-uses-stat-for-blobs-and-supports-multihit-and-multiterm', async () => {
  const root = await mkdtemp(join(process.env.WEAVE_TEST_ROOT, 'test-tmp', 'phase1-hist-'));
  try {
    const bytes = Buffer.from('binary payload '.repeat(30));
    const digest = createHash('sha256').update(bytes).digest('hex');
    const ref = { attachmentId: `sha256:${digest}`, bytes: bytes.length };
    const pad = ' filler'.repeat(50);
    const events = [
      {
        seq: 1,
        type: 'assistant/message',
        data: {
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: `first exactMarkerNeedle here${pad} second exactMarkerNeedle there` },
              { type: 'file', attachment: ref },
            ],
            source: { kind: 'model' },
          },
        },
      },
      {
        seq: 2,
        type: 'assistant/message',
        data: {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'The invoice calculation had a subtle rounding boundary error in cents.' }],
            source: { kind: 'model' },
          },
        },
      },
    ];
    const source = {
      id: 'hist-phase1',
      eventAt: (seq) => events.find((e) => e.seq === seq),
      deriveEventMessage: (e) => e.data.message,
    };

    const archive = new CompactionArchive({ root });
    archive.attachments = { async *readFileStream() { yield bytes; } };
    const entries = spanEntries(source, [1, 2]);
    assert.ok(await archive.writeSpan({ sessionId: source.id, compactionId: 'span-1', entries }));
    archive.attachments = undefined;

    const multiHit = await archive.search(source.id, 'exactMarkerNeedle');
    assert.equal(multiHit.unreadable.length, 0);
    assert.equal(multiHit.hits.length, 2);
    assert.ok(multiHit.hits[0].excerpt.includes('first exactMarkerNeedle'));
    assert.ok(multiHit.hits[1].excerpt.includes('second exactMarkerNeedle'));

    const multiTerm = await archive.search(source.id, 'invoice rounding error');
    assert.equal(multiTerm.unreadable.length, 0);
    assert.equal(multiTerm.hits.length, 1);
    assert.equal(multiTerm.hits[0].seq, 2);

    // Same-size 1-bit flip inside blob: search() only stats blob size, while readSpan() verifies SHA-256.
    const blobPath = join(archive.dirFor(source.id), 'attachments', `${digest}.blob`);
    const corrupted = Buffer.from(await readFile(blobPath));
    corrupted[0] ^= 1;
    await writeFile(blobPath, corrupted);

    const searchOnBitFlip = await archive.search(source.id, 'exactMarkerNeedle');
    assert.equal(searchOnBitFlip.unreadable.length, 0);
    assert.equal((await archive.readSpan(source.id, 'span-1')).reason, 'attachment');

    // Truncated blob: search() stat check detects size mismatch and reports unreadable attachment.
    await writeFile(blobPath, corrupted.subarray(0, 10));
    const searchOnTruncated = await archive.search(source.id, 'exactMarkerNeedle');
    assert.deepEqual(searchOnTruncated.unreadable, [{ compactionId: 'span-1', reason: 'attachment' }]);
    assert.equal(searchOnTruncated.hits[0].incomplete, 'attachment');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log(JSON.stringify({ passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, results }, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
