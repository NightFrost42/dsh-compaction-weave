import assert from 'node:assert/strict';

import { auditCompaction, conditionParts } from '../lib/audit.js';
import { buildCompactionInstruction } from '../lib/prompt.js';

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

const SEQ_1808_TEXT = '如果是在我审阅过程中有过修改，你进行修改的时候也一并把我的修改提交';
const SEQ_2301_TEXT =
  '在每章我审阅完毕之后，需要你总结这章我手动修改的部分，然后分析是否有需要归纳到 翻译文风笔记 中的内容。';
const SEQ_2725_TEXT =
  '当我说某一章审核完毕的时候，需要你总结这章我手动修改的部分，然后分析是否有需要归纳到 翻译文风笔记 中的内容，然后通知我。';

// ── 1. Issue #12 all 5 prefix / quote / bold repro cases + multi-quote safety ──
await test('issue12-conditional-prefix-seq-quote-bold-variants', () => {
  const users = [{ seq: 1808, text: SEQ_1808_TEXT, sourceKind: 'user' }];
  const cases = {
    'A-bare-bullet': `- ${SEQ_1808_TEXT}`,
    'B-bracket-seq': `- [seq 1808] ${SEQ_1808_TEXT}`,
    'C-paren-seq': `- （seq 1808）${SEQ_1808_TEXT}`,
    'D-quote-plus-seq': `- [seq 1808]「${SEQ_1808_TEXT}」`,
    'E-bold-keyword': `- **如果**是在我审阅过程中有过修改，你进行修改的时候也一并把我的修改提交`,
    'F-nested-bold-quote': `- [seq 1808] **「${SEQ_1808_TEXT}」**`,
    'G-english-numbered-bold': null,
  };

  for (const [name, summary] of Object.entries(cases)) {
    if (!summary) continue;
    assert.ok(conditionParts(summary), `conditionParts must recognize ${name}: ${summary}`);
    const rRaw = auditCompaction({
      userMessages: users,
      summaryText: summary,
      checkpointText: summary,
      threshold: 0.6,
    });
    assert.equal(rRaw.lost.length, 0, `${name} (raw) failed: ${JSON.stringify(rRaw.lost)}`);

    const rSectioned = auditCompaction({
      userMessages: users,
      summaryText: makeEnSummary(summary),
      checkpointText: makeEnSummary(summary),
      threshold: 0.6,
    });
    assert.equal(rSectioned.lost.length, 0, `${name} (sectioned) failed: ${JSON.stringify(rSectioned.lost)}`);
  }

  // English list prefix + seq citation + bold keyword
  const enSrc = [{ seq: 1808, text: 'If staging fails, stop deployment immediately.', sourceKind: 'user' }];
  const enSummary = '1. [seq 1808] **If** staging fails, stop deployment immediately.';
  assert.ok(conditionParts(enSummary));
  const rEn = auditCompaction({
    userMessages: enSrc,
    summaryText: makeEnSummary(enSummary),
    checkpointText: makeEnSummary(enSummary),
    threshold: 0.6,
  });
  assert.equal(rEn.lost.length, 0, `G-english-numbered-bold failed: ${JSON.stringify(rEn.lost)}`);

  // Multi-quote line must NOT merge quotes or let the 1st conditional swallow the 2nd rule
  const multiQuote = '「如果报告提到它，不要写库」「不要删除 backups」';
  assert.equal(conditionParts(multiQuote), null, 'multi-quote line must split cleanly rather than unwrap end-to-end');
  const multiUsers = [
    { seq: 1, text: '如果报告提到它，不要写库。', sourceKind: 'user' },
    { seq: 2, text: '不要删除 backups。', sourceKind: 'user' },
  ];
  const rMultiPass = auditCompaction({
    userMessages: multiUsers,
    summaryText: makeEnSummary(multiQuote),
    checkpointText: makeEnSummary(multiQuote),
    threshold: 0.6,
  });
  assert.equal(rMultiPass.lost.length, 0, `multi-quote pass failed: ${JSON.stringify(rMultiPass.lost)}`);

  const rMultiBadSecond = auditCompaction({
    userMessages: multiUsers,
    summaryText: makeEnSummary('「如果报告提到它，不要写库」「允许删除 backups」'),
    checkpointText: makeEnSummary('「如果报告提到它，不要写库」「允许删除 backups」'),
    threshold: 0.6,
    includeAllConflicts: true,
  });
  assert.ok(
    rMultiBadSecond.lost.some((item) => item.seq === 2 && item.reason === 'polarity'),
    `reversing second quote must still block: ${JSON.stringify(rMultiBadSecond.lost)}`,
  );

  // Dropping the condition on seq 1808 must STILL reject with reason='condition'
  const rDropped = auditCompaction({
    userMessages: users,
    summaryText: makeEnSummary('- [seq 1808]「你进行修改的时候也一并把我的修改提交」'),
    checkpointText: makeEnSummary('- [seq 1808]「你进行修改的时候也一并把我的修改提交」'),
    threshold: 0.6,
  });
  assert.ok(
    rDropped.lost.some((item) => item.seq === 1808 && item.reason === 'condition'),
    `dropped condition must still reject: ${JSON.stringify(rDropped.lost)}`,
  );
});

// ── 2. Temporal conditional triggers & past-narrative false-positive guard ───────
await test('issue12-temporal-conditionals-and-past-narrative-guard', () => {
  const temporalRules = [
    [2301, SEQ_2301_TEXT, '需要你总结这章我手动修改的部分，然后分析是否有需要归纳到 翻译文风笔记 中的内容。'],
    [2401, '在构建完成后，不要自动推送。', '不要自动推送。'],
    [2402, '在发布之前，必须跑完测试。', '必须跑完测试。'],
    [2403, '每当某章审核完毕时，需要通知我。', '需要通知我。'],
    [2404, '一旦检测到异常，立即停止部署。', '立即停止部署。'],
    [2405, '等测试通过后，再合并 PR。', '再合并 PR。'],
    [2406, '等到你确认的时候，再推送。', '再推送。'],
  ];

  for (const [seq, text, droppedTail] of temporalRules) {
    assert.ok(conditionParts(text), `conditionParts must match temporal rule seq=${seq}: ${text}`);
    const quoted = `- [seq ${seq}]「${text}」`;
    assert.ok(conditionParts(quoted), `conditionParts must match prefixed temporal rule seq=${seq}`);
    const ok = auditCompaction({
      userMessages: [{ seq, text, sourceKind: 'user' }],
      summaryText: makeEnSummary(quoted),
      checkpointText: makeEnSummary(quoted),
      threshold: 0.6,
    });
    assert.equal(ok.lost.length, 0, `temporal rule seq=${seq} failed: ${JSON.stringify(ok.lost)}`);

    const missingTrigger = `- [seq ${seq}]「${droppedTail}」`;
    const bad = auditCompaction({
      userMessages: [{ seq, text, sourceKind: 'user' }],
      summaryText: makeEnSummary(missingTrigger),
      checkpointText: makeEnSummary(missingTrigger),
      threshold: 0.6,
    });
    assert.ok(
      bad.lost.some((item) => item.seq === seq && item.reason === 'condition'),
      `dropped temporal condition seq=${seq} must reject: ${JSON.stringify(bad.lost)}`,
    );
  }

  // Changing 在发布之前 -> 在发布之后 must NOT silently lose 之前/之后 distinction
  const beforeVsAfter = auditCompaction({
    userMessages: [{ seq: 2402, text: '在发布之前，必须跑完测试。', sourceKind: 'user' }],
    summaryText: makeEnSummary('- [seq 2402]「在发布之后，必须跑完测试。」'),
    checkpointText: makeEnSummary('- [seq 2402]「在发布之后，必须跑完测试。」'),
    threshold: 0.6,
  });
  assert.ok(
    beforeVsAfter.lost.some((item) => item.seq === 2402 && item.reason === 'condition'),
    `flipping 之前 to 之后 must reject: ${JSON.stringify(beforeVsAfter.lost)}`,
  );

  // Past-narrative time must NOT be treated as a conditional prerequisite
  const pastNarratives = [
    [2501, '昨天部署失败之后，请保留原始日志。', '请保留原始日志。'],
    [2502, '在刚才重启之后，必须检查端口。', '必须检查端口。'],
    [2503, '上次发版完毕后，不要修改线上表。', '不要修改线上表。'],
    [2504, '当昨天测试失败时，不要删库。', '不要删库。'],
  ];
  for (const [seq, text, cleanSummary] of pastNarratives) {
    assert.equal(conditionParts(text), null, `past narrative must not trigger conditionParts: ${text}`);
    const r = auditCompaction({
      userMessages: [{ seq, text, sourceKind: 'user' }],
      summaryText: makeEnSummary(`- [seq ${seq}] ${cleanSummary}`),
      checkpointText: makeEnSummary(`- [seq ${seq}] ${cleanSummary}`),
      threshold: 0.6,
    });
    assert.equal(
      r.lost.some((item) => item.reason === 'condition'),
      false,
      `past narrative seq=${seq} must not emit false condition loss: ${JSON.stringify(r.lost)}`,
    );
  }
});

// ── 3. Near-duplicate rules seq 2301 + seq 2725 peer attribution & negative controls ──
await test('issue12-near-duplicate-rules-2301-2725-no-bleed-and-strict-missing-detection', () => {
  const m2301 = { seq: 2301, text: SEQ_2301_TEXT, sourceKind: 'user' };
  const m2725 = { seq: 2725, text: SEQ_2725_TEXT, sourceKind: 'user' };
  const q2301 = `- [seq 2301]「${SEQ_2301_TEXT}」`;
  const q2725 = `- [seq 2725]「${SEQ_2725_TEXT}」`;

  // Positive A: both retained with [seq N]「…」 quotes -> PASS with 0 lost
  const bothWithSeq = `${q2301}\n${q2725}`;
  const rBothSeq = auditCompaction({
    userMessages: [m2301, m2725],
    summaryText: bothWithSeq,
    checkpointText: bothWithSeq,
    threshold: 0.6,
  });
  assert.equal(rBothSeq.lost.length, 0, `both with seq failed: ${JSON.stringify(rBothSeq.lost)}`);

  const rBothSeqSectioned = auditCompaction({
    userMessages: [m2301, m2725],
    summaryText: makeEnSummary(bothWithSeq),
    checkpointText: makeEnSummary(bothWithSeq),
    threshold: 0.6,
  });
  assert.equal(rBothSeqSectioned.lost.length, 0, `both with seq sectioned failed: ${JSON.stringify(rBothSeqSectioned.lost)}`);

  // Positive B: both retained WITHOUT [seq N] prefixes (tests forwardBetter/reverseBetter without seq tie-breaker)
  const bothPlain = `- ${SEQ_2301_TEXT}\n- ${SEQ_2725_TEXT}`;
  const rBothPlain = auditCompaction({
    userMessages: [m2301, m2725],
    summaryText: makeEnSummary(bothPlain),
    checkpointText: makeEnSummary(bothPlain),
    threshold: 0.6,
  });
  assert.equal(rBothPlain.lost.length, 0, `both plain failed: ${JSON.stringify(rBothPlain.lost)}`);

  // Negative 1: ONLY seq 2301 kept, seq 2725 (incl. 然后通知我) omitted -> MUST catch seq 2725!
  const rMissing2725 = auditCompaction({
    userMessages: [m2301, m2725],
    summaryText: makeEnSummary(q2301),
    checkpointText: makeEnSummary(q2301),
    threshold: 0.6,
  });
  assert.ok(
    rMissing2725.lost.some((item) => item.seq === 2725),
    `dropping seq 2725 must fail audit even when near-duplicate seq 2301 is kept: ${JSON.stringify(rMissing2725.lost)}`,
  );

  // Even when verbatim Section 6 checkpoint preserves m2725, summary omitting 2725 must still catch it!
  const rMissing2725InSummaryOnly = auditCompaction({
    userMessages: [m2301, m2725],
    summaryText: makeEnSummary(q2301),
    checkpointText: `${makeEnSummary(q2301)}\n\n## 6. Recent User Messages (Verbatim)\n> seq 2301: ${SEQ_2301_TEXT}\n> seq 2725: ${SEQ_2725_TEXT}`,
    threshold: 0.6,
  });
  assert.ok(
    rMissing2725InSummaryOnly.lost.some((item) => item.seq === 2725),
    `omitting 2725 from summary prose must still fail even if Section 6 has verbatim text: ${JSON.stringify(rMissing2725InSummaryOnly.lost)}`,
  );

  // Negative 2: ONLY seq 2725 kept, seq 2301 omitted -> MUST catch seq 2301!
  const rMissing2301 = auditCompaction({
    userMessages: [m2301, m2725],
    summaryText: makeEnSummary(q2725),
    checkpointText: makeEnSummary(q2725),
    threshold: 0.6,
  });
  assert.ok(
    rMissing2301.lost.some((item) => item.seq === 2301),
    `dropping seq 2301 must fail audit even when near-duplicate seq 2725 is kept: ${JSON.stringify(rMissing2301.lost)}`,
  );

  // Negative 3: seq 2301 kept verbatim, seq 2725 loses its trigger or turns into non-notification polarity
  const droppedTrigger2725 = `${q2301}\n- [seq 2725] 需要你总结这章我手动修改的部分，然后分析是否有需要归纳到 翻译文风笔记 中的内容，然后通知我。`;
  const rBad2725 = auditCompaction({
    userMessages: [m2301, m2725],
    summaryText: makeEnSummary(droppedTrigger2725),
    checkpointText: makeEnSummary(droppedTrigger2725),
    threshold: 0.6,
  });
  assert.ok(
    rBad2725.lost.some((item) => item.seq === 2725 && item.reason === 'condition'),
    `dropped trigger on seq 2725 must still catch seq 2725: ${JSON.stringify(rBad2725.lost)}`,
  );
});

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
console.log(JSON.stringify({ passed, failed, results }, null, 2));
if (failed > 0) process.exitCode = 1;
