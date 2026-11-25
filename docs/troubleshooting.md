# 故障排查

[简体中文](troubleshooting.md) · [English](en/troubleshooting.md)

## 摘要失败时会发生什么

当单次摘要请求超时或未通过审计校验时，插件会按配置自动重试。默认在首次请求后最多追加 2 次重试，校验失败原因会作为修正反馈一并传给摘要模型。

若重试次数耗尽仍未通过，对话界面会显示失败原因与诊断文件路径。尚未提交替换的原始上下文保持不变；后台分页接续中已完成校验的页面会保存在本地，供后续继续处理。

| 提示类型 | 处理方式 |
| --- | --- |
| 摘要超时或断流 | 检查模型供应商连接状态，或在设置页适当调高等待上限与重试次数；已提交的分片与断点会自动保留，下一条消息、进度卡片“继续”或 `/compact resume` 会从断点续传 |
| 压缩中途暂停、崩退或想放弃未完成断点 | 进行中可点进度卡片“暂停”或执行 `/compact cancel`，已提交分片不会回滚；进程崩溃重开会话时插件会在加载前自动闭合残留锁并转为可续传断点。普通中断在下一条消息前自动续传，也可点“继续”或执行 `/compact resume`；若因额度耗尽（`paused_budget`）或连续失败（`paused_failure`）暂停，不会阻塞正常对话，排查后可点“继续”/`/compact` 恢复，或点“放弃进度”/`/compact discard` 清除断点（完整备份不受影响） |
| 摘要并发触发 429 限流、耗时偏慢或 `UNSUPPORTED_REASONING_EFFORT` | 默认并发 `summaryConcurrency: 2` 且推理力度为 `auto`（非 Anthropic 路由有思考时压到 `low`，Anthropic 同路由跟随主会话以复用缓存，主会话未开思考时不强行开启），遇 HTTP 429 时会自动将并发降至 1 并冷却重试；直接选择 `low` / `minimal` / `medium` / `high` / `xhigh` / `max` 时若模型不支持也会自动沿阶梯向下回退并省略。若仍被拒，请在 **设置 → 摘要模型 → 摘要推理强度** 设为 `none` 或该模型支持的档位 |
| 摘要结构不完整或输出截断 | 调高摘要输出上限（`maxTokens`），或更换更适合长文本归纳的摘要模型 |
| 要求、极性或指令来源审计未通过（`CONSTRAINT_POLARITY_LOST` / `reason=provenance`） | 查看提示中的触发类型（`untrusted-source` / `revoked` / `missing-source`）、触发摘要句与诊断文件中的 `auditReports` / `audit-reject/` 记录。仅设 `auditBlockOnLoss: false` 不会放行极性反转（`CONSTRAINT_POLARITY_LOST`）或来源审计（`provenance`）；若触发来自第三方消息桥接或记忆插件注入，可将 `source.kind` 加入 `extraReferenceSourceKinds` 或将裸前缀加入 `extraReferencePrefixes`（已内置常见 IM 桥接与多行记忆注入头），无依据归纳可按需设 `auditProvenanceBlock: false`（`untrusted-source` 与 `revoked` 仍始终强拦截） |
| 自动压缩连续失败触发熔断（`COMPACTION_STOPPED`） | 失败后输入框上方卡片会显示最近根因错误码、诊断 ID 与高成本大上下文计费提示：排查设置或切换模型后点击「手动重试压缩」（成功率清除所有熔断计数与放行标记）；如需在预算安全线内先继续对话，可通过设置页「自动压缩熔断后策略」（`confirm` / `degrade` / `block`，默认 `confirm`）或在卡片中二次确认放行，也可随时「恢复拦截」或复制脱敏诊断摘要反馈问题；注意 `RECOVERY_REQUIRED`、待续传与超出 `messageBudgetTokens` 红线永远不会放行 |
| 同时安装 `dsh-world` 后 Weave 静默未挂载 | 若 `dsh-world` 开启了压缩接管（`compactionSwapped` / `dsh-world/compaction`），会覆盖官方 `@deepseek-ai/dsh-compaction-basic` 行导致 Weave 无法挂载。预设模式请在 World Console 点击 **概览 → 会话预设 → 还原 DSH 预设**；非预设模式设置 `replaceCompaction: false`（`dsh-world` 的日记、`memory_find` 与记忆注入均完整保留），详见 [README 共存说明](../README.md#与-dsh-world-共存及第三方桥接隔离) |
| 输入或单组工具消息过大 | 插件会在超长会话上自动执行第一级分批工具输出掩码、按主摘要目标独立计算窗口容量、按波次分层折叠检查点并限制每块/每波工具引用上限；若单条消息或单组工具仍超限，请根据诊断中的估算值调高摘要模型窗口或输入预算配置 |
| 后台分页调用额度耗尽 | 排查提示原因后，输入 `/compact` 为剩余未完成页面续批一轮调用额度 |
| 从 `billion-context` 切到 Weave 后无法自动压缩或遇到旧折叠块 | Weave 接管官方压缩行时会自动清除残留的 `disabled: true`；若日志提示继承了 `auto: false`，请从 profile patch 中移除 `auto: false` 或显式配置 `engine.auto: true`。旧会话中的 `billion-context` / `billion-context-dsh` 折叠块或工具记录可通过进度卡片中的“兼容转换为 Weave”按钮或 `/compact migrate` 一键转换，转换前会自动创建并经 SHA-256 校验完整原始会话备份；如需回退，可点击卡片中的“还原备份”或执行 `/compact backups`、`/compact restore [backupId]`（已打开的会话会先锁定写入，在关闭重开或重载 DSH 后自动完成原子还原） |
| 弹出 `billion-context` 并存/代理残留警告或 `413` `preflight_compress_failed`（`BILI_COEXISTENCE_CONFLICT` / `BILI_PROXY_CONFLICT`） | 请在插件管理页停用或卸载 `billion-context`（含 `billion-context-dsh`），检查模型供应商 `baseUrl` 是否仍指向 bili 的 `127.0.0.1` / `localhost` 本地代理并还原为直连上游地址，然后**彻底重启一次 DSH**（即使刚才已在界面里关闭过 `billion-context` 也必须彻底重启以清理内存钩子与代理端口）；普通上游 HTTP `413` / `model window` 窗口溢出由 Weave 接管重试与合法 Snip 兜底 |
| 会话恢复或写隔离提示 | 保留存储目录中的事务日志与 `.rollback` 备份，重启宿主后查看恢复结果 |
| 宿主兼容或私有方法校验提示 | 核对当前 DSH 版本是否处于 `>=0.2.2-rc.1 <1.0.0-0` 范围（正式原子事务实测覆盖 `0.2.2-rc.1`、`0.2.2-rc.2`、`0.2.2-rc.3`）；在默认 `strictHostFingerprints: false` 下，若宿主小更新调整私有持久化方法，插件会在确认无未恢复 `.rollback`/`.tail` 原子日志后发出一次兼容提示并自动改走公开 `Session.append(replace)` + `sessions.flush()`；仅当设为 `strictHostFingerprints: true` 或存在未恢复原子日志时才会阻止压缩并保留恢复材料 |
| DSH Desktop `0.2.3-alpha.2+` 设置页 RPC `403 missing origin refused` / `403 owner role required` | 请升级至 `0.6.0` 并彻底重启 DSH（进程会随 `webserver/index-inject` 下发随机 `x-weave-rpc-token`，修复桌面端转发剥离 `Origin`/`Sec-Fetch-Site` 导致的 `403`）；若是在共享只读视图（如 `share-viewer`）下访问设置接口，服务端会按最小权限原则拒绝写/读配置并提示 `owner role required` |
| 设置页顶部显示其它压缩引擎正在接管（`engineActive` 警告横幅） | 表示当前预设或运行环境中存在其它上下文压缩引擎接管了官方压缩槽位（例如 `dsh-world` 或 `billion-context`），请按横幅提示停用冲突配置并重启 DSH |

## 审计误拒与自然语言边界

`PROGRESS_FACT_CONFLICT` 表示候选摘要中的显式 `key: value` 结构化进度字段（如 `*Count`、`*Completed`、`*Generated`、`*Passed`、`*Failed`、`*Path`、`*State`、`*Status` 与 `nextAction`）与来源消息里同一工作作用域的最新记录相矛盾（例如把已知数量写成 `null`，或把历史 `seq` 数值误写为当前进度）。常规诊断文件仅记录错误码、阶段、尝试状态、有效设置、估算值与 `auditReports` 索引，不保存来源事件序号、用户原话或候选摘要正文；`0.6.0` 的 `audit-reject/` 文件已直接记录 `summaryChars`、`requirementLines`、`coverageThreshold`、`blockingLost`、`softCoverageCount`、`auditCoverageScope` 与 `auditFallback`，对照其中的来源事件序号、源消息片段与候选摘要表述即可快速定位。

来源隔离直接基于宿主事件通道与显式标签边界（工具结果及系统上下文参照不再被当成用户命令；若你在自己的用户消息里粘贴了包含要求句式的大段第三方材料，建议用 `<quoted_text>...</quoted_text>` 或代码块包起来以明确区分）；默认 `auditCoverageScope: 'recent'` 将覆盖率硬审计收敛在近期原话与本跨度新增要求内（超长历史/旧窗口迁移不再因早期条数过多而卡死），同时所有硬冲突红线（极性、数值、单位、条件、范围、关系、例外、引用、来源溯源）依然全局强制执行。若确认候选摘要与最新来源一致却仍被拒绝，欢迎附带最小复现片段、错误码与模型信息提交 Issue。当某条已对应上的用户要求仅存在局部表述冲突（且未触发进度冲突、整条漏写或假授权拦截）时，引擎也会优先尝试用用户原话确定性替换该争议句。

## 诊断文件位置与内容

插件默认存储在以下独立目录：

```text
<DSH_HOME>/storages/dsh-compaction-weave/
```

- `diagnostics/`：采用白名单字段记录失败阶段、错误码、每次尝试状态、耗时、返回用量、有效配置、输入估算、分页进度及关联的 `auditReports` 索引，不包含来源事件序号、会话原话或候选摘要正文。其中 `context` 下的模型路由反映会话与摘要配置路由，不代表供应商最终实际响应的模型名；`actualDshVersion` 记为 `null` 表示未可靠采集到实际运行的宿主版本（排查或反馈时可手动补充实际版本），`supportedDshVersion` 则记录插件声明的宿主兼容范围字符串（`">=0.2.2-rc.1 <1.0.0-0"`）。
- `audit-reject/`：保存未通过要求或进度校验的候选摘要、实际审计文本、来源事件序号及对应源片段，可由诊断文件中的 `auditReports` 字段定位。
- `sessions/`：按会话保存已归档的原始历史事件与附件。
- `backups/`：按会话保存兼容转换前的原始字节完整会话备份（保留 `.v4.jsonl.zstd` / `.v4.jsonl` 原编码与 SHA-256 校验清单）、`pending-restore.json` 待还原标记与还原前安全副本，不向 DSH 原始会话目录写入额外文件。
- `summary-config.json`：保存摘要模型路由、重试、闲置与 `auditBlockOnLoss` 设置。

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
