import {noteAuditDiagnostic} from './failure-diagnostics.js';
// Audit-rejection dumps.
//
// WHY THIS EXISTS
//   The engine logs the first failing sentence to the host logger, which goes to stderr
//   and is not persisted anywhere we can read afterwards. That left us unable to answer
//   the only question that matters when compaction is refused: was the summary actually
//   wrong, or did the auditor misjudge it?
//
// WHAT IT DOES
//   When a summarisation target is rejected by content validation, write the complete
//   evidence for that rejection to <storageRoot>/audit-reject/ :
//     - the model's raw text (before section 6 is materialised)
//     - the text that was actually audited (after materialisation)
//     - the full checkpoint blocks
//     - the auditor's report (every lost item, with source sentence and candidate)
//     - the source user messages the auditor compared against
//     - the target provider/model and the reject code
//
// WHAT IT MUST NOT DO
//   - It must never change the verdict, throw, or delay a compaction.
//   - It must never write into the session log or the archive.
//   - It must be bounded: one file per rejection, and the directory is capped.
//
// Every failure inside this module is swallowed: a diagnostic must never be the reason a
// compaction fails.

import { mkdir, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {isReferenceContextKind} from './source-provenance.js';
import { redactCredentials } from './redact.js';

const DIR_NAME = 'audit-reject';
export const MAX_FILES = 40;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

function truncateFieldText(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) return text;
  let keep = Math.max(0, Math.floor(maxChars));
  if (keep > 0 && /[\uD800-\uDBFF]/.test(text[keep - 1])) keep -= 1;
  const omitted = text.length - keep;
  return `${text.slice(0, keep)}...[truncated ${omitted} chars]`;
}

function fitPayloadToFileBudget(payload, maxFileBytes) {
  const serialize = (obj) => `${JSON.stringify(obj, null, 2)}\n`;
  let out = serialize(payload);
  if (Buffer.byteLength(out, 'utf8') <= maxFileBytes) return out;

  const origUserMessages = Array.isArray(payload.userMessages)
    ? payload.userMessages.map((m) => ({ ...m }))
    : null;
  const origCheckpointBlocks = Array.isArray(payload.checkpointBlocks)
    ? payload.checkpointBlocks.map((b) => ({ ...b }))
    : null;
  const origAuditedText = payload.auditedText;
  const origModelRawText = payload.modelRawText;

  const caps = [];
  for (let cap = Math.max(256, Math.min(65536, maxFileBytes)); cap >= 32; cap = Math.floor(cap / 2)) {
    caps.push(cap);
  }
  caps.push(0);

  for (const cap of caps) {
    if (origUserMessages) {
      payload.userMessages = origUserMessages.map((m) =>
        typeof m.text === 'string' ? { ...m, text: truncateFieldText(m.text, cap) } : { ...m },
      );
      out = serialize(payload);
      if (Buffer.byteLength(out, 'utf8') <= maxFileBytes) return out;
      if (cap <= 512 && origUserMessages.length > 1) {
        const keepCount = cap === 0 ? 0 : Math.min(origUserMessages.length, Math.max(1, Math.floor(cap / 64)));
        const omittedCount = origUserMessages.length - keepCount;
        const tail = keepCount > 0 ? payload.userMessages.slice(-keepCount) : [];
        payload.userMessages = [
          { seq: null, text: `...[truncated ${omittedCount} userMessages]` },
          ...tail,
        ];
        out = serialize(payload);
        if (Buffer.byteLength(out, 'utf8') <= maxFileBytes) return out;
      }
    }

    if (origCheckpointBlocks) {
      payload.checkpointBlocks = origCheckpointBlocks.map((b) =>
        typeof b.text === 'string' ? { ...b, text: truncateFieldText(b.text, cap) } : { ...b },
      );
      out = serialize(payload);
      if (Buffer.byteLength(out, 'utf8') <= maxFileBytes) return out;
      if (cap <= 512 && origCheckpointBlocks.length > 1) {
        const keepCount = cap === 0 ? 0 : Math.min(origCheckpointBlocks.length, Math.max(1, Math.floor(cap / 64)));
        const omittedCount = origCheckpointBlocks.length - keepCount;
        const tail = keepCount > 0 ? payload.checkpointBlocks.slice(-keepCount) : [];
        payload.checkpointBlocks = [
          { type: 'text', text: `...[truncated ${omittedCount} checkpointBlocks]` },
          ...tail,
        ];
        out = serialize(payload);
        if (Buffer.byteLength(out, 'utf8') <= maxFileBytes) return out;
      }
    }

    if (typeof origAuditedText === 'string') {
      payload.auditedText = truncateFieldText(origAuditedText, cap);
      out = serialize(payload);
      if (Buffer.byteLength(out, 'utf8') <= maxFileBytes) return out;
    }

    if (typeof origModelRawText === 'string') {
      payload.modelRawText = truncateFieldText(origModelRawText, cap);
      out = serialize(payload);
      if (Buffer.byteLength(out, 'utf8') <= maxFileBytes) return out;
    }
  }

  return out;
}

/**
 * Redact obvious credentials before writing anything to disk.
 * This is a coarse screen, not a proof: it matches the shapes the project already screens for.
 */
function redact(text) {
  return redactCredentials(text, {
    pemReplacement: '[redacted-private-key]',
    keyReplacement: '[redacted-key]',
    tokenReplacement: '[redacted-token]',
    bearerReplacement: '$1[redacted-token]',
    redactBase64Blobs: true,
    minKeyLen: 16,
  });
}

async function prune(dir, { maxFiles = MAX_FILES, maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
    const entries = [];
    let totalBytes = 0;
    for (const name of names) {
      try {
        const info = await stat(join(dir, name));
        const size = Number.isFinite(info.size) ? info.size : 0;
        entries.push([name, info.mtimeMs, size]);
        totalBytes += size;
      } catch {
        /* ignore */
      }
    }
    entries.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    let start = 0;
    while (
      entries.length - start > maxFiles ||
      (entries.length - start > 1 && totalBytes > maxTotalBytes)
    ) {
      const [name, , size] = entries[start];
      start += 1;
      totalBytes -= size;
      try {
        await rm(join(dir, name), { force: true });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Record one rejected summarisation attempt.
 *
 * @param {object} args
 * @param {string} args.storageRoot   absolute path; the dumps go into <storageRoot>/audit-reject
 * @param {string} args.sessionId
 * @param {string} args.compactionId
 * @param {string} [args.target]      "provider/model"
 * @param {string} [args.code]        reject code from the validator
 * @param {string} [args.message]     reject message from the validator
 * @param {string} [args.modelRawText]      what the model wrote (pre-materialisation)
 * @param {string} [args.auditedText]       what the auditor actually read (post-materialisation)
 * @param {object[]} [args.checkpointBlocks]
 * @param {object} [args.report]      result of auditCompaction()
 * @param {object[]} [args.userMessages]
 * @returns {Promise<string|null>} the written path, or null when nothing was written
 */
export async function dumpAuditRejection(args) {
  try {
    const {
      storageRoot, sessionId, compactionId, target, trigger, code, message,
      modelRawText, auditedText, checkpointBlocks, report, userMessages,
    } = args ?? {};
    if (!storageRoot || !sessionId || !compactionId) return null;

    const dir = join(storageRoot, DIR_NAME);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const shortId = String(sessionId).slice(0, 22).replace(/[^A-Za-z0-9_-]/g, '_');
    const file = join(dir, `${shortId}__${stamp}__${String(compactionId).replace(/[^A-Za-z0-9_-]/g, '_')}__${randomUUID()}.json`);
    const safeTrigger = typeof trigger === 'string' && trigger.trim().length > 0 ? trigger.trim().slice(0, 64) : null;

    const payload = {
      kind: 'compaction-weave/audit-reject',
      version: 1,
      at: new Date().toISOString(),
      sessionId,
      compactionId,
      trigger: safeTrigger,
      target: target ?? null,
      attempt: args.attempt ?? null,
      reject: { code: code ?? null, message: message ?? null },
      // The model's own words. If the auditor is at fault, the culprit is in here.
      modelRawText: redact(modelRawText ?? null),
      // What the auditor was handed. Section 6 is materialised between these two.
      auditedText: redact(auditedText ?? null),
      audit: report
        ? {
            kind: report.kind ?? 'requirements',
            checked: report.checked,
            polarityFlips: report.polarityFlips,
            worstCoverage: report.worstCoverage,
            lostCount: Array.isArray(report.lost) ? report.lost.length : null,
            // Keep every lost item: source sentence, candidate sentence and reason.
            lost: Array.isArray(report.lost)
              ? report.lost.map((item) => ({
                  seq: item.seq,
                  reason: item.reason,
                  ...(item.key ? {key:item.key,scope:item.scope} : {}),
                  coverage: item.coverage,
                  line: redact(item.line),
                  candidate: redact(item.candidate ?? null),
                  ...(Array.isArray(item.conflicts) ? {conflicts:item.conflicts.map(c=>({reason:c.reason,candidate:redact(c.candidate)}))} : {}),
                }))
              : null,
          }
        : null,
      checkpointBlocks: Array.isArray(checkpointBlocks)
        ? checkpointBlocks.map((block) => ({
            type: block?.type ?? null,
            ...(typeof block?.text === 'string' ? { text: redact(block.text) } : {}),
          }))
        : null,
      userMessages: Array.isArray(userMessages)
        ? userMessages.map((m) => ({ seq: m?.seq ?? null, text: redact(m?.text ?? ''), ...(isReferenceContextKind(m?.sourceKind) ? {sourceKind:m.sourceKind} : {}) }))
        : null,
    };

    const maxFiles =
      Number.isFinite(args?.maxFiles) && args.maxFiles >= 1 ? Math.floor(args.maxFiles) : MAX_FILES;
    const maxFileBytes =
      Number.isFinite(args?.maxFileBytes) && args.maxFileBytes > 0
        ? Math.floor(args.maxFileBytes)
        : MAX_FILE_BYTES;
    const maxTotalBytes =
      Number.isFinite(args?.maxTotalBytes) && args.maxTotalBytes > 0
        ? Math.floor(args.maxTotalBytes)
        : MAX_TOTAL_BYTES;

    const jsonText = fitPayloadToFileBudget(payload, maxFileBytes);
    await writeFile(file, jsonText, { encoding: 'utf8', mode: 0o600 });
    await prune(dir, { maxFiles, maxTotalBytes });
    noteAuditDiagnostic(file);
    return file;
  } catch {
    // A diagnostic must never be the reason a compaction fails.
    noteAuditDiagnostic(null);
    return null;
  }
}
