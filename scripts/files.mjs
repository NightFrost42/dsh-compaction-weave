import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const projectRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const sourceEntries=['lib','locale','test','scripts','docs','package.json','cordis.patch.yml','README.md','README.en.md','CHANGELOG.md','LICENSE','.gitignore','.gitattributes','.github'];
export function filesUnder(root,entries) {
  const files=[];
  function visit(relative) {
    const absolute=path.join(root,relative),stat=fs.lstatSync(absolute);
    if(stat.isSymbolicLink())throw new Error('Symbolic link in release source: '+relative);
    if(stat.isDirectory())for(const name of fs.readdirSync(absolute).sort())visit(path.join(relative,name));
    else if(stat.isFile())files.push(relative.split(path.sep).join('/'));
    else throw new Error('Unsupported release entry: '+relative);
  }
  for(const entry of entries)visit(entry);
  return files.sort();
}
