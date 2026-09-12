import {readSceneWithEvidence} from './store.js';import {answer,sceneSchema} from './scene.js';
try{
 const args=process.argv.slice(2),words:string[]=[],flags:Record<string,string>={};
 for(let i=0;i<args.length;i++){
  if(args[i].startsWith('--')){const key=args[i];if(!['--receipt','--frame','--unit','--rotation'].includes(key)||flags[key]!==undefined||!args[i+1])throw Error('Invalid inspect option');flags[key]=args[++i];}
  else words.push(args[i]);
 }
 const question=words.join(' ').trim();if(!question)throw Error('timmy inspect <clearance|frame|empty spaces|arrows|bore A|coverage> [--receipt ID] [--frame part|world] [--unit mm|m] [--rotation 0|90]');
 const {scene:retained,observedAt}=readSceneWithEvidence(process.cwd(),flags['--receipt']);
 const view=sceneSchema.parse({...retained,frame:{...retained.frame,...(flags['--frame']?{id:flags['--frame']}:{}),...(flags['--unit']?{unit:flags['--unit']}:{}),...(flags['--rotation']?{rotationZ:Number(flags['--rotation'])}:{})}});
 const result={...answer(view,question),displayTransformOnly:true,observedAt};console.log(JSON.stringify(result,null,2));
 if(result.state==='failed'||result.state==='unsupported')process.exitCode=1;
}catch(e){console.error(JSON.stringify({state:'unavailable',reason:String(e)}));process.exitCode=1;}
