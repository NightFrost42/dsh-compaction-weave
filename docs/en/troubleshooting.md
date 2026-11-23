# Troubleshooting

[简体中文](../troubleshooting.md) · [English](troubleshooting.md)

## When a summary fails

When a summary request times out or fails validation, Weave retries automatically according to your settings. By default, the initial request can be followed by up to 2 retries, and validation failure details are fed back to the summary model on subsequent attempts.

If all attempts are exhausted, the conversation displays the failure reason and the path to the diagnostic file. Uncommitted original context remains intact in the conversation, and any completed continuation pages are saved on disk for later resumption.

| Failure | Next step |
| --- | --- |
| Timeout or interrupted stream | Check the provider connection and adjust timeout or retry settings; already-committed chunks and a resumable checkpoint are preserved so the next message, **Resume**, or `/compact resume` continues from where it stopped |
| Paused, crashed, or unwanted resumable checkpoint | Click **Pause** in the progress card or run `/compact cancel` to stop cleanly without rolling back committed chunks; after a crash, Weave closes any orphan lock before reopening the session and marks progress resumable. Ordinary interruptions auto-resume before your next message or via **Resume** / `/compact resume`; `paused_budget` and `paused_failure` checkpoints wait for explicit **Resume** / `/compact` or **Discard** / `/compact discard` without blocking normal chat (full-session backups remain untouched) |
| Rate limits (HTTP 429), slow summaries, or `UNSUPPORTED_REASONING_EFFORT` | Defaults use `summaryConcurrency: 2` and `summaryReasoningEffort: 'low'`, automatically dropping concurrency to 1 with cooldown on HTTP 429; explicit thinking levels (`minimal` / `medium` / `high` / `xhigh` / `max`) also step down the ladder and omit the parameter automatically when unsupported. If a model still rejects it, set `none` or a supported level in **Settings → Compaction → Summary reasoning effort** |
| Incomplete structure or truncated output | Increase `maxTokens` or choose a model better suited to long structured summaries |
| Requirement, polarity, or provenance check failed (`CONSTRAINT_POLARITY_LOST` / `reason=provenance`) | Check the surfaced provenance kind (`untrusted-source` / `revoked` / `missing-source`), offending summary sentence, and the linked `audit-reject/` record via `auditReports`; setting `auditBlockOnLoss: false` does NOT bypass `CONSTRAINT_POLARITY_LOST` or `provenance` checks. If triggered by an external bridge or bare memory plugin block, add its `source.kind` to `extraReferenceSourceKinds` or its prefix to `extraReferencePrefixes` (common IM bridges and multi-line memory headers are built in); `auditProvenanceBlock: false` relaxes `missing-source` warnings only while keeping `untrusted-source` and `revoked` strictly blocked |
| Auto-compaction tripped circuit breaker (`COMPACTION_STOPPED`) | The composer dock shows the root error code, diagnostic ID, and large-context billing warning: use **Retry compaction** after adjusting model/settings (success clears `stopped`, failures, and bypass), or under `confirm` / `degrade` (`pressureBreakerAction`) use the 2-step confirmation to continue chatting within the hard request budget (you can click **Restore block** or **Copy diagnostics** anytime). `RECOVERY_REQUIRED`, pending continuations, and `total >= messageBudgetTokens` never bypass |
| Weave silently fails to mount alongside `dsh-world` | When `dsh-world` replaces compaction (`compactionSwapped` / `dsh-world/compaction`), `@deepseek-ai/dsh-compaction-basic` is swapped out so Weave does not mount. In preset mode, click **概览 → 会话预设 → 还原 DSH 预设** in the World Console; in non-preset mode, set `replaceCompaction: false` (`dsh-world` diary, `memory_find`, and memory injection stay intact). See [README coexistence guide](../../README.en.md#coexisting-with-dsh-world--bridge-channel-isolation) |
| Oversized input or tool group | Weave automatically runs batched Stage-1 observation masking on oversized sessions, uses the primary summary target's own context window, folds checkpoints hierarchically across rolling waves, and caps tool-source references per chunk/wave; if a single message or tool group still exceeds limits, adjust the summary model window or input budgets using the diagnostic estimates |
| Continuation call budget exhausted | Resolve the reported cause, then run `/compact` to grant a fresh call budget for remaining pages |
| Migrating from `billion-context` or encountering legacy fold blocks | When replacing the official compaction row, Weave automatically strips stale `disabled: true` left by prior gates/patches and warns if `auto: false` was inherited (remove `auto: false` from your profile patch or set `engine.auto: true` to re-enable auto-compaction). Existing `billion-context` / `billion-context-dsh` sessions can be converted via the conditional **Convert to Weave** button in the progress card or `/compact migrate`; Weave creates and SHA-256 verifies a raw-byte full-session backup beforehand. Use **Restore backup** or `/compact backups` / `/compact restore [backupId]` to roll back (open sessions lock writes and restore atomically when reopened or after reloading DSH) |
| Foreground modal or error about `billion-context` coexistence / local proxy `413` (`BILI_COEXISTENCE_CONFLICT` / `BILI_PROXY_CONFLICT` / `preflight_compress_failed`) | Open Plugin Manager and disable or uninstall `billion-context` (`billion-context-dsh`), restore any model provider `baseUrl` still pointing to bili's `127.0.0.1` / `localhost` loopback proxy back to the direct upstream endpoint, and **fully restart DSH** (even if toggled off in the UI, a full restart is required to clear in-memory hooks and local proxy listeners). Genuine direct upstream HTTP `413` / `model window` errors are routed cleanly through overflow compaction / effective Snip rescue |
| Recovery or write-quarantine notice | Keep the transaction journal and `.rollback` backup in storage, restart DSH, and inspect the recovery outcome |
| Host compatibility or private method check notice | Verify that your DSH version falls within `>=0.2.2-rc.1 <1.0.0-0` (native atomic commits are verified on `0.2.2-rc.1`, `0.2.2-rc.2`, and `0.2.2-rc.3`); with default `strictHostFingerprints: false`, minor host updates changing private persistence internals emit a one-time notice and fall back to public `Session.append(replace)` + `sessions.flush()` when no unrecovered `.rollback`/`.tail` atomic journal exists, whereas `strictHostFingerprints: true` or unrecovered atomic journals block compaction and retain recovery files |

## False rejections and phrasing boundaries

`PROGRESS_FACT_CONFLICT` indicates a contradiction between explicit `key: value` structured progress assertions in the candidate summary (`*Count`, `*Completed`, `*Generated`, `*Passed`, `*Failed`, `*Path`, `*State`, `*Status`, and `nextAction`) and the latest source claim in that same scope (for example turning a known count into `null`, or citing an old `seq` value as the current state). General diagnostic files record the error code, stage, attempt outcomes, effective settings, input estimates, and `auditReports` references without storing source sequence numbers, user excerpts, or candidate summary prose; to inspect those details, follow `auditReports` in the diagnostic file to the corresponding `audit-reject/` record and compare the source sequence numbers, source excerpts, and candidate phrasing to determine whether the summary omitted the latest state or mixed scopes.

`0.3.2` relies on host event channels and explicit XML boundaries to separate real user commands from external reference material (tool outputs and runtime context are treated purely as reference data; if you paste long third-party text inside your own user turn, wrapping it in `<quoted_text>...</quoted_text>` or fenced code blocks keeps it clearly separated), and audits constraints using CJK bigrams, word-boundary ASCII tokens, dual-side conditions, antonym polarity equivalence, and chronological approval provenance checks. Indirect Chinese negation such as `并非……` or `不是……而是已被取代` remains a known boundary. If a summary matches the latest source state but is still rejected, please open an Issue with a minimal excerpt, the error code, and model details. When an existing matched constraint fragment fails without a progress conflict or missing-coverage/provenance error, the engine also attempts local deterministic line repair before failing.

## Diagnostic files

By default, plugin data is stored under:

```text
<DSH_HOME>/storages/dsh-compaction-weave/
```

- `diagnostics/`: uses an allowlist of metadata fields to record the failure stage, error code, per-attempt outcomes, timing, returned usage, effective settings, input estimates, continuation progress, and linked `auditReports` references, without source sequence numbers, conversation excerpts, or candidate prose. Routing fields under `context` reflect configured session and summary routing rather than the final responder model name; `actualDshVersion` is recorded as `null` when the running host version is not reliably collected (you can note your actual version manually when troubleshooting or reporting issues), while `supportedDshVersion` records the declared host compatibility range string (`">=0.2.2-rc.1 <1.0.0-0"`).
- `audit-reject/`: stores candidate summaries rejected by requirement or progress checks along with the audited text, source sequence numbers, and source excerpts, referenced from `auditReports` in the diagnostic file.
- `sessions/`: stores archived original history events and attachments organized by session.
- `backups/`: stores SHA-256 verified raw-byte full-session backups created before compatibility conversion (preserving exact `.v4.jsonl.zstd` / `.v4.jsonl` encoding), armed `pending-restore.json` markers, and pre-restore safety copies without writing any foreign files into DSH's session directory.
- `summary-config.json`: stores summary model routing, retry, idle, and `auditBlockOnLoss` settings.

Start with the diagnostic file path shown in the conversation notice for that operation. Before sharing files publicly, note that `audit-reject/` records and session excerpts contain original user prompts and candidate prose, and should be reviewed and redacted first. Persisted directories and files under `sessions/`, `audit-reject/`, and `journal/` are created with `0700` / `0600` modes on POSIX (macOS/Linux); on Windows, permissions follow Node.js file permission semantics without external ACL tooling.

## Open an Issue

If you run into errors, degraded reply quality after compaction, or forgotten requirements or progress, please [open an Issue](https://github.com/NightFrost42/dsh-compaction-weave/issues/new/choose) using the English or Chinese template.

Diagnostic files and logs are optional. For errors, you can attach a reviewed copy of the diagnostic file linked in chat and note the actual DSH version you are running; for quality or memory issues, include the relevant requirement and minimal conversation excerpts before and after compaction. See [Reporting issues and redacting logs](feedback.md) for privacy guidance and redaction instructions.

## Update or uninstall

To update a local package in Desktop, uninstall the existing Weave package on the Plugins page, install the new package via “Add plugin,” and restart DSH. Archives and summary settings in the independent storage directory are preserved.

For a command-line profile, stop the profile before upgrading from npm or a local `.tgz` package, or removing it:

```bash
dsh plugin --profile web add dsh-compaction-weave
dsh plugin --profile web add /absolute/path/dsh-compaction-weave-0.5.1.tgz
dsh plugin --profile web remove dsh-compaction-weave
```

Start the profile again afterwards.
