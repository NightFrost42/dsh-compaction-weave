import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {projectRoot,sourceEntries,filesUnder} from './files.mjs';

const pkg=JSON.parse(fs.readFileSync(path.join(projectRoot,'package.json'),'utf8'));
assert.equal(pkg.name,'dsh-compaction-weave');
assert.equal(pkg.private,undefined,'Release package must be publishable.');
assert.equal(pkg.license,'MIT');
assert.equal(pkg.engines.dsh,'>=0.2.2-rc.1 <1.0.0-0');
assert.equal(pkg.engines.node,'>=24.9.0');
assert.match(pkg.version,/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/);
assert.deepEqual(pkg.files,['lib','locale','cordis.patch.yml','README.md','README.en.md','LICENSE','CHANGELOG.md','docs']);
assert.equal(pkg.dsh.bundle.patch,'./cordis.patch.yml');
for(const entry of Object.values(pkg.exports)) {
  if(entry.includes('*'))assert.ok(fs.existsSync(path.join(projectRoot,path.dirname(entry))));
  else assert.ok(fs.statSync(path.join(projectRoot,entry)).isFile(),'Missing export '+entry);
}
const files=filesUnder(projectRoot,sourceEntries),errors=[];
const secret=/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const personal=/[A-Z]:[/\\]Users[/\\](?!Public\b|Default\b)[^/\\\s]+[/\\]|\/home\/(?!user\/)[^/\s]+\//i;
for(const relative of files) {
  const absolute=path.join(projectRoot,relative),text=fs.readFileSync(absolute,'utf8');
  if(secret.test(text))errors.push(relative+': possible credential');
  if(personal.test(text))errors.push(relative+': personal absolute path');
  if(/\.(?:js|mjs)$/.test(relative)) {
    const result=spawnSync(process.execPath,['--check',absolute],{encoding:'utf8',windowsHide:true});
    if(result.status!==0)errors.push(relative+': '+(result.stderr||result.error?.message));
  }
  if(relative.endsWith('.json'))try{JSON.parse(text);}catch(error){errors.push(relative+': '+error.message);}
  if(relative.endsWith('.md')) {
    for(const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const link=match[1].split('#')[0];
      if(!link||/^\w+:/.test(link))continue;
      const target=path.resolve(path.dirname(absolute),decodeURIComponent(link));
      if(!fs.existsSync(target))errors.push(relative+': broken link '+link);
    }
    if(relative!=='CHANGELOG.md')for(const match of text.matchAll(/dsh-compaction-weave-(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)\.tgz/g)) {
      if(match[1]!==pkg.version)errors.push(relative+': install example version differs from package');
    }
  }
}
const REGEX_PREFIX_KEYWORDS = new Set([
  'return', 'throw', 'case', 'delete', 'void', 'typeof',
  'await', 'yield', 'in', 'instanceof', 'new', 'of', 'else', 'do',
]);

function skipTemplateSegment(text, startIdx, braceStack) {
  let i = startIdx;
  const len = text.length;
  while (i < len) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '$' && text[i + 1] === '{') {
      braceStack.push('tpl');
      return { nextIndex: i + 2, ended: false };
    }
    if (text[i] === '`') return { nextIndex: i + 1, ended: true };
    i += 1;
  }
  return { nextIndex: len, ended: true };
}

function scanTopLevelEsm(text) {
  const tokens = [];
  let i = 0;
  const len = text.length;
  let expectRegex = true;
  const braceStack = [];

  while (i < len) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i += 1; continue; }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i + 1 < len && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = i + 1 < len ? i + 2 : len;
      continue;
    }
    if (ch === '\'' || ch === '"') {
      const quote = ch;
      let val = '';
      i += 1;
      while (i < len && text[i] !== quote) {
        if (text[i] === '\\') { val += text.slice(i, i + 2); i += 2; continue; }
        val += text[i];
        i += 1;
      }
      if (i < len) i += 1;
      tokens.push({ type: 'string', value: val, depth: braceStack.length });
      expectRegex = false;
      continue;
    }
    if (ch === '`') {
      const res = skipTemplateSegment(text, i + 1, braceStack);
      if (!res.ended) tokens.push({ type: 'punct', value: '${', depth: braceStack.length - 1 });
      expectRegex = !res.ended;
      i = res.nextIndex;
      continue;
    }
    if (ch === '/' && expectRegex) {
      i += 1;
      let inClass = false;
      while (i < len) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        else if (text[i] === '/' && !inClass) { i += 1; break; }
        else if (text[i] === '\n') break;
        i += 1;
      }
      while (i < len && /[a-z]/i.test(text[i])) i += 1;
      tokens.push({ type: 'regex', value: '', depth: braceStack.length });
      expectRegex = false;
      continue;
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$') {
      const start = i;
      i += 1;
      while (i < len && /[A-Za-z0-9_$]/.test(text[i])) i += 1;
      const word = text.slice(start, i);
      tokens.push({ type: 'ident', value: word, depth: braceStack.length });
      expectRegex = REGEX_PREFIX_KEYWORDS.has(word);
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      while (i < len && /[0-9A-Za-z_.xbn]/.test(text[i])) i += 1;
      tokens.push({ type: 'num', value: '', depth: braceStack.length });
      expectRegex = false;
      continue;
    }
    if (ch === '{') {
      braceStack.push('brace');
      tokens.push({ type: 'punct', value: '{', depth: braceStack.length - 1 });
      expectRegex = true;
      i += 1;
      continue;
    }
    if (ch === '}') {
      const top = braceStack.pop();
      if (top === 'tpl') {
        const res = skipTemplateSegment(text, i + 1, braceStack);
        expectRegex = !res.ended;
        i = res.nextIndex;
        continue;
      }
      tokens.push({ type: 'punct', value: '}', depth: braceStack.length });
      expectRegex = false;
      i += 1;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === '++' || two === '--') {
      tokens.push({ type: 'punct', value: two, depth: braceStack.length });
      expectRegex = false;
      i += 2;
      continue;
    }
    tokens.push({ type: 'punct', value: ch, depth: braceStack.length });
    expectRegex = !(ch === ')' || ch === ']');
    i += 1;
  }

  const imports = [];
  let hasEsmStatement = false;
  for (let k = 0; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.depth !== 0 || t.type !== 'ident') continue;
    if (t.value === 'import') {
      const n = tokens[k + 1];
      if (!n || (n.type === 'punct' && (n.value === '(' || n.value === '.'))) continue;
      hasEsmStatement = true;
      if (n.type === 'string') { imports.push(n.value); continue; }
      for (let j = k + 1; j < tokens.length; j += 1) {
        if (tokens[j].depth === 0 && tokens[j].type === 'punct' && tokens[j].value === ';') break;
        if (tokens[j].depth === 0 && tokens[j].type === 'ident' && tokens[j].value === 'from' && tokens[j + 1]?.type === 'string') {
          imports.push(tokens[j + 1].value);
          break;
        }
      }
    } else if (t.value === 'export') {
      hasEsmStatement = true;
      for (let j = k + 1; j < tokens.length; j += 1) {
        if (tokens[j].depth === 0 && tokens[j].type === 'punct' && tokens[j].value === ';') break;
        if (tokens[j].depth === 0 && tokens[j].type === 'ident' && tokens[j].value === 'from' && tokens[j + 1]?.type === 'string') {
          imports.push(tokens[j + 1].value);
          break;
        }
        if (tokens[j].depth === 0 && tokens[j].type === 'ident' && ['function', 'async', 'class', 'const', 'let', 'var', 'default'].includes(tokens[j].value)) break;
      }
    }
  }
  return { imports, hasEsmStatement };
}

function extractDirectedCycle(graph, scc) {
  if (scc.length === 1) return [scc[0], scc[0]];
  const sccSet = new Set(scc);
  const start = scc[0];
  const path = [start];
  const seen = new Set([start]);
  const dfs = (u) => {
    for (const v of graph.get(u) ?? []) {
      if (!sccSet.has(v)) continue;
      if (v === start) return [...path, start];
      if (seen.has(v)) continue;
      seen.add(v);
      path.push(v);
      const found = dfs(v);
      if (found) return found;
      path.pop();
    }
    return null;
  };
  return dfs(start) ?? [...scc, start];
}

function findCircularSccs(graph) {
  let idx = 0;
  const indexMap = new Map();
  const lowMap = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];

  function strongconnect(v) {
    indexMap.set(v, idx);
    lowMap.set(v, idx);
    idx += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!indexMap.has(w)) {
        strongconnect(w);
        lowMap.set(v, Math.min(lowMap.get(v), lowMap.get(w)));
      } else if (onStack.has(w)) {
        lowMap.set(v, Math.min(lowMap.get(v), indexMap.get(w)));
      }
    }
    if (lowMap.get(v) === indexMap.get(v)) {
      const scc = [];
      for (;;) {
        const w = stack.pop();
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      if (scc.length > 1 || (graph.get(v) ?? []).includes(v)) {
        cycles.push(extractDirectedCycle(graph, scc.reverse()));
      }
    }
  }

  for (const v of graph.keys()) {
    if (!indexMap.has(v)) strongconnect(v);
  }
  return cycles;
}

const libJsFiles = files.filter((relative) => relative.startsWith('lib/') && relative.endsWith('.js'));
const libJsSet = new Set(libJsFiles);
const esmGraph = new Map();
for (const relative of libJsFiles) {
  const text = fs.readFileSync(path.join(projectRoot, relative), 'utf8');
  const { imports, hasEsmStatement } = scanTopLevelEsm(text);
  if (relative === 'lib/client.js') {
    if (hasEsmStatement) errors.push('lib/client.js: unexpected top-level ESM import/export statement');
    continue;
  }
  const deps = [];
  for (const spec of imports) {
    if (!spec.startsWith('.')) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), spec));
    if (libJsSet.has(resolved) && !deps.includes(resolved)) deps.push(resolved);
  }
  esmGraph.set(relative, deps);
}
for (const cycle of findCircularSccs(esmGraph)) {
  errors.push(`circular ESM dependency: ${cycle.join(' -> ')}`);
}

if(errors.length)throw new Error(errors.join('\n'));
console.log(`Checked ${files.length} release source files; package ${pkg.version}, syntax, links, content, and 0-cycle ESM DAG (${esmGraph.size} modules) checks passed.`);
