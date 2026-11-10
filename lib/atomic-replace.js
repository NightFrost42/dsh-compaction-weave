// Windows readers can briefly hold a file without delete sharing. Retry the
// atomic rename only; never unlink a valid destination to make replacement work.
import {renameSync} from 'node:fs';
import {rename} from 'node:fs/promises';
const delays=[10,20,40,80];
const retryable=(error,platform)=>platform==='win32'&&['EPERM','EACCES','EBUSY'].includes(error?.code);
export function atomicReplaceSync(source,target,{replace=renameSync,platform=process.platform,wait=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)}={}){
  for(let attempt=0;;attempt++){
    try{return replace(source,target);}
    catch(error){if(!retryable(error,platform)||attempt>=delays.length)throw error;wait(delays[attempt]);}
  }
}
export async function atomicReplace(source,target,{replace=rename,platform=process.platform,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  for(let attempt=0;;attempt++){
    try{return await replace(source,target);}
    catch(error){if(!retryable(error,platform)||attempt>=delays.length)throw error;await wait(delays[attempt]);}
  }
}
