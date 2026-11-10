import { createHash } from 'node:crypto';
import { existsSync, readdirSync, openSync, readSync, closeSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const legacySegment = value => String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
/** Collision-resistant session directory; migrate legacy data only when its headers prove ownership. */
export function sessionDirectory(root, sessionId, kind) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('storage requires a nonempty session id');
  const target = join(root, 's-' + createHash('sha256').update(sessionId).digest('hex'));
  if (existsSync(target)) return target;
  const name = legacySegment(sessionId);
  if (!name || name === '.' || name === '..' || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return target;
  const legacy = join(root, name);
  if (!existsSync(legacy)) return target;
  const owned = [], foreign = [];
  const files = readdirSync(legacy);
  for (const name of files) {
    if (name === 'index.jsonl' || !name.endsWith(kind === 'archive' ? '.jsonl' : '.json')) continue;
    const path = join(legacy, name); const fd = openSync(path, 'r'); let record;
    try {
      const bytes = Buffer.alloc(Math.min(65536, statSync(path).size));
      const length = readSync(fd, bytes, 0, bytes.length, 0); const text = bytes.subarray(0,length).toString('utf8');
      if (kind === 'archive') record = JSON.parse(text.split('\n',1)[0]);
      else {
        // Journal snapshots can be large. Ownership is a top-level field, so use
        // JSON parsing of the full file, never an ambiguous substring match.
        if (statSync(path).size > bytes.length) {
          const full = Buffer.alloc(statSync(path).size); let offset = 0;
          while (offset < full.length) { const read = readSync(fd,full,offset,full.length-offset,offset); if (!read) throw new Error('short legacy journal'); offset += read; }
          record = JSON.parse(full.toString('utf8'));
        } else record = JSON.parse(text);
      }
    } finally { closeSync(fd); }
    if (record?.sessionId === sessionId) owned.push(name); else foreign.push(name);
  }
  if (owned.length && foreign.length) throw new Error('legacy storage contains mixed session identities; retain it for recovery');
  if (foreign.length) return target;
  if (!owned.length && files.length) throw new Error('legacy storage ownership cannot be established; retain its index and files');
  try { renameSync(legacy,target); }
  catch (error) { if (!(error.code === 'ENOENT' && existsSync(target))) throw error; }
  return target;
}
