import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_AUDIT_FALLBACK_CONFLICTS } from '../lib/audit-fallback.js';
import { resolveConfig } from '../lib/config.js';
import { prepareContinuation } from '../lib/continuation.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { FailureDiagnostics, failureExplanation } from '../lib/failure-diagnostics.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { CompactionProgressTracker } from '../lib/progress-tracker.js';
import { buildCompactionInstruction } from '../lib/prompt.js';
import { resolveSummaryCapacity } from '../lib/summary-budget.js';
import { resolveSummaryTargets, summarizeWithChain } from '../lib/summary.js';

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
const EN_HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeStructuredSummary(sections = {}) {
  return EN_HEADINGS.map((h, idx) => {
    if (idx === 5) return `${h}\n[filled by engine]`;
    const body = sections[idx + 1] ?? 'Historical span archived cleanly; continue below.';
    return `${h}\n${body}`;
  }).join('\n\n');
}

function makeContinuationNotes(body, goal = 'Continue bounded continuation safely.') {
  return [
    '## Goal',
    goal,
    '',
    '## State',
    body,
    '',
    '## Next',
    'Proceed with verification.',
    '',
    '## Uncertain',
    'None beyond archived items.',
  ].join('\n');
}

function makeStreamChunks(text, usage = { inputTokens: 120, outputTokens: 60, totalTokens: 180 }) {
  return async function* () {
    const mid = Math.max(1, Math.floor(text.length / 2));
    yield { type: 'text-delta', text: text.slice(0, mid) };
    yield { type: 'text-delta', text: text.slice(mid) };
    yield { type: 'finish', usage };
  };
}

async function createFixture({ extraConfig = {}, streamHandler, windowTokens = 200000 } = {}) {
  const root = await mkdtemp(join(TEST_BASE, 'weave-issue18-'));
  const sessionId = `sess-issue18-${randomUUID().slice(0, 8)}`;
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const llmCalls = [];
  const logs = [];

  const session = {
    id: sessionId,
    header: { version: 4, id: sessionId, createdAt: Date.now(), isSeeded: false },
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => [...events],
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    toolHistory: () => [],
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (event.type === 'system/message') return event.data?.message ?? event.data;
      if (event.type === 'user/message') return event.data;
      if (event.type === 'assistant/message') return event.data?.message;
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
        assert.ok(s >= 0 && e >= s);
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

  const sessionDir = join(root, 'host-sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const logPath = join(sessionDir, 'session.v4.jsonl');
  writeFileSync(logPath, `{"version":4,"id":"${sessionId}"}\n`, 'utf8');

  const agent = {
    session,
    inbox: { nextStep: [], nextTurn: [], prepend() {} },
    options: { provider: 'p', model: 'm' },
    runMaintenance: (fn) => fn(new AbortController().signal),
    cancel() {},
  };

  const ctx = {
    on: () => () => {},
    provide() {},
    logger: {
      info: (m) => logs.push({ level: 'info', msg: String(m) }),
      warn: (m) => logs.push({ level: 'warn', msg: String(m) }),
      error: (m) => logs.push({ level: 'error', msg: String(m) }),
    },
    sessions: {
      flush: async () => true,
      get: (id) => (id === sessionId ? session : undefined),
    },
    sessionPersistence: {
      locate: (header) => ({ kind: 'jsonl', path: header?.id === sessionId ? logPath : join(root, 'missing.jsonl') }),
    },
    tokenMeter: {
      measure(s = session) {
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
      async *stream(req) {
        const callIndex = llmCalls.length + 1;
        llmCalls.push({ provider: req.provider, model: req.model, messages: req.messages, callIndex });
        const raw = await streamHandler(req, callIndex);
        if (typeof raw === 'string') {
          yield* makeStreamChunks(raw)();
        } else {
          yield* raw;
        }
      },
    },
  };

  const config = resolveConfig({
    archiveDir: join(root, 'weave', 'archive'),
    language: 'en',
    failureThreshold: 3,
    summaryRetryCount: 1,
    summaryRetryDelayMs: 0,
    observationMaskingEnabled: false,
    microcompactEnabled: false,
    proactiveEnabled: false,
    continuationEnabled: false,
    preserveRecentMessages: 1,
    preserveRecentUserTokens: 20,
    auditCoverageThreshold: 0.9,
    ...extraConfig,
  }).config;

  const tracker = new CompactionProgressTracker();
  const engine = new WeaveCompactionEngine(ctx, config);
  engine.progressTracker = tracker;
  engine.historyToolsAvailable = true;

  const cleanup = async () => {
    engine.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };

  return { root, session, agent, ctx, config, engine, llmCalls, logs, addSystem, addUser, addAssistant, cleanup };
}

function readLatestDiagnosticJson(storageRoot) {
  const diagDir = join(storageRoot, 'diagnostics');
  const files = readdirSync(diagDir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 1, 'expected at least one diagnostic JSON file');
  files.sort();
  return JSON.parse(readFileSync(join(diagDir, files.at(-1)), 'utf8'));
}

// ────────────────────────────────────────────────── 1. Engine >3 blocking conflicts skips fallback with telemetry

await test('engine-exceeds-max-conflicts-records-skipped-diagnostics-and-warn-log', async () => {
  const f = await createFixture({
    extraConfig: { summaryRetryCount: 1 },
    streamHandler: () => makeStructuredSummary({ 2: 'Summarized deployment checklist without exact rules.' }),
  });
  try {
    f.addSystem('System baseline.');
    f.addUser('Always enforce immutable audit checksums on production artifacts.');
    f.addAssistant('Step 1 detail. ' + 'Log trace '.repeat(60));
    f.addUser('Never expose API credentials in stderr logs.');
    f.addAssistant('Step 2 detail. ' + 'Log trace '.repeat(60));
    f.addUser('Always validate incoming webhook signatures using HMAC.');
    f.addAssistant('Step 3 detail. ' + 'Log trace '.repeat(60));
    f.addUser('Keep database migration transactions idempotent and reversible.');
    f.addAssistant('Step 4 detail. ' + 'Log trace '.repeat(60));
    f.addUser('Proceed with next check.');
    f.addAssistant('Step 5 detail. ' + 'Log trace '.repeat(60));
    f.addUser('Continue.');

    await assert.rejects(
      () => f.engine.compactNow(f.agent, new AbortController().signal, 'cmd-exceeds-3'),
      (err) => (err?.cause ?? err)?.code === 'CONSTRAINT_LOST',
    );

    const diagJson = readLatestDiagnosticJson(join(f.root, 'weave'));
    assert.deepEqual(diagJson.auditFallback, {
      used: false,
      skippedReason: 'exceeds_max_conflicts',
      blockingCount: 4,
      maxConflicts: MAX_AUDIT_FALLBACK_CONFLICTS,
    });
    assert.doesNotMatch(JSON.stringify(diagJson.auditFallback), /checksums|credentials|HMAC|idempotent/);

    const warnLogs = f.logs.filter((entry) => entry.level === 'warn');
    assert.ok(
      warnLogs.some(
        (entry) =>
          entry.msg.includes('audit exhaustion fallback skipped') &&
          entry.msg.includes('reason=exceeds_max_conflicts') &&
          entry.msg.includes('blocking=4') &&
          entry.msg.includes(`max=${MAX_AUDIT_FALLBACK_CONFLICTS}`),
      ),
      `expected structured warn log for skipped fallback, got: ${JSON.stringify(warnLogs)}`,
    );
  } finally {
    await f.cleanup();
  }
});

// ────────────────────────────────────────────────── 2. Engine post-fallback shrinkage rejection records not_smaller

await test('engine-not-smaller-after-pinned-rules-records-not_smaller-diagnostics-and-warn-log', async () => {
  const f = await createFixture({
    extraConfig: { summaryRetryCount: 1, auditCoverageThreshold: 0.9, preserveRecentMessages: 1, preserveRecentUserTokens: 20 },
    streamHandler: () =>
      makeStructuredSummary({
        2: 'Maintain operational standards and proceed with next check.',
      }),
  });
  try {
    f.addSystem('Sys.');
    f.addUser('Always mandate full SHA-256 verification for every single configuration artifact ' + 'k'.repeat(1450) + '.');
    f.addAssistant('Noted. ' + 'Detail '.repeat(110));
    f.addUser('Proceed with next check.');
    f.addAssistant('Completed '.repeat(35));
    f.addUser('Continue.');

    await assert.rejects(
      () => f.engine.compactNow(f.agent, new AbortController().signal, 'cmd-not-smaller'),
      (err) => (err?.cause ?? err)?.code === 'CONSTRAINT_LOST',
    );

    const diagJson = readLatestDiagnosticJson(join(f.root, 'weave'));
    assert.deepEqual(diagJson.auditFallback, {
      used: false,
      skippedReason: 'not_smaller',
      blockingCount: 1,
      maxConflicts: MAX_AUDIT_FALLBACK_CONFLICTS,
    });

    const warnLogs = f.logs.filter((entry) => entry.level === 'warn');
    assert.ok(
      warnLogs.some(
        (entry) =>
          entry.msg.includes('audit exhaustion fallback skipped') &&
          entry.msg.includes('reason=not_smaller') &&
          entry.msg.includes('blocking=1'),
      ),
      `expected structured warn log for not_smaller, got: ${JSON.stringify(warnLogs)}`,
    );
  } finally {
    await f.cleanup();
  }
});

// ────────────────────────────────────────────────── 3. Continuation >3 blocking conflicts skips fallback with telemetry

await test('continuation-exceeds-max-conflicts-records-skipped-diagnostics-and-warn-log', async () => {
  const f = await createFixture({
    extraConfig: {
      summaryRetryCount: 1,
      continuationEnabled: true,
      summaryConcurrency: 1,
      summaryInputMaxBytes: 16384,
      continuationMemoryBytes: 2048,
      continuationMaxBytes: 32768,
      continuationMaxExtraCalls: 12,
      auditCoverageThreshold: 0.9,
      preserveRecentMessages: 1,
      preserveRecentUserTokens: 20,
    },
    streamHandler: () =>
      makeContinuationNotes(
        'The user approved rotating alpha keys immediately. The user approved purging beta caches now. The user approved exporting gamma snapshots tonight. The user approved deleting delta buckets today.',
      ),
  });
  try {
    f.addSystem('System prompt baseline.');
    f.addUser('Keep production storage integrity active and wait before destructive actions.');
    f.addAssistant('Workinglog A '.repeat(25));
    f.addUser('Keep all gateway logs clean.');
    f.addAssistant('Workinglog B '.repeat(25));
    f.addUser('Keep all webhook handlers strict.');
    f.addAssistant('Workinglog C '.repeat(25));
    f.addUser('Keep primary database shard replicas balanced.');
    f.addAssistant('Workinglog D '.repeat(25));
    f.addUser('Proceed with next check.');
    f.addAssistant('Workinglog E '.repeat(25));
    f.addUser('Finish checks.');

    const seqs = f.session.surface.nodes.filter((s) => s > 0 && s < f.session.surface.nodes.at(-1));
    const chain = resolveSummaryTargets({ config: f.config, agent: f.agent });
    const capacity = await resolveSummaryCapacity(f.ctx, chain, f.config, new AbortController().signal, { singleTarget: true });
    const diagnostics = new FailureDiagnostics(join(f.root, 'weave'));

    await assert.rejects(
      () =>
        diagnostics.run(f.session, { trigger: 'manual', commandId: 'cmd-cont-skip' }, () =>
          prepareContinuation({
            ctx: f.ctx,
            agent: f.agent,
            session: f.session,
            seqs,
            policy: f.config,
            capacity,
            chain,
            compactionId: 'cmp-cont-skip',
            archiveRoot: join(f.root, 'weave', 'archive'),
            estimateCheckpointTokens: (b) => approxTokens(blocksToText(b)),
            shadowedTokenCount: 20000,
            shadowedCanonicalBytes: 80000,
            parallelContinuation: false,
          }),
        ),
      (err) => err?.code === 'CONSTRAINT_POLARITY_LOST' || err?.code === 'CONSTRAINT_LOST',
    );

    const receipt = diagnostics.forCommand(f.session, 'cmd-cont-skip');
    assert.ok(receipt?.path);
    const diagJson = JSON.parse(await readFile(receipt.path, 'utf8'));
    assert.equal(diagJson.auditFallback?.used, false);
    assert.equal(diagJson.auditFallback?.skippedReason, 'exceeds_max_conflicts');
    assert.ok(diagJson.auditFallback?.blockingCount > MAX_AUDIT_FALLBACK_CONFLICTS);
    assert.equal(diagJson.auditFallback?.maxConflicts, MAX_AUDIT_FALLBACK_CONFLICTS);

    const warnLogs = f.logs.filter((entry) => entry.level === 'warn');
    assert.ok(
      warnLogs.some(
        (entry) =>
          entry.msg.includes('continuation audit exhaustion fallback skipped') &&
          entry.msg.includes('reason=exceeds_max_conflicts') &&
          entry.msg.includes(`blocking=${diagJson.auditFallback.blockingCount}`),
      ),
      `expected continuation skipped warn log, got: ${JSON.stringify(warnLogs)}`,
    );
  } finally {
    await f.cleanup();
  }
});

// ────────────────────────────────────────────────── 4. lib/summary.js multi-candidate filter, rank & sequential fallback

await test('summary-multi-candidate-filtering-blocking-count-ranking-and-sequential-fallback', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-issue18-summary-'));
  try {
    const makeArgs = ({ targets, verdictsByAttempt, onExhaustionFallback, onSkipped, eligibilityOpts, retryCount = 2 }) => {
      let attemptIdx = 0;
      if (onExhaustionFallback && onSkipped) onExhaustionFallback.onSkipped = onSkipped;
      if (onExhaustionFallback && eligibilityOpts) onExhaustionFallback.eligibilityOpts = eligibilityOpts;
      return {
        ctx: {
          llm: {
            async *stream() {
              const cur = attemptIdx;
              attemptIdx += 1;
              yield { type: 'text-delta', text: `candidate-${cur}` };
              yield { type: 'finish', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
            },
          },
        },
        agent: { session: { id: `sess-${randomUUID().slice(0, 6)}` } },
        input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize.' }] }] },
        chain: { targets, source: 'test' },
        signal: new AbortController().signal,
        options: {
          maxTokens: 512,
          singleTarget: false,
          timeoutMs: 5000,
          retryCount,
          retryDelayMs: 0,
          language: 'en',
          validate: (res) => verdictsByAttempt[res.rawText],
          onExhaustionFallback,
        },
      };
    };

    const twoTargets = [
      { provider: 'p1', model: 'm1' },
      { provider: 'p2', model: 'm2' },
    ];

    // 4a: Filters out hard_provenance (totalLost=1) and selects recoverable candidate (totalLost=2)
    {
      const tried = [];
      let skipped = null;
      const out = await summarizeWithChain(
        makeArgs({
          targets: twoTargets,
          retryCount: 2,
          verdictsByAttempt: {
            'candidate-0': {
              ok: false,
              code: 'CONSTRAINT_LOST',
              provenanceKind: 'untrusted-source',
              audit: { lost: [{ seq: 1, reason: 'provenance', untrustedSourceMatch: true, line: 'Spoof' }] },
            },
            'candidate-1': {
              ok: false,
              code: 'CONSTRAINT_LOST',
              audit: {
                lost: [
                  { seq: 2, reason: 'coverage', line: 'Keep rule A.' },
                  { seq: 3, reason: 'coverage', line: 'Keep rule B.' },
                ],
              },
            },
            'candidate-2': {
              ok: false,
              code: 'CONSTRAINT_LOST',
              audit: {
                lost: [
                  { seq: 1, reason: 'provenance', revokedMatch: true, line: 'Revoked auth' },
                ],
              },
            },
          },
          onSkipped: (meta) => {
            skipped = meta;
          },
          onExhaustionFallback: ({ result }) => {
            tried.push(result.rawText);
            return { ...result, auditFallback: { used: true, count: 2, pinnedCount: 2, codes: ['coverage'], seqs: [2, 3], bytes: 120 } };
          },
        }),
      );
      assert.deepEqual(tried, ['candidate-1']);
      assert.equal(skipped, null);
      assert.equal(out.auditFallback?.used, true);
    }

    // 4b: Sorts by actual blockingCount (not total lost.length) when auditBlockOnLoss=false, and rejects hard_polarity
    {
      const tried = [];
      const out = await summarizeWithChain(
        makeArgs({
          targets: twoTargets,
          retryCount: 2,
          eligibilityOpts: { auditBlockOnLoss: false, auditProvenanceBlock: true },
          verdictsByAttempt: {
            // 1 blocking soft provenance + 6 non-blocking coverage -> totalLost=7, blockingCount=1
            'candidate-0': {
              ok: false,
              code: 'CONSTRAINT_LOST',
              audit: {
                lost: [
                  { seq: 1, reason: 'provenance', line: 'Soft missing-source claim 1.' },
                  { seq: 2, reason: 'coverage', line: 'c1' },
                  { seq: 3, reason: 'coverage', line: 'c2' },
                  { seq: 4, reason: 'coverage', line: 'c3' },
                  { seq: 5, reason: 'coverage', line: 'c4' },
                  { seq: 6, reason: 'coverage', line: 'c5' },
                  { seq: 7, reason: 'coverage', line: 'c6' },
                ],
              },
            },
            // 2 blocking soft provenance -> totalLost=2, blockingCount=2
            'candidate-1': {
              ok: false,
              code: 'CONSTRAINT_LOST',
              audit: {
                lost: [
                  { seq: 1, reason: 'provenance', line: 'Soft missing-source claim 1.' },
                  { seq: 2, reason: 'provenance', line: 'Soft missing-source claim 2.' },
                ],
              },
            },
            // 3 blocking -> totalLost=3, blockingCount=3
            'candidate-2': {
              ok: false,
              code: 'CONSTRAINT_LOST',
              audit: {
                lost: [
                  { seq: 1, reason: 'provenance', line: 'r1' },
                  { seq: 2, reason: 'provenance', line: 'r2' },
                  { seq: 3, reason: 'provenance', line: 'r3' },
                ],
              },
            },
          },
          onExhaustionFallback: ({ result }) => {
            tried.push(result.rawText);
            return { ...result, auditFallback: { used: true, count: 1, pinnedCount: 1, codes: ['provenance'], seqs: [1], bytes: 80 } };
          },
        }),
      );
      assert.deepEqual(tried, ['candidate-0'], 'must prefer lower blockingCount=1 over blockingCount=2 even when totalLost=7');
      assert.equal(out.rawText, 'candidate-0');

      let polaritySkipped = null;
      await assert.rejects(
        () =>
          summarizeWithChain(
            makeArgs({
              targets: twoTargets,
              retryCount: 2,
              verdictsByAttempt: {
                'candidate-0': {
                  ok: false,
                  code: 'CONSTRAINT_POLARITY_LOST',
                  audit: { lost: [{ seq: 1, reason: 'polarity', line: 'Never drop logs.', candidate: 'Always drop logs.' }] },
                },
                'candidate-1': {
                  ok: false,
                  code: 'CONSTRAINT_POLARITY_LOST',
                  audit: { lost: [{ seq: 1, reason: 'polarity', line: 'Never drop logs.', candidate: 'Always drop logs.' }] },
                },
                'candidate-2': {
                  ok: false,
                  code: 'CONSTRAINT_POLARITY_LOST',
                  audit: { lost: [{ seq: 1, reason: 'polarity', line: 'Never drop logs.', candidate: 'Always drop logs.' }] },
                },
              },
              onSkipped: (meta) => {
                polaritySkipped = meta;
              },
              onExhaustionFallback: () => {
                throw new Error('hard_polarity must never invoke onExhaustionFallback');
              },
            }),
          ),
        (err) => err?.code === 'CONSTRAINT_POLARITY_LOST',
      );
      assert.equal(polaritySkipped?.skippedReason, 'hard_polarity');
    }

    // 4c: Sequential fallback: first candidate returns null (not_smaller), second candidate succeeds
    {
      const diag = new FailureDiagnostics(join(root, 'diag-4c'));
      const tried = [];
      let skipped = null;
      const out = await diag.run({ id: 'sess-4c' }, { trigger: 'manual', commandId: 'c4c' }, () =>
        summarizeWithChain(
          makeArgs({
            targets: twoTargets,
            retryCount: 2,
            verdictsByAttempt: {
              // blockingCount=1 -> tried first, rejects with not_smaller
              'candidate-0': {
                ok: false,
                code: 'CONSTRAINT_LOST',
                audit: { lost: [{ seq: 1, reason: 'coverage', line: 'Huge unshrinkable rule.' }] },
              },
              // blockingCount=2 -> tried second, succeeds
              'candidate-1': {
                ok: false,
                code: 'CONSTRAINT_LOST',
                audit: {
                  lost: [
                    { seq: 2, reason: 'coverage', line: 'Rule A.' },
                    { seq: 3, reason: 'coverage', line: 'Rule B.' },
                  ],
                },
              },
              'candidate-2': {
                ok: false,
                code: 'CONSTRAINT_LOST',
                audit: {
                  lost: [
                    { seq: 2, reason: 'coverage', line: 'Rule A.' },
                    { seq: 3, reason: 'coverage', line: 'Rule B.' },
                    { seq: 4, reason: 'coverage', line: 'Rule C.' },
                  ],
                },
              },
            },
            onSkipped: (meta) => {
              skipped = meta;
            },
            onExhaustionFallback: ({ result, blockingCount, recordSkip }) => {
              tried.push(result.rawText);
              if (result.rawText === 'candidate-0') {
                recordSkip({ skippedReason: 'not_smaller', blockingCount, maxConflicts: MAX_AUDIT_FALLBACK_CONFLICTS });
                return null;
              }
              return { ...result, auditFallback: { used: true, count: blockingCount, pinnedCount: 2, codes: ['coverage'], seqs: [2, 3], bytes: 96 } };
            },
          }),
        ),
      );
      assert.deepEqual(tried, ['candidate-0', 'candidate-1']);
      assert.equal(skipped, null);
      assert.equal(out.rawText, 'candidate-1');
      const diagJson = readLatestDiagnosticJson(join(root, 'diag-4c'));
      assert.equal(diagJson.auditFallback?.used, true);
    }

    // 4d: All eligible candidates reject -> emits primary skip reason once and writes used: false into diagnostics JSON
    {
      const diag = new FailureDiagnostics(join(root, 'diag-4d'));
      const tried = [];
      const skippedEvents = [];
      let caught = null;
      try {
        await diag.run({ id: 'sess-4d' }, { trigger: 'manual', commandId: 'c4d' }, () =>
          summarizeWithChain(
            makeArgs({
              targets: twoTargets,
              retryCount: 2,
              verdictsByAttempt: {
                'candidate-0': {
                  ok: false,
                  code: 'CONSTRAINT_LOST',
                  audit: { lost: [{ seq: 1, reason: 'coverage', line: 'First.' }] },
                },
                'candidate-1': {
                  ok: false,
                  code: 'CONSTRAINT_LOST',
                  audit: {
                    lost: [
                      { seq: 2, reason: 'coverage', line: 'Second.' },
                      { seq: 3, reason: 'coverage', line: 'Third.' },
                    ],
                  },
                },
                'candidate-2': {
                  ok: false,
                  code: 'SUMMARY_STRUCTURE_INVALID',
                },
              },
              onSkipped: (meta) => {
                skippedEvents.push(meta);
              },
              onExhaustionFallback: ({ result, blockingCount, recordSkip }) => {
                tried.push(result.rawText);
                recordSkip({
                  skippedReason: result.rawText === 'candidate-0' ? 'not_smaller' : 'no_verified_rule',
                  blockingCount,
                  maxConflicts: MAX_AUDIT_FALLBACK_CONFLICTS,
                });
                return null;
              },
            }),
          ),
        );
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.deepEqual(tried, ['candidate-0', 'candidate-1']);
      assert.deepEqual(skippedEvents, [
        {
          used: false,
          skippedReason: 'not_smaller',
          blockingCount: 1,
          maxConflicts: MAX_AUDIT_FALLBACK_CONFLICTS,
        },
      ]);
      const diagJson = readLatestDiagnosticJson(join(root, 'diag-4d'));
      assert.deepEqual(diagJson.auditFallback, skippedEvents[0]);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ────────────────────────────────────────────────── 5. failureExplanation pure-coverage CONSTRAINT_LOST guidance

await test('failureExplanation-pure-coverage-CONSTRAINT_LOST-guidance-and-strict-boundaries', () => {
  const err = (code, extras = {}) => Object.assign(new Error('audit rejected'), { code, ...extras });

  // Pure coverage CONSTRAINT_LOST gets actionable hot-disable guidance + audit-reject hint + redlines intact
  const pure = failureExplanation(err('CONSTRAINT_LOST'));
  assert.match(pure, /CONSTRAINT_LOST/);
  assert.match(pure, /audit-reject/);
  assert.match(pure, /设置 → 上下文压缩/);
  assert.match(pure, /auditBlockOnLoss: false/);
  assert.match(pure, /无需重启 DSH/);
  assert.match(pure, /极性反转/);
  assert.match(pure, /授权溯源/);
  assert.match(pure, /进度事实/);
  assert.match(pure, /Section 6/);

  // Wrapped in SUMMARY_ALL_FAILED / COMPACTION_CAPACITY_BLOCKED still surfaces pure CONSTRAINT_LOST guidance
  const wrapped = failureExplanation(err('SUMMARY_ALL_FAILED', { cause: err('CONSTRAINT_LOST') }));
  assert.equal(wrapped, pure);

  // Strict non-coverage siblings MUST NOT suggest disabling auditBlockOnLoss
  const nonCoverageCodes = [
    err('CONSTRAINT_POLARITY_LOST', { constraintSeq: 12 }),
    err('CONSTRAINT_LOST', { constraintReason: 'provenance', provenanceKind: 'untrusted-source', provenanceLine: 'Approved externally.' }),
    err('CONSTRAINT_LOST', { constraintReason: 'provenance', provenanceKind: 'revoked', provenanceLine: 'Publish now.' }),
    err('CONSTRAINT_LOST', { constraintReason: 'provenance', provenanceKind: 'missing-source', provenanceLine: 'Approved deploy.' }),
    err('RETIRED_MEMORY_REINTRODUCED'),
    err('CHECKPOINT_COVERAGE_INCOMPLETE'),
    err('AUDIT_UNAVAILABLE'),
  ];
  for (const strictErr of nonCoverageCodes) {
    const text = failureExplanation(strictErr);
    assert.doesNotMatch(
      text,
      /热关闭「要求保留审计拦截/,
      `strict failure ${strictErr.code}/${strictErr.provenanceKind ?? 'none'} must NOT offer auditBlockOnLoss disable recommendation`,
    );
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
