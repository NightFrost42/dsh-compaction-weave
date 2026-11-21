// 摘要与检查点的**提交前确定性校验**。
//
// 为什么必须有这一层：模板里写满"必须九节""必须列出每一条用户消息"，
// 但那些只是给模型的请求。模型回一句 `Done.`，模板一个字都不管用 ——
// 校验缺失时它会照样被当成合格摘要提交，用户原话就此消失。
// 这类损失不可逆：surface 一旦替换，原文只剩归档，模型再也读不到。
//
// 两层检查的可信来源不同：
//   1. `validateSummaryStructure` 只能检查**模型给的**摘要正文 ——
//      九个小节必须齐全、必须按编号顺序、每个编号只能出现一次。
//   2. `validateCheckpointCoverage` 检查**我们自己拼出来的**完整检查点 ——
//      被压区间里每一条用户原话都必须逐字出现在里面。
//      这条不依赖模型守规矩：原话是 `collectRecentUserMessages` 直接从事件里
//      取的，模型再怎么概括也改不掉它。校验时还会额外核对"来源全集"，
//      避免"选错了保留列表"时自己跟自己对得上。
//
// 任何一条不通过就抛错，让事务走"安全失败"路径：不替换 surface，保留原上下文。

/** 与 `prompt.js` 的 EN_SECTIONS / ZH_SECTIONS 一一对应。 */
const EN_SECTION_TITLES = [
  'Primary Request and Intent',
  'Key Technical Concepts',
  'Files and Code Sections',
  'Errors and Fixes',
  'Problem Solving',
  'All User Messages',
  'Pending Tasks',
  'Work Completed',
  'Context for Continuing Work',
];

const ZH_SECTION_TITLES = [
  '用户的核心请求与意图',
  '关键技术概念',
  '涉及的文件与代码',
  '错误与修复',
  '问题解决过程',
  '全部用户消息',
  '待办任务',
  '已完成的工作',
  '继续工作所需的上下文',
];

/**
 * Curated allowlist of natural Chinese heading variants per section (1..9).
 * Covers canonical `ZH_SECTION_TITLES` plus observed natural Chinese phrasings
 * (e.g. from DeepSeek Flash on code-heavy Chinese sessions) without ever
 * permitting arbitrary or unverified section titles.
 */
const ZH_SECTION_TITLE_VARIANTS = [
  ['用户的核心请求与意图', '用户核心请求与意图', '核心请求与意图', '主要请求与意图', '主要请求和意图', '用户的核心请求和意图', '核心请求和意图', '用户主要请求与意图'],
  ['关键技术概念', '核心技术概念'],
  ['涉及的文件与代码', '涉及的文件和代码', '文件与代码段', '文件和代码段', '文件与代码部分', '文件与代码', '相关文件与代码'],
  ['错误与修复', '错误和修复', '错误及修复'],
  ['问题解决过程', '问题解决', '问题解决与排查', '问题排查与解决'],
  ['全部用户消息', '所有用户消息', '全部用户原话', '所有用户原话'],
  ['待办任务', '待处理任务', '未完成任务'],
  ['已完成的工作', '已完成工作', '已完成任务'],
  ['继续工作所需的上下文', '继续工作上下文', '继续工作的上下文', '继续工作所需上下文', '后续工作上下文'],
];

const ACCEPTED_SECTION_TITLES = EN_SECTION_TITLES.map((enTitle, index) =>
  new Set([enTitle, ZH_SECTION_TITLES[index], ...ZH_SECTION_TITLE_VARIANTS[index]]),
);

/** 第 6 节（All User Messages）在九节里的下标（0 基）。 */
const USER_MESSAGE_SECTION = 5;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAcceptedHeadingTitle(number, title, titleSets = ACCEPTED_SECTION_TITLES) {
  if (number < 1 || number > titleSets.length) return false;
  const allowed = titleSets[number - 1];
  return allowed instanceof Set ? allowed.has(title) : title === allowed;
}

/**
 * 扫出所有 `## N. <title>` 形态的标题行，附带它在正文里的偏移。
 *
 * ⚠️ 不能用"每个标题单独 `regex.test`"来判齐全。那样只看得到"存在"，
 * 看不到"在第几位、出现了几次"：把九节按 9→1 倒着写、每节只写 `(none)`，
 * 九个正则全部命中，一份完全颠倒的空壳照样通过。顺序和唯一性必须单独查。
 *
 * @param {string} text
 * @param {readonly (string | ReadonlySet<string>)[]} [titleSets]
 * @returns {{ index: number, title: string, at: number, bodyAt: number }[]}
 */
function isClosingFence(line, fence) {
  if (!fence) return false;
  const trimmed = line.replace(/^ {0,3}/, '').replace(/[ \t]+$/, '');
  if (trimmed.length < fence.length) return false;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== fence.ch) return false;
  }
  return true;
}

function findHeadings(text, titleSets = ACCEPTED_SECTION_TITLES) {
  const found = [];
  let fence = null;
  const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  let offset = 0;
  for (const raw of lines) {
    const line = raw.replace(/(?:\r\n|\r|\n)$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (isClosingFence(line, fence)) fence = null;
    } else if (marker && !(marker[1][0] === '`' && line.slice(marker[0].length).includes('`'))) {
      fence = { ch: marker[1][0], length: marker[1].length };
    } else {
      const match = /^ {0,3}##[ \t]+(\d+)\.\s*(.*?)\s*$/.exec(line);
      if (match) {
        const number = Number(match[1]);
        if (isAcceptedHeadingTitle(number, match[2], titleSets)) {
          found.push({ index: number, title: match[2], at: offset, bodyAt: offset + line.length });
        }
      }
    }
    offset += raw.length;
  }
  return found;
}

/** Render originals deterministically; arbitrary headings/fences in user text remain data. */
export function renderVerbatimUserMessages(messages) {
  if (!messages.length) return 'No user messages in this span.';
  return messages.map((item, index) => {
    const blocks = Array.isArray(item.blocks) ? item.blocks : [{ type: 'text', text: item.text ?? '' }];
    return `### User message ${index + 1} (seq ${item.seq})\n` + blocks.map((block, i) => {
      const text = String(block.text ?? '');
      let longest = 2;
      for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
      const fence = '`'.repeat(longest + 1);
      return `Block ${i + 1}\n${fence}text\n${text}\n${fence}`;
    }).join('\n\n');
  }).join('\n\n');
}

/** Section six is generated from the independent source set, never trusted to model copying. */
export function materializeUserMessageSection(text, expected, language = 'en') {
  const check = validateSummaryStructure(text, { language });
  if (!check.ok) { const e = new Error(check.message); e.code = check.code; throw e; }
  const headings = findHeadings(text);
  const sixth = headings.find(h => h.index === 6), seventh = headings.find(h => h.index === 7);
  return text.slice(0, sixth.bodyAt) + '\n\n' + renderVerbatimUserMessages(expected) + '\n\n' + text.slice(seventh.at);
}

/** Only the source-verified sixth section is excluded from prose contradiction checks. */
export function summaryProse(text) {
  text = String(text ?? '');
  const headings = findHeadings(text);
  const sixth = headings.find(h => h.index === 6), seventh = headings.find(h => h.index === 7);
  if (sixth && seventh && seventh.at > sixth.at) return text.slice(0, sixth.at) + text.slice(seventh.at);
  return text;
}

const CONTINUATION_SECTION_TITLES = ['Goal', 'State', 'Next', 'Uncertain'];

function topLevelJsonKeys(source) {
  let depth = 0;
  let inString = false;
  let escape = false;
  let expectKey = false;
  let captureStart = -1;
  const keys = [];
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') {
        inString = false;
        if (captureStart >= 0) {
          keys.push(JSON.parse(source.slice(captureStart, i + 1)));
          captureStart = -1;
        }
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      if (depth === 1 && expectKey) {
        captureStart = i;
        expectKey = false;
      }
      continue;
    }
    if (ch === '{' || ch === '[') {
      if (depth === 0 && ch === '{') {
        depth = 1;
        expectKey = true;
      } else {
        depth += 1;
      }
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) break;
      continue;
    }
    if (ch === ',' && depth === 1) expectKey = true;
  }
  return keys;
}

/**
 * Unwraps a strict top-level JSON dictionary matching the 9 required checkpoint
 * headings (or 4 continuation headings) in exact order back into Markdown.
 */
export function unwrapJsonSectionMap(rawText, options = {}) {
  if (typeof rawText !== 'string') return rawText;
  let candidate = rawText.trim();
  const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(candidate);
  if (fenced) candidate = fenced[1].trim();
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) return rawText;

  let rawKeys;
  let parsed;
  try {
    rawKeys = topLevelJsonKeys(candidate);
    parsed = JSON.parse(candidate);
  } catch {
    return rawText;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return rawText;
  const entries = Object.entries(parsed);
  if (
    rawKeys.length !== entries.length ||
    new Set(rawKeys).size !== rawKeys.length ||
    rawKeys.includes('__proto__') ||
    rawKeys.some((k, idx) => k !== entries[idx][0])
  ) {
    return rawText;
  }

  const normalizeBody = (val) => {
    const norm = (s) => s.replace(/\r\n|\r/g, '\n').trim();
    if (typeof val === 'string') return norm(val);
    if (Array.isArray(val) && val.every((item) => typeof item === 'string')) return val.map((item) => norm(item)).join('\n');
    return null;
  };

  const visitUnfencedLines = (bodyText, onLine) => {
    let fence = null;
    for (const raw of String(bodyText ?? '').split(/\r\n|\r|\n/)) {
      if (fence !== null) {
        if (isClosingFence(raw, fence)) fence = null;
        continue;
      }
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
      if (marker && !(marker[1][0] === '`' && raw.slice(marker[0].length).includes('`'))) {
        fence = { ch: marker[1][0], length: marker[1].length };
        if (onLine) onLine(null);
        continue;
      }
      if (onLine && onLine(raw) === false) return false;
    }
    return fence === null;
  };

  const hasBalancedFences = (bodyText) => visitUnfencedLines(bodyText, null);

  const hasBalancedFencesAndNoLevel2Heading = (bodyText) => {
    let prevNonBlank = false;
    return visitUnfencedLines(bodyText, (raw) => {
      if (raw === null) {
        prevNonBlank = false;
        return true;
      }
      if (/^ {0,3}#{1,2}(?:[ \t]+|$)/.test(raw)) return false;
      if (prevNonBlank && /^ {0,3}(?:=+|-+)[ \t]*$/.test(raw)) return false;
      prevNonBlank = raw.trim().length > 0 && !/^ {0,3}(?:>|\*(?:\s*\*){2,}\s*$)/.test(raw);
      return true;
    });
  };

  const extractContHeadings = (bodyText) => {
    const headings = [];
    const balanced = visitUnfencedLines(bodyText, (raw) => {
      if (raw === null) return true;
      const m = /^ {0,3}##[ \t]+(.+?)[ \t]*$/.exec(raw);
      if (m) headings.push(`## ${m[1]}`);
      return true;
    });
    return balanced ? headings : null;
  };

  const expectedContHeadings = CONTINUATION_SECTION_TITLES.map((t) => `## ${t}`);

  if (entries.length === 1 && typeof entries[0][1] === 'string') {
    const inner = entries[0][1].replace(/\r\n|\r/g, '\n').trim();
    if (!hasBalancedFences(inner)) return rawText;
    const verified = findHeadings(inner).map((h) => h.index);
    if (
      validateSummaryStructure(inner, options).ok === true &&
      JSON.stringify(verified) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9])
    ) {
      return inner;
    }
    const contHeadings = extractContHeadings(inner);
    if (contHeadings && JSON.stringify(contHeadings) === JSON.stringify(expectedContHeadings)) {
      return inner;
    }
    return rawText;
  }

  if (entries.length === ACCEPTED_SECTION_TITLES.length) {
    const sections = [];
    for (let i = 0; i < ACCEPTED_SECTION_TITLES.length; i += 1) {
      const [key, value] = entries[i];
      const keyMatch = /^(?:##[ \t]+)?(\d+)\.\s*(.*?)\s*$/.exec(String(key).trim());
      const validKey =
        keyMatch !== null &&
        Number(keyMatch[1]) === i + 1 &&
        isAcceptedHeadingTitle(i + 1, keyMatch[2]);
      const body = validKey ? normalizeBody(value) : null;
      if (body === null || !hasBalancedFencesAndNoLevel2Heading(body)) return rawText;
      sections.push(`## ${i + 1}. ${keyMatch[2]}\n${body}`);
    }
    const assembled = sections.join('\n\n');
    if (validateSummaryStructure(assembled, options).ok !== true) return rawText;
    const verified = findHeadings(assembled).map((h) => h.index);
    if (JSON.stringify(verified) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9])) return rawText;
    return assembled;
  }

  if (entries.length === CONTINUATION_SECTION_TITLES.length) {
    const sections = [];
    for (let i = 0; i < CONTINUATION_SECTION_TITLES.length; i += 1) {
      const [key, value] = entries[i];
      const headingRe = new RegExp(`^(?:##[ \\t]+)?${escapeRegExp(CONTINUATION_SECTION_TITLES[i])}$`);
      const body = headingRe.test(String(key).trim()) ? normalizeBody(value) : null;
      if (body === null || !hasBalancedFencesAndNoLevel2Heading(body)) return rawText;
      sections.push(`## ${CONTINUATION_SECTION_TITLES[i]}\n${body}`);
    }
    const assembled = sections.join('\n\n');
    const contHeadings = extractContHeadings(assembled);
    if (!contHeadings || JSON.stringify(contHeadings) !== JSON.stringify(expectedContHeadings)) return rawText;
    return assembled;
  }

  return rawText;
}

/**
 * 摘要正文必须包含全部九个小节，**按编号顺序**、**每个编号恰好一次**，
 * 且第六节必须有实际内容（不能只写 `(none)`）。
 *
 * 第六节是"用户原话"的落脚点：检查点里虽然另有一段逐字原话，
 * 但模型读摘要时看的就是这一节。整节写成 `(none)` 等于把"用户要什么"
 * 从摘要里删掉，只留一堆技术笔记。
 *
 * @param {string} summaryText 模型返回的摘要正文
 * @param {{ language?: 'zh'|'en' }} [options]
 * @returns {{ ok: true, sections: number } | { ok: false, code: string, message: string }}
 */
export function validateSummaryStructure(summaryText, options = {}) {
  const text = typeof summaryText === 'string' ? summaryText : '';
  if (text.trim().length === 0) {
    return { ok: false, code: 'EMPTY_SUMMARY', message: 'the summary is empty' };
  }

  const preferredTitles = options.language === 'zh' ? ZH_SECTION_TITLES : EN_SECTION_TITLES;
  const headings = findHeadings(text);

  const seen = new Map();
  const duplicates = [];
  for (const heading of headings) {
    const count = (seen.get(heading.index) ?? 0) + 1;
    seen.set(heading.index, count);
    if (count === 2) duplicates.push(heading.index);
  }

  const missing = [];
  for (let number = 1; number <= preferredTitles.length; number += 1) {
    if (!seen.has(number)) missing.push(`${number}. ${preferredTitles[number - 1]}`);
  }

  if (missing.length > 0) {
    return {
      ok: false,
      code: 'SUMMARY_STRUCTURE_INVALID',
      message: `the summary is missing ${missing.length} required section(s): ${missing.join('; ')}`,
    };
  }
  if (duplicates.length > 0) {
    return {
      ok: false,
      code: 'SUMMARY_STRUCTURE_INVALID',
      message: `the summary repeats section(s) ${duplicates.join(', ')}; each section must appear exactly once`,
    };
  }

  // 顺序：第一次出现的编号序列必须严格递增。
  const order = headings.map((heading) => heading.index);
  for (let position = 1; position < order.length; position += 1) {
    if (order[position] <= order[position - 1]) {
      return {
        ok: false,
        code: 'SUMMARY_STRUCTURE_INVALID',
        message: `the summary sections are out of order (found ${order[position - 1]} before ${order[position]}); sections must follow 1..${preferredTitles.length}`,
      };
    }
  }

  // 第六节正文：取该标题行结束到下一个标题之间的内容。
  const userHeading = headings.find((heading) => heading.index === USER_MESSAGE_SECTION + 1);
  const nextHeading = headings.find((heading) => heading.at > userHeading.at);
  const sectionBody = text
    .slice(userHeading.bodyAt, nextHeading === undefined ? text.length : nextHeading.at)
    .trim();
  const bare = sectionBody.replace(/^[-*\d.、\s]+/, '').trim();
  const meaningless = bare.length === 0 || /^(\(none\)|\(无\)|（无）|none|n\/a|na|无|没有|暂无|略|待补充|-+|—+|…+|\.\.\.)$/i.test(bare);
  if (meaningless) {
    return {
      ok: false,
      code: 'SUMMARY_STRUCTURE_INVALID',
      message: `section ${USER_MESSAGE_SECTION + 1} (${preferredTitles[USER_MESSAGE_SECTION]}) is empty; it must list the user messages`,
    };
  }

  return { ok: true, sections: preferredTitles.length, userSectionBody: sectionBody };
}

/**
 * 第六节必须**逐条**交代来源区间里的每一条用户消息。
 *
 * 只查"这一节非空"是不够的：写一句 `用户希望继续` 也是非空，但三条用户要求
 * 里有两条根本没被提到，下一个模型读摘要时不会有任何线索知道它们存在。
 *
 * 只接受逐字原话按来源顺序出现；引擎以确定性渲染器生成最终清单。
 * 单独 seq 引用不等于逐字原文，不再放行。
 *
 * ⚠️ 曾经这里有一条"整节只要写了 `<preserved-user-messages>` 就放行"的豁免。
 * 它站不住：那等于说"保留段存在"可以替代"摘要交代过"。而保留段只保证原话
 * 还在，管不了模型在摘要里把用户的要求理解成什么 —— 用户写「不要删生产数据」，
 * 摘要写「删掉生产数据」，保留段一个字不差地躺着，豁免照样放行，两份矛盾
 * 的指令一起进检查点。所以这条豁免被删除：**逐条**就是逐条。
 *
 * ⚠️ 比对用的是**来源全集**，不是我们自己挑出来的保留列表：后者挑漏了，
 * 两边一起漏，校验会自己跟自己对上。
 *
 * @param {string} sectionBody 第六节正文
 * @param {readonly {seq:number, blocks?:{type:'text',text:string}[], text?:string}[]} expected
 * @returns {{ ok: true, listed: number } | { ok: false, code: string, message: string }}
 */
export function validateUserMessageSection(sectionBody, expected) {
  const list = Array.isArray(expected) ? expected : [];
  const body = typeof sectionBody === 'string' ? sectionBody : '';
  if (list.length === 0) return { ok: true, listed: 0 };

  if (body.trim() === renderVerbatimUserMessages(list).trim()) return { ok: true, listed: list.length };
  // Raw quoted lists remain accepted only when all original blocks occur in source order.
  let cursor = 0;
  for (const item of list) {
    const parts = Array.isArray(item.blocks) ? item.blocks.map(b => b.text) : [item.text ?? ''];
    for (const part of parts) {
      if (typeof part !== 'string') return { ok: false, code: 'SUMMARY_STRUCTURE_INVALID', message: 'invalid source text block' };
      const at = body.indexOf(part, cursor);
      if (at < 0) return { ok: false, code: 'SUMMARY_STRUCTURE_INVALID', message: `section 6 must reproduce every user message verbatim and in order (missing seq ${item.seq}); seq references alone are insufficient` };
      cursor = at + part.length;
    }
  }
  return { ok: true, listed: list.length };
}

/**
 * 拼好的检查点里，必须逐字包含被压区间里的每一条用户原话。
 *
 * 这是"用户原话不丢"的**兜底**：即使模型在摘要里把某条请求概括错了，
 * 原话仍然躺在 `<preserved-user-messages>` 里，下一个模型读得到。
 * 所以这里比对的是最终要写进 surface 的 `checkpointBlocks`，
 * 而不是模型返回的 `summaryText`。
 *
 * ⚠️ `expected` 是**来源全集**，不能省。只比对 `preserved`（我们自己挑出来的
 * 列表）等于让自己给自己判卷：挑漏了一条，两边一起漏，校验照样通过。
 * 调用方必须把"区间里真实存在的用户消息"也传进来，两边取并集来查。
 *
 * @param {readonly {type:string, text:string}[]} checkpointBlocks
 * @param {readonly {seq:number, blocks?:{type:'text',text:string}[], text?:string}[]} preserved
 * @param {{ expected?: readonly {seq:number, blocks?:{type:'text',text:string}[], text?:string}[] }} [options]
 * @returns {{ ok: true, covered: number } | { ok: false, code: string, message: string }}
 */
export function validateCheckpointCoverage(checkpointBlocks, preserved, options = {}) {
  const required = [];
  const pushAll = (list) => {
    if (!Array.isArray(list)) return;
    for (const item of list) if (item && typeof item === 'object') required.push(item);
  };
  pushAll(preserved);
  pushAll(options.expected);
  if (required.length === 0) return { ok: true, covered: 0 };

  const haystack = (Array.isArray(checkpointBlocks) ? checkpointBlocks : [])
    .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
    .join('\n');

  const missing = [];
  for (const item of required) {
    const parts =
      Array.isArray(item.blocks) && item.blocks.length > 0
        ? item.blocks.map((block) => block?.text).filter((value) => typeof value === 'string')
        : typeof item.text === 'string'
          ? [item.text]
          : [];
    // 来源事件里被摊平后只剩空白的内容没什么可校验的，跳过而不是判失败。
    const meaningful = parts.filter((part) => part.trim().length > 0);
    if (meaningful.length === 0) continue;
    // ⚠️ 逐块比对，不能把多块 join 起来比。检查点渲染时块之间会插入
    // `--- seq N block i ---` 分隔行，join 出来的整串永远不可能作为子串出现，
    // 那样多块消息会被判成"没覆盖"，好好的压缩被无谓地拦下来。
    const present = meaningful.every((part) => haystack.includes(part));
    if (!present && !missing.includes(typeof item.seq === 'number' ? item.seq : -1)) {
      missing.push(typeof item.seq === 'number' ? item.seq : -1);
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      code: 'CHECKPOINT_COVERAGE_INCOMPLETE',
      message:
        `${missing.length} user message(s) from the compacted span are not reproduced verbatim ` +
        `in the checkpoint (seq ${missing.join(', ')})`,
    };
  }

  return { ok: true, covered: required.length };
}
