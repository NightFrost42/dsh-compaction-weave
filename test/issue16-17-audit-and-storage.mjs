import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  auditCompaction,
  extractConstraintLines,
  negationsOf,
  scalarRequirement,
  sourceConstraintEvidence,
} from '../lib/audit.js';
import { dumpAuditRejection } from '../lib/audit-reject.js';
import { CompactionArchive } from '../lib/history.js';
import { CompactionJournal } from '../lib/journal.js';
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

function makeSummary(body = 'Preserved details.') {
  return EN_HEADINGS.map((h, i) => `${h}\n${i === 5 ? '[filled by engine]' : body}`).join('\n\n');
}

// ────────────────────────────────────────────────── 1. Issue #17: Bare isolated modal exemption

await test('issue17-bare-isolated-modals-skip-polarity-while-real-negations-and-actions-block', () => {
  // Original Issue #17 reproducer: isolated bare modal "需要" vs "装完开开关即用，不需要重启"
  const origReport = auditCompaction({
    userMessages: [{ seq: 1, text: '需要' }],
    summaryText: makeSummary('装完开开关即用，不需要重启'),
  });
  assert.equal(origReport.polarityFlips, 0);
  assert.equal(origReport.lost.filter((x) => x.reason === 'polarity').length, 0);
  assert.equal(origReport.lost.length, 0);

  // Other bare isolated CN / EN modals without action objects or negation also skip polarity
  for (const bareModal of ['需要。', '必须', '请务必', '只能', '一定要', '务必注意', 'must.', 'need', 'please']) {
    const r = auditCompaction({
      userMessages: [{ seq: 1, text: bareModal }],
      summaryText: makeSummary(`${bareModal.replace(/[。.!！]/g, '')} 暂不需要重启`),
    });
    assert.equal(r.polarityFlips, 0, `expected zero polarity flips for bare modal "${bareModal}"`);
    assert.equal(r.lost.filter((x) => x.reason === 'polarity').length, 0);
  }

  // Coverage is still enforced when an isolated modal is completely omitted
  const omitted = auditCompaction({
    userMessages: [{ seq: 1, text: '必须' }],
    summaryText: makeSummary('完全无关的内容'),
  });
  assert.ok(omitted.lost.some((x) => x.reason === 'coverage'));

  // Negative controls: real short negations & object-bearing modals MUST still block on polarity
  const strictBlocks = [
    ['别重启', '需要重启'],
    ['不要重启', '重启'],
    ['需要重启这个模块', '不要重启这个模块'],
    ['不要重启这个模块', '需要重启这个模块'],
    ['请重启', '不要重启'],
  ];
  for (const [src, cand] of strictBlocks) {
    const r = auditCompaction({
      userMessages: [{ seq: 1, text: src }],
      summaryText: makeSummary(cand),
    });
    assert.ok(r.polarityFlips >= 1, `expected polarity block for "${src}" vs "${cand}"`);
    assert.ok(
      r.lost.some((x) => x.reason === 'polarity'),
      `expected reason=polarity for "${src}" vs "${cand}"`,
    );
  }
});

// ────────────────────────────────────────────────── 2. Issue #16 A0: 避免 / 杜绝 / 免于 & guards

await test('issue16-a0-avoid-ban-free-from-polarity-and-double-negation-purpose-guards', () => {
  // Positive polarity blocks
  const positives = [
    ['请避免删除生产数据。', '删除生产数据。'],
    ['避免修改线上配置。', '修改线上配置。'],
    ['杜绝修改线上配置。', '修改线上配置。'],
    ['免于重启服务。', '重启服务。'],
  ];
  for (const [src, cand] of positives) {
    assert.ok(extractConstraintLines(src).length > 0, `expected constraint extraction for "${src}"`);
    assert.ok(negationsOf(src).length > 0, `expected negation extraction for "${src}"`);
    const r = auditCompaction({
      userMessages: [{ seq: 1, text: src }],
      summaryText: makeSummary(cand),
    });
    assert.ok(r.polarityFlips >= 1, `expected polarityFlips >= 1 for "${src}" vs "${cand}"`);
    assert.ok(
      r.lost.some((x) => x.reason === 'polarity'),
      `expected reason=polarity for "${src}" vs "${cand}"`,
    );
  }

  // Purpose adverbials ("为了避免...", "为避免...", "以避免...") must NOT mark affirmative main clauses negative
  assert.deepEqual(negationsOf('为了避免死锁，必须加锁。'), []);
  assert.deepEqual(negationsOf('为避免冲突，请重启服务。'), []);
  assert.deepEqual(negationsOf('必须加锁，以避免死锁。'), []);
  assert.deepEqual(negationsOf('为了杜绝事故，务必检查配置。'), []);

  // Purpose adverbials pass when faithfully preserved
  for (const [src, cand] of [
    ['为了避免死锁，必须加锁。', '为了避免死锁，必须加锁。'],
    ['为避免冲突，请重启服务。', '为避免冲突，请重启服务。'],
    ['必须加锁，以避免死锁。', '必须加锁，以避免死锁。'],
  ]) {
    const r = auditCompaction({
      userMessages: [{ seq: 1, text: src }],
      summaryText: makeSummary(cand),
    });
    assert.equal(r.lost.length, 0, `expected faithful purpose clause to pass for "${src}"`);
  }

  // Flipping the main clause polarity under a purpose adverbial MUST trigger polarity
  for (const [src, badCand] of [
    ['为了避免死锁，必须加锁。', '不要加锁。'],
    ['为了避免死锁，必须加锁。', '为了避免死锁，不要加锁。'],
    ['为避免冲突，请重启服务。', '不要重启服务。'],
    ['必须加锁，以避免死锁。', '不要加锁。'],
    ['为了避免死锁，不要重复加锁。', '为了避免死锁，必须重复加锁。'],
  ]) {
    const r = auditCompaction({
      userMessages: [{ seq: 1, text: src }],
      summaryText: makeSummary(badCand),
    });
    assert.ok(
      r.lost.some((x) => x.reason === 'polarity'),
      `expected reason=polarity for "${src}" vs "${badCand}"`,
    );
  }

  // Double negations ("不可避免", "难以避免", "无法避免", "避免不了") stay affirmative
  for (const [src, badCand] of [
    ['不可避免需要重启。', '无需重启。'],
    ['难以避免需要重启。', '无需重启。'],
    ['无法避免必须重启。', '无需重启。'],
    ['避免不了需要重启。', '无需重启。'],
  ]) {
    assert.deepEqual(negationsOf(src), [], `expected affirmative polarity for "${src}"`);
    const passSame = auditCompaction({
      userMessages: [{ seq: 1, text: src }],
      summaryText: makeSummary(src),
    });
    assert.equal(passSame.lost.length, 0, `expected faithful preservation for "${src}"`);

    const rFlip = auditCompaction({
      userMessages: [{ seq: 1, text: src }],
      summaryText: makeSummary(badCand),
    });
    assert.ok(
      rFlip.lost.some((x) => x.reason === 'polarity'),
      `expected reason=polarity for "${src}" vs "${badCand}"`,
    );
  }

  // Compound contrast with both "不可避免" and an independent real negation must keep the real negation
  assert.deepEqual(negationsOf('虽然停机不可避免，但不要删除生产数据。'), ['不要']);
  const mixedFlip = auditCompaction({
    userMessages: [{ seq: 1, text: '虽然停机不可避免，但不要删除生产数据。' }],
    summaryText: makeSummary('虽然停机不可避免，但直接删除生产数据。'),
  });
  assert.ok(mixedFlip.lost.some((x) => x.reason === 'polarity'));

  // Non-instructional idioms using 避免 must still not be over-extracted as instructions
  for (const adj of ['不可避免的延迟', '难以避免的损耗', '为了避免误解']) {
    assert.deepEqual(extractConstraintLines(adj), [], `expected no instruction extracted for "${adj}"`);
  }
});

// ────────────────────────────────────────────────── 3. Issue #16 A3: Duration units & Chinese date/ordinal exclusion

await test('issue16-a3-duration-units-years-months-weeks-and-date-ordinal-exclusions', () => {
  // Duration unit mismatches must be blocked with reason='value'
  const mismatches = [
    ['保留 3 年日志。', '保留 3 个月日志。'],
    ['保留 2 周日志。', '保留 2 天日志。'],
    ['保留 6 个月审计记录。', '保留 6 分钟审计记录。'],
    ['Keep logs for 3 years.', 'Keep logs for 3 months.'],
    ['Retain audit logs for 4 weeks.', 'Retain audit logs for 4 days.'],
  ];
  for (const [src, badCand] of mismatches) {
    const r = auditCompaction({
      userMessages: [{ seq: 1, text: src }],
      summaryText: makeSummary(badCand),
    });
    assert.ok(
      r.lost.some((x) => x.reason === 'value'),
      `expected reason=value for "${src}" vs "${badCand}", got ${JSON.stringify(r.lost)}`,
    );
  }

  // Unit synonyms pass cleanly
  const synonyms = [
    ['保留 2 星期日志。', '保留 2 周日志。'],
    ['Keep logs for 3 years.', 'Keep logs for 3 yrs.'],
    ['Keep logs for 6 months.', 'Keep logs for 6 months.'],
  ];
  for (const [src, okCand] of synonyms) {
    const r = auditCompaction({
      userMessages: [{ seq: 1, text: src }],
      summaryText: makeSummary(okCand),
    });
    assert.equal(r.lost.length, 0, `expected unit synonym match for "${src}" vs "${okCand}"`);
  }

  // Chinese calendar dates and time ordinals must NOT be extracted as quantity requirements
  const narrativeDates = [
    '2026年3月1日发生过一次重启。',
    '2026年11月23日上线完成。',
    '2026年3月完成迁移。',
    '11月23日排查结束。',
    '2026年重构模块。',
    '第2年复盘，第3周上线。',
    '第1个月观察期结束。',
  ];
  for (const line of narrativeDates) {
    assert.deepEqual(extractConstraintLines(line), [], `expected extractConstraintLines=[] for "${line}"`);
    assert.deepEqual(sourceConstraintEvidence(line), [], `expected sourceConstraintEvidence=[] for "${line}"`);
    assert.equal(scalarRequirement(line), null, `expected scalarRequirement=null for "${line}"`);
    const r = auditCompaction({
      userMessages: [{ seq: 1, text: line }],
      summaryText: makeSummary('历史上有过重启。'),
    });
    assert.equal(r.checked, 0, `expected checked=0 for narrative "${line}"`);
    assert.equal(r.lost.length, 0, `expected lost=[] for narrative "${line}"`);
  }

  // Generic scalar ordinals (non-time) still parse as scalarRequirement when explicit (=)
  assert.notEqual(scalarRequirement('第 0 段 = 0'), null);

  // Ambiguous excluded units (bare 月, 行, 台, 人) must NOT trigger numeric requirement cue extraction
  for (const narrative of ['3月完成了灰度。', '第 10 行记录了异常。', '3 台机器已扩容。', '5 个人参与评审。']) {
    assert.deepEqual(sourceConstraintEvidence(narrative), [], `expected excluded unit not extracted: "${narrative}"`);
  }
});

// ────────────────────────────────────────────────── 4. Issue #16 S1/S2 & H2: File modes & best-effort dir fsync

await test('issue16-s1-s2-h2-storage-modes-and-archive-dir-fsync', async () => {
  const root = await mkdtemp(join(process.env.WEAVE_TEST_ROOT ?? tmpdir(), 'weave-issue16-storage-'));
  try {
    // S1: audit-reject
    const rejectFile = await dumpAuditRejection({
      storageRoot: root,
      sessionId: 'sess-issue16-perm',
      compactionId: 'cmp-perm-1',
      code: 'CONSTRAINT_LOST',
      message: 'test reject record',
      modelRawText: 'raw candidate',
      auditedText: 'audited text',
      report: { kind: 'requirements', checked: 1, polarityFlips: 0, worstCoverage: 0, lost: [] },
      userMessages: [{ seq: 1, text: 'Keep rule A.' }],
    });
    assert.ok(rejectFile && rejectFile.endsWith('.json'));
    const rejectDir = dirname(rejectFile);

    // S2: journal async & sync
    const journal = new CompactionJournal({ root: join(root, 'journal') });
    const jAsyncFile = await journal.record({
      sessionId: 'sess-issue16-perm',
      compactionId: 'cmp-async-1',
      phase: 'started',
      startSeq: 0,
      endSeq: 5,
    });
    const jSyncFile = journal.recordSync({
      sessionId: 'sess-issue16-perm',
      compactionId: 'cmp-sync-1',
      phase: 'committing',
      startSeq: 0,
      endSeq: 5,
    });

    // H2: archive writeSpan + readSpan roundtrip (best-effort dir fsync never fails on Windows or POSIX)
    const archive = new CompactionArchive({ root: join(root, 'sessions') });
    const spanFile = await archive.writeSpan({
      sessionId: 'sess-issue16-perm',
      compactionId: 'cmp-span-1',
      entries: [
        { seq: 1, type: 'user/message', role: 'user', text: 'Preserve logs for 3 years.' },
      ],
    });
    assert.ok(spanFile && spanFile.endsWith('.jsonl.zstd'));
    const readBack = await archive.readSpan('sess-issue16-perm', 'cmp-span-1');
    assert.equal(readBack.ok, true);
    assert.equal(readBack.entries.length, 1);

    // On POSIX, verify actual on-disk 0o700 dirs and 0o600 files
    if (process.platform !== 'win32') {
      assert.equal((await stat(rejectDir)).mode & 0o777, 0o700);
      assert.equal((await stat(rejectFile)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(jAsyncFile))).mode & 0o777, 0o700);
      assert.equal((await stat(jAsyncFile)).mode & 0o777, 0o600);
      assert.equal((await stat(jSyncFile)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(spanFile))).mode & 0o777, 0o700);
      assert.equal((await stat(spanFile)).mode & 0o777, 0o600);
    }

    // Also assert source-level mode arguments across Windows & POSIX CI
    const [auditRejectSrc, journalSrc, historySrc] = await Promise.all([
      readFile(new URL('../lib/audit-reject.js', import.meta.url), 'utf8'),
      readFile(new URL('../lib/journal.js', import.meta.url), 'utf8'),
      readFile(new URL('../lib/history.js', import.meta.url), 'utf8'),
    ]);
    assert.match(auditRejectSrc, /mkdir\(dir,\s*\{\s*recursive:\s*true,\s*mode:\s*0o700\s*\}\)/);
    assert.match(auditRejectSrc, /writeFile\(file,\s*jsonText,\s*\{\s*encoding:\s*'utf8',\s*mode:\s*0o600\s*\}\)/);
    assert.match(journalSrc, /mkdir\(dir,\s*\{\s*recursive:\s*true,\s*mode:\s*0o700\s*\}\)/);
    assert.match(journalSrc, /open\(temp,\s*'wx',\s*0o600\)/);
    assert.match(journalSrc, /mkdirSync\(dirname\(file\),\s*\{\s*recursive:\s*true,\s*mode:\s*0o700\s*\}\)/);
    assert.match(journalSrc, /openSync\(temp,\s*'wx',\s*0o600\)/);
    assert.match(historySrc, /syncDirBestEffort/);
    assert.match(historySrc, /handle\.sync\(\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log(
  JSON.stringify(
    {
      passed: results.filter((r) => r.pass).length,
      failed: results.filter((r) => !r.pass).length,
      results,
    },
    null,
    2,
  ),
);
if (results.some((r) => !r.pass)) process.exitCode = 1;
