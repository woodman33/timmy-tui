import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {appendReceipt, verifySignature} from '../../src/utils/receipts.js';
const here=path.dirname(fileURLToPath(import.meta.url));
export const sha=(b:crypto.BinaryLike)=>crypto.createHash('sha256').update(b).digest('hex');
export const cardPath=path.join(here,'enclosure-tray/recipe.json');
const script=path.join(here,'enclosure-tray/build.py');
export type Parameters={width:number;wall:number;supportOffset:number;bore:number};
export function validate(input:unknown):Parameters {
  const r=input as any;
  if(!r||r.schema!=='timmy.recipe-request/1'||r.recipe!=='enclosure.tray/1'||Object.keys(r).sort().join()!=='parameters,recipe,schema')throw Error('Expected enclosure.tray/1 request');
  const p=r.parameters;
  if(!p||Object.keys(p).sort().join()!=='bore,supportOffset,wall,width'||Object.values(p).some(v=>typeof v!=='number'||!Number.isFinite(v)))throw Error('Four finite numeric parameters required');
  if(p.width<40||p.width>1000||p.wall<=0||p.wall>10||p.bore<=0||p.bore>=12||p.supportOffset<=p.wall+6||p.supportOffset>=Math.min(p.width,80)/2-6)throw Error('Conflicting tray dimensions: positive wall; supports inside cavity, separated; bore smaller than support');
  return {width:p.width,wall:p.wall,supportOffset:p.supportOffset,bore:p.bore};
}
export function prediction(p:Parameters){
  const centers=(w:number)=>[-1,1].flatMap(x=>[-1,1].map(y=>[x*(w/2-p.supportOffset),y*(40-p.supportOffset)]));
  const volume=p.width*80*30-(p.width-2*p.wall)*(80-2*p.wall)*(30-p.wall)+4*Math.PI*36*8-4*Math.PI*(p.bore/2)**2*(p.wall+8);
  return {schema:'timmy.tray-prediction/1',parameters:p,bounds:[p.width,80,30],volumeMm3:volume,centers:centers(p.width),widthChange:{from:140,to:180,fromCenters:centers(140),toCenters:centers(180),deltaX:[-20,-20,20,20],mustRebuild:['tray.outer','tray.cavity','tray.bosses','tray.bores'],mustMove:['tray.bosses','tray.bores'],invariants:['depth','height','wall','supportOffset','bore','support radius','support height','support/bore Y coordinates'],explanation:'Outer and cavity X faces expand by ±20 mm; support and bore axes translate ±20 mm outward. Stable feature IDs persist; exported face indices are not persistent IDs.'}};
}
export function gate(result:any,p:Parameters,dir:string){
  const v=result?.variant, checks=v?.checks;
  if(result?.passed!==true||result?.checksTotal!==30||!Array.isArray(checks)||checks.length!==30||checks.some((c:any,i:number)=>c.id!==`geometry.${String(i+1).padStart(2,'0')}`||c.passed!==true))throw Error('30-check geometry gate failed');
  if(JSON.stringify(v.features?.map((f:any)=>f.id))!==JSON.stringify(['tray.outer','tray.cavity','tray.bosses','tray.bores']))throw Error('Feature identity gate failed');
  const pred=prediction(p);
  if(v.measured.bounds.some((n:number,i:number)=>Math.abs(n-pred.bounds[i])>1e-6)||Math.abs(v.measured.volume-pred.volumeMm3)/pred.volumeMm3>1e-8)throw Error('Sealed analytical prediction differs');
  const near=(a:number[][],b:number[][])=>a.length===b.length&&a.every((row,i)=>row.length===2&&row.every((n,j)=>Math.abs(n-b[i][j])<1e-6));
  for(const f of v.features.slice(2))if(!near(f.cylinderAxesXY,pred.centers))throw Error('Native feature axes differ from prediction');
  const exports=[...v.stages.map((s:any)=>({file:s.file,sha256:s.sha256})),v.files.step];
  if(exports.length!==5)throw Error('Four mesh exports and STEP required');
  return exports.map((e:any)=>{if(typeof e.file!=='string'||path.isAbsolute(e.file)||e.file.split(/[\\/]/).includes('..'))throw Error('Unsafe export path');const full=path.join(dir,e.file);if(sha(fs.readFileSync(full))!==e.sha256)throw Error('Export hash mismatch');return {file:e.file,sha256:e.sha256};});
}
export function build(input:unknown,options:{root?:string;python?:string}={}){
  const root=options.root||process.cwd();
  let p:Parameters;
  try{p=validate(input);}catch(e){const r=appendReceipt('runs',{kind:'recipe.refused',subject:'enclosure.tray/1',policy:'auto',status:'denied',error_class:'schema',sources:[{request_sha256:sha(JSON.stringify(input)),reason:String(e)}],cost_usd:0},root);return {state:'refused',receipt:r.id,reason:String(e),nativeStarted:false};}
  const run=crypto.randomUUID(),base=path.join(root,'.timmy/recipe-runs',run);fs.mkdirSync(base,{recursive:true});
  fs.writeFileSync(path.join(base,'request.json'),JSON.stringify({schema:'timmy.recipe-request/1',recipe:'enclosure.tray/1',parameters:p}));
  const frozenScript=path.join(base,'build.py');fs.copyFileSync(script,frozenScript);
  const pred=prediction(p);fs.writeFileSync(path.join(base,'prediction.json'),JSON.stringify(pred,null,2)+'\n');
  const python=options.python||process.env.TIMMY_CADQUERY_PYTHON;
  const sources=[{path:frozenScript,sha256:sha(fs.readFileSync(frozenScript))},{path:cardPath,sha256:sha(fs.readFileSync(cardPath))},{path:path.join(base,'request.json'),sha256:sha(fs.readFileSync(path.join(base,'request.json')))},{path:path.join(base,'prediction.json'),sha256:sha(fs.readFileSync(path.join(base,'prediction.json')))}];
  if(python&&fs.existsSync(python))sources.push({path:python,sha256:sha(fs.readFileSync(python))});
  const before=appendReceipt('runs',{kind:'recipe.prediction',subject:'enclosure.tray/1:'+run,policy:'auto',status:'ok',sources,cost_usd:0},root);
  if(!verifySignature(before))throw Error('Prediction signature invalid');
  fs.writeFileSync(path.join(base,'prediction.receipt.json'),JSON.stringify(before,null,2)+'\n');
  let result:any,exports:any[]=[],failure:string|undefined;
  try{
    if(!python||!path.isAbsolute(python))throw Error('Set TIMMY_CADQUERY_PYTHON to the native runtime absolute path');
    const child=spawnSync(python,[frozenScript,'--request',path.join(base,'request.json'),'--output',path.join(base,'native')],{encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
    fs.writeFileSync(path.join(base,'native.log'),(child.stdout||'')+(child.stderr||''));
    if(child.error||child.status!==0)throw Error('Native execution failed; retained native.log');
    result=JSON.parse(fs.readFileSync(path.join(base,'native/result.json'),'utf8'));
    exports=gate(result,p,path.join(base,'native'));
  }catch(e){failure=String(e);}
  const resultSources=['native/result.json','native.log'].filter(n=>fs.existsSync(path.join(base,n))).map(n=>({path:path.join(base,n),sha256:sha(fs.readFileSync(path.join(base,n)))}));
  resultSources.push(...exports.map(e=>({path:path.join(base,'native',e.file),sha256:e.sha256})));
  const after=appendReceipt('runs',{kind:'recipe.build',subject:'enclosure.tray/1:'+run,policy:'auto',status:failure?'failed':'ok',child_receipts:[before.id],sources:resultSources,artifacts:resultSources.map(s=>s.path),discrepancies:failure?[failure]:[],cost_usd:0},root);
  const report={state:failure?'failed':'succeeded',run,parameters:p,predictionReceipt:before.id,receipt:after.id,receiptHash:after.hash,checksPassed:failure?null:30,features:result?.variant?.features,exports,error:failure};
  fs.writeFileSync(path.join(base,'report.json'),JSON.stringify(report,null,2)+'\n');
  return {...report,directory:base};
}
