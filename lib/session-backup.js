// Atomic, SHA-256 verified full-session backup and restore for DSH sessions.
//
// Persistence safety invariants (verified against @deepseek-ai/dsh-session-persistence-jsonl):
// 1. Default DSH physical encoding is Zstandard (`session.v4.jsonl.zstd`), NOT plaintext `.jsonl`.
//    Backups ALWAYS copy exact raw bytes without re-encoding or line-parsing, and preserve exact
//    `rawLogFilename` + `encoding` ('zstd' | 'none').
// 2. NEVER write safety copies (`pre-restore-*`) or backup artifacts inside DSH's own session
//    directory (`resolveGenerationInDirectory` / `listSessionDirs` reject foreign `.jsonl`/`.zstd`
//    files). All backups, pending-restore markers, and pre-restore safety copies stay strictly
//    inside Weave's own `<storage>/backups/s-<sha256(sessionId)>/` directory.
// 3. Live DSH `Session` is strictly append-only in memory and `JsonlSessionHandle` enforces
//    monotonic `observedLength`. Restoring a live session MUST arm `pending-restore.json` +
//    quarantine the live writer so `StockTransactionAdapter.recoverBeforeOpen` applies the
//    verified backup atomically on the next write open.
import * as fs from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { atomicReplaceSync } from './atomic-replace.js';
import { sessionDirectory } from './storage-path.js';
import { PLUGIN_VERSION } from './version.js';

const ROOT_DIR_NAME = 'dsh-compaction-weave';
const BACKUP_DIR_NAME = 'backups';
const MANIFEST_KIND = 'compaction-weave/session-backup';
const PENDING_RESTORE_KIND = 'compaction-weave/pending-restore';
const FORMAT_VERSION = 1;
const COPY_CHUNK_BYTES = 1024 * 1024;
const GENERATION_FILENAME_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]{1,160}$/;

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.dsh');
}

export function defaultBackupRoot() {
  return join(dshHome(), 'storages', ROOT_DIR_NAME, BACKUP_DIR_NAME);
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function makeError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function timestampSlug(now = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}

function generateBackupId(now = new Date()) {
  return `bkp-${timestampSlug(now)}-${randomBytes(4).toString('hex')}`;
}

function encodingOfFilename(filename) {
  return typeof filename === 'string' && filename.endsWith('.zstd') ? 'zstd' : 'none';
}

function formatVersionOfFilename(filename, fallback = null) {
  if (typeof filename !== 'string') return fallback;
  const match = GENERATION_FILENAME_RE.exec(filename);
  if (!match) return fallback;
  return match[1] === undefined ? 0 : Number(match[1]);
}

function isSafeFilename(name) {
  return (
    typeof name === 'string' &&
    SAFE_SEGMENT_RE.test(name) &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\')
  );
}

function fileDigestSync(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(COPY_CHUNK_BYTES);
  let bytes = 0;
  try {
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, bytes);
      if (!read) break;
      hash.update(chunk.subarray(0, read));
      bytes += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { bytes, sha256: hash.digest('hex') };
}

function copySynced(sourcePath, destinationPath) {
  const input = fs.openSync(sourcePath, 'r');
  const buffer = Buffer.alloc(COPY_CHUNK_BYTES);
  const hash = createHash('sha256');
  let output;
  let position = 0;
  try {
    output = fs.openSync(destinationPath, 'wx', 0o600);
    for (;;) {
      const size = fs.readSync(input, buffer, 0, buffer.length, position);
      if (!size) break;
      hash.update(buffer.subarray(0, size));
      let written = 0;
      while (written < size) {
        written += fs.writeSync(output, buffer, written, size - written, position + written);
      }
      position += size;
    }
    fs.fsyncSync(output);
  } finally {
    if (output !== undefined) fs.closeSync(output);
    fs.closeSync(input);
  }
  return { bytes: position, sha256: hash.digest('hex') };
}

function writeAtomicJsonSync(targetPath, payload) {
  fs.mkdirSync(dirname(targetPath), { recursive: true });
  const serialized = JSON.stringify(payload, null, 2) + '\n';
  const temp = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, serialized, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    atomicReplaceSync(temp, targetPath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
  return {
    bytes: Buffer.byteLength(serialized, 'utf8'),
    sha256: sha256Hex(serialized),
  };
}

function appendSyncedLineSync(filePath, record) {
  fs.mkdirSync(dirname(filePath), { recursive: true });
  const line = JSON.stringify(record) + '\n';
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeFileSync(fd, line, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function atomicRestoreTargetFile(targetPath, backupRawLogPath) {
  // Temp file lives only for the duration of the atomic rename and is always
  // cleaned up in `finally` so zero foreign files remain in DSH's session dir.
  fs.mkdirSync(dirname(targetPath), { recursive: true });
  const temp = `${targetPath}.weave-restore-${randomUUID()}.tmp`;
  try {
    copySynced(backupRawLogPath, temp);
    atomicReplaceSync(temp, targetPath);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
}

function manifestBodyWithoutDigest(manifest) {
  const { manifestSha256: _ignored, ...rest } = manifest;
  return rest;
}

function computeManifestSha256(manifest) {
  return sha256Hex(JSON.stringify(manifestBodyWithoutDigest(manifest)));
}

function pendingRestoreBodyWithoutChecksum(record) {
  const { checksum: _ignored, ...rest } = record;
  return rest;
}

function computePendingRestoreChecksum(record) {
  return sha256Hex(JSON.stringify(pendingRestoreBodyWithoutChecksum(record)));
}

async function resolveSessionLogPath({ session, sessionId, backend, sessionPersistence, logPath, signal }) {
  if (typeof logPath === 'string' && logPath.length > 0) {
    return resolve(logPath);
  }
  const id = sessionId ?? session?.id;
  if (backend && session?.header && typeof backend.locate === 'function') {
    const located = backend.locate(session.header);
    if (located?.kind === 'jsonl' && typeof located.path === 'string' && fs.existsSync(located.path)) {
      return resolve(located.path);
    }
  }
  if (backend && id && typeof backend.findLog === 'function') {
    const selected = await backend.findLog(id, signal);
    const candidate = selected?.sourcePath ?? selected?.currentPath;
    if (typeof candidate === 'string' && candidate.length > 0) {
      return resolve(candidate);
    }
  }
  if (sessionPersistence && id && typeof sessionPersistence.stat === 'function') {
    const st = await sessionPersistence.stat(id, signal ? { signal } : undefined);
    if (st?.location?.kind === 'jsonl' && typeof st.location.path === 'string') {
      return resolve(st.location.path);
    }
  }
  if (backend && session?.header && typeof backend.locate === 'function') {
    const located = backend.locate(session.header);
    if (located?.kind === 'jsonl' && typeof located.path === 'string') {
      return resolve(located.path);
    }
  }
  return null;
}

function safeCloneHeader(header) {
  if (!header || typeof header !== 'object') return null;
  try {
    return JSON.parse(JSON.stringify(header));
  } catch {
    return null;
  }
}

function clearDirectoryFilesSync(dirPath) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const name of entries) {
    const full = join(dirPath, name);
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {}
  }
  return removed;
}

function syncWeaveAuxStateOnRestore(store, sessionId, backupDir, manifest, options = {}) {
  const storageBase = dirname(store.root);

  // 1. Restore or clear weave-state.json in SessionStateStore.
  const stateStore = options.stateStore;
  const stateTarget =
    stateStore && typeof stateStore.file === 'function'
      ? stateStore.file(sessionId)
      : options.stateRoot
        ? join(resolve(options.stateRoot), `${sha256Hex(sessionId)}.json`)
        : null;

  if (stateTarget) {
    if (manifest.files.weaveState) {
      const backupStatePath = join(backupDir, manifest.files.weaveState.filename);
      fs.mkdirSync(dirname(stateTarget), { recursive: true });
      const temp = `${stateTarget}.${process.pid}.${randomUUID()}.tmp`;
      try {
        copySynced(backupStatePath, temp);
        atomicReplaceSync(temp, stateTarget);
      } finally {
        try {
          fs.unlinkSync(temp);
        } catch {}
      }
    } else {
      try {
        fs.unlinkSync(stateTarget);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }

  // 2. Clear stale journal entries for this session.
  const journalDir =
    options.journal && typeof options.journal.dirFor === 'function'
      ? options.journal.dirFor(sessionId)
      : join(options.journalRoot ? resolve(options.journalRoot) : join(storageBase, 'journal'), `s-${sha256Hex(sessionId)}`);
  clearDirectoryFilesSync(journalDir);

  // 3. Clear stale continuation-progress entries (ContinuationProgressStore uses raw sha256 dir).
  const contBase = options.continuationProgressRoot
    ? resolve(options.continuationProgressRoot)
    : join(storageBase, 'continuation-progress');
  const sessionHash = sha256Hex(sessionId);
  clearDirectoryFilesSync(join(contBase, sessionHash));
  clearDirectoryFilesSync(join(contBase, `s-${sessionHash}`));
}

export class SessionBackupStore {
  /** @param {{ root?: string | null }} [options] */
  constructor(options = {}) {
    this.root = options.root ? resolve(options.root) : defaultBackupRoot();
  }

  static alongside(archiveRoot) {
    if (typeof archiveRoot !== 'string' || archiveRoot.length === 0) {
      return new SessionBackupStore({});
    }
    return new SessionBackupStore({ root: join(dirname(archiveRoot), BACKUP_DIR_NAME) });
  }

  dirFor(sessionId) {
    return sessionDirectory(this.root, sessionId, 'backup');
  }

  backupDir(sessionId, backupId) {
    if (!isSafeFilename(backupId)) {
      throw makeError('BACKUP_ID_INVALID', `Invalid backup id: ${String(backupId)}`);
    }
    return join(this.dirFor(sessionId), backupId);
  }

  pendingRestoreFile(sessionId) {
    return join(this.dirFor(sessionId), 'pending-restore.json');
  }

  indexFile(sessionId) {
    return join(this.dirFor(sessionId), 'index.jsonl');
  }

  create(options) {
    return createSessionBackup(this, options);
  }

  verify(sessionId, backupId, options) {
    return verifySessionBackup(this, sessionId, backupId, options);
  }

  list(sessionId) {
    return listSessionBackups(this, sessionId);
  }

  restore(options) {
    return restoreSessionBackup(this, options);
  }

  readPendingRestore(sessionId) {
    return readPendingRestore(this, sessionId);
  }

  applyPendingRestoreBeforeOpen(sessionId, options) {
    return applyPendingRestoreBeforeOpen(this, sessionId, options);
  }
}

/**
 * Create and independently SHA-256 verify an atomic full-session backup.
 * Copies raw bytes (works transparently for `.v4.jsonl.zstd` and `.v4.jsonl`),
 * writes surface snapshot + weave-state + manifest strictly inside Weave's backup dir,
 * and never writes any file into DSH's session directory.
 */
export async function createSessionBackup(store, options = {}) {
  const backupStore = store instanceof SessionBackupStore ? store : new SessionBackupStore(store);
  const {
    session,
    sessions,
    backend,
    sessionPersistence,
    stateStore,
    stateRoot,
    logPath,
    reason = 'manual',
    signal,
  } = options;

  const sessionId = options.sessionId ?? session?.id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw makeError('BILI_BACKUP_FAILED', 'Session backup requires a non-empty sessionId.');
  }

  signal?.throwIfAborted();

  // Flush buffered events (and materialize unmaterialized sessions) before copying raw log.
  if (session && sessions && typeof sessions.flush === 'function') {
    await sessions.flush(session);
  }
  signal?.throwIfAborted();

  const resolvedPath = await resolveSessionLogPath({
    session,
    sessionId,
    backend,
    sessionPersistence,
    logPath,
    signal,
  });
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    throw makeError(
      'BILI_BACKUP_FAILED',
      `Session log file could not be located on disk for session "${sessionId}".`,
    );
  }

  const rawLogFilename = basename(resolvedPath);
  if (!isSafeFilename(rawLogFilename)) {
    throw makeError('BILI_BACKUP_FAILED', `Unsafe session log filename: ${rawLogFilename}`);
  }
  const encoding = encodingOfFilename(rawLogFilename);
  const formatVersion = formatVersionOfFilename(rawLogFilename, session?.header?.version ?? null);

  const performCopy = () => {
    signal?.throwIfAborted();
    const writer = backend?.tracker?.writers?.get?.(sessionId);
    if (writer && session) {
      if (
        (typeof writer.state?.cursor === 'number' &&
          typeof session.seq === 'number' &&
          writer.state.cursor !== session.seq) ||
        (Array.isArray(writer.buffered) && writer.buffered.length > 0)
      ) {
        throw makeError(
          'BILI_BACKUP_FAILED',
          'Live session has unflushed events; flush or wait until idle before backing up.',
        );
      }
    }

    const sessionDir = backupStore.dirFor(sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    let backupId;
    let backupDir;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      backupId = generateBackupId();
      backupDir = backupStore.backupDir(sessionId, backupId);
      try {
        fs.mkdirSync(backupDir, { mode: 0o700 });
        break;
      } catch (error) {
        if (error?.code === 'EEXIST') continue;
        throw error;
      }
    }

    const rawBackupPath = join(backupDir, rawLogFilename);
    const statBefore = fs.statSync(resolvedPath);
    const copiedRaw = copySynced(resolvedPath, rawBackupPath);
    const statAfter = fs.statSync(resolvedPath);
    const stable =
      statBefore.size === copiedRaw.bytes &&
      statAfter.size === copiedRaw.bytes &&
      statBefore.mtimeMs === statAfter.mtimeMs;
    if (!stable) {
      const liveDigest = fileDigestSync(resolvedPath);
      if (liveDigest.sha256 !== copiedRaw.sha256 || liveDigest.bytes !== copiedRaw.bytes) {
        try {
          fs.rmSync(backupDir, { recursive: true, force: true });
        } catch {}
        throw makeError(
          'BILI_BACKUP_FAILED',
          'Session log changed concurrently while creating backup; retry once idle.',
        );
      }
    }

    // Save surface metadata snapshot (non-authoritative diagnostic & inspection record).
    let surfaceSnapshotMeta = null;
    if (session && typeof session === 'object') {
      const snapshotFilename = 'surface-snapshot.json';
      const snapshotPayload = {
        seq: typeof session.seq === 'number' ? session.seq : null,
        nodes: Array.isArray(session.surface?.nodes) ? [...session.surface.nodes] : [],
        replaceGeneration: session.surface?.replaceGeneration ?? 0,
        header: safeCloneHeader(session.header),
      };
      const snap = writeAtomicJsonSync(join(backupDir, snapshotFilename), snapshotPayload);
      surfaceSnapshotMeta = { filename: snapshotFilename, bytes: snap.bytes, sha256: snap.sha256 };
    }

    // Copy Weave's per-session state file if present.
    let weaveStateMeta = null;
    const stateFilePath =
      stateStore && typeof stateStore.file === 'function'
        ? stateStore.file(sessionId)
        : stateRoot
          ? join(resolve(stateRoot), `${sha256Hex(sessionId)}.json`)
          : null;
    if (stateFilePath && fs.existsSync(stateFilePath)) {
      const stateFilename = 'weave-state.json';
      const copiedState = copySynced(stateFilePath, join(backupDir, stateFilename));
      weaveStateMeta = {
        filename: stateFilename,
        bytes: copiedState.bytes,
        sha256: copiedState.sha256,
      };
    }

    const createdAt = new Date().toISOString();
    const manifestBase = {
      kind: MANIFEST_KIND,
      version: FORMAT_VERSION,
      backupId,
      sessionId,
      reason: String(reason),
      createdAt,
      pluginVersion: PLUGIN_VERSION,
      source: {
        kind: 'jsonl',
        logPath: resolvedPath,
        rawLogFilename,
        encoding,
        formatVersion,
        eventCount: typeof session?.seq === 'number' ? session.seq : null,
        surfaceNodeCount: Array.isArray(session?.surface?.nodes) ? session.surface.nodes.length : null,
        replaceGeneration: session?.surface?.replaceGeneration ?? null,
        header: safeCloneHeader(session?.header),
      },
      files: {
        rawLog: {
          filename: rawLogFilename,
          bytes: copiedRaw.bytes,
          sha256: copiedRaw.sha256,
        },
        surfaceSnapshot: surfaceSnapshotMeta,
        weaveState: weaveStateMeta,
      },
    };
    const manifest = {
      ...manifestBase,
      manifestSha256: computeManifestSha256(manifestBase),
    };

    const manifestPath = join(backupDir, 'manifest.json');
    writeAtomicJsonSync(manifestPath, manifest);

    appendSyncedLineSync(backupStore.indexFile(sessionId), {
      backupId,
      sessionId,
      reason: manifest.reason,
      createdAt,
      encoding,
      rawLogFilename,
      bytes: copiedRaw.bytes,
      sha256: copiedRaw.sha256,
      logPath: resolvedPath,
    });

    return {
      backupId,
      backupDir,
      backupPath: rawBackupPath,
      manifestPath,
      manifest,
      expectedSha256: copiedRaw.sha256,
    };
  };

  const liveWriter = backend?.tracker?.writers?.get?.(sessionId);
  const created =
    liveWriter && typeof liveWriter.run === 'function'
      ? await liveWriter.run('weave-backup', performCopy)
      : performCopy();

  // Independent re-verification BEFORE returning success (mandatory gate).
  const verified = verifySessionBackup(backupStore, sessionId, created.backupId, {
    expectedSourcePath: resolvedPath,
    expectedSourceSha256: created.expectedSha256,
    verifyTargetDigest: true,
  });
  if (!verified.ok) {
    throw makeError(
      'BACKUP_VERIFICATION_FAILED',
      `Backup verification failed after creation (${verified.code}): ${verified.reason}`,
      { failureCode: 'BILI_BACKUP_FAILED', backupId: created.backupId },
    );
  }

  return {
    ok: true,
    backupId: created.backupId,
    backupDir: created.backupDir,
    backupPath: created.backupPath,
    manifestPath: created.manifestPath,
    manifest: verified.manifest,
  };
}

/**
 * Independently verify a stored session backup's manifest digest, raw log SHA-256,
 * encoding/filename integrity, and companion snapshot/state digests.
 */
export function verifySessionBackup(store, sessionId, backupId, options = {}) {
  const backupStore = store instanceof SessionBackupStore ? store : new SessionBackupStore(store);
  if (typeof sessionId !== 'string' || !sessionId) {
    return { ok: false, code: 'BACKUP_INVALID_SESSION', reason: 'Missing sessionId.' };
  }
  if (!isSafeFilename(backupId)) {
    return { ok: false, code: 'BACKUP_ID_INVALID', reason: 'Invalid backupId.' };
  }

  const backupDir = backupStore.backupDir(sessionId, backupId);
  const manifestPath = join(backupDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      code: error?.code === 'ENOENT' ? 'BACKUP_NOT_FOUND' : 'BACKUP_MANIFEST_UNREADABLE',
      reason: `Manifest unreadable: ${error?.message ?? error}`,
    };
  }

  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest.kind !== MANIFEST_KIND ||
    manifest.version !== FORMAT_VERSION ||
    manifest.sessionId !== sessionId ||
    manifest.backupId !== backupId
  ) {
    return { ok: false, code: 'BACKUP_MANIFEST_INVALID', reason: 'Manifest identity mismatch.' };
  }

  if (
    typeof manifest.manifestSha256 !== 'string' ||
    manifest.manifestSha256 !== computeManifestSha256(manifest)
  ) {
    return {
      ok: false,
      code: 'BACKUP_MANIFEST_TAMPERED',
      reason: 'Manifest SHA-256 checksum mismatch.',
    };
  }

  const rawFile = manifest.files?.rawLog;
  const rawFilename = rawFile?.filename;
  const encoding = manifest.source?.encoding;
  if (
    !isSafeFilename(rawFilename) ||
    rawFilename !== manifest.source?.rawLogFilename ||
    (encoding !== 'zstd' && encoding !== 'none') ||
    encodingOfFilename(rawFilename) !== encoding
  ) {
    return {
      ok: false,
      code: 'BACKUP_ENCODING_MISMATCH',
      reason: 'Backup raw log filename disagrees with declared encoding.',
    };
  }

  const rawLogPath = join(backupDir, rawFilename);
  let actualRaw;
  try {
    actualRaw = fileDigestSync(rawLogPath);
  } catch (error) {
    return {
      ok: false,
      code: 'BACKUP_RAW_MISSING',
      reason: `Backup raw log unreadable: ${error?.message ?? error}`,
    };
  }

  if (actualRaw.bytes !== rawFile.bytes || actualRaw.sha256 !== rawFile.sha256) {
    return {
      ok: false,
      code: 'BACKUP_CHECKSUM_MISMATCH',
      reason: 'Backup raw log SHA-256 or byte size mismatch.',
    };
  }

  // Verify optional companion files when declared in manifest.
  for (const key of ['surfaceSnapshot', 'weaveState']) {
    const entry = manifest.files?.[key];
    if (!entry) continue;
    if (!isSafeFilename(entry.filename)) {
      return { ok: false, code: 'BACKUP_MANIFEST_INVALID', reason: `Unsafe ${key} filename.` };
    }
    let actual;
    try {
      actual = fileDigestSync(join(backupDir, entry.filename));
    } catch (error) {
      return {
        ok: false,
        code: 'BACKUP_COMPANION_MISSING',
        reason: `Backup ${key} unreadable: ${error?.message ?? error}`,
      };
    }
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      return {
        ok: false,
        code: 'BACKUP_COMPANION_TAMPERED',
        reason: `Backup ${key} SHA-256 mismatch.`,
      };
    }
  }

  // Optional target checks (encoding/basename match and live digest match).
  if (typeof options.expectedSourcePath === 'string' && options.expectedSourcePath.length > 0) {
    const targetName = basename(options.expectedSourcePath);
    if (targetName !== rawFilename || encodingOfFilename(targetName) !== encoding) {
      return {
        ok: false,
        code: 'BACKUP_ENCODING_MISMATCH',
        reason: `Target "${targetName}" does not match backup "${rawFilename}" (${encoding}).`,
      };
    }
    if (options.verifyTargetDigest === true) {
      let targetDigest;
      try {
        targetDigest = fileDigestSync(options.expectedSourcePath);
      } catch (error) {
        return {
          ok: false,
          code: 'BACKUP_TARGET_UNREADABLE',
          reason: `Target log unreadable during verification: ${error?.message ?? error}`,
        };
      }
      if (targetDigest.sha256 !== rawFile.sha256 || targetDigest.bytes !== rawFile.bytes) {
        return {
          ok: false,
          code: 'BACKUP_TARGET_DIVERGED',
          reason: 'Target log bytes diverged from backup immediately after creation.',
        };
      }
    }
  }

  if (
    typeof options.expectedSourceSha256 === 'string' &&
    rawFile.sha256 !== options.expectedSourceSha256
  ) {
    return {
      ok: false,
      code: 'BACKUP_CHECKSUM_MISMATCH',
      reason: 'Backup raw log SHA-256 does not match expected digest.',
    };
  }

  return {
    ok: true,
    backupId,
    backupDir,
    rawLogPath,
    manifest,
  };
}

/**
 * List available backups for a session, newest first.
 */
export function listSessionBackups(store, sessionId) {
  const backupStore = store instanceof SessionBackupStore ? store : new SessionBackupStore(store);
  if (typeof sessionId !== 'string' || !sessionId) return [];
  const dir = backupStore.dirFor(sessionId);
  const byId = new Map();

  // Read append-only ledger first.
  try {
    const raw = fs.readFileSync(backupStore.indexFile(sessionId), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (entry?.sessionId === sessionId && isSafeFilename(entry?.backupId)) {
          const bDir = backupStore.backupDir(sessionId, entry.backupId);
          const rawPath = isSafeFilename(entry.rawLogFilename)
            ? join(bDir, entry.rawLogFilename)
            : null;
          byId.set(entry.backupId, {
            backupId: entry.backupId,
            sessionId,
            reason: entry.reason ?? 'unknown',
            createdAt: entry.createdAt ?? null,
            encoding: entry.encoding ?? encodingOfFilename(entry.rawLogFilename),
            rawLogFilename: entry.rawLogFilename ?? null,
            bytes: entry.bytes ?? null,
            sha256: entry.sha256 ?? null,
            backupDir: bDir,
            backupPath: rawPath,
            logPath: entry.logPath ?? null,
            present: Boolean(rawPath && fs.existsSync(rawPath) && fs.existsSync(join(bDir, 'manifest.json'))),
          });
        }
      } catch {}
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  // Also scan session backup directory for any manifest not yet in index.jsonl.
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const dirent of entries) {
    if (!dirent.isDirectory() || !dirent.name.startsWith('bkp-') || !isSafeFilename(dirent.name)) {
      continue;
    }
    if (byId.has(dirent.name)) continue;
    const bDir = join(dir, dirent.name);
    const manifestPath = join(bDir, 'manifest.json');
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (m?.kind !== MANIFEST_KIND || m.sessionId !== sessionId || m.backupId !== dirent.name) {
        continue;
      }
      const rawFilename = m.files?.rawLog?.filename ?? null;
      const rawPath = isSafeFilename(rawFilename) ? join(bDir, rawFilename) : null;
      byId.set(dirent.name, {
        backupId: dirent.name,
        sessionId,
        reason: m.reason ?? 'unknown',
        createdAt: m.createdAt ?? null,
        encoding: m.source?.encoding ?? encodingOfFilename(rawFilename),
        rawLogFilename: rawFilename,
        bytes: m.files?.rawLog?.bytes ?? null,
        sha256: m.files?.rawLog?.sha256 ?? null,
        backupDir: bDir,
        backupPath: rawPath,
        logPath: m.source?.logPath ?? null,
        present: Boolean(rawPath && fs.existsSync(rawPath)),
      });
    } catch {}
  }

  return [...byId.values()].sort((a, b) =>
    String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) ||
    b.backupId.localeCompare(a.backupId),
  );
}

/**
 * Read and validate an armed `pending-restore.json` record for a session, or `null` if none.
 */
export function readPendingRestore(store, sessionId) {
  const backupStore = store instanceof SessionBackupStore ? store : new SessionBackupStore(store);
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const file = backupStore.pendingRestoreFile(sessionId);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw makeError('BACKUP_RESTORE_INVALID', `Pending restore record unreadable: ${error?.message ?? error}`);
  }
  if (
    !record ||
    typeof record !== 'object' ||
    record.kind !== PENDING_RESTORE_KIND ||
    record.version !== FORMAT_VERSION ||
    record.sessionId !== sessionId ||
    !isSafeFilename(record.backupId) ||
    !isSafeFilename(record.rawLogFilename) ||
    (record.encoding !== 'zstd' && record.encoding !== 'none') ||
    typeof record.expectedSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.expectedSha256) ||
    typeof record.checksum !== 'string' ||
    record.checksum !== computePendingRestoreChecksum(record)
  ) {
    throw makeError('BACKUP_RESTORE_INVALID', 'Pending restore record failed integrity validation.');
  }
  return record;
}

function writePendingRestoreSync(backupStore, sessionId, { backupId, manifest, targetPath }) {
  const base = {
    kind: PENDING_RESTORE_KIND,
    version: FORMAT_VERSION,
    sessionId,
    backupId,
    expectedSha256: manifest.files.rawLog.sha256,
    rawLogFilename: manifest.source.rawLogFilename,
    encoding: manifest.source.encoding,
    targetPath,
    requestedAt: new Date().toISOString(),
  };
  const record = { ...base, checksum: computePendingRestoreChecksum(base) };
  writeAtomicJsonSync(backupStore.pendingRestoreFile(sessionId), record);
  return record;
}

function clearPendingRestoreSync(backupStore, sessionId) {
  try {
    fs.unlinkSync(backupStore.pendingRestoreFile(sessionId));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function executeColdRestoreLocked(backupStore, sessionId, verified, targetPath, options = {}) {
  const { backend, signal } = options;
  const { manifest, backupDir, rawLogPath } = verified;

  const targetFilename = basename(targetPath);
  if (
    targetFilename !== manifest.source.rawLogFilename ||
    encodingOfFilename(targetFilename) !== manifest.source.encoding
  ) {
    throw makeError(
      'BACKUP_ENCODING_MISMATCH',
      `Refusing to restore "${manifest.source.rawLogFilename}" (${manifest.source.encoding}) onto "${targetFilename}".`,
    );
  }

  let lease = null;
  let claimed = false;
  if (backend?.tracker && typeof backend.tracker.claimWrite === 'function') {
    backend.tracker.claimWrite(sessionId);
    claimed = true;
  }

  try {
    signal?.throwIfAborted();
    if (backend && typeof backend.acquireLease === 'function') {
      lease = await backend.acquireLease(sessionId, undefined, dirname(targetPath));
    }
    signal?.throwIfAborted();

    // Save pre-restore safety copy STRICTLY inside Weave's own backup directory (NEVER in DSH's session dir!).
    let safetyCopyPath = null;
    if (fs.existsSync(targetPath)) {
      const safetyName = `pre-restore-${timestampSlug()}-${randomBytes(4).toString('hex')}-${targetFilename}`;
      safetyCopyPath = join(backupStore.dirFor(sessionId), safetyName);
      fs.mkdirSync(dirname(safetyCopyPath), { recursive: true });
      copySynced(targetPath, safetyCopyPath);
    }

    // Atomically replace target raw log and verify exact byte/SHA-256 match.
    atomicRestoreTargetFile(targetPath, rawLogPath);
    const postDigest = fileDigestSync(targetPath);
    if (
      postDigest.sha256 !== manifest.files.rawLog.sha256 ||
      postDigest.bytes !== manifest.files.rawLog.bytes
    ) {
      throw makeError(
        'BACKUP_VERIFICATION_FAILED',
        'Post-restore target file digest did not match verified backup SHA-256.',
      );
    }

    backend?.coldLogMemo?.delete?.(sessionId);
    syncWeaveAuxStateOnRestore(backupStore, sessionId, backupDir, manifest, options);
    clearPendingRestoreSync(backupStore, sessionId);

    return {
      status: 'restored',
      requiresReopen: false,
      backupId: verified.backupId,
      backupPath: rawLogPath,
      targetPath,
      safetyCopyPath,
    };
  } finally {
    try {
      await lease?.release?.();
    } finally {
      if (claimed) backend.tracker.releaseClaim(sessionId);
    }
  }
}

/**
 * Restore a session from a verified backup.
 * - Path A (session closed / offline): restores immediately under write claim + lease.
 * - Path B (session currently live in memory): arms `pending-restore.json` + quarantines live writer
 *   so `StockTransactionAdapter.recoverBeforeOpen` applies it atomically on next write open.
 */
export async function restoreSessionBackup(store, options = {}) {
  const backupStore = store instanceof SessionBackupStore ? store : new SessionBackupStore(store);
  const {
    sessionId,
    backupId,
    sessions,
    backend,
    sessionPersistence,
    stockAdapter,
    logPath,
    signal,
  } = options;

  if (typeof sessionId !== 'string' || !sessionId) {
    throw makeError('BACKUP_RESTORE_INVALID', 'Restore requires a non-empty sessionId.');
  }

  let resolvedBackupId = backupId;
  if (!resolvedBackupId) {
    const latest = listSessionBackups(backupStore, sessionId).find((b) => b.present);
    if (!latest) {
      throw makeError('BACKUP_NOT_FOUND', `No backup found for session "${sessionId}".`);
    }
    resolvedBackupId = latest.backupId;
  }

  // Step 1: Verify backup integrity BEFORE touching anything.
  const verified = verifySessionBackup(backupStore, sessionId, resolvedBackupId);
  if (!verified.ok) {
    throw makeError(
      verified.code === 'BACKUP_ENCODING_MISMATCH'
        ? 'BACKUP_ENCODING_MISMATCH'
        : 'BACKUP_VERIFICATION_FAILED',
      `Backup "${resolvedBackupId}" failed verification (${verified.code}): ${verified.reason}`,
    );
  }

  // Step 2: Resolve target path and enforce strict filename/encoding match.
  const targetPath =
    (await resolveSessionLogPath({
      session: sessions?.get?.(sessionId),
      sessionId,
      backend,
      sessionPersistence,
      logPath,
      signal,
    })) ?? verified.manifest.source.logPath;

  if (!targetPath) {
    throw makeError('BACKUP_RESTORE_INVALID', `Cannot determine target log path for session "${sessionId}".`);
  }

  const targetName = basename(targetPath);
  if (
    targetName !== verified.manifest.source.rawLogFilename ||
    encodingOfFilename(targetName) !== verified.manifest.source.encoding
  ) {
    throw makeError(
      'BACKUP_ENCODING_MISMATCH',
      `Cannot restore backup "${verified.manifest.source.rawLogFilename}" (${verified.manifest.source.encoding}) onto "${targetName}".`,
    );
  }

  // Step 3: Branch on whether the session is currently live.
  const liveSession = sessions?.get?.(sessionId);
  const liveWriter = backend?.tracker?.writers?.get?.(sessionId);
  const isLive = Boolean(liveSession || liveWriter);

  if (isLive) {
    writePendingRestoreSync(backupStore, sessionId, {
      backupId: resolvedBackupId,
      manifest: verified.manifest,
      targetPath,
    });
    if (stockAdapter && liveWriter && typeof stockAdapter.quarantine === 'function') {
      stockAdapter.quarantine(sessionId, liveWriter);
    }
    return {
      status: 'armed',
      requiresReopen: true,
      backupId: resolvedBackupId,
      backupPath: verified.rawLogPath,
      targetPath,
    };
  }

  // Path A: Cold/offline restore.
  return executeColdRestoreLocked(backupStore, sessionId, verified, targetPath, options);
}

/**
 * Execute an armed `pending-restore.json` before DSH opens the session for writing.
 * Called by `StockTransactionAdapter.recoverBeforeOpen(id, signal)`.
 */
export async function applyPendingRestoreBeforeOpen(store, sessionId, options = {}) {
  const backupStore = store instanceof SessionBackupStore ? store : new SessionBackupStore(store);
  const pending = readPendingRestore(backupStore, sessionId);
  if (!pending) return null;

  const { backend, sessions, signal, logger } = options;
  if (sessions?.get?.(sessionId) || backend?.tracker?.writers?.has?.(sessionId)) {
    throw makeError(
      'RECOVERY_REQUIRED',
      'Refusing pending backup restore while a session or writer is still live.',
    );
  }

  const verified = verifySessionBackup(backupStore, sessionId, pending.backupId, {
    expectedSourceSha256: pending.expectedSha256,
  });
  if (!verified.ok) {
    throw makeError(
      'BACKUP_VERIFICATION_FAILED',
      `Armed restore backup "${pending.backupId}" failed verification (${verified.code}): ${verified.reason}`,
    );
  }

  let targetPath = pending.targetPath;
  if (backend && typeof backend.findLog === 'function') {
    const selected = await backend.findLog(sessionId, signal);
    const candidate = selected?.sourcePath ?? selected?.currentPath;
    if (typeof candidate === 'string' && candidate.length > 0) {
      targetPath = resolve(candidate);
    }
  }
  if (!targetPath) {
    throw makeError(
      'RECOVERY_REQUIRED',
      `Armed restore target path unavailable for session "${sessionId}".`,
    );
  }

  const result = await executeColdRestoreLocked(
    backupStore,
    sessionId,
    verified,
    targetPath,
    options,
  );
  logger?.warn?.(
    `[compaction-weave] Restored session "${sessionId}" from verified backup ${pending.backupId} before opening.`,
  );
  return result;
}
