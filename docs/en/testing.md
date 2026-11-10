# Testing

[简体中文](../testing.md) · [English](testing.md)

## Current candidate: 0.3.2-rc.1

On November 11, 2026, the complete publication preflight passed **50 suites with 1359 checks and no failures**, using Windows, Node.js 24.19.0, and DSH 0.2.2-rc.1.

| Validation | Result |
| --- | ---: |
| Offline regression and semantic checks | 45 suites / 1266 checks |
| DSH host integration | 5 suites / 93 checks |
| New progress expressions and full-summary replays | 47 / 47 |
| New negated-requirement checks | 12 / 12 |
| Original-source identity snapshots | 16 / 16 unchanged |
| Package server entry points and preset barriers | 3 entries / 4 presets |

The added cases are included in the 1359-check total. Per-suite results and validated code hashes are in [test-results.json](../test-results.json).

Regression cases distinguish reporting verbs from artifact completion, missing evidence from completion claims, unknown requirements from unknown status, future actions from current values, and cross-batch uncertainty from measured counts. Contradictions after a contrast or explicit assignment remain checked.

Seven complete summaries returned by the official service and previously rejected incorrectly are replayed offline. The network measurements below belong to the earlier `review.35` build.

## Official API experiment: review.35

The experiment used DeepSeek V4.1 Flash and recorded 90 model requests. All returned HTTP 200 and usage. Requests shared an account cache; the intended isolation marker did not reach the final request, so these results describe a warm-cache experiment rather than an isolated cold-cache comparison.

### Average compression result

**Across 4 successful compactions, input fell by an average of 68.50%, with 31.50% retained.** The 3 incremental compactions averaged a 58.71% reduction; the single consolidation reduced input by 97.89%.

| Compaction | Mode | Input tokens before | Input tokens after | Input reduction | Input retained |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Incremental | 58,838 | 19,778 | 66.39% | 33.61% |
| 2 | Incremental | 78,559 | 32,242 | 58.96% | 41.04% |
| 3 | Incremental | 91,046 | 44,812 | 50.78% | 49.22% |
| 4 | Consolidation | 103,827 | 2,187 | 97.89% | 2.11% |

Each reduction is `(input before - input after) / input before`. The headline takes the arithmetic mean of the 4 unrounded percentages and rounds the result to two decimal places. Before counts come from the second warm-up request with identical input; after counts come from the first main-conversation request after compaction. All counts use total input tokens reported in the official SSE usage.

Weighted by input volume, the four samples total **332,270 → 99,019 tokens**, a **70.20%** reduction. The README uses the equally weighted **68.50%** mean. This metric measures main-conversation input changes after successful compaction; summary-generation and retry usage are accounted for separately. Failed compactions are recorded below.

See the [compression measurement data](../benchmarks/review35-compression.json) for per-compaction token counts, formulas, and source-ledger checksums.

### Cache recovery

Hit rate is cached input tokens divided by total input tokens, using the service's usage fields.

| Compaction | Mode | Before | Reply 1 | Reply 6 |
| --- | --- | ---: | ---: | ---: |
| 1 | Incremental | 99.64% | 36.24% | 98.31% |
| 2 | Incremental | 99.72% | 42.48% | 99.11% |
| 3 | Incremental | 99.82% | 58.27% | 99.20% |
| 4 | Consolidation | 99.86% | 0.00% | 91.13% |

Observation continued to reply 24 after consolidation: **96.08%**, with 8926 input tokens, 8576 cached and 350 uncached. That consolidation reduced input from 103827 to 2187 tokens, a **97.89% reduction**.

All three incremental generations recovered above 98% by reply 6. Consolidation rebuilt the prefix cache over a longer sequence of replies.

### Requirement and task continuity

| Check | Result |
| --- | ---: |
| 16 replies before compaction, 14 fields each | 224 / 224 |
| 42 replies after successful compactions, 14 fields each | 588 / 588 |
| Task-continuation pairs | 120 / 120 |
| “Continue” probes | 8 / 8 |
| Path retrieval after connecting history tools | 8 / 8 |

The 42 replies comprise six replies after each of four successful compactions, plus eighteen additional replies after consolidation. Path retrieval with history tools used five model requests and eight tool calls. An earlier probe without connected tools returned tool-call text instead of the expected JSON once.

### Failures and fixes

The first independent run stopped at compaction 1 after three failed summary attempts. The second completed compactions 1–4, then stopped at compaction 5 after three attempts; compaction 6 was not executed. Both failures preserved original events and the visible message surface and produced diagnostics.

That `review.35` run therefore did not pass continuous-compaction stability acceptance. Candidate-summary misclassification was the main identified cause, rather than API request failure. Its actual samples now form part of the current regression suite.

Total usage was 3,290,387 input tokens: 2,723,200 cached and 567,187 uncached, plus 53,081 output tokens. There were 13 summary requests, including 5 extra retries. Separate pages of one consolidation count as requests, not failed retries.

## Reproduce the checks

```bash
npm test
npm run test:host
npm run check
npm run pack:release
```

See [Development](development.md) for host dependency configuration. New live experiments should assert that their unique marker exists in the actual outgoing request and retain per-request input, cache, output, and generation data.
