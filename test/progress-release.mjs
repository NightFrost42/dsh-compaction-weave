import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {extractProgressFacts,validateProgressFacts} from '../lib/progress-facts.js';
const corpus=JSON.parse(readFileSync(new URL('./fixtures/progress-release-candidates.json',import.meta.url),'utf8'));
const selection={effective:extractProgressFacts(corpus.source,{seq:corpus.seq})};
const results=corpus.cases.map(({name,text,expectedValid})=>{
  try {
    const verdict=validateProgressFacts(text,selection);
    assert.equal(verdict.ok,expectedValid,JSON.stringify(verdict));
    return {name,pass:true};
  }catch(error){return {name,pass:false,error:error.message};}
});
for (const row of JSON.parse(readFileSync(new URL('./fixtures/progress-retest-summaries.json',import.meta.url),'utf8'))) {
  try {
    const verdict=validateProgressFacts(row.candidate,{effective:extractProgressFacts(row.source,{seq:row.seq})});
    assert.equal(verdict.ok,row.expectedValid,JSON.stringify(verdict));
    results.push({name:'replay-'+row.name,pass:true});
  }catch(error){results.push({name:'replay-'+row.name,pass:false,error:error.message});}
}
console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));
if(results.some(r=>!r.pass))process.exitCode=1;
