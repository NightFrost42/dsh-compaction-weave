// Stock-host transaction adapter inspired by reply-forge's instance-scoped
// persistence adaptation. No host file is changed and no custom Session event
// is emitted. Private JS seams are fingerprint-gated; unknown hosts refuse.
import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { HOST_FINGERPRINTS } from './transaction-host.js';
import { CompactionJournal } from './journal.js';
import { SessionStateStore } from './state.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const SAME = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const installed = new WeakMap();
function refuse(message) { const e = new Error(`Weave transaction adapter: ${message}`); e.code = 'RECOVERY_REQUIRED'; return e; }
function prototypeMethod(object, name) { return Object.getPrototypeOf(object)?.[name]; }
function checkMethods(object, group) {
  for (const [name, expected] of Object.entries(HOST_FINGERPRINTS[group])) {
    const fn = prototypeMethod(object, name);
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (typeof fn !== 'function' || !allowed.includes(digest(Function.prototype.toString.call(fn)))) throw refuse(`unsupported ${group}.${name}; host compatibility must be reviewed before compaction`);
  }
}
function fileDigest(file, limit = Infinity) {
  const fd = fs.openSync(file, 'r'), hash = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024);
  let position = 0;
  try {
    while (position < limit) {
      const size = fs.readSync(fd, chunk, 0, Math.min(chunk.length, limit - position), position);
      if (!size) break;
      hash.update(chunk.subarray(0, size)); position += size;
    }
  } finally { fs.closeSync(fd); }
  return { bytes: position, sha256: hash.digest('hex') };
}
function writeNew(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function copySynced(source, destination) {
  const input = fs.openSync(source, 'r'), buffer = Buffer.alloc(1024 * 1024);
  let output, position = 0;
  try {
    output = fs.openSync(destination, 'wx', 0o600);
    for (;;) {
      const size = fs.readSync(input, buffer, 0, buffer.length, position);
      if (!size) break;
      let written = 0;
      while (written < size) written += fs.writeSync(output, buffer, written, size - written, position + written);
      position += size;
    }
    fs.fsyncSync(output);
  } finally { if (output !== undefined) fs.closeSync(output); fs.closeSync(input); }
}
function atomicRestore(target, backup) {
  const temp = `${target}.weave-restore-${randomUUID()}.tmp`;
  try { copySynced(backup, temp); fs.renameSync(temp, target); }
  finally { try { fs.unlinkSync(temp); } catch {} }
}
function verifyFiles(target, record, journal) {
  const file = journal.fileFor(record.sessionId, record.compactionId), backup = file + '.rollback', tailFile = file + '.tail', meta = record.atomic;
  if (meta?.version !== 1 || !Number.isSafeInteger(meta.beforeBytes) || meta.beforeBytes < 1 || !Number.isSafeInteger(meta.beforeEvents) || meta.beforeEvents < 0 || !Number.isSafeInteger(meta.tailBytes) || meta.tailBytes < 1 || !/^[a-f0-9]{64}$/.test(meta.beforeHash ?? '') || !/^[a-f0-9]{64}$/.test(meta.tailHash ?? '')) throw refuse('invalid recovery manifest; preserving all files');
  const actual = fileDigest(backup), tail = fs.readFileSync(tailFile);
  if (actual.sha256 !== meta.beforeHash || actual.bytes !== meta.beforeBytes || digest(tail) !== meta.tailHash || tail.length !== meta.tailBytes) throw refuse('backup/tail integrity check failed');
  const size = fs.statSync(target).size;
  if (fileDigest(target, meta.beforeBytes).sha256 !== meta.beforeHash || size < meta.beforeBytes) throw refuse('stored prefix diverged; refusing to overwrite unrelated history');
  if (meta.restored === true) return { backup, tail, meta, size };
  if (meta.restored !== undefined) throw refuse('invalid restored marker');
  if (record.phase !== 'committed' && size > meta.beforeBytes + tail.length) throw refuse('newer history exists after the transaction; refusing to discard it');
  const trailing = Math.min(tail.length, size - meta.beforeBytes), fd = fs.openSync(target, 'r'), check = Buffer.alloc(trailing);
  try { let read = 0; while (read < check.length) { const n = fs.readSync(fd, check, read, check.length-read, meta.beforeBytes+read); if (!n) throw refuse('unexpected EOF'); read += n; } }
  finally { fs.closeSync(fd); }
  if (!check.equals(tail.subarray(0, trailing))) throw refuse('stored tail diverged; preserving unrelated changes');
  if (record.phase === 'committed' && trailing !== tail.length) throw refuse('durable success decision has an incomplete event tail');
  return { backup, tail, meta, size };
}

export class StockTransactionAdapter {
  constructor(backend, sessions, logger) {
    checkMethods(backend, 'backend');
    if (!(backend.tracker?.writers instanceof Map)) throw refuse('JSONL writer registry unavailable');
    this.backend = backend; this.sessions = sessions; this.logger = logger;
    this.roots = new Map(); this.blocked = new Set(); this.openOriginal = backend.open;
    this.openDescriptor = Object.getOwnPropertyDescriptor(backend, 'open');
    const adapter = this;
    this.openWrapper = async function(id, access, options) {
      if (access === 'write') await adapter.recoverBeforeOpen(id, options?.signal);
      return adapter.openOriginal.call(this, id, access, options);
    };
    backend.open = this.openWrapper;
  }
  register(journal, state, failureThreshold) {
    this.roots.set(resolve(journal.root), { journal, state, failureThreshold });
  }
  assertSupported(session) {
    checkMethods(session, 'session'); checkMethods(session.surface, 'surface');
    if (this.sessions.get(session.id) !== session) throw refuse('Session is not the current live owner');
    if (session.header.version !== 4 || typeof session.constructor.create !== 'function') throw refuse('unsupported Session format');
    const h = this.backend.tracker.writers.get(session.id);
    if (!h || h.id !== session.id || h.access !== 'write' || h.closing || !h.lease || !h.state?.materialized) throw refuse('live durable writer/lease unavailable');
    checkMethods(h, 'handle');
    if (session.commit !== prototypeMethod(session, 'commit') || session.publicationEntry !== prototypeMethod(session, 'publicationEntry')) throw refuse('Session publication is wrapped by another extension');
    if (this.blocked.has(session.id)) throw refuse('writer is quarantined until cold recovery');
    return h;
  }
  stage(session, build) {
    this.assertSupported(session);
    // Replaying via native commit avoids Session.create(seed)'s end-seed marker.
    const shadow = session.constructor.create(session.id);
    shadow.header = session.header; shadow.inheritedEventCount = session.inheritedEventCount;
    shadow.surfaceManager.projections = session.surface.projections;
    for (const event of session.snapshotEvents()) shadow.commit(event, undefined);
    const before = session.seq, result = build(shadow), events = shadow.snapshotEvents(before);
    if (events.length !== 2 || events[0].type !== 'user/message' || events[0].data.source?.kind !== 'compact-checkpoint' || events[1].type !== 'compaction/end') throw refuse('unexpected staged event batch');
    return { before, events, result, nodes: [...shadow.surface.nodes] };
  }
  // All fallible asynchronous work finishes before entering handle.run's short
  // synchronous section. No live Session event can interleave inside that block.
  async commit(engine, session, record, staged, signal) {
    const h = this.assertSupported(session), journal = engine.journal;
    const encoded = Buffer.from(await this.backend.encodeEventBatch(staged.events));
    await engine._flushSession(session);
    signal?.throwIfAborted();
    return h.run('weave-commit', () => {
      signal?.throwIfAborted(); this.assertSupported(session);
      if (session.seq !== staged.before || h.state.cursor !== staged.before || h.buffered.length || h.state.tornTruncateTo !== undefined || h.state.recoveredTail?.length) throw refuse('session changed during commit preparation; retry after it is idle');
      const location = this.backend.locate(session.header);
      if (location?.kind !== 'jsonl') throw refuse('unsupported persistence location');
      const target = location.path, file = journal.fileFor(session.id, record.compactionId), backup = file+'.rollback', tailFile = file+'.tail';
      fs.mkdirSync(dirname(file), { recursive: true });
      // A transaction id is unique. Existing backup material is never overwritten.
      copySynced(target, backup); writeNew(tailFile, encoded);
      const before = fileDigest(target), saved = fileDigest(backup);
      if (!SAME(before, saved)) throw refuse('backup differs from the held writer file');
      const atomic = { version: 1, beforeBytes: before.bytes, beforeHash: before.sha256, beforeEvents: staged.before, tailBytes: encoded.length, tailHash: digest(encoded) };
      let current = { ...record, sessionId: session.id, atomic, phase: 'committing' }, decided = false;
      journal.recordSync(current);
      try {
        this.checkpoint?.('before-append', { session, record: current });
        const fd = fs.openSync(target, 'a');
        try { fs.writeFileSync(fd, encoded); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        this.checkpoint?.('after-append', { session, record: current });
        engine.sessionState.update(session.id, state => ({ ...state, failures: 0, stopped: false }));
        this.checkpoint?.('after-state', { session, record: current });
        signal?.throwIfAborted();
        journal.recordSync({ ...current, phase: 'committed' });
        decided = true;
        this.checkpoint?.('after-decision', { session, record: current });
        h.state.cursor += staged.events.length; h.state.primed = undefined; h.observedLength = h.state.cursor;
        this.backend.coldLogMemo?.delete(session.id);
        // Publish exactly the already-durable native events. Suppress only their
        // duplicate routing; other synchronous listener events retain normal routing.
        const originalEnqueue = h.enqueueLive, expected = new Map(staged.events.map(e => [e.seq, e]));
        h.enqueueLive = function(event, ...args) {
          if (expected.has(event.seq)) {
            if (!SAME(event, expected.get(event.seq))) throw refuse('publication differs from durable transaction');
            expected.delete(event.seq); return;
          }
          return originalEnqueue.call(this, event, ...args);
        };
        try {
          for (const event of staged.events) session.commit(event, session.publicationEntry());
          if (expected.size) throw refuse('durable events did not pass the live persistence router');
          if (!SAME(session.surface.nodes, staged.nodes)) throw refuse('published surface differs from staged surface');
        } finally { h.enqueueLive = originalEnqueue; }
        this.checkpoint?.('after-publish', { session, record: current });
        return staged.result;
      } catch (error) {
        if (decided) {
          this.quarantine(session.id, h);
          throw refuse(`commit is durable but publication failed; reopen the session: ${error.message}`);
        }
        try {
          verifyFiles(target, current, journal); atomicRestore(target, backup);
          if (!SAME(fileDigest(target), before)) throw refuse('restored backup differs');
          this.backend.coldLogMemo?.delete(session.id);
          const reason = signal?.aborted ? 'cancelled' : 'failed';
          current = { ...current, failureKind: reason, atomic: { ...atomic, restored: true } };
          journal.recordSync(current);
          engine.sessionState.update(session.id, state => {
            const failures = Math.max(state.failures, record.failuresBefore ?? 0);
            return { ...state, failures, stopped: failures >= engine.config.failureThreshold };
          });
          error.atomicRolledBack = true;
        } catch (rollbackError) {
          this.quarantine(session.id, h);
          throw refuse(`backup restoration failed; journal retained: ${rollbackError.message}`);
        }
        throw error;
      }
    });
  }
  quarantine(id, handle) {
    this.blocked.add(id);
    // Prevent buffered closers/inbox events being appended behind an uncertain tail.
    handle.persistContiguous = async () => { throw refuse('writer quarantined; restart for backup recovery'); };
  }
  async recoverBeforeOpen(id, signal) {
    const records = [];
    for (const entry of this.roots.values()) for (const record of await entry.journal.pending(id)) {
      if (record.corrupt) throw refuse('corrupt recovery journal');
      if (record.atomic) records.push({ ...entry, record: { ...record, sessionId: id } });
    }
    if (!records.length) return;
    if (this.sessions.get(id) || this.backend.tracker.writers.has(id)) throw refuse('refusing disk recovery while a session/writer is live');
    const backend = this.backend; backend.tracker.claimWrite(id);
    let lease;
    try {
      const selected = await backend.findLog(id, signal);
      if (!selected) throw refuse('session log is missing');
      lease = await backend.acquireLease(id, undefined, dirname(selected.currentPath));
      // The lock remains held across every check and replacement. Original open
      // acquires it again afterwards; a racing writer then causes normal refusal.
      for (const {journal, state, failureThreshold, record} of records) {
        signal?.throwIfAborted();
        const verified = verifyFiles(selected.currentPath, record, journal);
        if (record.phase === 'committed') { await journal.clear(id, record.compactionId); continue; }
        if (verified.meta.restored !== true) {
          atomicRestore(selected.currentPath, verified.backup);
          if (fileDigest(selected.currentPath).sha256 !== verified.meta.beforeHash) throw refuse('cold recovery verification failed');
          // Persist this before the host can append end-seed/turn closers or
          // newly queued input. A second crash must not rewind those events.
          record.atomic = { ...record.atomic, restored: true };
          journal.recordSync(record);
        }
        backend.coldLogMemo?.delete(id);
        // Close the restored lifecycle BEFORE Session's constructor emits an
        // end-seed marker. Closing it afterwards makes the next disk replay fail.
        const restoredLog = await backend.readStoredLog(selected.currentPath, id, signal);
        const start = restoredLog.events.find(e => e.type === 'compaction/start' && e.data.compactionId === record.compactionId);
        const end = restoredLog.events.find(e => e.type === 'compaction/end' && e.data.compactionId === record.compactionId);
        if (!start) throw refuse('restored log has no matching compaction start');
        if (!end) {
          if (restoredLog.events.some(e => e.type === 'session/end-seed' && e.seq > start.seq)) throw refuse('restored lifecycle crosses an end-seed marker');
          const closer = { type: 'compaction/end', seq: restoredLog.events.length, time: Date.now(), data: { ...start.data, error: 'Weave restored the failed transaction backup before loading this session.' } };
          await backend.persistBatch(restoredLog.meta, [closer], true, restoredLog.inheritedEventCount);
          backend.coldLogMemo?.delete(id);
          await backend.readStoredLog(selected.currentPath, id, signal);
        }
        const reason = record.failureKind ?? 'interrupted';
        state.update(id, current => {
          const failures = Math.max(current.failures, (record.failuresBefore ?? 0) + (reason === 'cancelled' ? 0 : 1));
          return { ...current, failures, stopped: failures >= failureThreshold };
        });
        journal.recordSync({ ...record, failureKind: reason });
        this.checkpoint?.('after-cold-restore', { record });
        this.blocked.delete(id);
        this.logger?.warn?.(`[compaction-weave] Restored failed transaction ${record.compactionId} from verified backup before loading ${id}.`);
      }
    } finally { try { await lease?.release(); } finally { backend.tracker.releaseClaim(id); } }
  }
  dispose() {
    // Cordis traces callable property reads, so compare the raw descriptor.
    if (Object.getOwnPropertyDescriptor(this.backend, 'open')?.value === this.openWrapper) {
      if (this.openDescriptor) Object.defineProperty(this.backend, 'open', this.openDescriptor);
      else delete this.backend.open;
    }
    installed.delete(this.backend);
  }
}

export function installStockTransactionAdapter(backend, sessions, logger) {
  let adapter = installed.get(backend);
  if (!adapter) { adapter = new StockTransactionAdapter(backend, sessions, logger); installed.set(backend, adapter); }
  return adapter;
}
