import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AUDIT_FALLBACK_SKIP_REASONS, diagnoseHeuristicFallbackVerdict } from '../lib/audit-fallback.js';
import { auditCompaction } from '../lib/audit.js';
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { CompactionArchive } from '../lib/history.js';
import { apply as applyGate, countEngineRows, injectBesideOfficial } from '../lib/index.js';
import {
  approxTokens,
  blocksToText,
  estimateHostHeuristicMessage,
  estimateHostHeuristicSpan,
} from '../lib/meter.js';
import { commitObservationMask, planObservationMask } from '../lib/observation-mask.js';
import { buildCompactionInstruction } from '../lib/prompt.js';
import { commitSnip, planSnip } from '../lib/snip.js';
import { SessionStateStore } from '../lib/state.js';
import {
  assertSummaryCapacity,
  buildSummaryRequest,
  byteRequestLimit,
  capacityByteLimit,
  capacityTokenLimit,
  fitsCapacity,
  measureSummaryRange,
  observeSummaryOverflow,
  planSummaryRange,
  resolveSummaryCapacity,
  tokenRequestLimit,
} from '../lib/summary-budget.js';
import { resolveSummaryTargets } from '../lib/summary.js';
import { StockTransactionAdapter } from '../lib/transaction.js';
import {
  forgetLockedWindow,
  isPollutedWindowRecord,
  lockWindow,
  peekLockedWindow,
  resetWindowCache,
} from '../lib/window.js';

const results = [];
async function test(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, pass: true, ms: Date.now() - started });
  } catch (error) {
    results.push({
      name,
      pass: false,
      ms: Date.now() - started,
      error: error?.message ?? String(error),
      stack: error?.stack,
    });
  }
}

const TEST_BASE = process.env.WEAVE_TEST_ROOT ?? tmpdir();
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ZH_HEADINGS = buildCompactionInstruction('zh')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));
const EN_HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeSummary(sections = {}, language = 'en') {
  const headings = language === 'zh' ? ZH_HEADINGS : EN_HEADINGS;
  const fallback =
    language === 'zh'
      ? '已完成历史归档整理，按约束继续。'
      : 'Historical span archived cleanly; continue below.';
  const placeholder = language === 'zh' ? '[由引擎填充]' : '[filled by engine]';
  return headings
    .map((h, idx) => {
      if (idx === 5) return `${h}\n${sections[6] ?? placeholder}`;
      const body = sections[idx + 1] ?? (idx === 8 ? sections.body : undefined) ?? fallback;
      return `${h}\n${body}`;
    })
    .join('\n\n');
}

function createSynthFixture({
  language = 'en',
  windowTokens = 200000,
  extraConfig = {},
  streamHandler,
  onFlush,
  openTurn = null,
} = {}) {
  const sessionId = `w1-${randomUUID().slice(0, 8)}`;
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const calls = [];
  const logs = [];
  const state = { flushes: 0 };

  const session = {
    id: sessionId,
    header: { version: 4, id: sessionId, createdAt: Date.now(), isSeeded: false },
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => [...events],
    requestHeader: () => ({ config: { provider: 'p', model: 'm', maxTokens: 4096 }, tools: [] }),
    toolHistory: () => [],
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (event.type === 'system/message') return event.data?.message ?? event.data;
      if (event.type === 'user/message') return event.data;
      if (event.type === 'assistant/message') return event.data?.message;
      if (event.type === 'tool/result') {
        const msg = event.data?.message ?? event.data;
        return {
          role: 'tool',
          toolCallId: msg.toolCallId ?? msg.source?.callId,
          content: msg.content,
          ...(msg.isError ? { isError: true } : {}),
        };
      }
      return undefined;
    },
    append(type, data, options = {}) {
      const event = {
        seq: events.length,
        time: Date.now() + events.length,
        type,
        data,
        ...(options.surfaceOp !== undefined ? { surfaceOp: options.surfaceOp } : {}),
        ...(Array.isArray(options.sourceEventSeqs) ? { sourceEventSeqs: [...options.sourceEventSeqs] } : {}),
      };
      events.push(event);
      if (options.surfaceOp?.op === 'replace') {
        const s = surface.nodes.indexOf(options.surfaceOp.startSeq);
        const e = surface.nodes.indexOf(options.surfaceOp.endSeq);
        assert.ok(s >= 0 && e >= s, `invalid replace range ${options.surfaceOp.startSeq}..${options.surfaceOp.endSeq}`);
        surface.nodes.splice(s, e - s + 1, event.seq);
        surface.replaceGeneration += 1;
      } else if (options.surfaceOp === 'append') {
        surface.nodes.push(event.seq);
      }
      return event;
    },
  };

  const addSystem = (text) =>
    session.append(
      'system/message',
      { message: { id: randomUUID(), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } } },
      { surfaceOp: 'append' },
    );

  const addUser = (text, sourceKind = 'user') =>
    session.append(
      'user/message',
      { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: sourceKind } },
      { surfaceOp: 'append' },
    );

  const addAssistant = (text) =>
    session.append(
      'assistant/message',
      { message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } } },
      { surfaceOp: 'append' },
    );

  const addToolPair = (toolName, args, outputText) => {
    const callId = `call_${randomUUID().slice(0, 8)}`;
    const callEv = session.append(
      'assistant/message',
      {
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'tool-call', callId, name: toolName, toolName, arguments: JSON.stringify(args), args }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
      { surfaceOp: 'append' },
    );
    const resEv = session.append(
      'tool/result',
      {
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: callId,
          content: [{ type: 'text', text: outputText }],
          source: { kind: 'tool', toolName, callId },
        },
      },
      { surfaceOp: 'append' },
    );
    return { callEv, resEv };
  };

  if (openTurn !== null) {
    session.append('turn/start', { turn: openTurn });
  }

  return (async () => {
    const root = await mkdtemp(join(TEST_BASE, 'weave-wave1-'));
    const sessionDir = join(root, 'host-sessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const logPath = join(sessionDir, 'session.v4.jsonl');
    writeFileSync(logPath, `{"version":4,"id":"${sessionId}"}\n`, 'utf8');

    const agent = {
      session,
      options: { provider: 'p', model: 'm' },
      runMaintenance: (fn) => fn(new AbortController().signal),
      cancel() {},
    };

    const ctx = {
      on() {
        return () => {};
      },
      provide() {},
      logger: {
        info: (m) => logs.push({ level: 'info', msg: String(m) }),
        warn: (m) => logs.push({ level: 'warn', msg: String(m) }),
        error: (m) => logs.push({ level: 'error', msg: String(m) }),
      },
      sessions: {
        flush: async () => {
          state.flushes += 1;
          await onFlush?.({ session, state });
          return true;
        },
        get: (id) => (id === sessionId ? session : undefined),
      },
      sessionPersistence: {
        locate: () => ({ kind: 'jsonl', path: logPath }),
      },
      tokenMeter: {
        measure(s) {
          const nodes = s.surface.nodes.map((seq) => ({
            seq,
            tokens: approxTokens(blocksToText(s.deriveEventMessage(s.eventAt(seq))?.content)),
          }));
          return { nodes, totalTokens: nodes.reduce((a, b) => a + b.tokens, 0), precision: 'priced' };
        },
      },
      llm: {
        async resolveModelInfo() {
          return { contextWindow: windowTokens };
        },
        async *stream(req, signal = req?.signal) {
          calls.push(req);
          const effectiveSignal = signal ?? req?.signal;
          const out = await streamHandler(req, calls.length, effectiveSignal);
          if (typeof out === 'string') {
            yield { type: 'text-delta', text: out };
            yield { type: 'finish', reason: { kind: 'stop' } };
          } else {
            yield* out;
          }
        },
      },
    };

    const config = resolveConfig({
      archiveDir: join(root, 'weave', 'archive'),
      language,
      failureThreshold: 3,
      summaryRetryCount: 1,
      summaryRetryDelayMs: 0,
      observationMaskingEnabled: false,
      microcompactEnabled: false,
      proactiveEnabled: false,
      continuationEnabled: false,
      ...extraConfig,
    }).config;

    const engine = new WeaveCompactionEngine(ctx, config);
    engine.historyToolsAvailable = true;

    return {
      root,
      session,
      agent,
      engine,
      events,
      surface,
      calls,
      logs,
      state,
      addSystem,
      addUser,
      addAssistant,
      addToolPair,
      async cleanup() {
        engine.dispose();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
      },
    };
  })();
}

function findHostModules(requiredPkg) {
  const candidates = [
    process.env.DSH_TEST_NODE_MODULES,
    join(REPO_ROOT, '.local/four-way-live-benchmark-20261118/host-runtime/node_modules'),
    join(REPO_ROOT, '.local/source-boundary-work-20261116/host-runtime/node_modules'),
  ].filter(Boolean);
  for (const root of candidates) {
    if (existsSync(join(root, '@deepseek-ai', requiredPkg, 'package.json'))) {
      return root;
    }
  }
  return null;
}

// ── Item 1: Hard polarity redline + compound comma clause + Case 3 ──────────────

await test('1-hard-polarity-banned-from-fallback-and-compound-comma-case2-case3-enforced', async () => {
  assert.ok(AUDIT_FALLBACK_SKIP_REASONS.includes('hard_polarity'));
  const v = diagnoseHeuristicFallbackVerdict({
    ok: false,
    code: 'CONSTRAINT_POLARITY_LOST',
    audit: { lost: [{ seq: 1, reason: 'polarity', line: '绝对不要修改 auth.js 文件', candidate: '可以修改 auth.js 文件。' }] },
  });
  assert.equal(v.eligible, false);
  assert.equal(v.skippedReason, 'hard_polarity');

  const commaRule = '绝对不要修改 auth.js 文件，必须保持所有对外接口不变。';
  const poisonedBase = makeSummary({
    1: '整理系统改造进度。',
    2: 'auth.js、接口兼容性',
    3: '- auth.js',
    4: '(无)',
    5: '- 确认可以修改 auth.js 文件以快速推进重构。',
    7: '- 推进重构',
    8: '- 完成初审',
    9: '- 可以修改 auth.js 文件。',
  }, 'zh');

  // Benign split across two separate bullets passes cleanly without false positive
  const cleanSplit = makeSummary({
    1: '绝对不要修改 auth.js 文件。\n必须保持所有对外接口不变。',
  }, 'zh');
  const cleanAudit = auditCompaction({
    userMessages: [{ seq: 1, text: commaRule }],
    summaryText: cleanSplit,
    checkpointText: `${cleanSplit}\n\n${commaRule}`,
    includeAllConflicts: true,
  });
  assert.equal(cleanAudit.polarityFlips, 0);

  // Symmetric sub-clause narrowing in conflictForPair (parenthetical/enumerated ordinals)
  const parentheticalSource = '第 2 轮代码审查继续（保持 prodTimeoutSec: 60、不改 auth.js、Forbid force-push）：';
  const parenCleanZh = makeSummary({
    5: '- 保持 prodTimeoutSec: 60\n- 不改 auth.js\n- Forbid force-push',
  }, 'zh');
  const parenAuditZh = auditCompaction({
    userMessages: [{ seq: 2, text: parentheticalSource }],
    summaryText: parenCleanZh,
    checkpointText: parenCleanZh,
    includeAllConflicts: true,
  });
  assert.equal(parenAuditZh.lost.length, 0, 'parenthetical ordinal must not false-trigger value conflict in ZH');

  const parenCleanEn = makeSummary({
    5: '- Strictly keep prodTimeoutSec: 60\n- 不改 auth.js\n- Forbid force-push',
  }, 'en');
  const parenAuditEn = auditCompaction({
    userMessages: [{ seq: 2, text: parentheticalSource }],
    summaryText: parenCleanEn,
    checkpointText: parenCleanEn,
    threshold: 0.6,
    includeAllConflicts: true,
  });
  assert.equal(
    parenAuditEn.lost.some((l) => l.reason === 'value' || l.reason === 'polarity'),
    false,
    'parenthetical ordinal must not false-trigger value/polarity in EN summary',
  );

  const parenWrongVal = makeSummary({
    5: '- 保持 prodTimeoutSec: 30\n- 不改 auth.js\n- Forbid force-push',
  }, 'zh');
  const parenValAudit = auditCompaction({
    userMessages: [{ seq: 2, text: parentheticalSource }],
    summaryText: parenWrongVal,
    checkpointText: parenWrongVal,
    includeAllConflicts: true,
  });
  assert.ok(parenValAudit.lost.some((l) => l.reason === 'value'), 'changed scalar value must still trigger value conflict');

  const parenFlipped = makeSummary({
    5: '- 保持 prodTimeoutSec: 60\n- 可以改 auth.js\n- Forbid force-push',
  }, 'zh');
  const parenFlipAudit = auditCompaction({
    userMessages: [{ seq: 2, text: parentheticalSource }],
    summaryText: parenFlipped,
    checkpointText: parenFlipped,
    includeAllConflicts: true,
  });
  assert.ok(parenFlipAudit.lost.some((l) => l.reason === 'polarity'), 'flipped enumerated ban must still trigger polarity conflict');

  const forbidFlipSum = makeSummary({ 5: '- Allow force-push' }, 'en');
  const forbidFlipAudit = auditCompaction({
    userMessages: [{ seq: 20, text: 'Forbid force-push' }],
    summaryText: forbidFlipSum,
    checkpointText: forbidFlipSum,
    includeAllConflicts: true,
  });
  assert.ok(forbidFlipAudit.lost.some((l) => l.reason === 'polarity'), 'Forbid -> Allow must trigger polarity conflict');

  const compoundTwoNumSrc = '把超时设为 60 秒（最多重试 3 次）';
  const compoundTwoNumSum = makeSummary({ 5: '- 超时设为 60 秒\n- 最多重试 3 次' }, 'zh');
  const compoundTwoNumAudit = auditCompaction({
    userMessages: [{ seq: 3, text: compoundTwoNumSrc }],
    summaryText: compoundTwoNumSum,
    checkpointText: compoundTwoNumSum,
    includeAllConflicts: true,
  });
  assert.equal(compoundTwoNumAudit.lost.length, 0, 'two-number parenthetical rule split across bullets must pass');

  // Direct audit on comma-compound rule inside Section 6 catches polarity flips
  const directSec6 = poisonedBase.replace('[由引擎填充]', `- ${commaRule}`);
  const directAudit = auditCompaction({
    userMessages: [{ seq: 1, text: commaRule }],
    summaryText: poisonedBase,
    checkpointText: directSec6,
    includeAllConflicts: true,
  });
  assert.equal(directAudit.polarityFlips, 1);
  assert.ok(directAudit.lost.some((l) => l.reason === 'polarity'));

  // Case 2: compound comma clause with first clause flipped while verbatim source remains in Section 6
  // Wave 1 catches polarity and reconstructDisputedLines scrubs all poisoned prose
  const fCase2 = await createSynthFixture({
    language: 'zh',
    extraConfig: {
      preserveRecentMessages: 4,
      preserveRecentUserTokens: 2048,
      auditCoverageThreshold: 0.6,
    },
    streamHandler: () => poisonedBase,
  });
  try {
    fCase2.addSystem('System prompt.');
    fCase2.addUser(commaRule);
    fCase2.addAssistant('工作日志排查记录正常，当前认证模块未变更。 '.repeat(200));
    fCase2.addUser('继续下一轮。');
    await fCase2.engine.compactNow(fCase2.agent, new AbortController().signal);
    const cpSeq = fCase2.surface.nodes.find((seq) => fCase2.session.eventAt(seq)?.data?.source?.kind === 'compact-checkpoint');
    assert.ok(cpSeq !== undefined);
    const cpText = blocksToText(fCase2.session.deriveEventMessage(fCase2.session.eventAt(cpSeq))?.content);
    assert.equal(cpText.includes('可以修改 auth.js 文件'), false, 'Case 2 must scrub all poisoned prose');
    assert.equal(cpText.includes('<pinned-source-rules'), false);
    assert.ok(cpText.includes(commaRule));
  } finally {
    await fCase2.cleanup();
  }

  // Case 3a: evicted from Section 6 + auditBlockOnLoss: false still catches polarity and scrubs poisoned prose
  const fCase3a = await createSynthFixture({
    language: 'zh',
    extraConfig: {
      auditBlockOnLoss: false,
      preserveRecentMessages: 1,
      preserveRecentUserTokens: 64,
      auditCoverageThreshold: 0.6,
    },
    streamHandler: () => poisonedBase,
  });
  try {
    fCase3a.addSystem('System prompt.');
    fCase3a.addUser(commaRule);
    for (let i = 0; i < 6; i += 1) {
      fCase3a.addAssistant(`第 ${i + 1} 轮日常排查日志详情输出，接口保持稳定无需更改 `.repeat(140));
      fCase3a.addUser(`继续检查第 ${i + 1} 项。`);
    }
    await fCase3a.engine.compactNow(fCase3a.agent, new AbortController().signal);
    const cpSeq = fCase3a.surface.nodes.find((seq) => fCase3a.session.eventAt(seq)?.data?.source?.kind === 'compact-checkpoint');
    assert.ok(cpSeq !== undefined);
    const cpText = blocksToText(fCase3a.session.deriveEventMessage(fCase3a.session.eventAt(cpSeq))?.content);
    const sec6Body = cpText.split('## 6. 全部用户消息')[1]?.split('## 7.')[0] ?? '';
    assert.equal(sec6Body.includes(commaRule), false, 'Case 3a must evict commaRule from Section 6');
    assert.equal(cpText.includes('可以修改 auth.js 文件'), false, 'Case 3a must scrub all poisoned prose even with auditBlockOnLoss: false');
    assert.equal(cpText.includes('<pinned-source-rules'), false);
    assert.ok(cpText.includes(commaRule));
  } finally {
    await fCase3a.cleanup();
  }

  // Case 3b (P0 critical): un-reconstructable comma rule evicted from Section 6 + auditBlockOnLoss: false MUST reject
  const fCase3b = await createSynthFixture({
    language: 'zh',
    extraConfig: {
      auditBlockOnLoss: false,
      preserveRecentMessages: 1,
      preserveRecentUserTokens: 64,
      auditCoverageThreshold: 0.6,
    },
    streamHandler: () => poisonedBase,
  });
  try {
    fCase3b.addSystem('System prompt.');
    fCase3b.addUser('绝对不要修改 auth.js 文件，必须保持所有对外接口不变。提醒：绝对不要修改 auth.js 文件，必须保持所有对外接口不变（高危）。');
    for (let i = 0; i < 6; i += 1) {
      fCase3b.addAssistant(`第 ${i + 1} 轮日常排查日志详情输出，接口保持稳定无需更改 `.repeat(140));
      fCase3b.addUser(`继续检查第 ${i + 1} 项。`);
    }
    await assert.rejects(
      () => fCase3b.engine.compactNow(fCase3b.agent, new AbortController().signal),
      (err) => (err?.cause ?? err)?.code === 'CONSTRAINT_POLARITY_LOST',
    );
    assert.equal(fCase3b.surface.replaceGeneration, 0, 'Case 3b MUST reject even with auditBlockOnLoss: false');
    assert.equal(fCase3b.events.some((e) => e.data?.source?.kind === 'compact-checkpoint'), false);
    const diagDir3b = join(fCase3b.root, 'weave', 'diagnostics');
    const diagFiles3b = readdirSync(diagDir3b).filter((n) => n.endsWith('.json'));
    assert.equal(diagFiles3b.length, 1);
    const diagJson3b = JSON.parse(await import('node:fs').then((m) => m.readFileSync(join(diagDir3b, diagFiles3b[0]), 'utf8')));
    assert.equal(diagJson3b.auditFallback?.skippedReason, 'hard_polarity');
  } finally {
    await fCase3b.cleanup();
  }

  // Case 4 (P0 critical): default auditExhaustionPolicy: 'fallback' MUST reject hard_polarity without <pinned-source-rules>
  const fCase4 = await createSynthFixture({
    language: 'zh',
    extraConfig: {
      preserveRecentMessages: 1,
      preserveRecentUserTokens: 64,
      auditCoverageThreshold: 0.6,
    },
    streamHandler: () => poisonedBase,
  });
  try {
    fCase4.addSystem('System prompt.');
    fCase4.addUser('绝对不要修改 auth.js 文件。提醒：绝对不要修改 auth.js 文件（高危）。');
    for (let i = 0; i < 6; i += 1) {
      fCase4.addAssistant(`第 ${i + 1} 轮日常排查日志详情输出，接口保持稳定无需更改 `.repeat(140));
      fCase4.addUser(`继续检查第 ${i + 1} 项。`);
    }
    await assert.rejects(
      () => fCase4.engine.compactNow(fCase4.agent, new AbortController().signal),
      (err) => (err?.cause ?? err)?.code === 'CONSTRAINT_POLARITY_LOST',
    );
    assert.equal(fCase4.surface.replaceGeneration, 0, 'Case 4 MUST NOT commit poisoned prose via <pinned-source-rules> fallback');
    assert.equal(fCase4.events.some((e) => e.data?.source?.kind === 'compact-checkpoint'), false);
    const diagDir4 = join(fCase4.root, 'weave', 'diagnostics');
    const diagFiles4 = readdirSync(diagDir4).filter((n) => n.endsWith('.json'));
    assert.equal(diagFiles4.length, 1);
    const diagJson4 = JSON.parse(await import('node:fs').then((m) => m.readFileSync(join(diagDir4, diagFiles4[0]), 'utf8')));
    assert.equal(diagJson4.auditFallback?.skippedReason, 'hard_polarity');
  } finally {
    await fCase4.cleanup();
  }
});

// ── Item 2: Non-atomic post-flush abort cleanup ───────────────────────────────

await test('2-non-atomic-post-flush-abort-clears-journal-and-breaker-without-locking-session', async () => {
  const ac = new AbortController();
  const f = await createSynthFixture({
    extraConfig: { preserveRecentMessages: 1, preserveRecentUserTokens: 64 },
    streamHandler: () => makeSummary({ 1: 'Keep prod backups strictly encrypted.' }, 'en'),
    onFlush({ state }) {
      if (state.flushes === 2) {
        ac.abort(new Error('user pressed escape during durability flush'));
      }
    },
  });
  try {
    f.addSystem('System prompt.');
    f.addUser('Keep prod backups strictly encrypted.');
    f.addAssistant('Execution trace '.repeat(120));
    f.addUser('Continue.');
    // Seed a prior failure so we verify clearBreakerState runs even on post-flush abort
    f.engine._recordFailure(f.agent, f.session, new Error('prior transient error'));
    assert.equal(f.engine.sessionState.read(f.session.id).failures, 1);

    await assert.rejects(
      () => f.engine.compactNow(f.agent, ac.signal),
      (err) => err?.code === 'cancelled' || err?.cause?.code === 'cancelled',
    );
    assert.equal(f.surface.replaceGeneration, 1);
    assert.equal((await f.engine.journal.pending(f.session.id)).length, 0, 'journal must be cleared after flush succeeds');
    assert.equal(f.engine.sessionState.read(f.session.id).failures, 0);
    assert.equal(f.engine.sessionState.read(f.session.id).stopped, false);
    // Must not throw RECOVERY_REQUIRED on subsequent recovery checks
    await f.engine.recoverPending(f.session);
  } finally {
    await f.cleanup();
  }
});

// ── Item 3: DSH dsh-token-meter shadow pricing alignment ──────────────────────

await test('3-shadow-pricing-adjacency-and-gross-host-heuristic-zero-drift', async () => {
  // 3A: Verify block-by-block formula on empty/non-empty system, text, reasoning, tool-call, image, structural
  assert.equal(estimateHostHeuristicMessage({ role: 'system', content: [] }), 0);
  assert.equal(estimateHostHeuristicMessage({ role: 'system', content: [{ type: 'text', text: 'abcd' }] }), 5);
  assert.equal(
    estimateHostHeuristicMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello' }, // ceil(5/4)+4 = 6
        { type: 'reasoning', text: 'abcd' }, // ceil(4/4)+4 = 5
        { type: 'tool-call', callId: 'c1', name: 'read_file', arguments: '{"path":"a.js"}' }, // ceil(9/4)+ceil(15/4)+4 = 3+4+4 = 11
      ],
    }),
    6 + 5 + 11 + 4,
  );
  const imgWithoutOffload = {
    role: 'user',
    content: [{ type: 'image', attachment: { attachmentId: 'sha256:abc', bytes: 9999 } }],
  };
  const imgWithOffload = {
    role: 'user',
    content: [{ type: 'image', attachment: { attachmentId: 'sha256:abc', bytes: 9999 }, offloaded: true }],
  };
  assert.equal(estimateHostHeuristicMessage(imgWithoutOffload), estimateHostHeuristicMessage(imgWithOffload));

  const meterRoot = findHostModules('dsh-token-meter');
  let hostEstimateMessage = null;
  let foldSurfaceProjection = null;
  if (meterRoot) {
    ({ estimateMessage: hostEstimateMessage } = await import(
      pathToFileURL(join(meterRoot, '@deepseek-ai/dsh-token-meter/lib/types/estimate.js')).href
    ));
    ({ foldSurfaceProjection } = await import(
      pathToFileURL(join(meterRoot, '@deepseek-ai/dsh-token-meter/lib/types/surface-projection.js')).href
    ));
    assert.equal(estimateHostHeuristicMessage(imgWithOffload), hostEstimateMessage(imgWithOffload));
  }

  // 3B: Engine compaction with pricedInput mismatch (CJK text + weighted priced multiplier) + observationMask + snip
  const f = await createSynthFixture({
    openTurn: 1,
    extraConfig: {
      preserveRecentMessages: 1,
      preserveRecentUserTokens: 32,
      auditBlockOnLoss: true,
    },
    streamHandler: () => makeSummary({ 1: '保留中文配置日志规则。' }, 'zh'),
  });
  try {
    f.addSystem('Sys.');
    const u1 = f.addUser('保留中文配置日志规则。');
    const a1 = f.addAssistant('中文测试助手回复内容 '.repeat(60));
    const { resEv: toolResEv } = f.addToolPair('read_file', { path: 'big.log' }, 'Line output '.repeat(500));
    f.addAssistant('Recent trailing summary notes '.repeat(25));
    const tailUser = f.addUser('Continue.');

    // Inject non-heuristic priced multiplier into tokenMeter to verify DSH events STILL record gross host heuristic
    f.engine.ctx.tokenMeter = {
      measure(s) {
        const nodes = s.surface.nodes.map((seq) => ({
          seq,
          tokens: seq === toolResEv.seq ? 9000 : approxTokens(blocksToText(s.deriveEventMessage(s.eventAt(seq))?.content)) * 3,
        }));
        return { nodes, totalTokens: nodes.reduce((a, b) => a + b.tokens, 0), precision: 'priced' };
      },
    };

    // Mask toolResEv directly via commitObservationMask
    const m1 = await f.engine._measure(f.session);
    const maskPlan = planObservationMask(f.session, m1, 32, {
      compactionId: 'mask-w1',
      thresholdChars: 500,
      headChars: 80,
      tailChars: 80,
    });
    assert.ok(maskPlan);
    const origToolMsg = f.session.deriveEventMessage(toolResEv);
    const expectedGrossTool = estimateHostHeuristicMessage(origToolMsg);
    const maskRes = await commitObservationMask({
      session: f.session,
      plan: maskPlan,
      archive: f.engine.archive,
      log: () => {},
      flushSession: null,
    });
    assert.ok(maskRes);
    const pruneEv = f.events.findLast((e) => e.type === 'compaction/prune');
    const toolReplaceEv = f.events.findLast((e) => e.type === 'tool/result' && e.surfaceOp?.op === 'replace');
    assert.equal(pruneEv.seq + 1, toolReplaceEv.seq, 'compaction/prune must be immediately adjacent to tool/result replace');
    assert.equal(pruneEv.data.shadowedTokenCount, expectedGrossTool, 'prune event must carry gross host heuristic');
    assert.equal(maskRes.shadowedTokenCount, maskPlan.totalTokensSaved, 'return stats keep net savings');

    // Run compaction across [u1, a1, toolCall, toolReplaceEv]
    const spanSeqs = [u1.seq, a1.seq, f.surface.nodes[3], toolReplaceEv.seq];
    const expectedGrossSpan = estimateHostHeuristicSpan(f.session, spanSeqs);
    f.engine.sessionState.update(f.session.id, (s) => s);
    await f.engine.compactRegion(spanSeqs[0], spanSeqs.at(-1), f.agent, new AbortController().signal);
    const sumEv = f.events.findLast((e) => e.type === 'compaction/summary');
    const cpReplaceEv = f.events.findLast((e) => e.type === 'user/message' && e.surfaceOp?.op === 'replace');
    assert.equal(sumEv.seq + 1, cpReplaceEv.seq, 'compaction/summary must be synchronously adjacent to replace');
    assert.equal(sumEv.data.shadowedTokenCount, expectedGrossSpan, 'summary event must carry gross host heuristic');
    assert.ok(tailUser);

    // Run Snip on an extra old tool pair before compacting
    f.addAssistant('Extra noise '.repeat(400));
    f.addAssistant('Recent answer.');
    f.addUser('Tail question.');
    const fSnip = await createSynthFixture({ openTurn: 2 });
    try {
      fSnip.addSystem('Sys.');
      const tPair = fSnip.addToolPair('run_shell', { cmd: 'ls' }, 'shell '.repeat(900));
      fSnip.addAssistant('After '.repeat(20));
      fSnip.addUser('Keep this recent request '.repeat(50));
      fSnip.addAssistant('Recent reply '.repeat(50));
      const snipPlan = planSnip(fSnip.session, await fSnip.engine._measure(fSnip.session), {
        keepRecentTurns: 1,
        keepRecentTokens: 128,
        minSavingsTokens: 100,
      });
      assert.ok(snipPlan && snipPlan.spans.length >= 1);
      const expectedGrossSnip = estimateHostHeuristicSpan(fSnip.session, snipPlan.spans[0].seqs);
      await commitSnip({
        session: fSnip.session,
        plan: snipPlan,
        archive: fSnip.engine.archive,
        log: () => {},
        flushSession: null,
      });
      const snipSum = fSnip.events.findLast((e) => e.type === 'compaction/summary');
      const snipRep = fSnip.events.findLast((e) => e.type === 'user/message' && e.surfaceOp?.op === 'replace');
      assert.equal(snipSum.seq + 1, snipRep.seq, 'snip compaction/summary must be adjacent to replace');
      assert.equal(snipSum.data.shadowedTokenCount, expectedGrossSnip);
      assert.ok(tPair);

      // Verify zero drift with real host dsh-token-meter foldSurfaceProjection when available
      if (foldSurfaceProjection && hostEstimateMessage) {
        for (const evList of [f.events, fSnip.events]) {
          // Only fold events whose payloads follow real DSH surface schema
          const targetSession = evList === f.events ? f.session : fSnip.session;
          let projected = 0;
          let claim;
          for (const ev of evList) {
            if (ev.type === 'turn/start') continue;
            // Re-shape event with canonical deriveEventMessage expectation if needed
            const res = foldSurfaceProjection(claim, ev);
            projected += res.deltaTokens;
            claim = res.claim;
          }
          const exactHeuristicSum = targetSession.surface.nodes.reduce(
            (sum, seq) => sum + hostEstimateMessage(targetSession.deriveEventMessage(targetSession.eventAt(seq))),
            0,
          );
          assert.equal(projected, exactHeuristicSum, 'dsh-token-meter foldSurfaceProjection must have ZERO drift');
        }
      }
    } finally {
      await fSnip.cleanup();
    }
  } finally {
    await f.cleanup();
  }
});

// ── Item 4: Dual-track same-dimension summary budget ──────────────────────────

await test('4-dual-track-summary-budget-enables-200k-single-call-and-keeps-small-byte-cap', async () => {
  assert.equal(DEFAULT_CONFIG.summaryInputRatio, 0.85);
  assert.equal(DEFAULT_CONFIG.summaryInputMaxBytes, 2097152);

  const cfg = resolveConfig({}).config;
  const targetSpec = {
    provider: 'deepseek',
    model: 'deepseek-chat',
    key: JSON.stringify(['deepseek', 'deepseek-chat']),
    window: 200000,
    output: 8192,
    margin: 33000,
    inputRatio: cfg.summaryInputRatio,
    maxInputBytes: cfg.summaryInputMaxBytes,
    scale: 1,
  };
  assert.equal(tokenRequestLimit(targetSpec), 134986);
  assert.equal(byteRequestLimit(targetSpec), 2097152);

  // Build ~480 KB ASCII span (~120k tokens) on 200k window: fits in 1 single chunk with preservePrefixCache
  const f200k = await createSynthFixture({
    windowTokens: 200000,
    extraConfig: { preserveRecentMessages: 1, preserveRecentUserTokens: 2048 },
  });
  try {
    f200k.addSystem('System baseline.');
    const bodyStart = f200k.addUser('Keep prodTimeoutSec: 60 strictly enforced.');
    let bodyEnd = bodyStart;
    for (let i = 0; i < 16; i += 1) {
      f200k.addUser(`Turn ${i + 1} code review notes.`);
      bodyEnd = f200k.addAssistant(`export const partition_${i} = "${'a'.repeat(28000)}";\n`);
    }
    f200k.addUser('Latest active prompt.');

    const cap = await resolveSummaryCapacity(
      f200k.engine.ctx,
      { targets: [{ provider: 'deepseek', model: 'deepseek-chat' }] },
      cfg,
    );
    assert.equal(capacityTokenLimit(cap), 134986);
    assert.equal(capacityByteLimit(cap), 2097152);

    const planned = planSummaryRange(
      f200k.session,
      { start: bodyStart.seq, end: bodyEnd.seq },
      cap,
      { policy: cfg, language: 'en', singleTarget: true },
    );
    assert.equal(planned.limited, false, '120k-token / ~460 KB 200k span must fit in 1 single chunk without splitting');
    const verbatim = measureSummaryRange(
      f200k.session,
      { start: planned.start, end: planned.end },
      { policy: cfg, language: 'en', preservePrefixCache: true, singleTarget: true },
    );
    assert.equal(fitsCapacity(verbatim, cap, { singleTarget: true }), true, 'preservePrefixCache: true must pass dual-track capacity');

    // Default CJK weight is 0.75 tok/char: 190k CJK chars (>= 142,500) exceeds 134,986 token limit
    // even though ~570 KB < 2 MiB; compatibility mode (1.0 tok/char) still rejects 140k CJK chars.
    const cjkReq = buildSummaryRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: '汉'.repeat(190000) }] }] });
    assert.ok(cjkReq.inputTokens >= 142500);
    assert.throws(
      () => assertSummaryCapacity(cjkReq, cap, { provider: 'deepseek', model: 'deepseek-chat' }),
      (e) => e.localCapacityRejection === true && e.code === 'CONTEXT_WINDOW_EXCEEDED',
    );
    const compatCap = await resolveSummaryCapacity(
      f200k.engine.ctx,
      { targets: [{ provider: 'deepseek', model: 'deepseek-chat' }] },
      resolveConfig({ summaryCjkTokensPerChar: 1.0 }).config,
    );
    const compatCjkReq = buildSummaryRequest(
      { messages: [{ role: 'user', content: [{ type: 'text', text: '汉'.repeat(140000) }] }] },
      { cjkTokensPerChar: 1.0 },
    );
    assert.ok(compatCjkReq.inputTokens >= 140000);
    assert.throws(
      () => assertSummaryCapacity(compatCjkReq, compatCap, { provider: 'deepseek', model: 'deepseek-chat' }),
      (e) => e.localCapacityRejection === true && e.code === 'CONTEXT_WINDOW_EXCEEDED',
    );

    // Explicit small summaryInputMaxBytes continues strictly bounding serialized bytes
    const smallByteCap = await resolveSummaryCapacity(
      f200k.engine.ctx,
      { targets: [{ provider: 'deepseek', model: 'deepseek-chat' }] },
      resolveConfig({ summaryInputMaxBytes: 48000 }).config,
    );
    assert.equal(capacityByteLimit(smallByteCap), 48000);
    const smallPlanned = planSummaryRange(
      f200k.session,
      { start: bodyStart.seq, end: bodyEnd.seq },
      smallByteCap,
      { policy: cfg, language: 'en', singleTarget: true },
    );
    assert.equal(smallPlanned.limited, true);
    assert.ok(smallPlanned.inputBytes <= 48000);

    // scale overflow halves both limits
    observeSummaryOverflow(cap, { provider: 'deepseek', model: 'deepseek-chat' }, Object.assign(new Error('overflow'), { code: 'CONTEXT_WINDOW_EXCEEDED' }));
    assert.equal(capacityTokenLimit(cap), Math.floor(134986 / 2));
    assert.equal(capacityByteLimit(cap), Math.floor(2097152 / 2));
  } finally {
    await f200k.cleanup();
  }
});

// ── Item 5 (+ Supplement) & Item 6: Route-scoped window, fallback guard, & live target ──

await test('5-and-6-route-window-isolation-fallback-upgrade-legacy-recovery-and-live-targets', async () => {
  resetWindowCache();
  const s = { id: `w1-win-${randomUUID().slice(0, 6)}` };
  const base = { session: s, providerMap: {}, fallback: 200000, clampMin: 65536 };

  // 1) Initial fallback upgrades to 1M when trusted arrives; subsequent fallback NEVER shrinks 1M down to 200k
  const g1 = lockWindow({ ...base, provider: 'deepseek', model: 'deepseek-chat', adapterWindow: undefined });
  assert.equal(g1.source, 'fallback');
  const g2 = lockWindow({ ...base, provider: 'deepseek', model: 'deepseek-chat', adapterWindow: undefined });
  assert.equal(g2.source, 'fallback');
  const up1m = lockWindow({ ...base, provider: 'deepseek', model: 'deepseek-chat', adapterWindow: 1000000 });
  assert.equal(up1m.window, 1000000);
  assert.equal(up1m.safetyWindow, 1000000);
  assert.equal(up1m.firstResolved, 1000000);
  const transientTimeout = lockWindow({ ...base, provider: 'deepseek', model: 'deepseek-chat', adapterWindow: undefined });
  assert.equal(transientTimeout.window, 1000000);
  assert.equal(transientTimeout.safetyWindow, 1000000, 'untrusted fallback must never shrink trusted 1M lock');

  // 2) Model switch isolates 64k vs 1M routes and retains prior tightened safetyWindow when switching back
  const tight1m = lockWindow({ ...base, provider: 'deepseek', model: 'deepseek-chat', adapterWindow: 800000 });
  assert.equal(tight1m.safetyWindow, 800000);
  const smallRoute = lockWindow({ ...base, provider: 'small', model: 'm64k', adapterWindow: 65536 });
  assert.equal(smallRoute.window, 65536);
  assert.equal(smallRoute.safetyWindow, 65536);
  const back1m = lockWindow({ ...base, provider: 'deepseek', model: 'deepseek-chat', adapterWindow: 1000000 });
  assert.equal(back1m.window, 1000000);
  assert.equal(back1m.safetyWindow, 800000, 'switching back to 1M route remembers its tightened safetyWindow');

  // 3) Legacy pre-Wave-1 polluted unrouted 200k record recovers cleanly on trusted route AND via /compact reset
  const root = await mkdtemp(join(TEST_BASE, 'weave-w1-state-'));
  try {
    const store = new SessionStateStore(join(root, 'state'));
    const legacyId = 'legacy-polluted-200k';
    const legacyWin = { window: 200000, firstResolved: 200000, safetyWindow: 200000, source: 'locked' };
    assert.equal(isPollutedWindowRecord(legacyWin), true);
    store.update(legacyId, () => ({ failures: 0, stopped: false, window: legacyWin }));
    const recovered = lockWindow({
      session: { id: legacyId },
      persisted: store.read(legacyId).window,
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      adapterWindow: 1000000,
      providerMap: {},
      fallback: 200000,
      clampMin: 65536,
    });
    assert.equal(recovered.window, 1000000);
    assert.equal(recovered.safetyWindow, 1000000);

    // /compact reset clears polluted 200k window while preserving genuine trusted windows
    const resetPolluted = store.resetBreaker(legacyId);
    assert.equal(resetPolluted.windowCleared, true);
    assert.equal(resetPolluted.state.window, undefined);

    const trustedId = 'trusted-window-kept';
    const trustedWin = { window: 128000, firstResolved: 128000, safetyWindow: 65536, source: 'provider', trusted: true };
    assert.equal(isPollutedWindowRecord(trustedWin), false);
    store.update(trustedId, () => ({ failures: 3, stopped: true, window: trustedWin }));
    const resetTrusted = store.resetBreaker(trustedId);
    assert.equal(resetTrusted.windowCleared, false);
    assert.deepEqual(resetTrusted.state.window, trustedWin);

    forgetLockedWindow(s.id, 'small', 'm64k');
    assert.equal(peekLockedWindow(s, 'small', 'm64k'), undefined);
    assert.equal(peekLockedWindow(s, 'deepseek', 'deepseek-chat'), 1000000);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }

  // 4) Item 6 / DSH 0.2.2-rc.1 contract: resolveSummaryTargets and _resolveSpec prioritize
  // live modelSelection / agent.model.current() -> session.requestHeader() -> initial agent.options.
  const switchedAgent = {
    options: { provider: 'initial-provider', model: 'initial-legacy', reasoningEffort: 'low' },
    model: { current: () => ({ provider: 'new-provider', model: 'new-1m', reasoningEffort: 'medium' }) },
    session: {
      id: `live-target-${randomUUID().slice(0, 6)}`,
      requestHeader: () => ({ config: { provider: 'old-provider', model: 'old-64k', reasoningEffort: 'high' } }),
    },
  };
  const chain = resolveSummaryTargets({ config: resolveConfig({}).config, agent: switchedAgent });
  assert.equal(chain.targets[0].provider, 'new-provider');
  assert.equal(chain.targets[0].model, 'new-1m');
  assert.equal(chain.targets[0].source, 'model');
  assert.equal(chain.targets[1].provider, 'old-provider');
  assert.equal(chain.targets[1].source, 'session');
  assert.equal(chain.targets[2].provider, 'initial-provider');
  assert.equal(chain.targets[2].source, 'agent');

  // Without agent.model.current(), session.requestHeader() beats stale initial agent.options
  const headerSwitchedAgent = {
    options: { provider: 'initial-provider', model: 'initial-legacy' },
    session: {
      id: `hdr-target-${randomUUID().slice(0, 6)}`,
      requestHeader: () => ({ config: { provider: 'header-provider', model: 'header-32k' } }),
    },
  };
  const headerChain = resolveSummaryTargets({ config: resolveConfig({}).config, agent: headerSwitchedAgent });
  assert.equal(headerChain.targets[0].provider, 'header-provider');
  assert.equal(headerChain.targets[0].source, 'session');
  assert.equal(headerChain.targets[1].provider, 'initial-provider');

  const fEngine = await createSynthFixture({
    extraConfig: {
      modelPolicies: [{ provider: 'new-provider', model: 'new-1m', thresholdRatio: 0.7 }],
    },
  });
  try {
    fEngine.engine.ctx.llm.resolveModelInfo = async (p, m) => ({ contextWindow: p === 'new-provider' ? 1000000 : 65536 });
    const liveAgent = {
      session: fEngine.session,
      options: { provider: 'initial-provider', model: 'initial-legacy' },
      model: { current: () => ({ provider: 'new-provider', model: 'new-1m' }) },
    };
    const spec = await fEngine.engine._resolveSpec(liveAgent, null, undefined);
    assert.equal(spec.provider, 'new-provider');
    assert.equal(spec.lockedWindow, 1000000);
    assert.equal(spec.policy.thresholdRatio, 0.7);
  } finally {
    await fEngine.cleanup();
  }
});

// ── Item 7: StockTransactionAdapter pre-write concurrent change -> SPAN_CHANGED ─

await test('7-stock-transaction-pre-write-concurrent-change-throws-SPAN_CHANGED-not-RECOVERY_REQUIRED', async () => {
  const hostMods = findHostModules('dsh-session-persistence-jsonl');
  if (!hostMods) return; // Skipped only when no host runtime packages exist in environment

  const { Context } = await import(pathToFileURL(join(hostMods, '@deepseek-ai/cordis/lib/index.js')).href);
  const { Session, SessionStore } = await import(pathToFileURL(join(hostMods, '@deepseek-ai/dsh-session/lib/index.js')).href);
  const persistence = await import(pathToFileURL(join(hostMods, '@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js')).href);

  const dir = await mkdtemp(join(TEST_BASE, 'weave-w1-tx-'));
  const root = new Context();
  const mounting = root.plugin({
    name: 'w1-tx-host',
    async apply(ctx) {
      new SessionStore(ctx);
      await persistence.apply(ctx, { root: join(dir, 'host-sessions'), compression: 'none' });
    },
  });
  await mounting.await();
  const backend = root.sessionPersistence;
  const store = root.sessions;
  const session = Session.create(`tx-${randomUUID().slice(0, 8)}`);
  const handle = await backend.create(session.header);
  const detach = store.enter(session);
  store.announce(session);

  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('system/message', { turn: 1, step: 1, message: { id: randomUUID(), role: 'system', content: [{ type: 'text', text: 'Sys.' }], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' });
  session.append('user/message', { id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'Keep config unchanged.' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  session.append('assistant/message', { turn: 1, step: 1, stream: [], usage: { inputTokens: 0, outputTokens: 0 }, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: 'Ack '.repeat(50) }], source: { kind: 'model', provider: 'p', model: 'm' } } }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1 });
  await store.flush(session);

  const adapter = new StockTransactionAdapter(backend, store, { warn() {} });
  const engine = new WeaveCompactionEngine({
    on() {},
    provide() {},
    logger: { info() {}, warn() {}, error() {} },
    sessions: { flush: (s) => store.flush(s), get: (id) => store.get(id) },
    sessionPersistence: backend,
  }, resolveConfig({ archiveDir: join(dir, 'weave', 'archive') }).config);
  adapter.register(engine.journal, engine.sessionState, engine.config.failureThreshold, engine.backupStore);

  try {
    const cid = 'weave-span-changed-test';
    await engine.journal.record({ sessionId: session.id, compactionId: cid, phase: 'committing', startSeq: 3, endSeq: 4 });
    const record = (await engine.journal.pending(session.id)).find((r) => r.compactionId === cid);
    const staged = adapter.stage(session, (shadow) => {
      const sumEv = shadow.append('compaction/summary', {
        compactionId: cid,
        summary: [{ type: 'text', text: makeSummary({ 1: 'Keep config unchanged.' }, 'en') }],
        shadowedRange: { start: 3, end: 4 },
        shadowedSeqs: [3, 4],
        shadowedTokenCount: 20,
        provider: 'p',
        model: 'm',
        maxTokens: 8192,
      });
      const cp = shadow.append(
        'user/message',
        { id: randomUUID(), role: 'user', content: [{ type: 'text', text: makeSummary({ 6: 'Keep config unchanged.' }, 'en') }], source: { kind: 'compact-checkpoint', compactionId: cid, preserved: [{ seq: 3, text: 'Keep config unchanged.' }] } },
        { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 }, sourceEventSeqs: [sumEv.seq, 3, 4] },
      );
      const endEv = shadow.append('compaction/end', { compactionId: cid, turn: null });
      return { summaryEvent: sumEv, replacement: cp, endEvent: endEv };
    });

    // Mutate session concurrently before commit enters h.run
    session.append('user/message', { id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'Concurrent arrival!' }], source: { kind: 'user' } }, { surfaceOp: 'append' });

    await assert.rejects(
      () => adapter.commit(engine, session, record, staged),
      (err) => err?.code === 'SPAN_CHANGED' && err?.code !== 'RECOVERY_REQUIRED',
    );
    assert.equal(adapter.blocked.has(session.id), false, 'pre-write SPAN_CHANGED must not quarantine writer');
    const jFile = engine.journal.fileFor(session.id, cid);
    assert.equal(existsSync(`${jFile}.rollback`), false, 'zero backup bytes should be written on pre-write SPAN_CHANGED');
    assert.equal(existsSync(`${jFile}.tail`), false);
  } finally {
    engine.dispose();
    adapter.dispose();
    detach();
    await handle.close();
    await mounting.dispose();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ── Item 8: WeaveCompactionEngine.dispose() aborts active streams ─────────────

await test('8-engine-dispose-aborts-in-flight-compaction-stream-and-rejects-new-calls', async () => {
  let streamAborted = false;
  let markEntered;
  const entered = new Promise((r) => { markEntered = r; });

  const f = await createSynthFixture({
    extraConfig: { preserveRecentMessages: 1, preserveRecentUserTokens: 32 },
    streamHandler: async function* (_req, _callIndex, signal) {
      markEntered();
      await new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          streamAborted = true;
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        signal?.addEventListener('abort', () => {
          streamAborted = true;
          reject(signal.reason ?? new Error('disposed'));
        }, { once: true });
      });
      yield { type: 'text-delta', text: 'unreachable' };
    },
  });
  try {
    f.addSystem('System baseline.');
    f.addUser('Never remove audit checks.');
    f.addAssistant('Work log '.repeat(120));
    f.addUser('Continue.');

    const beforeSurface = [...f.surface.nodes];
    const inFlight = f.engine.compactNow(f.agent, new AbortController().signal);
    await entered;
    f.engine.dispose();

    await assert.rejects(inFlight, (err) => (err?.cause ?? err)?.code === 'cancelled' || /disposed|abort/i.test(String(err?.message)));
    assert.equal(streamAborted, true, 'dispose() must abort in-flight LLM stream signal');
    assert.deepEqual(f.surface.nodes, beforeSurface);

    // Subsequent calls on disposed engine reject cleanly without invoking LLM
    const callCountBefore = f.calls.length;
    await assert.rejects(
      () => f.engine.compactNow(f.agent, new AbortController().signal),
      (err) => (err?.cause ?? err)?.code === 'cancelled',
    );
    assert.equal(f.calls.length, callCountBefore);
  } finally {
    await rm(f.root, { recursive: true, force: true }).catch(() => {});
  }
});

// ── Item 9: lib/index.js row counting, idempotent inject, & ctx.on warn ───────

await test('9-countEngineRows-injectBesideOfficial-idempotency-isolate-and-missing-ctx-on-warn', async () => {
  const tree = [
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      config: [
        {
          id: 'compaction-basic',
          name: '@deepseek-ai/dsh-compaction-basic',
          disabled: true,
          isolate: { compaction: true },
          config: { auto: true },
        },
        {
          id: 'command-compact',
          name: '@deepseek-ai/dsh-command-compact',
        },
      ],
    },
  ];
  assert.equal(countEngineRows(tree), 2, 'must count both official engine and command-compact');

  const first = injectBesideOfficial(tree, { thresholdRatio: 0.78 });
  assert.ok(first);
  const groupRows = first.plugins[0].config;
  assert.equal(groupRows.length, 3);
  const officialRow = groupRows.find((r) => r.id === 'compaction-basic');
  const weaveRow = groupRows.find((r) => r.id === 'compaction-basic-weave');
  assert.equal(officialRow.disabled, true);
  assert.ok(weaveRow);
  assert.equal(weaveRow.name, 'dsh-compaction-weave/engine');
  assert.deepEqual(weaveRow.isolate, { compaction: true }, 'must inherit isolate group membership');
  assert.equal('disabled' in weaveRow, false, 'injected weave row must NOT inherit disabled: true');
  assert.equal(weaveRow.config.thresholdRatio, 0.78);

  const second = injectBesideOfficial(first.plugins, { thresholdRatio: 0.78 });
  assert.equal(second, null, 'second injectBesideOfficial pass must be strictly idempotent');

  // Missing ctx.on warns loudly in both gate apply() and WeaveCompactionEngine
  const gateWarns = [];
  applyGate({ provide() {}, logger: { warn: (m) => gateWarns.push(String(m)) } }, {});
  assert.ok(gateWarns.some((m) => m.includes('ctx.on')), 'lib/index.js apply must warn when ctx.on is unavailable');

  const engDir = await mkdtemp(join(TEST_BASE, 'weave-w1-noctxon-'));
  const engWarns = [];
  let eng;
  try {
    eng = new WeaveCompactionEngine(
      { provide() {}, logger: { warn: (m) => engWarns.push(String(m)) } },
      resolveConfig({ archiveDir: join(engDir, 'archive') }).config,
    );
    assert.ok(engWarns.some((m) => m.includes('ctx.on')), 'WeaveCompactionEngine must warn when ctx.on is unavailable');
  } finally {
    eng?.dispose();
    await rm(engDir, { recursive: true, force: true }).catch(() => {});
  }
});

const summary = {
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
};
console.log(JSON.stringify(summary, null, 2));
if (summary.failed > 0) process.exitCode = 1;
