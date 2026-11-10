import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {projectRoot,sourceEntries,filesUnder} from './files.mjs';

const pkg=JSON.parse(fs.readFileSync(path.join(projectRoot,'package.json'),'utf8'));
const out=path.join(projectRoot,'dist');
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
execFileSync(process.execPath,[path.join(projectRoot,'scripts/check.mjs')],{cwd:projectRoot,stdio:'inherit',windowsHide:true});
fs.mkdirSync(out,{recursive:true});
const npmArgs=['pack','--ignore-scripts','--json','--pack-destination',out];
let npmCommand='npm',args=npmArgs;
if(process.env.npm_execpath){npmCommand=process.execPath;args=[process.env.npm_execpath,...npmArgs];}
else if(process.platform==='win32'){
  npmCommand=process.execPath;
  args=[path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),...npmArgs];
}
const packed=JSON.parse(execFileSync(npmCommand,args,{cwd:projectRoot,encoding:'utf8',windowsHide:true}))[0];
if(packed.name!==pkg.name||packed.version!==pkg.version)throw new Error('Packed package identity differs.');
const runtime=filesUnder(projectRoot,[...pkg.files,'package.json']);
const listed=packed.files.map(x=>x.path).sort();
if(JSON.stringify(listed)!==JSON.stringify(runtime))throw new Error('npm payload differs from the release whitelist.');
const source=filesUnder(projectRoot,sourceEntries);
const sourceName=`${pkg.name}-${pkg.version}-source.tar.gz`;
const tar=process.platform==='win32'?'tar.exe':'tar';
execFileSync(tar,['-czf',path.join(out,sourceName),...sourceEntries],{cwd:projectRoot,windowsHide:true});
const archives=[packed.filename,sourceName].map(name=>({name,bytes:fs.statSync(path.join(out,name)).size,sha256:hash(path.join(out,name))}));
const fileHashes=files=>Object.fromEntries(files.map(name=>[name,hash(path.join(projectRoot,name))]));
const manifest={name:pkg.name,version:pkg.version,createdAt:new Date().toISOString(),node:process.version,dsh:pkg.engines.dsh,archives,runtimeFiles:fileHashes(runtime),sourceFiles:fileHashes(source)};
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
fs.writeFileSync(path.join(out,'SHA256SUMS.txt'),archives.map(a=>`${a.sha256}  ${a.name}`).join('\n')+'\n');
console.log(JSON.stringify({version:pkg.version,runtimeFiles:runtime.length,sourceFiles:source.length,archives,output:out},null,2));
