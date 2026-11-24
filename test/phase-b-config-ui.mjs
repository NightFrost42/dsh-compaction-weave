import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

import {
  DEFAULT_CONFIG,
  MAX_MICROCOMPACT_HEAD_CHARS,
  MAX_MICROCOMPACT_KEEP_RECENT_TOOLS,
  MAX_MICROCOMPACT_REPEATED_READ_MIN_CHARS,
  MAX_MICROCOMPACT_TAIL_CHARS,
  MAX_MICROCOMPACT_THRESHOLD_CHARS,
  MAX_PERSISTED_OUTPUT_HEAD_CHARS,
  MAX_PERSISTED_OUTPUT_TAIL_CHARS,
  MAX_PERSISTED_OUTPUT_THRESHOLD_CHARS,
  MIN_MICROCOMPACT_HEAD_CHARS,
  MIN_MICROCOMPACT_KEEP_RECENT_TOOLS,
  MIN_MICROCOMPACT_REPEATED_READ_MIN_CHARS,
  MIN_MICROCOMPACT_TAIL_CHARS,
  MIN_MICROCOMPACT_THRESHOLD_CHARS,
  MIN_PERSISTED_OUTPUT_HEAD_CHARS,
  MIN_PERSISTED_OUTPUT_TAIL_CHARS,
  MIN_PERSISTED_OUTPUT_THRESHOLD_CHARS,
  REASONING_EFFORT_LADDER,
  SUMMARY_REASONING_EFFORTS,
  normalizeExtraReferenceSourceKinds,
  normalizeIdleFullSummaryEnabled,
  normalizeMicrocompactEnabled,
  normalizeMicrocompactHeadChars,
  normalizeMicrocompactKeepRecentTools,
  normalizeMicrocompactRepeatedReadMinChars,
  normalizeMicrocompactTailChars,
  normalizeMicrocompactThresholdChars,
  normalizePersistedOutputEnabled,
  normalizePersistedOutputHeadChars,
  normalizePersistedOutputTailChars,
  normalizePersistedOutputThresholdChars,
  normalizePostCompactReinjectEnabled,
  normalizePostCompactReinjectMaxBytes,
  normalizePostCompactReinjectMaxFileBytes,
  normalizePostCompactReinjectMaxFiles,
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

// ── 1. Phase B Config Defaults, Strict Non-Clamping Normalizers & Preservation ─

await test('phase-b-defaults-and-v042-phase-a-exports-preserved', () => {
  const expectedDefaults = {
    persistedOutputEnabled: true,
    persistedOutputThresholdChars: 32768,
    persistedOutputHeadChars: 1200,
    persistedOutputTailChars: 1200,
    microcompactEnabled: true,
    microcompactKeepRecentTools: 4,
    microcompactThresholdChars: 2000,
    microcompactHeadChars: 200,
    microcompactTailChars: 200,
    microcompactRepeatedReadMinChars: 2000,
    idleFullSummaryEnabled: true,
  };
  for (const [key, val] of Object.entries(expectedDefaults)) {
    assert.equal(DEFAULT_CONFIG[key], val, `DEFAULT_CONFIG.${key}`);
  }

  // Preserve v0.4.2 & Phase A exports and defaults, and verify Phase C defaults are opt-in false
  assert.deepEqual(SUMMARY_REASONING_EFFORTS, ['auto', 'low', 'none', 'inherit', 'minimal', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(REASONING_EFFORT_LADDER, ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']);
  assert.deepEqual(DEFAULT_CONFIG.extraReferenceSourceKinds, []);
  assert.deepEqual(normalizeExtraReferenceSourceKinds(['wechat']), ['wechat']);
  assert.equal(DEFAULT_CONFIG.diskLivenessCheck, true);
  assert.equal(DEFAULT_CONFIG.postCompactReinjectEnabled, true);
  assert.equal(DEFAULT_CONFIG.postCompactReinjectMaxFiles, 5);
  assert.equal(DEFAULT_CONFIG.postCompactReinjectMaxBytes, 24576);
  assert.equal(DEFAULT_CONFIG.postCompactReinjectMaxFileBytes, 6144);
  assert.equal(normalizePostCompactReinjectEnabled(false), false);
  assert.equal(normalizePostCompactReinjectMaxFiles(5), 5);
  assert.equal(normalizePostCompactReinjectMaxBytes(24576), 24576);
  assert.equal(normalizePostCompactReinjectMaxFileBytes(6144), 6144);
  assert.equal(DEFAULT_CONFIG.sessionMemoryEnabled, false);
  assert.equal(DEFAULT_CONFIG.contextCollapseEnabled, false);

  const { config, unknown } = resolveConfig({});
  assert.deepEqual(unknown, []);
  for (const [key, val] of Object.entries(expectedDefaults)) {
    assert.equal(config[key], val, `resolveConfig({}).config.${key}`);
  }

  // resolveTargetPolicy preserves Phase B fields alongside modelPolicies overrides
  const resolved = resolveConfig({
    persistedOutputEnabled: false,
    microcompactKeepRecentTools: 8,
    idleFullSummaryEnabled: false,
    modelPolicies: [{ provider: 'p', model: 'm', maxTokens: 4096 }],
  });
  assert.deepEqual(resolved.unknown, []);
  const target = resolveTargetPolicy(resolved.config, 'p', 'm');
  assert.equal(target.maxTokens, 4096);
  assert.equal(target.persistedOutputEnabled, false);
  assert.equal(target.microcompactKeepRecentTools, 8);
  assert.equal(target.idleFullSummaryEnabled, false);
});

await test('phase-b-normalizers-strictly-validate-without-clamping', () => {
  const boolSpecs = [
    ['persistedOutputEnabled', normalizePersistedOutputEnabled, true],
    ['microcompactEnabled', normalizeMicrocompactEnabled, true],
    ['idleFullSummaryEnabled', normalizeIdleFullSummaryEnabled, true],
  ];
  for (const [key, fn, defaultVal] of boolSpecs) {
    assert.equal(fn(), defaultVal);
    assert.equal(fn(true), true);
    assert.equal(fn(false), false);
    assert.equal(resolveConfig({ [key]: false }).config[key], false);
    for (const bad of ['true', 'false', 0, 1, null, {}, []]) {
      assert.throws(() => fn(bad), new RegExp(key), `${key} reject ${String(bad)}`);
      assert.throws(() => resolveConfig({ [key]: bad }), new RegExp(key));
    }
  }

  const intSpecs = [
    [
      'persistedOutputThresholdChars',
      normalizePersistedOutputThresholdChars,
      MIN_PERSISTED_OUTPUT_THRESHOLD_CHARS,
      MAX_PERSISTED_OUTPUT_THRESHOLD_CHARS,
      2048,
      1048576,
      [2048, 32768, 1048576],
      [-1, 0, 2047, 1048577, 4096.5, '32768', null, false, NaN, Infinity],
    ],
    [
      'persistedOutputHeadChars',
      normalizePersistedOutputHeadChars,
      MIN_PERSISTED_OUTPUT_HEAD_CHARS,
      MAX_PERSISTED_OUTPUT_HEAD_CHARS,
      0,
      8192,
      [0, 1200, 8192],
      [-1, 8193, 12.5, '1200', null, false, NaN, Infinity],
    ],
    [
      'persistedOutputTailChars',
      normalizePersistedOutputTailChars,
      MIN_PERSISTED_OUTPUT_TAIL_CHARS,
      MAX_PERSISTED_OUTPUT_TAIL_CHARS,
      0,
      8192,
      [0, 1200, 8192],
      [-1, 8193, 12.5, '1200', null, false, NaN, Infinity],
    ],
    [
      'microcompactKeepRecentTools',
      normalizeMicrocompactKeepRecentTools,
      MIN_MICROCOMPACT_KEEP_RECENT_TOOLS,
      MAX_MICROCOMPACT_KEEP_RECENT_TOOLS,
      0,
      50,
      [0, 4, 50],
      [-1, 51, 2.5, '4', null, true, NaN, Infinity],
    ],
    [
      'microcompactThresholdChars',
      normalizeMicrocompactThresholdChars,
      MIN_MICROCOMPACT_THRESHOLD_CHARS,
      MAX_MICROCOMPACT_THRESHOLD_CHARS,
      500,
      262144,
      [500, 2000, 262144],
      [-1, 0, 499, 262145, 500.5, '2000', null, false, NaN, Infinity],
    ],
    [
      'microcompactHeadChars',
      normalizeMicrocompactHeadChars,
      MIN_MICROCOMPACT_HEAD_CHARS,
      MAX_MICROCOMPACT_HEAD_CHARS,
      0,
      4096,
      [0, 200, 4096],
      [-1, 4097, 1.5, '200', null, false, NaN, Infinity],
    ],
    [
      'microcompactTailChars',
      normalizeMicrocompactTailChars,
      MIN_MICROCOMPACT_TAIL_CHARS,
      MAX_MICROCOMPACT_TAIL_CHARS,
      0,
      4096,
      [0, 200, 4096],
      [-1, 4097, 1.5, '200', null, false, NaN, Infinity],
    ],
    [
      'microcompactRepeatedReadMinChars',
      normalizeMicrocompactRepeatedReadMinChars,
      MIN_MICROCOMPACT_REPEATED_READ_MIN_CHARS,
      MAX_MICROCOMPACT_REPEATED_READ_MIN_CHARS,
      500,
      262144,
      [500, 2000, 262144],
      [-1, 0, 499, 262145, 999.5, '2000', null, false, NaN, Infinity],
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

// ── 2. summary-config.js Validation, Omission, Retain, Clear & Live Hot-Apply ─

await test('summary-config-phase-b-omission-and-validation', () => {
  const legacy = validateSummaryConfig({ provider: 'p', model: 'm', maxTokens: 4096 });
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.value, { provider: 'p', model: 'm', maxTokens: 4096, thresholdRatio: null });
  assert.equal(Object.hasOwn(legacy.value, 'persistedOutputEnabled'), false);
  assert.equal(Object.hasOwn(legacy.value, 'microcompactEnabled'), false);

  for (const boolVal of [true, false]) {
    const res = validateSummaryConfig({ persistedOutputEnabled: boolVal, microcompactEnabled: !boolVal });
    assert.equal(res.ok, true);
    assert.equal(res.value.persistedOutputEnabled, boolVal);
    assert.equal(res.value.microcompactEnabled, !boolVal);
  }

  for (const bad of ['true', 'false', 0, 1, null, {}, []]) {
    const resP = validateSummaryConfig({ persistedOutputEnabled: bad });
    assert.equal(resP.ok, false);
    assert.equal(resP.code, 'INVALID_PERSISTED_OUTPUT_ENABLED');

    const resM = validateSummaryConfig({ microcompactEnabled: bad });
    assert.equal(resM.ok, false);
    assert.equal(resM.code, 'INVALID_MICROCOMPACT_ENABLED');
  }
});

await test('summary-config-phase-b-rpc-legacy-omission-retain-clear-and-hot-apply', async () => {
  const root = await mkdtemp(join(testBaseRoot, 'weave-phaseb-cfg-'));
  const priorHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = root;
    const file = defaultSummaryConfigPath();

    // Legacy file without Phase B keys omits them, and empty clear clears without fabricating defaults
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, summarizationProvider: 'p', summarizationModel: 'm', maxTokens: 8192 }));
    const legacyRead = readSummaryConfig(file, { strict: true });
    assert.equal(Object.hasOwn(legacyRead, 'persistedOutputEnabled'), false);
    assert.equal(Object.hasOwn(legacyRead, 'microcompactEnabled'), false);

    const clearedLegacy = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '' } }, file);
    assert.equal(clearedLegacy.cleared, true);
    assert.equal(clearedLegacy.config, null);
    assert.equal(readSummaryConfig(file), null);
    const rawCleared = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(Object.hasOwn(rawCleared, 'persistedOutputEnabled'), false);
    assert.equal(Object.hasOwn(rawCleared, 'microcompactEnabled'), false);

    // Save persistedOutputEnabled=false and microcompactEnabled=false independently
    const saved = await handleSummaryConfigRpc(
      { method: 'set', params: { persistedOutputEnabled: false, microcompactEnabled: false } },
      file,
    );
    assert.equal(saved.cleared, false);
    assert.equal(saved.restartRequired, false);
    assert.equal(saved.config.persistedOutputEnabled, false);
    assert.equal(saved.config.microcompactEnabled, false);

    const got = await handleSummaryConfigRpc({ method: 'get' }, file);
    assert.deepEqual(got.config, saved.config);
    assert.equal(readSummaryConfig(file, { strict: true }).persistedOutputEnabled, false);
    assert.equal(readSummaryConfig(file, { strict: true }).microcompactEnabled, false);

    // Model-only save and model-only clear retain explicit Phase B settings
    await handleSummaryConfigRpc({ method: 'set', params: { provider: 'p', model: 'm' } }, file);
    assert.equal(readSummaryConfig(file).persistedOutputEnabled, false);
    assert.equal(readSummaryConfig(file).microcompactEnabled, false);
    const modelCleared = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '' } }, file);
    assert.equal(modelCleared.cleared, false);
    assert.equal(modelCleared.config.persistedOutputEnabled, false);
    assert.equal(modelCleared.config.microcompactEnabled, false);

    // Invalid RPC never overwrites disk
    const before = await readFile(file, 'utf8');
    await assert.rejects(
      handleSummaryConfigRpc({ method: 'set', params: { persistedOutputEnabled: 'bad' } }, file),
      { code: 'INVALID_PERSISTED_OUTPUT_ENABLED' },
    );
    await assert.rejects(
      handleSummaryConfigRpc({ method: 'set', params: { microcompactEnabled: 1 } }, file),
      { code: 'INVALID_MICROCOMPACT_ENABLED' },
    );
    assert.equal(await readFile(file, 'utf8'), before);

    // mergeSummaryConfig & writeSummaryConfig strict validation
    const merged = resolveConfig(mergeSummaryConfig({ persistedOutputEnabled: true, microcompactEnabled: true }, got.config)).config;
    assert.equal(merged.persistedOutputEnabled, false);
    assert.equal(merged.microcompactEnabled, false);
    assert.equal(Object.hasOwn(mergeSummaryConfig({}, { provider: 'p', model: 'm' }), 'persistedOutputEnabled'), false);
    assert.equal(Object.hasOwn(mergeSummaryConfig({}, { provider: 'p', model: 'm' }), 'microcompactEnabled'), false);
    assert.throws(() => mergeSummaryConfig({}, { persistedOutputEnabled: 'bad' }), { code: 'INVALID_PERSISTED_OUTPUT_ENABLED' });
    assert.throws(() => mergeSummaryConfig({}, { microcompactEnabled: 0 }), { code: 'INVALID_MICROCOMPACT_ENABLED' });
    assert.throws(() => writeSummaryConfig(file, { persistedOutputEnabled: 1 }), { code: 'INVALID_PERSISTED_OUTPUT_ENABLED' });
    assert.throws(() => writeSummaryConfig(file, { microcompactEnabled: null }), { code: 'INVALID_MICROCOMPACT_ENABLED' });

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
      assert.equal(peek().persistedOutputEnabled, false);
      assert.equal(peek().microcompactEnabled, false);

      await handleSummaryConfigRpc(
        { method: 'set', params: { persistedOutputEnabled: true, microcompactEnabled: true } },
        file,
      );
      assert.equal(peek().persistedOutputEnabled, true);
      assert.equal(peek().microcompactEnabled, true);

      for (const badDoc of [{ version: 1, persistedOutputEnabled: 'bad' }, { version: 1, microcompactEnabled: 'bad' }]) {
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

// ── 3. client.js ZH/EN Symmetry, Idle Hint & Touched-Gated Controls ──────────

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
  const click = async key => {
    button(key).props.onClick();
    return settle();
  };
  const change = (id, value) => {
    field(id).props.onChange({ target: { value: String(value) } });
    return render();
  };
  return { dictionaries, requests, render, field, click, change, settle };
}

for (const language of ['zh', 'en']) {
  await test(`${language}-client-phase-b-ui-symmetry-idle-hint-and-touched-gating`, async () => {
    const root = await mkdtemp(join(testBaseRoot, `weave-phaseb-ui-${language}-`));
    try {
      const file = join(root, 'summary-config.json');
      const h = await mountSettings({ language, file });

      // Key symmetry & Phase B hint texts
      const zhKeys = Object.keys(h.dictionaries.zh).sort();
      const enKeys = Object.keys(h.dictionaries.en).sort();
      assert.deepEqual(zhKeys, enKeys);
      assert.equal(typeof h.dictionaries[language].idleCompactionHint, 'string');
      assert.match(
        h.dictionaries[language].idleCompactionHint,
        language === 'zh' ? /0-LLM 轻压缩.*完整闲置摘要/ : /0-LLM microcompaction.*full idle summary/,
      );

      // Controls render with default 'true' and ['true', 'false'] options; opt-in Phase C defaults to false
      for (const id of ['weave-persisted-output', 'weave-microcompact']) {
        const control = h.field(id);
        assert.ok(control, `missing ${id}`);
        assert.equal(control.props.value, 'true');
        assert.deepEqual(control.children.map(o => o.props.value), ['true', 'false']);
      }
      assert.equal(h.field('weave-session-memory-enabled')?.props?.checked, false);

      const pageText = textOf(h.render());
      assert.match(pageText, language === 'zh' ? /0 前缀缓存失效/ : /0 prefix-cache invalidation/);
      assert.match(pageText, /isError: true/);
      assert.match(pageText, language === 'zh' ? /闲置 0-LLM 轻压缩/ : /Idle 0-LLM microcompaction/);

      // Untouched defaults omit persistedOutputEnabled & microcompactEnabled on both save and clear
      await h.click('save');
      const untouchedSave = h.requests.filter(r => r.method === 'set').at(-1).params;
      assert.equal(Object.hasOwn(untouchedSave, 'persistedOutputEnabled'), false);
      assert.equal(Object.hasOwn(untouchedSave, 'microcompactEnabled'), false);

      await h.click('clear');
      const untouchedClear = h.requests.filter(r => r.method === 'set').at(-1).params;
      assert.equal(Object.hasOwn(untouchedClear, 'persistedOutputEnabled'), false);
      assert.equal(Object.hasOwn(untouchedClear, 'microcompactEnabled'), false);

      // Touching one control at a time gates RPC payload cleanly
      h.change('weave-summary-provider', 'p');
      h.change('weave-summary-model', 'm');
      h.change('weave-persisted-output', 'false');
      await h.click('save');
      const onlyPersisted = h.requests.filter(r => r.method === 'set').at(-1).params;
      assert.equal(onlyPersisted.persistedOutputEnabled, false);
      assert.equal(Object.hasOwn(onlyPersisted, 'microcompactEnabled'), false);

      // Touching microcompact too persists both and survives model clear
      h.change('weave-microcompact', 'false');
      await h.click('save');
      const bothSaved = h.requests.filter(r => r.method === 'set').at(-1).params;
      assert.equal(bothSaved.persistedOutputEnabled, false);
      assert.equal(bothSaved.microcompactEnabled, false);
      assert.equal(readSummaryConfig(file, { strict: true }).persistedOutputEnabled, false);
      assert.equal(readSummaryConfig(file, { strict: true }).microcompactEnabled, false);

      await h.click('clear');
      const clearedDisk = readSummaryConfig(file, { strict: true });
      assert.equal(clearedDisk.provider, '');
      assert.equal(clearedDisk.persistedOutputEnabled, false);
      assert.equal(clearedDisk.microcompactEnabled, false);

      // Reloading populates saved values and preserves them on subsequent save
      const reloaded = await mountSettings({ language, file });
      assert.equal(reloaded.field('weave-persisted-output').props.value, 'false');
      assert.equal(reloaded.field('weave-microcompact').props.value, 'false');
      await reloaded.click('save');
      const reloadSet = reloaded.requests.filter(r => r.method === 'set').at(-1).params;
      assert.equal(reloadSet.persistedOutputEnabled, false);
      assert.equal(reloadSet.microcompactEnabled, false);

      // Clearing settings file externally and reloading via UI load() resets fields & touched flags
      await writeFile(file, JSON.stringify({ version: 1, summarizationProvider: 'p', summarizationModel: 'm' }));
      const withCatalogErr = await mountSettings({ language, file, failModels: true });
      withCatalogErr.change('weave-persisted-output', 'false');
      withCatalogErr.change('weave-microcompact', 'false');
      await withCatalogErr.click('reloadModels');
      assert.equal(withCatalogErr.field('weave-persisted-output').props.value, 'true');
      assert.equal(withCatalogErr.field('weave-microcompact').props.value, 'true');
      await withCatalogErr.click('save');
      const afterReloadParams = withCatalogErr.requests.filter(r => r.method === 'set').at(-1).params;
      assert.equal(Object.hasOwn(afterReloadParams, 'persistedOutputEnabled'), false);
      assert.equal(Object.hasOwn(afterReloadParams, 'microcompactEnabled'), false);

      // Failed save retains pending user edits
      const failing = await mountSettings({ language, file, failSet: true });
      failing.change('weave-persisted-output', 'false');
      failing.change('weave-microcompact', 'false');
      await failing.click('save');
      assert.equal(failing.field('weave-persisted-output').props.value, 'false');
      assert.equal(failing.field('weave-microcompact').props.value, 'false');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

await test('docs-document-phase-b-persisted-output-microcompact-and-idle-full-summary', async () => {
  const zhDoc = await readFile(new URL('../docs/configuration.md', import.meta.url), 'utf8');
  const enDoc = await readFile(new URL('../docs/en/configuration.md', import.meta.url), 'utf8');

  const keys = [
    'persistedOutputEnabled',
    'persistedOutputThresholdChars',
    'persistedOutputHeadChars',
    'persistedOutputTailChars',
    'microcompactEnabled',
    'microcompactKeepRecentTools',
    'microcompactThresholdChars',
    'microcompactHeadChars',
    'microcompactTailChars',
    'microcompactRepeatedReadMinChars',
    'idleFullSummaryEnabled',
  ];
  for (const key of keys) {
    assert.match(zhDoc, new RegExp(`\`${key}\``), `docs/configuration.md missing ${key}`);
    assert.match(enDoc, new RegExp(`\`${key}\``), `docs/en/configuration.md missing ${key}`);
  }
  assert.match(zhDoc, /Persisted-Output.*尾部.*tool\/result.*0 前缀缓存失效.*isError: true/s);
  assert.match(zhDoc, /Time-Based Microcompact.*idleCompactionMinutes.*0 LLM.*热点工具输出/s);
  assert.match(enDoc, /Persisted-Output.*unsent tail.*tool\/result.*0 prefix-cache invalidation.*isError: true/s);
  assert.match(enDoc, /Time-Based Microcompact.*idleCompactionMinutes.*0 LLM calls.*hot tool outputs/s);
});

console.log(JSON.stringify({
  passed: results.filter(r => r.pass).length,
  failed: results.filter(r => !r.pass).length,
  results,
}, null, 2));
if (results.some(r => !r.pass)) process.exitCode = 1;
