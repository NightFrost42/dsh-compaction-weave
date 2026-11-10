# Configuration

[简体中文](../configuration.md) · [English](configuration.md)

## Summary settings

Open **Settings → Summary model**, or the summary settings in the plugin details.

| Setting | Field | Default | Range |
| --- | --- | --- | --- |
| Provider | `summarizationProvider` | Follow conversation | Configured providers |
| Model | `summarizationModel` | Follow conversation | Models offered by the provider |
| Output limit | `maxTokens` | 8192 | 1–1000000 |
| Trigger ratio | `thresholdRatio` | 0.8 | 0.5–0.95 |
| Minimum reduction | `minimumReductionRatio` | 0.2 | 0.05–0.9 |
| Additional retries | `summaryRetryCount` | 2 | 0–4 |
| Base delay | `summaryRetryDelayMs` | 1000 | 0–30000 ms |
| Per-request timeout | `summaryTimeoutMs` | 180000 | 5000–3600000 ms |

The UI displays timing in seconds; configuration fields use milliseconds. A retry count of 2 allows up to 3 attempts for each unfinished summary or page. Consecutive retries use exponential backoff, capped at 30 seconds.

Select or clear the provider and model together. Clearing them follows the conversation model while retaining retry and trigger settings. **Restart DSH after saving.**

Settings are stored in:

```text
<DSH_HOME>/storages/dsh-compaction-weave/summary-config.json
```

When `DSH_HOME` is unset, DSH uses `.dsh` in the user's home directory.

## Advanced configuration

Set advanced options under `compaction-weave-gate.config.engine` in your profile patch:

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

Values saved by the summary settings page override the corresponding engine fields.

### Timing and cache preservation

| Field | Default | Meaning |
| --- | --- | --- |
| `auto` | `true` | Automatic compaction under context pressure |
| `thresholdRatio` | `0.8` | Automatic trigger ratio |
| `headroomTokens` | `33000` | Space reserved for replies and tool output |
| `minimumReductionRatio` | `0.2` | Target minimum automatic input reduction |
| `cachePreservePrefix` | `true` | Prefer incremental ranges preserving existing prefixes |
| `cacheMaxCheckpoints` | `4` | Checkpoint count at which consolidation is considered |
| `cacheMinSavingsTokens` | `4096` | Minimum space freed by incremental compaction |
| `proactiveEnabled` | `true` | Enable the model's `context_compact` tool |
| `proactiveMinTokens` | `8192` | Minimum context size for proactive compaction |
| `proactiveMinGrowthTokens` | `4096` | New content required before another proactive request |

`auto` controls pressure-based compaction; `proactiveEnabled` controls model requests. Use `/compact` for manual compaction.

### Quotes and resumable pages

| Field | Default | Meaning |
| --- | --- | --- |
| `preserveRecentMessages` | `32` | Maximum recent verbatim user messages |
| `preserveRecentUserTokens` | `4096` | Recent-quote budget |
| `summaryInputRatio` | `0.75` | Summary input budget relative to the model window |
| `summaryInputMaxBytes` | `458752` | Complete summary request's UTF-8 byte budget |
| `maxSummaryChunks` | `32` | Maximum successful chunks in a workflow |
| `continuationEnabled` | `true` | Enable paged continuation for large histories |
| `continuationMemoryBytes` | `12288` | Working-notes budget for continuation |
| `continuationMaxBytes` | `98304` | Total continuation-record budget |
| `continuationMaxExtraCalls` | `4` | Persisted extra-request allowance |

Older quotes leave the budget first; active requirements remain independently checked. Byte budgets support local planning; model usage reports provide actual service token counts.

### Archives, validation, and language

| Field | Default | Meaning |
| --- | --- | --- |
| `archiveEnabled` | `true` | Archive originals and attachments before compaction |
| `archiveDir` | Automatic | Custom archive directory |
| `auditEnabled` | `true` | Check requirement retention |
| `auditBlockOnLoss` | `true` | Retry and prevent submission of summaries losing requirements |
| `failureThreshold` | `3` | Consecutive-failure threshold for automatic compaction |
| `language` | `auto` | Summary language: `auto`, `zh`, or `en` |

The settings interface follows DSH's Chinese or English locale. The `language` option controls generated summaries separately.

Failures report their cause, attempts, and diagnostic location. See [Troubleshooting](troubleshooting.md).
