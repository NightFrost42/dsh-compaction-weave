// 三个回查工具的注册。
//
// 压缩会把原文从 surface 上换掉，但原文已经落盘（lib/history.js）。这三个
// 工具让模型自己把丢掉的东西捞回来 —— 这是 Claude Code「摘要里带 transcript
// 路径」那条思路在 DSH 里的等价物。
//
// 注册走宿主注入的 `ctx.tools`，不 import `@deepseek-ai/dsh-tools`：
// 插件目录按真实路径解析，裸导入会在加载期失败。

import { CompactionArchive, HISTORY_TOOLS } from './history.js';

/**
 * @param {object} ctx
 * @param {Readonly<Record<string, any>>} config
 * @param {CompactionArchive} [archive]
 */
export function registerHistoryTools(ctx, config, archive) {
  const tools = ctx?.tools;
  if (!tools || typeof tools.register !== 'function') return false;
  if (!config?.archiveEnabled) return false;

  const store = archive ?? new CompactionArchive({ root: config?.archiveDir });

  let registered = 0;
  for (const spec of HISTORY_TOOLS) {
    try {
      tools.register({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        // 宿主的 `register()` 强制要求 `output.render` 是函数，否则直接抛
        // `tool "x" must declare output { schema, render, presentationMeta? }`。
        // 少了它三个工具会全部注册失败，而且只在日志里留一行 warn —— 用户
        // 侧表现就是"装了但模型看不到 history_* 工具"。
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value ?? '') }],
        },
        timeoutMs: 15000,
        execute: (args, exec) => runTool(spec.name, store, args ?? {}, exec),
      });
      registered += 1;
    } catch (error) {
      ctx.logger?.warn?.(`[compaction-weave] failed to register ${spec.name}: ${error?.message ?? error}`);
    }
  }

  if (registered > 0) {
    ctx.logger?.info?.(`[compaction-weave] registered ${registered} history tool(s)`);
  }
  return registered === HISTORY_TOOLS.length;
}

async function runTool(toolName, store, args, exec) {
  const sessionId = resolveSessionId(exec);
  if (sessionId === null) {
    return 'history tools are only available inside an agent session.';
  }

  if (toolName === 'history_list') {
    const limit = clampInt(args.limit, 20, 1, 100);
    let spans;
    try { spans = await store.listSpans(sessionId); } catch (error) { return `Archive listing incomplete: ${error.message}`; }
    if (spans.length === 0) return 'No archived compaction spans in this session yet.';
    return spans
      .slice(0, limit)
      .map((span) => `${span.compactionId}  ${span.modified ?? '?'}  bytes=${span.bytes ?? '?'}`)
      .join('\n');
  }

  if (toolName === 'history_read') {
    const compactionId = typeof args.compactionId === 'string' ? args.compactionId : '';
    if (compactionId.length === 0) return 'history_read requires a compactionId (see history_list).';
    if (args.attachmentId !== undefined) {
      try {
        if (typeof args.attachmentId !== 'string') throw new Error('attachmentId must be a string');
        return JSON.stringify(await store.readAttachment(sessionId, compactionId, args.attachmentId, args.byteOffset ?? 0, args.byteLimit ?? 32768, exec?.signal));
      } catch (error) { return `Cannot read archived attachment: ${error.message}`; }
    }
    // `seq` 是**精确读取入口**：有它就不按 offset 猜页，直接把那一条捞出来。
    // 摘要/引用里只知道 seq 号、不知道它是第几条，按 offset 翻页找等于让调用方
    // 自己数 —— 100 条以上的跨度根本没法用。
    if (args.seq !== undefined && (!Number.isSafeInteger(args.seq) || args.seq < 0)) return 'history_read seq must be a non-negative safe integer.';
    const onlySeq = args.seq ?? null;
    const raw = args.raw === true;
    const full = args.full === true;
    // `raw` 一定要分页：结构化原文没有体积上限，一次全给会直接把上下文撑爆。
    const limit = raw
      ? clampInt(args.limit, 20, 1, RAW_PAGE_LIMIT)
      : clampInt(args.limit, 40, 1, 200);
    let result;
    try {
      result = await store.readSpan(sessionId, compactionId);
    } catch (error) {
      return `Cannot read ${compactionId}: ${error?.message ?? error}`;
    }
    const entries = Array.isArray(result?.entries) ? result.entries : [];
    // ⚠️ 归档不完整时必须**说出来**，不能只给能读到的那部分。
    // 回查的人是在补记忆，他不知道原文有多少条；悄悄少几条，他就会把"部分"
    // 当"全部"，比直接报错危险得多。
    const warning = result?.ok ? '' : formatDamage(compactionId, result);
    if (entries.length === 0) {
      return warning.length > 0 ? warning : `No entries found for ${compactionId}.`;
    }

    if (onlySeq !== null) {
      const matched = entries.filter((entry) => entry?.seq === onlySeq);
      if (matched.length === 0) {
        const available = entries.map((entry) => entry?.seq).filter((seq) => typeof seq === 'number');
        const range = available.length === 0 ? '?' : `${Math.min(...available)}..${Math.max(...available)}`;
        return `No entry with seq ${onlySeq} in ${compactionId} (this span holds seq ${range}; ${entries.length} entries).${warning}`;
      }
      const entry = matched[0];
      const json = JSON.stringify(entry);
      if (raw || json.length > 60000 || args.charOffset !== undefined || args.charLimit !== undefined) {
        const offset = clampInt(args.charOffset, 0, 0, json.length);
        const length = clampInt(args.charLimit, 60000, 1, 60000);
        const next = Math.min(offset + length, json.length);
        // Valid JSON envelope at every page boundary, even in the middle of a record.
        return JSON.stringify({ compactionId, seq: onlySeq, verified: result.ok === true, warning, encoding: 'JSON text; concatenate jsonChunk values then JSON.parse', charOffset: offset, totalChars: json.length, nextCharOffset: next < json.length ? next : null, jsonChunk: json.slice(offset, next) });
      }
      return `${warning}# ${compactionId} seq ${onlySeq} (1 of ${entries.length} entries)\n\n${formatEntry(entry, { compactionId, raw, full })}`;
    }

    const offset = clampInt(args.offset, 0, 0, 100000);
    const page = entries.slice(offset, offset + limit);
    if (page.length === 0) {
      return `No entries for ${compactionId} at offset ${offset} (total ${entries.length}).${warning}`;
    }
    const header = `# ${compactionId} (entries ${offset + 1}-${offset + page.length} of ${entries.length})${raw ? ' [raw]' : ''}`;
    const rendered = [];
    let chars = 0;
    for (const entry of page) {
      const text = formatEntry(entry, { compactionId, raw, full });
      if (text.length > RAW_CHAR_BUDGET) {
        rendered.push(`Entry seq ${entry.seq} exceeds the page budget. Read history_read compactionId=${compactionId} seq=${entry.seq} raw=true charOffset=0 charLimit=60000 and follow nextCharOffset; no record has been cut.`);
      } else if (chars + text.length <= RAW_CHAR_BUDGET) {
        rendered.push(text); chars += text.length;
      } else break;
    }
    const nextOffset = offset + rendered.length;
    const more = nextOffset < entries.length ? `\n\nNext page: offset=${nextOffset} (whole records only).` : '';
    return `${warning}${header}\n\n${rendered.join('\n\n')}${more}`;
  }

  if (toolName === 'history_search') {
    const query = typeof args.query === 'string' ? args.query : '';
    if (query.trim().length === 0) return 'history_search requires a non-empty query.';
    const limit = clampInt(args.limit, 20, 1, 100);
    let result;
    try { result = await store.search(sessionId, query, { limit }); } catch (error) { return `Archive search incomplete: ${error.message}. The query may exist in unreadable history.`; }
    const hits = Array.isArray(result?.hits) ? result.hits : Array.isArray(result) ? result : [];
    // ⚠️ "没搜到"只有在**所有归档都完整读进来**时才能当结论。
    // 有归档读不完整时，那一段里完全可能就有这条 —— 此时说
    // `No archived span contains "X"` 是在用一个更糟的错误回答
    // 用户的补记忆请求：他会以为这条约束从来没存在过。
    const unreadable = Array.isArray(result?.unreadable) ? result.unreadable : [];
    const caveat = unreadable.length === 0
      ? ''
      : `\n\n⚠️ ${unreadable.length} archived span(s) could not be read completely (${unreadable
          .map((item) => `${item.compactionId}: ${item.reason}`)
          .join(', ')}); the query may exist in the unreadable part.`;
    if (hits.length === 0) {
      return unreadable.length === 0
        ? `No archived span contains "${query}".`
        : `No readable archived span contains "${query}".${caveat}`;
    }
    return (
      hits
        .map((hit) => {
          const mark = hit.incomplete ? ' ⚠️(incomplete archive)' : '';
          return `[${hit.compactionId} seq=${hit.seq ?? '?'} ${hit.role ?? ''}]${mark} ${hit.excerpt}`;
        })
        .join('\n\n') + caveat
    );
  }

  return `Unknown tool: ${toolName}`;
}

function resolveSessionId(exec) {
  const candidates = [
    exec?.session?.id,
    exec?.agent?.session?.id,
    exec?.context?.session?.id,
    exec?.sessionId,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function formatEntry(entry, options = {}) {
  const seq = entry?.seq ?? '?';
  const type = entry?.type ?? 'event';
  const text = typeof entry?.text === 'string' && entry.text.length > 0 ? entry.text : '(no textual content)';
  const extra = [];
  // 工具调用与结果必须能重新配对：压缩之后 surface 上已经没有原始事件，
  // 归档里只留一句 `[tool-call foo]` 的话，"这次调用返回了什么"就永久丢失了。
  if (Array.isArray(entry?.tool)) {
    for (const ref of entry.tool) {
      if (!ref || typeof ref !== 'object') continue;
      const id = ref.callId ?? '?';
      if (ref.kind === 'call') extra.push(`tool-call ${ref.name ?? '?'} id=${id}`);
      else if (ref.kind === 'result') extra.push(`tool-result id=${id}`);
    }
  }
  // 非文本块（图片 / reasoning / 附件）在 `text` 里只剩占位符，
  // 这里把它们的真实结构列出来，否则"原文"其实缺了这些内容却看不出来。
  if (Array.isArray(entry?.blocks)) {
    for (const block of entry.blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') continue;
      const detail = nonTextSummary(block, { ...options, seq });
      if (detail !== null) extra.push(detail);
    }
  }
  const meta = extra.length === 0 ? '' : `\n(${extra.join('; ')})`;
  const head = `--- seq ${seq} [${type}] ---\n${text}${meta}`;
  return options.raw === true ? `${head}\n${rawRecord(entry)}` : head;
}

/** 默认视图里 reasoning 正文最多内联这么多字符，超出的走 `seq=` 精确读取。 */
const INLINE_TEXT_LIMIT = 1000;
/** `raw: true` 时一次最多返回这么多条 —— 结构化原文没有体积上限，必须设桩。 */
const RAW_PAGE_LIMIT = 20;
/** `raw: true` 时单次响应的结构化 JSON 总字符预算。 */
const RAW_CHAR_BUDGET = 120000;

/**
 * 给非文本块一句能追溯的摘要（类型 + 关键定位字段 + 可回查正文）。
 *
 * ⚠️ 两条历史教训都写在这里：
 * 1. 宿主的 `ImageBlock` 是 `{ type:'image', attachment: {...} }`，真实引用在
 *    **`block.attachment`** 下；只查顶层字段会让一张图退化成 `non-text block: image`，
 *    回查的人拿着这句话既找不到文件、也不知道它多大。
 * 2. `ReasoningBlock` 的正文就在 `block.text`，以前被换成 `text=23 chars` ——
 *    推理内容恰恰是回查时最需要的一句"模型当时怎么想的"，只给长度等于丢失。
 *
 * 顶层字段仍然照旧输出（有些插件把 `mimeType`/`url` 直接写在块顶上），
 * 所以老的断言形状不变；附件字段随后追加，长度/尺寸用数字原样给。
 *
 * @param {object} block
 * @param {{ compactionId?: string, seq?: number|string, full?: boolean }} [options]
 * @returns {string|null}
 */
function nonTextSummary(block, options = {}) {
  const type = typeof block.type === 'string' ? block.type : 'block';
  const bits = [];
  for (const key of ['mimeType', 'mediaType', 'url', 'path', 'filename', 'name', 'attachmentId', 'id']) {
    const value = block[key];
    if (typeof value === 'string' && value.length > 0) bits.push(`${key}=${value}`);
  }

  // 宿主规范：图片/文件的真实引用在 `block.attachment` 下。
  const attachment = block.attachment;
  if (attachment !== null && typeof attachment === 'object' && !Array.isArray(attachment)) {
    for (const key of ['attachmentId', 'mediaType', 'name', 'bytes', 'width', 'height']) {
      const value = attachment[key];
      if (typeof value === 'string' && value.length > 0) bits.push(`attachment.${key}=${value}`);
      else if (typeof value === 'number' && Number.isFinite(value)) bits.push(`attachment.${key}=${value}`);
    }
  }

  // 正文必须给出来（reasoning 的思维链、附件的提取文本都在这里）。
  // 只给长度是 V8-09 的原始形态：回查的人拿不到内容，等于没归档。
  if (typeof block.text === 'string' && block.text.length > 0) {
    const text = block.text;
    if (options.full === true || text.length <= INLINE_TEXT_LIMIT) {
      bits.push(`text=${JSON.stringify(text)}`);
    } else {
      // 截断时必须给**精确读取入口**，否则"给个长度"这件事只是换了个说法。
      const pointer = options.compactionId
        ? ` (full text: history_read compactionId=${options.compactionId} seq=${options.seq} full=true)`
        : '';
      bits.push(`text=${JSON.stringify(text.slice(0, INLINE_TEXT_LIMIT))}+${text.length - INLINE_TEXT_LIMIT} more chars${pointer}`);
    }
  }

  return bits.length === 0 ? `non-text block: ${type}` : `non-text block: ${type} (${bits.join(', ')})`;
}

/**
 * 一条归档记录的完整结构化形态（含 `blocks` / `source` / `tool`）。
 * 用缩进 JSON 输出，便于回查时逐字段核对，而不是只看到被 formatEntry 压平的那一行。
 */
function rawRecord(entry) {
  const record = { seq: entry?.seq ?? null, type: entry?.type ?? null, role: entry?.role ?? null };
  if (entry?.blocks !== undefined) record.blocks = entry.blocks;
  if (entry?.source !== undefined) record.source = entry.source;
  if (entry?.event !== undefined) record.event = entry.event;
  if (entry?.tool !== undefined) record.tool = entry.tool;
  if (typeof entry?.text === 'string') record.text = entry.text;
  return '```json\n' + JSON.stringify(record, null, 2) + '\n```';
}

/**
 * 把 `readSpan` 的损坏状态翻译成给人看的一句话。
 * 每种原因都要说清"缺的是什么"，而不是统一一句"读取失败"。
 */
function formatDamage(compactionId, result) {
  const reason = result?.reason;
  const head = `⚠️ Archive ${compactionId} is INCOMPLETE — the text below is only part of the original span.\n`;
  if (reason === 'missing') return `${head}The file does not exist (it may have been deleted or never written).\n\n`;
  if (reason === 'unreadable') return `${head}The file exists but could not be read (permissions or I/O error).\n\n`;
  if (reason === 'damaged') {
    const lines = Array.isArray(result?.damaged) ? result.damaged.slice(0, 20).join(', ') : '?';
    return `${head}${result.damaged?.length ?? '?'} line(s) are not valid JSON and were skipped (line ${lines}).\n\n`;
  }
  if (reason === 'truncated') {
    return `${head}The file records ${result.expected} entries but only ${result.actual} are present — it was cut short.\n\n`;
  }
  if (reason === 'checksum') {
    return `${head}Entries do not match the checksum in the header — the content was modified after it was written.\n\n`;
  }
  if (reason === 'version') {
    return `${head}The header declares format version ${String(result?.actual)} but this build reads version ${String(result?.expected)} — the file may come from a different release, so its fields cannot be interpreted safely.\n\n`;
  }
  if (reason === 'identity') {
    return `${head}The header says this span belongs to ${String(result?.actual?.sessionId)}/${String(result?.actual?.compactionId)}, not to the span you asked for (${String(result?.expected?.sessionId)}/${String(result?.expected?.compactionId)}) — the file was moved or renamed.\n\n`;
  }
  if (reason === 'bytes') {
    return `${head}The header records ${String(result?.expected)} bytes but the entries occupy ${String(result?.actual)} — the body was rewritten.\n\n`;
  }
  return `${head}No integrity header is present, so completeness cannot be verified.\n\n`;
}

function clampInt(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const v = Math.round(value);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/**
 * 只给测试用的入口。三个 handler 是纯函数（store, args, exec → string），
 * 直接单测比去合成一个宿主 tools 服务靠谱得多 —— 后者测的是桩，不是逻辑。
 */
export const __test = { runTool };
