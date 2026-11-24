import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  auditCompaction,
  auditInstructionProvenance,
} from '../lib/audit.js';
import {
  DEFAULT_CONFIG,
  normalizeAuditCoverageScope,
  resolveConfig,
  resolveTargetPolicy,
} from '../lib/config.js';
import { auditMemorySelection } from '../lib/constraint-scope.js';
import { compactCheckpointSource, WeaveCompactionEngine } from '../lib/engine.js';
import { apply as mountGate, SUMMARY_RPC_PATH } from '../lib/index.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import {
  buildCompactionInstruction,
  renderRepairFeedback,
} from '../lib/prompt.js';
import { preservedForSource, selectSessionMemory } from '../lib/region.js';
import {
  handleSummaryConfigRpc,
  mergeSummaryConfig,
  readSummaryConfig,
  validateSummaryConfig,
} from '../lib/summary-config.js';

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
const EN_HEADINGS = buildCompactionInstruction('en')
  .split('\n')
  .filter((line) => /^## [1-9]\./.test(line));

function makeEnSummary(body, section6 = '[filled by engine]') {
  return EN_HEADINGS
    .map((heading, idx) => `${heading}\n${idx === 5 ? section6 : idx === 8 ? body : 'Archived progress.'}`)
    .join('\n\n');
}

function makeLiveSession(id = `track-a-${randomUUID()}`) {
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  return {
    id,
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => [...events],
    requestHeader: () => ({ config: { provider: 'openai', model: 'gpt-4o', maxTokens: 4096 } }),
    toolHistory: () => [],
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (event.type === 'assistant/message') return event.data?.message ?? event.data;
      if (event.type === 'tool/result') return { role: 'tool', content: event.data?.content ?? event.data };
      if (event.type.endsWith('/message')) return event.data;
      return undefined;
    },
    append(type, data, options = {}) {
      const event = { seq: events.length, time: Date.now(), type, data };
      events.push(event);
      const op = options.surfaceOp;
      if (op?.op === 'replace') {
        const startIdx = surface.nodes.indexOf(op.startSeq);
        const endIdx = surface.nodes.indexOf(op.endSeq);
        assert.ok(startIdx >= 0 && endIdx >= startIdx, 'invalid replace range');
        surface.nodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
        surface.replaceGeneration += 1;
      } else if (op === 'append') {
        surface.nodes.push(event.seq);
      }
      return event;
    },
  };
}

function addMessage(session, role, text, { source, appendToSurface = true } = {}) {
  const data =
    role === 'assistant'
      ? { message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }], source: source ?? { kind: 'fixture' } } }
      : { id: randomUUID(), role, content: [{ type: 'text', text }], source: source ?? { kind: 'user' } };
  return session.append(`${role}/message`, data, appendToSurface ? { surfaceOp: 'append' } : {});
}

function buildMultiGenLongSession({ ancientCount = 122, includeAncientRedlines = true } = {}) {
  const session = makeLiveSession();
  addMessage(session, 'system', 'System policy active.');

  const ancientSeqs = [];
  if (includeAncientRedlines) {
    ancientSeqs.push(addMessage(session, 'user', 'Do not delete production records.', { appendToSurface: false }).seq);
    ancientSeqs.push(addMessage(session, 'user', 'Must use port 8080.', { appendToSurface: false }).seq);
    ancientSeqs.push(addMessage(session, 'user', 'If staging flag is set, deploy canary.', { appendToSurface: false }).seq);
  }
  while (ancientSeqs.length < ancientCount) {
    const idx = ancientSeqs.length + 1;
    ancientSeqs.push(
      addMessage(session, 'user', `Always validate invariant alpha_${idx} before commit.`, { appendToSurface: false }).seq,
    );
  }

  // Materialize a prior checkpoint whose memorySources + preserved point to ancientSeqs (off-surface now).
  const preservedAncient = ancientSeqs.map((seq) => {
    const msg = session.deriveEventMessage(session.eventAt(seq));
    return { seq, text: blocksToText(msg.content) };
  });
  const src = compactCheckpointSource('compaction-prev', undefined, preservedForSource(preservedAncient));
  const cpEvent = addMessage(
    session,
    'user',
    `<compacted-summary>\n${makeEnSummary('Previous checkpoint condensed older milestones.', preservedAncient.map((p) => `- seq ${p.seq}: ${p.text}`).join('\n'))}\n</compacted-summary>`,
    { source: src, appendToSurface: true },
  );

  // Recent raw turn messages directly in the new span
  const spanRawSeqs = [];
  spanRawSeqs.push(addMessage(session, 'user', 'Must keep audit telemetry JSON structured.').seq);
  addMessage(session, 'assistant', 'Working on telemetry structure. ' + 'trace '.repeat(200));
  spanRawSeqs.push(addMessage(session, 'user', 'Keep request timeout at 15 seconds.').seq);
  addMessage(session, 'assistant', 'Timeout set cleanly. ' + 'ok '.repeat(120));
  const newestUserSeq = addMessage(session, 'user', 'Always require schema checks before saving config.').seq;
  spanRawSeqs.push(newestUserSeq);
  addMessage(session, 'assistant', 'Schema checks ready.');

  return {
    session,
    ancientSeqs,
    cpSeq: cpEvent.seq,
    spanRawSeqs,
    newestUserSeq,
    spanSeqs: session.surface.nodes.slice(1),
  };
}

function findNode(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of tree.children ?? []) {
    const hit = findNode(child, predicate);
    if (hit) return hit;
  }
  return null;
}

function textOf(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (!tree || typeof tree !== 'object') return '';
  return (tree.children ?? []).map(textOf).join(' ');
}

function mountClientSettings({ language = 'zh', rpcHandler }) {
  const source = readFileSync(join(REPO_ROOT, 'lib/client.js'), 'utf8');
  let mod = null;
  let Section = null;
  let dictionaries = null;
  const states = [];
  const effects = [];
  let stateIndex = 0;
  let effectIndex = 0;
  const pending = new Set();
  const requests = [];

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
    }),
    useState: (initial) => {
      const i = stateIndex++;
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
      return [
        states[i],
        (val) => {
          states[i] = typeof val === 'function' ? val(states[i]) : val;
        },
      ];
    },
    useEffect: (cb, deps) => {
      const i = effectIndex++;
      if (!effects[i] || (deps && deps.length > 0)) {
        effects[i] = { callback: cb, pending: true };
      }
    },
  };

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(declaration) {
          mod = declaration.factory((name) => {
            assert.equal(name, 'react');
            return React;
          });
        },
      },
    },
    console,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval: () => {
      throw new Error('lib/client.js must never call setInterval');
    },
    clearInterval: () => {},
    fetch: (url, options) => {
      assert.equal(url, SUMMARY_RPC_PATH);
      const payload = JSON.parse(options.body);
      requests.push(payload);
      const task = (async () => {
        try {
          const value = await rpcHandler(payload);
          return { status: 200, text: async () => JSON.stringify({ ok: true, value }) };
        } catch (err) {
          return {
            status: 400,
            text: async () => JSON.stringify({ ok: false, error: { code: err?.code ?? 'ERR', message: err?.message ?? String(err) } }),
          };
        }
      })();
      pending.add(task);
      task.finally(() => pending.delete(task));
      return task;
    },
  };

  vm.runInNewContext(source, sandbox);
  mod.apply({
    locale: {
      register(_ns, dicts) {
        dictionaries = dicts;
      },
      bind: () => (key) => dictionaries?.[language]?.[key] ?? dictionaries?.zh?.[key] ?? key,
    },
    effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
    slots: {
      inject: (_name, fn) => fn(),
      register: (def, component) => {
        if (def?.name === 'settings.section') Section = component;
        return () => {};
      },
    },
  });
  assert.equal(typeof Section, 'function');

  const render = () => {
    stateIndex = 0;
    effectIndex = 0;
    const tree = Section();
    for (const entry of effects) {
      if (entry?.pending) {
        entry.pending = false;
        entry.callback();
      }
    }
    return tree;
  };
  const settle = async () => {
    let tree = render();
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
      await new Promise((r) => setTimeout(r, 0));
      tree = render();
    }
    return tree;
  };
  return {
    requests,
    render,
    settle,
    field: (tree, id) => findNode(tree, (n) => n.props?.id === id),
    button: (tree, label) => findNode(tree, (n) => n.type === 'button' && n.children?.includes(label)),
  };
}

function mountClientProgress({ language = 'zh', handler }) {
  const source = readFileSync(join(REPO_ROOT, 'lib/client.js'), 'utf8');
  let mod = null;
  let ProgressCard = null;
  let dictionaries = null;
  const states = [];
  const effects = [];
  let stateIndex = 0;
  let effectIndex = 0;
  let currentProps = { sessionId: 's-init' };

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
    }),
    useState: (initial) => {
      const i = stateIndex++;
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
      return [
        states[i],
        (val) => {
          states[i] = typeof val === 'function' ? val(states[i]) : val;
        },
      ];
    },
    useEffect: (cb, deps) => {
      const i = effectIndex++;
      const prev = effects[i];
      const changed = !prev || !deps || deps.some((d, idx) => d !== prev.deps?.[idx]);
      if (changed) effects[i] = { deps, cb, pending: true };
    },
  };

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(declaration) {
          mod = declaration.factory(() => React);
        },
      },
    },
    console,
    AbortController,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => {
      throw new Error('lib/client.js must never call setInterval');
    },
    clearInterval: () => {},
    fetch: async (_url, options) => {
      const payload = JSON.parse(options.body);
      const value = await handler(payload);
      return { status: 200, text: async () => JSON.stringify({ ok: true, value }) };
    },
  };

  vm.runInNewContext(source, sandbox);
  mod.apply({
    locale: {
      register(_ns, dicts) {
        dictionaries = dicts;
      },
      bind: () => (key) => dictionaries?.[language]?.[key] ?? dictionaries?.zh?.[key] ?? key,
    },
    effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
    slots: {
      inject: (_name, fn) => fn(),
      register: (def, component) => {
        if (def?.name === 'conversation.input.dock') ProgressCard = component;
        return () => {};
      },
    },
  });
  assert.equal(typeof ProgressCard, 'function');

  return {
    async renderAndPoll(props) {
      currentProps = props;
      stateIndex = 0;
      effectIndex = 0;
      let tree = ProgressCard(currentProps);
      for (const e of effects) {
        if (e?.pending) {
          e.pending = false;
          e.cb();
        }
      }
      await new Promise((r) => setTimeout(r, 15));
      stateIndex = 0;
      effectIndex = 0;
      tree = ProgressCard(currentProps);
      return { tree, states };
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

await test('a1-multi-gen-120-plus-rules-recent-allows-ancient-omissions-and-enforces-recent', () => {
  const { session, ancientSeqs, spanRawSeqs, newestUserSeq, spanSeqs } = buildMultiGenLongSession({ ancientCount: 122 });
  const selection = selectSessionMemory(session, spanSeqs, {
    coverageMaxMessages: 3,
    coverageMaxTokens: 500,
    approxTokens,
  });

  assert.ok(selection.directSpanSeqs instanceof Set);
  assert.ok(selection.recentWindowSeqs instanceof Set);
  assert.deepEqual([...selection.directSpanSeqs].sort((a, b) => a - b), [...spanRawSeqs].sort((a, b) => a - b));
  assert.ok(selection.recentWindowSeqs.has(newestUserSeq));
  for (const oldSeq of ancientSeqs) {
    assert.equal(selection.recentWindowSeqs.has(oldSeq), false, `ancient seq ${oldSeq} should fall outside recentWindowSeqs`);
  }

  const recentCheckpointText = [
    'Must keep audit telemetry JSON structured.',
    'Keep request timeout at 15 seconds.',
    'Always require schema checks before saving config.',
  ].join('\n');

  const okReport = auditMemorySelection({
    selection,
    summaryText: makeEnSummary('Continue schema validation work with telemetry intact.'),
    checkpointText: recentCheckpointText,
    threshold: 0.6,
    coverageScope: 'recent',
    includeAllConflicts: true,
  });
  assert.ok(okReport.checked >= 120, `expected full check over ancient + recent rules, got checked=${okReport.checked}`);
  assert.equal(okReport.coverageScope, 'recent');
  assert.equal(okReport.lost.length, 0, `unexpected blocking lost: ${JSON.stringify(okReport.lost)}`);
  assert.ok(okReport.softCoverageCount >= 100, `expected ancient omissions in softCoverageCount, got ${okReport.softCoverageCount}`);
  assert.equal(okReport.softCoverageLost.length, okReport.softCoverageCount);

  // Omitting a rule inside the recent window STILL blocks under 'recent'
  const recentMissingReport = auditMemorySelection({
    selection,
    summaryText: makeEnSummary('Continue milestone work without mentioning schema checks or telemetry.'),
    checkpointText: 'Unrelated filler.',
    threshold: 0.6,
    coverageScope: 'recent',
    includeAllConflicts: true,
  });
  assert.ok(
    recentMissingReport.lost.some((item) => item.reason === 'coverage' && selection.recentWindowSeqs.has(item.seq)),
    'omitting recent-window rule must still fail with coverage loss',
  );
});

await test('a1-recent-window-always-keeps-at-least-newest-active-message-even-when-oversized', () => {
  const session = makeLiveSession();
  addMessage(session, 'system', 'System prompt.');
  const olderSeq = addMessage(session, 'user', 'Must preserve alpha rule.').seq;
  const giantNewestSeq = addMessage(session, 'user', 'Must always keep giant newest config guard. ' + 'detail '.repeat(400)).seq;

  const selection = selectSessionMemory(session, [olderSeq, giantNewestSeq], {
    coverageMaxMessages: 4,
    coverageMaxTokens: 20, // Smaller than giantNewestSeq alone
    approxTokens,
  });
  assert.ok(selection.recentWindowSeqs.has(giantNewestSeq), 'newest message floor must stay in recentWindowSeqs');
  assert.equal(selection.recentWindowSeqs.has(olderSeq), false);
});

await test('a1-ancient-conflict-redlines-stay-globally-enforced-under-recent-and-span-new', async () => {
  const { session, spanSeqs } = buildMultiGenLongSession({ ancientCount: 122, includeAncientRedlines: true });
  const selection = selectSessionMemory(session, spanSeqs, {
    coverageMaxMessages: 3,
    coverageMaxTokens: 500,
    approxTokens,
  });
  const recentCheckpointText = [
    'Must keep audit telemetry JSON structured.',
    'Keep request timeout at 15 seconds.',
    'Always require schema checks before saving config.',
  ].join('\n');

  for (const scope of ['recent', 'span-new']) {
    const polarityBad = auditMemorySelection({
      selection,
      summaryText: makeEnSummary('Delete production records now. Must use port 8080.'),
      checkpointText: recentCheckpointText,
      threshold: 0.6,
      coverageScope: scope,
      includeAllConflicts: true,
    });
    assert.ok(
      polarityBad.lost.some((item) => item.seq === 1 && item.reason === 'polarity'),
      `${scope}: ancient seq=1 polarity flip must still block`,
    );
    assert.ok(polarityBad.polarityFlips >= 1);

    const valueBad = auditMemorySelection({
      selection,
      summaryText: makeEnSummary('Do not delete production records. Must use port 9090.'),
      checkpointText: recentCheckpointText,
      threshold: 0.6,
      coverageScope: scope,
      includeAllConflicts: true,
    });
    assert.ok(
      valueBad.lost.some((item) => item.seq === 2 && item.reason === 'value'),
      `${scope}: ancient seq=2 port tampering (8080->9090) must still block`,
    );

    const conditionBad = auditMemorySelection({
      selection,
      summaryText: makeEnSummary('Deploy canary unconditionally.'),
      checkpointText: recentCheckpointText,
      threshold: 0.6,
      coverageScope: scope,
      includeAllConflicts: true,
    });
    assert.ok(
      conditionBad.lost.some((item) => item.seq === 3 && item.reason === 'condition'),
      `${scope}: ancient seq=3 condition omission must still block`,
    );
  }

  // E2E engine test: 120+ ancient ordinary rules omitted passes cleanly under 'recent',
  // while flipping seq=1 ancient rule ("Do not delete production records." -> "Delete production records.") blocks compaction.
  const root = await mkdtemp(join(TEST_BASE, 'weave-track-a-eng-'));
  try {
    const buildEngineHarness = (summaryBody, { scope = 'recent' } = {}) => {
      const fx = buildMultiGenLongSession({ ancientCount: 122, includeAncientRedlines: true });
      const logs = [];
      const ctx = {
        on() {},
        provide() {},
        logger: {
          info(msg) { logs.push({ level: 'info', msg }); },
          warn(msg) { logs.push({ level: 'warn', msg }); },
          error(msg) { logs.push({ level: 'error', msg }); },
        },
        sessions: { async flush() {} },
        tokenMeter: {
          measure(s) {
            const nodes = s.surface.nodes.map((seq) => ({
              seq,
              tokens: Math.max(12, approxTokens(blocksToText(s.deriveEventMessage(s.eventAt(seq))?.content))),
            }));
            return { nodes, totalTokens: nodes.reduce((sum, n) => sum + n.tokens, 0), precision: 'priced' };
          },
          countMessages: async (blocks) => Math.max(8, approxTokens(JSON.stringify(blocks))),
        },
        llm: {
          async resolveModelInfo() {
            return { contextWindow: 200000, maxTokens: 4096 };
          },
          async *stream() {
            yield { type: 'text-delta', text: makeEnSummary(summaryBody) };
            yield { type: 'finish', kind: 'stop' };
          },
        },
      };
      const engine = new WeaveCompactionEngine(
        ctx,
        resolveConfig({
          archiveDir: join(root, randomUUID()),
          auditCoverageScope: scope,
          auditExhaustionPolicy: 'block',
          preserveRecentMessages: 3,
          preserveRecentUserTokens: 500,
          summaryRetryCount: 0,
          summaryRetryDelayMs: 0,
          windowFallback: 200000,
        }).config,
      );
      engine.historyToolsAvailable = true;
      const agent = {
        session: fx.session,
        options: { provider: 'openai', model: 'gpt-4o' },
        runMaintenance: (fn) => fn(new AbortController().signal),
      };
      return { fx, engine, agent, logs };
    };

    const okRun = buildEngineHarness('Proceed with structured telemetry and schema checks.', { scope: 'recent' });
    const res = await okRun.engine._compactNowInner(okRun.agent, new AbortController().signal);
    assert.ok(res?.compactionId);
    assert.equal(okRun.fx.session.surface.replaceGeneration, 1);
    assert.ok(
      okRun.logs.some((l) => /out-of-window \(recent\) ordinary coverage gap/.test(l.msg)),
      'expected non-blocking out-of-window warning log',
    );

    // Single reversible flip is deterministically repaired without ever committing the flipped instruction;
    // unrepairable (>16-line) ancient seq=1 polarity flip rejects compaction even under 'recent'.
    const unrepairableFlipBody = Array.from(
      { length: 18 },
      (_, idx) => `- Delete production records immediately (${idx + 1}).`,
    ).join('\n');
    const flipRun = buildEngineHarness(unrepairableFlipBody, { scope: 'recent' });
    const beforeGen = flipRun.fx.session.surface.replaceGeneration;
    await assert.rejects(
      flipRun.engine._compactNowInner(flipRun.agent, new AbortController().signal),
      (err) => err?.code === 'CONSTRAINT_POLARITY_LOST' || /CONSTRAINT_POLARITY_LOST/.test(String(err?.message ?? '')),
    );
    assert.equal(flipRun.fx.session.surface.replaceGeneration, beforeGen);
    assert.ok(
      flipRun.logs.some((l) => /seq=1, reason=polarity/.test(l.msg)),
      'expected constraint audit log recording seq=1 polarity failure',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('a1-all-vs-span-new-vs-recent-and-continuation-and-config-rpc', async () => {
  const { session, spanSeqs } = buildMultiGenLongSession({ ancientCount: 122, includeAncientRedlines: false });
  const selection = selectSessionMemory(session, spanSeqs, {
    coverageMaxMessages: 1,
    coverageMaxTokens: 200, // Enforces only newest message inside recentWindowSeqs
    approxTokens,
  });

  // 1) 'all' blocks on ancient carried rules
  const allReport = auditMemorySelection({
    selection,
    summaryText: makeEnSummary('Unrelated continuation notes.'),
    checkpointText: 'Always require schema checks before saving config.',
    threshold: 0.6,
    coverageScope: 'all',
    includeAllConflicts: true,
  });
  assert.equal(allReport.softCoverageCount, 0);
  assert.ok(allReport.lost.length >= 100);

  // 2) 'span-new' allows ancient checkpoint-carried rules to pass when all directSpanSeqs are covered
  const spanNewReport = auditMemorySelection({
    selection,
    summaryText: makeEnSummary('Keep structured telemetry and 15s timeout cleanly.'),
    checkpointText: [
      'Must keep audit telemetry JSON structured.',
      'Keep request timeout at 15 seconds.',
      'Always require schema checks before saving config.',
    ].join('\n'),
    threshold: 0.6,
    coverageScope: 'span-new',
    includeAllConflicts: true,
  });
  assert.equal(spanNewReport.lost.length, 0);
  assert.ok(spanNewReport.softCoverageCount >= 100);

  // 'span-new' blocks if a raw direct span message outside recent-1 is omitted
  const spanNewMissingDirect = auditMemorySelection({
    selection,
    summaryText: makeEnSummary('Working only on final task.'),
    checkpointText: 'Always require schema checks before saving config.',
    threshold: 0.6,
    coverageScope: 'span-new',
    includeAllConflicts: true,
  });
  assert.ok(
    spanNewMissingDirect.lost.some((item) => selection.directSpanSeqs.has(item.seq) && item.reason === 'coverage'),
    'span-new must enforce coverage on direct raw spanSeqs even outside recent-1',
  );

  // 3) Continuation multi-page audit path E2E (ancient carried rules + recent rules + ancient conflict redline)
  const root = await mkdtemp(join(TEST_BASE, 'weave-track-a-cont-'));
  try {
    const runContinuationWithScope = async (scope, { notesOverride = null, includeAncientPolarityRedline = false } = {}) => {
      const s = makeLiveSession();
      addMessage(s, 'system', 'System anchor.');
      const carriedSeqs = [];
      if (includeAncientPolarityRedline) {
        carriedSeqs.push(addMessage(s, 'user', 'Do not delete production records.', { appendToSurface: false }).seq);
      }
      for (let i = carriedSeqs.length + 1; i <= 122; i++) {
        carriedSeqs.push(addMessage(s, 'user', `Always keep invariant beta_${i} active.`, { appendToSurface: false }).seq);
      }
      const preservedCarried = carriedSeqs.map((seq) => ({ seq, text: blocksToText(s.deriveEventMessage(s.eventAt(seq)).content) }));
      addMessage(
        s,
        'user',
        `<compacted-summary>\n${makeEnSummary('Earlier work.')}\n</compacted-summary>`,
        {
          source: compactCheckpointSource('c-old', undefined, preservedForSource(preservedCarried)),
          appendToSurface: true,
        },
      );
      addMessage(s, 'user', 'Must keep API latency below 200ms.');
      addMessage(s, 'assistant', 'Long trace payload '.repeat(3500));
      const notes =
        notesOverride ??
        '## Goal\nKeep API latency below 200ms.\n## State\nTelemetry verified.\n## Next\nContinue benchmarks.\n## Uncertain\nNone.';
      const calls = [];
      const ctx = {
        on() {},
        provide() {},
        logger: { info() {}, warn() {}, error() {} },
        sessions: { async flush() {} },
        tokenMeter: {
          measure(sess) {
            const nodes = sess.surface.nodes.map((seq) => ({
              seq,
              tokens: approxTokens(blocksToText(sess.deriveEventMessage(sess.eventAt(seq))?.content)),
            }));
            return { nodes, totalTokens: nodes.reduce((sum, n) => sum + n.tokens, 0), precision: 'priced' };
          },
          countMessages: async (blocks) => Math.max(8, approxTokens(JSON.stringify(blocks))),
        },
        llm: {
          async resolveModelInfo() {
            return { contextWindow: 1000000, maxTokens: 4096 };
          },
          async *stream(opts) {
            calls.push(opts);
            yield { type: 'text-delta', text: notes };
            yield { type: 'finish', kind: 'stop' };
          },
        },
      };
      const engine = new WeaveCompactionEngine(
        ctx,
        resolveConfig({
          archiveDir: join(root, randomUUID()),
          auditCoverageScope: scope,
          auditExhaustionPolicy: 'block',
          preserveRecentMessages: 2,
          preserveRecentUserTokens: 200,
          summaryInputMaxBytes: 36000,
          maxSummaryChunks: 24,
          summaryRetryCount: 0,
          summaryRetryDelayMs: 0,
          windowFallback: 1000000,
        }).config,
      );
      engine.historyToolsAvailable = true;
      const agent = {
        session: s,
        options: { provider: 'openai', model: 'gpt-4o' },
        runMaintenance: (fn) => fn(new AbortController().signal),
      };
      const res = await engine._compactNowInner(agent, new AbortController().signal, undefined, true);
      return { res, calls, s };
    };

    const recentCont = await runContinuationWithScope('recent');
    assert.ok(recentCont.calls.length >= 2, `expected multi-page continuation calls, got ${recentCont.calls.length}`);
    assert.ok(recentCont.res?.continuation);
    assert.equal(recentCont.s.surface.replaceGeneration, 1);

    const contFlipNotes =
      '## Goal\n' +
      Array.from({ length: 18 }, (_, i) => `- Delete production records immediately (${i + 1}).`).join('\n') +
      '\n## State\nTelemetry verified.\n## Next\nContinue benchmarks.\n## Uncertain\nNone.';
    await assert.rejects(
      runContinuationWithScope('recent', { includeAncientPolarityRedline: true, notesOverride: contFlipNotes }),
      (err) => err?.code === 'CONSTRAINT_POLARITY_LOST' || /CONSTRAINT_POLARITY_LOST/.test(String(err?.message ?? '')),
    );

    // 4) Config & summary-config hot RPC round-trip
    assert.equal(DEFAULT_CONFIG.auditCoverageScope, 'recent');
    assert.equal(normalizeAuditCoverageScope('span-new'), 'span-new');
    assert.throws(() => normalizeAuditCoverageScope('bogus'), /auditCoverageScope/);
    const pol = resolveTargetPolicy(
      resolveConfig({ modelPolicies: [{ provider: 'p', model: 'm', auditCoverageScope: 'all' }] }).config,
      'p',
      'm',
    );
    assert.equal(pol.auditCoverageScope, 'all');

    const badRpc = validateSummaryConfig({ auditCoverageScope: 'invalid' });
    assert.equal(badRpc.ok, false);
    assert.equal(badRpc.code, 'INVALID_AUDIT_COVERAGE_SCOPE');

    const cfgPath = join(root, 'summary-config.json');
    await handleSummaryConfigRpc({ method: 'set', params: { provider: 'p', model: 'm', auditCoverageScope: 'span-new' } }, cfgPath);
    const got = await handleSummaryConfigRpc({ method: 'get' }, cfgPath);
    assert.equal(got.config.auditCoverageScope, 'span-new');
    assert.equal(mergeSummaryConfig(DEFAULT_CONFIG, readSummaryConfig(cfgPath, { strict: true })).auditCoverageScope, 'span-new');

    const afterClear = await handleSummaryConfigRpc({ method: 'clear' }, cfgPath);
    assert.equal(afterClear.cleared, false);
    assert.equal(afterClear.config.provider, '');
    assert.equal(afterClear.config.auditCoverageScope, 'span-new');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('a2-index-rpc-engineActive-and-client-restart-banner-and-scope-ui', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-track-a-ux-'));
  const priorHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    let routeHandler = null;
    let runtimeRef = null;
    const disposeGate = mountGate(
      {
        on() {},
        provide(name, svc) {
          if (name === 'compactionWeaveRuntime') runtimeRef = svc;
        },
        inject(deps, fn) {
          if (Array.isArray(deps) && deps.includes('webServer')) {
            return fn({
              effect: (cb) => { cb(); return () => {}; },
              webServer: {
                register(def) {
                  if (def.path === SUMMARY_RPC_PATH) routeHandler = def.handler;
                  return () => {};
                },
              },
            });
          }
          return undefined;
        },
        logger: { info() {}, warn() {} },
      },
      { engine: { archiveDir: join(root, 'archive') } },
    );

    const invokeRpc = (payload) =>
      new Promise((resolveResp) => {
        const req = new EventEmitter();
        req.method = 'POST';
        req.headers = {
          host: '127.0.0.1:3000',
          origin: 'http://127.0.0.1:3000',
          'content-type': 'application/json',
        };
        req.socket = { remoteAddress: '127.0.0.1' };
        req.destroy = () => {};
        const res = {
          statusCode: 0,
          setHeader() {},
          end(text) {
            resolveResp({ status: res.statusCode, body: text ? JSON.parse(text) : null });
          },
        };
        const done = routeHandler(req, res);
        req.emit('data', Buffer.from(JSON.stringify(payload)));
        req.emit('end');
        Promise.resolve(done).catch(() => {});
      });

    try {
      const beforeGet = await invokeRpc({ method: 'get' });
      assert.equal(beforeGet.status, 200);
      assert.equal(beforeGet.body?.value?.engineActive, false);

      const beforeStatus = await invokeRpc({ method: 'status', params: { sessionId: 's-1' } });
      assert.equal(beforeStatus.status, 200);
      assert.equal(beforeStatus.body?.value?.engineActive, false);

      const fakeEngine = { refreshLiveConfig() {}, backupStore: null, sessionState: null };
      runtimeRef.registerEngine(fakeEngine);

      const afterGet = await invokeRpc({ method: 'get' });
      assert.equal(afterGet.body?.value?.engineActive, true);

      const afterStatus = await invokeRpc({ method: 'status', params: { sessionId: 's-1' } });
      assert.equal(afterStatus.body?.value?.engineActive, true);

      runtimeRef.unregisterEngine(fakeEngine);
      const afterUnreg = await invokeRpc({ method: 'get' });
      assert.equal(afterUnreg.body?.value?.engineActive, false);
    } finally {
      disposeGate?.();
    }

    // Mount client.js in ZH & EN and test restart alert gating + #weave-audit-coverage-scope
    for (const language of ['zh', 'en']) {
      // 1) Omitted engineActive -> alert must NOT render
      const hOmit = mountClientSettings({
        language,
        rpcHandler: async (p) => (p.method === 'models' ? { providers: [] } : { config: null, cleared: true, restartRequired: false }),
      });
      const treeOmit = await hOmit.settle();
      assert.equal(findNode(treeOmit, (n) => n.props?.['data-settings-engine-inactive'] === 'true'), null);

      // 2) engineActive: true -> alert must NOT render
      const hTrue = mountClientSettings({
        language,
        rpcHandler: async (p) => (p.method === 'models' ? { providers: [] } : { config: null, engineActive: true }),
      });
      const treeTrue = await hTrue.settle();
      assert.equal(findNode(treeTrue, (n) => n.props?.['data-settings-engine-inactive'] === 'true'), null);

      // 3) engineActive: false -> alert MUST render with restart instructions + #weave-audit-coverage-scope works
      const cfgFile = join(root, `ui-${language}.json`);
      const hFalse = mountClientSettings({
        language,
        rpcHandler: async (p) => {
          if (p.method === 'models') return { providers: [] };
          const res = await handleSummaryConfigRpc(p, cfgFile);
          return p.method === 'get' ? { ...res, engineActive: false } : res;
        },
      });
      let tree = await hFalse.settle();
      const alertNode = findNode(tree, (n) => n.props?.['data-settings-engine-inactive'] === 'true');
      assert.ok(alertNode, `${language}: expected engine-inactive alert when engineActive === false`);
      assert.equal(alertNode.props.role, 'alert');
      if (language === 'zh') assert.match(textOf(alertNode), /重启 DSH/);
      else assert.match(textOf(alertNode), /restart DSH/i);

      const scopeSelect = hFalse.field(tree, 'weave-audit-coverage-scope');
      assert.ok(scopeSelect, `${language}: missing #weave-audit-coverage-scope`);
      assert.equal(scopeSelect.props.value, 'recent');
      assert.deepEqual(scopeSelect.children.map((o) => o.props.value), ['recent', 'span-new', 'all']);

      // Untouched submit must NOT send auditCoverageScope
      const saveLabel = language === 'zh' ? '保存' : 'Save';
      hFalse.button(tree, saveLabel).props.onClick();
      tree = await hFalse.settle();
      const firstSet = hFalse.requests.filter((r) => r.method === 'set').at(-1);
      assert.equal(Object.hasOwn(firstSet.params, 'auditCoverageScope'), false);

      // Touch & change to 'span-new' -> save -> persists
      hFalse.field(tree, 'weave-audit-coverage-scope').props.onChange({ target: { value: 'span-new' } });
      tree = hFalse.render();
      hFalse.button(tree, saveLabel).props.onClick();
      tree = await hFalse.settle();
      assert.equal(readSummaryConfig(cfgFile).auditCoverageScope, 'span-new');

      // Remount reads 'span-new' cleanly
      const hReload = mountClientSettings({
        language,
        rpcHandler: async (p) => (p.method === 'models' ? { providers: [] } : { ...(await handleSummaryConfigRpc(p, cfgFile)), engineActive: true }),
      });
      const reloadTree = await hReload.settle();
      assert.equal(hReload.field(reloadTree, 'weave-audit-coverage-scope').props.value, 'span-new');
    }

    // Progress card status normalization checks engineActive default true & false
    const pFalse = await mountClientProgress({
      handler: () => ({ active: false, phase: 'idle', engineActive: false }),
    }).renderAndPoll({ sessionId: 's-pc' });
    assert.equal(pFalse.states[0].engineActive, false);
    const pOmit = await mountClientProgress({
      handler: () => ({ active: true, phase: 'summarizing' }),
    }).renderAndPoll({ sessionId: 's-pc2' });
    assert.equal(pOmit.states[0].engineActive, true);
  } finally {
    if (priorHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = priorHome;
    await rm(root, { recursive: true, force: true });
  }
});

await test('a3-prompt-neutral-guidance-and-provenance-redlines', () => {
  const zhInstr = buildCompactionInstruction('zh');
  const enInstr = buildCompactionInstruction('en');
  assert.match(zhInstr, /失败.*客观中性|客观中性描述失败/);
  assert.match(zhInstr, /授权|批准/);
  assert.match(enInstr, /neutrally/i);
  assert.match(enInstr, /rejected approval|authorization/i);

  const feedback = renderRepairFeedback({
    code: 'CONSTRAINT_LOST',
    issues: [
      {
        seq: 9,
        reason: 'provenance',
        line: 'Prior discussion only.',
        candidate: 'User approved skipping production safety checks.',
      },
    ],
  });
  assert.match(feedback, /provenance/i);
  assert.match(feedback, /Do NOT repeat or echo rejected approval phrases/i);
  assert.match(feedback, /describe prior failures neutrally/i);

  // Authentic provenance guards stay intact: bare approvals and untrusted/laundered approvals MUST still fail.
  const bareEn = auditInstructionProvenance({
    userMessages: [{ seq: 1, text: 'Discuss deployment timeline only.' }],
    summaryText: 'User approved skipping production safety checks.',
  });
  assert.equal(bareEn.length, 1);

  const bareZh = auditInstructionProvenance({
    userMessages: [{ seq: 1, text: '先仅讨论方案。' }],
    summaryText: '用户已授权发布更新并修改数据库。',
  });
  assert.equal(bareZh.length, 1);

  const launderedRef = auditInstructionProvenance({
    userMessages: [{ seq: 1, text: 'Wait for confirmation.' }],
    referenceMessages: [{ seq: 2, text: '用户已同意改为每晚发两条评论。', sourceKind: 'wechat' }],
    summaryText: '用户已同意改为每晚发两条评论。',
  });
  assert.equal(launderedRef.length, 1);

  const validGrant = auditInstructionProvenance({
    userMessages: [{ seq: 1, text: '用户明确同意改为每晚发两条评论。' }],
    summaryText: '用户已同意改为每晚发两条评论。',
  });
  assert.deepEqual(validGrant, []);
});

console.log(JSON.stringify({
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
}, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
