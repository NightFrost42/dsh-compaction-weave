// Bounded concurrency pool with shared HTTP 429 AIMD slowdown, fail-fast
// sibling cancellation, and strictly ordered commit callbacks.

export const MIN_POOL_CONCURRENCY = 1;
export const MAX_POOL_CONCURRENCY = 6;
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 1500;
export const DEFAULT_ABORT_DRAIN_TIMEOUT_MS = 2000;

const RATE_LIMIT_CODE_RE = /rate[_-]?limit|too[_-]?many[_-]?requests|\b429\b/i;
const RATE_LIMIT_MSG_RE = /\b(?:HTTP[ /:]*)?429\b|rate[_\s-]?limit|too\s+many\s+requests|\b(?:RPM|TPM)\b/i;

const FATAL_AUTH_CODE_RE = /AUTH|CREDENTIAL|PERMISSION|UNAUTHORIZED|FORBIDDEN|\b401\b|\b403\b/i;
const FATAL_AUTH_NAME_RE = /AuthenticationError|PermissionDeniedError|UnauthorizedError|ForbiddenError/i;
const FATAL_AUTH_MSG_RE =
  /\b(?:HTTP[ /:]*)?(?:401|403)\b|\b(?:unauthorized|forbidden|authentication\s+(?:error|failed|required)|invalid\s+(?:api[\s_-]?key|credentials?)|credentials?\s+(?:invalid|expired|missing|denied)|permission\s+denied|access\s+denied)\b/i;
const FATAL_AUTH_TOKEN_RE = /\b(?:AUTH|CREDENTIAL|PERMISSION)\b/;

function collectErrorNodes(error, maxDepth = 8) {
  const nodes = [];
  const seen = new Set();
  const stack = [error];
  while (stack.length > 0 && nodes.length < maxDepth * 4) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    nodes.push(current);
    if (current.cause && typeof current.cause === 'object' && !seen.has(current.cause)) {
      stack.push(current.cause);
    }
    if (Array.isArray(current.failures)) {
      for (const failure of current.failures) {
        if (failure && typeof failure === 'object' && !seen.has(failure)) {
          stack.push(failure);
        }
      }
    }
  }
  return nodes;
}

function httpStatusOf(node) {
  return node?.status ?? node?.statusCode ?? node?.response?.status ?? null;
}

/**
 * Return true if `error` (or any entry in its cause / failures chain) indicates
 * provider rate-limiting (HTTP 429, rate_limit, too many requests, RPM/TPM).
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRateLimitError(error) {
  if (!error) return false;
  if (typeof error === 'string') return RATE_LIMIT_MSG_RE.test(error);
  for (const node of collectErrorNodes(error)) {
    if (httpStatusOf(node) === 429) return true;
    if (typeof node.code === 'string' && RATE_LIMIT_CODE_RE.test(node.code)) return true;
    if (typeof node.type === 'string' && RATE_LIMIT_CODE_RE.test(node.type)) return true;
    if (typeof node.message === 'string' && RATE_LIMIT_MSG_RE.test(node.message)) return true;
  }
  return false;
}

/**
 * Return true if `error` (or any entry in its cause / failures chain) indicates
 * a fatal authentication/authorization failure (HTTP 401/403 or AUTH/CREDENTIAL/PERMISSION).
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isFatalAuthError(error) {
  if (!error) return false;
  if (typeof error === 'string') return FATAL_AUTH_MSG_RE.test(error) || FATAL_AUTH_TOKEN_RE.test(error);
  for (const node of collectErrorNodes(error)) {
    const status = httpStatusOf(node);
    if (status === 401 || status === 403) return true;
    if (typeof node.code === 'string' && FATAL_AUTH_CODE_RE.test(node.code)) return true;
    if (typeof node.name === 'string' && FATAL_AUTH_NAME_RE.test(node.name)) return true;
    if (typeof node.type === 'string' && FATAL_AUTH_CODE_RE.test(node.type)) return true;
    if (
      typeof node.message === 'string' &&
      (FATAL_AUTH_MSG_RE.test(node.message) || FATAL_AUTH_TOKEN_RE.test(node.message))
    ) {
      return true;
    }
  }
  return false;
}

function clampConcurrency(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MIN_POOL_CONCURRENCY;
  return Math.max(MIN_POOL_CONCURRENCY, Math.min(MAX_POOL_CONCURRENCY, Math.floor(value)));
}

function abortErrorFrom(signal) {
  return signal?.reason ?? Object.assign(new Error('concurrent pool aborted'), { code: 'ABORTED' });
}

/**
 * Run `worker` over `items` with bounded concurrency (`1..6`), shared HTTP 429
 * AIMD slowdown (`effectiveConcurrency -> 1` + cooldown), fail-fast sibling
 * cancellation, and strictly ascending-index `onItemReadyInOrder` commits.
 *
 * @template T, R
 * @param {readonly T[]} items
 * @param {{
 *   concurrency?: number,
 *   signal?: AbortSignal,
 *   worker: (item: T, index: number, workerSignal: AbortSignal, poolControl: {
 *     noteRateLimit: (cooldownMs?: number) => void,
 *     readonly effectiveConcurrency: number,
 *     readonly rateLimited: boolean,
 *     readonly activeWorkers: number,
 *     readonly signal: AbortSignal,
 *   }) => Promise<R>,
 *   onItemReadyInOrder?: (result: R, item: T, index: number) => Promise<void> | void,
 *   onStateChange?: (state: { activeWorkers: number, effectiveConcurrency: number, rateLimited: boolean }) => void,
 *   rateLimitCooldownMs?: number,
 *   maxRateLimitRetries?: number,
 *   rateLimitRecoverySuccesses?: number,
 *   abortDrainTimeoutMs?: number,
 *   clock?: () => number,
 * }} options
 * @returns {Promise<{ results: R[], completedCount: number, effectiveConcurrency: number, rateLimited: boolean }>}
 */
export async function runConcurrentPool(items, options = {}) {
  const list = Array.isArray(items) ? items : Array.from(items ?? []);
  const worker = options?.worker;
  if (typeof worker !== 'function') {
    throw new TypeError('runConcurrentPool requires a worker function');
  }

  const initialConcurrency = clampConcurrency(options?.concurrency ?? MIN_POOL_CONCURRENCY);
  const externalSignal = options?.signal;
  if (externalSignal?.aborted) {
    throw abortErrorFrom(externalSignal);
  }
  if (list.length === 0) {
    return {
      results: [],
      completedCount: 0,
      effectiveConcurrency: initialConcurrency,
      rateLimited: false,
    };
  }

  const onItemReadyInOrder = typeof options?.onItemReadyInOrder === 'function' ? options.onItemReadyInOrder : null;
  const onStateChange = typeof options?.onStateChange === 'function' ? options.onStateChange : null;
  const rateLimitCooldownMs =
    typeof options?.rateLimitCooldownMs === 'number' &&
    Number.isFinite(options.rateLimitCooldownMs) &&
    options.rateLimitCooldownMs >= 0
      ? options.rateLimitCooldownMs
      : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  const maxRateLimitRetries =
    typeof options?.maxRateLimitRetries === 'number' &&
    Number.isInteger(options.maxRateLimitRetries) &&
    options.maxRateLimitRetries > 0
      ? options.maxRateLimitRetries
      : 0;
  const rateLimitRecoverySuccesses =
    typeof options?.rateLimitRecoverySuccesses === 'number' &&
    Number.isInteger(options.rateLimitRecoverySuccesses) &&
    options.rateLimitRecoverySuccesses > 0
      ? options.rateLimitRecoverySuccesses
      : 0;
  const abortDrainTimeoutMs =
    typeof options?.abortDrainTimeoutMs === 'number' &&
    Number.isFinite(options.abortDrainTimeoutMs) &&
    options.abortDrainTimeoutMs >= 0
      ? options.abortDrainTimeoutMs
      : DEFAULT_ABORT_DRAIN_TIMEOUT_MS;
  const now = typeof options?.clock === 'function' ? options.clock : () => Date.now();

  const internalController = new AbortController();
  const workerSignal = internalController.signal;

  let effectiveConcurrency = initialConcurrency;
  let activeWorkers = 0;
  let rateLimited = false;
  let cooldownUntil = 0;
  let cooldownTimer = null;
  let consecutiveCleanSuccesses = 0;
  let failed = false;
  let failureError = null;
  let settled = false;
  let commitRunning = false;
  let nextCommitIndex = 0;
  let completedCount = 0;

  const pendingIndices = list.map((_, idx) => idx);
  const retryCounts = new Map();
  const readyResults = new Map();
  const results = new Array(list.length);
  const inFlight = new Set();

  let lastEmittedState = null;
  const emitState = () => {
    if (!onStateChange) return;
    const snapshot = { activeWorkers, effectiveConcurrency, rateLimited };
    if (
      lastEmittedState &&
      lastEmittedState.activeWorkers === snapshot.activeWorkers &&
      lastEmittedState.effectiveConcurrency === snapshot.effectiveConcurrency &&
      lastEmittedState.rateLimited === snapshot.rateLimited
    ) {
      return;
    }
    lastEmittedState = snapshot;
    try {
      onStateChange(snapshot);
    } catch {
      /* best-effort telemetry must never interrupt pool work */
    }
  };

  let resolveOuter;
  let rejectOuter;
  const outerPromise = new Promise((resolve, reject) => {
    resolveOuter = resolve;
    rejectOuter = reject;
  });

  let onExternalAbort = null;
  const cleanup = () => {
    if (cooldownTimer !== null) {
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
    }
    if (onExternalAbort && externalSignal && typeof externalSignal.removeEventListener === 'function') {
      externalSignal.removeEventListener('abort', onExternalAbort);
      onExternalAbort = null;
    }
  };

  const finishReject = (err) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectOuter(err);
  };

  const finishResolve = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveOuter({
      results,
      completedCount,
      effectiveConcurrency,
      rateLimited,
    });
  };

  const abortPool = (err) => {
    if (failed) return;
    failed = true;
    failureError = err;
    if (cooldownTimer !== null) {
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
    }
    if (!internalController.signal.aborted) {
      internalController.abort(err);
    }
    emitState();
    if (inFlight.size === 0) {
      finishReject(failureError);
    } else {
      // Allow responsive sibling abort handlers and short async disk cleanup
      // to settle before settling the pool, without letting an uncooperative
      // worker hang cancellation indefinitely.
      const pending = Array.from(inFlight);
      let drainTimer = null;
      const drainPromise = Promise.allSettled(pending);
      void Promise.race([
        drainPromise,
        new Promise((resolve) => {
          drainTimer = setTimeout(resolve, abortDrainTimeoutMs);
        }),
      ]).then(() => {
        if (drainTimer !== null) {
          clearTimeout(drainTimer);
          drainTimer = null;
        }
        finishReject(failureError);
      });
    }
  };

  if (externalSignal && typeof externalSignal.addEventListener === 'function') {
    onExternalAbort = () => abortPool(abortErrorFrom(externalSignal));
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const noteRateLimit = (overrideCooldownMs) => {
    if (failed) return;
    const waitMs =
      typeof overrideCooldownMs === 'number' && Number.isFinite(overrideCooldownMs) && overrideCooldownMs >= 0
        ? overrideCooldownMs
        : rateLimitCooldownMs;
    rateLimited = true;
    effectiveConcurrency = MIN_POOL_CONCURRENCY;
    consecutiveCleanSuccesses = 0;
    cooldownUntil = Math.max(cooldownUntil, now() + waitMs);
    emitState();
  };

  const poolControl = {
    noteRateLimit,
    get effectiveConcurrency() {
      return effectiveConcurrency;
    },
    get rateLimited() {
      return rateLimited;
    },
    get activeWorkers() {
      return activeWorkers;
    },
    get signal() {
      return workerSignal;
    },
  };

  const checkDone = () => {
    if (failed || settled) return;
    if (
      pendingIndices.length === 0 &&
      activeWorkers === 0 &&
      !commitRunning &&
      nextCommitIndex === list.length
    ) {
      finishResolve();
    }
  };

  const drainCommits = async () => {
    if (commitRunning || failed) return;
    commitRunning = true;
    try {
      while (!failed && readyResults.has(nextCommitIndex)) {
        const idx = nextCommitIndex;
        const value = readyResults.get(idx);
        readyResults.delete(idx);
        // Free a head-of-line window slot immediately so workers for k+1.. can
        // keep making progress while `onItemReadyInOrder` awaits on index k.
        if (onItemReadyInOrder) scheduleLaunch();
        if (onItemReadyInOrder) {
          const commitTask = (async () => onItemReadyInOrder(value, list[idx], idx, poolControl))();
          inFlight.add(commitTask);
          try {
            await commitTask;
          } finally {
            inFlight.delete(commitTask);
          }
        }
        if (failed) return;
        results[idx] = value;
        completedCount += 1;
        nextCommitIndex += 1;
      }
    } catch (error) {
      abortPool(error);
    } finally {
      commitRunning = false;
      if (!failed) {
        if (readyResults.has(nextCommitIndex)) {
          void drainCommits();
        } else {
          scheduleLaunch();
          checkDone();
        }
      }
    }
  };

  const launchWorker = (index) => {
    activeWorkers += 1;
    emitState();

    let taskDone = false;
    const task = (async () => {
      try {
        const value = await worker(list[index], index, workerSignal, poolControl);
        if (failed) return;
        if (rateLimited && rateLimitRecoverySuccesses > 0 && effectiveConcurrency < initialConcurrency) {
          consecutiveCleanSuccesses += 1;
          if (consecutiveCleanSuccesses >= rateLimitRecoverySuccesses) {
            consecutiveCleanSuccesses = 0;
            effectiveConcurrency = Math.min(initialConcurrency, effectiveConcurrency + 1);
            emitState();
          }
        }
        readyResults.set(index, value);
        void drainCommits();
      } catch (error) {
        if (failed) return;
        if (isFatalAuthError(error)) {
          abortPool(error);
          return;
        }
        if (isRateLimitError(error)) {
          noteRateLimit();
          const attempts = retryCounts.get(index) ?? 0;
          if (attempts < maxRateLimitRetries) {
            retryCounts.set(index, attempts + 1);
            pendingIndices.unshift(index);
            return;
          }
        }
        abortPool(error);
      } finally {
        taskDone = true;
        inFlight.delete(task);
        activeWorkers = Math.max(0, activeWorkers - 1);
        emitState();
        if (!failed) {
          scheduleLaunch();
          checkDone();
        }
      }
    })();

    if (!taskDone) inFlight.add(task);
    task.catch(() => {});
  };

  const scheduleLaunch = () => {
    if (failed || settled) return;
    if (pendingIndices.length === 0) {
      checkDone();
      return;
    }
    const canLaunchMore = () =>
      activeWorkers < effectiveConcurrency &&
      (!onItemReadyInOrder || activeWorkers + readyResults.size < effectiveConcurrency);
    while (!failed && pendingIndices.length > 0 && canLaunchMore()) {
      const remainingCooldown = cooldownUntil - now();
      if (remainingCooldown > 0) {
        if (cooldownTimer === null) {
          cooldownTimer = setTimeout(() => {
            cooldownTimer = null;
            scheduleLaunch();
          }, remainingCooldown);
        }
        break;
      }
      const nextIndex = pendingIndices.shift();
      launchWorker(nextIndex);
    }
  };

  scheduleLaunch();
  return outerPromise;
}
