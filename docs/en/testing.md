[简体中文](../testing.md) · [English](testing.md)

# DSH Compaction Weave Testing Record (`0.3.2`)

## 0.3.2 Stable Release Validation, Paired Speedups, and Four-System Live Benchmark (2026-11-19)

Running under Windows / Node.js `v24.19.0` against an isolated DSH `0.2.2-rc.3` host, stable release `0.3.2` completes two-stage tool folding, same-route verbatim KV prefix reuse, `History archive` checkpoint pointers, host-channel + XML provenance isolation, domain-agnostic `key: value` progress checks, lexically normalized host method fingerprints, single-pass hashed transaction backups, ASCII word-set indexing in `coverageOf`, single-key JSON wrapper unwrapping and space-delimited scalar binding, pre-release billing-safety stress tests, and graceful public `Session.append(replace)` fallback (`strictHostFingerprints: false` across `>=0.2.2-rc.1 <1.0.0-0`). **All 51 active suites and 1,059 checks pass with 0 failures** (machine-readable evidence in [../benchmarks/v0.3.2-tests.json](../benchmarks/v0.3.2-tests.json)):

- **44 offline unit suites (941 checks)**: alongside [`phase1-optimizations.mjs`](../../test/phase1-optimizations.mjs) (5 checks), [`phase2-optimizations.mjs`](../../test/phase2-optimizations.mjs) (5 checks), [`phase3-route-b.mjs`](../../test/phase3-route-b.mjs) (6 checks), and [`astra-review-fixes.mjs`](../../test/astra-review-fixes.mjs) (20 checks), `0.3.2` adds [`release-billing-safety.mjs`](../../test/release-billing-safety.mjs) (9 checks) specifically verifying:
  1. Stage-1 observation masking executes **0 LLM calls** when pressure savings suffice, stays strictly idempotent (never re-masking stubs or error outputs), and avoids mutating the live prefix when Stage-2 LLM summarization is still required;
  2. Same-route context overflow triggers bounded downgrade fallback to projected coordinates without looping, while cross-route summarization strips incompatible `reasoningEffort`/`temperature` parameters;
  3. Retry bounds (`summaryRetryCount`), circuit breaker blocking across pressure/idle/overflow/`compaction/summary-error` waterfall paths after 3 consecutive failures, immediate abort on `401` credential failures without wasting retries, and `continuationMaxExtraCalls` halt + saved-page reuse without double-billing;
  4. Idle compaction skipping tiny/unshrinkable histories (`0` LLM calls), restoring user queued input cleanly on failure, validating HTTP RPC same-origin/size guards (`lib/index.js`), public package exports, `cordis.patch.yml`, and VM bundle loading for `lib/client.js`.
- **7 native DSH `0.2.2-rc.3` host integration suites (118 checks)**: native `Session` surface, capacity regressions, multi-generation cache retention, proactive compaction, durable atomic transactions (including `strictHostFingerprints: false` public-API fallback and unconditional refusal on unrecovered `.rollback`/`.tail` journals), and idle-resume checks all pass.
- **Clean-room archive verification**: extracting `dsh-compaction-weave-0.3.2-source.tar.gz` and `dsh-compaction-weave.tgz` into an isolated directory and running source checks, full offline tests, and export imports passes standalone without workspace `.local` or Git state.

### Paired benchmark comparison against 0.3.2-rc.4 (`a41b41a`)

Paired before/after benchmark running `v0.3.2-rc.4` (`a41b41a`) vs. `0.3.2` in the same Node.js `v24.19.0` / DSH `0.2.2-rc.3` environment ([../benchmarks/v0.3.2-tests.json](../benchmarks/v0.3.2-tests.json)):

| Benchmark metric | `0.3.2-rc.4` (`a41b41a`) | `0.3.2` stable | Measured impact |
| :--- | :--- | :--- | :--- |
| **Tool-heavy pressure compaction (`58,480` tokens)** | `1` LLM summary call; `58,480 → 10,052` (`-82.81%`); `7,329.35 ms` | **`0` LLM calls** (Stage-1 masking); `58,480 → 10,793` (`-81.54%`); **`19.36 ms`** | Eliminates the LLM summary call completely (~`379×` faster locally) while archiving exact tool bytes |
| **Same-route verbatim KV prefix bytes preserved** | `3 / 5` messages (`654 / 12,215` B = `60%` messages) | **`5 / 5` messages (`12,215 / 12,215` B = `100%`)** | Keeps the prompt prefix byte-for-byte intact before the tail instruction for provider KV cache hits |
| **Structured `key: value` progress validation (45 turns)** | `1.08 ms` (legacy regex + noun list) | **`0.01 ms`** (`key: value` structural parser) | ~`108×` faster and avoids false conflicts on ordinary prose mentioning reports/charts |
| **`2.1 MB` native host transaction commit (`.rollback` + hash)** | `23.61 ms` | **`20.26 ms`** | **`14.2%` faster** via single-pass streaming copy-and-hash |
| **Multi-term archive search (`"sqlite locking"`, 16 spans + 64 KB blobs)** | `0` hits (single-phrase + full blob hash per hit) | **`1` hit** (`11.78 ms`; fast stat + multi-term matching) | Multi-term queries match split tokens without re-hashing unrelated blobs on search |
| **Boundary & authorization edge cases (4 checks)** | `0 / 4` (unspaced CJK paraphrase, nested `<quoted_text>`, forged `</untrusted_reference>`, revoked approval) | **`4 / 4`** | Structural XML stack + boundary escaping + CJK bigrams + chronological revocation block spoofing |
| **Runtime bundle size & 45-turn requirement audit tradeoff** | 53 `lib/*.js` files (`748,804` B); audit `16.13 ms` | 54 files (**`728,876` B**, **-2.66%**); audit `31.83 ms` | Net `-19,928 B` (`-2.66%`) across `lib/` while adding Stage-1 masking, JSON unwrapping, and host fallback; `+15.7 ms` (~`0.7 ms`/turn) reflects deeper bilateral & provenance audit |

### Four-Model × Four-System Distortion-Free Live Gateway Benchmark (2026-11-19 Single-Run Observations)

To measure real-world anti-degradation accuracy, compression, multi-compaction KV cache recovery curves, wall-clock compaction speed, and spend without benchmark distortion, we evaluated **4 model families** across **4 systems** (`weave-0.3.2`, `weave-0.3.2-rc.4`, `dsh-basic` with `ToolResultPruner`, and `billion-context@0.1.216`) in [../benchmarks/v0.3.2-live-four-way.json](../benchmarks/v0.3.2-live-four-way.json):

- **Anti-distortion baseline controls**:
  - `dsh-basic` used stock DSH `0.2.2-rc.3` `headroomTokens: 65,536` and `CHAT_MAX_TOKENS=16384` to eliminate artificial output truncation failures;
  - `billion-context@0.1.216` ran behind a persistent header-injecting hop attaching `x-acp-session` per session (including across model switches) with `ccr: true` and natural `<acp-nudge>` autonomous compression;
  - Workloads used unique per-phase Node.js/SQL modules (zero repetitive filler) and explicitly permitted `null` when values were unverified.
- **Model routing & `GPT-6 Astra` disclosure**: Tests ran `auto/gemini-4-argon` (`Gemini 4 Argon`), `auto/glm-5.3-flash` (`GLM-5.3-Flash`), `deepseek/deepseek-flash` (`DeepSeek-V4.1-Flash`), and `GPT-6.1 Sol` (`2-2/gpt-6.1-sol` in Suite A; `auto/gpt-6.1-sol` in Suite C after `公益2` disabled `/v1/chat/completions`, verified `99.33%–99.46%` cache hits via live probe). On Magpie, `auto/gpt-6-astra` works natively in the official Codex CLI (used via MCP for code & benchmark audits) while returning HTTP `403 ("This account only allows Codex official clients")` to non-Codex DSH HTTP clients (`2-2/gpt-6-astra` HTTP `400`, `group/gpt-6.2-astra` HTTP `404`), so no client headers were spoofed.
- **Metric definitions**: **Effective reduction** computes `(rawBaselineBeforeInput - afterFirstCompactionInput) / rawBaselineBeforeInput` against unmodified Weave baselines; **wire reduction** computes `(observedBeforeInput - afterFirstCompactionInput) / observedBeforeInput` (negative values indicate net wire token bloat). Both Magpie catalog USD and unified Normalized reference USD are reported; all timings and cache readings are observed single-run gateway measurements.

#### A. Standalone Single-Model Matrix (32 Branches = 4 Systems × 8 Branches/System = 176 Checks/System)

- `w1-engineering-spec`: Multi-turn engineering spec evolution & anti-trap verification (36 checks: 14 recall + 5 trap + 3 JSONL draft + 14 final recall).
- `w2-repo-debug`: Eight ~23 KB source-file reads + crash log command failure (8 checks including `failedCommandPid: 48210` and middle-of-file constants `src/storage/sqlite-pool.js` / `busyTimeoutMs=4750` / `SQLITE_BUSY_SNAPSHOT_517`).

| System | Completed | Overall Accuracy (All / Conditional) | `w1` Spec Evolution | `w2` Tool-Heavy Debug | Mean Eff / Wire Reduction | Mean `w1` / `w2` Comp Wall Ms | Mean Summary Calls | Total Spend (Magpie / Norm USD) | Key Failure / Tradeoff Drivers |
| :--- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| **`weave-0.3.2`** | **8 / 8** | **175 / 176 (99.43%)** | **144 / 144** (`4/4`) | **31 / 32 (96.88%)** (`4/4`) | **`72.20%` / `72.20%`** | `26,881 ms` / **`35.8 ms`** (`20–48 ms`) | **`0.50`** (`0` on `w2`) | `$1.0821` / `$0.8539` | Only 8/8 high-accuracy system; all `w2` resolved in Stage-1 with `0` LLM calls (`gpt/w2` missed `failedCommandPid`: `7/8`) |
| **`weave-0.3.2-rc.4`** | **5 / 8** | `62 / 176` (35.23% all; conditional `62 / 68 = 91.18%`) | 36 / 36 (**`1/4` finished**) | 26 / 32 (`4/4`) | `38.87%` / `35.50%` | `53,131 ms` / `48,041 ms` | `1.20` | `$0.9372` / `$0.6605` (5 done) | Gemini, GPT, and DeepSeek `w1` failed deterministically on legacy `PROGRESS_FACT_CONFLICT`; `deepseek/w2` scored `3/8` |
| **`dsh-basic`** | 8 / 8 | 164 / 176 (**93.18%**) | **144 / 144** (`4/4`) | **20 / 32 (62.50%)** (`4/4`) | `65.49%` / `69.76%` | `56,811 ms` (**2.11×** slower vs Weave) / `6.8 ms` | `0.50` | `$0.7952` / `$0.6143` | Stock budget restored `w1` to `144/144`, but `ToolResultPruner` head/tail slicing drops middle constants (`4750`, `SQLITE_BUSY_SNAPSHOT_517`) with no archive lookup |
| **`billion-context@0.1.216`** | 8 / 8 | 155 / 176 (**88.07%**) | **144 / 144** (`4/4`) | **11 / 32 (34.38%)** (`gpt`/`deepseek` **0/8**) | `33.35%` / **`-13.95%` (wire bloat)** | `24,588 ms` / `34,863 ms` | `1.25` | **`$1.6899`** / **`$1.3999`** | Persistent `x-acp-session` fixed `w1` (`144/144`), but `w2` collapsed (`glm` `3/8`, `gpt` `0/8`, `deepseek` `0/8`) with `-13.95%` net local wire bloat |

<details>
<summary>Expand per-branch breakdown across all 32 standalone runs</summary>

| Model | System | `w1` Acc | `w1` Eff / Wire | `w1` Wall / Calls / R2→R6 Cache / USD | `w2` Acc | `w2` Eff / Wire | `w2` Wall / Calls / R2 Cache / USD |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| `Gemini 4 Argon` | **`weave-0.3.2`** | **36/36** | 79.36% / 79.36% | `35,751 ms` / 1 / 60.66%→70.28% / `$0.2135` | **8/8** | 42.31% / 42.31% | **`27 ms`** / **0** / 0% / `$0.3447` |
| `Gemini 4 Argon` | `weave-0.3.2-rc.4` | **FAIL** (`PROGRESS_FACT_CONFLICT`) | — | — | **8/8** | -34.43% / -34.42% | `40,730 ms` / 1 / 47.09% / `$0.3100` |
| `Gemini 4 Argon` | `dsh-basic` | 36/36 | 83.51% / 83.44% | `110,970 ms` / 1 / 51.65%→65.76% / `$0.2668` | **6/8** | 28.49% / 28.47% | `8 ms` / 0 / 87.56% / `$0.1180` |
| `Gemini 4 Argon` | `billion-context` | 36/36 | 36.87% / 8.58% | `45,476 ms` / 2 / 0%→0% / `$0.4791` | **8/8** | 7.05% / `-9.56%` | `45,090 ms` / 2 / 0% / `$0.5828` |
| `GLM-5.3-Flash` | **`weave-0.3.2`** | **36/36** | 87.40% / 87.40% | `33,391 ms` / 1 / 89.78%→93.72% / `$0.0081` | **8/8** | 77.55% / 77.55% | **`48 ms`** / **0** / 28.58% / `$0.0189` |
| `GLM-5.3-Flash` | `weave-0.3.2-rc.4` | 36/36 | 86.59% / 86.50% | `53,131 ms` / 2 / 90.68%→94.02% / `$0.0129` | **8/8** | 44.47% / 44.46% | `64,978 ms` / 1 / 49.80% / `$0.0217` |
| `GLM-5.3-Flash` | `dsh-basic` | 36/36 | 90.57% / 90.56% | `56,330 ms` / 1 / 0%→73.52% / `$0.0095` | **5/8** | 71.58% / 71.57% | `6 ms` / 0 / 9.66% / `$0.0108` |
| `GLM-5.3-Flash` | `billion-context` | 36/36 | 39.09% / 6.29% | `15,749 ms` / 1 / 97.60%→98.05% / `$0.0109` | **3/8** | 70.35% / 4.97% | `30,073 ms` / 0 / 98.82% / `$0.0127` |
| `GPT-6.1 Sol` (`2-2`) | **`weave-0.3.2`** | **36/36** | 67.91% / 67.91% | `26,842 ms` / 1 / 33.42%→0% / `$0.1771` | **7/8** | 57.19% / 57.19% | **`48 ms`** / **0** / 0% / `$0.2897` |
| `GPT-6.1 Sol` (`2-2`) | `weave-0.3.2-rc.4` | **FAIL** (`PROGRESS_FACT_CONFLICT`) | — | — | **7/8** | 53.49% / 36.71% | `46,019 ms` / 1 / 0% / `$0.5656` |
| `GPT-6.1 Sol` (`2-2`) | `dsh-basic` | 36/36 | 8.25% / 50.15% | `52,053 ms` / 1 / 98.84%→98.94% / `$0.2137` | **5/8** | 79.24% / 71.75% | `6 ms` / 0 / 81.28% / `$0.1551` |
| `GPT-6.1 Sol` (`2-2`) | `billion-context` | 36/36 | -42.41% / `-65.11%` | `26,211 ms` / 2 / 98.92%→85.97% / `$0.2402` | **0/8** | 51.36% / **`-72.46%`** | `57,821 ms` / 2 / 92.56% / `$0.3371` |
| `DeepSeek-V4.1-Flash` | **`weave-0.3.2`** | **36/36** | 88.18% / 88.18% | `11,538 ms` / 1 / 89.87%→91.95% / `$0.0106` | **8/8** | 77.71% / 77.71% | **`20 ms`** / **0** / 45.81% / `$0.0196` |
| `DeepSeek-V4.1-Flash` | `weave-0.3.2-rc.4` | **FAIL** (`PROGRESS_FACT_CONFLICT`) | — | — | **3/8** | 44.23% / 44.23% | `40,436 ms` / 1 / 78.34% / `$0.0269` |
| `DeepSeek-V4.1-Flash` | `dsh-basic` | 36/36 | 90.63% / 90.55% | `7,889 ms` / 1 / 89.29%→87.83% / `$0.0099` | **4/8** | 71.62% / 71.62% | `7 ms` / 0 / 98.28% / `$0.0114` |
| `DeepSeek-V4.1-Flash` | `billion-context` | 36/36 | 34.49% / 15.19% | `10,915 ms` / 1 / 97.41%→96.77% / `$0.0118` | **0/8** | 70.00% / 0.52% | `6,467 ms` / 0 / 98.49% / `$0.0152` |

</details>

#### B. Continuous 5-Compaction (`C1–C5`) × 6-Reply (`R1–R6`) KV Cache Recovery & Speed

Running 5 consecutive compactions with 6 follow-up replies per cycle (`8` long trajectories, `40` compactions, `240` replies) on `DeepSeek-V4.1-Flash` and `GLM-5.3-Flash` separates **compaction's own prefix cache hit (`compactionSelfPct`)**, **`R1` first-turn prefix write (`0%` on consolidation / `~33%` on incremental because a compacted span changes the prompt prefix)**, and **`R2–R6` steady-state KV cache recovery** (under provider `cache_read`/`cache_write` telemetry; single-run trajectories):

| Model / System | Accuracy | Comp Wall / End-to-End Wall | Reqs | Compaction Self-Cache (`C1–C5`) | `R1` Prefix Write (`C1–C5`) | `R2` Recovery (`C1–C5`) | `R3–R6` Steady State | Wire Reduction (`C1–C5`) | Total Spend (Magpie / Norm USD) |
| :--- | :---: | ---: | ---: | :--- | :--- | :--- | :--- | :--- | ---: |
| `DeepSeek` / **`weave-0.3.2`** | **100/100** | **`45,989 ms`** / **`116,878 ms`** | **40** | **`95.52, 93.49, 90.60, 87.15, 85.94%`** | `0, 33.24, 0, 0, 0%` | **`97.68, 99.08, 98.14, 98.32, 98.98%`** | `96.97%–98.65%` | `70.48, 53.51, 61.16, 55.06, 55.82%` | **`$0.0419` / `$0.0419`** |
| `DeepSeek` / `weave-0.3.2-rc.4` | 100/100 | `127,239 ms` (`2.77×` slower) / `195,746 ms` | 44 | `94.93, 0, 62.72, 0, 60.64%` | `0, 33.93, 0, 0, 0%` | `98.50–99.02%` | `96.56%–98.55%` | `70.73, 55.31, 61.42, 53.67, 56.53%` | `$0.0632` / `$0.0632` |
| `DeepSeek` / `dsh-basic` | 100/100 | `52,253 ms` (`1.14×` slower) / `126,139 ms` | 40 | **`0, 0, 0, 0, 0%`** | `0, 0, 0, 0, 0%` | `98.11–99.02%` | `95.65%–98.43%` | `70.08, 70.49, 64.27, 57.19, 58.04%` | `$0.0599` / `$0.0599` |
| `DeepSeek` / `billion-context` | **88/100** (`C2` 10/20, `C5` 18/20) | `173,811 ms` (`3.78×` slower) / `363,807 ms` | 69 | N/A | `27.78–87.23%` | `57.62–73.68%` | `57.17%–97.97%` | **`-27.75, -113.58, 35.40, -118.96, -189.07%`** | `$0.1032` / `$0.1032` |
| `GLM` / **`weave-0.3.2`** | **100/100** | **`107,648 ms`** / **`282,650 ms`** | **40** | `0, 37.68, 65.37, 0, 57.93%` | `0, 0, 0, 0, 0%` | `98.13, 34.18, 98.89, 98.92, 99.03%` (`C2` write delay; `R3=98.97%`) | `97.75%–99.11%` | `69.58, 53.48, 62.68, 54.87, 55.02%` | **`$0.0529` / `$0.0505`** |
| `GLM` / `weave-0.3.2-rc.4` | **FAIL** (`budget overflow`) | — | — | — | — | — | — | — | — |
| `GLM` / `dsh-basic` | 100/100 | `431,436 ms` (**`4.01×`** slower) / `576,429 ms` | 40 | **`0, 0, 0, 0, 0%`** | `0, 0, 0, 0, 0%` | `98.39–99.05%` | `97.41%–98.90%` | `68.20, 62.15, 55.92, 55.34, 55.85%` | `$0.0636` / `$0.0685` |
| `GLM` / `billion-context` | 100/100 | `351,901 ms` (**`3.27×`** slower) / `801,041 ms` (`2.83×`) | 57 | N/A | `0, 67.30, 58.00, 57.82, 0%` | `44.74, 0, 0, 0, 0%` | `R3` `0%–89.62%` → `R6` `95.54%–97.85%` | `-30.12, -157.12, -7.55, -7.22, 33.23%` | `$0.1034` / `$0.1164` |

#### C. Continuous 19-Switch Cross-Model Matrix (`Gemini 4 Argon → GLM-5.3-Flash → DeepSeek-V4.1-Flash → auto/gpt-6.1-sol`, 226 Checks)

Across 4 model-rotated generations (note Gen 4 ran `auto/gpt-6.1-sol` due to upstream `公益2` `/v1/chat/completions` shutdown; single-run gateway measurements):

| System | Compactions Passed | Accuracy | Per-Gen Wire Reduction (`G1 / G2 / G3 / G4`) | Comp Wall / End-to-End Wall | HTTP / Comp Reqs | Total Spend (Magpie / Norm USD) | Operational & Tradeoff Notes |
| :--- | :---: | ---: | :--- | ---: | ---: | ---: | :--- |
| **`weave-0.3.2`** | **4 / 4** (all 1st attempt) | **226 / 226 (100%)** | **`66.32% / 58.47% / 59.49% / 55.72%`** | **`114,864 ms`** / `400,743 ms` | **34 / 4** (`0` retries) | `$0.6077` / `$0.4915` | Single-key JSON unwrap + space-delimited scalar binding passed all 4 generations including GPT on the first attempt |
| **`weave-0.3.2-rc.4`** | **3 / 4** (Gen 4 GPT failed) | `226 / 226` (Gen 4 left uncompressed) | `65.47% / 57.95% / 60.13%` / **`-0.64%`** | `224,449 ms` (`1.95×` slower) / `436,157 ms` | 37 / **7** | `$0.7259` / `$0.5610` | Gen 4 GPT rejected until budget exhaustion (scored `226/226` only because full uncompressed history remained); nearly `2×` slower compaction |
| **`dsh-basic`** | 4 / 4 | 226 / 226 (100%) | `69.11% / 70.94% / 65.61% / 66.43%` | `118,401 ms` (still slower than Weave) / `327,876 ms` | 34 / 4 | `$0.5935` / `$0.4811` | Pure-text prompts without verbatim Section 6 retention or tool-archive lookup; ~`2.1%` cheaper norm USD on text-only rotation while taking `3.5s` longer to compact |
| **`billion-context@0.1.216`** | 4 / 4 (ACP) | 226 / 226 (100%) | **`-36.31%`** `/ 54.18% / 32.01% / N/A` | `203,650 ms` (`1.77×` slower) / **`875,970 ms`** (`2.19×` slower) | **48 / 15** | **`$0.8260`** / **`$0.6873`** | Fired 15 compaction calls across 48 HTTP requests; Gen 1 bloated `-36.31%`; full run took `14.6` minutes |

> **Longitudinal context**: Compared to historical baselines, `0.3.2` moves from `0.3.1-review.35` (stopped after Gen 4 consolidation / historical false rejection limit; DeepSeek `68.50%` mean / `70.20%` weighted reduction in [../benchmarks/review35-compression.json](../benchmarks/review35-compression.json)) and `0.3.2-rc.4` (Suite A `5/8`, Suite B GLM failed, Suite C Gen 4 failed) to **8/8 Suite A, 100/100 Suite B on DeepSeek & GLM, and 4/4 first-attempt 226/226 Suite C**, matching `0.3.2-rc.2` accuracy (`728/728` in [../benchmarks/rc2-live-and-cost.json](../benchmarks/rc2-live-and-cost.json)) while adding Stage-1 masking, `97%–99%` verified `R2–R6` cache recovery across 5 cycles, and public-API host fallback.

> **Historical baseline & scope boundary**: Alongside removing domain wordlists and natural-language guessing regexes, 21 coupled synthetic-fixture suites were moved to [`test/archived-regex/`](../../test/archived-regex/README.md); the pre-archive baseline (`2026-11-17`, 67 suites / 2,064 checks, 0 failures) stays recorded in [../benchmarks/rc4-tests.json](../benchmarks/rc4-tests.json). All 51 active unit/host suites and the `a41b41a` paired microbenchmarks use deterministic injected model responses and isolated runtimes with zero live paid calls, whereas the 2026-11-19 four-model × four-system matrices reflect live Magpie gateway runs archived in [../benchmarks/v0.3.2-live-four-way.json](../benchmarks/v0.3.2-live-four-way.json).

### Earlier pre-archive baseline (2026-11-17)

On Windows / Node.js 24.21.0 / DSH 0.2.2-rc.3 prior to archiving the legacy synthetic suites, **67 suites and 2064 checks passed with 0 failures**: 60 offline suites / 1948 checks and 7 native-host suites / 116 checks. [Per-suite baseline results](../benchmarks/rc4-tests.json) identify that snapshot and its scope.

Together, the active suites and baseline cover instruction/reference boundaries, corrections and task lifecycle, execution states, structured content, pruned-source recovery, per-call parsing caches, idle compaction, and live settings (concurrent operation snapshots, clearing overrides back to inherited configuration, the 30-day limit, and updates during native-session compaction).

Historical sections below retain their original version attribution. This release uses injected summary responses and adds no paid calls. Automated checks are not a real development-task success rate and do not establish desktop behavior, actual cache hits, or total task costs. Whole-task cost and waiting benefits still require separate task validation.


This document summarizes the validation for `0.3.2` and `0.3.2-rc.3`, the offline and host-integration regressions for `0.3.2-rc.2`, the four-model live cross-switch acceptance run and paired strategy cost evaluation conducted during `0.3.2-rc.2` candidate development, and the historical test records and formulas from `0.3.2-rc.1` and `0.3.1-review.35`.

---

## 1. Overview of Test Conditions

Testing across development and release verification covered offline synthetic streams, isolated DSH host integration, and live model gateway calls. The code baseline, runtime environment, and machine-readable evidence for each batch are listed below:

| Test batch | Code or package version | Platform & runtime | Host & model conditions | Scale & outcome | Evidence |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Windows stable release & paired benchmark** | `0.3.2` | Windows `win32` · Node.js `v24.19.0` | Isolated DSH `0.2.2-rc.3` host + synthetic streams + `a41b41a` paired run | **51 suites, 1,059 checks** (44 offline suites / 941 checks incl. 20 Astra-fix & 9 billing-safety checks + 7 host suites / 118 checks), **0 failures** | [../benchmarks/v0.3.2-tests.json](../benchmarks/v0.3.2-tests.json) |
| **Four-model × four-system live gateway benchmark** | `0.3.2` vs `rc.4` / `dsh-basic` / `billion-context@0.1.216` | Windows `win32` · Magpie gateway (single-run observations) | `Gemini 4 Argon`, `GLM-5.3-Flash`, `DeepSeek-V4.1-Flash`, `GPT-6.1 Sol` (`auto/gpt-6-astra` Codex-audited, HTTP `403` for non-Codex DSH) | **32 standalone** (Weave `8/8`, **175/176**, `w2` `35.8 ms` / 0 LLM calls) + **5-cycle cache** (`R2–R6` **97%–99%**) + **19-switch rotation** (Weave **4/4**, **226/226**) | [../benchmarks/v0.3.2-live-four-way.json](../benchmarks/v0.3.2-live-four-way.json) |
| **Windows full regression (`rc.3` multi-host)** | `0.3.2-rc.3` | Windows `win32` · Node.js `v24.21.0` | Isolated DSH `0.2.2-rc.1` and `0.2.2-rc.3` hosts + synthetic streams | **56 suites, 1,698 checks per host** (50 offline suites / 1,597 checks + 6 host suites / 101 checks), **0 failures** | [../benchmarks/rc3-host-compatibility.json](../benchmarks/rc3-host-compatibility.json), [../test-results.json](../test-results.json) |
| **Linux full regression (`rc.3` multi-host)** | `0.3.2-rc.3` | Linux `linux` · Node.js `v24.9.0` | Isolated DSH `0.2.2-rc.2` and `0.2.2-rc.3` hosts + synthetic streams | **56 suites, 1,698 checks per host** (50 offline suites / 1,597 checks + 6 host suites / 101 checks), **0 failures** | [../benchmarks/rc3-host-compatibility.json](../benchmarks/rc3-host-compatibility.json) |
| **Windows full regression (`0.3.2-rc.2`)** | `0.3.2-rc.2` | Windows `win32` · Node.js `v24.21.0` | Isolated DSH `0.2.2-rc.1` host + synthetic streams | **55 suites, 1,690 checks** (50 offline suites / 1,597 checks + 5 host suites / 93 checks), **0 failures** | [../benchmarks/rc3-host-compatibility.json](../benchmarks/rc3-host-compatibility.json) |
| **Linux offline regression (`0.3.2-rc.2`)** | `0.3.2-rc.2` | Linux `linux` · Node.js `v24.9.0` | Offline synthetic streams & fault injection | **50 suites, 1,597 checks**, **0 failures** | [../benchmarks/rc2-linux-tests.json](../benchmarks/rc2-linux-tests.json) |
| **Four-model live cross-switch acceptance** | Internal package `0.3.2-rc.1` (before removing legacy continuation command and adding diagnostic fields) | Windows · live gateway calls | `Gemini 4 Argon` → `GLM` → `DeepSeek` → `GPT` | 4 compactions (1 summary call each), 24 model switches, 60 HTTP requests; **728 / 728** state fields and **77 / 77** structure checks passed | [../benchmarks/rc2-live-and-cost.json](../benchmarks/rc2-live-and-cost.json) |
| **Four-model paired strategy & cost evaluation** | `0.3.2-rc.2` candidate development branches | Live gateway calls · 10 matched branch pairs | `DeepSeek`, `GLM`, `GPT`, `Gemini` | Baseline vs. experimental partial consolidation across compaction + 6 follow-up replies; independent audit of **678** raw HTTP attempts and **677** `usage` records with **0** discrepancies | [../benchmarks/rc2-live-and-cost.json](../benchmarks/rc2-live-and-cost.json) |
| **`0.3.2-rc.1` preflight regression (historical)** | `0.3.2-rc.1` | Windows `win32` · Node.js `v24.19.0` | Isolated DSH `0.2.2-rc.1` host + synthetic streams | **50 suites, 1,359 checks** (45 offline suites / 1,266 checks + 5 host suites / 93 checks), **0 failures** | [../benchmarks/published-0.3.2-rc.1-tests.json](../benchmarks/published-0.3.2-rc.1-tests.json) |
| **`0.3.1-review.35` live compaction experiment (historical)** | `0.3.1-review.35` | Official `DeepSeek V4.1 Flash` API · 90 requests | 4 successful compactions (3 incremental + 1 consolidation) | Equal-weight mean input reduction **68.50%**, incremental Gen 1–3 mean **58.71%**, weighted reduction **70.20%** | [../benchmarks/review35-compression.json](../benchmarks/review35-compression.json) |

---

## 2. `0.3.2-rc.3` Host Compatibility and `0.3.2-rc.2` Regression Suites

### 2.1 `0.3.2-rc.3` Multi-Host Compatibility and Real Transaction Regression

`0.3.2-rc.3` (November 14, 2026) widens the declared DSH host compatibility range to `>=0.2.2-rc.1 <0.3.0-0` (admitting the `0.2` series from `0.2.2-rc.1` onward, including prereleases, while excluding `0.3.0` prereleases and stable `0.3.0`), adds the reviewed `Session.append` implementation fingerprint introduced in DSH `0.2.2-rc.2` and `0.2.2-rc.3` (`f90d8979863a27976e0e03bda3254ce5f3a07bc830edeae81e0d60c22127bdaf` alongside `f434d8e94303e06be3f3ecddb599f90c7bff421eeb4ca3920611f68925565751`), and updates the host test runner and CI workflow without changing compaction, cache-preservation, cold-read, prewarming, or regeneration policies:

- **Windows multi-host full regression**: Executed on Windows (`win32`, Node.js `v24.21.0`) against isolated DSH `0.2.2-rc.1` and `0.2.2-rc.3` hosts, passing **56 suites and 1,698 checks with 0 failures** on each host (50 offline suites / 1,597 checks + 6 host suites / 101 checks).
- **Linux multi-host full regression**: Executed on Linux (`linux`, Node.js `v24.9.0`) against isolated DSH `0.2.2-rc.2` and `0.2.2-rc.3` hosts, passing **56 suites and 1,698 checks with 0 failures** on each host (50 offline suites / 1,597 checks + 6 host suites / 101 checks).
- **New host transaction and range checks (1 suite / 8 checks)**: Added to the host integration suite (bringing host checks from 5 suites / 93 checks to 6 suites / 101 checks) without calling paid model gateways. The 8 checks verify:
  1. Semver range admission of `0.2.2-rc.1`, `0.2.2-rc.2`, `0.2.2-rc.3`, stable `0.2.2`, and subsequent `0.2.x` releases;
  2. Semver range rejection of older versions and `0.3.0` prereleases;
  3. Real native durable commit, local archive write, readback, and cold reopen;
  4. Pre-decision failure rollback restoring original session history;
  5. Post-decision publication failure preserving durable commit state and clearing the pending decision marker on cold open;
  6. Interrupted physical tail recovery restoring the verified backup and closing the lifecycle before reopening;
  7. Refusal of unknown `Session.append` implementations before any summary request or transactional history mutation;
  8. Single and batch `Session.append` ingestion followed by full compaction and archive readback.
- **CI workflow configuration**: GitHub Actions adds an isolated host compatibility matrix across Windows and Linux against DSH `0.2.2-rc.1` and `0.2.2-rc.3` while retaining the existing offline matrix; cloud workflow runs for the new matrix have not yet been generated at release verification time.
- **Host support boundary**: Verified DSH host releases are `0.2.2-rc.1`, `0.2.2-rc.2`, and `0.2.2-rc.3` ([../benchmarks/rc3-host-compatibility.json](../benchmarks/rc3-host-compatibility.json)). Future `0.2.x` releases pass the installer version range check, but if a future host modifies private persistence methods to an unreviewed implementation fingerprint, Weave refuses compaction before issuing any summary request or mutating history while keeping existing recovery protections intact.

### 2.2 `0.3.2-rc.2` Offline and Host Integration Regression

Building on the 50 suites from `0.3.2-rc.1`, `0.3.2-rc.2` added regression coverage for requirement lifecycles, coordinated negation scope, superseded historical progress snapshots, progress source compatibility, and failure diagnostic whitelisting:

- **Windows full regression (`0.3.2-rc.2`)**: Executed on Node.js `v24.21.0` with DSH `0.2.2-rc.1`, passing **55 suites and 1,690 checks with 0 failures**. This comprises 50 offline unit suites (1,597 checks) and 5 DSH host integration suites (93 checks: `host/capacity-regressions.mjs` 29, `host/independent.mjs` 58, `host/native-cache-test.mjs` 4, `host/native-host.mjs` 1, and `host/native-proactive.mjs` 1).
- **Linux offline regression (`0.3.2-rc.2`)**: Executed on Node.js `v24.9.0`, passing **50 suites and 1,597 checks with 0 failures**, recorded in [../benchmarks/rc2-linux-tests.json](../benchmarks/rc2-linux-tests.json).
- **Replay of historical false-rejection samples**: Candidate summaries that previously triggered false rejections—such as intermediate progress counts (`19/23`) superseded by final completion (`23/23`), or affirmative requirements paired with explicit exclusion clauses—pass validation without redundant regenerations while genuine polarity flips and progress contradictions remain blocked.

### 2.3 Four-Model Live Cross-Switch Acceptance

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

**Conclusion**: Experimental partial consolidation produced only minor matched-pair savings on `DeepSeek` (`-4.36%`) and `GPT` (`-1.28%`), while substantially increasing summary regeneration and follow-up costs on `GLM` (`+31.88%` under the proxy-rate scenario) and `Gemini` (`+29.20%`), alongside 1 uncompleted content-failure branch on both `GLM` (`$0.017583060`) and `Gemini` (`$0.1911960`). Consequently, `0.3.2-rc.2` and `0.3.2-rc.3` retain the existing incremental-plus-full-consolidation default policy and do not send post-compaction cache prewarming requests.

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

- **Version attribution of live runs**: The four-model cross-switch acceptance test ran on internal package `0.3.2-rc.1` prior to removing `/context-continue` and adding the new diagnostic metadata fields, and the paired cost experiment compared `0.3.2-rc.2` candidate development branches. `0.3.2-rc.3` only widens host compatibility without new paid live runs; these datasets remain attributed to their respective builds rather than post-freeze live runs of the final `0.3.2-rc.2` or `0.3.2-rc.3` tarballs.
- **Invoice and pricing scope**: `DeepSeek`, `GPT`, and `Gemini` costs are gateway-rate estimates derived from returned `usage` without provider invoice reconciliation. `GLM` has its own billing schedule; its dollar figures and the `+31.88%` delta belong strictly to the proxy-rate cost scenario simulated with DeepSeek gateway unit rates, not actual paid invoices or official GLM list prices.
- **Unmatched branch counts in `allAttempts`**: On `GLM` and `Gemini`, Baseline completed 3 branches while Candidate completed 2; therefore, `allAttempts` totals reflect different numbers of completed branches (3 vs. 2) and cannot be compared directly as equal-output totals.
- **Control arm scope**: The paired experiment compared two compaction consolidation strategies across compaction plus 6 follow-up replies and did not include an uncompacted 6-reply live control arm.

---

## 4. Usage Representation and Host Version Fields in Diagnostics

In test ledgers and failure diagnostics, Weave records missing usage measurements and host versions according to these rules:

- **Missing usage representation**: When a request does not report `usage`, or when a request fails (`streamFailure` or an `error` / `aborted` terminal state) and the adapter returns an all-zero `usage` object, the measurement is treated as unknown and represented in JSON via `usage: null`, omitted fields, or `usageKnown: false` rather than a fixed `"unknown"` string. Successful responses with genuine zero or positive usage preserve their reported values.
- **Host version fields**: The diagnostic environment block records `supportedDshVersion: ">=0.2.2-rc.1 <0.3.0-0"` (the declared host compatibility range; `0.3.2-rc.2` recorded `"0.2.2-rc.1"`) and sets `actualDshVersion: null`, indicating that the running host version is not automatically detected; issue reports still require the user to supply the running DSH version manually.

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
