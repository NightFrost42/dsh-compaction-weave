<div align="center">

# DSH Compaction Weave

**Compact context. Keep requirements. Carry work forward.**

A context-compaction plugin for DeepSeek Harness that keeps long conversations focused on the current goal, active constraints, and the next step.

[简体中文](README.md) · [English](README.en.md)

[![Release](https://img.shields.io/github/v/release/NightFrost42/dsh-compaction-weave?style=flat-square&color=5865F2)](https://github.com/NightFrost42/dsh-compaction-weave/releases/latest)
[![npm](https://img.shields.io/npm/v/dsh-compaction-weave/latest?style=flat-square&color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-compaction-weave)
[![CI](https://img.shields.io/github/actions/workflow/status/NightFrost42/dsh-compaction-weave/ci.yml?style=flat-square)](https://github.com/NightFrost42/dsh-compaction-weave/actions/workflows/ci.yml)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.2--rc.1%20%3C1.0.0--0-4D6BFE?style=flat-square)](docs/en/configuration.md)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524.9-339933?style=flat-square&logo=node.js&logoColor=white)](docs/en/development.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-22A06B?style=flat-square)](LICENSE)
[![Languages](https://img.shields.io/badge/docs-English%20%7C%20%E4%B8%AD%E6%96%87-0F766E?style=flat-square)](README.md)

Incremental compaction · Requirement retention · History lookup · Audit checks · Diagnostics

[Install & upgrade](#installation-and-upgrade) · [Quick start](#quick-start) · [Principles](docs/en/principles.md) · [Basic settings](#basic-settings) · [Tests & verification](#tests-and-verification) · [Diagnostics & feedback](#diagnostics-and-feedback) · [Changelog](CHANGELOG.md)

</div>

## Why Weave?

Long sessions accumulate tool outputs, logs, superseded plans, and repeated discussion. Under the default configuration, DSH Compaction Weave uses a **two-stage approach — fold oversized tool outputs cheaply first, summarize only when needed** — to preserve **the current task, active user requirements, completed progress, and the next step**, while archiving original messages and attachments locally for on-demand lookup.

- **Two-stage compaction & same-route prefix reuse**: Non-error tool outputs longer than `4000` characters outside the recent tail are archived and folded into compact head/tail previews (upgraded with Tier-4 anomaly/declaration-skeleton previews) with `history_read` pointers first, skipping LLM calls whenever folding alone meets the target. When summarization is required, stable prefixes and prior checkpoints stay intact, and same-model requests keep the live prefix unchanged within budget to stay KV-cache friendly.
- **Channel isolation, redacted re-injection & audit checks**: Uses host event roles and explicit tags (`<untrusted_reference>`, `<quoted_text>`) to tell genuine user instructions apart from logs, fetched pages, and tool outputs. Defaults `auditCoverageScope: 'recent'` while globally enforcing numbers, unit conversions, conditions, affirmative/negated polarity symmetry, approval provenance, target scopes, and explicit `key: value` progress fields, paired with deterministic relative date grounding and redacted workspace file re-injection.
- **Resumable paging & BM25F archive lookup**: Splits oversized histories into resumable pages persisted on disk using lossless Node.js 24 native `zstd` archives; standard checkpoints carry `History archive` pointers and touched file paths for targeted queries via `history_list`, pure-JS BM25F multi-field `history_search`, and strict-schema-compatible `history_read`.

## How compaction works

When context reaches the trigger threshold, resumes after idle time, or receives a compaction request under default archiving, Weave first checks whether folding bulky older tool outputs is enough on its own. Otherwise it selects a tool-balanced span of earlier history, requests a structured candidate summary, and deterministically fills bounded recent verbatim user quotes into the checkpoint. Once structure, dual size reduction, active requirements, approval provenance, and `key: value` progress checks pass, Weave writes original events to the local archive, verifies host method fingerprints, creates a single-pass hashed backup, and transactionally replaces the visible span. See [Compaction principles and diagrams](docs/en/principles.md) for the full pipeline, budget formulas, archive boundaries, and recovery rules.

## Installation and upgrade

> [!IMPORTANT]
> **Instructions for AI installation assistants & setup agents (mutual exclusion & restart)**
>
> 1. **Check for conflicts first**: Before installing or enabling `dsh-compaction-weave`, inspect whether `billion-context` (or `billion-context-dsh`) is currently installed/enabled, or if any provider `baseUrl` still points to bili's local `127.0.0.1` / `localhost` loopback proxy.
> 2. **Stop and ask the user when both exist**: Both compaction plugins **must never run at the same time**. If `billion-context` is present or active, pause and ask the user which compaction plugin they want to keep rather than enabling both in parallel.
> 3. **Cleanup & migration guidance when keeping Weave**: Disable or uninstall `billion-context`, restore provider `baseUrl` values to the direct upstream endpoints, and tell the user that legacy `billion-context` sessions can be safely backed up and converted afterwards via `/compact migrate` (or the composer card button).
> 4. **Always instruct the user to fully restart DSH**: Even if `billion-context` was just toggled off in the UI, explicitly instruct the user to **fully restart DSH** so stale in-memory hooks (`internal/config`, `agent/pre-step`) and local proxy listeners are cleared before resuming chats.

Supports **DeepSeek Harness `>=0.2.2-rc.1 <1.0.0-0`** (`0.2.x–0.x` from `0.2.2-rc.1`), with native atomic transactions verified against **DSH `0.2.2-rc.1`, `0.2.2-rc.2`, and `0.2.2-rc.3`** on **Node.js 24.9+**, plus graceful fallback (`strictHostFingerprints: false` default) to public `Session.append(replace)` + `sessions.flush()` across minor DSH updates while still blocking unrecovered `.rollback`/`.tail` atomic journals, and `webserver/index-inject` process-level `x-weave-rpc-token` authentication (supporting DSH Desktop `0.2.3-alpha.2+` and enforcing owner-role RPC access). Stable releases are published to **[npm (`latest`)](https://www.npmjs.com/package/dsh-compaction-weave)** and [GitHub Releases](https://github.com/NightFrost42/dsh-compaction-weave/releases/latest): installing `dsh-compaction-weave` from npm is recommended so DSH can track `latest` updates automatically without `allowBuilds` prompts; manual installs using `dsh-compaction-weave.tgz` (versionless latest asset), `dsh-compaction-weave-0.6.0.tgz`, or a locally built `.tgz` remain supported as well.

### Desktop

- **Install from npm / plugin market (recommended for automatic updates)**: install `dsh-compaction-weave` via `dsh-market` (or enter package name `dsh-compaction-weave` under **Plugins → Add plugin**) to track the npm `latest` release channel.
- **Manual `.tgz` install / upgrade**:
  1. Download `dsh-compaction-weave.tgz` or `dsh-compaction-weave-0.6.0.tgz` from [Releases](https://github.com/NightFrost42/dsh-compaction-weave/releases/latest).
  2. When upgrading, uninstall the existing Weave package on the **Plugins** page first while keeping archives and settings in the independent storage directory. Skip this step for a fresh installation.
  3. Open **Plugins → Add plugin**, enter the absolute path to the package (for example `C:/Downloads/dsh-compaction-weave-0.6.0.tgz`), then install and enable it.
  4. **Restart DSH** and verify the version on the plugin details page.

### Command line

Stop the target profile, then install or upgrade from npm (recommended — tracks `latest` and skips `allowBuilds`):

```bash
dsh plugin --profile web add dsh-compaction-weave
```

For offline or manual tarball installation, pass a local `.tgz` path instead:

```bash
dsh plugin --profile web add /absolute/path/dsh-compaction-weave-0.6.0.tgz
```

Replace `web` with your command-line profile name and restart that profile afterwards. Desktop users should follow the plugin manager steps above.

## Quick start

Once enabled, chat normally. By default, Weave uses the active conversation model for summarization and automatically plans compaction as context approaches the trigger threshold (targeting at least a **20%** input reduction on automatic runs).

- **Manual compaction**: Type `/compact` in chat to compact immediately or resume an interrupted compaction/continuation; `/compact resume`, `/compact cancel`, `/compact discard`, and `/compact reset` control breakpoints and breaker counters directly.
- **Live progress & resumable compaction**: While compacting or migrating, a composer-aligned progress card above the input box displays monotonic total progress, active chunk counts, and concurrency, with an immediate **`[Pause]`** button. Pausing or crashing persists checkpoints safely—reopening the session shows **`[Resume]`** / **`[Discard]`**, and sending your next message automatically resumes from the checkpoint without redoing committed chunks.
- **`billion-context` backup & migration**: When foreign `billion-context` folded nodes are detected in a session, the card offers a conditional one-click compatibility migration that snapshots an immutable SHA-256 baseline backup before rolling-wave compaction, with local-timezone snapshot restore built in.
- **Phase wrap-up request**: Ask the model to call `context_compact` after finishing a task phase. The tool returns `queued` to record the request; at the next safe step after the current tool batch finishes, Weave checks context growth and eligible span conditions, then either runs compaction (`compacted`, `partial`, or `failed`) or returns a non-compacting receipt such as `skipped` or `blocked`. Check the follow-up receipt for the outcome.
- **Look up original history**: When you need earlier errors, file paths, or code details verified, ask or prompt the model—it can call these tools on demand to query the local archive:

| Tool | Purpose |
| --- | --- |
| `context_compact` | Queue a compaction request at a task boundary |
| `history_list` | List archived message ranges |
| `history_search` | Search archived history with BM25F multi-field ranking |
| `history_read` | Read original messages and attachments in pages (normalizes `null`/blank strict-tool args) |

## Basic settings

Adjust common options under **Settings → Context Compaction (Weave)** (or on the plugin details page). **Saving applies to subsequent operations without restarting DSH; an in-flight compaction keeps its original settings.**

| Setting | Default | Description |
| --- | --- | --- |
| Summary provider and model | Follow conversation | Leave blank to reuse the active chat model, or configure a dedicated summary model |
| Summary output limit | 8192 tokens | Maximum output length allowed for a single summary response |
| Summary concurrency | 2 | Bounded 1–6 parallel chunk generation & auditing with strictly ordered serial commits and automatic HTTP 429 backoff to `1` |
| Summary reasoning effort | `auto` | Route-aware by default (Anthropic/Claude same-route inherits session reasoning effort to preserve prompt caches; non-Anthropic caps active thinking to `low`; stays off when the session has thinking disabled). Also accepts explicit `low`, `none`, `minimal`, `medium`, `high`, `xhigh`, `max`, or `inherit` with automatic downward fallback |
| Stage-1 observation masking | On | Archive-backed 0-LLM masking of older oversized tool results before LLM summarization during pressure or manual compaction |
| Conservative CJK budget weight | `0.75` | `0.5–1.5`; heuristic tokens-per-char multiplier for CJK/Hangul/Kana budget planning (vs target model BPE). `0.75` keeps prefix KV caching active on 128k Chinese sessions; raise to `1.0` for finer CJK tokenizers |
| Audit coverage scope | `'recent'` | Scopes pure lexical coverage checks to recent retention & new span turns (`'recent'` / `'span-new'` / `'all'`) to avoid legacy migration gridlock while keeping all conflict redlines (`polarity`, values, conditions, provenance) globally enforced |
| Strict retention audit blocking | On | Blocks and regenerates summaries failing retention checks; disabling (`auditBlockOnLoss: false`) logs warnings instead |
| Pressure breaker policy | `confirm` | Controls automatic compaction after repeated failures: block with Retry / 2-step Confirm bypass (`confirm`), warn & bypass under request budget (`degrade`), or strictly block (`block`) |
| Automatic trigger ratio | 80% | Combined with next-reply output reservation and headroom to set the trigger threshold |
| Minimum reduction | 20% | Target input space reduction for automatic compaction planning |
| Retry count | 2 | Up to 2 additional attempts after an initial failure |
| Base retry delay | 1 second | Exponentially backed-off wait between retries (capped at 30 seconds) |
| Per-request timeout | 180 seconds | Timeout limit for each summary request |
| Compact after inactivity | Off | Presets or custom 1–43200 minutes (30 days); compact existing history before resuming after the interval |

Retry settings and output limit overrides (`maxTokens` can also be saved independently without overriding the summary model) take effect across turns; **Clear (follow session model)** clears both the model override and output limit while saving the rest of the hot-applied controls. See [Configuration](docs/en/configuration.md) and [Compaction principles and diagrams](docs/en/principles.md) for prefix preservation, verbatim quote budgets, redacted file re-injection, summary language (`auto` / `zh` / `en`), continuation paging options, and the restrictions when local archiving is disabled (`archiveEnabled: false`).

> **Token estimation & permanent tool-schema footprint**:
> - **Heuristic vs BPE**: Internal planning estimates tokens using a lightweight heuristic (`summaryCjkTokensPerChar` defaulting to `0.75` per CJK char, ~`0.25` per ASCII char) without shipping external BPE tables; actual upstream billing and hard limits follow the target model's BPE tokenizer (raise `summaryCjkTokensPerChar` toward `1.0` in Settings if using finer CJK tokenizers).
> - **Permanent tool schemas**: With archive history tools and proactive compaction enabled, 4 tool definitions accompany requests (`history_list` 271 chars, `history_read` 1,389 chars, `history_search` 385 chars, `context_compact` 513 chars) totaling **2,563 serialized JSON chars / 645 DSH tokens / ~697 BPE tokens** (BPE counts vary by tokenizer; disabling `proactiveEnabled` drops the 513-char `context_compact` definition).

## Coexisting with `dsh-world` & bridge channel isolation

- **Coexisting with `dsh-world` (Issue #4)**: If `dsh-world` is installed with compaction replacement active (`compactionSwapped` / `dsh-world/compaction`), it replaces `@deepseek-ai/dsh-compaction-basic` in the config tree so Weave silently fails to mount. To keep `dsh-world`'s diary, `memory_find`, and memory injection while letting Weave handle compaction:
  - Preset mode: in the World Console, open **概览 → 会话预设 → 还原 DSH 预设** (Overview → Session Presets → Restore DSH Preset);
  - Non-preset mode: set `replaceCompaction: false` in `dsh-world`.
- **Third-party IM bridge & bare injection isolation (Issue #6 / #7A)**: Built-in IM bridge channels (`wechat`, `qq`, `wechat-bridge`, `qq-bridge`, `im-bridge`) and unambiguous multi-line memory headers (such as `===== Long-Term Memory =====`, `===== 长期记忆 =====`, and `【记忆导引】` with body text) are automatically treated as untrusted reference context rather than user constraint sources; for any other custom `source.kind` or bare prefix, add it to `extraReferenceSourceKinds` or `extraReferencePrefixes` (see [Configuration](docs/en/configuration.md)).

## Tests and verification

- **Stable release `0.6.0` offline & dual-host regression (2026-11-25)**:
  - `npm run check`: validated **`288` release files**, syntax, links, secrets, and a **0-cycle ESM DAG across all `91` non-client modules**;
  - `npm test`: **`103` offline unit suites / `1,479` checks passed with 0 failures**;
  - Real DSH host integration: **111 suites / `1,610` checks passed with 0 failures** against both isolated **DSH `0.2.2-rc.1`** and **DSH `0.2.2-rc.3`** on Windows / Node.js `v24.19.0` (covering native `.rollback` transactions, `webserver/index-inject` RPC token & non-owner `403`, unclosed PEM redaction on reinject, strict-tool `null` argument normalization, and multi-worker lock reclamation).

- **Three-system distortion-free live gateway benchmark (`Weave 0.6.0` vs `DSH Basic` vs latest `billion-context@0.0.1328-master.ced22b1`, 2026-11-25, [`docs/benchmarks/v0.6.0-live-three-way.json`](docs/benchmarks/v0.6.0-live-three-way.json))**:
  - Live models run on the active gateway routes: **`Gemini 4 Neon`** (`group/gemini-4-neon`), **`GPT-6.1 Sol`** (`auto/gpt-6.1-sol` with `anyrouter/gpt-6.1-sol` fallback on Codex-only 403 slots), and **`DeepSeek-V4.1-Flash`** (`deepseek/deepseek-flash`); `dsh-basic` used stock `headroomTokens: 65,536`, and `billion-context` ran the latest `0.0.1328-master.ced22b1` release with persistent `x-acp-session` + `ccr: true`.
  - **Suite A · 18 standalone branches** (3 models × 3 systems × [`w1` evolving specs + `w2` heavy tool debugging], 132 checks/system):
    - **`weave-0.6.0`**: **6/6 completed with highest accuracy `131/132 (99.24%)`** — `108/108 (3/3)` on `w1` and **`23/24 (95.83%)`** on `w2` (`Gemini` **`8/8`**, `GPT-6.1 Sol` **`8/8`**, `DeepSeek` **`7/8`**), resolved every `w2` branch in **`75.67 ms`** mean compaction with **`0` summary LLM calls** (`w1` `48.54 s` vs `dsh-basic` `56.29 s`), achieving **`76.07%`** mean reduction at `$1.0200` Magpie / `$0.7632` norm USD;
    - **`dsh-basic`**: `6/6`, **`123/132 (93.18%)`** (`108/108` `w1`, **`15/24 = 62.50%`** `w2` as `ToolResultPruner` drops middle-of-file constants with no archive lookup), `58.91%` mean reduction, `$0.7912` / `$0.6057`;
    - **`billion-context@0.0.1328-master.ced22b1`**: `6/6`, **`114/132 (86.36%)`** (`108/108` `w1`, **`6/24 = 25.00%`** `w2` — `Gemini 3/8`, `DeepSeek 3/8`, `GPT 0/8`), `39,695 ms` mean `w2` compaction wall, only **`3.53%`** mean wire compression (`40.38%` effective), and highest spend (**`$1.1478`** Magpie / **`$0.9989`** norm, `30.9%` costlier than Weave norm).
  - **Suite B · 5 continuous cycles (`C1–C5`) × 6 replies (`R1–R6`) cache recovery & spend (`DeepSeek-V4.1-Flash` & `GPT-6.1 Sol`, 6 trajectories)**: All systems scored `100/100`. On `DeepSeek`, **`weave-0.6.0` achieved `86.59%–95.15%` compaction self-cache (`0%` on `dsh-basic`), `96.41%–98.89%` steady-state recovery, highest overall cache hit `72.11%`, and lowest spend `$0.0410`** (`dsh-basic` `$0.0584` / `52.15%`; `billion-context` `$0.0879` = **`2.15×`** costlier, `252.86 s` compaction = `3.43×` slower, `-34.95%` Cycle 1 bloat). On `GPT-6.1 Sol`, **`weave-0.6.0` delivered highest cache hit `64.48%` and lowest spend `$0.7789` / `$0.3895`** (`dsh-basic` `$0.8315` / `$0.4158`; `billion-context` bloated on **all 5 cycles** `-7.15%..-38.42%` at `926.99 s` e2e and `$1.1885` / `$0.5943` = **`1.53×`** costlier).
  - **Suite C · 15-switch multi-model rotation** (`Gemini 4 Neon → DeepSeek-V4.1-Flash → GPT-6.1 Sol → DeepSeek-V4.1-Flash`, 186 checks): **`weave-0.6.0` passed `4/4` compactions on the first pass, scored `186/186 (100%)`, finished fastest e2e in `275.62 s` (`56.15%–67.72%` wire reduction), and spent the least (`$0.6042` Magpie / `$0.4906` norm)**; `dsh-basic` scored `186/186` (`476.54 s` = `1.73×` slower, no verbatim Section 6 or tool archive, `$0.6482` / `$0.5116`); `billion-context@ced22b1` triggered `15` autonomous compactions, bloated **`-30.97%`** in Gen 1 and **`-8.07%`** in Gen 3, took `415.96 s`, and cost **`$0.8623` / `$0.7139`** (`+42.7%` Magpie / `+45.5%` norm costlier than Weave).

Compaction produces a lossy summary backed by on-demand archive lookup, and input token reduction differs from actual billing changes depending on cache hits, regenerations, and provider pricing. See [Testing](docs/en/testing.md) for full experimental conditions, real-host runtime evaluations, and module navigation.

## Diagnostics and feedback

If you encounter an error, an unexpected summary rejection, or missing context after compaction:

1. Open [GitHub Issues](https://github.com/NightFrost42/dsh-compaction-weave/issues/new/choose), choose the English or Chinese template, and describe the symptom, reproduction steps, and expected behavior.
2. **Log attachments are optional.** Attaching the diagnostic file for the failed operation usually speeds up troubleshooting; diagnostics already record the plugin version, declared DSH version range `supportedDshVersion` (`actualDshVersion` remains `null`, so you can still note your actually installed DSH version in the issue), configured model routes, effective settings, attempts, error categories, and returned usage automatically.
3. **Privacy notice:** Diagnostic logs and linked audit records may contain local paths, conversation text, or business data. Sending original files to a cloud AI is itself an external disclosure, and AI redaction can miss sensitive details or alter evidence. Always review redacted copies yourself before submitting, and omit attachments if unsure. See [Reporting issues and redacting logs](docs/en/feedback.md) for details and the redaction prompt.

## Documentation and development

| English | 简体中文 |
| --- | --- |
| [Configuration](docs/en/configuration.md) | [配置指南](docs/configuration.md) |
| [Compaction principles & diagrams](docs/en/principles.md) | [压缩原理与示意图](docs/principles.md) |
| [Architecture](docs/en/architecture.md) | [代码导航](docs/architecture.md) |
| [Reporting & redaction](docs/en/feedback.md) | [提交问题与日志脱敏](docs/feedback.md) |
| [Troubleshooting](docs/en/troubleshooting.md) | [故障排查](docs/troubleshooting.md) |
| [Testing](docs/en/testing.md) | [测试记录](docs/testing.md) |
| [Development & releases](docs/en/development.md) | [开发与发布](docs/development.md) |

The project uses native JavaScript ES modules with no build step:

```bash
git clone https://github.com/NightFrost42/dsh-compaction-weave.git
cd dsh-compaction-weave
npm test
npm run check
npm run pack:release
```

## License

[MIT](LICENSE)
