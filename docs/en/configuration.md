# Configuration

[简体中文](../configuration.md) · [English](configuration.md)

## Summary settings

Open **Settings → Summary model**, or the summary settings in the plugin details.

| Setting | Field | Default | Range |
| --- | --- | --- | --- |
| Provider | `summarizationProvider` | Follow conversation | Configured providers |
| Model | `summarizationModel` | Follow conversation | Models offered by the provider |
| Output limit | `maxTokens` | 8192 | 1–1000000 |
| Trigger ratio | `thresholdRatio` | 0.8 | 0.5–0.95 |
| Compact before resuming | `idleCompactionMinutes` | 0 (off) | 0 disables it; presets or custom input from 1–43200 whole minutes, up to 30 days |
| Minimum reduction | `minimumReductionRatio` | 0.2 | 0.05–0.9 |
| Additional retries | `summaryRetryCount` | 2 | 0–4 |
| Base delay | `summaryRetryDelayMs` | 1000 | 0–30000 ms |
| Per-request timeout | `summaryTimeoutMs` | 180000 | 5000–3600000 ms |
| Summary concurrency | `summaryConcurrency` | 2 | 1–6 integer (parallel chunk generation with strictly ordered serial commit; drops to 1 on HTTP 429) |
| Summary reasoning effort | `summaryReasoningEffort` | `low` | `low` (default reduced effort) / `none` (omitted) / `minimal` / `medium` / `high` / `xhigh` / `max` / `inherit` (follow session); steps down automatically if unsupported |
| Block on requirement loss | `auditBlockOnLoss` | `true` (on) | On / Off |
| Post-compact workspace file re-injection | `postCompactReinjectEnabled` | `true` (on) | On (0 LLM tokens, fresh local read of up to 5 recent workspace files, 24KB cap) / Off |

The UI displays timing in seconds; configuration fields use milliseconds. A retry count of 2 allows up to 3 attempts for each unfinished summary or page. Consecutive retries use exponential backoff, capped at 30 seconds.

Select or clear the provider and model together. **Clear (follow session model)** clears the model override and its output limit while saving the page's current trigger ratio, minimum reduction, retry, concurrency, reasoning effort, idle, audit-blocking, and workspace file re-injection settings, including unsaved edits.

**Saving or clearing settings on this page needs no DSH restart.** The summary model, output limit, trigger ratio, minimum reduction, retry and idle settings (as well as concurrency, reasoning effort, `auditBlockOnLoss`, and `postCompactReinjectEnabled`) all hot-apply at subsequent compaction or request boundaries. A compaction already in progress keeps the configuration snapshot it started with until that operation finishes.

### Requirement audit, resumable progress, slash commands & live progress card

- **`auditBlockOnLoss` (on by default)**: Retries and blocks summaries or continuations that drop active user requirements. Weave automatically filters `<system-reminder>`, `AGENTS.md`, and first-party DSH V4 host reminders (while preserving real user prose in mixed messages) to prevent false rejections. If a long session still hits retention rejections, you can toggle this off live in Settings; Section 6 verbatim quotes, polarity-flip blocking, approval provenance checks, and progress-fact conflict checks remain strictly enforced.
- **One-shot focused compaction (`/compact <focus>`, `/compact -- <focus>`)**:
  - `/compact <focus>` (for example `/compact keep API schema and error line numbers`) passes a one-shot focus instruction (control chars stripped, whitespace collapsed, capped at 500 characters) to manual compaction so specified details are prioritized without dropping user constraints or inventing facts. Only the exact 6 built-in subcommands (`migrate`, `backups`, `restore [backupId]`, `resume`, `cancel`, `discard`) are reserved; any other non-empty text parses as a focus instruction. Prefix with `--` (`/compact -- resume notes`) to force focus parsing when your instruction begins with a reserved keyword. Plain `/compact` with no arguments delegates unchanged.
- **Live progress card & pause/resume checkpoints**: During automatic compaction, manual `/compact`, paged continuation, or compatibility conversion, a live progress card appears above the composer showing the current phase, progress bar, wave/chunk/page counters, concurrency/rate-limit indicator, attempt count, summary model, token delta, masked tool count, stream liveness, elapsed timer, and a **Pause** button; when idle (with no migration or paused checkpoint), it stays hidden. If a run is paused, timed out, errored, or interrupted by a crash, committed chunks stay intact and remaining progress is persisted as a resumable checkpoint: ordinary interruptions (`interrupted`) auto-resume before the next message or on **Resume** / `/compact resume`; budget-paused (`paused_budget`) and threshold-failed (`paused_failure`) checkpoints never auto-resume (avoiding silent charges or blocking chat) and wait for explicit **Resume**, `/compact` / `/compact resume`, or **Discard** / `/compact discard` (original full-session backups are never deleted). Slash subcommands: `/compact resume`, `/compact cancel`, `/compact discard`.
- **`billion-context` compatibility conversion & verified backups**: The **Convert to Weave** row appears ONLY when unmigrated `billion-context` / `billion-context-dsh` fold blocks or tool artifacts are actually detected in the current session (strictly absent on ordinary or already-converted sessions). Before any irreversible conversion mutates the session, Weave creates and SHA-256 verifies a raw-byte full-session backup under `<DSH_HOME>/storages/dsh-compaction-weave/backups/` (preserving exact `.v4.jsonl.zstd` / `.v4.jsonl` encoding with zero foreign files written into DSH's session directory), and protects the initial original baseline backup across repeated runs. Equivalent slash subcommands are available via `/compact migrate`, `/compact backups`, and `/compact restore [backupId]`.

First installation or plugin upgrades still require a host reload as prompted by DSH to load the new code. The no-restart behavior above applies to changes on the summary settings page.

Settings are stored in:

```text
<DSH_HOME>/storages/dsh-compaction-weave/summary-config.json
```

When `DSH_HOME` is unset, DSH uses `.dsh` in the user's home directory.

### Compact before resuming

Choose **5, 10, 30, 60, 720 or 1440 minutes**, or the longer **7 days (10080 minutes) / 30 days (43200 minutes)** presets. For **Custom**, enter **1–43200 whole minutes**. Here, **1 month is fixed at 30 days, or 43200 minutes**, regardless of calendar month length. The default is off; select **Off** to disable, which saves 0. Custom input starts at 1.

The Claude 5 / 60-minute references, GPT ordinary and extended-cache references, and Gemini 30-minute reference remain available. The 7-day and 30-day presets support longer idle policies; they do not imply that provider caches last that long.

When a new user message arrives, compare its queue time with the latest user, assistant or tool activity in the same conversation. If the gap **exceeds** the selected interval, compact existing history at the first step of the new turn before handling the new input. This setting is independent of the pressure-based `auto` switch, applies across conversations, and does not change automatically when switching models. Saved changes apply at subsequent request boundaries; they do not start an idle countdown or background compaction timer.

The clock comes from durable session events, including after reopening. Skip new conversations, missing or invalid timestamps, input added during active tool loops, and history that cannot shrink. Do not repeat a successful compaction without intervening conversation work. New input stays outside the selected history. Summary, audit or storage failures stop the main request and retain that input; cancellation retains it too. Existing archives, requirement checks, tool pairing, retry limits and circuit breakers still apply.

This is a manual client policy, not an observation of server cache expiry. It does not enable or change upstream cache settings. Request start, response completion and explicit cache expiry are different clocks; savings still depend on actual input, summary and cache-hit costs.

Official references checked on 2026-11-17:

| Provider | Documented retention | Setting guidance |
| --- | --- | --- |
| [OpenAI GPT](https://developers.openai.com/api/docs/guides/prompt-caching) | GPT-5.6 and later in Responses default to a 30-minute minimum lifetime, with 12 hours available. Older `in_memory` typically lasts 5–10 idle minutes, up to 1 hour; `24h` typically lasts around 30 minutes, up to 24 hours | Choose for the model, API and upstream configuration. Maximum retention is not guaranteed availability; the new minimum lifetime governs cache-read pricing eligibility |
| [Claude](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | Default minimum 5 minutes, optional 1 hour; refreshed on cache use, timed from request start | 5 or 60 minutes as a reference; response generation consumes lifetime too |
| [Gemini](https://ai.google.dev/gemini-api/docs/caching) | No fixed implicit-cache TTL published in the checked guide. Explicit caches default to 1 hour with configurable expiry | This plugin offers 30 minutes as a trigger reference, not an official implicit-cache TTL |
| [DeepSeek](https://api-docs.deepseek.com/guides/kv_cache/) | Usually cleared within hours to days after falling out of use; best-effort hits | No fixed expiration point; choose a custom interval |
| [GLM](https://docs.bigmodel.cn/cn/guide/capabilities/cache.md) | No numerical retention time in the checked official guide | Choose a custom interval without assuming a fixed TTL |

## Advanced configuration

Set advanced options under `compaction-weave-gate.config.engine` in your profile patch:

```yaml
- id: compaction-weave-gate
  config:
    engine:
      cachePreservePrefix: true
      cacheMaxCheckpoints: 4
      minimumReductionRatio: 0.2
      summaryRetryCount: 2
      summaryRetryDelayMs: 1000
      summaryTimeoutMs: 180000
```

Values saved by the summary settings page override the corresponding engine fields.

### Timing and cache preservation

| Field | Default | Meaning |
| --- | --- | --- |
| `auto` | `true` | Automatic compaction under context pressure |
| `idleCompactionMinutes` | `0` | Independent idle-resume threshold, 1–43200 whole minutes (up to 30 days); 0 disables it |
| `idleCompactionMinTokens` | `0` | Minimum context tokens required before idle compaction runs (`0` = no extra floor) |
| `idleRetainTokens` | `0` | Recent tail tokens retained during idle compaction |
| `thresholdRatio` | `0.8` | Automatic trigger ratio |
| `headroomTokens` | `33000` | Space reserved for replies and tool output |
| `minimumReductionRatio` | `0.2` | Target minimum automatic input reduction |
| `observationMaskingEnabled` | `true` | Stage-1 archive-backed observation masking for older large tool outputs (skips LLM summary when target is met) |
| `observationMaskThresholdChars` | `4000` | Minimum tool-result length (in chars) for Stage-1 observation masking |
| `observationMaskHeadChars` | `300` | Leading chars retained inline by Stage-1 observation masking |
| `observationMaskTailChars` | `300` | Trailing chars retained inline by Stage-1 observation masking |
| `cachePreservePrefix` | `true` | Prefer incremental ranges preserving existing prefixes |
| `cacheMaxCheckpoints` | `4` | Checkpoint count at which consolidation is considered |
| `cacheMinSavingsTokens` | `4096` | Minimum space freed by incremental compaction |
| `proactiveEnabled` | `true` | Enable the model's `context_compact` tool |
| `proactiveMinTokens` | `8192` | Minimum context size for proactive compaction |
| `proactiveMinGrowthTokens` | `4096` | New content required before another proactive request |

`auto` controls pressure-based compaction, `idleCompactionMinutes` controls compaction when resuming after idle time, and `proactiveEnabled` controls model requests. Use `/compact` for manual compaction.

### Quotes and resumable pages

| Field | Default | Meaning |
| --- | --- | --- |
| `preserveRecentMessages` | `32` | Maximum recent verbatim user messages |
| `preserveRecentUserTokens` | `4096` | Recent-quote budget |
| `summaryInputRatio` | `0.75` | Summary input budget relative to the model window |
| `summaryInputMaxBytes` | `458752` | Complete summary request's UTF-8 byte budget |
| `summaryConcurrency` | `2` | Maximum concurrent summary workers (`1–6`; probes chunk 0 serially, then generates remaining chunks in parallel and commits strictly in order; drops to 1 on HTTP 429) |
| `summaryReasoningEffort` | `'low'` | Reasoning effort policy for summary calls: `low` (default reduced effort), `none` (omit reasoning effort), `minimal` / `medium` / `high` / `xhigh` / `max` (explicit level forwarded even cross-route, automatically stepping down `max → xhigh → high → medium → low → minimal → none → omit` and caching rejected efforts per route on `UNSUPPORTED_REASONING_EFFORT`), or `inherit` (keep session setting on same-route) |
| `maxSummaryChunks` | `32` | Maximum successful chunks in a workflow |
| `continuationEnabled` | `true` | Enable paged continuation for large histories |
| `continuationMemoryBytes` | `12288` | Working-notes budget for continuation |
| `continuationMaxBytes` | `98304` | Total continuation-record budget |
| `continuationMaxExtraCalls` | `4` | Persisted extra-request allowance |

Older quotes leave the budget first; active requirements remain independently checked. Byte budgets support local planning; model usage reports provide actual service token counts.

### Archives, validation, and language

| Field | Default | Meaning |
| --- | --- | --- |
| `archiveEnabled` | `true` | Archive originals and attachments before replacing the selected history |
| `archiveDir` | Automatic | Custom archive directory |
| `auditEnabled` | `true` | Check requirement retention |
| `auditBlockOnLoss` | `true` | Retry and prevent submission of summaries losing requirements (polarity reversals remain strictly blocked even when `false`) |
| `auditProvenanceBlock` | `true` | Block submissions when claimed permissions or instructions lack a matching verified user source; setting `false` warns on `missing-source` only while `untrusted-source` and `revoked` matches stay strictly blocked |
| `extraReferenceSourceKinds` | `[]` | Additional `source.kind` strings treated as untrusted reference channels instead of user commands (array of up to 64 non-empty strings; strictly rejects `'user'` and `'compact-checkpoint'`). Built-in IM bridge channels (`wechat`, `qq`, `wechat-bridge`, `qq-bridge`, `im-bridge`) are already isolated |
| `extraReferencePrefixes` | `[]` | Additional plain-text prefixes treated as bare untrusted reference injections (trimmed length 2–200 chars, max 64 entries). Built-in multi-line memory headers (e.g., `===== Long-Term Memory =====`, `===== 长期记忆 =====`, `【记忆导引】` with body text) are already isolated cleanly |
| `diskLivenessCheck` | `true` | Run a bounded, read-only local workspace check for missing or modified referenced paths at compaction time (uses 0 LLM tokens; auto-skips remote workspaces) |
| `failureThreshold` | `3` | Consecutive-failure threshold for automatic compaction |
| `pressureBreakerAction` | `'confirm'` | Policy when the automatic pressure circuit breaker trips (hot-configurable in Settings): `'confirm'` (default: pause auto-send and offer Retry or 2-step Confirm bypass in the composer dock), `'degrade'` (warn and bypass pressure compaction while under the hard request budget), or `'block'` (strictly block until retried or restored); `RECOVERY_REQUIRED`, pending continuations, and `total >= messageBudgetTokens` never bypass |
| `strictHostFingerprints` | `false` | When `false`, host minor updates altering private persistence methods gracefully fall back (with a one-time warning) to public `Session.append(replace)` + `sessions.flush` if no unrecovered `.rollback`/`.tail` atomic journal exists; set `true` to enforce reviewed method fingerprints |
| `language` | `auto` | Summary language: `auto`, `zh`, or `en` |

### Post-compact file re-injection & plugin event hooks

| Field | Default | Meaning |
| --- | --- | --- |
| `postCompactReinjectEnabled` | `true` | Deterministically re-reads recently touched local workspace files from disk after compaction (uses 0 LLM tokens; skips `AGENTS.md` / `CLAUDE.md`, `.env` / keys / secrets, binaries, symlink escapes, and remote/synthetic sessions) |
| `postCompactReinjectMaxFiles` | `5` | Maximum number of recent workspace files re-injected per compaction (`1–20` positive integer) |
| `postCompactReinjectMaxBytes` | `24576` | Total UTF-8 byte budget for post-compact file re-injection (`1024–262144` integer) |
| `postCompactReinjectMaxFileBytes` | `6144` | Per-file UTF-8 byte cap for post-compact file re-injection (`512–65536` integer) |

Weave also emits two in-process Cordis plugin event hooks on `ctx.root ?? ctx` for sibling DSH plugins (no external shell commands are spawned):

- **`weave/pre-compact`**: Dispatched serially before compaction runs; returning `{ continue: false }` or `{ cancel: true }` vetoes compaction, and `{ additionalContext }` (up to 1000 chars combined) or `{ focusInstruction }` (up to 500 chars) augments the run. Listener errors or timeouts (default 5000ms) log a warning and fail open so compaction is not stalled.
- **`weave/post-compact`**: Dispatched serially after compaction commits; strictly failure-isolated (warnings logged, never fails or rolls back committed checkpoints), optionally collecting `{ notice }` / `{ additionalContext }` hints.

The settings interface follows DSH's Chinese or English locale. The `language` option controls generated summaries separately.

Failures report their cause, attempts, and diagnostic location. See [Troubleshooting](troubleshooting.md).
