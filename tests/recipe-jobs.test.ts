import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {receiptsDir,verifySignature} from '../src/utils/receipts.js';
import {sha} from '../lanes/recipes/tray.js';
import {enqueue,start,status,cancel,recover,jobDirectory} from '../lanes/recipes/jobs.js';

const request={schema:'timmy.recipe-request/1',recipe:'enclosure.tray/1',parameters:{width:140,wall:3,supportOffset:10,bore:3}};
let root:string;
const wait=async(pred:()=>boolean)=>{const end=Date.now()+15000;while(!pred()){if(Date.now()>end)throw Error('Fake worker timeout');await new Promise(r=>setTimeout(r,50));}};
function executor(mode='complete'){
 const file=path.join(root,`fake-${mode}.mts`);
 const module=(name:string)=>JSON.stringify(pathToFileURL(path.resolve(name)).href);
 fs.writeFileSync(file,`
import fs from 'node:fs'; import path from 'node:path'; import {randomUUID} from 'node:crypto';
import {loadJob,jobDirectory,recordResult} from ${module('lanes/recipes/jobs.ts')};
import {appendReceipt} from ${module('src/utils/receipts.ts')};
import {sha} from ${module('lanes/recipes/tray.ts')};
const [,root,id]=process.argv.slice(2), job=loadJob(root,id), dir=jobDirectory(root,id), workspace=path.join(dir,'workspace');
fs.appendFileSync(path.join(dir,'executions.txt'),'fake execution\\n');
if(${JSON.stringify(mode)}==='fail')process.exit(3);
if(${JSON.stringify(mode)}==='wait')await new Promise(r=>setTimeout(r,10000));
const run=randomUUID(), base=path.join(workspace,'.timmy','recipe-runs',run);fs.mkdirSync(base,{recursive:true});
const input=path.join(base,'request.json');fs.writeFileSync(input,JSON.stringify(job.request));
const common={subject:'synthetic lifecycle test; no geometry claim',policy:'auto',status:'ok',cost_usd:0,env_lock:{os:{platform:'test'},tools:{}}};
fs.writeFileSync(path.join(base,'prediction.json'),JSON.stringify({synthetic:true}));fs.writeFileSync(path.join(base,'build.py'),'SYNTHETIC no-native source');
const predictionSources=['request.json','prediction.json','build.py'].map(file=>({path:path.join(base,file),sha256:sha(fs.readFileSync(path.join(base,file)))}));
const prediction=appendReceipt('runs',{...common,kind:'recipe.prediction',sources:predictionSources},workspace);
const native=path.join(base,'native');fs.mkdirSync(native);
const exports=['outer.stl','cavity.stl','bosses.stl','bores.stl','console-tray.step'].map(file=>{fs.writeFileSync(path.join(native,file),'SYNTHETIC lifecycle fixture; not geometry');return {file,sha256:sha(fs.readFileSync(path.join(native,file)))};});
fs.writeFileSync(path.join(native,'result.json'),'{}');fs.writeFileSync(path.join(base,'native.log'),'synthetic worker');
const sources=[path.join(native,'result.json'),path.join(base,'native.log'),...exports.map(e=>path.join(native,e.file))].map(file=>({path:file,sha256:sha(fs.readFileSync(file))}));
const receipt=appendReceipt('runs',{...common,kind:'recipe.build',child_receipts:[prediction.id],sources:${JSON.stringify(mode)}==='empty-sources'?[]:sources},workspace);
const result={state:'succeeded',run,receipt:receipt.id,receiptHash:receipt.hash,checksPassed:30,exports};fs.writeFileSync(path.join(base,'report.json'),JSON.stringify(result));
recordResult(root,id,{...result,directory:base});
`);return file;
}
const loader=createRequire(import.meta.url).resolve('tsx');
const worker=path.resolve('lanes/recipes/job-worker.ts');
const invoke=(id:string,env:NodeJS.ProcessEnv={})=>new Promise<number>((resolve,reject)=>{
 execFile(process.execPath,['--import',loader,worker,'execute',root,id],{timeout:10000,env:{...process.env,TIMMY_STORE:path.join(jobDirectory(root,id),'workspace','.timmy','receipts'),...env}},(error)=>{
  if(!error)return resolve(0);
  if(typeof error.code==='number')return resolve(error.code);
  reject(error);
 });
});
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'recipe-jobs-test-'));});
afterEach(()=>{fs.rmSync(root,{recursive:true,force:true});});
describe('durable recipe worker boundary (offline fake executor)',()=>{
 it('queues, completes in a separate process, and recovers an existing signed result without re-execution',async()=>{
  const job=enqueue(request,{root,executor:executor()});expect(job.state).toBe('queued');
  const id=job.job.id,dir=jobDirectory(root,id);
  await Promise.all([start(root,id),start(root,id)]);
  await wait(()=>status(root,id).state==='succeeded');
  expect(status(root,id).resultReceipt).toMatch(/^rc_/);
  expect(fs.readFileSync(path.join(dir,'executions.txt'),'utf8').trim().split('\n')).toHaveLength(1);
  fs.unlinkSync(path.join(dir,'terminal.json'));
  expect(recover(root,id).state).toBe('succeeded');
  await start(root,id);
  expect(fs.readFileSync(path.join(dir,'executions.txt'),'utf8').trim().split('\n')).toHaveLength(1);
  const result=JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8'));
  fs.appendFileSync(path.join(result.result.directory,'native','outer.stl'),'changed');
  expect(status(root,id).state).toBe('interrupted');
  expect((await start(root,id)).state).toBe('interrupted');
 });
 it('cancels before launch without executing',async()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id;
  expect(cancel(root,id).state).toBe('cancelled');expect((await start(root,id)).state).toBe('cancelled');
  expect(fs.existsSync(path.join(jobDirectory(root,id),'executions.txt'))).toBe(false);
 });
 it('cancels a running owned child and retains its partial output',async()=>{
  const id=enqueue(request,{root,executor:executor('wait')}).job.id,dir=jobDirectory(root,id);
  await start(root,id);await wait(()=>fs.existsSync(path.join(dir,'executions.txt')));
  expect(status(root,id).state).toBe('running');cancel(root,id);
  await wait(()=>status(root,id).state==='cancelled');
  expect(fs.existsSync(path.join(dir,'executions.txt'))).toBe(true);expect(fs.existsSync(path.join(dir,'result.json'))).toBe(false);
 });
 it('retains nonzero worker failure and never retries it',async()=>{
  const id=enqueue(request,{root,executor:executor('fail')}).job.id;
  await start(root,id);await wait(()=>status(root,id).state==='failed');
  expect((await start(root,id)).state).toBe('failed');
 });
 it('rejects changed source before launch',async()=>{
  const file=executor(),id=enqueue(request,{root,executor:file}).job.id;
  fs.appendFileSync(file,'\n// changed');await expect(start(root,id)).rejects.toThrow(/source changed/);
  expect(status(root,id).state).toBe('queued');
 });
 it('does not trust forged completion or replay an interrupted claim',async()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id);
  fs.writeFileSync(path.join(dir,'claim.json'),JSON.stringify({started:0}));
  fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({id,result:{state:'succeeded',receipt:'forged'}}));
  expect(recover(root,id).state).toBe('interrupted');expect((await start(root,id)).state).toBe('interrupted');
  expect(fs.existsSync(path.join(dir,'executions.txt'))).toBe(false);
 });
 it('rejects a tampered executable or Python binding before launch',async()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id),file=path.join(dir,'job.json');
  const original=JSON.parse(fs.readFileSync(file,'utf8'));
  for(const change of [{executor:'/tmp/not-admitted.mts'},{python:'/tmp/not-admitted-python'}]){
   fs.writeFileSync(file,JSON.stringify({...original,...change}));
   await expect(start(root,id)).rejects.toThrow(/binding mismatch/);
  }
  expect(fs.existsSync(path.join(dir,'executions.txt'))).toBe(false);
 });
 it('rejects a signed success with missing artifact sources',async()=>{
  const id=enqueue(request,{root,executor:executor('empty-sources')}).job.id,dir=jobDirectory(root,id);
  await start(root,id);await wait(()=>status(root,id).state==='failed');
  fs.unlinkSync(path.join(dir,'terminal.json'));
  expect(recover(root,id).state).toBe('interrupted');
  expect((await start(root,id)).state).toBe('interrupted');
 });
 it('never exposes a forged successful terminal marker as verified success',async()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id);
  const original=JSON.stringify({state:'succeeded',resultReceipt:'forged'});
  fs.writeFileSync(path.join(dir,'terminal.json'),original);
  expect(status(root,id).state).toBe('interrupted');
  expect((await start(root,id)).state).toBe('interrupted');
  expect(fs.readFileSync(path.join(dir,'terminal.json'),'utf8')).toBe(original);
  expect(fs.existsSync(path.join(dir,'executions.txt'))).toBe(false);
 });
 it('preserves a venv Python invocation symlink while pinning its target',async()=>{
  const python=path.join(root,'venv-python');fs.symlinkSync(process.execPath,python);
  const item=enqueue(request,{root,executor:executor(),python});
  expect(item.job.python).toBe(python);
  expect(item.job.pythonRealPath).toBe(fs.realpathSync(process.execPath));
  expect(item.job.sources.some(s=>s.file===item.job.pythonRealPath)).toBe(true);
  fs.unlinkSync(python);const alternate=path.join(root,'alternate-python');fs.writeFileSync(alternate,'fake');fs.symlinkSync(alternate,python);
  await expect(start(root,item.job.id)).rejects.toThrow(/source changed/);
 });
 it('refuses direct internal execution without a supervisor claim',async()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id);
  expect(await invoke(id)).toBe(1);
  expect(fs.existsSync(path.join(dir,'executions.txt'))).toBe(false);
  expect(fs.existsSync(path.join(dir,'native-execution.json'))).toBe(false);
 });
 it('allows only one of two concurrent internal execute invocations and recovers its signed result',async()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id);
  fs.writeFileSync(path.join(dir,'claim.json'),JSON.stringify({started:Date.now()}));
  fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify({started:Date.now()}));
  expect((await Promise.all([invoke(id),invoke(id)])).sort()).toEqual([0,1]);
  expect(fs.readFileSync(path.join(dir,'executions.txt'),'utf8').trim().split('\n')).toHaveLength(1);
  expect(recover(root,id).state).toBe('succeeded');
  expect(await invoke(id)).toBe(1);
  expect(fs.readFileSync(path.join(dir,'executions.txt'),'utf8').trim().split('\n')).toHaveLength(1);
 });
 it('retains the internal execution claim after an executor failure and refuses manual replay',async()=>{
  const id=enqueue(request,{root,executor:executor('fail')}).job.id,dir=jobDirectory(root,id);
  await start(root,id);await wait(()=>status(root,id).state==='failed');
  expect(fs.existsSync(path.join(dir,'native-execution.json'))).toBe(true);
  expect(await invoke(id)).toBe(1);
  expect(fs.readFileSync(path.join(dir,'executions.txt'),'utf8').trim().split('\n')).toHaveLength(1);
 });
 it('refuses manually executing a cancelled job even when supervisor markers exist',async()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id);
  fs.writeFileSync(path.join(dir,'claim.json'),JSON.stringify({started:Date.now()}));
  fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify({started:Date.now()}));
  cancel(root,id);expect(await invoke(id)).toBe(1);
  expect(fs.existsSync(path.join(dir,'executions.txt'))).toBe(false);
 });
 it('pins a private receipt store beneath a shared parent pin and refuses pin tampering',async()=>{
  const shared=path.join(root,'shared-receipts');fs.mkdirSync(shared);fs.mkdirSync(path.join(root,'.timmy'));
  fs.writeFileSync(path.join(root,'.timmy','store-pin'),shared);
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id),workspace=path.join(dir,'workspace');
  expect(receiptsDir(workspace)).toBe(path.join(workspace,'.timmy','receipts'));
  await start(root,id);await wait(()=>status(root,id).state==='succeeded');
  expect(fs.existsSync(path.join(shared,'runs.jsonl'))).toBe(false);
  fs.writeFileSync(path.join(workspace,'.timmy','store-pin'),shared);
  expect(()=>status(root,id)).toThrow(/store pin mismatch/);
  expect(fs.existsSync(path.join(shared,'runs.jsonl'))).toBe(false);
 });
 it('rejects a report and matching unsigned envelope edit without invalidating prior receipt history',async()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id);
  await start(root,id);await wait(()=>status(root,id).state==='succeeded');
  const file=path.join(dir,'result.json'),envelope=JSON.parse(fs.readFileSync(file,'utf8'));
  expect(verifySignature(envelope)).toBe(true);
  const reportPath=path.join(envelope.result.directory,'report.json'),report=JSON.parse(fs.readFileSync(reportPath,'utf8'));
  report.features=[{id:'forged-feature'}];fs.writeFileSync(reportPath,JSON.stringify(report));
  envelope.reportHash=sha(JSON.stringify(report));fs.writeFileSync(file,JSON.stringify(envelope));
  expect(verifySignature(envelope)).toBe(false);expect(status(root,id).state).toBe('interrupted');
  expect((await start(root,id)).state).toBe('interrupted');
  expect(fs.readFileSync(path.join(dir,'executions.txt'),'utf8').trim().split('\n')).toHaveLength(1);
 });
 it('refuses direct replay of an interrupted execution',async()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id);
  fs.writeFileSync(path.join(dir,'claim.json'),JSON.stringify({started:0}));
  fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify({started:0}));
  expect(recover(root,id).state).toBe('interrupted');expect(await invoke(id)).toBe(1);
  expect(fs.existsSync(path.join(dir,'executions.txt'))).toBe(false);
 });
 it('rejects altered or deleted frozen prediction artifacts during status and recovery',async()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id);
  await start(root,id);await wait(()=>status(root,id).state==='succeeded');
  const result=JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8'));
  const prediction=path.join(result.result.directory,'prediction.json'),original=fs.readFileSync(prediction);fs.appendFileSync(prediction,' ');
  expect(status(root,id).state).toBe('interrupted');
  fs.writeFileSync(prediction,original);
  fs.unlinkSync(path.join(result.result.directory,'build.py'));fs.unlinkSync(path.join(dir,'terminal.json'));
  expect(recover(root,id).state).toBe('interrupted');expect((await start(root,id)).state).toBe('interrupted');
  expect(fs.readFileSync(path.join(dir,'executions.txt'),'utf8').trim().split('\n')).toHaveLength(1);
 });
 it('honors cancellation during recovery while retaining a completed result',async()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id);
  await start(root,id);await wait(()=>status(root,id).state==='succeeded');
  fs.unlinkSync(path.join(dir,'terminal.json'));cancel(root,id);
  expect(recover(root,id).state).toBe('cancelled');expect(fs.existsSync(path.join(dir,'result.json'))).toBe(true);
  expect(await invoke(id)).toBe(1);
 });
 it('does not claim completed cancellation without a verified result or stopped worker',()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id);
  fs.writeFileSync(path.join(dir,'claim.json'),JSON.stringify({started:Date.now()}));
  fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify({started:Date.now()}));
  fs.writeFileSync(path.join(dir,'heartbeat.json'),JSON.stringify({at:Date.now()}));
  cancel(root,id);expect(recover(root,id)).toMatchObject({state:'running',progress:'cancellation-requested'});
  fs.writeFileSync(path.join(dir,'heartbeat.json'),JSON.stringify({at:0}));
  expect(recover(root,id).state).toBe('interrupted');
  expect(fs.existsSync(path.join(dir,'executions.txt'))).toBe(false);
 });
 it('never inherits an unbound Python from a direct caller environment',async()=>{
  const saved=process.env.TIMMY_CADQUERY_PYTHON;delete process.env.TIMMY_CADQUERY_PYTHON;
  let id:string;
  try{id=enqueue(request,{root}).job.id;}finally{if(saved!==undefined)process.env.TIMMY_CADQUERY_PYTHON=saved;}
  const dir=jobDirectory(root,id!);fs.writeFileSync(path.join(dir,'claim.json'),JSON.stringify({started:Date.now()}));
  fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify({started:Date.now()}));
  expect(await invoke(id!,{TIMMY_CADQUERY_PYTHON:process.execPath})).toBe(0);
  const envelope=JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8'));
  expect(envelope.result.state).toBe('failed');expect(envelope.result.error).toContain('Set TIMMY_CADQUERY_PYTHON');
  expect(envelope.result.error).not.toContain('Native execution failed');
 });
 it('rejects traversal and symlinked metadata',()=>{
  expect(()=>status(root,'../outside')).toThrow(/UUID/);
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id);
  fs.renameSync(path.join(dir,'job.json'),path.join(dir,'original.json'));
  fs.symlinkSync(path.join(dir,'original.json'),path.join(dir,'job.json'));
  expect(()=>status(root,id)).toThrow(/regular job file/);
 });
});
