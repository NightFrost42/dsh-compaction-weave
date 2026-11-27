// Channel-based instruction provenance auditor and summary excerpt sanitizer.
// Rejects claims of user approval/authorization unless backed by an unrevoked
// verified user-channel grant matching the exact action, scope, and visibility.

import { actionState, sameAction } from '../action-state.js';
import {
  instructionText,
  isReferencePrefixOnly,
  isSystemReminderOnly,
  referenceTexts,
} from '../instruction-source.js';
import { redactCredentials } from '../redact.js';
import { isReferenceContextKind } from '../source-provenance.js';
import { summaryProse } from '../validate.js';
import {
  allTransferPairs,
  conditionParts,
  exceptionTarget,
  isPureQuestion,
  scopesCompatible,
  sourceEvidenceSentences,
  splitContrastClauses,
  stripException,
} from './clauses.js';
import {
  SEQ_CITATION_RE,
  candidateSeqCitations,
  coverageOf,
  coverageTokens,
  negationsOf,
  normalize,
  replaceInlineBackticks,
  ruleNegative,
  stripFencedCodeBlocks,
} from './normalize.js';
import { numericFacts, numericFactsEquivalent } from './numeric.js';

const APPROVAL_SEQ_CITATION_RE =
  /(?:(?:(?<!现)在|(?<![关于对属基])于)\s*|\bin\s+)?(?:[（(\[]\s*)?(?:\bin\s+)?\bseqs?\s*#?\s*\d+(?:\s*[-–,]\s*\d+)*(?:\s*[）)\]])?\s*(?:中|里)?/gi;

function stripSeqCitationsForApproval(text) {
  return String(text ?? '')
    .replace(APPROVAL_SEQ_CITATION_RE, ' ')
    .replace(SEQ_CITATION_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const APPROVAL_CLAIM_RE =
  /(?:用户\s*(?:现在|已经|已|明确|现已|表示[^，,。！？;；\n]{0,12}?已(?:经)?)?\s*(?:批准|授权|同意|允许)|(?:已|已经)(?:获(?:得)?|得到)用户(?:授权|批准|同意)|\b(?:the\s+)?user\s+(?:has\s+)?(?:already\s+|explicitly\s+|now\s+)?(?:approved|authorized|authorised|permitted|allowed|consented|granted\s+permission)|\b(?:approved|authorized|authorised|permitted)\s+by\s+(?:the\s+)?user\b)/i;
const DIRECT_USER_APPROVAL_RE =
  /(?:^\s*(?:我\s*(?:现在|已经|已|明确|现已)?\s*(?:批准|授权|同意|允许)|i\s+(?:hereby\s+)?(?:authorize|authorise|approve|allow|permit|consent\s+to)\b))/im;
const UNTRUSTED_APPROVAL_SIGNAL_RE =
  /(?:(?:现已|已经|已|明确)?(?:批准|授权|同意|允许)|\b(?:approved|authorized|authorised|permitted|allowed|consented)\b)/i;
const NEGATED_OR_PENDING_APPROVAL_RE =
  /(?:未经|未获|没有得到|没有获得|尚无|尚未|并非|等待|等候|待|如(?:果)?|只有|仅当|除非|前置条件|前提(?:是|为)?|须先|需先|必须先|先经|先获|若无|若未|如无|如未|未|没有|不用(?!担心|怕|谢)|不(?!(?:用担心|必担心|再担心|用怕|要紧|久|过|仅|但|论)))(?:(?!(?:并(?:已|已经|且)|而且|但是|但|不过|而是|已经|现已|表示|[，,、。！？;；\n])).){0,24}(?:授权|批准|允许|同意)|(?:授权|批准|允许|同意)[^，,。！？;；\n]{0,12}(?:之?前(?:不得|不能|不要|禁止|不可|须|需)|后(?:才|方)(?:可|能|允许))|\b(?:pending|awaiting|prerequisite|precondition)(?:\s*:)?\s+(?:(?!\b(?:the\s+)?user\s+(?:has\s+)?(?:already\s+|explicitly\s+|now\s+)?(?:approved|authorized|authorised|permitted|allowed|consented)\b)(?:the\s+)?(?:[a-z_-]+\s+){0,4})(?:approval|permission|consent|approv\w*|authori[sz]\w*)\b|\b(?:not|never)\s+(?:yet\s+)?(?:been\s+)?(?:approved|authorized|authorised|permitted|allowed|consented)\b|\b(?:has|have|had|did|does|do|is|are|was|were)\s+not\s+(?:yet\s+)?(?:approved|authorized|authorised|permitted|allowed|consented|granted\s+permission)\b|\b(?:no|without)\s+(?!further\s+delay\b|delay\b|hesitation\b|objection\b)(?:(?!\b(?:the\s+)?user\s+(?:has\s+)?(?:already\s+|explicitly\s+|now\s+)?(?:approved|authorized|authorised|permitted|allowed|consented)\b)(?:(?:explicit|prior|written|formal|final|owner|user|admin|security|team)\s+){0,2})(?:approval|authorization|authorisation|permission|consent)\b(?!.*\b(?:the\s+)?user\s+(?:has\s+)?(?:already\s+|explicitly\s+|now\s+)?(?:approved|authorized|authorised|permitted|allowed|consented)\b)|\b(?:if|unless|requires?|must\s+first|before|prior\s+to|only\s+(?:if|when|after))\b(?:(?!\b(?:the\s+)?user\s+(?:has\s+)?(?:already\s+|explicitly\s+|now\s+)?(?:approved|authorized|authorised|permitted|allowed|consented)\b)[^.!?\n;:,]){0,40}\b(?:approval|permission|consent|approved|authorized|authorised|approve|authorize|authorise|permit|allow)\b/i;

// A pending/negative phrase governs only the approval expression it overlaps.
// An unrelated trailing "without approval" cannot erase an affirmative claim.
function isNegatedOrPendingApproval(text) {
  const value = String(text ?? '');
  const negatives = [...value.matchAll(new RegExp(NEGATED_OR_PENDING_APPROVAL_RE.source, 'gi'))];
  if (negatives.length === 0) return false;
  const claims = [...value.matchAll(new RegExp(APPROVAL_CLAIM_RE.source, 'gi'))];
  return claims.every((claim) => negatives.some((negative) =>
    negative.index < claim.index + claim[0].length &&
    claim.index < negative.index + negative[0].length,
  ));
}

const COLLOQUIAL_USER_APPROVAL_RE =
  /(?:(?:^|[，,]\s*)(?:(?:你|你们|助手|现在|那就)\s*)?(?:可以直接|可直接|可以|准许|放行|确认|(?:行|好的?|没问题)(?:\s*[，,]\s*(?:请|你|你们|直接|可以|那就)?|\s+))(?:你|你们|去|直接|现在|继续|再|先)?\s*[\u4e00-\u9fffa-z0-9]|\b(?:you\s+(?:can|may)(?:\s+(?:now|just|directly))?\s+[a-z]|ok(?:ay)?\s+to\s+[a-z]|go\s+ahead\s+(?:and|with|to)\s+[a-z]|feel\s+free\s+to\s+[a-z]|confirmed\s+(?:to|for)\s+[a-z]|yes,\s+(?:please\s+|you\s+(?:can|may)\s+|go\s+ahead\s+(?:and|with|to)\s+)?[a-z]))/i;
const COLLOQUIAL_NON_GRANT_RE =
  /(?:是否|能否|可否|能不能|可不可以|行不行|好不好|对不对|为什么|为何|怎么|如何|如果|倘若|假如|除非|只有|仅当|一旦|前提|前置条件|待确认|先确认|需确认|须确认|请确认|确认一下|不确定|先问我|问我|再定|暂缓|先等等|未必|谁说|难道|[吗呢么]\s*$|\b(?:if|unless|whether|only\s+(?:if|when|after)|not\s+sure|uncertain|unsure|ask\s+me|confirm\s+with\s+me|before\s+confirming|wait\s+until)\b)/i;
const STANDALONE_AFFIRMATION_RE =
  /^(?:好的?|行|没问题|同意|批准|授权|允许|确认|可以|准许|ok(?:ay)?|yes|sure|agreed|confirmed)[。.!！\s]*$/i;
const ADVISORY_OR_OBSERVATION_PREFIX_RE =
  /^(?:注意|切记|切勿|谨记|提醒|提示|小心|别忘了|记得|顺便提一下|顺便说|另外注意|说明|备注|刚才|之前|以前|曾经|原来|当时|目前看来|好像|似乎|感觉|\b(?:note|caution|warning|reminder|remember|be\s+careful|fyi|btw|earlier|previously|currently|seems?)\b)/i;
const RETROSPECTIVE_GRANT_PREFIX_RE =
  /^(?:已(?:经)?|曾(?:经)?|之前|此前|正在|刚才|昨天|上次|\b(?:already|previously|earlier|currently|was|were)\b)/i;
const DIRECT_IMPERATIVE_GRANT_RE =
  /(?:^(?:请(?!问)|麻烦|帮我|直接|现在|立即|马上|那就)|吧\s*[。.!！\s]*$|^(?:please|now|go\s+ahead|just)\s+)/i;
const ACTION_DIRECTIVE_RE =
  /(?:^(?:请|麻烦|帮我|直接|顺便把|顺便|然后把|然后|接着把|接着|再把|再|并把|把|将)|(?:把|将)\S{1,24}(?:放进|放入|放到|放|移入|移到|存入|存进|存到|提交到?|推送到?|推上去|写进|写入|改为|改成|设为|设置为|删掉|删除|迁移到?|复制到?|同步到?)|(?:做|弄|搞)(?:一个|个)?[^\n。！？;；]{0,20}(?:私有)?(?:仓库|代码库|库|\brepo)|(?:发布|部署|推送|推上去|放进|放入|放到|创建|新建|建立|生成|删除|删掉|移除|清理|清除|保留|留存|修改|更新|调整|改为|改成|设为|设置为|运行|执行|跑|测试|安装|配置|同步|迁移|复制|移动|提交|合并|写入|写进|打开|关闭|重启|整理|归档|上传|下载|备份|恢复|开始|继续|开工|开跑|启动)|\b(?:please|publish|deploy|push|put|place|store|create|make|add|delete|remove|clean|keep|retain|modify|update|run|execute|test|install|configure|sync|migrate|copy|move|commit|merge|write|open|close|restart|upload|download|backup|restore|start|begin|continue|launch)\b)/i;

const APPROVAL_BOILERPLATE_RE =
  /(?:(?:我|用户)\s*(?:现在|已经|已|明确|现已|在此)?\s*(?:批准|授权|同意|允许)|(?:已|已经)?(?:获(?:得)?|得到)用户(?:授权|批准|同意)|\b(?:the\s+)?user\s+(?:has\s+)?(?:already\s+|explicitly\s+|now\s+)?(?:approved|authorized|authorised|permitted|allowed|consented|granted\s+permission(?:\s+(?:to|for))?)|\bi\s+(?:hereby\s+)?(?:authorize|authorise|approve|allow|permit|consent\s+to)|\b(?:approved|authorized|authorised|permitted)\s+by\s+(?:the\s+)?user|\bto\b|\bfor\b|\bthe\b)/gi;

const COLLOQUIAL_GRANT_STRIP_RE =
  /^(?:(?:你|你们|助手|现在|那就)\s*)?(?:可直接|可以直接|可以|准许|放行|确认|(?:好的?|行|没问题)(?:\s*[，,]\s*)?)+(?:请|你|你们|去|直接|现在|继续|再|先)?|^(?:yes[,\s]+(?:please\s+)?|ok(?:ay)?\s+to\s+|you\s+(?:can|may)(?:\s+(?:now|just|directly))?\s+|go\s+ahead\s+(?:and|with|to)\s+|feel\s+free\s+to\s+|confirmed\s+(?:to|for)\s+|please\s+)/gi;

const TEMPORAL_DIRECTIVE_LEAD_RE =
  /^(?:在\s*)?(?:[^\s，,。；;]{1,12}?(?:完成后|完毕后|结束后)|完成[^\s，,。；;]{1,12}?后(?![半续面边方端台期置退果悔代者来缀])|完成后|完毕后|结束后|之后|随后|然后|接着|再|请|麻烦|帮我|直接)\s*/i;

const REVOCATION_APPROVAL_RE =
  /\b(?:revoke|withdraw|cancel|rescind|reject|deny|forbid|disallow|ban|prohibit)\s+(?:my\s+|the\s+|this\s+)?(?:prior\s+|previous\s+)?(?:approval|authorization|authorisation|permission|consent)\b|\b(?:do\s+not|don't|no\s+longer|not)\s+(?:approve|authorize|authorise|permit|allow|consent)\b|(?:撤销|取消|收回|撤回|作废|不再|不|不要|禁止|拒绝)(?:之前|刚才|上述|先前的?)?(?:的)?(?:批准|授权|同意|允许)/i;

const COLLOQUIAL_REVOCATION_RE =
  /(?:(?:先不要|不要再|暂不|先?(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人|忘了|忘记)|不要(?!紧|怕|求|忘)|禁止|不得|严禁|切勿|请勿|取消|撤回|撤销)\s*(?:[\u4e00-\u9fffa-z0-9_/.-]|(?=\S))|\b(?:do\s+not|don't|never|must\s+not)\s+(?!worry\b|hesitate\b|forget\b|miss\b)(?:the\s+|this\s+|any\s+)?[a-z]|^\s*cancel\s+(?:the\s+|this\s+|my\s+)?[a-z])/i;

const STANDALONE_COLLOQUIAL_CANCEL_RE =
  /^(?:(?:还是|先|那就)?(?:算了|不用了|罢了|作罢|算了吧)|(?:先)?(?:取消|撤回|作废)(?:上一条|上一项|刚才(?:那条|说的|那个)?|刚才的|这条)?|别这么?做了|先别了|\b(?:never\s*mind|nevermind|scratch\s+that|forget\s+(?:it|that)|cancel\s+(?:that|the\s+last(?:\s+one)?)|disregard\s+that)\b)[。.!！?？…~\s]*$/i;

const REVOCATION_BOILERPLATE_RE =
  /(?:(?:(?:我|用户)\s*)?(?:现在|已经|已|明确|现已|在此)?\s*(?:撤销|取消|收回|撤回|作废|不再|禁止|不得|严禁|切勿|请勿|拒绝|先不要|不要再|暂不|不要|先?(?<![分区识个特级差类性鉴告离甄辨判派])别(?!的|人|忘了|忘记)|不)\s*(?:之前|刚才|上述|先前的?)?(?:对)?(?:的)?(?:批准|授权|同意|允许)?|(?:之前|刚才|上述|先前的?)?(?:的)?(?:批准|授权|同意|允许)|\b(?:(?:i|the\s+user)\s+)?(?:hereby\s+)?(?:revoke|withdraw|cancel|rescind|reject|deny|forbid|do\s+not|don't|never|must\s+not|shall\s+not|no\s+longer|not)\s+(?:my\s+|the\s+|this\s+)?(?:prior\s+|previous\s+)?(?:approval|authorization|authorisation|permission|consent|approve|authorize|authorise|permit|allow)?\b|\b(?:of|for|on|to|the|my|this)\b)/gi;

const COMPOUND_CLAIM_SPLIT_RE =
  /(?:并且|并在|(?<![一合兼吞归相])并(?![且不未无非]|购|入|发(?!送|布|起|出)|行(?!动|事)|列(?!出)|排(?!查|除)|存(?!档|储|放)|吞|网|联(?!系)|拢|肩|重|举|蒂|案)|以及|同时|\band\b)/i;

const PRIVATE_VISIBILITY_RE =
  /(?:私有|私密|不公开|非公开|\b(?:private|non-?public|unlisted)\b)/i;
const PUBLIC_VISIBILITY_RE =
  /(?:(?<![不非未])公开|公共|\b(?<!non-)(?<!not\s)public\b)/i;

const VERB_FAMILY_RES = [
  ['read', /(?:查看|读取|读|检查|检索|查询|浏览|只看|\b(?:read|view|inspect|list|check|search|query|browse)\b)/i],
  ['draft', /(?:起草|草拟|拟定|打草稿|草稿|\b(?:draft|compose|outline)\b)/i],
  ['write', /(?:写入|写进|修改|编辑|更新|更改|覆盖|保存|改动|\b(?:write|edit|modify|update|change|patch|overwrite|save)\b)/i],
  ['delete', /(?:删除|删掉|移除|清空|销毁|抹除|丢弃|清理|清除|\b(?:delete|drop|remove|purge|wipe|destroy|erase|rm|truncate)\b)/i],
  ['publish', /(?:发布|上线|部署|推送|推上去|(?<![不非未])公开|\b(?:publish|release|deploy|ship|push|broadcast)\b)/i],
  ['exec', /(?:执行|运行|重跑|重运行|启动|调用|开始|开工|开跑|继续|\b(?:exec|execute|run|rerun|invoke|eval|launch|start|begin|continue)\b)/i],
  ['test', /(?:测试|单测|验证|校验|\b(?:test|tests|verify)\b)/i],
  ['repo_setup', /(?:放进|放入|放到|存进|存入|存到|移入|移到|创建|新建|建立|(?:做|弄|搞)(?:一个|个)?(?=[^\n。！？;；]{0,20}(?:私有)?(?:仓库|代码库|库|\brepo))|\b(?:put|place|store|create|make|init|initialize|setup|set\s+up)\b)/i],
];

const INCOMPATIBLE_VERB_FAMILY_PAIRS = new Set([
  'draft\0publish', 'publish\0draft',
  'read\0write', 'write\0read',
  'read\0delete', 'delete\0read',
  'read\0publish', 'publish\0read',
  'read\0exec', 'exec\0read',
  'exec\0delete', 'delete\0exec',
  'write\0delete', 'delete\0write',
  'write\0publish', 'publish\0write',
  'publish\0delete', 'delete\0publish',
  'repo_setup\0delete', 'delete\0repo_setup',
  'repo_setup\0publish', 'publish\0repo_setup',
  'test\0delete', 'delete\0test',
  'test\0publish', 'publish\0test',
  'test\0write', 'write\0test',
]);

const REPO_SETUP_STRIP_RE =
  /(?:把|将|源码|代码|工程|项目|文件|资料|一个|到|进|入|里|中|在|向|往|放进|放入|放到|放|存进|存入|存到|移入|移到|创建|新建|建立|\b(?:put|place|store|create|make|init|initialize|setup|set\s+up|push|source|code|files?|a|an|the|to|into|in|on|for)\b)/gi;

const stripApprovalBoilerplate = (text) => {
  const cleaned = normalize(stripSeqCitationsForApproval(text))
    .replace(/\*\*|__/g, ' ')
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(APPROVAL_BOILERPLATE_RE, ' ')
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(/(?:^|\s)[:：]+|[:：]+(?=\s|$)/g, ' ')
    .replace(/^[)）]+|[（(]+$/g, ' ')
    .replace(/[。.!！?？;；，,…]+/g, ' ')
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return coverageTokens(cleaned).length === 0 ? '' : cleaned;
};

function stripTemporalDirectiveLead(text) {
  let value = normalize(text);
  if (/^(?:如果|倘若|假如|除非|只有|仅当|若|\b(?:if|unless)\b)/i.test(value)) return value;
  let prev;
  do {
    prev = value;
    value = value.replace(TEMPORAL_DIRECTIVE_LEAD_RE, '').trim();
  } while (value && value !== prev && !/^(?:如果|倘若|假如|除非|只有|仅当|若|\b(?:if|unless)\b)/i.test(value));
  return value || normalize(text);
}

function stripGrantBoilerplate(text) {
  let value = stripApprovalBoilerplate(text);
  let prev;
  do {
    prev = value;
    value = value
      .replace(COLLOQUIAL_GRANT_STRIP_RE, ' ')
      .replace(/^(?:(?:我|用户|你|你们)\s*)?(?:现已|已经|已|明确)?\s*(?:批准|授权|同意|允许|确认)\s*/i, ' ')
      .replace(/^\b(?:approved|authorized|authorised|permitted|allowed|consented)(?:\s+(?:to|for))?\b/i, ' ')
      .replace(/^(?:(?:直接|去)\s+|(?:现在|立即|马上|那就)\s*(?=[\u4e00-\u9fffa-z0-9]{2,}))/i, ' ')
      .replace(/(?:^|\s)[:：]+|[:：]+(?=\s|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } while (value !== prev);
  const withoutParticle = value.replace(/吧$/, '').trim();
  return stripTemporalDirectiveLead(withoutParticle || value);
}

const stripRevocationBoilerplate = (text) => {
  const cleaned = normalize(stripSeqCitationsForApproval(text))
    .replace(/\*\*|__/g, ' ')
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(REVOCATION_BOILERPLATE_RE, ' ')
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(/(?:^|\s)[:：]+|[:：]+(?=\s|$)/g, ' ')
    .replace(/[。.!！?？;；，,…]+/g, ' ')
    .replace(/[（(]\s*[)）]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return coverageTokens(cleaned).length === 0 ? '' : cleaned;
};

function normApprovalInflections(text) {
  return normalize(text)
    .replace(/(?:开工|开跑|启动|开始)/g, '开始')
    .replace(/\b([a-z]{3,})\b/g, (w) => {
      if (/(?:runn|sett|putt|shipp|stopp|dropp|gett|cutt|swapp|tagg|logg|committ)ing$/.test(w)) {
        return w.slice(0, -4);
      }
      if (/(?:creat|delet|updat|plac|stor|writ|remov|execut|configur|initiat|mov|merg|sav|eras|purg|truncat|approv|authori[sz]|enabl|disabl)ing$/.test(w)) {
        return `${w.slice(0, -3)}e`;
      }
      if (/ing$/.test(w) && w.length >= 6) return w.slice(0, -3);
      return w;
    });
}

function verbFamiliesOf(text) {
  const value = normApprovalInflections(text);
  const families = new Set();
  for (const [name, re] of VERB_FAMILY_RES) {
    if (re.test(value)) families.add(name);
  }
  return families;
}

function hasIncompatibleVerbFamily(srcText, claimText) {
  const sf = verbFamiliesOf(srcText);
  const cf = verbFamiliesOf(claimText);
  if (sf.size === 0 || cf.size === 0) return false;
  for (const a of sf) {
    for (const b of cf) {
      if (a === b) continue;
      if (INCOMPATIBLE_VERB_FAMILY_PAIRS.has(`${a}\0${b}`) && !sf.has(b) && !cf.has(a)) {
        return true;
      }
    }
  }
  return false;
}

function hasVisibilityConflict(a, b) {
  const pa = PRIVATE_VISIBILITY_RE.test(a);
  const pb = PRIVATE_VISIBILITY_RE.test(b);
  const ua = PUBLIC_VISIBILITY_RE.test(a);
  const ub = PUBLIC_VISIBILITY_RE.test(b);
  return (pa && ub) || (ua && pb);
}

function concreteTargetEntities(text) {
  const cleaned = normalize(text).replace(REPO_SETUP_STRIP_RE, ' ').replace(/\s+/g, ' ').trim();
  const entities = new Set();
  for (const m of cleaned.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = m[0];
    if (run.length >= 4) {
      entities.add(run);
      for (let i = 0; i <= run.length - 4; i += 1) {
        entities.add(run.slice(i, i + 4));
      }
    }
  }
  for (const m of cleaned.matchAll(/[a-z0-9][a-z0-9_.-]{2,}/g)) {
    entities.add(m[0]);
  }
  return { cleaned, entities };
}

const GENERIC_REPO_WORDS = new Set([
  'private', 'public', 'non-public', 'nonpublic', 'unlisted', 'local', 'internal', 'repo', 'repository', 'code', 'source', 'git', 'remote', 'push', 'the', 'and', 'to', 'into', 'for',
]);
const STAGE_LABEL_ENTITY_RE = /^(?:phase|stage|round|cycle|batch|step|turn|iteration)\d+$/i;

function extraNamedEntitiesMatched(srcText, claimText) {
  const sNorm = normApprovalInflections(srcText);
  const cNorm = normApprovalInflections(claimText);
  for (const m of cNorm.matchAll(/[a-z0-9][a-z0-9_.-]{2,}/g)) {
    const tok = m[0];
    if (GENERIC_REPO_WORDS.has(tok) || STAGE_LABEL_ENTITY_RE.test(tok)) continue;
    if (!sNorm.includes(tok)) return false;
  }
  return true;
}

function repoSetupParaphraseMatch(srcCore, claimCore) {
  const sf = verbFamiliesOf(srcCore);
  const cf = verbFamiliesOf(claimCore);
  if (!sf.has('repo_setup') || !cf.has('repo_setup')) return false;
  if (hasVisibilityConflict(srcCore, claimCore)) return false;
  if (!extraNamedEntitiesMatched(srcCore, claimCore)) return false;
  const a = concreteTargetEntities(srcCore);
  const b = concreteTargetEntities(claimCore);
  const hasSharedContainer =
    (/(?:仓库|代码库|库|\brepo(?:sitory)?\b)/i.test(srcCore) && /(?:仓库|代码库|库|\brepo(?:sitory)?\b)/i.test(claimCore)) ||
    (/(?:目录|文件夹|\bfolder\b|\bdir(?:ectory)?\b)/i.test(srcCore) && /(?:目录|文件夹|\bfolder\b|\bdir(?:ectory)?\b)/i.test(claimCore));
  if (hasSharedContainer && PRIVATE_VISIBILITY_RE.test(srcCore) && PRIVATE_VISIBILITY_RE.test(claimCore)) {
    return true;
  }
  for (const ent of a.entities) {
    if (ent.length >= 4 && b.entities.has(ent)) {
      if (/^(?:github|gitlab|gitee|bitbucket|private|local|internal)$/i.test(ent)) {
        if (hasSharedContainer) return true;
        continue;
      }
      return true;
    }
  }
  return false;
}

function samePushDirectiveMatch(srcCore, claimCore) {
  const sf = verbFamiliesOf(srcCore);
  const cf = verbFamiliesOf(claimCore);
  if (!sf.has('publish') || !cf.has('publish')) return false;
  if (hasVisibilityConflict(srcCore, claimCore)) return false;
  if (!extraNamedEntitiesMatched(srcCore, claimCore)) return false;
  const hasPush = (s) => /(?:推送|推上去|\bpush\b)/i.test(s);
  const hasCode = (s) => /(?:代码|源码|\bcode\b|\bsource\b)/i.test(s);
  return hasPush(srcCore) && hasPush(claimCore) && hasCode(srcCore) && hasCode(claimCore);
}

const QUALIFYING_SCOPE_RE =
  /(?:测试|生产|预发|本地|线上|正式|(?<![a-z])(?:staging|prod(?:uction)?|dev(?:elopment)?|local|test(?:ing)?)(?![a-z]))/i;
const QUALIFYING_EXCEPTION_RE =
  /(?:除了|除外|不含|不包括|不涉及|\b(?:except|excluding|without)\b)/i;
const QUALIFYING_CONDITIONAL_RE =
  /(?:如果|倘若|假如|除非|只有|仅当|前提|前置|\b(?:if|unless|only)\b)/i;

const PROVENANCE_CONDITIONAL_CUE_RE =
  /(?:如果|倘若|假如|除非|只有|仅当|\b(?:if|unless|only\s+(?:if|when|after))\b)/i;
const PROVENANCE_TRAILING_ADVISORY_RE =
  /(?<=[)）])\s*(?=注意|切记|提醒|记得|别忘了)/;

function extractClosedParens(text) {
  const value = String(text ?? '');
  if (!/[（(]/.test(value)) return [];
  const opens = [];
  const spans = [];
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '（' || ch === '(') {
      opens.push({ ch, index: i });
    } else if (ch === '）' || ch === ')') {
      const expected = ch === '）' ? '（' : '(';
      if (opens.length > 0 && opens.at(-1).ch === expected) {
        const open = opens.pop();
        if (opens.length === 0) {
          spans.push({ start: open.index, end: i + 1, inner: value.slice(open.index + 1, i) });
        }
      }
    }
  }
  return spans;
}

function scopeKeysOf(text) {
  const keys = new Set();
  const str = String(text ?? '');
  if (/(?:生产|线上|正式|(?<![a-z])prod(?:uction)?(?![a-z]))/i.test(str)) keys.add('prod');
  if (/(?:预发(?:布)?|(?<![a-z])staging(?![a-z]))/i.test(str)) keys.add('staging');
  if (/(?:测试|(?<![a-z])test(?:ing)?(?![a-z]))/i.test(str)) keys.add('test');
  if (/(?:本地|(?<![a-z])local(?![a-z]))/i.test(str)) keys.add('local');
  if (/(?<![a-z])dev(?:elopment)?(?![a-z])/i.test(str)) keys.add('dev');
  return keys;
}

function nonParenScopeKeysOf(text) {
  const keys = new Set();
  const str = String(text ?? '');
  if (/(?:生产|线上|正式|(?<![a-z])prod(?:uction)?(?![a-z]))/i.test(str)) keys.add('prod');
  if (/(?:预发(?:布)?|(?<![a-z])staging(?![a-z]))/i.test(str)) keys.add('staging');
  if (/(?:测试环境|仅测试|(?<![a-z])test\s+env(?:ironment)?(?![a-z]))/i.test(str)) keys.add('test');
  if (/(?:本地环境|仅本地|(?<![a-z])local\s+env(?:ironment)?(?![a-z]))/i.test(str)) keys.add('local');
  if (/(?:开发环境|(?<![a-z])dev(?:elopment)?\s+env(?:ironment)?(?![a-z]))/i.test(str)) keys.add('dev');
  return keys;
}

function isQualifyingParenBody(inner) {
  const body = String(inner ?? '').trim();
  if (!body) return false;
  if (QUALIFYING_SCOPE_RE.test(body)) return true;
  if (QUALIFYING_EXCEPTION_RE.test(body) || exceptionTarget(body) !== null) return true;
  if (numericFacts(body).length > 0) return true;
  if (QUALIFYING_CONDITIONAL_RE.test(body)) return true;
  if (PRIVATE_VISIBILITY_RE.test(body) || PUBLIC_VISIBILITY_RE.test(body)) return true;
  if (negationsOf(body).length > 0) return true;
  if (allTransferPairs(body).length > 0) return true;
  return false;
}

function stripNonQualifyingParens(text) {
  const value = String(text ?? '');
  const spans = extractClosedParens(value);
  if (spans.length === 0) return value;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += value.slice(cursor, span.start);
    if (isQualifyingParenBody(span.inner)) {
      out += value.slice(span.start, span.end);
    } else {
      out += ' ';
    }
    cursor = span.end;
  }
  out += value.slice(cursor);
  return out.replace(/\s+/g, ' ').trim();
}

const BARE_APPROVAL_VERB_RE =
  /^(?:(?:去|继续)\s*)?(?:发布|上线|部署|删除|删掉|移除|清理|清除|执行|运行|重跑|启动|调用|写入|写进|修改|更改|更新|覆盖|推送|推上去|创建|新建|建立|安装|配置|publish|release|deploy|ship|delete|remove|drop|purge|rm|run|exec|execute|write|edit|modify|update|push|create|make|install)$/i;
const APPROVAL_LEADING_VERB_RE =
  /^(?:发布|上线|部署|删除|删掉|移除|清理|清除|执行|运行|重跑|启动|调用|写入|写进|修改|更改|更新|覆盖|推送|推上去|创建|新建|建立|安装|配置|publish|release|deploy|ship|delete|remove|drop|purge|rm|run|exec|execute|write|edit|modify|update|push|create|make|install)(?:\s+|$|(?=[\u4e00-\u9fffa-z0-9（(]))/i;
const GENERIC_RELEASE_OBJECT_RE =
  /^(?:更新|新版|新版本|版本|变更|改动|(?:the\s+|this\s+|new\s+)?(?:updates?|releases?|changes?))$/i;

function isBareApprovalVerb(core) {
  const value = normalize(core)
    .replace(/[。.!！?？;；，,…]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return false;
  return BARE_APPROVAL_VERB_RE.test(value) || BARE_APPROVAL_VERB_RE.test(normApprovalInflections(value));
}

function hasConcreteApprovalObject(strippedSCore) {
  let rest = normalize(strippedSCore)
    .replace(/[。.!！?？;；，,…]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!rest) return false;
  const inflected = normApprovalInflections(rest);
  if (APPROVAL_LEADING_VERB_RE.test(rest)) {
    rest = rest.replace(APPROVAL_LEADING_VERB_RE, '').trim();
  } else if (APPROVAL_LEADING_VERB_RE.test(inflected)) {
    rest = inflected.replace(APPROVAL_LEADING_VERB_RE, '').trim();
  } else {
    rest = rest
      .replace(/^(?:把|将)\s*/, '')
      .replace(/(?:发布|上线|部署|删除|删掉|移除|清理|清除|执行|运行|写入|修改|更改|更新|推送|创建|新建)$/, '')
      .trim();
  }
  if (!rest) return false;
  return !GENERIC_RELEASE_OBJECT_RE.test(rest);
}

function checkSentenceScopeAndQualifiers(srcClause, srcCore, claimSentence) {
  const srcNonParenScope = nonParenScopeKeysOf(srcClause);
  const claimAllScope = scopeKeysOf(claimSentence);
  for (const k of srcNonParenScope) {
    if (!claimAllScope.has(k)) return false;
  }
  for (const k of claimAllScope) {
    if (/^(?:prod|staging)$/.test(k) && !scopeKeysOf(srcClause).has(k)) return false;
  }
  const punctNormSCore = normalize(srcCore).replace(/[、，,]+/g, ' ').replace(/\s+/g, ' ').trim();
  const strippedSCore = stripNonQualifyingParens(punctNormSCore);
  const claimNorm = normalize(claimSentence);
  for (const span of extractClosedParens(strippedSCore)) {
    const inner = span.inner.trim();
    if (!inner) continue;
    for (const k of scopeKeysOf(inner)) {
      if (!claimAllScope.has(k)) return false;
    }
    if (QUALIFYING_CONDITIONAL_RE.test(inner)) {
      if (!QUALIFYING_CONDITIONAL_RE.test(claimSentence) || coverageOf(inner, claimNorm) < 0.7) {
        return false;
      }
    }
    const innerNegView = inner.replace(/(?:不公开|非公开)/g, ' ');
    if (negationsOf(innerNegView).length > 0) {
      if (negationsOf(claimSentence).length === 0 || coverageOf(inner, claimNorm) < 0.7) {
        return false;
      }
    }
    if (PRIVATE_VISIBILITY_RE.test(inner) && !PRIVATE_VISIBILITY_RE.test(claimSentence)) return false;
    if (PUBLIC_VISIBILITY_RE.test(inner) && !PUBLIC_VISIBILITY_RE.test(claimSentence)) return false;
  }
  return !(PROVENANCE_CONDITIONAL_CUE_RE.test(srcClause) && !PROVENANCE_CONDITIONAL_CUE_RE.test(claimSentence));
}

function checkClaimParensCovered(srcClause, targetText) {
  const punctNormSrcClause = normalize(stripSeqCitationsForApproval(srcClause))
    .replace(/[、，,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const span of extractClosedParens(targetText)) {
    const inner = span.inner.trim();
    if (!inner) continue;
    const innerNorm = inner.replace(/[、，,]+/g, ' ').replace(/\s+/g, ' ').trim();
    const cov = Math.max(
      coverageOf(innerNorm, punctNormSrcClause),
      coverageOf(normApprovalInflections(innerNorm), normApprovalInflections(punctNormSrcClause)),
    );
    if (cov < 0.75) return false;
  }
  return true;
}

function approvalTargetsMatch(srcCore, srcClause, claimCore, claimSentence, { isRevocation = false } = {}) {
  const sCore = isRevocation ? srcCore : stripTemporalDirectiveLead(srcCore);
  const cCore = isRevocation ? claimCore : stripTemporalDirectiveLead(claimCore);
  if (!sCore || !cCore) return false;
  if (!scopesCompatible(srcClause, claimSentence)) return false;
  const sDirs = allTransferPairs(sCore);
  const cDirs = allTransferPairs(cCore);
  const srcPairs = sDirs.length ? sDirs : allTransferPairs(srcClause);
  const claimPairs = cDirs.length ? cDirs : allTransferPairs(claimSentence);
  if ((srcPairs.length > 0 || claimPairs.length > 0) && JSON.stringify(srcPairs) !== JSON.stringify(claimPairs)) {
    return false;
  }
  const sEx = exceptionTarget(sCore) ?? exceptionTarget(srcClause);
  const cEx = exceptionTarget(cCore) ?? exceptionTarget(claimSentence);
  if (isRevocation ? cEx && sEx !== cEx : (sEx || cEx) && sEx !== cEx) return false;

  const sNums = numericFacts(sCore);
  const cNums = numericFacts(cCore);
  const numsMatch = sNums.length === cNums.length && numericFactsEquivalent(sCore, cCore, sNums, cNums);
  if (isRevocation ? cNums.length > 0 && !numsMatch : !numsMatch) return false;
  if (!isRevocation && (hasIncompatibleVerbFamily(sCore, cCore) || hasVisibilityConflict(sCore, cCore))) {
    return false;
  }
  if (!isRevocation && !extraNamedEntitiesMatched(srcClause, cCore)) return false;

  const cleanSrcClause = normalize(stripSeqCitationsForApproval(srcClause));
  const punctNormSrcClause = cleanSrcClause.replace(/[、，,]+/g, ' ').replace(/\s+/g, ' ').trim();
  const strippedSrcClause = stripNonQualifyingParens(punctNormSrcClause);
  const strippedSCore = stripNonQualifyingParens(
    normalize(sCore).replace(/[、，,]+/g, ' ').replace(/\s+/g, ' ').trim(),
  );
  const punctNormCCore = normalize(cCore).replace(/[、，,]+/g, ' ').replace(/\s+/g, ' ').trim();

  if (!isRevocation) {
    if (!checkSentenceScopeAndQualifiers(srcClause, sCore, claimSentence)) return false;
    if (!checkClaimParensCovered(srcClause, cCore)) return false;
    if (verbFamiliesOf(cCore).has('delete') && !verbFamiliesOf(sCore).has('delete')) return false;
    if (isBareApprovalVerb(cCore) && hasConcreteApprovalObject(strippedSCore)) return false;
  }

  const sa = actionState(sCore) ?? actionState(strippedSCore);
  const ca = actionState(cCore);
  if (isRevocation && coverageOf(sEx ? stripException(sCore) : sCore, normalize(cCore)) >= 0.7) return true;
  if (sa && ca) {
    if (sa.negative !== ca.negative) return false;
    if (sameAction(sa, ca)) return true;
  }
  if (!isRevocation && (repoSetupParaphraseMatch(sCore, cCore) || samePushDirectiveMatch(sCore, cCore))) {
    return true;
  }
  if (sa && ca && sa.verb !== ca.verb) {
    const sf = verbFamiliesOf(sCore);
    const cf = verbFamiliesOf(cCore);
    if (cf.size > 0 && ![...sf].some((f) => cf.has(f))) return false;
  }
  for (const target of [cleanSrcClause, punctNormSrcClause, strippedSrcClause]) {
    if (
      coverageOf(cCore, target) >= 0.75 ||
      coverageOf(punctNormCCore, target) >= 0.75 ||
      coverageOf(normApprovalInflections(cCore), normApprovalInflections(target)) >= 0.75 ||
      coverageOf(normApprovalInflections(punctNormCCore), normApprovalInflections(target)) >= 0.75
    ) {
      return true;
    }
  }
  if (isRevocation) {
    const sf = verbFamiliesOf(sCore);
    const cf = verbFamiliesOf(cCore);
    if (sf.size > 0 && [...sf].some((f) => cf.has(f))) {
      const stripVerbAndTiming = (v) => {
        let out = normApprovalInflections(v);
        for (const [, re] of VERB_FAMILY_RES) {
          out = out.replace(new RegExp(re.source, 'gi'), ' ');
        }
        return out.replace(/\b(?:now|just|directly|today|please)\b|现在|直接|请/gi, ' ').replace(/\s+/g, ' ').trim();
      };
      const objA = stripVerbAndTiming(sCore);
      const objB = stripVerbAndTiming(cCore);
      if (objA && objB && (coverageOf(objA, objB) >= 0.75 || coverageOf(objB, objA) >= 0.75)) {
        return true;
      }
    }
  }
  return false;
}

function rawMessageText(m) {
  if (typeof m?.text === 'string') return m.text;
  if (Array.isArray(m?.blocks)) return m.blocks.map((b) => String(b?.text ?? '')).join('\n');
  if (typeof m?.content === 'string') return m.content;
  if (Array.isArray(m?.content)) {
    return m.content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n');
  }
  return '';
}

function splitCompoundClaimParts(claimCore) {
  const value = String(claimCore ?? '').trim();
  if (!value) return [];
  return value.split(COMPOUND_CLAIM_SPLIT_RE).map((p) => p.trim()).filter(Boolean);
}

const REPO_CONTEXT_FOR_PRIVATE_MOD_RE =
  /(?:仓库|代码库|源码|存放|github|gitlab|gitee|\brepo(?:s|sitor(?:y|ies))?\b)/i;
const REPO_PAREN_PRIVATE_MOD_RE =
  /[（(]\s*(?:(?:私有|私密|不公开|非公开|\b(?:private|non-?public|unlisted)\b)(?:\s*[、，,/]\s*|\s+))*(?:不公开|非公开)(?:(?:\s*[、，,/]\s*|\s+)(?:私有|私密|不公开|非公开|\b(?:private|non-?public|unlisted)\b))*\s*[)）]/gi;
const REPO_AFTER_VERB_PRIVATE_MOD_RE =
  /(?<=(?:仓库|代码库|存放|创建|新建|建立|放进|放入|放到|设为|设置为)(?:为|的|一个|个)?\s*)[不非]公开/g;

function stripRepoPrivateModifierForNegCheck(clause) {
  const value = String(clause ?? '');
  if (!REPO_CONTEXT_FOR_PRIVATE_MOD_RE.test(value)) return value;
  return value
    .replace(REPO_PAREN_PRIVATE_MOD_RE, ' ')
    .replace(REPO_AFTER_VERB_PRIVATE_MOD_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function maskBalancedParensForSplit(text, parens) {
  const value = String(text ?? '');
  const spans = extractClosedParens(value);
  if (spans.length === 0) return value;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += value.slice(cursor, span.start);
    parens.push(value.slice(span.start, span.end));
    out += `\uE002${parens.length - 1}\uE003`;
    cursor = span.end;
  }
  out += value.slice(cursor);
  return out;
}

function unmaskParens(text, parens) {
  return text.replace(/\uE002(\d+)\uE003/g, (_, idx) => parens[Number(idx)] ?? '');
}

function maskBackticksForSplit(text, literals) {
  return replaceInlineBackticks(String(text ?? ''), (part) => {
    literals.push(part);
    return `\uE004${literals.length - 1}\uE005`;
  });
}

function unmaskBackticks(text, literals) {
  return text.replace(/\uE004(\d+)\uE005/g, (_, idx) => literals[Number(idx)] ?? '');
}

function splitProvenanceClauses(sent) {
  const raw = String(sent ?? '').trim();
  if (!raw || /^\s*#{1,6}\s/.test(raw)) return [];
  if (conditionParts(raw) || PROVENANCE_CONDITIONAL_CUE_RE.test(raw)) return [raw];
  const codeLiterals = [];
  const codeMasked = maskBackticksForSplit(raw, codeLiterals);
  const parens = [];
  const parenMasked = maskBalancedParensForSplit(codeMasked, parens);
  const out = [];
  for (const piece of splitContrastClauses(parenMasked)) {
    const withParens = unmaskParens(piece, parens).trim();
    if (!withParens) continue;
    const unmaskedFull = unmaskBackticks(withParens, codeLiterals).trim();
    if (conditionParts(unmaskedFull) || PROVENANCE_CONDITIONAL_CUE_RE.test(unmaskedFull)) {
      out.push(unmaskedFull);
      continue;
    }
    for (const sub of withParens.split(PROVENANCE_TRAILING_ADVISORY_RE)) {
      const clean = unmaskBackticks(sub, codeLiterals).trim();
      if (clean) out.push(clean);
    }
  }
  return out;
}

const LEADING_APPROVAL_CLAIM_RE = new RegExp(`^(?:${APPROVAL_CLAIM_RE.source})`, 'i');
const PAREN_APPROVAL_CLAIM_RE = new RegExp(`[（(](?=[^（）()\\n]{0,60}?${APPROVAL_CLAIM_RE.source})`, 'i');

function extractParenWrappedClaim(cleanSentence) {
  const value = String(cleanSentence ?? '').trim();
  if (!value || LEADING_APPROVAL_CLAIM_RE.test(value)) return null;
  const match = PAREN_APPROVAL_CLAIM_RE.exec(value);
  if (!match) return null;
  const openIdx = match.index;
  const outerPrefix = value.slice(0, openIdx).trim();
  const openCh = value[openIdx];
  const closeCh = openCh === '（' ? '）' : ')';
  let depth = 1;
  let closeIdx = -1;
  for (let i = openIdx + 1; i < value.length; i += 1) {
    if (value[i] === openCh) depth += 1;
    else if (value[i] === closeCh) {
      depth -= 1;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx >= 0) {
    const trailing = value.slice(closeIdx + 1).trim();
    const inner = value.slice(openIdx + 1, closeIdx).trim();
    if (!inner) return null;
    if (!trailing || /^[。.!！?？;；…]+$/.test(trailing)) {
      return { outerPrefix, inner, trailingAfterColon: '' };
    }
    const colonMatch = /^(?:\*\*|__)?\s*[:：]\s*(.+)$/.exec(trailing);
    if (colonMatch && colonMatch[1].trim()) {
      return { outerPrefix, inner, trailingAfterColon: colonMatch[1].trim() };
    }
    return null;
  }
  const inner = value.slice(openIdx + 1).trim();
  return inner ? { outerPrefix, inner, trailingAfterColon: '' } : null;
}

function stripOuterAttributionPrefix(text) {
  return String(text ?? '')
    .replace(/\*\*|__/g, ' ')
    .replace(/^\s*(?:[-*•+]|\d+[.)]|[:：)）]+)+\s*/, '')
    .replace(
      /^(?:(?:phase|stage|round|cycle|batch|step|turn|iteration)\s*#?\d+|第\s*\d+\s*(?:轮|阶段|步|批))(?:\s*(?:于|在|at)\s*\d{1,2}:\d{2}(?::\d{2})?)?\s*/i,
      '',
    )
    .replace(/^(?:于|在)\s*\d{1,2}:\d{2}(?::\d{2})?\s*/, '')
    .replace(/[（(]+$/g, '')
    .replace(/[。.!！?？;；…]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isUntrustedSourceMessage(m) {
  return (
    isReferenceContextKind(m.sourceKind) ||
    Boolean(m.externalFold) ||
    isSystemReminderOnly(m) ||
    isReferencePrefixOnly(m)
  );
}

function collectUserGrantsAndRevocations(userMessages) {
  const verifiedMessages = userMessages
    .filter((m) => !isUntrustedSourceMessage(m))
    .slice()
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  let activeGrants = [];
  const revokedGrants = [];
  const pushGrant = (clause, core, seq = null) => {
    if (!core) return;
    activeGrants.push({ seq, clause, core });
    if (
      allTransferPairs(clause).length === 0 &&
      !conditionParts(clause) &&
      !exceptionTarget(clause) &&
      !/(?:如果|除非|只有|仅当|\bif\b|\bunless\b)/i.test(clause)
    ) {
      const parts = splitCompoundClaimParts(core);
      if (parts.length >= 2) {
        for (const part of parts) {
          const cleanPart = stripTemporalDirectiveLead(part);
          if (cleanPart) activeGrants.push({ seq, clause, core: cleanPart });
        }
      }
    }
  };

  for (const m of verifiedMessages) {
    const rawText = stripFencedCodeBlocks(instructionText(m));
    const msgEntries = [];
    let messageHasGrant = false;

    for (const sent of sourceEvidenceSentences(rawText)) {
      const cleanSent = stripSeqCitationsForApproval(sent).replace(/\*\*|__/g, '').trim();
      const sentQuestion = isPureQuestion(sent) || /[?？]\s*$/.test(sent.trim());
      const sentHasConditional = PROVENANCE_CONDITIONAL_CUE_RE.test(cleanSent);

      for (const clause of splitProvenanceClauses(sent)) {
        const cleanClause = stripSeqCitationsForApproval(clause).replace(/\*\*|__/g, '').trim();
        const exTarget = exceptionTarget(cleanClause);
        const clauseNegView = stripRepoPrivateModifierForNegCheck(
          exTarget ? stripException(cleanClause) : cleanClause,
        );
        const clauseQuestion = sentQuestion || isPureQuestion(clause) || /[?？]\s*$/.test(clause.trim());
        const isFormalClaim = APPROVAL_CLAIM_RE.test(cleanClause) || DIRECT_USER_APPROVAL_RE.test(cleanClause);
        const isStandaloneCancel = STANDALONE_COLLOQUIAL_CANCEL_RE.test(cleanClause);
        const isRevoke =
          REVOCATION_APPROVAL_RE.test(cleanClause) ||
          COLLOQUIAL_REVOCATION_RE.test(cleanClause) ||
          isStandaloneCancel ||
          (isFormalClaim && isNegatedOrPendingApproval(cleanClause));
        if (isRevoke) {
          if (isStandaloneCancel && !REVOCATION_APPROVAL_RE.test(cleanClause)) {
            if (activeGrants.length > 0) {
              const lastGrantSeq = activeGrants.at(-1).seq;
              const revokedFromLast = activeGrants.filter((g) => g.seq === lastGrantSeq);
              for (const g of revokedFromLast) {
                revokedGrants.push({ seq: m.seq, clause: g.clause, core: g.core });
              }
              activeGrants = activeGrants.filter((g) => g.seq !== lastGrantSeq);
            } else {
              revokedGrants.push({ seq: m.seq, clause: cleanClause, core: '' });
            }
            msgEntries.push({ clause, cleanClause, kind: 'revoke' });
            continue;
          }
          const revCore = stripRevocationBoilerplate(cleanClause);
          revokedGrants.push({ seq: m.seq, clause: cleanClause, core: revCore });
          activeGrants = activeGrants.filter((g) => {
            if (!scopesCompatible(cleanClause, g.clause)) return true;
            if (!revCore) return false;
            return !approvalTargetsMatch(g.core, g.clause, revCore, cleanClause, { isRevocation: true });
          });
          msgEntries.push({ clause, cleanClause, kind: 'revoke' });
          continue;
        }
        const isFormalGrant = !clauseQuestion && isFormalClaim && !isNegatedOrPendingApproval(cleanClause);
        const isColloquialGrant =
          !clauseQuestion &&
          !sentHasConditional &&
          !isNegatedOrPendingApproval(cleanClause) &&
          !ruleNegative(clauseNegView) &&
          !COLLOQUIAL_NON_GRANT_RE.test(cleanClause) &&
          COLLOQUIAL_USER_APPROVAL_RE.test(cleanClause);
        if (isFormalGrant || isColloquialGrant) {
          messageHasGrant = true;
          pushGrant(cleanClause, stripGrantBoilerplate(cleanClause), m.seq);
          msgEntries.push({ clause, cleanClause, kind: 'grant' });
          continue;
        }
        if (!clauseQuestion && !sentHasConditional && STANDALONE_AFFIRMATION_RE.test(cleanClause)) {
          messageHasGrant = true;
          msgEntries.push({ clause, cleanClause, kind: 'affirmation' });
          continue;
        }
        const isDirectImperative =
          !clauseQuestion &&
          !sentHasConditional &&
          !isNegatedOrPendingApproval(cleanClause) &&
          !ruleNegative(clauseNegView) &&
          !COLLOQUIAL_NON_GRANT_RE.test(cleanClause) &&
          !conditionParts(cleanClause) &&
          !ADVISORY_OR_OBSERVATION_PREFIX_RE.test(cleanClause) &&
          !RETROSPECTIVE_GRANT_PREFIX_RE.test(cleanClause) &&
          DIRECT_IMPERATIVE_GRANT_RE.test(cleanClause) &&
          ACTION_DIRECTIVE_RE.test(cleanClause);
        if (isDirectImperative) {
          messageHasGrant = true;
          const core = stripGrantBoilerplate(cleanClause);
          if (core) pushGrant(cleanClause, core, m.seq);
          msgEntries.push({ clause, cleanClause, kind: 'grant' });
          continue;
        }
        msgEntries.push({ clause, cleanClause, kind: 'other', clauseQuestion, sentHasConditional });
      }
    }

    if (messageHasGrant) {
      for (const entry of msgEntries) {
        if (entry.kind !== 'other' || entry.clauseQuestion || entry.sentHasConditional) continue;
        const { cleanClause } = entry;
        const exTarget = exceptionTarget(cleanClause);
        const clauseNegView = stripRepoPrivateModifierForNegCheck(
          exTarget ? stripException(cleanClause) : cleanClause,
        );
        if (!cleanClause || ruleNegative(clauseNegView) || isNegatedOrPendingApproval(cleanClause)) continue;
        if (COLLOQUIAL_NON_GRANT_RE.test(cleanClause) || conditionParts(cleanClause)) continue;
        if (ADVISORY_OR_OBSERVATION_PREFIX_RE.test(cleanClause) || RETROSPECTIVE_GRANT_PREFIX_RE.test(cleanClause)) continue;
        if (!ACTION_DIRECTIVE_RE.test(cleanClause)) continue;
        const core = stripGrantBoilerplate(cleanClause);
        if (core) pushGrant(cleanClause, core, m.seq);
      }
    }
  }

  return { activeGrants, revokedGrants };
}

function splitApprovalClaimActions(claimCore) {
  const value = String(claimCore ?? '').trim();
  if (!value) return [];
  if (allTransferPairs(value).length > 0) return [value];
  const parts = splitCompoundClaimParts(value);
  return parts.length >= 2 ? parts : [value];
}

function passesCitedGrantGuards(g, targetText, cleanSentence) {
  if (!targetText) return false;
  if (!scopesCompatible(g.clause, cleanSentence)) return false;
  if (!checkSentenceScopeAndQualifiers(g.clause, g.core, cleanSentence)) return false;
  if (ruleNegative(targetText)) return false;
  if (hasVisibilityConflict(g.clause, cleanSentence)) return false;
  if (hasIncompatibleVerbFamily(g.core, targetText)) return false;
  const sf = verbFamiliesOf(g.core);
  const cf = verbFamiliesOf(targetText);
  if (cf.has('delete') && !sf.has('delete')) return false;
  if (sf.size === 0 || ![...sf].some((f) => cf.has(f))) return false;
  const srcPairs = allTransferPairs(g.core);
  const srcAllPairs = srcPairs.length ? srcPairs : allTransferPairs(g.clause);
  const claimPairs = allTransferPairs(targetText);
  const claimAllPairs = claimPairs.length ? claimPairs : allTransferPairs(cleanSentence);
  if ((srcAllPairs.length > 0 || claimAllPairs.length > 0) && JSON.stringify(srcAllPairs) !== JSON.stringify(claimAllPairs)) {
    return false;
  }
  const sEx = exceptionTarget(g.core) ?? exceptionTarget(g.clause);
  const cEx = exceptionTarget(targetText) ?? exceptionTarget(cleanSentence);
  if ((sEx || cEx) && sEx !== cEx) return false;
  const sNums = numericFacts(g.core);
  const cNums = numericFacts(targetText);
  const numsMatch = sNums.length === cNums.length && numericFactsEquivalent(g.core, targetText, sNums, cNums);
  if (!numsMatch) return false;
  if (!extraNamedEntitiesMatched(g.clause, targetText)) return false;
  if (!checkClaimParensCovered(g.clause, targetText)) return false;
  const grantAction = (actionState(g.core)?.verb || g.core).trim();
  if (grantAction.length < 2) return false;
  return coverageOf(normApprovalInflections(grantAction), normApprovalInflections(targetText)) >= 0.85;
}

function passesTrailingCompanionGuards(g, trailingRaw, trailingClean) {
  const checkStr = trailingClean || trailingRaw;
  if (!checkStr) return false;
  if (ruleNegative(trailingRaw) || ruleNegative(checkStr)) return false;
  if (!scopesCompatible(g.clause, checkStr)) return false;
  for (const k of scopeKeysOf(checkStr)) {
    if (/^(?:prod|staging)$/.test(k) && !scopeKeysOf(g.clause).has(k)) return false;
  }
  if (hasVisibilityConflict(g.clause, checkStr)) return false;
  if (hasIncompatibleVerbFamily(g.core, checkStr)) return false;
  const sf = verbFamiliesOf(g.core);
  const tf = verbFamiliesOf(checkStr);
  if (tf.has('delete') && !sf.has('delete')) return false;
  if (tf.has('publish') && !sf.has('publish')) return false;
  if (tf.has('write') && !sf.has('write')) return false;
  const sNums = numericFacts(g.core);
  const tNums = numericFacts(checkStr);
  if (sNums.length !== tNums.length || !numericFactsEquivalent(g.core, checkStr, sNums, tNums)) return false;
  const srcPairs = allTransferPairs(g.core);
  const srcAllPairs = srcPairs.length ? srcPairs : allTransferPairs(g.clause);
  const tailPairs = allTransferPairs(checkStr);
  if (tailPairs.length > 0 && JSON.stringify(srcAllPairs) !== JSON.stringify(tailPairs)) return false;
  const sEx = exceptionTarget(g.core) ?? exceptionTarget(g.clause);
  const tEx = exceptionTarget(checkStr);
  if (tEx && sEx !== tEx) return false;
  if (!extraNamedEntitiesMatched(g.clause, checkStr)) return false;
  if (!checkClaimParensCovered(g.clause, checkStr)) return false;
  // Existing timing-only start-task citations may carry a descriptive task
  // label. Concrete grants must cover the companion's action and target.
  const genericStart = /^(?:提前|继续|直接|现在)*(?:开始|开跑|开工|启动)(?:任务|工作)?$/u.test(normApprovalInflections(g.core));
  if (genericStart && /(?:开始|开跑|开工|启动|数据抓取)/u.test(checkStr) && !/[a-z]/i.test(checkStr)) return true;
  return passesCitedGrantGuards(g, checkStr, checkStr);
}

function matchesCitedSeqGrant(activeGrants, citedSeqs, cleanSentence, claimCore, parenWrapped, precedingActionCore = '', precedingSentence = '') {
  if (citedSeqs.size === 0) return false;
  const citedGrants = activeGrants.filter((g) => Number.isSafeInteger(g.seq) && citedSeqs.has(g.seq));
  if (citedGrants.length === 0) return false;
  const trailingRaw = parenWrapped?.trailingAfterColon ?? '';
  const trailingTarget = trailingRaw ? stripOuterAttributionPrefix(trailingRaw) : '';
  const outerTarget = parenWrapped?.outerPrefix ? stripOuterAttributionPrefix(parenWrapped.outerPrefix) : '';
  const defaultTarget = trailingTarget || stripOuterAttributionPrefix(claimCore);

  const matchesCitedTarget = (targetText) => {
    const cleanTarget = String(targetText ?? '').trim();
    if (!cleanTarget) return false;
    const actions = splitApprovalClaimActions(cleanTarget);
    if (actions.length === 0) return false;
    return actions.every((act) => citedGrants.some((g) => passesCitedGrantGuards(g, act, cleanSentence)));
  };

  if (!claimCore && !parenWrapped) {
    // A bare citation with no explicit target cannot self-authorize in isolation
    // or attach to an unrelated/ungranted preceding action (including headings).
    return citedGrants.some((g) => {
      if (!precedingActionCore || ruleNegative(precedingSentence) || !scopesCompatible(g.clause, cleanSentence)) {
        return false;
      }
      return approvalTargetsMatch(g.core, g.clause, precedingActionCore, precedingSentence);
    });
  }
  if (defaultTarget && matchesCitedTarget(defaultTarget)) {
    return true;
  }
  if (trailingRaw && outerTarget && outerTarget !== defaultTarget) {
    const trailingActions = splitApprovalClaimActions(trailingTarget || trailingRaw);
    return (
      matchesCitedTarget(outerTarget) &&
      trailingActions.length > 0 &&
      trailingActions.every((part) => citedGrants.some((g) => passesTrailingCompanionGuards(g, part, part)))
    );
  }
  return false;
}

function matchesUntrustedReference(untrustedRefs, claimCore, cleanSentence, unbackedParts) {
  const claimCoreTokens = claimCore ? coverageTokens(claimCore) : [];
  for (const ref of untrustedRefs) {
    const refRaw = String(ref.text ?? '');
    for (const rcSent of sourceEvidenceSentences(stripFencedCodeBlocks(refRaw))) {
      for (const rc of splitProvenanceClauses(rcSent)) {
        const cleanRc = stripSeqCitationsForApproval(rc);
        if (isNegatedOrPendingApproval(cleanRc)) continue;
        if (
          !(
            APPROVAL_CLAIM_RE.test(cleanRc) ||
            DIRECT_USER_APPROVAL_RE.test(cleanRc) ||
            COLLOQUIAL_USER_APPROVAL_RE.test(cleanRc) ||
            UNTRUSTED_APPROVAL_SIGNAL_RE.test(cleanRc)
          )
        ) {
          continue;
        }
        const rcCore = stripGrantBoilerplate(cleanRc);
        if (!claimCore) {
          if (!rcCore || APPROVAL_CLAIM_RE.test(cleanRc) || DIRECT_USER_APPROVAL_RE.test(cleanRc)) {
            return { matched: true, matchedSeq: ref.seq };
          }
          continue;
        }
        if (!rcCore) continue;
        const targetHit =
          approvalTargetsMatch(rcCore, cleanRc, claimCore, cleanSentence) ||
          unbackedParts.some((part) => approvalTargetsMatch(rcCore, cleanRc, part, cleanSentence)) ||
          (claimCoreTokens.length > 0 && coverageOf(claimCore, normalize(cleanRc)) >= 0.5) ||
          unbackedParts.some((part) => coverageTokens(part).length > 0 && coverageOf(part, normalize(cleanRc)) >= 0.5);
        if (targetHit) {
          return { matched: true, matchedSeq: ref.seq };
        }
      }
    }
  }
  return { matched: false, matchedSeq: null };
}

function matchesRevokedGrant(revokedGrants, claimCore, cleanSentence, unbackedParts) {
  return revokedGrants.some((r) => {
    if (!scopesCompatible(r.clause, cleanSentence)) return false;
    if (!r.core) return true;
    return (
      approvalTargetsMatch(r.core, r.clause, claimCore, cleanSentence, { isRevocation: true }) ||
      unbackedParts.some((part) => approvalTargetsMatch(r.core, r.clause, part, cleanSentence, { isRevocation: true }))
    );
  });
}

/**
 * Channel-based compaction laundering defense:
 * rejects summary claims of user approval/authorization unless a matching,
 * unrevoked verified user channel approval backs that specific action/scope.
 */
export function auditInstructionProvenance({ userMessages = [], referenceMessages = [], retiredDecisions = [], summaryText }) {
  const { activeGrants: rawActiveGrants, revokedGrants } = collectUserGrantsAndRevocations(userMessages);
  const cancelledSeqs = new Set();
  for (const decision of retiredDecisions) {
    if (decision?.reason !== 'cancelled') continue;
    if (Number.isSafeInteger(decision.seq)) cancelledSeqs.add(decision.seq);
    if (typeof decision.text !== 'string' || !decision.text.trim()) continue;
    revokedGrants.push({ seq: decision.by, clause: decision.text, core: stripGrantBoilerplate(decision.text) });
  }
  const activeGrants = rawActiveGrants.filter((g) => {
    if (Number.isSafeInteger(g.seq) && cancelledSeqs.has(g.seq)) return false;
    return !revokedGrants.some((r) => {
      if (!Number.isSafeInteger(r.seq) || !Number.isSafeInteger(g.seq) || r.seq <= g.seq) return false;
      if (!scopesCompatible(r.clause, g.clause)) return false;
      if (!r.core) return true;
      return approvalTargetsMatch(g.core, g.clause, r.core, r.clause, { isRevocation: true });
    });
  });

  const untrustedRefs = [
    ...userMessages.flatMap((m) =>
      (isUntrustedSourceMessage(m) ? [rawMessageText(m)] : referenceTexts(m)).map((text) => ({ seq: m.seq, text })),
    ),
    ...referenceMessages.map((m) => ({ seq: m.seq ?? -1, text: m.text })),
  ];
  const refSeq =
    untrustedRefs.find((r) => {
      const clean = stripSeqCitationsForApproval(r.text);
      return (
        !isNegatedOrPendingApproval(clean) &&
        (APPROVAL_CLAIM_RE.test(clean) || DIRECT_USER_APPROVAL_RE.test(clean) || UNTRUSTED_APPROVAL_SIGNAL_RE.test(clean))
      );
    })?.seq ??
    untrustedRefs[0]?.seq ??
    -1;

  const grantMatchesClaim = (claimCore, claimSentence, outerPrefix = '') =>
    activeGrants.some((g) => {
      if (!scopesCompatible(g.clause, claimSentence)) return false;
      if (outerPrefix) {
        const of = verbFamiliesOf(outerPrefix);
        const sf = verbFamiliesOf(g.core);
        if (
          ruleNegative(outerPrefix) ||
          hasIncompatibleVerbFamily(g.core, outerPrefix) ||
          (of.has('delete') && !sf.has('delete')) ||
          (sf.size === 0 && (of.has('delete') || of.has('publish') || of.has('write'))) ||
          !extraNamedEntitiesMatched(g.clause, outerPrefix)
        ) {
          return false;
        }
      }
      if (!claimCore) return false;
      return approvalTargetsMatch(g.core, g.clause, claimCore, claimSentence);
    });

  const lost = [];
  const summarySentences = sourceEvidenceSentences(stripFencedCodeBlocks(summaryText ? summaryProse(summaryText) : ''));
  for (let si = 0; si < summarySentences.length; si += 1) {
    const rawSent = summarySentences[si];
    const clauses = splitProvenanceClauses(rawSent);
    for (let ci = 0; ci < clauses.length; ci += 1) {
      const sentence = clauses[ci];
      const cleanSentence = stripSeqCitationsForApproval(sentence);
      if (!APPROVAL_CLAIM_RE.test(cleanSentence)) continue;
      if (isNegatedOrPendingApproval(cleanSentence)) continue;

      const claimCore = stripApprovalBoilerplate(cleanSentence);
      if (grantMatchesClaim(claimCore, cleanSentence)) continue;

      const precedingSentence = ci > 0 ? clauses[ci - 1] : (summarySentences[si - 1] ?? '');
      const precedingClean = !claimCore ? precedingSentence.replace(/^\s*#{1,6}\s+/, '') : '';
      const precedingCore = precedingClean ? stripGrantBoilerplate(precedingClean) : '';
      const precedingActionCore = precedingCore &&
        (verbFamiliesOf(precedingCore).size > 0 || actionState(precedingCore) || ACTION_DIRECTIVE_RE.test(precedingCore))
        ? precedingCore : '';
      if (
        !claimCore && precedingActionCore &&
        !ruleNegative(precedingSentence) &&
        grantMatchesClaim(precedingActionCore, precedingSentence)
      ) continue;

      const parenWrapped = extractParenWrappedClaim(cleanSentence);
      const innerClaimCore = parenWrapped ? stripApprovalBoilerplate(parenWrapped.inner) : '';
      if (innerClaimCore) {
        if (grantMatchesClaim(innerClaimCore, cleanSentence, parenWrapped.outerPrefix)) continue;
        const innerHasTransfer =
          allTransferPairs(parenWrapped.inner).length > 0 || allTransferPairs(innerClaimCore).length > 0;
        if (!innerHasTransfer) {
          const innerParts = splitCompoundClaimParts(innerClaimCore);
          if (
            innerParts.length >= 2 &&
            innerParts.every((part) => grantMatchesClaim(part, cleanSentence, parenWrapped.outerPrefix))
          ) {
            continue;
          }
        }
      } else if (parenWrapped) {
        const outerPart = stripOuterAttributionPrefix(parenWrapped.outerPrefix);
        const colonPart = parenWrapped.trailingAfterColon ? stripOuterAttributionPrefix(parenWrapped.trailingAfterColon) : '';
        const attrTarget = colonPart || outerPart;
        if (attrTarget && grantMatchesClaim(attrTarget, cleanSentence, parenWrapped.outerPrefix)) continue;
      }

      if (matchesCitedSeqGrant(activeGrants, candidateSeqCitations(sentence), cleanSentence, claimCore, parenWrapped, precedingActionCore, precedingSentence)) {
        continue;
      }

      let unbackedParts = claimCore ? [claimCore] : [];
      const hasTransfer = allTransferPairs(cleanSentence).length > 0 || allTransferPairs(claimCore).length > 0;
      if (claimCore && !hasTransfer) {
        const parts = splitCompoundClaimParts(claimCore);
        if (parts.length >= 2) {
          const missing = parts.filter((part) => !grantMatchesClaim(part, cleanSentence));
          if (missing.length === 0) continue;
          unbackedParts = missing;
        }
      }
      if (innerClaimCore && !unbackedParts.includes(innerClaimCore)) {
        unbackedParts = [...unbackedParts, innerClaimCore];
      }

      const untrusted = matchesUntrustedReference(untrustedRefs, claimCore, cleanSentence, unbackedParts);
      const revokedMatch = matchesRevokedGrant(revokedGrants, claimCore, cleanSentence, unbackedParts);
      lost.push({
        seq: untrusted.matchedSeq ?? refSeq,
        line: sentence,
        candidate: sentence,
        coverage: 0,
        reason: 'provenance',
        untrustedSourceMatch: untrusted.matched,
        revokedMatch,
      });
    }
  }
  return lost;
}

export function sanitizeProvenanceExcerpt(text, maxLen = 160) {
  const cleaned = redactCredentials(String(text ?? ''), {
    pemReplacement: '[redacted-private-key]',
    tokenReplacement: '[redacted]',
  })
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

/** Summarize provenance audit findings into hard (untrusted/revoked) vs soft diagnostics. */
export function summarizeProvenanceFailures(provenanceLost) {
  const items = Array.isArray(provenanceLost) ? provenanceLost : [];
  const hardProvenance = items.filter((item) => item?.untrustedSourceMatch === true || item?.revokedMatch === true);
  const softProvenance = items.filter((item) => !(item?.untrustedSourceMatch === true || item?.revokedMatch === true));
  const first = hardProvenance[0] ?? softProvenance[0] ?? null;
  const provenanceKind = first?.untrustedSourceMatch
    ? 'untrusted-source'
    : first?.revokedMatch
      ? 'revoked'
      : 'missing-source';
  const provenanceLine = sanitizeProvenanceExcerpt(first?.line ?? first?.candidate ?? '');
  return { hardProvenance, softProvenance, provenanceKind, provenanceLine };
}
