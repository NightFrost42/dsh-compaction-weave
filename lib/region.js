import {collectProgressFacts, renderProgressFacts, renderSummaryScope} from './progress-facts.js';
import {collectWorkReport, renderWorkReport, scopeWorkReport} from './work-report.js';
// 选区、边界校验、工具配对平衡、提交。
//
// 这些逻辑照抄官方 `dsh-compaction-basic` 的对应函数语义（已逐行读过
// `@deepseek-ai/dsh-compaction-basic@0.2.1-rc.5/lib/index.js:396-675`），
// 因为宿主对 surface 的约束是硬的：
//   - 压缩区间的两端必须落在「工具调用/结果配对平衡」的位置，否则会把一次
//     工具调用切成两半，模型看到孤立的 tool_result 就会崩。
//   - 区间必须在 surface 上找得到，且 start 的位置不能晚于 end。
//   - 提交方式是：先 append 一条 `compaction/summary`，再 append 一条
//     `user/message`，后者带 `surfaceOp: {op:'replace', startSeq, endSeq}`。
//
// 与官方的差异（本插件的 L5）：提交时把「最近 N 条用户消息原文」拼在摘要
// 之后一起写进那条 user/message，这样用户原话永远不会被摘要改写。

import {isReferenceContextKind, sourceKindOf} from './source-provenance.js';
import {projectSummaryMessage} from './reference-input.js';
import {hasPreviousCancellation, selectMemoryMessages, boundMemoryQuotes, removeConsumedCancellations, restoreMemorySource} from './memory-policy.js';
import {sourceLayout} from './source-refs.js';
const balanceCacheBySession = new WeakMap();

/**
 * 本地估算，避免为了一个 4 行的工具函数去 import 另一个模块（region.js 被
 * engine.js 引用，保持零内部依赖能减少循环引用风险）。
 * 与 lib/meter.js 的 approxTokens 保持同一口径：CJK 1 字≈1 token，其余 4 字符≈1 token。
 */
function approxTokensLocal(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0x2e80 && code <= 0x9fff) cjk += 1;
    else if (code >= 0xac00 && code <= 0xd7af) cjk += 1;
    else if (code >= 0xf900 && code <= 0xfaff) cjk += 1;
  }
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

function eventDelta(event) {
  if (!event || typeof event !== 'object') return 0;
  if (event.type === 'assistant/message') {
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) return 0;
    let count = 0;
    for (const block of content) {
      if (block && block.type === 'tool-call') count += 1;
    }
    return count;
  }
  if (event.type === 'tool/result') return -1;
  return 0;
}

function surfaceNodes(session) {
  const nodes = session?.surface?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

function buildBalanceCache(session) {
  const nodes = surfaceNodes(session);
  const indexBySeq = new Map();
  /** @type {number[]} */
  const inProgress = [0];
  let running = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    const seq = nodes[i];
    indexBySeq.set(seq, i);
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
    running += eventDelta(event);
    if (running < 0) {
      throw new Error(
        `tool-pairing balance: tool/result at surface seq ${seq} has no matching tool-call (corrupt surface)`,
      );
    }
    inProgress.push(running);
  }
  return {
    generation: session?.surface?.replaceGeneration ?? 0,
    length: nodes.length,
    indexBySeq,
    // cutBalanced[i] = 在 nodes[i] 之前切开是否平衡（i 从 0 到 length）
    cutBalanced: inProgress.map((n) => n === 0),
  };
}

function balanceCache(session) {
  const generation = session?.surface?.replaceGeneration ?? 0;
  const cached = balanceCacheBySession.get(session);
  if (cached !== undefined && cached.generation === generation && cached.length === surfaceNodes(session).length) {
    return cached;
  }
  const fresh = buildBalanceCache(session);
  balanceCacheBySession.set(session, fresh);
  return fresh;
}

/** 在 `seq` 之前切开是否平衡（即 seq 是某个 cut 的起点）。 */
export function toolPairingBalancedBefore(session, seq) {
  const cache = balanceCache(session);
  const index = cache.indexBySeq.get(seq);
  if (index === undefined) throw new Error(`tool-pairing balance: surface seq ${seq} not found`);
  return cache.cutBalanced[index] === true;
}

/** 在 `seq` 之后切开是否平衡（即 seq 是某个 cut 的终点）。 */
export function toolPairingBalancedAfter(session, seq) {
  const cache = balanceCache(session);
  const index = cache.indexBySeq.get(seq);
  if (index === undefined) throw new Error(`tool-pairing balance: surface seq ${seq} not found`);
  return cache.cutBalanced[index + 1] === true;
}

/** 会话首条是不是 system/message；是则压缩区间要从第二条开始。 */
export function systemHead(session, headSeq) {
  if (typeof session.eventAt !== 'function') return undefined;
  const event = session.eventAt(headSeq);
  if (!event || event.type !== 'system/message') return undefined;
  return event;
}

/**
 * 官方 `selectCompactableRange` 的等价实现。
 *
 * @param {object} session
 * @param {{ nodes: readonly number[], pricedNodes?: readonly {seq:number, tokens:number}[] }} measurement
 * @param {number} retainTokens
 * @returns {{ start: number, end: number }|null}
 */
export function selectCompactableRange(session, measurement, retainTokens) {
  const nodes = surfaceNodes(session);
  const measured = measurement?.nodes;
  if (!Array.isArray(measured) || measured.length !== nodes.length) {
    throw new Error('compaction: token-meter surface does not match the current session surface');
  }

  // `ctx.tokenMeter.measure()` 返回的 `nodes[]` 元素是
  // `{ seq, tokens, heuristicTokens }`（不是裸 seq 数字）。这里同时接受两种形态：
  // 数字与对象，避免宿主口径不同时在这一行抛错。
  const seqAt = (index) => {
    const node = measured[index];
    if (typeof node === 'number') return node;
    if (node && typeof node === 'object' && typeof node.seq === 'number') return node.seq;
    return undefined;
  };
  for (let i = 0; i < nodes.length; i += 1) {
    if (seqAt(i) !== nodes[i]) {
      throw new Error('compaction: token-meter surface does not match the current session surface');
    }
  }
  if (nodes.length === 0) return null;

  const firstIdx = systemHead(session, nodes[0]) === undefined ? 0 : 1;
  if (firstIdx >= nodes.length) return null;

  // 先把带价节点建成 Map：`find()` 在长会话里是 O(n²)，
  // 上万条消息时会把事件循环卡住（bili 的 slow-session 就是这么来的）。
  const pricedBySeq = new Map();
  if (measurement.pricedBySeq instanceof Map) {
    for (const [seq, tokens] of measurement.pricedBySeq) {
      if (typeof seq === 'number' && typeof tokens === 'number') pricedBySeq.set(seq, tokens);
    }
  }
  for (const node of measured) {
    if (!node || typeof node !== 'object' || typeof node.seq !== 'number') continue;
    if (typeof node.tokens === 'number' && Number.isFinite(node.tokens)) {
      pricedBySeq.set(node.seq, node.tokens);
    }
  }
  if (Array.isArray(measurement.pricedNodes)) {
    for (const node of measurement.pricedNodes) {
      if (node && typeof node.seq === 'number' && typeof node.tokens === 'number') {
        pricedBySeq.set(node.seq, node.tokens);
      }
    }
  }

  // pricedNodes 缺失或不完整时退化成按文本长度估算，否则 `kept` 永远是 0，
  // 保留区会被算成"没有"，结果一路压到只留第一条。
  const tokensOf = (seq) => {
    const priced = pricedBySeq.get(seq);
    if (typeof priced === 'number' && priced > 0) return priced;
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
    const message =
      typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : undefined;
    const text = textOfMessage(message);
    return text === null ? 0 : approxTokensLocal(text);
  };

  // 从尾部往前累加，直到攒够保留额度；keepFromIdx 之前的部分可以压。
  //
  // 注意 `retainTokens === 0` 的语义：官方实现里循环体至少跑一次
  // （`accumulated >= retainTokens` 在 retainTokens=0 时立刻为真），所以
  // **最后一条 surface 节点永远被保留**。手动 `/compact` 传的就是 0，如果这里
  // 也按 0 处理成"一条都不留"，checkpoint 会把整段历史（含最后一轮）全换掉，
  // 模型下一轮就完全看不到刚才发生了什么。这里逐字对齐官方。
  let keepFromIdx = nodes.length;
  let kept = 0;
  for (let index = nodes.length - 1; index >= firstIdx; index -= 1) {
    kept += tokensOf(nodes[index]);
    keepFromIdx = index;
    if (kept >= retainTokens) break;
  }

  // 边界必须落在工具配对平衡处，否则往前退。
  while (keepFromIdx > firstIdx && !toolPairingBalancedBefore(session, nodes[keepFromIdx])) {
    keepFromIdx -= 1;
  }
  if (keepFromIdx <= firstIdx) return null;

  return { start: nodes[firstIdx], end: nodes[keepFromIdx - 1] };
}

/**
 * 官方 `validateSurfaceRegion` 的等价实现，报错原文保持一致，便于对照日志。
 */
export function validateSurfaceRegion(session, start, end) {
  const nodes = surfaceNodes(session);
  const startIdx = nodes.indexOf(start);
  const endIdx = nodes.indexOf(end);
  if (startIdx < 0) throw new Error(`compactRegion: start seq ${start} not found in surface`);
  if (endIdx < 0) throw new Error(`compactRegion: end seq ${end} not found in surface`);
  if (startIdx > endIdx) {
    throw new Error(
      `compactRegion: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`,
    );
  }
  if (!toolPairingBalancedBefore(session, start)) {
    throw new Error(
      `compactRegion: start seq ${start} is not a balanced boundary (would split a step's tool-call/result pair)`,
    );
  }
  if (!toolPairingBalancedAfter(session, end)) {
    throw new Error(
      `compactRegion: end seq ${end} is not a balanced boundary (would split a step, or the step is still open)`,
    );
  }
}

/**
 * 扫描会话尾部，判断当前是否已经有一轮压缩在进行、是否有未闭合的 turn。
 * 官方 `inspectCompactionEntryState` 的等价实现。
 * @param {object} session
 */
export function inspectCompactionEntryState(session) {
  const seq = typeof session?.seq === 'number' ? session.seq : 0;
  let openTurnSeq = null;
  let openTurn = null;
  let unmatchedCompactionStart = null;
  let latestEndSeedSeq = null;

  for (let cursor = seq - 1; cursor >= 0; cursor -= 1) {
    const event = typeof session.eventAt === 'function' ? session.eventAt(cursor) : undefined;
    if (!event) continue;
    if (latestEndSeedSeq === null && event.type === 'session/end-seed') latestEndSeedSeq = cursor;
    if (unmatchedCompactionStart === null) {
      if (event.type === 'compaction/end') {
        unmatchedCompactionStart = false;
      } else if (event.type === 'compaction/start') {
        unmatchedCompactionStart = cursor;
      }
    }
    if (openTurn === null) {
      if (event.type === 'turn/end') {
        openTurn = false;
      } else if (event.type === 'turn/start') {
        // ⚠️ turn 身份是 `event.data.turn`（一个从 1 递增的小整数），
        // **不是**事件序号。把 cursor 当成 turn 写进 compaction/start 会让
        // 宿主的 turn 归属错位（seq=42 的 turn 可能实际是第 3 轮）。
        openTurnSeq = cursor;
        const raw = event.data?.turn;
        openTurn = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
      }
    }
    if (openTurn !== null && unmatchedCompactionStart !== null && latestEndSeedSeq !== null) break;
  }

  return {
    openTurn: openTurn === false ? null : openTurn,
    openTurnSeq,
    unmatchedCompactionStart: unmatchedCompactionStart === false ? null : unmatchedCompactionStart,
    latestEndSeedSeq,
  };
}

/**
 * 会话上是否已经挂着一把压缩锁。
 *
 * 官方语义（`assertCompactionInactive(unmatchedCompactionStart, latestEndSeedSeq, stage)`）：
 * 只有当「未闭合的 compaction/start」比「最近一次 session/end-seed」更**新**时，
 * 才算锁还活着。否则说明那是上一个会话生命周期里崩掉留下的孤儿锁 —— 这时候
 * 必须放行，否则一次崩溃会让这个会话永远压不动（用户感知就是"再也不压缩了，
 * 一路涨到 413"）。
 *
 * @param {number|null} unmatchedCompactionStart
 * @param {number|null} [latestEndSeedSeq]
 * @param {string} [stage]
 */
export function assertCompactionInactive(unmatchedCompactionStart, latestEndSeedSeq, stage = 'compaction') {
  if (unmatchedCompactionStart === null || unmatchedCompactionStart === undefined) return;
  if (latestEndSeedSeq !== null && latestEndSeedSeq !== undefined && latestEndSeedSeq > unmatchedCompactionStart) {
    // 孤儿锁：属于更早的会话生命周期，不再阻塞本次压缩。
    return;
  }
  const error = new Error(
    `${stage}: compaction already in progress; the session compaction lock is already active`,
  );
  error.code = 'busy';
  throw error;
}

/**
 * 把被压缩区间里的消息抽出来，作为摘要调用的输入。
 * 官方 `buildSummarizationInput` 的等价实现。
 *
 * @param {object} session
 * @param {readonly number[]} shadowedSeqs
 */
export function buildSummarizationInput(session, shadowedSeqs, options = {}) {
  const nodes = surfaceNodes(session);
  const head = nodes.length > 0 ? systemHead(session, nodes[0]) : undefined;
  const system =
    head !== undefined && typeof session.deriveEventMessage === 'function'
      ? session.deriveEventMessage(head)
      : null;

  const messages = [];
  for (const seq of shadowedSeqs) {
    if (typeof session.deriveEventMessage !== 'function') break;
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
    if (!event) continue;
    const message = projectSummaryMessage(session, event, session.deriveEventMessage(event));
    if (message !== null && message !== undefined) messages.push(message);
  }

  const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined;
  const tools = header?.tools;
  const progress=shadowedSeqs.length?(options.selectProgress??(seqs=>collectProgressFacts(session,seqs)))(shadowedSeqs):null;
  const input = { messages: system === null ? messages : [system, ...messages], workReport:scopeWorkReport(collectWorkReport(session,shadowedSeqs),progress), progress };
  if (Array.isArray(tools) && tools.length > 0) input.tools = [...tools];
  return input;
}

/**
 * Collect exact original source messages from a span, including checkpoint
 * references. This raw-source helper is unbounded unless limits are supplied;
 * production selection/deduplication uses selectSessionMemory afterwards.
 * Source fragments are recovered from durable events, not generated summaries.
 * Text blocks retain their original whitespace and code fences.
 *
 * @param {object} session
 * @param {readonly number[]} spanSeqs  即将被摘要覆盖的 seq（按 surface 顺序）
 * @param {{ maxMessages?: number|null, maxTokens?: number|null, approxTokens?: (text:string)=>number, instructionsOnly?: boolean }} [options]
 * @returns {{ seq: number, blocks: {type:'text', text:string}[], text: string }[]}
 */
function restoreCheckpointMemory(session, checkpoint, original, ref) {
  try { return restoreMemorySource(original,ref); }
  catch(error) {
    if(ref.layout||error.code!=='MEMORY_SOURCE_UNAVAILABLE')throw error;
    // Older continuation checkpoints stored a constraint-only projection under
    // the original seq. Match its recorded hash AND prove its source substrings.
    const restoreFrom=event=>{
      if(event?.type!=='user/message'||!isCompactCheckpointEvent(event))return null;
      for(const field of ['preserved','memoryRequirements'])for(const candidate of event.data.source[field]??[]){
        if(candidate?.seq!==ref.seq)continue;
        try {
          const blocks=Array.isArray(candidate.blocks)?candidate.blocks:typeof candidate.text==='string'?[{type:'text',text:candidate.text}]:[];
          if(!blocks.length||blocks.some(b=>b.type!=='text'||typeof b.text!=='string'))continue;
          const restored=restoreMemorySource({...candidate,blocks,text:blocks.map(b=>b.text).join('\n')},ref);
          if(!restored)continue;
          sourceLayout(restored,original); // Reject invented, reordered or edited prose.
          return restored;
        }catch{/* Try an earlier authoritative projection; never fabricate text. */}
      }
      return null;
    };
    // Usually this checkpoint itself has the matching projection. Avoid scanning
    // the entire event log again on every planning and audit pass in that case.
    const current=restoreFrom(checkpoint);if(current)return current;
    for(let seq=checkpoint.seq-1;seq>ref.seq;seq--){
      const restored=restoreFrom(session.eventAt(seq));if(restored)return restored;
    }
    throw error;
  }
}

export function collectRecentUserMessages(session, spanSeqs, options = {}) {
  const out = [];
  if (!Array.isArray(spanSeqs) || spanSeqs.length === 0) return out;
  if (typeof session.eventAt !== 'function') return out;

  const maxMessages =
    typeof options.maxMessages === 'number' && Number.isFinite(options.maxMessages)
      ? Math.max(0, Math.trunc(options.maxMessages))
      : null;
  const maxTokens =
    typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens)
      ? Math.max(0, options.maxTokens)
      : null;
  if (maxMessages === 0 || maxTokens === 0) return out;

  const collected = [];
  for (const seq of spanSeqs) {
    const event = session.eventAt(seq);
    if (!event || event.type !== 'user/message') continue;
    if (isCompactCheckpointEvent(event)) {
      if (Array.isArray(event.data.source.memorySources)) {
        for (const ref of event.data.source.memorySources) {
          const original = session.eventAt(ref?.seq);
          if (!Number.isSafeInteger(ref?.seq) || ref.seq >= event.seq || original?.type !== 'user/message' || isCompactCheckpointEvent(original)) {
            throw Object.assign(new Error('Cannot resolve checkpoint memory source.'), {code:'CHECKPOINT_PRESERVED_UNREADABLE'});
          }
          const blocks = blocksOfMessage(session.deriveEventMessage(original));
          if (!blocks) throw Object.assign(new Error('Missing original memory source blocks.'), {code:'CHECKPOINT_PRESERVED_UNREADABLE'});
          const restored = restoreCheckpointMemory(session,event,{seq:ref.seq,blocks,text:blocks.map(b=>b.text).join('\n')},ref);
          if (restored) collected.push(restored);
        }
        continue;
      }
      // 上一代检查点：正文是摘要，不能当原话抄；但它携带的原始原话要续传。
      //
      // ⚠️ 解析不出可信结构时必须**中止**，不能当成"这一代没有原话"。
      // 旧格式没有 `source.preserved`，只能反解析渲染文本；一旦原文里
      // 恰好有一行和容器标记同形，任何猜测都可能吞掉后半段用户原话。
      // 而覆盖校验核对的是同一份（被截短的）列表，会一路绿灯提交。
      // 宁可这次不压，也不能用"看起来成功"换掉用户原话。
      const inspected = inspectCheckpointPreserved(event);
      if (!inspected.ok || !inspected.structured) {
        // V8-07：旧格式用 `--- seq N ---` 分隔每条原话，而用户原文里也完全可能
        // 有一行长得一模一样。按文本切就是在猜 —— 猜错了会把一行原文当分隔符
        // 吞掉，而覆盖校验核对的是同一份被吞过的列表，照样一路绿灯。
        //
        // 这里**不再猜**：改从会话日志里恢复。那次压缩留下的 `compaction/summary`
        // 事件带着 `shadowedSeqs`，顺着它把原始 `user/message` 读回来，得到的是
        // 完整清单，不是猜测结果。恢复不了就安全拒绝。
        const recovered = recoverLegacyCheckpointPreserved(session, event);
        if (recovered !== null) {
          for (const carried of recovered) collected.push(carried);
          continue;
        }
        const error = new Error(
          `compaction: cannot recover the original user messages from the previous checkpoint (${inspected.reason ?? 'legacy checkpoint has no authoritative structured originals'}); ` +
            'refusing to compact rather than guessing and dropping part of them',
        );
        error.code = 'CHECKPOINT_PRESERVED_UNREADABLE';
        throw error;
      }
      for (const carried of inspected.preserved) collected.push(carried);
      continue;
    }
    const message = typeof session.deriveEventMessage === 'function' ? session.deriveEventMessage(event) : undefined;
    const blocks = blocksOfMessage(message);
    if (blocks === null) continue;
    collected.push({ seq, blocks, text: blocks.map((block) => block.text).join('\n') });
  }

  // 上限只在用户显式设定时生效，且从最新往前累加（新的原话优先级更高）。
  let used = 0;
  for (let i = collected.length - 1; i >= 0; i -= 1) {
    const item = collected[i];
    const sourceKind = sourceKindOf(session, item.seq);
    // Filter before applying user-preservation limits: a host reference must
    // neither consume a user slot nor crowd an actual requirement out of it.
    if (options.instructionsOnly && isReferenceContextKind(sourceKind)) continue;
    if (maxMessages !== null && out.length >= maxMessages) break;
    if (maxTokens !== null) {
      const cost = approxTokensFor(item.text, options.approxTokens);
      if (used + cost > maxTokens) break;
      used += cost;
    }
    // Provenance comes from the durable original event, never from text which
    // merely claims to be memory. Re-resolve carried checkpoint entries too:
    // older checkpoints did not serialize the kind of each original message.
    const { sourceKind: ignoredSourceKind, ...original } = item;
    out.push(typeof sourceKind === 'string' ? { ...original, sourceKind } : original);
  }

  out.reverse();
  return out;
}

// One selection contract for planning, exact preservation, audit and continuation.
// Full reference content remains in durable events and the source archive.
function carriedDecisions(session, seqs) {
  return seqs.flatMap(seq=>{
    const event=session.eventAt(seq);
    return event?.data?.source?.kind==='compact-checkpoint' ? event.data.source.memoryDecisions??[] : [];
  });
}
export function collectInstructionMessages(session, spanSeqs, options = {}) {
  const decisions=carriedDecisions(session,session.surface?.nodes??spanSeqs);
  return removeConsumedCancellations(collectRecentUserMessages(session,spanSeqs,{...options,instructionsOnly:true}),decisions);
}

// Newer tail messages govern revisions of an older prefix. Keep only fragment
// hashes for consumed cancellations while their original tail event remains live.
// Resolve relative cancellation against the durable user sequence, including
// no-op nudges already omitted from old checkpoints. Otherwise "cancel previous"
// can jump backwards to an unrelated surviving requirement after compaction.
function withPreviousUserContext(session,messages) {
  return messages.map(message=>{
    if(!hasPreviousCancellation(message))return message;
    for(let seq=message.seq-1;seq>=0;seq--){
      const event=session.eventAt(seq);
      if(event?.type!=='user/message')continue;
      const kind=sourceKindOf(session,seq);
      if(kind===undefined||kind==='user')return {...message,previousUserSeq:seq};
    }
    return message;
  });
}
// Reuse the expensive global lifecycle resolution within one synchronous
// planning operation. The selector cannot be reused after the surface changes.
export function createSessionMemorySelector(session, nodes = session.surface?.nodes??[]) {
  const generation=session.surface?.replaceGeneration??0,snapshot=[...nodes],length=nodes.length;
  const all=withPreviousUserContext(session,collectInstructionMessages(session,nodes));
  const global=selectMemoryMessages(all,{maxMessages:Infinity,maxTokens:Infinity});
  return (spanSeqs,options={})=>{
    const current=session.surface?.nodes??nodes;
    if(current.length!==length||(session.surface?.replaceGeneration??0)!==generation||current.some((seq,index)=>seq!==snapshot[index]))throw Object.assign(new Error('Session surface changed during memory planning; create a fresh selector.'),{code:'MEMORY_SELECTION_STALE'});
    const local=collectInstructionMessages(session,spanSeqs),localSeqs=new Set(local.map(m=>m.seq));
    const selected=boundMemoryQuotes(global.active.filter(m=>localSeqs.has(m.seq)),options);
    const applied=new Set(global.decisions.filter(d=>localSeqs.has(d.seq)&&d.reason==='cancelled').map(d=>d.by));
    const inherited=carriedDecisions(session,spanSeqs).filter(d=>d.reason==='cancellation-applied'&&nodes.includes(d.seq));
    const decisions=[...inherited,...global.decisions.filter(d=>localSeqs.has(d.seq)||d.reason==='cancellation-applied'&&applied.has(d.seq)),...selected.decisions];
    const governingSeqs=new Set(decisions.filter(d=>d.by!==undefined&&!localSeqs.has(d.by)).map(d=>d.by));
    return {...selected,retained:global.active.filter(m=>!localSeqs.has(m.seq)),governing:global.active.filter(m=>governingSeqs.has(m.seq)),decisions:[...new Map(decisions.map(d=>[JSON.stringify(d),d])).values()]};
  };
}
export function selectSessionMemory(session, spanSeqs, options = {}) {
  return createSessionMemorySelector(session,session.surface?.nodes??spanSeqs)(spanSeqs,options);
}

/**
 * 从一代检查点消息里取回它当年携带的**原始用户原话**，用于跨代续传。
 *
 * 结构化来源优先（本插件写入时带 `source.preserved`），文本解析只作兜底
 * （兼容没有该字段的旧检查点）。
 *
 * @param {object} event
 * @returns {{ seq: number, blocks: {type:'text', text:string}[], text: string }[]}
 */
export function preservedFromCheckpoint(event) {
  const inspected = inspectCheckpointPreserved(event);
  return inspected.ok ? inspected.preserved : [];
}

/** 保留段容器的起止标记。 */
const PRESERVED_OPEN = '<preserved-user-messages>';
const PRESERVED_CLOSE = '</preserved-user-messages>';

/**
 * 解析检查点里的保留段，并**报告结构是否可信**。
 *
 * ⚠️ 旧格式只有渲染后的文本，没有 `source.preserved` 可以对照。这时候
 * "容器标记"和"用户恰好写下的同一行"在字节上完全一样：原文里有一行
 * `</preserved-user-messages>`，按行扫描就会把它当成段的结束，后面的
 * 内容被整段丢弃 —— 而且丢掉之后覆盖校验拿的还是这份被截短的列表，
 * 自己跟自己对得上，一路绿灯。
 *
 * 因此这里不按"第一个结束标记"切，而是按**已知的渲染结构**切：
 * 保留段永远是检查点的最后一段（`buildCheckpointBlocks` 就是这么拼的），
 * 所以真正的结束标记是**最后一个**、且其后只剩空行。
 * 段内出现的同名标记一律当作用户原文保留。
 *
 * 无法无歧义判断时返回 `ok:false`，由调用方**安全拒绝压缩**，
 * 而不是猜一个可能吞掉原话的切法。
 *
 * @param {object} event
 * @returns {{ ok: true, preserved: {seq:number, blocks:{type:'text',text:string}[], text:string}[], structured: boolean }
 *          | { ok: false, reason: string }}
 */
export function inspectCheckpointPreserved(event) {
  const source = event?.data?.source;
  const structured = source && typeof source === 'object' ? source.preserved : undefined;
  if (Array.isArray(structured)) {
    const out = [];
    const extras = Array.isArray(source.memoryRequirements) ? source.memoryRequirements : [];
    const identities = new Set(structured.map(item => item?.seq));
    for (const item of [...structured, ...extras.filter(item => !identities.has(item?.seq))]) {
      if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.seq) || item.seq < 0) {
        return { ok: false, reason: 'invalid structured original identity' };
      }
      const rawBlocks = Array.isArray(item.blocks) ? item.blocks : typeof item.text === 'string' ? [{ type: 'text', text: item.text }] : null;
      if (!rawBlocks || rawBlocks.length === 0 || rawBlocks.some(block => !block || block.type !== 'text' || typeof block.text !== 'string')) {
        return { ok: false, reason: 'invalid structured original blocks' };
      }
      const blocks = rawBlocks.map(block => ({ type: 'text', text: block.text }));
      out.push({ seq: item.seq, blocks, text: blocks.map(block => block.text).join('\n') });
    }
    return { ok: true, preserved: out, structured: true };
  }

  const content = event?.data?.content;
  if (!Array.isArray(content)) return { ok: true, preserved: [], structured: false };

  const lines = [];
  for (const block of content) {
    if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') continue;
    for (const line of block.text.split('\n')) lines.push(line);
  }

  const open = lines.findIndex((line) => line.trim() === PRESERVED_OPEN);
  if (open < 0) return { ok: true, preserved: [], structured: false };

  const closes = [];
  for (let index = open + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === PRESERVED_CLOSE) closes.push(index);
  }
  if (closes.length === 0) {
    return { ok: false, reason: 'the preserved section has no closing marker' };
  }

  // 真正的结束标记是最后一个，并且其后只能是空行 —— 保留段永远排在检查点末尾。
  const close = closes[closes.length - 1];
  for (let index = close + 1; index < lines.length; index += 1) {
    if (lines[index].trim().length > 0) {
      return { ok: false, reason: 'unexpected content after the preserved section' };
    }
  }
  // ⚠️ 段内出现**任何**容器标记行都算无法无歧义恢复。
  // 旧格式（v6 之前）没有结构化的 `source.preserved`，原话只能从渲染文本里
  // 反解析。用户消息里若恰好有一行 `</preserved-user-messages>`，它和真正的
  // 结束标记长得一模一样 —— 取第一个会截掉后半段原话，取最后一个会把
  // 中间那段"容器外的内容"吞进保留段。两种都错，而且错得看不出来：
  // 后面那道覆盖校验核对的是**已经被截短/污染的列表**，会自己跟自己对上。
  // 宁可这次不压，也不能用"看起来成功"换掉用户原话。
  for (let index = open + 1; index < close; index += 1) {
    const line = lines[index].trim();
    if (line === PRESERVED_OPEN || line === PRESERVED_CLOSE) {
      return { ok: false, reason: 'the preserved section contains another container marker' };
    }
  }

  // ⚠️ V8-07：保留段里出现 `--- seq N ---` 这类分隔行时，**一律不当结构切**。
  //
  // 这条分隔行是旧格式（v6 及更早）每条原话之间的分隔符，也是本插件多块消息
  // 用来标块边界的东西。问题在于：用户自己写的一句话，如果恰好就是
  // `--- seq 99 ---`，它和结构分隔符在字节上完全一样。按行切就是在赌 ——
  // 赌错了会把用户原文里的一行当分隔符吃掉，把一条消息劈成两条，而且
  // `ok` 仍然是 true。后面那道覆盖校验核对的是同一份被污染的列表，
  // 自己跟自己对得上，于是"看起来压缩成功"，实际少了一行用户要求。
  //
  // 这里不再猜：报告 `legacyLayout`，让调用方从会话日志里那次压缩留下的
  // `shadowedSeqs` 把**原始事件**读回来（那是完整清单，不是猜测结果）。
  for (let index = open + 1; index < close; index += 1) {
    if (/^--- seq -?\d+(?: block \d+)? ---$/.test(lines[index])) {
      return {
        ok: false,
        legacyLayout: true,
        reason:
          'the preserved section is written in the legacy "--- seq N ---" layout, where the separator ' +
          'cannot be told apart from a line the user actually typed',
      };
    }
  }

  // 走到这里说明保留段里没有任何分隔行。旧格式每条消息都带分隔符，所以
  // 这段要么是单条无分隔的旧内容，要么是手工写的；整段按一条原话处理。
  const text = lines.slice(open + 1, close).join('\n');
  // 只跳过**整段空白**的条目，不做 trim —— 前导空格与缩进是原文的一部分。
  if (text.trim().length === 0) return { ok: true, preserved: [], structured: false };
  return {
    ok: true,
    preserved: [{ seq: -1, blocks: [{ type: 'text', text }], text }],
    structured: false,
  };
}

/**
 * V8-07 的确定性恢复：从**会话日志**里把上一代检查点携带的用户原话读回来。
 *
 * 为什么这条路可信，而文本反解析不可信：
 *   - 文本里分隔符与用户原文同形，任何切法都是在猜；
 *   - 而会话日志里留着那次压缩写下的 `compaction/summary` 事件，它带
 *     `compactionId` 和 `shadowedSeqs`。顺着这些 seq 取原始 `user/message`
 *     事件，拿到的是**当时真实存在的消息**，不需要猜任何边界。
 *
 * 压缩只改 surface（`state.nodes.splice`），不改事件日志，所以被折叠的那些
 * 事件在 `session.eventAt(seq)` 上仍然读得到。
 *
 * 恢复不了（找不到对应 summary 事件、seq 越界或来源存在歧义）
 * 一律返回 `null`，由调用方安全拒绝压缩 —— 宁可这次不压，也不能拿一份
 * 猜出来的清单去替换用户原话。
 *
 * @param {object} session
 * @param {object} checkpointEvent  上一代检查点事件
 * @returns {{ seq:number, blocks:{type:'text',text:string}[], text:string }[] | null}
 */
function recoverLegacyCheckpointPreserved(session, checkpointEvent) {
  if (!session || typeof session.eventAt !== 'function') return null;
  const compactionId = checkpointEvent?.data?.source?.compactionId;
  if (typeof compactionId !== 'string' || compactionId.length === 0) return null;

  const total = typeof session.seq === 'number' ? session.seq : null;
  if (total === null || total <= 0) return null;

  for (let seq = 0; seq < total; seq += 1) {
    const event = session.eventAt(seq);
    if (!event || event.type !== 'compaction/summary') continue;
    if (event.data?.compactionId !== compactionId) continue;
    const shadowed = event.data?.shadowedSeqs;
    if (!Array.isArray(shadowed) || shadowed.length === 0) return null;
    // 只认「整段都在日志里」的情况：越界说明日志被裁过，清单不完整。
    for (const item of shadowed) {
      if (!Number.isInteger(item) || item < 0 || item >= seq || !session.eventAt(item)) return null;
    }
    const checkpointSeq = Number.isSafeInteger(checkpointEvent.seq) ? checkpointEvent.seq : total;
    if (seq >= checkpointSeq || new Set(shadowed).size !== shadowed.length) return null;
    const recovered = collectRecentUserMessages(session, shadowed, {});
    return recovered; // An empty set is valid only after every source event was checked.
  }
  return null;
}

function approxTokensFor(text, approx) {
  return typeof approx === 'function' ? approx(text) : Math.ceil(text.length / 4);
}

/**
 * 把一条消息的 content 摊平成 text 块数组，**不做任何裁剪或空白处理**。
 * 每个 text 块单独保留，渲染时按块分段，多块消息的块边界也不会丢。
 */
function blocksOfMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const content = message.content;
  if (typeof content === 'string') {
    return content.length === 0 ? null : [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) return null;
  const blocks = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') blocks.push({ type: 'text', text: block.text });
  }
  return blocks.length === 0 ? null : blocks;
}

/** 事件是不是本插件/官方写下的检查点消息（而不是真正的用户发言）。 */
function isCompactCheckpointEvent(event) {
  const source = event?.data?.source;
  if (!source || typeof source !== 'object') return false;
  return source.kind === 'compact-checkpoint';
}

function textOfMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.length === 0 ? null : parts.join('\n');
}

/**
 * 生成要写进 surface 的那条替换消息的内容：
 *   检查点前言 + <compacted-summary>摘要</compacted-summary>
 *   + （可选）<preserved-user-messages>被压区间里的用户原话</preserved-user-messages>
 *
 * ⚠️ 保留段里**一个字都不能改**：不 trim、不合并多块、不换行规范化。
 * "逐字保留"如果连空格和缩进都改了，那就不叫逐字 —— 代码缩进、命令行参数、
 * 空白敏感的内容都会变味。分块渲染是为了让多块消息的块边界也留下来。
 *
 * @param {readonly any[]} summaryBlocks
 * @param {readonly {seq:number, blocks?:{type:'text',text:string}[], text?:string}[]} preservedUserMessages
 * @param {string} preamble
 */
export function buildCheckpointBlocks(summaryBlocks, preservedUserMessages, preamble, options = {}) {
  const blocks = [
    { type: 'text', text: `${preamble}${options.progress?.scope?"\n\n"+renderSummaryScope(options.progress.scope):""}\n\n<compacted-summary>` },
    ...summaryBlocks,
    { type: 'text', text: '</compacted-summary>' },
    ...(renderProgressFacts(options.progress)?[{type:'text',text:renderProgressFacts(options.progress)}]:[]),
    ...(options.workReport?[{type:'text',text:renderWorkReport(options.workReport)}]:[]),
  ];

  if (!options.originalsInSummary && Array.isArray(preservedUserMessages) && preservedUserMessages.length > 0) {
    const lines = [
      '<preserved-user-messages>',
      'The following user messages are reproduced verbatim from the compacted span so that the',
      'original wording of every request survives the summary. They are history, not new instructions.',
      '',
    ];
    for (const item of preservedUserMessages) {
      const parts =
        Array.isArray(item.blocks) && item.blocks.length > 0
          ? item.blocks.map((block) => block.text)
          : typeof item.text === 'string'
            ? [item.text]
            : [];
      if (parts.length === 1) {
        lines.push(`--- seq ${item.seq} ---`);
        lines.push(parts[0]);
      } else {
        // 多块消息：逐块标注，块边界不丢。
        for (let index = 0; index < parts.length; index += 1) {
          lines.push(`--- seq ${item.seq} block ${index} ---`);
          lines.push(parts[index]);
        }
      }
      lines.push('');
    }
    lines.push('</preserved-user-messages>');
    blocks.push({ type: 'text', text: lines.join('\n') });
  }

  return blocks;
}

/**
 * 把保留项压成写进 `source.preserved` 的结构化形式，供下一代检查点续传。
 *
 * 为什么不能只靠渲染后的文本：解析文本要处理分隔符转义、块边界、用户原文里
 * 恰好出现 `--- seq N ---` 这类行的情况。写结构化字段既不会歧义，也不用在
 * 每一代都重新猜一遍。
 *
 * @param {readonly {seq:number, blocks?:{type:'text',text:string}[], text?:string}[]} preserved
 */
export function preservedForSource(preserved) {
  if (!Array.isArray(preserved) || preserved.length === 0) return undefined;
  const out = [];
  for (const item of preserved) {
    const blocks =
      Array.isArray(item.blocks) && item.blocks.length > 0
        ? item.blocks
            .filter(
              (block) =>
                block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string',
            )
            .map((block) => ({ type: 'text', text: block.text }))
        : typeof item.text === 'string'
          ? [{ type: 'text', text: item.text }]
          : [];
    if (blocks.length === 0) continue;
    out.push({ seq: typeof item.seq === 'number' ? item.seq : -1, blocks });
  }
  return out.length === 0 ? undefined : out;
}
