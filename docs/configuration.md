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
| 压缩后工作区文件重注入 | `postCompactReinjectEnabled` | `true`（开启） | 开启（0 LLM Token，从本地重读最近最多 5 个工作区文件，上限 24KB）/ 关闭 |
| 超大工具结果尾部溢出 | `persistedOutputEnabled` | `true`（开启） | 开启（0 LLM，仅归档未发送尾部 ≥ 32768 字符工具输出并留首尾 1200 字预览）/ 关闭 |
| 闲置 0-LLM 轻压缩 | `microcompactEnabled` | `true`（开启） | 开启（0 LLM，闲置超期后先保留最新 4 条热点输出，折叠更早大输出与重复读取）/ 关闭 |

设置页用秒展示等待时间与间隔，配置字段使用毫秒。重试次数指首次请求之后的额外尝试：设置为 2 时，每个未完成的摘要或页面最多尝试 3 次。连续重试采用指数退避，间隔最高 30 秒。

供应商和模型一起选择或一起清空。点击“清除（跟随会话模型）”会清除模型覆盖及其输出上限，同时保存页面当前的触发比例、最小压缩幅度、重试、并发、推理力度、闲置时间、审计拦截、工作区文件重注入、尾部溢出与闲置轻压缩参数，包括尚未保存的修改。

**保存或清除本页设置无需重启 DSH。** 摘要模型、输出上限、触发比例、最小压缩幅度、重试和闲置设置（以及并发数、推理力度、`auditBlockOnLoss`、`postCompactReinjectEnabled`、`persistedOutputEnabled` 与 `microcompactEnabled`），均从后续压缩或请求边界热生效。进行中的压缩继续使用开始时的配置快照，直到本次操作结束。

### 要求保留审计、断点续传、斜杠命令与实时进度卡片

- **`auditBlockOnLoss`（默认开启）**：在摘要或分页接续漏掉有效用户约束时自动重试并阻止提交。插件已自动识别并过滤 `<system-reminder>`、`AGENTS.md` 以及宿主第一方上下文注入（保留同一消息中的真实用户正文），大幅降低长会话误拦截；若仍需优先让压缩通过，可在设置页将其关闭（关闭后仍严格拦截允许/禁止极性反转、无来源授权伪造及进度事实冲突，并继续逐字保留 Section 6 近期用户原话）。
- **单次聚焦压缩命令（`/compact <focus>`、`/compact -- <focus>`）**：
  - `/compact <focus>`（如 `/compact 保留 API 鉴权细节和报错行号`）可在手动压缩时传入单次聚焦指令（自动去除控制字符并压缩空白，最长 500 字符），在不漏掉用户约束或虚构事实的前提下优先保留指定上下文；仅精确保留以下 6 个内建子命令：`migrate`、`backups`、`restore [backupId]`、`resume`、`cancel`、`discard`，其余任意非空文本均解析为聚焦指令。若聚焦内容恰好以保留关键字开头（如 `-- resume notes`），可使用 `/compact -- <focus>` 强制按聚焦指令解析。无参数的 `/compact` 保持原有默认压缩与断点续传行为不变。
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
| `headroomTokens` | `33000` | 为后续回复和工具结果预留空间 |
| `minimumReductionRatio` | `0.2` | 自动压缩的最小输入缩减目标 |
| `observationMaskingEnabled` | `true` | 第一级归档存根掩码（优先掩码旧大体积工具输出，达标时免除摘要调用） |
| `observationMaskThresholdChars` | `4000` | 触发第一级存根掩码的工具结果最小字符数 |
| `observationMaskHeadChars` | `300` | 第一级存根掩码在首部保留的原始字符数 |
| `observationMaskTailChars` | `300` | 第一级存根掩码在尾部保留的原始字符数 |
| `persistedOutputEnabled` | `true` | 开启 **Persisted-Output** 尾部溢出：仅归档刚落盘且尚未发给模型的尾部 `tool/result` 节点（0 前缀缓存失效，绝不改写已发送历史，自动跳过 `isError: true`） |
| `persistedOutputThresholdChars` | `32768` | 触发尾部 `Persisted-Output` 溢出的最小文本块字符数（`2048–1048576` 整数） |
| `persistedOutputHeadChars` | `1200` | 尾部溢出存根在首部保留的预览字符数（`0–8192` 整数） |
| `persistedOutputTailChars` | `1200` | 尾部溢出存根在尾部保留的预览字符数（`0–8192` 整数） |
| `microcompactEnabled` | `true` | 开启 **Time-Based Microcompact**：共用 `idleCompactionMinutes` 阈值，0 LLM 调用，先保留最新 `K` 条热点工具输出并折叠更早大体积输出与同路径重复读取 |
| `microcompactKeepRecentTools` | `4` | 轻压缩时在尾部完整保留、不予折叠的最新成功工具输出条数 `K`（`0–50` 整数） |
| `microcompactThresholdChars` | `2000` | 轻压缩折叠较早非错误工具输出的最小字符数（`500–262144` 整数） |
| `microcompactHeadChars` | `200` | 轻压缩存根在首部保留的预览字符数（`0–4096` 整数） |
| `microcompactTailChars` | `200` | 轻压缩存根在尾部保留的预览字符数（`0–4096` 整数） |
| `microcompactRepeatedReadMinChars` | `2000` | 轻压缩去重同路径较早重复文件读取的最小字符数（`500–262144` 整数；尾部热点中的较新读取也可替代更早重复读取） |
| `idleFullSummaryEnabled` | `true` | 闲置超时并完成 0-LLM 轻压缩后，若仍需要缩减是否允许继续运行可选的完整 LLM 闲置摘要（设为 `false` 可仅运行 0-LLM 轻压缩） |
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
| `auditProvenanceBlock` | `true` | 授权/指令来源未匹配用户原文（`provenance`）时阻断提交；设为 `false` 时仅对无依据归纳改为告警放行，但对 `untrusted-source`（外部/注入来源）与 `revoked`（已撤回授权）仍保持强拦截 |
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
| `postCompactReinjectEnabled` | `true` | 压缩后确定性地从本地工作区磁盘重读最近活跃文件（消耗 0 LLM Token；自动跳过 `AGENTS.md` / `CLAUDE.md`、`.env` / 密钥等敏感文件、二进制文件、逃逸软链接与远程/合成会话） |
| `postCompactReinjectMaxFiles` | `5` | 压缩后重注入的本地工作区文件数量上限（`1–20` 正整数） |
| `postCompactReinjectMaxBytes` | `24576` | 压缩后重注入文件总字节上限（`1024–262144` 整数，UTF-8 字节） |
| `postCompactReinjectMaxFileBytes` | `6144` | 单个重注入文件的最大 UTF-8 读取字节数（`512–65536` 整数） |

Weave 还在插件事件总线（`ctx.root ?? ctx`）派发两个同进程 Cordis 插件生命周期钩子，供同一宿主内的其他 DSH 插件监听扩展（不执行本地外部 Shell 命令）：

- **`weave/pre-compact`**：压缩开始前按 `serial` 派发；任一监听器返回 `{ continue: false }` 或 `{ cancel: true }` 可否决本次压缩，返回 `{ additionalContext }`（合计上限 1000 字符）或 `{ focusInstruction }`（上限 500 字符）可向本次压缩注入上下文提示；监听器异常或超时（默认 5000ms）会记录警告并自动降级放行，避免阻塞主压缩流程。
- **`weave/post-compact`**：压缩提交后按 `serial` 派发；严格故障隔离（监听器报错或超时仅记录警告，绝不打断或回滚已提交的压缩），可返回可选的 `{ notice }` / `{ additionalContext }` 提示文本。

设置界面跟随 DSH 的中文或英文界面语言；`language` 字段单独控制生成摘要的语言。

默认配置已启用归档和要求检查。出现失败时，对话会显示原因、尝试次数以及诊断位置；详细处理方式见 [故障排查](troubleshooting.md)。
