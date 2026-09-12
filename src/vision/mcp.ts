import { getVisionStatus, runVisionInspection, listVisionEvents, recordVisionFeedback,
  syncVisionEvent, queryCloudVisionEvents, listLearningCandidates } from './runtime.js';
import { loadVisionEnvironment } from './config.js';
import { getVisionCatalog } from './platform.js';
import { publicVisionEvent } from './presentation.js';

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const text = { type: 'string' };
export const VISION_TOOLS = [
  { name: 'timmy_vision_catalog', description: 'Read the connected Roboflow workspace, projects, and saved Workflows. Distinguishes empty drafts and upload sinks. Does not run inference or change the workspace.', inputSchema: schema({}) },
  { name: 'timmy_vision_status', description: 'Inspect Roboflow configuration and local dependency readiness; no inference or cloud request.', inputSchema: schema({}) },
  { name: 'timmy_vision_inspect', description: 'Run the configured local/library/remote Roboflow model or saved Workflow on an image. Saves evidence, predictions and a TIMMY receipt. Only run on user-authorized images and compute.', inputSchema: schema({ imagePath: text, modelId: text, workspace: text, workflowId: text, parameters: { type: 'object' }, templateId: text, sourceId: text }, ['imagePath']) },
  { name: 'timmy_vision_events', description: 'Read locally archived vision observations and operator feedback.', inputSchema: schema({ limit: { type: 'number' } }) },
  { name: 'timmy_vision_feedback', description: 'Record the human operator’s supplied verdict on an observation; never invent an operator approval.', inputSchema: schema({ eventId: text, verdict: { type: 'string', enum: ['correct', 'incorrect', 'inconclusive'] }, note: text }, ['eventId', 'verdict']) },
  { name: 'timmy_vision_learning', description: 'List local uncertain or corrected observations for review. Does not upload or train.', inputSchema: schema({ limit: { type: 'number' }, threshold: { type: 'number' } }) },
  { name: 'timmy_vision_sync', description: 'Explicitly send one archived observation to the configured Roboflow Vision Events use case. Uploads image only if includeImage=true. Requires authorization to send this evidence.', inputSchema: schema({ eventId: text, includeImage: { type: 'boolean' } }, ['eventId']) },
  { name: 'timmy_vision_cloud_events', description: 'Query the configured Roboflow Vision Events use case.', inputSchema: schema({ limit: { type: 'number' }, cursor: text }) },
];
export async function callVisionTool(name: string, args: any = {}) {
  loadVisionEnvironment();
  switch (name) {
    case 'timmy_vision_catalog': return getVisionCatalog();
    case 'timmy_vision_status': return getVisionStatus();
    case 'timmy_vision_inspect': {
      const result = await runVisionInspection(args);
      return 'event' in result && result.event ? { ...result, event: publicVisionEvent(result.event) } : result;
    }
    case 'timmy_vision_events': {
      const result = listVisionEvents(args);
      return { ...result, events: result.events.map(publicVisionEvent) };
    }
    case 'timmy_vision_feedback': return recordVisionFeedback(args);
    case 'timmy_vision_learning': {
      const result = listLearningCandidates(args);
      return { ...result, events: result.events.map(publicVisionEvent) };
    }
    case 'timmy_vision_sync': return syncVisionEvent(args);
    case 'timmy_vision_cloud_events': return queryCloudVisionEvents(args);
    default: return { ok: false, state: 'invalid_request', note: 'Unknown vision tool.' };
  }
}
