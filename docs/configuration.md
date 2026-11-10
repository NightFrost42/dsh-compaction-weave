# 配置指南

[简体中文](configuration.md) · [English](en/configuration.md)

## 摘要设置页

入口：**设置 → 摘要模型**，或 **插件 → Weave 上下文压缩 → 摘要模型**。

| 设置 | 配置字段 | 默认值 | 可设置范围 |
| --- | --- | --- | --- |
| 摘要供应商 | `summarizationProvider` | 跟随会话 | 已配置供应商 |
| 摘要模型 | `summarizationModel` | 跟随会话 | 供应商提供的模型 |
| 输出上限 | `maxTokens` | 8192 | 1–1000000 |
| 触发比例 | `thresholdRatio` | 0.8 | 0.5–0.95 |
| 最小压缩幅度 | `minimumReductionRatio` | 0.2 | 0.05–0.9 |
| 额外重试次数 | `summaryRetryCount` | 2 | 0–4 |
| 重试基础间隔 | `summaryRetryDelayMs` | 1000 | 0–30000 毫秒 |
| 每次等待上限 | `summaryTimeoutMs` | 180000 | 5000–3600000 毫秒 |

设置页用秒展示等待时间与间隔，配置字段使用毫秒。重试次数指首次请求之后的额外尝试：设置为 2 时，每个未完成的摘要或页面最多尝试 3 次。连续重试采用指数退避，间隔最高 30 秒。

供应商和模型一起选择或一起清空。清空后回到跟随会话模型，重试与触发参数继续保留。保存后重启 DSH。

设置保存在：

```text
<DSH_HOME>/storages/dsh-compaction-weave/summary-config.json
```

没有设置 `DSH_HOME` 时使用用户目录下的 `.dsh`。

## 高级配置

高级参数通过 profile 的 patch 配置 `compaction-weave-gate` 的 `engine` 字段。以下示例保留默认缓存策略，并调整摘要重试：

```yaml
- id: compaction-weave-gate
  config:
    engine:
      cachePreservePrefix: true
      cacheMaxCheckpoints: 4
      minimumReductionRatio: 0.2
      summaryRetryCount: 2
      summaryRetryDelayMs: 1000
      summaryTimeoutMs: 180000
```

摘要设置页保存的字段会覆盖引擎同名字段。

### 压缩时机与缓存

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `auto` | `true` | 按上下文压力自动压缩 |
| `thresholdRatio` | `0.8` | 自动触发比例 |
| `headroomTokens` | `33000` | 为后续回复和工具结果预留空间 |
| `minimumReductionRatio` | `0.2` | 自动压缩的最小输入缩减目标 |
| `cachePreservePrefix` | `true` | 优先选择保留已有前缀的增量区间 |
| `cacheMaxCheckpoints` | `4` | 达到此数量后考虑合并摘要 |
| `cacheMinSavingsTokens` | `4096` | 增量压缩需要释放的最小规模 |
| `proactiveEnabled` | `true` | 开启模型的 `context_compact` 工具 |
| `proactiveMinTokens` | `8192` | 主动压缩所需的最小上下文规模 |
| `proactiveMinGrowthTokens` | `4096` | 再次主动压缩前所需的新内容规模 |

`auto` 和 `proactiveEnabled` 分别控制自动压力检查与模型主动申请。手动入口为 `/compact`。

### 原话与分页接续

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `preserveRecentMessages` | `32` | 近期用户原话条数上限 |
| `preserveRecentUserTokens` | `4096` | 近期原话预算 |
| `summaryInputRatio` | `0.75` | 摘要输入相对模型窗口的预算比例 |
| `summaryInputMaxBytes` | `458752` | 完整摘要请求的 UTF-8 字节预算 |
| `maxSummaryChunks` | `32` | 一次流程允许的成功分块数量 |
| `continuationEnabled` | `true` | 开启大段历史的分页接续 |
| `continuationMemoryBytes` | `12288` | 接续工作笔记预算 |
| `continuationMaxBytes` | `98304` | 整份接续记录预算 |
| `continuationMaxExtraCalls` | `4` | 持久化额外请求额度 |

原话从旧到新退出预算，仍有效的要求由独立检查继续保留。字节预算用于本地规划，服务端 token 用量以返回的 usage 为准。

### 归档、检查与诊断

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `archiveEnabled` | `true` | 压缩前归档原文与附件 |
| `archiveDir` | 自动 | 自定义历史归档目录 |
| `auditEnabled` | `true` | 检查要求是否保留 |
| `auditBlockOnLoss` | `true` | 要求丢失时重试并阻止不合格摘要提交 |
| `failureThreshold` | `3` | 连续失败后的自动压缩熔断阈值 |
| `language` | `auto` | 摘要语言：`auto`、`zh` 或 `en` |

设置界面跟随 DSH 的中文或英文界面语言；`language` 字段单独控制生成摘要的语言。

默认配置已启用归档和要求检查。出现失败时，对话会显示原因、尝试次数以及诊断位置；详细处理方式见 [故障排查](troubleshooting.md)。
