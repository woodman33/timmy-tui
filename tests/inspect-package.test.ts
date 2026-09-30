import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
// @ts-expect-error explicit plain JavaScript build helper
import {copyRuntimeAssets} from '../scripts/copy-runtime-assets.mjs';

const repository=fileURLToPath(new URL('../',import.meta.url));
let fixture:string,install:string,guard:string,maker:string,failed=false;
function write(file:string,bytes:string){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);}
function snapshot(root:string):[string,string|Buffer][]{return fs.readdirSync(root,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
 const file=path.join(root,entry.name),relative=path.relative(install,file);
 if(entry.isDirectory())return [[relative,'directory'] as [string,string|Buffer],...snapshot(file)];
 if(entry.isSymbolicLink())return [[relative,'link:'+fs.readlinkSync(file)] as [string,string|Buffer]];
 return [[relative,fs.readFileSync(file)] as [string,string|Buffer]];
});}
function unchanged(root:string,original:[string,string|Buffer][]){
 const actual=snapshot(root);expect(actual.map(([file])=>file)).toEqual(original.map(([file])=>file));
 for(let i=0;i<original.length;i++){
  const expected=original[i][1],value=actual[i][1];
  if(Buffer.isBuffer(expected))expect(Buffer.isBuffer(value)&&value.equals(expected),original[i][0]).toBe(true);
  else expect(value,original[i][0]).toBe(expected);
 }
}
function env(caller:string):NodeJS.ProcessEnv{return {PATH:path.dirname(process.execPath),HOME:caller,TMPDIR:path.join(fixture,'tmp'),XDG_CONFIG_HOME:caller,NODE_OPTIONS:`--import=${pathToFileURL(guard).href}`,INSPECT_INSTALL:install,INSPECT_GUARD_LOG:path.join(fixture,'guard.jsonl')};}
function caller(){return fs.mkdtempSync(path.join(fixture,'synthetic-caller-'));}
function invoke(root:string,...args:string[]){return spawnSync(process.execPath,[path.join(install,'dist/timmy.js'),'inspect',...args],{cwd:root,env:env(root),encoding:'utf8',timeout:10000});}
function retained(root:string,radius=4.5){return JSON.parse(execFileSync(process.execPath,[maker,String(radius)],{cwd:root,env:env(root),encoding:'utf8',timeout:10000}));}
function ok(root:string,...args:string[]){const run=invoke(root,...args);expect(run.error).toBeUndefined();expect(run.status,run.stderr).toBe(0);return JSON.parse(run.stdout);}
function refused(root:string,reason:string,...args:string[]){const run=invoke(root,...args);expect(run.error).toBeUndefined();expect(run.status).toBe(1);expect(JSON.parse(run.stderr)).toMatchObject({state:'unavailable',reason:expect.stringContaining(reason)});}

beforeAll(()=>{
 try{
 fixture=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'inspect-package-')));
 const delivered=process.env.TIMMY_INSPECT_PACKAGE_INSTALL;
 install=delivered?fs.realpathSync(delivered):path.join(fixture,'install');if(!delivered)fs.mkdirSync(install);fs.mkdirSync(path.join(fixture,'tmp'));
 if(!delivered){
 write(path.join(install,'package.json'),'{"type":"module"}');
 const require=createRequire(import.meta.url),compiler=path.join(path.dirname(require.resolve('typescript/package.json')),'bin/tsc');
 execFileSync(process.execPath,[compiler,'--project',path.join(repository,'tsconfig.json'),'--outDir',path.join(install,'dist')],{cwd:repository,timeout:60000});
 copyRuntimeAssets(repository,path.join(install,'dist'));
 // Inspect has a real production zod dependency. Copy its observed installed
 // bytes for this isolated compiled control; no development tool is delivered.
 const zod=path.dirname(require.resolve('zod/package.json'));
 const lock=JSON.parse(fs.readFileSync(path.join(repository,'package-lock.json'),'utf8'));
 expect(JSON.parse(fs.readFileSync(path.join(zod,'package.json'),'utf8')).version).toBe(lock.packages['node_modules/zod'].version);
 fs.cpSync(zod,path.join(install,'node_modules/zod'),{recursive:true});
 }
 guard=path.join(fixture,'guard.mjs');write(guard,`import cp from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
const entries=['dist/src/cli.js','dist/lanes/recipes/spatial03/inspect.js'].map(p=>path.join(process.env.INSPECT_INSTALL,p));
for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']){const original=cp[method];cp[method]=function(file,args,...rest){const allowed=['spawn','spawnSync'].includes(method)&&file===process.execPath&&Array.isArray(args)&&entries.includes(args[0]);fs.appendFileSync(process.env.INSPECT_GUARD_LOG,JSON.stringify({method,file,args,allowed})+'\\n');if(!allowed)throw Error('Inspect control refused subprocess');return original.call(this,file,args,...rest);};}syncBuiltinESMExports();`);
 maker=path.join(fixture,'synthetic-retained-scene.mjs');
 const module=(file:string)=>JSON.stringify(pathToFileURL(path.join(install,'dist',file)).href);
 write(maker,`import fs from 'node:fs';import path from 'node:path';import {appendReceipt} from ${module('src/utils/receipts.js')};import {sha} from ${module('lanes/recipes/tray.js')};import {scene} from ${module('lanes/recipes/spatial03/scene.js')};
// SYNTHETIC contract data and signatures only. No observation/native process.
const root=process.cwd(),dir=path.join(root,'.timmy/spatial03'),store=path.join(root,'.timmy/receipts');fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(store,{recursive:true});fs.writeFileSync(path.join(root,'.timmy/store-pin'),store+'\\n');
const o={synthetic:true,measuredAt:'2000-01-01T00:00:00.000Z',units:'mm',variants:[100,140,180].map(w=>({variant:'w'+w,features:['A','B','C','D'].map(id=>({id,radius:1.5,axisAtBase:[['A','C'].includes(id)?-(w/2-10):w/2-10,['A','B'].includes(id)?30:-30,0],zSpan:[0,11],checks:{radius:true,axisParallelZ:true,xEdgeOffset:true,yEdgeOffset:true,zSpan:true,completeCylindricalFace:true}}))}))};
const observations=path.join(dir,'observations.json');fs.writeFileSync(observations,JSON.stringify(o));const revision=sha(fs.readFileSync(observations));
const common={policy:'auto',status:'ok',cost_usd:0,discrepancies:['SYNTHETIC package fixture; no native observation'],env_lock:{os:{platform:'synthetic'},arch:'synthetic',tools:{},models:{}}};
const native=appendReceipt('runs',{...common,kind:'spatial.observation',subject:'spatial-t5k1.phase2.native',sources:[{path:observations,sha256:revision}]},root);
const view=scene(o,native.id,revision,Number(process.argv[2]));const file=path.join(dir,'scene.json');fs.writeFileSync(file,JSON.stringify(view));
const receipt=appendReceipt('runs',{...common,status:Number(process.argv[2])>5?'failed':'ok',kind:'spatial.scene',subject:'spatial-t5k1.phase2.scene',sources:[{path:file,sha256:sha(fs.readFileSync(file))}]},root);fs.writeFileSync(path.join(dir,'current.json'),JSON.stringify({receipt:receipt.id}));
console.log(JSON.stringify({receipt:receipt.id,revision,observations,file,synthetic:true}));`);
 }catch(error){failed=true;throw error;}
},60000);
afterEach(context=>{if(context.task.result?.state==='fail')failed=true;});
afterAll(()=>{
 try{
  if(!failed){const launches=fs.readFileSync(path.join(fixture,'guard.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));expect(launches.length).toBeGreaterThan(0);expect(launches.every(r=>r.allowed===true)).toBe(true);}
 }catch(error){failed=true;throw error;}
 finally{if(failed)console.warn('Retained synthetic inspect fixture: '+fixture);else if(fixture)fs.rmSync(fixture,{recursive:true,force:true});}
});

describe('compiled inspect delivery with synthetic retained contract data',()=>{
 it('reads the caller store through the real bin, preserves frame and analytical limits',()=>{
  const before=snapshot(install),root=caller(),record=retained(root),evidence=snapshot(root);
  for(const name of ['tsx','typescript','vitest'])expect(fs.existsSync(path.join(install,'node_modules',name))).toBe(false);
  expect(()=>createRequire(path.join(install,'dist/timmy.js')).resolve('tsx')).toThrow();
  expect(ok(root,'clearance')).toMatchObject({state:'passed',gapMm:2.5,basis:'analytical',revision:record.revision,observedAt:'2000-01-01T00:00:00.000Z',displayTransformOnly:true,unmeasured:['complete tool path','physical validation']});
  expect(ok(root,'frame','--frame','world','--unit','m','--rotation','90')).toMatchObject({point:[-.03,-.06,.011],frame:{id:'world',unit:'m',rotationZ:90}});
  expect(ok(root,'arrows').arrows.map((a:any)=>a.kind)).toEqual(['materialization','dependency','hypothesis']);
  expect(ok(root,'empty spaces','--receipt',record.receipt).features.every((f:any)=>f.basis==='analytical'&&!f.nativeBuilt)).toBe(true);
  unchanged(install,before);unchanged(root,evidence);
 });
 it('refuses absent, changed scene and changed observation evidence',()=>{
  const before=snapshot(install),empty=caller();refused(empty,'ENOENT','coverage');expect(fs.readdirSync(empty)).toEqual([]);
  const root=caller(),record=retained(root),original=fs.readFileSync(record.file);
  refused(root,'Scene seal unavailable','coverage','--receipt','foreign-fixture-receipt');
  fs.appendFileSync(record.file,' ');const alteredScene=snapshot(root);refused(root,'Scene source drift','coverage');unchanged(root,alteredScene);fs.writeFileSync(record.file,original);
  fs.appendFileSync(record.observations,' ');const alteredObservation=snapshot(root);refused(root,'Native source drift','coverage');unchanged(root,alteredObservation);
  unchanged(install,before);
 });
 it('preserves the under-2 mm analytical refusal and observed timestamp',()=>{
  const before=snapshot(install),root=caller();retained(root,5.5);const evidence=snapshot(root);
  const run=invoke(root,'clearance');expect(run.status).toBe(1);
  expect(JSON.parse(run.stdout)).toMatchObject({state:'failed',basis:'analytical',gapMm:1.5,minimumMm:2,observedAt:'2000-01-01T00:00:00.000Z'});
  unchanged(install,before);unchanged(root,evidence);
 });
 it.skipIf(Boolean(process.env.TIMMY_INSPECT_PACKAGE_INSTALL))('resolves source inspection from an unrelated caller without changing retained data',()=>{
  const root=caller();retained(root);const before=snapshot(install),evidence=snapshot(root);
  const loader=createRequire(import.meta.url).resolve('tsx');
  const result=JSON.parse(execFileSync(process.execPath,['--import',loader,path.join(repository,'timmy.ts'),'inspect','frame'],{cwd:root,timeout:10000,encoding:'utf8',env:{PATH:path.dirname(process.execPath),HOME:root,TMPDIR:path.join(fixture,'tmp')}}));
  expect(result.frame).toMatchObject({id:'part',unit:'mm'});unchanged(install,before);unchanged(root,evidence);
 });
});
