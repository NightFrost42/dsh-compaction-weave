import {atomicReplace} from './atomic-replace.js';
import { attachmentReferences, preserveAttachments, readAttachmentPage, statAttachment, verifyAttachment } from './attachments.js';
import { CompactBM25FIndex, prepareSpanForSearch, searchPreparedSpans } from './history-search.js';
import { MAX_SPAN_UNCOMPRESSED_BYTES, sessionDirectory } from './storage-path.js';
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
const MAX_INDEX_FILES = 5;
const MAX_INDEX_FILE_CHARS = 160;
const MAX_INDEX_LABEL_CHARS = 72;
const MAX_SEARCH_CACHE_SESSIONS = 8;

export { MAX_SPAN_UNCOMPRESSED_BYTES };

const ROOT_DIR_NAME = 'dsh-compaction-weave';

// 头部格式版本。读到别的版本说明这段归档不是当前代码写的 —— 字段含义可能变了，
// 不能按现在的规则解读它，也不能当成"内容完整"。
const SPAN_VERSION = 3;

export const HISTORY_SNAPSHOT_WARNING = 'Historical session snapshot; checksums verify archived bytes, not current workspace files (re-read files before editing).';

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

function normalizeIndexPath(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length > MAX_INDEX_FILE_CHARS || /[\r\n\x00-\x1f\x7f]/.test(cleaned)) return null;
  return cleaned;
}

function collectToolArgFiles(args, out) {
  let parsed = args;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return; }
  }
  if (!parsed || typeof parsed !== 'object') return;
  for (const key of ['path', 'filePath', 'file_path', 'file', 'target', 'filename', 'dest', 'source']) {
    const clean = normalizeIndexPath(parsed[key]);
    if (clean) out.add(clean);
    if (out.size >= MAX_INDEX_FILES) return;
  }
  if (Array.isArray(parsed.files)) {
    for (const item of parsed.files) {
      const clean = normalizeIndexPath(typeof item === 'string' ? item : (item?.path ?? item?.file_path ?? item?.filePath));
      if (clean) out.add(clean);
      if (out.size >= MAX_INDEX_FILES) return;
    }
  }
}

function firstArgHint(args) {
  let parsed = args;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return ''; }
  }
  if (!parsed || typeof parsed !== 'object') return '';
  for (const key of ['path', 'filePath', 'file_path', 'file', 'target', 'command', 'pattern', 'query']) {
    if (typeof parsed[key] === 'string' && parsed[key].trim().length > 0) {
      return parsed[key].trim().replace(/\s+/g, ' ');
    }
  }
  return '';
}

function sanitizeLabelCandidate(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return '';
  const stripped = raw
    .replace(/<compacted-summary>[\s\S]*?<\/compacted-summary>/gi, ' ')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<untrusted_reference\b[^>]*>[\s\S]*?<\/untrusted_reference>/gi, ' ')
    .replace(/<pinned-source-rules>[\s\S]*?<\/pinned-source-rules>/gi, ' ');
  for (const rawLine of stripped.split(/\r?\n/)) {
    const clean = rawLine.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    if (/^(?:History archive:|Archived files:|Folded archives:|Same-session continuation|\[Tool output|#+\s*$|[-=*]{3,}$|>)/.test(clean)) {
      continue;
    }
    if (clean.length <= MAX_INDEX_LABEL_CHARS) return clean;
    return `${clean.slice(0, MAX_INDEX_LABEL_CHARS - 1).trimEnd()}…`;
  }
  return '';
}

/**
 * Extract compact, zero-LLM index metadata (`startSeq`, `endSeq`, up to 5 `files`,
 * and deterministic short `label`) from archived span entries.
 *
 * @param {readonly any[]} entries
 * @param {{ files?: readonly string[], label?: string }} [extra]
 */
export function extractSpanIndexMetadata(entries, extra = {}) {
  const list = Array.isArray(entries) ? entries : [];
  let startSeq;
  let endSeq;
  const files = new Set();
  if (Array.isArray(extra?.files)) {
    for (const f of extra.files) {
      const clean = normalizeIndexPath(f);
      if (clean) files.add(clean);
      if (files.size >= MAX_INDEX_FILES) break;
    }
  }

  let userLabel = '';
  let toolLabel = '';
  let fallbackLabel = '';

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    if (Number.isSafeInteger(entry.seq) && entry.seq >= 0) {
      startSeq = startSeq === undefined ? entry.seq : Math.min(startSeq, entry.seq);
      endSeq = endSeq === undefined ? entry.seq : Math.max(endSeq, entry.seq);
    }
    if (files.size < MAX_INDEX_FILES) {
      if (Array.isArray(entry.tool)) {
        for (const ref of entry.tool) {
          if (ref?.kind === 'call') collectToolArgFiles(ref.arguments, files);
          if (files.size >= MAX_INDEX_FILES) break;
        }
      }
      if (files.size < MAX_INDEX_FILES && Array.isArray(entry.blocks)) {
        for (const block of entry.blocks) {
          if (block?.type === 'tool-call') collectToolArgFiles(block.arguments ?? block.args, files);
          if (files.size >= MAX_INDEX_FILES) break;
        }
      }
      if (files.size < MAX_INDEX_FILES && entry.event?.type === 'tool/call') {
        collectToolArgFiles(entry.event.data?.arguments, files);
      }
    }
    const isCheckpoint = entry.source?.kind === 'compact-checkpoint';
    if (!userLabel && entry.role === 'user' && !isCheckpoint && typeof entry.text === 'string') {
      userLabel = sanitizeLabelCandidate(entry.text);
    }
    if (!toolLabel && Array.isArray(entry.tool)) {
      const callRef = entry.tool.find((r) => r?.kind === 'call' && typeof r.name === 'string' && r.name.trim());
      if (callRef) {
        const hint = firstArgHint(callRef.arguments);
        const rawTool = hint ? `tool: ${callRef.name.trim()} ${hint}` : `tool: ${callRef.name.trim()}`;
        toolLabel = sanitizeLabelCandidate(rawTool);
      }
    }
    if (!fallbackLabel && !isCheckpoint && typeof entry.text === 'string') {
      fallbackLabel = sanitizeLabelCandidate(entry.text);
    }
  }

  const explicitLabel = typeof extra?.label === 'string' ? sanitizeLabelCandidate(extra.label) : '';
  const label = explicitLabel || userLabel || toolLabel || fallbackLabel || undefined;
  return {
    ...(startSeq !== undefined ? { startSeq } : {}),
    ...(endSeq !== undefined ? { endSeq } : {}),
    ...(files.size > 0 ? { files: [...files].slice(0, MAX_INDEX_FILES) } : {}),
    ...(label ? { label } : {}),
  };
}

export class CompactionArchive {
  /** @param {{ root?: string|null, maxDecompressedBytes?: number }} [options] */
  constructor(options = {}) {
    this.root = options.root ? resolve(options.root) : defaultArchiveRoot();
    this.maxDecompressedBytes =
      Number.isSafeInteger(options.maxDecompressedBytes) && options.maxDecompressedBytes > 0
        ? options.maxDecompressedBytes
        : MAX_SPAN_UNCOMPRESSED_BYTES;
    this._indexLocks = new Map();
    this._searchCache = new Map();
  }

  _invalidateSearchCache(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    this._searchCache.delete(sessionId);
  }

  _touchSearchSessionCache(sessionId) {
    let entry = this._searchCache.get(sessionId);
    if (entry) {
      this._searchCache.delete(sessionId);
      this._searchCache.set(sessionId, entry);
      return entry;
    }
    entry = { spans: new Map(), combinedSig: null, index: null };
    this._searchCache.set(sessionId, entry);
    while (this._searchCache.size > MAX_SEARCH_CACHE_SESSIONS) {
      const oldestKey = this._searchCache.keys().next().value;
      this._searchCache.delete(oldestKey);
    }
    return entry;
  }

  async _withIndexLock(sessionId, fn) {
    const key = String(sessionId ?? '');
    const prev = this._indexLocks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = prev.then(() => gate, () => gate);
    this._indexLocks.set(key, tail);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this._indexLocks.get(key) === tail) {
        this._indexLocks.delete(key);
      }
    }
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
  async writeSpan({ sessionId, compactionId, entries, signal, allowForeignFallback = false, files, label }) {
    try {
      signal?.throwIfAborted?.();
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
      signal?.throwIfAborted?.();
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
      signal?.throwIfAborted?.();
      await atomicArchiveWrite(file, compressed, signal);
      if (signal?.aborted) {
        await rm(file, { force: true }).catch(() => {});
        signal.throwIfAborted?.();
      }
      const meta = extractSpanIndexMetadata(entries, { files, label });
      await this._touchIndex(sessionId, compactionId, file, entries.length, meta);
      this._invalidateSearchCache(sessionId);
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

  async _touchIndex(sessionId, compactionId, file, count, meta = undefined) {
    return this._withIndexLock(sessionId, async () => {
      const dir = this.dirFor(sessionId);
      const indexPath = join(dir, 'index.jsonl');
      const payload = {
        compactionId,
        file,
        entries: count,
        at: new Date().toISOString(),
      };
      if (Number.isSafeInteger(meta?.startSeq) && meta.startSeq >= 0) payload.startSeq = meta.startSeq;
      if (Number.isSafeInteger(meta?.endSeq) && meta.endSeq >= 0) payload.endSeq = meta.endSeq;
      if (Array.isArray(meta?.files) && meta.files.length > 0) payload.files = meta.files.slice(0, MAX_INDEX_FILES);
      if (typeof meta?.label === 'string' && meta.label.trim().length > 0) payload.label = meta.label.trim();
      const line = JSON.stringify(payload);
      const handle = await open(indexPath, 'a', 0o600);
      try { await handle.writeFile(line + '\n', 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await syncDirBestEffort(dir);
    });
  }

  /**
   * Atomically remove both the archived span files and any `index.jsonl` entries
   * matching `compactionId` so aborted/rolled-back writes never leave ghost warnings.
   *
   * @param {string} sessionId
   * @param {string} compactionId
   * @returns {Promise<boolean>}
   */
  async deleteSpan(sessionId, compactionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
    if (typeof compactionId !== 'string' || compactionId.length === 0) return false;
    this._invalidateSearchCache(sessionId);
    const dir = this.dirFor(sessionId);
    const seg = safeSegment(compactionId);
    await rm(join(dir, `${seg}${SPAN_ZSTD_EXT}`), { force: true }).catch(() => {});
    await rm(join(dir, `${seg}${SPAN_PLAIN_EXT}`), { force: true }).catch(() => {});

    return this._withIndexLock(sessionId, async () => {
      const indexPath = join(dir, 'index.jsonl');
      let raw;
      try {
        raw = await readFile(indexPath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') {
          this._invalidateSearchCache(sessionId);
          return true;
        }
        throw error;
      }
      const kept = [];
      let removedAny = false;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === 'object' && parsed.compactionId === compactionId) {
            removedAny = true;
            continue;
          }
        } catch {
          // Preserve corrupt/unparseable lines verbatim so `_readIndex` still detects corruption.
        }
        kept.push(line);
      }
      if (removedAny) {
        const nextText = kept.length > 0 ? `${kept.join('\n')}\n` : '';
        await atomicArchiveWrite(indexPath, nextText);
      }
      this._invalidateSearchCache(sessionId);
      return true;
    });
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

  async _collectSpanInventory(sessionId, { includeStatMeta = false } = {}) {
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
    const indexedMeta = (record) => {
      const out = {};
      if (Number.isSafeInteger(record?.entries) && record.entries >= 0) out.entries = record.entries;
      if (Number.isSafeInteger(record?.startSeq) && record.startSeq >= 0) out.startSeq = record.startSeq;
      if (Number.isSafeInteger(record?.endSeq) && record.endSeq >= 0) out.endSeq = record.endSeq;
      if (Array.isArray(record?.files) && record.files.length > 0) {
        const cleanFiles = record.files.filter((f) => typeof f === 'string' && f.trim().length > 0).slice(0, MAX_INDEX_FILES);
        if (cleanFiles.length > 0) out.files = cleanFiles;
      }
      if (typeof record?.label === 'string' && record.label.trim().length > 0) out.label = record.label.trim();
      return out;
    };
    const statFields = (info) =>
      includeStatMeta
        ? {
            mtimeMs: info?.mtimeMs ?? null,
            ctimeMs: info?.ctimeMs ?? null,
            ino: info?.ino ?? null,
          }
        : {};
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
          ...statFields(resolved.info),
          ...indexedMeta(record),
        });
      } else {
        spans.push({
          compactionId: id,
          path: fallbackPath,
          bytes: 0,
          modified: record?.at ?? '',
          present: false,
          ...statFields(null),
          ...indexedMeta(record),
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
            ...statFields(info),
          });
        } catch {
          spans.push({
            compactionId: id,
            path,
            bytes: 0,
            modified: '',
            present: false,
            ...statFields(null),
          });
        }
      }
    }

    spans.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
    return spans;
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
    return this._collectSpanInventory(sessionId, { includeStatMeta: false });
  }

  async _listSpansForSearch(sessionId) {
    return this._collectSpanInventory(sessionId, { includeStatMeta: true });
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
      const maxOutputLength =
        Number.isSafeInteger(options?.maxDecompressedBytes) && options.maxDecompressedBytes > 0
          ? options.maxDecompressedBytes
          : this.maxDecompressedBytes;
      try {
        const plainBuf = await zstdDecompress(compressedBuf, { maxOutputLength });
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
   * Locate the archived span containing `seq` (using indexed `[startSeq, endSeq]` hints
   * first and falling back to unindexed/legacy spans). Reports unreadable spans on miss.
   *
   * @param {string} sessionId
   * @param {number} seq
   * @returns {Promise<{found:boolean, compactionId?:string, result?:any, unreadable:Array<{compactionId:string, reason:string}>}>}
   */
  async findSpanBySeq(sessionId, seq) {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      return { found: false, unreadable: [] };
    }
    const spans = await this.listSpans(sessionId);
    const unreadable = [];
    const seen = new Set();

    const tryRead = async (span) => {
      seen.add(span.compactionId);
      if (span.present === false) {
        unreadable.push({ compactionId: span.compactionId, reason: 'missing' });
        return null;
      }
      const result = await this.readSpan(sessionId, span.compactionId, { verifyAttachments: 'stat' });
      if (!result?.ok) {
        unreadable.push({ compactionId: span.compactionId, reason: result?.reason ?? 'unknown' });
      }
      const entries = Array.isArray(result?.entries) ? result.entries : [];
      if (entries.some((entry) => entry?.seq === seq)) {
        return { found: true, compactionId: span.compactionId, result, unreadable };
      }
      return null;
    };

    const indexedMatches = [];
    const legacyOrUnbounded = [];
    const nonMatchingIndexed = [];
    for (const span of spans) {
      const hasBounds = Number.isSafeInteger(span?.startSeq) && Number.isSafeInteger(span?.endSeq);
      if (hasBounds) {
        if (seq >= span.startSeq && seq <= span.endSeq) indexedMatches.push(span);
        else nonMatchingIndexed.push(span);
      } else {
        legacyOrUnbounded.push(span);
      }
    }

    for (const span of indexedMatches) {
      const hit = await tryRead(span);
      if (hit) return hit;
    }
    for (const span of legacyOrUnbounded) {
      if (seen.has(span.compactionId)) continue;
      const hit = await tryRead(span);
      if (hit) return hit;
    }
    for (const span of nonMatchingIndexed) {
      if (span.present === false) {
        unreadable.push({ compactionId: span.compactionId, reason: 'missing' });
      }
    }
    return { found: false, unreadable };
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
    const queryStr = String(query ?? '');
    if (queryStr.trim().length === 0) return { hits: [], scanned: 0, unreadable: [] };

    const spans = await this._listSpansForSearch(sessionId);
    const sessionCache = this._touchSearchSessionCache(sessionId);
    const unreadable = [];
    const preparedSpans = [];
    const activeCompactionIds = new Set();
    const sigParts = [];
    let scanned = 0;
    let allCompleteFromCache = true;

    for (const span of spans) {
      if (span.present === false) {
        // 索引说这一段存在过，文件却不见了。它当然扫不到，但"扫不到"
        // 不等于"里面没有" —— 必须记进 unreadable，让调用方说话时留余地。
        scanned += 1;
        unreadable.push({ compactionId: span.compactionId, reason: 'missing' });
        sessionCache.spans.delete(span.compactionId);
        allCompleteFromCache = false;
        continue;
      }
      activeCompactionIds.add(span.compactionId);
      const sig = `${span.compactionId}\0${span.path}\0${span.bytes}\0${span.mtimeMs ?? ''}\0${span.ctimeMs ?? ''}\0${span.ino ?? ''}`;
      const cached = sessionCache.spans.get(span.compactionId);
      if (cached && cached.sig === sig) {
        let attachmentsOk = true;
        if (cached.attachmentRefs.length > 0) {
          const spanDir = this.dirFor(sessionId);
          try {
            for (const ref of cached.attachmentRefs) {
              await statAttachment(spanDir, ref);
            }
          } catch {
            attachmentsOk = false;
          }
        }
        if (attachmentsOk) {
          scanned += 1;
          preparedSpans.push(cached.prepared);
          sigParts.push(sig);
          continue;
        }
      }
      allCompleteFromCache = false;
      const read = await this.readSpan(sessionId, span.compactionId, { verifyAttachments: 'stat' });
      scanned += 1;
      if (read?.ok === true) {
        const prepared = prepareSpanForSearch({
          compactionId: span.compactionId,
          entries: Array.isArray(read.entries) ? read.entries : [],
        });
        const attachmentRefs =
          read.header?.version === 3 && Array.isArray(read.header?.attachments)
            ? read.header.attachments
            : [];
        sessionCache.spans.set(span.compactionId, { sig, prepared, attachmentRefs });
        preparedSpans.push(prepared);
        sigParts.push(sig);
      } else {
        sessionCache.spans.delete(span.compactionId);
        const reason = read?.reason ?? 'unknown';
        unreadable.push({ compactionId: span.compactionId, reason });
        if (Array.isArray(read?.entries) && read.entries.length > 0) {
          preparedSpans.push(
            prepareSpanForSearch({
              compactionId: span.compactionId,
              entries: read.entries,
              incomplete: reason,
            }),
          );
        }
      }
    }

    for (const cachedId of sessionCache.spans.keys()) {
      if (!activeCompactionIds.has(cachedId)) {
        sessionCache.spans.delete(cachedId);
      }
    }

    if (preparedSpans.length === 0) {
      if (unreadable.length > 0) {
        sessionCache.combinedSig = null;
        sessionCache.index = null;
      }
      return { hits: [], scanned, unreadable };
    }

    if (unreadable.length === 0) {
      const combinedSig = sigParts.join('\n');
      let index = allCompleteFromCache && sessionCache.combinedSig === combinedSig ? sessionCache.index : null;
      if (!index) {
        index = new CompactBM25FIndex(preparedSpans);
        sessionCache.combinedSig = combinedSig;
        sessionCache.index = index;
      }
      const result = index.search(queryStr, { limit, excerptFn: excerptAround });
      return { hits: Array.isArray(result?.hits) ? result.hits : [], scanned, unreadable };
    }

    sessionCache.combinedSig = null;
    sessionCache.index = null;
    const result = searchPreparedSpans(preparedSpans, queryStr, { limit, excerptFn: excerptAround });
    return { hits: Array.isArray(result?.hits) ? result.hits : [], scanned, unreadable };
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
          const decompressed = await zstdDecompress(zstdDiskBuf, { maxOutputLength: this.maxDecompressedBytes });
          if (Buffer.compare(decompressed, rawPlainBuf) !== 0) {
            throw new Error('zstd roundtrip buffer mismatch');
          }
          const readCheck = await this.readSpan(sid, header.compactionId, { verifyAttachments: 'stat' });
          if (!readCheck.ok) {
            throw new Error(`compressed readSpan failed: ${readCheck.reason ?? 'unknown'}`);
          }

          await this._touchIndex(
            sid,
            header.compactionId,
            zstdPath,
            header.entries,
            extractSpanIndexMetadata(readCheck.entries),
          );
          await rm(plainPath);
          this._invalidateSearchCache(sid);
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
      this._invalidateSearchCache(item.sessionId);
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

async function readSpanHeaderOnly(filePath, compressed, maxDecompressedBytes = MAX_SPAN_UNCOMPRESSED_BYTES) {
  try {
    let text;
    if (compressed) {
      const buf = await readFile(filePath);
      text = (await zstdDecompress(buf, { maxOutputLength: maxDecompressedBytes })).toString('utf8');
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
    description: 'List archived compaction spans for this session (newest first).',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max spans (default 20).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'history_read',
    description:
      'Read archived span, entry, or attachment. Pass compactionId (optional if seq is set); raw:true returns JSON; attachmentId (+compactionId) inspects image metadata (rawBase64:true for bytes) or file chunks.',
    parameters: {
      type: 'object',
      properties: {
        compactionId: { type: 'string', description: 'Span id (optional if seq set).' },
        attachmentId: { type: 'string', description: 'Archived sha256 id (needs compactionId).' },
        rawBase64: { type: 'boolean', description: 'Return image base64 instead of metadata.' },
        byteOffset: { type: 'integer', minimum: 0, description: 'Attachment byte offset.' },
        byteLimit: { type: 'integer', minimum: 1, maximum: 32768, description: 'Max attachment bytes (default 32768).' },
        offset: { type: 'integer', minimum: 0, description: 'Entries to skip (default 0).' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Max entries (default 40, raw 20).',
        },
        seq: {
          type: 'integer',
          description: 'Target entry seq (auto-resolves span).',
        },
        raw: {
          type: 'boolean',
          description: 'Return raw JSON records.',
        },
        charOffset: { type: 'integer', minimum: 0, description: 'JSON chunk char offset (with seq).' },
        charLimit: { type: 'integer', minimum: 1, maximum: 60000, description: 'Max chars per jsonChunk (with seq).' },
        full: {
          type: 'boolean',
          description: 'Inline full non-text block text.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'history_search',
    description: 'Search archived spans (exact + BM25F); returns excerpts with compactionId and seq for history_read.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max hits (default 20).' },
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
async function atomicArchiveWrite(file, content, signal) {
  signal?.throwIfAborted?.();
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    if (typeof content === 'string') await handle.writeFile(content, 'utf8');
    else await handle.writeFile(content);
    await handle.sync(); await handle.close(); handle = null;
    signal?.throwIfAborted?.();
    await atomicReplace(temp, file);
    await syncDirBestEffort(dirname(file));
  } finally { if (handle) await handle.close().catch(() => {}); await rm(temp, { force: true }).catch(() => {}); }
}
