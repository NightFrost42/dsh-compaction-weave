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

Long sessions accumulate tool outputs, logs, superseded plans, and repeated discussion. Under the default configuration, DSH Compaction Weave uses a **layered compaction strategy**—handling oversized tool outputs and stale history at zero LLM cost first, summarizing only when needed—to preserve **the current task, active user requirements, completed progress, and the next step**, while archiving original messages and attachments locally for on-demand lookup:

- **Layered compaction & cache friendliness**: Non-error bulky tool results outside the hot region are archived and folded into compact previews with lookup pointers first, skipping LLM calls whenever folding alone meets the target; when summarization is required, stable prefixes and prior checkpoints stay intact, keeping same-route prompt prefixes cache-friendly within budget.
- **Source isolation, redacted re-injection & objective audits**: Uses message roles and explicit quotation tags to tell genuine user instructions apart from logs, fetched pages, and tool outputs; verifies numbers/units, conditions, affirmative/negated polarity, approval provenance, and explicit progress facts after summarization, while skipping sensitive paths and redacting secrets/keys before re-injecting recent workspace files.
- **Resumable progress & lossless local archive lookup**: Splits oversized histories into resumable chunks and continuation pages persisted safely across pauses or crashes; stores replaced originals and images in lossless `zstd` disk archives queryable anytime via built-in lookup tools.

## How compaction works

When context reaches the trigger threshold, resumes after idle time, or receives a compaction request under default archiving, Weave first checks whether zero-LLM folding is enough on its own. Otherwise it selects a tool-balanced span of earlier history, requests a structured candidate summary, and fills recent verbatim user quotes into the checkpoint. Once requirement audits and dual size-reduction checks pass, Weave archives the originals on disk and commits the history replacement transactionally. See [Compaction principles and diagrams](docs/en/principles.md) for the full layered design, budget formulas, and recovery guarantees.

## Installation and upgrade

> [!IMPORTANT]
> **Mutual exclusion & restart notice before installing**
> - Never enable Weave alongside other compaction plugins that rewrite `compaction-basic` or hook a local proxy (such as `billion-context`); see [Configuration](docs/en/configuration.md) and [Troubleshooting](docs/en/troubleshooting.md) for plugin coexistence and external channel isolation.
> - After disabling or switching such plugins (or restoring provider `baseUrl` settings), always perform a **full DSH restart** to clear in-memory hooks and local proxy ports.
> - Existing legacy sessions can be backed up and safely converted afterwards via `/compact migrate`.

Supports **DeepSeek Harness `>=0.2.2-rc.1 <1.0.0-0`** (verified across multiple host releases and Desktop RPC setups on **Node.js 24.9+**). Stable releases are published to **[npm (`latest`)](https://www.npmjs.com/package/dsh-compaction-weave)** and [GitHub Releases](https://github.com/NightFrost42/dsh-compaction-weave/releases/latest): installing `dsh-compaction-weave` from npm is recommended, while manual installs via `dsh-compaction-weave.tgz` (versionless latest asset) or `dsh-compaction-weave-0.6.0.tgz` are also supported.

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

- **Manual compaction**: Type `/compact` in chat to compact immediately or resume an interrupted run, or pass `/compact <focus>` for a one-shot focus instruction; `/compact resume`, `/compact cancel`, `/compact discard`, and `/compact reset` control breakpoints and breaker counters directly.
- **Live progress & resumable compaction**: While compacting or migrating, a composer-aligned progress card above the input box displays monotonic total progress, active chunk counts, and concurrency, with an immediate **`[Pause]`** button. Pausing or crashing persists checkpoints safely—reopening the session shows **`[Resume]`** / **`[Discard]`**, and sending your next message automatically resumes from the checkpoint without redoing committed chunks (pausing cleanly with `CONTINUATION_PENDING_POLICY_CHANGED` for explicit confirmation if compaction policy changed in the meantime so paid pages and call budgets are never silently reset).
- **`billion-context` backup & migration**: When foreign `billion-context` folded nodes are detected in a session, the card offers a conditional one-click compatibility migration that snapshots an immutable SHA-256 baseline backup before rolling-wave compaction, with local-timezone snapshot restore built in.
- **Phase wrap-up request**: Ask the model to call `context_compact` after finishing a task phase. The tool returns `queued` to record the request; at the next safe step after the current tool batch finishes, Weave checks context growth and eligible span conditions, then either runs compaction (`compacted`, `partial`, or `failed`) or returns a non-compacting receipt such as `skipped` or `blocked`. Check the follow-up receipt for the outcome.
- **Look up original history**: When you need earlier errors, file paths, or code details verified, ask or prompt the model—it can call these tools on demand to query the local archive:

| Tool | Purpose |
| --- | --- |
| `context_compact` | Queue a compaction request at a task boundary |
| `history_list` | List archived message ranges |
| `history_search` | Search archived history by relevance |
| `history_read` | Read original messages and attachments in pages |

## Basic settings

Adjust common options under **Settings → Context Compaction (Weave)** (or on the plugin details page). **Saving applies immediately to subsequent operations without restarting DSH; an in-flight compaction keeps its original settings.**

| Setting | Default | Description |
| --- | --- | --- |
| Summary provider and model | Follow conversation | Leave blank to reuse the active chat model, or configure a dedicated summary model |
| Summary output limit | 8192 tokens | Maximum output length allowed for a single summary response |
| Summary concurrency | 2 | Bounded 1–6 parallel chunk generation with ordered serial commit; drops to 1 on HTTP 429 |
| Summary reasoning effort | `auto` | Route-aware by default (Anthropic same-route inherits session thinking for cache reuse; non-Anthropic caps active thinking to `low`; stays off when session thinking is disabled); manual levels also supported |
| Archive observation masking | On | Archive-backed 0-LLM folding of older oversized tool results before summarization, skipping LLM calls if target is met |
| Strict retention audit blocking | On | Retries and blocks summaries dropping active constraints; disabling (`auditBlockOnLoss: false`) relaxes pure coverage losses only, while **polarity reversals, hard value/unit/condition/range conflicts, and untrusted/fake approvals remain blocked** |
| Pressure breaker policy | `confirm` | Controls automatic compaction after repeated failures: Retry / 2-step Confirm bypass (`confirm`), warn & bypass under request budget (`degrade`), or strictly block (`block`) |
| Automatic trigger ratio | 80% | Combined with next-reply output reservation and headroom to set the trigger threshold |
| Minimum reduction | 20% | Target input space reduction for automatic compaction planning |
| Retry count / delay / timeout | 2 / 1 s / 180 s | Exponentially backed-off retries (capped at 30 s) and per-attempt timeout |
| Compact after inactivity | Off | Presets or custom 1–43200 minutes (30 days); runs 0-LLM cleanup and optional idle summary when returning after the gap |

**Clear (follow session model)** clears both the model override and output limit while saving the rest of the hot-applied controls. See [Configuration](docs/en/configuration.md) and [Compaction principles and diagrams](docs/en/principles.md) for layered compaction toggles, file re-injection, image/archive watermarks, CJK budget weights, custom reference channels, `dsh-world` coexistence, and restrictions when local archiving is disabled (`archiveEnabled: false`).

## Tests and verification

`0.6.0` passed all static topology checks (`289` release files / `91` modules, `0`-cycle DAG), offline unit regressions (**104 suites / 1,603 checks**), and isolated dual-host integration suites against **DSH `0.2.2-rc.1` / `0.2.2-rc.3`** (**112 suites / 1,735 checks each**, `0` failures). Live Magpie gateway three-way benchmark summary (`Weave 0.6.0` vs `DSH Basic` vs `billion-context@0.0.1328-master.ced22b1`, raw `2026-11-25` capture preserved at `candidateCommit: 01f6502` in [`docs/benchmarks/v0.6.0-live-three-way.json`](docs/benchmarks/v0.6.0-live-three-way.json)):

| Comparison metric (2026-11-25 Live) | `Weave 0.6.0` | `DSH Basic` | `billion-context@0.0.1328-master.ced22b1` |
| --- | :---: | :---: | :---: |
| **Suite A Overall Accuracy (`w1` + Tool-Heavy `w2`)** | **131/132 (`99.24%`)**<br>(`w2` `23/24`, `0` LLM summary calls) | 123/132 (`93.18%`)<br>(`w2` `15/24`) | 114/132 (`86.36%`)<br>(`w2` `6/24`, GPT `0/8`) |
| **Suite A Reduction, Wall & Spend** | **`76.07%`** eff / wire (6/6)<br>`w2` `75.67 ms` · `$1.0200` / Norm `$0.7632` | **`70.69%`** (5/6 non-null mean; `58.91%` zero-filled)<br>`w2` `8.67 ms` · `$0.7912` / Norm `$0.6057` (`w2` recall loss vs lower spend) | **`4.24%`** wire / `48.45%` eff (5/6 non-null; `3.53%` / `40.38%` zero-filled)<br>`w2` `39,695 ms` · Magpie `+12.53%` / Norm `+30.89%` |
| **Suite B 5-Cycle Cache & Spend** | **`100/100`** · Highest cache hit<br>(DeepSeek **`72.11%`** / GPT **`64.48%`**)<br>Lowest spend **`$0.0410`** / **`$0.7789`** | `100/100` · Mid cache hit<br>(`52.15%` / `57.45%`)<br>`$0.0584` / `$0.8315` | `100/100` · DeepSeek C1 `-34.95%` (recovered `+11.86%..+39.76%` C2–C5); GPT `-38.42%..-7.15%` all C1–C5<br>Costlier **`2.15×`** (`$0.0879`) / **`1.53×`** (`$1.1885`) |
| **Suite C 15-Switch Multi-Model** | **186/186 (`100%`)** · `4/4` compactions (across `6` summary requests: `4/6` succeeded w/ 2 retries)<br>Fastest **`275.62 s`** · Lowest **`$0.6042` / `$0.4906`** | `186/186` (no Sec. 6 quotes/archive)<br>`476.54 s` · `$0.6482` / `$0.5116` | `186/186` · `15` autonomous compactions<br>`415.96 s` · Costlier **`+42.7%`** (`$0.8623` / `$0.7139`) |

Compaction produces a lossy summary backed by on-demand archive lookup, and input token reduction differs from actual billing changes depending on cache hits, retries, pricing basis (both Magpie billed USD and list-normalized Norm USD are shown above), and `null` pre-warm telemetry samples. See [Testing](docs/en/testing.md) for full experimental conditions, real-host runtime evaluations, and module navigation.

> **Bounded scope of regex & heuristic guards**: Credential/PEM redaction (`lib/redact.js`), workspace sensitive-path denylisting (`lib/file-reinject.js`), and deterministic requirement/provenance auditing (`lib/audit/*`) are bounded defenses tuned for common real-world formats and native DSH tool outputs; they do not claim exhaustive coverage of arbitrary custom encodings or arbitrary open-world natural-language paraphrases. See [Architecture](docs/en/architecture.md).

## Diagnostics and feedback

If you encounter an error, an unexpected summary rejection, or missing context after compaction:

1. Open [GitHub Issues](https://github.com/NightFrost42/dsh-compaction-weave/issues/new/choose), choose the English or Chinese template, and describe the symptom, reproduction steps, and expected behavior.
2. **Log attachments are optional.** Attaching the diagnostic file for the failed operation helps speed up triage (if the host version was not recorded automatically, note your actual installed DSH version in the issue).
3. **Privacy notice:** Diagnostic logs and linked audit records may contain local paths or conversation text. Always review redacted copies yourself before submitting, and omit attachments if unsure. See [Reporting issues and redacting logs](docs/en/feedback.md) for privacy guidance and redaction instructions.

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
