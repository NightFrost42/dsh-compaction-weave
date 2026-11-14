import fs from 'node:fs';
import assert from 'node:assert/strict';
import {extractProgressFacts,validateProgressFacts} from '../lib/progress-facts.js';
const fixtures=JSON.parse(fs.readFileSync(new URL('./fixtures/cost-audit-rejections.json',import.meta.url),'utf8'));
const results=[];
for(const fixture of fixtures){
  try{
    const effective=fixture.sourceLines.flatMap(([seq,line])=>extractProgressFacts(line,{seq}));
    assert.equal(validateProgressFacts(fixture.text,{effective}).ok,true);
    const realConflict=fixture.text+'\n当前 checkedFileCount=142，reportGenerated=true。';
    assert.equal(validateProgressFacts(realConflict,{effective}).ok,false);
    results.push({name:fixture.name,pass:true});
  }catch(error){results.push({name:fixture.name,pass:false,error:error.stack});}
}
console.log(JSON.stringify({passed:results.filter(row=>row.pass).length,failed:results.filter(row=>!row.pass).length,results},null,2));
if(results.some(row=>!row.pass))process.exitCode=1;
