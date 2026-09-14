/** Native acceptance: explicit invocation, never run by ordinary unit tests. */
import fs from 'node:fs';
import path from 'node:path';
import {build,gate,sha} from './tray.js';
const runs:any[]=[];
for(const parameters of [{width:140,wall:3,supportOffset:10,bore:3},{width:180,wall:3,supportOffset:10,bore:3},{width:180,wall:4,supportOffset:12,bore:4}]){
 const r:any=build({schema:'timmy.recipe-request/1',recipe:'enclosure.tray/1',parameters});
 if(r.state!=='succeeded')throw Error(JSON.stringify(r));runs.push(r);
}
const a=runs[0].features,b=runs[1].features;
for(let f=0;f<4;f++){
 if(a[f].id!==b[f].id)throw Error('Feature IDs changed');
 if(Math.abs(b[f].bounds.extentMin[0]-a[f].bounds.extentMin[0]+20)>1e-6||Math.abs(b[f].bounds.extentMax[0]-a[f].bounds.extentMax[0]-20)>1e-6)throw Error('X bounds did not expand ±20');
}
for(let f=2;f<4;f++)for(let i=0;i<4;i++){
 const delta=b[f].cylinderAxesXY[i][0]-a[f].cylinderAxesXY[i][0];
 if(Math.abs(delta-(i<2?-20:20))>1e-6||b[f].cylinderAxesXY[i][1]!==a[f].cylinderAxesXY[i][1])throw Error('Native feature motion differs');
}
const refused:any=build({schema:'timmy.recipe-request/1',recipe:'enclosure.tray/1',parameters:{width:140,wall:0,supportOffset:10,bore:3}});
if(refused.state!=='refused'||refused.nativeStarted!==false)throw Error('Zero wall not refused before native');
// Reject a changed export against the actual native report, then restore our own bytes.
const native=path.join(runs[0].directory,'native'), report=JSON.parse(fs.readFileSync(path.join(native,'result.json'),'utf8'));
const stl=path.join(native,report.variant.stages[0].file), original=fs.readFileSync(stl);let tamperRejected=false;
try{fs.appendFileSync(stl,'tamper');try{gate(report,runs[0].parameters,native);}catch{tamperRejected=true;}}finally{fs.writeFileSync(stl,original);}
if(!tamperRejected)throw Error('Tampered mesh admitted');
let missingCheckRejected=false;const broken=structuredClone(report);broken.variant.checks.pop();try{gate(broken,runs[0].parameters,native);}catch{missingCheckRejected=true;}
if(!missingCheckRejected)throw Error('Incomplete geometry gate admitted');
// Public evidence contains no local paths, raw native files or identity keys.
const publicRuns=runs.map(({directory,...r})=>r);
const evidence={schema:'timmy.spatial-t5k1.acceptance/1',state:'passed',runs:publicRuns,negativeControl:refused,comparison:'Measured support and bore axes move ±20 mm in X; Y unchanged; four stable feature IDs and X bounds verified',tamperRejected,missingCheckRejected,scope:'Native geometry qualification only. No manufacture, structural performance or byte-identical STEP replay claim.'};
fs.mkdirSync('docs/orders/spatial-t5k1',{recursive:true});fs.writeFileSync('docs/orders/spatial-t5k1/evidence.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({state:'passed',runs:runs.map(r=>({receipt:r.receipt,checks:r.checksPassed})),refusal:refused.receipt}));
