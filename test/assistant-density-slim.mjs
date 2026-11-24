import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { selectContextCollapseSpan } from '../lib/context-collapse.js';
import { approxTokens, blocksToText } from '../lib/meter.js';
import { isProjectedSummaryMessage, projectSummaryMessage, projectSummaryMessages } from '../lib/reference-input.js';
import { buildSummarizationInput } from '../lib/region.js';
import { planSnip } from '../lib/snip.js';
import { computeProseDensity } from '../lib/tool-preview.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error?.message ?? String(error), stack: error?.stack });
  }
}

function makeFillerProse(targetChars = 3200, variantSeed = 0) {
  const sentences = [
    'Certainly, I would be happy to walk through this general workflow together with you in detail.',
    'Thank you for sharing the high-level background and giving me time to think carefully about it.',
    'Overall everything looks very clear and straightforward from a general perspective right now.',
    'Let us continue looking carefully at the overall situation as we move along step by step.',
    'Sure, happy to help with this whenever you are ready to proceed to the next part.',
    'Everything seems quite smooth and consistent so far as we keep reviewing the context.',
  ];
  let out = '';
  let i = variantSeed;
  while (out.length < targetChars) {
    out += (out ? ' ' : '') + sentences[i % sentences.length];
    i += 1;
  }
  return out;
}

function makeHighDensityTechProse(targetChars = 3200, { includeStructure = false } = {}) {
  const subsystems = ['auth', 'billing', 'journal', 'router', 'cache', 'index', 'worker', 'quota', 'tls', 'audit', 'vault', 'stream', 'lock', 'codec', 'proxy', 'store', 'parser', 'queue', 'guard', 'policy'];
  const verbs = ['verify', 'enforce', 'commit', 'dispatch', 'compact', 'validate', 'hydrate', 'acquire', 'release', 'serialize', 'reconcile', 'throttle', 'rotate', 'snapshot', 'drain', 'flush'];
  let out = '';
  let i = 0;
  while (out.length < targetChars) {
    const sub = subsystems[i % subsystems.length];
    const sub2 = subsystems[(i * 7 + 3) % subsystems.length];
    const verb = verbs[i % verbs.length];
    const port = 4000 + i;
    const ver = `${1 + (i % 4)}.${i % 10}.${(i * 3) % 9}`;
    let line;
    if (includeStructure && i % 3 === 0) {
      line = `\`\`\`ts\nexport async function ${verb}${sub}${i}(txId: string) { return await ${sub2}Client.exec({ port: ${port}, timeoutMs: ${1200 + i} }); }\n\`\`\``;
    } else if (includeStructure && i % 3 === 1) {
      line = `completedCount: ${10 + i} | path: src/${sub}/${verb}_${i}.ts | url: https://${sub}.internal.example/v1/${sub2}/${i}\nError: ECONN_${sub.toUpperCase()}_${i} at ${verb}Handler_${i} (lib/${sub}/node_${i}.js:${20 + i}:4)`;
    } else {
      line =
        i % 2 === 0
          ? `Must enforce \`src/${sub}/${verb}-${i}.ts\` v${ver} checksum via \`--strict-${sub}=${port}\` against \`https://${sub}.internal.example/v${1 + (i % 3)}/${sub2}/${i}\`.`
          : `Never disable \`lib/${sub2}/node_${i}.mjs\` (${64 + i} ms, \`${1024 + i * 8} B\`); keep \`${verb}_${sub}_${i}\` guard under \`https://${sub2}.api.example/ops/${i}\`.`;
    }
    out += (out ? '\n' : '') + line;
    i += 1;
  }
  return out;
}

function makeSessionFixture() {
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };

  const session = {
    id: `sess-3ab-${randomUUID()}`,
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => [...events],
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
      if (options.surfaceOp === 'append') surface.nodes.push(event.seq);
      return event;
    },
  };

  const addSystem = (text) =>
    session.append(
      'system/message',
      { message: { id: randomUUID(), role: 'system', content: [{ type: 'text', text }], source: { kind: 'system-prompt' } } },
      { surfaceOp: 'append' },
    );

  const addUser = (text, { kind = 'user' } = {}) =>
    session.append(
      'user/message',
      { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind } },
      { surfaceOp: 'append' },
    );

  const addAssistant = (text, extraContent = []) =>
    session.append(
      'assistant/message',
      {
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'text', text }, ...extraContent],
          source: { kind: 'model' },
        },
      },
      { surfaceOp: 'append' },
    );

  return { session, events, surface, addSystem, addUser, addAssistant };
}

// ── 1. Substep 3A: Asymmetric assistant projection slimming & guards ────────

await test('3a-slims-old-low-density-assistant-prose-over-50pct-without-mutating-session', () => {
  const f = makeSessionFixture();
  f.addSystem('System instructions.');
  const u1 = f.addUser('Keep strict integer billing.');
  const filler = makeFillerProse(3600);
  assert.ok(computeProseDensity(filler) < 0.35, `expected low filler density < 0.35, got ${computeProseDensity(filler)}`);

  const oldAsst = f.addAssistant(filler);
  const recentAsst1 = f.addAssistant(makeFillerProse(3200, 1));
  const recentAsst2 = f.addAssistant(makeFillerProse(3200, 2));

  const seqs = [u1.seq, oldAsst.seq, recentAsst1.seq, recentAsst2.seq];
  const projected = projectSummaryMessages(f.session, seqs);

  // Old assistant turn is slimmed >= 50% with archive pointer and isProjectedSummaryMessage mark
  const projOld = projected[1];
  const oldText = blocksToText(projOld.content);
  assert.equal(isProjectedSummaryMessage(projOld), true);
  assert.ok(oldText.length <= filler.length * 0.5, `expected >= 50% reduction (${oldText.length} vs ${filler.length})`);
  assert.ok(oldText.includes(`history_read({ seq: ${oldAsst.seq} })`));
  assert.match(oldText, /\[Verbose assistant prose projected for summary; omitted \d+ chars of \d+;/);

  // Last 2 assistant turns MUST remain verbatim (unslimmed)
  assert.equal(blocksToText(projected[2].content), makeFillerProse(3200, 1));
  assert.equal(blocksToText(projected[3].content), makeFillerProse(3200, 2));

  // Original session event untouched
  assert.equal(blocksToText(f.session.eventAt(oldAsst.seq).data.message.content), filler);
});

await test('3a-protects-user-fences-traces-structured-progress-tool-calls-and-high-density-assistant', () => {
  const f = makeSessionFixture();
  f.addSystem('System.');
  const longUser = f.addUser(makeFillerProse(3200));
  const fenceAsst = f.addAssistant(`${makeFillerProse(2600)}\n\`\`\`js\nexport const port = 8080;\n\`\`\`\nDone.`);
  const traceAsst = f.addAssistant(`${makeFillerProse(2600)}\nTypeError: Cannot read properties of undefined\n    at routeRequest (src/server.js:42:11)`);
  const kvAsst = f.addAssistant(`${makeFillerProse(2600)}\ncompletedCount: 12\nnextAction: verify_checksum`);
  const toolCallAsst = f.addAssistant(makeFillerProse(2600), [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"path":"a.js"}' }]);
  const techText = makeHighDensityTechProse(3200);
  assert.ok(computeProseDensity(techText) >= 0.55, `expected high tech density >= 0.55, got ${computeProseDensity(techText)}`);
  const techAsst = f.addAssistant(techText);
  const shortAsst = f.addAssistant(makeFillerProse(2300));
  // Add 2 trailing assistant turns so all earlier assistant turns are outside recentAssistantSeqs
  const tail1 = f.addAssistant('Tail 1.');
  const tail2 = f.addAssistant('Tail 2.');

  const seqs = [
    longUser.seq,
    fenceAsst.seq,
    traceAsst.seq,
    kvAsst.seq,
    toolCallAsst.seq,
    techAsst.seq,
    shortAsst.seq,
    tail1.seq,
    tail2.seq,
  ];
  const projected = projectSummaryMessages(f.session, seqs);

  for (let idx = 0; idx < 7; idx += 1) {
    const seq = seqs[idx];
    const orig = blocksToText(f.session.deriveEventMessage(f.session.eventAt(seq)).content);
    const got = blocksToText(projected[idx].content);
    assert.equal(got, orig, `seq=${seq} must remain unslimmed verbatim`);
  }

  // Direct call with explicit recentAssistantSeqs also honors protection
  const directProtected = projectSummaryMessage(
    f.session,
    f.session.eventAt(longUser.seq),
    f.session.deriveEventMessage(f.session.eventAt(longUser.seq)),
    { recentAssistantSeqs: new Set() },
  );
  assert.equal(blocksToText(directProtected.content), blocksToText(longUser.data.content));
});

await test('3a-preservePrefixCache-keeps-verbatim-bytes-while-non-prefix-path-slims-via-region', () => {
  const f = makeSessionFixture();
  f.addSystem('System prompt.');
  f.addUser('Initial requirement: keep WAL strict.');
  const oldFiller = makeFillerProse(3500);
  const oldAsst = f.addAssistant(oldFiller);
  f.addUser('Next requirement: verify billing.');
  f.addAssistant('Recent 1.');
  f.addAssistant('Recent 2.');

  const seqs = f.surface.nodes.slice(1);
  const verbatimInput = buildSummarizationInput(f.session, seqs, { preservePrefixCache: true });
  const verbatimAsst = verbatimInput.messages.find((m) => m.role === 'assistant' && blocksToText(m.content).includes('Certainly'));
  assert.equal(blocksToText(verbatimAsst.content), oldFiller, 'preservePrefixCache: true must stay byte-identical');

  const projectedInput = buildSummarizationInput(f.session, seqs, { preservePrefixCache: false });
  const projectedAsst = projectedInput.messages.find((m) => m.role === 'assistant' && blocksToText(m.content).includes('history_read'));
  assert.ok(projectedAsst, `non-verbatim path must slim old low-density assistant seq=${oldAsst.seq}`);
  assert.ok(blocksToText(projectedAsst.content).length <= oldFiller.length * 0.5);
});

// ── 2. Substep 3B: Density-aware planSnip & selectContextCollapseSpan ──────

await test('3b-planSnip-prefers-low-density-verbose-run-over-equal-size-high-density-run-and-protects-rules', () => {
  const f = makeSessionFixture();
  f.addSystem('System prompt.');

  // Run A (earlier, HIGH technical density, ~1600 tokens)
  f.addUser('Requirement: always enforce `src/auth/verify-token.ts` validation.');
  const highTechText = makeHighDensityTechProse(6400);
  const highRunAsst = f.addAssistant(highTechText);
  // Pin user message between Run A and Run B
  const pinnedRule = f.addUser('Do not delete audit logs or alter WAL checksums.');
  // Run B (later, LOW filler density, equal ~1600 tokens)
  const lowFillerText = makeFillerProse(6400);
  const lowRunAsst = f.addAssistant(lowFillerText);

  // Protected recent tail (2 user turns + >= 8192 tokens)
  f.addUser('Recent turn 1 ' + 'x'.repeat(18000));
  f.addAssistant('Recent reply 1 ' + 'x'.repeat(18000));
  f.addUser('Recent turn 2 ' + 'x'.repeat(18000));
  f.addAssistant('Recent reply 2 ' + 'x'.repeat(18000));

  const nodes = f.surface.nodes;
  const measurement = {
    nodes: nodes.map((seq) => {
      const msg = f.session.deriveEventMessage(f.session.eventAt(seq));
      return { seq, tokens: approxTokens(blocksToText(msg.content)) };
    }),
    totalTokens: nodes.reduce((sum, seq) => sum + approxTokens(blocksToText(f.session.deriveEventMessage(f.session.eventAt(seq)).content)), 0),
  };

  // With maxSpansPerRescue: 1, low-density Run B must win over equal-sized high-density Run A!
  const plan1 = planSnip(f.session, measurement, { maxSpansPerRescue: 1 });
  assert.ok(plan1);
  assert.equal(plan1.spans.length, 1);
  assert.deepEqual(plan1.spans[0].seqs, [lowRunAsst.seq]);
  assert.ok(plan1.spans[0].avgDensity < 0.35);

  // With maxSpansPerRescue: 2, both runs are picked, ordered chronologically [Run A, Run B],
  // and pinnedRule stays protected.
  const plan2 = planSnip(f.session, measurement, { maxSpansPerRescue: 2 });
  assert.ok(plan2);
  assert.equal(plan2.spans.length, 2);
  assert.deepEqual(plan2.spans[0].seqs, [highRunAsst.seq]);
  assert.deepEqual(plan2.spans[1].seqs, [lowRunAsst.seq]);
  assert.ok(plan2.spans[0].avgDensity >= 0.55);
  assert.ok(plan2.spans[1].avgDensity < 0.35);
  const allSnippedSeqs = new Set(plan2.spans.flatMap((s) => s.seqs));
  assert.equal(allSnippedSeqs.has(pinnedRule.seq), false);
});

await test('3b-context-collapse-stops-before-high-density-trailing-segment-and-stays-greedy-when-uniform', () => {
  // 1) Contrasting prefix: low-density prefix [1..4] (~4.5k tok) + high-density trailing segment [5..6] (~16k tok) before tail
  const fContrast = makeSessionFixture();
  fContrast.addSystem('System head.');
  const lowTexts = [
    makeFillerProse(4500, 0),
    makeFillerProse(4500, 1),
    makeFillerProse(4500, 2),
    makeFillerProse(4500, 3),
  ];
  const lowSeqs = [
    fContrast.addUser(lowTexts[0]).seq,
    fContrast.addAssistant(lowTexts[1]).seq,
    fContrast.addUser(lowTexts[2]).seq,
    fContrast.addAssistant(lowTexts[3]).seq,
  ];
  const highTexts = [
    makeHighDensityTechProse(32000, { includeStructure: true }),
    makeHighDensityTechProse(32000, { includeStructure: true }),
  ];
  const highSeqs = [
    fContrast.addUser(highTexts[0]).seq,
    fContrast.addAssistant(highTexts[1]).seq,
  ];
  // Protected tail (2 user turns + > 8192 tokens)
  fContrast.addUser('Tail u1 ' + 'x'.repeat(20000));
  fContrast.addAssistant('Tail a1 ' + 'x'.repeat(20000));
  fContrast.addUser('Tail u2 ' + 'x'.repeat(20000));
  fContrast.addAssistant('Tail a2 ' + 'x'.repeat(20000));

  const contrastPlan = selectContextCollapseSpan(fContrast.session, fContrast.surface.nodes, {
    contextCollapseEnabled: true,
    contextCollapseMinTokens: 20000,
    contextCollapseMaxSpanTokens: 32768,
    contextCollapseKeepRecentTokens: 8192,
    contextCollapseKeepRecentTurns: 2,
  });
  assert.ok(contrastPlan);
  // Starts cleanly from prefix (seq 1, zero hole) and stops before highSeqs!
  assert.deepEqual(contrastPlan.seqs, lowSeqs);
  for (const hs of highSeqs) {
    assert.equal(contrastPlan.seqs.includes(hs), false, `high-density trailing seq=${hs} must stay verbatim`);
  }
  assert.ok(contrastPlan.avgDensity <= 0.38);

  // 2) Uniform density across prefix -> behaves greedily up to maxSpanTokens
  const fUniform = makeSessionFixture();
  fUniform.addSystem('System head.');
  const uSeqs = [];
  for (let i = 0; i < 8; i += 1) {
    const ev = i % 2 === 0
      ? fUniform.addUser(makeFillerProse(5600, i))
      : fUniform.addAssistant(makeFillerProse(5600, i));
    uSeqs.push(ev.seq);
  }
  fUniform.addUser('Tail u1 ' + 'x'.repeat(20000));
  fUniform.addAssistant('Tail a1 ' + 'x'.repeat(20000));
  fUniform.addUser('Tail u2 ' + 'x'.repeat(20000));
  fUniform.addAssistant('Tail a2 ' + 'x'.repeat(20000));

  const greedyPlan = selectContextCollapseSpan(fUniform.session, fUniform.surface.nodes, {
    contextCollapseEnabled: true,
    contextCollapseMinTokens: 20000,
    contextCollapseMaxSpanTokens: 32768,
    contextCollapseKeepRecentTokens: 8192,
    contextCollapseKeepRecentTurns: 2,
  });
  assert.ok(greedyPlan);
  assert.deepEqual(greedyPlan.seqs, uSeqs, 'uniform density prefix must collapse greedily across all 8 nodes');
});

console.log(JSON.stringify({
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
}, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
