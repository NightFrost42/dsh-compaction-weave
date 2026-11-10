import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';
const base=resolve(process.env.PLUGIN_UNDER_TEST??fileURLToPath(new URL('..',import.meta.url)));
const {auditCompaction}=await import(pathToFileURL(join(base,'lib/audit.js')));
const cases=[];
for(const source of ['如果报告提到它，不要写库。','如果报告里提到它，不要顺手写库。']) {
 for(const candidate of ['如果报告提到它，不要写库','报告若提到它也不要写库','当报告提到它时，不要写库','如果报告提及它，不要写库','若报告提到它，不要写库','报告提到它时不要写库','当报告提到它时不要写库','如果报告提到它就不要写库','不要写库，如果报告提到它']) cases.push(['alias',source,candidate,null]);
 for(const candidate of ['不要写库','不要顺手写库','如果报告没提到它，不要写库','如果日志提到它，不要写库','如果报告提到他，不要写库','如果它提到报告，不要写库','只有报告提到它时，不要写库','除非报告提到它，不要写库'])cases.push(['changed-condition',source,candidate,'condition']);
 cases.push(['reversed-action',source,'报告提到它就顺手写库','polarity']);
}
cases.push(
 ['consent-does-not-excuse-changed-trigger','等用户拍板。如果报告里提到它，不要顺手写库。','如果报告没提到它，不要顺手写库（用户未拍板）。','condition'],
 ['and-or','如果测试通过且用户批准，不要发布。','当测试通过或用户批准时，不要发布。','condition'],
 ['drop-conjunct','如果测试通过且用户批准，不要发布。','当测试通过时，不要发布。','condition'],
 ['changed-number','如果错误达到3次，不要发布。','当错误达到4次时，不要发布。','condition'],
 ['changed-direction','如果A批准B，不要发布。','当B批准A时，不要发布。','condition'],
 ['negative-condition-kept','如果报告没提到它，不要写库。','当报告没提到它时，不要写库。',null],
 ['negative-condition-changed','如果报告没提到它，不要写库。','当报告提到它时，不要写库。','condition'],
 ['negative-condition-action-flip','如果报告未批准，不要写库。','当报告未批准时，必须写库。','polarity'],
 ['en-when','If tests pass, do not deploy release.','When tests pass, do not deploy release.',null],
 ['en-postfix','Do not deploy release if tests pass.','When tests pass, do not deploy release.',null],
 ['en-unless-changed','Unless tests pass, do not deploy release.','If tests pass, do not deploy release.','condition'],
 ['en-only-changed','Only deploy release if tests pass.','Deploy release if tests pass.','condition'],
 ['en-only-kept','Only deploy release if tests pass.','Deploy release only if tests pass.',null],
 ['en-negation-changed','If tests do not pass, do not deploy release.','If tests pass, do not deploy release.','condition'],
 ['literal-not-synonym','如果标识为 `提及`，不要写库。','如果标识为 `提到`，不要写库。','condition'],
 ['different-rule-scope','如果报告提到A，不要写库。如果报告提到B，不要删库。','当报告提到B时，不要删库。当报告提及A时，不要写库。',null],
 ['correct-copy-cannot-excuse','如果报告提到它，不要写库。','如果报告提到它，不要写库。不要写库。','condition']
);
const results=[];
for(const [index,[id,source,candidate,reason]] of cases.entries())for(const preserved of [true,false]){
 try{
  const a=auditCompaction({userMessages:[{seq:1,text:source}],summaryText:candidate,...(preserved?{checkpointText:source+'\n'+candidate}:{})});
  if(reason)assert.ok(a.lost.some(x=>x.reason===reason),JSON.stringify(a));else assert.equal(a.lost.length,0,JSON.stringify(a));
  results.push({id:id+'-'+index,preserved,pass:true,reasons:a.lost.map(x=>x.reason)});
 }catch(e){results.push({id:id+'-'+index,preserved,pass:false,source,candidate,want:reason,error:e.message});}
}
const report={passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,results};console.log(JSON.stringify(report,null,2));if(report.failed)process.exitCode=1;
