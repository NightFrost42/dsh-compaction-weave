import {atomicReplaceSync} from './atomic-replace.js';
// Accepted working notes only; never an authority to replace session history.
// A checksum-bound, atomic checkpoint makes interrupted summary work reusable.
import {createHash,randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {mkdirSync,readFileSync,statSync,openSync,writeFileSync,fsyncSync,closeSync,unlinkSync} from 'node:fs';
const MAX_PROGRESS_BYTES=4194304;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const digest=value=>createHash('sha256').update(value).digest('hex');
const error=(code,message)=>Object.assign(new Error(message),{code});
export class ContinuationProgressStore {
  constructor(root,sessionId,key){
    if(typeof sessionId!=='string'||!sessionId||!/^[a-f0-9]{64}$/.test(key))throw error('CONTINUATION_PROGRESS_INVALID','Invalid continuation progress identity.');
    this.sessionId=sessionId;this.key=key;this.file=join(resolve(root),digest(sessionId),key+'.json');
  }
  read(){
    let record;
    try{if(statSync(this.file).size>MAX_PROGRESS_BYTES)throw error('CONTINUATION_PROGRESS_INVALID','Continuation progress exceeds its storage bound.');record=JSON.parse(readFileSync(this.file,'utf8'));}
    catch(e){if(e.code==='ENOENT')return null;throw error('CONTINUATION_PROGRESS_INVALID','Continuation progress is unreadable; original context retained.');}
    if(!object(record))throw error('CONTINUATION_PROGRESS_INVALID','Continuation progress must be an object; original context retained.');
    const {kind,version,sessionId,key,revision,data,checksum}=record;
    if(kind!=='compaction-weave/continuation-progress'||version!==1||sessionId!==this.sessionId||key!==this.key||!Number.isSafeInteger(revision)||revision<1||!object(data)||checksum!==digest(JSON.stringify({sessionId,key,revision,data})))throw error('CONTINUATION_PROGRESS_INVALID','Continuation progress identity or checksum mismatch; original context retained.');
    return record;
  }
  write(data,expectedRevision){
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=Number.MAX_SAFE_INTEGER)throw error('CONTINUATION_PROGRESS_INVALID','Invalid continuation progress revision; prior progress retained.');
    const folder=join(this.file,'..');mkdirSync(folder,{recursive:true});
    const lock=this.file+'.lock',temp=this.file+'.'+randomUUID()+'.tmp';let lockFd,fd;
    try{
      try{lockFd=openSync(lock,'wx',0o600);}catch(e){if(e.code!=='EEXIST')throw e;throw error('CONTINUATION_PROGRESS_LOCKED','Continuation progress is locked; no summary request is sent.');}
      const current=this.read();if((current?.revision??0)!==expectedRevision)throw error('CONTINUATION_PROGRESS_CHANGED','Continuation progress changed concurrently; do not overwrite another attempt.');
      // Freeze one JSON snapshot before hashing or writing it. A getter/toJSON
      // must not produce different bytes for the checksum and the durable record.
      let snapshot;
      try{snapshot=JSON.parse(JSON.stringify(data));}catch{throw error('CONTINUATION_PROGRESS_INVALID','Continuation progress is not serializable; prior progress retained.');}
      if(!object(snapshot))throw error('CONTINUATION_PROGRESS_INVALID','Continuation progress must be an object; prior progress retained.');
      const revision=expectedRevision+1,payload={sessionId:this.sessionId,key:this.key,revision,data:snapshot};
      const record={kind:'compaction-weave/continuation-progress',version:1,...payload,checksum:digest(JSON.stringify(payload))};
      const serialized=JSON.stringify(record)+'\n';
      // Apply the reader's complete UTF-8 bound before replacing accepted work.
      // Never trim the notes or usage ledger to force an oversized record to fit.
      if(Buffer.byteLength(serialized,'utf8')>MAX_PROGRESS_BYTES)throw error('CONTINUATION_PROGRESS_INVALID','Continuation progress exceeds its storage bound; prior progress retained.');
      fd=openSync(temp,'wx',0o600);writeFileSync(fd,serialized);fsyncSync(fd);closeSync(fd);fd=undefined;atomicReplaceSync(temp,this.file);return record;
    }finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch{}if(lockFd!==undefined){closeSync(lockFd);unlinkSync(lock);}}
  }
}
