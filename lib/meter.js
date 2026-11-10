// 最小 StreamChunk 折叠器。
//
// 官方用的是 `@deepseek-ai/dsh-llm` 里的 `BlockAssembler`，但那个包在本机
// 解析不到（本地插件是 junction 装的，真实路径下没有 node_modules），所以
// 这里自带一份。
//
// ⚠️ 不能因为"摘要只要纯文本"就只认 `text-delta`。宿主的 `BlockAssembler`
// （`dsh-llm/lib/index.js:954-1025`、`dsh-llm/lib/types/assembler.js:34-108`）
// 对同一个 index 有两套文本来源，**block-end 携带的 block 是终态、优先于
// 已累积的 delta**：
//
//   case 'block-end': {
//     const partial = this.ensure(chunk.index, chunk.block.type);
//     if (partial.block) return;   // 首次关闭生效，后来的重关闭忽略
//     partial.block = chunk.block;
//     return;
//   }
//   assemble(partial) { if (partial.block) return partial.block; ... }
//
// 也就是说存在两种合法流：
//   ① 只有 block-start + block-end（block.text 是完整文本，没有任何 delta）
//   ② delta 是草稿、block-end 的 block.text 才是定稿（覆盖 delta）
//
// 只折叠 delta 会分别导致"有完整文本却报空摘要"和"提交了草稿"。所以这里
// 按 index 维护 partial，关闭的块取终态、未关闭的文本块才折叠 delta，
// 与宿主逐条对齐。
//
// 协议依据 docs/subsystems/llm-streaming.md：
//   - chunk 类型：text-delta / reasoning-delta / tool-arg-delta / block-start /
//     block-end / usage / finish
//   - usage 必须在 finish 之前；finish 之后不得再有 chunk
//   - 失败有两条合法路径：stream() 直接 throw，或结束流时发 finish{kind:'error'|'aborted'}

/**
 * 没有 `index` 的 chunk 共用的 partial 键。
 * 用 Symbol 而不是数字，避免和真实 index 撞键。
 */
const ANONYMOUS_BLOCK = Symbol('anonymous-block');

export class SummaryAssembler {
  constructor() {
    /**
     * index → { blockType, text, block }
     * `block` 一旦被 block-end 填上就是终态，后续同 index 的 delta 一律忽略。
     * @type {Map<number, {blockType:string, text:string, block:any}>}
     */
    this._partials = new Map();
    /** 流里出现过的 index，按首次出现顺序。 @type {number[]} */
    this._order = [];
    /** @type {string[]} */
    this._reasoning = [];
    /** @type {number} */
    this._reasoningChars = 0;
    /** @type {{inputTokens?:number, outputTokens?:number, cacheReadTokens?:number, cacheWriteTokens?:number}|null} */
    this.usage = null;
    /** @type {{kind:string, failure?:unknown}|null} */
    this.finish = null;
    this._chunkCount = 0;
  }

  /** @param {any} chunk */
  push(chunk) {
    if (!chunk || typeof chunk !== 'object') return;
    this._chunkCount += 1;
    const change = { textChanged: false, reasoningChanged: false };

    switch (chunk.type) {
      case 'block-start': {
        this._ensure(chunk.index, chunk.blockType);
        break;
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const text = chunk.text ?? chunk.delta ?? chunk.content;
        const isText = chunk.type === 'text-delta';
        const partial = this._ensure(chunk.index, isText ? 'text' : 'reasoning');
        // 已被 block-end 关闭：迟到的 delta 属于畸形流，忽略（宿主同样处理）。
        if (partial.block) break;
        if (typeof text === 'string' && text.length > 0) {
          partial.text += text;
          if (isText) change.textChanged = true;
          else change.reasoningChanged = true;
        }
        if (!isText && typeof text === 'string') {
          this._reasoning.push(text);
          this._reasoningChars += text.length;
        }
        break;
      }
      case 'block-end': {
        const block = chunk.block;
        if (!block || typeof block !== 'object' || typeof block.type !== 'string') break;
        const partial = this._ensure(chunk.index, block.type);
        // 首次关闭生效；重关闭忽略，避免后来的畸形块覆盖已定稿内容。
        if (partial.block) break;
        if (typeof block.text === 'string' && block.text.length > 0 && block.text !== partial.text) {
          if (block.type === 'text') change.textChanged = true;
          if (block.type === 'reasoning') change.reasoningChanged = true;
        }
        partial.block = block;
        break;
      }
      case 'usage': {
        // ⚠️ 这里只能放**已定义的数值字段**。宿主 `session.append` 用
        // `snapshotJsonValue` 做无损 JSON 校验（`dsh-session/lib/index.js:1523`），
        // 它不像 `JSON.stringify` 那样把 undefined 丢掉，而是直接判定
        // "non-JSON-serializable data" 并抛错。而宿主自己的 `mapUsage`
        // （`dsh-llm-pi-ai/lib/index.js:1439-1446`）恰恰在缓存为 0 时会
        // **省略** `cacheReadTokens` / `cacheWriteTokens` —— 也就是说，
        // 一个完全合法的 usage 经过无条件四字段重建后，就会让压缩在提交阶段
        // 失败，只留下 compaction/start 和一个报错的 compaction/end。
        const u = chunk.usage ?? chunk;
        this.usage = compactUsage({
          inputTokens: pickNumber(u.inputTokens, u.input_tokens, u.promptTokens),
          outputTokens: pickNumber(u.outputTokens, u.output_tokens, u.completionTokens),
          totalTokens: pickNumber(u.totalTokens, u.total_tokens),
          cacheReadTokens: pickNumber(u.cacheReadTokens, u.cache_read_input_tokens),
          cacheWriteTokens: pickNumber(u.cacheWriteTokens, u.cache_creation_input_tokens),
        });
        break;
      }
      case 'finish': {
        // finish 的形态在不同适配器/版本里有三种：
        //   { type:'finish', kind:'max-tokens' }
        //   { type:'finish', reason:{ kind:'max-tokens', failure? } }
        //   { type:'finish', finishReason:'max-tokens' }
        const reason = chunk.reason;
        const kind =
          typeof chunk.kind === 'string'
            ? chunk.kind
            : typeof reason === 'string'
              ? reason
              : typeof reason?.kind === 'string'
                ? reason.kind
                : typeof chunk.finishReason === 'string'
                  ? chunk.finishReason
                  : 'stop';
        const failure = chunk.failure ?? chunk.error ?? reason?.failure ?? reason?.error;
        this.finish = { kind, failure };
        break;
      }
      // tool-call-delta / tool-arg-delta：摘要不需要工具调用回放，忽略。
      default:
        break;
    }
    return change;
  }

  /**
   * 取（或建）某个 index 的 partial，与宿主 `ensure` 同义。
   *
   * ⚠️ 缺 `index` 的 chunk 必须落进**同一个** partial，不能每条都新建。
   * 宿主用 `partials.get(chunk.index)`：`undefined` 也是个普通键，
   * 所有没带 index 的 delta 都累加进那一份。这里若拿"当前序号"当键，
   * 两个连续的 `{type:'text-delta', text:'你'}` / `{text:'好'}` 会变成
   * 两个块，拼出来是 `你\n好` —— 一份被无声切成两半的正文。
   * @param {any} index
   * @param {string} blockType
   */
  _ensure(index, blockType) {
    const key = typeof index === 'number' ? index : ANONYMOUS_BLOCK;
    let partial = this._partials.get(key);
    if (!partial) {
      partial = { blockType, text: '', block: null };
      this._partials.set(key, partial);
      this._order.push(key);
    }
    return partial;
  }

  /**
   * 把单个 partial 折叠成块，与宿主 `assemble` 同义：
   * 已关闭的取终态 block，未关闭的文本块用累积 delta。
   * @param {{blockType:string, text:string, block:any}} partial
   */
  _assemble(partial) {
    if (partial.block) return partial.block;
    switch (partial.blockType) {
      case 'text':
        return { type: 'text', text: partial.text };
      case 'reasoning':
        return { type: 'reasoning', text: partial.text };
      default:
        // 未关闭的非文本块（tool-call 等）：摘要用不到，返回 null 由调用方跳过。
        return null;
    }
  }

  /** 是否已经有可见正文。 */
  get hasText() {
    return this.blocks().some(
      (block) => block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0,
    );
  }

  /**
   * 纯文本正文，按流顺序拼接。
   *
   * ⚠️ 块之间必须用换行连接，与 `blocksToText` 完全一致。
   * 这里曾经用空串 `join('')`：模型把九个 Markdown 小节各放在一个 text 块里、
   * 每块末尾不带换行时，拼出来就是 `## 1. …## 2. …## 3. …` 一整行 ——
   * 提交前的行首标题校验只会看到第 1 节，另外 8 节全被判成"缺失"，
   * 一份完全合法的摘要被拒绝。生成、校验、审计、存储必须共用**同一个**
   * 文本表示，否则"校验通过"和"存进去的东西"根本不是同一份。
   */
  get text() {
    return blocksToText(this.blocks());
  }

  get reasoningChars() {
    return this._reasoningChars;
  }

  get chunkCount() {
    return this._chunkCount;
  }

  /**
   * 折成 ContentBlock[]，按流顺序，**保留所有可组装的块类型**。
   *
   * ⚠️ 这里不能只留 text。摘要内容政策要做两件不同的事：
   * 图片块必须像宿主一样**显式拒绝**（`UNSUPPORTED_CONTENT`），
   * 而"先过滤掉再检查"等于把该报的错吞了 —— 模型输出了图片，
   * 插件却当成纯文本摘要提交成功，用户拿到一份缺内容的检查点。
   * 所以过滤交给调用方（`summaryText`）做，这里如实反映流里有什么。
   * 只有"未关闭且不属于 text/reasoning"的块才返回 null（tool-call 之类）。
   */
  blocks() {
    const out = [];
    for (const key of this._order) {
      const partial = this._partials.get(key);
      if (!partial) continue;
      const block = this._assemble(partial);
      if (!block) continue;
      out.push(block);
    }
    return out;
  }

  /**
   * 按官方 `finishError` 的语义把异常 finish 转成 throw。
   * @throws {Error}
   */
  throwIfFailed() {
    const finish = this.finish;
    if (finish === null) return;
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      const failure = finish.failure;
      const message =
        (failure && typeof failure === 'object' && typeof failure.message === 'string'
          ? failure.message
          : typeof failure === 'string'
            ? failure
            : null) ?? `summarization stream ended with ${finish.kind}`;
      const error = new Error(message);
      error.code =
        (failure && typeof failure === 'object' && typeof failure.code === 'string'
          ? failure.code
          : finish.kind === 'aborted'
            ? 'ABORTED'
            : 'STREAM_ERROR');
      if (failure !== undefined) error.cause = failure;
      throw error;
    }
    if (finish.kind === 'max-tokens') {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)');
      error.code = 'MAX_TOKENS';
      throw error;
    }
  }
}

function pickNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * 去掉值为 `undefined` 的键，得到一个**可被宿主无损 JSON 快照**接受的 usage 对象。
 *
 * `session.append` 走的是 `snapshotJsonValue`，它把 `undefined` 视为
 * 不可序列化（而不是像 `JSON.stringify` 那样跳过），所以任何值为 undefined
 * 的字段都必须在这里剔除。全部字段都缺失时返回 `null`，让调用方整段省略。
 *
 * @param {{inputTokens?:number, outputTokens?:number, totalTokens?:number, cacheReadTokens?:number, cacheWriteTokens?:number}} raw
 * @returns {{inputTokens?:number, outputTokens?:number, totalTokens?:number, cacheReadTokens?:number, cacheWriteTokens?:number}|null}
 */
export function compactUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
      count += 1;
    }
  }
  return count === 0 ? null : out;
}

/**
 * 粗估 token：CJK 按 1 字 ≈ 1 token，其余按 4 字符 ≈ 1 token。
 * 只用于"摘要是否比原文小"这类相对判断，不用于绝对预算。
 *
 * ⚠️ 这不是真实分词。宿主 `tokenMeter.estimateMessage` 同样是固定 4 字符/token
 * 加结构开销（`dsh-token-meter/lib/index.js:615-667`），两者都只是估算。
 * 任何"请求一定落在窗口内"的结论都不能建立在这个数上。
 *
 * @param {string} text
 */
export function approxTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * 从 ContentBlock[] 里抽纯文本。
 * @param {readonly any[]|undefined} blocks
 */
export function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * 官方 `summaryText` 的等价实现：**只拒绝图片**，其余块一律滤成 text。
 *
 * 宿主实现（`dsh-compaction-basic/lib/index.js:370-374`）：
 * ```js
 * function summaryText(blocks) {
 *   if (contentHasImage(blocks)) throw new LlmError("compaction summary cannot contain image output", "UNSUPPORTED_CONTENT");
 *   return blocks.filter((block) => block.type === "text");
 * }
 * ```
 * `contentHasImage` 只判 `block.type === "image"`（`dsh-llm/lib/index.js:593-595`）。
 *
 * ⚠️ 不能顺手把 reasoning 一起拒掉。开思考的模型先吐 `thinking_start/delta/end`
 * （pi-ai 映射成 reasoning 块）再吐正文是**正常流形态**，不是畸形流：
 * 宿主会接受这种摘要，而这里一旦报 `UNSUPPORTED_CONTENT`，
 * 三级目标链会连着三个都失败，用户看到的是"摘要模型全部失败"，
 * 实际每个模型都好好答完了。内部推理不进检查点是对的（它不该被存下来），
 * 但"不存"和"当作不支持内容拒绝"是两件完全不同的事。
 *
 * @param {readonly any[]} blocks
 * @returns {readonly {type:'text', text:string}[]}
 */
export function summaryText(blocks) {
  if (!Array.isArray(blocks)) {
    const error = new Error('summarization produced no text summary content');
    error.code = 'EMPTY_SUMMARY';
    throw error;
  }
  if (blocks.some((block) => block && typeof block === 'object' && block.type === 'image')) {
    const error = new Error('compaction summary cannot contain image output');
    error.code = 'UNSUPPORTED_CONTENT';
    throw error;
  }
  const text = blocksToText(blocks);
  if (text.trim().length === 0) {
    const error = new Error('summarization produced no text summary content');
    error.code = 'EMPTY_SUMMARY';
    throw error;
  }
  return [{ type: 'text', text }];
}
