import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
// @ts-expect-error explicit plain JavaScript build helper
import {copyRuntimeAssets} from '../scripts/copy-runtime-assets.mjs';

const repository=fileURLToPath(new URL('../',import.meta.url));
const request={schema:'timmy.recipe-request/1',recipe:'enclosure.tray/1',parameters:{width:140,wall:3,supportOffset:10,bore:3}};
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
let fixture:string,install:string,caller:string,guard:string,failed=false;
function write(file:string,bytes:string){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);}
function manifest(dir:string):unknown[]{return fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
 const file=path.join(dir,entry.name),stat=fs.lstatSync(file),relative=path.relative(install,file);
 if(stat.isSymbolicLink())return [{path:relative,kind:'link',target:fs.readlinkSync(file)}];
 if(stat.isDirectory())return [{path:relative,kind:'directory'},...manifest(file)];
 return [{path:relative,kind:'file',hash:digest(fs.readFileSync(file))}];
});}
const env=():NodeJS.ProcessEnv=>({PATH:path.dirname(process.execPath),HOME:path.join(fixture,'home'),TMPDIR:path.join(fixture,'tmp'),XDG_CONFIG_HOME:path.join(fixture,'config'),NODE_OPTIONS:`--import=${pathToFileURL(guard).href}`,RECIPE_INSTALL:install,RECIPE_GUARD_LOG:path.join(fixture,'guard.jsonl')});
function command(...args:string[]){return spawnSync(process.execPath,[path.join(install,'dist/timmy.js'),'recipe',...args],{cwd:caller,env:env(),encoding:'utf8',timeout:15000});}
function json(...args:string[]){const run=command(...args);expect(run.error).toBeUndefined();expect(run.status,run.stderr).toBe(0);return JSON.parse(run.stdout);}

beforeAll(()=>{
 try{
 fixture=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'recipe-package-')));
 const delivered=process.env.TIMMY_RECIPE_PACKAGE_INSTALL;
 install=delivered?fs.realpathSync(delivered):path.join(fixture,'install');caller=path.join(fixture,'caller');
 for(const name of [...(delivered?[]:['install']),'caller','home','tmp','config'])fs.mkdirSync(path.join(fixture,name));
 if(!delivered){
 write(path.join(install,'package.json'),'{"type":"module"}');
 // Real compiler and actual dispatcher source. No bundled or substituted CLI,
 // development loader, dependency symlink, or source fallback in this fixture.
 const compiler=path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')),'bin/tsc');
 execFileSync(process.execPath,[compiler,'--project',path.join(repository,'tsconfig.json'),'--outDir',path.join(install,'dist')],{cwd:repository,timeout:60000});
 copyRuntimeAssets(repository,path.join(install,'dist'));
 }
 guard=path.join(fixture,'guard.mjs');
 write(guard,`import cp from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
const entries=['dist/src/cli.js','dist/lanes/recipes/cli.js','dist/lanes/recipes/job-worker.js'].map(p=>path.join(process.env.RECIPE_INSTALL,p));
for(const method of ['spawn','spawnSync','execFile','execFileSync','exec','execSync','fork']){
 const original=cp[method];cp[method]=function(file,args,...rest){
  const allowed=['spawn','spawnSync'].includes(method)&&file===process.execPath&&Array.isArray(args)&&entries.includes(args[0])&&!args.includes('--import');
  fs.appendFileSync(process.env.RECIPE_GUARD_LOG,JSON.stringify({method,file,args,allowed})+'\\n');
  if(!allowed)throw Error('Package smoke refused subprocess');return original.call(this,file,args,...rest);
 };
}syncBuiltinESMExports();`);
 write(path.join(caller,'request with spaces.json'),JSON.stringify(request));
 write(path.join(caller,'zero wall.json'),JSON.stringify({...request,parameters:{...request.parameters,wall:0}}));
 }catch(error){failed=true;throw error;}
},60000);
afterEach(context=>{if(context.task.result?.state==='fail')failed=true;});
afterAll(()=>{
 if(failed){console.warn('Retained package fixture: '+fixture);return;}
 if(fixture)fs.rmSync(fixture,{recursive:true,force:true});
});

describe('source recipe dispatcher',()=>{
 it.skipIf(Boolean(process.env.TIMMY_RECIPE_PACKAGE_INSTALL)).each(['src/cli.ts','timmy.ts'])('resolves the %s development loader while preserving an unrelated caller',(entry)=>{
  const sourceLoader=createRequire(import.meta.url).resolve('tsx');
  const output=execFileSync(process.execPath,['--import',sourceLoader,path.join(repository,entry),'recipe','plan','--request','request with spaces.json'],{cwd:caller,timeout:15000,encoding:'utf8',env:{PATH:path.dirname(process.execPath),HOME:path.join(fixture,'home'),TMPDIR:path.join(fixture,'tmp'),XDG_CONFIG_HOME:path.join(fixture,'config')}});
  expect(JSON.parse(output)).toMatchObject({bounds:[140,80,30]});
  expect(fs.existsSync(path.join(caller,'.timmy'))).toBe(false);
 });
});

describe('compiled recipe delivery without source or development dependencies',()=>{
 it('uses the real bin and caller workspace for plans, refusal and queued lifecycle',()=>{
  const before=manifest(install);
  if(!process.env.TIMMY_RECIPE_PACKAGE_INSTALL)expect(fs.existsSync(path.join(install,'node_modules'))).toBe(false);
  for(const dependency of ['tsx','typescript','vitest'])expect(fs.existsSync(path.join(install,'node_modules',dependency))).toBe(false);
  expect(()=>createRequire(path.join(install,'dist/timmy.js')).resolve('tsx')).toThrow();
  expect(json('list')).toMatchObject({id:'enclosure.tray/1'});
  expect(json('plan','--request','request with spaces.json')).toMatchObject({bounds:[140,80,30],widthChange:{mustRebuild:['tray.outer','tray.cavity','tray.bosses','tray.bores']}});
  const invalid=command('plan','--request','zero wall.json');expect(invalid.status).toBe(1);expect(invalid.stderr).toContain('positive wall');
  const queued=json('jobs','enqueue','--request','request with spaces.json');expect(queued.state).toBe('queued');
  const expected=['jobs.js','tray.js','enclosure-tray/recipe.json','enclosure-tray/build.py','job-worker.js'].map(file=>path.join(install,'dist/lanes/recipes',file));
  expect(queued.job.sources.map((s:any)=>s.file)).toEqual(expected);
  for(const source of queued.job.sources)expect(source.hash).toBe(digest(fs.readFileSync(source.file)));
  expect(queued.job.executor).toBe(expected.at(-1));
  const id=queued.job.id;
  expect(json('jobs','status',id).state).toBe('queued');
  expect(json('jobs','cancel',id).state).toBe('cancelled');
  expect(json('jobs','recover',id).state).toBe('cancelled');
  expect(json('jobs','start',id).state).toBe('cancelled');
  expect(fs.existsSync(path.join(caller,'.timmy/recipe-jobs',id,'claim.json'))).toBe(false);
  expect(manifest(install)).toEqual(before);
 });

 it('runs compiled workers, retaining the exact signed missing-runtime failure without replay',()=>{
  const before=manifest(install),queued=json('jobs','enqueue','--request','request with spaces.json'),id=queued.job.id;
  const runner=path.join(fixture,'observe-worker.mjs');
  const module=(file:string)=>JSON.stringify(pathToFileURL(path.join(install,'dist',file)).href);
  write(runner,`import {start,cancel,status,jobDirectory} from ${module('lanes/recipes/jobs.js')};import {verifySignature} from ${module('src/utils/receipts.js')};import fs from 'node:fs';import path from 'node:path';
const root=process.cwd(),id=process.argv[2];let child,closed=false,finish;const done=new Promise(r=>finish=r);let close;
const timer=setTimeout(()=>{try{cancel(root,id);}catch{}},8000);
async function drain(ms){let timeout;try{await Promise.race([done,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Owned package supervisor did not close')),ms);})]);}finally{clearTimeout(timeout);}}
try{await start(root,id,{onSupervisor:c=>{child=c;c.ref();c.once('close',(code,signal)=>{closed=true;close={code,signal};finish();});}});await drain(10000);
const result=status(root,id),dir=jobDirectory(root,id),envelope=JSON.parse(fs.readFileSync(path.join(dir,'result.json'))),base=envelope.result.directory;
const report=JSON.parse(fs.readFileSync(path.join(base,'report.json'))),receipts=fs.readFileSync(path.join(dir,'workspace/.timmy/receipts/runs.jsonl'),'utf8').trim().split('\\n').map(JSON.parse).filter(r=>r.hash);
console.log(JSON.stringify({result,close,report,validEnvelope:verifySignature(envelope),receipts:receipts.map(r=>({kind:r.kind,status:r.status,valid:verifySignature(r),id:r.id,hash:r.hash,children:r.child_receipts})),nativeExists:fs.existsSync(path.join(base,'native'))}));
}finally{clearTimeout(timer);if(child&&!closed){
 try{cancel(root,id);await drain(5000);}catch(error){
  fs.writeFileSync(path.join(root,'owned-worker-timeout.json'),JSON.stringify({pid:child.pid,closed,reason:String(error),descendantOutcome:'unknown; fixture retained'}));
  if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}
  await drain(1000);throw error;
 }
}}`);
  const probe=JSON.parse(execFileSync(process.execPath,[runner,id],{cwd:caller,env:env(),encoding:'utf8',timeout:20000}));
  const output=process.env.TIMMY_RECIPE_TEST_ARTIFACT_DIR;
  if(output){fs.mkdirSync(output,{recursive:true});fs.appendFileSync(path.join(output,'observed-package-results.jsonl'),JSON.stringify({install,caller,node:process.version,probe,launches:fs.readFileSync(path.join(fixture,'guard.jsonl'),'utf8')})+'\n');}
  expect(probe.close).toEqual({code:0,signal:null});
  expect(probe.result).toMatchObject({state:'failed',progress:'finished',resultReceipt:probe.report.receipt,resultHash:probe.report.receiptHash});
  expect(probe.report).toMatchObject({state:'failed',exports:[],checksPassed:null,error:'Error: Set TIMMY_CADQUERY_PYTHON to the native runtime absolute path'});
  expect(probe.validEnvelope).toBe(true);expect(probe.nativeExists).toBe(false);
  expect(probe.receipts.map((r:any)=>[r.kind,r.status,r.valid])).toEqual([['recipe.prediction','ok',true],['recipe.build','failed',true]]);
  expect(probe.receipts[1].children).toEqual([probe.receipts[0].id]);
  const job=path.join(caller,'.timmy/recipe-jobs',id),claim=fs.readFileSync(path.join(job,'native-execution.json'));
  expect(json('jobs','start',id).state).toBe('failed');expect(json('jobs','recover',id).state).toBe('failed');
  expect(fs.readFileSync(path.join(job,'native-execution.json'))).toEqual(claim);
  const launches=fs.readFileSync(path.join(fixture,'guard.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  expect(launches.filter(r=>r.allowed).every(r=>r.file===process.execPath&&r.args[0].endsWith('.js'))).toBe(true);
  expect(launches.some(r=>r.allowed&&r.args[0].endsWith('/job-worker.js')&&r.args[1]==='supervise')).toBe(true);
  expect(launches.some(r=>r.allowed&&r.args[0].endsWith('/job-worker.js')&&r.args[1]==='execute')).toBe(true);
  expect(launches.filter(r=>!r.allowed).every(r=>['sh','sw_vers','uname'].includes(r.file))).toBe(true);
  expect(manifest(install)).toEqual(before);
 });

 it('refuses a changed installed source before launching a queued worker',()=>{
  const queued=json('jobs','enqueue','--request','request with spaces.json'),id=queued.job.id;
  const file=path.join(install,'dist/lanes/recipes/tray.js'),original=fs.readFileSync(file);
  try{
   fs.appendFileSync(file,'\n// known changed runtime control\n');
   const result=command('jobs','start',id);expect(result.status).toBe(1);expect(result.stderr).toContain('source changed');
   expect(fs.existsSync(path.join(caller,'.timmy/recipe-jobs',id,'claim.json'))).toBe(false);
  }finally{fs.writeFileSync(file,original);}
  expect(json('jobs','cancel',id).state).toBe('cancelled');
 });
});
