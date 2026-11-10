import assert from 'node:assert/strict';
import {auditCompaction} from '../lib/audit.js';
const rows=[];
const check=(id,source,candidate,reject=false,reason)=>{
 try{const messages=Array.isArray(source)?source.map((text,i)=>({seq:i+1,text})):[{seq:1,text:source}];const a=auditCompaction({userMessages:messages,summaryText:candidate,checkpointText:messages.map(m=>m.text).join('\n')});assert.equal(a.lost.length>0,reject);if(reason)assert.ok(a.lost.some(x=>x.reason===reason));rows.push({id,pass:true});}catch(e){rows.push({id,pass:false,error:e.message});}
};
const hash='a'.repeat(64);
for(const [id,candidate]of [
 ['fingerprint','`lib/transaction-host.js`：3 个 session 指纹 `append '+hash+'`'],
 ['fingerprint-separated','session 指纹：`append` `'+hash+'`'],
 ['fingerprint-short','session 指纹：append `abcdef12…`'],
 ['fingerprint-redacted','session 指纹：`append [redacted-blob]`'],
 ['fingerprint-redacted-split','session 方法：`append` `[redacted-blob]`']
])check(id,'禁止 append',candidate);
for(const [id,candidate]of [
 ['positive-bare','append'],['positive-code','执行 `append`'],['positive-digest','执行 `append '+hash+'`'],
 ['positive-with-data','session 指纹：`append '+hash+'`；执行 append'],
 ['positive-with-copy','禁止 append。append'],['positive-with-quoted-copy','禁止 append。必须执行 append']
])check(id,'禁止 append',candidate,true,'polarity');
check('snapshot-current-is-not-condition','当前会话的 state 是 `failures=0, stopped=false`，日志里没有任何 `compaction/*` 事件','状态已更新：`failures=4, stopped=true`');
check('then-is-not-condition','当时的 state 是 `failures=0, stopped=false`','状态已更新：`failures=4, stopped=true`');
check('historical-snapshots-not-global-requirements',['状态记录：session-alpha failures=0。','状态记录：session-beta failures=4。'],'状态记录：session-beta failures=4。');
check('snapshot-no-last-wins',['此前 state 是 `failures=0`。','后来 state 是 `failures=4`。'],'此前 state 是 `failures=0`；后来 state 是 `failures=4`。');
for(const separator of ['=',':',' ']){
 check('field-format-'+separator,'必须 lostcount=5','必须 lostcount'+separator+'5');
 check('field-mutated-'+separator,'必须 lostcount=5','必须 lostcount'+separator+'6',true,'value');
 check('field-list-good-'+separator,'Must A=30, B=7','Must A'+separator+'30, B'+separator+'7');
 check('field-list-bad-'+separator,'Must A=30, B=7','Must A'+separator+'30, B'+separator+'8',true,'value');
}
check('field-bare-data-not-invariant','历史记录。必须保留日志。快照 `lostcount=5`。','快照 `lostcount 0`。');
check('fixed-value-still-invariant','必须 failures=0','必须 failures=4',true,'value');
check('requirement-not-suppressed-by-observation',['必须 failures=0','当时 state 是 `failures=4`'],'必须 failures=4',true,'value');
check('required-same-session-not-borrow-other',['session-alpha 必须 port=80','session-beta 必须 port=81'],'session-alpha 必须 port=81',true,'value');
check('required-different-session',['session-alpha 必须 port=80','session-beta 必须 port=81'],'session-beta 必须 port=81');
check('missing-number-still-blocked','必须 lostcount=5','必须 lostcount',true,'value');
check('condition-missing','如果报告提到它，不要写库','不要写库',true,'condition');
check('condition-flipped','如果报告提到它，不要写库','报告提到它就写库',true,'polarity');
check('condition-alias','如果报告提到它，不要写库','报告若提到它也不要写库');
check('condition-when','如果报告提到它，不要写库','当报告提到它时，不要写库');
check('negative-observation','不要重启 DSH','没有重启 DSH');
check('positive-observation','不要重启 DSH','已经重启 DSH',true,'polarity');
check('no-termination','不要终止 DSH','不终止 DSH');
check('not-lower-threshold','不要降低 auditCoverageThreshold','未降低 auditCoverageThreshold');
check('wrong-reference-not-data','必须在 `engine.js:198` 建 state 目录','必须在 `engine.js:199` 建 state 目录',true,'reference');
check('digest-does-not-hide-units','Must retain 30 days','Must retain 30 hours; fingerprint `append '+hash+'`',true,'unit');

for(const [id,candidate]of [
 ['inline-call','`append(foo=1)`'],['inline-call-quoted','调用 `append(foo=1)`'],
 ['inline-mixed-code','`value=1; append(data)`'],['fingerprint-next','指纹已记录，下一步 `append`'],
 ['fingerprint-then','Fingerprint recorded, then `append`'],['fingerprint-mixed','session 指纹：`append '+hash+'`，执行 append'],
 ['fingerprint-direct-call','指纹记录，`append(data)`'],['scalar-plus-command','`failures=0`，执行 append']
])check(id,'禁止 append',candidate,true,'polarity');

check('when-precondition-not-current-observation','当前提满足时，不要发布','不要发布',true,'condition');
check('when-clock-not-past-observation','当时钟为三点时不要发布','不要发布',true,'condition');
check('when-precondition-alias','当前提满足时，不要发布','如果前提满足，不要发布');

check('prefixed-modal-field-list','session-alpha Must A=30, B=7','session-alpha Must A=30, B=8',true,'value');
check('mid-sentence-modal-field-list','配置必须 A=30, B=7','配置必须 A=30, B=8',true,'value');
check('snapshots-do-not-inherit-other-message-modal',['session-alpha Must A=30, B=7','session-beta state: A=40, B=7'],'session-beta state: A=40, B=8');
console.log(JSON.stringify({passed:rows.filter(x=>x.pass).length,failed:rows.filter(x=>!x.pass).length,results:rows},null,2));if(rows.some(x=>!x.pass))process.exitCode=1;
