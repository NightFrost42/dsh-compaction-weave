import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {extractProgressFacts} from '../lib/progress-facts.js';
// Snapshots captured from review.35 source extraction. Candidate interpretation
// may improve without invalidating the IDs in existing persisted checkpoints.
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/progress-source-identities.json',import.meta.url),'utf8'));
const results=fixtures.map(({text,options,facts},index)=>{
  try {assert.deepEqual(extractProgressFacts(text,options),facts);return {name:'source-identity-'+index,pass:true};}
  catch(error){return {name:'source-identity-'+index,pass:false,error:error.message};}
});
console.log(JSON.stringify({passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,results},null,2));
if(results.some(x=>!x.pass))process.exitCode=1;
