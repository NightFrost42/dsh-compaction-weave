import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as mountGate, SUMMARY_RPC_PATH, renameOfficialRows } from '../lib/index.js';
import { apply as mountEngine } from '../lib/engine-entry.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { decorateCompactCommand } from '../lib/command-compact.js';
import { resolveConfig } from '../lib/config.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { buildCompactionInstruction } from '../lib/prompt.js';
import { detectBiliSession } from '../lib/foreign-fold.js';
import { OBSERVATION_MASK_MARKER } from '../lib/observation-mask.js';
import { StockTransactionAdapter } from '../lib/transaction.js';
import { SessionBackupStore, applyPendingRestoreBeforeOpen } from '../lib/session-backup.js';

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

function makeStructuredSummary(bodyNote = 'Archived progress; continuing task.') {
  return EN_HEADINGS.map((h, idx) =>
    `${h}\n${idx === 5 ? '[filled by engine]' : idx === 8 ? bodyNote : 'Evidence archived; continuing task.'}`,
  ).join('\n\n');
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function makeSessionFixture({
  id = `sess-${randomUUID()}`,
  sessionDir,
  rawFilename = 'session.v4.jsonl.zstd',
  initialRawBytes,
} = {}) {
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const logPath = sessionDir ? join(sessionDir, rawFilename) : null;
  if (sessionDir && logPath) {
    mkdirSync(sessionDir, { recursive: true });
    // Simulated Zstandard frame magic + payload bytes so backup/restore verifies raw-byte fidelity.
    const bytes = initialRawBytes ?? Buffer.concat([
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
      Buffer.from(`{"version":4,"id":"${id}"}\n`, 'utf8'),
    ]);
    writeFileSync(logPath, bytes);
  }
  const syncRawLog = () => {
    if (!logPath) return;
    const prefix = rawFilename.endsWith('.zstd') ? Buffer.from([0x28, 0xb5, 0x2f, 0xfd]) : Buffer.alloc(0);
    const payload = Buffer.from(
      JSON.stringify({ version: 4, id, events: events.length, replaceGeneration: surface.replaceGeneration }) + '\n',
      'utf8',
    );
    writeFileSync(logPath, Buffer.concat([prefix, payload]));
  };

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
        assert.ok(a >= 0 && b >= a, `invalid surface replace ${op.startSeq}..${op.endSeq}`);
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

  const addUser = (text, source = { kind: 'user' }, extraBlocks = []) =>
    session.append(
      'user/message',
      { id: randomUUID(), role: 'user', content: [{ type: 'text', text }, ...extraBlocks], source },
      { surfaceOp: 'append' },
    );

  const addAssistant = (text, toolCalls = []) =>
    session.append(
      'assistant/message',
      {
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [
            ...(text ? [{ type: 'text', text }] : []),
            ...toolCalls,
          ],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
      { surfaceOp: 'append' },
    );

  const addToolPair = (toolName, args, outputText, { callId = `call-${randomUUID()}`, isError = false, extraBlocks = [] } = {}) => {
    const callEvent = session.append('tool/call', { callId, name: toolName, arguments: JSON.stringify(args) });
    const assistantEvent = addAssistant('', [{ type: 'tool-call', id: callId, callId, name: toolName, toolName, arguments: args, args }]);
    const resultEvent = session.append(
      'tool/result',
      {
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: callId,
          content: [{ type: 'text', text: outputText }, ...extraBlocks],
          source: { kind: 'tool-result', callId },
          ...(isError ? { isError: true } : {}),
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] },
    );
    return { callEvent, assistantEvent, resultEvent, callId };
  };

  return { session, events, surface, logPath, syncRawLog, addSystem, addUser, addAssistant, addToolPair };
}

function makeFullHostFixture({
  home,
  windowTokens = 200000,
  extraEngineConfig = {},
  streamHandler,
} = {}) {
  const sessionsMap = new Map();
  const writersMap = new Map();
  const logPathsById = new Map();
  const eventListeners = new Map();
  const services = new Map();
  const pendingInjects = [];
  let registeredRoute = null;
  const warnings = [];
  const calls = [];

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
      const text = makeStructuredSummary();
      const mid = Math.floor(text.length / 2);
      yield { type: 'text-delta', text: text.slice(0, mid) };
      yield { type: 'text-delta', text: text.slice(mid) };
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

  const tryDeliverInjects = () => {
    for (let i = pendingInjects.length - 1; i >= 0; i -= 1) {
      const item = pendingInjects[i];
      if (item.deps.every((d) => services.has(d))) {
        pendingInjects.splice(i, 1);
        const subCtx = makeCtx(item.deps);
        item.fn(subCtx);
      }
    }
  };

  const makeCtx = (allowed = null) => ({
    logger: {
      info() {},
      warn(msg) {
        warnings.push(String(msg));
      },
    },
    effect(cb) {
      const d = cb();
      return typeof d === 'function' ? d : () => {};
    },
    on(name, fn) {
      const list = eventListeners.get(name) ?? [];
      list.push(fn);
      eventListeners.set(name, list);
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
      if (deps.every((d) => services.has(d))) {
        return fn(makeCtx(deps));
      }
      pendingInjects.push({ deps, fn });
      return () => {};
    },
    get sessions() {
      return services.get('sessions');
    },
    get sessionPersistence() {
      return services.get('sessionPersistence');
    },
    get llm() {
      return services.get('llm');
    },
    get tokenMeter() {
      return services.get('tokenMeter');
    },
    get webServer() {
      return services.get('webServer');
    },
    get compactionWeaveRuntime() {
      return services.get('compactionWeaveRuntime');
    },
    get compactionWeaveTransactions() {
      return services.get('compactionWeaveTransactions');
    },
    _allowed: allowed,
  });

  const priorHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const archiveDir = join(home, 'storages', 'dsh-compaction-weave', 'sessions');
  const rootCtx = makeCtx();
  const disposeGate = mountGate(rootCtx, {
    engine: { archiveDir, ...extraEngineConfig },
    receiptPath: join(home, 'storages', 'dsh-compaction-weave', 'gate-receipts.jsonl'),
  });
  const engineCtx = makeCtx();
  const disposeEngine = mountEngine(engineCtx, {
    archiveDir,
    language: 'en',
    ...extraEngineConfig,
  });
  const engine = services.get('compaction');
  engine.historyToolsAvailable = true;

  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      if (!registeredRoute) {
        reject(new Error('RPC route not registered'));
        return;
      }
      const req = new EventEmitter();
      req.method = 'POST';
      req.headers = { host: '127.0.0.1:3000' };
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

  return {
    rootCtx,
    engine,
    sessions,
    sessionsMap,
    writersMap,
    backend,
    calls,
    warnings,
    eventListeners,
    registerSession,
    rpc,
    getRoute: () => registeredRoute,
    cleanup,
  };
}

// 1. status RPC live telemetry + strict bili.detected === false on ordinary sessions + hot-apply auditBlockOnLoss
await test('rpc-status-live-telemetry-ordinary-session-and-hot-apply-auditBlockOnLoss', async () => {
  const home = await mkdtemp(join(tmpdir(), 'weave-e2e-status-'));
  let releaseStream;
  const streamReady = new Promise((resolve) => {
    releaseStream = resolve;
  });
  let streamStartedResolve;
  const streamStarted = new Promise((resolve) => {
    streamStartedResolve = resolve;
  });

  const host = makeFullHostFixture({
    home,
    extraEngineConfig: { summaryRetryCount: 0 },
    streamHandler: async function* () {
      const summary = makeStructuredSummary('Keep integer cents.');
      yield { type: 'text-delta', text: summary.slice(0, 80) };
      streamStartedResolve();
      await streamReady;
      yield { type: 'text-delta', text: summary.slice(80) };
      yield { type: 'finish', kind: 'stop' };
    },
  });
  try {
    assert.equal(host.getRoute()?.path, SUMMARY_RPC_PATH);

    // Ordinary session mentioning billion-context & <bili-snapshot> in plain user/assistant prose
    const s = makeSessionFixture({ sessionDir: join(home, 'sessions', 'ordinary') });
    s.addSystem('System prompt.');
    s.addUser('We discussed billion-context and <bili-snapshot v1 /> and acp_status in docs. Keep integer cents.');
    s.addAssistant('Sure, I will note that billion-context uses acp_status. ' + 'Detail line. '.repeat(400));
    s.addUser('Next step please.');
    host.registerSession(s);

    const idleStatus = await host.rpc('status', { sessionId: s.session.id });
    assert.equal(idleStatus.status, 200);
    assert.equal(idleStatus.body.ok, true);
    assert.equal(idleStatus.body.value.active, false);
    assert.equal(idleStatus.body.value.phase, 'idle');
    assert.equal(idleStatus.body.value.bili.detected, false, 'prose mentioning billion-context must NEVER set bili.detected=true');
    assert.equal(idleStatus.body.value.bili.canConvert, false);
    assert.equal(idleStatus.body.value.backup.count, 0);

    // Hot-apply auditBlockOnLoss via Settings RPC set -> takes effect immediately on live engine
    assert.equal(host.engine.config.auditBlockOnLoss, true);
    const setFalse = await host.rpc('set', { provider: '', model: '', auditBlockOnLoss: false });
    assert.equal(setFalse.body.ok, true);
    assert.equal(setFalse.body.value.config.auditBlockOnLoss, false);
    assert.equal(host.engine.config.auditBlockOnLoss, false);
    const setTrue = await host.rpc('set', { provider: '', model: '', auditBlockOnLoss: true });
    assert.equal(setTrue.body.ok, true);
    assert.equal(host.engine.config.auditBlockOnLoss, true);

    // Trigger manual compaction and verify live telemetry mid-stream
    const agent = {
      session: s.session,
      options: { provider: 'p', model: 'm' },
      runMaintenance: (fn) => fn(new AbortController().signal),
    };
    const compactPromise = host.engine.compactNow(agent, new AbortController().signal);
    await streamStarted;

    const liveStatus = await host.rpc('status', { sessionId: s.session.id });
    assert.equal(liveStatus.body.ok, true);
    assert.equal(liveStatus.body.value.active, true);
    assert.equal(liveStatus.body.value.phase, 'summarizing');
    assert.ok(typeof liveStatus.body.value.runId === 'string' && liveStatus.body.value.runId.length > 0);
    assert.equal(liveStatus.body.value.summaryModel, 'p/m');
    assert.ok(liveStatus.body.value.beforeTokens > 0);
    assert.ok(liveStatus.body.value.stream.textChars >= 80);
    assert.equal(liveStatus.body.value.bili.detected, false);
    // Zero raw draft text leaked in status payload
    assert.ok(!JSON.stringify(liveStatus.body.value).includes('Keep integer cents'));

    releaseStream();
    await compactPromise;

    const doneStatus = await host.rpc('status', { sessionId: s.session.id });
    assert.equal(doneStatus.body.ok, true);
    assert.equal(doneStatus.body.value.active, false);
    assert.equal(doneStatus.body.value.phase, 'done');
    assert.equal(doneStatus.body.value.runId, liveStatus.body.value.runId);
    assert.ok(doneStatus.body.value.currentTokens < doneStatus.body.value.beforeTokens);
  } finally {
    host.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

// 2. ranxianglei-authored-checkpoint (<bili-snapshot v1 ... /> in content[1]) -> backup -> migrate -> history_read -> detected=false
await test('e2e-ranxianglei-authored-checkpoint-backup-migrate-and-recall', async () => {
  const home = await mkdtemp(join(tmpdir(), 'weave-e2e-authored-'));
  const sessionDir = join(home, 'sessions', 'authored');
  const host = makeFullHostFixture({ home });
  try {
    const s = makeSessionFixture({ sessionDir, rawFilename: 'session.v4.jsonl.zstd' });
    s.addSystem('System.');
    // Historical shadowed original events in durable log (not on live surface)
    const oldUser = s.session.append('user/message', {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: 'Original pre-fold detail: secret-ticket-7741.' }],
      source: { kind: 'user' },
    });
    const oldAsst = s.session.append('assistant/message', {
      message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: 'Handled secret-ticket-7741.' }] },
    });
    // Foreign bili authored checkpoint with <bili-snapshot v1 ... /> in content[1]!
    const foldEv = s.session.append(
      'user/message',
      {
        id: randomUUID(),
        role: 'user',
        content: [
          { type: 'text', text: '[Compressed conversation section]\nWorked on ticket 7741.' },
          { type: 'text', text: '<bili-snapshot v1 blocks="1" tokens="42000" />' },
        ],
        source: { kind: 'compact-checkpoint', compactionId: 'bili-authored-1' },
      },
      { surfaceOp: 'append' },
    );
    // Verified post-fold user message that MUST survive migration
    const postFoldUser = s.addUser('Post-fold verified requirement: keep audit logs enabled.');
    s.addAssistant('Acknowledged.');
    host.registerSession(s);
    await host.sessions.flush(s.session);
    const originalRawBytes = readFileSync(s.logPath);
    const originalSha = sha256(originalRawBytes);

    // Inspect confirms detected=true
    const inspect = await host.rpc('bili-inspect', { sessionId: s.session.id });
    assert.equal(inspect.body.ok, true);
    assert.equal(inspect.body.value.bili.detected, true);
    assert.equal(inspect.body.value.bili.variant, 'ranxianglei-authored-checkpoint');
    assert.equal(inspect.body.value.bili.foldBlockCount, 1);

    // Missing confirmation MUST reject with zero mutation
    const nodesBefore = [...s.surface.nodes];
    const unconfirmed = await host.rpc('bili-migrate', { sessionId: s.session.id, confirmIrreversible: false });
    assert.equal(unconfirmed.body.ok, false);
    assert.equal(unconfirmed.body.error.code, 'CONFIRMATION_REQUIRED');
    assert.deepEqual(s.surface.nodes, nodesBefore);

    // Failed backup MUST abort with ZERO mutation!
    const origFindLog = host.backend.findLog;
    const origLocate = host.backend.locate;
    const origStat = host.backend.stat;
    host.backend.locate = () => null;
    host.backend.findLog = async () => null;
    host.backend.stat = async () => null;
    const failedBackup = await host.rpc('bili-migrate', { sessionId: s.session.id, confirmIrreversible: true });
    assert.equal(failedBackup.body.ok, false);
    assert.equal(failedBackup.body.error.code, 'BILI_BACKUP_FAILED');
    assert.deepEqual(s.surface.nodes, nodesBefore, 'failed backup must leave surface 100% untouched');
    host.backend.locate = origLocate;
    host.backend.findLog = origFindLog;
    host.backend.stat = origStat;

    // Now run confirmed migration
    const migrated = await host.rpc('bili-migrate', { sessionId: s.session.id, confirmIrreversible: true });
    assert.equal(migrated.body.ok, true);
    assert.equal(migrated.body.value.accepted, true);
    assert.equal(migrated.body.value.completed, true);
    assert.ok(migrated.body.value.backupId.startsWith('bkp-'));
    assert.ok(migrated.body.value.backupPath.endsWith('session.v4.jsonl.zstd'));
    assert.equal(sha256(readFileSync(migrated.body.value.backupPath)), originalSha, 'backup bytes must match original .v4.jsonl.zstd SHA-256');
    assert.equal(host.calls.length, 0, 'fold-adopt must use 0 LLM calls');

    // ZERO foreign files written inside DSH's session dir!
    assert.deepEqual(readdirSync(sessionDir), ['session.v4.jsonl.zstd']);

    // Native Weave checkpoint on surface with migratedFrom='billion-context'
    const cpSeq = s.surface.nodes.find((seq) => s.session.eventAt(seq)?.data?.source?.kind === 'compact-checkpoint');
    assert.ok(typeof cpSeq === 'number');
    const cpSource = s.session.eventAt(cpSeq).data.source;
    assert.ok(cpSource.compactionId.startsWith('weave-migrate-'));
    assert.equal(cpSource.migratedFrom, 'billion-context');
    assert.equal(cpSource.migrationVariant, 'ranxianglei-authored-checkpoint');
    assert.equal(cpSource.migrationBackupId, migrated.body.value.backupId);
    assert.equal(cpSource.externalSummaryUnverified, true);
    // DSH V4 compaction/summary validator only allows llmStreamCall === true or omitted (never false)
    const summaryEv = s.events.find(
      (e) => e.type === 'compaction/summary' && e.data?.compactionId === cpSource.compactionId,
    );
    assert.ok(summaryEv, 'fold-adopt must emit compaction/summary');
    assert.equal(summaryEv.data.llmStreamCall, undefined);
    assert.equal('llmStreamCall' in summaryEv.data, false);
    // Post-fold verified user message still preserved on surface tail (outside replaced span)
    assert.ok(s.surface.nodes.includes(postFoldUser.seq));

    // Archive recalls BOTH foreign fold AND shadowed durable originals
    const span = await host.engine.archive.readSpan(s.session.id, cpSource.compactionId);
    assert.equal(span.ok, true);
    const archivedSeqs = new Set(span.entries.map((e) => e.seq));
    assert.ok(archivedSeqs.has(foldEv.seq));
    assert.ok(archivedSeqs.has(oldUser.seq));
    assert.ok(archivedSeqs.has(oldAsst.seq));
    assert.ok(span.entries.some((e) => e.text.includes('secret-ticket-7741')));

    // Detection immediately flips to false
    const postStatus = await host.rpc('status', { sessionId: s.session.id });
    assert.equal(postStatus.body.ok, true);
    assert.equal(postStatus.body.value.bili.detected, false);
    assert.equal(postStatus.body.value.backup.count, 1);
    assert.equal(postStatus.body.value.backup.latestBackupId, migrated.body.value.backupId);
  } finally {
    host.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

// 3. billion-context-dsh ([Model-written summary ...], plugin:billion-context-dsh, broken tool pairing, stale foreign lock, foreign non-sha256 image)
await test('e2e-billion-context-dsh-heals-broken-pairing-closes-stale-lock-and-resets-breaker', async () => {
  const home = await mkdtemp(join(tmpdir(), 'weave-e2e-dsh-'));
  const sessionDir = join(home, 'sessions', 'bili-dsh');
  const host = makeFullHostFixture({ home });
  try {
    const s = makeSessionFixture({ sessionDir, rawFilename: 'session.v4.jsonl.zstd' });
    s.addSystem('System.');
    // Stale foreign compaction/start lock
    s.session.append('compaction/start', { compactionId: 'bili-stale-lock-1', turn: null });
    // V3->V4 migrated plugin:acp/block log-only event
    s.session.append('plugin:acp/block', { blockId: 'b1' });
    // Tyan66666/billion-context-dsh summary with foreign non-sha256 image placeholder
    s.session.append(
      'user/message',
      {
        id: randomUUID(),
        role: 'user',
        content: [
          {
            type: 'text',
            text: '[Model-written summary — not user words; re-verify any obligations before relying on them]\nMust keep 999 legacy foreign rules that must never trigger CONSTRAINT_LOST.',
          },
          { type: 'image', attachment: { attachmentId: 'foreign-placeholder-img', bytes: 123 } },
        ],
        source: { kind: 'plugin:billion-context-dsh' },
      },
      { surfaceOp: 'append' },
    );
    // Orphan tool/result breaking surface tool pairing (no matching tool-call!)
    s.session.append(
      'tool/result',
      {
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: 'orphan-bili-call',
          content: [{ type: 'text', text: '[acp-stored #m001] orphan result' }],
          source: { kind: 'tool-result', callId: 'orphan-bili-call' },
        },
      },
      { surfaceOp: 'append' },
    );
    // Clean balanced user/assistant tail after broken prefix
    const cleanUser = s.addUser('Keep production database read-only.');
    s.addAssistant('Understood, read-only enforced.');
    await host.sessions.flush(s.session);
    host.registerSession(s);

    // Trip the Weave circuit breaker beforehand to verify migration resets it
    for (let i = 0; i < 3; i += 1) {
      host.engine._recordFailure({ session: s.session }, s.session, new Error('prior failure'));
    }
    assert.equal(host.engine.sessionState.read(s.session.id).stopped, true);

    const det = detectBiliSession(s.session);
    assert.equal(det.detected, true);
    assert.equal(det.hasBrokenToolPairing, true);

    const res = await host.rpc('bili-migrate', { sessionId: s.session.id, confirmIrreversible: true });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.value.completed, true);

    // Stale lock was closed cleanly
    const staleCloser = s.events.find(
      (e) => e.type === 'compaction/end' && e.data?.compactionId === 'bili-stale-lock-1',
    );
    assert.ok(staleCloser, 'stale non-weave compaction/start must be closed');

    // Broken tool pairing is healed and bili.detected flipped to false
    const detAfter = detectBiliSession(s.session);
    assert.equal(detAfter.detected, false);
    assert.equal(detAfter.hasBrokenToolPairing, false);
    assert.ok(s.surface.nodes.includes(cleanUser.seq));

    // Archive is readable despite foreign non-sha256 image placeholder (allowForeignFallback)
    const span = await host.engine.archive.readSpan(s.session.id, res.body.value.compactionIds[0]);
    assert.equal(span.ok, true);
    const dshSummaryEv = s.events.find(
      (e) => e.type === 'compaction/summary' && e.data?.compactionId === res.body.value.compactionIds[0],
    );
    assert.ok(dshSummaryEv);
    assert.equal(dshSummaryEv.data.llmStreamCall, undefined);
    assert.equal('llmStreamCall' in dshSummaryEv.data, false);

    // Tripped breaker reset on success
    assert.equal(host.engine.sessionState.read(s.session.id).stopped, false);
    assert.equal(host.engine.sessionState.read(s.session.id).failures, 0);
  } finally {
    host.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

// 4. ranxianglei-proxy-raw (oversized raw log + acp_* tools) -> pre-masking + rolling-wave hierarchical fold
await test('e2e-ranxianglei-proxy-raw-premask-and-rolling-wave-fold', async () => {
  const home = await mkdtemp(join(tmpdir(), 'weave-e2e-raw-'));
  const sessionDir = join(home, 'sessions', 'proxy-raw');
  const observedPhases = new Set();
  const host = makeFullHostFixture({
    home,
    windowTokens: 120000,
    extraEngineConfig: {
      summaryInputMaxBytes: 36000,
      cacheMaxCheckpoints: 2,
      observationMaskThresholdChars: 2000,
      summaryRetryCount: 0,
    },
    streamHandler: async function* () {
      // Observe live phase from progress tracker during LLM streaming
      const sid = [...host.sessionsMap.keys()][0];
      const snap = host.engine.progressTracker.snapshot(sid);
      if (snap?.phase) observedPhases.add(snap.phase);
      const summary = makeStructuredSummary('Preserve strict API schema.');
      yield { type: 'text-delta', text: summary };
      yield { type: 'finish', kind: 'stop' };
    },
  });
  try {
    const s = makeSessionFixture({ sessionDir, rawFilename: 'session.v4.jsonl.zstd' });
    s.addSystem('System.');
    s.addUser('Preserve strict API schema.');
    // Oversized tool output + bili unique tools (`acp_status` and `acp_read_original_image`)
    s.addToolPair('acp_status', {}, '[ACP] acp_status result: active=true\n' + 'status-log '.repeat(600));
    s.addToolPair('acp_read_original_image', { ref: 'm001' }, '[bili] 原图已读取\n' + 'img-meta '.repeat(600));
    for (let i = 0; i < 6; i += 1) {
      s.addUser(`Turn ${i}: continue processing batch ${i}.`);
      s.addAssistant(`Processed batch ${i}: ` + 'analysis-detail '.repeat(1200));
    }
    await host.sessions.flush(s.session);
    host.registerSession(s);

    const detBefore = detectBiliSession(s.session);
    assert.equal(detBefore.detected, true);
    assert.equal(detBefore.variant, 'ranxianglei-proxy-raw');
    assert.ok(detBefore.biliToolCount >= 2);

    const migrated = await host.engine.migrateBiliSession(s.session, {
      sessions: host.sessions,
      backend: host.backend,
      sessionPersistence: host.backend,
      asyncRollingWave: false,
    });
    assert.equal(migrated.accepted, true);
    assert.equal(migrated.completed, true);
    assert.ok(migrated.backupId.startsWith('bkp-'));
    assert.ok(migrated.compactionIds.length >= 2);
    assert.ok(migrated.afterTokens < migrated.beforeTokens);

    // Idle migration (openTurn === null) must NEVER append tool/result or compaction/prune
    // outside an open turn (DSH V4 payload validator rejects tool/result outside a turn).
    assert.equal(
      s.events.some((e) => e.type === 'compaction/prune'),
      false,
      'idle proxy-raw migration must not emit disk compaction/prune or tool/result rewrites outside an open turn',
    );
    assert.equal(
      s.events.some((e) => e.type === 'tool/result' && blocksToText(e.data?.message?.content).includes(OBSERVATION_MASK_MARKER)),
      false,
      'idle proxy-raw migration must rely on in-request tool projection instead of outside-turn tool/result writes',
    );

    // Rolling-wave hierarchical fold ran (`phase: 'folding'` observed!)
    assert.ok(observedPhases.has('summarizing'), 'expected summarizing phase');
    assert.ok(observedPhases.has('folding'), 'expected hierarchical folding phase');

    // Migrated checkpoint stamped with migratedFrom='billion-context' & migrationBackupId
    const migratedCp = s.surface.nodes
      .map((seq) => s.session.eventAt(seq))
      .find((e) => e?.data?.source?.migratedFrom === 'billion-context');
    assert.ok(migratedCp, 'expected native Weave checkpoint with migratedFrom=billion-context');
    assert.equal(migratedCp.data.source.migrationBackupId, migrated.backupId);

    // Detection flips to false
    assert.equal(detectBiliSession(s.session).detected, false);

    // Also verify async rolling-wave kick-off via RPC returns immediately after verified backup
    const sAsync = makeSessionFixture({ sessionDir: join(home, 'sessions', 'proxy-raw-async'), rawFilename: 'session.v4.jsonl.zstd' });
    sAsync.addSystem('System.');
    sAsync.addUser('Keep async raw rule.');
    sAsync.addToolPair('acp_status', {}, '[ACP] acp_status result: ok\n' + 'raw-log '.repeat(600));
    sAsync.addAssistant('Analysis complete. ' + 'detail '.repeat(1200));
    host.registerSession(sAsync);
    await host.sessions.flush(sAsync.session);
    const asyncStart = await host.rpc('bili-migrate', { sessionId: sAsync.session.id, confirmIrreversible: true });
    assert.equal(asyncStart.body.ok, true);
    assert.equal(asyncStart.body.value.accepted, true);
    assert.equal(asyncStart.body.value.completed, false, 'RPC rolling-wave should return immediately after verified backup');
    assert.ok(asyncStart.body.value.backupId.startsWith('bkp-'));
    // Wait for background rolling-wave run to reach done
    for (let i = 0; i < 60; i += 1) {
      const st = await host.rpc('status', { sessionId: sAsync.session.id });
      if (!st.body.value.active && st.body.value.phase === 'done') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const asyncDone = await host.rpc('status', { sessionId: sAsync.session.id });
    assert.equal(asyncDone.body.value.active, false);
    assert.equal(asyncDone.body.value.phase, 'done');
    assert.equal(asyncDone.body.value.bili.detected, false);
  } finally {
    host.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

// 5. Backup restore E2E: Path A (cold restore) AND Path B (live armed pending-restore -> recoverBeforeOpen)
await test('e2e-backup-restore-path-a-cold-and-path-b-live-armed-recoverBeforeOpen', async () => {
  const home = await mkdtemp(join(tmpdir(), 'weave-e2e-restore-'));
  const sessionDir = join(home, 'sessions', 'restore-case');
  const host = makeFullHostFixture({ home });
  try {
    const s = makeSessionFixture({ sessionDir, rawFilename: 'session.v4.jsonl.zstd' });
    s.addSystem('System.');
    s.session.append(
      'user/message',
      {
        id: randomUUID(),
        role: 'user',
        content: [
          { type: 'text', text: '[Compressed conversation section]\nBefore migration.' },
          { type: 'text', text: '<bili-snapshot v1 blocks="1" />' },
        ],
        source: { kind: 'compact-checkpoint', compactionId: 'bili-1' },
      },
      { surfaceOp: 'append' },
    );
    host.registerSession(s);
    await host.sessions.flush(s.session);
    // Record distinctive pre-migration weave-state and capture exact pre-migration .v4.jsonl.zstd bytes
    host.engine.sessionState.update(s.session.id, (st) => ({ ...st, failures: 2, stopped: false }));
    const preMigrationRaw = readFileSync(s.logPath);
    const preMigrationSha = sha256(preMigrationRaw);

    const mig = await host.rpc('bili-migrate', { sessionId: s.session.id, confirmIrreversible: true });
    assert.equal(mig.body.ok, true);
    const backupId = mig.body.value.backupId;
    const postMigrationSha = sha256(readFileSync(s.logPath));
    assert.notEqual(postMigrationSha, preMigrationSha, 'migration must advance session log on disk');
    assert.equal(host.engine.sessionState.read(s.session.id).failures, 0);

    // Seed stale journal & continuation-progress files to verify restore cleans them
    await host.engine.journal.record({ sessionId: s.session.id, compactionId: 'stale-j', phase: 'started' });
    const contDir = join(home, 'storages', 'dsh-compaction-weave', 'continuation-progress', sha256(s.session.id));
    mkdirSync(contDir, { recursive: true });
    writeFileSync(join(contDir, 'stale.json'), '{"stale":true}');

    // --- Path B: Live session restore arms pending-restore.json + quarantines live writer ---
    let quarantined = false;
    const fakeWriter = {
      persistContiguous: async () => {},
    };
    host.writersMap.set(s.session.id, fakeWriter);
    const fakeStockAdapter = {
      blocked: new Set(),
      quarantine(id, handle) {
        quarantined = true;
        this.blocked.add(id);
        handle.persistContiguous = async () => {
          throw new Error('quarantined');
        };
      },
    };
    host.engine.transactionAdapter = fakeStockAdapter;

    // Without confirmRestore: true must fail
    const badRestore = await host.rpc('backup-restore', { sessionId: s.session.id, backupId, confirmRestore: false });
    assert.equal(badRestore.body.ok, false);
    assert.equal(badRestore.body.error.code, 'CONFIRMATION_REQUIRED');

    const armedRes = await host.engine.restoreSessionBackupFor(s.session.id, {
      backupId,
      sessions: host.sessions,
      backend: host.backend,
      sessionPersistence: host.backend,
      stockAdapter: fakeStockAdapter,
    });
    assert.equal(armedRes.status, 'armed');
    assert.equal(armedRes.requiresReopen, true);
    assert.equal(quarantined, true);
    assert.equal(fakeStockAdapter.blocked.has(s.session.id), true);

    // Status RPC reflects pendingRestore banner
    const armedStatus = await host.rpc('status', { sessionId: s.session.id });
    assert.equal(armedStatus.body.ok, true);
    assert.equal(armedStatus.body.value.backup.pendingRestore?.backupId, backupId);

    // Simulate closing the live session and reopening -> applyPendingRestoreBeforeOpen runs cleanly!
    host.sessionsMap.delete(s.session.id);
    host.writersMap.delete(s.session.id);
    const applied = await applyPendingRestoreBeforeOpen(host.engine.backupStore, s.session.id, {
      backend: host.backend,
      sessions: host.sessions,
      stateStore: host.engine.sessionState,
      journal: host.engine.journal,
    });
    assert.equal(applied.status, 'restored');
    assert.equal(sha256(readFileSync(s.logPath)), preMigrationSha, 'Path B reopen must restore exact .v4.jsonl.zstd bytes');
    assert.equal(host.engine.sessionState.read(s.session.id).failures, 2, 'weave-state.json restored');
    assert.deepEqual(await host.engine.journal.pending(s.session.id), [], 'stale journal cleared');
    assert.deepEqual(readdirSync(contDir), [], 'stale continuation-progress cleared');
    assert.equal(host.engine.backupStore.readPendingRestore(s.session.id), null);
    assert.deepEqual(readdirSync(sessionDir), ['session.v4.jsonl.zstd'], 'ZERO foreign files in DSH session dir');

    // --- Path A: Cold/offline restore restores immediately ---
    writeFileSync(s.logPath, Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('mutated-after-close\n')]));
    assert.notEqual(sha256(readFileSync(s.logPath)), preMigrationSha);

    const coldRes = await host.rpc('backup-restore', { sessionId: s.session.id, backupId, confirmRestore: true });
    assert.equal(coldRes.body.ok, true);
    assert.equal(coldRes.body.value.status, 'restored');
    assert.equal(coldRes.body.value.requiresReopen, false);
    assert.equal(sha256(readFileSync(s.logPath)), preMigrationSha, 'Path A cold restore must restore byte-for-byte');
    assert.deepEqual(readdirSync(sessionDir), ['session.v4.jsonl.zstd'], 'ZERO foreign files in DSH session dir after cold restore');
  } finally {
    host.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

// 6. /compact migrate, /compact backups, /compact restore subcommands + preserving default /compact
await test('e2e-slash-compact-migrate-backups-restore-and-preserve-default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'weave-e2e-cmd-'));
  const sessionDir = join(home, 'sessions', 'cmd-session');
  const host = makeFullHostFixture({ home });
  try {
    const s = makeSessionFixture({ sessionDir, rawFilename: 'session.v4.jsonl.zstd' });
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
        source: { kind: 'compact-checkpoint', compactionId: 'bili-cmd-1' },
      },
      { surfaceOp: 'append' },
    );
    await host.sessions.flush(s.session);
    host.registerSession(s);

    let defaultDelegated = 0;
    const baseResult = { kind: 'success', text: 'host-default-compact' };
    const decorated = decorateCompactCommand(
      {
        name: 'compact',
        async handler() {
          defaultDelegated += 1;
          return baseResult;
        },
      },
      host.engine,
    );
    const agent = { session: s.session, options: { provider: 'p', model: 'm' } };

    // Ordinary /compact and /compact <focus> still delegate untouched to host command!
    assert.equal(await decorated.handler({ rawInput: '/compact', agent, signal: new AbortController().signal }), baseResult);
    assert.equal(await decorated.handler({ rawInput: '/compact keep API schema', agent, signal: new AbortController().signal }), baseResult);
    assert.equal(defaultDelegated, 2);

    // /compact migrate
    const migOut = await decorated.handler({ rawInput: '/compact migrate', agent, signal: new AbortController().signal });
    assert.equal(migOut.kind, 'success');
    assert.match(migOut.text, /已完成 billion-context → Weave 兼容转换/);
    assert.match(migOut.text, /bkp-/);
    assert.equal(detectBiliSession(s.session).detected, false);

    // /compact backups
    const listOut = await decorated.handler({ rawInput: '/compact backups', agent, signal: new AbortController().signal });
    assert.equal(listOut.kind, 'success');
    assert.match(listOut.text, /共有 1 份/);
    assert.match(listOut.text, /bkp-/);

    // /compact restore (live session -> armed + requiresReopen guidance)
    const restoreOut = await decorated.handler({ rawInput: '/compact restore', agent, signal: new AbortController().signal });
    assert.equal(restoreOut.kind, 'success');
    assert.match(restoreOut.text, /备份还原已就绪/);
    assert.equal(defaultDelegated, 2);
  } finally {
    host.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

// 7. Issue #2 E2E through full WeaveCompactionEngine: 300-rule AGENTS.md repeated 9x + real user constraint under auditBlockOnLoss=true
await test('e2e-issue2-300-rule-agents-md-repeated-9x-passes-audit-and-enforces-real-constraint', async () => {
  const home = await mkdtemp(join(tmpdir(), 'weave-e2e-issue2-'));
  let responseText = makeStructuredSummary('必须保留审计日志。不要修改生产库。listenPort: 9443。');
  const host = makeFullHostFixture({
    home,
    extraEngineConfig: {
      auditEnabled: true,
      auditBlockOnLoss: true,
      preserveRecentMessages: 1,
      summaryRetryCount: 0,
    },
    streamHandler: async function* () {
      yield { type: 'text-delta', text: responseText };
      yield { type: 'finish', kind: 'stop' };
    },
  });
  try {
    const rules = Array.from({ length: 300 }, (_, i) =>
      i % 2 === 0
        ? `${i + 1}. Must never skip check #${i + 1}; keep maxTimeout=${10 + (i % 50)}s.`
        : `${i + 1}. 必须遵守仓库规范第 ${i + 1} 条，不要推送未验证分支。`,
    );
    const hugeAgentsReminder = [
      '<system-reminder>',
      'Instructions from: ~/.dsh/AGENTS.md',
      'Contains literal XML tags <reference>doc</reference> and <blockquote>example:',
      ...rules,
      '</system-reminder>',
    ].join('\n');

    const s = makeSessionFixture({ sessionDir: join(home, 'sessions', 'issue2') });
    s.addSystem('System.');
    // Mixed user message (evicted from Section 6 by preserveRecentMessages=1 so summary MUST retain its constraints!)
    s.addUser(`${hugeAgentsReminder}\n必须保留审计日志。不要修改生产库。listenPort: 9443。`);
    for (let i = 0; i < 8; i += 1) {
      s.addUser(
        hugeAgentsReminder,
        i % 2 === 0 ? { kind: 'agent-instructions', changes: [{ path: '~/.dsh/AGENTS.md' }] } : { kind: 'user' },
      );
      s.addAssistant(`Completed step ${i}. ` + 'Work log line. '.repeat(200));
    }
    // Second real user message inside the span so msg #1 is evicted from Section 6 verbatim quotes
    s.addUser('Continue verifying the deployment.');
    s.addAssistant('Verification underway. ' + 'Check log. '.repeat(120));
    s.addUser('Final tail message.');
    host.registerSession(s);

    const agent = {
      session: s.session,
      options: { provider: 'p', model: 'm' },
      runMaintenance: (fn) => fn(new AbortController().signal),
    };

    // 7a. Omitting real user constraints MUST still be blocked with CONSTRAINT_LOST under auditBlockOnLoss: true!
    responseText = makeStructuredSummary('No specific constraints mentioned.');
    await assert.rejects(
      () => host.engine.compactNow(agent, new AbortController().signal),
      (err) => err?.code === 'CONSTRAINT_LOST' || err?.cause?.code === 'CONSTRAINT_LOST' || /CONSTRAINT_LOST|missing from the checkpoint|保留检查/i.test(err?.message ?? ''),
    );

    // 7b. Summary preserving ONLY the real user constraints (and ignoring all 300 AGENTS.md rules x9) MUST SUCCEED!
    responseText = makeStructuredSummary('必须保留审计日志。不要修改生产库。listenPort: 9443。');
    const okResult = await host.engine.compactNow(agent, new AbortController().signal);
    assert.ok(okResult?.compactionId);

    // Verify real user constraint survived in the committed checkpoint, without 300-rule bloat
    const cpEvent = s.surface.nodes.map((seq) => s.session.eventAt(seq)).find((e) => e?.data?.source?.kind === 'compact-checkpoint');
    assert.ok(cpEvent);
    const cpText = blocksToText(cpEvent.data.content);
    assert.ok(cpText.includes('必须保留审计日志'));
    assert.ok(cpText.includes('listenPort: 9443'));
    assert.ok(!cpText.includes('Must never skip check #250'), '300-rule AGENTS.md reminder must not leak into checkpoint');
  } finally {
    host.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

// 8. Workstream A config hygiene: renameOfficialRows strips stale disabled:true and logs warnings on disabled:true & auto:false
await test('e2e-workstream-a-renameOfficialRows-strips-stale-disabled-and-warns-auto-false', () => {
  const tree = [
    {
      id: 'preset-standard',
      name: '@deepseek-ai/dsh-agent-preset',
      config: {
        id: 'standard',
        plugins: [
          {
            id: 'compaction',
            name: 'cordis:group',
            group: true,
            config: [
              {
                id: 'compaction-basic',
                name: '@deepseek-ai/dsh-compaction-basic',
                disabled: true,
                config: { auto: false, retainRatio: 0.2 },
              },
            ],
          },
        ],
      },
    },
  ];

  const rewritten = renameOfficialRows(tree, { thresholdRatio: 0.8 });
  assert.ok(rewritten);
  assert.equal(rewritten.rewritten, 1);
  assert.equal(rewritten.strippedDisabled, 1);
  assert.equal(rewritten.inheritedAutoFalse, 1);
  const engineRow = rewritten.plugins[0].config.plugins[0].config[0];
  assert.equal(engineRow.name, 'dsh-compaction-weave/engine');
  assert.equal(engineRow.disabled, undefined, 'stale disabled: true must be stripped');
  assert.equal(engineRow.config.auto, false, 'inherited auto: false stays explicit');

  // Verify live gate hook logs actionable warnings for BOTH stale disabled:true and inherited auto:false
  const hooks = new Map();
  const warnings = [];
  const dispose = mountGate(
    {
      on: (name, fn) => hooks.set(name, fn),
      provide() {},
      logger: { info() {}, warn: (msg) => warnings.push(String(msg)) },
    },
    { engine: {}, receiptPath: join(tmpdir(), `weave-receipt-${randomUUID()}.jsonl`) },
  );
  try {
    const out = hooks.get('internal/config')({}, () => ({ plugins: tree }));
    const row = out.plugins[0].config.plugins[0].config[0];
    assert.equal(row.disabled, undefined);
    assert.ok(warnings.some((w) => w.includes('disabled: true')), 'expected warning about stripped disabled: true');
    assert.ok(warnings.some((w) => w.includes('auto: false')), 'expected warning about inherited auto: false');
  } finally {
    dispose?.();
  }
});

// 9. Workstream B: deferCapacityFailureRecord prevents double-counting breaker failures & partial-commit preserved on continuation failure
await test('e2e-workstream-b-no-double-breaker-count-and-partial-commit-preservation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'weave-e2e-wb-'));
  const notes = '## Goal\nContinue work.\n## State\nArchived.\n## Next\nFinish step.\n## Uncertain\nNone.';
  const host = makeFullHostFixture({
    home,
    windowTokens: 120000,
    extraEngineConfig: {
      summaryInputMaxBytes: 42000,
      summaryRetryCount: 0,
      failureThreshold: 2,
      maxSummaryChunks: 16,
      continuationEnabled: true,
    },
    streamHandler: async function* (opts) {
      const sysText = blocksToText(opts.messages?.[0]?.content);
      if (sysText.includes('## Goal, ## State, ## Next, ## Uncertain')) {
        yield { type: 'text-delta', text: notes };
      } else {
        yield { type: 'text-delta', text: makeStructuredSummary() };
      }
      yield { type: 'finish', kind: 'stop' };
    },
  });
  try {
    // 9a. Single huge user-only message fails planSummaryRange -> falls back to continuation -> succeeds with 0 failures!
    const s1 = makeSessionFixture({ sessionDir: join(home, 'sessions', 'wb-1') });
    s1.addSystem('System.');
    s1.addUser('Keep audit trail.\n' + 'raw-context-blob '.repeat(2600));
    s1.addUser('Tail.');
    host.registerSession(s1);
    const a1 = { session: s1.session, options: { provider: 'p', model: 'm' }, runMaintenance: (fn) => fn(new AbortController().signal) };
    const r1 = await host.engine.compactNow(a1, new AbortController().signal);
    assert.ok(r1.continuation);
    assert.equal(host.engine.sessionState.read(s1.session.id).failures, 0, 'continuation fallback success must leave 0 failures');

    // 9b. When continuation ALSO fails, failure count MUST increment by 1 (NEVER 2 in a single turn!)
    const s2 = makeSessionFixture({ sessionDir: join(home, 'sessions', 'wb-2') });
    s2.addSystem('System.');
    s2.addUser('Keep audit trail.\n' + 'raw-context-blob '.repeat(2600));
    s2.addUser('Tail.');
    host.registerSession(s2);
    const badEngine = new WeaveCompactionEngine(
      {
        on() {},
        provide() {},
        logger: { info() {}, warn() {} },
        sessions: host.sessions,
        tokenMeter: {
          estimateMessage: (m) => approxTokens(blocksToText(m?.content)),
          measure: (sess) => {
            const nodes = sess.surface.nodes.map((seq) => ({ seq, tokens: approxTokens(blocksToText(sess.deriveEventMessage(sess.eventAt(seq))?.content)) }));
            return { nodes, totalTokens: nodes.reduce((sum, n) => sum + n.tokens, 0) };
          },
        },
        llm: {
          resolveModelInfo: async () => ({ contextWindow: 120000 }),
          async *stream() {
            throw Object.assign(new Error('provider outage'), { code: 'PROVIDER_ERROR' });
          },
        },
      },
      resolveConfig({
        archiveDir: join(home, 'bad-archive'),
        summaryInputMaxBytes: 42000,
        summaryRetryCount: 0,
        failureThreshold: 2,
        continuationEnabled: true,
      }).config,
    );
    badEngine.historyToolsAvailable = true;
    const a2 = { session: s2.session, options: { provider: 'p', model: 'm' }, runMaintenance: (fn) => fn(new AbortController().signal) };
    await assert.rejects(() => badEngine.compactNow(a2, new AbortController().signal));
    assert.equal(badEngine.sessionState.read(s2.session.id).failures, 1, 'must NOT double-count 2 failures in one turn');
    assert.equal(badEngine.sessionState.read(s2.session.id).stopped, false, 'single failure must not trip failureThreshold=2');

    // 9c. Partial-commit metadata preserved when chunk 1 commits and chunk 2 -> continuation fails!
    const s3 = makeSessionFixture({ sessionDir: join(home, 'sessions', 'wb-3') });
    s3.addSystem('System.');
    s3.addUser('Chunk 1 prompt.');
    s3.addAssistant('Chunk 1 long answer. ' + 'detail '.repeat(3000));
    s3.addUser('Chunk 2 huge unshrinkable user block: ' + 'huge '.repeat(5000));
    s3.addUser('Tail.');
    host.registerSession(s3);
    let llmCall = 0;
    const partialEngine = new WeaveCompactionEngine(
      {
        on() {},
        provide() {},
        logger: { info() {}, warn() {} },
        sessions: host.sessions,
        tokenMeter: {
          estimateMessage: (m) => approxTokens(blocksToText(m?.content)),
          measure: (sess) => {
            const nodes = sess.surface.nodes.map((seq) => ({ seq, tokens: approxTokens(blocksToText(sess.deriveEventMessage(sess.eventAt(seq))?.content)) }));
            return { nodes, totalTokens: nodes.reduce((sum, n) => sum + n.tokens, 0) };
          },
        },
        llm: {
          resolveModelInfo: async () => ({ contextWindow: 120000 }),
          async *stream() {
            llmCall += 1;
            if (llmCall === 1) {
              yield { type: 'text-delta', text: makeStructuredSummary() };
              yield { type: 'finish', kind: 'stop' };
              return;
            }
            throw Object.assign(new Error('continuation llm failed'), { code: 'PROVIDER_ERROR' });
          },
        },
      },
      resolveConfig({
        archiveDir: join(home, 'partial-archive'),
        summaryInputMaxBytes: 36000,
        summaryRetryCount: 0,
        continuationEnabled: true,
      }).config,
    );
    partialEngine.historyToolsAvailable = true;
    const a3 = { session: s3.session, options: { provider: 'p', model: 'm' }, runMaintenance: (fn) => fn(new AbortController().signal) };
    let caught = null;
    try {
      await partialEngine.compactNow(a3, new AbortController().signal);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected partial-commit error');
    assert.match(caught.message, /1 summary chunk\(s\) committed/);
    const preservedIds = caught.compactionIds ?? caught.cause?.compactionIds;
    assert.equal(preservedIds?.length, 1, 'committed chunk compactionId must be preserved on continuation error');
  } finally {
    host.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

// 10. Multi-wave continuation loops cleanly across waves until oversized proxy-raw bili session has bili.detected === false
await test('e2e-multi-wave-continuation-drains-oversized-bili-session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'weave-e2e-multiwave-'));
  const sessionDir = join(home, 'sessions', 'multiwave');
  const wavesObserved = new Set();
  const continuationNotes = [
    '## Goal\nPreserve strict API schema while draining all oversized billion-context waves.',
    '## State\nMulti-wave continuation archived historical tool outputs.',
    '## Next\nContinue task cleanly after full migration.',
    '## Uncertain\nRe-verify archived details via history_read as needed.',
  ].join('\n\n');

  const host = makeFullHostFixture({
    home,
    windowTokens: 120000,
    extraEngineConfig: {
      summaryInputMaxBytes: 36000,
      maxSummaryChunks: 2,
      summaryRetryCount: 0,
      continuationEnabled: true,
    },
    streamHandler: async function* () {
      const sid = [...host.sessionsMap.keys()][0];
      const snap = host.engine.progressTracker.snapshot(sid);
      if (snap?.waveIndex) wavesObserved.add(snap.waveIndex);
      yield { type: 'text-delta', text: continuationNotes };
      yield { type: 'finish', kind: 'stop' };
    },
  });
  try {
    const s = makeSessionFixture({ sessionDir, rawFilename: 'session.v4.jsonl.zstd' });
    // Large requestHeader().tools (>36 KB) forces planSummaryRange -> SUMMARY_GROUP_TOO_LARGE -> continuation waves,
    // mirroring real DSH profiles with 160+ registered MCP/plugin tools on a 200k-window model.
    const bigTools = Array.from({ length: 40 }, (_, i) => ({
      name: `tool_${i}`,
      description: 'D'.repeat(1100),
      parameters: { type: 'object', properties: {} },
    }));
    s.session.requestHeader = () => ({ config: { provider: 'p', model: 'm' }, tools: bigTools });
    s.addSystem('System.');
    s.addUser('Preserve strict API schema.');
    for (let i = 0; i < 6; i += 1) {
      s.addToolPair('acp_status', { step: i }, `[ACP] wave batch ${i}\n` + 'log-entry '.repeat(450));
      s.addAssistant(`Batch ${i} output: ` + 'analysis-record '.repeat(600));
    }
    s.addToolPair('acp_read_original_image', { ref: 'm999' }, '[bili] final tool output\n' + 'tail-data '.repeat(350));
    s.addAssistant('Final assistant summary: ' + 'closing-detail '.repeat(400));
    await host.sessions.flush(s.session);
    host.registerSession(s);

    const detBefore = detectBiliSession(s.session);
    assert.equal(detBefore.detected, true);
    assert.equal(detBefore.variant, 'ranxianglei-proxy-raw');
    assert.ok(detBefore.biliToolCount >= 7);

    const migrated = await host.engine.migrateBiliSession(s.session, {
      sessions: host.sessions,
      backend: host.backend,
      sessionPersistence: host.backend,
      asyncRollingWave: false,
    });
    assert.equal(migrated.accepted, true);
    assert.equal(migrated.completed, true);
    assert.ok(migrated.compactionIds.length >= 2, `expected multi-wave continuation (>=2 waves), got ${migrated.compactionIds.length}`);
    assert.ok(wavesObserved.has(1) && wavesObserved.has(2), `expected waveIndex 1 and 2, observed ${[...wavesObserved]}`);
    assert.equal(detectBiliSession(s.session).detected, false, 'multi-wave continuation must clear all bili tools');
    assert.equal(s.events.some((e) => e.type === 'compaction/prune'), false, 'idle multi-wave must not emit outside-turn compaction/prune');
  } finally {
    host.cleanup();
    await rm(home, { recursive: true, force: true });
  }
});

console.log(JSON.stringify({
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
}, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
