// 宿主入口：把官方压缩引擎的行「原地换成」本插件。
//
// 为什么不能只靠 cordis.patch.yml：
//   官方把 compaction 放在 agent preset 内部的 isolate 组里
//     - id: preset-standard
//       config:
//         - id: compaction
//           name: cordis:group
//           isolate: { compaction: true, toolResultPruner: true }
//           config:
//             - id: compaction-basic
//               name: '@deepseek-ai/dsh-compaction-basic'
//   profile / bundle 的 patch 层只能按「顶层 id」匹配，进不到 preset 的
//   config.plugins 里（bili 的 dsh.bundle.patch.yml 注释明确写了这一点，
//   见 #1772/#2474/#3354）。
//
// 所以我们用 `internal/config` 全局钩子：配置树解析完成、插件加载之前，
// 把 name 是官方 compaction-basic 的行改写成自己的引擎。bili 用同一个钩子
// 把行改成 disabled:true（billion-context/dist/agent/dsh-compaction-gate.js）；
// 本插件用同一钩子，只把 name 换成自己的引擎入口。
//
// 改写是幂等的：改完 name 就不再匹配，重复解析不会叠加。
// 卸载本插件 = 关掉改写 = 官方引擎原样生效，不会留下半截状态。

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { installStockTransactionAdapter } from './transaction.js';
import { defaultArchiveRoot } from './history.js';
import { CompactionJournal } from './journal.js';
import { SessionStateStore } from './state.js';
import { resolveConfig } from './config.js';
import { installCommandHeartbeat } from './command-heartbeat.js';
import {
  MAX_BODY_BYTES,
  defaultSummaryConfigPath,
  handleSummaryConfigRpc,
  readSummaryConfig,
} from './summary-config.js';

export const name = 'compaction-weave';

/** Settings page RPC; the path follows the `/plugins/<name>/` convention. */
export const SUMMARY_RPC_PATH = '/plugins/dsh-compaction-weave/rpc';

/** 本插件只需要能写日志与拿配置树；引擎由被改写出来的那一行自己注入服务。 */
export const inject = [];

/**
 * 加载顺序屏障用的服务名。
 *
 * 为什么需要它：`internal/config` 是**加载期**钩子 —— 每一行在它自己的 fiber
 * 起来时把配置过一遍 waterfall。宿主用 `Promise.all` 并行创建行
 * （`cordis-plugin-loader/src/config/group.ts`），所以"配置树里能看到本插件"
 * 完全不能证明"本插件的监听器已经注册、并且早于目标行解析"。
 *
 * bili 用同一招：它的 `dsh.bundle.patch.yml` 给 `preset-standard/ptc/minimal/cordis`
 * 四行加了 `inject: [biliBasicCompactionPolicy]`，让这些 preset 等它的 gate
 * 就绪后再加载（`billion-context/dist/agent/dsh-compaction-gate.js` 里的
 * `ctx.reflect?.provide?.(BILI_COMPACTION_DISABLE_SERVICE, ...)`）。
 *
 * 我们照抄这个机制：本插件 provide 这个服务，`cordis.patch.yml` 里给四个
 * preset 行加同名的 `inject`。没有它，谁先谁后全看调度运气。
 */
const GATE_SERVICE = 'compactionWeaveGate';

const OFFICIAL_ENGINE_PACKAGES = new Set(['@deepseek-ai/dsh-compaction-basic']);

/** Delegate to the official command, decorating only its timeout error text. */
const COMMAND_COMPACT_PACKAGE = '@deepseek-ai/dsh-command-compact';

const ENGINE_SPECIFIER = 'dsh-compaction-weave/engine';
const COMMAND_SPECIFIER = 'dsh-compaction-weave/command-compact';

/**
 * Merge the Settings-page override over the gate row's inherited engine config.
 * Explicit user values win; everything else stays untouched.
 */
export function mergeSummaryConfig(rawEngine, savedSummary) {
  const engineConfig = { ...(rawEngine && typeof rawEngine === 'object' ? rawEngine : {}) };
  if (savedSummary && typeof savedSummary === 'object') {
    if (savedSummary.provider && savedSummary.model) {
      engineConfig.summarizationProvider = savedSummary.provider;
      engineConfig.summarizationModel = savedSummary.model;
      if (savedSummary.maxTokens !== null && savedSummary.maxTokens !== undefined) {
        engineConfig.maxTokens = savedSummary.maxTokens;
      }
    }
    for (const key of ['summaryRetryCount','summaryRetryDelayMs','summaryTimeoutMs']) {
      if (Number.isInteger(savedSummary[key])) engineConfig[key]=savedSummary[key];
    }
    // The trigger line is independent of the summary-model override: the user
    // may tune it while still following the session model.
    if (typeof savedSummary.minimumReductionRatio === 'number' && Number.isFinite(savedSummary.minimumReductionRatio)) engineConfig.minimumReductionRatio = savedSummary.minimumReductionRatio;
    if (typeof savedSummary.thresholdRatio === 'number' && Number.isFinite(savedSummary.thresholdRatio)) {
      engineConfig.thresholdRatio = savedSummary.thresholdRatio;
    }
  }
  return engineConfig;
}

export function apply(ctx, rawConfig = {}) {
  const mode = rawConfig?.mode === 'disable-and-inject' ? 'disable-and-inject' : 'replace';
  const summaryConfigPath = defaultSummaryConfigPath();
  const savedSummary = readSummaryConfig(summaryConfigPath);
  const engineConfig = mergeSummaryConfig(rawConfig?.engine, savedSummary);
  if (savedSummary?.provider && savedSummary?.model) {
    ctx.logger?.info?.(
      `[compaction-weave] summary model from settings: ${savedSummary.provider}/${savedSummary.model}` +
        (savedSummary.maxTokens === null ? '' : ` (maxTokens=${savedSummary.maxTokens})`),
    );
  }
  const logPath = rawConfig?.receiptPath ?? defaultReceiptPath();
  const state = { rewrites: 0, seenEntries: new Set() };
  installCommandHeartbeat(ctx);
  // Compaction liveness for the in-composer status card. The `compaction/start`
  // payload only carries `turn`; the owning session id comes from the
  // `session/event` envelope, so the map is keyed by that id. Entries disappear
  // on `compaction/end` (success or failure), keeping the card self-clearing.
  const activeCompactions = new Map();
  const compactionStatus = sessionId => {
    const entry = activeCompactions.get(sessionId);
    if (!entry) return { active: false, startedAt: null, elapsedMs: 0, turn: null };
    return {
      active: true,
      startedAt: entry.startedAt,
      elapsedMs: Math.max(0, Date.now() - entry.startedAt),
      turn: entry.turn,
    };
  };
  let stockAdapter;
  let llmService = null;
  // Optional: the live provider/model catalog that backs the settings selects.
  ctx.inject?.(['llm'], llmCtx => {
    llmService = llmCtx.llm;
    return () => {
      llmService = null;
    };
  });
  const recoveryConfigs = new Map();
  const rememberRecoveryConfig = raw => {
    const config = resolveConfig(raw).config;
    const journal = CompactionJournal.alongside(config.archiveDir ?? defaultArchiveRoot());
    const spec = [journal, new SessionStateStore(join(dirname(journal.root), 'state')), config.failureThreshold];
    recoveryConfigs.set(journal.root, spec); stockAdapter?.register(...spec);
  };
  rememberRecoveryConfig(engineConfig);
  const rememberEngineRows = rows => {
    for (const row of rows) {
      if (row?.name === ENGINE_SPECIFIER) rememberRecoveryConfig(row.config ?? {});
      if (Array.isArray(row?.config)) rememberEngineRows(row.config);
      else if (Array.isArray(row?.config?.plugins)) rememberEngineRows(row.config.plugins);
    }
  };
  // Install before the host loads a persisted Session. Unlike engine-scoped
  // hooks, this also runs before failed compaction tails are decoded on resume.
  ctx.inject?.(['sessionPersistence', 'sessions'], recoveryCtx => {
    try {
      const adapter = installStockTransactionAdapter(recoveryCtx.sessionPersistence, recoveryCtx.sessions, recoveryCtx.logger);
      stockAdapter = adapter;
      for (const spec of recoveryConfigs.values()) adapter.register(...spec);
      recoveryCtx.provide('compactionWeaveTransactions', adapter);
      return () => adapter.dispose();
    } catch (error) {
      recoveryCtx.logger?.warn?.(`[compaction-weave] stock transaction support unavailable: ${error.message}`);
    }
  });

  // Settings page transport. The host half only reads/writes the plugin-owned
  // JSON file; it never touches the profile patch or the session log.
  ctx.inject?.(['webServer'], host => {
    try {
      return host.effect(
        () =>
          host.webServer.register({
            kind: 'exact',
            path: SUMMARY_RPC_PATH,
            handler: (request, response) =>
              serveSummaryConfigRpc(
                request,
                response,
                summaryConfigPath,
                llmService ?? getLlmService(ctx),
                compactionStatus,
              ),
          }),
        'compaction-weave: summary settings route',
      );
    } catch (error) {
      ctx.logger?.warn?.(
        `[compaction-weave] summary settings route unavailable: ${error?.message ?? error}`,
      );
    }
  });

  if (typeof ctx.on !== 'function') {
    ctx.logger?.warn?.('[compaction-weave] ctx.on is unavailable; the engine will not be installed');
    return;
  }

  // Track live compactions so the composer card can say "compacting…" without
  // the client polling a host-only event. The two events are log-only and are
  // always written by the engine around the whole operation, so the bracket is
  // reliable: start on `compaction/start`, clear on `compaction/end`.
  ctx.on('session/event', (session, event) => {
    const type = event?.type;
    if (!session?.id) return;
    if (type === 'compaction/start') {
      activeCompactions.set(session.id, {
        startedAt: Date.now(),
        turn: event.data?.turn ?? null,
      });
    } else if (type === 'compaction/end') {
      activeCompactions.delete(session.id);
    }
  });

  ctx.on(
    'internal/config',
    function onInternalConfig(_raw, next) {
      const resolved = next();
      const rows = pluginRowsOf(resolved);
      if (rows === null) return resolved;

      const matched = countEngineRows(rows);
      if (matched === 0) return resolved;

      const entryName = readEntryName(this);
      const rewritten =
        mode === 'disable-and-inject'
          ? injectBesideOfficial(rows, engineConfig)
          : renameOfficialRows(rows, engineConfig);

      if (rewritten === null) return resolved;
      rememberEngineRows(rewritten.plugins);

      state.rewrites += 1;
      ctx.logger?.info?.(
        `[compaction-weave] engine installed in ${entryName} (mode=${mode}, ${matched} official row(s) rewritten)`,
      );
      // 落一份回执，用于核对改写是否覆盖到目标配置层。
      void writeReceipt(logPath, {
        at: new Date().toISOString(),
        entry: entryName,
        mode,
        matched,
        rewritten,
      }).catch(() => {});

      return withPluginRows(resolved, rewritten.plugins);
    },
    { global: true },
  );

  ctx.logger?.info?.(`[compaction-weave] gate ready (mode=${mode})`);

  // 对外宣告"gate 已就绪"。目标 preset 行在 `cordis.patch.yml` 里声明
  // `inject: [compactionWeaveGate]`，于是它们会等这个服务出现之后才开始解析
  // 自己的配置 —— 那时代理已经装好，改写一定赶得上。
  provideGateService(ctx, state);

  return () => {
    // 服务由 fiber 拥有，卸载时自动注销；这里只留一个显式 disposer 的钩子，
    // 方便测试与将来需要手动撤销的场合。
  };
}

/**
 * 把 gate 暴露成一个服务，供 preset 行 `inject` 等待。
 * @param {object} ctx
 * @param {{rewrites: number, seenEntries: Set<string>}} state
 */
function provideGateService(ctx, state) {
  const value = Object.freeze({
    owner: 'dsh-compaction-weave',
    ready: true,
    rewrites: () => state.rewrites,
  });
  try {
    if (typeof ctx.provide === 'function') {
      ctx.provide(GATE_SERVICE, value);
      return;
    }
    if (typeof ctx.reflect?.provide === 'function') {
      ctx.reflect.provide(GATE_SERVICE, value);
      return;
    }
  } catch (error) {
    // 名字被占用、或当前 fiber 没资格 provide：降级为"没有屏障"，
    // 让 gate 仍然能靠 internal/config 生效（只是不保证先后）。
    ctx.logger?.warn?.(
      `[compaction-weave] could not expose ${GATE_SERVICE}: ${error?.message ?? error}; ` +
        'load order is not guaranteed',
    );
  }
}

// ──────────────────────────────────────────────────────────────── 配置树改写

/**
 * 从 `internal/config` 的解析结果里取出插件行数组。
 *
 * 已知形态是 `{ plugins: [...] }`（bili 的 gate 就是这么读的）。但不同 DSH 版本
 * 可能直接传数组，或者包在 `config.plugins` 里，所以这里三种都认；认不出返回 null，
 * 调用方原样返回、不做任何改写 —— 宁可不动，也不要改错结构。
 *
 * @param {unknown} resolved
 * @returns {any[] | null}
 */
function pluginRowsOf(resolved) {
  if (Array.isArray(resolved)) return looksLikePluginRows(resolved) ? resolved : null;
  if (!resolved || typeof resolved !== 'object') return null;
  if (Array.isArray(resolved.plugins)) return resolved.plugins;
  if (Array.isArray(resolved.config?.plugins)) return resolved.config.plugins;
  return null;
}

/**
 * 把改写后的行数组放回原来的容器形状。
 * @param {unknown} resolved
 * @param {any[]} rows
 */
function withPluginRows(resolved, rows) {
  if (Array.isArray(resolved)) return rows;
  if (Array.isArray(resolved.plugins)) return { ...resolved, plugins: rows };
  return { ...resolved, config: { ...resolved.config, plugins: rows } };
}

/**
 * 判断一个 `config` 值是不是「插件行数组」。
 *
 * 官方 group 行会写 `group: true`，但 preset 里包住 group 的那一层不一定声明
 * `group`（`preset-standard` 的 config 就是裸数组）。所以不能只看 `group`
 * 标志，否则会漏掉 preset 内部的嵌套行 —— 那正是我们要改的地方。
 *
 * @param {unknown} value
 */
function looksLikePluginRows(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  let rowLike = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    if (typeof item.name === 'string' || typeof item.id === 'string') rowLike += 1;
  }
  return rowLike > 0;
}

/**
 * 找出一行里嵌套的插件行，并告诉调用方它们挂在哪里。
 *
 * 两种真实形态都要认：
 *   1. `cordis:group` 行 → `config` 直接是行数组
 *        - id: compaction
 *          name: cordis:group
 *          config: [ {id: compaction-basic, ...} ]
 *   2. `@deepseek-ai/dsh-agent-preset` 行 → `config.plugins` 是行数组
 *        - id: preset-cordis
 *          name: '@deepseek-ai/dsh-agent-preset'
 *          config: { id: cordis, order: 4, plugins: [ ... ] }
 *
 * 只认第一种的话，一旦宿主把整棵树（含 preset 声明）交给钩子，preset 内部
 * 就永远改不到 —— 那正是压缩完全没被接管的那种"看起来装上了"的故障。
 *
 * @param {any} row
 * @returns {{ key: 'config'|'plugins', rows: any[] } | null}
 */
function childRowsOf(row) {
  if (!row || typeof row !== 'object') return null;
  if (looksLikePluginRows(row.config)) return { key: 'config', rows: row.config };
  if (row.config && typeof row.config === 'object' && looksLikePluginRows(row.config.plugins)) {
    return { key: 'plugins', rows: row.config.plugins };
  }
  return null;
}

/** 把改写后的子行放回它原来挂的位置。 */
function withChildRows(row, key, rows) {
  if (key === 'config') return { ...row, config: rows };
  return { ...row, config: { ...row.config, plugins: rows } };
}

/**
 * 递归统计配置树里有多少个官方引擎行（含 group / preset 的嵌套 config）。
 * @param {readonly any[]} rows
 */
export function countEngineRows(rows) {
  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (typeof row.name === 'string' && OFFICIAL_ENGINE_PACKAGES.has(row.name)) total += 1;
    const child = childRowsOf(row);
    if (child !== null) total += countEngineRows(child.rows);
  }
  return total;
}

/**
 * 把官方引擎行原地换成我们的引擎，保留 id、位置与 isolate 归属。
 * 原有 config 会被合并进新行（这样 bili 写过的 auto:false 之类不会丢）。
 *
 * @param {readonly any[]} rows
 * @param {Record<string, unknown>} engineConfig
 * @returns {{plugins: any[], rewritten: number} | null}
 */
export function renameOfficialRows(rows, engineConfig) {
  let rewritten = 0;

  const walk = (list) => {
    let changed = false;
    const out = list.map((row) => {
      if (!row || typeof row !== 'object') return row;

      if (row.name === COMMAND_COMPACT_PACKAGE) {
        changed = true;
        return {...row,name:COMMAND_SPECIFIER};
      }
      if (typeof row.name === 'string' && OFFICIAL_ENGINE_PACKAGES.has(row.name)) {
        rewritten += 1;
        changed = true;
        const merged = {
          ...(row.config && typeof row.config === 'object' ? row.config : {}),
          ...engineConfig,
        };
        return { ...row, name: ENGINE_SPECIFIER, config: merged };
      }

      const child = childRowsOf(row);
      if (child !== null) {
        const nested = walk(child.rows);
        if (nested.changed) {
          changed = true;
          return withChildRows(row, child.key, nested.list);
        }
      }
      return row;
    });
    return { list: changed ? out : list, changed };
  };

  const result = walk(rows);
  if (!result.changed) return null;
  return { plugins: result.list, rewritten };
}

/**
 * 备用模式：不换名，而是把官方行关掉，并在同一层追加我们的引擎行。
 * 只在 `mode: disable-and-inject` 时使用；保留它是为了万一"换名"在某个
 * DSH 版本里不被 loader 接受时，有一条不需要改代码的退路。
 *
 * @param {readonly any[]} rows
 * @param {Record<string, unknown>} engineConfig
 */
export function injectBesideOfficial(rows, engineConfig) {
  let rewritten = 0;

  const walk = (list) => {
    const out = [];
    let changed = false;
    for (const row of list) {
      if (!row || typeof row !== 'object') {
        out.push(row);
        continue;
      }
      if (row.name === COMMAND_COMPACT_PACKAGE) {
        changed = true;
        out.push({...row,name:COMMAND_SPECIFIER});
        continue;
      }
      if (typeof row.name === 'string' && OFFICIAL_ENGINE_PACKAGES.has(row.name)) {
        rewritten += 1;
        changed = true;
        out.push({ ...row, disabled: true });
        out.push({
          id: `${typeof row.id === 'string' ? row.id : 'compaction'}-weave`,
          name: ENGINE_SPECIFIER,
          config: {
            ...(row.config && typeof row.config === 'object' ? row.config : {}),
            ...engineConfig,
          },
        });
        continue;
      }
      const child = childRowsOf(row);
      if (child !== null) {
        const nested = walk(child.rows);
        if (nested.changed) {
          changed = true;
          out.push(withChildRows(row, child.key, nested.list));
          continue;
        }
      }
      out.push(row);
    }
    return { list: changed ? out : list, changed };
  };

  const result = walk(rows);
  if (!result.changed) return null;
  return { plugins: result.list, rewritten };
}

// ──────────────────────────────────────────────────────────────── 杂项

/**
 * cordis 把监听器的 `this` 指向发事件的 context；bili 用同样的方式拿 entry 名。
 * 拿不到时给一个可读的占位，不影响改写。
 */
function readEntryName(listenerThis) {
  try {
    const raw = listenerThis?.entry?.options?.name;
    if (typeof raw === 'string' && raw.length > 0) return raw.slice(0, 120);
  } catch {
    // 忽略：读不到就用占位名
  }
  return 'unknown-entry';
}

function headerOf(request, name) {
  const value = request?.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

/** Same-origin guard copied from the project's other host plugins. */
function allowSameOrigin(request, response) {
  if (headerOf(request, 'sec-fetch-site') === 'cross-site') {
    sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'cross-site request refused' } });
    return false;
  }
  const origin = headerOf(request, 'origin');
  if (origin === undefined || origin === '') return true;
  if (origin === 'null') {
    sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'opaque origin refused' } });
    return false;
  }
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'unparsable origin' } });
    return false;
  }
  if (host !== headerOf(request, 'host')) {
    sendJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'origin does not match host' } });
    return false;
  }
  return true;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        const error = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
        error.code = 'payload-too-large';
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** Optional LLM service lookup; a missing service only disables the catalog. */
function getLlmService(ctx) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get('llm') : null;
  } catch {
    return null;
  }
}

async function serveSummaryConfigRpc(request, response, file, llm, compactionStatus) {
  if (!allowSameOrigin(request, response)) return;
  if (request?.method !== 'POST') {
    sendJson(response, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } });
    return;
  }
  let payload;
  try {
    const raw = await readBody(request);
    payload = raw === '' ? {} : JSON.parse(raw);
  } catch (error) {
    const code = error?.code === 'payload-too-large' ? 'payload-too-large' : 'bad-request';
    sendJson(response, 400, {
      ok: false,
      error: { code, message: error instanceof Error ? error.message : 'bad request' },
    });
    return;
  }
  try {
    const value = compactionStatus && payload?.method === 'status'
      ? compactionStatus(typeof payload?.params?.sessionId === 'string' ? payload.params.sessionId : '')
      : await handleSummaryConfigRpc(payload, file, llm);
    sendJson(response, 200, { ok: true, value });
  } catch (error) {
    sendJson(response, 200, {
      ok: false,
      error: {
        code: typeof error?.code === 'string' ? error.code : 'internal-error',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function defaultReceiptPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'storages', 'dsh-compaction-weave', 'gate-receipts.jsonl');
}

async function writeReceipt(file, record) {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(record) + '\n', 'utf8');
}

// 注意：不能 `Object.assign(apply, {name})` —— 函数的 `name` 是只读属性，
// 赋值会在模块加载期直接抛 TypeError。这里用普通对象做默认导出。
export default { name, inject, apply };
