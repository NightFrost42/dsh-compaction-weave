# Architecture

[简体中文](../architecture.md) · [English](architecture.md)

For the user-facing explanation, worked examples, static diagrams, and guarantee boundaries, read [Compaction principles](principles.md). This page provides code navigation.

## From history to the next step

Weave runs during DSH session maintenance:

1. Measure the visible messages and select a history range with balanced tool calls and results.
2. Prefer a range that preserves existing checkpoints and stable prefixes while meeting the space-saving target.
3. Recover active requirements, recent verbatim messages, and the latest work report from original sources.
4. Request a candidate summary. Large histories may use chunks; eligible capacity failures can enter backend paged continuation.
5. Validate the complete candidate's structure, requirements, progress, and size with finite retries. Archive the selected originals and attachments after acceptance.
6. Verify transaction conditions, back up and durably write the replacement, persist the success decision, then publish the checkpoint.

Ordinary chunks commit individually, so earlier chunks may remain committed when a later one fails. Continuation saves accepted pages for recovery but replaces main history only after the complete candidate passes.

## Prefix preservation

`cache-policy.js` first considers history after the latest checkpoint. Existing checkpoints and the retained prefix keep their content while new notes are added after them.

Selection accounts for recent conversation, output capacity, quotes, the latest work report, and required savings. Consolidation is used when the checkpoint limit is reached, a revision affects requirements carried by an older checkpoint, or incremental compaction cannot free enough space.

Actual cache reuse is measured from service usage reports. [Testing](testing.md) records recovery across subsequent replies.

## Requirements and source identity

`memory-policy.js` tracks active requirements, revisions, cancellations, and duplication. Recent quotes have a separate message and token budget.

`audit.js` checks coverage, values, negation, conditions, and scope. Production and test environments, files, and batches are treated separately.

Original event sequence numbers, text fragments, and hashes identify sources. Generated checkpoint prose does not become a new original instruction. Later compactions continue restoring requirements from verified original events.

Standalone “continue” messages may leave the checkpoint. Relative cancellations still use the original user-message sequence to preserve their intended target.

## Progress and reports

`work-report.js` records the latest work report's source. Short reports may be carried verbatim; longer reports retain source references for summarization and lookup.

`progress-facts.js` tracks source-backed counts, completion states, artifact paths, and next actions. Candidate validation distinguishes current assertions, historical attribution, negated claims, and plans.

The semantic fixes in `0.3.2-rc.1` affect candidate interpretation. Original progress-fact extraction, hashes, IDs, and persisted source references retain their existing format.

## Paging and retries

A complete summary request includes source messages, instructions, quote indexes, and work-report context. `summary-budget.js` plans for the whole request; `continuation.js` produces working notes in pages when needed.

Accepted pages persist their source identity and progress. Later attempts reuse matching completed pages and resume unfinished work. Request allowance, actual dispatch, and unknown usage are tracked separately.

`summary-retry.js` handles timeouts, stream interruption, empty output, malformed summaries, and validation failures. Regular and continuation requests use `singleTarget: true`, requesting only the selected first summary target. Cancellation stops the current operation. `summary-timeout.js` checks deadlines during dispatch and reading.

## Archives and transactions

Archives preserve original events, message blocks, tool relationships, and SHA-256-checked attachments. History tools read these records in pages.

The transaction adapter checks fingerprints of the reviewed DSH `0.2.2-rc.1`, `0.2.2-rc.2`, and `0.2.2-rc.3` host methods (including single-event and batch `Session.append` implementations). Unrecognized host method implementations are refused before any summary request or transactional history mutation while retaining existing recovery materials. It backs up the original state, durably writes the replacement, persists a success decision, then publishes. A failure before that decision can restore a verified backup. A publication failure after durable success quarantines the writer and requires a cold reopen, preserving the successfully committed history.

## Entry points

`cordis.patch.yml` registers the configuration gate and orders four agent presets after it. The gate replaces the preset's basic compaction engine with Weave and merges existing configuration with saved settings.

| Module | Responsibility |
| --- | --- |
| `index.js`, `engine-entry.js` | Host loading and configuration |
| `engine.js` | Selection, generation, validation, and commit |
| `cache-policy.js`, `region.js` | Prefix preservation and balanced ranges |
| `memory-policy.js`, `audit.js` | Requirement lifecycle and validation |
| `progress-facts.js`, `work-report.js` | Source-backed progress and reports |
| `summary-*.js`, `continuation*.js` | Requests, budgets, paging, retries, and recovery |
| `history.js`, `attachments.js`, `tools.js` | Archives and retrieval |
| `transaction*.js`, `journal.js`, `state.js` | Transactions and persisted state |
| `failure-diagnostics.js`, `audit-reject.js` | Failure reports and rejected-summary evidence |
| `client.js`, `summary-config.js` | Localized settings and configuration storage |
