import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createPrivateKey,createPublicKey} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {sha,validate,cardPath} from './tray.js';
import {hashOf,verifySignature,receiptsDir} from '../../src/utils/receipts.js';
import {loadOrCreateKeys,signBody} from '../../src/utils/signing.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const extension=import.meta.url.endsWith('.js')?'js':'ts';
const worker=path.join(here,`job-worker.${extension}`);
// Production workers are emitted JavaScript; only source fixture/development
// entrypoints resolve the optional tsx development loader.
function nodeArguments(entry:string,...args:string[]){
 const loader=/\.[cm]?tsx?$/.test(entry)?['--import',createRequire(import.meta.url).resolve('tsx')]:[];
 return [...loader,entry,...args];
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type JobState='queued'|'running'|'succeeded'|'failed'|'cancelled'|'interrupted';
export interface Job {schema:'timmy.recipe-job/1';id:string;created:number;request:unknown;requestHash:string;sourceHash:string;executionHash:string;sources:{file:string;hash:string}[];signer:string;signature:string;executor:string;python?:string;pythonRealPath?:string}
const executionHash=(j:Pick<Job,'requestHash'|'sources'|'executor'|'python'|'pythonRealPath'>)=>sha(JSON.stringify({requestHash:j.requestHash,sources:j.sources,executor:j.executor,python:j.python??null,pythonRealPath:j.pythonRealPath??null}));
const regular=(p:string)=>{const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink())throw Error('Expected regular job file');return p;};
const present=(p:string)=>{try{fs.lstatSync(p);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}};
function directory(p:string,create=false){if(create&&!fs.existsSync(p))fs.mkdirSync(p,{mode:0o700});const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink())throw Error('Unsafe job directory');return p;}
export function jobDirectory(root:string,id:string){
 if(!uuid.test(id))throw Error('Invalid recipe job UUID');
 const base=fs.realpathSync(root);directory(path.join(base,'.timmy'),true);
 const jobs=directory(path.join(base,'.timmy','recipe-jobs'),true);
 if((fs.statSync(jobs).mode&0o077)!==0)throw Error('Recipe job directory must be private');
 return path.join(jobs,id);
}
const read=(p:string)=>JSON.parse(fs.readFileSync(regular(p),'utf8'));
function once(p:string,value:unknown){
 const tmp=p+'.'+randomUUID(),fd=fs.openSync(tmp,'wx',0o600);
 let open=true;
 try{
  fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.closeSync(fd);open=false;
  // A hard link publishes complete bytes atomically without replacing a winner.
  // Renaming over the destination would break the persistent one-shot gate.
  try{fs.linkSync(tmp,p);return true;}
  catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST'){regular(p);return false;}throw e;}
 }finally{if(open)fs.closeSync(fd);fs.unlinkSync(tmp);}
}
function atomic(p:string,value:unknown){if(fs.existsSync(p))regular(p);const tmp=p+'.'+randomUUID();fs.writeFileSync(tmp,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});fs.renameSync(tmp,p);}
function workspaceStore(dir:string){
 const workspace=directory(path.join(dir,'workspace'));
 directory(path.join(workspace,'.timmy'));
 const store=directory(path.join(workspace,'.timmy','receipts'));
 const pin=regular(path.join(workspace,'.timmy','store-pin'));
 if(fs.readFileSync(pin,'utf8').trim()!==store||receiptsDir(workspace)!==store)throw Error('Recipe workspace store pin mismatch');
 return workspace;
}
function workspaceSigner(workspace:string){
 const keys=directory(path.join(workspace,'.timmy','keys'));
 const privateKey=createPrivateKey(fs.readFileSync(regular(path.join(keys,'ed25519.pem')),'utf8'));
 return createPublicKey(privateKey).export({type:'spki',format:'pem'}).toString();
}
export function loadJob(root:string,id:string):Job {
 const dir=directory(jobDirectory(root,id)),job=read(path.join(dir,'job.json')) as Job;
 if(job.schema!=='timmy.recipe-job/1'||job.id!==id||sha(JSON.stringify(job.request))!==job.requestHash||sha(JSON.stringify(job.sources))!==job.sourceHash||executionHash(job)!==job.executionHash||!verifySignature(job as never)||!job.sources.some(s=>s.file===job.executor)||!path.isAbsolute(job.executor)||(job.python&&(!job.pythonRealPath||!job.sources.some(s=>s.file===job.pythonRealPath))))throw Error('Job binding mismatch');
 validate(job.request);const workspace=workspaceStore(dir);
 // Read the existing identity afresh: status must neither create a missing key
 // nor accept a cached key after custody changes on disk.
 if(workspaceSigner(workspace)!==job.signer)throw Error('Recipe job workspace signer mismatch');
 return job;
}
function sourceGate(job:Job){if(job.python&&fs.realpathSync(job.python)!==job.pythonRealPath)throw Error('Recipe job source changed; Python target differs');for(const source of job.sources)if(sha(fs.readFileSync(regular(source.file)))!==source.hash)throw Error('Recipe job source changed; enqueue a new job');}
export function enqueue(input:unknown,options:{root?:string;python?:string;executor?:string}={}) {
 const root=options.root??process.cwd(),id=randomUUID();
 const request={schema:'timmy.recipe-request/1',recipe:'enclosure.tray/1',parameters:validate(input)};
 const dir=jobDirectory(root,id);fs.mkdirSync(dir,{mode:0o700});
 const workspace=directory(path.join(dir,'workspace'),true);
 directory(path.join(workspace,'.timmy'),true);
 const store=directory(path.join(workspace,'.timmy','receipts'),true);
 fs.writeFileSync(path.join(workspace,'.timmy','store-pin'),store+'\n',{flag:'wx',mode:0o600});
 // executor is an explicit programmatic test seam; the CLI never accepts it.
 const executor=path.resolve(options.executor??worker);
 const python=options.python??process.env.TIMMY_CADQUERY_PYTHON;
 if(python&&!path.isAbsolute(python))throw Error('Python must be an absolute installed executable');
 const pythonRealPath=python?fs.realpathSync(python):undefined;
 const sources=[fileURLToPath(import.meta.url),path.join(here,`tray.${extension}`),cardPath,path.join(here,'enclosure-tray/build.py'),worker,executor,...(pythonRealPath?[pythonRealPath]:[])]
  .filter((p,i,a)=>a.indexOf(p)===i).map(file=>({file,hash:sha(fs.readFileSync(regular(file)))}));
 const body={schema:'timmy.recipe-job/1' as const,id,created:Date.now(),request,requestHash:sha(JSON.stringify(request)),sources,sourceHash:sha(JSON.stringify(sources)),signer:loadOrCreateKeys(workspace).publicPem,executor,...(python?{python,pythonRealPath}:{})};
 const bound={...body,executionHash:executionHash(body)};
 const job:Job={...bound,...signBody(bound,workspace)};
 once(path.join(dir,'job.json'),job);return status(root,id);
}
export type JobStatus={job:Job;state:JobState;progress:string;resultReceipt?:string;resultHash?:string;reason?:string};
/** What one completion() read verified (the review of 07f37ec, M3): the signed envelope, its report and receipts as
 * parsed then, and the bytes of every file it hashed, keyed by path. A reader consumes this instead of reading again. */
export interface ResultSnapshot{job:Job;envelope:any;report:any;receipt:any;prediction:any;base:string;files:ReadonlyMap<string,Buffer>}
export function status(root:string,id:string):JobStatus{return inspect(root,id).status;}
/** status() and, when its state rests on a verified result, the snapshot that same verification read. */
export function verifiedStatus(root:string,id:string):{status:JobStatus;snapshot?:ResultSnapshot}{return inspect(root,id);}
function inspect(root:string,id:string):{status:JobStatus;snapshot?:ResultSnapshot}{
 const job=loadJob(root,id),dir=jobDirectory(root,id);
 for(const name of ['recovered.json','terminal.json'])if(fs.existsSync(path.join(dir,name))){
  const recorded=read(path.join(dir,name));
  const hasReferences=Object.hasOwn(recorded,'resultReceipt')||Object.hasOwn(recorded,'resultHash');
  const legacyCancellation=recorded.state==='cancelled'&&!hasReferences&&present(path.join(dir,'result.json'));
  if(recorded.state==='succeeded'||hasReferences||legacyCancellation){
   try{
    // The result is verified against this same job file, not a second read of it.
    const {result:verified,snapshot}=verifyCompletion(root,id,job);
    if(!['succeeded','failed','cancelled'].includes(recorded.state)||
     (!legacyCancellation&&(typeof recorded.resultReceipt!=='string'||!recorded.resultReceipt||typeof recorded.resultHash!=='string'||!recorded.resultHash||
     recorded.resultReceipt!==verified.resultReceipt||recorded.resultHash!==verified.resultHash))||
     (recorded.state!=='cancelled'&&recorded.state!==verified.state))throw Error('Terminal result reference mismatch');
    return {status:{...recorded,...verified,state:recorded.state,...(legacyCancellation?{reason:'Cancellation requested; completed native result retained; no replay'}:{}),job},snapshot};
   }catch{return {status:{job,state:'interrupted',progress:'verification-failed',reason:'Recorded result could not be verified; original metadata retained; no replay'}};}
  }
  return {status:{...recorded,job}};
 }
 if(fs.existsSync(path.join(dir,'claim.json')))return {status:{job,state:'running',progress:fs.existsSync(path.join(dir,'cancel.json'))?'cancellation-requested':fs.existsSync(path.join(dir,'heartbeat.json'))?'native-build':'starting'}};
 return {status:{job,state:fs.existsSync(path.join(dir,'cancel.json'))?'cancelled':'queued',progress:fs.existsSync(path.join(dir,'cancel.json'))?'cancelled-before-start':'queued'}};
}
export function cancel(root:string,id:string){const current=status(root,id);if(['queued','running'].includes(current.state))once(path.join(jobDirectory(root,id),'cancel.json'),{requested:Date.now()});return status(root,id);}
function terminal(dir:string,state:JobState,reason?:string,extra:object={}){once(path.join(dir,'terminal.json'),{state,progress:'finished',...extra,...(reason?{reason}:{}),finished:Date.now()});}
function terminalCancellation(root:string,id:string,dir:string){
 if(present(path.join(dir,'result.json'))){
  try{const result=completion(root,id);terminal(dir,'cancelled','Cancellation requested; completed native result retained; no replay',{...result,state:'cancelled'});}
  catch{terminal(dir,'interrupted','Result could not be verified; no replay',{progress:'verification-failed'});}
  return;
 }
 terminal(dir,'cancelled','Partial artifacts retained; no replay');
}
export async function start(root:string,id:string,options:{onSupervisor?:(child:ReturnType<typeof spawn>)=>void}={}){
 if(process.platform==='win32')throw Error('Recipe workers currently require POSIX process groups');
 const current=status(root,id);if(current.state!=='queued')return current;
 const dir=jobDirectory(root,id);sourceGate(current.job);
 if(!once(path.join(dir,'claim.json'),{started:Date.now()}))return status(root,id);
 const log=fs.openSync(path.join(dir,'worker.log'),'ax',0o600);
 try{await new Promise<void>((resolve,reject)=>{
  const child=spawn(process.execPath,nodeArguments(worker,'supervise',path.resolve(root),id),{detached:true,stdio:['ignore',log,log],shell:false});
  child.once('error',e=>{terminal(dir,'failed','Worker could not start');reject(e);});
  child.once('spawn',()=>{child.unref();resolve();});
  // Programmatic observers can await this actual owned process during teardown;
  // the CLI never reads a saved PID or changes the detached job lifecycle.
  try{options.onSupervisor?.(child);}
  catch(error){console.warn('Recipe supervisor observer failed after launch: '+(error instanceof Error?error.message:String(error)));}
 });}finally{fs.closeSync(log);}
 return status(root,id);
}
/** Independent one-shot boundary for every internal execute invocation. */
export async function executeJob(root:string,id:string,native:(job:Job,workspace:string)=>void|Promise<void>){
 const job=loadJob(root,id),dir=jobDirectory(root,id);
 sourceGate(job);
 if(!fs.existsSync(path.join(dir,'claim.json'))||!fs.existsSync(path.join(dir,'execution.json')))throw Error('Job has no supervisor execution claim');
 if(['terminal.json','recovered.json','result.json','cancel.json'].some(name=>present(path.join(dir,name))))throw Error('Job is completed, interrupted or cancelled; no execution replay');
 const workspace=workspaceStore(dir);
 if(!once(path.join(dir,'native-execution.json'),{id,executionHash:job.executionHash,started:Date.now()}))throw Error('Job native execution already claimed; no replay');
 // The marker is intentionally retained on every outcome, including a crash.
 // Custom executors are a programmatic fixture seam and pass the same gate.
 if(job.executor===worker)await native(job,workspace);
 else await new Promise<void>((resolve,reject)=>{
  const child=spawn(process.execPath,nodeArguments(job.executor,'execute',path.resolve(root),id),{cwd:workspace,shell:false,stdio:'inherit',env:{...process.env,TIMMY_STORE:path.join(workspace,'.timmy','receipts'),TIMMY_CADQUERY_PYTHON:job.python??''}});
  child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Recipe executor did not complete')));
 });
}
/** Read back the incumbent report and its signed receipt; a result JSON alone is insufficient. */
function completion(root:string,id:string){return verifyCompletion(root,id).result;}
/** completion() with what it read: every file is read once, and each check and the returned snapshot use those bytes. */
function verifyCompletion(root:string,id:string,job:Job=loadJob(root,id)){
 const dir=jobDirectory(root,id),envelope=read(path.join(dir,'result.json'));
 const files=new Map<string,Buffer>();
 const bytes=(file:string)=>{let b=files.get(file);if(!b){b=fs.readFileSync(regular(file));files.set(file,b);}return b;};
 if(envelope.id!==id||envelope.requestHash!==job.requestHash||envelope.sourceHash!==job.sourceHash||envelope.executionHash!==job.executionHash||envelope.signer!==job.signer||!verifySignature(envelope))throw Error('Result binding mismatch');
 const r=envelope.result;if(!uuid.test(r.run)||!['succeeded','failed'].includes(r.state))throw Error('Invalid native result');
 const base=directory(path.join(dir,'workspace','.timmy','recipe-runs',r.run));
 // Walk every result ancestor: never follow a substituted receipt/report directory.
 let parent=dir;for(const part of ['workspace','.timmy','recipe-runs',r.run])parent=directory(path.join(parent,part));
 const report=JSON.parse(bytes(path.join(base,'report.json')).toString('utf8'));
 if(sha(JSON.stringify(report))!==envelope.reportHash||report.receipt!==r.receipt||report.receiptHash!==r.receiptHash||report.state!==r.state)throw Error('Report binding mismatch');
 const receiptDir=directory(path.join(dir,'workspace','.timmy','receipts'));
 const receipts=bytes(path.join(receiptDir,'runs.jsonl')).toString('utf8').trim().split('\n').map(line=>JSON.parse(line));
 const receipt=receipts.find(x=>x.id===r.receipt&&x.hash===r.receiptHash);
 if(!receipt||receipt.signer!==job.signer||!verifySignature(receipt)||hashOf({...receipt,hash:''})!==receipt.hash||receipt.kind!=='recipe.build'||receipt.status!==(r.state==='succeeded'?'ok':'failed'))throw Error('Result receipt invalid');
 const prediction=receipts.find(x=>receipt.child_receipts?.includes(x.id)&&x.kind==='recipe.prediction');
 if(!prediction||prediction.signer!==job.signer||!verifySignature(prediction)||hashOf({...prediction,hash:''})!==prediction.hash||!prediction.sources?.some((s:any)=>s.path===path.join(base,'request.json')&&s.sha256===job.requestHash))throw Error('Prediction/request binding invalid');
 if(sha(bytes(path.join(base,'request.json')))!==job.requestHash)throw Error('Native request changed');
 const frozenPrediction=['request.json','prediction.json','build.py'];
 for(const name of frozenPrediction){
  const file=path.join(base,name),source=prediction.sources?.find((s:any)=>s.path===file);
  if(!source||sha(bytes(file))!==source.sha256)throw Error('Retained prediction source changed');
 }
 for(const source of prediction.sources??[]){
  if(typeof source.path!=='string'||!source.path.startsWith(base+path.sep))continue;
  if(path.resolve(source.path)!==source.path)throw Error('Prediction path escaped');
  let cursor=base;for(const part of path.relative(base,source.path).split(path.sep).slice(0,-1))cursor=directory(path.join(cursor,part));
  if(sha(bytes(source.path))!==source.sha256)throw Error('Retained prediction source changed');
 }

 if(r.state==='succeeded'){
  if(report.checksPassed!==30||!Array.isArray(report.exports)||report.exports.length!==5||report.exports.some((e:any)=>typeof e.file!=='string'||path.isAbsolute(e.file)||e.file.split(/[\\/]/).includes('..')))throw Error('Native export set incomplete');
  if(report.exports.map((e:any)=>path.basename(e.file)).sort().join()!==['outer.stl','cavity.stl','bosses.stl','bores.stl','console-tray.step'].sort().join())throw Error('Native export identities differ');
  const required=[path.join(base,'native','result.json'),path.join(base,'native.log'),...report.exports.map((e:any)=>path.join(base,'native',e.file))].sort();
  if(!Array.isArray(receipt.sources)||receipt.sources.map((s:any)=>s.path).sort().join()!==required.join()||report.exports.some((e:any)=>!receipt.sources.some((s:any)=>s.path===path.join(base,'native',e.file)&&s.sha256===e.sha256)))throw Error('Native receipt artifact set incomplete');
 }
 for(const artifact of receipt.sources??[]){
  if(typeof artifact.path!=='string'||path.resolve(artifact.path)!==artifact.path||!artifact.path.startsWith(base+path.sep))throw Error('Receipt artifact escaped native run');
  const relative=path.relative(base,artifact.path);let cursor=base;
  for(const part of relative.split(path.sep).slice(0,-1))cursor=directory(path.join(cursor,part));
  if(sha(bytes(artifact.path))!==artifact.sha256)throw Error('Result artifact changed');
 }
 const snapshot:ResultSnapshot={job,envelope,report,receipt,prediction,base,files};
 return {result:{state:r.state as JobState,progress:'finished',resultReceipt:r.receipt as string,resultHash:r.receiptHash as string},snapshot};
}
export function recover(root:string,id:string){
 const current=status(root,id),dir=jobDirectory(root,id);
 // A failed readback must remain a refusal, not a new marker that repairs or
 // hides the retained result reference. Restoration can be inspected afresh.
 if(current.progress==='verification-failed')return current;
 if(!['running','interrupted'].includes(current.state))return current;
 if(present(path.join(dir,'result.json'))){
  try{const result=completion(root,id);
   const recovered=fs.existsSync(path.join(dir,'cancel.json'))?{...result,state:'cancelled',reason:'Cancellation requested; completed native result retained; no replay'}:result;
   once(path.join(dir,current.state==='interrupted'?'recovered.json':'terminal.json'),recovered);return status(root,id);}
  catch{terminal(dir,'interrupted','Result could not be verified; no replay',{progress:'verification-failed'});return status(root,id);}
 }
 const heartbeat=path.join(dir,'heartbeat.json');
 const last=fs.existsSync(heartbeat)?read(heartbeat).at:read(path.join(dir,'claim.json')).started;
 if(Date.now()-last>5000)terminal(dir,'interrupted','Worker heartbeat lost; native outcome unknown; no replay');
 return status(root,id);
}
/** An error in a few words: its code (ENOENT …) when it has one. */
const why=(error:unknown)=>(error as NodeJS.ErrnoException)?.code??(error instanceof Error?error.message:String(error));
/** Supervisor stays responsive while the incumbent synchronous build runs in a child. */
export async function supervise(root:string,id:string,options:{onExecutionClosed?:(code:number|null,signal:NodeJS.Signals|null)=>void}={}){
 const job=loadJob(root,id),dir=jobDirectory(root,id);
 if(!fs.existsSync(path.join(dir,'claim.json'))||fs.existsSync(path.join(dir,'terminal.json')))return;
 try{sourceGate(job);}catch{terminal(dir,'failed','Source changed before execution');return;}
 if(fs.existsSync(path.join(dir,'cancel.json'))){terminalCancellation(root,id,dir);return;}
 // A second supervisor cannot launch the same job, including after a crash.
 if(!once(path.join(dir,'execution.json'),{started:Date.now()}))return;
 const workspace=directory(path.join(dir,'workspace'));
 let child:ReturnType<typeof spawn>|undefined;
 const cancelled=()=>fs.existsSync(path.join(dir,'cancel.json'));
 const kill=()=>{if(child?.pid)try{process.kill(-child.pid,'SIGKILL');}catch{/* owned child already exited */}};
 // Round R4 (H29): a heartbeat the job folder no longer takes (the folder removed under a running job, say) stops
 // the native group as a cancellation does. Thrown from the timer, it killed this supervisor and left the group running.
 let lost:string|undefined;
 const beat=()=>{if(lost)return;try{atomic(path.join(dir,'heartbeat.json'),{at:Date.now()});}catch(error){lost=why(error);kill();}};
 try{
  await new Promise<void>((resolve,reject)=>{
   child=spawn(process.execPath,nodeArguments(worker,'execute',path.resolve(root),id),{cwd:workspace,detached:true,shell:false,stdio:'inherit',env:{...process.env,TIMMY_STORE:path.join(workspace,'.timmy','receipts'),TIMMY_CADQUERY_PYTHON:job.python??''}});
   const began=Date.now();beat();
   const timer=setInterval(()=>{beat();if(lost||cancelled()||Date.now()-began>150000)kill();},250);
   child.once('error',e=>{clearInterval(timer);reject(e);});
   child.once('close',(code,signal)=>{
    clearInterval(timer);
    // Programmatic observers see the actual close boundary, including failure;
    // CLI workers do not supply this callback or infer timing from a marker.
    try{options.onExecutionClosed?.(code,signal);}catch(error){console.warn('Recipe execution observer failed after close: '+(error instanceof Error?error.message:String(error)));}
    code===0?resolve():reject(Error('Native worker did not complete'));
   });
  });
  if(cancelled())terminalCancellation(root,id,dir);
  else{const result=completion(root,id);terminal(dir,result.state,undefined,result);}
 }catch{
  try{
   if(cancelled())terminalCancellation(root,id,dir);
   else if(lost)terminal(dir,'interrupted',`Heartbeat could not be written (${lost}); native process group stopped; no replay`);
   else terminal(dir,'failed','Worker failed; inspect worker.log');
  }catch(error){throw Error(`Job folder could not be written (${lost??why(error)}); native process group stopped; no terminal state recorded`);}
 }
 finally{kill();}
}
export function recordResult(root:string,id:string,result:any){
 const job=loadJob(root,id),dir=jobDirectory(root,id);
 const report=read(path.join(result.directory,'report.json'));
 const workspace=workspaceStore(dir);
 if(loadOrCreateKeys(workspace).publicPem!==job.signer)throw Error('Recipe result signer changed');
 const envelope={id,requestHash:job.requestHash,sourceHash:job.sourceHash,executionHash:job.executionHash,reportHash:sha(JSON.stringify(report)),result};
 once(path.join(dir,'result.json'),{...envelope,...signBody(envelope,workspace)});
}
