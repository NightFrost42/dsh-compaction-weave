import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WeaveCompactionEngine } from '../lib/engine.js';
import { apply as mountGate, SUMMARY_RPC_PATH } from '../lib/index.js';
import * as obsMask from '../lib/observation-mask.js';
import * as srcProv from '../lib/source-provenance.js';
import { withStageTraceContext, traceStageSync } from '../lib/stage-trace.js';
import { SessionStateStore } from '../lib/state.js';
import * as summaryConfigMod from '../lib/summary-config.js';

const {
  SummaryConfigError,
  handleSummaryConfigRpc,
  readSummaryConfig,
  writeSummaryConfig,
} = summaryConfigMod;

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

function walkJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkJsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Strip block and line comments without corrupting quoted string or template literal contents. */
function stripCommentsPreservingStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  let quote = 0;
  let escape = false;
  while (i < n) {
    const ch = source.charCodeAt(i);
    if (quote !== 0) {
      out += source[i];
      if (escape) {
        escape = false;
      } else if (ch === 92) {
        escape = true;
      } else if (ch === quote) {
        quote = 0;
      }
      i += 1;
      continue;
    }
    if (ch === 39 || ch === 34 || ch === 96) {
      quote = ch;
      out += source[i];
      i += 1;
      continue;
    }
    if (ch === 47 && source.charCodeAt(i + 1) === 47) {
      i += 2;
      while (i < n && source.charCodeAt(i) !== 10) i += 1;
      continue;
    }
    if (ch === 47 && source.charCodeAt(i + 1) === 42) {
      i += 2;
      while (i < n && !(source.charCodeAt(i) === 42 && source.charCodeAt(i + 1) === 47)) {
        if (source.charCodeAt(i) === 10) out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

function collectRelativeImports(filePath) {
  const cleaned = stripCommentsPreservingStrings(readFileSync(filePath, 'utf8'));
  const specs = [];
  const patterns = [
    /(?:import|export)\s+[\s\S]*?\s+from\s+['"](\.[^'"]+)['"]/g,
    /^\s*import\s+['"](\.[^'"]+)['"]/gm,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      const target = resolve(dirname(filePath), m[1]);
      if (existsSync(target)) specs.push(target);
    }
  }
  return specs;
}

function findSccs(nodes, adj) {
  let index = 0;
  const indices = new Map();
  const lowlink = new Map();
  const stack = [];
  const onStack = new Set();
  const sccs = [];

  function strongConnect(v) {
    indices.set(v, index);
    lowlink.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1 || (adj.get(v) ?? []).includes(v)) {
        sccs.push(comp);
      }
    }
  }

  for (const v of nodes) {
    if (!indices.has(v)) strongConnect(v);
  }
  return sccs;
}

// ── 1. 0-Cycle DAG & client.js Contract ─────────────────────────────────────

await test('phase6-zero-circular-imports-across-lib-and-zero-esm-in-client', () => {
  const libDir = join(REPO_ROOT, 'lib');
  const clientFile = resolve(join(libDir, 'client.js'));
  const libFiles = walkJsFiles(libDir).filter((f) => resolve(f) !== clientFile);
  assert.ok(libFiles.length >= 20, `expected lib/*.js files, found ${libFiles.length}`);

  const adj = new Map();
  for (const file of libFiles) {
    adj.set(resolve(file), collectRelativeImports(file));
  }
  const sccs = findSccs(libFiles.map((f) => resolve(f)), adj);
  assert.deepEqual(sccs, [], `unexpected circular ESM imports: ${JSON.stringify(sccs)}`);

  const clientCleaned = stripCommentsPreservingStrings(readFileSync(clientFile, 'utf8'));
  assert.equal(
    /^\s*(?:import|export)\s/m.test(clientCleaned),
    false,
    'lib/client.js must contain zero top-level ESM import/export statements',
  );
});

// ── 2. Export Identity Parity Across Refactored Leaves ──────────────────────

await test('phase6-export-identity-parity-across-reference-policy-and-tool-locator', async () => {
  const refPolicy = await import('../lib/reference-policy.js');
  const refNames = [
    'withExtraReferenceSourceKinds',
    'getExtraReferenceSourceKinds',
    'withExtraReferencePrefixes',
    'getExtraReferencePrefixes',
    'getExtraReferenceContextKey',
    'withReferencePolicy',
    'isReferenceContextKind',
  ];
  for (const name of refNames) {
    assert.equal(typeof refPolicy[name], 'function', `reference-policy missing ${name}`);
    assert.equal(srcProv[name], refPolicy[name], `source-provenance.${name} must strictly equal reference-policy.${name}`);
  }

  const toolLoc = await import('../lib/tool-locator.js');
  const locNames = [
    'OBSERVATION_MASK_MARKER',
    'PERSISTED_OUTPUT_MARKER',
    'MICROCOMPACT_SUPERSEDED_MARKER',
    'isArchivedToolStubText',
    'extractToolLocator',
  ];
  for (const name of locNames) {
    assert.ok(toolLoc[name] !== undefined, `tool-locator missing ${name}`);
    assert.equal(obsMask[name], toolLoc[name], `observation-mask.${name} must strictly equal tool-locator.${name}`);
  }
});

// ── 3. readSummaryConfig Stat-Cache & Hot-Reload Safety ─────────────────────

await test('phase6-readSummaryConfig-stat-cache-clone-invalidation-and-strict-error-safety', async () => {
  assert.equal(typeof summaryConfigMod.invalidateSummaryConfigCache, 'function');
  const root = await mkdtemp(join(TEST_BASE, 'weave-p6-cfg-'));
  const file = join(root, 'summary-config.json');
  try {
    summaryConfigMod.invalidateSummaryConfigCache();

    // Missing file returns null and must NOT permanently cache ENOENT
    assert.equal(readSummaryConfig(file), null);
    assert.equal(readSummaryConfig(file, { strict: true }), null);

    // Creating file immediately becomes visible
    writeSummaryConfig(file, { provider: 'openai', model: 'gpt-4o', maxTokens: 4096, auditCoverageScope: 'recent' });
    const first = readSummaryConfig(file);
    assert.equal(first?.provider, 'openai');
    assert.equal(first?.maxTokens, 4096);
    assert.equal(first?.auditCoverageScope, 'recent');

    // Mutating returned object must NOT poison subsequent cached reads
    first.maxTokens = 999999;
    first.provider = 'poisoned';
    const second = readSummaryConfig(file);
    assert.equal(second?.provider, 'openai');
    assert.equal(second?.maxTokens, 4096);

    // Same-ms writeSummaryConfig updates invalidate cache immediately
    writeSummaryConfig(file, { provider: 'anthropic', model: 'claude-sonnet-4', maxTokens: 8192, auditCoverageScope: 'span-new' });
    writeSummaryConfig(file, { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 16384, auditCoverageScope: 'all' });
    const afterWrites = readSummaryConfig(file, { strict: true });
    assert.equal(afterWrites?.provider, 'deepseek');
    assert.equal(afterWrites?.model, 'deepseek-chat');
    assert.equal(afterWrites?.maxTokens, 16384);
    assert.equal(afterWrites?.auditCoverageScope, 'all');

    // Direct fs overwrite outside writeSummaryConfig is detected by stat check
    const rawPayload = {
      version: 1,
      summarizationProvider: 'local',
      summarizationModel: 'direct-overwrite-longer-id',
      maxTokens: 2048,
      auditCoverageScope: 'recent',
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(file, JSON.stringify(rawPayload, null, 2) + '\n', 'utf8');
    const afterDirect = readSummaryConfig(file);
    assert.equal(afterDirect?.provider, 'local');
    assert.equal(afterDirect?.model, 'direct-overwrite-longer-id');
    assert.equal(afterDirect?.maxTokens, 2048);

    // Invalid JSON throws INVALID_SAVED_SETTINGS in strict mode without poisoning cache
    writeFileSync(file, '{invalid json', 'utf8');
    assert.throws(
      () => readSummaryConfig(file, { strict: true }),
      (err) => err instanceof SummaryConfigError && err.code === 'INVALID_SAVED_SETTINGS',
    );
    assert.equal(readSummaryConfig(file), null);

    // Writing valid config right after corrupt file recovers cleanly
    await handleSummaryConfigRpc({ method: 'set', params: { provider: 'openai', model: 'gpt-4o', maxTokens: 4096 } }, file);
    const recovered = readSummaryConfig(file, { strict: true });
    assert.equal(recovered?.provider, 'openai');
    assert.equal(recovered?.maxTokens, 4096);
  } finally {
    summaryConfigMod.invalidateSummaryConfigCache();
    await rm(root, { recursive: true, force: true });
  }
});

// ── 4. SessionStateStore.read Stat-Cache & Lock Safety ──────────────────────

await test('phase6-SessionStateStore-stat-cache-clone-resetBreaker-and-bypassCache-in-lock', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-p6-state-'));
  try {
    const store1 = new SessionStateStore(root);
    const store2 = new SessionStateStore(root);
    const sid = 'sess-state-cache';

    // ENOENT fast-path
    const initial = store1.read(sid);
    assert.equal(initial.failures, 0);
    assert.equal(initial.stopped, false);

    // update writes durable state; warm read returns structuredClone-isolated object
    store1.update(sid, (prev) => ({
      ...prev,
      failures: 2,
      stopped: true,
      lastFailureCode: 'SUMMARY_TIMEOUT',
      nested: { tag: 'v1' },
    }));
    const warm1 = store1.read(sid);
    assert.equal(warm1.failures, 2);
    assert.equal(warm1.stopped, true);
    warm1.failures = 777;
    warm1.nested.tag = 'mutated';

    const warm2 = store1.read(sid);
    assert.equal(warm2.failures, 2);
    assert.equal(warm2.nested.tag, 'v1');

    // External update on store2 is visible to store1.update() via bypassCache: true inside _withLock
    store2.update(sid, (prev) => ({
      ...prev,
      failures: prev.failures + 1,
      externalStamp: 'from-store2',
    }));
    let observedInLock = null;
    store1.update(sid, (prev) => {
      observedInLock = prev;
      return { ...prev, sawBypass: true };
    });
    assert.equal(observedInLock?.failures, 3);
    assert.equal(observedInLock?.externalStamp, 'from-store2');

    // resetBreaker invalidates cache cleanly
    const resetRes = store1.resetBreaker(sid);
    assert.equal(resetRes.reset, true);
    const afterReset = store1.read(sid);
    assert.equal(afterReset.failures, 0);
    assert.equal(afterReset.stopped, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 5. Resource Bounds & Disposal Cleanup ───────────────────────────────────

await test('phase6-engine-dispose-session-disposed-hooks-and-bounded-caches', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-p6-dispose-'));
  const priorHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    const handlers = new Map();
    const registerHook = (name, fn) => {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    };
    const engCtx = {
      on(name, fn) { registerHook(name, fn); },
      provide() {},
      logger: { info() {}, warn() {}, error() {} },
      sessions: { async flush() {} },
      tokenMeter: { measure: () => ({ nodes: [], totalTokens: 0 }) },
      llm: { async resolveModelInfo() { return { contextWindow: 200000, maxTokens: 4096 }; } },
    };
    const engine = new WeaveCompactionEngine(engCtx, {
      archiveDir: join(root, 'archive'),
      sessionMemoryEnabled: true,
    });

    // Ensure session/disposed cleans per-session state across all supported payload shapes
    const setPerSession = (sid) => {
      engine._failures.set(sid, 2);
      engine._stopped.set(sid, true);
      engine._recoveryBlocked.add(sid);
      engine._hostFallbackWarned.add(sid);
      engine._biliRuntimeSignals.set(sid, [{ code: 'BILI_PROXY_CONFLICT' }]);
      engine._lastPostCompactHook.set(sid, { at: Date.now() });
      engine.sessionMemory?.lastRunAt?.set?.(sid, { at: Date.now() });
    };
    setPerSession('sess-obj');
    setPerSession('sess-wrap');
    setPerSession('sess-str');
    setPerSession('sess-keep');

    const disposedHandlers = handlers.get('session/disposed') ?? [];
    assert.ok(disposedHandlers.length >= 1, 'engine must subscribe to session/disposed');
    for (const fn of disposedHandlers) {
      fn({ id: 'sess-obj' });
      fn({ session: { id: 'sess-wrap' } });
      fn('sess-str');
    }

    for (const gone of ['sess-obj', 'sess-wrap', 'sess-str']) {
      assert.equal(engine._failures.has(gone), false, `_failures should delete ${gone}`);
      assert.equal(engine._stopped.has(gone), false, `_stopped should delete ${gone}`);
      assert.equal(engine._recoveryBlocked.has(gone), false, `_recoveryBlocked should delete ${gone}`);
      assert.equal(engine._hostFallbackWarned.has(gone), false, `_hostFallbackWarned should delete ${gone}`);
      assert.equal(engine._biliRuntimeSignals.has(gone), false, `_biliRuntimeSignals should delete ${gone}`);
      assert.equal(engine._lastPostCompactHook.has(gone), false, `_lastPostCompactHook should delete ${gone}`);
      assert.equal(engine.sessionMemory?.lastRunAt?.has?.(gone), false, `sessionMemory.lastRunAt should delete ${gone}`);
    }
    assert.equal(engine._failures.get('sess-keep'), 2);
    assert.equal(engine._stopped.get('sess-keep'), true);
    assert.equal(engine._recoveryBlocked.has('sess-keep'), true);
    assert.equal(engine._biliRuntimeSignals.has('sess-keep'), true);

    // _noteBiliRuntimeSignal bounds engine._biliRuntimeSignals to <= 64 across 100 distinct sessions
    for (let i = 0; i < 100; i += 1) {
      engine._noteBiliRuntimeSignal({ id: `bili-cap-${i}` }, Object.assign(new Error('preflight_compress_failed'), { code: 'BILI_PROXY_CONFLICT' }));
    }
    assert.ok(engine._biliRuntimeSignals.size <= 64, `expected _biliRuntimeSignals.size <= 64, got ${engine._biliRuntimeSignals.size}`);

    // dispose() clears all engine in-memory collections
    engine.dispose();
    assert.equal(engine._hostFallbackWarned.size, 0);
    assert.equal(engine._failures.size, 0);
    assert.equal(engine._stopped.size, 0);
    assert.equal(engine._recoveryBlocked.size, 0);
    assert.equal(engine._biliRuntimeSignals.size, 0);
    assert.equal(engine._lastPostCompactHook.size, 0);

    // Mounted lib/index.js session/disposed cleans activeCompactions & disposer cleans runtime
    const gateHooks = new Map();
    let routeHandler = null;
    const disposeGate = mountGate(
      {
        on(name, fn) {
          if (!gateHooks.has(name)) gateHooks.set(name, []);
          gateHooks.get(name).push(fn);
        },
        provide() {},
        get(name) { return name === 'connection' ? { requestRejection: () => undefined } : null; },
        inject(deps, fn) {
          if (Array.isArray(deps) && deps.includes('webServer')) {
            return fn({
              effect: (cb) => { cb(); return () => {}; },
              webServer: {
                register(def) {
                  if (def.path === SUMMARY_RPC_PATH) routeHandler = def.handler;
                  return () => {};
                },
              },
            });
          }
          return undefined;
        },
        logger: { info() {}, warn() {} },
      },
      { engine: { archiveDir: join(root, 'gate-archive') } },
    );

    const invokeStatus = (sessionId) =>
      new Promise((resolveResp) => {
        const req = new EventEmitter();
        req.method = 'POST';
        req.headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' };
        req.socket = { remoteAddress: '127.0.0.1' };
        req.destroy = () => {};
        const res = {
          statusCode: 0,
          setHeader() {},
          end(text) { resolveResp(JSON.parse(text)); },
        };
        const done = routeHandler(req, res);
        req.emit('data', Buffer.from(JSON.stringify({ method: 'status', params: { sessionId } })));
        req.emit('end');
        Promise.resolve(done).catch(() => {});
      });

    for (const fn of gateHooks.get('session/event') ?? []) {
      fn({ id: 's-gate-disposed' }, { type: 'compaction/start', data: { turn: 3 } });
    }
    const activeBefore = await invokeStatus('s-gate-disposed');
    assert.equal(activeBefore?.value?.active, true);

    for (const fn of gateHooks.get('session/disposed') ?? []) {
      fn({ sessionId: 's-gate-disposed' });
    }
    const activeAfterDispose = await invokeStatus('s-gate-disposed');
    assert.equal(activeAfterDispose?.value?.active, false);

    disposeGate?.();

    // traceStageSync keeps ensuredDirs bounded across many distinct temp directories
    const traceRoot = join(root, 'traces');
    for (let i = 0; i < 160; i += 1) {
      const tracePath = join(traceRoot, `d-${i}`, 'stage.jsonl');
      withStageTraceContext({ enabled: true, filePath: tracePath }, () => {
        const out = traceStageSync('probe', { count: 1 }, () => i * 2, () => ({ ok: true }));
        assert.equal(out, i * 2);
      });
    }
    assert.equal(statSync(join(traceRoot, 'd-159', 'stage.jsonl')).isFile(), true);
  } finally {
    if (priorHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = priorHome;
    await rm(root, { recursive: true, force: true });
  }
});

console.log(JSON.stringify({
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
}, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
