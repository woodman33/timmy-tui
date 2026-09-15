#!/usr/bin/env python3
import argparse,hashlib,json,os,signal,socket,subprocess,time,urllib.error,urllib.request,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];STATE=ROOT/'.timmy/private/box-durable-manual-20260915';STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
WRANGLER='{{HOME}}/.npm/_npx/32026684e21afda6/node_modules/wrangler/bin/wrangler.js'
CONFIG=ROOT/'tools/box-loop-20260914/durable-manual-20260915/wrangler.json';NATIVE='http://127.0.0.1:18892';CONTROL='http://127.0.0.1:18891'
SOURCE=ROOT/'studio/box-loop-20260914/s2/native/scene.blend';SOURCEHASH='223392ee88d0e7d4cde14ea617d7b996e6ae731fd5614c3cc0e26bc10b2e0059'
def save(path,obj):
 with path.open('x') as f:json.dump(obj,f,indent=2);f.write('\n')
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def http(base,path,body=None,timeout=5):
 data=None if body is None else json.dumps(body).encode();req=urllib.request.Request(base+path,data=data,headers={'Content-Type':'application/json'},method='GET' if body is None else 'POST')
 with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=timeout) as r:return json.load(r)
def ready(base):
 deadline=time.monotonic()+45
 while time.monotonic()<deadline:
  try:
   value=http(base,'/health')
   if value.get('status') in ('ready','ok'):return value
  except Exception:pass
  time.sleep(.25)
 raise RuntimeError('Local service did not become ready: '+base)
def start_controller(logname):
 log=(STATE/logname).open('xb');env=dict(os.environ,WRANGLER_SEND_METRICS='false')
 args=['node',WRANGLER,'dev','--local','--config',str(CONFIG),'--persist-to',str(STATE/'workflow-state'),'--ip','127.0.0.1','--port','18891']
 p=subprocess.Popen(args,cwd=ROOT,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);log.close();return p.pid
def wait_job(job_id,log):
 deadline=time.monotonic()+210
 with log.open('x') as f:
  while time.monotonic()<deadline:
   try:status=http(CONTROL,'/jobs/'+job_id)
   except Exception as e:status={'http_error':str(e)}
   f.write(json.dumps({'at':time.time(),'value':status})+'\n');f.flush()
   workflow=status.get('workflow',{})
   if workflow.get('status') in ('errored','terminated'):raise RuntimeError('Workflow failed: '+json.dumps(workflow))
   if workflow.get('status') not in ('queued','running','waiting','complete','completed'):
    if 'http_error' in status:time.sleep(.5);continue
    raise RuntimeError('Workflow has no admissible pending or completed status: '+json.dumps(status))
   try:native=http(NATIVE,'/jobs/'+job_id)
   except urllib.error.HTTPError as e:
    if e.code==404 and workflow.get('status') in ('queued','running','waiting'):time.sleep(.25);continue
    raise
   if native['status']=='failed':raise RuntimeError('Native job failed: '+str(native['error']))
   if workflow.get('status') in ('complete','completed'):
    if native['status']!='completed':raise RuntimeError('Workflow/native terminal mismatch')
    return status,native
   time.sleep(.5)
 raise RuntimeError('Workflow completion deadline exceeded')
parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['success','recovery']);parser.add_argument('--op-id',required=True);args=parser.parse_args()
OUT=ROOT/('studio/box-loop-20260914/s4m-'+args.mode);job_id='bore-'+args.mode+'-'+str(uuid.uuid4());started=time.time();result=None;native_pid=None;controller_pid=None
try:
 if sha(SOURCE)!=SOURCEHASH:raise RuntimeError('Source hash mismatch')
 if args.mode=='success':
  for port in [18891,18892]:
   with socket.socket() as s:s.bind(('127.0.0.1',port))
  log=(STATE/'native-host.log').open('xb');p=subprocess.Popen(['python3',str(ROOT/'tools/box-loop-20260914/durable-manual-20260915/native-host.py')],cwd=ROOT,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True);log.close();native_pid=p.pid
  native_ready=ready(NATIVE);controller_pid=start_controller('controller-success.log');ready(CONTROL)
  save(STATE/'processes.json',{'nativePid':native_pid,'controllerPid':controller_pid,'owner_id':native_ready['owner_id'],'controllerRole':'Cloudflare Wrangler local Workflows runtime','nativeRole':'independent owned host process'})
 else:
  process=json.loads((STATE/'processes.json').read_text());native_pid=process['nativePid'];controller_pid=process['controllerPid'];native_ready=ready(NATIVE);ready(CONTROL)
  if native_ready['pid']!=native_pid:raise RuntimeError('Native host ownership changed')
 payload={'id':job_id,'diameter':32,'holdSeconds':30 if args.mode=='recovery' else 0};submitted=http(CONTROL,'/jobs',payload);save(OUT/'submitted.json',{'job_id':job_id,'payload':payload,'response':submitted,'controllerPid':controller_pid,'nativePid':native_pid})
 if args.mode=='recovery':
  deadline=time.monotonic()+20
  while time.monotonic()<deadline:
   controller_status=http(CONTROL,'/jobs/'+job_id)
   if controller_status.get('workflow',{}).get('status') in ('errored','terminated'):raise RuntimeError('Workflow failed before interruption: '+json.dumps(controller_status))
   try:native=http(NATIVE,'/jobs/'+job_id)
   except urllib.error.HTTPError as e:
    if e.code==404 and controller_status.get('workflow',{}).get('status') in ('queued','running','waiting'):time.sleep(.1);continue
    raise
   if native['status']=='running' and native.get('editPhase',{}).get('phase')=='geometry-edited-before-publication':
    child=native['editLaunch']['pid']
    if native['editPhase']['pid']!=child or native['editPhase']['parentPid']!=native_pid:raise RuntimeError('Native edit child identity mismatch')
    os.kill(child,0)
    break
   if native['status'] in ('failed','completed'):raise RuntimeError('Did not intercept native running phase')
   time.sleep(.1)
  else:raise RuntimeError('Native job did not enter owned phase')
  save(OUT/'before-kill.json',{'job_id':job_id,'native':native,'controller':http(CONTROL,'/jobs/'+job_id),'controllerPid':controller_pid,'nativePid':native_pid,'at':time.time()})
  identity=subprocess.check_output(['ps','-p',str(controller_pid),'-o','command='],text=True).strip()
  if WRANGLER not in identity or str(CONFIG) not in identity or os.getpgid(controller_pid)!=controller_pid:raise RuntimeError('Controller process ownership mismatch')
  save(OUT/'controller-identity.json',{'pid':controller_pid,'pgid':os.getpgid(controller_pid),'command':identity,'nativeEditPid':child})
  os.killpg(controller_pid,signal.SIGKILL);time.sleep(1)
  try:http(CONTROL,'/health',timeout=1)
  except Exception:controller_down=True
  else:controller_down=False
  if not controller_down:raise RuntimeError('Controller still answered after kill')
  retained=http(NATIVE,'/jobs/'+job_id)
  os.kill(child,0)
  if retained['nativeHostPid']!=native_pid or retained['executions']!=1:raise RuntimeError('Native ownership lost after controller kill')
  save(OUT/'controller-killed.json',{'signal':'SIGKILL','controllerPid':controller_pid,'controllerDown':controller_down,'nativeStillOwned':retained,'at':time.time()})
  controller_pid=start_controller('controller-recovery.log');ready(CONTROL)
  reconnected=http(CONTROL,'/jobs/'+job_id);save(OUT/'reconnected.json',{'controllerPid':controller_pid,'sameJobId':job_id,'response':reconnected,'samePersistDirectory':True})
  wake=http(CONTROL,'/jobs/'+job_id+'/reconnect',{})
  save(OUT/'recovery-signal.json',{'response':wake,'at':time.time(),'method':'Cloudflare instance.sendEvent','stepCacheReset':False})
 status,native=wait_job(job_id,OUT/'status-history.jsonl')
 if native['executions']!=1 or native['result']['editExecutions']!=1 or not native['result']['readback']['passed'] or sha(SOURCE)!=SOURCEHASH:raise RuntimeError('Exactly-once/readback/source gate failed')
 folder=ROOT/'studio/box-loop-20260914/s4m-native'/job_id
 edit=json.loads((folder/'edit-process.json').read_text());readback_process=json.loads((folder/'readback-process.json').read_text())
 if edit['status']!=0 or readback_process['status']!=0 or edit['pid']==readback_process['pid']:raise RuntimeError('Independent fresh native readback process gate failed')
 if sha(folder/'revision.blend')!=native['result']['documentRevision'] or native['result']['readback']['outputSha256']!=native['result']['documentRevision']:raise RuntimeError('Document revision hash mismatch')
 if args.mode=='recovery' and native['submissions']!=1:raise RuntimeError('Recovered workflow did not retain its completed native-submit step')
 duplicate=http(NATIVE,'/jobs/'+job_id,{'diameter':32,'holdSeconds':payload['holdSeconds']});after=http(NATIVE,'/jobs/'+job_id)
 if duplicate['fresh'] or after['executions']!=1 or after['result']['documentRevision']!=native['result']['documentRevision']:raise RuntimeError('Idempotent resubmit gate failed')
 save(OUT/'dedupe-control.json',{'response':duplicate,'after':after})
 save(OUT/'workflow-complete.json',status);save(OUT/'native-complete.json',native)
 save(OUT/'service-ownership.json',{'nativePid':native_pid,'controllerPid':controller_pid,'owner_id':native_ready['owner_id']})
 if args.mode=='recovery':
  result_scope='Signal-assisted Cloudflare local recovery: controller SIGKILL, same persistence directory, explicit reconnect event, retained step results. Native-host crash and power loss not tested.'
 else:result_scope='Cloudflare local Workflows plus separately owned native edit and fresh readback; generated geometry only.'
 result={'schema':'timmy.op.result/1','op_id':args.op_id,'job_id':job_id,'run_id':job_id,'status':'ok','mode':args.mode,'controller':'Cloudflare Workflows local dev','nativeOwner':native['owner_id'],'controllerPid':controller_pid,'nativePid':native_pid,'controllerInterrupted':args.mode=='recovery','sourceRevision':SOURCEHASH,'documentRevision':native['result']['documentRevision'],'document':native['result']['document'],'readback':native['result']['readback'],'editExecutions':1,'sourcePreserved':True,'durationSeconds':time.time()-started,'scope':'Controller process kill/restart only; not native-host crash or power-loss proof.'}
 result['scope']=result_scope
except Exception as e:result={'schema':'timmy.op.result/1','op_id':args.op_id,'job_id':job_id,'status':'failed','mode':args.mode,'error':str(e),'durationSeconds':time.time()-started,'queueStopped':True}
finally:
 # A terminal normal run leaves its owned services for the recovery checkpoint.
 # A failed gate or completed recovery closes only this attempt's owned services.
 if result and (result['status']=='failed' or args.mode=='recovery'):
  cleanup=[]
  for role,pid in [('controller',controller_pid),('native',native_pid)]:
   if pid:
    try:os.killpg(pid,signal.SIGTERM);cleanup.append({'role':role,'pid':pid,'signal':'SIGTERM'})
    except ProcessLookupError:cleanup.append({'role':role,'pid':pid,'alreadyExited':True})
  save(OUT/'cleanup-requested.json',cleanup)
  closed=[]
  deadline=time.monotonic()+5
  while time.monotonic()<deadline:
   closed=[]
   for port in [18891,18892]:
    with socket.socket() as sock:
     sock.settimeout(.25);closed.append({'port':port,'closed':sock.connect_ex(('127.0.0.1',port))!=0})
   if all(x['closed'] for x in closed):break
   time.sleep(.1)
  save(OUT/'cleanup-verified.json',{'ports':closed,'passed':all(x['closed'] for x in closed)})
  if not all(x['closed'] for x in closed):result.update(status='failed',queueStopped=True,cleanupFailure='Owned listener did not close')
 for log in STATE.glob('*.log'):
  (OUT/log.name).write_bytes(log.read_bytes())
save(OUT/'result.json',result);print(json.dumps(result));raise SystemExit(0 if result['status']=='ok' else 2)
