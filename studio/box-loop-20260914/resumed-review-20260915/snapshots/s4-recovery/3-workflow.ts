import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

// Local Workflows controller only. Native process ownership and readback remain
// with the separate host. Restart Wrangler using the same --persist-to directory.
// API: https://developers.cloudflare.com/workflows/build/workers-api/
// Retry semantics: https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/
type Job = { id: string; diameter: 32; holdSeconds: 0 | 30 };
type NativeJob = Record<string, unknown>;
type Instance = { id: string; status(): Promise<Record<string, unknown>>; sendEvent(event: {type: string; payload: Record<string, unknown>}): Promise<void> };
interface Env {
  NATIVE_HOST_URL: string;
  NATIVE_JOBS: {
    create(options: { id: string; params: Job }): Promise<Instance>;
    get(id: string): Promise<Instance>;
  };
}
const JOB_ID = /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,99}$/;
const FIXED_NATIVE_HOST = 'http://127.0.0.1:18892';

function jobInput(input: unknown): Job {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Job must be an object');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['id', 'diameter', 'holdSeconds'].includes(key))
    || typeof value.id !== 'string' || !JOB_ID.test(value.id) || value.diameter !== 32
    || value.holdSeconds !== 0 && value.holdSeconds !== 30) {
    throw Error('Expected {id, diameter:32, holdSeconds:0|30}');
  }
  return { id: value.id, diameter: 32, holdSeconds: value.holdSeconds };
}

function nativeUrl(env: Env, id: string): string {
  if (env.NATIVE_HOST_URL !== FIXED_NATIVE_HOST) throw Error('Native host differs from the fixed local checkpoint endpoint');
  return FIXED_NATIVE_HOST + '/jobs/' + encodeURIComponent(id);
}

async function nativeRequest(env: Env, id: string, init?: RequestInit): Promise<NativeJob> {
  const response = await fetch(nativeUrl(env, id), { ...init, redirect: 'manual', signal: AbortSignal.timeout(5000) });
  if (response.status >= 300 && response.status < 400) {
    throw new NonRetryableError('Native host redirect refused: HTTP ' + response.status);
  }
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500 && response.status !== 404 && response.status !== 429) {
      throw new NonRetryableError('Native host rejected job: HTTP ' + response.status);
    }
    throw Error('Native host unavailable: HTTP ' + response.status);
  }
  const text = await response.text();
  if (text.length > 512 * 1024) throw new NonRetryableError('Native response exceeds the bounded workflow result size');
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NonRetryableError('Native response must be an object');
  const data = value as NativeJob;
  const responseId = init?.method === 'POST' ? data.job_id : data.id;
  if (responseId !== id || typeof data.owner_id !== 'string' || !data.owner_id) {
    throw new NonRetryableError('Native response job identity or owner is missing');
  }
  return data;
}

export class NativeEditWorkflow extends WorkflowEntrypoint<Env, Job> {
  async run(event: WorkflowEvent<Job>, step: WorkflowStep) {
    const job = jobInput(event.payload);
    if (event.instanceId !== job.id) throw new NonRetryableError('Workflow instance and native job identity differ');
    const submitted = await step.do('native-submit', {
      retries: { limit: 3, delay: '1 second', backoff: 'constant' }, timeout: '15 seconds',
    }, async () => nativeRequest(this.env, job.id, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': job.id },
      body: JSON.stringify({ diameter: job.diameter, holdSeconds: job.holdSeconds }),
    }));
    if (job.holdSeconds === 30) {
      const signal = await step.waitForEvent<{jobId: string; nativeOwner: string}>('controller-reconnected', {
        type: 'controller-reconnected', timeout: '4 minutes',
      });
      if (signal.payload.jobId !== job.id || signal.payload.nativeOwner !== submitted.owner_id) {
        throw new NonRetryableError('Reconnect signal job or native-owner identity differs');
      }
    }
    const readback = await step.do('native-readback', {
      // Cloudflare applies timeout per attempt, not as a whole-workflow deadline.
      retries: { limit: 60, delay: '1 second', backoff: 'constant' }, timeout: '90 seconds',
    }, async () => {
      const native = await nativeRequest(this.env, job.id);
      if (native.owner_id !== submitted.owner_id) throw new NonRetryableError('Native ownership changed after submission');
      if (native.status === 'failed') throw new NonRetryableError('Native job failed: ' + String(native.error ?? 'unspecified native error'));
      if (native.status === 'queued' || native.status === 'running') throw Error('Native job is still pending');
      if (native.status !== 'completed') throw new NonRetryableError('Native host returned an unknown terminal status');
      const result = native.result as Record<string, unknown> | null;
      const verified = result?.readback as Record<string, unknown> | undefined;
      if (!result || result.job_id !== job.id || result.owner_id !== submitted.owner_id
        || verified?.passed !== true || native.executions !== 1 || result.editExecutions !== 1 || result.sourcePreserved !== true) {
        throw new NonRetryableError('Native job completed without a single owned edit and verified source-preserving readback');
      }
      return native;
    });
    return { schema: 'timmy.native-edit.workflow-result/1', id: job.id, workflowInstanceId: event.instanceId,
      status: 'completed', diameter: job.diameter, nativeJobId: job.id, nativeOwnerId: submitted.owner_id, submitted, readback,
      ownership: 'native host owns the subprocess; Workflow owns durable orchestration and retained step results',
      physicalMeasurement: false };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ status: 'ok', service: 'timmy-native-edit-workflow', mode: 'local', nativeHost: env.NATIVE_HOST_URL });
    }
    if (url.pathname === '/jobs' && request.method === 'POST') {
      let job: Job;
      try {
        const text = await request.text();
        if (text.length > 4096) throw Error('Job request exceeds 4096 characters');
        job = jobInput(JSON.parse(text));
        nativeUrl(env, job.id);
      } catch (error) {
        return Response.json({ status: 'rejected', error: error instanceof Error ? error.message : String(error) }, { status: 400 });
      }
      let instance: Instance, created = true;
      try {
        instance = await env.NATIVE_JOBS.create({ id: job.id, params: job });
      } catch (creationError) {
        // create() rejects reused IDs. Fetch the existing instance; never restart
        // or resubmit it here, and never imply new parameters replaced its payload.
        try { instance = await env.NATIVE_JOBS.get(job.id); created = false; }
        catch { return Response.json({ status: 'failed', error: String(creationError) }, { status: 503 }); }
      }
      return Response.json({ id: instance.id, created, parametersApplied: created,
        workflow: await instance.status(), statusUrl: '/jobs/' + encodeURIComponent(instance.id) }, { status: created ? 202 : 200 });
    }
    const reconnect = /^\/jobs\/([^/]+)\/reconnect$/.exec(url.pathname);
    if (reconnect && request.method === 'POST') {
      const id = decodeURIComponent(reconnect[1]);
      if (!JOB_ID.test(id)) return Response.json({status:'rejected'}, {status:400});
      const instance = await env.NATIVE_JOBS.get(id);
      const before = await instance.status();
      if (['errored','terminated'].includes(String(before.status))) {
        return Response.json({status:'failed', before}, {status:409});
      }
      const native = await nativeRequest(env, id);
      if (native.hold_seconds !== 30 || native.executions !== 1 || !['running','completed'].includes(String(native.status))) {
        return Response.json({status:'rejected', reason:'Expected one owned recovery edit'}, {status:409});
      }
      if (before.status !== 'complete') {
        await instance.sendEvent({type:'controller-reconnected', payload:{jobId:id,nativeOwner:native.owner_id}});
      }
      return Response.json({id, before, wake:'controller-reconnected', resetSteps:false, nativeOwner:native.owner_id});
    }
    const match = /^\/jobs\/([^/]+)$/.exec(url.pathname);
    if (match && request.method === 'GET') {
      let id: string;
      try { id = decodeURIComponent(match[1]); if (!JOB_ID.test(id)) throw Error('Invalid job ID'); }
      catch { return Response.json({ status: 'rejected', error: 'Invalid job ID' }, { status: 400 }); }
      let instance: Instance;
      try { instance = await env.NATIVE_JOBS.get(id); }
      catch { return Response.json({ id, status: 'not_found' }, { status: 404 }); }
      const workflow = await instance.status();
      let native: NativeJob | null = null, nativeError: string | null = null;
      try { native = await nativeRequest(env, id); }
      catch (error) { nativeError = error instanceof Error ? error.message : String(error); }
      return Response.json({ id, workflow, native, nativeError });
    }
    return Response.json({ status: 'not_found', routes: ['POST /jobs', 'GET /jobs/:id', 'GET /health'] }, { status: 404 });
  },
};
