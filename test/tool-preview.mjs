import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { auditCompaction, auditInstructionProvenance } from '../lib/audit.js';
import { approxTokens } from '../lib/meter.js';
import {
  MICROCOMPACT_SUPERSEDED_MARKER,
  OBSERVATION_MASK_MARKER,
  PERSISTED_OUTPUT_MARKER,
  formatMaskedToolText,
} from '../lib/observation-mask.js';
import {
  DEFAULT_PERSISTED_OUTPUT_HEAD_CHARS,
  DEFAULT_PERSISTED_OUTPUT_TAIL_CHARS,
} from '../lib/persisted-output.js';
import { projectSummaryMessage } from '../lib/reference-input.js';
import {
  LARGE_PREVIEW_INPUT_BYTES,
  MAX_JSON_PREVIEW_BYTES,
  buildToolPreview,
  codePointLength,
} from '../lib/tool-preview.js';

const results = [];
async function test(name, fn) {
  const start = performance.now();
  try {
    await fn();
    results.push({ name, pass: true, ms: Math.round(performance.now() - start) });
  } catch (error) {
    results.push({
      name,
      pass: false,
      error: error?.message ?? String(error),
      stack: error?.stack,
    });
  }
}

await test('diagnostic-middle-window-line-numbers-and-no-charOffset', () => {
  const lines = [];
  for (let i = 1; i <= 35; i += 1) {
    lines.push(`[line ${i}] setup step initializing worker pool item ${i} with clean baseline configuration`);
  }
  lines.push('[line 36] summary: 12 passed, 0 failed, 0 errors');
  for (let i = 37; i <= 63; i += 1) {
    lines.push(`[line ${i}] verbose log stream step ${i} executing background migration checks ok`);
  }
  lines.push('[line 64] preparing config payload for user-auth');
  lines.push("[line 65] TypeError: Cannot read properties of undefined (reading 'token')");
  lines.push('[line 66] at verifyToken (src/auth/verify.ts:42:18)');
  for (let i = 67; i <= 92; i += 1) {
    lines.push(`[line ${i}] continuing independent shard ${i} check after first batch`);
  }
  // Duplicate normalized signature must be deduplicated
  lines.push("[line 93] TypeError: Cannot read properties of undefined (reading 'token')");
  for (let i = 94; i <= 108; i += 1) {
    lines.push(`[line ${i}] running typecheck worker ${i} across workspace packages`);
  }
  lines.push('[line 109] compiling api module src/api/server.ts');
  lines.push("src/api/server.ts(42,10): error TS2345: Argument of type 'string' is not assignable");
  lines.push('[line 111] tsc exited with error code 2');
  for (let i = 112; i <= 150; i += 1) {
    lines.push(`[line ${i}] tail cleanup step ${i} flushing diagnostic buffers done`);
  }
  const text = lines.join('\n');

  const preview = buildToolPreview(text, { headChars: 300, tailChars: 300, toolName: 'bash', target: 'npm test' });
  assert.ok(preview);
  assert.equal(preview.kind, 'diagnostic');
  assert.ok(!preview.middle.includes('charOffset'), 'must never emit charOffset');
  assert.ok(preview.middle.includes('[L'), 'must annotate 1-based line numbers');
  assert.ok(preview.middle.includes("TypeError: Cannot read properties of undefined"));
  assert.ok(preview.middle.includes('error TS2345'));
  assert.ok(!preview.middle.includes('0 failed'), 'benign zero counts must be ignored');
  const clusterCount = (preview.middle.match(/\[L\d+/g) ?? []).length;
  assert.ok(clusterCount >= 1 && clusterCount <= 2, `expected <= 2 clusters, got ${clusterCount}`);

  // observation-mask integration
  const obsMasked = formatMaskedToolText(text, {
    compactionId: 'cmp-diag-1',
    seq: 8,
    toolName: 'bash',
    target: 'npm test',
    headChars: 300,
    tailChars: 300,
  });
  assert.ok(obsMasked);
  assert.ok(obsMasked.includes(OBSERVATION_MASK_MARKER));
  assert.ok(obsMasked.includes('preview=diagnostic'));
  assert.ok(!obsMasked.includes('charOffset'));
  assert.ok(obsMasked.includes('history_read({ compactionId: "cmp-diag-1", seq: 8 })'));
  assert.ok(approxTokens(obsMasked) < approxTokens(text));
  assert.ok(Buffer.byteLength(obsMasked, 'utf8') < Buffer.byteLength(text, 'utf8'));

  // persisted-output budget integration
  const bigLines = [...lines];
  while (bigLines.join('\n').length < 36000) {
    const n = bigLines.length + 1;
    bigLines.push(`[line ${n}] filler execution output padding entry number ${n} ok`);
  }
  const bigText = bigLines.join('\n');
  const persistedMasked = formatMaskedToolText(bigText, {
    compactionId: 'cmp-diag-2',
    seq: 12,
    toolName: 'bash',
    target: 'npm test',
    thresholdChars: 32768,
    headChars: DEFAULT_PERSISTED_OUTPUT_HEAD_CHARS,
    tailChars: DEFAULT_PERSISTED_OUTPUT_TAIL_CHARS,
    markerPrefix: PERSISTED_OUTPUT_MARKER,
  });
  assert.ok(persistedMasked);
  assert.ok(persistedMasked.includes(PERSISTED_OUTPUT_MARKER));
  assert.ok(persistedMasked.includes('preview=diagnostic'));
  assert.ok(persistedMasked.includes("TypeError: Cannot read properties of undefined"));
  assert.ok(approxTokens(persistedMasked) < approxTokens(bigText));
  assert.ok(Buffer.byteLength(persistedMasked, 'utf8') < Buffer.byteLength(bigText, 'utf8'));
});

await test('large-input-512kib-caps-scan-at-256kib-and-stays-fast', () => {
  // Error only beyond 600 KiB -> capped scan at 256 KiB skips it and stays fast
  const row = '0123456789abcdef verbose stream log entry ok without incident\n';
  const count = Math.ceil((LARGE_PREVIEW_INPUT_BYTES + 120 * 1024) / row.length);
  const lateError = `${row.repeat(count)}Error: LATE_FAILURE_AT_630K\n${row.repeat(20)}`;
  const t0 = performance.now();
  const latePreview = buildToolPreview(lateError, { headChars: 300, tailChars: 300, toolName: 'bash', target: 'tail.log' });
  const elapsedLate = performance.now() - t0;
  assert.equal(latePreview, null, 'error past 256 KiB scan limit must not be scanned');
  assert.ok(elapsedLate < 150, `scan too slow on >512KiB input: ${elapsedLate.toFixed(1)}ms`);

  // Error inside 100 KiB (< 256 KiB cap) on > 512 KiB input -> detected cleanly
  const prefixCount = Math.ceil((100 * 1024) / row.length);
  const suffixCount = Math.ceil((500 * 1024) / row.length);
  const earlyError =
    `${row.repeat(prefixCount)}Traceback (most recent call last):\nAssertionError: invariant broken\n${row.repeat(suffixCount)}`;
  const t1 = performance.now();
  const hitPreview = buildToolPreview(earlyError, { headChars: 300, tailChars: 300, toolName: 'bash', target: 'pytest' });
  const elapsedHit = performance.now() - t1;
  assert.ok(hitPreview);
  assert.equal(hitPreview.kind, 'diagnostic');
  assert.equal(hitPreview.truncatedScan, true);
  assert.ok(hitPreview.middle.includes('AssertionError: invariant broken'));
  assert.ok(elapsedHit < 150, `diagnostic scan too slow: ${elapsedHit.toFixed(1)}ms`);
});

await test('code-skeleton-allowlist-line-numbers-and-fail-open', () => {
  const numberedTs = [
    '   1 | import { createHash } from "node:crypto";',
    '   2 | import { join } from "node:path";',
    '   3 |',
    '   4 | export interface CompactionOptions {',
    '   5 |   threshold: number;',
    '   6 |   retain: number;',
    '   7 | }',
    '   8 |',
    '   9 | export class EngineRunner {',
    '  10 |   run(input: string) {',
    '  11 |     const a = input.trim();',
    ...Array.from({ length: 85 }, (_, i) => `  ${12 + i} |     const step${i} = a.slice(0, ${(i % 10) + 1});`),
    '  97 |     return a;',
    '  98 |   }',
    '  99 |',
    ' 100 |   async flushState(id: string) {',
    ...Array.from({ length: 30 }, (_, i) => ` ${101 + i} |     const k${i} = createHash("sha256").update(id).digest("hex");`),
    ' 131 |   }',
    ' 132 | }',
    ' 133 |',
    ' 134 | export async function runMainPipeline(cfg: CompactionOptions) {',
    ...Array.from({ length: 20 }, (_, i) => ` ${135 + i} |   const v${i} = join("root", String(${i}));`),
    ' 155 |   return cfg.threshold;',
    ' 156 | }',
  ].join('\n');

  const tsPreview = buildToolPreview(numberedTs, {
    headChars: 400,
    tailChars: 400,
    toolName: 'view_file',
    target: 'src/engine/runner.ts',
  });
  assert.ok(tsPreview);
  assert.equal(tsPreview.kind, 'code-skeleton');
  assert.ok(tsPreview.middle.includes('[L4] export interface CompactionOptions'));
  assert.ok(tsPreview.middle.includes('[L9] export class EngineRunner'));
  assert.ok(tsPreview.middle.includes('[L10] run(input: string)'));
  assert.ok(!tsPreview.middle.includes('const step0'), 'deep body lines must be excluded');
  assert.ok(!tsPreview.middle.includes('charOffset'));

  // reference-input projectSummaryMessage resolves { toolName, target } from preceding tool/call
  const callEvent = {
    seq: 1,
    type: 'tool/call',
    data: { callId: 'c-code', name: 'view_file', arguments: JSON.stringify({ path: 'src/engine/runner.ts' }) },
  };
  const resultEvent = {
    seq: 2,
    type: 'tool/result',
    sourceEventSeqs: [1],
    data: { message: { role: 'tool', toolCallId: 'c-code', content: [{ type: 'text', text: numberedTs }] } },
  };
  const session = { eventAt: (s) => (s === 1 ? callEvent : s === 2 ? resultEvent : undefined) };
  const projected = projectSummaryMessage(session, resultEvent, resultEvent.data.message);
  const projectedText = projected.content[0].text;
  assert.ok(projectedText.includes('Tool output projected for summary (code-skeleton)'));
  assert.ok(projectedText.includes('[L9] export class EngineRunner'));

  // Same content with non-code extension (.log) or non-read shell command -> must NOT trigger code-skeleton
  assert.equal(
    buildToolPreview(numberedTs, { headChars: 400, tailChars: 400, toolName: 'view_file', target: 'build.log' }),
    null,
  );
  assert.equal(
    buildToolPreview(numberedTs, { headChars: 400, tailChars: 400, toolName: 'bash', target: 'npm test runner.ts' }),
    null,
  );

  // < 2 declarations -> fail open to null
  const singleDecl = [
    'import { ok } from "node:assert";',
    'export function onlyOne() {',
    ...Array.from({ length: 120 }, (_, i) => `  const line_${i} = "padding_${i}";`),
    '}',
  ].join('\n');
  assert.equal(
    buildToolPreview(singleDecl, { headChars: 300, tailChars: 300, toolName: 'view_file', target: 'single.js' }),
    null,
  );
});

await test('json-outline-2-level-and-160kib-cap', () => {
  const largeObj = {
    sessionId: 'sess-alpha-1',
    status: 'ready',
    metrics: { total: 420, passed: 418, failed: 0, deep: { ignored: 'hidden' } },
    items: Array.from({ length: 60 }, (_, i) => ({
      id: `item-${i}`,
      name: `Worker ${i}`,
      payload: 'X'.repeat(120),
    })),
    extraOne: 'alpha',
    extraTwo: 'beta',
  };
  const jsonText = JSON.stringify(largeObj, null, 2);
  assert.ok(jsonText.length > 4000 && Buffer.byteLength(jsonText, 'utf8') < MAX_JSON_PREVIEW_BYTES);

  const objPreview = buildToolPreview(jsonText, { headChars: 300, tailChars: 300, toolName: 'bash', target: 'curl api' });
  assert.ok(objPreview);
  assert.equal(objPreview.kind, 'json-outline');
  assert.ok(objPreview.middle.includes('JSON object ('));
  assert.ok(objPreview.middle.includes('metrics: object('));
  assert.ok(objPreview.middle.includes('items: array(len=60'));
  assert.ok(!objPreview.middle.includes('ignored'), 'must not recurse past level 2');

  const largeArr = Array.from({ length: 80 }, (_, i) => ({ seq: i, kind: 'msg', body: 'Y'.repeat(120) }));
  const arrText = JSON.stringify(largeArr, null, 2);
  const arrPreview = buildToolPreview(arrText, { headChars: 300, tailChars: 300, toolName: 'bash', target: 'dump.json' });
  assert.ok(arrPreview);
  assert.equal(arrPreview.kind, 'json-outline');
  assert.ok(arrPreview.middle.includes('JSON array (length=80):'));
  assert.ok(arrPreview.middle.includes('[0]:'));
  assert.ok(arrPreview.middle.includes('[79]:'));

  // > 160 KiB JSON -> null (skip JSON.parse)
  const hugeJson = JSON.stringify({ data: Array.from({ length: 1200 }, (_, i) => ({ k: i, s: 'Z'.repeat(180) })) });
  assert.ok(Buffer.byteLength(hugeJson, 'utf8') > MAX_JSON_PREVIEW_BYTES);
  assert.equal(buildToolPreview(hugeJson, { headChars: 300, tailChars: 300 }), null);

  // Malformed JSON -> fail open null
  assert.equal(buildToolPreview('{ "broken": ' + 'x'.repeat(5000), { headChars: 300, tailChars: 300 }), null);
});

await test('dual-shrink-token-and-utf8-bytes-hard-gate', () => {
  // Choose parameters near budget limit where classic marker adds more bytes/tokens than omitted chars
  const tightText = 'A'.repeat(4005);
  const tooLargeMask = formatMaskedToolText(tightText, {
    compactionId: 'cmp-tight',
    seq: 3,
    thresholdChars: 4000,
    headChars: 1980,
    tailChars: 1980,
  });
  assert.equal(tooLargeMask, null, 'must refuse mask when tokens or UTF-8 bytes fail to strictly shrink');

  // Verify shrink strictly in both metrics on normal threshold
  const huge = 'Z'.repeat(6000);
  const shrunk = formatMaskedToolText(huge, {
    compactionId: 'cmp-ok',
    seq: 4,
    thresholdChars: 4000,
    headChars: 300,
    tailChars: 300,
  });
  assert.ok(shrunk);
  assert.ok(approxTokens(shrunk) < approxTokens(huge));
  assert.ok(Buffer.byteLength(shrunk, 'utf8') < Buffer.byteLength(huge, 'utf8'));
  assert.ok(codePointLength(shrunk) < codePointLength(huge));
});

await test('reference-input-never-double-truncates-archived-stubs-and-audit-clean', () => {
  for (const prefix of [OBSERVATION_MASK_MARKER, PERSISTED_OUTPUT_MARKER]) {
    const stub = `${prefix}c1 seq=5; omitted 9000 chars of 10000. Call history_read({ compactionId: "c1", seq: 5 }) if exact output is needed.]\n${'Q'.repeat(4500)}`;
    const ev = {
      seq: 5,
      type: 'tool/result',
      data: { message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: stub }] } },
    };
    const projected = projectSummaryMessage({ eventAt: () => ev }, ev, ev.data.message);
    assert.ok(!projected.content[0].text.includes('Tool output projected for summary'), 'must not double-truncate archived stub');
    assert.ok(projected.content[0].text.includes(stub));
  }

  const microStub = `${MICROCOMPACT_SUPERSEDED_MARKER}src/a.js at seq 2 superseded by seq 9; Call history_read({ compactionId: "c1", seq: 2 }) if needed.]\n${'W'.repeat(4500)}`;
  const microEv = {
    seq: 2,
    type: 'tool/result',
    data: { message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: microStub }] } },
  };
  const microProjected = projectSummaryMessage({ eventAt: () => microEv }, microEv, microEv.data.message);
  assert.ok(!microProjected.content[0].text.includes('Tool output projected for summary'));

  // Preview wrapped inside referenceMessages must not cause auditCompaction / auditInstructionProvenance false positives
  const diagText = [
    ...Array.from({ length: 40 }, (_, i) => `setup ${i} log line with baseline initialization details`),
    'Error: socket hang up while reaching staging host',
    ...Array.from({ length: 200 }, (_, i) => `more ${i} filler line text ok during staging check`),
  ].join('\n');
  const masked = formatMaskedToolText(diagText, { compactionId: 'c-audit', seq: 7, toolName: 'bash', target: 'curl' });
  assert.ok(masked);
  const summaryText = [
    '## 1. Current Task',
    'Investigate staging failure shown in tool output.',
    '## 2. Active User Requirements',
    '- seq 1: Keep production read-only.',
    '## 3. Completed Progress',
    'Collected diagnostic log snippet.',
    '## 6. All User Messages',
    '- seq 1: Keep production read-only.',
  ].join('\n');
  const userMessages = [{ seq: 1, text: 'Keep production read-only.' }];
  const referenceMessages = [{ seq: 7, text: `<untrusted_reference seq="7" kind="tool-result">\n${masked}\n</untrusted_reference>` }];

  const audit = auditCompaction({ userMessages, summaryText, checkpointText: summaryText, referenceMessages });
  assert.equal(audit.lost.length, 0);
  assert.equal(audit.polarityFlips, 0);
  const prov = auditInstructionProvenance({ userMessages, referenceMessages, summaryText });
  assert.equal(prov.length, 0);
});

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
console.log(JSON.stringify({ passed, failed, results }, null, 2));
if (failed > 0) process.exitCode = 1;
