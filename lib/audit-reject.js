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

const DIR_NAME = 'audit-reject';
const MAX_FILES = 40;

/**
 * Redact obvious credentials before writing anything to disk.
 * This is a coarse screen, not a proof: it matches the shapes the project already screens for.
 */
function redact(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, '[redacted-key]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{16,}/g, '$1[redacted-token]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[redacted-token]')
    .replace(/\b([A-Za-z0-9+/]{40,}={0,2})\b/g, (m) => (m.length > 60 ? '[redacted-blob]' : m));
}

async function prune(dir) {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
    if (names.length <= MAX_FILES) return;
    const withTime = [];
    for (const name of names) {
      try {
        const info = await stat(join(dir, name));
        withTime.push([name, info.mtimeMs]);
      } catch {
        /* ignore */
      }
    }
    withTime.sort((a, b) => a[1] - b[1]);
    for (const [name] of withTime.slice(0, withTime.length - MAX_FILES)) {
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
      storageRoot, sessionId, compactionId, target, code, message,
      modelRawText, auditedText, checkpointBlocks, report, userMessages,
    } = args ?? {};
    if (!storageRoot || !sessionId || !compactionId) return null;

    const dir = join(storageRoot, DIR_NAME);
    await mkdir(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const shortId = String(sessionId).slice(0, 22).replace(/[^A-Za-z0-9_-]/g, '_');
    const file = join(dir, `${shortId}__${stamp}__${String(compactionId).replace(/[^A-Za-z0-9_-]/g, '_')}__${randomUUID()}.json`);

    const payload = {
      kind: 'compaction-weave/audit-reject',
      version: 1,
      at: new Date().toISOString(),
      sessionId,
      compactionId,
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

    await writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    await prune(dir);
    noteAuditDiagnostic(file);
    return file;
  } catch {
    // A diagnostic must never be the reason a compaction fails.
    noteAuditDiagnostic(null);
    return null;
  }
}
