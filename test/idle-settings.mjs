import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { DEFAULT_CONFIG, resolveConfig, resolveTargetPolicy } from '../lib/config.js';
import { apply, injectBesideOfficial, mergeSummaryConfig, renameOfficialRows } from '../lib/index.js';
import {
  defaultSummaryConfigPath,
  handleSummaryConfigRpc,
  readSummaryConfig,
  validateSummaryConfig,
  writeSummaryConfig,
} from '../lib/summary-config.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message, stack: error.stack });
  }
}

const root = await mkdtemp(join(tmpdir(), 'weave-idle-settings-'));
const newFile = async () => join(await mkdtemp(join(root, 'settings-')), 'summary-config.json');
const presets = [0, 5, 10, 30, 60, 720, 1440, 10080, 43200];
const validMinutes = [...presets, 1, 37, 43199];
const invalidMinutes = [null, false, true, [], {}, -1, 1.5, 43201, 525600, NaN, Infinity, -Infinity, '', ' ', 'wrong', '5min', '1.5', '43201', '525600', '1e2', '0x1e'];
const invalidCode = { code: 'INVALID_IDLE_COMPACTION_MINUTES' };

await test('engine-default-is-off-and-missing-settings-inherit', () => {
  assert.equal(DEFAULT_CONFIG.idleCompactionMinutes, 0);
  assert.equal(resolveConfig({}).config.idleCompactionMinutes, 0);
  assert.deepEqual(mergeSummaryConfig({}, null), {});
  const saved = validateSummaryConfig({ provider: 'p', model: 'm', maxTokens: 4096 }).value;
  assert.deepEqual(saved, { provider: 'p', model: 'm', maxTokens: 4096, thresholdRatio: null });
  assert.equal(resolveConfig(mergeSummaryConfig({ idleCompactionMinutes: 60 }, saved)).config.idleCompactionMinutes, 60);
});

await test('engine-preserves-preset-custom-and-boundary-values-exactly', () => {
  for (const minutes of validMinutes) {
    const { config, unknown } = resolveConfig({ idleCompactionMinutes: minutes });
    assert.equal(config.idleCompactionMinutes, minutes);
    assert.deepEqual(unknown, []);
  }
});

await test('idle-setting-is-independent-of-the-auto-pressure-switch', () => {
  for (const auto of [true, false]) {
    for (const minutes of [0, 30, 720]) {
      const saved = validateSummaryConfig({ idleCompactionMinutes: minutes }).value;
      const { config } = resolveConfig(mergeSummaryConfig({ auto, idleCompactionMinutes: 60 }, saved));
      assert.equal(config.auto, auto);
      assert.equal(config.idleCompactionMinutes, minutes);
    }
  }
});

await test('engine-rejects-invalid-values-without-rounding-or-coercion', () => {
  for (const value of [...invalidMinutes, '0', '30']) {
    assert.throws(() => resolveConfig({ idleCompactionMinutes: value }), /idleCompactionMinutes/);
  }
});

await test('settings-accept-exact-integer-minutes-and-integer-form-text', () => {
  for (const minutes of validMinutes) {
    for (const raw of [minutes, String(minutes), ` ${minutes} `]) {
      const verdict = validateSummaryConfig({ idleCompactionMinutes: raw });
      assert.equal(verdict.ok, true);
      assert.equal(verdict.value.idleCompactionMinutes, minutes);
      assert.equal(verdict.value.provider, '');
      assert.equal(verdict.value.model, '');
    }
  }
});

await test('settings-validation-and-direct-write-reject-invalid-values', async () => {
  const file = await newFile();
  writeSummaryConfig(file, { idleCompactionMinutes: 37 });
  const before = await readFile(file, 'utf8');
  for (const value of invalidMinutes) {
    const verdict = validateSummaryConfig({ idleCompactionMinutes: value });
    assert.equal(verdict.ok, false, String(value));
    assert.equal(verdict.code, invalidCode.code);
    assert.throws(() => writeSummaryConfig(file, { idleCompactionMinutes: value }), invalidCode);
  }
  assert.equal(await readFile(file, 'utf8'), before);
});

for (const minutes of validMinutes) {
  await test(`rpc-persists-and-merges-${minutes}-minutes-without-summary-model`, async () => {
    const file = await newFile();
    const saved = await handleSummaryConfigRpc({ method: 'set', params: { idleCompactionMinutes: minutes } }, file);
    assert.equal(saved.cleared, false);
    assert.equal(saved.restartRequired, false);
    const disk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(disk.idleCompactionMinutes, minutes);
    assert.equal(disk.summarizationProvider, undefined);
    assert.equal(disk.summarizationModel, undefined);
    const loaded = await handleSummaryConfigRpc({ method: 'get' }, file);
    assert.equal(loaded.restartRequired, false);
    assert.deepEqual(loaded.config, saved.config);
    const inherited = { idleCompactionMinutes: 90, thresholdRatio: 0.75, summarizationProvider: 'p', summarizationModel: 'm' };
    const engine = resolveConfig(mergeSummaryConfig(inherited, loaded.config));
    assert.deepEqual(engine.unknown, []);
    assert.equal(engine.config.idleCompactionMinutes, minutes);
    assert.equal(engine.config.thresholdRatio, 0.75);
    assert.equal(engine.config.summarizationProvider, 'p');
    assert.equal(inherited.idleCompactionMinutes, 90);
  });
}

await test('invalid-rpc-input-never-overwrites-saved-settings', async () => {
  const file = await newFile();
  await handleSummaryConfigRpc({ method: 'set', params: { provider: 'p', model: 'm', idleCompactionMinutes: 30 } }, file);
  const before = await readFile(file, 'utf8');
  for (const value of invalidMinutes) {
    // Use the JSON transport shape as well: NaN/Infinity become explicit null.
    const request = JSON.parse(JSON.stringify({ method: 'set', params: { idleCompactionMinutes: value } }));
    await assert.rejects(handleSummaryConfigRpc(request, file), invalidCode);
    assert.equal(await readFile(file, 'utf8'), before);
  }
});

await test('model-only-rpc-save-and-clear-preserve-idle-including-zero', async () => {
  for (const minutes of [37, 0]) {
    const file = await newFile();
    await handleSummaryConfigRpc({ method: 'set', params: { provider: 'p', model: 'm', idleCompactionMinutes: minutes } }, file);
    await handleSummaryConfigRpc({ method: 'set', params: { provider: 'other', model: 'other-model' } }, file);
    assert.equal(readSummaryConfig(file).idleCompactionMinutes, minutes);
    const cleared = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '' } }, file);
    assert.equal(cleared.cleared, false);
    assert.equal(cleared.restartRequired, false);
    assert.equal(cleared.config.provider, '');
    assert.equal(cleared.config.model, '');
    assert.equal(cleared.config.idleCompactionMinutes, minutes);
    const loaded = (await handleSummaryConfigRpc({ method: 'get' }, file)).config;
    assert.equal(loaded.idleCompactionMinutes, minutes);
    assert.equal(resolveConfig(mergeSummaryConfig({ idleCompactionMinutes: 60 }, loaded)).config.idleCompactionMinutes, minutes);
  }
});

await test('legacy-file-and-model-clear-do-not-invent-an-idle-override', async () => {
  const file = await newFile();
  assert.equal(readSummaryConfig(file), null);
  await writeFile(file, JSON.stringify({ version: 1, summarizationProvider: 'p', summarizationModel: 'm', maxTokens: 8192 }));
  assert.equal(Object.hasOwn(readSummaryConfig(file), 'idleCompactionMinutes'), false);
  const cleared = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '' } }, file);
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.restartRequired, false);
  assert.equal(cleared.config, null);
  assert.equal(readSummaryConfig(file), null);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(file, 'utf8')), 'idleCompactionMinutes'), false);
  assert.equal(mergeSummaryConfig({ idleCompactionMinutes: 60 }, readSummaryConfig(file)).idleCompactionMinutes, 60);
});

await test('malformed-stored-idle-value-is-not-rounded-or-clamped', async () => {
  const file = await newFile();
  for (const value of [-1, 1.5, 43201, 525600, null, false, 'bad']) {
    await writeFile(file, JSON.stringify({ version: 1, idleCompactionMinutes: value }));
    assert.equal(readSummaryConfig(file), null);
  }
});

await test('saved-idle-validation-and-model-policies-keep-the-global-setting', () => {
  for (const value of [null, false, -1, 1.5, 43201, 525600, '30']) {
    assert.throws(() => mergeSummaryConfig({ idleCompactionMinutes: 10 }, { idleCompactionMinutes: value }), /idleCompactionMinutes/);
  }
  const { config } = resolveConfig({ idleCompactionMinutes: 37, modelPolicies: [{ provider: 'p', model: 'm', maxTokens: 4096 }] });
  assert.equal(resolveTargetPolicy(config, 'p', 'm').idleCompactionMinutes, 37);
  assert.equal(resolveTargetPolicy(config, 'other', 'm').idleCompactionMinutes, 37);
});

for (const [name, rewrite] of [['replace', renameOfficialRows], ['inject', injectBesideOfficial]]) {
  await test(`${name}-engine-row-preserves-inherited-value-and-explicit-zero`, () => {
    const rows = [{ id: 'compaction', name: '@deepseek-ai/dsh-compaction-basic', config: { idleCompactionMinutes: 60, auto: false } }];
    for (const saved of [null, { thresholdRatio: 0.8 }, { idleCompactionMinutes: 0 }, { idleCompactionMinutes: 37 }]) {
      const rewritten = rewrite(rows, mergeSummaryConfig({}, saved));
      const engine = rewritten.plugins.find(row => row.name === 'dsh-compaction-weave/engine');
      assert.equal(resolveConfig(engine.config).config.idleCompactionMinutes, saved?.idleCompactionMinutes ?? 60);
      assert.equal(engine.config.auto, false);
      assert.equal(rows[0].config.idleCompactionMinutes, 60);
    }
  });
}

for (const mode of ['replace', 'disable-and-inject']) {
await test(`gate-${mode}-keeps-base-engine-row-across-settings-save-and-clear`, async () => {
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, `gate-home-${mode}`);
  try {
    const file = defaultSummaryConfigPath();
    const mountGate = () => {
      const handlers = new Map();
      apply({ on: (name, fn) => handlers.set(name, fn), provide() {} }, {
        mode,
        engine: { archiveDir: join(root, 'archives'), idleCompactionMinutes: 60 },
        receiptPath: join(root, 'receipts.jsonl'),
      });
      const readEngine = () => {
        const result = handlers.get('internal/config')({}, () => ({ plugins: [
          { name: '@deepseek-ai/dsh-compaction-basic', config: { idleCompactionMinutes: 10 } },
        ] }));
        const row = result.plugins.find(plugin => plugin.name === 'dsh-compaction-weave/engine');
        assert.ok(row);
        return resolveConfig(row.config).config;
      };
      return readEngine;
    };
    await handleSummaryConfigRpc({ method: 'set', params: { provider: 'p', model: 'm', idleCompactionMinutes: 37 } }, file);
    const currentEngine = mountGate();
    assert.equal(currentEngine().idleCompactionMinutes, 60);
    assert.notEqual(currentEngine().summarizationModel, 'm');
    const saved = await handleSummaryConfigRpc({ method: 'set', params: { idleCompactionMinutes: 0 } }, file);
    assert.equal(saved.restartRequired, false);
    assert.equal(saved.config.idleCompactionMinutes, 0);
    assert.equal(currentEngine().idleCompactionMinutes, 60);
    assert.equal(mountGate()().idleCompactionMinutes, 60);
    const cleared = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '', idleCompactionMinutes: 43200 } }, file);
    assert.equal(cleared.restartRequired, false);
    assert.equal(cleared.config.provider, '');
    assert.equal(cleared.config.idleCompactionMinutes, 43200);
    assert.equal(currentEngine().idleCompactionMinutes, 60);
    assert.equal(mountGate()().idleCompactionMinutes, 60);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});
}

// Execute the shipped component with hooks and event handlers. Requests use
// the real settings RPC against temporary files; no model/network calls occur.
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
  return (tree?.children ?? []).map(textOf).join(' ');
}

async function mount({ file, language = 'zh', initial, failSet = false } = {}) {
  file ??= await newFile();
  if (initial !== undefined) await handleSummaryConfigRpc({ method: 'set', params: initial }, file);
  let module, Section, sectionDescriptor, dictionaries;
  let stateIndex = 0, effectIndex = 0;
  const state = [], effects = [], pending = new Set(), requests = [], responses = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: initialState => {
      const index = stateIndex++;
      if (!(index in state)) state[index] = initialState;
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    },
    useEffect: callback => { if (effectIndex++ === 0) effects.push(callback); },
  };
  const sandbox = {
    window: { __ModuleLoader__: { load: declaration => {
      module = declaration.factory(name => { assert.equal(name, 'react'); return React; });
    } } },
    console, AbortController, setTimeout, clearTimeout,
    setInterval: () => { throw new Error('Settings must not start a background timer'); },
    clearInterval,
    fetch: (url, options) => {
      assert.equal(url, '/plugins/dsh-compaction-weave/rpc');
      assert.equal(options.method, 'POST');
      const payload = JSON.parse(options.body);
      requests.push(payload);
      const task = (async () => {
        try {
          if (failSet && payload.method === 'set') throw new Error('Settings storage unavailable');
          const value = payload.method === 'models'
            ? { providers: [{ provider: 'p', name: 'Provider P', models: [{ id: 'm' }, { id: 'm2' }] }] }
            : await handleSummaryConfigRpc(payload, file);
          responses.push({ method: payload.method, value });
          return { status: 200, text: async () => JSON.stringify({ ok: true, value }) };
        } catch (error) {
          return { status: 200, text: async () => JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }) };
        }
      })();
      pending.add(task);
      void task.finally(() => pending.delete(task));
      return task;
    },
  };
  vm.runInNewContext(clientSource, sandbox);
  module.apply({
    slots: {
      inject: (_name, callback) => callback(),
      register: (descriptor, component) => {
        if (descriptor.name === 'settings.section') {
          sectionDescriptor = descriptor;
          Section = component;
        }
        return () => {};
      },
    },
    effect: callback => callback(),
    locale: {
      register: (_namespace, values) => { dictionaries = values; return () => {}; },
      bind: () => key => {
        assert.equal(typeof dictionaries?.[language]?.[key], 'string', `Missing ${language} translation: ${key}`);
        return dictionaries[language][key];
      },
    },
  });
  assert.equal(typeof Section, 'function');
  const render = () => { stateIndex = 0; return Section(); };
  const settle = async () => {
    await Promise.all([...pending]);
    await new Promise(resolve => setImmediate(resolve));
  };
  render();
  const dispose = effects[0]();
  await settle();
  const field = id => find(render(), node => node.props.id === id);
  const button = label => find(render(), node => node.type === 'button' && node.children.includes(label));
  const click = async key => {
    const control = button(dictionaries[language][key]);
    assert.ok(control);
    assert.equal(control.props.disabled, false);
    control.props.onClick();
    await settle();
  };
  return {
    file, requests, responses, render, field, button, click, dispose, sectionDescriptor, dictionaries,
    status: () => textOf(find(render(), node => node.props.role === 'status')),
    change: (id, value) => field(id).props.onChange({ target: { value: String(value) } }),
    select: value => field('weave-idle-compaction').props.onChange({ target: { value: String(value) } }),
    custom: value => field('weave-idle-custom-minutes').props.onChange({ target: { value: String(value) } }),
  };
}

await test('ui-default-off-options-and-first-save-match-engine-default', async () => {
  const h = await mount();
  const control = h.field('weave-idle-compaction');
  assert.equal(control.props.value, '0');
  assert.deepEqual(Array.from(control.children, option => option.props.value), ['0', '5', '10', '30', '60', '720', '1440', '10080', '43200', 'custom']);
  assert.equal(h.field('weave-idle-custom-minutes'), null);
  await h.click('save');
  assert.equal(readSummaryConfig(h.file).idleCompactionMinutes, 0);
  assert.equal(h.requests.find(request => request.method === 'set').params.idleCompactionMinutes, 0);
});

for (const minutes of presets) {
  await test(`ui-fixed-${minutes}-minutes-saves-and-reloads`, async () => {
    const h = await mount({ initial: { idleCompactionMinutes: 37 } });
    h.select(minutes);
    assert.equal(h.field('weave-idle-custom-minutes'), null);
    await h.click('save');
    assert.equal(readSummaryConfig(h.file).idleCompactionMinutes, minutes);
    assert.equal(h.requests.find(request => request.method === 'set').params.idleCompactionMinutes, minutes);
    assert.equal(h.responses.find(response => response.method === 'set').value.restartRequired, false);
    assert.match(h.status(), /已保存，无需重启 DSH。新设置从后续压缩或请求边界生效/);
    h.dispose();
    const reloaded = await mount({ file: h.file });
    assert.equal(reloaded.field('weave-idle-compaction').props.value, String(minutes));
    assert.equal(reloaded.field('weave-idle-custom-minutes'), null);
  });
}

for (const minutes of [1, 37, 10080, 43199, 43200]) {
  await test(`ui-custom-${minutes}-minutes-saves-and-reloads`, async () => {
    const h = await mount();
    h.select('custom');
    const input = h.field('weave-idle-custom-minutes');
    assert.equal(input.props.min, 1);
    assert.equal(input.props.step, 1);
    assert.equal(input.props.max, 43200);
    assert.ok(input.props['aria-describedby'].includes('weave-idle-duration-hint'));
    h.custom(minutes);
    await h.click('save');
    assert.equal(readSummaryConfig(h.file).idleCompactionMinutes, minutes);
    assert.equal(h.requests.find(request => request.method === 'set').params.idleCompactionMinutes, minutes);
    const reloaded = await mount({ file: h.file });
    assert.equal(reloaded.field('weave-idle-compaction').props.value, presets.includes(minutes) ? String(minutes) : 'custom');
    if (presets.includes(minutes)) assert.equal(reloaded.field('weave-idle-custom-minutes'), null);
    else assert.equal(reloaded.field('weave-idle-custom-minutes').props.value, String(minutes));
  });
}

await test('ui-custom-zero-is-rejected-and-off-explicitly-disables-inherited-setting', async () => {
  const h = await mount({ initial: { idleCompactionMinutes: 43200 } });
  h.select('custom');
  h.custom(0);
  await h.click('save');
  assert.match(h.status(), /1–43200.*关闭/);
  assert.equal(h.requests.some(request => request.method === 'set'), false);
  assert.equal(readSummaryConfig(h.file).idleCompactionMinutes, 43200);
  h.select(0);
  await h.click('save');
  assert.equal(resolveConfig(mergeSummaryConfig({ idleCompactionMinutes: 60 }, readSummaryConfig(h.file))).config.idleCompactionMinutes, 0);
  const reloaded = await mount({ file: h.file });
  assert.equal(reloaded.field('weave-idle-compaction').props.value, '0');
});

await test('invalid-ui-values-neither-save-nor-clear-the-model', async () => {
  const h = await mount({ initial: { provider: 'p', model: 'm', idleCompactionMinutes: 30 } });
  const before = await readFile(h.file, 'utf8');
  h.select('custom');
  for (const value of ['', ' ', '0', '-1', '0.5', '1.9', '43201', '525600', 'NaN', 'Infinity', '1e2', '0x1e', 'text']) {
    h.custom(value);
    await h.click('save');
    assert.match(textOf(h.render()), /整数分钟/);
    await h.click('clear');
    assert.match(textOf(h.render()), /整数分钟/);
  }
  assert.equal(h.requests.some(request => request.method === 'set'), false);
  assert.equal(await readFile(h.file, 'utf8'), before);
  h.custom(17);
  await h.click('save');
  assert.equal(readSummaryConfig(h.file).idleCompactionMinutes, 17);
});

await test('switching-away-from-invalid-custom-time-uses-the-selected-preset', async () => {
  const h = await mount();
  h.select('custom');
  h.custom('bad');
  h.select(10);
  await h.click('save');
  assert.equal(readSummaryConfig(h.file).idleCompactionMinutes, 10);
});

for (const minutes of [0, 30, 37, 10080, 43200]) {
  await test(`ui-clearing-summary-model-keeps-${minutes}-minute-setting-and-other-controls`, async () => {
    const h = await mount({ initial: {
      provider: 'p', model: 'm', maxTokens: 16384, idleCompactionMinutes: minutes,
      summaryRetryCount: 3, summaryRetryDelayMs: 2500, summaryTimeoutMs: 240000,
      thresholdRatio: 0.85, minimumReductionRatio: 0.3,
    } });
    await h.click('clear');
    const config = readSummaryConfig(h.file);
    assert.equal(config.provider, '');
    assert.equal(config.model, '');
    assert.equal(config.maxTokens, null);
    assert.equal(config.idleCompactionMinutes, minutes);
    assert.equal(config.summaryRetryCount, 3);
    assert.equal(config.summaryRetryDelayMs, 2500);
    assert.equal(config.summaryTimeoutMs, 240000);
    assert.equal(config.thresholdRatio, 0.85);
    assert.equal(config.minimumReductionRatio, 0.3);
    assert.equal(h.field('weave-summary-provider').props.value, '');
    assert.equal(h.field('weave-summary-model').props.value, '');
    assert.equal(h.field('weave-summary-max-tokens').props.value, '');
    assert.equal(h.responses.find(response => response.method === 'set').value.restartRequired, false);
    assert.match(h.status(), /已清除摘要模型覆盖，无需重启 DSH/);
    const reloaded = await mount({ file: h.file });
    assert.equal(reloaded.field('weave-summary-provider').props.value, '');
    assert.equal(reloaded.field('weave-idle-compaction').props.value, presets.includes(minutes) ? String(minutes) : 'custom');
  });
}

await test('ui-clearing-model-preserves-unsaved-custom-edit', async () => {
  const h = await mount({ initial: { provider: 'p', model: 'm', idleCompactionMinutes: 30 } });
  h.select('custom');
  h.custom(47);
  await h.click('clear');
  assert.equal(readSummaryConfig(h.file).idleCompactionMinutes, 47);
  assert.equal(readSummaryConfig(h.file).provider, '');
});

await test('provider-changes-do-not-auto-select-an-idle-time', async () => {
  const h = await mount({ initial: { idleCompactionMinutes: 37 } });
  h.field('weave-summary-provider').props.onChange({ target: { value: 'p' } });
  assert.equal(h.field('weave-idle-compaction').props.value, 'custom');
  assert.equal(h.field('weave-idle-custom-minutes').props.value, '37');
  await h.click('save');
  assert.equal(readSummaryConfig(h.file).provider, 'p');
  assert.equal(readSummaryConfig(h.file).idleCompactionMinutes, 37);
});

for (const language of ['zh', 'en']) {
  await test(`${language}-ui-explains-idle-trigger-cache-limits-and-apply-boundaries`, async () => {
    const h = await mount({ language });
    const text = textOf(h.render());
    const terms = language === 'zh'
      ? [/闲置后先压缩/, /用户、助手或工具的实际活动/, /新用户消息入队/, /时间未知时不触发/, /与按上下文压力触发的自动压缩开关独立/, /仅在新用户回合的第一步/, /活跃工具循环中不触发/, /仍可压缩的历史/, /保留新输入并停止该次请求/, /GPT-5\.6 及以后.*Responses API.*30 分钟.*12 小时/, /旧模型 in_memory.*5–10 分钟.*最长 1 小时/, /24h.*通常约 30 分钟.*最长 24 小时/, /并非保证/, /上游已启用相应缓存策略/, /不会启用或修改上游缓存/, /30 分钟是本插件的触发参考/, /并非官方/, /DeepSeek \/ GLM.*自定义/, /1 个月固定为 30 天（43200 分钟）/, /7 天／30 天是闲置策略，不代表服务商缓存有效期/, /保存或清除本页设置无需重启 DSH/, /从后续压缩或请求边界生效/, /进行中的压缩仍使用开始时的配置/, /首次安装或升级插件本体仍需按 DSH 提示重载宿主/]
      : [/Compact before resuming/, /actual user, assistant or tool activity/, /new user message is queued/, /Unknown timestamps do not trigger/, /independent of the automatic compaction switch/, /only at the first step of a new user turn/, /Active tool loops do not trigger/, /history that can still be compacted/, /keep the new input and stop that request/, /GPT-5\.6 and later.*Responses API.*30 minutes.*12 hours/, /older models, in_memory.*5–10 idle minutes.*up to 1 hour/, /24h typically lasts around 30 minutes.*up to 24 hours/, /maximum retention is not guaranteed/, /upstream enables the corresponding cache policy/, /does not enable or modify upstream caching/, /30 minutes is this plugin’s trigger reference/, /not an official cache TTL/, /DeepSeek \/ GLM.*custom time/, /1 month is fixed at 30 days \(43200 minutes\)/, /7-day and 30-day presets are idle policies, not provider cache lifetimes/, /Saving or clearing any setting on this page needs no DSH restart/, /subsequent compaction or request boundaries/, /A compaction already in progress keeps the configuration it started with/, /First installation or plugin upgrades still require a host reload as prompted by DSH/];
    for (const term of terms) assert.match(text, term);
    assert.doesNotMatch(text, /525600|重启 DSH 后生效|保存后需要重启|Restart DSH after saving|Restart DSH to apply/);
    const options = h.field('weave-idle-compaction').children;
    assert.match(textOf(options.find(option => option.props.value === '5')), /Claude/);
    assert.match(textOf(options.find(option => option.props.value === '60')), /Claude/);
    assert.match(textOf(options.find(option => option.props.value === '30')), /GPT \/ Gemini/);
    assert.match(textOf(options.find(option => option.props.value === '720')), /GPT 12/);
    assert.match(textOf(options.find(option => option.props.value === '1440')), language === 'zh' ? /旧 GPT.*非保证/ : /older GPT.*not guaranteed/);
    assert.match(textOf(options.find(option => option.props.value === '10080')), language === 'zh' ? /7 天（10080 分钟）/ : /7 days \(10080 minutes\)/);
    assert.match(textOf(options.find(option => option.props.value === '43200')), language === 'zh' ? /30 天（1 个月，43200 分钟）/ : /30 days \(1 month, 43200 minutes\)/);
    h.select('custom');
    assert.ok(h.field('weave-idle-custom-minutes'));
    h.custom('1.5');
    await h.click('save');
    assert.match(h.status(), language === 'zh' ? /1–43200.*整数分钟/ : /integer from 1 to 43200 minutes/);
    h.custom(37);
    await h.click('save');
    assert.equal(readSummaryConfig(h.file).idleCompactionMinutes, 37);
    assert.match(h.status(), language === 'zh' ? /已保存，无需重启 DSH/ : /Saved\. No DSH restart needed/);
  });

  await test(`${language}-ui-save-and-clear-submit-all-current-controls-without-restart`, async () => {
    const h = await mount({ language });
    for (const [id, value] of [
      ['weave-summary-provider', 'p'],
      ['weave-summary-model', 'm2'],
      ['weave-summary-max-tokens', '16384'],
      ['weave-summary-threshold', '85'],
      ['weave-minimum-reduction', '35'],
      ['weave-summary-retry-count', '4'],
      ['weave-summary-retry-delay', '1.25'],
      ['weave-summary-timeout', '240'],
      ['weave-audit-block-on-loss', 'false'],
    ]) h.change(id, value);
    h.select(43200);
    const savedValues = {
      provider: 'p', model: 'm2', maxTokens: 16384,
      thresholdRatio: 0.85, minimumReductionRatio: 0.35,
      summaryRetryCount: 4, summaryRetryDelayMs: 1250, summaryTimeoutMs: 240000,
      idleCompactionMinutes: 43200,
      auditBlockOnLoss: false,
    };
    await h.click('save');
    assert.deepEqual(h.requests.filter(request => request.method === 'set').at(-1).params, savedValues);
    assert.deepEqual(readSummaryConfig(h.file), savedValues);
    assert.equal(h.responses.filter(response => response.method === 'set').at(-1).value.restartRequired, false);
    assert.match(h.status(), language === 'zh' ? /已保存，无需重启 DSH.*后续压缩或请求边界/ : /Saved\. No DSH restart needed.*subsequent compaction or request boundaries/);

    for (const [id, value] of [
      ['weave-summary-threshold', '75'],
      ['weave-minimum-reduction', '25'],
      ['weave-summary-retry-count', '0'],
      ['weave-summary-retry-delay', '0'],
      ['weave-summary-timeout', '60'],
      ['weave-audit-block-on-loss', 'true'],
    ]) h.change(id, value);
    h.select('custom');
    h.custom(43199);
    await h.click('clear');
    const clearedValues = {
      provider: '', model: '', maxTokens: null,
      thresholdRatio: 0.75, minimumReductionRatio: 0.25,
      summaryRetryCount: 0, summaryRetryDelayMs: 0, summaryTimeoutMs: 60000,
      idleCompactionMinutes: 43199,
      auditBlockOnLoss: true,
    };
    assert.deepEqual(h.requests.filter(request => request.method === 'set').at(-1).params, clearedValues);
    assert.deepEqual(readSummaryConfig(h.file), clearedValues);
    const response = h.responses.filter(response => response.method === 'set').at(-1).value;
    assert.equal(response.restartRequired, false);
    assert.equal(response.cleared, false, 'Independent settings remain saved when the model override is cleared');
    assert.match(h.status(), language === 'zh' ? /已清除摘要模型覆盖，无需重启 DSH.*后续压缩或请求边界/ : /Summary model override cleared\. No DSH restart needed.*subsequent compaction or request boundaries/);
    for (const id of ['weave-summary-provider', 'weave-summary-model', 'weave-summary-max-tokens']) {
      assert.equal(h.field(id).props.value, '');
    }
    const reloaded = await mount({ file: h.file, language });
    for (const [id, value] of [
      ['weave-summary-provider', ''], ['weave-summary-model', ''], ['weave-summary-max-tokens', ''],
      ['weave-summary-threshold', 75], ['weave-minimum-reduction', 25],
      ['weave-summary-retry-count', '0'], ['weave-summary-retry-delay', '0'], ['weave-summary-timeout', '60'],
      ['weave-idle-compaction', 'custom'], ['weave-idle-custom-minutes', '43199'],
      ['weave-audit-block-on-loss', 'true'],
    ]) assert.equal(reloaded.field(id).props.value, value, id);
  });

  await test(`${language}-ui-failed-save-or-clear-retains-model-and-does-not-claim-applied`, async () => {
    const h = await mount({ language, failSet: true, initial: { provider: 'p', model: 'm', maxTokens: 16384, idleCompactionMinutes: 30 } });
    const before = await readFile(h.file, 'utf8');
    h.select(43200);
    for (const action of ['save', 'clear']) {
      await h.click(action);
      assert.match(h.status(), language === 'zh' ? /保存失败：Settings storage unavailable/ : /Save failed: Settings storage unavailable/);
      assert.doesNotMatch(h.status(), /无需重启|已保存|已清除|No DSH restart|Saved\.|override cleared/);
      assert.equal(h.field('weave-summary-provider').props.value, 'p');
      assert.equal(h.field('weave-summary-model').props.value, 'm');
      assert.equal(h.field('weave-summary-max-tokens').props.value, '16384');
      assert.equal(h.field('weave-idle-compaction').props.value, '43200');
      assert.equal(await readFile(h.file, 'utf8'), before);
    }
  });

  await test(`${language}-guide-matches-ui-month-limit-and-settings-apply-scope`, async () => {
    const path = language === 'zh' ? '../docs/configuration.md' : '../docs/en/configuration.md';
    const guide = await readFile(new URL(path, import.meta.url), 'utf8');
    const terms = language === 'zh'
      ? [/1–43200 整数分钟/, /7 天（10080 分钟）／30 天（43200 分钟）/, /1 个月固定为 30 天，即 43200 分钟/, /自定义输入从 1 开始/, /Claude.*5／60 分钟.*GPT.*Gemini.*30 分钟/, /7 天和 30 天.*不表示服务商缓存/, /保存或清除本页设置无需重启 DSH/, /摘要模型、输出上限、触发比例、最小压缩幅度、重试和闲置设置/, /后续压缩或请求边界/, /进行中的压缩继续使用开始时的配置快照/, /首次安装或升级插件本体仍需按 DSH 提示重载宿主/, /包括尚未保存的修改/]
      : [/1–43200 whole minutes/, /7 days \(10080 minutes\) \/ 30 days \(43200 minutes\)/, /1 month is fixed at 30 days, or 43200 minutes/, /Custom input starts at 1/, /Claude 5 \/ 60-minute.*GPT.*Gemini 30-minute/, /7-day and 30-day.*do not imply that provider caches/, /Saving or clearing settings on this page needs no DSH restart/, /summary model, output limit, trigger ratio, minimum reduction, retry and idle settings/, /subsequent compaction or request boundaries/, /A compaction already in progress keeps the configuration snapshot it started with/, /First installation or plugin upgrades still require a host reload as prompted by DSH/, /including unsaved edits/];
    for (const term of terms) assert.match(guide, term);
    assert.doesNotMatch(guide, /525600|重启 DSH 后生效|保存后需要重启|保存后重启 DSH|Restart DSH after saving|Restart DSH to apply/);
  });

  await test(`${language}-ui-section-renamed-compact-grid-and-dsh-theme-tokens`, async () => {
    const h = await mount({ language });
    const tree = h.render();
    assert.equal(h.sectionDescriptor.label(), language === 'zh' ? '上下文压缩' : 'Compaction');
    const heading = find(tree, node => node.type === 'h2');
    assert.ok(heading);
    assert.equal(textOf(heading), language === 'zh' ? '上下文压缩（Weave）' : 'Context Compaction (Weave)');
    assert.match(
      textOf(tree),
      language === 'zh'
        ? /配置 Weave 的摘要模型、触发阈值、闲置压缩与保留检查策略。/
        : /Configure summary model, compaction thresholds, idle compaction, and retention checks\./,
    );
    assert.equal(tree.props.style.padding, '12px 16px');
    assert.equal(tree.props.style.gap, 10);
    const twoColGrid = find(tree, node => node.props?.style?.display === 'grid' && node.props?.style?.gridTemplateColumns === 'repeat(2, minmax(0, 1fr))');
    assert.ok(twoColGrid, 'Settings section must use compact 2-column grid rows');
    const details = find(tree, node => node.type === 'details');
    assert.ok(details && details.props.open === undefined, 'Vendor cache reference details must start collapsed');

    const saveBtn = h.button(h.dictionaries[language].save);
    assert.equal(saveBtn.props.style.background, 'var(--dsw-alias-button-info-fill, var(--dsw-alias-state-business-primary, #2f6fed))');
    assert.equal(saveBtn.props.style.borderColor, 'transparent');
    assert.equal(saveBtn.props.style.color, 'var(--dsw-alias-label-primary-foreground, #ffffff)');

    const clearBtn = h.button(h.dictionaries[language].clear);
    assert.equal(clearBtn.props.style.background, 'var(--dsw-alias-bg-layer-2, transparent)');
    assert.equal(clearBtn.props.style.borderColor, 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))');
    assert.equal(clearBtn.props.style.color, 'var(--dsw-alias-label-primary, inherit)');
    h.dispose();
  });
}

console.log(JSON.stringify({
  passed: results.filter(result => result.pass).length,
  failed: results.filter(result => !result.pass).length,
  results,
}, null, 2));
if (results.some(result => !result.pass)) process.exitCode = 1;
