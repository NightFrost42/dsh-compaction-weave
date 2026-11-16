/**
 * Client half of dsh-compaction-weave: one Settings page section that lets the
 * user choose the model used to write compaction summaries.
 *
 * Contract notes:
 * - Only `react` is required. Requiring any Harness Client package would make a
 *   throwing component blank the whole settings panel.
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

    const dictionaries = {
      zh: {
        nav: '摘要模型',
        title: '摘要模型',
        intro: '选择压缩历史时负责写摘要的模型。留空表示跟随当前会话模型。',
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
        reductionHint: '自动压缩至少减少压缩前上下文的 {pct}%。达不到时尝试同会话接续；无法保留必要要求时会停止并报错。',
        reductionRange: '最小压缩幅度必须在 5% 到 90% 之间。',
        triggerHint: '触发线 = 窗口的 {pct}%。实际触发线取较小值：min(窗口 × 百分比, 窗口 − 输出预留 − 33000)；输出预留越大，实际触发会越早。',
        triggerRange: '触发线必须在 50% 到 95% 之间。',
        idleCompaction: '闲置后先压缩',
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
        idleReferences: '各家缓存时间参考',
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
        retryHint: '每个摘要或未完成页失败后最多再试 {count} 次（合计 {total} 次）。摘要修正也占次数；分页只重试未完成页，接续总预算仍然有效。',
        retryDelayHint: '后续重试间隔逐次加倍，最长 30 秒。取消、凭据错误或存储异常会立即停止。',
        timeoutHint: '单次请求超时后可重试，因此总等待时间可能超过此值。已发出的请求可能计费。',
        retryRange: '重试次数须为 0–4 的整数；基础间隔须为 0–30 秒；每次等待上限须为 5–3600 秒。',
      },
      en: {
        nav: 'Summary model',
        title: 'Summary model',
        intro: 'Choose the model that writes compaction summaries. Leave both fields empty to follow the current session model.',
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
        reductionHint: 'Reduce total context by at least {pct}% during automatic compaction. Try same-session continuation if needed; stop if required evidence cannot fit.',
        reductionRange: 'Minimum reduction must be between 5% and 90%.',
        triggerHint: 'The trigger line is {pct}% of the window. The effective line is min(window × percent, window − reserved output − 33000); a larger output reservation makes it fire earlier.',
        triggerRange: 'The trigger line must be between 50% and 95%.',
        idleCompaction: 'Compact before resuming',
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
        idleReferences: 'Provider cache time references',
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
        retryHint: 'Retry up to {count} times ({total} total attempts), including corrective requests. Resume only unfinished pages; the continuation budget still applies.',
        retryDelayHint: 'The delay doubles on later retries, capped at 30 seconds. Cancellation, credentials and storage failures stop immediately.',
        timeoutHint: 'A timed-out request can be retried, so total waiting time may exceed this limit. Dispatched requests may be billed.',
        retryRange: 'Retries must be an integer from 0 to 4; base delay 0–30 seconds; timeout 5–3600 seconds.',
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

    /**
     * Composer card that exists only while a compaction is running.
     *
     * The host records `compaction/start` / `compaction/end` around the whole
     * operation (the two log-only events are always written by the engine), so
     * the card polls one tiny RPC method and renders nothing otherwise. It is
     * deliberately a status card, not a progress bar: the engine cannot report
     * chunk progress without a second event vocabulary.
     */
    function CompactionProgressCard(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
      const [status, setStatus] = React.useState({ active: false, startedAt: null, elapsedMs: 0 });
      React.useEffect(() => {
        if (sessionId === '') return undefined;
        let alive = true;
        let timer = null;
        let inFlight = false;
        const tick = async () => {
          if (inFlight) return;
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
            const value = payload?.ok === true ? payload.value : null;
            const next = value?.active
              ? { active: true, startedAt: value.startedAt, elapsedMs: Number(value.elapsedMs) || 0 }
              : { active: false, startedAt: null, elapsedMs: 0 };
            setStatus(previous => {
              if (previous.active !== next.active) return next;
              if (!next.active) return previous;
              return Math.floor(previous.elapsedMs / 1000) === Math.floor(next.elapsedMs / 1000)
                ? previous
                : next;
            });
          } catch {
            // Host unreachable: keep the last snapshot instead of flashing.
          } finally {
            inFlight = false;
          }
        };
        void tick();
        timer = setInterval(() => void tick(), 1000);
        return () => {
          alive = false;
          if (timer !== null) clearInterval(timer);
        };
      }, [sessionId]);

      if (!status.active) return null;
      const t = typeof props?.t === 'function' ? props.t : (key => dictionaries.zh[key] ?? key);
      const seconds = Math.max(0, Math.floor(status.elapsedMs / 1000));
      return h('div', {
        role: 'status',
        'aria-live': 'polite',
        'data-compaction-progress': 'active',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          alignSelf: 'flex-start',
          maxWidth: '100%',
          padding: '6px 10px',
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.35))',
          background: 'var(--dsw-alias-bg-elevated, transparent)',
          color: 'var(--dsw-alias-text-secondary, inherit)',
          fontSize: 12,
          lineHeight: 1.4,
        },
      },
        h('span', {
          'aria-hidden': 'true',
          style: {
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: '50%',
            border: '2px solid var(--dsw-alias-brand-primary, #2f6fed)',
            borderTopColor: 'transparent',
          },
        }),
        h('span', null, t('compressing')),
        h('span', { style: { fontVariantNumeric: 'tabular-nums', opacity: 0.75 } }, `${seconds}s`),
      );
    }

    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.35))',
      background: 'var(--dsw-alias-bg-base, transparent)',
      color: 'var(--dsw-alias-text-primary, inherit)',
      font: 'inherit',
    };    const labelStyle = {
      display: 'block',
      fontSize: 12,
      fontWeight: 600,
      color: 'var(--dsw-alias-text-secondary, inherit)',
      marginBottom: 4,
    };
    const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 4 };
    const buttonStyle = {
      border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.35))',
      borderRadius: 8,
      padding: '8px 14px',
      font: 'inherit',
      cursor: 'pointer',
      background: 'var(--dsw-alias-bg-elevated, transparent)',
      color: 'var(--dsw-alias-text-primary, inherit)',
    };
    const primaryStyle = {
      ...buttonStyle,
      background: 'var(--dsw-alias-brand-primary, #2f6fed)',
      borderColor: 'var(--dsw-alias-brand-primary, #2f6fed)',
      color: '#fff',
    };
    const mutedStyle = {
      color: 'var(--dsw-alias-text-secondary, inherit)',
      fontSize: 12,
      lineHeight: 1.5,
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
          return h('section', { style: { maxWidth: 760, padding: '4px 0' } }, h('p', { style: mutedStyle }, t('loading')));
        }

        return h(
          'section',
          { style: { maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0' } },
          h('header', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('h2', { style: { fontSize: 18, margin: 0 } }, t('title')),
            h('p', { style: mutedStyle }, t('intro')),
          ),
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
            h('input', {id:'weave-summary-retry-count',type:'number',min:0,max:4,step:1,style:inputStyle,value:retryCount,onChange:event=>setRetryCount(event.target.value)}),
            h('p', {style:mutedStyle}, t('retryHint').replace('{count}',String(retryCount)).replace('{total}',String(Number(retryCount)+1))),
          ),
          h('div', { style: fieldStyle },
            h('label', { style: labelStyle, htmlFor: 'weave-summary-retry-delay' }, t('retryDelay')),
            h('input', {id:'weave-summary-retry-delay',type:'number',min:0,max:30,step:0.001,style:inputStyle,value:retryDelay,onChange:event=>setRetryDelay(event.target.value)}),
            h('p', {style:mutedStyle}, t('retryDelayHint')),
          ),
          h('div', { style: fieldStyle },
            h('label', { style: labelStyle, htmlFor: 'weave-summary-timeout' }, t('summaryTimeout')),
            h('input', {id:'weave-summary-timeout',type:'number',min:5,max:3600,step:1,style:inputStyle,value:summaryTimeout,onChange:event=>setSummaryTimeout(event.target.value)}),
            h('p', {style:mutedStyle}, t('timeoutHint')),
          ),
          h('div', { style: fieldStyle },
            h('label', { style: labelStyle, htmlFor: 'weave-summary-threshold' }, t('trigger')),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
              h('input', {
                id: 'weave-summary-threshold',
                type: 'range',
                min: 50,
                max: 95,
                step: 1,
                value: thresholdRatio,
                style: { flex: 1, accentColor: 'var(--dsw-alias-brand-primary, #2f6fed)' },
                'aria-label': t('trigger'),
                onChange: event => setThresholdRatio(Number(event.target.value)),
              }),
              h('span', { style: { minWidth: 48, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, `${thresholdRatio}%`),
            ),
            h('p', { style: mutedStyle }, t('triggerHint').replace('{pct}', String(thresholdRatio))),
          ),
          h('div', { style: fieldStyle },
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
            idlePreset !== 'custom' ? null : h('div', { style: fieldStyle },
              h('label', { style: labelStyle, htmlFor: 'weave-idle-custom-minutes' }, t('idleCustomMinutes')),
              h('input', {
                id: 'weave-idle-custom-minutes', type: 'number', min: 1, max: MAX_IDLE_COMPACTION_MINUTES, step: 1,
                style: inputStyle, value: idleCustomMinutes,
                'aria-describedby': 'weave-idle-duration-hint weave-idle-hint weave-idle-trigger-hint',
                onChange: event => setIdleCustomMinutes(event.target.value),
              }),
            ),
            h('p', { id: 'weave-idle-duration-hint', style: mutedStyle }, t('idleDurationHint')),
            h('p', { id: 'weave-idle-hint', style: mutedStyle }, t('idleHint')),
            h('p', { id: 'weave-idle-trigger-hint', style: mutedStyle }, t('idleTriggerHint')),
            h('details', {style:mutedStyle},
              h('summary', {style:{cursor:'pointer'}}, t('idleReferences')),
              h('p', { id: 'weave-idle-gpt-hint', style: mutedStyle }, t('idleGptHint')),
              h('p', { style: mutedStyle }, t('idleClaudeHint')),
              h('p', { id: 'weave-idle-cache-hint', style: mutedStyle }, t('idleCacheHint')),
              h('p', {style:mutedStyle}, [
                ['OpenAI', 'https://developers.openai.com/api/docs/guides/prompt-caching'],
                ['Claude', 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching'],
                ['Gemini', 'https://ai.google.dev/gemini-api/docs/caching'],
                ['DeepSeek', 'https://api-docs.deepseek.com/guides/kv_cache/'],
                ['GLM', 'https://docs.bigmodel.cn/cn/guide/capabilities/cache'],
              ].map(([label,href]) => h('a', {key:label,href,target:'_blank',rel:'noopener noreferrer',style:{marginRight:12,color:'inherit'}}, label))),
            ),
          ),
          h('div', { style: fieldStyle },
            h('label', { style: labelStyle, htmlFor: 'weave-minimum-reduction' }, t('minimumReduction')),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
              h('input', {
                id: 'weave-minimum-reduction', type: 'range', min: 5, max: 90, step: 1,
                value: minimumReductionRatio,
                style: { flex: 1, accentColor: 'var(--dsw-alias-brand-primary, #2f6fed)' },
                'aria-label': t('minimumReduction'),
                onChange: event => setMinimumReductionRatio(Number(event.target.value)),
              }),
              h('span', { style: { minWidth: 48, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, `${minimumReductionRatio}%`),
            ),
            h('p', { style: mutedStyle }, t('reductionHint').replace('{pct}', String(minimumReductionRatio))),
          ),
          h('p', { style: mutedStyle }, t('follow')),
          catalogError === null
            ? null
            : h('p', { style: { ...mutedStyle, color: 'var(--dsw-alias-text-danger, #c0392b)' } },
                `${t('catalogError')}: ${catalogError}`),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
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
                  color: status.kind === 'error'
                    ? 'var(--dsw-alias-text-danger, #c0392b)'
                    : 'var(--dsw-alias-text-success, #1e8449)',
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

      // The "compacting…" card sits where the session-recap card sits: in the
      // composer dock above the input box. It renders nothing when idle.
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
