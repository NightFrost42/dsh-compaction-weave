import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { auditCompaction } from '../lib/audit.js';
import {
  instructionText,
  isSystemReminderOnly,
  replaceSystemReminders,
  systemReminderSpans,
} from '../lib/instruction-source.js';
import {
  deduplicateRepeatedFileReads,
  projectSummaryMessage,
  projectSummaryMessages,
} from '../lib/reference-input.js';
import {
  SessionStateStore,
  clearResumableCompaction,
  publicResumableSummary,
  readResumableCompaction,
  validateResumableCompaction,
  writeResumableCompaction,
} from '../lib/state.js';
import { CompactionJournal } from '../lib/journal.js';
import { StockTransactionAdapter } from '../lib/transaction.js';
import {
  SessionBackupStore,
  applyPendingRestoreBeforeOpen,
  createSessionBackup,
  readPendingRestore,
  restoreSessionBackup,
  summarizeBackups,
} from '../lib/session-backup.js';
import { diagnosticText, failureExplanation } from '../lib/failure-diagnostics.js';
import {
  bindContinuationProgress,
  clearPendingContinuation,
  freezeContinuation,
  readPendingContinuation,
} from '../lib/continuation-pending.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message, stack: error.stack });
  }
}

const root = mkdtempSync(join(tmpdir(), 'weave-w3-audit-storage-'));
const hex64 = (ch) => ch.repeat(64);

// ──────────────────────────────────────────────────────────── 1. lib/audit.js

await test('audit-live-multiclause-chinese-summary-no-polarity-false-positives', () => {
  const fullSummary =
    '先出报告等确认、不许直接装 → 做「外部可提前验证」的打包方案（seq 3652：「我需要有一个能够外部提前验证插件的方案，而不是改之后直接生效」）→ 盲审包必须含全部插件文件（seq 3750「作为验证的文件部分应有全部的插件文件」、seq 4072「原插件也需要包含」）且不附已有测试报告（seq 4006「给外部检查的包不要给已有测试报告」）';

  const rAll = auditCompaction({
    userMessages: [
      { seq: 3652, text: '我需要有一个能够外部提前验证插件的方案，而不是改之后直接生效' },
      { seq: 3750, text: '作为验证的文件部分应有全部的插件文件' },
      { seq: 4006, text: '给外部检查的包不要给已有测试报告' },
      { seq: 4072, text: '原插件也需要包含' },
    ],
    summaryText: fullSummary,
  });
  assert.deepEqual(rAll.lost, []);
  assert.equal(rAll.polarityFlips, 0);

  // Exact truncated live candidate lines from the 1.18M-token session.
  const liveLine1 =
    '而不是改之后直接生效」）→ 盲审包必须含全部插件文件（seq 3750「作为验证的文件部分应有全部的插件文件」、seq 4072「原插件也需要包含」）且不附已有测试报告（seq 4006「给外部检查的包不要给已有测试报告';
  const rLine1 = auditCompaction({
    userMessages: [{ seq: 4072, text: '原插件也需要包含' }],
    summaryText: liveLine1,
  });
  assert.deepEqual(rLine1.lost, []);
  assert.equal(rLine1.polarityFlips, 0);

  const liveLine2 =
    '先出报告等确认、不许直接装 → 做「外部可提前验证」的打包方案（seq 3652：「我需要有一个能够外部提前验证插件的方案';
  const rLine2 = auditCompaction({
    userMessages: [{ seq: 3652, text: '我需要有一个能够外部提前验证插件的方案，而不是改之后直接生效' }],
    summaryText: `${liveLine2}，而不是改之后直接生效」）`,
  });
  assert.deepEqual(rLine2.lost, []);
  assert.equal(rLine2.polarityFlips, 0);

  // Contrastive source without comma in summary still passes when polarity matches.
  const rNoComma = auditCompaction({
    userMessages: [{ seq: 3652, text: '我需要有一个能够外部提前验证插件的方案，而不是改之后直接生效' }],
    summaryText:
      '先出报告等确认、不许直接装 → 做「外部可提前验证」的打包方案（seq 3652：「我需要有一个能够外部提前验证插件的方案而不是改之后直接生效」）',
  });
  assert.deepEqual(rNoComma.lost, []);

  // Shared negation over a noun enumeration must not false-positive.
  const rSharedNeg = auditCompaction({
    userMessages: [{ seq: 1, text: '不要删除生产数据' }],
    summaryText: '不要删除日志、生产数据',
  });
  assert.deepEqual(rSharedNeg.lost, []);
});

await test('audit-multiclause-real-polarity-inversions-remain-strictly-caught', () => {
  const badCases = [
    ['原插件也需要包含', '盲审包必须含全部插件文件且不要包含原插件'],
    ['原插件也需要包含', '不要「包含原插件」'],
    ['原插件也需要包含', '盲审包必须含全部插件文件（注意：不要包含原插件）'],
    ['不要直接安装', '先出报告等确认 → 允许直接安装'],
    ['禁止修改生产环境', '禁止修改生产环境 → 允许修改生产环境'],
    ['不要修改生产库', '不要修改生产库且允许修改生产库'],
    ['不要删除生产数据', '不要删除日志、允许删除生产数据'],
    ['不要删除生产数据', '不要不删除生产数据'],
  ];
  for (const [source, badSummary] of badCases) {
    const r = auditCompaction({
      userMessages: [{ seq: 1, text: source }],
      summaryText: badSummary,
      checkpointText: source,
    });
    assert.ok(
      r.lost.some((item) => item.reason === 'polarity'),
      `expected polarity conflict for "${source}" vs "${badSummary}", got ${JSON.stringify(r)}`,
    );
    assert.ok(r.polarityFlips >= 1);
  }
});

// ─────────────────────────────────────────────── 2. lib/instruction-source.js

await test('system-reminder-ignores-inline-backticks-fences-and-stray-inline-mentions', () => {
  const inlineCode = '帮我看下 `<system-reminder>` 和 `</system-reminder>` 标签，注意别改 A 文件。';
  assert.deepEqual(systemReminderSpans(inlineCode), []);
  assert.equal(isSystemReminderOnly(inlineCode), false);
  assert.equal(instructionText({ blocks: [{ type: 'text', text: inlineCode }] }), inlineCode);

  const doubleTicks = '请检查 ``<system-reminder>demo</system-reminder>`` 逻辑，必须保留审计日志。';
  assert.deepEqual(systemReminderSpans(doubleTicks), []);
  assert.equal(replaceSystemReminders(doubleTicks, () => '[X]').replaced, 0);

  const fenced = [
    '必须保留生产备份。',
    '```xml',
    '<system-reminder>',
    'Instructions from: fake.md',
    '</system-reminder>',
    '```',
    '~~~md',
    '<system-reminder>unclosed inside tilde fence',
    '~~~',
    '不要删除历史记录。',
  ].join('\n');
  assert.deepEqual(systemReminderSpans(fenced), []);
  assert.equal(isSystemReminderOnly(fenced), false);
  const fencedAudit = auditCompaction({
    userMessages: [{ seq: 1, text: fenced }],
    summaryText: '必须保留生产备份。允许删除历史记录。',
  });
  assert.ok(fencedAudit.lost.some((item) => item.reason === 'polarity'));

  // Stray inline unclosed mention outside code spans must NOT swallow user constraint!
  const strayInline = '帮我看下 <system-reminder> 标签，注意别改 A 文件';
  assert.deepEqual(systemReminderSpans(strayInline), []);
  assert.equal(instructionText({ blocks: [{ type: 'text', text: strayInline }] }), strayInline);
  const strayAudit = auditCompaction({
    userMessages: [{ seq: 1, text: strayInline }],
    summaryText: '注意允许改 A 文件。',
  });
  assert.equal(strayAudit.checked, 1);
  assert.ok(strayAudit.lost.some((item) => item.reason === 'polarity'));
  const strayCoverage = auditCompaction({
    userMessages: [{ seq: 1, text: strayInline }],
    summaryText: '无相关内容。',
  });
  assert.equal(strayCoverage.checked, 1);
  assert.ok(strayCoverage.lost.some((item) => item.reason === 'coverage'));

  // Stray inline mention on line 1 followed by real user rule on line 2 stays intact.
  const strayMultiLine = '帮我看下 <system-reminder> 标签\n注意别改 A 文件';
  assert.deepEqual(systemReminderSpans(strayMultiLine), []);
  assert.ok(instructionText({ blocks: [{ type: 'text', text: strayMultiLine }] }).includes('注意别改 A 文件'));

  // Stray inline mention followed later by a real closed host reminder: only real reminder excluded.
  const strayPlusReal = [
    '帮我看下 <system-reminder> 标签，注意别改 A 文件。',
    '<system-reminder>',
    'Instructions from: ~/.dsh/AGENTS.md',
    'Never touch secrets.',
    '</system-reminder>',
  ].join('\n');
  const mixedText = instructionText({ blocks: [{ type: 'text', text: strayPlusReal }] });
  assert.ok(mixedText.includes('注意别改 A 文件'));
  assert.ok(!mixedText.includes('AGENTS.md'));
  assert.ok(!mixedText.includes('Never touch secrets'));

  // Real unclosed host-injected reminders STILL fail closed to end of block.
  assert.equal(systemReminderSpans('<system-reminder>unclosed line start').length, 1);
  assert.equal(systemReminderSpans('  <system-reminder>indented line start').length, 1);
  assert.equal(systemReminderSpans('prefix <system-reminder>Instructions from: AGENTS.md\nrule').length, 1);
  assert.equal(systemReminderSpans('prefix <system-reminder>\nmulti-line body').length, 1);

  // Unclosed fence inside a real closed reminder must not swallow the closing tag.
  const unclosedFenceInReminder = [
    '<system-reminder>',
    'Instructions from: AGENTS.md',
    '```bash',
    'echo hi',
    '</system-reminder>',
    '必须保留日志。',
  ].join('\n');
  const afterFenceReminder = instructionText({ blocks: [{ type: 'text', text: unclosedFenceInReminder }] });
  assert.ok(afterFenceReminder.includes('必须保留日志'));
  assert.ok(!afterFenceReminder.includes('echo hi'));
});

// ────────────────────────────────────────────────── 3. lib/reference-input.js

await test('reference-input-deduplicates-repeated-identical-path-file-reads', () => {
  const bigBody = (tag, len = 4500) => `HEAD_${tag}_` + 'X'.repeat(len) + `_TAIL_${tag}`;
  const midBody = (tag) => `MID_${tag}_` + 'Y'.repeat(2400);
  const shortBody = 'short read < 2000 chars';

  const events = [
    { seq: 0, type: 'tool/call', data: { callId: 'c1', name: 'view_file', arguments: JSON.stringify({ path: 'src/engine.js' }) } },
    { seq: 1, type: 'tool/result', sourceEventSeqs: [0], data: { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: bigBody('v1') }] } } },
    { seq: 2, type: 'tool/call', data: { callId: 'c2', name: 'view_file', arguments: JSON.stringify({ path: 'src/other.js' }) } },
    { seq: 3, type: 'tool/result', sourceEventSeqs: [2], data: { message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: bigBody('other') }] } } },
    { seq: 4, type: 'tool/call', data: { callId: 'c3', name: 'view_file', arguments: JSON.stringify({ path: 'src/engine.js' }) } },
    { seq: 5, type: 'tool/result', sourceEventSeqs: [4], data: { message: { role: 'tool', toolCallId: 'c3', content: [{ type: 'text', text: bigBody('v2') }] } } },
    // Error read of src/other.js must NOT supersede seq 3!
    { seq: 6, type: 'tool/call', data: { callId: 'c4', name: 'view_file', arguments: JSON.stringify({ path: 'src/other.js' }) } },
    { seq: 7, type: 'tool/result', sourceEventSeqs: [6], data: { message: { role: 'tool', toolCallId: 'c4', isError: true, content: [{ type: 'text', text: bigBody('err') }] } } },
    // Shell cat reads >= 2000 chars deduplicate; piped cat does NOT.
    { seq: 8, type: 'tool/call', data: { callId: 'c5', name: 'bash', arguments: JSON.stringify({ command: 'cat docs/spec.md' }) } },
    { seq: 9, type: 'tool/result', sourceEventSeqs: [8], data: { message: { role: 'tool', toolCallId: 'c5', content: [{ type: 'text', text: midBody('cat1') }] } } },
    { seq: 10, type: 'tool/call', data: { callId: 'c6', name: 'bash', arguments: JSON.stringify({ command: 'cat docs/spec.md' }) } },
    { seq: 11, type: 'tool/result', sourceEventSeqs: [10], data: { message: { role: 'tool', toolCallId: 'c6', content: [{ type: 'text', text: midBody('cat2') }] } } },
    // Short read (< 2000 chars) must not be folded.
    { seq: 12, type: 'tool/call', data: { callId: 'c7', name: 'view_file', arguments: JSON.stringify({ path: 'src/tiny.js' }) } },
    { seq: 13, type: 'tool/result', sourceEventSeqs: [12], data: { message: { role: 'tool', toolCallId: 'c7', content: [{ type: 'text', text: shortBody }] } } },
    { seq: 14, type: 'tool/call', data: { callId: 'c8', name: 'view_file', arguments: JSON.stringify({ path: 'src/tiny.js' }) } },
    { seq: 15, type: 'tool/result', sourceEventSeqs: [14], data: { message: { role: 'tool', toolCallId: 'c8', content: [{ type: 'text', text: bigBody('tiny-later') }] } } },
    // Distinct line ranges of same file stay distinct!
    { seq: 16, type: 'tool/call', data: { callId: 'c9', name: 'view_file', arguments: JSON.stringify({ path: 'src/sliced.js', startLine: 1, endLine: 100 }) } },
    { seq: 17, type: 'tool/result', sourceEventSeqs: [16], data: { message: { role: 'tool', toolCallId: 'c9', content: [{ type: 'text', text: midBody('slice1') }] } } },
    { seq: 18, type: 'tool/call', data: { callId: 'c10', name: 'view_file', arguments: JSON.stringify({ path: 'src/sliced.js', startLine: 101, endLine: 200 }) } },
    { seq: 19, type: 'tool/result', sourceEventSeqs: [18], data: { message: { role: 'tool', toolCallId: 'c10', content: [{ type: 'text', text: midBody('slice2') }] } } },
  ];

  const session = {
    eventAt: (seq) => events[seq],
    deriveEventMessage: (ev) => (ev?.type === 'tool/result' ? ev.data.message : undefined),
  };
  const seqs = events.map((e) => e.seq);
  const superseded = deduplicateRepeatedFileReads(session, seqs);

  assert.equal(superseded.size, 2);
  assert.deepEqual(superseded.get(1), {
    seq: 1,
    path: 'src/engine.js',
    supersededBy: 5,
    pointer: '[Earlier read of src/engine.js at seq 1 superseded by seq 5; full record archived at seq 1]',
  });
  assert.deepEqual(superseded.get(9), {
    seq: 9,
    path: 'docs/spec.md',
    supersededBy: 11,
    pointer: '[Earlier read of docs/spec.md at seq 9 superseded by seq 11; full record archived at seq 9]',
  });
  assert.equal(superseded.has(3), false, 'error read must not supersede earlier good read');
  assert.equal(superseded.has(13), false, 'short read < 2000 chars must not be folded');
  assert.equal(superseded.has(17), false, 'distinct line ranges must not supersede each other');

  // projectSummaryMessage with supersededReads folds seq 1 and keeps head+tail on newest seq 5.
  const folded1 = projectSummaryMessage(session, events[1], events[1].data.message, { supersededReads: superseded });
  assert.ok(folded1.content[0].text.includes('[Earlier read of src/engine.js at seq 1 superseded by seq 5; full record archived at seq 1]'));
  assert.ok(!folded1.content[0].text.includes('HEAD_v1_'));

  const kept5 = projectSummaryMessage(session, events[5], events[5].data.message, { supersededReads: superseded });
  assert.ok(kept5.content[0].text.includes('HEAD_v2_'));
  assert.ok(kept5.content[0].text.includes('_TAIL_v2'));
  assert.ok(kept5.content[0].text.includes('Tool output projected for summary'));

  // Backward compatibility: 3-arg call still runs normal projection without dedup.
  const legacy1 = projectSummaryMessage(session, events[1], events[1].data.message);
  assert.ok(legacy1.content[0].text.includes('HEAD_v1_'));

  // projectSummaryMessages convenience helper applies dedup across span.
  const projectedAll = projectSummaryMessages(session, [1, 3, 5, 7, 9, 11]);
  assert.equal(projectedAll.length, 6);
  assert.ok(projectedAll[0].content[0].text.includes('superseded by seq 5'));
  assert.ok(projectedAll[2].content[0].text.includes('HEAD_v2_'));
  assert.equal(projectedAll[3], events[7].data.message, 'error message reference unchanged');
  assert.ok(projectedAll[4].content[0].text.includes('superseded by seq 11'));
  assert.ok(projectedAll[5].content[0].text.includes('MID_cat2_'));

  // Also works when tool-call blocks are in assistant/message (without sourceEventSeqs) and for read_file.
  const assistantEvents = [
    { seq: 0, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'a1', name: 'read_file', arguments: JSON.stringify({ path: 'lib/app.js' }) }] } } },
    { seq: 1, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'a1', content: [{ type: 'text', text: midBody('rf1') }] } } },
    { seq: 2, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'a2', name: 'read_file', arguments: JSON.stringify({ path: 'lib/app.js' }) }] } } },
    { seq: 3, type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'a2', content: [{ type: 'text', text: midBody('rf2') }] } } },
  ];
  const assistantSession = {
    eventAt: (seq) => assistantEvents[seq],
    deriveEventMessage: (ev) => ev?.data?.message,
  };
  const dedupAssistant = deduplicateRepeatedFileReads(assistantSession, [0, 1, 2, 3]);
  assert.equal(dedupAssistant.size, 1);
  assert.equal(
    dedupAssistant.get(1)?.pointer,
    '[Earlier read of lib/app.js at seq 1 superseded by seq 3; full record archived at seq 1]',
  );
});

// ────────────────────────────────────────────────────────── 4. lib/state.js

await test('state-stale-lock-dead-pid-reclaimed-and-live-eperm-fresh-unparseable-blocked', async () => {
  const store = new SessionStateStore(join(root, 'state-locks'));
  const sid = 'sess-lock-1';
  const lockFile = store.file(sid) + '.lock';
  fs.mkdirSync(store.root, { recursive: true });

  // 1. Dead PID lock (from a real exited child process) -> reclaimed immediately!
  const exited = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.ok(Number.isSafeInteger(exited.pid) && exited.pid > 0 && exited.pid !== process.pid);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: exited.pid, at: new Date().toISOString() }));
  const updated = store.update(sid, (s) => ({ ...s, failures: 2 }));
  assert.equal(updated.failures, 2);
  assert.equal(fs.existsSync(lockFile), false);

  // 2. Current process PID lock -> throws STATE_LOCKED and preserves lock!
  const selfLock = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  fs.writeFileSync(lockFile, selfLock);
  assert.throws(() => store.update(sid, (s) => s), (e) => e.code === 'STATE_LOCKED');
  assert.equal(fs.readFileSync(lockFile, 'utf8'), selfLock);
  fs.unlinkSync(lockFile);

  // 3. Another live process PID lock -> throws STATE_LOCKED!
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { windowsHide: true });
  try {
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
    const liveLock = JSON.stringify({ pid: child.pid, at: new Date().toISOString() });
    fs.writeFileSync(lockFile, liveLock);
    assert.throws(() => store.update(sid, (s) => s), (e) => e.code === 'STATE_LOCKED');
    assert.equal(fs.readFileSync(lockFile, 'utf8'), liveLock);
    fs.unlinkSync(lockFile);
  } finally {
    child.kill();
  }

  // 4. EPERM from process.kill(pid, 0) -> treated as active process owned by another user -> STATE_LOCKED!
  const origKill = process.kill;
  process.kill = (pid, sig) => {
    if (sig === 0) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    return origKill.call(process, pid, sig);
  };
  try {
    const epermLock = JSON.stringify({ pid: 999999, at: new Date().toISOString() });
    fs.writeFileSync(lockFile, epermLock);
    assert.throws(() => store.update(sid, (s) => s), (e) => e.code === 'STATE_LOCKED');
    assert.equal(fs.readFileSync(lockFile, 'utf8'), epermLock);
    fs.unlinkSync(lockFile);
  } finally {
    process.kill = origKill;
  }

  // 5. Unparseable fresh lock (< 5s old) -> STATE_LOCKED; once >= 5s old -> reclaimed!
  fs.writeFileSync(lockFile, '{truncated');
  assert.throws(() => store.update(sid, (s) => s), (e) => e.code === 'STATE_LOCKED');
  assert.equal(fs.readFileSync(lockFile, 'utf8'), '{truncated');
  const tenSecAgo = new Date(Date.now() - 10_000);
  fs.utimesSync(lockFile, tenSecAgo, tenSecAgo);
  const afterOld = store.update(sid, (s) => ({ ...s, failures: 1 }));
  assert.equal(afterOld.failures, 1);
  assert.equal(fs.existsSync(lockFile), false);
});

await test('state-resumable-compaction-schema-helpers-and-public-summary', () => {
  const store = new SessionStateStore(join(root, 'state-resumable'));
  const sid = 'sess-resumable-1';

  // Clearing absent resumableCompaction returns false and does NOT create state file.
  assert.equal(clearResumableCompaction(store, sid), false);
  assert.equal(fs.existsSync(store.file(sid)), false);

  const sampleJob = {
    version: 1,
    jobId: 'job-001',
    trigger: 'manual',
    status: 'interrupted',
    interruptReason: 'crash',
    createdAt: '2026-11-22T01:00:00.000Z',
    updatedAt: '2026-11-22T01:05:00.000Z',
    remainingSeqs: [10, 11, 12, 13],
    remainingSourceSha256: hex64('a'),
    initialTotalNodes: 20,
    completedNodes: 16,
    initialTotalTokens: 100000,
    completedTokens: 75000,
    completedChunks: 3,
    waveCount: 1,
    batchCheckpointSeqs: [5, 8],
    allowForeignFallback: true,
    checkpointMeta: { migratedFrom: 'billion-context' },
    originalBackupId: 'bkp-20261122T010000Z-abcd1234',
    consecutiveFailures: 1,
    lastErrorCode: 'ECONNRESET',
    lastErrorMessage: 'reset with secret sk-' + '1234567890abcdefghij',
  };

  const written = writeResumableCompaction(store, sid, sampleJob);
  assert.equal(written.version, 1);
  assert.equal(written.jobId, 'job-001');
  assert.ok(!written.lastErrorMessage.includes('1234567890abcdefghij'), 'secrets must be redacted');

  const readBack = readResumableCompaction(store, sid);
  assert.deepEqual(readBack, written);

  // publicResumableSummary hides internal fields & computes progress/canAutoResume.
  const pub = publicResumableSummary(readBack);
  assert.equal(pub.jobId, 'job-001');
  assert.equal(pub.overallPercent, 75);
  assert.equal(pub.remainingNodes, 4);
  assert.equal(pub.remainingTokens, 25000);
  assert.equal(pub.canAutoResume, true);
  assert.equal('remainingSeqs' in pub, false);
  assert.equal('remainingSourceSha256' in pub, false);
  assert.equal('checkpointMeta' in pub, false);

  // running -> null; paused / consecutiveFailures>=3 -> canAutoResume=false; interrupted migration -> canAutoResume=true.
  assert.equal(publicResumableSummary({ ...written, status: 'running' }), null);
  assert.equal(publicResumableSummary({ ...written, status: 'paused' }).canAutoResume, false);
  assert.equal(publicResumableSummary({ ...written, status: 'paused_budget' }).canAutoResume, false);
  assert.equal(publicResumableSummary({ ...written, status: 'paused_failure' }).canAutoResume, false);
  assert.equal(publicResumableSummary({ ...written, trigger: 'migration' }).canAutoResume, true);
  assert.equal(publicResumableSummary({ ...written, consecutiveFailures: 3 }).canAutoResume, false);

  // Corrupt or unknown version returns null and NEVER breaks SessionStateStore.read()!
  assert.equal(validateResumableCompaction({ ...sampleJob, version: 2 }), null);
  assert.equal(validateResumableCompaction({ ...sampleJob, remainingSeqs: [1, 1] }), null);
  assert.equal(validateResumableCompaction({ ...sampleJob, remainingSourceSha256: 'not-hex' }), null);
  assert.equal(validateResumableCompaction({ ...sampleJob, status: 'bogus' }), null);

  store.update(sid, (s) => ({ ...s, resumableCompaction: { version: 99, broken: true } }));
  assert.equal(store.read(sid).failures, 0, 'corrupt resumableCompaction must not break store.read()');
  assert.equal(readResumableCompaction(store, sid), null);

  assert.equal(clearResumableCompaction(store, sid), true);
  assert.equal(clearResumableCompaction(store, sid), false);
});

// ──────────────────────────────────────────────────── 5. lib/transaction.js

await test('transaction-recoverBeforeOpen-closes-started-and-orphan-weave-compactions', async () => {
  const wsDir = join(root, 'tx-cold');
  const stateStore = new SessionStateStore(join(wsDir, 'state'));
  const journal = new CompactionJournal({ root: join(wsDir, 'journal') });
  const backupStore = new SessionBackupStore({ root: join(wsDir, 'backups') });

  function makeAdapterHarness(initialEvents) {
    const events = initialEvents.map((e) => ({ ...e }));
    const logPath = join(wsDir, `log-${Math.random().toString(16).slice(2)}.v4.jsonl`);
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(logPath, 'dummy\n');
    let claimed = false;
    let leases = 0;
    const writers = new Map();
    const backend = {
      tracker: {
        writers,
        claimWrite() {
          if (claimed) throw new Error('already claimed');
          claimed = true;
        },
        releaseClaim() {
          claimed = false;
        },
      },
      coldLogMemo: new Map(),
      async findLog() {
        return { currentPath: logPath, sourcePath: logPath };
      },
      async acquireLease() {
        leases += 1;
        return { async release() {} };
      },
      async readStoredLog() {
        return { meta: { path: logPath }, events: events.map((e) => ({ ...e })), inheritedEventCount: 0 };
      },
      async persistBatch(_meta, batch) {
        events.push(...batch);
      },
    };
    const adapter = Object.create(StockTransactionAdapter.prototype);
    adapter.backend = backend;
    adapter.sessions = { get: () => null };
    adapter.logger = { warn() {} };
    adapter.roots = new Map();
    adapter.backupStores = new Map();
    adapter.blocked = new Set();
    adapter.register(journal, stateStore, 3, backupStore);
    return { adapter, events, getLeases: () => leases, isClaimed: () => claimed };
  }

  // Case A: pending non-atomic `phase: 'started'` journal + running resumableCompaction.
  const sidA = 'sess-cold-started';
  const cidA = 'weave-started-1';
  await journal.record({ sessionId: sidA, compactionId: cidA, phase: 'started', startEventSeq: 1 });
  writeResumableCompaction(stateStore, sidA, {
    jobId: 'job-cold-a',
    trigger: 'migration',
    status: 'running',
    remainingSeqs: [1, 2],
  });
  const hA = makeAdapterHarness([
    { seq: 0, type: 'system/message', data: {} },
    { seq: 1, type: 'compaction/start', data: { compactionId: cidA, turn: null } },
  ]);
  await hA.adapter.recoverBeforeOpen(sidA);
  const endsA = hA.events.filter((e) => e.type === 'compaction/end' && e.data?.compactionId === cidA);
  assert.equal(endsA.length, 1);
  assert.equal(endsA[0].data.error, 'Weave closed interrupted compaction before loading this session.');
  assert.equal((await journal.pending(sidA)).length, 0);
  const resA = readResumableCompaction(stateStore, sidA);
  assert.equal(resA.status, 'interrupted');
  assert.equal(resA.interruptReason, 'crash');
  assert.equal(hA.isClaimed(), false);

  // Case B: NO journal (narrow crash window between compaction/start and journal.record).
  const sidB = 'sess-cold-orphan';
  const cidB = 'weave-orphan-1';
  writeResumableCompaction(stateStore, sidB, {
    jobId: 'job-cold-b',
    trigger: 'manual',
    status: 'running',
    remainingSeqs: [2, 3],
  });
  const hB = makeAdapterHarness([
    { seq: 0, type: 'system/message', data: {} },
    { seq: 1, type: 'compaction/start', data: { compactionId: cidB, turn: 2 } },
  ]);
  await hB.adapter.recoverBeforeOpen(sidB);
  const endsB = hB.events.filter((e) => e.type === 'compaction/end' && e.data?.compactionId === cidB);
  assert.equal(endsB.length, 1);
  assert.equal(endsB[0].data.turn, 2);
  assert.equal(endsB[0].data.error, 'Weave closed interrupted compaction before loading this session.');
  const resB = readResumableCompaction(stateStore, sidB);
  assert.equal(resB.status, 'interrupted');
  assert.equal(resB.interruptReason, 'crash');

  // Case C: NO journal, but a surface replacement already occurred after compaction/start -> DO NOT silently close!
  const sidC = 'sess-cold-orphan-replaced';
  const hC = makeAdapterHarness([
    { seq: 0, type: 'system/message', data: {} },
    { seq: 1, type: 'compaction/start', data: { compactionId: 'weave-orphan-rep', turn: null } },
    { seq: 2, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, data: {} },
  ]);
  await hC.adapter.recoverBeforeOpen(sidC);
  assert.equal(hC.events.filter((e) => e.type === 'compaction/end').length, 0);

  // Case D: NO journal, non-weave compaction/start OR already past session/end-seed -> DO NOT touch!
  const hD = makeAdapterHarness([
    { seq: 0, type: 'compaction/start', data: { compactionId: 'basic-host-1', turn: null } },
  ]);
  await hD.adapter.recoverBeforeOpen('sess-foreign');
  assert.equal(hD.events.filter((e) => e.type === 'compaction/end').length, 0);

  const hE = makeAdapterHarness([
    { seq: 0, type: 'compaction/start', data: { compactionId: 'weave-old-seed', turn: null } },
    { seq: 1, type: 'session/end-seed', data: {} },
  ]);
  await hE.adapter.recoverBeforeOpen('sess-end-seed');
  assert.equal(hE.events.filter((e) => e.type === 'compaction/end').length, 0);
});

// ────────────────────────────────────────────────── 6. lib/session-backup.js

await test('session-backup-path-b-guard-breakpoint-clearing-and-cross-instance-cache', async () => {
  const wsDir = join(root, 'backup-w3');
  const dshDir = join(wsDir, 'dsh');
  fs.mkdirSync(dshDir, { recursive: true });
  const backupRoot = join(wsDir, 'weave', 'backups');
  const stateStore = new SessionStateStore(join(wsDir, 'weave', 'state'));
  const journal = new CompactionJournal({ root: join(wsDir, 'weave', 'journal') });
  const storeA = new SessionBackupStore({ root: backupRoot });
  const storeB = new SessionBackupStore({ root: backupRoot });

  const sid = 'sess-backup-w3';
  const logPath = join(dshDir, 'session.v4.jsonl.zstd');
  const v1Bytes = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4]);
  fs.writeFileSync(logPath, v1Bytes);

  // Seed state WITH both resumableCompaction and continuationPending BEFORE backup!
  stateStore.update(sid, () => ({ failures: 1, stopped: false }));
  writeResumableCompaction(stateStore, sid, {
    jobId: 'job-in-backup',
    trigger: 'migration',
    status: 'paused',
    remainingSeqs: [1, 2],
  });
  const fakeSession = {
    id: sid,
    seq: 2,
    surface: { nodes: [0, 1], replaceGeneration: 0 },
    eventAt: (seq) => ({ seq, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: `m${seq}` }] } }),
    deriveEventMessage: (e) => e.data,
  };
  freezeContinuation(stateStore, fakeSession, [0, 1]);
  assert.ok(readResumableCompaction(stateStore, sid));
  assert.ok(readPendingContinuation(stateStore, fakeSession));

  // Populate cache on storeA before backup exists (count=0).
  const emptySum = summarizeBackups(storeA, sid);
  assert.equal(emptySum.count, 0);

  // Create backup via storeB -> storeA MUST immediately see count=1 (no stale cache across instances!).
  const created = await createSessionBackup(storeB, {
    sessionId: sid,
    logPath,
    stateStore,
    reason: 'bili-migration',
  });
  const sumAfterCreate = summarizeBackups(storeA, sid);
  assert.equal(sumAfterCreate.count, 1);
  assert.equal(sumAfterCreate.originalBackupId, created.backupId);

  // Mutating returned summary object must NOT corrupt cached copy.
  sumAfterCreate.items.push({ backupId: 'injected' });
  const sumAgain = summarizeBackups(storeA, sid);
  assert.equal(sumAgain.items.length, 1);

  // Explicit invalidateCache works cleanly, and out-of-band disk change invalidates via stat signature.
  storeA.invalidateCache(sid);
  assert.equal(summarizeBackups(storeA, sid).count, 1);

  // Creating a 2nd backup on storeB invalidates storeA immediately.
  fs.writeFileSync(logPath, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 5, 6, 7, 8]));
  await createSessionBackup(storeB, {
    sessionId: sid,
    logPath,
    stateStore,
    reason: 'manual',
  });
  assert.equal(summarizeBackups(storeA, sid).count, 2);
  fs.writeFileSync(logPath, v1Bytes);

  // Path B (isLive === true) WITHOUT stockAdapter throws BACKUP_RESTORE_UNAVAILABLE and does NOT arm!
  const liveSessions = { get: (id) => (id === sid ? fakeSession : null) };
  await assert.rejects(
    restoreSessionBackup(storeA, {
      sessionId: sid,
      backupId: created.backupId,
      sessions: liveSessions,
      logPath,
    }),
    (err) =>
      err.code === 'BACKUP_RESTORE_UNAVAILABLE' &&
      err.message.includes('host transaction adapter is unavailable'),
  );
  assert.equal(readPendingRestore(storeA, sid), null);

  // Path B WITH stockAdapter arms restore and invalidates cache across storeA & storeB.
  const writers = new Map([[sid, { persistContiguous: async () => {} }]]);
  const backend = {
    tracker: { writers, claimWrite() {}, releaseClaim() {} },
    async findLog() {
      return { currentPath: logPath, sourcePath: logPath };
    },
    async acquireLease() {
      return { async release() {} };
    },
    coldLogMemo: new Map(),
  };
  const adapter = Object.create(StockTransactionAdapter.prototype);
  adapter.backend = backend;
  adapter.sessions = { get: () => null };
  adapter.logger = { warn() {} };
  adapter.roots = new Map();
  adapter.backupStores = new Map();
  adapter.blocked = new Set();
  adapter.register(journal, stateStore, 3, storeA);

  const armed = await restoreSessionBackup(storeB, {
    sessionId: sid,
    backupId: created.backupId,
    sessions: liveSessions,
    backend,
    stockAdapter: adapter,
    logPath,
  });
  assert.equal(armed.status, 'armed');
  assert.equal(summarizeBackups(storeA, sid).pendingRestore?.backupId, created.backupId);

  // Mutate disk log, detach live writer, and run recoverBeforeOpen -> restores v1Bytes AND strips BOTH breakpoints!
  fs.writeFileSync(logPath, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 9, 9, 9, 9]));
  writers.delete(sid);
  await adapter.recoverBeforeOpen(sid);

  assert.deepEqual(fs.readFileSync(logPath), v1Bytes);
  assert.equal(summarizeBackups(storeA, sid).pendingRestore, null);
  const restoredState = stateStore.read(sid);
  assert.equal(restoredState.failures, 1, 'clean baseline failure count preserved');
  assert.equal(restoredState.resumableCompaction, undefined, 'resumableCompaction must be stripped on restore');
  assert.equal(restoredState.continuationPending, undefined, 'continuationPending must be stripped on restore');
});

// ────────────────────────────────────────────── 7. lib/failure-diagnostics.js

await test('failure-diagnostics-punctuation-busy-causes-and-backup-restore-unavailable', () => {
  const txt = diagnosticText({
    id: 'diag-1',
    status: 'saved',
    attempts: 1,
    path: 'diagnostics/2026-diag-1.json',
    auditWriteFailures: 0,
  });
  assert.ok(txt.includes('诊断日志：diagnostics/2026-diag-1.json。提交日志是可选的'));

  // 4 distinct busy causes (including wrapped cause and combined lock+in-progress message).
  const busyOpenTurn = Object.assign(new Error('manual compaction: the session already has an open turn'), { code: 'busy' });
  assert.equal(
    failureExplanation(busyOpenTurn),
    '当前会话存在未结束的对话回合，请等待回复完成后再试。',
  );

  const busyLock = Object.assign(
    new Error('compaction: compaction already in progress; the session compaction lock is already active'),
    { code: 'busy' },
  );
  assert.equal(
    failureExplanation(busyLock),
    '检测到当前会话存在未闭合的压缩锁，请先重新打开会话或重试 /compact 自动恢复。',
  );

  const busyActive1 = Object.assign(new Error('manual compaction: compaction already in progress'), { code: 'busy' });
  assert.equal(
    failureExplanation(busyActive1),
    '当前会话已有压缩或迁移任务正在运行，请等待完成或在进度卡片中暂停后再试。',
  );

  const busyActive2 = Object.assign(new Error('busy'), {
    code: 'busy',
    cause: new Error('compaction already active for this logical session'),
  });
  assert.equal(
    failureExplanation(busyActive2),
    '当前会话已有压缩或迁移任务正在运行，请等待完成或在进度卡片中暂停后再试。',
  );

  const busyFallback = Object.assign(new Error('manual compaction requires an idle agent with no waking queued work'), {
    code: 'busy',
  });
  assert.equal(
    failureExplanation(busyFallback),
    '当前会话正在工作或已有压缩进行中，请空闲后再试。',
  );

  const restoreUnavail = Object.assign(new Error('adapter missing'), { code: 'BACKUP_RESTORE_UNAVAILABLE' });
  const restoreMsg = failureExplanation(restoreUnavail);
  assert.ok(restoreMsg.includes('BACKUP_RESTORE_UNAVAILABLE'));
  assert.ok(restoreMsg.includes('离线还原') || restoreMsg.includes('关闭 DSH'));
});

// ────────────────────────────────────────────── 8. lib/continuation-pending.js

await test('continuation-pending-clear-helper-and-smooth-policy-restart', () => {
  const store = new SessionStateStore(join(root, 'state-cont-pending'));
  const sid = 'sess-cont-w3';
  const session = {
    id: sid,
    surface: { nodes: [0, 1], replaceGeneration: 0 },
    eventAt: (seq) => ({ seq, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: `msg-${seq}` }] } }),
    deriveEventMessage: (e) => e.data,
  };

  // Clearing when absent returns false without creating state file.
  assert.equal(clearPendingContinuation(store, sid), false);
  assert.equal(fs.existsSync(store.file(sid)), false);

  const pending = freezeContinuation(store, session, [0, 1]);
  const key1 = hex64('1');
  const key2 = hex64('2');
  const key3 = hex64('3');

  bindContinuationProgress(store, session, pending.id, key1);

  // Default behavior (allowPolicyRestart: false, manualRetry: false) STILL hard-blocks!
  assert.throws(
    () => bindContinuationProgress(store, session, pending.id, key2),
    (e) => e.code === 'CONTINUATION_PENDING_POLICY_CHANGED',
  );

  // Smooth policy restart with allowPolicyRestart: true updates progressKey & tracks progressHistory!
  const res1 = bindContinuationProgress(store, session, pending.id, key2, {
    allowPolicyRestart: true,
    requestId: 'resume-1',
  });
  assert.deepEqual(res1.priorProgressKeys, [key1]);
  assert.equal(readPendingContinuation(store, session).progressKey, key2);

  // Also works smoothly with allowPolicyRestart: true even when requestId is omitted.
  const res2 = bindContinuationProgress(store, session, pending.id, key3, {
    allowPolicyRestart: true,
  });
  assert.deepEqual(res2.priorProgressKeys, [key1, key2]);
  assert.equal(readPendingContinuation(store, session).progressKey, key3);

  // Atomic clearPendingContinuation removes it and returns true, then false on repeat.
  assert.equal(clearPendingContinuation(store, sid), true);
  assert.equal(readPendingContinuation(store, session), null);
  assert.equal(clearPendingContinuation(store, sid), false);
});

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
console.log(JSON.stringify({ passed, failed, results }, null, 2));
if (failed > 0) process.exitCode = 1;
