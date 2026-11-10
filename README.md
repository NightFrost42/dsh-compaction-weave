<div align="center">

# DSH Compaction Weave

**压缩上下文，保留要求，延续工作。**

面向 DeepSeek Harness 的上下文压缩插件，让长对话带着清晰的目标、进度和下一步持续推进。

[简体中文](README.md) · [English](README.en.md)

[![Release](https://img.shields.io/github/v/release/NightFrost42/dsh-compaction-weave?include_prereleases&style=flat-square&color=5865F2)](https://github.com/NightFrost42/dsh-compaction-weave/releases)
[![CI](https://github.com/NightFrost42/dsh-compaction-weave/actions/workflows/ci.yml/badge.svg)](https://github.com/NightFrost42/dsh-compaction-weave/actions/workflows/ci.yml)
[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-4D6BFE?style=flat-square)](docs/configuration.md)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524.9-339933?style=flat-square&logo=node.js&logoColor=white)](docs/development.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-22A06B?style=flat-square)](LICENSE)
[![Languages](https://img.shields.io/badge/docs-%E4%B8%AD%E6%96%87%20%7C%20English-0F766E?style=flat-square)](README.en.md)

增量压缩 · 缓存复用 · 要求保留 · 历史回查 · 自动重试

[下载安装](#安装) · [快速上手](#快速上手) · [配置指南](docs/configuration.md) · [测试记录](docs/testing.md) · [问题反馈](https://github.com/NightFrost42/dsh-compaction-weave/issues/new/choose) · [更新日志](CHANGELOG.md)

</div>

## 为什么用 Weave

长任务会积累日志、工具输出、旧计划和重复对话。Weave 把这些内容整理成可继续工作的上下文：**正在做什么、哪些要求仍然有效、已经完成什么，以及接下来要做什么。**

已有摘要和稳定前缀会优先保留，新增历史按需压缩；需要更多空间时，再合并检查点。任务细节保存在可检索的历史归档中，用到时再读回来。

## 特性

| 能力 | 带来的体验 |
| --- | --- |
| 🧩 **增量压缩** | 优先保持已有前缀，减少对缓存的扰动，同时检查实际释放的空间 |
| 📌 **要求保留** | 单独检查数值、条件、禁止事项和适用范围；明确修订采用新值，取消任务及时移出 |
| 🧭 **进度接续** | 保留最新工作报告、结果和证据位置，区分当前状态、历史记录与未来计划 |
| 🧹 **低信息裁剪** | 清理独立的“继续”、重复表述和失效要求，近期原话按预算保留 |
| 🔎 **历史回查** | 归档原始消息与附件，模型通过关键词、消息序号和区间找回细节 |
| 📚 **分页接续** | 大段历史分段生成摘要，保存已完成页面，后续重试接着处理 |
| 🔁 **失败重试** | 超时、断流和未通过检查的摘要按配置重试，耗尽次数后给出原因与诊断位置 |
| 🌐 **中英文体验** | 中英文设置文案、README 与使用文档；摘要语言支持自动识别或手动选择 |

## 安装

适配 **DeepSeek Harness 0.2.2-rc.1**，使用 **Node.js 24.9+**。

### 桌面端

1. 下载 [插件安装包](https://github.com/NightFrost42/dsh-compaction-weave/releases/download/v0.3.2-rc.1/dsh-compaction-weave-0.3.2-rc.1.tgz)。
2. 打开 DSH 侧栏 **插件 → 添加插件**。
3. 输入安装包的绝对路径，例如 `C:/Downloads/dsh-compaction-weave-0.3.2-rc.1.tgz`。
4. 按提示安装并启用，然后重启 DSH。

### 命令行

在正在使用的 profile 中安装，例如 `web`：

```bash
dsh plugin --profile web add https://github.com/NightFrost42/dsh-compaction-weave/releases/download/v0.3.2-rc.1/dsh-compaction-weave-0.3.2-rc.1.tgz
```

将 `web` 替换为你的 profile 名称，完成后重新启动该 profile。也可以把 URL 换成本地安装包的绝对路径。

[所有版本与发布附件 →](https://github.com/NightFrost42/dsh-compaction-weave/releases)

## 快速上手

安装后照常对话即可。Weave 默认跟随当前会话模型生成摘要，在接近上下文阈值时自动整理历史。

### 随时手动压缩

```text
/compact
```

### 在任务阶段结束时整理

```text
这一阶段已经完成，整理当前进度、有效要求和剩余任务，再继续下一阶段。
```

模型可通过 `context_compact` 申请压缩。当前工具执行结束后，Weave 处理申请并返回结果。

### 找回旧信息

```text
查一下前面那次测试的原始报错，以及对应的文件位置。
```

| 工具 | 作用 |
| --- | --- |
| `context_compact` | 申请一次阶段性压缩 |
| `history_list` | 查看已归档的历史区间 |
| `history_search` | 按关键词检索历史 |
| `history_read` | 分段读取原始消息与附件 |

## 缓存与压缩怎样配合

```text
压缩前：已有摘要 + 稳定前缀 + 新增历史 + 最近对话
                         ↓ 增量压缩
压缩后：已有摘要 + 稳定前缀 + 新摘要   + 最近对话
                         ↓ 达到合并条件
合并后：合并摘要                     + 最近对话
```

增量压缩优先保留已有内容，让服务端缓存继续复用前缀。达到检查点上限、旧要求被修订或需要释放更多空间时，再合并摘要，然后继续增量处理。

默认最多保留 **4 个摘要检查点**，自动压缩以释放至少 **20%** 的输入空间为目标。

## 要求怎样跟随任务变化

```text
“测试环境超时设为 35 秒”  →  “改成 55 秒”
                    保留最新有效值：55 秒

“生成报告并上传”          →  “取消上传，报告保留本地”
                    保留：生成本地报告

“继续”                   →  不占用长期原话预算
```

近期用户原话默认最多保留 **32 条、约 4096 tokens**。有效要求独立检查，原始细节通过归档继续可查。对生产环境、测试环境以及不同文件的要求，按各自范围处理。

## 设置

打开 **设置 → 摘要模型**，也可以从插件详情进入。

| 设置 | 默认值 | 用途 |
| --- | --- | --- |
| 摘要供应商和模型 | 跟随会话 | 单独选择用于压缩的模型 |
| 摘要输出上限 | 8192 tokens | 分配摘要生成额度 |
| 自动压缩触发比例 | 80% | 调整开始整理上下文的时机 |
| 最小压缩幅度 | 20% | 调整每次自动压缩的空间目标 |
| 失败重试次数 | 2 次 | 首次失败后最多再尝试 2 次 |
| 重试基础间隔 | 1 秒 | 连续失败时逐步延长等待 |
| 每次摘要等待上限 | 180 秒 | 控制一次摘要请求的等待时间 |

**保存后重启 DSH 生效。** 重试参数可以独立设置；模型选择留空时继续跟随会话。

缓存策略、原话预算、摘要语言和分页参数见 [完整配置指南](docs/configuration.md)。

## 测试与数据

当前候选版 `0.3.2-rc.1` 已通过 **50 套、1359 项本地测试**，覆盖离线逻辑与 DSH 宿主集成。其中包括 7 份真实失败摘要重放，以及 16 组原始来源身份兼容检查。

最近一轮官方接口实测使用 `review.35` 和 DeepSeek V4.1 Flash。**4 次成功压缩的输入平均减少 68.50%，压缩后平均保留 31.50%**；样本包括 3 次增量压缩和 1 次合并，取每次输入缩减比例的算术平均。

| 观察项 | 记录 |
| --- | --- |
| 平均输入缩减 / 压缩后保留比例 | **68.50% / 31.50%**（4 次成功压缩） |
| 三代增量压缩后，第 6 答缓存命中率 | 98.31% / 99.11% / 99.20% |
| 合并后第 24 答缓存命中率 | 96.08% |
| 一次合并的输入缩减 | 103827 → 2187 tokens，减少 97.89% |
| 成功压缩后的 42 次问答 | 588 / 588 个字段正确 |

该轮实验发现的摘要误判已纳入当前版本修复与回归。请求口径、失败记录和完整结果见 [测试记录](docs/testing.md)。

## 问题反馈

如果遇到**报错、回答质量下降（“降智”），或压缩后忘记要求、进度和任务信息**，欢迎 [提交 Issue](https://github.com/NightFrost42/dsh-compaction-weave/issues/new/choose)。这些问题都值得反馈，中英文均可。

请尽量提供插件和 DSH 版本、会话模型与摘要模型、复现步骤，以及预期表现和实际表现。回答质量或记忆问题可以附上压缩前后的关键对话；报错请附提示中的错误码和诊断文件，位置见 [故障排查](docs/troubleshooting.md)。提交前移除密钥和私人信息。

## 文档

| 简体中文 | English |
| --- | --- |
| [配置指南](docs/configuration.md) | [Configuration](docs/en/configuration.md) |
| [工作原理](docs/architecture.md) | [Architecture](docs/en/architecture.md) |
| [故障排查](docs/troubleshooting.md) | [Troubleshooting](docs/en/troubleshooting.md) |
| [测试记录](docs/testing.md) | [Testing](docs/en/testing.md) |
| [开发与发布](docs/development.md) | [Development & releases](docs/en/development.md) |

## 开发与贡献

项目直接使用 JavaScript ES modules，无需编译。

```bash
git clone https://github.com/NightFrost42/dsh-compaction-weave.git
cd dsh-compaction-weave
npm test
npm run check
npm run pack:release
```

测试结果保存在 `.local/`，交付物生成到 `dist/`。GitHub Actions 在 Windows 与 Linux 上执行离线测试、项目检查和打包检查。

欢迎提交 Issue 或 Pull Request，一起改善长对话的压缩与接续体验。

## License

[MIT](LICENSE)
