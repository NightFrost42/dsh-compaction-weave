# Development and releases

[简体中文](../development.md) · [English](development.md)

## Environment

Use Node.js 24.9+ and npm. The plugin declares DSH compatibility as `>=0.2.2-rc.1 <0.3.0-0`; host integration uses runtime dependencies from a verified DSH host release (`0.2.2-rc.1`, `0.2.2-rc.2`, or `0.2.2-rc.3`). The plugin uses JavaScript ES modules directly, with no compilation step or additional runtime dependencies.

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

This runs all offline suites (50 suites, 1597 tests) plus host session, surface, capacity, proactive-compaction, multi-generation prefix-preservation, range admission, native durable commit, rollback, post-decision failure, cold recovery, batch `append`, and unknown-method refusal tests (6 suites, 101 tests). Model output is supplied by fixtures without paid model calls, and temporary storage is isolated. See [rc3-host-compatibility.json](../benchmarks/rc3-host-compatibility.json) for the host compatibility and test records.

## Layout

```text
lib/                  Runtime modules
locale/               Chinese and English plugin descriptions
test/                 Regression suites and fixtures
  integration/        DSH host integration
  helpers/            Isolation setup
scripts/              Test, validation, and packaging tools
docs/                 Chinese guides and test records
  en/                 English guides
.github/workflows/    Windows and Linux CI
cordis.patch.yml      DSH plugin bundle entry
```

`.local/` and `dist/` are ignored by Git. The CI workflow runs offline tests, source checks, packaging, and an isolated host matrix against DSH `0.2.2-rc.1` and `0.2.2-rc.3` on Windows and Linux using Node.js 24.

## Artifacts

`npm run pack:release` produces:

| File | Purpose |
| --- | --- |
| `dsh-compaction-weave-<version>.tgz` | DSH installable package |
| `dsh-compaction-weave-<version>-source.tar.gz` | Standalone source and tests |
| `SHA256SUMS.txt` | Archive SHA-256 checksums |
| `manifest.json` | Version, runtime requirements, and per-file hashes |

The runtime package follows `package.json.files`; the source archive uses an explicit source list. Local reports, raw sessions, previous deliveries, and local configuration are kept out of both artifacts.

## Release process

1. Update the package version, versioned installation examples in both languages, and `CHANGELOG.md`. Diagnostics read the package version directly.
2. Run offline and host integration tests and resolve failures.
3. Build and verify the archives, including checks from an independently extracted source package.
4. Push the source, create the matching `v<version>` tag, and attach the packages and checksum files to its GitHub Release.
5. If publishing to npm, publish the verified tarball:

```bash
npm publish dist/dsh-compaction-weave-0.3.2-rc.3.tgz --tag next --access public
```

The current release is a candidate and uses the `next` npm tag. A stable release updates both the version and `publishConfig.tag`.

## Semantic regression cases

Pair valid statements with genuine contradictions. “Do not claim the chart is generated” should pass; a following “but the chart is generated now” must still be compared with source-backed progress.

Run all audit and progress suites after changing candidate interpretation. `progress-source-compatibility.mjs` checks that persisted original-source identities remain readable.
