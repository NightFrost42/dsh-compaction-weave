// 装载冒烟测试：用假的 ctx 把插件的两个入口真正跑一遍。
//
// 目的不是"证明能压缩"（那要真机），而是提前抓出三类低级但致命的错误：
//   1. 模块加载期就炸（import 失败、默认导出形状不对、函数 name 只读冲突）
//   2. `apply()` 里用到宿主不存在的 API 时没有兜底（直接抛错 → 整个插件不加载）
//   3. `internal/config` 钩子对真实 preset 结构改不动（那压缩就完全没接管）
//
// 跑法：node test/smoke.mjs

import assert from 'node:assert/strict';

import gate, { countEngineRows, renameOfficialRows } from '../lib/index.js';
import engineEntry from '../lib/engine-entry.js';
import { resolveConfig } from '../lib/config.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL ${name}\n         ${error?.stack ?? error}\n`);
  }
}

/** 记录所有日志，便于断言"有没有安静地失败"。 */
function fakeCtx(overrides = {}) {
  const logs = [];
  const listeners = new Map();
  const services = new Map();
  const tools = [];
  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
      debug: (m) => logs.push(['debug', m]),
    },
    on(event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
    provide(name, value) {
      services.set(name, value);
      return () => services.delete(name);
    },
    reflect: {
      provide(name, value) {
        services.set(name, value);
        return () => services.delete(name);
      },
    },
    get(name) {
      return services.get(name);
    },
    // cordis 的 `ctx.inject(deps, cb)`：依赖齐了就跑回调，回调拿到的是同一个
    // 注入了这些服务的 ctx。这里简化成"一律立刻跑"，因为假 ctx 上什么服务都
    // 直接可读；缺 `tools` 的场景由 overrides 单独模拟。
    inject(deps, callback) {
      const missing = deps.filter((dep) => ctx[dep] === undefined);
      if (missing.length > 0) return undefined;
      return callback(ctx);
    },
    tools: {
      register(spec) {
        tools.push(spec);
      },
    },
    tokenMeter: {
      async measure() {
        return { nodes: [], pricedNodes: [], totalTokens: 0 };
      },
    },
    llm: {
      async resolveModelInfo() {
        return undefined;
      },
      async *stream() {
        // 空流
      },
    },
    ...overrides,
  };
  return { ctx, logs, listeners, services, tools };
}

// ─────────────────────────────────────────────── 1. 模块形状

test('gate 默认导出带 name / inject / apply', () => {
  assert.equal(gate.name, 'compaction-weave');
  assert.deepEqual(gate.inject, []);
  assert.equal(typeof gate.apply, 'function');
});

test('engine 入口默认导出带 name / inject / apply', () => {
  assert.equal(engineEntry.name, 'compaction-weave-engine');
  assert.ok(Array.isArray(engineEntry.inject));
  assert.equal(typeof engineEntry.apply, 'function');
});

test('两个入口都不需要任何 @deepseek-ai 运行时依赖', async () => {
  // 只要 import 成功就说明没有裸导入核心包（否则在插件目录会 ERR_MODULE_NOT_FOUND）。
  assert.ok(true);
});

// ─────────────────────────────────────────────── 2. gate 的配置改写

test('gate 在真实 preset 结构上把引擎行换名', () => {
  const { ctx, logs, listeners } = fakeCtx();
  gate.apply(ctx, { mode: 'replace', engine: { thresholdRatio: 0.75 } });

  const hook = listeners.get('internal/config');
  assert.equal(typeof hook, 'function', '必须注册 internal/config 钩子');

  // 结构与 asar 里 dsh-web-app/presets/cordis.patch.yml 逐字一致：
  // preset 行 → config.plugins（行数组）→ compaction group → config（行数组）→ 引擎行
  // 注意 preset 的 config 是对象（带 id/order/plugins），不是裸数组。
  const raw = {
    plugins: [
      {
        id: 'preset-cordis',
        name: '@deepseek-ai/dsh-agent-preset',
        config: {
          id: 'cordis',
          order: 4,
          plugins: [
            { id: 'persona', name: '@deepseek-ai/dsh-persona' },
            {
              id: 'compaction',
              name: 'cordis:group',
              group: true,
              isolate: { compaction: true, toolResultPruner: true },
              config: [
                { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
                { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
                { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner' },
              ],
            },
          ],
        },
      },
    ],
  };

  const rewritten = hook.call({ entry: { options: { name: '@deepseek-ai/dsh-agent-preset' } } }, raw, () => raw);

  const preset = rewritten.plugins[0];
  assert.equal(preset.config.id, 'cordis', 'preset 的 config 其它字段必须保留');
  assert.equal(preset.config.order, 4);
  assert.ok(Array.isArray(preset.config.plugins), 'plugins 必须还在 config.plugins 里');

  const group = preset.config.plugins.find((row) => row.id === 'compaction');
  const engineRow = group.config.find((row) => row.name === 'dsh-compaction-weave/engine');
  assert.ok(engineRow, '引擎行必须被换名');
  assert.equal(engineRow.id, 'compaction-basic', 'id 必须保留（isolate 组靠它定位）');
  assert.equal(engineRow.config.thresholdRatio, 0.75, '插件配置必须合并进去');
  assert.equal(
    group.config.find((row) => row.id === 'command-compact').name,
    'dsh-compaction-weave/command-compact',
    'command delegates to the stock handler',
  );
  assert.equal(group.isolate.compaction, true, 'isolate 必须原样保留');

  assert.ok(
    logs.some(([level, m]) => level === 'info' && m.includes('engine installed')),
    '必须留下"已安装"日志',
  );
});

test('gate 在没有引擎行的配置树上原样返回', () => {
  const { ctx, listeners } = fakeCtx();
  gate.apply(ctx, {});
  const hook = listeners.get('internal/config');
  const raw = { plugins: [{ id: 'x', name: 'something-else' }] };
  const out = hook.call({}, raw, () => raw);
  assert.equal(out, raw, '没有匹配时必须是同一个对象（不做无意义复制）');
});

test('gate 幂等：钩子跑两次不会重复改写', () => {
  const { ctx, listeners } = fakeCtx();
  gate.apply(ctx, {});
  const hook = listeners.get('internal/config');
  const raw = { plugins: [{ id: 'c', name: '@deepseek-ai/dsh-compaction-basic' }] };
  const once = hook.call({}, raw, () => raw);
  const twice = hook.call({}, once, () => once);
  assert.equal(twice, once, '第二次应该因为匹配不到而原样返回');
});

test('gate 在 next() 返回非对象时不崩', () => {
  const { ctx, listeners } = fakeCtx();
  gate.apply(ctx, {});
  const hook = listeners.get('internal/config');
  assert.equal(hook.call({}, {}, () => undefined), undefined);
  assert.equal(hook.call({}, {}, () => null), null);
});

test('gate 的 disable-and-inject 模式把官方行关掉并另起一行', () => {
  const { ctx, listeners } = fakeCtx();
  gate.apply(ctx, { mode: 'disable-and-inject' });
  const hook = listeners.get('internal/config');
  const raw = {
    plugins: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
    ],
  };
  const out = hook.call({}, raw, () => raw);
  assert.equal(out.plugins.length, 3);
  assert.equal(out.plugins[0].disabled, true);
  assert.equal(out.plugins[1].name, 'dsh-compaction-weave/engine');
  assert.equal(out.plugins[2].name, 'dsh-compaction-weave/command-compact');
});

test('countEngineRows 能在 preset 的多层嵌套里数到引擎行', () => {
  const plugins = [
    { id: 'a', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'a', plugins: [
      { id: 'compaction', group: true, config: [
        { id: 'cb', name: '@deepseek-ai/dsh-compaction-basic' },
      ] },
    ] } },
    { id: 'b', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'b', plugins: [
      { id: 'compaction', group: true, config: [
        { id: 'cb', name: '@deepseek-ai/dsh-compaction-basic' },
      ] },
    ] } },
  ];
  assert.equal(countEngineRows(plugins), 2, '两个 preset 各一个引擎');
});

test('gate 也认裸数组形态的配置载荷', () => {
  const { ctx, listeners } = fakeCtx();
  gate.apply(ctx, {});
  const hook = listeners.get('internal/config');
  const raw = [{ id: 'c', name: '@deepseek-ai/dsh-compaction-basic' }];
  const out = hook.call({}, raw, () => raw);
  assert.ok(Array.isArray(out), '裸数组进、裸数组出');
  assert.equal(out[0].name, 'dsh-compaction-weave/engine');
});

test('gate 也认 config.plugins 形态的配置载荷', () => {
  const { ctx, listeners } = fakeCtx();
  gate.apply(ctx, {});
  const hook = listeners.get('internal/config');
  const raw = { config: { plugins: [{ id: 'c', name: '@deepseek-ai/dsh-compaction-basic' }] } };
  const out = hook.call({}, raw, () => raw);
  assert.equal(out.config.plugins[0].name, 'dsh-compaction-weave/engine');
});

// ─────────────────────────────────────────────── 3. engine 入口

test('engine.apply 能注册服务、注册工具、不抛错', () => {
  const { ctx, logs, services, tools } = fakeCtx();
  const dispose = engineEntry.apply(ctx, { archiveEnabled: true, debug: true });
  assert.equal(typeof dispose, 'function', '必须返回清理函数');
  assert.ok(services.has('compaction'), '必须把引擎注册成 compaction 服务');
  assert.equal(services.get('compaction').name, 'compaction', '服务名要叫 compaction');
  assert.equal(tools.length, 4, '应当注册三个 history 工具及 context_compact');
  assert.deepEqual(tools.map((t) => t.name).sort(), ['context_compact', 'history_list', 'history_read', 'history_search']);
  assert.ok(logs.some(([, m]) => m.includes('engine ready')));
  dispose();
});

test('engine.apply 在宿主缺 tools / provide 时仍然不崩', () => {
  const { ctx } = fakeCtx({ tools: undefined, provide: undefined, reflect: undefined });
  assert.doesNotThrow(() => engineEntry.apply(ctx, {}));
});

test('三个 history 工具的描述符满足宿主 register() 的强制校验', () => {
  const { ctx, tools } = fakeCtx();
  engineEntry.apply(ctx, {});
  assert.equal(tools.length, 4);
  for (const spec of tools) {
    // 宿主源码（/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js 的 register()）：
    //   if (output === void 0 || typeof output !== 'object' || typeof output.render !== 'function')
    //     throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
    // 少了 render，三个工具会全部注册失败，只在日志里留一行 warn。
    assert.equal(typeof spec.output?.render, 'function', `${spec.name} 必须声明 output.render`);
    assert.deepEqual(spec.output.schema, { type: 'string' }, `${spec.name} 的输出 schema 必须是 string`);
    assert.equal(typeof spec.execute, 'function');
    assert.ok(Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0, 'timeoutMs 必须是正数');
    // render 的返回值必须是内容块数组
    const blocks = spec.output.render({}, 'hello');
    assert.ok(Array.isArray(blocks) && blocks[0]?.type === 'text' && blocks[0].text === 'hello');
  }
});

test('engine.apply 把未知配置键记成警告而不是抛错', () => {
  const { ctx, logs } = fakeCtx();
  engineEntry.apply(ctx, { nonsenseKey: 1 });
  assert.ok(logs.some(([level, m]) => level === 'warn' && m.includes('nonsenseKey')));
});

test('engine.apply 接受空配置并落到默认值', () => {
  const { ctx, services } = fakeCtx();
  engineEntry.apply(ctx, undefined);
  const engine = services.get('compaction');
  assert.equal(engine.config.thresholdRatio, resolveConfig({}).config.thresholdRatio);
});

// ─────────────────────────────────────────────── 4. 三个方法的兜底行为

test('compactIfNeeded 在没有 session 时返回 null 而不是抛错', async () => {
  const { ctx, services } = fakeCtx();
  engineEntry.apply(ctx, {});
  const engine = services.get('compaction');
  assert.equal(await engine.compactIfNeeded({}, 'pressure', new AbortController().signal), null);
});

test('compactIfNeeded 在 tokenMeter 缺失时返回 null', async () => {
  const { ctx, services } = fakeCtx({ tokenMeter: undefined });
  engineEntry.apply(ctx, {});
  const engine = services.get('compaction');
  const agent = { session: { id: 's', surface: { nodes: [0, 1], replaceGeneration: 0 }, eventAt: () => undefined } };
  assert.equal(await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal), null);
});

test('compactIfNeeded 在 signal 已 abort 时立刻返回 null', async () => {
  const { ctx, services } = fakeCtx();
  engineEntry.apply(ctx, {});
  const engine = services.get('compaction');
  const controller = new AbortController();
  controller.abort();
  const agent = { session: { id: 's', surface: { nodes: [], replaceGeneration: 0 }, eventAt: () => undefined } };
  assert.equal(await engine.compactIfNeeded(agent, 'pressure', controller.signal), null);
});

test('compactNow 在没有 runMaintenance 时抛 busy', async () => {
  const { ctx, services } = fakeCtx();
  engineEntry.apply(ctx, {});
  const engine = services.get('compaction');
  await assert.rejects(
    () => engine.compactNow({ session: { id: 's' } }, new AbortController().signal),
    (error) => error.code === 'busy',
  );
});

test('compactRegion 在区间不在 surface 上时抛官方同款报错', async () => {
  const { ctx, services } = fakeCtx();
  engineEntry.apply(ctx, {});
  const engine = services.get('compaction');
  const session = {
    id: 's',
    seq: 2,
    surface: { nodes: [0, 1], replaceGeneration: 0 },
    eventAt: () => undefined,
  };
  await assert.rejects(
    () => engine.compactRegion(99, 1, { session }, new AbortController().signal),
    /start seq 99 not found in surface/,
  );
});

test('重复 apply 两个 realm 时各自注册自己的引擎实例', () => {
  const a = fakeCtx();
  const b = fakeCtx();
  engineEntry.apply(a.ctx, { thresholdRatio: 0.6 });
  engineEntry.apply(b.ctx, { thresholdRatio: 0.9 });
  assert.notEqual(a.services.get('compaction'), b.services.get('compaction'));
  assert.equal(a.services.get('compaction').config.thresholdRatio, 0.6);
  assert.equal(b.services.get('compaction').config.thresholdRatio, 0.9);
});

// ─────────────────────────────────────────────── 汇总

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
