# Troubleshooting

[简体中文](../troubleshooting.md) · [English](troubleshooting.md)

## When a summary fails

Weave retries according to your settings. By default, the first request can be followed by 2 additional attempts. Validation failures are fed back to the summary model.

After attempts are exhausted, the conversation shows the cause and diagnostic location. Original context that has not been committed remains available. Completed continuation pages are saved for resumption.

| Failure | Next step |
| --- | --- |
| Timeout or interrupted stream | Check the provider connection and adjust timeout or retry settings |
| Incomplete structure or insufficient output | Increase the output limit or select a model suited to long summaries |
| Requirement or progress conflict | Inspect the rejection details; subsequent attempts receive this feedback |
| Oversized input or tool group | Review request-capacity information and the summary model's input budget |
| Consecutive-failure threshold reached | Resolve the reported cause, then retry with `/compact` |
| Recovery pending | Keep the journal and backup; restart and inspect the recovery outcome |

## Diagnostic files

The default storage directory is:

```text
<DSH_HOME>/storages/dsh-compaction-weave/
```

- `diagnostics/`: stages, error codes, attempts, timing, usage, and continuation progress.
- `sessions/`: original history and attachments organized by session.
- `audit-reject/`: candidate summaries rejected by requirement or progress checks.
- `summary-config.json`: summary model and retry settings.

Start with the path shown for the operation you are investigating. General failure reports use an allowlist of metadata fields. Rejection records may contain source and summary excerpts; review task content before sharing them.

## Open an Issue

Please [open an Issue](https://github.com/NightFrost42/dsh-compaction-weave/issues/new/choose) for errors, degraded answer quality, or forgotten requirements or progress after compaction. Choose the English or Chinese template and include versions, models, reproduction steps, and expected versus actual behavior.

For errors, attach the diagnostic file linked in the conversation. For quality or memory issues, include the relevant requirement and conversation excerpts showing the difference before and after compaction. Remove credentials and private information from logs and excerpts first.

## Update or uninstall

Use DSH's plugin manager, or manage a command-line profile with:

```bash
dsh plugin --profile web add https://github.com/NightFrost42/dsh-compaction-weave/releases/download/v0.3.2-rc.1/dsh-compaction-weave-0.3.2-rc.1.tgz
dsh plugin --profile web remove dsh-compaction-weave
```

Restart DSH afterwards. Archives and settings live in their own storage directory and are reused after a package update.
