<div align="center">

# DSH Compaction Weave

**压缩上下文，保留要求，延续工作。**

面向 DeepSeek Harness 的上下文压缩插件，让长对话带着明确的目标、有效约束和下一步继续推进。

[简体中文](README.md) · [English](README.en.md)

[![Release](https://img.shields.io/github/v/release/NightFrost42/dsh-compaction-weave?include_prereleases&style=flat-square&color=5865F2)](https://github.com/NightFrost42/dsh-compaction-weave/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/NightFrost42/dsh-compaction-weave/ci.yml?style=flat-square)](https://github.com/NightFrost42/dsh-compaction-weave/actions/workflows/ci.yml)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.2--rc.1%20%3C0.3.0--0-4D6BFE?style=flat-square)](docs/configuration.md)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524.9-339933?style=flat-square&logo=node.js&logoColor=white)](docs/development.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-22A06B?style=flat-square)](LICENSE)
[![Languages](https://img.shields.io/badge/docs-%E4%B8%AD%E6%96%87%20%7C%20English-0F766E?style=flat-square)](README.en.md)

增量压缩 · 要求保留 · 历史回查 · 审计校验 · 故障诊断

[安装与升级](#安装与升级) · [快速上手](#快速上手) · [压缩原理](docs/principles.md) · [基本设置](#基本设置) · [测试与验证](#测试与验证) · [诊断与反馈](#诊断与反馈) · [更新日志](CHANGELOG.md)

</div>

## 用途与能力

长对话会逐步积累工具输出、日志、旧方案和重复讨论。默认配置下，DSH Compaction Weave 将较早的历史整理为结构化检查点，保留**当前任务、仍有效的用户要求、已完成进度和下一步动作**，同时把被替换的原始消息与附件写入本地归档，供后续按需检索与分段读取。

- **增量整理**：优先保留稳定前缀与已有检查点，仅压缩新增历史；当检查点数量达到上限、早期要求发生修订或需要释放更多空间时，再执行完整合并。
- **要求与进度校验**：独立核对数值、条件、禁止事项、作用对象与任务进度。本版本修复了已复现的旧快照取代和协调否定范围误判，减少合格摘要的重复生成，同时继续拦截真实冲突。
- **分页接续与归档回查**：遇到超长历史或单次容量受限时，可按页保存已完成进度并接续处理；原始记录可在需要时通过历史工具按需回查。

## 压缩是怎样工作的

当上下文接近触发线或收到压缩指令时，插件会选出一段工具调用完整配对的历史区间，生成结构化候选摘要，并将预算内的近期用户原话确定性填入检查点。默认开启本地归档时，候选检查点通过结构、体积缩小、有效要求和进度核对后，插件会先把原始事件写入本地归档，再以事务方式替换当前可见历史；后续若需要核对早期细节，模型可按需调用归档工具回查原文。完整流程、数学预算、归档开关边界和恢复机制见 [压缩原理与示意图](docs/principles.md)。

## 安装与升级

支持 **DeepSeek Harness `>=0.2.2-rc.1 <0.3.0-0`**（`0.2.2-rc.1` 起的 `0.2` 系列），已实测 **DSH `0.2.2-rc.1`、`0.2.2-rc.2`、`0.2.2-rc.3`**，运行环境需 **Node.js 24.9+**。以下以 `0.3.2-rc.3` 为例，可使用 [Releases 页面](https://github.com/NightFrost42/dsh-compaction-weave/releases) 提供的安装包或本地打包生成的 `.tgz` 文件。

### 桌面端

1. 下载 `dsh-compaction-weave-0.3.2-rc.3.tgz`。
2. 升级安装时，先在 **插件** 页面卸载旧版 Weave，保留独立存储目录中的历史归档与设置；首次安装可跳过此步。
3. 打开 **插件 → 添加插件**，填入安装包绝对路径（如 `C:/Downloads/dsh-compaction-weave-0.3.2-rc.3.tgz`），完成安装并启用。
4. **重启 DSH**，在插件详情页确认版本号已更新。

### 命令行

停止目标 profile 后执行安装或覆盖升级：

```bash
dsh plugin --profile web add /absolute/path/dsh-compaction-weave-0.3.2-rc.3.tgz
```

请将 `web` 替换为实际使用的命令行 profile 名称，完成后重新启动该 profile。桌面端用户请使用上方的插件管理页流程。

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

在 **设置 → 摘要模型**（或插件详情页）中修改常用项，**保存后重启 DSH 生效**。

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| 摘要供应商和模型 | 跟随会话 | 留空时复用当前对话模型，也可单独指定摘要模型 |
| 摘要输出上限 | 8192 tokens | 单次摘要响应允许的最大输出长度 |
| 自动压缩触发比例 | 80% | 与主回答输出预留和提前量共同决定实际触发线 |
| 最小压缩幅度 | 20% | 自动压缩规划期望释放的输入空间比例 |
| 失败重试次数 | 2 次 | 首次请求失败后最多追加尝试 2 次 |
| 重试基础间隔 | 1 秒 | 连续重试时按指数退避延长等待（上限 30 秒） |
| 每次摘要等待上限 | 180 秒 | 单次摘要请求的超时时间 |

重试设置可独立于摘要模型生效。前缀保留、近期原话预算、摘要语言（自动 / 中文 / 英文）、后台分页参数，以及关闭本地归档（`archiveEnabled: false`）时的功能限制见 [配置指南](docs/configuration.md) 与 [压缩原理与示意图](docs/principles.md)。

## 测试与验证

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
