/** Additive SceneIR contract. It cannot authorize or dispatch materialization. */
import {z} from 'zod';
import crypto from 'node:crypto';
const finite=z.number().finite();
const point=z.tuple([finite,finite,finite]);
const identity={id:z.string().min(1),source:z.string().min(1),target:z.string().min(1)};
export const arrowSchema=z.discriminatedUnion('kind',[
 z.object({...identity,kind:z.literal('materialization'),sourceRevision:z.string().min(1),intentHash:z.string().regex(/^[a-f0-9]{64}$/),capability:z.literal('enclosure.tray/1'),state:z.literal('proposed')}).strict(),
 z.object({...identity,kind:z.literal('dependency'),relationship:z.string().min(1),executes:z.literal(false)}).strict(),
 z.object({...identity,kind:z.literal('hypothesis'),missingEvidence:z.string().min(1),executes:z.literal(false)}).strict(),
]);
export const sceneSchema=z.object({
 schema:z.literal('timmy.scene-ir/1'),revision:z.string().min(1),sourceReceipt:z.string().min(1),
 frame:z.object({id:z.enum(['part','world']),unit:z.enum(['mm','m']),origin:z.literal('center of exterior base'),handedness:z.literal('right'),up:z.literal('+Z'),rotationZ:z.union([z.literal(0),z.literal(90)]),dimension:z.literal(3)}).strict(),
 emptySpaces:z.array(z.object({id:z.string(),name:z.string(),kind:z.literal('required-empty-space'),frame:z.literal('part'),unit:z.literal('mm'),center:point,radiusMm:finite.positive(),zSpanMm:z.tuple([finite,finite]),basis:z.literal('analytical'),nativeBuilt:z.literal(false)}).strict()).length(4),
 arrows:z.array(arrowSchema).length(3),
}).strict().refine(s=>new Set(s.emptySpaces.map(e=>e.id)).size===4&&new Set(s.arrows.map(a=>a.kind)).size===3&&new Set(s.arrows.map(a=>a.id)).size===3,'Duplicate feature or arrow identity');
export type SceneIR=z.infer<typeof sceneSchema>;
export function transform(p:number[],rotation:0|90,unit:'mm'|'m'){
 if(p.length!==3||p.some(n=>!Number.isFinite(n))||![0,90].includes(rotation)||!['mm','m'].includes(unit))throw Error('Unsupported coordinate frame');
 const a=rotation===0?p:[-p[1],p[0],p[2]];return a.map(v=>v/(unit==='m'?1000:1));
}
export function frameChip(frame:SceneIR['frame']){return `${frame.id.toUpperCase()} · ${frame.unit} · +Z · RH · origin: ${frame.origin} · placement Z ${frame.rotationZ}°`;}
export function validateObservations(o:any){
 const names=['radius','axisParallelZ','xEdgeOffset','yEdgeOffset','zSpan','completeCylindricalFace'];
 if(o?.units!=='mm'||o.variants?.length!==3||JSON.stringify(o.variants.map((v:any)=>v.variant).sort())!==JSON.stringify(['w100','w140','w180']))throw Error('72-check coverage missing');
 let count=0;
 for(const v of o.variants){
  if(v.features.length!==4||v.features.map((f:any)=>f.id).sort().join()!=='A,B,C,D')throw Error('Bore coverage missing');
  const w=Number(v.variant.slice(1));
  for(const f of v.features){
   if(Object.keys(f.checks).sort().join()!==[...names].sort().join()||names.some(k=>f.checks[k]!==true))throw Error('Native bore check failed');
   const x=['A','C'].includes(f.id)?-(w/2-10):w/2-10,y=['A','B'].includes(f.id)?30:-30;
   if(!Array.isArray(f.axisAtBase)||f.axisAtBase.length!==3||f.axisAtBase.some((n:number,i:number)=>!Number.isFinite(n)||Math.abs(n-[x,y,0][i])>1e-6)||!Number.isFinite(f.radius)||Math.abs(f.radius-1.5)>1e-6||f.zSpan?.length!==2||f.zSpan.some((n:number,i:number)=>!Number.isFinite(n)||Math.abs(n-[0,11][i])>1e-6))throw Error('Native measurement differs from forecast');
   count+=names.length;
  }
 }return count===72;
}
export function scene(o:any,sourceReceipt:string,revision:string,radius=4.5,display:'part'|'world'='part',unit:'mm'|'m'='mm',rotation:0|90=0):SceneIR{
 validateObservations(o);if(!Number.isFinite(radius)||radius<3||radius>9)throw Error('Envelope radius must be 3…9 mm');
 const variant=o.variants.find((v:any)=>v.variant==='w140');
 const intentHash=crypto.createHash('sha256').update(JSON.stringify({revision,radius})).digest('hex');
 return sceneSchema.parse({schema:'timmy.scene-ir/1',revision,sourceReceipt,frame:{id:display,unit,origin:'center of exterior base',handedness:'right',up:'+Z',rotationZ:rotation,dimension:3},emptySpaces:variant.features.map((f:any)=>({id:`tool.${f.id}`,name:`Bore ${f.id} axial tool envelope`,kind:'required-empty-space',frame:'part',unit:'mm',center:[...f.axisAtBase.slice(0,2),11],radiusMm:radius,zSpanMm:[11,61],basis:'analytical',nativeBuilt:false})),arrows:[{id:'arrow.build',kind:'materialization',source:'tray.recipe',target:'tray.part',sourceRevision:revision,intentHash,capability:'enclosure.tray/1',state:'proposed'},{id:'arrow.width',kind:'dependency',source:'tray.width',target:'tray.bores',relationship:'edge-offset constraint',executes:false},{id:'arrow.access',kind:'hypothesis',source:'tool.A',target:'tool.path',missingEvidence:'Complete swept volume has not been tested',executes:false}]});
}
export const questions=['clearance','frame','empty spaces','arrows','bore A','coverage'] as const;
export function answer(s:SceneIR,question:string){
 sceneSchema.parse(s);
 const chip=frameChip(s.frame),gap=10-3-s.emptySpaces[0].radiusMm;
 const common={revision:s.revision,sourceReceipt:s.sourceReceipt,frameChip:chip,scope:'Retained native geometry plus analytical envelope; no new native execution',unmeasured:['complete tool path','physical validation']};
 if(question==='clearance')return {...common,question,state:gap>=2?'passed':'failed',basis:'analytical',gapMm:gap,minimumMm:2,formula:'10 mm edge offset − 3 mm wall − envelope radius',claim:'Horizontal wall gap only; not full-path clearance'};
 if(question==='frame')return {...common,question,state:'available',frame:s.frame,point:transform(s.emptySpaces[0].center,s.frame.id==='world'?s.frame.rotationZ:0,s.frame.unit)};
 if(question==='empty spaces')return {...common,question,state:'available',features:s.emptySpaces};
 if(question==='arrows')return {...common,question,state:'available',arrows:s.arrows};
 if(question==='bore A')return {...common,question,state:'retained-native',centerMm:s.emptySpaces[0].center,diameterMm:3};
 if(question==='coverage')return {...common,question,state:gap>=2?'passed':'failed',nativeChecks:{passed:72,total:72},analyticalClearance:gap>=2?'passed':'failed',unmeasuredCount:2};
 return {...common,question,state:'unsupported',supportedQuestions:questions};
}
