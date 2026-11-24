# Development and releases

[简体中文](../development.md) · [English](development.md)

## Environment

Use Node.js 24.9+ and npm. The plugin declares DSH compatibility as `>=0.2.2-rc.1 <1.0.0-0` (`0.2.x–0.x`); host integration uses runtime dependencies from a verified DSH host release (`0.2.2-rc.1`, `0.2.2-rc.2`, or `0.2.2-rc.3`). The plugin uses JavaScript ES modules directly, with no compilation step or additional runtime dependencies.

```bash
npm test
npm run check
npm run pack:release
```

`npm test` discovers suites in `test/` and runs them in separate processes with temporary `DSH_HOME` directories. Each suite has a timeout. Logs and summaries are saved under `.local/test-results/`.

`npm run check` validates syntax, JSON, package exports, documentation links, versioned installation examples, and sensitive-content patterns in release sources.

## Host integration

Set `DSH_TEST_NODE_MODULES` to the runtime's `node_modules` directory:

```powershell
$env:DSH_TEST_NODE_MODULES = 'D:/Apps/DSH/node_modules'
npm run test:host
```

Or supply the directory directly:

```bash
node scripts/test.mjs --host-modules /path/to/dsh/node_modules
```

This runs all offline suites (counts depend on the current version) plus host session, surface, capacity, proactive-compaction, multi-generation prefix-preservation, range admission, native durable commit, rollback, post-decision failure, cold recovery, batch `append`, and unknown-method refusal tests (see the current testing record). Model output is supplied by fixtures without paid model calls, and temporary storage is isolated. See [rc3-host-compatibility.json](../benchmarks/rc3-host-compatibility.json) for the host compatibility and test records.

## Layout

```text
lib/                  Runtime modules
locale/               Chinese and English plugin descriptions
test/                 Active regression suites and fixtures
  integration/        DSH host integration
  helpers/            Isolation setup
  archived-regex/     Archived legacy regex & domain-wordlist suites
scripts/              Test, validation, and packaging tools
docs/                 Chinese guides and test records
  en/                 English guides
.github/workflows/    Windows and Linux CI and automated release workflows
cordis.patch.yml      DSH plugin bundle entry
```

`.local/` and `dist/` are ignored by Git. The CI workflow runs offline tests, source checks, packaging, and an isolated host matrix against DSH `0.2.2-rc.1` and `0.2.2-rc.3` on Windows and Linux using Node.js 24, and pushing a matching `v<version>` tag triggers the automated npm + GitHub Release workflow.

## Artifacts

`npm run pack:release` produces:

| File | Purpose |
| --- | --- |
| `dsh-compaction-weave.tgz` | Versionless DSH package copy for stable `releases/latest/download/dsh-compaction-weave.tgz` URLs |
| `dsh-compaction-weave-<version>.tgz` | Versioned DSH installable package |
| `dsh-compaction-weave-<version>-source.tar.gz` | Standalone source and tests |
| `SHA256SUMS.txt` | Archive SHA-256 checksums |
| `manifest.json` | Version, runtime requirements, and per-file hashes |

The runtime package follows `package.json.files`; the source archive uses an explicit source list. Local reports, raw sessions, previous deliveries, and local configuration are kept out of both artifacts.

## Release process

1. Update the package version, versioned installation examples in both languages, and `CHANGELOG.md`. Diagnostics read the package version directly.
2. Run offline and host integration tests and resolve failures.
3. Build and verify the archives, including checks from an independently extracted source package.
4. Push the source, create the matching `v<version>` tag, and attach the packages and checksum files to its GitHub Release.
5. If publishing to npm manually from a local machine, publish the verified tarball (keep the leading `./` on npm 11+ so relative tarball paths are not parsed as GitHub `owner/repo` shorthand):

```bash
npm publish ./dist/dsh-compaction-weave-0.5.3-hotfix.1.tgz --tag hotfix --access public
```

Stable releases publish under the `latest` npm tag (prereleases use `next` in `publishConfig.tag`).

### Automated releases (GitHub Actions + npm Trusted Publishing)

[`.github/workflows/release.yml`](../../.github/workflows/release.yml) automates full releases whenever a `v<version>` tag matching `package.json` is pushed: it runs checks, offline tests, packaging, and the DSH host compatibility matrix across Windows and Linux, then publishes `./dist/dsh-compaction-weave-<version>.tgz` to npm via OIDC Trusted Publishing (no `NPM_TOKEN` secret required, provenance generated automatically; bound to `latest` for stable versions or `next` for prereleases) and creates or updates the GitHub Release (`--latest` or `--prerelease`) with all five `dist/` artifacts including the versionless `dsh-compaction-weave.tgz`.

One-time setup: after publishing the initial package manually, open **Settings → Trusted Publisher** on npmjs.com and link GitHub Actions with owner `NightFrost42`, repository `dsh-compaction-weave`, workflow filename `release.yml`, and an empty environment. You can also test the workflow anytime via `workflow_dispatch` with `dry_run=true`.

## Semantic regression cases

Structured progress checks validate explicit `key: value` facts, so fixtures should pair valid summaries with genuine conflicts. Keeping `chartGenerated: false` or an explicitly scoped historical `seq=` value should pass, while flipping the active scope to `chartGenerated: true` or `null` must still raise `PROGRESS_FACT_CONFLICT`.

Run the full test suite after changing candidate interpretation, channel boundaries, or audit rules (including `phase1-optimizations.mjs`, `phase2-optimizations.mjs`, `phase3-route-b.mjs`, `astra-review-fixes.mjs`, `release-billing-safety.mjs`, and `constraint-scope.mjs`) to verify persisted v1/v2 source compatibility, billing guards, and archive guarantees remain intact.
