import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { resolveConfig } from '../lib/config.js';
import {
  handleSummaryConfigRpc,
  mergeSummaryConfig,
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

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const pkgJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const localeZh = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8'));
const localeEn = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8'));

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of tree.children ?? []) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

function findAll(tree, predicate, out = []) {
  if (!tree || typeof tree !== 'object') return out;
  if (predicate(tree)) out.push(tree);
  for (const child of tree.children ?? []) {
    findAll(child, predicate, out);
  }
  return out;
}

function textOf(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (!tree || typeof tree !== 'object') return '';
  return (tree.children ?? []).map(textOf).join(' ');
}

function depsChanged(prev, next) {
  if (prev === undefined || next === undefined) return true;
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i += 1) {
    if (!Object.is(prev[i], next[i])) return true;
  }
  return false;
}

/**
 * Dependency-aware minimal React hook harness supporting ONLY
 * `{ createElement, useState, useEffect }` to match DSH client guardrails.
 */
function mountProgressCard({ language = 'zh', handler, initialVisibility = 'visible', clipboard } = {}) {
  let mod;
  let dictionaries;
  const registeredSlots = new Map();
  let stateIndex = 0;
  let effectIndex = 0;
  const states = [];
  const effects = [];
  const pendingFetches = new Set();
  const requests = [];
  const timers = new Map();
  let nextTimerId = 1;
  const scheduledDelays = [];
  const visibilityListeners = new Set();

  const doc = {
    visibilityState: initialVisibility,
    hidden: initialVisibility === 'hidden',
    addEventListener(event, fn) {
      if (event === 'visibilitychange') visibilityListeners.add(fn);
    },
    removeEventListener(event, fn) {
      if (event === 'visibilitychange') visibilityListeners.delete(fn);
    },
  };

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false && c !== true),
    }),
    useState: initialState => {
      const index = stateIndex++;
      if (!(index in states)) {
        states[index] = typeof initialState === 'function' ? initialState() : initialState;
      }
      return [
        states[index],
        value => {
          states[index] = typeof value === 'function' ? value(states[index]) : value;
        },
      ];
    },
    useEffect: (callback, deps) => {
      const index = effectIndex++;
      const prev = effects[index];
      if (!prev || depsChanged(prev.deps, deps)) {
        effects[index] = { callback, deps, pending: true, cleanup: prev?.cleanup };
      }
    },
  };

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: declaration => {
          mod = declaration.factory(name => {
            assert.equal(name, 'react', 'lib/client.js must only require react');
            return React;
          });
        },
      },
    },
    document: doc,
    ...(clipboard !== undefined ? { navigator: { clipboard } } : {}),
    console,
    AbortController,
    setTimeout: (fn, delay) => {
      const id = nextTimerId++;
      scheduledDelays.push(delay);
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: id => {
      timers.delete(id);
    },
    setInterval: () => {
      throw new Error('lib/client.js must use adaptive chained setTimeout, never setInterval');
    },
    clearInterval: () => {},
    fetch: (url, options) => {
      assert.equal(url, '/plugins/dsh-compaction-weave/rpc');
      assert.equal(options.method, 'POST');
      assert.equal(options.credentials, 'same-origin');
      const payload = JSON.parse(options.body);
      requests.push(payload);
      const task = (async () => {
        const result = await handler(payload);
        if (result && result.__error) {
          return { status: 200, text: async () => JSON.stringify({ ok: false, error: result.__error }) };
        }
        return { status: 200, text: async () => JSON.stringify({ ok: true, value: result }) };
      })();
      pendingFetches.add(task);
      void task.finally(() => pendingFetches.delete(task));
      return task;
    },
  };

  vm.runInNewContext(clientSource, sandbox);
  assert.deepEqual(Array.from(mod.inject), ['slots', 'locale']);
  mod.apply({
    slots: {
      inject: (_name, callback) => callback(),
      register: (descriptor, component) => {
        registeredSlots.set(descriptor.name, { descriptor, component });
        return () => {};
      },
    },
    effect: callback => callback(),
    locale: {
      register: (_ns, values) => {
        dictionaries = values;
        return () => {};
      },
      bind: () => key => {
        assert.equal(typeof dictionaries?.[language]?.[key], 'string', `Missing ${language} translation: ${key}`);
        return dictionaries[language][key];
      },
    },
  });

  const entry = registeredSlots.get('conversation.input.dock');
  assert.ok(entry && typeof entry.component === 'function', 'conversation.input.dock component must be registered');
  const Card = entry.component;

  let lastProps = {};
  const flushEffects = () => {
    for (const slot of effects) {
      if (slot && slot.pending) {
        slot.pending = false;
        if (typeof slot.cleanup === 'function') slot.cleanup();
        slot.cleanup = slot.callback();
      }
    }
  };

  const render = (props = lastProps) => {
    lastProps = props;
    stateIndex = 0;
    effectIndex = 0;
    const tree = Card(props);
    flushEffects();
    return tree;
  };

  const settle = async () => {
    for (let i = 0; i < 6; i += 1) {
      if (pendingFetches.size > 0) await Promise.all([...pendingFetches]);
      await new Promise(resolve => setImmediate(resolve));
      render(lastProps);
    }
    return render(lastProps);
  };

  const fireNextTimer = async () => {
    const first = timers.entries().next();
    assert.ok(!first.done, 'Expected a scheduled poll timer');
    const [id, entryTimer] = first.value;
    timers.delete(id);
    entryTimer.fn();
    return settle();
  };

  const fireTimerWithDelay = async targetDelay => {
    for (const [id, entryTimer] of timers.entries()) {
      if (entryTimer.delay === targetDelay) {
        timers.delete(id);
        entryTimer.fn();
        return settle();
      }
    }
    throw new Error(`Expected scheduled timer with delay ${targetDelay}`);
  };

  const setVisibility = state => {
    doc.visibilityState = state;
    doc.hidden = state === 'hidden';
    for (const fn of [...visibilityListeners]) fn();
  };

  const unmount = () => {
    for (const slot of effects) {
      if (typeof slot?.cleanup === 'function') slot.cleanup();
    }
  };

  return {
    dictionaries,
    registeredSlots,
    requests,
    timers,
    scheduledDelays,
    render,
    settle,
    fireNextTimer,
    fireTimerWithDelay,
    setVisibility,
    unmount,
    byAction: (tree, action) => find(tree, n => n.props?.['data-action'] === action),
  };
}

async function mountSettingsSection({ language = 'zh', initialConfig = null, providers = [{ provider: 'p', name: 'Provider P', models: [{ id: 'm' }] }], rpcHandler = null } = {}) {
  let mod;
  let Section;
  let dictionaries;
  let savedConfig = initialConfig ? { ...initialConfig } : null;
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
      if (!(index in states)) {
        states[index] = typeof initialState === 'function' ? initialState() : initialState;
      }
      return [
        states[index],
        value => {
          states[index] = typeof value === 'function' ? value(states[index]) : value;
        },
      ];
    },
    useEffect: (callback, deps) => {
      const index = effectIndex++;
      const prev = effects[index];
      if (!prev || depsChanged(prev.deps, deps)) {
        effects[index] = { callback, deps, pending: true, cleanup: prev?.cleanup };
      }
    },
  };

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: declaration => {
          mod = declaration.factory(name => {
            assert.equal(name, 'react', 'lib/client.js must only require react');
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
      throw new Error('Settings section must never call setInterval');
    },
    clearInterval: () => {},
    fetch: (url, options) => {
      assert.equal(url, '/plugins/dsh-compaction-weave/rpc');
      assert.equal(options.method, 'POST');
      const payload = JSON.parse(options.body);
      requests.push(payload);
      const task = (async () => {
        if (typeof rpcHandler === 'function') {
          const handled = await rpcHandler(payload);
          if (handled) return handled;
        }
        if (payload.method === 'get') {
          return { status: 200, text: async () => JSON.stringify({ ok: true, value: { config: savedConfig, cleared: false, restartRequired: false } }) };
        }
        if (payload.method === 'models') {
          return { status: 200, text: async () => JSON.stringify({ ok: true, value: { providers } }) };
        }
        if (payload.method === 'set') {
          savedConfig = { ...(payload.params ?? {}) };
          return { status: 200, text: async () => JSON.stringify({ ok: true, value: { config: savedConfig, cleared: false, restartRequired: false } }) };
        }
        return { status: 200, text: async () => JSON.stringify({ ok: false, error: { code: 'UNKNOWN_METHOD', message: payload.method } }) };
      })();
      pendingFetches.add(task);
      void task.finally(() => pendingFetches.delete(task));
      return task;
    },
  };

  vm.runInNewContext(clientSource, sandbox);
  mod.apply({
    slots: {
      inject: (_name, callback) => callback(),
      register: (descriptor, component) => {
        if (descriptor.name === 'settings.section') Section = component;
        return () => {};
      },
    },
    effect: callback => callback(),
    locale: {
      register: (_ns, values) => {
        dictionaries = values;
        return () => {};
      },
      bind: () => key => {
        assert.equal(typeof dictionaries?.[language]?.[key], 'string', `Missing ${language} translation: ${key}`);
        return dictionaries[language][key];
      },
    },
  });

  const render = () => {
    stateIndex = 0;
    effectIndex = 0;
    const tree = Section();
    for (const slot of effects) {
      if (slot && slot.pending) {
        slot.pending = false;
        if (typeof slot.cleanup === 'function') slot.cleanup();
        slot.cleanup = slot.callback();
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
    const btn = button(key);
    assert.ok(btn, `Missing button ${key}`);
    btn.props.onClick();
    return settle();
  };
  const change = (id, value) => {
    const node = field(id);
    assert.ok(node, `Missing field ${id}`);
    node.props.onChange({ target: { value: String(value) } });
    return render();
  };
  const statusText = () => textOf(find(render(), node => node.props?.role === 'status'));
  return { dictionaries, requests, render, settle, field, button, click, change, statusText, getSaved: () => savedConfig };
}

await test('package-manifest-injects-conversation-ui-and-locales-valid', () => {
  assert.deepEqual(pkgJson.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-plugin-manager',
    '@deepseek-ai/dsh-client-ui-conversation',
  ]);
  assert.equal(typeof localeZh.meta?.title, 'string');
  assert.equal(typeof localeZh.meta?.description, 'string');
  assert.equal(typeof localeEn.meta?.title, 'string');
  assert.equal(typeof localeEn.meta?.description, 'string');
});

await test('dictionaries-zh-and-en-are-100-percent-key-symmetric-and-slots-registered', () => {
  const h = mountProgressCard({ handler: () => ({ active: false }) });
  const zhKeys = Object.keys(h.dictionaries.zh).sort();
  const enKeys = Object.keys(h.dictionaries.en).sort();
  assert.deepEqual(zhKeys, enKeys);
  for (const key of zhKeys) {
    assert.equal(typeof h.dictionaries.zh[key], 'string', `zh.${key}`);
    assert.ok(h.dictionaries.zh[key].length > 0, `zh.${key} nonempty`);
    assert.equal(typeof h.dictionaries.en[key], 'string', `en.${key}`);
    assert.ok(h.dictionaries.en[key].length > 0, `en.${key} nonempty`);
  }
  assert.ok(h.registeredSlots.has('settings.section'));
  assert.ok(h.registeredSlots.has('conversation.input.dock'));
  assert.ok(h.registeredSlots.has('plugins.detail.section'));
  h.unmount();
});

await test('idle-non-bili-session-renders-null-and-polls-at-3000ms', async () => {
  const h = mountProgressCard({
    handler: () => ({
      active: false,
      phase: 'idle',
      elapsedMs: 0,
      bili: { detected: false, variant: null, foldBlockCount: 0, biliToolCount: 0, hasBrokenToolPairing: false, canConvert: false, needsBackup: false, hasOpenTurn: false, reasons: [] },
      backup: { count: 0, latestBackupId: null, backupPath: null, createdAt: null, pendingRestore: null },
    }),
  });
  h.render({ sessionId: 'sess-normal' });
  const tree = await h.settle();
  assert.equal(tree, null, 'Idle non-bili session must render null');
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0], { method: 'status', params: { sessionId: 'sess-normal' } });
  assert.equal(h.scheduledDelays.at(-1), 3000);
  h.unmount();
});

await test('idle-legacy-status-without-bili-renders-null', async () => {
  const h = mountProgressCard({
    handler: () => ({ active: false, startedAt: null, elapsedMs: 0, turn: null }),
  });
  h.render({ sessionId: 'sess-legacy' });
  const tree = await h.settle();
  assert.equal(tree, null);
  h.unmount();
});

for (const language of ['zh', 'en']) {
  await test(`${language}-active-compaction-renders-telemetry-and-strictly-omits-bili-button`, async () => {
    const h = mountProgressCard({
      language,
      handler: () => ({
        active: true,
        runId: 'run-1',
        seq: 14,
        sessionId: 'sess-active',
        trigger: 'manual',
        phase: 'summarizing',
        turn: 12,
        startedAt: 1763740000000,
        updatedAt: 1763740125000,
        finishedAt: null,
        elapsedMs: 125000,
        waveIndex: 1,
        waveTotal: 2,
        chunkIndex: 2,
        chunkTotal: 6,
        pageIndex: null,
        pageTotal: null,
        attempt: 2,
        maxAttempts: 3,
        beforeTokens: 482000,
        currentTokens: 214000,
        targetTokens: 158000,
        maskedCount: 18,
        maskedTokensSaved: 268000,
        summaryModel: 'deepseek/deepseek-v4.1-flash',
        stream: { chunks: 145, textChars: 1820, reasoningChars: 420, firstChunkMs: 950, idleMs: 120 },
        messageKey: 'phase_summarizing',
        messageParams: { chunkIndex: 2, chunkTotal: 6, attempt: 2, maxAttempts: 3 },
        message: 'Generating summary',
        error: null,
        bili: { detected: false, variant: null, foldBlockCount: 0, biliToolCount: 0, hasBrokenToolPairing: false, canConvert: false, needsBackup: false, hasOpenTurn: false, reasons: [] },
        backup: { count: 0, latestBackupId: null, backupPath: null, createdAt: null, pendingRestore: null },
      }),
    });
    h.render({ sessionId: 'sess-active' });
    const tree = await h.settle();
    assert.ok(tree, 'Active compaction must render progress card');
    assert.equal(tree.props['data-compaction-progress'], 'summarizing');
    const bar = find(tree, n => n.props?.role === 'progressbar');
    assert.ok(bar);
    assert.equal(bar.props['data-progress-mode'], 'determinate');
    assert.ok(bar.props['aria-valuenow'] >= 4 && bar.props['aria-valuenow'] <= 98);
    assert.equal(h.scheduledDelays.at(-1), 500, 'Active polling must run at 500ms');

    const text = textOf(tree);
    assert.match(text, /2:05/);
    assert.match(text, /deepseek\/deepseek-v4\.1-flash/);
    assert.match(text, /482k → 214k tok/);
    assert.match(text, /158k/);
    assert.match(text, /2240/);
    if (language === 'zh') {
      assert.match(text, /正在生成摘要/);
      assert.match(text, /波次 1\/2/);
      assert.match(text, /第 2\/6 块/);
      assert.match(text, /第 2\/3 次尝试/);
      assert.match(text, /已掩码 18 条（-268k tok）/);
    } else {
      assert.match(text, /Generating summary/);
      assert.match(text, /Wave 1\/2/);
      assert.match(text, /Chunk 2\/6/);
      assert.match(text, /Attempt 2\/3/);
      assert.match(text, /masked 18 \(-268k tok\)/);
    }

    // STRICT REQUIREMENT: bili convert button & row MUST be completely absent when detected === false.
    assert.equal(h.byAction(tree, 'bili-convert'), null);
    assert.equal(find(tree, n => n.props?.['data-bili-compat'] !== undefined), null);
    assert.equal(findAll(tree, n => n.type === 'button').length, 0);
    h.unmount();
  });
}

await test('indeterminate-planning-and-paged-continuation-and-session-owner-fallback', async () => {
  let payload = {
    active: true,
    phase: 'planning',
    elapsedMs: 1200,
    stream: { chunks: 0, textChars: 0, reasoningChars: 0 },
    bili: { detected: false },
  };
  const h = mountProgressCard({ language: 'zh', handler: () => payload });
  // Pass session via InputZone owner shape `{ session: { id } }` instead of `sessionId`.
  h.render({ session: { id: 'sess-owner' } });
  let tree = await h.settle();
  assert.deepEqual(h.requests[0], { method: 'status', params: { sessionId: 'sess-owner' } });
  const bar1 = find(tree, n => n.props?.role === 'progressbar');
  assert.equal(bar1.props['data-progress-mode'], 'indeterminate');
  assert.match(textOf(tree), /正在规划压缩范围/);
  assert.match(textOf(tree), /等待模型响应/);

  payload = {
    active: true,
    phase: 'continuing',
    elapsedMs: 64000,
    pageIndex: 4,
    pageTotal: 12,
    bili: { detected: false },
  };
  tree = await h.fireNextTimer();
  const bar2 = find(tree, n => n.props?.role === 'progressbar');
  assert.equal(bar2.props['data-progress-mode'], 'determinate');
  assert.match(textOf(tree), /正在分页接续压缩/);
  assert.match(textOf(tree), /第 4\/12 页/);
  assert.match(textOf(tree), /1:04/);
  assert.equal(h.byAction(tree, 'bili-convert'), null);
  h.unmount();
});

await test('visibility-hidden-pauses-polling-and-visible-resumes-immediately', async () => {
  const h = mountProgressCard({ handler: () => ({ active: false, phase: 'idle', bili: { detected: false } }) });
  h.render({ sessionId: 'sess-vis' });
  await h.settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.timers.size, 1);

  h.setVisibility('hidden');
  assert.equal(h.timers.size, 0, 'Hidden tab must cancel pending poll timer');
  assert.equal(h.requests.length, 1);

  h.setVisibility('visible');
  await h.settle();
  assert.equal(h.requests.length, 2, 'Becoming visible must trigger immediate refresh');
  assert.equal(h.timers.size, 1);
  h.unmount();
});

for (const language of ['zh', 'en']) {
  await test(`${language}-bili-detected-shows-convert-button-2step-confirm-backup-receipt-and-disappears-after`, async () => {
    const backupId = 'bkp-20261122T010000Z-a1b2c3d4';
    const backupPath = `/home/user/.dsh/storages/dsh-compaction-weave/backups/s-abc/${backupId}`;
    let migrated = false;
    const h = mountProgressCard({
      language,
      handler: payload => {
        if (payload.method === 'status') {
          if (!migrated) {
            return {
              active: false,
              phase: 'idle',
              elapsedMs: 0,
              bili: {
                detected: true,
                variant: 'ranxianglei-authored-checkpoint',
                foldBlockCount: 3,
                biliToolCount: 12,
                hasBrokenToolPairing: true,
                canConvert: true,
                needsBackup: true,
                hasOpenTurn: false,
                reasons: ['bili_snapshot_tag'],
              },
              backup: { count: 0, latestBackupId: null, backupPath: null, createdAt: null, pendingRestore: null },
            };
          }
          return {
            active: false,
            runId: 'run-mig-1',
            seq: 22,
            phase: 'done',
            trigger: 'migration',
            finishedAt: 1763740200000,
            elapsedMs: 4200,
            beforeTokens: 482000,
            currentTokens: 28000,
            bili: {
              detected: false,
              variant: null,
              foldBlockCount: 0,
              biliToolCount: 0,
              hasBrokenToolPairing: false,
              canConvert: false,
              needsBackup: false,
              hasOpenTurn: false,
              reasons: [],
            },
            backup: { count: 1, latestBackupId: backupId, backupPath, createdAt: '2026-11-22T01:00:00.000Z', pendingRestore: null },
          };
        }
        if (payload.method === 'bili-migrate') {
          assert.deepEqual(payload.params, { sessionId: 'sess-bili', confirmIrreversible: true });
          migrated = true;
          return {
            accepted: true,
            completed: true,
            runId: 'run-mig-1',
            backupId,
            backupPath,
            beforeTokens: 482000,
            afterTokens: 28000,
            compactionIds: ['weave-migrate-1'],
          };
        }
        throw new Error(`Unexpected method: ${payload.method}`);
      },
    });

    h.render({ sessionId: 'sess-bili' });
    let tree = await h.settle();
    assert.ok(find(tree, n => n.props?.['data-bili-compat'] === 'detected'));
    const convertBtn = h.byAction(tree, 'bili-convert');
    assert.ok(convertBtn);
    assert.equal(convertBtn.props.disabled, false);
    assert.equal(find(tree, n => n.props?.['data-confirm'] === 'bili-convert'), null);

    // Step 1: click Convert -> opens inline irreversible confirmation without calling RPC yet
    convertBtn.props.onClick();
    tree = h.render();
    const confirmBox = find(tree, n => n.props?.['data-confirm'] === 'bili-convert');
    assert.ok(confirmBox);
    assert.equal(h.requests.some(r => r.method === 'bili-migrate'), false);
    assert.match(textOf(confirmBox), /SHA-256/);

    // Cancel closes confirm cleanly without RPC
    h.byAction(tree, 'bili-convert-cancel').props.onClick();
    tree = h.render();
    assert.equal(find(tree, n => n.props?.['data-confirm'] === 'bili-convert'), null);
    assert.equal(h.requests.some(r => r.method === 'bili-migrate'), false);

    // Step 2: re-open and confirm -> sends bili-migrate with confirmIrreversible: true
    h.byAction(tree, 'bili-convert').props.onClick();
    tree = h.render();
    h.byAction(tree, 'bili-convert-confirm').props.onClick();
    tree = await h.settle();

    assert.equal(h.requests.filter(r => r.method === 'bili-migrate').length, 1);
    // After migration, bili.detected === false -> convert button MUST disappear completely
    assert.equal(h.byAction(tree, 'bili-convert'), null);
    assert.equal(find(tree, n => n.props?.['data-bili-compat'] !== undefined), null);
    // Backup receipt + selectable path + restore button MUST be shown
    const receipt = find(tree, n => n.props?.['data-backup-receipt'] === backupId);
    assert.ok(receipt);
    assert.match(textOf(receipt), new RegExp(backupId));
    const codeNode = find(receipt, n => n.props?.['data-backup-path'] === 'true');
    assert.ok(codeNode && textOf(codeNode) === backupPath);
    assert.ok(h.byAction(receipt, 'backup-restore'));
    h.unmount();
  });
}

await test('bili-convert-disabled-during-open-turn-or-active-compaction', async () => {
  let state = { active: false, hasOpenTurn: true };
  const h = mountProgressCard({
    language: 'zh',
    handler: () => ({
      active: state.active,
      phase: state.active ? 'summarizing' : 'idle',
      elapsedMs: state.active ? 5000 : 0,
      bili: { detected: true, variant: 'ranxianglei-proxy-raw', foldBlockCount: 0, biliToolCount: 8, hasBrokenToolPairing: false, canConvert: true, needsBackup: true, hasOpenTurn: state.hasOpenTurn, reasons: [] },
    }),
  });
  h.render({ sessionId: 'sess-busy' });
  let tree = await h.settle();
  assert.equal(h.byAction(tree, 'bili-convert').props.disabled, true);
  assert.match(textOf(tree), /当前回合结束后/);

  state = { active: true, hasOpenTurn: false };
  tree = await h.fireNextTimer();
  assert.equal(h.byAction(tree, 'bili-convert').props.disabled, true);
  assert.match(textOf(tree), /当前压缩结束后/);
  h.unmount();
});

await test('backup-restore-2step-confirm-armed-requiresReopen-and-cold-restored', async () => {
  const backupId = 'bkp-20261122T010500Z-deadbeef';
  const backupPath = `/home/user/.dsh/storages/dsh-compaction-weave/backups/s-abc/${backupId}`;
  let armed = false;
  let restoreMode = 'armed';
  const h = mountProgressCard({
    language: 'zh',
    handler: payload => {
      if (payload.method === 'status') {
        return {
          active: false,
          runId: 'run-m',
          seq: armed ? 30 : 20,
          phase: armed ? 'idle' : 'done',
          trigger: 'migration',
          finishedAt: 1763740300000,
          bili: { detected: false },
          backup: {
            count: 1,
            latestBackupId: backupId,
            backupPath,
            pendingRestore: armed ? { backupId, backupPath } : null,
          },
        };
      }
      if (payload.method === 'backup-restore') {
        assert.deepEqual(payload.params, { sessionId: 'sess-restore', backupId, confirmRestore: true });
        if (restoreMode === 'armed') {
          armed = true;
          return { status: 'armed', requiresReopen: true, backupId, backupPath, targetPath: '/home/user/.dsh/sessions/s.v4.jsonl.zstd' };
        }
        return { status: 'restored', requiresReopen: false, backupId, backupPath, targetPath: '/home/user/.dsh/sessions/s.v4.jsonl.zstd' };
      }
      throw new Error(`Unexpected method: ${payload.method}`);
    },
  });

  h.render({ sessionId: 'sess-restore' });
  let tree = await h.settle();
  const restoreBtn = h.byAction(tree, 'backup-restore');
  assert.ok(restoreBtn);
  restoreBtn.props.onClick();
  tree = h.render();
  assert.ok(find(tree, n => n.props?.['data-confirm'] === 'backup-restore'));
  assert.equal(h.requests.some(r => r.method === 'backup-restore'), false);

  h.byAction(tree, 'backup-restore-confirm').props.onClick();
  tree = await h.settle();
  assert.equal(h.requests.filter(r => r.method === 'backup-restore').length, 1);
  const pendingBanner = find(tree, n => n.props?.['data-backup-pending-restore'] === backupId);
  assert.ok(pendingBanner);
  assert.match(textOf(pendingBanner), /请完全重启 DSH 以加载还原后的历史/);
  h.unmount();

  // Cold restored path (requiresReopen: false)
  armed = false;
  restoreMode = 'restored';
  const h2 = mountProgressCard({
    language: 'en',
    handler: payload => {
      if (payload.method === 'status') {
        return {
          active: false,
          runId: 'run-m2',
          seq: 20,
          phase: 'done',
          trigger: 'migration',
          finishedAt: 1763740300000,
          bili: { detected: false },
          backup: { count: 1, latestBackupId: backupId, backupPath, pendingRestore: null },
        };
      }
      if (payload.method === 'backup-restore') {
        return { status: 'restored', requiresReopen: false, backupId, backupPath };
      }
      throw new Error(`Unexpected method: ${payload.method}`);
    },
  });
  h2.render({ sessionId: 'sess-restore' });
  let tree2 = await h2.settle();
  h2.byAction(tree2, 'backup-restore').props.onClick();
  tree2 = h2.render();
  h2.byAction(tree2, 'backup-restore-confirm').props.onClick();
  tree2 = await h2.settle();
  const restoredBanner = find(tree2, n => n.props?.['data-backup-restored'] === backupId);
  assert.ok(restoredBanner);
  assert.match(textOf(restoredBanner), /restored/);
  h2.unmount();
});

await test('error-state-shows-error-with-dismiss-and-keeps-bili-convert-when-detected', async () => {
  const h = mountProgressCard({
    language: 'zh',
    handler: () => ({
      active: false,
      runId: 'run-err',
      seq: 9,
      phase: 'error',
      finishedAt: 1763740500000,
      error: { code: 'CHECKPOINT_PRESERVED_UNREADABLE', message: '无法读取外部折叠检查点' },
      bili: { detected: true, variant: 'billion-context-dsh', foldBlockCount: 2, biliToolCount: 0, hasBrokenToolPairing: false, canConvert: true, needsBackup: true, hasOpenTurn: false, reasons: [] },
      backup: { count: 0, latestBackupId: null, backupPath: null, pendingRestore: null },
    }),
  });
  h.render({ sessionId: 'sess-err' });
  let tree = await h.settle();
  assert.ok(find(tree, n => n.props?.['data-compaction-section'] === 'error'));
  assert.match(textOf(tree), /无法读取外部折叠检查点/);
  assert.ok(h.byAction(tree, 'bili-convert'));

  h.byAction(tree, 'dismiss-terminal').props.onClick();
  tree = h.render();
  assert.equal(find(tree, n => n.props?.['data-compaction-section'] === 'error'), null);
  assert.ok(h.byAction(tree, 'bili-convert'), 'Dismissing error keeps bili convert button while detected');
  h.unmount();
});

await test('summary-config-auditBlockOnLoss-validation-omission-and-persistence', async () => {
  // Guardrail: validateSummaryConfig MUST omit auditBlockOnLoss when undefined (test/retry-settings.mjs:11).
  const omitted = validateSummaryConfig({ provider: 'p', model: 'm', maxTokens: 4096 });
  assert.equal(omitted.ok, true);
  assert.equal(Object.hasOwn(omitted.value, 'auditBlockOnLoss'), false);
  assert.deepEqual(omitted.value, { provider: 'p', model: 'm', maxTokens: 4096, thresholdRatio: null });

  // Invalid non-boolean values rejected
  for (const bad of ['true', 'false', 0, 1, null, {}, []]) {
    const verdict = validateSummaryConfig({ auditBlockOnLoss: bad });
    assert.equal(verdict.ok, false, String(bad));
    assert.equal(verdict.code, 'INVALID_AUDIT_BLOCK_ON_LOSS');
  }

  const root = await mkdtemp(join(tmpdir(), 'weave-audit-setting-'));
  const file = join(root, 'summary-config.json');

  // Persist false without model override
  const savedFalse = await handleSummaryConfigRpc({ method: 'set', params: { auditBlockOnLoss: false } }, file);
  assert.equal(savedFalse.cleared, false);
  assert.equal(savedFalse.config.auditBlockOnLoss, false);
  assert.equal(readSummaryConfig(file, { strict: true }).auditBlockOnLoss, false);
  assert.equal(resolveConfig(mergeSummaryConfig({ auditBlockOnLoss: true }, readSummaryConfig(file))).config.auditBlockOnLoss, false);

  // Model-only save/clear preserves independent auditBlockOnLoss setting
  await handleSummaryConfigRpc({ method: 'set', params: { provider: 'p', model: 'm' } }, file);
  assert.equal(readSummaryConfig(file).auditBlockOnLoss, false);
  const clearedModel = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '' } }, file);
  assert.equal(clearedModel.cleared, false);
  assert.equal(readSummaryConfig(file).auditBlockOnLoss, false);

  // Explicit true overrides inherited false
  await handleSummaryConfigRpc({ method: 'set', params: { auditBlockOnLoss: true } }, file);
  assert.equal(resolveConfig(mergeSummaryConfig({ auditBlockOnLoss: false }, readSummaryConfig(file))).config.auditBlockOnLoss, true);

  // Direct write rejects invalid value
  assert.throws(() => writeSummaryConfig(file, { auditBlockOnLoss: 'bad' }), { code: 'INVALID_AUDIT_BLOCK_ON_LOSS' });
});

await test('async-rolling-wave-bili-migrate-tracks-live-progress-and-unlocks-restore-on-done', async () => {
  const backupId = 'bkp-20261122T011500Z-11223344';
  const backupPath = `/home/user/.dsh/storages/dsh-compaction-weave/backups/s-wave/${backupId}`;
  let stage = 'idle';
  const h = mountProgressCard({
    language: 'zh',
    handler: payload => {
      if (payload.method === 'bili-migrate') {
        stage = 'running';
        return { accepted: true, completed: false, runId: 'run-wave', backupId, backupPath, beforeTokens: 600000 };
      }
      if (stage === 'idle') {
        return {
          active: false,
          phase: 'idle',
          bili: { detected: true, variant: 'ranxianglei-proxy-raw', foldBlockCount: 0, biliToolCount: 15, hasBrokenToolPairing: false, canConvert: true, needsBackup: true, hasOpenTurn: false, reasons: [] },
        };
      }
      if (stage === 'running') {
        return {
          active: true,
          runId: 'run-wave',
          seq: 5,
          phase: 'migrating',
          trigger: 'migration',
          elapsedMs: 14500,
          waveIndex: 1,
          waveTotal: 3,
          chunkIndex: 2,
          chunkTotal: 4,
          beforeTokens: 600000,
          currentTokens: 290000,
          targetTokens: 150000,
          bili: { detected: true, variant: 'ranxianglei-proxy-raw', foldBlockCount: 0, biliToolCount: 15, hasBrokenToolPairing: false, canConvert: true, needsBackup: true, hasOpenTurn: false, reasons: [] },
          backup: { count: 1, latestBackupId: backupId, backupPath, pendingRestore: null },
        };
      }
      return {
        active: false,
        runId: 'run-wave',
        seq: 12,
        phase: 'done',
        trigger: 'migration',
        finishedAt: 1763740800000,
        elapsedMs: 42000,
        beforeTokens: 600000,
        currentTokens: 42000,
        bili: { detected: false },
        backup: { count: 1, latestBackupId: backupId, backupPath, pendingRestore: null },
      };
    },
  });

  h.render({ sessionId: 'sess-wave' });
  let tree = await h.settle();
  h.byAction(tree, 'bili-convert').props.onClick();
  tree = h.render();
  h.byAction(tree, 'bili-convert-confirm').props.onClick();
  tree = await h.settle();

  assert.equal(tree.props['data-compaction-progress'], 'migrating');
  assert.equal(h.scheduledDelays.at(-1), 500);
  assert.match(textOf(tree), /波次 1\/3/);
  assert.match(textOf(tree), /第 2\/4 块/);
  assert.equal(h.byAction(tree, 'backup-restore').props.disabled, true, 'Restore disabled while active');

  stage = 'done';
  tree = await h.fireNextTimer();
  assert.equal(h.byAction(tree, 'bili-convert'), null, 'Convert button gone after async migration finishes');
  assert.equal(h.byAction(tree, 'backup-restore').props.disabled, false, 'Restore unlocked once done');
  assert.equal(h.scheduledDelays.at(-1), 3000);
  h.unmount();
});

await test('session-switch-resets-bili-confirm-and-backup-state', async () => {
  const h = mountProgressCard({
    language: 'zh',
    handler: payload => {
      if (payload.params.sessionId === 's-bili') {
        return {
          active: false,
          phase: 'idle',
          bili: { detected: true, variant: 'ranxianglei-authored-checkpoint', foldBlockCount: 2, biliToolCount: 0, hasBrokenToolPairing: false, canConvert: true, needsBackup: true, hasOpenTurn: false, reasons: [] },
        };
      }
      return {
        active: false,
        phase: 'idle',
        bili: { detected: false },
      };
    },
  });
  h.render({ sessionId: 's-bili' });
  let tree = await h.settle();
  h.byAction(tree, 'bili-convert').props.onClick();
  tree = h.render();
  assert.ok(find(tree, n => n.props?.['data-confirm'] === 'bili-convert'));

  // Switch active session to non-bili session -> card resets and becomes null
  h.render({ sessionId: 's-normal' });
  tree = await h.settle();
  assert.equal(tree, null);
  h.unmount();
});

await test('bili-migrate-rpc-error-displays-error-and-preserves-convert-button', async () => {
  const h = mountProgressCard({
    language: 'en',
    handler: payload => {
      if (payload.method === 'bili-migrate') {
        return { __error: { code: 'BACKUP_VERIFICATION_FAILED', message: 'Checksum mismatch' } };
      }
      return {
        active: false,
        phase: 'idle',
        bili: { detected: true, variant: 'ranxianglei-authored-checkpoint', foldBlockCount: 1, biliToolCount: 0, hasBrokenToolPairing: false, canConvert: true, needsBackup: true, hasOpenTurn: false, reasons: [] },
      };
    },
  });
  h.render({ sessionId: 's-fail' });
  let tree = await h.settle();
  h.byAction(tree, 'bili-convert').props.onClick();
  tree = h.render();
  h.byAction(tree, 'bili-convert-confirm').props.onClick();
  tree = await h.settle();
  assert.match(textOf(tree), /Checksum mismatch/);
  assert.ok(h.byAction(tree, 'bili-convert'));
  h.unmount();
});

await test('dsh-real-css-tokens-compact-card-and-zero-dead-alias-tokens', async () => {
  // Guardrail: never use non-existent or white-on-white DSH CSS tokens.
  assert.doesNotMatch(
    clientSource,
    /--dsw-alias-(?:brand-primary|text-[a-z-]+|bg-elevated|bg-base|border-secondary|border-subtle)/,
    'lib/client.js must only reference real DSH CSS tokens',
  );
  assert.match(clientSource, /--dsw-alias-button-info-fill/);
  assert.match(clientSource, /--dsw-alias-label-primary-foreground/);

  const backupId = 'bkp-20261122T010000Z-aaaa1111';
  const backupPath = `/home/user/.dsh/storages/dsh-compaction-weave/backups/s-tok/${backupId}/session.v4.jsonl.zstd`;
  const h = mountProgressCard({
    language: 'zh',
    handler: () => ({
      active: false,
      phase: 'idle',
      bili: { detected: true, variant: 'ranxianglei-proxy-raw', foldBlockCount: 0, biliToolCount: 4, hasBrokenToolPairing: false, canConvert: true, needsBackup: true, hasOpenTurn: false, reasons: [] },
      backup: {
        count: 1,
        originalBackupId: backupId,
        latestBackupId: backupId,
        backupPath,
        createdAt: '2026-11-22T01:00:00.000Z',
        pendingRestore: null,
        items: [{ backupId, createdAt: '2026-11-22T01:00:00.000Z', bytes: 2048, eventCount: 40, surfaceNodeCount: 36, reason: 'bili-migration', isBaseline: true, backupPath }],
      },
    }),
  });
  h.render({ sessionId: 'sess-tokens' });
  let tree = await h.settle();

  // Compact card metrics & composer width alignment
  assert.equal(tree.props.style.width, 'calc(100% - 2 * var(--dsh-composer-side-clearance, 16px))');
  assert.equal(tree.props.style.maxWidth, 'var(--dsh-composer-card-max-width, 760px)');
  assert.equal(tree.props.style.margin, '0 auto');
  assert.equal(tree.props.style.alignSelf, 'center');
  assert.equal(tree.props.style.boxSizing, 'border-box');
  assert.equal(tree.props.style.padding, '6px 10px');
  assert.equal(tree.props.style.gap, 5);
  assert.equal(tree.props.style.fontSize, 12);

  // Single backup omits select and uses truncated code path with full path title tooltip
  assert.equal(find(tree, n => n.props?.['data-backup-select'] === 'true'), null);
  const codeNode = find(tree, n => n.props?.['data-backup-path'] === 'true');
  assert.ok(codeNode);
  assert.equal(codeNode.props.title, backupPath);
  assert.equal(codeNode.props.style.textOverflow, 'ellipsis');

  // Primary convert button + confirm button use real DSH button-info-fill + label-primary-foreground
  const convertBtn = h.byAction(tree, 'bili-convert');
  assert.equal(convertBtn.props.style.background, 'var(--dsw-alias-button-info-fill, var(--dsw-alias-state-business-primary, #2f6fed))');
  assert.equal(convertBtn.props.style.borderColor, 'transparent');
  assert.equal(convertBtn.props.style.color, 'var(--dsw-alias-label-primary-foreground, #ffffff)');

  convertBtn.props.onClick();
  tree = h.render();
  const convertConfirmBtn = h.byAction(tree, 'bili-convert-confirm');
  assert.equal(convertConfirmBtn.props.style.background, 'var(--dsw-alias-button-info-fill, var(--dsw-alias-state-business-primary, #2f6fed))');
  assert.equal(convertConfirmBtn.props.style.borderColor, 'transparent');
  assert.equal(convertConfirmBtn.props.style.color, 'var(--dsw-alias-label-primary-foreground, #ffffff)');
  const convertCancelBtn = h.byAction(tree, 'bili-convert-cancel');
  assert.equal(convertCancelBtn.props.style.background, 'var(--dsw-alias-bg-layer-2, transparent)');
  assert.equal(convertCancelBtn.props.style.borderColor, 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))');
  assert.equal(convertCancelBtn.props.style.color, 'var(--dsw-alias-label-primary, inherit)');

  // Restore button (secondary) + confirm restore button (primary)
  const restoreBtn = h.byAction(tree, 'backup-restore');
  assert.equal(restoreBtn.props.style.background, 'var(--dsw-alias-bg-layer-2, transparent)');
  assert.equal(restoreBtn.props.style.borderColor, 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))');
  assert.equal(restoreBtn.props.style.color, 'var(--dsw-alias-label-primary, inherit)');
  restoreBtn.props.onClick();
  tree = h.render();
  const restoreConfirmBtn = h.byAction(tree, 'backup-restore-confirm');
  assert.equal(restoreConfirmBtn.props.style.background, 'var(--dsw-alias-button-info-fill, var(--dsw-alias-state-business-primary, #2f6fed))');
  assert.equal(restoreConfirmBtn.props.style.borderColor, 'transparent');
  assert.equal(restoreConfirmBtn.props.style.color, 'var(--dsw-alias-label-primary-foreground, #ffffff)');
  h.unmount();
});

for (const language of ['zh', 'en']) {
  await test(`${language}-overall-percent-drives-primary-progress-bar-and-token-telemetry-across-waves`, async () => {
    let stage = 0;
    const snapshots = [
      {
        active: true,
        runId: 'run-overall',
        seq: 1,
        phase: 'detecting',
        elapsedMs: 400,
        overallPercent: 0,
        overallProcessedTokens: 0,
        overallTotalTokens: 1180000,
        overallProcessedNodes: 0,
        overallTotalNodes: 1173,
        bili: { detected: false },
      },
      {
        active: true,
        runId: 'run-overall',
        seq: 8,
        phase: 'summarizing',
        elapsedMs: 18500,
        overallPercent: 42,
        overallProcessedTokens: 510000,
        overallTotalTokens: 1180000,
        overallProcessedNodes: 492,
        overallTotalNodes: 1173,
        waveIndex: 1,
        waveTotal: 2,
        chunkIndex: 1,
        chunkTotal: 6,
        stream: { chunks: 40, textChars: 640, reasoningChars: 0 },
        bili: { detected: false },
      },
      {
        active: true,
        runId: 'run-overall',
        seq: 16,
        phase: 'continuing',
        elapsedMs: 44000,
        overallPercent: 78,
        overallProcessedTokens: 920000,
        overallTotalTokens: 1180000,
        overallProcessedNodes: 915,
        overallTotalNodes: 1173,
        waveIndex: 2,
        waveTotal: 2,
        chunkIndex: 1,
        chunkTotal: 4,
        pageIndex: 1,
        pageTotal: 3,
        bili: { detected: false },
      },
    ];
    const h = mountProgressCard({ language, handler: () => snapshots[stage] });
    h.render({ sessionId: 'sess-overall' });

    // 0% must still be determinate (not falsy/indeterminate)
    let tree = await h.settle();
    let bar = find(tree, n => n.props?.role === 'progressbar');
    assert.equal(bar.props['data-progress-mode'], 'determinate');
    assert.equal(bar.props['aria-valuenow'], 0);
    assert.equal(bar.children[0].props.style.width, '0%');
    assert.ok(find(tree, n => n.props?.['data-overall-percent'] === '0'));

    // 42% takes precedence over chunkIndex 1/6 (which alone would be ~8%)
    stage = 1;
    tree = await h.fireNextTimer();
    bar = find(tree, n => n.props?.role === 'progressbar');
    assert.equal(bar.props['data-progress-mode'], 'determinate');
    assert.equal(bar.props['aria-valuenow'], 42);
    assert.equal(bar.children[0].props.style.width, '42%');
    const text1 = textOf(tree);
    if (language === 'zh') {
      assert.match(text1, /总进度 42%/);
      assert.match(text1, /已处理 510k \/ 1\.18M tok/);
    } else {
      assert.match(text1, /Overall 42%/);
      assert.match(text1, /Processed 510k \/ 1\.18M tok/);
    }

    // Wave 2 resets chunkIndex=1/4 and pageIndex=1/3, but progress bar monotonically stays at 78%
    stage = 2;
    tree = await h.fireNextTimer();
    bar = find(tree, n => n.props?.role === 'progressbar');
    assert.equal(bar.props['aria-valuenow'], 78);
    assert.equal(bar.children[0].props.style.width, '78%');
    assert.ok(find(tree, n => n.props?.['data-overall-percent'] === '78'));
    h.unmount();
  });

  await test(`${language}-multi-backup-defaults-to-original-baseline-and-supports-select-switching`, async () => {
    const origId = 'bkp-20261122T010000Z-1111aaaa';
    const retryId = 'bkp-20261122T011200Z-2222bbbb';
    const origPath = `/home/user/.dsh/storages/dsh-compaction-weave/backups/s-multi/${origId}/session.v4.jsonl.zstd`;
    const retryPath = `/home/user/.dsh/storages/dsh-compaction-weave/backups/s-multi/${retryId}/session.v4.jsonl.zstd`;
    const restoredIds = [];
    let retried = false;

    const h = mountProgressCard({
      language,
      handler: payload => {
        if (payload.method === 'bili-migrate') {
          retried = true;
          // Retry returns the newer backupId, but UI must still default restore to originalBackupId!
          return { accepted: true, completed: true, runId: 'run-retry', backupId: retryId, backupPath: retryPath };
        }
        if (payload.method === 'backup-restore') {
          restoredIds.push(payload.params.backupId);
          return { status: 'restored', requiresReopen: false, backupId: payload.params.backupId, backupPath: payload.params.backupId === origId ? origPath : retryPath };
        }
        return {
          active: false,
          runId: retried ? 'run-retry' : 'run-attempt1',
          seq: retried ? 40 : 20,
          phase: retried ? 'done' : 'error',
          trigger: 'migration',
          finishedAt: retried ? 1763740900000 : 1763740500000,
          error: retried ? null : { code: 'SUMMARY_NOT_SMALLER', message: 'Attempt 1 failed' },
          bili: {
            detected: !retried,
            variant: retried ? null : 'ranxianglei-proxy-raw',
            foldBlockCount: 0,
            biliToolCount: retried ? 0 : 10,
            hasBrokenToolPairing: false,
            canConvert: !retried,
            needsBackup: !retried,
            hasOpenTurn: false,
            reasons: [],
          },
          backup: {
            count: 2,
            originalBackupId: origId,
            latestBackupId: retryId,
            backupPath: origPath,
            createdAt: '2026-11-22T01:00:00.000Z',
            pendingRestore: null,
            items: [
              { backupId: retryId, createdAt: '2026-11-22T01:12:00.000Z', bytes: 5120000, eventCount: 980, surfaceNodeCount: 962, reason: 'bili-migration', isBaseline: false, backupPath: retryPath },
              { backupId: origId, createdAt: '2026-11-22T01:00:00.000Z', bytes: 7100000, eventCount: 1200, surfaceNodeCount: 1173, reason: 'bili-migration', isBaseline: true, backupPath: origPath },
            ],
          },
        };
      },
    });

    h.render({ sessionId: 'sess-multi' });
    let tree = await h.settle();

    // Even after clicking Retry migration (whose RPC receipt returns retryId), default restore target MUST stay origId!
    h.byAction(tree, 'bili-convert').props.onClick();
    tree = h.render();
    h.byAction(tree, 'bili-convert-confirm').props.onClick();
    tree = await h.settle();

    const select = find(tree, n => n.props?.['data-backup-select'] === 'true');
    assert.ok(select, 'Multi-backup selector must render when items.length > 1');
    assert.equal(select.props.value, origId, 'Default selected backup must be originalBackupId');
    assert.equal(select.children.length, 2);
    assert.equal(select.children[0].props.value, origId, 'Original baseline backup listed first');
    if (language === 'zh') {
      assert.match(textOf(select.children[0]), /原始备份 · 1173条/);
      assert.match(textOf(select.children[1]), /快照 · 962条/);
    } else {
      assert.match(textOf(select.children[0]), /Original backup · 1173 nodes/);
      assert.match(textOf(select.children[1]), /Snapshot · 962 nodes/);
    }

    // Confirming restore without changing selector restores original baseline backup
    assert.ok(find(tree, n => n.props?.['data-backup-receipt'] === origId));
    assert.equal(textOf(find(tree, n => n.props?.['data-backup-path'] === 'true')), origPath);
    h.byAction(tree, 'backup-restore').props.onClick();
    tree = h.render();
    h.byAction(tree, 'backup-restore-confirm').props.onClick();
    tree = await h.settle();
    assert.deepEqual(restoredIds, [origId]);

    // Dismiss restored banner and switch selector to newer snapshot -> restores retryId
    h.byAction(tree, 'dismiss-backup').props.onClick();
    tree = h.render();
    const select2 = find(tree, n => n.props?.['data-backup-select'] === 'true');
    assert.ok(select2);
    select2.props.onChange({ target: { value: retryId } });
    tree = h.render();
    assert.ok(find(tree, n => n.props?.['data-backup-receipt'] === retryId));
    assert.equal(textOf(find(tree, n => n.props?.['data-backup-path'] === 'true')), retryPath);
    h.byAction(tree, 'backup-restore').props.onClick();
    tree = h.render();
    h.byAction(tree, 'backup-restore-confirm').props.onClick();
    tree = await h.settle();
    assert.deepEqual(restoredIds, [origId, retryId]);
    h.unmount();
  });

  await test(`${language}-active-pause-button-cancel-rpc-error-and-concurrency-rate-limit-chips`, async () => {
    let releaseCancel;
    let failNextCancel = false;
    let rateLimited = false;
    let paused = false;

    const h = mountProgressCard({
      language,
      handler: payload => {
        if (payload.method === 'cancel-compaction') {
          assert.deepEqual(payload.params, { sessionId: 'sess-cancel' });
          if (failNextCancel) {
            return { __error: { code: 'CANCEL_BUSY', message: 'Cancel channel busy' } };
          }
          return new Promise(resolve => {
            releaseCancel = () => {
              paused = true;
              resolve({ cancelled: true, runId: 'run-c1' });
            };
          });
        }
        if (paused) {
          return {
            active: false,
            phase: 'idle',
            cancellable: false,
            bili: { detected: false },
            resumable: {
              jobId: 'job-paused-1',
              trigger: 'manual',
              status: 'paused_user',
              interruptReason: 'user_cancel',
              overallPercent: 35,
              completedChunks: 2,
              remainingNodes: 140,
              remainingTokens: 210000,
              initialTotalTokens: 320000,
              completedTokens: 110000,
              updatedAt: 1763741000000,
              canAutoResume: false,
              lastErrorCode: null,
              lastErrorMessage: null,
            },
          };
        }
        return {
          active: true,
          runId: 'run-c1',
          seq: rateLimited ? 9 : 4,
          phase: 'summarizing',
          trigger: 'manual',
          elapsedMs: 12000,
          overallPercent: 35,
          cancellable: true,
          concurrency: rateLimited ? 1 : 3,
          activeWorkers: rateLimited ? 1 : 3,
          rateLimited,
          bili: { detected: false },
        };
      },
    });

    h.render({ sessionId: 'sess-cancel' });
    let tree = await h.settle();

    // Concurrency chip shows 并发 3 / 3× and Pause button sits next to elapsed timer
    const chip1 = find(tree, n => n.props?.['data-compaction-concurrency'] === '3');
    assert.ok(chip1);
    assert.equal(textOf(chip1), language === 'zh' ? '并发 3' : '3×');

    const pauseBtn = h.byAction(tree, 'cancel-compaction');
    assert.ok(pauseBtn);
    assert.equal(pauseBtn.props.disabled, false);
    assert.equal(textOf(pauseBtn), language === 'zh' ? '暂停' : 'Pause');
    assert.equal(pauseBtn.props.style.background, 'var(--dsw-alias-bg-layer-2, transparent)');
    assert.equal(pauseBtn.props.style.borderColor, 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))');

    // Rate-limited telemetry chip flips to 限流降速 / rate-limited even when concurrency dropped to 1
    rateLimited = true;
    tree = await h.fireNextTimer();
    const chip2 = find(tree, n => n.props?.['data-compaction-concurrency'] === 'rate-limited');
    assert.ok(chip2);
    assert.equal(textOf(chip2), language === 'zh' ? '限流降速' : 'rate-limited');

    // RPC error on cancel surfaces cleanly in error row without crashing
    failNextCancel = true;
    h.byAction(tree, 'cancel-compaction').props.onClick();
    tree = await h.settle();
    assert.match(textOf(tree), /Cancel channel busy/);
    assert.equal(h.byAction(tree, 'cancel-compaction').props.disabled, false);

    // Successful cancel shows busy label while in flight, then transitions to resumable banner
    failNextCancel = false;
    h.byAction(tree, 'cancel-compaction').props.onClick();
    tree = h.render();
    const busyBtn = h.byAction(tree, 'cancel-compaction');
    assert.ok(busyBtn);
    assert.equal(busyBtn.props.disabled, true);
    assert.equal(textOf(busyBtn), language === 'zh' ? '正在暂停…' : 'Pausing…');

    releaseCancel();
    tree = await h.settle();
    assert.equal(h.byAction(tree, 'cancel-compaction'), null);
    assert.ok(find(tree, n => n.props?.['data-compaction-resumable'] === 'job-paused-1'));
    assert.equal(h.byAction(tree, 'bili-convert'), null);
    h.unmount();
  });

  await test(`${language}-resumable-banner-status-notes-resume-and-2step-discard`, async () => {
    let resumable = {
      jobId: 'job-res-1',
      trigger: 'manual',
      status: 'paused_budget',
      interruptReason: 'call_budget',
      overallPercent: 45,
      completedChunks: 3,
      remainingNodes: 180,
      remainingTokens: 240000,
      initialTotalTokens: 440000,
      completedTokens: 200000,
      updatedAt: 1763741200000,
      canAutoResume: true,
      lastErrorCode: null,
      lastErrorMessage: null,
    };
    let active = false;
    let failResume = false;

    const h = mountProgressCard({
      language,
      handler: payload => {
        if (payload.method === 'resume-compaction') {
          assert.deepEqual(payload.params, { sessionId: 'sess-res' });
          if (failResume) return { __error: { code: 'BUSY', message: 'Resume blocked' } };
          active = true;
          return { accepted: true, runId: 'run-res-2' };
        }
        if (payload.method === 'discard-resume') {
          assert.deepEqual(payload.params, { sessionId: 'sess-res', confirmDiscard: true });
          resumable = null;
          return { discarded: true };
        }
        return {
          active,
          phase: active ? 'continuing' : 'idle',
          elapsedMs: active ? 2000 : 0,
          overallPercent: active ? 50 : null,
          bili: { detected: false },
          backup: { count: 0, items: [] },
          resumable: active ? null : resumable,
        };
      },
    });

    h.render({ sessionId: 'sess-res' });
    let tree = await h.settle();
    const banner = find(tree, n => n.props?.['data-compaction-resumable'] === 'job-res-1');
    assert.ok(banner);
    assert.equal(tree.props['data-compaction-progress'], 'resumable');
    assert.equal(h.byAction(tree, 'bili-convert'), null);
    assert.equal(find(tree, n => n.props?.['data-bili-compat'] !== undefined), null);

    const text = textOf(banner);
    if (language === 'zh') {
      assert.match(text, /上次压缩未完成/);
      assert.match(text, /已完成 45% · 剩 180 条/);
      assert.match(text, /预算/);
      assert.match(text, /发消息自动继续/);
      assert.equal(textOf(h.byAction(banner, 'resume-compaction')), '继续压缩');
      assert.equal(textOf(h.byAction(banner, 'discard-resume')), '放弃');
    } else {
      assert.match(text, /Compaction paused/);
      assert.match(text, /45% done · 180 remaining/);
      assert.match(text, /budget/i);
      assert.match(text, /Auto-resumes on next message/);
      assert.equal(textOf(h.byAction(banner, 'resume-compaction')), 'Continue compaction');
      assert.equal(textOf(h.byAction(banner, 'discard-resume')), 'Discard');
    }

    // paused_failure note renders when status switches to paused_failure
    resumable = {
      ...resumable,
      status: 'paused_failure',
      canAutoResume: false,
      lastErrorCode: 'SUMMARY_TIMEOUT',
      lastErrorMessage: 'Model timed out',
    };
    tree = await h.fireNextTimer();
    const failText = textOf(find(tree, n => n.props?.['data-compaction-resumable'] === 'job-res-1'));
    if (language === 'zh') {
      assert.match(failText, /连续失败已暂停/);
      assert.doesNotMatch(failText, /发消息自动继续/);
    } else {
      assert.match(failText, /paused after failures/);
      assert.doesNotMatch(failText, /Auto-resumes on next message/);
    }

    // Resume RPC failure surfaces error and keeps banner visible
    failResume = true;
    h.byAction(tree, 'resume-compaction').props.onClick();
    tree = await h.settle();
    assert.match(textOf(tree), /Resume blocked/);
    assert.ok(find(tree, n => n.props?.['data-compaction-resumable'] === 'job-res-1'));

    // 2-step discard confirmation: step 1 opens confirm box without RPC, cancel closes without RPC
    h.byAction(tree, 'discard-resume').props.onClick();
    tree = h.render();
    const confirmBox = find(tree, n => n.props?.['data-confirm'] === 'discard-resume');
    assert.ok(confirmBox);
    assert.equal(h.requests.some(r => r.method === 'discard-resume'), false);
    assert.match(textOf(confirmBox), language === 'zh' ? /备份仍会保留/ : /backup remains intact/);

    h.byAction(tree, 'discard-resume-cancel').props.onClick();
    tree = h.render();
    assert.equal(find(tree, n => n.props?.['data-confirm'] === 'discard-resume'), null);
    assert.equal(h.requests.some(r => r.method === 'discard-resume'), false);

    // Resume succeeds and transitions to active progress
    failResume = false;
    h.byAction(tree, 'resume-compaction').props.onClick();
    tree = await h.settle();
    assert.equal(h.requests.filter(r => r.method === 'resume-compaction').length, 2);
    assert.equal(tree.props['data-compaction-progress'], 'continuing');

    // Return to paused and confirm discard -> sends confirmDiscard: true and clears card to null
    active = false;
    tree = await h.fireNextTimer();
    h.byAction(tree, 'discard-resume').props.onClick();
    tree = h.render();
    h.byAction(tree, 'discard-resume-confirm').props.onClick();
    tree = await h.settle();
    assert.equal(h.requests.filter(r => r.method === 'discard-resume').length, 1);
    assert.equal(tree, null);
    h.unmount();
  });

  await test(`${language}-migration-resume-suppresses-duplicate-bili-convert-and-keeps-restore`, async () => {
    const backupId = 'bkp-20261122T010000Z-migbase1';
    const backupPath = `/home/user/.dsh/storages/dsh-compaction-weave/backups/s-mig/${backupId}/session.v4.jsonl.zstd`;
    let resumable = {
      jobId: 'job-mig-1',
      trigger: 'migration',
      status: 'interrupted',
      interruptReason: 'crash',
      overallPercent: 60,
      completedChunks: 5,
      remainingNodes: 210,
      remainingTokens: 310000,
      initialTotalTokens: 780000,
      completedTokens: 470000,
      updatedAt: 1763741500000,
      canAutoResume: false,
      lastErrorCode: null,
      lastErrorMessage: null,
    };

    const h = mountProgressCard({
      language,
      handler: payload => {
        if (payload.method === 'discard-resume') {
          resumable = null;
          return { discarded: true };
        }
        return {
          active: false,
          phase: 'idle',
          bili: {
            detected: true,
            variant: 'ranxianglei-proxy-raw',
            foldBlockCount: 0,
            biliToolCount: 30,
            hasBrokenToolPairing: false,
            canConvert: true,
            needsBackup: true,
            hasOpenTurn: false,
            reasons: [],
          },
          backup: {
            count: 1,
            originalBackupId: backupId,
            latestBackupId: backupId,
            backupPath,
            createdAt: '2026-11-22T01:00:00.000Z',
            pendingRestore: null,
            items: [{ backupId, createdAt: '2026-11-22T01:00:00.000Z', bytes: 4096, eventCount: 400, surfaceNodeCount: 380, reason: 'bili-migration', isBaseline: true, backupPath }],
          },
          resumable,
        };
      },
    });

    h.render({ sessionId: 'sess-mig-res' });
    let tree = await h.settle();

    // Migration resume banner is shown with migration-specific labels
    const banner = find(tree, n => n.props?.['data-compaction-resumable'] === 'job-mig-1');
    assert.ok(banner);
    assert.match(textOf(banner), language === 'zh' ? /上次兼容转换未完成/ : /Migration paused/);
    assert.equal(
      textOf(h.byAction(banner, 'resume-compaction')),
      language === 'zh' ? '继续转换' : 'Continue migration',
    );

    // STRICT MUTUAL EXCLUSION: duplicate bili-convert row MUST be suppressed!
    assert.equal(h.byAction(tree, 'bili-convert'), null);
    assert.equal(find(tree, n => n.props?.['data-bili-compat'] !== undefined), null);

    // Restore Backup controls MUST remain available alongside Continue / Discard!
    assert.ok(find(tree, n => n.props?.['data-backup-receipt'] === backupId));
    assert.ok(h.byAction(tree, 'backup-restore'));

    // After discarding the paused migration checkpoint, bili-convert cleanly reappears
    h.byAction(tree, 'discard-resume').props.onClick();
    tree = h.render();
    h.byAction(tree, 'discard-resume-confirm').props.onClick();
    tree = await h.settle();
    assert.equal(find(tree, n => n.props?.['data-compaction-resumable'] !== undefined), null);
    assert.ok(h.byAction(tree, 'bili-convert'));
    h.unmount();
  });

  await test(`${language}-p2-polish-local-time-dedup-banner-restart-wording-and-copy-path`, async () => {
    const origIso = '2026-11-22T01:05:00.000Z';
    const d = new Date(origIso);
    const pad = n => String(n).padStart(2, '0');
    const expectedLocalTime = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

    const origId = 'bkp-20261122T010500Z-aaaa1111';
    const badDateId = 'bkp-20261122T011500Z-bbbb2222';
    const origPath = `/home/user/.dsh/storages/dsh-compaction-weave/backups/s-p2/${origId}/session.v4.jsonl.zstd`;
    const badDatePath = `/home/user/.dsh/storages/dsh-compaction-weave/backups/s-p2/${badDateId}/session.v4.jsonl.zstd`;
    const copied = [];
    let migrated = false;
    let armed = false;

    const h = mountProgressCard({
      language,
      clipboard: {
        writeText: async value => {
          copied.push(value);
        },
      },
      handler: payload => {
        if (payload.method === 'bili-migrate') {
          migrated = true;
          return { accepted: true, completed: true, runId: 'run-p2', backupId: origId, backupPath: origPath };
        }
        if (payload.method === 'backup-restore') {
          armed = true;
          return { status: 'armed', requiresReopen: true, backupId: origId, backupPath: origPath };
        }
        return {
          active: false,
          runId: migrated ? 'run-p2' : null,
          seq: migrated ? 10 : 1,
          phase: migrated && !armed ? 'done' : 'idle',
          trigger: migrated ? 'migration' : null,
          finishedAt: migrated ? 1763742000000 : null,
          bili: { detected: !migrated, variant: !migrated ? 'ranxianglei-proxy-raw' : null, foldBlockCount: 0, biliToolCount: !migrated ? 4 : 0, hasBrokenToolPairing: false, canConvert: !migrated, needsBackup: !migrated, hasOpenTurn: false, reasons: [] },
          backup: {
            count: 2,
            originalBackupId: origId,
            latestBackupId: badDateId,
            backupPath: origPath,
            createdAt: origIso,
            pendingRestore: armed ? { backupId: origId, backupPath: origPath } : null,
            items: [
              { backupId: origId, createdAt: origIso, bytes: 3000, eventCount: 50, surfaceNodeCount: 48, reason: 'bili-migration', isBaseline: true, backupPath: origPath },
              { backupId: badDateId, createdAt: 'not-a-date', bytes: 2000, eventCount: 30, surfaceNodeCount: 28, reason: 'bili-migration', isBaseline: false, backupPath: badDatePath },
            ],
          },
        };
      },
    });

    h.render({ sessionId: 'sess-p2' });
    let tree = await h.settle();

    // Local timezone MM-DD HH:MM formatting and invalid-date fallback
    const select = find(tree, n => n.props?.['data-backup-select'] === 'true');
    assert.ok(select);
    assert.ok(textOf(select.children[0]).includes(expectedLocalTime), `Expected local time ${expectedLocalTime} in "${textOf(select.children[0])}"`);
    assert.ok(textOf(select.children[1]).includes('bbbb2222'), 'Invalid date must fall back to backupId suffix');

    // Run migration -> done banner must appear ONCE (not duplicated inside backup-receipt)
    h.byAction(tree, 'bili-convert').props.onClick();
    tree = h.render();
    h.byAction(tree, 'bili-convert-confirm').props.onClick();
    tree = await h.settle();

    const doneText = h.dictionaries[language].biliConvertDone;
    const receipt = find(tree, n => n.props?.['data-backup-receipt'] === origId);
    assert.ok(receipt);
    assert.equal(textOf(tree).split(doneText).length - 1, 1, 'Migration completion banner must appear exactly once');
    assert.equal(textOf(receipt).includes(doneText), false, 'Duplicate receiptLead must not render inside backup row');

    // Dismissing terminal banner must NOT cause receiptLead to reappear inside backup row
    h.byAction(tree, 'dismiss-terminal').props.onClick();
    tree = h.render();
    const receiptAfterDismiss = find(tree, n => n.props?.['data-backup-receipt'] === origId);
    assert.ok(receiptAfterDismiss);
    assert.equal(textOf(receiptAfterDismiss).includes(doneText), false);

    // Copy-path button copies exact path, toggles to Copied / 已复制, then resets after timer
    const copyBtn = h.byAction(receiptAfterDismiss, 'copy-backup-path');
    assert.ok(copyBtn);
    assert.equal(textOf(copyBtn), language === 'zh' ? '复制' : 'Copy');
    copyBtn.props.onClick();
    tree = await h.settle();
    assert.deepEqual(copied, [origPath]);
    assert.equal(textOf(h.byAction(tree, 'copy-backup-path')), language === 'zh' ? '已复制' : 'Copied');

    tree = await h.fireTimerWithDelay(1800);
    assert.equal(textOf(h.byAction(tree, 'copy-backup-path')), language === 'zh' ? '复制' : 'Copy');

    // Online armed restore clearly instructs full DSH restart and keeps copy-path button
    h.byAction(tree, 'backup-restore').props.onClick();
    tree = h.render();
    h.byAction(tree, 'backup-restore-confirm').props.onClick();
    tree = await h.settle();
    const armedBanner = find(tree, n => n.props?.['data-backup-pending-restore'] === origId);
    assert.ok(armedBanner);
    assert.match(
      textOf(armedBanner),
      language === 'zh' ? /请完全重启 DSH 以加载还原后的历史/ : /Fully restart DSH to load the restored history/,
    );
    assert.ok(h.byAction(armedBanner, 'copy-backup-path'));
    h.unmount();

    // Missing / throwing clipboard fails safely without crashing or flipping label
    const hFailClip = mountProgressCard({
      language,
      clipboard: { writeText: async () => { throw new Error('clipboard denied'); } },
      handler: () => ({
        active: false,
        phase: 'done',
        trigger: 'migration',
        finishedAt: 1763742100000,
        bili: { detected: false },
        backup: { count: 1, originalBackupId: origId, latestBackupId: origId, backupPath: origPath, items: [] },
      }),
    });
    hFailClip.render({ sessionId: 'sess-clip-err' });
    let failTree = await hFailClip.settle();
    hFailClip.byAction(failTree, 'copy-backup-path').props.onClick();
    failTree = await hFailClip.settle();
    assert.equal(textOf(hFailClip.byAction(failTree, 'copy-backup-path')), language === 'zh' ? '复制' : 'Copy');
    hFailClip.unmount();
  });

  await test(`${language}-settings-concurrency-reasoning-effort-and-per-field-validation`, async () => {
    const h = await mountSettingsSection({ language });

    // Defaults render cleanly in compact 2-column grid
    assert.equal(h.field('weave-summary-concurrency').props.value, '2');
    assert.equal(h.field('weave-summary-concurrency').props.min, 1);
    assert.equal(h.field('weave-summary-concurrency').props.max, 6);
    const reasoningField = h.field('weave-summary-reasoning-effort');
    assert.equal(reasoningField.props.value, 'auto');
    assert.deepEqual(reasoningField.children.map(o => o.props.value), ['auto', 'low', 'none', 'minimal', 'medium', 'high', 'xhigh', 'max', 'inherit']);

    const fullText = textOf(h.render());
    assert.match(fullText, /429/);
    assert.match(fullText, language === 'zh' ? /摘要并发数/ : /Summary concurrency/);
    assert.match(fullText, language === 'zh' ? /摘要推理强度/ : /Summary reasoning effort/);

    // Per-field validation produces 4 distinct messages and blocks set RPC
    const seenErrors = new Set();
    const checkInvalid = async (fieldId, badValue, restoreValue) => {
      const beforeSets = h.requests.filter(r => r.method === 'set').length;
      h.change(fieldId, badValue);
      await h.click('save');
      assert.equal(h.requests.filter(r => r.method === 'set').length, beforeSets, `${fieldId}=${badValue} must block save`);
      const err = h.statusText();
      assert.ok(err.length > 0, `Expected validation error for ${fieldId}=${badValue}`);
      seenErrors.add(err);
      h.change(fieldId, restoreValue);
    };

    await checkInvalid('weave-summary-retry-count', '5', '2');
    await checkInvalid('weave-summary-retry-delay', '31', '1');
    await checkInvalid('weave-summary-timeout', '4', '180');
    await checkInvalid('weave-summary-concurrency', '0', '2');
    assert.equal(seenErrors.size, 4, 'retryCount, retryDelay, summaryTimeout, and summaryConcurrency must have distinct validation messages');

    // Additional concurrency invalid bounds (7, 1.5, empty)
    for (const bad of ['7', '1.5', '']) {
      const beforeSets = h.requests.filter(r => r.method === 'set').length;
      h.change('weave-summary-concurrency', bad);
      await h.click('save');
      assert.equal(h.requests.filter(r => r.method === 'set').length, beforeSets);
    }

    // Valid save sends summaryConcurrency + summaryReasoningEffort
    h.change('weave-summary-provider', 'p');
    h.change('weave-summary-model', 'm');
    h.change('weave-summary-concurrency', '4');
    h.change('weave-summary-reasoning-effort', 'none');
    await h.click('save');
    const setParams = h.requests.filter(r => r.method === 'set').at(-1).params;
    assert.equal(setParams.summaryConcurrency, 4);
    assert.equal(setParams.summaryReasoningEffort, 'none');
    assert.equal(setParams.provider, 'p');
    assert.equal(setParams.model, 'm');

    // Clear resets only provider/model/maxTokens and preserves concurrency + reasoning effort
    await h.click('clear');
    const clearParams = h.requests.filter(r => r.method === 'set').at(-1).params;
    assert.equal(clearParams.provider, '');
    assert.equal(clearParams.model, '');
    assert.equal(clearParams.maxTokens, null);
    assert.equal(clearParams.summaryConcurrency, 4);
    assert.equal(clearParams.summaryReasoningEffort, 'none');

    // Reload from saved config populates and preserves both without re-editing
    const hReload = await mountSettingsSection({
      language,
      initialConfig: { provider: 'p', model: 'm', summaryConcurrency: 5, summaryReasoningEffort: 'inherit' },
    });
    assert.equal(hReload.field('weave-summary-concurrency').props.value, '5');
    assert.equal(hReload.field('weave-summary-reasoning-effort').props.value, 'inherit');
    await hReload.click('clear');
    const reloadClearParams = hReload.requests.filter(r => r.method === 'set').at(-1).params;
    assert.equal(reloadClearParams.summaryConcurrency, 5);
    assert.equal(reloadClearParams.summaryReasoningEffort, 'inherit');
  });
}

await test('session-switch-resets-resumable-confirm-copied-path-and-action-error', async () => {
  const backupId = 'bkp-20261122T010000Z-reset001';
  const backupPath = `/home/user/.dsh/storages/dsh-compaction-weave/backups/s-rst/${backupId}`;
  const copied = [];
  const h = mountProgressCard({
    language: 'zh',
    clipboard: { writeText: async p => { copied.push(p); } },
    handler: payload => {
      if (payload.method === 'resume-compaction') {
        return { __error: { code: 'ERR', message: 'Resume failed on s-1' } };
      }
      if (payload.params.sessionId === 's-1') {
        return {
          active: false,
          phase: 'idle',
          bili: { detected: true, variant: 'ranxianglei-proxy-raw', foldBlockCount: 0, biliToolCount: 3, hasBrokenToolPairing: false, canConvert: true, needsBackup: true, hasOpenTurn: false, reasons: [] },
          backup: { count: 1, originalBackupId: backupId, latestBackupId: backupId, backupPath, items: [] },
          resumable: {
            jobId: 'job-s1',
            trigger: 'migration',
            status: 'paused_user',
            interruptReason: 'user_cancel',
            overallPercent: 50,
            completedChunks: 2,
            remainingNodes: 80,
            remainingTokens: 90000,
            initialTotalTokens: 180000,
            completedTokens: 90000,
            updatedAt: 1763741600000,
            canAutoResume: false,
            lastErrorCode: null,
            lastErrorMessage: null,
          },
        };
      }
      return {
        active: false,
        phase: 'idle',
        bili: { detected: false },
        backup: { count: 0, items: [] },
        resumable: null,
      };
    },
  });

  h.render({ sessionId: 's-1' });
  let tree = await h.settle();
  // Trigger error, copy path, and open discard-resume confirmation
  h.byAction(tree, 'resume-compaction').props.onClick();
  tree = await h.settle();
  assert.match(textOf(tree), /Resume failed on s-1/);

  h.byAction(tree, 'copy-backup-path').props.onClick();
  tree = await h.settle();
  assert.equal(textOf(h.byAction(tree, 'copy-backup-path')), '已复制');

  h.byAction(tree, 'discard-resume').props.onClick();
  tree = h.render();
  assert.ok(find(tree, n => n.props?.['data-confirm'] === 'discard-resume'));

  // Switch to clean idle session -> all state cleared, card becomes null
  h.render({ sessionId: 's-2' });
  tree = await h.settle();
  assert.equal(tree, null);

  // Switch back to s-1 -> confirm box, copied state, and old error remain cleanly reset
  h.render({ sessionId: 's-1' });
  tree = await h.settle();
  assert.equal(find(tree, n => n.props?.['data-confirm'] === 'discard-resume'), null);
  assert.equal(textOf(h.byAction(tree, 'copy-backup-path')), '复制');
  assert.doesNotMatch(textOf(tree), /Resume failed on s-1/);
  h.unmount();
});

await test('p1-1-settings-submit-syncs-server-maxTokens-under-follow-session-model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-p1-1-ui-'));
  const file = join(root, 'summary-config.json');
  const h = await mountSettingsSection({
    language: 'zh',
    rpcHandler: async (payload) => {
      if (payload.method === 'models') return null;
      try {
        const value = await handleSummaryConfigRpc(payload, file);
        if (payload.method === 'set' && value?.config) {
          // Simulate server-adjusted / canonicalized maxTokens returned in result.config
          return {
            status: 200,
            text: async () => JSON.stringify({ ok: true, value: { ...value, config: { ...value.config, maxTokens: 12288 } } }),
          };
        }
        return { status: 200, text: async () => JSON.stringify({ ok: true, value }) };
      } catch (error) {
        return { status: 200, text: async () => JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }) };
      }
    },
  });

  h.change('weave-summary-max-tokens', '16384');
  await h.click('save');
  const setReq = h.requests.filter(r => r.method === 'set').at(-1);
  assert.equal(setReq.params.provider, '');
  assert.equal(setReq.params.model, '');
  assert.equal(setReq.params.maxTokens, 16384);
  assert.equal(readSummaryConfig(file, { strict: true })?.maxTokens, 16384);
  assert.equal(h.field('weave-summary-max-tokens').props.value, '12288');

  // Clearing resets form.maxTokens cleanly
  await h.click('clear');
  assert.equal(h.field('weave-summary-max-tokens').props.value, '');
  assert.equal(readSummaryConfig(file, { strict: true }), null);
});

await test('p2-4-progress-card-messageParams-node-fallback-and-stream-timing', async () => {
  let payload = {
    active: true,
    phase: 'summarizing',
    elapsedMs: 4200,
    overallProcessedNodes: 8,
    overallTotalNodes: 20,
    overallTotalTokens: null,
    messageKey: 'waveTotalProgress',
    messageParams: { index: 2, total: 5 },
    stream: { chunks: 1, textChars: 0, reasoningChars: 0, firstChunkMs: 650, idleMs: 4200 },
    bili: { detected: false },
  };
  const h = mountProgressCard({ language: 'zh', handler: () => payload });
  h.render({ sessionId: 'sess-p2-4' });
  let tree = await h.settle();
  let txt = textOf(tree);
  assert.match(txt, /波次 2\/5/);
  assert.match(txt, /已处理 8 \/ 20 节点/);
  assert.match(txt, /首字 650ms/);
  assert.match(txt, /静默 4\.2s/);

  // Poll updates changing ONLY messageParams and stream timing must trigger re-render
  payload = {
    ...payload,
    messageParams: { index: 3, total: 5 },
    stream: { chunks: 1, textChars: 0, reasoningChars: 0, firstChunkMs: 1200, idleMs: 5500 },
  };
  tree = await h.fireNextTimer();
  txt = textOf(tree);
  assert.match(txt, /波次 3\/5/);
  assert.match(txt, /首字 1\.2s/);
  assert.match(txt, /静默 5\.5s/);
  h.unmount();
});

console.log(JSON.stringify({
  passed: results.filter(r => r.pass).length,
  failed: results.filter(r => !r.pass).length,
  results,
}, null, 2));
if (results.some(r => !r.pass)) process.exitCode = 1;
