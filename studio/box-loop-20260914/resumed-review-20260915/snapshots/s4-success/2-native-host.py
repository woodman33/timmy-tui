#!/usr/bin/env python3
"""Owned loopback native executor. Controller restarts never resubmit an edit."""
import argparse,hashlib,json,os,re,sqlite3,subprocess,threading,time,uuid
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
ROOT=Path(__file__).resolve().parents[3]
STATE=ROOT/'.timmy/private/box-durable-manual-20260915';STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
ART=ROOT/'studio/box-loop-20260914/s4m-native';ART.mkdir(exist_ok=True)
SOURCE=ROOT/'studio/box-loop-20260914/s2/native/scene.blend'
SOURCE_HASH='223392ee88d0e7d4cde14ea617d7b996e6ae731fd5614c3cc0e26bc10b2e0059'
BLENDER='/Applications/Blender.app/Contents/MacOS/Blender'
SCRIPT=ROOT/'tools/box-loop-20260914/durable-manual-20260915/revise-bore.py'
OWNER_FILE=STATE/'owner.json'
if not OWNER_FILE.exists():
 with OWNER_FILE.open('x') as f:json.dump({'owner_id':'native-'+str(uuid.uuid4())},f)
OWNER=json.loads(OWNER_FILE.read_text())['owner_id']
def db():
 c=sqlite3.connect(STATE/'jobs.sqlite',timeout=20);c.row_factory=sqlite3.Row;c.execute('PRAGMA journal_mode=WAL');c.execute('PRAGMA synchronous=FULL');return c
with db() as c:c.execute('CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,owner_id TEXT,diameter REAL,hold_seconds INTEGER,status TEXT,phase TEXT,executions INTEGER DEFAULT 0,submissions INTEGER DEFAULT 1,result TEXT,error TEXT,created REAL,finished REAL)')
def save(p,data):
 with p.open('x') as f:json.dump(data,f,indent=2);f.write('\n')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def row(id):
 with db() as c:r=c.execute('SELECT * FROM jobs WHERE id=?',(id,)).fetchone()
 if not r:return None
 x=dict(r)
 if x['result']:x['result']=json.loads(x['result'])
 x['nativeHostPid']=os.getpid()
 for key,name in [('editLaunch','edit-launch.json'),('editPhase','native-edit-started.json')]:
  path=ART/id/name
  if path.exists():
   try:x[key]=json.loads(path.read_text())
   except ValueError:pass
 return x
def run(id):
 folder=ART/id
 try:
  folder.mkdir(exist_ok=False)
  with db() as c:
   claimed=c.execute("UPDATE jobs SET status='running',phase='native-owned',executions=executions+1 WHERE id=? AND executions=0",(id,))
   if claimed.rowcount!=1:raise RuntimeError('Native job already claimed; launch refused')
  job=row(id)
  save(folder/'native-ownership.json',{'job_id':id,'owner_id':OWNER,'nativeHostPid':os.getpid(),'sourceSha256':SOURCE_HASH,'executions':job['executions']})
  if sha(SOURCE)!=SOURCE_HASH:raise RuntimeError('Source document changed')
  with db() as c:c.execute("UPDATE jobs SET phase='editing' WHERE id=?",(id,))
  for mode in ['edit','readback']:
   args=[BLENDER,'--background','--factory-startup','--disable-autoexec','--python-exit-code','2','--python',str(SCRIPT),'--',mode,'--source',str(SOURCE),'--out',str(folder/'revision.blend'),'--job-id',id,'--source-sha256',SOURCE_HASH,'--diameter',str(job['diameter']),'--report',str(folder/(mode+'.json'))]
   args+=['--hold-seconds',str(job['hold_seconds'] if mode=='edit' else 0)]
   child=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   save(folder/(mode+'-launch.json'),{'job_id':id,'pid':child.pid,'parentPid':os.getpid(),'at':time.time(),'argv':args,'executionOrdinal':1})
   try:stdout,stderr=child.communicate(timeout=90)
   except subprocess.TimeoutExpired:
    child.kill();stdout,stderr=child.communicate();save(folder/(mode+'-timeout.json'),{'pid':child.pid,'stopped':True,'at':time.time()})
   save(folder/(mode+'-process.json'),{'argv':args,'pid':child.pid,'status':child.returncode,'stdout':stdout,'stderr':stderr})
   if child.returncode:raise RuntimeError(mode+' native process failed')
  readback=json.loads((folder/'readback.json').read_text())
  if not readback.get('passed'):raise RuntimeError('Native readback failed')
  if readback.get('jobId')!=id or readback.get('sourceSha256')!=SOURCE_HASH or readback.get('outputSha256')!=sha(folder/'revision.blend'):raise RuntimeError('Readback document identity mismatch')
  if sha(SOURCE)!=SOURCE_HASH:raise RuntimeError('Source changed after native edit')
  output={'job_id':id,'owner_id':OWNER,'sourceRevision':SOURCE_HASH,'documentRevision':sha(folder/'revision.blend'),'document':str((folder/'revision.blend').relative_to(ROOT)),'readback':readback,'editExecutions':row(id)['executions'],'sourcePreserved':True}
  save(folder/'result.json',output)
  with db() as c:c.execute("UPDATE jobs SET status='completed',phase='verified',result=?,finished=? WHERE id=?",(json.dumps(output),time.time(),id))
 except Exception as e:
  with db() as c:c.execute("UPDATE jobs SET status='failed',phase='failed',error=?,finished=? WHERE id=?",(str(e),time.time(),id))
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def answer(self,status,data):
  body=json.dumps(data).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def do_GET(self):
  if self.path=='/health':return self.answer(200,{'status':'ready','owner_id':OWNER,'pid':os.getpid()})
  id=self.path.removeprefix('/jobs/')
  if not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}',id):return self.answer(400,{'error':'invalid id'})
  value=row(id);return self.answer(200 if value else 404,value or {'error':'not found'})
 def do_POST(self):
  id=self.path.removeprefix('/jobs/')
  if not self.path.startswith('/jobs/') or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}',id):return self.answer(400,{'error':'invalid id'})
  n=int(self.headers.get('Content-Length','0'))
  if n<1 or n>2048:return self.answer(400,{'error':'invalid body'})
  try:
   payload=json.loads(self.rfile.read(n));diameter=float(payload['diameter']);hold=int(payload.get('holdSeconds',0))
   if diameter!=32 or hold not in (0,30):raise ValueError()
  except Exception:return self.answer(400,{'error':'fixed checkpoint accepts diameter32 and hold0or30'})
  with db() as c:
   c.execute('BEGIN IMMEDIATE');existing=c.execute('SELECT diameter,hold_seconds FROM jobs WHERE id=?',(id,)).fetchone()
   if existing:
    if existing['diameter']!=diameter or existing['hold_seconds']!=hold:return self.answer(409,{'error':'job request identity conflict'})
    c.execute('UPDATE jobs SET submissions=submissions+1 WHERE id=?',(id,));fresh=False
   else:
    c.execute("INSERT INTO jobs(id,owner_id,diameter,hold_seconds,status,phase,created) VALUES(?,?,?,?,?,?,?)",(id,OWNER,diameter,hold,'queued','queued',time.time()));fresh=True
  if fresh:threading.Thread(target=run,args=(id,),daemon=False).start()
  return self.answer(202,{'job_id':id,'owner_id':OWNER,'fresh':fresh,'status':row(id)['status']})
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=18892);args=parser.parse_args()
 print(json.dumps({'status':'ready','owner_id':OWNER,'pid':os.getpid(),'port':args.port}),flush=True)
 ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
