import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {projectRoot,sourceEntries,filesUnder} from './files.mjs';

const pkg=JSON.parse(fs.readFileSync(path.join(projectRoot,'package.json'),'utf8'));
assert.equal(pkg.name,'dsh-compaction-weave');
assert.equal(pkg.private,undefined,'Release package must be publishable.');
assert.equal(pkg.license,'MIT');
assert.equal(pkg.engines.dsh,'>=0.2.2-rc.1 <0.3.0-0');
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
    for(const match of text.matchAll(/dsh-compaction-weave-(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)\.tgz/g)) {
      if(match[1]!==pkg.version)errors.push(relative+': install example version differs from package');
    }
  }
}
if(errors.length)throw new Error(errors.join('\n'));
console.log(`Checked ${files.length} release source files; package ${pkg.version}, syntax, links and content checks passed.`);
