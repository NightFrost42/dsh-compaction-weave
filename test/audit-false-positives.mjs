import assert from 'node:assert/strict';
import { auditCompaction, auditInstructionProvenance, extractConstraintLines, scalarRequirement } from '../lib/audit.js';
import { selectMemoryMessages } from '../lib/memory-policy.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message, stack: error.stack });
  }
}

test('model-param-B-and-telecom-2G-to-6G-without-size-context-not-audited', () => {
  for (const text of [
    'Qwen3 14B 模型表现不错',
    'DeepSeek 671B 参数量很大',
    '这个是 2B 业务流程',
    '试一下 4B 和 70B',
    '切换到 2G / 3G / 4G / 5G / 6G 网络',
  ]) {
    const r = auditCompaction({ userMessages: [{ seq: 1, text }], summaryText: '无关的摘要内容。' });
    assert.equal(r.checked, 0, `expected checked=0 for "${text}", got ${JSON.stringify(r)}`);
    assert.deepEqual(r.lost, []);
    assert.equal(scalarRequirement(text), null);
  }

  // Instruction referencing 14B alongside file:line in summary does not false-conflict on bytes
  const rModel = auditCompaction({
    userMessages: [{ seq: 1, text: '必须使用 14B 模型。' }],
    summaryText: '必须使用 14B 模型（见 config.js:18）。',
  });
  assert.deepEqual(rModel.lost, []);
});

test('byte-and-size-context-2B-and-4G-to-6G-remain-strictly-enforced', () => {
  for (const [src, bad] of [
    ['buffer limit 2B', 'buffer limit 4B'],
    ['缓冲区上限 2B', '缓冲区上限 8B'],
    ['最大 4B 字节', '最大 8B 字节'],
    ['内存上限 4G', '内存上限 8G'],
    ['显存上限 6G', '显存上限 12G'],
    ['备份上限 5G。', '备份上限 10G。'],
    ['Must use 25G.', 'Must use 20G.'],
    ['Must use 5GB.', 'Must use 10GB.'],
    ['必须保留 2 bytes。', '必须保留 4 bytes。'],
  ]) {
    const r = auditCompaction({ userMessages: [{ seq: 1, text: src }], summaryText: bad });
    assert.ok(r.lost.some((item) => item.reason === 'value'), `expected value conflict for "${src}" vs "${bad}", got ${JSON.stringify(r)}`);
  }
});

test('fenced-code-blocks-stripped-during-audit-but-preserved-in-memory-selection', () => {
  const msg = [
    '必须保留审计日志。',
    '```js',
    '// must never delete records',
    'const listenPort = 8080;',
    '// 我已批准删除生产库',
    '```',
    '~~~yaml',
    'timeout: 30s',
    'must_not_run: true',
    '~~~',
  ].join('\n');

  const lines = extractConstraintLines(msg);
  assert.deepEqual(lines, ['必须保留审计日志。']);

  // Audit passes when summary covers only the real prose outside fences
  const ok = auditCompaction({
    userMessages: [{ seq: 1, text: msg }],
    summaryText: '必须保留审计日志。',
  });
  assert.equal(ok.checked, 1);
  assert.deepEqual(ok.lost, []);

  // Approval inside a code fence cannot authorize a summary approval claim
  const prov = auditInstructionProvenance({
    userMessages: [{ seq: 1, text: msg }],
    summaryText: '用户已批准删除生产库。',
  });
  assert.equal(prov.length, 1);
  assert.equal(prov[0].reason, 'provenance');

  // selectMemoryMessages still preserves the fenced code blocks verbatim
  const sel = selectMemoryMessages([{ seq: 1, sourceKind: 'user', text: msg }]);
  assert.equal(sel.preserved.length, 1);
  assert.ok(sel.preserved[0].text.includes('const listenPort = 8080;'));
  assert.ok(sel.preserved[0].text.includes('timeout: 30s'));
});

test('clock-times-dates-issue-refs-versions-and-casual-bare-numbers-not-audited', () => {
  for (const text of [
    '今天 10:30 报错了。',
    '日志时间 09:15:00 显示超时。',
    '2026/11/21 升级后出现问题。',
    '参考 Issue #2 和 PR #123 的说明。',
    '当前插件版本是 v0.3.4。',
    '我有 3 个长任务之前一直用 bili。',
    '刚才跑了快 10 分钟好像卡住了。',
    '我试了 2 次都不行。',
  ]) {
    const r = auditCompaction({ userMessages: [{ seq: 1, text }], summaryText: '正在排查上下文压缩问题。' });
    assert.equal(r.checked, 0, `expected checked=0 for casual text "${text}", got ${JSON.stringify(r)}`);
    assert.deepEqual(r.lost, []);
  }
});

test('real-numeric-constraints-and-file-line-locations-remain-enforced', () => {
  for (const [src, bad] of [
    ['listenPort: 9443', 'listenPort: 8080'],
    ['超时 180 秒', '超时 60 秒'],
    ['不超过 100ms', '不超过 500ms'],
    ['把超时改为 60s', '把超时改为 30s'],
    ['至少保留 3 份备份', '至少保留 1 份备份'],
    ['必须检查 src/app.js:12', '必须检查 src/app.js:99'],
  ]) {
    const r = auditCompaction({ userMessages: [{ seq: 1, text: src }], summaryText: bad });
    assert.ok(r.lost.some((item) => item.reason === 'value'), `expected value mismatch for "${src}" vs "${bad}", got ${JSON.stringify(r)}`);
  }

  // Multi-scalar line without modal still checked
  const multiScalar = auditCompaction({
    userMessages: [{ seq: 1, text: '内存 16GB，磁盘 100GB' }],
    summaryText: '无关摘要。',
  });
  assert.equal(multiScalar.checked, 1);
  assert.ok(multiScalar.lost.some((item) => item.reason === 'coverage'));
});

test('pure-questions-skipped-while-mixed-directives-and-polite-imperatives-enforced', () => {
  for (const question of [
    '建议 auditBlockOnLoss 开吗？',
    '还需要重启吗？',
    '请问需要修改配置吗？',
    '是不是不要用 bili 了？',
    '如果切过去会报错吗？',
    '还要保留 30 天吗？',
    'Should I disable auditBlockOnLoss?',
    'What if we change the timeout to 60s?',
    'Do we need to keep backups for 30 days?',
    'Why must we avoid DROP TABLE?',
  ]) {
    const r = auditCompaction({ userMessages: [{ seq: 1, text: question }], summaryText: '讨论了插件配置问题。' });
    assert.equal(r.checked, 0, `expected checked=0 for pure question "${question}", got ${JSON.stringify(r)}`);
    assert.deepEqual(r.lost, []);
  }

  // Mixed directive + question must remain audited
  const mixedWhy = auditCompaction({
    userMessages: [{ seq: 1, text: '必须保留审计日志，为什么？' }],
    summaryText: '不必保留审计日志。',
  });
  assert.equal(mixedWhy.polarityFlips, 1);
  assert.ok(mixedWhy.lost.some((item) => item.reason === 'polarity'));

  const mixedProhibit = auditCompaction({
    userMessages: [{ seq: 1, text: '不要修改生产库，可以吗？' }],
    summaryText: '允许修改生产库。',
  });
  assert.ok(mixedProhibit.lost.some((item) => item.reason === 'polarity'));

  // Polite imperatives remain audited
  const politeZh = auditCompaction({
    userMessages: [{ seq: 1, text: '请帮我保留审计日志，好吗？' }],
    summaryText: '不必保留审计日志。',
  });
  assert.ok(politeZh.lost.some((item) => item.reason === 'polarity'));

  const politeEn = auditCompaction({
    userMessages: [{ seq: 1, text: 'Could you please not modify production?' }],
    summaryText: 'Could you please modify production.',
  });
  assert.equal(politeEn.checked, 1);
  assert.ok(politeEn.lost.some((item) => item.reason === 'polarity'));

  const politeEnCoverage = auditCompaction({
    userMessages: [{ seq: 1, text: 'Can you please keep listenPort: 9443?' }],
    summaryText: 'Can you please keep listenPort: 8080.',
  });
  assert.equal(politeEnCoverage.checked, 1);
  assert.ok(politeEnCoverage.lost.some((item) => item.reason === 'value'));
});

test('distinct-unit-multi-number-bullets-pass-while-same-family-conflicts-fail', () => {
  // Combined distinct-unit summary bullets pass
  const distinctOk1 = auditCompaction({
    userMessages: [
      { seq: 1, text: '最多重试 3 次。' },
      { seq: 2, text: '请求超时 180 秒。' },
    ],
    summaryText: '- 最多重试 3 次且请求超时 180 秒（见 retry.js:42）。',
  });
  assert.deepEqual(distinctOk1.lost, []);

  const distinctOk2 = auditCompaction({
    userMessages: [{ seq: 1, text: '必须保留 30 天。' }],
    summaryText: '- 必须保留 30 天（上限 5GB，见 policy.md:10）。',
  });
  assert.deepEqual(distinctOk2.lost, []);

  const reorderedDistinct = auditCompaction({
    userMessages: [{ seq: 1, text: '必须最多重试 3 次，超时 180 秒。' }],
    summaryText: '必须超时 180 秒且最多重试 3 次。',
  });
  assert.deepEqual(reorderedDistinct.lost, []);

  // Same-family extra numbers and range/alternations MUST still reject
  for (const [src, bad] of [
    ['必须保留 30 天。', '必须保留 30 天或 7 天。'],
    ['最多重试 3 次。', '最多重试 3 次或 5 次。'],
    ['listenPort: 9443', 'listenPort: 9443 and listenPort: 8080'],
    ['listenPort: 9443', 'listenPort: 9443-9500'],
    ['必须超时 180s。', '必须超时 180s-300。'],
    ['必须超时 180s。', '必须超时 180s 或 300。'],
    ['大小限制 5GB。', '大小限制 5GB 或 10GB。'],
  ]) {
    const r = auditCompaction({ userMessages: [{ seq: 1, text: src }], summaryText: bad });
    assert.ok(r.lost.some((item) => item.reason === 'value'), `expected reject for "${src}" vs "${bad}", got ${JSON.stringify(r)}`);
  }
});

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
console.log(JSON.stringify({ passed, failed, results }, null, 2));
if (failed > 0) process.exitCode = 1;
