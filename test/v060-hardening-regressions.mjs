import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { auditCompaction, auditInstructionProvenance, summarizeProvenanceFailures } from '../lib/audit.js';
import { classifyBlockingAuditLost } from '../lib/audit-fallback.js';
import { numericFacts, numericFactsEquivalent } from '../lib/audit/numeric.js';
import { decorateCompactCommand } from '../lib/command-compact.js';
import { createCommandHeartbeatScope } from '../lib/command-heartbeat.js';
import { resolveConfig } from '../lib/config.js';
import { planContinuationMemory, prepareContinuation, selectContinuationWave } from '../lib/continuation.js';
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

for (const engine of fixtures) engine.dispose();
// Each root was created by scratch() within the test sandbox.
for (const root of roots) rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({ passed: results.filter(row => row.pass).length, failed: results.filter(row => !row.pass).length, results }, null, 2));
if (results.some(row => !row.pass)) process.exitCode = 1;
