import fs from 'node:fs';import path from 'node:path';
import {readChain,verifySignature,hashOf} from '../../../src/utils/receipts.js';
import {sha} from '../tray.js';import {sceneSchema,validateObservations} from './scene.js';
export function readSceneWithEvidence(root=process.cwd(),receiptId?:string){
 const pointer=receiptId?{receipt:receiptId}:JSON.parse(fs.readFileSync(path.join(root,'.timmy/spatial03/current.json'),'utf8'));
 const chain=readChain('runs',root),r=chain.find(r=>r.id===pointer.receipt);
 const valid=(r:any)=>r&&verifySignature(r)&&r.hash===hashOf({...r,hash:''});
 if(!valid(r)||r!.subject!=='spatial-t5k1.phase2.scene'||!['ok','failed'].includes(r!.status||'')||r!.kind!=='spatial.scene')throw Error('Scene seal unavailable');
 const sources=r!.sources as {path:string;sha256:string}[];
 for(const s of sources)if(sha(fs.readFileSync(s.path))!==s.sha256)throw Error('Scene source drift');
 const file=sources.find(s=>path.basename(s.path)==='scene.json');if(!file)throw Error('Scene missing');
 const scene=sceneSchema.parse(JSON.parse(fs.readFileSync(file.path,'utf8')));
 const native=chain.find(r=>r.id===scene.sourceReceipt);
 if(!valid(native)||native!.subject!=='spatial-t5k1.phase2.native'||native!.status!=='ok')throw Error('Native source seal unavailable');
 for(const s of native!.sources as {path:string;sha256:string}[])if(sha(fs.readFileSync(s.path))!==s.sha256)throw Error('Native source drift');
 const observation=(native!.sources as any[]).find(s=>path.basename(s.path)==='observations.json');
 if(!observation)throw Error('72-check observation missing');
 if(scene.revision!==observation.sha256)throw Error('Scene/native revision mismatch');
 const observations=JSON.parse(fs.readFileSync(observation.path,'utf8'));
 validateObservations(observations);
 return {scene,observedAt:observations.measuredAt};
}

export function readScene(root=process.cwd(),receiptId?:string){return readSceneWithEvidence(root,receiptId).scene;}
