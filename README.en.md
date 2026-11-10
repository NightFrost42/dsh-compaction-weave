<div align="center">

# DSH Compaction Weave

**Compact context. Keep requirements. Carry work forward.**

A context-compaction plugin for DeepSeek Harness that keeps long conversations focused on the goal, current progress, and the next step.

[简体中文](README.md) · [English](README.en.md)

[![Release](https://img.shields.io/github/v/release/NightFrost42/dsh-compaction-weave?include_prereleases&style=flat-square&color=5865F2)](https://github.com/NightFrost42/dsh-compaction-weave/releases)
[![CI](https://github.com/NightFrost42/dsh-compaction-weave/actions/workflows/ci.yml/badge.svg)](https://github.com/NightFrost42/dsh-compaction-weave/actions/workflows/ci.yml)
[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-4D6BFE?style=flat-square)](docs/en/configuration.md)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524.9-339933?style=flat-square&logo=node.js&logoColor=white)](docs/en/development.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-22A06B?style=flat-square)](LICENSE)
[![Languages](https://img.shields.io/badge/docs-English%20%7C%20%E4%B8%AD%E6%96%87-0F766E?style=flat-square)](README.md)

Incremental compaction · Prefix reuse · Requirement retention · History lookup · Automatic retries

[Install](#installation) · [Quick start](#quick-start) · [Configuration](docs/en/configuration.md) · [Test results](docs/en/testing.md) · [Changelog](CHANGELOG.md)

</div>

## Why Weave?

Long tasks accumulate logs, tool output, old plans, and repeated messages. Weave turns that history into context you can keep working from: **what you are doing, which requirements still apply, what has been completed, and what comes next.**

Existing summaries and stable prefixes are preserved where possible. New history is compacted as it grows, and checkpoints are consolidated when more space is needed. Original details stay available in a searchable archive.

## Features

| Feature | What it does |
| --- | --- |
| 🧩 **Incremental compaction** | Keeps existing prefixes where possible while checking that compaction frees useful space |
| 📌 **Requirement retention** | Checks values, conditions, prohibitions, and scope; applies explicit revisions and cancellations |
| 🧭 **Progress continuity** | Carries recent work reports and evidence locations forward, distinguishing current state from history and plans |
| 🧹 **Low-information pruning** | Removes standalone “continue” messages, repetition, and retired requirements; budgets recent verbatim messages |
| 🔎 **History lookup** | Archives original messages and attachments for keyword, sequence, and range-based retrieval |
| 📚 **Resumable pages** | Summarizes large histories in pages, saving accepted work for later retries |
| 🔁 **Automatic retries** | Retries timeouts, interrupted streams, and rejected summaries, then reports the cause and diagnostic location |
| 🌐 **Chinese and English** | Localized settings, READMEs, and guides; automatic or explicitly selected summary language |

## Installation

For **DeepSeek Harness 0.2.2-rc.1**, using **Node.js 24.9+**.

### Desktop

1. Download the [plugin package](https://github.com/NightFrost42/dsh-compaction-weave/releases/download/v0.3.2-rc.1/dsh-compaction-weave-0.3.2-rc.1.tgz).
2. Open **Plugins → Add plugin** in the DSH sidebar.
3. Enter its absolute path, such as `C:/Downloads/dsh-compaction-weave-0.3.2-rc.1.tgz`.
4. Install and enable the plugin, then restart DSH.

### Command line

Install into the profile you use, for example `web`:

```bash
dsh plugin --profile web add https://github.com/NightFrost42/dsh-compaction-weave/releases/download/v0.3.2-rc.1/dsh-compaction-weave-0.3.2-rc.1.tgz
```

Replace `web` with your profile name, then restart that profile. You can also replace the URL with the package's absolute local path.

[All versions and release assets →](https://github.com/NightFrost42/dsh-compaction-weave/releases)

## Quick start

Keep chatting after installation. Weave uses the current conversation model by default and automatically compacts history as the context approaches its threshold.

### Compact manually

```text
/compact
```

### Wrap up a task phase

```text
This phase is complete. Organize the current progress, active requirements,
and remaining tasks before continuing to the next phase.
```

The model can request compaction with `context_compact`. Weave waits for the current tool batch to finish, processes the request, and returns the outcome.

### Recover an earlier detail

```text
Find the original error from the earlier test and the relevant file location.
```

| Tool | Purpose |
| --- | --- |
| `context_compact` | Request compaction at a task boundary |
| `history_list` | List archived history ranges |
| `history_search` | Search archived history by keyword |
| `history_read` | Read original messages and attachments in pages |

## How compaction and caching work together

```text
Before:       Existing notes + Stable prefix + New history + Recent conversation
                                             ↓ Compact incrementally
After:        Existing notes + Stable prefix + New notes   + Recent conversation
                                             ↓ Consolidate when needed
Consolidated: Merged notes                                 + Recent conversation
```

Incremental compaction preserves existing content so the service can reuse its cached prefix. When the checkpoint limit is reached, earlier requirements change, or more space is needed, Weave consolidates the notes and resumes incremental compaction.

Defaults allow up to **4 summary checkpoints** and target at least a **20% input reduction** per automatic compaction.

## Requirements evolve with the task

```text
“Set the test timeout to 35 seconds” → “Change it to 55 seconds”
                          Keep the current value: 55 seconds

“Generate and upload the report”    → “Cancel the upload; keep it local”
                          Keep: generate the local report

“Continue”                         → No long-term verbatim budget used
```

Recent user quotes default to at most **32 messages and approximately 4096 tokens**. Active requirements are checked separately, while original details remain retrievable. Requirements for production, test environments, and different files retain their respective scopes.

## Settings

Open **Settings → Summary model**, or open the configuration from the plugin details.

| Setting | Default | Purpose |
| --- | --- | --- |
| Summary provider and model | Follow the conversation | Choose a dedicated summarization model |
| Summary output limit | 8192 tokens | Allocate generation capacity |
| Automatic trigger ratio | 80% | Choose when to start compaction |
| Minimum reduction | 20% | Set the space-saving target |
| Retry count | 2 | Allow up to 2 additional attempts after the first |
| Base retry delay | 1 second | Increase the wait after consecutive failures |
| Per-request timeout | 180 seconds | Bound each summary request's wait |

**Restart DSH after saving.** Retry settings can be configured independently; leaving the model selection empty follows the conversation model.

See [Configuration](docs/en/configuration.md) for prefix preservation, quote budgets, summary language, and paging settings.

## Tests and measurements

Release candidate `0.3.2-rc.1` passed **50 local suites with 1359 checks**, covering offline logic and DSH host integration. This includes replaying 7 real rejected summaries and checking 16 original-source identity snapshots.

The latest official-API experiment used `review.35` and DeepSeek V4.1 Flash. **Across 4 successful compactions, input fell by an average of 68.50%, with 31.50% retained.** The sample contains 3 incremental compactions and 1 consolidation; the average is the arithmetic mean of the per-compaction reductions.

| Observation | Recorded result |
| --- | --- |
| Average input reduction / retained proportion | **68.50% / 31.50%** (4 successful compactions) |
| Cache hit rate on reply 6 after three incremental compactions | 98.31% / 99.11% / 99.20% |
| Cache hit rate on reply 24 after consolidation | 96.08% |
| Input reduction in one consolidation | 103827 → 2187 tokens; 97.89% reduction |
| 42 replies after successful compactions | 588 / 588 checked fields correct |

Summary misclassifications found during that run are covered by the current fixes and regression suite. See [Testing](docs/en/testing.md) for measurement details, failure records, and full results.

## Report a problem

If you encounter **errors, degraded answer quality, or forgotten requirements, progress, or task details after compaction**, please [open an Issue](https://github.com/NightFrost42/dsh-compaction-weave/issues/new/choose). Reports in English and Chinese are welcome.

Include the plugin and DSH versions, conversation and summary models, reproduction steps, and expected versus actual behavior. For quality or memory issues, include the relevant conversation excerpts from before and after compaction. For errors, attach the error code and diagnostic file shown in the conversation; see [Troubleshooting](docs/en/troubleshooting.md) for locations. Remove credentials and private information before posting.

## Documentation

| English | 简体中文 |
| --- | --- |
| [Configuration](docs/en/configuration.md) | [配置指南](docs/configuration.md) |
| [Architecture](docs/en/architecture.md) | [工作原理](docs/architecture.md) |
| [Troubleshooting](docs/en/troubleshooting.md) | [故障排查](docs/troubleshooting.md) |
| [Testing](docs/en/testing.md) | [测试记录](docs/testing.md) |
| [Development & releases](docs/en/development.md) | [开发与发布](docs/development.md) |

## Development and contributions

The project uses JavaScript ES modules directly. No compilation step is needed.

```bash
git clone https://github.com/NightFrost42/dsh-compaction-weave.git
cd dsh-compaction-weave
npm test
npm run check
npm run pack:release
```

Test reports go to `.local/`; release artifacts go to `dist/`. GitHub Actions runs offline tests, project checks, and packaging checks on Windows and Linux.

[Issues](https://github.com/NightFrost42/dsh-compaction-weave/issues) and pull requests are welcome. Include reproduction steps, error codes, and the relevant diagnostic details when reporting a problem.

## License

[MIT](LICENSE)
