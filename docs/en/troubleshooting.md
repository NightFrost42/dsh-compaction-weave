# Troubleshooting

[简体中文](../troubleshooting.md) · [English](troubleshooting.md)

## When a summary fails

When a summary request times out or fails validation, Weave retries automatically according to your settings. By default, the initial request can be followed by up to 2 retries, and validation failure details are fed back to the summary model on subsequent attempts.

If all attempts are exhausted, the conversation displays the failure reason and the path to the diagnostic file. Uncommitted original context remains intact in the conversation, and any completed continuation pages are saved on disk for later resumption.

| Failure | Next step |
| --- | --- |
| Timeout or interrupted stream | Check the provider connection and adjust timeout or retry settings |
| Incomplete structure or truncated output | Increase `maxTokens` or choose a model better suited to long structured summaries |
| Requirement or progress check failed | Check the error code and stage in the diagnostic file, then open the `audit-reject/` record linked in `auditReports` to inspect the rejected candidate, source sequence numbers, and excerpts; retries receive this feedback automatically |
| Oversized input or tool group | Use the error code, effective settings, and collected input estimates in the diagnostic file to adjust the summary model window or input budgets |
| Continuation call budget exhausted | Resolve the reported cause, then run `/compact` to grant a fresh call budget for remaining pages |
| Recovery or write-quarantine notice | Keep the transaction journal and `.rollback` backup in storage, restart DSH, and inspect the recovery outcome |
| Host compatibility or private method check notice | Verify that your DSH version falls within `>=0.2.2-rc.1 <0.3.0-0` (formally verified against `0.2.2-rc.1`, `0.2.2-rc.2`, and `0.2.2-rc.3`); if a future 0.2.x release changes private persistence methods, Weave refuses compaction before requesting a summary or mutating history while retaining existing recovery materials |

## False rejections and phrasing boundaries

`PROGRESS_FACT_CONFLICT` indicates a contradiction between the candidate summary's task state or next action and the source history. General diagnostic files record the error code, stage, attempt outcomes, effective settings, input estimates, and `auditReports` references without storing source sequence numbers, user excerpts, or candidate summary prose; to inspect those details, follow `auditReports` in the diagnostic file to the corresponding `audit-reject/` record and compare the source sequence numbers, source excerpts, and candidate phrasing to determine whether the summary omitted the latest state or the audit misclassified the phrasing.

`0.3.2-rc.2` fixes reproduced false rejections around superseded historical snapshots and coordinated negation scope. Indirect Chinese negation such as `并非……` or `不是……而是已被取代` remains a known classification boundary. If a summary matches the latest source state but is still rejected, please open an Issue with a minimal excerpt, the error code, and model details. When requirement coverage falls short without a progress conflict, the engine also attempts local deterministic line reconstruction before failing.

## Diagnostic files

By default, plugin data is stored under:

```text
<DSH_HOME>/storages/dsh-compaction-weave/
```

- `diagnostics/`: uses an allowlist of metadata fields to record the failure stage, error code, per-attempt outcomes, timing, returned usage, effective settings, input estimates, continuation progress, and linked `auditReports` references, without source sequence numbers, conversation excerpts, or candidate prose. Routing fields under `context` reflect configured session and summary routing rather than the final responder model name; `actualDshVersion` is recorded as `null` when the running host version is not reliably collected (you can note your actual version manually when troubleshooting or reporting issues), while `supportedDshVersion` records the declared host compatibility range string (`">=0.2.2-rc.1 <0.3.0-0"`).
- `audit-reject/`: stores candidate summaries rejected by requirement or progress checks along with the audited text, source sequence numbers, and source excerpts, referenced from `auditReports` in the diagnostic file.
- `sessions/`: stores archived original history events and attachments organized by session.
- `summary-config.json`: stores summary model routing and retry configuration.

Start with the diagnostic file path shown in the conversation notice for that operation. Before sharing files publicly, note that `audit-reject/` records and session excerpts contain original user prompts and candidate prose, and should be reviewed and redacted first.

## Open an Issue

If you run into errors, degraded reply quality after compaction, or forgotten requirements or progress, please [open an Issue](https://github.com/NightFrost42/dsh-compaction-weave/issues/new/choose) using the English or Chinese template.

Diagnostic files and logs are optional. For errors, you can attach a reviewed copy of the diagnostic file linked in chat and note the actual DSH version you are running; for quality or memory issues, include the relevant requirement and minimal conversation excerpts before and after compaction. See [Reporting issues and redacting logs](feedback.md) for privacy guidance and redaction instructions.

## Update or uninstall

To update a local package in Desktop, uninstall the existing Weave package on the Plugins page, install the new package via “Add plugin,” and restart DSH. Archives and summary settings in the independent storage directory are preserved.

For a command-line profile, stop the profile before upgrading or removing the package:

```bash
dsh plugin --profile web add /absolute/path/dsh-compaction-weave-0.3.2-rc.3.tgz
dsh plugin --profile web remove dsh-compaction-weave
```

Start the profile again afterwards.
