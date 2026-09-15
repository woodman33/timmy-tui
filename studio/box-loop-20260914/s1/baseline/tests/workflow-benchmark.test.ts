import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkflowCases, workflowFinalSchema, workflowPublicTask, workflowMessages, collectWorkflowObservations, createWorkflowConnection, gradeWorkflow, workflowStopReason, prepareWorkflowStudy } from '../src/vision/spatial/workflow-benchmark.js';
import { oracleLabEpisode } from '../src/vision/spatial/lab-challenges.js';
import { independentlyVerifyLabSession } from '../src/vision/spatial/lab-independent-verifier.js';
import { runLabCli } from '../src/vision/spatial/lab-cli.js';
import { runWorkflowCli } from '../src/vision/spatial/workflow-cli.js';
import * as tournament from '../src/vision/spatial/lab-tournament.js';

const temporaryRoots: string[] = [];
function freshDirectory() { const parent = mkdtempSync(join(tmpdir(), 'timmy-workflow-benchmark-test-')); temporaryRoots.push(parent); return join(parent, 'new-study'); }
afterEach(() => { vi.restoreAllMocks(); for (const directory of temporaryRoots.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const item = (id = 'light-boundary') => buildWorkflowCases().find(c => c.id === id)!;
const episode = (finalJson: unknown, overrides: Record<string, unknown> = {}) => ({ finalJson, error: null, protocolErrors: [], requests: [{ phase: 'final', error: null }], rawFormatValid: true, formatValid: true, attemptedCalls: 0, finalRequests: 1, ...overrides });
const offline = () => vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Network prohibited in workflow integration tests.'); });

describe('public workflow projection and offline preparation', () => {
  it('requires citation structure without supplying expected facts or received evidence IDs', () => {
    for (const workflow of buildWorkflowCases()) {
      const schema = workflowFinalSchema(workflow) as any;
      const keys = workflow.task.publicTask.requiredFacts;
      expect(schema.properties.evidenceByFact.required).toEqual(keys.length ? keys : ['missingEvidence']);
      for (const value of Object.values(schema.properties.evidenceByFact.properties) as any[]) {
        expect(value).toMatchObject({ type: 'array', minItems: 1, items: { type: 'string' } });
        expect(value.items).not.toHaveProperty('enum');
      }
      const before = JSON.stringify(schema);
      workflow.task.privateExpected.facts = { sentinel: 'NEVER PRESENT THIS ANSWER' };
      expect(JSON.stringify(workflowFinalSchema(workflow))).toBe(before);
      expect(before).not.toContain('ev-'); expect(before).not.toContain('privateExpected');
    }
  });
  it('projects only public requests and never serializes evaluator geometry or answers into model context', () => {
    for (const workflow of buildWorkflowCases()) {
      const expectedPublic = workflowPublicTask(workflow), expectedMessages = workflowMessages(workflow);
      Object.defineProperty(workflow.task, 'privateExpected', { get: () => { throw new Error('PRIVATE ANSWERS READ'); }, enumerable: true });
      Object.defineProperty(workflow.task, 'scene', { get: () => { throw new Error('PRIVATE SCENE READ'); }, enumerable: true });
      expect(workflowPublicTask(workflow)).toEqual(expectedPublic); expect(workflowMessages(workflow)).toEqual(expectedMessages);
      const serialized = JSON.stringify(expectedMessages);
      expect(serialized).not.toContain('privateExpected'); expect(serialized).not.toContain('innerRadius'); expect(serialized).not.toContain('"scene":');
      expect(expectedPublic.requiredFacts).toEqual(workflow.task.publicTask.requiredFacts);
      expect(expectedPublic.sceneRef).toBe(workflow.task.publicTask.sceneRef);
      expect(expectedMessages).toHaveLength(2);
    }
  });
  it('defines two novice, two medium and two hard cases with passing independent reference checks', () => {
    const network = offline(), catalog = buildWorkflowCases();
    expect(catalog).toHaveLength(6); expect(new Set(catalog.map(c => c.id)).size).toBe(6);
    expect(catalog.map(c => c.tier)).toEqual(['novice', 'novice', 'medium', 'medium', 'hard', 'hard']);
    for (const workflow of catalog) {
      const reference = oracleLabEpisode(workflow.task);
      expect(reference.score.verifiedTaskSuccess, workflow.id).toBe(true);
      expect(independentlyVerifyLabSession(workflow.task, reference.session).valid, workflow.id).toBe(true);
    }
    expect(network).not.toHaveBeenCalled();
  });
  it('prepares all six offline controls without inference and refuses to overwrite the study', () => {
    const network = offline(), directory = freshDirectory(), prepared = prepareWorkflowStudy(directory);
    expect(prepared.passed).toBe(true); expect(prepared.oracleChecks).toHaveLength(6); expect(prepared.oracleChecks.every(c => c.passed)).toBe(true);
    expect(prepared.isolation.scope).toMatchObject({ modelCalls: 0, networkCalls: 0, nativeCalls: 0 });
    const publicData = readFileSync(join(directory, 'public-workflows.json'), 'utf8');
    expect(publicData).not.toContain('privateExpected'); expect(publicData).not.toContain('innerRadius');
    expect(() => prepareWorkflowStudy(directory)).toThrow(/fresh output/); expect(network).not.toHaveBeenCalled();
  });
  it('acquires identical observations even when evaluator answers are inaccessible', () => {
    const network = offline();
    for (const workflow of buildWorkflowCases().filter(c => !c.task.difficulty.edit_steps)) {
      const first = collectWorkflowObservations(workflow);
      Object.defineProperty(workflow.task, 'privateExpected', { get: () => { throw new Error('Acquisition accessed evaluator answers.'); }, enumerable: true });
      const second = collectWorkflowObservations(workflow);
      expect(second.observations, workflow.id).toEqual(first.observations); expect(second.events).toEqual(first.events);
      const context = JSON.parse(workflowMessages(workflow, second.observations)[1].content);
      expect(context.mode).toBe('reasoning-from-recorded-observations'); expect(context.observations).toEqual(second.observations);
    }
    expect(() => collectWorkflowObservations(item('medium-edit'))).toThrow(/edits require/); expect(network).not.toHaveBeenCalled();
  });
});

describe('connection and component attribution', () => {
  it('records actual simulated wire request and response contracts without claiming native software execution', () => {
    const workflow = item('medium-comparison'), bound = collectWorkflowObservations(workflow);
    expect(bound.events.length).toBeGreaterThan(1);
    for (const event of bound.events) {
      expect(event.connection).toBe('simulated-json'); expect(event.contract).toEqual({ valid: true, failures: [] });
      expect(event.wireRequest.tool).toBe(event.name); expect(event.wireResponse.id).toBe(event.wireRequest.id);
      expect(event.wireResponse.result).toEqual(event.output); expect(event.sourcePreserved).toBe(true);
    }
    const grade = gradeWorkflow(workflow, bound.session, episode(null), bound.events);
    expect(grade.components.transport).toMatchObject({ nativeSoftwareTested: false, contractFailures: 0, payloadsRecorded: bound.events.length });
  });
  it('separates the injected stale refusal from a model stale mistake and never writes the source', () => {
    const workflow = item('hard-recovery'), before = JSON.stringify(workflow.task.scene), bound = createWorkflowConnection(workflow);
    const args = { objectId: bound.session.scene.objects[0].id, operation: 'translate', vectorMm: [1, 0, 0], expectedRevision: bound.session.currentRevision };
    const injected = bound.dispatch('lab_propose', args);
    expect(injected).toMatchObject({ status: 'refused', code: 'stale_revision', sourceWritten: false }); expect(bound.session.edits).toHaveLength(0);
    expect(bound.events[0]).toMatchObject({ input: args, injectedFault: 'stale-revision', contract: { valid: true }, beforeRevision: args.expectedRevision, afterRevision: args.expectedRevision });
    expect(bound.events[0].deliveredArguments.expectedRevision).not.toBe(args.expectedRevision);
    const successful = bound.dispatch('lab_propose', args); expect(successful.status).toBe('proposed'); expect(bound.session.edits).toHaveLength(1);
    const staleByModel = bound.dispatch('lab_propose', args); expect(staleByModel.status).toBe('refused');
    expect(bound.events[2].injectedFault).toBeNull(); expect(bound.events[2].contract.valid).toBe(true);
    const grade = gradeWorkflow(workflow, bound.session, episode(null), bound.events);
    expect(grade.components.transport).toMatchObject({ injectedRefusals: 1, modelInvalidCalls: 1, contractFailures: 0 });
    expect(grade.components.toolExecution.sourcePreserved).toBe(true); expect(JSON.stringify(workflow.task.scene)).toBe(before); expect(JSON.stringify(bound.session.source)).toBe(before);
  });
  it('reports missing answers as unobserved rather than zero reasoning accuracy', () => {
    const workflow = item(), reference = oracleLabEpisode(workflow.task);
    const missing = gradeWorkflow(workflow, reference.session, episode(null), []);
    expect(missing.components.modelAnswer).toMatchObject({ observed: false, factAccuracy: null, evidencePrecision: null, evidenceRecall: null });
    expect(missing.components.workflow.finalResponseReceived).toBe(false); expect(workflowStopReason(missing)).toBe('shared_workflow_or_runtime_failure');
    const wrong = structuredClone(reference.answer); wrong.facts.pointState = wrong.facts.pointState === 'empty' ? 'solid' : 'empty';
    const incorrect = gradeWorkflow(workflow, reference.session, episode(wrong), []);
    expect(incorrect.components.modelAnswer.observed).toBe(true); expect(incorrect.components.modelAnswer.factAccuracy).toBeLessThan(1);
    expect(incorrect.components.workflow.finalResponseReceived).toBe(true); expect(workflowStopReason(incorrect)).toBe('evidence_or_reasoning_failure_requires_isolated_diagnosis');
  });
  it('stops on a protocol error or failed request even when the final facts and evidence are correct', () => {
    const workflow = item(), reference = oracleLabEpisode(workflow.task);
    const clean = gradeWorkflow(workflow, reference.session, episode(reference.answer), []);
    expect(clean.verifiedTaskSuccess).toBe(true); expect(workflowStopReason(clean)).toBeNull();
    for (const extra of [
      { protocolErrors: ['Malformed native tool arguments'] },
      { requests: [{ phase: 'tools', error: 'timed out' }, { phase: 'final', error: null }] },
    ]) {
      const grade = gradeWorkflow(workflow, reference.session, episode(reference.answer, extra), []);
      expect(grade.score.verifiedTaskSuccess).toBe(true); expect(grade.components.modelAnswer.factAccuracy).toBe(1);
      expect(grade.components.workflow.protocolClean).toBe(false); expect(workflowStopReason(grade)).toBe('shared_workflow_or_runtime_failure');
    }
  });
  it('keeps connection contract failure distinct from correct model answers', () => {
    const workflow = item(), reference = oracleLabEpisode(workflow.task);
    const grade = gradeWorkflow(workflow, reference.session, episode(reference.answer), [{ output: { status: 'ok' }, contract: { valid: false, failures: ['revision_binding'] } }]);
    expect(grade.components.transport.contractFailures).toBe(1); expect(grade.score.verifiedTaskSuccess).toBe(true); expect(workflowStopReason(grade)).toBe('connection_contract_failure');
  });
});

describe('legacy sweep admission', () => {
  it('rejects unknown or missing explicit workflow cases before creating output or using the network', async () => {
    const network = offline(), directory = freshDirectory();
    for (const flags of [[], ['--case', 'does-not-exist']]) {
      const messages: string[] = [];
      expect(await runWorkflowCli(['case', '--out', directory, ...flags], value => messages.push(value))).toBe(1);
      expect(JSON.parse(messages[0])).toMatchObject({ ok: false }); expect(messages[0]).toMatch(/case/i);
      expect(existsSync(directory)).toBe(false);
    }
    expect(network).not.toHaveBeenCalled();
  });
  it('rejects missing explicit models or replay intent before creating files or touching the network', async () => {
    const network = offline(), directory = freshDirectory(), run = vi.spyOn(tournament, 'runLabTournament').mockResolvedValue({ testOnly: true } as any);
    for (const flags of [[], ['--models', '["granite4.2:latest"]'], ['--legacy-replay', 'yes'], ['--models', '["granite4.2:latest"]', '--legacy-replay', 'no']]) {
      const messages: string[] = [];
      expect(await runLabCli(['tournament', '--out', directory, ...flags], value => messages.push(value))).toBe(1);
      expect(messages.join('\n')).toContain('explicit --models'); expect(existsSync(directory)).toBe(false);
    }
    expect(run).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it('admits only a valid explicit replay list and forwards exactly those models', async () => {
    const network = offline(), directory = freshDirectory(), run = vi.spyOn(tournament, 'runLabTournament').mockResolvedValue({ testOnly: true } as any);
    for (const models of ['[]', '["a","a"]', '[42]', 'not-json']) {
      expect(await runLabCli(['tournament', '--out', directory, '--models', models, '--legacy-replay', 'yes'], () => {})).toBe(1);
    }
    expect(run).not.toHaveBeenCalled();
    expect(await runLabCli(['tournament', '--out', directory, '--models', '["granite4.2:latest"]', '--legacy-replay', 'yes', '--concurrency', '1'], () => {})).toBe(0);
    expect(run).toHaveBeenCalledExactlyOnceWith(directory, expect.objectContaining({ models: ['granite4.2:latest'], concurrency: 1 }));
    expect(network).not.toHaveBeenCalled(); expect(existsSync(directory)).toBe(false);
  });
});
