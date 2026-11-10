import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {ContinuationProgressStore} from '../lib/continuation-progress.js';
const rows=[];
async function test(name,fn){try{await fn();rows.push({name,pass:true});}catch(e){rows.push({name,pass:false,error:e.message,stack:e.stack});}}
const hash=x=>createHash('sha256').update(x).digest('hex');
const fixture=()=>new ContinuationProgressStore(fs.mkdtempSync(join(tmpdir(),'weave-progress-store-')),'session','a'.repeat(64));
const seed=store=>{store.write({next:2,memory:'accepted notes',calls:[{usage:null}]},0);return fs.readFileSync(store.file);};
const onlyRecord=store=>assert.deepEqual(fs.readdirSync(dirname(store.file)),['a'.repeat(64)+'.json']);
await test('oversized-utf8-write-retains-last-readable-progress',()=>{
 const store=fixture(),before=seed(store);
 assert.throws(()=>store.write({next:3,memory:'中'.repeat(1500000)},1),e=>e.code==='CONTINUATION_PROGRESS_INVALID');
 assert.deepEqual(fs.readFileSync(store.file),before);assert.equal(store.read().data.next,2);onlyRecord(store);
});
await test('exact-byte-bound-roundtrips-and-one-more-byte-is-rejected',()=>{
 const store=fixture();const make=(revision,memory)=>{const data={memory},payload={sessionId:store.sessionId,key:store.key,revision,data};return JSON.stringify({kind:'compaction-weave/continuation-progress',version:1,...payload,checksum:hash(JSON.stringify(payload))})+'\n';};
 const remaining=4194304-Buffer.byteLength(make(1,'')),memory='中'.repeat(Math.floor(remaining/3))+'x'.repeat(remaining%3);
 store.write({memory},0);assert.equal(fs.statSync(store.file).size,4194304);assert.equal(store.read().data.memory,memory);
 const before=fs.readFileSync(store.file);assert.throws(()=>store.write({memory:memory+'x'},1),e=>e.code==='CONTINUATION_PROGRESS_INVALID');assert.deepEqual(fs.readFileSync(store.file),before);onlyRecord(store);
});
await test('snapshot-is-serialized-once-and-detached-from-caller',()=>{
 const store=fixture();let reads=0;const input={get next(){return ++reads;},nested:{memory:'accepted'}};
 const record=store.write(input,0);assert.equal(reads,1);input.nested.memory='changed';assert.deepEqual(store.read(),record);assert.equal(record.data.nested.memory,'accepted');
});
for(const [name,value] of [['null',null],['array',[]],['string','oops'],['undefined',undefined],['bigint',{n:1n}],['cycle',(()=>{const a={};a.self=a;return a;})()]])await test('invalid-'+name+'-cannot-replace-progress',()=>{
 const store=fixture(),before=seed(store);assert.throws(()=>store.write(value,1),e=>e.code==='CONTINUATION_PROGRESS_INVALID');assert.deepEqual(fs.readFileSync(store.file),before);onlyRecord(store);
});
await test('revision-overflow-cannot-poison-the-last-record',()=>{
 const store=fixture();seed(store);const data={next:2},revision=Number.MAX_SAFE_INTEGER,body={sessionId:store.sessionId,key:store.key,revision,data};
 fs.writeFileSync(store.file,JSON.stringify({kind:'compaction-weave/continuation-progress',version:1,...body,checksum:hash(JSON.stringify(body))}));const before=fs.readFileSync(store.file);assert.equal(store.read().revision,revision);
 assert.throws(()=>store.write(data,revision),e=>e.code==='CONTINUATION_PROGRESS_INVALID');assert.deepEqual(fs.readFileSync(store.file),before);
});
for(const text of ['null','[]','{"kind":"bad"}','not json'])await test('unreadable-record-uses-stable-error-'+text,()=>{
 const store=fixture();seed(store);fs.writeFileSync(store.file,text);assert.throws(()=>store.read(),e=>e.code==='CONTINUATION_PROGRESS_INVALID');
});
await test('foreign-lock-is-not-stolen-or-deleted',()=>{
 const store=fixture(),before=seed(store);fs.writeFileSync(store.file+'.lock','another writer');
 assert.throws(()=>store.write({next:3},1),e=>e.code==='CONTINUATION_PROGRESS_LOCKED');assert.equal(fs.readFileSync(store.file+'.lock','utf8'),'another writer');assert.deepEqual(fs.readFileSync(store.file),before);
});
await test('stale-revision-cannot-overwrite-newer-accepted-pages',()=>{
 const store=fixture();seed(store);store.write({next:3},1);const before=fs.readFileSync(store.file);assert.throws(()=>store.write({next:2},1),e=>e.code==='CONTINUATION_PROGRESS_CHANGED');assert.deepEqual(fs.readFileSync(store.file),before);onlyRecord(store);
});
await test('disk-full-during-replacement-retains-the-readable-record',()=>{
 const store=fixture(),before=seed(store),rename=fs.renameSync;
 fs.renameSync=(from,to)=>{if(to===store.file)throw Object.assign(new Error('synthetic disk full'),{code:'ENOSPC'});return rename(from,to);};syncBuiltinESMExports();
 try{assert.throws(()=>store.write({next:3},1),e=>e.code==='ENOSPC');assert.deepEqual(fs.readFileSync(store.file),before);assert.equal(store.read().data.next,2);onlyRecord(store);}finally{fs.renameSync=rename;syncBuiltinESMExports();}
});
console.log(JSON.stringify({passed:rows.filter(x=>x.pass).length,failed:rows.filter(x=>!x.pass).length,results:rows},null,2));if(rows.some(x=>!x.pass))process.exitCode=1;
