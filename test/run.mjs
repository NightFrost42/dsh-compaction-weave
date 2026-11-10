// 离线自测：不装进 DSH，也不碰任何真实会话。
//
// 跑法：node test/run.mjs
//
// 覆盖的都是纯逻辑（配置、阈值、选区、prompt、审计、流折叠、窗口锁定、
// 配置树改写），这些是压缩出错时最可能出问题的地方，而且不需要宿主就能验。
// 完整测试入口：npm test；真实宿主适配测试：npm run test:host。

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const imageBytes = Buffer.alloc(184320, 7), fileBytes = Buffer.alloc(512, 9);
const imageId='sha256:'+createHash('sha256').update(imageBytes).digest('hex');
const fileId='sha256:'+createHash('sha256').update(fileBytes).digest('hex');
const attachmentFixture={async readImage(){return {data:imageBytes};},async *readFileStream(){yield fileBytes;}};
import { readFile, writeFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveConfig, resolveCompactSpec, resolveTargetPolicy, DEFAULT_CONFIG } from '../lib/config.js';
import {
  toolPairingBalancedBefore,
  toolPairingBalancedAfter,
  selectCompactableRange,
  validateSurfaceRegion,
  inspectCompactionEntryState,
  collectRecentUserMessages,
  buildCheckpointBlocks,
  inspectCheckpointPreserved,
} from '../lib/region.js';
import { approxTokens, SummaryAssembler, summaryText, blocksToText, compactUsage } from '../lib/meter.js';
import { buildCompactionInstruction, detectLanguage, CHECKPOINT_PREAMBLE } from '../lib/prompt.js';
import { auditCompaction, extractConstraintLines } from '../lib/audit.js';
import { lockWindow, contextWindowOf, defaultMaxTokensOf, peekLockedWindow, resetWindowCache } from '../lib/window.js';
import { countEngineRows, renameOfficialRows, injectBesideOfficial } from '../lib/index.js';
import { compactCheckpointSource, isCompactCheckpointSource, WeaveCompactionEngine } from '../lib/engine.js';
import { MANUAL_CODES, toManualCode, asManualError, asHostManualError } from '../lib/manual-error.js';
import { resolveSummaryTargets } from '../lib/summary.js';
import {
  validateSummaryStructure,
  validateCheckpointCoverage,
  validateUserMessageSection,
} from '../lib/validate.js';
import { CompactionArchive, spanEntries } from '../lib/history.js';
import { CompactionJournal } from '../lib/journal.js';
import { __test as toolsTest } from '../lib/tools.js';
const { runTool } = toolsTest;

let passed = 0;
let liveSessionNumber = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n         ${error?.message ?? error}\n`);
  }
}

/** 异步用例：必须 `await`，否则失败会被当成 unhandled rejection 漏掉。 */
async function atest(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n         ${error?.message ?? error}\n`);
  }
}

// ───────────────────────────────────────────────────────── 测试用的假会话

/**
 * 造一个最小的 session：surface.nodes 是 seq 数组，eventAt(seq) 返回事件。
 * 事件里显式给了 `data` 就原样透传（turn/start 的 turn 编号、compaction/* 的
 * compactionId 都靠这条路径），否则按 type 合成最小 payload。
 * @param {{seq:number, type:string, text?:string, toolCalls?:number, data?:object}[]} events
 */
function fakeSession(events) {
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const nodes = events.map((e) => e.seq);
  return {
    id: 'session-test',
    seq: events.length === 0 ? 0 : events[events.length - 1].seq + 1,
    surface: { nodes, replaceGeneration: 0 },
    eventAt(seq) {
      const raw = bySeq.get(seq);
      if (!raw) return undefined;
      if (raw.data !== undefined) return { type: raw.type, data: raw.data };
      if (raw.type === 'assistant/message') {
        const content = [];
        for (let i = 0; i < (raw.toolCalls ?? 0); i += 1) content.push({ type: 'tool-call', id: `c${i}` });
        if (raw.text) content.push({ type: 'text', text: raw.text });
        return { type: 'assistant/message', data: { message: { role: 'assistant', content } } };
      }
      if (raw.type === 'tool/result') {
        return { type: 'tool/result', data: { content: [{ type: 'text', text: raw.text ?? 'tool output' }] } };
      }
      return { type: raw.type, data: { message: { role: raw.type === 'user/message' ? 'user' : 'system', content: [{ type: 'text', text: raw.text ?? '' }] } } };
    },
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (event.type === 'assistant/message') return event.data.message;
      if (event.type === 'tool/result') {
        return { role: 'tool', content: event.data.content };
      }
      return event.data?.message;
    },
  };
}

function measureOf(session, tokensPerSeq) {
  const nodes = [...session.surface.nodes];
  return {
    nodes,
    pricedNodes: nodes.map((seq) => ({ seq, tokens: tokensPerSeq?.(seq) ?? 100 })),
    totalTokens: nodes.length * 100,
  };
}

// ───────────────────────────────────────────────────────── 1. 配置

test('resolveConfig 用默认值填充空配置', () => {
  const { config, unknown } = resolveConfig({});
  assert.equal(config.thresholdRatio, DEFAULT_CONFIG.thresholdRatio);
  assert.equal(config.headroomTokens, 33000);
  assert.equal(unknown.length, 0);
});

test('resolveConfig 收集未知键但不抛错', () => {
  const { unknown } = resolveConfig({ nope: 1, auto: false });
  assert.deepEqual(unknown, ['nope']);
});

test('resolveConfig 把 retainRatio 压到 thresholdRatio 之下', () => {
  const { config } = resolveConfig({ thresholdRatio: 0.5, retainRatio: 0.9 });
  assert.ok(config.retainRatio < config.thresholdRatio, `retainRatio=${config.retainRatio}`);
});

test('resolveConfig 把过大的 headroomTokens 收回到窗口的 1/4', () => {
  const { config } = resolveConfig({ windowFallback: 100000, headroomTokens: 900000 });
  assert.equal(config.headroomTokens, 25000);
});

// ───────────────────────────────────────────────────────── 2. 阈值算法

test('resolveCompactSpec 与官方公式一致（200k 窗口）', () => {
  const policy = { thresholdRatio: 0.8, headroomTokens: 33000, retainRatio: 0.16, retainTokens: null };
  const spec = resolveCompactSpec(policy, 200000, 8192);
  // messageBudget = 200000-8192 = 191808
  // pressureBudget = 191808-33000 = 158808
  // threshold = floor(min(160000, 158808)) = 158808
  assert.equal(spec.messageBudgetTokens, 191808);
  assert.equal(spec.pressureBudgetTokens, 158808);
  assert.equal(spec.thresholdTokens, 158808);
  assert.equal(spec.retainTokens, Math.floor(191808 * 0.16));
});

test('resolveCompactSpec 在 headroom 大于整条消息预算时把提前量收进窗口内（C02）', () => {
  // 10000 窗口 − 8192 预留 = 1808 消息预算，headroom 却是 33000。
  // 这是小窗口的真实配置，不能抛错（抛错 = 自动压缩永不触发）。
  const spec = resolveCompactSpec(
    { thresholdRatio: 0.8, headroomTokens: 33000, retainRatio: 0.16, retainTokens: null },
    10000,
    8192,
  );
  assert.equal(spec.messageBudgetTokens, 1808);
  assert.equal(spec.pressureBudgetTokens, 1808 - 452, '提前量收敛到消息预算的 1/4');
  assert.ok(spec.thresholdTokens < spec.messageBudgetTokens, '压缩线必须严格早于阻断线');
  assert.ok(spec.retainTokens < spec.thresholdTokens);

  // 预留本身就把窗口吃光时仍然是错误：那种配置没有任何可压缩空间。
  assert.throws(
    () => resolveCompactSpec({ thresholdRatio: 0.8, headroomTokens: 1000, retainRatio: 0.16, retainTokens: null }, 10000, 12000),
    /no message budget/,
  );
});

test('resolveCompactSpec 拒绝 retainTokens >= thresholdTokens', () => {
  // 200000 窗口、1000 headroom → threshold = min(160000, 199000) = 160000
  // retainTokens 170000 > 160000，必须被拒。
  assert.throws(
    () =>
      resolveCompactSpec(
        { thresholdRatio: 0.8, headroomTokens: 1000, retainRatio: 0.16, retainTokens: 170000 },
        200000,
        0,
      ),
    /must be less than threshold tokens/,
  );
});

// ───────────────────────────────────────────────────────── 3. 工具配对与选区

test('toolPairingBalancedBefore/After 认得工具调用与结果的配对', () => {
  // seq 0: user, 1: assistant(tool-call), 2: tool/result, 3: assistant(text)
  const session = fakeSession([
    { seq: 0, type: 'user/message', text: 'hi' },
    { seq: 1, type: 'assistant/message', toolCalls: 1 },
    { seq: 2, type: 'tool/result', text: 'out' },
    { seq: 3, type: 'assistant/message', text: 'done' },
  ]);
  assert.equal(toolPairingBalancedBefore(session, 0), true);
  assert.equal(toolPairingBalancedBefore(session, 1), true);
  assert.equal(toolPairingBalancedBefore(session, 2), false, 'seq 2 之前有一个未闭合的 tool-call');
  assert.equal(toolPairingBalancedAfter(session, 2), true);
  assert.equal(toolPairingBalancedAfter(session, 1), false);
});

test('selectCompactableRange 保留尾部且不切开工具配对', () => {
  const session = fakeSession([
    { seq: 0, type: 'user/message', text: 'a' },
    { seq: 1, type: 'assistant/message', text: 'b' },
    { seq: 2, type: 'assistant/message', toolCalls: 1 },
    { seq: 3, type: 'tool/result', text: 'c' },
    { seq: 4, type: 'assistant/message', text: 'd' },
  ]);
  const measurement = measureOf(session);
  const range = selectCompactableRange(session, measurement, 150);
  assert.ok(range, '应该能选出可压区间');
  assert.equal(range.start, 0);
  // 保留 150 token ≈ 2 条（每条 100），从尾部倒着数 → keepFromIdx 落在 3 附近，
  // 但 3 之前不平衡（seq2 的 tool-call 未闭合）→ 往前退到 2。
  assert.ok(toolPairingBalancedBefore(session, range.start));
  assert.ok(toolPairingBalancedAfter(session, range.end));
});

test('selectCompactableRange 在 retainTokens 覆盖全部内容时返回 null', () => {
  const session = fakeSession([
    { seq: 0, type: 'user/message', text: 'a' },
    { seq: 1, type: 'assistant/message', text: 'b' },
  ]);
  assert.equal(selectCompactableRange(session, measureOf(session), 100000), null);
});

test('selectCompactableRange 在 surface 与计价不一致时抛错', () => {
  const session = fakeSession([{ seq: 0, type: 'user/message', text: 'a' }]);
  assert.throws(
    () => selectCompactableRange(session, { nodes: [99], pricedNodes: [] }, 0),
    /does not match the current session surface/,
  );
});

test('validateSurfaceRegion 拒绝不存在的 seq 与倒序区间', () => {
  const session = fakeSession([
    { seq: 0, type: 'user/message', text: 'a' },
    { seq: 1, type: 'assistant/message', text: 'b' },
  ]);
  assert.throws(() => validateSurfaceRegion(session, 99, 1), /start seq 99 not found in surface/);
  assert.throws(() => validateSurfaceRegion(session, 1, 0), /is after end seq/);
});

test('inspectCompactionEntryState 认出未闭合的 compaction/start', () => {
  const session = fakeSession([
    { seq: 0, type: 'turn/start', data: { turn: 3 } },
    { seq: 1, type: 'compaction/start' },
  ]);
  const state = inspectCompactionEntryState(session);
  assert.equal(state.unmatchedCompactionStart, 1);
  // turn 身份是 event.data.turn，不是事件 seq。
  assert.equal(state.openTurn, 3);
  assert.equal(state.openTurnSeq, 0);
});

test('inspectCompactionEntryState 在 compaction/end 之后认为锁已释放', () => {
  const session = fakeSession([
    { seq: 0, type: 'compaction/start' },
    { seq: 1, type: 'compaction/end' },
    { seq: 2, type: 'turn/end' },
  ]);
  const state = inspectCompactionEntryState(session);
  assert.equal(state.unmatchedCompactionStart, null);
  assert.equal(state.openTurn, null);
});

// ───────────────────────────────────────────────────────── 4. L5 保留用户原话

test('collectRecentUserMessages 从 span 尾部挑用户消息并保持时间顺序', () => {
  const session = fakeSession([
    { seq: 0, type: 'user/message', text: '第一条' },
    { seq: 1, type: 'assistant/message', text: '答' },
    { seq: 2, type: 'user/message', text: '第二条' },
    { seq: 3, type: 'assistant/message', text: '答' },
    { seq: 4, type: 'user/message', text: '第三条' },
  ]);
  const picked = collectRecentUserMessages(session, [0, 1, 2, 3, 4], {
    maxMessages: 2,
    maxTokens: 10000,
    approxTokens,
  });
  assert.deepEqual(picked.map((p) => p.text), ['第二条', '第三条']);
});

test('collectRecentUserMessages 只看 span 内部，不抄 span 外的消息', () => {
  // 这是之前写反的那一处：span 外的消息本来就不会被折叠，再抄一遍纯属浪费 token。
  const session = fakeSession([
    { seq: 0, type: 'user/message', text: 'span 外（会被原样保留，不该再抄）' },
    { seq: 1, type: 'user/message', text: 'span 内 old' },
    { seq: 2, type: 'user/message', text: 'span 内 new' },
  ]);
  const picked = collectRecentUserMessages(session, [1, 2], { maxMessages: 5, maxTokens: 10000, approxTokens });
  assert.deepEqual(picked.map((p) => p.seq), [1, 2]);
  assert.ok(!picked.some((p) => p.text.includes('span 外')));
});

test('collectRecentUserMessages 在 span 为空时返回空数组', () => {
  const session = fakeSession([{ seq: 0, type: 'user/message', text: 'x' }]);
  assert.deepEqual(collectRecentUserMessages(session, [], { maxMessages: 3, maxTokens: 100, approxTokens }), []);
});

test('collectRecentUserMessages 超预算时截断而不是整条丢弃', () => {
  const big = 'x'.repeat(4000); // 约 1000 token
  const session = fakeSession([
    { seq: 0, type: 'user/message', text: big },
    { seq: 1, type: 'user/message', text: big },
    { seq: 2, type: 'user/message', text: big },
  ]);
  const picked = collectRecentUserMessages(session, [0, 1, 2], {
    maxMessages: 10,
    maxTokens: 1200,
    approxTokens,
  });
  // 从尾部往前累加：seq2 用掉 1000，seq1 会超预算 → 停。至少保留最后一条。
  assert.deepEqual(picked.map((p) => p.seq), [2]);
});

test('buildCheckpointBlocks 同时带摘要与用户原话两段', () => {
  const blocks = buildCheckpointBlocks([{ type: 'text', text: '摘要正文' }], [{ seq: 7, text: '原话' }], CHECKPOINT_PREAMBLE);
  const text = blocksToText(blocks);
  assert.ok(text.includes('<compacted-summary>'));
  assert.ok(text.includes('摘要正文'));
  assert.ok(text.includes('</compacted-summary>'));
  assert.ok(text.includes('<preserved-user-messages>'));
  assert.ok(text.includes('原话'));
});

test('buildCheckpointBlocks 在没有保留消息时不留空壳标签', () => {
  const text = blocksToText(buildCheckpointBlocks([{ type: 'text', text: 'x' }], [], CHECKPOINT_PREAMBLE));
  assert.ok(!text.includes('<preserved-user-messages>'));
});

// ───────────────────────────────────────────────────────── 5. 流折叠与摘要文本

test('SummaryAssembler 拼接 text-delta 并记录 usage', () => {
  const a = new SummaryAssembler();
  a.push({ type: 'text-delta', text: '你' });
  a.push({ type: 'text-delta', text: '好' });
  a.push({ type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } });
  a.push({ type: 'finish', reason: { kind: 'stop' } });
  a.throwIfFailed();
  assert.equal(a.text, '你好');
  assert.equal(a.usage.outputTokens, 2);
});

test('SummaryAssembler 把 max-tokens 变成 MAX_TOKENS 错误', () => {
  const a = new SummaryAssembler();
  a.push({ type: 'text-delta', text: '半截' });
  a.push({ type: 'finish', reason: { kind: 'max-tokens' } });
  assert.throws(() => a.throwIfFailed(), (error) => error.code === 'MAX_TOKENS');
});

test('SummaryAssembler 把 error finish 变成异常', () => {
  const a = new SummaryAssembler();
  a.push({ type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'X' } } });
  assert.throws(() => a.throwIfFailed(), /boom/);
});

test('summaryText 拒绝非文本块与空摘要', () => {
  assert.throws(() => summaryText([{ type: 'image', data: 'x' }]), (e) => e.code === 'UNSUPPORTED_CONTENT');
  assert.throws(() => summaryText([{ type: 'text', text: '   ' }]), (e) => e.code === 'EMPTY_SUMMARY');
});

test('approxTokens 对中文与英文给出同一量级', () => {
  assert.equal(approxTokens('你好世界'), 4);
  assert.equal(approxTokens('abcdefgh'), 2);
  assert.equal(approxTokens(''), 0);
});

// ───────────────────────────────────────────────────────── 6. L4 摘要模板

test('英文模板包含九个固定小节', () => {
  const text = buildCompactionInstruction('en');
  for (let i = 1; i <= 9; i += 1) {
    assert.ok(text.includes(`## ${i}.`), `缺少第 ${i} 节`);
  }
  assert.ok(/All User Messages/i.test(text), '必须包含「所有用户消息」一节');
});

test('中文模板同样是九节', () => {
  const text = buildCompactionInstruction('zh');
  for (let i = 1; i <= 9; i += 1) {
    assert.ok(text.includes(`## ${i}.`), `缺少第 ${i} 节`);
  }
});

test('有旧摘要时模板要求合并而不是照抄', () => {
  const text = buildCompactionInstruction('en', { previousSummary: 'OLD' });
  assert.ok(/PRIOR|prior|merge/i.test(text));
});

test('detectLanguage 按 CJK 占比判定', () => {
  assert.equal(detectLanguage('这是一段中文说明文字，占比很高。'), 'zh');
  assert.equal(detectLanguage('This is a plain English sentence about compaction.'), 'en');
  assert.equal(detectLanguage('混合', 'zh'), 'zh');
});

// ───────────────────────────────────────────────────────── 7. 约束审计

test('extractConstraintLines 抓出祈使句', () => {
  const lines = extractConstraintLines('不要直接执行任何命令\n这是一句普通描述\n必须保留原文');
  assert.equal(lines.length, 2);
});

test('auditCompaction 在摘要丢掉约束时报告 lost', () => {
  const report = auditCompaction({
    userMessages: [{ seq: 1, text: '不要直接执行任何命令，必须先确认' }],
    summaryText: '用户要求先确认后再操作。',
    threshold: 0.6,
  });
  assert.equal(report.checked, 1);
  assert.ok(report.lost.length === 1, '应当报告一条丢失的约束');
});

test('auditCompaction 在摘要保留约束时不报告', () => {
  const report = auditCompaction({
    userMessages: [{ seq: 1, text: '不要直接执行任何命令，必须先确认' }],
    summaryText: '不要直接执行任何命令，必须先确认。',
    threshold: 0.6,
  });
  assert.equal(report.lost.length, 0);
});

// ───────────────────────────────────────────────────────── 8. L1 窗口锁定

test('contextWindowOf 认多种适配器返回结构', () => {
  assert.equal(contextWindowOf({ context: { contextWindow: 1000 } }), 1000);
  assert.equal(contextWindowOf({ contextWindow: 2000 }), 2000);
  assert.equal(contextWindowOf({ window: 3000 }), 3000);
  assert.equal(contextWindowOf({}), undefined);
});

test('defaultMaxTokensOf 认多种字段名', () => {
  assert.equal(defaultMaxTokensOf({ defaultMaxTokens: 4096 }), 4096);
  assert.equal(defaultMaxTokensOf({ context: { defaultMaxTokens: 8192 } }), 8192);
});

test('lockWindow 固定首次答案，后续仅收紧 safetyWindow', () => {
  const session = {};
  const first = lockWindow({
    session,
    provider: 'p',
    model: 'm',
    adapterWindow: 1000000,
    providerMap: {},
    fallback: 200000,
    clampMin: 65536,
  });
  assert.equal(first.window, 1000000);
  assert.equal(first.source, 'adapter');

  // 中途报出更小的真实值 → 收紧（否则阈值按 1000000 算，永远压不动）
  const second = lockWindow({
    session,
    provider: 'p',
    model: 'm',
    adapterWindow: 868928,
    providerMap: {},
    fallback: 200000,
    clampMin: 65536,
  });
  assert.equal(second.safetyWindow, 868928, '更小的可信值必须能收紧已锁定的窗口');
  assert.equal(second.source, 'locked');

  // 再报一个更大的值 → 忽略（窗口只能变小不能变大）
  const third = lockWindow({
    session,
    provider: 'p',
    model: 'm',
    adapterWindow: 1000000,
    providerMap: {},
    fallback: 200000,
    clampMin: 65536,
  });
  assert.equal(third.safetyWindow, 868928, '更大的中途值不得把窗口放大');
});

test('lockWindow 首次回退仍固定答案，后续真值收紧安全预算', () => {
  const session = {};
  const first = lockWindow({
    session,
    provider: 'p',
    model: 'm',
    adapterWindow: undefined,
    providerMap: {},
    fallback: 200000,
    clampMin: 65536,
  });
  assert.equal(first.source, 'fallback');
  assert.equal(first.window, 200000);

  const second = lockWindow({
    session,
    provider: 'p',
    model: 'm',
    adapterWindow: 32768,
    providerMap: {},
    fallback: 200000,
    clampMin: 65536,
  });
  assert.equal(second.safetyWindow, 32768, '真实小窗口不能被 fallback 锁死');
});

test('lockWindow 不把适配器报出的合法小窗口向上抬到 clampMin', () => {
  const session = {};
  const locked = lockWindow({
    session,
    provider: 'p',
    model: 'm',
    adapterWindow: 32768,
    providerMap: {},
    fallback: 200000,
    clampMin: 65536,
  });
  assert.equal(locked.window, 32768, 'clampMin 只用于兜回退值，不能放大真值');
  assert.equal(locked.source, 'adapter');
});

test('lockWindow 优先用配置里的显式映射', () => {
  const session = {};
  const locked = lockWindow({
    session,
    provider: 'p',
    model: 'm',
    adapterWindow: 1000,
    providerMap: { 'p/m': 500000 },
    fallback: 200000,
    clampMin: 65536,
  });
  assert.equal(locked.window, 500000);
  assert.equal(locked.source, 'config');
});

test('lockWindow 在适配器没有窗口时回退并钳到最小值', () => {
  const session = {};
  const locked = lockWindow({
    session,
    provider: 'p',
    model: 'm',
    adapterWindow: undefined,
    providerMap: {},
    fallback: 1024,
    clampMin: 65536,
  });
  assert.equal(locked.window, 65536);
  assert.equal(locked.source, 'fallback');
});

// ───────────────────────────────────────────────────────── 9. 配置树改写

test('countEngineRows 数到 isolate 组里的嵌套行', () => {
  const plugins = [
    { id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config: [
      { id: 'compaction', name: 'cordis:group', group: true, config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      ] },
    ] },
  ];
  assert.equal(countEngineRows(plugins), 1, '只数引擎，不数 command-compact');
});

test('renameOfficialRows 原地换名并保留 id 与位置', () => {
  const plugins = [
    { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { auto: false } },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
    ] },
  ];
  const result = renameOfficialRows(plugins, { thresholdRatio: 0.7 });
  assert.ok(result);
  assert.equal(result.rewritten, 1);
  const group = result.plugins[0];
  assert.equal(group.id, 'compaction');
  assert.deepEqual(group.isolate, { compaction: true });
  const engineRow = group.config[0];
  assert.equal(engineRow.id, 'compaction-basic');
  assert.equal(engineRow.name, 'dsh-compaction-weave/engine');
  assert.equal(engineRow.config.auto, false, '原行 config 要保留');
  assert.equal(engineRow.config.thresholdRatio, 0.7, '新配置要合并进去');
  assert.equal(group.config[1].name, 'dsh-compaction-weave/command-compact', 'command delegates to host with timeout presentation');
});

test('renameOfficialRows 幂等：改过一次后再改不生效', () => {
  const plugins = [{ id: 'c', name: '@deepseek-ai/dsh-compaction-basic' }];
  const once = renameOfficialRows(plugins, {});
  assert.ok(once);
  const twice = renameOfficialRows(once.plugins, {});
  assert.equal(twice, null);
});

test('injectBesideOfficial 关闭官方行并在同一层追加引擎行', () => {
  const plugins = [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' }];
  const result = injectBesideOfficial(plugins, {});
  assert.ok(result);
  assert.equal(result.plugins.length, 2);
  assert.equal(result.plugins[0].disabled, true);
  assert.equal(result.plugins[1].name, 'dsh-compaction-weave/engine');
});

// 真实宿主结构（@deepseek-ai/dsh-agent-preset）：行数组挂在 config.plugins 里，
// 而 group 的行数组挂在 config 本身。两种必须都能改到，否则会出现
// "数得到但改不到"的假成功。
const REAL_PRESET_TREE = [
  {
    id: 'preset-cordis',
    name: '@deepseek-ai/dsh-agent-preset',
    config: {
      id: 'cordis',
      order: 4,
      plugins: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona' },
        {
          id: 'compaction',
          name: 'cordis:group',
          group: true,
          isolate: { compaction: true, toolResultPruner: true },
          config: [
            { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
            { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
            {
              id: 'tool-result-pruner',
              name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
              config: { thresholdChars: 8192 },
            },
          ],
        },
      ],
    },
  },
];

test('countEngineRows 数得到 preset 的 config.plugins 里的引擎行', () => {
  assert.equal(countEngineRows(REAL_PRESET_TREE), 1);
});

test('renameOfficialRows 能改到 preset 的 config.plugins 里的引擎行', () => {
  const result = renameOfficialRows(REAL_PRESET_TREE, { thresholdRatio: 0.72 });
  assert.ok(result, '必须真的改到，否则压缩根本没被接管');
  assert.equal(result.rewritten, 1);

  const preset = result.plugins[0];
  assert.equal(preset.config.id, 'cordis', 'preset 的其它字段要保留');
  assert.equal(preset.config.order, 4);
  assert.ok(Array.isArray(preset.config.plugins), 'plugins 必须还在 config.plugins 里');

  const group = preset.config.plugins.find((row) => row.id === 'compaction');
  assert.ok(group, 'group 行要保留');
  assert.deepEqual(group.isolate, { compaction: true, toolResultPruner: true });

  const engineRow = group.config.find((row) => row.id === 'compaction-basic');
  assert.equal(engineRow.name, 'dsh-compaction-weave/engine');
  assert.equal(engineRow.config.thresholdRatio, 0.72);

  const command = group.config.find((row) => row.id === 'command-compact');
  assert.equal(command.name, 'dsh-compaction-weave/command-compact', 'command delegates to host with timeout presentation');

  const pruner = group.config.find((row) => row.id === 'tool-result-pruner');
  assert.equal(pruner.config.thresholdChars, 8192, '同级其它行原样保留');
});

test('renameOfficialRows 改 preset 后幂等', () => {
  const once = renameOfficialRows(REAL_PRESET_TREE, {});
  assert.ok(once);
  assert.equal(renameOfficialRows(once.plugins, {}), null);
});

test('injectBesideOfficial 也能在 preset 的 config.plugins 里追加', () => {
  const result = injectBesideOfficial(REAL_PRESET_TREE, { thresholdRatio: 0.6 });
  assert.ok(result);
  const group = result.plugins[0].config.plugins.find((row) => row.id === 'compaction');
  assert.equal(group.config.length, 4, '关一条 + 加一条');
  const official = group.config.find((row) => row.id === 'compaction-basic');
  assert.equal(official.disabled, true);
  const added = group.config.find((row) => row.id === 'compaction-basic-weave');
  assert.equal(added.name, 'dsh-compaction-weave/engine');
  assert.equal(added.config.thresholdRatio, 0.6);
});

test('countEngineRows 在 preset 里两层嵌套时都数得到', () => {
  const tree = [
    {
      id: 'preset-standard',
      name: '@deepseek-ai/dsh-agent-preset',
      config: {
        id: 'standard',
        plugins: [
          { id: 'c', name: 'cordis:group', group: true, config: [
            { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
          ] },
        ],
      },
    },
    { id: 'top', name: '@deepseek-ai/dsh-compaction-basic' },
  ];
  assert.equal(countEngineRows(tree), 2);
});

// ───────────────────────────────────────────────────────── 10. checkpoint source

test('compactCheckpointSource 打上可识别的 marker', () => {
  const source = compactCheckpointSource('cmp-1');
  assert.equal(source.kind, 'compact-checkpoint');
  assert.equal(source.compactionId, 'cmp-1');
  assert.equal(isCompactCheckpointSource(source), true);
  assert.equal(isCompactCheckpointSource({ kind: 'other' }), false);
});

test('compactCheckpointSource 带上 sourceCommandId 且被冻结', () => {
  const source = compactCheckpointSource('cmp-2', 'cmd-9');
  assert.equal(source.sourceCommandId, 'cmd-9');
  assert.ok(Object.isFrozen(source));
});

// ───────────────────────────────────────────────────────── 11. 审查回归（F01–F13 / R01）

test('F02: spec 必须带上重试次数，否则循环上限是 NaN', () => {
  const { config } = resolveConfig({ compactionRetries: 1, maxOverflowRetries: 2 });
  const spec = resolveCompactSpec(config, 200000, 8192);
  assert.equal(spec.compactionRetries, 1, 'spec 缺 compactionRetries 会让 maxAttempts 变 NaN');
  assert.equal(spec.maxOverflowRetries, 2);
  assert.ok(!Number.isNaN(spec.compactionRetries + 1), 'compactionRetries + 1 不能是 NaN');
});

test('F03: compactUsage 丢掉 undefined，只留有限数值', () => {
  // 宿主 mapUsage 在缓存为 0 时会省略这两个字段；我们若无条件补 undefined，
  // 宿主无损 JSON 校验会拒掉整个 compaction/summary 事件。
  const raw = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: undefined };
  const out = compactUsage(raw);
  assert.deepEqual(out, { inputTokens: 1000, outputTokens: 100 });
  assert.ok(!('cacheReadTokens' in out), '不能留下 undefined 字段');
  assert.equal(compactUsage({}), null, '全空时返回 null 而不是空对象');
  assert.equal(compactUsage(null), null);
  assert.equal(compactUsage({ weird: 'text' }), null, '非数值字段一律丢弃');
});

test('F09: modelPolicies 按 provider+model 命中并覆盖', () => {
  const { config, unknown } = resolveConfig({
    modelPolicies: [{ provider: 'p', model: 'm', maxTokens: 256, headroomTokens: 12000 }],
  });
  assert.deepEqual(unknown, [], 'modelPolicies 是合法键，不该报未知');
  assert.equal(config.modelPolicies.length, 1, 'modelPolicies 不能被静默丢弃');
  assert.equal(config.maxTokens, DEFAULT_CONFIG.maxTokens, '基础配置不受覆盖项影响');

  const hit = resolveTargetPolicy(config, 'p', 'm');
  assert.equal(hit.maxTokens, 256, '命中的目标策略要覆盖 maxTokens');
  assert.equal(hit.headroomTokens, 12000);
  const miss = resolveTargetPolicy(config, 'p', 'other');
  assert.equal(miss.maxTokens, DEFAULT_CONFIG.maxTokens, '没命中就保持基础配置');
});

test('F09/V3-F06: 缺 provider/model 的 modelPolicies 条目必须抛错，不能静默丢弃', () => {
  // 语义已按官方收紧：宿主 `assertModelPolicy` 在加载期就抛，静默丢弃会让用户
  // 以为策略生效了。所以这里断言的是"抛错"，不是"被过滤掉"。
  assert.throws(
    () => resolveConfig({ modelPolicies: [{ provider: 'p' }] }),
    /modelPolicies\[0\]\.model must be a non-empty string/,
  );
  assert.throws(
    () => resolveConfig({ modelPolicies: [{ model: 'm' }] }),
    /modelPolicies\[0\]\.provider must be a non-empty string/,
  );
});

test('F04: 零预算时一条用户原话都不保留（不能强制留 1 条）', () => {
  const session = fakeSession([
    { seq: 0, type: 'user/message', text: '很长的一句话'.repeat(50) },
    { seq: 1, type: 'assistant/message', text: '答' },
  ]);
  assert.deepEqual(collectRecentUserMessages(session, [0, 1], { maxMessages: 0, maxTokens: 20000 }), []);
  assert.deepEqual(collectRecentUserMessages(session, [0, 1], { maxMessages: 3, maxTokens: 0 }), []);
});

test('F04: 缺原始来源的旧 checkpoint 必须拒绝，不能跳过后声称全保留', () => {
  const session = fakeSession([
    { seq: 0, type: 'user/message', text: '上一代检查点正文' },
    { seq: 1, type: 'user/message', text: '真正想说的话' },
  ]);
  // 手工把 seq 0 换成带 compact-checkpoint 来源的事件
  const original = session.eventAt;
  session.eventAt = (seq) => {
    const event = original(seq);
    if (seq === 0 && event) {
      return {
        type: 'user/message',
        data: {
          id: 'cp',
          role: 'user',
          content: [{ type: 'text', text: '上一代检查点正文' }],
          source: { kind: 'compact-checkpoint', compactionId: 'x' },
        },
      };
    }
    return event;
  };
  assert.throws(() => collectRecentUserMessages(session, [0, 1], {
    maxMessages: 5, maxTokens: 20000, approxTokens,
  }), /cannot recover/, '缺少旧来源应显式失败；完整官方日志恢复另由独立 Q36 覆盖');
});

test('F10: turn 身份取 event.data.turn，事件定位另存 openTurnSeq', () => {
  const session = fakeSession([
    { seq: 0, type: 'turn/start', data: { turn: 7 } },
    { seq: 1, type: 'user/message', text: 'x' },
  ]);
  const state = inspectCompactionEntryState(session);
  assert.equal(state.openTurn, 7, 'turn 编号来自 event.data.turn');
  assert.equal(state.openTurnSeq, 0, '事件 seq 单独存');
});

test('F08: 后续更小真值收紧、更大值忽略、合法小窗口不被放大', () => {
  const session = {};
  const base = { session, provider: 'p', model: 'm', providerMap: {}, fallback: 200000, clampMin: 65536 };
  assert.equal(lockWindow({ ...base, adapterWindow: 1000000 }).window, 1000000);
  assert.equal(lockWindow({ ...base, adapterWindow: 868928 }).safetyWindow, 868928, '更小真值必须收紧');
  assert.equal(lockWindow({ ...base, adapterWindow: 1000000 }).safetyWindow, 868928, '更大值必须忽略');
  const fresh = {};
  assert.equal(
    lockWindow({ ...base, session: fresh, adapterWindow: 32768 }).window,
    32768,
    '合法小窗口不能被 clampMin 向上抬',
  );
});

// ───────────────────────────────────────────────── 第二轮审查（V2）的回归

test('V2-F01: _append 不能是 async，否则提交段的同步校验必然抛错', async () => {
  // 提交段要求同步写：`_appendSync` 检测到 Promise 就抛
  // "session.append returned a promise for ..."，surface 替换永远不发生。
  // 这里直接检查方法签名——`async` 函数构造器的名字是 AsyncFunction。
  const { WeaveCompactionEngine } = await import('../lib/engine.js');
  const descriptor = Object.getOwnPropertyDescriptor(WeaveCompactionEngine.prototype, '_append');
  assert.ok(descriptor, '_append 必须存在');
  assert.notEqual(
    descriptor.value?.constructor?.name,
    'AsyncFunction',
    '_append 必须是同步函数：它被 _appendSync 直接调用',
  );
});

test('V2-F02: 引擎必须声明 sessions 注入，否则读 ctx.sessions 直接抛错', async () => {
  const entry = await import('../lib/engine-entry.js');
  assert.ok(Array.isArray(entry.inject), 'inject 必须是数组');
  assert.ok(entry.inject.includes('sessions'), 'inject 必须含 sessions（手动压缩要 flush）');
  assert.ok(entry.inject.includes('llm'), 'inject 必须含 llm');
  assert.ok(entry.inject.includes('tokenMeter'), 'inject 必须含 tokenMeter');
});

test('V2-F03: 内部错误码全部映射到官方六码，不会撞 assertNever', () => {
  const internal = [
    'busy',
    'ABORTED',
    'cancelled',
    'SPAN_CHANGED',
    'changed',
    'commit',
    'persistence',
    'SUMMARY_NOT_SMALLER',
    'SUMMARY_TIMEOUT',
    'SUMMARY_ALL_FAILED',
    'NO_SUMMARY_TARGET',
    'MAX_TOKENS',
    'UNSUPPORTED_CONTENT',
    'CONTEXT_WINDOW_EXCEEDED',
    'WHATEVER_UNKNOWN',
    undefined,
  ];
  for (const code of internal) {
    const mapped = toManualCode(code, 'summary');
    assert.ok(MANUAL_CODES.includes(mapped), `${code} → ${mapped} 必须落在官方六码内`);
  }
  // 未知码按阶段兜底
  assert.equal(toManualCode('WHATEVER_UNKNOWN', 'commit'), 'commit');
  assert.equal(toManualCode('WHATEVER_UNKNOWN', 'summary'), 'summary');
});

test('V2-F03: asManualError 产出官方形状，且不二次包装', () => {
  const plain = new Error('upstream exploded');
  plain.code = 'SPAN_CHANGED';
  const wrapped = asManualError(plain, 'commit');
  assert.equal(wrapped.name, 'ManualCompactionError');
  assert.equal(wrapped.code, 'changed', 'SPAN_CHANGED 必须映射成 changed');
  assert.equal(wrapped.message, 'upstream exploded', '消息原文必须保留');
  assert.equal(wrapped.cause, plain, 'cause 必须指向原始错误');

  // 已经是正确形状的原样返回，重试/递归路径上不会套娃
  assert.equal(asManualError(wrapped, 'summary'), wrapped);

  // 没有 code 的普通 Error 也要归类，不能漏成未处理异常
  const bare = asManualError(new Error('boom'), 'commit');
  assert.equal(bare.code, 'commit');
  assert.equal(asManualError(new Error('boom'), 'summary').code, 'summary');
});

test('V2-F04: 窗口溢出按 code 判 recoverable，不依赖 message 关键词', () => {
  // 适配器常把上游原文吞掉，只留 "request failed" 这种通用文案。
  // 只看 message 会把最该缩小跨度重试的一类失败判成不可恢复。
  const aggregated = new Error('all summarization targets failed');
  aggregated.code = 'SUMMARY_ALL_FAILED';
  aggregated.recoverable = true;
  const engine = Object.create(WeaveCompactionEngine.prototype);
  assert.equal(engine._isRecoverable(aggregated), true, '聚合错误要看 recoverable 标记');

  const byCode = new Error('request failed');
  byCode.code = 'CONTEXT_WINDOW_EXCEEDED';
  assert.equal(engine._isRecoverable(byCode), true, 'code 命中必须可恢复');

  const byMessage = new Error('the context length is too long');
  byMessage.code = 'UPSTREAM';
  assert.equal(engine._isRecoverable(byMessage), true, 'message 命中也要可恢复');

  assert.equal(engine._isRecoverable(Object.assign(new Error('x'), { code: 'SUMMARY_TIMEOUT' })), false);
  assert.equal(engine._isRecoverable(Object.assign(new Error('x'), { code: 'ABORTED' })), false);
});

test('V2-F05: 压缩成功后必须解除熔断，否则一次瞬时故障永久停压', () => {
  const engine = Object.create(WeaveCompactionEngine.prototype);
  const session = { id: 'session-breaker' };
  engine._stopped = new Map();
  engine._failures = new Map();
  engine._stopped.set(engine._keyOf(session), true);
  assert.equal(engine._stopped.has(engine._keyOf(session)), true, '前置：会话已熔断');
  // 模拟成功提交后那一行
  engine._stopped.delete(engine._keyOf(session));
  assert.equal(engine._stopped.has(engine._keyOf(session)), false, '成功后必须解除熔断');
});

test('V2-F06: modelPolicies 的 maxTokens 必须真的进到 spec', () => {
  const config = resolveConfig({
    modelPolicies: [{ provider: 'deepseek-account', model: 'deepseek-flash', maxTokens: 256 }],
  }).config;
  const effective = resolveTargetPolicy(config, 'deepseek-account', 'deepseek-flash');
  assert.equal(effective.maxTokens, 256, '命中后必须覆盖 maxTokens');
  const spec = resolveCompactSpec(effective, 200000, 8192);
  assert.equal(spec.maxTokens, 256, 'spec 上的 maxTokens 必须是覆盖后的值');
  // 没命中的模型仍然用全局值
  const other = resolveTargetPolicy(config, 'other', 'model');
  assert.equal(other.maxTokens, config.maxTokens, '未命中必须保持全局值');
});

// ───────────────────────────────────────────────── 第三轮审查（V3）回归

/** 造一个只够构造引擎的最小 ctx。 */
function fakeEngineCtx(overrides = {}) {
  const handlers = new Map();
  return {
    handlers,
    on(type, handler) {
      handlers.set(type, handler);
    },
    provide() {},
    get() {
      return undefined;
    },
    logger: { info() {}, warn() {}, debug() {} },
    llm: {},
    ...overrides,
  };
}

function makeEngine(config) {
  return new WeaveCompactionEngine(fakeEngineCtx(), resolveConfig(config).config);
}

await atest('V3-F01: 手动失败必须抛宿主那个类的实例，同形类过不了 instanceof', async () => {
  // 宿主只认 `error instanceof ManualCompactionError`（`dsh-command-compact/lib/index.js:65-71`），
  // 自己声明一个同名同码的类在 instanceof 上恒为 false。
  class HostManualCompactionError extends Error {
    constructor(code, message, options) {
      super(message, options);
      this.code = code;
      this.name = 'ManualCompactionError';
    }
  }
  const ctx = {
    get(name) {
      if (name !== 'loader') return undefined;
      return { import: async () => ({ ManualCompactionError: HostManualCompactionError }) };
    },
  };
  const error = new Error('boom');
  error.code = 'SPAN_CHANGED';
  const wrapped = await asHostManualError(ctx, error, 'commit');
  assert.ok(wrapped instanceof HostManualCompactionError, '必须是宿主类实例，否则 /compact 会 rethrow');
  assert.equal(wrapped.code, 'changed', '内部码要映射到官方码');
  assert.equal(wrapped.cause, error, 'cause 要保留原始错误');
  // 已经是宿主实例的，原样返回，不二次包装
  assert.equal(await asHostManualError(ctx, wrapped, 'commit'), wrapped);
});

await atest('V3-F01: 取不到宿主类时退回同形实现，不能让插件加载失败', async () => {
  const ctx = { get: () => undefined };
  const error = new Error('boom');
  error.code = 'SUMMARY_TIMEOUT';
  const wrapped = await asHostManualError(ctx, error, 'summary');
  assert.equal(wrapped.name, 'ManualCompactionError');
  assert.equal(wrapped.code, 'summary');
  // 加载器抛错也必须被吞掉
  const throwCtx = { get: () => ({ import: async () => { throw new Error('nope'); } }) };
  const fallback = await asHostManualError(throwCtx, error, 'summary');
  assert.equal(fallback.code, 'summary');
});

await atest('V3-F02: 合并后的策略必须一路传到摘要目标解析', async () => {
  const engine = makeEngine({
    modelPolicies: [
      {
        provider: 'p',
        model: 'm',
        summarizationProvider: 'sp',
        summarizationModel: 'sm',
        maxTokens: 256,
      },
    ],
  });
  engine.ctx.llm.resolveModelInfo = async () => ({ contextWindow: 200000, maxTokens: 8192 });
  const agent = {
    options: { provider: 'p', model: 'm' },
    session: { id: 's', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) },
  };
  const spec = await engine._resolveSpec(agent, null, undefined);
  assert.equal(spec.maxTokens, 256, 'spec 要带合并后的输出上限');
  assert.ok(spec.policy, 'spec 必须带上合并后的整份策略');
  // 摘要链要用这份策略，才能把 modelPolicies 的摘要模型排进去
  const chain = resolveSummaryTargets({ config: spec.policy, agent });
  assert.equal(chain.targets[0].provider, 'sp', '摘要链第一位必须来自 modelPolicies');
  assert.equal(chain.targets[0].model, 'sm');
});

await atest('V3-F03: 溢出重试上限要按目标模型策略读，不能被全局值盖掉', async () => {
  const engine = makeEngine({
    maxOverflowRetries: 1,
    modelPolicies: [{ provider: 'p', model: 'm', maxOverflowRetries: 0 }],
  });
  const handler = engine.ctx.handlers.get('agent/request-error');
  assert.equal(typeof handler, 'function', '必须注册溢出处理器');

  let compacted = 0;
  engine.compactIfNeeded = async () => {
    compacted += 1;
    return { shadowedSeqs: [0], shadowedTokenCount: 10, summarySeq: 1 };
  };
  const agent = {
    options: { provider: 'p', model: 'm' },
    session: {
      id: 's',
      surface: { replaceGeneration: 0 },
      requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    },
  };
  let nexted = 0;
  const outcome = await handler(
    { agent, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: { aborted: false } },
    () => {
      nexted += 1;
      return 'next';
    },
  );
  assert.equal(outcome, 'next', '目标模型 maxOverflowRetries=0 时必须直接放行原始错误');
  assert.equal(compacted, 0, '不允许为它触发溢出压缩');
  assert.equal(nexted, 1);
});

test('V3-F04/V4-02: 预留输出预算只认 header 与适配器默认值，缺省是 0', () => {
  const engine = makeEngine({ maxTokens: 8192 });
  const agent = {
    options: { maxTokens: 32000 },
    session: { requestHeader: () => ({ config: { maxTokens: 4096 } }) },
  };
  assert.equal(
    engine._reservedCompletionTokens(agent, 65536),
    4096,
    'header 是这次请求真实用的上限，比适配器默认值更权威',
  );

  // ⚠️ V4-02：header 没有 cap 时**不能**退回 `agent.options.maxTokens`。
  // 那是 agent 创建时的初始值，不等于这次请求实际会用的输出上限；宿主在这里
  // 直接取适配器报出来的默认值（`dsh-compaction-basic/lib/index.js:757-759`）。
  const noHeader = { options: { maxTokens: 32000 }, session: { requestHeader: () => ({}) } };
  assert.equal(
    engine._reservedCompletionTokens(noHeader, 65536),
    65536,
    'header 无 cap 时必须用适配器默认值，不能被 agent 初始选项顶掉',
  );

  // 全都没有就是 0，不是插件自己的摘要 maxTokens（8192 与对话请求的预留无关）。
  assert.equal(
    engine._reservedCompletionTokens({ session: {} }, undefined),
    0,
    '没有任何来源时必须预留 0，凭空 8192 会让压缩线提前触发',
  );
});

test('V3-F05: 目标给了 retainRatio 就必须抹掉全局的 retainTokens', () => {
  const config = resolveConfig({
    retainTokens: 1000,
    modelPolicies: [{ provider: 'p', model: 'm', retainRatio: 0.3 }],
  }).config;
  const merged = resolveTargetPolicy(config, 'p', 'm');
  assert.equal(merged.retainRatio, 0.3, '目标的 retainRatio 必须生效');
  assert.equal(merged.retainTokens, undefined, '全局 retainTokens 必须被抹掉，否则它会一直赢');
  // 反向：目标给了 retainTokens，全局的 retainRatio 也要消失
  const reverse = resolveConfig({
    retainRatio: 0.2,
    modelPolicies: [{ provider: 'p', model: 'm', retainTokens: 5000 }],
  }).config;
  const mergedReverse = resolveTargetPolicy(reverse, 'p', 'm');
  assert.equal(mergedReverse.retainTokens, 5000);
  assert.equal(mergedReverse.retainRatio, undefined);
});

test('V3-F06: modelPolicies 校验与宿主同强度（重复 / 互斥 / 成对 / 未知键）', () => {
  assert.throws(
    () =>
      resolveConfig({
        modelPolicies: [
          { provider: 'p', model: 'm' },
          { provider: 'p', model: 'm' },
        ],
      }),
    /duplicate model policy for p\/m/,
  );
  assert.throws(
    () => resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', retainRatio: 0.3, retainTokens: 100 }] }),
    /retainRatio and retainTokens are mutually exclusive/,
  );
  assert.throws(
    () => resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', summarizationProvider: 'sp' }] }),
    /must be set together/,
  );
  assert.throws(
    () => resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', auto: true }] }),
    /unknown key "auto"/,
  );
  // 顶层同样互斥
  assert.throws(
    () => resolveConfig({ retainRatio: 0.2, retainTokens: 100 }),
    /retainRatio and retainTokens are mutually exclusive/,
  );
});

await atest('V3-F07: 归档失败必须中止压缩，不能带着 archivePath=null 提交', async () => {
  // 压缩提交后被折叠消息只剩归档一处可读，归档悄悄失败等于把"可回查"作废。
  // 这里用源码级断言守住那段守卫：删掉它，这条用例立刻红。
  const source = await readFile(new URL('../lib/engine.js', import.meta.url), 'utf8');
  assert.match(source, /error\.code = 'ARCHIVE_FAILED'/, '归档失败必须抛 ARCHIVE_FAILED');
  assert.match(
    source,
    /if \(!archivePath\) \{[\s\S]{0,400}?throw error;/,
    '写失败后必须在提交段之前抛出',
  );
  // 该码要能映射到官方六码
  assert.equal(toManualCode('ARCHIVE_FAILED'), 'summary');
});

// ───────────────────────────────────────────────── 第四轮审查（V4）回归

/**
 * 造一个能真的 `append`、真的做 surface 替换的假会话。
 *
 * 前三轮的夹具只读不写，所以事务收尾类的问题（写了几条 end、有没有 flush）
 * 在离线测试里根本观察不到。这里把 append 做成真的事件日志 + 真替换。
 */
function fakeLiveSession(rawEvents, options = {}) {
  const log = [];
  const bySeq = new Map();
  const surface = { nodes: [], replaceGeneration: 0 };
  let seqCounter = 0;

  const session = {
    id: options.id ?? `session-live-${process.pid}-${++liveSessionNumber}`,
    get seq() {
      return seqCounter;
    },
    surface,
    eventAt(seq) {
      return bySeq.get(seq);
    },
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (event.type === 'assistant/message') return event.data.message;
      if (event.type === 'tool/result') return { role: 'tool', content: event.data.content };
      return event.data?.message;
    },
    append(type, data, appendOptions) {
      if (typeof options.appendHook === 'function') {
        const override = options.appendHook(type, data, seqCounter);
        if (override instanceof Error) throw override;
      }
      const seq = seqCounter;
      seqCounter += 1;
      const event = { seq, type, data };
      bySeq.set(seq, event);
      log.push(event);
      const op = appendOptions?.surfaceOp;
      if (op && op.op === 'replace') {
        const startIdx = surface.nodes.indexOf(op.startSeq);
        const endIdx = surface.nodes.indexOf(op.endSeq);
        if (startIdx >= 0 && endIdx >= startIdx) {
          surface.nodes.splice(startIdx, endIdx - startIdx + 1, seq);
        } else {
          surface.nodes.push(seq);
        }
        surface.replaceGeneration += 1;
      } else if (type === 'user/message' || type === 'assistant/message' || type === 'system/message') {
        surface.nodes.push(seq);
      }
      return event;
    },
    requestHeader() {
      return { config: options.headerConfig ?? { provider: 'p', model: 'm' } };
    },
    toolHistory() {
      return [];
    },
  };

  for (const raw of rawEvents) {
    const seq = seqCounter;
    seqCounter += 1;
    const event = { seq, type: raw.type, data: raw.data };
    bySeq.set(seq, event);
    log.push(event);
    surface.nodes.push(seq);
  }
  return { session, log, surface, bySeq };
}

/**
 * 一段固定的"可压缩历史"：system + 开着的 turn + 三条够长的消息。
 *
 * 消息体刻意给到 4000 字符（约 1000 tokens）：九节摘要本身就约 215 tokens，
 * 跨度里只有两条消息时"摘要必须比原文小"会直接不成立 —— 那是夹具尺度
 * 造成的误判，不是被测逻辑的问题。
 */
function liveEvents() {
  const BODY = 4000;
  const text = (ch) => ({ message: { role: 'user', content: [{ type: 'text', text: ch.repeat(BODY) }] } });
  return [
    {
      type: 'system/message',
      data: { message: { role: 'system', content: [{ type: 'text', text: 'system prompt' }] } },
    },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: text('a') },
    {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: 'b'.repeat(BODY * 4) }] } },
    },
    { type: 'user/message', data: text('c') },
  ];
}

/**
 * 一份**结构合法**的九节摘要正文。
 *
 * 引擎在提交前会做确定性校验（`lib/validate.js`）：九个小节标题必须齐全，
 * 否则整次压缩按安全失败处理、不替换 surface。所以测试里的"正常摘要"
 * 必须真的是九节，不能再拿一句 `short summary` 凑数 —— 那样测的其实是
 * 失败路径。
 */
const VALID_SUMMARY = [
  '## 1. Primary Request and Intent',
  'Continue the compaction work.',
  '## 2. Key Technical Concepts',
  'Session surface, compaction checkpoint, KV cache.',
  '## 3. Files and Code Sections',
  'lib/engine.js, lib/region.js, lib/validate.js.',
  '## 4. Errors and Fixes',
  '(none)',
  '## 5. Problem Solving',
  'Preserved user wording verbatim.',
  '## 6. All User Messages',
  'See <preserved-user-messages> for the verbatim list.',
  '## 7. Pending Tasks',
  '(none)',
  '## 8. Work Completed',
  'Compaction transaction wired.',
  '## 9. Context for Continuing Work',
  'Run the offline suites.',
].join('\n');

/** `VALID_SUMMARY` 里第六节那两行（改夹具时到处要 replace 它）。 */
const VALID_SUMMARY_USER_SECTION = '## 6. All User Messages\nSee <preserved-user-messages> for the verbatim list.';

/** 指令块里那张「来源区间用户消息清单」的行首，用来识别追加的指令消息。 */
const MANIFEST_LINE = /^- seq (\d+)(?::\s*(.*))?$/;

/**
 * 按**这次请求实际带上的用户消息清单**拼一份第六节合法的摘要。
 *
 * 引擎现在真的会校验"第六节逐条交代了来源区间里的每条用户消息"，所以夹具不能
 * 再用一句「见保留容器」糊过去 —— 那样测的是失败路径，不是正常路径。
 *
 * 做法直接照着提示词的要求来：从追加的指令块里读出 `- seq N: 摘要` 那张清单，
 * 第六节逐条写成 `- seq N: ...`。这正是合规模型应该产出的形状，引用 seq 也算
 * 交代（`validateUserMessageSection` 认这个写法），而且不会把几千字的原话在摘要
 * 里再抄一遍、把"摘要必须更小"那条撞红。
 *
 * 找不到清单时（极少数不经过 `summarizeWithTarget` 的路径）退回逐字列，宁可啰嗦
 * 也不要静默产出非法摘要。
 */
function summaryForMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const instruction = list.length > 0 ? list[list.length - 1] : null;
  const instructionText =
    instruction && instruction.role === 'user' && Array.isArray(instruction.content)
      ? instruction.content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
      : '';

  const cited = [];
  for (const line of instructionText.split('\n')) {
    const match = MANIFEST_LINE.exec(line.trim());
    if (match === null) continue;
    const note = (match[2] ?? '').trim();
    cited.push(note.length === 0 ? `- seq ${match[1]}` : `- seq ${match[1]}: ${note}`);
  }
  if (cited.length > 0) {
    return VALID_SUMMARY.replace(
      VALID_SUMMARY_USER_SECTION,
      `## 6. All User Messages\n${cited.join('\n')}`,
    );
  }

  // 兜底：逐字列出所有用户消息，但跳过最后那条指令本身。
  const users = [];
  for (const message of list.slice(0, -1)) {
    if (message?.role !== 'user') continue;
    const content = message.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((block) => block?.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text)
              .join('\n')
          : '';
    if (text.trim().length > 0) users.push(text);
  }
  const body = users.length === 0 ? '(none)' : users.map((text) => `- ${text}`).join('\n');
  return VALID_SUMMARY.replace(VALID_SUMMARY_USER_SECTION, `## 6. All User Messages\n${body}`);
}

/** 造一个流式摘要脚本；`sink` 收集每次真实请求的 options。 */
function scriptedStream(sink, text = summaryForMessages) {
  return async function* stream(options) {
    if (sink) sink.push(options);
    // `text` 允许是函数：第六节必须按**这次请求实际带了哪些用户消息**来写，
    // 写死字符串会永远和来源区间对不上。
    const value = typeof text === 'function' ? text(options.messages) : text;
    yield { type: 'text-delta', text: value };
    yield { type: 'finish', kind: 'stop' };
  };
}

function makeLiveEngine(config, ctxOverrides = {}) {
  const ctx = fakeEngineCtx({
    tokenMeter: {
      measure(session) {
        // 每条事件算 1000 tokens：九节摘要本身约 200 tokens，被压跨度只有
        // 两条事件时"摘要必须更小"这条会误伤 —— 那是夹具尺度问题，不是逻辑问题。
        const nodes = session.surface.nodes.map(seq => ({ seq, tokens: approxTokens(blocksToText(session.deriveEventMessage(session.eventAt(seq))?.content)) }));
        return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) };
      },
    },
    sessions: { async flush() {} },
    llm: { stream: scriptedStream(null) },
    ...ctxOverrides,
  });
  return new WeaveCompactionEngine(ctx, resolveConfig(config).config);
}

await atest('V4-01/V7-05: 替换之前的 flush 失败时，surface 一个字节都不许动', async () => {
  const engine = makeLiveEngine(
    { preserveRecentMessages: null, archiveEnabled: false },
    {
      sessions: {
        async flush() {
          throw new Error('disk full');
        },
      },
    },
  );
  const { session, log, surface } = fakeLiveSession(liveEvents());
  const error = await engine
    ._compactSpan(1, 3, { session }, undefined, { manual: true, turn: null }, 0)
    .then(() => null, (e) => e);

  assert.ok(error, 'flush 失败必须让这次压缩以失败告终');
  assert.equal(error.code, 'commit', `提交前未完成，不能映射到宿主已完成的 persistence 提示，实际 ${error.code}`);

  // 这是 V7-05 的核心：flush 挪到了替换**之前**，所以它失败时替换还没发生。
  // 旧实现先替换再等持久化，失败时 surface 已经被收掉了，收不回来。
  assert.equal(surface.replaceGeneration, 0, '替换前的持久化失败，surface 必须原封不动');

  const ends = log.filter((event) => event.type === 'compaction/end');
  assert.equal(ends.length, 1, `同一个 compactionId 只能有一条 end，实际写了 ${ends.length} 条`);
  assert.match(String(ends[0].data.error), /persistence/, '这条 end 要写明失败原因');
});

await atest('V4-01/V7-05: 替换之后 end 写不进去，必须补一次把锁关上', async () => {
  let endAttempts = 0;
  const engine = makeLiveEngine({ preserveRecentMessages: null, archiveEnabled: false });
  const { session, surface, log } = fakeLiveSession(liveEvents(), {
    appendHook(type) {
      if (type !== 'compaction/end') return undefined;
      endAttempts += 1;
      return new Error('append exploded');
    },
  });
  const error = await engine
    ._compactSpan(1, 3, { session }, undefined, { manual: true, turn: null }, 0)
    .then(() => null, (e) => e);

  assert.ok(error, 'end 写不进去必须抛错');
  // 替换已经发生，此时留一把永远不开的锁会让会话一路涨到 413 ——
  // 所以这里允许（且要求）补一次。补完仍失败才真的放弃。
  assert.equal(endAttempts, 2, `替换之后 end 失败要补一次，实际尝试 ${endAttempts} 次`);
  assert.equal(surface.replaceGeneration, 1, '替换本身已经生效，无法回滚');
  assert.equal(error.compactionStage, 'commit', 'end 写失败属于提交段');
  assert.equal(log.filter((event) => event.type === 'compaction/end').length, 0, '两次尝试都被 appendHook 拦下了');
});

await atest('V4-03: 公开 compactRegion 也要走 modelPolicies 的摘要策略', async () => {
  const calls = [];
  const engine = makeLiveEngine(
    {
      preserveRecentMessages: null,
      archiveEnabled: false,
      maxTokens: 8192,
      modelPolicies: [
        { provider: 'p', model: 'm', summarizationProvider: 'sp', summarizationModel: 'sm', maxTokens: 512 },
      ],
    },
    { llm: { stream: scriptedStream(calls) } },
  );
  const { session } = fakeLiveSession(liveEvents());
  const result = await engine.compactRegion(1, 3, { session }, undefined);

  assert.ok(result, 'compactRegion 必须真的压成功');
  assert.equal(calls.length, 1, '只该发一次摘要请求');
  assert.equal(calls[0].provider, 'sp', '溢出恢复走的是同一个模型，必须用目标策略的摘要模型');
  assert.equal(calls[0].model, 'sm');
  assert.equal(calls[0].maxTokens, 512, '输出上限也必须按目标模型算，不能退回全局 8192');
});

test('V4-04: modelPolicies.maxTokens 与宿主同值域，1–255 不能被拒', () => {
  // 宿主 `assertPositiveInteger` 只拒 <= 0；卡 256 会把宿主合法的配置变成
  // `apply()` 阶段抛错 = 整行引擎加载失败。
  const { config } = resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', maxTokens: 128 }] });
  assert.equal(config.modelPolicies[0].maxTokens, 128);
  assert.throws(
    () => resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', maxTokens: 0 }] }),
    /maxTokens/,
  );
});

await atest('V4-05: 维护窗口被收回算取消，不算摘要失败', async () => {
  const engine = makeEngine({});
  const reason = new Error('maintenance withdrawn');
  const controller = new AbortController();
  controller.abort(reason);
  engine._compactManual = async () => {
    throw reason;
  };
  const agent = { session: { id: 's' }, runMaintenance: async (cb) => cb(controller.signal) };
  const error = await engine._compactNowInner(agent, undefined).then(() => null, (e) => e);

  assert.ok(error, '取消也要抛出，只是错误码不同');
  assert.equal(error.code, 'cancelled', `期望 cancelled，实际 ${error.code}`);
  assert.equal(error.cause, reason, '原始中止原因要留在 cause 里');
});

await atest('V4-05: 压缩自身出错时不能被误判成取消', async () => {
  const engine = makeEngine({});
  const boom = new Error('auth failed');
  engine._compactManual = async () => {
    throw boom;
  };
  const controller = new AbortController();
  const agent = { session: { id: 's' }, runMaintenance: async (cb) => cb(controller.signal) };
  const error = await engine._compactNowInner(agent, undefined).then(() => null, (e) => e);

  assert.equal(error, boom, 'signal 没中止时，原错误必须原样往上抛');
});

test('V4-06: ratio 的合法区间是 (0, 1]，0 必须被拒', () => {
  assert.throws(
    () => resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', thresholdRatio: 0 }] }),
    /\(0, 1\]/,
  );
  assert.throws(
    () => resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', retainRatio: 0 }] }),
    /\(0, 1\]/,
  );
});

test('V4-06: 目标覆盖与全局继承合并后仍要 retainRatio < thresholdRatio', () => {
  // 单看 `{thresholdRatio: 0.2}` 自己合法，配上全局 `retainRatio: 0.3` 才冲突。
  // 加载期不查出来，就要等真的命中这个模型才在 `resolveCompactSpec` 里炸，
  // 那时摘要请求一次都没发出去。
  assert.throws(
    () => resolveConfig({ retainRatio: 0.3, modelPolicies: [{ provider: 'p', model: 'm', thresholdRatio: 0.2 }] }),
    /retainRatio \(0\.3\) must be less than the resolved thresholdRatio \(0\.2\)/,
  );
  // 目标自己把保留量给对了就不该报。
  const { config } = resolveConfig({
    retainRatio: 0.3,
    modelPolicies: [{ provider: 'p', model: 'm', thresholdRatio: 0.2, retainRatio: 0.1 }],
  });
  assert.equal(config.modelPolicies[0].retainRatio, 0.1);
});

// ───────────────────────────────────────────────── 第五轮审查（V5）回归

await atest('V5-01: 预算解析失败也不能丢掉目标摘要策略', async () => {
  // 目标策略给了 `retainTokens: 500000`：绝对 token 数跟窗口大小有关，加载期
  // 查不出来（`validateModelPolicyRetention` 对绝对保留量只能放行），但运行到
  // `resolveCompactSpec` 时 retainTokens 会超过 thresholdTokens → 必抛。
  // 而"摘要该发给谁"跟预算无关：策略里明确写了 summary-p/summary-m。
  const calls = [];
  const engine = makeLiveEngine(
    {
      preserveRecentMessages: null,
      archiveEnabled: false,
      modelPolicies: [
        {
          provider: 'p',
          model: 'm',
          summarizationProvider: 'summary-p',
          summarizationModel: 'summary-m',
          maxTokens: 128,
          retainTokens: 500000,
        },
      ],
    },
    { llm: { stream: scriptedStream(calls) } },
  );
  const { session } = fakeLiveSession(liveEvents(), { headerConfig: { provider: 'p', model: 'm', maxTokens: 4096 } });

  // 先确认这个配置确实会让 _resolveSpec 抛错（否则本用例测不到目标分支）。
  const specError = await engine._resolveSpec({ session }, undefined, undefined).then(() => null, (e) => e);
  assert.ok(specError, '这组预算必须让 _resolveSpec 抛错，否则用例没有覆盖到异常分支');

  const result = await engine.compactRegion(1, 3, { session }, undefined);
  assert.ok(result, '预算失败不应阻止区间压缩本身');

  assert.equal(calls.length, 1, `摘要请求只应发一次，实际 ${calls.length}`);
  assert.equal(calls[0].provider, 'summary-p', `摘要被静默改道到 ${calls[0].provider}`);
  assert.equal(calls[0].model, 'summary-m', `摘要被静默改道到 ${calls[0].model}`);
  assert.equal(calls[0].maxTokens, 128, `输出上限应为目标策略的 128，实际 ${calls[0].maxTokens}`);
});

await atest('V5-02: 顶层 maxTokens 是正整数就必须原样保留，不许静默抬高', async () => {
  for (const value of [1, 128, 255, 256]) {
    const config = resolveConfig({ maxTokens: value }).config;
    assert.equal(config.maxTokens, value, `顶层 maxTokens=${value} 被改成了 ${config.maxTokens}`);
  }
  // 非法值要明确拒绝，而不是悄悄替换成默认值。
  for (const bad of [0, -1, 12.5, '128', NaN]) {
    assert.throws(() => resolveConfig({ maxTokens: bad }), /maxTokens/, `maxTokens=${String(bad)} 应被拒绝`);
  }
});

await atest('V5-02: 顶层 maxTokens 真的进到摘要请求', async () => {
  const calls = [];
  const engine = makeLiveEngine(
    { maxTokens: 128, preserveRecentMessages: null, archiveEnabled: false },
    { llm: { stream: scriptedStream(calls) } },
  );
  const { session } = fakeLiveSession(liveEvents());
  await engine.compactRegion(1, 3, { session }, undefined);
  assert.equal(calls[0].maxTokens, 128, `摘要请求应为 128，实际 ${calls[0].maxTokens}`);
});

await atest('V5-03/V8-02: 替换前的 flush 期间被取消，surface 一个字节都不许动', async () => {
  const controller = new AbortController();
  const engine = makeLiveEngine(
    { preserveRecentMessages: null, archiveEnabled: false },
    {
      sessions: {
        async flush() {
          // 模拟维护窗口在持久化等待期间被收回。这次 flush 发生在**替换之前**，
          // 所以取消必须让替换根本不发生 —— 用户收到 cancelled，历史却已经被
          // 改写，是比"压缩失败"严重得多的事。
          controller.abort(new Error('maintenance revoked'));
        },
      },
    },
  );
  const { session, log } = fakeLiveSession(liveEvents());
  const error = await engine
    ._compactSpan(1, 3, { session }, controller.signal, { manual: true, turn: null }, 0)
    .then(() => null, (e) => e);

  assert.ok(error, 'flush 期间被取消必须让这次操作以失败告终');
  assert.equal(error.code, 'cancelled', `期望 cancelled，实际 ${error.code}`);
  assert.equal(session.surface.replaceGeneration, 0, '替换前取消，surface 必须原封不动');
  // 生命周期要关上：end 仍然落盘，并带上失败原因。不关会留一把孤儿锁，
  // 会话带着它一路涨到 413。
  const ends = log.filter((event) => event.type === 'compaction/end');
  assert.equal(ends.length, 1, '替换前取消也必须写一条 end 把生命周期关掉');
  assert.match(String(ends[0].data.error), /cancel|abort/i, 'end 要带上取消原因');
});

await atest('V5-03: 没被取消时 flush 之后仍回成功', async () => {
  const controller = new AbortController();
  const engine = makeLiveEngine({ preserveRecentMessages: null, archiveEnabled: false });
  const { session } = fakeLiveSession(liveEvents());
  const result = await engine._compactSpan(1, 3, { session }, controller.signal, { manual: true, turn: null }, 0);
  assert.ok(result, '未取消时必须正常返回结果');
});

await atest('V5-03: 自动路径（非手动）不做 flush 后取消检查', async () => {
  // 自动压缩的 signal 归 agent-loop 管，取消语义由外层决定；
  // 这里只确认新增的检查没有误伤自动路径。
  const controller = new AbortController();
  const engine = makeLiveEngine({ preserveRecentMessages: null, archiveEnabled: false });
  const { session } = fakeLiveSession(liveEvents());
  const result = await engine
    ._compactSpan(1, 3, { session }, controller.signal, { manual: false, turn: 1 }, 0)
    .then((value) => value, (e) => e);
  assert.ok(result && result.compactionId, `自动路径应正常完成，实际 ${result?.message ?? result}`);
});

// ─────────────────────────────────────── 第六轮：C05 全量逐字保留

await atest('C05: 显式足量预算完整保留用户原话', async () => {
  const engine = makeLiveEngine({ archiveEnabled: false, preserveRecentUserTokens: 20000 });
  const events = liveEvents();
  // 再加 5 条用户消息，凑到 7 条 —— 旧实现默认只留最近 3 条。
  for (let index = 0; index < 5; index += 1) {
    events.push({
      type: 'user/message',
      data: { message: { role: 'user', content: [{ type: 'text', text: `turn-${index}-${'x'.repeat(4000)}` }] } },
    });
    events.push({
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: `ack-${index} ${'assistant analysis '.repeat(2000)}` }] } },
    });
  }
  const { session, log } = fakeLiveSession(events);
  const result = await engine._compactSpan(1, events.length - 2, { session }, undefined, { manual: true, turn: null }, 0);

  assert.equal(result.preservedUserMessages, 7, `应保留 7 条用户原话，实际 ${result.preservedUserMessages}`);
  const checkpoint = log.find((event) => event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint');
  assert.ok(checkpoint, '应写出检查点消息');
  const body = checkpoint.data.content.map((block) => block.text).join('\n');
  for (let index = 0; index < 5; index += 1) {
    assert.ok(body.includes(`turn-${index}-`), `第 ${index} 条用户原话必须逐字出现在检查点里`);
  }
});

await atest('C05: 无归档时不能移出超预算原话', async () => {
  const engine = makeLiveEngine({ archiveEnabled: false });
  const huge = 'H'.repeat(120000); // 远超旧的 20000 token 预算
  // 跨度里**只有用户消息**：逐字保留后检查点必然不比原文小，
  // 这时按 C05 的验收要求必须安全失败，而不是悄悄丢掉原话换成功。
  const events = [
    { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'sp' }] } } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: huge }] } } },
    { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: 'short one' }] } } },
  ];
  const { session, log } = fakeLiveSession(events);
  const error = await engine
    ._compactSpan(1, 3, { session }, undefined, { manual: true, turn: null }, 0)
    .then(() => null, (e) => e);

  assert.ok(error, '保留全部原话后不再变小，必须失败');
  assert.equal(error.code, 'MEMORY_ARCHIVE_REQUIRED', `无归档不得移出原话，实际 ${error.code}`);
  assert.equal(session.surface.replaceGeneration, 0, 'surface 必须完全未替换');
  assert.equal(log.filter((event) => event.type === 'compaction/end').length, 1, 'end 只写一条失败记录');
  assert.equal(log.filter((event) => event.type === 'compaction/summary').length, 0, '不得写出摘要事件');
});

await atest('C05: 空白与缩进原样保留，不 trim 不合并', async () => {
  const engine = makeLiveEngine({ archiveEnabled: false });
  const raw = '  leading spaces\n\n\tcode block\n    indented line  \n';
  const events = [
    ...liveEvents(),
    { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: raw }] } } },
  ];
  const { session, log } = fakeLiveSession(events);
  await engine._compactSpan(1, 5, { session }, undefined, { manual: true, turn: null }, 0);
  const checkpoint = log.find((event) => event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint');
  const body = checkpoint.data.content.map((block) => block.text).join('\n');
  assert.ok(body.includes(raw), '原话的空格、空行、制表符、行尾空格都必须原样保留');
});

await atest('C05: 多 text 块消息按块分别标注，块边界不丢', async () => {
  const engine = makeLiveEngine({ archiveEnabled: false });
  const events = [
    ...liveEvents(),
    {
      type: 'user/message',
      data: {
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'first-block' },
            { type: 'text', text: 'second-block' },
          ],
        },
      },
    },
  ];
  const { session, log } = fakeLiveSession(events);
  await engine._compactSpan(1, 5, { session }, undefined, { manual: true, turn: null }, 0);
  const checkpoint = log.find((event) => event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint');
  const body = checkpoint.data.content.map((block) => block.text).join('\n');
  assert.match(body, /Block 1\n```text\nfirst-block/, '第六节保留第一块');
  assert.match(body, /Block 2\n```text\nsecond-block/, '第六节保留第二块');
  assert.equal((body.match(/first-block/g)||[]).length,1,'原话只渲染一份');
});

await atest('C05: 跨代续传 —— 第二代检查点仍携带第一代的原始原话', async () => {
  const engine = makeLiveEngine({ archiveEnabled: false });
  const first = 'first-generation-original-wording';
  const events = [
    ...liveEvents(),
    { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: first }] } } },
  ];
  const { session, log } = fakeLiveSession(events);
  await engine._compactSpan(1, 5, { session }, undefined, { manual: true, turn: null }, 0);

  // 真实场景：第一代检查点之后又跑了很多轮，第二轮压缩要折叠「检查点 + 新历史」。
  // 跨度里必须有足够的可折叠内容，否则"逐字保留 + 必须变小"本来就不可能同时成立
  // —— 那种情况按 C05 的验收要求就是安全失败，不能靠丢原话来换成功。
  const events2 = [
    ...events,
    ...log.map((event) => ({ type: event.type, data: event.data })),
  ];
  for (let index = 0; index < 6; index += 1) {
    events2.push({
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: `work-${index}-${'w'.repeat(4000)}` }] } },
    });
    if (index % 2 === 0) {
      events2.push({
        type: 'user/message',
        data: { message: { role: 'user', content: [{ type: 'text', text: `ask-${index}` }] } },
      });
    }
  }
  const second = fakeLiveSession(events2);
  await engine._compactSpan(1, events2.length - 2, { session: second.session }, undefined, {
    manual: true,
    turn: null,
  }, 0);
  // ⚠️ 必须取**最后一条**检查点：`events2` 里还带着第一代那条，
  // `find` 会返回第一个匹配，读到的其实是被带过来的旧检查点。
  const generations = second.log.filter(
    (event) => event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint',
  );
  assert.ok(generations.length >= 2, `应至少有两代检查点，实际 ${generations.length}`);
  const body2 = generations[generations.length - 1].data.content.map((block) => block.text).join('\n');
  assert.ok(body2.includes(first), '第一代的原始原话必须继续出现在第二代检查点里');
  assert.ok(body2.includes('ask-4'), '第二代新增的用户原话也必须逐字保留');
});

// ─────────────────────────────────────── 第六轮：C04 提交前确定性校验

await atest('C04: 模型只回 Done. 时必须判结构不合格，不能提交', async () => {
  const engine = makeLiveEngine(
    { archiveEnabled: false },
    { llm: { stream: scriptedStream(null, 'Done.') } },
  );
  const { session, log } = fakeLiveSession(liveEvents());
  const error = await engine
    ._compactSpan(1, 3, { session }, undefined, { manual: true, turn: null }, 0)
    .then(() => null, (e) => e);
  assert.ok(error, '缺九节结构必须失败');
  assert.equal(error.code, 'SUMMARY_STRUCTURE_INVALID', `期望 SUMMARY_STRUCTURE_INVALID，实际 ${error.code}`);
  assert.equal(session.surface.replaceGeneration, 0, 'surface 必须完全未替换');
  assert.equal(log.filter((event) => event.type === 'compaction/summary').length, 0, '不得写出摘要事件');
});

await atest('C04: 九节齐全但缺第 6 节时也要判不合格', async () => {
  const partial = VALID_SUMMARY.replace('## 6. All User Messages\nSee <preserved-user-messages> for the verbatim list.\n', '');
  const engine = makeLiveEngine({ archiveEnabled: false }, { llm: { stream: scriptedStream(null, partial) } });
  const { session } = fakeLiveSession(liveEvents());
  const error = await engine
    ._compactSpan(1, 3, { session }, undefined, { manual: true, turn: null }, 0)
    .then(() => null, (e) => e);
  assert.equal(error?.code, 'SUMMARY_STRUCTURE_INVALID', `期望 SUMMARY_STRUCTURE_INVALID，实际 ${error?.code}`);
  assert.match(error.message, /All User Messages/, '错误信息要点名缺的是哪一节');
});

await atest('C04: 校验器按语言各认一套小节标题', async () => {
  const zh = [
    '## 1. 用户的核心请求与意图',
    'x',
    '## 2. 关键技术概念',
    'x',
    '## 3. 涉及的文件与代码',
    'x',
    '## 4. 错误与修复',
    'x',
    '## 5. 问题解决过程',
    'x',
    '## 6. 全部用户消息',
    'x',
    '## 7. 待办任务',
    'x',
    '## 8. 已完成的工作',
    'x',
    '## 9. 继续工作所需的上下文',
    'x',
  ].join('\n');
  assert.equal(validateSummaryStructure(zh, { language: 'zh' }).ok, true, '中文模板应通过中文校验');
  assert.equal(validateSummaryStructure(zh, { language: 'en' }).ok, false, '中文模板不该通过英文校验');
  assert.equal(validateSummaryStructure(VALID_SUMMARY, { language: 'en' }).ok, true, '英文模板应通过英文校验');
});

await atest('C04: 原话覆盖检查比对的是拼好的检查点，不依赖模型守规矩', async () => {
  const preserved = [{ seq: 7, blocks: [{ type: 'text', text: 'must-appear-verbatim' }] }];
  assert.equal(
    validateCheckpointCoverage([{ type: 'text', text: 'must-appear-verbatim' }], preserved).ok,
    true,
    '原话出现即通过',
  );
  const miss = validateCheckpointCoverage([{ type: 'text', text: 'something else' }], preserved);
  assert.equal(miss.ok, false, '原话缺失必须失败');
  assert.equal(miss.code, 'CHECKPOINT_COVERAGE_INCOMPLETE');
  assert.match(miss.message, /seq 7/, '错误信息要点名是哪一条');
});

// ─────────────────────────────────────── 第六轮：C02 压缩线严格早于阻断线

/** 小窗口场景：窗口 32768、输出预留 4096，headroom 仍是默认的 33000。 */
function smallWindowEngine(ctxOverrides = {}) {
  const engine = makeLiveEngine(
    { archiveEnabled: false, modelPolicies: [] },
    {
      llm: {
        stream: scriptedStream(null),
        async resolveModelInfo() {
          return { contextWindow: 32768, maxTokens: 4096 };
        },
      },
      ...ctxOverrides,
    },
  );
  return engine;
}

function smallWindowAgent(engine, session) {
  return {
    session,
    options: { provider: 'p', model: 'm', maxTokens: 4096 },
    runMaintenance: async (callback) => callback(new AbortController().signal),
  };
}

await atest('C02: 小窗口下 headroom 大于消息预算时，压缩线仍然早于阻断线', async () => {
  const engine = smallWindowEngine();
  const { session } = fakeLiveSession(liveEvents());
  const agent = smallWindowAgent(engine, session);
  // 窗口 32768 / 预留 4096 → 消息预算 28672，headroom 33000 已经超过它。
  const spec = await engine._resolveSpec(agent, null, undefined);

  assert.equal(spec.messageBudgetTokens, 32768 - 4096, '消息预算 = 窗口 − 输出预留');
  assert.ok(spec.thresholdTokens > 0, '压缩线不能是 0 或负数');
  assert.ok(
    spec.thresholdTokens <= spec.messageBudgetTokens,
    `压缩线 (${spec.thresholdTokens}) 不能越过阻断线 (${spec.messageBudgetTokens})`,
  );
  assert.ok(
    spec.thresholdTokens < spec.messageBudgetTokens,
    '压缩线必须**严格早于**阻断线，否则压缩永远来不及',
  );
});

await atest('C02: 小窗口下自动压缩真的会触发，而不是抛 no pressure budget', async () => {
  const engine = smallWindowEngine();
  // 每条 1000 tokens；阈值约 21504，所以 26 条足够越线。
  const events = [
    { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } } },
    { type: 'turn/start', data: { turn: 1 } },
  ];
  for (let index = 0; index < 26; index += 1) {
    events.push({
      type: index % 2 === 0 ? 'user/message' : 'assistant/message',
      data: { message: { role: index % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `m-${index}-${'x'.repeat(index % 2 === 0 ? 2000 : 7000)}` }] } },
    });
  }
  const { session } = fakeLiveSession(events);
  const agent = smallWindowAgent(engine, session);

  const result = await engine.compactIfNeeded(agent, 'pressure', undefined);
  assert.ok(result, '越线之后必须真的压一次，不能因为 headroom 大就静默跳过');
  assert.ok(session.surface.replaceGeneration >= 1, 'surface 必须被替换过');
});

await atest('C02: 小窗口下即使自动预算不合法，手动压缩短历史也能进摘要', async () => {
  const engine = smallWindowEngine();
  // ⚠️ 手动 `/compact` 只在会话空闲时可用：跨度里有 `turn/start`（未闭合的轮）
  // 时 `_compactRegionCore` 会以 busy 拒绝。这里要测的是"预算不拦手动"，
  // 不是"轮开着也能压"，所以先去掉那条 turn/start。
  const events = liveEvents().filter((event) => event.type !== 'turn/start');
  // A genuinely short complete request: this test covers manual pressure gating,
  // not a 24KB body plus duplicate originals against the new 16KB conservative budget.
  for (const event of events) for (const block of event.data?.message?.content ?? []) if (block.type === 'text') block.text = block.text.slice(0, event.type === 'assistant/message' ? 8000 : 200);
  const { session } = fakeLiveSession(events);
  const agent = smallWindowAgent(engine, session);

  // 3 条历史 + 每条 1000 tokens，远低于任何压缩线 —— 手动入口不该被自动预算拦。
  const result = await engine._compactManual(agent, undefined, undefined);
  assert.ok(result, '手动压缩必须能在短历史上完成，不受自动压力预算影响');
  assert.equal(session.surface.replaceGeneration, 1, '应当替换一次');
});

// ─────────────────────────────────────── 第六轮：C06 溢出渐进收敛

await atest('C06: 重试必须严格缩小跨度，同一区间不许重复烧调用', async () => {
  // 一个 60000 tokens 的尾节点：按 token 步长放宽保留量时，边界会被这个
  // 巨节点反复跨过，重选很容易拿回同一个跨度。这里直接构造这种分布。
  const events = [
    { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } } },
    ...liveEvents().filter((event) => event.type !== 'system/message'),
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: `huge-${'z'.repeat(4000)}` }] } } },
  ];
  const engine = makeLiveEngine(
    { archiveEnabled: false, reactiveStep: 3 },
    {
      tokenMeter: {
        measure(session) {
          const nodes = session.surface.nodes.map((seq) => ({
            seq,
            tokens: seq === session.surface.nodes[session.surface.nodes.length - 1] ? 60000 : 1000,
          }));
          return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) };
        },
      },
    },
  );

  const seen = [];
  const summaryCalls = [];
  engine.ctx.llm.stream = async function* stream(options) {
    summaryCalls.push(options);
    // 每次都失败，逼出全部重试路径。
    const error = new Error('context length exceeded');
    error.code = 'CONTEXT_WINDOW_EXCEEDED';
    throw error;
  };

  const { session } = fakeLiveSession(events);
  const originalCore = engine._compactRegionCore.bind(engine);
  engine._compactRegionCore = async (start, end, agent, signal, options) => {
    seen.push(`${start}-${end}`);
    return originalCore(start, end, agent, signal, options);
  };

  await engine
    .compactIfNeeded(
      {
        session,
        options: { provider: 'p', model: 'm', maxTokens: 4096 },
        runMaintenance: async (callback) => callback(new AbortController().signal),
      },
      'context-overflow',
      undefined,
    )
    .then(() => null, (e) => e);

  const unique = new Set(seen);
  assert.equal(
    unique.size,
    seen.length,
    `每次重试必须压不同的区间，实际重复了：${seen.join(' | ')}`,
  );
  assert.ok(seen.length <= 4, `重试次数必须有上限，实际 ${seen.length} 次`);
});

await atest('C06: 溢出首次从保留区起步，不是一上来就把前缀全吞掉', async () => {
  const engine = makeLiveEngine({ archiveEnabled: false, retainRatio: 0.5 }, {
    tokenMeter: {
      measure(session) {
        const nodes = session.surface.nodes.map(seq => ({ seq, tokens: approxTokens(blocksToText(session.deriveEventMessage(session.eventAt(seq))?.content)) }));
        return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) };
      },
    },
  });

  const seen = [];
  const originalCore = engine._compactRegionCore.bind(engine);
  engine._compactRegionCore = async (start, end, agent, signal, options) => {
    seen.push({ start, end });
    return originalCore(start, end, agent, signal, options);
  };

  const events = [
    { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } } },
    // 自动压缩必须落在打开的轮里（`_compactRegionCore` 会拒绝没有 open turn 的自动路径）。
    { type: 'turn/start', data: { turn: 1 } },
  ];
  for (let index = 0; index < 12; index += 1) {
    events.push({
      type: index % 2 === 0 ? 'user/message' : 'assistant/message',
      data: { message: { role: index % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text: `u-${index}-${'x'.repeat(index % 2 === 0 ? 2000 : 100000)}` }] } },
    });
  }
  const { session } = fakeLiveSession(events);
  await engine.compactIfNeeded(
    {
      session,
      options: { provider: 'p', model: 'm', maxTokens: 4096 },
      runMaintenance: async (callback) => callback(new AbortController().signal),
    },
    'context-overflow',
    undefined,
  );

  assert.ok(seen.length >= 1, '溢出路径必须真的压一次');
  const nodes = session.surface.nodes;
  // 第一次选区的终点不能是「倒数第二个节点之后就没内容了」那种极限吞并：
  // 保留区按 retainRatio 至少留一部分，终点必须早于最后一个可压节点。
  const firstEndIdx = nodes.indexOf(seen[0].end);
  assert.ok(
    firstEndIdx < nodes.length - 1,
    `溢出首次选区应保留尾部（end 索引 ${firstEndIdx} / 共 ${nodes.length} 个节点）`,
  );
});

// ─────────────────────────────────────── 第六轮：C07 熔断与失败计数

await atest('C07: 第 3 次失败之后不许再发第 4 次摘要请求', async () => {
  // 用一个大计量把总 token 顶到阈值之上，否则压力入口在阈值判断处就返回了，
  // 根本走不到摘要调用 —— 那样测的其实不是熔断。
  const engine = makeLiveEngine(
    { archiveEnabled: false, reactiveStep: 1, failureThreshold: 3, retainTokens: 1 },
    {
      tokenMeter: {
        measure(session) {
          const nodes = session.surface.nodes.map(seq => ({ seq, tokens: approxTokens(blocksToText(session.deriveEventMessage(session.eventAt(seq))?.content)) }));
          // Force pressure independently; do not pretend a 4 KB message costs 100k tokens.
          return { nodes, totalTokens: 400000 };
        },
      },
    },
  );
  let calls = 0;
  engine.ctx.llm.stream = async function* stream() {
    calls += 1;
    const error = new Error('context length exceeded');
    error.code = 'CONTEXT_WINDOW_EXCEEDED';
    throw error;
  };
  const { session } = fakeLiveSession(liveEvents());
  const agent = {
    session,
    options: { provider: 'p', model: 'm', maxTokens: 4096 },
    runMaintenance: async (callback) => callback(new AbortController().signal),
  };

  // 同一个会话连续跑 3 次自动压缩，每次都失败。
  for (let index = 0; index < 3; index += 1) {
    await engine.compactIfNeeded(agent, 'pressure', undefined).then(() => null, () => null);
  }
  assert.equal(calls, 3, `每次压缩只该发一次摘要请求，实际发了 ${calls} 次`);
  assert.ok(engine._stopped.has(engine._keyOf(session)), '第 3 次失败后必须熔断');

  // 第 4 次自动入口必须直接返回，不再发请求。
  await engine.compactIfNeeded(agent, 'pressure', undefined).then(() => null, () => null);
  assert.equal(calls, 3, '熔断之后不许再发摘要请求');
});

await atest('C07: 熔断之后连渐进重试也必须停下', async () => {
  const engine = makeLiveEngine({ archiveEnabled: false, reactiveStep: 3, failureThreshold: 1 });
  let calls = 0;
  engine.ctx.llm.stream = async function* stream() {
    calls += 1;
    const error = new Error('context length exceeded');
    error.code = 'CONTEXT_WINDOW_EXCEEDED';
    throw error;
  };
  const { session } = fakeLiveSession(liveEvents());
  await engine
    ._compactSpan(1, 3, { session }, undefined, {
      manual: false,
      turn: 1,
      reselect: async () => ({ start: 1, end: 2 }),
    }, 0)
    .then(() => null, () => null);

  // failureThreshold=1 → 第一次失败就熔断，reactiveStep 再大也不许重试。
  assert.equal(calls, 1, `熔断后不该重试，实际发了 ${calls} 次`);
});

await atest('C07: 持久化失败也要计入熔断，不能一直白试', async () => {
  const engine = makeLiveEngine(
    { archiveEnabled: false, failureThreshold: 2 },
    {
      sessions: {
        async flush() {
          throw new Error('disk full');
        },
      },
    },
  );
  // 手动路径只在空闲会话上可用，去掉未闭合的 turn。
  const { session } = fakeLiveSession(liveEvents().filter((event) => event.type !== 'turn/start'));
  const agent = {
    session,
    options: { provider: 'p', model: 'm', maxTokens: 4096 },
    runMaintenance: async (callback) => callback(new AbortController().signal),
  };

  const error = await engine._compactManual(agent, undefined, undefined).then(() => null, (e) => e);
  assert.equal(error?.code, 'commit', `提交前持久化失败应报告尚未完成，实际 ${error?.code}`);
  assert.equal(engine._failures.get(engine._keyOf(session)) ?? 0, 1, '持久化失败必须计入失败次数');
});

// ─────────────────────────────────────── 第六轮：C03 摘要硬截止

await atest('C03: 适配器忽略 signal 时，插件层必须自己硬截止', async () => {
  // 造一个"不合作"的流：收到 signal 也不理，永远不结束。
  // 只靠把 signal 传给适配器是不行的 —— 第三方后端完全可以忽略它，
  // 那样 `for await` 会一直等下去，超时形同虚设。
  const engine = makeLiveEngine({ archiveEnabled: false, summaryTimeoutMs: 5000 }, {
    llm: {
      async resolveModelInfo() {
        return { contextWindow: 200000, maxTokens: 8192 };
      },
      stream() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                // 永远 pending：既不给 chunk 也不 done。
                return new Promise(() => {});
              },
            };
          },
        };
      },
    },
  });
  const { session } = fakeLiveSession(liveEvents().filter((event) => event.type !== 'turn/start'));
  const agent = {
    session,
    options: { provider: 'p', model: 'm', maxTokens: 4096 },
    runMaintenance: async (callback) => callback(new AbortController().signal),
  };

  const startedAt = Date.now();
  const error = await engine._compactManual(agent, undefined, undefined).then(() => null, (e) => e);
  const elapsed = Date.now() - startedAt;

  assert.ok(error, '不合作的流必须被插件层截止，而不是永远等下去');
  // 包装成手动错误后 code 会归到 summary（manual-error 的映射），
  // 但底层原因必须是 SUMMARY_TIMEOUT。
  const cause = error?.cause ?? error;
  const codes = [error?.code, cause?.code, cause?.cause?.code].filter(Boolean);
  assert.ok(
    codes.includes('SUMMARY_TIMEOUT') || /timed out/i.test(error?.message ?? ''),
    `期望 SUMMARY_TIMEOUT，实际 ${JSON.stringify(codes)} / ${error?.message}`,
  );
  assert.ok(elapsed < 20000, `硬截止应该很快返回，实际等了 ${elapsed}ms`);
});

await atest('C03: 超时之后迟到的结果必须被拒收，不能当成功', async () => {
  // 流最终会返回内容，但返回时已经超时了。这种"迟到成功"最危险：
  // 拿到的摘要可能对应一个已经被放弃的请求，凭它替换 surface 等于用
  // 过期数据覆盖现役上下文。
  const engine = makeLiveEngine({ archiveEnabled: false, summaryTimeoutMs: 5000 }, {
    llm: {
      async resolveModelInfo() {
        return { contextWindow: 200000, maxTokens: 8192 };
      },
      stream() {
        return {
          [Symbol.asyncIterator]() {
            let emitted = false;
            return {
              async next() {
                if (emitted) return { done: true, value: undefined };
                emitted = true;
                // 等到超时之后再吐出内容。
                await new Promise((resolve) => setTimeout(resolve, 5500));
                return { done: false, value: { type: 'text-delta', index: 0, text: 'LATE SUMMARY' } };
              },
            };
          },
        };
      },
    },
  });
  const { session } = fakeLiveSession(liveEvents().filter((event) => event.type !== 'turn/start'));
  const agent = {
    session,
    options: { provider: 'p', model: 'm', maxTokens: 4096 },
    runMaintenance: async (callback) => callback(new AbortController().signal),
  };

  const error = await engine._compactManual(agent, undefined, undefined).then(() => null, (e) => e);
  assert.ok(error, '迟到的成功必须被拒收');
});

// ─────────────────────────────── 第六轮：C03 硬截止 / C10 极性 / C01 持久锁

await atest('C01: 会话对象重建之后，首次锁定的窗口不能重新放宽', async () => {
  resetWindowCache();
  const base = { provider: 'p', model: 'm', providerMap: {}, fallback: 200000, clampMin: 65536 };

  // 第一次：适配器还没答上来，只能落到 fallback。
  const first = lockWindow({ ...base, session: { id: 'session-c01' }, adapterWindow: undefined });
  assert.equal(first.source, 'fallback');
  assert.equal(first.window, 200000);

  // 宿主重建了 session 实例（进程重启后恢复、切分支），逻辑 id 不变。
  const rebuilt = lockWindow({ ...base, session: { id: 'session-c01' }, adapterWindow: 32768 });
  assert.equal(rebuilt.safetyWindow, 32768, '更小的可信值必须能收紧');
  assert.equal(rebuilt.firstResolved, 200000, '首次解析值要一直记得');

  // 再换一个对象、并报一个更大的窗口 —— 不许放大回去。
  const bigger = lockWindow({ ...base, session: { id: 'session-c01' }, adapterWindow: 1000000 });
  assert.equal(bigger.safetyWindow, 32768, '更大的值一律忽略，窗口只能单调变小');
  assert.equal(peekLockedWindow({ id: 'session-c01' }, 'p', 'm'), 200000);
});

await atest('C10: 否定被丢掉时必须算约束丢失，不能只看词覆盖', async () => {
  const flipped = auditCompaction({
    userMessages: [{ seq: 1, text: 'Do not delete production data' }],
    summaryText: 'Delete production data',
    threshold: 0.6,
  });
  assert.equal(flipped.lost.length, 1, '否定反转必须报丢失');
  assert.equal(flipped.lost[0].reason, 'polarity');
  assert.equal(flipped.polarityFlips, 1);
  // 覆盖率本身是达标的 —— 正是这一点让它以前被漏掉。
  assert.ok(flipped.lost[0].coverage >= 0.6);

  const kept = auditCompaction({
    userMessages: [{ seq: 1, text: 'Do not delete production data' }],
    summaryText: 'Do not delete production data under any circumstance',
    threshold: 0.6,
  });
  assert.equal(kept.lost.length, 0, '否定还在就不该报丢失');

  // 中文同理。
  const zh = auditCompaction({
    userMessages: [{ seq: 2, text: '不要删除生产数据' }],
    summaryText: '删除生产数据',
    threshold: 0.6,
  });
  assert.equal(zh.lost.length, 1);
  assert.equal(zh.lost[0].reason, 'polarity');
});

// ───────────────────────────────────────── 第六轮：C09 归档完整性与回查

/** 在临时目录里造一个归档，用完就删。 */
async function withTempArchive(fn) {
  const root = await mkdtemp(join(tmpdir(), 'weave-archive-'));
  try {
    return await fn(new CompactionArchive({ root }), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await atest('C09: 完整归档能逐字读回，且校验通过', async () => {
  await withTempArchive(async (archive) => {
    const entries = [
      { seq: 1, type: 'user/message', role: 'user', text: '  keep leading spaces\n\n\ttab and newline  ' },
      { seq: 2, type: 'assistant/message', role: 'assistant', text: 'code:\n    indented line\n' },
    ];
    const file = await archive.writeSpan({ sessionId: 'session-c09', compactionId: 'cmp-1', entries });
    assert.ok(file, '写归档必须成功');
    const result = await archive.readSpan('session-c09', 'cmp-1');
    assert.equal(result.ok, true, `完整归档应校验通过，实际 ${result.reason}`);
    assert.deepEqual(result.entries.map((e) => e.text), entries.map((e) => e.text), '逐字原样回读');
  });
});

await atest('C09: 坏行不能被静默跳过，必须报 damaged', async () => {
  await withTempArchive(async (archive, root) => {
    await archive.writeSpan({
      sessionId: 'session-c09',
      compactionId: 'cmp-2',
      entries: [{ seq: 1, type: 'user/message', role: 'user', text: 'alpha' }],
    });
    const file = join(archive.dirFor('session-c09'), 'cmp-2.jsonl');
    const raw = await readFile(file, 'utf8');
    await writeFile(file, `${raw}{ this is not json\n`, 'utf8');

    const result = await archive.readSpan('session-c09', 'cmp-2');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'damaged');
    assert.deepEqual(result.damaged, [3], '坏行行号要报出来');
  });
});

await atest('C09: 被截断的归档要报 truncated 并给出应有条数', async () => {
  await withTempArchive(async (archive, root) => {
    await archive.writeSpan({
      sessionId: 'session-c09',
      compactionId: 'cmp-3',
      entries: [
        { seq: 1, type: 'user/message', role: 'user', text: 'one' },
        { seq: 2, type: 'user/message', role: 'user', text: 'two' },
        { seq: 3, type: 'user/message', role: 'user', text: 'three' },
      ],
    });
    const file = join(archive.dirFor('session-c09'), 'cmp-3.jsonl');
    const lines = (await readFile(file, 'utf8')).split('\n');
    // 只留头部 + 第一条，模拟写入过程中断电。
    await writeFile(file, `${lines[0]}\n${lines[1]}\n`, 'utf8');

    const result = await archive.readSpan('session-c09', 'cmp-3');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'truncated');
    assert.equal(result.expected, 3);
    assert.equal(result.actual, 1);
  });
});

await atest('C09: 内容被改过要报 checksum，而不是当成正常', async () => {
  await withTempArchive(async (archive, root) => {
    await archive.writeSpan({
      sessionId: 'session-c09',
      compactionId: 'cmp-4',
      entries: [{ seq: 1, type: 'user/message', role: 'user', text: 'original' }],
    });
    const file = join(archive.dirFor('session-c09'), 'cmp-4.jsonl');
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines[1] = JSON.stringify({ seq: 1, type: 'user/message', role: 'user', text: 'tampered' });
    await writeFile(file, `${lines.join('\n')}`, 'utf8');

    const result = await archive.readSpan('session-c09', 'cmp-4');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'checksum');
  });
});

await atest('C09: 文件不存在要报 missing，不能抛出去', async () => {
  await withTempArchive(async (archive) => {
    const result = await archive.readSpan('session-c09', 'nope');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing');
    assert.deepEqual(result.entries, []);
  });
});

await atest('C09: history_read 遇到不完整归档必须在正文前面写出警告', async () => {
  await withTempArchive(async (archive, root) => {
    await archive.writeSpan({
      sessionId: 'session-c09',
      compactionId: 'cmp-5',
      entries: [{ seq: 1, type: 'user/message', role: 'user', text: 'alpha' }],
    });
    const file = join(archive.dirFor('session-c09'), 'cmp-5.jsonl');
    const raw = await readFile(file, 'utf8');
    await writeFile(file, `${raw}garbage line\n`, 'utf8');

    const out = await runTool('history_read', archive, { compactionId: 'cmp-5' }, { session: { id: 'session-c09' } });
    assert.match(out, /INCOMPLETE/);
    assert.match(out, /not valid JSON/);
    // 警告必须在正文之前，否则读完正文才看到警告已经晚了。
    assert.ok(out.indexOf('INCOMPLETE') < out.indexOf('--- seq'), '警告要排在正文前面');
  });
});

await atest('C09: history_search 命中不完整归档时要标记出来', async () => {
  await withTempArchive(async (archive, root) => {
    await archive.writeSpan({
      sessionId: 'session-c09',
      compactionId: 'cmp-6',
      entries: [{ seq: 1, type: 'user/message', role: 'user', text: 'find me here' }],
    });
    const file = join(archive.dirFor('session-c09'), 'cmp-6.jsonl');
    const raw = await readFile(file, 'utf8');
    await writeFile(file, `${raw}broken\n`, 'utf8');

    const out = await runTool('history_search', archive, { query: 'find me' }, { session: { id: 'session-c09' } });
    assert.match(out, /incomplete archive/);
  });
});

await atest('C09: 头部字段被改过必须报出来，不能只看 entries 和 checksum', async () => {
  await withTempArchive(async (archive, root) => {
    const write = async (compactionId) => {
      await archive.writeSpan({
        sessionId: 'session-c09',
        compactionId,
        entries: [{ seq: 1, type: 'user/message', role: 'user', text: 'original' }],
      });
      return join(archive.dirFor('session-c09'), `${compactionId}.jsonl`);
    };
    const tamper = async (file, mutate) => {
      const lines = (await readFile(file, 'utf8')).split('\n');
      const header = JSON.parse(lines[0]);
      mutate(header);
      lines[0] = JSON.stringify(header);
      await writeFile(file, lines.join('\n'), 'utf8');
    };

    // 版本不对：字段含义可能已经变了，不能按当前规则解读。
    const v = await write('cmp-v');
    await tamper(v, (header) => {
      header.version = 999;
    });
    const versioned = await archive.readSpan('session-c09', 'cmp-v');
    assert.equal(versioned.ok, false);
    assert.equal(versioned.reason, 'version');

    // 字节数对不上：正文被改写过，即使 checksum 也一起改了。
    const b = await write('cmp-b');
    await tamper(b, (header) => {
      header.bytes = 0;
    });
    const bytes = await archive.readSpan('session-c09', 'cmp-b');
    assert.equal(bytes.ok, false);
    assert.equal(bytes.reason, 'bytes');

    // 身份对不上：文件被搬过或改过名。
    const i = await write('cmp-i');
    await tamper(i, (header) => {
      header.compactionId = 'somebody-else';
    });
    const identity = await archive.readSpan('session-c09', 'cmp-i');
    assert.equal(identity.ok, false);
    assert.equal(identity.reason, 'identity');
  });
});

await atest('C09: 非文本块与工具调用要能追溯，不能只剩 [image] 占位', async () => {
  await withTempArchive(async (archive) => {
    archive.attachments = attachmentFixture;
    const entries = spanEntries({
      id: 'session-c09',
      eventAt(seq) {
        if (seq === 1) {
          return {
            seq: 1,
            type: 'user/message',
            data: {
              source: { kind: 'user' },
              message: {
                role: 'user',
                content: [
                  { type: 'text', text: 'look at this' },
                  { type: 'image', mimeType: 'image/png', url: 'https://example.test/a.png', attachment:{attachmentId:imageId,bytes:imageBytes.length} },
                ],
              },
            },
          };
        }
        if (seq === 2) {
          return {
            seq: 2,
            type: 'assistant/message',
            data: {
              message: {
                role: 'assistant',
                content: [
                  { type: 'tool-call', name: 'read_file', callId: 'call-1', arguments: { path: 'a.txt' } },
                ],
              },
            },
          };
        }
        return undefined;
      },
      deriveEventMessage(event) {
        return event?.data?.message;
      },
    }, [1, 2]);

    await archive.writeSpan({ sessionId: 'session-c09', compactionId: 'cmp-rich', entries });
    const read = await archive.readSpan('session-c09', 'cmp-rich');
    assert.equal(read.ok, true);
    const [first, second] = read.entries;

    assert.ok(Array.isArray(first.blocks), '原始块结构必须落盘');
    assert.equal(first.blocks[1].type, 'image');
    assert.equal(first.blocks[1].url, 'https://example.test/a.png');
    assert.deepEqual(first.source, { kind: 'user' }, '来源必须留着');

    assert.equal(second.tool[0].kind, 'call');
    assert.equal(second.tool[0].name, 'read_file');
    assert.equal(second.tool[0].callId, 'call-1');

    // 工具输出里也要能看到这些，而不是只剩 [image] 占位符。
    const out = await runTool('history_read', archive, { compactionId: 'cmp-rich' }, { session: { id: 'session-c09' } });
    assert.match(out, /tool-call read_file id=call-1/);
    assert.match(out, /non-text block: image \(mimeType=image\/png/);
  });
});

// ───────────────────────────────────────────── 第六轮：C08 计量口径

await atest('C08: 缺价的节点用字符估算兜底，不能当成 0 token', async () => {
  const engine = makeLiveEngine({ archiveEnabled: false });
  const { session } = fakeLiveSession(liveEvents());
  // 只给第 1 条计价，其余节点没有 tokens —— 这正是"部分计价"的真实形态。
  engine._lastPriced.set(session, new Map([[1, 500]]));

  const tokens = engine._shadowedTokens(session, [1, 2, 3]);
  assert.ok(tokens > 500, `缺价节点必须按估算计入，实际 ${tokens}`);
  assert.ok(tokens >= 500 + 1000, '两条 4000 字符的消息按 4 字符/token 至少各 1000');
});

await atest('C08: 计量口径要随测量结果一起交出来', async () => {
  const priced = makeLiveEngine(
    { archiveEnabled: false },
    {
      tokenMeter: {
        measure(session) {
          const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: 100 }));
          return { nodes, totalTokens: nodes.length * 100 };
        },
      },
    },
  );
  const { session } = fakeLiveSession(liveEvents());
  const full = await priced._measure(session);
  assert.equal(full.precision, 'priced');

  const heuristic = makeLiveEngine(
    { archiveEnabled: false },
    {
      tokenMeter: {
        measure(session) {
          const nodes = session.surface.nodes.map((seq) => ({ seq, heuristicTokens: 100 }));
          return { nodes, totalTokens: nodes.length * 100 };
        },
      },
    },
  );
  const rough = await heuristic._measure(session);
  assert.equal(rough.precision, 'heuristic');

  const mixed = makeLiveEngine(
    { archiveEnabled: false },
    {
      tokenMeter: {
        measure(session) {
          const nodes = session.surface.nodes.map((seq, index) =>
            index === 0 ? { seq, tokens: 100 } : { seq, heuristicTokens: 100 },
          );
          return { nodes, totalTokens: nodes.length * 100 };
        },
      },
    },
  );
  const blend = await mixed._measure(session);
  assert.equal(blend.precision, 'mixed');
});

await atest('C08: 压缩结果必须带上被压区间的计量口径，不能只给数字', async () => {
  const engine = makeLiveEngine(
    { archiveEnabled: false },
    {
      tokenMeter: {
        measure(session) {
          // 全部只有粗估 —— 这是宿主的默认状态（没接 tokenizer/usage 时）。
          // 每条 1000：九节摘要本身约 200 tokens，给太小会先撞上"摘要必须更小"。
          const nodes = session.surface.nodes.map((seq) => ({ seq, heuristicTokens: approxTokens(blocksToText(session.deriveEventMessage(session.eventAt(seq))?.content)) }));
          return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.heuristicTokens, 0) };
        },
      },
    },
  );
  const events = liveEvents().filter((event) => event.type !== 'turn/start');
  const { session } = fakeLiveSession(events);
  const agent = {
    session,
    options: { provider: 'p', model: 'm', maxTokens: 4096 },
    runMaintenance: async (callback) => callback(new AbortController().signal),
  };
  const result = await engine.compactNow(agent, new AbortController().signal, undefined);
  assert.ok(result, '压缩应当成功');
  assert.equal(result.shadowedTokenPrecision, 'heuristic', '粗估计量必须如实标成 heuristic，不能默认 priced');
  assert.ok(result.shadowedTokenCount > 0, '数字本身也要有');
});

// ─────────────────────────────────────────────── 第七轮：V7-01…V7-09 回归

await atest('V7-01: 流初始化同步抛错时不许泄漏未处理的超时拒绝', async () => {
  // 宿主 `llm.stream` 走 waterfall，中间监听器允许同步 throw。
  // 早先迭代器在 try 之外创建，这一抛就跳过 finally，计时器与 abort 监听器
  // 都不清理，几秒后那次超时以 unhandledRejection 炸出来（进程退出码 1）。
  const engine = makeLiveEngine(
    { archiveEnabled: false },
    {
      llm: {
        stream() {
          throw new Error('middleware exploded synchronously');
        },
      },
    },
  );
  const { session } = fakeLiveSession(liveEvents());
  const error = await engine
    ._compactSpan(1, 3, { session }, undefined, { manual: true, turn: null }, 0)
    .then(() => null, (e) => e);
  assert.ok(error, '同步抛错必须变成一次正常的压缩失败');
  assert.match(String(error.message), /middleware exploded/);
  assert.equal(session.surface.replaceGeneration, 0, 'surface 不许动');
});

await atest('V7-02: 多文本块拼成的九节摘要不能被误判缺节', async () => {
  // 模型把九节拆成 9 个独立 text 块返回时，`rawText` 与 `summaryText` 必须
  // 是同一套文本表示，否则"摘要正文看着合格、校验用的是另一份"。
  const engine = makeLiveEngine(
    { archiveEnabled: false },
    {
      llm: {
        stream: async function* stream(options) {
          const text = summaryForMessages(options.messages);
          const blocks = text.split('\n');
          for (let index = 0; index < blocks.length; index += 1) {
            yield { type: 'block-start', index, blockType: 'text' };
            yield { type: 'text-delta', index, text: blocks[index] };
            yield { type: 'block-end', index, block: { type: 'text', text: blocks[index] } };
          }
          yield { type: 'finish', kind: 'stop' };
        },
      },
    },
  );
  const { session } = fakeLiveSession(liveEvents());
  const result = await engine
    ._compactSpan(1, 3, { session }, undefined, { manual: true, turn: null }, 0)
    .then((value) => value, (e) => e);
  assert.ok(!result?.code, `多文本块必须被接受，实际失败：${result?.code} ${result?.message ?? ''}`);
  assert.equal(session.surface.replaceGeneration, 1);
});

await atest('V7-03: 九节倒序 / 重复 / 第六节空壳都必须被拒', async () => {
  const titles = [
    'Primary Request and Intent',
    'Key Technical Concepts',
    'Files and Code Sections',
    'Errors and Fixes',
    'Problem Solving',
    'All User Messages',
    'Pending Tasks',
    'Work Completed',
    'Context for Continuing Work',
  ];
  const reversed = titles
    .map((title, index) => {
      const number = titles.length - index;
      return `## ${number}. ${titles[number - 1]}\n(none)`;
    })
    .join('\n');
  const outOfOrder = validateSummaryStructure(reversed, { language: 'en' });
  assert.equal(outOfOrder.ok, false, '倒序必须被拒');
  assert.match(outOfOrder.message, /out of order/);

  const duplicated = `${VALID_SUMMARY}\n## 1. Primary Request and Intent\nagain`;
  const dup = validateSummaryStructure(duplicated, { language: 'en' });
  assert.equal(dup.ok, false, '重复小节必须被拒');
  assert.match(dup.message, /repeats section/);

  const emptyUserSection = VALID_SUMMARY.replace(
    '## 6. All User Messages\nSee <preserved-user-messages> for the verbatim list.',
    '## 6. All User Messages\n(none)',
  );
  const empty = validateSummaryStructure(emptyUserSection, { language: 'en' });
  assert.equal(empty.ok, false, '第六节只写 (none) 必须被拒');
  assert.match(empty.message, /is empty/);
});

await atest('V7-04: 旧 checkpoint 里的结束标记被用户原文命中时必须拒绝压缩', async () => {
  // v6 检查点没有 `source.preserved`，只能靠解析渲染文本恢复原话。
  // 用户消息里恰好有一行 `</preserved-user-messages>` 时，"最后一个结束标记"
  // 之前的整段看着完全合法 —— 但中间那段用户原话会被当成容器外的内容丢掉。
  const legacy = [
    CHECKPOINT_PREAMBLE,
    '## 1. Primary Request and Intent',
    'keep going',
    '<preserved-user-messages>',
    '--- seq 2 ---',
    'Keep original start',
    '</preserved-user-messages>',
    'DO NOT DELETE THE BACKUP',
    '</preserved-user-messages>',
  ].join('\n');
  const inspected = inspectCheckpointPreserved({ data: { content: [{ type: 'text', text: legacy }] } });
  assert.equal(inspected.ok, false, '无法无歧义恢复时必须拒绝，而不是猜一个');
  assert.match(String(inspected.reason), /container marker|after the preserved section/);
});

await atest('V7-06: 无关否定词不能掩盖约束反转', async () => {
  // 原文要求"不要删生产数据"，摘要写成"删生产数据。不要重启服务。" ——
  // 整份摘要里确实有一个 `do not`，但那句跟删除无关。
  const flipped = auditCompaction({
    userMessages: [{ seq: 1, text: 'Do not delete production data' }],
    summaryText: 'Delete production data. Do not restart services.',
    checkpointText: 'Delete production data. Do not restart services.',
  });
  assert.equal(flipped.polarityFlips, 1, '否定必须绑定到原动作，不能全文随便找一个否定词就算数');
  assert.equal(flipped.lost[0].reason, 'polarity');

  const negated = auditCompaction({
    userMessages: [{ seq: 2, text: 'Always preserve the archive' }],
    summaryText: 'Never preserve the archive.',
    checkpointText: 'Never preserve the archive.',
  });
  assert.equal(negated.polarityFlips, 1, '正向要求被写成负向也算反转');

  const labeled = extractConstraintLines('Output format: JSON\nRun the tests');
  assert.ok(
    labeled.some((line) => /Output format: JSON/.test(line)),
    '`标签: 值` 形态的约束必须被抽出来，不能因为不含命令词就漏掉',
  );
});

await atest('V7-07: 归档读不完整时不许声称"历史里没有"', async () => {
  await withTempArchive(async (archive, root) => {
    await archive.writeSpan({
      sessionId: 'session-v707',
      compactionId: 'cmp-v707',
      entries: [
        { seq: 1, type: 'user/message', role: 'user', text: 'alpha' },
        { seq: 2, type: 'user/message', role: 'user', text: 'UNIQUE_BACKUP_REQUIREMENT' },
      ],
    });
    // 把含关键词的那一行截断：readSpan 会报 truncated。
    const file = join(archive.dirFor('session-v707'), 'cmp-v707.jsonl');
    const lines = (await readFile(file, 'utf8')).split('\n');
    await writeFile(file, `${lines.slice(0, 2).join('\n')}\n`, 'utf8');

    const result = await archive.search('session-v707', 'UNIQUE_BACKUP_REQUIREMENT');
    assert.equal(result.hits.length, 0);
    assert.equal(result.unreadable.length, 1, '读不完整的段必须被记下来');
    assert.equal(result.unreadable[0].reason, 'truncated');

    const text = await runTool(
      'history_search',
      archive,
      { query: 'UNIQUE_BACKUP_REQUIREMENT' },
      { sessionId: 'session-v707' },
    );
    assert.match(text, /No readable archived span/, '不能说成"没有任何归档包含"');
    assert.match(text, /could not be read completely/);
  });
});

await atest('V7-08: 图片输出必须在被丢弃之前就拦住', async () => {
  // 宿主 `summaryText` 遇图片抛 UNSUPPORTED_CONTENT。如果我们在组装阶段
  // 就把图片块过滤掉，后面那道拒绝逻辑永远看不到它 —— 摘要"成功"了，
  // 但模型确实产出了非法内容。
  const engine = makeLiveEngine(
    { archiveEnabled: false },
    {
      llm: {
        stream: async function* stream() {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: VALID_SUMMARY };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: VALID_SUMMARY } };
          yield { type: 'block-end', index: 1, block: { type: 'image', source: { type: 'base64', data: 'AAAA' } } };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    },
  );
  const { session } = fakeLiveSession(liveEvents());
  const error = await engine
    ._compactSpan(1, 3, { session }, undefined, { manual: true, turn: null }, 0)
    .then(() => null, (e) => e);
  assert.ok(error, '带图片输出的摘要必须失败');
  // 三级目标链会把逐目标失败聚合成 SUMMARY_ALL_FAILED，但原因必须带得出来：
  // 关键不是错误码长什么样，而是**它没有被当成成功**。
  assert.ok(
    error.code === 'UNSUPPORTED_CONTENT' ||
      (Array.isArray(error.failureCodes) && error.failureCodes.includes('UNSUPPORTED_CONTENT')),
    `失败原因里必须出现 UNSUPPORTED_CONTENT，实际 ${error.code} / ${JSON.stringify(error.failureCodes ?? [])}`,
  );
  assert.equal(session.surface.replaceGeneration, 0, 'surface 不许动');
});

await atest('V7-09: 宿主粗估节点不能被标成 priced', async () => {
  // 宿主 `priceSurface` 总会返回 `tokens`；无图片/文件定价时它等于
  // `heuristicTokens`。所以"有没有 tokens 字段"零信息量。
  const engine = makeLiveEngine(
    { archiveEnabled: false },
    {
      tokenMeter: {
        measure(session) {
          const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: 33, heuristicTokens: 33 }));
          return { nodes, totalTokens: nodes.length * 33 };
        },
      },
    },
  );
  const { session } = fakeLiveSession(liveEvents());
  const measured = await engine._measure(session);
  assert.equal(measured.precision, 'heuristic', 'tokens 与 heuristicTokens 相等 = 只是粗估');

  const routed = makeLiveEngine(
    { archiveEnabled: false },
    {
      tokenMeter: {
        measure(session) {
          const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: 128, heuristicTokens: 33 }));
          return { nodes, totalTokens: nodes.length * 128 };
        },
      },
    },
  );
  const priced = await routed._measure(session);
  assert.equal(priced.precision, 'priced', '与粗估不等说明路由定价插过手');
});

await atest('C04: 第六节必须逐条交代来源区间里的用户消息', async () => {
  const expected = [
    { seq: 2, blocks: [{ type: 'text', text: 'first requirement' }] },
    { seq: 4, blocks: [{ type: 'text', text: 'second requirement' }] },
  ];

  const vague = validateUserMessageSection('用户希望继续推进压缩工作。', expected);
  assert.equal(vague.ok, false, '空泛描述不算交代');
  assert.match(vague.message, /must reproduce every user message verbatim/);

  const verbatim = validateUserMessageSection('- first requirement\n- second requirement', expected);
  assert.equal(verbatim.ok, true, '逐字列出必须通过');

  const cited = validateUserMessageSection('- seq 2: 已保留\n- #4 已保留', expected);
  assert.equal(cited.ok, false, '仅 seq 引用不满足逐字原话承诺');

  const container = validateUserMessageSection('See <preserved-user-messages> for the verbatim list.', expected);
  // 以前这里允许「整节指个容器」—— 但那样模型只要写一句话就绕过整条要求，
  // 漏掉的条目由覆盖校验兜底。问题是覆盖校验核对的是**拼好的检查点**，
  // 而容器里的原话本来就是逐字复制的，它永远满足自己。等于自己给自己盖章。
  // 第六节必须逐条交代，指向容器不算交代。
  assert.equal(container.ok, false, '整节指向保留容器不算交代：要有逐条清单或 seq 引用');
  assert.match(container.message, /must reproduce every user message verbatim/);
});

// ───────────────────────────────────── 第七轮：C10 约束丢失必须能拦住提交

await atest('C10/V7-06: 审计报出约束丢失时必须拦下提交，而不是记条日志', async () => {
  // 这里直接对**拦截决策**做测试：把 auditor 换成"报告有丢失"，然后确认引擎
  // 抛 CONSTRAINT_LOST、surface 一个字节都不动。
  //
  // 为什么不走真实审计：修好 V8-05 之后，"用户原话从检查点里消失"这个前提
  // 已经不可能通过配置造出来了 —— 想少留就会先被 PRESERVE_LIMIT_DROPS_ORIGINALS
  // 拦住。所以端到端造不出"约束丢失"，只能把 auditor 打桩，专测拦截这一段。
  const engine = makeLiveEngine({ archiveEnabled: false, auditEnabled: true });
  assert.equal(engine.config.auditBlockOnLoss, true, '默认必须拦');
  engine._audit = () => ({
    checked: 1,
    lost: [{ seq: 1, line: 'Never drop the audit trail', coverage: 0.2, reason: 'coverage' }],
    worstCoverage: 0.2,
    polarityFlips: 0,
  });

  const { session, surface } = fakeLiveSession(liveEvents());
  const error = await engine
    ._compactSpan(1, 3, { session }, undefined, { manual: true, turn: null }, 0)
    .then(() => null, (e) => e);
  assert.ok(error, '审计报出丢失时必须让压缩失败');
  assert.equal(error.code, 'CONSTRAINT_LOST', `期望 CONSTRAINT_LOST，实际 ${error.code}`);
  assert.equal(surface.replaceGeneration, 0, '拦下之后 surface 一个字节都不许动');
});

await atest('C10/V7-06: 原话逐字留在检查点里时，摘要没提也不算丢失', async () => {
  // 反向确认：默认配置会保留区间内全部用户原话，约束行虽然没进摘要正文，
  // 但逐字躺在 <preserved-user-messages> 里 —— 用户意图没丢，不该拦。
  const engine = makeLiveEngine(
    { archiveEnabled: false, auditEnabled: true },
    { llm: { stream: scriptedStream(null, summaryForMessages) } },
  );
  const events = liveEvents().filter((event) => event.type !== 'turn/start');
  events[1] = {
    type: 'user/message',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Never drop the audit trail; you must not delete production data' }],
      },
    },
  };
  const { session, surface } = fakeLiveSession(events);
  const agent = {
    session,
    options: { provider: 'p', model: 'm', maxTokens: 4096 },
    runMaintenance: async (callback) => callback(new AbortController().signal),
  };

  const result = await engine.compactNow(agent, new AbortController().signal, undefined);
  assert.ok(result && result.compactionId, `原话还在就不该拦，实际 ${result?.message ?? result}`);
  assert.equal(surface.replaceGeneration, 1, '应当正常替换');

  // 关键证据：约束原话必须真的逐字在检查点里。
  // 注意 `user/message` 的事件数据**就是消息本身**，不是 `{ message }` 包装。
  const checkpoint = session.surface.nodes
    .map((seq) => session.eventAt(seq))
    .filter((event) => event?.data?.source?.kind === 'compact-checkpoint')
    .pop();
  const text = checkpoint.data.content.map((block) => block.text ?? '').join('\n');
  assert.ok(
    text.includes('never delete production data') || text.includes('must not delete production data'),
    '约束原话必须逐字留在检查点里',
  );
});

await atest('C10: 显式关掉 auditBlockOnLoss 时才允许带着覆盖不足继续', async () => {
  const engine = makeLiveEngine({ archiveEnabled: false, auditEnabled: true, auditBlockOnLoss: false });
  assert.equal(engine.config.auditBlockOnLoss, false, '配置必须真的传进来');
  // 默认值必须是拦（true）—— 这是"代价不对称"的取舍。
  const strict = makeLiveEngine({ archiveEnabled: false });
  assert.equal(strict.config.auditBlockOnLoss, true, '默认必须拦下约束丢失');
});

await atest('V8-04: 反义摘要必须先拒绝，重建后只提交原文约束', async () => {
  // 默认配置：原话逐字保留在检查点末尾的 <preserved-user-messages> 里。
  // 摘要正文却写成了相反的意思。审计如果拿"完整检查点"去找覆盖句，
  // 原话段必然满足（它本来就是逐字的），于是判成"极性保持"。
  //
  // 摘要必须既能过第六节（按 seq 清单逐条交代），又把第 5 节写成反义句 ——
  // 所以基于 `summaryForMessages` 再注入那句反义文本。
  const flip = (messages) =>
    summaryForMessages(messages).replace('## 5. Problem Solving', 'Delete production data.\n\n## 5. Problem Solving');
  const engine = makeLiveEngine(
    { archiveEnabled: false, auditEnabled: true },
    { llm: { stream: scriptedStream(null, flip) } },
  );
  const events = liveEvents().filter((event) => event.type !== 'turn/start');
  events[1] = {
    type: 'user/message',
    data: { message: { role: 'user', content: [{ type: 'text', text: 'Do not delete production data' }] } },
  };
  const { session, surface, log } = fakeLiveSession(events);
  const agent = {
    session,
    options: { provider: 'p', model: 'm', maxTokens: 4096 },
    runMaintenance: async (callback) => callback(new AbortController().signal),
  };

  await engine.compactNow(agent, new AbortController().signal, undefined);
  const saved = log.find(e=>e.type==='compaction/summary').data;
  assert.ok(saved.rawOutput.map(b=>b.text??'').join('\n').includes('Delete production data.'));
  assert.ok(saved.reconstruction.length > 0);
  const text = saved.summary.map(b=>b.text??'').join('\n');
  assert.equal(auditCompaction({userMessages:[{seq:1,text:'Do not delete production data'}],summaryText:text,checkpointText:text}).lost.length,0);
  assert.ok(text.includes('> Do not delete production data'));
  assert.equal(surface.replaceGeneration,1);
});

await atest('V8-04: 原话与摘要一致时不能被误报成反转', async () => {
  // 反向确认：摘要老老实实写着否定句，就必须放行 —— 否则上一条的修法
  // 只是把"漏报"换成了"永远报"。
  const agree = (messages) =>
    summaryForMessages(messages).replace(
      '## 5. Problem Solving',
      'Do not delete production data.\n\n## 5. Problem Solving',
    );
  const engine = makeLiveEngine(
    { archiveEnabled: false, auditEnabled: true },
    { llm: { stream: scriptedStream(null, agree) } },
  );
  const events = liveEvents().filter((event) => event.type !== 'turn/start');
  events[1] = {
    type: 'user/message',
    data: { message: { role: 'user', content: [{ type: 'text', text: 'Do not delete production data' }] } },
  };
  const { session, surface } = fakeLiveSession(events);
  const agent = {
    session,
    options: { provider: 'p', model: 'm', maxTokens: 4096 },
    runMaintenance: async (callback) => callback(new AbortController().signal),
  };

  const result = await engine.compactNow(agent, new AbortController().signal, undefined);
  assert.ok(result && result.compactionId, `极性一致时必须放行，实际 ${result?.message ?? result}`);
  assert.equal(surface.replaceGeneration, 1, '放行时应当正常替换');
});

await atest('V8-13: 归档文件被删掉之后，搜索不许断言"历史里没有"', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-archive-'));
  try {
    const archive = new CompactionArchive({ root });
    const sessionId = 'session-deleted';
    const file = await archive.writeSpan({
      sessionId,
      compactionId: 'compaction-1',
      entries: [{ seq: 1, type: 'user/message', role: 'user', text: 'UNIQUE_DELETED_REQUIREMENT keep this' }],
    });
    assert.ok(file, '归档必须写成功');

    // 直接删掉段文件，只留 index.jsonl 记录。
    await rm(file);

    // 单段读取必须报 missing。
    const read = await archive.readSpan(sessionId, 'compaction-1');
    assert.equal(read.ok, false);
    assert.equal(read.reason, 'missing');

    // 搜索必须知道"有一段本该在、但读不到"，不能说成"历史里没有"。
    const result = await archive.search(sessionId, 'UNIQUE_DELETED_REQUIREMENT');
    assert.equal(result.hits.length, 0);
    assert.equal(result.unreadable.length, 1, `必须报出读不到的段，实际 ${JSON.stringify(result.unreadable)}`);
    assert.equal(result.unreadable[0].reason, 'missing');

    const output = await runTool('history_search', archive, { query: 'UNIQUE_DELETED_REQUIREMENT' }, { sessionId });
    assert.match(String(output), /No readable archived span/, '不能给出确定否定');
    assert.match(String(output), /could not be read completely/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await atest('V8-08: 缺 checksum 的归档不能被当成完整', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-archive-'));
  try {
    const archive = new CompactionArchive({ root });
    const sessionId = 'session-nochecksum';
    const file = await archive.writeSpan({
      sessionId,
      compactionId: 'compaction-1',
      entries: [{ seq: 1, type: 'user/message', role: 'user', text: 'original' }],
    });
    const raw = await readFile(file, 'utf8');
    const lines = raw.split('\n');
    const header = JSON.parse(lines[0]);
    delete header.checksum;
    lines[0] = JSON.stringify(header);
    await writeFile(file, lines.join('\n'), 'utf8');

    const read = await archive.readSpan(sessionId, 'compaction-1');
    assert.equal(read.ok, false, '没有校验和就不能声称完整');
    assert.equal(read.reason, 'checksum');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await atest('V8-12: 已经熔断的会话，外部恢复入口也不许再发摘要请求', async () => {
  const sink = [];
  const engine = makeLiveEngine(
    { archiveEnabled: false, reactiveStep: 3, failureThreshold: 3 },
    { llm: { stream: scriptedStream(sink) } },
  );
  const events = liveEvents();
  const { session } = fakeLiveSession(events);
  const agent = { session, options: { provider: 'p', model: 'm', maxTokens: 4096 } };

  // 先把这个逻辑会话打成熔断状态。
  engine._stopped.set(engine._keyOf(session), true);

  const retried = await engine._reactiveRetry(agent, undefined);
  assert.equal(retried, false, '熔断之后不许再重试');
  assert.equal(sink.length, 0, `一次摘要请求都不该发，实际发了 ${sink.length} 次`);
});

await atest('V8-11: 元数据连续三次变小，每一次都必须被接受', async () => {
  resetWindowCache();
  const session = { id: 'session-window-shrink' };
  const base = { session, provider: 'p', model: 'm', providerMap: {}, fallback: 200000, clampMin: 65536 };

  const first = lockWindow({ ...base, adapterWindow: 200000 });
  assert.equal(first.window, 200000);

  const second = lockWindow({ ...base, adapterWindow: 150000 });
  assert.equal(second.safetyWindow, 150000, '第二次变小必须接受');

  // 关键一步：旧实现"收紧一次就冻结"，这里会停在 150000，
  // 而真实窗口只有 32768 —— 阈值 112904 落在窗口外面，压缩永不触发。
  const third = lockWindow({ ...base, adapterWindow: 32768 });
  assert.equal(third.safetyWindow, 32768, '第三次变小同样必须接受，否则阈值会大于真实窗口');
  assert.equal(third.firstResolved, 200000, 'firstResolved 记录的是首次解析值，不随修正改变');

  // 变大仍然必须忽略。
  const fourth = lockWindow({ ...base, adapterWindow: 1000000 });
  assert.equal(fourth.safetyWindow, 32768, '更大的值一律忽略，窗口只降不升');
});

await atest('V8-11: 兜底值被任何可信值替换，不区分方向', async () => {
  resetWindowCache();
  const session = { id: 'session-window-fallback-up' };
  const base = { session, provider: 'p', model: 'm', providerMap: {}, fallback: 200000, clampMin: 65536 };

  // 第一次没有可信值，落到 fallback。
  const guessed = lockWindow({ ...base, adapterWindow: undefined });
  assert.equal(guessed.source, 'fallback');

  // 后来适配器报出一个**更大**的值。旧实现只允许"往下换"，
  // 于是 1000000 进不来，阈值一直按 200000 算 —— 对真实 1M 窗口的模型
  // 来说，压缩会早得离谱，每轮都在烧摘要调用。
  const corrected = lockWindow({ ...base, adapterWindow: 1000000 });
  assert.equal(corrected.window, 200000, '首次会话窗口不可变化');
  assert.equal(corrected.safetyWindow, 200000, '安全预算不随更大元数据放宽');
  assert.equal(corrected.source, 'locked');
});

await atest('V8-03: 崩溃留下的孤儿压缩锁，下次启动必须能关上', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-journal-'));
  try {
    const journal = new CompactionJournal({ root });
    const sessionId = 'session-crashed';
    // 模拟上次崩在"替换之后、end 之前"：日志留着，会话上留一把没关的锁。
    await journal.record({
      sessionId,
      compactionId: 'compaction-crashed',
      phase: 'committing',
      startSeq: 1,
      endSeq: 3,
    });

    const events = liveEvents().filter((event) => event.type !== 'turn/start');
    events.push({
      type: 'compaction/start',
      data: { compactionId: 'compaction-crashed', turn: null },
    });
    const { session, log } = fakeLiveSession(events, { id: sessionId });
    const engine = makeLiveEngine({ archiveEnabled: false });
    engine.journal = journal;

    const before = inspectCompactionEntryState(session);
    assert.notEqual(before.unmatchedCompactionStart, null, '夹具本身要留着一把未闭合的锁');

    const result = await engine.recoverPending(session);
    assert.equal(result.recovered, 1, '必须补写一条 end');
    assert.equal(
      log.filter((event) => event.type === 'compaction/end').length,
      1,
      'end 必须落盘',
    );
    assert.equal(
      inspectCompactionEntryState(session).unmatchedCompactionStart,
      null,
      '收尾之后不能再有未闭合的锁',
    );
    assert.equal((await journal.pending(sessionId)).length, 0, '日志必须清掉');

    // 幂等：再跑一次什么都不做。
    const again = await engine.recoverPending(session);
    assert.equal(again.recovered, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await atest('V8-03: 事务正常走完时不留日志', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-journal-'));
  try {
    const journal = new CompactionJournal({ root });
    const sessionId = 'session-clean';
    const engine = makeLiveEngine({ archiveEnabled: false });
    engine.journal = journal;

    const events = liveEvents().filter((event) => event.type !== 'turn/start');
    const { session } = fakeLiveSession(events, { id: sessionId });
    const agent = {
      session,
      options: { provider: 'p', model: 'm', maxTokens: 4096 },
      runMaintenance: async (callback) => callback(new AbortController().signal),
    };
    const result = await engine.compactNow(agent, new AbortController().signal, undefined);
    assert.ok(result && result.compactionId, '压缩应成功');
    assert.equal((await journal.pending(sessionId)).length, 0, '成功路径不该留下日志');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────── 第八轮：V8-07 旧格式分隔符 / V8-09 回查

await atest('V8-07: 旧 checkpoint 里 --- seq N --- 形态的分隔行必须拒绝，不能再猜', async () => {
  // 审计报告的原场景：用户在 v6 时代写过
  //   first line
  //   --- seq 99 ---
  //   DO NOT DELETE BACKUP。
  // 旧实现把这个分隔行当结构吞掉，恢复成两条 seq=-1 的消息，原话里的那行消失，
  // 而且 inspect 还返回 ok —— 丢了一行用户原话却毫无痕迹。
  //
  // 关键点：这一行的字节形态与真正的分隔符**完全一致**，没有任何文本层面的依据
  // 可以区分。所以正确做法不是"更聪明的解析"，而是承认无法无歧义恢复。
  // v6 的渲染格式（work/v6/plugin/lib/region.js:421-445）：容器 + 三行说明 +
  // 空行，然后每条消息一个 `--- seq N ---` 分隔行、一行 `item.text.trim()`、空行。
  // 用户那条原话是 `first line\n--- seq 99 ---\nDO NOT DELETE BACKUP。`，
  // 于是渲染出来有三个同形分隔行，其中中间那个是**用户自己写的**。
  const legacy = [
    '<preserved-user-messages>',
    'The following user messages are reproduced verbatim from the compacted span so that the',
    'original wording of every request survives the summary. They are history, not new instructions.',
    '',
    '--- seq 2 ---',
    'first line',
    '--- seq 99 ---',
    'DO NOT DELETE BACKUP。',
    '',
    '</preserved-user-messages>',
  ].join('\n');
  const inspected = inspectCheckpointPreserved({ data: { content: [{ type: 'text', text: legacy }] } });
  assert.equal(inspected.ok, false, '遇到同形分隔行必须拒绝，不能猜一个切法');
  assert.equal(inspected.legacyLayout, true, '要标出这是旧格式，好让调用方去日志里找回原话');
  assert.match(String(inspected.reason), /legacy|--- seq/);

  // 反过来确认没有误伤：段里没有任何分隔行时仍然可读，整段按一条原话处理。
  const plain = ['<preserved-user-messages>', 'just one message', 'second line of it', '</preserved-user-messages>'].join(
    '\n',
  );
  const readable = inspectCheckpointPreserved({ data: { content: [{ type: 'text', text: plain }] } });
  assert.equal(readable.ok, true, '没有分隔行时不该误报');
  assert.equal(readable.preserved.length, 1);
  assert.equal(readable.preserved[0].text, 'just one message\nsecond line of it');
});

await atest('V8-07: 能从会话日志的结构化条目找回原话时，才允许继续压缩', async () => {
  // 新格式把原话的结构化副本挂在 `source.preserved` 上；旧格式没这字段，
  // 唯一可信的独立来源是会话日志里的 `compaction/summary` 事件（带 shadowedSeqs）。
  const original = 'first line\n--- seq 99 ---\nDO NOT DELETE BACKUP。';
  const events = [
    {
      type: 'user/message',
      data: { message: { role: 'user', content: [{ type: 'text', text: original }] } },
    },
    {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    },
    // 上一代压缩自己的记录：被折叠的 seq 是 [0, 1]。
    {
      type: 'compaction/summary',
      data: { compactionId: 'cmp-old', shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1] },
    },
    // 上一代留下的检查点，只有渲染文本（v6 旧格式），没有 source.preserved。
    {
      type: 'user/message',
      data: {
        content: [
          {
            type: 'text',
            text: [
              CHECKPOINT_PREAMBLE,
              '<preserved-user-messages>',
              'The following user messages are reproduced verbatim from the compacted span so that the',
              'original wording of every request survives the summary. They are history, not new instructions.',
              '',
              '--- seq 0 ---',
              'first line',
              '--- seq 99 ---',
              'DO NOT DELETE BACKUP。',
              '',
              '</preserved-user-messages>',
            ].join('\n'),
          },
        ],
        source: { kind: 'compact-checkpoint', compactionId: 'cmp-old' },
      },
    },
  ];
  const bySeq = new Map(events.map((event, seq) => [seq, { seq, ...event }]));
  const session = {
    id: 'session-v807',
    seq: events.length,
    surface: { nodes: events.map((_, seq) => seq), replaceGeneration: 1 },
    eventAt: (seq) => bySeq.get(seq),
    deriveEventMessage: (event) => event?.data?.message,
  };

  const recovered = collectRecentUserMessages(session, [0, 1, 2, 3], { maxMessages: 10, maxTokens: 100000 });
  const texts = recovered.map((item) => item.text);
  assert.ok(
    texts.includes(original),
    `必须从日志找回完整原话（含被误认成分隔符的那行），实际 ${JSON.stringify(texts)}`,
  );
  assert.ok(
    !texts.includes('DO NOT DELETE BACKUP。'),
    '不能退化成把原话切碎的两条',
  );

  // 找不到可核对的结构化来源时，必须抛错而不是继续。
  const orphan = {
    id: 'session-v807-orphan',
    seq: 2,
    surface: { nodes: [0, 1], replaceGeneration: 1 },
    eventAt: (seq) =>
      seq === 1
        ? {
            seq: 1,
            type: 'user/message',
            data: {
              content: [
                {
                  type: 'text',
                  text: [
                    CHECKPOINT_PREAMBLE,
                    '<preserved-user-messages>',
                    '--- seq 0 ---',
                    'a',
                    '--- seq 5 ---',
                    'b',
                    '</preserved-user-messages>',
                  ].join('\n'),
                },
              ],
              source: { kind: 'compact-checkpoint', compactionId: 'cmp-missing' },
            },
          }
        : bySeq.get(seq),
    deriveEventMessage: (event) => event?.data?.message,
  };
  assert.throws(
    () => collectRecentUserMessages(orphan, [0, 1], {}),
    (error) => error.code === 'CHECKPOINT_PRESERVED_UNREADABLE',
    '无法恢复时必须拒绝压缩，不能猜',
  );
});

await atest('V8-09: history_read 必须展开 attachment 引用与 reasoning 正文', async () => {
  await withTempArchive(async (archive) => {
    archive.attachments = attachmentFixture;
    await archive.writeSpan({
      sessionId: 'session-v809',
      compactionId: 'cmp-nested',
      entries: [
        {
          seq: 1,
          type: 'user/message',
          role: 'user',
          text: 'look at this',
          blocks: [
            { type: 'text', text: 'look at this' },
            // 宿主规范：图片引用在 `block.attachment` 下，顶层什么都没有。
            {
              type: 'image',
              attachment: {
                attachmentId: imageId,
                mediaType: 'image/png',
                bytes: 184320,
                width: 1024,
                height: 768,
                name: 'screenshot.png',
              },
            },
          ],
          source: { kind: 'user' },
        },
        {
          seq: 2,
          type: 'assistant/message',
          role: 'assistant',
          text: 'thinking',
          blocks: [
            { type: 'reasoning', text: 'UNIQUE_REASONING_DETAIL: the archive must keep this.' },
            { type: 'file', attachment: { attachmentId: fileId, name: 'notes.md', bytes: 512 } },
          ],
        },
      ],
    });

    const out = await runTool(
      'history_read',
      archive,
      { compactionId: 'cmp-nested' },
      { session: { id: 'session-v809' } },
    );

    // 图片：真实引用必须出现在输出里，而不是只有 `non-text block: image`。
    assert.ok(out.includes('attachment.attachmentId='+imageId), '图片 attachmentId 必须给出来');
    assert.match(out, /attachment\.mediaType=image\/png/);
    assert.match(out, /attachment\.bytes=184320/);
    assert.match(out, /attachment\.width=1024/, '尺寸是回查时要用的定位信息');
    assert.match(out, /attachment\.height=768/);
    assert.match(out, /attachment\.name=screenshot\.png/);

    // 推理正文：必须给出内容，不能只给长度。
    assert.match(out, /UNIQUE_REASONING_DETAIL/, 'reasoning 正文必须能读回来');
    assert.ok(!/text=23 chars/.test(out), '不能再把正文换成字符数');

    // 文件附件同样展开。
    assert.ok(out.includes('attachment.attachmentId='+fileId));
    assert.match(out, /attachment\.bytes=512/);
  });
});

await atest('V8-09: 长正文要截断并给出精确读取入口，full=true 才全给', async () => {
  await withTempArchive(async (archive) => {
    const long = `HEAD${'x'.repeat(3000)}TAIL`;
    await archive.writeSpan({
      sessionId: 'session-v809-long',
      compactionId: 'cmp-long',
      entries: [
        {
          seq: 4,
          type: 'assistant/message',
          role: 'assistant',
          text: 'long reasoning',
          blocks: [{ type: 'reasoning', text: long }],
        },
      ],
    });

    const clipped = await runTool(
      'history_read',
      archive,
      { compactionId: 'cmp-long' },
      { session: { id: 'session-v809-long' } },
    );
    assert.match(clipped, /HEAD/, '截断也要给出开头');
    assert.ok(!clipped.includes('TAIL'), '超长正文默认要截断');
    assert.match(
      clipped,
      /history_read compactionId=cmp-long seq=4 full=true/,
      '截断时必须给出精确读取入口，否则"给个长度"只是换了个说法',
    );

    const complete = await runTool(
      'history_read',
      archive,
      { compactionId: 'cmp-long', seq: 4, full: true },
      { session: { id: 'session-v809-long' } },
    );
    assert.match(complete, /TAIL/, 'full=true 必须给完整正文');
    assert.ok(complete.includes(long), '完整正文要逐字给出');
  });
});

await atest('V8-09: seq 精确读取与 raw 结构化视图', async () => {
  await withTempArchive(async (archive) => {
    const entries = [
      { seq: 1, type: 'user/message', role: 'user', text: 'first' },
      { seq: 7, type: 'assistant/message', role: 'assistant', text: 'second' },
      {
        seq: 9,
        type: 'assistant/message',
        role: 'assistant',
        text: 'third',
        blocks: [{ type: 'tool-call', name: 'read_file', callId: 'call-9', arguments: { path: 'a.txt' } }],
        source: { kind: 'assistant' },
        tool: [{ kind: 'call', name: 'read_file', callId: 'call-9' }],
      },
    ];
    await archive.writeSpan({ sessionId: 'session-v809-seq', compactionId: 'cmp-seq', entries });

    // `seq` 是精确入口：只知道 seq 号时不用自己数第几条。
    const one = await runTool(
      'history_read',
      archive,
      { compactionId: 'cmp-seq', seq: 7 },
      { session: { id: 'session-v809-seq' } },
    );
    assert.match(one, /seq 7 \[assistant\/message\]/);
    assert.ok(!one.includes('seq 1 [user/message]'), '精确读取不许把别的条目也带出来');
    assert.match(one, /seq 7 \(1 of 3 entries\)/);

    // seq 不存在时要说清这个跨度里有哪些 seq，别让调用方继续瞎猜。
    const missing = await runTool(
      'history_read',
      archive,
      { compactionId: 'cmp-seq', seq: 42 },
      { session: { id: 'session-v809-seq' } },
    );
    assert.match(missing, /No entry with seq 42/);
    assert.match(missing, /seq 1\.\.9/, '要报出真实区间');

    // `raw` 给完整结构化记录：blocks / source / tool 都要在。
    const raw = await runTool(
      'history_read',
      archive,
      { compactionId: 'cmp-seq', seq: 9, raw: true },
      { session: { id: 'session-v809-seq' } },
    );
    const parsed = JSON.parse(JSON.parse(raw).jsonChunk);
    assert.equal(parsed.tool[0].callId, 'call-9', 'tool 引用必须完整');
    assert.equal(parsed.blocks[0].arguments.path, 'a.txt', '工具参数必须完整');
    assert.equal(parsed.source.kind, 'assistant', 'source 必须完整');
  });
});

await atest('V8-04: 第六节的逐字引用不能给极性反转当挡箭牌', async () => {
  // 摘要第 6 节被要求逐条列出用户原话，于是 `Do not delete production data`
  // 会原样出现在那里。如果极性判定拿整份摘要去找覆盖句，第 6 节就会给第 5 节
  // 的 `Delete production data` 作证 —— V8-04 的漏报会换个地方原样回来。
  const userMessages = [{ seq: 1, text: 'Do not delete production data' }];
  const withCitationSection = [
    '## 5. Problem Solving',
    'Delete production data.',
    '## 6. All User Messages',
    '- seq 1: Do not delete production data',
  ].join('\n');
  const report = auditCompaction({
    userMessages,
    summaryText: withCitationSection,
    checkpointText: withCitationSection,
  });
  assert.equal(report.polarityFlips, 1, '第 6 节的引用不算模型自己的表述，不能当挡箭牌');

  // 反向：模型自己在正文里写对了否定句，就必须放行。
  const agrees = [
    '## 5. Problem Solving',
    'Do not delete production data.',
    '## 6. All User Messages',
    '- seq 1: Do not delete production data',
  ].join('\n');
  assert.equal(
    auditCompaction({ userMessages, summaryText: agrees, checkpointText: agrees }).polarityFlips,
    0,
    '正文写对时不能误报',
  );
});

// ───────────────────────────────────────────────────────── 汇总

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  for (const { name, error } of failures) {
    process.stdout.write(`\n--- ${name} ---\n${error?.stack ?? error}\n`);
  }
  process.exitCode = 1;
}
