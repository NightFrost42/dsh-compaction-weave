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

长对话会逐步积累工具输出、日志、旧方案和重复讨论。默认配置下，DSH Compaction Weave 采用**分层整理策略**——平时先零开销折叠超大工具输出与冷历史、不够时再调用模型总结对话——在检查点中保留**当前任务、仍有效的用户要求、已完成进度和下一步动作**，同时把被替换的原始消息与附件写入本地无损归档，供后续按需精准回查：

- **分层压缩与缓存友好**：超出热保留区的非报错大体积工具结果会先归档并折叠为带回查指针的紧凑预览，若空间已够便直接跳过总结模型；需要摘要时，优先保留稳定前缀与已有检查点，同路由场景下尽量延续提示词缓存。
- **来源隔离、脱敏重注入与客观审计**：依据消息来源与引用标签区分真实用户指令和外部网页、日志或工具返回，避免误将参考文本当作用户命令；压缩后自动校验数字/单位、条件、正反极性与明确进度事实，并在重读近期工作区文件进入后续上下文前自动剔除敏感文件并脱敏私钥与凭据。
- **中断续传与本地归档回查**：超长历史支持分块与分页持久化推进，暂停或异常中断后可无缝接续；被替换的原文与图片均完整存入本地 `zstd` 归档，通过自带检索工具即可随时回查原始细节。

## 压缩是怎样工作的

当上下文接近阈值、闲置超时或收到压缩指令时，插件会先尝试零模型调用的轻量化折叠；若仍需进一步压缩，再选出工具调用配对完整的区间生成结构化检查点，并填入近期用户原话。在通过要求审计与体积缩小检查后，插件先将原件完整写入本地归档，再安全提交历史替换。完整分层原理、数学预算与故障恢复边界见 [压缩原理与示意图](docs/principles.md)。

## 安装与升级

> [!IMPORTANT]
> **安装前互斥与重启提示**
> - 请勿与会改写 `compaction-basic` 或本地代理的其他压缩插件（如 `billion-context`）同时启用；多插件共存与第三方注入通道隔离细节见 [配置指南](docs/configuration.md) 与 [故障排查](docs/troubleshooting.md)。
> - 停用或切换同类插件（及清理本地代理 `baseUrl`）后，请务必**彻底重启 DSH**，确保旧钩子与端口完全释放。
> - 如需迁移其他插件遗留的旧会话，重启后可使用 `/compact migrate` 先备份原始会话再安全转换。

支持 **DeepSeek Harness `>=0.2.2-rc.1 <1.0.0-0`**（已通过多版本真实宿主兼容与桌面端 RPC 校验，需要 **Node.js 24.9+**）。正式版已发布至 **[npm（`latest`）](https://www.npmjs.com/package/dsh-compaction-weave)** 与 [GitHub Releases](https://github.com/NightFrost42/dsh-compaction-weave/releases/latest)：优先推荐通过 npm 安装 `dsh-compaction-weave`，也可手动使用无版本号 `dsh-compaction-weave.tgz` 或 `dsh-compaction-weave-0.6.0.tgz`。

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
| `history_search` | 相关性检索已归档历史原文与日志 |
| `history_read` | 分段读取原始消息与附件内容 |

## 基本设置

在 **设置 → 上下文压缩（Weave）**（或插件详情页）中修改常用项，**保存后无需重启 DSH，后续操作立即生效；进行中的压缩保留原设置**。

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| 摘要供应商和模型 | 跟随会话 | 留空时复用当前对话模型，也可单独指定摘要模型 |
| 摘要输出上限 | 8192 tokens | 单次摘要响应允许的最大输出长度 |
| 摘要并发数 | 2 | 多分片时按 1–6 路受控并发生成并按序提交，遇限流自动降回并发 1 |
| 摘要推理强度 | `auto` | 按路由自适应（Anthropic 同路由继承缓存偏好，非 Anthropic 路由有思考时压低至 `low`，主会话未开思考时不强行开启），也支持手动指定或禁用 |
| 归档存根掩码 | 开启 | 压缩前先以 0 模型调用尝试折叠旧大体积工具输出，达标直接免除摘要调用 |
| 要求保留审计拦截 | 开启 | 对遗漏有效要求的摘要自动重生成；关闭（`auditBlockOnLoss: false`）后可放行普通覆盖缺失，但**极性反转与假/未信任授权仍始终拦截** |
| 自动压缩熔断后策略 | `confirm` | 连续失败熔断后控制卡片提供手动重试与两步确认暂跳过（`confirm`），或告警放行（`degrade`）/ 严格阻断（`block`） |
| 自动压缩触发比例 | 80% | 与主回答预留输出和提前量共同决定自动触发水位 |
| 最小压缩幅度 | 20% | 自动压缩规划期望释放的输入空间比例 |
| 失败重试次数 / 间隔 / 超时 | 2 次 / 1 秒 / 180 秒 | 指数退避重试（间隔上限 30 秒）与单次等待上限 |
| 闲置后先压缩 | 关闭 | 预设或自定义 1–43200 分钟（30 天）；离开超期回来发送新消息前先轻压缩并视需总结冷历史 |

点击“清除（跟随会话模型）”会清除模型覆盖与独立输出上限并保存其余热生效设置；更多高级选项（含分层压缩细项、文件重注入、图片/归档阈值、CJK 预算权重、自定义参考通道、`dsh-world` 共存及关闭本地归档限制）见 [配置指南](docs/configuration.md) 与 [压缩原理与示意图](docs/principles.md)。

## 测试与验证

`0.6.0` 已在本地通过全部静态拓扑检查、全量离线回归及隔离的 **DSH `0.2.2-rc.1` / `0.2.2-rc.3`** 双宿主集成回归（0 失败）。真实模型网关三方无失真对比实盘摘要（`Weave 0.6.0` vs `DSH Basic` vs `billion-context@0.0.1328-master.ced22b1`，详见 [`docs/benchmarks/v0.6.0-live-three-way.json`](docs/benchmarks/v0.6.0-live-three-way.json)）：

| 对比维度（2026-11-25 实盘） | `Weave 0.6.0` | `DSH Basic` | `billion-context@0.0.1328-master.ced22b1` |
| --- | :---: | :---: | :---: |
| **Suite A 总准确率（`w1` + 重工具 `w2`）** | **131/132 (`99.24%`)**<br>（`w2` `23/24` 且 0 摘要调用） | 123/132 (`93.18%`)<br>（`w2` `15/24`） | 114/132 (`86.36%`)<br>（`w2` `6/24`，GPT `0/8`） |
| **Suite A 压缩与耗时** | **`76.07%`** 有效/线缆<br>`w2` 均耗 **`75.67 ms`** | `58.91%`<br>`w2` `8.67 ms` | 仅 **`3.53%`** 线缆（有效 `40.38%`）<br>`w2` `39,695 ms`，花费高 `+30.9%` |
| **Suite B 5 轮缓存恢复与花费** | **`100/100`** · 总命中率最高<br>（DeepSeek **`72.11%`** / GPT **`64.48%`**）<br>花费最低 **`$0.0410`** / **`$0.7789`** | `100/100` · 命中率居中<br>（`52.15%` / `57.45%`）<br>花费 `$0.0584` / `$0.8315` | `100/100` · 多轮净膨胀 **`-34.95%`..`-38.42%`**<br>花费 **`2.15×`**（`$0.0879`）/ **`1.53×`**（`$1.1885`） |
| **Suite C 15 次跨模型切换** | **186/186 (`100%`)** · `4/4` 一次过<br>最快 **`275.62 s`** · 最低 **`$0.6042` / `$0.4906`** | `186/186`（无第 6 节原话与归档）<br>`476.54 s` · `$0.6482` / `$0.5116` | `186/186` · `15` 次自主压缩<br>`415.96 s` · 贵 **`+42.7%`**（`$0.8623` / `$0.7139`） |

上下文压缩属于有损摘要加按需归档回查，实际输入缩减与账单变化受缓存命中、重生成和模型计费影响；完整多模型明细与复现方法见 [测试记录](docs/testing.md)。

## 诊断与反馈

遇到报错、摘要被拒或压缩后遗漏信息时，可按以下步骤排查与反馈：

1. 在 [GitHub Issues](https://github.com/NightFrost42/dsh-compaction-weave/issues/new/choose) 选择中文或英文模板，描述问题现象、复现步骤与预期表现。
2. **日志附件完全可选**。附上对应操作的诊断日志有助于更快定位（若诊断未写入实际宿主版本，请在正文补充你当前使用的 DSH 版本）。
3. **隐私提示**：诊断日志与审计样本可能包含本地路径或对话原文。提交前请检查并脱敏，拿不准时可不附日志。详细脱敏方法见 [提交问题与日志脱敏](docs/feedback.md)。

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
