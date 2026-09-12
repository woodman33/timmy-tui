import express from 'express';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { listPlans } from '../utils/dispatch.js';
import { imageHash, readVisionEvent, visionStorageDir } from './store.js';
import { visionAsset, loadVisionEnvironment } from './config.js';
import { getVisionCatalog } from './platform.js';
import { publicVisionEvent, findVisionOutput } from './presentation.js';
import { getVisionStatus, runVisionInspection, listVisionEvents, recordVisionFeedback,
  syncVisionEvent, queryCloudVisionEvents, listLearningCandidates } from './runtime.js';

export function createVisionApp(dir = process.cwd()) {
  loadVisionEnvironment(dir);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const hostname = req.hostname;
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) {
      res.status(403).json({ ok: false, state: 'forbidden', note: 'Use the local Timmy address.' }); return;
    }
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) {
      res.status(403).json({ ok: false, state: 'forbidden', note: 'Open this action in Timmy.' }); return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '28mb' }));
  const options = { dir };
  const handle = (fn: (req: express.Request) => unknown) => async (req: express.Request, res: express.Response) => {
    try { res.json(await fn(req)); }
    catch { res.status(500).json({ ok: false, state: 'error', note: 'The operation failed. Check the local runtime and try again.' }); }
  };
  app.get('/api/vision/status', handle(() => getVisionStatus(options)));
  app.get('/api/vision/catalog', handle(() => getVisionCatalog(options)));
  app.get('/api/vision/events', handle(() => {
    const result = listVisionEvents({ limit: 100 }, options);
    return { ...result, events: result.events.map(publicVisionEvent) };
  }));
  app.get('/api/vision/events/:id/outputs/:digest', (req, res) => {
    try {
      const event = readVisionEvent(req.params.id, options);
      if (!event) { res.sendStatus(404); return; }
      const output = findVisionOutput(event, req.params.digest);
      if (!output) { res.sendStatus(404); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.type(output.mimeType).send(output.bytes);
    } catch { res.sendStatus(404); }
  });
  app.get('/api/vision/events/:id/image', (req, res) => {
    try {
      const event = readVisionEvent(req.params.id, options);
      if (!event) { res.sendStatus(404); return; }
      if (dirname(resolve(event.image.path)) !== resolve(visionStorageDir(options), 'images')) { res.sendStatus(403); return; }
      const bytes = readFileSync(event.image.path);
      if (imageHash(bytes) !== event.image.sha256) { res.status(409).json({ ok: false, state: 'integrity_error' }); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.type(event.image.mimeType).send(bytes);
    } catch { res.sendStatus(404); }
  });
  app.get('/api/vision/learning', handle(() => {
    const result = listLearningCandidates({ limit: 100 }, options);
    return { ...result, events: result.events.map(publicVisionEvent) };
  }));
  app.get('/api/vision/cloud-events', handle(() => queryCloudVisionEvents({ limit: 50 }, options)));
  app.post('/api/vision/run', handle(async req => {
    if (typeof req.body?.imageBase64 !== 'string') return { ok: false, state: 'invalid_request', note: 'Choose an image first.' };
    // Browser requests never get arbitrary local-file read access.
    const { imageBase64, filename, modelId, workspace, workflowId, parameters, imageInput,
      templateId, sourceId, metadata, confidenceThreshold } = req.body;
    const result = await runVisionInspection({ imageBase64, filename, modelId, workspace, workflowId,
      parameters, imageInput, templateId, sourceId, metadata, confidenceThreshold }, options);
    return 'event' in result && result.event ? { ...result, event: publicVisionEvent(result.event) } : result;
  }));
  app.post('/api/vision/feedback', handle(req => recordVisionFeedback(req.body, options)));
  app.post('/api/vision/sync', handle(req => syncVisionEvent(req.body, options)));
  app.get('/dispatch', (_req, res) => res.json(listPlans(dir)));
  app.use(express.static(visionAsset('studio/tldraw-mission-map', dir), { etag: true }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.type === 'entity.too.large' ? 413 : 400).json({ ok: false, state: 'invalid_request', note: 'Send a valid JSON request with an image under 12 MB.' });
  });
  return app;
}

export async function startVisionServer(port = 4336, dir = process.cwd()) {
  const server = createServer(createVisionApp(dir));
  server.requestTimeout = 310_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return server;
}
