import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { auditCompaction } from '../lib/audit.js';
import { runConcurrentPool } from '../lib/concurrency.js';
import { DEFAULT_CONFIG, normalizeSummaryCjkTokensPerChar, resolveConfig } from '../lib/config.js';
import { WeaveCompactionEngine } from '../lib/engine.js';
import { CompactionArchive } from '../lib/history.js';
import { apply as mountGate } from '../lib/index.js';
import { SummaryAssembler, approxTokens, estimateHostHeuristicMessage } from '../lib/meter.js';
import { commitObservationMask, planObservationMask } from '../lib/observation-mask.js';
import { buildCompactionInstruction } from '../lib/prompt.js';
import { selectCompactableRange } from '../lib/region.js';
import { commitSnip, planSnip } from '../lib/snip.js';
import {
  buildSummaryRequest,
  measureSummaryRange,
  planSummaryRange,
  resolveSummaryCapacity,
} from '../lib/summary-budget.js';
import {
  handleSummaryConfigRpc,
  mergeSummaryConfig,
  readSummaryConfig,
  validateSummaryConfig,
  writeSummaryConfig,
} from '../lib/summary-config.js';
import { CONTENT_RETRY_CODES } from '../lib/summary-retry.js';
import { resolveSummaryTargets, summarizeWithChain } from '../lib/summary.js';
import { buildToolPreview } from '../lib/tool-preview.js';
import { HOST_NORMALIZED_FINGERPRINTS } from '../lib/transaction-host.js';

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

function makeSummary(sections = {}) {
  return EN_HEADINGS
    .map((h, idx) => {
      if (idx === 5) return `${h}\n${sections[6] ?? '[filled by engine]'}`;
      const body = sections[idx + 1] ?? (idx === 8 ? sections.body : undefined) ?? 'Archived progress; continue.';
      return `${h}\n${body}`;
    })
    .join('\n\n');
}

function makeMockSession({ id = `w3-${randomUUID()}`, openTurn = null } = {}) {
  const events = [];
  const surface = { nodes: [], replaceGeneration: 0 };
  let requestConfig = { provider: 'openai', model: 'gpt-4o' };
  const session = {
    id,
    openTurn,
    surface,
    get seq() {
      return events.length;
    },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => [...events],
    requestHeader: () => ({ config: requestConfig }),
    setRequestHeaderModel(provider, model) {
      requestConfig = { provider, model };
    },
    toolHistory: () => [],
    deriveEventMessage(event) {
      if (!event) return undefined;
      if (event.type === 'system/message') return event.data?.message ?? event.data;
      if (event.type === 'user/message') return event.data;
      if (event.type === 'assistant/message') return event.data?.message ?? event.data;
      if (event.type === 'tool/result') return event.data?.message ?? event.data;
      return undefined;
    },
    append(type, data, options) {
      const ev = {
        seq: events.length,
        type,
        data,
        ...(options?.surfaceOp ? { surfaceOp: options.surfaceOp } : {}),
        ...(options?.sourceEventSeqs ? { sourceEventSeqs: options.sourceEventSeqs } : {}),
      };
      events.push(ev);
      if (options?.surfaceOp?.op === 'replace') {
        const sIdx = surface.nodes.indexOf(options.surfaceOp.startSeq);
        const eIdx = surface.nodes.indexOf(options.surfaceOp.endSeq);
        assert.ok(sIdx >= 0 && eIdx >= sIdx, 'invalid mock replace range');
        surface.nodes.splice(sIdx, eIdx - sIdx + 1, ev.seq);
        surface.replaceGeneration += 1;
      } else if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result' || type === 'system/message') {
        surface.nodes.push(ev.seq);
      }
      return ev;
    },
  };
  return session;
}

// ── 1. P0-1: RPC connection auth, Host loopback/bound guard, Origin & Content-Type ──

await test('P0-1-rpc-enforces-connection-auth-host-origin-and-json-content-type', async () => {
  let registered = null;
  let connectionService = null;
  let injectListener = null;
  const dispose = mountGate(
    {
      on() {},
      provide() {},
      get(name) {
        return name === 'connection' ? connectionService : null;
      },
      inject(deps, cb) {
        if (Array.isArray(deps) && deps.includes('connection')) {
          return cb({ connection: connectionService });
        }
        if (Array.isArray(deps) && deps.includes('webServer')) {
          return cb({
            on(ev, listener) {
              if (ev === 'webserver/index-inject') injectListener = listener;
              return () => {};
            },
            effect(fn) {
              return fn();
            },
            webServer: {
              host: '127.0.0.1',
              register(route) {
                registered = route;
                return () => {};
              },
            },
          });
        }
        return () => {};
      },
    },
    {},
  );
  try {
    assert.ok(registered?.handler);
    const tbl = [];
    injectListener?.(tbl);
    const bootTok = tbl.find((r) => r?.name === '__WEAVE_RPC_TOKEN__')?.value;
    assert.ok(bootTok);
    const send = (method, headers, body = '{"method":"get"}', extraReq = {}) =>
      new Promise((resolveRes) => {
        const req = Object.assign(new EventEmitter(), { method, socket: { remoteAddress: '127.0.0.1' }, headers, ...extraReq });
        const out = { statusCode: 200, headers: {}, body: '' };
        const res = {
          set statusCode(code) { out.statusCode = code; },
          get statusCode() { return out.statusCode; },
          setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
          end(chunk = '') {
            out.body = String(chunk);
            resolveRes({ status: out.statusCode, json: JSON.parse(out.body) });
          },
        };
        const p = registered.handler(req, res);
        if (body !== undefined) req.emit('data', Buffer.from(body));
        req.emit('end');
        Promise.resolve(p).catch(() => {});
      });

    // Without connection service: strict origin, host & fail-closed token enforcement
    const noOrigin = await send('POST', { host: '127.0.0.1:3000', 'content-type': 'application/json' });
    assert.equal(noOrigin.status, 403);

    const opaqueOrigin = await send('POST', { host: '127.0.0.1:3000', origin: 'null', 'content-type': 'application/json' });
    assert.equal(opaqueOrigin.status, 403);

    const rebindHost = await send('POST', { host: 'evil.attacker:3000', origin: 'http://evil.attacker:3000', 'content-type': 'application/json' });
    assert.equal(rebindHost.status, 403);

    const crossOriginFetch = await send('POST', {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
      'sec-fetch-site': 'cross-origin',
      'content-type': 'application/json',
    });
    assert.equal(crossOriginFetch.status, 403);

    const badMime = await send('POST', {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
      'x-weave-rpc-token': bootTok,
      'content-type': 'text/plain',
    });
    assert.equal(badMime.status, 415);

    const noTokenLoopback = await send('POST', {
      Host: '127.0.0.1:3000',
      Origin: 'http://127.0.0.1:3000',
      'Content-Type': 'application/json; charset=utf-8',
    });
    assert.equal(noTokenLoopback.status, 401);

    const validLoopback = await send('POST', {
      Host: '127.0.0.1:3000',
      Origin: 'http://127.0.0.1:3000',
      'x-weave-rpc-token': bootTok,
      'Content-Type': 'application/json; charset=utf-8',
    });
    assert.equal(validLoopback.status, 200);
    assert.equal(validLoopback.json.ok, true);

    // With host connection service: defers to requestRejection (401 when unauthenticated, 200 when valid)
    connectionService = {
      requestRejection(req) {
        return req.headers?.authorization === 'Bearer ok' ? undefined : 401;
      },
    };
    const unauth = await send('POST', { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' });
    assert.equal(unauth.status, 401);

    const authNoOrigin = await send('POST', {
      host: '127.0.0.1:3000',
      authorization: 'Bearer ok',
      'content-type': 'application/json',
    });
    assert.equal(authNoOrigin.status, 200);
  } finally {
    dispose?.();
  }
});

await test('Issue19-rpc-index-inject-token-and-same-origin-header-fallback', async () => {
  let registered = null;
  let routeDisposed = false;
  let webServerDispose = null;
  let connectionService = null;
  let firstBootToken = null;
  const indexInjectListeners = new Set();
  const dispose = mountGate(
    {
      on() {},
      provide() {},
      get(name) {
        return name === 'connection' ? connectionService : null;
      },
      inject(deps, cb) {
        if (Array.isArray(deps) && deps.includes('connection')) {
          return cb({ connection: connectionService });
        }
        if (Array.isArray(deps) && deps.includes('webServer')) {
          webServerDispose = cb({
            on(event, listener) {
              if (event === 'webserver/index-inject') {
                indexInjectListeners.add(listener);
                return () => indexInjectListeners.delete(listener);
              }
              return () => {};
            },
            effect(fn) {
              return fn();
            },
            webServer: {
              host: '127.0.0.1',
              register(route) {
                registered = route;
                return () => { routeDisposed = true; };
              },
            },
          });
          return webServerDispose;
        }
        return () => {};
      },
    },
    {},
  );
  try {
    assert.ok(registered?.handler);
    assert.equal(indexInjectListeners.size, 1, 'must subscribe to webserver/index-inject');

    const injectTable = [];
    for (const listener of indexInjectListeners) listener(injectTable);
    const tokenEntry = injectTable.find((row) => row?.kind === 'global' && row?.name === '__WEAVE_RPC_TOKEN__');
    assert.ok(tokenEntry && typeof tokenEntry.value === 'string' && tokenEntry.value.length >= 32, 'must inject random __WEAVE_RPC_TOKEN__ global');
    const validToken = tokenEntry.value;
    firstBootToken = validToken;

    // Non-array table should not crash listener
    for (const listener of indexInjectListeners) listener(null);

    const send = (method, headers, body = '{"method":"get"}', extraReq = {}) =>
      new Promise((resolveRes) => {
        const req = Object.assign(new EventEmitter(), { method, socket: { remoteAddress: '127.0.0.1' }, headers, ...extraReq });
        const out = { statusCode: 200, headers: {}, body: '' };
        const res = {
          set statusCode(code) { out.statusCode = code; },
          get statusCode() { return out.statusCode; },
          setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
          end(chunk = '') {
            out.body = String(chunk);
            resolveRes({ status: out.statusCode, json: JSON.parse(out.body) });
          },
        };
        const p = registered.handler(req, res);
        if (body !== undefined) req.emit('data', Buffer.from(body));
        req.emit('end');
        Promise.resolve(p).catch(() => {});
      });

    // Tier 2: No connection + missing/empty Origin + valid x-weave-rpc-token => 200
    const tokenMissingOrigin = await send('POST', {
      host: '127.0.0.1:3000',
      'x-weave-rpc-token': validToken,
      'content-type': 'application/json',
    });
    assert.equal(tokenMissingOrigin.status, 200);
    assert.equal(tokenMissingOrigin.json.ok, true);

    const tokenUpperHeaderEmptyOrigin = await send('POST', {
      Host: '127.0.0.1:3000',
      Origin: '',
      'X-Weave-Rpc-Token': validToken,
      'Content-Type': 'application/json',
    });
    assert.equal(tokenUpperHeaderEmptyOrigin.status, 200);
    assert.equal(tokenUpperHeaderEmptyOrigin.json.ok, true);

    // Forged / wrong tokens (different length, same length, multibyte UTF-8 same string length) => 403
    const forgedShort = await send('POST', {
      host: '127.0.0.1:3000',
      'x-weave-rpc-token': 'forged',
      'content-type': 'application/json',
    });
    assert.equal(forgedShort.status, 403);
    assert.equal(forgedShort.json.error?.message, 'missing origin refused');

    const flipped = (validToken[0] === 'A' ? 'B' : 'A') + validToken.slice(1);
    const forgedSameLen = await send('POST', {
      host: '127.0.0.1:3000',
      'x-weave-rpc-token': flipped,
      'content-type': 'application/json',
    });
    assert.equal(forgedSameLen.status, 403);

    const forgedMultibyte = await send('POST', {
      host: '127.0.0.1:3000',
      'x-weave-rpc-token': '中' + validToken.slice(1),
      'content-type': 'application/json',
    });
    assert.equal(forgedMultibyte.status, 403);

    // Valid token MUST NOT bypass cross-site Origin, Origin: null, cross-site Sec-Fetch-Site, untrusted Host, GET, or non-JSON
    const tokenCrossOrigin = await send('POST', {
      host: '127.0.0.1:3000',
      origin: 'http://evil.example',
      'x-weave-rpc-token': validToken,
      'content-type': 'application/json',
    });
    assert.equal(tokenCrossOrigin.status, 403);
    assert.equal(tokenCrossOrigin.json.error?.message, 'origin does not match host');

    const tokenNullOrigin = await send('POST', {
      host: '127.0.0.1:3000',
      origin: 'null',
      'x-weave-rpc-token': validToken,
      'content-type': 'application/json',
    });
    assert.equal(tokenNullOrigin.status, 403);
    assert.equal(tokenNullOrigin.json.error?.message, 'opaque origin refused');

    const tokenCrossFetchSite = await send('POST', {
      host: '127.0.0.1:3000',
      'sec-fetch-site': 'Cross-Site',
      'x-weave-rpc-token': validToken,
      'content-type': 'application/json',
    });
    assert.equal(tokenCrossFetchSite.status, 403);

    const tokenBadHost = await send('POST', {
      host: 'evil.attacker:3000',
      'x-weave-rpc-token': validToken,
      'content-type': 'application/json',
    });
    assert.equal(tokenBadHost.status, 403);

    const tokenGet = await send('GET', {
      host: '127.0.0.1:3000',
      'x-weave-rpc-token': validToken,
      'content-type': 'application/json',
    }, '');
    assert.equal(tokenGet.status, 405);

    const tokenBadMime = await send('POST', {
      host: '127.0.0.1:3000',
      'x-weave-rpc-token': validToken,
      'content-type': 'text/plain',
    });
    assert.equal(tokenBadMime.status, 415);

    // No connection, no token + missing Origin + Sec-Fetch-Site: same-origin or same-origin Referer => 401 (fail-closed)
    const sameOriginFetch = await send('POST', {
      host: '127.0.0.1:3000',
      'sec-fetch-site': '  Same-Origin  ',
      'content-type': 'application/json',
    });
    assert.equal(sameOriginFetch.status, 401);

    const sameSiteNotEnough = await send('POST', {
      host: '127.0.0.1:3000',
      'sec-fetch-site': 'same-site',
      'content-type': 'application/json',
    });
    assert.equal(sameSiteNotEnough.status, 403);
    assert.equal(sameSiteNotEnough.json.error?.message, 'missing origin refused');

    const sameOriginReferer = await send('POST', {
      host: '127.0.0.1:3000',
      referer: 'http://127.0.0.1:3000/settings?tab=weave',
      'content-type': 'application/json',
    });
    assert.equal(sameOriginReferer.status, 401);

    const ipv6RefererWithTok = await send('POST', {
      host: '[::1]:3000',
      referer: 'http://[::1]:3000/settings',
      'x-weave-rpc-token': validToken,
      'content-type': 'application/json',
    });
    assert.equal(ipv6RefererWithTok.status, 200);

    // Cross-site / wrong-port / non-http(s) / userinfo / relative Referer + missing Origin => 403
    for (const badReferer of [
      'http://evil.example/',
      'http://127.0.0.1:9999/settings',
      'ftp://127.0.0.1:3000/settings',
      'http://user@127.0.0.1:3000/settings',
      '/settings',
    ]) {
      const res = await send('POST', {
        host: '127.0.0.1:3000',
        referer: badReferer,
        'content-type': 'application/json',
      });
      assert.equal(res.status, 403, `bad referer must be refused: ${badReferer}`);
      assert.equal(res.json.error?.message, 'missing origin refused');
    }

    // Duplicate / comma-joined Sec-Fetch-Site and array/duplicate security headers => 403
    const dupFetchSiteJoined = await send('POST', {
      host: '127.0.0.1:3000',
      'sec-fetch-site': 'cross-site, same-origin',
      'x-weave-rpc-token': validToken,
      'content-type': 'application/json',
    });
    assert.equal(dupFetchSiteJoined.status, 403);
    assert.equal(dupFetchSiteJoined.json.error?.message, 'cross-site request refused');

    const dupFetchSiteArray = await send('POST', {
      host: '127.0.0.1:3000',
      'sec-fetch-site': ['same-origin', 'cross-site'],
      'content-type': 'application/json',
    });
    assert.equal(dupFetchSiteArray.status, 403);

    const dupOriginArray = await send('POST', {
      host: '127.0.0.1:3000',
      origin: ['', 'https://evil.example'],
      'x-weave-rpc-token': validToken,
      'content-type': 'application/json',
    });
    assert.equal(dupOriginArray.status, 403);

    const dupTokenArray = await send('POST', {
      host: '127.0.0.1:3000',
      'x-weave-rpc-token': [validToken, 'junk'],
      'content-type': 'application/json',
    });
    assert.equal(dupTokenArray.status, 403);

    const dupHostMixedCase = await send('POST', {
      Host: '127.0.0.1:3000',
      host: 'evil.attacker:3000',
      'x-weave-rpc-token': validToken,
      'content-type': 'application/json',
    });
    assert.equal(dupHostMixedCase.status, 403);

    // Non-HTTP(S) Origin schemes, userinfo, and path in Origin => 403
    for (const badOrigin of [
      'ftp://127.0.0.1:3000',
      'ws://127.0.0.1:3000',
      'http://evil@127.0.0.1:3000',
      'http://127.0.0.1:3000/evil',
    ]) {
      const res = await send('POST', {
        host: '127.0.0.1:3000',
        origin: badOrigin,
        'x-weave-rpc-token': validToken,
        'content-type': 'application/json',
      });
      assert.equal(res.status, 403, `bad origin must be refused: ${badOrigin}`);
    }

    // Scheme-aware default-port normalization: reject 80 vs https 443 confusion, accept https :443
    const port80VsHttpsOrigin = await send('POST', {
      host: '127.0.0.1:80',
      origin: 'https://127.0.0.1',
      'content-type': 'application/json',
    });
    assert.equal(port80VsHttpsOrigin.status, 403);

    const port80VsHttpsReferer = await send('POST', {
      host: '127.0.0.1:80',
      referer: 'https://127.0.0.1/settings',
      'content-type': 'application/json',
    });
    assert.equal(port80VsHttpsReferer.status, 403);

    const https443Origin = await send(
      'POST',
      {
        host: '127.0.0.1:443',
        origin: 'https://127.0.0.1',
        'x-weave-rpc-token': validToken,
        'content-type': 'application/json',
      },
      '{"method":"get"}',
      { socket: { remoteAddress: '127.0.0.1', encrypted: true } },
    );
    assert.equal(https443Origin.status, 200);

    const https443Referer = await send(
      'POST',
      {
        host: '127.0.0.1:443',
        referer: 'https://127.0.0.1:443/settings',
        'x-weave-rpc-token': validToken,
        'content-type': 'application/json',
      },
      '{"method":"get"}',
      { socket: { remoteAddress: '127.0.0.1', encrypted: true } },
    );
    assert.equal(https443Referer.status, 200);

    // Contradictory Tier-3 headers => 403
    const sameOriginEvilReferer = await send('POST', {
      host: '127.0.0.1:3000',
      'sec-fetch-site': 'same-origin',
      referer: 'https://evil.example/pwn',
      'content-type': 'application/json',
    });
    assert.equal(sameOriginEvilReferer.status, 403);

    const sameSiteWithSameOriginReferer = await send('POST', {
      host: '127.0.0.1:3000',
      'sec-fetch-site': 'same-site',
      referer: 'http://127.0.0.1:3000/settings',
      'content-type': 'application/json',
    });
    assert.equal(sameSiteWithSameOriginReferer.status, 403);

    // Naked local curl (no connection, no token, no Origin, no Referer, no same-origin) => 403 missing origin refused
    const nakedCurl = await send('POST', {
      host: '127.0.0.1:3000',
      'content-type': 'application/json',
    });
    assert.equal(nakedCurl.status, 403);
    assert.equal(nakedCurl.json.error?.message, 'missing origin refused');

    // Tier 1 precedence: when connection service rejects with 401, valid token must NOT bypass it
    connectionService = {
      requestRejection(req) {
        return req.headers?.authorization === 'Bearer ok' ? undefined : 401;
      },
    };
    const tokenCannotBypassConn = await send('POST', {
      host: '127.0.0.1:3000',
      'x-weave-rpc-token': validToken,
      'content-type': 'application/json',
    });
    assert.equal(tokenCannotBypassConn.status, 401);
  } finally {
    webServerDispose?.();
    dispose?.();
  }
  assert.equal(routeDisposed, true, 'webServer route disposer must run');
  assert.equal(indexInjectListeners.size, 0, 'webserver/index-inject listener must be disposed without leak');

  // Process-level token persists across plugin reload/toggle so one-shot Electron boot global keeps working
  let reloadedRoute = null;
  let reloadDispose = null;
  const reloadListeners = new Set();
  const disposeReload = mountGate(
    {
      on() {},
      provide() {},
      get() { return null; },
      inject(deps, cb) {
        if (Array.isArray(deps) && deps.includes('webServer')) {
          reloadDispose = cb({
            on(event, listener) {
              if (event === 'webserver/index-inject') {
                reloadListeners.add(listener);
                return () => reloadListeners.delete(listener);
              }
              return () => {};
            },
            effect(fn) { return fn(); },
            webServer: {
              host: '127.0.0.1',
              register(route) {
                reloadedRoute = route;
                return () => { throw new Error('dispose route boom'); };
              },
            },
          });
          return reloadDispose;
        }
        return () => {};
      },
    },
    {},
  );
  try {
    const reloadTable = [];
    for (const listener of reloadListeners) {
      listener(reloadTable);
      listener(reloadTable);
    }
    const tokenRows = reloadTable.filter((row) => row?.kind === 'global' && row?.name === '__WEAVE_RPC_TOKEN__');
    assert.equal(tokenRows.length, 1, 'index-inject listener must deduplicate __WEAVE_RPC_TOKEN__ in a table');
    assert.equal(tokenRows[0].value, firstBootToken, 'process-level rpcToken must survive plugin reload/toggle');
    const reloadedRes = await new Promise((resolveRes) => {
      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        socket: { remoteAddress: '127.0.0.1' },
        headers: {
          host: '127.0.0.1:3000',
          'x-weave-rpc-token': firstBootToken,
          'content-type': 'application/json',
        },
      });
      const out = { statusCode: 200, body: '' };
      const res = {
        set statusCode(code) { out.statusCode = code; },
        get statusCode() { return out.statusCode; },
        setHeader() {},
        end(chunk = '') {
          out.body = String(chunk);
          resolveRes({ status: out.statusCode, json: JSON.parse(out.body) });
        },
      };
      Promise.resolve(reloadedRoute.handler(req, res)).catch(() => {});
      req.emit('data', Buffer.from('{"method":"get"}'));
      req.emit('end');
    });
    assert.equal(reloadedRes.status, 200);
    assert.equal(reloadedRes.json.ok, true);
  } finally {
    assert.throws(() => reloadDispose?.(), /dispose route boom/);
    disposeReload?.();
  }
  assert.equal(reloadListeners.size, 0, 'index-inject listener must still clean up when disposeRoute throws');

  // Verify cleanup when webServer.register throws after host.on succeeded
  const leakedListeners = new Set();
  const disposeOnFail = mountGate(
    {
      on() {},
      provide() {},
      get(name) {
        if (name === 'llm') {
          return {
            listProviders: () => [{ id: 'deepseek' }],
            listModels: async () => ['deepseek-chat'],
          };
        }
        return null;
      },
      inject(deps, cb) {
        if (Array.isArray(deps) && deps.includes('webServer')) {
          return cb({
            on(event, listener) {
              if (event === 'webserver/index-inject') {
                leakedListeners.add(listener);
                return () => leakedListeners.delete(listener);
              }
              return () => {};
            },
            effect(fn) { return fn(); },
            webServer: {
              host: '127.0.0.1',
              register() { throw new Error('route conflict'); },
            },
          });
        }
        return () => {};
      },
    },
    {},
  );
  disposeOnFail?.();
  assert.equal(leakedListeners.size, 0, 'failed webServer.register must clean up webserver/index-inject listener');
});

await test('Issue19-client-attaches-rpc-token-header-on-rpc-and-status-poller', async () => {
  // End-to-end simulation of DSH Desktop 0.2.3-alpha.2 (no connection service, missing Origin header):
  // lib/index.js injects __WEAVE_RPC_TOKEN__ -> lib/client.js attaches x-weave-rpc-token on both rpc() & status poller -> 200
  let registered = null;
  let webServerDispose = null;
  const indexInjectListeners = new Set();
  const disposeHost = mountGate(
    {
      on() {},
      provide() {},
      get(name) {
        if (name === 'llm') {
          return {
            listProviders: () => [{ id: 'deepseek' }],
            listModels: async () => ['deepseek-chat'],
          };
        }
        return null;
      },
      inject(deps, cb) {
        if (Array.isArray(deps) && deps.includes('webServer')) {
          webServerDispose = cb({
            on(event, listener) {
              if (event === 'webserver/index-inject') {
                indexInjectListeners.add(listener);
                return () => indexInjectListeners.delete(listener);
              }
              return () => {};
            },
            effect(fn) { return fn(); },
            webServer: {
              host: '127.0.0.1',
              register(route) {
                registered = route;
                return () => {};
              },
            },
          });
          return webServerDispose;
        }
        return () => {};
      },
    },
    {},
  );
  try {
    const injectTable = [];
    for (const listener of indexInjectListeners) listener(injectTable);
    const tokenEntry = injectTable.find((row) => row?.kind === 'global' && row?.name === '__WEAVE_RPC_TOKEN__');
    assert.ok(tokenEntry?.value);

    const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
    const dispatchToHost = (options) =>
      new Promise((resolveRes) => {
        const req = Object.assign(new EventEmitter(), {
          method: options.method,
          socket: { remoteAddress: '127.0.0.1' },
          // Simulate DSH Desktop 0.2.3-alpha.2: loopback Host, no Origin, no Referer, no Sec-Fetch-Site
          headers: { host: '127.0.0.1:3000', ...options.headers },
        });
        const out = { statusCode: 200, body: '' };
        const res = {
          set statusCode(code) { out.statusCode = code; },
          get statusCode() { return out.statusCode; },
          setHeader() {},
          end(chunk = '') {
            out.body = String(chunk);
            resolveRes({ status: out.statusCode, text: async () => out.body });
          },
        };
        const p = registered.handler(req, res);
        req.emit('data', Buffer.from(options.body));
        req.emit('end');
        Promise.resolve(p).catch(() => {});
      });

    const runClientProbe = async (injectedToken, { onWindowOnly = false } = {}) => {
      let mod = null;
      const slots = new Map();
      const observed = [];
      const pending = [];
      const effects = [];
      const React = {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
        useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
        useMemo: (fn) => fn(),
        useRef: (init) => ({ current: init }),
        useCallback: (fn) => fn,
        useEffect: (fn) => { effects.push(fn); },
      };
      const sandbox = {
        window: {
          ...(onWindowOnly && injectedToken !== undefined ? { __WEAVE_RPC_TOKEN__: injectedToken } : {}),
          __ModuleLoader__: {
            load: (decl) => { mod = decl.factory(() => React); },
          },
        },
        ...(!onWindowOnly && injectedToken !== undefined ? { __WEAVE_RPC_TOKEN__: injectedToken } : {}),
        document: { hidden: false, addEventListener() {}, removeEventListener() {} },
        console,
        AbortController,
        setTimeout: () => 1,
        clearTimeout: () => {},
        fetch: (_url, options) => {
          const payload = JSON.parse(options.body);
          const task = dispatchToHost(options).then(async (res) => {
            const raw = await res.text();
            observed.push({ method: payload.method, headers: { ...options.headers }, status: res.status, json: JSON.parse(raw) });
            return { status: res.status, text: async () => raw };
          });
          pending.push(task);
          return task;
        },
      };
      vm.runInNewContext(clientSource, sandbox);
      mod.apply({
        slots: {
          inject: (_n, cb) => cb(),
          register: (desc, comp) => { slots.set(desc.name, comp); return () => {}; },
        },
        effect: (cb) => cb(),
        locale: {
          register: () => () => {},
          bind: () => (k) => k,
        },
      });
      // Mount settings section (triggers rpc('get') and rpc('models')) and conversation dock (triggers status poller)
      const Settings = slots.get('settings.section');
      const Dock = slots.get('conversation.input.dock');
      assert.equal(typeof Settings, 'function');
      assert.equal(typeof Dock, 'function');
      Settings({});
      Dock({ sessionId: 'sess-issue19' });
      const cleanups = effects.map((fn) => fn()).filter((c) => typeof c === 'function');
      await Promise.allSettled(pending);
      for (const cleanup of cleanups) cleanup();
      return observed;
    };

    // With injected token: all 3 calls (get, models, status) carry x-weave-rpc-token and get HTTP 200
    const withToken = await runClientProbe(tokenEntry.value);
    const methodsWithToken = new Set(withToken.map((r) => r.method));
    assert.ok(methodsWithToken.has('get'), 'settings section must call rpc(get)');
    assert.ok(methodsWithToken.has('models'), 'settings section must call rpc(models)');
    assert.ok(methodsWithToken.has('status'), 'conversation dock must poll status');
    for (const call of withToken) {
      assert.equal(call.headers['x-weave-rpc-token'], tokenEntry.value, `${call.method} must send x-weave-rpc-token`);
      assert.equal(call.status, 200, `${call.method} must succeed with 200 without Origin header`);
      assert.equal(call.json.ok, true, `${call.method} must return ok: true`);
    }

    // Also works when injected onto window.__WEAVE_RPC_TOKEN__ in a separate window object
    const withWindowToken = await runClientProbe(tokenEntry.value, { onWindowOnly: true });
    assert.ok(withWindowToken.length >= 3);
    for (const call of withWindowToken) {
      assert.equal(call.headers['x-weave-rpc-token'], tokenEntry.value);
      assert.equal(call.status, 200);
      assert.equal(call.json.ok, true);
    }

    // Without injected token (or whitespace-only): header is omitted and naked missing-Origin request is rejected with 403
    for (const blank of [undefined, '', '   ']) {
      const withoutToken = await runClientProbe(blank);
      assert.ok(withoutToken.length >= 3);
      for (const call of withoutToken) {
        assert.equal('x-weave-rpc-token' in call.headers, false, `${call.method} must omit token header when unset/blank`);
        assert.equal(call.status, 403, `${call.method} without token/origin/referer must be refused with 403`);
      }
    }
  } finally {
    webServerDispose?.();
    disposeHost?.();
  }
});

// ── 2. P0-2: runConcurrentPool awaits in-flight ordered commits & propagates pool signal ──

await test('P0-2-concurrent-pool-drains-ordered-commit-and-aborts-pool-signal-on-reject', async () => {
  let stillRunning = false;
  let sawPoolAbort = false;
  let releaseItem0;
  const item0Entered = new Promise((res) => { releaseItem0 = res; });
  let releaseWorker0;
  await assert.rejects(
    () =>
      runConcurrentPool([0, 1], {
        concurrency: 2,
        worker: async (item) => {
          if (item === 1) {
            await item0Entered;
            throw Object.assign(new Error('worker-1 failed'), { code: 'WORKER1_FAIL' });
          }
          return 'ok-0';
        },
        onItemReadyInOrder: async (_val, _spec, _idx, poolControl) => {
          stillRunning = true;
          releaseItem0();
          poolControl.signal.addEventListener('abort', () => {
            sawPoolAbort = true;
          }, { once: true });
          await new Promise((res) => {
            releaseWorker0 = res;
            setTimeout(res, 40);
          });
          stillRunning = false;
        },
      }),
    (err) => err?.code === 'WORKER1_FAIL',
  );
  releaseWorker0?.();
  assert.equal(stillRunning, false, 'runConcurrentPool must await active onItemReadyInOrder before rejecting');
  assert.equal(sawPoolAbort, true, 'poolControl.signal must abort when sibling worker fails');
});

// ── 3. P0-3 & P1-11: auditCompaction sub-quadratic latency & disable/enable antonym equivalence ──

await test('P0-3-and-P1-11-audit-performance-and-disable-enable-antonym-pair', () => {
  const sharedDomain = [];
  for (let i = 0; i < 40; i += 1) {
    sharedDomain.push({ seq: i + 1, text: `服务节点 node-${i + 1}（https://svc-${i + 1}.example:${8100 + i}）必须启用 mTLS 校验。` });
  }
  const t0 = performance.now();
  const report = auditCompaction({
    userMessages: sharedDomain,
    summaryText: makeSummary({ 1: '本轮已完成整体网络与服务节点巡检整理。' }),
    threshold: 0.6,
    includeAllConflicts: true,
  });
  const elapsedMs = performance.now() - t0;
  assert.equal(report.lost.length, 40);
  assert.ok(elapsedMs < 500, `Expected auditCompaction(n=40) < 500ms, got ${elapsedMs.toFixed(1)}ms`);

  const eq = auditCompaction({
    userMessages: [{ seq: 1, text: 'Always disable telemetry.' }],
    summaryText: makeSummary({ 1: '- Do not enable telemetry.' }),
    threshold: 0.6,
  });
  assert.equal(eq.polarityFlips, 0, 'disable vs do not enable must be equivalent');
  assert.equal(eq.lost.length, 0);

  const flip = auditCompaction({
    userMessages: [{ seq: 1, text: 'Always disable telemetry.' }],
    summaryText: makeSummary({ 1: '- Enable telemetry.' }),
    threshold: 0.6,
  });
  assert.equal(flip.polarityFlips, 1, 'disable vs enable must trigger polarity flip');

  const diffTopic = auditCompaction({
    userMessages: [{ seq: 1, text: 'Always disable telemetry.' }],
    summaryText: makeSummary({ 1: '- Enable logging.' }),
    threshold: 0.6,
  });
  assert.equal(diffTopic.polarityFlips, 0, 'unrelated enable/disable topic must not trigger polarity flip');

  const diffScope = auditCompaction({
    userMessages: [{ seq: 1, text: 'Always disable telemetry in staging.' }],
    summaryText: makeSummary({ 1: '- Enable telemetry in production.' }),
    threshold: 0.6,
  });
  assert.equal(diffScope.polarityFlips, 0, 'different scopes must not trigger enable/disable polarity flip');
});

// ── 4. P0-4: DSH 0.2.2-rc.1 live model selection routing & no agent/request listener ──

await test('P0-4-live-model-selection-order-and-no-deprecated-agent-request', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-w3-p04-'));
  try {
    const events = [];
    const session = makeMockSession();
    session.setRequestHeaderModel('header-prov', 'header-model');
    let selectedModel = { provider: 'current-prov', model: 'current-model' };
    const agent = {
      session,
      options: { provider: 'opt-prov', model: 'opt-model' },
      model: { current: () => selectedModel },
    };

    const resolvedFromCurrent = resolveSummaryTargets({ config: DEFAULT_CONFIG, agent });
    assert.equal(resolvedFromCurrent.targets[0].provider, 'current-prov');
    assert.equal(resolvedFromCurrent.targets[0].model, 'current-model');
    assert.equal(resolvedFromCurrent.targets[0].source, 'model');

    const resolvedFromPreStep = resolveSummaryTargets({
      config: DEFAULT_CONFIG,
      agent,
      modelSelection: { provider: 'step-prov', model: 'step-model', reasoningEffort: 'high' },
    });
    assert.equal(resolvedFromPreStep.targets[0].provider, 'step-prov');
    assert.equal(resolvedFromPreStep.targets[0].model, 'step-model');
    assert.equal(resolvedFromPreStep.targets[0].reasoningEffort, 'high');

    selectedModel = null;
    const resolvedFromHeader = resolveSummaryTargets({ config: DEFAULT_CONFIG, agent });
    assert.equal(resolvedFromHeader.targets[0].provider, 'header-prov');
    assert.equal(resolvedFromHeader.targets[0].model, 'header-model');

    session.setRequestHeaderModel('', '');
    const resolvedFromOptions = resolveSummaryTargets({ config: DEFAULT_CONFIG, agent });
    assert.equal(resolvedFromOptions.targets[0].provider, 'opt-prov');
    assert.equal(resolvedFromOptions.targets[0].model, 'opt-model');

    // Engine registers zero deprecated agent/request listeners and resolves policies from step modelSelection
    const cfg = resolveConfig({
      archiveDir: join(root, 'sessions'),
      modelPolicies: [
        { provider: 'step-prov', model: 'step-model', headroomTokens: 12000 },
        { provider: 'opt-prov', model: 'opt-model', headroomTokens: 44000 },
      ],
    }).config;
    const engine = new WeaveCompactionEngine(
      {
        on(name) { events.push(name); return () => {}; },
        provide() {},
      },
      cfg,
    );
    try {
      assert.equal(events.includes('agent/request'), false, 'must never listen on deprecated agent/request');
      await engine._stepModelSelection.run(
        { agent, session, selection: { provider: 'step-prov', model: 'step-model' } },
        async () => {
          const policy = engine._resolvePolicy(agent);
          assert.equal(policy.headroomTokens, 12000);
        },
      );
    } finally {
      engine.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 5. P0-5: Fallback recovery clears clean persisted commit instead of permanent RECOVERY_REQUIRED ──

await test('P0-5-recoverPending-finalizes-persisted-clean-replacement-without-locking', async () => {
  const txSource = readFileSync(join(REPO_ROOT, 'lib/transaction.js'), 'utf8');
  assert.ok(txSource.includes('atomicReplaceSync(temp, target)'), 'atomicRestore must use atomicReplaceSync');
  assert.equal(/fs\.renameSync\s*\(\s*temp\s*,\s*target\s*\)/.test(txSource), false);

  const root = await mkdtemp(join(TEST_BASE, 'weave-w3-p05-'));
  try {
    const engine = new WeaveCompactionEngine(
      {
        on() { return () => {}; },
        provide() {},
        sessions: { async flush() {} },
      },
      resolveConfig({ archiveDir: join(root, 'sessions') }).config,
    );
    try {
      // 1. After flush + committed journal, a transient state-write failure retains the committed journal
      //    and subsequent recoverPending idempotently resets breaker state and clears it without RECOVERY_REQUIRED.
      const s1 = makeMockSession({ id: 'sess-clean-recover' });
      const u1 = s1.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Keep rule' }] });
      s1.append('compaction/start', { compactionId: 'cmp-ok', turn: null });
      s1.append('user/message', {
        role: 'user',
        content: [{ type: 'text', text: 'checkpoint' }],
        source: { kind: 'compact-checkpoint', compactionId: 'cmp-ok' },
      }, { surfaceOp: { op: 'replace', startSeq: u1.seq, endSeq: u1.seq }, sourceEventSeqs: [u1.seq] });
      s1.append('compaction/end', { compactionId: 'cmp-ok', turn: null });
      engine.sessionState.update(s1.id, (cur) => ({ ...cur, failures: 2 }));
      await engine.journal.record({ sessionId: s1.id, compactionId: 'cmp-ok', phase: 'committed', startSeq: u1.seq, endSeq: u1.seq, failuresBefore: 2 });

      const origUpdate = engine.sessionState.update.bind(engine.sessionState);
      let failStateWrite = true;
      engine.sessionState.update = (id, fn) => {
        if (failStateWrite) throw new Error('transient state disk error');
        return origUpdate(id, fn);
      };
      await assert.rejects(() => engine.recoverPending(s1), /transient state disk error/);
      assert.equal((await engine.journal.pending(s1.id)).length, 1);

      failStateWrite = false;
      const rec = await engine.recoverPending(s1);
      assert.equal(rec.recovered, 0);
      assert.equal((await engine.journal.pending(s1.id)).length, 0);
      assert.equal(engine.sessionState.read(s1.id).failures, 0);

      // 2. By contrast, an uncommitted replacement (even with clean in-memory end before failed flush) must still fail closed.
      const s2 = makeMockSession({ id: 'sess-dirty-recover' });
      const u2 = s2.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Keep rule' }] });
      s2.append('compaction/start', { compactionId: 'cmp-err', turn: null });
      s2.append('user/message', {
        role: 'user',
        content: [{ type: 'text', text: 'checkpoint' }],
        source: { kind: 'compact-checkpoint', compactionId: 'cmp-err' },
      }, { surfaceOp: { op: 'replace', startSeq: u2.seq, endSeq: u2.seq }, sourceEventSeqs: [u2.seq] });
      s2.append('compaction/end', { compactionId: 'cmp-err', turn: null });
      await engine.journal.record({ sessionId: s2.id, compactionId: 'cmp-err', phase: 'committing', startSeq: u2.seq, endSeq: u2.seq, failuresBefore: 0 });
      await assert.rejects(() => engine.recoverPending(s2), (e) => e.code === 'RECOVERY_REQUIRED');
      assert.equal((await engine.journal.pending(s2.id)).length, 1);
    } finally {
      engine.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 6. P1-1: Observation mask uses host-scale deltaTokens matching surface measurement ──

await test('P1-1-observation-mask-uses-host-heuristic-delta-for-cjk-outputs', () => {
  const session = makeMockSession();
  const cjkOut = '测试工具输出状态正常继续推进任务。'.repeat(600); // ~10,800 CJK chars -> ~2,700 host heuristic tokens
  const u1 = session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Analyze CJK logs' }] });
  const a1 = session.append('assistant/message', {
    message: {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'tc-1', name: 'bash', args: { cmd: 'cat log' } }],
    },
  });
  const t1 = session.append('tool/result', {
    message: {
      role: 'tool',
      toolCallId: 'tc-1',
      content: [{ type: 'text', text: cjkOut }],
    },
  });
  session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Latest turn tail '.repeat(20) }] });
  const nodes = session.surface.nodes.map((seq) => {
    const ev = session.eventAt(seq);
    return { seq, tokens: estimateHostHeuristicMessage(session.deriveEventMessage(ev)) };
  });
  const measurement = { nodes, totalTokens: nodes.reduce((s, n) => s + n.tokens, 0), precision: 'heuristic' };
  const plan = planObservationMask(session, measurement, 50, {
    compactionId: 'mask-cjk-1',
    thresholdChars: 2000,
    headChars: 300,
    tailChars: 300,
  });
  assert.ok(plan && plan.targets.length === 1);
  assert.ok(plan.targets[0].savedTokens < 3500, `Expected host-scale savedTokens < 3500, got ${plan.targets[0].savedTokens}`);
  assert.ok(u1.seq >= 0 && a1.seq >= 0 && t1.seq >= 0);
});

// ── 7. P1-2: summaryCjkTokensPerChar default 0.75 + configurable [0.5, 1.5] + Settings UI/RPC ──

await test('P1-2-cjk-weight-default-075-and-configurable-10-compat-across-budget-rpc-ui', async () => {
  assert.equal(DEFAULT_CONFIG.summaryCjkTokensPerChar, 0.75);
  assert.throws(() => normalizeSummaryCjkTokensPerChar(0.49), /summaryCjkTokensPerChar/);
  assert.throws(() => normalizeSummaryCjkTokensPerChar(1.51), /summaryCjkTokensPerChar/);
  assert.throws(() => normalizeSummaryCjkTokensPerChar('1.0'), /summaryCjkTokensPerChar/);
  assert.equal(normalizeSummaryCjkTokensPerChar(0.754), 0.75);
  assert.equal(normalizeSummaryCjkTokensPerChar(1.0), 1);

  // 96k CJK chars fits 128k capacity under 0.75 (keeps prefix KV cache), exceeds under 1.0 compatibility weight
  const cjkSession = makeMockSession();
  for (let i = 0; i < 6; i += 1) {
    cjkSession.append('user/message', { role: 'user', content: [{ type: 'text', text: '中'.repeat(16000) }] });
  }
  const cjkNodes = cjkSession.surface.nodes;
  const ctxMock = { llm: { resolveModelInfo: () => ({ contextWindow: 128000 }) } };
  const capDefault = await resolveSummaryCapacity(ctxMock, { targets: [{ provider: 'deepseek', model: 'deepseek-chat' }] }, resolveConfig({ maxTokens: 8192, headroomTokens: 32000 }).config);
  const verbatimDefault = measureSummaryRange(cjkSession, { start: cjkNodes[0], end: cjkNodes.at(-1) }, { policy: resolveConfig().config, preservePrefixCache: true });
  assert.ok(verbatimDefault.inputTokens <= capDefault.targets[0].window && verbatimDefault.inputTokens < 74636, `Expected <74636 with 0.75 weight, got ${verbatimDefault.inputTokens}`);
  const plannedDefault = planSummaryRange(cjkSession, { start: cjkNodes[0], end: cjkNodes.at(-1) }, capDefault, { preservePrefixCache: true });
  assert.equal(plannedDefault.limited, false, '128k 96k-CJK session must not force split/disable prefix cache at default 0.75');

  const cfg10 = resolveConfig({ maxTokens: 8192, headroomTokens: 32000, summaryCjkTokensPerChar: 1.0 }).config;
  const cap10 = await resolveSummaryCapacity(ctxMock, { targets: [{ provider: 'deepseek', model: 'deepseek-chat' }] }, cfg10);
  const verbatim10 = measureSummaryRange(cjkSession, { start: cjkNodes[0], end: cjkNodes.at(-1) }, { policy: cfg10, preservePrefixCache: true });
  assert.ok(verbatim10.inputTokens >= 96000, `Expected >=96000 with 1.0 compat weight, got ${verbatim10.inputTokens}`);
  assert.ok(verbatim10.inputTokens > (128000 - 8192 - 32000) * 0.85);
  assert.equal(cap10.cjkTokensPerChar, 1);

  // Settings validation, RPC persistence, mergeSummaryConfig & UI select control
  const badRpc = validateSummaryConfig({ provider: '', model: '', summaryCjkTokensPerChar: 2.0 });
  assert.equal(badRpc.ok, false);
  assert.equal(badRpc.code, 'INVALID_SUMMARY_CJK_TOKENS_PER_CHAR');

  const root = await mkdtemp(join(TEST_BASE, 'weave-w3-cjk-ui-'));
  try {
    const file = join(root, 'summary-config.json');
    const saved = await handleSummaryConfigRpc({ method: 'set', params: { provider: '', model: '', summaryCjkTokensPerChar: 1.0 } }, file);
    assert.equal(saved.config.summaryCjkTokensPerChar, 1);
    assert.equal(mergeSummaryConfig(DEFAULT_CONFIG, readSummaryConfig(file, { strict: true })).summaryCjkTokensPerChar, 1);

    // Mount lib/client.js settings UI and verify selector defaults/save
    const clientSource = readFileSync(join(REPO_ROOT, 'lib/client.js'), 'utf8');
    const states = [];
    const effects = [];
    let stateIndex = 0;
    let effectIndex = 0;
    let Section = null;
    let mod = null;
    let dictionaries = null;
    const pendingFetches = new Set();
    const requests = [];
    const sandbox = {
      window: {
        __ModuleLoader__: {
          load(declaration) {
            mod = declaration.factory((name) => {
              assert.equal(name, 'react');
              return sandbox.React;
            });
          },
        },
      },
      React: {
        createElement(type, props, ...children) {
          return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
        },
        useState(init) {
          const i = stateIndex++;
          if (!(i in states)) states[i] = typeof init === 'function' ? init() : init;
          return [states[i], (next) => { states[i] = typeof next === 'function' ? next(states[i]) : next; }];
        },
        useEffect(cb) {
          const i = effectIndex++;
          if (!(i in effects)) effects[i] = { pending: true, callback: cb };
        },
      },
      fetch(_url, opts) {
        const payload = JSON.parse(opts.body);
        requests.push(payload);
        const task = (async () => {
          const value = payload.method === 'models'
            ? { providers: [{ provider: 'p', name: 'P', models: [{ id: 'm' }] }] }
            : await handleSummaryConfigRpc(payload, file);
          return { status: 200, text: async () => JSON.stringify({ ok: true, value }) };
        })();
        pendingFetches.add(task);
        void task.finally(() => pendingFetches.delete(task));
        return task;
      },
    };
    vm.runInNewContext(clientSource, sandbox);
    mod.apply({
      slots: {
        inject: (_n, cb) => cb(),
        register(desc, comp) { if (desc.name === 'settings.section') Section = comp; return () => {}; },
      },
      effect: (cb) => cb(),
      locale: { register: (_n, d) => { dictionaries = d; return () => {}; }, bind: () => (k) => dictionaries.zh[k] },
    });
    const render = () => {
      stateIndex = 0;
      effectIndex = 0;
      const tree = Section();
      for (const s of effects) if (s?.pending) { s.pending = false; s.callback(); }
      return tree;
    };
    const findNode = (node, pred) => {
      if (!node || typeof node !== 'object') return null;
      if (pred(node)) return node;
      for (const child of node.children ?? []) {
        const hit = findNode(child, pred);
        if (hit) return hit;
      }
      return null;
    };
    render();
    for (let i = 0; i < 4; i++) {
      if (pendingFetches.size > 0) await Promise.all([...pendingFetches]);
      await new Promise((r) => setImmediate(r));
      render();
    }
    const sel = findNode(render(), (n) => n.props?.id === 'weave-summary-cjk-tokens-per-char');
    assert.ok(sel);
    assert.equal(sel.props.value, '1');
    assert.deepEqual(sel.children.map((o) => o.props.value), ['0.75', '0.85', '1', '1.25']);
    sel.props.onChange({ target: { value: '0.75' } });
    render();
    const saveBtn = findNode(render(), (n) => n.type === 'button' && n.children.includes(dictionaries.zh.save));
    saveBtn.props.onClick();
    if (pendingFetches.size > 0) await Promise.all([...pendingFetches]);
    assert.equal(readSummaryConfig(file, { strict: true }).summaryCjkTokensPerChar, 0.75);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 8. P1-3: bypassHeuristicAudit never allows polarity flips through ──

await test('P1-3-bypassHeuristicAudit-strictly-blocks-polarity-reversal', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-w3-p13-'));
  try {
    const session = makeMockSession();
    const u1 = session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Never delete production logs.' }] });
    const a1 = session.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'Working log: ' + 'detail '.repeat(600) }] } });
    const cfg = resolveConfig({
      archiveDir: join(root, 'sessions'),
      auditBlockOnLoss: true,
      auditExhaustionPolicy: 'fallback',
      summaryRetryCount: 1,
      summaryRetryDelayMs: 0,
    }).config;
    const summaryText = makeSummary({
      1: 'Keep settings updated.',
      6: '[seq 0] Never delete production logs.',
    });
    const engine = new WeaveCompactionEngine(
      {
        on() { return () => {}; },
        provide() {},
        llm: {
          async *stream() {
            yield { type: 'text-delta', text: summaryText };
            yield { type: 'finish', kind: 'stop' };
          },
        },
      },
      cfg,
    );
    try {
      let auditCalls = 0;
      let fallbackCompleted = false;
      const origCreateFallback = engine._makeAuditExhaustionFallback.bind(engine);
      engine._makeAuditExhaustionFallback = (...args) => {
        const fn = origCreateFallback(...args);
        const wrapped = async (payload) => {
          const out = await fn(payload);
          if (out && typeof out === 'object') {
            delete out._validated;
            fallbackCompleted = true;
          }
          return out;
        };
        wrapped.eligibilityOpts = fn.eligibilityOpts;
        wrapped.onSkipped = fn.onSkipped;
        return wrapped;
      };
      engine._audit = () => {
        auditCalls += 1;
        if (!fallbackCompleted) {
          return {
            checked: 1,
            polarityFlips: 0,
            worstCoverage: 0.4,
            lost: [{ seq: u1.seq, line: 'Never delete production logs.', reason: 'coverage', coverage: 0.4 }],
          };
        }
        return {
          checked: 1,
          polarityFlips: 1,
          worstCoverage: 0,
          lost: [{ seq: u1.seq, line: 'Never delete production logs.', reason: 'polarity' }],
        };
      };
      await assert.rejects(
        () =>
          engine._compactRegionCore(
            u1.seq,
            a1.seq,
            { session, options: { provider: 'p', model: 'm' } },
            undefined,
            { manual: true, skipPlan: true },
          ),
        (err) => err?.code === 'CONSTRAINT_POLARITY_LOST' && fallbackCompleted && auditCalls >= 2,
      );
    } finally {
      engine.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 9. P1-4: MAX_TOKENS not in CONTENT_RETRY_CODES + SummaryAssembler preserves finite reasoningTokens ──

await test('P1-4-max-tokens-immediately-recoverable-and-reasoningTokens-preserved', async () => {
  assert.equal(CONTENT_RETRY_CODES.has('MAX_TOKENS'), false);
  let calls = 0;
  await assert.rejects(
    () =>
      summarizeWithChain({
        ctx: {
          llm: {
            async *stream() {
              calls += 1;
              yield { type: 'finish', kind: 'max-tokens' };
            },
          },
        },
        agent: { session: { id: 's-maxtok' } },
        input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
        chain: { targets: [{ provider: 'p', model: 'm' }] },
        options: { maxTokens: 512, retryCount: 2, retryDelayMs: 0 },
      }),
    (err) => err?.recoverable === true && err?.summaryRetryExhausted === false && calls === 1,
  );

  const assembler = new SummaryAssembler();
  assembler.push({ type: 'usage', usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 7 } });
  assert.deepEqual(assembler.usage, { inputTokens: 100, outputTokens: 20, reasoningTokens: 7 });

  const assembler2 = new SummaryAssembler();
  assembler2.push({ type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } });
  assert.equal('reasoningTokens' in assembler2.usage, false);
});

// ── 10. P1-6: isTailBalancedFrom requires running === 0 ──

await test('P1-6-unclosed-tail-tool-call-rejected-by-selectCompactableRange', () => {
  const session = makeMockSession();
  const u1 = session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'First turn '.repeat(40) }] });
  const a1 = session.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'Done first '.repeat(40) }] } });
  session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Second turn' }] });
  // Unclosed tool-call in retained tail
  session.append('assistant/message', {
    message: {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'tc-open', name: 'read', args: {} }],
    },
  });
  const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: 100 }));
  assert.equal(selectCompactableRange(session, { nodes }, 120, { allowUnbalancedPrefix: true }), null);
  assert.ok(u1.seq === 0 && a1.seq === 1);
});

// ── 11. P1-7 & P1-8: _adoptBiliFoldSpan surface check + _provideService before hooks ──

await test('P1-7-and-P1-8-service-before-hooks-and-adopt-span-change-abort', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-w3-p178-'));
  try {
    let hooksRegistered = 0;
    const conflictEngine = new WeaveCompactionEngine(
      {
        provide() {
          throw new Error('duplicate compaction service');
        },
        on() {
          hooksRegistered += 1;
          return () => {};
        },
      },
      resolveConfig({ archiveDir: join(root, 'sessions-conflict') }).config,
    );
    conflictEngine.dispose();
    assert.equal(hooksRegistered, 0, '_registerHooks must not run when _provideService fails');

    // _adoptBiliFoldSpan detects surface drift after archive.writeSpan and throws SPAN_CHANGED without writing compaction/start
    const engine = new WeaveCompactionEngine(
      { on() { return () => {}; }, provide() {} },
      resolveConfig({ archiveDir: join(root, 'sessions') }).config,
    );
    try {
      const session = makeMockSession({ id: 'sess-adopt-drift' });
      const u1 = session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Hello' }] });
      const b1 = session.append('assistant/message', {
        message: { role: 'assistant', content: [{ type: 'text', text: 'Folded' }] },
      });
      const origWrite = engine.archive.writeSpan.bind(engine.archive);
      engine.archive.writeSpan = async (args) => {
        const res = await origWrite(args);
        // Simulate another surface append mutating span interior mid-await
        const extra = session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Concurrent arrival' }] });
        session.surface.nodes.splice(1, 0, extra.seq);
        return res;
      };
      await assert.rejects(
        () =>
          engine._adoptBiliFoldSpan(
            session,
            { session, options: { provider: 'p', model: 'm' } },
            {
              startSeq: u1.seq,
              endSeq: b1.seq,
              surfaceRangeSeqs: [u1.seq, b1.seq],
              totalArchivedSeqs: [u1.seq, b1.seq],
              variant: 'v4',
            },
            { backupId: 'bkp-1' },
          ),
        (err) => err?.code === 'SPAN_CHANGED',
      );
      const starts = session.snapshotEvents().filter((e) => e.type === 'compaction/start');
      assert.equal(starts.length, 0);
    } finally {
      engine.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── 12. P1-9 & P2-1..P2-4: copy, openTurn recheck, Go FAIL regex, archive mutex, snip syntax, engine bounds, rc.1 hash ──

await test('P2-1-commitObservationMask-rechecks-openTurn-and-tool-preview-keeps-go-fail', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-w3-p21-'));
  try {
    const archive = new CompactionArchive({ root: join(root, 'sessions') });
    const session = makeMockSession({ id: 'sess-mask-race', openTurn: 1 });
    session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Run test' }] });
    session.append('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'tc-r', name: 'bash', args: {} }],
      },
    });
    const t = session.append('tool/result', {
      message: { role: 'tool', toolCallId: 'tc-r', content: [{ type: 'text', text: 'Z'.repeat(8000) }] },
    });
    const origWriteSpan = archive.writeSpan.bind(archive);
    archive.writeSpan = async (args) => {
      const path = await origWriteSpan(args);
      // Turn closes while writeSpan is awaiting!
      session.openTurn = null;
      return path;
    };
    const res = await commitObservationMask({
      session,
      plan: { compactionId: 'cmp-race-1', targets: [{ seq: t.seq, nextContent: [{ type: 'text', text: '[masked]' }], savedTokens: 1500 }] },
      archive,
    });
    assert.equal(res, null);
    assert.deepEqual(await archive.listSpans(session.id), [], 'orphaned archive span must be deleted when openTurn closed');

    const lines = [];
    for (let i = 0; i < 40; i += 1) lines.push(`ok test helper line ${i} `.repeat(3));
    lines.splice(20, 0, '--- FAIL: TestAuth (0.01s)', 'FAIL\tgithub.com/acme/pkg\t0.012s');
    const goLog = lines.join('\n');
    const preview = buildToolPreview(goLog, { headChars: 300, tailChars: 300, marker: '[omitted]', target: 'bash' });
    assert.ok(preview && preview.kind === 'diagnostic');
    assert.ok(preview.middle.includes('--- FAIL: TestAuth'), 'Go --- FAIL: diagnostic must be retained');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('P2-2-history-index-mutex-and-snip-history_read-syntax', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-w3-p22-'));
  try {
    const archive = new CompactionArchive({ root: join(root, 'sessions') });
    await Promise.all([
      archive.writeSpan({ sessionId: 's-race', compactionId: 'c-1', entries: [{ seq: 0, type: 'user/message', role: 'user', text: 'a' }] }),
      archive.writeSpan({ sessionId: 's-race', compactionId: 'c-2', entries: [{ seq: 1, type: 'user/message', role: 'user', text: 'b' }] }),
      archive.deleteSpan('s-race', 'c-1'),
      archive.writeSpan({ sessionId: 's-race', compactionId: 'c-3', entries: [{ seq: 2, type: 'user/message', role: 'user', text: 'c' }] }),
    ]);
    const list = await archive.listSpans('s-race');
    assert.ok(list.some((x) => x.compactionId === 'c-3'));

    // Verify snip produces valid JSON object call syntax history_read({ compactionId: "..." })
    const s = makeMockSession({ id: 'sess-snip-syntax', openTurn: 2 });
    const u1 = s.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Start task' }] });
    s.append('assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'tc-s', name: 'read', args: { file: 'a.js' } }] } });
    s.append('tool/result', { message: { role: 'tool', toolCallId: 'tc-s', content: [{ type: 'text', text: 'data '.repeat(2400) }] } });
    s.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Recent request 1 ' + 'x'.repeat(8000) }] });
    s.append('user/message', { role: 'user', content: [{ type: 'text', text: 'Recent request 2 ' + 'y'.repeat(8000) }] });
    const nodes = s.surface.nodes.map((seq) => ({ seq, tokens: estimateHostHeuristicMessage(s.deriveEventMessage(s.eventAt(seq))) }));
    const measurement = {
      nodes,
      totalTokens: nodes.reduce((acc, n) => acc + n.tokens, 0),
    };
    const snipPlan = planSnip(s, measurement, { keepRecentTurns: 1, keepRecentTokens: 2000, minSavingsTokens: 100 });
    assert.ok(snipPlan && snipPlan.spans.length >= 1);
    s.append('turn/start', { turn: 2 });
    const committed = await commitSnip({ session: s, plan: snipPlan, archive });
    assert.ok(committed);
    const stubEv = s.eventAt(s.surface.nodes.find((seq) => {
      const ev = s.eventAt(seq);
      return ev?.type === 'user/message' && ev.data?.source?.kind === 'compact-checkpoint';
    }));
    const stubText = stubEv?.data?.content?.map((b) => b.text).join('\n') ?? '';
    assert.match(stubText, /history_read\(\{ compactionId: "/);
    assert.ok(u1.seq === 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('P2-3-and-P2-4-engine-disposed-and-bounds-plus-rc1-fingerprint-and-atomic-config-tmp', async () => {
  const root = await mkdtemp(join(TEST_BASE, 'weave-w3-p234-'));
  try {
    const engine = new WeaveCompactionEngine({ on() { return () => {}; }, provide() {} }, resolveConfig({ archiveDir: join(root, 'sessions') }).config);
    for (let i = 0; i < 600; i += 1) {
      engine._setBounded(engine._failures, `s-${i}`, i);
      engine._setBounded(engine._stopped, `s-${i}`, true);
      engine._setBounded(engine._lastPostCompactHook, `s-${i}`, { trigger: 'auto' });
      engine._addBounded(engine._recoveryBlocked, `s-${i}`);
    }
    assert.ok(engine._failures.size <= 512);
    assert.ok(engine._stopped.size <= 512);
    assert.ok(engine._lastPostCompactHook.size <= 512);
    assert.ok(engine._recoveryBlocked.size <= 512);

    engine.dispose();
    const s = makeMockSession();
    assert.equal(await engine._emergencySnip({ session: s }, {}, undefined), null);
    assert.equal(await engine._spillTailToolOutputs({ session: s }), null);
    assert.equal(await engine._guardVisibleImageBudget({ session: s }), null);

    // rc.1 normalized append hash present
    assert.ok(
      HOST_NORMALIZED_FINGERPRINTS.session.append.includes('713afc30226dc9bb4c871b9907927d773f467fa64f990cf167e27bca79c00a21'),
      'HOST_NORMALIZED_FINGERPRINTS.session.append must include DSH 0.2.2-rc.1 hash',
    );

    // Concurrent writeSummaryConfig leaves clean config with zero stray .tmp files
    const cfgFile = join(root, 'summary-config.json');
    writeSummaryConfig(cfgFile, { provider: 'p1', model: 'm1' });
    writeSummaryConfig(cfgFile, { provider: 'p2', model: 'm2', summaryCjkTokensPerChar: 1.0 });
    const files = await readdir(root);
    assert.equal(files.some((n) => n.includes('.tmp-')), false);
    assert.equal(readSummaryConfig(cfgFile, { strict: true }).provider, 'p2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log(JSON.stringify({ passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, results }, null, 2));
if (results.some((r) => !r.pass)) process.exitCode = 1;
