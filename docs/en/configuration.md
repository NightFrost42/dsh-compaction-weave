# Configuration

[简体中文](../configuration.md) · [English](configuration.md)

## Context Compaction (Weave) settings

Open **Settings → Context Compaction (Weave)**, or the **Weave Context Compaction** plugin details.

With history tools and proactive compaction enabled, the four definitions (`history_list`, `history_read`, `history_search`, `context_compact`) total **2,563 chars / 645 DSH tokens / ~697 BPE tokens**. Summary budgeting uses a heuristic: `summaryCjkTokensPerChar` defaults to `0.75`, with ASCII estimated at ~`0.25` tokens per character. Actual billing and hard limits follow the target tokenizer; BPE counts also vary by tokenizer.

| Setting | Field | Default | Range |
| --- | --- | --- | --- |
| Provider | `summarizationProvider` | Follow conversation | Configured providers |
| Model | `summarizationModel` | Follow conversation | Models offered by the provider |
| Output limit | `maxTokens` | 8192 | 1–1000000 |
| Trigger ratio | `thresholdRatio` | 0.8 | 0.5–0.95 |
| Compact before resuming | `idleCompactionMinutes` | 0 (off) | 0 disables it; **not** scheduled in the background—runs 0-LLM microcompaction / optional idle summary only when you return and send the next message; 1–43200 whole minutes, up to 30 days |
| Minimum reduction | `minimumReductionRatio` | 0.2 | 0.05–0.9 |
| Additional retries | `summaryRetryCount` | 2 | 0–4 |
| Base delay | `summaryRetryDelayMs` | 1000 | 0–30000 ms |
| Per-request timeout | `summaryTimeoutMs` | 180000 | 5000–3600000 ms |
| Summary concurrency | `summaryConcurrency` | 2 | 1–6 integer (parallel chunk generation with strictly ordered serial commit; drops to 1 on HTTP 429) |
| Summary reasoning effort | `summaryReasoningEffort` | `auto` | `auto` (default route-aware: inherits on same-route Anthropic/Claude, caps active thinking to `low` on non-Anthropic routes, stays off when session thinking is disabled) / `low` / `none` (omitted) / `minimal` / `medium` / `high` / `xhigh` / `max` / `inherit` (always inherit); steps down automatically if unsupported |
| Conservative CJK budget weight | `summaryCjkTokensPerChar` | `0.75` | `0.5–1.5` (`0.75` default keeps prefix KV caching active on 128k Chinese sessions; raise to `1.0` for compatibility with finer CJK tokenizers) |
| Block on requirement loss | `auditBlockOnLoss` | `true` (on) | On / Off |
| Audit coverage enforcement scope | `auditCoverageScope` | `'recent'` | `'recent'` (default: enforce coverage across both the recent retention window and recent current-span new raw `user/message` inputs capped at `>= 32` messages / `>= 4096` tokens, while logging out-of-window multi-gen omissions as non-blocking) / `'span-new'` (new raw `user/message` items directly in the span) / `'all'` (all historical messages); **conflict redlines (`polarity`, `value`, `unit`, `condition`, `range`, `relation`, `exception`, `reference`, `provenance`) always stay globally enforced** |
| Heuristic audit exhaustion policy | `auditExhaustionPolicy` | `'fallback'` | `'fallback'` (default: pin `<= 3` verified verbatim pure-user rules outside prose for coverage/soft-provenance disputes after chain + retry exhaustion; polarity reversals never bypass) / `'block'` (strictly block on exhaustion) |
| Post-compact workspace file re-injection | `postCompactReinjectEnabled` | `true` (on) | On (0 extra summary LLM calls; **redacts credentials, unclosed/straddling PEM bodies, and partial secret prefixes**, up to 5 files capped by `postCompactReinjectMaxBytes` = 24KB) / Off |
| Spill oversized tail tool outputs | `persistedOutputEnabled` | `true` (on) | On (0 extra summary LLM calls, archives only unsent tail tool outputs ≥ 32768 chars with 1200-char head/tail preview) / Off |
| Stage-1 observation masking | `observationMaskingEnabled` | `true` (on) | On (default 0-LLM fast path; masks older oversized tool outputs into stubs with `history_read` pointers during pressure or manual compaction, skipping LLM summary if target is met) / Off |
| Idle 0-LLM microcompaction | `microcompactEnabled` | `true` (on) | On (0 LLM calls; **requires `idleCompactionMinutes > 0` to trigger**—preserves newest 4 hot outputs and folds older oversized outputs & repeated reads after idle timeout) / Off |
| Last-resort 0-LLM emergency pruning (Snip) | `snipEnabled` | `true` (on) | On (default, 0 LLM; triggers only near `messageBudgetTokens` or on 413 after regular compaction/continuation fails, archiving old tool loops with `history_read` pointers without dropping recent user messages) / Off |
| Pre-generate summaries in background between turns | `sessionMemoryEnabled` | `false` (off) | Off (default, 0 extra calls) / On (opt-in; pre-warms rolling summaries between turns in the background, consuming extra API balance & token quota) |
| Background memory pre-warm limit per cycle | `sessionMemoryMaxCallsPerSession` | `8` | 1–100 integer (**per-cycle** billing fuse between committed Weave compactions; resets `callsUsed` on committed compaction checkpoint while keeping monotonic `totalCallsUsed`) |
| Expired-window context collapse | `contextCollapseEnabled` | `false` (off) | Off (default) / On (opt-in; triggers ONLY inside the expired `idleCompactionMinutes` resume window after 0-LLM microcompaction, never during warm prompt cache; may invoke a summary LLM call consuming API balance) |

The UI displays timing in seconds; configuration fields use milliseconds. A retry count of 2 allows up to 3 attempts for each unfinished summary or page. Consecutive retries use exponential backoff, capped at 30 seconds.

Select or clear the provider and model together (standalone output limit `maxTokens` can also be saved independently without overriding provider/model). **Clear (follow session model)** clears the model override and its standalone output limit while saving the page's current trigger ratio, minimum reduction, retry, concurrency, reasoning effort, CJK weight, idle, audit-blocking, workspace file re-injection, persisted-output, Stage-1 observation masking, microcompaction, Snip emergency pruning, and modified session-memory / context-collapse settings, including unsaved edits.

**Saving or clearing settings on this page needs no DSH restart.** The summary model, output limit, trigger ratio, minimum reduction, retry and idle settings (as well as concurrency, reasoning effort, `summaryCjkTokensPerChar`, `auditBlockOnLoss`, `auditCoverageScope`, `auditExhaustionPolicy`, `postCompactReinjectEnabled`, `persistedOutputEnabled`, `observationMaskingEnabled`, `microcompactEnabled`, `snipEnabled`, `sessionMemoryEnabled`, `sessionMemoryMaxCallsPerSession`, `contextCollapseEnabled`, `archiveWarnBytes`, `maxVisibleAttachmentBytes`, and `maxVisibleImages`) all hot-apply at subsequent compaction or request boundaries. A compaction already in progress keeps the configuration snapshot it started with until that operation finishes.

### Requirement audit, resumable progress, slash commands & live progress card

- **`auditBlockOnLoss` (on by default) & `auditExhaustionPolicy` (`'fallback'` by default)**: Retries and blocks summaries or continuations that drop active user requirements. Weave automatically filters `<system-reminder>`, `AGENTS.md`, and first-party DSH V4 host reminders (while preserving real user prose in mixed messages) and attempts deterministic local disputed-line reconstruction during retries. If the active summary target and at least 1 corrective retry still exhaust with `<= 3` coverage or `missing-source` soft-provenance heuristic losses (with every non-provenance item uniquely resolved to a verified pure-user message, `<= 2048` UTF-8 bytes overhead, and strict token/byte shrinkage still holding), `'fallback'` pins those verbatim user rules inside an outer `<pinned-source-rules>` block (automatically stripped before secondary compaction) and records `auditFallback` telemetry; polarity reversals (`CONSTRAINT_POLARITY_LOST`), structural, shrinkage, `PROGRESS_FACT_CONFLICT`, `RETIRED_MEMORY_REINTRODUCED`, and `untrusted-source` / `revoked` provenance checks NEVER bypass (set `'block'` to disable this controlled exhaustion fallback).
- **One-shot focused compaction & breaker reset (`/compact <focus>`, `/compact -- <focus>`, `/compact reset`)**:
  - `/compact <focus>` (for example `/compact keep API schema and error line numbers`) passes a one-shot focus instruction (control chars stripped, whitespace collapsed, capped at 500 characters) to manual compaction so specified details are prioritized without dropping user constraints or inventing facts. Only the exact 7 built-in subcommands (`migrate`, `backups`, `restore [backupId]`, `resume`, `cancel`, `discard`, `reset`) are reserved; any other non-empty text parses as a focus instruction. Prefix with `--` (`/compact -- resume notes` or `/compact -- reset`) to force focus parsing when your instruction begins with a reserved keyword. Plain `/compact` with no arguments delegates unchanged.
  - `/compact reset` safely clears the current session's circuit breaker and consecutive failure counter (`failures: 0`, `stopped: false`, `breakerBypassed: false`) while preserving observed `window` bounds and resumable breakpoints; if a manually edited state file triggered `STATE_INVALID` and no active lock or pending recovery journal exists, it atomically rebuilds a clean state record with a fresh SHA-256 checksum.
- **Live progress card & pause/resume checkpoints**: During automatic compaction, manual `/compact`, paged continuation, or compatibility conversion, a live progress card appears above the composer showing the current phase, progress bar, wave/chunk/page counters, concurrency/rate-limit indicator, attempt count, summary model, token delta, masked tool count, stream liveness, elapsed timer, and a **Pause** button; when idle (with no migration or paused checkpoint), it stays hidden. If a run is paused, timed out, errored, or interrupted by a crash, committed chunks stay intact and remaining progress is persisted as a resumable checkpoint: ordinary interruptions (`interrupted`) auto-resume before the next message or on **Resume** / `/compact resume`; budget-paused (`paused_budget`) and threshold-failed (`paused_failure`) checkpoints never auto-resume (avoiding silent charges or blocking chat) and wait for explicit **Resume**, `/compact` / `/compact resume`, or **Discard** / `/compact discard` (original full-session backups are never deleted). Slash subcommands: `/compact resume`, `/compact cancel`, `/compact discard`.
- **`billion-context` compatibility conversion & verified backups**: The **Convert to Weave** row appears ONLY when unmigrated `billion-context` / `billion-context-dsh` fold blocks or tool artifacts are actually detected in the current session (strictly absent on ordinary or already-converted sessions). Before any irreversible conversion mutates the session, Weave creates and SHA-256 verifies a raw-byte full-session backup under `<DSH_HOME>/storages/dsh-compaction-weave/backups/` (preserving exact `.v4.jsonl.zstd` / `.v4.jsonl` encoding with zero foreign files written into DSH's session directory), and protects the initial original baseline backup across repeated runs. Equivalent slash subcommands are available via `/compact migrate`, `/compact backups`, and `/compact restore [backupId]`.
- **Coexistence with other compaction/pruning plugins**: Avoid enabling multiple context compaction or pruning plugins that modify `compaction-basic` at the same time (such as `billion-context` or other plugins rewriting `compaction-basic`); after disabling or uninstalling another such plugin, reload DSH and verify no stale `disabled: true` or `auto: false` override remains.

First installation or plugin upgrades still require a host reload as prompted by DSH to load the new code. The no-restart behavior above applies to changes on the summary settings page.

Settings are stored in:

```text
<DSH_HOME>/storages/dsh-compaction-weave/summary-config.json
```

When `DSH_HOME` is unset, DSH uses `.dsh` in the user's home directory.

### Compact before resuming

Choose **5, 10, 30, 60, 720 or 1440 minutes**, or the longer **7 days (10080 minutes) / 30 days (43200 minutes)** presets. For **Custom**, enter **1–43200 whole minutes**. Here, **1 month is fixed at 30 days, or 43200 minutes**, regardless of calendar month length. The default is off; select **Off** to disable, which saves 0. Custom input starts at 1.

The Claude 5 / 60-minute references, GPT ordinary and extended-cache references, and Gemini 30-minute reference remain available. The 7-day and 30-day presets support longer idle policies; they do not imply that provider caches last that long.

When a new user message arrives, compare its queue time with the latest user, assistant or tool activity in the same conversation. If the gap **exceeds** the selected interval, Weave shares `idleCompactionMinutes` with **Time-Based Microcompact (0 LLM calls)**: at the first step of the new turn before handling the new input, it first preserves the newest `K` (default `4`) hot tool outputs and folds older oversized tool outputs and same-path repeated reads, then runs an optional full idle summary (`idleFullSummaryEnabled`) only if further reduction is still needed. This setting is independent of the pressure-based `auto` switch, applies across conversations, and does not change automatically when switching models. Saved changes apply at subsequent request boundaries; they do not start an idle countdown or background compaction timer.

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
| `headroomTokens` | `33000` | Space reserved for replies and tool output; capped at `25%` up to `2×` headroom and ramped smoothly above it, with at least 1 token of net compaction margin beyond a ratio-based recent tail |
| `minimumReductionRatio` | `0.2` | Target minimum automatic input reduction |
| `observationMaskingEnabled` | `true` | Stage-1 archive-backed observation masking for older large tool outputs (skips LLM summary when target is met) |
| `observationMaskThresholdChars` | `4000` | Minimum tool-result length (in chars) for Stage-1 observation masking |
| `observationMaskHeadChars` | `300` | Leading chars retained inline by Stage-1 observation masking |
| `observationMaskTailChars` | `300` | Trailing chars retained inline by Stage-1 observation masking |
| `persistedOutputEnabled` | `true` | Enable **Persisted-Output**: spills ONLY newly landed unsent tail `tool/result` nodes (0 prefix-cache invalidation, never mutates already-sent history, skips `isError: true`) |
| `persistedOutputThresholdChars` | `32768` | Minimum text block length (chars) before tail `Persisted-Output` spilling triggers (`2048–1048576` integer) |
| `persistedOutputHeadChars` | `1200` | Leading preview chars kept inline in persisted-output stubs (`0–8192` integer) |
| `persistedOutputTailChars` | `1200` | Trailing preview chars kept inline in persisted-output stubs (`0–8192` integer) |
| `microcompactEnabled` | `true` | Enable **Time-Based Microcompact**: **requires `idleCompactionMinutes > 0` to trigger** (remains inactive when `0`); 0 LLM calls, preserves newest `K` hot tool outputs while folding older oversized outputs and same-path repeated reads before optional full idle summary |
| `microcompactKeepRecentTools` | `4` | Number of newest successful hot tool outputs `K` preserved intact during microcompaction (`0–50` integer) |
| `microcompactThresholdChars` | `2000` | Minimum length (chars) for folding older non-error tool outputs during microcompaction (`500–262144` integer) |
| `microcompactHeadChars` | `200` | Leading preview chars kept inline by microcompact masking (`0–4096` integer) |
| `microcompactTailChars` | `200` | Trailing preview chars kept inline by microcompact masking (`0–4096` integer) |
| `microcompactRepeatedReadMinChars` | `2000` | Minimum char length for deduplicating earlier same-path file reads during microcompaction (`500–262144` integer; newer hot-tail reads still supersede older reads) |
| `idleFullSummaryEnabled` | `true` | **Requires `idleCompactionMinutes > 0` to trigger**; whether idle resume compaction may fall back to a full LLM idle summary after 0-LLM microcompaction if still needed (set `false` for microcompact-only idle cleanup) |
| `cachePreservePrefix` | `true` | Prefer incremental ranges preserving existing prefixes |
| `cacheMaxCheckpoints` | `4` | Checkpoint count at which consolidation is considered |
| `cacheMinSavingsTokens` | `4096` | Minimum space freed by incremental compaction |
| `proactiveEnabled` | `true` | Enable the model's `context_compact` tool |
| `proactiveMinTokens` | `8192` | Minimum context size for proactive compaction |
| `proactiveMinGrowthTokens` | `4096` | New content required before another proactive request |

`auto` controls pressure-based compaction, `idleCompactionMinutes` controls compaction when resuming after idle time, and `proactiveEnabled` controls model requests. Use `/compact` for manual compaction.

### Execution hierarchy & last-resort 0-LLM emergency pruning (Snip)

Weave reduces context in strictly ordered, cache-conscious tiers:

1. **Normal warm cache (active turns)**: runs ONLY 0-LLM, 0-prefix-cache-invalidation **Persisted-Output** tail spilling for newly landed unsent `tool/result` nodes; never mutates previously sent history.
2. **Expired idle TTL window (`idleCompactionMinutes` exceeded)**:
   - **Tier 1 — Idle 0-LLM Time-Based Microcompact**: keeps newest `K` hot tool outputs and folds older oversized outputs & repeated same-path reads.
   - **Tier 2 — Context Collapse (opt-in)**: runs progressively when `contextCollapseEnabled: true` (never during warm prompt cache).
   - **Tier 3 — Optional full idle LLM summary (`idleFullSummaryEnabled`)**: runs only if further reduction is still needed.
3. **Pressure / manual compaction (`thresholdRatio` / `pressureBudgetTokens`, `/compact`, `context_compact`)**: runs Stage-1 archive-backed **Observation Masking** (0 LLM if target met) before LLM summarization / paged continuation (reusing validated `Session Memory` first when `sessionMemoryEnabled: true`).
4. **Last-resort 0-LLM emergency pruning (`Snip`) near the hard wall**: triggers ONLY as a final fallback when regular compaction or continuation fails / cannot fit and the session still approaches `messageBudgetTokens` or hits `CONTEXT_WINDOW_EXCEEDED` (413) (0 LLM calls). Snip prioritizes archiving older tool-call/result loops into compact stubs with `history_read` pointers while strictly protecting the system prompt, recent user messages and turns, active constraints, and tool-pair boundaries.

| Field | Default | Meaning |
| --- | --- | --- |
| `snipEnabled` | `true` | Enable last-resort 0-LLM emergency pruning **Snip** (on by default, hot-toggleable in Settings; 0 LLM calls, triggers only near `messageBudgetTokens` or on 413 after regular compaction/continuation fails, archiving pruned tool loops with `history_read` pointers and never dropping recent user messages) |
| `snipKeepRecentTurns` | `2` | Minimum recent authentic user turns strictly protected from Snip pruning (`1–50` integer) |
| `snipKeepRecentTokens` | `8192` | Minimum recent working-tail token floor protected from Snip pruning (`512–262144` integer, bounded against target budget on tool-pair-balanced boundaries) |
| `snipMinSavingsTokens` | `1024` | Minimum net token savings required before Snip archives a candidate span (`0–131072` integer) |
| `snipMaxSpansPerRescue` | `4` | Maximum contiguous spans archived in a single emergency Snip rescue pass (`1–20` integer) |

### Background Summary Pre-Warming Between Turns & Expired-Window Context Collapse (Opt-In, Default Off)

Both features are **strictly opt-in (`false` by default)**: when disabled, they incur **0 extra LLM calls and 0 extra charges**.

- **Pre-generate Summaries in Background Between Turns (`sessionMemoryEnabled`)**: Distinct from `idleCompactionMinutes` above (**not** scheduled in the background—`idleCompactionMinutes` runs only when you return and send the next message), enabling this toggle pre-generates rolling summaries in the background between turns using an explicit `coveredThroughSeq` watermark while preserving the recent working tail. If foreground compaction arrives while a compatible in-flight pre-warm is running, it waits briefly (default `4000 ms`) to reuse it with 0 extra LLM calls, or cancels and falls back cleanly on timeout or focus mismatch; reuses strictly verify checksums, `sourceHash`, `policyFingerprint`, and tool-pair balance. Bounded by min tokens, update intervals, cooldown, 12 KB payload cap, and a persistent **per-cycle billing fuse** (`sessionMemoryMaxCallsPerSession`, preserving monotonic `totalCallsUsed` across `clear()`, reset/rollback/backup restore/0-LLM pruning, and resetting `callsUsed` ONLY after a committed Weave compaction checkpoint or `bili` fold-adopt commit) to prevent runaway background billing.
- **Expired-Window Context Collapse**: Enforces **expired-TTL cache-safe gating**—triggers **ONLY** inside the expired `idleCompactionMinutes` resume window **after** Tier 1 0-LLM **Time-Based Microcompact** (and before optional Tier 3 full idle summary). **NEVER** runs during active turns or warm prompt caches, and stays completely inactive when `idleCompactionMinutes` is `0`. Collapses earlier uncollapsed raw sub-phases progressively up to `contextCollapseMaxSpanTokens` while protecting the recent working tail via the **intersection** of `contextCollapseKeepRecentTokens` and `contextCollapseKeepRecentTurns` (ignoring non-user `<system-reminder>` / bridge messages and keeping tool call/result pairs unsplit). May invoke a summary LLM call consuming API balance.

| Field | Default | Meaning |
| --- | --- | --- |
| `sessionMemoryEnabled` | `false` | Opt-in toggle for background summary pre-warming between turns (`false` by default; enabling runs background LLM calls consuming API balance and token quota) |
| `sessionMemoryMinTokens` | `24576` | Minimum compactable context tokens required before background pre-warming runs (`4096–1000000` integer) |
| `sessionMemoryUpdateIntervalTokens` | `16384` | Minimum new token delta beyond the existing `coveredThroughSeq` watermark to trigger an incremental refresh (`2048–500000` integer) |
| `sessionMemoryUpdateIntervalTurns` | `4` | Minimum new authentic user turn delta beyond `coveredThroughSeq` to trigger an incremental refresh (`1–100` integer) |
| `sessionMemoryCooldownMs` | `60000` | Minimum cooldown interval in milliseconds between background pre-warm LLM calls (`0–3600000` integer) |
| `sessionMemoryMaxBytes` | `12288` | Maximum UTF-8 byte size allowed for a persisted session memory payload (`2048–65536` integer; oversized entries are cleanly skipped) |
| `sessionMemoryMaxCallsPerSession` | `8` | Background memory pre-warm limit per cycle / per-cycle billing fuse (`1–100` integer; `callsUsed` resets after a committed Weave compaction checkpoint while keeping monotonic `totalCallsUsed`, preserved across `clear()`, rollback, restore, and 0-LLM pruning) |
| `contextCollapseEnabled` | `false` | Opt-in toggle for progressive Context Collapse inside the expired `idleCompactionMinutes` resume window (`false` by default; never triggers during warm prompt cache) |
| `contextCollapseMinTokens` | `49152` | Minimum total surface tokens required before Context Collapse activates (`8192–1000000` integer) |
| `contextCollapseMaxSpanTokens` | `32768` | Maximum prefix token span collapsed in a single progressive step (`4096–500000` integer, leaving intermediate/recent history intact) |
| `contextCollapseKeepRecentTokens` | `8192` | Minimum recent working-tail token floor protected from Context Collapse (`1024–200000` integer, intersected with turn retention) |
| `contextCollapseKeepRecentTurns` | `2` | Minimum recent authentic user turns protected from Context Collapse (`1–20` integer, intersected with token retention on tool-pair-balanced boundaries) |

### Quotes and resumable pages

| Field | Default | Meaning |
| --- | --- | --- |
| `preserveRecentMessages` | `32` | Maximum recent verbatim user messages |
| `preserveRecentUserTokens` | `4096` | Recent-quote budget |
| `summaryInputRatio` | `0.85` | Summary input token budget relative to the available model window |
| `summaryInputMaxBytes` | `2097152` | Independent UTF-8 byte hard ceiling for the complete summary request (2 MiB) |
| `summaryCjkTokensPerChar` | `0.75` | Heuristic tokens-per-char multiplier for CJK/Hangul/Kana budget planning (`0.5–1.5`, hot-configurable in Settings; Weave uses a lightweight heuristic vs external BPE tables—ASCII ~`0.25` tok/char—while upstream billing uses model BPE; set `1.0` for finer CJK tokenizers) |
| `summaryConcurrency` | `2` | Maximum concurrent summary workers (`1–6`; probes chunk 0 serially, then generates remaining chunks in parallel and commits strictly in order; drops to 1 on HTTP 429) |
| `summaryReasoningEffort` | `'auto'` | Reasoning effort policy for summary calls: `auto` (default route-aware: inherits session effort on same-route Anthropic/Claude to preserve prompt caches, caps active thinking to `low` on non-Anthropic routes, stays off when session thinking is disabled), `low` (explicit low selection; preserves `minimal` / `none` when lower, otherwise forwards `'low'` including cross-route), `none` (omit reasoning effort), `minimal` / `medium` / `high` / `xhigh` / `max` (explicit levels forwarded even cross-route; all direct levels automatically step down `max → xhigh → high → medium → low → minimal → none → omit` and cache rejected efforts per route on `UNSUPPORTED_REASONING_EFFORT`), or `inherit` (always inherit session setting) |
| `compactionRetries` | `1` | Legacy host-schema/spec compatibility placeholder (unused by runtime retry loops; configure `summaryRetryCount` and `summaryRetryDelayMs` for actual retries) |
| `maxSummaryChunks` | `32` | Maximum successful chunks in a workflow |
| `continuationEnabled` | `true` | Enable paged continuation for large histories |
| `continuationMemoryBytes` | `12288` | Working-notes budget for continuation |
| `continuationMaxBytes` | `98304` | Total continuation-record budget |
| `continuationMaxExtraCalls` | `4` | Persisted extra-request allowance |

Older quotes leave the budget first; active requirements remain independently checked. Byte budgets support local planning; model usage reports provide actual service token counts.

### Archives, validation, and language

| Field | Default | Meaning |
| --- | --- | --- |
| `archiveEnabled` | `true` | Archive originals and attachments before replacing the selected history (uses lossless `zstd` compression and `0o700` / `0o600` permissions on POSIX macOS/Linux—Windows follows Node.js file permission semantics; never auto-deletes) |
| `archiveDir` | Automatic | Custom archive directory |
| `archiveWarnBytes` | `536870912` (512 MiB) | Gently warns in the composer dock when local `sessions/` archive usage exceeds this threshold (`0` disables; `0–102400 MiB` range; pairs with manual lossless compression and confirmed orphan cleanup in Settings) |
| `maxVisibleAttachmentBytes` | `16777216` (16 MiB) | High-watermark byte threshold for visible un-offloaded images (`0` disables byte trigger; uses high/low hysteresis to batch-offload older images via native `image/offload` while retaining newest 6 hot to avoid per-turn KV-cache thrashing and without resetting session-memory `callsUsed`) |
| `maxVisibleImages` | `24` | High-watermark count threshold for visible un-offloaded images (`0` disables count trigger, `1–500` allowed; paired with a `>= 20` guard for images with an edge `> 2000px`; batch-offloads to low watermark and never rewrites `user/message` events) |
| `auditEnabled` | `true` | Check requirement retention |
| `auditBlockOnLoss` | `true` | Retry and prevent submission of summaries losing requirements; explicitly setting `false` acts as a manual emergency escape hatch permitting non-polarity losses/conflicts, while **polarity reversals (`polarity`) and hard provenance conflicts (`untrusted-source`/`revoked`) remain strictly blocked** |
| `auditCoverageScope` | `'recent'` | Controls which historical user messages enforce strict heuristic `coverage` checking (hot-configurable in Settings): `'recent'` (default: covers both the `preserveRecentMessages` / `preserveRecentUserTokens` retention window and recent new raw `user/message` entries in the current span capped at `>= 32` messages / `>= 4096` tokens, so shrinking Section 6 verbatim quotes never disables coverage auditing on current-span instructions while still preventing ancient multi-gen or giant-migration deadlocks; out-of-window omissions log a warning as `softCoverageCount` without blocking or consuming fallback slots; explicit `/compact <focus>` softens pure `coverage` gaps only and never bypasses value/range/condition conflicts), `'span-new'` (enforce only non-checkpoint raw `user/message` events directly in the span), or `'all'` (enforce all active messages across the span). All conflict redlines (`polarity`, `value`, `unit`, `condition`, `range`, `relation`, `exception`, `reference`, `provenance`) and verbatim Section 6 preservation remain globally enforced across all modes |
| `auditProvenanceBlock` | `true` | Block submissions when claimed permissions or instructions lack a matching verified user source; setting `false` warns on `missing-source` only while `untrusted-source` and `revoked` matches stay strictly blocked |
| `auditExhaustionPolicy` | `'fallback'` | Controlled automatic policy when the active summary target and at least 1 corrective retry exhaust with only `<= 3` pure `coverage` or soft `missing-source` gaps (hot-configurable in Settings): `'fallback'` (default: pins verified verbatim pure-user rules in `<pinned-source-rules>` `<= 2048` B while enforcing strict shrinkage and all hard redlines) or `'block'` (strictly fail without fallback); **never activates on `CONSTRAINT_POLARITY_LOST`, any hard value/unit/condition/range/relation/exception/reference conflict, `summaryRetryCount === 0`, or structure/size/progress/retired/`untrusted-source`/`revoked` failures** |
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
| `postCompactReinjectEnabled` | `true` | Deterministically re-reads recently touched local workspace files from disk after compaction (0 extra summary LLM calls; re-injected files are passed as subsequent main-turn context input, capped by `postCompactReinjectMaxBytes`; redacts credentials, unclosed/boundary-straddling PEM private keys via bounded `+4 KiB` lookahead, and partial secret prefixes, and skips `AGENTS.md` / `CLAUDE.md`, `.env` / keys / secrets, binaries, symlink escapes, and remote/synthetic sessions) |
| `postCompactReinjectMaxFiles` | `5` | Maximum number of recent workspace files re-injected per compaction (`1–20` positive integer) |
| `postCompactReinjectMaxBytes` | `24576` | Total UTF-8 byte budget for post-compact file re-injection (`1024–262144` integer) |
| `postCompactReinjectMaxFileBytes` | `6144` | Per-file UTF-8 byte cap for post-compact file re-injection (`512–65536` integer) |

Weave also emits two in-process Cordis plugin event hooks via a top-level bridged `hookBus` (safe under strict `ReflectService` proxies) for sibling DSH plugins (no external shell commands are spawned):

- **`weave/pre-compact`**: Dispatched serially before compaction runs; returning `{ continue: false }` or `{ cancel: true }` vetoes compaction, `{ additionalContext }` (newline-preserving, up to 1000 chars combined, injected separately from user focus) or `{ focusInstruction }` (up to 500 chars) augments the run. Listener errors or timeouts (default 5000ms) log a warning and fail open so compaction is not stalled.
- **`weave/post-compact`**: Dispatched serially after compaction commits; strictly failure-isolated (warnings logged, never fails or rolls back committed checkpoints), collecting optional `{ notice }` / `{ notices }` / `{ additionalContext }` strings into info logs and `hookNotices` receipt metadata.

The settings interface follows DSH's Chinese or English locale. The `language` option controls generated summaries separately.

Failures report their cause, attempts, and diagnostic location. See [Troubleshooting](troubleshooting.md).
