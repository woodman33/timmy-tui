import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {spawn,ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import {receiptsDir,verifySignature} from '../src/utils/receipts.js';
import {keysPath,loadOrCreateKeys,signBody} from '../src/utils/signing.js';
import {sha} from '../lanes/recipes/tray.js';
import {enqueue,start as startJob,status,cancel,recover,jobDirectory,supervise} from '../lanes/recipes/jobs.js';

const request={schema:'timmy.recipe-request/1',recipe:'enclosure.tray/1',parameters:{width:140,wall:3,supportOffset:10,bore:3}};
let root:string;
type Owned={child:ChildProcess;id:string;supervisor:boolean;closed:boolean;done:Promise<void>};
let owned:Owned[],diagnostics:unknown[],cancellationFailures:number,retained:boolean;
let controllers:{id:string;done:Promise<void>;closed:boolean}[];
function observe(child:ChildProcess,id:string,supervisor:boolean){
 const events=diagnostics;
 let finish!:()=>void;const entry:Owned={child,id,supervisor,closed:false,done:new Promise(r=>{finish=r;})};owned.push(entry);
 child.once('error',error=>events.push({id,supervisor,error:error.message,code:(error as NodeJS.ErrnoException).code}));
 child.once('close',(code,signal)=>{entry.closed=true;events.push({id,supervisor,code,signal});finish();});return entry;
}
const start=(jobRoot:string,id:string)=>startJob(jobRoot,id,{onSupervisor:child=>observe(child,id,true)});
function supervised(id:string,onClose:(code:number|null)=>void){
 const events=diagnostics,entry={id,done:Promise.resolve(),closed:false};
 entry.done=supervise(root,id,{onExecutionClosed:(code,signal)=>{events.push({id,supervisedClose:{code,signal}});onClose(code);}}).finally(()=>{entry.closed=true;});
 controllers.push(entry);return entry.done;
}
async function drainOwned(deadline=5000){
 for(const entry of [...owned.filter(x=>x.supervisor),...controllers])if(!entry.closed){
  try{cancel(root,entry.id);}catch(error){cancellationFailures++;diagnostics.push({id:entry.id,cancellationError:error instanceof Error?error.message:String(error)});}
 }
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([Promise.all([...owned,...controllers].map(entry=>entry.done)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned fixture worker did not close; fixture retained')),deadline);})]);}
 finally{if(timer)clearTimeout(timer);}
}
function retainFailure(error?:unknown,assertionErrors?:unknown){
 retained=true;
 const detail={root,node:process.version,diagnostics,assertionErrors,teardownError:error instanceof Error?error.message:error,openChildren:owned.filter(x=>!x.closed).map(x=>({id:x.id,supervisor:x.supervisor,pid:x.child.pid})),openControllers:controllers.filter(x=>!x.closed).map(x=>x.id)};
 fs.writeFileSync(path.join(root,'test-failure.json'),JSON.stringify(detail,null,2),{mode:0o600});
 const output=process.env.TIMMY_RECIPE_TEST_ARTIFACT_DIR;
 if(output){fs.mkdirSync(output,{recursive:true,mode:0o700});fs.appendFileSync(path.join(output,'retained-fixtures.jsonl'),JSON.stringify(detail)+'\n',{mode:0o600});}
 console.warn('Retained recipe fixture diagnostics: '+root);
}
function snapshotBeforeCleanup(){
 const snapshot=path.join(root,'before-cleanup');fs.mkdirSync(snapshot,{mode:0o700});
 for(const id of new Set([...owned.filter(x=>x.supervisor).map(x=>x.id),...controllers.map(x=>x.id)])){
  const dir=jobDirectory(root,id),dest=path.join(snapshot,id);fs.mkdirSync(dest,{mode:0o700});
  for(const name of ['worker.log','terminal.json','heartbeat.json','claim.json','execution.json','native-execution.json','result.json']){
   const file=path.join(dir,name);if(fs.existsSync(file)&&fs.lstatSync(file).isFile())fs.writeFileSync(path.join(dest,name),fs.readFileSync(file),{mode:0o600});
  }
 }
}
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
const failed=${JSON.stringify(mode)}.startsWith('reported-failure');
const receipt=appendReceipt('runs',{...common,status:failed?'failed':'ok',kind:'recipe.build',child_receipts:[prediction.id],sources:${JSON.stringify(mode)}==='empty-sources'?[]:sources},workspace);
const result={state:failed?'failed':'succeeded',run,receipt:receipt.id,receiptHash:receipt.hash,checksPassed:failed?0:30,exports:failed?[]:exports};fs.writeFileSync(path.join(base,'report.json'),JSON.stringify(result));
recordResult(root,id,{...result,directory:base});
if(${JSON.stringify(mode)}==='cancel-after-result')fs.writeFileSync(path.join(dir,'cancel.json'),JSON.stringify({requested:Date.now()}));
if(${JSON.stringify(mode)}==='tamper-result')fs.appendFileSync(path.join(base,'native.log'),'tampered');
if(${JSON.stringify(mode)}==='malformed-result-exit-error')fs.writeFileSync(path.join(dir,'result.json'),'{');
if(${JSON.stringify(mode)}.endsWith('exit-error'))process.exitCode=3;
`);return file;
}
const loader=createRequire(import.meta.url).resolve('tsx');
const worker=path.resolve('lanes/recipes/job-worker.ts');
const invoke=(id:string,env:NodeJS.ProcessEnv={})=>new Promise<number>((resolve,reject)=>{
 const events=diagnostics;
 const child=spawn(process.execPath,['--import',loader,worker,'execute',root,id],{detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,TIMMY_STORE:path.join(jobDirectory(root,id),'workspace','.timmy','receipts'),...env}});
 const entry=observe(child,id,false);let stdout='',stderr='',timedOut=false;
 child.stdout?.on('data',b=>{stdout+=b;});child.stderr?.on('data',b=>{stderr+=b;});
 const timer=setTimeout(()=>{timedOut=true;if(!entry.closed&&child.pid)try{process.kill(-child.pid,'SIGKILL');}catch(error){events.push({id,killError:String(error)});}},10000);
 child.once('error',error=>{clearTimeout(timer);reject(error);});
 child.once('close',(code,signal)=>{clearTimeout(timer);const detail={id,code,signal,timedOut,stdout,stderr};events.push(detail);
  if(!timedOut&&typeof code==='number')resolve(code);
  else reject(Error('Direct fixture worker failed: '+JSON.stringify(detail)));
 });
});
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'recipe-jobs-test-'));owned=[];controllers=[];diagnostics=[];cancellationFailures=0;retained=false;});
afterEach(async context=>{
 vi.restoreAllMocks();if(!fs.existsSync(root))return;
 const failed=context.task.result?.state==='fail';let snapshotError:unknown;
 try{if(failed)snapshotBeforeCleanup();}catch(error){snapshotError=error;diagnostics.push({snapshotError:error instanceof Error?error.message:String(error)});}
 let teardownError:unknown;try{await drainOwned();}catch(error){teardownError=error;}
 if(teardownError||snapshotError||failed||cancellationFailures||retained){retainFailure(teardownError??snapshotError,context.task.result?.errors);if(teardownError||snapshotError)throw teardownError??snapshotError;return;}
 fs.rmSync(root,{recursive:true,force:true});
});
describe('durable recipe worker boundary (offline fake executor)',()=>{
 it('keeps late child-close diagnostics with their original fixture',async()=>{
  const original=diagnostics,child=new ChildProcess(),entry=observe(child,'late-close-control',false);
  diagnostics=[];child.emit('close',0,null);await entry.done;
  expect(original).toContainEqual({id:'late-close-control',supervisor:false,code:0,signal:null});expect(diagnostics).toEqual([]);
 });
 it('never exposes a partially written terminal marker to status during recovery',()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id),terminal=path.join(dir,'terminal.json');
  fs.writeFileSync(path.join(dir,'claim.json'),JSON.stringify({started:0}));
  const open=fs.openSync.bind(fs),write=fs.writeFileSync.bind(fs);let publicationFd:number|undefined,observations=0;
  vi.spyOn(fs,'openSync').mockImplementation((file,flags,mode)=>{const fd=open(file,flags,mode);if(String(file).startsWith(terminal+'.'))publicationFd=fd;return fd;});
  vi.spyOn(fs,'writeFileSync').mockImplementation((file,data,options)=>{
   if(file===publicationFd||file===terminal){
    const fd=typeof file==='number'?file:open(file,'wx',0o600),bytes=Buffer.from(String(data)),half=Math.floor(bytes.length/2);
    try{fs.writeSync(fd,bytes.subarray(0,half));expect(status(root,id).state).toBe('running');observations++;fs.writeSync(fd,bytes.subarray(half));}
    finally{if(typeof file!=='number')fs.closeSync(fd);}
   }else write(file,data,options);
  });
  expect(recover(root,id).state).toBe('interrupted');expect(observations).toBe(1);
  vi.restoreAllMocks();expect(JSON.parse(fs.readFileSync(terminal,'utf8')).state).toBe('interrupted');
  const retained=fs.readFileSync(terminal);recover(root,id);expect(fs.readFileSync(terminal)).toEqual(retained);
  expect(fs.readdirSync(dir).filter(name=>name.startsWith('terminal.json.'))).toEqual([]);
 });
 it('preserves an incumbent terminal marker that wins the publication race',()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id),terminal=path.join(dir,'terminal.json');
  fs.writeFileSync(path.join(dir,'claim.json'),JSON.stringify({started:0}));
  const link=fs.linkSync.bind(fs),winner=JSON.stringify({state:'cancelled',progress:'cancelled-before-start'});
  vi.spyOn(fs,'linkSync').mockImplementation((source,target)=>{if(target===terminal)fs.writeFileSync(terminal,winner,{flag:'wx'});link(source,target);});
  expect(recover(root,id).state).toBe('cancelled');expect(fs.readFileSync(terminal,'utf8')).toBe(winner);
  expect(fs.readdirSync(dir).filter(name=>name.startsWith('terminal.json.'))).toEqual([]);
 });
 it('waits for the actual owned supervisor to close before removing its fixture',async()=>{
  const id=enqueue(request,{root,executor:executor('wait')}).job.id,dir=jobDirectory(root,id);
  await start(root,id);await wait(()=>fs.existsSync(path.join(dir,'heartbeat.json')));
  expect(owned.some(entry=>entry.id===id&&!entry.closed)).toBe(true);
  await drainOwned();expect(owned.every(entry=>entry.closed)).toBe(true);expect(status(root,id).state).toBe('cancelled');
  fs.rmSync(root,{recursive:true,force:true});expect(fs.existsSync(root)).toBe(false);
 });
 it('retains the fixture when an owned child does not meet the teardown deadline',async()=>{
  const probe=path.join(root,'probe.txt');fs.writeFileSync(probe,'retained');
  const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'}),entry=observe(child,'teardown-control',false);
  try{await expect(drainOwned(1)).rejects.toThrow(/did not close; fixture retained/);retainFailure('Expected teardown negative control');
   expect(fs.readFileSync(probe,'utf8')).toBe('retained');expect(fs.existsSync(path.join(root,'test-failure.json'))).toBe(true);
  }finally{if(!entry.closed)child.kill('SIGKILL');await entry.done;}
 });
 it('reports observer errors without rejecting an already launched supervisor',async()=>{
  const id=enqueue(request,{root,executor:executor('fail')}).job.id,warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  await expect(startJob(root,id,{onSupervisor:child=>{observe(child,id,true);throw Error('observer control');}})).resolves.toBeDefined();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('observer failed after launch'));
  await wait(()=>status(root,id).state==='failed');
 });
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
 it('keeps a verified result when cancellation arrives before supervise records completion',async()=>{
  const id=enqueue(request,{root,executor:executor('cancel-after-result')}).job.id;
  await start(root,id);await wait(()=>status(root,id).state==='cancelled');
  const observed=status(root,id);
  expect(observed).toMatchObject({state:'cancelled',progress:'finished',reason:'Cancellation requested; completed native result retained; no replay'});
  expect(observed.resultReceipt).toMatch(/^rc_/);expect(observed.resultHash).toBeTruthy();
 });
 it.each(['complete','reported-failure'])('revalidates cancelled %s result references on status and recovery without rewriting metadata',async mode=>{
  const id=enqueue(request,{root,executor:executor(mode)}).job.id,dir=jobDirectory(root,id);
  await start(root,id);await wait(()=>['succeeded','failed'].includes(status(root,id).state));
  const original=status(root,id);expect(original.resultReceipt).toMatch(/^rc_/);expect(original.resultHash).toBeTruthy();
  fs.unlinkSync(path.join(dir,'terminal.json'));cancel(root,id);
  expect(recover(root,id)).toMatchObject({state:'cancelled',resultReceipt:original.resultReceipt,resultHash:original.resultHash});
  expect(status(root,id).reason).toMatch(/completed native result retained/);
  const retained=['terminal.json','result.json'].map(name=>({name,bytes:fs.readFileSync(path.join(dir,name))}));
  const envelope=JSON.parse(retained[1].bytes.toString());
  fs.unlinkSync(path.join(envelope.result.directory,mode==='complete'?'native/outer.stl':'native.log'));
  for(const observed of [status(root,id),recover(root,id)]){
   expect(observed).toMatchObject({state:'interrupted',progress:'verification-failed'});
   expect(observed).not.toHaveProperty('resultReceipt');expect(observed).not.toHaveProperty('resultHash');
  }
  for(const item of retained)expect(fs.readFileSync(path.join(dir,item.name))).toEqual(item.bytes);
  expect(fs.existsSync(path.join(dir,'recovered.json'))).toBe(false);
  expect(await invoke(id)).toBe(1);
  expect(fs.readFileSync(path.join(dir,'executions.txt'),'utf8').trim().split('\n')).toHaveLength(1);
 });
 it('revalidates a failed native result receipt before exposing it after failure',async()=>{
  const id=enqueue(request,{root,executor:executor('reported-failure')}).job.id,dir=jobDirectory(root,id);
  await start(root,id);await wait(()=>status(root,id).state==='failed');
  expect(status(root,id).resultReceipt).toMatch(/^rc_/);
  const retained=['terminal.json','result.json'].map(name=>({name,bytes:fs.readFileSync(path.join(dir,name))}));
  const envelope=JSON.parse(retained[1].bytes.toString());fs.appendFileSync(path.join(envelope.result.directory,'native.log'),'changed');
  for(const observed of [status(root,id),recover(root,id)]){
   expect(observed).toMatchObject({state:'interrupted',progress:'verification-failed'});
   expect(observed).not.toHaveProperty('resultReceipt');expect(observed).not.toHaveProperty('resultHash');
  }
  for(const item of retained)expect(fs.readFileSync(path.join(dir,item.name))).toEqual(item.bytes);
  expect(fs.existsSync(path.join(dir,'recovered.json'))).toBe(false);
 });
 it('refuses mismatched, incomplete or malformed result references across terminal states without repairing markers',async()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id);
  await start(root,id);await wait(()=>status(root,id).state==='succeeded');
  const original=status(root,id),file=path.join(dir,'terminal.json');
  const cases=[
   {state:'cancelled',resultReceipt:original.resultReceipt,resultHash:'wrong'},
   {state:'cancelled',resultReceipt:'wrong',resultHash:original.resultHash},
   {state:'cancelled',resultReceipt:original.resultReceipt},
   {state:'cancelled',resultHash:original.resultHash},
   {state:'cancelled',resultReceipt:null,resultHash:original.resultHash},
   {state:'cancelled',resultReceipt:original.resultReceipt,resultHash:''},
   {state:'failed',resultReceipt:original.resultReceipt,resultHash:original.resultHash},
   {state:'interrupted',resultReceipt:original.resultReceipt,resultHash:original.resultHash},
   {state:'cancelled',resultReceipt:undefined,resultHash:original.resultHash}
  ];
  for(const marker of cases){
   const bytes=Buffer.from(JSON.stringify(marker));fs.writeFileSync(file,bytes);
   for(const observed of [status(root,id),recover(root,id)]){
    expect(observed).toMatchObject({state:'interrupted',progress:'verification-failed'});
    expect(observed).not.toHaveProperty('resultReceipt');expect(observed).not.toHaveProperty('resultHash');
   }
   expect(fs.readFileSync(file)).toEqual(bytes);expect(fs.existsSync(path.join(dir,'recovered.json'))).toBe(false);
  }
  expect(fs.readFileSync(path.join(dir,'executions.txt'),'utf8').trim().split('\n')).toHaveLength(1);
 });
 it('rejects a job re-signed by a foreign identity without replacing the existing workspace key',()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id),workspace=path.join(dir,'workspace');
  const file=path.join(dir,'job.json'),job=JSON.parse(fs.readFileSync(file,'utf8')),key=fs.readFileSync(keysPath(workspace));
  const foreign={...job,...signBody(job,path.join(root,'foreign'))};expect(verifySignature(foreign)).toBe(true);
  fs.writeFileSync(file,JSON.stringify(foreign));
  expect(()=>status(root,id)).toThrow(/workspace signer mismatch/);
  expect(()=>recover(root,id)).toThrow(/workspace signer mismatch/);
  expect(fs.readFileSync(keysPath(workspace))).toEqual(key);
  expect(fs.readFileSync(file,'utf8')).toBe(JSON.stringify(foreign));
 });
 it('reads the existing identity without a stale cache, key recreation or symlink substitution',()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id),workspace=path.join(dir,'workspace');
  const keyFile=keysPath(workspace),original=fs.readFileSync(keyFile),foreignRoot=path.join(root,'foreign');
  const foreign=loadOrCreateKeys(foreignRoot);
  fs.writeFileSync(keyFile,foreign.privatePem);expect(()=>status(root,id)).toThrow(/workspace signer mismatch/);
  fs.writeFileSync(keyFile,original);expect(status(root,id).state).toBe('queued');
  fs.unlinkSync(keyFile);expect(()=>status(root,id)).toThrow();expect(fs.existsSync(keyFile)).toBe(false);
  fs.symlinkSync(keysPath(foreignRoot),keyFile);expect(()=>status(root,id)).toThrow(/regular job file/);
  expect(fs.readlinkSync(keyFile)).toBe(keysPath(foreignRoot));
  expect(fs.existsSync(path.join(dir,'executions.txt'))).toBe(false);
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
 it.each([
  {mode:'complete',name:'terminal.json'},
  {mode:'reported-failure',name:'terminal.json'},
  {mode:'complete',name:'recovered.json'},
  {mode:'reported-failure',name:'recovered.json'}
 ])('reads legacy pointerless cancelled $mode results from $name without changing retained metadata',async({mode,name})=>{
  const id=enqueue(request,{root,executor:executor(mode)}).job.id,dir=jobDirectory(root,id);
  await start(root,id);await wait(()=>['succeeded','failed'].includes(status(root,id).state));await drainOwned();
  const result=status(root,id),original=Buffer.from(JSON.stringify({state:'cancelled',progress:'finished',reason:'Partial artifacts retained; no replay'}));
  const priorTerminal=fs.readFileSync(path.join(dir,'terminal.json'));fs.writeFileSync(path.join(dir,name),original);
  for(const value of [status(root,id),recover(root,id)])expect(value).toMatchObject({state:'cancelled',resultReceipt:result.resultReceipt,resultHash:result.resultHash});
  expect(fs.readFileSync(path.join(dir,name))).toEqual(original);expect(fs.existsSync(path.join(dir,'recovered.json'))).toBe(name==='recovered.json');
  const envelope=JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8'));
  fs.appendFileSync(path.join(envelope.result.directory,'native.log'),'changed');
  for(const value of [status(root,id),recover(root,id)]){
   expect(value).toMatchObject({state:'interrupted',progress:'verification-failed'});expect(value).not.toHaveProperty('resultReceipt');expect(value).not.toHaveProperty('resultHash');
  }
  expect(fs.readFileSync(path.join(dir,name))).toEqual(original);if(name==='recovered.json')expect(fs.readFileSync(path.join(dir,'terminal.json'))).toEqual(priorTerminal);expect(await invoke(id)).toBe(1);
 });
 it.each([
  {mode:'complete',exit:0,result:'succeeded'},
  {mode:'reported-failure',exit:0,result:'failed'},
  {mode:'result-exit-error',exit:1,result:'succeeded'},
  {mode:'reported-failure-exit-error',exit:1,result:'failed'},
  {mode:'tamper-result',exit:0,result:null},
  {mode:'malformed-result-exit-error',exit:1,result:null}
 ])('handles cancellation at the actual supervisor close boundary: $mode',async scenario=>{
  const id=enqueue(request,{root,executor:executor(scenario.mode)}).job.id,dir=jobDirectory(root,id);
  fs.writeFileSync(path.join(dir,'claim.json'),JSON.stringify({started:Date.now()}));let closed:number|null|undefined;
  await supervised(id,code=>{closed=code;cancel(root,id);});expect(closed).toBe(scenario.exit);
  const terminal=fs.readFileSync(path.join(dir,'terminal.json'));
  if(scenario.result){
   const result=JSON.parse(fs.readFileSync(path.join(dir,'result.json'),'utf8'));expect(result.result.state).toBe(scenario.result);
   for(const observed of [status(root,id),recover(root,id)])expect(observed).toMatchObject({state:'cancelled',resultReceipt:result.result.receipt,resultHash:result.result.receiptHash});
  }else{
   for(const observed of [status(root,id),recover(root,id)]){
    expect(observed).toMatchObject({state:'interrupted',progress:'verification-failed'});expect(observed).not.toHaveProperty('resultReceipt');expect(observed).not.toHaveProperty('resultHash');
   }
  }
  expect(fs.readFileSync(path.join(dir,'terminal.json'))).toEqual(terminal);expect(await invoke(id)).toBe(1);
  expect(fs.readFileSync(path.join(dir,'executions.txt'),'utf8').trim().split('\n')).toHaveLength(1);
 });
 it.each(['terminal.json','recovered.json'])('refuses malformed legacy cancelled result readback from %s without rewriting it',name=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id);
  const raw=Buffer.from(JSON.stringify({state:'cancelled',progress:'finished'}));fs.writeFileSync(path.join(dir,name),raw);fs.writeFileSync(path.join(dir,'result.json'),'{');
  for(const observed of [status(root,id),recover(root,id)]){
   expect(observed).toMatchObject({state:'interrupted',progress:'verification-failed'});expect(observed).not.toHaveProperty('resultReceipt');expect(observed).not.toHaveProperty('resultHash');
  }
  expect(fs.readFileSync(path.join(dir,name))).toEqual(raw);expect(fs.readFileSync(path.join(dir,'result.json'),'utf8')).toBe('{');
 });
 it('records verification refusal when recovering a cancelled running job with an invalid result',async()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id);
  fs.writeFileSync(path.join(dir,'claim.json'),JSON.stringify({started:0}));fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify({started:0}));cancel(root,id);
  const raw=JSON.stringify({id,result:{state:'succeeded',receipt:'not-admitted'}});fs.writeFileSync(path.join(dir,'result.json'),raw);
  for(const value of [recover(root,id),status(root,id)]){
   expect(value).toMatchObject({state:'interrupted',progress:'verification-failed'});expect(value).not.toHaveProperty('resultReceipt');expect(value).not.toHaveProperty('resultHash');
  }
  const terminal=fs.readFileSync(path.join(dir,'terminal.json'));recover(root,id);expect(fs.readFileSync(path.join(dir,'terminal.json'))).toEqual(terminal);expect(fs.readFileSync(path.join(dir,'result.json'),'utf8')).toBe(raw);
  expect(await invoke(id)).toBe(1);expect(fs.existsSync(path.join(dir,'executions.txt'))).toBe(false);
 });
 it('refuses a signed result from another job in a legacy cancelled record',async()=>{
  const file=executor(),first=enqueue(request,{root,executor:file}).job.id,second=enqueue(request,{root,executor:file}).job.id;
  await Promise.all([start(root,first),start(root,second)]);await wait(()=>status(root,first).state==='succeeded'&&status(root,second).state==='succeeded');await drainOwned();
  const foreign=fs.readFileSync(path.join(jobDirectory(root,first),'result.json'));expect(verifySignature(JSON.parse(foreign.toString()))).toBe(true);
  const dir=jobDirectory(root,second),terminal=Buffer.from(JSON.stringify({state:'cancelled',progress:'finished'}));fs.writeFileSync(path.join(dir,'terminal.json'),terminal);fs.writeFileSync(path.join(dir,'result.json'),foreign);
  for(const value of [status(root,second),recover(root,second)]){
   expect(value).toMatchObject({state:'interrupted',progress:'verification-failed'});expect(value).not.toHaveProperty('resultReceipt');expect(value).not.toHaveProperty('resultHash');
  }
  expect(fs.readFileSync(path.join(dir,'terminal.json'))).toEqual(terminal);expect(fs.readFileSync(path.join(dir,'result.json'))).toEqual(foreign);expect(await invoke(second)).toBe(1);
  expect(fs.readFileSync(path.join(dir,'executions.txt'),'utf8').trim().split('\n')).toHaveLength(1);
 });
 it.each(['terminal.json','recovered.json'])('refuses dangling retained result in legacy %s without changing its link or marker',async name=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id),target=path.join(root,'missing-result');
  const raw=Buffer.from(JSON.stringify({state:'cancelled',progress:'finished'}));fs.writeFileSync(path.join(dir,name),raw);fs.symlinkSync(target,path.join(dir,'result.json'));
  for(const value of [status(root,id),recover(root,id)]){
   expect(value).toMatchObject({state:'interrupted',progress:'verification-failed'});expect(value).not.toHaveProperty('resultReceipt');expect(value).not.toHaveProperty('resultHash');
  }
  expect(fs.readFileSync(path.join(dir,name))).toEqual(raw);expect(fs.readlinkSync(path.join(dir,'result.json'))).toBe(target);expect(await invoke(id)).toBe(1);
 });
 it('refuses a dangling retained result during cancelled running-job recovery',async()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id),target=path.join(root,'missing-result');
  fs.writeFileSync(path.join(dir,'claim.json'),JSON.stringify({started:0}));fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify({started:0}));cancel(root,id);fs.symlinkSync(target,path.join(dir,'result.json'));
  const value=recover(root,id);expect(value).toMatchObject({state:'interrupted',progress:'verification-failed'});expect(value).not.toHaveProperty('resultReceipt');expect(value).not.toHaveProperty('resultHash');
  expect(fs.readlinkSync(path.join(dir,'result.json'))).toBe(target);expect(await invoke(id)).toBe(1);expect(fs.existsSync(path.join(dir,'executions.txt'))).toBe(false);
 });
 it('refuses a dangling retained result when the supervisor observes cancellation before execution',async()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id),target=path.join(root,'missing-result');
  fs.writeFileSync(path.join(dir,'claim.json'),JSON.stringify({started:0}));cancel(root,id);fs.symlinkSync(target,path.join(dir,'result.json'));let childClosed=false;
  await supervised(id,()=>{childClosed=true;});expect(childClosed).toBe(false);
  const value=status(root,id);expect(value).toMatchObject({state:'interrupted',progress:'verification-failed'});expect(value).not.toHaveProperty('resultReceipt');expect(value).not.toHaveProperty('resultHash');
  expect(fs.readlinkSync(path.join(dir,'result.json'))).toBe(target);expect(fs.existsSync(path.join(dir,'execution.json'))).toBe(false);expect(await invoke(id)).toBe(1);
 });
 it('does not execute through a dangling result entry with no cancellation marker',async()=>{
  const id=enqueue(request,{root,executor:executor()}).job.id,dir=jobDirectory(root,id),target=path.join(root,'missing-result');
  fs.writeFileSync(path.join(dir,'claim.json'),JSON.stringify({started:Date.now()}));fs.writeFileSync(path.join(dir,'execution.json'),JSON.stringify({started:Date.now()}));fs.symlinkSync(target,path.join(dir,'result.json'));
  expect(await invoke(id)).toBe(1);expect(fs.readlinkSync(path.join(dir,'result.json'))).toBe(target);expect(fs.existsSync(path.join(dir,'native-execution.json'))).toBe(false);expect(fs.existsSync(path.join(dir,'executions.txt'))).toBe(false);
 });
});
