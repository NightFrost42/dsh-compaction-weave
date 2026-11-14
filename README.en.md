<div align="center">

# DSH Compaction Weave

**Compact context. Keep requirements. Carry work forward.**

A context-compaction plugin for DeepSeek Harness that keeps long conversations focused on the current goal, active constraints, and the next step.

[简体中文](README.md) · [English](README.en.md)

[![Release](https://img.shields.io/github/v/release/NightFrost42/dsh-compaction-weave?include_prereleases&style=flat-square&color=5865F2)](https://github.com/NightFrost42/dsh-compaction-weave/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/NightFrost42/dsh-compaction-weave/ci.yml?style=flat-square)](https://github.com/NightFrost42/dsh-compaction-weave/actions/workflows/ci.yml)
[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-4D6BFE?style=flat-square)](docs/en/configuration.md)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524.9-339933?style=flat-square&logo=node.js&logoColor=white)](docs/en/development.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-22A06B?style=flat-square)](LICENSE)
[![Languages](https://img.shields.io/badge/docs-English%20%7C%20%E4%B8%AD%E6%96%87-0F766E?style=flat-square)](README.md)

Incremental compaction · Requirement retention · History lookup · Audit checks · Diagnostics

[Install & upgrade](#installation-and-upgrade) · [Quick start](#quick-start) · [Principles](docs/en/principles.md) · [Basic settings](#basic-settings) · [Tests & verification](#tests-and-verification) · [Diagnostics & feedback](#diagnostics-and-feedback) · [Changelog](CHANGELOG.md)

</div>

## Why Weave?

Long sessions accumulate tool outputs, logs, superseded plans, and repeated discussion. Under the default configuration, DSH Compaction Weave condenses earlier history into structured checkpoints that preserve **the current task, active user requirements, completed progress, and the next step**, while archiving original messages and attachments locally for on-demand lookup.

- **Incremental compaction**: Keep stable prefixes and existing checkpoints intact while compacting new history. Full consolidation runs only when the checkpoint limit is reached, an earlier requirement is revised, or more space is needed.
- **Requirement and progress checks**: Independently verify numbers, conditions, prohibitions, target scopes, and task progress. This release fixes reproduced false rejections around superseded snapshots and coordinated negation while continuing to block genuine conflicts.
- **Resumable paging and archive lookup**: Split oversized histories into pages, persist completed pages on disk, and query original messages or attachments on demand when details are needed.

## How compaction works

When context approaches the trigger threshold or a compaction request is issued, Weave selects a tool-balanced span of earlier history, generates a structured candidate summary, and deterministically fills bounded recent verbatim user quotes into the checkpoint. With local archiving enabled by default, once the candidate passes structure, size-reduction, requirement, and progress checks, Weave writes the original events to the local archive and transactionally replaces the visible history span; later, the model can call archive lookup tools on demand when earlier details need verification. See [Compaction principles and diagrams](docs/en/principles.md) for the full pipeline, budget formulas, archive toggle boundaries, and recovery rules.

## Installation and upgrade

Built for **DeepSeek Harness 0.2.2-rc.1** on **Node.js 24.9+**. The examples below use `0.3.2-rc.2`; download the release asset from [Releases](https://github.com/NightFrost42/dsh-compaction-weave/releases) or build a local `.tgz` package.

### Desktop

1. Obtain `dsh-compaction-weave-0.3.2-rc.2.tgz`.
2. When upgrading, uninstall the existing Weave package on the **Plugins** page first while keeping archives and settings in the independent storage directory. Skip this step for a fresh installation.
3. Open **Plugins → Add plugin**, enter the absolute path to the package (for example `C:/Downloads/dsh-compaction-weave-0.3.2-rc.2.tgz`), then install and enable it.
4. **Restart DSH** and verify the version on the plugin details page.

### Command line

Stop the target profile, then install or upgrade the package:

```bash
dsh plugin --profile web add /absolute/path/dsh-compaction-weave-0.3.2-rc.2.tgz
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

Adjust common options under **Settings → Summary model** (or on the plugin details page). **Restart DSH after saving.**

| Setting | Default | Description |
| --- | --- | --- |
| Summary provider and model | Follow conversation | Leave blank to reuse the active chat model, or configure a dedicated summary model |
| Summary output limit | 8192 tokens | Maximum output length allowed for a single summary response |
| Automatic trigger ratio | 80% | Combined with next-reply output reservation and headroom to set the trigger threshold |
| Minimum reduction | 20% | Target input space reduction for automatic compaction planning |
| Retry count | 2 | Up to 2 additional attempts after an initial failure |
| Base retry delay | 1 second | Exponentially backed-off wait between retries (capped at 30 seconds) |
| Per-request timeout | 180 seconds | Timeout limit for each summary request |

Retry settings take effect independently of summary model selection. See [Configuration](docs/en/configuration.md) and [Compaction principles and diagrams](docs/en/principles.md) for prefix preservation, verbatim quote budgets, summary language (`auto` / `zh` / `en`), continuation paging options, and the restrictions when local archiving is disabled (`archiveEnabled: false`).

## Tests and verification

- **Offline and host regression**: `0.3.2-rc.2` passed **55 suites with 1,690 checks** (including DSH host integration) on Windows (Node.js 24.21.0, DSH 0.2.2-rc.1) and **50 suites with 1,597 checks** in Linux offline regression (Node.js 24.9.0), with 0 failures.
- **Four-model live cross-switch acceptance**: Live testing on the internal `0.3.2-rc.1` build prior to removing the legacy manual continuation command and adding diagnostic metadata covered **Gemini 4 Argon → GLM → DeepSeek → GPT**, completing 4 compactions (1 summary call each), 24 model switches, and 60 HTTP requests with **728 / 728** state fields and **77 / 77** workflow and structure checks passing.
- **Strategy and cost evaluation**: Paired experiments compared the existing incremental and full-consolidation policy against an experimental partial-consolidation candidate across compaction and 6 follow-up replies, counting content and false-rejection regenerations while excluding network and provider request failures. The existing policy proved more consistent across models and remains the default, without post-compaction prewarming.

Compaction produces a lossy summary backed by on-demand archive lookup, and input token reduction differs from actual billing changes depending on cache hits, regenerations, and provider pricing. See [Testing](docs/en/testing.md) for full experimental conditions, the GLM proxy-rate cost scenario, and historical records.

## Diagnostics and feedback

If you encounter an error, an unexpected summary rejection, or missing context after compaction:

1. Open [GitHub Issues](https://github.com/NightFrost42/dsh-compaction-weave/issues/new/choose), choose the English or Chinese template, and describe the symptom, reproduction steps, and expected behavior.
2. **Log attachments are optional.** Attaching the diagnostic file for the failed operation usually speeds up troubleshooting; diagnostics already record the plugin version, target DSH version (you can still note your actually installed DSH version in the issue), configured model routes, effective settings, attempts, error categories, and returned usage automatically.
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
