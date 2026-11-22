import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_CONTEXT_COLLAPSE_ENABLED,
  DEFAULT_CONTEXT_COLLAPSE_KEEP_RECENT_TOKENS,
  DEFAULT_CONTEXT_COLLAPSE_KEEP_RECENT_TURNS,
  DEFAULT_CONTEXT_COLLAPSE_MAX_SPAN_TOKENS,
  DEFAULT_CONTEXT_COLLAPSE_MIN_SPAN_NODES,
  DEFAULT_CONTEXT_COLLAPSE_MIN_SPAN_TOKENS,
  DEFAULT_CONTEXT_COLLAPSE_MIN_TOKENS,
  inspectContextCollapseSpan,
  selectContextCollapseSpan,
  shouldSkipFullIdleSummaryAfterCollapse,
} from '../lib/context-collapse.js';
import { approxTokens } from '../lib/meter.js';
import { withExtraReferenceSourceKinds } from '../lib/source-provenance.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({
      name,
      pass: false,
      error: error?.message ?? String(error),
      stack: error?.stack,
    });
  }
}

function tokensStr(tokenCount) {
  // approxTokens counts 4 ASCII chars = 1 token.
  return 'x'.repeat(tokenCount * 4);
}

function makeFixture() {
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };

  const session = {
    id: `sess-${randomUUID()}`,
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (event.type === 'system/message') return event.data?.message;
      if (event.type === 'user/message') return event.data;
      if (event.type === 'assistant/message') return event.data?.message;
      if (event.type === 'tool/result') return event.data?.message;
      return undefined;
    },
    append(type, data, options = {}) {
      const event = {
        seq: events.length,
        type,
        data,
        ...(Array.isArray(options.sourceEventSeqs) ? { sourceEventSeqs: [...options.sourceEventSeqs] } : {}),
      };
      events.push(event);
      const op = options.surfaceOp;
      if (op?.op === 'replace') {
        const start = surface.nodes.indexOf(op.startSeq);
        const end = surface.nodes.indexOf(op.endSeq);
        assert.ok(start >= 0 && end >= start, 'invalid replace range');
        surface.nodes.splice(start, end - start + 1, event.seq);
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

  const addUser = (text, { kind = 'user', externalFold = false, stringContent = false } = {}) =>
    session.append(
      'user/message',
      {
        id: randomUUID(),
        role: 'user',
        content: stringContent ? text : [{ type: 'text', text }],
        ...(kind === undefined ? {} : { source: { kind } }),
        ...(externalFold ? { externalFold: true } : {}),
      },
      { surfaceOp: 'append' },
    );

  const addCheckpoint = (text, { compactionId = `weave-${randomUUID().slice(0, 8)}`, source } = {}) =>
    session.append(
      'user/message',
      {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: source ?? { kind: 'compact-checkpoint', compactionId },
      },
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
          source: { kind: 'model' },
        },
      },
      { surfaceOp: 'append' },
    );

  const addAssistantToolCalls = (calls, text = '') => {
    const callEvents = [];
    const content = [];
    if (text) content.push({ type: 'text', text });
    for (const call of calls) {
      const callId = call.callId ?? `call-${randomUUID().slice(0, 8)}`;
      const argsJson = JSON.stringify(call.args ?? {});
      const tc = session.append('tool/call', { callId, name: call.name ?? 'read_file', arguments: argsJson });
      callEvents.push(tc);
      content.push({ type: 'tool-call', id: callId, callId, name: call.name ?? 'read_file', arguments: argsJson });
    }
    const asst = session.append(
      'assistant/message',
      { message: { id: randomUUID(), role: 'assistant', content, source: { kind: 'model' } } },
      { surfaceOp: 'append' },
    );
    return { callEvents, asst };
  };

  const addToolResult = (callEvent, text) =>
    session.append(
      'tool/result',
      {
        message: {
          id: randomUUID(),
          role: 'tool',
          toolCallId: callEvent.data.callId,
          content: [{ type: 'text', text }],
          source: { kind: 'tool', callId: callEvent.data.callId },
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] },
    );

  return {
    session,
    events,
    surface,
    addSystem,
    addUser,
    addCheckpoint,
    addAssistant,
    addAssistantToolCalls,
    addToolResult,
  };
}

function seedEligibleSession({ phaseTokens = 10000, phaseCount = 5, tailTurnTokens = 5000 } = {}) {
  const f = makeFixture();
  f.addSystem(tokensStr(200));
  for (let p = 0; p < phaseCount; p += 1) {
    const each = Math.floor(phaseTokens / 2);
    f.addUser(`Phase ${p} prompt: ${tokensStr(each)}`);
    f.addAssistant(`Phase ${p} reply: ${tokensStr(each)}`);
  }
  // 2 recent authentic user turns (each split across user + assistant)
  const halfTail = Math.floor(tailTurnTokens / 2);
  f.addUser(`Recent turn 1: ${tokensStr(Math.floor(halfTail / 2))}`);
  f.addAssistant(`Recent reply 1: ${tokensStr(Math.floor(halfTail / 2))}`);
  f.addUser(`Recent turn 2: ${tokensStr(Math.floor(halfTail / 2))}`);
  f.addAssistant(`Recent reply 2: ${tokensStr(Math.floor(halfTail / 2))}`);
  return f;
}

await test('defaults-and-opt-in-strict-boolean-guard', () => {
  assert.equal(DEFAULT_CONTEXT_COLLAPSE_ENABLED, false);
  assert.equal(DEFAULT_CONTEXT_COLLAPSE_MIN_TOKENS, 49152);
  assert.equal(DEFAULT_CONTEXT_COLLAPSE_MAX_SPAN_TOKENS, 32768);
  assert.equal(DEFAULT_CONTEXT_COLLAPSE_KEEP_RECENT_TOKENS, 8192);
  assert.equal(DEFAULT_CONTEXT_COLLAPSE_KEEP_RECENT_TURNS, 2);
  assert.equal(DEFAULT_CONTEXT_COLLAPSE_MIN_SPAN_NODES, 4);
  assert.equal(DEFAULT_CONTEXT_COLLAPSE_MIN_SPAN_TOKENS, 4096);

  const f = seedEligibleSession({ phaseTokens: 12000, phaseCount: 5, tailTurnTokens: 10000 });
  for (const policy of [
    undefined,
    null,
    {},
    { contextCollapseEnabled: false },
    { contextCollapseEnabled: 'true' },
    { contextCollapseEnabled: 1 },
  ]) {
    assert.equal(selectContextCollapseSpan(f.session, f.surface.nodes, policy), null);
    assert.deepEqual(inspectContextCollapseSpan(f.session, f.surface.nodes, policy), {
      ok: false,
      reason: 'disabled',
      plan: null,
    });
  }

  const enabled = selectContextCollapseSpan(f.session, f.surface.nodes, { contextCollapseEnabled: true });
  assert.ok(enabled);
  assert.ok(enabled.totalTokens >= 49152);
});

await test('min-token-gate-computed-and-boundary-exact', () => {
  // Build a session with ~49,151 tokens vs 49,152 tokens via derived messages (no priced map)
  const fUnder = makeFixture();
  fUnder.addSystem(tokensStr(151));
  for (let i = 0; i < 6; i += 1) {
    fUnder.addUser(tokensStr(4000));
    fUnder.addAssistant(tokensStr(4000));
  }
  // 151 + 12 * 4000 = 48,151 < 49,152
  const underInspect = inspectContextCollapseSpan(fUnder.session, fUnder.surface.nodes, {
    contextCollapseEnabled: true,
  });
  assert.equal(underInspect.ok, false);
  assert.equal(underInspect.reason, 'below-min-tokens');
  assert.equal(underInspect.totalTokens, 48151);
  assert.equal(underInspect.minTokens, 49152);
  assert.equal(selectContextCollapseSpan(fUnder.session, fUnder.surface.nodes, { contextCollapseEnabled: true }), null);

  // Add 1001 tokens -> exact 49,152 tokens
  fUnder.addUser(tokensStr(500), { stringContent: true });
  fUnder.addAssistant(tokensStr(501));
  const exactPlan = selectContextCollapseSpan(fUnder.session, fUnder.surface.nodes, {
    contextCollapseEnabled: true,
  });
  assert.ok(exactPlan, 'exact minTokens boundary (49152) must be eligible');
  assert.equal(exactPlan.totalTokens, 49152);

  // Also check CJK approxTokens computation (~1 CJK char = 1 token)
  const fCjk = makeFixture();
  fCjk.addUser('请'.repeat(1000));
  fCjk.addAssistant('好'.repeat(1000));
  fCjk.addUser('继'.repeat(1000));
  fCjk.addAssistant('续'.repeat(1000));
  fCjk.addUser('最'.repeat(1000));
  fCjk.addAssistant('近'.repeat(1000));
  const cjkRes = inspectContextCollapseSpan(fCjk.session, fCjk.surface.nodes, {
    contextCollapseEnabled: true,
    contextCollapseMinTokens: 6000,
    contextCollapseKeepRecentTokens: 1500,
    contextCollapseKeepRecentTurns: 1,
    contextCollapseMinSpanNodes: 4,
    contextCollapseMinSpanTokens: 2000,
  });
  assert.equal(cjkRes.ok, true);
  assert.equal(cjkRes.totalTokens, 6000);
});

await test('intersection-of-keepRecentTokens-and-keepRecentTurns-ignoring-non-user-envelopes', () => {
  const f = makeFixture();
  const sys = f.addSystem(tokensStr(200));
  const u1 = f.addUser(tokensStr(6000));
  const a1 = f.addAssistant(tokensStr(6000));
  const u2 = f.addUser(tokensStr(6000));
  const a2 = f.addAssistant(tokensStr(6000));
  const u3 = f.addUser(tokensStr(6000));
  const a3 = f.addAssistant(tokensStr(6000));

  // Turn N-1: real user message + reply
  const uPrev = f.addUser(tokensStr(1000));
  const aPrev = f.addAssistant(tokensStr(1000));

  // Noise between Turn N-1 and Turn N: system-reminder only, wechat bridge, runtime-context, custom extra bridge
  const remOnly = f.addUser('<system-reminder>\nInstructions from: AGENTS.md\n' + tokensStr(500) + '\n</system-reminder>');
  const wechatMsg = f.addUser('wechat ping: ' + tokensStr(500), { kind: 'wechat' });
  const runtimeMsg = f.addUser('runtime info: ' + tokensStr(500), { kind: 'runtime-context' });
  const customBridge = f.addUser('custom bridge: ' + tokensStr(500), { kind: 'dingtalk-bridge' });

  // Turn N: real user message containing embedded <system-reminder> PLUS real text, and short reply
  const uLast = f.addUser('<system-reminder>hook note</system-reminder>\nPlease finish the test. ' + tokensStr(500));
  const aLast = f.addAssistant(tokensStr(500));

  // Total > 40000; test with explicit minTokens 30000
  // Tail from uPrev..aLast has ~5000 tokens (< keepRecentTokens 8192)!
  // So keepRecentTokens (8192) walks back into a3 (6000) -> tokenCutoff = a3,
  // whereas keepRecentTurns (2) stops at uPrev -> turnCutoff = uPrev.
  // Intersection (earliest/strictest) MUST pick a3!
  const planTokensStricter = withExtraReferenceSourceKinds(['dingtalk-bridge'], () =>
    selectContextCollapseSpan(f.session, f.surface.nodes, {
      contextCollapseEnabled: true,
      contextCollapseMinTokens: 30000,
      contextCollapseKeepRecentTokens: 8192,
      contextCollapseKeepRecentTurns: 2,
      contextCollapseMaxSpanTokens: 50000,
    }),
  );
  assert.ok(planTokensStricter);
  assert.deepEqual(planTokensStricter.protectedTailSeqs, [
    a3.seq,
    uPrev.seq,
    aPrev.seq,
    remOnly.seq,
    wechatMsg.seq,
    runtimeMsg.seq,
    customBridge.seq,
    uLast.seq,
    aLast.seq,
  ]);
  assert.deepEqual(planTokensStricter.seqs, [u1.seq, a1.seq, u2.seq, a2.seq, u3.seq]);
  assert.equal(planTokensStricter.seqs.includes(sys.seq), false);

  // Now shrink keepRecentTokens to 1000 so keepRecentTurns=2 (uPrev) is stricter than keepRecentTokens (uLast..aLast = 1000+)!
  // Because remOnly/wechatMsg/runtimeMsg/customBridge are ignored, keepRecentTurns=2 MUST walk all the way back to uPrev!
  const planTurnsStricter = withExtraReferenceSourceKinds(['dingtalk-bridge'], () =>
    selectContextCollapseSpan(f.session, f.surface.nodes, {
      contextCollapseEnabled: true,
      contextCollapseMinTokens: 30000,
      contextCollapseKeepRecentTokens: 1000,
      contextCollapseKeepRecentTurns: 2,
      contextCollapseMaxSpanTokens: 50000,
    }),
  );
  assert.ok(planTurnsStricter);
  assert.deepEqual(planTurnsStricter.protectedTailSeqs, [
    uPrev.seq,
    aPrev.seq,
    remOnly.seq,
    wechatMsg.seq,
    runtimeMsg.seq,
    customBridge.seq,
    uLast.seq,
    aLast.seq,
  ]);
  assert.deepEqual(planTurnsStricter.seqs, [u1.seq, a1.seq, u2.seq, a2.seq, u3.seq, a3.seq]);

  // If keepRecentTurns exceeds available authentic user turns (e.g. 6 > 5 authentic turns), protect everything -> null
  const tooFewTurns = inspectContextCollapseSpan(f.session, f.surface.nodes, {
    contextCollapseEnabled: true,
    contextCollapseMinTokens: 30000,
    contextCollapseKeepRecentTokens: 1000,
    contextCollapseKeepRecentTurns: 6,
  });
  assert.equal(tooFewTurns.ok, false);
  assert.equal(tooFewTurns.reason, 'protected-tail');

  // Policy extraReferenceSourceKinds + detached surfaceNodes without session.surface
  const detachedSession = {
    eventAt: (seq) => f.session.eventAt(seq),
    deriveEventMessage: (ev) => f.session.deriveEventMessage(ev),
  };
  const detachedPlan = selectContextCollapseSpan(detachedSession, [...f.surface.nodes], {
    contextCollapseEnabled: true,
    contextCollapseMinTokens: 30000,
    contextCollapseKeepRecentTokens: 1000,
    contextCollapseKeepRecentTurns: 2,
    contextCollapseMaxSpanTokens: 50000,
    extraReferenceSourceKinds: ['dingtalk-bridge'],
  });
  assert.ok(detachedPlan);
  assert.deepEqual(detachedPlan.protectedTailSeqs, planTurnsStricter.protectedTailSeqs);
});

await test('skip-leading-systemHead-and-contiguous-checkpoints-and-external-folds', () => {
  const f = makeFixture();
  const sys = f.addSystem(tokensStr(200));
  const cp1 = f.addCheckpoint('Native checkpoint 1 ' + tokensStr(1500), { compactionId: 'weave-1' });
  const biliCp = f.addCheckpoint('<bili-snapshot v1 />\nExternal fold ' + tokensStr(1500), {
    source: { kind: 'compact-checkpoint' },
  });
  const biliNudge = f.addUser('Nudge tombstone', { kind: 'plugin:billion-context-dsh' });

  const r1 = f.addUser(tokensStr(8000));
  const r2 = f.addAssistant(tokensStr(8000));
  const r3 = f.addUser(tokensStr(8000));
  const r4 = f.addAssistant(tokensStr(8000));
  const r5 = f.addUser(tokensStr(8000));
  const r6 = f.addAssistant(tokensStr(8000));
  const r7 = f.addUser(tokensStr(8000));
  const r8 = f.addAssistant(tokensStr(8000));

  const t1 = f.addUser(tokensStr(4500));
  const t2 = f.addAssistant(tokensStr(4500));
  const t3 = f.addUser(tokensStr(4500));
  const t4 = f.addAssistant(tokensStr(4500));

  const plan = selectContextCollapseSpan(f.session, f.surface.nodes, {
    contextCollapseEnabled: true,
    contextCollapseMinTokens: 49152,
    contextCollapseMaxSpanTokens: 32768,
    contextCollapseKeepRecentTokens: 8192,
    contextCollapseKeepRecentTurns: 2,
  });
  assert.ok(plan);
  assert.equal(plan.startSeq, r1.seq, 'must skip systemHead and all contiguous leading checkpoints/external-folds');
  assert.equal(plan.seqs.includes(sys.seq), false);
  assert.equal(plan.seqs.includes(cp1.seq), false);
  assert.equal(plan.seqs.includes(biliCp.seq), false);
  assert.equal(plan.seqs.includes(biliNudge.seq), false);
  // 4 nodes * 8000 = 32000 <= 32768 (5th node would be 40000 > 32768)
  assert.deepEqual(plan.seqs, [r1.seq, r2.seq, r3.seq, r4.seq]);
  assert.equal(plan.endSeq, r4.seq);
  assert.equal(plan.tokens, 32000);
  assert.deepEqual(plan.protectedTailSeqs, [t1.seq, t2.seq, t3.seq, t4.seq]);

  // Progressive collapse pass 2: after replacing r1..r4 with cp2, next call skips cp2 and targets r5..r8
  const cp2 = f.session.append(
    'user/message',
    {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: 'Collapsed phase 1 ' + tokensStr(2000) }],
      source: { kind: 'compact-checkpoint', compactionId: 'weave-collapse-2' },
    },
    { surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq } },
  );

  const pass2 = selectContextCollapseSpan(f.session, f.surface.nodes, {
    contextCollapseEnabled: true,
    contextCollapseMinTokens: 49152,
    contextCollapseMaxSpanTokens: 32768,
    contextCollapseKeepRecentTokens: 8192,
    contextCollapseKeepRecentTurns: 2,
  });
  assert.ok(pass2);
  assert.equal(pass2.startSeq, r5.seq, 'pass 2 must skip cp2 and start at next raw node r5');
  assert.equal(pass2.seqs.includes(cp2.seq), false);
  assert.deepEqual(pass2.seqs, [r5.seq, r6.seq, r7.seq, r8.seq]);
  assert.deepEqual(pass2.protectedTailSeqs, [t1.seq, t2.seq, t3.seq, t4.seq]);

  // Surface with only systemHead + checkpoints returns null (no-uncollapsed-nodes)
  const fOnlyCp = makeFixture();
  fOnlyCp.addSystem(tokensStr(30000));
  fOnlyCp.addCheckpoint(tokensStr(25000));
  const onlyCpInspect = inspectContextCollapseSpan(fOnlyCp.session, fOnlyCp.surface.nodes, {
    contextCollapseEnabled: true,
  });
  assert.equal(onlyCpInspect.ok, false);
  assert.equal(onlyCpInspect.reason, 'no-uncollapsed-nodes');
});

await test('tool-call-boundary-trimming-and-parallel-tool-calls', () => {
  // Case 1: maxSpanTokens stops mid-way inside a parallel 2-tool-call group -> trims back before assistant(tool-call)
  const f = makeFixture();
  f.addSystem(tokensStr(200));
  const u1 = f.addUser(tokensStr(6000));
  const a1 = f.addAssistant(tokensStr(6000));
  const u2 = f.addUser(tokensStr(6000));
  const a2 = f.addAssistant(tokensStr(6000));

  // Assistant emits 2 parallel tool calls (token cost 200 each -> 6000+6000+6000+6000 = 24000 so far)
  const tcGroup = f.addAssistantToolCalls([{ name: 'read_file' }, { name: 'read_file' }], tokensStr(500));
  const tr1 = f.addToolResult(tcGroup.callEvents[0], tokensStr(4000)); // cum = 28500 <= 32768
  const tr2 = f.addToolResult(tcGroup.callEvents[1], tokensStr(8000)); // cum = 36500 > 32768!

  // Tail (2 authentic turns, >= 8192 tok)
  const uTail1 = f.addUser(tokensStr(5000));
  const aTail1 = f.addAssistant(tokensStr(5000));
  const uTail2 = f.addUser(tokensStr(5000));
  const aTail2 = f.addAssistant(tokensStr(5000));

  const plan = selectContextCollapseSpan(f.session, f.surface.nodes, {
    contextCollapseEnabled: true,
    contextCollapseMinTokens: 49152,
    contextCollapseMaxSpanTokens: 32768,
    contextCollapseKeepRecentTokens: 8192,
    contextCollapseKeepRecentTurns: 2,
  });
  assert.ok(plan);
  // Greedy stops at tr1 (28500 <= 32768), which is unbalanced because tr2 is still open!
  // Backward trimming must step past tr1 AND tcGroup.asst back to a2!
  assert.deepEqual(plan.seqs, [u1.seq, a1.seq, u2.seq, a2.seq]);
  assert.equal(plan.startSeq, u1.seq);
  assert.equal(plan.endSeq, a2.seq);
  assert.equal(plan.tokens, 24000);
  assert.ok(!plan.seqs.includes(tcGroup.asst.seq));
  assert.ok(!plan.seqs.includes(tr1.seq));
  assert.ok(!plan.seqs.includes(tr2.seq));

  // Case 2: protectedTail cutoff lands between assistant(tool-call) and its tool/result -> trims back before assistant(tool-call)
  const fSplitTail = makeFixture();
  fSplitTail.addSystem(tokensStr(200));
  const p1 = fSplitTail.addUser(tokensStr(6000));
  const p2 = fSplitTail.addAssistant(tokensStr(6000));
  const p3 = fSplitTail.addUser(tokensStr(6000));
  const p4 = fSplitTail.addAssistant(tokensStr(6000));
  const splitCall = fSplitTail.addAssistantToolCalls([{ name: 'bash' }], tokensStr(500));
  // Huge tool result pushes keepRecentTokens cutoff right onto splitResult!
  const splitResult = fSplitTail.addToolResult(splitCall.callEvents[0], tokensStr(25000));
  const lastU = fSplitTail.addUser(tokensStr(1000));
  const lastA = fSplitTail.addAssistant(tokensStr(1000));

  const splitPlan = selectContextCollapseSpan(fSplitTail.session, fSplitTail.surface.nodes, {
    contextCollapseEnabled: true,
    contextCollapseMinTokens: 49152,
    contextCollapseMaxSpanTokens: 32768,
    contextCollapseKeepRecentTokens: 8192,
    contextCollapseKeepRecentTurns: 1,
  });
  assert.ok(splitPlan);
  assert.deepEqual(splitPlan.protectedTailSeqs, [splitResult.seq, lastU.seq, lastA.seq]);
  assert.deepEqual(splitPlan.seqs, [p1.seq, p2.seq, p3.seq, p4.seq]);
  assert.ok(!splitPlan.seqs.includes(splitCall.asst.seq), 'tool-call whose result is in protected tail must not be collapsed');

  // Case 3: Corrupt orphan tool/result returns unbalanced-tool-pairing cleanly instead of crashing
  const fCorrupt = makeFixture();
  fCorrupt.addUser(tokensStr(25000));
  fCorrupt.addToolResult({ data: { callId: 'missing' }, seq: 0 }, tokensStr(25000));
  fCorrupt.addUser(tokensStr(5000));
  fCorrupt.addAssistant(tokensStr(5000));
  const corruptInspect = inspectContextCollapseSpan(fCorrupt.session, fCorrupt.surface.nodes, {
    contextCollapseEnabled: true,
    contextCollapseKeepRecentTurns: 1,
    contextCollapseMinSpanNodes: 1,
  });
  assert.equal(corruptInspect.ok, false);
  assert.equal(corruptInspect.reason, 'unbalanced-tool-pairing');
});

await test('minSpanNodes-minSpanTokens-and-maxSpanTokens-ceilings', () => {
  // 1. minSpanNodes bound (only 3 eligible nodes before protected tail -> rejected)
  const fFewNodes = makeFixture();
  fFewNodes.addSystem(tokensStr(200));
  fFewNodes.addUser(tokensStr(14000));
  fFewNodes.addAssistant(tokensStr(14000));
  fFewNodes.addUser(tokensStr(14000));
  fFewNodes.addUser(tokensStr(5000));
  fFewNodes.addAssistant(tokensStr(5000));
  fFewNodes.addUser(tokensStr(5000));
  fFewNodes.addAssistant(tokensStr(5000));

  const fewNodesRes = inspectContextCollapseSpan(fFewNodes.session, fFewNodes.surface.nodes, {
    contextCollapseEnabled: true,
    contextCollapseMinTokens: 49152,
    contextCollapseMaxSpanTokens: 50000,
    contextCollapseKeepRecentTokens: 8192,
    contextCollapseKeepRecentTurns: 2,
  });
  assert.equal(fewNodesRes.ok, false);
  assert.equal(fewNodesRes.reason, 'below-min-span-nodes');
  assert.equal(fewNodesRes.candidateNodes, 3);
  assert.equal(fewNodesRes.minSpanNodes, 4);

  // 2. minSpanTokens bound (4 eligible nodes totaling 4000 < 4096 while total >= 49152 -> rejected)
  const fFewTok = makeFixture();
  fFewTok.addSystem(tokensStr(200));
  fFewTok.addUser(tokensStr(1000));
  fFewTok.addAssistant(tokensStr(1000));
  fFewTok.addUser(tokensStr(1000));
  fFewTok.addAssistant(tokensStr(1000));
  // Large protected tail makes total >= 49152
  fFewTok.addUser(tokensStr(25000));
  fFewTok.addAssistant(tokensStr(25000));
  const fewTokRes = inspectContextCollapseSpan(fFewTok.session, fFewTok.surface.nodes, {
    contextCollapseEnabled: true,
    contextCollapseMinTokens: 49152,
    contextCollapseKeepRecentTokens: 8192,
    contextCollapseKeepRecentTurns: 1,
  });
  assert.equal(fewTokRes.ok, false);
  assert.equal(fewTokRes.reason, 'below-min-span-tokens');
  assert.equal(fewTokRes.candidateTokens, 4000);
  assert.equal(fewTokRes.minSpanTokens, 4096);

  // 3. First eligible node itself > maxSpanTokens -> exceeds-max-span-tokens
  const fHugeFirst = makeFixture();
  fHugeFirst.addUser(tokensStr(35000));
  fHugeFirst.addAssistant(tokensStr(5000));
  fHugeFirst.addUser(tokensStr(5000));
  fHugeFirst.addAssistant(tokensStr(5000));
  fHugeFirst.addUser(tokensStr(5000));
  fHugeFirst.addAssistant(tokensStr(5000));
  const hugeFirstRes = inspectContextCollapseSpan(fHugeFirst.session, fHugeFirst.surface.nodes, {
    contextCollapseEnabled: true,
    contextCollapseMaxSpanTokens: 32768,
  });
  assert.equal(hugeFirstRes.ok, false);
  assert.equal(hugeFirstRes.reason, 'exceeds-max-span-tokens');

  // 4. Verify exact plan structure and greedy cap leaving intermediate history untouched
  const fCap = seedEligibleSession({ phaseTokens: 16000, phaseCount: 4, tailTurnTokens: 10000 });
  const capPlan = selectContextCollapseSpan(fCap.session, fCap.surface.nodes, {
    contextCollapseEnabled: true,
  });
  assert.ok(capPlan);
  assert.deepEqual(
    Object.keys(capPlan).sort(),
    ['endSeq', 'maxSpanTokens', 'minSpanTokens', 'protectedTailSeqs', 'seqs', 'startSeq', 'tokens', 'totalTokens'].sort(),
  );
  assert.equal(capPlan.minSpanTokens, 4096);
  assert.equal(capPlan.maxSpanTokens, 32768);
  assert.ok(capPlan.tokens <= 32768);
  assert.equal(capPlan.seqs.length, 4); // 4 * (8000 + 4 prefix tokens) = 32016 <= 32768, leaving phases 2 & 3 uncollapsed!
  assert.equal(capPlan.tokens, 32016);
  assert.equal(capPlan.protectedTailSeqs.length, 4);

  // 5. Measurement / pricedBySeq where maxSpanTokens allows only 2 nodes (< minSpanNodes 4) -> rejected cleanly
  const fShort = makeFixture();
  const s1 = fShort.addUser('u1');
  const s2 = fShort.addAssistant('a1');
  const s3 = fShort.addUser('u2');
  const s4 = fShort.addAssistant('a2');
  const s5 = fShort.addUser('u3');
  const s6 = fShort.addAssistant('a3');
  const pricedBySeq = new Map([
    [s1.seq, 12000],
    [s2.seq, 12000],
    [s3.seq, 12000],
    [s4.seq, 12000],
    [s5.seq, 5000],
    [s6.seq, 5000],
  ]);
  const pricedRes = inspectContextCollapseSpan(
    fShort.session,
    fShort.surface.nodes,
    { contextCollapseEnabled: true },
    { measurement: { nodes: fShort.surface.nodes.map((seq) => ({ seq, tokens: pricedBySeq.get(seq) })), pricedBySeq, totalTokens: 58000 } },
  );
  assert.equal(pricedRes.ok, false);
  assert.equal(pricedRes.reason, 'below-min-span-nodes');
  assert.equal(pricedRes.candidateNodes, 2);
});

await test('mid-surface-checkpoint-is-never-collapsed-and-policy-overrides-work', () => {
  const f = makeFixture();
  f.addSystem(tokensStr(200));
  const u1 = f.addUser(tokensStr(5000));
  const a1 = f.addAssistant(tokensStr(5000));
  const u2 = f.addUser(tokensStr(5000));
  const a2 = f.addAssistant(tokensStr(5000));
  // External fold sitting mid-surface must NOT be collapsed into plan.seqs
  const midExternalFold = f.addUser('Nudge', { kind: 'plugin:acp-nudge' });
  const u3 = f.addUser(tokensStr(15000));
  const a3 = f.addAssistant(tokensStr(15000));
  const t1 = f.addUser(tokensStr(5000));
  const t2 = f.addAssistant(tokensStr(5000));
  const t3 = f.addUser(tokensStr(5000));
  const t4 = f.addAssistant(tokensStr(5000));

  const plan = selectContextCollapseSpan(f.session, f.surface.nodes, {
    contextCollapseEnabled: true,
    contextCollapseMinTokens: 49152,
    contextCollapseMaxSpanTokens: 32768,
    contextCollapseKeepRecentTokens: 8192,
    contextCollapseKeepRecentTurns: 2,
  });
  assert.ok(plan);
  assert.deepEqual(plan.seqs, [u1.seq, a1.seq, u2.seq, a2.seq]);
  assert.equal(plan.seqs.includes(midExternalFold.seq), false);
  assert.equal(plan.seqs.includes(u3.seq), false);
  assert.equal(plan.seqs.includes(a3.seq), false);
  assert.deepEqual(plan.protectedTailSeqs, [t1.seq, t2.seq, t3.seq, t4.seq]);

  // Policy custom minSpanNodes / minSpanTokens + approxTokens fallback on string content
  const planCustom = selectContextCollapseSpan(f.session, f.surface.nodes, {
    contextCollapseEnabled: true,
    contextCollapseMinTokens: 49152,
    contextCollapseMinSpanNodes: 2,
    contextCollapseMinSpanTokens: 9000,
    contextCollapseMaxSpanTokens: 12000,
  });
  assert.ok(planCustom);
  assert.deepEqual(planCustom.seqs, [u1.seq, a1.seq]);
  assert.equal(planCustom.tokens, 10000);
  assert.equal(planCustom.minSpanTokens, 9000);
  assert.equal(planCustom.maxSpanTokens, 12000);
});

await test('priced-measurement-minSpanNodes-check-and-override', () => {
  const fShort = makeFixture();
  const seqs = [];
  for (let i = 0; i < 6; i += 1) {
    seqs.push(fShort.addUser(`u${i}`).seq);
    seqs.push(fShort.addAssistant(`a${i}`).seq);
  }
  const pricedBySeq = new Map(seqs.map((seq) => [seq, 6000]));
  const plan = selectContextCollapseSpan(
    fShort.session,
    fShort.surface.nodes,
    { contextCollapseEnabled: true },
    { measurement: { nodes: seqs.map((seq) => ({ seq, tokens: 6000 })), pricedBySeq, totalTokens: 72000 } },
  );
  assert.ok(plan);
  assert.equal(plan.totalTokens, 72000);
  assert.equal(plan.seqs.length, 5); // 5 * 6000 = 30000 <= 32768
  assert.equal(plan.tokens, 30000);
  assert.equal(plan.protectedTailSeqs.length, 4); // last 2 turns (u4,a4,u5,a5) = 24000 >= 8192
});

await test('shouldSkipFullIdleSummaryAfterCollapse-parity-with-engine', () => {
  // 1. idleFullSummaryEnabled: false always skips
  assert.equal(
    shouldSkipFullIdleSummaryAfterCollapse({
      beforeTokens: 60000,
      afterTokens: 59900,
      policy: { idleFullSummaryEnabled: false, minimumReductionRatio: 0.5 },
      microResult: null,
      collapseResult: null,
    }),
    true,
  );

  // 2. Neither microcompact nor collapse ran -> false (falls through to Tier 3 / _compactManual)
  assert.equal(
    shouldSkipFullIdleSummaryAfterCollapse({
      beforeTokens: 60000,
      afterTokens: 40000,
      policy: { idleFullSummaryEnabled: true, minimumReductionRatio: 0.2 },
      microResult: null,
      collapseResult: null,
    }),
    false,
  );
  assert.equal(
    shouldSkipFullIdleSummaryAfterCollapse({
      beforeTokens: 60000,
      afterTokens: 40000,
      policy: { idleFullSummaryEnabled: true, minimumReductionRatio: 0.2 },
      microResult: { maskedCount: 0, shadowedTokenCount: 0 },
      collapseResult: { status: 'skipped' },
    }),
    false,
  );

  // 3. After microcompact/collapse, below idleCompactionMinTokens -> skips Tier 3
  assert.equal(
    shouldSkipFullIdleSummaryAfterCollapse({
      beforeMicroTokens: 45000,
      beforeTokens: 42000,
      afterTokens: 38000,
      policy: { idleFullSummaryEnabled: true, idleCompactionMinTokens: 40000, minimumReductionRatio: 0.5 },
      collapseResult: { compactionId: 'weave-c1' },
    }),
    true,
  );

  // 4. Combined reduction measured against original pre-idle total tokens (beforeMicroTokens), NOT post-micro beforeTokens
  assert.equal(
    shouldSkipFullIdleSummaryAfterCollapse({
      beforeMicroTokens: 60000,
      beforeTokens: 53000, // micro saved 7k (11.7%)
      afterTokens: 47000,  // collapse saved 6k net (11.3% of 53k, but 13k/60k = 21.7% combined!)
      policy: { idleFullSummaryEnabled: true, minimumReductionRatio: 0.2 },
      microResult: { maskedCount: 2, shadowedTokenCount: 7000 },
      collapseResult: { compactionId: 'weave-c2', shadowedTokenCount: 12000 },
      thresholdTokens: 50000,
    }),
    true,
  );

  // 5. Collapse gross shadowedTokenCount must NOT mask insufficient net reduction (checkpoint overhead keeps afterTokens high)
  assert.equal(
    shouldSkipFullIdleSummaryAfterCollapse({
      beforeMicroTokens: 60000,
      beforeTokens: 60000,
      afterTokens: 54000, // only 10% net reduction despite 25000 gross shadowed tokens
      policy: { idleFullSummaryEnabled: true, minimumReductionRatio: 0.2 },
      microResult: null,
      collapseResult: { compactionId: 'weave-c3', shadowedTokenCount: 25000 },
      thresholdTokens: 80000,
    }),
    false,
  );

  // 6. Sufficient reduction ratio STILL requires afterTokens < thresholdTokens / idleCompactionThresholdTokens
  assert.equal(
    shouldSkipFullIdleSummaryAfterCollapse({
      beforeMicroTokens: 100000,
      beforeTokens: 80000,
      afterTokens: 65000, // 35% reduction >= 20%, but STILL >= thresholdTokens (60000)!
      policy: { idleFullSummaryEnabled: true, minimumReductionRatio: 0.2 },
      collapseResult: { compactionId: 'weave-c4' },
      thresholdTokens: 60000,
    }),
    false,
  );
  assert.equal(
    shouldSkipFullIdleSummaryAfterCollapse({
      beforeMicroTokens: 100000,
      beforeTokens: 80000,
      afterTokens: 59999,
      policy: { idleFullSummaryEnabled: true, minimumReductionRatio: 0.2, idleCompactionThresholdTokens: 60000 },
      collapseResult: { compactionId: 'weave-c5' },
    }),
    true,
  );

  // 7. Microcompact-only path parity with engine.js (shadowedTokenCount >= minRatio when < thresholdTokens)
  assert.equal(
    shouldSkipFullIdleSummaryAfterCollapse({
      beforeTokens: 60000,
      afterTokens: 45000,
      policy: { idleFullSummaryEnabled: true, minimumReductionRatio: 0.2 },
      microResult: { maskedCount: 3, shadowedTokenCount: 15000 },
      collapseResult: null,
      thresholdTokens: 50000,
    }),
    true,
  );

  // 8. Omitted microResult/collapseResult still evaluates ratio + thresholdTokens + idleCompactionMinTokens
  assert.equal(
    shouldSkipFullIdleSummaryAfterCollapse({
      beforeTokens: 60000,
      afterTokens: 45000,
      policy: { minimumReductionRatio: 0.2, thresholdTokens: 50000 },
    }),
    true,
  );
  assert.equal(
    shouldSkipFullIdleSummaryAfterCollapse({
      beforeTokens: 60000,
      afterTokens: 45000,
      policy: { minimumReductionRatio: 0.2, thresholdTokens: 44000 },
    }),
    false,
  );
  assert.equal(
    shouldSkipFullIdleSummaryAfterCollapse({
      beforeTokens: 30000,
      afterTokens: 25000,
      policy: { idleCompactionMinTokens: 40000, minimumReductionRatio: 0.5 },
    }),
    true,
  );
});

await test('extraReferencePrefixes-and-builtin-bare-memory-excluded-from-turn-retention', () => {
  const f = makeFixture();
  const sys = f.addSystem('System.');
  const u1 = f.addUser(tokensStr(6000));
  const a1 = f.addAssistant(tokensStr(6000));
  const u2 = f.addUser(tokensStr(6000));
  const a2 = f.addAssistant(tokensStr(6000));
  const u3 = f.addUser(tokensStr(6000));
  const a3 = f.addAssistant(tokensStr(6000));

  // Turn N-1: real user turn + reply
  const uPrev = f.addUser(tokensStr(1000));
  const aPrev = f.addAssistant(tokensStr(1000));

  // Trailing bare built-in memory block & custom prefix block (neither is a real user turn)
  const bareBuiltIn = f.addUser('===== 长期记忆 =====\nRecall line.\n' + tokensStr(200));
  const customPrefix = f.addUser('### Custom Memory\nRecall line.\n' + tokensStr(200));

  // Turn N: real user turn + reply
  const uLast = f.addUser('Finish verification. ' + tokensStr(300));
  const aLast = f.addAssistant(tokensStr(300));

  const basePolicy = {
    contextCollapseEnabled: true,
    contextCollapseMinTokens: 30000,
    contextCollapseKeepRecentTokens: 800,
    contextCollapseKeepRecentTurns: 2,
    contextCollapseMaxSpanTokens: 50000,
  };

  // With extraReferencePrefixes passed on policy, inspectContextCollapseSpan activates withReferencePolicy:
  // customPrefix and bareBuiltIn are skipped, so Turn N-1 = uPrev stays protected.
  const planWithPrefix = selectContextCollapseSpan(f.session, f.surface.nodes, {
    ...basePolicy,
    extraReferencePrefixes: ['### Custom Memory'],
  });
  assert.ok(planWithPrefix);
  assert.deepEqual(planWithPrefix.protectedTailSeqs, [
    uPrev.seq,
    aPrev.seq,
    bareBuiltIn.seq,
    customPrefix.seq,
    uLast.seq,
    aLast.seq,
  ]);
  assert.deepEqual(planWithPrefix.seqs, [u1.seq, a1.seq, u2.seq, a2.seq, u3.seq, a3.seq]);
  assert.equal(planWithPrefix.seqs.includes(sys.seq), false);

  // Without extraReferencePrefixes, customPrefix looks like Turn N-1 so uPrev falls into the collapse span
  const planWithoutPrefix = selectContextCollapseSpan(f.session, f.surface.nodes, basePolicy);
  assert.ok(planWithoutPrefix);
  assert.equal(planWithoutPrefix.seqs.includes(uPrev.seq), true);
  assert.deepEqual(planWithoutPrefix.protectedTailSeqs, [customPrefix.seq, uLast.seq, aLast.seq]);
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
