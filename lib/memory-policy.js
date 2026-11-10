// A bounded verbatim tail over current, non-duplicated user requests. Full
// history stays in the archive. Removing a quote never suppresses the audit of
// a still-active requirement; only proven revisions/cancellations retire rules.
import {createHash} from 'node:crypto';
import {auditCompaction, sourceEvidenceSentences, sourceConstraintEvidence, scalarRequirement} from './audit.js';
import {isReferenceContextKind} from './source-provenance.js';
import {sourceLayout, restoreSourceLayout} from './source-refs.js';
const key = text => String(text).normalize('NFC').trim().replace(/\s+/g,' ');
const action = text => key(text).toLowerCase().replace(/[。.!！?？;；，,]+$/,'').replace(/^(?:(?:请|帮我|麻烦|必须|务必|现在)\s*|(?:please|must)\s+)+/,'').trim();
const conditional = text => /如果|除非|只有|仅当|(?:^|[，,])\s*(?:若|当)|\b(?:if|when|unless|only after)\b/i.test(text);
function cancellation(text) {
  const value=action(text);
  if (/^(?:算了|不用了|取消上一条|撤销上一条|never mind|cancel that)$/.test(value)) return {previous:true};
  if (/^(?:算了[，,]?\s*)?(?:(?:取消|撤销)(?:刚才|前面|上面|上一条|这个|那个)(?:的)?(?:请求|任务|操作)?|(?:这个|那个|刚才的)?(?:不用|不必)做了?)$/.test(value)) return {previous:true};
  const m=/^(?:取消|撤销|不用再|不必再|不要再|别再|cancel\s+)(.+?)(?:了)?$/i.exec(value)
    ?? /^(?:不用|不必|不要)(.+?)了$/.exec(value);
  return m ? {target:action(m[1]).replace(/的(?:任务|请求|操作)$/,'')} : null;
}
const fragmentHash = text => createHash('sha256').update(key(text)).digest('hex');
function revises(older,newer) {
  // Different prerequisites/environments are not a revision of the same rule.
  // Keep ambiguous conditions for the summary to explain rather than guess.
  if (conditional(older)||conditional(newer)) return false;
  const scopes=text=>[...text.matchAll(/\b(?:production|staging|development|test)\b|生产|测试|预发布/gi)].map(m=>m[0].toLowerCase());
  const a=scopes(older),b=scopes(newer);if(a.length&&b.length&&JSON.stringify(a)!==JSON.stringify(b))return false;
  // Digits inside object names, literal paths or quoted identifiers are scope,
  // not interchangeable parameter values (server1 vs server2, v1 vs v2).
  const identifiers=text=>[...text.matchAll(/`[^`]+`|(?:[a-z]:[/\\]|https?:\/\/)[^\s，。；]+|(?<![a-z0-9_.-])[a-z_][a-z0-9_.-]*\d[a-z0-9_.-]*|(?:服务器|文件|目录|模型|角色|项目|实例|设备|节点|任务|第)\s*\d+/gi)].map(m=>m[0]);
  if(JSON.stringify(identifiers(older))!==JSON.stringify(identifiers(newer)))return false;
  const oldScalar=scalarRequirement(older),newScalar=scalarRequirement(newer);
  if(oldScalar&&newScalar&&oldScalar.subject===newScalar.subject&&oldScalar.family===newScalar.family)
    return oldScalar.value!==newScalar.value||oldScalar.unit!==newScalar.unit;
  const shape=text=>action(text).replace(/\b(?:do not|don't|not|must|should|always|please)\b|不要|不得|不能|不必|必须|还是|改为|改成|设置为|设为|现在|可以/g,'').replace(/\d+(?:\.\d+)?/g,'#').replace(/\s+/g,' ').trim();
  const field=text=>/^[a-z]:[/\\]/i.test(text.trim())?null:/^\s*([\p{L}_][\p{L}\p{N}_ ./\-]{1,40})\s*[:=：]\s*(.+)$/u.exec(text);
  const fa=field(older),fb=field(newer);
  if(fa&&fb&&key(fa[1])===key(fb[1]))return key(fa[2])!==key(fb[2]);
  if(shape(older)!==shape(newer))return false;
  const report=auditCompaction({userMessages:[{seq:0,text:older}],summaryText:newer,checkpointText:older,threshold:.85});
  return report.lost.some(item=>['polarity','value','unit','range','relation','exception','reference'].includes(item.reason));
}
function fragments(message) {
  const blocks=message.blocks?.length?message.blocks:[{type:'text',text:message.text??''}];
  return blocks.flatMap((block,blockIndex)=>{
    const text=String(block.text??'');
    // Preserve code/literal blocks atomically, including indentation and fences.
    const parts=/```|~~~/.test(text)?[text]:sourceEvidenceSentences(text);
    let cursor=0;
    return parts.map(part=>{const start=text.indexOf(part,cursor);cursor=start+part.length;if(start<0)throw new Error('Memory fragment must be an exact source substring.');return {text:part,blockIndex,start,end:cursor,hash:fragmentHash(part),keep:true};});
  });
}
// Policy splitting is separate from the legacy source-fragment tokenizer.
// Existing fragment hashes keep their meaning; new partial quotes use verified
// source layouts. Only unambiguous independent actions can be retired alone.
function taskAction(text) {
  let value=action(text).replace(/^(?:并且|然后|并)\s*/,'');
  value=value.replace(/^(?:报告|图表|扫描|校验|测试|检查|打包)(?:完成|通过|成功)后\s*/,'');
  if(conditional(value)||/[`"'“”‘’「」『』，,；;]|否则|或者|要么|并且|然后|并|不要|不得|不能|禁止|不必|只在|仅在|才能/.test(value))return null;
  const m=/^(生成|上传|下载|导出|打包|发送|部署|删除|运行)([^。！？]*)$/.exec(value);
  return m?{verb:m[1],object:m[2].trim()}:null;
}
function policyParts(text) {
  // Long prose remains atomic; do not scan every conjunction against its prefix.
  if(text.length>2048)return [text];
  if(/```|~~~|[`"'“”‘’「」『』]|如果|除非|只有|仅当|否则|或者|要么|(?:^|[，,])\s*(?:若|当)/.test(text))return [text];
  const nudge=/^\s*(?:请继续|继续(?:吧|执行|处理|工作)?)[，,]\s*(?:但是|但)?\s*/.exec(text);
  if(nudge&&text.slice(nudge[0].length).trim())return [nudge[0],...policyParts(text.slice(nudge[0].length))];
  const comma=/[，,]\s*/.exec(text);
  if(comma){
    const end=comma.index+comma[0].length,left=text.slice(0,end),right=text.slice(end);
    // A trailing condition qualifies the cancellation; it is not a new task.
    if(cancellation(left)&&(/^(?:请|保留|生成|上传|导出|打包|不要|禁止)/.test(right)||/^(?:报告|图表|结果|文件)(?:仅|只)?在本地(?:交付|保存)/.test(right)))return [left,...policyParts(right)];
    return [text];
  }
  const conjunction=/并且|然后|并/.exec(text);
  if(conjunction){
    const left=text.slice(0,conjunction.index),right=text.slice(conjunction.index);
    if(taskAction(left)&&taskAction(right))return [left,right];
  }
  return [text];
}
function policyFragments(message) {
  return fragments(message).flatMap(parent=>{
    let offset=parent.start;
    return policyParts(parent.text).map(text=>{
      const part={...parent,text,start:offset,end:offset+text.length,hash:fragmentHash(text),parentHash:parent.hash};offset=part.end;
      // A continuation prefix was split only when followed by real content.
      part.emptyContinuation=/^\s*(?:请继续|继续(?:吧|执行|处理|工作)?)[，,]\s*(?:但是|但)?\s*$/.test(text);
      return part;
    });
  });
}
export function hasPreviousCancellation(message) {
  if(!/取消|撤销|算了|不用|不必|never mind|cancel that/i.test(message.text??''))return false;
  return policyFragments(message).some(part=>cancellation(part.text)?.previous);
}
function cancelsTask(cancel,old,targets) {
  if(action(old.part.text)===cancel.target)return true;
  const wanted=taskAction(cancel.target),actual=taskAction(old.part.text);
  if(!wanted||!actual||wanted.verb!==actual.verb)return false;
  if(wanted.object)return wanted.object===actual.object;
  // An unqualified verb cannot silently choose between different destinations.
  return targets.filter(candidate=>taskAction(candidate.part.text)?.verb===wanted.verb).length===1;
}
function filteredMessage(message, parts) {
  if(parts.every(p=>p.keep))return message;
  const sourceBlocks=message.blocks?.length?message.blocks:[{type:'text',text:message.text??''}];
  const blocks=sourceBlocks.map((block,index)=>{
    let text=String(block.text??'');
    for(const p of parts.filter(p=>p.blockIndex===index&&!p.keep).reverse())text=text.slice(0,p.start)+text.slice(p.end);
    return {type:'text',text};
  }).filter(b=>b.text.trim());
  return blocks.length?{...message,blocks,text:blocks.map(b=>b.text).join('\n')}:null;
}
export function memorySourceRefs(messages, session) {
  return messages.map(m=>{
    const ref={seq:m.seq,fragments:fragments(m).map(p=>p.hash)};
    if(!session)return ref; // Compatibility for callers without an event store.
    const event=session.eventAt(m.seq),message=session.deriveEventMessage(event);
    const blocks=Array.isArray(message?.content)?message.content.filter(b=>b.type==='text'):typeof message?.content==='string'?[{type:'text',text:message.content}]:[];
    if(event?.type!=='user/message'||!blocks.length)throw Object.assign(new Error('Cannot resolve checkpoint memory source.'),{code:'MEMORY_SOURCE_UNAVAILABLE'});
    return {...ref,layout:sourceLayout(m,{seq:m.seq,blocks})};
  });
}
export function restoreMemorySource(message, ref) {
  if(ref.layout)return restoreSourceLayout(message,ref.layout);
  if(!Array.isArray(ref.fragments)||ref.fragments.some(h=>typeof h!=='string'||!/^[a-f0-9]{64}$/.test(h)))throw new Error('Invalid memory source fragment references.');
  const parts=fragments(message),wanted=new Set(ref.fragments);
  if([...wanted].some(hash=>!parts.some(p=>p.hash===hash)))throw Object.assign(new Error('Memory source fragments are unavailable.'),{code:'MEMORY_SOURCE_UNAVAILABLE'});
  const counts=new Map();for(const hash of ref.fragments)counts.set(hash,(counts.get(hash)??0)+1);
  for(const part of [...parts].reverse()){const count=counts.get(part.hash)??0;part.keep=count>0;if(count)counts.set(part.hash,count-1);}
  return filteredMessage(message,parts);
}
export function removeConsumedCancellations(messages, decisions) {
  return messages.flatMap(message=>{
    const consumed=decisions.filter(d=>d.reason==='cancellation-applied'&&d.seq===message.seq);
    if(!consumed.length)return [message];
    const parts=policyFragments(message);
    for(const part of parts)if(consumed.some(d=>d.fragmentHash?d.fragmentHash===part.hash||d.fragmentHash===part.parentHash:!!cancellation(part.text)))part.keep=false;
    const retained=filteredMessage(message,parts);return retained?[retained]:[];
  });
}
// These exact standalone nudges carry no new task, constraint or authorization.
// Keep mixed messages, quoted literals, approvals, cancellations and parameters.
export function isEmptyContinuation(text) {
  return /^(?:继续(?:吧|执行|处理|工作)?|请继续|接着来|接着做|continue|please continue|go on|carry on)[。.!！\s]*$/iu.test(String(text??'').trim());
}
export function selectMemoryMessages(messages, options={}) {
  const discarded=messages.filter(m=>!isReferenceContextKind(m.sourceKind)&&isEmptyContinuation(m.text));
  const rows=messages.filter(m=>!isReferenceContextKind(m.sourceKind)).map((message,index)=>({message,index,emptyContinuation:isEmptyContinuation(message.text),parts:policyFragments(message)}))
    .sort((a,b)=>a.message.seq-b.message.seq||a.index-b.index);
  const decisions=discarded.map(m=>({reason:'empty-continuation',seq:m.seq})),kept=[];
  let previousUserRow=null;
  for(const row of rows){
    const mayRevise=row.message.sourceKind===undefined||row.message.sourceKind==='user';
    // A nudge has no content to retain, but still occupies the previous-user
    // address until this selection finishes. A later 'cancel previous' must
    // consume that no-op, never reach back to an unrelated surviving rule.
    if(row.emptyContinuation){for(const part of row.parts)part.keep=false;if(mayRevise)previousUserRow=row;continue;}
    for(const part of row.parts){
      if(part.emptyContinuation){part.keep=false;decisions.push({reason:'empty-continuation-fragment',seq:row.message.seq,fragmentHash:part.hash});continue;}
      const cancel=mayRevise?cancellation(part.text):null;
      // 'Cancel the previous request' addresses that whole user message, not the
      // last clause or an intervening plugin injection. A later repeat of an old
      // cancellation is never allowed to cancel a different request.
      const ownsTarget=kept.some(old=>old.row===row&&old.part.keep);
      const originalPrevious=Number.isSafeInteger(row.message.previousUserSeq)?row.message.previousUserSeq:undefined;
      const targetRow=ownsTarget?row:previousUserRow;
      const targetSeq=ownsTarget?row.message.seq:originalPrevious??targetRow?.message.seq;
      const targets=kept.filter(old=>old.part.keep&&(!cancel?.previous||old.row.message.seq===targetSeq));
      let cancelled=!!(cancel?.previous&&!ownsTarget&&(targetRow?.emptyContinuation&&targetRow.message.seq===targetSeq||originalPrevious!==undefined&&!targets.length));
      for(const old of targets){
        if(cancel&&(cancel.previous||cancelsTask(cancel,old,targets))){
          old.part.keep=false;cancelled=true;decisions.push({reason:'cancelled',seq:old.row.message.seq,by:row.message.seq,fragmentHash:old.part.hash,text:old.part.text});
        }else if((/```|~~~/.test(old.part.text+part.text)?old.part.text===part.text:key(old.part.text)===key(part.text))){
          if(!mayRevise&&(old.row.message.sourceKind===undefined||old.row.message.sourceKind==='user')){
            part.keep=false;decisions.push({reason:'duplicate',seq:row.message.seq,by:old.row.message.seq});
          }else{
            old.part.keep=false;decisions.push({reason:'duplicate',seq:old.row.message.seq,by:row.message.seq});
          }
        }else if(mayRevise&&!cancel&&!/```|~~~/.test(old.part.text+part.text)&&revises(old.part.text,part.text)){
          old.part.keep=false;decisions.push({reason:'superseded',seq:old.row.message.seq,by:row.message.seq,fragmentHash:old.part.hash,text:old.part.text});
        }
      }
      if(cancelled){part.keep=false;decisions.push({reason:'cancellation-applied',seq:row.message.seq,fragmentHash:part.hash});}
      if(part.keep)kept.push({row,part});
    }
    if(mayRevise)previousUserRow=row;
  }
  const active=rows.flatMap(row=>{const m=filteredMessage(row.message,row.parts);return m?[m]:[];});
  const bounded=boundMemoryQuotes(active,options);
  return {...bounded,decisions:[...decisions,...bounded.decisions]};
}
// Lifecycle decisions belong to the full session. Selecting a local quote tail
// must never reinterpret an ambiguous cancellation with fewer visible targets.
export function boundMemoryQuotes(active, options={}) {
  const preserved=[...active],decisions=[];
  const maxMessages=options.maxMessages??32,maxTokens=options.maxTokens??4096;
  const estimate=options.approxTokens??(text=>Buffer.byteLength(text,'utf8'));
  let used=preserved.reduce((n,m)=>n+estimate(m.text),0);
  while(preserved.length&&(preserved.length>maxMessages||used>maxTokens)){
    const removed=preserved.shift();used-=estimate(removed.text);decisions.push({reason:'oldest-quote-evicted',seq:removed.seq});
  }
  return {active,preserved,decisions};
}

// Only exact repeated prose lines are folded; fenced code is left untouched.
export function deduplicateNotes(text, quotes=[]) {
  const seen=new Set(quotes.flatMap(m=>m.text.split('\n')).filter(s=>s.trim()&&!/```|~~~|^\s*#/.test(s)).map(key));let fence=null;
  return String(text).split('\n').filter(line=>{
    const marker=/^\s*(`{3,}|~{3,})/.exec(line);
    if(marker){if(!fence)fence=marker[1][0];else if(marker[1][0]===fence)fence=null;return true;}
    if(fence||!line.trim()||/^\s*#/.test(line)||/^(?:\(none\)|（无）|none\.?|unknown\.?)$/i.test(line.trim()))return true;
    const k=key(line);if(seen.has(k))return false;seen.add(k);return true;
  }).join('\n').replace(/(^## [^\n]+\n)(?:[ \t]*\n)*(?=## |\s*$)/gm, '$1(none)\n\n');
}

export function memoryRequirements(messages) {
  return messages.flatMap(message=>{
    const text=sourceConstraintEvidence(message.text).join('\n');
    return text?[{seq:message.seq,text,blocks:[{type:'text',text}]}]:[];
  });
}
export function memoryPolicyInstruction(selection, options={}) {
  const live=selection.active.map(m=>m.text).join('\n');
  const retired=selection.decisions.filter(d=>d.text&&!live.includes(d.text));
  const retainedRequirements=memoryRequirements(selection.retained??[]);
  return 'Working-memory policy: retain the current goal, verified progress with evidence paths, unresolved issues and next actions. Deduplicate facts. Later explicit revisions replace earlier values for the SAME object and scope. An explicitly cancelled request and its cancellation are both absent from the resulting notes and pending tasks. Different conditions remain distinct. External skills/files are referenced by retrieval coordinates, not copied. Original quotes are bounded oldest-first; still-active requirements below must survive in the notes even when their raw quote is archived. Do not invent missing evidence.'+(options.requirements===false?'':'\nCurrent requirements:\n'+memoryRequirements(selection.active).map(m=>`[seq ${m.seq}] ${m.text}`).join('\n'))+((selection.governing??[]).length?'\nLater instructions outside this span (already visible separately; govern revisions, do not copy into the notes):\n'+selection.governing.map(m=>`[seq ${m.seq}] ${m.text}`).join('\n'):'')+(retainedRequirements.length?'\nOther active requirements already visible outside this span (respect them; do not duplicate them in notes):\n'+retainedRequirements.map(m=>`[seq ${m.seq}] ${m.text}`).join('\n'):'')+'\nRetired requests (exclude these, never execute them):\n'+retired.map(d=>`[${d.reason}, seq ${d.seq}, revised by ${d.by}] ${d.text}`).join('\n');
}
export function retiredMemoryPresent(text,selection) {
  const live=key(selection.active.map(m=>m.text).join('\n'));
  return selection.decisions.find(d=>d.text&&!live.includes(key(d.text))&&key(text).includes(key(d.text)));
}
