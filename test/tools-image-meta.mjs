import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyAttachment } from '../lib/attachments.js';
import { CompactionArchive, HISTORY_TOOLS } from '../lib/history.js';
import { __test } from '../lib/tools.js';

const { runTool } = __test;
const baseRoot = process.env.WEAVE_TEST_ROOT ?? tmpdir();

const results = [];
async function test(name, fn) {
  const start = performance.now();
  try {
    await fn();
    results.push({ name, pass: true, ms: Math.round(performance.now() - start) });
  } catch (error) {
    results.push({
      name,
      pass: false,
      error: error?.message ?? String(error),
      stack: error?.stack,
    });
  }
}

await test('history-tools-schema-declares-rawBase64', () => {
  const readSpec = HISTORY_TOOLS.find((t) => t.name === 'history_read');
  assert.ok(readSpec);
  assert.equal(readSpec.parameters.additionalProperties, false);
  assert.deepEqual(readSpec.parameters.properties.rawBase64?.type, 'boolean');
});

await test('image-attachment-defaults-to-verified-metadata-without-base64-or-host-paths', async () => {
  const root = await mkdtemp(join(baseRoot, 'weave-img-meta-'));
  try {
    const imgBytes = Buffer.alloc(65536, 0x2a);
    const fileBytes = Buffer.alloc(40960, 0x4b);
    const imgDigest = createHash('sha256').update(imgBytes).digest('hex');
    const fileDigest = createHash('sha256').update(fileBytes).digest('hex');
    const imgRef = {
      attachmentId: `sha256:${imgDigest}`,
      mediaType: 'image/png',
      width: 1280,
      height: 720,
      bytes: imgBytes.length,
      name: 'shot.png',
    };
    const fileRef = {
      attachmentId: `sha256:${fileDigest}`,
      mediaType: 'application/octet-stream',
      bytes: fileBytes.length,
      name: 'report.bin',
    };

    const archiveDir = join(root, 'archive');
    const archive = new CompactionArchive({ root: archiveDir });
    archive.attachments = {
      async readImage(ref) {
        assert.equal(ref.attachmentId, imgRef.attachmentId);
        return { data: imgBytes };
      },
      async *readFileStream(ref) {
        assert.equal(ref.attachmentId, fileRef.attachmentId);
        yield fileBytes;
      },
    };

    const sid = 'session-img-meta';
    await archive.writeSpan({
      sessionId: sid,
      compactionId: 'cmp-1',
      entries: [
        {
          seq: 1,
          type: 'user/message',
          role: 'user',
          text: 'inspect screenshot and report',
          blocks: [
            { type: 'image', attachment: imgRef },
            { type: 'file', attachment: fileRef },
          ],
        },
      ],
    });
    await archive.writeSpan({
      sessionId: sid,
      compactionId: 'cmp-other',
      entries: [{ seq: 2, type: 'user/message', role: 'user', text: 'empty span' }],
    });

    // Default history_read on image attachment -> compact verified metadata only
    const metaOut = await runTool(
      'history_read',
      archive,
      { compactionId: 'cmp-1', attachmentId: imgRef.attachmentId },
      { session: { id: sid } },
    );
    assert.ok(metaOut.length < 1024, `expected compact metadata JSON (<1024 chars), got ${metaOut.length}`);
    const parsedMeta = JSON.parse(metaOut);
    assert.equal(parsedMeta.type, 'image');
    assert.equal(parsedMeta.attachmentId, imgRef.attachmentId);
    assert.equal(parsedMeta.mediaType, 'image/png');
    assert.equal(parsedMeta.width, 1280);
    assert.equal(parsedMeta.height, 720);
    assert.equal(parsedMeta.bytes, imgBytes.length);
    assert.equal(parsedMeta.name, 'shot.png');
    assert.equal(parsedMeta.verified, true);
    assert.equal(parsedMeta.encoding, 'metadata-only');
    assert.equal(parsedMeta.base64, undefined);
    assert.match(parsedMeta.note, /rawBase64:\s*true/);
    assert.ok(!metaOut.includes(archiveDir), 'must never expose host archive path');
    assert.ok(!metaOut.includes('.blob'), 'must never expose internal blob filename');

    // Explicit rawBase64: true on image attachment -> paginated base64 chunks
    const imgChunks = [];
    let offset = 0;
    do {
      const pageStr = await runTool(
        'history_read',
        archive,
        {
          compactionId: 'cmp-1',
          attachmentId: imgRef.attachmentId,
          rawBase64: true,
          byteOffset: offset,
          byteLimit: 32768,
        },
        { session: { id: sid } },
      );
      const page = JSON.parse(pageStr);
      assert.equal(page.verified, true);
      assert.equal(page.encoding, 'base64');
      imgChunks.push(Buffer.from(page.base64, 'base64'));
      offset = page.nextByteOffset;
    } while (offset !== null);
    assert.deepEqual(Buffer.concat(imgChunks), imgBytes);

    // Non-image file without rawBase64 keeps original base64 paging
    const fileChunks = [];
    let fileOffset = 0;
    do {
      const pageStr = await runTool(
        'history_read',
        archive,
        {
          compactionId: 'cmp-1',
          attachmentId: fileRef.attachmentId,
          byteOffset: fileOffset,
          byteLimit: 16384,
        },
        { session: { id: sid } },
      );
      const page = JSON.parse(pageStr);
      assert.equal(page.verified, true);
      assert.equal(page.encoding, 'base64');
      fileChunks.push(Buffer.from(page.base64, 'base64'));
      fileOffset = page.nextByteOffset;
    } while (fileOffset !== null);
    assert.deepEqual(Buffer.concat(fileChunks), fileBytes);

    // CompactionArchive.readAttachment legacy contract unchanged
    const directPage = await archive.readAttachment(sid, 'cmp-1', imgRef.attachmentId, 0, 128);
    assert.equal(directPage.verified, true);
    assert.equal(directPage.encoding, 'base64');
    assert.equal(directPage.totalBytes, imgBytes.length);
    assert.deepEqual(Buffer.from(directPage.base64, 'base64'), imgBytes.subarray(0, 128));

    // Cross-span access refused
    await assert.rejects(archive.inspectAttachment(sid, 'cmp-other', imgRef.attachmentId), /does not belong/);
    const crossToolOut = await runTool(
      'history_read',
      archive,
      { compactionId: 'cmp-other', attachmentId: imgRef.attachmentId },
      { session: { id: sid } },
    );
    assert.match(crossToolOut, /^Cannot read archived attachment: .*does not belong/);

    // Tampered .blob rejected cleanly (full SHA-256 verification)
    const blobPath = join(archive.dirFor(sid), 'attachments', `${imgDigest}.blob`);
    const corrupted = Buffer.from(imgBytes);
    corrupted[0] ^= 0xff;
    await writeFile(blobPath, corrupted);
    await assert.rejects(verifyAttachment(archive.dirFor(sid), imgRef), /SHA-256|verification/);
    await assert.rejects(archive.inspectAttachment(sid, 'cmp-1', imgRef.attachmentId), /attachment|verification/);
    const corruptToolOut = await runTool(
      'history_read',
      archive,
      { compactionId: 'cmp-1', attachmentId: imgRef.attachmentId },
      { session: { id: sid } },
    );
    assert.match(corruptToolOut, /^Cannot read archived attachment:/);
    assert.ok(!corruptToolOut.includes(archiveDir));

    // Missing .blob rejected cleanly without exposing host path
    await unlink(blobPath);
    await assert.rejects(verifyAttachment(archive.dirFor(sid), imgRef), (err) => {
      assert.match(err.message, /missing/);
      assert.ok(!err.message.includes(archiveDir));
      return true;
    });
    await assert.rejects(archive.inspectAttachment(sid, 'cmp-1', imgRef.attachmentId), /attachment|missing/);
    const missingToolOut = await runTool(
      'history_read',
      archive,
      { compactionId: 'cmp-1', attachmentId: imgRef.attachmentId },
      { session: { id: sid } },
    );
    assert.match(missingToolOut, /^Cannot read archived attachment:/);
    assert.ok(!missingToolOut.includes(archiveDir), 'missing blob error must not leak host path');
    assert.ok(!missingToolOut.includes('.blob'), 'missing blob error must not leak blob path');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('history-read-treats-null-and-blank-optional-args-as-omitted', async () => {
  const root = await mkdtemp(join(baseRoot, 'weave-strict-tool-args-'));
  try {
    const archive = new CompactionArchive({ root: join(root, 'archive') });
    const sid = 'session-strict-args';
    await archive.writeSpan({
      sessionId: sid,
      compactionId: 'cmp-1',
      entries: [
        { seq: 1, type: 'user/message', role: 'user', text: 'strict schema keeps null and empty optional args' },
        { seq: 2, type: 'tool/result', role: 'tool', text: 'busyTimeoutMs: 4750, lockCode: SQLITE_BUSY_SNAPSHOT_517' },
      ],
    });

    const spanRead = await runTool(
      'history_read',
      archive,
      { compactionId: 'cmp-1', seq: null, attachmentId: '' },
      { session: { id: sid } },
    );
    assert.match(spanRead, /# cmp-1 \(entries 1-2 of 2\)/);
    assert.match(spanRead, /SQLITE_BUSY_SNAPSHOT_517/);

    const seqFormatted = await runTool(
      'history_read',
      archive,
      {
        compactionId: ' cmp-1 ',
        seq: 1,
        attachmentId: null,
        charOffset: null,
        charLimit: null,
        offset: null,
        limit: null,
        raw: null,
        full: null,
        rawBase64: null,
      },
      { session: { id: sid } },
    );
    assert.match(seqFormatted, /^[\s\S]*# cmp-1 seq 1 \(1 of 2 entries\)/);
    assert.ok(!seqFormatted.startsWith('{"compactionId":'));

    const locateBySeq = await runTool(
      'history_read',
      archive,
      { compactionId: '   ', seq: 2, attachmentId: '   ' },
      { session: { id: sid } },
    );
    assert.match(locateBySeq, /# cmp-1 seq 2 \(1 of 2 entries\)/);
    assert.match(locateBySeq, /busyTimeoutMs: 4750/);

    const missingTarget = await runTool(
      'history_read',
      archive,
      { compactionId: null, seq: '', attachmentId: '' },
      { session: { id: sid } },
    );
    assert.equal(missingTarget, 'history_read requires a compactionId (or a seq to locate its archived span; see history_list).');

    assert.equal(
      await runTool('history_read', archive, { compactionId: 'cmp-1', seq: -1 }, { session: { id: sid } }),
      'history_read seq must be a non-negative safe integer.',
    );
    assert.equal(
      await runTool('history_read', archive, { compactionId: 'cmp-1', seq: 'abc' }, { session: { id: sid } }),
      'history_read seq must be a non-negative safe integer.',
    );
    assert.match(
      await runTool('history_read', archive, { compactionId: 'cmp-1', attachmentId: 123 }, { session: { id: sid } }),
      /attachmentId must be a string/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
console.log(JSON.stringify({ passed, failed, results }, null, 2));
if (failed > 0) process.exitCode = 1;
