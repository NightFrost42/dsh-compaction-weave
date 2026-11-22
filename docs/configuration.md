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
| 闲置后先压缩 | `idleCompactionMinutes` | 0（关闭） | 0 表示关闭；预设或自定义 1–43200 整数分钟，最长 30 天 |
| 最小压缩幅度 | `minimumReductionRatio` | 0.2 | 0.05–0.9 |
| 额外重试次数 | `summaryRetryCount` | 2 | 0–4 |
| 重试基础间隔 | `summaryRetryDelayMs` | 1000 | 0–30000 毫秒 |
| 每次等待上限 | `summaryTimeoutMs` | 180000 | 5000–3600000 毫秒 |
| 摘要并发数 | `summaryConcurrency` | 2 | 1–6 整数（多块并行生成，严格按顺序提交；遇到 HTTP 429 自动降为 1） |
| 摘要推理力度 | `summaryReasoningEffort` | `low` | `low`（默认低档）/ `none`（关闭）/ `minimal` / `medium` / `high` / `xhigh` / `max` / `inherit`（跟随会话）；不支持时自动逐级向下回退 |
| 要求保留审计拦截 | `auditBlockOnLoss` | `true`（开启） | 开启 / 关闭 |

设置页用秒展示等待时间与间隔，配置字段使用毫秒。重试次数指首次请求之后的额外尝试：设置为 2 时，每个未完成的摘要或页面最多尝试 3 次。连续重试采用指数退避，间隔最高 30 秒。

供应商和模型一起选择或一起清空。点击“清除（跟随会话模型）”会清除模型覆盖及其输出上限，同时保存页面当前的触发比例、最小压缩幅度、重试、并发、推理力度、闲置时间与审计拦截参数，包括尚未保存的修改。

**保存或清除本页设置无需重启 DSH。** 摘要模型、输出上限、触发比例、最小压缩幅度、重试和闲置设置（以及并发数、推理力度与 `auditBlockOnLoss` 审计拦截开关），均从后续压缩或请求边界热生效。进行中的压缩继续使用开始时的配置快照，直到本次操作结束。

### 要求保留审计、断点续传与实时进度卡片

- **`auditBlockOnLoss`（默认开启）**：在摘要或分页接续漏掉有效用户约束时自动重试并阻止提交。插件已自动识别并过滤 `<system-reminder>`、`AGENTS.md` 以及宿主第一方上下文注入（保留同一消息中的真实用户正文），大幅降低长会话误拦截；若仍需优先让压缩通过，可在设置页将其关闭（关闭后仍严格拦截允许/禁止极性反转、无来源授权伪造及进度事实冲突，并继续逐字保留 Section 6 近期用户原话）。
- **实时压缩进度卡片与暂停/断点续传**：自动压缩、手动 `/compact`、分页接续或兼容转换进行时，对话输入框上方会自动显示实时进度卡片，包含阶段状态、进度条、波次/分块/页码、并发路数与限流状态、重试次数、摘要模型、token 变化、掩码统计、流式接收活跃度与计时，并支持点击**暂停**中断当前任务；空闲且无需迁移/续传时完全隐藏。当压缩因用户暂停、超时、错误或进程崩溃中断时，已提交的分片全部保留，未完成进度会自动保存断点：普通中断（`interrupted`）会在下一条消息前自动续传，也可在进度卡片点击**继续**或执行 `/compact resume` 立即继续；额度耗尽（`paused_budget`）或达到失败阈值（`paused_failure`）时不会自动触发续传，避免静默续费或阻塞对话，排查后可点击**继续**、执行 `/compact` / `/compact resume`，或点击**放弃进度** / `/compact discard` 清理未完成断点（原始完整备份始终保留）。命令行对应子命令：`/compact resume`、`/compact cancel`、`/compact discard`。
- **billion-context 兼容转换与完整备份**：仅当当前会话实际检测到未迁移的 `billion-context` / `billion-context-dsh` 折叠块或工具记录时，进度卡片才会按需出现“兼容转换为 Weave”入口（普通会话及已完成转换的会话不显示）。执行不可逆转换前，插件会先在独立存储目录 `<DSH_HOME>/storages/dsh-compaction-weave/backups/` 下创建并经 SHA-256 校验原始字节（完整保留 `.v4.jsonl.zstd` / `.v4.jsonl` 编码，不向 DSH 会话目录写入杂项文件）；多次备份始终保护首次生成的原始基线备份不被覆盖；命令行亦可使用 `/compact migrate`、`/compact backups` 与 `/compact restore [backupId]`。

首次安装或升级插件本体仍需按 DSH 提示重载宿主，才能加载新版代码；上述无需重启仅适用于摘要设置页的设置变更。

设置保存在：

```text
<DSH_HOME>/storages/dsh-compaction-weave/summary-config.json
```

没有设置 `DSH_HOME` 时使用用户目录下的 `.dsh`。

### 闲置后先压缩

选择 **5、10、30、60、720 或 1440 分钟**，或较长的 **7 天（10080 分钟）／30 天（43200 分钟）** 预设。也可以选择 **自定义**，填写 **1–43200 整数分钟**。这里 **1 个月固定为 30 天，即 43200 分钟**，不按日历月份计算。默认关闭；停用时选择“关闭”，对应配置值 0，自定义输入从 1 开始。

Claude 保留 5／60 分钟参考，GPT 保留普通及延长缓存参考，Gemini 保留 30 分钟参考。7 天和 30 天用于较长的闲置策略，不表示服务商缓存能保留这么久。

收到新的用户消息时，插件根据同一会话最近一次用户、助手或工具活动，与新消息入队时间的间隔判断。间隔**超过**设定值后，在新回合第一步先压缩已有历史，再继续处理新输入。设置独立于 `auto` 压力压缩开关，适用于所有会话，不随模型切换自动改值。保存后从后续请求边界应用，不会启动闲置倒计时或后台定时压缩。

时间依据会话持久事件，因此重开会话后仍可判断。新会话、时间缺失或异常、活跃工具循环中追加消息，以及没有可缩小历史时跳过。成功压缩后没有新增对话活动，也不重复压缩。待处理的新消息保持在压缩范围外；摘要、审计或存储失败时停止本轮发送并保留输入，取消时也保留输入。已有的原文归档、要求检查、工具配对、重试与熔断继续生效。

这些时间是客户端的手动触发策略，不能测出服务商缓存是否真的过期，也不会启用或修改上游缓存参数。尤其是请求开始时间、回复完成时间和显式缓存的过期时刻并不相同；闲置压缩是否节费仍取决于实际输入、摘要和缓存命中成本。

2026-11-17 核验的官方参考：

| 服务商 | 文档中的保留规则 | 设置时如何理解 |
| --- | --- | --- |
| [OpenAI GPT](https://developers.openai.com/api/docs/guides/prompt-caching) | GPT-5.6 及以后在 Responses API 默认最低寿命 30 分钟，可选 12 小时；旧模型 `in_memory` 通常闲置 5–10 分钟、最长 1 小时，`24h` 通常约 30 分钟、最长 24 小时 | 依模型、接口和上游参数选择参考；最长保留不保证一直命中，新机制最低寿命涉及缓存读取计费资格 |
| [Claude](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | 默认最短 5 分钟，可选 1 小时；使用缓存时刷新，从请求开始计时 | 选择 5 或 60 分钟参考，回复生成时间也计入服务端寿命 |
| [Gemini](https://ai.google.dev/gemini-api/docs/caching) | 隐式缓存未公开固定 TTL；显式缓存默认 1 小时，可设置和更新过期时间 | 本插件按 30 分钟提供触发参考，这不是官方隐式缓存寿命 |
| [DeepSeek](https://api-docs.deepseek.com/guides/kv_cache/) | 不再使用后通常数小时至数天清理，尽力命中 | 没有固定到期点；按实际使用选择自定义时间 |
| [GLM](https://docs.bigmodel.cn/cn/guide/capabilities/cache.md) | 已查官方指南未公开具体缓存保留时间 | 使用自定义时间，不推定固定有效期 |

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
| `idleCompactionMinutes` | `0` | 独立的闲置后压缩阈值，1–43200 整数分钟（最长 30 天）；0 关闭 |
| `idleCompactionMinTokens` | `0` | 触发闲置压缩所需的最小上下文 token 数（0 表示不设额外下限） |
| `idleRetainTokens` | `0` | 闲置压缩时保留在末尾的近期上下文 token 预算 |
| `thresholdRatio` | `0.8` | 自动触发比例 |
| `headroomTokens` | `33000` | 为后续回复和工具结果预留空间 |
| `minimumReductionRatio` | `0.2` | 自动压缩的最小输入缩减目标 |
| `observationMaskingEnabled` | `true` | 第一级归档存根掩码（优先掩码旧大体积工具输出，达标时免除摘要调用） |
| `observationMaskThresholdChars` | `4000` | 触发第一级存根掩码的工具结果最小字符数 |
| `observationMaskHeadChars` | `300` | 第一级存根掩码在首部保留的原始字符数 |
| `observationMaskTailChars` | `300` | 第一级存根掩码在尾部保留的原始字符数 |
| `cachePreservePrefix` | `true` | 优先选择保留已有前缀的增量区间 |
| `cacheMaxCheckpoints` | `4` | 达到此数量后考虑合并摘要 |
| `cacheMinSavingsTokens` | `4096` | 增量压缩需要释放的最小规模 |
| `proactiveEnabled` | `true` | 开启模型的 `context_compact` 工具 |
| `proactiveMinTokens` | `8192` | 主动压缩所需的最小上下文规模 |
| `proactiveMinGrowthTokens` | `4096` | 再次主动压缩前所需的新内容规模 |

`auto`、`idleCompactionMinutes` 和 `proactiveEnabled` 分别控制自动压力检查、闲置后继续对话时压缩与模型主动申请。手动入口为 `/compact`。

### 原话与分页接续

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `preserveRecentMessages` | `32` | 近期用户原话条数上限 |
| `preserveRecentUserTokens` | `4096` | 近期原话预算 |
| `summaryInputRatio` | `0.75` | 摘要输入相对模型窗口的预算比例 |
| `summaryInputMaxBytes` | `458752` | 完整摘要请求的 UTF-8 字节预算 |
| `summaryConcurrency` | `2` | 多分片/分页摘要的并行生成上限（1–6；首片串行探针后并行生成、严格按顺序提交，429 自动降至 1） |
| `summaryReasoningEffort` | `'low'` | 摘要请求推理力度策略：`low`（默认低档降耗）、`none`（省略参数）、`minimal` / `medium` / `high` / `xhigh` / `max`（直接指定思考档位，跨路由也会下发并在不支持时自动沿阶梯 `max → xhigh → high → medium → low → minimal → none → 省略` 向下回退并按路由缓存）、`inherit`（同路由沿用主会话设置） |
| `maxSummaryChunks` | `32` | 一次流程允许的成功分块数量 |
| `continuationEnabled` | `true` | 开启大段历史的分页接续 |
| `continuationMemoryBytes` | `12288` | 接续工作笔记预算 |
| `continuationMaxBytes` | `98304` | 整份接续记录预算 |
| `continuationMaxExtraCalls` | `4` | 持久化额外请求额度 |

原话从旧到新退出预算，仍有效的要求由独立检查继续保留。字节预算用于本地规划，服务端 token 用量以返回的 usage 为准。

### 归档、检查与诊断

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `archiveEnabled` | `true` | 替换选区历史前归档原文与附件 |
| `archiveDir` | 自动 | 自定义历史归档目录 |
| `auditEnabled` | `true` | 检查要求是否保留 |
| `auditBlockOnLoss` | `true` | 要求丢失时重试并阻止不合格摘要提交（极性反转在关闭时仍严格拦截） |
| `extraReferenceSourceKinds` | `[]` | 额外视为非用户参考通道的 `source.kind` 字符串数组（最多 64 项，严禁包含 `'user'` 或 `'compact-checkpoint'`）；内置已自动隔离 `wechat`、`qq`、`wechat-bridge`、`qq-bridge`、`im-bridge` 等桥接通道 |
| `failureThreshold` | `3` | 连续失败后的自动压缩熔断阈值 |
| `strictHostFingerprints` | `false` | 宿主持久化私有方法随 DSH 小版本改动时，确认无未恢复 `.rollback`/`.tail` 日志后发出一次提示并降级使用公开 `Session.append(replace)` + `sessions.flush`；设为 `true` 时严格拦截未审核指纹 |
| `language` | `auto` | 摘要语言：`auto`、`zh` 或 `en` |

设置界面跟随 DSH 的中文或英文界面语言；`language` 字段单独控制生成摘要的语言。

默认配置已启用归档和要求检查。出现失败时，对话会显示原因、尝试次数以及诊断位置；详细处理方式见 [故障排查](troubleshooting.md)。
