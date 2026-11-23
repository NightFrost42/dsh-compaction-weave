import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  memoryDecisionsForSource,
  memorySourceRefs,
  restoreMemorySource,
  restoreRetiredDecisions,
  restoreRetiredDecisionsBatch,
  retiredMemoryPresent,
  selectMemoryMessages,
} from '../lib/memory-policy.js';
import { restoreSourceLayout, sourceLayout } from '../lib/source-refs.js';
import { collectInstructionMessages, selectSessionMemory } from '../lib/region.js';
import { FailureDiagnostics, failureExplanation } from '../lib/failure-diagnostics.js';
import { sourceEvidenceSentences, sourceEvidenceSentencesLegacyQuoteSplit } from '../lib/audit.js';
import { withStageTraceContext } from '../lib/stage-trace.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message, stack: error.stack });
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fragDigest = (text) => sha256(String(text).normalize('NFC').trim().replace(/\s+/g, ' '));
const blocksDigest = (blocks) => sha256(JSON.stringify(blocks.map((b) => b.text)));
const msg = (seq, text, sourceKind = 'user') => ({ seq, text, sourceKind, blocks: [{ type: 'text', text }] });

function makeSession(initialEvents = []) {
  const events = initialEvents.map((e, seq) => ({ seq, ...e }));
  const surface = { nodes: events.map((e) => e.seq), replaceGeneration: 0 };
  const session = {
    id: 'issue13-compat-session',
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => events,
    deriveEventMessage: (e) => e?.data,
  };
  const addUser = (text, kind = 'user', visible = true) => {
    const seq = events.length;
    events.push({
      seq,
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text }], source: { kind } },
    });
    if (visible) surface.nodes.push(seq);
    return seq;
  };
  return { session, events, surface, addUser };
}

// 1. Pre-v0.4.4 quote-end (。」 / 。” / .") memoryDecisions restore & upgrade cleanly
await test('pre-v044-quote-end-memoryDecisions-restore-and-upgrade', () => {
  // 1a. Both source and actor cross quote-end boundary; modern splitter keeps 」 attached so
  // current byMap upgrades overlapping coordinates automatically when actor matches both versions.
  const fUpgrade = makeSession();
  const s0 = fUpgrade.addUser('生成「目标。」然后停止。', 'user', false);
  const a0 = fUpgrade.addUser('取消上一条', 'user', false);
  const s0Text = fUpgrade.events[s0].data.content[0].text;
  const a0Text = fUpgrade.events[a0].data.content[0].text;
  const cpLegacyUpgrade = [
    {
      reason: 'cancelled',
      seq: s0,
      by: a0,
      fragmentHash: fragDigest('生成「目标。'),
      sourcePart: { block: 0, start: 0, end: 6 },
      byFragmentHash: fragDigest(a0Text),
      sourceSha256: blocksDigest([{ text: s0Text }]),
      bySha256: blocksDigest([{ text: a0Text }]),
    },
    {
      reason: 'cancelled',
      seq: s0,
      by: a0,
      fragmentHash: fragDigest('」然后停止。'),
      sourcePart: { block: 0, start: 6, end: 12 },
      byFragmentHash: fragDigest(a0Text),
      sourceSha256: blocksDigest([{ text: s0Text }]),
      bySha256: blocksDigest([{ text: a0Text }]),
    },
  ];
  const upgraded = restoreRetiredDecisions(cpLegacyUpgrade, fUpgrade.session, 2);
  assert.equal(upgraded.length, 2);
  assert.equal(upgraded[0].text, '生成「目标。」');
  assert.deepEqual(upgraded[0].sourcePart, { block: 0, start: 0, end: 7 });
  assert.equal(upgraded[1].text, '然后停止。');
  assert.deepEqual(upgraded[1].sourcePart, { block: 0, start: 7, end: 12 });

  // 1b. Actor text itself ended with .」 so pre-v0.4.4 split 「取消上一条。」「」 whereas modern keeps 「取消上一条。」」.
  const fActorQuote = makeSession();
  const s1 = fActorQuote.addUser('生成「目标。」然后停止。', 'user', false);
  const a1 = fActorQuote.addUser('取消上一条。」', 'user', false);
  const s1Text = fActorQuote.events[s1].data.content[0].text;
  const a1Text = fActorQuote.events[a1].data.content[0].text;
  const legacyActorDecisions = [
    {
      reason: 'cancelled',
      seq: s1,
      by: a1,
      fragmentHash: fragDigest('生成「目标。'),
      sourcePart: { block: 0, start: 0, end: 6 },
      byFragmentHash: fragDigest('取消上一条。'),
      sourceSha256: blocksDigest([{ text: s1Text }]),
      bySha256: blocksDigest([{ text: a1Text }]),
    },
    {
      reason: 'cancelled',
      seq: s1,
      by: a1,
      fragmentHash: fragDigest('」然后停止。'),
      sourcePart: { block: 0, start: 6, end: 12 },
      byFragmentHash: fragDigest('取消上一条。'),
      sourceSha256: blocksDigest([{ text: s1Text }]),
      bySha256: blocksDigest([{ text: a1Text }]),
    },
  ];
  const restoredBatch = restoreRetiredDecisionsBatch(
    [{ checkpointSeq: 2, decisions: legacyActorDecisions }],
    fActorQuote.session,
  );
  assert.equal(restoredBatch.length, 2);
  assert.equal(restoredBatch[0].text, '生成「目标。');
  assert.equal(restoredBatch[1].text, '」然后停止。');

  // 1c. English quote-end (.") + Chinese 。” superseded checkpoint entry across full selectSessionMemory
  const fSup = makeSession();
  const s2 = fSup.addUser('timeout: 30s.', 'user', false);
  const a2 = fSup.addUser('timeout: 60s."', 'user', false);
  const s2Text = fSup.events[s2].data.content[0].text;
  const a2Text = fSup.events[a2].data.content[0].text;
  assert.deepEqual(sourceEvidenceSentencesLegacyQuoteSplit(a2Text), ['timeout: 60s.', '"']);
  assert.deepEqual(sourceEvidenceSentences(a2Text), ['timeout: 60s."']);
  const legacySupDecisions = [
    {
      reason: 'superseded',
      seq: s2,
      by: a2,
      fragmentHash: fragDigest('timeout: 30s.'),
      sourcePart: { block: 0, start: 0, end: 13 },
      byFragmentHash: fragDigest('timeout: 60s.'),
      sourceSha256: blocksDigest([{ text: s2Text }]),
      bySha256: blocksDigest([{ text: a2Text }]),
    },
  ];
  const cpSeq = fSup.events.length;
  fSup.events.push({
    seq: cpSeq,
    type: 'user/message',
    data: {
      role: 'user',
      content: [{ type: 'text', text: 'Notes.' }],
      source: {
        kind: 'compact-checkpoint',
        memorySources: [],
        preserved: [],
        memoryDecisions: legacySupDecisions,
      },
    },
  });
  fSup.surface.nodes = [cpSeq];
  const sel = selectSessionMemory(fSup.session, [cpSeq]);
  assert.ok(sel.decisions.some((d) => d.seq === s2 && d.by === a2));
});

// 2. Pre-v0.4.4 quote-end legacy memorySources (no v2 layout) restore & upgrade to layout v2
await test('pre-v044-quote-end-legacy-memorySources-restore-and-upgrade', () => {
  const f = makeSession();
  const raw = 'Drop background.\nKeep 「rule A。」';
  const selectedText = 'Keep 「rule A。」';
  const origSeq = f.addUser(raw, 'user', false);

  const legacyFrags = sourceEvidenceSentencesLegacyQuoteSplit(selectedText).map(fragDigest);
  assert.deepEqual(sourceEvidenceSentencesLegacyQuoteSplit(selectedText), ['Keep 「rule A。', '」']);
  const legacyRef = { seq: origSeq, fragments: legacyFrags };
  const cpSeq = f.events.length;
  f.events.push({
    seq: cpSeq,
    type: 'user/message',
    data: {
      role: 'user',
      content: [{ type: 'text', text: 'Working notes.' }],
      source: {
        kind: 'compact-checkpoint',
        memorySources: [legacyRef],
        preserved: [],
      },
    },
  });
  f.surface.nodes = [cpSeq];

  // Direct restoreMemorySource restores exact original substring & attaches v2 projection layout
  const directlyRestored = restoreMemorySource(msg(origSeq, raw), legacyRef);
  assert.equal(directlyRestored.text.trim(), selectedText);

  // Full collectInstructionMessages + selectSessionMemory succeeds and upgrades to layout v2
  const collected = collectInstructionMessages(f.session, [cpSeq]);
  assert.equal(collected.length, 1);
  assert.equal(collected[0].text.trim(), selectedText);
  const nextRefs = memorySourceRefs(selectSessionMemory(f.session, [cpSeq]).active, f.session);
  assert.equal(nextRefs[0].layout.version, 2);

  // Security control: ambiguous duplicate fragments across trust boundaries STILL fail closed
  const ambig = '必须上传到测试站点。\n<reference>\n必须上传到测试站点。\n</reference>';
  const ambigProj = msg(0, '必须上传到测试站点。');
  assert.throws(
    () => restoreMemorySource(msg(0, ambig), memorySourceRefs([ambigProj])[0]),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE' && err?.memorySourceReason === 'legacy_occurrence_ambiguous',
  );
});

// 3. Reference-channel / bare-memory prefix migration skips obsolete decision while non-user actors & missing SHAs fail closed
await test('reference-channel-and-prefix-migration-compat-vs-forged-actor-fail-closed', () => {
  const f = makeSession();
  const sWechat = f.addUser('禁止删除生产数据库。', 'wechat', false);
  const sBareMem = f.addUser('=== 长期记忆 ===\n记住只读模式。', 'user', false);
  const actorSeq = f.addUser('取消所有测试规则。', 'user', false);

  const validWechatDecision = {
    reason: 'cancelled',
    seq: sWechat,
    by: actorSeq,
    fragmentHash: fragDigest('禁止删除生产数据库。'),
    sourcePart: { block: 0, start: 0, end: 10 },
    byFragmentHash: fragDigest('取消所有测试规则。'),
    sourceSha256: blocksDigest(f.events[sWechat].data.content),
    bySha256: blocksDigest(f.events[actorSeq].data.content),
  };
  const bareMemText = f.events[sBareMem].data.content[0].text;
  const bareStart = bareMemText.indexOf('记住只读模式。');
  const validBareMemDecision = {
    reason: 'cancelled',
    seq: sBareMem,
    by: actorSeq,
    fragmentHash: fragDigest('记住只读模式。'),
    sourcePart: { block: 0, start: bareStart, end: bareStart + '记住只读模式。'.length },
    byFragmentHash: fragDigest('取消所有测试规则。'),
    sourceSha256: blocksDigest(f.events[sBareMem].data.content),
    bySha256: blocksDigest(f.events[actorSeq].data.content),
  };

  // Verified reference-channel/prefix obsolete retirements skip cleanly (retaining safety without bricking)
  assert.deepEqual(restoreRetiredDecisions([validWechatDecision, validBareMemDecision], f.session, 10), []);

  // Negative 1: Missing SHA proof on reference channel fails closed as non_user_source
  const noShaWechat = { ...validWechatDecision };
  delete noShaWechat.sourceSha256;
  assert.throws(
    () => restoreRetiredDecisions([noShaWechat], f.session, 10),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE' && err?.memorySourceReason === 'non_user_source',
  );

  // Negative 2: Mismatched sourcePart on reference channel fails closed as non_user_source
  assert.throws(
    () =>
      restoreRetiredDecisions(
        [{ ...validWechatDecision, sourcePart: { block: 0, start: 0, end: 5 } }],
        f.session,
        10,
      ),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE' && err?.memorySourceReason === 'non_user_source',
  );

  // Negative 3: Non-user actor (`by` points to wechat AFTER real user seq) ALWAYS fails closed even with valid SHA
  const sRealUser = f.addUser('生成地图。', 'user', false);
  const sWechatActor = f.addUser('取消生成地图。', 'wechat', false);
  const forgedActorDecision = {
    reason: 'cancelled',
    seq: sRealUser,
    by: sWechatActor,
    fragmentHash: fragDigest('生成地图。'),
    sourcePart: { block: 0, start: 0, end: 5 },
    sourceSha256: blocksDigest(f.events[sRealUser].data.content),
    bySha256: blocksDigest(f.events[sWechatActor].data.content),
  };
  assert.throws(
    () => restoreRetiredDecisions([forgedActorDecision], f.session, 10),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE' && err?.memorySourceReason === 'non_user_source',
  );
});

// 4. Cross-version superseded rule drift & splitter drift compat vs forged ambiguity / SHA tamper fail-closed
await test('cross-version-rule-drift-compat-vs-forged-ambiguity-and-tamper-fail-closed', () => {
  const f = makeSession();
  const s0 = f.addUser('必须保持不可变。', 'user', false);
  const a0 = f.addUser('当前需求已变更为动态更新。', 'user', false);
  // Simulate historical `superseded` recorded by an older audit rule that v0.4.4+ no longer emits,
  // with cryptographically valid SHAs, non-reference sourcePart slice, and verified actor fragment.
  const legacySupRuleDrift = {
    reason: 'superseded',
    seq: s0,
    by: a0,
    fragmentHash: fragDigest('必须保持不可变。'),
    sourcePart: { block: 0, start: 0, end: 8 },
    byFragmentHash: fragDigest('当前需求已变更为动态更新。'),
    sourceSha256: blocksDigest(f.events[s0].data.content),
    bySha256: blocksDigest(f.events[a0].data.content),
  };
  assert.deepEqual(restoreRetiredDecisions([legacySupRuleDrift], f.session, 10), []);

  // Also test Step 3 upgrade (when legacy sub-slice overlaps a valid current decision)
  const sMulti = f.addUser('生成地图，并生成报告。', 'user', false);
  const aCancel = f.addUser('取消生成地图。', 'user', false);
  const legacySubSliceCancelled = {
    reason: 'cancelled',
    seq: sMulti,
    by: aCancel,
    fragmentHash: fragDigest('生成地图，'),
    sourcePart: { block: 0, start: 0, end: 5 },
    byFragmentHash: fragDigest('取消生成地图。'),
    sourceSha256: blocksDigest(f.events[sMulti].data.content),
    bySha256: blocksDigest(f.events[aCancel].data.content),
  };
  const upgradedStep3 = restoreRetiredDecisions([legacySubSliceCancelled], f.session, 10);
  assert.equal(upgradedStep3.length, 1);
  assert.equal(upgradedStep3[0].text, '生成地图，并生成报告。');

  // And test Step 4 safe skip when a legacy comma splitter isolated a sub-slice that current
  // splitter merges into a larger clause no longer matching current replay (provenSplitterDrift)
  const sDrift = f.addUser('保留安全日志，生成地图。', 'user', false);
  const aDrift = f.addUser('取消生成地图。', 'user', false);
  const sDriftStart = '保留安全日志，生成地图。'.indexOf('生成地图。');
  const legacySplitDrift = {
    reason: 'cancelled',
    seq: sDrift,
    by: aDrift,
    fragmentHash: fragDigest('生成地图。'),
    sourcePart: { block: 0, start: sDriftStart, end: sDriftStart + '生成地图。'.length },
    byFragmentHash: fragDigest('取消生成地图。'),
    sourceSha256: blocksDigest(f.events[sDrift].data.content),
    bySha256: blocksDigest(f.events[aDrift].data.content),
  };
  assert.deepEqual(restoreRetiredDecisions([legacySplitDrift], f.session, 10), []);

  // Security control A: forged local decision claiming to resolve global ambiguity MUST STILL FAIL CLOSED!
  const fAmbig = makeSession();
  fAmbig.addUser('上传到站点A。');
  fAmbig.addUser('上传到站点B。');
  fAmbig.addUser('取消上传。');
  const partial = selectMemoryMessages([msg(0, '上传到站点A。'), msg(2, '取消上传。')]);
  const forgedAmbig = memoryDecisionsForSource(partial.decisions, fAmbig.session);
  assert.throws(
    () => restoreRetiredDecisions(forgedAmbig, fAmbig.session, 3),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE' && err?.memorySourceReason === 'decision_replay_mismatch',
  );

  // Security control B: real event SHA tampering MUST STILL FAIL CLOSED with sha_mismatch!
  const fTamper = makeSession();
  fTamper.addUser('生成地图。');
  fTamper.addUser('取消生成地图。');
  const authentic = memoryDecisionsForSource(
    selectMemoryMessages([msg(0, '生成地图。'), msg(1, '取消生成地图。')]).decisions,
    fTamper.session,
  );
  assert.equal(restoreRetiredDecisions(authentic, fTamper.session, 2)[0].text, '生成地图。');
  assert.ok(retiredMemoryPresent('生成地图。', { active: [], decisions: restoreRetiredDecisions(authentic, fTamper.session, 2) }));

  // Tamper recorded sourceSha256
  assert.throws(
    () => restoreRetiredDecisions([{ ...authentic[0], sourceSha256: '0'.repeat(64) }], fTamper.session, 2),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE' && err?.memorySourceReason === 'sha_mismatch',
  );
  // Mutate underlying event text in place -> hits sha_mismatch
  fTamper.events[0].data.content[0].text = '生成报告。';
  assert.throws(
    () => restoreRetiredDecisions(authentic, fTamper.session, 2),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE' && err?.memorySourceReason === 'sha_mismatch',
  );
  // Missing event -> hits missing_event
  assert.throws(
    () => restoreRetiredDecisions([{ ...authentic[0], seq: 99, by: 100 }], fTamper.session, 101),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE' && err?.memorySourceReason === 'missing_event',
  );
});

// 5. sourceLayout legacy projections containing stripped list markers
await test('sourceLayout-legacy-list-marker-projections-and-tamper-controls', () => {
  // 5a. Non-contiguous list items across numeric / paren / bullet styles (uncached WeakMap objects)
  const cases = [
    ['1. Keep backups.\n2. Temp note.\n3. Never delete logs.', '1. Keep backups.\n3. Never delete logs.'],
    ['2) Retain audit trail.\n3) Ignore cache.\n4) Verify checksum.', '2) Retain audit trail.\n4) Verify checksum.'],
    ['(1) Hold lock.\n(2) Drop tmp.\n(3) Sync state.', '(1) Hold lock.\n(3) Sync state.'],
    ['- Rule alpha.\n- Temporary log.\n- Rule beta.', '- Rule alpha.\n- Rule beta.'],
    ['  * Check ports.\n  * Ignore warning.\n  + Seal archive.', '  * Check ports.\n  + Seal archive.'],
    // 5b. Same-line partial deletion (Attempt B: marker precedes non-adjacent surviving sentence)
    ['1. Generate report. Never delete logs.', '1. Never delete logs.'],
    ['  - First step. Second step.\n  - Third step.', '  - Second step.\n  - Third step.'],
  ];

  for (const [origText, selText] of cases) {
    const original = msg(0, origText);
    const selected = msg(0, selText);
    const layout = sourceLayout(selected, original);
    assert.equal(layout.version, 2);
    // Security invariant: part.space MUST remain strictly whitespace-only!
    for (const blk of layout.blocks) {
      for (const part of blk.parts) {
        if (typeof part.space === 'string') {
          assert.match(part.space, /^\s*$/);
        }
      }
    }
    const restored = restoreSourceLayout(msg(0, origText), JSON.parse(JSON.stringify(layout)));
    assert.equal(restored.text, selText);
  }

  // Negative controls: fabricated markers, arbitrary text gaps, reordering, space injection
  assert.throws(
    () => sourceLayout(msg(0, '9. Never delete logs.'), msg(0, '1. Keep backups.\n3. Never delete logs.')),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE' && err?.memorySourceReason === 'source_part_mismatch',
  );
  assert.throws(
    () => sourceLayout(msg(0, 'EXTRA Keep backups.'), msg(0, '1. Keep backups.')),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE' && err?.memorySourceReason === 'source_part_mismatch',
  );
  assert.throws(
    () => sourceLayout(msg(0, '3. Never delete logs.\n1. Keep backups.'), msg(0, '1. Keep backups.\n3. Never delete logs.')),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE' && err?.memorySourceReason === 'source_part_mismatch',
  );
  const validLayout = sourceLayout(msg(0, '- Keep backups.'), msg(0, '- Keep backups.\n- Extra.'));
  validLayout.blocks[0].parts.unshift({ space: '1. ' });
  assert.throws(
    () => restoreSourceLayout(msg(0, '- Keep backups.\n- Extra.'), validLayout),
    (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE' && err?.memorySourceReason === 'source_part_mismatch',
  );
});

// 6. Sanitized diagnostic sub-reasons & zero-prose privacy guard
await test('sanitized-diagnostic-sub-reasons-and-zero-prose-privacy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-issue13-diag-'));
  try {
    const diag = new FailureDiagnostics(root);
    const session = { id: 'diag-issue13' };

    const integrityErr = Object.assign(new Error('USER_PROSE_MUST_NOT_LEAK'), {
      code: 'MEMORY_SOURCE_UNAVAILABLE',
      memorySourceReason: 'sha_mismatch',
    });
    const wrapped = Object.assign(new Error('compaction capacity blocked'), {
      code: 'COMPACTION_CAPACITY_BLOCKED',
      cause: integrityErr,
    });
    try {
      await diag.run(session, { trigger: 'manual', commandId: 'c1' }, () => {
        throw wrapped;
      });
    } catch {}
    const reportPath = diag.forCommand(session, 'c1')?.path;
    assert.ok(reportPath);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(report.errors[0].code, 'COMPACTION_CAPACITY_BLOCKED');
    assert.equal(report.errors[1].code, 'MEMORY_SOURCE_UNAVAILABLE');
    assert.equal(report.errors[1].subReason, 'sha_mismatch');
    assert.ok(!JSON.stringify(report).includes('USER_PROSE_MUST_NOT_LEAK'));

    const expIntegrity = failureExplanation(wrapped);
    assert.match(expIntegrity, /MEMORY_SOURCE_UNAVAILABLE/);
    assert.match(expIntegrity, /subReason=sha_mismatch/);
    assert.doesNotMatch(expIntegrity, /USER_PROSE_MUST_NOT_LEAK/);

    const driftErr = Object.assign(new Error('Memory source fragments are unavailable.'), {
      code: 'MEMORY_SOURCE_UNAVAILABLE',
      memorySourceReason: 'fragment_mismatch',
    });
    const expDrift = failureExplanation(driftErr);
    assert.match(expDrift, /MEMORY_SOURCE_UNAVAILABLE/);
    assert.match(expDrift, /subReason=fragment_mismatch/);
    assert.match(expDrift, /跨版本|坐标|分句/);

    // Non-allowlisted arbitrary/prose string MUST be dropped from serialized subReason
    const badReasonErr = Object.assign(new Error('raw'), {
      code: 'MEMORY_SOURCE_UNAVAILABLE',
      memorySourceReason: 'unlisted_arbitrary_prose_leak',
    });
    try {
      await diag.run(session, { trigger: 'manual', commandId: 'c2' }, () => {
        throw badReasonErr;
      });
    } catch {}
    const report2 = JSON.parse(await readFile(diag.forCommand(session, 'c2').path, 'utf8'));
    assert.equal(report2.errors[0].code, 'MEMORY_SOURCE_UNAVAILABLE');
    assert.equal(report2.errors[0].subReason, undefined);
    assert.ok(!JSON.stringify(report2).includes('unlisted_arbitrary_prose_leak'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 7. Gated legacy replay skips non-quote-end superseded drift & tracks legacyLastSeq accurately
await test('superseded-rule-drift-without-quote-end-skips-without-legacy-replay-and-legacyLastSeq-recomputes', async () => {
  const root = await mkdtemp(join(process.env.WEAVE_TEST_ROOT ?? tmpdir(), 'weave-issue13-opt7-'));
  try {
    const f = makeSession();
    for (let i = 0; i <= 305; i += 1) {
      f.addUser(`Filler note ${i}.`, 'user', false);
    }
    const setMsg = (seq, text) => {
      f.events[seq].data.content = [{ type: 'text', text }];
    };

    // Quote-end legacy pairs at low (20), mid (150), and high (200) where modern byMap is empty
    // (modern keeps 「」 attached so `'取消上一条。」'` no longer emits in current byMap)
    setMsg(19, '生成「目标一。」然后停止。');
    setMsg(20, '取消上一条。」');
    setMsg(149, '生成「目标二。」然后停止。');
    setMsg(150, '取消上一条。」');
    setMsg(199, '生成「目标三。」然后停止。');
    setMsg(200, '取消上一条。」');

    // Drifted superseded pair at maxBy = 300 with NO quote-end punctuation
    setMsg(290, '必须保持不可变。');
    setMsg(300, '当前需求已变更为动态更新。');

    const makeDecision = (reason, seq, by, fragText, byFragText) => ({
      reason,
      seq,
      by,
      fragmentHash: fragDigest(fragText),
      sourcePart: { block: 0, start: 0, end: fragText.length },
      byFragmentHash: fragDigest(byFragText),
      sourceSha256: blocksDigest(f.events[seq].data.content),
      bySha256: blocksDigest(f.events[by].data.content),
    });

    const dDrift = makeDecision('superseded', 290, 300, '必须保持不可变。', '当前需求已变更为动态更新。');
    const dLow = makeDecision('cancelled', 19, 20, '生成「目标一。', '取消上一条。');
    const dMid = makeDecision('cancelled', 149, 150, '生成「目标二。', '取消上一条。');
    const dHigh = makeDecision('cancelled', 199, 200, '生成「目标三。', '取消上一条。');

    const runTracedRestore = async (tag, decisions) => {
      const traceDir = join(root, tag);
      const res = await withStageTraceContext(
        { enabled: true, storageRoot: traceDir, sessionId: `s-${tag}` },
        () => restoreRetiredDecisions(decisions, f.session, 306),
      );
      const lines = (await readFile(join(traceDir, 'stage-trace.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const endEv = lines.find((l) => l.stage === 'restoreRetiredDecisions' && l.phase === 'end');
      assert.ok(endEv, `missing restoreRetiredDecisions trace for ${tag}`);
      return { res, trace: endEv };
    };

    // Call 1 (high maxBy=300, drifted non-quote superseded): scans once (301), skips getLegacyByMap()
    const c1 = await runTracedRestore('c1-drift-cold', [dDrift]);
    assert.deepEqual(c1.res, []);
    assert.equal(c1.trace.hitCache, false);
    assert.equal(c1.trace.scanned, 301);

    // Call 2 (low maxBy=20, quote-end legacy cancelled): hits main byMap cache, computes byMapLegacy over 0..20 only
    const c2 = await runTracedRestore('c2-low-legacy', [dLow]);
    assert.equal(c2.res.length, 1);
    assert.equal(c2.res[0].seq, 19);
    assert.equal(c2.res[0].by, 20);
    assert.equal(c2.trace.hitCache, true);
    assert.equal(c2.trace.scanned, 21);

    // Call 3 (high maxBy=200, quote-end legacy cancelled): detects legacyLastSeq (20) < 200 and recomputes cleanly
    const c3 = await runTracedRestore('c3-high-legacy', [dHigh]);
    assert.equal(c3.res.length, 1);
    assert.equal(c3.res[0].seq, 199);
    assert.equal(c3.res[0].by, 200);
    assert.equal(c3.trace.hitCache, true);
    assert.equal(c3.trace.scanned, 201);

    // Call 4 (mid maxBy=150): legacyLastSeq (200) >= 150 reuses cached byMapLegacy with zero scan
    const c4 = await runTracedRestore('c4-mid-legacy-cached', [dMid]);
    assert.equal(c4.res.length, 1);
    assert.equal(c4.res[0].seq, 149);
    assert.equal(c4.res[0].by, 150);
    assert.equal(c4.trace.hitCache, true);
    assert.equal(c4.trace.scanned, 0);

    // Call 5 (drifted non-quote superseded at maxBy=300 while legacyLastSeq=200): stays gated & zero-scan
    const c5 = await runTracedRestore('c5-drift-warm', [dDrift]);
    assert.deepEqual(c5.res, []);
    assert.equal(c5.trace.hitCache, true);
    assert.equal(c5.trace.scanned, 0);

    // Security baseline: missing byFragmentHash STILL fails closed instead of skipping as rule drift
    const badDrift = { ...dDrift };
    delete badDrift.byFragmentHash;
    assert.throws(
      () => restoreRetiredDecisions([badDrift], f.session, 306),
      (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 8. Append-only tail turns reuse replay cache; truncation & early-event tampering still fail closed
await test('append-only-tail-turns-reuse-replay-cache-while-truncation-and-tamper-fail-closed', async () => {
  const root = await mkdtemp(join(process.env.WEAVE_TEST_ROOT ?? tmpdir(), 'weave-issue13-opt8-'));
  try {
    const f = makeSession();
    for (let i = 0; i <= 24; i += 1) {
      f.addUser(`Background entry ${i}.`, 'user', false);
    }
    f.events[10].data.content = [{ type: 'text', text: '生成地图。' }];
    f.events[20].data.content = [{ type: 'text', text: '取消生成地图。' }];

    const dWithSha = {
      reason: 'cancelled',
      seq: 10,
      by: 20,
      fragmentHash: fragDigest('生成地图。'),
      sourcePart: { block: 0, start: 0, end: 5 },
      byFragmentHash: fragDigest('取消生成地图。'),
      sourceSha256: blocksDigest(f.events[10].data.content),
      bySha256: blocksDigest(f.events[20].data.content),
    };

    const runTraced = async (tag, sessionObj, decisions) => {
      const traceDir = join(root, tag);
      const res = await withStageTraceContext(
        { enabled: true, storageRoot: traceDir, sessionId: `s-${tag}` },
        () => restoreRetiredDecisionsBatch([{ checkpointSeq: 25, decisions }], sessionObj),
      );
      const lines = (await readFile(join(traceDir, 'stage-trace.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const endEv = lines.find((l) => l.stage === 'restoreRetiredDecisions' && l.phase === 'end');
      return { res, trace: endEv };
    };

    // Cold populate
    const r1 = await runTraced('r1-cold', f.session, [dWithSha]);
    assert.equal(r1.res.length, 1);
    assert.equal(r1.trace.hitCache, false);
    assert.equal(r1.trace.scanned, 21);

    // Append 5 new turns at tail (replaceGeneration unchanged) -> cache hits cleanly
    for (let i = 0; i < 5; i += 1) f.addUser(`Tail turn ${i}.`, 'user', true);
    const r2 = await runTraced('r2-append5', f.session, [dWithSha]);
    assert.equal(r2.res.length, 1);
    assert.equal(r2.trace.hitCache, true);
    assert.equal(r2.trace.scanned, 0);

    // Append 3 more turns -> still hits cache and advances monotonic cached.sessionSeq
    for (let i = 0; i < 3; i += 1) f.addUser(`More tail ${i}.`, 'user', true);
    const r3 = await runTraced('r3-append3', f.session, [dWithSha]);
    assert.equal(r3.res.length, 1);
    assert.equal(r3.trace.hitCache, true);
    assert.equal(r3.trace.scanned, 0);

    // Truncate tail (session.seq < cached.sessionSeq) -> invalidates cache
    f.events.pop();
    const r4 = await runTraced('r4-truncate', f.session, [dWithSha]);
    assert.equal(r4.res.length, 1);
    assert.equal(r4.trace.hitCache, false);
    assert.equal(r4.trace.scanned, 21);

    // Re-warm with SHA-less legacy decision, append turn, then tamper seq=10 in-place -> fail-closed
    const dNoSha = {
      reason: 'cancelled',
      seq: 10,
      by: 20,
      fragmentHash: fragDigest('生成地图。'),
      sourcePart: { block: 0, start: 0, end: 5 },
      byFragmentHash: fragDigest('取消生成地图。'),
    };
    const rNoShaWarm = await runTraced('r5-nosha-warm', f.session, [dNoSha]);
    assert.equal(rNoShaWarm.res.length, 1);
    assert.equal(rNoShaWarm.trace.hitCache, true);
    assert.equal(rNoShaWarm.trace.scanned, 0);

    f.addUser('Tail before tamper.', 'user', true);
    f.events[10].data.content = [{ type: 'text', text: '生成表格。' }];
    assert.throws(
      () => restoreRetiredDecisionsBatch([{ checkpointSeq: 25, decisions: [dWithSha] }], f.session),
      (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE' && err?.memorySourceReason === 'sha_mismatch',
    );
    assert.throws(
      () => restoreRetiredDecisionsBatch([{ checkpointSeq: 25, decisions: [dNoSha] }], f.session),
      (err) => err?.code === 'MEMORY_SOURCE_UNAVAILABLE',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log(JSON.stringify({ passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, results }, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
