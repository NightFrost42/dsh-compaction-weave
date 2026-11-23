import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { WeaveCompactionEngine } from '../../lib/engine.js';
import { StockTransactionAdapter } from '../../lib/transaction.js';
import { resolveConfig } from '../../lib/config.js';
import { approxTokens, blocksToText } from '../../lib/meter.js';
import { measureVisibleImages } from '../../lib/image-budget.js';
import { buildCompactionInstruction } from '../../lib/prompt.js';

const modules = process.env.DSH_TEST_NODE_MODULES;
const load = (file) => import(pathToFileURL(path.join(modules, file)));
const { Context } = await load('@deepseek-ai/cordis/lib/index.js');
const { Session, SessionStore } = await load('@deepseek-ai/dsh-session/lib/index.js');
const persistence = await load('@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js');
const offloadPlugin = await load('@deepseek-ai/dsh-compaction-image-offload/lib/index.js');
const { LlmError, IMAGE_OFFLOAD_REQUIRED_CODE } = await load('@deepseek-ai/dsh-llm/lib/index.js');

const EN_HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));
const summaryText = EN_HEADINGS.map((h, i) =>
  `${h}\n${i === 0 ? 'Continue multimodal test.' : i === 5 ? '[filled by engine]' : 'Archived cleanly.'}`,
).join('\n\n');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message, stack: error.stack });
  }
}

async function hostFixture({ mountOffloadPlugin = true, extraConfig = {}, streamImpl = null } = {}) {
  const directory = fs.mkdtempSync(path.join(process.env.WEAVE_TEST_ROOT, 'test-tmp', 'mm-host-'));
  const root = new Context();
  const mounting = root.plugin({
    name: 'weave-multimodal-host-fixture',
    async apply(ctx) {
      new SessionStore(ctx);
      await persistence.apply(ctx, { root: path.join(directory, 'host-sessions'), compression: 'none' });
      if (mountOffloadPlugin) {
        await offloadPlugin.apply(ctx);
      }
    },
  });
  await mounting.await();

  const backend = root.sessionPersistence;
  const store = root.sessions;
  const sessionId = 'mm-host-' + randomUUID();
  const session = store.prepare(sessionId);
  const handle = await backend.create(session.header);
  const detach = store.enter(session);
  store.announce(session);

  const blobMap = new Map();
  let llmCalls = 0;
  const ctx = {
    on: (name, fn) => root.on(name, fn),
    waterfall: (name, ...args) => root.waterfall(name, ...args),
    provide: () => {},
    logger: { info() {}, warn() {}, error() {} },
    sessions: {
      flush: (s) => store.flush(s),
      get: (id) => store.get(id),
    },
    sessionPersistence: backend,
    tokenMeter: {
      measure(s) {
        const nodes = s.surface.nodes.map((seq) => ({
          seq,
          tokens: approxTokens(blocksToText(s.deriveEventMessage(s.eventAt(seq))?.content)),
        }));
        return { nodes, totalTokens: nodes.reduce((n, x) => n + x.tokens, 0) };
      },
    },
    llm: {
      async resolveModelInfo() {
        return { contextWindow: 1000000 };
      },
      async *stream(req) {
        llmCalls += 1;
        if (typeof streamImpl === 'function') {
          yield* streamImpl(req, llmCalls);
          return;
        }
        yield { type: 'text-delta', text: summaryText };
        yield { type: 'finish', kind: 'stop', usage: { inputTokens: 100, outputTokens: 60 } };
      },
    },
  };

  const engine = new WeaveCompactionEngine(
    ctx,
    resolveConfig({
      archiveDir: path.join(directory, 'weave', 'archive'),
      language: 'en',
      persistedOutputEnabled: false,
      microcompactEnabled: false,
      observationMaskingEnabled: false,
      ...extraConfig,
    }).config,
  );
  const adapter = new StockTransactionAdapter(backend, store, ctx.logger);
  adapter.register(engine.journal, engine.sessionState, engine.config.failureThreshold, engine.backupStore);
  engine.transactionAdapter = adapter;
  engine.requireTransactionAdapter = true;
  engine.historyToolsAvailable = true;
  engine.archive.attachments = {
    async readImage(ref) {
      const data = blobMap.get(ref.attachmentId);
      if (!data) throw new Error(`missing host blob ${ref.attachmentId}`);
      return { data };
    },
  };

  const agent = {
    session,
    options: { provider: 'p', model: 'm' },
    runMaintenance: (fn) => fn(new AbortController().signal),
    cancel: () => {},
  };

  const mkImg = (seed, opts = {}) => {
    const size = opts.bytes ?? 64;
    const raw = Buffer.alloc(size, 0x4d);
    raw.write(`host-img-${seed}-`.slice(0, size));
    const digest = createHash('sha256').update(raw).digest('hex');
    const att = {
      attachmentId: `sha256:${digest}`,
      mediaType: 'image/png',
      bytes: raw.length,
      width: opts.width ?? 800,
      height: opts.height ?? 600,
      name: `host-${seed}.png`,
    };
    blobMap.set(att.attachmentId, raw);
    return { type: 'image', attachment: att };
  };

  const addSystem = (text) =>
    session.append(
      'system/message',
      {
        turn: 1,
        step: 1,
        message: { id: randomUUID(), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } },
      },
      { surfaceOp: 'append' },
    );

  const addUser = (content) =>
    session.append(
      'user/message',
      { id: randomUUID(), role: 'user', content, source: { kind: 'user' } },
      { surfaceOp: 'append' },
    );

  const addAssistantToolCall = (callId, name = 'inspect_img') => {
    session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        stream: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
      { surfaceOp: 'append' },
    );
    return session.append('tool/call', {
      turn: 1,
      step: 1,
      callId,
      name,
      arguments: '{}',
    });
  };

  const addToolResult = (callId, content, callSeq) =>
    session.append(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: { id: randomUUID(), role: 'tool', toolCallId: callId, content, source: { kind: 'tool', callId } },
      },
      { surfaceOp: 'append', sourceEventSeqs: [callSeq] },
    );

  const close = async () => {
    delete adapter.checkpoint;
    engine.dispose();
    adapter.dispose();
    detach();
    await handle.close();
    await mounting.dispose();
  };

  return {
    directory,
    backend,
    store,
    session,
    sessionId,
    engine,
    agent,
    mkImg,
    addSystem,
    addUser,
    addAssistantToolCall,
    addToolResult,
    calls: () => llmCalls,
    close,
  };
}

await test('host-dsh-compaction-image-offload-collaborates-on-IMAGE_OFFLOAD_REQUIRED-in-compactSpan', async () => {
  const f = await hostFixture({
    mountOffloadPlugin: true,
    extraConfig: { cachePreservePrefix: true },
    streamImpl: async function* (req, callNum) {
      if (callNum === 1) {
        const err = new LlmError('Too many un-offloaded images', IMAGE_OFFLOAD_REQUIRED_CODE, {
          offloadImages: 2,
        });
        throw err;
      }
      // On 2nd attempt, at least 2 images were offloaded by real host dsh-compaction-image-offload
      const rawImgs = req.messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((b) => b?.type === 'image' && b.offloaded !== true);
      assert.equal(rawImgs.length, 0, 'both images should now carry offloaded: true from host projection');
      yield { type: 'text-delta', text: summaryText };
      yield { type: 'finish', kind: 'stop', usage: { inputTokens: 80, outputTokens: 50 } };
    },
  });

  try {
    f.session.append('turn/start', { turn: 1 });
    f.session.append('step/start', { turn: 1, step: 1 });
    f.addSystem('Stable system prefix.');
    const u1 = f.addUser([{ type: 'text', text: 'Keep DB read-only. ' + 'note '.repeat(400) }, f.mkImg('h1')]);
    const ac = f.addAssistantToolCall('tc-h1');
    const t1 = f.addToolResult('tc-h1', [f.mkImg('h2'), { type: 'text', text: 'evidence '.repeat(1200) }], ac.seq);
    f.addUser([{ type: 'text', text: 'Tail turn stays.' }]);
    f.session.append('step/end', { turn: 1, step: 1 });
    f.session.append('turn/end', { turn: 1 });
    await f.store.flush(f.session);

    const res = await f.engine._compactSpan(
      u1.seq,
      t1.seq,
      f.agent,
      new AbortController().signal,
      { manual: true, policy: f.engine.config, preservePrefixCache: true },
      0,
    );
    assert.ok(res);
    assert.equal(f.calls(), 2);
    assert.equal(f.engine._failures.size, 0);
    assert.ok(f.session.snapshotEvents().some((e) => e.type === 'image/offload'));
  } finally {
    await f.close();
  }
});

await test('host-real-session-2a-batch-offload-increments-contentGeneration-and-replays', async () => {
  const f = await hostFixture({
    mountOffloadPlugin: true,
    extraConfig: { maxVisibleImages: 24, maxVisibleAttachmentBytes: 16 * 1024 * 1024 },
  });
  try {
    f.session.append('turn/start', { turn: 1 });
    f.session.append('step/start', { turn: 1, step: 1 });
    f.addSystem('System.');
    for (let i = 0; i < 25; i += 1) {
      const img = f.mkImg(`nat-${i}`, { bytes: 256 * 1024, width: i === 2 ? 390 : 800, height: i === 2 ? 2475 : 600 });
      if (i % 2 === 0) {
        f.addUser([{ type: 'text', text: `img ${i}` }, img]);
      } else {
        const ac = f.addAssistantToolCall(`tc-${i}`);
        f.addToolResult(`tc-${i}`, [img, { type: 'text', text: 'ok' }], ac.seq);
      }
    }
    const replaceGenBefore = f.session.surface.replaceGeneration;
    const contentGenBefore = f.session.surface.contentGeneration;

    const committed = await f.engine._guardVisibleImageBudget(f.agent, new AbortController().signal);
    assert.ok(committed);
    assert.equal(committed.mode, 'image-offload');
    assert.equal(committed.offloadCount, 19);
    assert.equal(committed.remainingCount, 6);
    assert.equal(measureVisibleImages(f.session).visibleImageCount, 6);
    assert.equal(f.session.surface.replaceGeneration, replaceGenBefore);
    assert.equal(f.session.surface.contentGeneration, contentGenBefore + 1);
    assert.equal(
      f.session.snapshotEvents().some((e) => e.type === 'user/message' && e.surfaceOp && e.surfaceOp !== 'append'),
      false,
    );
    await f.store.flush(f.session);
    const stored = await f.backend.readStoredLog(f.backend.locate(f.session.header).path, f.session.id);
    const replayed = Session.fromRestore(
      f.session.id,
      stored.events,
      stored.meta,
      stored.inheritedEventCount,
      'detached',
      f.store.messageProjections,
    );
    assert.equal(measureVisibleImages(replayed).visibleImageCount, 6);
  } finally {
    await f.close();
  }
});

await test('host-without-imageOffloadProjection-rejects-atomically-and-falls-back-safely', async () => {
  const f = await hostFixture({
    mountOffloadPlugin: false,
    extraConfig: { maxVisibleImages: 4, maxVisibleAttachmentBytes: 16 * 1024 * 1024 },
  });
  try {
    f.session.append('turn/start', { turn: 1 });
    f.session.append('step/start', { turn: 1, step: 1 });
    f.addSystem('System.');
    const u1 = f.addUser([{ type: 'text', text: 'user photo' }, f.mkImg('no-proj-u1')]);
    const ac = f.addAssistantToolCall('tc-np');
    const tr = f.addToolResult('tc-np', [f.mkImg('no-proj-t1'), { type: 'text', text: 'tool text' }], ac.seq);
    for (let i = 0; i < 6; i += 1) {
      f.addUser([{ type: 'text', text: `tail-${i}` }, f.mkImg(`np-hot-${i}`)]);
    }

    const res = await f.engine._guardVisibleImageBudget(f.agent, new AbortController().signal);
    assert.ok(res);
    assert.equal(res.mode, 'tool-result-image-stub');
    assert.equal(f.session.snapshotEvents().some((e) => e.type === 'image/offload'), false, 'failed projection must never enter log');
    assert.ok(f.session.surface.nodes.includes(u1.seq), 'user/message stays intact');
    assert.equal(f.session.surface.nodes.includes(tr.seq), false, 'old tool/result replaced');
    await f.store.flush(f.session);
  } finally {
    await f.close();
  }
});

await test('host-finish-error-chunk-IMAGE_OFFLOAD_REQUIRED-offloads-or-strips-in-memory', async () => {
  const fWithProj = await hostFixture({
    mountOffloadPlugin: true,
    extraConfig: { cachePreservePrefix: true },
    streamImpl: async function* (req, callNum) {
      if (callNum === 1) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { code: IMAGE_OFFLOAD_REQUIRED_CODE, message: 'offload 2 images', offloadImages: 2 },
          },
        };
        return;
      }
      const rawImgs = req.messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((b) => b?.type === 'image' && b.offloaded !== true);
      assert.equal(rawImgs.length, 0, 'images offloaded cleanly via direct projection on finish:error chunk');
      yield { type: 'text-delta', text: summaryText };
      yield { type: 'finish', kind: 'stop', usage: { inputTokens: 80, outputTokens: 50 } };
    },
  });
  try {
    fWithProj.session.append('turn/start', { turn: 1 });
    fWithProj.session.append('step/start', { turn: 1, step: 1 });
    fWithProj.addSystem('Stable system prefix.');
    const u1 = fWithProj.addUser([{ type: 'text', text: 'Keep DB read-only. ' + 'note '.repeat(400) }, fWithProj.mkImg('fe1')]);
    const tc1 = fWithProj.addAssistantToolCall('tc-fe1');
    const t1 = fWithProj.addToolResult('tc-fe1', [fWithProj.mkImg('fe2'), { type: 'text', text: 'evidence '.repeat(1200) }], tc1.seq);
    fWithProj.addUser([{ type: 'text', text: 'Tail turn stays.' }]);
    fWithProj.session.append('step/end', { turn: 1, step: 1 });
    fWithProj.session.append('turn/end', { turn: 1 });
    await fWithProj.store.flush(fWithProj.session);

    const res = await fWithProj.engine._compactSpan(
      u1.seq,
      t1.seq,
      fWithProj.agent,
      new AbortController().signal,
      { manual: true, policy: fWithProj.engine.config, preservePrefixCache: true },
      0,
    );
    assert.ok(res);
    assert.equal(fWithProj.calls(), 2);
    assert.equal(fWithProj.engine._failures.size, 0);
    assert.ok(fWithProj.session.snapshotEvents().some((e) => e.type === 'image/offload'));
  } finally {
    await fWithProj.close();
  }

  const fWithoutProj = await hostFixture({
    mountOffloadPlugin: false,
    extraConfig: { cachePreservePrefix: true },
    streamImpl: async function* (req, callNum) {
      if (callNum === 1) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { code: IMAGE_OFFLOAD_REQUIRED_CODE, message: 'offload 2 images', offloadImages: 2 },
          },
        };
        return;
      }
      const rawImgs = req.messages
        .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .filter((b) => b?.type === 'image');
      assert.equal(rawImgs.length, 0, 'in-memory stripImagesForSummary handles finish:error when host lacks projection');
      assert.ok(
        req.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => typeof b.text === 'string' && b.text.includes('Image omitted for summary'))),
      );
      yield { type: 'text-delta', text: summaryText };
      yield { type: 'finish', kind: 'stop', usage: { inputTokens: 80, outputTokens: 50 } };
    },
  });
  try {
    fWithoutProj.session.append('turn/start', { turn: 1 });
    fWithoutProj.session.append('step/start', { turn: 1, step: 1 });
    fWithoutProj.addSystem('Stable system prefix.');
    const u1 = fWithoutProj.addUser([{ type: 'text', text: 'Keep DB read-only. ' + 'note '.repeat(400) }, fWithoutProj.mkImg('fnp1')]);
    const tc1 = fWithoutProj.addAssistantToolCall('tc-fnp1');
    const t1 = fWithoutProj.addToolResult('tc-fnp1', [fWithoutProj.mkImg('fnp2'), { type: 'text', text: 'evidence '.repeat(1200) }], tc1.seq);
    fWithoutProj.addUser([{ type: 'text', text: 'Tail turn stays.' }]);
    fWithoutProj.session.append('step/end', { turn: 1, step: 1 });
    fWithoutProj.session.append('turn/end', { turn: 1 });
    await fWithoutProj.store.flush(fWithoutProj.session);

    const res = await fWithoutProj.engine._compactSpan(
      u1.seq,
      t1.seq,
      fWithoutProj.agent,
      new AbortController().signal,
      { manual: true, policy: fWithoutProj.engine.config, preservePrefixCache: true },
      0,
    );
    assert.ok(res);
    assert.equal(fWithoutProj.calls(), 2);
    assert.equal(fWithoutProj.session.snapshotEvents().some((e) => e.type === 'image/offload'), false);
  } finally {
    await fWithoutProj.close();
  }
});

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
console.log(JSON.stringify({ passed, failed, results }, null, 2));
if (failed > 0) process.exitCode = 1;
