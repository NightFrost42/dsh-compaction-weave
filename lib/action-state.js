// Small explicit action grammar shared by lifecycle selection and revocation
// checks. Unknown language, compound conditions and quoted identifiers stay
// outside automatic equivalence; this is not a semantic classifier.
const normalize=text=>String(text??'').normalize('NFC').toLowerCase().trim().replace(/[。.!！?？;；，,]+$/,'').replace(/\s+/g,' ');
const verbs=new Map([
  ['生成','create'],['绘制','create'],['制作','create'],['产出','create'],['generate','create'],['create','create'],['draw','create'],
  ['上传','upload'],['upload','upload'],['下载','download'],['download','download'],
  ['导出','export'],['export','export'],['打包','package'],['package','package'],
  ['发送','send'],['send','send'],['部署','deploy'],['deploy','deploy'],
  ['删除','delete'],['delete','delete'],['修改','edit'],['编辑','edit'],['modify','edit'],['edit','edit'],
  ['运行','run'],['执行','run'],['run','run'],['execute','run'],
  ['安装','install'],['install','install'],['发布','publish'],['publish','publish'],
]);
const cnVerbPattern=[...verbs.keys()].filter(verb=>!/[a-z]/.test(verb)).join('|');
const startVerb=new RegExp('^('+[...verbs.keys()].map(verb=>/^[a-z]+$/.test(verb)?verb+'\\b':verb).join('|')+')\\s*(.+)$','i');
const forbidden=/[`"'“”‘’「」『』]|如果|除非|只有|仅当|否则|或者|要么|(?:^|[，,])\s*(?:若|当)|\b(?:if|when|unless|either|except)\b/i;
export function actionState(text,{summary=false}={}) {
  let value=normalize(text);
  if(!value||value.length>512||forbidden.test(value))return null;
  if(/^(?:已(?:经)?(?:生成|制作|绘制|上传|修改|运行|部署)|曾(?:经)?|之前|此前|据|根据|\b(?:already|previously|generated|created|uploaded|edited|deployed)\b)/i.test(value))return null;
  // Do not mistake retrospective/quoted mentions for a live action. A finite
  // negative state is useful when checking whether notes revive a task.
  if(/^(?:历史|旧文档|引用|网页|工具|日志|文档|样例|示例|the (?:tool|document|log)|historical)/i.test(value))return null;
  let negative=false,permission=false;
  value=value.replace(/^(?:当前|目前|现行)?(?:用户)?(?:要求|指令|规则|任务)\s*[:：]\s*/,'');
  if(summary)value=value.replace(/^(?:下一步|接下来|然后|现在|计划|准备|待|将要|将|继续)\s*[:：]?\s*|^(?:next(?: step)?|plan(?:ned)?(?: to)?|will|then)\s*:?\s*/i,'');
  value=value.replace(/^(?:(?:请|帮我|麻烦|必须|务必|现在|重新|还是)\s*|(?:please|must|now|again)\s+)+/,'');
  const operator=/^(?:(?:用户|我|你|助手|我们)\s*)?(?:现在|已经|已|明确|现已)?\s*(允许|可以|批准|授权|同意|不要|不得|不能|禁止|不必|无需|取消|撤销|不再|尚未|未|没有|还未|不用再|不要再)\s*|^(?:(?:the user|i|you|we)\s+)?(?:(?:has|have)\s+)?(?:now\s+|already\s+)?(allow(?:ed)?|permit(?:ted)?|authori[sz](?:e|ed)|approv(?:e|ed)|do not|don't|must not|never|cancel(?:led)?|not|no longer)\s+/i.exec(value);
  if(operator) {
    const op=operator[1]??operator[2];negative=/^(?:不要|不得|不能|禁止|不必|无需|取消|撤销|不再|尚未|未|没有|还未|不用再|不要再|do not|don't|must not|never|cancel|not|no longer)/i.test(op);
    permission=!negative;value=value.slice(operator[0].length).replace(/^(?:to|重新|再)\s*/,'');
    // Two operators never form an affirmative permission merely by stripping
    // the first one (don't cancel / 不要禁止). Leave their meaning to the source.
    if(/^(?:不要|不得|不能|禁止|不必|无需|取消|撤销|不再|尚未|未|没有|还未|不用再|不要再|do not|don't|must not|never|cancel|not|no longer)/i.test(value))return null;
  }
  value=value.replace(/^(?:把|将)\s*/,'');
  // Action-first forms; object-first 把 forms require a complete verb boundary.
  let match=startVerb.exec(value),object,verb;
  if(match){verb=verbs.get(match[1].toLowerCase());object=match[2];}
  else {
    match=new RegExp('^(.+?)('+cnVerbPattern+')((?:到|至|到达).+)?$','i').exec(value);
    if(!match)return null;verb=verbs.get(match[2].toLowerCase());object=match[1]+(match[3]??'');
  }
  object=object.replace(/(?:的)?(?:任务|请求|操作)$/,'').replace(/(?:了|吧)$/,'').replace(/^(?:the|a|an)\s+/,'').trim();
  if(!object||/[，,；;]|并且|然后|同时|或者|以及|\b(?:and|or|then)\b/.test(object))return null;
  return {verb,object,negative,permission,key:verb+'\u0000'+object};
}

export function sameAction(a,b) {return !!a&&!!b&&a.key===b.key;}
