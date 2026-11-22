import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

import {
  DEFAULT_CONFIG,
  MAX_SNIP_KEEP_RECENT_TOKENS,
  MAX_SNIP_KEEP_RECENT_TURNS,
  MAX_SNIP_MAX_SPANS_PER_RESCUE,
  MAX_SNIP_MIN_SAVINGS_TOKENS,
  MIN_SNIP_KEEP_RECENT_TOKENS,
  MIN_SNIP_KEEP_RECENT_TURNS,
  MIN_SNIP_MAX_SPANS_PER_RESCUE,
  MIN_SNIP_MIN_SAVINGS_TOKENS,
  REASONING_EFFORT_LADDER,
  SUMMARY_REASONING_EFFORTS,
  normalizeExtraReferenceSourceKinds,
  normalizeSnipEnabled,
  normalizeSnipKeepRecentTokens,
  normalizeSnipKeepRecentTurns,
  normalizeSnipMaxSpansPerRescue,
  normalizeSnipMinSavingsTokens,
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

// ── 1. Phase D Snip Defaults, Strict Validators & modelPolicies ──────────────

await test('phase-d-5-snip-defaults-and-prior-exports-preserved', () => {
  const expectedDefaults = {
    snipEnabled: true,
    snipKeepRecentTurns: 2,
    snipKeepRecentTokens: 8192,
    snipMinSavingsTokens: 1024,
    snipMaxSpansPerRescue: 4,
  };
  assert.equal(Object.keys(expectedDefaults).length, 5);
  for (const [key, val] of Object.entries(expectedDefaults)) {
    assert.equal(DEFAULT_CONFIG[key], val, `DEFAULT_CONFIG.${key}`);
  }

  // Prior Phase A/B/C/v0.4.2 exports and defaults preserved
  assert.equal('hooks' in DEFAULT_CONFIG, false);
  assert.deepEqual(SUMMARY_REASONING_EFFORTS, ['low', 'none', 'inherit', 'minimal', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(REASONING_EFFORT_LADDER, ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']);
  assert.deepEqual(normalizeExtraReferenceSourceKinds(['wechat']), ['wechat']);
  assert.equal(DEFAULT_CONFIG.postCompactReinjectEnabled, true);
  assert.equal(DEFAULT_CONFIG.persistedOutputEnabled, true);
  assert.equal(DEFAULT_CONFIG.microcompactEnabled, true);
  assert.equal(DEFAULT_CONFIG.sessionMemoryEnabled, false);
  assert.equal(DEFAULT_CONFIG.contextCollapseEnabled, false);

  const { config, unknown } = resolveConfig({});
  assert.deepEqual(unknown, []);
  for (const [key, val] of Object.entries(expectedDefaults)) {
    assert.equal(config[key], val, `resolveConfig({}).config.${key}`);
  }
});

await test('phase-d-normalizers-and-modelPolicies-validate-strictly-without-clamping', () => {
  assert.equal(normalizeSnipEnabled(), true);
  assert.equal(normalizeSnipEnabled(true), true);
  assert.equal(normalizeSnipEnabled(false), false);
  assert.equal(resolveConfig({ snipEnabled: false }).config.snipEnabled, false);
  for (const badBool of ['true', 'false', 0, 1, null, {}, []]) {
    assert.throws(() => normalizeSnipEnabled(badBool), /snipEnabled/);
    assert.throws(() => resolveConfig({ snipEnabled: badBool }), /snipEnabled/);
    assert.throws(
      () => resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', snipEnabled: badBool }] }),
      /snipEnabled/,
    );
  }

  const intSpecs = [
    [
      'snipKeepRecentTurns',
      normalizeSnipKeepRecentTurns,
      MIN_SNIP_KEEP_RECENT_TURNS,
      MAX_SNIP_KEEP_RECENT_TURNS,
      1,
      50,
      [1, 2, 50],
      [-1, 0, 51, 2.5, '2', null, false, true, NaN, Infinity, {}],
    ],
    [
      'snipKeepRecentTokens',
      normalizeSnipKeepRecentTokens,
      MIN_SNIP_KEEP_RECENT_TOKENS,
      MAX_SNIP_KEEP_RECENT_TOKENS,
      512,
      262144,
      [512, 8192, 262144],
      [-1, 0, 511, 262145, 8192.5, '8192', null, false, NaN, Infinity],
    ],
    [
      'snipMinSavingsTokens',
      normalizeSnipMinSavingsTokens,
      MIN_SNIP_MIN_SAVINGS_TOKENS,
      MAX_SNIP_MIN_SAVINGS_TOKENS,
      0,
      131072,
      [0, 1024, 131072],
      [-1, 131073, 1024.5, '1024', null, false, true, NaN, Infinity],
    ],
    [
      'snipMaxSpansPerRescue',
      normalizeSnipMaxSpansPerRescue,
      MIN_SNIP_MAX_SPANS_PER_RESCUE,
      MAX_SNIP_MAX_SPANS_PER_RESCUE,
      1,
      20,
      [1, 4, 20],
      [-1, 0, 21, 2.5, '4', null, false, true, NaN, Infinity],
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

      const mp = resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', [key]: val }] });
      assert.deepEqual(mp.unknown, []);
      assert.equal(resolveTargetPolicy(mp.config, 'p', 'm')[key], val);
    }
    for (const bad of badVals) {
      assert.throws(() => fn(bad), new RegExp(key), `${key} reject ${String(bad)}`);
      assert.throws(() => resolveConfig({ [key]: bad }), new RegExp(key));
      assert.throws(
        () => resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', [key]: bad }] }),
        new RegExp(key),
      );
    }
  }

  // Combined modelPolicies override + fallback preservation via resolveTargetPolicy
  const combined = resolveConfig({
    snipEnabled: true,
    snipKeepRecentTurns: 3,
    modelPolicies: [
      {
        provider: 'p',
        model: 'm',
        snipEnabled: false,
        snipKeepRecentTurns: 5,
        snipKeepRecentTokens: 16384,
        snipMinSavingsTokens: 2048,
        snipMaxSpansPerRescue: 8,
      },
    ],
  });
  assert.deepEqual(combined.unknown, []);
  const target = resolveTargetPolicy(combined.config, 'p', 'm');
  assert.equal(target.snipEnabled, false);
  assert.equal(target.snipKeepRecentTurns, 5);
  assert.equal(target.snipKeepRecentTokens, 16384);
  assert.equal(target.snipMinSavingsTokens, 2048);
  assert.equal(target.snipMaxSpansPerRescue, 8);
  const other = resolveTargetPolicy(combined.config, 'other', 'model');
  assert.equal(other.snipEnabled, true);
  assert.equal(other.snipKeepRecentTurns, 3);
});

// ── 2. summary-config.js Hot Round-Trip, Omission, Retain & Clear ────────────

await test('summary-config-snipEnabled-omission-and-validation', () => {
  const legacy = validateSummaryConfig({ provider: 'p', model: 'm', maxTokens: 4096 });
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.value, { provider: 'p', model: 'm', maxTokens: 4096, thresholdRatio: null });
  assert.equal(Object.hasOwn(legacy.value, 'snipEnabled'), false);

  for (const boolVal of [true, false]) {
    const res = validateSummaryConfig({ snipEnabled: boolVal });
    assert.equal(res.ok, true);
    assert.equal(res.value.snipEnabled, boolVal);
  }
  for (const bad of ['true', 'false', 0, 1, null, {}, []]) {
    const res = validateSummaryConfig({ snipEnabled: bad });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'INVALID_SNIP_ENABLED');
  }
});

await test('summary-config-snipEnabled-rpc-retain-clear-and-live-hot-apply', async () => {
  const root = await mkdtemp(join(testBaseRoot, 'weave-phased-cfg-'));
  const priorHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = root;
    const file = defaultSummaryConfigPath();

    // Legacy file omits snipEnabled; model clear returns cleared: true without fabricating defaults
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, summarizationProvider: 'p', summarizationModel: 'm', maxTokens: 8192 }));
    const legacyRead = readSummaryConfig(file, { strict: true });
    assert.equal(Object.hasOwn(legacyRead, 'snipEnabled'), false);

    const clearedLegacy = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '' } }, file);
    assert.equal(clearedLegacy.cleared, true);
    assert.equal(clearedLegacy.config, null);
    assert.equal(readSummaryConfig(file), null);

    // Save snipEnabled=false independently
    const saved = await handleSummaryConfigRpc({ method: 'set', params: { snipEnabled: false } }, file);
    assert.equal(saved.cleared, false);
    assert.equal(saved.restartRequired, false);
    assert.equal(saved.config.snipEnabled, false);

    const got = await handleSummaryConfigRpc({ method: 'get' }, file);
    assert.deepEqual(got.config, saved.config);
    assert.equal(readSummaryConfig(file, { strict: true }).snipEnabled, false);

    // Model-only save and model-only clear preserve snipEnabled=false
    await handleSummaryConfigRpc({ method: 'set', params: { provider: 'p', model: 'm' } }, file);
    assert.equal(readSummaryConfig(file).snipEnabled, false);
    const modelCleared = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '' } }, file);
    assert.equal(modelCleared.cleared, false);
    assert.equal(modelCleared.config.snipEnabled, false);

    // Invalid RPC never overwrites disk
    const before = await readFile(file, 'utf8');
    await assert.rejects(
      handleSummaryConfigRpc({ method: 'set', params: { snipEnabled: 'no' } }, file),
      { code: 'INVALID_SNIP_ENABLED' },
    );
    await assert.rejects(
      handleSummaryConfigRpc({ method: 'set', params: { snipEnabled: 0 } }, file),
      { code: 'INVALID_SNIP_ENABLED' },
    );
    assert.equal(await readFile(file, 'utf8'), before);

    // mergeSummaryConfig & writeSummaryConfig strict validation
    const merged = resolveConfig(mergeSummaryConfig({ snipEnabled: true }, got.config)).config;
    assert.equal(merged.snipEnabled, false);
    assert.equal(Object.hasOwn(mergeSummaryConfig({}, { provider: 'p', model: 'm' }), 'snipEnabled'), false);
    assert.throws(() => mergeSummaryConfig({}, { snipEnabled: 'bad' }), { code: 'INVALID_SNIP_ENABLED' });
    assert.throws(() => writeSummaryConfig(file, { snipEnabled: 1 }), { code: 'INVALID_SNIP_ENABLED' });

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
      assert.equal(peek().snipEnabled, false);

      await handleSummaryConfigRpc({ method: 'set', params: { snipEnabled: true } }, file);
      assert.equal(peek().snipEnabled, true);

      await handleSummaryConfigRpc({ method: 'set', params: { snipEnabled: false } }, file);
      assert.equal(peek().snipEnabled, false);

      await writeFile(file, JSON.stringify({ version: 1, snipEnabled: 'bad' }));
      assert.equal(readSummaryConfig(file), null);
      assert.throws(() => readSummaryConfig(file, { strict: true }), { code: 'INVALID_SAVED_SETTINGS' });
    } finally {
      dispose();
    }
  } finally {
    if (priorHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = priorHome;
    await rm(root, { recursive: true, force: true });
  }
});

// ── 3. client.js #weave-snip ZH/EN Render, Hints, Touched Guard & Save ───────

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
  await test(`${language}-client-phase-d-snip-render-hints-touched-guard-and-save`, async () => {
    const root = await mkdtemp(join(testBaseRoot, `weave-phased-ui-${language}-`));
    try {
      const file = join(root, 'summary-config.json');
      const h = await mountSettings({ language, file });

      // Key symmetry & no dead CSS tokens
      assert.deepEqual(Object.keys(h.dictionaries.zh).sort(), Object.keys(h.dictionaries.en).sort());
      assert.doesNotMatch(
        clientSource,
        /--dsw-alias-(?:brand-primary|text-[a-z-]+|bg-elevated|bg-base|border-secondary|border-subtle)/,
      );

      // #weave-snip renders alongside #weave-persisted-output and #weave-microcompact with default 'true'
      const snipControl = h.field('weave-snip');
      assert.ok(snipControl, 'missing #weave-snip');
      assert.equal(snipControl.type, 'select');
      assert.equal(snipControl.props.value, 'true');
      assert.equal(snipControl.props['aria-describedby'], 'weave-snip-hint');
      assert.deepEqual(snipControl.children.map(o => o.props.value), ['true', 'false']);

      const pageText = textOf(h.render());
      if (language === 'zh') {
        assert.match(pageText, /默认开启.*0 LLM 调用.*messageBudgetTokens.*413.*history_read.*绝不丢弃近期用户消息/);
      } else {
        assert.match(pageText, /On by default.*0 LLM calls.*messageBudgetTokens.*413.*history_read.*never dropping recent user messages/);
      }

      // Untouched default omits snipEnabled on both save and clear
      await h.click('save');
      const untouchedSave = h.requests.filter(r => r.method === 'set').at(-1).params;
      assert.equal(Object.hasOwn(untouchedSave, 'snipEnabled'), false);

      await h.click('clear');
      const untouchedClear = h.requests.filter(r => r.method === 'set').at(-1).params;
      assert.equal(Object.hasOwn(untouchedClear, 'snipEnabled'), false);

      // Touching #weave-snip to 'false' sends snipEnabled: false and preserves across model clear
      h.change('weave-summary-provider', 'p');
      h.change('weave-summary-model', 'm');
      h.change('weave-snip', 'false');
      await h.click('save');
      const savedParams = h.requests.filter(r => r.method === 'set').at(-1).params;
      assert.equal(savedParams.snipEnabled, false);
      assert.equal(readSummaryConfig(file, { strict: true }).snipEnabled, false);

      await h.click('clear');
      const clearedDisk = readSummaryConfig(file, { strict: true });
      assert.equal(clearedDisk.provider, '');
      assert.equal(clearedDisk.snipEnabled, false);

      // Reloading populates saved false, marks touched, and flipping back to 'true' persists
      const reloaded = await mountSettings({ language, file });
      assert.equal(reloaded.field('weave-snip').props.value, 'false');
      await reloaded.click('save');
      assert.equal(reloaded.requests.filter(r => r.method === 'set').at(-1).params.snipEnabled, false);

      reloaded.change('weave-snip', 'true');
      await reloaded.click('save');
      assert.equal(reloaded.requests.filter(r => r.method === 'set').at(-1).params.snipEnabled, true);
      assert.equal(readSummaryConfig(file, { strict: true }).snipEnabled, true);

      // External reset + reloadModels clears field & touched flag
      await writeFile(file, JSON.stringify({ version: 1, summarizationProvider: 'p', summarizationModel: 'm' }));
      const withCatalogErr = await mountSettings({ language, file, failModels: true });
      withCatalogErr.change('weave-snip', 'false');
      await withCatalogErr.click('reloadModels');
      assert.equal(withCatalogErr.field('weave-snip').props.value, 'true');
      await withCatalogErr.click('save');
      assert.equal(Object.hasOwn(withCatalogErr.requests.filter(r => r.method === 'set').at(-1).params, 'snipEnabled'), false);

      // Failed save retains pending user edits
      const failing = await mountSettings({ language, file, failSet: true });
      failing.change('weave-snip', 'false');
      await failing.click('save');
      assert.equal(failing.field('weave-snip').props.value, 'false');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

// ── 4. Documentation Coverage & Scope Guards ─────────────────────────────────

await test('docs-document-all-5-snip-keys-hot-toggle-and-hierarchy-without-compact-memory', async () => {
  const zhDoc = await readFile(new URL('../docs/configuration.md', import.meta.url), 'utf8');
  const enDoc = await readFile(new URL('../docs/en/configuration.md', import.meta.url), 'utf8');

  const snipKeys = [
    'snipEnabled',
    'snipKeepRecentTurns',
    'snipKeepRecentTokens',
    'snipMinSavingsTokens',
    'snipMaxSpansPerRescue',
  ];
  for (const key of snipKeys) {
    assert.match(zhDoc, new RegExp(`\`${key}\``), `docs/configuration.md missing ${key}`);
    assert.match(enDoc, new RegExp(`\`${key}\``), `docs/en/configuration.md missing ${key}`);
  }

  assert.match(zhDoc, /Persisted-Output.*Time-Based Microcompact.*Context Collapse.*idleFullSummaryEnabled.*Snip/s);
  assert.match(zhDoc, /messageBudgetTokens.*413.*history_read/);
  assert.match(enDoc, /Persisted-Output.*Time-Based Microcompact.*Context Collapse.*idleFullSummaryEnabled.*Snip/s);
  assert.match(enDoc, /messageBudgetTokens.*413.*history_read/);

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
