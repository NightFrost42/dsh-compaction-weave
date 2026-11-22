import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { auditCompaction } from '../lib/audit.js';
import {
  extractCandidatePaths,
  probeDiskLiveness,
  resolvePathInsideWorkspace,
  resolveSessionRootRecords,
} from '../lib/disk-liveness.js';
import { collectActiveWorkspaceFiles, renderActiveWorkspaceFiles } from '../lib/file-reinject.js';
import { blocksToText } from '../lib/meter.js';
import { CHECKPOINT_PREAMBLE } from '../lib/prompt.js';
import { buildCheckpointBlocks } from '../lib/region.js';

const TEST_BASE = process.env.WEAVE_TEST_ROOT ?? tmpdir();

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error: error.message, stack: error.stack });
  }
}

function createMockSession({ cwd, workingDirChanges = [], events = [] } = {}) {
  const all = [...events];
  if (workingDirChanges.length > 0 && all.length === 0) {
    for (const dir of workingDirChanges) {
      all.push({ seq: all.length, type: 'working-directory/change', data: { cwd: dir } });
    }
  }
  const bySeq = new Map(all.map((ev, idx) => [ev.seq ?? idx, { seq: ev.seq ?? idx, ...ev }]));
  const maxSeq = all.length === 0 ? 0 : Math.max(...bySeq.keys()) + 1;
  return {
    id: `sess-${randomUUID()}`,
    header: {
      version: 4,
      id: 'sess-test',
      createdAt: Date.now() - 10_000,
      isSeeded: false,
      ...(cwd === undefined ? {} : { cwd }),
    },
    get seq() {
      return maxSeq;
    },
    eventAt(s) {
      return bySeq.get(s);
    },
    deriveEventMessage(ev) {
      if (!ev) return undefined;
      if (ev.type === 'assistant/message') return ev.data?.message;
      if (ev.type === 'tool/result') return ev.data?.message ?? ev.data;
      return ev.data;
    },
  };
}

function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// ── 1. disk-liveness exports: resolveSessionRootRecords & resolvePathInsideWorkspace ──
await test('disk-liveness-root-records-and-resolve-path-inside-workspace', async () => {
  const base = await mkdtemp(join(TEST_BASE, 'weave-reinject-dl-'));
  try {
    const ws = join(base, 'ws');
    const outside = join(base, 'outside');
    await mkdir(join(ws, 'src'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(ws, 'src', 'app.js'), 'export const a = 1;\n');
    await writeFile(join(outside, 'secret.txt'), 'nope');

    const session = createMockSession({ cwd: ws });
    const records = resolveSessionRootRecords(session);
    assert.equal(records.length, 1);
    assert.ok(records[0].real.length > 0);

    const relHit = resolvePathInsideWorkspace('src/app.js:12-20', records);
    assert.ok(relHit);
    assert.equal(relHit.display, 'src/app.js');

    const absHit = resolvePathInsideWorkspace(join(ws, 'src', 'app.js'), records);
    assert.ok(absHit);
    assert.equal(absHit.display, 'src/app.js');

    assert.equal(resolvePathInsideWorkspace('../outside/secret.txt', records), null);
    assert.equal(resolvePathInsideWorkspace('src/../../outside/secret.txt', records), null);
    assert.equal(resolvePathInsideWorkspace(join(outside, 'secret.txt'), records), null);
    assert.equal(resolvePathInsideWorkspace('\\\\remote-host\\share\\a.js', records), null);
    assert.equal(resolvePathInsideWorkspace('\\\\?\\C:\\ws\\a.js', records), null);
    assert.equal(resolvePathInsideWorkspace('//remote-host/share/a.js', records), null);
    assert.equal(resolvePathInsideWorkspace(ws, records), null);
    assert.equal(resolvePathInsideWorkspace('src/app.js', []), null);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ── 2. disk-liveness ignores <active-workspace-files> (no circular path scanning) ──
await test('disk-liveness-strips-active-workspace-files-tag', async () => {
  const base = await mkdtemp(join(TEST_BASE, 'weave-reinject-strip-'));
  try {
    const ws = join(base, 'ws');
    await mkdir(join(ws, 'src'), { recursive: true });
    await writeFile(join(ws, 'src', 'real.js'), 'export const ok = true;\n');

    const session = createMockSession({ cwd: ws });
    const reinjected = renderActiveWorkspaceFiles({
      files: [
        {
          path: 'src/real.js',
          bytes: 80,
          truncated: true,
          content: '```md\nCheck `src/only-inside-reinjected-missing.js`\n[... truncated ...]',
        },
      ],
      totalBytes: 80,
    });

    const summaryText = [
      'Verified `src/real.js`.',
      reinjected,
      'Still track `src/summary-missing.js` outside block.',
    ].join('\n\n');

    const candidates = extractCandidatePaths({ session, summaryText });
    const displays = candidates.map((c) => c.display);
    assert.ok(displays.includes('src/real.js'));
    assert.ok(displays.includes('src/summary-missing.js'));
    assert.ok(!displays.includes('src/only-inside-reinjected-missing.js'));

    const probe = probeDiskLiveness({ session, summaryText });
    assert.deepEqual(probe.missing, ['src/summary-missing.js']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ── 3. Ranking: write (+10) > read (+4) > archived (+2) & tie-breakers & arg keys ──
await test('ranking-scores-tie-breakers-and-argument-variants', async () => {
  const base = await mkdtemp(join(TEST_BASE, 'weave-reinject-rank-'));
  try {
    const ws = join(base, 'ws');
    await mkdir(join(ws, 'src'), { recursive: true });
    const names = [
      'write-old.js',
      'write-new.js',
      'read-twice.js',
      'read-new.js',
      'read-old.js',
      'shell-read.js',
      'archived-only.js',
      'extra-archived.js',
    ];
    for (const name of names) {
      await writeFile(join(ws, 'src', name), `// ${name}\n`);
    }

    const events = [
      // Read once at seq 0 (+4, latestSeq=0)
      { seq: 0, type: 'tool/call', data: { callId: 'c0', name: 'read_file', arguments: JSON.stringify({ file_path: 'src/read-old.js' }) } },
      // Read twice at seq 1 and seq 2 (+8 total)
      { seq: 1, type: 'tool/call', data: { callId: 'c1', name: 'view_file', arguments: JSON.stringify({ AbsolutePath: join(ws, 'src', 'read-twice.js') }) } },
      { seq: 2, type: 'tool/call', data: { callId: 'c2', name: 'open_file', arguments: JSON.stringify({ targetFile: 'src/read-twice.js' }) } },
      // Write once at seq 3 (+10, latestSeq=3)
      { seq: 3, type: 'tool/call', data: { callId: 'c3', name: 'write_file', arguments: JSON.stringify({ filePath: 'src/write-old.js' }) } },
      // Write once via assistant tool-call + tool/result sourceEventSeqs with SAME callId -> MUST NOT double count (+10, latestSeq=4)
      { seq: 4, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'tool-call', callId: 'c4', toolName: 'edit_file', args: { target_file: 'src/write-new.js' } }] } } },
      { seq: 5, type: 'tool/call', data: { callId: 'c4', name: 'edit_file', arguments: JSON.stringify({ target_file: 'src/write-new.js' }) } },
      { seq: 6, type: 'tool/result', sourceEventSeqs: [5], data: { message: { role: 'tool', toolCallId: 'c4', content: [{ type: 'text', text: 'ok' }] } } },
      // Read once at seq 7 via sourceEventSeqs -> tool/call only (+4, latestSeq=7)
      { seq: 7, type: 'tool/call', data: { callId: 'c7', name: 'read_file', arguments: JSON.stringify({ filename: 'src/read-new.js' }) } },
      { seq: 8, type: 'tool/result', sourceEventSeqs: [7], data: { message: { role: 'tool', toolCallId: 'c7', content: [{ type: 'text', text: 'old' }] } } },
      // Shell path in command arg (+4, latestSeq=9)
      { seq: 9, type: 'tool/call', data: { callId: 'c9', name: 'bash', arguments: JSON.stringify({ command: 'cat src/shell-read.js ../outside/ignore.txt /etc/passwd' }) } },
    ];

    const session = createMockSession({ cwd: ws, events });
    const shadowedSeqs = [0, 1, 2, 3, 4, 6, 8, 9];
    const archivedFiles = ['src/archived-only.js', 'src/extra-archived.js', 'src/read-old.js'];

    const res = collectActiveWorkspaceFiles({
      session,
      shadowedSeqs,
      archivedFiles,
      maxFiles: 7,
    });

    assert.deepEqual(
      res.files.map((f) => f.path),
      [
        'src/write-new.js', // score 10, latestSeq 4
        'src/write-old.js', // score 10, latestSeq 3
        'src/read-twice.js', // score 8, latestSeq 2
        'src/shell-read.js', // score 4, latestSeq 9
        'src/read-new.js', // score 4, latestSeq 7
        'src/read-old.js', // score 4, latestSeq 0 (NOT boosted to 6 by archivedFiles!)
        'src/archived-only.js', // score 2, latestSeq -1, alpha before extra-archived.js
      ],
    );

    // Same score & same latestSeq -> touchCount descending, then display path ascending
    const tieEvents = [
      { seq: 0, type: 'tool/call', data: { callId: 't0', name: 'read_file', arguments: JSON.stringify({ path: 'src/read-old.js' }) } },
      {
        seq: 1,
        type: 'assistant/message',
        data: {
          message: {
            role: 'assistant',
            content: [
              { type: 'tool-call', callId: 't1a', toolName: 'read_file', args: { file: 'src/write-old.js' } },
              { type: 'tool-call', callId: 't1b', toolName: 'read_file', args: { file: 'src/read-old.js' } },
              { type: 'tool-call', callId: 't1c', toolName: 'read_file', args: { file: 'src/read-new.js' } },
            ],
          },
        },
      },
    ];
    const tieSession = createMockSession({ cwd: ws, events: tieEvents });
    // read-old.js has score 8 (2 touches), read-new.js & write-old.js both have score 4, seq 1, touchCount 1 -> read-new.js < write-old.js
    const tieRes = collectActiveWorkspaceFiles({ session: tieSession, shadowedSeqs: [0, 1], maxFiles: 3 });
    assert.deepEqual(
      tieRes.files.map((f) => f.path),
      ['src/read-old.js', 'src/read-new.js', 'src/write-old.js'],
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ── 4. Fresh post-edit disk content vs stale transcript content + missing skip ──
await test('fresh-post-edit-disk-content-vs-stale-transcript', async () => {
  const base = await mkdtemp(join(TEST_BASE, 'weave-reinject-fresh-'));
  try {
    const ws = join(base, 'ws');
    await mkdir(join(ws, 'src'), { recursive: true });
    await writeFile(join(ws, 'src', 'live.js'), 'export const version = 2;\n');

    const events = [
      { seq: 0, type: 'tool/call', data: { callId: 'c0', name: 'read_file', arguments: JSON.stringify({ path: 'src/live.js' }) } },
      { seq: 1, type: 'tool/result', sourceEventSeqs: [0], data: { message: { role: 'tool', toolCallId: 'c0', content: [{ type: 'text', text: 'export const version = 1;\n' }] } } },
      { seq: 2, type: 'tool/call', data: { callId: 'c2', name: 'write_file', arguments: JSON.stringify({ path: 'src/deleted.js' }) } },
    ];
    const session = createMockSession({ cwd: ws, events });
    const res = collectActiveWorkspaceFiles({ session, shadowedSeqs: [0, 1, 2] });
    assert.equal(res.files.length, 1);
    assert.equal(res.files[0].path, 'src/live.js');
    assert.equal(res.files[0].content, 'export const version = 2;\n');
    assert.equal(res.files[0].truncated, false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ── 5. Security: symlink escape, traversal, UNC, outside-workspace, directories ──
await test('security-rejects-traversal-unc-outside-dir-and-symlink-escape', async () => {
  const base = await mkdtemp(join(TEST_BASE, 'weave-reinject-sec-'));
  try {
    const ws = join(base, 'ws');
    const outside = join(base, 'outside');
    await mkdir(join(ws, 'src'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(ws, 'src', 'safe.js'), 'export const safe = true;\n');
    await writeFile(join(ws, '.env'), 'SECRET=123\n');
    await writeFile(join(outside, 'leak.txt'), 'OUTSIDE_SECRET');

    let symlinkCreated = false;
    let sensitiveSymlinkCreated = false;
    try {
      await symlink(join(outside, 'leak.txt'), join(ws, 'src', 'escape-link.txt'));
      symlinkCreated = true;
      await symlink(join(ws, '.env'), join(ws, 'src', 'env-alias.txt'));
      sensitiveSymlinkCreated = true;
    } catch {
      // Unprivileged Windows without Developer Mode may disallow symlink creation; skip symlink-specific assertion if so.
    }

    const events = [
      { seq: 0, type: 'tool/call', data: { callId: 's0', name: 'write_file', arguments: JSON.stringify({ path: '../outside/leak.txt' }) } },
      { seq: 1, type: 'tool/call', data: { callId: 's1', name: 'write_file', arguments: JSON.stringify({ path: 'src/../../outside/leak.txt' }) } },
      { seq: 2, type: 'tool/call', data: { callId: 's2', name: 'write_file', arguments: JSON.stringify({ path: 'src/../src/safe.js' }) } },
      { seq: 3, type: 'tool/call', data: { callId: 's3', name: 'write_file', arguments: JSON.stringify({ path: join(outside, 'leak.txt') }) } },
      { seq: 4, type: 'tool/call', data: { callId: 's4', name: 'write_file', arguments: JSON.stringify({ path: '\\\\server\\share\\file.txt' }) } },
      { seq: 5, type: 'tool/call', data: { callId: 's5', name: 'write_file', arguments: JSON.stringify({ path: '\\\\?\\C:\\ws\\safe.js' }) } },
      { seq: 6, type: 'tool/call', data: { callId: 's6', name: 'write_file', arguments: JSON.stringify({ path: 'src' }) } },
      { seq: 7, type: 'tool/call', data: { callId: 's7', name: 'write_file', arguments: JSON.stringify({ path: 'src/escape-link.txt' }) } },
      { seq: 8, type: 'tool/call', data: { callId: 's8', name: 'write_file', arguments: JSON.stringify({ path: 'src/env-alias.txt' }) } },
      { seq: 9, type: 'tool/call', data: { callId: 's9', name: 'read_file', arguments: JSON.stringify({ path: 'src/safe.js' }) } },
    ];

    const session = createMockSession({ cwd: ws, events });
    const res = collectActiveWorkspaceFiles({
      session,
      shadowedSeqs: events.map((e) => e.seq),
      archivedFiles: ['../outside/leak.txt', 'src/escape-link.txt'],
    });

    assert.deepEqual(res.files.map((f) => f.path), ['src/safe.js']);
    assert.ok(!res.text.includes('OUTSIDE_SECRET'));
    assert.ok(!res.text.includes('SECRET=123'));
    if (symlinkCreated || sensitiveSymlinkCreated) {
      assert.ok(!res.files.some((f) => f.path.includes('escape-link') || f.path.includes('env-alias')));
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ── 6. Sensitive files, binary extensions, and NUL byte rejection ───────────────
await test('security-rejects-sensitive-binary-and-nul-files', async () => {
  const base = await mkdtemp(join(TEST_BASE, 'weave-reinject-filter-'));
  try {
    const ws = join(base, 'ws');
    await mkdir(join(ws, 'sub', 'secrets'), { recursive: true });
    await mkdir(join(ws, 'config', 'Credentials'), { recursive: true });
    await mkdir(join(ws, '.git'), { recursive: true });
    await mkdir(join(ws, 'src'), { recursive: true });

    const blockedFiles = [
      ['.env', 'API_KEY=1'],
      ['.env.local', 'API_KEY=2'],
      ['.ENV.production', 'API_KEY=3'],
      ['cert.pem', '-----BEGIN CERT-----'],
      ['private.KEY', 'key'],
      ['keystore.p12', 'p12'],
      ['cert.PFX', 'pfx'],
      ['id_rsa', 'rsa'],
      ['my_id_ed25519_key', 'ed25519'],
      ['secrets.json', '{"k":"v"}'],
      ['sub/secrets/api.yaml', 'k: v'],
      ['credentials.json', '{"c":1}'],
      ['config/Credentials/prod.txt', 'pw'],
      ['.npmrc', '//registry/:_authToken=x'],
      ['.netrc', 'machine x password y'],
      ['.git/config', '[core]\n'],
      ['token.json', '{"t":"1"}'],
      ['TokenCache.JSON', '{"t":"2"}'],
      ['logo.PNG', 'not really png'],
      ['doc.pdf', '%PDF-1.4'],
      ['archive.tar.gz', 'gz'],
      ['mod.wasm', 'wasm'],
      ['addon.node', 'node'],
      ['store.sqlite', 'sqlite'],
    ];

    for (const [rel, body] of blockedFiles) {
      await writeFile(join(ws, rel), body);
    }

    // Extensionless text file with NUL byte inside first 4KB (at offset 3000)
    const nulBuf = Buffer.alloc(3500, 0x61);
    nulBuf[3000] = 0x00;
    await writeFile(join(ws, 'src', 'data-with-nul'), nulBuf);

    // Legitimate file that should survive
    await writeFile(join(ws, 'src', 'tokenizer.js'), 'export function count() { return 1; }\n');

    const events = [
      ...blockedFiles.map(([rel], idx) => ({
        seq: idx,
        type: 'tool/call',
        data: { callId: `b${idx}`, name: 'write_file', arguments: JSON.stringify({ path: rel }) },
      })),
      { seq: 100, type: 'tool/call', data: { callId: 'bn', name: 'write_file', arguments: JSON.stringify({ path: 'src/data-with-nul' }) } },
      { seq: 101, type: 'tool/call', data: { callId: 'ok', name: 'read_file', arguments: JSON.stringify({ path: 'src/tokenizer.js' }) } },
    ];

    const session = createMockSession({ cwd: ws, events });
    // Also test with small maxFileBytes=512 so NUL check still scans full 4KB sample
    const res = collectActiveWorkspaceFiles({
      session,
      shadowedSeqs: events.map((e) => e.seq),
      maxFiles: 10,
      maxFileBytes: 512,
    });

    assert.deepEqual(res.files.map((f) => f.path), ['src/tokenizer.js']);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ── 6b. Excludes host-resident AGENTS.md / CLAUDE.md (exact basename) ─────────
await test('excludes-host-resident-agents-md-and-claude-md-exact-basename', async () => {
  const base = await mkdtemp(join(TEST_BASE, 'weave-reinject-hostdocs-'));
  try {
    const ws = join(base, 'ws');
    await mkdir(join(ws, 'foo'), { recursive: true });
    await mkdir(join(ws, 'docs'), { recursive: true });
    await mkdir(join(ws, 'src'), { recursive: true });

    await writeFile(join(ws, 'AGENTS.md'), '# root agents instructions\n');
    await writeFile(join(ws, 'CLAUDE.md'), '# root claude instructions\n');
    await writeFile(join(ws, 'foo', 'AGENTS.md'), '# nested agents instructions\n');
    await writeFile(join(ws, 'foo', 'claude.md'), '# nested lowercase claude instructions\n');
    await writeFile(join(ws, 'docs', 'sub-agents.md'), '# substring should NOT be excluded\n');
    await writeFile(join(ws, 'src', 'app.js'), 'export const app = 1;\n');

    const events = [
      { seq: 0, type: 'tool/call', data: { callId: 'hd0', name: 'write_file', arguments: JSON.stringify({ path: 'AGENTS.md' }) } },
      { seq: 1, type: 'tool/call', data: { callId: 'hd1', name: 'edit_file', arguments: JSON.stringify({ path: 'CLAUDE.md' }) } },
      { seq: 2, type: 'tool/call', data: { callId: 'hd2', name: 'write_file', arguments: JSON.stringify({ path: 'foo/AGENTS.md' }) } },
      { seq: 3, type: 'tool/call', data: { callId: 'hd3', name: 'read_file', arguments: JSON.stringify({ path: 'foo/claude.md' }) } },
      { seq: 4, type: 'tool/call', data: { callId: 'hd4', name: 'read_file', arguments: JSON.stringify({ path: 'docs/sub-agents.md' }) } },
      { seq: 5, type: 'tool/call', data: { callId: 'hd5', name: 'write_file', arguments: JSON.stringify({ path: 'src/app.js' }) } },
    ];
    const session = createMockSession({ cwd: ws, events });
    const res = collectActiveWorkspaceFiles({
      session,
      shadowedSeqs: [0, 1, 2, 3, 4, 5],
      archivedFiles: ['AGENTS.md', 'CLAUDE.md', 'foo/AGENTS.md'],
    });

    assert.deepEqual(
      res.files.map((f) => f.path),
      ['src/app.js', 'docs/sub-agents.md'],
    );
    assert.ok(!res.text.includes('root agents instructions'));
    assert.ok(!res.text.includes('root claude instructions'));
    assert.ok(!res.text.includes('nested agents instructions'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ── 7. Per-file UTF-8/surrogate safe truncation & total maxBytes cap ──────────
await test('bounded-read-utf8-surrogate-truncation-and-total-max-bytes', async () => {
  const base = await mkdtemp(join(TEST_BASE, 'weave-reinject-utf8-'));
  try {
    const ws = join(base, 'ws');
    await mkdir(join(ws, 'src'), { recursive: true });

    // Multi-byte CJK (3 bytes) + Emoji surrogate pair 🚀 (4 UTF-8 bytes, 2 UTF-16 code units)
    const unit = '中文🚀'; // 3 + 3 + 4 = 10 UTF-8 bytes
    const bigUtf8 = unit.repeat(40); // 400 UTF-8 bytes
    await writeFile(join(ws, 'src', 'utf8.txt'), bigUtf8);
    await writeFile(join(ws, 'src', 'second.txt'), 'B'.repeat(180));
    await writeFile(join(ws, 'src', 'third.txt'), 'C'.repeat(180));

    const events = [
      { seq: 0, type: 'tool/call', data: { callId: 'u0', name: 'write_file', arguments: JSON.stringify({ path: 'src/third.txt' }) } },
      { seq: 1, type: 'tool/call', data: { callId: 'u1', name: 'write_file', arguments: JSON.stringify({ path: 'src/second.txt' }) } },
      { seq: 2, type: 'tool/call', data: { callId: 'u2', name: 'write_file', arguments: JSON.stringify({ path: 'src/utf8.txt' }) } },
    ];
    const session = createMockSession({ cwd: ws, events });

    // Test every small offset around 190..205 to guarantee no split UTF-8 char or lone surrogate
    for (let cap = 190; cap <= 205; cap += 1) {
      const single = collectActiveWorkspaceFiles({
        session,
        shadowedSeqs: [2],
        maxFileBytes: cap,
        maxBytes: 1000,
      });
      assert.equal(single.files.length, 1);
      const file = single.files[0];
      assert.equal(file.truncated, true);
      assert.ok(file.bytes <= cap, `bytes ${file.bytes} must be <= ${cap}`);
      assert.equal(Buffer.byteLength(file.content, 'utf8'), file.bytes);
      assert.equal(hasLoneSurrogate(file.content), false, 'must never split UTF-16 surrogate pairs');
      assert.ok(!file.content.includes('\uFFFD'), 'must never split UTF-8 multi-byte char into replacement char');
      assert.match(file.content, /\n\[\.\.\. truncated \d+ bytes; read full file from disk before relying on omitted lines \.\.\.\]$/);
    }

    // Total maxBytes cap across multiple files (200 + 180 + 180 -> maxBytes 320 caps cleanly)
    const multi = collectActiveWorkspaceFiles({
      session,
      shadowedSeqs: [0, 1, 2],
      maxFiles: 5,
      maxFileBytes: 200,
      maxBytes: 320,
    });
    assert.ok(multi.files.length >= 2);
    assert.ok(multi.totalBytes <= 320, `totalBytes ${multi.totalBytes} must be <= 320`);
    assert.equal(
      multi.totalBytes,
      multi.files.reduce((sum, f) => sum + f.bytes, 0),
    );
    assert.match(multi.text, new RegExp(`^<active-workspace-files count="${multi.files.length}" total-bytes="${multi.totalBytes}" scope="local-workspace">`));
    assert.match(multi.text, /<\/active-workspace-files>$/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ── 8. Synthetic/remote sessions & zero/negative limits return empty ──────────
await test('synthetic-remote-and-zero-limits-return-empty', async () => {
  const base = await mkdtemp(join(TEST_BASE, 'weave-reinject-empty-'));
  try {
    const ws = join(base, 'ws');
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, 'a.js'), 'export const a = 1;\n');

    const localSession = createMockSession({
      cwd: ws,
      events: [{ seq: 0, type: 'tool/call', data: { callId: 'a0', name: 'write_file', arguments: JSON.stringify({ path: 'a.js' }) } }],
    });

    for (const badSession of [
      null,
      createMockSession({ cwd: undefined }),
      createMockSession({ cwd: join(base, 'does-not-exist') }),
      createMockSession({ cwd: '\\\\remote-server\\share\\ws' }),
    ]) {
      const r = collectActiveWorkspaceFiles({
        session: badSession,
        shadowedSeqs: [0],
        archivedFiles: ['a.js'],
      });
      assert.deepEqual(r, { files: [], totalBytes: 0, text: '' });
    }

    for (const badLimit of [
      { maxFiles: 0 },
      { maxFiles: -1 },
      { maxBytes: 0 },
      { maxFileBytes: 0 },
    ]) {
      const r = collectActiveWorkspaceFiles({
        session: localSession,
        shadowedSeqs: [0],
        ...badLimit,
      });
      assert.deepEqual(r, { files: [], totalBytes: 0, text: '' });
    }

    assert.equal(renderActiveWorkspaceFiles(null), '');
    assert.equal(renderActiveWorkspaceFiles({ files: [], totalBytes: 0 }), '');
    assert.equal(renderActiveWorkspaceFiles({ files: [{ path: 'a.js', bytes: 5, truncated: false, content: 'hello' }] }, { maxFiles: 0 }), '');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ── 9. buildCheckpointBlocks placement (after diskLiveness/archivePointer, before progress/workReport) ──
await test('build-checkpoint-blocks-active-files-placement', () => {
  const activeBlock = renderActiveWorkspaceFiles({
    files: [{ path: 'src/app.js', bytes: 18, truncated: false, content: 'export const x=1;\n' }],
    totalBytes: 18,
  });
  const blocks = buildCheckpointBlocks(
    [{ type: 'text', text: 'Summary body.' }],
    [{ seq: 1, text: 'Keep tests green.' }],
    CHECKPOINT_PREAMBLE,
    {
      archive: { compactionId: 'cmp-1', startSeq: 1, endSeq: 5, files: ['src/app.js'] },
      diskLiveness: '<disk-state-check checked-at="2026-11-22T08:00Z" scope="local-workspace">\n- Missing on disk at compaction: src/gone.js\n</disk-state-check>',
      activeFiles: `  ${activeBlock}  `,
      progress: { scope: { start: 1, end: 5, count: 4 }, local: [{ seq: 1, key: 'doneCount', value: 1, scope: 'current-work', excerpt: 'doneCount=1' }] },
      workReport: { seq: 4, text: 'Completed step 1.', sha256: 'abc' },
    },
  );

  const texts = blocks.map((b) => b.text);
  const archiveIdx = texts.findIndex((t) => t.startsWith('History archive:'));
  const diskIdx = texts.findIndex((t) => t.startsWith('<disk-state-check'));
  const activeIdx = texts.findIndex((t) => t.startsWith('<active-workspace-files'));
  const progressIdx = texts.findIndex((t) => t.startsWith('Source-backed progress claims'));
  const workIdx = texts.findIndex((t) => t.startsWith('Latest assistant work report'));
  const preservedIdx = texts.findIndex((t) => t.startsWith('<preserved-user-messages>'));

  assert.ok(archiveIdx >= 0);
  assert.ok(diskIdx === archiveIdx + 1);
  assert.ok(activeIdx === diskIdx + 1, `expected activeFiles right after diskLiveness (got activeIdx=${activeIdx}, diskIdx=${diskIdx})`);
  assert.ok(progressIdx === activeIdx + 1);
  assert.ok(workIdx === progressIdx + 1);
  assert.ok(preservedIdx === workIdx + 1);
  assert.equal(blocks[activeIdx].text, activeBlock);

  const joined = blocksToText(blocks);
  assert.ok(joined.includes('<active-workspace-files count="1" total-bytes="18" scope="local-workspace">'));

  // Without diskLiveness, activeFiles follows archivePointer; whitespace-only activeFiles omitted
  const noDiskBlocks = buildCheckpointBlocks(
    [{ type: 'text', text: 'Summary body.' }],
    [],
    CHECKPOINT_PREAMBLE,
    {
      archive: { compactionId: 'cmp-2', startSeq: 1, endSeq: 5 },
      activeFiles: activeBlock,
    },
  );
  const noDiskTexts = noDiskBlocks.map((b) => b.text);
  assert.equal(noDiskTexts.findIndex((t) => t.startsWith('<active-workspace-files')), noDiskTexts.findIndex((t) => t.startsWith('History archive:')) + 1);

  const blankActive = buildCheckpointBlocks(
    [{ type: 'text', text: 'Summary body.' }],
    [],
    CHECKPOINT_PREAMBLE,
    { activeFiles: '   \n  ' },
  );
  assert.ok(!blocksToText(blankActive).includes('<active-workspace-files'));
});

// ── 10. auditCompaction strips <active-workspace-files> before backup coverage check ──
await test('audit-strips-active-workspace-files-and-prevents-tag-breakout', () => {
  const droppedRule = 'Do not delete production backups';
  const renderedActive = renderActiveWorkspaceFiles({
    files: [
      {
        path: 'src/notes.js',
        bytes: 120,
        truncated: false,
        content: `// ${droppedRule}\n// </active-workspace-files>\n// ${droppedRule}`,
      },
    ],
    totalBytes: 120,
  });

  // Escaped closing tag inside rendered wrapper prevents premature breakout
  assert.ok(renderedActive.includes('&lt;/active-workspace-files>'));

  const summaryWithoutConstraint = 'Refactored storage cleanup module.';
  const checkpointWithReinject = `${summaryWithoutConstraint}\n\n${renderedActive}`;

  const report = auditCompaction({
    userMessages: [{ seq: 1, text: droppedRule }],
    summaryText: summaryWithoutConstraint,
    checkpointText: checkpointWithReinject,
    threshold: 0.6,
  });

  assert.equal(report.checked, 1);
  assert.equal(report.lost.length, 1);
  assert.equal(report.lost[0].reason, 'coverage');

  // Same check for CJK constraint inside <active-workspace-files>
  const zhRule = '必须保留整数分计价';
  const zhActive = renderActiveWorkspaceFiles({
    files: [{ path: 'src/price.js', bytes: 32, truncated: false, content: `// ${zhRule}\n` }],
    totalBytes: 32,
  });
  const zhReport = auditCompaction({
    userMessages: [{ seq: 2, text: zhRule }],
    summaryText: '已完成价格模块重构。',
    checkpointText: `已完成价格模块重构。\n\n${zhActive}`,
    threshold: 0.6,
  });
  assert.equal(zhReport.lost.length, 1);
  assert.equal(zhReport.lost[0].reason, 'coverage');
});

console.log(
  JSON.stringify(
    {
      passed: results.filter((r) => r.pass).length,
      failed: results.filter((r) => !r.pass).length,
      results,
    },
    null,
    2,
  ),
);
if (results.some((r) => !r.pass)) process.exitCode = 1;
