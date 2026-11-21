import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  SessionBackupStore,
  createSessionBackup,
  verifySessionBackup,
  listSessionBackups,
  summarizeBackups,
  restoreSessionBackup,
  readPendingRestore,
  applyPendingRestoreBeforeOpen,
} from '../lib/session-backup.js';
import { SessionStateStore } from '../lib/state.js';
import { CompactionJournal } from '../lib/journal.js';
import { ContinuationProgressStore } from '../lib/continuation-progress.js';
import { StockTransactionAdapter } from '../lib/transaction.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message, stack: error.stack });
  }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function makeTempWorkspace(tag) {
  const root = mkdtempSync(join(tmpdir(), `weave-backup-${tag}-`));
  const dshSessionDir = join(root, 'dsh-sessions', '_no-cwd', 'sess-1');
  const weaveStorage = join(root, 'weave-storage');
  fs.mkdirSync(dshSessionDir, { recursive: true });
  fs.mkdirSync(weaveStorage, { recursive: true });
  return {
    root,
    dshSessionDir,
    weaveStorage,
    backupStore: new SessionBackupStore({ root: join(weaveStorage, 'backups') }),
    stateStore: new SessionStateStore(join(weaveStorage, 'state')),
    journal: new CompactionJournal({ root: join(weaveStorage, 'journal') }),
    contRoot: join(weaveStorage, 'continuation-progress'),
  };
}

function makeFakeZstdBytes(label) {
  // Real Zstandard frame magic (0x28 0xB5 0x2F 0xFD) plus non-UTF8 binary payload bytes
  // so any accidental UTF-8 decoding/re-encoding would immediately corrupt the bytes.
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58, 0xff, 0xfe, 0x80, 0x81, 0x00]);
  const body = Buffer.from(`frame:${label}:end\n`, 'utf8');
  return Buffer.concat([magic, body, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff])]);
}

function makeMockBackend(sessionId, targetPath, { liveWriter = false } = {}) {
  const writers = new Map();
  let claimed = false;
  let leaseReleased = 0;
  let leaseAcquired = 0;
  const coldLogMemo = new Map([[sessionId, { stale: true }]]);

  const writerHandle = {
    id: sessionId,
    access: 'write',
    closing: false,
    lease: { active: true },
    state: { materialized: true, cursor: 5 },
    buffered: [],
    quarantined: false,
    run(_label, fn) {
      return fn();
    },
    async persistContiguous() {},
  };
  if (liveWriter) writers.set(sessionId, writerHandle);

  const backend = {
    tracker: {
      writers,
      claimWrite(id) {
        if (claimed) throw new Error(`already claimed ${id}`);
        claimed = true;
      },
      releaseClaim() {
        claimed = false;
      },
    },
    coldLogMemo,
    locate() {
      return { kind: 'jsonl', path: targetPath };
    },
    async findLog() {
      return { sourcePath: targetPath, sourceVersion: 4, currentPath: targetPath };
    },
    async acquireLease() {
      leaseAcquired += 1;
      return {
        async release() {
          leaseReleased += 1;
        },
      };
    },
  };

  return {
    backend,
    writerHandle,
    stats: () => ({ claimed, leaseAcquired, leaseReleased, memoHas: coldLogMemo.has(sessionId) }),
  };
}

await test('zstd-raw-byte-fidelity-and-zero-foreign-files-in-dsh-session-dir', async () => {
  const ws = makeTempWorkspace('zstd');
  const sessionId = 'sess-zstd-1';
  const zstdPath = join(ws.dshSessionDir, 'session.v4.jsonl.zstd');
  const originalBytes = makeFakeZstdBytes('before-migration');
  fs.writeFileSync(zstdPath, originalBytes);

  ws.stateStore.update(sessionId, () => ({ failures: 1, stopped: false }));
  const mock = makeMockBackend(sessionId, zstdPath, { liveWriter: true });
  const session = {
    id: sessionId,
    seq: 5,
    header: { version: 4, id: sessionId, createdAt: 1700000000000, isSeeded: false, delegationDepth: 0 },
    surface: { nodes: [0, 1, 2], replaceGeneration: 0 },
  };
  let flushed = 0;
  const sessions = {
    get: () => null,
    async flush() {
      flushed += 1;
    },
  };

  const created = await createSessionBackup(ws.backupStore, {
    session,
    sessions,
    backend: mock.backend,
    stateStore: ws.stateStore,
    reason: 'bili-migration',
  });

  assert.equal(flushed, 1);
  assert.equal(created.ok, true);
  assert.equal(created.manifest.source.encoding, 'zstd');
  assert.equal(created.manifest.source.rawLogFilename, 'session.v4.jsonl.zstd');
  assert.equal(created.manifest.source.formatVersion, 4);
  assert.deepEqual(fs.readFileSync(created.backupPath), originalBytes);
  // Zero foreign files in DSH's session directory after backup!
  assert.deepEqual(fs.readdirSync(ws.dshSessionDir), ['session.v4.jsonl.zstd']);

  // Simulate post-migration mutations: log overwritten, state mutated, stale journal & continuation progress written.
  const mutatedBytes = makeFakeZstdBytes('after-migration-mutated');
  fs.writeFileSync(zstdPath, mutatedBytes);
  ws.stateStore.update(sessionId, () => ({ failures: 3, stopped: true }));
  await ws.journal.record({ sessionId, compactionId: 'weave-post-1', phase: 'committing' });
  const contStore = new ContinuationProgressStore(ws.contRoot, sessionId, 'a'.repeat(64));
  contStore.write({ segments: [] }, 0);

  // Detach writer -> Path A cold restore.
  mock.backend.tracker.writers.delete(sessionId);
  const restored = await restoreSessionBackup(ws.backupStore, {
    sessionId,
    backupId: created.backupId,
    sessions,
    backend: mock.backend,
    stateStore: ws.stateStore,
    journal: ws.journal,
    continuationProgressRoot: ws.contRoot,
  });

  assert.equal(restored.status, 'restored');
  assert.equal(restored.requiresReopen, false);
  // Bit-for-bit identical Zstandard binary restoration!
  assert.deepEqual(fs.readFileSync(zstdPath), originalBytes);
  assert.equal(sha256(fs.readFileSync(zstdPath)), sha256(originalBytes));
  // Pre-restore safety copy lives strictly inside Weave's backup dir, NEVER DSH's session dir!
  assert.ok(restored.safetyCopyPath.startsWith(ws.backupStore.dirFor(sessionId)));
  assert.deepEqual(fs.readFileSync(restored.safetyCopyPath), mutatedBytes);
  assert.deepEqual(fs.readdirSync(ws.dshSessionDir), ['session.v4.jsonl.zstd']);
  // Aux Weave stores synced cleanly:
  assert.deepEqual(ws.stateStore.read(sessionId), { failures: 1, stopped: false });
  assert.equal((await ws.journal.pending(sessionId)).length, 0);
  assert.equal(contStore.read(), null);
  assert.equal(mock.stats().memoHas, false);
  assert.equal(mock.stats().claimed, false);
  assert.equal(mock.stats().leaseAcquired, 1);
  assert.equal(mock.stats().leaseReleased, 1);
});

await test('plaintext-jsonl-backup-and-absent-state-removal-on-restore', async () => {
  const ws = makeTempWorkspace('jsonl');
  const sessionId = 'sess-plain-1';
  const jsonlPath = join(ws.dshSessionDir, 'session.v4.jsonl');
  const rawText = '{"type":"session","version":4,"id":"sess-plain-1","createdAt":1,"isSeeded":false,"delegationDepth":0}\n';
  fs.writeFileSync(jsonlPath, rawText, 'utf8');

  const created = await createSessionBackup(ws.backupStore, {
    sessionId,
    logPath: jsonlPath,
    stateStore: ws.stateStore,
    reason: 'manual',
  });
  assert.equal(created.manifest.source.encoding, 'none');
  assert.equal(created.manifest.files.weaveState, null);

  // Create state file AFTER backup, then restore -> state file must be deleted.
  ws.stateStore.update(sessionId, () => ({ failures: 2, stopped: true }));
  fs.writeFileSync(jsonlPath, rawText + '{"seq":0,"type":"turn/start","time":2,"data":{"turn":1}}\n', 'utf8');

  const restored = await restoreSessionBackup(ws.backupStore, {
    sessionId,
    backupId: created.backupId,
    logPath: jsonlPath,
    stateStore: ws.stateStore,
    journal: ws.journal,
    continuationProgressRoot: ws.contRoot,
  });
  assert.equal(restored.status, 'restored');
  assert.equal(fs.readFileSync(jsonlPath, 'utf8'), rawText);
  assert.equal(fs.existsSync(ws.stateStore.file(sessionId)), false);
  assert.deepEqual(fs.readdirSync(ws.dshSessionDir), ['session.v4.jsonl']);
});

await test('sha256-tamper-and-encoding-mismatch-rejected-before-mutation', async () => {
  const ws = makeTempWorkspace('tamper');
  const sessionId = 'sess-tamper-1';
  const zstdPath = join(ws.dshSessionDir, 'session.v4.jsonl.zstd');
  const original = makeFakeZstdBytes('intact');
  fs.writeFileSync(zstdPath, original);

  const created = await createSessionBackup(ws.backupStore, {
    sessionId,
    logPath: zstdPath,
    reason: 'bili-migration',
  });

  // 1. Cross-encoding mismatch (.zstd backup vs plain .jsonl target) refused without touching target.
  const plainTarget = join(ws.root, 'other-dir', 'session.v4.jsonl');
  fs.mkdirSync(dirname(plainTarget), { recursive: true });
  fs.writeFileSync(plainTarget, 'untouched');
  await assert.rejects(
    restoreSessionBackup(ws.backupStore, {
      sessionId,
      backupId: created.backupId,
      logPath: plainTarget,
    }),
    (err) => err.code === 'BACKUP_ENCODING_MISMATCH',
  );
  assert.equal(fs.readFileSync(plainTarget, 'utf8'), 'untouched');

  // 2. Flip 1 byte in backed-up raw log -> verify fails & restore refuses without touching target.
  const tamperedRaw = Buffer.from(fs.readFileSync(created.backupPath));
  tamperedRaw[0] ^= 0xff;
  fs.writeFileSync(created.backupPath, tamperedRaw);

  const checkRaw = verifySessionBackup(ws.backupStore, sessionId, created.backupId);
  assert.equal(checkRaw.ok, false);
  assert.equal(checkRaw.code, 'BACKUP_CHECKSUM_MISMATCH');

  const currentLive = makeFakeZstdBytes('live-untouched');
  fs.writeFileSync(zstdPath, currentLive);
  await assert.rejects(
    restoreSessionBackup(ws.backupStore, {
      sessionId,
      backupId: created.backupId,
      logPath: zstdPath,
    }),
    (err) => err.code === 'BACKUP_VERIFICATION_FAILED',
  );
  assert.deepEqual(fs.readFileSync(zstdPath), currentLive);

  // 3. Restore raw bytes, tamper manifest -> verify rejects with BACKUP_MANIFEST_TAMPERED.
  fs.writeFileSync(created.backupPath, original);
  const manifest = JSON.parse(fs.readFileSync(created.manifestPath, 'utf8'));
  manifest.reason = 'tampered-reason';
  fs.writeFileSync(created.manifestPath, JSON.stringify(manifest));
  const checkManifest = verifySessionBackup(ws.backupStore, sessionId, created.backupId);
  assert.equal(checkManifest.ok, false);
  assert.equal(checkManifest.code, 'BACKUP_MANIFEST_TAMPERED');
});

await test('path-b-live-restore-arms-quarantines-and-applies-via-recoverBeforeOpen', async () => {
  const ws = makeTempWorkspace('pathb');
  const sessionId = 'sess-live-1';
  const zstdPath = join(ws.dshSessionDir, 'session.v4.jsonl.zstd');
  const preMigrationBytes = makeFakeZstdBytes('pre-migration-v1');
  fs.writeFileSync(zstdPath, preMigrationBytes);

  const mock = makeMockBackend(sessionId, zstdPath, { liveWriter: true });
  let liveSession = {
    id: sessionId,
    seq: 5,
    header: { version: 4, id: sessionId, createdAt: 1, isSeeded: false, delegationDepth: 0 },
    surface: { nodes: [0, 1], replaceGeneration: 0 },
  };
  const sessions = {
    get: (id) => (liveSession && id === sessionId ? liveSession : null),
    async flush() {},
  };

  const created = await createSessionBackup(ws.backupStore, {
    session: liveSession,
    sessions,
    backend: mock.backend,
    stateStore: ws.stateStore,
    reason: 'bili-migration',
  });

  // Simulate post-migration disk change while session is still live.
  const migratedBytes = makeFakeZstdBytes('post-migration-v2');
  fs.writeFileSync(zstdPath, migratedBytes);

  // Build a minimal StockTransactionAdapter instance (skipping host prototype fingerprint check by
  // constructing via prototype to exercise the exact recoverBeforeOpen + quarantine code paths).
  const adapter = Object.create(StockTransactionAdapter.prototype);
  adapter.backend = mock.backend;
  adapter.sessions = sessions;
  adapter.logger = { warn() {} };
  adapter.roots = new Map();
  adapter.backupStores = new Map();
  adapter.blocked = new Set();
  adapter.register(ws.journal, ws.stateStore, 3, ws.backupStore);

  // Request restore while session is LIVE -> Path B arms pending-restore.json and quarantines writer!
  const armed = await restoreSessionBackup(ws.backupStore, {
    sessionId,
    backupId: created.backupId,
    sessions,
    backend: mock.backend,
    stockAdapter: adapter,
  });

  assert.equal(armed.status, 'armed');
  assert.equal(armed.requiresReopen, true);
  assert.equal(adapter.blocked.has(sessionId), true);
  await assert.rejects(mock.writerHandle.persistContiguous(), /writer quarantined/);
  // Disk log NOT mutated yet while live!
  assert.deepEqual(fs.readFileSync(zstdPath), migratedBytes);
  // Pending restore record exists strictly inside Weave's backup dir, zero foreign files in DSH dir!
  const pending = readPendingRestore(ws.backupStore, sessionId);
  assert.ok(pending);
  assert.equal(pending.backupId, created.backupId);
  assert.equal(pending.encoding, 'zstd');
  assert.deepEqual(fs.readdirSync(ws.dshSessionDir), ['session.v4.jsonl.zstd']);

  // Calling recoverBeforeOpen while still live must refuse!
  await assert.rejects(adapter.recoverBeforeOpen(sessionId), /live/);

  // Close/detach live session and writer -> simulate reopening via recoverBeforeOpen!
  liveSession = null;
  mock.backend.tracker.writers.delete(sessionId);
  await adapter.recoverBeforeOpen(sessionId);

  assert.deepEqual(fs.readFileSync(zstdPath), preMigrationBytes);
  assert.equal(readPendingRestore(ws.backupStore, sessionId), null);
  assert.equal(adapter.blocked.has(sessionId), false);
  assert.deepEqual(fs.readdirSync(ws.dshSessionDir), ['session.v4.jsonl.zstd']);
});

await test('unflushed-live-writer-rejected-and-sibling-backup-root-auto-discovered', async () => {
  const ws = makeTempWorkspace('unflushed');
  const sessionId = 'sess-unflushed-1';
  const zstdPath = join(ws.dshSessionDir, 'session.v4.jsonl.zstd');
  const v1Bytes = makeFakeZstdBytes('v1');
  fs.writeFileSync(zstdPath, v1Bytes);

  const mock = makeMockBackend(sessionId, zstdPath, { liveWriter: true });
  mock.writerHandle.buffered.push({ seq: 5 });
  const session = {
    id: sessionId,
    seq: 5,
    header: { version: 4, id: sessionId, createdAt: 1, isSeeded: false, delegationDepth: 0 },
    surface: { nodes: [0], replaceGeneration: 0 },
  };
  await assert.rejects(
    createSessionBackup(ws.backupStore, {
      session,
      backend: mock.backend,
      reason: 'bili-migration',
    }),
    (err) => err.code === 'BILI_BACKUP_FAILED',
  );

  // Clear buffered -> backup succeeds; then arm Path B and verify recoverBeforeOpen discovers
  // sibling `<storage>/backups` automatically when only `register(journal, state, 3)` was called.
  mock.writerHandle.buffered.length = 0;
  const created = await createSessionBackup(ws.backupStore, {
    session,
    backend: mock.backend,
    stateStore: ws.stateStore,
    reason: 'bili-migration',
  });
  fs.writeFileSync(zstdPath, makeFakeZstdBytes('v2-mutated'));

  let live = session;
  const sessions = { get: (id) => (live && id === sessionId ? live : null) };
  const adapter = Object.create(StockTransactionAdapter.prototype);
  adapter.backend = mock.backend;
  adapter.sessions = sessions;
  adapter.logger = { warn() {} };
  adapter.roots = new Map();
  adapter.backupStores = new Map();
  adapter.blocked = new Set();
  // 3-arg legacy register call WITHOUT explicit backupStore:
  adapter.register(ws.journal, ws.stateStore, 3);

  const armed = await restoreSessionBackup(ws.backupStore, {
    sessionId,
    backupId: created.backupId,
    sessions,
    backend: mock.backend,
    stockAdapter: adapter,
  });
  assert.equal(armed.status, 'armed');

  live = null;
  mock.backend.tracker.writers.delete(sessionId);
  await adapter.recoverBeforeOpen(sessionId);
  assert.deepEqual(fs.readFileSync(zstdPath), v1Bytes);
  assert.equal(readPendingRestore(ws.backupStore, sessionId), null);
});

await test('list-backups-returns-newest-first-and-applyPendingRestoreBeforeOpen-noop-when-empty', async () => {
  const ws = makeTempWorkspace('list');
  const sessionId = 'sess-list-1';
  const logPath = join(ws.dshSessionDir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(logPath, makeFakeZstdBytes('snap-1'));
  const b1 = await createSessionBackup(ws.backupStore, { sessionId, logPath, reason: 'manual' });
  fs.writeFileSync(logPath, makeFakeZstdBytes('snap-2'));
  const b2 = await createSessionBackup(ws.backupStore, { sessionId, logPath, reason: 'bili-migration' });

  const list = listSessionBackups(ws.backupStore, sessionId);
  assert.equal(list.length, 2);
  assert.equal(list[0].backupId, b2.backupId);
  assert.equal(list[1].backupId, b1.backupId);
  assert.equal(list[0].present, true);
  assert.equal(list[0].encoding, 'zstd');

  const noop = await applyPendingRestoreBeforeOpen(ws.backupStore, sessionId, {});
  assert.equal(noop, null);
});

await test('summarizeBackups-pins-baseline-reuses-identical-sha-and-defaults-restore-to-original', async () => {
  const ws = makeTempWorkspace('baseline');
  const sessionId = 'sess-baseline-1';
  const logPath = join(ws.dshSessionDir, 'session.v4.jsonl.zstd');
  const bytesOriginal = makeFakeZstdBytes('clean-pre-migration-1173');
  const bytesPartial = makeFakeZstdBytes('partial-retry-962');
  fs.writeFileSync(logPath, bytesOriginal);

  const sessionClean = {
    id: sessionId,
    seq: 1173,
    header: { version: 4, id: sessionId, createdAt: 1, isSeeded: false, delegationDepth: 0 },
    surface: { nodes: Array.from({ length: 1173 }, (_, i) => i), replaceGeneration: 0 },
  };
  const b1 = await createSessionBackup(ws.backupStore, {
    session: sessionClean,
    logPath,
    reason: 'bili-migration',
    reuseIdentical: true,
  });
  assert.equal(b1.manifest.isBaseline, true);
  assert.equal(b1.manifest.source.surfaceNodeCount, 1173);

  // Identical-SHA call reuses b1 without creating a duplicate backup
  const b1Reused = await createSessionBackup(ws.backupStore, {
    session: sessionClean,
    logPath,
    reason: 'bili-migration',
    reuseIdentical: true,
  });
  assert.equal(b1Reused.reused, true);
  assert.equal(b1Reused.backupId, b1.backupId);
  assert.equal(listSessionBackups(ws.backupStore, sessionId).length, 1);

  // Simulate partial migration -> second backup must NOT be baseline and MUST NOT clobber originalBackupId
  fs.writeFileSync(logPath, bytesPartial);
  const sessionPartial = {
    id: sessionId,
    seq: 1200,
    header: { version: 4, id: sessionId, createdAt: 1, isSeeded: false, delegationDepth: 0 },
    surface: { nodes: Array.from({ length: 962 }, (_, i) => i), replaceGeneration: 12 },
  };
  const b2 = await createSessionBackup(ws.backupStore, {
    session: sessionPartial,
    logPath,
    reason: 'bili-migration',
    reuseIdentical: true,
  });
  assert.equal(b2.reused, undefined);
  assert.equal(b2.manifest.isBaseline, false);

  const summary = summarizeBackups(ws.backupStore, sessionId);
  assert.equal(summary.count, 2);
  assert.equal(summary.originalBackupId, b1.backupId);
  assert.equal(summary.latestBackupId, b2.backupId);
  assert.equal(summary.backupPath, b1.backupPath);
  assert.equal(summary.items.length, 2);
  assert.equal(summary.items.find((x) => x.backupId === b1.backupId).isBaseline, true);
  assert.equal(summary.items.find((x) => x.backupId === b1.backupId).surfaceNodeCount, 1173);
  assert.equal(summary.items.find((x) => x.backupId === b2.backupId).isBaseline, false);
  assert.equal(summary.items.find((x) => x.backupId === b2.backupId).surfaceNodeCount, 962);

  // Default restore (no backupId) restores clean original baseline b1, NOT b2!
  fs.writeFileSync(logPath, makeFakeZstdBytes('broken-live'));
  const restored = await restoreSessionBackup(ws.backupStore, { sessionId, logPath });
  assert.equal(restored.backupId, b1.backupId);
  assert.deepEqual(fs.readFileSync(logPath), bytesOriginal);
});

console.log(
  JSON.stringify(
    {
      passed: results.filter((r) => r.pass).length,
      failed: results.filter((r) => !r.pass).length,
      results,
    },
    null,
    2,
  ),
);
if (results.some((r) => !r.pass)) process.exitCode = 1;
