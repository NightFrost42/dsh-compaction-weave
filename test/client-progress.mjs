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
function mountProgressCard({ language = 'zh', handler, initialVisibility = 'visible' } = {}) {
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
    setVisibility,
    unmount,
    byAction: (tree, action) => find(tree, n => n.props?.['data-action'] === action),
  };
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

await test('idle-non-bili-session-renders-null-and-polls-at-1500ms', async () => {
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
  assert.equal(h.scheduledDelays.at(-1), 1500);
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
  assert.match(textOf(pendingBanner), /关闭并重新打开当前会话/);
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
  assert.equal(h.scheduledDelays.at(-1), 1500);
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

console.log(JSON.stringify({
  passed: results.filter(r => r.pass).length,
  failed: results.filter(r => !r.pass).length,
  results,
}, null, 2));
if (results.some(r => !r.pass)) process.exitCode = 1;
