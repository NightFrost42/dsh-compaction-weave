import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, rename, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';

const tryDigestOf = ref => {
  const match = /^sha256:([a-f0-9]{64})$/.exec(ref?.attachmentId ?? '');
  if (!match || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) return null;
  return match[1];
};
const digestOf = ref => {
  const digest = tryDigestOf(ref);
  if (!digest) throw new Error('attachment reference is not a verified host content address');
  return digest;
};
/** Collect every nested image/file block without flattening or mutating the original events. */
export function attachmentReferences(entries, options = {}) {
  const allowForeignFallback = options?.allowForeignFallback === true;
  const found = new Map();
  const blocks = [];
  for (const entry of entries) {
    for (const content of [entry?.blocks, entry?.event?.data?.content, entry?.event?.data?.message?.content]) if (Array.isArray(content)) for (const block of content) blocks.push(block);
    for (const source of [entry?.source,entry?.event?.data?.source,entry?.event?.data?.message?.source])
      if (Array.isArray(source?.preserved)) for (const message of source.preserved) if (Array.isArray(message?.blocks)) for (const block of message.blocks) blocks.push(block);
  }
  for (const item of blocks) {
    if (item?.type !== 'image' && item?.type !== 'file') continue;
    const ref = item.attachment;
    if (allowForeignFallback) {
      if (!tryDigestOf(ref)) continue;
    } else {
      digestOf(ref);
    }
    const key = item.type + ':' + ref.attachmentId;
    if (found.has(key) && found.get(key).ref.bytes !== ref.bytes) throw new Error('conflicting attachment byte counts');
    found.set(key, {type:item.type, ref});
  }
  return [...found.values()];
}
/** Check that an attachment blob exists on disk with its declared byte size. */
export async function statAttachment(dir, ref) {
  const digest = digestOf(ref);
  const info = await stat(join(dir, 'attachments', digest + '.blob'));
  if (!info.isFile() || info.size !== ref.bytes) throw new Error('attachment missing or size mismatch');
  return info;
}
/** Verify the whole object through one open handle and retain at most one bounded page. */
export async function readAttachmentPage(dir, ref, offset=0, limit=32768, signal) {
  const digest = digestOf(ref);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > ref.bytes || !Number.isSafeInteger(limit) || limit < 1 || limit > 32768) throw new Error('invalid attachment byte page');
  const handle = await open(join(dir,'attachments',digest+'.blob'),'r');
  const hash = createHash('sha256'), chunks=[];let count=0;
  try {
    const buffer = Buffer.alloc(65536);
    for (;;) {
      signal?.throwIfAborted(); const {bytesRead} = await handle.read(buffer,0,buffer.length,count);if(!bytesRead)break;
      const chunk=buffer.subarray(0,bytesRead);hash.update(chunk);
      const start=Math.max(0,offset-count),end=Math.min(bytesRead,offset+limit-count);
      if(end>start)chunks.push(Buffer.from(chunk.subarray(start,end)));
      count+=bytesRead;
    }
    if(count!==ref.bytes || hash.digest('hex')!==digest)throw new Error('archived attachment failed full size/SHA-256 verification');
    const bytes=Buffer.concat(chunks);const next=offset+bytes.length;
    return {attachmentId:ref.attachmentId,verified:true,encoding:'base64',byteOffset:offset,totalBytes:count,nextByteOffset:next<count?next:null,base64:bytes.toString('base64')};
  } finally {await handle.close();}
}
/** Verify the complete blob size and SHA-256 digest without retaining bytes or exposing host paths. */
export async function verifyAttachment(dir, ref, signal) {
  const digest = digestOf(ref);
  let handle;
  try {
    handle = await open(join(dir, 'attachments', digest + '.blob'), 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('archived attachment blob missing');
    throw new Error(`archived attachment unreadable (${error?.code ?? 'I/O error'})`);
  }
  const hash = createHash('sha256');
  let count = 0;
  try {
    const buffer = Buffer.alloc(65536);
    for (;;) {
      signal?.throwIfAborted?.();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, count);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      count += bytesRead;
    }
    if (count !== ref.bytes || hash.digest('hex') !== digest) {
      throw new Error('archived attachment failed full size/SHA-256 verification');
    }
    return { attachmentId: ref.attachmentId, bytes: count, verified: true };
  } finally {
    await handle.close();
  }
}
/** Back up admitted image bytes / verbatim file bytes before publishing the text archive. */
export async function preserveAttachments(dir, entries, provider, signal, options = {}) {
  const allowForeignFallback = options?.allowForeignFallback === true;
  const refs=attachmentReferences(entries, options);if(!refs.length)return [];
  await mkdir(join(dir,'attachments'),{recursive:true,mode:0o700});
  const preserved=[];
  for(const {type,ref} of refs) {
    try {await readAttachmentPage(dir,ref,0,1,signal);preserved.push({type,attachmentId:ref.attachmentId,bytes:ref.bytes});continue;}catch(error){if(signal?.aborted)throw error;}
    if(!provider) {
      if(allowForeignFallback) continue;
      throw new Error('attachments service is unavailable; refusing to discard unarchived binary content');
    }
    const digest=digestOf(ref),file=join(dir,'attachments',digest+'.blob'),temp=file+'.'+randomUUID()+'.tmp';let handle;
    try {
      handle=await open(temp,'wx',0o600);let count=0;const hash=createHash('sha256');
      const stream=type==='file'?provider.readFileStream(ref,signal):[ (await provider.readImage(ref,signal)).data ];
      for await(const data of stream) {
        signal?.throwIfAborted();const chunk=Buffer.from(data);hash.update(chunk);count+=chunk.length;
        if(count>ref.bytes)throw new Error('attachment exceeds its declared size');
        let offset=0;while(offset<chunk.length){const {bytesWritten}=await handle.write(chunk,offset,chunk.length-offset,count-chunk.length+offset);if(!bytesWritten)throw new Error('short attachment write');offset+=bytesWritten;}
      }
      if(count!==ref.bytes || hash.digest('hex')!==digest)throw new Error('attachment source size/SHA-256 mismatch');
      await handle.sync();await handle.close();handle=null;await rename(temp,file);
      preserved.push({type,attachmentId:ref.attachmentId,bytes:ref.bytes});
    } catch (error) {
      if (signal?.aborted || !allowForeignFallback) throw error;
    } finally {if(handle)await handle.close().catch(()=>{});await rm(temp,{force:true}).catch(()=>{});}
  }
  return preserved;
}
