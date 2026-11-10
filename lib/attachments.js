import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, rename, rm} from 'node:fs/promises';
import {join} from 'node:path';

const digestOf = ref => {
  const match = /^sha256:([a-f0-9]{64})$/.exec(ref?.attachmentId ?? '');
  if (!match || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new Error('attachment reference is not a verified host content address');
  return match[1];
};
/** Collect every nested image/file block without flattening or mutating the original events. */
export function attachmentReferences(entries) {
  const found = new Map();
  const blocks = [];
  for (const entry of entries) {
    for (const content of [entry?.blocks, entry?.event?.data?.content, entry?.event?.data?.message?.content]) if (Array.isArray(content)) for (const block of content) blocks.push(block);
    for (const source of [entry?.source,entry?.event?.data?.source,entry?.event?.data?.message?.source])
      if (Array.isArray(source?.preserved)) for (const message of source.preserved) if (Array.isArray(message.blocks)) for (const block of message.blocks) blocks.push(block);
  }
  for (const item of blocks) {
    if (item?.type !== 'image' && item?.type !== 'file') continue;
    const ref = item.attachment; digestOf(ref);
    const key = item.type + ':' + ref.attachmentId;
    if (found.has(key) && found.get(key).ref.bytes !== ref.bytes) throw new Error('conflicting attachment byte counts');
    found.set(key, {type:item.type, ref});
  }
  return [...found.values()];
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
/** Back up admitted image bytes / verbatim file bytes before publishing the text archive. */
export async function preserveAttachments(dir, entries, provider, signal) {
  const refs=attachmentReferences(entries);if(!refs.length)return [];
  await mkdir(join(dir,'attachments'),{recursive:true});
  for(const {type,ref} of refs) {
    try {await readAttachmentPage(dir,ref,0,1,signal);continue;}catch(error){if(signal?.aborted)throw error;}
    if(!provider)throw new Error('attachments service is unavailable; refusing to discard unarchived binary content');
    const digest=digestOf(ref),file=join(dir,'attachments',digest+'.blob'),temp=file+'.'+randomUUID()+'.tmp';let handle;
    try {
      handle=await open(temp,'wx');let count=0;const hash=createHash('sha256');
      const stream=type==='file'?provider.readFileStream(ref,signal):[ (await provider.readImage(ref,signal)).data ];
      for await(const data of stream) {
        signal?.throwIfAborted();const chunk=Buffer.from(data);hash.update(chunk);count+=chunk.length;
        if(count>ref.bytes)throw new Error('attachment exceeds its declared size');
        let offset=0;while(offset<chunk.length){const {bytesWritten}=await handle.write(chunk,offset,chunk.length-offset,count-chunk.length+offset);if(!bytesWritten)throw new Error('short attachment write');offset+=bytesWritten;}
      }
      if(count!==ref.bytes || hash.digest('hex')!==digest)throw new Error('attachment source size/SHA-256 mismatch');
      await handle.sync();await handle.close();handle=null;await rename(temp,file);
    } finally {if(handle)await handle.close().catch(()=>{});await rm(temp,{force:true}).catch(()=>{});}
  }
  return refs.map(({type,ref})=>({type,attachmentId:ref.attachmentId,bytes:ref.bytes}));
}
