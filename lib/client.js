/**
 * Client half of dsh-compaction-weave: compact Settings page section
 * (`settings.section` / `plugins.detail.section`) and live composer-dock
 * progress + billion-context compatibility card (`conversation.input.dock`).
 *
 * Contract notes:
 * - Only `react` is required at startup (`{ createElement, useState, useEffect }`).
 *   Conflict modals lazily try `react-dom` portals with an inline fallback.
 *   Requiring any Harness Client package would make a throwing component blank
 *   the whole settings panel.
 * - No document.body writes; all listeners/registrations go through ctx.effect
 *   or the slot disposer.
 * - The page is a settings.section contribution, so it appears in the Settings
 *   navigation as its own page (id `compaction-weave-summary`).
 */
window.__ModuleLoader__.load({
  id: 'dsh-compaction-weave',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'weaveSummary';
    const RPC_PATH = '/plugins/dsh-compaction-weave/rpc';
    const PAGE_ID = 'compaction-weave-summary';
    const MAX_IDLE_COMPACTION_MINUTES = 43200; // One month is a fixed 30 days.
    const IDLE_PRESETS = ['0', '5', '10', '30', '60', '720', '1440', '10080', '43200'];
    const SUMMARY_REASONING_EFFORTS = ['auto', 'low', 'none', 'minimal', 'medium', 'high', 'xhigh', 'max', 'inherit'];
    const PRESSURE_BREAKER_ACTIONS = ['confirm', 'degrade', 'block'];
    const AUDIT_EXHAUSTION_POLICIES = ['fallback', 'block'];
    const AUDIT_COVERAGE_SCOPES = ['recent', 'span-new', 'all'];
    const ISSUE_REPORT_URL = 'https://github.com/NightFrost42/dsh-compaction-weave/issues/new';
    const ACTIVE_POLL_MS = 500;
    const IDLE_POLL_MS = 3000;

    // Verified DSH theme CSS tokens (from dsh-config-manager & dsh-client-ui-theme).
    const TOKEN_TEXT_PRIMARY = 'var(--dsw-alias-label-primary, inherit)';
    const TOKEN_TEXT_SECONDARY = 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.85))';
    const TOKEN_TEXT_ERROR = 'var(--dsw-alias-state-error-primary, #c0392b)';
    const TOKEN_TEXT_SUCCESS = 'var(--dsw-alias-state-success-primary, #1e8449)';
    const TOKEN_TEXT_WARNING = 'var(--dsw-alias-state-warning-primary, #b45309)';
    const TOKEN_ACCENT = 'var(--dsw-alias-state-business-primary, var(--dsw-alias-button-info-fill, #2f6fed))';
    const TOKEN_PRIMARY_BG = 'var(--dsw-alias-button-info-fill, var(--dsw-alias-state-business-primary, #2f6fed))';
    const TOKEN_PRIMARY_FG = 'var(--dsw-alias-label-primary-foreground, #ffffff)';
    const TOKEN_SURFACE_1 = 'var(--dsw-alias-bg-layer-1, transparent)';
    const TOKEN_SURFACE_2 = 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))';
    const TOKEN_SECONDARY_BG = 'var(--dsw-alias-bg-layer-2, transparent)';
    const TOKEN_BORDER_1 = 'var(--dsw-alias-border-l1, rgba(127,127,127,0.2))';
    const TOKEN_BORDER_2 = 'var(--dsw-alias-border-l2, rgba(127,127,127,0.35))';

    const dictionaries = {
      zh: {
        nav: '上下文压缩',
        title: '上下文压缩（Weave）',
        intro: '配置 Weave 的摘要模型、触发阈值、闲置压缩与保留检查策略。',
        provider: 'Provider',
        providerPlaceholder: '例如 deepseek',
        model: 'Model',
        modelPlaceholder: '例如 deepseek-v4.1-flash',
        maxTokens: 'maxTokens（输出上限）',
        maxTokensPlaceholder: '默认 8192',
        save: '保存',
        saving: '保存中…',
        clear: '清除（跟随会话模型）',
        loading: '读取当前配置…',
        saved: '已保存，无需重启 DSH。新设置从后续压缩或请求边界生效。',
        cleared: '已清除摘要模型覆盖，无需重启 DSH。从后续压缩或请求边界跟随会话模型。',
        applyHint: '保存或清除本页设置无需重启 DSH，从后续压缩或请求边界生效。进行中的压缩仍使用开始时的配置。首次安装或升级插件本体仍需按 DSH 提示重载宿主。',
        pair: 'Provider 和 Model 必须同时填写，或同时留空。',
        badMax: 'maxTokens 必须是 1 到 1000000 之间的整数。',
        error: '保存失败：',
        follow: '两项都空时清除覆盖，跟随当前会话模型。',
        followSession: '跟随当前会话模型',
        notInCatalog: '不在当前模型列表中',
        noModels: '该 Provider 没有可选模型',
        defaultMax: '默认（8192）',
        catalogError: '模型列表读取失败',
        reloadModels: '重新读取模型列表',
        trigger: '自动压缩触发线',
        minimumReduction: '最小压缩幅度',
        reductionHint: '自动压缩至少缩减压缩前上下文的 {pct}%。',
        reductionRange: '最小压缩幅度必须在 5% 到 90% 之间。',
        triggerHint: '达窗口 {pct}% 时触发（受输出预留上限约束）。',
        triggerRange: '触发线必须在 50% 到 95% 之间。',
        idleCompaction: '闲置后先压缩',
        idleCompactionHint: '非后台定时压缩——离开超过设定时长后，在您回来发送下一条消息前才先执行 0-LLM 轻压缩（折叠较早大体积工具输出与同路径重复读取），若仍需缩减再运行可选完整闲置摘要以减少缓存重建开销（因此回来第一句会略有等待）；如需趁对话间隙提前在后台预生成摘要以加速后续压缩，请开启下方“回合间隙后台预生成摘要”。',
        idleOff: '关闭',
        idle5: '5 分钟（Claude 默认 / 旧 GPT 参考）',
        idle10: '10 分钟',
        idle30: '30 分钟（GPT / Gemini 参考）',
        idle60: '60 分钟（Claude 延长缓存参考）',
        idle720: '720 分钟（GPT 12 小时参考）',
        idle1440: '1440 分钟（旧 GPT 最长 24 小时参考，非保证）',
        idle10080: '7 天（10080 分钟）',
        idle43200: '30 天（1 个月，43200 分钟）',
        idleCustom: '自定义',
        idleCustomMinutes: '自定义闲置时间（分钟）',
        idleDurationHint: '自定义可填 1–43200 整数分钟；1 个月固定为 30 天（43200 分钟）。7 天／30 天是闲置策略，不代表服务商缓存有效期；停用请选择“关闭”。',
        idleReferences: '闲置规则与各家缓存时间参考',
        idleClaudeHint: 'Claude 默认缓存至少保留 5 分钟，可选 1 小时；从使用缓存的请求开始计时，生成回复也占用这段时间。',
        idleHint: '默认关闭，与按上下文压力触发的自动压缩开关独立。按本会话最近一次用户、助手或工具的实际活动，到新用户消息入队时的间隔估计闲置时间；时间未知时不触发。',
        idleTriggerHint: '超过所选时间后，仅在新用户回合的第一步、发送前先执行 0-LLM 轻压缩（保留最新 4 条热点工具输出，折叠更早大体积工具输出与同路径重复读取），若仍需缩减再对仍可压缩的历史运行可选完整闲置摘要；活跃工具循环中不触发。压缩失败则保留新输入并停止该次请求。',
        idleGptHint: 'GPT-5.6 及以后模型在 Responses API 中默认最低缓存寿命为 30 分钟，可选 12 小时；这涉及缓存读取计费资格，不保证每次命中或降低延迟。旧模型 in_memory 通常闲置 5–10 分钟、最长 1 小时；24h 通常约 30 分钟、最长 24 小时，支持范围和默认值因模型与组织策略而异，最长值并非保证。',
        idleCacheHint: '这些时间是手动触发参考，并非服务商缓存的实际过期时间。12 / 24 小时选项仅适用于上游已启用相应缓存策略，此设置不会启用或修改上游缓存。Gemini 的 30 分钟是本插件的触发参考，并非官方隐式缓存有效期。DeepSeek / GLM 目前无可靠固定有效期，可自定义时间。',
        idleRange: '自定义闲置时间必须为 1–43200 之间的整数分钟；停用请选择“关闭”。',
        compressing: '正在压缩…',
        retryCount: '失败重试次数',
        retryDelay: '重试基础间隔（秒）',
        summaryTimeout: '每次摘要等待上限（秒）',
        retryHint: '失败最多再试 {count} 次（共 {total} 次）。',
        retryDelayHint: '逐次翻倍，上限 30 秒。',
        timeoutHint: '单次请求超时上限；超时后可重试。',
        retryCountRange: '失败重试次数须为 0–4 之间的整数。',
        retryDelayRange: '重试基础间隔须为 0–30 秒之间（精确到毫秒）。',
        summaryTimeoutRange: '每次摘要等待上限须为 5–3600 秒之间。',
        summaryConcurrency: '摘要并发数',
        summaryConcurrencyHint: '默认 2（1–6）；提高可加速多块压缩，过高易触发服务商 429 限流。',
        concurrencyRange: '摘要并发数须为 1–6 之间的整数。',
        summaryReasoningEffort: '摘要推理强度',
        summaryReasoningAuto: 'auto（默认：Anthropic 同路由继承保缓存，其余收敛为 low；主会话关闭思考时不强开）',
        summaryReasoningLow: 'low（低推理，更快）',
        summaryReasoningNone: 'none（关闭：省略推理强度参数）',
        summaryReasoningMinimal: 'minimal（极简推理）',
        summaryReasoningMedium: 'medium（中等推理）',
        summaryReasoningHigh: 'high（高推理）',
        summaryReasoningXhigh: 'xhigh（超高推理）',
        summaryReasoningMax: 'max（最高推理）',
        summaryReasoningInherit: 'inherit（所有路由均沿用主会话推理强度）',
        summaryReasoningHint: '默认 auto：Anthropic/Claude 同路由自动继承以避免切换 effort 破坏前部 KV 缓存，其余路由（如 DeepSeek/GLM）自动收敛到 low；主会话未开思考时均不强开。手动选择其它档位即强制按指定档位执行（不支持时自动向下回退）。',
        reasoningEffortRange: '摘要推理强度必须为 auto、low、none、minimal、medium、high、xhigh、max 或 inherit。',
        summaryCjkTokensPerChar: 'CJK 预算保守权重（summaryCjkTokensPerChar）',
        summaryCjkWeight075: '0.75 tok/字（默认：适配 DeepSeek/Qwen 等现代分词器）',
        summaryCjkWeight085: '0.85 tok/字（偏稳健）',
        summaryCjkWeight10: '1.0 tok/字（兼容较碎分词器，最大余量）',
        summaryCjkWeight125: '1.25 tok/字（极保守预算）',
        summaryCjkWeightCustom: '{weight} tok/字（自定义保存值）',
        summaryCjkTokensPerCharHint: '宿主表层按 chars/4 粗估；摘要分块预算使用可调 CJK 权重（summaryCjkTokensPerChar，默认 0.75 tok/字，仍属启发式估算而非真实 BPE）以保护 128k 中文会话前部 KV 缓存，常驻 4 个历史/压缩工具 Schema 约占 2.4 KB（~660–750 BPE tok）固定前缀；如用较碎旧分词器出现摘要分块溢出，可调回 1.0。',
        summaryCjkTokensPerCharRange: 'CJK 预算保守权重须为 0.5–1.5 之间的数值。',
        auditBlockOnLoss: '要求保留审计拦截（auditBlockOnLoss）',
        auditBlockOnLossOn: '开启（默认：漏掉有效要求时拦截重试）',
        auditBlockOnLossOff: '关闭（仅警告；仍拦截极性反转与授权伪造）',
        auditBlockOnLossHint: '已自动过滤宿主注入块；频繁误拦截时可关闭，仍保留 Section 6 原话与极性检查。',
        auditCoverageScope: '约束覆盖审计范围（auditCoverageScope）',
        auditCoverageScopeRecent: 'recent（默认：按近期保留窗口审计普通遗漏）',
        auditCoverageScopeSpanNew: 'span-new（仅审计本次新折叠原话的普通遗漏）',
        auditCoverageScopeAll: 'all（全历史严格：全部历史普通约束均须覆盖）',
        auditCoverageScopeHint: '控制普通约束遗漏检查的回溯窗口；极性反转（polarity）、数值篡改（value/unit）、条件/范围/关系/例外与授权来源（condition/provenance）红线始终全历史强制拦截。',
        auditCoverageScopeRange: '约束覆盖审计范围必须为 recent、span-new 或 all。',
        engineInactiveTitle: '内置压缩引擎仍在运行 — 请完全重启 DSH',
        engineInactiveBody: 'Weave 插件界面已加载，但当前会话仍由 DSH 默认压缩引擎接管。请完全退出并重启 DSH，以使 Weave 压缩引擎生效。',
        auditExhaustionPolicy: '启发式审计耗尽兜底策略（auditExhaustionPolicy）',
        auditExhaustionFallback: 'fallback（默认：全链与重试耗尽后，外挂经核验纯用户原话兜底放行）',
        auditExhaustionBlock: 'block（严格拦截：重试耗尽后直接失败，禁用受控兜底）',
        auditExhaustionPolicyHint: '仅当整个目标链（且至少经过 1 次纠偏重试）仍因启发式约束校验失败（<= 3 处且可逐字定位纯用户原话）时生效；结构缺失、未缩小、进度事实冲突、已撤回记忆或非可信/伪造授权仍永久严格拦截。',
        auditExhaustionPolicyRange: '启发式审计耗尽兜底策略必须为 fallback 或 block。',
        pressureBreakerAction: '自动压缩熔断后策略',
        pressureBreakerConfirm: 'confirm（默认：阻断并弹出放行确认 / 重试入口）',
        pressureBreakerDegrade: 'degrade（直接警告放行：预算红线内允许继续对话）',
        pressureBreakerBlock: 'block（严格阻断：仅允许重试压缩或还原，禁用跳过）',
        pressureBreakerActionHint: '当自动压缩连续失败达到阈值时，决定是否允许在预算安全线内先继续对话（仍永久保留持久化失败、续传待办和硬预算红线拦截）。',
        pressureBreakerActionRange: '自动压缩熔断后策略必须为 confirm、degrade 或 block。',
        breakerBlockedTitle: '自动压缩已熔断（已暂停发送）',
        breakerBypassedTitle: '自动压缩已熔断（当前按策略暂跳过，允许继续对话）',
        breakerBillingWarning: '注意：跳过压缩期间将以未压缩的大上下文继续请求模型，按上下文长度计费，费用可能明显上升；硬窗口红线仍会拦截超限请求。',
        breakerFailureCode: '错误码：{code}',
        breakerDiagnosticId: '诊断 ID：{id}',
        breakerRetry: '手动重试压缩',
        breakerRetryBypassed: '重新压缩',
        breakerRetrying: '正在重试…',
        breakerRetryFailed: '重试压缩失败：{error}',
        breakerBypass: '继续对话（暂跳过自动压缩）',
        breakerBypassConfirmHint: '确认后，本会话将在硬预算安全线内暂跳过自动压缩并允许发送消息；不会删除原历史，可随时恢复拦截或点击重试。',
        breakerBypassConfirm: '确认放行',
        breakerRestoreBlock: '恢复拦截',
        breakerBypassFailed: '更新熔断放行失败：{error}',
        breakerCopyDiagnostic: '复制诊断',
        breakerCopiedDiagnostic: '已复制诊断',
        breakerReportIssue: '反馈问题',
        postCompactReinject: '压缩后工作区文件重注入',
        postCompactReinjectOn: '开启（默认：0 次额外摘要模型调用，重读最近 5 个工作区文件）',
        postCompactReinjectOff: '关闭（不从本地磁盘重注入近期文件）',
        postCompactReinjectHint: '0 次额外摘要模型调用；仅在本地工作区存在时，压缩后从磁盘新鲜读取最近最多 5 个活跃文件（默认上限 24KB，作为后续主回合上下文输入；在 64k 等小安全窗口下会自动按预算缩减上限，除非显式配置自定义上限），自动跳过 AGENTS.md、敏感文件与远程会话。',
        observationMasking: '第一级 0-LLM 工具输出掩码（Observation Masking）',
        observationMaskingOn: '开启（默认：0 摘要模型调用，优先归档旧大工具输出并留 history_read 指针）',
        observationMaskingOff: '关闭（跳过第一级掩码，达线时直接生成完整检查点摘要）',
        observationMaskingHint: '默认开启，0 次摘要模型调用；超阈值后先将热尾之外 ≥ 4000 字的非报错工具输出归档并替换为首尾预览，若已达标则免调摘要模型（需原文时可由 history_read 取回）；关闭后即使仅含大工具输出也直接走完整摘要模型（仅需兼容极少触发完整重排的模型或压测对比时建议关闭）。',
        persistedOutput: '超大工具结果尾部溢出（Persisted-Output）',
        persistedOutputOn: '开启（默认：0 LLM，仅归档未发送尾部 ≥ 32768 字工具输出）',
        persistedOutputOff: '关闭（保留未发送尾部超大工具输出原文）',
        persistedOutputHint: '0 LLM Token 消耗，0 前缀缓存失效；仅对刚落盘且尚未发给模型的尾部成功工具输出（跳过 isError: true）进行归档并替换为首尾 1200 字预览，绝不改写历史。',
        microcompact: '闲置 0-LLM 轻压缩（Microcompact）',
        microcompactOn: '开启（默认：保留最新 4 条热点输出，折叠更早大输出与重复读取）',
        microcompactOff: '关闭（闲置超时后不执行 0-LLM 轻压缩）',
        microcompactHint: '共用「闲置后先压缩」时间阈值（默认 0 关闭；需在上方设置大于 0 的闲置分钟数才会生效），0 LLM 调用；超时后先保留最新 4 条热点工具输出，并折叠更早大体积工具输出与同路径重复读取，仍需缩减时再按需运行可选完整闲置摘要。',
        snip: '最后兜底 0-LLM 急救裁剪（Snip）',
        snipOn: '开启（默认：0 LLM，逼近硬预算或 413 兜底急救裁剪旧工具循环）',
        snipOff: '关闭（不执行 0-LLM 最后兜底急救裁剪）',
        snipHint: '默认开启，0 LLM 调用；仅在常规压缩与续传仍无法满足、逼近 messageBudgetTokens 硬上限或触发 413 溢出时作为最后兜底触发，将较早工具调用循环归档并留下 history_read 指针，绝不丢弃近期用户消息。',
        sessionMemoryEnabled: '后台摘要预热（可选）',
        sessionMemoryEnabledToggle: '回合间隙后台预生成摘要',
        sessionMemoryHint: '默认关闭（手动开启）；开启后会趁对话回合间隙在后台提前预生成摘要，供下次压缩直接复用（接近无感秒切）。额外消耗 API 余额与 Token 额度，受最小内容量、60 秒冷却、12 KB 体积与下方单轮压缩前后台预热上限保护。',
        sessionMemoryMaxCalls: '单轮压缩前后台预热上限（1–100）',
        sessionMemoryMaxCallsHint: '仅在开启上方「回合间隙后台预生成摘要」时生效（默认 8 次）。限制两次正式压缩之间后台最多自动预生成多少次摘要以防烧余额；每次成功压缩后自动清零重算，不影响正常对话与 /compact（回滚、还原备份或失败重试不会重置）。',
        sessionMemoryMaxCallsRange: '单轮压缩前后台预热上限须为 1–100 之间的整数。',
        contextCollapseEnabled: '过期窗口上下文折叠（Context Collapse）',
        contextCollapseEnabledToggle: '开启过期闲置窗口渐进折叠（默认关闭）',
        contextCollapseHint: '默认关闭（手动开启）；仅在超过 idleCompactionMinutes 闲置恢复窗口、且 0-LLM 轻压缩（Microcompact）之后触发（绝不在热提示词缓存期间运行，未设闲置时间时不触发），触发时可能调用摘要 LLM 并消耗 API 余额。',
        overallProgress: '总进度 {percent}%',
        overallTokensProgress: '已处理 {processed} / {total} tok',
        phase_idle: '空闲',
        phase_detecting: '正在检查会话状态…',
        phase_backing_up: '正在创建并校验会话备份…',
        phase_masking: '正在掩码冗长工具输出…',
        phase_planning: '正在规划压缩范围…',
        phase_summarizing: '正在生成摘要…',
        phase_folding: '正在合并历史检查点…',
        phase_continuing: '正在分页接续压缩…',
        phase_auditing: '正在核对约束与进度…',
        phase_committing: '正在原子提交检查点…',
        phase_migrating: '正在转换 billion-context 格式…',
        phase_restoring: '正在还原会话备份…',
        phase_done: '压缩完成',
        phase_error: '压缩未完成',
        waveTotalProgress: '波次 {index}/{total}',
        waveProgress: '波次 {index}',
        chunkTotalProgress: '第 {index}/{total} 块',
        chunkProgress: '第 {index} 块',
        pageTotalProgress: '第 {index}/{total} 页',
        pageProgress: '第 {index} 页',
        attemptProgress: '第 {attempt}/{max} 次尝试',
        retryReason_CONSTRAINT_LOST: '上次因约束校验未通过重试',
        retryReason_CONSTRAINT_POLARITY_LOST: '上次因约束极性冲突重试',
        retryReason_SUMMARY_NOT_SMALLER: '上次因摘要体积未缩小重试',
        retryReason_SUMMARY_STRUCTURE_INVALID: '上次因摘要结构不完整重试',
        retryReason_CONTINUATION_STRUCTURE: '上次因摘要结构不完整重试',
        retryReason_PROGRESS_FACT_CONFLICT: '上次因进度事实冲突重试',
        retryReason_RETIRED_MEMORY_REINTRODUCED: '上次因引入已取消要求重试',
        retryReason_EMPTY_SUMMARY: '上次因返回空摘要重试',
        retryReason_MAX_TOKENS: '上次因输出触达上限重试',
        retryReason_SUMMARY_TIMEOUT: '上次因响应超时重试',
        retryReason_RATE_LIMITED: '上次因触发限流重试',
        retryReason_CONTEXT_WINDOW_EXCEEDED: '上次因超输入上限重试',
        retryReason_SUMMARY_FOREIGN_BILI_FORMAT: '上次因输出旧 bili 格式（疑代理残留）重试',
        retryReason_BILI_PROXY_CONFLICT: '上次因疑为 bili 本地代理残留（413/preflight）中止重试',
        retryReason_BILI_COEXISTENCE_CONFLICT: '上次因检测到 billion-context 并存拦截',
        retryReasonGeneric: '上次因 {code} 重试',
        biliConflictTitleActive: '检测到 billion-context 插件仍在并存运行',
        biliConflictTitleProxy: '检测到疑似 billion-context 本地代理残留',
        biliConflictTitleBoth: '检测到 billion-context 并存且存在本地代理残留',
        biliConflictBody: '两个压缩插件或本地代理同时拦截请求会导致 413 拒回或生成非 Weave 格式摘要。请按以下步骤处理后重试：',
        biliConflictStep1: '1. 打开「插件管理」，停用或卸载 billion-context（含 billion-context-dsh）。',
        biliConflictStep2: '2. 检查模型供应商设置，若 baseUrl 仍指向 bili 的 127.0.0.1 / localhost 本地代理，请还原为直连上游地址。',
        biliConflictStep3: '3. 务必彻底重启一次 DSH 主程序（即使刚才已在界面里关闭过 billion-context，也需彻底重启以清理残留内存钩子与代理端口）。',
        biliConflictStep4: '4. 如需保留旧会话历史，重启后可在会话中执行 /compact migrate 或通过备份安全恢复。',
        biliConflictSignal: '探测信号：{signals}',
        biliConflictBannerText: '检测到 billion-context 并存或代理残留，请停用插件、还原 baseUrl 并彻底重启 DSH。',
        biliConflictReopen: '查看处理指引',
        biliConflictDismiss: '已知晓，暂关闭弹窗',
        tokenDelta: '{before} → {current} tok',
        tokenSingle: '{before} tok',
        tokenTarget: '目标 {target}',
        auditFallbackNotice: '受控兜底 {count} 处',
        maskedCount: '已掩码 {count} 条',
        maskedSaved: '已掩码 {count} 条（-{saved} tok）',
        auxCacheHit: '摘要缓存命中 {pct}%',
        auxReasoning: '摘要思考 {tokens}',
        reinjectedFiles: '重注入 {files} 文件 ({bytes})',
        streamReceiving: '已接收 {chars} 字',
        streamChunks: '流式接收中（{chunks}）',
        streamWaiting: '等待模型响应…',
        biliDetectedTitle: '检测到 billion-context 格式',
        biliVariantAuthored: 'authored 检查点',
        biliVariantRaw: '代理原始记录',
        biliVariantDsh: 'billion-context-dsh',
        biliVariantMixed: '混合格式',
        biliFoldBlocks: '{count} 个折叠块',
        biliToolCalls: '{count} 条工具记录',
        biliBrokenPairing: '工具配对异常',
        biliConvert: '兼容转换为 Weave',
        biliConverting: '正在备份并转换…',
        biliWaitOpenTurn: '请等待当前回合结束后再转换',
        biliWaitBusy: '请等待当前压缩结束后再转换',
        biliConvertConfirmHint: '不可逆转换：将转为 Weave 检查点，转换前自动创建并校验 SHA-256 完整备份，随时可还原。',
        biliConvertConfirm: '备份并转换',
        biliConvertDone: '已转换为 Weave 格式并保留完整备份。',
        biliConvertStarted: '完整备份已校验，正在执行转换…',
        biliConvertFailed: '兼容转换失败：{error}',
        backupSaved: '备份：{id}',
        backupPathLabel: '备份路径：',
        backupOriginalLabel: '原始备份',
        backupSnapshotLabel: '快照',
        backupSelectLabel: '选择还原备份',
        backupNodeCount: '{count}条',
        backupRestore: '还原备份',
        backupRestoring: '正在准备还原…',
        backupRestoreConfirmHint: '将从备份 {id} 还原会话历史；若会话已打开，会先锁定写入并在重新打开后自动完成。',
        backupRestoreConfirm: '确认还原备份',
        backupRestored: '备份 {id} 已还原。',
        backupRestoreArmed: '备份还原已就绪（{id}）。请完全重启 DSH 以加载还原后的历史。',
        backupRestoreFailed: '备份还原失败：{error}',
        copyPath: '复制',
        copiedPath: '已复制',
        pause: '暂停',
        pausing: '正在暂停…',
        cancelFailed: '暂停失败：{error}',
        concurrencyChip: '并发 {count}',
        rateLimitedChip: '限流降速',
        resumeMigrationTitle: '上次兼容转换未完成',
        resumeCompactionTitle: '上次压缩未完成',
        resumeProgressDetail: '已完成 {percent}% · 剩 {remaining} 条',
        resumePausedBudget: '已达单次预算上限',
        resumePausedFailure: '因连续失败已暂停',
        resumeAutoHint: '发消息自动继续',
        resumeMigrationAction: '继续转换',
        resumeCompactionAction: '继续压缩',
        resumingAction: '正在继续…',
        resumeFailed: '继续执行失败：{error}',
        discardResume: '放弃',
        discardingResume: '正在放弃…',
        discardResumeConfirmHint: '放弃将清除已保存的断点续传进度（已创建的完整会话备份仍会保留）。',
        discardResumeConfirm: '确认放弃',
        discardResumeFailed: '放弃断点失败：{error}',
        doneSummary: '压缩完成',
        errorFallback: '压缩未完成，请查看诊断信息或重试。',
        cancel: '取消',
        dismiss: '关闭',
        archiveWarnDockTitle: '本地归档占用提醒',
        archiveWarnDockDetail: 'Weave 本地归档（sessions/）已占用 {total}，超过提醒阈值 {warn}。',
        archiveWarnDockNoAutoDelete: '不会自动删除任何归档；可在「设置 → 上下文压缩 → 本地归档存储」手动无损压缩旧段或清理已确认删除会话的孤儿归档。',
        archiveStorageTitle: '本地归档存储',
        archiveStorageStats: '占用 {total} · 备份 {backup} · 会话 {sessions} 个 · 未压缩旧段 {legacy} 个',
        archiveStorageWarnBanner: '已超过提醒阈值（{warn}）：不会自动删除任何归档，请手动压缩旧段或清理确认已删除会话的孤儿归档。',
        archiveWarnMb: '归档占用提醒阈值（MiB，0=关闭）',
        archiveWarnMbHint: '默认 512 MiB（0=关闭提醒）。仅在底部与设置页软提醒，绝不自动删除或阻断发送。',
        archiveWarnMbRange: '归档占用提醒阈值须为 0–102400 之间的整数 MiB。',
        maxVisibleAttachmentMb: '可见图片字节高水位阈值（MiB，0=关闭）',
        maxVisibleAttachmentMbHint: '默认 16 MiB（0=关闭字节触发）。超出高水位时单批卸载较早图片并保留最新 6 张热点图片（0 LLM，绝不改写用户消息）。',
        maxVisibleAttachmentMbRange: '可见图片字节高水位阈值须为 0–1024 之间的整数 MiB。',
        maxVisibleImages: '可见图片张数高水位阈值（张，0=关闭）',
        maxVisibleImagesHint: '默认 24 张（0=关闭张数触发；含 >2000px 长图 >= 20 张防爆护栏）。触线时单批卸载至低水位保持 KV 缓存稳定。',
        maxVisibleImagesRange: '可见图片张数高水位阈值须为 0–500 之间的整数。',
        archiveCompressLegacy: '无损压缩旧归档',
        archiveCompressing: '压缩中…',
        archiveCompressDone: '已无损压缩 {count} 个旧归档段，释放 {saved}（失败 {failed} 个）。',
        archiveCompressFailed: '无损压缩旧归档失败：{error}',
        archiveCleanupOrphans: '清理孤儿归档',
        archiveCleanupConfirmHint: '仅整目录删除宿主已确认不存在的 {count} 个孤儿会话归档（释放 {bytes}），活跃与存疑会话永久保留。',
        archiveCleanupConfirm: '确认删除孤儿归档',
        archiveCleanupDone: '已清理 {count} 个孤儿会话归档，释放 {bytes}。',
        archiveCleanupUnavailable: '当前宿主环境不支持孤儿核验，已禁用清理以防误删。',
        archiveCleanupFailed: '清理孤儿归档失败：{error}',
      },
      en: {
        nav: 'Compaction',
        title: 'Context Compaction (Weave)',
        intro: 'Configure summary model, compaction thresholds, idle compaction, and retention checks.',
        provider: 'Provider',
        providerPlaceholder: 'e.g. deepseek',
        model: 'Model',
        modelPlaceholder: 'e.g. deepseek-v4.1-flash',
        maxTokens: 'maxTokens (output cap)',
        maxTokensPlaceholder: 'default 8192',
        save: 'Save',
        saving: 'Saving…',
        clear: 'Clear (follow session model)',
        loading: 'Reading current configuration…',
        saved: 'Saved. No DSH restart needed. Changes apply at subsequent compaction or request boundaries.',
        cleared: 'Summary model override cleared. No DSH restart needed. Follow the session model at subsequent compaction or request boundaries.',
        applyHint: 'Saving or clearing any setting on this page needs no DSH restart. Changes apply at subsequent compaction or request boundaries. A compaction already in progress keeps the configuration it started with. First installation or plugin upgrades still require a host reload as prompted by DSH.',
        pair: 'Provider and Model must be filled together, or both left empty.',
        badMax: 'maxTokens must be an integer between 1 and 1000000.',
        error: 'Save failed: ',
        follow: 'Leave both empty to clear the override and follow the current session model.',
        followSession: 'Follow the current session model',
        notInCatalog: 'not in the current catalog',
        noModels: 'No models for this provider',
        defaultMax: 'Default (8192)',
        catalogError: 'Could not read the model catalog',
        reloadModels: 'Reload models',
        trigger: 'Auto-compaction trigger',
        minimumReduction: 'Minimum compaction reduction',
        reductionHint: 'Auto-compaction must reduce context by at least {pct}%.',
        reductionRange: 'Minimum reduction must be between 5% and 90%.',
        triggerHint: 'Triggers at {pct}% of window (capped by output reserve).',
        triggerRange: 'The trigger line must be between 50% and 95%.',
        idleCompaction: 'Compact before resuming',
        idleCompactionHint: 'Not scheduled in the background — after being away past the threshold, runs 0-LLM microcompaction (folding old oversized tool outputs & repeated reads) and an optional full idle summary only when you return and send the next message to reduce cache rebuild cost (so the first reply back may wait briefly). To pre-warm summaries in the background between turns, enable "Pre-generate summaries in background between turns" below.',
        idleOff: 'Off',
        idle5: '5 minutes (Claude default / older GPT reference)',
        idle10: '10 minutes',
        idle30: '30 minutes (GPT / Gemini reference)',
        idle60: '60 minutes (Claude extended cache reference)',
        idle720: '720 minutes (GPT 12-hour reference)',
        idle1440: '1440 minutes (older GPT, up to 24 hours; not guaranteed)',
        idle10080: '7 days (10080 minutes)',
        idle43200: '30 days (1 month, 43200 minutes)',
        idleCustom: 'Custom',
        idleCustomMinutes: 'Custom idle time (minutes)',
        idleDurationHint: 'Custom accepts 1–43200 whole minutes; 1 month is fixed at 30 days (43200 minutes). The 7-day and 30-day presets are idle policies, not provider cache lifetimes. Select Off to disable.',
        idleReferences: 'Idle rules & provider cache references',
        idleClaudeHint: 'Claude caches last at least 5 minutes by default, with a 1-hour option. Time starts when the request using the cache begins, including response generation.',
        idleHint: 'Off by default and independent of the automatic compaction switch for context pressure. Estimate idle time from this session’s latest actual user, assistant or tool activity to when the new user message is queued. Unknown timestamps do not trigger compaction.',
        idleTriggerHint: 'After the selected interval, only at the first step of a new user turn, first run 0-LLM microcompaction (folding old oversized tool outputs & repeated reads while keeping the newest 4 hot tool outputs) before optional full idle summary on any history that can still be compacted before sending if still needed. Active tool loops do not trigger it. If compaction fails, keep the new input and stop that request.',
        idleGptHint: 'For GPT-5.6 and later in the Responses API, the default minimum cache lifetime is 30 minutes, with 12 hours available. This governs cache-read pricing eligibility, without guaranteeing a cache hit or lower latency. For older models, in_memory typically lasts 5–10 idle minutes, up to 1 hour; 24h typically lasts around 30 minutes, up to 24 hours. Support and defaults vary by model and organization policy; maximum retention is not guaranteed.',
        idleCacheHint: 'These times are manual trigger references, not the provider’s actual cache expiry. The 12 / 24-hour options apply only when the upstream enables the corresponding cache policy; this setting does not enable or modify upstream caching. Gemini’s 30 minutes is this plugin’s trigger reference, not an official cache TTL. DeepSeek / GLM currently have no reliable fixed TTL; choose a custom time.',
        idleRange: 'Custom idle time must be an integer from 1 to 43200 minutes. Select Off to disable.',
        compressing: 'Compacting…',
        retryCount: 'Retries after failure',
        retryDelay: 'Base retry delay (seconds)',
        summaryTimeout: 'Timeout per summary request (seconds)',
        retryHint: 'Up to {count} retries ({total} attempts total).',
        retryDelayHint: 'Doubles per retry, capped at 30s.',
        timeoutHint: 'Per-request timeout; timed-out calls may retry.',
        retryCountRange: 'Retries after failure must be an integer from 0 to 4.',
        retryDelayRange: 'Base retry delay must be between 0 and 30 seconds (millisecond precision).',
        summaryTimeoutRange: 'Timeout per summary request must be between 5 and 3600 seconds.',
        summaryConcurrency: 'Summary concurrency',
        summaryConcurrencyHint: 'Default 2 (1–6); higher speeds up multi-chunk compaction, too high risks 429 rate limits.',
        concurrencyRange: 'Summary concurrency must be an integer from 1 to 6.',
        summaryReasoningEffort: 'Summary reasoning effort',
        summaryReasoningAuto: 'auto (default: inherit on same-route Anthropic for cache, low elsewhere; off stays off)',
        summaryReasoningLow: 'low (reduced reasoning, faster)',
        summaryReasoningNone: 'none (omit reasoning effort)',
        summaryReasoningMinimal: 'minimal (minimal reasoning)',
        summaryReasoningMedium: 'medium (medium reasoning)',
        summaryReasoningHigh: 'high (high reasoning)',
        summaryReasoningXhigh: 'xhigh (extra-high reasoning)',
        summaryReasoningMax: 'max (maximum reasoning)',
        summaryReasoningInherit: 'inherit (always follow session reasoning effort)',
        summaryReasoningHint: 'Default auto: inherits session effort on same-route Anthropic/Claude to preserve prompt KV caches and caps other routes (e.g. DeepSeek/GLM) to low, while keeping reasoning off when the main session disables it. Explicit selections override per your choice (stepping down automatically if unsupported).',
        reasoningEffortRange: 'Summary reasoning effort must be auto, low, none, minimal, medium, high, xhigh, max, or inherit.',
        summaryCjkTokensPerChar: 'Conservative CJK budget weight (summaryCjkTokensPerChar)',
        summaryCjkWeight075: '0.75 tok/char (default: fits modern DeepSeek/Qwen tokenizers)',
        summaryCjkWeight085: '0.85 tok/char (moderately conservative)',
        summaryCjkWeight10: '1.0 tok/char (compatibility for finer tokenizers)',
        summaryCjkWeight125: '1.25 tok/char (extra-conservative budget)',
        summaryCjkWeightCustom: '{weight} tok/char (custom saved)',
        summaryCjkTokensPerCharHint: 'Host surface estimates with chars/4, while summary chunk budgeting uses configurable CJK weighting (summaryCjkTokensPerChar, default 0.75 tok/char — a conservative heuristic rather than exact model BPE) to preserve prefix KV caching on 128k Chinese sessions; the 4 permanent archive/compact tool schemas occupy ~2.4 KB (~660–750 BPE tok) fixed prefix overhead. Raise to 1.0 if an older tokenizer splits CJK finer.',
        summaryCjkTokensPerCharRange: 'Conservative CJK budget weight must be a finite number between 0.5 and 1.5.',
        auditBlockOnLoss: 'Block compaction on requirement loss (auditBlockOnLoss)',
        auditBlockOnLossOn: 'On (default: block & retry on dropped requirements)',
        auditBlockOnLossOff: 'Off (warn only; polarity & provenance still blocked)',
        auditBlockOnLossHint: 'Host-injected blocks are filtered automatically; turning off keeps Section 6 quotes and polarity checks.',
        auditCoverageScope: 'Constraint coverage audit scope (auditCoverageScope)',
        auditCoverageScopeRecent: 'recent (default: audit ordinary omissions within recent retention window)',
        auditCoverageScopeSpanNew: 'span-new (audit ordinary omissions for newly compacted span messages only)',
        auditCoverageScopeAll: 'all (strict full history: require coverage across all prior constraints)',
        auditCoverageScopeHint: 'Controls the window for ordinary requirement omission checks; polarity flips, value/unit tampering, condition/range/relation/exception, and provenance redlines always remain globally enforced across full history.',
        auditCoverageScopeRange: 'Constraint coverage audit scope must be recent, span-new, or all.',
        engineInactiveTitle: 'Built-in compaction engine is still active — please fully restart DSH',
        engineInactiveBody: 'The Weave plugin UI is loaded, but DSH’s default compaction engine is still handling sessions. Please fully quit and restart DSH so the Weave engine takes over.',
        auditExhaustionPolicy: 'Heuristic audit exhaustion fallback (auditExhaustionPolicy)',
        auditExhaustionFallback: 'fallback (default: pin verified pure-user rules outside prose after chain/retry exhaustion)',
        auditExhaustionBlock: 'block (strictly block on exhaustion; disable controlled fallback)',
        auditExhaustionPolicyHint: 'Activates only after exhausting all fallback-chain targets and at least 1 corrective retry with <= 3 heuristic losses backed by verbatim pure-user rules; structural, shrinkage, progress-fact, retired-memory, and untrusted/revoked provenance checks stay strictly blocked.',
        auditExhaustionPolicyRange: 'Heuristic audit exhaustion policy must be fallback or block.',
        pressureBreakerAction: 'Pressure circuit breaker policy',
        pressureBreakerConfirm: 'confirm (default: block and offer bypass confirmation / retry)',
        pressureBreakerDegrade: 'degrade (warn and bypass within request budget)',
        pressureBreakerBlock: 'block (strictly blocked; allow retry or restore only)',
        pressureBreakerActionHint: 'Controls whether a session can continue chatting inside the request budget after repeated automatic pressure failures (persistence failures, pending continuations, and the hard request budget always stay enforced).',
        pressureBreakerActionRange: 'Pressure circuit breaker policy must be confirm, degrade, or block.',
        breakerBlockedTitle: 'Automatic compaction paused (circuit breaker tripped)',
        breakerBypassedTitle: 'Automatic compaction tripped (temporarily bypassed by policy)',
        breakerBillingWarning: 'Warning: while bypassing compaction, turns send full uncompressed context and token billing can rise sharply; hard context-window limits still block oversized requests.',
        breakerFailureCode: 'Error code: {code}',
        breakerDiagnosticId: 'Diagnostic ID: {id}',
        breakerRetry: 'Retry compaction',
        breakerRetryBypassed: 'Re-try compaction',
        breakerRetrying: 'Retrying…',
        breakerRetryFailed: 'Retry compaction failed: {error}',
        breakerBypass: 'Continue chat (skip auto-compact)',
        breakerBypassConfirmHint: 'Confirm to temporarily skip automatic pressure compaction while total tokens remain under the hard request budget; no history is deleted and you can restore blocking or retry anytime.',
        breakerBypassConfirm: 'Confirm bypass',
        breakerRestoreBlock: 'Restore block',
        breakerBypassFailed: 'Failed to update breaker bypass: {error}',
        breakerCopyDiagnostic: 'Copy diagnostics',
        breakerCopiedDiagnostic: 'Copied',
        breakerReportIssue: 'Report issue',
        postCompactReinject: 'Post-compact workspace file re-injection',
        postCompactReinjectOn: 'On (default: 0 extra summary LLM calls, fresh read of up to 5 recent files)',
        postCompactReinjectOff: 'Off (do not re-inject recent local workspace files)',
        postCompactReinjectHint: 'Uses 0 extra summary LLM calls; after compaction, freshly reads up to 5 recent local workspace files (default 24KB cap, added to subsequent main-turn context input; auto-scales down on small safety windows such as 64k unless custom limits are configured), skipping AGENTS.md, secrets, and remote sessions.',
        observationMasking: 'Stage-1 0-LLM observation masking (observationMaskingEnabled)',
        observationMaskingOn: 'On (default: 0 summary LLM calls, archive large old tool outputs with history_read pointers)',
        observationMaskingOff: 'Off (skip Stage-1 masking and go straight to summary LLM compaction)',
        observationMaskingHint: 'On by default with 0 extra summary LLM calls: archives older non-error tool outputs >= 4000 chars outside the hot tail into head/tail previews, skipping the summary model whenever space targets are met (originals remain accessible via history_read). Disable only if you want every pressure trigger to go straight to full LLM summarization.',
        persistedOutput: 'Spill oversized tail tool outputs (Persisted-Output)',
        persistedOutputOn: 'On (default: 0 LLM, archive unsent tail tool outputs ≥ 32768 chars)',
        persistedOutputOff: 'Off (keep oversized unsent tail tool outputs inline)',
        persistedOutputHint: 'Uses 0 LLM tokens with 0 prefix-cache invalidation; archives only newly landed unsent tail successful tool outputs (skipping isError: true) with a 1200-char head/tail preview, never mutating prior history.',
        microcompact: 'Idle 0-LLM microcompaction (Microcompact)',
        microcompactOn: 'On (default: keep newest 4 hot outputs, fold older large outputs & repeated reads)',
        microcompactOff: 'Off (skip 0-LLM microcompaction after idle timeout)',
        microcompactHint: 'Shares the idle interval with 0 LLM calls (requires setting an idle interval above > 0 to take effect; inactive when 0); preserves the newest 4 hot tool outputs while folding older oversized tool outputs and same-path repeated reads before optional full idle summary if still needed.',
        snip: 'Last-resort 0-LLM emergency pruning (Snip)',
        snipOn: 'On (default: 0 LLM, prune old tool loops near hard budget or on 413)',
        snipOff: 'Off (disable 0-LLM last-resort emergency pruning)',
        snipHint: 'On by default, 0 LLM calls; triggers only as a last resort when approaching messageBudgetTokens or hitting 413 after regular compaction/continuation fails, archiving pruned tool loops with history_read pointers and never dropping recent user messages.',
        sessionMemoryEnabled: 'Background summary pre-warming (optional)',
        sessionMemoryEnabledToggle: 'Pre-generate summaries in background between turns',
        sessionMemoryHint: 'Opt-in (disabled by default). When enabled, pre-generates summaries in the background between turns for instant reuse on the next compaction, consuming extra API balance and token quota (bounded by min tokens, 60s cooldown, 12 KB size cap, and the per-cycle pre-warm limit below).',
        sessionMemoryMaxCalls: 'Background memory pre-warm limit per cycle (1–100)',
        sessionMemoryMaxCallsHint: 'Applies only when "Pre-generate summaries in background between turns" is enabled (default 8). Caps how many background summary pre-warm calls can run before the next committed compaction to protect API balance; automatically resets after each successful compaction commit (rollback, backup restore, or failed retries do not reset it) and never blocks normal chat or /compact.',
        sessionMemoryMaxCallsRange: 'Background memory pre-warm limit must be an integer between 1 and 100.',
        contextCollapseEnabled: 'Expired-window context collapse (Context Collapse)',
        contextCollapseEnabledToggle: 'Enable progressive collapse inside expired idle window (off by default)',
        contextCollapseHint: 'Opt-in (disabled by default). Triggers ONLY inside the expired idleCompactionMinutes resume window after 0-LLM Microcompact (NEVER runs during a warm prompt cache, and stays inactive when idleCompactionMinutes is 0); may invoke a summary LLM call consuming API balance.',
        overallProgress: 'Overall {percent}%',
        overallTokensProgress: 'Processed {processed} / {total} tok',
        phase_idle: 'Idle',
        phase_detecting: 'Inspecting session…',
        phase_backing_up: 'Creating & verifying session backup…',
        phase_masking: 'Masking verbose tool outputs…',
        phase_planning: 'Planning compaction range…',
        phase_summarizing: 'Generating summary…',
        phase_folding: 'Folding checkpoints…',
        phase_continuing: 'Running paged continuation…',
        phase_auditing: 'Auditing constraints & progress…',
        phase_committing: 'Committing checkpoint atomically…',
        phase_migrating: 'Converting billion-context format…',
        phase_restoring: 'Restoring session backup…',
        phase_done: 'Compaction complete',
        phase_error: 'Compaction failed',
        waveTotalProgress: 'Wave {index}/{total}',
        waveProgress: 'Wave {index}',
        chunkTotalProgress: 'Chunk {index}/{total}',
        chunkProgress: 'Chunk {index}',
        pageTotalProgress: 'Page {index}/{total}',
        pageProgress: 'Page {index}',
        attemptProgress: 'Attempt {attempt}/{max}',
        retryReason_CONSTRAINT_LOST: 'Retry: constraint audit failed',
        retryReason_CONSTRAINT_POLARITY_LOST: 'Retry: polarity conflict',
        retryReason_SUMMARY_NOT_SMALLER: 'Retry: summary not smaller',
        retryReason_SUMMARY_STRUCTURE_INVALID: 'Retry: invalid structure',
        retryReason_CONTINUATION_STRUCTURE: 'Retry: invalid structure',
        retryReason_PROGRESS_FACT_CONFLICT: 'Retry: progress fact conflict',
        retryReason_RETIRED_MEMORY_REINTRODUCED: 'Retry: retired requirement',
        retryReason_EMPTY_SUMMARY: 'Retry: empty summary',
        retryReason_MAX_TOKENS: 'Retry: output truncated',
        retryReason_SUMMARY_TIMEOUT: 'Retry: timeout',
        retryReason_RATE_LIMITED: 'Retry: rate limited',
        retryReason_CONTEXT_WINDOW_EXCEEDED: 'Retry: input limit exceeded',
        retryReason_SUMMARY_FOREIGN_BILI_FORMAT: 'Retry: legacy bili format (check proxy)',
        retryReason_BILI_PROXY_CONFLICT: 'Aborted: bili local proxy preflight conflict',
        retryReason_BILI_COEXISTENCE_CONFLICT: 'Blocked: active billion-context plugin conflict',
        retryReasonGeneric: 'Retry: {code}',
        biliConflictTitleActive: 'Active billion-context plugin detected alongside Weave',
        biliConflictTitleProxy: 'Suspected billion-context local proxy residue detected',
        biliConflictTitleBoth: 'Active billion-context plugin and local proxy residue detected',
        biliConflictBody: 'Running billion-context or leaving its local proxy active alongside Weave causes 413 rejections or incompatible summary formats. Complete these steps before continuing:',
        biliConflictStep1: '1. Open Plugin Manager and disable or uninstall billion-context (including billion-context-dsh).',
        biliConflictStep2: '2. Check your model provider settings and restore any baseUrl pointing to a 127.0.0.1 / localhost bili proxy back to the direct upstream URL.',
        biliConflictStep3: '3. Fully restart DSH (even if you just toggled billion-context off in the UI, a full restart is required to clear residual in-memory hooks and local proxy ports).',
        biliConflictStep4: '4. To preserve older billion-context sessions, run /compact migrate or restore a verified backup after restarting.',
        biliConflictSignal: 'Detected signals: {signals}',
        biliConflictBannerText: 'billion-context coexistence or proxy residue detected — disable it, restore baseUrl, and restart DSH.',
        biliConflictReopen: 'View fix steps',
        biliConflictDismiss: 'Dismiss for now',
        tokenDelta: '{before} → {current} tok',
        tokenSingle: '{before} tok',
        tokenTarget: 'target {target}',
        auditFallbackNotice: 'Controlled fallback: {count}',
        maskedCount: 'masked {count}',
        maskedSaved: 'masked {count} (-{saved} tok)',
        auxCacheHit: 'Summary cache hit {pct}%',
        auxReasoning: 'Summary reasoning {tokens}',
        reinjectedFiles: 'Reinjected {files} files ({bytes})',
        streamReceiving: 'received {chars} chars',
        streamChunks: 'streaming ({chunks})',
        streamWaiting: 'Waiting for model…',
        biliDetectedTitle: 'Detected billion-context format',
        biliVariantAuthored: 'authored checkpoint',
        biliVariantRaw: 'proxy raw log',
        biliVariantDsh: 'billion-context-dsh',
        biliVariantMixed: 'mixed format',
        biliFoldBlocks: '{count} fold block(s)',
        biliToolCalls: '{count} tool record(s)',
        biliBrokenPairing: 'broken tool pairing',
        biliConvert: 'Convert to Weave',
        biliConverting: 'Backing up & converting…',
        biliWaitOpenTurn: 'Wait for the current turn to finish before converting',
        biliWaitBusy: 'Wait for active compaction to finish before converting',
        biliConvertConfirmHint: 'Irreversible conversion to Weave checkpoints; a SHA-256 verified full backup is created first so you can restore anytime.',
        biliConvertConfirm: 'Backup & Convert',
        biliConvertDone: 'Converted to Weave format with a full backup preserved.',
        biliConvertStarted: 'Full backup verified; running conversion…',
        biliConvertFailed: 'Compatibility conversion failed: {error}',
        backupSaved: 'Backup: {id}',
        backupPathLabel: 'Backup path: ',
        backupOriginalLabel: 'Original backup',
        backupSnapshotLabel: 'Snapshot',
        backupSelectLabel: 'Select backup to restore',
        backupNodeCount: '{count} nodes',
        backupRestore: 'Restore backup',
        backupRestoring: 'Preparing restore…',
        backupRestoreConfirmHint: 'Restores session history from backup {id}; if open, writes lock and restore completes on reopen.',
        backupRestoreConfirm: 'Confirm restore',
        backupRestored: 'Backup {id} restored.',
        backupRestoreArmed: 'Backup restore armed ({id}). Fully restart DSH to load the restored history.',
        backupRestoreFailed: 'Backup restore failed: {error}',
        copyPath: 'Copy',
        copiedPath: 'Copied',
        pause: 'Pause',
        pausing: 'Pausing…',
        cancelFailed: 'Failed to pause: {error}',
        concurrencyChip: '{count}×',
        rateLimitedChip: 'rate-limited',
        resumeMigrationTitle: 'Migration paused',
        resumeCompactionTitle: 'Compaction paused',
        resumeProgressDetail: '{percent}% done · {remaining} remaining',
        resumePausedBudget: 'call budget reached',
        resumePausedFailure: 'paused after failures',
        resumeAutoHint: 'Auto-resumes on next message',
        resumeMigrationAction: 'Continue migration',
        resumeCompactionAction: 'Continue compaction',
        resumingAction: 'Resuming…',
        resumeFailed: 'Failed to resume: {error}',
        discardResume: 'Discard',
        discardingResume: 'Discarding…',
        discardResumeConfirmHint: 'Discarding clears the saved checkpoint progress (any full session backup remains intact).',
        discardResumeConfirm: 'Discard',
        discardResumeFailed: 'Failed to discard checkpoint: {error}',
        doneSummary: 'Compaction complete',
        errorFallback: 'Compaction did not complete. Check diagnostics or try again.',
        cancel: 'Cancel',
        dismiss: 'Dismiss',
        archiveWarnDockTitle: 'Local archive storage notice',
        archiveWarnDockDetail: 'Weave local archives (sessions/) use {total}, exceeding the {warn} notice threshold.',
        archiveWarnDockNoAutoDelete: 'Archives are never auto-deleted. Manage legacy plain spans or verified orphan archives in Settings → Compaction (Weave) → Local Archive Storage.',
        archiveStorageTitle: 'Local Archive Storage',
        archiveStorageStats: 'Used {total} · Backups {backup} · {sessions} sessions · {legacy} legacy plain spans',
        archiveStorageWarnBanner: 'Exceeds notice threshold ({warn}): archives are never auto-deleted; manually compress legacy spans or clean up verified deleted-session orphans.',
        archiveWarnMb: 'Archive storage notice threshold (MiB, 0 = off)',
        archiveWarnMbHint: 'Default 512 MiB (0 = disable notices). Soft warning only; never auto-deletes archives or blocks sending.',
        archiveWarnMbRange: 'Archive storage notice threshold must be an integer between 0 and 102400 MiB.',
        maxVisibleAttachmentMb: 'Visible image byte high-watermark (MiB, 0 = off)',
        maxVisibleAttachmentMbHint: 'Default 16 MiB (0 = disable byte trigger). When exceeded, batch-offloads older images in one shot while keeping newest 6 hot (0 LLM, never mutates user/message).',
        maxVisibleAttachmentMbRange: 'Visible image byte threshold must be an integer between 0 and 1024 MiB.',
        maxVisibleImages: 'Visible image count high-watermark (0 = off)',
        maxVisibleImagesHint: 'Default 24 images (0 = disable count trigger; includes >= 20 guard for >2000px edges). Batch-offloads to low watermark to keep KV cache stable.',
        maxVisibleImagesRange: 'Visible image count threshold must be an integer between 0 and 500.',
        archiveCompressLegacy: 'Losslessly compress legacy spans',
        archiveCompressing: 'Compressing…',
        archiveCompressDone: 'Losslessly compressed {count} legacy spans, freeing {saved} ({failed} failed).',
        archiveCompressFailed: 'Failed to compress legacy spans: {error}',
        archiveCleanupOrphans: 'Clean up orphan archives',
        archiveCleanupConfirmHint: 'Delete whole directories for only {count} host-verified missing sessions ({bytes}); active and uncertain sessions are always preserved.',
        archiveCleanupConfirm: 'Confirm orphan deletion',
        archiveCleanupDone: 'Cleaned up {count} orphan session archives, freeing {bytes}.',
        archiveCleanupUnavailable: 'Current host does not support orphan verification; cleanup is disabled to prevent accidental deletion.',
        archiveCleanupFailed: 'Failed to clean up orphan archives: {error}',
      },
    };

    function buildRpcHeaders() {
      const headers = { 'content-type': 'application/json' };
      const raw =
        (typeof globalThis.__WEAVE_RPC_TOKEN__ === 'string' && globalThis.__WEAVE_RPC_TOKEN__.trim()) ||
        (typeof window !== 'undefined' && window !== null && typeof window.__WEAVE_RPC_TOKEN__ === 'string' && window.__WEAVE_RPC_TOKEN__.trim()) ||
        '';
      if (raw) headers['x-weave-rpc-token'] = raw;
      return headers;
    }

    async function rpc(method, params, signal) {
      const response = await fetch(RPC_PATH, {
        method: 'POST',
        headers: buildRpcHeaders(),
        credentials: 'same-origin',
        body: JSON.stringify(params === undefined ? { method } : { method, params }),
        ...(signal === undefined ? {} : { signal }),
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text === '' ? null : JSON.parse(text);
      } catch {
        throw new Error(`host returned non-JSON (HTTP ${response.status})`);
      }
      if (payload === null || payload.ok !== true) {
        const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
        error.code = payload?.error?.code;
        throw error;
      }
      return payload.value;
    }

    function formatTemplate(template, vars) {
      let text = String(template ?? '');
      if (!vars || typeof vars !== 'object') return text;
      for (const [key, value] of Object.entries(vars)) {
        text = text.replaceAll(`{${key}}`, String(value ?? ''));
      }
      return text;
    }

    function formatElapsed(ms) {
      const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
      if (total < 60) return `${total}s`;
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      const pad = n => String(n).padStart(2, '0');
      return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
    }

    function formatTokens(value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return '';
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
      if (n >= 10_000) return `${Math.round(n / 1000)}k`;
      if (n >= 1_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
      return String(Math.round(n));
    }

    function positiveInt(value) {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    }

    function nonNegativeInt(value) {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    }

    function nullableNonNegativeInt(value) {
      if (value === null || value === undefined || value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    }

    function clampPercent(value) {
      if (value === null || value === undefined || value === '') return null;
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return Math.min(100, Math.max(0, Math.round(n)));
    }

    const SAFE_RETRY_CODE_RE = /^[A-Za-z0-9_.-]{1,80}$/;
    const RETRY_SECRET_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b|-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY-{5}/i;
    const RETRY_SECRET_PREFIX_RE = /(?:^|[_.-])(?:sk-|gh[pousr]_|(?:AKIA|ASIA)[0-9A-Z]{4,})|-{5}BEGIN [A-Z0-9 _]*PRIVATE[_ ]KEY(?:-{5})?/i;
    const GENERIC_RETRY_CODES = new Set([
      'Error',
      'TypeError',
      'RangeError',
      'SyntaxError',
      'ReferenceError',
      'URIError',
      'EvalError',
      'AggregateError',
      'ERROR',
      'UNKNOWN',
    ]);

    function normalizeRetryReasonCode(value) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (
        !trimmed ||
        !SAFE_RETRY_CODE_RE.test(trimmed) ||
        RETRY_SECRET_RE.test(trimmed) ||
        RETRY_SECRET_PREFIX_RE.test(trimmed) ||
        GENERIC_RETRY_CODES.has(trimmed)
      ) {
        return null;
      }
      return trimmed;
    }

    const EMPTY_STATUS = Object.freeze({
      active: false,
      runId: null,
      seq: 0,
      sessionId: '',
      trigger: null,
      phase: 'idle',
      turn: null,
      startedAt: null,
      updatedAt: null,
      finishedAt: null,
      elapsedMs: 0,
      overallPercent: null,
      overallProcessedTokens: null,
      overallTotalTokens: null,
      overallProcessedNodes: null,
      overallTotalNodes: null,
      waveIndex: null,
      waveTotal: null,
      chunkIndex: null,
      chunkTotal: null,
      pageIndex: null,
      pageTotal: null,
      attempt: null,
      maxAttempts: null,
      retryReasonCode: null,
      auditFallbackCount: null,
      beforeTokens: null,
      currentTokens: null,
      targetTokens: null,
      maskedCount: 0,
      maskedTokensSaved: 0,
      auxInputTokens: null,
      auxReasoningTokens: null,
      auxCacheReadTokens: null,
      auxCacheWriteTokens: null,
      reinjectBytes: null,
      reinjectFiles: null,
      summaryModel: null,
      cancellable: false,
      concurrency: null,
      activeWorkers: null,
      rateLimited: false,
      stream: null,
      messageKey: null,
      messageParams: null,
      message: null,
      error: null,
      bili: null,
      biliConflict: null,
      archiveWarning: null,
      backup: null,
      resumable: null,
      breaker: null,
      stopped: false,
      breakerBypassed: false,
      pressureBreakerAction: 'confirm',
      lastFailureCode: null,
      lastDiagnosticId: null,
      lastDiagnosticPath: null,
      pluginVersion: null,
      engineActive: true,
    });

    function normalizeError(raw) {
      if (!raw) return null;
      if (typeof raw === 'string') return raw ? { code: null, message: raw } : null;
      if (typeof raw === 'object') {
        const message = typeof raw.message === 'string' ? raw.message : '';
        const code = typeof raw.code === 'string' && raw.code ? raw.code : null;
        if (!message && !code) return null;
        return { code, message: message || code };
      }
      return null;
    }

    function normalizeBili(raw) {
      if (!raw || typeof raw !== 'object') return null;
      return {
        detected: raw.detected === true,
        variant: typeof raw.variant === 'string' && raw.variant ? raw.variant : null,
        foldBlockCount: nonNegativeInt(raw.foldBlockCount),
        biliToolCount: nonNegativeInt(raw.biliToolCount),
        hasBrokenToolPairing: raw.hasBrokenToolPairing === true,
        canConvert: raw.canConvert !== false,
        needsBackup: raw.needsBackup !== false,
        hasOpenTurn: raw.hasOpenTurn === true,
        reasons: Array.isArray(raw.reasons) ? raw.reasons.filter(r => typeof r === 'string') : [],
      };
    }

    function normalizeBiliConflict(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.detected !== true) return null;
      const activePlugin = raw.activePlugin === true || raw.kind === 'active_plugin' || raw.kind === 'both';
      const proxyResidue = raw.proxyResidue === true || raw.kind === 'proxy_residue' || raw.kind === 'both';
      const kind = activePlugin && proxyResidue
        ? 'both'
        : activePlugin
          ? 'active_plugin'
          : proxyResidue
            ? 'proxy_residue'
            : (['active_plugin', 'proxy_residue', 'both'].includes(raw.kind) ? raw.kind : null);
      if (!kind) return null;
      const signals = Array.isArray(raw.signals)
        ? [...new Set(raw.signals.filter(s => typeof s === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(s)))].slice(0, 12)
        : [];
      return {
        detected: true,
        kind,
        activePlugin,
        proxyResidue,
        signals,
        restartRecommended: raw.restartRecommended !== false,
        lastSignalAt: typeof raw.lastSignalAt === 'string' && raw.lastSignalAt ? raw.lastSignalAt : null,
        lastSignalCode: typeof raw.lastSignalCode === 'string' && raw.lastSignalCode ? raw.lastSignalCode : null,
      };
    }

    function biliConflictChanged(a, b) {
      if (a === b) return false;
      if (!a || !b) return true;
      return (
        a.detected !== b.detected ||
        a.kind !== b.kind ||
        a.activePlugin !== b.activePlugin ||
        a.proxyResidue !== b.proxyResidue ||
        a.lastSignalAt !== b.lastSignalAt ||
        a.lastSignalCode !== b.lastSignalCode ||
        (Array.isArray(a.signals) ? a.signals.join(',') : '') !== (Array.isArray(b.signals) ? b.signals.join(',') : '')
      );
    }

    function formatBytes(value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return '0 B';
      if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2).replace(/\.?0+$/, '')} GiB`;
      if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MiB`;
      if (n >= 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, '')} KiB`;
      return `${Math.round(n)} B`;
    }

    function normalizeArchiveWarning(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.warnExceeded !== true) return null;
      const totalBytes = nullableNonNegativeInt(raw.totalBytes);
      const warnBytes = nullableNonNegativeInt(raw.warnBytes);
      if (totalBytes === null || warnBytes === null || warnBytes <= 0 || totalBytes < warnBytes) return null;
      return {
        warnExceeded: true,
        totalBytes,
        warnBytes,
        legacyPlainSpanCount: nonNegativeInt(raw.legacyPlainSpanCount),
      };
    }

    function archiveWarningChanged(a, b) {
      if (a === b) return false;
      if (!a || !b) return true;
      return (
        a.warnExceeded !== b.warnExceeded ||
        a.totalBytes !== b.totalBytes ||
        a.warnBytes !== b.warnBytes ||
        a.legacyPlainSpanCount !== b.legacyPlainSpanCount
      );
    }

    function normalizeArchiveStorage(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const warnBytes = nullableNonNegativeInt(raw.warnBytes) ?? (512 * 1024 * 1024);
      const totalBytes = nonNegativeInt(raw.totalBytes);
      return {
        totalBytes,
        backupBytes: nonNegativeInt(raw.backupBytes),
        sessionCount: nonNegativeInt(raw.sessionCount),
        spanCount: nonNegativeInt(raw.spanCount),
        legacyPlainSpanCount: nonNegativeInt(raw.legacyPlainSpanCount),
        legacyPlainSpanBytes: nonNegativeInt(raw.legacyPlainSpanBytes),
        orphanProbeAvailable: raw.orphanProbeAvailable === true,
        orphanSessionCount: nonNegativeInt(raw.orphanSessionCount),
        orphanBytes: nonNegativeInt(raw.orphanBytes),
        ambiguousSessionCount: nonNegativeInt(raw.ambiguousSessionCount),
        warnBytes,
        warnExceeded: raw.warnExceeded === true || (warnBytes > 0 && totalBytes >= warnBytes),
      };
    }

    function normalizeBackupItem(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const backupId = typeof raw.backupId === 'string' && raw.backupId ? raw.backupId : null;
      if (!backupId) return null;
      return {
        backupId,
        createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : null,
        bytes: nullableNonNegativeInt(raw.bytes),
        eventCount: nullableNonNegativeInt(raw.eventCount),
        surfaceNodeCount: nullableNonNegativeInt(raw.surfaceNodeCount),
        reason: typeof raw.reason === 'string' && raw.reason ? raw.reason : null,
        isBaseline: raw.isBaseline === true,
        backupPath: typeof raw.backupPath === 'string' && raw.backupPath ? raw.backupPath : null,
      };
    }

    function normalizeBackup(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const pending = raw.pendingRestore && typeof raw.pendingRestore === 'object'
        ? {
            backupId: typeof raw.pendingRestore.backupId === 'string' ? raw.pendingRestore.backupId : '',
            backupPath: typeof raw.pendingRestore.backupPath === 'string' ? raw.pendingRestore.backupPath : null,
            targetPath: typeof raw.pendingRestore.targetPath === 'string' ? raw.pendingRestore.targetPath : null,
          }
        : null;
      const items = Array.isArray(raw.items)
        ? raw.items.map(normalizeBackupItem).filter(Boolean)
        : [];
      return {
        count: nonNegativeInt(raw.count),
        originalBackupId: typeof raw.originalBackupId === 'string' && raw.originalBackupId ? raw.originalBackupId : null,
        latestBackupId: typeof raw.latestBackupId === 'string' && raw.latestBackupId ? raw.latestBackupId : null,
        backupPath: typeof raw.backupPath === 'string' && raw.backupPath ? raw.backupPath : null,
        createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : null,
        pendingRestore: pending && pending.backupId ? pending : null,
        items,
      };
    }

    function normalizeStream(raw) {
      if (!raw || typeof raw !== 'object') return null;
      return {
        chunks: nonNegativeInt(raw.chunks),
        textChars: nonNegativeInt(raw.textChars),
        reasoningChars: nonNegativeInt(raw.reasoningChars),
        firstChunkMs: raw.firstChunkMs === null || raw.firstChunkMs === undefined ? null : nonNegativeInt(raw.firstChunkMs),
        idleMs: raw.idleMs === null || raw.idleMs === undefined ? null : nonNegativeInt(raw.idleMs),
      };
    }

    function normalizeResumable(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const jobId = typeof raw.jobId === 'string' && raw.jobId ? raw.jobId : null;
      if (!jobId) return null;
      const status = typeof raw.status === 'string' && raw.status ? raw.status : null;
      if (status === 'running') return null;
      return {
        jobId,
        trigger: typeof raw.trigger === 'string' && raw.trigger ? raw.trigger : null,
        status,
        interruptReason: typeof raw.interruptReason === 'string' && raw.interruptReason ? raw.interruptReason : null,
        overallPercent: clampPercent(raw.overallPercent),
        completedChunks: nonNegativeInt(raw.completedChunks),
        remainingNodes: nonNegativeInt(raw.remainingNodes),
        remainingTokens: nullableNonNegativeInt(raw.remainingTokens),
        initialTotalTokens: nullableNonNegativeInt(raw.initialTotalTokens),
        completedTokens: nullableNonNegativeInt(raw.completedTokens),
        updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
          ? raw.updatedAt
          : (typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : null),
        canAutoResume: raw.canAutoResume === true,
        lastErrorCode: typeof raw.lastErrorCode === 'string' && raw.lastErrorCode ? raw.lastErrorCode : null,
        lastErrorMessage: typeof raw.lastErrorMessage === 'string' && raw.lastErrorMessage ? raw.lastErrorMessage : null,
      };
    }

    function normalizeBreaker(raw, root) {
      const hasObject = raw && typeof raw === 'object';
      const src = hasObject ? raw : root;
      const stopped = Boolean(hasObject ? src.stopped === true : root?.stopped === true);
      const failures = hasObject ? nonNegativeInt(src.failures) : nonNegativeInt(root?.failures);
      const breakerBypassed = Boolean(
        hasObject ? (src.breakerBypassed === true || root?.breakerBypassed === true) : root?.breakerBypassed === true,
      );
      const actionRaw = hasObject && PRESSURE_BREAKER_ACTIONS.includes(src.pressureBreakerAction)
        ? src.pressureBreakerAction
        : PRESSURE_BREAKER_ACTIONS.includes(root?.pressureBreakerAction)
          ? root.pressureBreakerAction
          : 'confirm';
      const lastFailureCode =
        typeof (hasObject ? src.lastFailureCode : undefined) === 'string' && src.lastFailureCode
          ? src.lastFailureCode
          : typeof root?.lastFailureCode === 'string' && root.lastFailureCode
            ? root.lastFailureCode
            : null;
      const lastDiagnosticId =
        typeof (hasObject ? src.lastDiagnosticId : undefined) === 'string' && src.lastDiagnosticId
          ? src.lastDiagnosticId
          : typeof root?.lastDiagnosticId === 'string' && root.lastDiagnosticId
            ? root.lastDiagnosticId
            : null;
      const lastDiagnosticPath =
        typeof (hasObject ? src.lastDiagnosticPath : undefined) === 'string' && src.lastDiagnosticPath
          ? src.lastDiagnosticPath
          : typeof root?.lastDiagnosticPath === 'string' && root.lastDiagnosticPath
            ? root.lastDiagnosticPath
            : null;
      const breaker = hasObject
        ? {
            stopped,
            failures,
            breakerBypassed,
            pressureBreakerAction: actionRaw,
            lastFailureCode,
            lastDiagnosticId,
            lastDiagnosticPath,
          }
        : null;
      return {
        breaker,
        stopped,
        breakerBypassed,
        pressureBreakerAction: actionRaw,
        lastFailureCode,
        lastDiagnosticId,
        lastDiagnosticPath,
      };
    }

    function normalizeStatus(value) {
      if (!value || typeof value !== 'object') return EMPTY_STATUS;
      const active = value.active === true;
      const rawPhase = typeof value.phase === 'string' && value.phase ? value.phase : (active ? 'summarizing' : 'idle');
      const br = normalizeBreaker(value.breaker, value);
      return {
        active,
        runId: typeof value.runId === 'string' && value.runId ? value.runId : null,
        seq: nonNegativeInt(value.seq),
        sessionId: typeof value.sessionId === 'string' ? value.sessionId : '',
        trigger: typeof value.trigger === 'string' && value.trigger ? value.trigger : null,
        phase: rawPhase,
        turn: value.turn === null || value.turn === undefined ? null : Number(value.turn),
        startedAt: typeof value.startedAt === 'number' && Number.isFinite(value.startedAt) ? value.startedAt : null,
        updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : null,
        finishedAt: typeof value.finishedAt === 'number' && Number.isFinite(value.finishedAt) ? value.finishedAt : null,
        elapsedMs: nonNegativeInt(value.elapsedMs),
        overallPercent: clampPercent(value.overallPercent),
        overallProcessedTokens: nullableNonNegativeInt(value.overallProcessedTokens),
        overallTotalTokens: nullableNonNegativeInt(value.overallTotalTokens),
        overallProcessedNodes: nullableNonNegativeInt(value.overallProcessedNodes),
        overallTotalNodes: nullableNonNegativeInt(value.overallTotalNodes),
        waveIndex: positiveInt(value.waveIndex),
        waveTotal: positiveInt(value.waveTotal),
        chunkIndex: positiveInt(value.chunkIndex),
        chunkTotal: positiveInt(value.chunkTotal),
        pageIndex: positiveInt(value.pageIndex),
        pageTotal: positiveInt(value.pageTotal),
        attempt: positiveInt(value.attempt),
        maxAttempts: positiveInt(value.maxAttempts),
        retryReasonCode: normalizeRetryReasonCode(value.retryReasonCode),
        auditFallbackCount: positiveInt(value.auditFallbackCount),
        beforeTokens: positiveInt(value.beforeTokens),
        currentTokens: positiveInt(value.currentTokens),
        targetTokens: positiveInt(value.targetTokens),
        maskedCount: nonNegativeInt(value.maskedCount),
        maskedTokensSaved: nonNegativeInt(value.maskedTokensSaved),
        auxInputTokens: nullableNonNegativeInt(value.auxInputTokens),
        auxReasoningTokens: nullableNonNegativeInt(value.auxReasoningTokens),
        auxCacheReadTokens: nullableNonNegativeInt(value.auxCacheReadTokens),
        auxCacheWriteTokens: nullableNonNegativeInt(value.auxCacheWriteTokens),
        reinjectBytes: nullableNonNegativeInt(value.reinjectBytes),
        reinjectFiles: nullableNonNegativeInt(value.reinjectFiles),
        summaryModel: typeof value.summaryModel === 'string' && value.summaryModel ? value.summaryModel : null,
        cancellable: Boolean(value.cancellable),
        concurrency: positiveInt(value.concurrency),
        activeWorkers: nullableNonNegativeInt(value.activeWorkers),
        rateLimited: Boolean(value.rateLimited),
        stream: normalizeStream(value.stream),
        messageKey: typeof value.messageKey === 'string' && value.messageKey ? value.messageKey : null,
        messageParams: value.messageParams && typeof value.messageParams === 'object' ? value.messageParams : null,
        message: typeof value.message === 'string' && value.message ? value.message : null,
        error: normalizeError(value.error),
        bili: normalizeBili(value.bili),
        biliConflict: normalizeBiliConflict(value.biliConflict),
        archiveWarning: normalizeArchiveWarning(value.archiveWarning),
        backup: normalizeBackup(value.backup),
        resumable: normalizeResumable(value.resumable),
        breaker: br.breaker,
        stopped: br.stopped,
        breakerBypassed: br.breakerBypassed,
        pressureBreakerAction: br.pressureBreakerAction,
        lastFailureCode: br.lastFailureCode,
        lastDiagnosticId: br.lastDiagnosticId,
        lastDiagnosticPath: br.lastDiagnosticPath,
        pluginVersion: typeof value.pluginVersion === 'string' && value.pluginVersion ? value.pluginVersion : null,
        engineActive: value.engineActive === false ? false : true,
      };
    }

    function resumableChanged(a, b) {
      if (a === b) return false;
      if (!a || !b) return true;
      return (
        a.jobId !== b.jobId ||
        a.trigger !== b.trigger ||
        a.status !== b.status ||
        a.interruptReason !== b.interruptReason ||
        a.overallPercent !== b.overallPercent ||
        a.completedChunks !== b.completedChunks ||
        a.remainingNodes !== b.remainingNodes ||
        a.remainingTokens !== b.remainingTokens ||
        a.initialTotalTokens !== b.initialTotalTokens ||
        a.completedTokens !== b.completedTokens ||
        a.updatedAt !== b.updatedAt ||
        a.canAutoResume !== b.canAutoResume ||
        a.lastErrorCode !== b.lastErrorCode ||
        a.lastErrorMessage !== b.lastErrorMessage
      );
    }

    function backupItemsChanged(aItems, bItems) {
      const listA = Array.isArray(aItems) ? aItems : [];
      const listB = Array.isArray(bItems) ? bItems : [];
      if (listA.length !== listB.length) return true;
      for (let i = 0; i < listA.length; i += 1) {
        const x = listA[i];
        const y = listB[i];
        if (
          x.backupId !== y.backupId ||
          x.isBaseline !== y.isBaseline ||
          x.surfaceNodeCount !== y.surfaceNodeCount ||
          x.eventCount !== y.eventCount ||
          x.backupPath !== y.backupPath ||
          x.createdAt !== y.createdAt
        ) {
          return true;
        }
      }
      return false;
    }

    function statusChanged(a, b) {
      if (a.active !== b.active || a.phase !== b.phase || a.runId !== b.runId || a.seq !== b.seq || a.trigger !== b.trigger) return true;
      if (a.active && Math.floor(a.elapsedMs / 500) !== Math.floor(b.elapsedMs / 500)) return true;
      if (
        a.overallPercent !== b.overallPercent ||
        a.overallProcessedTokens !== b.overallProcessedTokens ||
        a.overallTotalTokens !== b.overallTotalTokens ||
        a.overallProcessedNodes !== b.overallProcessedNodes ||
        a.overallTotalNodes !== b.overallTotalNodes ||
        a.waveIndex !== b.waveIndex || a.waveTotal !== b.waveTotal ||
        a.chunkIndex !== b.chunkIndex || a.chunkTotal !== b.chunkTotal ||
        a.pageIndex !== b.pageIndex || a.pageTotal !== b.pageTotal ||
        a.attempt !== b.attempt || a.maxAttempts !== b.maxAttempts ||
        a.retryReasonCode !== b.retryReasonCode ||
        a.auditFallbackCount !== b.auditFallbackCount ||
        a.beforeTokens !== b.beforeTokens || a.currentTokens !== b.currentTokens || a.targetTokens !== b.targetTokens ||
        a.maskedCount !== b.maskedCount || a.maskedTokensSaved !== b.maskedTokensSaved ||
        a.auxInputTokens !== b.auxInputTokens || a.auxReasoningTokens !== b.auxReasoningTokens ||
        a.auxCacheReadTokens !== b.auxCacheReadTokens || a.auxCacheWriteTokens !== b.auxCacheWriteTokens ||
        a.reinjectBytes !== b.reinjectBytes || a.reinjectFiles !== b.reinjectFiles ||
        a.summaryModel !== b.summaryModel || a.message !== b.message ||
        a.cancellable !== b.cancellable ||
        a.concurrency !== b.concurrency ||
        a.activeWorkers !== b.activeWorkers ||
        a.rateLimited !== b.rateLimited ||
        a.finishedAt !== b.finishedAt
      ) return true;
      if ((a.stream?.chunks ?? -1) !== (b.stream?.chunks ?? -1) ||
          (a.stream?.textChars ?? -1) !== (b.stream?.textChars ?? -1) ||
          (a.stream?.reasoningChars ?? -1) !== (b.stream?.reasoningChars ?? -1)) return true;
      if ((a.error?.code ?? null) !== (b.error?.code ?? null) || (a.error?.message ?? null) !== (b.error?.message ?? null)) return true;
      if (resumableChanged(a.resumable, b.resumable)) return true;
      if (biliConflictChanged(a.biliConflict, b.biliConflict)) return true;
      if (archiveWarningChanged(a.archiveWarning, b.archiveWarning)) return true;
      if (
        (a.bili?.detected ?? false) !== (b.bili?.detected ?? false) ||
        (a.bili?.variant ?? null) !== (b.bili?.variant ?? null) ||
        (a.bili?.foldBlockCount ?? 0) !== (b.bili?.foldBlockCount ?? 0) ||
        (a.bili?.biliToolCount ?? 0) !== (b.bili?.biliToolCount ?? 0) ||
        (a.bili?.hasBrokenToolPairing ?? false) !== (b.bili?.hasBrokenToolPairing ?? false) ||
        (a.bili?.canConvert ?? true) !== (b.bili?.canConvert ?? true) ||
        (a.bili?.hasOpenTurn ?? false) !== (b.bili?.hasOpenTurn ?? false)
      ) return true;
      if (
        (a.backup?.count ?? 0) !== (b.backup?.count ?? 0) ||
        (a.backup?.originalBackupId ?? null) !== (b.backup?.originalBackupId ?? null) ||
        (a.backup?.latestBackupId ?? null) !== (b.backup?.latestBackupId ?? null) ||
        (a.backup?.backupPath ?? null) !== (b.backup?.backupPath ?? null) ||
        (a.backup?.pendingRestore?.backupId ?? null) !== (b.backup?.pendingRestore?.backupId ?? null) ||
        backupItemsChanged(a.backup?.items, b.backup?.items)
      ) return true;
      if (
        a.stopped !== b.stopped ||
        a.breakerBypassed !== b.breakerBypassed ||
        a.pressureBreakerAction !== b.pressureBreakerAction ||
        a.lastFailureCode !== b.lastFailureCode ||
        a.lastDiagnosticId !== b.lastDiagnosticId ||
        a.lastDiagnosticPath !== b.lastDiagnosticPath ||
        a.pluginVersion !== b.pluginVersion ||
        a.engineActive !== b.engineActive ||
        (a.breaker?.failures ?? 0) !== (b.breaker?.failures ?? 0)
      ) return true;
      return false;
    }

    function computeProgressPercent(status) {
      if (status.phase === 'done') return 100;
      if (typeof status.overallPercent === 'number' && Number.isFinite(status.overallPercent)) {
        return Math.min(100, Math.max(0, Math.round(status.overallPercent)));
      }
      if (status.pageTotal && status.pageIndex) {
        return Math.min(98, Math.max(4, Math.round(((status.pageIndex - 0.5) / status.pageTotal) * 100)));
      }
      if (status.chunkTotal && status.chunkIndex) {
        return Math.min(98, Math.max(4, Math.round(((status.chunkIndex - 0.5) / status.chunkTotal) * 100)));
      }
      if (status.waveTotal && status.waveIndex) {
        return Math.min(98, Math.max(4, Math.round(((status.waveIndex - 0.5) / status.waveTotal) * 100)));
      }
      return null;
    }

    function isPageHidden() {
      const doc = globalThis.document;
      if (!doc) return false;
      return doc.visibilityState === 'hidden' || doc.hidden === true;
    }

    function phaseLabelFor(tr, phase) {
      const key = `phase_${phase}`;
      const translated = tr(key);
      if (translated && translated !== key) return translated;
      return tr('compressing');
    }

    function variantLabelFor(tr, variant) {
      if (variant === 'ranxianglei-authored-checkpoint') return tr('biliVariantAuthored');
      if (variant === 'ranxianglei-proxy-raw') return tr('biliVariantRaw');
      if (variant === 'billion-context-dsh') return tr('biliVariantDsh');
      if (variant === 'mixed') return tr('biliVariantMixed');
      return variant || '';
    }

    function formatLocalShortTime(value) {
      if (typeof value !== 'string' || !value) return null;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return null;
      const pad = n => String(n).padStart(2, '0');
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function formatBackupOptionLabel(tr, item, originalBackupId) {
      const isOriginal = item.isBaseline === true || (Boolean(originalBackupId) && item.backupId === originalBackupId);
      const parts = [isOriginal ? tr('backupOriginalLabel') : tr('backupSnapshotLabel')];
      const count = item.surfaceNodeCount !== null && item.surfaceNodeCount > 0
        ? item.surfaceNodeCount
        : (item.eventCount !== null && item.eventCount > 0 ? item.eventCount : null);
      if (count !== null) {
        parts.push(formatTemplate(tr('backupNodeCount'), { count }));
      }
      const localTime = formatLocalShortTime(item.createdAt);
      if (localTime) {
        parts.push(localTime);
      } else {
        parts.push(item.backupId.slice(-8));
      }
      return parts.join(' · ');
    }

    const RETRY_REASON_KEYS = Object.freeze({
      CONSTRAINT_LOST: 'retryReason_CONSTRAINT_LOST',
      CONSTRAINT_POLARITY_LOST: 'retryReason_CONSTRAINT_POLARITY_LOST',
      SUMMARY_NOT_SMALLER: 'retryReason_SUMMARY_NOT_SMALLER',
      SUMMARY_STRUCTURE_INVALID: 'retryReason_SUMMARY_STRUCTURE_INVALID',
      CONTINUATION_STRUCTURE: 'retryReason_CONTINUATION_STRUCTURE',
      PROGRESS_FACT_CONFLICT: 'retryReason_PROGRESS_FACT_CONFLICT',
      RETIRED_MEMORY_REINTRODUCED: 'retryReason_RETIRED_MEMORY_REINTRODUCED',
      EMPTY_SUMMARY: 'retryReason_EMPTY_SUMMARY',
      MAX_TOKENS: 'retryReason_MAX_TOKENS',
      SUMMARY_TIMEOUT: 'retryReason_SUMMARY_TIMEOUT',
      RATE_LIMITED: 'retryReason_RATE_LIMITED',
      CONTEXT_WINDOW_EXCEEDED: 'retryReason_CONTEXT_WINDOW_EXCEEDED',
      SUMMARY_FOREIGN_BILI_FORMAT: 'retryReason_SUMMARY_FOREIGN_BILI_FORMAT',
      BILI_PROXY_CONFLICT: 'retryReason_BILI_PROXY_CONFLICT',
      BILI_COEXISTENCE_CONFLICT: 'retryReason_BILI_COEXISTENCE_CONFLICT',
    });

    function biliConflictTitleKey(kind) {
      if (kind === 'both') return 'biliConflictTitleBoth';
      if (kind === 'proxy_residue') return 'biliConflictTitleProxy';
      return 'biliConflictTitleActive';
    }

    function retryReasonLabelFor(tr, code) {
      if (!code) return null;
      const key = Object.prototype.hasOwnProperty.call(RETRY_REASON_KEYS, code)
        ? RETRY_REASON_KEYS[code]
        : null;
      if (key) return tr(key);
      return formatTemplate(tr('retryReasonGeneric'), { code });
    }

    function buildAuxAndReinjectTelemetry(tr, status) {
      const items = [];
      const totalAuxIn =
        (status.auxInputTokens ?? 0) +
        (status.auxCacheReadTokens ?? 0) +
        (status.auxCacheWriteTokens ?? 0);
      if (status.auxCacheReadTokens > 0 && totalAuxIn > 0) {
        const pct = clampPercent((status.auxCacheReadTokens / totalAuxIn) * 100);
        items.push(formatTemplate(tr('auxCacheHit'), { pct }));
      }
      if (status.auxReasoningTokens > 0) {
        items.push(formatTemplate(tr('auxReasoning'), { tokens: formatTokens(status.auxReasoningTokens) }));
      }
      if (status.reinjectBytes > 0) {
        items.push(formatTemplate(tr('reinjectedFiles'), {
          files: status.reinjectFiles ?? 0,
          bytes: formatBytes(status.reinjectBytes),
        }));
      }
      return items;
    }

    function buildTelemetryItems(tr, status) {
      const items = [];
      if (status.overallTotalTokens && status.overallTotalTokens > 0) {
        items.push(formatTemplate(tr('overallTokensProgress'), {
          processed: formatTokens(status.overallProcessedTokens ?? 0),
          total: formatTokens(status.overallTotalTokens),
        }));
      }
      if (status.waveIndex) {
        items.push(
          status.waveTotal
            ? formatTemplate(tr('waveTotalProgress'), { index: status.waveIndex, total: status.waveTotal })
            : formatTemplate(tr('waveProgress'), { index: status.waveIndex }),
        );
      }
      if (status.chunkIndex) {
        items.push(
          status.chunkTotal
            ? formatTemplate(tr('chunkTotalProgress'), { index: status.chunkIndex, total: status.chunkTotal })
            : formatTemplate(tr('chunkProgress'), { index: status.chunkIndex }),
        );
      }
      if (status.pageIndex) {
        items.push(
          status.pageTotal
            ? formatTemplate(tr('pageTotalProgress'), { index: status.pageIndex, total: status.pageTotal })
            : formatTemplate(tr('pageProgress'), { index: status.pageIndex }),
        );
      }
      if (status.attempt && (status.attempt > 1 || (status.maxAttempts && status.maxAttempts > 1))) {
        items.push(formatTemplate(tr('attemptProgress'), {
          attempt: status.attempt,
          max: status.maxAttempts ?? status.attempt,
        }));
      }
      if (status.retryReasonCode) {
        const reasonLabel = retryReasonLabelFor(tr, status.retryReasonCode);
        if (reasonLabel) items.push(reasonLabel);
      }
      if (status.auditFallbackCount && status.auditFallbackCount > 0) {
        items.push(formatTemplate(tr('auditFallbackNotice'), { count: status.auditFallbackCount }));
      }
      if (status.beforeTokens) {
        const before = formatTokens(status.beforeTokens);
        const current = status.currentTokens ? formatTokens(status.currentTokens) : '';
        let tok = current && status.currentTokens !== status.beforeTokens
          ? formatTemplate(tr('tokenDelta'), { before, current })
          : formatTemplate(tr('tokenSingle'), { before });
        if (status.targetTokens) {
          tok += ` / ${formatTemplate(tr('tokenTarget'), { target: formatTokens(status.targetTokens) })}`;
        }
        items.push(tok);
      }
      if (status.maskedCount > 0) {
        items.push(
          status.maskedTokensSaved > 0
            ? formatTemplate(tr('maskedSaved'), { count: status.maskedCount, saved: formatTokens(status.maskedTokensSaved) })
            : formatTemplate(tr('maskedCount'), { count: status.maskedCount }),
        );
      }
      items.push(...buildAuxAndReinjectTelemetry(tr, status));
      if (status.stream) {
        const chars = status.stream.textChars + status.stream.reasoningChars;
        if (chars > 0) {
          items.push(formatTemplate(tr('streamReceiving'), { chars }));
        } else if (status.stream.chunks > 0) {
          items.push(formatTemplate(tr('streamChunks'), { chunks: status.stream.chunks }));
        } else {
          items.push(tr('streamWaiting'));
        }
      }
      return items;
    }

    function buildBiliSummary(tr, bili) {
      const parts = [];
      const variant = variantLabelFor(tr, bili.variant);
      if (variant) parts.push(variant);
      if (bili.foldBlockCount > 0) parts.push(formatTemplate(tr('biliFoldBlocks'), { count: bili.foldBlockCount }));
      if (bili.biliToolCount > 0) parts.push(formatTemplate(tr('biliToolCalls'), { count: bili.biliToolCount }));
      if (bili.hasBrokenToolPairing) parts.push(tr('biliBrokenPairing'));
      return parts.join(' · ');
    }

    const compactButtonStyle = {
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: TOKEN_BORDER_2,
      borderRadius: 5,
      padding: '3px 8px',
      fontSize: 11,
      lineHeight: 1.35,
      fontFamily: 'inherit',
      cursor: 'pointer',
      background: TOKEN_SECONDARY_BG,
      color: TOKEN_TEXT_PRIMARY,
      whiteSpace: 'nowrap',
    };
    const compactPrimaryButtonStyle = {
      ...compactButtonStyle,
      background: TOKEN_PRIMARY_BG,
      borderColor: 'transparent',
      color: TOKEN_PRIMARY_FG,
    };
    const compactMicroButtonStyle = {
      ...compactButtonStyle,
      padding: '1px 6px',
      flexShrink: 0,
    };
    const compactSelectStyle = {
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: TOKEN_BORDER_2,
      borderRadius: 5,
      padding: '2px 6px',
      fontSize: 11,
      lineHeight: 1.35,
      fontFamily: 'inherit',
      background: TOKEN_SURFACE_2,
      color: TOKEN_TEXT_PRIMARY,
      maxWidth: 210,
    };
    const compactDismissButtonStyle = {
      border: 'none',
      background: 'transparent',
      color: TOKEN_TEXT_SECONDARY,
      cursor: 'pointer',
      padding: '0 4px',
      fontSize: 14,
      lineHeight: 1,
    };
    const codePathStyle = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 11,
      padding: '1px 5px',
      borderRadius: 4,
      background: TOKEN_SURFACE_2,
      color: TOKEN_TEXT_SECONDARY,
      display: 'inline-block',
      maxWidth: 180,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      verticalAlign: 'bottom',
      userSelect: 'all',
    };
    const dividerStyle = {
      borderTop: `1px solid ${TOKEN_BORDER_1}`,
      paddingTop: 5,
    };

    function disabledStyle(baseStyle, disabled) {
      return disabled ? { ...baseStyle, opacity: 0.55, cursor: 'not-allowed' } : baseStyle;
    }

    function statusDotStyle(background) {
      return {
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        flexShrink: 0,
        background,
      };
    }

    function pillStyle(color = TOKEN_TEXT_SECONDARY, extra) {
      return {
        fontSize: 11,
        padding: '0 6px',
        borderRadius: 999,
        background: TOKEN_SURFACE_2,
        color,
        ...(extra ?? {}),
      };
    }

    function sectionRowStyle(hasPrev, extra) {
      return {
        ...(hasPrev ? dividerStyle : {}),
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        ...(extra ?? {}),
      };
    }

    const confirmBannerStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      flexWrap: 'wrap',
      padding: '5px 8px',
      borderRadius: 6,
      border: '1px solid rgba(217, 119, 6, 0.35)',
      background: 'rgba(217, 119, 6, 0.08)',
    };

    function renderInlineConfirmBar({
      confirmKey,
      hintText,
      confirmText,
      cancelText,
      disabled,
      onConfirm,
      onCancel,
    }) {
      return h('div', { 'data-confirm': confirmKey, style: confirmBannerStyle },
        h('span', { style: { flex: 1, minWidth: 180, fontSize: 11, color: TOKEN_TEXT_PRIMARY } }, hintText),
        h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
          h('button', {
            type: 'button',
            'data-action': `${confirmKey}-confirm`,
            disabled,
            style: compactPrimaryButtonStyle,
            onClick: onConfirm,
          }, confirmText),
          h('button', {
            type: 'button',
            'data-action': `${confirmKey}-cancel`,
            disabled,
            style: compactButtonStyle,
            onClick: onCancel,
          }, cancelText),
        ),
      );
    }

    function renderModalPortal(modalNode) {
      try {
        if (typeof document !== 'undefined' && document?.body) {
          const rd = require('react-dom');
          if (typeof rd?.createPortal === 'function') {
            return rd.createPortal(modalNode, document.body);
          }
        }
      } catch {
        // Fallback inline when react-dom or document.body is unavailable in headless mocks.
      }
      return modalNode;
    }

    function renderConflictBannerAndModal({
      tr,
      biliConflict,
      biliConflictKey,
      showBiliConflictModal,
      onReopen,
      onDismissModal,
    }) {
      const conflictAccent = biliConflict.activePlugin ? TOKEN_TEXT_ERROR : TOKEN_TEXT_WARNING;
      const signalList = Array.isArray(biliConflict.signals) && biliConflict.signals.length > 0
        ? biliConflict.signals.join(', ')
        : biliConflict.kind;
      const nodes = [
        h('div', {
          key: 'bili-conflict-banner',
          role: 'alert',
          'data-bili-conflict-banner': biliConflict.kind,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
            padding: '5px 8px',
            borderRadius: 6,
            border: `1px solid ${conflictAccent}`,
            background: TOKEN_SURFACE_2,
          },
        },
          h('span', { 'aria-hidden': 'true', style: statusDotStyle(conflictAccent) }),
          h('span', { style: { flex: 1, minWidth: 180, fontWeight: 600, color: conflictAccent } },
            tr(biliConflictTitleKey(biliConflict.kind))),
          h('span', { style: { flex: '1 1 100%', fontSize: 11, color: TOKEN_TEXT_SECONDARY } },
            tr('biliConflictBannerText')),
          h('button', {
            type: 'button',
            'data-action': 'reopen-bili-conflict-modal',
            'data-bili-conflict-reopen': 'true',
            style: compactPrimaryButtonStyle,
            onClick: onReopen,
          }, tr('biliConflictReopen')),
        ),
      ];
      if (showBiliConflictModal) {
        nodes.push(renderModalPortal(
          h('div', {
            key: 'bili-conflict-modal',
            role: 'alertdialog',
            'aria-modal': 'true',
            'data-bili-conflict-modal': biliConflict.kind,
            style: {
              position: 'fixed',
              inset: 0,
              zIndex: 9999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 16,
              background: 'rgba(15, 23, 42, 0.56)',
            },
          },
            h('div', {
              style: {
                width: '100%',
                maxWidth: 520,
                boxSizing: 'border-box',
                borderRadius: 10,
                border: `1px solid ${conflictAccent}`,
                borderLeft: `4px solid ${conflictAccent}`,
                background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
                color: TOKEN_TEXT_PRIMARY,
                padding: '14px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                boxShadow: '0 12px 32px rgba(0, 0, 0, 0.32)',
              },
            },
              h('div', { style: { fontSize: 14, fontWeight: 700, color: conflictAccent } },
                tr(biliConflictTitleKey(biliConflict.kind))),
              h('p', { style: { margin: 0, fontSize: 12, lineHeight: 1.45, color: TOKEN_TEXT_PRIMARY } },
                tr('biliConflictBody')),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, lineHeight: 1.45, color: TOKEN_TEXT_PRIMARY } },
                h('div', { key: 's1' }, tr('biliConflictStep1')),
                h('div', { key: 's2' }, tr('biliConflictStep2')),
                h('div', { key: 's3', style: { fontWeight: 600 } }, tr('biliConflictStep3')),
                h('div', { key: 's4', style: { color: TOKEN_TEXT_SECONDARY } }, tr('biliConflictStep4')),
              ),
              h('div', { style: { fontSize: 11, color: TOKEN_TEXT_SECONDARY, fontVariantNumeric: 'tabular-nums' } },
                formatTemplate(tr('biliConflictSignal'), { signals: signalList })),
              h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 } },
                h('button', {
                  type: 'button',
                  'data-action': 'dismiss-bili-conflict-modal',
                  'data-bili-conflict-dismiss': 'true',
                  style: compactPrimaryButtonStyle,
                  onClick: () => onDismissModal(biliConflictKey),
                }, tr('biliConflictDismiss')),
              ),
            ),
          ),
        ));
      }
      return nodes;
    }

    function renderActiveProgressSection({
      tr,
      status,
      activePhase,
      progressPercent,
      indeterminateStep,
      telemetryItems,
      cancelBusy,
      onCancel,
    }) {
      const headerText = status.active && status.message && !status.messageKey
        ? status.message
        : phaseLabelFor(tr, activePhase);
      const hasOverallPercent = status.overallPercent !== null;
      const showConcurrencyChip = status.rateLimited === true || (status.concurrency !== null && status.concurrency > 1);
      const concurrencyLabel = status.rateLimited === true
        ? tr('rateLimitedChip')
        : formatTemplate(tr('concurrencyChip'), { count: status.concurrency });
      const indeterminateMargins = ['0%', '22%', '44%', '65%'];
      return h('div', { key: 'progress', 'data-compaction-section': 'progress', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          h('span', { 'aria-hidden': 'true', style: statusDotStyle(TOKEN_ACCENT) }),
          hasOverallPercent
            ? h('span', {
                'data-overall-percent': String(status.overallPercent),
                style: { fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: TOKEN_ACCENT },
              }, formatTemplate(tr('overallProgress'), { percent: status.overallPercent }))
            : progressPercent !== null
              ? h('span', {
                  'data-progress-percent': String(progressPercent),
                  style: { fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: TOKEN_ACCENT },
                }, `${progressPercent}%`)
              : null,
          hasOverallPercent || progressPercent !== null
            ? h('span', { 'aria-hidden': 'true', style: { color: TOKEN_TEXT_SECONDARY } }, '·')
            : null,
          h('span', { style: { fontWeight: 600, color: TOKEN_TEXT_PRIMARY } }, headerText),
          status.summaryModel
            ? h('span', { 'data-summary-model': status.summaryModel, style: pillStyle() }, status.summaryModel)
            : null,
          showConcurrencyChip
            ? h('span', {
                'data-compaction-concurrency': status.rateLimited ? 'rate-limited' : String(status.concurrency),
                title: status.activeWorkers !== null && status.concurrency !== null
                  ? `${status.activeWorkers}/${status.concurrency}`
                  : undefined,
                style: pillStyle(status.rateLimited ? TOKEN_TEXT_WARNING : TOKEN_TEXT_SECONDARY, { fontVariantNumeric: 'tabular-nums' }),
              }, concurrencyLabel)
            : null,
          h('span', {
            'data-compaction-elapsed': 'true',
            style: { marginLeft: 'auto', fontSize: 11, fontVariantNumeric: 'tabular-nums', color: TOKEN_TEXT_SECONDARY },
          }, formatElapsed(status.elapsedMs)),
          status.cancellable === true
            ? h('button', {
                type: 'button',
                'data-action': 'cancel-compaction',
                disabled: cancelBusy,
                style: disabledStyle(compactMicroButtonStyle, cancelBusy),
                onClick: onCancel,
              }, cancelBusy ? tr('pausing') : tr('pause'))
            : null,
        ),
        h('div', {
          role: 'progressbar',
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          ...(progressPercent === null ? {} : { 'aria-valuenow': progressPercent }),
          'data-progress-mode': progressPercent === null ? 'indeterminate' : 'determinate',
          style: { width: '100%', height: 4, borderRadius: 999, overflow: 'hidden', background: TOKEN_BORDER_1 },
        },
          h('div', {
            style: progressPercent === null
              ? {
                  width: '35%',
                  height: '100%',
                  borderRadius: 999,
                  marginLeft: indeterminateMargins[indeterminateStep],
                  background: TOKEN_ACCENT,
                  transition: 'margin-left 450ms ease',
                }
              : {
                  width: `${progressPercent}%`,
                  height: '100%',
                  borderRadius: 999,
                  background: TOKEN_ACCENT,
                  transition: 'width 250ms ease',
                },
          }),
        ),
        telemetryItems.length > 0
          ? h('div', {
              'data-compaction-telemetry': 'true',
              ...(status.retryReasonCode ? { 'data-retry-reason': status.retryReasonCode } : {}),
              style: { fontSize: 11, lineHeight: 1.35, color: TOKEN_TEXT_SECONDARY, fontVariantNumeric: 'tabular-nums' },
            }, telemetryItems.join(' · '))
          : null,
      );
    }

    function renderTerminalSection({ tr, hasPrev, actionError, status, settledTelemetryItems = [], onDismiss }) {
      const isErr = actionError !== null || status.phase === 'error';
      const errMessage = actionError ?? status.error?.message ?? status.message ?? tr('errorFallback');
      const doneDelta = status.beforeTokens && status.currentTokens
        ? ` (${formatTemplate(tr('tokenDelta'), { before: formatTokens(status.beforeTokens), current: formatTokens(status.currentTokens) })})`
        : '';
      const doneElapsed = status.elapsedMs > 0 ? ` · ${formatElapsed(status.elapsedMs)}` : '';
      const doneLabel = status.trigger === 'migration' ? tr('biliConvertDone') : (status.message || tr('doneSummary'));
      const dismissBtn = h('button', {
        type: 'button',
        'data-action': 'dismiss-terminal',
        'aria-label': tr('dismiss'),
        title: tr('dismiss'),
        style: compactDismissButtonStyle,
        onClick: onDismiss,
      }, '×');
      const leadSpan = h('span', {
        style: { flex: 1, minWidth: 0, wordBreak: 'break-word', color: isErr ? TOKEN_TEXT_ERROR : TOKEN_TEXT_SUCCESS },
      }, isErr ? errMessage : `${doneLabel}${doneDelta}${doneElapsed}`);
      if (!isErr && settledTelemetryItems.length > 0) {
        return h('div', {
          key: 'terminal',
          'data-compaction-section': 'done',
          style: sectionRowStyle(hasPrev, { gap: 3 }),
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, leadSpan, dismissBtn),
          h('div', {
            'data-compaction-telemetry': 'true',
            style: { fontSize: 11, lineHeight: 1.35, color: TOKEN_TEXT_SECONDARY, fontVariantNumeric: 'tabular-nums' },
          }, settledTelemetryItems.join(' · ')),
        );
      }
      return h('div', {
        key: 'terminal',
        'data-compaction-section': isErr ? 'error' : 'done',
        style: { ...(hasPrev ? dividerStyle : {}), display: 'flex', alignItems: 'center', gap: 6 },
      }, leadSpan, dismissBtn);
    }

    function renderBreakerSection({
      tr,
      hasPrev,
      isBypassedActive,
      pressureBreakerAction,
      status,
      actionBusy,
      copiedDiagnostic,
      confirmAction,
      onToggleBypassConfirm,
      onRetry,
      onBypass,
      onCancelConfirm,
      onCopyDiagnostic,
    }) {
      const breakerBusy = actionBusy !== null;
      const canConfirmBypass = !isBypassedActive && pressureBreakerAction !== 'block' && status.breakerBypassed !== true;
      const canRestoreBlock = isBypassedActive && pressureBreakerAction === 'confirm' && status.breakerBypassed === true;
      const details = [
        status.lastFailureCode ? formatTemplate(tr('breakerFailureCode'), { code: status.lastFailureCode }) : null,
        status.lastDiagnosticId ? formatTemplate(tr('breakerDiagnosticId'), { id: status.lastDiagnosticId }) : null,
      ].filter(Boolean);
      const linkStyle = { ...compactButtonStyle, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' };
      return h('div', {
        key: 'breaker',
        'data-breaker-banner': isBypassedActive ? 'bypassed' : 'blocked',
        style: sectionRowStyle(hasPrev, {
          padding: '6px 8px',
          borderRadius: 6,
          border: isBypassedActive ? '1px solid rgba(217, 119, 6, 0.4)' : '1px solid rgba(220, 38, 38, 0.38)',
          background: isBypassedActive ? 'rgba(217, 119, 6, 0.08)' : 'rgba(220, 38, 38, 0.07)',
        }),
      },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 6, flexWrap: 'wrap' } },
          h('div', { style: { flex: 1, minWidth: 160, display: 'flex', flexDirection: 'column', gap: 2 } },
            h('div', { style: { fontWeight: 600, color: isBypassedActive ? TOKEN_TEXT_WARNING : TOKEN_TEXT_ERROR } },
              isBypassedActive ? tr('breakerBypassedTitle') : tr('breakerBlockedTitle')),
            details.length > 0
              ? h('div', {
                  'data-breaker-meta': 'true',
                  style: { fontSize: 11, color: TOKEN_TEXT_SECONDARY, fontVariantNumeric: 'tabular-nums' },
                }, details.join(' · '))
              : null,
            h('div', { 'data-breaker-billing-warning': 'true', style: { fontSize: 11, color: TOKEN_TEXT_SECONDARY } },
              tr('breakerBillingWarning')),
          ),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            'data-action': 'retry-compaction',
            disabled: breakerBusy,
            style: disabledStyle(compactPrimaryButtonStyle, breakerBusy),
            onClick: onRetry,
          }, actionBusy === 'retrying' ? tr('breakerRetrying') : (isBypassedActive ? tr('breakerRetryBypassed') : tr('breakerRetry'))),
          canConfirmBypass
            ? h('button', {
                type: 'button',
                'data-action': 'bypass-breaker',
                disabled: breakerBusy,
                style: disabledStyle(compactButtonStyle, breakerBusy),
                onClick: onToggleBypassConfirm,
              }, tr('breakerBypass'))
            : null,
          canRestoreBlock
            ? h('button', {
                type: 'button',
                'data-action': 'restore-breaker-block',
                disabled: breakerBusy,
                style: disabledStyle(compactButtonStyle, breakerBusy),
                onClick: () => onBypass(false),
              }, tr('breakerRestoreBlock'))
            : null,
          h('button', {
            type: 'button',
            'data-action': 'copy-diagnostic',
            style: compactButtonStyle,
            onClick: onCopyDiagnostic,
          }, copiedDiagnostic ? tr('breakerCopiedDiagnostic') : tr('breakerCopyDiagnostic')),
          h('a', {
            href: ISSUE_REPORT_URL,
            target: '_blank',
            rel: 'noopener noreferrer',
            'data-action': 'report-issue',
            style: linkStyle,
          }, tr('breakerReportIssue')),
        ),
        canConfirmBypass && confirmAction === 'bypass-breaker' && !breakerBusy
          ? renderInlineConfirmBar({
              confirmKey: 'bypass-breaker',
              hintText: tr('breakerBypassConfirmHint'),
              confirmText: tr('breakerBypassConfirm'),
              cancelText: tr('cancel'),
              disabled: breakerBusy,
              onConfirm: () => onBypass(true),
              onCancel: onCancelConfirm,
            })
          : null,
      );
    }

    function renderResumableSection({
      tr,
      hasPrev,
      resumable,
      actionBusy,
      confirmAction,
      onResume,
      onToggleDiscardConfirm,
      onConfirmDiscard,
      onCancelConfirm,
    }) {
      const isMigrationResume = resumable.trigger === 'migration';
      const resumePercent = resumable.overallPercent
        ?? (resumable.initialTotalTokens && resumable.initialTotalTokens > 0 && resumable.completedTokens !== null
          ? clampPercent((resumable.completedTokens / resumable.initialTotalTokens) * 100)
          : 0);
      const resumeDetails = [
        formatTemplate(tr('resumeProgressDetail'), { percent: resumePercent, remaining: resumable.remainingNodes }),
      ];
      if (resumable.status === 'paused_budget') resumeDetails.push(tr('resumePausedBudget'));
      else if (resumable.status === 'paused_failure') resumeDetails.push(tr('resumePausedFailure'));
      if (resumable.canAutoResume === true) resumeDetails.push(tr('resumeAutoHint'));
      const resumeBusy = actionBusy !== null;
      return h('div', {
        key: 'resumable',
        'data-compaction-resumable': resumable.jobId,
        style: sectionRowStyle(hasPrev),
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          h('div', { style: { flex: 1, minWidth: 140, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            h('span', { 'aria-hidden': 'true', style: statusDotStyle(TOKEN_TEXT_WARNING) }),
            h('span', { style: { fontWeight: 600, color: TOKEN_TEXT_PRIMARY } },
              isMigrationResume ? tr('resumeMigrationTitle') : tr('resumeCompactionTitle')),
            h('span', {
              title: resumable.lastErrorMessage || undefined,
              style: { fontSize: 11, color: TOKEN_TEXT_SECONDARY, fontVariantNumeric: 'tabular-nums' },
            }, resumeDetails.join(' · ')),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 } },
            h('button', {
              type: 'button',
              'data-action': 'resume-compaction',
              disabled: resumeBusy,
              style: disabledStyle(compactPrimaryButtonStyle, resumeBusy),
              onClick: onResume,
            }, actionBusy === 'resuming'
              ? tr('resumingAction')
              : (isMigrationResume ? tr('resumeMigrationAction') : tr('resumeCompactionAction'))),
            h('button', {
              type: 'button',
              'data-action': 'discard-resume',
              disabled: resumeBusy,
              style: disabledStyle(compactButtonStyle, resumeBusy),
              onClick: onToggleDiscardConfirm,
            }, actionBusy === 'discarding' ? tr('discardingResume') : tr('discardResume')),
          ),
        ),
        confirmAction === 'discard-resume' && !resumeBusy
          ? renderInlineConfirmBar({
              confirmKey: 'discard-resume',
              hintText: tr('discardResumeConfirmHint'),
              confirmText: tr('discardResumeConfirm'),
              cancelText: tr('cancel'),
              disabled: actionBusy !== null,
              onConfirm: onConfirmDiscard,
              onCancel: onCancelConfirm,
            })
          : null,
      );
    }

    function renderBiliCompatSection({
      tr,
      hasPrev,
      bili,
      isActive,
      actionBusy,
      confirmAction,
      onToggleConvertConfirm,
      onConfirmConvert,
      onCancelConfirm,
    }) {
      const summary = buildBiliSummary(tr, bili);
      const disabledReason = bili.hasOpenTurn
        ? tr('biliWaitOpenTurn')
        : isActive
          ? tr('biliWaitBusy')
          : '';
      const convertDisabled = isActive || bili.hasOpenTurn || bili.canConvert === false;
      return h('div', {
        key: 'bili',
        'data-bili-compat': 'detected',
        style: sectionRowStyle(hasPrev),
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          h('div', { style: { flex: 1, minWidth: 140 } },
            h('span', { style: { fontWeight: 600, color: TOKEN_TEXT_PRIMARY } }, tr('biliDetectedTitle')),
            summary ? h('span', { style: { color: TOKEN_TEXT_SECONDARY } }, ` (${summary})`) : null,
            disabledReason
              ? h('span', { style: { marginLeft: 6, fontSize: 11, color: TOKEN_TEXT_SECONDARY } }, disabledReason)
              : null,
          ),
          h('button', {
            type: 'button',
            'data-action': 'bili-convert',
            disabled: convertDisabled,
            style: disabledStyle(compactPrimaryButtonStyle, convertDisabled),
            onClick: onToggleConvertConfirm,
          }, actionBusy === 'migrating' ? tr('biliConverting') : tr('biliConvert')),
        ),
        confirmAction === 'convert' && !convertDisabled
          ? renderInlineConfirmBar({
              confirmKey: 'bili-convert',
              hintText: tr('biliConvertConfirmHint'),
              confirmText: tr('biliConvertConfirm'),
              cancelText: tr('cancel'),
              disabled: actionBusy !== null,
              onConfirm: onConfirmConvert,
              onCancel: onCancelConfirm,
            })
          : null,
      );
    }

    function renderBackupSection({
      tr,
      hasPrev,
      pendingRestore,
      showRestoredBanner,
      restoreResult,
      effectiveBackupId,
      effectiveBackupPath,
      backupItems,
      backup,
      isActive,
      bili,
      status,
      showServerTerminal,
      migrationReceipt,
      actionBusy,
      copiedPath,
      confirmAction,
      onCopyPath,
      onSelectBackup,
      onToggleRestoreConfirm,
      onConfirmRestore,
      onCancelConfirm,
      onDismissRestored,
      onDismissReceipt,
    }) {
      if (pendingRestore) {
        const pendingPath = pendingRestore.backupPath || effectiveBackupPath;
        return h('div', {
          key: 'pending-restore',
          'data-backup-pending-restore': pendingRestore.backupId,
          style: sectionRowStyle(hasPrev, {
            padding: '6px 8px',
            borderRadius: 6,
            border: '1px solid rgba(217, 119, 6, 0.4)',
            background: 'rgba(217, 119, 6, 0.1)',
            gap: 3,
          }),
        },
          h('div', { style: { fontWeight: 600, color: TOKEN_TEXT_WARNING } },
            formatTemplate(tr('backupRestoreArmed'), { id: pendingRestore.backupId })),
          pendingPath
            ? h('div', { style: { fontSize: 11, color: TOKEN_TEXT_SECONDARY, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' } },
                tr('backupPathLabel'),
                h('code', { 'data-backup-path': 'true', title: pendingPath, style: codePathStyle }, pendingPath),
                h('button', {
                  type: 'button',
                  'data-action': 'copy-backup-path',
                  style: compactMicroButtonStyle,
                  onClick: () => onCopyPath(pendingPath),
                }, copiedPath === pendingPath ? tr('copiedPath') : tr('copyPath')))
            : null,
        );
      }
      if (showRestoredBanner) {
        return h('div', {
          key: 'restored',
          'data-backup-restored': restoreResult.backupId,
          style: { ...(hasPrev ? dividerStyle : {}), display: 'flex', alignItems: 'center', gap: 6 },
        },
          h('span', { style: { flex: 1, color: TOKEN_TEXT_SUCCESS } },
            formatTemplate(tr('backupRestored'), { id: restoreResult.backupId })),
          h('button', {
            type: 'button',
            'data-action': 'dismiss-backup',
            'aria-label': tr('dismiss'),
            title: tr('dismiss'),
            style: compactDismissButtonStyle,
            onClick: onDismissRestored,
          }, '×'),
        );
      }
      const restoreDisabled = isActive || bili?.hasOpenTurn === true;
      const serverOwnsMigrationDone = status.phase === 'done' && status.trigger === 'migration';
      const receiptLead = migrationReceipt && !showServerTerminal && !serverOwnsMigrationDone && !isActive
        ? (migrationReceipt.completed ? tr('biliConvertDone') : tr('biliConvertStarted'))
        : null;
      const sortedBackupItems = backupItems.length > 1
        ? [
            ...backupItems.filter(item => item.isBaseline || item.backupId === backup?.originalBackupId),
            ...backupItems.filter(item => !(item.isBaseline || item.backupId === backup?.originalBackupId)),
          ]
        : backupItems;
      return h('div', {
        key: 'backup-receipt',
        'data-backup-receipt': effectiveBackupId,
        style: sectionRowStyle(hasPrev),
      },
        receiptLead
          ? h('div', { style: { color: TOKEN_TEXT_SUCCESS, fontWeight: 500, fontSize: 11 } }, receiptLead)
          : null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          h('div', { style: { flex: 1, minWidth: 140, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' } },
            h('span', {
              title: effectiveBackupPath || effectiveBackupId,
              style: { color: TOKEN_TEXT_PRIMARY, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
            }, formatTemplate(tr('backupSaved'), { id: effectiveBackupId })),
            effectiveBackupPath
              ? h('code', { 'data-backup-path': 'true', title: effectiveBackupPath, style: codePathStyle }, effectiveBackupPath)
              : null,
            effectiveBackupPath
              ? h('button', {
                  type: 'button',
                  'data-action': 'copy-backup-path',
                  style: compactMicroButtonStyle,
                  onClick: () => onCopyPath(effectiveBackupPath),
                }, copiedPath === effectiveBackupPath ? tr('copiedPath') : tr('copyPath'))
              : null,
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 } },
            sortedBackupItems.length > 1
              ? h('select', {
                  'data-backup-select': 'true',
                  'aria-label': tr('backupSelectLabel'),
                  disabled: restoreDisabled,
                  value: effectiveBackupId,
                  style: disabledStyle(compactSelectStyle, restoreDisabled),
                  onChange: onSelectBackup,
                }, sortedBackupItems.map(item =>
                  h('option', { key: item.backupId, value: item.backupId },
                    formatBackupOptionLabel(tr, item, backup?.originalBackupId)),
                ))
              : null,
            h('button', {
              type: 'button',
              'data-action': 'backup-restore',
              disabled: restoreDisabled,
              style: disabledStyle(compactButtonStyle, restoreDisabled),
              onClick: onToggleRestoreConfirm,
            }, actionBusy === 'restoring' ? tr('backupRestoring') : tr('backupRestore')),
            !isActive
              ? h('button', {
                  type: 'button',
                  'data-action': 'dismiss-backup',
                  'aria-label': tr('dismiss'),
                  title: tr('dismiss'),
                  style: compactDismissButtonStyle,
                  onClick: onDismissReceipt,
                }, '×')
              : null,
          ),
        ),
        confirmAction === 'restore' && !restoreDisabled
          ? renderInlineConfirmBar({
              confirmKey: 'backup-restore',
              hintText: formatTemplate(tr('backupRestoreConfirmHint'), { id: effectiveBackupId }),
              confirmText: tr('backupRestoreConfirm'),
              cancelText: tr('cancel'),
              disabled: actionBusy !== null,
              onConfirm: () => onConfirmRestore(effectiveBackupId),
              onCancel: onCancelConfirm,
            })
          : null,
      );
    }

    function renderArchiveWarningSection({ tr, hasPrev, archiveWarning, onDismiss }) {
      return h('div', {
        key: 'archive-warning',
        'data-archive-warning': 'true',
        style: sectionRowStyle(hasPrev, {
          gap: 3,
          padding: '6px 8px',
          borderRadius: 6,
          border: '1px solid rgba(217, 119, 6, 0.35)',
          background: 'rgba(217, 119, 6, 0.08)',
        }),
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          h('span', { style: { flex: 1, minWidth: 160, fontWeight: 600, fontSize: 12, color: TOKEN_TEXT_WARNING } },
            tr('archiveWarnDockTitle')),
          h('button', {
            type: 'button',
            'data-action': 'dismiss-archive-warning',
            'aria-label': tr('dismiss'),
            title: tr('dismiss'),
            style: compactDismissButtonStyle,
            onClick: onDismiss,
          }, '×'),
        ),
        h('div', { style: { fontSize: 11, color: TOKEN_TEXT_PRIMARY, lineHeight: 1.4 } },
          formatTemplate(tr('archiveWarnDockDetail'), {
            total: formatBytes(archiveWarning.totalBytes),
            warn: formatBytes(archiveWarning.warnBytes),
          })),
        h('div', { style: { fontSize: 11, color: TOKEN_TEXT_SECONDARY, lineHeight: 1.35 } },
          tr('archiveWarnDockNoAutoDelete')),
      );
    }

    async function copyTextToClipboard(text) {
      if (!text) return false;
      try {
        const clipboard = globalThis.navigator?.clipboard;
        if (clipboard && typeof clipboard.writeText === 'function') {
          await clipboard.writeText(text);
          return true;
        }
      } catch {
        // Clipboard access may be unavailable or denied; ignore cleanly.
      }
      return false;
    }

    function deriveProgressCardView({
      status,
      actionBusy,
      actionError,
      dismissedKey,
      dismissedBackupKey,
      biliModalDismissedKey,
      archiveWarnDismissedKey,
      migrationReceipt,
      restoreResult,
      selectedBackupId,
    }) {
      const bili = status.bili;
      const backup = status.backup;
      const resumable = status.resumable;
      const isActive =
        status.active === true ||
        (actionBusy !== null && actionBusy !== 'discarding' && actionBusy !== 'bypassing');
      const pressureBreakerAction = status.pressureBreakerAction || 'confirm';
      const isBypassedActive =
        pressureBreakerAction === 'degrade' ||
        (pressureBreakerAction === 'confirm' && status.breakerBypassed === true);
      const showBreakerRow = !isActive && status.stopped === true;
      const showResumeRow = !isActive && resumable !== null;
      // STRICT visibility gate: bili conversion UI renders ONLY when detected === true,
      // and is suppressed when a resumable migration checkpoint is already shown.
      const showBiliRow = bili?.detected === true && !(showResumeRow && resumable?.trigger === 'migration');

      const terminalKey = !isActive && (status.phase === 'done' || status.phase === 'error')
        ? `${status.runId ?? ''}:${status.phase}:${status.finishedAt ?? status.seq}`
        : '';
      const showServerTerminal = terminalKey !== '' && dismissedKey !== terminalKey;
      const showTerminalRow = showServerTerminal || actionError !== null;
      const hasSettledTelemetry = Boolean(
        !isActive &&
        (!terminalKey || showServerTerminal) &&
        (
          (status.auxCacheReadTokens ?? 0) > 0 ||
          (status.auxReasoningTokens ?? 0) > 0 ||
          (status.reinjectBytes ?? 0) > 0
        ),
      );

      const pendingRestore = backup?.pendingRestore
        ?? (restoreResult?.requiresReopen ? restoreResult : null);
      const showRestoredBanner = !pendingRestore && restoreResult !== null && restoreResult.status === 'restored';

      const backupItems = Array.isArray(backup?.items) ? backup.items : [];
      const serverDefaultBackupId = backup?.originalBackupId ?? backup?.latestBackupId ?? null;
      const defaultBackupId = serverDefaultBackupId ?? migrationReceipt?.backupId ?? null;
      const backupReceiptKey = defaultBackupId
        ? `${backup?.count ?? 1}:${backup?.originalBackupId ?? ''}:${backup?.latestBackupId ?? ''}:${migrationReceipt?.backupId ?? ''}`
        : '';
      const backupNotDismissed = backupReceiptKey !== '' && dismissedBackupKey !== backupReceiptKey;
      const hasBackupContext = Boolean(
        defaultBackupId &&
        backupNotDismissed &&
        (
          migrationReceipt?.backupId ||
          (status.trigger === 'migration' && (isActive || showServerTerminal)) ||
          ((showBiliRow || (showResumeRow && resumable?.trigger === 'migration')) && serverDefaultBackupId) ||
          backupItems.length > 1
        ),
      );
      const validSelectedBackup =
        selectedBackupId &&
        (
          backupItems.some(item => item.backupId === selectedBackupId) ||
          selectedBackupId === backup?.originalBackupId ||
          selectedBackupId === backup?.latestBackupId ||
          selectedBackupId === migrationReceipt?.backupId
        )
          ? selectedBackupId
          : null;
      const effectiveBackupId = hasBackupContext ? (validSelectedBackup ?? defaultBackupId) : null;
      const selectedBackupItem = effectiveBackupId
        ? backupItems.find(item => item.backupId === effectiveBackupId) ?? null
        : null;
      const effectiveBackupPath =
        selectedBackupItem?.backupPath
        ?? (effectiveBackupId && (effectiveBackupId === backup?.originalBackupId || effectiveBackupId === backup?.latestBackupId) ? backup?.backupPath : null)
        ?? (effectiveBackupId && effectiveBackupId === migrationReceipt?.backupId ? migrationReceipt?.backupPath : null)
        ?? backup?.backupPath
        ?? migrationReceipt?.backupPath
        ?? null;
      const showBackupRow = Boolean(pendingRestore || showRestoredBanner || effectiveBackupId);

      const biliConflict = status.biliConflict;
      const showBiliConflict = biliConflict?.detected === true;
      const biliConflictKey = showBiliConflict
        ? `${biliConflict.kind}:${Array.isArray(biliConflict.signals) ? biliConflict.signals.join(',') : ''}:${biliConflict.lastSignalAt ?? ''}`
        : '';
      const showBiliConflictModal = showBiliConflict && biliModalDismissedKey !== biliConflictKey;

      const archiveWarning = status.archiveWarning;
      const archiveWarnKey = archiveWarning
        ? `${archiveWarning.totalBytes}:${archiveWarning.warnBytes}:${archiveWarning.legacyPlainSpanCount}`
        : '';
      const showArchiveWarning = Boolean(archiveWarning && archiveWarnDismissedKey !== archiveWarnKey);

      const activePhase = status.active
        ? status.phase
        : actionBusy === 'migrating'
          ? 'backing_up'
          : actionBusy === 'restoring'
            ? 'restoring'
            : actionBusy === 'resuming'
              ? (resumable?.trigger === 'migration' ? 'migrating' : 'continuing')
              : status.phase;

      const progressAttr = isActive
        ? activePhase
        : showBreakerRow
          ? (isBypassedActive ? 'breaker-bypassed' : 'breaker-blocked')
          : showResumeRow
            ? 'resumable'
            : showBiliRow
              ? 'bili-detected'
              : showBiliConflict
                ? 'bili-conflict'
                : showArchiveWarning
                  ? 'archive-warning'
                  : (hasSettledTelemetry && !terminalKey ? 'telemetry' : status.phase);

      return {
        bili,
        backup,
        resumable,
        isActive,
        pressureBreakerAction,
        isBypassedActive,
        showBreakerRow,
        showResumeRow,
        showBiliRow,
        terminalKey,
        showServerTerminal,
        showTerminalRow,
        hasSettledTelemetry,
        pendingRestore,
        showRestoredBanner,
        backupItems,
        backupReceiptKey,
        effectiveBackupId,
        effectiveBackupPath,
        showBackupRow,
        biliConflict,
        showBiliConflict,
        biliConflictKey,
        showBiliConflictModal,
        archiveWarning,
        archiveWarnKey,
        showArchiveWarning,
        activePhase,
        progressAttr,
        progressPercent: isActive ? computeProgressPercent(status) : null,
        indeterminateStep: Math.floor((status.elapsedMs || 0) / 500) % 4,
      };
    }

    function buildProgressCardSections({
      tr,
      view,
      status,
      actionError,
      actionBusy,
      copiedDiagnostic,
      copiedPath,
      confirmAction,
      cancelBusy,
      migrationReceipt,
      restoreResult,
      telemetryItems,
      settledTelemetryItems = [],
      handlers,
    }) {
      const sections = [];
      if (view.showBiliConflict) {
        sections.push(...renderConflictBannerAndModal({
          tr,
          biliConflict: view.biliConflict,
          biliConflictKey: view.biliConflictKey,
          showBiliConflictModal: view.showBiliConflictModal,
          onReopen: handlers.onReopenBiliModal,
          onDismissModal: handlers.onDismissBiliModal,
        }));
      }
      if (view.isActive) {
        sections.push(renderActiveProgressSection({
          tr,
          status,
          activePhase: view.activePhase,
          progressPercent: view.progressPercent,
          indeterminateStep: view.indeterminateStep,
          telemetryItems,
          cancelBusy,
          onCancel: handlers.onCancel,
        }));
      }
      if (view.showTerminalRow) {
        sections.push(renderTerminalSection({
          tr,
          hasPrev: sections.length > 0,
          actionError,
          status,
          settledTelemetryItems,
          onDismiss: handlers.onDismissTerminal,
        }));
      } else if (!view.isActive && !view.terminalKey && settledTelemetryItems.length > 0) {
        sections.push(
          h('div', {
            key: 'settled-telemetry',
            'data-compaction-section': 'telemetry',
            style: { ...(sections.length > 0 ? dividerStyle : {}), display: 'flex', alignItems: 'center', gap: 6 },
          },
            h('div', {
              'data-compaction-telemetry': 'true',
              style: { fontSize: 11, lineHeight: 1.35, color: TOKEN_TEXT_SECONDARY, fontVariantNumeric: 'tabular-nums' },
            }, settledTelemetryItems.join(' · ')),
          ),
        );
      }
      if (view.showBreakerRow) {
        sections.push(renderBreakerSection({
          tr,
          hasPrev: sections.length > 0,
          isBypassedActive: view.isBypassedActive,
          pressureBreakerAction: view.pressureBreakerAction,
          status,
          actionBusy,
          copiedDiagnostic,
          confirmAction,
          onToggleBypassConfirm: () => handlers.toggleConfirm('bypass-breaker'),
          onRetry: handlers.onRetry,
          onBypass: handlers.onBypass,
          onCancelConfirm: handlers.onCancelConfirm,
          onCopyDiagnostic: handlers.onCopyDiagnostic,
        }));
      }
      if (view.showResumeRow) {
        sections.push(renderResumableSection({
          tr,
          hasPrev: sections.length > 0,
          resumable: view.resumable,
          actionBusy,
          confirmAction,
          onResume: handlers.onResume,
          onToggleDiscardConfirm: () => handlers.toggleConfirm('discard-resume'),
          onConfirmDiscard: handlers.onConfirmDiscard,
          onCancelConfirm: handlers.onCancelConfirm,
        }));
      }
      if (view.showBiliRow) {
        sections.push(renderBiliCompatSection({
          tr,
          hasPrev: sections.length > 0,
          bili: view.bili,
          isActive: view.isActive,
          actionBusy,
          confirmAction,
          onToggleConvertConfirm: () => handlers.toggleConfirm('convert'),
          onConfirmConvert: handlers.onConfirmConvert,
          onCancelConfirm: handlers.onCancelConfirm,
        }));
      }
      if (view.showBackupRow) {
        sections.push(renderBackupSection({
          tr,
          hasPrev: sections.length > 0,
          pendingRestore: view.pendingRestore,
          showRestoredBanner: view.showRestoredBanner,
          restoreResult,
          effectiveBackupId: view.effectiveBackupId,
          effectiveBackupPath: view.effectiveBackupPath,
          backupItems: view.backupItems,
          backup: view.backup,
          isActive: view.isActive,
          bili: view.bili,
          status,
          showServerTerminal: view.showServerTerminal,
          migrationReceipt,
          actionBusy,
          copiedPath,
          confirmAction,
          onCopyPath: handlers.onCopyPath,
          onSelectBackup: handlers.onSelectBackup,
          onToggleRestoreConfirm: () => handlers.toggleConfirm('restore'),
          onConfirmRestore: handlers.onConfirmRestore,
          onCancelConfirm: handlers.onCancelConfirm,
          onDismissRestored: handlers.onDismissRestored,
          onDismissReceipt: handlers.onDismissReceipt,
        }));
      }
      if (view.showArchiveWarning) {
        sections.push(renderArchiveWarningSection({
          tr,
          hasPrev: sections.length > 0,
          archiveWarning: view.archiveWarning,
          onDismiss: handlers.onDismissArchiveWarning,
        }));
      }
      return sections;
    }

    /**
     * Composer-dock card (`conversation.input.dock`) showing:
     * 1. Live compaction / migration progress (phase, progress bar, wave/chunk/page,
     *    attempt, model, concurrency/rate-limit chip, token delta, masked count,
     *    stream liveness, elapsed timer, and cancellable Pause button).
     * 2. Resumable interrupted compaction / migration banner (Scheme A) with
     *    Continue + 2-step Discard confirmation.
     * 3. Strictly conditional billion-context compatibility conversion row
     *    (rendered ONLY when `status.bili?.detected === true` and not superseded by
     *    a resumable migration checkpoint) with inline 2-step confirmation.
     * 4. Post-conversion backup receipt + copy path + inline 2-step restore + restart banner.
     *
     * Uses adaptive chained `setTimeout` polling (500ms active / 3000ms idle,
     * paused when hidden) over the single `/plugins/dsh-compaction-weave/rpc`
     * route, and ONLY React `{ createElement, useState, useEffect }`.
     */
    function createCompactionProgressCard(boundT) {
      return function CompactionProgressCard(props) {
        const sessionId =
          typeof props?.sessionId === 'string' && props.sessionId
            ? props.sessionId
            : typeof props?.session?.id === 'string' && props.session.id
              ? props.session.id
              : '';
        const [status, setStatus] = React.useState(EMPTY_STATUS);
        const [confirmAction, setConfirmAction] = React.useState(null); // null | 'convert' | 'restore' | 'discard-resume' | 'bypass-breaker'
        const [actionBusy, setActionBusy] = React.useState(null); // null | 'migrating' | 'restoring' | 'resuming' | 'discarding' | 'retrying' | 'bypassing'
        const [cancelBusy, setCancelBusy] = React.useState(false);
        const [copiedPath, setCopiedPath] = React.useState('');
        const [copiedDiagnostic, setCopiedDiagnostic] = React.useState(false);
        const [actionError, setActionError] = React.useState(null);
        const [migrationReceipt, setMigrationReceipt] = React.useState(null);
        const [restoreResult, setRestoreResult] = React.useState(null);
        const [selectedBackupId, setSelectedBackupId] = React.useState(null);
        const [dismissedKey, setDismissedKey] = React.useState('');
        const [dismissedBackupKey, setDismissedBackupKey] = React.useState('');
        const [biliModalDismissedKey, setBiliModalDismissedKey] = React.useState('');
        const [archiveWarnDismissedKey, setArchiveWarnDismissedKey] = React.useState('');
        const [pollNonce, setPollNonce] = React.useState(0);

        React.useEffect(() => {
          setStatus(EMPTY_STATUS);
          setConfirmAction(null);
          setActionBusy(null);
          setCancelBusy(false);
          setCopiedPath('');
          setCopiedDiagnostic(false);
          setActionError(null);
          setMigrationReceipt(null);
          setRestoreResult(null);
          setSelectedBackupId(null);
          setDismissedKey('');
          setDismissedBackupKey('');
          setBiliModalDismissedKey('');
        }, [sessionId]);

        React.useEffect(() => {
          if (!copiedPath) return undefined;
          const timer = setTimeout(() => setCopiedPath(''), 1800);
          return () => clearTimeout(timer);
        }, [copiedPath]);

        React.useEffect(() => {
          if (!copiedDiagnostic) return undefined;
          const timer = setTimeout(() => setCopiedDiagnostic(false), 1800);
          return () => clearTimeout(timer);
        }, [copiedDiagnostic]);

        React.useEffect(() => {
          if (sessionId === '') return undefined;
          let alive = true;
          let timer = null;
          let inFlight = false;
          let lastActive = false;

          const clearTimer = () => {
            if (timer !== null) {
              clearTimeout(timer);
              timer = null;
            }
          };

          const schedule = delayMs => {
            clearTimer();
            if (!alive || isPageHidden()) return;
            timer = setTimeout(() => {
              timer = null;
              void tick();
            }, delayMs);
          };

          const tick = async () => {
            if (!alive || inFlight || isPageHidden()) return;
            inFlight = true;
            try {
              const response = await fetch(RPC_PATH, {
                method: 'POST',
                headers: buildRpcHeaders(),
                credentials: 'same-origin',
                body: JSON.stringify({ method: 'status', params: { sessionId } }),
              });
              const text = await response.text();
              const payload = text === '' ? null : JSON.parse(text);
              if (!alive) return;
              if (payload?.ok === true && payload.value) {
                const next = normalizeStatus(payload.value);
                lastActive = next.active;
                setStatus(previous => (statusChanged(previous, next) ? next : previous));
              }
            } catch {
              // Host unreachable: retain last snapshot instead of flashing.
            } finally {
              inFlight = false;
              if (alive) {
                const busyActive = actionBusy !== null && actionBusy !== 'discarding';
                schedule(lastActive || busyActive ? ACTIVE_POLL_MS : IDLE_POLL_MS);
              }
            }
          };

          const onVisibilityChange = () => {
            if (!alive) return;
            if (isPageHidden()) {
              clearTimer();
            } else {
              clearTimer();
              void tick();
            }
          };

          const doc = globalThis.document;
          if (doc && typeof doc.addEventListener === 'function') {
            doc.addEventListener('visibilitychange', onVisibilityChange);
          }

          void tick();

          return () => {
            alive = false;
            clearTimer();
            if (doc && typeof doc.removeEventListener === 'function') {
              doc.removeEventListener('visibilitychange', onVisibilityChange);
            }
          };
        }, [sessionId, actionBusy, pollNonce]);

        const tr = typeof props?.t === 'function' ? props.t : boundT;
        const view = deriveProgressCardView({
          status,
          actionBusy,
          actionError,
          dismissedKey,
          dismissedBackupKey,
          biliModalDismissedKey,
          archiveWarnDismissedKey,
          migrationReceipt,
          restoreResult,
          selectedBackupId,
        });
        if (
          !view.isActive &&
          !view.showBreakerRow &&
          !view.showResumeRow &&
          !view.showBiliRow &&
          !view.showTerminalRow &&
          !view.hasSettledTelemetry &&
          !view.showBackupRow &&
          !view.showBiliConflict &&
          !view.showArchiveWarning
        ) {
          return null;
        }

        const telemetryItems = view.isActive ? buildTelemetryItems(tr, status) : [];
        const settledTelemetryItems = !view.isActive && view.hasSettledTelemetry
          ? buildAuxAndReinjectTelemetry(tr, status)
          : [];

        async function runDockAction(busyKey, errorKey, task, beforeStart) {
          if (!sessionId || actionBusy !== null) return;
          setActionBusy(busyKey);
          setConfirmAction(null);
          setActionError(null);
          if (beforeStart) beforeStart();
          try {
            await task();
          } catch (error) {
            setActionError(formatTemplate(tr(errorKey), { error: error?.message ?? String(error) }));
          } finally {
            setActionBusy(null);
            setPollNonce(n => n + 1);
          }
        }

        async function handleCancelCompaction() {
          if (!sessionId || cancelBusy) return;
          setCancelBusy(true);
          setActionError(null);
          try {
            await rpc('cancel-compaction', { sessionId });
          } catch (error) {
            setActionError(formatTemplate(tr('cancelFailed'), { error: error?.message ?? String(error) }));
          } finally {
            setCancelBusy(false);
            setPollNonce(n => n + 1);
          }
        }

        const handleResumeCompaction = () =>
          runDockAction('resuming', 'resumeFailed', () => rpc('resume-compaction', { sessionId }));
        const handleConfirmDiscardResume = () =>
          runDockAction('discarding', 'discardResumeFailed', () => rpc('discard-resume', { sessionId, confirmDiscard: true }));
        const handleRetryCompaction = () =>
          runDockAction('retrying', 'breakerRetryFailed', () => rpc('retry-compaction', { sessionId }));

        const handleBypassBreaker = (bypass) =>
          runDockAction('bypassing', 'breakerBypassFailed', async () => {
            const params = bypass
              ? { sessionId, bypass: true, confirmBypass: true }
              : { sessionId, bypass: false };
            const updated = await rpc('bypass-breaker', params);
            if (updated && typeof updated === 'object') {
              setStatus(previous => {
                const next = normalizeStatus({ ...previous, ...updated, breaker: updated });
                return statusChanged(previous, next) ? next : previous;
              });
            }
          });

        const handleConfirmConvert = () =>
          runDockAction(
            'migrating',
            'biliConvertFailed',
            async () => {
              const result = await rpc('bili-migrate', { sessionId, confirmIrreversible: true });
              const backupId = typeof result?.backupId === 'string' && result.backupId ? result.backupId : null;
              const backupPath = typeof result?.backupPath === 'string' && result.backupPath ? result.backupPath : null;
              if (backupId || backupPath || result?.accepted) {
                setMigrationReceipt({
                  backupId,
                  backupPath,
                  completed: result?.completed !== false,
                  beforeTokens: positiveInt(result?.beforeTokens),
                  afterTokens: positiveInt(result?.afterTokens),
                });
              }
            },
            () => {
              setRestoreResult(null);
              setSelectedBackupId(null);
              setDismissedBackupKey('');
            },
          );

        const handleConfirmRestore = (backupId) => {
          if (!backupId) return undefined;
          return runDockAction('restoring', 'backupRestoreFailed', async () => {
            const result = await rpc('backup-restore', { sessionId, backupId, confirmRestore: true });
            setRestoreResult({
              status: typeof result?.status === 'string' ? result.status : (result?.requiresReopen ? 'armed' : 'restored'),
              requiresReopen: result?.requiresReopen === true || result?.status === 'armed',
              backupId: typeof result?.backupId === 'string' && result.backupId ? result.backupId : backupId,
              backupPath: typeof result?.backupPath === 'string' ? result.backupPath : view.effectiveBackupPath,
              targetPath: typeof result?.targetPath === 'string' ? result.targetPath : null,
            });
          });
        };

        async function handleCopyPath(path) {
          if (await copyTextToClipboard(path)) setCopiedPath(path);
        }

        async function handleCopyDiagnostic() {
          const text = JSON.stringify({
            pluginVersion: status.pluginVersion ?? null,
            lastFailureCode: status.lastFailureCode ?? null,
            lastDiagnosticId: status.lastDiagnosticId ?? null,
            lastDiagnosticPath: status.lastDiagnosticPath ?? null,
          }, null, 2);
          if (await copyTextToClipboard(text)) setCopiedDiagnostic(true);
        }

        const sections = buildProgressCardSections({
          tr,
          view,
          status,
          actionError,
          actionBusy,
          copiedDiagnostic,
          copiedPath,
          confirmAction,
          cancelBusy,
          migrationReceipt,
          restoreResult,
          telemetryItems,
          settledTelemetryItems,
          handlers: {
            toggleConfirm: key => setConfirmAction(current => (current === key ? null : key)),
            onReopenBiliModal: () => setBiliModalDismissedKey(''),
            onDismissBiliModal: setBiliModalDismissedKey,
            onCancel: () => void handleCancelCompaction(),
            onDismissTerminal: () => {
              setActionError(null);
              if (view.terminalKey) setDismissedKey(view.terminalKey);
            },
            onRetry: () => void handleRetryCompaction(),
            onBypass: bypass => void handleBypassBreaker(bypass),
            onCancelConfirm: () => setConfirmAction(null),
            onCopyDiagnostic: () => void handleCopyDiagnostic(),
            onResume: () => void handleResumeCompaction(),
            onConfirmDiscard: () => void handleConfirmDiscardResume(),
            onConfirmConvert: () => void handleConfirmConvert(),
            onCopyPath: path => void handleCopyPath(path),
            onSelectBackup: event => {
              setSelectedBackupId(event.target.value);
              setConfirmAction(null);
            },
            onConfirmRestore: id => void handleConfirmRestore(id),
            onDismissRestored: () => {
              setRestoreResult(null);
              setMigrationReceipt(null);
            },
            onDismissReceipt: () => {
              setConfirmAction(null);
              setMigrationReceipt(null);
              if (view.backupReceiptKey) setDismissedBackupKey(view.backupReceiptKey);
              if (view.terminalKey) setDismissedKey(view.terminalKey);
            },
            onDismissArchiveWarning: () => setArchiveWarnDismissedKey(view.archiveWarnKey),
          },
        });

        return h('div', {
          role: 'status',
          'aria-live': 'polite',
          'data-compaction-progress': view.progressAttr,
          style: {
            width: 'calc(100% - 2 * var(--dsh-composer-side-clearance, 16px))',
            maxWidth: 'var(--dsh-composer-card-max-width, 760px)',
            margin: '0 auto',
            alignSelf: 'center',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
            padding: '6px 10px',
            borderRadius: 8,
            border: `1px solid ${TOKEN_BORDER_1}`,
            background: TOKEN_SURFACE_1,
            color: TOKEN_TEXT_PRIMARY,
            fontSize: 12,
            lineHeight: 1.35,
          },
        }, sections);
      };
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '5px 8px',
      borderRadius: 6,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: TOKEN_BORDER_2,
      background: TOKEN_SURFACE_1,
      color: TOKEN_TEXT_PRIMARY,
      fontSize: 12,
      lineHeight: 1.4,
      fontFamily: 'inherit',
    };
    const labelStyle = {
      display: 'block',
      fontSize: 11,
      fontWeight: 600,
      color: TOKEN_TEXT_SECONDARY,
      lineHeight: 1.3,
      marginBottom: 2,
    };
    const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 };
    const row2Style = {
      display: 'grid',
      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
      gap: 10,
      alignItems: 'start',
    };
    const buttonStyle = {
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: TOKEN_BORDER_2,
      borderRadius: 6,
      padding: '6px 12px',
      fontSize: 12,
      lineHeight: 1.4,
      fontFamily: 'inherit',
      cursor: 'pointer',
      background: TOKEN_SECONDARY_BG,
      color: TOKEN_TEXT_PRIMARY,
    };
    const primaryStyle = {
      ...buttonStyle,
      background: TOKEN_PRIMARY_BG,
      borderColor: 'transparent',
      color: TOKEN_PRIMARY_FG,
    };
    const mutedStyle = {
      color: TOKEN_TEXT_SECONDARY,
      fontSize: 11,
      lineHeight: 1.35,
      margin: 0,
    };

    const MB = 1024 * 1024;
    const INITIAL_SETTINGS_FORM = Object.freeze({
      provider: '',
      model: '',
      maxTokens: '',
      thresholdRatio: 80,
      minimumReductionRatio: 20,
      retryCount: '2',
      retryDelay: '1',
      summaryTimeout: '180',
      summaryConcurrency: '2',
      summaryReasoningEffort: 'auto',
      summaryCjkTokensPerChar: '0.75',
      idlePreset: '0',
      idleCustomMinutes: '',
      auditBlockOnLoss: true,
      auditCoverageScope: 'recent',
      auditExhaustionPolicy: 'fallback',
      pressureBreakerAction: 'confirm',
      postCompactReinjectEnabled: true,
      observationMaskingEnabled: true,
      persistedOutputEnabled: true,
      microcompactEnabled: true,
      sessionMemoryEnabled: false,
      sessionMemoryMaxCalls: '8',
      contextCollapseEnabled: false,
      snipEnabled: true,
      archiveWarnMb: '512',
      maxVisibleAttachmentMb: '16',
      maxVisibleImagesCount: '24',
    });

    const TOUCHED_SUBMIT_SPECS = Object.freeze([
      ['auditCoverageScope', 'auditCoverageScope', v => v],
      ['auditExhaustionPolicy', 'auditExhaustionPolicy', v => v],
      ['summaryConcurrency', 'summaryConcurrency', v => Number(v)],
      ['summaryReasoningEffort', 'summaryReasoningEffort', v => v],
      ['summaryCjkTokensPerChar', 'summaryCjkTokensPerChar', v => Math.round(Number(v) * 100) / 100],
      ['pressureBreakerAction', 'pressureBreakerAction', v => v],
      ['postCompactReinjectEnabled', 'postCompactReinjectEnabled', v => Boolean(v)],
      ['observationMaskingEnabled', 'observationMaskingEnabled', v => Boolean(v)],
      ['persistedOutputEnabled', 'persistedOutputEnabled', v => Boolean(v)],
      ['microcompactEnabled', 'microcompactEnabled', v => Boolean(v)],
      ['sessionMemoryEnabled', 'sessionMemoryEnabled', v => Boolean(v)],
      ['sessionMemoryMaxCalls', 'sessionMemoryMaxCallsPerSession', v => Number(v)],
      ['contextCollapseEnabled', 'contextCollapseEnabled', v => Boolean(v)],
      ['snipEnabled', 'snipEnabled', v => Boolean(v)],
      ['archiveWarnMb', 'archiveWarnBytes', v => Number(String(v).trim()) * MB],
      ['maxVisibleAttachmentMb', 'maxVisibleAttachmentBytes', v => Number(String(v).trim()) * MB],
      ['maxVisibleImagesCount', 'maxVisibleImages', v => Number(String(v).trim())],
    ]);

    const POLICY_SELECT_SPECS = Object.freeze([
      {
        key: 'auditBlockOnLoss',
        id: 'weave-audit-block-on-loss',
        labelKey: 'auditBlockOnLoss',
        hintKey: 'auditBlockOnLossHint',
        kind: 'boolean',
        touchedGated: false,
        useHintId: false,
        onKey: 'auditBlockOnLossOn',
        offKey: 'auditBlockOnLossOff',
      },
      {
        key: 'auditCoverageScope',
        id: 'weave-audit-coverage-scope',
        labelKey: 'auditCoverageScope',
        hintKey: 'auditCoverageScopeHint',
        kind: 'enum',
        touchedGated: true,
        useHintId: true,
        values: AUDIT_COVERAGE_SCOPES,
        optionKeys: {
          recent: 'auditCoverageScopeRecent',
          'span-new': 'auditCoverageScopeSpanNew',
          all: 'auditCoverageScopeAll',
        },
      },
      {
        key: 'auditExhaustionPolicy',
        id: 'weave-audit-exhaustion-policy',
        labelKey: 'auditExhaustionPolicy',
        hintKey: 'auditExhaustionPolicyHint',
        kind: 'enum',
        touchedGated: true,
        useHintId: false,
        values: AUDIT_EXHAUSTION_POLICIES,
        optionKeys: { fallback: 'auditExhaustionFallback', block: 'auditExhaustionBlock' },
      },
      {
        key: 'pressureBreakerAction',
        id: 'weave-pressure-breaker-action',
        labelKey: 'pressureBreakerAction',
        hintKey: 'pressureBreakerActionHint',
        kind: 'enum',
        touchedGated: true,
        useHintId: false,
        values: PRESSURE_BREAKER_ACTIONS,
        optionKeys: { confirm: 'pressureBreakerConfirm', degrade: 'pressureBreakerDegrade', block: 'pressureBreakerBlock' },
      },
      {
        key: 'postCompactReinjectEnabled',
        id: 'weave-post-compact-reinject',
        labelKey: 'postCompactReinject',
        hintKey: 'postCompactReinjectHint',
        kind: 'boolean',
        touchedGated: true,
        useHintId: false,
        onKey: 'postCompactReinjectOn',
        offKey: 'postCompactReinjectOff',
      },
      {
        key: 'observationMaskingEnabled',
        id: 'weave-observation-masking',
        labelKey: 'observationMasking',
        hintKey: 'observationMaskingHint',
        kind: 'boolean',
        touchedGated: true,
        useHintId: true,
        onKey: 'observationMaskingOn',
        offKey: 'observationMaskingOff',
      },
      {
        key: 'persistedOutputEnabled',
        id: 'weave-persisted-output',
        labelKey: 'persistedOutput',
        hintKey: 'persistedOutputHint',
        kind: 'boolean',
        touchedGated: true,
        useHintId: true,
        onKey: 'persistedOutputOn',
        offKey: 'persistedOutputOff',
      },
      {
        key: 'microcompactEnabled',
        id: 'weave-microcompact',
        labelKey: 'microcompact',
        hintKey: 'microcompactHint',
        kind: 'boolean',
        touchedGated: true,
        useHintId: true,
        onKey: 'microcompactOn',
        offKey: 'microcompactOff',
      },
      {
        key: 'snipEnabled',
        id: 'weave-snip',
        labelKey: 'snip',
        hintKey: 'snipHint',
        kind: 'boolean',
        touchedGated: true,
        useHintId: true,
        onKey: 'snipOn',
        offKey: 'snipOff',
      },
    ]);

    const ARCHIVE_NUMBER_FIELDS = Object.freeze([
      {
        key: 'archiveWarnMb',
        id: 'weave-archive-warn-mb',
        dataField: 'archiveWarnMb',
        min: 0,
        max: 102400,
        step: 1,
        labelKey: 'archiveWarnMb',
        hintKey: 'archiveWarnMbHint',
        hintId: 'weave-archive-warn-mb-hint',
      },
      {
        key: 'maxVisibleAttachmentMb',
        id: 'weave-max-visible-attachment-mb',
        dataField: 'maxVisibleAttachmentMb',
        min: 0,
        max: 1024,
        step: 1,
        labelKey: 'maxVisibleAttachmentMb',
        hintKey: 'maxVisibleAttachmentMbHint',
        hintId: 'weave-max-visible-attachment-mb-hint',
      },
      {
        key: 'maxVisibleImagesCount',
        id: 'weave-max-visible-images',
        dataField: 'maxVisibleImages',
        min: 0,
        max: 500,
        step: 1,
        labelKey: 'maxVisibleImages',
        hintKey: 'maxVisibleImagesHint',
        hintId: 'weave-max-visible-images-hint',
      },
    ]);

    const CJK_WEIGHT_PRESETS = Object.freeze([
      ['0.75', 'summaryCjkWeight075'],
      ['0.85', 'summaryCjkWeight085'],
      ['1', 'summaryCjkWeight10'],
      ['1.25', 'summaryCjkWeight125'],
    ]);

    const SERVER_SYNC_DEFAULTS = Object.freeze([
      ['observationMaskingEnabled', true],
      ['persistedOutputEnabled', true],
      ['microcompactEnabled', true],
      ['sessionMemoryEnabled', false],
      ['contextCollapseEnabled', false],
      ['snipEnabled', true],
    ]);

    function decodeMbSetting(rawBytes, defaultMb) {
      if (Number.isInteger(rawBytes) && rawBytes >= 0) {
        const mb = rawBytes === 0 ? 0 : Math.max(1, Math.round(rawBytes / MB));
        return { value: String(mb), touched: rawBytes === 0 || rawBytes % MB === 0 };
      }
      return { value: String(defaultMb), touched: false };
    }

    function decodeServerSubset(config) {
      const values = {};
      const touched = {};
      for (const [key, fallback] of SERVER_SYNC_DEFAULTS) {
        const hasVal = typeof config?.[key] === 'boolean';
        values[key] = hasVal ? config[key] : fallback;
        touched[key] = hasVal;
      }
      const rawCalls = config?.sessionMemoryMaxCallsPerSession;
      const hasCalls = Number.isInteger(rawCalls) && rawCalls >= 1 && rawCalls <= 100;
      values.sessionMemoryMaxCalls = String(hasCalls ? rawCalls : 8);
      touched.sessionMemoryMaxCalls = hasCalls;

      const warnDecoded = decodeMbSetting(config?.archiveWarnBytes, 512);
      values.archiveWarnMb = warnDecoded.value;
      touched.archiveWarnMb = warnDecoded.touched;

      const imgMbDecoded = decodeMbSetting(config?.maxVisibleAttachmentBytes, 16);
      values.maxVisibleAttachmentMb = imgMbDecoded.value;
      touched.maxVisibleAttachmentMb = imgMbDecoded.touched;

      const rawImgCount = config?.maxVisibleImages;
      const hasImgCount = Number.isInteger(rawImgCount) && rawImgCount >= 0 && rawImgCount <= 500;
      values.maxVisibleImagesCount = String(hasImgCount ? rawImgCount : 24);
      touched.maxVisibleImagesCount = hasImgCount;

      const rawCjkWeight = config?.summaryCjkTokensPerChar;
      const hasCjkWeight =
        typeof rawCjkWeight === 'number' &&
        Number.isFinite(rawCjkWeight) &&
        rawCjkWeight >= 0.5 &&
        rawCjkWeight <= 1.5;
      values.summaryCjkTokensPerChar = String(hasCjkWeight ? Math.round(rawCjkWeight * 100) / 100 : 0.75);
      touched.summaryCjkTokensPerChar = hasCjkWeight;

      const hasCoverageScope = AUDIT_COVERAGE_SCOPES.includes(config?.auditCoverageScope);
      values.auditCoverageScope = hasCoverageScope ? config.auditCoverageScope : 'recent';
      touched.auditCoverageScope = hasCoverageScope;

      return { values, touched };
    }

    function decodeFullLoadedConfig(prevForm, config) {
      const sub = decodeServerSubset(config);
      const idle = String(config?.idleCompactionMinutes ?? 0);
      const isPresetIdle = IDLE_PRESETS.includes(idle);
      const hasExhaustion = AUDIT_EXHAUSTION_POLICIES.includes(config?.auditExhaustionPolicy);
      const hasBreaker = PRESSURE_BREAKER_ACTIONS.includes(config?.pressureBreakerAction);
      const hasReinject = typeof config?.postCompactReinjectEnabled === 'boolean';
      const hasConcurrency = Number.isInteger(config?.summaryConcurrency) && config.summaryConcurrency >= 1 && config.summaryConcurrency <= 6;
      const hasReasoning = SUMMARY_REASONING_EFFORTS.includes(config?.summaryReasoningEffort);

      const nextForm = {
        ...prevForm,
        ...sub.values,
        idlePreset: isPresetIdle ? idle : 'custom',
        idleCustomMinutes: isPresetIdle ? '' : idle,
        auditBlockOnLoss: typeof config?.auditBlockOnLoss === 'boolean' ? config.auditBlockOnLoss : true,
        auditExhaustionPolicy: hasExhaustion ? config.auditExhaustionPolicy : 'fallback',
        pressureBreakerAction: hasBreaker ? config.pressureBreakerAction : 'confirm',
        postCompactReinjectEnabled: hasReinject ? config.postCompactReinjectEnabled : true,
        summaryConcurrency: String(hasConcurrency ? config.summaryConcurrency : 2),
        summaryReasoningEffort: hasReasoning ? config.summaryReasoningEffort : 'auto',
      };
      if (config) {
        nextForm.retryCount = String(config.summaryRetryCount ?? 2);
        nextForm.retryDelay = String((config.summaryRetryDelayMs ?? 1000) / 1000);
        nextForm.summaryTimeout = String((config.summaryTimeoutMs ?? 180000) / 1000);
        nextForm.provider = config.provider ?? '';
        nextForm.model = config.model ?? '';
        nextForm.maxTokens = config.maxTokens === null || config.maxTokens === undefined ? '' : String(config.maxTokens);
        nextForm.thresholdRatio = typeof config.thresholdRatio === 'number' ? Math.round(config.thresholdRatio * 100) : 80;
        nextForm.minimumReductionRatio = typeof config.minimumReductionRatio === 'number' ? Math.round(config.minimumReductionRatio * 100) : 20;
      }
      const nextTouched = {
        ...sub.touched,
        auditExhaustionPolicy: hasExhaustion,
        pressureBreakerAction: hasBreaker,
        postCompactReinjectEnabled: hasReinject,
        summaryConcurrency: hasConcurrency,
        summaryReasoningEffort: hasReasoning,
      };
      return { form: nextForm, touched: nextTouched };
    }

    function isValidIntFieldText(rawText, min, max, requireDigitsOnly) {
      const text = String(rawText ?? '').trim();
      if (text === '') return false;
      if (requireDigitsOnly && !/^\d+$/.test(text)) return false;
      const n = Number(text);
      return Number.isInteger(n) && n >= min && n <= max;
    }

    function validateSettingsForm(form, clear, t) {
      const idleText = String(form.idlePreset === 'custom' ? form.idleCustomMinutes : form.idlePreset).trim();
      if (
        !isValidIntFieldText(idleText, form.idlePreset === 'custom' ? 1 : 0, MAX_IDLE_COMPACTION_MINUTES, true) ||
        (form.idlePreset !== 'custom' && !IDLE_PRESETS.includes(form.idlePreset))
      ) return t('idleRange');
      if (!isValidIntFieldText(form.retryCount, 0, 4, false)) return t('retryCountRange');
      const retryDelayText = String(form.retryDelay).trim();
      const delay = /^\d+(?:\.\d{1,3})?$/.test(retryDelayText)
        ? Math.round(Number(retryDelayText) * 1000)
        : NaN;
      if (!Number.isInteger(delay) || delay < 0 || delay > 30000) return t('retryDelayRange');
      const timeoutText = String(form.summaryTimeout).trim();
      const timeout = Number(timeoutText) * 1000;
      if (timeoutText === '' || !Number.isInteger(timeout) || timeout < 5000 || timeout > 3600000) return t('summaryTimeoutRange');
      if (!isValidIntFieldText(form.summaryConcurrency, 1, 6, true)) return t('concurrencyRange');
      if (!isValidIntFieldText(form.sessionMemoryMaxCalls, 1, 100, true)) return t('sessionMemoryMaxCallsRange');
      if (!isValidIntFieldText(form.archiveWarnMb, 0, 102400, true)) return t('archiveWarnMbRange');
      if (!isValidIntFieldText(form.maxVisibleAttachmentMb, 0, 1024, true)) return t('maxVisibleAttachmentMbRange');
      if (!isValidIntFieldText(form.maxVisibleImagesCount, 0, 500, true)) return t('maxVisibleImagesRange');
      if (!SUMMARY_REASONING_EFFORTS.includes(form.summaryReasoningEffort)) return t('reasoningEffortRange');
      const cjkWeightText = String(form.summaryCjkTokensPerChar ?? '').trim();
      const cjkWeightNum = Number(cjkWeightText);
      if (cjkWeightText === '' || !Number.isFinite(cjkWeightNum) || cjkWeightNum < 0.5 || cjkWeightNum > 1.5) {
        return t('summaryCjkTokensPerCharRange');
      }
      if (!AUDIT_COVERAGE_SCOPES.includes(form.auditCoverageScope)) return t('auditCoverageScopeRange');
      if (!AUDIT_EXHAUSTION_POLICIES.includes(form.auditExhaustionPolicy)) return t('auditExhaustionPolicyRange');
      if (!PRESSURE_BREAKER_ACTIONS.includes(form.pressureBreakerAction)) return t('pressureBreakerActionRange');
      const p = form.provider.trim();
      const m = form.model.trim();
      if (!clear && (p === '') !== (m === '')) return t('pair');
      if (!Number.isInteger(form.thresholdRatio) || form.thresholdRatio < 50 || form.thresholdRatio > 95) return t('triggerRange');
      if (!Number.isInteger(form.minimumReductionRatio) || form.minimumReductionRatio < 5 || form.minimumReductionRatio > 90) return t('reductionRange');
      const v = form.maxTokens.trim();
      if (!clear && v !== '' && !isValidIntFieldText(v, 1, 1_000_000, false)) return t('badMax');
      return null;
    }

    function buildSettingsRpcParams(form, touched, clear) {
      const params = clear
        ? {
            provider: '',
            model: '',
            maxTokens: null,
            thresholdRatio: form.thresholdRatio / 100,
            minimumReductionRatio: form.minimumReductionRatio / 100,
          }
        : {
            provider: form.provider.trim(),
            model: form.model.trim(),
            maxTokens: form.maxTokens.trim() === '' ? null : Number(form.maxTokens),
            thresholdRatio: form.thresholdRatio / 100,
            minimumReductionRatio: form.minimumReductionRatio / 100,
          };
      Object.assign(params, {
        summaryRetryCount: Number(form.retryCount),
        summaryRetryDelayMs: Math.round(Number(String(form.retryDelay).trim()) * 1000),
        summaryTimeoutMs: Number(form.summaryTimeout) * 1000,
        idleCompactionMinutes: Number(form.idlePreset === 'custom' ? form.idleCustomMinutes : form.idlePreset),
        auditBlockOnLoss: Boolean(form.auditBlockOnLoss),
      });
      for (const [formKey, paramKey, transform] of TOUCHED_SUBMIT_SPECS) {
        if (touched[formKey]) params[paramKey] = transform(form[formKey]);
      }
      return params;
    }

    function buildCatalogSelectOptions(catalog, provider, model, maxTokens, t) {
      const providerOptions = [{ value: '', label: t('followSession') }];
      for (const entry of catalog) {
        const id = String(entry?.provider ?? '');
        if (id === '') continue;
        providerOptions.push({ value: id, label: entry.name && entry.name !== id ? `${entry.name} (${id})` : id });
      }
      if (provider && !providerOptions.some(option => option.value === provider)) {
        providerOptions.push({ value: provider, label: `${provider} (${t('notInCatalog')})` });
      }
      const selectedProvider = catalog.find(entry => entry?.provider === provider);
      const modelOptions = [];
      for (const entry of selectedProvider?.models ?? []) {
        const id = String(entry?.id ?? '');
        if (id === '') continue;
        modelOptions.push({ value: id, label: entry.name && entry.name !== id ? `${entry.name} (${id})` : id });
      }
      if (model && !modelOptions.some(option => option.value === model)) {
        modelOptions.push({ value: model, label: `${model} (${t('notInCatalog')})` });
      }
      const maxTokenValues = ['8192', '16384', '32768', '65536', '131072'];
      const maxOptions = [{ value: '', label: t('defaultMax') }, ...maxTokenValues.map(value => ({ value, label: value }))];
      if (maxTokens && !maxOptions.some(option => option.value === maxTokens)) {
        maxOptions.push({ value: maxTokens, label: maxTokens });
      }
      return { providerOptions, modelOptions, maxOptions };
    }

    function renderSelectControl({ id, label, value, options, emptyOption, disabled, describedBy, hint, hintId, onChange }) {
      const children = options.length === 0 && emptyOption
        ? h('option', { value: '' }, emptyOption)
        : options.map(opt => h('option', { key: opt.value, value: opt.value }, opt.label));
      return h('div', { key: id, style: fieldStyle },
        h('label', { style: labelStyle, htmlFor: id }, label),
        h('select', {
          id,
          style: inputStyle,
          value,
          ...(disabled !== undefined ? { disabled } : {}),
          ...(describedBy ? { 'aria-describedby': describedBy } : {}),
          onChange,
        }, children),
        hint ? h('p', { ...(hintId ? { id: hintId } : {}), style: mutedStyle }, hint) : null,
      );
    }

    function renderNumberControl({ id, label, min, max, step = 1, value, dataField, disabled, describedBy, hint, hintId, wrapperOpacity, onChange }) {
      return h('div', { key: id, style: wrapperOpacity === undefined ? fieldStyle : { ...fieldStyle, opacity: wrapperOpacity } },
        h('label', { style: labelStyle, htmlFor: id }, label),
        h('input', {
          id,
          type: 'number',
          min,
          max,
          step,
          ...(dataField ? { 'data-field': dataField } : {}),
          ...(disabled !== undefined ? { disabled } : {}),
          ...(describedBy ? { 'aria-describedby': describedBy } : {}),
          style: inputStyle,
          value,
          onChange,
        }),
        hint ? h('p', { ...(hintId ? { id: hintId } : {}), style: mutedStyle }, hint) : null,
      );
    }

    function renderRangeControl({ id, label, min, max, step = 1, value, hint, onChange }) {
      return h('div', { key: id, style: fieldStyle },
        h('label', { style: labelStyle, htmlFor: id }, label),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('input', {
            id,
            type: 'range',
            min,
            max,
            step,
            value,
            style: { flex: 1, accentColor: TOKEN_ACCENT },
            'aria-label': label,
            onChange: event => onChange(Number(event.target.value)),
          }),
          h('span', { style: { minWidth: 36, textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: TOKEN_TEXT_PRIMARY } }, `${value}%`),
        ),
        h('p', { style: mutedStyle }, hint),
      );
    }

    function renderCheckboxControl({ id, heading, toggleLabel, checked, hint, hintId, minHeight, onChange }) {
      return h('div', { key: id, style: fieldStyle },
        h('span', { style: labelStyle }, heading),
        h('label', {
          htmlFor: id,
          style: { display: 'flex', alignItems: 'center', gap: 6, minHeight, fontSize: 12, color: TOKEN_TEXT_PRIMARY, cursor: 'pointer' },
        },
          h('input', {
            id,
            type: 'checkbox',
            checked: Boolean(checked),
            'aria-describedby': hintId,
            style: { accentColor: TOKEN_ACCENT, margin: 0 },
            onChange: event => {
              const next = typeof event?.target?.checked === 'boolean'
                ? event.target.checked
                : event?.target?.value === true || event?.target?.value === 'true';
              onChange(next);
            },
          }),
          h('span', null, toggleLabel),
        ),
        h('p', { id: hintId, style: mutedStyle }, hint),
      );
    }

    function renderIdleCompactionSection({ t, form, updateField }) {
      const idleControl = renderSelectControl({
        id: 'weave-idle-compaction',
        label: t('idleCompaction'),
        value: form.idlePreset,
        describedBy: 'weave-idle-duration-hint weave-idle-hint weave-idle-trigger-hint',
        options: [
          ...IDLE_PRESETS.map(value => ({ value, label: t(value === '0' ? 'idleOff' : `idle${value}`) })),
          { value: 'custom', label: t('idleCustom') },
        ],
        onChange: event => updateField('idlePreset', event.target.value),
      });
      const idleCustomControl = form.idlePreset === 'custom'
        ? renderNumberControl({
            id: 'weave-idle-custom-minutes',
            label: t('idleCustomMinutes'),
            min: 1,
            max: MAX_IDLE_COMPACTION_MINUTES,
            step: 1,
            value: form.idleCustomMinutes,
            describedBy: 'weave-idle-duration-hint weave-idle-hint weave-idle-trigger-hint',
            onChange: event => updateField('idleCustomMinutes', event.target.value),
          })
        : null;
      const cacheRefs = [
        ['OpenAI', 'https://developers.openai.com/api/docs/guides/prompt-caching'],
        ['Claude', 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching'],
        ['Gemini', 'https://ai.google.dev/gemini-api/docs/caching'],
        ['DeepSeek', 'https://api-docs.deepseek.com/guides/kv_cache/'],
        ['GLM', 'https://docs.bigmodel.cn/cn/guide/capabilities/cache'],
      ];
      return h('div', { style: fieldStyle },
        idleCustomControl ? h('div', { style: row2Style }, idleControl, idleCustomControl) : idleControl,
        h('p', { style: mutedStyle }, t('idleCompactionHint')),
        h('details', { style: { ...mutedStyle, marginTop: 2 } },
          h('summary', { style: { cursor: 'pointer', color: TOKEN_TEXT_SECONDARY } }, t('idleReferences')),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4 } },
            h('p', { id: 'weave-idle-duration-hint', style: mutedStyle }, t('idleDurationHint')),
            h('p', { id: 'weave-idle-hint', style: mutedStyle }, t('idleHint')),
            h('p', { id: 'weave-idle-trigger-hint', style: mutedStyle }, t('idleTriggerHint')),
            h('p', { id: 'weave-idle-gpt-hint', style: mutedStyle }, t('idleGptHint')),
            h('p', { style: mutedStyle }, t('idleClaudeHint')),
            h('p', { id: 'weave-idle-cache-hint', style: mutedStyle }, t('idleCacheHint')),
            h('p', { style: mutedStyle },
              cacheRefs.map(([label, href]) =>
                h('a', { key: label, href, target: '_blank', rel: 'noopener noreferrer', style: { marginRight: 10, color: 'inherit' } }, label),
              )),
          ),
        ),
      );
    }

    function renderArchiveStoragePanel({
      t,
      form,
      loading,
      saving,
      archiveStorage,
      archiveBusy,
      archiveFeedback,
      archiveCleanupConfirm,
      setArchiveCleanupConfirm,
      updateTouchedField,
      onCompressLegacy,
      onCleanupOrphans,
    }) {
      const compressDisabled = Boolean(loading || saving || archiveBusy !== null || !archiveStorage || archiveStorage.legacyPlainSpanCount === 0);
      const cleanupDisabled = Boolean(loading || saving || archiveBusy !== null || !archiveStorage || !archiveStorage.orphanProbeAvailable || archiveStorage.orphanSessionCount === 0);
      return h('div', {
        'data-settings-archive-storage': 'true',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: '10px 12px',
          borderRadius: 6,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: TOKEN_BORDER_1,
          background: TOKEN_SURFACE_2,
        },
      },
        h('div', { style: { fontSize: 12, fontWeight: 600, color: TOKEN_TEXT_PRIMARY } }, t('archiveStorageTitle')),
        archiveStorage
          ? h('div', { 'data-archive-stats': 'true', style: { ...mutedStyle, fontVariantNumeric: 'tabular-nums' } },
              formatTemplate(t('archiveStorageStats'), {
                total: formatBytes(archiveStorage.totalBytes),
                backup: formatBytes(archiveStorage.backupBytes),
                sessions: archiveStorage.sessionCount,
                legacy: archiveStorage.legacyPlainSpanCount,
              }))
          : null,
        archiveStorage?.warnExceeded === true
          ? h('div', {
              'data-archive-warn-banner': 'true',
              style: { ...confirmBannerStyle, fontSize: 11, lineHeight: 1.4, color: TOKEN_TEXT_WARNING, display: 'block' },
            }, formatTemplate(t('archiveStorageWarnBanner'), { warn: formatBytes(archiveStorage.warnBytes) }))
          : null,
        ...ARCHIVE_NUMBER_FIELDS.map(spec =>
          renderNumberControl({
            id: spec.id,
            label: t(spec.labelKey),
            min: spec.min,
            max: spec.max,
            step: spec.step,
            dataField: spec.dataField,
            value: form[spec.key],
            disabled: loading || saving,
            hint: t(spec.hintKey),
            hintId: spec.hintId,
            onChange: e => updateTouchedField(spec.key, e.target.value),
          }),
        ),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            'data-action': 'archive-compress-legacy',
            disabled: compressDisabled,
            style: disabledStyle(buttonStyle, compressDisabled),
            onClick: onCompressLegacy,
          }, archiveBusy === 'compress' ? t('archiveCompressing') : t('archiveCompressLegacy')),
          h('button', {
            type: 'button',
            'data-action': 'archive-cleanup-orphans',
            disabled: cleanupDisabled,
            style: disabledStyle(buttonStyle, cleanupDisabled),
            onClick: () => setArchiveCleanupConfirm(v => !v),
          }, t('archiveCleanupOrphans')),
        ),
        archiveStorage && !archiveStorage.orphanProbeAvailable
          ? h('p', { 'data-archive-probe-unavailable': 'true', style: mutedStyle }, t('archiveCleanupUnavailable'))
          : null,
        archiveCleanupConfirm && archiveStorage?.orphanProbeAvailable && archiveStorage.orphanSessionCount > 0
          ? h('div', {
              'data-confirm': 'archive-cleanup-orphans',
              style: { ...confirmBannerStyle, flexDirection: 'column', alignItems: 'stretch', padding: '6px 8px' },
            },
              h('span', { style: { fontSize: 11, color: TOKEN_TEXT_PRIMARY, lineHeight: 1.4 } },
                formatTemplate(t('archiveCleanupConfirmHint'), {
                  count: archiveStorage.orphanSessionCount,
                  bytes: formatBytes(archiveStorage.orphanBytes),
                })),
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h('button', {
                  type: 'button',
                  'data-action': 'archive-cleanup-confirm',
                  disabled: archiveBusy !== null,
                  style: primaryStyle,
                  onClick: onCleanupOrphans,
                }, t('archiveCleanupConfirm')),
                h('button', {
                  type: 'button',
                  'data-action': 'archive-cleanup-cancel',
                  disabled: archiveBusy !== null,
                  style: buttonStyle,
                  onClick: () => setArchiveCleanupConfirm(false),
                }, t('cancel')),
              ),
            )
          : null,
        archiveFeedback
          ? h('p', {
              'data-archive-feedback': archiveFeedback.kind,
              style: {
                margin: 0,
                fontSize: 11,
                lineHeight: 1.4,
                color: archiveFeedback.kind === 'error'
                  ? TOKEN_TEXT_ERROR
                  : archiveFeedback.kind === 'warning'
                    ? TOKEN_TEXT_WARNING
                    : TOKEN_TEXT_SUCCESS,
              },
            }, archiveFeedback.text)
          : null,
      );
    }

    function renderSettingsSectionBody({
      t,
      loading,
      saving,
      form,
      catalog,
      catalogError,
      status,
      biliConflict,
      engineActive,
      archiveStorage,
      archiveBusy,
      archiveFeedback,
      archiveCleanupConfirm,
      setArchiveCleanupConfirm,
      onProviderChange,
      updateField,
      updateTouchedField,
      onCompressLegacy,
      onCleanupOrphans,
      onSubmit,
      onReload,
    }) {
      if (loading) {
        return h('section', { style: { maxWidth: 640, padding: '12px 16px' } }, h('p', { style: mutedStyle }, t('loading')));
      }
      const { providerOptions, modelOptions, maxOptions } = buildCatalogSelectOptions(
        catalog,
        form.provider,
        form.model,
        form.maxTokens,
        t,
      );
      const reasoningOptions = SUMMARY_REASONING_EFFORTS.map(value => ({
        value,
        label: t(`summaryReasoning${value[0].toUpperCase()}${value.slice(1)}`),
      }));
      const cjkWeightOptions = CJK_WEIGHT_PRESETS.map(([value, key]) => ({ value, label: t(key) }));
      if (!CJK_WEIGHT_PRESETS.some(([val]) => val === form.summaryCjkTokensPerChar)) {
        cjkWeightOptions.push({
          value: form.summaryCjkTokensPerChar,
          label: formatTemplate(t('summaryCjkWeightCustom'), { weight: form.summaryCjkTokensPerChar }),
        });
      }
      const policyControls = POLICY_SELECT_SPECS.map(spec => {
        const isBool = spec.kind === 'boolean';
        const options = isBool
          ? [{ value: 'true', label: t(spec.onKey) }, { value: 'false', label: t(spec.offKey) }]
          : spec.values.map(val => ({ value: val, label: t(spec.optionKeys[val]) }));
        return renderSelectControl({
          id: spec.id,
          label: t(spec.labelKey),
          value: isBool ? (form[spec.key] ? 'true' : 'false') : form[spec.key],
          options,
          describedBy: spec.useHintId ? `${spec.id}-hint` : undefined,
          hint: t(spec.hintKey),
          hintId: spec.useHintId ? `${spec.id}-hint` : undefined,
          onChange: event => {
            const next = isBool ? event.target.value !== 'false' : event.target.value;
            if (spec.touchedGated) updateTouchedField(spec.key, next);
            else updateField(spec.key, next);
          },
        });
      });

      return h(
        'section',
        { style: { maxWidth: 640, width: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 16px' } },
        h('header', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          h('h2', { style: { fontSize: 16, fontWeight: 600, margin: 0, color: TOKEN_TEXT_PRIMARY } }, t('title')),
          h('p', { style: mutedStyle }, t('intro')),
        ),
        engineActive === false
          ? h('div', {
              role: 'alert',
              'data-settings-engine-inactive': 'true',
              style: {
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: TOKEN_TEXT_WARNING,
                borderRadius: 8,
                background: TOKEN_SURFACE_2,
                padding: '8px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                fontSize: 12,
                lineHeight: 1.4,
              },
            },
              h('div', { style: { fontWeight: 700, color: TOKEN_TEXT_WARNING } }, t('engineInactiveTitle')),
              h('div', { style: { color: TOKEN_TEXT_PRIMARY } }, t('engineInactiveBody')),
            )
          : null,
        biliConflict?.detected
          ? h('div', {
              role: 'alert',
              'data-settings-bili-conflict': biliConflict.kind,
              style: {
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: biliConflict.activePlugin ? TOKEN_TEXT_ERROR : TOKEN_TEXT_WARNING,
                borderRadius: 8,
                background: TOKEN_SURFACE_2,
                padding: '8px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                fontSize: 12,
                lineHeight: 1.4,
              },
            },
              h('div', { style: { fontWeight: 700, color: biliConflict.activePlugin ? TOKEN_TEXT_ERROR : TOKEN_TEXT_WARNING } },
                t(biliConflictTitleKey(biliConflict.kind))),
              h('div', { style: { color: TOKEN_TEXT_PRIMARY } }, t('biliConflictStep1')),
              h('div', { style: { color: TOKEN_TEXT_PRIMARY } }, t('biliConflictStep2')),
              h('div', { style: { color: TOKEN_TEXT_PRIMARY, fontWeight: 600 } }, t('biliConflictStep3')),
            )
          : null,
        h('div', { style: row2Style },
          renderSelectControl({
            id: 'weave-summary-provider',
            label: t('provider'),
            value: form.provider,
            options: providerOptions,
            onChange: onProviderChange,
          }),
          renderSelectControl({
            id: 'weave-summary-model',
            label: t('model'),
            value: form.model,
            options: modelOptions,
            emptyOption: form.provider === '' ? t('followSession') : t('noModels'),
            disabled: form.provider === '' || modelOptions.length === 0,
            onChange: event => updateField('model', event.target.value),
          }),
        ),
        h('div', { style: row2Style },
          renderSelectControl({
            id: 'weave-summary-max-tokens',
            label: t('maxTokens'),
            value: form.maxTokens,
            options: maxOptions,
            onChange: event => updateField('maxTokens', event.target.value),
          }),
          renderNumberControl({
            id: 'weave-summary-retry-count',
            label: t('retryCount'),
            min: 0,
            max: 4,
            step: 1,
            value: form.retryCount,
            hint: t('retryHint').replace('{count}', String(form.retryCount)).replace('{total}', String(Number(form.retryCount) + 1)),
            onChange: event => updateField('retryCount', event.target.value),
          }),
        ),
        h('div', { style: row2Style },
          renderNumberControl({
            id: 'weave-summary-retry-delay',
            label: t('retryDelay'),
            min: 0,
            max: 30,
            step: 0.001,
            value: form.retryDelay,
            hint: t('retryDelayHint'),
            onChange: event => updateField('retryDelay', event.target.value),
          }),
          renderNumberControl({
            id: 'weave-summary-timeout',
            label: t('summaryTimeout'),
            min: 5,
            max: 3600,
            step: 1,
            value: form.summaryTimeout,
            hint: t('timeoutHint'),
            onChange: event => updateField('summaryTimeout', event.target.value),
          }),
        ),
        h('div', { style: row2Style },
          renderNumberControl({
            id: 'weave-summary-concurrency',
            label: t('summaryConcurrency'),
            min: 1,
            max: 6,
            step: 1,
            value: form.summaryConcurrency,
            hint: t('summaryConcurrencyHint'),
            onChange: event => updateTouchedField('summaryConcurrency', event.target.value),
          }),
          renderSelectControl({
            id: 'weave-summary-reasoning-effort',
            label: t('summaryReasoningEffort'),
            value: form.summaryReasoningEffort,
            options: reasoningOptions,
            hint: t('summaryReasoningHint'),
            onChange: event => updateTouchedField('summaryReasoningEffort', event.target.value),
          }),
        ),
        renderSelectControl({
          id: 'weave-summary-cjk-tokens-per-char',
          label: t('summaryCjkTokensPerChar'),
          value: form.summaryCjkTokensPerChar,
          options: cjkWeightOptions,
          hint: t('summaryCjkTokensPerCharHint'),
          onChange: event => updateTouchedField('summaryCjkTokensPerChar', event.target.value),
        }),
        h('div', { style: row2Style },
          renderRangeControl({
            id: 'weave-summary-threshold',
            label: t('trigger'),
            min: 50,
            max: 95,
            value: form.thresholdRatio,
            hint: t('triggerHint').replace('{pct}', String(form.thresholdRatio)),
            onChange: value => updateField('thresholdRatio', value),
          }),
          renderRangeControl({
            id: 'weave-minimum-reduction',
            label: t('minimumReduction'),
            min: 5,
            max: 90,
            value: form.minimumReductionRatio,
            hint: t('reductionHint').replace('{pct}', String(form.minimumReductionRatio)),
            onChange: value => updateField('minimumReductionRatio', value),
          }),
        ),
        renderIdleCompactionSection({ t, form, updateField }),
        ...policyControls,
        h('div', { style: row2Style },
          renderCheckboxControl({
            id: 'weave-session-memory-enabled',
            heading: t('sessionMemoryEnabled'),
            toggleLabel: t('sessionMemoryEnabledToggle'),
            checked: form.sessionMemoryEnabled,
            hint: t('sessionMemoryHint'),
            hintId: 'weave-session-memory-hint',
            minHeight: 28,
            onChange: next => updateTouchedField('sessionMemoryEnabled', next),
          }),
          renderNumberControl({
            id: 'weave-session-memory-max-calls',
            label: t('sessionMemoryMaxCalls'),
            min: 1,
            max: 100,
            step: 1,
            value: form.sessionMemoryMaxCalls,
            describedBy: 'weave-session-memory-max-calls-hint',
            hint: t('sessionMemoryMaxCallsHint'),
            hintId: 'weave-session-memory-max-calls-hint',
            wrapperOpacity: form.sessionMemoryEnabled ? undefined : 0.65,
            onChange: event => updateTouchedField('sessionMemoryMaxCalls', event.target.value),
          }),
        ),
        renderCheckboxControl({
          id: 'weave-context-collapse-enabled',
          heading: t('contextCollapseEnabled'),
          toggleLabel: t('contextCollapseEnabledToggle'),
          checked: form.contextCollapseEnabled,
          hint: t('contextCollapseHint'),
          hintId: 'weave-context-collapse-hint',
          minHeight: 26,
          onChange: next => updateTouchedField('contextCollapseEnabled', next),
        }),
        renderArchiveStoragePanel({
          t,
          form,
          loading,
          saving,
          archiveStorage,
          archiveBusy,
          archiveFeedback,
          archiveCleanupConfirm,
          setArchiveCleanupConfirm,
          updateTouchedField,
          onCompressLegacy,
          onCleanupOrphans,
        }),
        catalogError === null
          ? null
          : h('p', { style: { ...mutedStyle, color: TOKEN_TEXT_ERROR } }, `${t('catalogError')}: ${catalogError}`),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
          h('button', { type: 'button', style: primaryStyle, disabled: saving, onClick: () => onSubmit(false) },
            saving ? t('saving') : t('save')),
          h('button', { type: 'button', style: buttonStyle, disabled: saving, onClick: () => onSubmit(true) },
            t('clear')),
          catalogError === null
            ? null
            : h('button', { type: 'button', style: buttonStyle, disabled: saving, onClick: onReload }, t('reloadModels')),
        ),
        status === null
          ? null
          : h('p', {
              role: 'status',
              style: { ...mutedStyle, color: status.kind === 'error' ? TOKEN_TEXT_ERROR : TOKEN_TEXT_SUCCESS },
            }, status.text),
        h('p', { style: mutedStyle }, t('applyHint')),
      );
    }

    function apply(ctx) {
      const fallback = key => dictionaries.zh[key] ?? key;
      let t = fallback;
      try {
        if (typeof ctx.locale?.register === 'function') {
          ctx.effect?.(() => ctx.locale.register(NS, dictionaries), 'compaction-weave: settings locale');
        }
        if (typeof ctx.locale?.bind === 'function') t = ctx.locale.bind(NS);
      } catch (error) {
        console.warn('[dsh-compaction-weave] settings locale unavailable:', error?.message ?? error);
      }

      function Section() {
        const [loading, setLoading] = React.useState(true);
        const [form, setForm] = React.useState(INITIAL_SETTINGS_FORM);
        const [touched, setTouched] = React.useState({});
        const [archiveStorage, setArchiveStorage] = React.useState(null);
        const [archiveBusy, setArchiveBusy] = React.useState(null);
        const [archiveFeedback, setArchiveFeedback] = React.useState(null);
        const [archiveCleanupConfirm, setArchiveCleanupConfirm] = React.useState(false);
        const [catalog, setCatalog] = React.useState([]);
        const [catalogError, setCatalogError] = React.useState(null);
        const [saving, setSaving] = React.useState(false);
        const [status, setStatus] = React.useState(null);
        const [biliConflict, setBiliConflict] = React.useState(null);
        const [engineActive, setEngineActive] = React.useState(true);

        const updateField = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
        const updateTouchedField = (key, value) => {
          setForm(prev => ({ ...prev, [key]: value }));
          setTouched(prev => ({ ...prev, [key]: true }));
        };

        async function runArchiveAction(busyKey, rpcMethod, rpcParams, failedKey, onResult) {
          if (archiveBusy) return;
          setArchiveBusy(busyKey);
          setArchiveFeedback(null);
          try {
            const res = await rpc(rpcMethod, rpcParams);
            if (res?.storage) setArchiveStorage(normalizeArchiveStorage(res.storage));
            onResult(res);
          } catch (error) {
            setArchiveFeedback({
              kind: 'error',
              text: formatTemplate(t(failedKey), { error: error?.message ?? String(error) }),
            });
          } finally {
            setArchiveBusy(null);
          }
        }

        const handleCompressLegacy = () =>
          runArchiveAction('compress', 'archive-compress-legacy', undefined, 'archiveCompressFailed', res => {
            setArchiveFeedback({
              kind: Number(res?.failedCount) > 0 ? 'warning' : 'success',
              text: formatTemplate(t('archiveCompressDone'), {
                count: nonNegativeInt(res?.compressedCount),
                saved: formatBytes(res?.bytesSaved ?? 0),
                failed: nonNegativeInt(res?.failedCount),
              }),
            });
          });

        const handleCleanupOrphans = () =>
          runArchiveAction('cleanup', 'archive-cleanup-orphans', { confirmDelete: true }, 'archiveCleanupFailed', res => {
            setArchiveCleanupConfirm(false);
            setArchiveFeedback(
              res?.supported === false
                ? { kind: 'warning', text: t('archiveCleanupUnavailable') }
                : {
                    kind: 'success',
                    text: formatTemplate(t('archiveCleanupDone'), {
                      count: nonNegativeInt(res?.deletedSessions),
                      bytes: formatBytes(res?.freedBytes ?? 0),
                    }),
                  },
            );
          });

        function load() {
          let alive = true;
          setLoading(true);
          setCatalogError(null);
          Promise.allSettled([rpc('get'), rpc('models')])
            .then(([configResult, catalogResult]) => {
              if (!alive) return;
              if (configResult.status === 'fulfilled') {
                setBiliConflict(normalizeBiliConflict(configResult.value?.biliConflict));
                setEngineActive(configResult.value?.engineActive !== false);
                setArchiveStorage(normalizeArchiveStorage(configResult.value?.archiveStorage));
                setArchiveCleanupConfirm(false);
                const config = configResult.value?.config ?? null;
                setForm(prev => decodeFullLoadedConfig(prev, config).form);
                setTouched(decodeFullLoadedConfig(INITIAL_SETTINGS_FORM, config).touched);
              } else {
                setStatus({ kind: 'error', text: (t('error') ?? 'Save failed: ') + (configResult.reason?.message ?? configResult.reason) });
              }
              if (catalogResult.status === 'fulfilled') {
                const providers = catalogResult.value?.providers;
                setCatalog(Array.isArray(providers) ? providers : []);
              } else {
                setCatalog([]);
                setCatalogError(catalogResult.reason?.message ?? String(catalogResult.reason));
              }
            })
            .finally(() => {
              if (alive) setLoading(false);
            });
          return () => {
            alive = false;
          };
        }

        React.useEffect(load, []);

        function onProviderChange(event) {
          const next = event.target.value;
          const entry = catalog.find(item => item?.provider === next);
          setForm(prev => ({ ...prev, provider: next, model: entry?.models?.[0]?.id ?? '' }));
        }

        async function submit(clear) {
          const problem = validateSettingsForm(form, clear, t);
          if (problem) {
            setStatus({ kind: 'error', text: problem });
            return;
          }
          setSaving(true);
          setStatus(null);
          try {
            const params = buildSettingsRpcParams(form, touched, clear);
            const result = await rpc('set', params);
            if (touched.archiveWarnMb) {
              const nextWarnBytes = params.archiveWarnBytes;
              setArchiveStorage(prev => (
                prev ? { ...prev, warnBytes: nextWarnBytes, warnExceeded: nextWarnBytes > 0 && prev.totalBytes >= nextWarnBytes } : prev
              ));
            }
            if (result && Object.hasOwn(result, 'config')) {
              const sub = decodeServerSubset(result.config);
              setForm(prev => ({ ...prev, ...sub.values }));
              setTouched(prev => ({ ...prev, ...sub.touched }));
            }
            if (clear) {
              setForm(prev => ({ ...prev, provider: '', model: '', maxTokens: '' }));
              setStatus({ kind: 'ok', text: t('cleared') });
            } else {
              setStatus({ kind: 'ok', text: t('saved') });
            }
          } catch (error) {
            setStatus({ kind: 'error', text: (t('error') ?? 'Save failed: ') + (error?.message ?? error) });
          } finally {
            setSaving(false);
          }
        }

        return renderSettingsSectionBody({
          t,
          loading,
          saving,
          form,
          catalog,
          catalogError,
          status,
          biliConflict,
          engineActive,
          archiveStorage,
          archiveBusy,
          archiveFeedback,
          archiveCleanupConfirm,
          setArchiveCleanupConfirm,
          onProviderChange,
          updateField,
          updateTouchedField,
          onCompressLegacy: () => void handleCompressLegacy(),
          onCleanupOrphans: () => void handleCleanupOrphans(),
          onSubmit: clear => void submit(clear),
          onReload: () => void load(),
        });
      }

      // Fallback for compositions whose main Settings shell is unavailable or
      // does not project late settings.section registrations: the same form is
      // also reachable from Plugins -> dsh-compaction-weave.
      function PluginSection(props) {
        const subject = props?.subject;
        const pkg = subject?.pkg;
        const name = typeof pkg === 'string' ? pkg : pkg?.name;
        if (subject?.kind !== 'bundle' || name !== 'dsh-compaction-weave') return null;
        return h(Section);
      }

      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: PAGE_ID, order: 5, label: () => t('nav'), locale: NS },
            Section,
          ),
        );
      } catch (error) {
        console.warn('[dsh-compaction-weave] settings.section unavailable:', error?.message ?? error);
      }

      const CompactionProgressCard = createCompactionProgressCard(t);
      try {
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            { name: 'conversation.input.dock', id: 'compaction-weave-progress', order: 3, locale: NS },
            CompactionProgressCard,
          ),
        );
      } catch (error) {
        console.warn('[dsh-compaction-weave] composer progress card unavailable:', error?.message ?? error);
      }

      try {
        ctx.slots.inject('plugins.detail.section', () =>
          ctx.slots.register(
            { name: 'plugins.detail.section', id: PAGE_ID, order: 10, locale: NS },
            PluginSection,
          ),
        );
      } catch (error) {
        console.warn('[dsh-compaction-weave] plugins.detail.section unavailable:', error?.message ?? error);
      }
    }

    const module = { exports: {} };
    module.exports.apply = apply;
    module.exports.inject = ['slots', 'locale'];
    return module.exports;
  },
});
