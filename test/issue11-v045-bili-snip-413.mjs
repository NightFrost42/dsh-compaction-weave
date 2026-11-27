import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import vm from 'node:vm';

import {
  classifyBiliProxyError,
  detectBiliCoexistence,
  detectLoopbackBiliProviders,
  findEnabledBiliPluginRows,
  isBiliProxyPreflightError,
  isNonSnippableCompactionError,
  isWindowOverflowError,
} from '../lib/bili-conflict.js';
import { resolveConfig } from '../lib/config.js';
import { dumpAuditRejection } from '../lib/audit-reject.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { apply as applyEngine } from '../lib/engine-entry.js';
import { apply as applyPlugin } from '../lib/index.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { normalizeRetryReasonCode } from '../lib/progress-tracker.js';
import { buildCompactionInstruction } from '../lib/prompt.js';
import { summarizeWithChain } from '../lib/summary.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error?.message ?? String(error), stack: error?.stack });
  }
}

const TEST_BASE = process.env.WEAVE_TEST_ROOT ?? tmpdir();
const MINUTE = 60_000;

const EN_HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeSummary(section9 = 'Preserve active rules and continue.') {
  return EN_HEADINGS.map((h, idx) =>
    `${h}\n${idx === 5 ? '[filled by engine]' : idx === 8 ? section9 : 'Historical details archived.'}`,
  ).join('\n\n');
}

function tokensStr(tokenCount, label = 'tok') {
  const unit = `${label} `;
  const chars = Math.max(4, tokenCount * 4);
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
}

async function createIsolatedSessionFixture({
  extraConfig = {},
  windowTokens = 65536,
  defaultMaxTokens = 4096,
  streamImpl = null,
  withRuntimePlugin = false,
  pluginConfigRows = null,
  providers = [],
} = {}) {
  const root = await mkdtemp(join(TEST_BASE, 'weave-i11-v045-'));
  const prevHome = process.env.DSH_HOME;
  if (withRuntimePlugin) process.env.DSH_HOME = root;
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const hooks = new Map();
  const provided = new Map();
  const llmCalls = [];
  const logs = [];
  let routeHandler = null;
  let flushes = 0;
  let clock = Date.now() - 40 * MINUTE;

  const session = {
    id: `sess-${randomUUID()}`,
    header: { version: 4, id: 'placeholder', createdAt: clock, isSeeded: false },
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => [...events],
    requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: defaultMaxTokens } }),
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
      const time = typeof options.time === 'number' ? options.time : (clock += 10);
      const event = {
        seq: events.length,
        time,
        type,
        data,
        ...(options.surfaceOp !== undefined ? { surfaceOp: options.surfaceOp } : {}),
        ...(Array.isArray(options.sourceEventSeqs) ? { sourceEventSeqs: [...options.sourceEventSeqs] } : {}),
      };
      events.push(event);
      const op = options.surfaceOp;
      if (op?.op === 'replace') {
        const s = surface.nodes.indexOf(op.startSeq);
        const e = surface.nodes.indexOf(op.endSeq);
        assert.ok(s >= 0 && e >= s, `invalid replace ${op.startSeq}..${op.endSeq}`);
        surface.nodes.splice(s, e - s + 1, event.seq);
        surface.replaceGeneration += 1;
      } else if (op === 'append') {
        surface.nodes.push(event.seq);
      }
      return event;
    },
  };
  session.header.id = session.id;

  const sessionsMap = new Map([[session.id, session]]);
  const measure = () => {
    const nodes = surface.nodes.map((seq) => {
      const msg = session.deriveEventMessage(session.eventAt(seq));
      return { seq, tokens: approxTokens(blocksToText(msg?.content)) };
    });
    return { nodes, totalTokens: nodes.reduce((sum, n) => sum + n.tokens, 0), precision: 'priced' };
  };

  const baseCtx = {
    provide(name, val) {
      provided.set(name, val);
    },
    get(name) {
      return name === 'connection' ? { admit: () => ({ peer: { principal: { kind: 'owner' } } }) } : provided.get(name);
    },
    inject(deps, fn) {
      if (Array.isArray(deps) && deps.includes('llm')) {
        fn({ llm: baseCtx.llm });
      }
      if (Array.isArray(deps) && deps.includes('webServer')) {
        fn({
          effect: (createFn) => {
            createFn();
            return () => {};
          },
          webServer: {
            register(def) {
              routeHandler = def.handler;
              return () => {};
            },
          },
        });
      }
      if (Array.isArray(deps) && deps.includes('compactionWeaveRuntime') && provided.has('compactionWeaveRuntime')) {
        return fn({ compactionWeaveRuntime: provided.get('compactionWeaveRuntime') });
      }
      return undefined;
    },
    on(event, fn) {
      if (!hooks.has(event)) hooks.set(event, []);
      hooks.get(event).push(fn);
      return () => {};
    },
    logger: {
      info: (m) => logs.push({ level: 'info', msg: String(m) }),
      warn: (m) => logs.push({ level: 'warn', msg: String(m) }),
      error: (m) => logs.push({ level: 'error', msg: String(m) }),
    },
    sessions: {
      flush: async () => {
        flushes += 1;
      },
      get: (id) => sessionsMap.get(id),
    },
    tokenMeter: { measure: () => measure() },
    llm: {
      listProviders: () => providers,
      async resolveModelInfo() {
        return { contextWindow: windowTokens, defaultMaxTokens };
      },
      async *stream(req) {
        llmCalls.push(req);
        if (typeof streamImpl === 'function') {
          yield* streamImpl(req, llmCalls.length);
          return;
        }
        yield { type: 'text-delta', text: makeSummary() };
        yield { type: 'finish', kind: 'stop', usage: { inputTokens: 80, outputTokens: 60 } };
      },
    },
  };

  const rawEngineCfg = {
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
    snipEnabled: true,
    snipKeepRecentTurns: 2,
    snipKeepRecentTokens: 4096,
    snipMinSavingsTokens: 512,
    snipMaxSpansPerRescue: 4,
    ...extraConfig,
  };

  let engine;
  if (withRuntimePlugin) {
    applyPlugin(baseCtx, { engine: rawEngineCfg });
    if (pluginConfigRows) {
      const cfgHooks = hooks.get('internal/config') ?? [];
      for (const h of cfgHooks) {
        h(null, () => ({ config: { plugins: pluginConfigRows } }));
      }
    }
    applyEngine(baseCtx, rawEngineCfg);
    engine = provided.get('compactionWeaveRuntime')?.getDefaultEngine?.();
    assert.ok(engine, 'engine must mount via engine-entry');
  } else {
    engine = new WeaveCompactionEngine(baseCtx, resolveConfig(rawEngineCfg).config);
  }
  engine.historyToolsAvailable = true;

  const callRpc = async (method, params = {}) => {
    assert.ok(routeHandler, 'runtime rpc route must be registered');
    let statusCode = 0;
    let bodyText = '';
    const req = Readable.from([Buffer.from(JSON.stringify({ method, params }))]);
    req.method = 'POST';
    req.socket = { remoteAddress: '127.0.0.1' };
    req.headers = { origin: 'http://localhost', host: 'localhost', 'content-type': 'application/json' };
    const res = {
      set statusCode(c) { statusCode = c; },
      get statusCode() { return statusCode; },
      setHeader() {},
      writeHead(c) { statusCode = c; },
      end(chunk) { bodyText += String(chunk ?? ''); },
    };
    await routeHandler(req, res);
    return { statusCode, body: JSON.parse(bodyText) };
  };

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
      { message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } } },
      { surfaceOp: 'append' },
    );

  const addToolStep = ({ turn = 1, step = 1, toolName = 'read_file', args = { path: 'src/a.js' }, resultText }) => {
    const callId = `call-${randomUUID().slice(0, 8)}`;
    const argsJson = JSON.stringify(args);
    const asst = session.append(
      'assistant/message',
      {
        turn,
        step,
        message: {
          id: randomUUID(),
          role: 'assistant',
          source: { kind: 'model', provider: 'p', model: 'm' },
          content: [{ type: 'tool-call', id: callId, name: toolName, arguments: argsJson }],
        },
      },
      { surfaceOp: 'append' },
    );
    const tc = session.append('tool/call', { turn, step, callId, name: toolName, arguments: argsJson });
    const tr = session.append(
      'tool/result',
      {
        turn,
        step,
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: callId,
          source: { kind: 'tool', callId },
          content: [{ type: 'text', text: resultText }],
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [tc.seq] },
    );
    return { asst, tc, tr };
  };

  const agent = {
    session,
    inbox: { nextStep: [], nextTurn: [], prepend: () => {} },
    options: { provider: 'p', model: 'm' },
    runMaintenance: (fn) => fn(new AbortController().signal),
    cancel() {},
  };

  const runPreStep = async (messages = []) => {
    const preHooks = hooks.get('agent/pre-step') ?? [];
    assert.ok(preHooks.length >= 1);
    let enteredMain = false;
    await preHooks[0]({ agent, signal: new AbortController().signal, messages }, async () => {
      enteredMain = true;
      return { kind: 'enter' };
    });
    return { enteredMain };
  };

  const runRequestError = async (failure) => {
    const errHooks = hooks.get('agent/request-error') ?? [];
    assert.ok(errHooks.length >= 1);
    let fellThrough = false;
    const outcome = await errHooks[0]({ agent, signal: new AbortController().signal, failure }, async () => {
      fellThrough = true;
      return { kind: 'original-error' };
    });
    return { outcome, fellThrough };
  };

  const snipStubs = () =>
    surface.nodes
      .map((seq) => ({ seq, msg: session.deriveEventMessage(session.eventAt(seq)) }))
      .filter(({ msg }) => msg?.source?.kind === 'compact-checkpoint' && msg?.source?.snip === true);

  const countArchiveFiles = async () => {
    const sessDir = join(engine.archive.root, 'sessions');
    try {
      const entries = await readdir(sessDir, { recursive: true });
      return entries.filter((f) => {
        const name = String(f);
        return name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl') || name.endsWith('.json');
      }).length;
    } catch {
      return 0;
    }
  };

  return {
    root,
    engine,
    session,
    surface,
    agent,
    logs,
    llmCalls,
    measure,
    callRpc,
    addSystem,
    addUser,
    addAssistant,
    addToolStep,
    runPreStep,
    runRequestError,
    snipStubs,
    countArchiveFiles,
    get flushes() {
      return flushes;
    },
    cleanup: async () => {
      engine.dispose();
      if (withRuntimePlugin) {
        if (prevHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevHome;
      }
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

// ── 1. Classifier unit checks & strict negative guardrails ──────────────────────

await test('bili-conflict-classifiers-and-no-false-positives', async () => {
  assert.equal(
    findEnabledBiliPluginRows([
      { name: 'other-plugin' },
      { name: 'billion-context', disabled: true },
      { name: 'billion-context-dsh', enabled: false },
    ]),
    0,
  );
  assert.equal(
    findEnabledBiliPluginRows([
      { id: 'preset-standard', config: [{ name: 'billion-context' }] },
      { name: '@scope/billion-context-dsh' },
    ]),
    2,
  );

  // Legitimate loopback Ollama/vLLM must NOT trigger bili proxy false alarm!
  const ollamaProviders = [
    { id: 'ollama', name: 'Local Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
    { id: 'local-vllm', baseUrl: 'http://localhost:8000/v1' },
  ];
  assert.deepEqual(detectLoopbackBiliProviders({ listProviders: () => ollamaProviders }), []);
  assert.deepEqual(
    detectLoopbackBiliProviders({
      listProviders: () => [...ollamaProviders, { id: 'bili-proxy', baseUrl: 'http://127.0.0.1:18999/v1' }],
    }),
    ['bili-proxy'],
  );

  // Inactive telemetry / verdict must NOT trigger conflict
  const cleanConflict = detectBiliCoexistence({
    ctx: { get: () => null },
    enabledConfigRows: 0,
    runtimeSignals: [],
    llmService: { listProviders: () => ollamaProviders },
    globalObj: {
      __BILI_DSH_COMPACTION_VERDICT__: 'inactive',
      __BILI_DSH_COMPACTION_GATE_TELEMETRY__: { active: false, verdict: 'inactive' },
    },
  });
  assert.equal(cleanConflict.detected, false);
  assert.equal(cleanConflict.activePlugin, false);
  assert.equal(cleanConflict.proxyResidue, false);

  // Active telemetry + proxy signal yields kind='both'
  const activeBoth = detectBiliCoexistence({
    ctx: { get: (n) => (n === 'biliBasicCompactionPolicy' ? {} : null) },
    enabledConfigRows: 1,
    runtimeSignals: [{ kind: 'bili_proxy_preflight', code: 'BILI_PROXY_CONFLICT', at: '2026-11-23T12:00:00Z' }],
    llmService: null,
    globalObj: { __BILI_DSH_COMPACTION_VERDICT__: 'active' },
  });
  assert.equal(activeBoth.detected, true);
  assert.equal(activeBoth.kind, 'both');
  assert.equal(activeBoth.activePlugin, true);
  assert.equal(activeBoth.proxyResidue, true);

  // Genuine 413 / model window vs bili proxy preflight separation
  assert.equal(isWindowOverflowError({ status: 413, message: 'Payload Too Large' }), true);
  assert.equal(isWindowOverflowError({ statusCode: 413, message: 'exceeds model window' }), true);
  assert.equal(isBiliProxyPreflightError({ status: 413, message: 'Payload Too Large' }), false);

  const biliPreflight = {
    statusCode: 413,
    message: 'preflight_compress_failed: payload core text alone is 128400 vs model window 65536, no upstream can accept it',
  };
  assert.equal(isBiliProxyPreflightError(biliPreflight), true);
  assert.equal(isWindowOverflowError(biliPreflight), false);
  assert.equal(isNonSnippableCompactionError(biliPreflight), true);
  assert.equal(classifyBiliProxyError({ code: 'SUMMARY_FOREIGN_BILI_FORMAT' }), 'foreign_bili_format');

  // Non-snippable categories
  for (const err of [
    { code: 'SUMMARY_FOREIGN_BILI_FORMAT' },
    { code: 'BILI_PROXY_CONFLICT' },
    { code: 'BILI_COEXISTENCE_CONFLICT' },
    { status: 401, message: 'Unauthorized' },
    { statusCode: 403, message: 'Forbidden' },
    { code: 'CONFIG_INVALID' },
    { code: 'RECOVERY_REQUIRED' },
  ]) {
    assert.equal(isNonSnippableCompactionError(err), true);
  }
  assert.equal(isNonSnippableCompactionError({ code: 'HTTP_502', status: 502 }), false);
});

// ── 2. Runtime RPC exposure + active coexistence early stop ─────────────────────

await test('bili-coexistence-runtime-rpc-and-early-stop', async () => {
  const f = await createIsolatedSessionFixture({
    withRuntimePlugin: true,
    pluginConfigRows: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'bili', name: 'billion-context', disabled: false },
    ],
  });
  try {
    f.addSystem('Sys rules.');
    f.addUser('Keep WAL enabled.');
    f.addUser('Short message.');

    // Below threshold still passes undisturbed so unrelated small chats don't lock up
    const lowStep = await f.runPreStep([]);
    assert.equal(lowStep.enteredMain, true);

    f.addAssistant(tokensStr(54000, 'history'));
    f.addUser('Latest.');

    const st = await f.callRpc('status', { sessionId: f.session.id });
    assert.equal(st.body.ok, true);
    assert.equal(st.body.value.biliConflict?.detected, true);
    assert.equal(st.body.value.biliConflict?.activePlugin, true);
    assert.ok(st.body.value.biliConflict.signals.includes('bili_config_enabled'));

    const cfgGet = await f.callRpc('get');
    assert.equal(cfgGet.body.ok, true);
    assert.equal(cfgGet.body.value.biliConflict?.detected, true);

    // Above threshold pressure auto-compaction blocks with BILI_COEXISTENCE_CONFLICT and 0 LLM calls
    await assert.rejects(
      f.runPreStep([]),
      (err) => err?.failureCode === 'BILI_COEXISTENCE_CONFLICT' || err?.code === 'BILI_COEXISTENCE_CONFLICT',
    );
    assert.equal(f.llmCalls.length, 0);
    assert.equal(f.snipStubs().length, 0);

    // Manual /compact, migrate, resume, retry also short-circuit with 0 LLM calls
    await assert.rejects(
      f.engine.compactNow(f.agent, new AbortController().signal, 'cmd-1'),
      (err) => err?.code === 'BILI_COEXISTENCE_CONFLICT' || err?.cause?.code === 'BILI_COEXISTENCE_CONFLICT',
    );
    await assert.rejects(
      f.engine.migrateBiliSession(f.session),
      (err) => err?.code === 'BILI_COEXISTENCE_CONFLICT',
    );
    await assert.rejects(
      f.engine.retryCompactionFor(f.session),
      (err) => err?.code === 'BILI_COEXISTENCE_CONFLICT',
    );
    assert.equal(f.llmCalls.length, 0);
  } finally {
    await f.cleanup();
  }

  // Historical <bili-snapshot> session WITHOUT active plugin MUST NOT block or set biliConflict!
  const fHist = await createIsolatedSessionFixture({ withRuntimePlugin: true });
  try {
    fHist.addSystem('Sys.');
    fHist.session.append(
      'assistant/message',
      {
        message: {
          id: randomUUID(),
          role: 'assistant',
          source: { kind: 'model' },
          content: [{ type: 'text', text: '<bili-snapshot>legacy fold</bili-snapshot>' }],
        },
      },
      { surfaceOp: 'append' },
    );
    fHist.addUser('Continue cleanly.');
    const stHist = await fHist.callRpc('status', { sessionId: fHist.session.id });
    assert.equal(stHist.body.value.biliConflict ?? null, null);
  } finally {
    await fHist.cleanup();
  }
});

// ── 3. Zero-side-effect Snip guards & pre-commit effectiveness gate ─────────────

await test('snip-skips-non-overflow-and-aborts-before-write-when-unrescuable', async () => {
  // 3a. Foreign bili format failure at >= 95% budget wall MUST NOT run Snip
  const fForeign = await createIsolatedSessionFixture({ withRuntimePlugin: true });
  try {
    fForeign.session.append('turn/start', { turn: 1 });
    fForeign.addSystem('Sys.');
    fForeign.addUser('Keep invariant.');
    fForeign.addToolStep({ turn: 1, step: 1, resultText: tokensStr(38000, 'toolA') });
    fForeign.addUser(tokensStr(12000, 'u1'));
    fForeign.addAssistant('Ack 1');
    fForeign.addUser(tokensStr(12000, 'u2'));
    fForeign.addAssistant('Ack 2');
    assert.ok(fForeign.measure().totalTokens >= 61440);

    const genBefore = fForeign.surface.replaceGeneration;
    fForeign.engine.compactIfNeeded = async () => {
      throw Object.assign(new Error('legacy bili snapshot returned'), { code: 'SUMMARY_FOREIGN_BILI_FORMAT' });
    };
    await assert.rejects(fForeign.runPreStep([]), /SUMMARY_FOREIGN_BILI_FORMAT|bili/);
    assert.equal(fForeign.snipStubs().length, 0, 'Snip must not run on SUMMARY_FOREIGN_BILI_FORMAT');
    assert.equal(await fForeign.countArchiveFiles(), 0, 'Zero archive files written');
    assert.equal(fForeign.surface.replaceGeneration, genBefore);

    // Signal is also propagated to runtime status
    const st = await fForeign.callRpc('status', { sessionId: fForeign.session.id });
    assert.equal(st.body.value.biliConflict?.detected, true);
    assert.equal(st.body.value.biliConflict?.proxyResidue, true);
  } finally {
    await fForeign.cleanup();
  }

  // 3b. Unrescuable oversized protected tail: Snip aborts BEFORE commitSnip (0 writes, 0 surface changes)
  const fHuge = await createIsolatedSessionFixture({ windowTokens: 65536, defaultMaxTokens: 4096 });
  try {
    fHuge.session.append('turn/start', { turn: 1 });
    fHuge.addSystem('Sys.');
    fHuge.addUser('Important invariant.');
    // Old small snippable tool loop (~2000 tok)
    fHuge.addToolStep({ turn: 1, step: 1, resultText: tokensStr(2000, 'smallTool') });
    // Protected recent user turns alone = 70,000 tok > 61,440 budget -> unrescuable by Snip!
    fHuge.addUser(tokensStr(35000, 'recentUserA'));
    fHuge.addAssistant('Ack A');
    fHuge.addUser(tokensStr(35000, 'recentUserB'));
    fHuge.addAssistant('Ack B');

    const genBefore = fHuge.surface.replaceGeneration;
    const nodesBefore = [...fHuge.surface.nodes];
    let specSeen = null;
    fHuge.engine.compactIfNeeded = async (agent, _trig, sig) => {
      const m = await fHuge.engine._measure(agent.session);
      specSeen = await fHuge.engine._resolveSpec(agent, m, sig);
      throw Object.assign(new Error('upstream 502'), { code: 'HTTP_502', status: 502 });
    };
    await assert.rejects(
      fHuge.runPreStep([]),
      (err) => err?.code === 'COMPACTION_AUTOMATIC_BLOCKED' && /HTTP_502/.test(err.message),
    );
    assert.equal(fHuge.snipStubs().length, 0, 'Unrescuable session must produce 0 snip stubs');
    assert.equal(await fHuge.countArchiveFiles(), 0, 'Unrescuable session must write 0 archive files');
    assert.deepEqual(fHuge.surface.nodes, nodesBefore);
    assert.equal(fHuge.surface.replaceGeneration, genBefore);
    assert.equal(fHuge.flushes, 0);

    // Same-state dedupe avoids re-running ineffective plan inside _guardRequestBudget
    assert.ok(specSeen);
    const second = await fHuge.engine._emergencySnip(fHuge.agent, specSeen, new AbortController().signal, 'budget-wall');
    assert.equal(second, null);
  } finally {
    await fHuge.cleanup();
  }
});

// ── 4. Adaptive high-yield Snip rescues when default 4 spans are insufficient ────

await test('snip-adaptive-high-yield-rescue-on-many-small-spans', async () => {
  const f = await createIsolatedSessionFixture({ windowTokens: 65536, defaultMaxTokens: 4096 });
  try {
    f.session.append('turn/start', { turn: 1 });
    f.addSystem('Sys.');
    f.addUser('Rule: preserve integer arithmetic.');
    // 6 small oldest tool spans (~1.5k tok each = 9k total), followed by 2 huge tool spans (~22k each = 44k)!
    // With total ~68k and budget 61,440: default 4 oldest spans save only ~6k (leaves ~62k >= 61,440),
    // while adaptive high-yield rescues easily below 61,440!
    for (let i = 0; i < 6; i += 1) {
      f.addToolStep({ turn: 1, step: i + 1, resultText: tokensStr(1500, `small${i}`) });
    }
    const big1 = f.addToolStep({ turn: 1, step: 7, resultText: tokensStr(22000, 'HUGE_A') });
    const big2 = f.addToolStep({ turn: 1, step: 8, resultText: tokensStr(22000, 'HUGE_B') });
    f.addUser(tokensStr(5000, 'tailU1'));
    f.addAssistant('Ack 1');
    f.addUser(tokensStr(5000, 'tailU2'));
    f.addAssistant('Ack 2');
    assert.ok(f.measure().totalTokens >= 61440);

    f.engine.compactIfNeeded = async () => null;
    const { enteredMain } = await f.runPreStep([]);
    assert.equal(enteredMain, true, 'Adaptive Snip should rescue under messageBudgetTokens');
    assert.ok(f.measure().totalTokens < 61440);
    assert.ok(f.snipStubs().length >= 1);
    assert.equal(f.surface.nodes.includes(big1.tr.seq), false);
    assert.equal(f.surface.nodes.includes(big2.tr.seq), false);
  } finally {
    await f.cleanup();
  }
});

// ── 5. HTTP 413 / model window rescue vs bili proxy preflight abort ───────────

await test('http-413-overflow-rescue-vs-bili-proxy-preflight-abort', async () => {
  // 5a. Direct upstream HTTP 413 without preflight string rescues and returns { kind: 'retry' }
  const f413 = await createIsolatedSessionFixture({
    streamImpl: async function* () {
      throw Object.assign(new Error('HTTP 413: Payload Too Large for model window'), { statusCode: 413 });
    },
  });
  try {
    f413.session.append('turn/start', { turn: 1 });
    f413.addSystem('Sys.');
    f413.addUser('Rule: keep deterministic ids.');
    f413.addToolStep({ turn: 1, step: 1, resultText: tokensStr(28000, 'TOOL413') });
    f413.addUser(tokensStr(5000, 'u1'));
    f413.addAssistant('Ack 1');
    f413.addUser(tokensStr(5000, 'u2'));
    f413.addAssistant('Ack 2');

    const { outcome, fellThrough } = await f413.runRequestError({
      statusCode: 413,
      message: 'HTTP 413: Payload Too Large (exceeds model window)',
    });
    assert.equal(fellThrough, false);
    assert.deepEqual(outcome, { kind: 'retry' });
    assert.equal(f413.snipStubs().length, 1);
  } finally {
    await f413.cleanup();
  }

  // 5b. bili proxy preflight 413 stops immediately with BILI_PROXY_CONFLICT (no retry, no Snip, updates status)
  const fBili413 = await createIsolatedSessionFixture({ withRuntimePlugin: true });
  try {
    fBili413.session.append('turn/start', { turn: 1 });
    fBili413.addSystem('Sys.');
    fBili413.addUser('Rule: keep WAL.');
    fBili413.addToolStep({ turn: 1, step: 1, resultText: tokensStr(28000, 'NO_SNIP') });
    fBili413.addUser('Tail.');

    await assert.rejects(
      fBili413.runRequestError({
        statusCode: 413,
        message: 'preflight_compress_failed: payload core text alone is 90000 vs model window 65536, no upstream can accept it',
      }),
      (err) => err?.code === 'BILI_PROXY_CONFLICT' && /baseUrl|billion-context|BILI_PROXY_CONFLICT/.test(err.message),
    );
    assert.equal(fBili413.llmCalls.length, 0);
    assert.equal(fBili413.snipStubs().length, 0);
    assert.equal(await fBili413.countArchiveFiles(), 0);

    const st = await fBili413.callRpc('status', { sessionId: fBili413.session.id });
    assert.equal(st.body.value.biliConflict?.detected, true);
    assert.equal(st.body.value.biliConflict?.lastSignalCode, 'BILI_PROXY_CONFLICT');
    assert.equal(st.body.value.lastFailureCode, 'BILI_PROXY_CONFLICT');
    assert.equal(st.body.value.breaker.failures, 1);
  } finally {
    await fBili413.cleanup();
  }

  // 5c. summarizeWithChain stops on bili proxy preflight without falling through to secondary target
  let calls = 0;
  await assert.rejects(
    summarizeWithChain({
      ctx: {
        llm: {
          async resolveModelInfo() {
            return { contextWindow: 65536, defaultMaxTokens: 4096 };
          },
          async *stream() {
            calls += 1;
            throw Object.assign(new Error('413 preflight_compress_failed'), { statusCode: 413 });
          },
        },
      },
      chain: { targets: [{ provider: 'p1', model: 'm1' }, { provider: 'p2', model: 'm2' }] },
      input: {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        userMessages: [{ seq: 1, text: 'Keep rule.' }],
      },
      options: { language: 'en', timeoutMs: 5000, retryCount: 2, retryDelayMs: 0 },
    }),
    (err) => err?.code === 'BILI_PROXY_CONFLICT' && err?.recoverable === false,
  );
  assert.equal(calls, 1, 'bili proxy preflight must not burn secondary chain targets');
  assert.equal(
    normalizeRetryReasonCode({ status: 413, message: 'preflight_compress_failed' }),
    'BILI_PROXY_CONFLICT',
  );
  assert.equal(
    normalizeRetryReasonCode({ status: 413, message: '413: model window exceeded' }),
    'CONTEXT_WINDOW_EXCEEDED',
  );
});

// ── 6. Diagnostic trigger in audit-reject & interrupted top-level state sync ───

await test('diagnostic-trigger-in-audit-reject-and-resumable-state-sync', async () => {
  const f = await createIsolatedSessionFixture();
  try {
    const dumped = await dumpAuditRejection({
      storageRoot: join(f.root, 'diag-root'),
      sessionId: f.session.id,
      compactionId: 'cp-trig-1',
      trigger: 'manual',
      target: 'p/m',
      code: 'CONSTRAINT_LOST',
      message: 'missing rule',
      attempt: 1,
      modelRawText: 'summary text',
      auditedText: 'summary text',
      userMessages: [{ seq: 1, text: 'Keep WAL.' }],
    });
    assert.ok(dumped);
    const parsed = JSON.parse(await readFile(dumped, 'utf8'));
    assert.equal(parsed.trigger, 'manual');

    f.addSystem('Sys.');
    f.addUser('Keep WAL.');
    f.addAssistant('Ack.');

    // _persistResumableInterrupted on error syncs top-level sessionState
    const res1 = f.engine._persistResumableInterrupted(
      f.session,
      {
        jobId: 'job-1',
        trigger: 'pressure',
        completedChunks: 1,
        remainingSeqs: [1, 2],
        consecutiveFailures: 0,
      },
      Object.assign(new Error('413 model window'), { code: 'CONTEXT_WINDOW_EXCEEDED' }),
      null,
      { userCancelled: false },
    );
    assert.equal(res1.consecutiveFailures, 1);
    const top1 = f.engine.sessionState.read(f.session.id);
    assert.equal(top1.failures, 1);
    assert.equal(top1.lastFailureCode, 'CONTEXT_WINDOW_EXCEEDED');
    assert.equal(top1.stopped, false);

    // Reaching failureThreshold syncs stopped: true and failures >= threshold
    const res3 = f.engine._persistResumableInterrupted(
      f.session,
      {
        jobId: 'job-1',
        trigger: 'pressure',
        completedChunks: 1,
        remainingSeqs: [1, 2],
        consecutiveFailures: 2,
      },
      Object.assign(new Error('413 model window'), { code: 'CONTEXT_WINDOW_EXCEEDED' }),
      null,
      { userCancelled: false },
    );
    assert.equal(res3.consecutiveFailures, 3);
    assert.equal(res3.status, 'paused_failure');
    const top3 = f.engine.sessionState.read(f.session.id);
    assert.equal(top3.failures, 3);
    assert.equal(top3.stopped, true);
    assert.equal(top3.lastFailureCode, 'CONTEXT_WINDOW_EXCEEDED');
  } finally {
    await f.cleanup();
  }
});

// ── 7. Client UI: modal, dismiss, persistent banner & reopen, Settings banner ─

await test('client-ui-bili-conflict-modal-banner-and-settings-zh-and-en', async () => {
  const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

  function find(tree, pred) {
    if (!tree || typeof tree !== 'object') return null;
    if (pred(tree)) return tree;
    for (const c of tree.children ?? []) {
      const hit = find(c, pred);
      if (hit) return hit;
    }
    return null;
  }

  function textOf(tree) {
    if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
    if (!tree || typeof tree !== 'object') return '';
    return (tree.children ?? []).map(textOf).join(' ');
  }

  function mountUi({ language = 'zh', handler }) {
    let mod;
    let dictionaries;
    const slots = new Map();
    const states = [];
    const effects = [];
    let sIdx = 0;
    let eIdx = 0;
    const pendingFetches = new Set();

    const React = {
      createElement: (type, props, ...children) => ({
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
      }),
      useState: (init) => {
        const i = sIdx++;
        if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
        return [
          states[i],
          (val) => {
            states[i] = typeof val === 'function' ? val(states[i]) : val;
          },
        ];
      },
      useEffect: (cb, deps) => {
        const i = eIdx++;
        const prev = effects[i];
        const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, j) => !Object.is(d, prev.deps[j]));
        effects[i] = { deps, callback: cb, cleanup: prev?.cleanup, pending: changed };
      },
    };

    const sandbox = {
      window: {
        __ModuleLoader__: {
          load: (entry) => {
            mod = entry.factory(() => React);
          },
        },
      },
      document: { visibilityState: 'visible', hidden: false, addEventListener() {}, removeEventListener() {} },
      console,
      AbortController,
      setTimeout: () => 1,
      clearTimeout() {},
      setInterval: () => { throw new Error('no setInterval'); },
      clearInterval() {},
      fetch: (_url, options) => {
        const payload = JSON.parse(options.body);
        const task = (async () => {
          const value = await handler(payload);
          return { status: 200, text: async () => JSON.stringify({ ok: true, value }) };
        })();
        pendingFetches.add(task);
        void task.finally(() => pendingFetches.delete(task));
        return task;
      },
    };

    vm.runInNewContext(clientSource, sandbox);
    mod.apply({
      slots: {
        inject: (_name, fn) => fn(),
        register: (desc, comp) => {
          slots.set(desc.name, comp);
          return () => {};
        },
      },
      effect: (cb) => cb(),
      locale: {
        register: (_ns, dicts) => {
          dictionaries = dicts;
          return () => {};
        },
        bind: () => (k) => dictionaries[language][k],
      },
    });

    const mountSlot = (slotName) => {
      const Comp = slots.get(slotName);
      sIdx = 0;
      eIdx = 0;
      states.length = 0;
      effects.length = 0;
      let lastProps = {};
      const render = (props = lastProps) => {
        lastProps = props;
        sIdx = 0;
        eIdx = 0;
        const tree = Comp(props);
        for (const e of effects) {
          if (e?.pending) {
            e.pending = false;
            e.cleanup?.();
            e.cleanup = e.callback();
          }
        }
        return tree;
      };
      const settle = async (props = {}) => {
        render(props);
        for (let i = 0; i < 6; i += 1) {
          if (pendingFetches.size > 0) await Promise.all([...pendingFetches]);
          await new Promise((resolve) => setImmediate(resolve));
          render(lastProps);
        }
        return render(lastProps);
      };
      return { render, settle };
    };

    return { mountSlot };
  }

  for (const lang of ['zh', 'en']) {
    const conflictPayload = {
      detected: true,
      kind: 'both',
      activePlugin: true,
      proxyResidue: true,
      signals: ['bili_config_enabled', 'bili_proxy_preflight_413'],
      restartRecommended: true,
      lastSignalCode: 'BILI_PROXY_CONFLICT',
    };

    const dockUi = mountUi({
      language: lang,
      handler: async () => ({ active: false, phase: 'idle', biliConflict: conflictPayload }),
    });
    const dock = dockUi.mountSlot('conversation.input.dock');
    let tree = await dock.settle({ sessionId: 's-bili' });
    const modal = find(tree, (n) => n.props?.['data-bili-conflict-modal'] === 'both');
    const banner = find(tree, (n) => n.props?.['data-bili-conflict-banner'] === 'both');
    assert.ok(modal, `expected foreground conflict modal (${lang})`);
    assert.equal(modal.props.role, 'alertdialog');
    assert.ok(banner, `expected persistent conflict banner (${lang})`);
    const modalText = textOf(modal);
    assert.match(modalText, /billion-context/);
    assert.match(modalText, /baseUrl/);
    assert.match(modalText, /\/compact migrate/);
    assert.match(modalText, lang === 'zh' ? /重启/ : /restart/i);

    // Dismiss hides modal while keeping persistent banner, and reopen brings modal back
    const dismissBtn = find(tree, (n) => n.props?.['data-bili-conflict-dismiss'] === 'true');
    assert.ok(dismissBtn);
    dismissBtn.props.onClick();
    tree = dock.render({ sessionId: 's-bili' });
    assert.equal(find(tree, (n) => n.props?.['data-bili-conflict-modal'] !== undefined), null);
    const reopenBtn = find(tree, (n) => n.props?.['data-bili-conflict-reopen'] === 'true');
    assert.ok(reopenBtn);
    reopenBtn.props.onClick();
    tree = dock.render({ sessionId: 's-bili' });
    assert.ok(find(tree, (n) => n.props?.['data-bili-conflict-modal'] === 'both'));

    // Settings section renders warning banner when rpc('get') reports biliConflict
    const settingsUi = mountUi({
      language: lang,
      handler: async (payload) =>
        payload.method === 'get'
          ? { config: { summaryConcurrency: 2 }, biliConflict: conflictPayload }
          : { providers: [] },
    });
    const sec = settingsUi.mountSlot('settings.section');
    const secTree = await sec.settle({});
    const secWarn = find(secTree, (n) => n.props?.['data-settings-bili-conflict'] === 'both');
    assert.ok(secWarn, `expected Settings bili warning banner (${lang})`);
    assert.match(textOf(secWarn), lang === 'zh' ? /重启/ : /restart/i);
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
