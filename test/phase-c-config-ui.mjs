import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

import {
  DEFAULT_CONFIG,
  MAX_CONTEXT_COLLAPSE_KEEP_RECENT_TOKENS,
  MAX_CONTEXT_COLLAPSE_KEEP_RECENT_TURNS,
  MAX_CONTEXT_COLLAPSE_MAX_SPAN_TOKENS,
  MAX_CONTEXT_COLLAPSE_MIN_TOKENS,
  MAX_SESSION_MEMORY_COOLDOWN_MS,
  MAX_SESSION_MEMORY_MAX_BYTES,
  MAX_SESSION_MEMORY_MAX_CALLS_PER_SESSION,
  MAX_SESSION_MEMORY_MIN_TOKENS,
  MAX_SESSION_MEMORY_UPDATE_INTERVAL_TOKENS,
  MAX_SESSION_MEMORY_UPDATE_INTERVAL_TURNS,
  MIN_CONTEXT_COLLAPSE_KEEP_RECENT_TOKENS,
  MIN_CONTEXT_COLLAPSE_KEEP_RECENT_TURNS,
  MIN_CONTEXT_COLLAPSE_MAX_SPAN_TOKENS,
  MIN_CONTEXT_COLLAPSE_MIN_TOKENS,
  MIN_SESSION_MEMORY_COOLDOWN_MS,
  MIN_SESSION_MEMORY_MAX_BYTES,
  MIN_SESSION_MEMORY_MAX_CALLS_PER_SESSION,
  MIN_SESSION_MEMORY_MIN_TOKENS,
  MIN_SESSION_MEMORY_UPDATE_INTERVAL_TOKENS,
  MIN_SESSION_MEMORY_UPDATE_INTERVAL_TURNS,
  REASONING_EFFORT_LADDER,
  SUMMARY_REASONING_EFFORTS,
  normalizeContextCollapseEnabled,
  normalizeContextCollapseKeepRecentTokens,
  normalizeContextCollapseKeepRecentTurns,
  normalizeContextCollapseMaxSpanTokens,
  normalizeContextCollapseMinTokens,
  normalizeExtraReferenceSourceKinds,
  normalizeSessionMemoryCooldownMs,
  normalizeSessionMemoryEnabled,
  normalizeSessionMemoryMaxBytes,
  normalizeSessionMemoryMaxCallsPerSession,
  normalizeSessionMemoryMinTokens,
  normalizeSessionMemoryUpdateIntervalTokens,
  normalizeSessionMemoryUpdateIntervalTurns,
  resolveConfig,
  resolveTargetPolicy,
} from '../lib/config.js';
import {
  defaultSummaryConfigPath,
  handleSummaryConfigRpc,
  mergeSummaryConfig,
  readSummaryConfig,
  validateSummaryConfig,
  writeSummaryConfig,
} from '../lib/summary-config.js';
import { apply as mountEngine } from '../lib/engine-entry.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message, stack: error.stack });
  }
}

const testBaseRoot = process.env.WEAVE_TEST_ROOT ?? tmpdir();

// ── 1. Phase C Opt-In Defaults, Strict Non-Clamping Validation & Inheritance ─

await test('phase-c-12-defaults-and-prior-exports-preserved', () => {
  const expectedDefaults = {
    sessionMemoryEnabled: false,
    sessionMemoryMinTokens: 24576,
    sessionMemoryUpdateIntervalTokens: 16384,
    sessionMemoryUpdateIntervalTurns: 4,
    sessionMemoryCooldownMs: 60000,
    sessionMemoryMaxBytes: 12288,
    sessionMemoryMaxCallsPerSession: 8,
    contextCollapseEnabled: false,
    contextCollapseMinTokens: 49152,
    contextCollapseMaxSpanTokens: 32768,
    contextCollapseKeepRecentTokens: 8192,
    contextCollapseKeepRecentTurns: 2,
  };
  assert.equal(Object.keys(expectedDefaults).length, 12);
  for (const [key, val] of Object.entries(expectedDefaults)) {
    assert.equal(DEFAULT_CONFIG[key], val, `DEFAULT_CONFIG.${key}`);
  }

  // Preserve v0.4.2, Phase A, and Phase B exports/defaults; no shell hooks key
  assert.equal('hooks' in DEFAULT_CONFIG, false);
  assert.deepEqual(SUMMARY_REASONING_EFFORTS, ['low', 'none', 'inherit', 'minimal', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(REASONING_EFFORT_LADDER, ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']);
  assert.deepEqual(normalizeExtraReferenceSourceKinds(['wechat']), ['wechat']);
  assert.equal(DEFAULT_CONFIG.postCompactReinjectEnabled, true);
  assert.equal(DEFAULT_CONFIG.persistedOutputEnabled, true);
  assert.equal(DEFAULT_CONFIG.microcompactEnabled, true);
  assert.equal(DEFAULT_CONFIG.idleFullSummaryEnabled, true);

  const { config, unknown } = resolveConfig({});
  assert.deepEqual(unknown, []);
  for (const [key, val] of Object.entries(expectedDefaults)) {
    assert.equal(config[key], val, `resolveConfig({}).config.${key}`);
  }

  // resolveTargetPolicy preserves Phase C fields alongside modelPolicies overrides
  const resolved = resolveConfig({
    sessionMemoryEnabled: true,
    sessionMemoryMaxCallsPerSession: 16,
    contextCollapseEnabled: true,
    contextCollapseKeepRecentTurns: 5,
    modelPolicies: [{ provider: 'p', model: 'm', maxTokens: 4096 }],
  });
  assert.deepEqual(resolved.unknown, []);
  const target = resolveTargetPolicy(resolved.config, 'p', 'm');
  assert.equal(target.maxTokens, 4096);
  assert.equal(target.sessionMemoryEnabled, true);
  assert.equal(target.sessionMemoryMaxCallsPerSession, 16);
  assert.equal(target.contextCollapseEnabled, true);
  assert.equal(target.contextCollapseKeepRecentTurns, 5);
});

await test('phase-c-normalizers-strictly-validate-all-12-keys-without-clamping', () => {
  const boolSpecs = [
    ['sessionMemoryEnabled', normalizeSessionMemoryEnabled, false],
    ['contextCollapseEnabled', normalizeContextCollapseEnabled, false],
  ];
  for (const [key, fn, defaultVal] of boolSpecs) {
    assert.equal(fn(), defaultVal);
    assert.equal(fn(true), true);
    assert.equal(fn(false), false);
    assert.equal(resolveConfig({ [key]: true }).config[key], true);
    assert.equal(resolveConfig({ [key]: false }).config[key], false);
    for (const bad of ['true', 'false', 0, 1, null, {}, []]) {
      assert.throws(() => fn(bad), new RegExp(key), `${key} reject ${String(bad)}`);
      assert.throws(() => resolveConfig({ [key]: bad }), new RegExp(key));
    }
  }

  const intSpecs = [
    [
      'sessionMemoryMinTokens',
      normalizeSessionMemoryMinTokens,
      MIN_SESSION_MEMORY_MIN_TOKENS,
      MAX_SESSION_MEMORY_MIN_TOKENS,
      4096,
      1000000,
      [4096, 24576, 1000000],
      [-1, 0, 4095, 1000001, 24576.5, '24576', null, false, true, NaN, Infinity, {}],
    ],
    [
      'sessionMemoryUpdateIntervalTokens',
      normalizeSessionMemoryUpdateIntervalTokens,
      MIN_SESSION_MEMORY_UPDATE_INTERVAL_TOKENS,
      MAX_SESSION_MEMORY_UPDATE_INTERVAL_TOKENS,
      2048,
      500000,
      [2048, 16384, 500000],
      [-1, 0, 2047, 500001, 16384.5, '16384', null, false, NaN, Infinity],
    ],
    [
      'sessionMemoryUpdateIntervalTurns',
      normalizeSessionMemoryUpdateIntervalTurns,
      MIN_SESSION_MEMORY_UPDATE_INTERVAL_TURNS,
      MAX_SESSION_MEMORY_UPDATE_INTERVAL_TURNS,
      1,
      100,
      [1, 4, 100],
      [-1, 0, 101, 2.5, '4', null, false, NaN, Infinity],
    ],
    [
      'sessionMemoryCooldownMs',
      normalizeSessionMemoryCooldownMs,
      MIN_SESSION_MEMORY_COOLDOWN_MS,
      MAX_SESSION_MEMORY_COOLDOWN_MS,
      0,
      3600000,
      [0, 60000, 3600000],
      [-1, 3600001, 10.5, '60000', null, false, NaN, Infinity],
    ],
    [
      'sessionMemoryMaxBytes',
      normalizeSessionMemoryMaxBytes,
      MIN_SESSION_MEMORY_MAX_BYTES,
      MAX_SESSION_MEMORY_MAX_BYTES,
      2048,
      65536,
      [2048, 12288, 65536],
      [-1, 0, 2047, 65537, 4096.5, '12288', null, false, NaN, Infinity],
    ],
    [
      'sessionMemoryMaxCallsPerSession',
      normalizeSessionMemoryMaxCallsPerSession,
      MIN_SESSION_MEMORY_MAX_CALLS_PER_SESSION,
      MAX_SESSION_MEMORY_MAX_CALLS_PER_SESSION,
      1,
      100,
      [1, 8, 100],
      [-1, 0, 101, 3.5, '8', null, false, true, NaN, Infinity],
    ],
    [
      'contextCollapseMinTokens',
      normalizeContextCollapseMinTokens,
      MIN_CONTEXT_COLLAPSE_MIN_TOKENS,
      MAX_CONTEXT_COLLAPSE_MIN_TOKENS,
      8192,
      1000000,
      [8192, 49152, 1000000],
      [-1, 0, 8191, 1000001, 8192.5, '49152', null, false, NaN, Infinity],
    ],
    [
      'contextCollapseMaxSpanTokens',
      normalizeContextCollapseMaxSpanTokens,
      MIN_CONTEXT_COLLAPSE_MAX_SPAN_TOKENS,
      MAX_CONTEXT_COLLAPSE_MAX_SPAN_TOKENS,
      4096,
      500000,
      [4096, 32768, 500000],
      [-1, 0, 4095, 500001, 4096.5, '32768', null, false, NaN, Infinity],
    ],
    [
      'contextCollapseKeepRecentTokens',
      normalizeContextCollapseKeepRecentTokens,
      MIN_CONTEXT_COLLAPSE_KEEP_RECENT_TOKENS,
      MAX_CONTEXT_COLLAPSE_KEEP_RECENT_TOKENS,
      1024,
      200000,
      [1024, 8192, 200000],
      [-1, 0, 1023, 200001, 1024.5, '8192', null, false, NaN, Infinity],
    ],
    [
      'contextCollapseKeepRecentTurns',
      normalizeContextCollapseKeepRecentTurns,
      MIN_CONTEXT_COLLAPSE_KEEP_RECENT_TURNS,
      MAX_CONTEXT_COLLAPSE_KEEP_RECENT_TURNS,
      1,
      20,
      [1, 2, 20],
      [-1, 0, 21, 1.5, '2', null, false, true, NaN, Infinity],
    ],
  ];

  for (const [key, fn, minConst, maxConst, expectedMin, expectedMax, validVals, badVals] of intSpecs) {
    assert.equal(minConst, expectedMin, `${key} min const`);
    assert.equal(maxConst, expectedMax, `${key} max const`);
    assert.equal(fn(), DEFAULT_CONFIG[key], `${key} default`);
    for (const val of validVals) {
      assert.equal(fn(val), val, `${key} exact ${val}`);
      const resolved = resolveConfig({ [key]: val });
      assert.deepEqual(resolved.unknown, []);
      assert.equal(resolved.config[key], val);
    }
    for (const bad of badVals) {
      assert.throws(() => fn(bad), new RegExp(key), `${key} reject ${String(bad)}`);
      assert.throws(() => resolveConfig({ [key]: bad }), new RegExp(key));
    }
  }
});

// ── 2. summary-config.js Hot-Reload RPC, Omission, Retain & Clear ────────────

await test('summary-config-phase-c-omission-and-validation', () => {
  const legacy = validateSummaryConfig({ provider: 'p', model: 'm', maxTokens: 4096 });
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.value, { provider: 'p', model: 'm', maxTokens: 4096, thresholdRatio: null });
  assert.equal(Object.hasOwn(legacy.value, 'sessionMemoryEnabled'), false);
  assert.equal(Object.hasOwn(legacy.value, 'sessionMemoryMaxCallsPerSession'), false);
  assert.equal(Object.hasOwn(legacy.value, 'contextCollapseEnabled'), false);

  for (const boolVal of [true, false]) {
    const res = validateSummaryConfig({
      sessionMemoryEnabled: boolVal,
      contextCollapseEnabled: !boolVal,
      sessionMemoryMaxCallsPerSession: boolVal ? 1 : 100,
    });
    assert.equal(res.ok, true);
    assert.equal(res.value.sessionMemoryEnabled, boolVal);
    assert.equal(res.value.contextCollapseEnabled, !boolVal);
    assert.equal(res.value.sessionMemoryMaxCallsPerSession, boolVal ? 1 : 100);
  }

  for (const raw of ['1', ' 25 ', '100']) {
    const res = validateSummaryConfig({ sessionMemoryMaxCallsPerSession: raw });
    assert.equal(res.ok, true);
    assert.equal(res.value.sessionMemoryMaxCallsPerSession, Number(raw.trim()));
  }

  for (const badBool of ['true', 'false', 0, 1, null, {}, []]) {
    const resSm = validateSummaryConfig({ sessionMemoryEnabled: badBool });
    assert.equal(resSm.ok, false);
    assert.equal(resSm.code, 'INVALID_SESSION_MEMORY_ENABLED');

    const resCc = validateSummaryConfig({ contextCollapseEnabled: badBool });
    assert.equal(resCc.ok, false);
    assert.equal(resCc.code, 'INVALID_CONTEXT_COLLAPSE_ENABLED');
  }

  for (const badInt of [0, 101, -1, 1.5, '0', '101', '1.5', '1e2', '0x10', '', ' ', null, false, true, NaN, Infinity, {}, []]) {
    const resCalls = validateSummaryConfig({ sessionMemoryMaxCallsPerSession: badInt });
    assert.equal(resCalls.ok, false, `bad sessionMemoryMaxCallsPerSession=${String(badInt)}`);
    assert.equal(resCalls.code, 'INVALID_SESSION_MEMORY_MAX_CALLS_PER_SESSION');
  }
});

await test('summary-config-phase-c-rpc-legacy-omission-retain-clear-and-hot-apply', async () => {
  const root = await mkdtemp(join(testBaseRoot, 'weave-phasec-cfg-'));
  const priorHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = root;
    const file = defaultSummaryConfigPath();

    // Legacy file without Phase C keys omits them, and empty clear clears without fabricating defaults
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, summarizationProvider: 'p', summarizationModel: 'm', maxTokens: 8192 }));
    const legacyRead = readSummaryConfig(file, { strict: true });
    assert.equal(Object.hasOwn(legacyRead, 'sessionMemoryEnabled'), false);
    assert.equal(Object.hasOwn(legacyRead, 'sessionMemoryMaxCallsPerSession'), false);
    assert.equal(Object.hasOwn(legacyRead, 'contextCollapseEnabled'), false);

    const clearedLegacy = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '' } }, file);
    assert.equal(clearedLegacy.cleared, true);
    assert.equal(clearedLegacy.config, null);
    assert.equal(readSummaryConfig(file), null);
    const rawCleared = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(Object.hasOwn(rawCleared, 'sessionMemoryEnabled'), false);
    assert.equal(Object.hasOwn(rawCleared, 'sessionMemoryMaxCallsPerSession'), false);
    assert.equal(Object.hasOwn(rawCleared, 'contextCollapseEnabled'), false);

    // Save Phase C keys independently without model override
    const saved = await handleSummaryConfigRpc(
      {
        method: 'set',
        params: {
          sessionMemoryEnabled: true,
          sessionMemoryMaxCallsPerSession: 15,
          contextCollapseEnabled: true,
        },
      },
      file,
    );
    assert.equal(saved.cleared, false);
    assert.equal(saved.restartRequired, false);
    assert.equal(saved.config.sessionMemoryEnabled, true);
    assert.equal(saved.config.sessionMemoryMaxCallsPerSession, 15);
    assert.equal(saved.config.contextCollapseEnabled, true);

    const got = await handleSummaryConfigRpc({ method: 'get' }, file);
    assert.deepEqual(got.config, saved.config);
    assert.equal(readSummaryConfig(file, { strict: true }).sessionMemoryEnabled, true);
    assert.equal(readSummaryConfig(file, { strict: true }).sessionMemoryMaxCallsPerSession, 15);
    assert.equal(readSummaryConfig(file, { strict: true }).contextCollapseEnabled, true);

    // Model-only save and model-only clear retain explicit Phase C settings
    await handleSummaryConfigRpc({ method: 'set', params: { provider: 'p', model: 'm' } }, file);
    assert.equal(readSummaryConfig(file).sessionMemoryEnabled, true);
    assert.equal(readSummaryConfig(file).sessionMemoryMaxCallsPerSession, 15);
    assert.equal(readSummaryConfig(file).contextCollapseEnabled, true);
    const modelCleared = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '' } }, file);
    assert.equal(modelCleared.cleared, false);
    assert.equal(modelCleared.config.sessionMemoryEnabled, true);
    assert.equal(modelCleared.config.sessionMemoryMaxCallsPerSession, 15);
    assert.equal(modelCleared.config.contextCollapseEnabled, true);

    // Single-key save (only sessionMemoryMaxCallsPerSession) works independently too
    const callsOnlyFile = join(root, 'calls-only.json');
    const callsOnly = await handleSummaryConfigRpc({ method: 'set', params: { sessionMemoryMaxCallsPerSession: 12 } }, callsOnlyFile);
    assert.equal(callsOnly.cleared, false);
    assert.equal(readSummaryConfig(callsOnlyFile, { strict: true }).sessionMemoryMaxCallsPerSession, 12);
    const callsRetainedOnClear = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '' } }, callsOnlyFile);
    assert.equal(callsRetainedOnClear.cleared, false);
    assert.equal(callsRetainedOnClear.config.sessionMemoryMaxCallsPerSession, 12);

    // Invalid RPC never overwrites disk
    const before = await readFile(file, 'utf8');
    await assert.rejects(
      handleSummaryConfigRpc({ method: 'set', params: { sessionMemoryEnabled: 'yes' } }, file),
      { code: 'INVALID_SESSION_MEMORY_ENABLED' },
    );
    await assert.rejects(
      handleSummaryConfigRpc({ method: 'set', params: { contextCollapseEnabled: 1 } }, file),
      { code: 'INVALID_CONTEXT_COLLAPSE_ENABLED' },
    );
    await assert.rejects(
      handleSummaryConfigRpc({ method: 'set', params: { sessionMemoryMaxCallsPerSession: 101 } }, file),
      { code: 'INVALID_SESSION_MEMORY_MAX_CALLS_PER_SESSION' },
    );
    assert.equal(await readFile(file, 'utf8'), before);

    // mergeSummaryConfig & writeSummaryConfig strict validation
    const merged = resolveConfig(
      mergeSummaryConfig(
        { sessionMemoryEnabled: false, sessionMemoryMaxCallsPerSession: 8, contextCollapseEnabled: false },
        got.config,
      ),
    ).config;
    assert.equal(merged.sessionMemoryEnabled, true);
    assert.equal(merged.sessionMemoryMaxCallsPerSession, 15);
    assert.equal(merged.contextCollapseEnabled, true);

    const legacyMerged = mergeSummaryConfig({}, { provider: 'p', model: 'm' });
    assert.equal(Object.hasOwn(legacyMerged, 'sessionMemoryEnabled'), false);
    assert.equal(Object.hasOwn(legacyMerged, 'sessionMemoryMaxCallsPerSession'), false);
    assert.equal(Object.hasOwn(legacyMerged, 'contextCollapseEnabled'), false);

    assert.throws(() => mergeSummaryConfig({}, { sessionMemoryEnabled: 'bad' }), { code: 'INVALID_SESSION_MEMORY_ENABLED' });
    assert.throws(() => mergeSummaryConfig({}, { contextCollapseEnabled: 0 }), { code: 'INVALID_CONTEXT_COLLAPSE_ENABLED' });
    assert.throws(() => mergeSummaryConfig({}, { sessionMemoryMaxCallsPerSession: '15' }), { code: 'INVALID_SESSION_MEMORY_MAX_CALLS_PER_SESSION' });
    assert.throws(() => mergeSummaryConfig({}, { sessionMemoryMaxCallsPerSession: 0 }), { code: 'INVALID_SESSION_MEMORY_MAX_CALLS_PER_SESSION' });
    assert.throws(() => writeSummaryConfig(file, { sessionMemoryEnabled: 1 }), { code: 'INVALID_SESSION_MEMORY_ENABLED' });
    assert.throws(() => writeSummaryConfig(file, { contextCollapseEnabled: null }), { code: 'INVALID_CONTEXT_COLLAPSE_ENABLED' });
    assert.throws(() => writeSummaryConfig(file, { sessionMemoryMaxCallsPerSession: 101 }), { code: 'INVALID_SESSION_MEMORY_MAX_CALLS_PER_SESSION' });

    // Live mounted engine sees hot updates without restart
    const hooks = new Map();
    const services = new Map();
    const dispose = mountEngine(
      { on: (n, f) => hooks.set(n, f), provide: (n, v) => services.set(n, v), logger: { info() {}, warn() {} } },
      { auto: false, archiveDir: join(root, 'archive') },
    );
    try {
      const engine = services.get('compaction');
      const peek = () => engine._withConfig(() => engine.config);
      assert.equal(peek().sessionMemoryEnabled, true);
      assert.equal(peek().sessionMemoryMaxCallsPerSession, 15);
      assert.equal(peek().contextCollapseEnabled, true);

      await handleSummaryConfigRpc(
        {
          method: 'set',
          params: {
            sessionMemoryEnabled: false,
            sessionMemoryMaxCallsPerSession: 4,
            contextCollapseEnabled: false,
          },
        },
        file,
      );
      assert.equal(peek().sessionMemoryEnabled, false);
      assert.equal(peek().sessionMemoryMaxCallsPerSession, 4);
      assert.equal(peek().contextCollapseEnabled, false);

      for (const badDoc of [
        { version: 1, sessionMemoryEnabled: 'bad' },
        { version: 1, contextCollapseEnabled: 'bad' },
        { version: 1, sessionMemoryMaxCallsPerSession: 0 },
        { version: 1, sessionMemoryMaxCallsPerSession: 101 },
      ]) {
        await writeFile(file, JSON.stringify(badDoc));
        assert.equal(readSummaryConfig(file), null);
        assert.throws(() => readSummaryConfig(file, { strict: true }), { code: 'INVALID_SAVED_SETTINGS' });
      }
    } finally {
      dispose();
    }
  } finally {
    if (priorHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = priorHome;
    await rm(root, { recursive: true, force: true });
  }
});

// ── 3. client.js ZH/EN DOM, Hint Copy, Validation & Touched-Gated Submits ────

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of tree.children ?? []) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

function textOf(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (!tree || typeof tree !== 'object') return '';
  return (tree.children ?? []).map(textOf).join(' ');
}

async function mountSettings({ language = 'zh', file, initialConfig, failModels = false, failSet = false } = {}) {
  if (initialConfig) {
    await handleSummaryConfigRpc({ method: 'set', params: initialConfig }, file);
  }
  let mod;
  let Section;
  let dictionaries;
  let stateIndex = 0;
  let effectIndex = 0;
  const states = [];
  const effects = [];
  const pendingFetches = new Set();
  const requests = [];

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false && c !== true),
    }),
    useState: initialState => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initialState;
      return [
        states[index],
        value => {
          states[index] = typeof value === 'function' ? value(states[index]) : value;
        },
      ];
    },
    useEffect: (callback, deps) => {
      const index = effectIndex++;
      if (!effects[index] || (deps && deps.length > 0)) {
        effects[index] = { callback, pending: true };
      }
    },
  };

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: declaration => {
          mod = declaration.factory(name => {
            assert.equal(name, 'react');
            return React;
          });
        },
      },
    },
    console,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval: () => {
      throw new Error('Settings must never use setInterval');
    },
    clearInterval: () => {},
    fetch: (url, options) => {
      assert.equal(url, '/plugins/dsh-compaction-weave/rpc');
      const payload = JSON.parse(options.body);
      requests.push(payload);
      const task = (async () => {
        try {
          if (payload.method === 'models' && failModels) throw new Error('catalog offline');
          if (payload.method === 'set' && failSet) throw new Error('storage locked');
          const value = payload.method === 'models'
            ? { providers: [{ provider: 'p', name: 'Provider P', models: [{ id: 'm' }] }] }
            : await handleSummaryConfigRpc(payload, file);
          return { status: 200, text: async () => JSON.stringify({ ok: true, value }) };
        } catch (error) {
          return { status: 200, text: async () => JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }) };
        }
      })();
      pendingFetches.add(task);
      void task.finally(() => pendingFetches.delete(task));
      return task;
    },
  };

  vm.runInNewContext(clientSource, sandbox);
  mod.apply({
    slots: {
      inject: (_name, cb) => cb(),
      register: (desc, component) => {
        if (desc.name === 'settings.section') Section = component;
        return () => {};
      },
    },
    effect: cb => cb(),
    locale: {
      register: (_ns, values) => {
        dictionaries = values;
        return () => {};
      },
      bind: () => key => {
        assert.equal(typeof dictionaries?.[language]?.[key], 'string', `Missing ${language}.${key}`);
        return dictionaries[language][key];
      },
    },
  });

  const render = () => {
    stateIndex = 0;
    effectIndex = 0;
    const tree = Section();
    for (const slot of effects) {
      if (slot?.pending) {
        slot.pending = false;
        slot.callback();
      }
    }
    return tree;
  };
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      if (pendingFetches.size > 0) await Promise.all([...pendingFetches]);
      await new Promise(resolve => setImmediate(resolve));
      render();
    }
    return render();
  };

  render();
  await settle();
  const field = id => find(render(), node => node.props?.id === id);
  const button = key => find(render(), node => node.type === 'button' && node.children.includes(dictionaries[language][key]));
  const statusText = () => textOf(find(render(), node => node.props?.role === 'status'));
  const click = async key => {
    button(key).props.onClick();
    return settle();
  };
  const change = (id, value) => {
    field(id).props.onChange({ target: { value: String(value) } });
    return render();
  };
  const toggle = (id, checked) => {
    field(id).props.onChange({ target: { checked: Boolean(checked) } });
    return render();
  };
  return { dictionaries, requests, render, field, statusText, click, change, toggle, settle };
}

for (const language of ['zh', 'en']) {
  await test(`${language}-client-phase-c-dom-warnings-validation-and-touched-gating`, async () => {
    const root = await mkdtemp(join(testBaseRoot, `weave-phasec-ui-${language}-`));
    try {
      const file = join(root, 'summary-config.json');
      const h = await mountSettings({ language, file });

      // Key symmetry & no dead CSS tokens
      assert.deepEqual(Object.keys(h.dictionaries.zh).sort(), Object.keys(h.dictionaries.en).sort());
      assert.doesNotMatch(
        clientSource,
        /--dsw-alias-(?:brand-primary|text-[a-z-]+|bg-elevated|bg-base|border-secondary|border-subtle)/,
      );

      // DOM elements render with exact IDs, types, defaults, and aria-describedby hints
      const smCheckbox = h.field('weave-session-memory-enabled');
      assert.ok(smCheckbox);
      assert.equal(smCheckbox.type, 'input');
      assert.equal(smCheckbox.props.type, 'checkbox');
      assert.equal(smCheckbox.props.checked, false);
      assert.equal(smCheckbox.props['aria-describedby'], 'weave-session-memory-hint');

      const smCallsInput = h.field('weave-session-memory-max-calls');
      assert.ok(smCallsInput);
      assert.equal(smCallsInput.type, 'input');
      assert.equal(smCallsInput.props.type, 'number');
      assert.equal(smCallsInput.props.min, 1);
      assert.equal(smCallsInput.props.max, 100);
      assert.equal(smCallsInput.props.step, 1);
      assert.equal(smCallsInput.props.value, '8');
      assert.equal(smCallsInput.props['aria-describedby'], 'weave-session-memory-max-calls-hint');

      const ccCheckbox = h.field('weave-context-collapse-enabled');
      assert.ok(ccCheckbox);
      assert.equal(ccCheckbox.type, 'input');
      assert.equal(ccCheckbox.props.type, 'checkbox');
      assert.equal(ccCheckbox.props.checked, false);
      assert.equal(ccCheckbox.props['aria-describedby'], 'weave-context-collapse-hint');

      // Explicit warning & disambiguated copy for background pre-warming, billing fuse & expired-TTL cache safety
      const pageText = textOf(h.render());
      if (language === 'zh') {
        assert.match(pageText, /非后台定时压缩.*回合间隙后台预生成摘要/);
        assert.match(pageText, /默认关闭.*回合间隙.*API 余额.*Token 额度/);
        assert.match(pageText, /每次成功压缩后自动清零重算/);
        assert.match(pageText, /默认关闭.*idleCompactionMinutes 闲置恢复窗口.*Microcompact.*热提示词缓存.*API 余额/);
      } else {
        assert.match(pageText, /Not scheduled in the background.*Pre-generate summaries in background between turns/);
        assert.match(pageText, /Opt-in \(disabled by default\).*background between turns.*API balance.*token quota/);
        assert.match(pageText, /automatically resets after each successful compaction commit/);
        assert.match(pageText, /Opt-in \(disabled by default\).*expired idleCompactionMinutes resume window.*Microcompact.*NEVER runs during a warm prompt cache.*API balance/);
      }

      // Untouched defaults omit all 3 Phase C fields on save & clear
      await h.click('save');
      const untouchedSave = h.requests.filter(r => r.method === 'set').at(-1).params;
      assert.equal(Object.hasOwn(untouchedSave, 'sessionMemoryEnabled'), false);
      assert.equal(Object.hasOwn(untouchedSave, 'sessionMemoryMaxCallsPerSession'), false);
      assert.equal(Object.hasOwn(untouchedSave, 'contextCollapseEnabled'), false);

      await h.click('clear');
      const untouchedClear = h.requests.filter(r => r.method === 'set').at(-1).params;
      assert.equal(Object.hasOwn(untouchedClear, 'sessionMemoryEnabled'), false);
      assert.equal(Object.hasOwn(untouchedClear, 'sessionMemoryMaxCallsPerSession'), false);
      assert.equal(Object.hasOwn(untouchedClear, 'contextCollapseEnabled'), false);

      // Touching one control at a time gates RPC payload cleanly
      h.change('weave-summary-provider', 'p');
      h.change('weave-summary-model', 'm');
      h.toggle('weave-session-memory-enabled', true);
      await h.click('save');
      const onlySm = h.requests.filter(r => r.method === 'set').at(-1).params;
      assert.equal(onlySm.sessionMemoryEnabled, true);
      assert.equal(Object.hasOwn(onlySm, 'sessionMemoryMaxCallsPerSession'), false);
      assert.equal(Object.hasOwn(onlySm, 'contextCollapseEnabled'), false);

      // Invalid max-calls inputs block save & clear without sending RPC
      const setCountBeforeInvalid = h.requests.filter(r => r.method === 'set').length;
      for (const badCalls of ['', '0', '101', '1.5', '1e2', 'abc']) {
        h.change('weave-session-memory-max-calls', badCalls);
        await h.click('save');
        assert.match(h.statusText(), language === 'zh' ? /1–100 之间的整数/ : /integer between 1 and 100/);
        await h.click('clear');
        assert.match(h.statusText(), language === 'zh' ? /1–100 之间的整数/ : /integer between 1 and 100/);
      }
      assert.equal(h.requests.filter(r => r.method === 'set').length, setCountBeforeInvalid);

      // Fix max-calls & toggle context collapse -> persists and survives model clear
      h.change('weave-session-memory-max-calls', '12');
      h.toggle('weave-context-collapse-enabled', true);
      await h.click('save');
      const allThreeSaved = h.requests.filter(r => r.method === 'set').at(-1).params;
      assert.equal(allThreeSaved.sessionMemoryEnabled, true);
      assert.equal(allThreeSaved.sessionMemoryMaxCallsPerSession, 12);
      assert.equal(allThreeSaved.contextCollapseEnabled, true);

      const savedDisk = readSummaryConfig(file, { strict: true });
      assert.equal(savedDisk.sessionMemoryEnabled, true);
      assert.equal(savedDisk.sessionMemoryMaxCallsPerSession, 12);
      assert.equal(savedDisk.contextCollapseEnabled, true);

      await h.click('clear');
      const clearedDisk = readSummaryConfig(file, { strict: true });
      assert.equal(clearedDisk.provider, '');
      assert.equal(clearedDisk.sessionMemoryEnabled, true);
      assert.equal(clearedDisk.sessionMemoryMaxCallsPerSession, 12);
      assert.equal(clearedDisk.contextCollapseEnabled, true);

      // Reloading populates saved values and allows explicit toggle back to false
      const reloaded = await mountSettings({ language, file });
      assert.equal(reloaded.field('weave-session-memory-enabled').props.checked, true);
      assert.equal(reloaded.field('weave-session-memory-max-calls').props.value, '12');
      assert.equal(reloaded.field('weave-context-collapse-enabled').props.checked, true);

      reloaded.toggle('weave-session-memory-enabled', false);
      reloaded.toggle('weave-context-collapse-enabled', false);
      await reloaded.click('save');
      const flippedParams = reloaded.requests.filter(r => r.method === 'set').at(-1).params;
      assert.equal(flippedParams.sessionMemoryEnabled, false);
      assert.equal(flippedParams.sessionMemoryMaxCallsPerSession, 12);
      assert.equal(flippedParams.contextCollapseEnabled, false);
      assert.equal(readSummaryConfig(file, { strict: true }).sessionMemoryEnabled, false);
      assert.equal(readSummaryConfig(file, { strict: true }).contextCollapseEnabled, false);

      // External file reset + reloadModels() clears fields & touched flags
      await writeFile(file, JSON.stringify({ version: 1, summarizationProvider: 'p', summarizationModel: 'm' }));
      const withCatalogErr = await mountSettings({ language, file, failModels: true });
      withCatalogErr.toggle('weave-session-memory-enabled', true);
      withCatalogErr.change('weave-session-memory-max-calls', '20');
      withCatalogErr.toggle('weave-context-collapse-enabled', true);
      await withCatalogErr.click('reloadModels');
      assert.equal(withCatalogErr.field('weave-session-memory-enabled').props.checked, false);
      assert.equal(withCatalogErr.field('weave-session-memory-max-calls').props.value, '8');
      assert.equal(withCatalogErr.field('weave-context-collapse-enabled').props.checked, false);
      await withCatalogErr.click('save');
      const afterReloadParams = withCatalogErr.requests.filter(r => r.method === 'set').at(-1).params;
      assert.equal(Object.hasOwn(afterReloadParams, 'sessionMemoryEnabled'), false);
      assert.equal(Object.hasOwn(afterReloadParams, 'sessionMemoryMaxCallsPerSession'), false);
      assert.equal(Object.hasOwn(afterReloadParams, 'contextCollapseEnabled'), false);

      // Failed save retains pending user edits
      const failing = await mountSettings({ language, file, failSet: true });
      failing.toggle('weave-session-memory-enabled', true);
      failing.change('weave-session-memory-max-calls', '25');
      failing.toggle('weave-context-collapse-enabled', true);
      await failing.click('save');
      assert.equal(failing.field('weave-session-memory-enabled').props.checked, true);
      assert.equal(failing.field('weave-session-memory-max-calls').props.value, '25');
      assert.equal(failing.field('weave-context-collapse-enabled').props.checked, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

// ── 4. Documentation Coverage & Scope Guards ─────────────────────────────────

await test('docs-document-all-12-phase-c-keys-opt-in-fuse-watermark-and-ttl-gate-without-memory-cmd-or-hooks', async () => {
  const zhDoc = await readFile(new URL('../docs/configuration.md', import.meta.url), 'utf8');
  const enDoc = await readFile(new URL('../docs/en/configuration.md', import.meta.url), 'utf8');

  const phaseCKeys = [
    'sessionMemoryEnabled',
    'sessionMemoryMinTokens',
    'sessionMemoryUpdateIntervalTokens',
    'sessionMemoryUpdateIntervalTurns',
    'sessionMemoryCooldownMs',
    'sessionMemoryMaxBytes',
    'sessionMemoryMaxCallsPerSession',
    'contextCollapseEnabled',
    'contextCollapseMinTokens',
    'contextCollapseMaxSpanTokens',
    'contextCollapseKeepRecentTokens',
    'contextCollapseKeepRecentTurns',
  ];
  for (const key of phaseCKeys) {
    assert.match(zhDoc, new RegExp(`\`${key}\``), `docs/configuration.md missing ${key}`);
    assert.match(enDoc, new RegExp(`\`${key}\``), `docs/en/configuration.md missing ${key}`);
  }

  // Highlight opt-in default false, billing fuse, watermark/tail-preservation, expired-TTL cache-safe gating
  assert.match(zhDoc, /默认关闭（`false`）/);
  assert.match(zhDoc, /计费熔断/);
  assert.match(zhDoc, /coveredThroughSeq.*水印/);
  assert.match(zhDoc, /过期 TTL 缓存安全门控.*idleCompactionMinutes.*Microcompact.*绝不触发/s);

  assert.match(enDoc, /strictly opt-in \(`false` by default\)/);
  assert.match(enDoc, /billing fuse/);
  assert.match(enDoc, /coveredThroughSeq.*watermark/);
  assert.match(enDoc, /expired-TTL cache-safe gating.*idleCompactionMinutes.*Time-Based Microcompact.*NEVER/s);

  // Strictly NO `/compact memory` subcommand or shell hooks docs
  assert.doesNotMatch(zhDoc, /\/compact\s+memory/);
  assert.doesNotMatch(enDoc, /\/compact\s+memory/);
  assert.doesNotMatch(zhDoc, /shell\s+hooks|外部\s*Shell\s*命令钩子/i);
  assert.doesNotMatch(enDoc, /shell\s+hooks/i);
});

console.log(JSON.stringify({
  passed: results.filter(r => r.pass).length,
  failed: results.filter(r => !r.pass).length,
  results,
}, null, 2));
if (results.some(r => !r.pass)) process.exitCode = 1;
