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
| Block on requirement loss | `auditBlockOnLoss` | `true` (on) | On / Off |

The UI displays timing in seconds; configuration fields use milliseconds. A retry count of 2 allows up to 3 attempts for each unfinished summary or page. Consecutive retries use exponential backoff, capped at 30 seconds.

Select or clear the provider and model together. **Clear (follow session model)** clears the model override and its output limit while saving the page's current trigger ratio, minimum reduction, retry, idle, and audit-blocking settings, including unsaved edits.

**Saving or clearing settings on this page needs no DSH restart.** The summary model, output limit, trigger ratio, minimum reduction, retry and idle settings (as well as `auditBlockOnLoss`) all hot-apply at subsequent compaction or request boundaries. A compaction already in progress keeps the configuration snapshot it started with until that operation finishes.

### Requirement audit & live progress card

- **`auditBlockOnLoss` (on by default)**: Retries and blocks summaries or continuations that drop active user requirements. Weave automatically filters `<system-reminder>`, `AGENTS.md`, and first-party DSH V4 host reminders (while preserving real user prose in mixed messages) to prevent false rejections. If a long session still hits retention rejections, you can toggle this off live in Settings; Section 6 verbatim quotes, polarity-flip blocking, approval provenance checks, and progress-fact conflict checks remain strictly enforced.
- **Live compaction progress card**: During automatic compaction, manual `/compact`, paged continuation, or compatibility conversion, a live progress card appears above the composer showing the current phase, progress bar, wave/chunk/page counters, attempt count, summary model, token delta, masked tool count, stream liveness, and elapsed timer. When idle (and no migration is needed), the card stays hidden.
- **`billion-context` compatibility conversion & verified backups**: The **Convert to Weave** row appears ONLY when unmigrated `billion-context` / `billion-context-dsh` fold blocks or tool artifacts are actually detected in the current session (strictly absent on ordinary or already-converted sessions). Before any irreversible conversion mutates the session, Weave creates and SHA-256 verifies a raw-byte full-session backup under `<DSH_HOME>/storages/dsh-compaction-weave/backups/` (preserving exact `.v4.jsonl.zstd` / `.v4.jsonl` encoding with zero foreign files written into DSH's session directory). Equivalent slash subcommands are available via `/compact migrate`, `/compact backups`, and `/compact restore [backupId]`.

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
| `auditBlockOnLoss` | `true` | Retry and prevent submission of summaries losing requirements |
| `failureThreshold` | `3` | Consecutive-failure threshold for automatic compaction |
| `strictHostFingerprints` | `false` | When `false`, host minor updates altering private persistence methods gracefully fall back (with a one-time warning) to public `Session.append(replace)` + `sessions.flush` if no unrecovered `.rollback`/`.tail` atomic journal exists; set `true` to enforce reviewed method fingerprints |
| `language` | `auto` | Summary language: `auto`, `zh`, or `en` |

The settings interface follows DSH's Chinese or English locale. The `language` option controls generated summaries separately.

Failures report their cause, attempts, and diagnostic location. See [Troubleshooting](troubleshooting.md).
