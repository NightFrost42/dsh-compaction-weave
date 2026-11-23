import {atomicReplace} from './atomic-replace.js';
import { attachmentReferences, preserveAttachments, readAttachmentPage, statAttachment, verifyAttachment } from './attachments.js';
import { sessionDirectory } from './storage-path.js';
import { historySourceSeqs, toolResultMessage } from './history-source.js';
// 被压掉的原文落盘 + 三个回查工具。
//
// 压缩前归档完整原文，模型通过 history 工具按序号和关键词读取细节。
//
// 落盘位置：<DSH_HOME>/storages/dsh-compaction-weave/sessions/<sessionId>/<compactionId>.jsonl.zstd
// 每行保留完整 event、blocks/source/tool 及检索文本；宿主接纳的附件字节单独 SHA-256 归档。

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, open, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { zstdCompress as zstdCompressCb, zstdDecompress as zstdDecompressCb, constants as zlibConstants } from 'node:zlib';

const zstdCompress = promisify(zstdCompressCb);
const zstdDecompress = promisify(zstdDecompressCb);
const ZSTD_OPTIONS = { params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 } };
const SPAN_ZSTD_EXT = '.jsonl.zstd';
const SPAN_PLAIN_EXT = '.jsonl';
const SHA256_HEX_RE = /^s-([a-f0-9]{64})$/;

const ROOT_DIR_NAME = 'dsh-compaction-weave';

// 头部格式版本。读到别的版本说明这段归档不是当前代码写的 —— 字段含义可能变了，
// 不能按现在的规则解读它，也不能当成"内容完整"。
const SPAN_VERSION = 3;

export const HISTORY_SNAPSHOT_WARNING = 'Historical session snapshot; current files or external content may have changed. Archive checksums and attachment SHA-256 verify archived content, not the current disk file version. Re-read current files before editing.';

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.dsh');
}

export function defaultArchiveRoot() {
  return join(dshHome(), 'storages', ROOT_DIR_NAME, 'sessions');
}

function safeSegment(value) {
  return String(value ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

export class CompactionArchive {
  /** @param {{ root?: string|null }} [options] */
  constructor(options = {}) {
    this.root = options.root ? resolve(options.root) : defaultArchiveRoot();
  }

  dirFor(sessionId) {
    return sessionDirectory(this.root, sessionId, 'archive');
  }

  /**
   * 把一段被摘要覆盖的原文写盘。
   *
   * ⚠️ 失败返回 `null`，由调用方决定怎么办 —— 引擎那边会**中止压缩**。
   * 压缩一旦提交，被折叠的消息就从 surface 上消失了，归档是唯一还能读到原文的
   * 地方；悄悄吞掉失败等于把"可回查"这个保证单方面作废。
   *
   * @param {object} args
   * @param {string} args.sessionId
   * @param {string} args.compactionId
   * @param {{seq:number, type:string, role:string, text:string}[]} args.entries
   * @returns {Promise<string|null>} 落盘路径；失败返回 null
   */
  async writeSpan({ sessionId, compactionId, entries, signal, allowForeignFallback = false }) {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const dir = this.dirFor(sessionId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const foreignFallback = allowForeignFallback === true;
      const attachments = await preserveAttachments(
        dir,
        entries,
        this.attachments,
        signal,
        foreignFallback ? { allowForeignFallback: true } : undefined,
      );
      const file = join(dir, `${safeSegment(compactionId)}${SPAN_ZSTD_EXT}`);
      // 第一行是**头部**：写清版本、条数与校验和。没有它，读的时候没法区分
      // "这个段本来就只有 3 条"和"文件被截断了"。校验和覆盖所有条目原文，
      // 用来发现"行数对得上但内容被改过"的情况。
      const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
      const header = JSON.stringify({
        kind: 'compaction-weave/span',
        attachments,
        ...(foreignFallback ? { foreignFallback: true } : {}),
        version: SPAN_VERSION,
        compactionId,
        sessionId,
        entries: entries.length,
        bytes: Buffer.byteLength(body, 'utf8'),
        checksum: checksum(body),
        at: new Date().toISOString(),
      });
      const compressed = await zstdCompress(Buffer.from(`${header}\n${body}\n`, 'utf8'), ZSTD_OPTIONS);
      await atomicArchiveWrite(file, compressed);
      await this._touchIndex(sessionId, compactionId, file, entries.length);
      return file;
    } catch {
      return null;
    }
  }

  /** Read only an attachment owned by this verified session/span; never an arbitrary path. */
  async readAttachment(sessionId, compactionId, attachmentId, offset, limit, signal) {
    const span = await this.readSpan(sessionId, compactionId);
    if (!span.ok) throw new Error('attachment owner archive is incomplete: ' + span.reason);
    const foreignFallback = span.header?.foreignFallback === true;
    const owned = attachmentReferences(
      span.entries,
      foreignFallback ? { allowForeignFallback: true } : undefined,
    ).find(item => item.ref.attachmentId === attachmentId);
    if (!owned) throw new Error('attachment does not belong to this span');
    return readAttachmentPage(this.dirFor(sessionId), owned.ref, offset, limit, signal);
  }

  /** Inspect verified attachment metadata owned by this session/span without exposing base64 bytes or host paths. */
  async inspectAttachment(sessionId, compactionId, attachmentId, signal) {
    const span = await this.readSpan(sessionId, compactionId);
    if (!span.ok) throw new Error('attachment owner archive is incomplete: ' + span.reason);
    const foreignFallback = span.header?.foreignFallback === true;
    const owned = attachmentReferences(
      span.entries,
      foreignFallback ? { allowForeignFallback: true } : undefined,
    ).find(item => item.ref.attachmentId === attachmentId);
    if (!owned) throw new Error('attachment does not belong to this span');
    await verifyAttachment(this.dirFor(sessionId), owned.ref, signal);
    const ref = owned.ref;
    return {
      type: owned.type,
      attachmentId: ref.attachmentId,
      mediaType: typeof ref.mediaType === 'string' && ref.mediaType.length > 0
        ? ref.mediaType
        : (typeof ref.mimeType === 'string' && ref.mimeType.length > 0 ? ref.mimeType : null),
      width: typeof ref.width === 'number' && Number.isFinite(ref.width) ? ref.width : null,
      height: typeof ref.height === 'number' && Number.isFinite(ref.height) ? ref.height : null,
      bytes: ref.bytes,
      name: typeof ref.name === 'string' && ref.name.length > 0 ? ref.name : null,
      verified: true,
    };
  }

  async _touchIndex(sessionId, compactionId, file, count) {
    const dir = this.dirFor(sessionId);
    const indexPath = join(dir, 'index.jsonl');
    const line = JSON.stringify({
      compactionId,
      file,
      entries: count,
      at: new Date().toISOString(),
    });
    const handle = await open(indexPath, 'a', 0o600);
    try { await handle.writeFile(line + '\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await syncDirBestEffort(dir);
  }

  async _resolveSpanFile(dir, compactionId) {
    const seg = safeSegment(compactionId);
    const zstdPath = join(dir, `${seg}${SPAN_ZSTD_EXT}`);
    try {
      const info = await stat(zstdPath);
      return { path: zstdPath, compressed: true, info };
    } catch (error) {
      if (error?.code !== 'ENOENT') return { error };
    }
    const plainPath = join(dir, `${seg}${SPAN_PLAIN_EXT}`);
    try {
      const info = await stat(plainPath);
      return { path: plainPath, compressed: false, info };
    } catch (error) {
      if (error?.code !== 'ENOENT') return { error };
    }
    return null;
  }

  /**
   * 列出某会话归档过的所有压缩段（新的在前）。
   *
   * ⚠️ 只扫目录是不够的。`index.jsonl` 记着"这个会话本该有哪些段"，
   * 而目录只反映"现在还在哪些文件"。两者不一致时（文件被删、被挪走、
   * 目录读不出来），只扫目录会得出"这里本来就只有这些"的结论 ——
   * 于是搜索对一个已经丢失的段说"历史里没有"。这里以索引为准枚举，
   * 用 `present` 标出文件还在不在。
   */
  async listSpans(sessionId) {
    const dir = this.dirFor(sessionId);
    const indexed = await this._readIndex(sessionId);
    let names = [];
    let readable = true;
    try {
      names = await readdir(dir);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`archive directory unreadable: ${error.message}`);
      readable = false;
    }

    // Deduplicate index.jsonl keeping the LATEST record per compactionId so
    // lossless conversion (.jsonl -> .jsonl.zstd) or re-compaction resolves cleanly.
    const latestById = new Map();
    for (const record of indexed) {
      const id = record?.compactionId;
      if (typeof id !== 'string' || id.length === 0) continue;
      latestById.set(id, record);
    }

    const seen = new Set();
    const spans = [];
    for (const [id, record] of latestById.entries()) {
      seen.add(id);
      const resolved = await this._resolveSpanFile(dir, id);
      const fallbackPath = typeof record?.file === 'string' && record.file ? record.file : join(dir, `${safeSegment(id)}${SPAN_ZSTD_EXT}`);
      if (resolved && !resolved.error) {
        spans.push({
          compactionId: id,
          path: resolved.path,
          bytes: resolved.info.size,
          modified: resolved.info.mtime?.toISOString() ?? record?.at ?? '',
          present: true,
        });
      } else {
        spans.push({
          compactionId: id,
          path: fallbackPath,
          bytes: 0,
          modified: record?.at ?? '',
          present: false,
        });
      }
    }

    if (readable) {
      const discovered = new Map();
      for (const name of names) {
        if (name === 'index.jsonl') continue;
        if (name.endsWith(SPAN_ZSTD_EXT)) {
          const id = name.slice(0, -SPAN_ZSTD_EXT.length);
          if (id) discovered.set(id, { name, compressed: true });
        } else if (name.endsWith(SPAN_PLAIN_EXT)) {
          const id = name.slice(0, -SPAN_PLAIN_EXT.length);
          if (id && !discovered.has(id)) discovered.set(id, { name, compressed: false });
        }
      }
      for (const [id, entry] of discovered.entries()) {
        if (seen.has(id)) continue;
        seen.add(id);
        const path = join(dir, entry.name);
        try {
          const info = await stat(path);
          spans.push({
            compactionId: id,
            path,
            bytes: info.size,
            modified: info.mtime.toISOString(),
            present: true,
          });
        } catch {
          spans.push({ compactionId: id, path, bytes: 0, modified: '', present: false });
        }
      }
    }

    spans.sort((a, b) => (a.modified < b.modified ? 1 : -1));
    return spans;
  }

  /**
   * 读 `index.jsonl` 的全部记录。坏行/读失败明确报错；不能据残缺索引宣称无历史。
   */
  async _readIndex(sessionId) {
    const indexPath = join(this.dirFor(sessionId), 'index.jsonl');
    let raw;
    try { raw = await readFile(indexPath, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    const out = [];
    for (const [i, line] of raw.split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (!record || typeof record.compactionId !== 'string' || !record.compactionId || !Number.isSafeInteger(record.entries) || record.entries < 0) throw new Error('invalid record');
        out.push(record);
      } catch { throw new Error(`archive index is incomplete or corrupt at line ${i + 1}; search cannot prove absence`); }
    }
    return out;
  }

  /**
   * 读一个归档段的全部条目。
   *
   * ⚠️ 坏行**不能静默跳过**。以前 `catch {}` 一吞，用户拿到的是"看起来完整"的
   * 部分原文 —— 回查的人无从判断少了什么。现在返回结构化结果：
   *   - `ok: true`  → 头部、条数、校验和三者都对得上
   *   - `ok: false` → 带上 `reason` 与 `damaged` 明细，调用方必须把它告诉用户
   *
   * @param {string} sessionId
   * @param {string} compactionId
   * @returns {Promise<{ok:boolean, entries:any[], reason?:string, expected?:number, actual?:number, damaged?:number[], header?:any}>}
   */
  async readSpan(sessionId, compactionId, options = {}) {
    const dir = this.dirFor(sessionId);
    const seg = safeSegment(compactionId);
    const zstdFile = join(dir, `${seg}${SPAN_ZSTD_EXT}`);
    const plainFile = join(dir, `${seg}${SPAN_PLAIN_EXT}`);
    let raw;
    let compressedBuf = null;
    try {
      compressedBuf = await readFile(zstdFile);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return { ok: false, entries: [], reason: 'unreadable' };
      }
    }
    if (compressedBuf !== null) {
      try {
        const plainBuf = await zstdDecompress(compressedBuf);
        raw = plainBuf.toString('utf8');
      } catch {
        return { ok: false, entries: [], reason: 'damaged' };
      }
    } else {
      try {
        raw = await readFile(plainFile, 'utf8');
      } catch (error) {
        return { ok: false, entries: [], reason: error?.code === 'ENOENT' ? 'missing' : 'unreadable' };
      }
    }

    const lines = raw.split('\n');
    let header;
    let start = 0;
    if (lines.length > 0 && lines[0].trim().length > 0) {
      try {
        const first = JSON.parse(lines[0]);
        if (first && typeof first === 'object' && first.kind === 'compaction-weave/span') {
          header = first;
          start = 1;
        }
      } catch {
        // 第一行不是 JSON：按旧格式（无头部）处理，下面会按"无头部"判定。
      }
    }

    const entries = [];
    const damaged = [];
    for (let index = start; index < lines.length; index += 1) {
      const trimmed = lines[index].trim();
      if (trimmed.length === 0) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        damaged.push(index + 1);
      }
    }

    if (damaged.length > 0) {
      return { ok: false, entries, damaged, reason: 'damaged', header };
    }
    if (header === undefined) {
      // 没有头部 = 旧格式或外部写入。条数无从校验，明确说"未校验"而不是"完整"。
      return { ok: false, entries, reason: 'unverified', header };
    }
    // ⚠️ 头部里的每一个字段都要**核对**，不能只看它存在。
    // 只核 `entries` 与 `checksum` 时，把 `version` 改成 999、`bytes` 改成 0
    // 仍然读成 `ok: true` —— 头部退化成一个可以随便写的注释，校验和也就
    // 只剩"内容没被改过"，说不出"这是不是我写的那一段"。
    if (header.version !== SPAN_VERSION && header.version !== 2) {
      return { ok: false, entries, reason: 'version', expected: SPAN_VERSION, actual: header.version, header };
    }
    if (header.compactionId !== compactionId || header.sessionId !== sessionId) {
      return {
        ok: false,
        entries,
        reason: 'identity',
        expected: { sessionId, compactionId },
        actual: { sessionId: header.sessionId, compactionId: header.compactionId },
        header,
      };
    }
    if (header.entries !== entries.length) {
      return { ok: false, entries, reason: 'truncated', expected: header.entries, actual: entries.length, header };
    }
    const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
    if (header.bytes !== Buffer.byteLength(body, 'utf8')) {
      return { ok: false, entries, reason: 'bytes', expected: header.bytes, actual: Buffer.byteLength(body, 'utf8'), header };
    }
    // ⚠️ 校验和必须**存在且合法**。
    // 早先只在"checksum 是字符串"时才核对，缺失就直接跳到 ok —— 于是把校验和
    // 整行删掉、再把正文改成等长内容，仍然读成"完整"。校验和是可选的装饰时，
    // 它保护的就不是内容，而是"没改过头部的人"。
    if (typeof header.checksum !== 'string' || !/^[0-9a-f]{8}$/i.test(header.checksum)) {
      return { ok: false, entries, reason: 'checksum', header };
    }
    if (header.checksum !== checksum(body)) {
      return { ok: false, entries, reason: 'checksum', header };
    }
    // Version 2 verified text/structure only. Version 3 also verifies every binary.
    if (header.version === 3) {
      try {
        const foreignFallback = header.foreignFallback === true;
        const refs = attachmentReferences(
          entries,
          foreignFallback ? { allowForeignFallback: true } : undefined,
        );
        let toVerify = refs;
        if (foreignFallback) {
          if (!Array.isArray(header.attachments)) throw new Error('attachment manifest mismatch');
          const byKey = new Map(refs.map(item => [`${item.type}:${item.ref.attachmentId}`, item]));
          toVerify = [];
          for (const recorded of header.attachments) {
            const key = `${recorded?.type}:${recorded?.attachmentId}`;
            const matched = byKey.get(key);
            if (!matched || matched.ref.bytes !== recorded?.bytes) {
              throw new Error('attachment manifest mismatch');
            }
            toVerify.push(matched);
          }
        } else {
          const expected = refs.map(({type,ref}) => ({type,attachmentId:ref.attachmentId,bytes:ref.bytes}));
          if (JSON.stringify(expected) !== JSON.stringify(header.attachments)) throw new Error('attachment manifest mismatch');
        }
        if (options.verifyAttachments === 'stat') {
          for (const {ref} of toVerify) await statAttachment(this.dirFor(sessionId), ref);
          return { ok: true, entries, header, binaryVerified: false };
        }
        for (const {ref} of toVerify) await readAttachmentPage(this.dirFor(sessionId), ref, 0, 1);
      } catch (error) { return { ok:false, entries, reason:'attachment', detail:error.message, header }; }
    }
    return { ok: true, entries, header, binaryVerified: header.version === 3 };
  }

  /**
   * 在一个会话的全部归档里做全文搜索。
   *
   * ⚠️ 返回值不能只是命中数组。"没搜到"有两种完全不同的含义：
   * - 所有归档都**完整**读过了，确实没有 → 用户可以直接相信"历史里没有"；
   * - 有归档读**不完整**（截断/校验和不对/坏行）→ 那一段里可能有，
   *   只是看不见。
   * 早先只在命中时附 `incomplete`，无命中就把读取失败状态丢了，于是
   * `history_search` 会对着一个截断的归档说"No archived span contains …" ——
   * 比不作答更糟，因为用户会据此认为那条约束从来没存在过。
   *
   * @returns {Promise<{hits: any[], scanned: number, unreadable: {compactionId:string, reason:string}[]}>}
   */
  async search(sessionId, query, options = {}) {
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20;
    const needle = String(query ?? '').toLowerCase();
    const hits = [];
    const unreadable = [];
    if (needle.length === 0) return { hits, scanned: 0, unreadable };
    const terms = [...new Set(needle.trim().split(/\s+/).filter(Boolean))];
    const spans = await this.listSpans(sessionId);
    let scanned = 0;
    for (const span of spans) {
      if (span.present === false) {
        // 索引说这一段存在过，文件却不见了。它当然扫不到，但"扫不到"
        // 不等于"里面没有" —— 必须记进 unreadable，让调用方说话时留余地。
        scanned += 1;
        unreadable.push({ compactionId: span.compactionId, reason: 'missing' });
        continue;
      }
      const read = await this.readSpan(sessionId, span.compactionId, { verifyAttachments: 'stat' });
      scanned += 1;
      if (!read?.ok) {
        unreadable.push({ compactionId: span.compactionId, reason: read?.reason ?? 'unknown' });
      }
      const entries = Array.isArray(read?.entries) ? read.entries : [];
      for (const entry of entries) {
        const primary = typeof entry?.text === 'string' ? entry.text : '';
        const meta = [JSON.stringify(entry?.blocks ?? []), JSON.stringify(entry?.source ?? {}), JSON.stringify(entry?.tool ?? [])].join('\n');
        let matchedInEntry = false;
        const scanExact = (haystack) => {
          if (!haystack) return false;
          const lower = haystack.toLowerCase();
          let found = false;
          let from = 0;
          while (from <= lower.length) {
            const at = lower.indexOf(needle, from);
            if (at < 0) break;
            found = true;
            hits.push({
              compactionId: span.compactionId,
              seq: entry.seq,
              role: entry.role,
              excerpt: excerptAround(haystack, at, needle.length),
              // 命中的段本身不完整时带出来：搜到一条不等于这段原文是完整的。
              ...(read?.ok ? {} : { incomplete: read?.reason ?? 'unknown' }),
            });
            if (hits.length >= limit) return 'limit';
            from = at + Math.max(needle.length, 80);
          }
          return found;
        };
        const primaryMatch = scanExact(primary);
        if (primaryMatch === 'limit') return { hits, scanned, unreadable };
        matchedInEntry = primaryMatch;
        if (!matchedInEntry) {
          const metaMatch = scanExact(meta);
          if (metaMatch === 'limit') return { hits, scanned, unreadable };
          matchedInEntry = metaMatch;
        }
        if (!matchedInEntry && terms.length > 1) {
          const combined = primary ? `${primary}\n${meta}` : meta;
          const lower = combined.toLowerCase();
          if (terms.every(term => lower.includes(term))) {
            const firstTerm = terms[0];
            const at = lower.indexOf(firstTerm);
            hits.push({
              compactionId: span.compactionId,
              seq: entry.seq,
              role: entry.role,
              excerpt: excerptAround(combined, at, firstTerm.length),
              ...(read?.ok ? {} : { incomplete: read?.reason ?? 'unknown' }),
            });
            if (hits.length >= limit) return { hits, scanned, unreadable };
          }
        }
      }
    }
    return { hits, scanned, unreadable };
  }

  /**
   * Read-only archive storage inventory & conservative orphan classification.
   * Never modifies disk state and never guesses host paths.
   */
  async getStorageStats({
    backupRoot = null,
    stateRoot = null,
    journal = null,
    sessions = null,
    backend = null,
    sessionPersistence = null,
    probeSessionExists = null,
    activeSessionIds = null,
    signal = null,
  } = {}) {
    const resolvedStateRoot = stateRoot ? resolve(stateRoot) : join(dirname(this.root), 'state');
    const resolvedBackupRoot = backupRoot ? resolve(backupRoot) : null;
    const orphanProbeAvailable = Boolean(
      typeof probeSessionExists === 'function' ||
      typeof sessionPersistence?.stat === 'function' ||
      typeof backend?.findLog === 'function',
    );

    const backupBytes = resolvedBackupRoot ? await sumDirectoryBytes(resolvedBackupRoot, signal) : 0;
    let dirEntries = [];
    try {
      dirEntries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return {
          totalBytes: 0,
          backupBytes,
          sessionCount: 0,
          spanCount: 0,
          legacyPlainSpanCount: 0,
          legacyPlainSpanBytes: 0,
          orphanProbeAvailable,
          orphanSessionCount: 0,
          orphanBytes: 0,
          ambiguousSessionCount: 0,
          sessions: [],
          orphanPreview: [],
        };
      }
      throw error;
    }

    let totalBytes = 0;
    let spanCount = 0;
    let legacyPlainSpanCount = 0;
    let legacyPlainSpanBytes = 0;
    let orphanSessionCount = 0;
    let orphanBytes = 0;
    let ambiguousSessionCount = 0;
    const sessionSummaries = [];
    const orphanPreview = [];

    for (const entry of dirEntries) {
      signal?.throwIfAborted?.();
      const entryPath = join(this.root, entry.name);
      if (entry.isSymbolicLink?.()) continue;
      if (entry.isFile()) {
        try {
          totalBytes += (await stat(entryPath)).size;
        } catch {}
        continue;
      }
      if (!entry.isDirectory()) continue;

      const disk = await scanSessionArchiveDir(entryPath, signal);
      totalBytes += disk.bytes;
      spanCount += disk.spanFiles.length;
      legacyPlainSpanCount += disk.plainCount;
      legacyPlainSpanBytes += disk.plainBytes;

      const resolved = await resolveSessionIdForArchiveDir({
        dirPath: entryPath,
        dirName: entry.name,
        spanFiles: disk.spanFiles,
        stateRoot: resolvedStateRoot,
      });

      let status = 'retained';
      if (!resolved.sessionId || resolved.ambiguous) {
        status = 'ambiguous';
        ambiguousSessionCount += 1;
      } else {
        const sid = resolved.sessionId;
        const hasPendingJournal = await checkPendingJournalForSession(sid, journal, dirname(this.root));
        if (hasPendingJournal) {
          status = 'active';
        } else {
          const probe = await probeHostSession({
            sessionId: sid,
            probeSessionExists,
            sessions,
            backend,
            sessionPersistence,
            activeSessionIds,
            signal,
          });
          if (probe === 'active' || probe === 'exists') {
            status = 'active';
          } else if (probe === 'missing') {
            status = 'orphan';
            orphanSessionCount += 1;
            orphanBytes += disk.bytes;
            orphanPreview.push({
              dirName: entry.name,
              sessionId: sid,
              bytes: disk.bytes,
              spanCount: disk.spanFiles.length,
              lastModified: disk.mtimeMs > 0 ? new Date(disk.mtimeMs).toISOString() : null,
            });
          } else {
            status = probe === 'unavailable' ? 'probe_unavailable' : 'ambiguous';
            if (status === 'ambiguous') ambiguousSessionCount += 1;
          }
        }
      }

      sessionSummaries.push({
        dirName: entry.name,
        sessionId: resolved.sessionId,
        bytes: disk.bytes,
        spanCount: disk.spanFiles.length,
        legacyPlainSpanCount: disk.plainCount,
        legacyPlainSpanBytes: disk.plainBytes,
        lastModified: disk.mtimeMs > 0 ? new Date(disk.mtimeMs).toISOString() : null,
        status,
      });
    }

    return {
      totalBytes,
      backupBytes,
      sessionCount: sessionSummaries.length,
      spanCount,
      legacyPlainSpanCount,
      legacyPlainSpanBytes,
      orphanProbeAvailable,
      orphanSessionCount,
      orphanBytes,
      ambiguousSessionCount,
      sessions: sessionSummaries,
      orphanPreview,
    };
  }

  /**
   * Losslessly convert verified legacy plaintext `.jsonl` spans to `.jsonl.zstd`,
   * verify exact roundtrip decompression + checksum + readSpan BEFORE touching
   * index or removing the plaintext `.jsonl`. Never deletes unverified/corrupt files.
   */
  async compressLegacySpans({ signal = null } = {}) {
    let dirEntries = [];
    try {
      dirEntries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { compressedCount: 0, skippedCount: 0, failedCount: 0, bytesBefore: 0, bytesAfter: 0, bytesSaved: 0 };
      }
      throw error;
    }

    let compressedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let bytesBefore = 0;
    let bytesAfter = 0;

    for (const entry of dirEntries) {
      signal?.throwIfAborted?.();
      if (!entry.isDirectory() || entry.isSymbolicLink?.()) continue;
      const entryPath = join(this.root, entry.name);
      let fileNames = [];
      try {
        fileNames = await readdir(entryPath);
      } catch {
        continue;
      }

      const plainNames = fileNames.filter((n) => n !== 'index.jsonl' && n.endsWith(SPAN_PLAIN_EXT));
      if (plainNames.length === 0) continue;

      const resolved = await resolveSessionIdForArchiveDir({
        dirPath: entryPath,
        dirName: entry.name,
        spanFiles: plainNames.map((name) => ({ name, path: join(entryPath, name), compressed: false })),
        stateRoot: join(dirname(this.root), 'state'),
      });
      if (!resolved.sessionId || resolved.ambiguous) {
        skippedCount += plainNames.length;
        continue;
      }
      const sid = resolved.sessionId;
      let targetDir;
      try {
        targetDir = this.dirFor(sid);
      } catch {
        skippedCount += plainNames.length;
        continue;
      }

      for (const plainName of plainNames) {
        signal?.throwIfAborted?.();
        const plainPath = join(targetDir, plainName);
        const compactionIdFromName = plainName.slice(0, -SPAN_PLAIN_EXT.length);
        let zstdCreated = false;
        const zstdPath = join(targetDir, `${safeSegment(compactionIdFromName)}${SPAN_ZSTD_EXT}`);
        try {
          const rawPlainBuf = await readFile(plainPath);
          const rawText = rawPlainBuf.toString('utf8');
          const firstLine = rawText.split('\n', 1)[0]?.trim() ?? '';
          const header = firstLine ? JSON.parse(firstLine) : null;
          if (
            !header ||
            header.kind !== 'compaction-weave/span' ||
            header.sessionId !== sid ||
            typeof header.compactionId !== 'string' ||
            safeSegment(header.compactionId) !== compactionIdFromName
          ) {
            skippedCount += 1;
            continue;
          }

          // Verify plaintext integrity (including checksum/entries/bytes/attachments) BEFORE converting.
          let preCheckZstdExisted = true;
          try { await stat(zstdPath); } catch { preCheckZstdExisted = false; }
          if (!preCheckZstdExisted) {
            const plainRead = await this.readSpan(sid, header.compactionId, { verifyAttachments: 'stat' });
            if (!plainRead.ok) {
              skippedCount += 1;
              continue;
            }
            const compressed = await zstdCompress(rawPlainBuf, ZSTD_OPTIONS);
            await atomicArchiveWrite(zstdPath, compressed);
            zstdCreated = true;
          }

          // Mandatory lossless roundtrip verification + full readSpan check before deleting `.jsonl`.
          const zstdDiskBuf = await readFile(zstdPath);
          const decompressed = await zstdDecompress(zstdDiskBuf);
          if (Buffer.compare(decompressed, rawPlainBuf) !== 0) {
            throw new Error('zstd roundtrip buffer mismatch');
          }
          const readCheck = await this.readSpan(sid, header.compactionId, { verifyAttachments: 'stat' });
          if (!readCheck.ok) {
            throw new Error(`compressed readSpan failed: ${readCheck.reason ?? 'unknown'}`);
          }

          await this._touchIndex(sid, header.compactionId, zstdPath, header.entries);
          await rm(plainPath);
          compressedCount += 1;
          bytesBefore += rawPlainBuf.length;
          bytesAfter += zstdDiskBuf.length;
        } catch (error) {
          if (signal?.aborted) throw error;
          if (zstdCreated) {
            await rm(zstdPath, { force: true }).catch(() => {});
          }
          failedCount += 1;
        }
      }
    }

    return {
      compressedCount,
      skippedCount,
      failedCount,
      bytesBefore,
      bytesAfter,
      bytesSaved: Math.max(0, bytesBefore - bytesAfter),
    };
  }

  /**
   * Explicitly delete ONLY verified orphan whole session directories after `confirmDelete: true`.
   * Fail-closed when host probe is unavailable or ownership/liveness is uncertain.
   */
  async cleanupOrphanArchives({
    confirmDelete = false,
    backupRoot = null,
    stateRoot = null,
    journal = null,
    sessions = null,
    backend = null,
    sessionPersistence = null,
    probeSessionExists = null,
    activeSessionIds = null,
    signal = null,
  } = {}) {
    if (confirmDelete !== true) {
      throw Object.assign(new Error('Orphan archive cleanup requires explicit confirmDelete: true confirmation.'), {
        code: 'CONFIRMATION_REQUIRED',
      });
    }
    const stats = await this.getStorageStats({
      backupRoot,
      stateRoot,
      journal,
      sessions,
      backend,
      sessionPersistence,
      probeSessionExists,
      activeSessionIds,
      signal,
    });
    if (!stats.orphanProbeAvailable) {
      return {
        supported: false,
        deletedSessions: 0,
        freedBytes: 0,
        skippedCount: stats.sessionCount,
        reason: 'ORPHAN_PROBE_UNAVAILABLE',
      };
    }

    let deletedSessions = 0;
    let freedBytes = 0;
    let skippedCount = 0;
    const rootResolved = resolve(this.root);

    for (const item of stats.sessions) {
      signal?.throwIfAborted?.();
      if (item.status !== 'orphan' || !item.sessionId || !item.dirName) {
        skippedCount += 1;
        continue;
      }
      const targetDir = resolve(rootResolved, item.dirName);
      if (dirname(targetDir) !== rootResolved) {
        skippedCount += 1;
        continue;
      }
      // Double-check live session & journal right before rm to eliminate TOCTOU races.
      if (activeSessionIds?.has?.(item.sessionId) || sessions?.get?.(item.sessionId)) {
        skippedCount += 1;
        continue;
      }
      if (await checkPendingJournalForSession(item.sessionId, journal, dirname(rootResolved))) {
        skippedCount += 1;
        continue;
      }
      await rm(targetDir, { recursive: true, force: true });
      deletedSessions += 1;
      freedBytes += item.bytes;
    }

    return {
      supported: true,
      deletedSessions,
      freedBytes,
      skippedCount,
    };
  }
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sumDirectoryBytes(rootDir, signal = null, depth = 0) {
  if (depth > 8) return 0;
  let total = 0;
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    signal?.throwIfAborted?.();
    if (entry.isSymbolicLink?.()) continue;
    const p = join(rootDir, entry.name);
    if (entry.isFile()) {
      try { total += (await stat(p)).size; } catch {}
    } else if (entry.isDirectory()) {
      total += await sumDirectoryBytes(p, signal, depth + 1);
    }
  }
  return total;
}

async function scanSessionArchiveDir(dirPath, signal = null, depth = 0) {
  let bytes = 0;
  let mtimeMs = 0;
  let plainCount = 0;
  let plainBytes = 0;
  const spanFiles = [];
  if (depth > 4) return { bytes, mtimeMs, plainCount, plainBytes, spanFiles };
  let entries = [];
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return { bytes, mtimeMs, plainCount, plainBytes, spanFiles };
  }
  for (const entry of entries) {
    signal?.throwIfAborted?.();
    if (entry.isSymbolicLink?.()) continue;
    const p = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const sub = await scanSessionArchiveDir(p, signal, depth + 1);
      bytes += sub.bytes;
      if (sub.mtimeMs > mtimeMs) mtimeMs = sub.mtimeMs;
      continue;
    }
    if (!entry.isFile()) continue;
    let info;
    try { info = await stat(p); } catch { continue; }
    bytes += info.size;
    if (info.mtimeMs > mtimeMs) mtimeMs = info.mtimeMs;
    if (depth === 0 && entry.name !== 'index.jsonl') {
      if (entry.name.endsWith(SPAN_ZSTD_EXT)) {
        spanFiles.push({ name: entry.name, path: p, size: info.size, compressed: true });
      } else if (entry.name.endsWith(SPAN_PLAIN_EXT)) {
        plainCount += 1;
        plainBytes += info.size;
        spanFiles.push({ name: entry.name, path: p, size: info.size, compressed: false });
      }
    }
  }
  return { bytes, mtimeMs, plainCount, plainBytes, spanFiles };
}

async function readSpanHeaderOnly(filePath, compressed) {
  try {
    let text;
    if (compressed) {
      const buf = await readFile(filePath);
      text = (await zstdDecompress(buf)).toString('utf8');
    } else {
      const handle = await open(filePath, 'r');
      try {
        const buf = Buffer.alloc(65536);
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
        text = buf.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    }
    const line = text.split('\n', 1)[0]?.trim() ?? '';
    if (!line) return null;
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === 'object' && parsed.kind === 'compaction-weave/span') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveSessionIdForArchiveDir({ dirPath, dirName, spanFiles, stateRoot }) {
  const hashMatch = SHA256_HEX_RE.exec(dirName);
  const expectedHex = hashMatch ? hashMatch[1] : null;
  const ids = new Set();
  const ordered = [...spanFiles].sort((a, b) => (a.compressed === b.compressed ? 0 : a.compressed ? -1 : 1));
  for (const sf of ordered) {
    const header = await readSpanHeaderOnly(sf.path, sf.compressed);
    if (!header || typeof header.sessionId !== 'string' || !header.sessionId) continue;
    if (expectedHex && sha256Hex(header.sessionId) !== expectedHex) {
      return { sessionId: null, ambiguous: true };
    }
    ids.add(header.sessionId);
    if (ids.size > 1) return { sessionId: null, ambiguous: true };
  }
  if (ids.size === 1) {
    return { sessionId: [...ids][0], ambiguous: false };
  }
  if (expectedHex && stateRoot) {
    try {
      const raw = await readFile(join(stateRoot, `${expectedHex}.json`), 'utf8');
      const parsed = JSON.parse(raw);
      if (
        parsed?.kind === 'compaction-weave/state' &&
        typeof parsed.sessionId === 'string' &&
        parsed.sessionId.length > 0 &&
        sha256Hex(parsed.sessionId) === expectedHex
      ) {
        return { sessionId: parsed.sessionId, ambiguous: false };
      }
    } catch {}
  }
  return { sessionId: null, ambiguous: true };
}

async function checkPendingJournalForSession(sessionId, journal, storageRoot) {
  if (journal && typeof journal.pending === 'function') {
    try {
      const pending = await journal.pending(sessionId);
      if (Array.isArray(pending) && pending.length > 0) return true;
    } catch {
      return true;
    }
  }
  const jFile =
    typeof journal?.file === 'function'
      ? journal.file(sessionId)
      : join(storageRoot, 'journal', `${sha256Hex(sessionId)}.json`);
  try {
    await stat(jFile);
    return true;
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
}

async function probeHostSession({
  sessionId,
  probeSessionExists,
  sessions,
  backend,
  sessionPersistence,
  activeSessionIds,
  signal,
}) {
  if (activeSessionIds?.has?.(sessionId) || sessions?.get?.(sessionId)) {
    return 'active';
  }
  if (typeof probeSessionExists === 'function') {
    try {
      const res = await probeSessionExists(sessionId, { signal });
      if (res === true) return 'exists';
      if (res === false) return 'missing';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }
  const hasStat = typeof sessionPersistence?.stat === 'function';
  const hasFindLog = typeof backend?.findLog === 'function';
  if (!hasStat && !hasFindLog) return 'unavailable';
  if (hasStat) {
    try {
      const st = await sessionPersistence.stat(sessionId, signal ? { signal } : undefined);
      if (st) return 'exists';
    } catch (error) {
      if (error?.code !== 'ENOENT') return 'unknown';
    }
  }
  if (hasFindLog) {
    try {
      const found = await backend.findLog(sessionId, signal);
      if (found && (found.sourcePath || found.currentPath)) return 'exists';
    } catch (error) {
      if (error?.code !== 'ENOENT') return 'unknown';
    }
  }
  return 'missing';
}

function excerptAround(text, at, length) {
  const pad = 120;
  const from = Math.max(0, at - pad);
  const to = Math.min(text.length, at + length + pad);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < text.length ? '…' : '';
  return prefix + text.slice(from, to).replace(/\s+/g, ' ') + suffix;
}

/**
 * 内容校验和。不是密码学用途，只需要"改一个字节就能发现"。
 * 用 FNV-1a 32 位，纯 JS 无依赖、几十毫秒能算完几 MB。
 * @param {string} text
 */
function checksum(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= (text.charCodeAt(index) >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 把会话 surface 上的一段区间抽成可落盘的条目。
 *
 * ⚠️ 只存 `{seq, type, role, text}` 是不够的：`text` 是给搜索用的**投影**，
 * 图片块被压成 `[image]`、reasoning 被压成 `[reasoning]`、工具调用只留名字 ——
 * 压缩之后 surface 上已经没有原始事件了，归档是唯一的副本。一旦投影丢信息，
 * 就再也取不回来，而 `history_read` 还会把它当成"原文"给用户看。
 *
 * 所以每条额外保存：
 * - `blocks`：消息 content 的**结构化副本**（原样 JSON，不投影）；
 * - `source`：事件来源（含 checkpoint 的 compactionId / preserved 等）；
 * - `tool`：工具调用的 name / callId / arguments 或 tool-result 的 callId，
 *   让调用与结果能重新配对。
 * 选区条目保持原序作为前缀；随后追加其不可变工具来源闭包。不会把来源事件
 * 纳入实际替换范围，也不沿 checkpoint 来源扩张到整个会话历史。
 *
 * @param {object} session
 * @param {readonly number[]} seqs
 */
export function spanEntries(session, seqs, options = {}) {
  const allowForeignFallback = options?.allowForeignFallback === true;
  const { selected, sources } = historySourceSeqs(
    session,
    seqs,
    allowForeignFallback ? { allowForeignFallback: true } : undefined,
  );
  const entries = [];
  for (const seq of [...selected, ...sources]) {
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
    if (!event) throw new Error(`archive source event ${seq} is missing`);
    // A projection is allowed to omit output. Original results must come from
    // the immutable accepted event, including the entire pre-pruner content.
    const message = toolResultMessage(event) ??
      (typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : undefined);
    const rawText = messageToText(message) ?? eventToText(event);
    if (rawText === null && !allowForeignFallback) throw new Error(`archive source event ${seq} cannot be represented`);
    const text = rawText ?? '';
    const entry = {
      event: jsonSafeCopy(event),
      seq,
      type: typeof event.type === 'string' ? event.type : 'unknown',
      role: typeof message?.role === 'string' ? message.role : roleOfEvent(event),
      text,
      snapshot: { kind: 'historical-session-event', scope: entries.length < selected.length ? 'selected' : 'tool-source', currentFileVersion: 'not-checked' },
    };
    const blocks = structuralBlocks(message, event);
    if (blocks !== undefined) entry.blocks = blocks;
    const source = event?.data?.source ?? message?.source;
    if (source !== undefined && source !== null) entry.source = jsonSafeCopy(source);
    const tool = toolRefsOf(blocks);
    if (event.type === 'tool/result') {
      const callId = message?.toolCallId ?? message?.source?.callId;
      if (callId !== undefined) tool.push({ kind: 'result', callId });
    } else if (event.type === 'tool/call' && event.data?.callId !== undefined) {
      const ref = { kind: 'call', callId: event.data.callId };
      if (event.data.name !== undefined) ref.name = jsonSafeCopy(event.data.name);
      if (event.data.arguments !== undefined) ref.arguments = jsonSafeCopy(event.data.arguments);
      tool.push(ref);
    }
    if (tool.length > 0) entry.tool = tool;
    entries.push(entry);
  }
  return entries;
}

/** 结构化块副本：优先取消息 content，其次取事件 data 本身（tool/result 之类）。 */
function structuralBlocks(message, event) {
  const content = message?.content;
  if (Array.isArray(content)) return content.map((block) => jsonSafeCopy(block));
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const data = event?.data;
  if (data && typeof data === 'object') return [jsonSafeCopy(data)];
  return undefined;
}

/** 把工具调用与结果里的关联字段单独提出来，便于重新配对。 */
function toolRefsOf(blocks) {
  if (!Array.isArray(blocks)) return [];
  const refs = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool-call') {
      refs.push({
        kind: 'call',
        name: typeof block.name === 'string' ? block.name : undefined,
        callId: block.callId ?? block.toolCallId ?? block.id,
        arguments: jsonSafeCopy(block.arguments ?? block.args),
      });
    } else if (block.type === 'tool-result') {
      refs.push({
        kind: 'result',
        callId: block.callId ?? block.toolCallId ?? block.id,
      });
    }
  }
  return refs.filter((ref) => ref.callId !== undefined || ref.name !== undefined);
}

/**
 * 归档快照的最大嵌套深度。
 *
 * 宿主已经用无损 JSON 校验过事件数据（`dsh-llm/lib/typert.host.js` 的
 * `snapshotJsonValue` 接受任意深度的普通对象），所以这里遇到深结构是**正常**的，
 * 不是损坏。真正的风险是递归爆栈，用显式上限兜住。
 */
const MAX_SNAPSHOT_DEPTH = 64;

/**
 * 深拷贝成可无损 JSON 序列化的值。
 *
 * ⚠️ 超出资源上限时必须**显式失败**，不能悄悄写个 `null` 顶替原值。
 * 以前的写法是 `if (depth > 12) return null`：归档照写、校验和照算，
 * 磁盘上那份"完整归档"里已经躺着一片 null，而读回来的人看不出少了什么 ——
 * 这比拒绝归档糟得多，因为拒绝至少是可见的。
 *
 * 非 JSON 值、稀疏数组、特殊原型与循环均显式拒绝，不悄悄丢字段。
 */
function jsonSafeCopy(value, depth = 0, path = new Set()) {
  if (depth > MAX_SNAPSHOT_DEPTH) {
    const error = new Error(
      `archive snapshot exceeded the maximum nesting depth (${MAX_SNAPSHOT_DEPTH}); ` +
        'refusing to replace deeper values with null and call the archive complete',
    );
    error.code = 'SNAPSHOT_TOO_DEEP';
    throw error;
  }
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (typeof value !== 'object' || value === undefined) throw new Error('archive source is not lossless JSON');
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new Error('archive source is not a plain JSON object');

  if (path.has(value)) {
    const error = new Error('archive snapshot hit a circular reference; JSON cannot represent it losslessly');
    error.code = 'SNAPSHOT_CYCLIC';
    throw error;
  }
  path.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) if (!(i in value)) throw new Error('archive source has a sparse array');
      return value.map((item) => jsonSafeCopy(item, depth + 1, path));
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(out, key, { value: jsonSafeCopy(item, depth + 1, path), enumerable: true, writable: true, configurable: true });
    }
    return out;
  } finally {
    // 只挡**当前路径**上的环，同一个对象出现在兄弟分支是合法的 DAG，不该判错。
    path.delete(value);
  }
}

function roleOfEvent(event) {
  const type = event?.type;
  if (type === 'user/message') return 'user';
  if (type === 'assistant/message') return 'assistant';
  if (type === 'tool/result') return 'tool';
  if (type === 'system/message') return 'system';
  return 'other';
}

function messageToText(message) {
  if (!message || typeof message !== 'object') return null;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'tool-call') {
      parts.push(`[tool-call ${block.name ?? '?'}] ${safeJson(block.arguments ?? block.args)}`);
    }
    else if (block.type === 'tool-result') {
      parts.push(`[tool-result ${block.callId ?? block.toolCallId ?? '?'}] ${blocksToPlain(block.content)}`);
    }
    else if (typeof block.type === 'string') parts.push(`[${block.type}]`);
  }
  return parts.length === 0 ? null : parts.join('\n');
}

function eventToText(event) {
  if (!event || typeof event !== 'object') return null;
  const data = event.data;
  if (data === undefined) return null;
  if (typeof data === 'string') return data;
  if (typeof data === 'object' && typeof data.text === 'string') return data.text;
  return safeJson(data);
}

function blocksToPlain(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return safeJson(content);
  const parts = [];
  for (const block of content) {
    if (block && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length === 0 ? safeJson(content) : parts.join('\n');
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 三个回查工具的描述。真正的注册由 lib/tools.js 完成（需要宿主 tools 服务）。
 */
export const HISTORY_TOOLS = Object.freeze([
  {
    name: 'history_list',
    description:
      'List the archived spans produced by context compaction in this session (newest first). ' +
      'Each span contains the selected events and their original tool-result sources. ' + HISTORY_SNAPSHOT_WARNING,
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many spans to list. Default 20.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'history_read',
    description:
      'Read one archived compaction span verbatim. Use it when a summary is not enough and you need ' +
      'the exact original wording, code, error text or numbers. Non-text blocks (images, files, ' +
      'reasoning) are expanded with their real attachment references and their text, never just a ' +
      'length. Pass `seq` to jump straight to one entry, and `raw: true` for the full structured ' +
      'record (blocks/source/tool) instead of the flattened view. Original pre-pruner tool results can be found by their sourceEventSeqs or history_search. For archived attachments, pass attachmentId: archived images return verified compact metadata by default unless rawBase64: true is set; non-image files return verified base64 chunks via nextByteOffset. ' + HISTORY_SNAPSHOT_WARNING,
    parameters: {
      type: 'object',
      properties: {
        compactionId: { type: 'string', description: 'Span id from history_list.' },
        attachmentId: { type: 'string', description: 'Inspect or read this archived image/file by its sha256 id, scoped to this span. Images default to verified metadata unless rawBase64 is true.' },
        rawBase64: { type: 'boolean', description: 'With attachmentId on an archived image: return verified base64 byte chunks instead of compact metadata. Default false.' },
        byteOffset: { type: 'integer', minimum: 0, description: 'Attachment byte offset; follow nextByteOffset until null.' },
        byteLimit: { type: 'integer', minimum: 1, maximum: 32768, description: 'Maximum bytes per attachment chunk. Default 32768.' },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many entries. Default 0.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Entries to return. Default 40, or 20 when `raw` is set.',
        },
        seq: {
          type: 'integer',
          description: 'Read exactly this entry (the seq shown in extracted summaries and search hits).',
        },
        raw: {
          type: 'boolean',
          description: 'Return each entry as a JSON record with its blocks, source and tool references.',
        },
        charOffset: { type: 'integer', minimum: 0, description: 'With seq: character offset into the exact JSON record. Default 0.' },
        charLimit: { type: 'integer', minimum: 1, maximum: 60000, description: 'With seq: bounded characters per chunk; concatenate jsonChunk values to recover the record.' },
        full: {
          type: 'boolean',
          description: 'Inline the complete text of non-text blocks instead of truncating it.',
        },
      },
      required: ['compactionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'history_search',
    description:
      'Full-text search across every archived compaction span of this session. Returns short excerpts ' +
      'with the span id and seq so you can follow up with history_read. ' + HISTORY_SNAPSHOT_WARNING,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring to find.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max hits. Default 20.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
]);

/** Best-effort POSIX parent-directory fsync after atomic archive replacement or index update. */
async function syncDirBestEffort(dir) {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is unsupported on some platforms/filesystems; never interrupt commit.
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/** A complete span replaces its file only after the temporary file is fsynced. */
async function atomicArchiveWrite(file, content) {
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    if (typeof content === 'string') await handle.writeFile(content, 'utf8');
    else await handle.writeFile(content);
    await handle.sync(); await handle.close(); handle = null;
    await atomicReplace(temp, file);
    await syncDirBestEffort(dirname(file));
  } finally { if (handle) await handle.close().catch(() => {}); await rm(temp, { force: true }).catch(() => {}); }
}
