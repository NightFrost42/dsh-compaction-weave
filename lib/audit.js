import { summaryProse } from './validate.js';
import {isReferenceContextKind} from './source-provenance.js';
// 约束丢失审计：零 LLM 调用。
//
// 思路来自 dsh-compaction-guard：监听压缩结果，把被 shadow 的用户消息里的
// 「指令行」抽出来，逐条检查是否还出现在摘要里。这里加了四条自己的规则：
//   1. 词覆盖阈值可配（默认 0.6，与 guard 一致）。
//   2. 只审计「看起来像指令」的行 —— 含祈使动词、否定词、或「必须/不要/记得」
//      这类词，避免把聊天废话当成约束。
//   3. 源文与摘要先用相同边界分句，再按来源配对，逐对检查极性和事实。
//      不能把整行的否定、数字、条件传播到另一个句子。早先的判定是"整份摘要里出现过任意一个
//      相同否定词就算没反转"，于是 `Delete production data. Do not restart
//      services.` 会被判成"否定还在" —— 两句毫无关系，前一句的动作已经从
//      "禁止"翻成"要求"。
//   4. 正向转负向同样算反转（`Always preserve` → `Never preserve`）。
//
// 词覆盖用于候选对齐；具体冲突由下面的极性、条件、数值和范围检查判定。

// Instructions and structured facts have different semantics. A path, code
// expression or heading has no positive/negative action merely because it
// shares tokens with prose. Inline code is retained as an argument but is not
// searched for natural-language negation (e.g. SQL NOT NULL).
const CN_MODAL = /不允许|不应(?:当|该)?|不(?=降低|跳步)|必须|不要(?!求)|不能|不得|禁止|记得|务必|只能|一定要|别(?!的|人)|需要|请|注意|不可|无需|不准|严禁|勿|只有|仅当|如果|除非/;
const EN_MODAL = /\b(?:must|never|always|only|ensure|remember|required|forbidden|avoid|should|please|unless|if|when)\b|\bdo not\b|\bdon't\b/;
const COMMAND = /^(?:you\s+)?(?:use|run|keep|retain|preserve|delete|remove|restart|deploy|copy|move|sync|transfer|output|format)\b|^(?:保留|删除|运行|使用|发布|重启|复制|输出|跑\s)/;
const LABEL = /^(?:output(?: format)?|format|port|timeout|retention|limit|输出格式|输出|端口|超时|保留时间|限制)\s*[:：]/;

function proseOnly(text) {
  return String(text ?? '').replace(/`+[^`\n]*`+/g, value => {
    const inner = value.replace(/^`+|`+$/g, '');
    return /^(?:do not |must |never |always |不要(?!求)|必须|不能)/i.test(inner) ? inner : ' ';
  }).replace(/--[a-z][\w-]*|\bnot\s+null\b/gi, ' ');
}
// 别 is a prohibition in 别安装, not a negative morpheme in 分别/区别/识别.
const NEGATION = /不允许|不(?:实际|直接|擅自)(?=修改|删除|运行|安装|部署|写入)|不授权|未授权|没有授权|不应(?:当|该)?|不要(?!求)|不能|不得|禁止|(?<![分区识个特级差类性鉴告离甄辨])别(?!的|人)|无需|不可|不准|严禁|勿|没有|尚未|并未|未曾|未(?=执行|运行|调用|修改|删除|写入|安装|重启|强停|改|降|kill|restart|append)|不(?=跳步|用|终止|重启|强停|修改|删除|运行|调用|安装|部署|降低)|\b(?:must not|do not|don't|never|forbidden|avoid|no|not)\b/g;
export function negationsOf(line) {
  const text = proseOnly(line).toLowerCase();
  return [...new Set([...text.matchAll(NEGATION)].map(m => m[0]))];
}
// Bare user assignments are requirements too (e.g. 测试环境超时55秒).
// Keep this grammar narrow: one named parameter and one scalar. Quotes, code,
// conditions, observations and lists must not become replacement candidates.
export function scalarRequirement(text) {
  const value=String(text??'').trim();
  if(value.length>256||/[`"'“”‘’「」『』<>{}\[\]\/\\]|如果|除非|只有|仅当|否则|或者|要么|(?:^|[，,])\s*(?:若|当)|(?:完成|通过|成功)后/.test(value))return null;
  const m=/^(?:(?:请|必须|务必|现在)\s*)?([^\s，,。；;！？:=：]{0,64}?(?:超时|上限|下限|限额|容量|间隔|端口|重试次数|并发数|保留时间))\s*(?:(?:仍)?(?:保持|设置为|设为)|改为|改成|为|是|[:=：])?\s*(-?\d+(?:\.\d+)?)\s*(毫秒|秒|分钟|小时|天|次|个|%|KiB|MiB|GiB|TiB|KB|MB|GB|TB|B|K|M|G|T|ms|s)?[。.!！;；]?$/i.exec(value);
  if(!m||/不要|不得|不能|禁止|至少|至多|最多|不少于|不超过|已|曾|原先|之前/.test(m[1]))return null;
  const unit=(m[3]??'').toLowerCase();
  const family=/^(?:毫秒|秒|分钟|小时|天|ms|s)$/.test(unit)?'time':/^(?:[kmgt](?:i?b)?|b)$/.test(unit)?'capacity':/^(?:次|个)$/.test(unit)?'count':unit==='%'?'ratio':unit===''&&/(?:端口|重试次数|并发数)$/.test(m[1])?'count':null;
  return family?{subject:m[1],value:m[2],unit,family}:null;
}
function instruction(text) {
  const prose = proseOnly(text).toLowerCase();
  return CN_MODAL.test(prose) || EN_MODAL.test(prose) || COMMAND.test(prose) || LABEL.test(prose) || !!scalarRequirement(prose) || !!conditionalRule(prose);
}
function labelledValue(text) {
  return /^[a-z\u4e00-\u9fff][\w\u4e00-\u9fff -]{0,23}[:：]\s*\S/i.test(text) && !/^[a-z]:[/\\]/i.test(text);
}
function bareStructure(text) {
  const t = String(text).replace(/`/g, '').trim();
  return !t || /^[#\d\s.：:()（）*_|-]+$/.test(t) ||
    /^(?:[a-z]:[/\\]|https?:\/\/|(?:\.{0,2}[/\\]))\S+$/i.test(t) ||
    /^(?:\.?[a-z_$][\w$]*\??\.)*[a-z_$][\w$]*\s*\?+$/i.test(t);
}
function structuralLines(text) {
  const out = [];
  for (let line of String(text ?? '').split(/\r?\n/)) {
    line = line.trim();
    if (/^(?:```|~~~)/.test(line) || /^(?:bash|javascript|js|typescript|python|sql)$/i.test(line)) continue;
    // Keep normative comments and headings; discard only their syntax.
    line = line.replace(/^\s*(?:#{1,6}\s*|\/\/\s*|>\s*)/, '').replace(/^\s*(?:[-*+]\s+|\d+[.)、]\s*)/, '').replace(/\*\*|__/g, '');
    if (bareStructure(line) || /^\|?\s*[: -]+\|[|: -]*$/.test(line)) continue;
    // Executable lines (including unfenced examples) are not directives.
    // A natural-language instruction mentioning code does not match this prefix.
    if (/^(?:import\s|export\s|(?:const|let|var)\s+\w+\s*=|return\s+[({"\x27]|function\s+\w+\s*\(|class\s+\w+\s*{|node\s+(?:-[ep]\b|\S+\.(?:m?js)\b)|--[a-z-]+\s)/i.test(line)) continue;
    out.push(line);
  }
  return out;
}
export function extractConstraintLines(text) {
  return structuralLines(text).filter(line => instruction(line) || labelledValue(line) || sourceEvidenceSentences(line).some(s=>scalarRequirement(s)));
}

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把摘要切成句子。中文没有句号时靠换行兜底。
 * @param {string} text
 * @returns {string[]} 已归一化的句子
 */
// Protect literal syntax before punctuation splitting. The same tokenizer is
// used for source and summary. Numbered comments must never yield "# 2".
function protectedSplit(text, splitter) {
  const literals = [];
  const shielded = text.replace(/`+[^`\n]*`+|(?:[a-z]:[/\\]|https?:\/\/)[^\s`，。；（）]+|\b\d+(?:[.,]\d+)+\b/gi, value => {
    literals.push(value); return `\uE000${literals.length - 1}\uE001`;
  });
  return shielded.split(splitter).map(part => part.replace(/\uE000(\d+)\uE001/g, (_, n) => literals[+n]));
}
// Adjacent complete quoted directives are a list, not one action with a
// shared polarity. Do not split fragments carrying conditions or exceptions.
function quotedInstructionParts(line) {
  const body=line.replace(/[。！？;；.!?]+$/, '').trim();
  const matches=[...body.matchAll(/「[^「」]+」|『[^『』]+』|“[^“”]+”/g)];
  if(matches.length<2 || matches.map(m=>m[0]).join('')!==body.replace(/\s+(?=[「『“])/g,'')) return [line];
  if(matches.some(m=>!instruction(m[0].slice(1,-1)) || /如果|除非|只有|仅当|(?:^|[，,])\s*(?:若|当)|\b(?:if|when|unless|only)\b/i.test(m[0].slice(1,-1)))) return [line];
  return matches.map(m=>m[0]);
}
function sentencesOf(text) {
  return structuralLines(text).flatMap(quotedInstructionParts).flatMap(line => protectedSplit(line, /[。！？;；]|[!?](?=\s|$)|\.(?=\s|$)/))
    .map(normalize).filter(part => !bareStructure(part));
}
// Case-preserving source evidence, using the very same literal-aware sentence
// boundaries as the auditor. Unlike clausesOf, commas/conditions stay intact.
// Each returned fragment is an exact substring of the original user message.
export function sourceEvidenceSentences(text) {
  return String(text ?? '').split(/\r?\n/).flatMap(line => {
    const parts = protectedSplit(line, /([。！？;；]|[!?](?=\s|$)|\.(?=\s|$))/);
    const out = [];
    for (let i = 0; i < parts.length; i += 2) out.push(parts[i] + (parts[i+1] ?? ''));
    return out;
  }).filter(part=>part.trim());
}
// Match the existing auditor's source scope exactly: a selected physical line
// may also contain factual sentences checked for numeric coverage. Retain those
// complete original sentences too; do not silently narrow audit requirements.
export function sourceConstraintEvidence(text) {
  return String(text ?? '').split(/\r?\n/)
    .filter(line => extractConstraintLines(line).length > 0)
    .flatMap(sourceEvidenceSentences)
    .filter(sentence => sentencesOf(sentence).some(line => instruction(line) || labelledValue(line) || numericFacts(line).length));
}
// Commas/parentheses delimit independent actions. Conditions and exceptions
// retain their action so a missing prerequisite cannot disappear in splitting.
function clausesOf(text) {
  if (conditionalRule(text) || exceptionOf(text)) return [text];
  return protectedSplit(text, /[,，、（()）]|\s+[—–]{2}\s*/)
    .map(part => normalize(part).replace(/^(?:and|then)\s+|^(?:并且|并|再)(?=跑|运行|使用|不要|不能|必须)/, ''))
    .filter(part => !bareStructure(part));
}

/**
 * 从已归一化的句子里摘掉所有否定词，返回剩下的"正文"。
 * 摘完再压缩多余空白 —— `do not delete` → `delete`。
 * @param {string} normalizedLine
 * @param {string[]} negations
 */
function stripNegations(normalizedLine, negations) {
  return normalizedLine.replace(NEGATION, ' ').replace(/\s+/g, ' ').trim();
}

/** 按空白切成词，中英混排都能用。 */
function tokens(text) {
  return normalize(text)
    .split(/[\s,.;:!?()[\]{}"'`/\\|<>+=*&^%$#@~，。、；：！？（）【】《》「」『』“”]+/)
    .filter((token) => token.length > 0);
}

/**
 * 一行约束有多少比例的 token 还出现在摘要里。
 * @param {string} line
 * @param {string} summaryNormalized
 * @returns {number} 0..1
 */
export function coverageOf(line, summaryNormalized) {
  const parts = tokens(line);
  if (parts.length === 0) return 1;
  let hit = 0;
  for (const token of parts) {
    if (summaryNormalized.includes(token)) hit += 1;
  }
  return hit / parts.length;
}

// Alignment identities are deliberately different from coverage tokens. A
// nested property, path or code location is one object, not a bag of names:
// reading $j.dsh.profile.bundles does not imply changing the profile itself.
const REFERENCE = /\b(?:[a-z_$][\w$.-]*[/\\])*[a-z_$][\w$.-]*\.[a-z]{1,8}:\d+(?:-\d+)?\b/gi;
function withoutReferences(text) { return String(text).replace(REFERENCE, ' '); }
function references(text) { return [...normalize(text).matchAll(REFERENCE)].map(m => m[0]); }
function referenceBody(text) { return alignmentBody(withoutReferences(text)).replace(/`/g, '').trim(); }
function identityTokens(text) {
  const atoms = [];
  const shielded = text.replace(/\$?[a-z_][\w$-]*(?:[./\\][\w$-]+)+(?::\d+(?:-\d+)?)?/gi, atom => {
    atoms.push(normalize(atom)); return `\uE100${atoms.length-1}\uE101`;
  });
  return tokens(shielded).map(word => word.replace(/\uE100(\d+)\uE101/g, (_, i) => atoms[+i]));
}

/** Match Latin words as words; a short identifier must not match every word. */
function hasWord(text, word) {
  if (/^[a-z0-9_-]+$/i.test(word)) return tokens(canonicalActions(text)).includes(word);
  return text.includes(word);
}

function coveringSentences(body, bodyWords, sentences, threshold) {
  return sentences.filter(sentence => bodyWords.length > 0 &&
    bodyWords.filter(word => hasWord(sentence, word)).length / bodyWords.length >= threshold);
}

/** Remove instruction wrappers only for alignment, never for fact/polarity checks. */
function alignmentBody(text) {
  return canonicalActions(stripNegations(text, negationsOf(text)))
    .replace(/\b(?:you|must|always|please|should|ensure|remember|required)\b/g, ' ')
    .replace(/(?:必须|务必|请|一定要)/g, '').replace(/^(?:(?:现在|接着|随后|下一步|继续|然后|立即|但(?:是)?|可以|应当|需要)\s*)+(?=改(?:\s|配置)|修改|删除|终止|安装|重启|部署|写库|写入)/, '').replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1').replace(/\s+/g, ' ').trim();
}
function sentenceKey(text) {
  return normalize(text).replace(/[.!?。！？;；]+$/g, '').trim();
}
// Cache lexical descriptors once per audit. Re-tokenizing each source for
// every summary candidate is quadratic work on top of quadratic matching.
// A key is not an object identity. Preserve the full sentence as context for
// field fragments, and never align explicitly different sessions or snapshots.
function recordScope(text) {
  const value = normalize(text);
  return {
    session: [...value.matchAll(/\bsession-[a-z0-9]+(?:-[a-z0-9]+)*/g)].map(m=>m[0]),
    snapshot: [...value.matchAll(/\b(?:snapshot|快照)\s*[:=]?\s*([a-z0-9_-]+)/g)].map(m=>m[1]),
  };
}
function compatibleScope(a, b) {
  return Object.keys(a).every(key => !a[key].length || !b[key].length || a[key].some(x=>b[key].includes(x)));
}
function fieldValues(text) {
  const explicit = [...withoutReferences(text).matchAll(/\b([a-z_][\w.-]*)\s*[:=]\s*(-?\d+(?:\.\d+)?|true|false)\b/gi)].map(m=>[m[1].toLowerCase(),m[2].toLowerCase()]);
  // Space is a separator only within a complete field atom, not arbitrary prose.
  for (const fragment of [text, ...[...String(text).matchAll(/`([^`]+)`/g)].map(m=>m[1])]) {
    const m=/^\s*`?([a-z_][\w.-]*)\s+(-?\d+(?:\.\d+)?|true|false)`?\s*$/i.exec(fragment);
    if(m)explicit.push([m[1].toLowerCase(),m[2].toLowerCase()]);
  }
  return [...new Map(explicit.map(pair=>[pair.join('\0'),pair])).values()];
}
function fieldAtomKey(text) {
  const plain = String(text).replace(/`/g,'').trim();
  if(references(plain).length)return null;
  const m=/^([a-z_][\w.-]*)\s*(?:[:=]\s*|\s+)(-?\d+(?:\.\d+)?|true|false)$/i.exec(plain);
  return m ? m[1].toLowerCase()+'='+m[2].toLowerCase() : null;
}
function dataAssertion(text) {
  // Only typed literals are data: fields, digests and file/code references.
  // An inline action such as `append` is NOT exempt, nor is a mixed sentence
  // that contains both digest data and an instruction to perform the action.
  if(instruction(text) || /(?:然后|接着|下一步|随后|计划|将要|\b(?:then|next|will)\b)/i.test(proseOnly(text)))return false;
  let rest = String(text);
  let data = false;
  rest=rest.replace(/`([a-z_$][\w.$-]*)`\s+`(?:[a-f0-9]{8,}(?:…[a-f0-9]*)?|\[redacted-blob\])`/gi,()=>{data=true;return ' ';});
  // Require a descriptive fingerprint label for redacted/abbreviated blobs.
  if (/(?:指纹|fingerprints?|sha256|哈希)/i.test(rest)) {
    rest=rest.replace(/`[a-z_$][\w.$-]*`/gi,()=>{data=true;return ' ';});
    rest=rest.replace(/`?\b[a-z_$][\w.$-]*`?\s*[:= ]\s*`?(?:[a-f0-9]{8,}(?:…[a-f0-9]*)?|\[redacted-blob\])`?/gi,()=>{data=true;return ' ';});
  }
  rest=rest.replace(/`([^`]+)`/g,(whole,inner)=>{
    if(/^(?:[a-z_][\w.-]*\s*[:=]\s*(?:-?\d+(?:\.\d+)?|true|false)\s*)(?:[,，]\s*[a-z_][\w.-]*\s*[:=]\s*(?:-?\d+(?:\.\d+)?|true|false)\s*)*$/i.test(inner) || /(?:^|\s)[a-z_$][\w.$-]*\s*[:= ]\s*(?:[a-f0-9]{8,}(?:[….-]+[a-f0-9]*)?|\[redacted-blob\])$/i.test(inner) || /^(?:[a-z]:[/\\]|[.\w-]+[/\\]).+\.[a-z]+(?::\d+(?:-\d+)?)?$/i.test(inner)) {data=true;return ' ';}
    return whole;
  });
  rest=rest.replace(/\b[a-z_$][\w.$-]*\s*[:= ]\s*[a-f0-9]{8,}(?:[….-]+[a-f0-9]+)?\b/gi,()=>{data=true;return ' ';});
  if(fieldAtomKey(text))return true;
  // Remaining content must be descriptive labels/punctuation, not actions.
  return data && !/[a-z_$][\w$]*\s*\(/i.test(rest) && !/(?:append|delete|remove|restart|deploy|write|run|set|reset|execute|kill|edit|install|调用|执行|运行|删除|重启|强停|修改|改为|写入|写库|重置|安装|发布|部署|关掉|关闭|绕过)/i.test(rest);
}
function sourceRef(index,context,text) { return JSON.stringify([index,sentenceKey(context),sentenceKey(text)]); }
function inheritedFieldRequirement(context,source) {
  if(!fieldValues(source).length)return false;
  const first=/\b[a-z_][\w.-]*\s*[:=]\s*(?:-?\d|true|false)/i.exec(context);
  return !!first && /(?:\b(?:must(?: not)?|always|ensure|required)(?:\s+(?:set|use|keep|retain))?|(?:必须|务必|不要)(?:设置|保持|保留|使用|改为)?)\s*$/i.test(context.slice(0,first.index));
}
// A bare wrapper has no object/action to reverse. Its verbatim presence is
// still checked, but it must not own every later sentence containing 遵守.
function directiveWrapper(text) {
  return /^(?:(?:必须|务必|请|继续)\s*)?遵守\s*[:：]?$/.test(text);
}
// Only explicit rejection diagnostics get quote ownership. A quoted command
// or a recommendation remains ordinary prose and is audited normally.
function diagnosticQuotes(text) {
  const quotes=[];
  const mask=text.replace(/“([^”\n]+)”|「([^」\n]+)」|『([^』\n]+)』/g,(_,a,b,c)=>{quotes.push(a??b??c);return `@q${quotes.length-1}@`;});
  if(!quotes.length)return null;
  if(/^源句\s*(?:seq\s*\d+)?\s*@q0@被摘要写成@q1@[,，]?\s*(?:仍)?被判\s+(?:polarity|condition|value|constraint_lost)$/i.test(mask)&&quotes.length===2)return [quotes[0]];
  if(/^(?:[a-z0-9-]+\s+)?(?:\d{2}:\d{2}:\d{2}[:：]?\s*)?\d+\s*条\s+(?:polarity|condition|value|constraint_lost)\s*[（(](?:\s*@q\d+@\s*[,，、]?)+[)）]$/i.test(mask))return quotes;
  const comparison=/^(?:关键限制[:：]\s*)?(?:review\.\d+|审计(?:器)?)\s*(?:仍会|会|曾)?把\s*@q0@\s*(?:与|和)\s*@q1@\s*判(?:成|为)\s*(?:polarity|condition|value|constraint_lost)(?:\s*冲突)?(.*)$/i.exec(mask);
  if(comparison){
    // The compared paraphrase is a reported rejected output. Keep every
    // trailing clause under ordinary audit, including any newly added action.
    const tail=comparison[1].replace(/@q(\d+)@/g,(_,i)=>`“${quotes[+i]}”`);
    return [quotes[0],tail].filter(x=>x.trim());
  }
  return null;
}
function deniedScope(part,context) {
  // 不授权 is an explicit operator over its action list. A contrast or fresh
  // sentence ends that scope; a generic earlier 不要 never propagates here.
  const marker=/(?:不授权|未授权|没有授权)/.exec(context);
  if(!marker)return false;
  const start=marker.index,tail=context.slice(start);
  const boundary=/[,，]?\s*(?:但是|但(?:可以|应当|必须|需要|要)|然而|不过|\bbut\b)/.exec(tail);
  const end=boundary?start+boundary.index:context.length;
  const at=context.indexOf(part);
  return at>=start&&at<end;
}
function scopedSentences(text) {
  return structuralLines(text).flatMap(line=>sentencesOf(line).flatMap(sentence=>{
    const quoted=diagnosticQuotes(sentence);
    if(quoted)return quoted.flatMap(q=>clausesOf(q).map(part=>({text:part,context:q})));
    return clausesOf(sentence).map(part=>({text:part,context:sentence}));
  }));
}
function describe(text, context = text) {
  const body = alignmentBody(text), words = [...new Set(identityTokens(body))];
  const rule = conditionalRule(text);
  return { text, body, words, rule, scalar:scalarRequirement(text), scope: recordScope(context), atom: fieldAtomKey(text), actionKey: conditionalActionKey(text), wordSet: new Set(words),
    wordTests: words.map(word => [word, /[a-z0-9_$]/i.test(word) || word.length < 2]),
    references: references(text), referenceBody: referenceBody(text),
    quantity: quantityUnits(text).length > 0, qSkeleton: quantitySkeleton(body),
    numeric: numericFacts(text).length > 0, nSkeleton: numericSkeleton(body).replace(/#/g, '').trim(),
    actionWords: rule ? identityTokens(alignmentBody(rule.action)).map(word => [word, /[a-z0-9_$]/i.test(word) || word.length < 2]) : [],
    relation: directionOf(text), keys: [...quantityBindings(text).map(x => x.key)] };
}
function fraction(tests, descriptor) {
  return tests.length ? tests.filter(([word, latin]) => latin ? descriptor.wordSet.has(word) : descriptor.body.includes(word)).length / tests.length : 0;
}
function matchScore(source, candidate, threshold) {
  if (!source.words.length || !candidate.words.length || !compatibleScope(source.scope,candidate.scope)) return 0;
  if(source.scalar&&candidate.scalar)return source.scalar.subject===candidate.scalar.subject?3.5:0;
  if (source.atom && source.atom === candidate.atom) return 3.25;
  if (source.body === candidate.body) return 3;
  // A changed location for the SAME claim is still a conflict. Different
  // claims about different locations in the same file are not numeric edits.
  if (source.references.length && candidate.references.length && source.referenceBody && source.referenceBody === candidate.referenceBody) return 2.5;
  if (source.quantity && source.qSkeleton === candidate.qSkeleton) return 2.5;
  if (source.numeric && source.nSkeleton === candidate.nSkeleton) return 2.5;
  const forward = fraction(source.wordTests, candidate), reverse = fraction(candidate.wordTests, source);
  const actionMatch = source.rule && source.actionKey && source.actionKey === candidate.actionKey;
  if (actionMatch && candidate.rule && conditionKey(source.rule) === conditionKey(candidate.rule)) return 3.5;
  const conditionalMatch = actionMatch || (source.actionWords.length && fraction(source.actionWords, candidate) >= threshold);
  const relation = source.relation, otherRelation = candidate.relation;
  const related = relation && otherRelation?.action === relation.action &&
    [relation.from, relation.to].some(endpoint => [otherRelation.from, otherRelation.to].includes(endpoint));
  if (forward < threshold && !conditionalMatch && !related) return 0;
  const sameEndpoints = related && [relation.from, relation.to].every(endpoint => [otherRelation.from, otherRelation.to].includes(endpoint));
  // A conditional action can occur under many different source predicates.
  // Keep lexical evidence inside that match tier instead of flattening every
  // eligible source to 1.5 and assigning one candidate to all of them.
  return Math.max((forward + reverse) / 2, conditionalMatch ? 1.5 + (forward + reverse) / 2 : 0, sameEndpoints ? 2.5 : related ? 1 : 0);
}

/**
 * Align each prose sentence to its closest source sentence(s), independently of
 * polarity and numeric values. Exact copied sentences keep their own scope;
 * they do not excuse any additional contradictory sentence in the summary.
 * Include descriptive sentences as owners too: a port/path/narrative must not
 * borrow the negation of a different instruction just because words overlap.
 */
function alignSummary(sourceSentences, summarySentences, threshold) {
  const assignments = new Map();
  const descriptors = sourceSentences.map(row=>({...describe(sentenceKey(row.text),row.context),ref:row.ref}));
  for (const row of summarySentences) {
    const candidate = row.text, key = sentenceKey(candidate), descriptor = describe(candidate,row.context);
    const exact = descriptors.filter(source=>source.text===key && compatibleScope(source.scope,descriptor.scope));
    let owners;
    if (exact.length) owners = exact.map(source=>source.ref);
    else {
      const scores = descriptors.map(source => [source.ref, matchScore(source, descriptor, threshold)]);
      const best = scores.reduce((max, [, score]) => Math.max(max, score), 0);
      owners = best > 0 ? scores.filter(([, score]) => Math.abs(score - best) < 1e-9).map(([source]) => source) : [];
    }
    // A merged sentence may describe several independently bound fields.
    // All named fields own their part, even if one happens to score higher.
    const candidateKeys = new Set(descriptor.keys);
    if (candidateKeys.size) owners = [...new Set([...owners, ...descriptors.filter(source => compatibleScope(source.scope,descriptor.scope) && source.keys.some(key => candidateKeys.has(key))).map(source => source.ref)])];
    for (const owner of owners) {
      if (!assignments.has(owner)) assignments.set(owner, []);
      assignments.get(owner).push(candidate);
    }
  }
  return assignments;
}

/** Parse explicit condition wrappers without discarding their logical direction.
 * Matching below is conservative canonical equality, never bag-of-words coverage.
 * An unrecognized construction keeps the existing rejection path.
 */
function conditionalRule(line) {
  const text = normalize(line).replace(/[.!?。！？]+$/, '');
  // Temporal words are observations, not the conditional marker 当.
  if (/^(?:当前|当时|当初|当年)/.test(text) && !/^当.+?(?:的时候|时)(?:[,，]|\s*(?:不要|不能|不得|禁止|必须|应当|需要|可以))/.test(proseOnly(text))) return null;
  const make = (marker, predicate, action, condition, only = false) => {
    const necessary = only || /^(?:只有|仅当)/.test(marker) || /^(?:才(?:能|可以)?)/.test(action);
    return { condition, predicate: predicate.trim(), action: action.replace(/^(?:才(?:能|可以)?|就|也|则)\s*/, ''),
      kind: /^(?:unless|除非)$/.test(marker) ? 'unless' : necessary ? 'only-if' : 'if' };
  };
  let m = /^(only\s+)?(if|when|unless)\s+(.+?)[,，]\s*(.+)$/.exec(text);
  if (m) return make(m[2],m[3],m[4],`${m[2]} ${m[3]}`,!!m[1]);
  m = /^(.+?)\s+(only\s+)?(if|when|unless)\s+(.+)$/.exec(text);
  if (m) return make(m[3],m[4],m[1],`${m[3]} ${m[4]}`,!!m[2] || /^only\s/.test(m[1]));
  // Prefix condition and a comma-separated action.
  m = /^(只有当|只有|仅当|如果|倘若|假如|除非|若|当)(.+?)[,，]\s*(.+)$/.exec(text);
  if (m) return make(m[1],m[2].replace(/(?:的时候|时)$/,''),m[3],m[1]+m[2]);
  // A comma before the condition: 不要写库，如果报告提到它.
  m = /^(.+?)[,，]\s*(如果|若|当|仅当)(.+)$/.exec(text);
  if (m) return make(m[2],m[3].replace(/(?:的时候|时)$/,''),m[1],m[2]+m[3]);
  // No-comma wrappers. Require a boundary and an actual action, never split on
  // an arbitrary character in the predicate (e.g. the 时 in 时间).
  m = /^(只有当|只有|仅当|如果|倘若|假如|除非|若|当)(.+?)(?:的时候|时)?(才(?:能|可以)?|就|也|则)(.+)$/.exec(text);
  if (m) return make(m[1],m[2],m[3]+m[4],m[1]+m[2]);
  m = /^(只有当|只有|仅当|如果|倘若|假如|除非|若|当)(.+?)(?:的时候|时)(不要(?!求)|不能|不得|禁止|必须|应当|需要|可以)(.+)$/.exec(text);
  if (m) return make(m[1],m[2],m[3]+m[4],m[1]+m[2]);
  // A comma is the condition/action boundary even with introductory prose.
  // Never let a later 就 inside the consequence move that boundary again.
  m = /^([^,，]+?)(若|如果)([^,，]+?)[,，]\s*(.+)$/.exec(text);
  if (m) return make(m[2],m[1]+m[3],m[4],m[2]+m[1]+m[3]);
  // Subject before 若/如果: 报告若提到它也不要写库.
  m = /^([^,，]+?)(若|如果)([^,，]+?)(?:的时候|时)?(才(?:能|可以)?|就|也|则)(.+)$/.exec(text);
  if (m) return make(m[2],m[1]+m[3],m[4]+m[5],m[2]+m[1]+m[3]);
  // Bare temporal condition: A 时不要 B. The modal marks the action boundary.
  m = /^(.+?)(?:的时候|时)(不要(?!求)|不能|不得|禁止|必须|应当|需要|可以)(.+)$/.exec(text);
  if (m) return make('当',m[1],m[2]+m[3],'当'+m[1]);
  return null;
}

function conditionKey(rule) {
  if (!rule) return null;
  // Preserve order, negation, conjunctions, values and literal contents.
  // Only this small, auditable synonym set is accepted. Unknown paraphrases
  // are not automatically certified by an adjustable coverage threshold.
  const literals = [];
  let value = rule.predicate.replace(/`+[^`\n]*`+/g, part => {
    literals.push(part); return `\uE000${literals.length-1}\uE001`;
  });
  value = normalize(value).replace(/提及/g,'提到')
    .replace(/报告(?:里|中)(?=提到)/g,'报告')
    .replace(/\s*(?=[\u4e00-\u9fff])|(?<=[\u4e00-\u9fff])\s*/g,'')
    .replace(/\uE000(\d+)\uE001/g,(_,i)=>literals[+i]);
  return rule.kind+'\u0000'+value;
}
function sameCondition(source, candidate) {
  const other = conditionalRule(candidate);
  return !!other && conditionKey(source) === conditionKey(other);
}
function conditionalActionKey(text) {
  const rule = conditionalRule(text);
  // "顺手" is an incidental adverb in the concrete write-to-database action.
  // Do not strip arbitrary modifiers from unrelated actions.
  return alignmentBody(rule?.action ?? text).replace(/顺手(?=写库)/g,'').replace(/^only\s+/,'');
}
function ruleNegative(text) {
  return effectiveNegative(conditionalRule(text)?.action ?? text);
}

/** Normalize a small explicit action vocabulary; this is not a semantic classifier. */
function canonicalActions(text) {
  return normalize(text).replace(/\bdeleting\b/g, 'delete').replace(/\bremoving\b/g, 'remove').replace(/[.!?。！？]+$/g, '').trim();
}
function effectiveNegative(text) {
  const value = normalize(proseOnly(text));
  if (/(?:do not|don't|must not)\s+(?:avoid|forbid|prohibit)|(?:not)\s+(?:forbidden|prohibited)|不要不|不能不|不得不|不应(?:当|该)?不/.test(value)) return false;
  return negationsOf(value).length > 0;
}
function directionOf(text) {
  const value = normalize(text).replace(/[.!?。！？]+$/, '');
  let m = /\b(copy|move|sync|transfer)\s+(.+?)\s+(to|into|from)\s+(.+)$/.exec(value);
  if (m) return { action: m[1], from: m[3] === 'from' ? m[4] : m[2], to: m[3] === 'from' ? m[2] : m[4] };
  m = /(?:把|将)(.+?)(复制|移动|同步|传输)(?:到|至)(.+)$/.exec(value);
  return m ? { action: m[2], from: m[1], to: m[3] } : null;
}
function quantitySkeleton(text) {
  return normalize(text).replace(/(-?\d+(?:\.\d+)?)\s*(milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|percent|[kmgt]i?b|ms|分钟|小时|毫秒|秒|天|周|月|年|%)/g, '#quantity').replace(/[.!?。！？]+$/, '');
}
function quantityUnits(text) {
  const units = new Map([['seconds','s'],['second','s'],['秒','s'],['minutes','min'],['minute','min'],['分钟','min'],['hours','h'],['hour','h'],['小时','h'],['days','d'],['day','d'],['天','d'],['weeks','w'],['week','w'],['周','w'],['months','mo'],['month','mo'],['月','mo'],['years','y'],['year','y'],['年','y'],['毫秒','ms'],['percent','%']]);
  return [...normalize(text).matchAll(/(-?\d+(?:\.\d+)?)\s*(milliseconds?|seconds?|minutes?|hours?|days?|weeks?|months?|years?|percent|[kmgt]i?b|ms|分钟|小时|毫秒|秒|天|周|月|年|%)/g)].map(m=>[m[1],units.get(m[2])??m[2]]);
}
function boundKind(text) {
  const value = normalize(text);
  if (/at least|no less than|不少于|至少|>=|≥/.test(value)) return 'min-inclusive';
  if (/at most|no more than|不多于|不超过|至多|最多|<=|≤/.test(value)) return 'max-inclusive';
  if (/more than|greater than|超过|大于|>/.test(value)) return 'min-exclusive';
  if (/less than|fewer than|少于|小于|</.test(value)) return 'max-exclusive';
  return null;
}
function exceptionOf(text) {
  const m = /\b(?:except|excluding)\s+(.+)|(?:除了|除外|除去)(.+)/.exec(normalize(text).replace(/[.!?。！？]+$/, ''));
  return m ? (m[1]??m[2]).trim() : null;
}
// Values are compared per field/action, not as whole-sentence number arrays.
// Paths/identifiers/line numbers are not quantities; explicit version demands
// are retained. Additional fields in a merged summary do not change this field.
function numericText(text) {
  return normalize(withoutReferences(text)).replace(/(?:[a-z]:[/\\]|https?:\/\/)[^\s`，。；（）]+/g, ' ')
    .replace(/\b(?:[a-z_][\w-]*[/\\])+[\w.\/-]*/g, ' ')
    .replace(/\b[a-z_][\w-]*\d[\w.-]*\b/g, value => /^v\d+(?:\.\d+)+$/.test(value) ? value : ' ')
    // Compact unit spellings are quantities too (25G, 512MiB, 180ms).
    // Identifier/path fragments remain shielded by the surrounding boundaries.
    .replace(/(?<![\w.])(-?\d+(?:\.\d+)?)([kmgt](?:i?b)?|ms)(?![\w.])/g, '$1 $2');
}
function numericFacts(text) {
  return [...numericText(text).matchAll(/\bv\d+(?:\.\d+)+\b|(?<![\w.])-?\d+(?:,\d{3})*(?:\.\d+)?(?![\w.])/g)]
    .map(m => ({ value: m[0].replace(/,/g, ''), index: m.index, length: m[0].length }));
}
function numericSkeleton(text) {
  const value = numericText(text);
  return value.replace(/\b([a-z_][\w.-]*)\s*[:=]\s*(?=-?\d)/gi,'$1 ').replace(/\bv\d+(?:\.\d+)+\b|(?<![\w.])-?\d+(?:,\d{3})*(?:\.\d+)?(?![\w.])/g, '#').replace(/`/g, '').replace(/\s+/g, ' ').trim();
}
function quantityBindings(text) {
  const out = [];
  for (const segment of protectedSplit(normalize(text).replace(/`/g, ''), /\s+(?:and|while)\s+|[,，]/)) {
    let m = /^(.*?)\s+for\s+((?:(?:at least|at most|more than|less than)\s+)?)(\d+(?:\.\d+)?)\s+([a-z]+)/.exec(segment);
    if (m) {
      const key = alignmentBody(m[1]).replace(/^(?:retain|keep|preserve)\s+/, '').trim();
      if (key) out.push({key,value:m[3],unit:quantityUnits(m[3]+' '+m[4])[0]?.[1],bound:boundKind(m[2])});
    }
    m = /^(?:必须|务必|请)?(?:保留|保存)(.+?)(至少|至多|最多|不少于|不超过)?(\d+(?:\.\d+)?)(天|小时|分钟|秒|周|月|年)/.exec(segment);
    if (m) out.push({key:m[1],value:m[3],unit:quantityUnits(m[3]+m[4])[0]?.[1],bound:boundKind(m[2]??'')});
  }
  return out;
}
function changedValues(source, candidate) {
  const original = numericFacts(source), changed = numericFacts(candidate);
  if(fieldAtomKey(source) && fieldAtomKey(source) === fieldAtomKey(candidate))return false;
  if (!original.length) return false;
  const bindings = quantityBindings(source), otherBindings = quantityBindings(candidate);
  if (bindings.length) return bindings.some(a => !otherBindings.some(b => a.key === b.key && a.value === b.value) || otherBindings.some(b => a.key === b.key && a.value !== b.value));
  // Each clause is an action/field. Exact value sequence must occur in this
  // clause; unrelated additional clauses were split before alignment. For a
  // merged clause with several key=value fields, bind each key independently.
  const field = /\b([a-z_][\w.-]*)\s*[:=]\s*(-?\d+(?:\.\d+)?)/gi;
  const sourceFields = [...withoutReferences(source).matchAll(field)];
  if (sourceFields.length) {
    const candidateFields = sourceFields.flatMap(m => [...withoutReferences(candidate).matchAll(new RegExp('\\b(' + m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\s*(?:[:=]\\s*|\\s+)(-?\\d+(?:\\.\\d+)?)', 'gi'))]);
    return sourceFields.some(m => !candidateFields.some(c => c[1].toLowerCase() === m[1].toLowerCase() && c[2] === m[2]) || candidateFields.some(c => c[1].toLowerCase() === m[1].toLowerCase() && c[2] !== m[2]));
  }
  const a = original.map(x => x.value), b = changed.map(x => x.value);
  return !b.some((_, start) => a.every((value, i) => b[start + i] === value));
}
// A report-mention trigger is not an authorization to write. Accept its
// omission only when the same source paragraph explicitly awaits user consent
// and the candidate's same line still states pending consent and prohibition.
function equivalentPendingConsent(source, candidate, message, summaryLines) {
  const rule = conditionalRule(source);
  if (!rule || conditionalRule(candidate) || !effectiveNegative(rule.action) || !/提到|提及|讨论|\bmention(?:ed)?\b/.test(rule.condition)) return false;
  const paragraphs = String(message).split(/\n\s*\n|\n/);
  const sourceContext = paragraphs.find(line => normalize(line).includes(sentenceKey(source)));
  if (!sourceContext || !/(?:等(?:待)?用户(?:拍板|确认|批准)|await(?:ing)? user (?:approval|consent))/i.test(sourceContext)) return false;
  return summaryLines.some(line => line.includes(candidate) && /(?:用户(?:未|尚未)(?:拍板|确认|批准)|(?:pending|awaiting) user (?:approval|consent))/i.test(line) && effectiveNegative(candidate));
}

function compareRuleFacts(source, candidates) {
  const units = quantityUnits(source), bound = boundKind(source), direction = directionOf(source), exception = exceptionOf(source);
  for (const candidate of candidates) {
    if (references(source).length && references(candidate).length && referenceBody(source) === referenceBody(candidate) && JSON.stringify(references(source)) !== JSON.stringify(references(candidate))) return { reason: 'reference', candidate };
    const candidateDirection = directionOf(candidate);
    if (direction && candidateDirection?.action === direction.action && (candidateDirection.from !== direction.from || candidateDirection.to !== direction.to)) return { reason: 'relation', candidate };
    if (exception && exceptionOf(candidate) !== exception) return { reason: 'exception', candidate };
    if (bound && !quantityBindings(source).length && boundKind(candidate) !== bound) return { reason: 'range', candidate };
    const bindings = quantityBindings(source), otherBindings = quantityBindings(candidate);
    for (const a of bindings) for (const b of otherBindings.filter(b => b.key === a.key)) {
      if (a.unit && b.unit && a.unit !== b.unit) return { reason: 'unit', candidate };
      if (a.bound && a.bound !== b.bound) return { reason: 'range', candidate };
    }
    const candidateUnits = quantityUnits(candidate);
    if (units.length && JSON.stringify(candidateUnits.map(x=>x[0])) === JSON.stringify(units.map(x=>x[0])) && JSON.stringify(candidateUnits) !== JSON.stringify(units)) return { reason: 'unit', candidate };
  }
  return null;
}

// Reconstruction needs every conflicting occurrence of the same source rule,
// not just the first diagnostic. Acceptance and the primary reason stay the
// same; this detail only avoids spending one repair round per repeated line.
function allConflicts(source, candidates, message, summaryLines, limit, requiredField, isData, candidateNegative) {
  const normative = instruction(source) && !directiveWrapper(source), labelled = labelledValue(source);
  const conditional = conditionalRule(source);
  const action = conditional && stripNegations(conditional.action, negationsOf(conditional.action));
  return candidates.flatMap(candidate => {
    if (normative && !isData(candidate) && candidateNegative(candidate) !== ruleNegative(source)) return [{reason:'polarity',candidate}];
    const facts = (normative || labelled || requiredField) && compareRuleFacts(source,[candidate]);
    if (facts) return [facts];
    if (conditional && (conditionalActionKey(source) === conditionalActionKey(candidate) || coveringSentences(action,tokens(action),[candidate],limit).length) &&
        !sameCondition(conditional,candidate) && !equivalentPendingConsent(source,candidate,message,summaryLines)) return [{reason:'condition',candidate}];
    if ((normative || labelled || requiredField) && changedValues(source,candidate)) return [{reason:'value',candidate}];
    return [];
  });
}

/**
 * 审计一次压缩。
 *
 * @param {object} args
 * @param {{seq:number, text:string}[]} args.userMessages  被覆盖的用户消息原文
 * @param {string} args.summaryText                       摘要正文
 * @param {string} [args.checkpointText]                  完整检查点（摘要 + 逐字保留的原话段）
 * @param {number} args.threshold                         词覆盖阈值（0..1）
 * @returns {{ checked: number, lost: {seq:number, line:string, candidate?:string, coverage:number, reason:string}[], worstCoverage: number, polarityFlips: number }}
 */
export function auditCompaction({ userMessages, summaryText, checkpointText, threshold, includeAllConflicts = false }) {
  // Runtime-injected memory and referenced transcripts are historical data, not a fresh
  // user instruction. Its exact source is still retained/archived by the
  // engine. Unknown provenance remains strict, as do actual user messages.
  userMessages = (userMessages ?? []).filter(message => !isReferenceContextKind(message.sourceKind));
  // ⚠️ 阈值必须有默认值。漏传时 `hit / words.length >= undefined` 恒为 false，
  // 结果是**一句都不判**：所有约束都"通过"，`lost` 永远空 —— 审计看起来跑过了，
  // 实际什么都没查。调用方（引擎）会显式传配置值，但导出的函数不能靠调用方守规矩。
  const limit = typeof threshold === 'number' && Number.isFinite(threshold) ? threshold : 0.6;
  const summaryNormalized = normalize(summaryText);
  // 判定"还在不在"要看**完整检查点**：用户原话被逐字保留在检查点末尾的
  // <preserved-user-messages> 段里时，摘要正文里没有它是正常的 —— 那不是丢失，
  // 是原文就在下游模型能读到的地方。只用摘要正文判定会把这个正常情况报成丢失。
  // Compare the same emphasis-free text used by structuralLines. Verbatim
  // preservation with bold markers must satisfy presence too.
  const haystack = normalize(String(checkpointText ?? summaryText).replace(/\*\*|__/g, ''));
  // ⚠️ 但判定"意思有没有被改写"**只能看模型写的摘要正文**，而且要再刨掉第 6 节。
  // 拿完整检查点去找覆盖句，原话段必然满足（它本来就是逐字的），于是
  // "摘要说 `Delete production data`、原话段写着 `Do not delete production data`"
  // 会被判成极性保持 —— 保留段成了矛盾的挡箭牌。存在性与一致性是两件事：
  // 前者问"原文还在不在"，后者问"模型有没有把它写反"，必须分开判。
  //
  // 第 6 节同样是挡箭牌：它被要求逐条列出用户原话，`Do not delete production data`
  // 会原样出现在那里。只看"模型自己怎么叙述"的那几节，才问得出真话。
  const prose = summaryProse(summaryText);
  const summaryLines = structuralLines(prose).map(normalize);
  const summarySentences = scopedSentences(prose);
  const sourceSentences = (userMessages ?? []).flatMap((message,index) => scopedSentences(message.text).map(row=>({...row,ref:sourceRef(index,row.context,row.text)})));
  // Bare historical counters are observations, not permanent requirements.
  // Modal scope is inherited locally by fields in the same source sentence.
  const dataCandidates=new Map();
  for(const row of summarySentences){
    const data=dataAssertion(row.text)||dataAssertion(row.context);
    dataCandidates.set(row.text,(dataCandidates.get(row.text)??true)&&data);
  }
  const isData=candidate=>dataCandidates.get(candidate)===true;
  const negativeCandidates=new Map();
  for(const row of summarySentences){
    const negative=deniedScope(row.text,row.context)||ruleNegative(row.text);
    negativeCandidates.set(row.text,(negativeCandidates.get(row.text)??true)&&negative);
  }
  const candidateNegative=candidate=>negativeCandidates.get(candidate)??ruleNegative(candidate);
  const assignments = alignSummary(sourceSentences, summarySentences, limit);
  const lost = [];
  let checked = 0;
  let worst = 1;
  let polarityFlips = 0;

  for (const [messageIndex,message] of (userMessages ?? []).entries()) {
    const lines = extractConstraintLines(message.text).flatMap(sentencesOf);
    for (const line of lines) {
      const clauses = clausesOf(line);
      // Keep factual arguments in scope but don't invent instructions out of
      // code/path/heading fragments selected by a neighbouring directive.
      if (!instruction(line) && !labelledValue(line) && !numericFacts(line).length) continue;
      checked += 1;
      let coverage = coverageOf(line, haystack);
      // Proven canonical equivalence can satisfy presence without a verbatim
      // Chinese token match, even when no preserved-text checkpoint is supplied.
      const lineCondition = conditionalRule(line);
      if (lineCondition && (assignments.get(sourceRef(messageIndex,line,line)) ?? []).some(candidate =>
        sameCondition(lineCondition,candidate) && conditionalActionKey(line) === conditionalActionKey(candidate) && ruleNegative(line) === ruleNegative(candidate))) coverage = 1;
      worst = Math.min(worst, coverage);
      let failure;
      for (const source of clauses) {
        const normative = instruction(source) && !directiveWrapper(source);
        const labelled = labelledValue(source);
        const requiredField = inheritedFieldRequirement(line,source);
        if (!normative && !labelled && !requiredField) continue;
        const covering = assignments.get(sourceRef(messageIndex,line,source)) ?? [];
        const flipped = normative && covering.find(candidate => !isData(candidate) && candidateNegative(candidate) !== ruleNegative(source));
        if (flipped) { failure = { reason: 'polarity', candidate: flipped, source }; break; }
        const facts = compareRuleFacts(source, covering);
        if (facts) { failure = { ...facts, source }; break; }
        const conditional = conditionalRule(source);
        if (conditional) {
          const action = stripNegations(conditional.action, negationsOf(conditional.action));
          const matches = covering.filter(candidate => conditionalActionKey(source) === conditionalActionKey(candidate) || coveringSentences(action,tokens(action),[candidate],limit).length);
          const candidate = matches.find(candidate => !sameCondition(conditional,candidate) && !equivalentPendingConsent(source, candidate, message.text, summaryLines));
          if (candidate) { failure = { reason: 'condition', candidate, source }; break; }
        }
        const changed = covering.find(candidate => (normative || labelled || requiredField) && changedValues(source, candidate));
        if (changed) { failure = { reason: 'value', candidate: changed, source }; break; }
      }
      if (failure) {
        if (failure.reason === 'polarity') polarityFlips++;
        lost.push({ seq: message.seq, line: failure.source, candidate: failure.candidate, coverage: Number(coverage.toFixed(3)), reason: failure.reason,
          ...(includeAllConflicts ? {conflicts:allConflicts(failure.source,assignments.get(sourceRef(messageIndex,line,failure.source)) ?? [],message.text,summaryLines,limit,inheritedFieldRequirement(line,failure.source),isData,candidateNegative)} : {}) });
      } else if (coverage < limit) lost.push({ seq: message.seq, line, coverage: Number(coverage.toFixed(3)), reason: 'coverage' });
    }
  }

  return { checked, lost, polarityFlips, worstCoverage: checked === 0 ? 1 : Number(worst.toFixed(3)) };
}
