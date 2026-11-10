import {atomicReplace} from './atomic-replace.js';
import { attachmentReferences, preserveAttachments, readAttachmentPage } from './attachments.js';
import { sessionDirectory } from './storage-path.js';
// 被压掉的原文落盘 + 三个回查工具。
//
// 压缩前归档完整原文，模型通过 history 工具按序号和关键词读取细节。
//
// 落盘位置：<DSH_HOME>/storages/dsh-compaction-weave/sessions/<sessionId>/<compactionId>.jsonl
// 每行保留完整 event、blocks/source/tool 及检索文本；宿主接纳的附件字节单独 SHA-256 归档。

import { mkdir, readFile, readdir, writeFile, appendFile, stat, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT_DIR_NAME = 'dsh-compaction-weave';

// 头部格式版本。读到别的版本说明这段归档不是当前代码写的 —— 字段含义可能变了，
// 不能按现在的规则解读它，也不能当成"内容完整"。
const SPAN_VERSION = 3;

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
  async writeSpan({ sessionId, compactionId, entries, signal }) {
    try {
      const dir = this.dirFor(sessionId);
      await mkdir(dir, { recursive: true });
      const attachments = await preserveAttachments(dir, entries, this.attachments, signal);
      const file = join(dir, `${safeSegment(compactionId)}.jsonl`);
      // 第一行是**头部**：写清版本、条数与校验和。没有它，读的时候没法区分
      // "这个段本来就只有 3 条"和"文件被截断了"。校验和覆盖所有条目原文，
      // 用来发现"行数对得上但内容被改过"的情况。
      const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
      const header = JSON.stringify({
        kind: 'compaction-weave/span',
        attachments,
        version: SPAN_VERSION,
        compactionId,
        sessionId,
        entries: entries.length,
        bytes: Buffer.byteLength(body, 'utf8'),
        checksum: checksum(body),
        at: new Date().toISOString(),
      });
      await atomicArchiveWrite(file, `${header}\n${body}\n`);
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
    const owned = attachmentReferences(span.entries).find(item => item.ref.attachmentId === attachmentId);
    if (!owned) throw new Error('attachment does not belong to this span');
    return readAttachmentPage(this.dirFor(sessionId), owned.ref, offset, limit, signal);
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
    const handle = await open(indexPath, 'a');
    try { await handle.writeFile(line + '\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
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

    const seen = new Set();
    const spans = [];
    for (const record of indexed) {
      const id = record?.compactionId;
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
      seen.add(id);
      const path = join(dir, `${safeSegment(id)}.jsonl`);
      let info;
      try {
        info = await stat(path);
      } catch {
        info = undefined;
      }
      spans.push({
        compactionId: id,
        path,
        bytes: info?.size ?? 0,
        modified: info?.mtime?.toISOString() ?? record?.at ?? '',
        present: info !== undefined,
      });
    }

    if (readable) {
      for (const name of names) {
        if (!name.endsWith('.jsonl') || name === 'index.jsonl') continue;
        const id = name.slice(0, -'.jsonl'.length);
        if (seen.has(id)) continue;
        seen.add(id);
        const path = join(dir, name);
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
  async readSpan(sessionId, compactionId) {
    const file = join(this.dirFor(sessionId), `${safeSegment(compactionId)}.jsonl`);
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      return { ok: false, entries: [], reason: error?.code === 'ENOENT' ? 'missing' : 'unreadable' };
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
        const refs = attachmentReferences(entries);
        const expected = refs.map(({type,ref}) => ({type,attachmentId:ref.attachmentId,bytes:ref.bytes}));
        if (JSON.stringify(expected) !== JSON.stringify(header.attachments)) throw new Error('attachment manifest mismatch');
        for (const {ref} of refs) await readAttachmentPage(this.dirFor(sessionId), ref, 0, 1);
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
      const read = await this.readSpan(sessionId, span.compactionId);
      scanned += 1;
      if (!read?.ok) {
        unreadable.push({ compactionId: span.compactionId, reason: read?.reason ?? 'unknown' });
      }
      const entries = Array.isArray(read?.entries) ? read.entries : [];
      for (const entry of entries) {
        const text = [entry?.text ?? '', JSON.stringify(entry?.blocks ?? []), JSON.stringify(entry?.source ?? {}), JSON.stringify(entry?.tool ?? [])].join('\n');
        const at = text.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        hits.push({
          compactionId: span.compactionId,
          seq: entry.seq,
          role: entry.role,
          excerpt: excerptAround(text, at, needle.length),
          // 命中的段本身不完整时带出来：搜到一条不等于这段原文是完整的。
          ...(read?.ok ? {} : { incomplete: read?.reason ?? 'unknown' }),
        });
        if (hits.length >= limit) return { hits, scanned, unreadable };
      }
    }
    return { hits, scanned, unreadable };
  }
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
 *
 * @param {object} session
 * @param {readonly number[]} seqs
 */
export function spanEntries(session, seqs) {
  const entries = [];
  for (const seq of seqs) {
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
    if (!event) throw new Error(`archive source event ${seq} is missing`);
    const message =
      typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : undefined;
    const text = messageToText(message) ?? eventToText(event);
    if (text === null) throw new Error(`archive source event ${seq} cannot be represented`);
    const entry = {
      event: jsonSafeCopy(event),
      seq,
      type: typeof event.type === 'string' ? event.type : 'unknown',
      role: typeof message?.role === 'string' ? message.role : roleOfEvent(event),
      text,
    };
    const blocks = structuralBlocks(message, event);
    if (blocks !== undefined) entry.blocks = blocks;
    const source = event?.data?.source ?? message?.source;
    if (source !== undefined && source !== null) entry.source = jsonSafeCopy(source);
    const tool = toolRefsOf(blocks);
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
      'Each span is the verbatim original text that a compaction summary replaced.',
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
      'record (blocks/source/tool) instead of the flattened view. For archived image/file bytes, pass attachmentId and follow nextByteOffset; concatenate decoded base64 chunks.',
    parameters: {
      type: 'object',
      properties: {
        compactionId: { type: 'string', description: 'Span id from history_list.' },
        attachmentId: { type: 'string', description: 'Read this archived image/file by its sha256 id as verified base64 chunks, scoped to this span.' },
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
      'with the span id and seq so you can follow up with history_read.',
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

/** A complete span replaces its file only after the temporary file is fsynced. */
async function atomicArchiveWrite(file, text) {
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle;
  try {
    handle = await open(temp, 'wx'); await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close(); handle = null;
    await atomicReplace(temp, file);
  } finally { if (handle) await handle.close().catch(() => {}); await rm(temp, { force: true }).catch(() => {}); }
}
