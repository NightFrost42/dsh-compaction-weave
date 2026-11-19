import fs from 'node:fs';import assert from 'node:assert/strict';import {resolve,join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const base=resolve(process.env.PLUGIN_UNDER_TEST??fileURLToPath(new URL('..',import.meta.url)));
const {auditCompaction}=await import(pathToFileURL(join(base,'lib/audit.js')));
const results=[];
function check(id,source,summary,reason=null){const a=auditCompaction({userMessages:[{seq:1,text:source}],summaryText:summary,checkpointText:source});try{if(reason)assert.ok(a.lost.some(x=>x.reason===reason),JSON.stringify(a));else assert.equal(a.lost.length,0,JSON.stringify(a));results.push({id,pass:true,checked:a.checked,lost:a.lost.length,polarityFlips:a.polarityFlips});}catch(e){results.push({id,pass:false,error:e.message});}}
const minimal=['不要跳过。 两次（a）','不要跳过。 (a) (b)','Never restart services. Use port 8080.','不要删除生产数据。 端口 8080。','不要删除生产数据。See the note.'];
minimal.forEach((text,i)=>{check('A'+(i+1)+'_identity',text,text);check('A'+(i+1)+'_real_flip',text,text.replace('不要','').replace('Never restart','Restart'),'polarity');check('A'+(i+1)+'_correct_quote_cannot_cancel_flip',text,text+'\n'+text.replace('不要','').replace('Never restart','Restart'),'polarity');});
for(const [id,text] of [
 ['decimal','Always retain backups for 2.5 days. Use port 8080.'],
 ['semicolon','Never restart services; Use port 8080; Always retain backups for 30 days.'],
 ['two_objects','Do not delete production data. Delete staging data.'],
 ['two_retentions','Always retain archive A for 30 days. Always retain archive B for 7 days.'],
 ['condition','Only deploy release if tests pass. Use port 8080.'],
 ['exception','Never delete backups except temporary backups. Keep 30 days of logs.'],
 ['direction','You must copy staging to production. You must copy archive to mirror.'],
 ['paths','Output report: D:/alpha/review/30/result.md\nOutput evidence: D:/alpha/review/7/result.md'],
 ['short','Must X. Never Y.'],
 ['cn_condition','如果测试通过，才发布版本。端口 8080。'],
 ['cn_exception','不要删除备份，除了临时备份。保留30天的日志。'],
 ['explicit_conflicting_source','Do not delete production data. Delete production data.'],
]) check('A_identity_'+id,text,text);
for(const [id,source,bad,reason] of [
 ['port','Never restart services. Use port 8080.','Never restart services. Use port 9090.','value'],
 ['number','Always retain archive A for 30 days. Always retain archive B for 7 days.','Always retain archive A for 3 days. Always retain archive B for 7 days.','value'],
 ['unit','Never restart services. Always retain backups for 30 days.','Never restart services. Always retain backups for 30 hours.','unit'],
 ['condition','Only deploy release if tests pass. Use port 8080.','Deploy release. Use port 8080.','condition'],
 ['cn_condition','如果测试通过，才发布版本。端口 8080。','发布版本。端口 8080。','condition'],
 ['exception','Never delete backups except temporary backups. Keep 30 days of logs.','Never delete backups except production backups. Keep 30 days of logs.','exception'],
 ['direction','You must copy staging to production. You must copy archive to mirror.','You must copy production to staging. You must copy archive to mirror.','relation'],
 ['shared_object','Do not delete production data. Delete staging data.','Delete production data. Delete staging data.','polarity'],
 ['short_x','Must X. Never Y.','Must not X. Never Y.','polarity'],
 ['short_y','Must X. Never Y.','Must X. Y.','polarity'],
 ['range','Always retain at least 3 backups. Use port 8080.','Always retain at most 3 backups. Use port 8080.','range'],
]) check('A_mutation_'+id,source,bad,reason);
const corpus=JSON.parse(fs.readFileSync(new URL('./audit-corpus.json',import.meta.url)));
for(const c of corpus){check('A_legacy_good_'+c.id,c.source,c.good);check('A_legacy_bad_'+c.id,c.source,c.bad,c.reason);check('A_legacy_both_'+c.id,c.source,c.good+'\n'+c.bad,c.reason);}
const summary={passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,results};if(process.env.AUDIT_REPORT_PATH)fs.writeFileSync(process.env.AUDIT_REPORT_PATH,JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));if(summary.failed)process.exitCode=1;
