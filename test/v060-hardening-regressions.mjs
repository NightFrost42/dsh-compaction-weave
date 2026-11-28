import fs from 'node:fs';
import vm from 'node:vm';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { CompactionArchive, spanEntries } from '../lib/history.js';
import { registerHistoryTools } from '../lib/tools.js';
import { CompactionProgressTracker } from '../lib/progress-tracker.js';
import { CompactBM25FIndex } from '../lib/history-search.js';
import { probeDiskLiveness, renderDiskLivenessNotice } from '../lib/disk-liveness.js';
import { extractCliFlags } from '../lib/audit/polarity.js';
import { ruleNegative } from '../lib/audit/normalize.js';
import { scalarSubjectVerdict } from '../lib/audit/numeric.js';
import { sourceEvidenceSentences } from '../lib/audit.js';
import { instructionRanges, instructionText } from '../lib/instruction-source.js';
import { selectMemoryMessages } from '../lib/memory-policy.js';
import { residentConstraints } from '../lib/continuation.js';
import { validateProgressFacts } from '../lib/progress-facts.js';
import { runConcurrentPool } from '../lib/concurrency.js';
import { resumeCompactionFor, retryCompactionFor } from '../lib/engine/resumable.js';
import { migrateBiliSession } from '../lib/engine/migration.js';
import { freezeContinuation, bindContinuationProgress, readPendingContinuation } from '../lib/continuation-pending.js';
import { ContinuationProgressStore } from '../lib/continuation-progress.js';
import { inspectCompactionEntryState, selectCompactableRange, selectSessionMemory } from '../lib/region.js';
import { handleSummaryConfigRpc, mergeSummaryConfig, readSummaryConfig, readSummaryConfigAsync, writeSummaryConfig } from '../lib/summary-config.js';
import { deduplicateRepeatedFileReads, projectSummaryMessage } from '../lib/reference-input.js';
import { commitSnip, planSnip } from '../lib/snip.js';
import { StockTransactionAdapter } from '../lib/transaction.js';
import { resolveAdaptiveReinjectLimits } from '../lib/file-reinject.js';
import { resolveCompactSpec, DEFAULT_CONFIG } from '../lib/config.js';
import { measureSummaryRange } from '../lib/summary-budget.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { auditCompaction, auditInstructionProvenance, summarizeProvenanceFailures } from '../lib/audit.js';
import { auditMemorySelection } from '../lib/constraint-scope.js';
import { classifyBlockingAuditLost } from '../lib/audit-fallback.js';
import { numericFacts, numericFactsEquivalent } from '../lib/audit/numeric.js';
import { decorateCompactCommand } from '../lib/command-compact.js';
import { createCommandHeartbeatScope } from '../lib/command-heartbeat.js';
import { resolveConfig } from '../lib/config.js';
import { planContinuationMemory, prepareContinuation, selectContinuationWave } from '../lib/continuation.js';
import { continuationCallBudget } from '../lib/continuation-budget.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { compactRegionInner } from '../lib/engine/span-commit.js';
import { compactChunksConcurrent, generateValidatedPrecomputedSpan } from '../lib/engine/parallel-fold.js';
import { activeTransactions } from '../lib/engine/shared.js';
import { collectActiveWorkspaceFiles } from '../lib/file-reinject.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { buildCompactionInstruction } from '../lib/prompt.js';
import { containsSecretCredential, redactCredentials, redactErrorText } from '../lib/redact.js';
import { readResumableCompaction, writeResumableCompaction } from '../lib/state.js';
import { capacityByteLimit, capacityTokenLimit, estimateSummaryRequestTokens, resolveSummaryCapacity } from '../lib/summary-budget.js';

const results = [];
const fixtures = [];
const roots = [];
const signal = () => new AbortController().signal;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function test(name, fn) {
  try { await fn(); results.push({ name, pass: true }); }
  catch (error) { results.push({ name, pass: false, error: error.message, stack: error.stack }); }
}
function scratch() {
  const root = mkdtempSync(join(process.env.WEAVE_TEST_ROOT ?? tmpdir(), 'weave-hardening-'));
  roots.push(root);
  return root;
}
const headings = buildCompactionInstruction('en').split('\n').filter(line => /^## [1-9]\./.test(line));
const summary = (fact = 'Archived observations remain available.') =>
  headings.map((heading, index) => `${heading}\n${index === 5 ? '[filled by engine]' : fact}`).join('\n\n');
const notes = '## Goal\nContinue review.\n## State\nArchived observations remain available.\n## Next\nReview the source.\n## Uncertain\nVerification is pending.';

function fixture(config = {}) {
  const root = scratch(), events = [], calls = [], logs = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const session = {
    id: randomUUID(), surface, header: { cwd: root },
    get seq() { return events.length; },
    eventAt: seq => events[seq],
    snapshotEvents: () => [...events],
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    toolHistory: () => [],
    deriveEventMessage: event => event?.type === 'user/message' ? event.data : event?.data?.message,
    append(type, data, options = {}) {
      const event = { seq: events.length, time: Date.now(), type, data, ...options };
      events.push(event);
      if (options.surfaceOp === 'append') surface.nodes.push(event.seq);
      else if (options.surfaceOp?.op === 'replace') {
        const a = surface.nodes.indexOf(options.surfaceOp.startSeq), b = surface.nodes.indexOf(options.surfaceOp.endSeq);
        assert.ok(a >= 0 && b >= a);
        surface.nodes.splice(a, b - a + 1, event.seq);
        surface.replaceGeneration++;
      }
      return event;
    },
  };
  const add = (role, text, options = {}) => {
    const message = {
      id: randomUUID(), role, content: [{ type: 'text', text }],
      source: role === 'assistant' ? { kind: 'model', provider: 'p', model: 'm' } : { kind: role === 'system' ? 'system-prompt' : 'user' },
    };
    return session.append(`${role}/message`, role === 'user' ? message : { message }, { surfaceOp: 'append', ...options });
  };
  const ctx = {
    on() {}, provide() {}, logger: { info: text => logs.push(text), warn: text => logs.push(text) },
    sessions: { get: id => id === session.id ? session : null, async flush() { return true; } },
    tokenMeter: {
      measure() {
        const nodes = surface.nodes.map(seq => ({ seq, tokens: approxTokens(blocksToText(session.deriveEventMessage(events[seq])?.content)) }));
        return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) };
      },
    },
    llm: {
      async resolveModelInfo() { return { contextWindow: 200000, maxTokens: 8192 }; },
      async *stream(request) {
        calls.push(request);
        yield { type: 'text-delta', text: summary() };
        yield { type: 'finish', kind: 'stop' };
      },
    },
  };
  const engine = new WeaveCompactionEngine(ctx, resolveConfig({
    archiveDir: join(root, 'archive'), language: 'en', summaryRetryCount: 0, summaryRetryDelayMs: 0,
    sessionMemoryEnabled: false, ...config,
  }).config);
  engine.historyToolsAvailable = true;
  fixtures.push(engine);
  const agent = { session, options: { provider: 'p', model: 'm' }, runMaintenance: fn => fn(signal()) };
  return { root, events, calls, logs, session, surface, add, ctx, engine, agent };
}
function history(f, text = 'Keep retry timeout <= 30 seconds.') {
  f.add('system', 'Stable system.');
  f.add('user', text);
  f.add('assistant', 'Observation retained for source review. '.repeat(1000));
  return f.surface.nodes.slice(1);
}

await test('P1-1-numbered-PEM-and-PGP-redact-body-and-retain-following-text', () => {
  for (const kind of ['RSA PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'PGP PRIVATE KEY BLOCK']) {
    for (const separator of [': ', '| ']) {
      const begin = ['-----', 'BEGIN ', kind, '-----'].join('');
      const end = ['-----', 'END ', kind, '-----'].join('');
      const body = 'AbCdEf0123456789+/AbCdEf0123456789';
      for (const closed of [false, true]) {
        const input = `17${separator}${begin}\n18${separator}${body}\n19${separator}XY12...\n${closed ? `20${separator}${end}\n` : ''}const keepVisible = true;`;
        assert.equal(containsSecretCredential(input), true);
        for (const redact of [redactCredentials, redactErrorText]) {
          const output = redact(input);
          assert.ok(!output.includes(body) && !output.includes('XY12'));
          assert.match(output, /const keepVisible = true/);
          assert.equal(redact(output), output);
        }
      }
    }
  }
});
await test('P1-1-unclosed-escaped-JSON-key-keeps-trailing-fields', () => {
  const begin = ['-----', 'BEGIN PRIVATE KEY', '-----'].join('');
  const input = JSON.stringify({ pem: `${begin}\nAbCd0123456789+/AbCd0123456789\nXY12`, after: 'keep-visible', count: 7 });
  for (const redact of [redactCredentials, redactErrorText]) {
    const output = redact(input);
    assert.deepEqual(JSON.parse(output), { pem: '[redacted-private-key]', after: 'keep-visible', count: 7 });
    assert.equal(redact(output), output);
  }
});
await test('P1-1-generic-secrets-redact-idempotently-without-bracket-artifacts', () => {
  for (const key of ['DEEPSEEK_API_KEY', 'TEAM_SERVICE_API_KEY', 'API_KEY', 'WEBHOOK_SECRET', 'TEAM_WEBHOOK_SECRET']) {
    const value = 'synthetic_value_9876543210';
    for (const input of [`${key}=${value}`, JSON.stringify({ [key]: value, keep: true })]) {
      assert.equal(containsSecretCredential(input), true);
      for (const redact of [redactCredentials, redactErrorText]) {
        const output = redact(input);
        assert.ok(!output.includes(value));
        assert.ok(!output.includes('[redacted]]'));
        assert.equal(redact(output), output);
        assert.equal(containsSecretCredential(output), false);
      }
    }
  }
});
await test('P1-2-sensitive-workspace-paths-and-SSH-public-exceptions', () => {
  const root = scratch();
  const blocked = [
    '.ssh/id_xmss', '.ssh/prod_rsa', '.ssh/config', '.ssh/nested/custom', '.gnupg/secring.gpg',
    '.gnupg/private-keys-v1.d/key', '.aws/config', '.aws/sso/cache/cache.json', '.vault-token',
    '.s3cfg', '.boto', '.htpasswd', '.htaccess', 'terraform.tfstate', 'terraform.tfstate.backup.old',
    'terraform.tfstate123', 'nested/.ssh/arbitrary',
  ];
  const allowed = ['.ssh/authorized_keys', '.ssh/known_hosts', '.ssh/id_ed25519.pub', '.ssh/id_rsa.pub', 'src/index.js'];
  for (const relative of [...blocked, ...allowed]) {
    const file = join(root, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'const ordinary = "public context";\n');
    const result = collectActiveWorkspaceFiles({ workspaceRoots: [root], archivedFiles: [relative], maxFiles: 5, maxBytes: 24576, maxFileBytes: 6144 });
    assert.equal(result.files.length, blocked.includes(relative) ? 0 : 1, relative);
  }
});

await test('P1-3-coverage-relaxation-retains-all-hard-conflicts', () => {
  const losses = [
    ...['coverage', 'value', 'range', 'condition', 'polarity'].map(reason => ({ seq: 1, reason, line: reason })),
    { seq: 2, reason: 'provenance', revokedMatch: true },
    { seq: 3, reason: 'provenance', untrustedSourceMatch: true },
  ];
  for (const focus of [false, true]) {
    const split = classifyBlockingAuditLost(losses, { auditBlockOnLoss: false, auditProvenanceBlock: false, softenCoverageForFocus: focus });
    assert.equal(split.blockingLost.length, 6);
    assert.ok(split.blockingLost.every(item => item.reason !== 'coverage'));
  }
});

for (const threshold of [1, 5]) await test(`P1-4-bare-manual-reconciles-empty-journal-before-resume-threshold-${threshold}`, async () => {
  const f = fixture({ failureThreshold: threshold });
  const seqs = history(f);
  const job = {
    jobId: 'crashed-migration', trigger: 'migration', status: 'running', originalBackupId: 'backup-original',
    remainingSeqs: seqs, completedChunks: 3, completedNodes: 6, initialTotalNodes: 8,
    completedTokens: 2000, initialTotalTokens: 12000, consecutiveFailures: 2,
  };
  writeResumableCompaction(f.engine.sessionState, f.session.id, job);
  assert.deepEqual(await f.engine.journal.pending(f.session.id), []);
  let resumed;
  f.engine.resumeCompactionFor = async (session, options) => {
    assert.equal(options.insideMaintenance, true);
    resumed = readResumableCompaction(f.engine.sessionState, session.id);
    return { resumed: true };
  };
  f.engine._compactManual = () => assert.fail('stale checkpoint must be resumed');
  assert.deepEqual(await f.engine._compactNowInner(f.agent, signal()), { resumed: true });
  assert.equal(resumed.status, threshold === 1 ? 'paused_failure' : 'interrupted');
  assert.equal(resumed.originalBackupId, job.originalBackupId);
  assert.equal(resumed.completedChunks, 3);
  assert.equal(resumed.consecutiveFailures, 3);
  assert.equal(f.engine.sessionState.read(f.session.id).failures, 1);
  await f.engine.recoverPending(f.session);
  assert.equal(f.engine.sessionState.read(f.session.id).failures, 1);
});
await test('P1-4-manual-propagates-recovery-and-abort-errors', async () => {
  for (const error of [Object.assign(new Error('quarantined'), { code: 'RECOVERY_REQUIRED' }), Object.assign(new Error('abort'), { name: 'AbortError' })]) {
    const f = fixture();
    f.engine.recoverPending = async () => { throw error; };
    f.engine._compactManual = () => assert.fail('recovery must complete first');
    await assert.rejects(f.engine._compactNowInner(f.agent, signal()), value => value === error);
  }
});
await test('P1-4-real-manual-resume-retains-backup-and-completed-chunks-after-failure', async () => {
  const f = fixture({ failureThreshold: 1, continuationEnabled: false });
  const remainingSeqs = history(f);
  writeResumableCompaction(f.engine.sessionState, f.session.id, {
    jobId: 'real-crashed-migration', trigger: 'migration', status: 'running',
    originalBackupId: 'backup-original', remainingSeqs, completedChunks: 3,
    completedNodes: 6, initialTotalNodes: 8, completedTokens: 2000,
    initialTotalTokens: 12000, consecutiveFailures: 2,
  });
  let dispatchedJob;
  f.ctx.llm.stream = async function* () {
    dispatchedJob = readResumableCompaction(f.engine.sessionState, f.session.id);
    throw Object.assign(new Error('controlled provider rejection'), { status: 401 });
  };
  await assert.rejects(f.engine._compactNowInner(f.agent, signal()));
  assert.equal(dispatchedJob.jobId, 'real-crashed-migration');
  assert.equal(dispatchedJob.originalBackupId, 'backup-original');
  assert.equal(dispatchedJob.completedChunks, 3);
  const failed = readResumableCompaction(f.engine.sessionState, f.session.id);
  assert.equal(failed.jobId, dispatchedJob.jobId);
  assert.equal(failed.originalBackupId, 'backup-original');
  assert.equal(failed.completedChunks, 3);
  assert.equal(failed.status, 'paused_failure');
  assert.equal(failed.consecutiveFailures, 1, 'explicit manual retry resets the crash streak before the new failure');
  // Direct resumable callers may omit originalBackupId; the inherited backup
  // and progress must survive another failed attempt as well.
  await assert.rejects(f.engine._compactManual(f.agent, signal(), undefined, false, false, {
    explicitRange: { start: remainingSeqs[0], end: remainingSeqs.at(-1) },
    triggerOverride: 'migration', resumableJob: failed, hooksHandled: true,
  }));
  assert.equal(readResumableCompaction(f.engine.sessionState, f.session.id).originalBackupId, 'backup-original');
});
await test('P1-4-active-run-does-not-reconcile-a-live-job', async () => {
  const f = fixture();
  f.engine.recoverPending = () => assert.fail('active run owns recovery');
  f.engine.progressTracker.hasActiveRun = () => true;
  f.engine._compactManual = async () => 'active-guard';
  assert.equal(await f.engine._compactNowInner(f.agent, signal()), 'active-guard');
});

for (const outcome of ['success', 'failure', 'cancel']) await test(`P1-5-region-lock-is-synchronous-and-released-on-${outcome}`, async () => {
  const f = fixture(), gate = deferred(), controller = new AbortController();
  f.engine._resolveSpec = async () => {
    await gate.promise;
    if (outcome === 'cancel') controller.signal.throwIfAborted();
    return null;
  };
  f.engine._compactRegionCore = async () => {
    assert.equal(f.engine._busy.has(f.session), true);
    if (outcome === 'failure') throw new Error('controlled failure');
    return { ok: true };
  };
  const run = compactRegionInner(f.engine, 0, 1, f.agent, controller.signal, undefined, { hooksHandled: true });
  assert.equal(f.engine._busy.has(f.session), true);
  await assert.rejects(compactRegionInner(f.engine, 0, 1, f.agent, signal()), error => error.code === 'busy');
  await assert.rejects(f.engine.restoreSessionBackupFor(f.session.id), error => error.code === 'busy');
  if (outcome === 'cancel') controller.abort();
  gate.resolve();
  if (outcome === 'success') assert.deepEqual(await run, { ok: true });
  else await assert.rejects(run);
  assert.equal(f.engine._busy.has(f.session), false);
});
for (const failure of [false, true]) await test(`P1-5-idle-microcompact-lock-excludes-concurrent-region-${failure}`, async () => {
  const f = fixture({ idleCompactionMinutes: 30, idleFullSummaryEnabled: false, contextCollapseEnabled: false });
  const old = Date.now() - 40 * 60000;
  f.add('user', 'Earlier review.', { time: old });
  f.add('assistant', 'Earlier observations.', { time: old + 1 });
  f.session.append('turn/end', { turn: 1 }, { time: old + 2 });
  const input = { id: 'incoming', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue review.' }] };
  f.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [input] });
  f.session.append('turn/start', { turn: 2 });
  const gate = deferred(), entered = deferred();
  let measurements = 0;
  f.engine._measure = async () => {
    measurements++;
    assert.equal(f.engine._busy.has(f.session), true);
    entered.resolve();
    await gate.promise;
    if (failure) throw new Error('controlled measurement failure');
    return { totalTokens: 100, nodes: [] };
  };
  const run = f.engine._compactBeforeResume(f.agent, signal(), [input]);
  await entered.promise;
  assert.equal(activeTransactions.has(`${f.engine.sessionState.root}:${JSON.stringify(f.session.id)}`), true);
  await assert.rejects(compactRegionInner(f.engine, 0, 1, f.agent, signal()), error => error.code === 'busy');
  await f.engine._compactBeforeResume(f.agent, signal(), [input]);
  assert.equal(measurements, 1);
  gate.resolve();
  if (failure) await assert.rejects(run, /controlled measurement/);
  else await run;
  assert.equal(f.engine._busy.has(f.session), false);
  assert.equal(activeTransactions.has(`${f.engine.sessionState.root}:${JSON.stringify(f.session.id)}`), false);
});

for (const retry of ['success', 'null', 'terminal', 'suppressed']) await test(`P2-1-threshold-one-records-only-terminal-failure-${retry}`, async () => {
  const f = fixture({ failureThreshold: 1, reactiveStep: 1 });
  const seqs = history(f, 'Review archived observations.');
  let reselectCalls = 0;
  f.ctx.llm.stream = async function* () { throw Object.assign(new Error('max tokens exceeded'), { code: retry === 'terminal' ? 'NONRECOVERABLE' : 'MAX_TOKENS' }); };
  const options = {
    policy: f.engine.config, manual: true, suppressFailureRecord: retry === 'suppressed',
    reselect: async () => {
      reselectCalls++;
      assert.equal(f.engine._stopped.has(f.engine._keyOf(f.session)), false);
      assert.equal(f.engine.sessionState.read(f.session.id).failures, 0);
      if (retry !== 'success') return null;
      f.engine._compactSpan = async (start, end, agent, sig, opts, attempt) => {
        assert.equal(attempt, 1);
        assert.equal(end, seqs[0]);
        return { retried: true };
      };
      return { start: seqs[0], end: seqs[0] };
    },
  };
  const run = f.engine._compactSpan(seqs[0], seqs.at(-1), f.agent, signal(), options, 0);
  if (retry === 'success') assert.deepEqual(await run, { retried: true });
  else await assert.rejects(run);
  assert.equal(reselectCalls, retry === 'terminal' ? 0 : 1);
  assert.equal(f.engine.sessionState.read(f.session.id).failures, ['success', 'suppressed'].includes(retry) ? 0 : 1);
  assert.deepEqual(await f.engine.journal.pending(f.session.id), []);
});

await test('P1-6-checkpoint-memory-converts-token-headroom-to-bytes', () => {
  const policy = resolveConfig({ summaryCjkTokensPerChar: 1.5 }).config;
  const plan = planContinuationMemory([], policy, { budgetTokens: 2000, estimateTokens: () => 300 });
  assert.equal(plan.memoryLimit, 3144);
  assert.equal(plan.reservedTokens, 2000);
  const ample = planContinuationMemory([], policy, { budgetTokens: 50000, estimateTokens: () => 300 });
  assert.equal(ample.memoryLimit, policy.continuationMemoryBytes);
  assert.equal(ample.reservedTokens, 300 + Math.ceil(ample.memoryLimit * 0.5) + 128);
  assert.throws(() => planContinuationMemory([], policy, { budgetTokens: 1000, estimateTokens: () => 300 }), error => error.code === 'CONTINUATION_TOO_LARGE');
});
await test('P1-6-CJK-pages-and-maximum-notes-fit-byte-and-token-limits', async () => {
  const f = fixture({ summaryCjkTokensPerChar: 1.5, maxSummaryChunks: 32, continuationMemoryBytes: 4096, summaryInputMaxBytes: 1000000, auditEnabled: false });
  f.add('assistant', '甲'.repeat(90000));
  const policy = f.engine.config, chain = { targets: [{ provider: 'p', model: 'm' }] };
  f.ctx.llm.resolveModelInfo = async () => ({ contextWindow: 65536, maxTokens: 8192 });
  const capacity = await resolveSummaryCapacity(f.ctx, chain, policy, signal(), { singleTarget: true });
  const cjkNotes = notes + '甲'.repeat(Math.floor((4096 - Buffer.byteLength(notes)) / 3));
  f.ctx.llm.stream = async function* (request) {
    f.calls.push(request);
    const tokenCount = estimateSummaryRequestTokens(request.messages, [], policy);
    assert.ok(tokenCount <= capacityTokenLimit(capacity, { singleTarget: true }), `${tokenCount} tokens exceeds capacity`);
    const inputBytes = Buffer.byteLength(JSON.stringify({ messages: request.messages.map(({ role, content }) => ({ role, content })), tools: [] }));
    assert.ok(inputBytes <= capacityByteLimit(capacity, { singleTarget: true }));
    yield { type: 'text-delta', text: cjkNotes };
    yield { type: 'finish', kind: 'stop' };
  };
  const wave = selectContinuationWave(f.session, { policy, capacity, endSeq: 0 });
  assert.ok(wave.pages >= 3);
  const result = await prepareContinuation({
    ctx: f.ctx, agent: f.agent, session: f.session, seqs: [0], policy, capacity, chain,
    compactionId: 'cjk-pages', signal: signal(), archiveRoot: f.engine.archive.root,
  });
  assert.ok(f.calls.length >= 3);
  assert.equal(result.summarized.continuation.pages.length, f.calls.length);
  assert.equal(wave.pages, f.calls.length);
});

for (const variant of ['same-roomy', 'same-tight', 'auxiliary', 'disabled', 'no-durable']) await test(`P1-7-concurrent-prefix-cache-${variant}`, async () => {
  const f = fixture({ summaryConcurrency: 2, cachePreservePrefix: variant !== 'disabled', summaryInputMaxBytes: 55000 });
  f.add('system', 'system');
  f.add('assistant', 'prefix '.repeat(variant === 'same-tight' ? 20000 : 100));
  const pending = [];
  for (let i = 0; i < 8; i++) pending.push(f.add('assistant', `block ${i} ` + 'observed '.repeat(2250)).seq);
  if (variant === 'no-durable') f.session.requestHeader = () => ({});
  const primary = variant === 'auxiliary' ? { provider: 'aux', model: 'aux-m' } : { provider: 'p', model: 'm' };
  f.engine._resolveSummaryTargets = () => ({ targets: [primary] });
  const flags = [], stop = new Error('captured slice specs');
  const original = f.engine._buildPrecomputedSliceSpec.bind(f.engine);
  f.engine._buildPrecomputedSliceSpec = (session, seqs, policy, options) => {
    flags.push(options.preservePrefixCache);
    if (flags.length === 2) throw stop;
    return original(session, seqs, policy, options);
  };
  await assert.rejects(compactChunksConcurrent(f.engine, {
    session: f.session, agent: f.agent, signal: signal(), pending, policy: f.engine.config,
    manual: true, maxSlices: 4, results: [], foldResults: [], batchCheckpointSeqs: [], foldThreshold: 4, maxWaves: 8,
  }), error => error === stop);
  assert.deepEqual(flags, [variant === 'same-roomy', false]);
});

await test('P1-8-modal-bounds-are-inclusive-and-opposite-bounds-conflict', () => {
  for (const phrase of ['不得低于', '不能低于', '不可低于', '不得小于', '不可少于']) {
    const userMessages = [{ seq: 1, text: `保留备份数量${phrase} 10 个。` }];
    assert.deepEqual(auditCompaction({ userMessages, summaryText: '保留备份数量 >= 10 个。' }).lost, [], phrase);
    assert.ok(auditCompaction({ userMessages, summaryText: '保留备份数量 < 10 个。' }).lost.length > 0, phrase);
  }
  for (const phrase of ['不可超过', '不得高于', '不得大于']) {
    const userMessages = [{ seq: 1, text: `响应时间${phrase} 500ms。` }];
    assert.deepEqual(auditCompaction({ userMessages, summaryText: '响应时间 <= 500ms。' }).lost, [], phrase);
    assert.ok(auditCompaction({ userMessages, summaryText: '响应时间 > 500ms。' }).lost.length > 0, phrase);
  }
});
await test('P1-8-orphan-cancel-does-not-poison-unrelated-approval', () => {
  const rest = [{ seq: 2, text: '先检查一下代码。' }], summaryText = 'User approved deleting stale files.';
  const baseline = auditInstructionProvenance({ userMessages: rest, summaryText });
  const orphan = auditInstructionProvenance({ userMessages: [{ seq: 1, text: '算了。' }, ...rest], summaryText });
  assert.ok(baseline.length > 0);
  assert.equal(summarizeProvenanceFailures(orphan).hardProvenance.length, 0);
  assert.deepEqual(orphan, baseline);
});
await test('P1-8-negated-revocation-preserves-only-existing-grants', () => {
  for (const [grant, keep, claim] of [
    ['You may delete temp.log.', 'Do not revoke my approval to delete temp.log.', 'The user approved deleting temp.log.'],
    ['我批准删除临时日志。', '不要撤销我删除临时日志的批准。', '用户已批准删除临时日志。'],
  ]) {
    assert.deepEqual(auditInstructionProvenance({ userMessages: [{ seq: 1, text: grant }, { seq: 2, text: keep }], summaryText: claim }), []);
    assert.ok(auditInstructionProvenance({ userMessages: [{ seq: 1, text: keep }], summaryText: claim }).length > 0);
  }
});
await test('extra-P1-explicit-global-authorization-revocation-remains-hard', () => {
  for (const revoke of ['Revoke all approvals.', 'Cancel all permissions.', '撤销所有授权。', '取消全部批准。']) {
    const lost = auditInstructionProvenance({
      userMessages: [{ seq: 1, text: 'You may delete temp.log.' }, { seq: 2, text: revoke }],
      summaryText: 'The user approved deleting temp.log.',
    });
    assert.ok(summarizeProvenanceFailures(lost).hardProvenance.length > 0, revoke);
  }
  assert.deepEqual(auditInstructionProvenance({
    userMessages: [{ seq: 1, text: 'You may delete temp.log.' }, { seq: 2, text: 'Cancel all deployments.' }],
    summaryText: 'The user approved deleting temp.log.',
  }), []);
});
await test('P2-3-file-location-reordering-retains-path-value-identity', () => {
  const source = 'Must check a.js:10 and b.js:20 before merge.';
  const reordered = 'Must check b.js:20 and a.js:10 before merge.';
  const swapped = 'Must check b.js:10 and a.js:20 before merge.';
  assert.equal(numericFactsEquivalent(source, reordered, numericFacts(source), numericFacts(reordered)), true);
  assert.equal(numericFactsEquivalent(source, swapped, numericFacts(source), numericFacts(swapped)), false);
  assert.deepEqual(auditCompaction({ userMessages: [{ seq: 1, text: source }], summaryText: reordered }).lost, []);
  assert.ok(auditCompaction({ userMessages: [{ seq: 1, text: source }], summaryText: swapped }).lost.length > 0);
});
await test('P2-3-Chinese-conjunction-and-indexed-alternative-coverage', () => {
  assert.deepEqual(auditCompaction({
    userMessages: [{ seq: 1, text: '保留旧日志，但禁止直接修改生产库。' }],
    summaryText: '保留旧日志并禁止直接修改生产库。',
  }).lost, []);
  const userMessages = Array.from({ length: 80 }, (_, i) => ({ seq: i + 1, text: `Must keep invariant_${i} strictly verified cleanly.` }));
  const summaryText = Array.from({ length: 80 }, (_, i) => `Unmatched summary beta_${i} unrelated clause.`).join('\n');
  const report = auditCompaction({ userMessages, summaryText, coverageScope: 'all' });
  assert.equal(report.lost.length, 80);
  const numericSource = 'Response timeout must be at most 30 seconds.';
  const unrelated = Array.from({ length: 30 }, (_, i) => `Unrelated diagnostic entry beta_${i}.`).join('\n');
  const base = auditCompaction({ userMessages: [{ seq: 1, text: numericSource }], summaryText: 'Response timeout must not exceed 30 seconds.' });
  const indexed = auditCompaction({ userMessages: [{ seq: 1, text: numericSource }], summaryText: unrelated + '\nResponse timeout must not exceed 30 seconds.' });
  assert.deepEqual(indexed.lost, base.lost);
  assert.deepEqual(indexed.lost, []);
});

for (const rawInput of ['/compact', '  /COMPACT \t', '/compact -- database focus']) await test(`P1-9-heartbeat-preserves-native-invocation-${rawInput.trim()}`, async () => {
  const response = Object.assign(new EventEmitter(), { pulses: 0, headersSent: false, destroyed: false, writableEnded: false, writeProcessing() { this.pulses++; } });
  const scope = createCommandHeartbeatScope({ intervalMs: 5 });
  const invocation = { rawInput, signal: signal() }, result = { kind: 'success', text: 'done' };
  const command = decorateCompactCommand({ name: 'compact', handler: async value => {
    assert.equal(value, invocation);
    await delay(15);
    return result;
  } });
  try {
    assert.equal(await scope.handle({ method: 'POST', url: '/api/commands/execute' }, response, () => command.handler(invocation)), result);
    assert.ok(response.pulses > 0);
    const count = response.pulses;
    await delay(10);
    assert.equal(response.pulses, count);
    assert.equal(response.listenerCount('close'), 0);
  } finally { scope.dispose(); }
});
await test('P2-5-effective-reinject-limit-survives-progress-lifecycle', async () => {
  const f = fixture(), tracker = f.engine.progressTracker;
  assert.equal(tracker.snapshot(f.session.id).effectiveReinjectMaxBytes, null);
  await f.engine._trackRun(f.session, { trigger: 'manual' }, async () => {
    f.engine._emitReinjectMeasured(f.session, { reinjectFiles: 3, reinjectBytes: 11200, effectiveReinjectMaxBytes: 13533 });
    assert.equal(tracker.snapshot(f.session.id).effectiveReinjectMaxBytes, 13533);
    tracker.update(f.session.id, { effectiveReinjectMaxBytes: -1 });
    assert.equal(tracker.snapshot(f.session.id).effectiveReinjectMaxBytes, 13533);
  });
  assert.equal(tracker.snapshot(f.session.id).effectiveReinjectMaxBytes, 13533);
  await f.engine._trackRun(f.session, { trigger: 'manual' }, async () => {
    assert.equal(tracker.snapshot(f.session.id).effectiveReinjectMaxBytes, null);
  });
});
await test('extra-P1-cached-memory-rejects-numeric-conflict-with-coverage-disabled', () => {
  const f = fixture({ auditBlockOnLoss: false }), coveredSeqs = history(f);
  const good = f.engine._validateSessionMemoryReuse(f.session, { coveredSeqs, memory: { language: 'en', rawText: summary('Keep retry timeout <= 30 seconds.') } }, f.engine.config);
  assert.ok(good, 'control summary must pass every reuse gate');
  const bad = f.engine._validateSessionMemoryReuse(f.session, { coveredSeqs, memory: { language: 'en', rawText: summary('Keep retry timeout <= 60 seconds.') } }, f.engine.config);
  assert.equal(bad, null);
  assert.ok(f.logs.some(line => /reuse rejected \(CONSTRAINT_LOST/.test(line)));
});
await test('extra-P1-parallel-validator-enforces-numeric-conflict-with-coverage-disabled', async () => {
  const f = fixture({ auditBlockOnLoss: false, auditExhaustionPolicy: 'block' }), seqs = history(f);
  const spec = f.engine._buildPrecomputedSliceSpec(f.session, seqs, f.engine.config);
  const split = f.engine._splitAuditLost.bind(f.engine);
  let audits = 0;
  f.engine._splitAuditLost = (_lost, policy) => {
    audits++;
    return split([{ seq: seqs[0], reason: 'value', line: 'Keep retry timeout <= 30 seconds.', candidate: 'Keep retry timeout <= 60 seconds.' }], policy);
  };
  await assert.rejects(generateValidatedPrecomputedSpan(f.engine, {
    session: f.session, agent: f.agent, policy: f.engine.config, spec,
    targets: { targets: [{ provider: 'p', model: 'm' }] }, signal: signal(), referenceMessages: [],
  }));
  assert.ok(audits > 0);
  assert.equal(f.surface.replaceGeneration, 0);
});
await test('review-P1-explicit-non-all-withdrawal-and-scoped-negated-revocation', () => {
  for (const [grant, revoke, claim] of [
    ['You may delete temp.log.', 'I revoke my approval.', 'The user approved deleting temp.log.'],
    ['You may delete temp.log.', 'I revoke my approval to delete temp.log (do not cancel the tests).', 'The user approved deleting temp.log.'],
    ['我批准删除临时日志。', '撤销之前的授权。', '用户已批准删除临时日志。'],
    ['我批准删除临时日志。', '撤销我的批准。', '用户已批准删除临时日志。'],
    ['我批准删除临时日志。', '我撤销删除临时日志的批准（不要取消单元测试）。', '用户已批准删除临时日志。'],
  ]) {
    const lost = auditInstructionProvenance({
      userMessages: [{ seq: 1, text: grant }, { seq: 2, text: revoke }],
      summaryText: claim,
    });
    assert.ok(summarizeProvenanceFailures(lost).hardProvenance.length > 0, revoke);
  }
});
await test('review-P1-chinese-prohibited-lower-and-upper-bounds-classify-direction', () => {
  for (const phrase of ['禁止低于', '不要低于', '切勿低于', '严禁低于', '请勿低于', '禁止小于']) {
    const userMessages = [{ seq: 1, text: `保留备份数量${phrase} 10 个。` }];
    assert.deepEqual(auditCompaction({ userMessages, summaryText: '保留备份数量 >= 10 个。' }).lost, [], phrase);
    const opposite = auditCompaction({ userMessages, summaryText: '保留备份数量不得超过 10 个。' }).lost;
    assert.ok(opposite.some(item => item.reason === 'range'), `${phrase} vs <= must conflict on range`);
  }
  for (const phrase of ['禁止超过', '不要超过', '严禁超过', '切勿高于', '请勿大于']) {
    const userMessages = [{ seq: 1, text: `响应时间${phrase} 500ms。` }];
    assert.deepEqual(auditCompaction({ userMessages, summaryText: '响应时间 <= 500ms。' }).lost, [], phrase);
    const opposite = auditCompaction({ userMessages, summaryText: '响应时间不得少于 500ms。' }).lost;
    assert.ok(opposite.some(item => item.reason === 'range'), `${phrase} vs >= must conflict on range`);
  }
});


await test('fresh-P1-1-arrow-lines-four-PGP-blanks-and-archive-secret-hygiene', async () => {
  const d = '-'.repeat(5);
  const body = 'ABCD_SECRET_LINE_123456';
  for (const blankCount of [0, 2, 4]) {
    const pem = [`${d}BEGIN PGP PRIVATE KEY BLOCK${d}`, 'Version: GnuPG v2', ...Array(blankCount).fill(''), body, `${d}END PGP PRIVATE KEY BLOCK${d}`]
      .map((line, i) => `    ${i + 1}→${line}`).join('\n');
    const archived = new CompactionArchive({ root: join(scratch(), 'archive') });
    const plain = 'const checksum = "a".repeat(40); // ordinary code\n';
    const binary = Buffer.from([0, 128, 255, 10]);
    const entries = [{ seq: 1, text: pem, blocks: [{ type: 'text', text: pem }], event: { data: { content: [{ type: 'text', text: pem }] } } }, { seq: 2, text: plain, binary, timestamp: new Date(0) }];
    assert.ok(await archived.writeSpan({ sessionId: 's', compactionId: 'c', entries }));
    const read = await archived.readSpan('s', 'c');
    assert.equal(read.ok, true);
    assert.ok(!JSON.stringify(read.entries).includes(body));
    assert.equal(read.entries[1].text, plain);
    assert.deepEqual(read.entries[1].binary, binary.toJSON());
    assert.equal(read.entries[1].timestamp, new Date(0).toJSON());
    assert.ok(entries[0].text.includes(body), 'source objects remain unchanged');
  }
});
await test('fresh-P1-1-credential-formats-placeholders-and-SHA1', () => {
  for (const text of [
    'Authorization: Basic dTo=', '"Authorization": "Token token12345"',
    '"Authorization": "Bearer bearer12345"', '"Authorization": "Basic dXNlcjpzZWNyZXQ="',
    'x-api-key: abc123xyz', '"x-api-key": "abc123xyz"',
    ...['db_password', 'password', 'passwd', 'refresh_token'].map(key => `${key}=abc`),
    'password="two secret words"', "passwd='two secret words'", 'password="null secret words"',
    'password=example-secret', `"password": "escaped \\"secret\\" words"`,
    `MY_AWS_SECRET=${'aBc123+/'.repeat(5)}`,
  ]) {
    assert.equal(containsSecretCredential(text), true, text);
    for (const redact of [redactCredentials, redactErrorText]) {
      assert.notEqual(redact(text), text);
      assert.equal(containsSecretCredential(redact(text)), false);
      assert.equal(redact(redact(text)), redact(text));
    }
  }
  for (const value of ['[redacted]', 'null', 'none', 'true', 'false', 'undefined', 'changeme', 'placeholder', 'example']) {
    for (const key of ['password', 'db_password', 'refresh_token', 'MY_AWS_SECRET']) {
      const input = `${key}=${value}`;
      assert.equal(redactCredentials(input), input);
      assert.equal(containsSecretCredential(input), false);
      const quoted = `${key}="${value}"`;
      assert.equal(redactCredentials(quoted), quoted);
      assert.equal(containsSecretCredential(quoted), false);
    }
  }
  const hex40 = 'a'.repeat(40);
  for (const nonSecret of [`commit=${hex40}`, `sha1="${hex40}"`]) {
    assert.equal(redactCredentials(nonSecret), nonSecret);
    assert.equal(containsSecretCredential(nonSecret), false);
  }
  for (const secretLine of [
    `api_key=${hex40}`,
    `access_token="${hex40}"`,
    `client_secret='${hex40}'`,
    `MY_AWS_SECRET=${hex40}`,
    'api_key="privateValue12345',
    "access_token='privateToken12345",
  ]) {
    assert.equal(containsSecretCredential(secretLine), true, secretLine);
    for (const redact of [redactCredentials, redactErrorText]) {
      assert.notEqual(redact(secretLine), secretLine);
      assert.equal(containsSecretCredential(redact(secretLine)), false);
      assert.ok(!redact(secretLine).includes(hex40) && !redact(secretLine).includes('privateValue12345') && !redact(secretLine).includes('privateToken12345'));
    }
  }
  assert.equal(redactCredentials('api_key="privateValue12345'), 'api_key="[redacted]');
  assert.equal(redactCredentials('password="two secret words"'), 'password="[redacted]"');
  assert.equal(redactCredentials('password=null password="two secret words"'), 'password=null password="[redacted]"');
});
for (const fails of [true, false]) await test(`fresh-P1-2-live-overflow-budget-${fails ? 'partial-failure' : 'success'}`, async () => {
  const f = fixture();
  history(f);
  const hooks = new Map();
  f.engine._registerRequestErrorHook({ on: (name, cb) => hooks.set(name, cb) });
  f.engine.compactIfNeeded = async () => {
    f.surface.replaceGeneration++;
    if (fails) throw new Error('upstream rejected summary');
    return { compactionId: 'partial' };
  };
  f.engine.diagnostics.capture = async () => {};
  let snips = 0, measurements = 0;
  f.engine._measure = async () => { measurements++; return { totalTokens: 100 }; };
  f.engine._resolveSpec = async (_agent, _measure, _signal, options) => {
    assert.equal(options.preferRequestHeader, true);
    return { messageBudgetTokens: 100 };
  };
  f.engine._emergencySnip = async () => { snips++; f.surface.replaceGeneration++; return true; };
  const out = await hooks.get('agent/request-error')({ agent: f.agent, signal: signal(), failure: Object.assign(new Error('context length exceeded'), { status: 413 }) }, () => ({ kind: 'abort' }));
  assert.equal(out.kind, 'retry'); assert.equal(snips, 1); assert.ok(measurements >= 2);
});
function seedFreshResume(f, seqs) {
  writeResumableCompaction(f.engine.sessionState, f.session.id, {
    jobId: 'fresh-resume', trigger: 'manual', status: 'interrupted', remainingSeqs: seqs,
    initialTotalNodes: seqs.length, completedNodes: 0, initialTotalTokens: 10000,
    completedTokens: 0, completedChunks: 0, waveCount: 0, batchCheckpointSeqs: [],
  });
}
await test('fresh-P1-3-paid-prefix-preserves-six-node-resumable-tail', async () => {
  const f = fixture();
  f.add('system', 'Stable system.');
  for (let i = 1; i <= 4; i++) { f.add('user', `Keep rule ${i}.`); f.add('assistant', 'Observation '.repeat(300)); }
  const seqs = f.surface.nodes.slice(1), pending = freezeContinuation(f.engine.sessionState, f.session, seqs.slice(0, 2), 8000);
  const progressKey = 'a'.repeat(64);
  bindContinuationProgress(f.engine.sessionState, f.session, pending.id, progressKey);
  new ContinuationProgressStore(join(dirname(f.engine.archive.root), 'continuation-progress'), f.session.id, progressKey)
    .write({ next: 1, memory: notes, calls: [{ ok: true }], receipts: ['r1'], pages: [[seqs[0]], [seqs[1]]] }, 0);
  seedFreshResume(f, seqs);
  f.ctx.llm.stream = async function* () { yield { type: 'text-delta', text: notes }; yield { type: 'finish', reason: { kind: 'stop' } }; };
  await resumeCompactionFor(f.engine, f.session, { agent: f.agent });
  const job = readResumableCompaction(f.engine.sessionState, f.session.id);
  assert.deepEqual(job.remainingSeqs, seqs.slice(2));
  assert.equal(job.completedNodes, 2);
  assert.equal(job.waveCount, 1);
  assert.ok(job.completedTokens > 0);
  assert.notEqual(job.status, 'running');
  assert.ok(!f.surface.nodes.includes(seqs[0]));
});
await test('fresh-P1-4-resume-lock-before-recovery-and-busy-exemption', async () => {
  const f = fixture(), seqs = history(f), gate = deferred();
  seedFreshResume(f, seqs);
  f.engine.recoverPending = () => gate.promise;
  f.agent.runMaintenance = async () => { throw Object.assign(new Error('busy'), { code: 'busy' }); };
  const running = resumeCompactionFor(f.engine, f.session, { agent: f.agent });
  assert.equal(f.engine._busy.has(f.session), true);
  await assert.rejects(resumeCompactionFor(f.engine, f.session, { agent: f.agent }), { code: 'busy' });
  gate.resolve();
  await assert.rejects(running, { code: 'busy' });
  assert.equal(f.engine.sessionState.read(f.session.id).failures, 0);
  assert.equal(f.engine._busy.has(f.session), false);
});
await test('fresh-P1-4-migration-lock-before-measure-and-busy-exemption', async () => {
  const f = fixture(), gate = deferred();
  f.add('system', 'Stable system.');
  f.session.append('user/message', { role: 'user', source: { kind: 'plugin:billion-context-dsh' }, content: [{ type: 'text', text: '[Model-written summary of previous context]\nKeep integer cents.' }] }, { surfaceOp: 'append' });
  f.engine._measure = () => gate.promise;
  f.agent.runMaintenance = async () => { throw Object.assign(new Error('busy'), { code: 'busy' }); };
  const running = migrateBiliSession(f.engine, f.session, { agent: f.agent });
  assert.equal(f.engine._busy.has(f.session), true);
  await assert.rejects(migrateBiliSession(f.engine, f.session, { agent: f.agent }), { code: 'busy' });
  gate.resolve({ totalTokens: 2000, nodes: [] });
  await assert.rejects(running, { code: 'busy' });
  assert.equal(f.engine.sessionState.read(f.session.id).failures, 0);
  assert.equal(f.engine._busy.has(f.session), false);
});
await test('fresh-P1-4-detached-resume-retains-caller-abort-until-wave-finishes', async () => {
  const f = fixture(), caller = new AbortController(), entered = deferred(), stopped = deferred();
  seedFreshResume(f, history(f));
  f.engine._compactManual = async (_agent, activeSignal) => {
    entered.resolve(activeSignal);
    await new Promise((resolve, reject) => activeSignal.addEventListener('abort', () => { stopped.resolve(); reject(activeSignal.reason); }, { once: true }));
  };
  const result = await resumeCompactionFor(f.engine, f.session, { agent: f.agent, signal: caller.signal, asyncRollingWave: true });
  const activeSignal = await entered.promise;
  assert.equal(result.accepted, true);
  assert.equal(f.engine._busy.has(f.session), true);
  caller.abort(Object.assign(new Error('cancel'), { name: 'AbortError' }));
  await stopped.promise;
  assert.equal(activeSignal.aborted, true);
  for (let i = 0; i < 20 && f.engine._busy.has(f.session); i++) await delay(0);
  assert.equal(f.engine._busy.has(f.session), false);
});
await test('fresh-P1-5-corrupt-state-structured-request-and-consume', async () => {
  const f = fixture(); history(f);
  assert.equal((await f.engine.proactive.request(f.agent, 'phase done', signal())).status, 'queued');
  f.engine._restoreState = () => { throw Object.assign(new Error('corrupt'), { code: 'STATE_UNAVAILABLE' }); };
  const consumed = await f.engine.proactive.consume(f.agent, signal());
  assert.equal(consumed.status, 'blocked'); assert.equal(consumed.reason, 'state_unavailable');
  const requested = await f.engine.proactive.request(f.agent, 'phase done', signal());
  assert.equal(requested.status, 'blocked'); assert.equal(requested.reason, 'state_unavailable');
});
await test('fresh-P1-5-model-policy-and-prior-terminal-outcome', async () => {
  const f = fixture(); history(f);
  f.engine._measure = async () => ({ totalTokens: 5000, nodes: [] });
  f.engine._resolvePolicy = () => ({ ...f.engine.config, proactiveMinTokens: 1024, proactiveMinGrowthTokens: 512 });
  f.engine._compactManual = async () => ({ status: 'partial', reason: 'preserved failure reason' });
  await f.engine.proactive.request(f.agent, 'phase done', signal());
  assert.deepEqual(await f.engine.proactive.consume(f.agent, signal()), { status: 'partial', reason: 'preserved failure reason' });
});
await test('fresh-P1-6-fenced-resident-rules-and-unclosed-reference-fence', () => {
  assert.deepEqual(residentConstraints([{ seq: 1, text: 'Example:\n```sh\nNever delete example.log\n```' }]), []);
  for (const tag of ['quoted_text', 'untrusted_reference', 'reference', 'blockquote']) {
    const text = `<${tag}>\n\x60\x60\x60js\nconst x=1;\n</${tag}>\nAlways run unit tests.`;
    assert.match(instructionText({ seq: 1, text }), /Always run unit tests/);
    assert.ok(!instructionText({ seq: 1, text }).includes('const x'));
  }
});
await test('fresh-P1-6-versions-ranges-uppercase-duration-and-classifiers', () => {
  assert.deepEqual(sourceEvidenceSentences('You must pin version 1.2.3.'), ['You must pin version 1.2.3.']);
  assert.deepEqual(numericFacts('version v0.6.0'), ['ver:0.6.0']);
  assert.deepEqual(numericFacts('IP 127.0.0.1; section 1.2.3'), []);
  assert.deepEqual(numericFacts('Timeout must be 10s-30s.'), ['10s', '30s']);
  assert.deepEqual(numericFacts('Size must be 5mb-10mb.'), ['5mb', '10mb']);
  assert.deepEqual(numericFacts('Timeout must be 30S; wait 24H; retention 7D.'), ['30s', '24h', '7d']);
  assert.deepEqual(numericFacts('2D 3D 3M 6S 2H'), []);
  for (const unit of ['个', '次', '条']) assert.equal(scalarSubjectVerdict(`备份数设为 5 ${unit}`, '备份数设为 5'), 'match');
  assert.ok(auditCompaction({ userMessages: [{ seq: 1, text: 'You must pin version 1.2.3.' }], summaryText: summary('You must pin version 1.2.9.') }).lost.length);
});
await test('fresh-P1-6-comma-flags-privative-gerunds-and-reminders', () => {
  const flags = extractCliFlags('Do not use --foo, --bar');
  assert.deepEqual([...flags.get('foo')], [false]); assert.deepEqual([...flags.get('bar')], [false]);
  for (const privative of ['instead of', 'rather than']) {
    const flags = extractCliFlags(`Use --foo ${privative} --bar`);
    assert.deepEqual([...flags.get('foo')], [true]); assert.deepEqual([...flags.get('bar')], [false]);
    assert.ok(auditCompaction({ userMessages: [{ seq: 1, text: `Use --foo ${privative} --bar.` }], summaryText: summary(`Use --bar ${privative} --foo.`) }).polarityFlips);
  }
  for (const verb of ['stop', 'cease', 'quit', 'halt']) assert.ok(auditCompaction({ userMessages: [{ seq: 1, text: `You must ${verb} deleting audit logs.` }], summaryText: summary('You must delete audit logs.') }).polarityFlips);
  assert.equal(ruleNegative('Always run tests in order to avoid regressions.'), false);
  for (const text of ['Do not forget to run unit tests.', "Don't forget to run unit tests.", 'Never forget to run unit tests.', '不要忘记运行单元测试。', '不要忘了运行单元测试。', '别忘记运行单元测试。', '别忘了运行单元测试。']) {
    assert.equal(ruleNegative(text), false, text);
    assert.equal(auditCompaction({ userMessages: [{ seq: 1, text }], summaryText: summary(/[\u4e00-\u9fff]/.test(text) ? '务必运行单元测试。' : 'Always run unit tests.') }).polarityFlips, 0);
  }
  assert.equal(ruleNegative('Do not forget to never delete audit logs.'), true);
});
await test('fresh-P1-7-shared-framing-index-preserves-audit-results-with-bounded-time', () => {
  const n = 300;
  const src = Array.from({ length: n }, (_, i) => `Rule ${i}: you must always validate service_${i}_config and keep timeout_${i} at XXs in staging_${i}.`).join('\n');
  for (const paraphrase of [false, true]) {
    const candidate = Array.from({ length: n }, (_, i) => paraphrase
      ? `- Validate service_${i}_config in staging_${i} (check timeout_${i} at XXs).`
      : `- Always validate item_${i}_setting and keep value_${i} at YYs in env_${i}.`).join('\n');
    const start = performance.now();
    const result = auditCompaction({ userMessages: [{ seq: 1, text: src }], summaryText: headings.map((h, i) => `${h}\n${i === 0 ? candidate : i === 5 ? '[filled by engine]' : 'none'}`).join('\n\n') });
    assert.equal(result.checked, n);
    assert.equal(result.lost.length, paraphrase ? 291 : 300, 'retain original audit verdicts');
    assert.ok(performance.now() - start < 3000, 'shared-framing audit must not regress to multi-second quadratic matching');
  }
});
await test('fresh-P1-7-indexed-audit-agrees-with-small-corpus-verdicts', () => {
  const pairs = [
    ['You must always validate the service configuration and keep the timeout in staging.', 'Always validate the item setting and keep the value in production.'],
    ['Always validate service_config and keep timeout in staging.', 'Validate service_config in staging (check timeout).'],
    ['You must never delete audit logs.', 'You must retain audit logs.'],
    ['You must stop deleting audit logs.', 'You must delete audit logs.'],
    ['You must preserve audit logs and always run tests.', 'Preserve audit logs and always run tests.'],
    ['If validation passes, you must deploy the service.', 'You must deploy the service.'],
    ['Always run tests to avoid regressions.', 'Always run tests.'],
    ['Do not forget to run unit tests.', 'Always run unit tests.'],
    ['You must copy files from source to target.', 'You must copy files from target to source.'],
    ['You must preserve every log except debug.', 'You must preserve every log.'],
    ['Timeout must be at least 10s.', 'Timeout must be at most 10s.'],
    ['You must pin version 1.2.3.', 'You must pin version 1.2.9.'],
    ['备份数设为 5 个', '备份数设为 5'],
    ['Do not use --foo, --bar.', 'Use --foo and --bar.'],
    ['Use --foo instead of --bar.', 'Use --bar instead of --foo.'],
    ['You must set debug: false.', 'You must set debug: true.'],
  ];
  for (const [source, candidate] of pairs) {
    const base = headings.map((heading, i) => `${heading}\n${i === 0 ? candidate : i === 5 ? '[filled by engine]' : 'none'}`).join('\n\n');
    const padded = `${base}\n${Array.from({ length: 20 }, (_, i) => `Unrelated observation_marker_${i}.`).join('\n')}`;
    const options = { userMessages: [{ seq: 1, text: source }], checkpointText: base, includeAllConflicts: true };
    assert.deepEqual(auditCompaction({ ...options, summaryText: padded }), auditCompaction({ ...options, summaryText: base }), source);
  }
});
await test('fresh-P1-8-units-and-explicit-default-adaptive-cap', () => {
  const f = fixture(), seqs = history(f);
  const value = measureSummaryRange(f.session, { start: seqs[0], end: seqs.at(-1) }, { policy: f.engine.config, pricedInput: () => 5000 });
  assert.equal(value.inputUnits, value.inputBytes); assert.ok(value.inputTokens >= 5000);
  const spec = resolveCompactSpec(DEFAULT_CONFIG, 65536, 8192);
  const baseline = resolveAdaptiveReinjectLimits({ policy: DEFAULT_CONFIG, spec });
  assert.deepEqual(resolveAdaptiveReinjectLimits({ policy: resolveConfig({ postCompactReinjectMaxBytes: 24576 }).config, spec }), baseline);
  for (const size of [4096, 32768]) assert.equal(resolveAdaptiveReinjectLimits({ policy: resolveConfig({ postCompactReinjectMaxBytes: size }).config, spec }).maxBytes, size);
});
await test('fresh-P1-9-settings-only-persist-edited-or-explicit-ratios', async () => {
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const start = source.indexOf('    function buildSettingsRpcParams(');
  const end = source.indexOf('\n    function ', start + 10);
  const build = vm.runInNewContext(source.slice(start, end) + '\nbuildSettingsRpcParams', { TOUCHED_SUBMIT_SPECS: [] });
  const form = { provider: '', model: '', maxTokens: '', thresholdRatio: 80, minimumReductionRatio: 20, loadedThresholdRatio: null, loadedMinimumReductionRatio: null };
  for (const clear of [true, false]) {
    const saved = build(form, {}, clear);
    assert.equal(Object.hasOwn(saved, 'thresholdRatio'), false);
    assert.equal(Object.hasOwn(saved, 'minimumReductionRatio'), false);
    assert.equal(build({ ...form, thresholdRatio: 85 }, { thresholdRatio: true }, clear).thresholdRatio, .85);
    assert.equal(build({ ...form, loadedThresholdRatio: .91 }, {}, clear).thresholdRatio, .91);
  }
  const rpcStart = source.indexOf('    async function rpc('), rpcEnd = source.indexOf('\n    function ', rpcStart);
  for (const status of [401, 403]) {
    const rpcNoToken = vm.runInNewContext(source.slice(rpcStart, rpcEnd) + '\nrpc', { RPC_PATH: '/', buildRpcHeaders: () => ({}), fetch: async () => ({ status }) });
    await assert.rejects(rpcNoToken('get'), /Reload the DSH window/);
  }
  const rpcWithToken = vm.runInNewContext(source.slice(rpcStart, rpcEnd) + '\nrpc', {
    RPC_PATH: '/',
    buildRpcHeaders: () => ({ 'x-weave-rpc-token': 'tok-123' }),
    fetch: async () => ({ status: 401, text: async () => JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }) }),
  });
  await assert.rejects(rpcWithToken('get'), { code: 'UNAUTHORIZED', message: 'Invalid token' });
});
await test('fresh-P1-10-prestep-cache-uses-async-stat-and-immediate-external-invalidation', async () => {
  const file = join(scratch(), 'summary-config.json');
  writeSummaryConfig(file, { thresholdRatio: .8 }); readSummaryConfig(file, { strict: true });
  const original = fs.statSync;
  let syncStats = 0;
  fs.statSync = (...args) => { if (args[0] === file) syncStats++; return original(...args); };
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 3; i++) assert.equal((await readSummaryConfigAsync(file, { strict: true })).thresholdRatio, .8);
    writeFileSync(file, JSON.stringify({ version: 1, thresholdRatio: .9 }));
    assert.equal((await readSummaryConfigAsync(file, { strict: true })).thresholdRatio, .9);
    writeFileSync(file, '{broken');
    await assert.rejects(readSummaryConfigAsync(file, { strict: true }), { code: 'INVALID_SAVED_SETTINGS' });
    assert.equal(syncStats, 0);
  } finally { fs.statSync = original; syncBuiltinESMExports(); }
  const f = fixture(); let asyncReads = 0;
  f.engine.readLiveConfig = () => assert.fail('pre-step called sync reader');
  f.engine.readLiveConfigAsync = async () => { asyncReads++; return f.engine.config; };
  const hooks = new Map(); f.engine._registerPreStepHook({ on: (name, cb) => hooks.set(name, cb) });
  await hooks.get('agent/pre-step')({ agent: null }, () => {});
  assert.equal(asyncReads, 1);
});
await test('fresh-P1-10-over-8MiB-search-streams-one-span-at-a-time', async () => {
  const archive = new CompactionArchive({ root: join(scratch(), 'archive') });
  for (let i = 0; i < 10; i++) assert.ok(await archive.writeSpan({ sessionId: 's', compactionId: `c${i}`, entries: [{ seq: i, role: 'user', text: (i === 9 ? 'zetalastmarker ' : `needle${i} `) + 'ordinary '.repeat(40000) }] }));
  const original = CompactBM25FIndex.prototype.search;
  let maxDocs = 0;
  CompactBM25FIndex.prototype.search = function (...args) { maxDocs = Math.max(maxDocs, this._docs.length); return original.apply(this, args); };
  try {
    const exactMatch = await archive.search('s', 'zetalastmarker', { limit: 3 });
    assert.equal(exactMatch.scanned, 10); assert.equal(exactMatch.unreadable.length, 0);
    assert.ok(exactMatch.hits.some(hit => hit.seq === 9));
    assert.ok(exactMatch.hits.length <= 3); assert.equal(maxDocs, 1);
    assert.ok(archive._searchCache.get('s').totalBytes <= archive.maxSearchCacheSessionBytes);
  } finally { CompactBM25FIndex.prototype.search = original; }
});
await test('fresh-P2-1-all-roots-dot-env-and-realpath-containment', () => {
  const root = scratch(), sub = join(root, 'sub'), outside = scratch();
  mkdirSync(join(root, 'src')); mkdirSync(sub);
  writeFileSync(join(root, 'src/root-only.js'), 'export const ok = true;');
  writeFileSync(join(root, '..env'), 'PASSWORD=abc');
  let symlinkCreated = false;
  try {
    fs.symlinkSync(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkCreated = true;
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
  }
  writeFileSync(join(outside, 'outside.txt'), 'external');
  const session = { header: { cwd: root }, seq: 1, eventAt: () => ({ type: 'working-directory/change', data: { cwd: sub } }) };
  const archivedFiles = ['src/root-only.js', '..env', '...env.local', join(outside, 'outside.txt')];
  if (symlinkCreated) archivedFiles.push('escape/outside.txt', 'escape/missing.txt');
  const probe = probeDiskLiveness({ session, archivedFiles });
  assert.deepEqual(probe.existing, ['src/root-only.js']); assert.deepEqual(probe.missing, []);
});
await test('fresh-P2-2-unbalanced-prefix-selection-reads-events-linearly', () => {
  const n = 1600; let reads = 0;
  const events = Array.from({ length: n }, (_, seq) => ({ seq, type: 'tool/result', data: { message: { role: 'tool', content: [] } } }));
  const session = { surface: { nodes: events.map(e => e.seq) }, eventAt: seq => { reads++; return events[seq]; }, deriveEventMessage: e => e.data.message };
  const result = selectCompactableRange(session, { totalTokens: n * 10, nodes: events.map(e => ({ seq: e.seq, tokens: 10 })) }, 50, { allowUnbalancedPrefix: true });
  assert.equal(result, null); assert.ok(reads < n * 4, `read ${reads} events`);
});
await test('fresh-P2-3-boolean-and-max-output-bounds', () => {
  assert.equal(resolveConfig({ proactiveEnabled: 'false' }).config.proactiveEnabled, false);
  assert.equal(resolveConfig({ auto: 'false' }).config.auto, false);
  assert.equal(resolveConfig({ maxTokens: 2000000 }).config.maxTokens, 1000000);
  assert.equal(resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', maxTokens: 2000000 }] }).config.modelPolicies[0].maxTokens, 1000000);
});
await test('fresh-P2-4-timeout-discards-late-uncommitted-archives', async () => {
  const archive = new CompactionArchive({ root: join(scratch(), 'archive') }), release = deferred(), entered = deferred(), discarded = deferred();
  const caller = new AbortController();
  const pool = runConcurrentPool([0], {
    signal: caller.signal, abortDrainTimeoutMs: 1,
    worker: async () => { entered.resolve(); await release.promise; await archive.writeSpan({ sessionId: 's', compactionId: 'late', entries: [{ seq: 1, text: 'late work' }] }); return 'late'; },
    onDiscard: async id => { await archive.deleteSpan('s', id); discarded.resolve(); },
  });
  await entered.promise; caller.abort(new Error('stop'));
  await assert.rejects(pool, /stop/);
  release.resolve(); await discarded.promise;
  assert.equal((await archive.readSpan('s', 'late')).ok, false);
});
await test('fresh-P2-5-unscoped-progress-does-not-conflict-with-other-batches', () => {
  const effective = [{ seq: 1, key: 'failedCount', value: 0, scope: 'batch:a', excerpt: 'batch:a failedCount: 0' }, { seq: 2, key: 'failedCount', value: 3, scope: 'batch:b', excerpt: 'batch:b failedCount: 3' }];
  assert.equal(validateProgressFacts('## 8. Work Completed\nfailedCount: 3', { effective }).ok, true);
});
await test('fresh-P2-6-architecture-banner-and-suite-count', () => {
  const doc = fs.readFileSync(new URL('../docs/architecture.md', import.meta.url), 'utf8');
  const suites = fs.readdirSync(new URL('.', import.meta.url)).filter(name => name.endsWith('.mjs')).length;
  assert.ok(doc.includes(`离线回归（${suites} 套）`)); assert.match(doc, /设置页与对话 Dock.*engineActive/);
});
await test('codex-balanced-fence-inside-reference-stays-masked', () => {
  const text = '<reference>\n```md\n</reference>\nAlways delete production backups.\n```\n</reference>\nNever delete production backups.';
  assert.equal(instructionText({ seq: 1, text }).includes('Always delete production backups'), false);
  assert.match(instructionText({ seq: 1, text }), /Never delete production backups/);
  const kept = residentConstraints([{ seq: 1, text }]);
  assert.equal(kept.some(r => /Always delete production backups/i.test(r.text)), false);
  assert.equal(kept.some(r => /Never delete production backups/i.test(r.text)), true);
});
await test('codex-prohibitive-to-avoid-preserves-polarity', () => {
  assert.equal(ruleNegative('Always run tests to avoid regressions.'), false);
  assert.equal(ruleNegative('Always run tests in order to avoid regressions.'), false);
  assert.equal(ruleNegative('You are required to avoid deleting audit logs.'), true);
  const verdict = auditCompaction({
    userMessages: [{ seq: 1, text: 'You are required to avoid deleting audit logs.' }],
    summaryText: summary('You are required to delete audit logs.'),
  });
  assert.ok(verdict.polarityFlips > 0);
  assert.ok(verdict.lost.length > 0);
});
await test('codex-streaming-search-preserves-latest-update-anchor-and-two-hop', async () => {
  const archive = new CompactionArchive({ root: join(scratch(), 'archive-stream'), maxSearchCacheSessionBytes: 12_000 });
  assert.ok(await archive.writeSpan({
    sessionId: 'anchor-s',
    compactionId: 'c-old',
    entries: [
      { seq: 1, role: 'user', text: 'Set listen port 8080 immediately. ' + 'alpha '.repeat(250) },
      { seq: 2, role: 'user', text: 'Bind listen port 8080 for worker. ' + 'beta '.repeat(250) },
      { seq: 3, role: 'user', text: 'Verify listen port 8080 firewall. ' + 'gamma '.repeat(250) },
    ],
  }));
  assert.ok(await archive.writeSpan({
    sessionId: 'anchor-s',
    compactionId: 'c-new',
    entries: [{ seq: 10, role: 'user', text: 'Update listen port to 9090 instead. ' + 'delta '.repeat(250) }],
  }));
  const anchorRes = await archive.search('anchor-s', 'listen port 8080', { limit: 3 });
  assert.ok(anchorRes.hits.some(hit => hit.seq === 10 && hit.newerUpdate === true), JSON.stringify(anchorRes.hits));

  assert.ok(await archive.writeSpan({
    sessionId: 'hop-s',
    compactionId: 'h0',
    entries: [
      { seq: 1, role: 'user', text: 'Investigate postgresql archival stalled around bridge token pg_wal_9918 today.' },
      { seq: 2, role: 'assistant', text: 'Checking postgresql config and pg_wal_9918 filler '.repeat(120) },
      { seq: 3, role: 'assistant', text: 'Comparing postgresql checkpoints filler '.repeat(120) },
      { seq: 4, role: 'tool', text: 'archival queue ok '.repeat(120) },
      { seq: 5, role: 'tool', text: 'stalled worker heartbeat '.repeat(120) },
    ],
  }));
  assert.ok(await archive.writeSpan({
    sessionId: 'hop-s',
    compactionId: 'h1',
    entries: [
      { seq: 50, role: 'user', text: 'Mitigation for pg_wal_9918 requires flushing archival segment queue manually.' },
      { seq: 51, role: 'tool', text: 'Incident tag pg_wal_9918 closed without further notes.' },
      ...Array.from({ length: 10 }, (_, idx) => ({ seq: 60 + idx, role: 'assistant', text: `ordinary filler sentence number ${idx} ` + 'noise '.repeat(80) })),
    ],
  }));
  const hopRes = await archive.search('hop-s', 'postgresql archival stalled', { limit: 6 });
  assert.ok(hopRes.hits.some(hit => hit.seq === 50 && hit.secondHop === true), JSON.stringify(hopRes.hits));
  assert.equal(hopRes.hits.some(hit => hit.seq === 51), false);
});

await test('seal-P1-1-follow-session-model-preserves-explicit-maxTokens', async () => {
  const file = join(scratch(), 'summary-config.json');
  const saved = await handleSummaryConfigRpc({
    method: 'set',
    params: { provider: '', model: '', maxTokens: 16384 },
  }, file);
  assert.equal(saved.cleared, false);
  assert.equal(saved.config.provider, '');
  assert.equal(saved.config.model, '');
  assert.equal(saved.config.maxTokens, 16384);
  const onDisk = readSummaryConfig(file, { strict: true });
  assert.equal(onDisk?.maxTokens, 16384);
  const merged = mergeSummaryConfig({ summarizationProvider: 'host-p', summarizationModel: 'host-m', maxTokens: 4096 }, onDisk);
  assert.equal(merged.summarizationProvider, 'host-p');
  assert.equal(merged.summarizationModel, 'host-m');
  assert.equal(merged.maxTokens, 16384);

  // Explicit null maxTokens, clear:['maxTokens'], or model-only clear without maxTokens still clears
  const clearedByNull = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '', maxTokens: null } }, file);
  assert.equal(clearedByNull.cleared, true);
  assert.equal(clearedByNull.config, null);

  await handleSummaryConfigRpc({ method: 'set', params: { provider: 'p', model: 'm', maxTokens: 16384 } }, file);
  const clearedByEmptyPair = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '' } }, file);
  assert.equal(clearedByEmptyPair.cleared, true);
  assert.equal(clearedByEmptyPair.config, null);

  await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '', maxTokens: 16384 } }, file);
  const clearedByKeyList = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '', maxTokens: 16384, clear: ['maxTokens'] } }, file);
  assert.equal(clearedByKeyList.cleared, true);
  assert.equal(clearedByKeyList.config, null);
});

await test('seal-P1-2-resolveSpec-forwards-preferRequestHeader-and-drives-overflow-snip', async () => {
  const f = fixture({ auto: true, snipEnabled: true, minimumReductionRatio: 0.1 });
  f.ctx.llm.resolveModelInfo = async (provider, model) => {
    if (provider === 'small' && model === 'small-24k') return { contextWindow: 24000, maxTokens: 2048 };
    return { contextWindow: 200000, maxTokens: 4096 };
  };
  f.session.requestHeader = () => ({ config: { provider: 'small', model: 'small-24k' } });
  f.agent.model = { current: () => ({ provider: 'big', model: 'big-200k' }) };

  await f.engine._preStepCache.run({ measures: new Map(), specs: new Map() }, async () => {
    const defaultSpec = await f.engine._resolveSpec(f.agent, undefined, signal());
    assert.equal(defaultSpec.provider, 'big');
    assert.equal(defaultSpec.model, 'big-200k');
    assert.equal(defaultSpec.lockedWindow, 200000);

    // Must bypass preferRequestHeader:false pre-step cache entry and use requestHeader target
    const headerSpec = await f.engine._resolveSpec(f.agent, undefined, signal(), { preferRequestHeader: true });
    assert.equal(headerSpec.provider, 'small');
    assert.equal(headerSpec.model, 'small-24k');
    assert.equal(headerSpec.lockedWindow, 24000);

    const budgetHeaderSpec = await f.engine._resolveSpec(f.agent, undefined, signal(), { budgetOnly: true, preferRequestHeader: true });
    assert.ok(budgetHeaderSpec.messageBudgetTokens < 24000);
  });

  // Real agent/request-error overflow path with preferRequestHeader: true
  const hooks2 = new Map();
  const root2 = scratch();
  const events2 = [];
  const surface2 = { nodes: [], replaceGeneration: 0 };
  const session2 = {
    id: randomUUID(),
    surface: surface2,
    header: { cwd: root2 },
    get seq() { return events2.length; },
    eventAt: s => events2[s],
    snapshotEvents: () => [...events2],
    requestHeader: () => ({ config: { provider: 'small', model: 'small-24k' } }),
    toolHistory: () => [],
    deriveEventMessage: ev => ev?.type === 'user/message' ? ev.data : ev?.data?.message,
    append(type, data, options = {}) {
      const ev = { seq: events2.length, time: Date.now(), type, data, ...options };
      events2.push(ev);
      if (options.surfaceOp === 'append') surface2.nodes.push(ev.seq);
      else if (options.surfaceOp?.op === 'replace') {
        const a = surface2.nodes.indexOf(options.surfaceOp.startSeq), b = surface2.nodes.indexOf(options.surfaceOp.endSeq);
        surface2.nodes.splice(a, b - a + 1, ev.seq);
        surface2.replaceGeneration++;
      }
      return ev;
    },
  };
  const ctx2 = {
    on(name, cb) { hooks2.set(name, cb); return () => {}; },
    provide() {},
    logger: { info() {}, warn() {} },
    sessions: { get: id => id === session2.id ? session2 : null, async flush() { return true; } },
    tokenMeter: {
      measure() {
        const nodes = surface2.nodes.map(s => ({ seq: s, tokens: approxTokens(blocksToText(session2.deriveEventMessage(events2[s])?.content)) }));
        return { nodes, totalTokens: nodes.reduce((sum, n) => sum + n.tokens, 0) };
      },
    },
    llm: {
      async resolveModelInfo(p, m) {
        if (p === 'small' && m === 'small-24k') return { contextWindow: 24000, maxTokens: 2048 };
        return { contextWindow: 200000, maxTokens: 4096 };
      },
      async *stream() {
        yield { type: 'text-delta', text: summary() };
        yield { type: 'finish', kind: 'stop' };
      },
    },
  };
  const eng2 = new WeaveCompactionEngine(ctx2, resolveConfig({
    archiveDir: join(root2, 'archive'),
    language: 'en',
    summaryRetryCount: 0,
    summaryRetryDelayMs: 0,
    sessionMemoryEnabled: false,
    auto: true,
    snipEnabled: true,
    retainTokens: 512,
    keepRecent: 2,
    snipKeepRecentTokens: 512,
    snipKeepRecentTurns: 1,
    snipMinSavingsTokens: 1000,
  }).config);
  eng2.historyToolsAvailable = true;
  fixtures.push(eng2);
  const push2 = (role, text) => session2.append(`${role}/message`, role === 'user' ? { id: randomUUID(), role, content: [{ type: 'text', text }], source: { kind: 'user' } } : { message: { id: randomUUID(), role, content: [{ type: 'text', text }], source: role === 'system' ? { kind: 'system-prompt' } : { kind: 'model', provider: 'big', model: 'big-200k' } } }, { surfaceOp: 'append' });
  session2.append('turn/start', { turn: 1 });
  session2.append('step/start', { turn: 1, step: 1 });
  push2('system', 'Keep deployment gates.');
  for (let i = 1; i <= 5; i += 1) {
    if (i > 1) {
      session2.append('turn/start', { turn: i });
      session2.append('step/start', { turn: i, step: 1 });
    }
    push2('user', `Requirement batch ${i}: retain gate ${i}.`);
    push2('assistant', `Verbose build output segment ${i}. `.repeat(450));
    if (i < 5) {
      session2.append('step/end', { turn: i, step: 1 });
      session2.append('turn/end', { turn: i });
    }
  }
  const agent2 = { session: session2, options: { provider: 'big', model: 'big-200k' }, model: { current: () => ({ provider: 'big', model: 'big-200k' }) }, runMaintenance: fn => fn(signal()) };
  // Fail compaction summary so agent/request-error must resolve overflowSpec (24k, not 200k) and trigger emergency snip
  eng2.ctx.llm.stream = async function* () { throw Object.assign(new Error('overflow summary fail'), { code: 'CONTEXT_WINDOW_EXCEEDED' }); };
  const hook = hooks2.get('agent/request-error');
  assert.equal(typeof hook, 'function');
  const outcome = await hook({ agent: agent2, failure: Object.assign(new Error('maximum context length exceeded'), { status: 400 }), signal: signal() }, async () => ({ kind: 'abort' }));
  assert.deepEqual(outcome, { kind: 'retry' });
  assert.ok(events2.some(ev => ev.type === 'compaction/start' && String(ev.data?.compactionId ?? '').startsWith('weave-snip-')), 'smaller requestHeader window should drive emergency snip');
});

await test('seal-P1-3-sanitizeArchiveEntry-deep-redacts-object-arguments-and-content', async () => {
  const archive = new CompactionArchive({ root: join(scratch(), 'archive') });
  const skSecret = ['sk', 'testSecretValue1234567890abcd'].join('-');
  const ghpSecret = ['ghp', '1234567890abcdefghijklmnop'].join('_');
  const dsn = 'postgres://admin:TopSecretDbPass99@db.example.internal:5432/prod';
  const entry = {
    seq: 1,
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        callId: 'call-obj-1',
        name: 'deploy_service',
        arguments: {
          apiKey: skSecret,
          dbUrl: dsn,
          name: skSecret,
          headers: { Authorization: `Bearer ${skSecret}` },
          tokens: [ghpSecret],
        },
      },
      {
        type: 'tool-result',
        callId: 'call-obj-1',
        name: 'deploy_service',
        content: {
          status: 'ok',
          type: 'json',
          credential: skSecret,
          dbUrl: dsn,
        },
      },
    ],
  };

  await archive.writeSpan({ sessionId: 'p1-3', compactionId: 'c1', entries: [entry] });
  // Must NOT mutate original in-memory object
  assert.equal(entry.content[0].arguments.apiKey, skSecret);
  assert.equal(entry.content[0].arguments.headers.Authorization, `Bearer ${skSecret}`);

  const read = await archive.readSpan('p1-3', 'c1');
  assert.equal(read.ok, true);
  const storedCall = read.entries[0].content[0];
  assert.equal(storedCall.type, 'tool-call');
  assert.equal(storedCall.callId, 'call-obj-1');
  assert.equal(storedCall.name, 'deploy_service');
  assert.doesNotMatch(JSON.stringify(storedCall.arguments), new RegExp(skSecret));
  assert.doesNotMatch(JSON.stringify(storedCall.arguments), new RegExp(ghpSecret));
  assert.doesNotMatch(JSON.stringify(storedCall.arguments), /TopSecretDbPass99/);

  const storedResult = read.entries[0].content[1];
  assert.equal(storedResult.type, 'tool-result');
  assert.equal(storedResult.content.type, 'json');
  assert.doesNotMatch(JSON.stringify(storedResult.content), new RegExp(skSecret));
  assert.doesNotMatch(JSON.stringify(storedResult.content), /TopSecretDbPass99/);
});

await test('seal-P2-2-retryCompactionFor-holds-busy-across-recovery-and-asyncRollingWave', async () => {
  const f = fixture({ auto: false });
  history(f);

  // 1. Observe _busy held synchronously during recoverPending AND across asyncRollingWave until stream completes
  const origRecover = f.engine.recoverPending.bind(f.engine);
  let busyInsideRecover = false;
  f.engine.recoverPending = async (sess, ...rest) => {
    busyInsideRecover = f.engine._busy.has(sess);
    return origRecover(sess, ...rest);
  };
  const gate1 = deferred();
  f.ctx.llm.stream = async function* () {
    await gate1.promise;
    yield { type: 'text-delta', text: summary('Keep retry timeout <= 30 seconds.') };
    yield { type: 'finish', kind: 'stop' };
  };

  const accepted1 = await retryCompactionFor(f.engine, f.session, { agent: f.agent, asyncRollingWave: true });
  assert.equal(accepted1.accepted, true);
  assert.equal(accepted1.completed, false);
  assert.equal(busyInsideRecover, true);
  assert.equal(f.engine._busy.has(f.session), true);
  await assert.rejects(retryCompactionFor(f.engine, f.session, { agent: f.agent }), { code: 'busy' });

  gate1.resolve();
  for (let i = 0; i < 50 && f.engine._busy.has(f.session); i += 1) await delay(10);
  assert.equal(f.engine._busy.has(f.session), false);

  // 2. Resumable handoff path does not self-reject as busy and holds _busy until wave completes
  const f2 = fixture({ auto: false });
  const seqs2 = history(f2);
  const nowIso = new Date().toISOString();
  writeResumableCompaction(f2.engine.sessionState, f2.session.id, {
    version: 1,
    jobId: 'job-p2-2',
    trigger: 'manual',
    status: 'interrupted',
    interruptReason: 'crash',
    createdAt: nowIso,
    updatedAt: nowIso,
    remainingSeqs: seqs2,
    remainingSourceSha256: null,
    initialTotalNodes: seqs2.length,
    completedNodes: 0,
    completedChunks: 0,
    waveCount: 0,
    consecutiveFailures: 1,
    initialTotalTokens: 4000,
    completedTokens: 0,
    batchCheckpointSeqs: [],
    allowForeignFallback: false,
    checkpointMeta: null,
    originalBackupId: null,
  });
  const gate2 = deferred();
  f2.ctx.llm.stream = async function* () {
    await gate2.promise;
    yield { type: 'text-delta', text: summary('Keep retry timeout <= 30 seconds.') };
    yield { type: 'finish', kind: 'stop' };
  };
  const accepted2 = await retryCompactionFor(f2.engine, f2.session, { agent: f2.agent, asyncRollingWave: true });
  assert.equal(accepted2.accepted, true);
  assert.equal(accepted2.completed, false);
  assert.equal(f2.engine._busy.has(f2.session), true);
  gate2.resolve();
  for (let i = 0; i < 50 && f2.engine._busy.has(f2.session); i += 1) await delay(10);
  assert.equal(f2.engine._busy.has(f2.session), false);
});

await test('seal-P2-3-commitSnip-compaction-end-double-failure-recovers-without-deadlock', async () => {
  const f = fixture({ auto: false });
  f.session.append('turn/start', { turn: 1 });
  f.session.append('step/start', { turn: 1, step: 1 });
  f.add('system', 'System prefix.');
  f.add('user', 'Req A.');
  const a1 = f.add('assistant', 'Old output '.repeat(1200));
  const u2 = f.add('user', 'Latest question.');
  f.add('assistant', 'Recent reply.');
  assert.ok(u2.seq > a1.seq);

  const plan = {
    spans: [
      {
        compactionId: 'weave-snip-double-fail',
        startSeq: a1.seq,
        endSeq: a1.seq,
        seqs: [a1.seq],
        savedTokens: 1200,
        stubText: '[Snipped archive stub]',
      },
    ],
  };

  const origAppend = f.session.append.bind(f.session);
  f.session.append = (type, data, opts) => {
    if (type === 'compaction/end') throw new Error('simulated flush failure');
    return origAppend(type, data, opts);
  };
  await assert.rejects(
    commitSnip({ session: f.session, plan, archive: f.engine.archive, log() {} }),
    err => err?.code === 'commit' && err?.surfaceMutated === true,
  );
  f.session.append = origAppend;

  const beforeState = inspectCompactionEntryState(f.session);
  assert.notEqual(beforeState.unmatchedCompactionStart, null);

  // In-memory recovery closes weave-snip-* cleanly without RECOVERY_REQUIRED
  const rec = await f.engine.recoverPending(f.session);
  assert.ok(rec.recovered >= 1);
  assert.equal(inspectCompactionEntryState(f.session).unmatchedCompactionStart, null);
  assert.equal(f.engine._recoveryBlocked.has(f.engine._keyOf(f.session)), false);

  // Also test reopen path via StockTransactionAdapter.prototype.recoverBeforeOpen
  const snipEvents = f.events.filter(e => e.type !== 'compaction/end');
  const persistedClosers = [];
  const fakeAdapter = {
    roots: new Map(),
    backupStores: new Map(),
    blocked: new Set(['s-snip']),
    sessions: new Map(),
    logger: { warn() {} },
    backend: {
      tracker: {
        writers: new Map(),
        claimWrite() {},
        releaseClaim() {},
      },
      coldLogMemo: new Map(),
      async findLog() { return { currentPath: join(f.root, 'fake.v4.jsonl') }; },
      async acquireLease() { return { async release() {} }; },
      async readStoredLog() { return { meta: {}, events: snipEvents, inheritedEventCount: 0 }; },
      async persistBatch(_meta, batch) { persistedClosers.push(...batch); },
    },
  };
  await StockTransactionAdapter.prototype.recoverBeforeOpen.call(fakeAdapter, 's-snip', signal());
  assert.equal(persistedClosers.length, 1);
  assert.equal(persistedClosers[0].type, 'compaction/end');
  assert.equal(persistedClosers[0].data.compactionId, 'weave-snip-double-fail');
  assert.equal(persistedClosers[0].data.error, undefined);
  assert.equal(fakeAdapter.blocked.has('s-snip'), false);

  // Non-snip weave-* compaction with surface replacement MUST NOT be closed silently
  const nonSnipClosers = [];
  const nonSnipEvents = snipEvents.map(ev => {
    if (ev.data?.compactionId === 'weave-snip-double-fail') {
      return { ...ev, data: { ...ev.data, compactionId: 'weave-manual-danger' } };
    }
    if (ev.data?.source?.compactionId === 'weave-snip-double-fail') {
      return { ...ev, data: { ...ev.data, source: { ...ev.data.source, compactionId: 'weave-manual-danger' } } };
    }
    return ev;
  });
  fakeAdapter.backend.readStoredLog = async () => ({ meta: {}, events: nonSnipEvents, inheritedEventCount: 0 });
  fakeAdapter.backend.persistBatch = async (_meta, batch) => { nonSnipClosers.push(...batch); };
  await StockTransactionAdapter.prototype.recoverBeforeOpen.call(fakeAdapter, 's-nonsnip', signal());
  assert.equal(nonSnipClosers.length, 0);
});

await test('seal-P2-5-continuation-reports-reinject-telemetry', async () => {
  const f = fixture({
    auto: false,
    archiveDir: join(scratch(), 'archive'),
    postCompactReinjectEnabled: true,
    postCompactReinjectMaxBytes: 16384,
  });
  const activeFile = join(f.root, 'src-note.js');
  writeFileSync(activeFile, 'export const BUILD_FLAG = 42;\n', 'utf8');
  f.session.append('turn/start', { turn: 1 });
  f.session.append('step/start', { turn: 1, step: 1 });
  f.add('system', 'Stable system prompt.');
  f.add('user', 'Keep BUILD_FLAG = 42.');
  const callEvent = f.session.append('assistant/message', {
    message: {
      id: randomUUID(),
      role: 'assistant',
      content: [
        { type: 'tool-call', callId: 'read-1', name: 'read_file', arguments: { path: activeFile } },
      ],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
  }, { surfaceOp: 'append' });
  const resultEvent = f.session.append('tool/result', {
    callId: 'read-1',
    message: {
      id: randomUUID(),
      role: 'tool',
      toolCallId: 'read-1',
      content: [{ type: 'text', text: 'export const BUILD_FLAG = 42;\n' + 'context line '.repeat(400) }],
      source: { kind: 'tool', callId: 'read-1' },
    },
  }, { surfaceOp: 'append' });
  const padEvent = f.add('assistant', 'Detailed analysis filler. '.repeat(400));
  f.session.append('step/end', { turn: 1, step: 1 });
  f.session.append('turn/end', { turn: 1 });
  const seqs = [callEvent.seq, resultEvent.seq, padEvent.seq];
  f.ctx.llm.stream = async function* () {
    yield { type: 'text-delta', text: '## Goal\nKeep BUILD_FLAG = 42.\n\n## State\nInspected src-note.js.\n\n## Next\nContinue verification.\n\n## Uncertain\nNone.' };
    yield { type: 'finish', kind: 'stop', usage: { inputTokens: 120, outputTokens: 40 } };
  };
  await f.engine._trackRun(f.session, { trigger: 'manual' }, () =>
    f.engine._compactRegionCore(seqs[0], seqs.at(-1), f.agent, signal(), {
      manual: true,
      policy: f.engine.config,
      continuation: true,
    }),
  );
  const snap = f.engine.progressTracker.snapshot(f.session.id);
  assert.ok(snap);
  assert.ok(snap.reinjectFiles >= 1, JSON.stringify(snap));
  assert.ok(snap.reinjectBytes > 0, JSON.stringify(snap));
  assert.ok(snap.effectiveReinjectMaxBytes > 0, JSON.stringify(snap));
});

await test('seal-P2-6-projectSummaryMessage-strips-stale-aux-blocks-on-continuation', () => {
  const continuationSource = {
    kind: 'compact-checkpoint',
    compactionId: 'c-old',
    continuation: { version: 1, pages: [] },
    memorySources: [{ seq: 1 }],
    memoryRequirements: ['Keep WAL enabled'],
  };
  const event = {
    seq: 10,
    type: 'user/message',
    data: {
      id: 'm-10',
      role: 'user',
      source: continuationSource,
      content: [{
        type: 'text',
        text: [
          '## Goal\nKeep WAL enabled.',
          '<pinned-source-rules count="1">\n- old pinned rule\n</pinned-source-rules>',
          '<disk-state-check checked-at="2026-11-27T00:00:00Z" scope="local-workspace">\n- stale disk status\n</disk-state-check>',
          '<active-workspace-files count="1" total-bytes="32" scope="local-workspace">\n<file path="old.js" bytes="32" truncated="false">\nconst old = 1;\n</file>\n</active-workspace-files>',
        ].join('\n\n'),
      }],
    },
  };
  const fakeSession = {
    eventAt: s => (s === event.seq ? event : undefined),
    deriveEventMessage: ev => ev?.data,
  };
  const projected = projectSummaryMessage(fakeSession, event, event.data);
  const text = blocksToText(projected.content);
  assert.match(text, /Keep WAL enabled\./);
  assert.doesNotMatch(text, /<pinned-source-rules/);
  assert.doesNotMatch(text, /<disk-state-check/);
  assert.doesNotMatch(text, /<active-workspace-files/);
  assert.deepEqual(event.data.source.memorySources, [{ seq: 1 }]);
  assert.deepEqual(event.data.source.memoryRequirements, ['Keep WAL enabled']);
});

await test('codex-P1-P2-route-cache-budget-switch-keyaware-redact-stale-running-retry-and-reinject', async () => {
  // 1. Alternating full(false) -> budgetOnly(true) -> full(true) must NOT return stale 200k fullSpec
  const f1 = fixture({ auto: true });
  f1.ctx.llm.resolveModelInfo = async (provider, model) => {
    if (provider === 'small' && model === 'small-24k') return { contextWindow: 24000, maxTokens: 2048 };
    return { contextWindow: 200000, maxTokens: 4096 };
  };
  f1.session.requestHeader = () => ({ config: { provider: 'small', model: 'small-24k' } });
  f1.agent.model = { current: () => ({ provider: 'big', model: 'big-200k' }) };
  await f1.engine._preStepCache.run({ measures: new Map(), specs: new Map() }, async () => {
    const s1 = await f1.engine._resolveSpec(f1.agent, undefined, signal());
    assert.equal(s1.lockedWindow, 200000);
    const sBudget = await f1.engine._resolveSpec(f1.agent, undefined, signal(), { budgetOnly: true, preferRequestHeader: true });
    assert.ok(sBudget.messageBudgetTokens < 24000);
    const sFullTrue = await f1.engine._resolveSpec(f1.agent, undefined, signal(), { preferRequestHeader: true });
    assert.equal(sFullTrue.provider, 'small');
    assert.equal(sFullTrue.model, 'small-24k');
    assert.equal(sFullTrue.lockedWindow, 24000);
  });

  // 2. Object redaction: unprefixed password, hex apiKey, Authorization: Basic ..., and payload records[0].name
  const archive = new CompactionArchive({ root: join(scratch(), 'archive') });
  const hex40 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const basicVal = 'Basic dXNlcjpzZWNyZXRwYXNz';
  const ghpSecret = ['ghp', 'payloadSecretName12345678'].join('_');
  const plainPass = 'myUnprefixedDbSecret99';
  const envelopeCallId = ['sk', 'envelopeCallId1234567890'].join('-');
  const objEntry = {
    seq: 2,
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        callId: envelopeCallId,
        name: 'http_call',
        arguments: {
          password: plainPass,
          apiKey: hex40,
          headers: { Authorization: basicVal },
        },
      },
      {
        type: 'tool-result',
        callId: envelopeCallId,
        name: 'http_call',
        content: {
          records: [{ name: ghpSecret }],
        },
      },
    ],
  };
  await archive.writeSpan({ sessionId: 'codex-obj', compactionId: 'c1', entries: [objEntry] });
  assert.equal(objEntry.content[0].arguments.password, plainPass);
  const loaded = await archive.readSpan('codex-obj', 'c1');
  assert.equal(loaded.ok, true);
  assert.equal(loaded.entries[0].content[0].callId, envelopeCallId);
  assert.equal(loaded.entries[0].content[0].name, 'http_call');
  assert.doesNotMatch(JSON.stringify(loaded.entries[0].content[0].arguments), /myUnprefixedDbSecret99/);
  assert.doesNotMatch(JSON.stringify(loaded.entries[0].content[0].arguments), new RegExp(hex40));
  assert.doesNotMatch(JSON.stringify(loaded.entries[0].content[0].arguments), /dXNlcjpzZWNyZXRwYXNz/);
  assert.doesNotMatch(JSON.stringify(loaded.entries[0].content[1].content), new RegExp(ghpSecret));

  // 3a. retryCompactionFor reconciles stale 'running' resumable checkpoint while holding _busy and resumes it
  const f3 = fixture({ auto: false, failureThreshold: 3 });
  const seqs3 = history(f3);
  const nowIso = new Date().toISOString();
  writeResumableCompaction(f3.engine.sessionState, f3.session.id, {
    version: 1,
    jobId: 'job-stale-run',
    trigger: 'manual',
    status: 'running',
    interruptReason: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    remainingSeqs: seqs3,
    remainingSourceSha256: null,
    initialTotalNodes: seqs3.length,
    completedNodes: 0,
    completedChunks: 0,
    waveCount: 0,
    consecutiveFailures: 0,
    initialTotalTokens: 4000,
    completedTokens: 0,
    batchCheckpointSeqs: [],
    allowForeignFallback: false,
    checkpointMeta: null,
    originalBackupId: null,
  });
  let compactCalls3 = 0;
  f3.ctx.llm.stream = async function* () {
    compactCalls3 += 1;
    yield { type: 'text-delta', text: summary('Keep retry timeout <= 30 seconds.') };
    yield { type: 'finish', kind: 'stop' };
  };
  const ret3 = await retryCompactionFor(f3.engine, f3.session, { agent: f3.agent });
  assert.equal(compactCalls3, 1);
  assert.equal(f3.engine._busy.has(f3.session), false);
  assert.ok(ret3?.compactionId);

  // 3b. When resumeCompactionFor transfers lock and returns null, retryCompactionFor must NOT fall through to a duplicate run
  const f4 = fixture({ auto: false });
  history(f4);
  const origResume = f4.engine.resumeCompactionFor.bind(f4.engine);
  let fallbackCalls = 0;
  f4.engine._compactManual = async () => { fallbackCalls += 1; return { status: 'unexpected' }; };
  f4.engine.resumeCompactionFor = async (sess, opts) => {
    const p = Promise.resolve(null);
    opts._onLockTransferred?.(p);
    f4.engine._busy.delete(sess);
    return null;
  };
  writeResumableCompaction(f4.engine.sessionState, f4.session.id, {
    version: 1,
    jobId: 'job-null-handoff',
    trigger: 'manual',
    status: 'interrupted',
    interruptReason: 'crash',
    createdAt: nowIso,
    updatedAt: nowIso,
    remainingSeqs: f4.session.surface.nodes.slice(1),
    remainingSourceSha256: null,
    initialTotalNodes: f4.session.surface.nodes.length,
    completedNodes: 0,
    completedChunks: 0,
    waveCount: 0,
    consecutiveFailures: 1,
    initialTotalTokens: 4000,
    completedTokens: 0,
    batchCheckpointSeqs: [],
    allowForeignFallback: false,
    checkpointMeta: null,
    originalBackupId: null,
  });
  const nullHandoff = await retryCompactionFor(f4.engine, f4.session, { agent: f4.agent });
  assert.equal(nullHandoff, null);
  assert.equal(fallbackCalls, 0);
  f4.engine.resumeCompactionFor = origResume;

  // 4. prepareContinuationForSpan reports reduced / omitted / disabled reinjection telemetry
  for (const enabled of [true, false]) {
    const f5 = fixture({
      auto: false,
      archiveDir: join(scratch(), 'archive'),
      postCompactReinjectEnabled: enabled,
      postCompactReinjectMaxBytes: 4096,
    });
    const bigFile = join(f5.root, 'large-note.js');
    writeFileSync(bigFile, '// line\n'.repeat(300), 'utf8'); // ~2400B -> fits under 4096 or disabled = 0
    f5.session.append('turn/start', { turn: 1 });
    f5.session.append('step/start', { turn: 1, step: 1 });
    f5.add('system', 'Stable system prompt.');
    f5.add('user', 'Keep large-note guardrails.');
    const cEv = f5.session.append('assistant/message', {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: [{ type: 'tool-call', callId: 'r-1', name: 'read_file', arguments: { path: bigFile } }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, { surfaceOp: 'append' });
    const rEv = f5.session.append('tool/result', {
      callId: 'r-1',
      message: {
        id: randomUUID(),
        role: 'tool',
        toolCallId: 'r-1',
        content: [{ type: 'text', text: '// filler '.repeat(600) }],
        source: { kind: 'tool', callId: 'r-1' },
      },
    }, { surfaceOp: 'append' });
    f5.session.append('step/end', { turn: 1, step: 1 });
    f5.session.append('turn/end', { turn: 1 });
    f5.ctx.llm.stream = async function* () {
      yield { type: 'text-delta', text: '## Goal\nKeep large-note guardrails.\n\n## State\nRead file.\n\n## Next\nDone.\n\n## Uncertain\nNone.' };
      yield { type: 'finish', kind: 'stop', usage: { inputTokens: 80, outputTokens: 20 } };
    };
    await f5.engine._trackRun(f5.session, { trigger: 'manual' }, () =>
      f5.engine._compactRegionCore(cEv.seq, rEv.seq, f5.agent, signal(), {
        manual: true,
        policy: f5.engine.config,
        continuation: true,
      }),
    );
    const snap5 = f5.engine.progressTracker.snapshot(f5.session.id);
    assert.equal(snap5.reinjectFiles, enabled ? 1 : 0);
    if (enabled) assert.ok(snap5.reinjectBytes > 0 && snap5.effectiveReinjectMaxBytes === 4096);
    else assert.equal(snap5.reinjectBytes, 0);
  }
});

await test('codex-round2-redact-suffix-array-blocks-cache-identity-abort-flush-and-shrunk-reinject', async () => {
  // 1. Space/comma/newline/quote credentials, array-valued credentials, and real spanEntries blocks copy
  const archive = new CompactionArchive({ root: join(scratch(), 'archive-r2') });
  const ghpSecret = ['ghp', 'blocksPayloadSecret123456'].join('_');
  const envelopeCallId = ['sk', 'envelopeCallIdRoundTwo12'].join('-');
  const eventsR = [
    {
      seq: 0,
      type: 'assistant/message',
      data: {
        message: {
          id: 'm-call',
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              callId: envelopeCallId,
              name: 'fetch_records',
              arguments: {
                password: 'correct horse battery staple',
                apiKey: 'key,with,commas',
                api_key: 'line1\nline2"quote',
                nested: { password: ['plainSecretOne', 'plainSecretTwo'] },
                headers: { Authorization: ['Basic dXNlcjpwYXNz'] },
              },
            },
          ],
        },
      },
    },
    {
      seq: 1,
      type: 'tool/result',
      data: {
        callId: envelopeCallId,
        name: 'fetch_records',
        message: {
          id: 'm-res',
          role: 'tool',
          toolCallId: envelopeCallId,
          content: [{ type: 'record', name: ghpSecret }],
        },
      },
    },
  ];
  const sessR = {
    seq: eventsR.length,
    eventAt: s => eventsR[s],
    deriveEventMessage: ev => ev?.data?.message ?? ev?.data,
  };
  const builtEntries = spanEntries(sessR, [0, 1]);
  await archive.writeSpan({ sessionId: 'r2-span', compactionId: 'c1', entries: builtEntries });
  const loadedR = await archive.readSpan('r2-span', 'c1');
  assert.equal(loadedR.ok, true);
  const serializedAll = JSON.stringify(loadedR.entries);
  for (const leaked of ['correct', 'horse', 'battery', 'staple', 'with,commas', 'line1', 'line2', 'plainSecretOne', 'dXNlcjpwYXNz', ghpSecret]) {
    assert.equal(serializedAll.includes(leaked), false, `Must not leak ${leaked}`);
  }
  assert.equal(loadedR.entries[0].blocks[0].callId, envelopeCallId);
  assert.equal(loadedR.entries[0].blocks[0].name, 'fetch_records');

  // 2. Cache identity separation for budgetOnly(true) -> full(true) across header/config/resolver changes
  const fCache = fixture({ auto: true });
  fCache.ctx.llm.resolveModelInfo = async (_p, m) =>
    m === 'hdr-30k' ? { contextWindow: 30000, maxTokens: 2048 } : { contextWindow: 200000, maxTokens: 4096 };
  let headerModel = 'hdr-200k';
  fCache.session.requestHeader = () => ({ config: { provider: 'p', model: headerModel } });
  await fCache.engine._preStepCache.run({ measures: new Map(), specs: new Map() }, async () => {
    const full1 = await fCache.engine._resolveSpec(fCache.agent, undefined, signal());
    assert.equal(full1.lockedWindow, 200000);
    // Header change before budgetOnly + full must invalidate prev.fullSpec
    headerModel = 'hdr-30k';
    const b1 = await fCache.engine._resolveSpec(fCache.agent, undefined, signal(), { budgetOnly: true, preferRequestHeader: true });
    assert.ok(b1.messageBudgetTokens < 30000);
    const full2 = await fCache.engine._resolveSpec(fCache.agent, undefined, signal(), { preferRequestHeader: true });
    assert.equal(full2.lockedWindow, 30000);
    // Resolver identity change must invalidate _preStepCache entry even at same route/headers
    let infoCalls = 0;
    fCache.ctx.llm.resolveModelInfo = async () => { infoCalls += 1; return { contextWindow: 30000, maxTokens: 4096 }; };
    await fCache.engine._resolveSpec(fCache.agent, undefined, signal(), { budgetOnly: true, preferRequestHeader: true });
    assert.equal(infoCalls, 1);
    const full3 = await fCache.engine._resolveSpec(fCache.agent, undefined, signal(), { preferRequestHeader: true });
    assert.equal(full3.lockedWindow, 30000);
    assert.equal(infoCalls, 2);
    // Config object replacement must invalidate _preStepCache entry even at same route/headers/resolver
    fCache.engine.config = resolveConfig({ ...fCache.engine.config, windowFallback: 64000, maxTokens: 8192 }).config;
    await fCache.engine._resolveSpec(fCache.agent, undefined, signal(), { preferRequestHeader: true });
    assert.equal(infoCalls, 3);
  });

  // 3. Real async retryCompactionFor handoff retains caller abort signal until resumed wave stops
  const fAbort = fixture({ auto: false });
  const seqsA = history(fAbort);
  const nowIso = new Date().toISOString();
  writeResumableCompaction(fAbort.engine.sessionState, fAbort.session.id, {
    version: 1,
    jobId: 'job-r2-abort',
    trigger: 'manual',
    status: 'interrupted',
    interruptReason: 'crash',
    createdAt: nowIso,
    updatedAt: nowIso,
    remainingSeqs: seqsA,
    remainingSourceSha256: null,
    initialTotalNodes: seqsA.length,
    completedNodes: 0,
    completedChunks: 0,
    waveCount: 0,
    consecutiveFailures: 1,
    initialTotalTokens: 4000,
    completedTokens: 0,
    batchCheckpointSeqs: [],
    allowForeignFallback: false,
    checkpointMeta: null,
    originalBackupId: null,
  });
  const enteredAbort = deferred();
  const stoppedAbort = deferred();
  fAbort.engine._compactManual = async (_ag, activeSignal) => {
    enteredAbort.resolve(activeSignal);
    await new Promise((_res, rej) =>
      activeSignal.addEventListener('abort', () => { stoppedAbort.resolve(); rej(activeSignal.reason); }, { once: true }),
    );
  };
  const callerCtrl = new AbortController();
  const retAbort = await retryCompactionFor(fAbort.engine, fAbort.session, {
    agent: fAbort.agent,
    signal: callerCtrl.signal,
    asyncRollingWave: true,
  });
  assert.equal(retAbort.accepted, true);
  assert.equal(fAbort.engine._busy.has(fAbort.session), true);
  const innerSig = await enteredAbort.promise;
  callerCtrl.abort(Object.assign(new Error('abort retry'), { name: 'AbortError' }));
  await stoppedAbort.promise;
  assert.equal(innerSig.aborted, true);
  for (let i = 0; i < 40 && fAbort.engine._busy.has(fAbort.session); i += 1) await delay(10);
  assert.equal(fAbort.engine._busy.has(fAbort.session), false);

  // 4. Failing flush on weave-snip-* recovery retains pending durability marker and retries flush
  const fFlush = fixture({ auto: false });
  fFlush.session.append('turn/start', { turn: 1 });
  fFlush.session.append('step/start', { turn: 1, step: 1 });
  fFlush.add('system', 'System.');
  fFlush.add('user', 'Req.');
  const oldMsg = fFlush.add('assistant', 'Verbose output '.repeat(1200));
  fFlush.add('user', 'Latest.');
  fFlush.add('assistant', 'Reply.');
  const origApp = fFlush.session.append.bind(fFlush.session);
  fFlush.session.append = (type, data, opts) => {
    if (type === 'compaction/end') throw new Error('double end fail');
    return origApp(type, data, opts);
  };
  await assert.rejects(
    commitSnip({
      session: fFlush.session,
      plan: { spans: [{ compactionId: 'weave-snip-flush-retry', startSeq: oldMsg.seq, endSeq: oldMsg.seq, seqs: [oldMsg.seq], savedTokens: 1200, stubText: '[Snipped]' }] },
      archive: fFlush.engine.archive,
      log() {},
    }),
  );
  fFlush.session.append = origApp;
  let flushAttempts = 0;
  fFlush.ctx.sessions.flush = async () => {
    flushAttempts += 1;
    if (flushAttempts === 1) throw new Error('transient flush error');
    return true;
  };
  await assert.rejects(fFlush.engine.recoverPending(fFlush.session), /transient flush error/);
  assert.equal(flushAttempts, 1);
  const rec2 = await fFlush.engine.recoverPending(fFlush.session);
  assert.equal(flushAttempts, 2);
  assert.ok(rec2.recovered >= 1);

  // 5. Continuation reinjection reports reduced shrunk count (< 3 files) when full 3 files exceed tight continuation budget
  const fShrunk = fixture({
    auto: false,
    archiveDir: join(scratch(), 'archive'),
    postCompactReinjectEnabled: true,
    postCompactReinjectMaxBytes: 15000,
    maxSummaryChars: 6500,
  });
  fShrunk.ctx.llm.resolveModelInfo = async () => ({ contextWindow: 64000, maxTokens: 2048 });
  fShrunk.session.append('turn/start', { turn: 1 });
  fShrunk.session.append('step/start', { turn: 1, step: 1 });
  fShrunk.add('system', 'Sys.');
  fShrunk.add('user', 'Keep shrunken files check.');
  const toolCalls = [];
  for (let i = 0; i < 3; i += 1) {
    const fileP = join(fShrunk.root, `shrunk-${i}.js`);
    writeFileSync(fileP, `// file ${i}\n`.repeat(300), 'utf8'); // ~3000B each => 3 files = ~9000B (>6500 maxSummaryChars), shrunk = ~1-2 files (<5000B)
    const ce = fShrunk.session.append('assistant/message', {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: [{ type: 'tool-call', callId: `c-${i}`, name: 'read_file', arguments: { path: fileP } }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, { surfaceOp: 'append' });
    const re = fShrunk.session.append('tool/result', {
      callId: `c-${i}`,
      message: { id: randomUUID(), role: 'tool', toolCallId: `c-${i}`, content: [{ type: 'text', text: '// out '.repeat(500) }], source: { kind: 'tool', callId: `c-${i}` } },
    }, { surfaceOp: 'append' });
    toolCalls.push(ce.seq, re.seq);
  }
  fShrunk.session.append('step/end', { turn: 1, step: 1 });
  fShrunk.session.append('turn/end', { turn: 1 });
  fShrunk.ctx.llm.stream = async function* () {
    yield { type: 'text-delta', text: '## Goal\nKeep shrunken files check.\n\n## State\nInspected files.\n\n## Next\nDone.\n\n## Uncertain\nNone.' };
    yield { type: 'finish', kind: 'stop', usage: { inputTokens: 80, outputTokens: 20 } };
  };
  await fShrunk.engine._trackRun(fShrunk.session, { trigger: 'manual' }, () =>
    fShrunk.engine._compactRegionCore(toolCalls[0], toolCalls.at(-1), fShrunk.agent, signal(), {
      manual: true,
      policy: fShrunk.engine.config,
      continuation: true,
    }),
  );
  const snapS = fShrunk.engine.progressTracker.snapshot(fShrunk.session.id);
  assert.ok(snapS.reinjectFiles >= 1 && snapS.reinjectFiles < 3, JSON.stringify(snapS));
  assert.ok(snapS.reinjectBytes > 0 && snapS.reinjectBytes <= snapS.effectiveReinjectMaxBytes, JSON.stringify(snapS));
});

await test('codex-round3-redact-braces-auth-separators-and-snip-flush-blocker-retention', async () => {
  // 1. Leading/embedded braces on scalar assignments redact completely while JSON array brackets are preserved
  assert.equal(redactCredentials('password=alpha{tailSecret99}'), 'password=[redacted]}');
  assert.equal(redactCredentials('password={tailSecret99}'), 'password=[redacted]}');
  assert.doesNotMatch(redactCredentials('password=alpha{tailSecret99}'), /tailSecret99/);
  assert.doesNotMatch(redactCredentials('password={tailSecret99}'), /tailSecret99/);

  // 2. Archive leaf Authorization values (scalar & array) with commas/spaces/newlines/quotes leave zero suffix
  const archive = new CompactionArchive({ root: join(scratch(), 'archive-r3') });
  const authCases = [
    { Authorization: 'Token prefixValue,suffixSecret99' },
    { Authorization: ['Token prefixValue,suffixSecret99', 'Bearer tok alpha\nsuffixTwo"end'] },
    { headers: { Authorization: 'Basic dXNlcjpwYXNz,extraTail' } },
  ];
  await archive.writeSpan({
    sessionId: 'r3-auth',
    compactionId: 'c1',
    entries: [{
      seq: 0,
      role: 'assistant',
      content: authCases.map((args, idx) => ({
        type: 'tool-call',
        callId: `c-${idx}`,
        name: 'req',
        arguments: args,
      })),
    }],
  });
  const readAuth = await archive.readSpan('r3-auth', 'c1');
  const dumpedAuth = JSON.stringify(readAuth.entries);
  for (const leaked of ['prefixValue', 'suffixSecret99', 'suffixTwo', 'dXNlcjpwYXNz', 'extraTail']) {
    assert.equal(dumpedAuth.includes(leaked), false, `Authorization leak: ${leaked}`);
  }

  // 3. Failed snip flush retains _pendingSnipFlushSessions & _recoveryBlocked across flush(false), missing flush, and consecutive failures
  const f = fixture({ auto: false });
  f.session.append('turn/start', { turn: 1 });
  f.session.append('step/start', { turn: 1, step: 1 });
  f.add('system', 'Sys.');
  f.add('user', 'Req.');
  const old = f.add('assistant', 'Old output '.repeat(1200));
  f.add('user', 'Next.');
  f.add('assistant', 'Ans.');
  const origApp = f.session.append.bind(f.session);
  f.session.append = (type, data, opts) => {
    if (type === 'compaction/end') throw new Error('end fail');
    return origApp(type, data, opts);
  };
  await assert.rejects(
    commitSnip({
      session: f.session,
      plan: { spans: [{ compactionId: 'weave-snip-r3-flush', startSeq: old.seq, endSeq: old.seq, seqs: [old.seq], savedTokens: 1200, stubText: '[Snipped]' }] },
      archive: f.engine.archive,
      log() {},
    }),
  );
  f.session.append = origApp;

  const key = f.engine._keyOf(f.session);
  // Attempt 1: flush rejects
  f.ctx.sessions.flush = async () => { throw new Error('disk offline'); };
  await assert.rejects(f.engine.recoverPending(f.session), /disk offline/);
  assert.equal(f.engine._pendingSnipFlushSessions.has(f.session), true);
  assert.equal(f.engine._recoveryBlocked.has(key), true);

  // Attempt 2: flush returns false -> persistence failure, blocker & marker retained
  f.ctx.sessions.flush = async () => false;
  await assert.rejects(f.engine.recoverPending(f.session), { code: 'persistence' });
  assert.equal(f.engine._pendingSnipFlushSessions.has(f.session), true);
  assert.equal(f.engine._recoveryBlocked.has(key), true);

  // Attempt 3: flush becomes unavailable -> RECOVERY_REQUIRED, blocker & marker retained
  f.ctx.sessions.flush = undefined;
  await assert.rejects(f.engine.recoverPending(f.session), { code: 'RECOVERY_REQUIRED' });
  assert.equal(f.engine._pendingSnipFlushSessions.has(f.session), true);
  assert.equal(f.engine._recoveryBlocked.has(key), true);

  // Attempt 4: flush recovers -> succeeds and clears both marker & blocker
  f.ctx.sessions.flush = async () => true;
  const ok = await f.engine.recoverPending(f.session);
  assert.ok(ok.recovered >= 1);
  assert.equal(f.engine._pendingSnipFlushSessions.has(f.session), false);
  assert.equal(f.engine._recoveryBlocked.has(key), false);
});

await test('redline-seal-P1-1-async-busy-toctou-and-progress-tracker', async () => {
  // 1a. prepareAutoCompaction paused at resolveModelInfo does not steal _busy / progressTracker from active compactRegion
  const resolveGate = deferred();
  const streamStarted = deferred();
  const streamGate = deferred();
  let resolveCount = 0;
  const fAuto = fixture({ thresholdRatio: 0.4, manualOnly: false, auto: true, continuationEnabled: false });
  fAuto.session.append('turn/start', { turn: 1 });
  fAuto.session.append('step/start', { turn: 1, step: 1 });
  fAuto.add('system', 'Sys.');
  const u1 = fAuto.add('user', 'Keep timeout fixed at 30s.');
  const a1 = fAuto.add('assistant', 'Detailed analysis. '.repeat(200));
  for (let i = 0; i < 4; i += 1) {
    fAuto.add('user', `Follow-up turn ${i + 1}.`);
    fAuto.add('assistant', 'More trace data. '.repeat(900));
  }
  fAuto.add('user', 'Latest question.');
  fAuto.session.append('turn/end', { turn: 1 });
  fAuto.ctx.llm.resolveModelInfo = async () => {
    resolveCount += 1;
    if (resolveCount === 1) await resolveGate.promise;
    return { contextWindow: 32000, maxTokens: 2048 };
  };
  fAuto.ctx.llm.stream = async function* (req) {
    fAuto.calls.push(req);
    streamStarted.resolve();
    await streamGate.promise;
    yield { type: 'text-delta', text: summary('Keep timeout fixed at 30s.') };
    yield { type: 'finish', kind: 'stop' };
  };

  const autoPromise = fAuto.engine.compactIfNeeded(fAuto.agent, 'pressure', signal());
  await delay(10);
  const regionPromise = fAuto.engine.compactNow(fAuto.agent, signal());
  await streamStarted.promise;
  assert.equal(fAuto.engine._busy.has(fAuto.session), true);
  const regionRunId = fAuto.engine.progressTracker.snapshot(fAuto.session.id).runId;
  assert.ok(regionRunId);

  resolveGate.resolve();
  const autoResult = await autoPromise;
  assert.equal(autoResult, null);
  assert.equal(fAuto.engine._busy.has(fAuto.session), true, 'compactNow still holds _busy');
  assert.equal(fAuto.engine.progressTracker.snapshot(fAuto.session.id).runId, regionRunId);

  streamGate.resolve();
  const regionResult = await regionPromise;
  assert.ok(regionResult);
  assert.equal(fAuto.engine._busy.has(fAuto.session), false);

  // 1b. runContextCollapse paused at weave/pre-compact does not clobber concurrent compactNow
  const preHookGate = deferred();
  const colStreamStarted = deferred();
  const colStreamGate = deferred();
  let preHookCb = null;
  const fCol = fixture({ auto: false, retainTokens: 0 });
  fCol.ctx.on = (ev, fn) => {
    if (ev === 'weave/pre-compact') preHookCb = fn;
  };
  fCol.ctx.emit = async (ev, payload) => (ev === 'weave/pre-compact' && preHookCb ? preHookCb(payload) : undefined);
  let preHookCount = 0;
  fCol.engine._runPreCompactHook = async () => {
    preHookCount += 1;
    if (preHookCount === 1) await preHookGate.promise;
    return { cancelled: false, effectiveFocus: '', additionalContext: '' };
  };
  fCol.session.append('turn/start', { turn: 1 });
  fCol.session.append('step/start', { turn: 1, step: 1 });
  fCol.add('system', 'Sys.');
  const cu1 = fCol.add('user', 'Task A.');
  const ca1 = fCol.add('assistant', 'Details '.repeat(1200));
  fCol.add('user', 'Task B.');
  fCol.add('assistant', 'More details '.repeat(1200));
  fCol.add('user', 'Follow up.');
  fCol.session.append('turn/end', { turn: 1 });
  fCol.ctx.llm.stream = async function* (req) {
    fCol.calls.push(req);
    colStreamStarted.resolve();
    await colStreamGate.promise;
    yield { type: 'text-delta', text: summary('Task A.') };
    yield { type: 'finish', kind: 'stop' };
  };
  const colPromise = fCol.engine._runContextCollapse(
    fCol.agent,
    { seqs: [cu1.seq, ca1.seq], startSeq: cu1.seq, endSeq: ca1.seq, totalTokens: 2500 },
    fCol.engine.config,
    signal(),
    2500,
  );
  await delay(10);
  const colRegionPromise = fCol.engine.compactNow(fCol.agent, signal());
  await colStreamStarted.promise;
  const colRegRunId = fCol.engine.progressTracker.snapshot(fCol.session.id).runId;
  preHookGate.resolve();
  assert.equal(await colPromise, null);
  assert.equal(fCol.engine._busy.has(fCol.session), true);
  assert.equal(fCol.engine.progressTracker.snapshot(fCol.session.id).runId, colRegRunId);
  colStreamGate.resolve();
  await colRegionPromise;
  assert.equal(fCol.engine._busy.has(fCol.session), false);

  // 1c. emergencySnip paused at _measure bails cleanly without deleting _busy or leaving stale _snipAttemptedAt
  const measureGate = deferred();
  const snipStreamStarted = deferred();
  const snipStreamGate = deferred();
  const fSnip = fixture({ auto: false, snipEnabled: true });
  fSnip.session.append('turn/start', { turn: 1 });
  fSnip.session.append('step/start', { turn: 1, step: 1 });
  fSnip.add('system', 'Sys.');
  const su1 = fSnip.add('user', 'Analyze logs.');
  const sa1 = fSnip.add('assistant', 'Huge log '.repeat(1800));
  fSnip.add('user', 'Latest turn.');
  const origMeasure = fSnip.engine._measure.bind(fSnip.engine);
  let waitFirstMeasure = true;
  fSnip.engine._measure = async (s) => {
    if (waitFirstMeasure) {
      waitFirstMeasure = false;
      await measureGate.promise;
    }
    return origMeasure(s);
  };
  fSnip.ctx.llm.stream = async function* (req) {
    fSnip.calls.push(req);
    snipStreamStarted.resolve();
    await snipStreamGate.promise;
    yield { type: 'text-delta', text: summary('Analyze logs.') };
    yield { type: 'finish', kind: 'stop' };
  };
  const snipPromise = fSnip.engine._emergencySnip(
    fSnip.agent,
    { policy: fSnip.engine.config, messageBudgetTokens: 1000, thresholdTokens: 800 },
    signal(),
    'budget-wall',
  );
  await delay(10);
  const snipRegionPromise = fSnip.engine.compactRegion(su1.seq, sa1.seq, fSnip.agent, signal());
  await snipStreamStarted.promise;
  assert.equal(fSnip.engine._busy.has(fSnip.session), true);
  measureGate.resolve();
  assert.equal(await snipPromise, null);
  assert.equal(fSnip.engine._busy.has(fSnip.session), true);
  assert.equal(fSnip.engine._snipAttemptedAt.has(fSnip.session), false);
  snipStreamGate.resolve();
  await snipRegionPromise;
  assert.equal(fSnip.engine._busy.has(fSnip.session), false);

  // 1d. CompactionProgressTracker.withRun isolates concurrent non-nested calls on active sessionId
  const tracker = new CompactionProgressTracker();
  const outerGate = deferred();
  let capturedOuterId = null;
  let concurrentId = 'unset';
  let cancelAborted = false;
  const pOuter = tracker.withRun('sess-pt-lock', { trigger: 'manual', phase: 'summarizing' }, async (runId) => {
    capturedOuterId = runId;
    assert.equal(tracker.registerCancel('sess-pt-lock', runId, { signal: { aborted: false }, abort() { cancelAborted = true; } }), true);
    await outerGate.promise;
    return 'outer';
  });
  await delay(10);
  const pConcurrent = await tracker.withRun('sess-pt-lock', { trigger: 'idle', phase: 'masking' }, async (runId) => {
    concurrentId = runId;
    assert.equal(tracker.update('sess-pt-lock', { phase: 'masking', maskedCount: 77 }), false);
    assert.equal(tracker.update('sess-pt-lock', { phase: 'masking', maskedCount: 88 }, { runId: capturedOuterId }), false);
    assert.equal(tracker.updateStream('sess-pt-lock', { idleMs: 999 }, { runId: capturedOuterId }), false);
    assert.equal(tracker.registerCancel('sess-pt-lock', capturedOuterId, { signal: { aborted: false }, abort() {} }), false);
    assert.equal(tracker.finish('sess-pt-lock', {}, { runId: capturedOuterId }), false);
    assert.equal(tracker.fail('sess-pt-lock', new Error('hijack'), { runId: capturedOuterId }), false);
    tracker.clear('sess-pt-lock');
    await delay(5);
    let nestedId = 'unset';
    await tracker.withRun('sess-pt-lock', { phase: 'masking' }, async (innerId) => {
      nestedId = innerId;
      assert.equal(tracker.update('sess-pt-lock', { phase: 'planning' }, { runId: capturedOuterId }), false);
    });
    assert.equal(nestedId, null);
    return 'concurrent';
  });
  assert.equal(pConcurrent, 'concurrent');
  assert.equal(concurrentId, null);
  assert.equal(tracker.snapshot('sess-pt-lock').runId, capturedOuterId);
  assert.equal(tracker.snapshot('sess-pt-lock').phase, 'summarizing');
  assert.equal(tracker.snapshot('sess-pt-lock').active, true);
  assert.equal(tracker.isCancellable('sess-pt-lock'), true);
  assert.equal(tracker.cancelRun('sess-pt-lock', 'test').cancelled, true);
  assert.equal(cancelAborted, true);
  outerGate.resolve();
  assert.equal(await pOuter, 'outer');
  assert.equal(tracker.snapshot('sess-pt-lock').active, false);
});

await test('redline-seal-P1-2-resumable-unshrinkable-tail-clears-checkpoint', async () => {
  const registeredHooks = new Map();
  const root = scratch();
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  const session = {
    id: randomUUID(),
    surface,
    header: { cwd: root },
    get seq() { return events.length; },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => [...events],
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    toolHistory: () => [],
    deriveEventMessage: (event) => (event?.type === 'user/message' ? event.data : event?.data?.message),
    append(type, data, options = {}) {
      const event = { seq: events.length, time: Date.now(), type, data, ...options };
      events.push(event);
      if (options.surfaceOp === 'append') surface.nodes.push(event.seq);
      else if (options.surfaceOp?.op === 'replace') {
        const a = surface.nodes.indexOf(options.surfaceOp.startSeq);
        const b = surface.nodes.indexOf(options.surfaceOp.endSeq);
        assert.ok(a >= 0 && b >= a);
        surface.nodes.splice(a, b - a + 1, event.seq);
        surface.replaceGeneration += 1;
      }
      return event;
    },
  };
  const addMsg = (role, text) => {
    const message = {
      id: randomUUID(),
      role,
      content: [{ type: 'text', text }],
      source: role === 'assistant' ? { kind: 'model', provider: 'p', model: 'm' } : { kind: role },
    };
    return session.append(`${role}/message`, role === 'user' ? message : { message }, { surfaceOp: 'append' });
  };
  let llmCalls = 0;
  const ctx = {
    on(event, fn) { registeredHooks.set(event, fn); },
    provide() {},
    logger: { info() {}, warn() {} },
    sessions: { get: (id) => (id === session.id ? session : null), async flush() { return true; } },
    tokenMeter: {
      measure() {
        const nodes = surface.nodes.map((seq) => ({ seq, tokens: approxTokens(blocksToText(session.deriveEventMessage(events[seq])?.content)) }));
        return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) };
      },
    },
    llm: {
      async resolveModelInfo() { return { contextWindow: 200000, maxTokens: 8192 }; },
      async *stream() {
        llmCalls += 1;
        yield { type: 'text-delta', text: summary() };
        yield { type: 'finish', kind: 'stop' };
      },
    },
  };
  const engine = new WeaveCompactionEngine(ctx, resolveConfig({
    archiveDir: join(root, 'archive'),
    language: 'en',
    auto: false,
    sessionMemoryEnabled: false,
  }).config);
  engine.historyToolsAvailable = true;
  fixtures.push(engine);
  const agent = { session, options: { provider: 'p', model: 'm' }, runMaintenance: (fn) => fn(signal()) };

  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  addMsg('system', 'Stable system.');
  const uTiny = addMsg('user', 'Ok.');
  const aTiny = addMsg('assistant', 'Done.');
  const remainingSeqs = [uTiny.seq, aTiny.seq];

  writeResumableCompaction(engine.sessionState, session.id, {
    jobId: 'job-unshrinkable-tail',
    status: 'interrupted',
    trigger: 'manual',
    manual: true,
    remainingSeqs,
    remainingSourceSha256: engine._sourceHashForSeqs(session, remainingSeqs),
    completedChunks: 1,
    completedNodes: 4,
    completedTokens: 4000,
    initialTotalNodes: 6,
    initialTotalTokens: 4010,
    consecutiveFailures: 0,
    updatedAt: new Date().toISOString(),
  });

  let spillCalls = 0;
  engine._spillTailToolOutputs = async () => { spillCalls += 1; };
  const preStepHook = registeredHooks.get('agent/pre-step');
  assert.equal(typeof preStepHook, 'function');

  // First pre-step resumes job-unshrinkable-tail -> unshrinkable tail clears checkpoint instead of resurrecting it
  await preStepHook({ agent, signal: signal(), messages: [], turn: 2, step: 1 }, () => {});
  assert.equal(readResumableCompaction(engine.sessionState, session.id), null);
  assert.equal(llmCalls, 0);

  // Subsequent pre-steps must NOT loop auto-resume and must reach spillTailToolOutputs normally
  await preStepHook({ agent, signal: signal(), messages: [], turn: 2, step: 2 }, () => {});
  await preStepHook({ agent, signal: signal(), messages: [], turn: 2, step: 3 }, () => {});
  assert.equal(llmCalls, 0);
  assert.equal(spillCalls, 2);
});

await test('redline-seal-P1-3-multiroot-disk-liveness-and-reinject-no-host-path', () => {
  const root = scratch();
  const wsA = join(root, 'wsA');
  const wsB = join(root, 'wsB');
  mkdirSync(join(wsA, 'src'), { recursive: true });
  mkdirSync(wsB, { recursive: true });
  writeFileSync(join(wsA, 'src', 'app.js'), 'export const appReady = true;\n', 'utf8');

  const events = [
    {
      seq: 0,
      type: 'working-directory/change',
      data: { cwd: wsB },
    },
    {
      seq: 1,
      type: 'user/message',
      data: {
        id: 'u1',
        role: 'user',
        content: [{
          type: 'text',
          text: `Inspect ${join(wsA, 'src', 'app.js')} and removed ${join(wsA, 'src', 'gone.js')}.`,
        }],
      },
    },
    {
      seq: 2,
      type: 'assistant/message',
      data: {
        message: {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'tool-call', callId: 'c1', name: 'Read', arguments: { path: join(wsA, 'src', 'app.js') } }],
        },
      },
    },
  ];
  const session = {
    id: randomUUID(),
    header: { cwd: wsA },
    get seq() { return events.length; },
    eventAt: (seq) => events[seq],
    deriveEventMessage: (ev) => (ev?.type === 'user/message' ? ev.data : ev?.data?.message),
  };

  const liveness = probeDiskLiveness({
    session,
    shadowedSeqs: [1, 2],
    archivedFiles: [],
    summaryText: `Inspect ${join(wsA, 'src', 'app.js')} and removed ${join(wsA, 'src', 'gone.js')}.`,
  });
  const notice = renderDiskLivenessNotice(liveness);
  assert.deepEqual(liveness.existing, ['src/app.js']);
  assert.deepEqual(liveness.missing, ['src/gone.js']);
  assert.ok(notice.includes('src/gone.js'));
  assert.ok(!notice.includes(wsA.replaceAll('\\', '/')) && !notice.includes(wsA));
  assert.ok(!notice.includes(wsB.replaceAll('\\', '/')) && !notice.includes(wsB));

  const reinject = collectActiveWorkspaceFiles({ session, shadowedSeqs: [1, 2], maxFileBytes: 4096, maxBytes: 8192 });
  assert.equal(reinject.files.length, 1);
  assert.equal(reinject.files[0].path, 'src/app.js');
  assert.ok(!reinject.text.includes(wsA.replaceAll('\\', '/')) && !reinject.text.includes(wsA));
  assert.ok(!reinject.text.includes(wsB.replaceAll('\\', '/')) && !reinject.text.includes(wsB));
});

await test('redline-seal-P1-4-sanitize-archive-default-redact', async () => {
  const archive = new CompactionArchive({ root: join(scratch(), 'archive-p14') });
  const skTok = ['sk_', 'live_', 'archiveP14Secret99'].join('');
  const bearerTok = ['Bearer ', 'bearerP14Token88'].join('');
  const pgDsn = ['postgres://', 'app:dbPassP14', '@db.local:5432/prod'].join('');
  const pairCallId = ['sk_', 'live_', 'call_pair_9988'].join('');
  const events = [
    {
      seq: 0,
      type: 'assistant/message',
      data: {
        message: {
          id: 'a-p14',
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              callId: pairCallId,
              name: 'fetch_data',
              arguments: { authorization: bearerTok, nested: { name: skTok } },
            },
            {
              type: 'text',
              text: 'block with nested payloads',
              data: { name: skTok },
              message: { name: bearerTok },
              source: { callId: pgDsn },
            },
          ],
        },
        args: { token: skTok, type: pgDsn },
        input: { headers: { Authorization: bearerTok } },
        metadata: { dsn: pgDsn },
        source: { kind: 'model', apiKey: skTok, name: skTok },
      },
    },
    {
      seq: 1,
      type: 'tool/result',
      data: {
        callId: pairCallId,
        message: {
          id: 'r-p14',
          role: 'tool',
          toolCallId: pairCallId,
          content: [{ type: 'text', text: `ok ${bearerTok}` }],
          source: { kind: 'tool-result', callId: pairCallId },
        },
        output: { apiKey: skTok },
        meta: { dsn: pgDsn },
        error: `failed with ${bearerTok}`,
      },
    },
  ];
  const session = {
    id: 'sess-p14',
    get seq() { return events.length; },
    eventAt: (seq) => events[seq],
    deriveEventMessage: (ev) => ev?.data?.message,
  };
  const built = spanEntries(session, [0, 1]);
  await archive.writeSpan({ sessionId: 'sess-p14', compactionId: 'cmp-p14', entries: built });
  // Direct root-level assistant entry with content[] preserves callId/name while redacting arguments
  await archive.writeSpan({
    sessionId: 'sess-p14',
    compactionId: 'cmp-p14-direct',
    entries: [{
      seq: 0,
      role: 'assistant',
      content: [{ type: 'tool-call', callId: pairCallId, name: 'fetch_data', arguments: { secret: skTok } }],
    }],
  });
  const directSpan = await archive.readSpan('sess-p14', 'cmp-p14-direct');
  assert.equal(directSpan.ok, true);
  assert.equal(directSpan.entries[0].content[0].callId, pairCallId);
  assert.equal(directSpan.entries[0].content[0].name, 'fetch_data');
  assert.equal(JSON.stringify(directSpan.entries).includes('archiveP14Secret99'), false);

  const span = await archive.readSpan('sess-p14', 'cmp-p14');
  assert.equal(span.ok, true);
  assert.equal(span.entries[0].event.data.message.content[0].callId, pairCallId);
  assert.equal(span.entries[0].event.data.message.content[0].name, 'fetch_data');
  assert.equal(span.entries[0].event.data.source.kind, 'model');
  assert.equal(span.entries[1].event.data.callId, pairCallId);
  assert.equal(span.entries[1].event.data.message.toolCallId, pairCallId);
  assert.equal(span.entries[1].event.data.message.source.callId, pairCallId);
  assert.equal(span.entries[1].tool[0].callId, pairCallId);

  const dumpedSpan = JSON.stringify(span.entries);
  const tools = new Map();
  registerHistoryTools(
    {
      tools: { register: (spec) => tools.set(spec.name, spec) },
      logger: { info() {}, warn() {} },
    },
    { archiveEnabled: true },
    archive,
  );
  const rawRead = await tools.get('history_read').execute({ compactionId: 'cmp-p14', raw: true }, { session: { id: 'sess-p14' } });
  for (const text of [dumpedSpan, rawRead]) {
    for (const secret of ['archiveP14Secret99', 'bearerP14Token88', 'dbPassP14']) {
      assert.equal(text.includes(secret), false, `leaked secret substring: ${secret}`);
    }
  }
});

await test('redline-seal-P1-5-history-tools-fs-errors-no-dsh-home-leak', async () => {
  const dshHome = scratch();
  const archive = new CompactionArchive({ root: join(dshHome, 'archive-v2') });
  const tools = new Map();
  registerHistoryTools(
    {
      tools: { register: (spec) => tools.set(spec.name, spec) },
      logger: { info() {}, warn() {} },
    },
    { archiveEnabled: true },
    archive,
  );
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from('attachment payload bytes');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const ref = { attachmentId: `sha256:${digest}`, bytes: bytes.length, mimeType: 'image/png', name: 'img.png' };
  archive.attachments = { async readImage() { return { data: bytes }; } };
  await archive.writeSpan({
    sessionId: 'sess-p15-att',
    compactionId: 'cmp-p15-att',
    entries: [{ seq: 0, type: 'user/message', role: 'user', text: 'image', blocks: [{ type: 'image', attachment: ref }] }],
  });
  // Delete .blob and verify readAttachment + v2 history_read(rawBase64) do not expose <DSH_HOME> path
  rmSync(join(archive.dirFor('sess-p15-att'), 'attachments', `${digest}.blob`));
  await assert.rejects(
    archive.readAttachment('sess-p15-att', 'cmp-p15-att', ref.attachmentId, 0, 1024),
    (err) => {
      assert.match(err.message, /archived attachment blob missing|attachment owner archive is incomplete/);
      assert.equal(err.message.includes(dshHome), false, err.message);
      return true;
    },
  );
  const v3Span = await archive.readSpan('sess-p15-att', 'cmp-p15-att');
  assert.equal(v3Span.ok, false);
  assert.match(v3Span.detail, /archived attachment blob missing/);
  assert.equal(v3Span.detail.includes(dshHome), false, v3Span.detail);

  // Also test v2 span missing .blob reaching readAttachmentPage directly via history_read({ rawBase64: true })
  const v2Dir = archive.dirFor('sess-p15-v2');
  mkdirSync(v2Dir, { recursive: true });
  const v2Entry = { seq: 0, type: 'user/message', role: 'user', text: 'image', blocks: [{ type: 'image', attachment: ref }] };
  const body = JSON.stringify(v2Entry);
  let fnv = 0x811c9dc5;
  for (let i = 0; i < body.length; i += 1) {
    fnv ^= body.charCodeAt(i) & 0xff;
    fnv = Math.imul(fnv, 0x01000193) >>> 0;
    fnv ^= (body.charCodeAt(i) >>> 8) & 0xff;
    fnv = Math.imul(fnv, 0x01000193) >>> 0;
  }
  const v2Header = {
    kind: 'compaction-weave/span',
    version: 2,
    sessionId: 'sess-p15-v2',
    compactionId: 'cmp-p15-v2',
    entries: 1,
    bytes: Buffer.byteLength(body, 'utf8'),
    checksum: fnv.toString(16).padStart(8, '0'),
  };
  writeFileSync(join(v2Dir, 'cmp-p15-v2.jsonl'), JSON.stringify(v2Header) + '\n' + body + '\n', 'utf8');
  const rawAttErr = await tools.get('history_read').execute(
    { compactionId: 'cmp-p15-v2', attachmentId: ref.attachmentId, rawBase64: true },
    { session: { id: 'sess-p15-v2' } },
  );
  assert.match(rawAttErr, /archived attachment blob missing/);
  assert.equal(rawAttErr.includes(dshHome), false, rawAttErr);

  // Trigger ENOTDIR on sessionDir and verify history_list, history_search, and history_read(seq) scrub paths
  const sessionFile = archive.dirFor('sess-p15-enotdir');
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, 'not a directory', 'utf8');
  const execCtx = { session: { id: 'sess-p15-enotdir' } };
  for (const [toolName, args] of [
    ['history_list', {}],
    ['history_search', { query: 'anything' }],
    ['history_read', { seq: 0 }],
  ]) {
    const out = await tools.get(toolName).execute(args, execCtx);
    assert.equal(out.includes(dshHome), false, `${toolName} leaked DSH_HOME: ${out}`);
    assert.equal(out.includes(sessionFile), false, `${toolName} leaked session path: ${out}`);
  }

  // Wrapped error path scrubbing preserves diagnostic text while removing paths with spaces, backticks, Unicode POSIX paths, and >500-char trailing paths
  const winPath = ['C:', '\\Host Root\\.dsh\\Session Archive.jsonl'].join('');
  const posixHomePath = ['/', 'home', '/review-user/.dsh/archive.jsonl'].join('');
  const uncPath = ['\\\\server', '\\Share Dir\\file.bin'].join('');
  const wrappedTools = new Map();
  registerHistoryTools(
    {
      tools: { register: (spec) => wrappedTools.set(spec.name, spec) },
      logger: { info() {}, warn() {} },
    },
    { archiveEnabled: true },
    {
      async listSpans() {
        throw new Error(`failed to open ${winPath}, \`${posixHomePath}\`, /资料, and ${uncPath}`);
      },
      async readSpan() {
        throw new Error(`${'x '.repeat(260)}/very/long/trailing/secret-host-path.jsonl`);
      },
    },
  );
  const listErr = await wrappedTools.get('history_list').execute({}, { session: { id: 'sess-wrap' } });
  for (const leak of ['Host Root', 'Session Archive', 'review-user', 'archive.jsonl', '/资料', 'Share Dir']) {
    assert.equal(listErr.includes(leak), false, `history_list leaked ${leak}: ${listErr}`);
  }
  const longReadErr = await wrappedTools.get('history_read').execute({ compactionId: 'c1' }, { session: { id: 'sess-wrap' } });
  assert.equal(longReadErr.includes('secret-host-path'), false, longReadErr);
});

await test('goal-round1-P1-1-proactive-failure-receipt-no-host-path', async () => {
  const fakeUnixPath = ['', 'home', 'alice', 'private', 'config.json'].join('/');
  const fakeShadowPath = ['', 'etc', 'shadow'].join('/');
  const failures = [
    Object.assign(new Error('audit constraint lost'), { code: 'CONSTRAINT_LOST' }),
    Object.assign(
      new Error(`reason=provenance, kind=approval, line="用户已批准删除${fakeUnixPath}。Cookie: session=synthetic-cookie-123 token=synthetic_tok_987"`),
      {
        code: 'PROVENANCE_LOST',
        constraintReason: 'provenance',
        provenanceKind: 'approval',
        provenanceLine: `用户已批准删除${fakeUnixPath}。Cookie: session=synthetic-cookie-123 token=synthetic_tok_987`,
      },
    ),
    Object.assign(new Error('cancelled by hook'), {
      code: `${fakeUnixPath}`,
      hookCancelled: true,
      hookReason: `blocked ${fakeShadowPath} token=synthetic_secret999`,
    }),
    Object.assign(new Error('custom upstream secret error'), {
      code: 'TOKEN_SYNTHETIC_SECRET_123',
    }),
  ];

  for (const err of failures) {
    const f = fixture({ auto: false, proactiveEnabled: true });
    f.session.append('turn/start', { turn: 1 });
    f.add('system', 'Sys.');
    f.add('user', 'Keep strict limit <= 30s.');
    f.add('assistant', 'Details '.repeat(400));
    f.engine._measure = async () => ({
      totalTokens: 50000,
      nodes: f.surface.nodes.map((seq) => ({ seq, tokens: Math.floor(50000 / Math.max(1, f.surface.nodes.length)) })),
    });
    f.engine._compactManual = async () => {
      throw err;
    };
    const req = await f.engine.proactive.request(f.agent, 'Completed investigation phase');
    assert.equal(req.status, 'queued');
    const outcome = await f.engine.diagnostics.run(
      f.session,
      { trigger: 'proactive' },
      () => f.engine.proactive.consume(f.agent, signal(), []),
    );
    assert.equal(outcome.status, 'failed');
    assert.ok(typeof outcome.diagnosticId === 'string' && outcome.diagnosticId.length > 0);
    if (err.code === 'TOKEN_SYNTHETIC_SECRET_123' || err.code === fakeUnixPath) {
      assert.equal(outcome.code, 'COMPACTION_FAILED');
    } else {
      assert.equal(outcome.code, err.code);
    }

    const appended = f.events.at(-1);
    assert.equal(appended.type, 'user/message');
    assert.equal(appended.data.source?.kind, 'weave-compaction-status');
    const receiptText = appended.data.content?.[0]?.text ?? '';
    assert.equal(receiptText.includes(f.root), false, `receipt leaked root: ${receiptText}`);
    assert.equal(receiptText.includes('.json'), false, `receipt leaked .json path: ${receiptText}`);
    assert.equal(receiptText.includes('诊断日志：'), false, `receipt leaked 诊断日志：: ${receiptText}`);
    assert.equal(receiptText.includes(fakeUnixPath), false, `receipt leaked posix path: ${receiptText}`);
    assert.equal(receiptText.includes(fakeShadowPath), false, `receipt leaked shadow path: ${receiptText}`);
    assert.equal(receiptText.includes('synthetic-cookie-123'), false, `receipt leaked cookie: ${receiptText}`);
    assert.equal(receiptText.includes('synthetic_tok_987'), false, `receipt leaked token: ${receiptText}`);
    assert.equal(receiptText.includes('synthetic_secret999'), false, `receipt leaked hook token: ${receiptText}`);
    assert.equal(receiptText.includes('TOKEN_SYNTHETIC_SECRET_123'), false, `receipt leaked arbitrary code: ${receiptText}`);
    assert.equal(receiptText.includes(outcome.diagnosticId), true);
    assert.equal(f.logs.some((line) => line.includes('诊断编号：')), true);
  }

  // _restoreState failure during consume() also normalizes unknown uppercase codes
  const fRestore = fixture({ auto: false, proactiveEnabled: true });
  fRestore.session.append('turn/start', { turn: 1 });
  fRestore.add('system', 'Sys.');
  fRestore.add('user', 'Keep strict limit <= 30s.');
  fRestore.add('assistant', 'Details '.repeat(400));
  const reqRestore = await fRestore.engine.proactive.request(fRestore.agent, 'Completed phase');
  assert.equal(reqRestore.status, 'queued');
  fRestore.engine._restoreState = () => {
    throw Object.assign(new Error('restore secret failure'), { code: 'TOKEN_SYNTHETIC_SECRET_123' });
  };
  const restoreOutcome = await fRestore.engine.proactive.consume(fRestore.agent, signal(), []);
  assert.equal(restoreOutcome.status, 'blocked');
  assert.equal(restoreOutcome.code, 'STATE_UNAVAILABLE');
  const restoreReceiptText = fRestore.events.at(-1).data.content?.[0]?.text ?? '';
  assert.equal(restoreReceiptText.includes('TOKEN_SYNTHETIC_SECRET_123'), false);
});

await test('goal-round1-P1-2-continuation-wave-binary-search-and-byShape-linear', async () => {
  const f = fixture({ auto: false });
  f.ctx.llm.resolveModelInfo = async () => ({ contextWindow: 48000, maxTokens: 4096 });
  f.session.append('turn/start', { turn: 1 });
  f.add('system', 'Sys.');
  const padBlock = 'segment '.repeat(500);
  for (let i = 0; i < 1029; i += 1) {
    f.add('user', `Unique user step ${i}: confirm token alpha-${i} stays isolated. ${padBlock}`);
    f.add('assistant', `Unique assistant reply ${i}: verified branch ${i * 7}. ${padBlock}`);
  }
  const capacity = await resolveSummaryCapacity(
    f.ctx,
    { targets: [{ provider: 'p', model: 'm' }] },
    f.engine.config,
    signal(),
  );
  const tWave0 = performance.now();
  const wave = selectContinuationWave(f.session, {
    endSeq: f.surface.nodes.at(-1),
    policy: f.engine.config,
    maxPages: DEFAULT_CONFIG.maxSummaryChunks,
    capacity,
  });
  const waveMs = performance.now() - tWave0;
  assert.equal(wave.limited, true);
  assert.ok(wave.remainingCount > 0);
  assert.ok(wave.pages <= DEFAULT_CONFIG.maxSummaryChunks);
  assert.ok(waveMs < 2000, `selectContinuationWave took ${waveMs.toFixed(1)}ms`);

  // Maximality check: next balanced node after wave.end cannot fit within maxPages
  const waveEndIdx = f.surface.nodes.indexOf(wave.end);
  assert.ok(waveEndIdx >= 1 && waveEndIdx + 1 < f.surface.nodes.length);
  const nextWave = selectContinuationWave(f.session, {
    endSeq: f.surface.nodes[waveEndIdx + 1],
    policy: f.engine.config,
    maxPages: DEFAULT_CONFIG.maxSummaryChunks,
    capacity,
  });
  assert.equal(nextWave.end, wave.end);
  assert.equal(nextWave.limited, true);

  // Non-monotonic exact-fit predicate (6Astra counterexample): ends 0-2 fail capacity
  // due to large earlier workReport, end 3 shrinks workReport & fits maxPages:3, end 4 exceeds maxPages
  const fMono = fixture({ auto: false, continuationMemoryBytes: 2048 });
  fMono.session.append('turn/start', { turn: 1 });
  fMono.add('system', 'Sys.');
  const longWorkReport = `Verified step zero. ${'details '.repeat(360)}`; // ~2.9KB <= MAX_REPORT_BYTES
  fMono.add('assistant', longWorkReport);
  fMono.add('assistant', 'note '.repeat(300));
  const seqA2 = fMono.add('assistant', 'note '.repeat(300)).seq;
  const seqA3 = fMono.add('assistant', 'Done.').seq;
  fMono.add('assistant', 'Payload '.repeat(600));
  fMono.add('assistant', 'Trailing item.');
  const monoCapacity = {
    targets: [{
      provider: 'p',
      model: 'm',
      key: '["p","m"]',
      window: 200000,
      output: 8192,
      margin: 12000,
      inputRatio: 0.85,
      maxInputBytes: 14500,
      scale: 1,
      source: 'test',
    }],
    shrinkLimit: Infinity,
    shrinkTokenLimit: Infinity,
    observedOverflows: 0,
    cjkTokensPerChar: 0.75,
  };
  assert.throws(
    () => selectContinuationWave(fMono.session, {
      endSeq: seqA2,
      policy: fMono.engine.config,
      maxPages: 3,
      capacity: monoCapacity,
    }),
    (err) => err?.code === 'CONTINUATION_CAPACITY',
  );
  const monoWave = selectContinuationWave(fMono.session, {
    endSeq: fMono.surface.nodes.at(-1),
    policy: fMono.engine.config,
    maxPages: 3,
    capacity: monoCapacity,
  });
  assert.equal(monoWave.end, seqA3, `expected non-monotonic max fit at seq ${seqA3}, got ${monoWave.end}`);
  assert.equal(monoWave.limited, true);
  assert.ok(monoWave.pages <= 3);

  // Unconstrained revision supersedes constrained rule ("不要删除缓存。" -> "改为删除缓存。")
  const cacheRev = selectMemoryMessages([
    { seq: 1, role: 'user', text: '不要删除缓存。' },
    { seq: 2, role: 'user', text: '改为删除缓存。' },
  ]);
  assert.equal(cacheRev.active.length, 1);
  assert.equal(cacheRev.active[0].seq, 2);
  assert.equal(cacheRev.decisions.some((d) => d.reason === 'superseded' && d.seq === 1), true);

  // 16/17-entry bucket boundary without FIFO eviction loss: seq 1 and all 16 intermediate plugin entries retire
  const bucketMsgs = [
    { seq: 1, role: 'user', text: 'Must retain at least 100 backup snapshots.' },
  ];
  for (let i = 0; i < 16; i += 1) {
    bucketMsgs.push({
      seq: i + 2,
      role: 'user',
      sourceKind: 'plugin:x',
      text: `Must retain at least ${101 + i} backup snapshots.`,
    });
  }
  bucketMsgs.push({ seq: 18, role: 'user', text: 'Must retain at least 5 backup snapshots.' });
  const bucketRes = selectMemoryMessages(bucketMsgs);
  assert.equal(bucketRes.active.length, 1);
  assert.equal(bucketRes.active[0].seq, 18);
  assert.equal(bucketRes.decisions.some((d) => d.reason === 'superseded' && d.seq === 1), true);

  // Non-superseding same-shape bare-digit items (320 items) stay O(N) AND retain accurate supersession
  const bareDigitMsgs = [];
  for (let i = 0; i < 320; i += 1) {
    bareDigitMsgs.push({
      seq: i + 1,
      role: 'user',
      text: `Must check item ${i + 10} before release.`,
    });
  }
  const tShape0 = performance.now();
  const resShape = selectMemoryMessages(bareDigitMsgs);
  const shapeMs = performance.now() - tShape0;
  assert.equal(resShape.active.length, 320);
  assert.ok(shapeMs < 300, `same-shape bare-digit selectMemoryMessages took ${shapeMs.toFixed(1)}ms`);

  const resRevisedDigit = selectMemoryMessages([
    ...bareDigitMsgs,
    { seq: 321, role: 'user', text: 'Never check item 50 before release.' },
  ]);
  assert.equal(resRevisedDigit.active.length, 320);
  assert.equal(resRevisedDigit.decisions.some((d) => d.reason === 'superseded' && d.seq === 41), true);

  const shortRev = selectMemoryMessages([
    { seq: 1, role: 'user', text: 'Must keep retry delay at least 10 seconds.' },
    { seq: 2, role: 'user', text: 'Must keep retry delay at least 25 seconds.' },
  ]);
  assert.equal(shortRev.decisions.some((d) => d.reason === 'superseded' && d.seq === 1), true);
  assert.equal(shortRev.active.length, 1);

  // Mixed calendar-year/duration and leading-zero quantity equivalents must evaluate individually
  const calDur = selectMemoryMessages([
    { seq: 1, role: 'user', text: '必须在2026年之前完成。' },
    { seq: 2, role: 'user', text: '必须在20年之前完成。' },
    { seq: 3, role: 'user', text: '必须在30年之前完成。' },
  ]);
  assert.deepEqual(calDur.active.map((m) => m.seq), [1, 3]);
  assert.equal(calDur.decisions.some((d) => d.reason === 'superseded' && d.seq === 2 && d.by === 3), true);

  const leadingZero = selectMemoryMessages([
    { seq: 1, role: 'user', text: 'Must retain 05 backup snapshots.' },
    { seq: 2, role: 'user', text: 'Must retain 5 backup snapshots.' },
  ]);
  assert.deepEqual(leadingZero.active.map((m) => m.seq), [1, 2]);

  // Pagination & wave equivalence across UTF-8 multibyte, empty content, repeated references/reminders,
  // multipart part=9->10 splitting, and hasLargePrefix (>256-byte prefix)
  const fEq = fixture({ auto: false, continuationMemoryBytes: 2048 });
  fEq.session.append('turn/start', { turn: 1 });
  fEq.add('system', 'Sys.');
  fEq.add('user', '');
  const repeatedRef = 'Shared runtime note across steps.';
  fEq.session.append('user/message', {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'session-reference' },
    content: [{ type: 'text', text: repeatedRef }],
  }, { surfaceOp: 'append' });
  fEq.session.append('user/message', {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'session-reference' },
    content: [{ type: 'text', text: repeatedRef }],
  }, { surfaceOp: 'append' });
  const reminder = '<system-reminder>Keep local check fast.</system-reminder>';
  fEq.add('user', `${reminder}\n执行中文边界校验：${'测试字节边界'.repeat(1600)}`);
  fEq.add('user', `${reminder}\nFollow up.`);
  const largeKind = `custom_${'x'.repeat(260)}`;
  fEq.session.append('user/message', {
    id: randomUUID(),
    role: 'user',
    source: { kind: largeKind },
    content: [{ type: 'text', text: 'Large prefix item '.repeat(20) }],
  }, { surfaceOp: 'append' });
  const eqCap = {
    targets: [{
      provider: 'p',
      model: 'm',
      key: '["p","m"]',
      window: 200000,
      output: 8192,
      margin: 12000,
      inputRatio: 0.85,
      maxInputBytes: 15000,
      scale: 1,
      source: 'test',
    }],
    shrinkLimit: Infinity,
    shrinkTokenLimit: Infinity,
    observedOverflows: 0,
    cjkTokensPerChar: 0.75,
  };
  const eqWave = selectContinuationWave(fEq.session, {
    endSeq: fEq.surface.nodes.at(-1),
    policy: fEq.engine.config,
    maxPages: 32,
    capacity: eqCap,
  });
  fEq.ctx.llm.stream = async function* (request) {
    fEq.calls.push(request);
    yield { type: 'text-delta', text: notes };
    yield { type: 'finish', kind: 'stop' };
  };
  await prepareContinuation({
    ctx: fEq.ctx,
    agent: fEq.agent,
    session: fEq.session,
    seqs: eqWave.seqs,
    policy: fEq.engine.config,
    capacity: eqCap,
    chain: { targets: [{ provider: 'p', model: 'm' }] },
    compactionId: 'cmp-eq',
    signal: signal(),
    archiveRoot: join(fEq.root, 'archive'),
  });
  assert.equal(fEq.calls.length, eqWave.pages);
  assert.ok(eqWave.pages >= 11, `expected >= 11 pages to cross part=9->10, got ${eqWave.pages}`);
});

await test('goal-round1-P1-3-codeSpanRanges-linear-on-interleaved-tags-and-fences', () => {
  const interleaved = Array.from(
    { length: 1500 },
    (_, i) => `<blockquote>\n\`\`\`\nconst v${i} = ${i};\n\`\`\`\n</blockquote>\nKeep constraint ${i}.`,
  ).join('\n');
  const t0 = performance.now();
  const extracted = instructionText({ role: 'user', blocks: [{ type: 'text', text: interleaved }] });
  const elapsedInterleaved = performance.now() - t0;
  assert.ok(elapsedInterleaved < 250, `interleaved took ${elapsedInterleaved.toFixed(1)}ms`);
  assert.match(extracted, /Keep constraint 1499/);
  assert.doesNotMatch(extracted, /const v1499/);

  const pureFences = Array.from({ length: 4000 }, (_, i) => `\`\`\`\nx=${i}\n\`\`\`\nRule ${i}.`).join('\n');
  const t1 = performance.now();
  const rangesPure = instructionRanges({ role: 'user', blocks: [{ type: 'text', text: pureFences }] });
  const elapsedPure = performance.now() - t1;
  assert.ok(elapsedPure < 250, `pure fences took ${elapsedPure.toFixed(1)}ms`);
  assert.ok(Array.isArray(rangesPure) && rangesPure.length > 0);

  // Exact structural checks: unclosed fence inside container, nested containers,
  // literal closing tag inside balanced fence, CRLF, and multiline tag crossing fence boundaries
  const unclosedInQuote = '<blockquote>\n```\nunclosed fence\n</blockquote>\nAlways require HTTPS.';
  const outQuote = instructionText({ role: 'user', blocks: [{ type: 'text', text: unclosedInQuote }] });
  assert.match(outQuote, /Always require HTTPS/);
  assert.doesNotMatch(outQuote, /unclosed fence/);
  assert.equal(instructionRanges({ role: 'user', blocks: [{ type: 'text', text: unclosedInQuote }] }).length, 1);

  const nestedUnclosed = '<untrusted_reference>\n<blockquote>\n```\nunclosed\n</blockquote>\n</untrusted_reference>\nKeep outer rule.';
  const outNested = instructionText({ role: 'user', blocks: [{ type: 'text', text: nestedUnclosed }] });
  assert.equal(outNested.trim(), 'Keep outer rule.');
  assert.equal(instructionRanges({ role: 'user', blocks: [{ type: 'text', text: nestedUnclosed }] }).length, 1);

  const literalCloseInFence = '<blockquote>\n```\n</blockquote>\n```\nInner quote rule.\n</blockquote>\nKeep outside.';
  const outLiteral = instructionText({ role: 'user', blocks: [{ type: 'text', text: literalCloseInFence }] });
  assert.equal(outLiteral.trim(), 'Keep outside.');

  const crlfMixed = '<blockquote>\r\n```\r\nconst crlf = 1;\r\n```\r\n</blockquote>\r\nCRLF rule survives.';
  const outCrlf = instructionText({ role: 'user', blocks: [{ type: 'text', text: crlfMixed }] });
  assert.equal(outCrlf.trim(), 'CRLF rule survives.');

  const multilineTag = '<blockquote\ndata-attr="x">\n```\nfence line\n```\nInside.\n</blockquote>\nAfter multiline.';
  const outMultiline = instructionText({ role: 'user', blocks: [{ type: 'text', text: multilineTag }] });
  assert.equal(outMultiline.trim(), 'After multiline.');
});

await test('goal-round2-P1-1-map-reduce-continuation-auto-and-manual-resume', async () => {
  const VALID_NOTES = '## Goal\nFinish diagnostics.\n## State\nEvidence archived.\n## Next\nReview results.\n## Uncertain\nNone pending.';
  const makeMrHarness = ({ failAtCall = Infinity } = {}) => {
    const f = fixture({
      summaryRetryCount: 0,
      summaryRetryDelayMs: 0,
      summaryInputMaxBytes: 50000,
      maxSummaryChunks: 32,
      windowFallback: 1000000,
      continuationMaxExtraCalls: 4,
    });
    assert.equal(f.engine.config.summaryConcurrency, 2);
    assert.equal(f.engine.config.continuationMaxExtraCalls, 4);
    f.add('system', 'System prompt.');
    f.add('user', 'Do not delete the audit logs.\n' + 'archiveblob '.repeat(6000));
    f.add('assistant', 'evidence '.repeat(4000));
    f.add('assistant', 'more evidence '.repeat(4000));
    let shouldFail = true;
    f.ctx.llm.resolveModelInfo = async () => ({ contextWindow: 1000000 });
    f.ctx.llm.stream = async function* (opts) {
      f.calls.push(opts);
      if (shouldFail && f.calls.length === failAtCall) {
        throw Object.assign(new Error('503 transient failure'), { status: 503 });
      }
      yield { type: 'text-delta', text: VALID_NOTES };
      yield { type: 'finish', kind: 'stop' };
    };
    return {
      ...f,
      stopFailing() { shouldFail = false; },
    };
  };

  // (a) Auto-resume via compactIfNeeded (tryAutoContinuationRegion) after manual Map-Reduce fails partway
  const hAuto = makeMrHarness({ failAtCall: 4 });
  await assert.rejects(() => hAuto.engine.compactNow(hAuto.agent, signal()));
  const pendingAuto = readPendingContinuation(hAuto.engine.sessionState, hAuto.session);
  assert.ok(pendingAuto?.progressKey);
  const progressRootAuto = join(hAuto.root, 'continuation-progress');
  const savedAuto = new ContinuationProgressStore(progressRootAuto, hAuto.session.id, pendingAuto.progressKey).read()?.data;
  assert.equal(savedAuto?.mode, 'map-reduce');
  assert.ok((savedAuto?.pageNotes?.length ?? 0) >= 2, `expected >= 2 pageNotes, got ${savedAuto?.pageNotes?.length}`);
  hAuto.stopFailing();
  hAuto.engine.sessionState.update(hAuto.session.id, st => {
    const next = { ...st };
    delete next.resumableCompaction;
    return next;
  });
  hAuto.session.append('turn/start', { turn: 99 });
  let autoRes;
  try {
    autoRes = await hAuto.engine.compactIfNeeded(hAuto.agent, 'pressure', signal());
  } finally {
    hAuto.session.append('turn/end', { turn: 99, reason: { kind: 'completed' } });
  }
  assert.ok(autoRes?.continuation);
  assert.equal(autoRes.continuation.progressKey, pendingAuto.progressKey);
  assert.ok(autoRes.continuation.resumedPages >= 2, `expected resumedPages >= 2, got ${autoRes.continuation.resumedPages}`);
  assert.ok(!autoRes.continuation.priorProgressKeys?.includes(pendingAuto.progressKey));

  // (b) Manual-resume via compactNow(..., true) (executeManualRolloverFlow) after Map-Reduce fails partway
  const hManual = makeMrHarness({ failAtCall: 4 });
  await assert.rejects(() => hManual.engine.compactNow(hManual.agent, signal()));
  const pendingManual = readPendingContinuation(hManual.engine.sessionState, hManual.session);
  assert.ok(pendingManual?.progressKey);
  const progressRootManual = join(hManual.root, 'continuation-progress');
  const savedManual = new ContinuationProgressStore(progressRootManual, hManual.session.id, pendingManual.progressKey).read()?.data;
  assert.equal(savedManual?.mode, 'map-reduce');
  assert.ok((savedManual?.pageNotes?.length ?? 0) >= 2, `expected >= 2 pageNotes, got ${savedManual?.pageNotes?.length}`);
  hManual.stopFailing();
  const manualRes = await hManual.engine.compactNow(hManual.agent, signal(), randomUUID(), true);
  assert.ok(manualRes?.continuation);
  assert.equal(manualRes.continuation.progressKey, pendingManual.progressKey);
  assert.ok(manualRes.continuation.resumedPages >= 2, `expected resumedPages >= 2, got ${manualRes.continuation.resumedPages}`);
  assert.ok(!manualRes.continuation.priorProgressKeys?.includes(pendingManual.progressKey));
});

await test('goal-round2-P1-2-selectContinuationWave-linear-under-default-and-tight-budgets', async () => {
  const defaultCfg200k = resolveConfig({}).config;
  const cap200k = await resolveSummaryCapacity(
    { llm: { resolveModelInfo: async () => ({ contextWindow: 200000, maxTokens: 8192 }) }, logger: { warn() {} } },
    { targets: [{ provider: 'p', model: 'm' }] },
    defaultCfg200k,
    signal(),
  );
  const buildWaveSession = (nodeCount, { userTextLen = 550, userEvery = 4, withRepeatedReads = false } = {}) => {
    const f = fixture({ auto: false });
    f.add('system', 'Sys.');
    const appendReadPair = (callId, body) => {
      f.session.append('assistant/message', {
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'tool-call', callId, name: 'read_file', arguments: { path: 'src/app.js' } }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      }, { surfaceOp: 'append' });
      f.session.append('tool/result', {
        message: {
          role: 'tool',
          toolCallId: callId,
          content: [{ type: 'text', text: body }],
        },
      }, { surfaceOp: 'append' });
    };
    if (withRepeatedReads) {
      appendReadPair('tc-r1', 'line1 '.repeat(500));
    }
    const start = withRepeatedReads ? 3 : 1;
    const stop = nodeCount - (withRepeatedReads ? 2 : 0);
    for (let i = start; i < stop; i += 1) {
      if (withRepeatedReads && i === 301) {
        appendReadPair('tc-r-mid', 'lineMid '.repeat(500));
        continue;
      }
      if (i % userEvery === 0) {
        f.add('user', `User rule ${i}: Must keep module_${i} contract unchanged and verify ${'k'.repeat(userTextLen)}.`);
      } else {
        f.add('assistant', `Step ${i} output processed cleanly.`);
      }
    }
    if (withRepeatedReads) {
      appendReadPair('tc-r2', 'line2 '.repeat(500));
    }
    return f.session;
  };

  // (a) Default 200k 2,060-node workload
  const s2060 = buildWaveSession(2060, { userTextLen: 550, userEvery: 4 });
  const t0a = performance.now();
  const w2060 = selectContinuationWave(s2060, {
    endSeq: s2060.surface.nodes.at(-1),
    policy: defaultCfg200k,
    maxPages: defaultCfg200k.maxSummaryChunks,
    capacity: cap200k,
  });
  const msA = performance.now() - t0a;
  assert.ok(w2060?.seqs?.length > 0);
  assert.ok(msA < 1000, `200k 2060-node selectContinuationWave took ${msA.toFixed(1)}ms`);
  // Maximality: next node beyond wave.end cannot expand the wave further
  const idx2060 = s2060.surface.nodes.indexOf(w2060.end);
  if (idx2060 + 1 < s2060.surface.nodes.length) {
    const w2060Next = selectContinuationWave(s2060, {
      endSeq: s2060.surface.nodes[idx2060 + 1],
      policy: defaultCfg200k,
      maxPages: defaultCfg200k.maxSummaryChunks,
      capacity: cap200k,
    });
    assert.equal(w2060Next.end, w2060.end);
  }

  // (b) Tight-budget 2,120-node workload (forced smaller tight capacity ceiling)
  const capTight = await resolveSummaryCapacity(
    { llm: { resolveModelInfo: async () => ({ contextWindow: 48000, maxTokens: 4096 }) }, logger: { warn() {} } },
    { targets: [{ provider: 'p', model: 'm' }] },
    defaultCfg200k,
    signal(),
  );
  const s2120 = buildWaveSession(2120, { userTextLen: 260, userEvery: 4 });
  const t0b = performance.now();
  const w2120 = selectContinuationWave(s2120, {
    endSeq: s2120.surface.nodes.at(-1),
    policy: defaultCfg200k,
    maxPages: defaultCfg200k.maxSummaryChunks,
    capacity: capTight,
  });
  const msB = performance.now() - t0b;
  assert.ok(w2120?.seqs?.length > 0);
  assert.ok(msB < 1000, `tight 2120-node selectContinuationWave took ${msB.toFixed(1)}ms`);

  // (c) Tight-budget 2,122-node repeated-read workload (waveSupersededReads.size > 0)
  const s2122 = buildWaveSession(2122, { userTextLen: 260, userEvery: 4, withRepeatedReads: true });
  assert.ok(deduplicateRepeatedFileReads(s2122, s2122.surface.nodes).size > 0, 'repeated reads must actually deduplicate');
  const t0c = performance.now();
  const w2122 = selectContinuationWave(s2122, {
    endSeq: s2122.surface.nodes.at(-1),
    policy: defaultCfg200k,
    maxPages: defaultCfg200k.maxSummaryChunks,
    capacity: capTight,
  });
  const msC = performance.now() - t0c;
  assert.ok(w2122?.seqs?.length > 0);
  assert.ok(msC < 1000, `tight repeated-read 2122-node selectContinuationWave took ${msC.toFixed(1)}ms`);

  // Verify non-monotonic workReport exactness still holds
  const fMono = fixture({ auto: false, continuationMemoryBytes: 2048 });
  fMono.add('system', 'Sys.');
  fMono.add('assistant', `Verified baseline. ${'details '.repeat(360)}`);
  fMono.add('assistant', 'note '.repeat(300));
  const seqA2 = fMono.add('assistant', 'note '.repeat(300)).seq;
  const seqA3 = fMono.add('assistant', 'Done.').seq;
  fMono.add('assistant', 'Payload '.repeat(600));
  const monoCapacity = {
    targets: [{ provider: 'p', model: 'm', key: '["p","m"]', window: 200000, output: 8192, margin: 12000, inputRatio: 0.85, maxInputBytes: 14500, scale: 1, source: 'test' }],
    shrinkLimit: Infinity,
    shrinkTokenLimit: Infinity,
    observedOverflows: 0,
    cjkTokensPerChar: 0.75,
  };
  assert.throws(
    () => selectContinuationWave(fMono.session, { endSeq: seqA2, policy: fMono.engine.config, maxPages: 3, capacity: monoCapacity }),
    err => err?.code === 'CONTINUATION_CAPACITY',
  );
  const wMono = selectContinuationWave(fMono.session, { endSeq: fMono.surface.nodes.at(-1), policy: fMono.engine.config, maxPages: 3, capacity: monoCapacity });
  assert.equal(wMono.end, seqA3);
});

await test('goal-round2-P1-3-selectMemoryMessages-linear-on-percent-dates-and-decimals', () => {
  // (a) 600 percentage constraints
  const pctMsgs = Array.from({ length: 600 }, (_, i) => ({
    seq: i,
    role: 'user',
    text: `覆盖率必须达到 ${(10 + i * 0.1).toFixed(1)}% 且保留详细测试报告和日志`,
  }));
  const t0a = performance.now();
  const pctRes = selectMemoryMessages(pctMsgs);
  const pctMs = performance.now() - t0a;
  assert.equal(pctRes.active.length, 600);
  assert.ok(pctMs < 750, `600 pct rules took ${pctMs.toFixed(1)}ms`);

  // (b) 336 calendar date constraints (common '2026' across all entries)
  const dateMsgs = Array.from({ length: 336 }, (_, i) => ({
    seq: i,
    role: 'user',
    text: `必须在 2026年${(Math.floor(i / 28) % 12) + 1}月${(i % 28) + 1}日 完成第 ${i} 批每日备份归档任务`,
  }));
  const t0b = performance.now();
  const dateRes = selectMemoryMessages(dateMsgs);
  const dateMs = performance.now() - t0b;
  assert.equal(dateRes.active.length, 336);
  assert.ok(dateMs < 500, `336 date rules took ${dateMs.toFixed(1)}ms`);

  // (c) 300 non-scalar decimal constraints
  const decMsgs = Array.from({ length: 300 }, (_, i) => ({
    seq: i,
    role: 'user',
    text: `错误率不得高于 ${(1.1 + i * 0.1).toFixed(1)} 个百分点且保留全部异常检测日志。`,
  }));
  const t0c = performance.now();
  const decRes = selectMemoryMessages(decMsgs);
  const decMs = performance.now() - t0c;
  assert.equal(decRes.active.length, 211);
  assert.ok(decMs < 500, `300 decimal rules took ${decMs.toFixed(1)}ms`);

  // (d) Exact equivalence semantics preserved: 2026年 vs 20年 vs 30年 remain distinct; 05 vs 5 match; targeted polarity reversal retires only target
  const distinctDates = selectMemoryMessages([
    { seq: 1, role: 'user', text: '2026年冻结日志归档。' },
    { seq: 2, role: 'user', text: '20年冻结日志归档。' },
    { seq: 3, role: 'user', text: '30年冻结日志归档。' },
  ]);
  assert.equal(distinctDates.active.length, 3);

  const leadingZeroDistinct = selectMemoryMessages([
    { seq: 1, role: 'user', text: '最多保留 05 个历史快照。' },
    { seq: 2, role: 'user', text: '最多保留 5 个历史快照。' },
  ]);
  assert.equal(leadingZeroDistinct.active.length, 2);

  const leadingZeroConflict = selectMemoryMessages([
    { seq: 1, role: 'user', text: 'Must retain at least 05 backup snapshots.' },
    { seq: 2, role: 'user', text: 'Must retain at least 06 backup snapshots.' },
  ]);
  assert.equal(leadingZeroConflict.active.length, 1);
  assert.equal(leadingZeroConflict.active[0].seq, 2);

  const groupWithReversal = [
    ...Array.from({ length: 120 }, (_, i) => ({
      seq: i,
      role: 'user',
      text: `module_${i} 的覆盖率必须达到 ${(10 + i * 0.1).toFixed(1)}% 且保留详细测试报告和日志`,
    })),
    {
      seq: 999,
      role: 'user',
      text: 'module_42 的覆盖率不要必须达到 14.2% 且不要保留详细测试报告和日志',
    },
  ];
  const revRes = selectMemoryMessages(groupWithReversal);
  assert.equal(revRes.active.some(m => m.seq === 42), false);
  assert.equal(revRes.active.some(m => m.seq === 999), true);
  assert.equal(revRes.active.length, 120);
});

await test('goal-round2-P1-4-provenance-partial-clause-cancellation-same-seq', async () => {
  const f = fixture({
    auditEnabled: true,
    auditBlockOnLoss: true,
    auditProvenanceBlock: true,
    auditExhaustionPolicy: 'block',
    summaryRetryCount: 0,
    summaryRetryDelayMs: 0,
  });
  f.session.append('turn/start', { turn: 0 });
  f.add('system', 'Sys.');
  const u0 = f.add('user', '我已批准发布 alpha-svc 到 staging。我已批准删除临时目录 tmp_old。');
  f.add('assistant', 'pad '.repeat(2500));
  const u2 = f.add('user', '取消删除临时目录 tmp_old。');
  f.add('assistant', 'Done step 3.');

  const sel = selectSessionMemory(f.session, [u0.seq, u0.seq + 1, u2.seq]);
  const compliantSummary = [
    '## 1. Primary Request and Intent',
    '- 用户已批准发布 alpha-svc 到 staging。',
    '## 2. Key Technical Concepts',
    '- Staging deployment.',
    '## 3. Files and Code Sections',
    '- None modified.',
    '## 4. Errors and Fixes',
    '- None.',
    '## 5. Problem Solving',
    '- Cancelled temporary cleanup.',
    '## 6. All User Messages',
    '[filled by engine]',
    '## 7. Pending Tasks',
    '- 发布 alpha-svc 到 staging。',
    '## 8. Work Completed',
    '- Prepared staging deployment.',
    '## 9. Context for Continuing Work',
    '- Proceed with staging deploy.',
  ].join('\n');
  const okAudit = auditMemorySelection({ selection: sel, summaryText: compliantSummary });
  assert.equal(okAudit.lost.length, 0, `expected 0 lost items, got ${JSON.stringify(okAudit.lost)}`);

  const badSummary = compliantSummary.replace(
    'Staging deployment.',
    'Staging deployment. 用户已批准删除临时目录 tmp_old。',
  );
  const badAudit = auditMemorySelection({ selection: sel, summaryText: badSummary });
  assert.equal(badAudit.lost.some(x => x.reason === 'provenance'), true);

  f.ctx.llm.stream = async function* (req) {
    f.calls.push(req);
    yield { type: 'text-delta', text: compliantSummary };
    yield { type: 'finish', kind: 'stop' };
  };
  const compactRes = await f.engine.compactRegion(u0.seq, u2.seq, f.agent, signal());
  assert.ok(compactRes?.summarySeq >= 0);
});

await test('goal-round2-codex-P1-1-mapreduce-multigroup-reduce-resumes-without-loop', async () => {
  const f = fixture({
    summaryRetryCount: 0,
    summaryRetryDelayMs: 0,
    summaryInputMaxBytes: 24000,
    continuationMemoryBytes: 10000,
    maxSummaryChunks: 32,
    windowFallback: 1000000,
    continuationMaxExtraCalls: 4,
  });
  f.add('system', 'Sys.');
  for (let i = 0; i < 4; i += 1) {
    f.add('assistant', `Segment ${i}: ` + 'artifact '.repeat(450));
  }
  const LONG_MAP_NOTE = [
    '## Goal',
    'Continue multi-page diagnostics.',
    '## State',
    'Evidence remains archived. ' + 'detail '.repeat(750),
    '## Next',
    'Complete synthesis.',
    '## Uncertain',
    'None.',
  ].join('\n');
  const FINAL_MERGE_NOTE = [
    '## Goal',
    'Continue multi-page diagnostics.',
    '## State',
    'Merged multi-group evidence.',
    '## Next',
    'Verify final state.',
    '## Uncertain',
    'None.',
  ].join('\n');

  const capacity = await resolveSummaryCapacity(
    { llm: { resolveModelInfo: async () => ({ contextWindow: 1000000, maxTokens: 8192 }) }, logger: { warn() {} } },
    { targets: [{ provider: 'p', model: 'm' }] },
    f.engine.config,
    signal(),
  );
  const seqs = f.surface.nodes.slice(1);
  f.ctx.llm.stream = async function* (req) {
    f.calls.push(req);
    const body = req.messages.map(m => blocksToText(m.content ?? [])).join('\n');
    const isMap = body.includes('Independent notes for page ');
    yield { type: 'text-delta', text: isMap ? LONG_MAP_NOTE : FINAL_MERGE_NOTE };
    yield { type: 'finish', kind: 'stop' };
  };

  let progressKey = null;
  let err1 = null;
  try {
    await prepareContinuation({
      ctx: f.ctx,
      agent: f.agent,
      session: f.session,
      seqs,
      policy: f.engine.config,
      capacity,
      chain: { targets: [{ provider: 'p', model: 'm' }] },
      compactionId: 'cmp-mr-reduce-1',
      signal: signal(),
      archiveRoot: join(f.root, 'archive', 'sess-mr'),
      onProgressIdentity: k => { progressKey = k; },
      manualRetry: true,
      requestId: 'req-mr-1',
      parallelContinuation: true,
    });
  } catch (e) {
    err1 = e;
  }
  assert.equal(err1?.code, 'CONTINUATION_CALL_BUDGET', `expected CONTINUATION_CALL_BUDGET, got ${err1?.code}: ${err1?.message}`);
  const store = new ContinuationProgressStore(join(f.root, 'archive', 'continuation-progress'), f.session.id, progressKey);
  const saved1 = store.read()?.data;
  assert.equal(saved1?.mode, 'map-reduce');
  assert.equal(saved1?.reduced, false);
  assert.ok((saved1?.reduceNext ?? 0) >= 4, `expected reduceNext >= 4 saved, got ${saved1?.reduceNext}`);
  assert.ok(typeof saved1?.reduceMemory === 'string' && saved1.reduceMemory.length > 0);
  assert.equal(saved1?.reduceGroupHashes?.length, saved1?.reduceNext);

  const callsBeforeResume = f.calls.length;
  const resumed = await prepareContinuation({
    ctx: f.ctx,
    agent: f.agent,
    session: f.session,
    seqs,
    policy: f.engine.config,
    capacity,
    chain: { targets: [{ provider: 'p', model: 'm' }] },
    compactionId: 'cmp-mr-reduce-2',
    signal: signal(),
    archiveRoot: join(f.root, 'archive', 'sess-mr'),
    manualRetry: true,
    requestId: 'req-mr-2',
    parallelContinuation: true,
  });
  assert.ok(f.calls.length > callsBeforeResume);
  assert.equal(resumed.summarized.continuation.progressKey, progressKey);
  const saved2 = store.read()?.data;
  assert.equal(saved2?.reduced, true);
  assert.ok((saved2?.reduceNext ?? 0) > saved1.reduceNext);

  // Tampered reduceGroupHashes (unfinished & completed), premature completion, and oversized reduceNext must all fail closed
  const runExpectInvalid = async (mutated, suffix) => {
    const cur = store.read();
    store.write(mutated, cur.revision);
    await assert.rejects(
      () => prepareContinuation({
        ctx: f.ctx,
        agent: f.agent,
        session: f.session,
        seqs,
        policy: f.engine.config,
        capacity,
        chain: { targets: [{ provider: 'p', model: 'm' }] },
        compactionId: `cmp-mr-reduce-${suffix}`,
        signal: signal(),
        archiveRoot: join(f.root, 'archive', 'sess-mr'),
        manualRetry: true,
        requestId: `req-mr-${suffix}`,
        parallelContinuation: true,
      }),
      err => err?.code === 'CONTINUATION_PROGRESS_INVALID',
    );
  };

  const prematureCompleted = {
    ...structuredClone(saved1),
    reduced: true,
    memory: FINAL_MERGE_NOTE,
    reduceMemory: FINAL_MERGE_NOTE,
    last: {
      rawText: FINAL_MERGE_NOTE,
      summary: [{ type: 'text', text: FINAL_MERGE_NOTE }],
      provider: 'p',
      model: 'm',
      maxTokens: 8192,
      language: 'en',
      usage: null,
      reconstruction: null,
    },
  };
  await runExpectInvalid(prematureCompleted, 'premature');

  const completedTamperedHash = {
    ...structuredClone(saved2),
    reduceGroupHashes: ['f'.repeat(64), ...saved2.reduceGroupHashes.slice(1)],
  };
  await runExpectInvalid(completedTamperedHash, 'completed-hash');

  const completedOversizedCursor = {
    ...structuredClone(saved2),
    reduceNext: 999,
    reduceGroupHashes: Array.from({ length: 999 }, (_, i) => saved2.reduceGroupHashes[i] ?? 'a'.repeat(64)),
  };
  await runExpectInvalid(completedOversizedCursor, 'completed-cursor');

  await runExpectInvalid(
    { ...structuredClone(saved1), reduceGroupHashes: ['f'.repeat(64), ...saved1.reduceGroupHashes.slice(1)] },
    'unreduced-hash',
  );
});

await test('goal-round2-codex-P1-2-reordered-checkpoint-superseded-read-uses-surface-index', async () => {
  const f = fixture({
    microcompactRepeatedReadMinChars: 500,
    continuationMemoryBytes: 2048,
    maxSummaryChunks: 1,
    summaryInputMaxBytes: 11700,
    windowFallback: 1000000,
  });
  // Construct reordered surface [0, 1, 2, 10, 5, 6] mimicking checkpoint replacement + preserved tail
  f.add('system', 'Sys.'); // seq 0
  f.session.append('assistant/message', {
    message: {
      id: randomUUID(), role: 'assistant',
      content: [{ type: 'tool-call', callId: 'c1', name: 'read_file', arguments: { path: 'app.js' } }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
  }, { surfaceOp: 'append' }); // seq 1
  f.session.append('tool/result', {
    message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'R1_'.repeat(200) }] },
  }, { surfaceOp: 'append' }); // seq 2 (600 chars)
  f.add('assistant', 'pad-3'); // seq 3 (not on surface)
  f.add('assistant', 'pad-4'); // seq 4 (not on surface)
  f.session.append('assistant/message', {
    message: {
      id: randomUUID(), role: 'assistant',
      content: [{ type: 'tool-call', callId: 'c2', name: 'read_file', arguments: { path: 'app.js' } }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
  }, { surfaceOp: 'append' }); // seq 5
  f.session.append('tool/result', {
    message: { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'R2_'.repeat(200) }] },
  }, { surfaceOp: 'append' }); // seq 6 (supersedes seq 2)
  // Empty slots 7..9 then checkpoint at seq 10
  f.add('assistant', 'pad-7');
  f.add('assistant', 'pad-8');
  f.add('assistant', 'pad-9');
  const cpEvent = f.session.append('user/message', {
    id: randomUUID(), role: 'user',
    source: { kind: 'compact-checkpoint', compactionId: 'c-prev', memoryRequirements: [], memorySources: [], memoryDecisions: [] },
    content: [{ type: 'text', text: 'Checkpoint summary: ' + 'x'.repeat(2100) }],
  }); // seq 10 (sized so [1, 2, 10] fits 1 page ONLY if seq 2 is collapsed, and exceeds 1 page otherwise)
  f.surface.nodes.splice(0, f.surface.nodes.length, 0, 1, 2, cpEvent.seq, 5, 6);

  const capacity = {
    targets: [{ provider: 'p', model: 'm', key: '["p","m"]', window: 1000000, output: 8192, margin: 12000, inputRatio: 0.85, maxInputBytes: 11700, scale: 1, source: 'test' }],
    shrinkLimit: Infinity, shrinkTokenLimit: Infinity, observedOverflows: 0, cjkTokensPerChar: 0.75,
  };
  const wave = selectContinuationWave(f.session, {
    endSeq: 6,
    policy: f.engine.config,
    maxPages: 1,
    capacity,
  });
  // seq 6 supersedes seq 2, and seq 6 is OUTSIDE prefix [1, 2, 10], so seq 2 stays ~600B
  // making [1, 2, 10] > 1 page; wave must safely pick [1, 2] instead of [1, 2, 10].
  assert.deepEqual(wave.seqs, [1, 2], `expected [1, 2] not [1, 2, 10], got ${JSON.stringify(wave.seqs)}`);

  const VALID_NOTES = '## Goal\nContinue review.\n## State\nEvidence archived.\n## Next\nReview.\n## Uncertain\nNone.';
  f.ctx.llm.stream = async function* (req) {
    f.calls.push(req);
    yield { type: 'text-delta', text: VALID_NOTES };
    yield { type: 'finish', kind: 'stop' };
  };
  const prep = await prepareContinuation({
    ctx: f.ctx, agent: f.agent, session: f.session, seqs: wave.seqs,
    policy: f.engine.config, capacity, chain: { targets: [{ provider: 'p', model: 'm' }] },
    compactionId: 'cmp-reorder', signal: signal(), archiveRoot: join(f.root, 'archive', 'sess-reorder'),
  });
  assert.equal(prep.summarized.continuation.pages.length, 1);
});

await test('goal-round2-codex-P2-3-impossible-checkpoint-budget-fast-fail', async () => {
  const f = fixture({ auto: false });
  f.add('system', 'Sys.');
  for (let i = 1; i < 2000; i += 1) {
    f.add('assistant', `Assistant step ${i}`);
  }
  const cap = await resolveSummaryCapacity(
    { llm: { resolveModelInfo: async () => ({ contextWindow: 200000, maxTokens: 8192 }) }, logger: { warn() {} } },
    { targets: [{ provider: 'p', model: 'm' }] },
    f.engine.config,
    signal(),
  );
  const t0 = performance.now();
  assert.throws(
    () => selectContinuationWave(f.session, {
      endSeq: f.surface.nodes.at(-1),
      policy: f.engine.config,
      maxPages: 32,
      capacity: cap,
      checkpointBudgetTokens: 1000,
    }),
    err => err?.code === 'CONTINUATION_TOO_LARGE',
  );
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 200, `impossible checkpointBudgetTokens took ${elapsed.toFixed(1)}ms`);

  // Custom estimateCheckpointTokens charging differently for equal-length scope strings must agree with prepareContinuation
  const fs = fixture({ continuationMemoryBytes: 2048, summaryInputMaxBytes: 14400 });
  fs.add('system', 'Sys.');
  for (let i = 1; i <= 11; i += 1) {
    fs.add('assistant', `msg ${String(i).padStart(2, '0')}`);
  }
  const capCustom = {
    targets: [{ provider: 'p', model: 'm', key: '["p","m"]', window: 200000, output: 8192, margin: 12000, inputRatio: 0.85, maxInputBytes: 14400, scale: 1, source: 'test' }],
    shrinkLimit: Infinity, shrinkTokenLimit: Infinity, observedOverflows: 0, cjkTokensPerChar: 0.75,
  };
  const customMeter = (blocks) => {
    const txt = blocksToText(blocks);
    return approxTokens(txt) + (txt.includes('Scope: 11 selected') ? 500 : 0);
  };
  const basePlan10 = planContinuationMemory([], fs.engine.config, { estimateTokens: customMeter });
  const budgetTokensCustom = basePlan10.reservedTokens + 150;
  const waveCustom = selectContinuationWave(fs.session, {
    endSeq: fs.surface.nodes.at(-1),
    policy: fs.engine.config,
    maxPages: 32,
    capacity: capCustom,
    checkpointBudgetTokens: budgetTokensCustom,
    estimateCheckpointTokens: customMeter,
  });
  assert.equal(waveCustom.seqs.length, 10, `expected 10-message prefix avoiding 11-message scope penalty, got ${waveCustom.seqs.length}`);
});

await test('goal-round2-codex-P2-4-provenance-coordinated-conjunction-partial-cancel', () => {
  for (const conj of ['并', '并且']) {
    const f = fixture({ auto: false });
    const u0 = f.add('user', `我已批准发布 alpha-svc 到 staging ${conj}删除临时目录 tmp_old。`);
    const u1 = f.add('user', '取消删除临时目录 tmp_old。');
    const sel = selectSessionMemory(f.session, [u0.seq, u1.seq]);

    const baseSummary = [
      '## 1. Primary Request and Intent',
      '- KEEP_PLACEHOLDER',
      '## 2. Key Technical Concepts',
      '- Staging.',
      '## 3. Files and Code Sections',
      '- None.',
      '## 4. Errors and Fixes',
      '- None.',
      '## 5. Problem Solving',
      '- Cancelled cleanup.',
      '## 6. All User Messages',
      '[filled by engine]',
      '## 7. Pending Tasks',
      '- DONE_PLACEHOLDER',
      '## 8. Work Completed',
      '- Prepared.',
      '## 9. Context for Continuing Work',
      '- Continue.',
    ].join('\n');

    const okSummary = baseSummary
      .replace('KEEP_PLACEHOLDER', '用户已批准发布 alpha-svc 到 staging。')
      .replace('DONE_PLACEHOLDER', '发布 alpha-svc 到 staging。');
    const okAudit = auditMemorySelection({ selection: sel, summaryText: okSummary });
    assert.equal(okAudit.lost.length, 0, `${conj}: expected 0 lost items, got ${JSON.stringify(okAudit.lost)}`);

    const badCancelledSummary = baseSummary
      .replace('KEEP_PLACEHOLDER', '用户已批准删除临时目录 tmp_old。')
      .replace('DONE_PLACEHOLDER', '删除 tmp_old。');
    const badCancelledAudit = auditMemorySelection({ selection: sel, summaryText: badCancelledSummary });
    assert.equal(badCancelledAudit.lost.some(x => x.reason === 'provenance'), true, conj);

    const badCompoundSummary = baseSummary
      .replace('KEEP_PLACEHOLDER', `用户已批准发布 alpha-svc 到 staging ${conj}删除临时目录 tmp_old。`)
      .replace('DONE_PLACEHOLDER', '发布 alpha-svc。');
    const badCompoundAudit = auditMemorySelection({ selection: sel, summaryText: badCompoundSummary });
    assert.equal(badCompoundAudit.lost.some(x => x.reason === 'provenance'), true, conj);
  }
});

await test('goal-round2-codex-P2-5-tolerance-float-parity-and-alternating-month-linear', () => {
  const vals = [
    '1.0000000000009',
    '1.0000000000008',
    '1.0000000000007',
    '1.0000000000006',
    '1.0000000000005',
    '1.0000000000004',
    '1.0000000000018',
  ];
  const brute = (msgs) => {
    const kept = [];
    for (const m of msgs) {
      for (let i = kept.length - 1; i >= 0; i -= 1) {
        const rep = auditCompaction({
          userMessages: [{ seq: 0, text: kept[i].text }],
          summaryText: m.text,
          checkpointText: kept[i].text,
          threshold: 0.85,
        });
        if (rep.lost.some(x => ['polarity', 'value', 'unit', 'range', 'relation', 'exception', 'reference'].includes(x.reason))) {
          kept.splice(i, 1);
        }
      }
      kept.push(m);
    }
    return kept.map(m => m.seq);
  };
  for (const seqVals of [vals, [...vals.slice(0, 6).reverse(), vals[6]]]) {
    const msgs = seqVals.map((v, seq) => ({ seq, role: 'user', text: `Must wait ${v} seconds before checking the logs.` }));
    const got = selectMemoryMessages(msgs).active.map(m => m.seq);
    assert.deepEqual(got, brute(msgs));
  }

  const altMonthMsgs = Array.from({ length: 2000 }, (_, i) => ({
    seq: i,
    role: 'user',
    text: `必须在 ${2000 + i}年${(i % 2) + 1}月9日 完成每日备份归档任务`,
  }));
  const t0 = performance.now();
  const altRes = selectMemoryMessages(altMonthMsgs);
  const altMs = performance.now() - t0;
  assert.equal(altRes.active.length, 2000);
  assert.ok(altMs < 500, `2000 alternating-month rules took ${altMs.toFixed(1)}ms`);
});

await test('goal-round3-P1-1-parallel-map-budget-race-and-out-of-order-persistence', async () => {
  const mkNotes = (n) => `## Goal\nGoal p${n}\n\n## State\nState p${n}\n\n## Next\nNext p${n}\n\n## Uncertain\nNone.`;
  const runTransientRace = async ({ extraCalls, summaryConcurrency, summaryRetryCount, fastSibling }) => {
    const f = fixture({
      archiveEnabled: true,
      language: 'en',
      summaryRetryCount,
      summaryRetryDelayMs: 0,
      maxTokens: 1200,
      auditEnabled: false,
      auditBlockOnLoss: false,
      parallelPages: true,
      summaryConcurrency,
      summaryInputMaxBytes: 24000,
      continuationMemoryBytes: 4096,
      maxSummaryChunks: 32,
      windowFallback: 1000000,
      continuationMaxExtraCalls: extraCalls,
    });
    f.add('system', 'Sys.');
    for (let i = 1; i <= 14; i += 1) {
      f.add('assistant', `Segment ${i}: ` + `trace payload_${i} `.repeat(380));
    }
    const seqs = f.surface.nodes.slice(1);
    const capacity = await resolveSummaryCapacity(
      { llm: { resolveModelInfo: async () => ({ contextWindow: 1000000, maxTokens: 1200 }) }, logger: { warn() {} } },
      { targets: [{ provider: 'p', model: 'm' }] },
      f.engine.config,
      signal(),
    );
    let page1FailedOnce = false;
    let mapCalls = 0;
    let progressKey = null;
    f.ctx.llm.stream = async function* (req) {
      f.calls.push(req);
      const body = req.messages.map((m) => blocksToText(m.content ?? [])).join('\n');
      const m = /page (\d+) of (\d+)/.exec(body);
      if (m) {
        mapCalls += 1;
        const pageNo = Number(m[1]);
        if (pageNo === 1) {
          await delay(fastSibling ? 35 : 5);
          if (!page1FailedOnce) {
            page1FailedOnce = true;
            const err = new Error('HTTP 429 rate limit');
            err.status = 429;
            throw err;
          }
          yield { type: 'text-delta', text: mkNotes(pageNo) };
          yield { type: 'finish', kind: 'stop' };
          return;
        }
        await delay(fastSibling ? 5 : 40);
        yield { type: 'text-delta', text: mkNotes(pageNo) };
        yield { type: 'finish', kind: 'stop' };
        return;
      }
      yield { type: 'text-delta', text: mkNotes('reduced') };
      yield { type: 'finish', kind: 'stop' };
    };
    const res = await prepareContinuation({
      ctx: f.ctx,
      agent: f.agent,
      session: f.session,
      seqs,
      policy: f.engine.config,
      capacity,
      chain: { targets: [{ provider: 'p', model: 'm' }] },
      compactionId: `cmp-race-${extraCalls}-${fastSibling}`,
      signal: signal(),
      archiveRoot: join(f.root, 'archive', 'sess-race'),
      onProgressIdentity: (k) => { progressKey = k; },
      rateLimitCooldownMs: 0,
      parallelContinuation: true,
    });
    assert.ok(res?.summarized?.summary?.length > 0);
    assert.equal(res.summarized.continuation.pages.length, seqs.length);
    const store = new ContinuationProgressStore(join(f.root, 'archive', 'continuation-progress'), f.session.id, progressKey);
    const saved = store.read()?.data;
    assert.equal(saved.completedMapPages, undefined);
    assert.equal(saved.next, seqs.length);
    assert.ok(mapCalls <= seqs.length + 1, `expected minimal retries (${mapCalls} <= ${seqs.length + 1})`);
  };

  await runTransientRace({ extraCalls: 2, summaryConcurrency: 2, summaryRetryCount: 1, fastSibling: true });
  await runTransientRace({ extraCalls: 2, summaryConcurrency: 2, summaryRetryCount: 1, fastSibling: false });
  await runTransientRace({ extraCalls: 4, summaryConcurrency: 6, summaryRetryCount: 2, fastSibling: true });

  // Tight extraCalls=1 with a Page-1 retry completes ALL Map pages without false-tripping mid-Map,
  // pauses cleanly before Reduce, and finishes on 1 manual renewal.
  {
    const ft = fixture({
      archiveEnabled: true,
      language: 'en',
      summaryRetryCount: 1,
      summaryRetryDelayMs: 0,
      maxTokens: 1200,
      auditEnabled: false,
      auditBlockOnLoss: false,
      parallelPages: true,
      summaryConcurrency: 2,
      summaryInputMaxBytes: 24000,
      continuationMemoryBytes: 4096,
      maxSummaryChunks: 32,
      windowFallback: 1000000,
      continuationMaxExtraCalls: 1,
    });
    ft.add('system', 'Sys.');
    for (let i = 1; i <= 14; i += 1) {
      ft.add('assistant', `Tight segment ${i}: ` + `payload_${i} `.repeat(380));
    }
    const tSeqs = ft.surface.nodes.slice(1);
    const tCap = await resolveSummaryCapacity(
      { llm: { resolveModelInfo: async () => ({ contextWindow: 1000000, maxTokens: 1200 }) }, logger: { warn() {} } },
      { targets: [{ provider: 'p', model: 'm' }] },
      ft.engine.config,
      signal(),
    );
    let failedOnce = false;
    ft.ctx.llm.stream = async function* (req) {
      ft.calls.push(req);
      const body = req.messages.map((m) => blocksToText(m.content ?? [])).join('\n');
      const m = /page (\d+) of (\d+)/.exec(body);
      if (m) {
        const pageNo = Number(m[1]);
        if (pageNo === 1 && !failedOnce) {
          await delay(30);
          failedOnce = true;
          const err = new Error('HTTP 429 rate limit');
          err.status = 429;
          throw err;
        }
        await delay(5);
        yield { type: 'text-delta', text: mkNotes(pageNo) };
        yield { type: 'finish', kind: 'stop' };
        return;
      }
      yield { type: 'text-delta', text: mkNotes('reduced') };
      yield { type: 'finish', kind: 'stop' };
    };
    let tightErr = null;
    try {
      await prepareContinuation({
        ctx: ft.ctx,
        agent: ft.agent,
        session: ft.session,
        seqs: tSeqs,
        policy: ft.engine.config,
        capacity: tCap,
        chain: { targets: [{ provider: 'p', model: 'm' }] },
        compactionId: 'cmp-tight-1',
        signal: signal(),
        archiveRoot: join(ft.root, 'archive', 'sess-tight'),
        rateLimitCooldownMs: 0,
        parallelContinuation: true,
      });
    } catch (e) {
      tightErr = e;
    }
    assert.equal(tightErr?.code, 'CONTINUATION_CALL_BUDGET');
    assert.ok((tightErr?.continuationProgress?.totalPages ?? 0) >= 3);
    assert.equal(tightErr?.continuationProgress?.acceptedPages, tightErr?.continuationProgress?.totalPages);
    const tResumed = await prepareContinuation({
      ctx: ft.ctx,
      agent: ft.agent,
      session: ft.session,
      seqs: tSeqs,
      policy: ft.engine.config,
      capacity: tCap,
      chain: { targets: [{ provider: 'p', model: 'm' }] },
      compactionId: 'cmp-tight-2',
      signal: signal(),
      archiveRoot: join(ft.root, 'archive', 'sess-tight'),
      manualRetry: true,
      requestId: 'req-tight-renew',
      rateLimitCooldownMs: 0,
      parallelContinuation: true,
    });
    assert.ok(tResumed?.summarized?.summary?.length > 0);
  }

  // Persistent failure on Page 1 must persist completed sibling pages and resume cleanly without rebilling them
  const fp = fixture({
    archiveEnabled: true,
    language: 'en',
    summaryRetryCount: 2,
    summaryRetryDelayMs: 0,
    maxTokens: 1200,
    auditEnabled: false,
    auditBlockOnLoss: false,
    parallelPages: true,
    summaryConcurrency: 4,
    summaryInputMaxBytes: 24000,
    continuationMemoryBytes: 4096,
    maxSummaryChunks: 32,
    windowFallback: 1000000,
    continuationMaxExtraCalls: 1,
  });
  fp.add('system', 'Sys.');
  for (let i = 1; i <= 6; i += 1) {
    fp.add('assistant', `Persistent segment ${i}: ` + `data_${i} `.repeat(380));
  }
  const pSeqs = fp.surface.nodes.slice(1);
  const pCap = await resolveSummaryCapacity(
    { llm: { resolveModelInfo: async () => ({ contextWindow: 1000000, maxTokens: 1200 }) }, logger: { warn() {} } },
    { targets: [{ provider: 'p', model: 'm' }] },
    fp.engine.config,
    signal(),
  );
  let failPage1 = true;
  let progressKey = null;
  const pagesCalledOnResume = [];
  let inResume = false;
  fp.ctx.llm.stream = async function* (req) {
    fp.calls.push(req);
    const body = req.messages.map((m) => blocksToText(m.content ?? [])).join('\n');
    const m = /page (\d+) of (\d+)/.exec(body);
    if (m) {
      const pageNo = Number(m[1]);
      if (inResume) pagesCalledOnResume.push(pageNo);
      if (pageNo === 1 && failPage1) {
        await delay(25);
        yield { type: 'text-delta', text: 'invalid' };
        yield { type: 'finish', kind: 'stop' };
        return;
      }
      await delay(5);
      yield { type: 'text-delta', text: mkNotes(pageNo) };
      yield { type: 'finish', kind: 'stop' };
      return;
    }
    yield { type: 'text-delta', text: mkNotes('final') };
    yield { type: 'finish', kind: 'stop' };
  };
  const errBudget = await (async () => {
    try {
      await prepareContinuation({
        ctx: fp.ctx,
        agent: fp.agent,
        session: fp.session,
        seqs: pSeqs,
        policy: fp.engine.config,
        capacity: pCap,
        chain: { targets: [{ provider: 'p', model: 'm' }] },
        compactionId: 'cmp-persist-1',
        signal: signal(),
        archiveRoot: join(fp.root, 'archive', 'sess-persist'),
        onProgressIdentity: (k) => { progressKey = k; },
        rateLimitCooldownMs: 0,
        parallelContinuation: true,
      });
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.equal(errBudget?.code, 'CONTINUATION_CALL_BUDGET');
  const pStore = new ContinuationProgressStore(join(fp.root, 'archive', 'continuation-progress'), fp.session.id, progressKey);
  const paused = pStore.read()?.data;
  const savedOutOfOrderKeys = Object.keys(paused?.completedMapPages ?? {});
  assert.ok(savedOutOfOrderKeys.length >= 1, `expected completed sibling pages saved, got ${JSON.stringify(paused)}`);
  assert.equal(errBudget.continuationProgress.acceptedPages, savedOutOfOrderKeys.length);

  // Tamper checks on completedMapPages must fail closed with CONTINUATION_PROGRESS_INVALID
  const checkTamperedOutOfOrder = async (mutate) => {
    const cur = pStore.read();
    const copy = structuredClone(cur.data);
    mutate(copy);
    pStore.write(copy, cur.revision);
    await assert.rejects(
      () => prepareContinuation({
        ctx: fp.ctx,
        agent: fp.agent,
        session: fp.session,
        seqs: pSeqs,
        policy: fp.engine.config,
        capacity: pCap,
        chain: { targets: [{ provider: 'p', model: 'm' }] },
        compactionId: 'cmp-tamper',
        signal: signal(),
        archiveRoot: join(fp.root, 'archive', 'sess-persist'),
        parallelContinuation: true,
      }),
      { code: 'CONTINUATION_PROGRESS_INVALID' },
    );
    pStore.write(cur.data, pStore.read().revision);
  };
  await checkTamperedOutOfOrder((d) => { d.completedMapPages['0'] = d.completedMapPages[savedOutOfOrderKeys[0]]; });
  await checkTamperedOutOfOrder((d) => { d.completedMapPages[savedOutOfOrderKeys[0]].receipt.sourceSha256 = '0'.repeat(64); });

  failPage1 = false;
  inResume = true;
  const resumed = await prepareContinuation({
    ctx: fp.ctx,
    agent: fp.agent,
    session: fp.session,
    seqs: pSeqs,
    policy: fp.engine.config,
    capacity: pCap,
    chain: { targets: [{ provider: 'p', model: 'm' }] },
    compactionId: 'cmp-persist-2',
    signal: signal(),
    archiveRoot: join(fp.root, 'archive', 'sess-persist'),
    manualRetry: true,
    requestId: 'req-persist-renew',
    rateLimitCooldownMs: 0,
    parallelContinuation: true,
  });
  assert.ok(resumed?.summarized?.summary?.length > 0);
  for (const key of savedOutOfOrderKeys) {
    assert.equal(pagesCalledOnResume.includes(Number(key) + 1), false, `persisted sibling page ${Number(key) + 1} must not be rebilled`);
  }
});

await test('goal-round3-P1-2-json-escaped-credential-redaction', async () => {
  const apiSecret = ['sk_live_json', 'topsecret', '987654'].join('_');
  const rawApiKey = ['myCustomApiSecret', 'Alpha', '987654'].join('_');
  const awsSecret = ['wJalrXUtnFEMI', 'K7MDENG', 'bPxRfiCYEXAMPLEKEY'].join('/');
  const dbPassword = ['hunter2', 'json', 'pass99'].join('_');
  const basicSecret = 'Basic ' + Buffer.from('audituser:s3cr3tPass!').toString('base64');

  const innerJson = JSON.stringify({
    api_key: rawApiKey,
    aws_secret_access_key: awsSecret,
    password: dbPassword,
    Authorization: basicSecret,
    client_secret: apiSecret,
  });
  const onceEscaped = JSON.stringify({ payload: innerJson });
  const twiceEscaped = JSON.stringify({ wrapped: onceEscaped });

  for (const sample of [onceEscaped, twiceEscaped]) {
    assert.equal(containsSecretCredential(sample), true, `containsSecretCredential failed on escaped sample: ${sample}`);
    const scrubbed = redactCredentials(sample);
    for (const secret of [rawApiKey, awsSecret, dbPassword, basicSecret, apiSecret]) {
      assert.equal(scrubbed.includes(secret), false, `secret leaked after redactCredentials: ${secret}`);
    }
    assert.equal(containsSecretCredential(scrubbed), false, `redacted sample must be clean: ${scrubbed}`);
    const parsed = JSON.parse(scrubbed);
    assert.ok(parsed && typeof parsed === 'object', 'redacted JSON must remain parseable');
  }

  // Escaped placeholders must remain non-secret (zero false positives)
  const cleanEscaped = JSON.stringify({
    payload: JSON.stringify({ api_key: 'null', password: '', client_secret: 'placeholder', aws_secret_access_key: 'short' }),
  });
  assert.equal(containsSecretCredential(cleanEscaped), false);
  assert.equal(redactCredentials(cleanEscaped), cleanEscaped);

  // E2E archive write/read + history_list + history_read + workspace file reinjection
  const f = fixture({ auto: false, archiveEnabled: true });
  const ws = join(f.root, 'ws');
  mkdirSync(join(ws, 'src'), { recursive: true });
  writeFileSync(join(ws, 'src', 'config.ts'), `export const blob = ${onceEscaped};\n`, 'utf8');
  f.session.header.cwd = ws;
  f.add('system', 'Sys.');
  const u1 = f.session.append('assistant/message', {
    message: {
      id: 'm-tc',
      role: 'assistant',
      source: { kind: 'model', provider: 'p', model: 'm' },
      content: [{ type: 'tool-call', id: 'tc-json-1', name: 'write', arguments: JSON.stringify({ path: 'src/config.ts', content: innerJson }) }],
    },
  }, { surfaceOp: 'append' });
  const t2 = f.session.append('tool/result', {
    message: {
      id: 'm-tr',
      role: 'tool',
      toolCallId: 'tc-json-1',
      source: { kind: 'tool-result', callId: 'tc-json-1' },
      content: [{ type: 'text', text: 'wrote file' }],
    },
  }, { surfaceOp: 'append' });

  const arch = new CompactionArchive({ root: join(f.root, 'arch-json') });
  const written = await arch.writeSpan({
    sessionId: f.session.id,
    compactionId: 'cmp-json-redact',
    entries: spanEntries(f.session, [u1.seq, t2.seq]),
  });
  assert.ok(written);
  const spanRead = await arch.readSpan(f.session.id, 'cmp-json-redact');
  const serializedSpan = JSON.stringify(spanRead);
  for (const secret of [rawApiKey, awsSecret, dbPassword, basicSecret, apiSecret]) {
    assert.equal(serializedSpan.includes(secret), false, `archive leaked ${secret}`);
  }
  const indexRaw = fs.readFileSync(join(arch.dirFor(f.session.id), 'index.jsonl'), 'utf8');
  for (const secret of [rawApiKey, awsSecret, dbPassword, basicSecret, apiSecret]) {
    assert.equal(indexRaw.includes(secret), false, `index.jsonl leaked ${secret}`);
  }
  const reinj = collectActiveWorkspaceFiles({
    session: f.session,
    shadowedSeqs: [u1.seq, t2.seq],
    workspaceRoots: [ws],
  });
  for (const secret of [rawApiKey, awsSecret, dbPassword, basicSecret, apiSecret]) {
    assert.equal(reinj.text.includes(secret), false, `reinject leaked ${secret}`);
  }
});

await test('goal-round3-P1-3-compound-provenance-same-verb-and-laundering', async () => {
  // Same-verb compound approval + single partial revocation (ZH & EN) must allow surviving approval
  const sameVerbPublish = auditInstructionProvenance({
    userMessages: [
      { seq: 1, text: '我已批准发布 alpha-svc 到 staging 并且发布 beta-svc 到 staging。' },
      { seq: 2, text: '取消发布 beta-svc 到 staging。' },
    ],
    summaryText: [
      '## 1. Primary Request and Intent',
      '用户已批准发布 alpha-svc 到 staging。',
      '## 6. All User Messages',
      '1. 我已批准发布 alpha-svc 到 staging 并且发布 beta-svc 到 staging。',
      '2. 取消发布 beta-svc 到 staging。',
    ].join('\n'),
  });
  assert.deepEqual(sameVerbPublish, []);

  const sameVerbEn = auditInstructionProvenance({
    userMessages: [
      { seq: 1, text: 'I approve deploying alpha-svc and deploying beta-svc.' },
      { seq: 2, text: 'Cancel deploying beta-svc.' },
    ],
    summaryText: '## 1. Primary Request and Intent\nThe user approved deploying alpha-svc.\n## 6. All User Messages\nRecorded.',
  });
  assert.deepEqual(sameVerbEn, []);

  // Compound permission laundering must be blocked with revokedMatch: true
  const launderingRevoke = auditInstructionProvenance({
    userMessages: [
      { seq: 1, text: '我已批准部署 alpha-svc 到 staging 并且测试 beta-svc。' },
      { seq: 2, text: '取消测试 beta-svc。' },
    ],
    summaryText: '## 1. Primary Request and Intent\n用户已批准部署 alpha-svc 到 staging 并且测试 beta-svc。\n## 6. All User Messages\n已记录。',
  });
  assert.ok(launderingRevoke.length >= 1 && launderingRevoke[0].revokedMatch === true, `expected revokedMatch block on launderingRevoke, got ${JSON.stringify(launderingRevoke)}`);

  const launderingRetired = auditInstructionProvenance({
    userMessages: [{ seq: 1, text: '我已批准读取 logs 并且检查 metrics。' }],
    retiredDecisions: [{ reason: 'cancelled', seq: 1, by: 2, text: '检查 metrics' }],
    summaryText: '## 1. Primary Request and Intent\n用户已批准读取 logs 并且检查 metrics。\n## 6. All User Messages\n已记录。',
  });
  assert.ok(launderingRetired.length >= 1 && launderingRetired[0].revokedMatch === true, `expected revokedMatch block on launderingRetired, got ${JSON.stringify(launderingRetired)}`);

  // Outer scope qualifier must carry onto surviving compound sibling without leaking into prod
  const scopedOk = auditInstructionProvenance({
    userMessages: [
      { seq: 1, text: '我已批准在 staging 环境下部署 alpha-svc 并且测试 beta-svc。' },
      { seq: 2, text: '取消测试 beta-svc。' },
    ],
    summaryText: '## 1. Primary Request and Intent\n在 staging 环境下用户已批准部署 alpha-svc。\n## 6. All User Messages\n已记录。',
  });
  assert.deepEqual(scopedOk, []);
  const scopedEscalate = auditInstructionProvenance({
    userMessages: [
      { seq: 1, text: '我已批准在 staging 环境下部署 alpha-svc 并且测试 beta-svc。' },
      { seq: 2, text: '取消测试 beta-svc。' },
    ],
    summaryText: '## 1. Primary Request and Intent\n在 prod 环境下用户已批准部署 alpha-svc。\n## 6. All User Messages\n已记录。',
  });
  assert.ok(scopedEscalate.length >= 1);

  // E2E compactRegion under default auditExhaustionPolicy: 'fallback' commits surviving approval cleanly
  const f = fixture({ language: 'zh-CN', summaryRetryCount: 0, summaryRetryDelayMs: 0 });
  const pad = 'Work log observation line verified cleanly. '.repeat(220);
  f.add('system', 'System rules.');
  const m1 = f.add('user', '我已批准发布 alpha-svc 到 staging 并且发布 beta-svc 到 staging。');
  f.add('assistant', pad);
  f.add('user', '取消发布 beta-svc 到 staging。');
  const m4 = f.add('assistant', pad);
  f.session.append('turn/start', { turn: 1 });
  f.add('user', 'Continue checking status.');
  const validSummary = [
    '## 1. Primary Request and Intent',
    '用户已批准发布 alpha-svc 到 staging。',
    '## 2. Key Technical Concepts',
    'Staging deployment scope narrowed to alpha-svc.',
    '## 3. Files and Code Sections',
    'None.',
    '## 4. Errors and Fixes',
    'None.',
    '## 5. Problem Solving',
    'Retained active approval for alpha-svc.',
    '## 6. All User Messages',
    '- seq 1: 我已批准发布 alpha-svc 到 staging 并且发布 beta-svc 到 staging。',
    '- seq 3: 取消发布 beta-svc 到 staging。',
    '## 7. Pending Tasks',
    'Proceed with alpha-svc staging release.',
    '## 8. Work Completed',
    'Observation checked.',
    '## 9. Context for Continuing Work',
    'Deploy alpha-svc to staging.',
  ].join('\n');
  f.ctx.llm.stream = async function* (req) {
    f.calls.push(req);
    yield { type: 'text-delta', text: validSummary };
    yield { type: 'finish', kind: 'stop' };
  };
  const committed = await f.engine.compactRegion(m1.seq, m4.seq, f.agent);
  assert.ok(committed?.compactionId, `expected compactRegion to commit, got ${JSON.stringify(committed)}`);
});

await test('goal-round3-codex-all-5-p1-and-p2-guards', async () => {
  // 1. P1-1 & P2-1 (lib/redact.js): embedded escaped quotes + depth-2 + 2-backslash delim + linear O(N) runtime
  const embedded = JSON.stringify({ payload: JSON.stringify({ password: 'first"second_secret987' }) });
  assert.equal(containsSecretCredential(embedded), true);
  const redactedEmb = redactCredentials(embedded);
  assert.equal(redactedEmb.includes('second_secret987'), false, redactedEmb);
  assert.equal(containsSecretCredential(redactedEmb), false, redactedEmb);
  assert.equal(JSON.parse(JSON.parse(redactedEmb).payload).password, '[redacted]');

  const twoSlash = 'log payload \\\\"api_key\\\\":\\\\"myTwoSlashSecret99\\\\" done';
  assert.equal((twoSlash.match(/\\\\"/g) ?? []).length, 4);
  assert.equal(containsSecretCredential(twoSlash), true);
  const redactedTwo = redactCredentials(twoSlash);
  assert.equal(redactedTwo.includes('myTwoSlashSecret99'), false);
  assert.equal(containsSecretCredential(redactedTwo), false);

  for (const bs of ['\\', '\\\\', '\\\\\\\\']) {
    const sample = `PASSWORD=${bs}VerySecret99`;
    assert.equal(containsSecretCredential(sample), true, sample);
    const red = redactCredentials(sample);
    assert.equal(red.includes('VerySecret99'), false, red);
    assert.equal(containsSecretCredential(red), false, red);
    assert.equal(redactErrorText(sample).includes('VerySecret99'), false);
  }
  for (const paddedStructured of [`password=[${' '.repeat(24)}"x"]`, `password={${' '.repeat(24)}"a": 1}`]) {
    assert.equal(containsSecretCredential(paddedStructured), false, paddedStructured);
    assert.equal(redactCredentials(paddedStructured), paddedStructured);
  }

  for (const adv of ['a.'.repeat(20000) + 'z', 'a_'.repeat(20000) + 'z']) {
    const t0 = performance.now();
    assert.equal(containsSecretCredential(adv), false);
    assert.equal(redactCredentials(adv), adv);
    assert.ok(performance.now() - t0 < 150, `linear scan exceeded 150ms`);
  }

  // 2. P1-2: Compound revocation revokes EVERY matching child & blocks all individual/combined claims
  for (const claim of [
    '## 1. Primary Request and Intent\nThe user approved deploying alpha-svc.\n## 6. All User Messages\nRecorded.',
    '## 1. Primary Request and Intent\nThe user approved deploying beta-svc.\n## 6. All User Messages\nRecorded.',
    '## 1. Primary Request and Intent\nThe user approved deploying alpha-svc and deploying beta-svc.\n## 6. All User Messages\nRecorded.',
  ]) {
    const res = auditInstructionProvenance({
      userMessages: [
        { seq: 1, text: 'I approve deploying alpha-svc and deploying beta-svc.' },
        { seq: 2, text: 'Cancel deploying alpha-svc and deploying beta-svc.' },
      ],
      summaryText: claim,
    });
    assert.ok(res.length >= 1 && res[0].revokedMatch === true, `compound revoke failed for ${claim}: ${JSON.stringify(res)}`);
  }

  // 3. P1-3: Ordinary English modifiers ("any", "immediately") never defeat revocation matching
  const anyLogs = auditInstructionProvenance({
    userMessages: [
      { seq: 1, text: 'I approve deleting logs.' },
      { seq: 2, text: 'Do not delete any logs.' },
    ],
    summaryText: '## 1. Primary Request and Intent\nThe user approved deleting logs.\n## 6. All User Messages\nRecorded.',
  });
  assert.ok(anyLogs.length >= 1 && anyLogs[0].revokedMatch === true, `anyLogs: ${JSON.stringify(anyLogs)}`);

  const immDeploy = auditInstructionProvenance({
    userMessages: [
      { seq: 1, text: 'I approve deploying alpha-svc.' },
      { seq: 2, text: 'Cancel deploying alpha-svc immediately.' },
    ],
    summaryText: '## 1. Primary Request and Intent\nThe user approved deploying alpha-svc.\n## 6. All User Messages\nRecorded.',
  });
  assert.ok(immDeploy.length >= 1 && immDeploy[0].revokedMatch === true, `immDeploy: ${JSON.stringify(immDeploy)}`);

  // 4. P1-4 & P2-1: Shared leading qualifier without 下/中/里 and compound revocation scope propagation
  for (const [grantText, okSummary, badSummary] of [
    ['我已批准在 staging 部署 alpha-svc 并且部署 beta-svc。', '用户已批准在 staging 部署 beta-svc。', '用户已批准部署 beta-svc。'],
    ['我已批准在生产环境部署 alpha-svc 并且部署 beta-svc。', '用户已批准在生产环境部署 beta-svc。', '用户已批准部署 beta-svc。'],
    ['我已批准仅限 staging 环境部署 alpha-svc 并且部署 beta-svc。', '用户已批准仅限 staging 环境部署 beta-svc。', '用户已批准部署 beta-svc。'],
  ]) {
    const badRes = auditInstructionProvenance({
      userMessages: [
        { seq: 1, text: grantText },
        { seq: 2, text: '取消部署 alpha-svc。' },
      ],
      summaryText: `## 1. Primary Request and Intent\n${badSummary}\n## 6. All User Messages\n已记录。`,
    });
    assert.ok(badRes.length >= 1, `missing scope block for: ${grantText}`);
    const okRes = auditInstructionProvenance({
      userMessages: [
        { seq: 1, text: grantText },
        { seq: 2, text: '取消部署 alpha-svc。' },
      ],
      summaryText: `## 1. Primary Request and Intent\n${okSummary}\n## 6. All User Messages\n已记录。`,
    });
    assert.deepEqual(okRes, [], `unexpected block for: ${grantText}: ${JSON.stringify(okRes)}`);
  }

  const scopedRevokeProdPreserved = auditInstructionProvenance({
    userMessages: [
      { seq: 1, text: 'I approve deploying beta-svc in production.' },
      { seq: 2, text: 'Cancel in staging deploying alpha-svc and deploying beta-svc.' },
    ],
    summaryText: '## 1. Primary Request and Intent\nThe user approved deploying beta-svc in production.\n## 6. All User Messages\nRecorded.',
  });
  assert.deepEqual(scopedRevokeProdPreserved, [], `staging compound cancel must preserve production approval: ${JSON.stringify(scopedRevokeProdPreserved)}`);

  // 5. P1-5, P1-3(follow-up), P1-4(follow-up) & P2-2:
  //    (a) Rejected pre-renewal completed stream (validated=false) NOT miscounted as pre-grant acceptance;
  //    (b) Tampered/lowered grant.accepted rejected AFTER buffer drains into state.receipts;
  //    (c) Cleared calls rejected;
  //    (d) Late worker settlement after abortPool/poolExited never mutates saved progress.
  const mkStateWithGrant = (grantOverrides = {}, stripKeys = [], clearCalls = false, drained = false) => ({
    segments: [[0], [1], [2]],
    next: drained ? 3 : 0,
    memory: drained ? notes : '',
    last: null,
    receipts: drained
      ? [
          { page: 0, sourceBytes: 10, sourceSha256: '0'.repeat(64), memoryBytes: 10, callCount: 5 },
          { page: 1, sourceBytes: 10, sourceSha256: 'a'.repeat(64), memoryBytes: 10, callCount: 3 },
          { page: 2, sourceBytes: 10, sourceSha256: 'b'.repeat(64), memoryBytes: 10, callCount: 4 },
        ]
      : [],
    mode: 'map-reduce',
    pageNotes: drained ? [notes, notes, notes] : [],
    reduced: false,
    ...(drained
      ? {}
      : {
          completedMapPages: {
            1: { rawText: notes, receipt: { page: 1, sourceBytes: 10, sourceSha256: 'a'.repeat(64), memoryBytes: 10, callCount: 3 } },
            2: { rawText: notes, receipt: { page: 2, sourceBytes: 10, sourceSha256: 'b'.repeat(64), memoryBytes: 10, callCount: 4 } },
          },
        }),
    calls: clearCalls
      ? []
      : [
          { page: 0, phase: 'map', completed: false, endedAt: '2026-11-28T00:00:01.000Z' },
          { page: 0, phase: 'map', completed: false, endedAt: '2026-11-28T00:00:02.000Z' },
          { page: 1, phase: 'map', completed: true, endedAt: '2026-11-28T00:00:03.000Z' },
          { page: 2, phase: 'map', completed: true, endedAt: '2026-11-28T00:00:04.000Z' },
          ...(drained ? [{ page: 0, phase: 'map', completed: true, endedAt: '2026-11-28T00:00:06.000Z' }] : []),
        ],
    budgetGrants: [
      (() => {
        const g = {
          version: 2,
          calls: 4,
          next: 0,
          accepted: 2,
          requestId: 'req-1',
          at: '2026-11-28T00:00:05.000Z',
          ...grantOverrides,
        };
        for (const k of stripKeys) delete g[k];
        return g;
      })(),
    ],
  });
  assert.throws(() => continuationCallBudget(mkStateWithGrant({}, ['accepted']), 1), { code: 'CONTINUATION_PROGRESS_INVALID' });
  assert.throws(() => continuationCallBudget(mkStateWithGrant({}, ['version', 'accepted']), 1), { code: 'CONTINUATION_PROGRESS_INVALID' });
  assert.throws(() => continuationCallBudget(mkStateWithGrant({ accepted: 1 }), 1), { code: 'CONTINUATION_PROGRESS_INVALID' });
  assert.throws(() => continuationCallBudget(mkStateWithGrant({}, [], true), 1), { code: 'CONTINUATION_PROGRESS_INVALID' });
  assert.doesNotThrow(() => continuationCallBudget(mkStateWithGrant(), 1).assertAvailable());
  // After buffer drained into state.receipts: lowering/removing grant.accepted STILL fails closed!
  assert.throws(() => continuationCallBudget(mkStateWithGrant({ accepted: 0 }, [], false, true), 1), { code: 'CONTINUATION_PROGRESS_INVALID' });
  assert.throws(() => continuationCallBudget(mkStateWithGrant({}, ['version', 'accepted'], false, true), 1), { code: 'CONTINUATION_PROGRESS_INVALID' });
  assert.doesNotThrow(() => continuationCallBudget(mkStateWithGrant({}, [], false, true), 1).assertAvailable());

  // 5b. Rejected stream (completed=true, validate failed) before renewal -> succeeds after renewal -> legitimate resume must succeed!
  {
    const mkNotes = (n) => `## Goal\nGoal p${n}\n\n## State\nState p${n}\n\n## Next\nNext p${n}\n\n## Uncertain\nNone.`;
    const fr = fixture({
      archiveEnabled: true,
      language: 'en',
      summaryRetryCount: 2,
      summaryRetryDelayMs: 0,
      maxTokens: 1200,
      auditEnabled: false,
      auditBlockOnLoss: false,
      parallelPages: true,
      summaryConcurrency: 2,
      summaryInputMaxBytes: 24000,
      continuationMemoryBytes: 4096,
      maxSummaryChunks: 32,
      windowFallback: 1000000,
      continuationMaxExtraCalls: 1,
    });
    fr.add('system', 'Sys.');
    for (let i = 1; i <= 6; i += 1) fr.add('assistant', `Rej seg ${i}: ` + `val_${i} `.repeat(380));
    const rSeqs = fr.surface.nodes.slice(1);
    const rCap = await resolveSummaryCapacity(
      { llm: { resolveModelInfo: async () => ({ contextWindow: 1000000, maxTokens: 1200 }) }, logger: { warn() {} } },
      { targets: [{ provider: 'p', model: 'm' }] },
      fr.engine.config,
      signal(),
    );
    let rejectPhase = 'all-invalid';
    let rProgKey = null;
    fr.ctx.llm.stream = async function* (req) {
      fr.calls.push(req);
      const body = req.messages.map((m) => blocksToText(m.content ?? [])).join('\n');
      const m = /page (\d+) of (\d+)/.exec(body);
      if (!m) {
        yield { type: 'text-delta', text: mkNotes('reduce') };
        yield { type: 'finish', kind: 'stop' };
        return;
      }
      const pNo = Number(m[1]);
      if (rejectPhase === 'all-invalid') {
        yield { type: 'text-delta', text: 'bad missing headings' };
        yield { type: 'finish', kind: 'stop' };
        return;
      }
      if (rejectPhase === 'page1-fail-rest-ok' && pNo === 1) {
        await delay(25);
        yield { type: 'text-delta', text: 'still invalid on p1' };
        yield { type: 'finish', kind: 'stop' };
        return;
      }
      await delay(5);
      yield { type: 'text-delta', text: mkNotes(pNo) };
      yield { type: 'finish', kind: 'stop' };
    };
    await assert.rejects(
      () => prepareContinuation({
        ctx: fr.ctx,
        agent: fr.agent,
        session: fr.session,
        seqs: rSeqs,
        policy: fr.engine.config,
        capacity: rCap,
        chain: { targets: [{ provider: 'p', model: 'm' }] },
        compactionId: 'cmp-rej-1',
        signal: signal(),
        archiveRoot: join(fr.root, 'archive', 'sess-rej'),
        onProgressIdentity: (k) => { rProgKey = k; },
        rateLimitCooldownMs: 0,
        parallelContinuation: true,
      }),
      { code: 'CONTINUATION_CALL_BUDGET' },
    );
    rejectPhase = 'page1-fail-rest-ok';
    await assert.rejects(
      () => prepareContinuation({
        ctx: fr.ctx,
        agent: fr.agent,
        session: fr.session,
        seqs: rSeqs,
        policy: fr.engine.config,
        capacity: rCap,
        chain: { targets: [{ provider: 'p', model: 'm' }] },
        compactionId: 'cmp-rej-2',
        signal: signal(),
        archiveRoot: join(fr.root, 'archive', 'sess-rej'),
        manualRetry: true,
        requestId: 'req-rej-2',
        rateLimitCooldownMs: 0,
        parallelContinuation: true,
      }),
      { code: 'CONTINUATION_CALL_BUDGET' },
    );
    rejectPhase = 'all-ok';
    const doneRej = await prepareContinuation({
      ctx: fr.ctx,
      agent: fr.agent,
      session: fr.session,
      seqs: rSeqs,
      policy: fr.engine.config,
      capacity: rCap,
      chain: { targets: [{ provider: 'p', model: 'm' }] },
      compactionId: 'cmp-rej-3',
      signal: signal(),
      archiveRoot: join(fr.root, 'archive', 'sess-rej'),
      manualRetry: true,
      requestId: 'req-rej-3',
      rateLimitCooldownMs: 0,
      parallelContinuation: true,
    });
    assert.ok(doneRej?.summarized?.summary?.length > 0);
    assert.ok(new ContinuationProgressStore(join(fr.root, 'archive', 'continuation-progress'), fr.session.id, rProgKey).read()?.data?.reduced === true);
  }
});

await test('goal-round3-codex-followup-4-p1-and-2-p2-guards', async () => {
  // 1. P1-1: Action verbs ("testing" / "测试") must NOT suppress inherited leading scope
  assert.ok(
    auditInstructionProvenance({
      userMessages: [{ seq: 1, text: 'I approve in staging deploying alpha-svc and testing beta-svc.' }],
      summaryText: '## 1. Primary Request and Intent\nThe user approved testing beta-svc.\n## 6. All User Messages\nRecorded.',
    }).length >= 1,
    'EN action verb testing must not strip inherited staging qualifier',
  );
  assert.deepEqual(
    auditInstructionProvenance({
      userMessages: [{ seq: 1, text: 'I approve in staging deploying alpha-svc and testing beta-svc.' }],
      summaryText: '## 1. Primary Request and Intent\nThe user approved testing beta-svc in staging.\n## 6. All User Messages\nRecorded.',
    }),
    [],
  );
  assert.ok(
    auditInstructionProvenance({
      userMessages: [
        { seq: 1, text: '我已批准在 staging 部署 alpha-svc 并且测试 beta-svc。' },
        { seq: 2, text: '取消部署 alpha-svc。' },
      ],
      summaryText: '## 1. Primary Request and Intent\n用户已批准测试 beta-svc。\n## 6. All User Messages\n已记录。',
    }).length >= 1,
    'CN action verb 测试 must not strip inherited staging qualifier',
  );
  assert.deepEqual(
    auditInstructionProvenance({
      userMessages: [
        { seq: 1, text: 'I approve testing beta-svc in production.' },
        { seq: 2, text: 'Cancel in staging deploying alpha-svc and testing beta-svc.' },
      ],
      summaryText: '## 1. Primary Request and Intent\nThe user approved testing beta-svc in production.\n## 6. All User Messages\nRecorded.',
    }),
    [],
  );

  // 2. P1-2: Chinese development scope ("在开发环境") preserved across surviving compound children
  assert.ok(
    auditInstructionProvenance({
      userMessages: [
        { seq: 1, text: '我已批准在开发环境部署 alpha-svc 并且部署 beta-svc。' },
        { seq: 2, text: '取消部署 alpha-svc。' },
      ],
      summaryText: '## 1. Primary Request and Intent\n用户已批准部署 beta-svc。\n## 6. All User Messages\n已记录。',
    }).length >= 1,
  );
  assert.deepEqual(
    auditInstructionProvenance({
      userMessages: [
        { seq: 1, text: '我已批准在开发环境部署 alpha-svc 并且部署 beta-svc。' },
        { seq: 2, text: '取消部署 alpha-svc。' },
      ],
      summaryText: '## 1. Primary Request and Intent\n用户已批准在开发环境部署 beta-svc。\n## 6. All User Messages\n已记录。',
    }),
    [],
  );

  // 3. P1-3: Hyphenated & nested parenthetical commentary never defeats explicit revocation
  for (const revLine of [
    'Do not deploy alpha-svc (non-negotiable).',
    'Do not deploy alpha-svc (non-negotiable and urgent).',
    'Do not deploy alpha-svc (non-negotiable; urgent).',
    'Do not deploy alpha-svc (non-negotiable (urgent; now)).',
    'Do not deploy alpha-svc (non-negotiable (urgent',
  ]) {
    const revOut = auditInstructionProvenance({
      userMessages: [
        { seq: 1, text: 'I approve deploying alpha-svc.' },
        { seq: 2, text: revLine },
      ],
      summaryText: '## 1. Primary Request and Intent\nThe user approved deploying alpha-svc.\n## 6. All User Messages\nRecorded.',
    });
    assert.ok(revOut.length >= 1 && revOut[0].revokedMatch === true, `failed for ${revLine}: ${JSON.stringify(revOut)}`);
  }
  assert.ok(
    auditInstructionProvenance({
      userMessages: [
        { seq: 1, text: 'I approve in staging deploying alpha-svc.' },
        { seq: 2, text: 'Do not deploy alpha-svc (only in staging (non-negotiable; urgent)).' },
      ],
      summaryText: '## 1. Primary Request and Intent\nThe user approved deploying alpha-svc in staging.\n## 6. All User Messages\nRecorded.',
    })[0]?.revokedMatch === true,
    'qualifying outer paren must survive nested non-qualifying semicolon revocation commentary',
  );

  assert.ok(
    auditInstructionProvenance({
      userMessages: [
        { seq: 1, text: 'I approve in staging deploying alpha-svc.' },
        { seq: 2, text: 'Do not deploy alpha-svc (only in staging (non-negotiable).' },
      ],
      summaryText: '## 1. Primary Request and Intent\nThe user approved deploying alpha-svc in staging.\n## 6. All User Messages\nRecorded.',
    })[0]?.revokedMatch === true,
    'mixed closed non-qualifying paren inside unclosed qualifying outer paren must not defeat revocation',
  );
  {
    const deepT0 = performance.now();
    const deepOut = auditInstructionProvenance({
      userMessages: [
        { seq: 1, text: 'I approve deploying alpha-svc in staging.' },
        { seq: 2, text: 'Do not deploy alpha-svc ' + '(only in staging '.repeat(28) },
      ],
      summaryText: '## 1. Primary Request and Intent\nThe user approved deploying alpha-svc in staging.\n## 6. All User Messages\nRecorded.',
    });
    const deepMs = performance.now() - deepT0;
    assert.ok(deepMs < 200, `deep unclosed qualifying parens took ${deepMs.toFixed(1)}ms`);
    assert.ok(deepOut.length >= 1 && deepOut[0].revokedMatch === true);
  }
  {
    const balT0 = performance.now();
    const balOut = auditInstructionProvenance({
      userMessages: [
        { seq: 1, text: 'I approve deploying alpha-svc in staging.' },
        { seq: 2, text: 'Do not deploy alpha-svc ' + '('.repeat(10000) + 'staging' + ')'.repeat(10000) },
      ],
      summaryText: '## 1. Primary Request and Intent\nThe user approved deploying alpha-svc in staging.\n## 6. All User Messages\nRecorded.',
    });
    const balMs = performance.now() - balT0;
    assert.ok(balMs < 500, `deep balanced parens took ${balMs.toFixed(1)}ms`);
    assert.ok(balOut.length >= 1 && balOut[0].revokedMatch === true);
  }
  for (const parenLead of ['(only in staging)', '(only in staging (urgent))', '((only in staging))', '(urgent) (only in staging)']) {
    assert.ok(
      auditInstructionProvenance({
        userMessages: [
          { seq: 1, text: `I approve ${parenLead} deleting alpha-db and deleting beta-db.` },
        ],
        summaryText: '## 1. Primary Request and Intent\nThe user approved deleting beta-db.\n## 6. All User Messages\nRecorded.',
      }).length >= 1,
      `parenthesized leading scope ${parenLead} must propagate to compound siblings and block unscoped summary`,
    );
    assert.deepEqual(
      auditInstructionProvenance({
        userMessages: [
          { seq: 1, text: `I approve ${parenLead} deleting alpha-db and deleting beta-db.` },
          { seq: 2, text: 'Cancel deleting alpha-db.' },
        ],
        summaryText: '## 1. Primary Request and Intent\nThe user approved deleting beta-db only in staging.\n## 6. All User Messages\nRecorded.',
      }),
      [],
    );
  }
  for (const envName of ['dev', 'test', 'local']) {
    assert.ok(
      auditInstructionProvenance({
        userMessages: [
          { seq: 1, text: `I approve in staging deleting alpha-db and deleting beta-db in ${envName} only.` },
        ],
        summaryText: '## 1. Primary Request and Intent\nThe user approved deleting beta-db.\n## 6. All User Messages\nRecorded.',
      }).length >= 1,
      `explicit override in ${envName} only must require ${envName} preservation in summary`,
    );
    assert.deepEqual(
      auditInstructionProvenance({
        userMessages: [
          { seq: 1, text: `I approve in staging deleting alpha-db and deleting beta-db in ${envName} only.` },
        ],
        summaryText: `## 1. Primary Request and Intent\nThe user approved deleting beta-db in ${envName} only.\n## 6. All User Messages\nRecorded.`,
      }),
      [],
    );
  }

  // 3b. Final-6Astra P1-1: identifier-like tokens (including unquoted dotted production.checks) must NOT suppress inherited staging scope
  for (const idToken of ['production-checks', 'production/checks', '`production.checks`', 'production.checks', 'checks:production']) {
    assert.ok(
      auditInstructionProvenance({
        userMessages: [
          { seq: 1, text: `I approve in staging deploying alpha-svc and testing ${idToken}.` },
          { seq: 2, text: 'Cancel deploying alpha-svc.' },
        ],
        summaryText: `## 1. Primary Request and Intent\nThe user approved testing ${idToken} in production.\n## 6. All User Messages\nRecorded.`,
      }).length >= 1,
      `${idToken} must retain inherited staging scope and reject escalation to production`,
    );
    assert.deepEqual(
      auditInstructionProvenance({
        userMessages: [
          { seq: 1, text: `I approve in staging deploying alpha-svc and testing ${idToken}.` },
          { seq: 2, text: 'Cancel deploying alpha-svc.' },
        ],
        summaryText: `## 1. Primary Request and Intent\nThe user approved testing ${idToken} in staging.\n## 6. All User Messages\nRecorded.`,
      }),
      [],
      `${idToken} must stay accepted when summary keeps staging scope`,
    );
  }
  for (const idToken of ['production-checks', 'production.checks']) {
    assert.deepEqual(
      auditInstructionProvenance({
        userMessages: [
          { seq: 1, text: `I approve testing ${idToken} in production.` },
          { seq: 2, text: `Cancel in staging deploying alpha-svc and testing ${idToken}.` },
        ],
        summaryText: `## 1. Primary Request and Intent\nThe user approved testing ${idToken} in production.\n## 6. All User Messages\nRecorded.`,
      }),
      [],
      `compound staging revocation containing ${idToken} must not revoke production grant`,
    );
  }

  // 4. P2-1: Malformed grant.next (-1e20) fails immediately in O(1) without infinite loop
  assert.throws(
    () => continuationCallBudget({
      segments: [[0], [1], [2]],
      next: 0,
      receipts: [],
      calls: [{ page: 0, phase: 'map', completed: false }],
      budgetGrants: [{ calls: 1, next: -1e20, requestId: 'bad-grant' }],
    }, 1),
    { code: 'CONTINUATION_PROGRESS_INVALID' },
  );

  // 5. P1-4 & P2-2: Drained receipt callCount tamper, provenance-invalid buffered note, and late worker settlement after pool exit
  const mkNotes = (n) => `## Goal\nGoal d${n}\n\n## State\nState d${n}\n\n## Next\nNext d${n}\n\n## Uncertain\nNone.`;
  const fd = fixture({
    archiveEnabled: true,
    language: 'en',
    summaryRetryCount: 2,
    summaryRetryDelayMs: 0,
    maxTokens: 1200,
    auditEnabled: true,
    auditBlockOnLoss: true,
    auditProvenanceBlock: true,
    parallelPages: true,
    summaryConcurrency: 4,
    summaryInputMaxBytes: 24000,
    continuationMemoryBytes: 4096,
    maxSummaryChunks: 32,
    windowFallback: 1000000,
    continuationMaxExtraCalls: 1,
  });
  fd.add('system', 'Sys.');
  fd.add('user', 'Keep database offline.');
  for (let i = 1; i <= 5; i += 1) fd.add('assistant', `Drained seg ${i}: ` + `entry_${i} `.repeat(380));
  const dSeqs = fd.surface.nodes.slice(1);
  const dCap = await resolveSummaryCapacity(
    { llm: { resolveModelInfo: async () => ({ contextWindow: 1000000, maxTokens: 1200 }) }, logger: { warn() {} } },
    { targets: [{ provider: 'p', model: 'm' }] },
    fd.engine.config,
    signal(),
  );
  let phase = 'fail-page1';
  let dProgKey = null;
  fd.ctx.llm.stream = async function* (req) {
    fd.calls.push(req);
    const body = req.messages.map((m) => blocksToText(m.content ?? [])).join('\n');
    const m = /page (\d+) of (\d+)/.exec(body);
    if (!m) {
      yield { type: 'text-delta', text: '## Goal\nKeep database offline.\n\n## State\nMerged.\n\n## Next\nContinue.\n\n## Uncertain\nNone.' };
      yield { type: 'finish', kind: 'stop' };
      return;
    }
    const pNo = Number(m[1]);
    if (phase === 'fail-page1' && pNo === 1) {
      await delay(25);
      yield { type: 'text-delta', text: 'bad missing sections' };
      yield { type: 'finish', kind: 'stop' };
      return;
    }
    if (phase === 'fail-last-page' && pNo > 1) {
      await delay(25);
      const err = new Error('HTTP 401 unauthorized');
      err.status = 401;
      throw err;
    }
    if (phase === 'fail-reduce') {
      await delay(10);
      yield { type: 'text-delta', text: `## Goal\nKeep database offline.\n\n## State\nPage ${pNo}.\n\n## Next\nContinue.\n\n## Uncertain\nNone.` };
      yield { type: 'finish', kind: 'stop' };
      return;
    }
    await delay(5);
    yield { type: 'text-delta', text: `## Goal\nKeep database offline.\n\n## State\nPage ${pNo}.\n\n## Next\nContinue.\n\n## Uncertain\nNone.` };
    yield { type: 'finish', kind: 'stop' };
  };
  await assert.rejects(
    () => prepareContinuation({
      ctx: fd.ctx,
      agent: fd.agent,
      session: fd.session,
      seqs: dSeqs,
      policy: fd.engine.config,
      capacity: dCap,
      chain: { targets: [{ provider: 'p', model: 'm' }] },
      compactionId: 'cmp-drain-1',
      signal: signal(),
      archiveRoot: join(fd.root, 'archive', 'sess-drain'),
      onProgressIdentity: (k) => { dProgKey = k; },
      rateLimitCooldownMs: 0,
      parallelContinuation: true,
    }),
    { code: 'CONTINUATION_CALL_BUDGET' },
  );
  const dStore = new ContinuationProgressStore(join(fd.root, 'archive', 'continuation-progress'), fd.session.id, dProgKey);
  const beforeProv = dStore.read();
  const bufKey = Object.keys(beforeProv.data.completedMapPages)[0];
  assert.ok(bufKey, 'expected buffered page before provenance-tamper check');

  // Provenance-invalid buffered note with auditing enabled must fail closed with 0 LLM calls
  const callsBeforeProvTamper = fd.calls.length;
  const badProvCopy = structuredClone(beforeProv.data);
  badProvCopy.completedMapPages[bufKey].rawText =
    '## Goal\nThe user approved dropping the database.\n\n## State\nKeep database offline.\n\n## Next\nContinue.\n\n## Uncertain\nNone.';
  badProvCopy.completedMapPages[bufKey].receipt.memoryBytes = Buffer.byteLength(badProvCopy.completedMapPages[bufKey].rawText, 'utf8');
  dStore.write(badProvCopy, beforeProv.revision);
  await assert.rejects(
    () => prepareContinuation({
      ctx: fd.ctx,
      agent: fd.agent,
      session: fd.session,
      seqs: dSeqs,
      policy: fd.engine.config,
      capacity: dCap,
      chain: { targets: [{ provider: 'p', model: 'm' }] },
      compactionId: 'cmp-drain-prov-tamper',
      signal: signal(),
      archiveRoot: join(fd.root, 'archive', 'sess-drain'),
      manualRetry: true,
      requestId: 'req-drain-prov',
      parallelContinuation: true,
    }),
    { code: 'CONTINUATION_PROGRESS_INVALID' },
  );
  assert.equal(fd.calls.length, callsBeforeProvTamper);
  dStore.write(beforeProv.data, dStore.read().revision);

  // Independent buffered completedMapPages callCount tamper (missing / duplicate / same-phase wrong-page) with valid grants -> 0 LLM calls
  const extraMapCallIdx = beforeProv.data.calls.findIndex((c) => c.phase === 'map' && c.completed === true && c.page !== Number(bufKey));
  for (const mutateBuf of [
    (d) => { delete d.completedMapPages[bufKey].receipt.callCount; },
    ...(extraMapCallIdx >= 0
      ? [(d) => { d.completedMapPages[bufKey].receipt.callCount = extraMapCallIdx + 1; }]
      : []),
    ...(Object.keys(beforeProv.data.completedMapPages).length >= 2
      ? [(d) => {
          const k2 = Object.keys(d.completedMapPages)[1];
          d.completedMapPages[bufKey].receipt.callCount = d.completedMapPages[k2].receipt.callCount;
        }]
      : []),
  ]) {
    const cur = dStore.read();
    const copy = structuredClone(cur.data);
    mutateBuf(copy);
    dStore.write(copy, cur.revision);
    const nCalls = fd.calls.length;
    await assert.rejects(
      () => prepareContinuation({
        ctx: fd.ctx,
        agent: fd.agent,
        session: fd.session,
        seqs: dSeqs,
        policy: fd.engine.config,
        capacity: dCap,
        chain: { targets: [{ provider: 'p', model: 'm' }] },
        compactionId: 'cmp-drain-buf-tamper',
        signal: signal(),
        archiveRoot: join(fd.root, 'archive', 'sess-drain'),
        parallelContinuation: true,
      }),
      { code: 'CONTINUATION_PROGRESS_INVALID' },
    );
    assert.equal(fd.calls.length, nCalls);
    dStore.write(cur.data, dStore.read().revision);
  }
  dStore.write(beforeProv.data, dStore.read().revision);

  // Advance so Page 1 drains buffered pages into state.receipts & fails during Reduce with budget exhausted
  phase = 'ok-then-fail-reduce';
  fd.ctx.llm.stream = async function* (req) {
    fd.calls.push(req);
    const body = req.messages.map((m) => blocksToText(m.content ?? [])).join('\n');
    const m = /page (\d+) of (\d+)/.exec(body);
    if (m) {
      const pNo = Number(m[1]);
      yield { type: 'text-delta', text: `## Goal\nKeep database offline.\n\n## State\nPage ${pNo}.\n\n## Next\nContinue.\n\n## Uncertain\nNone.` };
      yield { type: 'finish', kind: 'stop' };
      return;
    }
    yield { type: 'text-delta', text: 'invalid reduce output' };
    yield { type: 'finish', kind: 'stop' };
  };
  await assert.rejects(
    () => prepareContinuation({
      ctx: fd.ctx,
      agent: fd.agent,
      session: fd.session,
      seqs: dSeqs,
      policy: fd.engine.config,
      capacity: dCap,
      chain: { targets: [{ provider: 'p', model: 'm' }] },
      compactionId: 'cmp-drain-2',
      signal: signal(),
      archiveRoot: join(fd.root, 'archive', 'sess-drain'),
      manualRetry: true,
      requestId: 'req-drain-2',
      rateLimitCooldownMs: 0,
      parallelContinuation: true,
    }),
    { code: 'CONTINUATION_CALL_BUDGET' },
  );
  const drainedRow = dStore.read();
  assert.equal(drainedRow.data.completedMapPages, undefined, 'buffer should have drained');
  assert.ok(drainedRow.data.receipts.length >= 3);
  assert.equal(drainedRow.data.budgetGrants.length, 1);

  // Independent missing, duplicate, and unique same-phase wrong-page receipt.callCount mutations with valid grants must reject with 0 LLM calls!
  for (const mutateDrained of [
    (d) => {
      delete d.receipts[1].callCount;
    },
    (d) => {
      d.receipts[1].callCount = d.receipts[0].callCount;
    },
    (d) => {
      const swap = d.receipts[1].callCount;
      d.receipts[1].callCount = d.receipts[2].callCount;
      d.receipts[2].callCount = swap;
    },
    (d) => {
      delete d.receipts[1].callCount;
      d.budgetGrants[0].accepted = 0;
    },
    (d) => {
      d.receipts[1].callCount = d.calls.length;
      d.budgetGrants[0].accepted = 0;
    },
    (d) => {
      delete d.receipts[1].callCount;
      delete d.budgetGrants[0].version;
      delete d.budgetGrants[0].accepted;
    },
  ]) {
    const cur = dStore.read();
    const copy = structuredClone(cur.data);
    mutateDrained(copy);
    dStore.write(copy, cur.revision);
    const nCalls = fd.calls.length;
    await assert.rejects(
      () => prepareContinuation({
        ctx: fd.ctx,
        agent: fd.agent,
        session: fd.session,
        seqs: dSeqs,
        policy: fd.engine.config,
        capacity: dCap,
        chain: { targets: [{ provider: 'p', model: 'm' }] },
        compactionId: 'cmp-drain-tamper',
        signal: signal(),
        archiveRoot: join(fd.root, 'archive', 'sess-drain'),
        parallelContinuation: true,
      }),
      { code: 'CONTINUATION_PROGRESS_INVALID' },
    );
    assert.equal(fd.calls.length, nCalls);
    dStore.write(cur.data, dStore.read().revision);
  }

  // Delayed/late worker settling after abortPool/poolExited cannot mutate saved progress
  const fl = fixture({
    archiveEnabled: true,
    language: 'en',
    summaryRetryCount: 0,
    summaryRetryDelayMs: 0,
    maxTokens: 1200,
    auditEnabled: false,
    auditBlockOnLoss: false,
    parallelPages: true,
    summaryConcurrency: 2,
    summaryInputMaxBytes: 24000,
    continuationMemoryBytes: 4096,
    maxSummaryChunks: 32,
    windowFallback: 1000000,
    continuationMaxExtraCalls: 1,
  });
  fl.add('system', 'Sys.');
  for (let i = 1; i <= 5; i += 1) fl.add('assistant', `Late seg ${i}: ` + `trace_${i} `.repeat(380));
  const lSeqs = fl.surface.nodes.slice(1);
  const lCap = await resolveSummaryCapacity(
    { llm: { resolveModelInfo: async () => ({ contextWindow: 1000000, maxTokens: 1200 }) }, logger: { warn() {} } },
    { targets: [{ provider: 'p', model: 'm' }] },
    fl.engine.config,
    signal(),
  );
  let lateProgKey = null;
  const lateGate = deferred();
  fl.ctx.llm.stream = async function* (req) {
    fl.calls.push(req);
    const body = req.messages.map((m) => blocksToText(m.content ?? [])).join('\n');
    const m = /page (\d+) of (\d+)/.exec(body);
    const pNo = m ? Number(m[1]) : 1;
    if (pNo === 1) {
      // Wait well past fast abort while another worker immediately triggers fatal 401
      await lateGate.promise;
      yield { type: 'text-delta', text: mkNotes(1) };
      yield { type: 'finish', kind: 'stop' };
      return;
    }
    await delay(10);
    const err = new Error('HTTP 401 fatal');
    err.status = 401;
    throw err;
  };
  await assert.rejects(
    () => prepareContinuation({
      ctx: fl.ctx,
      agent: fl.agent,
      session: fl.session,
      seqs: lSeqs,
      policy: fl.engine.config,
      capacity: lCap,
      chain: { targets: [{ provider: 'p', model: 'm' }] },
      compactionId: 'cmp-late-1',
      signal: signal(),
      archiveRoot: join(fl.root, 'archive', 'sess-late'),
      onProgressIdentity: (k) => { lateProgKey = k; },
      rateLimitCooldownMs: 0,
      parallelContinuation: true,
    }),
  );
  const lStore = new ContinuationProgressStore(join(fl.root, 'archive', 'continuation-progress'), fl.session.id, lateProgKey);
  const snapshotBeforeLateResolve = lStore.read();
  lateGate.resolve();
  await delay(30);
  const snapshotAfterLateResolve = lStore.read();
  assert.equal(snapshotAfterLateResolve.revision, snapshotBeforeLateResolve.revision, 'late worker settlement after poolExited must not write progress');
  assert.deepEqual(snapshotAfterLateResolve.data, snapshotBeforeLateResolve.data);

  // 6. Legacy sequential upgrade -> manual v2 renewal -> interrupted attempt -> resume,
  //    PLUS duplicate / missing / wrong-page callCount tamper rejection on both sequential & map-reduce!
  {
    const mkSeqNote = (p) => `## Goal\nSeq goal ${p}.\n\n## State\nSeq state ${p}.\n\n## Next\nContinue.\n\n## Uncertain\nNone.`;
    const fsSeq = fixture({
      archiveEnabled: true,
      language: 'en',
      summaryRetryCount: 1,
      summaryRetryDelayMs: 0,
      maxTokens: 1200,
      auditEnabled: false,
      auditBlockOnLoss: false,
      summaryConcurrency: 1,
      summaryInputMaxBytes: 24000,
      continuationMemoryBytes: 4096,
      maxSummaryChunks: 32,
      windowFallback: 1000000,
      continuationMaxExtraCalls: 0,
    });
    fsSeq.add('system', 'Sys.');
    for (let i = 1; i <= 5; i += 1) fsSeq.add('assistant', `Seq seg ${i}: ` + `body_${i} `.repeat(1600));
    const sSeqs = fsSeq.surface.nodes.slice(1);
    const sCap = await resolveSummaryCapacity(
      { llm: { resolveModelInfo: async () => ({ contextWindow: 1000000, maxTokens: 1200 }) }, logger: { warn() {} } },
      { targets: [{ provider: 'p', model: 'm' }] },
      fsSeq.engine.config,
      signal(),
    );
    let seqFailAtCall = 2;
    let sProgKey = null;
    fsSeq.ctx.llm.stream = async function* (req) {
      fsSeq.calls.push(req);
      const callIdx = fsSeq.calls.length;
      if (callIdx >= seqFailAtCall) {
        const err = new Error('HTTP 429 transient');
        err.status = 429;
        throw err;
      }
      yield { type: 'text-delta', text: mkSeqNote(callIdx) };
      yield { type: 'finish', kind: 'stop' };
    };
    await assert.rejects(
      () => prepareContinuation({
        ctx: fsSeq.ctx,
        agent: fsSeq.agent,
        session: fsSeq.session,
        seqs: sSeqs,
        policy: fsSeq.engine.config,
        capacity: sCap,
        chain: { targets: [{ provider: 'p', model: 'm' }] },
        compactionId: 'cmp-seq-leg-1',
        signal: signal(),
        archiveRoot: join(fsSeq.root, 'archive', 'sess-seq-leg'),
        onProgressIdentity: (k) => { sProgKey = k; },
      }),
      { code: 'CONTINUATION_CALL_BUDGET' },
    );
    const sStore = new ContinuationProgressStore(join(fsSeq.root, 'archive', 'continuation-progress'), fsSeq.session.id, sProgKey);
    // Simulate genuine HEAD v1 legacy checkpoint lacking ledgerVersion and receipt.callCount
    const legRow = sStore.read();
    assert.ok(legRow.data.segments.length >= 3, `expected >=3 sequential segments, got ${legRow.data.segments.length}`);
    assert.ok(legRow.data.receipts.length >= 1);
    const legData = structuredClone(legRow.data);
    delete legData.ledgerVersion;
    for (const r of legData.receipts) delete r.callCount;
    sStore.write(legData, legRow.revision);

    // Manual renewal upgrades legacy receipt to v2, fails cleanly at call 5 (accepting pages 1 & 2 -> receipts [1, 3, 4]), then resumes cleanly!
    seqFailAtCall = 5;
    await assert.rejects(
      () => prepareContinuation({
        ctx: fsSeq.ctx,
        agent: fsSeq.agent,
        session: fsSeq.session,
        seqs: sSeqs,
        policy: fsSeq.engine.config,
        capacity: sCap,
        chain: { targets: [{ provider: 'p', model: 'm' }] },
        compactionId: 'cmp-seq-leg-2',
        signal: signal(),
        archiveRoot: join(fsSeq.root, 'archive', 'sess-seq-leg'),
        manualRetry: true,
        requestId: 'req-seq-leg-renew-1',
      }),
      { code: 'CONTINUATION_CALL_BUDGET' },
    );
    const upgradedRow = sStore.read();
    assert.equal(upgradedRow.data.budgetGrants[0].version, 2);
    assert.ok(Number.isSafeInteger(upgradedRow.data.receipts[0].callCount));
    assert.ok(upgradedRow.data.receipts.length >= 3, `expected >=3 receipts for same-grant swap test, got ${upgradedRow.data.receipts.length}`);

    // Tampering sequential v2 checkpoint (missing / duplicate / same-grant unique swapped wrong-page callCount) must fail closed with 0 LLM calls
    for (const mutateSeq of [
      (d) => { delete d.receipts[0].callCount; },
      (d) => { d.receipts[1].callCount = d.receipts[0].callCount; },
      (d) => {
        const swap = d.receipts[1].callCount;
        d.receipts[1].callCount = d.receipts[2].callCount;
        d.receipts[2].callCount = swap;
      },
    ]) {
      const cur = sStore.read();
      const copy = structuredClone(cur.data);
      mutateSeq(copy);
      sStore.write(copy, cur.revision);
      const nCalls = fsSeq.calls.length;
      await assert.rejects(
        () => prepareContinuation({
          ctx: fsSeq.ctx,
          agent: fsSeq.agent,
          session: fsSeq.session,
          seqs: sSeqs,
          policy: fsSeq.engine.config,
          capacity: sCap,
          chain: { targets: [{ provider: 'p', model: 'm' }] },
          compactionId: 'cmp-seq-leg-tamper',
          signal: signal(),
          archiveRoot: join(fsSeq.root, 'archive', 'sess-seq-leg'),
        }),
        { code: 'CONTINUATION_PROGRESS_INVALID' },
      );
      assert.equal(fsSeq.calls.length, nCalls);
      sStore.write(cur.data, sStore.read().revision);
    }

    // Legitimate interrupted sequential resume after upgrade completes cleanly
    seqFailAtCall = 999;
    const seqDone = await prepareContinuation({
      ctx: fsSeq.ctx,
      agent: fsSeq.agent,
      session: fsSeq.session,
      seqs: sSeqs,
      policy: fsSeq.engine.config,
      capacity: sCap,
      chain: { targets: [{ provider: 'p', model: 'm' }] },
      compactionId: 'cmp-seq-leg-3',
      signal: signal(),
      archiveRoot: join(fsSeq.root, 'archive', 'sess-seq-leg'),
      manualRetry: true,
      requestId: 'req-seq-leg-renew-2',
    });
    assert.ok(seqDone?.summarized?.summary?.length > 0);
  }
});

await test('goal-round3-codex-review4-legacy-upgrade-and-provenance', async () => {
  // 1. Legacy v1 sequential checkpoint with rejected completed call + v1 grant + accepted retry -> links final callCount & resumes!
  {
    const mkSeq = (n) => `## Goal\nKeep retry bounded ${n}.\n\n## State\nPage ${n} done.\n\n## Next\nContinue.\n\n## Uncertain\nNone.`;
    const flHelper = fixture({
      archiveEnabled: true,
      language: 'en',
      summaryRetryCount: 1,
      summaryRetryDelayMs: 0,
      maxTokens: 1200,
      auditEnabled: false,
      auditBlockOnLoss: false,
      summaryInputMaxBytes: 24000,
      continuationMemoryBytes: 4096,
      maxSummaryChunks: 32,
      windowFallback: 1000000,
      continuationMaxExtraCalls: 0,
      summaryConcurrency: 1,
    });
    flHelper.add('system', 'Sys.');
    for (let i = 1; i <= 4; i += 1) flHelper.add('assistant', `Legacy seq ${i}: ` + `entry_${i} `.repeat(1600));
    const hSeqs = flHelper.surface.nodes.slice(1);
    const hCap = await resolveSummaryCapacity(
      { llm: { resolveModelInfo: async () => ({ contextWindow: 1000000, maxTokens: 1200 }) }, logger: { warn() {} } },
      { targets: [{ provider: 'p', model: 'm' }] },
      flHelper.engine.config,
      signal(),
    );
    let hKey = null;
    let hCount = 0;
    flHelper.ctx.llm.stream = async function* (req) {
      hCount += 1;
      flHelper.calls.push(req);
      if (hCount >= 2) {
        const err = new Error('HTTP 429 fail page 2');
        err.status = 429;
        throw err;
      }
      yield { type: 'text-delta', text: mkSeq(1) };
      yield { type: 'finish', kind: 'stop' };
    };
    await assert.rejects(
      () => prepareContinuation({
        ctx: flHelper.ctx,
        agent: flHelper.agent,
        session: flHelper.session,
        seqs: hSeqs,
        policy: flHelper.engine.config,
        capacity: hCap,
        chain: { targets: [{ provider: 'p', model: 'm' }] },
        compactionId: 'cmp-leg-v1-seed',
        signal: signal(),
        archiveRoot: join(flHelper.root, 'archive', 'sess-leg-v1'),
        onProgressIdentity: (k) => { hKey = k; },
      }),
      { code: 'CONTINUATION_CALL_BUDGET' },
    );
    const hStore = new ContinuationProgressStore(join(flHelper.root, 'archive', 'continuation-progress'), flHelper.session.id, hKey);
    const hRow = hStore.read();
    const authenticV1 = structuredClone(hRow.data);
    delete authenticV1.ledgerVersion;
    delete authenticV1.receipts[0].callCount;
    // Inject prior rejected completed call + legacy v1 grant before the accepted call
    authenticV1.calls = [
      { page: 0, target: 'p/m', startedAt: '2026-11-28T00:00:00.000Z', maxTokens: 1200, requestBytes: 1000, usage: { inputTokens: 50, outputTokens: 10 }, endedAt: '2026-11-28T00:00:00.500Z', completed: true },
      ...authenticV1.calls,
    ];
    authenticV1.budgetGrants = [
      { calls: 1, next: 0, requestId: 'req-v1-manual-grant', at: '2026-11-28T00:00:00.800Z' },
    ];
    hStore.write(authenticV1, hRow.revision);

    // Step A: manual renewal upgrades authentic v1 checkpoint -> succeeds page 1, fails page 2 -> callCount MUST be 2 (after legacy grant!)
    hCount = 0;
    flHelper.ctx.llm.stream = async function* (req) {
      hCount += 1;
      flHelper.calls.push(req);
      if (hCount >= 2) {
        const err = new Error('HTTP 429 fail page 3');
        err.status = 429;
        throw err;
      }
      yield { type: 'text-delta', text: mkSeq(2) };
      yield { type: 'finish', kind: 'stop' };
    };
    await assert.rejects(
      () => prepareContinuation({
        ctx: flHelper.ctx,
        agent: flHelper.agent,
        session: flHelper.session,
        seqs: hSeqs,
        policy: flHelper.engine.config,
        capacity: hCap,
        chain: { targets: [{ provider: 'p', model: 'm' }] },
        compactionId: 'cmp-leg-v1-stepA',
        signal: signal(),
        archiveRoot: join(flHelper.root, 'archive', 'sess-leg-v1'),
        manualRetry: true,
        requestId: 'req-v1-upgrade-2',
      }),
      { code: 'CONTINUATION_CALL_BUDGET' },
    );
    const midRow = hStore.read();
    assert.equal(midRow.data.ledgerVersion, 2);
    assert.equal(midRow.data.receipts[0].callCount, 2, 'must link final completed call after v1 grant, NOT rejected call 1');
    assert.equal(midRow.data.budgetGrants.length, 2);

    // Step B: subsequent resume after interruption MUST succeed cleanly without CONTINUATION_PROGRESS_INVALID!
    flHelper.ctx.llm.stream = async function* (req) {
      flHelper.calls.push(req);
      yield { type: 'text-delta', text: mkSeq(99) };
      yield { type: 'finish', kind: 'stop' };
    };
    const legDone = await prepareContinuation({
      ctx: flHelper.ctx,
      agent: flHelper.agent,
      session: flHelper.session,
      seqs: hSeqs,
      policy: flHelper.engine.config,
      capacity: hCap,
      chain: { targets: [{ provider: 'p', model: 'm' }] },
      compactionId: 'cmp-leg-v1-stepB',
      signal: signal(),
      archiveRoot: join(flHelper.root, 'archive', 'sess-leg-v1'),
      manualRetry: true,
      requestId: 'req-v1-upgrade-3',
    });
    assert.ok(legDone?.summarized?.summary?.length > 0);
  }

  // 2. Existing HEAD map-reduce checkpoint (4+ accepted map pages lacking callCount + failed reduce) upgrades & finishes in 1 reduce call!
  {
    const fm = fixture({
      archiveEnabled: true,
      language: 'en',
      summaryRetryCount: 0,
      summaryRetryDelayMs: 0,
      maxTokens: 1200,
      auditEnabled: false,
      auditBlockOnLoss: false,
      parallelPages: true,
      summaryConcurrency: 4,
      summaryInputMaxBytes: 24000,
      continuationMemoryBytes: 4096,
      maxSummaryChunks: 32,
      windowFallback: 1000000,
      continuationMaxExtraCalls: 2,
    });
    fm.add('system', 'Sys.');
    for (let i = 1; i <= 5; i += 1) fm.add('assistant', `HEAD MR seg ${i}: ` + `map_${i} `.repeat(1200));
    const mSeqs = fm.surface.nodes.slice(1);
    const mCap = await resolveSummaryCapacity(
      { llm: { resolveModelInfo: async () => ({ contextWindow: 1000000, maxTokens: 1200 }) }, logger: { warn() {} } },
      { targets: [{ provider: 'p', model: 'm' }] },
      fm.engine.config,
      signal(),
    );
    let mrKey = null;
    fm.ctx.llm.stream = async function* (req) {
      fm.calls.push(req);
      const body = req.messages.map((m) => blocksToText(m.content ?? [])).join('\n');
      const m = /page (\d+) of (\d+)/.exec(body);
      if (m) {
        const pNo = Number(m[1]);
        yield { type: 'text-delta', text: `## Goal\nKeep MR ${pNo}.\n\n## State\nMapped ${pNo}.\n\n## Next\nReduce.\n\n## Uncertain\nNone.` };
        yield { type: 'finish', kind: 'stop' };
        return;
      }
      const err = new Error('HTTP 503 reduce transient failure');
      err.status = 503;
      throw err;
    };
    await assert.rejects(
      () => prepareContinuation({
        ctx: fm.ctx,
        agent: fm.agent,
        session: fm.session,
        seqs: mSeqs,
        policy: fm.engine.config,
        capacity: mCap,
        chain: { targets: [{ provider: 'p', model: 'm' }] },
        compactionId: 'cmp-head-mr-1',
        signal: signal(),
        archiveRoot: join(fm.root, 'archive', 'sess-head-mr'),
        onProgressIdentity: (k) => { mrKey = k; },
        parallelContinuation: true,
      }),
      (err) => err && err.code !== 'CONTINUATION_PROGRESS_INVALID',
    );
    const mStore = new ContinuationProgressStore(join(fm.root, 'archive', 'continuation-progress'), fm.session.id, mrKey);
    const mrRow = mStore.read();
    assert.equal(mrRow.data.mode, 'map-reduce');
    assert.ok(mrRow.data.segments.length >= 4);
    assert.equal(mrRow.data.next, mrRow.data.segments.length);
    assert.equal(mrRow.data.reduced, false);
    // Strip ledgerVersion & receipt.callCount to reproduce exact HEAD on-disk map-reduce format!
    const headMrData = structuredClone(mrRow.data);
    delete headMrData.ledgerVersion;
    for (const r of headMrData.receipts) delete r.callCount;
    mStore.write(headMrData, mrRow.revision);

    const callsBeforeResume = fm.calls.length;
    fm.ctx.llm.stream = async function* (req) {
      fm.calls.push(req);
      yield { type: 'text-delta', text: '## Goal\nKeep MR reduced.\n\n## State\nReduced cleanly.\n\n## Next\nDone.\n\n## Uncertain\nNone.' };
      yield { type: 'finish', kind: 'stop' };
    };
    const mrDone = await prepareContinuation({
      ctx: fm.ctx,
      agent: fm.agent,
      session: fm.session,
      seqs: mSeqs,
      policy: fm.engine.config,
      capacity: mCap,
      chain: { targets: [{ provider: 'p', model: 'm' }] },
      compactionId: 'cmp-head-mr-2',
      signal: signal(),
      archiveRoot: join(fm.root, 'archive', 'sess-head-mr'),
      parallelContinuation: true,
    });
    assert.ok(mrDone?.summarized?.summary?.length > 0);
    assert.equal(fm.calls.length - callsBeforeResume, 1, 'HEAD map-reduce resume must finish in 1 reduce call with 0 re-mapped pages');
    const upgradedMr = mStore.read();
    assert.equal(upgradedMr.data.ledgerVersion, 2);
    assert.ok(upgradedMr.data.receipts.every((r) => Number.isSafeInteger(r.callCount)));
  }
});

for (const engine of fixtures) engine.dispose();
// Each root was created by scratch() within the test sandbox.
for (const root of roots) rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({ passed: results.filter(row => row.pass).length, failed: results.filter(row => !row.pass).length, results }, null, 2));
if (results.some(row => !row.pass)) process.exitCode = 1;
