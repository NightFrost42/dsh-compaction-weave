import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

import { auditCompaction, auditInstructionProvenance } from '../lib/audit.js';
import { decorateCompactCommand } from '../lib/command-compact.js';
import { resolveConfig } from '../lib/config.js';
import { renderContinuation } from '../lib/continuation.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import {
  CompactionArchive,
  HISTORY_SNAPSHOT_WARNING,
  HISTORY_TOOLS,
  MAX_SPAN_UNCOMPRESSED_BYTES,
  spanEntries,
} from '../lib/history.js';
import { POST_COMPACT_EVENT, PRE_COMPACT_EVENT } from '../lib/hooks.js';
import {
  estimateContentTokens,
  estimateHostHeuristicMessage,
  estimateMessageTokens,
} from '../lib/meter.js';
import { commitObservationMask } from '../lib/observation-mask.js';
import {
  buildCompactionInstruction,
  detectLanguage,
  extractLanguageSample,
} from '../lib/prompt.js';
import { projectSummaryMessage } from '../lib/reference-input.js';
import { collectChildArchiveIds, renderArchivePointer } from '../lib/region.js';
import { SessionStateStore } from '../lib/state.js';
import { sessionDirectory } from '../lib/storage-path.js';
import { buildSummaryRequest } from '../lib/summary-budget.js';
import { resolveReasoningEffort, summarizeWithChain } from '../lib/summary.js';
import { registerHistoryTools } from '../lib/tools.js';

const results = [];
async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, pass: true, ms: Date.now() - started });
  } catch (error) {
    results.push({
      name,
      pass: false,
      ms: Date.now() - started,
      error: error?.message ?? String(error),
      stack: error?.stack,
    });
  }
}

const TEST_BASE = process.env.WEAVE_TEST_ROOT ?? tmpdir();
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const ZH_HEADINGS = buildCompactionInstruction('zh')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));
const EN_HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeSummary(sections = {}, language = 'en') {
  const headings = language === 'zh' ? ZH_HEADINGS : EN_HEADINGS;
  const fallback =
    language === 'zh'
      ? '已完成历史归档整理，按约束继续。'
      : 'Historical span archived cleanly; continue below.';
  const placeholder = language === 'zh' ? '[由引擎填充]' : '[filled by engine]';
  return headings
    .map((h, idx) => {
      if (idx === 5) return `${h}\n${sections[6] ?? placeholder}`;
      const body = sections[idx + 1] ?? (idx === 8 ? sections.body : undefined) ?? fallback;
      return `${h}\n${body}`;
    })
    .join('\n\n');
}

function createSynthSession(sessionId = `w2-${randomUUID().slice(0, 8)}`) {
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const session = {
    id: sessionId,
    header: { version: 4, id: sessionId, createdAt: Date.now(), isSeeded: false },
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => [...events],
    requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: 4096 }, tools: [] }),
    toolHistory: () => [],
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (event.type === 'system/message') return event.data?.message ?? event.data;
      if (event.type === 'user/message') return event.data;
      if (event.type === 'assistant/message') return event.data?.message;
      if (event.type === 'tool/result') {
        const msg = event.data?.message ?? event.data;
        return {
          role: 'tool',
          toolCallId: msg.toolCallId ?? msg.source?.callId,
          content: msg.content,
          ...(msg.isError ? { isError: true } : {}),
        };
      }
      return undefined;
    },
    append(type, data, options = {}) {
      const event = {
        seq: events.length,
        time: Date.now() + events.length,
        type,
        data,
        ...(options.surfaceOp !== undefined ? { surfaceOp: options.surfaceOp } : {}),
        ...(Array.isArray(options.sourceEventSeqs) ? { sourceEventSeqs: [...options.sourceEventSeqs] } : {}),
      };
      events.push(event);
      if (options.surfaceOp?.op === 'replace') {
        const s = surface.nodes.indexOf(options.surfaceOp.startSeq);
        const e = surface.nodes.indexOf(options.surfaceOp.endSeq);
        assert.ok(s >= 0 && e >= s, `invalid replace range ${options.surfaceOp.startSeq}..${options.surfaceOp.endSeq}`);
        surface.nodes.splice(s, e - s + 1, event.seq);
        surface.replaceGeneration += 1;
      } else if (options.surfaceOp === 'append') {
        surface.nodes.push(event.seq);
      }
      return event;
    },
  };

  const addUser = (text, sourceKind = 'user') =>
    session.append(
      'user/message',
      { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: sourceKind } },
      { surfaceOp: 'append' },
    );
  const addAssistant = (text) =>
    session.append(
      'assistant/message',
      { message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } } },
      { surfaceOp: 'append' },
    );
  const addToolPair = (toolName, args, outputText) => {
    const callId = `call_${randomUUID().slice(0, 8)}`;
    const callEv = session.append(
      'assistant/message',
      {
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'tool-call', callId, name: toolName, toolName, arguments: JSON.stringify(args), args }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
      { surfaceOp: 'append' },
    );
    const resEv = session.append(
      'tool/result',
      {
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: callId,
          source: { callId, toolName },
          content: [{ type: 'text', text: outputText }],
        },
      },
      { surfaceOp: 'append' },
    );
    return { callEv, resEv };
  };
  return { session, events, surface, addUser, addAssistant, addToolPair };
}

function registerToolsMap(archive, sessionId) {
  const registered = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(def) {
        registered.set(def.name, def);
      },
    },
  };
  const ok = registerHistoryTools(ctx, { archiveEnabled: true, archiveDir: archive.root }, archive);
  assert.equal(ok, true, 'all history tools should register');
  const callTool = async (name, args = {}) => {
    const def = registered.get(name);
    assert.ok(def, `missing tool ${name}`);
    return def.execute(args, { session: { id: sessionId } });
  };
  return { registered, callTool };
}

// 1. Ghost index cleanup
await test('1-ghost-index-cleanup-deleteSpan-and-mask-rollback-prevent-unreadable-search', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-w2-ghost-'));
  try {
    const archive = new CompactionArchive({ root });
    const { session, addUser, addToolPair } = createSynthSession('ghost-sess-1');
    addUser('Investigate auth latency and keep src/server.js clean.');
    const { resEv: r1 } = addToolPair('read_file', { path: 'src/server.js' }, 'A'.repeat(2000));
    const { resEv: r2 } = addToolPair('read_file', { path: 'src/db.js' }, 'B'.repeat(2000));
    addUser('Now proceed with tests.');
    session.append('turn/start', { turn: 1 });

    // Write valid kept span first
    await archive.writeSpan({
      sessionId: session.id,
      compactionId: 'kept-span',
      entries: spanEntries(session, [0]),
    });

    // Simulate mask rollback triggered by post-write abort race
    const abortCtrl = new AbortController();
    const wrappedArchive = Object.assign(Object.create(Object.getPrototypeOf(archive)), archive, {
      async writeSpan(args) {
        const path = await archive.writeSpan(args);
        abortCtrl.abort(new Error('mid-mask abort'));
        return path;
      },
    });
    const planAbort = {
      compactionId: 'aborted-mask-span',
      targets: [{ seq: r1.seq, callId: r1.data.message.toolCallId, nextContent: [{ type: 'text', text: '[masked]' }] }],
    };
    await assert.rejects(
      () => commitObservationMask({ session, plan: planAbort, archive: wrappedArchive, signal: abortCtrl.signal }),
      /mid-mask abort/,
    );

    // Simulate ready.length === 0 rollback (surface emptied during writeSpan)
    const clearingArchive = Object.assign(Object.create(Object.getPrototypeOf(archive)), archive, {
      async writeSpan(args) {
        const path = await archive.writeSpan(args);
        session.surface.nodes.length = 0;
        return path;
      },
    });
    const planEmpty = {
      compactionId: 'empty-ready-span',
      targets: [{ seq: r2.seq, callId: r2.data.message.toolCallId, nextContent: [{ type: 'text', text: '[masked]' }] }],
    };
    const resEmpty = await commitObservationMask({ session, plan: planEmpty, archive: clearingArchive });
    assert.equal(resEmpty, null);

    // Verify neither aborted nor empty-ready span left a ghost entry in index.jsonl or files on disk
    const spans = await archive.listSpans(session.id);
    assert.deepEqual(
      spans.map((s) => s.compactionId),
      ['kept-span'],
      'only kept-span must remain in archive index after rollbacks',
    );
    const { callTool } = registerToolsMap(archive, session.id);
    const searchOut = await callTool('history_search', { query: 'Investigate' });
    assert.ok(searchOut.includes('kept-span'));
    assert.ok(!/unreadable|could not be read|missing/i.test(searchOut), `unexpected ghost warning: ${searchOut}`);

    // Direct deleteSpan is idempotent (false on empty id, true once absent)
    assert.equal(await archive.deleteSpan(session.id, ''), false);
    assert.equal(await archive.deleteSpan(session.id, 'never-existed'), true);
    assert.equal(await archive.deleteSpan(session.id, 'kept-span'), true);
    assert.equal((await archive.listSpans(session.id)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 2. zstd decompression 32 MiB cap
await test('2-zstd-decompression-32mib-cap-rejects-oversized-span-without-oom', async () => {
  assert.equal(MAX_SPAN_UNCOMPRESSED_BYTES, 32 * 1024 * 1024);
  const root = await mkdtemp(join(TEST_BASE, 'weave-w2-zstd-'));
  try {
    const archive = new CompactionArchive({ root });
    const sessionId = 'zstd-cap-sess';
    const oversizedText =
      JSON.stringify({ type: 'archive/header', version: 2, sessionId, compactionId: 'bomb-1', checksum: '00000000' }) +
      '\n' +
      'X'.repeat(33 * 1024 * 1024);
    const compressed = zstdCompressSync(Buffer.from(oversizedText, 'utf8'));
    const dir = archive.dirFor(sessionId);
    mkdirSync(dir, { recursive: true });
    await writeFile(join(dir, 'bomb-1.jsonl.zstd'), compressed);

    const readRes = await archive.readSpan(sessionId, 'bomb-1');
    assert.equal(readRes.ok, false);
    assert.equal(readRes.reason, 'damaged');

    // Legacy directory scan via sessionDirectory must also enforce 32 MiB cap synchronously
    const legacyRoot = join(root, 'legacy-check');
    const legacyDir = join(legacyRoot, 'legacy-bomb-sess');
    mkdirSync(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, 'bomb-1.jsonl.zstd'), compressed);
    assert.throws(
      () => sessionDirectory(legacyRoot, 'legacy-bomb-sess', 'archive'),
      (err) => err?.code === 'ERR_BUFFER_TOO_LARGE' || /exceeded|too large|buffer/i.test(String(err?.message ?? err)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 3 & 4. history_list new/legacy compat, history_read({ seq }), attachmentId guard, & projection hints
await test('3-and-4-archive-discoverability-history-list-history-read-seq-and-projection-hints', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-w2-history-'));
  try {
    const archive = new CompactionArchive({ root });
    const { session, addUser, addAssistant, addToolPair } = createSynthSession('hist-disc-1');
    const u0 = addUser('Refactor d:/work/src/auth/login.ts to enforce strict timeout limits.');
    const { resEv: t0 } = addToolPair('read_file', { path: 'src/config/timeout.js' }, 'L'.repeat(5000));
    addAssistant('Done updating timeout config.');

    // Write new span via API -> enriched index entry
    await archive.writeSpan({
      sessionId: session.id,
      compactionId: 'cmp-new-1',
      entries: spanEntries(session, [u0.seq, t0.seq]),
    });

    // Write legacy unindexed span (entry with NO startSeq/endSeq/files/label in index.jsonl)
    const uLegacy = addUser('Legacy span user requirement line for old index test.');
    const legacyEntries = spanEntries(session, [uLegacy.seq]);
    await archive.writeSpan({
      sessionId: session.id,
      compactionId: 'cmp-legacy-0',
      entries: legacyEntries,
    });
    const indexPath = join(archive.dirFor(session.id), 'index.jsonl');
    const indexLines = readFileSync(indexPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const rec = JSON.parse(line);
        if (rec.compactionId === 'cmp-legacy-0') {
          return JSON.stringify({
            compactionId: rec.compactionId,
            file: rec.file,
            entries: rec.entries,
            at: rec.at,
          });
        }
        return line;
      });
    writeFileSync(indexPath, indexLines.join('\n') + '\n', 'utf8');

    const { callTool } = registerToolsMap(archive, session.id);

    // HISTORY_TOOLS schema check: compactionId must not be in required[]
    const readToolSpec = HISTORY_TOOLS.find((t) => t.name === 'history_read');
    assert.ok(!readToolSpec.parameters.required?.includes('compactionId'));

    // history_list shows enriched fields on new span and stays clean on legacy span
    const listed = await callTool('history_list', {});
    assert.ok(listed.includes('cmp-new-1'), `listed=${listed}`);
    assert.ok(listed.includes(`seq=${u0.seq}-${t0.seq}`), `expected seq range in: ${listed}`);
    assert.ok(listed.includes('login.ts') || listed.includes('timeout.js'), `expected file hint in: ${listed}`);
    assert.ok(listed.includes('label='), `expected label in: ${listed}`);
    assert.ok(listed.includes('cmp-legacy-0'));
    assert.ok(!listed.includes('undefined') && !listed.includes('null'));

    // history_read({ seq }) without compactionId resolves both indexed new span and unindexed legacy span
    const readNewBySeq = await callTool('history_read', { seq: u0.seq });
    assert.ok(readNewBySeq.includes('cmp-new-1'));
    assert.ok(readNewBySeq.includes('strict timeout limits'));
    assert.ok(readNewBySeq.includes(HISTORY_SNAPSHOT_WARNING.slice(0, 30)));

    const readLegacyBySeq = await callTool('history_read', { seq: uLegacy.seq });
    assert.ok(readLegacyBySeq.includes('cmp-legacy-0'));
    assert.ok(readLegacyBySeq.includes('Legacy span user requirement'));

    // attachmentId still requires compactionId; missing both compactionId & seq errors cleanly
    const attErr = await callTool('history_read', { attachmentId: 'abc123' });
    assert.ok(/requires a compactionId/i.test(attErr), attErr);
    const emptyErr = await callTool('history_read', {});
    assert.ok(/requires a compactionId/i.test(emptyErr), emptyErr);

    // reference-input projection hints clarify optional compactionId with seq
    const bigToolMsg = session.deriveEventMessage(t0);
    const projected = projectSummaryMessage(session, t0, bigToolMsg, {
      toolResultPreviewMaxChars: 600,
    });
    const projText = typeof projected.content === 'string'
      ? projected.content
      : projected.content.map((b) => b?.text ?? '').join('\n');
    assert.ok(projText.includes(`history_read({ seq: ${t0.seq} })`), projText);
    assert.ok(projText.includes('compactionId optional with seq'), projText);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 5. renderContinuation matches renderArchivePointer + Folded archives preserve (seq start-end)
await test('5-renderContinuation-aligns-with-renderArchivePointer-and-collectChildArchiveIds', async () => {
  const { session, append } = (() => {
    const s = createSynthSession('ptr-sess');
    return { ...s, append: s.session.append.bind(s.session) };
  })();
  append('user/message', {
    id: 'ckpt-parent',
    role: 'user',
    source: { kind: 'compact-checkpoint', compactionId: 'cmp-child-1', shadowedRange: { start: 0, end: 12 } },
    content: [
      {
        type: 'text',
        text: 'History archive: cmp-child-1 (seq 0-12). Earlier checkpoints also reference their own archives.\nFolded archives: cmp-grandchild-0 (seq 0-5).',
      },
    ],
  }, { surfaceOp: 'append' });
  const childIds = collectChildArchiveIds(session, [0]);
  assert.ok(childIds.includes('cmp-child-1 (seq 0-12)'), `missing child ranged format: ${JSON.stringify(childIds)}`);
  assert.ok(childIds.includes('cmp-grandchild-0 (seq 0-5)'), `missing grandchild ranged format: ${JSON.stringify(childIds)}`);

  const meta = {
    compactionId: 'cmp-2',
    startSeq: 13,
    endSeq: 48,
    files: ['lib/engine.js', 'lib/history.js'],
    childIds,
  };
  const ptrLine = renderArchivePointer(meta);
  const contText = renderContinuation('## Goal\nShip Wave 2.', [], 'cmp-2', null, null, '', '', '', meta);
  assert.ok(ptrLine.includes('cmp-2 (seq 13-48)'));
  assert.ok(contText.includes('History archive: cmp-2 (seq 13-48).'));
  assert.ok(contText.includes('Archived files: lib/engine.js, lib/history.js.'));
  assert.ok(contText.includes('Folded archives: cmp-child-1 (seq 0-12), cmp-grandchild-0 (seq 0-5).'));
});

// 6. summaryReasoningEffort: 'low' cross-route & unset primary + automatic downgrade
await test('6-reasoning-effort-low-cross-route-unset-primary-and-downgrade', async () => {
  assert.equal(resolveReasoningEffort(undefined, 'low'), 'low');
  assert.equal(resolveReasoningEffort(null, 'low'), 'low');
  assert.equal(resolveReasoningEffort('max', 'low'), 'low');
  assert.equal(resolveReasoningEffort('minimal', 'low'), 'minimal');
  assert.equal(resolveReasoningEffort('none', 'low'), 'none');

  // Cross-route call with unset primary reasoningEffort passes 'low'
  const seenCross = [];
  const summaryInput = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Keep API compatible.' }] }],
  };
  const resCross = await summarizeWithChain({
    ctx: {
      llm: {
        async *stream(opts) {
          seenCross.push(opts.reasoningEffort);
          yield { type: 'text-delta', delta: makeSummary({}, 'en') };
          yield { type: 'finish', reason: 'stop', usage: { inputTokens: 10, outputTokens: 20 } };
        },
      },
    },
    chain: { targets: [{ provider: 'fallback-prov', model: 'fallback-model' }] },
    input: summaryInput,
    signal: new AbortController().signal,
    options: {
      primary: { provider: 'main-prov', model: 'main-model', reasoningEffort: undefined },
      reasoningEffortPolicy: 'low',
      maxTokens: 1024,
      timeoutMs: 10000,
      language: 'en',
      compactionRetries: 1,
    },
  });
  assert.ok(resCross.rawText.includes('## 1.'));
  assert.deepEqual(seenCross, ['low']);

  // Unsupported 'low' automatically downgrades to lower/default and remembers rejection per route
  const seenDowngrade = [];
  const llm = {
    async *stream(opts) {
      seenDowngrade.push(opts.reasoningEffort);
      if (opts.reasoningEffort === 'low') {
        throw Object.assign(new Error('UNSUPPORTED_REASONING_EFFORT: low rejected'), {
          code: 'UNSUPPORTED_REASONING_EFFORT',
        });
      }
      yield { type: 'text-delta', delta: makeSummary({}, 'en') };
      yield { type: 'finish', reason: 'stop', usage: { inputTokens: 10, outputTokens: 20 } };
    },
  };
  const resDowngrade = await summarizeWithChain({
    ctx: { llm },
    chain: { targets: [{ provider: 'p2', model: 'm2' }] },
    input: summaryInput,
    signal: new AbortController().signal,
    options: {
      primary: { provider: 'main-prov', model: 'main-model' },
      reasoningEffortPolicy: 'low',
      maxTokens: 1024,
      timeoutMs: 10000,
      language: 'en',
      compactionRetries: 1,
    },
  });
  assert.ok(resDowngrade.rawText.includes('## 1.'));
  assert.equal(seenDowngrade[0], 'low');
  assert.ok(seenDowngrade.length >= 2);
});

// 7. Hook contracts: multiline >500 <=1000 additionalContext separated from /compact <focus> + post-compact notices
await test('7-hook-contracts-additionalContext-separated-from-focus-and-postCompact-notices-captured', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-w2-hooks-'));
  try {
    const { session, addUser, addAssistant } = createSynthSession('hooks-contract-1');
    const filler = ' Detailed analysis of invoice line items, tax rounding, and ledger invariants. '.repeat(25);
    addUser('Must preserve integer billing math in cents across all invoices.');
    addAssistant('Understood, keeping integer billing math.' + filler);
    addUser('Also keep audit log schema immutable during migration.');
    addAssistant('Keeping audit log schema immutable.' + filler);
    addUser('Please verify invoice totals match line-item sums.');
    addAssistant('Verified.' + filler);

    const multilineCtx = [
      'Line 1: Keep migration rollback notes.',
      'Line 2: ' + 'R'.repeat(240),
      'Line 3: ' + 'S'.repeat(240),
      'Line 4: Final multi-line hook context line.',
    ].join('\n');
    assert.ok(multilineCtx.length > 500 && multilineCtx.length <= 1000);

    const userFocus = 'Keep auth schema and billing line numbers verbatim';
    const promptsSeen = [];
    const logs = [];
    const hookListeners = new Map();
    const ctx = {
      sessions: { flush: async () => {} },
      on(event, fn) {
        if (!hookListeners.has(event)) hookListeners.set(event, []);
        hookListeners.get(event).push(fn);
        return () => {};
      },
      events: {
        dispatch(_mode, args) {
          const event = args.shift();
          return (hookListeners.get(event) ?? []).map((fn) => fn.bind(null));
        },
      },
      tokenMeter: {
        async measure(s) {
          const nodes = (s.surface?.nodes ?? []).map((seq) => ({ seq, tokens: 8000, heuristicTokens: 8000 }));
          return { logRevision: s.seq, baseline: { kind: 'heuristic' }, totalTokens: nodes.length * 8000, nodes };
        },
      },
      llm: {
        resolveModelInfo: async () => ({ contextWindow: 200000, defaultMaxTokens: 4096 }),
        async *stream(opts) {
          promptsSeen.push(opts.messages.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => b.text ?? '').join('\n'))).join('\n'));
          yield {
            type: 'text-delta',
            delta: makeSummary({
              9: [
                'Must preserve integer billing math in cents across all invoices.',
                'Also keep audit log schema immutable during migration.',
              ].join('\n'),
            }, 'en'),
          };
          yield { type: 'finish', reason: 'stop', usage: { inputTokens: 100, outputTokens: 80 } };
        },
      },
      logger: {
        info: (m) => logs.push({ level: 'info', m }),
        warn: (m) => logs.push({ level: 'warn', m }),
        error: (m) => logs.push({ level: 'error', m }),
      },
    };
    ctx.on(PRE_COMPACT_EVENT, () => ({ additionalContext: multilineCtx }));
    ctx.on(POST_COMPACT_EVENT, () => ({ notices: ['verify-ok'] }));
    ctx.on(POST_COMPACT_EVENT, () => {
      throw new Error('slow-store');
    });

    const engine = new WeaveCompactionEngine(ctx, resolveConfig({
      stateDir: join(root, 'state'),
      journalDir: join(root, 'journal'),
      archiveDir: join(root, 'archive'),
      diagnosticsDir: join(root, 'diag'),
      sessionMemoryDir: join(root, 'mem'),
      retainRatio: 0.05,
      preserveRecentUserTokens: 10,
      language: 'en',
      postCompactReinjectEnabled: false,
      diskLivenessCheck: false,
    }).config);
    const agent = {
      session,
      options: { provider: 'p', model: 'm' },
      runMaintenance: async (fn) => fn(new AbortController().signal),
    };
    const result = await engine.compactNow(agent, new AbortController().signal, 'cmd-w2-hooks', false, {
      focusInstruction: userFocus,
    });
    assert.ok(result, 'compaction should succeed');
    assert.ok(promptsSeen.length >= 1);
    const fullPrompt = promptsSeen[0];
    assert.ok(fullPrompt.includes(userFocus), 'user focus instruction must remain intact');
    assert.ok(fullPrompt.includes('Line 1: Keep migration rollback notes.\nLine 2:'), 'additionalContext newlines must be preserved');
    assert.ok(fullPrompt.includes('Line 4: Final multi-line hook context line.'), 'additionalContext >500 <=1000 chars must not be truncated to 500');
    assert.deepEqual(result.hookNotices, ['verify-ok']);
    assert.ok(
      Array.isArray(result.hookWarnings) && result.hookWarnings.some((w) => w.includes('slow-store')),
      `expected hookWarnings with slow-store, got ${JSON.stringify(result.hookWarnings)}`,
    );
    assert.ok(logs.some((l) => l.level === 'info' && l.m.includes('verify-ok')));
    assert.ok(logs.some((l) => l.level === 'warn' && l.m.includes('slow-store')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 8. Code-heavy Chinese conversation detects 'zh' and dead sampleTextFor removed
await test('8-code-heavy-chinese-session-detects-zh-and-sampleTextFor-removed', async () => {
  const bigAsciiCode = Array.from({ length: 80 }, (_, i) => `function step_${i}(payload) { return payload.value + ${i}; }`).join('\n');
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: '请帮我排查登录接口超时的根本原因，保留所有鉴权校验。' }] },
    { role: 'tool', content: [{ type: 'text', text: '```js\n' + bigAsciiCode + '\n```' }] },
    { role: 'assistant', content: [{ type: 'text', text: '```ts\n' + bigAsciiCode + '\n```\n排查结果已确认，请修复超时重试。' }] },
    { role: 'user', content: [{ type: 'text', text: '`<untrusted_reference>Lots of ASCII wrapper text</untrusted_reference>`\n确认修改后运行单测验证。' }] },
  ];
  const sample = extractLanguageSample(msgs);
  assert.equal(detectLanguage(sample, 'auto'), 'zh');

  const req = buildSummaryRequest(
    { messages: msgs },
    { language: 'auto', userMessages: [] },
  );
  assert.equal(req.language, 'zh');

  const summarySource = await readFile(join(REPO_ROOT, 'lib/summary.js'), 'utf8');
  assert.equal(/function\s+sampleTextFor\b/.test(summarySource), false, 'dead sampleTextFor must be removed from lib/summary.js');
});

// 9. Audit hardening: forbid/disallow/ban/prohibit vs stop, colon boundary, O(n) backticks
await test('9-audit-forbid-disallow-ban-prohibit-colon-provenance-and-linear-backticks', async () => {
  const forbiddenSources = [
    { seq: 1, text: 'Forbid deleting production backups.' },
    { seq: 2, text: 'Disallow direct writes to master.' },
    { seq: 3, text: 'Ban unauthenticated webhook calls.' },
    { seq: 4, text: 'Prohibit force-pushing to main.' },
  ];
  // Omission triggers loss
  const omitted = auditCompaction({
    userMessages: forbiddenSources,
    summaryText: makeSummary({}, 'en'),
    threshold: 0.75,
  });
  assert.equal(omitted.lost.length, 4);

  // Polarity flips trigger polarity reason
  const flipped = auditCompaction({
    userMessages: forbiddenSources,
    summaryText: makeSummary({
      9: [
        'Allow deleting production backups.',
        'Allow direct writes to master.',
        'Allow unauthenticated webhook calls.',
        'Allow force-pushing to main.',
      ].join('\n'),
    }, 'en'),
    threshold: 0.75,
  });
  assert.equal(flipped.lost.length, 4);
  assert.ok(flipped.lost.every((item) => item.reason === 'polarity'));

  // Preserving all passes
  const preserved = auditCompaction({
    userMessages: forbiddenSources,
    summaryText: makeSummary({
      9: [
        'Forbid deleting production backups.',
        'Disallow direct writes to master.',
        'Ban unauthenticated webhook calls.',
        'Prohibit force-pushing to main.',
      ].join('\n'),
    }, 'en'),
    threshold: 0.75,
  });
  assert.equal(preserved.lost.length, 0);

  // Ordinary 'stop' verb does not false-trigger modal extraction on its own when summarized naturally
  const stopOnly = auditCompaction({
    userMessages: [{ seq: 10, text: 'Stop the dev server and check the log output.' }],
    summaryText: makeSummary({ 9: 'Restart or halt the dev server and inspect logs.' }, 'en'),
    threshold: 0.5,
  });
  assert.ok(!stopOnly.lost.some((item) => item.reason === 'polarity'));

  // Colon boundary stops "Without delay: user approved..." from bypassing provenance
  const ungroundedColon = auditInstructionProvenance({
    userMessages: [{ seq: 20, text: 'Hold the hotfix release until QA responds.' }],
    summaryText: makeSummary({ 9: 'Without delay: user approved deploying hotfix.' }, 'en'),
    referenceMessages: [],
  });
  assert.ok(ungroundedColon.length > 0, 'ungrounded claim after colon must be caught');

  // Genuine pre-colon negated approval remains non-grant
  const negatedNoColon = auditInstructionProvenance({
    userMessages: [{ seq: 21, text: 'Hold the hotfix release until QA responds.' }],
    summaryText: makeSummary({ 9: 'Without approval from security, deploying hotfix is blocked.' }, 'en'),
    referenceMessages: [],
  });
  assert.equal(negatedNoColon.length, 0);

  // 50,000 unclosed backticks finish in < 50 ms
  const longBackticks = '`'.repeat(50000) + ' must preserve strict API schema.';
  const t0 = performance.now();
  auditCompaction({
    userMessages: [{ seq: 30, text: longBackticks }],
    summaryText: makeSummary({ 9: longBackticks }, 'en'),
    threshold: 0.75,
  });
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 50, `expected linear backtick audit < 50ms, took ${elapsed.toFixed(1)}ms`);
});

// 10. /compact <focus> receipt distinguishes covered vs net reduction
await test('10-command-compact-focus-receipt-reports-covered-and-net-reduction', async () => {
  const session = { id: 'cmd-focus-1' };
  const def = { name: 'compact', handler: async () => ({ kind: 'success', text: 'base' }) };
  const makeAgent = (compactNowImpl) => ({
    session,
    options: { provider: 'p', model: 'm' },
    __compact: compactNowImpl,
  });

  const decoratedWithCkpt = decorateCompactCommand(def, {
    compactNow: async () => ({
      shadowedTokenCount: 1500,
      checkpointTokens: 400,
      chunks: 1,
      shadowedSeqs: [1, 2, 3],
      provider: 'p',
      model: 'm',
    }),
  });
  const resWithCkpt = await decoratedWithCkpt.handler({
    rawInput: '/compact keep auth',
    commandId: 'c1',
    agent: makeAgent(),
    signal: new AbortController().signal,
  });
  assert.equal(resWithCkpt.kind, 'success');
  assert.ok(resWithCkpt.text.includes('覆盖约 1500 tok（净缩减约 1100 tok）'), resWithCkpt.text);
  assert.ok(!resWithCkpt.text.includes('，缩减约 1500 tok'), resWithCkpt.text);

  const decoratedNoCkpt = decorateCompactCommand(def, {
    compactNow: async () => ({
      shadowedTokenCount: 1500,
      chunks: 1,
      shadowedSeqs: [1, 2, 3],
    }),
  });
  const resNoCkpt = await decoratedNoCkpt.handler({
    rawInput: '/compact keep auth',
    commandId: 'c2',
    agent: makeAgent(),
    signal: new AbortController().signal,
  });
  assert.ok(resNoCkpt.text.includes('覆盖源历史约 1500 tok'), resNoCkpt.text);
});

// 11. Offline estimateMessageTokens & estimateContentTokens use estimateHostHeuristicMessage
await test('11-offline-meter-estimates-image-and-tool-call-blocks-gt-zero', async () => {
  const msg = {
    id: 'm-mm',
    role: 'assistant',
    content: [
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' },
      { type: 'tool-call', callId: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'src/app.js' }) },
    ],
  };
  const expected = estimateHostHeuristicMessage(msg);
  assert.ok(expected > 0, `expected heuristic > 0, got ${expected}`);
  assert.equal(estimateMessageTokens(msg, null), expected);
  assert.equal(estimateContentTokens(msg.content, 'assistant', null), expected);
  assert.equal(estimateContentTokens([], 'assistant', null), 0);
});

// 12. SessionStateStore.update skips redundant write/fsync on unchanged data
await test('12-session-state-store-update-skips-unchanged-write-and-persists-changes', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-w2-state-'));
  try {
    const store = new SessionStateStore(root);
    const id = 'state-noop-1';
    store.update(id, (s) => ({ ...s, marker: 1 }));
    const file = store.file(id);
    const mtime1 = statSync(file).mtimeMs;

    await new Promise((r) => setTimeout(r, 40));
    store.update(id, (s) => ({ ...s }));
    const mtime2 = statSync(file).mtimeMs;
    assert.equal(mtime2, mtime1, 'unchanged update must skip _writeRecordSync and preserve mtimeMs');

    await new Promise((r) => setTimeout(r, 40));
    store.update(id, (s) => {
      s.marker = 2;
      return s;
    });
    const mtime3 = statSync(file).mtimeMs;
    assert.ok(mtime3 > mtime2, 'in-place mutation of prev must still write to disk');
    assert.equal(store.read(id).marker, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 13. Single pre-step caches _measure & _resolveSpec (misses on next turn or surface change)
await test('13-pre-step-cache-reuses-measure-and-resolveSpec-once-and-invalidates-correctly', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-w2-prestep-'));
  try {
    const { session, addUser, addAssistant } = createSynthSession('prestep-cache-1');
    addUser('Keep database migrations backward-compatible.');
    addAssistant('Understood.');

    let preStepHandler = null;
    let measureCalls = 0;
    let resolveModelCalls = 0;
    const ctx = {
      sessions: { flush: async () => {} },
      on(event, fn) {
        if (event === 'agent/pre-step') preStepHandler = fn;
        return () => {};
      },
      tokenMeter: {
        async measure(s) {
          measureCalls += 1;
          const nodes = (s.surface?.nodes ?? []).map((seq) => ({ seq, tokens: 500, heuristicTokens: 500 }));
          return { logRevision: s.seq, baseline: { kind: 'heuristic' }, totalTokens: nodes.length * 500, nodes };
        },
      },
      llm: {
        async resolveModelInfo() {
          resolveModelCalls += 1;
          return { contextWindow: 200000, defaultMaxTokens: 4096 };
        },
        async *stream() {
          throw new Error('should not summarize below threshold');
        },
      },
      logger: { info() {}, warn() {}, error() {} },
    };

    const engine = new WeaveCompactionEngine(ctx, resolveConfig({
      stateDir: join(root, 'state'),
      journalDir: join(root, 'journal'),
      archiveDir: join(root, 'archive'),
      diagnosticsDir: join(root, 'diag'),
      sessionMemoryDir: join(root, 'mem'),
      auto: true,
      persistedOutputEnabled: false,
      idleCompactionMinutes: 0,
      sessionMemoryEnabled: false,
      maxVisibleImages: 20,
    }).config);
    const agent = {
      session,
      options: { provider: 'p', model: 'm' },
      runMaintenance: async (fn) => fn(new AbortController().signal),
    };

    // Turn 1: below threshold -> compactIfNeeded calls _measure + _resolveSpec(full);
    // _guardRequestBudget calls _measure + _resolveSpec(budgetOnly). Cache reduces 2->1!
    let nextCalls = 0;
    await preStepHandler(
      { agent, signal: new AbortController().signal, messages: [] },
      async () => {
        nextCalls += 1;
        // Outside pre-step cache in next() must NOT reuse pre-step cache
        await engine._measure(session);
        return 'ok';
      },
    );
    assert.equal(nextCalls, 1);
    assert.equal(measureCalls, 2, '1 cached preflight measure + 1 uncached inside next()');
    assert.equal(resolveModelCalls, 1, 'resolveModelInfo reused between compactIfNeeded and _guardRequestBudget');

    // Turn 2: fresh pre-step pass starts empty cache even when surface hasn't changed
    await preStepHandler(
      { agent, signal: new AbortController().signal, messages: [] },
      async () => 'ok',
    );
    assert.equal(measureCalls, 3, 'second pre-step pass re-measures cleanly');
    assert.equal(resolveModelCalls, 2, 'second pre-step pass re-resolves cleanly');

    // Within one pre-step pass, surface mutation invalidates cached _measure and _resolveSpec
    await engine._preStepCache.run({ measures: new Map(), specs: new Map() }, async () => {
      const m1 = await engine._measure(session);
      const s1 = await engine._resolveSpec(agent, m1, new AbortController().signal);
      const m1Again = await engine._measure(session);
      const b1 = await engine._resolveSpec(agent, m1Again, new AbortController().signal, { budgetOnly: true });
      assert.equal(measureCalls, 4);
      assert.equal(resolveModelCalls, 3);
      assert.equal(b1.messageBudgetTokens, s1.messageBudgetTokens);

      addUser('New user turn mutating surface!');
      await engine._measure(session);
      await engine._resolveSpec(agent, m1, new AbortController().signal);
      assert.equal(measureCalls, 5, 'surface append must invalidate _measure cache');
      assert.equal(resolveModelCalls, 4, 'surface append must invalidate _resolveSpec cache');
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const failed = results.filter((r) => !r.pass).length;
console.log(JSON.stringify({ passed: results.length - failed, failed, results }, null, 2));
if (failed > 0) process.exitCode = 1;
