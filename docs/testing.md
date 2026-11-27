[简体中文](testing.md) · [English](en/testing.md)

# DSH Compaction Weave 测试记录（0.6.0）

## 0.6.0 正式版验证与三方无失真对比评测（2026-11-25）

在 Windows / Node.js `v24.19.0` 环境下，正式版 `0.6.0` 完成 `lib/audit/` 6 层无环拆分、`lib/engine/` 8 域模块化、纯 JS BM25F 多字段归档检索（`history-search.js`）、`zstd` 无损归档与存储治理、确定性相对日期锚定、Tier-4 关键散文预览、工作区文件重注入 PEM/凭据脱敏（`+4 KiB` 预读边界）、`auditCoverageScope: 'recent'`（全档保留硬红线校验）、DSH Desktop `0.2.3-alpha.2+` `webserver/index-inject` 随机 Token 与非 `owner` `403` 防护、`threadId` + `(dev, ino)` 跨工作线程锁安全回收，以及 `history_read` 在严格工具模式下的 `null`/空字符串参数规范化：

| 验证维度 | 范围与条件 | 结果 | 数据记录 |
| --- | --- | --- | --- |
| **静态与拓扑校验 (`npm run check`)** | `289` 个发布源文件、包清单 `0.6.0`、文档链接、安装示例与敏感内容规则 | **91 个非客户端 ESM 模块 `0` 环 DAG 通过** | [../scripts/check.mjs](../scripts/check.mjs) |
| **全量离线单元测试 (`npm test`)** | 独立进程 + 隔离临时 `DSH_HOME` | **104 套、1,565 项用例全部通过，0 失败** | [../test/v060-audit-hardening.mjs](../test/v060-audit-hardening.mjs) |
| **DSH `0.2.2-rc.1` 宿主集成回归** | 真实 DSH `Session`、容量、多代缓存与原生 `.rollback` 事务 | **112 套、1,696 项用例全部通过，0 失败** | — |
| **DSH `0.2.2-rc.3` 宿主集成回归** | 真实 DSH `Session`、容量、多代缓存与原生 `.rollback` 事务 | **112 套、1,696 项用例全部通过，0 失败** | — |
| **独立发布打包与解包验收** | `npm run pack:release`（`dist/dsh-compaction-weave-0.6.0.tgz`、`dsh-compaction-weave.tgz`、源码归档与 `SHA256SUMS.txt`） | 白名单校验一致、干净退出 | [../scripts/release.mjs](../scripts/release.mjs) |

---

### 三方无失真真实网关对比评测（`Weave 0.6.0` vs `dsh-basic` vs 最新 `billion-context`，2026-11-25 实盘观测）

为在公平、无人工限额失真的条件下评测 `0.6.0` 与 DSH 基础压缩及最新社区对标插件之间的差距，在本地 Magpie 网关上实盘对比 **3 套系统**：
1. **`weave-0.6.0`**：本仓库 `0.6.0` 默认配置（第一级归档折叠、Tier-4 预览、BM25F 归档检索、`auditCoverageScope: 'recent'`、脱敏文件重注入）。
2. **`dsh-basic`**：DSH `0.2.2-rc.3` 原生 `BasicCompactionEngine` + `ToolResultPruner`（启用原生满额 `headroomTokens: 65,536` 与 `CHAT_MAX_TOKENS=16384`，不设人为小输出限额）。
3. **`billion-context` (`0.0.1328-master.ced22b1`)**：评测当日 npm 最新 `master` 版本地代理，挂载头注入中间件在整段会话及跨模型切换中持久化附带 `x-acp-session`，开启 `ccr: true` 与自然触发 `<acp-nudge>` 自主压缩。

- **实测模型路由**：使用 **`Gemini 4 Neon`**（`group/gemini-4-neon`）、**`GPT-6.1 Sol`**（`auto/gpt-6.1-sol`，命中 Codex 专用槽位 403 时同分支锁定故障转移至 `anyrouter/gpt-6.1-sol`）与 **`DeepSeek-V4.1-Flash`**（`deepseek/deepseek-flash`，备选 `auto/deepseek-v4.1-flash-1017`）。所有系统看到完全一致的表面提示、JSON Schema 与重试配额。
- **指标口径**：**有效压缩率**以同测题未改造前的 `weave-0.6.0` 原始 `beforeInput` 为分母计算 `(rawBefore - after1Input) / rawBefore`；**本地线缆压缩率**以各系统压缩前实测输入为分母 `(observedBefore - after1Input) / observedBefore`（负值表示经前缀/标签重排后发生净膨胀）；费用同时报告网关目录 `Magpie USD` 与跨供应商对齐 `Normalized USD`。完整逐分支、逐轮次与逐代次机器可读数据见 [benchmarks/v0.6.0-live-three-way.json](benchmarks/v0.6.0-live-three-way.json)。

#### A. 单模型独立分支（3 模型 × 3 系统 × 2 负载 = 18 分支；每系统 6 支共 132 项测题）

- `w1-engineering-spec`：多轮演进工程规格与防误导陷阱（`36` 项检查：`14` 压缩后回忆 + `5` 陷阱拒答 + `3` JSONL 清单 + `14` 末轮复核）。
- `w2-repo-debug`：8 次约 23 KB 源码读取与崩溃日志排障（`8` 项检查：关键约束、`failedCommandPid: 48210` 及文件中部常量 `src/storage/sqlite-pool.js` / `busyTimeoutMs=4750` / `SQLITE_BUSY_SNAPSHOT_517`）。

| 系统 | 完成分支 | 总准确率 | `w1` 工程演进 | `w2` 重工具排障 | 均值有效 / 本地压缩率 | 均值 `w1` / `w2` 压缩耗时 | 均值摘要调用 | 合计等价费用（Magpie / Norm USD） | 核心表现与对比分析 |
| :--- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| **`weave-0.6.0`** | **6 / 6** | **131 / 132 (99.24%)** | **108 / 108**（3/3） | **23 / 24 (95.83%)**（3/3） | **`76.07%` / `76.07%`**（6/6） | `48,537 ms` / **`75.67 ms`**（`w2` 均耗 `<0.15 s`） | **`0.50`**（`w2` 全 0 次） | `$1.0200` / `$0.7632` | **唯一双负载均近满分系统**；`w2` `Gemini 8/8`、`GPT 8/8`、`DeepSeek 7/8` 且全部 0 次摘要调用 |
| **`dsh-basic`** | 6 / 6 | 123 / 132 (93.18%) | **108 / 108**（3/3） | 15 / 24 (62.50%)（3/3） | `70.69%` / `70.69%`（5/6 非空；计零 `58.91%`） | `56,292 ms` / `8.67 ms` | `0.83` | **`$0.7912` / `$0.6057`** | 纯文本 `w1` 满分且 Suite A 总费最低（Magpie `-22.4%` / Norm `-20.6%` vs Weave）；`w2` 3/3 均因 `ToolResultPruner` 切片丢失文件中部常量（`15/24`） |
| **`billion-context@ced22b1`** | 6 / 6 | 114 / 132 (86.36%) | **108 / 108**（3/3） | **6 / 24 (25.00%)**（`gpt` **0/8**） | `48.45%` / **`4.24%`**（5/6 非空；计零 `40.38%` / `3.53%`） | `33,996 ms` / **`39,695 ms`** | `0.50` | **`$1.1478`** (`+12.53%`) / **`$0.9989`** (`+30.89%`) | 纯文本 `w1` 满分；重工具 `w2` 严重失忆（`Gemini 3/8`、`DeepSeek 3/8`、`GPT 0/8`），线缆压缩极低且总费最高 |

<details>
<summary>展开查看 18 分支逐模型明细（w1 / w2 准确率、压缩率、耗时、R2/R6 缓存与花费）</summary>

| 模型 | 系统 | `w1` 准确率 | `w1` 压缩（有效/本地） | `w1` 压缩/端到端 ms · 调用 · R2→R6 缓存 · Magpie USD | `w2` 准确率 | `w2` 压缩（有效/本地） | `w2` 压缩/端到端 ms · R2 缓存 · Magpie USD |
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

*(注：`gpt/dsh-basic/w1` 与 `gpt/billion-context/w1` 在 `before-warm` 阶段因未达同一计数锚点，JSON 中 `beforeInputTokens` 与压缩率字段记为 `null`。)*

</details>

#### B. 连续 5 次压缩（`C1–C5`）× 6 轮恢复（`R1–R6`）KV Cache 恢复与花费

在 `DeepSeek-V4.1-Flash` 与 `GPT-6.1 Sol` 上连续运行 5 个周期（每周期压缩后追问 6 轮，共 6 条轨迹、30 次压缩、180 轮恢复回答），测量**摘要请求自命中（`compactionSelfPct`）**、`R2` 恢复、`R6` 稳态命中、全轨迹总体缓存命中率及等价账单：

| 模型 / 系统 | 准确率 | 压缩耗时 / 端到端耗时 | 摘要自命中（`C1–C5`） | `R2` 恢复（`C1–C5`） | `R6` 稳态（`C1–C5`） | 线缆净压缩（`C1–C5`） | 全程总缓存率 | 总花费（Magpie / Norm USD） |
| :--- | :---: | ---: | :--- | :--- | :--- | :--- | ---: | ---: |
| `DeepSeek` / **`weave-0.6.0`** | **100/100** | `73,653 ms` / **`293,672 ms`** | **`95.15, 91.77, 88.42, 86.75, 86.59%`** | **`98.36%–98.89%`** | `96.41%–98.05%` | `69.30, 61.97, 56.03, 55.46, 56.03%` | **`72.11%`** | **`$0.0410` / `$0.0410`** |
| `DeepSeek` / `dsh-basic` | 100/100 | `70,201 ms` / `405,394 ms` | `0, 0, 0, 0, 0%` | `97.97%–98.58%` | `95.87%–98.12%` | `71.04, 71.40, 65.37, 65.91, 57.87%` | `52.15%` | `$0.0584` / `$0.0584`（贵 **42.6%**） |
| `DeepSeek` / `billion-context@ced22b1` | 100/100 | `252,862 ms`（慢 **3.43×**）/ `549,326 ms` | — | `57.35%–98.19%` | `94.49%–98.22%` | **`-34.95%`**, `39.76, 11.86, 37.62, 38.31%` | `66.69%` | **`$0.0879`** / `$0.0879`（**2.15×**） |
| `GPT-6.1 Sol` / **`weave-0.6.0`** | **100/100** | `204,608 ms` / `635,044 ms` | **`0, 45.76, 57.66, 58.22, 58.96%`** | **`98.76%–99.09%`** | **`98.35%–98.66%`** | `68.25, 62.04, 53.73, 53.02, 53.30%` | **`64.48%`** | **`$0.7789` / `$0.3895`** |
| `GPT-6.1 Sol` / `dsh-basic` | 100/100 | `194,252 ms` / `596,156 ms` | `0, 39.28, 48.44, 49.98, 50.26%` | `98.61%–98.94%` | `97.99%–98.46%` | `69.86, 70.47, 64.96, 65.09, 64.96%` | `57.45%` | `$0.8315` / `$0.4158` |
| `GPT-6.1 Sol` / `billion-context@ced22b1` | 100/100 | `260,591 ms` / **`926,991 ms`** | — | `20.97%–25.92%` | `97.16%–98.18%` | **`-38.42, -7.15, -7.89, -7.91, -8.67%`** | `49.27%` | **`$1.1885` / `$0.5943`**（**1.53×**） |

#### C. 连续 4 代、15 次跨模型切换（`Gemini 4 Neon → DeepSeek → GPT-6.1 Sol → DeepSeek`，共 186 项检查）

| 系统 | 完成压缩 | 准确率 | 第 1–4 代线缆净压缩 | 压缩耗时 / 端到端总耗时 | 总 HTTP 请求（压缩次数） | 总花费（Magpie / Norm USD） |
| :--- | :---: | :---: | :--- | ---: | ---: | ---: |
| **`weave-0.6.0`** | **4 / 4** | **186 / 186 (100%)** | `67.72% / 59.98% / 57.62% / 56.15%` | `118,631 ms` / **`275,620 ms`** | `32`（`6` 次摘要请求：4 成功 + 2 次重试） | **`$0.6042` / `$0.4906`** |
| `dsh-basic` | 4 / 4 | 186 / 186 (100%) | `68.34% / 71.59% / 71.19% / 65.03%` | `111,682 ms` / `476,540 ms`（慢 `1.73×`） | `30`（`4` 次摘要） | `$0.6482` / `$0.5116`（无第 6 节原话与归档） |
| `billion-context@ced22b1` | 4 / 4 | 186 / 186 (100%) | **`-30.97%`**, `25.34%`, **`-8.07%`**, `34.81%` | `185,885 ms` / `415,957 ms`（慢 `1.51×`） | `42`（**`15`** 次压缩调用） | **`$0.8623` / `$0.7139`**（贵 **42.7% / 45.5%**) |

*(原始基准 JSON [`docs/benchmarks/v0.6.0-live-three-way.json`](benchmarks/v0.6.0-live-three-way.json) 保持 `2026-11-25` 实盘采录（`candidateCommit: 01f6502`）原样未改。)*

---

## 历史版本测试归档（`0.3.2` 及早期记录）

<details>
<summary>展开查看 0.3.2 及更早版本的多宿主兼容性矩阵与历史实验索引</summary>

- **早期四模型 × 四系统对比基线（2026-11-19）**：[`benchmarks/v0.3.2-live-four-way.json`](benchmarks/v0.3.2-live-four-way.json)、[`benchmarks/v0.3.2-tests.json`](benchmarks/v0.3.2-tests.json)
- **多版本 DSH 宿主兼容性回归（`0.3.2-rc.3` Windows / Linux × `0.2.2-rc.1` / `rc.2` / `rc.3`）**：[`benchmarks/rc3-host-compatibility.json`](benchmarks/rc3-host-compatibility.json)
- **更早版本基线与策略对比归档**：[`benchmarks/rc4-tests.json`](benchmarks/rc4-tests.json)、[`benchmarks/rc2-linux-tests.json`](benchmarks/rc2-linux-tests.json)、[`benchmarks/rc2-live-and-cost.json`](benchmarks/rc2-live-and-cost.json)、[`benchmarks/published-0.3.2-rc.1-tests.json`](benchmarks/published-0.3.2-rc.1-tests.json)、[`benchmarks/review35-compression.json`](benchmarks/review35-compression.json)、[`test-results.json`](test-results.json)

</details>

---

## 本地复现与代码导航

在项目根目录可执行以下命令运行离线回归、静态校验与宿主集成测试：

```bash
npm test
npm run check
node scripts/test.mjs --host-modules /path/to/dsh/node_modules
```

与压缩流水线、缓存策略、审计、脱敏和诊断对应的核心模块如下：

- 压缩主流水线与结果状态汇总：[../lib/engine.js](../lib/engine.js)、[../lib/engine/span-commit.js](../lib/engine/span-commit.js)
- 缓存前缀保留策略、选区计算与日期锚定：[../lib/cache-policy.js](../lib/cache-policy.js)、[../lib/region.js](../lib/region.js)、[../lib/date-grounding.js](../lib/date-grounding.js)
- 6 层无环要求/极性/来源审计、否定范围与进度事实核对：[../lib/audit.js](../lib/audit.js)、[../lib/audit/compaction.js](../lib/audit/compaction.js)、[../lib/constraint-scope.js](../lib/constraint-scope.js)、[../lib/progress-facts.js](../lib/progress-facts.js)
- 确定性要求行重建与用户要求生命周期：[../lib/reconstruct.js](../lib/reconstruct.js)、[../lib/memory-policy.js](../lib/memory-policy.js)
- 线性凭据脱敏、工作区文件重注入与 Tier-4 工具预览：[../lib/redact.js](../lib/redact.js)、[../lib/file-reinject.js](../lib/file-reinject.js)、[../lib/tool-preview.js](../lib/tool-preview.js)
- 后台分页接续、调用预算与进度账本：[../lib/continuation.js](../lib/continuation.js)、[../lib/continuation-budget.js](../lib/continuation-budget.js)、[../lib/continuation-progress.js](../lib/continuation-progress.js)
- 本地 `zstd` 归档、BM25F 检索、附件存储、工具执行与事务提交：[../lib/history.js](../lib/history.js)、[../lib/history-search.js](../lib/history-search.js)、[../lib/attachments.js](../lib/attachments.js)、[../lib/tools.js](../lib/tools.js)、[../lib/transaction.js](../lib/transaction.js)
- 失败诊断元数据白名单与审计拒绝样本记录：[../lib/failure-diagnostics.js](../lib/failure-diagnostics.js)、[../lib/audit-reject.js](../lib/audit-reject.js)
