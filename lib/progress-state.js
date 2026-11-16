// A bounded, declarative progress grammar. Object names come from the source,
// rather than a session-wide "latest task" guess. Predicates describe separate
// execution and verification axes; neither a plan nor an attempt is a result.
const named = /(?:任务|项目|模块|工单|服务|组件|制品|task|project|module|ticket|service|component|artifact)\s*(?:[:：#]\s*)?(?:[「“`"]([^」”`"\n]+)[」”`"]|([A-Za-z0-9][\w.-]*|[甲乙丙丁戊己庚辛壬癸一二三四五六七八九十]+)|([^\s，,。；;：:的]{1,32})(?=的|[:：]))/gi;
const kindOf = word => ({任务:'task',项目:'project',模块:'module',工单:'ticket',服务:'service',组件:'component',制品:'artifact'}[word] ?? word.toLowerCase());
const order = ['project','task','ticket','module','service','component','artifact','batch'];
const historical = /历史|旧(?:进度|状态|报告|快照)|较早|更早|样本|示例|\b(?:historical|previous|sample|example)\b/i;
const universal = /全部|所有|每一项|均|\b(?:all|everything|every (?:task|operation|test))\b/i;
const activities = [
  ['report',/报告|\breport\b/i], ['chart',/图表|统计图|\bchart\b/i],
  ['package',/离线包|打包|\bpackag(?:e|ing)\b/i], ['scan',/扫描|\bscan(?:ned|ning)?\b/i],
  ['build',/构建|编译|\b(?:rebuild|build|built|compil(?:e|ed|ation))\b/i],
  ['deploy',/部署|发布|\bdeploy(?:ed|ment)?\b/i], ['migration',/迁移|\bmigrat(?:e|ed|ion)\b/i],
  ['backup',/备份|\bbackup\b/i], ['install',/安装|\binstall(?:ed|ation)?\b/i],
  ['export',/导出|\bexport(?:ed)?\b/i], ['import',/导入|\bimport(?:ed)?\b/i],
  ['sync',/同步|\bsync(?:hroniz(?:e|ed|ation))?\b/i], ['test',/测试|复核|验证|校验|\b(?:tests?|test(?:ed|ing)|verif(?:y|ied|ication)|validat(?:e|ed|ion))\b/i],
];
const future = /^(?:[-*\d.)、\s]*(?:(?:当前|本次|现在)\s*)?)(?:如果|若|假设|计划|打算|预计|准备|拟|将要|将(?:在|会|进行)|待|下一步|接下来|然后|随后|请|需要|必须|要求|建议|应当|应该|(?:在)?.{1,50}(?:通过|完成|生成|结束|成功)后(?:再|将|应|确认|更新|检查)|(?:if|when|once|after|plan(?:ned)?(?: to)?|intend to|will|would|should|must|next(?: step| action)?|then|please)\b)/i;
// Obligations may follow an explicit subject ("qty must be ..."). Their
// comma-dependent error-code clauses are requirements, not observed failures.
const obligation = /(?:^|\s|[：:，,])(?:必须|须|务必|应当|应该|不得|不能|(?:must|shall|should)\b)|^[^。；;]{1,100}(?:必须|须(?:为|是|要)|不得|应当|应该)/i;
const orderedInstruction = /^(?:先(?!前)|首先|优先|务必)(?!前)/;
const question = /[?？]|(?:是否|有没有|能否|\b(?:whether|is it|has it|did it)\b)/i;
const current = /^(?:但|不过|然而|而|目前|当前|现在|实际|事实上|已经|已完成|已生成|已通过|尚未|还未|未能|没有|仍未|仍然|now\b|currently\b|actually\b|but\b)/i;
const progressSignal = /完成|生成|失败|报错|异常|中止|中断|尝试|执行|启动|运行|验证|测试|复核|校验|尚未|下一步|剩余|\b(?:complete[ds]?|generat(?:e[ds]?|ion)|fail(?:ed|ure)?|error|attempt(?:ed)?|start(?:ed)?|running|execut(?:e[ds]?|ion)|test(?:ed|ing)?|verif(?:y|ied|ication)|validat(?:e[ds]?|ion)|pending|next|remaining)\b/i;
export function hasProgressSignals(text) {
  text=String(text);
  try{if(typeof JSON.parse(text)==='object')return false;}catch{/* ordinary prose */}
  if(/^(?:Same-session continuation\.|This is an automatically generated checkpoint)/.test(text))return false;
  let fence=null;
  for(const line of text.split(/\r?\n/)){
    const marker=/^\s*(`{3,}|~{3,})/.exec(line);
    if(marker){if(!fence)fence=marker[1][0];else if(fence===marker[1][0])fence=null;continue;}
    if(!fence&&!/^\s*>/.test(line)&&progressSignal.test(line))return true;
  }
  return false;
}

export function progressObjectScope(text, inherited = 'current-work') {
  const parts = new Map(inherited === 'current-work' ? [] : inherited.split('/').map(p=>{const i=p.indexOf(':');return [p.slice(0,i),p.slice(i+1)];}));
  for (const m of text.matchAll(named)) {
    const word=/任务|项目|模块|工单|服务|组件|制品|task|project|module|ticket|service|component|artifact/i.exec(m[0])[0];
    const kind=kindOf(word),name=(m[1]??m[2]??m[3]).trim();
    if (/^(?:已|未|尚未|完成|失败|进行|当前|本次|全部|所有|completed|failed|current|all)$/i.test(name)) continue;
    // A new enclosing object cannot silently inherit a sibling's child object.
    const rank=order.indexOf(kind);
    for (const child of order.slice(rank+1)) parts.delete(child);
    parts.set(kind,encodeURIComponent(name));
  }
  const batch=/(?:批次|\bbatch)\s*[:：#]?\s*([A-Za-z0-9_-]+)/i.exec(text)??/第\s*([0-9]+)\s*批/.exec(text);
  if(batch&&!/^(?:个|份|\s+files\b)/i.test(text.slice(batch.index+batch[0].length))&&!/^(?:[a-z]\w*(?:Count|Completed|Generated|Path)|nextAction)$/i.test(batch[1]))parts.set('batch',batch[1]);
  else if(/上一批|前一批|\bprevious batch\b/i.test(text))return parts.size?[...parts].map(([k,v])=>k+':'+v).join('/')+'/previous-batch':'previous-batch';
  return order.filter(k=>parts.has(k)).map(k=>k+':'+parts.get(k)).join('/')||'current-work';
}

// Sentence/contrast boundaries reset modality. Commas can carry a planned
// dependent action, but an explicit current assertion starts a fresh claim.
export function progressFrames(text) {
  const frames=[];let scope='current-work',activity=null;
  for(const sentence of String(text).split(/(?<=[。！？；;])\s*|\r?\n|(?<=\.)\s+(?=[A-Z])/u)) {
    if(!sentence.trim())continue;
    if(/^\s*#{1,6}\s/.test(sentence)){scope='current-work';activity=null;continue;}
    // Quoted/superseded/sample object names own only that historical clause.
    // In particular a batch number in a log cannot name the current work that
    // follows it. Named live-task context still carries to dependent sentences.
    const beforeScope=scope,beforeActivity=activity,isHistorical=historical.test(sentence)&&!/(?:目前|当前|最新)(?:状态|进度)?[：:]|\b(?:currently|now)\b/i.test(sentence);
    if(isHistorical){scope='current-work';activity=null;}
    let planned=false,directive=false;
    const pieces=sentence.split(/[，,](?!\d)|(?=但是|但(?:目前|当前|报告|图表|构建|测试)|然而|不过|而(?:报告|图表)|并且(?:报告|图表))/u);
    for(const piece of pieces){
      const text=piece.trim();if(!text)continue;
      const nextScope=progressObjectScope(text,scope);
      if(nextScope!==scope)activity=null;
      scope=nextScope;
      if(current.test(text)){planned=false;directive=false;}
      directive=obligation.test(text)||orderedInstruction.test(text)||/^(?:请|需要|要求|建议|please\b|must\b|should\b)/i.test(text)||directive;
      planned=future.test(text)||directive||planned;
      const explicit=activityOf(text);
      // A result predicate followed by "testing" belongs to the prior subject
      // (report completed, passed tests); a new named operation owns its state.
      const dependent=/^(?:但|不过|然而|而|but\s+)?(?:已(?:经)?|尚未|还未|仍未|未|没有|结果|原因|错误|状态|成功|失败|经过|已经通过|通过了|(?:has |have |was |were )?(?:not |already )?(?:passed|failed|completed|untested))/i.test(text);
      if(explicit){
        if(explicit==='test'&&dependent)activity=activity??'*';
        else activity=explicit;
      }
      if(universal.test(text)&&verification.test(text))activity='*';
      frames.push({text,scope,activity,planned,directive,question:question.test(text),assertionText:sentence.trim(),order:frames.length});
    }
    if(isHistorical){scope=beforeScope;activity=beforeActivity;}
  }
  return frames;
}

function activityOf(text) {
  // A subject before a state predicate is a useful open vocabulary fallback:
  // "索引重建失败" and "快照归档已完成" need no fixture-specific dictionary.
  const subject=/^(?:[-*\d.)、\s]*)(?:最新进度[：:]\s*)?(.{1,64}?)(?=(?:已(?:经)?|尚未|还未|仍未|未能|没有|正在|尝试|失败|成功|报错|完成|\s+(?:failed|succeeded|completed|is running|has completed)\b))/.exec(text)?.[1]?.trim();
  const descriptive=subject?.replace(named,'').replace(/^(?:的|[\s:：])+|(?:的|[\s:：])+$/g,'');
  if(descriptive&&/^[\p{L}\p{N}_ .-]{2,48}$/u.test(descriptive)&&!/^本批|文件|全部任务|所有|\b(?:all tasks|all work)\b/i.test(descriptive)) {
    for(const [id,pattern] of activities)if(pattern.test(descriptive))return id;
    return 'named:'+descriptive.toLowerCase();
  }
  for(const [id,pattern] of activities)if(pattern.test(text))return id;
  return null;
}

const unsupportedClaim = /(?:不能|不得|不可|不应|不要|不代表|不表示|不意味着|不足以)(?:再)?[^，,。；;]{0,30}(?:宣称|声称|断言|认定|视为|当作|证明|完成|生成|通过)|\b(?:cannot|must not|does not)\s+(?:claim|prove|mean|confirm)/i;
const unknown = /未知|不明|不清楚|不确定|无法确认|不能确认|未确认|未返回|未收到|尚无结果|结果未出|\b(?:unknown|unconfirmed|undetermined|no result|awaiting (?:a )?result)\b/i;
const failed = /失败|未通过|未能(?:完成|成功)|报错|中止|中断|\b(?:failed|failure|error|aborted)\b/i;
const succeeded = /(?:已(?:经)?|均|全部)?通过(?:了)?|成功(?:了)?|\b(?:passed|succeeded|successful|successfully)\b/i;
const completed = /已(?:经)?(?:完成|生成|结束)|完成了|完成完毕|\b(?:completed|finished|done|generated)\b/i;
const attempted = /(?:已(?:经)?)?(?:尝试|试过)|\b(?:attempted|tried)\b/i;
const running = /正在|进行中|执行中|运行中|已(?:经)?(?:启动|开始|执行)|\b(?:running|in progress|started|executed)\b/i;
const notStarted = /(?:尚未|还未|未|没有)(?:开始|执行|运行|启动)|\b(?:not (?:yet )?(?:started|run|executed))\b/i;
const untested = /(?:尚未|还未|仍未|未|没有)(?:进行)?(?:独立)?(?:测试|验证|复核|校验)|未经(?:独立)?(?:测试|验证|复核|校验)|\b(?:untested|unverified|not (?:yet )?(?:tested|verified|validated))\b/i;
const verification = /测试|验证|复核|校验|\b(?:test(?:s|ed|ing)?|verif(?:y|ied|ication)|validat(?:e|ed|ion))\b/i;
const verificationPerformed = /经过|已(?:经)?(?:进行|执行|做)(?:了|过)?|完成了?|\b(?:tested|verified|validated|underwent|undergone)\b/i;
const attributable = /助手(?:称|报告|自报|自述)|(?:根据|据|源|来源|source)\s*seq\s*\d+|(?:用户|原说话者|报告方|原始助手)(?:称|报告|自报|自述)|\b(?:assistant|speaker|user)[ -](?:reported|claimed)|\b(?:assistant|speaker|user)\s+(?:reported|claimed|said)/i;
export const isAttributedProgress = text => attributable.test(text);
export const isIndependentClaim = text => /(?:已|通过|完成|经过).{0,16}独立(?:测试|验证|复核|校验)|独立(?:测试|验证|复核|校验).{0,12}(?:通过|完成)|\b(?:independently (?:verified|tested|validated)|passed independent (?:tests?|verification|validation))\b/i.test(text)&&!untested.test(text)&&!unsupportedClaim.test(text);

export function stateClaims(frame) {
  const {text,scope,activity,planned,question}=frame,claims=[];
  if(question||unsupportedClaim.test(text))return claims;
  if(!planned){
    if(/(?:没有|无)(?:任何)?(?:剩余|待办|未完成)(?:(?:任务|工作|动作|事项)(?!的|前置条件|审批|条件)|(?=[，,。；;！!\s]|$))|\bno (?:remaining|pending|unfinished) (?:tasks?|work|actions?)\b/i.test(text))claims.push({key:'nextAction',value:'none',scope,excerpt:text});
    if(universal.test(text)&&/(?:任务|工作|事项)|\b(?:tasks?|work|everything)\b/i.test(text)&&completed.test(text.replace(/全部任务完成|所有任务完成|所有工作完成/g,'已完成')))claims.push({key:'overallState',value:'completed',scope,excerpt:text});
    if(universal.test(text)&&succeeded.test(text)&&!verification.test(text)&&!failed.test(text))claims.push({key:'overallState',value:'succeeded',scope,excerpt:text});
  }
  if(!activity)return claims;
  const stateScope=scope+'/activity:'+encodeURIComponent(activity);
  const put=(key,value)=>claims.push({key,value,scope:stateScope,excerpt:text,activity,phase:planned?'plan':'observation'});
  const isVerification=verification.test(text);
  if(planned){
    if(!['report','chart','package','scan'].includes(activity))put('executionState','planned');
    return claims;
  }
  if(isVerification&&(untested.test(text)||unknown.test(text)||failed.test(text)||succeeded.test(text)||completed.test(text)||verificationPerformed.test(text))){
    const value=untested.test(text)?'untested':unknown.test(text)?'unknown':failed.test(text)?'failed':succeeded.test(text)?'passed':'completed';
    put('verificationState',value);
  }
  // Existing output fields already protect basic completion. Extra state is
  // needed for attempts, execution results and open-vocabulary operations.
  const legacyOutput=['report','chart','package','scan'].includes(activity);
  if(attempted.test(text))put('executionAttempted',true);
  const negatedFailure=/(?:没有|并未|未|不是)\s*失败|\b(?:did not fail|not failed)\b/i.test(text);
  let state=null;
  if(notStarted.test(text))state='not-started';
  else if(unknown.test(text)&&/(?:结果|状态|是否|成功|完成)|\b(?:result|outcome|status)\b/i.test(text))state='unknown';
  else if(failed.test(text)&&!negatedFailure&&!untested.test(text))state='failed';
  else if(succeeded.test(text)&&!untested.test(text))state='succeeded';
  else if(completed.test(text))state='completed';
  else if(running.test(text))state='running';
  else if(attempted.test(text))state='attempted';
  const verificationResult=isVerification&&!['test','*'].includes(activity);
  if(state&&!verificationResult&&(!legacyOutput||['attempted','running','failed','unknown','not-started'].includes(state)))put('executionState',state);
  // Failed creation/scan cannot be asserted as a completed artifact. Failed
  // tests on an existing artifact do not negate its creation on the other axis.
  if(state==='failed'&&legacyOutput&&!verificationResult)claims.push({key:({report:'reportGenerated',chart:'chartGenerated',package:'packageCompleted',scan:'scanCompleted'})[activity],value:false,scope,excerpt:text});
  if(state==='failed'){
    const codes=[...text.matchAll(/\b(?:[A-Z][A-Z\d]*(?:_[A-Z\d]+)+|E[A-Z]{3,}|[A-Z]{2,}\d{2,})\b/g)].map(m=>m[0]);
    if(codes.length)put('failureCode',[...new Set(codes)].sort().join(','));
  }else if(/^(?:原因|错误|失败原因|error\b|cause\b)\s*[:：]?/i.test(text)){
    const codes=[...text.matchAll(/\b(?:[A-Z][A-Z\d]*(?:_[A-Z\d]+)+|E[A-Z]{3,}|[A-Z]{2,}\d{2,})\b/g)].map(m=>m[0]);
    if(codes.length)put('failureCode',[...new Set(codes)].sort().join(','));
  }
  return claims;
}

export function progressScopesMatch(candidate, source) {
  if(candidate===source)return true;
  // An unnamed object is never rebound to just the most recent named sibling.
  // Its claim must agree with every otherwise compatible named object.
  if(candidate==='current-work')return !source.includes('/activity:');
  if(candidate.endsWith('/activity:*')){
    const base=candidate.slice(0,-'/activity:*'.length);
    return source.includes('/activity:')&&(base==='current-work'||source.startsWith(base+'/activity:'));
  }
  if(candidate.startsWith('current-work/activity:'))return source.endsWith(candidate.slice('current-work'.length));
  return false;
}

export function stateCompatible(candidate, source) {
  if(candidate===source)return true;
  return candidate==='completed'&&source==='succeeded';
}

export function nextActionCompatible(candidate, source) {
  if(candidate===source)return true;
  // General next steps retain source text rather than pretending to have a
  // universal synonym dictionary. Compare a named destination operation when
  // both sides identify one; an opaque preparatory clause is not evidence of
  // an incompatible destination. The explicit none/result contradictions are
  // still audited, as are the established generated-report/chart/package IDs.
  if(!candidate.startsWith('text:')||!source.startsWith('text:'))return false;
  const operation=value=>{
    const raw=value.slice(5);
    for(const [id,pattern] of activities)if(pattern.test(raw)||id==='build'&&/rebuild/.test(raw))return id;
    return null;
  };
  const a=operation(candidate),b=operation(source);
  return !a||!b||a===b;
}

export function generalNextAction(text) {
  const match=/(?:下一步|接下来|\bnext(?: action| step)?\b)\s*[:：]?\s*([^。；;]+)/i.exec(text);
  if(!match)return null;
  const action=match[1].replace(/^(?:为|是|[:：])\s*/,'').trim();
  const parenthetical=/^[（(]([^（）()]*)[）)]/.exec(action);
  if(parenthetical){
    const content=parenthetical[1],id=/生成(?:本地)?报告/.test(content)?'generate-report':/生成(?:统计)?图(?:表)?/.test(content)?'generate-chart':/打包.*(?:校验|验证)/.test(content)?'package-and-verify':null;
    if(id)return id;
  }
  // A nominal reference to a "next step instruction" is not a newly named
  // action. It may describe the field without assigning or changing its value.
  if(/^(?:指示|安排|要求|状态|字段|计划|声明|记录|报告|[）)\]。]|instruction\b|field\b|status\b|declaration\b)/i.test(action))return null;
  if(/^(?:无|没有|none)[。.!\s]*$/i.test(action))return 'none';
  if(!action||action.length>200)return null;
  return 'text:'+action.replace(/[`*\s，,。.!]/g,'').toLowerCase();
}
