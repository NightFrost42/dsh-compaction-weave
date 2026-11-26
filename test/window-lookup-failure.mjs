// 回归：resolveSummaryCapacity 对 resolveModelInfo 失败的可观测性。
//
// 背景：catch 只重抛 abort，其余异常被静默吞掉，随后回落到 windowFallback。
// 这是有意设计（CAP11 依赖超时回落 200000），但对排查很不友好：
// 「模型不存在 / provider 未注册 / 查询超时」与「确实未知窗口」事后无从区分。
// 本测试锁定的行为是：**回落行为完全不变**，额外记录 windowLookupFailure。
import assert from 'node:assert/strict';
import { resolveSummaryCapacity } from '../lib/summary-budget.js';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e?.stack ?? String(e) }); }
}

const cfg = {
  maxTokens: 8192,
  headroomTokens: 33000,
  summaryInputRatio: 0.85,
  summaryInputMaxBytes: 2097152,
  summaryTimeoutMs: 180000,
  windowFallback: 200000,
};
const chain = { targets: [{ provider: 'p', model: 'm' }] };

await test('healthy lookup has no failure marker', async () => {
  const cap = await resolveSummaryCapacity({ llm: { resolveModelInfo: async () => ({ contextWindow: 1048576 }) } }, chain, cfg);
  assert.equal(cap.targets[0].window, 1048576);
  assert.equal(cap.targets[0].source, 'target-metadata/config');
  assert.equal('windowLookupFailure' in cap.targets[0], false);
});

await test('thrown UNKNOWN_MODEL falls back but is recorded', async () => {
  const cap = await resolveSummaryCapacity({
    llm: { resolveModelInfo: async () => { throw Object.assign(new Error('magpie knows no model'), { code: 'UNKNOWN_MODEL' }); } },
  }, chain, cfg);
  assert.equal(cap.targets[0].window, 200000, 'fallback window must stay 200000');
  assert.equal(cap.targets[0].source, 'configured-fallback');
  assert.equal(cap.targets[0].windowLookupFailure, 'UNKNOWN_MODEL');
});

await test('missing resolveModelInfo is recorded too', async () => {
  const cap = await resolveSummaryCapacity({ llm: {} }, chain, cfg);
  assert.equal(cap.targets[0].window, 200000);
  assert.ok(cap.targets[0].windowLookupFailure, 'must record a failure marker');
});

await test('explicit windowProviderMap still wins over lookup failure', async () => {
  const cap = await resolveSummaryCapacity({
    llm: { resolveModelInfo: async () => { throw new Error('boom'); } },
  }, chain, { ...cfg, windowProviderMap: { 'p/m': 1000000 } });
  assert.equal(cap.targets[0].window, 1000000);
  assert.equal(cap.targets[0].source, 'target-metadata/config');
});

await test('timeout still falls back to 200000 (CAP11 contract preserved)', async () => {
  const cap = await resolveSummaryCapacity({
    llm: { resolveModelInfo: () => new Promise(() => {}) },
  }, chain, { ...cfg, summaryTimeoutMs: 20 });
  assert.equal(cap.targets[0].window, 200000);
  assert.equal(cap.targets[0].source, 'configured-fallback');
});

const failed = results.filter((r) => !r.pass);
process.stdout.write(JSON.stringify({ suite: 'window-lookup-failure', passed: results.length - failed.length, failed: failed.length, results }, null, 2) + '\n');
if (failed.length > 0) process.exitCode = 1;
