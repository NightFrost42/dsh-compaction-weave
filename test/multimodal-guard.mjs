import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_MAX_VISIBLE_ATTACHMENT_BYTES,
  DEFAULT_MAX_VISIBLE_IMAGES,
  normalizeMaxVisibleAttachmentBytes,
  normalizeMaxVisibleImages,
  resolveConfig,
} from '../lib/config.js';
import { prepareContinuation } from '../lib/continuation.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import {
  DEFAULT_KEEP_HOT_IMAGES,
  SUMMARY_MAX_IMAGE_COUNT,
  SUMMARY_MAX_IMAGE_PAYLOAD_BYTES,
  inspectMessagesImages,
  isImageOffloadRequiredError,
  isUpstreamMultimodal400Error,
  measureVisibleImages,
  planVisibleImageOffload,
} from '../lib/image-budget.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { buildCompactionInstruction } from '../lib/prompt.js';
import { buildCheckpointBlocks } from '../lib/region.js';
import { SessionMemoryStore, computeSessionMemoryPolicyFingerprint, computeSessionMemorySourceHash } from '../lib/session-memory.js';
import { buildSummaryRequest } from '../lib/summary-budget.js';
import { handleSummaryConfigRpc } from '../lib/summary-config.js';

const TEST_BASE = process.env.WEAVE_TEST_ROOT ?? tmpdir();
const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

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
      error: error?.message ?? String(error),
      stack: error?.stack,
    });
  }
}

const EN_HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeSummary(extra = 'Preserve active rules cleanly.') {
  return EN_HEADINGS.map((h, idx) =>
    `${h}\n${idx === 5 ? '[filled by engine]' : idx === 8 ? extra : 'Historical work archived cleanly.'}`,
  ).join('\n\n');
}

function makeImgAttachment(seed, { bytes = 450 * 1024, width = 800, height = 600, mediaType = 'image/png' } = {}) {
  const digest = createHash('sha256').update(`img-${seed}`).digest('hex');
  return {
    type: 'image',
    attachment: {
      attachmentId: `sha256:${digest}`,
      mediaType,
      bytes,
      width,
      height,
      name: `shot-${seed}.png`,
    },
  };
}

function makeSurfaceFixture({
  root,
  extraConfig = {},
  windowTokens = 200000,
  streamImpl = null,
  withNativeImageProjection = true,
  openTurn = 1,
} = {}) {
  const logs = [];
  const events = [];
  const projectedMessages = new Map();
  const surface = { nodes: [], replaceGeneration: 0, contentGeneration: 0 };
  const hooks = new Map();
  const llmCalls = [];
  const attachmentsMap = new Map();

  const emit = (name, ...args) => {
    for (const fn of hooks.get(name) ?? []) fn(...args);
  };

  const session = {
    id: `sess-${randomUUID()}`,
    header: { version: 4, id: 'placeholder', createdAt: Date.now() - 120000, isSeeded: false },
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => [...events],
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    toolHistory: () => [],
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (projectedMessages.has(event.seq)) return projectedMessages.get(event.seq);
      if (event.type === 'user/message') return event.data;
      if (event.type === 'assistant/message') return event.data.message?.content?.length ? event.data.message : null;
      if (event.type === 'system/message') return event.data.message;
      if (event.type === 'tool/result') return event.data.message;
      return null;
    },
    append(type, data, meta = {}) {
      if (type === 'image/offload') {
        if (!withNativeImageProjection) {
          throw new Error('session event "image/offload" requires a message projection');
        }
        const targets = data?.targets;
        if (!Array.isArray(targets) || targets.length === 0) {
          throw new Error('image/offload: targets must be non-empty');
        }
        for (const target of targets) {
          const ev = events[target.seq];
          const cur = session.deriveEventMessage(ev);
          const idxSet = new Set(target.imageIndexes);
          let imgIdx = 0;
          const nextContent = cur.content.map((b) => {
            if (b?.type !== 'image') return b;
            const curIdx = imgIdx++;
            return idxSet.has(curIdx) ? { ...b, offloaded: true } : b;
          });
          projectedMessages.set(target.seq, { ...cur, content: nextContent });
        }
        surface.contentGeneration += 1;
        const ev = { seq: events.length, type, data, ts: Date.now() };
        events.push(ev);
        emit('session/event', session, ev);
        return ev;
      }

      const seq = events.length;
      const ev = {
        seq,
        type,
        data,
        ts: Date.now(),
        ...(meta.surfaceOp ? { surfaceOp: meta.surfaceOp } : {}),
        ...(meta.sourceEventSeqs ? { sourceEventSeqs: meta.sourceEventSeqs } : {}),
      };
      events.push(ev);
      if (meta.surfaceOp === 'append') {
        surface.nodes.push(seq);
      } else if (meta.surfaceOp && meta.surfaceOp.op === 'replace') {
        const sIdx = surface.nodes.indexOf(meta.surfaceOp.startSeq);
        const eIdx = surface.nodes.indexOf(meta.surfaceOp.endSeq);
        assert.ok(sIdx >= 0 && eIdx >= sIdx, `invalid replace range ${meta.surfaceOp.startSeq}..${meta.surfaceOp.endSeq}`);
        surface.nodes.splice(sIdx, eIdx - sIdx + 1, seq);
        surface.replaceGeneration += 1;
        surface.contentGeneration += 1;
      }
      emit('session/event', session, ev);
      return ev;
    },
  };
  session.header.id = session.id;

  if (openTurn !== null) {
    session.append('turn/start', { turn: openTurn });
  }

  const measure = () => {
    const nodes = surface.nodes.map((seq) => {
      const m = session.deriveEventMessage(events[seq]);
      return { seq, tokens: approxTokens(blocksToText(m?.content)) };
    });
    return { nodes, totalTokens: nodes.reduce((a, b) => a + b.tokens, 0) };
  };

  const ctx = {
    logger: {
      info: (m) => logs.push({ level: 'info', msg: String(m) }),
      warn: (m) => logs.push({ level: 'warn', msg: String(m) }),
      error: (m) => logs.push({ level: 'error', msg: String(m) }),
    },
    on(name, fn) {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push(fn);
    },
    async waterfall(name, payload, fallback) {
      const fns = hooks.get(name) ?? [];
      let idx = 0;
      const runNext = async () => {
        if (idx >= fns.length) return fallback();
        const fn = fns[idx++];
        return await fn(payload, runNext);
      };
      return await runNext();
    },
    provide() {},
    sessions: {
      flush: async () => {},
      get: (id) => (id === session.id ? session : undefined),
    },
    tokenMeter: { measure: () => measure() },
    llm: {
      async resolveModelInfo() {
        return { contextWindow: windowTokens, defaultMaxTokens: 8192 };
      },
      async *stream(req) {
        llmCalls.push(req);
        if (typeof streamImpl === 'function') {
          yield* streamImpl(req, llmCalls.length);
          return;
        }
        yield { type: 'text-delta', text: makeSummary() };
        yield { type: 'finish', kind: 'stop', usage: { inputTokens: 120, outputTokens: 80 } };
      },
    },
  };

  const { config } = resolveConfig({
    archiveDir: join(root, 'archive'),
    language: 'en',
    proactiveEnabled: false,
    persistedOutputEnabled: false,
    microcompactEnabled: false,
    observationMaskingEnabled: false,
    continuationEnabled: false,
    summaryRetryCount: 0,
    summaryRetryDelayMs: 0,
    headroomTokens: 4096,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    ...extraConfig,
  });

  const engine = new WeaveCompactionEngine(ctx, config);
  engine.historyToolsAvailable = true;
  engine.archive.attachments = {
    async readImage(ref) {
      const buf = attachmentsMap.get(ref.attachmentId);
      if (!buf) throw new Error(`missing fixture image ${ref.attachmentId}`);
      return { data: buf };
    },
  };

  const agent = {
    session,
    options: { provider: 'p', model: 'm' },
    runMaintenance: (fn) => fn(new AbortController().signal),
    cancel: () => {},
  };

  const registerImageBlock = (seed, opts = {}) => {
    const size = opts.bytes ?? 80;
    const raw = Buffer.alloc(size, 0x50);
    raw.write(`img-data-${seed}-`.slice(0, size));
    const digest = createHash('sha256').update(raw).digest('hex');
    const block = {
      type: 'image',
      attachment: {
        attachmentId: `sha256:${digest}`,
        mediaType: opts.mediaType ?? 'image/png',
        bytes: raw.length,
        width: opts.width ?? 800,
        height: opts.height ?? 600,
        name: `shot-${seed}.png`,
      },
    };
    attachmentsMap.set(block.attachment.attachmentId, raw);
    return block;
  };

  const addSystem = (text) =>
    session.append(
      'system/message',
      { message: { role: 'system', content: [{ type: 'text', text }] } },
      { surfaceOp: 'append' },
    );

  const addUser = (blocksOrText) => {
    const content =
      typeof blocksOrText === 'string' ? [{ type: 'text', text: blocksOrText }] : blocksOrText;
    return session.append(
      'user/message',
      { id: randomUUID(), role: 'user', content, source: { kind: 'user' } },
      { surfaceOp: 'append' },
    );
  };

  const addAssistant = (text, toolCalls = []) => {
    const content = [{ type: 'text', text }];
    for (const tc of toolCalls) {
      const args = typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {});
      content.push({ type: 'tool-call', id: tc.id, name: tc.name, arguments: args });
    }
    return session.append(
      'assistant/message',
      {
        turn: openTurn ?? 1,
        step: 1,
        stream: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        message: { role: 'assistant', content, source: { kind: 'model', provider: 'p', model: 'm' } },
      },
      { surfaceOp: 'append' },
    );
  };

  const addToolCall = (callId, name = 'view_img', args = '{}') =>
    session.append('tool/call', {
      turn: openTurn ?? 1,
      step: 1,
      callId,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    });

  const addToolResult = (callId, contentBlocks, sourceSeqs = []) => {
    const content = typeof contentBlocks === 'string' ? [{ type: 'text', text: contentBlocks }] : contentBlocks;
    return session.append(
      'tool/result',
      {
        turn: openTurn ?? 1,
        step: 1,
        message: { role: 'tool', toolCallId: callId, content, source: { kind: 'tool', callId } },
      },
      { surfaceOp: 'append', ...(sourceSeqs.length ? { sourceEventSeqs: sourceSeqs } : {}) },
    );
  };

  const runWaterfall = (name, payload, fallback = () => undefined) => ctx.waterfall(name, payload, fallback);

  return {
    session,
    surface,
    events,
    hooks,
    llmCalls,
    logs,
    engine,
    agent,
    ctx,
    registerImageBlock,
    addSystem,
    addUser,
    addAssistant,
    addToolCall,
    addToolResult,
    runWaterfall,
  };
}

await test('summary-budget-decouples-image-bytes-and-triggers-independent-image-strip', () => {
  // Single 450 KB and 2 MiB image must NOT push inputUnits over 448 KiB text cap
  const single450k = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'check screenshot' }, makeImgAttachment('450k', { bytes: 450 * 1024 })] }],
  };
  const req450 = buildSummaryRequest(single450k, { language: 'en' });
  assert.ok(req450.inputUnits < 10000, `inputUnits must exclude binary bytes*4/3, got ${req450.inputUnits}`);
  assert.equal(req450.imagesStripped, false);
  assert.equal(req450.imageCount, 1);
  assert.equal(req450.imagePayloadBytes, Math.ceil((450 * 1024) / 3) * 4);

  const single2mb = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'check 2MB' }, makeImgAttachment('2mb', { bytes: 2 * 1024 * 1024 })] }],
  };
  const req2mb = buildSummaryRequest(single2mb, { language: 'en' });
  assert.ok(req2mb.inputUnits < 10000, `2MB image must not trigger 448 KiB inputUnits block, got ${req2mb.inputUnits}`);
  assert.equal(req2mb.imagesStripped, false);

  // > 10 MiB total base64 payload triggers automatic in-memory strip without mutating input
  const twelveMbMsgs = {
    messages: Array.from({ length: 10 }, (_, i) => ({
      role: 'user',
      content: [{ type: 'text', text: `turn ${i}` }, makeImgAttachment(`big-${i}`, { bytes: 1024 * 1024, width: 1200, height: 800 })],
    })),
  };
  const reqStripBytes = buildSummaryRequest(twelveMbMsgs, { language: 'en' });
  assert.equal(reqStripBytes.imagesStripped, true);
  assert.ok(reqStripBytes.imagePayloadBytes > SUMMARY_MAX_IMAGE_PAYLOAD_BYTES);
  assert.ok(reqStripBytes.messages.every((m) => m.content.every((b) => b.type !== 'image')));
  assert.ok(reqStripBytes.messages.some((m) => m.content.some((b) => /Image omitted for summary.*1200x800/.test(b.text))));
  assert.equal(twelveMbMsgs.messages[0].content[1].type, 'image', 'original input messages must stay unmutated');

  // >= 16 images triggers independent strip even when small bytes
  const sixteenImgs = {
    messages: Array.from({ length: SUMMARY_MAX_IMAGE_COUNT }, (_, i) => ({
      role: 'user',
      content: [makeImgAttachment(`cnt-${i}`, { bytes: 1024, width: 400, height: 400 })],
    })),
  };
  const reqCount = buildSummaryRequest(sixteenImgs, { language: 'en' });
  assert.equal(reqCount.imagesStripped, true);
  assert.equal(inspectMessagesImages(sixteenImgs.messages).imageCount, SUMMARY_MAX_IMAGE_COUNT);
});

await test('image-offload-required-dispatches-verbatim-seqs-without-sys0-and-zero-breaker', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-mm-2c-1-'));
  try {
    let seenDispatch = null;
    let streamCount = 0;
    const f = makeSurfaceFixture({
      root,
      extraConfig: { cachePreservePrefix: true, reactiveStep: 1 },
      streamImpl: async function* (_req, callNum) {
        streamCount = callNum;
        if (callNum === 1) {
          yield {
            type: 'finish',
            kind: 'error',
            failure: { code: 'IMAGE_OFFLOAD_REQUIRED', message: 'offload oldest 2 images', offloadImages: 2 },
          };
          return;
        }
        yield { type: 'text-delta', text: makeSummary('Retried cleanly after native offload.') };
        yield { type: 'finish', kind: 'stop', usage: { inputTokens: 100, outputTokens: 60 } };
      },
    });

    // Mock host compaction-image-offload plugin registered AFTER Weave's listener
    f.ctx.on('compaction/summary-error', ({ session, sourceEventSeqs, error }, next) => {
      seenDispatch = { sourceEventSeqs: [...sourceEventSeqs], errorCode: error?.code };
      if (error?.code !== 'IMAGE_OFFLOAD_REQUIRED') return next();
      let left = error.failure?.offloadImages ?? 2;
      const targets = [];
      for (const s of sourceEventSeqs) {
        if (left <= 0) break;
        const ev = session.eventAt(s);
        if (ev?.type !== 'user/message' && ev?.type !== 'tool/result') continue;
        const msg = session.deriveEventMessage(ev);
        const imageIndexes = [];
        let idx = 0;
        for (const b of msg.content) {
          if (b.type === 'image') {
            if (!b.offloaded && left > 0) {
              imageIndexes.push(idx);
              left -= 1;
            }
            idx += 1;
          }
        }
        if (imageIndexes.length > 0) targets.push({ seq: s, imageIndexes });
      }
      if (!targets.length) return next();
      session.append('image/offload', { targets });
      return true;
    });

    const sysEv = f.addSystem('System head.');
    const ckptEv = f.session.append(
      'user/message',
      { id: randomUUID(), role: 'user', content: [{ type: 'text', text: '<compacted-summary>\n## 1. Current Task\nprev\n</compacted-summary>' }], source: { kind: 'compact-checkpoint', version: 4, preserved: [] } },
      { surfaceOp: 'append' },
    );
    const u1 = f.addUser([{ type: 'text', text: 'Keep production immutable.' }, f.registerImageBlock('u1', { bytes: 2048, width: 1024, height: 768 })]);
    f.addAssistant('Running check '.repeat(1200), [{ id: 'tc1', name: 'view_img' }]);
    const tc1 = f.addToolCall('tc1', 'view_img');
    const t1 = f.addToolResult('tc1', [f.registerImageBlock('t1', { bytes: 2048, width: 1024, height: 768 }), { type: 'text', text: 'result '.repeat(600) }], [tc1.seq]);
    const tailU = f.addUser('Current active message.');

    const res = await f.engine._compactSpan(u1.seq, t1.seq, f.agent, new AbortController().signal, {
      manual: true,
      policy: f.engine.config,
      preservePrefixCache: true,
    }, 0);

    assert.ok(res);
    assert.equal(streamCount, 2);
    assert.ok(seenDispatch, 'host compaction/summary-error listener must run');
    assert.equal(seenDispatch.errorCode, 'IMAGE_OFFLOAD_REQUIRED');
    assert.ok(!seenDispatch.sourceEventSeqs.includes(sysEv.seq), 'candidateSeqs must exclude index 0 system/message');
    assert.ok(seenDispatch.sourceEventSeqs.includes(ckptEv.seq), 'candidateSeqs must cover verbatim prefix seqs');
    assert.ok(seenDispatch.sourceEventSeqs.includes(u1.seq));
    assert.ok(seenDispatch.sourceEventSeqs.includes(t1.seq));
    assert.equal(f.engine._failures.size, 0, 'successful in-place retry must leave breaker failures at 0');
    assert.equal(f.engine._stopped.size, 0);
    // Remaining surface nodes after commit kept system + checkpoint(new) + tailU cleanly
    assert.ok(f.session.surface.nodes.includes(tailU.seq));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

await test('image-offload-loop-cap-2-no-progress-and-upstream-400-converge-with-stripImagesForSummary', async () => {
  // Subcase A: listener reduces count on every call, but summary keeps failing with IMAGE_OFFLOAD_REQUIRED (>2 rounds)
  const rootA = await mkdtemp(join(TEST_BASE, 'weave-mm-cap-'));
  try {
    let calls = 0;
    const f = makeSurfaceFixture({
      root: rootA,
      extraConfig: { reactiveStep: 1 },
      streamImpl: async function* (req) {
        calls += 1;
        const hasRawImages = req.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image' && !b.offloaded));
        if (calls <= 3) {
          assert.equal(hasRawImages, true, `call ${calls} before fallback expected un-offloaded image`);
          yield { type: 'finish', kind: 'error', failure: { code: 'IMAGE_OFFLOAD_REQUIRED', message: 'still too many', offloadImages: 1 } };
          return;
        }
        assert.equal(hasRawImages, false, '4th call (after 2 offload rounds) must strip remaining images in-memory');
        assert.ok(req.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => typeof b.text === 'string' && b.text.includes('Image omitted for summary'))));
        yield { type: 'text-delta', text: makeSummary('Converged after 2 offload rounds.') };
        yield { type: 'finish', kind: 'stop', usage: { inputTokens: 90, outputTokens: 50 } };
      },
    });
    f.ctx.on('compaction/summary-error', ({ session, sourceEventSeqs, error }, next) => {
      if (error?.code !== 'IMAGE_OFFLOAD_REQUIRED') return next();
      for (const s of sourceEventSeqs) {
        const msg = session.deriveEventMessage(session.eventAt(s));
        const pos = msg?.content?.findIndex?.((b) => b.type === 'image' && !b.offloaded) ?? -1;
        if (pos >= 0) {
          let imgIdx = 0;
          for (let k = 0; k < pos; k += 1) if (msg.content[k]?.type === 'image') imgIdx += 1;
          session.append('image/offload', { targets: [{ seq: s, imageIndexes: [imgIdx] }] });
          return true;
        }
      }
      return next();
    });

    f.addSystem('Sys.');
    const u1 = f.addUser([
      { type: 'text', text: 'Always verify outputs. ' + 'pad '.repeat(400) },
      f.registerImageBlock('c1'),
      f.registerImageBlock('c2'),
      f.registerImageBlock('c3'),
    ]);
    const a1 = f.addAssistant('Working through items '.repeat(600));
    const uTail = f.addUser('latest turn');

    const res = await f.engine._compactSpan(u1.seq, a1.seq, f.agent, new AbortController().signal, {
      manual: true,
      policy: f.engine.config,
    }, 0);
    assert.ok(res);
    assert.equal(calls, 4, 'initial + 2 native offload retries + 1 stripped retry');
    // Original raw event u1 keeps ALL 3 un-offloaded original image blocks untouched in session history
    assert.equal(f.events[u1.seq].data.content.filter((b) => b.type === 'image' && !b.offloaded).length, 3);
    assert.ok(f.session.surface.nodes.includes(uTail.seq));
    assert.equal(f.engine._failures.size, 0);
  } finally {
    await rm(rootA, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }

  // Subcase B: Upstream multimodal 400 (2000px edge / too many images) converges via in-memory stripImagesForSummary
  const rootB = await mkdtemp(join(TEST_BASE, 'weave-mm-400-'));
  try {
    let calls = 0;
    const f = makeSurfaceFixture({
      root: rootB,
      streamImpl: async function* (req) {
        calls += 1;
        if (calls === 1) {
          const err = new Error('HTTP 400: image dimensions exceed max allowed size for many-image requests: 2000 pixels');
          err.status = 400;
          throw err;
        }
        assert.equal(req.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image')), false);
        yield { type: 'text-delta', text: makeSummary('Recovered after upstream 400 image rejection.') };
        yield { type: 'finish', kind: 'stop', usage: { inputTokens: 80, outputTokens: 50 } };
      },
    });
    f.addSystem('Sys.');
    const u1 = f.addUser([
      { type: 'text', text: 'Keep image specs exact. ' + 'note '.repeat(400) },
      f.registerImageBlock('long-shot', { bytes: 200000, width: 390, height: 2475 }),
    ]);
    const a1 = f.addAssistant('Analysis complete. '.repeat(600));
    const uTail = f.addUser('next');

    const res = await f.engine._compactSpan(u1.seq, a1.seq, f.agent, new AbortController().signal, {
      manual: true,
      policy: f.engine.config,
    }, 0);
    assert.ok(res);
    assert.equal(calls, 2);
    assert.equal(f.events[u1.seq].data.content[1].type, 'image', 'raw event image preserved intact');
    assert.ok(f.session.surface.nodes.includes(uTail.seq));
  } finally {
    await rm(rootB, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

await test('continuation-renders-image-metadata-and-strips-on-multimodal-failure', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-mm-cont-'));
  try {
    const requestsSeen = [];
    const sessionId = `sess-cont-${randomUUID()}`;
    const events = [
      { seq: 0, type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'Sys' }] } } },
      {
        seq: 1,
        type: 'user/message',
        data: {
          id: 'u1',
          role: 'user',
          content: [
            { type: 'text', text: 'Must never delete backups. ' + 'long detail '.repeat(150) },
            {
              type: 'image',
              attachment: {
                attachmentId: `sha256:${'a'.repeat(64)}`,
                mediaType: 'image/png',
                width: 390,
                height: 2475,
                bytes: 312000,
                name: 'tall.png',
              },
            },
          ],
          source: { kind: 'user' },
        },
      },
      {
        seq: 2,
        type: 'assistant/message',
        data: { message: { role: 'assistant', content: [{ type: 'text', text: 'work note '.repeat(150) }], source: { kind: 'model', provider: 'p', model: 'm' } } },
      },
    ];
    const session = {
      id: sessionId,
      surface: { nodes: [0, 1, 2], replaceGeneration: 0 },
      eventAt: (s) => events[s],
      deriveEventMessage: (e) => (e?.type === 'user/message' ? e.data : e?.data?.message),
    };
    const contText = ['## Goal', 'Finish task.', '## State', 'Must never delete backups (seq 1).', '## Next', 'Verify.', '## Uncertain', 'None.'].join('\n');
    const ctx = {
      llm: {
        async *stream(req) {
          requestsSeen.push(req);
          if (requestsSeen.length === 1) {
            const err = new Error('HTTP 400: image dimensions exceed 2000 pixels');
            err.status = 400;
            throw err;
          }
          yield { type: 'text-delta', text: contText };
          yield { type: 'finish', kind: 'stop', usage: { inputTokens: 100, outputTokens: 60 } };
        },
      },
    };
    const { config } = resolveConfig({
      archiveDir: join(root, 'archive'),
      language: 'en',
      summaryRetryCount: 0,
      summaryRetryDelayMs: 0,
      maxSummaryChunks: 16,
      continuationMemoryBytes: 4096,
    });
    const prepared = await prepareContinuation({
      ctx,
      agent: { session, options: { provider: 'p', model: 'm' } },
      session,
      seqs: [1, 2],
      policy: config,
      capacity: { targets: [{ key: JSON.stringify(['p', 'm']), window: 32000, output: 4096, margin: 0, inputRatio: 1, maxInputBytes: 24000, scale: 1 }], shrinkLimit: Infinity },
      chain: { targets: [{ provider: 'p', model: 'm' }], source: 'test' },
      compactionId: 'cmp-cont-img',
      signal: new AbortController().signal,
      archiveRoot: join(root, 'archive'),
      checkpointBudgetTokens: 12000,
      estimateCheckpointTokens: (blocks) => approxTokens(blocksToText(blocks)),
      shadowedTokenCount: 20000,
      shadowedCanonicalBytes: 80000,
    });

    assert.ok(prepared?.summarized?.rawText);
    assert.equal(requestsSeen.length, 2);
    const reqJson = JSON.stringify(requestsSeen[0].messages);
    assert.ok(reqJson.includes('dimensions=390x2475'));
    assert.ok(reqJson.includes('bytes=312000'));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

await test('2a-hysteresis-batch-offload-session-memory-contentGeneration-and-callsUsed-isolation', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-mm-2a-'));
  try {
    const f = makeSurfaceFixture({
      root,
      withNativeImageProjection: true,
      extraConfig: {
        sessionMemoryEnabled: true,
        sessionMemoryMaxCallsPerSession: 8,
        maxVisibleImages: 24,
        maxVisibleAttachmentBytes: 16 * 1024 * 1024,
      },
    });
    f.addSystem('System.');
    const seedSeqs = [];
    // Add 25 low-token, high-byte images including 390x2475 across user/message & tool/result
    for (let i = 0; i < 25; i += 1) {
      const img = f.registerImageBlock(`batch-${i}`, {
        bytes: 400 * 1024, // 25 * 400KB = 10 MiB (< 16 MiB), triggering count >= 24 + tall edge >= 20
        width: i === 5 ? 390 : 800,
        height: i === 5 ? 2475 : 600,
      });
      if (i % 2 === 0) {
        seedSeqs.push(f.addUser([{ type: 'text', text: `u${i}` }, img]).seq);
      } else {
        const a = f.addAssistant('call tool', [{ id: `c-${i}`, name: 'view_img' }]);
        const tc = f.addToolCall(`c-${i}`, 'view_img');
        seedSeqs.push(a.seq);
        seedSeqs.push(f.addToolResult(`c-${i}`, [img, { type: 'text', text: 'ok' }], [tc.seq]).seq);
      }
    }

    // Seed SessionMemoryStore with callsUsed=3 and saved memory + matching live inFlight entry
    const store = f.engine.sessionMemory._store();
    const candidateSeqs = seedSeqs.slice(0, 6);
    const sourceHash = computeSessionMemorySourceHash(f.session, candidateSeqs);
    const policyFp = computeSessionMemoryPolicyFingerprint(f.engine.config);
    store.recordAttempt(f.session.id, { maxCalls: 8, memory: null });
    store.recordAttempt(f.session.id, { maxCalls: 8, memory: null });
    store.recordAttempt(f.session.id, {
      maxCalls: 8,
      memory: {
        sourceHash,
        policyFingerprint: policyFp,
        coveredSeqs: candidateSeqs,
        coveredThroughSeq: candidateSeqs.at(-1),
        range: { start: candidateSeqs[0], end: candidateSeqs.at(-1) },
        rawText: makeSummary('Old cached memory'),
        language: 'en',
        updatedAt: new Date().toISOString(),
      },
    });
    assert.equal(store.read(f.session.id).callsUsed, 3);

    // Put a synthetic in-flight task with pre-offload contentGeneration
    let resolveInFlight;
    const inFlightEntry = {
      controller: new AbortController(),
      promise: new Promise((r) => { resolveInFlight = r; }),
      cleared: false,
      session: f.session,
      policyFingerprint: policyFp,
      coveredSeqs: candidateSeqs,
      startSeq: candidateSeqs[0],
      coveredThroughSeq: candidateSeqs.at(-1),
      surfaceGeneration: f.session.surface.replaceGeneration,
      contentGeneration: f.session.surface.contentGeneration,
    };
    f.engine.sessionMemory.inFlight.set(f.session.id, inFlightEntry);

    const replaceGenBefore = f.session.surface.replaceGeneration;
    const contentGenBefore = f.session.surface.contentGeneration;

    // Trigger 2A pre-step gate (or direct _guardVisibleImageBudget)
    const committed = await f.engine._guardVisibleImageBudget(f.agent, new AbortController().signal);
    assert.ok(committed);
    assert.equal(committed.mode, 'image-offload');
    assert.equal(committed.offloadCount, 25 - DEFAULT_KEEP_HOT_IMAGES);
    assert.equal(committed.remainingCount, DEFAULT_KEEP_HOT_IMAGES);

    // Only ONE batch `image/offload` event, ZERO `user/message` `surfaceOp: replace`!
    const offloadEvents = f.events.filter((e) => e.type === 'image/offload');
    assert.equal(offloadEvents.length, 1);
    const userReplaceEvents = f.events.filter((e) => e.type === 'user/message' && e.surfaceOp && e.surfaceOp !== 'append');
    assert.equal(userReplaceEvents.length, 0, 'MUST NEVER use surfaceOp: replace on user/message');

    // Visible images strictly reduced to 6 hot images
    const afterStats = measureVisibleImages(f.session);
    assert.equal(afterStats.visibleImageCount, 6);
    assert.equal(f.session.surface.replaceGeneration, replaceGenBefore, 'image/offload keeps replaceGeneration untouched');
    assert.equal(f.session.surface.contentGeneration, contentGenBefore + 1, 'image/offload increments contentGeneration');

    // SessionMemory cache cleared, BUT callsUsed stays 3 (never reset by 0-LLM 2A offload!)
    const afterMem = store.read(f.session.id);
    assert.equal(afterMem.memory, null, 'cached session memory invalidated');
    assert.equal(afterMem.callsUsed, 3, '0-LLM image offload MUST NOT reset callsUsed billing fuse');

    // Old inFlight entry captured old contentGeneration -> waitForWithin MUST reject reuse!
    // Re-attach simulated non-cleared inFlight entry to verify contentGeneration check directly
    f.engine.sessionMemory.inFlight.set(f.session.id, { ...inFlightEntry, cleared: false, controller: new AbortController() });
    const waitOutcome = await f.engine.sessionMemory.waitForWithin(f.session.id, { timeoutMs: 2000, session: f.session });
    assert.equal(waitOutcome.status, 'incompatible');
    assert.equal(waitOutcome.reason, 'surface-generation-mismatch');
    f.engine.sessionMemory.inFlight.delete(f.session.id);
    resolveInFlight({ ok: true });

    // Next turn adds 1 new image (6 + 1 = 7) -> hysteresis keeps cache intact (NO per-turn offload!)
    f.addUser([{ type: 'text', text: 'turn with 7th hot image' }, f.registerImageBlock('hot-7', { bytes: 200 * 1024, width: 800, height: 600 })]);
    const secondPass = await f.engine._guardVisibleImageBudget(f.agent, new AbortController().signal);
    assert.equal(secondPass, null, 'hysteresis must not evict on every turn below high watermark');
    assert.equal(f.events.filter((e) => e.type === 'image/offload').length, 1);

    // Test byte-trigger hysteresis too: newest 3 images = 400KB + 400KB + 200KB = 1,024,000 B <= 1 MiB low watermark
    f.engine.config = resolveConfig({
      archiveDir: join(root, 'archive'),
      maxVisibleAttachmentBytes: 2 * 1024 * 1024,
      maxVisibleImages: 0,
    }).config;
    const bytePlan = planVisibleImageOffload(f.session, {
      maxVisibleAttachmentBytes: 2 * 1024 * 1024,
      maxVisibleImages: 0,
    });
    assert.ok(bytePlan);
    assert.equal(bytePlan.reason, 'visible_bytes');
    assert.equal(bytePlan.remainingCount, 3, `2*400KB + 1*200KB = 1000KB <= 1 MiB, kept ${bytePlan.remainingCount}`);
    const afterByteEntries = measureVisibleImages(f.session).entries.slice(-bytePlan.remainingCount);
    const remainingBytes = afterByteEntries.reduce((sum, item) => sum + item.bytes, 0);
    assert.ok(remainingBytes <= 1024 * 1024, `kept bytes ${remainingBytes} must not exceed 1 MiB low watermark`);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

await test('2a-host-without-imageOffloadProjection-fails-open-user-message-and-stubs-tool-result', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-mm-no-proj-'));
  try {
    const f = makeSurfaceFixture({
      root,
      withNativeImageProjection: false,
      openTurn: 1,
      extraConfig: { maxVisibleImages: 8, maxVisibleAttachmentBytes: 16 * 1024 * 1024 },
    });
    f.addSystem('System.');
    const userImgEv = f.addUser([{ type: 'text', text: 'user photo' }, f.registerImageBlock('u-keep')]);
    f.addAssistant('inspect', [{ id: 'c-tool-1', name: 'snap' }, { id: 'c-tool-2', name: 'snap' }]);
    const tc1 = f.addToolCall('c-tool-1', 'snap');
    const tc2 = f.addToolCall('c-tool-2', 'snap');
    const tr1 = f.addToolResult('c-tool-1', [f.registerImageBlock('t-old-1'), { type: 'text', text: 't1' }], [tc1.seq]);
    const tr2 = f.addToolResult('c-tool-2', [f.registerImageBlock('t-old-2'), { type: 'text', text: 't2' }], [tc2.seq]);
    // 6 newest user images keep total count = 9 (>= 8), so 3 oldest (u-keep, t-old-1, t-old-2) selected to offload
    for (let i = 0; i < 6; i += 1) {
      f.addUser([{ type: 'text', text: `recent-${i}` }, f.registerImageBlock(`hot-${i}`)]);
    }

    const res = await f.engine._guardVisibleImageBudget(f.agent, new AbortController().signal);
    assert.ok(res);
    assert.equal(res.mode, 'tool-result-image-stub');
    assert.equal(res.offloadCount, 2);

    // user/message NEVER replaced with surfaceOp: replace!
    assert.ok(f.session.surface.nodes.includes(userImgEv.seq), 'user/message image event must remain untouched on fail-open');
    assert.equal(f.events.some((e) => e.type === 'user/message' && e.surfaceOp && e.surfaceOp !== 'append'), false);
    assert.equal(f.events.some((e) => e.type === 'image/offload'), false, 'failed projection must not pollute log');

    // Old tool/result nodes replaced via archive + surfaceOp: replace stub
    assert.equal(f.session.surface.nodes.includes(tr1.seq), false);
    assert.equal(f.session.surface.nodes.includes(tr2.seq), false);
    const archivedSpan = await f.engine.archive.readSpan(f.session.id, res.compactionId);
    assert.equal(archivedSpan.ok, true);
    assert.equal(archivedSpan.entries.filter((e) => e.type === 'tool/result').length, 2);
    assert.equal(archivedSpan.entries.length, 4);

    // When openTurn === null, even tool/result replacement refuses and fails open cleanly
    f.session.append('turn/end', { turn: 1 });
    const fClosed = makeSurfaceFixture({
      root,
      withNativeImageProjection: false,
      openTurn: null,
      extraConfig: { maxVisibleImages: 2 },
    });
    fClosed.addSystem('Sys');
    fClosed.addAssistant('c', [{ id: 'tc-c', name: 'x' }]);
    const tcc = fClosed.addToolCall('tc-c', 'x');
    fClosed.addToolResult('tc-c', [fClosed.registerImageBlock('z1'), fClosed.registerImageBlock('z2')], [tcc.seq]);
    assert.equal(await fClosed.engine._guardVisibleImageBudget(fClosed.agent, new AbortController().signal), null);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

await test('agent-request-error-multimodal-400-rescue-and-bili-413-redline', async () => {
  // Case A: upstream multimodal 400 triggers 2A offload and returns { kind: 'retry' }
  const rootA = await mkdtemp(join(TEST_BASE, 'weave-mm-req400-'));
  try {
    const f = makeSurfaceFixture({ root: rootA, withNativeImageProjection: true });
    f.addSystem('Sys');
    f.addUser([{ type: 'text', text: 'first' }, f.registerImageBlock('r1', { width: 390, height: 2475 })]);
    f.addUser([{ type: 'text', text: 'second' }, f.registerImageBlock('r2', { width: 390, height: 2475 })]);

    const multimodal400 = Object.assign(
      new Error('HTTP 400: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels'),
      { status: 400 },
    );
    assert.equal(isUpstreamMultimodal400Error(multimodal400), true);
    const outcome = await f.runWaterfall(
      'agent/request-error',
      { agent: f.agent, failure: multimodal400, signal: new AbortController().signal },
      () => ({ kind: 'unhandled' }),
    );
    assert.deepEqual(outcome, { kind: 'retry' });
    assert.equal(f.events.filter((e) => e.type === 'image/offload').length, 1);
    assert.ok(measureVisibleImages(f.session).visibleImageCount < 2);
  } finally {
    await rm(rootA, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }

  // Case B: bili local proxy 413 preflight error NEVER enters multimodal retry / 2A / Snip even with 25 images
  const rootB = await mkdtemp(join(TEST_BASE, 'weave-mm-bili413-'));
  try {
    const f = makeSurfaceFixture({ root: rootB, withNativeImageProjection: true });
    f.addSystem('Sys');
    for (let i = 0; i < 10; i += 1) {
      f.addUser([{ type: 'text', text: `img ${i}` }, f.registerImageBlock(`bili-${i}`, { width: 390, height: 2475 })]);
    }
    const bili413 = Object.assign(
      new Error('413 preflight_compress_failed: payload core text alone is larger than window; image dimensions 2000 pixels'),
      { status: 413 },
    );
    assert.equal(isUpstreamMultimodal400Error(bili413), false, 'bili 413 MUST NEVER classify as multimodal 400');
    assert.equal(isImageOffloadRequiredError(bili413), false);

    await assert.rejects(
      f.runWaterfall(
        'agent/request-error',
        { agent: f.agent, failure: bili413, signal: new AbortController().signal },
        () => undefined,
      ),
      (err) => err?.code === 'BILI_PROXY_CONFLICT',
    );
    assert.equal(f.events.filter((e) => e.type === 'image/offload').length, 0, 'bili 413 must emit 0 image/offload events');
  } finally {
    await rm(rootB, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

await test('config-normalizers-summary-config-persistence-and-client-controls', async () => {
  assert.equal(DEFAULT_MAX_VISIBLE_ATTACHMENT_BYTES, 16 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_VISIBLE_IMAGES, 24);
  assert.equal(normalizeMaxVisibleAttachmentBytes(0), 0);
  assert.equal(normalizeMaxVisibleImages(0), 0);
  assert.throws(() => normalizeMaxVisibleAttachmentBytes(-1));
  assert.throws(() => normalizeMaxVisibleImages(501));

  const root = await mkdtemp(join(TEST_BASE, 'weave-mm-cfg-'));
  try {
    const file = join(root, 'summary-config.json');
    const setRes = await handleSummaryConfigRpc(
      {
        method: 'set',
        params: {
          provider: 'p',
          model: 'm',
          maxVisibleAttachmentBytes: 8 * 1024 * 1024,
          maxVisibleImages: 12,
        },
      },
      file,
    );
    assert.equal(setRes.config.maxVisibleAttachmentBytes, 8 * 1024 * 1024);
    assert.equal(setRes.config.maxVisibleImages, 12);

    const gotAfterSet = await handleSummaryConfigRpc({ method: 'get' }, file);
    assert.equal(gotAfterSet.config.maxVisibleAttachmentBytes, 8 * 1024 * 1024);
    assert.equal(gotAfterSet.config.maxVisibleImages, 12);

    // Clearing model override preserves image budget hot settings
    const clearRes = await handleSummaryConfigRpc(
      { method: 'set', params: { provider: '', model: '' } },
      file,
    );
    assert.equal(clearRes.cleared, false);
    assert.equal(clearRes.config.maxVisibleAttachmentBytes, 8 * 1024 * 1024);
    assert.equal(clearRes.config.maxVisibleImages, 12);
    assert.equal(clearRes.restartRequired, false);

    const gotAfterClear = await handleSummaryConfigRpc({ method: 'get' }, file);
    assert.equal(gotAfterClear.config.maxVisibleAttachmentBytes, 8 * 1024 * 1024);
    assert.equal(gotAfterClear.config.maxVisibleImages, 12);

    // Disable with 0
    const offRes = await handleSummaryConfigRpc(
      {
        method: 'set',
        params: { provider: '', model: '', maxVisibleAttachmentBytes: 0, maxVisibleImages: 0 },
      },
      file,
    );
    assert.equal(offRes.config.maxVisibleAttachmentBytes, 0);
    assert.equal(offRes.config.maxVisibleImages, 0);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }

  assert.ok(clientSource.includes('weave-max-visible-attachment-mb'));
  assert.ok(clientSource.includes('weave-max-visible-images'));
});

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
console.log(JSON.stringify({ passed, failed, results }, null, 2));
if (failed > 0) process.exitCode = 1;
