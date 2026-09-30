import fs from 'node:fs';
import {build,validate,prediction,cardPath} from './tray.js';
import {enqueue,start,status,cancel,recover} from './jobs.js';
const [command,...args]=process.argv.slice(2);
try{
 if(command==='list'&&args.length===0)console.log(fs.readFileSync(cardPath,'utf8'));
 else if(command==='jobs'){
  const [action,...rest]=args;
  if(action==='enqueue'&&rest.length===2&&rest[0]==='--request'){
   if(fs.statSync(rest[1]).size>16384)throw Error('Request too large');
   console.log(JSON.stringify(enqueue(JSON.parse(fs.readFileSync(rest[1],'utf8'))),null,2));
  }else if(rest.length===1&&['start','status','cancel','recover'].includes(action)){
   const result=action==='start'?await start(process.cwd(),rest[0]):({status,cancel,recover} as const)[action as 'status'|'cancel'|'recover'](process.cwd(),rest[0]);
   console.log(JSON.stringify(result,null,2));
  }else throw Error('recipe jobs enqueue --request FILE | start/status/cancel/recover UUID');
 }
 else if(['plan','build'].includes(command)&&args.length===2&&args[0]==='--request'){
  if(fs.statSync(args[1]).size>16384)throw Error('Request too large');
  const input=JSON.parse(fs.readFileSync(args[1],'utf8'));
  const result=command==='plan'?prediction(validate(input)):build(input);
  console.log(JSON.stringify(result,null,2));
  if(command==='build'&&(result as any).state!=='succeeded')process.exitCode=1;
 }else{console.log('timmy recipe list | plan --request FILE | build --request FILE');process.exitCode=2;}
}catch(e){console.error(String(e));process.exitCode=1;}
