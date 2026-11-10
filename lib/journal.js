import {atomicReplaceSync,atomicReplace} from './atomic-replace.js';
import { sessionDirectory } from './storage-path.js';
// 持久事务日志：插件保存成功决策；原装宿主未决替换保留并阻断。
// started/committing 等阶段是未决事务，committed 是已持久成功决策。
// 清理失败不能抹掉决策，也不能把已成功事务误回滚；坏记录保留并阻断继续。

import { mkdir, readFile, readdir, rm, writeFile, open } from 'node:fs/promises';
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const JOURNAL_DIR_NAME = 'journal';

function safeSegment(value) {
  return String(value ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

/**
 * 压缩事务日志。
 *
 * started 记录首次发布边界；committing 保存原节点/投影快照及失败计数。
 * replaced/closing 记录中间阶段；committed 只做清理，不再撤销成功结果。
 */
export class CompactionJournal {
  /** @param {{ root?: string|null }} [options] */
  constructor(options = {}) {
    this.root = options.root
      ? resolve(options.root)
      : join(process.cwd(), JOURNAL_DIR_NAME);
  }

  /** 由归档根目录推出日志根目录（两者共用 DSH_HOME 下的同一个 storage 目录）。 */
  static alongside(archiveRoot) {
    if (typeof archiveRoot !== 'string' || archiveRoot.length === 0) return new CompactionJournal({});
    return new CompactionJournal({ root: join(dirname(archiveRoot), JOURNAL_DIR_NAME) });
  }

  dirFor(sessionId) {
    return sessionDirectory(this.root, sessionId, 'journal');
  }

  fileFor(sessionId, compactionId) {
    return join(this.dirFor(sessionId), `${safeSegment(compactionId)}.json`);
  }

  /**
   * 记一笔"我要做/我正在做"。
   *
   * ⚠️ 写失败**必须抛**。日志写不进去时继续往下做，就等于放弃跨进程恢复：
   * 崩溃之后没人知道这次压缩做到哪一步了。宁可这次不压，也不能留一个
   * 谁也说不清的半成品事务。
   *
   * @param {{ sessionId: string, compactionId: string, phase: string, startSeq?: number, endSeq?: number, note?: string }} record
   * @returns {Promise<string>} 日志文件路径
   */
  async record({ sessionId, compactionId, phase, startSeq, endSeq, note, snapshot, startEventSeq, failuresBefore, failureKind, atomic }) {
    const dir = this.dirFor(sessionId);
    await mkdir(dir, { recursive: true });
    const file = this.fileFor(sessionId, compactionId);
    const payload = {
      kind: 'compaction-weave/journal',
      version: 1,
      sessionId,
      compactionId,
      phase,
      ...(failuresBefore === undefined ? {} : { failuresBefore }),
      ...(failureKind === undefined ? {} : { failureKind }),
      ...(atomic === undefined ? {} : { atomic }),
      ...(startEventSeq === undefined ? {} : { startEventSeq }),
      ...(startSeq === undefined ? {} : { startSeq }),
      ...(endSeq === undefined ? {} : { endSeq }),
      ...(note === undefined ? {} : { note }),
      ...(snapshot === undefined ? {} : { snapshot }),
      at: new Date().toISOString(),
    };
    const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    let handle;
    try {
      handle = await open(temp, 'wx'); await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
      await handle.sync(); await handle.close(); handle = null; await atomicReplace(temp, file);
    } finally { if (handle) await handle.close().catch(() => {}); await rm(temp, { force: true }).catch(() => {}); }
    return file;
  }

  // The short stock-host commit section must not yield between the durable
  // decision and publication. The record has the same schema as record().
  recordSync(record) {
    const { file: ignored, corrupt: ignoredCorrupt, ...data } = record;
    const file = this.fileFor(data.sessionId, data.compactionId);
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    let fd;
    try {
      fd = openSync(temp, 'wx');
      writeFileSync(fd, JSON.stringify({ ...data, kind: 'compaction-weave/journal', version: 1, at: new Date().toISOString() }) + '\n');
      fsyncSync(fd); closeSync(fd); fd = undefined; atomicReplaceSync(temp, file);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch {}
    }
    return file;
  }

  /** 事务正常收尾后清掉痕迹。清失败不算致命 —— 下次启动最多多做一次幂等收尾。 */
  async clear(sessionId, compactionId) {
    try {
      const file = this.fileFor(sessionId, compactionId);
      await rm(file, { force: true });
      // Once the journal is gone, no recovery can need these transaction files.
      await rm(file + '.rollback', { force: true }).catch(() => {});
      await rm(file + '.tail', { force: true }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 列出某会话所有**没走完**的事务。
   * 目录不存在 = 没有未完成事务（这是正常情况，不是错误）。
   *
   * @param {string} sessionId
   * @returns {Promise<{compactionId: string, phase: string, startSeq?: number, endSeq?: number, at?: string, file: string, corrupt?: boolean}[]>}
   */
  async pending(sessionId) {
    const dir = this.dirFor(sessionId);
    let names;
    try {
      names = await readdir(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = join(dir, name);
      const compactionId = name.slice(0, -'.json'.length);
      try {
        const raw = await readFile(file, 'utf8');
        const record = JSON.parse(raw);
        if (!record || record.kind !== 'compaction-weave/journal' || record.version !== 1 || record.sessionId !== sessionId || record.compactionId !== compactionId || (record.failureKind !== undefined && !['failed', 'cancelled', 'interrupted'].includes(record.failureKind)) || !['started', 'committing', 'replaced', 'closing', 'committed'].includes(record.phase)) {
          out.push({ compactionId, phase: 'unknown', file, corrupt: true });
          continue;
        }
        out.push({
          compactionId: typeof record.compactionId === 'string' ? record.compactionId : compactionId,
          phase: typeof record.phase === 'string' ? record.phase : 'unknown',
          ...(record.failuresBefore === undefined ? {} : { failuresBefore: record.failuresBefore }),
          ...(record.failureKind === undefined ? {} : { failureKind: record.failureKind }),
          ...(record.atomic === undefined ? {} : { atomic: record.atomic }),
          ...(record.startEventSeq === undefined ? {} : { startEventSeq: record.startEventSeq }),
          ...(record.startSeq === undefined ? {} : { startSeq: record.startSeq }),
          ...(record.endSeq === undefined ? {} : { endSeq: record.endSeq }),
          ...(record.at === undefined ? {} : { at: record.at }),
          ...(record.snapshot === undefined ? {} : { snapshot: record.snapshot }),
          file,
        });
      } catch {
        out.push({ compactionId, phase: 'unknown', file, corrupt: true });
      }
    }
    return out;
  }
}
