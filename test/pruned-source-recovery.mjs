import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { CompactionArchive, HISTORY_SNAPSHOT_WARNING, spanEntries } from '../lib/history.js';
import { historySourceSeqs } from '../lib/history-source.js';
import { __test as tools } from '../lib/tools.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { resolveConfig } from '../lib/config.js';
import { approxTokens, blocksToText } from '../lib/meter.js';

const results = [];
const text = value => [{ type: 'text', text: value }];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const event = (seq, type, data, extra = {}) => ({ seq, type, data, ...extra });
const options = process.argv.slice(2);
const hostOption = options.indexOf('--host-modules');
const hostModules = hostOption >= 0 ? options[hostOption + 1] : process.env.DSH_TEST_NODE_MODULES;
const auditOption = options.indexOf('--pruner-source');
const auditSource = auditOption >= 0 ? options[auditOption + 1] : process.env.WEAVE_TEST_PRUNER_SOURCE;

function session(events) {
  return {
    id: 'pruned-source-recovery',
    eventAt: seq => events[seq],
    // Deliberately projects replacement output. spanEntries must use the
    // immutable tool/result message instead when it follows a source pointer.
    deriveEventMessage: current => current?.data?.projected ?? current?.data?.message ?? current?.data,
  };
}

async function test(name, run) {
  try {
    const detail = await run();
    results.push({ name, pass: true, ...(detail === undefined ? {} : { detail }) });
  } catch (error) {
    results.push({ name, pass: false, error: error.stack ?? String(error) });
  }
}

// Existing public tool contract: each raw response is an independent JSON
// envelope; only the concatenated jsonChunk string is the archived record.
async function readRecord(archive, id, compactionId, seq, charLimit = 7777) {
  let offset = 0, joined = '', pages = 0;
  do {
    const result = await tools.runTool('history_read', archive, { compactionId, seq, raw: true, charOffset: offset, charLimit }, { session: { id } });
    const page = JSON.parse(result);
    assert.equal(page.verified, true);
    assert.equal(page.charOffset, offset);
    assert.ok(page.jsonChunk.length <= charLimit);
    assert.equal(page.currentFileVersion, 'not-checked');
    assert.equal(page.snapshotWarning, HISTORY_SNAPSHOT_WARNING);
    joined += page.jsonChunk;
    offset = page.nextCharOffset;
    assert.ok(++pages < 1000);
  } while (offset !== null);
  return { entry: JSON.parse(joined), pages };
}

if (process.argv[2] === '--cold') {
  const saved = JSON.parse(await readFile(process.argv[3], 'utf8'));
  const archive = new CompactionArchive({ root: saved.root });
  const restored = await readRecord(archive, saved.sessionId, saved.compactionId, saved.seq);
  assert.equal(sha256(JSON.stringify(restored.entry)), saved.entrySha256);
  assert.match(restored.entry.text, /MIDDLE_EXACT_FAILURE_SENTINEL/);
  console.log(JSON.stringify({ pid: process.pid, pages: restored.pages, entrySha256: sha256(JSON.stringify(restored.entry)) }));
  process.exit(0);
}

function syntheticSession() {
  const events = [], surface = { nodes: [], replaceGeneration: 0 };
  return {
    id: randomUUID(), surface, get seq() { return events.length; },
    eventAt: seq => events[seq], snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'offline', model: 'fixed-response' } }),
    deriveEventMessage: current => current?.data?.message ?? current?.data,
    append(type, data, options = {}) {
      const current = { seq: events.length, type, data: structuredClone(data), ...structuredClone(options) };
      events.push(current);
      if (options.surfaceOp === 'append') surface.nodes.push(current.seq);
      else if (options.surfaceOp?.op === 'replace') {
        const start = surface.nodes.indexOf(options.surfaceOp.startSeq), end = surface.nodes.indexOf(options.surfaceOp.endSeq);
        assert.ok(start >= 0 && end >= start);
        surface.nodes.splice(start, end - start + 1, current.seq);
        surface.replaceGeneration++;
      }
      return current;
    },
  };
}

async function hostPruner() {
  // Pin the audit's extracted rc.3 source. Only Service/schema/JSON ownership
  // boundaries are stubbed; no running desktop or installed plugin is changed.
  const source = await readFile(auditSource, 'utf8');
  assert.equal(sha256(source), 'e86442e9a2403c392482b9035916e5610c251d62f3581892866404d69c064254');
  const executable = source.replace(/^import .*;\r?\n/gm, '').replace(/^export \{[^\n]+\};?\s*$/m, '');
  const schema = { step() { return this; }, min() { return this; }, default() { return this; } };
  return vm.runInNewContext(executable + '\n({ToolResultPruner,DEFAULTS});', {
    Service: class { constructor(ctx) { this.ctx = ctx; } }, z: { object: () => ({}), number: () => schema },
    deepFreeze: value => value, freezeMessage: value => structuredClone(value), structuredClone,
  });
}

async function engineRecovery({ continuation, Session }) {
  const root = await mkdtemp(join(tmpdir(), 'weave-pruned-engine-'));
  let engine;
  try {
    const active = Session ? Session.create('pruned-' + randomUUID()) : syntheticSession();
    const add = (role, value) => active.append(role + '/message', role === 'user'
      ? { id: randomUUID(), role, source: { kind: 'user' }, content: text(value) }
      : { turn: 1, step: 1, ...(role === 'assistant' ? { stream: [], usage: { inputTokens: 0, outputTokens: 0 } } : {}), message: { id: randomUUID(), role, source: role === 'system' ? { kind: 'system-prompt' } : { kind: 'model', provider: 'offline', model: 'fixed-response' }, content: text(value) } }, { surfaceOp: 'append' });
    active.append('turn/start', { turn: 1 });
    active.append('step/start', { turn: 1, step: 1 });
    add('system', 'Stable system context.');
    add('user', 'Review the archived diagnostics.');
    const requests = [
      { type: 'tool-call', id: 'A', name: 'read_file', arguments: JSON.stringify({ path: 'src/worker.js' }) },
      { type: 'tool-call', id: 'B', name: 'test_command', arguments: '{}' },
    ];
    active.append('assistant/message', { turn: 1, step: 1, stream: [], usage: { inputTokens: 0, outputTokens: 0 }, message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'offline', model: 'fixed-response' }, content: requests } }, { surfaceOp: 'append' });
    const calls = requests.map(block => active.append('tool/call', { turn: 1, step: 1, callId: block.id, name: block.name, arguments: block.arguments }));
    const bodies = {
      A: 'const prefix="' + 'a'.repeat(6000) + '";\r\nfunction ACTIVE_SIGNATURE(payload, options) { return options.normalize(payload); }\r\nconst suffix="' + 'b'.repeat(6000) + '";😀',
      B: JSON.stringify({ head: 'a'.repeat(6000), critical: 'MIDDLE_EXACT_FAILURE_SENTINEL', tail: 'b'.repeat(6000) }),
    };
    const originals = ['B', 'A'].map(id => active.append('tool/result', { turn: 1, step: 1,
      message: { id: randomUUID(), role: 'tool', toolCallId: id, source: { kind: 'tool', callId: id }, isError: id === 'B', content: text(bodies[id]) },
      ...(id === 'B' ? { error: { name: 'DiagnosticError', code: 'FIXTURE_ERROR' } } : {}),
    }, { surfaceOp: 'append', sourceEventSeqs: [calls.find(call => call.data.callId === id).seq] }));
    const headings = ['Primary Request and Intent', 'Key Technical Concepts', 'Files and Code Sections', 'Errors and Fixes', 'Problem Solving', 'All User Messages', 'Pending Tasks', 'Work Completed', 'Context for Continuing Work'];
    const summary = continuation
      ? '## Goal\nReview the archived diagnostics.\n## State\nHistorical output is retained in the archive.\n## Next\nReview the source evidence.\n## Uncertain\nNo independent verification.'
      : headings.map((heading, i) => `## ${i + 1}. ${heading}\n${i === 0 ? 'Review the archived diagnostics.' : i === 5 ? '[filled by engine]' : '(none)'}`).join('\n\n');
    const modelCalls = [];
    const ctx = { on() {}, provide() {}, logger: { info() {}, warn() {} }, sessions: { async flush() {} },
      tokenMeter: { measure(s) { const nodes = s.surface.nodes.map(seq => ({ seq, tokens: approxTokens(blocksToText(s.deriveEventMessage(s.eventAt(seq))?.content)) })); return { nodes, totalTokens: nodes.reduce((total, node) => total + node.tokens, 0) }; } },
      llm: { async resolveModelInfo() { return { contextWindow: 1000000 }; }, async *stream(options) { modelCalls.push(options); yield { type: 'text-delta', text: summary }; yield { type: 'finish', kind: 'stop' }; } },
    };
    const { ToolResultPruner } = await hostPruner();
    const pruner = new ToolResultPruner({ tokenMeter: { estimateMessage: value => approxTokens(blocksToText(value.content)) } });
    ctx.get = name => name === 'toolResultPruner' ? pruner : undefined;
    engine = new WeaveCompactionEngine(ctx, resolveConfig({ archiveDir: join(root, 'archive'), language: 'en', summaryRetryCount: 0, summaryRetryDelayMs: 0 }).config);
    engine.historyToolsAvailable = true;
    await engine._pruneToolResults(active);
    const pruned = active.surface.nodes.map(seq => active.eventAt(seq)).filter(current => current.type === 'tool/result');
    assert.deepEqual(pruned.map(current => current.data.message.toolCallId), ['B', 'A']);
    assert.ok(pruned.every(current => blocksToText(current.data.message.content).includes('[... tool result middle pruned ...]')));
    assert.ok(pruned.every(current => !/MIDDLE_EXACT_FAILURE_SENTINEL|ACTIVE_SIGNATURE/.test(blocksToText(current.data.message.content))));
    assert.equal(pruned[0].data.message.isError, true);
    add('assistant', 'Historical diagnostic detail. '.repeat(5000));
    active.append('step/end', { turn: 1, step: 1 });
    active.append('turn/end', { turn: 1 });
    const originalSnapshot = structuredClone(active.snapshotEvents());
    const selected = [...active.surface.nodes].slice(1);
    const agent = { session: active, options: { provider: 'offline', model: 'fixed-response' } };
    const compacted = await engine._compactRegionCore(selected[0], selected.at(-1), agent, new AbortController().signal, {
      manual: true, policy: engine.config, ...(continuation ? { continuation: true, continuationBudgetTokens: 14000 } : {}),
    });
    assert.ok(compacted?.compactionId);
    assert.deepEqual(active.snapshotEvents().slice(0, originalSnapshot.length), originalSnapshot);
    const archive = new CompactionArchive({ root: engine.archive.root });
    const span = await archive.readSpan(active.id, compacted.compactionId);
    assert.equal(span.ok, true);
    assert.deepEqual(span.entries.slice(0, selected.length).map(entry => entry.seq), selected);
    assert.equal(new Set(span.entries.map(entry => entry.seq)).size, span.entries.length);
    for (const current of originals) {
      const restored = await readRecord(archive, active.id, compacted.compactionId, current.seq);
      assert.deepEqual(restored.entry.event, current);
      assert.equal(restored.entry.text, bodies[current.data.message.toolCallId]);
      assert.equal(restored.entry.snapshot.scope, 'tool-source');
      assert.ok(restored.pages > 1);
    }
    const search = await tools.runTool('history_search', archive, { query: 'MIDDLE_EXACT_FAILURE_SENTINEL' }, { session: { id: active.id } });
    assert.match(search, new RegExp('seq=' + originals[0].seq));
    assert.equal(modelCalls.length, 1);
    const summaryEvent = active.snapshotEvents().findLast(current => current.type === 'compaction/summary');
    assert.deepEqual(summaryEvent.data.shadowedSeqs, selected);
    assert.ok(!summaryEvent.data.shadowedSeqs.includes(originals[0].seq));
    return { hostVersion: '0.2.2-rc.3', nativeSession: Boolean(Session), continuation, modelCalls: modelCalls.length, selectedSeqs: selected, archivedSeqs: span.entries.map(entry => entry.seq), originals: originals.map(current => current.seq), originalEventsUnchanged: true, exactMiddleRecovered: true };
  } finally {
    engine?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

await test('source-closure-keeps-selected-prefix-and-appends-original-result', async () => {
  const original = 'head\nMIDDLE_EXACT_FAILURE_SENTINEL\nACTIVE_SIGNATURE(payload)\ntail';
  const events = [
    event(0, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call', callId: 'A', name: 'read_file', arguments: { path: 'src/worker.js' } }] } }),
    event(1, 'tool/call', { callId: 'A', name: 'read_file', arguments: { path: 'src/worker.js' } }),
    event(2, 'tool/result', {
      message: { role: 'tool', toolCallId: 'A', source: { kind: 'tool-result', callId: 'A' }, isError: true, content: text(original) },
      projected: { role: 'tool', toolCallId: 'A', source: { kind: 'tool-result', callId: 'A' }, isError: true, content: text('head\n[... tool result middle pruned ...]\ntail') },
    }, { sourceEventSeqs: [1] }),
    event(3, 'assistant/message', { message: { role: 'assistant', content: text('replacement summary') } }),
  ];
  const source = session(events);
  assert.deepEqual(historySourceSeqs(source, [3, 2]), { selected: [3, 2], sources: [1] });
  const entries = spanEntries(source, [3, 2]);
  assert.deepEqual(entries.map(entry => entry.seq), [3, 2, 1]);
  assert.equal(entries[1].text, original);
  assert.equal(entries[1].event.data.message.isError, true);
  assert.equal(entries[1].event.data.message.toolCallId, 'A');
  assert.equal(entries[2].type, 'tool/call');
  assert.equal(entries[2].tool[0].callId, 'A');
  assert.equal(entries[2].tool[0].name, 'read_file');
  assert.equal(entries[1].snapshot.scope, 'selected');
  assert.equal(entries[2].snapshot.scope, 'tool-source');
  return { selectedSeqs: [3, 2], archivedSeqs: entries.map(entry => entry.seq), exactMiddleRestored: true };
});

await test('archive-search-and-exact-history-read-find-source-after-cold-reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-pruned-source-'));
  try {
    const original = JSON.stringify({ head: 'a'.repeat(7000), middle: 'MIDDLE_EXACT_FAILURE_SENTINEL', tail: 'b'.repeat(7000) });
    const events = [
      event(0, 'tool/call', { callId: 'B', name: 'read_file', arguments: { path: 'src/data.json' } }),
      event(1, 'tool/result', { message: { role: 'tool', toolCallId: 'B', source: { kind: 'tool-result', callId: 'B' }, isError: true, content: text(original) } }),
      event(2, 'tool/result', { message: { role: 'tool', toolCallId: 'B', source: { kind: 'tool-result', callId: 'B' }, isError: true, content: text('[... tool result middle pruned ...]') } }, { sourceEventSeqs: [1] }),
    ];
    const source = session(events);
    const archive = new CompactionArchive({ root });
    const entries = spanEntries(source, [2]);
    assert.deepEqual(entries.map(entry => entry.seq), [2, 1]);
    assert.ok(await archive.writeSpan({ sessionId: source.id, compactionId: 'pruned', entries }));

    const reopened = new CompactionArchive({ root });
    const search = await reopened.search(source.id, 'MIDDLE_EXACT_FAILURE_SENTINEL');
    assert.equal(search.unreadable.length, 0);
    assert.deepEqual(search.hits.map(hit => hit.seq), [1]);
    const raw = await readRecord(reopened, source.id, 'pruned', 1);
    assert.equal(raw.entry.snapshot.scope, 'tool-source');
    assert.equal(raw.entry.event.data.message.isError, true);
    assert.equal(raw.entry.event.data.message.toolCallId, 'B');
    assert.equal(raw.entry.text, original);
    assert.deepEqual(JSON.parse(raw.entry.text), JSON.parse(original));
    assert.ok(raw.pages > 1);
    const input = join(root, 'cold-input.json');
    await writeFile(input, JSON.stringify({ root, sessionId: source.id, compactionId: 'pruned', seq: 1, entrySha256: sha256(JSON.stringify(raw.entry)) }));
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--cold', input], { windowsHide: true, encoding: 'utf8', timeout: 25000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const cold = JSON.parse(child.stdout);
    assert.notEqual(cold.pid, process.pid);
    assert.match(await tools.runTool('history_read', reopened, { compactionId: 'pruned', seq: 1 }, { session: { id: source.id } }), /historical session snapshot/i);
    return { searchHits: search.hits, rawExact: raw.entry.text === original, pages: raw.pages, cold, sourceWarning: HISTORY_SNAPSHOT_WARNING };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('source-closure-preserves-attachment-and-owner-check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-pruned-attachment-'));
  try {
    const bytes = Buffer.from('source attachment exact 😀');
    const ref = { attachmentId: `sha256:${sha256(bytes)}`, bytes: bytes.length };
    const events = [
      event(0, 'tool/call', { callId: 'C', name: 'read_file', arguments: { path: 'src/a.bin' } }),
      event(1, 'tool/result', { message: { role: 'tool', toolCallId: 'C', source: { kind: 'tool-result', callId: 'C' }, content: [{ type: 'text', text: 'original binary result' }, { type: 'file', attachment: ref }] } }),
      event(2, 'tool/result', { message: { role: 'tool', toolCallId: 'C', source: { kind: 'tool-result', callId: 'C' }, content: text('[... tool result middle pruned ...]') } }, { sourceEventSeqs: [1] }),
    ];
    const source = session(events);
    const archive = new CompactionArchive({ root });
    archive.attachments = { async *readFileStream() { yield bytes; } };
    const entries = spanEntries(source, [2]);
    assert.ok(await archive.writeSpan({ sessionId: source.id, compactionId: 'with-file', entries }));
    archive.attachments = undefined;
    const page = await archive.readAttachment(source.id, 'with-file', ref.attachmentId, 0, 7);
    const chunks = [Buffer.from(page.base64, 'base64')];
    let offset = page.nextByteOffset;
    while (offset !== null) {
      const next = await archive.readAttachment(source.id, 'with-file', ref.attachmentId, offset, 7);
      chunks.push(Buffer.from(next.base64, 'base64'));
      offset = next.nextByteOffset;
    }
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.ok(await archive.writeSpan({ sessionId: source.id, compactionId: 'other-span', entries: [] }));
    await assert.rejects(archive.readAttachment(source.id, 'other-span', ref.attachmentId), /does not belong/);
    await assert.rejects(archive.readAttachment('foreign-session', 'with-file', ref.attachmentId), /owner archive/);
    const corrupt = Buffer.from(bytes);
    corrupt[0] ^= 1;
    await writeFile(join(archive.dirFor(source.id), 'attachments', sha256(bytes) + '.blob'), corrupt);
    assert.equal((await archive.readSpan(source.id, 'with-file')).reason, 'attachment');
    await assert.rejects(archive.readAttachment(source.id, 'with-file', ref.attachmentId), /owner archive/);
    return { bytes: bytes.length, attachmentRoundTrip: true, crossSpanRefused: true, crossSessionRefused: true, sameSizeCorruptionRefused: true };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('malformed-or-cross-call-source-is-rejected-before-archive-write', async () => {
  const base = event(0, 'tool/call', { callId: 'A', name: 'read_file', arguments: {} });
  const wrong = event(1, 'tool/result', { message: { role: 'tool', toolCallId: 'B', source: { kind: 'tool-result', callId: 'B' }, content: text('wrong') } }, { sourceEventSeqs: [0] });
  assert.throws(() => spanEntries(session([base, wrong]), [1]), /different tool call/);
  const duplicate = event(1, 'tool/result', { message: { role: 'tool', toolCallId: 'A', source: { kind: 'tool-result', callId: 'A' }, content: text('bad') } }, { sourceEventSeqs: [0, 0] });
  assert.throws(() => spanEntries(session([base, duplicate]), [1]), /unique earlier/);
  const forward = event(0, 'tool/result', { message: { role: 'tool', toolCallId: 'A', source: { kind: 'tool-result', callId: 'A' }, content: text('bad') } }, { sourceEventSeqs: [1] });
  assert.throws(() => spanEntries(session([forward, base]), [0]), /earlier/);
  return { crossCallRefused: true, duplicateRefused: true, forwardRefused: true };
});

await test('ordinary_selected_span_without_source_pointer_is_unchanged', async () => {
  const events = [event(0, 'user/message', { role: 'user', source: { kind: 'user' }, content: text('keep exact') })];
  const entries = spanEntries(session(events), [0]);
  assert.deepEqual(entries.map(entry => entry.seq), [0]);
  assert.equal(entries[0].text, 'keep exact');
  assert.equal(entries[0].snapshot.scope, 'selected');
  return { selectedOnly: true };
});

await test('multiple-replacement-generations-and-overlapping-roots-deduplicate-exact-sources', () => {
  const events = [event(0, 'tool/call', { callId: 'A', name: 'read_file', arguments: {} })];
  for (let seq = 1; seq <= 4; seq++) events.push(event(seq, 'tool/result', { message: { role: 'tool', toolCallId: 'A', content: text('generation ' + seq) } }, { sourceEventSeqs: [seq - 1] }));
  const source = session(events);
  const entries = spanEntries(source, [3, 4]);
  assert.deepEqual(entries.map(entry => entry.seq), [3, 4, 0, 1, 2]);
  for (const entry of entries) assert.deepEqual(entry.event, events[entry.seq]);
  return { archivedSeqs: entries.map(entry => entry.seq), noDuplicateSeq: true };
});

await test('source-chain-budget-cannot-be-bypassed-by-overlapping-selected-roots', () => {
  const events = [event(0, 'tool/call', { callId: 'A', name: 'read_file', arguments: {} })];
  for (let seq = 1; seq <= 65; seq++) events.push(event(seq, 'tool/result', { message: { role: 'tool', toolCallId: 'A', content: text('generation') } }, { sourceEventSeqs: [seq - 1] }));
  assert.throws(() => spanEntries(session(events), [64, 65]), /chain exceeds 64/);
  assert.throws(() => spanEntries(session(events), [65, 64]), /chain exceeds 64/);
  const oversized = event(5000, 'tool/result', { message: { role: 'tool', toolCallId: 'A', content: text('oversized') } }, { sourceEventSeqs: Array.from({ length: 4097 }, (_, i) => i) });
  let reads = 0;
  assert.throws(() => spanEntries({ eventAt(seq) { reads++; return seq === 5000 ? oversized : undefined; } }, [5000]), /over-budget/);
  assert.equal(reads, 1, 'An over-budget source list must be rejected before enumerating its targets.');
  return { depthLimit: 64, inspectedSourceLimit: 4096, selectedOrderCannotBypass: true };
});

await test('missing-source-and-invalid-identities-fail-explicitly', () => {
  const missing = event(3, 'tool/result', { message: { role: 'tool', toolCallId: 'A', content: text('missing') } }, { sourceEventSeqs: [1] });
  assert.throws(() => spanEntries({ eventAt: seq => seq === 3 ? missing : undefined }, [3]), /source event 1 is missing/);
  assert.throws(() => spanEntries({ eventAt: () => event(99, 'tool/call', {}) }, [1]), /mismatched sequence/);
  assert.throws(() => spanEntries(session([]), [-0]), /unique non-negative/);
  const conflict = event(2, 'tool/result', { message: { role: 'tool', toolCallId: 'A', source: { callId: 'B' }, content: text('conflict') } }, { sourceEventSeqs: [1] });
  assert.throws(() => spanEntries({ eventAt: () => conflict }, [2]), /conflicting call IDs/);
  return { missingRefused: true, identityRefused: true, negativeZeroRefused: true, conflictingIdsRefused: true };
});

await test('checkpoint-provenance-does-not-widen-the-tool-source-archive', () => {
  const checkpoint = event(100, 'user/message', { role: 'user', source: { kind: 'compact-checkpoint' }, content: text('historical notes') }, { sourceEventSeqs: [0, 90] });
  const reads = [];
  const entries = spanEntries({ eventAt(seq) { reads.push(seq); if (seq === 100) return checkpoint; throw new Error('Archive scope widened'); }, deriveEventMessage: current => current.data }, [100]);
  assert.deepEqual(entries.map(entry => entry.seq), [100]);
  assert.ok(reads.every(seq => seq === 100));
  return { checkpointSourceNotTraversed: true };
});

await test('page-budgets-cold-source-ownership-and-corrupt-search-remain-explicit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-pruned-budget-'));
  try {
    const archive = new CompactionArchive({ root });
    const id = 'budget-source', compactionId = 'large-source';
    const original = event(0, 'tool/result', { message: { role: 'tool', toolCallId: 'A', content: text('MIDDLE_EXACT_FAILURE_SENTINEL\r\n' + '😀\r\n'.repeat(60000)) } });
    const replaced = event(1, 'tool/result', { message: { role: 'tool', toolCallId: 'A', content: text('pruned replacement') } }, { sourceEventSeqs: [0] });
    const file = await archive.writeSpan({ sessionId: id, compactionId, entries: spanEntries(session([original, replaced]), [1]) });
    assert.ok(file);
    const exec = { session: { id } };
    const args = { compactionId, seq: 0, raw: true, charLimit: 999999 };
    const first = await tools.runTool('history_read', archive, args, exec);
    const repeated = await tools.runTool('history_read', archive, args, exec);
    assert.equal(first, repeated);
    assert.equal(JSON.parse(first).jsonChunk.length, 60000);
    const page = await tools.runTool('history_read', archive, { compactionId, raw: true }, exec);
    assert.ok(page.length < 125000);
    assert.match(page, /exceeds the page budget/);
    assert.match(page, /seq=0 raw=true charOffset=0/);
    assert.match(await tools.runTool('history_read', archive, { compactionId, seq: -1 }, exec), /non-negative safe integer/);
    assert.equal((await archive.readSpan('foreign-session', compactionId)).reason, 'missing');
    assert.equal((await archive.search('foreign-session', 'MIDDLE_EXACT_FAILURE_SENTINEL')).hits.length, 0);
    await rm(file);
    const failedSearch = await tools.runTool('history_search', archive, { query: 'MIDDLE_EXACT_FAILURE_SENTINEL' }, exec);
    assert.match(failedSearch, /unreadable|could not be read/i);
    assert.doesNotMatch(failedSearch, /No archived span contains/);
    assert.match(await tools.runTool('history_read', archive, { compactionId, seq: 0 }, exec), /does not exist/i);
    return { perChunkLimit: 60000, wholePageBudgetHeld: true, identicalRepeats: true, foreignSessionAbsent: true, missingIndexEntryNotAbsence: true, cumulativeBudget: 'existing per-call behavior unchanged' };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The unit run stays portable. The targeted host run opts into the already
// provided rc.3 modules, rather than installing dependencies.
if (auditSource) for (const continuation of [false, true]) {
  await test(`rc3-original-pruner-and-production-engine-${continuation ? 'continuation' : 'ordinary'}`, () => engineRecovery({ continuation }));
}
if (hostModules && auditSource) {
  const { Session } = await import(pathToFileURL(join(hostModules, '@deepseek-ai/dsh-session/lib/index.js')));
  for (const continuation of [false, true]) {
    await test(`rc3-native-session-pruner-and-production-engine-${continuation ? 'continuation' : 'ordinary'}`, () => engineRecovery({ continuation, Session }));
  }
}

console.log(JSON.stringify({
  passed: results.filter(result => result.pass).length,
  failed: results.filter(result => !result.pass).length,
  results,
}, null, 2));
if (results.some(result => !result.pass)) process.exitCode = 1;
