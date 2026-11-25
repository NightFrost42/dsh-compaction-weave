# 工作原理

[简体中文](architecture.md) · [English](en/architecture.md)

面向使用者的完整讲解、数值例子、静态示意图和保证边界见 [压缩原理详解](principles.md)。本页用于代码导航。

## 从历史到下一步

Weave 在 DSH 的会话维护阶段整理上下文。一次压缩按以下顺序执行：

1. 读取当前消息表，测量输入规模；在开启归档、历史检索工具可用且开启 `observationMaskingEnabled` 时，优先把近期热尾之外超过 4000 字的非报错工具输出存入归档并折叠为首尾预览（`observation-mask.js`），若重新实测空间已降到触发线和目标内则直接结束、免调摘要模型，并附带 `history_read` 回查指针。
2. 仍超水位时选出工具调用配对完整的历史区间；在保留热尾与压缩目标的前提下，当摘要路由与主对话一致且预算允许时启用 `preservePrefixCache` 原样前缀复用，避免破坏服务商 KV Cache。
3. 从原始消息提取有效要求、近期原话、XML 通道隔离元数据（`source-provenance.js` / `instruction-source.js` / `reference-input.js`：`user` 与 `<untrusted_reference>` / `<channel-provenance>`）和最新工作报告，建立来源引用。
4. 调用摘要模型生成候选；大段历史可分块，适用容量问题可进入后台分页接续。
5. 检查完整候选的结构、要求、进度与大小，失败时有限重试；合格后归档选区原文与附件，并在标准检查点末尾写入 `History archive: <compactionId>` 指针与涉及文件列表。
6. 核验事务条件，单趟拷贝兼哈希备份并持久化替换，写入成功决定后发布检查点；后续对话从更新后的上下文继续。

常规多块流程逐块提交，后块失败时前块可能已经完成。分页接续保存已接受页面用于恢复，完整候选通过后才替换主历史。

## 缓存策略

`cache-policy.js` 优先选择最后一个检查点之后的历史区间。已有检查点和保留前缀维持原有内容，只在后面追加新摘要。

选择区间时同时考虑近期对话、摘要输出预算、原话预算、最新工作报告和最小释放空间。以下情况会切换到合并路径：

- 闲置恢复压缩主动关闭增量前缀保留；
- 已达到 `cacheMaxCheckpoints`；
- 新要求修订了旧检查点携带的要求；
- 增量区间无法释放所需空间。

这样把前缀复用与上下文容量放在同一个决策里。服务端实际缓存量从模型返回的 usage 读取，测试记录单独展示压缩后的恢复过程。

## 要求与来源

`memory-policy.js` 处理要求的生效、修订、取消与去重（包含明确变更引导与右置取消从句退场，同时保护条件作用域）。近期原话遵循条数和 token 预算，仍有效的要求独立保留。

`lib/audit/` 采用 6 层无环子模块组织（`normalize.js` → `numeric.js` → `clauses.js` → `polarity.js` / `provenance.js` → `compaction.js`，由 `audit.js` 聚合重导出），统一覆盖规范化、单位等价换算、句内编号与条件子句切分、CLI/布尔开关与正反词形极性校验、来源溯源，以及 `auditCoverageScope` 范围化的覆盖率检查。

原始事件号、文本片段和哈希共同标识来源。历史检查点中的生成文字不会成为新的原始要求；下一代压缩仍从经过核验的原始事件恢复依据。

独立的“继续”等低信息原话可以移出检查点。取消上一条时仍按原始用户消息顺序定位，避免因为裁剪改变指代对象。

## 进度与工作报告

`work-report.js` 保存最新工作报告的来源。短报告可随检查点携带原话，长报告保存来源标识，供后续摘要与回查使用。

`progress-facts.js` 基于显式 `key: value` 结构化进度声明与 SHA-256 来源校验跟踪计数、状态、产物路径和 `nextAction`，避免领域词表对普通自然语言的误判。

## 分页接续与重试

完整摘要请求包含源消息、规则、近期原话索引、`<channel-provenance>` 通道隔离声明和工作报告。`summary-budget.js` 按完整请求规划容量，`continuation.js` 在需要时分页生成工作笔记。

每个已接受页面保存来源身份和进度。重试或恢复时复用匹配的已完成页面，未完成页面继续请求。调用额度、实际发送与未知用量分别记录。

`summary-retry.js` 对超时、断流、空摘要、结构不合格和检查失败进行有限重试。常规和接续请求均使用 `singleTarget: true`，只请求选定的首个摘要目标。用户取消会结束当前操作。`summary-timeout.js` 在发送和读取阶段检查截止时间。

## 归档与提交

归档以消息区间组织，保存原始事件、消息块和工具关系，默认通过 Node.js 24 原生 `zstd` 无损压缩存储。`history-search.js` 提供纯 JS BM25F 多字段检索（CJK 双字 + 英文词干 + 子模去冗余 Top-K + 2-hop 关联 + 按 span 失效的有界 LRU 缓存）；附件按 SHA-256 保存并支持元数据优先/按需逐字节读取（`tools.js` 同时兼容严格工具模式下的 `null`/空白可选参数）。

事务适配器对经审查的 DSH `0.2.2-rc.1`、`0.2.2-rc.2` 与 `0.2.2-rc.3` 宿主方法（含单条与批量 `Session.append` 实现及去除注释/空白后的归一化方法签名）做指纹核验，按“单趟拷贝兼哈希备份、持久化替换、持久化成功决定、发布”的顺序提交；若遇到未知宿主方法体则在摘要请求与历史修改前直接拒绝并保留已有恢复材料。成功决定前失败可恢复已核验的备份；决定后发布异常会隔离写入并要求冷重开会话，保留已持久成功的历史。`state.js` 与 `session-memory.js` 的跨进程/工作线程状态锁绑定 `threadId`、文件 `(dev, ino)` 身份与原子 `.reclaim` 门禁。

## 插件入口

`cordis.patch.yml` 注册配置入口，并让四种 preset 在入口就绪后加载。入口将 preset 中的基础压缩引擎替换为 Weave，合并原有配置与插件设置。

`client.js`（单文件无外部 ESM 导入、无 `setInterval`）基于 `settings-schema.js` 的元数据驱动声明式渲染设置页与实时进度卡片（含 `engineActive` 接管冲突提示及 `ReactDOM.createPortal` 弹窗）；`index.js` 通过 `webserver/index-inject` 注入进程级 `x-weave-rpc-token`（`timingSafeEqual` + 非 `owner` 角色 `403` 拦截 + 同源头校验）；`summary-config.js` 负责读取、校验和保存设置；`command-compact.js` 接入手动命令。

## 代码导航

Run-time 共 `92` 个 `lib/**/*.js` 模块（除独立打包的单文件 `client.js` 外，其余 `91` 个非客户端 ESM 模块由 `scripts/check.mjs` 强制执行 **`0` 环 DAG** 拓扑校验）：

| 目录或模块 | 职责 |
| --- | --- |
| `lib/index.js`、`engine-entry.js`、`hooks.js` | DSH 加载、RPC 安全守卫、`hookBus` 事件桥接与配置入口 |
| `lib/engine.js`、`lib/engine/*.js`（8 模块）、`idle-compaction.js` | 选区、路由预算、可恢复断点、并发折叠、迁移与事务提交 |
| `lib/observation-mask.js`、`tool-preview.js` | 第一级工具输出归档折叠、Tier-4 散文/骨架预览 |
| `lib/cache-policy.js`、`region.js`、`date-grounding.js` | 前缀复用、工具配对、相对日期确定性锚定与归档指针 |
| `lib/source-provenance.js`、`instruction-source.js`、`reference-input.js` | 宿主通道分类、`<untrusted_reference>` / `<channel-provenance>` XML 隔离 |
| `lib/memory-policy.js`、`lib/audit.js`、`lib/audit/*.js`（6 层模块） | 要求生命周期、6 层无环确定性审计与来源校验 |
| `lib/redact.js`、`lib/file-reinject.js` | 统一凭据/线性 PEM 私钥脱敏与压缩后安全文件重注入 |
| `lib/progress-facts.js`、`work-report.js` | 结构化 `key: value` 进度与报告来源 |
| `lib/summary-*.js`、`continuation*.js` | 摘要请求、分页、重试与恢复 |
| `lib/history.js`、`history-search.js`、`attachments.js`、`tools.js` | `zstd` 归档、BM25F 多字段检索与 `history_*` 工具 |
| `lib/persisted-output.js`、`microcompact.js`、`snip.js`、`context-collapse.js` | 分级溢出拦截、闲置 0-LLM 轻压缩、Snip 急救与上下文折叠 |
| `lib/transaction*.js`、`journal.js`、`state.js`、`session-backup.js`、`bili-conflict.js` | 事务提交、并发锁、会话完整备份与 `billion-context` 兼容迁移 |
| `lib/failure-diagnostics.js`、`audit-reject.js`、`audit-fallback.js` | 脱敏失败诊断、拒稿证据落盘与受控耗尽兜底 |
| `lib/settings-schema.js`、`summary-config.js`、`client.js` | 设置元表 SSOT、热配置存储与单文件 WebUI |
| `test/` | 离线回归（103 套）与 DSH 宿主集成测试（8 套） |
