# Architecture

[简体中文](../architecture.md) · [English](architecture.md)

For the user-facing explanation, worked examples, static diagrams, and guarantee boundaries, read [Compaction principles](principles.md). This page provides code navigation.

## From history to the next step

Weave runs during DSH session maintenance:

1. Measure the visible messages and, when archives, history lookup tools, and `observationMaskingEnabled` are enabled (with no pending continuation), first fold older large non-error tool outputs outside the hot tail into archived head/tail previews (`observation-mask.js`); re-measure afterwards and skip calling a summary model if both the threshold and reduction target are met.
2. Otherwise, select tool-balanced history spans and enable verbatim `preservePrefixCache` prefix reuse when summarizing on the same model route within budget so provider KV Cache stays warm.
3. Extract active requirements, recent verbatim messages, XML provenance boundaries (`source-provenance.js` / `instruction-source.js` / `reference-input.js`: verified user messages vs `<untrusted_reference>` / `<channel-provenance>`), and the latest work report from original sources.
4. Request a candidate summary. Large histories may use chunks; eligible capacity failures can enter backend paged continuation.
5. Validate structure, requirements, progress, and size with finite retries. Archive selected originals and attachments and attach `History archive: <compactionId>` pointers and touched files to standard checkpoints.
6. Verify transaction preconditions, back up via single-pass copy-and-hash, durably write the replacement, persist the success decision, then publish the checkpoint.

Ordinary chunks commit individually, so earlier chunks may remain committed when a later one fails. Continuation saves accepted pages for recovery but replaces main history only after the complete candidate passes.

## Prefix preservation

`cache-policy.js` first considers history after the latest checkpoint. Existing checkpoints and the retained prefix keep their content while new notes are added after them.

Selection accounts for recent conversation, output capacity, quotes, the latest work report, and required savings. Consolidation is used when idle-resume compaction disables prefix preservation, the checkpoint limit is reached, a revision affects requirements carried by an older checkpoint, or incremental compaction cannot free enough space.

Actual cache reuse is measured from service usage reports. [Testing](testing.md) records recovery across subsequent replies.

## Requirements and source identity

`memory-policy.js` tracks active requirements, revisions (including narrow explicit revision prefixes and right-hand cancellation clauses while preserving conditional scopes), cancellations, and duplication. Recent quotes have a separate message and token budget.

`lib/audit/` splits the deterministic auditor into a 6-layer acyclic module stack (`normalize.js` → `numeric.js` → `clauses.js` → `polarity.js` / `provenance.js` → `compaction.js`, re-exported via `audit.js`), covering normalization, exact unit conversions, inline ordinal/clause splitting, CLI-flag/boolean/enable-disable polarity symmetry, approval provenance, and `auditCoverageScope`-aware coverage checks.

> **Bounded defense contract**: Regex/pattern-based credential redaction (`lib/redact.js`), workspace sensitive-path denylisting (`lib/file-reinject.js`), and deterministic heuristic NLP constraint/provenance auditing (`lib/audit/*`) are **bounded defenses** targeting common real-world credential formats, native DSH formatting boundaries, and high-frequency constraint phrasing—they do not promise exhaustive coverage of arbitrary non-standard encodings or open-world natural-language paraphrases.

Original event sequence numbers, text fragments, and hashes identify sources. Generated checkpoint prose does not become a new original instruction. Later compactions continue restoring requirements from verified original events.

Standalone “continue” messages may leave the checkpoint. Relative cancellations still use the original user-message sequence to preserve their intended target.

## Progress and reports

`work-report.js` records the latest work report's source. Short reports may be carried verbatim; longer reports retain source references for summarization and lookup.

`progress-facts.js` tracks explicit `key: value` structured progress assertions and `nextAction` with SHA-256 source provenance instead of domain-specific noun dictionaries.

## Paging and retries

A complete summary request includes source messages, instructions, `<channel-provenance>` channel isolation metadata, quote indexes, and work-report context. `summary-budget.js` plans for the whole request; `continuation.js` produces working notes in pages when needed.

Accepted pages persist their source identity and progress. Later attempts reuse matching completed pages and resume unfinished work. Request allowance, actual dispatch, and unknown usage are tracked separately.

`summary-retry.js` handles timeouts, stream interruption, empty output, malformed summaries, and validation failures. Regular and continuation requests use `singleTarget: true`, requesting only the selected first summary target. Cancellation stops the current operation. `summary-timeout.js` checks deadlines during dispatch and reading.

## Archives and transactions

Archives scrub credentials prior to write, pre-check the `32 MiB` uncompressed byte ceiling, preserve original events, message blocks, tool relationships, and SHA-256-checked attachments, and store data with native Node.js 24 lossless `zstd` compression by default. `history-search.js` provides zero-dependency BM25F multi-field search (CJK bigrams + English stemming, submodular Top-K diversification, 2-hop tool-call linking, and per-span LRU caching, seamlessly switching above `8 MiB` to corpus-stats-aware bounded candidate streaming so global latest-update anchors and cross-span 2-hop links still hold), while `tools.js` handles strict tool-calling schemas (normalizing `null`/blank optional arguments cleanly) and SHA-256 attachment inspection.

The transaction adapter checks both raw and comment/whitespace-normalized fingerprints of the reviewed DSH `0.2.2-rc.1`, `0.2.2-rc.2`, and `0.2.2-rc.3` host methods (including single-event and batch `Session.append` implementations). Under default `strictHostFingerprints: false`, if no unrecovered `.rollback`/`.tail` atomic journal remains and a minor host update alters private persistence internals, Weave emits a one-time notice and gracefully falls back to public `Session.append(..., { surfaceOp: { op: 'replace' } })` + `sessions.flush()` while keeping pre-replace archiving intact; only unrecovered atomic journals or `strictHostFingerprints: true` hard-refuse unrecognized method bodies before summarization or history mutation while retaining existing recovery materials. On native atomic commits, it backs up the original state via single-pass hashed `copySynced`, durably writes the replacement, persists a success decision, then publishes. A failure before that decision can restore a verified backup. A publication failure after durable success quarantines the writer and requires a cold reopen, preserving the successfully committed history. `state.js` and `session-memory.js` bind file locks to `threadId`, `(dev, ino)` file identity, and serialized `.reclaim` gates.

## Entry points

`cordis.patch.yml` registers the configuration gate and orders four agent presets after it. The gate replaces the preset's basic compaction engine with Weave and merges existing configuration with saved settings.

`index.js` bridges the host RPC endpoint (with `webserver/index-inject` process-level `x-weave-rpc-token`, `timingSafeEqual`, same-origin validation, and non-owner `403` enforcement) and `hookBus`; `client.js` (single-file browser bundle with zero imports and zero `setInterval`) renders the declarative Settings page (`settings-schema.js` SSOT, plus the `engineActive` takeover banner rendered on both the Settings page and the conversation composer Dock) and the composer-dock live progress card plus `ReactDOM.createPortal` migration/takeover confirmation modals.

The `lib/` runtime comprises `92` modules (`91` non-client ESM modules enforced at **0 cycles** by `scripts/check.mjs`):

| Module | Responsibility |
| --- | --- |
| `index.js`, `engine-entry.js`, `hooks.js` | Host loading, RPC auth/origin guard, `hookBus`, and configuration |
| `engine.js`, `lib/engine/*.js` (8 modules), `idle-compaction.js` | Selection, routing budgets, resumable recovery, parallel fold, migration, and commit |
| `observation-mask.js`, `tool-preview.js` | Stage-1 tool-output archive folding and Tier-4 salient prose / skeleton previews |
| `cache-policy.js`, `region.js`, `date-grounding.js` | Prefix reuse, balanced ranges, deterministic date grounding, and archive pointers |
| `source-provenance.js`, `instruction-source.js`, `reference-input.js` | Channel provenance and `<untrusted_reference>` / `<channel-provenance>` XML boundaries |
| `memory-policy.js`, `audit.js`, `lib/audit/*.js` (6 layered modules) | Requirement lifecycle, acyclic deterministic auditor, and provenance checks |
| `redact.js`, `file-reinject.js` | Linear PEM/credential redaction and bounded redacted workspace file re-injection |
| `progress-facts.js`, `work-report.js` | Structured `key: value` progress and reports |
| `summary-*.js`, `continuation*.js` | Requests, budgets, paging, retries, and recovery |
| `history.js`, `history-search.js`, `attachments.js`, `tools.js` | Lossless `zstd` archives, BM25F search, and `history_*` tool execution |
| `persisted-output.js`, `microcompact.js`, `snip.js`, `context-collapse.js` | Tail persistence, 0-LLM microcompact, Snip emergency rescue, and collapse |
| `transaction*.js`, `journal.js`, `state.js`, `session-backup.js`, `bili-conflict.js` | Transactions, worker-safe locks, full backups, and `billion-context` migration |
| `failure-diagnostics.js`, `audit-reject.js`, `audit-fallback.js` | Redacted diagnostics, rejection snapshots, and controlled fallback |
| `settings-schema.js`, `summary-config.js`, `client.js` | Settings SSOT, hot storage, and localized UI |
| `test/` | Offline regression suites (`104`) and DSH host integration suites (`8`) |
