import fs from 'node:fs';
import assert from 'node:assert/strict';
import {auditCompaction} from '../lib/audit.js';
import {extractProgressFacts,validateProgressFacts} from '../lib/progress-facts.js';
import {reconstructDisputedLines} from '../lib/reconstruct.js';

const results=[];
const test=(name,run)=>{
  try{run();results.push({name,pass:true});}
  catch(error){results.push({name,pass:false,error:error.stack});}
};
const selection={effective:extractProgressFacts('最新进度：本批114个文件已完成扫描和格式检查。报告已生成，图表尚未生成。下一步生成图表。',{seq:44})};
const captured=JSON.parse(fs.readFileSync(new URL('./fixtures/residual-audit-summaries.json',import.meta.url),'utf8'));
for(const fixture of captured){
  const effective=fixture.progressSourceLines.flatMap(([seq,line])=>extractProgressFacts(line,{seq}));
  const checkpointText=fixture.userMessages.map(message=>message.text).join('\n')+'\n'+fixture.text;
  test('captured-complete-summary-'+fixture.name,()=>{
    assert.equal(validateProgressFacts(fixture.text,{effective}).ok,true);
    const audit=auditCompaction({userMessages:fixture.userMessages,summaryText:fixture.text,checkpointText,includeAllConflicts:true});
    if(fixture.allowRequirementReconstruction&&audit.lost.length){
      const rebuilt=reconstructDisputedLines({text:fixture.text,userMessages:fixture.userMessages,audit,language:'zh',format:'continuation'});
      assert.ok(rebuilt);
      assert.equal(validateProgressFacts(rebuilt.text,{effective}).ok,true);
      assert.equal(auditCompaction({userMessages:fixture.userMessages,summaryText:rebuilt.text,checkpointText:checkpointText+'\n'+rebuilt.text,includeAllConflicts:true}).lost.length,0);
    }else assert.equal(audit.lost.length,0);
  });
  test('captured-summary-cannot-hide-new-progress-'+fixture.name,()=>{
    assert.equal(validateProgressFacts(fixture.text+'\n当前 chartGenerated=true。',{effective}).ok,false);
  });
  test('captured-summary-cannot-hide-new-action-'+fixture.name,()=>{
    const summaryText=fixture.text+'\n不会覆盖已有文件但现在删除已有文件。';
    const audit=auditCompaction({userMessages:fixture.userMessages,summaryText,checkpointText:checkpointText+'\n'+summaryText,includeAllConflicts:true});
    assert.ok(audit.lost.some(row=>row.reason==='polarity'&&row.line.includes('删除')),JSON.stringify(audit));
  });
}

for(const text of [
  '此进度替代早期快照（seq 29/31 报告 batch=2 107 个、reportGenerated=false、nextAction=generate-report）。',
  '此进度替代早期快照（seq29/31 报告未生成；seq30 下一步生成报告）。',
  '此进度取代早期快照（seq29 报告未生成、nextAction=generate-report）。',
  '较早进度记录（seq29 报告未生成；seq31 下一步生成报告）已被seq44的最新进度替代。',
  '此进度替代早期快照（seq29 报告未生成）。当前报告已生成，图表尚未生成。',
  '早期JSON快照 seq29/31 记录 checkedFileCount=107，已被 seq44 的114取代。',
  '更早的 JSON 快照 seq29/31 记录 checkedFileCount=107 已被取代。',
  '早期快照 seq29/31（JSON响应）记录 checkedFileCount=107，该值已被后续最新进度取代。',
])test('historical-replacement-is-not-current-'+text,()=>assert.equal(validateProgressFacts(text,selection).ok,true));
for(const text of [
  '此进度替代早期快照（seq29 当前 reportGenerated=false）。',
  '此进度替代早期快照（seq29 报告未生成）。但现在 reportGenerated=false。',
  '此进度不会替代早期快照（seq29 报告未生成），当前报告未生成。',
  '此进度未替代早期快照（seq29 reportGenerated=false）。',
  '此进度没有替代早期快照（seq29 reportGenerated=false）。',
  '此进度尚未替代早期快照（seq29 reportGenerated=false）。',
  '此进度不再替代早期快照（seq29 reportGenerated=false）。',
  '此进度不要替代早期快照（seq29 reportGenerated=false）。',
  '较早进度记录（seq29 reportGenerated=false）尚未被seq44的最新进度替代，当前 reportGenerated=false。',
  '替代早期快照（报告未生成），当前 nextAction=generate-report。',
  '下一步生成图表。当前报告是否已生成未知。',
  '此进度替代早期快照（seq29 reportGenerated=false）。seq44（reportGenerated=false）。',
  '此进度替代早期快照（seq29 reportGenerated=false）；seq44（reportGenerated=false）。',
  '此进度替代早期快照（seq29 reportGenerated=false）。另一个问题 seq44（reportGenerated=false）。',
  '已经替代早期快照（seq29 reportGenerated=false），图表（seq44 chartGenerated=true）。',
  '替代一个模块。报告 seq44（reportGenerated=false）。',
  '早期快照 seq29 reportGenerated=false 已被后续最新进度取代，但当前 reportGenerated=false。',
  '早期JSON快照 seq29 checkedFileCount=107，当前 checkedFileCount=107。',
])test('replacement-does-not-excuse-conflict-'+text,()=>assert.equal(validateProgressFacts(text,selection).ok,false));

const prohibitions='不得修改生产环境。不得删除已有文件。';
const audit=(summaryText,source=prohibitions)=>auditCompaction({userMessages:[{seq:5,text:source}],summaryText,checkpointText:source+'\n'+summaryText,includeAllConflicts:true});
for(const text of [
  '生成内容及不会覆盖或删除已有文件的安全输出路径。',
  '确认不会覆盖、删除已有文件及修改生产环境的输出路径。',
  '不得覆盖、删除已有文件或修改生产环境。',
  '不会覆盖，或删除已有文件及修改生产环境。',
  '不会删除已有文件但也不会修改生产环境。',
  '不会删除已有文件随后不修改生产环境。',
])test('coordinated-prohibition-keeps-negative-scope-'+text,()=>assert.equal(audit(text).lost.length,0));
for(const text of [
  '不会删除已有文件但现在修改生产环境。',
  '不会删除已有文件随后修改生产环境。',
  '不会覆盖、删除已有文件然后直接修改生产环境。',
  '确认不会覆盖、删除已有文件的输出路径但现在修改生产环境。',
  '不会覆盖、删除已有文件，修改生产环境。',
  '不会覆盖已有文件，删除已有文件。',
  '不会覆盖已有文件而是删除已有文件。',
  '不得不覆盖、删除已有文件。',
  '不会删除已有文件，可是修改生产环境。',
  '不会覆盖、删除已有文件及需要修改生产环境。',
  '不会覆盖、删除已有文件及现在修改生产环境。',
  '不会覆盖、删除已有文件及不能不修改生产环境。',
  '不会覆盖、删除已有文件、必须修改生产环境。',
  '不会删除已有文件或允许修改生产环境。',
  '不会覆盖、删除已有文件并且我现在修改生产环境。',
  '不会覆盖、删除已有文件及助手修改生产环境。',
  '不会覆盖、删除已有文件且现在修改生产环境。',
  '不得删除已有文件以及仍然需要修改生产环境。',
  '不授权删除已有文件然后修改生产环境。',
  '不授权删除已有文件但现在修改生产环境。',
])test('fresh-action-does-not-borrow-negation-'+text,()=>assert.ok(audit(text).lost.some(row=>row.reason==='polarity'),JSON.stringify(audit(text))));
test('source-coordinated-negation-is-symmetric',()=>assert.equal(audit('不得删除已有文件。不得修改生产环境。','不得覆盖、删除已有文件及修改生产环境。').lost.length,0));
// A literal inside an explicit condition retains its identity and scope.
// This does not grant every arbitrary inline action quote diagnostic ownership.
test('literal-contrast-keeps-condition-scope',()=>assert.equal(audit('如果标识为 `随后删除已有文件`，不要修改生产环境。','如果标识为 `随后删除已有文件`，不要修改生产环境。').lost.length,0));
test('literal-contrast-mutation-still-conflicts',()=>assert.ok(audit('如果标识为 `随后修改生产环境`，不要修改生产环境。','如果标识为 `随后删除已有文件`，不要修改生产环境。').lost.some(row=>row.reason==='condition')));
test('conditional-coordinated-negation-keeps-trigger',()=>assert.equal(audit('当测试通过时，不得删除已有文件及修改生产环境。','如果测试通过，不得删除已有文件及修改生产环境。').lost.length,0));
test('conditional-fresh-positive-action-still-conflicts',()=>assert.ok(audit('如果测试通过，不会删除已有文件然后修改生产环境。').lost.some(row=>row.reason==='polarity')));
test('conditional-second-action-keeps-trigger',()=>assert.equal(audit('如果用户批准，必须删除测试文件然后修改测试环境。','如果用户批准，必须删除测试文件然后修改测试环境。').lost.length,0));
test('conditional-second-action-cannot-drop-trigger',()=>assert.ok(audit('如果用户批准，必须删除测试文件。然后修改测试环境。','如果用户批准，必须删除测试文件然后修改测试环境。').lost.some(row=>row.reason==='condition')));
test('conditional-second-action-cannot-change-trigger',()=>assert.ok(audit('如果用户批准，必须删除测试文件。如果测试通过，然后修改测试环境。','如果用户批准，必须删除测试文件然后修改测试环境。').lost.some(row=>row.reason==='condition')));

console.log(JSON.stringify({passed:results.filter(row=>row.pass).length,failed:results.filter(row=>!row.pass).length,results},null,2));
if(results.some(row=>!row.pass))process.exitCode=1;
