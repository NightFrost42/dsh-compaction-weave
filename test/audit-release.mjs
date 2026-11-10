import assert from 'node:assert/strict';
import {auditCompaction} from '../lib/audit.js';
const results=[];
for(const source of ['禁止修改生产环境。','不要删除已有文件。']) {
  const action=source.includes('生产')?'修改生产环境':'删除已有文件';
  for(const [candidate,valid] of [
    [`当前约束保持为：不允许${action}。`,true],
    [`不实际${action}。`,true],
    [`允许${action}。`,false],
    [`必须${action}。`,false],
    [`不允许${action}，但现在允许${action}。`,false],
    [`不允许${action}。必须${action}。`,false],
  ]) {
    try {
      const audit=auditCompaction({userMessages:[{seq:1,text:source}],summaryText:candidate,checkpointText:source+'\n'+candidate});
      assert.equal(audit.lost.length===0,valid,JSON.stringify(audit));
      results.push({name:source+' -> '+candidate,pass:true});
    }catch(error){results.push({name:source+' -> '+candidate,pass:false,error:error.message});}
  }
}
console.log(JSON.stringify({passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results},null,2));
if(results.some(r=>!r.pass))process.exitCode=1;
