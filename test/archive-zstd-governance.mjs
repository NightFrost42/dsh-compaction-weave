import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { zstdCompressSync } from 'node:zlib';
import vm from 'node:vm';

import {
  DEFAULT_ARCHIVE_WARN_BYTES,
  DEFAULT_CONFIG,
  MAX_ARCHIVE_WARN_BYTES,
  normalizeArchiveWarnBytes,
  resolveConfig,
} from '../lib/config.js';
import { CompactionArchive } from '../lib/history.js';
import { CompactionJournal } from '../lib/journal.js';
import { CompactionProgressTracker } from '../lib/progress-tracker.js';
import { SessionStateStore } from '../lib/state.js';
import { sessionDirectory } from '../lib/storage-path.js';
import {
  handleSummaryConfigRpc,
  readSummaryConfig,
  validateSummaryConfig,
} from '../lib/summary-config.js';
import { registerHistoryTools } from '../lib/tools.js';
import { apply as applyPlugin } from '../lib/index.js';
import { apply as applyEngine } from '../lib/engine-entry.js';

const testBaseRoot = process.env.WEAVE_TEST_ROOT ?? tmpdir();
const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message, stack: error.stack });
  }
}

function spanChecksum(body) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i += 1) {
    hash ^= body.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (body.charCodeAt(i) >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function buildPlainSpanContent({ sessionId, compactionId, entries }) {
  const body = entries.map((e) => JSON.stringify(e)).join('\n');
  const header = JSON.stringify({
    kind: 'compaction-weave/span',
    attachments: [],
    version: 3,
    compactionId,
    sessionId,
    entries: entries.length,
    bytes: Buffer.byteLength(body, 'utf8'),
    checksum: spanChecksum(body),
    at: '2026-01-01T00:00:00.000Z',
  });
  return `${header}\n${body}\n`;
}

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

function runHistoryTools(archive) {
  const map = new Map();
  const ok = registerHistoryTools(
    {
      tools: {
        register(spec) {
          map.set(spec.name, spec);
        },
      },
    },
    { archiveEnabled: true },
    archive,
  );
  assert.equal(ok, true);
  return async (toolName, sessionId, args) =>
    map.get(toolName).execute(args, { session: { id: sessionId } });
}

function mountClient({ language = 'zh', handler } = {}) {
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

  const depsChanged = (prev, next) => {
    if (prev === undefined || next === undefined) return true;
    if (prev.length !== next.length) return true;
    for (let i = 0; i < prev.length; i += 1) {
      if (!Object.is(prev[i], next[i])) return true;
    }
    return false;
  };

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
    }),
    useState: (initialState) => {
      const index = stateIndex++;
      if (!(index in states)) {
        states[index] = typeof initialState === 'function' ? initialState() : initialState;
      }
      return [
        states[index],
        (value) => {
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
        load: (declaration) => {
          mod = declaration.factory((name) => {
            assert.equal(name, 'react');
            return React;
          });
        },
      },
    },
    document: {
      visibilityState: 'visible',
      hidden: false,
      addEventListener() {},
      removeEventListener() {},
    },
    console,
    AbortController,
    setTimeout: (fn, delay) => {
      const id = nextTimerId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    setInterval: () => {
      throw new Error('Must not use setInterval');
    },
    clearInterval: () => {},
    fetch: (url, options) => {
      assert.equal(url, '/plugins/dsh-compaction-weave/rpc');
      const payload = JSON.parse(options.body);
      requests.push(payload);
      const task = (async () => {
        try {
          const result = await handler(payload);
          if (result && result.__error) {
            return { status: 200, text: async () => JSON.stringify({ ok: false, error: result.__error }) };
          }
          return { status: 200, text: async () => JSON.stringify({ ok: true, value: result }) };
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
        registeredSlots.set(desc.name, { desc, component });
        return () => {};
      },
    },
    effect: (cb) => cb(),
    locale: {
      register: (_ns, values) => {
        dictionaries = values;
        return () => {};
      },
      bind: () => (key) => {
        assert.equal(typeof dictionaries?.[language]?.[key], 'string', `Missing ${language}.${key}`);
        return dictionaries[language][key];
      },
    },
  });

  const mountSlot = (slotName, initialProps = {}) => {
    const Comp = registeredSlots.get(slotName)?.component;
    assert.ok(typeof Comp === 'function', `Missing slot ${slotName}`);
    let lastProps = initialProps;
    const render = (props = lastProps) => {
      lastProps = props;
      stateIndex = 0;
      effectIndex = 0;
      const tree = Comp(props);
      for (const slot of effects) {
        if (slot?.pending) {
          slot.pending = false;
          if (typeof slot.cleanup === 'function') slot.cleanup();
          slot.cleanup = slot.callback();
        }
      }
      return tree;
    };
    const settle = async () => {
      for (let i = 0; i < 6; i += 1) {
        if (pendingFetches.size > 0) await Promise.all([...pendingFetches]);
        await new Promise((resolve) => setImmediate(resolve));
        render(lastProps);
      }
      return render(lastProps);
    };
    return {
      render,
      settle,
      dictionaries,
      requests,
      field: (id) => find(render(), (n) => n.props?.id === id),
      byAction: (action) => find(render(), (n) => n.props?.['data-action'] === action),
      byKey: (key) => find(render(), (n) => n.type === 'button' && n.children.includes(dictionaries[language][key])),
      async clickAction(action) {
        const node = this.byAction(action);
        assert.ok(node && !node.props.disabled, `Expected enabled button [data-action="${action}"]`);
        await node.props.onClick();
        return settle();
      },
      async clickKey(key) {
        const node = this.byKey(key);
        assert.ok(node && !node.props.disabled, `Expected enabled button for key "${key}"`);
        await node.props.onClick();
        return settle();
      },
      change(id, value) {
        this.field(id).props.onChange({ target: { value: String(value) } });
        return render();
      },
      unmount() {
        for (const slot of effects) {
          if (typeof slot?.cleanup === 'function') slot.cleanup();
        }
      },
    };
  };

  return { dictionaries, requests, mountSlot };
}

// ── 1. Lossless .jsonl.zstd storage, integrity & minimal POSIX permissions ───

await test('zstd-writeSpan-reduces-size-and-roundtrips-verbatim-with-attachments', async () => {
  const root = await mkdtemp(join(testBaseRoot, 'weave-zstd-rt-'));
  try {
    const imgData = Buffer.alloc(4096, 17);
    const imgId = 'sha256:' + createHash('sha256').update(imgData).digest('hex');
    const archive = new CompactionArchive({ root: join(root, 'sessions') });
    archive.attachments = { async readImage() { return { data: imgData }; } };
    const entries = [
      { seq: 1, type: 'user/message', role: 'user', text: 'Do not mutate production tables. '.repeat(80) },
      { seq: 2, type: 'assistant/message', role: 'assistant', text: 'Repeated log trace output. '.repeat(120) },
      { seq: 3, type: 'user/message', role: 'user', blocks: [{ type: 'image', attachment: { attachmentId: imgId, bytes: imgData.length } }] },
    ];

    const file = await archive.writeSpan({ sessionId: 'sess-zstd-1', compactionId: 'cmp-1', entries });
    assert.ok(file && file.endsWith('.jsonl.zstd'), `expected .jsonl.zstd file, got ${file}`);

    const plainBytes = Buffer.byteLength(buildPlainSpanContent({ sessionId: 'sess-zstd-1', compactionId: 'cmp-1', entries }), 'utf8');
    const diskBytes = (await stat(file)).size;
    assert.ok(diskBytes < plainBytes * 0.25, `expected significant compression: ${diskBytes} vs ${plainBytes}`);

    const read = await archive.readSpan('sess-zstd-1', 'cmp-1');
    assert.equal(read.ok, true);
    assert.equal(read.binaryVerified, true);
    assert.deepEqual(read.entries, entries);

    const runTool = runHistoryTools(archive);
    const listed = await runTool('history_list', 'sess-zstd-1', {});
    assert.match(listed, /cmp-1/);
    const searchOut = await runTool('history_search', 'sess-zstd-1', { query: 'production tables' });
    assert.match(searchOut, /cmp-1/);
    const readOut = await runTool('history_read', 'sess-zstd-1', { compactionId: 'cmp-1' });
    assert.match(readOut, /Do not mutate production tables/);

    if (process.platform !== 'win32') {
      const rootMode = (await stat(archive.root)).mode & 0o777;
      const sessDir = archive.dirFor('sess-zstd-1');
      const dirMode = (await stat(sessDir)).mode & 0o777;
      const spanMode = (await stat(file)).mode & 0o777;
      const idxMode = (await stat(join(sessDir, 'index.jsonl'))).mode & 0o777;
      const blobMode = (await stat(join(sessDir, 'attachments', `${imgId.slice(7)}.blob`))).mode & 0o777;
      assert.equal(rootMode, 0o700);
      assert.equal(dirMode, 0o700);
      assert.equal(spanMode, 0o600);
      assert.equal(idxMode, 0o600);
      assert.equal(blobMode, 0o600);
    }

    // Corrupt zstd frame fails closed as damaged
    const buf = await readFile(file);
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    buf[buf.length - 1] ^= 0xff;
    await writeFile(file, buf);
    const bad = await archive.readSpan('sess-zstd-1', 'cmp-1');
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'damaged');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 2. Backwards compatibility, index.jsonl dedup & legacy dir migration ─────

await test('mixed-plain-and-zstd-coexist-index-dedup-prefers-latest-and-migrates-legacy-zstd-dir', async () => {
  const root = await mkdtemp(join(testBaseRoot, 'weave-zstd-compat-'));
  try {
    const archiveRoot = join(root, 'sessions');
    const archive = new CompactionArchive({ root: archiveRoot });
    const sessionId = 'sess-mixed';
    const dir = archive.dirFor(sessionId);
    await mkdir(dir, { recursive: true });

    // Legacy plaintext span directly on disk
    const plainEntries = [{ seq: 1, type: 'user/message', role: 'user', text: 'legacy plain requirement' }];
    const plainPath = join(dir, 'cmp-legacy.jsonl');
    await writeFile(plainPath, buildPlainSpanContent({ sessionId, compactionId: 'cmp-legacy', entries: plainEntries }), 'utf8');

    // Write zstd span via writeSpan for cmp-recompressed
    const zstdEntries = [{ seq: 2, type: 'user/message', role: 'user', text: 'modern zstd requirement' }];
    const zstdPath = await archive.writeSpan({ sessionId, compactionId: 'cmp-modern', entries: zstdEntries });

    // Prepend an older index.jsonl line for cmp-modern pointing to .jsonl, followed by latest .jsonl.zstd line
    const idxPath = join(dir, 'index.jsonl');
    const existingIdx = await readFile(idxPath, 'utf8');
    const olderRec = JSON.stringify({
      compactionId: 'cmp-modern',
      file: join(dir, 'cmp-modern.jsonl'),
      entries: 1,
      at: '2025-12-01T00:00:00.000Z',
    });
    const plainRec = JSON.stringify({
      compactionId: 'cmp-legacy',
      file: plainPath,
      entries: 1,
      at: '2025-11-01T00:00:00.000Z',
    });
    await writeFile(idxPath, `${plainRec}\n${olderRec}\n${existingIdx}`, 'utf8');

    const spans = await archive.listSpans(sessionId);
    assert.equal(spans.length, 2, 'duplicate index records for same compactionId must deduplicate');
    const modernSpan = spans.find((s) => s.compactionId === 'cmp-modern');
    assert.equal(modernSpan?.path, zstdPath, 'latest index record / .jsonl.zstd wins');
    assert.equal((await archive.search(sessionId, 'legacy plain requirement')).hits.length, 1);
    assert.equal((await archive.search(sessionId, 'modern zstd requirement')).hits.length, 1);

    // Legacy unhashed dir with ONLY .jsonl.zstd migrates cleanly; foreign dir does NOT
    const legacySid = 'legacy-zstd-dir';
    const legacyArchive = new CompactionArchive({ root: join(root, 'mig-sessions') });
    const ownedPath = await legacyArchive.writeSpan({ sessionId: legacySid, compactionId: 'c-1', entries: [{ seq: 5, text: 'owned zstd' }] });
    assert.ok(ownedPath.endsWith('.jsonl.zstd'));
    const hashedDir = legacyArchive.dirFor(legacySid);
    await rename(hashedDir, join(legacyArchive.root, legacySid));
    assert.equal(sessionDirectory(legacyArchive.root, legacySid, 'archive'), hashedDir);
    assert.equal((await legacyArchive.readSpan(legacySid, 'c-1')).entries[0].text, 'owned zstd');

    const foreignSid = 'foreign-zstd-dir';
    const foreignLegacyDir = join(legacyArchive.root, foreignSid);
    await mkdir(foreignLegacyDir, { recursive: true });
    await writeFile(
      join(foreignLegacyDir, 'c-1.jsonl.zstd'),
      zstdCompressSync(Buffer.from(buildPlainSpanContent({ sessionId: 'other-owner', compactionId: 'c-1', entries: [{ seq: 1, text: 'x' }] }), 'utf8')),
    );
    const foreignDest = sessionDirectory(legacyArchive.root, foreignSid, 'archive');
    assert.notEqual(foreignDest, foreignLegacyDir);
    const foreignStat = await stat(join(foreignLegacyDir, 'c-1.jsonl.zstd'));
    assert.ok(foreignStat.isFile(), 'foreign legacy dir must not be migrated onto another sessionId');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 3. getStorageStats (read-only) & compressLegacySpans (lossless) ──────────

await test('getStorageStats-readonly-and-compressLegacySpans-lossless-skip-corrupt', async () => {
  const root = await mkdtemp(join(testBaseRoot, 'weave-legacy-compress-'));
  try {
    const archiveRoot = join(root, 'sessions');
    const backupRoot = join(root, 'backups');
    const stateRoot = join(root, 'state');
    await mkdir(join(backupRoot, 'b1'), { recursive: true });
    await writeFile(join(backupRoot, 'b1', 'snap.bin'), Buffer.alloc(123, 3));

    const archive = new CompactionArchive({ root: archiveRoot });
    const sid = 'sess-legacy-convert';
    const dir = archive.dirFor(sid);
    await mkdir(dir, { recursive: true });

    const validEntries = [
      { seq: 1, type: 'user/message', role: 'user', text: 'Important rule alpha '.repeat(60) },
      { seq: 2, type: 'assistant/message', role: 'assistant', text: 'Response trace '.repeat(60) },
    ];
    const validPlainPath = join(dir, 'cmp-valid.jsonl');
    const validPlainText = buildPlainSpanContent({ sessionId: sid, compactionId: 'cmp-valid', entries: validEntries });
    await writeFile(validPlainPath, validPlainText, 'utf8');

    const badPlainPath = join(dir, 'cmp-corrupt.jsonl');
    await writeFile(badPlainPath, '{corrupted json header\n', 'utf8');

    const badChecksumPath = join(dir, 'cmp-badsum.jsonl');
    await writeFile(
      badChecksumPath,
      buildPlainSpanContent({ sessionId: sid, compactionId: 'cmp-badsum', entries: [{ seq: 9, text: 'a' }] }).replace(/"checksum":"[0-9a-f]+"/, '"checksum":"deadbeef"'),
      'utf8',
    );

    const beforeStats = await archive.getStorageStats({
      backupRoot,
      stateRoot,
      probeSessionExists: async () => true,
    });
    assert.equal(beforeStats.backupBytes, 123);
    assert.equal(beforeStats.sessionCount, 1);
    assert.equal(beforeStats.spanCount, 3);
    assert.equal(beforeStats.legacyPlainSpanCount, 3);
    assert.ok(beforeStats.legacyPlainSpanBytes > 0);
    assert.equal(beforeStats.orphanProbeAvailable, true);
    assert.equal(beforeStats.orphanSessionCount, 0);

    const comp = await archive.compressLegacySpans();
    assert.equal(comp.compressedCount, 1);
    assert.equal(comp.skippedCount, 1);
    assert.equal(comp.failedCount, 1);
    assert.ok(comp.bytesSaved > 0);

    await assert.rejects(stat(validPlainPath), /ENOENT/);
    const convertedStat = await stat(join(dir, 'cmp-valid.jsonl.zstd'));
    assert.ok(convertedStat.isFile());
    const corruptStat = await stat(badPlainPath);
    assert.ok(corruptStat.isFile(), 'corrupt legacy .jsonl must be preserved, never deleted');
    const badSumStat = await stat(badChecksumPath);
    assert.ok(badSumStat.isFile(), 'bad-checksum legacy .jsonl must be preserved, never deleted');

    const readAfter = await archive.readSpan(sid, 'cmp-valid');
    assert.equal(readAfter.ok, true);
    assert.deepEqual(readAfter.entries, validEntries);

    const afterStats = await archive.getStorageStats({ backupRoot, stateRoot });
    assert.equal(afterStats.legacyPlainSpanCount, 2);
    assert.equal(afterStats.orphanProbeAvailable, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 4. Fail-closed cleanupOrphanArchives ──────────────────────────────────────

await test('cleanupOrphanArchives-fail-closed-and-preserves-active-pending-ambiguous', async () => {
  const root = await mkdtemp(join(testBaseRoot, 'weave-orphans-'));
  try {
    const archiveRoot = join(root, 'sessions');
    const stateRoot = join(root, 'state');
    const archive = new CompactionArchive({ root: archiveRoot });
    const journal = CompactionJournal.alongside(archiveRoot);
    const stateStore = new SessionStateStore(stateRoot);

    const sidOrphan = 'sess-orphan';
    const sidOrphanStateOnly = 'sess-orphan-state-only';
    const sidActiveLive = 'sess-active-live';
    const sidPendingJournal = 'sess-pending-journal';

    await archive.writeSpan({ sessionId: sidOrphan, compactionId: 'o-1', entries: [{ seq: 1, text: 'orphan' }] });
    await archive.writeSpan({ sessionId: sidActiveLive, compactionId: 'a-1', entries: [{ seq: 1, text: 'live' }] });
    await archive.writeSpan({ sessionId: sidPendingJournal, compactionId: 'j-1', entries: [{ seq: 1, text: 'pending' }] });

    // Orphan identified strictly via state/<hash>.json when archive only holds non-parseable data
    const stateOnlyDir = archive.dirFor(sidOrphanStateOnly);
    await mkdir(stateOnlyDir, { recursive: true });
    await writeFile(join(stateOnlyDir, 'index.jsonl'), '', 'utf8');
    stateStore.update(sidOrphanStateOnly, () => ({ stopped: false, failures: 0 }));

    // Ambiguous dir: hashed directory name, no valid span header, no state file
    const ambiguousDir = archive.dirFor('sess-unknown-ambiguous');
    await mkdir(ambiguousDir, { recursive: true });
    await writeFile(join(ambiguousDir, 'index.jsonl'), '{"broken":true\n', 'utf8');

    // Pending journal holds lock for sidPendingJournal even if host session list reports missing
    await journal.record({ sessionId: sidPendingJournal, compactionId: 'lock-1', phase: 'started', startEventSeq: 1 });

    // 1. Refuses without confirmDelete: true
    await assert.rejects(
      archive.cleanupOrphanArchives({ stateRoot, journal, probeSessionExists: async () => false }),
      (e) => e.code === 'CONFIRMATION_REQUIRED',
    );

    // 2. Fail-closed when host probe unavailable
    const noProbe = await archive.cleanupOrphanArchives({ confirmDelete: true, stateRoot, journal });
    assert.equal(noProbe.supported, false);
    assert.equal(noProbe.deletedSessions, 0);
    assert.equal(noProbe.reason, 'ORPHAN_PROBE_UNAVAILABLE');
    assert.ok((await stat(archive.dirFor(sidOrphan))).isDirectory());

    // 3. Probe exists for nothing on disk, yet live sessions + pending journal + ambiguous preserved
    const missingSet = new Set([sidOrphan, sidOrphanStateOnly, sidPendingJournal]);
    const sessions = new Map([[sidActiveLive, { id: sidActiveLive }]]);
    const sessionPersistence = {
      async stat(id) {
        if (missingSet.has(id)) {
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        }
        return { size: 100 };
      },
    };

    const previewStats = await archive.getStorageStats({ stateRoot, journal, sessions, sessionPersistence });
    assert.equal(previewStats.orphanProbeAvailable, true);
    assert.equal(previewStats.orphanSessionCount, 2);
    assert.equal(previewStats.ambiguousSessionCount, 1);

    const res = await archive.cleanupOrphanArchives({
      confirmDelete: true,
      stateRoot,
      journal,
      sessions,
      sessionPersistence,
    });
    assert.equal(res.supported, true);
    assert.equal(res.deletedSessions, 2);
    assert.ok(res.freedBytes > 0);

    await assert.rejects(stat(archive.dirFor(sidOrphan)), /ENOENT/);
    await assert.rejects(stat(archive.dirFor(sidOrphanStateOnly)), /ENOENT/);
    assert.ok((await stat(archive.dirFor(sidActiveLive))).isDirectory());
    assert.ok((await stat(archive.dirFor(sidPendingJournal))).isDirectory());
    assert.ok((await stat(ambiguousDir)).isDirectory());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 5. Config, summary-config RPC, soft archiveWarning & runtime RPC ─────────

await test('archiveWarnBytes-config-and-runtime-rpcs-soft-warning-never-auto-deletes', async () => {
  const root = await mkdtemp(join(testBaseRoot, 'weave-warn-rpc-'));
  const prevDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    assert.equal(DEFAULT_ARCHIVE_WARN_BYTES, 512 * 1024 * 1024);
    assert.equal(DEFAULT_CONFIG.archiveWarnBytes, DEFAULT_ARCHIVE_WARN_BYTES);
    assert.equal(normalizeArchiveWarnBytes(0), 0);
    assert.equal(normalizeArchiveWarnBytes(1024), 1024);
    assert.throws(() => normalizeArchiveWarnBytes(-1));
    assert.throws(() => normalizeArchiveWarnBytes(1.5));
    assert.throws(() => normalizeArchiveWarnBytes(MAX_ARCHIVE_WARN_BYTES + 1));
    assert.equal(resolveConfig({ archiveWarnBytes: 0 }).config.archiveWarnBytes, 0);

    assert.equal(validateSummaryConfig({ archiveWarnBytes: -5 }).code, 'INVALID_ARCHIVE_WARN_BYTES');
    assert.equal(validateSummaryConfig({ archiveWarnBytes: MAX_ARCHIVE_WARN_BYTES + 1 }).code, 'INVALID_ARCHIVE_WARN_BYTES');

    const cfgFile = join(root, 'storages', 'dsh-compaction-weave', 'summary-config.json');
    await handleSummaryConfigRpc({ method: 'set', params: { provider: 'p', model: 'm', archiveWarnBytes: 256 * 1024 * 1024 } }, cfgFile);
    await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '' } }, cfgFile);
    assert.equal(readSummaryConfig(cfgFile, { strict: true }).archiveWarnBytes, 256 * 1024 * 1024);
    await rm(cfgFile, { force: true });

    // Tracker sanitization emits warning strictly when totalBytes >= warnBytes and warnBytes > 0
    const tracker = new CompactionProgressTracker();
    assert.equal(tracker.snapshot('s1', { archiveWarning: { totalBytes: 100, warnBytes: 0 } }).archiveWarning ?? null, null);
    assert.equal(tracker.snapshot('s1', { archiveWarning: { totalBytes: 99, warnBytes: 100 } }).archiveWarning ?? null, null);
    assert.deepEqual(
      tracker.snapshot('s1', { archiveWarning: { totalBytes: 120, warnBytes: 100, legacyPlainSpanCount: 3 } }).archiveWarning,
      { warnExceeded: true, totalBytes: 120, warnBytes: 100, legacyPlainSpanCount: 3 },
    );

    // End-to-end runtime RPC route via plugin apply + engine-entry apply
    const provided = new Map();
    const sessionsMap = new Map([['sess-live', { id: 'sess-live' }]]);
    let routeHandler = null;
    const baseCtx = {
      baseDir: root,
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      sessions: sessionsMap,
      sessionPersistence: {
        async stat(id) {
          if (id === 'sess-live') return { size: 50 };
          const err = new Error('ENOENT');
          err.code = 'ENOENT';
          throw err;
        },
      },
      on() { return () => {}; },
      provide(k, v) { provided.set(k, v); },
      get(k) { return provided.get(k); },
      inject(deps, fn) {
        if (deps.includes('webServer')) {
          return fn({
            effect: (cb) => cb(),
            webServer: { register(spec) { routeHandler = spec.handler; return () => {}; } },
          });
        }
        if (deps.includes('llm')) return fn({ llm: { listProviders: () => [] } });
        if (deps.includes('compactionWeaveRuntime')) {
          return fn({ compactionWeaveRuntime: provided.get('compactionWeaveRuntime') });
        }
        if (deps.includes('sessionPersistence')) {
          return fn({ sessionPersistence: baseCtx.sessionPersistence, sessions: sessionsMap, logger: baseCtx.logger, provide() {} });
        }
        return () => {};
      },
    };

    const archiveDir = join(root, 'storages', 'dsh-compaction-weave', 'sessions');
    applyPlugin(baseCtx, { engine: { archiveDir, archiveWarnBytes: 1 } });
    applyEngine(baseCtx, { archiveDir, archiveWarnBytes: 1 });
    const engine = provided.get('compactionWeaveRuntime').getDefaultEngine();

    // Seed an orphan plain .jsonl file + a live zstd span
    const orphanDir = engine.archive.dirFor('sess-gone');
    await mkdir(orphanDir, { recursive: true });
    await writeFile(
      join(orphanDir, 'old.jsonl'),
      buildPlainSpanContent({ sessionId: 'sess-gone', compactionId: 'old', entries: [{ seq: 1, text: 'orphan text '.repeat(50) }] }),
      'utf8',
    );
    await engine.archive.writeSpan({ sessionId: 'sess-live', compactionId: 'live-1', entries: [{ seq: 1, text: 'keep me' }] });

    const callRpc = async (method, params = {}) => {
      let statusCode = 0;
      let bodyText = '';
      const req = Readable.from([Buffer.from(JSON.stringify({ method, params }))]);
      req.method = 'POST';
      req.headers = { origin: 'http://localhost', host: 'localhost', 'content-type': 'application/json' };
      const res = {
        set statusCode(c) { statusCode = c; },
        get statusCode() { return statusCode; },
        setHeader() {},
        writeHead(c) { statusCode = c; },
        end(chunk) { bodyText += String(chunk ?? ''); },
      };
      await routeHandler(req, res);
      return { statusCode, body: JSON.parse(bodyText) };
    };

    const statsRpc = await callRpc('archive-stats');
    assert.equal(statsRpc.body.ok, true);
    assert.equal(statsRpc.body.value.storage.legacyPlainSpanCount, 1);
    assert.equal(statsRpc.body.value.storage.orphanSessionCount, 1);
    assert.equal(statsRpc.body.value.storage.warnExceeded, true);

    const getRpc = await callRpc('get');
    assert.equal(getRpc.body.value.archiveStorage.warnBytes, 1);
    assert.equal(getRpc.body.value.archiveStorage.warnExceeded, true);

    // Status exposes archiveWarning and does NOT delete anything
    const st = await callRpc('status', { sessionId: 'sess-live' });
    assert.equal(st.body.value.archiveWarning.warnExceeded, true);
    assert.ok((await stat(join(orphanDir, 'old.jsonl'))).isFile());

    // Manual compress via RPC
    const compRpc = await callRpc('archive-compress-legacy');
    assert.equal(compRpc.body.value.compressedCount, 1);
    assert.equal(compRpc.body.value.storage.legacyPlainSpanCount, 0);

    // Cleanup rejects without confirmDelete: true, then cleans only orphan with confirmDelete: true
    const rejectedCleanup = await callRpc('archive-cleanup-orphans', {});
    assert.equal(rejectedCleanup.body.ok, false);
    assert.equal(rejectedCleanup.body.error.code, 'CONFIRMATION_REQUIRED');

    const okCleanup = await callRpc('archive-cleanup-orphans', { confirmDelete: true });
    assert.equal(okCleanup.body.ok, true);
    assert.equal(okCleanup.body.value.deletedSessions, 1);
    assert.equal(okCleanup.body.value.storage.orphanSessionCount, 0);
    await assert.rejects(stat(orphanDir), /ENOENT/);
    assert.ok((await stat(engine.archive.dirFor('sess-live'))).isDirectory());

    // Setting archiveWarnBytes: 0 via RPC hot-reloads warning off
    await callRpc('set', { archiveWarnBytes: 0 });
    const stAfterOff = await callRpc('status', { sessionId: 'sess-live' });
    assert.equal(stAfterOff.body.value.archiveWarning ?? null, null);
  } finally {
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
    await rm(root, { recursive: true, force: true });
  }
});

// ── 6. Client UI (Dock warning + Settings storage panel, ZH & EN) ────────────

for (const language of ['zh', 'en']) {
  await test(`${language}-client-ui-dock-archive-warning-and-settings-storage-panel`, async () => {
    // 6a. Dock banner shows & dismisses back to null when idle
    let dockWarning = { warnExceeded: true, totalBytes: 700 * 1024 * 1024, warnBytes: 512 * 1024 * 1024, legacyPlainSpanCount: 4 };
    const dockHost = mountClient({
      language,
      handler: (payload) => {
        if (payload.method === 'status') {
          return { active: false, phase: 'idle', elapsedMs: 0, archiveWarning: dockWarning };
        }
        return {};
      },
    });
    const dock = dockHost.mountSlot('conversation.input.dock', { sessionId: 's-dock' });
    dock.render({ sessionId: 's-dock' });
    const warnTree = await dock.settle();
    assert.equal(warnTree?.props?.['data-compaction-progress'], 'archive-warning');
    const warnBox = find(warnTree, (n) => n.props?.['data-archive-warning'] === 'true');
    assert.ok(warnBox);
    if (language === 'zh') assert.match(textOf(warnBox), /sessions\/.*700 MiB.*512 MiB.*不会自动删除/);
    else assert.match(textOf(warnBox), /sessions\/.*700 MiB.*512 MiB.*never auto-deleted/i);

    const afterDismiss = await dock.clickAction('dismiss-archive-warning');
    assert.equal(afterDismiss, null, 'dismissed idle archiveWarning must collapse to null');
    dock.unmount();

    // 6b. Settings UI load/validate/save/clear/compress/cleanup
    const root = await mkdtemp(join(testBaseRoot, `weave-ui-archive-${language}-`));
    try {
      const cfgFile = join(root, 'summary-config.json');
      let storageState = {
        totalBytes: 600 * 1024 * 1024,
        backupBytes: 12 * 1024 * 1024,
        sessionCount: 5,
        spanCount: 18,
        legacyPlainSpanCount: 3,
        legacyPlainSpanBytes: 200 * 1024 * 1024,
        orphanProbeAvailable: false,
        orphanSessionCount: 0,
        orphanBytes: 0,
        ambiguousSessionCount: 1,
        warnBytes: 512 * 1024 * 1024,
        warnExceeded: true,
      };
      const calls = [];
      const rpcHandler = async (payload) => {
        calls.push(payload);
        if (payload.method === 'models') {
          return { providers: [{ provider: 'p', name: 'Provider P', models: [{ id: 'm' }] }] };
        }
        if (payload.method === 'archive-compress-legacy') {
          storageState = {
            ...storageState,
            totalBytes: 420 * 1024 * 1024,
            legacyPlainSpanCount: 0,
            legacyPlainSpanBytes: 0,
            warnExceeded: storageState.warnBytes > 0 && 420 * 1024 * 1024 >= storageState.warnBytes,
          };
          return { compressedCount: 3, skippedCount: 0, failedCount: 0, bytesBefore: 200 * 1024 * 1024, bytesAfter: 20 * 1024 * 1024, bytesSaved: 180 * 1024 * 1024, storage: storageState };
        }
        if (payload.method === 'archive-cleanup-orphans') {
          assert.equal(payload.params?.confirmDelete, true);
          storageState = {
            ...storageState,
            totalBytes: 300 * 1024 * 1024,
            sessionCount: 3,
            orphanSessionCount: 0,
            orphanBytes: 0,
            warnExceeded: storageState.warnBytes > 0 && 300 * 1024 * 1024 >= storageState.warnBytes,
          };
          return { supported: true, deletedSessions: 2, freedBytes: 120 * 1024 * 1024, skippedCount: 3, storage: storageState };
        }
        const res = await handleSummaryConfigRpc(payload, cfgFile);
        if (payload.method === 'set' && res?.config?.archiveWarnBytes !== undefined) {
          storageState = {
            ...storageState,
            warnBytes: res.config.archiveWarnBytes,
            warnExceeded: res.config.archiveWarnBytes > 0 && storageState.totalBytes >= res.config.archiveWarnBytes,
          };
        }
        if (payload.method === 'get') {
          return { ...res, archiveStorage: storageState };
        }
        return res;
      };

      const uiHost = mountClient({ language, handler: rpcHandler });
      assert.deepEqual(Object.keys(uiHost.dictionaries.zh).sort(), Object.keys(uiHost.dictionaries.en).sort());
      const settings = uiHost.mountSlot('settings.section');
      settings.render();
      const loadedTree = await settings.settle();

      // Strictly NO extra RPC calls in load() beyond ['get', 'models']
      assert.deepEqual(calls.map((c) => c.method).sort(), ['get', 'models']);

      const panel = find(loadedTree, (n) => n.props?.['data-settings-archive-storage'] === 'true');
      assert.ok(panel);
      assert.ok(find(panel, (n) => n.props?.['data-archive-warn-banner'] === 'true'));
      assert.ok(find(panel, (n) => n.props?.['data-archive-probe-unavailable'] === 'true'));
      assert.equal(settings.byAction('archive-cleanup-orphans').props.disabled, true);
      assert.equal(settings.field('weave-archive-warn-mb').props.value, '512');

      // Untouched default save omits archiveWarnBytes
      await settings.clickKey('save');
      assert.equal(Object.hasOwn(calls.filter((c) => c.method === 'set').at(-1).params, 'archiveWarnBytes'), false);

      // Invalid archiveWarnMb values rejected locally
      for (const bad of ['-1', '102401', '1.5', '']) {
        settings.change('weave-archive-warn-mb', bad);
        await settings.clickKey('save');
        assert.equal(calls.filter((c) => c.method === 'set').length, 1, `bad value ${bad} must fail validation before rpc('set')`);
      }

      // Change threshold to 256 MiB, save, then model clear preserves it
      settings.change('weave-archive-warn-mb', '256');
      await settings.clickKey('save');
      assert.equal(readSummaryConfig(cfgFile, { strict: true }).archiveWarnBytes, 256 * 1024 * 1024);
      await settings.clickKey('clear');
      assert.equal(readSummaryConfig(cfgFile, { strict: true }).archiveWarnBytes, 256 * 1024 * 1024);

      // Setting 0 disables warning banner cleanly
      settings.change('weave-archive-warn-mb', '0');
      const zeroTree = await settings.clickKey('save');
      assert.equal(readSummaryConfig(cfgFile, { strict: true }).archiveWarnBytes, 0);
      assert.equal(find(zeroTree, (n) => n.props?.['data-archive-warn-banner'] === 'true'), null);

      // Compress legacy spans via button
      const afterCompress = await settings.clickAction('archive-compress-legacy');
      assert.equal(settings.byAction('archive-compress-legacy').props.disabled, true, 'legacy count now 0 -> button disables');
      assert.ok(find(afterCompress, (n) => n.props?.['data-archive-feedback'] === 'success'));

      // Reload with orphanProbeAvailable = true -> test 2-step orphan confirmation
      storageState = { ...storageState, orphanProbeAvailable: true, orphanSessionCount: 2, orphanBytes: 120 * 1024 * 1024 };
      const reloaded = mountClient({ language, handler: rpcHandler }).mountSlot('settings.section');
      reloaded.render();
      const loadedOrphan = await reloaded.settle();
      assert.equal(reloaded.field('weave-archive-warn-mb').props.value, '0');
      assert.equal(find(loadedOrphan, (n) => n.props?.['data-confirm'] === 'archive-cleanup-orphans'), null);
      const confirmTree = await reloaded.clickAction('archive-cleanup-orphans');
      assert.ok(find(confirmTree, (n) => n.props?.['data-confirm'] === 'archive-cleanup-orphans'));
      const cleanedTree = await reloaded.clickAction('archive-cleanup-confirm');
      assert.equal(find(cleanedTree, (n) => n.props?.['data-confirm'] === 'archive-cleanup-orphans'), null);
      assert.equal(reloaded.byAction('archive-cleanup-orphans').props.disabled, true);
      assert.ok(find(cleanedTree, (n) => n.props?.['data-archive-feedback'] === 'success'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

console.log(JSON.stringify({
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
}, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
