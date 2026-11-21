<div align="center">

# DSH Compaction Weave

**压缩上下文，保留要求，延续工作。**

面向 DeepSeek Harness 的上下文压缩插件，让长对话带着明确的目标、有效约束和下一步继续推进。

[简体中文](README.md) · [English](README.en.md)

[![Release](https://img.shields.io/github/v/release/NightFrost42/dsh-compaction-weave?style=flat-square&color=5865F2)](https://github.com/NightFrost42/dsh-compaction-weave/releases/latest)
[![npm](https://img.shields.io/npm/v/dsh-compaction-weave/latest?style=flat-square&color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-compaction-weave)
[![CI](https://img.shields.io/github/actions/workflow/status/NightFrost42/dsh-compaction-weave/ci.yml?style=flat-square)](https://github.com/NightFrost42/dsh-compaction-weave/actions/workflows/ci.yml)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.2--rc.1%20%3C1.0.0--0-4D6BFE?style=flat-square)](docs/configuration.md)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524.9-339933?style=flat-square&logo=node.js&logoColor=white)](docs/development.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-22A06B?style=flat-square)](LICENSE)
[![Languages](https://img.shields.io/badge/docs-%E4%B8%AD%E6%96%87%20%7C%20English-0F766E?style=flat-square)](README.en.md)

增量压缩 · 要求保留 · 历史回查 · 审计校验 · 故障诊断

[安装与升级](#安装与升级) · [快速上手](#快速上手) · [压缩原理](docs/principles.md) · [基本设置](#基本设置) · [测试与验证](#测试与验证) · [诊断与反馈](#诊断与反馈) · [更新日志](CHANGELOG.md)

</div>

## 用途与能力

长对话会逐步积累工具输出、日志、旧方案和重复讨论。默认配置下，DSH Compaction Weave 采用**“先轻折超大工具输出、不够再总结对话”**的两级整理策略，在检查点中保留**当前任务、仍有效的用户要求、已完成进度和下一步动作**，同时把被替换的原始消息与附件写入本地归档，供后续按需检索与分段读取。

- **两级整理与同路由缓存复用**：近期尾部之外超过 `4000` 字的非报错工具结果会先归档并折叠为“开头 + 结尾预览 + `history_read` 指引”，若空间已够直接结束、无需调用总结模型；确实需要总结时，优先保留稳定前缀与已有检查点，同模型路由在预算内原样保持请求前缀，尽量命中服务商缓存。
- **通道隔离与要求进度校验**：基于宿主事件角色与 `<untrusted_reference>` / `<quoted_text>` 等显式标签区分真实用户指令与外部引用，避免把网页正文、日志或工具返回误当成用户命令；独立核对数值、条件、禁止事项、授权出处、作用对象与显式 `key: value` 结构化任务进度。
- **分页接续与归档回查**：遇到超长历史或单次容量受限时，可按页保存已完成进度并接续处理；标准检查点自动携带 `History archive` 指针与涉及文件列表，配合 `history_list`、多词 `history_search` 与 `history_read` 按需精准回查。

## 压缩是怎样工作的

当上下文接近触发线、闲置超时或收到压缩指令时，在开启归档的默认配置下，插件会先评估能否只靠折叠旧的超大工具输出达标；不够或需要总结时，再选出工具调用完整配对的历史区间，生成结构化候选摘要，并把预算内的近期用户原话确定性填入检查点。候选检查点通过结构、体积缩小、有效要求、授权出处与 `key: value` 进度核对后，插件先把原始事件写入本地归档，核验宿主存储方法指纹并完成单趟哈希备份后，以事务方式替换当前可见历史。完整流程、数学预算、归档开关边界和恢复机制见 [压缩原理与示意图](docs/principles.md)。

## 安装与升级

支持 **DeepSeek Harness `>=0.2.2-rc.1 <1.0.0-0`**（`0.2.2-rc.1` 起的 `0.2.x–0.x` 系列），原生原子事务已实测 **DSH `0.2.2-rc.1`、`0.2.2-rc.2`、`0.2.2-rc.3`**，并在默认 `strictHostFingerprints: false` 下支持宿主后续小版本调整私有持久化方法时平顺降级至公开 `Session.append(replace)` + `sessions.flush()`（同时继续拦截未恢复 `.rollback`/`.tail` 日志），运行环境需 **Node.js 24.9+**。正式版已同步发布到 **[npm（`latest`）](https://www.npmjs.com/package/dsh-compaction-weave)** 与 [GitHub Releases](https://github.com/NightFrost42/dsh-compaction-weave/releases/latest)：优先推荐通过 npm 安装 `dsh-compaction-weave`（自动跟踪 `latest` 更新提示并免除 `allowBuilds` 构建授权），也可使用 Releases 页面提供的 `dsh-compaction-weave.tgz`（无版本号最新包）、`dsh-compaction-weave-0.3.3.tgz` 或本地打包生成的 `.tgz` 文件。

### 桌面端

- **通过 npm / 插件市场安装（推荐，可自动获取更新）**：在 `dsh-market` 搜索或点击安装 `dsh-compaction-weave`（或使用 **插件 → 添加插件** 安装 npm 包名 `dsh-compaction-weave`），后续将自动跟踪 npm `latest` 标签提示升级。
- **通过离线 `.tgz` 手动安装 / 升级**：
  1. 从 [Releases 页面](https://github.com/NightFrost42/dsh-compaction-weave/releases/latest) 下载 `dsh-compaction-weave.tgz` 或 `dsh-compaction-weave-0.3.3.tgz`。
  2. 升级安装时，先在 **插件** 页面卸载旧版 Weave，保留独立存储目录中的历史归档与设置；首次安装可跳过此步。
  3. 打开 **插件 → 添加插件**，填入安装包绝对路径（如 `C:/Downloads/dsh-compaction-weave-0.3.3.tgz`），完成安装并启用。
  4. **重启 DSH**，在插件详情页确认版本号已更新。

### 命令行

停止目标 profile 后执行安装或覆盖升级。推荐直接从 npm 安装（自动绑定 `latest` 并免 `allowBuilds`）：

```bash
dsh plugin --profile web add dsh-compaction-weave
```

如需离线安装或手动指定版本 `.tgz` 包，也可改用本地文件路径：

```bash
dsh plugin --profile web add /absolute/path/dsh-compaction-weave-0.3.3.tgz
```

请将 `web` 替换为实际使用的命令行 profile 名称，完成后重新启动该 profile。桌面端用户请参考上方的插件管理页流程。

## 快速上手

插件启用后即可正常对话。默认情况下，Weave 跟随当前会话模型生成摘要，并在上下文接近阈值时自动规划压缩（自动模式以释放至少 **20%** 输入空间为规划目标）。

- **手动触发**：在对话框输入 `/compact` 立即尝试压缩，或在后台分页暂停后继续剩余页面。
- **阶段收尾申请**：可让模型在完成阶段任务后调用 `context_compact` 提交申请。工具返回 `queued` 表示已进入队列，插件会在当前工具批次结束后的安全步骤检查上下文增长与可压缩区间，满足条件时执行压缩并返回 `compacted`、`partial` 或 `failed`，不满足条件或插件已停止时返回 `skipped`、`blocked` 等最终回执；查看后续回执即可确认结果。
- **回查原文**：需要核对早期报错、路径或代码细节时，可提醒或直接向模型提问，模型可按需调用以下工具检索本地归档：

| 工具 | 作用 |
| --- | --- |
| `context_compact` | 在阶段任务边界排队申请上下文压缩 |
| `history_list` | 查看已归档的历史消息区间 |
| `history_search` | 按关键词检索已归档历史 |
| `history_read` | 分段读取原始消息与附件内容 |

## 基本设置

在 **设置 → 摘要模型**（或插件详情页）中修改常用项，**保存后无需重启 DSH，后续操作使用新设置；进行中的压缩保留原设置**。

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| 摘要供应商和模型 | 跟随会话 | 留空时复用当前对话模型，也可单独指定摘要模型 |
| 摘要输出上限 | 8192 tokens | 单次摘要响应允许的最大输出长度 |
| 自动压缩触发比例 | 80% | 与主回答输出预留和提前量共同决定实际触发线 |
| 最小压缩幅度 | 20% | 自动压缩规划期望释放的输入空间比例 |
| 失败重试次数 | 2 次 | 首次请求失败后最多追加尝试 2 次 |
| 重试基础间隔 | 1 秒 | 连续重试时按指数退避延长等待（上限 30 秒） |
| 每次摘要等待上限 | 180 秒 | 单次摘要请求的超时时间 |
| 闲置后先压缩 | 关闭 | 预设或自定义 1–43200 分钟（30 天）；超过间隔后先压缩已有历史再继续 |

重试设置可独立于摘要模型生效。前缀保留、近期原话预算、摘要语言（自动 / 中文 / 英文）、后台分页参数，以及关闭本地归档（`archiveEnabled: false`）时的功能限制见 [配置指南](docs/configuration.md) 与 [压缩原理与示意图](docs/principles.md)。

## 测试与验证

- **正式版 `0.3.2`（2026-11-19 宿主兼容放宽、两级整理、通道隔离、JSON 解包与计费保护后）**：Windows / Node.js / DSH `0.2.2-rc.3` 实测全部 **51 套活动套件、1,059 项断言全部通过，0 失败**（包含 **44 套离线单元测试 / 941 项** 与 **7 套真实 DSH `0.2.2-rc.3` 宿主集成测试 / 118 项**，含 `strictHostFingerprints: false` 降级与阻断测试、20 项修复回归 `astra-review-fixes.mjs` 及 9 项资金/额度熔断压测 `release-billing-safety.mjs`）；与 `v0.3.2-rc.4`（`a41b41a`）配对基准实测重工具输入省下 100% 摘要调用（`1 → 0` 次、`7329.35 ms → 19.36 ms`）、同路由原样前缀从 `60%`（`654 B`）提升至 `100%`（`12,215 B`）、结构化进度校验提速约 `108×`、`2.1 MB` 原生事务提交提速 `14.2%`，运行库体积净减 `2.66%`（`748,804 → 728,876 B`），详见 [逐套结果与提升对比](docs/benchmarks/v0.3.2-tests.json)。此前强绑定特定业务词表与旧自然语言猜测正则的 21 套历史测试已归档至 [`test/archived-regex/`](test/archived-regex/README.md)，退出日常测试入口；重构前基线快照（67 套、2064 项）留存于 [逐套结果基线](docs/benchmarks/rc4-tests.json)。

- **四模型 × 四系统无失真真实网关对比基准（2026-11-19 单轮实盘观测，详见 [`docs/benchmarks/v0.3.2-live-four-way.json`](docs/benchmarks/v0.3.2-live-four-way.json)）**：恢复 `dsh-basic` 原生满额 `headroomTokens: 65536` 与 `CHAT_MAX_TOKENS=16384`、为 `billion-context@0.1.216` 全程注入持久 `x-acp-session` + `ccr` 与 `<acp-nudge>` 并采用独立非重复代码/SQL 用例（未核实字段显式允许 `null`）。GPT 槽位因网关限制 `auto/gpt-6-astra` 仅官方 Codex 客户端可用（`Codex` 内已完成代码与基准对抗复核；DSH 普通 HTTP 请求不伪造客户端头），因此 Suite A 使用 `2-2/gpt-6.1-sol`、Suite C 使用 `auto/gpt-6.1-sol`（连同 `auto/gemini-4-argon`、`auto/glm-5.3-flash`、`deepseek/deepseek-flash`）：
  - **Suite A · 单模型独立 32 分支**（4 模型 × 4 系统 × `w1` 工程规格演进 + `w2` 重工具排障）：**`weave-0.3.2` 8/8 全部完成且总分最高 `175/176 (99.43%)`**——`w1` 4/4 模型 `144/144`（压缩均耗时 `26.88 s`，比 `dsh-basic` `56.81 s` 快 `2.11×`）、`w2` `31/32` 仅耗 **`35.8 ms`**（**0 次摘要调用**，均有效/本地压缩 `72.20%`，总花 `$1.0821` / 标准化 `$0.8539`）；`rc.4` 仅完成 `5/8`（3 组 `w1` 被旧 `PROGRESS_FACT_CONFLICT` 拦截，已完成 `62/68 = 91.18%`，占总测题 `62/176 = 35.23%`）；`dsh-basic` 完成 `8/8` 但 `w2` 跌至 **`20/32 (62.50%)`**（`ToolResultPruner` 头尾截断永久丢弃文件中间常量且无归档工具）；`billion-context` 完成 `8/8` 总分仅 **`155/176 (88.07%)`**（`w2` 跌至 **`11/32 (34.38%)`**，`gpt`/`deepseek` 均 `0/8`），本地请求反膨胀 **`-13.95%`**，耗资 `$1.6899` / `$1.3999`。
  - **Suite B · 连续 5 次压缩（`C1–C5`）× 6 轮恢复（`R1–R6`）缓存与速度**：揭示压缩后首次缓存读与稳态恢复的真实规律——`R1` 为更换前缀后首次写入（合并归零、增量约 `33%`），自 `R2–R6` 起 **`weave-0.3.2` 在 DeepSeek 与 GLM 全部 5 轮均稳定恢复至 `97%–99%`**，且摘要调用自身持续命中前缀缓存（DeepSeek `compactionSelfPct` 达 **`85.94%–95.52%`**，GLM 增/合复用 **`37.68%–65.37%`**；`dsh-basic` 摘要自身始终 `0%`）。DeepSeek 上 `weave-0.3.2` `100/100`、压缩 `45.99 s`（快 `rc.4` `2.77×`、快 `billion-context` `3.78×`）、仅 `$0.0419`（`billion-context` 跌至 `88/100` 且全线倒挂 `-27.75%..-189.07%`）；GLM 上 `weave-0.3.2` `100/100`、压缩仅 **`107.65 s`**（比 `dsh-basic` `431.44 s` 快 **`4.01×`**，比 `billion-context` `351.90 s` 快 **`3.27×`**，端到端快 **`2.83×`**，`rc.4` 则因预算溢出失败）。
  - **Suite C · 四模型 19 次连续切换**（`Gemini → GLM → DeepSeek → auto/gpt-6.1-sol`，共 226 项检查）：**`weave-0.3.2` 4/4 压缩全部一次过审（4 次摘要调用、0 重试）、`226/226 (100%)`、压缩 `114.86 s`（400.74 s 端到端）、四代平均压缩 `60.00%`（`$0.6077` / `$0.4915`）**；`rc.4` 第 4 代 GPT 失败（`3/4`、`7` 次摘要、`224.45 s`、`226/226` 系第 4 代未压缩直接回放）；纯文本基线 `dsh-basic` `4/4`（`226/226`、压缩 `118.40 s`、`$0.5935` / `$0.4811`，不保第 6 节逐字原话与工具归档）；`billion-context` 发起 `15` 次压缩与 `48` 次请求（端到端 `875.97 s` 慢 `2.19×`），第 1 代膨胀 `-36.31%`，总花 `$0.8260` / `$0.6873`。

- **离线与宿主回归**：`0.3.2-rc.3` 在 Windows（Node.js 24.21.0，分别搭配 DSH `0.2.2-rc.1` 与 `0.2.2-rc.3`）及 Linux（Node.js 24.9.0，分别搭配 DSH `0.2.2-rc.2` 与 `0.2.2-rc.3`）均通过 **56 套、1698 项**测试（其中离线 **50 套、1597 项**，真实宿主集成 **6 套、101 项**，含新增 8 项宿主事务、范围准入与未知实现拒绝检查），全部 0 失败；明细见 [`docs/benchmarks/rc3-host-compatibility.json`](docs/benchmarks/rc3-host-compatibility.json)。
- **四模型连续切换实测**：在移除旧手动接续命令并补充诊断元数据前的内部版本（`0.3.2-rc.1`）上，联网验收覆盖 **Gemini 4 Argon → GLM → DeepSeek → GPT**，连续完成 4 次压缩（每次 1 次摘要请求）、24 次模型切换与 60 次 HTTP 请求，**728 / 728** 个状态字段和 **77 / 77** 项流程结构检查全部通过。
- **策略与费用评估**：配对实验对比了既有增量与完整合并策略同实验性局部合并方案，计入内容不合格与误拒重生成及压缩后 6 次接续回答，排除网络和供应商请求失败。实测显示既有策略跨模型表现更稳健，因此保持既有策略且不在压缩后额外预热。

上下文压缩属于有损摘要加按需归档回查，输入 tokens 缩减比例与实际账单变化受缓存命中、重生成和模型计费规则影响；完整实验条件、GLM 代理单价情景估算及历史测试结果见 [测试记录](docs/testing.md)。

## 诊断与反馈

遇到报错、摘要被拒或压缩后遗漏信息时，可按以下步骤排查与反馈：

1. 在 [GitHub Issues](https://github.com/NightFrost42/dsh-compaction-weave/issues/new/choose) 选择中文或英文模板，描述问题现象、复现步骤与预期表现。
2. **日志附件完全可选**。附上对应操作的诊断日志通常有助于更快定位问题；诊断文件已自动记录插件版本、支持的 DSH 版本范围 `supportedDshVersion`（`actualDshVersion` 仍为 `null`，可在 Issue 中补充实际安装的 DSH 版本）、配置的模型路由、有效设置、尝试记录、错误分类和返回用量，无需手动抄写。
3. **隐私提示**：诊断日志与关联审计文件可能包含本地路径、对话原文或业务信息。将原始文件发给云端 AI 本身属于信息分享，AI 脱敏也可能遗漏敏感内容或改动关键证据。提交前请人工复查脱敏副本，拿不准时可不附日志。详细说明与脱敏提示词见 [提交问题与日志脱敏](docs/feedback.md)。

## 文档与开发

| 简体中文 | English |
| --- | --- |
| [配置指南](docs/configuration.md) | [Configuration](docs/en/configuration.md) |
| [压缩原理与示意图](docs/principles.md) | [Compaction principles](docs/en/principles.md) |
| [代码导航](docs/architecture.md) | [Architecture](docs/en/architecture.md) |
| [提交问题与日志脱敏](docs/feedback.md) | [Reporting & redaction](docs/en/feedback.md) |
| [故障排查](docs/troubleshooting.md) | [Troubleshooting](docs/en/troubleshooting.md) |
| [测试记录](docs/testing.md) | [Testing](docs/en/testing.md) |
| [开发与发布](docs/development.md) | [Development & releases](docs/en/development.md) |

项目采用原生 JavaScript ES modules，无需构建步骤，可在本地直接运行测试与打包：

```bash
git clone https://github.com/NightFrost42/dsh-compaction-weave.git
cd dsh-compaction-weave
npm test
npm run check
npm run pack:release
```

## License

[MIT](LICENSE)

---

感谢 [LINUX DO](https://linux.do/) 提供技术交流与开源分享的社区空间。
