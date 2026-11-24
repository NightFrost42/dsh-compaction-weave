import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_ANCHORS_PER_MESSAGE,
  MAX_GROUNDED_ENTRIES_PER_SPAN,
  MAX_VALID_EPOCH_MS,
  MIN_VALID_EPOCH_MS,
  extractDateGroundings,
  formatInlineDateGrounding,
  renderDateGrounding,
} from '../lib/date-grounding.js';
import { CompactionArchive, spanEntries } from '../lib/history.js';
import { buildSummarizationInput } from '../lib/region.js';
import { buildSummaryRequest } from '../lib/summary-budget.js';
import { __test as toolsTest } from '../lib/tools.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error?.message ?? String(error), stack: error?.stack });
  }
}

// 2026-11-24T20:00:00.000Z:
// - At UTC (offset 0): Tuesday 2026-11-24
// - At UTC+8 (offset 480): Wednesday 2026-11-25
const TS_TUE_UTC = Date.UTC(2026, 10, 24, 20, 0, 0);
// 2026-11-29T12:00:00.000Z -> Sunday 2026-11-29 in UTC
const TS_SUN_UTC = Date.UTC(2026, 10, 29, 12, 0, 0);

await test('cn-relative-dates-fixed-offsets-days-and-iso-weeks', () => {
  const res = extractDateGroundings('前天改了配置，昨天测试，昨晚报警，今天上线，今晚观察。', TS_TUE_UTC, {
    tzOffsetMinutes: 0,
    maxAnchors: 10,
  });
  assert.equal(res.anchorDate, '2026-11-24');
  assert.deepEqual(res.anchors, [
    { phrase: '前天', date: '2026-11-22' },
    { phrase: '昨天', date: '2026-11-23' },
    { phrase: '昨晚', date: '2026-11-23' },
    { phrase: '今天', date: '2026-11-24' },
    { phrase: '今晚', date: '2026-11-24' },
  ]);

  const res2 = extractDateGroundings('今早今日明天明早明晚明日后天大后天 3天前 10 天后', TS_TUE_UTC, {
    tzOffsetMinutes: 0,
    maxAnchors: 12,
  });
  assert.deepEqual(res2.anchors, [
    { phrase: '今早', date: '2026-11-24' },
    { phrase: '今日', date: '2026-11-24' },
    { phrase: '明天', date: '2026-11-25' },
    { phrase: '明早', date: '2026-11-25' },
    { phrase: '明晚', date: '2026-11-25' },
    { phrase: '明日', date: '2026-11-25' },
    { phrase: '后天', date: '2026-11-26' },
    { phrase: '大后天', date: '2026-11-27' },
    { phrase: '3天前', date: '2026-11-21' },
    { phrase: '10 天后', date: '2026-12-04' },
  ]);

  // ISO Monday-start week math on Tuesday 2026-11-24 and Sunday 2026-11-29
  const wkTue = extractDateGroundings('本周一 这周日 上周五 下星期三 上星期天 本星期六', TS_TUE_UTC, {
    tzOffsetMinutes: 0,
    maxAnchors: 10,
  });
  assert.deepEqual(wkTue.anchors, [
    { phrase: '本周一', date: '2026-11-23' },
    { phrase: '这周日', date: '2026-11-29' },
    { phrase: '上周五', date: '2026-11-20' },
    { phrase: '下星期三', date: '2026-12-02' },
    { phrase: '上星期天', date: '2026-11-22' },
    { phrase: '本星期六', date: '2026-11-28' },
  ]);

  const wkSun = extractDateGroundings('本周一 上周日 下周一', TS_SUN_UTC, {
    tzOffsetMinutes: 0,
    maxAnchors: 10,
  });
  assert.equal(wkSun.anchorDate, '2026-11-29');
  assert.deepEqual(wkSun.anchors, [
    { phrase: '本周一', date: '2026-11-23' },
    { phrase: '上周日', date: '2026-11-22' },
    { phrase: '下周一', date: '2026-11-30' },
  ]);

  // Out-of-range / decimal / compound non-date CN words must not false-trigger
  assert.equal(
    extractDateGroundings('0天前 366天前 1000天前 第3天前 1.5天前 后天性免疫 大前天', TS_TUE_UTC, {
      tzOffsetMinutes: 0,
    }),
    null,
  );
});

await test('en-relative-dates-tzoffset-and-word-boundaries', () => {
  // tzOffsetMinutes: +480 shifts 2026-11-24T20:00Z -> Wednesday 2026-11-25!
  const res = extractDateGroundings(
    'Yesterday we patched it, Today/tonight we test, Tomorrow we deploy, and in 5 days we audit.',
    TS_TUE_UTC,
    { tzOffsetMinutes: 480, maxAnchors: 10 },
  );
  assert.equal(res.anchorDate, '2026-11-25');
  assert.deepEqual(res.anchors, [
    { phrase: 'Yesterday', date: '2026-11-24' },
    { phrase: 'Today', date: '2026-11-25' },
    { phrase: 'tonight', date: '2026-11-25' },
    { phrase: 'Tomorrow', date: '2026-11-26' },
    { phrase: 'in 5 days', date: '2026-11-30' },
  ]);

  // `logged in 3 days ago` must match `3 days ago` (-3), NOT `in 3 days` (+3)!
  const enWeekAndAgo = extractDateGroundings(
    'User logged in 3 days ago; next Monday and last Friday vs this Sunday.',
    TS_TUE_UTC,
    { tzOffsetMinutes: 0, maxAnchors: 10 },
  );
  assert.deepEqual(enWeekAndAgo.anchors, [
    { phrase: '3 days ago', date: '2026-11-21' },
    { phrase: 'next Monday', date: '2026-11-30' },
    { phrase: 'last Friday', date: '2026-11-20' },
    { phrase: 'this Sunday', date: '2026-11-29' },
  ]);

  // Word boundaries, identifiers, decimals, and >365 bounds
  assert.equal(
    extractDateGroundings('today_backup 0 days ago in 366 days 1.5 days ago yesterdayish', TS_TUE_UTC, {
      tzOffsetMinutes: 0,
    }),
    null,
  );
});

await test('code-fences-and-inline-backticks-are-masked-safely', () => {
  const mixed = [
    '```js',
    'const msg = "yesterday and tomorrow and 明天";',
    '```',
    '~~~txt',
    '3 days ago and 本周一',
    '~~~',
    'Inline `today` and ``in 2 days`` stay masked, stray ` does not block 昨天.',
  ].join('\n');

  const inline = formatInlineDateGrounding(mixed, TS_TUE_UTC, { tzOffsetMinutes: 0 });
  assert.equal(inline, '昨天=2026-11-23');

  // Unclosed code fence to EOF masks remaining lines
  const unclosed = '```md\nyesterday\ntomorrow';
  assert.equal(formatInlineDateGrounding(unclosed, TS_TUE_UTC, { tzOffsetMinutes: 0 }), '');
});

await test('mock-missing-nonfinite-and-out-of-range-timestamps-return-null-or-empty', () => {
  for (const badTs of [undefined, null, NaN, Infinity, -1, 0, 1000, MIN_VALID_EPOCH_MS - 1, MAX_VALID_EPOCH_MS + 1, '2026-11-24']) {
    assert.equal(extractDateGroundings('yesterday 明天', badTs, { tzOffsetMinutes: 0 }), null);
    assert.equal(formatInlineDateGrounding('yesterday 明天', badTs, { tzOffsetMinutes: 0 }), '');
  }
  assert.ok(extractDateGroundings('today', MIN_VALID_EPOCH_MS, { tzOffsetMinutes: 0 }));
  assert.ok(extractDateGroundings('today', MAX_VALID_EPOCH_MS, { tzOffsetMinutes: 0 }));
});

await test('caps-4-anchors-per-message-and-12-entries-per-span-skipping-system-and-checkpoints', () => {
  assert.equal(MAX_ANCHORS_PER_MESSAGE, 4);
  assert.equal(MAX_GROUNDED_ENTRIES_PER_SPAN, 12);

  // Deduplication prevents repeated phrase from burning anchor slots, and caps at 4
  const capped = extractDateGroundings('昨天 昨天 前天 今天 明天 后天 大后天', TS_TUE_UTC, {
    tzOffsetMinutes: 0,
  });
  assert.equal(capped.anchors.length, 4);
  assert.deepEqual(
    capped.anchors.map((a) => a.phrase),
    ['昨天', '前天', '今天', '明天'],
  );

  // Span with system/message, compact-checkpoint, mock ts=1000, and 15 valid messages -> max 12 entries
  const events = [
    { seq: 0, time: TS_TUE_UTC, type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'yesterday system' }] } } },
    { seq: 1, time: TS_TUE_UTC, type: 'user/message', data: { role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'yesterday checkpoint' }] } },
    { seq: 2, time: 1000, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'yesterday mock time' }] } },
  ];
  for (let i = 3; i < 18; i += 1) {
    events.push({
      seq: i,
      time: TS_TUE_UTC,
      type: i % 2 === 0 ? 'assistant/message' : 'user/message',
      data:
        i % 2 === 0
          ? { message: { role: 'assistant', content: [{ type: 'text', text: `Msg ${i} tomorrow` }] } }
          : { role: 'user', content: [{ type: 'text', text: `Msg ${i} 昨天` }] },
    });
  }
  const session = {
    eventAt: (seq) => events[seq],
    deriveEventMessage: (e) => e?.data?.message ?? e?.data,
  };
  const block = renderDateGrounding(session, events.map((e) => e.seq), { tzOffsetMinutes: 0 });
  assert.ok(block.startsWith('<date-grounding>\n') && block.endsWith('\n</date-grounding>'));
  const lines = block.split('\n').slice(1, -1);
  assert.equal(lines.length, 12);
  assert.equal(block.includes('seq 0 ('), false);
  assert.equal(block.includes('seq 1 ('), false);
  assert.equal(block.includes('seq 2 ('), false);
  assert.ok(lines[0].startsWith('seq 6 (2026-11-24):'));
  assert.ok(lines.at(-1).startsWith('seq 17 (2026-11-24):'));
});

await test('preservePrefixCache-keeps-prefix-messages-byte-identical-while-tail-carries-dateGrounding', () => {
  const sysMsg = { role: 'system', content: [{ type: 'text', text: 'System prompt.' }] };
  const events = [
    { seq: 0, time: TS_TUE_UTC, type: 'system/message', data: { message: sysMsg } },
    { seq: 1, time: TS_TUE_UTC, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'Prefix message without dates.' }] } },
    { seq: 2, time: TS_TUE_UTC, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '昨天发现问题，明天修复。' }] } },
    { seq: 3, time: TS_TUE_UTC, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '收到，将在明天处理。' }] } } },
  ];
  const surface = { nodes: [0, 1, 2, 3], replaceGeneration: 0 };
  const session = {
    id: 'sess-dg-cache',
    surface,
    eventAt: (seq) => events[seq],
    deriveEventMessage: (e) => e?.data?.message ?? e?.data,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  };

  const withDates = buildSummarizationInput(session, [2, 3], { preservePrefixCache: true, tzOffsetMinutes: 0 });
  assert.ok(withDates.dateGrounding.includes('<date-grounding>'));
  assert.ok(withDates.dateGrounding.includes('昨天=2026-11-23, 明天=2026-11-25'));

  // Comparing against identical prefix messages without dates proves prefix messages stay byte-identical
  const cleanEvents = events.map((e) =>
    e.seq >= 2
      ? {
          ...e,
          data:
            e.type === 'assistant/message'
              ? { message: { role: 'assistant', content: [{ type: 'text', text: '收到，将在明天处理。' }] } }
              : { role: 'user', content: [{ type: 'text', text: '昨天发现问题，明天修复。' }] },
        }
      : e,
  );
  const cleanSession = { ...session, eventAt: (seq) => cleanEvents[seq] };
  const rawInput = buildSummarizationInput(cleanSession, [2, 3], { preservePrefixCache: true, tzOffsetMinutes: 0 });
  assert.equal(JSON.stringify(withDates.messages), JSON.stringify(rawInput.messages));

  // Verify buildSummaryRequest places <date-grounding> strictly in the trailing user instruction message
  const req = buildSummaryRequest(withDates, { language: 'zh', userMessages: [] });
  assert.equal(JSON.stringify(req.messages.slice(0, -1)), JSON.stringify(withDates.messages));
  const tailText = req.messages.at(-1).content[0].text;
  assert.ok(tailText.includes('<date-grounding>'));
  assert.ok(tailText.includes('昨天=2026-11-23, 明天=2026-11-25'));
});

await test('history_read-appends-inline-date-grounding-without-mutating-raw-json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-date-grounding-'));
  try {
    const events = [
      {
        seq: 1,
        time: TS_TUE_UTC,
        type: 'user/message',
        data: {
          role: 'user',
          content: [{ type: 'text', text: '昨天改了端口，明天回归测试。' }],
          source: { kind: 'user' },
        },
      },
    ];
    const source = {
      id: 'sess-dg-history',
      eventAt: (seq) => events.find((e) => e.seq === seq),
      deriveEventMessage: (e) => e?.data,
    };
    const archive = new CompactionArchive({ root });
    const entries = spanEntries(source, [1]);
    await archive.writeSpan({ sessionId: source.id, compactionId: 'cmp-dg', entries });

    const normalOut = await toolsTest.runTool(
      'history_read',
      archive,
      { compactionId: 'cmp-dg', seq: 1 },
      { session: { id: source.id } },
    );
    const expectedYesterday = formatInlineDateGrounding('昨天改了端口，明天回归测试。', TS_TUE_UTC);
    assert.ok(normalOut.includes(`date-grounding: ${expectedYesterday}`), `got: ${normalOut}`);

    const rawOut = await toolsTest.runTool(
      'history_read',
      archive,
      { compactionId: 'cmp-dg', seq: 1, raw: true },
      { session: { id: source.id } },
    );
    const parsedRaw = JSON.parse(rawOut);
    const rawEntry = JSON.parse(parsedRaw.jsonChunk);
    assert.equal(rawEntry.text, '昨天改了端口，明天回归测试。');
    assert.equal(rawEntry.event.time, TS_TUE_UTC);
    assert.equal('dateGrounding' in rawEntry, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('buildSummarizationInput-non-verbatim-preserves-last-2-assistant-messages-via-recentAssistantSeqs', () => {
  const filler = 'Verbose filler commentary about nothing technical in particular. '.repeat(60);
  assert.ok(filler.length > 2400);
  const events = [
    { seq: 0, time: TS_TUE_UTC, type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'System.' }] } } },
    { seq: 1, time: TS_TUE_UTC, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: `OLD_A1 ${filler}` }] } } },
    { seq: 2, time: TS_TUE_UTC, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'User turn.' }] } },
    { seq: 3, time: TS_TUE_UTC, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: `RECENT_A2 ${filler}` }] } } },
    { seq: 4, time: TS_TUE_UTC, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: `RECENT_A3 ${filler}` }] } } },
  ];
  const session = {
    id: 'sess-recent-assistant',
    surface: { nodes: [0, 1, 2, 3, 4], replaceGeneration: 0 },
    eventAt: (seq) => events[seq],
    deriveEventMessage: (e) => e?.data?.message ?? e?.data,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  };

  const input = buildSummarizationInput(session, [1, 2, 3, 4], { preservePrefixCache: false });
  // messages[0]=system, messages[1]=OLD_A1, messages[2]=User, messages[3]=RECENT_A2, messages[4]=RECENT_A3
  assert.equal(input.messages[3].content[0].text, `RECENT_A2 ${filler}`);
  assert.equal(input.messages[4].content[0].text, `RECENT_A3 ${filler}`);
});

console.log(JSON.stringify({ passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, results }, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
