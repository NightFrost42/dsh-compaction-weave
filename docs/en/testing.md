[简体中文](../testing.md) · [English](testing.md)

# DSH Compaction Weave Testing Record (`0.6.0`)

## 0.6.0 Stable Release Validation & Live Three-Way Comparison (2026-11-25)

Under Windows / Node.js `v24.19.0`, `0.6.0` completes the 6-layer acyclic `lib/audit/` split, 8-domain `lib/engine/` modularization, pure-JS BM25F multi-field archive search (`history-search.js`), lossless Node.js 24 `zstd` archiving and storage governance, deterministic relative date grounding, Tier-4 salient prose previews, workspace file re-injection credential/unclosed-PEM redaction (`+4 KiB` bounded lookahead), `auditCoverageScope: 'recent'` (with conflict redlines globally enforced), DSH Desktop `0.2.3-alpha.2+` `webserver/index-inject` random token + non-owner `403` enforcement, `threadId` + `(dev, ino)` multi-worker lock reclamation, and `history_read` normalization of `null`/blank optional arguments under strict tool-calling schemas:

| Verification gate | Scope & conditions | Result | Reference |
| --- | --- | --- | --- |
| **Static & DAG topology (`npm run check`)** | `288` release files, package `0.6.0`, syntax, links, install examples, secrets, and module DAG | **91 non-client ESM modules, 0 cycles passed** | [../../scripts/check.mjs](../../scripts/check.mjs) |
| **Offline unit suites (`npm test`)** | Separate child processes + isolated temp `DSH_HOME` | **103 suites, 1,481 checks passed, 0 failures** | [../../test/v060-audit-hardening.mjs](../../test/v060-audit-hardening.mjs) |
| **DSH `0.2.2-rc.1` host integration** | Real DSH `Session`, capacity, multi-gen prefix cache, and native `.rollback` transactions | **111 suites, 1,612 checks passed, 0 failures** | — |
| **DSH `0.2.2-rc.3` host integration** | Real DSH `Session`, capacity, multi-gen prefix cache, and native `.rollback` transactions | **111 suites, 1,612 checks passed, 0 failures** | — |
| **Clean release packaging (`npm run pack:release`)** | Generates `dist/dsh-compaction-weave-0.6.0.tgz`, `dsh-compaction-weave.tgz`, source tarball, and `SHA256SUMS.txt` | Payload matches `package.json.files` whitelist cleanly | [../../scripts/release.mjs](../../scripts/release.mjs) |

---

### Three-System Distortion-Free Live Gateway Comparison (`Weave 0.6.0` vs `dsh-basic` vs latest `billion-context`, 2026-11-25 Single-Run Observations)

To measure real-world accuracy, compression, multi-cycle KV cache recovery, compaction wall time, and API spend fairly without artificial caps or header distortion, we benchmarked **3 systems** side-by-side over the local Magpie gateway:
1. **`weave-0.6.0`**: Default `0.6.0` configuration (Stage-1 local observation masking, Tier-4 previews, BM25F archive search, `auditCoverageScope: 'recent'`, redacted file re-injection).
2. **`dsh-basic`**: DSH `0.2.2-rc.3` built-in `BasicCompactionEngine` + `ToolResultPruner` with full stock `headroomTokens: 65,536` and `CHAT_MAX_TOKENS=16384`.
3. **`billion-context` (`0.0.1328-master.ced22b1`)**: Latest npm master build at benchmark time, mounted behind a persistent header-injecting hop attaching `x-acp-session` across turns and model switches with `ccr: true` and natural `<acp-nudge>` autonomous compression.

- **Live model routes**: **`Gemini 4 Neon`** (`group/gemini-4-neon`), **`GPT-6.1 Sol`** (`auto/gpt-6.1-sol` with per-branch sticky failover to `anyrouter/gpt-6.1-sol` on Codex-only HTTP 403 slots), and **`DeepSeek-V4.1-Flash`** (`deepseek/deepseek-flash`, fallback `auto/deepseek-v4.1-flash-1017`). All three systems received identical visible prompts, JSON schemas, and retry allowances.
- **Metric definitions**: **Effective reduction** computes `(rawBaselineBeforeInput - afterFirstCompactionInput) / rawBaselineBeforeInput` against unmodified `weave-0.6.0` inputs; **wire reduction** computes `(observedBeforeInput - afterFirstCompactionInput) / observedBeforeInput` (negative values denote net token bloat). Both Magpie catalog USD and unified Normalized reference USD are reported. Full machine-readable evidence is recorded in [../benchmarks/v0.6.0-live-three-way.json](../benchmarks/v0.6.0-live-three-way.json).

#### A. Standalone Single-Model Matrix (18 Branches = 3 Models × 3 Systems × 2 Workloads; 132 Checks/System)

- `w1-engineering-spec`: Multi-turn evolving engineering spec and anti-trap check (`36` checks: `14` post-compaction recall + `5` trap defense + `3` JSONL manifest + `14` final recall).
- `w2-repo-debug`: Eight ~23 KB source-file reads + crash log failure debugging (`8` checks: project rules, `failedCommandPid: 48210`, and middle-of-file constants `src/storage/sqlite-pool.js` / `busyTimeoutMs=4750` / `SQLITE_BUSY_SNAPSHOT_517`).

| System | Completed | Overall Accuracy | `w1` Spec Evolution | `w2` Tool-Heavy Debug | Mean Eff / Wire Reduction | Mean `w1` / `w2` Comp Wall Ms | Mean Summary Calls | Total Spend (Magpie / Norm USD) | Key Takeaways |
| :--- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| **`weave-0.6.0`** | **6 / 6** | **131 / 132 (99.24%)** | **108 / 108** (`3/3`) | **23 / 24 (95.83%)** (`3/3`) | **`76.07%` / `76.07%`** | `48,537 ms` / **`75.67 ms`** | **`0.50`** (`0` on `w2`) | `$1.0200` / `$0.7632` | Highest overall & `w2` accuracy (`Gemini 8/8`, `GPT 8/8`, `DeepSeek 7/8`) with **`0` LLM summary calls** on `w2` |
| **`dsh-basic`** | 6 / 6 | 123 / 132 (93.18%) | **108 / 108** (`3/3`) | 15 / 24 (62.50%) (`3/3`) | `58.91%` / `58.91%` | `56,292 ms` / `8.67 ms` | `0.83` | `$0.7912` / `$0.6057` | `w1` passed at full budget, but `ToolResultPruner` head/tail slicing drops middle constants (`3/3` missed `4750` / `517`) |
| **`billion-context@ced22b1`** | 6 / 6 | 114 / 132 (86.36%) | **108 / 108** (`3/3`) | **6 / 24 (25.00%)** (`gpt` **0/8**) | `40.38%` / **`3.53%`** | `33,996 ms` / **`39,695 ms`** | `0.50` | **`$1.1478`** / **`$0.9989`** | `w1` passed cleanly, but `w2` collapsed (`Gemini 3/8`, `DeepSeek 3/8`, `GPT 0/8`), wire reduction was **`3.53%`**, and norm spend was `30.9%` above Weave |

<details>
<summary>Expand per-branch breakdown across all 18 standalone runs</summary>

| Model | System | `w1` Acc | `w1` Eff / Wire | `w1` Comp/E2E ms · Calls · R2→R6 Cache · Magpie USD | `w2` Acc | `w2` Eff / Wire | `w2` Comp/E2E ms · R2 Cache · Magpie USD |
| :--- | :--- | ---: | ---: | :--- | ---: | ---: | :--- |
| `Gemini 4 Neon` | **`weave-0.6.0`** | **36/36** | 84.67% / 84.67% | `77,881 / 896,952` · 1 · 46.69%→55.82% · `$0.3133` | **8/8** | 43.24% / 43.24% | **`140`** `/ 90,086` · 57.89% · `$0.1636` |
| `Gemini 4 Neon` | `dsh-basic` | 36/36 | 87.64% / 87.64% | `59,996 / 558,985` · 1 · 27.31%→23.21% · `$0.2654` | 6/8 | 30.51% / 30.51% | `9 / 54,435` · 86.45% · `$0.1336` |
| `Gemini 4 Neon` | `billion-context` | 36/36 | 39.63% / 6.52% | `70,973 / 207,921` · 1 · 0%→0% · `$0.4430` | 3/8 | 29.31% / 0.89% | `41,334 / 333,358` · 61.02% · `$0.3827` |
| `GPT-6.1 Sol` | **`weave-0.6.0`** | **36/36** | 86.08% / 86.08% | `43,545 / 103,080` · 1 · 92.79%→94.42% · `$0.1514` | **8/8** | 77.50% / 77.50% | **`29`** `/ 62,680` · 28.28% · `$0.3623` |
| `GPT-6.1 Sol` | `dsh-basic` | 36/36 | — / — | `90,768 / 441,418` · 3 · 0%→79.31% · `$0.1979` | 5/8 | 71.75% / 71.75% | `9 / 60,895` · 98.76% · `$0.1731` |
| `GPT-6.1 Sol` | `billion-context` | 36/36 | — / — | `19,492 / 129,929` · 1 · 97.47%→97.96% · `$0.1582` | 0/8 | 68.83% / 0.61% | `50,896 / 149,620` · 99.11% · `$0.1396` |
| `DeepSeek-V4.1-Flash` | **`weave-0.6.0`** | **36/36** | 87.55% / 87.55% | `24,184 / 121,838` · 1 · 90.08%→89.75% · `$0.0106` | **7/8** | 77.39% / 77.39% | **`58`** `/ 14,349` · 29.04% · `$0.0188` |
| `DeepSeek-V4.1-Flash` | `dsh-basic` | 36/36 | 91.95% / 91.94% | `18,113 / 122,009` · 1 · 85.33%→87.07% · `$0.0100` | 4/8 | 71.62% / 71.62% | `8 / 65,485` · 98.25% · `$0.0112` |
| `DeepSeek-V4.1-Flash` | `billion-context` | 36/36 | 36.17% / 12.66% | `11,524 / 122,491` · 1 · 97.56%→96.37% · `$0.0112` | 3/8 | 68.31% / 0.50% | `26,856 / 129,801` · 98.42% · `$0.0131` |

*(Note: `beforeInputTokens` / compression ratios on `gpt/dsh-basic/w1` and `gpt/billion-context/w1` were recorded as `null` in the summary JSON because the `before-warm` hook telemetry was unavailable before compaction.)*

</details>

#### B. Continuous 5-Compaction (`C1–C5`) × 6-Reply (`R1–R6`) KV Cache Recovery & Spend

Running 5 consecutive compactions followed by 6 replies per cycle (`6` long trajectories = `30` compactions + `180` follow-up replies) on `DeepSeek-V4.1-Flash` and `GPT-6.1 Sol`:

| Model / System | Accuracy | Comp Wall / End-to-End Wall | Comp Self-Cache (`C1–C5`) | `R2` Recovery (`C1–C5`) | `R6` Steady State (`C1–C5`) | Wire Reduction (`C1–C5`) | Total Cache Hit | Total Spend (Magpie / Norm USD) |
| :--- | :---: | ---: | :--- | :--- | :--- | :--- | ---: | ---: |
| `DeepSeek` / **`weave-0.6.0`** | **100/100** | `73,653 ms` / **`293,672 ms`** | **`95.15, 91.77, 88.42, 86.75, 86.59%`** | **`98.36%–98.89%`** | `96.41%–98.05%` | `69.30, 61.97, 56.03, 55.46, 56.03%` | **`72.11%`** | **`$0.0410` / `$0.0410`** |
| `DeepSeek` / `dsh-basic` | 100/100 | `70,201 ms` / `405,394 ms` | `0, 0, 0, 0, 0%` | `97.97%–98.58%` | `95.87%–98.12%` | `71.04, 71.40, 65.37, 65.91, 57.87%` | `52.15%` | `$0.0584` / `$0.0584` (**+42.6%**) |
| `DeepSeek` / `billion-context@ced22b1` | 100/100 | `252,862 ms` (`3.43×` slower) / `549,326 ms` | — | `57.35%–98.19%` | `94.49%–98.22%` | **`-34.95%`**, `39.76, 11.86, 37.62, 38.31%` | `66.69%` | **`$0.0879`** / `$0.0879` (**2.15×**) |
| `GPT-6.1 Sol` / **`weave-0.6.0`** | **100/100** | `204,608 ms` / `635,044 ms` | **`0, 45.76, 57.66, 58.22, 58.96%`** | **`98.76%–99.09%`** | **`98.35%–98.66%`** | `68.25, 62.04, 53.73, 53.02, 53.30%` | **`64.48%`** | **`$0.7789` / `$0.3895`** |
| `GPT-6.1 Sol` / `dsh-basic` | 100/100 | `194,252 ms` / `596,156 ms` | `0, 39.28, 48.44, 49.98, 50.26%` | `98.61%–98.94%` | `97.99%–98.46%` | `69.86, 70.47, 64.96, 65.09, 64.96%` | `57.45%` | `$0.8315` / `$0.4158` |
| `GPT-6.1 Sol` / `billion-context@ced22b1` | 100/100 | `260,591 ms` / **`926,991 ms`** | — | `20.97%–25.92%` | `97.16%–98.18%` | **`-38.42, -7.15, -7.89, -7.91, -8.67%`** | `49.27%` | **`$1.1885` / `$0.5943`** (**1.53×**) |

#### C. Continuous 4-Generation Multi-Model Rotation (`Gemini 4 Neon → DeepSeek → GPT-6.1 Sol → DeepSeek`, 15 Switches, 186 Checks)

| System | Compactions | Accuracy | Gen 1–4 Wire Reduction | Comp Wall / End-to-End Wall | Total HTTP Reqs (Comp Reqs) | Total Spend (Magpie / Norm USD) |
| :--- | :---: | :---: | :--- | ---: | ---: | ---: |
| **`weave-0.6.0`** | **4 / 4** | **186 / 186 (100%)** | `67.72% / 59.98% / 57.62% / 56.15%` | `118,631 ms` / **`275,620 ms`** | `32` (`6`) | **`$0.6042` / `$0.4906`** |
| `dsh-basic` | 4 / 4 | 186 / 186 (100%) | `68.34% / 71.59% / 71.19% / 65.03%` | `111,682 ms` / `476,540 ms` (`1.73×` slower) | `30` (`4`) | `$0.6482` / `$0.5116` (no verbatim Sec. 6 or archive) |
| `billion-context@ced22b1` | 4 / 4 | 186 / 186 (100%) | **`-30.97%`**, `25.34%`, **`-8.07%`**, `34.81%` | `185,885 ms` / `415,957 ms` (`1.51×` slower) | `42` (**`15`**) | **`$0.8623` / `$0.7139`** (**+42.7% / +45.5%**) |

---

## Historical Verification Records (`0.3.2` and Earlier)

<details>
<summary>Expand pre-0.6.0 multi-host compatibility matrices and historical experiment JSON archives</summary>

- **Historical live 4-way benchmark (2026-11-19)**: [`../benchmarks/v0.3.2-live-four-way.json`](../benchmarks/v0.3.2-live-four-way.json), [`../benchmarks/v0.3.2-tests.json`](../benchmarks/v0.3.2-tests.json)
- **Multi-version DSH host compatibility (`0.3.2-rc.3` Windows / Linux × `0.2.2-rc.1` / `rc.2` / `rc.3`)**: [`../benchmarks/rc3-host-compatibility.json`](../benchmarks/rc3-host-compatibility.json)
- **Earlier baseline and strategy evaluation archives**: [`../benchmarks/rc4-tests.json`](../benchmarks/rc4-tests.json), [`../benchmarks/rc2-linux-tests.json`](../benchmarks/rc2-linux-tests.json), [`../benchmarks/rc2-live-and-cost.json`](../benchmarks/rc2-live-and-cost.json), [`../benchmarks/published-0.3.2-rc.1-tests.json`](../benchmarks/published-0.3.2-rc.1-tests.json), [`../benchmarks/review35-compression.json`](../benchmarks/review35-compression.json), [`../test-results.json`](../test-results.json)

</details>

---

## Running Tests Locally and Source Navigation

Run the offline regression suite, static checks, and host integration tests from the repository root:

```bash
npm test
npm run check
node scripts/test.mjs --host-modules /path/to/dsh/node_modules
```

Core modules under `lib/` corresponding to the compaction pipeline, cache policy, auditing, redaction, and diagnostics:

- Main compaction pipeline and outcome reporting: [../../lib/engine.js](../../lib/engine.js), [../../lib/engine/span-commit.js](../../lib/engine/span-commit.js)
- Cache-prefix preservation policy, span selection, and date grounding: [../../lib/cache-policy.js](../../lib/cache-policy.js), [../../lib/region.js](../../lib/region.js), [../../lib/date-grounding.js](../../lib/date-grounding.js)
- Layered acyclic auditing, negation scope, and progress fact validation: [../../lib/audit.js](../../lib/audit.js), [../../lib/audit/compaction.js](../../lib/audit/compaction.js), [../../lib/constraint-scope.js](../../lib/constraint-scope.js), [../../lib/progress-facts.js](../../lib/progress-facts.js)
- Deterministic requirement reconstruction and requirement lifecycle tracking: [../../lib/reconstruct.js](../../lib/reconstruct.js), [../../lib/memory-policy.js](../../lib/memory-policy.js)
- Linear credential/PEM redaction, bounded file re-injection, and Tier-4 previews: [../../lib/redact.js](../../lib/redact.js), [../../lib/file-reinject.js](../../lib/file-reinject.js), [../../lib/tool-preview.js](../../lib/tool-preview.js)
- Backend continuation paging, call budgets, and progress ledgers: [../../lib/continuation.js](../../lib/continuation.js), [../../lib/continuation-budget.js](../../lib/continuation-budget.js), [../../lib/continuation-progress.js](../../lib/continuation-progress.js)
- Local `zstd` archive, BM25F search, attachment store, tool handler, and transactional commit: [../../lib/history.js](../../lib/history.js), [../../lib/history-search.js](../../lib/history-search.js), [../../lib/attachments.js](../../lib/attachments.js), [../../lib/tools.js](../../lib/tools.js), [../../lib/transaction.js](../../lib/transaction.js)
- Failure diagnostic metadata whitelist and audit rejection records: [../../lib/failure-diagnostics.js](../../lib/failure-diagnostics.js), [../../lib/audit-reject.js](../../lib/audit-reject.js)
