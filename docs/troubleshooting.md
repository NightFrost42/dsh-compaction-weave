# 故障排查

[简体中文](troubleshooting.md) · [English](en/troubleshooting.md)

## 摘要失败时会发生什么

当单次摘要请求超时或未通过审计校验时，插件会按配置自动重试。默认在首次请求后最多追加 2 次重试，校验失败原因会作为修正反馈一并传给摘要模型。

若重试次数耗尽仍未通过，对话界面会显示失败原因与诊断文件路径。尚未提交替换的原始上下文保持不变；后台分页接续中已完成校验的页面会保存在本地，供后续继续处理。

| 提示类型 | 处理方式 |
| --- | --- |
| 摘要超时或断流 | 检查模型供应商连接状态，或在设置页适当调高等待上限与重试次数；已提交的分片与断点会自动保留，下一条消息、进度卡片“继续”或 `/compact resume` 会从断点续传 |
| 压缩中途暂停、崩退或想放弃未完成断点 | 进行中可点进度卡片“暂停”或执行 `/compact cancel`，已提交分片不会回滚；进程崩溃重开会话时插件会在加载前自动闭合残留锁并转为可续传断点。普通中断在下一条消息前自动续传，也可点“继续”或执行 `/compact resume`；若中断后摘要或压缩策略发生变化，自动前置续传会主动暂停（`CONTINUATION_PENDING_POLICY_CHANGED`）而不会静默丢弃已付费页面或重置调用预算，等待显式点击“继续”/执行 `/compact` 或 `/compact discard`；若因额度耗尽（`paused_budget`）或连续失败（`paused_failure`）暂停，不会阻塞正常对话，排查后可点“继续”/`/compact` 恢复，或点“放弃进度”/`/compact discard` 清除断点（完整备份不受影响） |
| 摘要并发触发 429 限流、耗时偏慢或 `UNSUPPORTED_REASONING_EFFORT` | 默认并发 `summaryConcurrency: 2` 且推理力度为 `auto`（非 Anthropic 路由有思考时压到 `low`，Anthropic 同路由跟随主会话以复用缓存，主会话未开思考时不强行开启），遇 HTTP 429 时会自动将并发降至 1 并冷却重试；直接选择 `low` / `minimal` / `medium` / `high` / `xhigh` / `max` 时若模型不支持也会自动沿阶梯向下回退并省略。若仍被拒，请在 **设置 → 上下文压缩（Weave） → 摘要推理强度** 设为 `none` 或该模型支持的档位 |
| 摘要结构不完整或输出截断 | 调高摘要输出上限（`maxTokens`），或更换更适合长文本归纳的摘要模型 |
| 要求、极性或指令来源审计未通过（`CONSTRAINT_POLARITY_LOST` / `reason=provenance`） | 查看提示中的触发类型（`untrusted-source` / `revoked` / `missing-source`）、触发摘要句与诊断文件中的 `auditReports` / `audit-reject/` 记录。仅设 `auditBlockOnLoss: false` 仅可放行纯覆盖缺失，不会放行极性反转（`CONSTRAINT_POLARITY_LOST`）、数值/单位/条件/区间等硬冲突或来源审计（`provenance`）；若触发来自第三方消息桥接或记忆插件注入，可将 `source.kind` 加入 `extraReferenceSourceKinds` 或将裸前缀加入 `extraReferencePrefixes`（已内置常见 IM 桥接与多行记忆注入头），无依据归纳可按需设 `auditProvenanceBlock: false`（`untrusted-source` 与 `revoked` 仍始终强拦截） |
| 自动压缩连续失败触发熔断（`COMPACTION_STOPPED`） | 失败后输入框上方卡片会显示最近根因错误码、诊断 ID 与高成本大上下文计费提示：排查设置或切换模型后点击「手动重试压缩」（成功率清除所有熔断计数与放行标记）；如需在预算安全线内先继续对话，可通过设置页「自动压缩熔断后策略」（`confirm` / `degrade` / `block`，默认 `confirm`）或在卡片中二次确认放行，也可随时「恢复拦截」或复制脱敏诊断摘要反馈问题；注意 `RECOVERY_REQUIRED`、待续传与超出 `messageBudgetTokens` 红线永远不会放行 |
| 同时安装 `dsh-world` 后 Weave 静默未挂载 | 若 `dsh-world` 开启了压缩接管（`compactionSwapped` / `dsh-world/compaction`），会覆盖官方 `@deepseek-ai/dsh-compaction-basic` 行导致 Weave 无法挂载。预设模式请在 World Console 点击 **概览 → 会话预设 → 还原 DSH 预设**；非预设模式设置 `replaceCompaction: false`（`dsh-world` 的日记、`memory_find` 与记忆注入均完整保留），也可搭配 `extraReferenceSourceKinds` / `extraReferencePrefixes` 隔离自定义注入，详见 [配置指南](configuration.md) |
| 输入或单组工具消息过大 | 插件会在超长会话上自动执行第一级分批工具输出掩码、按主摘要目标独立计算窗口容量、按波次分层折叠检查点并限制每块/每波工具引用上限；若诊断或 `CONTEXT_WINDOW_EXCEEDED` / `SUMMARY_GROUP_TOO_LARGE` 报错中带有 `windowLookupFailure`，说明模型窗口查询失败并回退到了 `windowFallback`（默认 `200000`），可结合 `windowProviderMap` 检查并调整摘要模型窗口或输入预算 |
| 后台分页调用额度耗尽 | 排查提示原因后，输入 `/compact` 为剩余未完成页面续批一轮调用额度 |
| 从 `billion-context` 切到 Weave 后无法自动压缩或遇到旧折叠块 | Weave 接管官方压缩行时会自动清除残留的 `disabled: true`；若日志提示继承了 `auto: false`，请从 profile patch 中移除 `auto: false` 或显式配置 `engine.auto: true`。旧会话中的 `billion-context` / `billion-context-dsh` 折叠块或工具记录可通过进度卡片中的“兼容转换为 Weave”按钮或 `/compact migrate` 一键转换，转换前会自动创建并经 SHA-256 校验完整原始会话备份；如需回退，可点击卡片中的“还原备份”或执行 `/compact backups`、`/compact restore [backupId]`（已打开的会话会先锁定写入，在关闭重开或重载 DSH 后自动完成原子还原；并发重复恢复或与压缩/迁移同时触发时会安全拒绝并返回 `busy` / `STATE_LOCKED`，防止状态或备份损坏） |
| 弹出 `billion-context` 并存/代理残留警告或 `413` `preflight_compress_failed`（`BILI_COEXISTENCE_CONFLICT` / `BILI_PROXY_CONFLICT`） | 请在插件管理页停用或卸载 `billion-context`（含 `billion-context-dsh`），检查模型供应商 `baseUrl` 是否仍指向 bili 的 `127.0.0.1` / `localhost` 本地代理并还原为直连上游地址，然后**彻底重启一次 DSH**（即使刚才已在界面里关闭过 `billion-context` 也必须彻底重启以清理内存钩子与代理端口）；普通上游 HTTP `413` / `model window` 窗口溢出由 Weave 接管重试与合法 Snip 兜底 |
| 会话恢复或写隔离提示 | 保留存储目录中的事务日志与 `.rollback` 备份，重启宿主后查看恢复结果 |
| 宿主兼容或私有方法校验提示 | 核对当前 DSH 版本是否处于 `>=0.2.2-rc.1 <1.0.0-0` 范围（正式原子事务实测覆盖 `0.2.2-rc.1`、`0.2.2-rc.2`、`0.2.2-rc.3`）；在默认 `strictHostFingerprints: false` 下，若宿主小更新调整私有持久化方法，插件会在确认无未恢复 `.rollback`/`.tail` 原子日志后发出一次兼容提示并自动改走公开 `Session.append(replace)` + `sessions.flush()`；仅当设为 `strictHostFingerprints: true` 或存在未恢复原子日志时才会阻止压缩并保留恢复材料 |
| DSH Desktop `0.2.3-alpha.2+` 设置页 RPC `403 missing origin refused` / `403 owner role required` | 请升级至 `0.6.0` 并彻底重启 DSH（进程会随 `webserver/index-inject` 下发随机 `x-weave-rpc-token`，修复桌面端转发剥离 `Origin`/`Sec-Fetch-Site` 导致的 `403`）；若重装或重启后旧窗口页面 Token 已轮换，前端会提示重新加载 DSH 窗口；若在共享只读视图（如 `share-viewer`）下访问设置接口，服务端会按最小权限原则拒绝写/读配置并提示 `owner role required` |
| 设置页或对话 Dock 显示其它压缩引擎正在接管（`engineActive` 警告横幅） | 表示当前预设或运行环境中存在其它上下文压缩引擎接管了官方压缩槽位（例如 `dsh-world` 或 `billion-context`），请按横幅提示停用冲突配置并重启 DSH |

## 审计误拒与自然语言边界

`PROGRESS_FACT_CONFLICT` 表示候选摘要中的显式 `key: value` 结构化进度字段（如 `*Count`、`*Completed`、`*Generated`、`*Passed`、`*Failed`、`*Path`、`*State`、`*Status` 与 `nextAction`）与来源消息里同一工作作用域的最新记录相矛盾（例如把已知数量写成 `null`，或把历史 `seq` 数值误写为当前进度）。常规诊断文件仅记录错误码、阶段、尝试状态、有效设置、估算值与 `auditReports` 索引，不保存来源事件序号、用户原话或候选摘要正文；`audit-reject/` 快照则直接记录 `summaryChars`、`trigger`、`audit.coverageThreshold`、`audit.softCoverageCount`、`audit.auditFallbackSkippedReason`、`audit.lostCount` 与 `audit.lost`，对照其中的来源事件序号、源消息片段与候选摘要表述即可快速定位。

来源隔离直接基于宿主事件通道与显式标签边界（工具结果及系统上下文参照不再被当成用户命令；若你在自己的用户消息里粘贴了包含要求句式的大段第三方材料，建议用 `<quoted_text>...</quoted_text>` 或代码块包起来以明确区分）；默认 `auditCoverageScope: 'recent'` 将覆盖率硬审计收敛在近期原话与本跨度新增要求内（超长历史/旧窗口迁移不再因早期条数过多而卡死），同时所有硬冲突红线（极性、数值、单位、条件、范围、关系、例外、引用、来源溯源）依然全局强制执行。若确认候选摘要与最新来源一致却仍被拒绝，欢迎附带最小复现片段、错误码与模型信息提交 Issue。当某条已对应上的用户要求仅存在局部表述冲突（且未触发进度冲突、整条漏写或假授权拦截）时，引擎也会优先尝试用用户原话确定性替换该争议句。

## 诊断文件位置与内容

插件默认存储在以下独立目录：

```text
<DSH_HOME>/storages/dsh-compaction-weave/
```

- `diagnostics/`：采用白名单字段记录失败阶段、错误码、每次尝试状态、耗时、返回用量、有效配置、输入估算、脱敏 `windowLookupFailure`（含后台 `session-memory` 失败路径查窗降级观测，且零失败直接重建成功不再误写 `outcome: "recovered"`）、分页进度及关联的 `auditReports` 索引，不包含来源事件序号、会话原话或候选摘要正文。其中 `context` 下的模型路由反映会话与摘要配置路由，不代表供应商最终实际响应的模型名；`actualDshVersion` 记为 `null` 表示未可靠采集到实际运行的宿主版本（排查或反馈时可手动补充实际版本），`supportedDshVersion` 则记录插件声明的宿主兼容范围字符串（`">=0.2.2-rc.1 <1.0.0-0"`）。
- `audit-reject/`：保存未通过要求或进度校验的候选摘要、实际审计文本、`summaryChars` / `trigger`、`audit` 字段（`coverageThreshold`、`softCoverageCount`、`auditFallbackSkippedReason`、`lostCount`、`lost`）、来源事件序号及对应源片段，可由诊断文件中的 `auditReports` 字段定位。
- `sessions/`：按会话保存已归档的原始历史事件与附件。
- `backups/`：按会话保存兼容转换前的原始字节完整会话备份（保留 `.v4.jsonl.zstd` / `.v4.jsonl` 原编码与 SHA-256 校验清单）、`pending-restore.json` 待还原标记与还原前安全副本，不向 DSH 原始会话目录写入额外文件。
- `state/`：按会话持久化熔断计数、安全窗口观测值与可恢复状态（带 SHA-256 校验和及工作线程锁保护）。
- `journal/`：保存替换提交期间的事务进度账本、并发锁与恢复状态记录。
- `continuation-progress/`：保存后台容量分页接续及分块中断的已接受页面、源哈希与调用账本，支持暂停或崩退后恢复。
- `session-memory/`：仅在开启 Opt-In `sessionMemoryEnabled` 后创建，保存回合间隙后台预热的滚动记忆及周期调用熔断计数。
- `gate-receipts.jsonl`：有界滚动（最大 256 KiB）记录压缩入口接管与禁用清理回执，仅保存计数摘要 `{ rewritten, strippedDisabled, inheritedAutoFalse }`，不落盘同宿兄弟插件配置树。
- `summary-config.json`：保存设置页全部热生效配置（摘要供应商与模型、输出上限、触发/缩减比例、重试与并发、推理力度、CJK 权重、闲置阈值、审计范围与拦截/兜底/熔断策略、分层压缩开关、重注入、图片/归档阈值及自定义参考前缀）。

对话提示中给出的诊断路径对应当次操作，排查时优先查看该文件。若公开分享排查资料，请注意 `audit-reject/` 与会话片段包含用户原话与候选摘要正文，上传前请先检查并脱敏。`sessions/`、`audit-reject/`、`journal/` 等持久化目录与文件默认以 `0700` / `0600` 权限创建；该权限保护适用于 POSIX（macOS/Linux），Windows 下受 Node.js 文件权限语义限制（不引入外部 ACL 工具修改）。

## 提交 Issue

遇到报错、压缩后回答质量明显下降，或遗忘要求与工作进度时，可在 [GitHub Issues](https://github.com/NightFrost42/dsh-compaction-weave/issues/new/choose) 选择中文或英文模板提交反馈。

日志与诊断附件均为可选。报错类问题可附上经过检查的诊断文件副本，并在正文中补充实际使用的 DSH 版本；回答质量或记忆遗漏问题可附上关键要求原话，以及压缩前后表现差异的最小对话片段。脱敏方法与隐私注意事项见 [提交问题与日志脱敏](feedback.md)。

## 更新与卸载

桌面端更新本地安装包时，先在“插件”页卸载已安装的旧版 Weave，再通过“添加插件”安装新包并重启 DSH。独立存储目录中的历史归档与摘要设置会自动保留。

命令行 profile 停止后可通过 npm 覆盖升级，或指定本地 `.tgz` 路径卸载/升级：

```bash
dsh plugin --profile web add dsh-compaction-weave
dsh plugin --profile web add /absolute/path/dsh-compaction-weave-0.6.0.tgz
dsh plugin --profile web remove dsh-compaction-weave
```

执行完成后重新启动对应 profile 即可。
