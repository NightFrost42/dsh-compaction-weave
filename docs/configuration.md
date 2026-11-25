# 配置指南

[简体中文](configuration.md) · [English](en/configuration.md)

## 上下文压缩（Weave）设置页

入口：**设置 → 上下文压缩（Weave）**，或 **插件 → Weave 上下文压缩** 的详情页。

启用历史工具与主动压缩时，`history_list`、`history_read`、`history_search`、`context_compact` 四个工具定义合计 **2,563 字符 / 645 DSH tokens / 约 697 BPE tokens**。摘要预算采用启发式估算：`summaryCjkTokensPerChar` 默认 `0.75`，ASCII 约 `0.25` token/字符；实际计费与硬上限仍以目标模型分词器为准，BPE 数值也随分词器而异。

| 设置 | 配置字段 | 默认值 | 可设置范围 |
| --- | --- | --- | --- |
| 摘要供应商 | `summarizationProvider` | 跟随会话 | 已配置供应商 |
| 摘要模型 | `summarizationModel` | 跟随会话 | 供应商提供的模型 |
| 输出上限 | `maxTokens` | 8192 | 1–1000000 |
| 触发比例 | `thresholdRatio` | 0.8 | 0.5–0.95 |
| 闲置后先压缩 | `idleCompactionMinutes` | 0（关闭） | 0 表示关闭；非后台定时执行，仅在离开超期后**回来发下一条消息前**先做 0-LLM 轻压缩 / 可选闲置摘要；1–43200 整数分钟，最长 30 天 |
| 最小压缩幅度 | `minimumReductionRatio` | 0.2 | 0.05–0.9 |
| 额外重试次数 | `summaryRetryCount` | 2 | 0–4 |
| 重试基础间隔 | `summaryRetryDelayMs` | 1000 | 0–30000 毫秒 |
| 每次等待上限 | `summaryTimeoutMs` | 180000 | 5000–3600000 毫秒 |
| 摘要并发数 | `summaryConcurrency` | 2 | 1–6 整数（多块并行生成，严格按顺序提交；遇到 HTTP 429 自动降为 1） |
| 摘要推理力度 | `summaryReasoningEffort` | `auto` | `auto`（默认按路由自适应：仅 Anthropic 同路由继承，非 Anthropic 路由有思考时压到 `low`，主会话未开思考时不强行开启）/ `low` / `none`（关闭）/ `minimal` / `medium` / `high` / `xhigh` / `max` / `inherit`（跟随会话）；不支持时自动逐级向下回退 |
| CJK 预算保守权重 | `summaryCjkTokensPerChar` | `0.75` | `0.5–1.5`（默认 `0.75`，使 128k 中文会话正常保留前部 KV 缓存；需要兼容较碎分词器时可调到 `1.0`） |
| 要求保留审计拦截 | `auditBlockOnLoss` | `true`（开启） | 开启 / 关闭 |
| 覆盖率审计窗口范围 | `auditCoverageScope` | `'recent'` | `'recent'`（默认：覆盖近期原话保留窗口及本跨度新增近期原始用户消息，按至少 `32` 条 / `4096` token 封顶；窗外旧跨度/超大规模迁移原话普通遗漏记软警告不阻塞）/ `'span-new'`（仅对本跨度新增原始用户消息强制覆盖率）/ `'all'`（全跨度严格覆盖）；**所有冲突红线（`polarity`/`value`/`unit`/`condition`/`range`/`relation`/`exception`/`reference`/`provenance`）在三档下始终全局强制执行** |
| 启发式审计耗尽兜底策略 | `auditExhaustionPolicy` | `'fallback'` | `'fallback'`（默认：全链与重试耗尽后，对纯覆盖/软溯源争议外挂 `<= 3` 处经核验纯用户原话放行；极性反转永不兜底）/ `'block'`（严格拦截，禁用兜底） |
| 压缩后工作区文件重注入 | `postCompactReinjectEnabled` | `true`（开启） | 开启（0 额外摘要模型调用；重注入内容作为后续主回合上下文输入，**对正文执行凭据、未闭合/跨截断边界 PEM 私钥体与尾部前缀脱敏**，最多重读 5 个本地工作区文件，受 `postCompactReinjectMaxBytes` 默认 24KB 封顶）/ 关闭 |
| 超大工具结果尾部溢出 | `persistedOutputEnabled` | `true`（开启） | 开启（0 额外摘要模型调用，仅归档未发送尾部 ≥ 32768 字符工具输出并留首尾 1200 字预览）/ 关闭 |
| 第一级归档存根掩码 | `observationMaskingEnabled` | `true`（开启） | 开启（默认，0 LLM 优先路径；压力或手动压缩时先折叠较早大工具输出为带 `history_read` 指针的存根，达标则免除摘要模型调用）/ 关闭 |
| 闲置 0-LLM 轻压缩 | `microcompactEnabled` | `true`（开启） | 开启（0 LLM 调用；**需开启 `idleCompactionMinutes > 0` 才会触发**，闲置超期后先保留最新 4 条热点输出，折叠更早大输出与重复读取）/ 关闭 |
| 最后兜底 0-LLM 急救裁剪（Snip） | `snipEnabled` | `true`（开启） | 开启（默认，0 LLM；仅在逼近 `messageBudgetTokens` 或 413 兜底时归档旧工具循环并保留 `history_read` 指针，绝不丢弃近期用户消息）/ 关闭 |
| 回合间隙后台预生成摘要 | `sessionMemoryEnabled` | `false`（关闭） | 关闭（默认，0 额外调用）/ 开启（Opt-In；趁回合间隙在后台预生成摘要供下次压缩复用，消耗额外 API 余额与 Token 额度） |
| 单轮压缩前后台预热上限 | `sessionMemoryMaxCallsPerSession` | `8` | 1–100 整数（两次正式压缩之间的**单周期**计费熔断上限；成功提交 Weave 压缩检查点后归零重算，`totalCallsUsed` 单调累计） |
| 过期窗口上下文折叠 | `contextCollapseEnabled` | `false`（关闭） | 关闭（默认）/ 开启（Opt-In；仅在超过 `idleCompactionMinutes` 闲置恢复窗口、且 0-LLM 轻压缩之后触发，绝不在热提示词缓存期间修改历史，可能调用摘要 LLM 消耗 API 余额） |

设置页用秒展示等待时间与间隔，配置字段使用毫秒。重试次数指首次请求之后的额外尝试：设置为 2 时，每个未完成的摘要或页面最多尝试 3 次。连续重试采用指数退避，间隔最高 30 秒。

供应商和模型一起选择或一起清空（输出上限 `maxTokens` 也可在不覆盖供应商/模型时独立保存生效）。点击“清除（跟随会话模型）”会清除模型覆盖及其独立输出上限，同时保存页面当前的触发比例、最小压缩幅度、重试、并发、推理力度、CJK 预算权重、闲置时间、审计拦截、工作区文件重注入、尾部溢出、第一级归档存根掩码、闲置轻压缩、最后兜底急救裁剪（Snip）以及已修改的会话记忆／过期窗口折叠参数，包括尚未保存的修改。

**保存或清除本页设置无需重启 DSH。** 摘要模型、输出上限、触发比例、最小压缩幅度、重试和闲置设置（以及并发数、推理力度、`summaryCjkTokensPerChar`、`auditBlockOnLoss`、`auditCoverageScope`、`auditExhaustionPolicy`、`postCompactReinjectEnabled`、`persistedOutputEnabled`、`observationMaskingEnabled`、`microcompactEnabled`、`snipEnabled`、`sessionMemoryEnabled`、`sessionMemoryMaxCallsPerSession`、`contextCollapseEnabled`、`archiveWarnBytes`、`maxVisibleAttachmentBytes` 与 `maxVisibleImages`），均从后续压缩或请求边界热生效。进行中的压缩继续使用开始时的配置快照，直到本次操作结束。

### 要求保留审计、断点续传、斜杠命令与实时进度卡片

- **`auditBlockOnLoss`（默认开启）与 `auditExhaustionPolicy`（默认 `'fallback'`）**：在摘要或分页接续漏掉有效用户约束时自动重试并阻止提交。插件已自动识别并过滤 `<system-reminder>`、`AGENTS.md` 以及宿主第一方上下文注入（保留同一消息中的真实用户正文），并在重试时先运行确定性局部行重构修复遗漏/极性反转；若当前摘要目标且至少 1 次纠偏重试均已耗尽，仍存在不超过 3 处纯覆盖率或 `missing-source` 软溯源启发式争议（全部非 `provenance` 项均可精确逐字回溯至纯用户原话、总开销 ≤ 2048 字节且仍严格缩小 token 与字节数），默认 `auditExhaustionPolicy: 'fallback'` 会将经核验的用户原话外挂于 `<pinned-source-rules>`（在 `<compacted-summary>` 外前置，二次压缩时自动剥离不滚雪球）并记录在 `auditFallback` 与进度卡片“受控兜底”提示中；极性反转（`CONSTRAINT_POLARITY_LOST`）、结构完整性、体积缩小、`PROGRESS_FACT_CONFLICT`、`RETIRED_MEMORY_REINTRODUCED` 以及 `untrusted-source` / `revoked` 强来源检查永久严格拦截，永不兜底放行（如需重试耗尽后直接失败，可设为 `'block'`）。
- **单次聚焦压缩与熔断重置命令（`/compact <focus>`、`/compact -- <focus>`、`/compact reset`）**：
  - `/compact <focus>`（如 `/compact 保留 API 鉴权细节和报错行号`）可在手动压缩时传入单次聚焦指令（自动去除控制字符并压缩空白，最长 500 字符），在不漏掉用户约束或虚构事实的前提下优先保留指定上下文；仅精确保留以下 7 个内建子命令：`migrate`、`backups`、`restore [backupId]`、`resume`、`cancel`、`discard`、`reset`，其余任意非空文本均解析为聚焦指令。若聚焦内容恰好以保留关键字开头（如 `-- resume notes` 或 `-- reset`），可使用 `/compact -- <focus>` 强制按聚焦指令解析。无参数的 `/compact` 保持原有默认压缩与断点续传行为不变。
  - `/compact reset` 可安全清零当前会话的熔断状态与连续失败计数（`failures: 0`、`stopped: false`、`breakerBypassed: false`），同时完整保留 `window` 观测值与已有可恢复断点；若此前因手工修改状态文件导致 `STATE_INVALID` 校验失败且确认不存在未完成压缩事务（无运行中锁及未决恢复日志），会自动以新的 SHA-256 校验和原子重建干净状态文件。
- **实时压缩进度卡片与暂停/断点续传**：自动压缩、手动 `/compact`、分页接续或兼容转换进行时，对话输入框上方会自动显示实时进度卡片，包含阶段状态、进度条、波次/分块/页码、并发路数与限流状态、重试次数、摘要模型、token 变化、掩码统计、流式接收活跃度与计时，并支持点击**暂停**中断当前任务；空闲且无需迁移/续传时完全隐藏。当压缩因用户暂停、超时、错误或进程崩溃中断时，已提交的分片全部保留，未完成进度会自动保存断点：普通中断（`interrupted`）会在下一条消息前自动续传，也可在进度卡片点击**继续**或执行 `/compact resume` 立即继续；额度耗尽（`paused_budget`）或达到失败阈值（`paused_failure`）时不会自动触发续传，避免静默续费或阻塞对话，排查后可点击**继续**、执行 `/compact` / `/compact resume`，或点击**放弃进度** / `/compact discard` 清理未完成断点（原始完整备份始终保留）。命令行对应子命令：`/compact resume`、`/compact cancel`、`/compact discard`。
- **billion-context 兼容转换与完整备份**：仅当当前会话实际检测到未迁移的 `billion-context` / `billion-context-dsh` 折叠块或工具记录时，进度卡片才会按需出现“兼容转换为 Weave”入口（普通会话及已完成转换的会话不显示）。执行不可逆转换前，插件会先在独立存储目录 `<DSH_HOME>/storages/dsh-compaction-weave/backups/` 下创建并经 SHA-256 校验原始字节（完整保留 `.v4.jsonl.zstd` / `.v4.jsonl` 编码，不向 DSH 会话目录写入杂项文件）；多次备份始终保护首次生成的原始基线备份不被覆盖；命令行亦可使用 `/compact migrate`、`/compact backups` 与 `/compact restore [backupId]`。
- **与其他压缩/裁剪插件共存注意**：请避免同时启用多个会修改 `compaction-basic` 的上下文压缩或裁剪类插件（例如 `billion-context` 或其他改写 `compaction-basic` 的插件）；停用或卸载同类插件后请重载 DSH，并检查配置中是否残留 `disabled: true` 或 `auto: false`。

首次安装或升级插件本体仍需按 DSH 提示重载宿主，才能加载新版代码；上述无需重启仅适用于摘要设置页的设置变更。

设置保存在：

```text
<DSH_HOME>/storages/dsh-compaction-weave/summary-config.json
```

没有设置 `DSH_HOME` 时使用用户目录下的 `.dsh`。

### 闲置后先压缩

选择 **5、10、30、60、720 或 1440 分钟**，或较长的 **7 天（10080 分钟）／30 天（43200 分钟）** 预设。也可以选择 **自定义**，填写 **1–43200 整数分钟**。这里 **1 个月固定为 30 天，即 43200 分钟**，不按日历月份计算。默认关闭；停用时选择“关闭”，对应配置值 0，自定义输入从 1 开始。

Claude 保留 5／60 分钟参考，GPT 保留普通及延长缓存参考，Gemini 保留 30 分钟参考。7 天和 30 天用于较长的闲置策略，不表示服务商缓存能保留这么久。

收到新的用户消息时，插件根据同一会话最近一次用户、助手或工具活动，与新消息入队时间的间隔判断。间隔**超过**设定值后，在新回合第一步先按共用 `idleCompactionMinutes` 阈值的 **Time-Based Microcompact（0 LLM 调用）** 处理已有历史——保留最新 `K`（默认 `4`）条成功热点工具输出，折叠更早的大体积工具输出与同路径重复读取；若之后仍需要进一步缩减（且 `idleFullSummaryEnabled` 为 `true`），再继续执行可选的完整闲置摘要，随后处理新输入。设置独立于 `auto` 压力压缩开关，适用于所有会话，不随模型切换自动改值。保存后从后续请求边界应用，不会启动闲置倒计时或后台定时压缩。

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
| `headroomTokens` | `33000` | 为后续回复和工具结果预留空间；预算不超过 2 倍该值时上限取 `25%`，超出后平滑过渡至配置值，按比例保留近期尾部时另留至少 1 token 的净压缩裕量 |
| `minimumReductionRatio` | `0.2` | 自动压缩的最小输入缩减目标 |
| `observationMaskingEnabled` | `true` | 第一级归档存根掩码（优先掩码旧大体积工具输出，达标时免除摘要调用） |
| `observationMaskThresholdChars` | `4000` | 触发第一级存根掩码的工具结果最小字符数 |
| `observationMaskHeadChars` | `300` | 第一级存根掩码在首部保留的原始字符数 |
| `observationMaskTailChars` | `300` | 第一级存根掩码在尾部保留的原始字符数 |
| `persistedOutputEnabled` | `true` | 开启 **Persisted-Output** 尾部溢出：仅归档刚落盘且尚未发给模型的尾部 `tool/result` 节点（0 前缀缓存失效，绝不改写已发送历史，自动跳过 `isError: true`） |
| `persistedOutputThresholdChars` | `32768` | 触发尾部 `Persisted-Output` 溢出的最小文本块字符数（`2048–1048576` 整数） |
| `persistedOutputHeadChars` | `1200` | 尾部溢出存根在首部保留的预览字符数（`0–8192` 整数） |
| `persistedOutputTailChars` | `1200` | 尾部溢出存根在尾部保留的预览字符数（`0–8192` 整数） |
| `microcompactEnabled` | `true` | 开启 **Time-Based Microcompact**：**需开启 `idleCompactionMinutes > 0` 才会触发**（为 `0` 时保持休眠），0 LLM 调用，先保留最新 `K` 条热点工具输出并折叠更早大体积输出与同路径重复读取 |
| `microcompactKeepRecentTools` | `4` | 轻压缩时在尾部完整保留、不予折叠的最新成功工具输出条数 `K`（`0–50` 整数） |
| `microcompactThresholdChars` | `2000` | 轻压缩折叠较早非错误工具输出的最小字符数（`500–262144` 整数） |
| `microcompactHeadChars` | `200` | 轻压缩存根在首部保留的预览字符数（`0–4096` 整数） |
| `microcompactTailChars` | `200` | 轻压缩存根在尾部保留的预览字符数（`0–4096` 整数） |
| `microcompactRepeatedReadMinChars` | `2000` | 轻压缩去重同路径较早重复文件读取的最小字符数（`500–262144` 整数；尾部热点中的较新读取也可替代更早重复读取） |
| `idleFullSummaryEnabled` | `true` | **需开启 `idleCompactionMinutes > 0` 才会触发**；闲置超时并完成 0-LLM 轻压缩后，若仍需要缩减是否允许继续运行可选的完整 LLM 闲置摘要（设为 `false` 可仅运行 0-LLM 轻压缩） |
| `cachePreservePrefix` | `true` | 优先选择保留已有前缀的增量区间 |
| `cacheMaxCheckpoints` | `4` | 达到此数量后考虑合并摘要 |
| `cacheMinSavingsTokens` | `4096` | 增量压缩需要释放的最小规模 |
| `proactiveEnabled` | `true` | 开启模型的 `context_compact` 工具 |
| `proactiveMinTokens` | `8192` | 主动压缩所需的最小上下文规模 |
| `proactiveMinGrowthTokens` | `4096` | 再次主动压缩前所需的新内容规模 |

`auto`、`idleCompactionMinutes` 和 `proactiveEnabled` 分别控制自动压力检查、闲置后继续对话时压缩与模型主动申请。手动入口为 `/compact`。

### 上下文压缩执行层级与最后兜底 0-LLM 急救裁剪（Snip）

Weave 按缓存友好与零额外计费优先的顺序分层缩减上下文：

1. **热缓存期（正常连续对话）**：仅运行 0 LLM、0 前缀缓存失效的 **Persisted-Output** 尾部溢出（仅归档尚未发给模型的尾部超大 `tool/result`）；绝不改写已发送历史。
2. **闲置超期恢复窗口（超过 `idleCompactionMinutes`）**：
   - **Tier 1 — 闲置 0-LLM 轻压缩（Time-Based Microcompact）**：先保留最新 `K` 条热点工具输出，折叠更早大体积输出与同路径重复读取。
   - **Tier 2 — 过期窗口上下文折叠（Context Collapse，Opt-In）**：仅在 `contextCollapseEnabled: true` 时接续渐进折叠更早阶段（绝不在热缓存期间运行）。
   - **Tier 3 — 可选完整闲置摘要（`idleFullSummaryEnabled`）**：仅在前面步骤后仍需进一步缩减时执行。
3. **压力／手动压缩（达到 `thresholdRatio` / `pressureBudgetTokens` 或手动 `/compact`、`context_compact`）**：先运行第一级归档存根掩码（Observation Masking，达标则免除摘要模型调用），未达标再进入 LLM 摘要或分页接续（若开启 `sessionMemoryEnabled` 则优先尝试复用已核验的后台记忆）。
4. **接近硬预算红线的最后兜底 0-LLM 急救裁剪（Snip）**：仅当常规压缩、掩码或续传失败／仍不足以压低，且会话逼近 `messageBudgetTokens` 硬上限或触发 413 溢出（`CONTEXT_WINDOW_EXCEEDED`）时作为最后一道兜底防线运行（0 LLM 调用）。Snip 优先将最旧的工具调用循环归档并替换为带 `history_read` 回查指针的紧凑存根，严格保留系统提示、近期真实用户消息与回合、有效约束及工具调用/结果配对完整性。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `snipEnabled` | `true` | 开启最后兜底 0-LLM 急救裁剪 **Snip**（默认开启，也可在设置页热切换；0 LLM 调用，仅在常规压缩与续传仍无法避免逼近 `messageBudgetTokens` 硬上限或触发 413 溢出时触发，归档旧工具循环并留下 `history_read` 指针，绝不丢弃近期用户消息） |
| `snipKeepRecentTurns` | `2` | Snip 强制在尾部保护的最近真实用户回合数下限（`1–50` 整数） |
| `snipKeepRecentTokens` | `8192` | Snip 强制在尾部保护的近期工作上下文最小 token 预算（`512–262144` 整数，随目标预算协调并在工具配对边界对齐） |
| `snipMinSavingsTokens` | `1024` | Snip 单个候选连续区间至少需净释放的最小 token 数（`0–131072` 整数） |
| `snipMaxSpansPerRescue` | `4` | 单次 Snip 急救流程最多归档裁剪的连续区间数量上限（`1–20` 整数） |

### 回合间隙后台预生成摘要与过期窗口上下文折叠（默认关闭，Opt-In）

以下两项特性均采用**严格默认关闭（`false`）**的 Opt-In 策略：未显式启用时 **0 额外 LLM 调用、0 额外计费**。

- **回合间隙后台预生成摘要（`sessionMemoryEnabled`）**：注意区分上方的“闲置后先压缩（`idleCompactionMinutes`）”——后者**不是后台定时压缩**，而是在您离开超期并回来发下一条消息前现场运行 0-LLM 轻压缩 / 可选闲置摘要；开启本项后，才会在对话回合间隙真正运行后台摘要预热，通过显式 `coveredThroughSeq` 水印追踪已覆盖前缀并保留近期尾部工作区上下文，前台压缩若撞上正在进行且兼容的后台预生成，将先短限时等待复用（默认 `4000 ms`，超时自动取消回退），复用前严格校验校验和、`sourceHash`、`policyFingerprint` 与工具配对完整性；受最小 token、间隔、冷却、12KB 体积上限与跨 `clear()` 持久保留的**单周期计费熔断**（`sessionMemoryMaxCallsPerSession`，仅在成功提交 Weave 压缩检查点或 `bili` 折衷合并提交后归零当前周期 `callsUsed` 并保留单调递增的 `totalCallsUsed`；回滚、还原备份或 0-LLM 局部裁剪绝不重置）约束，避免后台失控扣费。
- **过期窗口上下文折叠（Context Collapse）**：采用**过期 TTL 缓存安全门控**，**仅**在超过 `idleCompactionMinutes` 闲置恢复窗口、且 Tier 1 **0-LLM 轻压缩（Microcompact）** 执行之后触发（`idleCompactionMinutes` 为 `0` 或热提示词缓存期间**绝不触发**）；按 `contextCollapseMaxSpanTokens` 渐进折叠较早未折叠阶段，同时以 `contextCollapseKeepRecentTokens` 与 `contextCollapseKeepRecentTurns` 的交集（取保护范围更早的一侧，且忽略 `<system-reminder>` 与桥接通道非用户消息、不拆断工具调用/结果配对）严格保留近期工作尾部。触发时可能调用摘要 LLM 并消耗 API 余额。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `sessionMemoryEnabled` | `false` | Opt-In 开关：是否在回合间隙后台预生成摘要供下次压缩复用（默认 `false` 关闭；启用后会运行后台 LLM 调用消耗 API 余额与 Token 额度） |
| `sessionMemoryMinTokens` | `24576` | 触发后台预热所需的最小可压缩上下文 token 数（`4096–1000000` 整数） |
| `sessionMemoryUpdateIntervalTokens` | `16384` | 已有有效 `coveredThroughSeq` 水印后，触发增量更新所需的新增 token 增量（`2048–500000` 整数） |
| `sessionMemoryUpdateIntervalTurns` | `4` | 已有有效 `coveredThroughSeq` 水印后，触发增量更新所需的新增真实用户回合数（`1–100` 整数） |
| `sessionMemoryCooldownMs` | `60000` | 两次后台预热 LLM 调用之间的最小冷却间隔（`0–3600000` 整数毫秒） |
| `sessionMemoryMaxBytes` | `12288` | 单条持久化会话记忆载荷的 UTF-8 最大字节上限（`2048–65536` 整数；超限则安全跳过落盘） |
| `sessionMemoryMaxCallsPerSession` | `8` | 单轮压缩前后台预热上限 / 单周期计费熔断（`1–100` 整数；每次成功提交 Weave 压缩检查点后归零重算当前周期 `callsUsed` 并累计 `totalCallsUsed`，普通 `clear()`、回滚、还原备份及 0-LLM 局部裁剪绝不归零） |
| `contextCollapseEnabled` | `false` | Opt-In 开关：是否启用过期 `idleCompactionMinutes` 恢复窗口内的渐进 Context Collapse（默认 `false` 关闭；仅在过期闲置窗口 Microcompact 之后触发，绝不破坏热提示词缓存） |
| `contextCollapseMinTokens` | `49152` | 触发 Context Collapse 所需的最小表面消息总 token 数（`8192–1000000` 整数） |
| `contextCollapseMaxSpanTokens` | `32768` | 单次渐进 Context Collapse 最多折叠的前缀 token 跨度上限（`4096–500000` 整数，避免一次吞并整段中间/近期历史） |
| `contextCollapseKeepRecentTokens` | `8192` | Context Collapse 强制在尾部保留的近期工作上下文最小 token 预算（`1024–200000` 整数，与回合数保留取交集） |
| `contextCollapseKeepRecentTurns` | `2` | Context Collapse 强制在尾部保留的最近真实用户回合数（`1–20` 整数，与 token 保留取交集并对齐工具配对边界） |

### 原话与分页接续

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `preserveRecentMessages` | `32` | 近期用户原话条数上限 |
| `preserveRecentUserTokens` | `4096` | 近期原话预算 |
| `summaryInputRatio` | `0.85` | 摘要输入相对模型可用窗口的 Token 预算比例 |
| `summaryInputMaxBytes` | `2097152` | 完整摘要请求的独立 UTF-8 字节硬上限（2 MiB） |
| `summaryCjkTokensPerChar` | `0.75` | 摘要与上下文规划对 CJK/韩文/假名的启发式每字 token 估算权重（`0.5–1.5`，支持在设置页热生效；插件采用轻量化启发式估算，ASCII ≈ `0.25` tok/char、不含外部 BPE 运行表，实际计费仍以模型分词器为准；需兼容较碎分词器时可调至 `1.0`） |
| `summaryConcurrency` | `2` | 多分片/分页摘要的并行生成上限（1–6；首片串行探针后并行生成、严格按顺序提交，429 自动降至 1） |
| `summaryReasoningEffort` | `'auto'` | 摘要请求推理力度策略：`auto`（默认按路由自适应：仅 Anthropic/Claude 同路由沿用主会话设置以复用提示词缓存，非 Anthropic 路由有思考时压到 `low`，主会话未设力度时不强行开启思考）、`low`（显式指定低档；主会话已设更低档位 `minimal` / `none` 时沿用更低档，未设或跨路由时按 `'low'` 下发）、`none`（省略参数）、`minimal` / `medium` / `high` / `xhigh` / `max`（直接指定思考档位；上述直接档位在遇到 `UNSUPPORTED_REASONING_EFFORT` 时均会自动沿阶梯 `max → xhigh → high → medium → low → minimal → none → 省略` 向下回退并按路由缓存）、`inherit`（强制继承主会话设置） |
| `compactionRetries` | `1` | 宿主架构/规格兼容保留占位字段（运行时摘要重试请配置 `summaryRetryCount` 与 `summaryRetryDelayMs`，本字段不参与运行期重试循环） |
| `maxSummaryChunks` | `32` | 一次流程允许的成功分块数量 |
| `continuationEnabled` | `true` | 开启大段历史的分页接续 |
| `continuationMemoryBytes` | `12288` | 接续工作笔记预算 |
| `continuationMaxBytes` | `98304` | 整份接续记录预算 |
| `continuationMaxExtraCalls` | `4` | 持久化额外请求额度 |

原话从旧到新退出预算，仍有效的要求由独立检查继续保留。字节预算用于本地规划，服务端 token 用量以返回的 usage 为准。

### 归档、检查与诊断

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `archiveEnabled` | `true` | 替换选区历史前归档原文与附件（默认使用无损 `zstd` 压缩并以 `0o700` / `0o600` 权限落盘——适用于 POSIX 的 macOS/Linux，Windows 下受 Node.js 文件权限语义限制；绝不自动删除） |
| `archiveDir` | 自动 | 自定义历史归档目录 |
| `archiveWarnBytes` | `536870912`（512 MiB） | 本地归档（`sessions/`）占用超过阈值时仅触发卡片温和提醒（`0` 关闭提醒；`0–102400 MiB` 对应字节范围，提供设置页手动无损压缩旧段与确认清理孤儿归档入口） |
| `maxVisibleAttachmentBytes` | `16777216`（16 MiB） | 可见表面未卸载图片字节高水位阈值（`0` 关闭字节触发；超过阈值时采用高低双水位迟滞策略，单批原生 `image/offload` 卸载较早图片并保留最新 6 张热点图片以维持 KV 缓存稳定，不重置周期会话记忆计数） |
| `maxVisibleImages` | `24` | 可见表面未卸载图片张数高水位阈值（`0` 关闭张数触发，允许 `1–500`；另设长边 `>2000px` 超过 `20` 张护栏；触线时单批卸载至低水位，且严格不改写 `user/message` 原文） |
| `auditEnabled` | `true` | 检查要求是否保留 |
| `auditBlockOnLoss` | `true` | 要求丢失或矛盾时重试并阻止不合格摘要提交；显式设为 `false` 作为用户紧急逃生阀时，可放行普通覆盖缺失及非极性冲突，但**极性反转（`polarity`）与硬来源冲突（`untrusted-source`/`revoked`）在关闭时仍严格拦截** |
| `auditCoverageScope` | `'recent'` | 控制启发式普通覆盖率（`coverage`）的强制窗口范围（支持设置页热生效）：`'recent'`（默认：同时覆盖 `preserveRecentMessages` / `preserveRecentUserTokens` 近期保留窗口与本跨度新增近期原始用户消息——上限至少取 `32` 条 / `4096` token，即使缩小第 6 节逐字原话预算也不会屏蔽当前跨度新指令的摘要覆盖审计，同时避免多代历史或超大规模迁移死锁；窗外普通覆盖遗漏仅记录告警并计入 `softCoverageCount`，不阻断且不消耗兜底名额；`/compact <focus>` 显式聚焦模式下仅柔化纯 `coverage` 缺口、不放行数值/区间/条件矛盾）、`'span-new'`（仅对本跨度直接新增、非旧检查点携带的原始 `user/message` 强制覆盖率）或 `'all'`（对全跨度所有保留原话强制覆盖率）。所有全局冲突红线（`polarity`、`value`、`unit`、`condition`、`range`、`relation`、`exception`、`reference`、`provenance`）及最近原话第 6 节逐字保存始终全局强制执行 |
| `auditProvenanceBlock` | `true` | 授权/指令来源未匹配用户原文（`provenance`）时阻断提交；设为 `false` 时仅对无依据归纳改为告警放行，但对 `untrusted-source`（外部/注入来源）与 `revoked`（已撤回授权）仍保持强拦截 |
| `auditExhaustionPolicy` | `'fallback'` | 当前摘要目标与至少 1 次纠偏重试全部耗尽且仅剩 `<= 3` 处纯覆盖率（`coverage`）或软 `missing-source` 缺口时的自动兜底策略（可在设置页热生效）：`'fallback'`（默认：外挂经核验纯用户原话至 `<pinned-source-rules>`、`≤ 2048` 字节并严守缩小与所有强红线后受控放行）或 `'block'`（严格拦截并失败）；`CONSTRAINT_POLARITY_LOST`（极性反转）、任意数值/单位/条件/区间/关系/例外/引用硬冲突（`value`/`unit`/`condition`/`range`/`relation`/`exception`/`reference`）、`summaryRetryCount === 0` 或结构/体积/进度/已撤回/`untrusted-source`/`revoked` 失败**永不走自动兜底** |
| `extraReferenceSourceKinds` | `[]` | 额外视为非用户参考通道的 `source.kind` 字符串数组（最多 64 项，严禁包含 `'user'` 或 `'compact-checkpoint'`）；内置已自动隔离 `wechat`、`qq`、`wechat-bridge`、`qq-bridge`、`im-bridge` 等桥接通道 |
| `extraReferencePrefixes` | `[]` | 额外视为非用户注入块的裸文本前缀数组（修剪后 2–200 字符、最多 64 项）；内置已自动隔离多行记忆注入头（如 `===== 长期记忆 =====`、`【记忆导引】` 后带正文），不污染 Section 6 原话或要求审计 |
| `diskLivenessCheck` | `true` | 压缩时在工作区目录内只读检查历史提及文件路径是否缺失或于近期改动（不调模型，非本地路径自动跳过） |
| `failureThreshold` | `3` | 连续失败后的自动压缩熔断阈值 |
| `pressureBreakerAction` | `'confirm'` | 自动压缩熔断后的处理策略（可在设置页热生效修改）：`'confirm'`（默认：阻断自动发送并在输入框卡片提供重试压缩与两步确认放行）、`'degrade'`（在请求硬预算内发出告警并暂跳过自动压缩）、`'block'`（严格阻断，仅允许重试压缩或还原备份）；`RECOVERY_REQUIRED`、待续传与超出 `messageBudgetTokens` 永不放行 |
| `strictHostFingerprints` | `false` | 宿主持久化私有方法随 DSH 小版本改动时，确认无未恢复 `.rollback`/`.tail` 日志后发出一次提示并降级使用公开 `Session.append(replace)` + `sessions.flush`；设为 `true` 时严格拦截未审核指纹 |
| `language` | `auto` | 摘要语言：`auto`、`zh` 或 `en` |

### 工作区文件重注入与插件生命周期事件（Hooks）

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `postCompactReinjectEnabled` | `true` | 压缩后确定性地从本地工作区磁盘重读最近活跃文件（0 额外摘要模型调用；重注入内容作为后续主回合上下文输入，受 `postCompactReinjectMaxBytes` 封顶；内置 `+4 KiB` 预读窗口对凭据、未闭合/跨截断边界 PEM 私钥体与残片前缀自动脱敏，并自动跳过 `AGENTS.md` / `CLAUDE.md`、`.env` / 密钥等敏感文件、二进制文件、逃逸软链接与远程/合成会话） |
| `postCompactReinjectMaxFiles` | `5` | 压缩后重注入的本地工作区文件数量上限（`1–20` 正整数） |
| `postCompactReinjectMaxBytes` | `24576` | 压缩后重注入文件总字节上限（`1024–262144` 整数，UTF-8 字节） |
| `postCompactReinjectMaxFileBytes` | `6144` | 单个重注入文件的最大 UTF-8 读取字节数（`512–65536` 整数） |

Weave 还在插件事件总线（通过顶层安全桥接 `hookBus` 访问 Cordis 事件总线，兼容严格 `ReflectService` Proxy）派发两个同进程 Cordis 插件生命周期钩子，供同一宿主内的其他 DSH 插件监听扩展（不执行本地外部 Shell 命令）：

- **`weave/pre-compact`**：压缩开始前按 `serial` 派发；任一监听器返回 `{ continue: false }` 或 `{ cancel: true }` 可否决本次压缩，返回 `{ additionalContext }`（独立保留换行、合计上限 1000 字符，不挤占用户聚焦指令）或 `{ focusInstruction }`（上限 500 字符）可向本次压缩注入上下文提示；监听器异常或超时（默认 5000ms）会记录警告并自动降级放行，避免阻塞主压缩流程。
- **`weave/post-compact`**：压缩提交后按 `serial` 派发；严格故障隔离（监听器报错或超时仅记录警告，绝不打断或回滚已提交的压缩），可返回可选的 `{ notice }` / `{ notices }` / `{ additionalContext }` 提示文本（引擎会记录通知日志并保留在压缩结果 `hookNotices` 与回执元数据中）。

设置界面跟随 DSH 的中文或英文界面语言；`language` 字段单独控制生成摘要的语言。

默认配置已启用归档和要求检查。出现失败时，对话会显示原因、尝试次数以及诊断位置；详细处理方式见 [故障排查](troubleshooting.md)。
