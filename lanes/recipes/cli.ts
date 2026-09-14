import fs from 'node:fs';
import {build,validate,prediction,cardPath} from './tray.js';
const [command,...args]=process.argv.slice(2);
try{
 if(command==='list'&&args.length===0)console.log(fs.readFileSync(cardPath,'utf8'));
 else if(['plan','build'].includes(command)&&args.length===2&&args[0]==='--request'){
  if(fs.statSync(args[1]).size>16384)throw Error('Request too large');
  const input=JSON.parse(fs.readFileSync(args[1],'utf8'));
  const result=command==='plan'?prediction(validate(input)):build(input);
  console.log(JSON.stringify(result,null,2));
  if(command==='build'&&(result as any).state!=='succeeded')process.exitCode=1;
 }else{console.log('timmy recipe list | plan --request FILE | build --request FILE');process.exitCode=2;}
}catch(e){console.error(String(e));process.exitCode=1;}
