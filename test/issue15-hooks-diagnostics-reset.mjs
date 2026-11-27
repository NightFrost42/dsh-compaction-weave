import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import {
  POST_COMPACT_EVENT,
  PRE_COMPACT_EVENT,
  runPostCompactHooks,
  runPreCompactHooks,
} from '../lib/hooks.js';
import { apply as mountGate, SUMMARY_RPC_PATH } from '../lib/index.js';
import { apply as mountEngine } from '../lib/engine-entry.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { resolveConfig } from '../lib/config.js';
import { decorateCompactCommand, parseCompactSubcommand } from '../lib/command-compact.js';
import {
  FailureDiagnostics,
  classifyRuntimeError,
  diagnosticFor,
  failureExplanation,
} from '../lib/failure-diagnostics.js';
import { SessionStateStore } from '../lib/state.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { buildCompactionInstruction } from '../lib/prompt.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({
      name,
      pass: false,
      error: error?.message ?? String(error),
      stack: error?.stack,
    });
  }
}

const TEST_BASE = process.env.WEAVE_TEST_ROOT ?? tmpdir();
const EN_HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeSummary(section9 = 'Continue work cleanly.') {
  return EN_HEADINGS.map((h, i) =>
    `${h}\n${i === 5 ? '[filled by engine]' : i === 8 ? section9 : 'Historical details archived.'}`,
  ).join('\n\n');
}

function createStrictReflectProxy(target, allowedProps = new Set()) {
  const deniedError = (prop) =>
    new Error(`cannot get property "${typeof prop === 'symbol' ? prop.toString() : String(prop)}" without inject`);

  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === Symbol.toStringTag || prop === Symbol.for('nodejs.util.inspect.custom')) {
        return Reflect.get(obj, prop, receiver);
      }
      if (allowedProps.has(prop)) {
        const value = Reflect.get(obj, prop, receiver);
        return typeof value === 'function' ? value.bind(obj) : value;
      }
      throw deniedError(prop);
    },
  });
}

function createSessionFixture({ cwd } = {}) {
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  let clock = Date.now() - 60_000;

  const session = {
    id: `sess-${randomUUID()}`,
    header: {
      version: 4,
      id: 'placeholder',
      createdAt: clock,
      isSeeded: false,
      ...(cwd ? { cwd } : {}),
    },
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
      if (event.type === 'system/message') return event.data.message;
      if (event.type === 'user/message') return event.data;
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
      return undefined;
    },
    append(type, data, options = {}) {
      clock += 10;
      const event = {
        seq: events.length,
        time: typeof options.time === 'number' ? options.time : clock,
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
        assert.ok(start >= 0 && end >= start, `invalid replace range ${op.startSeq}..${op.endSeq}`);
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

  return { session, events, surface, addSystem, addUser, addAssistant };
}

function createTokenMeter() {
  return {
    measure(s) {
      const nodes = s.surface.nodes.map((seq) => {
        const msg = s.deriveEventMessage(s.eventAt(seq));
        const tokens = Math.max(1, approxTokens(blocksToText(msg?.content)));
        return { seq, tokens, heuristicTokens: tokens };
      });
      return {
        totalTokens: nodes.reduce((sum, n) => sum + n.tokens, 0),
        surfaceTokens: nodes.reduce((sum, n) => sum + n.tokens, 0),
        nodes,
        baseline: { kind: 'heuristic' },
      };
    },
    estimateMessage(message) {
      return Math.max(1, approxTokens(blocksToText(message?.content)));
    },
  };
}

function createRpcInvoker(routeHandler) {
  return async (method, params = {}) => {
    const req = new EventEmitter();
    req.method = 'POST';
    req.socket = { remoteAddress: '127.0.0.1' };
    req.headers = { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080', 'content-type': 'application/json' };
    req.destroy = () => {};
    let resolvedBody = '';
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      end(body) {
        resolvedBody = String(body ?? '');
      },
    };
    const promise = routeHandler(req, res);
    req.emit('data', Buffer.from(JSON.stringify({ method, params })));
    req.emit('end');
    await promise;
    return JSON.parse(resolvedBody);
  };
}

// ── Suite A: Cordis ReflectService Proxy Safety & Hook Bus Bridge ─────────────

await test('A1-strict-proxy-never-throws-in-runPreCompactHooks-or-runPostCompactHooks', async () => {
  const warningsLogged = [];
  // Case 1: ctx.root throws ReflectService error, but ctx.events is directly accessible
  const listeners = new Map();
  const proxyWithEvents = createStrictReflectProxy(
    {
      events: {
        dispatch(_mode, args) {
          const eventName = args.shift();
          return (listeners.get(eventName) ?? []).map((fn) => fn.bind(null));
        },
      },
    },
    new Set(['events']),
  );
  listeners.set(PRE_COMPACT_EVENT, [
    (payload) => ({ additionalContext: `ok:${payload.sessionId}`, focusInstruction: 'keep invariants' }),
  ]);
  listeners.set(POST_COMPACT_EVENT, [
    (payload) => ({ notice: `post:${payload.sessionId}` }),
  ]);

  const pre1 = await runPreCompactHooks(proxyWithEvents, { sessionId: 's-proxy-1' });
  assert.equal(pre1.cancelled, false);
  assert.equal(pre1.additionalContext, 'ok:s-proxy-1');
  assert.equal(pre1.focusInstruction, 'keep invariants');
  assert.deepEqual(pre1.warnings, []);

  const post1 = await runPostCompactHooks(proxyWithEvents, { sessionId: 's-proxy-1' });
  assert.deepEqual(post1.notices, ['post:s-proxy-1']);
  assert.deepEqual(post1.warnings, []);

  // Case 2: EVERY property on ctx throws (root, Symbol.for('cordis.root'), events, serial, parallel, listeners, emit, logger)
  const totalDenyProxy = createStrictReflectProxy({}, new Set());
  const preOpen = await runPreCompactHooks(
    totalDenyProxy,
    { sessionId: 's-proxy-2' },
    { log: (lvl, msg) => warningsLogged.push({ lvl, msg }) },
  );
  assert.equal(preOpen.cancelled, false);
  assert.equal(preOpen.warnings.length, 1);
  assert.match(preOpen.warnings[0], /without inject/);
  assert.ok(warningsLogged.some((w) => w.lvl === 'warn' && /without inject/.test(w.msg)));

  // Even when logger also throws inside ctx and no log option is provided, it still never throws
  const preSilent = await runPreCompactHooks(totalDenyProxy, { sessionId: 's-proxy-2b' });
  assert.equal(preSilent.cancelled, false);
  assert.equal(preSilent.warnings.length, 1);

  const preClosed = await runPreCompactHooks(
    totalDenyProxy,
    { sessionId: 's-proxy-3' },
    { failClosed: true },
  );
  assert.equal(preClosed.cancelled, true);
  assert.match(preClosed.reason, /without inject/);

  const postOpen = await runPostCompactHooks(totalDenyProxy, { sessionId: 's-proxy-4' });
  assert.deepEqual(postOpen.notices, []);
  assert.equal(postOpen.warnings.length, 1);
  assert.match(postOpen.warnings[0], /without inject/);
});

await test('A2-isolated-engine-uses-top-level-hookBus-without-touching-ctx-root-and-survives-standalone-proxy', async () => {
  const root = mkdtempSync(join(TEST_BASE, 'weave-issue15-hooks-'));
  const priorHome = process.env.DSH_HOME;
  const home = join(root, 'dsh-home');
  process.env.DSH_HOME = home;
  mkdirSync(home, { recursive: true });

  const disposers = [];
  let standaloneEngine;
  try {
    // Setup Cordis-like top-level app ctx (external listener outside isolated group)
    const rootListeners = new Map();
    const services = new Map();
    const pendingInjects = [];
    const receivedEvents = [];

    const deliverInjects = () => {
      for (let i = pendingInjects.length - 1; i >= 0; i -= 1) {
        const entry = pendingInjects[i];
        if (entry.deps.every((d) => services.has(d))) {
          pendingInjects.splice(i, 1);
          const sub = createStrictReflectProxy(
            {
              ...Object.fromEntries(entry.deps.map((d) => [d, services.get(d)])),
              logger: { info() {}, warn() {}, error() {}, debug() {} },
            },
            new Set([...entry.deps, 'logger']),
          );
          const d = entry.fn(sub);
          if (typeof d === 'function') disposers.push(d);
        }
      }
    };

    const llmCalls = [];
    const llm = {
      resolveModelInfo: async () => ({ contextWindow: 128000, maxOutputTokens: 4096 }),
      async *stream(req) {
        llmCalls.push(req);
        yield { type: 'text-delta', text: makeSummary() };
        yield { type: 'finish', kind: 'stop', usage: { inputTokens: 80, outputTokens: 40 } };
      },
    };
    const tokenMeter = createTokenMeter();
    const sessions = { flush: async () => true, get: () => null };
    services.set('llm', llm);
    services.set('tokenMeter', tokenMeter);
    services.set('sessions', sessions);

    // Register external plugin listeners on top-level event bus
    const regListener = (ev, fn) => {
      if (!rootListeners.has(ev)) rootListeners.set(ev, []);
      rootListeners.get(ev).push(fn);
    };
    regListener(PRE_COMPACT_EVENT, (payload) => {
      receivedEvents.push({ type: 'pre', sessionId: payload.sessionId });
      return {
        focusInstruction: 'keep external hook rule',
        additionalContext: 'external context detail',
      };
    });
    regListener(POST_COMPACT_EVENT, (payload) => {
      receivedEvents.push({ type: 'post', compactionId: payload.compactionId });
      return { notice: 'post hook ok' };
    });

    const topRawCtx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      events: {
        dispatch(_mode, args) {
          const ev = args.shift();
          return (rootListeners.get(ev) ?? []).map((fn) => fn.bind(null));
        },
      },
      on() {
        return () => {};
      },
      effect(cb) {
        return typeof cb === 'function' ? cb() : () => {};
      },
      provide(name, value) {
        services.set(name, value);
        deliverInjects();
      },
      get(name) {
        return services.get(name);
      },
      inject(deps, fn) {
        if (deps.every((d) => services.has(d))) {
          const sub = createStrictReflectProxy(
            {
              ...Object.fromEntries(deps.map((d) => [d, services.get(d)])),
              logger: { info() {}, warn() {}, error() {}, debug() {} },
            },
            new Set([...deps, 'logger']),
          );
          const d = fn(sub);
          if (typeof d === 'function') disposers.push(d);
          return () => {};
        }
        pendingInjects.push({ deps, fn });
        return () => {};
      },
    };
    // Even topCtx refuses `.root` to simulate strict Cordis!
    const topProxyCtx = createStrictReflectProxy(
      topRawCtx,
      new Set(['logger', 'events', 'on', 'effect', 'provide', 'get', 'inject']),
    );
    const unmountGate = mountGate(topProxyCtx, {
      mode: 'replace',
      engine: {
        archiveDir: join(root, 'archive'),
        summaryRetryCount: 0,
        summaryConcurrency: 1,
        observationMaskingEnabled: false,
        proactiveEnabled: false,
      },
    });
    if (typeof unmountGate === 'function') disposers.push(unmountGate);

    const runtime = services.get('compactionWeaveRuntime');
    assert.ok(runtime?.hookBus, 'top-level compactionWeaveRuntime must expose hookBus');

    // Now mount engine inside an isolated child Proxy ctx where root, events, and Symbol(cordis.root) all THROW!
    const providedByEngine = new Map();
    const isolatedRawCtx = {
      llm,
      tokenMeter,
      sessions,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      get(k) {
        return services.get(k);
      },
      on() {
        return () => {};
      },
      effect(cb) {
        return typeof cb === 'function' ? cb() : () => {};
      },
      provide(name, value) {
        providedByEngine.set(name, value);
      },
      inject(deps, fn) {
        if (deps.every((d) => services.has(d))) {
          const sub = createStrictReflectProxy(
            {
              ...Object.fromEntries(deps.map((d) => [d, services.get(d)])),
              logger: { info() {}, warn() {}, error() {}, debug() {} },
            },
            new Set([...deps, 'logger']),
          );
          const d = fn(sub);
          if (typeof d === 'function') disposers.push(d);
          return () => {};
        }
        pendingInjects.push({ deps, fn });
        return () => {};
      },
    };
    const isolatedProxyCtx = createStrictReflectProxy(
      isolatedRawCtx,
      new Set(['llm', 'tokenMeter', 'sessions', 'logger', 'get', 'on', 'provide', 'inject']),
    );
    const unmountEngine = mountEngine(isolatedProxyCtx, {
      archiveDir: join(root, 'archive'),
      summaryRetryCount: 0,
      summaryConcurrency: 1,
      observationMaskingEnabled: false,
      proactiveEnabled: false,
    });
    if (typeof unmountEngine === 'function') disposers.push(unmountEngine);

    const engine = runtime.getDefaultEngine();
    assert.ok(engine);
    assert.equal(engine.hookBus, runtime.hookBus);

    const f = createSessionFixture();
    f.addSystem('System prompt.');
    for (let i = 0; i < 8; i += 1) {
      f.addUser(`Topic ${i} background observation: benchmark telemetry data ${i}.`);
      f.addAssistant(`Topic ${i} analysis: recorded telemetry summary ${'y'.repeat(1200)}.`);
    }

    const res = await engine.compactNow({
      session: f.session,
      options: { provider: 'p', model: 'm' },
      runMaintenance: (fn) => fn(new AbortController().signal),
    });
    assert.ok(res?.compactionId, 'expected compaction to succeed under strict Proxy');
    assert.ok(receivedEvents.some((e) => e.type === 'pre' && e.sessionId === f.session.id));
    assert.ok(receivedEvents.some((e) => e.type === 'post' && e.compactionId === res.compactionId));
    assert.ok(
      JSON.stringify(llmCalls[0].messages).includes('keep external hook rule'),
      'expected pre-compact focusInstruction from top-level hookBus to reach summary request',
    );
    assert.ok(
      JSON.stringify(llmCalls[0].messages).includes('external context detail'),
      'expected pre-compact additionalContext from top-level hookBus to reach summary request',
    );

    // Standalone engine without runtime bridge, where ctx throws on root AND events AND logger
    const standaloneProxyCtx = createStrictReflectProxy(
      {
        llm,
        tokenMeter,
        sessions: { flush: async () => true, get: () => null },
        get: () => undefined,
        on() {
          return () => {};
        },
        provide() {},
      },
      new Set(['llm', 'tokenMeter', 'sessions', 'get', 'on', 'provide']),
    );
    standaloneEngine = new WeaveCompactionEngine(
      standaloneProxyCtx,
      resolveConfig({
        archiveDir: join(root, 'standalone-archive'),
        summaryRetryCount: 0,
        summaryConcurrency: 1,
        observationMaskingEnabled: false,
        proactiveEnabled: false,
      }).config,
    );
    const f2 = createSessionFixture();
    f2.addSystem('System.');
    for (let i = 0; i < 8; i += 1) {
      f2.addUser(`Standalone observation ${i}: benchmark trace sample ${i}.`);
      f2.addAssistant(`Standalone reply ${i}: recorded trace sample ${'w'.repeat(1200)}.`);
    }
    const standaloneRes = await standaloneEngine.compactNow({
      session: f2.session,
      options: { provider: 'p', model: 'm' },
      runMaintenance: (fn) => fn(new AbortController().signal),
    });
    assert.ok(standaloneRes?.compactionId, 'standalone engine with strict Proxy ctx must not crash on ctx.root or ctx.logger');
  } finally {
    standaloneEngine?.dispose?.();
    for (const d of disposers) {
      try { d(); } catch {}
    }
    if (priorHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Suite B: UNKNOWN Diagnostic Classification & Strict Privacy Redaction ─────

await test('B1-cordis-errors-classify-as-CORDIS_CONTEXT_ERROR-with-pluginFrame-and-clear-explanation', async () => {
  const root = mkdtempSync(join(TEST_BASE, 'weave-issue15-cordis-'));
  try {
    const diag = new FailureDiagnostics(root);
    const session = { id: 'sess-cordis-diag' };
    const cordisInternalFrame = '    at Object.get (/app/node_modules/@deepseek-ai/cordis/lib/index.js:1257:18)';
    const weaveFrame = '    at Module.runPreCompactHooks (file:///opt/plugins/dsh-compaction-weave/lib/hooks.js:174:15)';
    const userHomeFrame = `    at caller (${['C:', 'Users', 'private_dev', 'proj', 'main.js'].join('\\')}:10:2)`;

    const cases = [
      {
        msg: 'cannot get property "root" without inject',
        subReason: 'cordis_missing_inject:root',
        matchExplain: /"root".*lib\/hooks\.js:174:15/,
      },
      {
        msg: 'cannot set property "compaction" without provide',
        subReason: 'cordis_missing_provide:compaction',
        matchExplain: /"compaction".*lib\/hooks\.js:174:15/,
      },
      {
        msg: 'cannot get required service "sessions" in inactive context',
        subReason: 'cordis_inactive_service:sessions',
        matchExplain: /cordis_inactive_service:sessions/,
      },
      {
        msg: 'cannot create effect on inactive context',
        subReason: 'cordis_inactive_effect',
        matchExplain: /cordis_inactive_effect/,
      },
    ];

    for (const item of cases) {
      const err = new Error(item.msg);
      err.stack = [`Error: ${item.msg}`, cordisInternalFrame, weaveFrame, userHomeFrame].join('\n');
      assert.deepEqual(classifyRuntimeError(err), { code: 'CORDIS_CONTEXT_ERROR', subReason: item.subReason });

      const receipt = await diag.capture(session, err, { trigger: 'manual' });
      assert.equal(receipt.status, 'saved');
      assert.equal(receipt.code, 'CORDIS_CONTEXT_ERROR');
      const reportRaw = readFileSync(receipt.path, 'utf8');
      const report = JSON.parse(reportRaw);
      assert.equal(report.errors[0].code, 'CORDIS_CONTEXT_ERROR');
      assert.equal(report.errors[0].subReason, item.subReason);
      assert.equal(report.errors[0].pluginFrame, 'lib/hooks.js:174:15');
      assert.equal(report.errors[0].safeDetail, undefined);
      assert.doesNotMatch(reportRaw, /private_dev/);
      assert.doesNotMatch(reportRaw, /@deepseek-ai\/cordis/);

      const explain = failureExplanation(err);
      assert.match(explain, /CORDIS_CONTEXT_ERROR/);
      assert.match(explain, item.matchExplain);
      assert.doesNotMatch(explain, /private_dev/);
    }

    // Engine _extractFailureCode elevates CORDIS_CONTEXT_ERROR above UNKNOWN
    const engine = new WeaveCompactionEngine(
      { on() {}, provide() {}, logger: { info() {}, warn() {}, error() {}, debug() {} } },
      resolveConfig({ archiveDir: join(root, 'arch') }).config,
    );
    try {
      const wrapped = new Error('cannot get property "root" without inject');
      assert.equal(engine._extractFailureCode(wrapped, { code: 'UNKNOWN' }), 'CORDIS_CONTEXT_ERROR');
    } finally {
      engine.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test('B2-unknown-runtime-errors-emit-bounded-redacted-safeDetail-and-no-leaks', async () => {
  const root = mkdtempSync(join(TEST_BASE, 'weave-issue15-unknown-'));
  try {
    const diag = new FailureDiagnostics(root);
    const session = { id: 'sess-unknown-diag' };
    const winPath = ['C:', 'Users', 'secret_user', 'Documents', 'notes.txt'].join('\\');
    const posixPath = ['', 'home', 'secret_user', 'workspace', 'key.json'].join('/');
    const apiKey = 'sk-' + 'ConfidentialKey9876543210';
    const ghToken = 'ghp_' + 'ConfidentialGitHubToken999';
    const rawMsg =
      `Cannot read property "bar" via ${winPath} or ${posixPath} ` +
      `auth=${apiKey} Bearer TopSecretJwt.Payload.Sig ${ghToken} ` +
      `url=https://private.internal.example/v1/chat?secret=1 ` +
      `payload={"prompt":"PRIVATE CHAT MESSAGE"} "请帮我删掉生产数据库"`;

    const typeErr = new TypeError(rawMsg);
    typeErr.stack = [
      `TypeError: ${rawMsg}`,
      '    at Proxy.get (/tmp/other-lib/node_modules/foo/index.js:12:3)',
      '    at WeaveCompactionEngine.run (file:///usr/local/dsh-compaction-weave/lib/engine.js:4321:9)',
      `    at secretCaller (${winPath}:99:1)`,
    ].join('\n');

    const receipt = await diag.capture(session, typeErr, { trigger: 'automatic' });
    assert.equal(receipt.status, 'saved');
    assert.equal(receipt.code, 'UNKNOWN');
    const reportRaw = readFileSync(receipt.path, 'utf8');
    const report = JSON.parse(reportRaw);
    assert.equal(report.errors[0].code, 'UNKNOWN');
    assert.equal(report.errors[0].pluginFrame, 'lib/engine.js:4321:9');
    assert.ok(typeof report.errors[0].safeDetail === 'string' && report.errors[0].safeDetail.length > 0);
    assert.ok(report.errors[0].safeDetail.length <= 120);
    assert.match(report.errors[0].safeDetail, /Cannot read property "bar"/);

    for (const forbidden of [
      'secret_user',
      apiKey,
      ghToken,
      'TopSecretJwt',
      'private.internal.example',
      'PRIVATE CHAT MESSAGE',
      '请帮我删掉生产数据库',
    ]) {
      assert.equal(reportRaw.includes(forbidden), false, `report must not leak: ${forbidden}`);
      assert.equal(failureExplanation(typeErr).includes(forbidden), false, `explanation must not leak: ${forbidden}`);
    }
    assert.match(failureExplanation(typeErr), /位置=lib\/engine\.js:4321:9/);
    assert.match(failureExplanation(typeErr), /特征=/);

    // Normal coded error must NOT attach pluginFrame or safeDetail
    const coded = Object.assign(new Error('network reset at C:\\Users\\nobody'), { code: 'ECONNRESET' });
    const codedReceipt = await diag.capture(session, coded, { trigger: 'manual' });
    const codedReport = JSON.parse(readFileSync(codedReceipt.path, 'utf8'));
    assert.equal(codedReport.errors[0].code, 'ECONNRESET');
    assert.equal(codedReport.errors[0].pluginFrame, undefined);
    assert.equal(codedReport.errors[0].safeDetail, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Suite C: /compact reset, SessionStateStore.resetBreaker & Safety Guards ───

await test('C1-parseCompactSubcommand-handles-reset-vs-focus-cleanly', () => {
  assert.deepEqual(parseCompactSubcommand('reset'), { kind: 'reset' });
  assert.deepEqual(parseCompactSubcommand('RESET'), { kind: 'reset' });
  assert.deepEqual(parseCompactSubcommand({ rawInput: '/compact reset' }), { kind: 'reset' });
  assert.deepEqual(parseCompactSubcommand({ rawInput: '  /compact   reset  ' }), { kind: 'reset' });
  assert.deepEqual(parseCompactSubcommand('reset auth'), { kind: 'focus', focusInstruction: 'reset auth' });
  assert.deepEqual(parseCompactSubcommand('-- reset'), { kind: 'focus', focusInstruction: 'reset' });
  assert.deepEqual(parseCompactSubcommand({ rawInput: '/compact -- reset notes' }), {
    kind: 'focus',
    focusInstruction: 'reset notes',
  });
});

await test('C2-compact-reset-clears-breaker-preserves-window-and-resumable-and-rebuilds-STATE_INVALID', async () => {
  const root = mkdtempSync(join(TEST_BASE, 'weave-issue15-reset-'));
  const priorHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'dsh-home');
  let engine;
  try {
    const f = createSessionFixture();
    f.addSystem('System.');
    f.addUser('Keep strict API compatibility.');
    f.addAssistant('Understood.');

    const ctx = {
      llm: {
        resolveModelInfo: async () => ({ contextWindow: 128000, maxOutputTokens: 4096 }),
        async *stream() {
          yield { type: 'text-delta', text: makeSummary() };
          yield { type: 'finish', kind: 'stop' };
        },
      },
      tokenMeter: createTokenMeter(),
      sessions: { flush: async () => true, get: (id) => (id === f.session.id ? f.session : null) },
      on() {
        return () => {};
      },
      provide() {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    };
    engine = new WeaveCompactionEngine(
      ctx,
      resolveConfig({ archiveDir: join(root, 'archive'), failureThreshold: 3 }).config,
    );

    const savedWindow = { safetyWindow: 65536, window: 128000, source: 'provider' };
    const savedResumable = {
      version: 1,
      jobId: 'job-preserve-1',
      trigger: 'manual',
      status: 'interrupted',
      interruptReason: 'paused',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      remainingSeqs: [1, 2],
      remainingSourceSha256: null,
      initialTotalNodes: 4,
      completedNodes: 2,
      initialTotalTokens: 1000,
      completedTokens: 500,
      completedChunks: 1,
      waveCount: 1,
      batchCheckpointSeqs: [3],
      allowForeignFallback: false,
      checkpointMeta: null,
      originalBackupId: null,
      consecutiveFailures: 0,
      lastErrorCode: null,
      lastErrorMessage: null,
    };

    engine.sessionState.update(f.session.id, () => ({
      failures: 3,
      stopped: true,
      breakerBypassed: true,
      bypassed: true,
      bypassedAt: '2026-01-01T00:02:00.000Z',
      lastFailureCode: 'ECONNRESET',
      lastFailureAt: '2026-01-01T00:02:00.000Z',
      lastDiagnosticId: 'diag-issue15',
      lastDiagnosticPath: '/tmp/diag-issue15.json',
      window: savedWindow,
      resumableCompaction: savedResumable,
    }));
    engine._restoreState(f.session);
    assert.equal(engine._stopped.has(f.session.id), true);
    assert.equal(engine._failures.get(f.session.id), 3);

    const cmd = decorateCompactCommand(
      { name: 'compact', async handler() { return { kind: 'success', text: 'stock' }; } },
      engine,
    );
    const out1 = await cmd.handler({
      agent: { session: f.session },
      commandId: 'cmd-reset-1',
      rawInput: '/compact reset',
      signal: new AbortController().signal,
    });
    assert.equal(out1.kind, 'success');
    assert.match(out1.text, /清零/);
    assert.match(out1.text, /stopped/);

    const afterState = engine.sessionState.read(f.session.id);
    assert.equal(afterState.failures, 0);
    assert.equal(afterState.stopped, false);
    assert.equal(afterState.breakerBypassed, false);
    assert.equal(afterState.lastFailureCode, null);
    assert.equal(afterState.lastDiagnosticId, null);
    assert.equal(afterState.lastDiagnosticPath, null);
    assert.equal(Object.hasOwn(afterState, 'lastFailureAt'), false);
    assert.equal(Object.hasOwn(afterState, 'bypassed'), false);
    assert.deepEqual(afterState.window, savedWindow);
    assert.deepEqual(afterState.resumableCompaction, savedResumable);
    assert.equal(engine._stopped.has(f.session.id), false);
    assert.equal(engine._failures.has(f.session.id), false);

    // Second reset cleanly reports already clean state
    const out2 = await cmd.handler({
      agent: { session: f.session },
      commandId: 'cmd-reset-2',
      rawInput: '/compact reset',
      signal: new AbortController().signal,
    });
    assert.equal(out2.kind, 'success');
    assert.match(out2.text, /无需重置/);

    // Corrupt state file (checksum mismatch -> STATE_INVALID) with no pending journal -> rebuilt atomically
    const stateFile = engine.sessionState.file(f.session.id);
    const badRecord = JSON.parse(readFileSync(stateFile, 'utf8'));
    badRecord.data.failures = 99; // tampers checksum without updating checksum
    writeFileSync(stateFile, JSON.stringify(badRecord) + '\n', 'utf8');
    assert.throws(() => engine.sessionState.read(f.session.id), (err) => err?.code === 'STATE_INVALID');

    const outRebuilt1 = await cmd.handler({
      agent: { session: f.session },
      commandId: 'cmd-reset-3',
      rawInput: '/compact reset',
      signal: new AbortController().signal,
    });
    assert.equal(outRebuilt1.kind, 'success');
    assert.match(outRebuilt1.text, /STATE_INVALID/);
    const rebuiltState = engine.sessionState.read(f.session.id);
    assert.equal(rebuiltState.failures, 0);
    assert.equal(rebuiltState.stopped, false);

    // Broken JSON syntax -> STATE_UNAVAILABLE with SyntaxError cause -> rebuilt atomically
    writeFileSync(stateFile, '{not valid json', 'utf8');
    assert.throws(() => engine.sessionState.read(f.session.id), (err) => err?.code === 'STATE_UNAVAILABLE');
    const outRebuilt2 = await cmd.handler({
      agent: { session: f.session },
      commandId: 'cmd-reset-4',
      rawInput: '/compact reset',
      signal: new AbortController().signal,
    });
    assert.equal(outRebuilt2.kind, 'success');
    assert.match(outRebuilt2.text, /STATE_INVALID/);
    assert.equal(engine.sessionState.read(f.session.id).failures, 0);
  } finally {
    engine?.dispose();
    if (priorHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
  }
});

await test('C3-compact-reset-guards-active-lock-and-pending-journal-plus-reset-breaker-RPC', async () => {
  const root = mkdtempSync(join(TEST_BASE, 'weave-issue15-guards-'));
  const priorHome = process.env.DSH_HOME;
  const home = join(root, 'dsh-home');
  process.env.DSH_HOME = home;
  mkdirSync(home, { recursive: true });
  const disposers = [];
  try {
    const f = createSessionFixture();
    f.addSystem('System.');
    f.addUser('Hello');
    f.addAssistant('Hi');

    let registeredRoute = null;
    const services = new Map();
    const pendingInjects = [];
    const sessions = {
      flush: async () => true,
      get: (id) => (id === f.session.id ? f.session : null),
    };
    const llm = {
      resolveModelInfo: async () => ({ contextWindow: 128000, maxOutputTokens: 4096 }),
      async *stream() {
        yield { type: 'text-delta', text: makeSummary() };
        yield { type: 'finish', kind: 'stop' };
      },
    };
    const tokenMeter = createTokenMeter();
    services.set('sessions', sessions);
    services.set('llm', llm);
    services.set('tokenMeter', tokenMeter);
    services.set('connection', { requestRejection: () => undefined });
    services.set('webServer', {
      register(spec) {
        if (spec.path === SUMMARY_RPC_PATH) registeredRoute = spec.handler;
        return () => {};
      },
    });

    const deliverInjects = () => {
      for (let i = pendingInjects.length - 1; i >= 0; i -= 1) {
        const entry = pendingInjects[i];
        if (entry.deps.every((d) => services.has(d))) {
          pendingInjects.splice(i, 1);
          const d = entry.fn({
            logger: { info() {}, warn() {}, error() {}, debug() {} },
            effect: (cb) => cb(),
            ...Object.fromEntries(entry.deps.map((dKey) => [dKey, services.get(dKey)])),
            provide: (k, v) => { services.set(k, v); deliverInjects(); },
          });
          if (typeof d === 'function') disposers.push(d);
        }
      }
    };

    const makeCtx = () => ({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      on() { return () => {}; },
      effect: (cb) => cb(),
      get: (k) => services.get(k),
      provide(k, v) { services.set(k, v); deliverInjects(); },
      inject(deps, fn) {
        if (deps.every((d) => services.has(d))) {
          const d = fn({
            logger: { info() {}, warn() {}, error() {}, debug() {} },
            effect: (cb) => cb(),
            ...Object.fromEntries(deps.map((dKey) => [dKey, services.get(dKey)])),
            provide: (k, v) => { services.set(k, v); deliverInjects(); },
          });
          if (typeof d === 'function') disposers.push(d);
          return () => {};
        }
        pendingInjects.push({ deps, fn });
        return () => {};
      },
    });

    const dGate = mountGate(makeCtx(), {
      mode: 'replace',
      engine: { archiveDir: join(root, 'archive'), failureThreshold: 3 },
    });
    if (typeof dGate === 'function') disposers.push(dGate);
    const dEngine = mountEngine(makeCtx(), { archiveDir: join(root, 'archive'), failureThreshold: 3 });
    if (typeof dEngine === 'function') disposers.push(dEngine);

    const runtime = services.get('compactionWeaveRuntime');
    const engine = runtime.getDefaultEngine();
    assert.ok(registeredRoute, 'expected RPC route mounted');
    const rpc = createRpcInvoker(registeredRoute);
    const cmd = decorateCompactCommand(
      { name: 'compact', async handler() { return { kind: 'success', text: 'stock' }; } },
      engine,
    );

    // Trip circuit breaker
    engine.sessionState.update(f.session.id, () => ({ failures: 3, stopped: true, lastFailureCode: 'ECONNRESET' }));
    engine._restoreState(f.session);

    // Guard 1: Busy lock rejects without mutating state
    engine._busy.add(f.session);
    const busyRes = await cmd.handler({
      agent: { session: f.session },
      commandId: 'cmd-busy',
      rawInput: '/compact reset',
      signal: new AbortController().signal,
    });
    assert.equal(busyRes.kind, 'error');
    assert.match(busyRes.text, /正在运行/);
    assert.equal(engine.sessionState.read(f.session.id).stopped, true);
    const busyRpc = await rpc('reset-breaker', { sessionId: f.session.id });
    assert.equal(busyRpc.ok, false);
    assert.equal(busyRpc.error.code, 'busy');
    engine._busy.delete(f.session);

    // Guard 2: Pending journal + tampered state refuses with RECOVERY_REQUIRED and leaves BOTH untouched
    const stateFile = engine.sessionState.file(f.session.id);
    const tampered = JSON.parse(readFileSync(stateFile, 'utf8'));
    tampered.checksum = '0'.repeat(64);
    writeFileSync(stateFile, JSON.stringify(tampered) + '\n', 'utf8');
    await engine.journal.record({ sessionId: f.session.id, compactionId: 'c-pend-1', phase: 'started' });

    const pendRes = await cmd.handler({
      agent: { session: f.session },
      commandId: 'cmd-pend',
      rawInput: '/compact reset',
      signal: new AbortController().signal,
    });
    assert.equal(pendRes.kind, 'error');
    assert.match(pendRes.text, /RECOVERY_REQUIRED/);
    const pendRpc = await rpc('reset-breaker', { sessionId: f.session.id });
    assert.equal(pendRpc.ok, false);
    assert.equal(pendRpc.error.code, 'RECOVERY_REQUIRED');
    // Still tampered & still pending
    assert.throws(() => engine.sessionState.read(f.session.id), (err) => err?.code === 'STATE_INVALID');
    assert.equal((await engine.journal.pending(f.session.id)).length, 1);

    // Clear journal, restore stopped state via RPC `reset-breaker`
    await engine.journal.clear(f.session.id, 'c-pend-1');
    engine._stopped.set(f.session.id, true);
    engine._failures.set(f.session.id, 3);
    const rpcOk = await rpc('reset-breaker', { sessionId: f.session.id });
    assert.equal(rpcOk.ok, true);
    assert.equal(rpcOk.value.rebuilt, true);
    assert.equal(rpcOk.value.stopped, false);
    assert.equal(rpcOk.value.failures, 0);
    assert.equal(engine._stopped.has(f.session.id), false);
    assert.equal(engine._failures.has(f.session.id), false);

    // Direct store-level sanity check: IO/non-Syntax errors stay fail-closed in SessionStateStore.resetBreaker
    const store = new SessionStateStore(join(root, 'direct-state'));
    const directRes = store.resetBreaker('never-seen');
    assert.equal(directRes.reset, false);
    assert.equal(directRes.rebuilt, false);
    assert.equal(directRes.state.failures, 0);
  } finally {
    for (const d of disposers) {
      try { d(); } catch {}
    }
    if (priorHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
  }
});

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
console.log(JSON.stringify({ passed, failed, results }, null, 2));
if (failed > 0) process.exitCode = 1;
