/**
 * Client half of dsh-compaction-weave: compact Settings page section
 * (`settings.section` / `plugins.detail.section`) and live composer-dock
 * progress + billion-context compatibility card (`conversation.input.dock`).
 *
 * Contract notes:
 * - Only `react` is required (`{ createElement, useState, useEffect }`).
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
    const SUMMARY_REASONING_EFFORTS = ['low', 'none', 'minimal', 'medium', 'high', 'xhigh', 'max', 'inherit'];
    const PRESSURE_BREAKER_ACTIONS = ['confirm', 'degrade', 'block'];
    const AUDIT_EXHAUSTION_POLICIES = ['fallback', 'block'];
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
        summaryReasoningLow: 'low（默认：低推理，更快）',
        summaryReasoningNone: 'none（关闭：省略推理强度参数）',
        summaryReasoningMinimal: 'minimal（极简推理）',
        summaryReasoningMedium: 'medium（中等推理）',
        summaryReasoningHigh: 'high（高推理）',
        summaryReasoningXhigh: 'xhigh（超高推理）',
        summaryReasoningMax: 'max（最高推理）',
        summaryReasoningInherit: 'inherit（沿用当前会话推理强度）',
        summaryReasoningHint: '默认 low，避免摘要沿用高推理导致变慢；直接指定档位时若模型不支持将自动逐级向下回退并省略。',
        reasoningEffortRange: '摘要推理强度必须为 low、none、minimal、medium、high、xhigh、max 或 inherit。',
        auditBlockOnLoss: '要求保留审计拦截（auditBlockOnLoss）',
        auditBlockOnLossOn: '开启（默认：漏掉有效要求时拦截重试）',
        auditBlockOnLossOff: '关闭（仅警告；仍拦截极性反转与授权伪造）',
        auditBlockOnLossHint: '已自动过滤宿主注入块；频繁误拦截时可关闭，仍保留 Section 6 原话与极性检查。',
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
        postCompactReinjectOn: '开启（默认：0 LLM Token，重读最近 5 个工作区文件）',
        postCompactReinjectOff: '关闭（不从本地磁盘重注入近期文件）',
        postCompactReinjectHint: '0 LLM Token 消耗；仅在本地工作区存在时，压缩后从磁盘新鲜读取最近最多 5 个活跃文件（总计上限 24KB），自动跳过 AGENTS.md、敏感文件与远程会话。',
        persistedOutput: '超大工具结果尾部溢出（Persisted-Output）',
        persistedOutputOn: '开启（默认：0 LLM，仅归档未发送尾部 ≥ 32768 字工具输出）',
        persistedOutputOff: '关闭（保留未发送尾部超大工具输出原文）',
        persistedOutputHint: '0 LLM Token 消耗，0 前缀缓存失效；仅对刚落盘且尚未发给模型的尾部成功工具输出（跳过 isError: true）进行归档并替换为首尾 1200 字预览，绝不改写历史。',
        microcompact: '闲置 0-LLM 轻压缩（Microcompact）',
        microcompactOn: '开启（默认：保留最新 4 条热点输出，折叠更早大输出与重复读取）',
        microcompactOff: '关闭（闲置超时后不执行 0-LLM 轻压缩）',
        microcompactHint: '共用「闲置后先压缩」时间阈值，0 LLM 调用；超时后先保留最新 4 条热点工具输出，并折叠更早大体积工具输出与同路径重复读取，仍需缩减时再按需运行可选完整闲置摘要。',
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
        summaryReasoningLow: 'low (default: fast, avoids high reasoning)',
        summaryReasoningNone: 'none (omit reasoning effort)',
        summaryReasoningMinimal: 'minimal (minimal reasoning)',
        summaryReasoningMedium: 'medium (medium reasoning)',
        summaryReasoningHigh: 'high (high reasoning)',
        summaryReasoningXhigh: 'xhigh (extra-high reasoning)',
        summaryReasoningMax: 'max (maximum reasoning)',
        summaryReasoningInherit: 'inherit (follow session reasoning effort)',
        summaryReasoningHint: 'Default low to avoid slow high-reasoning summary calls; selected levels automatically fall back downward if unsupported.',
        reasoningEffortRange: 'Summary reasoning effort must be low, none, minimal, medium, high, xhigh, max, or inherit.',
        auditBlockOnLoss: 'Block compaction on requirement loss (auditBlockOnLoss)',
        auditBlockOnLossOn: 'On (default: block & retry on dropped requirements)',
        auditBlockOnLossOff: 'Off (warn only; polarity & provenance still blocked)',
        auditBlockOnLossHint: 'Host-injected blocks are filtered automatically; turning off keeps Section 6 quotes and polarity checks.',
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
        postCompactReinjectOn: 'On (default: 0 LLM tokens, fresh read of up to 5 recent files)',
        postCompactReinjectOff: 'Off (do not re-inject recent local workspace files)',
        postCompactReinjectHint: 'Uses 0 LLM tokens; after compaction, freshly reads up to 5 recent local workspace files (24KB cap), skipping AGENTS.md, secrets, and remote sessions.',
        persistedOutput: 'Spill oversized tail tool outputs (Persisted-Output)',
        persistedOutputOn: 'On (default: 0 LLM, archive unsent tail tool outputs ≥ 32768 chars)',
        persistedOutputOff: 'Off (keep oversized unsent tail tool outputs inline)',
        persistedOutputHint: 'Uses 0 LLM tokens with 0 prefix-cache invalidation; archives only newly landed unsent tail successful tool outputs (skipping isError: true) with a 1200-char head/tail preview, never mutating prior history.',
        microcompact: 'Idle 0-LLM microcompaction (Microcompact)',
        microcompactOn: 'On (default: keep newest 4 hot outputs, fold older large outputs & repeated reads)',
        microcompactOff: 'Off (skip 0-LLM microcompaction after idle timeout)',
        microcompactHint: 'Shares the idle interval with 0 LLM calls; preserves the newest 4 hot tool outputs while folding older oversized tool outputs and same-path repeated reads before optional full idle summary if still needed.',
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

    async function rpc(method, params, signal) {
      const response = await fetch(RPC_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
    const RETRY_SECRET_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{8,})\b/i;
    const RETRY_SECRET_PREFIX_RE = /(?:^|[_.-])(?:sk-|gh[pousr]_)/i;
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
                headers: { 'content-type': 'application/json' },
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
        const effectiveBackupId = hasBackupContext
          ? (validSelectedBackup ?? defaultBackupId)
          : null;
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

        if (!isActive && !showBreakerRow && !showResumeRow && !showBiliRow && !showTerminalRow && !showBackupRow && !showBiliConflict && !showArchiveWarning) return null;

        const activePhase = status.active
          ? status.phase
          : actionBusy === 'migrating'
            ? 'backing_up'
            : actionBusy === 'restoring'
              ? 'restoring'
              : actionBusy === 'resuming'
                ? (resumable?.trigger === 'migration' ? 'migrating' : 'continuing')
                : status.phase;

        const progressPercent = isActive ? computeProgressPercent(status) : null;
        const indeterminateStep = Math.floor((status.elapsedMs || 0) / 500) % 4;
        const indeterminateMargins = ['0%', '22%', '44%', '65%'];
        const telemetryItems = isActive ? buildTelemetryItems(tr, status) : [];

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

        async function handleResumeCompaction() {
          if (!sessionId || actionBusy !== null) return;
          setActionBusy('resuming');
          setConfirmAction(null);
          setActionError(null);
          try {
            await rpc('resume-compaction', { sessionId });
          } catch (error) {
            setActionError(formatTemplate(tr('resumeFailed'), { error: error?.message ?? String(error) }));
          } finally {
            setActionBusy(null);
            setPollNonce(n => n + 1);
          }
        }

        async function handleConfirmDiscardResume() {
          if (!sessionId || actionBusy !== null) return;
          setActionBusy('discarding');
          setConfirmAction(null);
          setActionError(null);
          try {
            await rpc('discard-resume', { sessionId, confirmDiscard: true });
          } catch (error) {
            setActionError(formatTemplate(tr('discardResumeFailed'), { error: error?.message ?? String(error) }));
          } finally {
            setActionBusy(null);
            setPollNonce(n => n + 1);
          }
        }

        async function handleCopyPath(path) {
          if (!path) return;
          try {
            const clipboard = globalThis.navigator?.clipboard;
            if (clipboard && typeof clipboard.writeText === 'function') {
              await clipboard.writeText(path);
              setCopiedPath(path);
            }
          } catch {
            // Clipboard access may be unavailable or denied; ignore cleanly.
          }
        }

        async function handleRetryCompaction() {
          if (!sessionId || actionBusy !== null) return;
          setActionBusy('retrying');
          setConfirmAction(null);
          setActionError(null);
          try {
            await rpc('retry-compaction', { sessionId });
          } catch (error) {
            setActionError(formatTemplate(tr('breakerRetryFailed'), { error: error?.message ?? String(error) }));
          } finally {
            setActionBusy(null);
            setPollNonce(n => n + 1);
          }
        }

        async function handleBypassBreaker(bypass) {
          if (!sessionId || actionBusy !== null) return;
          setActionBusy('bypassing');
          setConfirmAction(null);
          setActionError(null);
          try {
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
          } catch (error) {
            setActionError(formatTemplate(tr('breakerBypassFailed'), { error: error?.message ?? String(error) }));
          } finally {
            setActionBusy(null);
            setPollNonce(n => n + 1);
          }
        }

        async function handleCopyDiagnostic() {
          const text = JSON.stringify({
            pluginVersion: status.pluginVersion ?? null,
            lastFailureCode: status.lastFailureCode ?? null,
            lastDiagnosticId: status.lastDiagnosticId ?? null,
            lastDiagnosticPath: status.lastDiagnosticPath ?? null,
          }, null, 2);
          try {
            const clipboard = globalThis.navigator?.clipboard;
            if (clipboard && typeof clipboard.writeText === 'function') {
              await clipboard.writeText(text);
              setCopiedDiagnostic(true);
            }
          } catch {
            // Clipboard access may be unavailable or denied; ignore cleanly.
          }
        }

        async function handleConfirmConvert() {
          if (!sessionId || actionBusy !== null) return;
          setActionBusy('migrating');
          setConfirmAction(null);
          setActionError(null);
          setRestoreResult(null);
          setSelectedBackupId(null);
          setDismissedBackupKey('');
          try {
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
          } catch (error) {
            setActionError(formatTemplate(tr('biliConvertFailed'), { error: error?.message ?? String(error) }));
          } finally {
            setActionBusy(null);
            setPollNonce(n => n + 1);
          }
        }

        async function handleConfirmRestore(backupId) {
          if (!sessionId || !backupId || actionBusy !== null) return;
          setActionBusy('restoring');
          setConfirmAction(null);
          setActionError(null);
          try {
            const result = await rpc('backup-restore', { sessionId, backupId, confirmRestore: true });
            setRestoreResult({
              status: typeof result?.status === 'string' ? result.status : (result?.requiresReopen ? 'armed' : 'restored'),
              requiresReopen: result?.requiresReopen === true || result?.status === 'armed',
              backupId: typeof result?.backupId === 'string' && result.backupId ? result.backupId : backupId,
              backupPath: typeof result?.backupPath === 'string' ? result.backupPath : effectiveBackupPath,
              targetPath: typeof result?.targetPath === 'string' ? result.targetPath : null,
            });
          } catch (error) {
            setActionError(formatTemplate(tr('backupRestoreFailed'), { error: error?.message ?? String(error) }));
          } finally {
            setActionBusy(null);
            setPollNonce(n => n + 1);
          }
        }

        const sections = [];

        if (showBiliConflict) {
          const conflictAccent = biliConflict.activePlugin ? TOKEN_TEXT_ERROR : TOKEN_TEXT_WARNING;
          const signalList = Array.isArray(biliConflict.signals) && biliConflict.signals.length > 0
            ? biliConflict.signals.join(', ')
            : biliConflict.kind;
          sections.push(
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
              h('span', {
                'aria-hidden': 'true',
                style: {
                  display: 'inline-block',
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: conflictAccent,
                },
              }),
              h('span', { style: { flex: 1, minWidth: 180, fontWeight: 600, color: conflictAccent } },
                tr(biliConflictTitleKey(biliConflict.kind))),
              h('span', { style: { flex: '1 1 100%', fontSize: 11, color: TOKEN_TEXT_SECONDARY } },
                tr('biliConflictBannerText')),
              h('button', {
                type: 'button',
                'data-action': 'reopen-bili-conflict-modal',
                'data-bili-conflict-reopen': 'true',
                style: compactPrimaryButtonStyle,
                onClick: () => setBiliModalDismissedKey(''),
              }, tr('biliConflictReopen')),
            ),
          );
          if (showBiliConflictModal) {
            sections.push(
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
                      onClick: () => setBiliModalDismissedKey(biliConflictKey),
                    }, tr('biliConflictDismiss')),
                  ),
                ),
              ),
            );
          }
        }

        // 1. Live active progress section
        if (isActive) {
          const headerText = status.active && status.message && !status.messageKey
            ? status.message
            : phaseLabelFor(tr, activePhase);
          const hasOverallPercent = status.overallPercent !== null;
          const showConcurrencyChip = status.rateLimited === true || (status.concurrency !== null && status.concurrency > 1);
          const concurrencyLabel = status.rateLimited === true
            ? tr('rateLimitedChip')
            : formatTemplate(tr('concurrencyChip'), { count: status.concurrency });
          sections.push(
            h('div', { key: 'progress', 'data-compaction-section': 'progress', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                h('span', {
                  'aria-hidden': 'true',
                  style: {
                    display: 'inline-block',
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: TOKEN_ACCENT,
                  },
                }),
                hasOverallPercent
                  ? h('span', {
                      'data-overall-percent': String(status.overallPercent),
                      style: {
                        fontWeight: 600,
                        fontVariantNumeric: 'tabular-nums',
                        color: TOKEN_ACCENT,
                      },
                    }, formatTemplate(tr('overallProgress'), { percent: status.overallPercent }))
                  : progressPercent !== null
                    ? h('span', {
                        'data-progress-percent': String(progressPercent),
                        style: {
                          fontWeight: 600,
                          fontVariantNumeric: 'tabular-nums',
                          color: TOKEN_ACCENT,
                        },
                      }, `${progressPercent}%`)
                    : null,
                hasOverallPercent || progressPercent !== null
                  ? h('span', { 'aria-hidden': 'true', style: { color: TOKEN_TEXT_SECONDARY } }, '·')
                  : null,
                h('span', { style: { fontWeight: 600, color: TOKEN_TEXT_PRIMARY } }, headerText),
                status.summaryModel
                  ? h('span', {
                      'data-summary-model': status.summaryModel,
                      style: {
                        fontSize: 11,
                        padding: '0 6px',
                        borderRadius: 999,
                        background: TOKEN_SURFACE_2,
                        color: TOKEN_TEXT_SECONDARY,
                      },
                    }, status.summaryModel)
                  : null,
                showConcurrencyChip
                  ? h('span', {
                      'data-compaction-concurrency': status.rateLimited ? 'rate-limited' : String(status.concurrency),
                      title: status.activeWorkers !== null && status.concurrency !== null
                        ? `${status.activeWorkers}/${status.concurrency}`
                        : undefined,
                      style: {
                        fontSize: 11,
                        padding: '0 6px',
                        borderRadius: 999,
                        background: TOKEN_SURFACE_2,
                        color: status.rateLimited ? TOKEN_TEXT_WARNING : TOKEN_TEXT_SECONDARY,
                        fontVariantNumeric: 'tabular-nums',
                      },
                    }, concurrencyLabel)
                  : null,
                h('span', {
                  'data-compaction-elapsed': 'true',
                  style: {
                    marginLeft: 'auto',
                    fontSize: 11,
                    fontVariantNumeric: 'tabular-nums',
                    color: TOKEN_TEXT_SECONDARY,
                  },
                }, formatElapsed(status.elapsedMs)),
                status.cancellable === true
                  ? h('button', {
                      type: 'button',
                      'data-action': 'cancel-compaction',
                      disabled: cancelBusy,
                      style: {
                        ...compactMicroButtonStyle,
                        ...(cancelBusy ? { opacity: 0.55, cursor: 'not-allowed' } : {}),
                      },
                      onClick: () => void handleCancelCompaction(),
                    }, cancelBusy ? tr('pausing') : tr('pause'))
                  : null,
              ),
              h('div', {
                role: 'progressbar',
                'aria-valuemin': 0,
                'aria-valuemax': 100,
                ...(progressPercent === null ? {} : { 'aria-valuenow': progressPercent }),
                'data-progress-mode': progressPercent === null ? 'indeterminate' : 'determinate',
                style: {
                  width: '100%',
                  height: 4,
                  borderRadius: 999,
                  overflow: 'hidden',
                  background: TOKEN_BORDER_1,
                },
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
                    style: {
                      fontSize: 11,
                      lineHeight: 1.35,
                      color: TOKEN_TEXT_SECONDARY,
                      fontVariantNumeric: 'tabular-nums',
                    },
                  }, telemetryItems.join(' · '))
                : null,
            ),
          );
        }

        // 2. Terminal done / error feedback row
        if (showTerminalRow) {
          const isErr = actionError !== null || status.phase === 'error';
          const errMessage = actionError ?? status.error?.message ?? status.message ?? tr('errorFallback');
          const doneDelta = status.beforeTokens && status.currentTokens
            ? ` (${formatTemplate(tr('tokenDelta'), { before: formatTokens(status.beforeTokens), current: formatTokens(status.currentTokens) })})`
            : '';
          const doneElapsed = status.elapsedMs > 0 ? ` · ${formatElapsed(status.elapsedMs)}` : '';
          const doneLabel = status.trigger === 'migration' ? tr('biliConvertDone') : (status.message || tr('doneSummary'));
          sections.push(
            h('div', {
              key: 'terminal',
              'data-compaction-section': isErr ? 'error' : 'done',
              style: {
                ...(sections.length > 0 ? dividerStyle : {}),
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              },
            },
              h('span', {
                style: {
                  flex: 1,
                  minWidth: 0,
                  wordBreak: 'break-word',
                  color: isErr ? TOKEN_TEXT_ERROR : TOKEN_TEXT_SUCCESS,
                },
              }, isErr ? errMessage : `${doneLabel}${doneDelta}${doneElapsed}`),
              h('button', {
                type: 'button',
                'data-action': 'dismiss-terminal',
                'aria-label': tr('dismiss'),
                title: tr('dismiss'),
                style: compactDismissButtonStyle,
                onClick: () => {
                  setActionError(null);
                  if (terminalKey) setDismissedKey(terminalKey);
                },
              }, '×'),
            ),
          );
        }

        // 2b. Circuit breaker banner (blocked or graduated bypass)
        if (showBreakerRow) {
          const breakerBusy = actionBusy !== null;
          const canConfirmBypass = !isBypassedActive && pressureBreakerAction !== 'block' && status.breakerBypassed !== true;
          const canRestoreBlock = isBypassedActive && pressureBreakerAction === 'confirm' && status.breakerBypassed === true;
          const details = [
            status.lastFailureCode ? formatTemplate(tr('breakerFailureCode'), { code: status.lastFailureCode }) : null,
            status.lastDiagnosticId ? formatTemplate(tr('breakerDiagnosticId'), { id: status.lastDiagnosticId }) : null,
          ].filter(Boolean);
          const linkStyle = {
            ...compactButtonStyle,
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
          };
          sections.push(
            h('div', {
              key: 'breaker',
              'data-breaker-banner': isBypassedActive ? 'bypassed' : 'blocked',
              style: {
                ...(sections.length > 0 ? dividerStyle : {}),
                padding: '6px 8px',
                borderRadius: 6,
                border: isBypassedActive ? '1px solid rgba(217, 119, 6, 0.4)' : '1px solid rgba(220, 38, 38, 0.38)',
                background: isBypassedActive ? 'rgba(217, 119, 6, 0.08)' : 'rgba(220, 38, 38, 0.07)',
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
              },
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
                  h('div', {
                    'data-breaker-billing-warning': 'true',
                    style: { fontSize: 11, color: TOKEN_TEXT_SECONDARY },
                  }, tr('breakerBillingWarning')),
                ),
              ),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                h('button', {
                  type: 'button',
                  'data-action': 'retry-compaction',
                  disabled: breakerBusy,
                  style: {
                    ...compactPrimaryButtonStyle,
                    ...(breakerBusy ? { opacity: 0.55, cursor: 'not-allowed' } : {}),
                  },
                  onClick: () => void handleRetryCompaction(),
                }, actionBusy === 'retrying'
                  ? tr('breakerRetrying')
                  : (isBypassedActive ? tr('breakerRetryBypassed') : tr('breakerRetry'))),
                canConfirmBypass
                  ? h('button', {
                      type: 'button',
                      'data-action': 'bypass-breaker',
                      disabled: breakerBusy,
                      style: {
                        ...compactButtonStyle,
                        ...(breakerBusy ? { opacity: 0.55, cursor: 'not-allowed' } : {}),
                      },
                      onClick: () => setConfirmAction(current => (current === 'bypass-breaker' ? null : 'bypass-breaker')),
                    }, tr('breakerBypass'))
                  : null,
                canRestoreBlock
                  ? h('button', {
                      type: 'button',
                      'data-action': 'restore-breaker-block',
                      disabled: breakerBusy,
                      style: {
                        ...compactButtonStyle,
                        ...(breakerBusy ? { opacity: 0.55, cursor: 'not-allowed' } : {}),
                      },
                      onClick: () => void handleBypassBreaker(false),
                    }, tr('breakerRestoreBlock'))
                  : null,
                h('button', {
                  type: 'button',
                  'data-action': 'copy-diagnostic',
                  style: compactButtonStyle,
                  onClick: () => void handleCopyDiagnostic(),
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
                ? h('div', {
                    'data-confirm': 'bypass-breaker',
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      flexWrap: 'wrap',
                      padding: '5px 8px',
                      borderRadius: 6,
                      border: '1px solid rgba(217, 119, 6, 0.35)',
                      background: 'rgba(217, 119, 6, 0.08)',
                    },
                  },
                    h('span', { style: { flex: 1, minWidth: 180, fontSize: 11, color: TOKEN_TEXT_PRIMARY } },
                      tr('breakerBypassConfirmHint')),
                    h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
                      h('button', {
                        type: 'button',
                        'data-action': 'bypass-breaker-confirm',
                        disabled: breakerBusy,
                        style: compactPrimaryButtonStyle,
                        onClick: () => void handleBypassBreaker(true),
                      }, tr('breakerBypassConfirm')),
                      h('button', {
                        type: 'button',
                        'data-action': 'bypass-breaker-cancel',
                        disabled: breakerBusy,
                        style: compactButtonStyle,
                        onClick: () => setConfirmAction(null),
                      }, tr('cancel')),
                    ),
                  )
                : null,
            ),
          );
        }

        // 3. Resumable interrupted compaction / migration banner (Scheme A)
        if (showResumeRow) {
          const isMigrationResume = resumable.trigger === 'migration';
          const resumePercent = resumable.overallPercent
            ?? (resumable.initialTotalTokens && resumable.initialTotalTokens > 0 && resumable.completedTokens !== null
              ? clampPercent((resumable.completedTokens / resumable.initialTotalTokens) * 100)
              : 0);
          const resumeDetails = [
            formatTemplate(tr('resumeProgressDetail'), {
              percent: resumePercent,
              remaining: resumable.remainingNodes,
            }),
          ];
          if (resumable.status === 'paused_budget') {
            resumeDetails.push(tr('resumePausedBudget'));
          } else if (resumable.status === 'paused_failure') {
            resumeDetails.push(tr('resumePausedFailure'));
          }
          if (resumable.canAutoResume === true) {
            resumeDetails.push(tr('resumeAutoHint'));
          }
          const resumeBusy = actionBusy !== null;
          sections.push(
            h('div', {
              key: 'resumable',
              'data-compaction-resumable': resumable.jobId,
              style: {
                ...(sections.length > 0 ? dividerStyle : {}),
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
              },
            },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                h('div', { style: { flex: 1, minWidth: 140, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                  h('span', {
                    'aria-hidden': 'true',
                    style: {
                      display: 'inline-block',
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      flexShrink: 0,
                      background: TOKEN_TEXT_WARNING,
                    },
                  }),
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
                    style: {
                      ...compactPrimaryButtonStyle,
                      ...(resumeBusy ? { opacity: 0.55, cursor: 'not-allowed' } : {}),
                    },
                    onClick: () => void handleResumeCompaction(),
                  }, actionBusy === 'resuming'
                    ? tr('resumingAction')
                    : (isMigrationResume ? tr('resumeMigrationAction') : tr('resumeCompactionAction'))),
                  h('button', {
                    type: 'button',
                    'data-action': 'discard-resume',
                    disabled: resumeBusy,
                    style: {
                      ...compactButtonStyle,
                      ...(resumeBusy ? { opacity: 0.55, cursor: 'not-allowed' } : {}),
                    },
                    onClick: () => setConfirmAction(current => (current === 'discard-resume' ? null : 'discard-resume')),
                  }, actionBusy === 'discarding' ? tr('discardingResume') : tr('discardResume')),
                ),
              ),
              confirmAction === 'discard-resume' && !resumeBusy
                ? h('div', {
                    'data-confirm': 'discard-resume',
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      flexWrap: 'wrap',
                      padding: '5px 8px',
                      borderRadius: 6,
                      border: '1px solid rgba(217, 119, 6, 0.35)',
                      background: 'rgba(217, 119, 6, 0.08)',
                    },
                  },
                    h('span', { style: { flex: 1, minWidth: 180, fontSize: 11, color: TOKEN_TEXT_PRIMARY } },
                      tr('discardResumeConfirmHint')),
                    h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
                      h('button', {
                        type: 'button',
                        'data-action': 'discard-resume-confirm',
                        disabled: actionBusy !== null,
                        style: compactPrimaryButtonStyle,
                        onClick: () => void handleConfirmDiscardResume(),
                      }, tr('discardResumeConfirm')),
                      h('button', {
                        type: 'button',
                        'data-action': 'discard-resume-cancel',
                        disabled: actionBusy !== null,
                        style: compactButtonStyle,
                        onClick: () => setConfirmAction(null),
                      }, tr('cancel')),
                    ),
                  )
                : null,
            ),
          );
        }

        // 4. STRICTLY CONDITIONAL billion-context compatibility conversion row
        if (showBiliRow) {
          const summary = buildBiliSummary(tr, bili);
          const disabledReason = bili.hasOpenTurn
            ? tr('biliWaitOpenTurn')
            : isActive
              ? tr('biliWaitBusy')
              : '';
          const convertDisabled = isActive || bili.hasOpenTurn || bili.canConvert === false;
          sections.push(
            h('div', {
              key: 'bili',
              'data-bili-compat': 'detected',
              style: {
                ...(sections.length > 0 ? dividerStyle : {}),
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
              },
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
                  style: {
                    ...compactPrimaryButtonStyle,
                    ...(convertDisabled ? { opacity: 0.55, cursor: 'not-allowed' } : {}),
                  },
                  onClick: () => setConfirmAction(current => (current === 'convert' ? null : 'convert')),
                }, actionBusy === 'migrating' ? tr('biliConverting') : tr('biliConvert')),
              ),
              confirmAction === 'convert' && !convertDisabled
                ? h('div', {
                    'data-confirm': 'bili-convert',
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      flexWrap: 'wrap',
                      padding: '5px 8px',
                      borderRadius: 6,
                      border: '1px solid rgba(217, 119, 6, 0.35)',
                      background: 'rgba(217, 119, 6, 0.08)',
                    },
                  },
                    h('span', { style: { flex: 1, minWidth: 180, fontSize: 11, color: TOKEN_TEXT_PRIMARY } }, tr('biliConvertConfirmHint')),
                    h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
                      h('button', {
                        type: 'button',
                        'data-action': 'bili-convert-confirm',
                        disabled: actionBusy !== null,
                        style: compactPrimaryButtonStyle,
                        onClick: () => void handleConfirmConvert(),
                      }, tr('biliConvertConfirm')),
                      h('button', {
                        type: 'button',
                        'data-action': 'bili-convert-cancel',
                        disabled: actionBusy !== null,
                        style: compactButtonStyle,
                        onClick: () => setConfirmAction(null),
                      }, tr('cancel')),
                    ),
                  )
                : null,
            ),
          );
        }

        // 5. Backup receipt + multi-backup selector + inline 2-step restore + restart banner
        if (showBackupRow) {
          if (pendingRestore) {
            const pendingPath = pendingRestore.backupPath || effectiveBackupPath;
            sections.push(
              h('div', {
                key: 'pending-restore',
                'data-backup-pending-restore': pendingRestore.backupId,
                style: {
                  ...(sections.length > 0 ? dividerStyle : {}),
                  padding: '6px 8px',
                  borderRadius: 6,
                  border: '1px solid rgba(217, 119, 6, 0.4)',
                  background: 'rgba(217, 119, 6, 0.1)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                },
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
                        onClick: () => void handleCopyPath(pendingPath),
                      }, copiedPath === pendingPath ? tr('copiedPath') : tr('copyPath')))
                  : null,
              ),
            );
          } else if (showRestoredBanner) {
            sections.push(
              h('div', {
                key: 'restored',
                'data-backup-restored': restoreResult.backupId,
                style: {
                  ...(sections.length > 0 ? dividerStyle : {}),
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                },
              },
                h('span', { style: { flex: 1, color: TOKEN_TEXT_SUCCESS } },
                  formatTemplate(tr('backupRestored'), { id: restoreResult.backupId })),
                h('button', {
                  type: 'button',
                  'data-action': 'dismiss-backup',
                  'aria-label': tr('dismiss'),
                  title: tr('dismiss'),
                  style: compactDismissButtonStyle,
                  onClick: () => {
                    setRestoreResult(null);
                    setMigrationReceipt(null);
                  },
                }, '×'),
              ),
            );
          } else if (effectiveBackupId) {
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
            sections.push(
              h('div', {
                key: 'backup-receipt',
                'data-backup-receipt': effectiveBackupId,
                style: {
                  ...(sections.length > 0 ? dividerStyle : {}),
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                },
              },
                receiptLead
                  ? h('div', { style: { color: TOKEN_TEXT_SUCCESS, fontWeight: 500, fontSize: 11 } }, receiptLead)
                  : null,
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                  h('div', { style: { flex: 1, minWidth: 140, display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' } },
                    h('span', {
                      title: effectiveBackupPath || effectiveBackupId,
                      style: {
                        color: TOKEN_TEXT_PRIMARY,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      },
                    }, formatTemplate(tr('backupSaved'), { id: effectiveBackupId })),
                    effectiveBackupPath
                      ? h('code', {
                          'data-backup-path': 'true',
                          title: effectiveBackupPath,
                          style: codePathStyle,
                        }, effectiveBackupPath)
                      : null,
                    effectiveBackupPath
                      ? h('button', {
                          type: 'button',
                          'data-action': 'copy-backup-path',
                          style: compactMicroButtonStyle,
                          onClick: () => void handleCopyPath(effectiveBackupPath),
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
                          style: {
                            ...compactSelectStyle,
                            ...(restoreDisabled ? { opacity: 0.55, cursor: 'not-allowed' } : {}),
                          },
                          onChange: event => {
                            setSelectedBackupId(event.target.value);
                            setConfirmAction(null);
                          },
                        }, sortedBackupItems.map(item =>
                          h('option', { key: item.backupId, value: item.backupId },
                            formatBackupOptionLabel(tr, item, backup?.originalBackupId)),
                        ))
                      : null,
                    h('button', {
                      type: 'button',
                      'data-action': 'backup-restore',
                      disabled: restoreDisabled,
                      style: {
                        ...compactButtonStyle,
                        ...(restoreDisabled ? { opacity: 0.55, cursor: 'not-allowed' } : {}),
                      },
                      onClick: () => setConfirmAction(current => (current === 'restore' ? null : 'restore')),
                    }, actionBusy === 'restoring' ? tr('backupRestoring') : tr('backupRestore')),
                    !isActive
                      ? h('button', {
                          type: 'button',
                          'data-action': 'dismiss-backup',
                          'aria-label': tr('dismiss'),
                          title: tr('dismiss'),
                          style: compactDismissButtonStyle,
                          onClick: () => {
                            setConfirmAction(null);
                            setMigrationReceipt(null);
                            if (backupReceiptKey) setDismissedBackupKey(backupReceiptKey);
                            if (terminalKey) setDismissedKey(terminalKey);
                          },
                        }, '×')
                      : null,
                  ),
                ),
                confirmAction === 'restore' && !restoreDisabled
                  ? h('div', {
                      'data-confirm': 'backup-restore',
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        flexWrap: 'wrap',
                        padding: '5px 8px',
                        borderRadius: 6,
                        border: '1px solid rgba(217, 119, 6, 0.35)',
                        background: 'rgba(217, 119, 6, 0.08)',
                      },
                    },
                      h('span', { style: { flex: 1, minWidth: 180, fontSize: 11, color: TOKEN_TEXT_PRIMARY } },
                        formatTemplate(tr('backupRestoreConfirmHint'), { id: effectiveBackupId })),
                      h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
                        h('button', {
                          type: 'button',
                          'data-action': 'backup-restore-confirm',
                          disabled: actionBusy !== null,
                          style: compactPrimaryButtonStyle,
                          onClick: () => void handleConfirmRestore(effectiveBackupId),
                        }, tr('backupRestoreConfirm')),
                        h('button', {
                          type: 'button',
                          'data-action': 'backup-restore-cancel',
                          disabled: actionBusy !== null,
                          style: compactButtonStyle,
                          onClick: () => setConfirmAction(null),
                        }, tr('cancel')),
                      ),
                    )
                  : null,
              ),
            );
          }
        }

        if (showArchiveWarning) {
          sections.push(
            h('div', {
              key: 'archive-warning',
              'data-archive-warning': 'true',
              style: {
                ...(sections.length > 0 ? dividerStyle : {}),
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
                padding: '6px 8px',
                borderRadius: 6,
                border: '1px solid rgba(217, 119, 6, 0.35)',
                background: 'rgba(217, 119, 6, 0.08)',
              },
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
                  onClick: () => setArchiveWarnDismissedKey(archiveWarnKey),
                }, '×'),
              ),
              h('div', { style: { fontSize: 11, color: TOKEN_TEXT_PRIMARY, lineHeight: 1.4 } },
                formatTemplate(tr('archiveWarnDockDetail'), {
                  total: formatBytes(archiveWarning.totalBytes),
                  warn: formatBytes(archiveWarning.warnBytes),
                })),
              h('div', { style: { fontSize: 11, color: TOKEN_TEXT_SECONDARY, lineHeight: 1.35 } },
                tr('archiveWarnDockNoAutoDelete')),
            ),
          );
        }

        return h('div', {
          role: 'status',
          'aria-live': 'polite',
          'data-compaction-progress': isActive
            ? activePhase
            : showBreakerRow
              ? (isBypassedActive ? 'breaker-bypassed' : 'breaker-blocked')
              : (showResumeRow ? 'resumable' : (showBiliRow ? 'bili-detected' : (showBiliConflict ? 'bili-conflict' : (showArchiveWarning ? 'archive-warning' : status.phase)))),
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
        const [provider, setProvider] = React.useState('');
        const [model, setModel] = React.useState('');
        const [maxTokens, setMaxTokens] = React.useState('');
        const [thresholdRatio, setThresholdRatio] = React.useState(80);
        const [minimumReductionRatio, setMinimumReductionRatio] = React.useState(20);
        const [retryCount, setRetryCount] = React.useState('2');
        const [retryDelay, setRetryDelay] = React.useState('1');
        const [summaryTimeout, setSummaryTimeout] = React.useState('180');
        const [summaryConcurrency, setSummaryConcurrency] = React.useState('2');
        const [summaryReasoningEffort, setSummaryReasoningEffort] = React.useState('low');
        const [concurrencyTouched, setConcurrencyTouched] = React.useState(false);
        const [reasoningTouched, setReasoningTouched] = React.useState(false);
        const [idlePreset, setIdlePreset] = React.useState('0');
        const [idleCustomMinutes, setIdleCustomMinutes] = React.useState('');
        const [auditBlockOnLoss, setAuditBlockOnLoss] = React.useState(true);
        const [auditExhaustionPolicy, setAuditExhaustionPolicy] = React.useState('fallback');
        const [auditExhaustionTouched, setAuditExhaustionTouched] = React.useState(false);
        const [pressureBreakerAction, setPressureBreakerAction] = React.useState('confirm');
        const [pressureBreakerTouched, setPressureBreakerTouched] = React.useState(false);
        const [postCompactReinjectEnabled, setPostCompactReinjectEnabled] = React.useState(true);
        const [reinjectTouched, setReinjectTouched] = React.useState(false);
        const [persistedOutputEnabled, setPersistedOutputEnabled] = React.useState(true);
        const [persistedOutputTouched, setPersistedOutputTouched] = React.useState(false);
        const [microcompactEnabled, setMicrocompactEnabled] = React.useState(true);
        const [microcompactTouched, setMicrocompactTouched] = React.useState(false);
        const [sessionMemoryEnabled, setSessionMemoryEnabled] = React.useState(false);
        const [sessionMemoryTouched, setSessionMemoryTouched] = React.useState(false);
        const [sessionMemoryMaxCalls, setSessionMemoryMaxCalls] = React.useState('8');
        const [sessionMemoryMaxCallsTouched, setSessionMemoryMaxCallsTouched] = React.useState(false);
        const [contextCollapseEnabled, setContextCollapseEnabled] = React.useState(false);
        const [contextCollapseTouched, setContextCollapseTouched] = React.useState(false);
        const [snipEnabled, setSnipEnabled] = React.useState(true);
        const [snipTouched, setSnipTouched] = React.useState(false);
        const [archiveWarnMb, setArchiveWarnMb] = React.useState('512');
        const [archiveWarnTouched, setArchiveWarnTouched] = React.useState(false);
        const [archiveStorage, setArchiveStorage] = React.useState(null);
        const [archiveBusy, setArchiveBusy] = React.useState(null);
        const [archiveFeedback, setArchiveFeedback] = React.useState(null);
        const [archiveCleanupConfirm, setArchiveCleanupConfirm] = React.useState(false);
        const [catalog, setCatalog] = React.useState([]);
        const [catalogError, setCatalogError] = React.useState(null);
        const [saving, setSaving] = React.useState(false);
        const [status, setStatus] = React.useState(null);
        const [biliConflict, setBiliConflict] = React.useState(null);

        function syncPhaseBToggles(config) {
          const hasPersistedOutput = typeof config?.persistedOutputEnabled === 'boolean';
          setPersistedOutputEnabled(hasPersistedOutput ? config.persistedOutputEnabled : true);
          setPersistedOutputTouched(hasPersistedOutput);
          const hasMicrocompact = typeof config?.microcompactEnabled === 'boolean';
          setMicrocompactEnabled(hasMicrocompact ? config.microcompactEnabled : true);
          setMicrocompactTouched(hasMicrocompact);
        }

        function syncPhaseCToggles(config) {
          const hasSessionMemory = typeof config?.sessionMemoryEnabled === 'boolean';
          setSessionMemoryEnabled(hasSessionMemory ? config.sessionMemoryEnabled : false);
          setSessionMemoryTouched(hasSessionMemory);
          const hasMaxCalls = Number.isInteger(config?.sessionMemoryMaxCallsPerSession) &&
            config.sessionMemoryMaxCallsPerSession >= 1 &&
            config.sessionMemoryMaxCallsPerSession <= 100;
          setSessionMemoryMaxCalls(String(hasMaxCalls ? config.sessionMemoryMaxCallsPerSession : 8));
          setSessionMemoryMaxCallsTouched(hasMaxCalls);
          const hasContextCollapse = typeof config?.contextCollapseEnabled === 'boolean';
          setContextCollapseEnabled(hasContextCollapse ? config.contextCollapseEnabled : false);
          setContextCollapseTouched(hasContextCollapse);
        }

        function syncPhaseDToggles(config) {
          const hasSnip = typeof config?.snipEnabled === 'boolean';
          setSnipEnabled(hasSnip ? config.snipEnabled : true);
          setSnipTouched(hasSnip);
        }

        function syncArchiveWarn(config) {
          const rawWarn = config?.archiveWarnBytes;
          const hasWarn = Number.isInteger(rawWarn) && rawWarn >= 0;
          if (!hasWarn) {
            setArchiveWarnMb('512');
            setArchiveWarnTouched(false);
            return;
          }
          const mb = rawWarn === 0 ? 0 : Math.max(1, Math.round(rawWarn / (1024 * 1024)));
          setArchiveWarnMb(String(mb));
          setArchiveWarnTouched(rawWarn === 0 || rawWarn % (1024 * 1024) === 0);
        }

        async function handleCompressLegacy() {
          if (archiveBusy) return;
          setArchiveBusy('compress');
          setArchiveFeedback(null);
          try {
            const res = await rpc('archive-compress-legacy');
            if (res?.storage) setArchiveStorage(normalizeArchiveStorage(res.storage));
            setArchiveFeedback({
              kind: Number(res?.failedCount) > 0 ? 'warning' : 'success',
              text: formatTemplate(t('archiveCompressDone'), {
                count: nonNegativeInt(res?.compressedCount),
                saved: formatBytes(res?.bytesSaved ?? 0),
                failed: nonNegativeInt(res?.failedCount),
              }),
            });
          } catch (error) {
            setArchiveFeedback({
              kind: 'error',
              text: formatTemplate(t('archiveCompressFailed'), { error: error?.message ?? String(error) }),
            });
          } finally {
            setArchiveBusy(null);
          }
        }

        async function handleCleanupOrphans() {
          if (archiveBusy) return;
          setArchiveBusy('cleanup');
          setArchiveFeedback(null);
          try {
            const res = await rpc('archive-cleanup-orphans', { confirmDelete: true });
            if (res?.storage) setArchiveStorage(normalizeArchiveStorage(res.storage));
            setArchiveCleanupConfirm(false);
            if (res?.supported === false) {
              setArchiveFeedback({ kind: 'warning', text: t('archiveCleanupUnavailable') });
            } else {
              setArchiveFeedback({
                kind: 'success',
                text: formatTemplate(t('archiveCleanupDone'), {
                  count: nonNegativeInt(res?.deletedSessions),
                  bytes: formatBytes(res?.freedBytes ?? 0),
                }),
              });
            }
          } catch (error) {
            setArchiveFeedback({
              kind: 'error',
              text: formatTemplate(t('archiveCleanupFailed'), { error: error?.message ?? String(error) }),
            });
          } finally {
            setArchiveBusy(null);
          }
        }

        function load() {
          let alive = true;
          setLoading(true);
          setCatalogError(null);
          Promise.allSettled([rpc('get'), rpc('models')])
            .then(([configResult, catalogResult]) => {
              if (!alive) return;
              if (configResult.status === 'fulfilled') {
                setBiliConflict(normalizeBiliConflict(configResult.value?.biliConflict));
                setArchiveStorage(normalizeArchiveStorage(configResult.value?.archiveStorage));
                const config = configResult.value?.config ?? null;
                syncArchiveWarn(config);
                setArchiveCleanupConfirm(false);
                const idle = String(config?.idleCompactionMinutes ?? 0);
                setIdlePreset(IDLE_PRESETS.includes(idle) ? idle : 'custom');
                setIdleCustomMinutes(IDLE_PRESETS.includes(idle) ? '' : idle);
                setAuditBlockOnLoss(typeof config?.auditBlockOnLoss === 'boolean' ? config.auditBlockOnLoss : true);
                const hasExhaustionPolicy = AUDIT_EXHAUSTION_POLICIES.includes(config?.auditExhaustionPolicy);
                setAuditExhaustionPolicy(hasExhaustionPolicy ? config.auditExhaustionPolicy : 'fallback');
                setAuditExhaustionTouched(hasExhaustionPolicy);
                const hasBreakerAction = PRESSURE_BREAKER_ACTIONS.includes(config?.pressureBreakerAction);
                setPressureBreakerAction(hasBreakerAction ? config.pressureBreakerAction : 'confirm');
                setPressureBreakerTouched(hasBreakerAction);
                const hasReinject = typeof config?.postCompactReinjectEnabled === 'boolean';
                setPostCompactReinjectEnabled(hasReinject ? config.postCompactReinjectEnabled : true);
                setReinjectTouched(hasReinject);
                syncPhaseBToggles(config);
                syncPhaseCToggles(config);
                syncPhaseDToggles(config);
                const hasConcurrency = Number.isInteger(config?.summaryConcurrency) && config.summaryConcurrency >= 1 && config.summaryConcurrency <= 6;
                setSummaryConcurrency(String(hasConcurrency ? config.summaryConcurrency : 2));
                setConcurrencyTouched(hasConcurrency);
                const hasReasoning = SUMMARY_REASONING_EFFORTS.includes(config?.summaryReasoningEffort);
                setSummaryReasoningEffort(hasReasoning ? config.summaryReasoningEffort : 'low');
                setReasoningTouched(hasReasoning);
                if (config) {
                  setRetryCount(String(config.summaryRetryCount ?? 2));
                  setRetryDelay(String((config.summaryRetryDelayMs ?? 1000) / 1000));
                  setSummaryTimeout(String((config.summaryTimeoutMs ?? 180000) / 1000));
                  setProvider(config.provider ?? '');
                  setModel(config.model ?? '');
                  setMaxTokens(config.maxTokens === null || config.maxTokens === undefined ? '' : String(config.maxTokens));
                  setThresholdRatio(typeof config.thresholdRatio === 'number' ? Math.round(config.thresholdRatio * 100) : 80);
                  setMinimumReductionRatio(typeof config.minimumReductionRatio === 'number' ? Math.round(config.minimumReductionRatio * 100) : 20);
                }
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

        const providerOptions = [{ value: '', label: t('followSession') }];
        for (const entry of catalog) {
          const id = String(entry?.provider ?? '');
          if (id === '') continue;
          providerOptions.push({
            value: id,
            label: entry.name && entry.name !== id ? `${entry.name} (${id})` : id,
          });
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

        function onProviderChange(event) {
          const next = event.target.value;
          setProvider(next);
          const entry = catalog.find(item => item?.provider === next);
          setModel(entry?.models?.[0]?.id ?? '');
        }

        function validate(clear = false) {
          const idleText = String(idlePreset === 'custom' ? idleCustomMinutes : idlePreset).trim();
          const idle = Number(idleText);
          if (!/^\d+$/.test(idleText) || !Number.isInteger(idle) || idle < (idlePreset === 'custom' ? 1 : 0) || idle > MAX_IDLE_COMPACTION_MINUTES ||
              (idlePreset !== 'custom' && !IDLE_PRESETS.includes(idlePreset))) return t('idleRange');
          const retryCountText = String(retryCount).trim();
          const retries = Number(retryCountText);
          if (retryCountText === '' || !Number.isInteger(retries) || retries < 0 || retries > 4) return t('retryCountRange');
          const retryDelayText = String(retryDelay).trim();
          const delay = Number(retryDelayText) * 1000;
          if (retryDelayText === '' || !Number.isInteger(delay) || delay < 0 || delay > 30000) return t('retryDelayRange');
          const timeoutText = String(summaryTimeout).trim();
          const timeout = Number(timeoutText) * 1000;
          if (timeoutText === '' || !Number.isInteger(timeout) || timeout < 5000 || timeout > 3600000) return t('summaryTimeoutRange');
          const concurrencyText = String(summaryConcurrency).trim();
          const concurrency = Number(concurrencyText);
          if (concurrencyText === '' || !/^\d+$/.test(concurrencyText) || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) return t('concurrencyRange');
          const maxCallsText = String(sessionMemoryMaxCalls).trim();
          const maxCalls = Number(maxCallsText);
          if (maxCallsText === '' || !/^\d+$/.test(maxCallsText) || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 100) return t('sessionMemoryMaxCallsRange');
          const archiveWarnText = String(archiveWarnMb ?? '').trim();
          const archiveWarnMbNum = archiveWarnText === '' ? NaN : Number(archiveWarnText);
          if (archiveWarnText === '' || !/^\d+$/.test(archiveWarnText) || !Number.isInteger(archiveWarnMbNum) || archiveWarnMbNum < 0 || archiveWarnMbNum > 102400) {
            return t('archiveWarnMbRange');
          }
          if (!SUMMARY_REASONING_EFFORTS.includes(summaryReasoningEffort)) return t('reasoningEffortRange');
          if (!AUDIT_EXHAUSTION_POLICIES.includes(auditExhaustionPolicy)) return t('auditExhaustionPolicyRange');
          if (!PRESSURE_BREAKER_ACTIONS.includes(pressureBreakerAction)) return t('pressureBreakerActionRange');
          const p = provider.trim();
          const m = model.trim();
          if (!clear && (p === '') !== (m === '')) return t('pair');
          if (!Number.isInteger(thresholdRatio) || thresholdRatio < 50 || thresholdRatio > 95) return t('triggerRange');
          if (!Number.isInteger(minimumReductionRatio) || minimumReductionRatio < 5 || minimumReductionRatio > 90) return t('reductionRange');
          const v = maxTokens.trim();
          if (!clear && v !== '') {
            const number = Number(v);
            if (!Number.isInteger(number) || number < 1 || number > 1_000_000) return t('badMax');
          }
          return null;
        }

        async function submit(clear) {
          const problem = validate(clear);
          if (problem) {
            setStatus({ kind: 'error', text: problem });
            return;
          }
          setSaving(true);
          setStatus(null);
          try {
            const params = clear
              ? { provider: '', model: '', maxTokens: null, thresholdRatio: thresholdRatio / 100, minimumReductionRatio: minimumReductionRatio / 100 }
              : {
                  provider: provider.trim(),
                  model: model.trim(),
                  maxTokens: maxTokens.trim() === '' ? null : Number(maxTokens),
                  thresholdRatio: thresholdRatio / 100,
                  minimumReductionRatio: minimumReductionRatio / 100,
                };
            Object.assign(params, {
              summaryRetryCount: Number(retryCount),
              summaryRetryDelayMs: Number(retryDelay) * 1000,
              summaryTimeoutMs: Number(summaryTimeout) * 1000,
            });
            params.idleCompactionMinutes = Number(idlePreset === 'custom' ? idleCustomMinutes : idlePreset);
            params.auditBlockOnLoss = Boolean(auditBlockOnLoss);
            if (auditExhaustionTouched) params.auditExhaustionPolicy = auditExhaustionPolicy;
            if (concurrencyTouched) params.summaryConcurrency = Number(summaryConcurrency);
            if (reasoningTouched) params.summaryReasoningEffort = summaryReasoningEffort;
            if (pressureBreakerTouched) params.pressureBreakerAction = pressureBreakerAction;
            if (reinjectTouched) params.postCompactReinjectEnabled = Boolean(postCompactReinjectEnabled);
            if (persistedOutputTouched) params.persistedOutputEnabled = Boolean(persistedOutputEnabled);
            if (microcompactTouched) params.microcompactEnabled = Boolean(microcompactEnabled);
            if (sessionMemoryTouched) params.sessionMemoryEnabled = Boolean(sessionMemoryEnabled);
            if (sessionMemoryMaxCallsTouched) params.sessionMemoryMaxCallsPerSession = Number(sessionMemoryMaxCalls);
            if (contextCollapseTouched) params.contextCollapseEnabled = Boolean(contextCollapseEnabled);
            if (snipTouched) params.snipEnabled = Boolean(snipEnabled);
            if (archiveWarnTouched) params.archiveWarnBytes = Number(String(archiveWarnMb).trim()) * 1024 * 1024;
            const result = await rpc('set', params);
            if (archiveWarnTouched) {
              const nextWarnBytes = params.archiveWarnBytes;
              setArchiveStorage(prev => (
                prev
                  ? {
                      ...prev,
                      warnBytes: nextWarnBytes,
                      warnExceeded: nextWarnBytes > 0 && prev.totalBytes >= nextWarnBytes,
                    }
                  : prev
              ));
            }
            if (result && Object.hasOwn(result, 'config')) {
              syncPhaseBToggles(result.config);
              syncPhaseCToggles(result.config);
              syncPhaseDToggles(result.config);
              syncArchiveWarn(result.config);
            }
            if (clear) {
              setProvider('');
              setModel('');
              setMaxTokens('');
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

        if (loading) {
          return h('section', { style: { maxWidth: 640, padding: '12px 16px' } }, h('p', { style: mutedStyle }, t('loading')));
        }

        const idleControl = h('div', { style: fieldStyle },
          h('label', { style: labelStyle, htmlFor: 'weave-idle-compaction' }, t('idleCompaction')),
          h('select', {
            id: 'weave-idle-compaction',
            style: inputStyle,
            value: idlePreset,
            'aria-describedby': 'weave-idle-duration-hint weave-idle-hint weave-idle-trigger-hint',
            onChange: event => setIdlePreset(event.target.value),
          },
            IDLE_PRESETS.map(value => h('option', { key: value, value }, t(value === '0' ? 'idleOff' : `idle${value}`))),
            h('option', { value: 'custom' }, t('idleCustom')),
          ),
        );

        const idleCustomControl = idlePreset !== 'custom'
          ? null
          : h('div', { style: fieldStyle },
              h('label', { style: labelStyle, htmlFor: 'weave-idle-custom-minutes' }, t('idleCustomMinutes')),
              h('input', {
                id: 'weave-idle-custom-minutes', type: 'number', min: 1, max: MAX_IDLE_COMPACTION_MINUTES, step: 1,
                style: inputStyle, value: idleCustomMinutes,
                'aria-describedby': 'weave-idle-duration-hint weave-idle-hint weave-idle-trigger-hint',
                onChange: event => setIdleCustomMinutes(event.target.value),
              }),
            );

        function renderToggleRow(item) {
          return h('div', { key: item.id, style: fieldStyle },
            h('label', { style: labelStyle, htmlFor: item.id }, t(item.labelKey)),
            h('select', {
              id: item.id,
              style: inputStyle,
              value: item.value ? 'true' : 'false',
              'aria-describedby': `${item.id}-hint`,
              onChange: event => item.onSelect(event.target.value !== 'false'),
            },
              h('option', { value: 'true' }, t(item.onKey)),
              h('option', { value: 'false' }, t(item.offKey)),
            ),
            h('p', { id: `${item.id}-hint`, style: mutedStyle }, t(item.hintKey)),
          );
        }

        return h(
          'section',
          { style: { maxWidth: 640, width: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 16px' } },
          h('header', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            h('h2', { style: { fontSize: 16, fontWeight: 600, margin: 0, color: TOKEN_TEXT_PRIMARY } }, t('title')),
            h('p', { style: mutedStyle }, t('intro')),
          ),
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
            h('div', { style: fieldStyle },
              h('label', { style: labelStyle, htmlFor: 'weave-summary-provider' }, t('provider')),
              h('select', {
                id: 'weave-summary-provider',
                style: inputStyle,
                value: provider,
                onChange: onProviderChange,
              }, providerOptions.map(option => h('option', { key: option.value, value: option.value }, option.label))),
            ),
            h('div', { style: fieldStyle },
              h('label', { style: labelStyle, htmlFor: 'weave-summary-model' }, t('model')),
              h('select', {
                id: 'weave-summary-model',
                style: inputStyle,
                value: model,
                disabled: provider === '' || modelOptions.length === 0,
                onChange: event => setModel(event.target.value),
              }, modelOptions.length === 0
                ? h('option', { value: '' }, provider === '' ? t('followSession') : t('noModels'))
                : modelOptions.map(option => h('option', { key: option.value, value: option.value }, option.label))),
            ),
          ),
          h('div', { style: row2Style },
            h('div', { style: fieldStyle },
              h('label', { style: labelStyle, htmlFor: 'weave-summary-max-tokens' }, t('maxTokens')),
              h('select', {
                id: 'weave-summary-max-tokens',
                style: inputStyle,
                value: maxTokens,
                onChange: event => setMaxTokens(event.target.value),
              }, maxOptions.map(option => h('option', { key: option.value, value: option.value }, option.label))),
            ),
            h('div', { style: fieldStyle },
              h('label', { style: labelStyle, htmlFor: 'weave-summary-retry-count' }, t('retryCount')),
              h('input', { id: 'weave-summary-retry-count', type: 'number', min: 0, max: 4, step: 1, style: inputStyle, value: retryCount, onChange: event => setRetryCount(event.target.value) }),
              h('p', { style: mutedStyle }, t('retryHint').replace('{count}', String(retryCount)).replace('{total}', String(Number(retryCount) + 1))),
            ),
          ),
          h('div', { style: row2Style },
            h('div', { style: fieldStyle },
              h('label', { style: labelStyle, htmlFor: 'weave-summary-retry-delay' }, t('retryDelay')),
              h('input', { id: 'weave-summary-retry-delay', type: 'number', min: 0, max: 30, step: 0.001, style: inputStyle, value: retryDelay, onChange: event => setRetryDelay(event.target.value) }),
              h('p', { style: mutedStyle }, t('retryDelayHint')),
            ),
            h('div', { style: fieldStyle },
              h('label', { style: labelStyle, htmlFor: 'weave-summary-timeout' }, t('summaryTimeout')),
              h('input', { id: 'weave-summary-timeout', type: 'number', min: 5, max: 3600, step: 1, style: inputStyle, value: summaryTimeout, onChange: event => setSummaryTimeout(event.target.value) }),
              h('p', { style: mutedStyle }, t('timeoutHint')),
            ),
          ),
          h('div', { style: row2Style },
            h('div', { style: fieldStyle },
              h('label', { style: labelStyle, htmlFor: 'weave-summary-concurrency' }, t('summaryConcurrency')),
              h('input', {
                id: 'weave-summary-concurrency',
                type: 'number',
                min: 1,
                max: 6,
                step: 1,
                style: inputStyle,
                value: summaryConcurrency,
                onChange: event => {
                  setSummaryConcurrency(event.target.value);
                  setConcurrencyTouched(true);
                },
              }),
              h('p', { style: mutedStyle }, t('summaryConcurrencyHint')),
            ),
            h('div', { style: fieldStyle },
              h('label', { style: labelStyle, htmlFor: 'weave-summary-reasoning-effort' }, t('summaryReasoningEffort')),
              h('select', {
                id: 'weave-summary-reasoning-effort',
                style: inputStyle,
                value: summaryReasoningEffort,
                onChange: event => {
                  setSummaryReasoningEffort(event.target.value);
                  setReasoningTouched(true);
                },
              },
                h('option', { value: 'low' }, t('summaryReasoningLow')),
                h('option', { value: 'none' }, t('summaryReasoningNone')),
                h('option', { value: 'minimal' }, t('summaryReasoningMinimal')),
                h('option', { value: 'medium' }, t('summaryReasoningMedium')),
                h('option', { value: 'high' }, t('summaryReasoningHigh')),
                h('option', { value: 'xhigh' }, t('summaryReasoningXhigh')),
                h('option', { value: 'max' }, t('summaryReasoningMax')),
                h('option', { value: 'inherit' }, t('summaryReasoningInherit')),
              ),
              h('p', { style: mutedStyle }, t('summaryReasoningHint')),
            ),
          ),
          h('div', { style: row2Style },
            h('div', { style: fieldStyle },
              h('label', { style: labelStyle, htmlFor: 'weave-summary-threshold' }, t('trigger')),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('input', {
                  id: 'weave-summary-threshold',
                  type: 'range',
                  min: 50,
                  max: 95,
                  step: 1,
                  value: thresholdRatio,
                  style: { flex: 1, accentColor: TOKEN_ACCENT },
                  'aria-label': t('trigger'),
                  onChange: event => setThresholdRatio(Number(event.target.value)),
                }),
                h('span', { style: { minWidth: 36, textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: TOKEN_TEXT_PRIMARY } }, `${thresholdRatio}%`),
              ),
              h('p', { style: mutedStyle }, t('triggerHint').replace('{pct}', String(thresholdRatio))),
            ),
            h('div', { style: fieldStyle },
              h('label', { style: labelStyle, htmlFor: 'weave-minimum-reduction' }, t('minimumReduction')),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('input', {
                  id: 'weave-minimum-reduction', type: 'range', min: 5, max: 90, step: 1,
                  value: minimumReductionRatio,
                  style: { flex: 1, accentColor: TOKEN_ACCENT },
                  'aria-label': t('minimumReduction'),
                  onChange: event => setMinimumReductionRatio(Number(event.target.value)),
                }),
                h('span', { style: { minWidth: 36, textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: TOKEN_TEXT_PRIMARY } }, `${minimumReductionRatio}%`),
              ),
              h('p', { style: mutedStyle }, t('reductionHint').replace('{pct}', String(minimumReductionRatio))),
            ),
          ),
          h('div', { style: fieldStyle },
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
                h('p', { style: mutedStyle }, [
                  ['OpenAI', 'https://developers.openai.com/api/docs/guides/prompt-caching'],
                  ['Claude', 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching'],
                  ['Gemini', 'https://ai.google.dev/gemini-api/docs/caching'],
                  ['DeepSeek', 'https://api-docs.deepseek.com/guides/kv_cache/'],
                  ['GLM', 'https://docs.bigmodel.cn/cn/guide/capabilities/cache'],
                ].map(([label, href]) => h('a', { key: label, href, target: '_blank', rel: 'noopener noreferrer', style: { marginRight: 10, color: 'inherit' } }, label))),
              ),
            ),
          ),
          h('div', { style: fieldStyle },
            h('label', { style: labelStyle, htmlFor: 'weave-audit-block-on-loss' }, t('auditBlockOnLoss')),
            h('select', {
              id: 'weave-audit-block-on-loss',
              style: inputStyle,
              value: auditBlockOnLoss ? 'true' : 'false',
              onChange: event => setAuditBlockOnLoss(event.target.value !== 'false'),
            },
              h('option', { value: 'true' }, t('auditBlockOnLossOn')),
              h('option', { value: 'false' }, t('auditBlockOnLossOff')),
            ),
            h('p', { style: mutedStyle }, t('auditBlockOnLossHint')),
          ),
          h('div', { style: fieldStyle },
            h('label', { style: labelStyle, htmlFor: 'weave-audit-exhaustion-policy' }, t('auditExhaustionPolicy')),
            h('select', {
              id: 'weave-audit-exhaustion-policy',
              style: inputStyle,
              value: auditExhaustionPolicy,
              onChange: event => {
                setAuditExhaustionPolicy(event.target.value);
                setAuditExhaustionTouched(true);
              },
            },
              h('option', { value: 'fallback' }, t('auditExhaustionFallback')),
              h('option', { value: 'block' }, t('auditExhaustionBlock')),
            ),
            h('p', { style: mutedStyle }, t('auditExhaustionPolicyHint')),
          ),
          h('div', { style: fieldStyle },
            h('label', { style: labelStyle, htmlFor: 'weave-pressure-breaker-action' }, t('pressureBreakerAction')),
            h('select', {
              id: 'weave-pressure-breaker-action',
              style: inputStyle,
              value: pressureBreakerAction,
              onChange: event => {
                setPressureBreakerAction(event.target.value);
                setPressureBreakerTouched(true);
              },
            },
              h('option', { value: 'confirm' }, t('pressureBreakerConfirm')),
              h('option', { value: 'degrade' }, t('pressureBreakerDegrade')),
              h('option', { value: 'block' }, t('pressureBreakerBlock')),
            ),
            h('p', { style: mutedStyle }, t('pressureBreakerActionHint')),
          ),
          h('div', { style: fieldStyle },
            h('label', { style: labelStyle, htmlFor: 'weave-post-compact-reinject' }, t('postCompactReinject')),
            h('select', {
              id: 'weave-post-compact-reinject',
              style: inputStyle,
              value: postCompactReinjectEnabled ? 'true' : 'false',
              onChange: event => {
                setPostCompactReinjectEnabled(event.target.value !== 'false');
                setReinjectTouched(true);
              },
            },
              h('option', { value: 'true' }, t('postCompactReinjectOn')),
              h('option', { value: 'false' }, t('postCompactReinjectOff')),
            ),
            h('p', { style: mutedStyle }, t('postCompactReinjectHint')),
          ),
          ...[
            {
              id: 'weave-persisted-output',
              labelKey: 'persistedOutput',
              value: persistedOutputEnabled,
              onKey: 'persistedOutputOn',
              offKey: 'persistedOutputOff',
              hintKey: 'persistedOutputHint',
              onSelect: next => {
                setPersistedOutputEnabled(next);
                setPersistedOutputTouched(true);
              },
            },
            {
              id: 'weave-microcompact',
              labelKey: 'microcompact',
              value: microcompactEnabled,
              onKey: 'microcompactOn',
              offKey: 'microcompactOff',
              hintKey: 'microcompactHint',
              onSelect: next => {
                setMicrocompactEnabled(next);
                setMicrocompactTouched(true);
              },
            },
            {
              id: 'weave-snip',
              labelKey: 'snip',
              value: snipEnabled,
              onKey: 'snipOn',
              offKey: 'snipOff',
              hintKey: 'snipHint',
              onSelect: next => {
                setSnipEnabled(next);
                setSnipTouched(true);
              },
            },
          ].map(renderToggleRow),
          h('div', { style: row2Style },
            h('div', { style: fieldStyle },
              h('span', { style: labelStyle }, t('sessionMemoryEnabled')),
              h('label', {
                htmlFor: 'weave-session-memory-enabled',
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  minHeight: 28,
                  fontSize: 12,
                  color: TOKEN_TEXT_PRIMARY,
                  cursor: 'pointer',
                },
              },
                h('input', {
                  id: 'weave-session-memory-enabled',
                  type: 'checkbox',
                  checked: Boolean(sessionMemoryEnabled),
                  'aria-describedby': 'weave-session-memory-hint',
                  style: { accentColor: TOKEN_ACCENT, margin: 0 },
                  onChange: event => {
                    const next = typeof event?.target?.checked === 'boolean'
                      ? event.target.checked
                      : event?.target?.value === true || event?.target?.value === 'true';
                    setSessionMemoryEnabled(next);
                    setSessionMemoryTouched(true);
                  },
                }),
                h('span', null, t('sessionMemoryEnabledToggle')),
              ),
              h('p', { id: 'weave-session-memory-hint', style: mutedStyle }, t('sessionMemoryHint')),
            ),
            h('div', { style: { ...fieldStyle, ...(sessionMemoryEnabled ? {} : { opacity: 0.65 }) } },
              h('label', { style: labelStyle, htmlFor: 'weave-session-memory-max-calls' }, t('sessionMemoryMaxCalls')),
              h('input', {
                id: 'weave-session-memory-max-calls',
                type: 'number',
                min: 1,
                max: 100,
                step: 1,
                style: inputStyle,
                value: sessionMemoryMaxCalls,
                'aria-describedby': 'weave-session-memory-max-calls-hint',
                onChange: event => {
                  setSessionMemoryMaxCalls(event.target.value);
                  setSessionMemoryMaxCallsTouched(true);
                },
              }),
              h('p', { id: 'weave-session-memory-max-calls-hint', style: mutedStyle }, t('sessionMemoryMaxCallsHint')),
            ),
          ),
          h('div', { style: fieldStyle },
            h('span', { style: labelStyle }, t('contextCollapseEnabled')),
            h('label', {
              htmlFor: 'weave-context-collapse-enabled',
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                minHeight: 26,
                fontSize: 12,
                color: TOKEN_TEXT_PRIMARY,
                cursor: 'pointer',
              },
            },
              h('input', {
                id: 'weave-context-collapse-enabled',
                type: 'checkbox',
                checked: Boolean(contextCollapseEnabled),
                'aria-describedby': 'weave-context-collapse-hint',
                style: { accentColor: TOKEN_ACCENT, margin: 0 },
                onChange: event => {
                  const next = typeof event?.target?.checked === 'boolean'
                    ? event.target.checked
                    : event?.target?.value === true || event?.target?.value === 'true';
                  setContextCollapseEnabled(next);
                  setContextCollapseTouched(true);
                },
              }),
              h('span', null, t('contextCollapseEnabledToggle')),
            ),
            h('p', { id: 'weave-context-collapse-hint', style: mutedStyle }, t('contextCollapseHint')),
          ),
          h('div', {
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
              ? h('div', {
                  'data-archive-stats': 'true',
                  style: { ...mutedStyle, fontVariantNumeric: 'tabular-nums' },
                }, formatTemplate(t('archiveStorageStats'), {
                  total: formatBytes(archiveStorage.totalBytes),
                  backup: formatBytes(archiveStorage.backupBytes),
                  sessions: archiveStorage.sessionCount,
                  legacy: archiveStorage.legacyPlainSpanCount,
                }))
              : null,
            archiveStorage?.warnExceeded === true
              ? h('div', {
                  'data-archive-warn-banner': 'true',
                  style: {
                    fontSize: 11,
                    lineHeight: 1.4,
                    color: TOKEN_TEXT_WARNING,
                    padding: '6px 8px',
                    borderRadius: 6,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: 'rgba(217, 119, 6, 0.35)',
                    background: 'rgba(217, 119, 6, 0.08)',
                  },
                }, formatTemplate(t('archiveStorageWarnBanner'), {
                  warn: formatBytes(archiveStorage.warnBytes),
                }))
              : null,
            h('div', { style: fieldStyle },
              h('label', { htmlFor: 'weave-archive-warn-mb', style: labelStyle }, t('archiveWarnMb')),
              h('input', {
                id: 'weave-archive-warn-mb',
                type: 'number',
                min: 0,
                max: 102400,
                step: 1,
                'data-field': 'archiveWarnMb',
                value: archiveWarnMb,
                disabled: loading || saving,
                style: inputStyle,
                onChange: e => {
                  setArchiveWarnMb(e.target.value);
                  setArchiveWarnTouched(true);
                },
              }),
              h('p', { id: 'weave-archive-warn-mb-hint', style: mutedStyle }, t('archiveWarnMbHint')),
            ),
            h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('button', {
                type: 'button',
                'data-action': 'archive-compress-legacy',
                disabled: Boolean(loading || saving || archiveBusy !== null || !archiveStorage || archiveStorage.legacyPlainSpanCount === 0),
                style: {
                  ...buttonStyle,
                  ...(Boolean(loading || saving || archiveBusy !== null || !archiveStorage || archiveStorage.legacyPlainSpanCount === 0)
                    ? { opacity: 0.55, cursor: 'not-allowed' }
                    : {}),
                },
                onClick: () => void handleCompressLegacy(),
              }, archiveBusy === 'compress' ? t('archiveCompressing') : t('archiveCompressLegacy')),
              h('button', {
                type: 'button',
                'data-action': 'archive-cleanup-orphans',
                disabled: Boolean(loading || saving || archiveBusy !== null || !archiveStorage || !archiveStorage.orphanProbeAvailable || archiveStorage.orphanSessionCount === 0),
                style: {
                  ...buttonStyle,
                  ...(Boolean(loading || saving || archiveBusy !== null || !archiveStorage || !archiveStorage.orphanProbeAvailable || archiveStorage.orphanSessionCount === 0)
                    ? { opacity: 0.55, cursor: 'not-allowed' }
                    : {}),
                },
                onClick: () => setArchiveCleanupConfirm(v => !v),
              }, t('archiveCleanupOrphans')),
            ),
            archiveStorage && !archiveStorage.orphanProbeAvailable
              ? h('p', { 'data-archive-probe-unavailable': 'true', style: mutedStyle }, t('archiveCleanupUnavailable'))
              : null,
            archiveCleanupConfirm && archiveStorage?.orphanProbeAvailable && archiveStorage.orphanSessionCount > 0
              ? h('div', {
                  'data-confirm': 'archive-cleanup-orphans',
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    padding: '6px 8px',
                    borderRadius: 6,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: 'rgba(217, 119, 6, 0.35)',
                    background: 'rgba(217, 119, 6, 0.08)',
                  },
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
                      onClick: () => void handleCleanupOrphans(),
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
          ),
          catalogError === null
            ? null
            : h('p', { style: { ...mutedStyle, color: TOKEN_TEXT_ERROR } },
                `${t('catalogError')}: ${catalogError}`),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h('button', { type: 'button', style: primaryStyle, disabled: saving, onClick: () => void submit(false) },
              saving ? t('saving') : t('save')),
            h('button', { type: 'button', style: buttonStyle, disabled: saving, onClick: () => void submit(true) },
              t('clear')),
            catalogError === null
              ? null
              : h('button', { type: 'button', style: buttonStyle, disabled: saving, onClick: () => void load() },
                  t('reloadModels')),
          ),
          status === null
            ? null
            : h('p', {
                role: 'status',
                style: {
                  ...mutedStyle,
                  color: status.kind === 'error' ? TOKEN_TEXT_ERROR : TOKEN_TEXT_SUCCESS,
                },
              }, status.text),
          h('p', { style: mutedStyle }, t('applyHint')),
        );
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
            {
              name: 'settings.section',
              id: PAGE_ID,
              order: 5,
              label: () => t('nav'),
              locale: NS,
            },
            Section,
          ),
        );
      } catch (error) {
        console.warn('[dsh-compaction-weave] settings.section unavailable:', error?.message ?? error);
      }

      // The live compaction progress + conditional bili-context compatibility
      // card sits in the composer dock above the input box and renders nothing
      // on normal idle sessions.
      const CompactionProgressCard = createCompactionProgressCard(t);
      try {
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'compaction-weave-progress',
              order: 3,
              locale: NS,
            },
            CompactionProgressCard,
          ),
        );
      } catch (error) {
        console.warn('[dsh-compaction-weave] composer progress card unavailable:', error?.message ?? error);
      }

      try {
        ctx.slots.inject('plugins.detail.section', () =>
          ctx.slots.register(
            {
              name: 'plugins.detail.section',
              id: PAGE_ID,
              order: 10,
              locale: NS,
            },
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
