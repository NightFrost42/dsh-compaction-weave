import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_CONFIG,
  REASONING_EFFORT_LADDER,
  SUMMARY_REASONING_EFFORTS,
  normalizeExtraReferenceSourceKinds,
  normalizeSummaryReasoningEffort,
  resolveConfig,
  resolveTargetPolicy,
} from '../lib/config.js';
import {
  handleSummaryConfigRpc,
  mergeSummaryConfig,
  validateSummaryConfig,
} from '../lib/summary-config.js';
import {
  buildReasoningEffortFallbackChain,
  isUnsupportedReasoningEffortError,
  resolveReasoningEffort,
  summarizeWithChain,
  summarizeWithTarget,
} from '../lib/summary.js';
import { buildCompactionInstruction, SUMMARY_TARGET_CHARS } from '../lib/prompt.js';
import {
  materializeUserMessageSection,
  unwrapJsonSectionMap,
  validateSummaryStructure,
  validateUserMessageSection,
} from '../lib/validate.js';
import {
  classifyEventChannel,
  isReferenceContextKind,
  withExtraReferenceSourceKinds,
} from '../lib/source-provenance.js';
import { auditCompaction } from '../lib/audit.js';
import { failureExplanation } from '../lib/failure-diagnostics.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { prepareContinuation } from '../lib/continuation.js';
import { resolveSummaryCapacity } from '../lib/summary-budget.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { PLUGIN_VERSION } from '../lib/version.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message, stack: error.stack });
  }
}

const EN_HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));
const ZH_HEADINGS = buildCompactionInstruction('zh')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeSummary(headings, sec6Heading, sec6Body, bodyNote = 'Concise progress summary.') {
  return headings
    .map((h, i) => {
      if (i === 5) return sec6Body ? `${sec6Heading}\n${sec6Body}` : sec6Heading;
      if (i === 8) return `${h}\n${bodyNote}`;
      return `${h}\nConcise note.`;
    })
    .join('\n\n');
}

function makeSession({ id = `sess-${randomUUID()}` } = {}) {
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const session = {
    id,
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => [...events],
    requestHeader: () => ({ config: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
    toolHistory: () => [],
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (event.type === 'system/message') return event.data?.message ?? event.data;
      if (event.type === 'user/message') return event.data;
      if (event.type === 'assistant/message') return event.data?.message;
      if (event.type === 'tool/result') return event.data?.message;
      return undefined;
    },
    append(type, data, options = {}) {
      const event = {
        seq: events.length,
        time: Date.now(),
        type,
        data,
        ...(Array.isArray(options.sourceEventSeqs) ? { sourceEventSeqs: [...options.sourceEventSeqs] } : {}),
      };
      events.push(event);
      const op = options.surfaceOp;
      if (op?.op === 'replace') {
        const a = surface.nodes.indexOf(op.startSeq);
        const b = surface.nodes.indexOf(op.endSeq);
        assert.ok(a >= 0 && b >= a, `invalid replace ${op.startSeq}..${op.endSeq}`);
        surface.nodes.splice(a, b - a + 1, event.seq);
        surface.replaceGeneration += 1;
      } else if (op === 'append') {
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
  const addUser = (text, kind = 'user') =>
    session.append(
      'user/message',
      { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: kind === undefined ? undefined : { kind } },
      { surfaceOp: 'append' },
    );
  const addAssistant = (text) =>
    session.append(
      'assistant/message',
      {
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'text', text }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
      { surfaceOp: 'append' },
    );
  return { session, events, surface, addSystem, addUser, addAssistant };
}

function makeEngine({ root, extraConfig = {}, streamHandler, resolveModelInfo } = {}) {
  const calls = [];
  const measure = (session) => {
    const nodes = session.surface.nodes.map((seq) => {
      const msg = session.deriveEventMessage(session.eventAt(seq));
      return { seq, tokens: approxTokens(blocksToText(msg?.content)) };
    });
    return { nodes, totalTokens: nodes.reduce((sum, n) => sum + n.tokens, 0) };
  };
  const ctx = {
    on() {},
    provide() {},
    logger: { info() {}, warn() {} },
    sessions: { async flush() { return true; } },
    tokenMeter: {
      estimateMessage: (msg) => approxTokens(blocksToText(msg?.content)),
      measure,
    },
    llm: {
      resolveModelInfo: resolveModelInfo ?? (async () => ({ contextWindow: 200000, defaultMaxTokens: 8192 })),
      async *stream(opts) {
        calls.push(opts);
        if (streamHandler) {
          yield* streamHandler(opts, calls.length);
          return;
        }
        yield { type: 'text-delta', text: makeSummary(EN_HEADINGS, '## 6. All User Messages', '[filled by engine]') };
        yield { type: 'finish', kind: 'stop' };
      },
    },
  };
  const config = resolveConfig({
    archiveDir: join(root, 'sessions'),
    summaryRetryCount: 0,
    summaryRetryDelayMs: 0,
    summaryTimeoutMs: 10000,
    ...extraConfig,
  }).config;
  const engine = new WeaveCompactionEngine(ctx, config);
  engine.historyToolsAvailable = true;
  return { engine, ctx, calls };
}

// ── 1. PR #3 Follow-up: Prompt & Section 6 Placeholder Symmetry ──────────────

await test('pr3-followup-prompt-en-and-zh-instructions-preserve-9-headings', () => {
  const en = buildCompactionInstruction('en');
  assert.ok(en.includes('## 6. All User Messages'));
  assert.ok(en.includes('[filled by engine]'));
  assert.ok(en.includes('engine inserts recent originals'));
  assert.equal((en.match(/^## [1-9]\./gm) || []).length, 9);

  const zh = buildCompactionInstruction('zh');
  assert.ok(zh.includes('## 6. 全部用户消息'));
  assert.ok(zh.includes('[由引擎填充]'));
  assert.equal((zh.match(/^## [1-9]\./gm) || []).length, 9);
});

await test('pr3-followup-placeholder-titles-and-cjk-preservation-without-clobbering', () => {
  const originals = [{ seq: 3, text: 'Keep production database intact.' }];

  for (const title of ['[由引擎填充]', '由引擎填充', '[filled by engine]', 'filled by engine', '[engine-filled]', 'engine-filled']) {
    const draft = makeSummary(ZH_HEADINGS, `## 6. ${title}`, '');
    assert.equal(validateSummaryStructure(draft, { language: 'en' }).ok, true, `should accept placeholder ${title}`);
    assert.equal(validateSummaryStructure(draft, { language: 'zh' }).ok, true, `should accept placeholder ${title} in zh`);
  }

  // Placeholder JSON map with [engine-filled] unwraps cleanly
  const jsonPlaceholder = JSON.stringify({
    '## 1. Primary Request and Intent': 'Fix bug.',
    '## 2. Key Technical Concepts': 'Checkpoints.',
    '## 3. Files and Code Sections': 'lib/validate.js',
    '## 4. Errors and Fixes': '(none)',
    '## 5. Problem Solving': 'Normalized.',
    '## 6. [engine-filled]': '',
    '## 7. Pending Tasks': '(none)',
    '## 8. Work Completed': 'Fixed.',
    '## 9. Context for Continuing Work': 'Done.',
  });
  const unwrapped = unwrapJsonSectionMap(jsonPlaceholder, { language: 'en' });
  assert.equal(validateSummaryStructure(unwrapped, { language: 'en' }).ok, true);
  const matEn = materializeUserMessageSection(unwrapped, originals, 'en');
  assert.ok(matEn.includes('## 6. All User Messages\n'));
  assert.ok(!matEn.includes('[engine-filled]'));
  assert.ok(validateUserMessageSection(validateSummaryStructure(matEn, { language: 'en' }).userSectionBody, originals).ok);

  // Placeholder with CJK Section 7 under language='en' normalizes to ZH canonical heading
  const mixedZhDraft = makeSummary(ZH_HEADINGS, '## 6. [filled by engine]', '');
  const matMixed = materializeUserMessageSection(mixedZhDraft, originals, 'en');
  assert.ok(matMixed.includes('## 6. 全部用户消息\n'), 'CJK Section 7 triggers ZH canonical heading when normalizing placeholder');
  assert.ok(!matMixed.includes('[filled by engine]'));

  // Placeholder with CJK placeholder under language='en' normalizes to ZH canonical heading
  const enWithCjkPlaceholder = makeSummary(EN_HEADINGS, '## 6. [由引擎填充]', '');
  const matCjkPlaceholder = materializeUserMessageSection(enWithCjkPlaceholder, originals, 'en');
  assert.ok(matCjkPlaceholder.includes('## 6. 全部用户消息\n'));

  // Valid non-placeholder ZH heading MUST NOT be clobbered when language='en'
  const naturalZh = makeSummary(ZH_HEADINGS, '## 6. 所有用户消息', '[由引擎填充]');
  const matNaturalZh = materializeUserMessageSection(naturalZh, originals, 'en');
  assert.ok(matNaturalZh.includes('## 6. 所有用户消息\n'), 'valid non-placeholder heading must remain untouched');
  assert.ok(!matNaturalZh.includes('## 6. All User Messages'));

  // Valid non-placeholder EN heading MUST NOT be clobbered when language='zh'
  const naturalEn = makeSummary(EN_HEADINGS, '## 6. All User Messages', '[filled by engine]');
  const matNaturalEn = materializeUserMessageSection(naturalEn, originals, 'zh');
  assert.ok(matNaturalEn.includes('## 6. All User Messages\n'), 'valid EN heading must remain untouched');
});

// ── 2. Issue #5: Direct Thinking-Level Selection & Tiered Downgrade ─────────

await test('issue5-config-and-summary-config-support-all-8-efforts', async () => {
  assert.deepEqual(REASONING_EFFORT_LADDER, ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']);
  assert.deepEqual(SUMMARY_REASONING_EFFORTS, ['low', 'none', 'inherit', 'minimal', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(DEFAULT_CONFIG.summaryReasoningEffort, 'low');

  for (const effort of SUMMARY_REASONING_EFFORTS) {
    assert.equal(normalizeSummaryReasoningEffort(effort), effort);
    assert.equal(resolveConfig({ summaryReasoningEffort: effort }).config.summaryReasoningEffort, effort);
    const policy = resolveTargetPolicy(
      resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', summaryReasoningEffort: effort }] }).config,
      'p',
      'm',
    );
    assert.equal(policy.summaryReasoningEffort, effort);

    const v = validateSummaryConfig({ summaryReasoningEffort: ` ${effort} ` });
    assert.equal(v.ok, true);
    assert.equal(v.value.summaryReasoningEffort, effort);

    const m = mergeSummaryConfig({}, { summaryReasoningEffort: ` ${effort} ` });
    assert.equal(m.summaryReasoningEffort, effort);
  }

  assert.throws(() => resolveConfig({ summaryReasoningEffort: 'ultra' }), /summaryReasoningEffort/);
  assert.throws(() => resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', summaryReasoningEffort: 'ultra' }] }), /summaryReasoningEffort/);
  assert.equal(validateSummaryConfig({ summaryReasoningEffort: 'ultra' }).code, 'INVALID_SUMMARY_REASONING_EFFORT');
  assert.throws(() => mergeSummaryConfig({}, { summaryReasoningEffort: 'ultra' }), { code: 'INVALID_SUMMARY_REASONING_EFFORT' });

  const baseRoot = process.env.WEAVE_TEST_ROOT ?? tmpdir();
  const root = await mkdtemp(join(baseRoot, 'weave-v042-rpc-'));
  try {
    const file = join(root, 'summary-config.json');
    const res = await handleSummaryConfigRpc({ method: 'set', params: { summaryReasoningEffort: ' high ' } }, file);
    assert.equal(res.config.summaryReasoningEffort, 'high');
    await assert.rejects(
      handleSummaryConfigRpc({ method: 'set', params: { summaryReasoningEffort: 'ultra' } }, file),
      { code: 'INVALID_SUMMARY_REASONING_EFFORT' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('issue5-helpers-resolve-error-detect-and-fallback-chain', () => {
  assert.equal(resolveReasoningEffort('high', 'none'), undefined);
  assert.equal(resolveReasoningEffort('high', 'inherit'), 'high');
  assert.equal(resolveReasoningEffort(null, 'inherit'), undefined);
  for (const direct of ['minimal', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(resolveReasoningEffort(undefined, direct), direct);
    assert.equal(resolveReasoningEffort(null, direct), direct);
    assert.equal(resolveReasoningEffort('low', direct), direct);
  }
  assert.equal(resolveReasoningEffort(undefined, 'low'), undefined);
  assert.equal(resolveReasoningEffort(null, 'low'), undefined);
  assert.equal(resolveReasoningEffort('minimal', 'low'), 'minimal');
  assert.equal(resolveReasoningEffort('max', 'low'), 'low');

  // Cycle-safe depth <= 6 cause walk
  assert.equal(isUnsupportedReasoningEffortError({ code: 'UNSUPPORTED_REASONING_EFFORT' }), true);
  assert.equal(isUnsupportedReasoningEffortError(new Error('Model does not support reasoning effort')), true);
  assert.equal(isUnsupportedReasoningEffortError(new Error('invalid_reasoning_effort value')), true);

  let deep = Object.assign(new Error('outer'), { cause: Object.assign(new Error('inner'), { code: 'UNSUPPORTED_REASONING_EFFORT' }) });
  assert.equal(isUnsupportedReasoningEffortError(deep), true);

  const cycleA = new Error('generic A');
  const cycleB = new Error('generic B');
  cycleA.cause = cycleB;
  cycleB.cause = cycleA;
  assert.equal(isUnsupportedReasoningEffortError(cycleA), false);

  let tooDeep = { code: 'UNSUPPORTED_REASONING_EFFORT' };
  for (let i = 0; i < 8; i += 1) tooDeep = { message: 'wrap', cause: tooDeep };
  assert.equal(isUnsupportedReasoningEffortError(tooDeep), false, 'must stop at depth <= 6');

  assert.deepEqual(buildReasoningEffortFallbackChain('max'), ['xhigh', 'high', 'medium', 'low', 'minimal', 'none', undefined]);
  assert.deepEqual(buildReasoningEffortFallbackChain('high'), ['medium', 'low', 'minimal', 'none', undefined]);
  assert.deepEqual(buildReasoningEffortFallbackChain('none'), [undefined]);
  assert.deepEqual(buildReasoningEffortFallbackChain('custom'), ['low', 'minimal', 'none', undefined]);
  assert.deepEqual(buildReasoningEffortFallbackChain(undefined), [undefined]);
  assert.deepEqual(buildReasoningEffortFallbackChain('high', { supportedEfforts: [] }), [undefined]);
  assert.deepEqual(
    buildReasoningEffortFallbackChain('max', { supportedEfforts: ['high', 'low', 'high'] }),
    ['high', 'low', undefined],
  );
});

await test('issue5-cross-route-low-vs-direct-high-and-preflight', async () => {
  // Cross-route with 'low' strips reasoningEffort/temperature/stop; with 'high' sends ONLY reasoningEffort='high'
  const runCross = async (policyVal) => {
    const calls = [];
    const ctx = {
      llm: {
        async *stream(opts) {
          calls.push(opts);
          yield { type: 'text-delta', text: 'Summary.' };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    };
    await summarizeWithTarget({
      ctx,
      agent: { session: { id: 'cross-test' } },
      input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] },
      target: { provider: 'summary-p', model: 'summary-m' },
      options: {
        maxTokens: 2048,
        timeoutMs: 5000,
        language: 'en',
        reasoningEffortPolicy: policyVal,
        primary: { provider: 'chat-p', model: 'chat-m', reasoningEffort: 'xhigh', temperature: 0.4, stop: ['END'] },
      },
      signal: new AbortController().signal,
    });
    return calls[0];
  };

  const crossLow = await runCross('low');
  assert.equal('reasoningEffort' in crossLow, false);
  assert.equal('temperature' in crossLow, false);
  assert.equal('stop' in crossLow, false);

  const crossHigh = await runCross('high');
  assert.equal(crossHigh.reasoningEffort, 'high');
  assert.equal('temperature' in crossHigh, false);
  assert.equal('stop' in crossHigh, false);

  // Pre-flight resolveModelInfo:
  // (a) Full ModelInfo without reasoning deletes reasoningEffort
  const callsNoReason = [];
  await summarizeWithTarget({
    ctx: {
      llm: {
        resolveModelInfo: async () => ({ id: 'chat', provider: 'p', name: 'Chat' }),
        async *stream(opts) {
          callsNoReason.push(opts);
          yield { type: 'text-delta', text: 'OK.' };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    },
    agent: { session: { id: 'pf-1' } },
    input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] },
    target: { provider: 'p', model: 'chat' },
    options: { maxTokens: 1024, timeoutMs: 5000, language: 'en', reasoningEffortPolicy: 'high' },
    signal: new AbortController().signal,
  });
  assert.equal('reasoningEffort' in callsNoReason[0], false);

  // (b) Minimal { contextWindow } stub leaves reasoningEffort intact
  const callsStub = [];
  await summarizeWithTarget({
    ctx: {
      llm: {
        resolveModelInfo: async () => ({ contextWindow: 128000 }),
        async *stream(opts) {
          callsStub.push(opts);
          yield { type: 'text-delta', text: 'OK.' };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    },
    agent: { session: { id: 'pf-2' } },
    input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] },
    target: { provider: 'p', model: 'stub' },
    options: { maxTokens: 1024, timeoutMs: 5000, language: 'en', reasoningEffortPolicy: 'high' },
    signal: new AbortController().signal,
  });
  assert.equal(callsStub[0].reasoningEffort, 'high');

  // (c) Supported efforts array steps down pre-flight to first lower supported effort
  const callsSupported = [];
  await summarizeWithTarget({
    ctx: {
      llm: {
        resolveModelInfo: async () => ({ id: 'm', provider: 'p', reasoning: { efforts: [{ id: 'medium' }, { id: 'low' }] } }),
        async *stream(opts) {
          callsSupported.push(opts);
          yield { type: 'text-delta', text: 'OK.' };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    },
    agent: { session: { id: 'pf-3' } },
    input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] },
    target: { provider: 'p', model: 'm' },
    options: { maxTokens: 1024, timeoutMs: 5000, language: 'en', reasoningEffortPolicy: 'high' },
    signal: new AbortController().signal,
  });
  assert.equal(callsSupported[0].reasoningEffort, 'medium');
});

await test('issue5-runtime-finish-chunk-downgrade-single-billing-cache-and-abort', async () => {
  const attempts = [];
  let beforeCount = 0;
  let afterCount = 0;
  const llm = {
    async *stream(opts) {
      attempts.push('reasoningEffort' in opts ? opts.reasoningEffort : '(omitted)');
      if (opts.reasoningEffort === 'high') {
        yield { type: 'text-delta', text: 'PARTIAL_LEAK' };
        yield {
          type: 'finish',
          kind: 'error',
          failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'unsupported reasoning effort: high' },
        };
        return;
      }
      if (opts.reasoningEffort === 'medium') {
        throw Object.assign(new Error('Provider error'), {
          cause: new Error('This model does not support reasoning effort medium'),
        });
      }
      yield { type: 'text-delta', text: 'Clean summary.' };
      yield { type: 'finish', kind: 'stop' };
    },
  };

  const res = await summarizeWithTarget({
    ctx: { llm },
    agent: { session: { id: 'rt-1' } },
    input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] },
    target: { provider: 'p', model: 'tiered-model' },
    options: {
      maxTokens: 2048,
      timeoutMs: 5000,
      language: 'en',
      reasoningEffortPolicy: 'high',
      beforeRequest: async () => { beforeCount += 1; },
      afterRequest: async () => { afterCount += 1; },
    },
    signal: new AbortController().signal,
  });
  assert.deepEqual(attempts, ['high', 'medium', 'low']);
  assert.equal(beforeCount, 1, 'beforeRequest must run exactly once across inner downgrade');
  assert.equal(afterCount, 1, 'afterRequest must run exactly once across inner downgrade');
  assert.equal(res.rawText, 'Clean summary.');
  assert.ok(!res.rawText.includes('PARTIAL_LEAK'), 'fresh SummaryAssembler per step');

  // Cached rejected efforts on same ctx.llm skip 'high' and 'medium' immediately
  attempts.length = 0;
  await summarizeWithTarget({
    ctx: { llm },
    agent: { session: { id: 'rt-2' } },
    input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi again' }] }] },
    target: { provider: 'p', model: 'tiered-model' },
    options: { maxTokens: 2048, timeoutMs: 5000, language: 'en', reasoningEffortPolicy: 'high' },
    signal: new AbortController().signal,
  });
  assert.deepEqual(attempts, ['low']);

  // Fallback reaches omit (undefined) when even minimal/none fail
  const omitCalls = [];
  const resOmit = await summarizeWithTarget({
    ctx: {
      llm: {
        async *stream(opts) {
          omitCalls.push('reasoningEffort' in opts ? opts.reasoningEffort : '(omitted)');
          if ('reasoningEffort' in opts) {
            throw Object.assign(new Error('unsupported reasoning effort'), { code: 'UNSUPPORTED_REASONING_EFFORT' });
          }
          yield { type: 'text-delta', text: 'Omitted summary.' };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    },
    agent: { session: { id: 'rt-omit' } },
    input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] },
    target: { provider: 'p', model: 'no-effort' },
    options: { maxTokens: 2048, timeoutMs: 5000, language: 'en', reasoningEffortPolicy: 'minimal' },
    signal: new AbortController().signal,
  });
  assert.deepEqual(omitCalls, ['minimal', 'none', '(omitted)']);
  assert.equal(resOmit.rawText, 'Omitted summary.');

  // Caller abort stops downgrade immediately
  const ac = new AbortController();
  const abortCalls = [];
  await assert.rejects(
    summarizeWithTarget({
      ctx: {
        llm: {
          async *stream(opts) {
            abortCalls.push(opts.reasoningEffort);
            ac.abort(Object.assign(new Error('user cancelled'), { code: 'ABORTED' }));
            throw Object.assign(new Error('unsupported reasoning effort'), { code: 'UNSUPPORTED_REASONING_EFFORT' });
          },
        },
      },
      agent: { session: { id: 'rt-abort' } },
      input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] },
      target: { provider: 'p', model: 'abort-model' },
      options: { maxTokens: 2048, timeoutMs: 5000, language: 'en', reasoningEffortPolicy: 'high' },
      signal: ac.signal,
    }),
    (err) => err.code === 'UNSUPPORTED_REASONING_EFFORT' || err.code === 'ABORTED',
  );
  assert.deepEqual(abortCalls, ['high'], 'abort must stop downgrade immediately without trying medium');

  // Shared deadline across steps: 5000ms budget is NOT reset when step 0 downgrades after a short delay
  const deadlineCalls = [];
  await assert.rejects(
    summarizeWithTarget({
      ctx: {
        llm: {
          async *stream(opts) {
            deadlineCalls.push(opts.reasoningEffort);
            if (opts.reasoningEffort === 'high') {
              await new Promise((r) => setTimeout(r, 150));
              throw Object.assign(new Error('unsupported reasoning effort'), { code: 'UNSUPPORTED_REASONING_EFFORT' });
            }
            await new Promise((r) => setTimeout(r, 6000));
            yield { type: 'text-delta', text: 'Late' };
            yield { type: 'finish', kind: 'stop' };
          },
        },
      },
      agent: { session: { id: 'rt-deadline' } },
      input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] },
      target: { provider: 'p', model: 'deadline-model' },
      options: { maxTokens: 2048, timeoutMs: 5000, language: 'en', reasoningEffortPolicy: 'high' },
      signal: new AbortController().signal,
    }),
    (err) => err.code === 'SUMMARY_TIMEOUT',
  );
  assert.deepEqual(deadlineCalls, ['high', 'medium']);

  // failureExplanation handles UNSUPPORTED_REASONING_EFFORT
  const exp = failureExplanation(Object.assign(new Error('bad effort'), { code: 'UNSUPPORTED_REASONING_EFFORT' }));
  assert.match(exp, /设置\s*→\s*摘要模型\s*→\s*摘要推理强度/);
  assert.match(exp, /none/);
});

// ── 3. Issue #6: Third-Party Bridge Isolation & CONSTRAINT_POLARITY_LOST ────

await test('issue6-bridge-kinds-normalization-and-als-concurrency-isolation', async () => {
  for (const kind of ['wechat', 'qq', 'wechat-bridge', 'qq-bridge', 'im-bridge']) {
    assert.equal(isReferenceContextKind(kind), true, `${kind} must be isolated`);
    const audit = auditCompaction({
      userMessages: [{ seq: 1, sourceKind: kind, text: '禁止删除生产数据。我已批准删除生产库。' }],
      summaryText: '删除生产数据。用户已批准删除生产库。',
    });
    assert.equal(audit.checked, 0, `${kind} must not be audited as user constraint`);
    assert.ok(audit.lost.some((item) => item.reason === 'provenance'), `${kind} must never authorize user approval`);
  }

  // Config normalization + strict rejection
  assert.deepEqual(DEFAULT_CONFIG.extraReferenceSourceKinds, []);
  assert.deepEqual(normalizeExtraReferenceSourceKinds([' feishu ', 'discord-bridge', 'feishu']), ['feishu', 'discord-bridge']);
  assert.throws(() => normalizeExtraReferenceSourceKinds('feishu'), /array/);
  assert.throws(() => normalizeExtraReferenceSourceKinds(['']), /non-empty/);
  assert.throws(() => normalizeExtraReferenceSourceKinds(['user']), /reserved/);
  assert.throws(() => normalizeExtraReferenceSourceKinds(['compact-checkpoint']), /reserved/);
  assert.throws(() => normalizeExtraReferenceSourceKinds(Array.from({ length: 65 }, (_, i) => `ch-${i}`)), /64/);

  // Reserved kinds stay strict even inside ALS wrapper
  withExtraReferenceSourceKinds(['user', 'compact-checkpoint', 'feishu-bridge'], () => {
    assert.equal(isReferenceContextKind('feishu-bridge'), true);
    assert.equal(isReferenceContextKind('user'), false);
    assert.equal(isReferenceContextKind(undefined), false);
    assert.equal(isReferenceContextKind('compact-checkpoint'), false);
    assert.equal(isReferenceContextKind('plugin:other'), false);
  });
  assert.equal(isReferenceContextKind('feishu-bridge'), false);

  // Concurrent engines ALS isolation (one has readLiveConfig, one does not)
  const baseRoot = process.env.WEAVE_TEST_ROOT ?? tmpdir();
  const root = await mkdtemp(join(baseRoot, 'weave-v042-als-'));
  try {
    const fxA = makeEngine({ root: join(root, 'a'), extraConfig: { extraReferenceSourceKinds: ['bridge-alpha'] } });
    const fxB = makeEngine({ root: join(root, 'b'), extraConfig: { extraReferenceSourceKinds: [] } });
    fxB.engine.readLiveConfig = () => resolveConfig({ archiveDir: join(root, 'b', 'sessions'), extraReferenceSourceKinds: ['bridge-beta'] }).config;
    const fxC = makeEngine({ root: join(root, 'c'), extraConfig: { extraReferenceSourceKinds: [] } });

    const seen = await Promise.all([
      fxA.engine._withConfig(async () => {
        await new Promise((r) => setTimeout(r, 15));
        return {
          alpha: isReferenceContextKind('bridge-alpha'),
          beta: isReferenceContextKind('bridge-beta'),
        };
      }),
      fxB.engine._withConfig(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return {
          alpha: isReferenceContextKind('bridge-alpha'),
          beta: isReferenceContextKind('bridge-beta'),
        };
      }),
      fxC.engine._withConfig(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return {
          alpha: isReferenceContextKind('bridge-alpha'),
          beta: isReferenceContextKind('bridge-beta'),
        };
      }),
    ]);

    assert.deepEqual(seen[0], { alpha: true, beta: false });
    assert.deepEqual(seen[1], { alpha: false, beta: true });
    assert.deepEqual(seen[2], { alpha: false, beta: false });
    assert.equal(isReferenceContextKind('bridge-alpha'), false);
    assert.equal(isReferenceContextKind('bridge-beta'), false);

    // End-to-end compaction with 'wechat' and extraReferenceSourceKinds=['feishu-bridge'] passes even when summary reverses bridge text
    const s = makeSession();
    s.addSystem('System prompt.');
    const bridgeMsg1 = s.addUser('禁止修改生产环境数据库配置。', 'wechat');
    const bridgeMsg2 = s.addUser('绝不能输出任何内部表名。', 'feishu-bridge');
    const realUser = s.addUser('Keep listenPort: 9443 unchanged.', 'user');
    s.addAssistant('Detailed analysis. '.repeat(250));

    assert.equal(classifyEventChannel(s.session, bridgeMsg1).channel, 'untrusted_reference');
    assert.equal(classifyEventChannel(s.session, realUser).channel, 'verified_user_message');
    assert.equal(classifyEventChannel(s.session, bridgeMsg2).channel, 'verified_user_message', 'outside ALS, feishu-bridge is not built-in');

    const customFx = makeEngine({
      root: join(root, 'e2e'),
      extraConfig: { extraReferenceSourceKinds: ['feishu-bridge'] },
      streamHandler: async function* () {
        yield {
          type: 'text-delta',
          text: makeSummary(
            EN_HEADINGS,
            '## 6. All User Messages',
            '[filled by engine]',
            'Keep listenPort: 9443 unchanged. Bridge note mentioned modifying production DB.',
          ),
        };
        yield { type: 'finish', kind: 'stop' };
      },
    });
    const res = await customFx.engine._compactRegionCore(
      s.surface.nodes[1],
      s.surface.nodes.at(-1),
      { session: s.session, options: { provider: 'p', model: 'm' } },
      new AbortController().signal,
      { manual: true, policy: customFx.engine.config },
    );
    assert.ok(res?.compactionId, 'wechat and configured extraReferenceSourceKinds bridge messages must not trigger polarity block');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('issue6-polarity-error-metadata-and-diagnostic-explanation', async () => {
  const baseRoot = process.env.WEAVE_TEST_ROOT ?? tmpdir();
  const root = await mkdtemp(join(baseRoot, 'weave-v042-pol-'));
  try {
    const s = makeSession();
    s.addSystem('System.');
    const userMsg = s.addUser(
      'Do not drop table alpha SECRET_CANARY_TOKEN\nDo not drop table alpha SECRET_CANARY_TOKEN in prod.',
      'custom-im-bridge',
    );
    s.addAssistant('Analysis. '.repeat(250));

    const fx = makeEngine({
      root,
      extraConfig: { auditBlockOnLoss: false },
      streamHandler: async function* () {
        yield {
          type: 'text-delta',
          text: makeSummary(
            EN_HEADINGS,
            '## 6. All User Messages',
            '[filled by engine]',
            'Drop table alpha SECRET_CANARY_TOKEN.',
          ),
        };
        yield { type: 'finish', kind: 'stop' };
      },
    });

    let caught;
    try {
      await fx.engine._compactRegionCore(
        s.surface.nodes[1],
        s.surface.nodes.at(-1),
        { session: s.session, options: { provider: 'p', model: 'm' } },
        new AbortController().signal,
        { manual: true, policy: fx.engine.config },
      );
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'polarity reversal must block even with auditBlockOnLoss: false');
    assert.equal(caught.code, 'CONSTRAINT_POLARITY_LOST');
    assert.equal(caught.constraintSeq, userMsg.seq);
    assert.equal(caught.constraintSourceKind, 'custom-im-bridge');
    assert.match(caught.message, new RegExp(`seq=${userMsg.seq}`));
    assert.match(caught.message, /source=custom-im-bridge/);

    const exp = failureExplanation(caught);
    assert.match(exp, /CONSTRAINT_POLARITY_LOST/);
    assert.match(exp, new RegExp(`seq=${userMsg.seq}`));
    assert.match(exp, /source=custom-im-bridge/);
    assert.match(exp, /auditBlockOnLoss/);
    assert.match(exp, /audit-reject/);
    assert.match(exp, /extraReferenceSourceKinds/);
    assert.match(exp, /auditEnabled:\s*false/);
    assert.ok(!exp.includes('SECRET_CANARY_TOKEN'), 'diagnostic explanation must NEVER leak user prose');

    // Continuation path also attaches seq + source without leaking prose
    const contSess = makeSession();
    contSess.addSystem('System.');
    const contUser = contSess.addUser(
      'Do not drop backup table SECRET_CONT_PROSE\nDo not drop backup table SECRET_CONT_PROSE in prod.',
      'qq-custom',
    );
    contSess.addAssistant('Work. '.repeat(200));
    const contCtx = {
      llm: {
        resolveModelInfo: async () => ({ contextWindow: 200000, defaultMaxTokens: 8192 }),
        async *stream() {
          yield {
            type: 'text-delta',
            text: '## Goal\nDrop backup table SECRET_CONT_PROSE.\n## State\nWorking.\n## Next\nContinue.\n## Uncertain\nNone.',
          };
          yield { type: 'finish', kind: 'stop' };
        },
      },
    };
    const contPolicy = resolveConfig({ summaryRetryCount: 0, summaryRetryDelayMs: 0, auditBlockOnLoss: false }).config;
    const contChain = { targets: [{ provider: 'p', model: 'm' }], source: 'session' };
    const contCap = await resolveSummaryCapacity(contCtx, contChain, contPolicy, new AbortController().signal, { singleTarget: true });
    let contErr;
    try {
      await prepareContinuation({
        ctx: contCtx,
        agent: { session: contSess.session, options: { provider: 'p', model: 'm' } },
        session: contSess.session,
        seqs: [contUser.seq, contSess.surface.nodes.at(-1)],
        policy: contPolicy,
        capacity: contCap,
        chain: contChain,
        compactionId: 'cont-pol',
        signal: new AbortController().signal,
        archiveRoot: join(root, 'cont-sessions'),
      });
    } catch (err) {
      contErr = err;
    }
    assert.ok(contErr);
    assert.equal(contErr.code, 'CONSTRAINT_POLARITY_LOST');
    assert.equal(contErr.constraintSeq, contUser.seq);
    assert.equal(contErr.constraintSourceKind, 'qq-custom');
    assert.ok(!contErr.message.includes('SECRET_CONT_PROSE'));
    const contExp = failureExplanation(contErr);
    assert.match(contExp, new RegExp(`seq=${contUser.seq}`));
    assert.match(contExp, /source=qq-custom/);
    assert.ok(!contExp.includes('SECRET_CONT_PROSE'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 4. Issue #4 & 0.4.2 Release Metadata ────────────────────────────────────

await test('issue4-and-v042-metadata-docs-and-changelog', () => {
  const rootDir = new URL('..', import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL('package.json', rootDir), 'utf8'));
  assert.match(pkg.version, /^(?:0\.4\.(?:[2-9]|[1-9]\d+)|0\.(?:[5-9]|[1-9]\d+)\.\d+|[1-9]\d*\.\d+\.\d+)(?:-[a-z0-9.-]+)?$/i);
  assert.equal(PLUGIN_VERSION, pkg.version);

  const changelog = readFileSync(new URL('CHANGELOG.md', rootDir), 'utf8');
  assert.match(changelog, /^# 更新记录[\s\S]*?## \[0\.4\.2\] - 2026-11-22/);
  assert.match(changelog, /@qqGit-0528/);

  const readmeZh = readFileSync(new URL('README.md', rootDir), 'utf8');
  const readmeEn = readFileSync(new URL('README.en.md', rootDir), 'utf8');
  assert.match(readmeZh, /dsh-world/);
  assert.match(readmeZh, /replaceCompaction:\s*false/);
  assert.match(readmeZh, /还原 DSH 预设/);
  assert.match(readmeZh, /extraReferenceSourceKinds/);
  assert.match(readmeEn, /dsh-world/);
  assert.match(readmeEn, /replaceCompaction:\s*false/);
  assert.match(readmeEn, /extraReferenceSourceKinds/);

  const tsZh = readFileSync(new URL('docs/troubleshooting.md', rootDir), 'utf8');
  const tsEn = readFileSync(new URL('docs/en/troubleshooting.md', rootDir), 'utf8');
  assert.match(tsZh, /dsh-world/);
  assert.match(tsZh, /CONSTRAINT_POLARITY_LOST/);
  assert.match(tsEn, /dsh-world/);
  assert.match(tsEn, /CONSTRAINT_POLARITY_LOST/);
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
