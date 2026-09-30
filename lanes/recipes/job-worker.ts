import {build} from './tray.js';
import {executeJob,recordResult,supervise} from './jobs.js';
const [mode,root,id]=process.argv.slice(2);
try {
 if(mode==='supervise')await supervise(root,id);
 else if(mode==='execute'){
  await executeJob(root,id,async(job,workspace)=>{
   // This entry is a dedicated worker, including when invoked directly.
   process.chdir(workspace);
   process.env.TIMMY_STORE=workspace+'/.timmy/receipts';
   process.env.TIMMY_CADQUERY_PYTHON=job.python??'';
   console.log('Recipe store: '+process.env.TIMMY_STORE);
   const result=build(job.request,{root:workspace,python:job.python});
   recordResult(root,id,result);
  });
 }else throw Error('Unknown recipe worker mode');
}catch(error){console.error(error instanceof Error?error.message:'Recipe worker failed');process.exitCode=1;}
