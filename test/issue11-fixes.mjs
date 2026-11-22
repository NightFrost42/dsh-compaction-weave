import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  auditCompaction,
  extractConstraintLines,
  negationsOf,
  stripExplicitValueCorrection,
} from '../lib/audit.js';
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  dumpAuditRejection,
} from '../lib/audit-reject.js';
import { failureExplanation } from '../lib/failure-diagnostics.js';
import {
  detectForeignBiliSummaryOutput,
  isExternalFoldEvent,
} from '../lib/foreign-fold.js';
import { buildCompactionInstruction, renderRepairFeedback } from '../lib/prompt.js';
import { summarizeWithChain } from '../lib/summary.js';
import { validateSummaryStructure } from '../lib/validate.js';

const results = [];
async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, pass: true, ms: Date.now() - started });
  } catch (error) {
    results.push({ name, pass: false, ms: Date.now() - started, error: error.message, stack: error.stack });
  }
}

const EN_HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeEnSummary(body = 'Preserved details.') {
  return EN_HEADINGS.map((h, i) => `${h}\n${i === 5 ? '[filled by engine]' : body}`).join('\n\n');
}

// ────────────────────────────────────────────────── Part A: Chinese polarity & value fixes

await test('A1-buka-compound-adjectives-not-negations-while-real-buka-prohibitions-remain-strict', () => {
  for (const adj of [
    'prune 只读 + 副本演练（不可逆动作全在副本）',
    '不可或缺的步骤',
    '不可避免的延迟',
    '不可变配置对象',
    '不可靠的网络链路',
    '不可预测的竞态',
  ]) {
    assert.deepEqual(negationsOf(adj), [], `expected zero negations for "${adj}"`);
  }

  // Compound adjectives in source/summary must never emit false polarity
  const okReadOnly = auditCompaction({
    userMessages: [{ seq: 1, text: '必须保持 prune 只读 + 副本演练（不可逆动作全在副本）。' }],
    summaryText: makeEnSummary('必须保持 prune 只读 + 副本演练（不可逆动作全在副本）。'),
  });
  assert.deepEqual(okReadOnly.lost, []);
  assert.equal(okReadOnly.polarityFlips, 0);

  const okAdjNoParens = auditCompaction({
    userMessages: [{ seq: 1, text: '必须保留不可变配置，这是不可或缺且不可避免的机制。' }],
    summaryText: makeEnSummary('保留不可变配置（不可或缺且不可避免）。'),
  });
  assert.deepEqual(okAdjNoParens.lost, []);
  assert.equal(okAdjNoParens.polarityFlips, 0);

  // Real 不可 prohibitions MUST still match NEGATION and block polarity reversal!
  for (const [source, reversed] of [
    ['不可修改生产库。', '允许修改生产库。'],
    ['不可删除审计日志。', '可以删除审计日志。'],
    ['不可跳过校验步骤。', '可以跳过校验步骤。'],
    ['不可写入主表。', '直接写入主表。'],
    ['不可直接发布到线上。', '可以直接发布到线上。'],
  ]) {
    assert.ok(negationsOf(source).includes('不可'), `expected 不可 negation in "${source}"`);
    assert.deepEqual(extractConstraintLines(source), [source]);
    const r = auditCompaction({
      userMessages: [{ seq: 1, text: source }],
      summaryText: makeEnSummary(reversed),
    });
    assert.ok(
      r.lost.some((item) => item.reason === 'polarity'),
      `expected polarity reject for "${source}" -> "${reversed}", got ${JSON.stringify(r)}`,
    );
    assert.ok(r.polarityFlips >= 1);
  }
});

await test('A2-quoted-nominal-discipline-phrases-consistent-while-reversals-trigger-polarity', () => {
  // Affirmative governance preservation phrases referencing a negative rule stay valid
  for (const consistent of [
    '维持「上正主前门表」纪律',
    '维持「上正主前门表」的纪律',
    '严格遵守「上正主前门表」规范',
    '坚守「上正主前门表」红线',
    '遵循「别上正主」原则',
  ]) {
    const r = auditCompaction({
      userMessages: [{ seq: 1, text: '别上正主' }],
      summaryText: makeEnSummary(consistent),
    });
    assert.deepEqual(r.lost, [], `expected no loss for "${consistent}", got ${JSON.stringify(r)}`);
    assert.equal(r.polarityFlips, 0);
  }

  // Real reversals MUST still emit reason='polarity'!
  for (const reversed of [
    '可以上正主',
    '直接上正主',
    '放开「上正主」限制',
    '取消「别上正主」纪律',
    '不再执行「别上正主」纪律',
    '维持「允许上正主」纪律',
  ]) {
    const r = auditCompaction({
      userMessages: [{ seq: 1, text: '别上正主' }],
      summaryText: makeEnSummary(reversed),
    });
    assert.ok(
      r.lost.some((item) => item.reason === 'polarity'),
      `expected polarity reject for "别上正主" -> "${reversed}", got ${JSON.stringify(r)}`,
    );
    assert.ok(r.polarityFlips >= 1);
  }
});

await test('A3-unrelated-low-overlap-cross-section-pairs-never-emit-polarity-while-real-short-flips-do', () => {
  const rCross = auditCompaction({
    userMessages: [
      { seq: 1, text: '注意：0.58 = 0.3×0.6，第 0 段 used 是 null。' },
      { seq: 2, text: 'verify-daycard.py 需做容错解析（第 0 段 BV…未命中时降级）。' },
    ],
    summaryText: makeEnSummary(
      [
        '0.58 = 0.3×0.6，第 0 段 used 是 null。',
        'verify-daycard.py：容错解析（第 0 段 BV…未命中时降级）。',
      ].join('\n'),
    ),
  });
  assert.equal(rCross.polarityFlips, 0, `unexpected polarity flip: ${JSON.stringify(rCross)}`);
  assert.deepEqual(rCross.lost, []);

  // Pure digit overlap alone ('0.58 = 0.3×0.6... used 是 null' vs 'verify-daycard.py：容错解析（第 0 段 BV…）') must not emit polarity
  const rUnrelated = auditCompaction({
    userMessages: [{ seq: 1, text: '注意：0.58 = 0.3×0.6... used 是 null' }],
    summaryText: makeEnSummary('0.58 = 0.3×0.6... used 是 null\nverify-daycard.py：容错解析（第 0 段 BV…）'),
  });
  assert.equal(rUnrelated.polarityFlips, 0);
  assert.deepEqual(rUnrelated.lost, []);

  // Distinct scalar subjects ('used = 0' vs '第 0 段 = 0') must not false-polarity
  const rDistinctScalars = auditCompaction({
    userMessages: [{ seq: 1, text: 'used = 0' }],
    summaryText: makeEnSummary('used = 0\n不能修改第 0 段 = 0'),
  });
  assert.equal(rDistinctScalars.polarityFlips, 0);
  assert.deepEqual(rDistinctScalars.lost, []);

  // Real short reversals still trigger polarity cleanly
  for (const [src, bad] of [
    ['不要删除 backups', '允许删除 backups'],
    ['禁止自动重启', '自动重启'],
    ['不允许直接写入生产库', '可以直接写入生产库'],
  ]) {
    const r = auditCompaction({
      userMessages: [{ seq: 1, text: src }],
      summaryText: makeEnSummary(bad),
    });
    assert.ok(r.lost.some((item) => item.reason === 'polarity'), `expected polarity flip for "${src}" -> "${bad}"`);
    assert.ok(r.polarityFlips >= 1);
  }
});

await test('A4-explicit-colloquial-numeric-corrections-pass-new-value-and-reject-old-value', () => {
  assert.equal(stripExplicitValueCorrection('prune 对表 420（不是 386）'), 'prune 对表 420');
  assert.equal(stripExplicitValueCorrection('420 (not 386)'), '420');
  assert.equal(stripExplicitValueCorrection('timeout: 420ms, not 386ms'), 'timeout: 420ms');
  assert.equal(stripExplicitValueCorrection('prune 对表 420，而不是 386'), 'prune 对表 420');

  // Summarized with new value (either stripped or retaining correction note) -> ZERO loss, ZERO polarity
  for (const [src, okSummary] of [
    ['prune 对表 420（不是 386）', 'prune 对表 420'],
    ['prune 对表 420（不是 386）', 'prune 对表 420（不是 386）'],
    ['prune 对表 420（不是之前的 386）', 'prune 对表 420'],
    ['prune 对表 420，而不是 386', 'prune 对表 420'],
    ['port: 420 (not 386)', 'port: 420'],
    ['timeout: 420ms, not 386ms', 'timeout: 420ms'],
  ]) {
    const rOk = auditCompaction({
      userMessages: [{ seq: 1, text: src }],
      summaryText: makeEnSummary(okSummary),
    });
    assert.deepEqual(rOk.lost, [], `expected pass for "${src}" -> "${okSummary}", got ${JSON.stringify(rOk)}`);
    assert.equal(rOk.polarityFlips, 0);
  }

  // Bound historical replacement contrast alongside active value passes cleanly
  const rHistorical = auditCompaction({
    userMessages: [{ seq: 1, text: 'port: 420' }],
    summaryText: makeEnSummary('port was 386, replaced by 420\nport: 420'),
  });
  assert.deepEqual(rHistorical.lost, []);

  // Wrongly reverting to old value MUST still reject with reason='value'!
  for (const [src, badSummary] of [
    ['prune 对表 420（不是 386）', 'prune 对表 386'],
    ['port: 420 (not 386)', 'port: 386'],
    ['timeout: 420ms, not 386ms', 'timeout: 386ms'],
  ]) {
    const rBad = auditCompaction({
      userMessages: [{ seq: 1, text: src }],
      summaryText: makeEnSummary(badSummary),
    });
    assert.ok(
      rBad.lost.some((item) => item.reason === 'value'),
      `expected reason='value' for "${src}" -> "${badSummary}", got ${JSON.stringify(rBad)}`,
    );
  }
});

// ────────────────────────────────────────────────── Part B: Foreign bili output detection & repair

await test('B1-detectForeignBiliSummaryOutput-and-isExternalFoldEvent-boundaries', () => {
  assert.equal(detectForeignBiliSummaryOutput('<bili-snapshot v1 conv="c1" seq="12" blocks="b1" />'), 'bili_snapshot');
  assert.equal(detectForeignBiliSummaryOutput('  \n```xml\n<bili-snapshot v2 blocks="b1" />\n```'), 'bili_snapshot');
  assert.equal(detectForeignBiliSummaryOutput('[Compressed conversation section] — Task notes'), 'bili_compressed_section');
  assert.equal(detectForeignBiliSummaryOutput('```\n[Compressed conversation section]\nDetails\n```'), 'bili_compressed_section');
  assert.equal(detectForeignBiliSummaryOutput(makeEnSummary('Discussed <bili-snapshot v1 /> and [Compressed conversation section]')), null);
  assert.equal(detectForeignBiliSummaryOutput(''), null);

  // isExternalFoldEvent detects missing/legacy bili folds on user/assistant events
  assert.equal(
    isExternalFoldEvent({
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: '<bili-snapshot v1 conv="x" seq="1" />' }] },
    })?.reason,
    'bili_snapshot_checkpoint',
  );
  assert.equal(
    isExternalFoldEvent({
      type: 'assistant/message',
      data: {
        message: {
          role: 'assistant',
          source: { kind: 'model', provider: 'p', model: 'm' },
          content: [{ type: 'text', text: '[Compressed conversation section]\nOld summary.' }],
        },
      },
    })?.reason,
    'bili_compressed_section_checkpoint',
  );

  // Immune: native Weave checkpoint & ordinary user/assistant prose quoting <bili-snapshot>
  assert.equal(
    isExternalFoldEvent({
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'compact-checkpoint', compactionId: 'weave-123', memorySources: [] },
        content: [{ type: 'text', text: '<bili-snapshot v1 /> discussed earlier' }],
      },
    }),
    null,
  );
  assert.equal(
    isExternalFoldEvent({
      type: 'user/message',
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Please explain <bili-snapshot v1 /> mid-sentence.' }],
      },
    }),
    null,
  );
  assert.equal(
    isExternalFoldEvent({
      type: 'assistant/message',
      data: {
        message: {
          role: 'assistant',
          source: { kind: 'model', provider: 'p', model: 'm' },
          content: [{ type: 'text', text: 'Here is an explanation of <bili-snapshot v1 />.' }],
        },
      },
    }),
    null,
  );
});

await test('B2-B5-validate-prompt-summary-retry-and-failureExplanation-for-foreign-bili', async () => {
  const snapVerdict = validateSummaryStructure('<bili-snapshot v1 blocks="b1" />\nOld summary', { language: 'en' });
  assert.equal(snapVerdict.ok, false);
  assert.equal(snapVerdict.code, 'SUMMARY_FOREIGN_BILI_FORMAT');
  assert.equal(snapVerdict.foreignBiliFormat, 'bili_snapshot');

  const compVerdict = validateSummaryStructure('[Compressed conversation section]\nDone.', { language: 'zh' });
  assert.equal(compVerdict.ok, false);
  assert.equal(compVerdict.code, 'SUMMARY_FOREIGN_BILI_FORMAT');
  assert.equal(compVerdict.foreignBiliFormat, 'bili_compressed_section');

  // Repair prompt explicitly forbids <bili-snapshot> and [Compressed conversation section]
  const feedbackText = renderRepairFeedback({
    code: 'SUMMARY_FOREIGN_BILI_FORMAT',
    message: snapVerdict.message,
    issues: [],
  });
  assert.match(feedbackText, /<bili-snapshot>/);
  assert.match(feedbackText, /\[Compressed conversation section\]/);
  assert.match(feedbackText, /billion-context/i);
  assert.match(feedbackText, /9-section/i);

  // Retry succeeds when attempt 1 returns <bili-snapshot> and attempt 2 returns valid 9-section summary
  const retryCalls = [];
  const retryResult = await summarizeWithChain({
    ctx: {
      llm: {
        async *stream(opts) {
          retryCalls.push(opts);
          const text =
            retryCalls.length === 1
              ? '<bili-snapshot v1 blocks="1" />\nLegacy proxy output'
              : makeEnSummary('Clean 9-section output.');
          yield { type: 'text-delta', text };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    },
    agent: { session: { id: 'bili-retry-sess' } },
    input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Keep logs.' }] }] },
    chain: { targets: [{ provider: 'p', model: 'm' }] },
    options: {
      maxTokens: 1024,
      timeoutMs: 5000,
      language: 'en',
      retryCount: 2,
      retryDelayMs: 0,
      validate: (r) => validateSummaryStructure(r.rawText, { language: r.language }),
    },
    signal: new AbortController().signal,
  });
  assert.equal(retryCalls.length, 2);
  assert.ok(retryResult.rawText.includes('Clean 9-section output.'));
  const secondReqText = JSON.stringify(retryCalls[1].messages.at(-1));
  assert.match(secondReqText, /SUMMARY_FOREIGN_BILI_FORMAT/);
  assert.match(secondReqText, /<bili-snapshot>/);

  // Exhausted retries preserve error.code === 'SUMMARY_FOREIGN_BILI_FORMAT'
  const failCalls = [];
  let exhaustedErr = null;
  try {
    await summarizeWithChain({
      ctx: {
        llm: {
          async *stream(opts) {
            failCalls.push(opts);
            yield { type: 'text-delta', text: '[Compressed conversation section]\nStill proxy output.' };
            yield { type: 'finish', kind: 'stop' };
          },
        },
      },
      agent: { session: { id: 'bili-fail-sess' } },
      input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Keep logs.' }] }] },
      chain: { targets: [{ provider: 'p', model: 'm' }] },
      options: {
        maxTokens: 1024,
        timeoutMs: 5000,
        language: 'en',
        retryCount: 1,
        retryDelayMs: 0,
        validate: (r) => validateSummaryStructure(r.rawText, { language: r.language }),
      },
      signal: new AbortController().signal,
    });
  } catch (err) {
    exhaustedErr = err;
  }
  assert.equal(failCalls.length, 2);
  assert.ok(exhaustedErr);
  assert.equal(exhaustedErr.code, 'SUMMARY_FOREIGN_BILI_FORMAT');
  assert.equal(exhaustedErr.summaryRetryExhausted, true);

  // failureExplanation warns about residual bili local proxy & baseUrl
  const directExplain = failureExplanation(exhaustedErr);
  assert.match(directExplain, /SUMMARY_FOREIGN_BILI_FORMAT/);
  assert.match(directExplain, /bili|billion-context/);
  assert.match(directExplain, /127\.0\.0\.1|localhost|代理/);
  assert.match(directExplain, /baseUrl/);

  const wrappedExplain = failureExplanation(
    Object.assign(new Error('wrapped'), {
      code: 'SUMMARY_ALL_FAILED',
      failureCodes: ['SUMMARY_FOREIGN_BILI_FORMAT'],
    }),
  );
  assert.match(wrappedExplain, /SUMMARY_FOREIGN_BILI_FORMAT/);
  assert.match(wrappedExplain, /baseUrl/);
});

// ────────────────────────────────────────────────── Part C: audit-reject/ caps

await test('C-audit-reject-per-file-truncation-and-total-bytes-rolling-eviction', async () => {
  assert.equal(MAX_FILES, 40);
  assert.equal(MAX_FILE_BYTES, 256 * 1024);
  assert.equal(MAX_TOTAL_BYTES, 4 * 1024 * 1024);

  const root = await mkdtemp(join(tmpdir(), 'weave-issue11-reject-'));
  try {
    // 1. Oversized bulky fields truncated cleanly while preserving reject, report.lost, target, attempt, code
    const lostItems = [{ seq: 9, reason: 'polarity', coverage: 1, line: '不可修改主表', candidate: '允许修改主表' }];
    const p1 = await dumpAuditRejection({
      storageRoot: root,
      sessionId: 'sess-oversize',
      compactionId: 'cmp-1',
      target: 'p/m',
      attempt: 2,
      code: 'CONSTRAINT_POLARITY_LOST',
      message: 'polarity flip at seq 9',
      modelRawText: 'Raw summary line. '.repeat(700),
      auditedText: 'Audited summary line. '.repeat(600),
      checkpointBlocks: [{ type: 'text', text: 'Checkpoint block line. '.repeat(600) }],
      userMessages: [{ seq: 9, text: 'User message line. '.repeat(700) }],
      report: { checked: 1, polarityFlips: 1, worstCoverage: 1, lost: lostItems },
      maxFileBytes: 4096,
      maxTotalBytes: 1024 * 1024,
    });
    assert.ok(p1);
    const bytes1 = (await stat(p1)).size;
    assert.ok(bytes1 <= 4096, `expected file size <= 4096, got ${bytes1}`);
    const parsed1 = JSON.parse(await readFile(p1, 'utf8'));
    assert.equal(parsed1.target, 'p/m');
    assert.equal(parsed1.attempt, 2);
    assert.deepEqual(parsed1.reject, { code: 'CONSTRAINT_POLARITY_LOST', message: 'polarity flip at seq 9' });
    assert.equal(parsed1.audit.lost.length, 1);
    assert.equal(parsed1.audit.lost[0].reason, 'polarity');
    assert.equal(parsed1.audit.lost[0].line, '不可修改主表');
    assert.match(parsed1.modelRawText, /\.\.\.\[truncated \d+ chars\]$/);
    assert.match(parsed1.auditedText, /\.\.\.\[truncated \d+ chars\]$/);
    assert.match(parsed1.userMessages[0].text, /\.\.\.\[truncated \d+ chars\]$/);

    // Clear p1 so rolling eviction test starts fresh
    await rm(p1, { force: true });

    // 2. Rolling oldest-first eviction when directory total bytes exceed maxTotalBytes
    const rejectDir = join(root, 'audit-reject');
    const written = [];
    for (let i = 0; i < 6; i += 1) {
      const p = await dumpAuditRejection({
        storageRoot: root,
        sessionId: 'sess-roll',
        compactionId: `roll-${i}`,
        target: 'p/m',
        attempt: 1,
        code: 'CONSTRAINT_LOST',
        message: `item ${i}`,
        modelRawText: `M${i}-` + 'Summary text chunk. '.repeat(100),
        report: { checked: 1, polarityFlips: 0, worstCoverage: 0.2, lost: [{ seq: i, reason: 'coverage', coverage: 0.2, line: `Rule ${i}` }] },
        maxFiles: 40,
        maxFileBytes: 4096,
        maxTotalBytes: 6000,
      });
      assert.ok(p);
      // Pin ascending deterministic mtimeMs so oldest-first eviction order is exact
      const t = new Date(1700000000000 + i * 10000);
      await utimes(p, t, t);
      written.push(p);
    }

    // Trigger one more dump with ascending timestamp to enforce rolling eviction against pinned mtimes
    const pLast = await dumpAuditRejection({
      storageRoot: root,
      sessionId: 'sess-roll',
      compactionId: 'roll-final',
      target: 'p/m',
      attempt: 1,
      code: 'CONSTRAINT_LOST',
      message: 'item final',
      modelRawText: 'MF-' + 'Summary text chunk. '.repeat(100),
      report: { checked: 1, polarityFlips: 0, worstCoverage: 0.2, lost: [{ seq: 6, reason: 'coverage', coverage: 0.2, line: 'Rule 6' }] },
      maxFiles: 40,
      maxFileBytes: 4096,
      maxTotalBytes: 6000,
    });
    assert.ok(pLast);

    const remainingNames = (await readdir(rejectDir)).filter((n) => n.endsWith('.json'));
    let remainingBytes = 0;
    for (const name of remainingNames) {
      remainingBytes += (await stat(join(rejectDir, name))).size;
    }
    assert.ok(remainingNames.length >= 1 && remainingNames.length < 7, `expected oldest files evicted, kept ${remainingNames.length}`);
    assert.ok(remainingBytes <= 6000, `expected total bytes <= 6000, got ${remainingBytes}`);
    assert.ok(remainingNames.some((n) => n.includes('roll-final')), 'newest file must be retained');
    assert.equal(remainingNames.some((n) => n.includes('roll-0')), false, 'oldest file roll-0 must be evicted');

    // 3. Unwritable path never throws
    const blockedPath = join(root, 'not-a-dir');
    await writeFile(blockedPath, 'x');
    assert.equal(
      await dumpAuditRejection({
        storageRoot: blockedPath,
        sessionId: 's',
        compactionId: 'c',
        code: 'X',
      }),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
console.log(JSON.stringify({ passed, failed, results }, null, 2));
if (failed > 0) process.exitCode = 1;
