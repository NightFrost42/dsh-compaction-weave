import assert from 'node:assert/strict';

import {
  POST_COMPACT_EVENT,
  PRE_COMPACT_EVENT,
  runPostCompactHooks,
  runPreCompactHooks,
} from '../lib/hooks.js';
import {
  buildCompactionInstruction,
  sanitizeFocusInstruction,
} from '../lib/prompt.js';
import { buildSummaryRequest } from '../lib/summary-budget.js';

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error?.message ?? String(error), stack: error?.stack });
  }
}

function createCordisLikeBus() {
  const listeners = new Map();
  return {
    on(eventName, callback) {
      if (!listeners.has(eventName)) listeners.set(eventName, []);
      listeners.get(eventName).push(callback);
    },
    events: {
      dispatch(type, args) {
        assert.equal(type, 'serial');
        const copy = [...args];
        const eventName = copy.shift();
        const bound = [];
        for (const cb of listeners.get(eventName) ?? []) {
          bound.push(cb.bind(null, ...copy));
        }
        return bound;
      },
    },
  };
}

// ── 1. Hooks constants & ctx.root isolation ───────────────────────────────────

await test('event constants and ctx.root dispatch isolation', async () => {
  assert.equal(PRE_COMPACT_EVENT, 'weave/pre-compact');
  assert.equal(POST_COMPACT_EVENT, 'weave/post-compact');

  const rootBus = createCordisLikeBus();
  const childBus = createCordisLikeBus();
  const seen = [];
  rootBus.on(PRE_COMPACT_EVENT, (payload) => {
    seen.push({ bus: 'root', sessionId: payload.sessionId });
    return { additionalContext: 'from-root' };
  });
  childBus.on(PRE_COMPACT_EVENT, () => {
    seen.push({ bus: 'child' });
    return { additionalContext: 'from-child' };
  });

  const ctx = { ...childBus, root: rootBus };
  const res = await runPreCompactHooks(ctx, { sessionId: 's-1' });
  assert.equal(res.cancelled, false);
  assert.equal(res.reason, null);
  assert.equal(res.additionalContext, 'from-root');
  assert.deepEqual(seen, [{ bus: 'root', sessionId: 's-1' }]);
});

// ── 2. Multi-listener accumulation & caps in pre-compact ─────────────────────

await test('runPreCompactHooks accumulates and caps additionalContext (1000) and focusInstruction (500)', async () => {
  const bus = createCordisLikeBus();
  bus.on(PRE_COMPACT_EVENT, () => ({
    additionalContext: 'line-1\x00\x07\r\nline-2',
    focusInstruction: '  keep\nauth\tcontract  ',
  }));
  bus.on(PRE_COMPACT_EVENT, () => ({
    additionalContext: 'a'.repeat(1200),
    focusInstruction: 'b'.repeat(600),
  }));

  const res = await runPreCompactHooks(bus, { sessionId: 's-acc' });
  assert.equal(res.cancelled, false);
  assert.equal(res.reason, null);
  assert.ok(res.additionalContext.startsWith('line-1\nline-2\n'));
  assert.equal(res.additionalContext.length, 1000);
  assert.ok(res.focusInstruction.startsWith('keep auth contract '));
  assert.equal(res.focusInstruction.length, 500);
  assert.deepEqual(res.warnings, []);
});

// ── 3. Veto short-circuit (cancel: true & continue: false) ───────────────────

await test('runPreCompactHooks short-circuits on cancel:true and continue:false with sanitized reason', async () => {
  const bus1 = createCordisLikeBus();
  let ranSecond = false;
  bus1.on(PRE_COMPACT_EVENT, () => ({ additionalContext: 'ctx-1', focusInstruction: 'focus-1' }));
  bus1.on(PRE_COMPACT_EVENT, () => ({ cancel: true, reason: `veto\n${'r'.repeat(600)}` }));
  bus1.on(PRE_COMPACT_EVENT, () => {
    ranSecond = true;
    return { additionalContext: 'should-not-run' };
  });

  const v1 = await runPreCompactHooks(bus1, { sessionId: 's-v1' });
  assert.equal(v1.cancelled, true);
  assert.equal(v1.reason.length, 500);
  assert.ok(!/[\r\n]/.test(v1.reason));
  assert.equal(v1.additionalContext, 'ctx-1');
  assert.equal(v1.focusInstruction, 'focus-1');
  assert.equal(ranSecond, false);

  const bus2 = {
    serial(eventName, payload) {
      assert.equal(eventName, PRE_COMPACT_EVENT);
      assert.equal(payload.sessionId, 's-v2');
      return { continue: false, reason: 'stopped by policy' };
    },
  };
  const v2 = await runPreCompactHooks(bus2, { sessionId: 's-v2' });
  assert.equal(v2.cancelled, true);
  assert.equal(v2.reason, 'stopped by policy');

  const bus3 = {
    emit() {
      return { continue: false };
    },
  };
  const v3 = await runPreCompactHooks(bus3, { sessionId: 's-v3' });
  assert.equal(v3.cancelled, true);
  assert.equal(v3.reason, 'cancelled by weave/pre-compact hook');
});

// ── 4. Error & timeout isolation + failClosed ────────────────────────────────

await test('runPreCompactHooks isolates throwing and hanging listeners unless failClosed', async () => {
  const bus = createCordisLikeBus();
  const warningsLogged = [];
  let lateReject;
  bus.on(PRE_COMPACT_EVENT, () => {
    throw new Error('sync boom');
  });
  bus.on(PRE_COMPACT_EVENT, () => new Promise((_, reject) => {
    lateReject = reject;
    // Never resolves within timeoutMs=50; later rejects to verify no unhandledRejection.
    setTimeout(() => lateReject(new Error('late rejection after timeout')), 120);
  }));
  bus.on(PRE_COMPACT_EVENT, () => ({ additionalContext: 'survived' }));

  const res = await runPreCompactHooks(bus, { sessionId: 's-iso' }, {
    timeoutMs: 50,
    log: (level, msg) => warningsLogged.push({ level, msg }),
  });
  assert.equal(res.cancelled, false);
  assert.equal(res.additionalContext, 'survived');
  assert.equal(res.warnings.length, 2);
  assert.ok(warningsLogged.some((w) => w.level === 'warn' && /sync boom/.test(w.msg)));
  assert.ok(warningsLogged.some((w) => w.level === 'warn' && /timed out/.test(w.msg)));

  // Wait past late rejection to prove it does not trigger unhandledRejection.
  await new Promise((r) => setTimeout(r, 150));

  const closedBus = createCordisLikeBus();
  closedBus.on(PRE_COMPACT_EVENT, async () => {
    throw new Error('required gate failed');
  });
  const closedRes = await runPreCompactHooks(closedBus, { sessionId: 's-fc' }, { failClosed: true });
  assert.equal(closedRes.cancelled, true);
  assert.match(closedRes.reason, /required gate failed/);
});

// ── 5. AbortSignal propagation in runPreCompactHooks ─────────────────────────

await test('runPreCompactHooks rethrows AbortSignal immediately', async () => {
  const preAborted = new AbortController();
  preAborted.abort(Object.assign(new Error('already aborted'), { code: 'ABORTED' }));
  let called = false;
  await assert.rejects(
    runPreCompactHooks(
      { serial() { called = true; } },
      { sessionId: 's-ab1' },
      { signal: preAborted.signal },
    ),
    (err) => err?.code === 'ABORTED',
  );
  assert.equal(called, false);

  const midAbort = new AbortController();
  const bus = createCordisLikeBus();
  bus.on(PRE_COMPACT_EVENT, () => new Promise(() => {}));
  setTimeout(() => midAbort.abort(Object.assign(new Error('mid-flight abort'), { code: 'ABORTED' })), 30);

  await assert.rejects(
    runPreCompactHooks(bus, { sessionId: 's-ab2' }, { signal: midAbort.signal, timeoutMs: 5000 }),
    (err) => err?.code === 'ABORTED',
  );
});

// ── 6. runPostCompactHooks isolation, notices, and fallbacks ─────────────────

await test('runPostCompactHooks collects notices and never throws on errors, timeouts, or aborts', async () => {
  const bus = createCordisLikeBus();
  const logs = [];
  bus.on(POST_COMPACT_EVENT, () => {
    throw new Error('post sync crash');
  });
  bus.on(POST_COMPACT_EVENT, () => new Promise(() => {}));
  bus.on(POST_COMPACT_EVENT, () => ({ notice: 'indexed checkpoint', additionalContext: 'synced state' }));
  bus.on(POST_COMPACT_EVENT, () => ({ notices: ['n1', '  \x00 ', 'n2'] }));

  const out = await runPostCompactHooks(bus, { compactionId: 'cmp-1' }, {
    timeoutMs: 50,
    log: { warn: (msg) => logs.push(msg) },
  });
  assert.deepEqual(out.notices, ['indexed checkpoint', 'synced state', 'n1', 'n2']);
  assert.equal(out.warnings.length, 2);
  assert.equal(logs.length, 2);

  // Fallback to bus.parallel / bus.emit and abort safety.
  const parallelOut = await runPostCompactHooks(
    {
      async parallel(event, payload) {
        assert.equal(event, POST_COMPACT_EVENT);
        return [{ notice: `ok:${payload.compactionId}` }];
      },
    },
    { compactionId: 'cmp-2' },
  );
  assert.deepEqual(parallelOut.notices, ['ok:cmp-2']);
  assert.deepEqual(parallelOut.warnings, []);

  const aborted = new AbortController();
  aborted.abort();
  const abortSafe = await runPostCompactHooks(
    { emit() { throw new Error('should not run'); } },
    { compactionId: 'cmp-3' },
    { signal: aborted.signal },
  );
  assert.deepEqual(abortSafe, { notices: [], warnings: [] });
});

// ── 7. Prompt focus sanitization, byte-for-byte invariance, and budget forward ─

await test('sanitizeFocusInstruction, buildCompactionInstruction, and buildSummaryRequest handle focus cleanly', () => {
  assert.equal(sanitizeFocusInstruction(null), '');
  assert.equal(sanitizeFocusInstruction(undefined), '');
  assert.equal(sanitizeFocusInstruction(42), '');
  assert.equal(sanitizeFocusInstruction('  \r\n\t\x00\x1f\x7f  '), '');
  assert.equal(sanitizeFocusInstruction('  keep\r\n\tSQL\x00   migrations\x1fexact  '), 'keep SQL migrationsexact');
  assert.equal(sanitizeFocusInstruction('x'.repeat(600)).length, 500);

  // Preserve v0.4.2 PR #3 Section 6 heading preservation instructions and byte-for-byte invariance when focus is omitted.
  const baseEn = buildCompactionInstruction('en');
  assert.ok(baseEn.includes('keep heading "## 6. All User Messages" unchanged'));
  assert.ok(baseEn.includes('engine inserts recent originals'));
  assert.equal((baseEn.match(/^## [1-9]\./gm) || []).length, 9);
  assert.equal(buildCompactionInstruction('en', {}), baseEn);
  assert.equal(buildCompactionInstruction('en', { focusInstruction: '' }), baseEn);
  assert.equal(buildCompactionInstruction('en', { focusInstruction: null }), baseEn);
  assert.equal(buildCompactionInstruction('en', { focusInstruction: ' \n\t\x00 ' }), baseEn);

  const baseZh = buildCompactionInstruction('zh');
  assert.ok(baseZh.includes('标题必须原样保留「## 6. 全部用户消息」'));
  assert.equal((baseZh.match(/^## [1-9]\./gm) || []).length, 9);
  assert.equal(buildCompactionInstruction('zh', { focusInstruction: '   ' }), baseZh);

  const basePrev = buildCompactionInstruction('en', { previousSummary: 'PRIOR' });
  assert.equal(buildCompactionInstruction('en', { previousSummary: 'PRIOR', focusInstruction: '' }), basePrev);

  const focusedEn = buildCompactionInstruction('en', { focusInstruction: '  preserve\napi\tendpoints  ' });
  assert.ok(focusedEn.startsWith(`${baseEn}\n\n`));
  assert.ok(focusedEn.includes('Focus instructions from the user (prioritize retaining these details without dropping required rules or inventing facts): preserve api endpoints'));

  const focusedZh = buildCompactionInstruction('zh', { focusInstruction: '保留\n错误码' });
  assert.ok(focusedZh.startsWith(`${baseZh}\n\n`));
  assert.ok(focusedZh.includes('用户聚焦指令（在不遗漏必要规则、不编造事实的前提下优先保留以下细节）：保留 错误码'));

  const input = { messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect migration files.' }] }] };
  const reqPlain = buildSummaryRequest(input, { language: 'en' });
  const reqEmpty = buildSummaryRequest(input, { language: 'en', focusInstruction: ' \t\n ' });
  assert.deepEqual(reqEmpty, reqPlain);

  const reqFocus = buildSummaryRequest(input, { language: 'en', focusInstruction: 'Keep migration rollback notes' });
  assert.ok(reqFocus.messages.at(-1).content[0].text.includes('Keep migration rollback notes'));
});

console.log(JSON.stringify({
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  results,
}, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
