import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateSummaryStructure,
  materializeUserMessageSection,
  summaryProse,
  unwrapJsonSectionMap,
} from '../lib/validate.js';
import {
  DEFAULT_MIN_PROSE_HEADROOM_BYTES,
  buildSummaryRequest,
  measureSummaryRange,
  planSummaryRange,
} from '../lib/summary-budget.js';
import {
  SessionBackupStore,
  createSessionBackup,
  summarizeBackups,
  restoreSessionBackup,
} from '../lib/session-backup.js';
import { apply as mountGate } from '../lib/index.js';
import { apply as mountEngine } from '../lib/engine-entry.js';
import { decorateCompactCommand } from '../lib/command-compact.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { buildCompactionInstruction } from '../lib/prompt.js';
import { detectBiliSession } from '../lib/foreign-fold.js';

const results = [];
async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, pass: true, ms: Date.now() - started });
  } catch (error) {
    results.push({ name, pass: false, ms: Date.now() - started, error: error.message, stack: error.stack });
  }
}

const EN_HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeEnSummary(bodyNote = 'Archived progress; continuing task.') {
  return EN_HEADINGS.map((h, idx) =>
    `${h}\n${idx === 5 ? '[filled by engine]' : idx === 8 ? bodyNote : 'Concise summary.'}`,
  ).join('\n\n');
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function makeSessionFixture({ id = `sess-${randomUUID()}`, sessionDir, rawFilename = 'session.v4.jsonl.zstd' } = {}) {
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const logPath = sessionDir ? join(sessionDir, rawFilename) : null;
  if (sessionDir && logPath) {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      logPath,
      Buffer.concat([
        Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
        Buffer.from(`{"version":4,"id":"${id}","init":true}\n`, 'utf8'),
      ]),
    );
  }
  const session = {
    id,
    header: { version: 4, id, createdAt: Date.now() },
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
      if (event.type === 'system/message') return event.data?.message ?? event.data;
      if (event.type === 'user/message') return event.data;
      if (event.type === 'assistant/message') return event.data?.message;
      if (event.type === 'tool/result') {
        const msg = event.data?.message ?? event.data;
        if (!msg) return undefined;
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
        time: Date.now(),
        type,
        data,
        ...(Array.isArray(options.sourceEventSeqs) ? { sourceEventSeqs: [...options.sourceEventSeqs] } : {}),
      };
      events.push(event);
      const op = options.surfaceOp;
      if (op?.op === 'replace') {
        const a = surface.nodes.indexOf(op.startSeq);
        const b = surface.nodes.indexOf(op.endSeq);
        assert.ok(a >= 0 && b >= a, `invalid replace ${op.startSeq}..${op.endSeq}`);
        surface.nodes.splice(a, b - a + 1, event.seq);
        surface.replaceGeneration += 1;
      } else if (op === 'append') {
        surface.nodes.push(event.seq);
      }
      return event;
    },
  };

  const addSystem = (text) =>
    session.append(
      'system/message',
      { message: { id: randomUUID(), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } } },
      { surfaceOp: 'append' },
    );

  const addUser = (text, source = { kind: 'user' }) =>
    session.append(
      'user/message',
      { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source },
      { surfaceOp: 'append' },
    );

  const addAssistant = (text, toolCalls = []) =>
    session.append(
      'assistant/message',
      {
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [...(text ? [{ type: 'text', text }] : []), ...toolCalls],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
      { surfaceOp: 'append' },
    );

  const addToolPair = (toolName, args, outputText, { callId = `call-${randomUUID()}` } = {}) => {
    const callEvent = session.append('tool/call', { callId, name: toolName, arguments: JSON.stringify(args) });
    const assistantEvent = addAssistant('', [{ type: 'tool-call', id: callId, callId, name: toolName, toolName, arguments: args, args }]);
    const resultEvent = session.append(
      'tool/result',
      {
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: callId,
          content: [{ type: 'text', text: outputText }],
          source: { kind: 'tool-result', callId },
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] },
    );
    return { callEvent, assistantEvent, resultEvent, callId };
  };

  return { session, events, surface, logPath, addSystem, addUser, addAssistant, addToolPair };
}

function makeHostFixture({ home, windowTokens = 120000, extraEngineConfig = {}, streamHandler } = {}) {
  const sessionsMap = new Map();
  const writersMap = new Map();
  const logPathsById = new Map();
  const services = new Map();
  const pendingInjects = [];
  const calls = [];
  let registeredRoute = null;

  const registerSession = (fixtureObj) => {
    sessionsMap.set(fixtureObj.session.id, fixtureObj.session);
    if (fixtureObj.logPath) logPathsById.set(fixtureObj.session.id, fixtureObj.logPath);
  };

  const backend = {
    tracker: {
      writers: writersMap,
      claims: new Set(),
      claimWrite(id) {
        if (this.claims.has(id)) throw new Error('already claimed');
        this.claims.add(id);
      },
      releaseClaim(id) {
        this.claims.delete(id);
      },
    },
    coldLogMemo: new Map(),
    locate(header) {
      const p = logPathsById.get(header?.id);
      return p ? { kind: 'jsonl', path: p } : null;
    },
    async findLog(id) {
      const p = logPathsById.get(id);
      return p && existsSync(p) ? { sourcePath: p, currentPath: p } : null;
    },
    async stat(id) {
      const p = logPathsById.get(id);
      return p ? { location: { kind: 'jsonl', path: p } } : null;
    },
    async acquireLease() {
      return { async release() {} };
    },
  };

  const sessions = {
    get: (id) => sessionsMap.get(id),
    async flush(session) {
      const logPath = logPathsById.get(session?.id);
      if (logPath && session) {
        const prefix = logPath.endsWith('.zstd') ? Buffer.from([0x28, 0xb5, 0x2f, 0xfd]) : Buffer.alloc(0);
        const body = Buffer.from(
          JSON.stringify({ version: 4, id: session.id, seq: session.seq, nodes: session.surface?.nodes ?? [] }) + '\n',
          'utf8',
        );
        writeFileSync(logPath, Buffer.concat([prefix, body]));
      }
      return true;
    },
  };

  const llm = {
    listProviders: () => [{ id: 'p', name: 'Provider P' }],
    listModels: async () => [{ id: 'm', name: 'Model M' }],
    async resolveModelInfo() {
      return { contextWindow: windowTokens, defaultMaxTokens: 8192 };
    },
    async *stream(opts) {
      calls.push(opts);
      if (typeof streamHandler === 'function') {
        yield* streamHandler(opts, calls.length);
        return;
      }
      yield { type: 'text-delta', text: makeEnSummary() };
      yield { type: 'finish', kind: 'stop' };
    },
  };

  const tokenMeter = {
    estimateMessage: (msg) => approxTokens(blocksToText(msg?.content)),
    measure: (session) => {
      const nodes = (session.surface?.nodes ?? []).map((seq) => {
        const msg = session.deriveEventMessage(session.eventAt(seq));
        return { seq, tokens: approxTokens(blocksToText(msg?.content)) };
      });
      return { nodes, totalTokens: nodes.reduce((sum, n) => sum + n.tokens, 0) };
    },
  };

  const webServer = {
    register(route) {
      registeredRoute = route;
      return () => {
        if (registeredRoute === route) registeredRoute = null;
      };
    },
  };

  services.set('sessions', sessions);
  services.set('sessionPersistence', backend);
  services.set('llm', llm);
  services.set('tokenMeter', tokenMeter);
  services.set('webServer', webServer);
  services.set('connection', { requestRejection: () => undefined });

  const tryDeliverInjects = () => {
    for (let i = pendingInjects.length - 1; i >= 0; i -= 1) {
      const item = pendingInjects[i];
      if (item.deps.every((d) => services.has(d))) {
        pendingInjects.splice(i, 1);
        item.fn(makeCtx());
      }
    }
  };

  const makeCtx = () => ({
    logger: { info() {}, warn() {} },
    effect(cb) {
      const d = cb();
      return typeof d === 'function' ? d : () => {};
    },
    on() {
      return () => {};
    },
    provide(name, value) {
      services.set(name, value);
      tryDeliverInjects();
    },
    get(name) {
      return services.get(name);
    },
    inject(deps, fn) {
      if (deps.every((d) => services.has(d))) return fn(makeCtx());
      pendingInjects.push({ deps, fn });
      return () => {};
    },
    get sessions() { return services.get('sessions'); },
    get sessionPersistence() { return services.get('sessionPersistence'); },
    get llm() { return services.get('llm'); },
    get tokenMeter() { return services.get('tokenMeter'); },
    get webServer() { return services.get('webServer'); },
    get connection() { return services.get('connection'); },
    get compactionWeaveRuntime() { return services.get('compactionWeaveRuntime'); },
    get compactionWeaveTransactions() { return services.get('compactionWeaveTransactions'); },
  });

  const priorHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const archiveDir = join(home, 'storages', 'dsh-compaction-weave', 'sessions');
  const disposeGate = mountGate(makeCtx(), {
    engine: { archiveDir, ...extraEngineConfig },
    receiptPath: join(home, 'storages', 'dsh-compaction-weave', 'gate-receipts.jsonl'),
  });
  const disposeEngine = mountEngine(makeCtx(), { archiveDir, ...extraEngineConfig });
  const engine = services.get('compaction');
  engine.historyToolsAvailable = true;

  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const req = new EventEmitter();
      req.method = 'POST';
      req.socket = { remoteAddress: '127.0.0.1' };
      req.headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' };
      req.destroy = () => {};
      const res = {
        statusCode: 0,
        setHeader() {},
        end(text) {
          resolve({ status: this.statusCode, body: JSON.parse(text) });
        },
      };
      const done = registeredRoute.handler(req, res);
      req.emit('data', Buffer.from(JSON.stringify(params === undefined ? { method } : { method, params })));
      req.emit('end');
      Promise.resolve(done).catch(reject);
    });

  const cleanup = () => {
    disposeEngine?.();
    disposeGate?.();
    if (priorHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = priorHome;
  };

  return { engine, sessions, sessionsMap, writersMap, backend, calls, registerSession, rpc, cleanup };
}

// 1. Bilingual + natural Chinese 9-section heading validation (real DeepSeek Flash failure)
await test('bilingual-natural-zh-headings-accepted-and-arbitrary-rejected', async () => {
  const realDeepSeekFlashZh = [
    '## 1. 主要请求与意图',
    '- 修复线上上下文迁移与进度条显示。',
    '## 2. 关键技术概念',
    '- DSH V4 事务提交与压缩检查点。',
    '## 3. 文件与代码段',
    '- lib/validate.js 与 lib/engine.js',
    '## 4. 错误与修复',
    '- 解决中文九节标题在英文检测下误拒的问题。',
    '## 5. 问题解决',
    '- 维护白名单变体并保持严格顺序与防重复。',
    '## 6. 所有用户消息',
    '[由引擎填充]',
    '## 7. 待办任务',
    '- 运行完整测试套件。',
    '## 8. 已完成工作',
    '- 完成双语标题白名单实现。',
    '## 9. 继续工作上下文',
    '- 保持 listenPort: 9443 不变。',
  ].join('\n\n');

  // Accepted regardless of options.language ('en' or 'zh')
  assert.equal(validateSummaryStructure(realDeepSeekFlashZh, { language: 'en' }).ok, true);
  assert.equal(validateSummaryStructure(realDeepSeekFlashZh, { language: 'zh' }).ok, true);

  // materializeUserMessageSection and summaryProse work seamlessly even with language='en'
  const expected = [{ seq: 2, text: 'Keep listenPort: 9443 and never drop backup.' }];
  const materialized = materializeUserMessageSection(realDeepSeekFlashZh, expected, 'en');
  assert.ok(materialized.includes('Keep listenPort: 9443 and never drop backup.'));
  assert.equal(validateSummaryStructure(materialized, { language: 'en' }).ok, true);
  const prose = summaryProse(materialized);
  assert.ok(!prose.includes('### User message 1 (seq 2)'), 'summaryProse must strip natural Chinese Section 6');
  assert.ok(prose.includes('## 7. 待办任务'));

  // Additional natural curated variants pass
  const altVariants = realDeepSeekFlashZh
    .replace('## 1. 主要请求与意图', '## 1. 用户核心请求与意图')
    .replace('## 9. 继续工作上下文', '## 9. 继续工作所需的上下文');
  assert.equal(validateSummaryStructure(altVariants, { language: 'en' }).ok, true);
  assert.equal(
    validateSummaryStructure(altVariants.replace('## 1. 用户核心请求与意图', '## 1. 核心请求与意图'), { language: 'en' }).ok,
    true,
  );

  // JSON section map with natural Chinese headings unwraps even under language='en'
  const jsonMap = JSON.stringify({
    '## 1. 主要请求与意图': '修复迁移。',
    '## 2. 关键技术概念': '检查点。',
    '## 3. 文件与代码段': 'lib/validate.js',
    '## 4. 错误与修复': '无',
    '## 5. 问题解决': '已处理',
    '## 6. 所有用户消息': '[由引擎填充]',
    '## 7. 待办任务': '测试',
    '## 8. 已完成工作': '已完成',
    '## 9. 继续工作上下文': '继续',
  });
  const unwrapped = unwrapJsonSectionMap(jsonMap, { language: 'en' });
  assert.equal(validateSummaryStructure(unwrapped, { language: 'en' }).ok, true);

  // Strict structural rejections remain enforced!
  const garbageHeading = realDeepSeekFlashZh.replace('## 1. 主要请求与意图', '## 1. Foo');
  assert.equal(validateSummaryStructure(garbageHeading, { language: 'en' }).ok, false);
  assert.equal(validateSummaryStructure(garbageHeading, { language: 'zh' }).ok, false);

  const dupCrossLang = `${realDeepSeekFlashZh}\n\n## 1. Primary Request and Intent\ndup`;
  const dupVerdict = validateSummaryStructure(dupCrossLang, { language: 'en' });
  assert.equal(dupVerdict.ok, false);
  assert.match(dupVerdict.message, /repeats section/);

  const outOfOrder = realDeepSeekFlashZh
    .replace('## 2. 关键技术概念', '__TMP__')
    .replace('## 3. 文件与代码段', '## 2. 关键技术概念')
    .replace('__TMP__', '## 3. 文件与代码段');
  const orderVerdict = validateSummaryStructure(outOfOrder, { language: 'en' });
  assert.equal(orderVerdict.ok, false);
  assert.match(orderVerdict.message, /out of order/);

  const emptyFullWidthSec6 = realDeepSeekFlashZh.replace('[由引擎填充]', '（无）');
  assert.equal(validateSummaryStructure(emptyFullWidthSec6, { language: 'en' }).ok, false);

  const fencedSec1 = realDeepSeekFlashZh.replace('## 1. 主要请求与意图', '```md\n## 1. 主要请求与意图\n```');
  assert.equal(validateSummaryStructure(fencedSec1, { language: 'en' }).ok, false);

  // End-to-end engine run: code-heavy English chunk (language auto -> 'en') with Flash Chinese summary succeeds on attempt 1
  const home = await mkdtemp(join(tmpdir(), 'weave-live-bilingual-'));
  const host = makeHostFixture({
    home,
    extraEngineConfig: { language: 'auto', summaryRetryCount: 0, auditBlockOnLoss: false },
    streamHandler: async function* () {
      yield { type: 'text-delta', text: realDeepSeekFlashZh };
      yield { type: 'finish', kind: 'stop' };
    },
  });
  try {
    const s = makeSessionFixture({ sessionDir: join(home, 'sessions', 'bilingual') });
    s.addSystem('System.');
    s.addUser('Fix parser and keep listenPort: 9443.');
    s.addAssistant('```ts\n' + 'export const value = 1234567890;\n'.repeat(200) + '```');
    s.addUser('Continue.');
    host.registerSession(s);
    const agent = { session: s.session, options: { provider: 'p', model: 'm' }, runMaintenance: (fn) => fn(new AbortController().signal) };
    const res = await host.engine.compactNow(agent, new AbortController().signal);
    assert.ok(res?.compactionId);
    assert.equal(host.calls.length, 1, 'natural Chinese summary on code-heavy English-detected span must pass on 1st attempt');
  } finally {
    host.cleanup();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// 2. planSummaryRange prefers candidates with >= 2048 bytes prose headroom and falls back cleanly
await test('planSummaryRange-prefers-prose-headroom-with-tight-fallback', () => {
  assert.equal(DEFAULT_MIN_PROSE_HEADROOM_BYTES, 2048);

  // Case A: An earlier balanced end has >2048 headroom while a later end adds a big preserved user message
  // (plus workReport/progress) that shrinks headroom below 2048.
  const f = makeSessionFixture();
  f.addSystem('System.');
  const u1 = f.addUser('Short goal.');
  const a1 = f.addAssistant('detailed analysis '.repeat(300)); // ~5400 bytes -> large headroom!
  const mBefore = measureSummaryRange(f.session, { start: u1.seq, end: a1.seq }, { language: 'en' });
  assert.ok(mBefore.sourceBytes - mBefore.minimumCheckpointBytes > 2048);

  // Add a huge work report at the end whose structured rendering reduces net headroom while still keeping min < source.
  const hugeReportLine = 'Completed phase 1 verification: ' + 'detail-item-'.repeat(400) + ' 已完成全部检查。';
  const a2 = f.addAssistant(hugeReportLine);
  const mAfter = measureSummaryRange(f.session, { start: u1.seq, end: a2.seq }, { language: 'en' });

  const bigCap = {
    targets: [{ window: 1_000_000, output: 4096, margin: 4096, inputRatio: 1, maxInputBytes: 1_000_000, scale: 1 }],
    shrinkLimit: Infinity,
  };
  // Force a headroom threshold right between mAfter's headroom and mBefore's headroom if needed,
  // or verify with explicit minProseHeadroomBytes so test is deterministic regardless of wrapper size.
  const hrBefore = mBefore.sourceBytes - mBefore.minimumCheckpointBytes;
  const hrAfter = mAfter.sourceBytes - mAfter.minimumCheckpointBytes;
  if (hrBefore > hrAfter && hrAfter > 0) {
    const threshold = hrAfter + 10;
    const picked = planSummaryRange(
      f.session,
      { start: u1.seq, end: a2.seq },
      bigCap,
      { language: 'en', minProseHeadroomBytes: threshold },
    );
    assert.equal(picked.end, a1.seq, 'planner must prefer candidate with sufficient prose headroom over tight later end');
  }

  // Case B: Tight span with 0 < headroom < 2048 where NO candidate has >2048 headroom -> falls back instead of throwing
  const fTight = makeSessionFixture();
  fTight.addSystem('System.');
  const tu = fTight.addUser('Tight ask.');
  const ta = fTight.addAssistant('x'.repeat(1100));
  const mTight = measureSummaryRange(fTight.session, { start: tu.seq, end: ta.seq }, { language: 'en' });
  assert.ok(mTight.minimumCheckpointBytes < mTight.sourceBytes, 'fixture must be strictly shrinkable');
  assert.ok(mTight.minimumCheckpointBytes + 2048 >= mTight.sourceBytes, 'fixture headroom must be < 2048 bytes');
  const fallbackPlan = planSummaryRange(fTight.session, { start: tu.seq, end: ta.seq }, bigCap, { language: 'en' });
  assert.equal(fallbackPlan.end, ta.seq, 'must fall back to tight fitting span when no candidate has >=2048 headroom');
});

// 3. SUMMARY_NOT_SMALLER retry feedback delivers exact maxSummaryBytes so Attempt 2 succeeds
await test('summary-not-smaller-retry-feedback-includes-maxSummaryBytes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'weave-live-not-smaller-'));
  const observedRetryPrompts = [];
  const host = makeHostFixture({
    home,
    extraEngineConfig: { language: 'en', summaryRetryCount: 2, summaryRetryDelayMs: 0, auditBlockOnLoss: false, continuationEnabled: false },
    streamHandler: async function* (opts, callNumber) {
      const promptText = blocksToText(opts.messages.at(-1)?.content);
      observedRetryPrompts.push(promptText);
      if (callNumber === 1) {
        // Oversized valid 9-section summary that triggers SUMMARY_NOT_SMALLER
        yield { type: 'text-delta', text: makeEnSummary('Bloated note. '.repeat(600)) };
      } else {
        // Concise summary on Attempt 2 after seeing maxSummaryBytes budget
        yield { type: 'text-delta', text: makeEnSummary('Concise final note.') };
      }
      yield { type: 'finish', kind: 'stop' };
    },
  });
  try {
    const s = makeSessionFixture({ sessionDir: join(home, 'sessions', 'not-smaller') });
    s.addSystem('System.');
    s.addUser('Short request.');
    s.addAssistant('Work output line. '.repeat(220));
    s.addUser('Next.');
    host.registerSession(s);

    const agent = { session: s.session, options: { provider: 'p', model: 'm' }, runMaintenance: (fn) => fn(new AbortController().signal) };
    const res = await host.engine.compactNow(agent, new AbortController().signal);
    assert.ok(res?.compactionId);
    assert.equal(host.calls.length, 2, 'should recover on attempt 2 using size feedback');
    assert.match(observedRetryPrompts[1], /SIZE BUDGET CONSTRAINT:/);
    assert.match(observedRetryPrompts[1], /maxSummaryBytes=\d+/);
    assert.match(observedRetryPrompts[1], /reduce summary prose by at least \d+ UTF-8 bytes/);

    // Direct unit check on buildSummaryRequest size constraint injection
    const reqWithFeedback = buildSummaryRequest(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
      {
        language: 'en',
        repairFeedback: {
          code: 'SUMMARY_NOT_SMALLER',
          message: 'complete checkpoint is not smaller (maxSummaryBytes=420, reduce summary prose by at least 800 UTF-8 bytes)',
          issues: [],
        },
      },
    );
    const reqPrompt = blocksToText(reqWithFeedback.messages.at(-1).content);
    assert.match(reqPrompt, /SIZE BUDGET CONSTRAINT:.*maxSummaryBytes=420/);
  } finally {
    host.cleanup();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// 4. migrateBiliSession (proxy-raw-rolling) retains unshrinkable non-bili tail cleanly once all bili nodes are cleared
await test('migrate-bili-retains-unshrinkable-non-bili-tail-after-bili-cleared', async () => {
  const home = await mkdtemp(join(tmpdir(), 'weave-live-bili-tail-'));
  let streamIndex = 0;
  const host = makeHostFixture({
    home,
    windowTokens: 120000,
    extraEngineConfig: {
      language: 'en',
      summaryInputMaxBytes: 36000,
      summaryRetryCount: 0,
      continuationEnabled: false,
      auditBlockOnLoss: false,
    },
    streamHandler: async function* () {
      streamIndex += 1;
      if (streamIndex === 1) {
        // Chunk 1 compacts the bili tool nodes cleanly
        yield { type: 'text-delta', text: makeEnSummary('Compacted bili tools cleanly.') };
      } else {
        // Final remaining non-bili tail: summary is larger than the small tail -> SUMMARY_NOT_SMALLER
        yield { type: 'text-delta', text: makeEnSummary('Verbose tail summary '.repeat(400)) };
      }
      yield { type: 'finish', kind: 'stop' };
    },
  });
  try {
    const s = makeSessionFixture({ sessionDir: join(home, 'sessions', 'bili-tail') });
    s.addSystem('System.');
    s.addUser('Keep production safe.');
    s.addToolPair('acp_status', {}, '[ACP] acp_status result: ok\n' + 'status-payload '.repeat(1200));
    // Single large assistant message (~31.5KB) fills Chunk 1 right near summaryInputMaxBytes=36000,
    // so tailUser (~1.2KB) + tailAsst (~4.2KB) spill into Chunk 2!
    s.addAssistant('Chunk 1 body. ' + 'detail-line '.repeat(2620));
    const tailUser = s.addUser('Short tail follow-up. ' + 'u'.repeat(1200));
    const tailAsst = s.addAssistant('Tail response. ' + 'tail-word '.repeat(420));
    s.addUser('Final retained tail prompt.');
    s.addAssistant('Final retained tail reply.');
    await host.sessions.flush(s.session);
    host.registerSession(s);

    assert.equal(detectBiliSession(s.session).detected, true);
    const mig = await host.engine.migrateBiliSession(s.session, {
      sessions: host.sessions,
      backend: host.backend,
      sessionPersistence: host.backend,
      asyncRollingWave: false,
    });
    assert.equal(mig.accepted, true);
    assert.equal(mig.completed, true);
    assert.ok(streamIndex >= 2, `expected chunk 1 commit + chunk 2 SUMMARY_NOT_SMALLER tail, got ${streamIndex} calls`);
    assert.ok(mig.compactionIds.length >= 1);
    assert.equal(detectBiliSession(s.session).detected, false, 'all bili nodes must be cleared');
    assert.ok(s.surface.nodes.includes(tailUser.seq), 'unshrinkable non-bili tail user node must stay safely retained');
    assert.ok(s.surface.nodes.includes(tailAsst.seq), 'unshrinkable non-bili tail assistant node must stay safely retained');

    // Contrast: if a bili tool node is STILL present on Chunk 2 when SUMMARY_NOT_SMALLER happens, migration MUST fail!
    streamIndex = 0;
    const sStillBili = makeSessionFixture({ sessionDir: join(home, 'sessions', 'bili-tail-still-bili') });
    sStillBili.addSystem('System.');
    sStillBili.addUser('Keep production safe.');
    sStillBili.addToolPair('acp_status', {}, '[ACP] chunk 1 bili\n' + 'status-payload '.repeat(1200));
    sStillBili.addAssistant('Chunk 1 body. ' + 'detail-line '.repeat(2620));
    sStillBili.addUser('Chunk 2 prompt. ' + 'u'.repeat(1200));
    sStillBili.addToolPair('acp_read_original_image', { ref: 'm9' }, '[bili] 原图已读取\n' + 'img '.repeat(300));
    sStillBili.addAssistant('Chunk 2 bili tail. ' + 'tail-word '.repeat(420));
    sStillBili.addUser('Final retained tail prompt.');
    sStillBili.addAssistant('Final retained tail reply.');
    await host.sessions.flush(sStillBili.session);
    host.registerSession(sStillBili);
    await assert.rejects(() =>
      host.engine.migrateBiliSession(sStillBili.session, {
        sessions: host.sessions,
        backend: host.backend,
        sessionPersistence: host.backend,
        asyncRollingWave: false,
      }),
    );
    assert.equal(detectBiliSession(sStillBili.session).detected, true, 'bili tool still unmigrated on failed tail');
  } finally {
    host.cleanup();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// 5. Monotonic overallPercent across chunks + fold, multi-wave continuation, and fold-adopt
await test('monotonic-overallPercent-across-chunks-fold-continuation-and-fold-adopt', async () => {
  const home = await mkdtemp(join(tmpdir(), 'weave-live-progress-'));

  // 5a. Multi-chunk + hierarchical fold
  const chunkSnapshots = [];
  const hostChunks = makeHostFixture({
    home: join(home, 'chunks'),
    windowTokens: 120000,
    extraEngineConfig: {
      language: 'en',
      summaryInputMaxBytes: 36000,
      cacheMaxCheckpoints: 2,
      summaryRetryCount: 0,
      auditBlockOnLoss: false,
    },
    streamHandler: async function* () {
      const sid = [...hostChunks.sessionsMap.keys()][0];
      const text = makeEnSummary('Chunk summary.');
      const mid = Math.floor(text.length / 2);
      yield { type: 'text-delta', text: text.slice(0, mid) };
      chunkSnapshots.push(hostChunks.engine.progressTracker.snapshot(sid));
      yield { type: 'text-delta', text: text.slice(mid) };
      yield { type: 'finish', kind: 'stop' };
    },
  });
  try {
    const s = makeSessionFixture({ sessionDir: join(home, 'chunks', 'sessions', 's1') });
    s.addSystem('System.');
    s.addUser('Process all batches.');
    s.addToolPair('acp_status', {}, '[ACP] acp_status result: ok\n' + 'log '.repeat(600));
    for (let i = 0; i < 6; i += 1) {
      s.addUser(`Batch ${i}`);
      s.addAssistant(`Output ${i}: ` + 'analysis-detail '.repeat(1200));
    }
    await hostChunks.sessions.flush(s.session);
    hostChunks.registerSession(s);

    // Also spy on progressTracker.update to capture EVERY single transition
    const allChunkPercents = [];
    const origUpdate = hostChunks.engine.progressTracker.update.bind(hostChunks.engine.progressTracker);
    hostChunks.engine.progressTracker.update = (sid, patch, opts) => {
      const ok = origUpdate(sid, patch, opts);
      const snap = hostChunks.engine.progressTracker.snapshot(sid);
      if (typeof snap.overallPercent === 'number') allChunkPercents.push(snap.overallPercent);
      return ok;
    };

    await hostChunks.engine.migrateBiliSession(s.session, {
      sessions: hostChunks.sessions,
      backend: hostChunks.backend,
      sessionPersistence: hostChunks.backend,
      asyncRollingWave: false,
    });
    const doneSnap = hostChunks.engine.progressTracker.snapshot(s.session.id);
    allChunkPercents.push(doneSnap.overallPercent);

    assert.ok(allChunkPercents.length >= 6, `expected rich progress updates, got ${allChunkPercents.length}`);
    for (let i = 1; i < allChunkPercents.length; i += 1) {
      assert.ok(
        allChunkPercents[i] >= allChunkPercents[i - 1],
        `overallPercent must be strictly monotonic non-decreasing: ${JSON.stringify(allChunkPercents)}`,
      );
    }
    assert.equal(doneSnap.phase, 'done');
    assert.equal(doneSnap.overallPercent, 100);
    assert.ok(doneSnap.overallTotalNodes > 0);
    assert.equal(doneSnap.overallProcessedNodes, doneSnap.overallTotalNodes);
    assert.ok(doneSnap.overallTotalTokens > 0);
    assert.equal(doneSnap.overallProcessedTokens, doneSnap.overallTotalTokens);
  } finally {
    hostChunks.cleanup();
  }

  // 5b. Multi-wave continuation: overallPercent advances smoothly across waves & pages and NEVER resets to 0!
  const contNotes = '## Goal\nDrain waves.\n\n## State\nArchived.\n\n## Next\nContinue.\n\n## Uncertain\nNone.';
  const hostCont = makeHostFixture({
    home: join(home, 'cont'),
    windowTokens: 120000,
    extraEngineConfig: {
      language: 'en',
      summaryInputMaxBytes: 36000,
      maxSummaryChunks: 2,
      summaryRetryCount: 0,
      continuationEnabled: true,
      auditBlockOnLoss: false,
    },
    streamHandler: async function* () {
      yield { type: 'text-delta', text: contNotes };
      yield { type: 'finish', kind: 'stop' };
    },
  });
  try {
    const s = makeSessionFixture({ sessionDir: join(home, 'cont', 'sessions', 's2') });
    const bigTools = Array.from({ length: 40 }, (_, i) => ({
      name: `tool_${i}`,
      description: 'D'.repeat(1100),
      parameters: { type: 'object', properties: {} },
    }));
    s.session.requestHeader = () => ({ config: { provider: 'p', model: 'm' }, tools: bigTools });
    s.addSystem('System.');
    s.addUser('Preserve strict schema.');
    for (let i = 0; i < 6; i += 1) {
      s.addToolPair('acp_status', { step: i }, `[ACP] wave ${i}\n` + 'log-entry '.repeat(450));
      s.addAssistant(`Batch ${i}: ` + 'analysis-record '.repeat(600));
    }
    await hostCont.sessions.flush(s.session);
    hostCont.registerSession(s);

    const waveTransitions = [];
    const origUpdate = hostCont.engine.progressTracker.update.bind(hostCont.engine.progressTracker);
    hostCont.engine.progressTracker.update = (sid, patch, opts) => {
      const ok = origUpdate(sid, patch, opts);
      const snap = hostCont.engine.progressTracker.snapshot(sid);
      waveTransitions.push({ wave: snap.waveIndex, page: snap.pageIndex, pct: snap.overallPercent });
      return ok;
    };

    const mig = await hostCont.engine.migrateBiliSession(s.session, {
      sessions: hostCont.sessions,
      backend: hostCont.backend,
      sessionPersistence: hostCont.backend,
      asyncRollingWave: false,
    });
    assert.ok(mig.compactionIds.length >= 2);
    const done = hostCont.engine.progressTracker.snapshot(s.session.id);
    waveTransitions.push({ wave: done.waveIndex, page: done.pageIndex, pct: done.overallPercent });

    for (let i = 1; i < waveTransitions.length; i += 1) {
      assert.ok(
        waveTransitions[i].pct >= waveTransitions[i - 1].pct,
        `multi-wave overallPercent must never regress: ${JSON.stringify(waveTransitions)}`,
      );
    }
    const wave2First = waveTransitions.find((t) => t.wave === 2);
    assert.ok(wave2First && wave2First.pct > 12, `wave 2 must start above 12% without resetting to 0: ${JSON.stringify(wave2First)}`);
    assert.equal(done.overallPercent, 100);
  } finally {
    hostCont.cleanup();
  }

  // 5c. fold-adopt milestones: backing_up=15 -> migrating=45 -> committing=85 -> done=100
  const hostFold = makeHostFixture({ home: join(home, 'fold') });
  try {
    const s = makeSessionFixture({ sessionDir: join(home, 'fold', 'sessions', 's3') });
    s.addSystem('System.');
    s.session.append(
      'user/message',
      {
        id: randomUUID(),
        role: 'user',
        content: [
          { type: 'text', text: '[Compressed conversation section]\nLegacy fold.' },
          { type: 'text', text: '<bili-snapshot v1 blocks="1" />' },
        ],
        source: { kind: 'compact-checkpoint', compactionId: 'bili-fold-1' },
      },
      { surfaceOp: 'append' },
    );
    await hostFold.sessions.flush(s.session);
    hostFold.registerSession(s);

    const foldMilestones = [];
    const origWithRun = hostFold.engine.progressTracker.withRun.bind(hostFold.engine.progressTracker);
    hostFold.engine.progressTracker.withRun = (sid, meta, fn) => {
      if (meta?.phase) foldMilestones.push([meta.phase, meta.overallPercent]);
      return origWithRun(sid, meta, fn);
    };
    const origUpdate = hostFold.engine.progressTracker.update.bind(hostFold.engine.progressTracker);
    hostFold.engine.progressTracker.update = (sid, patch, opts) => {
      const ok = origUpdate(sid, patch, opts);
      const snap = hostFold.engine.progressTracker.snapshot(sid);
      foldMilestones.push([snap.phase, snap.overallPercent]);
      return ok;
    };

    await hostFold.engine.migrateBiliSession(s.session, {
      sessions: hostFold.sessions,
      backend: hostFold.backend,
      sessionPersistence: hostFold.backend,
      asyncRollingWave: false,
    });
    const foldDone = hostFold.engine.progressTracker.snapshot(s.session.id);
    foldMilestones.push([foldDone.phase, foldDone.overallPercent]);

    assert.ok(foldMilestones.some(([p, v]) => p === 'backing_up' && v === 15), `expected backing_up=15 in ${JSON.stringify(foldMilestones)}`);
    assert.ok(foldMilestones.some(([p, v]) => p === 'migrating' && v === 45), `expected migrating=45 in ${JSON.stringify(foldMilestones)}`);
    assert.ok(foldMilestones.some(([p, v]) => p === 'committing' && v === 85), `expected committing=85 in ${JSON.stringify(foldMilestones)}`);
    assert.equal(foldDone.overallPercent, 100);
  } finally {
    hostFold.cleanup();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// 6. Retry backup clobbering prevention, identical-SHA reuse, originalBackupId pinning, and default restore target
await test('retry-backup-preserves-original-baseline-reuses-identical-sha-and-restores-baseline', async () => {
  const home = await mkdtemp(join(tmpdir(), 'weave-live-retry-backup-'));
  let failOnCall = 2; // Attempt 1 commits Chunk 1 (call 1) and fails on Chunk 2 (call 2)!
  let callCounter = 0;
  const host = makeHostFixture({
    home,
    windowTokens: 120000,
    extraEngineConfig: {
      language: 'en',
      summaryInputMaxBytes: 36000,
      summaryRetryCount: 0,
      continuationEnabled: false,
      auditBlockOnLoss: false,
    },
    streamHandler: async function* () {
      callCounter += 1;
      if (callCounter === failOnCall) {
        throw Object.assign(new Error('transient provider outage mid-batch'), { code: 'PROVIDER_ERROR' });
      }
      yield { type: 'text-delta', text: makeEnSummary('Chunk committed.') };
      yield { type: 'finish', kind: 'stop' };
    },
  });
  try {
    const s = makeSessionFixture({ sessionDir: join(home, 'sessions', 'retry-sess'), rawFilename: 'session.v4.jsonl.zstd' });
    s.addSystem('System.');
    s.addUser('Preserve original baseline.');
    s.addToolPair('acp_status', {}, '[ACP] chunk 1 bili tool\n' + 'chunk1-log '.repeat(1200));
    s.addAssistant('Chunk 1 reply A. ' + 'chunk1-reply '.repeat(1600));
    s.addAssistant('Chunk 1 reply B. ' + 'chunk1-extra '.repeat(1600));
    // Second bili tool sits in Chunk 2 (past Chunk 1's 36KB budget) so after Attempt 1
    // partially commits Chunk 1 and fails Chunk 2, bili is STILL detected and user can click Retry!
    s.addToolPair('acp_read_original_image', { ref: 'm002' }, '[bili] 原图已读取\n' + 'chunk2-log '.repeat(1200));
    s.addAssistant('Chunk 2 reply. ' + 'chunk2-reply '.repeat(1600));
    host.registerSession(s);
    await host.sessions.flush(s.session);

    const originalBytes = readFileSync(s.logPath);
    const originalSha = sha256(originalBytes);
    const originalNodeCount = s.surface.nodes.length;

    // Attempt 1: creates clean baseline Backup #1, commits Chunk 1, fails on Chunk 2!
    await assert.rejects(() =>
      host.engine.migrateBiliSession(s.session, {
        sessions: host.sessions,
        backend: host.backend,
        sessionPersistence: host.backend,
        asyncRollingWave: false,
      }),
    );
    const afterAttempt1Sha = sha256(readFileSync(s.logPath));
    assert.notEqual(afterAttempt1Sha, originalSha, 'Attempt 1 must have partially committed Chunk 1');
    assert.ok(s.surface.nodes.length < originalNodeCount, 'surface node count shrunk after Chunk 1');
    assert.equal(detectBiliSession(s.session).detected, true, 'Chunk 2 bili tool still present for Retry');

    const status1 = (await host.rpc('status', { sessionId: s.session.id })).body.value;
    assert.equal(status1.backup.count, 1);
    const b1Id = status1.backup.originalBackupId;
    assert.ok(b1Id && b1Id === status1.backup.latestBackupId);
    assert.equal(status1.backup.items.length, 1);
    assert.equal(status1.backup.items[0].isBaseline, true);
    assert.equal(status1.backup.items[0].surfaceNodeCount, originalNodeCount);

    // Attempt 2 (Retry): fails during chunk 2 (creates non-baseline Backup #2 capturing partially-modified state!)
    failOnCall = callCounter + 1;
    await assert.rejects(() =>
      host.engine.migrateBiliSession(s.session, {
        sessions: host.sessions,
        backend: host.backend,
        sessionPersistence: host.backend,
        asyncRollingWave: false,
      }),
    );

    const status2 = (await host.rpc('status', { sessionId: s.session.id })).body.value;
    assert.equal(status2.backup.count, 2);
    const b2Id = status2.backup.latestBackupId;
    assert.notEqual(b2Id, b1Id);
    // CRITICAL: originalBackupId and backupPath MUST remain pinned to clean baseline Backup #1!
    assert.equal(status2.backup.originalBackupId, b1Id, 'Retry MUST NOT clobber originalBackupId');
    assert.equal(status2.backup.backupPath, status1.backup.backupPath, 'status.backup.backupPath must keep baseline path');
    assert.equal(status2.backup.items.length, 2);
    const item1 = status2.backup.items.find((i) => i.backupId === b1Id);
    const item2 = status2.backup.items.find((i) => i.backupId === b2Id);
    assert.equal(item1.isBaseline, true);
    assert.equal(item1.surfaceNodeCount, originalNodeCount);
    assert.equal(item2.isBaseline, false);
    assert.ok(item2.surfaceNodeCount < originalNodeCount);

    // Identical-SHA retry reuse: when disk bytes have not changed since the latest backup
    // (e.g., pre-flight capacity rejection before writing any session event), retry MUST reuse
    // the identical-SHA backup instead of duplicating 7MB files!
    const reuseResult = await createSessionBackup(host.engine.backupStore, {
      session: s.session,
      sessions: host.sessions,
      backend: host.backend,
      stateStore: host.engine.sessionState,
      reason: 'bili-migration',
      reuseIdentical: true,
    });
    const countBeforeIdenticalRetry = (await host.rpc('status', { sessionId: s.session.id })).body.value.backup.count;
    const reuseAgain = await createSessionBackup(host.engine.backupStore, {
      session: s.session,
      sessions: host.sessions,
      backend: host.backend,
      stateStore: host.engine.sessionState,
      reason: 'bili-migration',
      reuseIdentical: true,
    });
    assert.equal(reuseAgain.reused, true, 'identical-SHA backup must be reused');
    assert.equal(reuseAgain.backupId, reuseResult.backupId);
    const status3 = (await host.rpc('status', { sessionId: s.session.id })).body.value;
    assert.equal(status3.backup.count, countBeforeIdenticalRetry, 'identical-SHA retry must not duplicate backup files');
    assert.equal(status3.backup.originalBackupId, b1Id, 'originalBackupId remains pinned to clean baseline Backup #1');

    // /compact backups surfaces baseline annotation and default restore hint
    const decorated = decorateCompactCommand({ name: 'compact', async handler() { return { kind: 'success', text: 'ok' }; } }, host.engine);
    const backupsOut = await decorated.handler({
      rawInput: '/compact backups',
      agent: { session: s.session },
      signal: new AbortController().signal,
    });
    assert.equal(backupsOut.kind, 'success');
    assert.match(backupsOut.text, /\[原始基线\]/);
    assert.ok(backupsOut.text.includes(b1Id));

    // Cold restore WITHOUT explicit backupId MUST default to originalBackupId (Backup #1 -> originalSha)!
    host.sessionsMap.delete(s.session.id);
    const defaultRestore = await host.rpc('backup-restore', {
      sessionId: s.session.id,
      confirmRestore: true,
    });
    assert.equal(defaultRestore.body.ok, true);
    assert.equal(defaultRestore.body.value.backupId, b1Id, 'default restore must pick originalBackupId (Backup #1)');
    assert.equal(sha256(readFileSync(s.logPath)), originalSha, 'default restore must recover clean pre-migration bytes');

    // Explicit backupId = b2 STILL restores Backup #2 when explicitly chosen!
    const explicitRestore = await host.rpc('backup-restore', {
      sessionId: s.session.id,
      backupId: b2Id,
      confirmRestore: true,
    });
    assert.equal(explicitRestore.body.ok, true);
    assert.equal(explicitRestore.body.value.backupId, b2Id);
    assert.equal(sha256(readFileSync(s.logPath)), afterAttempt1Sha);
  } finally {
    host.cleanup();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// 7. Legacy pre-fix backups (without explicit isBaseline in manifest) still pin earliest bili-migration as originalBackupId
await test('legacy-bili-backups-without-isBaseline-still-pin-earliest-baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-live-legacy-bkp-'));
  try {
    const store = new SessionBackupStore({ root: join(root, 'backups') });
    const sessionId = 'legacy-sess-1';
    const logPath = join(root, 'session.v4.jsonl.zstd');
    const bytes1 = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('legacy-v1\n')]);
    const bytes2 = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('legacy-v2\n')]);
    writeFileSync(logPath, bytes1);
    const b1 = await createSessionBackup(store, { sessionId, logPath, reason: 'bili-migration', isBaseline: false });
    writeFileSync(logPath, bytes2);
    const b2 = await createSessionBackup(store, { sessionId, logPath, reason: 'bili-migration', isBaseline: false });

    const summary = summarizeBackups(store, sessionId);
    assert.equal(summary.count, 2);
    assert.equal(summary.originalBackupId, b1.backupId, 'earliest bili-migration backup must be pinned as originalBackupId');
    assert.equal(summary.latestBackupId, b2.backupId);
    assert.equal(summary.backupPath, b1.backupPath);
    assert.equal(summary.items.find((i) => i.backupId === b1.backupId).isBaseline, true);

    // Default restore picks b1 (bytes1)
    writeFileSync(logPath, Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('mutated\n')]));
    const restored = await restoreSessionBackup(store, { sessionId, logPath });
    assert.equal(restored.backupId, b1.backupId);
    assert.deepEqual(readFileSync(logPath), bytes1);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
