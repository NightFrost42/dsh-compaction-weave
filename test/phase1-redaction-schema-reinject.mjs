import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

import { summarizeProvenanceFailures } from '../lib/audit.js';
import { dumpAuditRejection } from '../lib/audit-reject.js';
import {
  DEFAULT_CONFIG,
  EXPLICIT_CONFIG_KEYS,
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
} from '../lib/config.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import {
  FailureDiagnostics,
  beginDiagnosticAttempt,
  diagnosticContext,
  diagnosticFor,
  finishDiagnosticAttempt,
  noteDiagnosticMeasurement,
} from '../lib/failure-diagnostics.js';
import { resolveAdaptiveReinjectLimits } from '../lib/file-reinject.js';
import { CompactionArchive, HISTORY_SNAPSHOT_WARNING, HISTORY_TOOLS } from '../lib/history.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { COMPACTION_TOOL_NAME, registerCompactionTool } from '../lib/proactive.js';
import { CompactionProgressTracker, normalizeRetryReasonCode } from '../lib/progress-tracker.js';
import { buildCompactionInstruction } from '../lib/prompt.js';
import {
  AWS_ACCESS_KEY_RE,
  BEARER_TOKEN_RE,
  COMMON_SECRET_TOKEN_RE,
  PEM_PRIVATE_KEY_BLOCK_RE,
  PEM_PRIVATE_KEY_HEADER_RE,
  PEM_PRIVATE_KEY_LINE_RE,
  SECRET_PREFIX_RE,
  STRICT_SECRET_PREFIX_RE,
  containsSecretCredential,
  hasSecretPrefix,
  redactCredentials,
  redactPemPrivateKeys,
} from '../lib/redact.js';
import { sanitizeStageMeta, traceStageSync, withStageTraceContext } from '../lib/stage-trace.js';
import {
  SessionStateStore,
  publicBreakerSummary,
  publicResumableSummary,
  validateResumableCompaction,
} from '../lib/state.js';
import { isAnthropicReasoningRoute, resolveReasoningEffort, summarizeWithChain, summarizeWithTarget } from '../lib/summary.js';
import { resolveSummaryCapacity } from '../lib/summary-budget.js';
import { registerHistoryTools } from '../lib/tools.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error?.message ?? String(error), stack: error?.stack });
  }
}

const TEST_BASE = process.env.WEAVE_TEST_ROOT ?? tmpdir();
const D5 = '-'.repeat(5);

function makePemHeader(label) {
  return `${D5}BEGIN ${label}${D5}`;
}

function makePemBlock(label, body = 'MIIEowIBAAKCAQEAv39xDummyBodyLineOne1234567890ABCD==\nQ29udGludWVkRHVtbXlCb2R5TGluZVR3bzEyMzQ1Njc4OTAxMjM0NTY=') {
  return `${D5}BEGIN ${label}${D5}\n${body}\n${D5}END ${label}${D5}`;
}

// Construct synthetic credentials dynamically so scripts/check.mjs static scan stays clean.
const FAKE_SK = 'sk-' + 'TestSecretAlpha1234567890';
const FAKE_GH = 'ghp_' + 'TestGitHubToken1234567890';
const FAKE_BEARER = 'Bearer ' + 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummySig';
const FAKE_AKIA = 'AKIA' + 'IOSFODNN7EXAMPLE';
const FAKE_ASIA = 'ASIA' + 'Z52L7EXAMPLEKEY9';
const FAKE_LONG_B64 = 'QWxhZGRpbjpvcGVuIHNlc2FtZSB0ZXN0IHBheWxvYWQgZm9yIGJhc2U2NCBibG9iIHJlZGFjdGlvbg==';

const EN_HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeSummary(section9 = 'Preserve active workspace changes and continue safely.') {
  return EN_HEADINGS.map((h, idx) =>
    `${h}\n${idx === 5 ? '[filled by engine]' : idx === 8 ? section9 : 'Historical details archived cleanly.'}`,
  ).join('\n\n');
}

function bpeTokens(text) {
  let ascii = 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x7f) ascii += 1;
    else if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x3000 && cp <= 0x303f) ||
      (cp >= 0xff00 && cp <= 0xffef)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(ascii / 3.7 + cjk * 0.68 + other / 2.5) + 4;
}

function mountClientSandbox({ language = 'zh', handler } = {}) {
  const clientSourcePath = new URL('../lib/client.js', import.meta.url);
  let mod;
  let dictionaries;
  const registeredSlots = new Map();
  let stateIndex = 0;
  let effectIndex = 0;
  const states = [];
  const effects = [];
  const pendingFetches = new Set();
  const timers = new Map();
  let nextTimerId = 1;

  const depsChanged = (prev, next) => {
    if (prev === undefined || next === undefined) return true;
    if (prev.length !== next.length) return true;
    for (let i = 0; i < prev.length; i += 1) {
      if (!Object.is(prev[i], next[i])) return true;
    }
    return false;
  };

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
    }),
    useState: (init) => {
      const idx = stateIndex++;
      if (!(idx in states)) states[idx] = typeof init === 'function' ? init() : init;
      return [
        states[idx],
        (val) => {
          states[idx] = typeof val === 'function' ? val(states[idx]) : val;
        },
      ];
    },
    useEffect: (cb, deps) => {
      const idx = effectIndex++;
      const prev = effects[idx];
      if (!prev || depsChanged(prev.deps, deps)) {
        effects[idx] = { callback: cb, deps, pending: true, cleanup: prev?.cleanup };
      }
    },
  };

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (decl) => {
          mod = decl.factory((name) => {
            assert.equal(name, 'react', 'lib/client.js must only require react');
            return React;
          });
        },
      },
    },
    document: {
      visibilityState: 'visible',
      hidden: false,
      addEventListener() {},
      removeEventListener() {},
    },
    console,
    AbortController,
    setTimeout: (fn, delay) => {
      const id = nextTimerId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => {
      throw new Error('lib/client.js must never call setInterval');
    },
    clearInterval: () => {},
    fetch: (_url, opts) => {
      const payload = JSON.parse(opts.body);
      const task = (async () => {
        const value = await handler(payload);
        return { status: 200, text: async () => JSON.stringify({ ok: true, value }) };
      })();
      pendingFetches.add(task);
      void task.finally(() => pendingFetches.delete(task));
      return task;
    },
  };

  return { clientSourcePath, sandbox, registeredSlots, getMod: () => mod, getDictionaries: () => dictionaries, states, effects, pendingFetches, timers, setStateIdx: (v) => { stateIndex = v; }, setEffectIdx: (v) => { effectIndex = v; }, applyClient(src) {
    vm.runInNewContext(src, sandbox);
    mod.apply({
      slots: {
        inject: (_n, cb) => cb(),
        register: (desc, comp) => {
          registeredSlots.set(desc.name, comp);
          return () => {};
        },
      },
      effect: (cb) => cb(),
      locale: {
        register: (_ns, d) => {
          dictionaries = d;
          return () => {};
        },
        bind: () => (k) => dictionaries[language][k],
      },
    });
    const Card = registeredSlots.get('conversation.input.dock');
    let lastProps = {};
    const flushEffects = () => {
      for (const slot of effects) {
        if (slot?.pending) {
          slot.pending = false;
          if (typeof slot.cleanup === 'function') slot.cleanup();
          slot.cleanup = slot.callback();
        }
      }
    };
    const render = (props = lastProps) => {
      lastProps = props;
      stateIndex = 0;
      effectIndex = 0;
      const tree = Card(props);
      flushEffects();
      return tree;
    };
    const settle = async () => {
      for (let i = 0; i < 6; i += 1) {
        if (pendingFetches.size > 0) await Promise.all([...pendingFetches]);
        await new Promise((r) => setImmediate(r));
        render(lastProps);
      }
      return render(lastProps);
    };
    const fireNextTimer = async () => {
      const first = timers.entries().next();
      assert.ok(!first.done, 'Expected scheduled timer');
      const [id, entry] = first.value;
      timers.delete(id);
      entry.fn();
      return settle();
    };
    const unmount = () => {
      for (const slot of effects) {
        if (typeof slot?.cleanup === 'function') slot.cleanup();
      }
    };
    return { dictionaries, render, settle, fireNextTimer, unmount };
  } };
}

function findNode(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of tree.children ?? []) {
    const match = findNode(child, predicate);
    if (match) return match;
  }
  return null;
}

function textOf(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (!tree || typeof tree !== 'object') return '';
  return (tree.children ?? []).map(textOf).join(' ');
}

// ── 1. lib/redact.js unit & stateless /g lastIndex safety ───────────────────

await test('redact-covers-pem-blocks-truncated-headers-aws-akia-asia-tokens-and-is-stateless', () => {
  assert.ok(PEM_PRIVATE_KEY_BLOCK_RE instanceof RegExp);
  assert.ok(PEM_PRIVATE_KEY_HEADER_RE instanceof RegExp);
  assert.ok(PEM_PRIVATE_KEY_LINE_RE instanceof RegExp);
  assert.ok(AWS_ACCESS_KEY_RE instanceof RegExp);
  assert.ok(COMMON_SECRET_TOKEN_RE instanceof RegExp);
  assert.ok(BEARER_TOKEN_RE instanceof RegExp);
  assert.ok(SECRET_PREFIX_RE instanceof RegExp);
  assert.ok(STRICT_SECRET_PREFIX_RE instanceof RegExp);

  for (const label of ['RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
    const fullBlock = `before\n${makePemBlock(label)}\nafter`;
    const redactedBlock = redactPemPrivateKeys(fullBlock);
    assert.equal(redactedBlock, 'before\n[redacted-private-key]\nafter', `full PEM block for ${label}`);
    assert.ok(!redactedBlock.includes('BEGIN'), `no BEGIN header in ${label}`);
    assert.ok(!redactedBlock.includes('DummyBody'), `no PEM body in ${label}`);

    const truncated = `Error loading key: ${makePemHeader(label)} MIIEtruncatedLine`;
    const redactedTrunc = redactPemPrivateKeys(truncated);
    assert.equal(redactedTrunc, 'Error loading key: [redacted-private-key]', `truncated PEM header for ${label}`);
  }

  const mixed = [
    `rsa=${makePemBlock('RSA PRIVATE KEY')}`,
    `trunc=${makePemHeader('OPENSSH PRIVATE KEY')} b3BlbnNzaC1rZXktdjE`,
    `akia=${FAKE_AKIA}`,
    `asia=${FAKE_ASIA}`,
    `sk=${FAKE_SK}`,
    `gh=${FAKE_GH}`,
    `auth=${FAKE_BEARER}`,
    `blob=${FAKE_LONG_B64}`,
  ].join('\n');

  const sanitized = redactCredentials(mixed, {
    pemReplacement: '[redacted-private-key]',
    keyReplacement: '[redacted-key]',
    tokenReplacement: '[redacted-token]',
    bearerReplacement: '$1[redacted-token]',
    redactBase64Blobs: true,
  });

  for (const secret of ['BEGIN RSA PRIVATE KEY', 'BEGIN OPENSSH PRIVATE KEY', 'DummyBody', FAKE_AKIA, FAKE_ASIA, FAKE_SK, FAKE_GH, 'dummySig', FAKE_LONG_B64]) {
    assert.ok(!sanitized.includes(secret), `redactCredentials must remove ${secret}`);
  }
  assert.ok(sanitized.includes('[redacted-private-key]'));
  assert.ok(sanitized.includes('[redacted-key]'));
  assert.ok(sanitized.includes('[redacted-token]'));
  assert.ok(sanitized.includes('[redacted-blob]'));
  assert.ok(sanitized.includes('Bearer [redacted-token]'));

  // Repeated stateless checks must NEVER alternate due to /g lastIndex bug.
  const samples = [
    makePemHeader('RSA PRIVATE KEY'),
    makePemBlock('EC PRIVATE KEY'),
    FAKE_ASIA,
    FAKE_AKIA,
    FAKE_SK,
    FAKE_GH,
    FAKE_BEARER,
  ];
  for (const sample of samples) {
    for (let i = 0; i < 6; i += 1) {
      assert.equal(containsSecretCredential(sample), true, `containsSecretCredential iteration ${i} for ${sample}`);
    }
  }
  for (const prefix of [makePemHeader('PRIVATE KEY'), FAKE_ASIA, FAKE_AKIA, `err_${FAKE_ASIA}`, `err-${FAKE_SK}`, `err.${FAKE_GH}`, 'Bearer token']) {
    for (let i = 0; i < 6; i += 1) {
      assert.equal(hasSecretPrefix(prefix), true, `hasSecretPrefix iteration ${i} for ${prefix}`);
    }
  }
  assert.equal(containsSecretCredential('CONSTRAINT_LOST'), false);
  assert.equal(hasSecretPrefix('RATE_LIMITED'), false);
});

// Correctness check for non-secret region-like vs clean codes
await test('redact-clean-retry-codes-do-not-false-positive', () => {
  for (const clean of ['CONSTRAINT_LOST', 'RATE_LIMITED', 'ECONNRESET', 'MAX_TOKENS', 'SUMMARY_TIMEOUT']) {
    assert.equal(containsSecretCredential(clean), false, `clean code ${clean} must not match credential`);
    assert.equal(hasSecretPrefix(clean), false, `clean code ${clean} must not match secret prefix`);
  }
});

// ── 2. Redaction & Telemetry Wiring Across Backend Callers ───────────────────

await test('redaction-wiring-in-audit-reject-failure-diagnostics-audit-stage-trace-state-progress-tracker', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-phase1-redact-'));
  try {
    // 2a. lib/audit-reject.js
    const pemRsa = makePemBlock('RSA PRIVATE KEY');
    const pemEc = makePemBlock('EC PRIVATE KEY');
    const rejectFile = await dumpAuditRejection({
      storageRoot: root,
      sessionId: 'sess-redact-1',
      compactionId: 'cmp-redact-1',
      code: 'CONSTRAINT_LOST',
      modelRawText: `Raw ${pemRsa} key ${FAKE_ASIA} ${FAKE_SK}`,
      auditedText: `Audited ${pemEc} key ${FAKE_AKIA} ${FAKE_GH} ${FAKE_BEARER}`,
      checkpointBlocks: [{ type: 'text', text: `Block ${FAKE_LONG_B64} ${FAKE_ASIA}` }],
      userMessages: [{ seq: 1, text: `User ${pemRsa} ${FAKE_ASIA}` }],
      report: {
        kind: 'requirements',
        checked: 1,
        polarityFlips: 0,
        worstCoverage: 0,
        lost: [{
          seq: 1,
          reason: 'missing',
          coverage: 0,
          line: `Line ${FAKE_ASIA} ${pemEc}`,
          candidate: `Cand ${FAKE_BEARER}`,
          conflicts: [{ reason: 'polarity', candidate: `Conf ${FAKE_SK}` }],
        }],
      },
    });
    assert.ok(rejectFile, 'audit-reject file should be written');
    const rejectText = await readFile(rejectFile, 'utf8');
    for (const leak of ['BEGIN RSA PRIVATE KEY', 'BEGIN EC PRIVATE KEY', 'DummyBody', FAKE_ASIA, FAKE_AKIA, FAKE_SK, FAKE_GH, 'dummySig', FAKE_LONG_B64]) {
      assert.ok(!rejectText.includes(leak), `audit-reject leaked ${leak}`);
    }
    assert.match(rejectText, /\[redacted-private-key\]/);
    assert.match(rejectText, /\[redacted-key\]/);
    assert.match(rejectText, /\[redacted-token\]/);
    assert.match(rejectText, /\[redacted-blob\]/);

    // 2b. lib/failure-diagnostics.js: multi-line PEM redacted BEFORE first-line split, ASIA redacted,
    // finishDiagnosticAttempt preserves reasoning/cacheWrite/cacheRead tokens, noteDiagnosticMeasurement reinject.
    const diagDir = join(root, 'diag');
    const diag = new FailureDiagnostics(diagDir);
    const pemErr = new Error(`${makePemBlock('OPENSSH PRIVATE KEY')}\nNetwork reset while connecting with ${FAKE_ASIA} and ${FAKE_SK}`);
    let capturedErr;
    try {
      await diag.run({ id: 'sess-diag-1' }, { trigger: 'manual' }, async () => {
        const attempt = beginDiagnosticAttempt({ provider: 'p', model: 'm' }, { maxTokens: 4096, timeoutMs: 5000, retryCount: 1 });
        finishDiagnosticAttempt(attempt, {
          requestStarted: true,
          completed: true,
          outcome: 'failed',
          usage: {
            inputTokens: 1200,
            outputTokens: 300,
            totalTokens: 1500,
            cachedInputTokens: 800,
            cacheReadTokens: 800,
            reasoningTokens: 250,
            cacheWriteTokens: 400,
            cacheCreationTokens: 400,
            cacheCreationInputTokens: 400,
          },
        });
        noteDiagnosticMeasurement(
          { reinjectBytes: 3456, reinjectFiles: 2, effectiveReinjectMaxBytes: 4120, ignoredNeg: -5 },
          { stage: 'reinject' },
        );
        throw pemErr;
      });
    } catch (e) {
      capturedErr = e;
    }
    const receipt = diagnosticFor(capturedErr);
    assert.equal(receipt?.status, 'saved');
    const diagText = await readFile(receipt.path, 'utf8');
    const diagJson = JSON.parse(diagText);
    for (const leak of ['BEGIN OPENSSH PRIVATE KEY', 'DummyBody', FAKE_ASIA, FAKE_SK]) {
      assert.ok(!diagText.includes(leak), `diagnostic report leaked ${leak}`);
    }
    const safeDetail = diagJson.errors?.[0]?.safeDetail ?? '';
    assert.ok(!safeDetail.includes('BEGIN'), 'safeDetail must not contain PEM header');
    assert.ok(!safeDetail.includes(FAKE_ASIA), 'safeDetail must not contain ASIA key');
    assert.deepEqual(diagJson.measurements?.reinject, {
      reinjectBytes: 3456,
      reinjectFiles: 2,
      effectiveReinjectMaxBytes: 4120,
    });
    const usage = diagJson.attempts?.[0]?.usage;
    assert.equal(usage?.reasoningTokens, 250);
    assert.equal(usage?.cacheReadTokens, 800);
    assert.equal(usage?.cacheWriteTokens, 400);
    assert.equal(usage?.cacheCreationTokens, 400);
    assert.equal(usage?.cacheCreationInputTokens, 400);

    // safeRoute blocks ASIA & PEM headers
    const secretCtx = diagnosticContext({
      options: { provider: FAKE_ASIA, model: makePemHeader('RSA PRIVATE KEY') },
    });
    assert.equal(secretCtx.conversation.provider, null);
    assert.equal(secretCtx.conversation.model, null);

    // 2c. lib/audit.js summarizeProvenanceFailures
    const provSum = summarizeProvenanceFailures([
      {
        untrustedSourceMatch: true,
        line: `Untrusted rule ${makePemBlock('RSA PRIVATE KEY')} key=${FAKE_ASIA} ${FAKE_SK}`,
      },
    ]);
    assert.equal(provSum.provenanceKind, 'untrusted-source');
    assert.ok(!provSum.provenanceLine.includes('BEGIN RSA PRIVATE KEY'));
    assert.ok(!provSum.provenanceLine.includes('DummyBody'));
    assert.ok(!provSum.provenanceLine.includes(FAKE_ASIA));
    assert.ok(!provSum.provenanceLine.includes(FAKE_SK));
    assert.ok(provSum.provenanceLine.includes('[redacted-private-key]'));

    // 2d. lib/stage-trace.js
    for (const badCode of [FAKE_ASIA, FAKE_AKIA, `err_${FAKE_ASIA}`, makePemHeader('EC PRIVATE KEY'), FAKE_SK, FAKE_GH]) {
      const cleaned = sanitizeStageMeta({ code: badCode, reason: badCode, count: 3 });
      assert.equal(cleaned.code, undefined, `stage-trace must drop secret code ${badCode}`);
      assert.equal(cleaned.reason, undefined, `stage-trace must drop secret reason ${badCode}`);
      assert.equal(cleaned.count, 3);
    }
    const traced = [];
    withStageTraceContext({ enabled: true, onEvent: (ev) => traced.push(ev) }, () => {
      traceStageSync('test_stage', { code: FAKE_ASIA, reason: 'CONSTRAINT_LOST', count: 2 }, () => 'ok');
    });
    assert.equal(traced[0]?.code, undefined);
    assert.equal(traced[0]?.reason, 'CONSTRAINT_LOST');

    // 2e. lib/state.js
    const stateStore = new SessionStateStore(join(root, 'state'));
    stateStore.update('s-state-1', (prev) => ({
      ...prev,
      failures: 1,
      lastFailureCode: 'ERR_1',
      lastDiagnosticId: 'diag-1',
      lastDiagnosticPath: `/tmp/diag-${FAKE_ASIA}-${FAKE_SK}.json`,
    }));
    const readBack = stateStore.read('s-state-1');
    assert.ok(!readBack.lastDiagnosticPath.includes(FAKE_ASIA));
    assert.ok(!readBack.lastDiagnosticPath.includes(FAKE_SK));
    const breakerSum = publicBreakerSummary({
      stopped: true,
      failures: 3,
      lastDiagnosticPath: `${makePemHeader('PRIVATE KEY')}/diag-${FAKE_AKIA}`,
    });
    assert.ok(!breakerSum.lastDiagnosticPath.includes('BEGIN PRIVATE KEY'));
    assert.ok(!breakerSum.lastDiagnosticPath.includes(FAKE_AKIA));
    const validResumable = validateResumableCompaction({
      version: 1,
      jobId: 'job-1',
      trigger: 'manual',
      status: 'paused_failure',
      createdAt: '2026-11-24T00:00:00Z',
      updatedAt: '2026-11-24T00:00:00Z',
      remainingSeqs: [1, 2],
      initialTotalNodes: 4,
      completedNodes: 2,
      initialTotalTokens: 1000,
      completedTokens: 500,
      completedChunks: 1,
      waveCount: 1,
      allowForeignFallback: false,
      consecutiveFailures: 1,
      lastErrorMessage: `Err ${makePemBlock('RSA PRIVATE KEY')} ${FAKE_ASIA} ${FAKE_BEARER}`,
    });
    assert.ok(!validResumable.lastErrorMessage.includes('BEGIN RSA PRIVATE KEY'));
    assert.ok(!validResumable.lastErrorMessage.includes('DummyBody'));
    assert.ok(!validResumable.lastErrorMessage.includes(FAKE_ASIA));
    assert.ok(!validResumable.lastErrorMessage.includes('dummySig'));
    const pubResumable = publicResumableSummary(validResumable);
    assert.ok(!pubResumable.lastErrorMessage.includes(FAKE_ASIA));

    // 2f. lib/progress-tracker.js: redaction + 5 new telemetry fields
    const tracker = new CompactionProgressTracker();
    const idle = tracker.snapshot('s-pt-idle');
    for (const k of ['auxInputTokens', 'auxReasoningTokens', 'auxCacheReadTokens', 'reinjectBytes', 'reinjectFiles']) {
      assert.equal(idle[k], null, `idle snapshot ${k} must be null`);
    }
    assert.equal(normalizeRetryReasonCode({ code: FAKE_ASIA }), null);
    assert.equal(normalizeRetryReasonCode({ code: makePemHeader('RSA PRIVATE KEY') }), null);
    assert.equal(normalizeRetryReasonCode({ code: `err_${FAKE_ASIA}` }), null);

    await tracker.withRun('s-pt-1', { trigger: 'manual', phase: 'summarizing' }, async () => {
      const duringRun = tracker.snapshot('s-pt-1');
      assert.equal(duringRun.auxInputTokens, null);
      assert.equal(duringRun.reinjectBytes, null);

      tracker.update('s-pt-1', {
        message: `Retrying ${makePemBlock('EC PRIVATE KEY')} ${FAKE_ASIA} ${FAKE_SK}`,
        summaryModel: FAKE_ASIA,
        retryReasonCode: FAKE_ASIA,
        messageParams: { chunkIndex: 1, bad: FAKE_ASIA, badPem: makePemHeader('PRIVATE KEY') },
        auxInputTokens: 10000,
        auxReasoningTokens: 1200,
        auxCacheReadTokens: 7500,
        reinjectBytes: 4096,
        reinjectFiles: 3,
      });
      // Negative/invalid values must be ignored.
      tracker.update('s-pt-1', { auxInputTokens: -10, reinjectBytes: NaN });

      const snap = tracker.snapshot('s-pt-1');
      assert.ok(!snap.message.includes('BEGIN EC PRIVATE KEY'));
      assert.ok(!snap.message.includes(FAKE_ASIA));
      assert.ok(!snap.message.includes(FAKE_SK));
      assert.equal(snap.summaryModel, null);
      assert.equal(snap.retryReasonCode, null);
      assert.equal(snap.messageParams.chunkIndex, 1);
      assert.equal(snap.messageParams.bad, undefined);
      assert.equal(snap.messageParams.badPem, undefined);
      assert.equal(snap.auxInputTokens, 10000);
      assert.equal(snap.auxReasoningTokens, 1200);
      assert.equal(snap.auxCacheReadTokens, 7500);
      assert.equal(snap.reinjectBytes, 4096);
      assert.equal(snap.reinjectFiles, 3);
    });
    const done = tracker.snapshot('s-pt-1');
    assert.equal(done.auxInputTokens, 10000);
    assert.equal(done.auxReasoningTokens, 1200);
    assert.equal(done.auxCacheReadTokens, 7500);
    assert.equal(done.reinjectBytes, 4096);
    assert.equal(done.reinjectFiles, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 3. lib/client.js sandbox: redaction, telemetry pills, hints & no ESM ─────

await test('client-js-sandbox-redacts-pem-asia-renders-telemetry-pills-and-documents-phase1-hints', async () => {
  const clientSrc = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  // Single-file browser bundle must contain zero ESM import/export statements.
  assert.equal(/^\s*(?:import|export)\s/m.test(clientSrc), false, 'lib/client.js must contain zero ESM import/export statements');

  for (const language of ['zh', 'en']) {
    let statusPayload = {
      active: true,
      runId: 'run-p1-ui',
      seq: 7,
      sessionId: 'sess-p1-ui',
      trigger: 'manual',
      phase: 'summarizing',
      elapsedMs: 1500,
      chunkIndex: 1,
      chunkTotal: 2,
      attempt: 2,
      maxAttempts: 3,
      retryReasonCode: makePemHeader('RSA PRIVATE KEY'),
      auxInputTokens: 10000,
      auxReasoningTokens: 1200,
      auxCacheReadTokens: 7500,
      reinjectBytes: 4096,
      reinjectFiles: 3,
      summaryModel: 'p/m',
    };

    const mnt = mountClientSandbox({ language, handler: () => statusPayload });
    const ui = mnt.applyClient(clientSrc);
    try {
      // Hint strings check on both dictionaries
      for (const lang of ['zh', 'en']) {
        const cjkHint = ui.dictionaries[lang].summaryCjkTokensPerCharHint;
        const reinjectHint = ui.dictionaries[lang].postCompactReinjectHint;
        assert.match(cjkHint, /chars\/4/);
        assert.match(cjkHint, /0\.75/);
        assert.match(cjkHint, /2\.5\s*KB/i);
        assert.match(cjkHint, /645.*697/);
        assert.match(reinjectHint, /64k/i);
        assert.match(reinjectHint, lang === 'zh' ? /0 次额外摘要模型调用/ : /0 extra summary LLM calls/);
        assert.match(reinjectHint, /24KB/);
      }

      ui.render({ sessionId: 'sess-p1-ui' });
      let tree = await ui.settle();
      let telemetry = findNode(tree, (n) => n.props?.['data-compaction-telemetry'] === 'true');
      assert.ok(telemetry, `${language}: telemetry row must render`);
      assert.equal(telemetry.props['data-retry-reason'], undefined, `${language}: PEM in retryReasonCode must be rejected`);
      const text1 = textOf(telemetry);
      assert.ok(!text1.includes('BEGIN'), 'PEM must not leak in UI telemetry');
      if (language === 'zh') {
        assert.match(text1, /摘要缓存命中 43%/);
        assert.match(text1, /摘要思考 1\.2k/);
        assert.match(text1, /重注入 3 文件 \(4 KiB\)/);
      } else {
        assert.match(text1, /Summary cache hit 43%/);
        assert.match(text1, /Summary reasoning 1\.2k/);
        assert.match(text1, /Reinjected 3 files \(4 KiB\)/);
      }

      // Update with ASIA in retryReasonCode and mixed uncached/cached input -> 60% = 1500 / (1000 + 1500), constant seq still diffs!
      statusPayload = {
        ...statusPayload,
        retryReasonCode: FAKE_ASIA,
        auxInputTokens: 1000,
        auxCacheReadTokens: 1500,
        auxReasoningTokens: 420,
        reinjectBytes: 512,
        reinjectFiles: 1,
      };
      tree = await ui.fireNextTimer();
      telemetry = findNode(tree, (n) => n.props?.['data-compaction-telemetry'] === 'true');
      assert.equal(telemetry.props['data-retry-reason'], undefined, `${language}: ASIA in retryReasonCode must be rejected`);
      const text2 = textOf(telemetry);
      assert.ok(!text2.includes(FAKE_ASIA));
      assert.match(text2, language === 'zh' ? /摘要缓存命中 60%/ : /Summary cache hit 60%/);
      assert.match(text2, language === 'zh' ? /摘要思考 420/ : /Summary reasoning 420/);
      assert.match(text2, language === 'zh' ? /重注入 1 文件 \(512 B\)/ : /Reinjected 1 files \(512 B\)/);

      // Prefixed ASIA also rejected
      statusPayload = {
        ...statusPayload,
        retryReasonCode: `err_${FAKE_ASIA}`,
        auxCacheReadTokens: 0,
        auxReasoningTokens: 0,
        reinjectBytes: 0,
      };
      tree = await ui.fireNextTimer();
      telemetry = findNode(tree, (n) => n.props?.['data-compaction-telemetry'] === 'true');
      assert.equal(telemetry.props['data-retry-reason'], undefined);
      const text3 = textOf(telemetry);
      assert.doesNotMatch(text3, /摘要缓存命中|Summary cache hit|摘要思考|Summary reasoning|重注入|Reinjected/);
    } finally {
      ui.unmount();
    }
  }
});

// ── 4. 4-Tool Schema Slimming & Runtime HISTORY_SNAPSHOT_WARNING ────────────

await test('schema-slimming-under-750-bpe-tokens-preserves-all-fields-and-runtime-warning', async () => {
  const registeredProactive = [];
  assert.equal(
    registerCompactionTool(
      { tools: { register: (spec) => { registeredProactive.push(spec); return () => {}; } } },
      { config: DEFAULT_CONFIG, proactive: { request: async () => ({}) } },
    ),
    true,
  );
  assert.equal(registeredProactive.length, 1);

  const all4Tools = [...HISTORY_TOOLS, ...registeredProactive].map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters ?? t.inputSchema,
  }));
  const serialized = JSON.stringify(all4Tools);
  const tokens = bpeTokens(serialized);
  assert.ok(tokens <= 750, `Expected combined 4-tool schema <= 750 BPE tokens, got ${tokens} (${serialized.length} bytes)`);

  assert.deepEqual(
    all4Tools.map((t) => t.name),
    ['history_list', 'history_read', 'history_search', COMPACTION_TOOL_NAME],
  );

  // HISTORY_SNAPSHOT_WARNING export intact, NOT duplicated inside schema descriptions.
  assert.equal(typeof HISTORY_SNAPSHOT_WARNING, 'string');
  assert.ok(HISTORY_SNAPSHOT_WARNING.length > 20);
  for (const t of HISTORY_TOOLS) {
    assert.equal(t.description.includes(HISTORY_SNAPSHOT_WARNING), false, `${t.name} description must not duplicate HISTORY_SNAPSHOT_WARNING`);
  }

  // Exact schema invariants on all 4 tools.
  for (const t of all4Tools) {
    assert.equal(t.parameters.type, 'object');
    assert.equal(t.parameters.additionalProperties, false, `${t.name} additionalProperties must be false`);
  }
  const readSpec = all4Tools.find((t) => t.name === 'history_read');
  const expectedReadProps = {
    compactionId: 'string',
    attachmentId: 'string',
    rawBase64: 'boolean',
    byteOffset: 'integer',
    byteLimit: 'integer',
    offset: 'integer',
    limit: 'integer',
    seq: 'integer',
    raw: 'boolean',
    charOffset: 'integer',
    charLimit: 'integer',
    full: 'boolean',
  };
  assert.deepEqual(Object.keys(readSpec.parameters.properties).sort(), Object.keys(expectedReadProps).sort());
  for (const [prop, expectedType] of Object.entries(expectedReadProps)) {
    assert.equal(readSpec.parameters.properties[prop].type, expectedType, `history_read.${prop}.type`);
  }
  assert.equal(readSpec.parameters.required, undefined);
  assert.deepEqual(all4Tools.find((t) => t.name === 'history_search').parameters.required, ['query']);
  assert.deepEqual(all4Tools.find((t) => t.name === 'context_compact').parameters.required, ['reason']);

  // Runtime outputs for history_read (formatted + raw) still include HISTORY_SNAPSHOT_WARNING,
  // and history_list returns archived span listing cleanly.
  const root = await mkdtemp(join(TEST_BASE, 'weave-phase1-tools-'));
  try {
    const archive = new CompactionArchive({ root: join(root, 'archive') });
    const session = {
      id: 'sess-tools-runtime',
      eventAt: (seq) => (seq === 1 ? { seq: 1, time: 1000, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'Keep strict tests.' }] } } : null),
      deriveEventMessage: (ev) => ev?.data,
    };
    await archive.writeSpan({ sessionId: session.id, compactionId: 'cmp-rt-1', entries: [{ seq: 1, type: 'user/message', text: 'Keep strict tests.', message: session.eventAt(1).data }] });

    const registeredTools = new Map();
    registerHistoryTools(
      { tools: { register: (t) => { registeredTools.set(t.name, t); return () => {}; } }, logger: { info() {}, warn() {} } },
      { archiveEnabled: true, archiveDir: archive.root },
      archive,
    );
    const execCtx = { session: { id: session.id } };
    const listOut = await registeredTools.get('history_list').execute({}, execCtx);
    assert.ok(listOut.includes('cmp-rt-1'), 'history_list should list archived compactionId');

    const readTextOut = await registeredTools.get('history_read').execute({ compactionId: 'cmp-rt-1' }, execCtx);
    assert.ok(readTextOut.includes(HISTORY_SNAPSHOT_WARNING), 'history_read text output must include HISTORY_SNAPSHOT_WARNING');

    const readRawOut = await registeredTools.get('history_read').execute({ seq: 1, raw: true }, execCtx);
    assert.equal(JSON.parse(readRawOut).snapshotWarning, HISTORY_SNAPSHOT_WARNING, 'history_read raw JSON must include snapshotWarning');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 5. Adaptive Small-Window Reinjection + Explicit Overrides + E2E 64k ─────

await test('adaptive-reinject-limits-scale-on-64k-and-honor-explicit-overrides', () => {
  const defaultCfg = resolveConfig().config;
  assert.equal(DEFAULT_CONFIG.postCompactReinjectMaxBytes, 24576);
  assert.equal(DEFAULT_CONFIG.postCompactReinjectMaxFiles, 5);
  assert.equal(DEFAULT_CONFIG.postCompactReinjectMaxFileBytes, 6144);
  assert.equal(defaultCfg[EXPLICIT_CONFIG_KEYS].size, 0);

  // 200k window keeps full defaults
  const spec200k = resolveCompactSpec(defaultCfg, 200000, 8192);
  const res200k = resolveAdaptiveReinjectLimits({ policy: defaultCfg, spec: spec200k });
  assert.deepEqual(res200k, { maxFiles: 5, maxBytes: 24576, maxFileBytes: 6144, adaptiveApplied: false });

  // 64k small window (headroom=33000, retainTokens=9175, threshold=19475) scales down <= 4500 B
  const res64kTight = resolveAdaptiveReinjectLimits({
    policy: defaultCfg,
    spec: { headroomTokens: 33000, retainTokens: 9175, thresholdTokens: 19475 },
  });
  assert.equal(res64kTight.adaptiveApplied, true);
  assert.ok(res64kTight.maxBytes > 0 && res64kTight.maxBytes <= 4500, `expected <= 4500 B, got ${res64kTight.maxBytes}`);
  assert.ok(res64kTight.maxFiles >= 1 && res64kTight.maxFiles <= 2);
  assert.equal(res64kTight.maxFileBytes, res64kTight.maxBytes);

  // Explicit default value retains small-window adaptive scaling
  const explicitDefaultCfg = resolveConfig({ postCompactReinjectMaxBytes: 24576 }).config;
  assert.equal(explicitDefaultCfg[EXPLICIT_CONFIG_KEYS].has('postCompactReinjectMaxBytes'), true);
  const resExplicit24k = resolveAdaptiveReinjectLimits({
    policy: explicitDefaultCfg,
    spec: { headroomTokens: 33000, retainTokens: 9175, thresholdTokens: 19475 },
  });
  assert.deepEqual(resExplicit24k, res64kTight);

  // Explicit override 16384
  const explicit16kCfg = resolveConfig({ postCompactReinjectMaxBytes: 16384 }).config;
  const resExplicit16k = resolveAdaptiveReinjectLimits({
    policy: explicit16kCfg,
    spec: { headroomTokens: 33000, retainTokens: 9175, thresholdTokens: 19475 },
  });
  assert.deepEqual(resExplicit16k, { maxFiles: 5, maxBytes: 16384, maxFileBytes: 6144, adaptiveApplied: false });

  // Explicit override via modelPolicies
  const withPolicyCfg = resolveConfig({
    modelPolicies: [{ provider: 'p', model: 'small-64k', postCompactReinjectMaxBytes: 24576 }],
  }).config;
  const mergedPolicy = resolveTargetPolicy(withPolicyCfg, 'p', 'small-64k');
  assert.equal(mergedPolicy[EXPLICIT_CONFIG_KEYS].has('postCompactReinjectMaxBytes'), true);
  const resModelPolicy = resolveAdaptiveReinjectLimits({
    policy: mergedPolicy,
    spec: { headroomTokens: 33000, retainTokens: 9175, thresholdTokens: 19475 },
  });
  assert.deepEqual(resModelPolicy, res64kTight);
});

await test('e2e-64k-engine-compaction-bounds-reinject-and-records-telemetry', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-phase1-e2e-64k-'));
  const workspace = join(root, 'ws');
  try {
    await mkdir(join(workspace, 'src'), { recursive: true });
    // Write 5 active files (~5 KB each = ~25 KB total) so unscaled 24KB would inject ~4-5 files (~20KB+),
    // while 64k tight thresholdRatio=0.3 (threshold=19660, retain=9175 -> runwayCap=4194 B) bounds <active-workspace-files>.
    for (let i = 1; i <= 5; i += 1) {
      await writeFile(
        join(workspace, 'src', `mod${i}.js`),
        `// module ${i}\n` + `export const v${i} = "${'x'.repeat(120)}";\n`.repeat(38),
        'utf8',
      );
    }

    const events = [];
    const surface = { nodes: [], replaceGeneration: 0 };
    const session = {
      id: `sess-e2e-64k-${randomUUID()}`,
      header: { version: 4, id: 'placeholder', createdAt: Date.now() - 10000, isSeeded: false, cwd: workspace },
      surface,
      get seq() { return events.length; },
      eventAt: (seq) => events[seq],
      snapshotEvents: () => [...events],
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' } }),
      toolHistory: () => [],
      deriveEventMessage(ev) {
        if (!ev) return undefined;
        if (ev.type === 'system/message') return ev.data.message;
        if (ev.type === 'user/message') return ev.data;
        if (ev.type === 'assistant/message') return ev.data.message;
        if (ev.type === 'tool/result') {
          const m = ev.data.message ?? ev.data;
          return { role: 'tool', toolCallId: m.toolCallId ?? m.source?.callId, content: m.content };
        }
        return undefined;
      },
      append(type, data, options = {}) {
        const ev = {
          seq: events.length,
          time: Date.now(),
          type,
          data,
          ...(options.surfaceOp !== undefined ? { surfaceOp: options.surfaceOp } : {}),
          ...(Array.isArray(options.sourceEventSeqs) ? { sourceEventSeqs: [...options.sourceEventSeqs] } : {}),
        };
        events.push(ev);
        const op = options.surfaceOp;
        if (op?.op === 'replace') {
          const s = surface.nodes.indexOf(op.startSeq);
          const e = surface.nodes.indexOf(op.endSeq);
          assert.ok(s >= 0 && e >= s);
          surface.nodes.splice(s, e - s + 1, ev.seq);
          surface.replaceGeneration += 1;
        } else if (op === 'append') {
          surface.nodes.push(ev.seq);
        }
        return ev;
      },
    };
    session.header.id = session.id;

    const addSystem = (text) => session.append('system/message', { message: { id: randomUUID(), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' });
    const addUser = (text) => session.append('user/message', { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' });
    const addAssistant = (text) => session.append('assistant/message', { message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-reasoner' } } }, { surfaceOp: 'append' });
    const addTool = (path) => {
      const callId = `call-${randomUUID().slice(0, 8)}`;
      const argsJson = JSON.stringify({ path });
      session.append('assistant/message', { message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-reasoner' }, content: [{ type: 'tool-call', id: callId, name: 'write_file', arguments: argsJson }] } }, { surfaceOp: 'append' });
      const tc = session.append('tool/call', { callId, name: 'write_file', arguments: argsJson });
      session.append('tool/result', { message: { id: randomUUID(), role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, content: [{ type: 'text', text: `Wrote ${path}` }] } }, { surfaceOp: 'append', sourceEventSeqs: [tc.seq] });
    };

    const ctx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      tokenMeter: {
        measure(s) {
          const nodes = s.surface.nodes.map((seq) => {
            const msg = s.deriveEventMessage(s.eventAt(seq));
            const tokens = Math.max(1, approxTokens(blocksToText(msg?.content)));
            return { seq, tokens, heuristicTokens: tokens };
          });
          const totalTokens = nodes.reduce((sum, n) => sum + n.tokens, 0);
          return { totalTokens, surfaceTokens: totalTokens, nodes, baseline: { kind: 'heuristic' } };
        },
        estimateMessage: (m) => Math.max(1, approxTokens(blocksToText(m?.content))),
      },
      llm: {
        resolveModelInfo: async () => ({ contextWindow: 65536, maxOutputTokens: 8192 }),
        async *stream() {
          yield { type: 'text-delta', text: makeSummary('Keep deterministic integer billing.') };
          yield {
            type: 'usage',
            usage: { inputTokens: 8000, outputTokens: 200, totalTokens: 8200, reasoningTokens: 320, cacheReadTokens: 6000 },
          };
          yield { type: 'finish', kind: 'stop' };
        },
      },
      sessions: { flush: async () => true, get: (id) => (id === session.id ? session : null) },
      tools: { register: () => () => {} },
      provide: () => {},
      get: () => undefined,
    };

    // thresholdRatio 0.3 on 65536 window -> thresholdTokens=19660, retainTokens=9175 -> adaptive cap=4194 B
    const engine = new WeaveCompactionEngine(
      ctx,
      resolveConfig({
        archiveDir: join(root, 'archive'),
        thresholdRatio: 0.3,
        headroomTokens: 33000,
        summaryRetryCount: 0,
        summaryConcurrency: 1,
        observationMaskingEnabled: false,
        proactiveEnabled: false,
        cachePreservePrefix: false,
      }).config,
    );
    engine.historyToolsAvailable = true;

    addSystem('System prompt.');
    addUser('Keep deterministic integer billing.');
    for (let i = 1; i <= 5; i += 1) addTool(`src/mod${i}.js`);
    addAssistant('Long engineering analysis trace for 64k window compaction. '.repeat(900));
    addUser('Continue verifying the next step.');
    addAssistant('Ready.');

    const agent = {
      session,
      options: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
      runMaintenance: (fn) => fn(new AbortController().signal),
    };

    const res = await engine.compactNow(agent, new AbortController().signal, 'cmd-64k-e2e');
    assert.ok(res?.compactionId, '64k compaction should succeed');

    const cpSeq = session.surface.nodes.find(
      (seq) => session.deriveEventMessage(session.eventAt(seq))?.source?.kind === 'compact-checkpoint',
    );
    assert.equal(typeof cpSeq, 'number');
    const cpText = blocksToText(session.deriveEventMessage(session.eventAt(cpSeq)).content);
    const activeMatch = /<active-workspace-files\b[^>]*>[\s\S]*?<\/active-workspace-files>/.exec(cpText);
    assert.ok(activeMatch, 'expected bounded <active-workspace-files> block in 64k checkpoint');
    assert.ok(Buffer.byteLength(activeMatch[0], 'utf8') <= 4500, `expected bounded <active-workspace-files> <= 4500 B, got ${Buffer.byteLength(activeMatch[0], 'utf8')}`);

    const snap = engine.progressTracker.snapshot(session.id);
    assert.ok(snap.reinjectBytes > 0 && snap.reinjectBytes <= 4194, `expected reinjectBytes in (0, 4194], got ${snap.reinjectBytes}`);
    assert.ok(snap.reinjectFiles >= 1 && snap.reinjectFiles <= 2, `expected reinjectFiles in [1, 2], got ${snap.reinjectFiles}`);
    assert.equal(snap.auxInputTokens, 8000);
    assert.equal(snap.auxReasoningTokens, 320);
    assert.equal(snap.auxCacheReadTokens, 6000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 6. summaryReasoningEffort: 'auto' across Anthropic, non-Anthropic, & OFF ─

await test('summary-reasoning-effort-auto-anthropic-inherit-non-anthropic-low-and-off-undefined', async () => {
  const anthropicTarget = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
  const deepseekTarget = { provider: 'deepseek', model: 'deepseek-reasoner' };

  assert.equal(isAnthropicReasoningRoute(anthropicTarget), true);
  assert.equal(isAnthropicReasoningRoute(deepseekTarget), false);

  // Pure resolveReasoningEffort matrix
  assert.equal(resolveReasoningEffort('high', 'auto', anthropicTarget), 'high');
  assert.equal(resolveReasoningEffort('high', 'auto', deepseekTarget), 'low');
  assert.equal(resolveReasoningEffort(undefined, 'auto', anthropicTarget), undefined);
  assert.equal(resolveReasoningEffort(undefined, 'auto', deepseekTarget), undefined);
  assert.equal(resolveReasoningEffort(null, 'auto', anthropicTarget), undefined);

  // Actual request emission via summarizeWithTarget / summarizeWithChain (same-route + cross-route)
  const captured = [];
  const ctx = {
    llm: {
      resolveModelInfo: async () => ({ contextWindow: 200000, maxOutputTokens: 8192, reasoning: { efforts: ['low', 'medium', 'high'] } }),
      async *stream(req) {
        captured.push(req);
        yield { type: 'text-delta', text: makeSummary() };
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } };
        yield { type: 'finish', kind: 'stop' };
      },
    },
  };
  const cfg = resolveConfig().config;
  const capacity = await resolveSummaryCapacity(
    ctx,
    { targets: [anthropicTarget, deepseekTarget], source: 'test' },
    cfg,
    new AbortController().signal,
  );
  const baseOpts = {
    maxTokens: 2048,
    timeoutMs: 5000,
    language: 'en',
    reasoningEffortPolicy: 'auto',
    capacity,
  };
  const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize work.' }] }] };

  // 1) Anthropic same-route with high -> inherits 'high'
  await summarizeWithTarget({
    ctx,
    agent: { session: { id: 's-auto-1' } },
    input,
    target: anthropicTarget,
    options: { ...baseOpts, primary: { ...anthropicTarget, reasoningEffort: 'high' } },
    signal: new AbortController().signal,
  });
  assert.equal(captured.at(-1).reasoningEffort, 'high');

  // 2) Non-Anthropic same-route with high -> 'low'
  await summarizeWithTarget({
    ctx,
    agent: { session: { id: 's-auto-2' } },
    input,
    target: deepseekTarget,
    options: { ...baseOpts, primary: { ...deepseekTarget, reasoningEffort: 'high' } },
    signal: new AbortController().signal,
  });
  assert.equal(captured.at(-1).reasoningEffort, 'low');

  // 3) Thinking OFF on same-route Anthropic -> undefined (omitted)
  await summarizeWithTarget({
    ctx,
    agent: { session: { id: 's-auto-3' } },
    input,
    target: anthropicTarget,
    options: { ...baseOpts, primary: { ...anthropicTarget } },
    signal: new AbortController().signal,
  });
  assert.equal(Object.hasOwn(captured.at(-1), 'reasoningEffort'), false);

  // 4) Thinking OFF on cross-route (DeepSeek OFF -> Anthropic summary) -> undefined (omitted)
  await summarizeWithChain({
    ctx,
    agent: { session: { id: 's-auto-4' } },
    input,
    chain: { targets: [anthropicTarget], source: 'config' },
    options: { ...baseOpts, retryCount: 0, retryDelayMs: 0, primary: { ...deepseekTarget } },
    signal: new AbortController().signal,
  });
  assert.equal(Object.hasOwn(captured.at(-1), 'reasoningEffort'), false);

  // 5) Thinking OFF on cross-route (Anthropic OFF -> DeepSeek summary) -> undefined (omitted)
  await summarizeWithChain({
    ctx,
    agent: { session: { id: 's-auto-5' } },
    input,
    chain: { targets: [deepseekTarget], source: 'config' },
    options: { ...baseOpts, retryCount: 0, retryDelayMs: 0, primary: { ...anthropicTarget } },
    signal: new AbortController().signal,
  });
  assert.equal(Object.hasOwn(captured.at(-1), 'reasoningEffort'), false);
});

console.log(JSON.stringify({
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
}, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
