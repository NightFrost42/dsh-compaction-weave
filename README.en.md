<div align="center">

# DSH Compaction Weave

**Compact context. Keep requirements. Carry work forward.**

A context-compaction plugin for DeepSeek Harness that keeps long conversations focused on the current goal, active constraints, and the next step.

[简体中文](README.md) · [English](README.en.md)

[![Release](https://img.shields.io/github/v/release/NightFrost42/dsh-compaction-weave?style=flat-square&color=5865F2)](https://github.com/NightFrost42/dsh-compaction-weave/releases/latest)
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

- **Two-stage compaction & same-route prefix reuse**: Non-error tool outputs longer than `4000` characters outside the recent tail are archived and folded into compact head/tail previews with `history_read` pointers first, skipping LLM calls whenever folding alone meets the target. When summarization is required, stable prefixes and prior checkpoints stay intact, and same-model requests keep the live prefix unchanged within budget to stay KV-cache friendly.
- **Channel isolation & requirement/progress checks**: Uses host event roles and explicit tags (`<untrusted_reference>`, `<quoted_text>`) to tell genuine user instructions apart from logs, fetched pages, and tool outputs, while independently checking numbers, conditions, prohibitions, approval provenance, target scopes, and explicit `key: value` progress fields.
- **Resumable paging and direct archive lookup**: Splits oversized histories into resumable pages persisted on disk; standard checkpoints carry `History archive` pointers and touched file paths for targeted queries via `history_list`, multi-term `history_search`, and `history_read`.

## How compaction works

When context reaches the trigger threshold, resumes after idle time, or receives a compaction request under default archiving, Weave first checks whether folding bulky older tool outputs is enough on its own. Otherwise it selects a tool-balanced span of earlier history, requests a structured candidate summary, and deterministically fills bounded recent verbatim user quotes into the checkpoint. Once structure, dual size reduction, active requirements, approval provenance, and `key: value` progress checks pass, Weave writes original events to the local archive, verifies host method fingerprints, creates a single-pass hashed backup, and transactionally replaces the visible span. See [Compaction principles and diagrams](docs/en/principles.md) for the full pipeline, budget formulas, archive boundaries, and recovery rules.

## Installation and upgrade

Supports **DeepSeek Harness `>=0.2.2-rc.1 <1.0.0-0`** (`0.2.x–0.x` from `0.2.2-rc.1`), with native atomic transactions verified against **DSH `0.2.2-rc.1`, `0.2.2-rc.2`, and `0.2.2-rc.3`** on **Node.js 24.9+**, plus graceful fallback (`strictHostFingerprints: false` default) to public `Session.append(replace)` + `sessions.flush()` across minor DSH updates while still blocking unrecovered `.rollback`/`.tail` atomic journals. The examples below use stable release `0.3.3`; download `dsh-compaction-weave.tgz` (versionless latest asset) or `dsh-compaction-weave-0.3.3.tgz` from [Releases](https://github.com/NightFrost42/dsh-compaction-weave/releases/latest), or build a local `.tgz` package.

### Desktop

1. Obtain `dsh-compaction-weave.tgz` or `dsh-compaction-weave-0.3.3.tgz`.
2. When upgrading, uninstall the existing Weave package on the **Plugins** page first while keeping archives and settings in the independent storage directory. Skip this step for a fresh installation.
3. Open **Plugins → Add plugin**, enter the absolute path to the package (for example `C:/Downloads/dsh-compaction-weave-0.3.3.tgz`), then install and enable it.
4. **Restart DSH** and verify the version on the plugin details page.

### Command line

Stop the target profile, then install or upgrade the package:

```bash
dsh plugin --profile web add /absolute/path/dsh-compaction-weave-0.3.3.tgz
```

Replace `web` with your command-line profile name and restart that profile afterwards. Desktop users should follow the plugin manager steps above.

## Quick start

Once enabled, chat normally. By default, Weave uses the active conversation model for summarization and automatically plans compaction as context approaches the trigger threshold (targeting at least a **20%** input reduction on automatic runs).

- **Manual compaction**: Type `/compact` in chat to compact immediately or resume a paused multi-page continuation.
- **Phase wrap-up request**: Ask the model to call `context_compact` after finishing a task phase. The tool returns `queued` to record the request; at the next safe step after the current tool batch finishes, Weave checks context growth and eligible span conditions, then either runs compaction (`compacted`, `partial`, or `failed`) or returns a non-compacting receipt such as `skipped` or `blocked`. Check the follow-up receipt for the outcome.
- **Look up original history**: When you need earlier errors, file paths, or code details verified, ask or prompt the model—it can call these tools on demand to query the local archive:

| Tool | Purpose |
| --- | --- |
| `context_compact` | Queue a compaction request at a task boundary |
| `history_list` | List archived message ranges |
| `history_search` | Search archived history by keyword |
| `history_read` | Read original messages and attachments in pages |

## Basic settings

Adjust common options under **Settings → Summary model** (or on the plugin details page). **Saving applies to subsequent operations without restarting DSH; an in-flight compaction keeps its original settings.**

| Setting | Default | Description |
| --- | --- | --- |
| Summary provider and model | Follow conversation | Leave blank to reuse the active chat model, or configure a dedicated summary model |
| Summary output limit | 8192 tokens | Maximum output length allowed for a single summary response |
| Automatic trigger ratio | 80% | Combined with next-reply output reservation and headroom to set the trigger threshold |
| Minimum reduction | 20% | Target input space reduction for automatic compaction planning |
| Retry count | 2 | Up to 2 additional attempts after an initial failure |
| Base retry delay | 1 second | Exponentially backed-off wait between retries (capped at 30 seconds) |
| Per-request timeout | 180 seconds | Timeout limit for each summary request |
| Compact after inactivity | Off | Presets or custom 1–43200 minutes (30 days); compact existing history before resuming after the interval |

Retry settings take effect independently of summary model selection. See [Configuration](docs/en/configuration.md) and [Compaction principles and diagrams](docs/en/principles.md) for prefix preservation, verbatim quote budgets, summary language (`auto` / `zh` / `en`), continuation paging options, and the restrictions when local archiving is disabled (`archiveEnabled: false`).

## Tests and verification

- **Stable release `0.3.2` (after the 2026-11-19 host-compatibility relaxation, two-stage compaction, channel-isolation refactor, JSON-wrapper unwrapping, and billing-safety stress tests)**: **51 active suites / 1,059 checks passed with 0 failures** against DSH `0.2.2-rc.3` on Windows (**44 offline suites / 941 checks** including 20 checks in `astra-review-fixes.mjs` and 9 billing/entry checks in `release-billing-safety.mjs`, plus **7 real-host integration suites / 118 checks** covering `strictHostFingerprints: false` graceful fallback and atomic journal refusal); in paired benchmarks against `v0.3.2-rc.4` (`a41b41a`), heavy tool-output compaction cut summary LLM calls from `1` to `0` (`7,329.35 ms → 19.36 ms`), same-route verbatim KV prefix preservation rose from `60%` (`654 B`) to `100%` (`12,215 B`), structured `key: value` validation sped up ~`108×` (`1.08 ms → 0.01 ms`), native `2.1 MB` host transaction commit sped up `14.2%`, and runtime `lib/` bytes dropped `2.66%` (`748,804 → 728,876 B`) — see [Per-suite results and improvement benchmark](docs/benchmarks/v0.3.2-tests.json). 21 legacy synthetic-vocabulary and natural-language regex suites remain archived under [`test/archived-regex/`](test/archived-regex/README.md) outside default runs, and the pre-archive baseline (67 suites / 2,064 checks) stays recorded in [Per-suite baseline results](docs/benchmarks/rc4-tests.json).

- **Four-model × four-system distortion-free live gateway benchmark (2026-11-19 single-run observations, [`docs/benchmarks/v0.3.2-live-four-way.json`](docs/benchmarks/v0.3.2-live-four-way.json))**: Restored stock `dsh-basic` `headroomTokens: 65,536` (`CHAT_MAX_TOKENS=16384`), persistent `x-acp-session` + `ccr` + `<acp-nudge>` for `billion-context@0.1.216`, non-repetitive per-phase Node.js/SQL modules, and explicit `null` allowance for unverified fields. Because `auto/gpt-6-astra` only permits official Codex CLI clients directly (`HTTP 403` on plain DSH HTTP requests; used natively inside Codex MCP for code and benchmark audits, with no client spoofing), the DSH GPT slot ran `2-2/gpt-6.1-sol` in Suite A and `auto/gpt-6.1-sol` in Suite C alongside `auto/gemini-4-argon`, `auto/glm-5.3-flash`, and `deepseek/deepseek-flash`:
  - **Suite A · Standalone 32 branches** (4 models × 4 systems × `w1` evolving specs + `w2` tool-heavy debugging): **`weave-0.3.2` completed 8/8 with highest accuracy `175/176 (99.43%)`** — `144/144` on `w1` (`26.88 s` mean compaction vs `56.81 s` for `dsh-basic`, **`2.11×` faster**) and `31/32` on `w2` in **`35.8 ms`** (**`0` summary LLM calls**, `72.20%` mean effective/wire reduction, `$1.0821` Magpie / `$0.8539` norm); `rc.4` completed `5/8` (`3/4` `w1` branches failed `PROGRESS_FACT_CONFLICT`; `62/68 = 91.18%` conditional on completed, `62/176 = 35.23%` overall); `dsh-basic` finished `8/8` (`164/176 = 93.18%`) but fell to **`20/32 (62.50%)`** on `w2` (`ToolResultPruner` drops middle-of-file constants with no archive lookup); `billion-context` finished `8/8` at **`155/176 (88.07%)`** (`w2` **`11/32 = 34.38%`**, `0/8` on GPT & DeepSeek) with **`-13.95%` local wire bloat** at `$1.6899` / `$1.3999`.
  - **Suite B · 5 continuous cycles (`C1–C5`) × 6 replies (`R1–R6`) cache recovery & speed**: Separates first post-compaction prefix write (`R1`: `0%` consolidation / `~33%` incremental) from steady-state recovery: **`weave-0.3.2` recovered KV cache hits to `97%–99%` across `R2–R6` through all 5 cycles on DeepSeek and GLM**, while hitting cache on compaction calls themselves (`85.94%–95.52%` DeepSeek, `37.68%–65.37%` GLM vs `0%` on `dsh-basic`). On DeepSeek: `100/100`, `45.99 s` compaction (`2.77×` faster than `rc.4`, `3.78×` vs `billion-context`), `$0.0419` (`billion-context` dropped to `88/100` with `-27.75%..-189.07%` bloat). On GLM: `100/100`, **`107.65 s` compaction (`4.01×` faster than `dsh-basic` `431.44 s`; `3.27×` vs `billion-context` `351.90 s`; `2.83×` faster e2e; `rc.4` failed)**.
  - **Suite C · Continuous 19-switch rotation** (`Gemini → GLM → DeepSeek → auto/gpt-6.1-sol`, 226 checks): **`weave-0.3.2` passed 4/4 compactions on the first attempt (`4` calls, `0` retries), scored `226/226 (100%)` in `114.86 s` compaction (`400.74 s` e2e), `60.00%` mean wire reduction (`$0.6077` / `$0.4915`)**; `rc.4` failed Gen 4 GPT (`3/4`, `7` calls, `224.45 s` comp, `226/226` only because Gen 4 stayed uncompressed `-0.64%`); text-only `dsh-basic` scored `4/4` (`226/226`, `118.40 s` comp / `327.88 s` e2e, `$0.5935` / `$0.4811`, without verbatim Section 6 or tool archive); `billion-context` ran `15` compaction calls and `48` HTTP calls (`875.97 s` e2e = `2.19×` slower), expanded `-36.31%` in Gen 1, and cost `$0.8260` / `$0.6873`.

- **Offline and host regression**: `0.3.2-rc.3` passed **56 suites with 1,698 checks** (**50 offline suites with 1,597 checks** plus **6 real-host integration suites with 101 checks**, including 8 new checks for native transactional commit/rollback, range admission, and unknown-method refusal) on Windows (Node.js 24.21.0 with DSH `0.2.2-rc.1` and `0.2.2-rc.3`) and on Linux (Node.js 24.9.0 with DSH `0.2.2-rc.2` and `0.2.2-rc.3`), all with 0 failures; see [`docs/benchmarks/rc3-host-compatibility.json`](docs/benchmarks/rc3-host-compatibility.json).
- **Four-model live cross-switch acceptance**: Live testing on the internal `0.3.2-rc.1` build prior to removing the legacy manual continuation command and adding diagnostic metadata covered **Gemini 4 Argon → GLM → DeepSeek → GPT**, completing 4 compactions (1 summary call each), 24 model switches, and 60 HTTP requests with **728 / 728** state fields and **77 / 77** workflow and structure checks passing.
- **Strategy and cost evaluation**: Paired experiments compared the existing incremental and full-consolidation policy against an experimental partial-consolidation candidate across compaction and 6 follow-up replies, counting content and false-rejection regenerations while excluding network and provider request failures. The existing policy proved more consistent across models and remains the default, without post-compaction prewarming.

Compaction produces a lossy summary backed by on-demand archive lookup, and input token reduction differs from actual billing changes depending on cache hits, regenerations, and provider pricing. See [Testing](docs/en/testing.md) for full experimental conditions, the GLM proxy-rate cost scenario, and historical records.

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
