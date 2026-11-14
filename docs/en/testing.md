[简体中文](../testing.md) · [English](testing.md)

# DSH Compaction Weave Testing Record (`0.3.2-rc.2`)

This document summarizes the offline and host-integration regressions for `0.3.2-rc.2`, the four-model live cross-switch acceptance run and paired strategy cost evaluation conducted during candidate development, and the historical test records and formulas from `0.3.2-rc.1` and `0.3.1-review.35`.

---

## 1. Overview of Test Conditions

Testing across development and release verification covered offline synthetic streams, isolated DSH host integration, and live model gateway calls. The code baseline, runtime environment, and machine-readable evidence for each batch are listed below:

| Test batch | Code or package version | Platform & runtime | Host & model conditions | Scale & outcome | Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Windows full regression** | `0.3.2-rc.2` | Windows `win32` · Node.js `v24.21.0` | Isolated DSH `0.2.2-rc.1` host + synthetic streams | **55 suites, 1,690 checks** (50 offline suites / 1,597 checks + 5 host suites / 93 checks), **0 failures** | [../test-results.json](../test-results.json) |
| **Linux offline regression** | `0.3.2-rc.2` | Linux `linux` · Node.js `v24.9.0` | Offline synthetic streams & fault injection | **50 suites, 1,597 checks**, **0 failures** | [../benchmarks/rc2-linux-tests.json](../benchmarks/rc2-linux-tests.json) |
| **Four-model live cross-switch acceptance** | Internal package `0.3.2-rc.1` (before removing legacy continuation command and adding diagnostic fields) | Windows · live gateway calls | `Gemini 4 Argon` → `GLM` → `DeepSeek` → `GPT` | 4 compactions (1 summary call each), 24 model switches, 60 HTTP requests; **728 / 728** state fields and **77 / 77** structure checks passed | [../benchmarks/rc2-live-and-cost.json](../benchmarks/rc2-live-and-cost.json) |
| **Four-model paired strategy & cost evaluation** | `0.3.2-rc.2` candidate development branches | Live gateway calls · 10 matched branch pairs | `DeepSeek`, `GLM`, `GPT`, `Gemini` | Baseline vs. experimental partial consolidation across compaction + 6 follow-up replies; independent audit of **678** raw HTTP attempts and **677** `usage` records with **0** discrepancies | [../benchmarks/rc2-live-and-cost.json](../benchmarks/rc2-live-and-cost.json) |
| **`0.3.2-rc.1` preflight regression (historical)** | `0.3.2-rc.1` | Windows `win32` · Node.js `v24.19.0` | Isolated DSH `0.2.2-rc.1` host + synthetic streams | **50 suites, 1,359 checks** (45 offline suites / 1,266 checks + 5 host suites / 93 checks), **0 failures** | [../benchmarks/published-0.3.2-rc.1-tests.json](../benchmarks/published-0.3.2-rc.1-tests.json) |
| **`0.3.1-review.35` live compaction experiment (historical)** | `0.3.1-review.35` | Official `DeepSeek V4.1 Flash` API · 90 requests | 4 successful compactions (3 incremental + 1 consolidation) | Equal-weight mean input reduction **68.50%**, incremental Gen 1–3 mean **58.71%**, weighted reduction **70.20%** | [../benchmarks/review35-compression.json](../benchmarks/review35-compression.json) |

---

## 2. `0.3.2-rc.2` Regression Suites and Four-Model Live Acceptance

### 2.1 Offline and Host Integration Regression

Building on the 50 suites from `0.3.2-rc.1`, `0.3.2-rc.2` adds regression coverage for requirement lifecycles, coordinated negation scope, superseded historical progress snapshots, progress source compatibility, and failure diagnostic whitelisting:

- **Windows full regression**: Executed on Node.js `v24.21.0` with DSH `0.2.2-rc.1`, passing **55 suites and 1,690 checks with 0 failures**. This comprises 50 offline unit suites (1,597 checks) and 5 DSH host integration suites (93 checks: `host/capacity-regressions.mjs` 29, `host/independent.mjs` 58, `host/native-cache-test.mjs` 4, `host/native-host.mjs` 1, and `host/native-proactive.mjs` 1). Suite-level results are recorded in [../test-results.json](../test-results.json).
- **Linux offline regression**: Executed on Node.js `v24.9.0`, passing **50 suites and 1,597 checks with 0 failures**, recorded in [../benchmarks/rc2-linux-tests.json](../benchmarks/rc2-linux-tests.json).
- **Replay of historical false-rejection samples**: Candidate summaries that previously triggered false rejections—such as intermediate progress counts (`19/23`) superseded by final completion (`23/23`), or affirmative requirements paired with explicit exclusion clauses—now pass validation without redundant regenerations while genuine polarity flips and progress contradictions remain blocked.

### 2.2 Four-Model Live Cross-Switch Acceptance

Prior to removing the legacy `/context-continue` command registration and adding the new diagnostic metadata fields, a live cross-provider acceptance run was executed using internal package `0.3.2-rc.1`. A single long session was compacted and continued across **Gemini 4 Argon → GLM → DeepSeek → GPT**, as recorded in [../benchmarks/rc2-live-and-cost.json](../benchmarks/rc2-live-and-cost.json):

- Completed **4 compactions**, each passing structure, size-reduction, requirement, and progress audits on the **first summary request** without regeneration retries;
- Completed **24 model switches** and **60 HTTP requests** while maintaining consistent checkpoints and archive lookups across providers;
- Passed **728 / 728** session and archive state field assertions and **77 / 77** workflow and surface structure checks.

---

## 3. Paired Cache and Consolidation Strategy Cost Evaluation

### 3.1 Experimental Design and Accounting Method

To determine whether Weave should switch to an experimental partial-consolidation policy (Candidate) when hitting checkpoint or space limits or retain the existing incremental-plus-full-consolidation policy (Baseline), paired development branches starting from identical conversation states were run across `DeepSeek`, `GLM`, `GPT`, and `Gemini`. Each branch executed **compaction (`summary`)** followed by **6 consecutive follow-up replies (`sixReplies`)**.

Cost accounting followed these rules:

1. **Included requests**: Summary generation requests, feedback-driven regenerations triggered by content, nine-section structure, format, semantic, or audit false-rejection issues (including attempts in branches that ultimately failed content validation), and the 6 post-compaction assistant replies.
2. **Excluded failures**: Network interruptions, provider server errors, rate limits (HTTP 429), timeouts, and mid-stream disconnects are tracked separately and excluded from strategy cost comparisons.
3. **Unit rate calculation**: `DeepSeek`, `GPT`, and `Gemini` USD figures are estimated from the gateway unit rates recorded during testing and the token `usage` returned by each request (`recorded-gateway-rate-estimate`). `GLM` ran under a free token quota without verifying applicable GLM contract unit prices; its USD figures are modeled by applying DeepSeek gateway unit rates to GLM's returned token `usage` as a **proxy-rate cost scenario (`deepseek-proxy-rate-scenario`)**.
4. **Matched-pair accounting**: `DeepSeek` and `GPT` completed all 3 paired branches (`matchedPairs = 3`). On `GLM` and `Gemini`, Baseline completed 3 branches whereas Candidate had 1 branch terminate after repeated content validation failures, yielding `matchedPairs = 2`. The "Matched delta" column compares only completed matched pairs and does not mix in uncompleted branch spend (`contentFailedSpend`).
5. **Independent recalculation**: An independent audit of all **678** raw HTTP attempts and **677** returned `usage` records confirmed **0** discrepancies in dollar amounts or failure categories. Full token breakdowns are available in [../benchmarks/rc2-live-and-cost.json](../benchmarks/rc2-live-and-cost.json).

### 3.2 Four-Model Paired Cost Summary Table

| Model | Matched pairs | Baseline matched cost | Candidate matched cost | Matched delta | Candidate uncompleted content-failure spend |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **DeepSeek** | 3 | `$0.031691832` | `$0.030309330` | `-4.36%` | `$0` |
| **GLM** (proxy-rate scenario) | 2 | `$0.021538548` | `$0.028403982` | `+31.88%` | `$0.017583060` |
| **GPT** | 3 | `$0.24170450` | `$0.23862275` | `-1.28%` | `$0` |
| **Gemini** | 2 | `$0.2185486` | `$0.2823570` | `+29.20%` | `$0.1911960` |

**Conclusion**: Experimental partial consolidation produced only minor matched-pair savings on `DeepSeek` (`-4.36%`) and `GPT` (`-1.28%`), while substantially increasing summary regeneration and follow-up costs on `GLM` (`+31.88%` under the proxy-rate scenario) and `Gemini` (`+29.20%`), alongside 1 uncompleted content-failure branch on both `GLM` (`$0.017583060`) and `Gemini` (`$0.1911960`). Consequently, `0.3.2-rc.2` retains the existing incremental-plus-full-consolidation default policy and does not send post-compaction cache prewarming requests.

<details>
<summary>Expand for stage-level costs, completed branch counts, and HTTP attempt breakdown</summary>

Detailed token counts (`inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`) and `unknownCosts` (`0` across all recorded entries) are stored in [../benchmarks/rc2-live-and-cost.json](../benchmarks/rc2-live-and-cost.json).

| Model & arm | Scope | Completed branches | HTTP attempts | Cost (USD) |
| :--- | :--- | :---: | :---: | :---: |
| **DeepSeek · Baseline** | `summary` | — | 3 | `$0.028614900` |
| **DeepSeek · Baseline** | `sixReplies` | — | 18 | `$0.003076932` |
| **DeepSeek · Baseline** | `matchedTotal` | 3 | 21 | `$0.031691832` |
| **DeepSeek · Baseline** | `allAttempts` | 3 | 21 | `$0.031691832` |
| **DeepSeek · Candidate** | `summary` | — | 4 | `$0.027003546` |
| **DeepSeek · Candidate** | `sixReplies` | — | 18 | `$0.003305784` |
| **DeepSeek · Candidate** | `matchedTotal` | 3 | 22 | `$0.030309330` |
| **DeepSeek · Candidate** | `allAttempts` | 3 | 22 | `$0.030309330` |
| **GLM · Baseline** (proxy rate) | `summary` | — | 2 | `$0.017680518` |
| **GLM · Baseline** (proxy rate) | `sixReplies` | — | 12 | `$0.003858030` |
| **GLM · Baseline** (proxy rate) | `matchedTotal` | 2 | 14 | `$0.021538548` |
| **GLM · Baseline** (proxy rate) | `allAttempts` | 3 | 22 | `$0.040645980` |
| **GLM · Candidate** (proxy rate) | `summary` | — | 3 | `$0.025145022` |
| **GLM · Candidate** (proxy rate) | `sixReplies` | — | 12 | `$0.003258960` |
| **GLM · Candidate** (proxy rate) | `matchedTotal` | 2 | 15 | `$0.028403982` |
| **GLM · Candidate** (proxy rate) | `contentFailedSpend` | 0 | 3 | `$0.017583060` |
| **GLM · Candidate** (proxy rate) | `allAttempts` | 2 | 18 | `$0.045987042` |
| **GPT · Baseline** | `summary` | — | 3 | `$0.21601400` |
| **GPT · Baseline** | `sixReplies` | — | 18 | `$0.02569050` |
| **GPT · Baseline** | `matchedTotal` | 3 | 21 | `$0.24170450` |
| **GPT · Baseline** | `allAttempts` | 3 | 21 | `$0.24170450` |
| **GPT · Candidate** | `summary` | — | 3 | `$0.20204525` |
| **GPT · Candidate** | `sixReplies` | — | 18 | `$0.03657750` |
| **GPT · Candidate** | `matchedTotal` | 3 | 21 | `$0.23862275` |
| **GPT · Candidate** | `allAttempts` | 3 | 21 | `$0.23862275` |
| **Gemini · Baseline** | `summary` | — | 2 | `$0.1337640` |
| **Gemini · Baseline** | `sixReplies` | — | 12 | `$0.0847846` |
| **Gemini · Baseline** | `matchedTotal` | 2 | 14 | `$0.2185486` |
| **Gemini · Baseline** | `allAttempts` | 3 | 22 | `$0.3931174` |
| **Gemini · Candidate** | `summary` | — | 3 | `$0.1888180` |
| **Gemini · Candidate** | `sixReplies` | — | 12 | `$0.0935390` |
| **Gemini · Candidate** | `matchedTotal` | 2 | 15 | `$0.2823570` |
| **Gemini · Candidate** | `contentFailedSpend` | 0 | 3 | `$0.1911960` |
| **Gemini · Candidate** | `allAttempts` | 2 | 18 | `$0.4735530` |

</details>

### 3.3 Experimental Scope and Limitations

When interpreting the live acceptance and paired cost datasets, note the following scope boundaries:

- **Version attribution of live runs**: The four-model cross-switch acceptance test ran on internal package `0.3.2-rc.1` prior to removing `/context-continue` and adding the new diagnostic metadata fields, and the paired cost experiment compared candidate development branches. Neither dataset should be read as a post-freeze live package verification of the final `0.3.2-rc.2` tarball.
- **Invoice and pricing scope**: `DeepSeek`, `GPT`, and `Gemini` costs are gateway-rate estimates derived from returned `usage` without provider invoice reconciliation. `GLM` has its own billing schedule; its dollar figures and the `+31.88%` delta belong strictly to the proxy-rate cost scenario simulated with DeepSeek gateway unit rates, not actual paid invoices or official GLM list prices.
- **Unmatched branch counts in `allAttempts`**: On `GLM` and `Gemini`, Baseline completed 3 branches while Candidate completed 2; therefore, `allAttempts` totals reflect different numbers of completed branches (3 vs. 2) and cannot be compared directly as equal-output totals.
- **Control arm scope**: The paired experiment compared two compaction consolidation strategies across compaction plus 6 follow-up replies and did not include an uncompacted 6-reply live control arm.

---

## 4. Usage Representation and Host Version Fields in Diagnostics

In test ledgers and failure diagnostics, Weave records missing usage measurements and host versions according to these rules:

- **Missing usage representation**: When a request does not report `usage`, or when a request fails (`streamFailure` or an `error` / `aborted` terminal state) and the adapter returns an all-zero `usage` object, the measurement is treated as unknown and represented in JSON via `usage: null`, omitted fields, or `usageKnown: false` rather than a fixed `"unknown"` string. Successful responses with genuine zero or positive usage preserve their reported values.
- **Host version fields**: The diagnostic environment block records `supportedDshVersion: "0.2.2-rc.1"` and sets `actualDshVersion: null`, indicating that the running host version was not reliably collected; issue reports still require the user to supply the running DSH version manually.

---

## 5. Historical Test Records (`0.3.2-rc.1` and `0.3.1-review.35`)

### 5.1 Published Version: `0.3.2-rc.1`

On November 11, 2026, the preflight regression for `0.3.2-rc.1` passed **50 suites with 1,359 checks and 0 failures** on Windows (`win32`), Node.js `v24.19.0`, and DSH `0.2.2-rc.1`. Per-suite results and code SHA-256 hashes are archived in [../benchmarks/published-0.3.2-rc.1-tests.json](../benchmarks/published-0.3.2-rc.1-tests.json).

| Validation | Result |
| :--- | ---: |
| Offline regression and semantic checks | 45 suites / 1,266 checks |
| DSH host integration | 5 suites / 93 checks |
| New progress expressions and full-summary replays | 47 / 47 |
| New negated-requirement checks | 12 / 12 |
| Original-source identity snapshots | 16 / 16 unchanged |
| Package server entry points and preset barriers | 3 entries / 4 presets |

These targeted checks are included in the 1,359-check total. They distinguish reporting verbs from artifact completion, missing evidence from completion claims, unknown requirements from unknown status or cross-batch uncertainty, and future actions from current values, while verifying contradictions after contrast clauses, explicit assignments, negated modification constraints, and source identity hashes. Seven complete summaries previously returned by the official service and falsely rejected were replayed offline without making new model requests.

### 5.2 Official API Multi-Turn Experiment: `0.3.1-review.35`

The **68.50%** mean input reduction cited in earlier documentation originates from the **`0.3.1-review.35`** multi-turn experiment on the official `DeepSeek V4.1 Flash` API (not a `0.3.2-rc.1` package test). Per-compaction token counts, formulas, and the source ledger CSV checksum (SHA-256 `46319cddf905f9bed3ebda2ec44f0cbe305ce2bfac1386a2e52bfc16176e3df2`) are archived in [../benchmarks/review35-compression.json](../benchmarks/review35-compression.json).

The experiment recorded 90 model requests, all returning HTTP 200 and `usage`. Because requests shared an account cache and the intended isolation marker did not reach the final request payload, these measurements represent a warm-cache run where existing prefix caches could be reused rather than an isolated cold-cache comparison.

- **Equal-weight mean input reduction (4 successful compactions)**: **68.50%** (`68.5046%`), with **31.50%** (`31.4954%`) retained on average; the 3 incremental compactions averaged a **58.71%** (`58.7083%`) reduction, and the single consolidation reduced input by **97.89%** (`97.8936%`).
- **Volume-weighted input reduction**: Across the 4 samples, total input fell from `332,270` to `99,019` tokens, a **70.20%** (`70.1992%`) reduction. This metric measures main-conversation input before and after successful compaction; summary generation and retry usage are accounted for separately.

<details>
<summary>Expand for 0.3.1-review.35 formulas, cache recovery, task continuity, and failure records</summary>

#### 1. Per-Compaction Token Data and Formulas

Per-compaction reduction, equal-weight mean reduction, and volume-weighted reduction are defined as:

$$\text{inputReductionPercent}_i = 100 \times \frac{\text{before}_i - \text{after}_i}{\text{before}_i}, \quad \text{inputRetainedPercent}_i = 100 - \text{inputReductionPercent}_i$$

$$\text{meanInputReductionPercent} = \frac{1}{N} \sum_{i=1}^{N} \text{inputReductionPercent}_i, \quad \text{weightedInputReductionPercent} = 100 \times \frac{\sum_{i=1}^{N} \text{before}_i - \sum_{i=1}^{N} \text{after}_i}{\sum_{i=1}^{N} \text{before}_i}$$

Before counts use the second warm-up request with identical input; after counts use the first main-conversation request after compaction, both taken from total input tokens in the official SSE `usage`:

| Compaction | Mode | Before input (`inputTokens`) | After input (`inputTokens`) | Input reduction |
| :---: | :--- | ---: | ---: | ---: |
| 1 | `incremental` | 58,838 | 19,778 | 66.39% |
| 2 | `incremental` | 78,559 | 32,242 | 58.96% |
| 3 | `incremental` | 91,046 | 44,812 | 50.78% |
| 4 | `consolidation` | 103,827 | 2,187 | 97.89% |
| **Total / Mean** | **3 incremental + 1 consolidation** | **332,270** | **99,019** | **Mean 68.50% / Weighted 70.20%** |

Per-compaction cache-read, uncached, and input-retention breakdowns are recorded in [`benchmarks/review35-compression.json`](../benchmarks/review35-compression.json).

#### 2. Cache Recovery Across Replies

Cache hit rate is `cacheReadTokens / inputTokens` as reported by the service:

| Compaction | Mode | Before | Reply 1 | Reply 6 |
| :---: | :--- | ---: | ---: | ---: |
| 1 | Incremental | 99.64% | 36.24% | 98.31% |
| 2 | Incremental | 99.72% | 42.48% | 99.11% |
| 3 | Incremental | 99.82% | 58.27% | 99.20% |
| 4 | Consolidation | 99.86% | 0.00% | 91.13% |

All three incremental compactions recovered above a 98% cache hit rate by Reply 6. Consolidation reduced input from `103,827` to `2,187` tokens (`97.89%`) and rebuilt the prefix cache from `0.00%`; by Reply 24 after consolidation, the cache hit rate reached **96.08%** (`8,926` input tokens: `8,576` cached and `350` uncached).

#### 3. Requirement and Task Continuity

| Check | Result |
| :--- | ---: |
| 16 replies before compaction, 14 fields each | 224 / 224 |
| 42 replies after successful compactions, 14 fields each | 588 / 588 |
| Task-continuation pairs | 120 / 120 |
| "Continue" probes | 8 / 8 |
| Path retrieval after connecting history tools | 8 / 8 |

The 42 post-compaction replies consist of 6 replies after each of the 4 compactions plus 18 additional replies after consolidation. Path retrieval with connected history tools used 5 model requests and 8 tool calls; an earlier probe without connected tools returned tool-call text instead of the expected JSON once.

#### 4. Failures and Root-Cause Fixes

During that experiment, the first independent run stopped at Compaction 1 after exhausting 3 summary attempts. The second run completed Compactions 1–4 and stopped at Compaction 5 after 3 attempts; Compaction 6 was not executed. Both failures preserved original events and the visible message surface while emitting diagnostics.

Accordingly, `0.3.1-review.35` did not pass continuous-compaction stability acceptance. Investigation showed that candidate-summary semantic misclassification—rather than API transport failure—was the primary cause, and those real samples were incorporated into the regression suite. Recorded cumulative usage for the run was `3,290,387` input tokens (`2,723,200` cached and `567,187` uncached) and `53,081` output tokens, with 13 summary requests (including 5 extra retries; separate pages within a single consolidation count as requests rather than failed retries).

</details>

---

## 6. Running Tests Locally and Source Navigation

Run the offline regression suite and static checks from the repository root:

```bash
npm test
npm run check
```

Core modules under `lib/` corresponding to the compaction pipeline, cache policy, auditing, and diagnostics:

- Main compaction pipeline and outcome reporting: [../../lib/engine.js](../../lib/engine.js)
- Cache-prefix preservation policy and span selection: [../../lib/cache-policy.js](../../lib/cache-policy.js), [../../lib/region.js](../../lib/region.js)
- Requirement alignment auditing, negation scope, and progress fact validation: [../../lib/audit.js](../../lib/audit.js), [../../lib/constraint-scope.js](../../lib/constraint-scope.js), [../../lib/progress-facts.js](../../lib/progress-facts.js)
- Deterministic requirement reconstruction and requirement lifecycle tracking: [../../lib/reconstruct.js](../../lib/reconstruct.js), [../../lib/memory-policy.js](../../lib/memory-policy.js)
- Backend continuation paging, call budgets, and progress ledgers: [../../lib/continuation.js](../../lib/continuation.js), [../../lib/continuation-budget.js](../../lib/continuation-budget.js), [../../lib/continuation-progress.js](../../lib/continuation-progress.js)
- Local message archive, attachment storage, and transactional commit: [../../lib/history.js](../../lib/history.js), [../../lib/attachments.js](../../lib/attachments.js), [../../lib/transaction.js](../../lib/transaction.js)
- Failure diagnostic metadata whitelist and audit rejection records: [../../lib/failure-diagnostics.js](../../lib/failure-diagnostics.js), [../../lib/audit-reject.js](../../lib/audit-reject.js)
