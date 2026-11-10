import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

const project=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args=process.argv.slice(2);
let host=false,hostModules=process.env.DSH_TEST_NODE_MODULES;
while(args.length) {
  const flag=args.shift();
  if(flag==='--host')host=true;
  else if(flag==='--host-modules'&&args.length){host=true;hostModules=path.resolve(args.shift());}
  else throw new Error('Unknown test option: '+flag);
}
if(host&&!hostModules)throw new Error('Set DSH_TEST_NODE_MODULES to the DSH runtime node_modules directory.');
if(host) {
  const info=JSON.parse(fs.readFileSync(path.join(hostModules,'@deepseek-ai/dsh-session/package.json'),'utf8'));
  const pkg=JSON.parse(fs.readFileSync(path.join(project,'package.json'),'utf8'));
  if(info.version!==pkg.engines.dsh)throw new Error(`Expected DSH ${pkg.engines.dsh}; found ${info.version}.`);
}
const reportDir=path.join(project,'.local','test-results',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(reportDir,{recursive:true});
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'weave-tests-'));
const preload=path.join(project,'test/helpers/isolate.mjs');
const jobs=fs.readdirSync(path.join(project,'test')).filter(n=>n.endsWith('.mjs')).sort().map(n=>['unit/'+n,path.join(project,'test',n)]);
if(host)for(const n of fs.readdirSync(path.join(project,'test/integration')).filter(n=>n.endsWith('.mjs')).sort())jobs.push(['host/'+n,path.join(project,'test/integration',n)]);
function counts(text) {
  try {
    const value=JSON.parse(text),rows=Array.isArray(value)?value:value.results;
    if(Array.isArray(rows))return {passed:rows.filter(x=>x.pass===true).length,failed:rows.filter(x=>x.pass===false).length};
    return {passed:value.passed??value.pass??0,failed:value.failed??value.fail??0};
  }catch{
    return {passed:Number(/(\d+)\s+passed/.exec(text)?.[1]??0),failed:Number(/(\d+)\s+failed/.exec(text)?.[1]??0)};
  }
}
const results=[];let index=0;
async function worker() {
  while(index<jobs.length) {
    const [name,file]=jobs[index++],started=Date.now();
    const temp=path.join(scratch,name.replaceAll('/','-'));
    fs.mkdirSync(temp,{recursive:true});
    const result=await new Promise(resolve=>{
      let stdout='',stderr='',timedOut=false;
      const child=spawn(process.execPath,['--import',pathToFileURL(preload).href,file],{
        cwd:temp,windowsHide:true,
        env:{...process.env,TEMP:temp,TMP:temp,TMPDIR:temp,DSH_HOME:path.join(temp,'dsh'),WEAVE_TEST_ROOT:temp,PLUGIN_UNDER_TEST:project,...(host?{DSH_TEST_NODE_MODULES:hostModules}:{})},
      });
      child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
      child.on('error',e=>stderr+=e.message);
      const timer=setTimeout(()=>{timedOut=true;child.kill();},180000);
      child.on('close',code=>{
        clearTimeout(timer);
        const log=name.replaceAll('/','-')+'.log';
        fs.writeFileSync(path.join(reportDir,log),stdout+stderr);
        resolve({name,exit:code,timedOut,...counts(stdout),milliseconds:Date.now()-started,log});
      });
    });
    results.push(result);
    console.log(`${result.exit===0&&!result.failed&&result.passed?'PASS':'FAIL'} ${name} (${result.passed} cases)`);
  }
}
await Promise.all([worker(),worker(),worker()]);
results.sort((a,b)=>a.name.localeCompare(b.name));
const failedSuites=results.filter(r=>r.exit!==0||r.failed>0||r.passed===0).length;
const report={version:JSON.parse(fs.readFileSync(path.join(project,'package.json'))).version,date:new Date().toISOString(),node:process.version,platform:process.platform,hostIntegration:host,suites:results.length,passed:results.reduce((n,r)=>n+r.passed,0),failedSuites,results};
fs.writeFileSync(path.join(reportDir,'summary.json'),JSON.stringify(report,null,2)+'\n');
fs.writeFileSync(path.join(project,'.local','latest-tests.json'),JSON.stringify(report,null,2)+'\n');
// Only remove the scratch directory that this invocation created.
if(!failedSuites)fs.rmSync(scratch,{recursive:true,force:true});
console.log(JSON.stringify({passed:report.passed,failedSuites,report:path.join(reportDir,'summary.json'),...(failedSuites?{scratch}:{})},null,2));
if(failedSuites)process.exitCode=1;
