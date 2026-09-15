import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { appendReceipt, hashOf, rootStoreDir, verifySignature } from '../../src/utils/receipts.js';
import { planRoute } from '../../src/vision/spatial/route-graph.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'), dir=join(root,'studio/box-loop-20260914/s3-repair');
const save=(p:string,v:unknown)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const sha=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const verified=(r:any)=>verifySignature(r)&&hashOf({...r,hash:''})===r.hash;
function seal(kind:string,status:'ok'|'failed',file:string,op_id:string,children:string[]=[]){
 if(rootStoreDir(root)!==join(root,'.timmy/receipts'))throw Error('Receipt store mismatch');
 console.log('store: '+rootStoreDir(root));
 const r=appendReceipt('runs',{kind,subject:kind==='seal'?'route.graph':'route.graph repair',status,tier:'LIGHT',policy:'Root toolchain, source planning, measured-provenance and backend-independence controls. Fleet parked.',artifacts:[relative(root,file)],output_sha256:sha(file),sources:[{op_id}],child_receipts:children,...(status==='failed'?{error_class:'route_repair_gate',exit_code:2}:{})},root);
 if(!verified(r))throw Error('Seal invalid');return r;
}
const [mode,op]=process.argv.slice(2);
if(mode==='submit'){
 const id='route-repair-'+randomUUID();save(join(dir,'request.json'),{schema:'timmy.op/1',op_id:id,operation:'route.graph repair',worker:'detached worker; synchronous source CLI subprocesses',startedAt:new Date().toISOString()});
 const r=seal('op.request','ok',join(dir,'request.json'),id);save(join(dir,'request.receipt.json'),r);
 const child=spawn(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),'worker',id],{cwd:root,detached:true,stdio:'ignore'});child.unref();console.log(JSON.stringify({op_id:id,pid:child.pid,requestSeal:r.id}));
}else if(mode==='worker'){
 if(!/^route-repair-[a-f0-9-]{36}$/.test(op))throw Error('Invalid operation');
 const children:string[]=[]; let result:any;
 const command=(name:string,args:string[])=>{const r=spawnSync(args[0],args.slice(1),{cwd:root,encoding:'utf8',timeout:45000,maxBuffer:1000000});save(join(dir,name+'.process.json'),{argv:args,status:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr,error:r.error?.message});if(r.status!==0)throw Error(name+' failed');return r.stdout.trim();};
 try{
  const pins=read(join(dir,'toolchain-pins.json'));
  const npxVersion=command('npx-tsc',['npx','--no-install','tsc','--version']);
  const rootVersion=command('root-tsc',[join(root,'node_modules/.bin/tsc'),'--version']);
  if(npxVersion!=='Version '+pins.lockInstalled||rootVersion!==npxVersion||pins.installedVersion!==pins.lockInstalled)throw Error('TypeScript version gate failed');
  const bin=join(root,'dist/timmy.js'),before={sha256:sha(bin),mode:statSync(bin).mode&0o777};chmodSync(bin,statSync(bin).mode|0o111);
  const after={sha256:sha(bin),mode:statSync(bin).mode&0o777};save(join(dir,'bin-permission.json'),{before,after,onlyExecuteBitsAdded:before.sha256===after.sha256,compiledRouteUpdated:false});
  command('installed-bin',['/opt/homebrew/bin/timmy','--version']);
  command('source-help',['npx','--no-install','tsx','timmy.ts','route','--help']);
  async function route(name:string,from:string,to:string,required:string,independent:number,expected:string,reason?:string){
   const stdout=command(name,['npx','--no-install','tsx','timmy.ts','route','--from',from,'--to',to,'--require',required,'--independent',String(independent)]);
   const submitted=stdout.split('\n').map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(row=>row?.op_id&&row?.complete_path);
   if(!submitted)throw Error(name+' has no operation id');
   const deadline=Date.now()+45000;while(!existsSync(submitted.complete_path)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,200));
   if(!existsSync(submitted.complete_path))throw Error(name+' timed out');
   const done=read(submitted.complete_path),value=read(submitted.result_path),receipt=read(submitted.receipt_path);
   if(!verified(receipt)||receipt.output_sha256!==sha(submitted.result_path)||done.receipt!==receipt.hash||value.status!=='ok'||value.outcome!==expected||reason&&value.plan.reason!==reason)throw Error(name+' result gate failed');
   children.push(receipt.hash);const snapshot=join(dir,name);mkdirSync(snapshot);
   for(const f of readdirSync(dirname(submitted.complete_path)))if(statSync(join(dirname(submitted.complete_path),f)).isFile())copyFileSync(join(dirname(submitted.complete_path),f),join(snapshot,f));
   return {op_id:value.op_id,opResultSeal:receipt.id,outcome:value.outcome,reason:value.plan.reason,paths:value.plan.paths.map((p:any)=>p.edgeIds)};
  }
  const planned=await route('planned','volume.package','grounded.point','sourceRevision,units.mm,generated.provenance',1,'planned');
  const measured=await route('measured-refusal','mesh.json','grounded.point','physical.measured',1,'refused','source_properties_unavailable');
  const independent=await route('independence-refusal','volume.package','grounded.point','sourceRevision,units.mm',2,'refused','insufficient_independent_backends');
  const graph=read(join(root,'studio/box-loop-20260914/s3/graph.json'));
  const original=graph.edges.find((e:any)=>e.id==='surface-to-native-view');
  const fixture=structuredClone(graph);fixture.edges=[structuredClone(original),{...structuredClone(original),id:'same-blender-through-second-wrapper'}];
  const request={from:'mesh.json',to:'view.bundle',requiredProperties:['sourceRevision','units.mm'],independent:2};
  const duplicate=planRoute(fixture,request),single=planRoute(fixture,{...request,independent:1});
  save(join(dir,'shared-backend-control.json'),{scope:'Control fixture only; never admitted as graph',fixture,request,result:duplicate,singleRoute:single});
  if(single.status!=='planned'||duplicate.status!=='refused'||duplicate.reason!=='insufficient_independent_backends')throw Error('Shared-backend control failed');
  if(Date.now()>Date.parse(read(join(dir,'scope.json')).deadline))throw Error('Checkpoint deadline failed');
  result={schema:'timmy.op.result/1',op_id:op,status:'ok',graphSha256:sha(join(root,'studio/box-loop-20260914/s3/graph.json')),admittedGraph:'studio/box-loop-20260914/s3/graph.json',sourceRunner:'npx --no-install tsx timmy.ts route',toolchain:npxVersion,planned,measured,independent,sharedBackendControl:'passed',generatedMeasurementScope:'Timmy can compute and verify dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.',compiledRouteUpdated:false,sourceRouteAdmitted:true,child_receipts:children};
 }catch(error){result={schema:'timmy.op.result/1',op_id:op,status:'failed',error:error instanceof Error?error.message:String(error),child_receipts:children,queueStopped:true};}
 save(join(dir,'result.json'),result);const boundary=seal('op.result',result.status,join(dir,'result.json'),op,children);save(join(dir,'op.result.receipt.json'),boundary);
 const walk=(d:string):string[]=>readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(d,e.name)):[join(d,e.name)]);
 const impl=['tools/box-loop-20260914/repair-route.ts','src/vision/spatial/route-cli.ts','src/vision/spatial/route-graph.ts','timmy.ts','src/cli.ts'];
 save(join(dir,'manifest.json'),{schema:'timmy.checkpoint.manifest/1',subject:'route.graph',status:result.status,artifacts:walk(dir).sort().map(p=>({path:relative(root,p),sha256:sha(p)})),implementation:impl.map(path=>({path,sha256:sha(join(root,path))}))});
 const r=seal('seal',result.status,join(dir,'manifest.json'),op,[boundary.hash]);save(join(dir,'route.graph.receipt.json'),r);
 save(join(dir,'checkpoint.json'),{started:read(join(dir,'scope.json')).started,ended:new Date().toISOString(),within15Minutes:Date.now()<=Date.parse(read(join(dir,'scope.json')).deadline),status:result.status,sealId:r.id});
 save(join(dir,'complete.json'),{status:result.status,op_id:op,sealId:r.id,hash:r.hash,opResultId:boundary.id});
}else throw Error('Use submit or worker');
