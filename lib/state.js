import {atomicReplaceSync} from './atomic-replace.js';
// Durable, per-session policy state. No model data or credentials are stored here.
import { mkdirSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class SessionStateStore {
  constructor(root) { this.root = resolve(root); }
  file(id) {
    if (typeof id !== 'string' || !id) throw new Error('durable compaction state requires a session id');
    return join(this.root, createHash('sha256').update(id).digest('hex') + '.json');
  }
  read(id) {
    const file = this.file(id);
    let record;
    try { record = JSON.parse(readFileSync(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return { failures: 0, stopped: false }; throw new Error(`compaction state unreadable: ${e.message}`); }
    if (record.kind !== 'compaction-weave/state' || record.version !== 1 || record.sessionId !== id || !record.data || record.checksum !== createHash('sha256').update(JSON.stringify(record.data)).digest('hex')) throw new Error('compaction state identity or checksum mismatch');
    if (!Number.isSafeInteger(record.data.failures) || record.data.failures < 0 || typeof record.data.stopped !== 'boolean') throw new Error('compaction state has invalid failure counters');
    return record.data;
  }
  update(id, change) {
    mkdirSync(this.root, { recursive: true });
    const file = this.file(id), lock = file + '.lock', temp = file + '.' + randomUUID() + '.tmp';
    let lockFd, fd;
    try {
      // Concurrent writers fail closed; a leftover lock is retained for explicit recovery.
      try { lockFd = openSync(lock, 'wx'); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const locked = new Error(`compaction state is locked; preserve and inspect the lock after all writers stop: ${lock}`);
        locked.code = 'STATE_LOCKED'; locked.cause = error; throw locked;
      }
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      const data = change(this.read(id));
      const record = { kind: 'compaction-weave/state', version: 1, sessionId: id, data, checksum: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
      fd = openSync(temp, 'wx'); writeFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined;
      atomicReplaceSync(temp, file);
      return data;
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch {}
      if (lockFd !== undefined) { closeSync(lockFd); unlinkSync(lock); }
    }
  }
}
