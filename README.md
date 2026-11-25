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

- **两级整理与同路由缓存复用**：近期尾部之外超过 `4000` 字的非报错工具结果会先归档并折叠为“开头 + 结尾预览（支持 Tier-4 异常聚簇/骨架预览） + `history_read` 指引”，若空间已够直接结束、无需调用总结模型；确实需要总结时，优先保留稳定前缀与已有检查点，同模型路由在预算内原样保持请求前缀，尽量命中服务商缓存。
- **通道隔离、脱敏重注入与要求进度校验**：基于宿主事件角色与 `<untrusted_reference>` / `<quoted_text>` 等显式标签区分真实用户指令与外部引用，避免把网页正文、日志或工具返回误当成用户命令；默认 `auditCoverageScope: 'recent'` 收敛近期覆盖率并全局强制执行数字/单位换算、条件、正反同义/禁用极性、授权出处与 `key: value` 结构化进度校验；支持压缩后工作区文件凭据/未闭合私钥脱敏重注入及确定性相对日期锚定。
- **分页接续与 BM25F 归档回查**：遇到超长历史或单次容量受限时，可按页保存已完成进度并接续处理；默认采用 Node 24 原生 `zstd` 无损归档，标准检查点自动携带 `History archive` 指针与涉及文件列表，配合 `history_list`、纯 JS BM25F 多字段 `history_search` 与严格模式兼容的 `history_read` 按需精准回查。

## 压缩是怎样工作的

当上下文接近触发线、闲置超时或收到压缩指令时，在开启归档的默认配置下，插件会先评估能否只靠折叠旧的超大工具输出达标；不够或需要总结时，再选出工具调用完整配对的历史区间，生成结构化候选摘要，并把预算内的近期用户原话确定性填入检查点。候选检查点通过结构、体积缩小、有效要求、授权出处与 `key: value` 进度核对后，插件先把原始事件写入本地归档，核验宿主存储方法指纹并完成单趟哈希备份后，以事务方式替换当前可见历史。完整流程、数学预算、归档开关边界和恢复机制见 [压缩原理与示意图](docs/principles.md)。

## 安装与升级

> [!IMPORTANT]
> **给 AI 安装助手 / 自动化配置代理的互斥安装指引**
>
> 1. **先检查冲突再动手**：安装或启用 `dsh-compaction-weave` 前，请先检查目标环境中是否已安装/启用 `billion-context`（含 `billion-context-dsh`），或模型供应商配置（`baseUrl`）是否仍指向 `127.0.0.1` / `localhost` 上的 `bili` 本地代理端口。
> 2. **发现并存时先停下询问用户**：两个压缩插件**禁止同时开启**；若检测到已安装/启用 `billion-context`，必须先停下并明确询问用户“保留哪一个上下文压缩插件”，切勿自行直接启用双插件并存。
> 3. **确认选择 Weave 后的清理与迁移提示**：先停用或卸载 `billion-context`、将供应商 `baseUrl` 还原为直连上游地址；如有需要保留的旧会话历史，可向用户说明重启后可在会话中使用 `/compact migrate`（或进度卡片按钮）先备份再安全转换为 Weave 格式。
> 4. **务必明确提醒彻底重启 DSH**：无论是在插件管理页关闭还是卸载 `billion-context`，只要刚改过启用状态或代理配置，都必须**明确提醒用户彻底重启一次 DSH 主程序**（仅热停用仍可能遗留同进程内存钩子与本地代理端口导致 `BILI_COEXISTENCE_CONFLICT` / `413` 冲突）。

支持 **DeepSeek Harness `>=0.2.2-rc.1 <1.0.0-0`**（`0.2.2-rc.1` 起的 `0.2.x–0.x` 系列），原生原子事务已实测 **DSH `0.2.2-rc.1`、`0.2.2-rc.2`、`0.2.2-rc.3`**，并在默认 `strictHostFingerprints: false` 下支持宿主后续小版本调整私有持久化方法时平顺降级至公开 `Session.append(replace)` + `sessions.flush()`（同时继续拦截未恢复 `.rollback`/`.tail` 日志），设置页 RPC 已接入 `webserver/index-inject` 进程级随机 `x-weave-rpc-token`（兼容 DSH Desktop `0.2.3-alpha.2+` 并拦截非 `owner` 访问），运行环境需 **Node.js 24.9+**。正式版已同步发布到 **[npm（`latest`）](https://www.npmjs.com/package/dsh-compaction-weave)** 与 [GitHub Releases](https://github.com/NightFrost42/dsh-compaction-weave/releases/latest)：优先推荐通过 npm 安装 `dsh-compaction-weave`（自动跟踪 `latest` 更新提示并免除 `allowBuilds` 构建授权），也可使用 Releases 页面提供的 `dsh-compaction-weave.tgz`（无版本号最新包）、`dsh-compaction-weave-0.6.0.tgz` 或本地打包生成的 `.tgz` 文件。

### 桌面端

- **通过 npm / 插件市场安装（推荐，可自动获取更新）**：在 `dsh-market` 搜索或点击安装 `dsh-compaction-weave`（或使用 **插件 → 添加插件** 安装 npm 包名 `dsh-compaction-weave`），后续将自动跟踪 npm `latest` 标签提示升级。
- **通过离线 `.tgz` 手动安装 / 升级**：
  1. 从 [Releases 页面](https://github.com/NightFrost42/dsh-compaction-weave/releases/latest) 下载 `dsh-compaction-weave.tgz` 或 `dsh-compaction-weave-0.6.0.tgz`。
  2. 升级安装时，先在 **插件** 页面卸载旧版 Weave，保留独立存储目录中的历史归档与设置；首次安装可跳过此步。
  3. 打开 **插件 → 添加插件**，填入安装包绝对路径（如 `C:/Downloads/dsh-compaction-weave-0.6.0.tgz`），完成安装并启用。
  4. **重启 DSH**，在插件详情页确认版本号已更新。

### 命令行

停止目标 profile 后执行安装或覆盖升级。推荐直接从 npm 安装（自动绑定 `latest` 并免 `allowBuilds`）：

```bash
dsh plugin --profile web add dsh-compaction-weave
```

如需离线安装或手动指定版本 `.tgz` 包，也可改用本地文件路径：

```bash
dsh plugin --profile web add /absolute/path/dsh-compaction-weave-0.6.0.tgz
```

请将 `web` 替换为实际使用的命令行 profile 名称，完成后重新启动该 profile。桌面端用户请参考上方的插件管理页流程。

## 快速上手

插件启用后即可正常对话。默认情况下，Weave 跟随当前会话模型生成摘要，并在上下文接近阈值时自动规划压缩（自动模式以释放至少 **20%** 输入空间为规划目标）。

- **手动触发**：在对话框输入 `/compact` 立即尝试压缩，或在后台断点暂停后继续剩余分块/页面；也可使用 `/compact resume`、`/compact cancel`、`/compact discard` 直接控制续压与暂停，或 `/compact reset` 重置熔断计数器。
- **实时进度与中断续压**：压缩或迁移期间，对话输入框上方会显示与输入框等宽的实时进度卡片（含总进度、当前分块与并发度），支持随时点击 **`[暂停]`**；主动暂停或意外崩溃重启后均自动保留断点，打开会话可见 **`[继续压缩]`** / **`[继续转换]`** 与 **`[放弃]`**，继续发送新消息也会自动从断点接续压缩（不重复已提交分块）。
- **`billion-context` 兼容迁移与完整备份还原**：仅在检测到会话存在 `billion-context` 折叠块时，卡片出现「兼容转换为 Weave」入口；转换前自动拍下不可变 SHA-256 完整会话基线备份并支持多波次滚雪球迁移，后续可随时在卡片内按本地时间选择快照还原。
- **阶段收尾申请**：可让模型在完成阶段任务后调用 `context_compact` 提交申请。工具返回 `queued` 表示已进入队列，插件会在当前工具批次结束后的安全步骤检查上下文增长与可压缩区间，满足条件时执行压缩并返回 `compacted`、`partial` 或 `failed`，不满足条件或插件已停止时返回 `skipped`、`blocked` 等最终回执；查看后续回执即可确认结果。
- **回查原文**：需要核对早期报错、路径或代码细节时，可提醒或直接向模型提问，模型可按需调用以下工具检索本地归档：

| 工具 | 作用 |
| --- | --- |
| `context_compact` | 在阶段任务边界排队申请上下文压缩 |
| `history_list` | 查看已归档的历史消息区间 |
| `history_search` | 基于 BM25F 多字段相关性检索已归档历史 |
| `history_read` | 分段读取原始消息与附件内容（兼容严格工具 `null`/空字符串参数） |

## 基本设置

在 **设置 → 上下文压缩（Weave）**（或插件详情页）中修改常用项，**保存后无需重启 DSH，后续操作使用新设置；进行中的压缩保留原设置**。

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| 摘要供应商和模型 | 跟随会话 | 留空时复用当前对话模型，也可单独指定摘要模型 |
| 摘要输出上限 | 8192 tokens | 单次摘要响应允许的最大输出长度 |
| 摘要并发数 | 2 | 允许 1–6 路受控并发生成与审计（严格按序提交），遇 HTTP 429 自动降回并发 1 冷却 |
| 摘要推理强度 | `auto` | 默认按路由自适应（仅 Anthropic/Claude 同路由继承主会话思考强度以复用提示词缓存；非 Anthropic 路由有思考时自动压到 `low`；主会话未开启思考时保持不传）。也支持直接指定 `low`、`none`、`minimal`、`medium`、`high`、`xhigh`、`max` 或 `inherit`（不支持时自动逐级向下回退并省略） |
| 第一级归档存根掩码 | `开启` | 压力或手动压缩时先以 0 LLM 尝试将旧大体积工具结果折叠为带 `history_read` 指针的存根，达标则免除摘要模型调用 |
| CJK 预算保守权重 | `0.75` | `0.5–1.5`；内部长度规划对 CJK/假名/韩文的启发式系数（非外置 BPE 精确分词）。默认 `0.75` 使 128k 中文会话正常保留前部 KV 缓存，需兼容较碎分词器时可调到 `1.0` |
| 覆盖率审计窗口范围 | `'recent'` | 聚焦近期原话窗口与本跨度新增要求的覆盖率审计（`'recent'` / `'span-new'` / `'all'`），防止超长历史迁移卡死；冲突红线（极性/数值/条件/溯源等）三档始终全局强执行 |
| 保留审计严格阻断 | 开启 | 默认对未通过保留校验的摘要阻断重生成；关闭（`auditBlockOnLoss: false`）后改为仅记录告警并放行 |
| 自动压缩熔断后策略 | `confirm` | 连续失败熔断后控制卡片提供手动重试、两步确认暂跳过自动压缩（`confirm`），或仅警告放行（`degrade`）/ 严格阻断（`block`） |
| 自动压缩触发比例 | 80% | 与主回答输出预留和提前量共同决定实际触发线 |
| 最小压缩幅度 | 20% | 自动压缩规划期望释放的输入空间比例 |
| 失败重试次数 | 2 次 | 首次请求失败后最多追加尝试 2 次 |
| 重试基础间隔 | 1 秒 | 连续重试时按指数退避延长等待（上限 30 秒） |
| 每次摘要等待上限 | 180 秒 | 单次摘要请求的超时时间 |
| 闲置后先压缩 | 关闭 | 预设或自定义 1–43200 分钟（30 天）；超过间隔后先压缩已有历史再继续 |

重试与输出上限（支持未选摘要模型时单独保存 `maxTokens`）可独立生效；点击“清除（跟随会话模型）”会清除模型覆盖与独立输出上限并保存其余热生效开关。前缀保留、近期原话预算、工作区脱敏重注入、摘要语言（自动 / 中文 / 英文）、后台分页参数，以及关闭本地归档（`archiveEnabled: false`）时的功能限制见 [配置指南](docs/configuration.md) 与 [压缩原理与示意图](docs/principles.md)。

> **估算口径与常驻工具 Schema 开销说明**：
> - **Token 估算口径**：插件内置快速启发式估算器（CJK 字符按 `summaryCjkTokensPerChar` 默认 `0.75` 加权、ASCII 字符按 `1/4` 近似），无需依赖外部大型 BPE 运行库；实际计费与上限判定仍以上游模型 BPE 分词器为准（需要更保守兼容较碎分词器时，可在设置页将 `summaryCjkTokensPerChar` 调至 `1.0`）。
> - **常驻工具 Schema 体积**：启用历史工具与主动压缩后，每轮会随系统工具表常驻注入 4 个工具定义（`history_list` 271 字符、`history_read` 1,389 字符、`history_search` 385 字符、`context_compact` 513 字符），序列化 JSON 总计 **2,563 字符 / 645 DSH tokens / 约 697 BPE tokens**（BPE 随分词器而异；若通过配置关闭 `proactiveEnabled`，可省去 `context_compact` 的 513 字符定义）。

## 与 `dsh-world` 共存及第三方桥接隔离

- **与 `dsh-world` 共存（Issue #4）**：如果同时安装并启用了 `dsh-world` 的压缩替换（`compactionSwapped` / `dsh-world/compaction`），它会把官方 `@deepseek-ai/dsh-compaction-basic` 行从配置树替换掉，导致 Weave 找不到官方行而**静默未挂载**。若要保留 `dsh-world` 的日记、`memory_find` 与记忆注入同时由 Weave 负责压缩：
  - 预设模式：在 World Console 点击 **概览 → 会话预设 → 还原 DSH 预设**；
  - 非预设模式：在 `dsh-world` 配置中设置 `replaceCompaction: false`。
- **第三方 IM 桥接通道与裸注入前缀隔离（Issue #6 / #7A）**：Weave 已内置将 `wechat`、`qq`、`wechat-bridge`、`qq-bridge`、`im-bridge` 等桥接来源及常见多行记忆注入头（如 `===== 长期记忆 =====`、`===== Long-Term Memory =====`、`【记忆导引】`）按非用户参考数据隔离（不参与 Section 6 保留与约束/极性审计）；若你使用的第三方桥接或插件带有自定义 `source.kind` 或裸前缀，可在配置中加入 `extraReferenceSourceKinds` / `extraReferencePrefixes`（见 [配置指南](docs/configuration.md)）。

## 测试与验证

- **正式版 `0.6.0` 全量离线与双宿主集成回归（2026-11-25）**：
  - `npm run check`：检查 **`288` 个发布源文件**，通过包合规、语法、链接、敏感信息与 **`91` 个非客户端 ESM 模块 `0` 环 DAG** 校验；
  - `npm test`：**`103` 套离线单元测试 / `1,479` 项断言全部通过，0 失败**；
  - 真实 DSH 宿主集成测试：在 Windows / Node.js `v24.19.0` 上针对隔离的 **DSH `0.2.2-rc.1`** 与 **DSH `0.2.2-rc.3`** 各自通过全部 **`111` 套 / `1,610` 项用例，0 失败**（覆盖原生 `.rollback` 原子事务、`webserver/index-inject` Token 与非 owner `403` 鉴权、未闭合 PEM 脱敏回注、严格工具 `null` 参数规范化与并发锁隔离）。

- **真实模型网关三方无失真对比（`Weave 0.6.0` vs `DSH Basic` vs 最新版 `billion-context@0.0.1328-master.ced22b1`，2026-11-25 实盘观测，详见 [`docs/benchmarks/v0.6.0-live-three-way.json`](docs/benchmarks/v0.6.0-live-three-way.json)）**：
  - 实测选用当前网关可用三组模型：**`Gemini 4 Neon`**（`group/gemini-4-neon`）、**`GPT-6.1 Sol`**（`auto/gpt-6.1-sol`，Codex 专用槽位 403 自动切换同模 `anyrouter/gpt-6.1-sol`）与 **`DeepSeek-V4.1-Flash`**（`deepseek/deepseek-flash`）；对照方 `dsh-basic` 使用原生满额 `headroomTokens: 65,536`，`billion-context` 使用当日最新 master 版 `0.0.1328-master.ced22b1` 并全程持久化注入 `x-acp-session` 与 `ccr: true`。
  - **Suite A · 单模型独立 18 分支**（3 模型 × 3 系统 × `w1` 工程规格演进 + `w2` 重工具排障，每系统 `132` 项检查）：
    - **`weave-0.6.0`**：**6/6 全完成、总准确率最高 `131/132 (99.24%)`** —— `w1` `108/108 (3/3)`、`w2` **`23/24 (95.83%)`**（`Gemini` **`8/8`**、`GPT-6.1 Sol` **`8/8`**、`DeepSeek` **`7/8`**），`w2` 全部 **0 次摘要模型调用**、均耗时仅 **`75.67 ms`**（`w1` 均耗 `48.54 s` 快于 `dsh-basic` `56.29 s`），均值有效/本地压缩率 **`76.07%`**，总花费 `$1.0200` Magpie / `$0.7632` 标准化 USD；
    - **`dsh-basic`**：6/6 完成、总准确率 **`123/132 (93.18%)`** —— `w1` `108/108`，`w2` 跌至 **`15/24 (62.50%)`**（`Gemini 6/8`、`GPT 5/8`、`DeepSeek 4/8`，头尾切片永久丢弃文件中间常量且无归档工具），均值压缩率 `58.91%`，花费 `$0.7912` / `$0.6057`；
    - **`billion-context@0.0.1328-master.ced22b1`**：6/6 完成、总准确率 **`114/132 (86.36%)`** —— `w1` `108/108`，`w2` 跌至 **`6/24 (25.00%)`**（`Gemini 3/8`、`DeepSeek 3/8`、`GPT 0/8`），`w2` 平均耗 `39,695 ms`，本地线缆均值压缩仅 **`3.53%`**（有效 `40.38%`），且总花费最高（`$1.1478` Magpie / `$0.9989` 标准化，比 `weave-0.6.0` 高 `30.9%`）。
  - **Suite B · 连续 5 次压缩（`C1–C5`）× 6 轮恢复（`R1–R6`）缓存与花费（`DeepSeek-V4.1-Flash` & `GPT-6.1 Sol`，共 6 条轨迹）**：三套系统均取得 `100/100`；`DeepSeek` 上 **`weave-0.6.0` 摘要请求自命中缓存 `86.59%–95.15%`（`dsh-basic` 为 `0%`）、`R2` 恢复 `98.36%–98.89%`、`R6` `96.41%–98.05%`、全轨迹总缓存命中率 `72.11%` 最高且总花费最低 `$0.0410`**（`dsh-basic` `$0.0584` / `52.15%`，`billion-context` `$0.0879` 达 **`2.15×`** 且压缩耗 `252.86 s` 慢 **`3.43×`**、Cycle 1 膨胀 `-34.95%`）；`GPT-6.1 Sol` 上 **`weave-0.6.0` 摘要自命中 `45.76%–58.96%`、全轨迹总命中 `64.48%` 最高且总花费最低 `$0.7789` / `$0.3895`**（`dsh-basic` `$0.8315` / `$0.4158`、`billion-context` 5 轮全线净膨胀 **`-7.15%` 至 `-38.42%`**、总耗 `926.99 s` 且花费 `$1.1885` / `$0.5943` 达 **`1.53×`**）。
  - **Suite C · 多模型 15 次连续切换**（`Gemini 4 Neon → DeepSeek-V4.1-Flash → GPT-6.1 Sol → DeepSeek-V4.1-Flash`，共 186 项检查）：**`weave-0.6.0` `4/4` 压缩全部一次通过、`186/186 (100%)`、端到端总耗时最快 `275.62 s`、每代净压缩 `56.15%–67.72%` 且总花费最低 `$0.6042` Magpie / `$0.4906` 标准化**；`dsh-basic` `4/4`、`186/186`（不保第 6 节逐字原话与工具归档）、端到端耗时 `476.54 s`（慢 `1.73×`）、`$0.6482` / `$0.5116`；`billion-context@ced22b1` 期间共触发 `15` 次自主压缩请求、第 1 代净膨胀 **`-30.97%`**、第 3 代净膨胀 **`-8.07%`**，端到端 `415.96 s` 且总花费 **`$0.8623` / `$0.7139`**（比 `weave-0.6.0` 贵 **`42.7%` / `45.5%`**）。

上下文压缩属于有损摘要加按需归档回查，输入 tokens 缩减比例与实际账单变化受缓存命中、重生成和模型计费规则影响；完整多套件测试条件、DSH 真实宿主长会话对照及更多实验明细见 [测试记录](docs/testing.md)。

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
