import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import vm from 'node:vm';

import {
  DEFAULT_CONFIG,
  MAX_POST_COMPACT_REINJECT_MAX_BYTES,
  MAX_POST_COMPACT_REINJECT_MAX_FILES,
  MAX_POST_COMPACT_REINJECT_MAX_FILE_BYTES,
  MIN_POST_COMPACT_REINJECT_MAX_BYTES,
  MIN_POST_COMPACT_REINJECT_MAX_FILES,
  MIN_POST_COMPACT_REINJECT_MAX_FILE_BYTES,
  REASONING_EFFORT_LADDER,
  SUMMARY_REASONING_EFFORTS,
  normalizeExtraReferenceSourceKinds,
  normalizePostCompactReinjectEnabled,
  normalizePostCompactReinjectMaxBytes,
  normalizePostCompactReinjectMaxFileBytes,
  normalizePostCompactReinjectMaxFiles,
  resolveConfig,
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
import {
  MAX_FOCUS_INSTRUCTION_CHARS,
  decorateCompactCommand,
  parseCompactSubcommand,
  sanitizeFocusInstruction,
} from '../lib/command-compact.js';
import { createCommandHeartbeatScope } from '../lib/command-heartbeat.js';

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

// ── 1. Phase A Config Defaults, Strict Validation & v0.4.2 Preservation ─────

await test('config-reinject-defaults-and-v042-exports-preserved', () => {
  assert.equal(DEFAULT_CONFIG.postCompactReinjectEnabled, true);
  assert.equal(DEFAULT_CONFIG.postCompactReinjectMaxFiles, 5);
  assert.equal(DEFAULT_CONFIG.postCompactReinjectMaxBytes, 24576);
  assert.equal(DEFAULT_CONFIG.postCompactReinjectMaxFileBytes, 6144);
  assert.equal(DEFAULT_CONFIG.diskLivenessCheck, true);
  assert.deepEqual(DEFAULT_CONFIG.extraReferenceSourceKinds, []);
  assert.deepEqual(REASONING_EFFORT_LADDER, ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']);
  assert.deepEqual(SUMMARY_REASONING_EFFORTS, ['low', 'none', 'inherit', 'minimal', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(normalizeExtraReferenceSourceKinds(['qq-bridge']), ['qq-bridge']);

  const { config, unknown } = resolveConfig({});
  assert.deepEqual(unknown, []);
  assert.equal(config.postCompactReinjectEnabled, true);
  assert.equal(config.postCompactReinjectMaxFiles, 5);
  assert.equal(config.postCompactReinjectMaxBytes, 24576);
  assert.equal(config.postCompactReinjectMaxFileBytes, 6144);
  assert.equal('sessionMemoryEnabled' in DEFAULT_CONFIG, false);
  assert.equal('hooks' in DEFAULT_CONFIG, false);
});

await test('config-reinject-normalizers-strictly-validate-without-clamping', () => {
  assert.equal(normalizePostCompactReinjectEnabled(true), true);
  assert.equal(normalizePostCompactReinjectEnabled(false), false);
  assert.equal(resolveConfig({ postCompactReinjectEnabled: false }).config.postCompactReinjectEnabled, false);
  for (const badBool of ['true', 'false', 0, 1, null, {}, []]) {
    assert.throws(() => normalizePostCompactReinjectEnabled(badBool), /postCompactReinjectEnabled/);
    assert.throws(() => resolveConfig({ postCompactReinjectEnabled: badBool }), /postCompactReinjectEnabled/);
  }

  const intSpecs = [
    [
      'postCompactReinjectMaxFiles',
      normalizePostCompactReinjectMaxFiles,
      MIN_POST_COMPACT_REINJECT_MAX_FILES,
      MAX_POST_COMPACT_REINJECT_MAX_FILES,
      [1, 5, 20],
      [0, -1, 21, 2.5, '5', null, false, NaN, Infinity],
    ],
    [
      'postCompactReinjectMaxBytes',
      normalizePostCompactReinjectMaxBytes,
      MIN_POST_COMPACT_REINJECT_MAX_BYTES,
      MAX_POST_COMPACT_REINJECT_MAX_BYTES,
      [1024, 24576, 262144],
      [0, 1023, 262145, 2048.5, '24576', null, NaN],
    ],
    [
      'postCompactReinjectMaxFileBytes',
      normalizePostCompactReinjectMaxFileBytes,
      MIN_POST_COMPACT_REINJECT_MAX_FILE_BYTES,
      MAX_POST_COMPACT_REINJECT_MAX_FILE_BYTES,
      [512, 6144, 65536],
      [0, 511, 65537, 512.5, '6144', null, false],
    ],
  ];

  for (const [key, fn, min, max, validVals, badVals] of intSpecs) {
    assert.equal(fn(min), min, `${key} min`);
    assert.equal(fn(max), max, `${key} max`);
    for (const val of validVals) {
      assert.equal(fn(val), val);
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

// ── 2. summary-config.js Hot Settings Validation, Persistence & RPC ─────────

await test('summary-config-postCompactReinjectEnabled-omission-and-validation', () => {
  const legacy = validateSummaryConfig({ provider: 'p', model: 'm', maxTokens: 4096 });
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.value, { provider: 'p', model: 'm', maxTokens: 4096, thresholdRatio: null });
  assert.equal(Object.hasOwn(legacy.value, 'postCompactReinjectEnabled'), false);

  for (const boolVal of [true, false]) {
    const res = validateSummaryConfig({ postCompactReinjectEnabled: boolVal });
    assert.equal(res.ok, true);
    assert.equal(res.value.postCompactReinjectEnabled, boolVal);
  }
  for (const bad of ['true', 'false', 0, 1, null, {}, []]) {
    const res = validateSummaryConfig({ postCompactReinjectEnabled: bad });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'INVALID_POST_COMPACT_REINJECT_ENABLED');
  }
});

await test('summary-config-rpc-persistence-clear-merge-and-live-engine-hot-apply', async () => {
  const root = await mkdtemp(join(testBaseRoot, 'weave-phasea-cfg-'));
  const priorHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = root;
    const file = defaultSummaryConfigPath();

    // Model-only save and clear when no independent settings exist returns cleared: true
    await handleSummaryConfigRpc({ method: 'set', params: { provider: 'p', model: 'm' } }, file);
    const emptyClear = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '' } }, file);
    assert.equal(emptyClear.cleared, true);
    assert.equal(emptyClear.config, null);
    assert.equal(readSummaryConfig(file), null);

    // Save postCompactReinjectEnabled=false independently
    const saved = await handleSummaryConfigRpc({
      method: 'set',
      params: { postCompactReinjectEnabled: false },
    }, file);
    assert.equal(saved.cleared, false);
    assert.equal(saved.restartRequired, false);
    assert.equal(saved.config.postCompactReinjectEnabled, false);

    const got = await handleSummaryConfigRpc({ method: 'get' }, file);
    assert.deepEqual(got.config, saved.config);
    assert.equal(readSummaryConfig(file, { strict: true }).postCompactReinjectEnabled, false);

    // Model-only save and clear preserve independent postCompactReinjectEnabled
    await handleSummaryConfigRpc({ method: 'set', params: { provider: 'p', model: 'm' } }, file);
    assert.equal(readSummaryConfig(file).postCompactReinjectEnabled, false);
    const modelCleared = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '' } }, file);
    assert.equal(modelCleared.cleared, false);
    assert.equal(modelCleared.config.postCompactReinjectEnabled, false);

    // Invalid RPC never overwrites disk
    const before = await readFile(file, 'utf8');
    await assert.rejects(
      handleSummaryConfigRpc({ method: 'set', params: { postCompactReinjectEnabled: 'no' } }, file),
      { code: 'INVALID_POST_COMPACT_REINJECT_ENABLED' },
    );
    assert.equal(await readFile(file, 'utf8'), before);

    // mergeSummaryConfig & strict validation
    const merged = resolveConfig(mergeSummaryConfig({ postCompactReinjectEnabled: true }, got.config)).config;
    assert.equal(merged.postCompactReinjectEnabled, false);
    assert.throws(() => mergeSummaryConfig({}, { postCompactReinjectEnabled: 'no' }), { code: 'INVALID_POST_COMPACT_REINJECT_ENABLED' });
    assert.throws(() => writeSummaryConfig(file, { postCompactReinjectEnabled: 1 }), { code: 'INVALID_POST_COMPACT_REINJECT_ENABLED' });

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
      assert.equal(peek().postCompactReinjectEnabled, false);

      await handleSummaryConfigRpc({ method: 'set', params: { postCompactReinjectEnabled: true } }, file);
      assert.equal(peek().postCompactReinjectEnabled, true);

      await writeFile(file, JSON.stringify({ version: 1, postCompactReinjectEnabled: 'bad' }));
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

// ── 3. command-compact.js: Strict 6 Built-in Subcommands + Focus ────────────

await test('command-compact-parses-strict-6-subcommands-and-focus-including-memory-phrase', () => {
  // Empty -> { kind: 'default' }
  assert.deepEqual(parseCompactSubcommand(''), { kind: 'default' });
  assert.deepEqual(parseCompactSubcommand('   '), { kind: 'default' });
  assert.deepEqual(parseCompactSubcommand(null), { kind: 'default' });
  assert.deepEqual(parseCompactSubcommand({ rawInput: '/compact' }), { kind: 'default' });
  assert.deepEqual(parseCompactSubcommand({ rawInput: '/compact   ' }), { kind: 'default' });
  assert.deepEqual(parseCompactSubcommand({ rawArgs: '' }), { kind: 'default' });
  assert.deepEqual(parseCompactSubcommand({ args: [] }), { kind: 'default' });

  // Exact 6 reserved subcommands ONLY
  assert.deepEqual(parseCompactSubcommand('migrate'), { kind: 'migrate' });
  assert.deepEqual(parseCompactSubcommand('backups'), { kind: 'backups' });
  assert.deepEqual(parseCompactSubcommand('restore'), { kind: 'restore', backupId: undefined });
  assert.deepEqual(parseCompactSubcommand('restore bkp-1'), { kind: 'restore', backupId: 'bkp-1' });
  assert.deepEqual(parseCompactSubcommand('resume'), { kind: 'resume' });
  assert.deepEqual(parseCompactSubcommand('cancel'), { kind: 'cancel' });
  assert.deepEqual(parseCompactSubcommand('discard'), { kind: 'discard' });

  // Phase A: `/compact memory` and `/compact memory leak focus` MUST parse as focus!
  assert.deepEqual(parseCompactSubcommand('memory'), {
    kind: 'focus',
    focusInstruction: 'memory',
  });
  assert.deepEqual(parseCompactSubcommand('memory leak focus'), {
    kind: 'focus',
    focusInstruction: 'memory leak focus',
  });
  assert.deepEqual(parseCompactSubcommand({ rawInput: '/compact memory leak traces' }), {
    kind: 'focus',
    focusInstruction: 'memory leak traces',
  });

  // Focus parsing preserves case, collapses control chars/whitespace, handles `--`
  assert.deepEqual(parseCompactSubcommand({ rawInput: '/compact keep migration scripts' }), {
    kind: 'focus',
    focusInstruction: 'keep migration scripts',
  });
  assert.deepEqual(parseCompactSubcommand({ rawArgs: "keep\nAPI\t\x07schema   errors" }), {
    kind: 'focus',
    focusInstruction: 'keep API schema errors',
  });
  assert.deepEqual(parseCompactSubcommand({ args: ['focus', 'on', 'tests'] }), {
    kind: 'focus',
    focusInstruction: 'focus on tests',
  });
  assert.deepEqual(parseCompactSubcommand({ rawInput: '/compact resume details' }), {
    kind: 'focus',
    focusInstruction: 'resume details',
  });
  assert.deepEqual(parseCompactSubcommand('-- resume notes'), {
    kind: 'focus',
    focusInstruction: 'resume notes',
  });
  assert.deepEqual(parseCompactSubcommand({ rawInput: '/compact -- migrate plan' }), {
    kind: 'focus',
    focusInstruction: 'migrate plan',
  });
  assert.deepEqual(parseCompactSubcommand({ rawInput: '/compact --' }), { kind: 'focus-empty' });

  const longText = 'A'.repeat(650);
  assert.equal(sanitizeFocusInstruction(longText).length, MAX_FOCUS_INSTRUCTION_CHARS);
  assert.equal(parseCompactSubcommand(longText).focusInstruction.length, MAX_FOCUS_INSTRUCTION_CHARS);
});

await test('command-compact-executes-focus-with-heartbeat-and-preserves-empty-passthrough', async () => {
  let hostCalls = 0;
  const hostResult = { kind: 'success', text: 'host-default' };
  const compactNowCalls = [];

  const compaction = {
    async compactNow(agent, signal, commandId, continuation, options) {
      compactNowCalls.push({ agent, signal, commandId, continuation, options });
      await sleep(16);
      return {
        compactionId: 'weave-focus-1',
        compactionIds: ['weave-focus-1', 'weave-focus-2'],
        chunks: 2,
        shadowedSeqs: [0, 1, 2, 3],
        shadowedTokenCount: 18500,
        summarySeq: 12,
        provider: 'deepseek',
        model: 'deepseek-v4.1-flash',
      };
    },
  };

  const cmd = decorateCompactCommand(
    {
      name: 'compact',
      async handler() {
        hostCalls += 1;
        return hostResult;
      },
    },
    compaction,
  );
  const agent = { session: { id: 'sess-cmd' } };

  // Empty /compact delegates untouched
  assert.equal(await cmd.handler({ rawInput: '/compact', agent, signal: new AbortController().signal }), hostResult);
  assert.equal(hostCalls, 1);
  assert.equal(compactNowCalls.length, 0);

  // `/compact memory leak focus` and `/compact -- resume notes` invoke compactNow with focusInstruction inside HTTP heartbeat
  const scope = createCommandHeartbeatScope({ intervalMs: 5 });
  const response = Object.assign(new EventEmitter(), {
    pulses: 0,
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    writeProcessing() {
      this.pulses += 1;
    },
  });
  const req = { method: 'POST', url: '/api/commands/execute' };
  const sig = new AbortController().signal;
  const focusRes = await scope.handle(req, response, () =>
    cmd.handler({
      rawInput: '/compact -- resume notes',
      agent,
      signal: sig,
      commandId: 'cmd-focus-1',
    }),
  );
  scope.dispose();

  assert.ok(response.pulses >= 1, `expected heartbeat pulses during focus compaction, got ${response.pulses}`);
  assert.equal(compactNowCalls.length, 1);
  assert.equal(compactNowCalls[0].agent, agent);
  assert.equal(compactNowCalls[0].signal, sig);
  assert.equal(compactNowCalls[0].commandId, 'cmd-focus-1');
  assert.equal(compactNowCalls[0].continuation, false);
  assert.deepEqual(compactNowCalls[0].options, { focusInstruction: 'resume notes' });
  assert.equal(focusRes.kind, 'success');
  assert.equal(focusRes.sourceEventSeq, 12);
  assert.match(focusRes.text, /resume notes/);
  assert.match(focusRes.text, /2 段检查点/);
  assert.match(focusRes.text, /18500 tok/);
  assert.equal(hostCalls, 1);

  const memLeakRes = await cmd.handler({
    rawInput: '/compact memory leak focus',
    agent,
    signal: new AbortController().signal,
    commandId: 'cmd-focus-2',
  });
  assert.equal(memLeakRes.kind, 'success');
  assert.deepEqual(compactNowCalls[1].options, { focusInstruction: 'memory leak focus' });

  // Empty `--` reports friendly error without calling compactNow
  const emptyDash = await cmd.handler({ rawInput: '/compact --', agent, signal: new AbortController().signal });
  assert.equal(emptyDash.kind, 'error');
  assert.equal(compactNowCalls.length, 2);

  // compactNow returning null reports clean message
  compaction.compactNow = async () => null;
  const nothingRes = await cmd.handler({ rawArgs: 'keep config', agent, signal: new AbortController().signal });
  assert.equal(nothingRes.kind, 'success');
  assert.match(nothingRes.text, /暂无可压缩/);

  // compactNow throwing error decorates cleanly via diagnostic / failureExplanation
  compaction.failureForCommand = () => ({
    id: 'diag-focus-1',
    status: 'saved',
    attempts: 2,
    auditWriteFailures: 0,
    path: 'diag.json',
    explanation: '聚焦压缩诊断说明。',
  });
  compaction.compactNow = async () => {
    throw Object.assign(new Error('summary failed'), { code: 'CONSTRAINT_LOST' });
  };
  const errRes = await cmd.handler({
    rawInput: '/compact keep rules',
    agent,
    signal: new AbortController().signal,
    commandId: 'cmd-err-1',
  });
  assert.equal(errRes.kind, 'error');
  assert.match(errRes.text, /聚焦压缩诊断说明/);
  assert.match(errRes.text, /diag-focus-1/);

  // Missing compactNow falls back to definition.handler
  const fallbackCmd = decorateCompactCommand(
    {
      name: 'compact',
      async handler(inv) {
        return { kind: 'success', text: `fallback:${inv.rawArgs}` };
      },
    },
    {},
  );
  const fbRes = await fallbackCmd.handler({ rawArgs: 'keep x', agent, signal: new AbortController().signal });
  assert.deepEqual(fbRes, { kind: 'success', text: 'fallback:keep x' });
});

// ── 4. client.js Settings UI: Reinject Control + 8 Reasoning Options ────────

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

async function mountSettings({ language = 'zh', file, initialConfig } = {}) {
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
  return { dictionaries, requests, render, field, click, change };
}

for (const language of ['zh', 'en']) {
  await test(`${language}-client-settings-renders-reinject-preserves-8-efforts-and-gates-touched-save`, async () => {
    const root = await mkdtemp(join(testBaseRoot, `weave-phasea-ui-${language}-`));
    try {
      const file = join(root, 'summary-config.json');
      const h = await mountSettings({ language, file });

      // All 8 v0.4.2 reasoning effort options remain intact
      const reasoningField = h.field('weave-summary-reasoning-effort');
      assert.deepEqual(
        reasoningField.children.map(o => o.props.value),
        ['low', 'none', 'minimal', 'medium', 'high', 'xhigh', 'max', 'inherit'],
      );

      // Post-compact reinject control renders with default 'true' and clear explanation; no sessionMemory UI in Phase A
      const reinjectField = h.field('weave-post-compact-reinject');
      assert.ok(reinjectField);
      assert.equal(reinjectField.props.value, 'true');
      assert.deepEqual(reinjectField.children.map(o => o.props.value), ['true', 'false']);
      assert.equal(h.field('weave-session-memory-enabled'), null);

      const pageText = textOf(h.render());
      assert.match(pageText, language === 'zh' ? /0 LLM Token/ : /0 LLM tokens/);
      assert.match(pageText, /24KB/);
      assert.match(pageText, /AGENTS\.md/);

      // Untouched default omits postCompactReinjectEnabled from set payload
      await h.click('save');
      const untouchedParams = h.requests.filter(r => r.method === 'set').at(-1).params;
      assert.equal(Object.hasOwn(untouchedParams, 'postCompactReinjectEnabled'), false);

      // Touching and saving persists postCompactReinjectEnabled=false cleanly
      h.change('weave-summary-provider', 'p');
      h.change('weave-summary-model', 'm');
      h.change('weave-post-compact-reinject', 'false');
      await h.click('save');

      const setParams = h.requests.filter(r => r.method === 'set').at(-1).params;
      assert.equal(setParams.postCompactReinjectEnabled, false);
      assert.equal(readSummaryConfig(file, { strict: true }).postCompactReinjectEnabled, false);

      // Clear model preserves postCompactReinjectEnabled=false
      await h.click('clear');
      const clearedDisk = readSummaryConfig(file, { strict: true });
      assert.equal(clearedDisk.provider, '');
      assert.equal(clearedDisk.postCompactReinjectEnabled, false);

      // Reloading populates from saved file and marks touched
      const reloaded = await mountSettings({ language, file });
      assert.equal(reloaded.field('weave-post-compact-reinject').props.value, 'false');
      await reloaded.click('save');
      assert.equal(reloaded.requests.filter(r => r.method === 'set').at(-1).params.postCompactReinjectEnabled, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

console.log(JSON.stringify({
  passed: results.filter(r => r.pass).length,
  failed: results.filter(r => !r.pass).length,
  results,
}, null, 2));
if (results.some(r => !r.pass)) process.exitCode = 1;
