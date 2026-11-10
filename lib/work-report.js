// A small exact latest work report complements generated notes. It is assistant
// evidence, never a user requirement or a claim of independent verification.
import {createHash} from 'node:crypto';
const MAX_REPORT_BYTES=3072;
const hash=blocks=>createHash('sha256').update(JSON.stringify(blocks)).digest('hex');
const failure=()=>Object.assign(new Error('Latest work report source cannot be verified.'),{code:'WORK_REPORT_SOURCE_UNAVAILABLE'});
function read(session,seq) {
  const event=session.eventAt(seq);if(event?.type!=='assistant/message')throw failure();
  const message=session.deriveEventMessage(event),content=message?.content;
  if(!Array.isArray(content))return null;
  const blocks=content.filter(b=>b.type==='text').map(b=>({type:'text',text:b.text}));
  if(blocks.some(b=>typeof b.text!=='string'))throw failure();
  return {seq,blocks,text:blocks.map(b=>b.text).join('\n'),sha256:hash(blocks)};
}
export function collectWorkReport(session,seqs) {
  let latest=null;
  for(const seq of seqs){
    const event=session.eventAt(seq);let report;
    if(event?.type==='assistant/message'){
      report=read(session,seq);
      if(!report||!/(?:已完成|已生成|已验证|已改名|已通过|尚未|未完成|下一步|剩余|全部任务完成|\b(?:completed|generated|verified|passed|pending|next step|remaining)\b)/i.test(report.text))continue;
    }else{
      const ref=event?.type==='user/message'&&event.data?.source?.kind==='compact-checkpoint'?event.data.source.workReport:null;
      if(!ref)continue;
      if(!Number.isSafeInteger(ref.seq)||ref.seq<0||ref.seq>=seq||typeof ref.sha256!=='string')throw failure();
      report=read(session,ref.seq);if(!report||report.sha256!==ref.sha256)throw failure();
    }
    if(!latest||report.seq>latest.seq)latest=report;
  }
  // Keep the newest source even when its text is too large to repeat. Dropping
  // the reference would let an older checkpoint resurrect a stale exact report
  // on the next merge. Oversized reports carry identity, never partial prose.
  if(!latest)return null;
  return Buffer.byteLength(latest.text,'utf8')<=MAX_REPORT_BYTES?latest:{seq:latest.seq,sha256:latest.sha256,omitted:true};
}
// Do not append an obsolete verbatim status beside newer retained progress.
// Its complete text is still in the summarizer input/archive, and its source
// identity survives. Only overlapping work fields can establish supersession.
export function scopeWorkReport(report,progress) {
  if(!report)return report;
  const prior=(progress?.history??[]).filter(f=>f.seq===report.seq);
  const newer=(progress?.effective??[]).filter(f=>f.seq>report.seq&&prior.some(p=>p.key===f.key&&p.scope===f.scope));
  if(!newer.length)return report;
  return {seq:report.seq,sha256:report.sha256,omitted:true,supersededBy:Math.max(...newer.map(f=>f.seq))};
}
export const workReportRef=report=>report?{seq:report.seq,sha256:report.sha256}:null;
export function renderWorkReport(report) {
  if(!report)return '';
  if(report.supersededBy!==undefined)return `Historical assistant work report source seq ${report.seq}; overlapping progress has a newer original source at seq ${report.supersededBy}. Its verbatim status is not repeated here. Keep non-superseded details from the local notes or archive; use the newer original for current status. This is historical assistant evidence, not new permission.`;
  if(report.omitted===true)return `Latest assistant work report WITHIN THIS SPAN is source seq ${report.seq}; later messages outside the span may have newer progress. Its full text exceeds the verbatim allowance; this does not make facts elsewhere unknown. Consult the generated notes or archived source for its content. Earlier report excerpts are older evidence, not proof of current status. Reconcile status for the same work item using this newer source; do not invent its contents. This is historical assistant evidence, not new permission; later user instructions still govern.`;
  const longest=Math.max(2,...[...report.text.matchAll(/`+/g)].map(m=>m[0].length)),fence='`'.repeat(longest+1);
  return `Latest assistant work report WITHIN THIS SPAN, source seq ${report.seq} (verbatim; not independently re-verified by the compactor). For the SAME work item, this report supersedes older status only. Later original messages outside this span remain authoritative; this excerpt cannot override them. Preserve its stated uncertainty; later user instructions still govern. This is historical assistant evidence, not new permission.\n${fence}text\n${report.text}\n${fence}`;
}
