import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {tmpdir} from 'node:os';import {join} from 'node:path';import {SessionStateStore} from '../lib/state.js';import assert from 'node:assert/strict';import {atomicReplace,atomicReplaceSync} from '../lib/atomic-replace.js';
const rows=[];async function test(name,fn){try{await fn();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.message});}}
for(const asyncMode of [false,true])for(const code of ['EPERM','EACCES','EBUSY'])await test((asyncMode?'async':'sync')+'-retries-'+code+'-without-deleting-target',async()=>{
 let calls=0;const waits=[],error=Object.assign(new Error(code),{code}),options={platform:'win32',wait:n=>waits.push(n),replace:(from,to)=>{assert.equal(from,'staged');assert.equal(to,'live');if(++calls<3)throw error;return 'renamed';}};
 const r=await (asyncMode?atomicReplace:atomicReplaceSync)('staged','live',options);assert.equal(r,'renamed');assert.equal(calls,3);assert.deepEqual(waits,[10,20]);
});
for(const code of ['ENOSPC','ENOENT','EIO','EEXIST','STATE_LOCKED'])await test('real-error-'+code+'-not-retried',()=>{
 let calls=0;const error=Object.assign(new Error(code),{code});assert.throws(()=>atomicReplaceSync('a','b',{platform:'win32',replace:()=>{calls++;throw error;},wait:()=>assert.fail()}),e=>e===error);assert.equal(calls,1);
});
await test('persistent-permission-error-is-bounded-and-preserves-original-error',async()=>{
 const error=Object.assign(new Error('permanent'),{code:'EPERM'}),waits=[];let calls=0;await assert.rejects(atomicReplace('a','b',{platform:'win32',replace:async()=>{calls++;throw error;},wait:n=>waits.push(n)}),e=>e===error);assert.equal(calls,5);assert.equal(waits.reduce((a,b)=>a+b),150);
});
await test('non-windows-permission-error-is-not-masked',()=>{
 const error=Object.assign(new Error('denied'),{code:'EACCES'});assert.throws(()=>atomicReplaceSync('a','b',{platform:'linux',replace:()=>{throw error;},wait:()=>assert.fail()}),e=>e===error);
});
await test('real-state-update-retries-transient-sharing-error-without-losing-old-data',()=>{
 const store=new SessionStateStore(fs.mkdtempSync(join(tmpdir(),'weave-atomic-')));store.update('a',s=>({...s,marker:'before'}));
 const rename=fs.renameSync;let blocked=0;fs.renameSync=(from,to)=>{if(to===store.file('a')&&blocked++<2)throw Object.assign(new Error('sharing violation'),{code:'EPERM'});return rename(from,to);};syncBuiltinESMExports();
 try{store.update('a',s=>({...s,marker:'after'}));assert.equal(store.read('a').marker,'after');assert.equal(blocked,3);assert.ok(!fs.existsSync(store.file('a')+'.lock'));}finally{fs.renameSync=rename;syncBuiltinESMExports();}
});
await test('real-state-permanent-failure-keeps-prior-record-and-releases-own-lock',()=>{
 const store=new SessionStateStore(fs.mkdtempSync(join(tmpdir(),'weave-atomic-')));store.update('a',s=>({...s,marker:'before'}));const before=fs.readFileSync(store.file('a'));
 const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(to===store.file('a'))throw Object.assign(new Error('full disk'),{code:'ENOSPC'});return rename(from,to);};syncBuiltinESMExports();
 try{assert.throws(()=>store.update('a',s=>({...s,marker:'after'})),e=>e.code==='ENOSPC');assert.deepEqual(fs.readFileSync(store.file('a')),before);assert.ok(!fs.existsSync(store.file('a')+'.lock'));}finally{fs.renameSync=rename;syncBuiltinESMExports();}
});
console.log(JSON.stringify({passed:rows.filter(x=>x.pass).length,failed:rows.filter(x=>!x.pass).length,results:rows},null,2));if(rows.some(x=>!x.pass))process.exitCode=1;
