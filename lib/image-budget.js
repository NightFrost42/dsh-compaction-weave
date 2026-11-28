// Zero-I/O image budget metering, high/low watermark batch image/offload planner,
// summary-request image payload inspection/stripping, and multimodal error classifiers.

import { extractErrorChain, isBiliProxyPreflightError } from './bili-conflict.js';
import {
  formatStrippedImagePlaceholder,
  scanVisibleImages,
  stripImagesFromMessages,
} from './meter.js';
import {
  MAX_MASK_SOURCE_DEPTH,
  MAX_MASK_STAGE_REFS,
  commitObservationMask,
  inspectMaskSourceStats,
} from './observation-mask.js';

export const DEFAULT_MAX_VISIBLE_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_VISIBLE_IMAGES = 24;
export const DEFAULT_KEEP_HOT_IMAGES = 6;
export const OVERSIZED_IMAGE_EDGE_PX = 2000;
export const OVERSIZED_IMAGE_MIN_COUNT = 20;
export const SUMMARY_MAX_IMAGE_PAYLOAD_BYTES = 10 * 1024 * 1024;
export const SUMMARY_MAX_IMAGE_COUNT = 16;

export {
  formatStrippedImagePlaceholder,
  scanVisibleImages,
  stripImagesFromMessages,
};

const UPSTREAM_IMAGE_NOUN_RE = /\b(?:image|images|img|vision|multimodal|media)\b/i;
const UPSTREAM_IMAGE_LIMIT_RE =
  /(?:2000\s*(?:px|pixels?)?|\bdimension|dimensions\b|\bpixels?\b|too\s+many\s+images|many[- ]image|multi[- ]?image|image\s+count|max(?:imum)?\s+(?:number\s+of\s+)?images|exceeds?\s+max(?:imum)?\s+(?:image\s+)?(?:dimension|size|edge|width|height)|exceeds?\s+\d+\s*(?:mb|mib)|cannot\s+exceed\s+2000|larger\s+than\s+2000|single\s+edge)/i;
const BAD_REQUEST_CODES = new Set([
  'BAD_REQUEST',
  'INVALID_REQUEST',
  'INVALID_REQUEST_ERROR',
  'INVALID_ARGUMENT',
  'UNSUPPORTED_CONTENT',
]);

/**
 * Inspect un-offloaded images inside an assembled `messages` array for summary
 * calls without touching `request.inputUnits` (decoupled from the 448 KiB text cap).
 *
 * @param {readonly any[]} messages
 * @returns {{ imagePayloadBytes: number, imageCount: number, oversizedEdgeCount: number, exceedsSummaryImageLimit: boolean }}
 */
export function inspectMessagesImages(messages) {
  let imagePayloadBytes = 0;
  let imageCount = 0;
  let oversizedEdgeCount = 0;

  if (!Array.isArray(messages)) {
    return { imagePayloadBytes, imageCount, oversizedEdgeCount, exceedsSummaryImageLimit: false };
  }

  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object' || block.type !== 'image' || block.offloaded === true) {
        continue;
      }
      const att = block.attachment;
      const bytes = typeof att?.bytes === 'number' && Number.isFinite(att.bytes) && att.bytes > 0 ? att.bytes : 0;
      const width = typeof att?.width === 'number' && Number.isFinite(att.width) && att.width > 0 ? att.width : 0;
      const height = typeof att?.height === 'number' && Number.isFinite(att.height) && att.height > 0 ? att.height : 0;
      imagePayloadBytes += bytes > 0 ? Math.ceil(bytes / 3) * 4 : 0;
      imageCount += 1;
      if (Math.max(width, height) > OVERSIZED_IMAGE_EDGE_PX) {
        oversizedEdgeCount += 1;
      }
    }
  }

  const exceedsSummaryImageLimit =
    imagePayloadBytes > SUMMARY_MAX_IMAGE_PAYLOAD_BYTES ||
    imageCount >= SUMMARY_MAX_IMAGE_COUNT ||
    (imageCount >= OVERSIZED_IMAGE_MIN_COUNT && oversizedEdgeCount > 0);

  return {
    imagePayloadBytes,
    imageCount,
    oversizedEdgeCount,
    exceedsSummaryImageLimit,
  };
}

/**
 * Measure un-offloaded visible images on `session` in O(1) per block (zero I/O).
 * @param {object} session
 * @param {readonly number[]} [seqs]
 */
export function measureVisibleImages(session, seqs = undefined) {
  return scanVisibleImages(session, seqs);
}

/**
 * Identify `IMAGE_OFFLOAD_REQUIRED` errors across Error causes and aggregated failures.
 * Never matches bili proxy 413 errors.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isImageOffloadRequiredError(error) {
  if (!error || isBiliProxyPreflightError(error)) return false;
  const chain = extractErrorChain(error);
  for (const item of chain) {
    if (
      item.code === 'IMAGE_OFFLOAD_REQUIRED' ||
      item.failureCode === 'IMAGE_OFFLOAD_REQUIRED' ||
      item.failureCodes.includes('IMAGE_OFFLOAD_REQUIRED')
    ) {
      return true;
    }
  }
  const failures = error?.failures;
  if (Array.isArray(failures)) {
    for (const f of failures) {
      if (f?.code === 'IMAGE_OFFLOAD_REQUIRED') return true;
    }
  }
  return false;
}

/**
 * Unwrap the innermost `Error` / `LlmError` carrying `IMAGE_OFFLOAD_REQUIRED`
 * so `@deepseek-ai/dsh-compaction-image-offload` receives the real `LlmError`
 * instance and its `failure.offloadImages` count.
 *
 * @param {unknown} error
 * @returns {unknown}
 */
export function extractRawImageOffloadError(error) {
  if (!error || typeof error !== 'object') return error;
  const seen = new Set();
  let best = null;
  for (let current = error, depth = 0; current && depth < 6 && !seen.has(current); current = current.cause, depth += 1) {
    seen.add(current);
    if (typeof current === 'object' && current.code === 'IMAGE_OFFLOAD_REQUIRED') {
      if (!best || current instanceof Error) {
        best = current;
      }
    }
  }
  return best ?? error;
}

/**
 * Detect upstream HTTP 400 multi-image or single-edge >2000px rejections.
 * Strictly respects the billion-context proxy 413 redline (`false` on any bili or 413 error).
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isUpstreamMultimodal400Error(error) {
  if (!error || isBiliProxyPreflightError(error)) return false;
  const inspectOne = (candidate) => {
    for (const item of extractErrorChain(candidate)) {
      const st = item.httpStatus ?? item.status ?? item.statusCode;
      if (st === 413) return false;
      if (st !== null && st !== 400) continue;
      const msg = item.message ?? '';
      if (!msg || /cannot contain image output/i.test(msg)) continue;
      if (item.code === 'IMAGE_OFFLOAD_REQUIRED' || item.failureCode === 'IMAGE_OFFLOAD_REQUIRED') continue;
      if (!UPSTREAM_IMAGE_NOUN_RE.test(msg) || !UPSTREAM_IMAGE_LIMIT_RE.test(msg)) continue;
      const mentions400 =
        st === 400 ||
        /\b(?:HTTP\s+)?400\b/i.test(msg) ||
        BAD_REQUEST_CODES.has(item.code ?? '') ||
        BAD_REQUEST_CODES.has(item.failureCode ?? '');
      if (mentions400 || st === null) return true;
    }
    return false;
  };
  if (inspectOne(error)) return true;
  if (Array.isArray(error?.failures)) {
    for (const f of error.failures) {
      if (f && inspectOne(f)) return true;
    }
  }
  return false;
}

/**
 * Plan a high/low-watermark hysteresis batch `image/offload` across visible images
 * on `session`, retaining the newest `keepHotImages` (default 6) hot images to
 * avoid per-turn KV-cache invalidation.
 *
 * @param {object} session
 * @param {{ maxVisibleAttachmentBytes?: number, maxVisibleImages?: number, keepHotImages?: number, force?: boolean }} [options]
 */
export function planVisibleImageOffload(session, options = {}) {
  const stats = scanVisibleImages(session);
  if (stats.entries.length === 0) return null;

  const maxVisibleAttachmentBytes =
    typeof options.maxVisibleAttachmentBytes === 'number' &&
    Number.isFinite(options.maxVisibleAttachmentBytes) &&
    options.maxVisibleAttachmentBytes >= 0
      ? Math.floor(options.maxVisibleAttachmentBytes)
      : DEFAULT_MAX_VISIBLE_ATTACHMENT_BYTES;
  const maxVisibleImages =
    typeof options.maxVisibleImages === 'number' &&
    Number.isFinite(options.maxVisibleImages) &&
    options.maxVisibleImages >= 0
      ? Math.floor(options.maxVisibleImages)
      : DEFAULT_MAX_VISIBLE_IMAGES;
  const keepHotImages =
    Number.isSafeInteger(options.keepHotImages) && options.keepHotImages >= 0
      ? options.keepHotImages
      : DEFAULT_KEEP_HOT_IMAGES;
  const force = options.force === true;

  const byteTriggered =
    maxVisibleAttachmentBytes > 0 && stats.visibleImageBytes > maxVisibleAttachmentBytes;
  const countTriggered =
    maxVisibleImages > 0 && stats.visibleImageCount >= maxVisibleImages;
  const oversizedTriggered =
    stats.visibleImageCount >= OVERSIZED_IMAGE_MIN_COUNT && stats.oversizedEdgeImageCount > 0;

  if (!force && !byteTriggered && !countTriggered && !oversizedTriggered) {
    return null;
  }

  let keep = Math.min(keepHotImages, stats.entries.length);
  if (byteTriggered && maxVisibleAttachmentBytes > 0) {
    const lowByteWatermark = Math.floor(maxVisibleAttachmentBytes * 0.5);
    const minKeep = force && stats.entries.length <= 1 ? 0 : 1;
    let keptBytes = 0;
    for (let i = stats.entries.length - keep; i < stats.entries.length; i += 1) {
      keptBytes += stats.entries[i].bytes;
    }
    while (keep > minKeep && keptBytes > lowByteWatermark) {
      const oldestKept = stats.entries[stats.entries.length - keep];
      keptBytes -= oldestKept.bytes;
      keep -= 1;
    }
    if (!force && keep === stats.entries.length && stats.entries.length === 1 && byteTriggered) {
      // Single oversized image > maxVisibleAttachmentBytes cannot shrink further if kept.
      keep = 0;
    }
  } else if (force && keep >= stats.entries.length) {
    keep = Math.max(0, stats.entries.length - 1);
  }

  const evictCount = stats.entries.length - keep;
  if (evictCount <= 0) return null;

  const evictEntries = stats.entries.slice(0, evictCount);
  const bySeq = new Map();
  for (const item of evictEntries) {
    let list = bySeq.get(item.seq);
    if (!list) {
      list = [];
      bySeq.set(item.seq, list);
    }
    list.push(item.imageIndex);
  }
  const targets = [...bySeq.entries()].map(([seq, imageIndexes]) => ({
    seq,
    imageIndexes,
  }));

  const reason = byteTriggered
    ? 'visible_bytes'
    : oversizedTriggered
      ? 'oversized_edge_count'
      : countTriggered
        ? 'visible_count'
        : 'forced_rescue';

  return {
    reason,
    stats,
    targets,
    offloadCount: evictCount,
    remainingCount: keep,
  };
}

/**
 * Select the oldest `count` un-offloaded image occurrences in `seqs` order
 * across `user/message` and `tool/result` nodes (mirroring DSH's
 * `@deepseek-ai/dsh-compaction-image-offload` selection semantics).
 *
 * @param {object} session
 * @param {readonly number[]} seqs
 * @param {number} count
 * @returns {Array<{ seq: number, imageIndexes: number[] }>}
 */
export function selectOldestImageTargets(session, seqs, count) {
  if (!session || !Array.isArray(seqs) || !Number.isSafeInteger(count) || count <= 0) {
    return [];
  }
  const targets = [];
  let remaining = count;
  for (const seq of seqs) {
    if (remaining <= 0) break;
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
    if (!event || (event.type !== 'user/message' && event.type !== 'tool/result')) continue;
    const message =
      typeof session.deriveEventMessage === 'function'
        ? session.deriveEventMessage(event)
        : event.type === 'user/message'
          ? event.data
          : event.data?.message;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    const imageIndexes = [];
    let imageIndex = 0;
    for (const block of content) {
      if (remaining <= 0) break;
      if (block && typeof block === 'object' && block.type === 'image') {
        if (block.offloaded !== true) {
          imageIndexes.push(imageIndex);
          remaining -= 1;
        }
        imageIndex += 1;
      }
    }
    if (imageIndexes.length > 0) {
      targets.push({ seq, imageIndexes });
    }
  }
  return targets;
}

/**
 * Execute a batch image offload plan.
 * - Prefers single-batch native `session.append('image/offload', { targets })`
 *   covering both `user/message` and `tool/result` without duplicating archives.
 * - If the host lacks `imageOffloadProjection` (atomic `validateNext` throws),
 *   fails open for `user/message` (NEVER uses `surfaceOp: replace` on `user/message`)
 *   and safely archives + replaces older non-pinned `tool/result` images when
 *   `openTurn !== null && archiveEnabled`.
 *
 * @param {{ session: object, plan: object, archive?: object, policy?: object, log?: Function, flushSession?: Function, signal?: AbortSignal }} [args]
 */
export async function commitVisibleImageOffload({
  session,
  plan,
  archive,
  policy,
  log,
  flushSession,
  signal,
} = {}) {
  if (!session || !plan || !Array.isArray(plan.targets) || plan.targets.length === 0) {
    return null;
  }
  if (typeof session.append !== 'function' || typeof session.eventAt !== 'function') {
    return null;
  }
  signal?.throwIfAborted?.();

  // Primary channel: native durable `image/offload` batch projection event.
  let appended = false;
  try {
    session.append('image/offload', { targets: plan.targets });
    appended = true;
    if (typeof flushSession === 'function') {
      await flushSession(session);
    }
    return {
      mode: 'image-offload',
      offloadCount: plan.offloadCount,
      remainingCount: plan.remainingCount,
      targets: plan.targets,
      reason: plan.reason,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (appended) {
      const detail = error instanceof Error ? error.message : String(error);
      const flushErr = new Error(`image/offload flush failed: ${detail}`);
      flushErr.code = error?.code === 'persistence' ? 'persistence' : 'commit';
      flushErr.compactionStage = 'commit';
      flushErr.surfaceMutated = true;
      flushErr.cause = error;
      try {
        log?.('warn', `image/offload flush failed: ${detail}`);
      } catch {
        /* ignore logger errors */
      }
      throw flushErr;
    }
    try {
      const detail = error instanceof Error ? error.message : String(error);
      log?.('warn', `native image/offload unavailable (${detail}); falling back safely`);
    } catch {
      /* ignore logger errors */
    }
  }

  // Fallback when host lacks `imageOffloadProjection`:
  // Hard redlines:
  // 1) NEVER apply `surfaceOp: replace` on `user/message` (fail-open for user/message);
  // 2) Only replace `tool/result` inside an open turn with archive enabled via commitObservationMask.
  if (policy?.archiveEnabled === false || !archive) {
    return null;
  }

  const maskTargets = [];
  let batchRefs = 0;
  let offloadedToolImages = 0;
  const fallbackTargets = [];

  for (const target of plan.targets) {
    const event = session.eventAt(target.seq);
    // Strict redline: NEVER surfaceOp-replace `user/message`.
    if (!event || event.type !== 'tool/result') continue;
    const message = event.data?.message;
    if (!message || message.isError === true || !Array.isArray(message.content)) continue;

    const stats = inspectMaskSourceStats(session, target.seq, MAX_MASK_STAGE_REFS);
    if (!Number.isFinite(stats.refs) || !Number.isFinite(stats.depth) || stats.depth >= MAX_MASK_SOURCE_DEPTH) {
      continue;
    }
    const targetRefs = stats.refs + 1;
    if (batchRefs + targetRefs > MAX_MASK_STAGE_REFS) break;

    const indexSet = new Set(target.imageIndexes);
    let imageIndex = 0;
    let changed = false;
    let replacedInEvent = 0;
    const nextContent = message.content.map((block) => {
      if (!block || typeof block !== 'object' || block.type !== 'image') return block;
      const currentIdx = imageIndex;
      imageIndex += 1;
      if (!indexSet.has(currentIdx) || block.offloaded === true) return block;
      changed = true;
      replacedInEvent += 1;
      return { type: 'text', text: formatStrippedImagePlaceholder(block, target.seq) };
    });
    if (!changed) continue;

    maskTargets.push({ seq: target.seq, nextContent, savedTokens: replacedInEvent * 256 });
    fallbackTargets.push({ seq: target.seq, imageIndexes: target.imageIndexes });
    batchRefs += targetRefs;
    offloadedToolImages += replacedInEvent;
  }

  if (maskTargets.length === 0) return null;

  const maskCompactionId =
    `weave-img-offload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const committed = await commitObservationMask({
      session,
      plan: {
        compactionId: maskCompactionId,
        targets: maskTargets,
        totalTokensSaved: offloadedToolImages * 256,
        batchRefs,
        hasMore: false,
      },
      archive,
      log,
      flushSession,
      signal,
    });
    if (!committed) return null;
    return {
      mode: 'tool-result-image-stub',
      offloadCount: offloadedToolImages,
      remainingCount: Math.max(0, plan.stats.visibleImageCount - offloadedToolImages),
      targets: fallbackTargets,
      compactionId: committed.compactionId,
      reason: plan.reason,
    };
  } catch (error) {
    if (error?.surfaceMutated === true || signal?.aborted) throw error;
    try {
      const detail = error instanceof Error ? error.message : String(error);
      log?.('warn', `tool/result fallback image archive failed before mutation; failing open: ${detail}`);
    } catch {
      /* ignore logger errors */
    }
    return null;
  }
}
