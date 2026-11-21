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
    const ACTIVE_POLL_MS = 500;
    const IDLE_POLL_MS = 1500;

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
        idleSummaryHint: '默认关闭，独立于上下文压力触发；闲置超时后仅在新回合发送前压缩。',
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
        idleTriggerHint: '超过所选时间后，仅在新用户回合的第一步、发送前压缩仍可压缩的历史；活跃工具循环中不触发。压缩失败则保留新输入并停止该次请求。',
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
        retryRange: '重试次数须为 0–4 的整数；基础间隔须为 0–30 秒；每次等待上限须为 5–3600 秒。',
        auditBlockOnLoss: '要求保留审计拦截（auditBlockOnLoss）',
        auditBlockOnLossOn: '开启（默认：漏掉有效要求时拦截重试）',
        auditBlockOnLossOff: '关闭（仅警告；仍拦截极性反转与授权伪造）',
        auditBlockOnLossHint: '已自动过滤宿主注入块；频繁误拦截时可关闭，仍保留 Section 6 原话与极性检查。',
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
        tokenDelta: '{before} → {current} tok',
        tokenSingle: '{before} tok',
        tokenTarget: '目标 {target}',
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
        backupRestoreArmed: '备份还原已就绪（{id}）。请关闭并重新打开当前会话（或重载 DSH）以加载还原后的历史。',
        backupRestoreFailed: '备份还原失败：{error}',
        doneSummary: '压缩完成',
        errorFallback: '压缩未完成，请查看诊断信息或重试。',
        cancel: '取消',
        dismiss: '关闭',
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
        idleSummaryHint: 'Off by default, independent of context-pressure trigger; compacts before a new turn after idle.',
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
        idleTriggerHint: 'After the selected interval, compact any history that can still be compacted before sending, only at the first step of a new user turn. Active tool loops do not trigger it. If compaction fails, keep the new input and stop that request.',
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
        retryRange: 'Retries must be an integer from 0 to 4; base delay 0–30 seconds; timeout 5–3600 seconds.',
        auditBlockOnLoss: 'Block compaction on requirement loss (auditBlockOnLoss)',
        auditBlockOnLossOn: 'On (default: block & retry on dropped requirements)',
        auditBlockOnLossOff: 'Off (warn only; polarity & provenance still blocked)',
        auditBlockOnLossHint: 'Host-injected blocks are filtered automatically; turning off keeps Section 6 quotes and polarity checks.',
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
        tokenDelta: '{before} → {current} tok',
        tokenSingle: '{before} tok',
        tokenTarget: 'target {target}',
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
        backupRestoreArmed: 'Backup restore armed ({id}). Close and reopen this session (or reload DSH) to load the restored history.',
        backupRestoreFailed: 'Backup restore failed: {error}',
        doneSummary: 'Compaction complete',
        errorFallback: 'Compaction did not complete. Check diagnostics or try again.',
        cancel: 'Cancel',
        dismiss: 'Dismiss',
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
      beforeTokens: null,
      currentTokens: null,
      targetTokens: null,
      maskedCount: 0,
      maskedTokensSaved: 0,
      summaryModel: null,
      stream: null,
      messageKey: null,
      messageParams: null,
      message: null,
      error: null,
      bili: null,
      backup: null,
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

    function normalizeStatus(value) {
      if (!value || typeof value !== 'object') return EMPTY_STATUS;
      const active = value.active === true;
      const rawPhase = typeof value.phase === 'string' && value.phase ? value.phase : (active ? 'summarizing' : 'idle');
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
        beforeTokens: positiveInt(value.beforeTokens),
        currentTokens: positiveInt(value.currentTokens),
        targetTokens: positiveInt(value.targetTokens),
        maskedCount: nonNegativeInt(value.maskedCount),
        maskedTokensSaved: nonNegativeInt(value.maskedTokensSaved),
        summaryModel: typeof value.summaryModel === 'string' && value.summaryModel ? value.summaryModel : null,
        stream: normalizeStream(value.stream),
        messageKey: typeof value.messageKey === 'string' && value.messageKey ? value.messageKey : null,
        messageParams: value.messageParams && typeof value.messageParams === 'object' ? value.messageParams : null,
        message: typeof value.message === 'string' && value.message ? value.message : null,
        error: normalizeError(value.error),
        bili: normalizeBili(value.bili),
        backup: normalizeBackup(value.backup),
      };
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
        a.beforeTokens !== b.beforeTokens || a.currentTokens !== b.currentTokens || a.targetTokens !== b.targetTokens ||
        a.maskedCount !== b.maskedCount || a.maskedTokensSaved !== b.maskedTokensSaved ||
        a.summaryModel !== b.summaryModel || a.message !== b.message ||
        a.finishedAt !== b.finishedAt
      ) return true;
      if ((a.stream?.chunks ?? -1) !== (b.stream?.chunks ?? -1) ||
          (a.stream?.textChars ?? -1) !== (b.stream?.textChars ?? -1) ||
          (a.stream?.reasoningChars ?? -1) !== (b.stream?.reasoningChars ?? -1)) return true;
      if ((a.error?.code ?? null) !== (b.error?.code ?? null) || (a.error?.message ?? null) !== (b.error?.message ?? null)) return true;
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

    function formatBackupOptionLabel(tr, item, originalBackupId) {
      const isOriginal = item.isBaseline === true || (Boolean(originalBackupId) && item.backupId === originalBackupId);
      const parts = [isOriginal ? tr('backupOriginalLabel') : tr('backupSnapshotLabel')];
      const count = item.surfaceNodeCount !== null && item.surfaceNodeCount > 0
        ? item.surfaceNodeCount
        : (item.eventCount !== null && item.eventCount > 0 ? item.eventCount : null);
      if (count !== null) {
        parts.push(formatTemplate(tr('backupNodeCount'), { count }));
      }
      const timeMatch = typeof item.createdAt === 'string' ? /T(\d{2}:\d{2})/.exec(item.createdAt) : null;
      if (timeMatch) {
        parts.push(timeMatch[1]);
      } else {
        parts.push(item.backupId.slice(-8));
      }
      return parts.join(' · ');
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
     *    attempt, model, token delta, masked count, stream liveness, elapsed timer).
     * 2. Strictly conditional billion-context compatibility conversion row
     *    (rendered ONLY when `status.bili?.detected === true`, absent otherwise)
     *    with inline 2-step irreversible confirmation + mandatory SHA-256 backup.
     * 3. Post-conversion backup receipt + inline 2-step restore + reopen banner.
     *
     * Uses adaptive chained `setTimeout` polling (500ms active / 1500ms idle,
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
        const [confirmAction, setConfirmAction] = React.useState(null); // null | 'convert' | 'restore'
        const [actionBusy, setActionBusy] = React.useState(null); // null | 'migrating' | 'restoring'
        const [actionError, setActionError] = React.useState(null);
        const [migrationReceipt, setMigrationReceipt] = React.useState(null);
        const [restoreResult, setRestoreResult] = React.useState(null);
        const [selectedBackupId, setSelectedBackupId] = React.useState(null);
        const [dismissedKey, setDismissedKey] = React.useState('');
        const [dismissedBackupKey, setDismissedBackupKey] = React.useState('');
        const [pollNonce, setPollNonce] = React.useState(0);

        React.useEffect(() => {
          setStatus(EMPTY_STATUS);
          setConfirmAction(null);
          setActionBusy(null);
          setActionError(null);
          setMigrationReceipt(null);
          setRestoreResult(null);
          setSelectedBackupId(null);
          setDismissedKey('');
          setDismissedBackupKey('');
        }, [sessionId]);

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
                schedule(lastActive || actionBusy !== null ? ACTIVE_POLL_MS : IDLE_POLL_MS);
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
        const isActive = status.active === true || actionBusy !== null;

        // STRICT visibility gate: bili conversion UI renders ONLY when detected === true.
        const showBiliRow = bili?.detected === true;

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
            (showBiliRow && serverDefaultBackupId) ||
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

        if (!isActive && !showBiliRow && !showTerminalRow && !showBackupRow) return null;

        const activePhase = status.active
          ? status.phase
          : actionBusy === 'migrating'
            ? 'backing_up'
            : actionBusy === 'restoring'
              ? 'restoring'
              : status.phase;

        const progressPercent = isActive ? computeProgressPercent(status) : null;
        const indeterminateStep = Math.floor((status.elapsedMs || 0) / 500) % 4;
        const indeterminateMargins = ['0%', '22%', '44%', '65%'];
        const telemetryItems = isActive ? buildTelemetryItems(tr, status) : [];

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

        // 1. Live active progress section
        if (isActive) {
          const headerText = status.active && status.message && !status.messageKey
            ? status.message
            : phaseLabelFor(tr, activePhase);
          const hasOverallPercent = status.overallPercent !== null;
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
                h('span', {
                  'data-compaction-elapsed': 'true',
                  style: {
                    marginLeft: 'auto',
                    fontSize: 11,
                    fontVariantNumeric: 'tabular-nums',
                    color: TOKEN_TEXT_SECONDARY,
                  },
                }, formatElapsed(status.elapsedMs)),
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

        // 3. STRICTLY CONDITIONAL billion-context compatibility conversion row
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

        // 4. Backup receipt + multi-backup selector + inline 2-step restore + requiresReopen banner
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
                  ? h('div', { style: { fontSize: 11, color: TOKEN_TEXT_SECONDARY, display: 'flex', alignItems: 'center', gap: 4 } },
                      tr('backupPathLabel'),
                      h('code', { 'data-backup-path': 'true', title: pendingPath, style: codePathStyle }, pendingPath))
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
            const receiptLead = migrationReceipt && !showServerTerminal && !isActive
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

        return h('div', {
          role: 'status',
          'aria-live': 'polite',
          'data-compaction-progress': isActive ? activePhase : (showBiliRow ? 'bili-detected' : status.phase),
          style: {
            width: '100%',
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
        const [idlePreset, setIdlePreset] = React.useState('0');
        const [idleCustomMinutes, setIdleCustomMinutes] = React.useState('');
        const [auditBlockOnLoss, setAuditBlockOnLoss] = React.useState(true);
        const [catalog, setCatalog] = React.useState([]);
        const [catalogError, setCatalogError] = React.useState(null);
        const [saving, setSaving] = React.useState(false);
        const [status, setStatus] = React.useState(null);

        function load() {
          let alive = true;
          setLoading(true);
          setCatalogError(null);
          Promise.allSettled([rpc('get'), rpc('models')])
            .then(([configResult, catalogResult]) => {
              if (!alive) return;
              if (configResult.status === 'fulfilled') {
                const config = configResult.value?.config ?? null;
                const idle = String(config?.idleCompactionMinutes ?? 0);
                setIdlePreset(IDLE_PRESETS.includes(idle) ? idle : 'custom');
                setIdleCustomMinutes(IDLE_PRESETS.includes(idle) ? '' : idle);
                setAuditBlockOnLoss(typeof config?.auditBlockOnLoss === 'boolean' ? config.auditBlockOnLoss : true);
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
          const retries=Number(retryCount),delay=Number(retryDelay)*1000,timeout=Number(summaryTimeout)*1000;
          if (![retryCount,retryDelay,summaryTimeout].every(v=>String(v).trim()!=='') || !Number.isInteger(retries)||retries<0||retries>4||!Number.isInteger(delay)||delay<0||delay>30000||!Number.isInteger(timeout)||timeout<5000||timeout>3600000) return t('retryRange');
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
            Object.assign(params,{summaryRetryCount:Number(retryCount),summaryRetryDelayMs:Number(retryDelay)*1000,summaryTimeoutMs:Number(summaryTimeout)*1000});
            params.idleCompactionMinutes = Number(idlePreset === 'custom' ? idleCustomMinutes : idlePreset);
            params.auditBlockOnLoss = Boolean(auditBlockOnLoss);
            await rpc('set', params);
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

        return h(
          'section',
          { style: { maxWidth: 640, width: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 16px' } },
          h('header', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            h('h2', { style: { fontSize: 16, fontWeight: 600, margin: 0, color: TOKEN_TEXT_PRIMARY } }, t('title')),
            h('p', { style: mutedStyle }, t('intro')),
          ),
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
            h('p', { style: mutedStyle }, t('idleSummaryHint')),
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
