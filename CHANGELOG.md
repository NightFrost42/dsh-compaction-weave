# 更新记录

## [0.5.3-hotfix.1] - 2026-11-25

- **DSH Desktop `0.2.3-alpha.2` 设置页与进度轮询 `403 missing origin refused` 紧急热修（Issue #19，基于 `v0.5.2` 单点热修，npm 仅发 `hotfix` dist-tag，`latest` 仍保持 `0.5.2`）**：
  - **真机根因定位**：在升级后的 DSH Desktop `0.2.3-alpha.2` 上确认主进程 `forwardWebRequest()` 在将 `dsh-app://app/` 请求转发至本机 Host（`127.0.0.1:<port>`）时会主动剥离 `host`、`origin`、`cookie`、`sec-fetch-site` 请求头（同时 `dsh-client-connection` 自 `v0.2.2-rc.2` 起已移除旧 `requestRejection()`，改为 `webserver/authorize` / `admit()`），导致 `0.5.2` 下的设置页 RPC 与进度条轮询全部因空 `Origin` 返回 `403 missing origin refused`。
  - **三层兼容与安全守卫（[index.js](lib/index.js)、[client.js](lib/client.js)）**：
    1. 保留第一优先级宿主 `connection.requestRejection`（拒绝码不可被 Token 绕过）；
    2. 新增第二优先级主通道：通过宿主 `webserver/index-inject` 惰性生成进程级随机 Token（`randomBytes(32).toString('base64url')`）注入 `globalThis.__WEAVE_RPC_TOKEN__`（跨插件重载存活，卸载 `try/finally` 清理防泄漏），`lib/client.js` 的 `rpc()` 与 `status` 轮询统一经 `buildRpcHeaders()` 附带 `x-weave-rpc-token`，服务端先按 UTF-8 字节长度对齐再用 `timingSafeEqual` 校验；
    3. 新增第三优先级同源头兜底：在无 `connection` 且无有效 Token 时，仅在无跨头矛盾下对单一 `Sec-Fetch-Site: same-origin` 或无 userinfo 且按协议归一化端口匹配 `Host` 的 `http:`/`https:` 同源 `Referer` 放行，并对既无鉴权又无同源头信号的裸空 `Origin` 请求继续拦截（`403 missing origin refused`）；
    4. 同步加固重复/数组/大小写重复安全头、逗号拼接 `Sec-Fetch-Site`、非 `http(s):`/含 userinfo/含路径 `Origin` 及 `:80` vs `https :443` 端口混淆绕过防护（携带跨站 `Origin`/`Sec-Fetch-Site` 即使附带正确 Token 仍拒为 `403`）。
  - **验证结果**：通过 [wave3-audit-hardening.mjs](test/wave3-audit-hardening.mjs)（`16/16`）、`npm run check`、`npm test`（`96` 套 / `1,417` 用例）、DSH `0.2.2-rc.3` 宿主集成测试（`104` 套 / `1,548` 用例）与本地 DSH Desktop `0.2.3-alpha.2` Electron 真机 CDP 实测。

## [0.5.2] - 2026-11-24

- **审计与溯源假阳修复（Issue #11 收口）**：
  - [audit.js](lib/audit.js) 在覆盖率（`extractConstraintLines` / `isPureQuestion`）与溯源两侧统一跳过无结尾标点中文疑问句（如 `see-now不能做到同样的事吗`、`storyboard能不能做到`、`端口是不是改成8080`），并拒绝疑问语气非授权句；
  - [action-state.js](lib/action-state.js) 修复尾缀剥离顺序（`现在提前开始任务吧`），[audit.js](lib/audit.js) 在 `ACTION_DIRECTIVE_RE` 与 `VERB_FAMILY_RES` 补全 `开始 / 开工 / 开跑 / 启动 / 继续 / exec`、支持加粗/空括号剥离与「时间状语/动作 + `吧`」口语执行授权，并补齐受严密动词族/作用域/括号防夹带守卫保护的括号外标签与验证 `seq N` 引用溯源（覆盖 `Round4 于 22:00 提前开跑（用户批准提前）`、`**round4 提前开跑**（用户 seq 35367 批准）`、`**Round4（用户 seq 35367 批准）**：新房测试提前开跑` 等摘要归因写法，同时继续严防借 `seq` 洗白跨动词/跨环境或未授权动作）；
  - 修复围栏代码块内误拆行、`ownedByPeer` 跨条目吞并丢失数字/文件名（`lineFactsPreservedIn`）、`规则1：` 等条目序号误作标量（保护 `0.58` / `1.5s` / `0.5GB` 等小数），以及跨段 `seq=35577` 条件句（含 `只要`）混合极性等价改写放行与全部否定子句覆盖校验。
- **通用确定性审计规则增强**：
  - [audit.js](lib/audit.js) 收齐中文并列否定作用域（`随后 / 然后 / 接着 / 继而` 及含情态覆写的 `或允许 / 以及仍然需要` 等连接词）并消除纯摘要独立模式下顿号/逗号并列否定（如 `不得覆盖、删除已有文件或修改生产环境`）的误报；
  - [audit.js](lib/audit.js) 与 [action-state.js](lib/action-state.js) 补齐英文规范情态词 `shall`、`shall not`、`may not`（严格排除裸 `may`）、`required to`、`prohibited from`、`ought to`、`ought not to`；
  - [audit.js](lib/audit.js) 增加无歧义同族单位精确换算等价放行（`1000ms == 1s`、`60s == 1min`、`60min == 1h`、`24h == 1d`、`1024KB == 1MB`、`1024MB == 1GB` 等，继续拒绝 `1 month == 30d` 与不等数值）及通用 CLI Flag（`--flag` / `--no-flag`）与布尔开关（`key: false/true`、`key=false/true`）极性一致性校验；引入有界缓存与倒排候选预过滤（`subQueriesForLine` / `lineIdsByFeat`），消除多规则共享词元时的 $O(N^3)$ 主线程卡顿。
- **路由自适应推理强度、`observationMaskingEnabled` 设置页与独立 `maxTokens`**：
  - [config.js](lib/config.js)、[summary.js](lib/summary.js) 与 [client.js](lib/client.js) 将 `summaryReasoningEffort` 默认值改为路由自适应 `'auto'`（Anthropic/Claude 同路由继承主会话思考强度以复用提示词缓存，非 Anthropic 路由有思考时收敛为 `'low'`，主会话未开思考时不强行开启；用户手动选择始终优先）并完善模型级与跨路由回退逻辑；
  - 新增可热配置与设置页调节的 `summaryCjkTokensPerChar`（默认 `0.75`，支持调至 `1.0`）与 `observationMaskingEnabled` 开关，并在 [summary-config.js](lib/summary-config.js) 支持未覆盖摘要模型时独立保存 `maxTokens` 及显式 `clear` RPC；[meter.js](lib/meter.js) 对齐 Stage-1 与规划阶段估算口径。
- **安全边界、契约一致性与生命周期可靠性加固**：
  - [index.js](lib/index.js) 为 HTTP RPC 接入 `ctx.connection?.requestRejection(req)` 并加强回环/`Host`/`Origin`/`sec-fetch-site`/`Content-Type: application/json` 校验，修复 `compaction/end` 遗留 `activeCompactions` 竞态并移除不兼容 `agent/request` 监听（改以 `AsyncLocalStorage` 在 `agent/pre-step` 透传 `modelSelection`）；
  - [engine.js](lib/engine.js) 与 [session-memory.js](lib/session-memory.js) 避免跨模型切换首轮沿用旧路由 `header.config.maxTokens`、`MAX_TOKENS` 误进内容重试阻断缩跨度，限制 `lastRunAt` LRU（512 上限）并清理 `_disposed` 状态；[transaction-host.js](lib/transaction-host.js) 与 [atomic-replace.js](lib/atomic-replace.js) 加固 `committed` 恢复幂等、Windows 原子替换与 DSH `0.2.2-rc.1` 归一化指纹。
- **常驻工具 Schema 精简与文档对齐**：
  - 精简 [history.js](lib/history.js) `HISTORY_TOOLS`（尤其 `history_read`）与 `HISTORY_SNAPSHOT_WARNING` 描述，并在 [README.md](README.md)、[README.en.md](README.en.md)、[配置说明](docs/configuration.md)、[Configuration](docs/en/configuration.md) 及设置页补齐启发式 Token 估算口径与 4 工具常驻 Schema 体积说明；新增 [wave1-security-hardening.mjs](test/wave1-security-hardening.mjs)–[wave4-audit-hardening.mjs](test/wave4-audit-hardening.mjs) 等回归套件。

## [0.5.1] - 2026-11-24

- **高熵工具预览与 `history_read` 图片元数据防爆**：新增 [tool-preview.js](lib/tool-preview.js)，在 [observation-mask.js](lib/observation-mask.js) 与 [reference-input.js](lib/reference-input.js) 启用 3 级高熵预览（中段异常聚簇 `[L<n>]` 窗口、白名单扩展名零 AST 声明骨架、160 KiB 内 2 层浅 JSON 摘要）及双缩小门禁（`history_search`/`history_read` 默认放宽至 500 chars）；[history.js](lib/history.js) 与 [tools.js](lib/tools.js) 在 `history_read` 读取图片时默认返回 SHA-256 校验元数据（保留 `rawBase64: true` 兼容）。
- **多模态防线闭环（`IMAGE_OFFLOAD_REQUIRED` 协同、`stripImagesForSummary` 降级与双水位批量图片卸载）**：[image-budget.js](lib/image-budget.js)、[meter.js](lib/meter.js)、[summary-budget.js](lib/summary-budget.js)、[summary.js](lib/summary.js)、[region.js](lib/region.js)、[continuation.js](lib/continuation.js) 与 [engine.js](lib/engine.js) 打通模型拒绝图片输入时的本地原生 `image/offload` 重试（最多 2 轮）与纯内存剥图降级；新增热点配置项 `maxVisibleAttachmentBytes`（默认 16 MiB）与 `maxVisibleImages`（默认 24）并在 [config.js](lib/config.js)、[summary-config.js](lib/summary-config.js)、[client.js](lib/client.js) 与中英文 [配置说明](docs/configuration.md) / [English Configuration](docs/en/configuration.md) 暴露界面开关。
- **Cordis 严格代理事件总线隔离、`UNKNOWN` 脱敏诊断与 `/compact reset`（Issue #15）**：[index.js](lib/index.js) 通过顶层安全适配器向 [engine-entry.js](lib/engine-entry.js) 与 [engine.js](lib/engine.js) 桥接 `hookBus`，[hooks.js](lib/hooks.js) 与 [manual-error.js](lib/manual-error.js) 彻底消除未保护 `ctx?.root` / `ctx?.logger` 代理访问抛错；[failure-diagnostics.js](lib/failure-diagnostics.js) 将代理/非激活上下文报错分类为 `CORDIS_CONTEXT_ERROR` 并为 `UNKNOWN` 补充限域脱敏栈顶帧与 `safeDetail`；[command-compact.js](lib/command-compact.js) 与 [state.js](lib/state.js) 新增 `/compact reset` 安全清除熔断与失败计数（含无未决恢复事务时 `STATE_INVALID` 原子重建）。
- **审计误判收窄、明确时长单位与持久化权限/`fsync` 加固（Issue #11 后续 / #14 / #16 / #17）**：[audit.js](lib/audit.js) 在 `ACTION_DIRECTIVE_RE` 补齐 `改为/改成/设为/设置为`、消除 `auditInstructionProvenance` 空核通配 Bug、在 `isBareShortVerbSource` 豁免无对象无否定孤立情态词（`需要`/`must` 等，保留 `别重启`/`需要重启这个模块` 严检）、补全受限 `避免/杜绝/免于` 并显式排除双重否定与目的状语（`为了避免死锁，必须加锁`）、补齐 `年/years?/yrs?`·`个月/months?`·`周/星期/weeks?` 明确时长单位并排除中文日期/时间序数；[audit-reject.js](lib/audit-reject.js) 与 [journal.js](lib/journal.js) 对齐 POSIX `0o700` / `0o600` 权限，[history.js](lib/history.js) 在原子提交后追加 POSIX 父目录 best-effort `fsync` 并在中英文 [故障排查](docs/troubleshooting.md) / [Troubleshooting](docs/en/troubleshooting.md) 说明 Windows 与 POSIX 权限差异；[index.js](lib/index.js)、[region.js](lib/region.js)、[summary-budget.js](lib/summary-budget.js) 与 [continuation.js](lib/continuation.js) 统一 `compaction-basic` 共存提示并透传 `microcompactRepeatedReadMinChars`。
- **兜底被拒诊断、纯 `coverage` `CONSTRAINT_LOST` 引导与多候选顺延（Issue #18 & #11 遗留）**：[audit-fallback.js](lib/audit-fallback.js)、[summary.js](lib/summary.js)、[engine.js](lib/engine.js)、[continuation.js](lib/continuation.js) 与 [failure-diagnostics.js](lib/failure-diagnostics.js) 过滤不可兜底硬拦截、按实际阻断冲突数排序多候选并在耗尽后顺延尝试，失败或被拒时输出结构化 `warn` 日志与脱敏 `auditFallback: { used: false, skippedReason, blockingCount, maxConflicts }` 诊断字段；[failure-diagnostics.js](lib/failure-diagnostics.js) 为纯 `CONSTRAINT_LOST` 补充可操作中文热关闭 `auditBlockOnLoss: false` 引导，同时继续守住极性/溯源/进度/Section 6 强红线。
- **记忆策略重放门控与并发中止排空加固**：[memory-policy.js](lib/memory-policy.js) 重排 `restoreRetiredDecisionsBatch` 优先走当前 `byMap` O(1) 升级并门控 `getLegacyByMap()`，补充 `legacyLastSeq` 覆盖上界追踪并在会话末尾纯追加轮次安全复用历史重放缓存；[concurrency.js](lib/concurrency.js)、[history.js](lib/history.js) 与 [engine.js](lib/engine.js) 为 `runConcurrentPool` 补齐 `AbortSignal` 受限排空等待（`DEFAULT_ABORT_DRAIN_TIMEOUT_MS`）及 `CompactionArchive.writeSpan` / `atomicArchiveWrite` 中止短路，消除并发提前达标终止时滞后写盘导致的竞争。
- **发布验证**：全量通过 `npm run check`、`npm run pack:release` 与真实 DSH 宿主测试矩阵（`100` 套 / `1,497` 项用例，`0` 失败）。

## [0.5.0] - 2026-11-23

- **归档无损 `zstd` 瘦身与存储治理**：[history.js](lib/history.js)、[storage-path.js](lib/storage-path.js) 与 [attachments.js](lib/attachments.js) 默认使用 Node.js 24 原生 `zstd` 无损压缩新建/迁移归档并设置最小权限（目录 `0o700`、文件 `0o600`），同时向下兼容明文与 `.zst` 双读；新增 `archiveWarnBytes` 软告警阈值、[index.js](lib/index.js) / [client.js](lib/client.js) 设置页只读存储统计面板（总归档字节、历史会话与附件数量、可回收占用）、按需手动无损压缩历史归档与保守 fail-closed 孤儿归档清理。
- **启发式审计受控分层兜底与重建增强**：[reconstruct.js](lib/reconstruct.js) 扩展处理引号/冒号规则、数值纠偏与局部极性冲突重构；新增 [audit-fallback.js](lib/audit-fallback.js) 与配置项 `auditExhaustionPolicy`（默认 `'fallback'`，可选 `'block'`），仅当主/备模型链穷尽且至少完成 1 次真实纠偏重试后，对剩余启发式争议规则启用确定性 `<pinned-source-rules>` 外置拼装兜底（继续严格拦截结构损坏、非可信注入/已撤回授权伪造、进度事实冲突与截断），并将降级状态通过 [summary.js](lib/summary.js)、[continuation.js](lib/continuation.js)、[engine.js](lib/engine.js)、[progress-tracker.js](lib/progress-tracker.js) 与 [failure-diagnostics.js](lib/failure-diagnostics.js) 透传至诊断与进度快照。
- **后台会话记忆短限时复用、按周期重置配额上限与设置页消歧**：[session-memory.js](lib/session-memory.js) 新增 `waitForWithin`，在压缩触发时短限时等待并复用已在运行中的后台记忆（零重复 LLM 请求）；[engine.js](lib/engine.js) 将 `sessionMemoryMaxCallsPerSession` 语义改为按压缩周期计费并在成功提交 Weave 压缩或采用 `bili` 迁移后重置当前周期计数（同时保留单调累计 `totalCallsUsed`）；设置页（[client.js](lib/client.js)）与中英文 [配置说明](docs/configuration.md) / [English Configuration](docs/en/configuration.md) 明确区分“后台会话记忆”与“长时闲置自动压缩”。
- **跨版本检查点重放 `MEMORY_SOURCE_UNAVAILABLE` 兼容与脱敏子原因（Issue #13）**：[audit.js](lib/audit.js) 导出 `v0.4.4` 前引号切分器 `sourceEvidenceSentencesLegacyQuoteSplit`，[memory-policy.js](lib/memory-policy.js) 在不削弱缺失事件、SHA-256 篡改与非用户来源 fail-closed 护栏的前提下兼容历史 `。」`/`。”`/`."` 引号切句检查点并升级新版坐标、兼容参考通道白名单（如 `wechat` / 内置裸记忆块）与历史规则漂移；[source-refs.js](lib/source-refs.js) 兼容 `sourceLayout` 剥离行首列表符间隙；[failure-diagnostics.js](lib/failure-diagnostics.js) 为 `MEMORY_SOURCE_UNAVAILABLE` 输出白名单脱敏 `subReason`（`missing_event` / `sha_mismatch` / `fragment_mismatch` / `source_part_mismatch` / `non_user_source` 等），严禁泄露正文。
- **中文极性误判收窄（Issue #11）**：[audit.js](lib/audit.js) 对无对象、无否定、无条件、无数量约束的孤立裸短动词（如 `重启` vs `不用重启`、`restart`）跳过极性误判；将 `hasPolarityConflict` 混合极性逐段比对入口阈值从 `0.9` 放宽至 `Math.max(limit, 0.7)` 并在 `CN_MODAL` / `NEGATION` / `STRONG_DIRECTIVE_RE` / `GOVERNING_NEG_BEFORE_BRACKET_RE` 补齐 `不许`（漏留或翻转禁止半句及 `别重启` / `重启服务` / `do not restart` 仍严格拦截）。
- **发布验证**：全量通过 `npm run check` 与真实 DSH 宿主测试矩阵（`93` 套 / `1,455` 项测试，`0` 失败）。

## [0.4.5] - 2026-11-23

- **`billion-context` 并存 / 本地代理残留多信号探测、前台弹窗告警与服务端早停（Issue #11 跟进）**：新增 [bili-conflict.js](lib/bili-conflict.js)，在不误报纯历史 `<bili-snapshot>` 会话及 Ollama 等合法本地服务（`127.0.0.1:11434`）的前提下，结合同进程标志（`__BILI_DSH_COMPACTION_VERDICT__`、`__BILI_DSH_COMPACTION_GATE_TELEMETRY__`、`biliBasicCompactionPolicy`、启用配置行）与运行时代理残留信号（`SUMMARY_FOREIGN_BILI_FORMAT`、`413 preflight_compress_failed`、`payload core text alone is`、`bili` 回环供应商 URL）汇总脱敏 `biliConflict`；通过 [index.js](lib/index.js) `status` / `get` RPC 透传给 [client.js](lib/client.js)，在输入框上方（`conversation.input.dock`）弹出可暂关闭并保留常驻警告条/重开按钮的前台 `alertdialog` 弹窗及设置页提示条（明确告知停用 `billion-context`、还原 `baseUrl` 并彻底重启 DSH），同时在 [engine.js](lib/engine.js) 于触发压缩/迁移/续传/重试前直接抛出 `BILI_COEXISTENCE_CONFLICT` 避免空烧摘要重试额度。
- **Snip 零副作用防呆与自适应高收益裁剪**：[engine.js](lib/engine.js) 在 `agent/pre-step` 与 `agent/request-error` 对非上下文溢出类或无法通过裁剪自救的失败（`SUMMARY_FOREIGN_BILI_FORMAT`、`BILI_PROXY_CONFLICT`、`BILI_COEXISTENCE_CONFLICT`、`401/403`、`RECOVERY_REQUIRED`、配置/状态/归档异常等）跳过 `_emergencySnip`，且在真正写入 `commitSnip` 前先基于 `plan.projectedRemainingTokens` 校验能否实际压回 `messageBudgetTokens` 以内，救不回时以 0 归档写入、0 surface 改写直接中止，并对同一 `(openTurn, replaceGeneration, nodes.length)` 状态去重；[snip.js](lib/snip.js) 新增 `allowAdaptiveMaxSpans`（默认保守 `maxSpansPerRescue=4` 不变，不足时按高收益跨度自适应放宽至 `24` 并保持时间正序交付）与 `canMeetTarget`。
- **统一 HTTP `413` / 非标准窗口溢出识别与 `bili` 代理分流**：将 `CONTEXT_WINDOW_EXCEEDED`、`httpStatus/status/statusCode === 413`、`model window` / `payload too large` / `oversized content` 统一至 [bili-conflict.js](lib/bili-conflict.js)，打通 [summary.js](lib/summary.js)、[progress-tracker.js](lib/progress-tracker.js) 与 [engine.js](lib/engine.js)（`agent/request-error` 与 `_isRecoverable`），使真实上游 `413` 进入溢出压缩或有效 Snip 自救后 `{ kind: 'retry' }`；同时严格分流 `bili` 本地代理预检拒回（`preflight_compress_failed` 等），直接记为 `BILI_PROXY_CONFLICT` 并抛出可读排障引导，绝不空转重试或触发无效 Snip。
- **诊断明细与 README 安装互斥重启指引补齐**：[audit-reject.js](lib/audit-reject.js)、[continuation.js](lib/continuation.js) 与 [engine.js](lib/engine.js) 在 `audit-reject/` 记录中补全脱敏 `trigger` 字段，并在 `_persistResumableInterrupted` 因错误或超时中断时同步顶层 `sessionState` 的 `failures`、`stopped` 与 `lastFailureCode`；在双语 [README](README.md) / [README.en.md](README.en.md) 安装区顶部新增面向 AI 安装助手的冲突检查、先询问用户及“彻底重启 DSH”提示，同步补充中英文 [故障排查](docs/troubleshooting.md) 与 [Issue #11 回归测试](test/issue11-v045-bili-snip-413.mjs)。

## [0.4.4] - 2026-11-23

- **压缩后确定性工作区重注入、聚焦压缩与程序化钩子（Phase A）**：在 [file-reinject.js](lib/file-reinject.js) 新增零 LLM 费用的压缩后本地最近活跃工作区文件重读与重注入（`postCompactReinjectEnabled` 默认开启，最多 5 个文件 / 24 KiB，远程或合成会话自动跳过并严格防路径逃逸/敏感文件泄漏）；[command-compact.js](lib/command-compact.js) 与引擎新增一次性 `/compact <focus>`（及 `/compact -- <focus>` 消歧）聚焦指令（严格保持 6 个内置子命令不变）；支持同进程 Cordis 事件 `weave/pre-compact` 与 `weave/post-compact`（零 `child_process` Shell 钩子）。
- **工具输出分级外置与时间触发 Microcompact / 后台会话记忆与 TTL 折叠（Phase B / C）**：新增持久化工具输出摘要存根与 `idleCompactionMinutes` 超缓存 TTL 回合优先执行零模型或局部清理（[microcompact.js](lib/microcompact.js)、[context-collapse.js](lib/context-collapse.js)），热缓存期内绝不破坏前序缓存前缀；新增默认关闭的试验性后台会话记忆（[session-memory.js](lib/session-memory.js)，`sessionMemoryEnabled: false`，严格按单会话调用上限计费防误触与源码 SHA-256 防篡改）。
- **紧急兜底 Snip 剪枝（Phase D，默认开启）**：新增 [snip.js](lib/snip.js)（`snipEnabled: true`），仅在硬预算壁垒、`>= 95%` 压力壁垒常规压缩失败或 HTTP `413` `CONTEXT_WINDOW_EXCEEDED` 时作为最后保命手段触发（绝不绕过 `_stopped` 熔断）；严格执行先归档（支持 `history_read` 回查）后在开放回合且无并发压缩锁状态下同步写入 DSH V4 规范四段式信封（`compaction/start` → `compaction/summary` → `user/message` `replace` → `compaction/end`），保护首条系统提示、近期用户原话与有效要求；设置页新增 5 项热生效配置与 `#weave-snip` 开关。
- **进度条脱敏重试原因展示（`retryReasonCode`）**：在 [progress-tracker.js](lib/progress-tracker.js)、[continuation.js](lib/continuation.js)、[engine.js](lib/engine.js) 与 [client.js](lib/client.js) 贯通 `onAttemptError` 安全错误码归一化（严格通过 `SAFE_CODE_RE` 白名单且过滤密钥/正文/泛化错误，分块提交成功或新 run 启动时清零），在 Dock 进度条 `第 {attempt}/{max} 次尝试` 旁紧凑展示中英文重试原因标签。
- **Issue #8 后续结构性边界收窄**：在 [audit.js](lib/audit.js) 中保留 5 道硬护栏与可见性冲突，仅在源侧剥离非限定括号备注后改用守卫式正向包含（`>= 0.75`）并阻止把具体对象授权缩成孤立裸动词；对中文逗号长句逐子句扫描防整句误杀；补入 `私密` 与仓库语境 `不公开` 识别（不放松 `COMPOUND_CLAIM_SPLIT_RE`）。
- **Issue #9 二次压缩大日志防冻死与阶段打点**：在 [memory-policy.js](lib/memory-policy.js)、[region.js](lib/region.js)、[progress-facts.js](lib/progress-facts.js) 与 [summary-budget.js](lib/summary-budget.js) 消除多检查点 `0..max(by)` 重复全历史重放并引入四索引 $O(1)$ 消重、按 `(session, seq)` 缓存索引、安全跳过 `local-script` / `date-fold` / 反转区间等外部检查点、给 `planSummaryRange` 增加有界探查与 `secondaryPrecheck` 前置早退；新增按需开启的隐私安全同步阶段追踪（[stage-trace.js](lib/stage-trace.js)，`WEAVE_TRACE_STAGES=1` 或 `debug: true`）。
- **Issue #10 预算死区修复与预检错误码落地**：消除 [config.js](lib/config.js) 中 `messageBudgetTokens` 位于 `33,001..39,285` 时 `headroomTokens` 不收敛导致新会话首条消息 5ms 预检阻断的死区（`128k` / `200k` / `1M` 基线数值零变化），并为 `resolveCompactSpec` 与 [state.js](lib/state.js) 补齐 `COMPACTION_INVALID_BUDGET`、`COMPACTION_RETAIN_EXCEEDS_THRESHOLD`、`STATE_INVALID`、`STATE_UNAVAILABLE` 及 [failure-diagnostics.js](lib/failure-diagnostics.js) 中文排障引导。
- **Issue #11 全组修复**：收紧 [audit.js](lib/audit.js) `不可` 排除 `不可逆`/`不可或缺`/`不可避免` 等复合形容词、保护引号内名词性纪律引用（如 `维持「上正主前门表」纪律`）、提升无关跨段低重合 `polarity` 防误判门槛并保留完整条件句上下文以严拦条件极性反转、支持 `420（不是 386）` 显式数值更正且严拦旧值回退；[engine.js](lib/engine.js) 幂等记录迁移/续传/崩溃恢复失败，在 `recoverPending` 接管残留 `running` 记录时递增 `consecutiveFailures` 与 `state.failures`（记录 `INTERRUPTED_CRASH`）并在达阈值后转入 `paused_failure` 终止无限自动重试循环；[foreign-fold.js](lib/foreign-fold.js) / [validate.js](lib/validate.js) / [prompt.js](lib/prompt.js) 检出 `<bili-snapshot>` / `[Compressed conversation section]`（`SUMMARY_FOREIGN_BILI_FORMAT`）、注入定向纠偏并在诊断建议提示排查残留 `bili` 本地代理；[audit-reject.js](lib/audit-reject.js) 增加 `256 KB` 单文件渐进截断与 `4 MiB` 总目录滚动清理上限。
- **Issue #12 条件句前缀规范化、时间状语与近重复规则防串味**：[audit.js](lib/audit.js) 修复句末标点与收引号（`。」`）被拆断问题，`conditionParts()` 在识别前统一规范化剥离 `>`、列表符、首尾 `seq` 引用、单对成对引号及 `**`/`__` 加粗标记（同时保持多引号并列片段独立切分）；补齐 `在…(之后|以后|之前|以前|完毕后|完成后|结束后|时|的时候)`、`每当`、`一旦`、`等(到)…(时|的时候|后|之后|以后)` 触发词并拦截 `之前`/`之后` 方向反转，防止 `昨天`/`刚才`/`上次` 等过去叙事误报条件丢失；`ownedByPeer` 保留 `peer` 的 `seq` 归属、消除 `lineCov + 0.05 > 1.0` 悬崖并结合本规则独立有效支撑消除近重复规则互相串味（真漏删近重复要求仍严格拦截）。
- **发布验证**：全量通过 `npm run check`（`239` 个发布源文件）与真实 DSH 宿主测试矩阵（`88` 套 / `1,402` 项测试，`0` 失败）。

## [0.4.3] - 2026-11-22

- **裸非用户记忆注入隔离与 `extraReferencePrefixes`（Issue #7A）**：在 `lib/instruction-source.js` 与 `lib/source-provenance.js` 中自动识别多行独立记忆注入头（如 `===== 长期记忆 =====`、`===== Long-Term Memory =====`、`【记忆导引】` 等且严格要求换行后含正文，避免单行普通用户提问误判），并新增可配置前缀数组 `extraReferencePrefixes`（2–200 字符、最多 64 项，经 `AsyncLocalStorage` 按引擎/策略并发隔离并自动失效 `instructionRanges` 边界缓存）；隔离内容在压缩投影时封装为 `<untrusted_reference kind="reference-prefix">`，全链路排除出 Section 6 `preserved` 与用户要求/极性/闲置输入判定。
- **修复 `repairFeedback` 触发本地 `CONTEXT_WINDOW_EXCEEDED`（Issue #7B）**：`renderRepairFeedback` 严格遵守 `maxBytes` UTF-8 字节上限；`planSummaryRange` 默认预留受控修正反馈余量（`DEFAULT_REPAIR_FEEDBACK_HEADROOM_BYTES = 8704`，按窗口上限 `25%` 封顶并在单组过大时自动回落至完整 `limit` 避免误报 `SUMMARY_GROUP_TOO_LARGE`）；新增 `buildFittedSummaryRequest` 在重试拟合超限时按序裁剪 `issues`、压缩 `repairFeedbackMaxBytes` / `SUMMARY_NOT_SMALLER` 提示并在必要时省略历史反馈（同时保持 `requestLimit` / `capacityLimit` / `assertSummaryCapacity` 契约不变）。
- **来源审计（Provenance）增强、词序无关、`auditProvenanceBlock` 与精准诊断（Issue #8A/8B/8C）**：扩充中英文否定/待批/前置条件授权模式（如`除非`/`前置条件`/`未经`/`之?前不得`/`后才可`与 `prerequisite`/`before`/`only after`）；剔除 `seq #N` 位置引用后再匹配授权词组以实现词序无关；仅在可信用户原文中识别常见口语同意与同条行动指令、严格跳过纯疑问句与 `注意`/`先问我` 警告句、支持口语撤回（`revokedGrants`）、复合授权拆分（防夹带未授权动作）与动词族强校验 + 仓库收尾同义改写；新增 `auditProvenanceBlock`（默认 `true`，仅警告模式仍对命中 `untrusted-source`/`revoked` 保持强拦截），并在报错、`failureExplanation` 与 `FailureDiagnostics` 中直接透出触发摘要原句、`reason=provenance` 与 `kind`。
- **自动压缩熔断分级放行、闲置免阻断与反馈交互面板**：
  - 闲置压缩 `_compactBeforeResume` 遇激活熔断器时记录告警并跳过而不抛出 `COMPACTION_STOPPED`，不阻断日常对话（仍受硬请求预算红线保护）。
  - 新增 `pressureBreakerAction` 配置与热生效设置项（`'confirm'` 默认确认放行 / `'degrade'` 预算内告警放行 / `'block'` 严格阻断）；持久化 `breakerBypassed`、`lastFailureCode`、`lastDiagnosticId`、`lastDiagnosticPath`，并在成功压缩、手动重试、还原备份及恢复后通过 `clearBreakerState` 一键清理。
  - 新增 `retry-compaction` 与 `bypass-breaker`（需两步确认）RPC；输入框上方进度卡片在熔断时展示错误码、诊断 ID、高成本计费提示、「手动重试压缩」、「继续对话（两步确认）」/「恢复拦截」、脱敏诊断复制与反馈问题入口（`RECOVERY_REQUIRED`、待续传与 `total >= messageBudgetTokens` 红线永不放行）。

## [0.4.2] - 2026-11-22

- **修复 Section 6 占位符写进标题导致结构校验误拒（PR #3 by `@qqGit-0528` 与跟进完善）**：采纳 `@qqGit-0528` 在 PR #3 中的修复并在 `lib/prompt.js` 与 `lib/validate.js` 中补全双语对称逻辑：英文提示词同步明确保留 `## 6. All User Messages` 标题并将 `[filled by engine]` 写在正文；`ZH_SECTION_TITLE_VARIANTS[5]` 补齐 `[engine-filled]` / `engine-filled` 与 `ENGINE_PLACEHOLDER_RE` 对称匹配；`materializeUserMessageSection` 仅在标题命中占位符正则时才规范化第六节标题（结合 `language` 与标题/第 7 节 CJK 语境输出 `## 6. 全部用户消息` 或 `## 6. All User Messages`），确保 `## 6. 所有用户消息` 等合法自然中文标题不再被 `language='en'` 误改。
- **直接选择摘要推理强度与阶梯向下回退（Issue #5）**：`summaryReasoningEffort` 新增直接档位 `minimal`、`medium`、`high`、`xhigh`、`max`（共 8 项配置，默认仍为 `low`），设置页下拉框同步更新并支持跨路由直接下发；新增 `resolveModelInfo` 能力预检、按 `ctx.llm` 隔离的有界拒绝缓存（`max → xhigh → high → medium → low → minimal → none → 省略`）以及流抛错/结束块 `UNSUPPORTED_REASONING_EFFORT` 单计费边界内运行时逐级降档与诊断指引。
- **第三方桥接通道隔离与 `CONSTRAINT_POLARITY_LOST` 诊断升级（Issue #6）**：内置将 `wechat`、`qq`、`wechat-bridge`、`qq-bridge`、`im-bridge` 纳入 `REFERENCE_CONTEXT_KINDS` 非用户参考通道，新增 `extraReferenceSourceKinds` 配置项（通过 `AsyncLocalStorage` 按引擎/策略并发隔离，严禁传入 `'user'` 与 `'compact-checkpoint'`）；在全部 `CONSTRAINT_POLARITY_LOST` 报错与 `failureExplanation` 中携带脱敏的 `seq` 与 `source` 元数据，并说明即便关闭 `auditBlockOnLoss` 极性拦截仍严格生效及对应排查路径。
- **`dsh-world` 共存与桥接排查文档（Issue #4）**：在双语 `README` 与 `troubleshooting` 中补充与 `dsh-world`（`compactionSwapped` / `dsh-world/compaction`）共存方案（通过 World Console 还原 DSH 预设或设置 `replaceCompaction: false`，保留日记/`memory_find`/记忆注入）及第三方桥接通道隔离配置说明。
- **回归测试**：新增 `test/hotfix-v042.mjs` 专项回归套件并同步更新 `test/w3-concurrency-config.mjs` 与 `test/client-progress.mjs`。

## [0.4.1] - 2026-11-22

- **修复多块自动压缩过早触发接续死锁（`compactIfNeeded`）**：在 `compactIfNeeded` 串行与并发多块压缩路径中，只有当上下文降至 `<= reductionTarget`（或剩余可压分块耗尽 / 未能继续缩减）时才结束批处理，并将 `_compactChunksConcurrent` 的 `stopBelowTokens` 设为 `reductionTarget + 1`；避免第 0 块刚跌破 `thresholdTokens` 但仍高于 `reductionTarget` 时提前退出批处理并误触发分页接续。
- **修复零进度 `continuationPending` 锁死普通 `/compact`**：新增 `_readPendingContinuationAcceptedPages` 读取磁盘 `continuation-progress` 已接受页数（损坏或校验异常时严格 fail-closed 不清理）；当普通手动 `/compact`（非接续/闲置/主动/显式范围且非既有接续会话）遇到 `acceptedPages === 0` 的残留锁时自动解除内存状态锁（保留磁盘账本）并按普通分块压缩完成；当自动压缩已提交分块后可选接续在 Page 0（`acceptedPages === 0`）失败且上下文低于 `thresholdTokens` 时同步清理零进度锁。
- **修复已暂停/耗尽接续状态低于阈值时误阻断日常对话（`agent/pre-step`）**：当 `resumableCompaction` 处于 `paused_budget`/`paused_failure` 或遭遇零新请求耗尽的 `CONTINUATION_CALL_BUDGET` / `COMPACTION_STOPPED` 时，只要当前上下文低于 `thresholdTokens` 即记录告警并放行用户消息正常对话（零额外模型调用），同时严格保持 `>= thresholdTokens` 与直接调用 `compactIfNeeded('pressure')` 的阻断与预算校验不变。
- **回归测试**：新增 `test/hotfix-continuation-trap.mjs`，离线与宿主集成测试扩展至 **64 套**。

## 0.4.0 — 2026-11-22

- **实时压缩进度卡片与统一中断续压（方案 A）**：在对话输入框上方（`conversation.input.dock`）新增与输入框等宽、适配 DSH 主题变量的实时进度卡片，支持单调总进度、块号/Token 实时刷新与主动 `[暂停]`；手动、自动、闲置压缩或迁移中断后均持久化断点，打开会话即见进度与 `[继续压缩]/[继续转换]`/`[放弃]`，继续发消息自动从断点接续（严格遵守分页预算与失败熔断红线）；新增 `/compact resume`、`/compact cancel`、`/compact discard`。
- **`billion-context` 一键备份迁移与原子还原**：仅在检测到 `billion-context` 折叠块的会话显示「兼容转换为 Weave」入口；转换前自动建立不可变基线 SHA-256 完整备份并支持多波次滚雪球压缩；支持本地时区备份选择、路径一键复制与在线/离线安全还原（缺 `stockAdapter` 时拒绝假成功并明确提示）。
- **可控并发提速与推理降档**：新增热生效 `summaryConcurrency`（1–6 并发，默认 2，受控并发生成审计 + 按块序串行原子提交，遇 HTTP 429 自动降回并发 1 冷却，暂停或鉴权失败联动中止在途槽位）、`summaryReasoningEffort`（默认 `low`，避免继承主会话高推理档位）、重复大文件读取投影去重以及多页接续并行 Map-Reduce。
- **保留审计治理与 Issue #2 修复**：设置页新增热生效 `auditBlockOnLoss` 开关（设置入口更名为「上下文压缩」）；修复 `<system-reminder>` / `AGENTS.md` 被误当成用户约束导致 `CONSTRAINT_LOST`（[#2](https://github.com/NightFrost42/dsh-compaction-weave/issues/2)）并免疫反引号/代码块字面量；修复中文多子句极性误判（`CONSTRAINT_POLARITY_LOST`）及双语九段标题与体积缩减重试反馈。
- **P0/P1 崩溃自愈与并发安全加固**：冷启动在宿主写入 `session/end-seed` 前自动闭合 `phase: 'started'` 及无日志尾随孤儿 `weave-` 压缩锁，`agent/status` 与 `latestEndSeedSeq` 对齐解除旧死锁；冷会话迁移期间拦截并发新回合（`keepInbox: true`）；`weave-state.json.lock` 增加死进程 PID 自动回收；可选层级折叠 `_tryHierarchicalFold` 异常平滑跳过不熔断；细化 4 类忙碌诊断并补齐多 preset 路由与空闲轮询缓存优化。
- **验收基线**：离线与真实 DSH 宿主测试扩展至 **63 套 / 1,211 项检查全部通过（0 失败）**。

## 0.3.4 — 2026-11-21

- **npm `latest` 分发渠道与双语文档更新**：在 `README.md` 与 `README.en.md` 顶部加入绑定 `latest` 标签的 npm 徽章，将推荐安装与升级方式调整为直接安装 npm 包 `dsh-compaction-weave`（`dsh plugin --profile web add dsh-compaction-weave`，自动接收更新提示并免 `allowBuilds`），保留离线 `.tgz` 方案并同步更新 `docs/troubleshooting.md`、`docs/en/troubleshooting.md` 升级命令示例。
- **自动发版工作流（`.github/workflows/release.yml`）**：推送与 `package.json` 匹配的 `v<version>` 标签后自动运行 Windows / Linux 校验与 DSH 宿主兼容矩阵，并通过 npm OIDC Trusted Publishing（自动生成 Provenance 溯源证明，免长期 `NPM_TOKEN`）发布到 `latest`（或预发布 `next`），同时创建或更新 GitHub Release（`--latest` + 全部 5 个产物含无版本号 `dsh-compaction-weave.tgz`）；支持 `workflow_dispatch` 的 `dry_run` 预演。
- **发布文档路径修正**：更新 `docs/development.md` 与 `docs/en/development.md` 中的手动发布命令示例为 `./dist/...` 相对路径前缀（适配 npm 11+），并补充 Trusted Publishing 配置说明。

## 0.3.3 — 2026-11-21

- **修复技术术语被误判为数值约束（[#1](https://github.com/NightFrost42/dsh-compaction-weave/issues/1)）**：在 `lib/audit.js` 中为 `numericFacts` 与 `scalarRequirement` 增加 `isNonQuantityTechTerm` 校验：紧贴数字的大写单字母时长符号（如 `3D`、`2D`、`3M`、`6S`、`2H`）不再被当作时长单位（小写 `3d`/`30s`/`5m`/`2h` 与 `3 days`/`3天` 保持不变）；缺少存储/内存/配额类上下文的独立 `5G` 不再被当作 `5gb`（`备份上限 5G`、`5GB` 及 `25G`/`8GB` 等真实容量约束不受影响）。
- **回归测试**：在 `test/constraint-scope.mjs` 新增 14 项针对 `3D`/`2D`/`5G` 等术语与真实容量/时长边界的回归用例，离线全量测试 **955 项 0 失败**。

## 0.3.2 — 2026-11-19

- **正式稳定版发布与渠道调整**：将包版本升级为 `0.3.2` 正式版，将 `publishConfig.tag` 调整为 `latest`；同时更新发布脚本 `scripts/release.mjs`，每次打包同步输出无版本号副本 `dsh-compaction-weave.tgz` 与带版本号 `dsh-compaction-weave-0.3.2.tgz`，支持 `releases/latest/download/dsh-compaction-weave.tgz` 固定升级入口。
- **宿主兼容放宽与公开接口平滑降级（`strictHostFingerprints: false`）**：将 `engines.dsh` 从 `>=0.2.2-rc.1 <0.3.0-0` 放宽至 `>=0.2.2-rc.1 <1.0.0-0`（覆盖 `0.2.x–0.x`）；新增 `strictHostFingerprints` 配置（默认 `false`）：在无条件阻断未恢复 `.rollback`/`.tail` 原子日志与保留前置归档的前提下，当 DSH 小版本更新调整私有持久化方法时发出一次兼容提示并自动降级为公开 `Session.append(..., { surfaceOp: { op: 'replace' } })` + `sessions.flush()`，避免无关宿主小更新造成插件停机（设为 `true` 时保留严格方法指纹白名单拦截）。
- **第一级零模型调用工具输出折叠（`observationMaskingEnabled`）**：在压力触发下先把尾部外超过 `4000` 字的非报错工具结果归档并折叠为首尾预览与 `history_read` 指针，重新实测达标则直接结束、免去一次摘要模型调用（实测重工具输入压力压缩由 `1 → 0` 次调用、`7329 ms → 19.36 ms`）；不足达标时不污染可见前缀以保 KV 缓存，同时严格限制溯源链深度上限（`< 63`）、单批引用配额（`<= 3840`）及写盘错误 `surfaceMutated` 传播。
- **同模型路由原样前缀复用（`preservePrefixCache`）**：当摘要路由与主会话持久路由一致且预算允许时，保持前缀消息逐字节不变（配对实测从 `60%` / `654 B` 提升至 `100%` / `12,215 B`）；遇到溢出时按原文上限折半并平滑退回外部坐标投影；标准检查点自动附带 `History archive: <compactionId>` 指针与涉及文件列表，超出体积限制时依次精简文件列表或指针行。
- **结构化通道隔离与通用审计（正则大减法）**：用宿主原生事件通道与显式 XML 标签（`<untrusted_reference>`、`<quoted_text>` 等，支持同类嵌套与闭合防逃逸、内部边界转义及 `<channel-provenance>` 清单）替代猜测性自然语言引用正则；要求审计支持按用户原始消息时序重放逐条授权与撤回出处、双侧条件比对、正反同义极性识别、词集查表 + 双字切片与通用争议句修复；进度事实收敛为与业务名词无关的显式 `key: value` 结构化校验（45 轮校验由 `1.08 ms` 降至 `0.01 ms`）。
- **闲置后先压缩与热生效设置**：保留 `0.3.2-rc.4` 引入的“闲置后先压缩”（`idleCompactionMinutes` / `idleCompactionMinTokens` / `idleRetainTokens`，1–43200 分钟自定义、供应商缓存参考说明及设置保存/恢复免重启 DSH）。
- **摘要结构解包与标量审计加固**：`unwrapJsonSectionMap` 新增对单键 JSON 包装（如 `{"handoff": "## 1. ..."}`）与围栏感知四节续传标题的安全解包，并修正 `lib/audit.js` 中“判别”复合词否定边界、行内反引号/加粗剥离（保留 `8080**2` 幂运算）及 ``基线：`listenPort 9443` `` 等空格分隔标量识别，消除切换测试中首轮结构或标量误拒重试。
- **事务备份、检索优化与全套验证**：`.rollback` 改为单趟流式复制兼 SHA-256（`2.1 MB` 提交提速 `14.2%`），归档检索支持多词并查与附件 stat 快检；新增 `test/release-billing-safety.mjs`（9 项资金/额度熔断与入口校验）、`test/astra-review-fixes.mjs`（20 项专项回归）及宿主兼容降级集成校验，全量实测 **51 套活动套件、1059 项断言 0 失败**（44 套离线 941 项 + 7 套 DSH `0.2.2-rc.3` 宿主 118 项）。完成无失真三组真实 Magpie 网关评测（**Gemini 4 Argon / GLM-5.3-Flash / DeepSeek-V4.1-Flash / GPT-6.1 Sol**，其中 `auto/gpt-6-astra` 在官方 Codex CLI 下深度参与代码与基准审计，因网关仅限 Codex 客户端直接访问 `auto/gpt-6-astra`，DSH HTTP 对标槽位依不伪造请求头原则分别采用 `2-2/gpt-6.1-sol` 与 `auto/gpt-6.1-sol`）：32 分支单模型独立对标（Weave `8/8`、**175/176 = 99.43%**，`w2` 零调用均耗时 `35.8 ms`）、5 轮连续压缩 `C1–C5` × `R1–R6` 缓存恢复与速度对标（`R2–R6` 稳态命中 `97%–99%`，GLM 压缩总耗时比 `dsh-basic` 快 `4.01×`），以及 19 次跨模型连续切换（Weave **4/4** 一次过审、`226/226 = 100%`），详见 [测试记录](docs/testing.md)、[docs/benchmarks/v0.3.2-tests.json](docs/benchmarks/v0.3.2-tests.json) 与 [docs/benchmarks/v0.3.2-live-four-way.json](docs/benchmarks/v0.3.2-live-four-way.json)。

## 0.3.2-rc.4 — 2026-11-17

- 作为候选基线提交（`a41b41a`），引入“闲置后先压缩”（`idleCompactionMinutes`）预设与 1–43200 分钟自定义设置、设置损坏保护与运行期并发配置快照隔离、历史锚点/约束/状态修正，归档前通过 67 套 / 2064 项基线测试（留存于 `docs/benchmarks/rc4-tests.json`）。

## 0.3.2-rc.3 — 2026-11-14

### 宿主兼容与接口适配

- 将 `engines.dsh` 兼容范围扩宽为 `>=0.2.2-rc.1 <0.3.0-0`（覆盖 `0.2.2-rc.1` 起的 `0.2` 系列含预发布版，不含 `0.3.0` 预发布版）。
- 核验并纳入 DSH `0.2.2-rc.2` / `0.2.2-rc.3` 新增批量输入与单事件快照校验辅助函数后的 `Session.append` 实现指纹（保留 `0.2.2-rc.1` 指纹）；`Session.commit`、`Session.publicationEntry`、`SurfaceManager.validateNext`、`SurfaceManager._processDelta`、JSONL 后端与句柄受检方法、官方 `/compact` 命令及 `token-meter` 实现保持不变。
- 诊断元数据中的 `supportedDshVersion` 现记录兼容范围字符串 `>=0.2.2-rc.1 <0.3.0-0`，`actualDshVersion` 保持 `null`（可在反馈时手动补充实际宿主版本）。
- 未知宿主写入实现仍会在发起摘要请求或执行事务性历史替换前拒绝压缩，并保留已有恢复材料；本次不改动压缩、冷读、预热或重生成策略。

### 测试与 CI

- 新增真实宿主事务与版本范围测试套件（8 项检查）：覆盖 `rc.1` / `rc.2` / `rc.3` 及后续 `0.2` 范围准入、旧版与 `0.3` 预发布版拒绝、原生持久化提交与本地归档回读及重开、提交前失败回滚、提交后发布异常保留持久化结果并在冷启动时清理决策、物理尾部中断从已校验备份恢复并关闭生命周期后重开、未知 `append` 在摘要请求前拒绝，以及批量/单条 `append` 后的完整压缩与回读（不调用付费模型）。
- 实测通过全部离线（50 套、1597 项）与真实宿主集成（6 套、101 项）共 **56 套、1698 项**测试（0 失败）：Windows（Node.js 24.21.0）分别完成 DSH `0.2.2-rc.1` 与 `0.2.2-rc.3` 实测，Linux（Node.js 24.9.0）分别完成 DSH `0.2.2-rc.2` 与 `0.2.2-rc.3` 实测；明细记录于 `docs/benchmarks/rc3-host-compatibility.json`。
- GitHub Actions 保留原有离线矩阵，并新增 Windows / Linux × DSH `0.2.2-rc.1` / `0.2.2-rc.3` 隔离宿主测试矩阵。

## 0.3.2-rc.2 — 2026-11-14

### 修复

- 修正已复现的要求与进度审计误拒：明确关联来源序号和被最新进度取代的旧快照，区分历史转述、当前状态、缺少证据与未来动作，减少合格摘要的重复生成。
- 保留参数修订、独立禁止事项及协调动作列表中的否定范围；转折后的新相反动作、错误当前值和错误下一步仍会被拦截。
- 将产物完成谓语与第一步动作绑定到所属工作项，避免报告、图表和扫描状态串扰；已有原始来源 ID、哈希与存储格式保持兼容。
- 摘要服务未返回 `usage` 或失败时适配器合成全零用量时，传入 `null` 并将尝试记录标记为 `usageKnown: false`（不写入虚构零用量字段）；成功响应返回的真实零用量、正数与缓存用量仍正常保留。
- 补齐真实失败摘要重放与否定范围、旧快照边界回归；“并非……”“不是……而是已被取代”等复杂中文间接否定仍为已知识别边界。
- 移除旧版独立的 `/context-continue` 手动接续命令注册及提示；常规 `/compact` 与后台分页接续机制继续保留，支持已完成页面恢复及有限重试预算。
- 失败诊断采用白名单字段补充运行环境、会话与摘要配置路由、有效设置、输入估算、重试等待与失败分类（`failureKind`）；确定性重建成功后保留关联的 `auditReports` 审计记录索引。

### 策略与验证

- 保持既有增量压缩与必要时完整合并策略，压缩后首答保持正常冷读、不额外预热；后半段检查点局部合并实验未获得跨模型一致收益，未设为默认。
- 配对费用实验计入内容、格式、语义及审计误拒导致的重生成（含未完成的内容失败分支）与压缩后 6 次接续回答，排除网络、供应商、限流、超时与断流请求失败。DeepSeek、GPT、Gemini 按返回 `usage` 与记录的网关单价估算；GLM 测试使用免费额度，未核查适用结算单价和实际账单，仅将真实返回的 `usage` 套入 DeepSeek 网关单价做情景估算。
- 最终代码在 Windows（Node.js 24.21.0、DSH 0.2.2-rc.1）通过 55 套、1690 项回归（含宿主集成），在 Linux（Node.js 24.9.0）通过 50 套、1597 项离线回归，均 0 失败。在移除独立 `/context-continue` 命令及调整诊断元数据前，基于内部 `rc.1` 打包构建完成的 **Gemini 4 Argon → GLM → DeepSeek → GPT** 联网验收共执行 4 次压缩（各 1 次摘要请求，无重生成）、24 次模型切换与 60 次 HTTP 请求，728 / 728 个状态字段和 77 / 77 项流程结构检查通过。

### 文档与发布

- 修订中英文 README 与原理、测试、排障、反馈文档，集中说明适用边界、诊断字段含义与隐私注意事项。
- 增补双语工作原理讲解与三组静态 SVG 示意图，核对窗口预算公式、第六节近期原话预算、单目标路由、双重严格缩小检查与四类故障恢复边界。
- 整理测试记录中的条件总览表、四模型配对费用主表（逐次 token 明细收归 JSON 产物）、GLM 代理单价情景估算说明及 `0.3.1-review.35` 历史测试记录。
- 优化中英文 Issue 模板与脱敏指南：明确日志附件完全可选、保留云端 AI 分享与人工复查隐私提醒，内置跨文件一致的“信息类型＋编号”脱敏提示词。
- 提供安装包、源码包、逐文件清单和 SHA-256 校验值。

## 0.3.2-rc.1

### 修复

- 修正“进度报告：扫描已完成”被误认为报告产物完成的情况。
- 区分缺少完成证据、禁止声称完成与真正的完成声明。
- 区分是否要求生成产物与产物当前是否完成。
- 识别“生成后再更新字段”的未来动作，以及最新来源之后的假设性变化。
- 将字段未知判断限制在对应字段，避免跨批次问题覆盖已知文件数量。
- 正确识别“不允许修改”“不实际修改”等否定要求。
- 保持转折后的当前状态、错误数量和相反要求检查；原始事实身份与来源记录保持兼容。

### 发布整理

- 新增完整中英文 README、五组双语文档、项目徽章及下载入口。
- 配置 Windows / Linux GitHub Actions，执行测试、项目检查与打包验证；文件占用回归分别检查平台的重试与原错误保留行为。
- 整理并在文档中引用 `0.3.1-review.35` 历史实测的平均输入缩减 68.50% 口径、逐次 token 数据和复算公式。
- 增加中英文 Issue 模板，收集报错、回答质量下降和压缩后遗忘反馈。
- 建立源码、测试、脚本与文档的标准目录。
- 重写 README，补充配置、架构、故障排查和开发文档。
- 提供统一离线测试与可选 DSH 宿主集成测试入口。
- 添加发布内容检查、运行包、源码包与 SHA-256 清单。
- 诊断版本从包元数据读取，减少手动版本同步。

## 0.3.1-review.35

- 增量保留已有检查点和稳定前缀，在需要时合并摘要。
- 支持用户要求的修订、取消、去重与近期原话预算。
- 保存工作报告与进度来源，支持完整历史和附件回查。
- 支持大段历史的分页接续、持久化进度及恢复。
- 增加摘要失败重试、等待上限、错误提示和诊断。
- 提供摘要模型、触发比例、最小压缩幅度及重试参数设置页。

官方接口实测记录及后续修复见 [测试记录](docs/testing.md)。
