import { describe, expect, it } from 'vitest';
// Browser-safe template logic deliberately has no tldraw or DOM dependency.
// @ts-expect-error Plain JavaScript is shared directly with the browser.
import { VISION_TEMPLATES, buildTemplateGraph, buildRunRequest, validateRunConfiguration, planSyncChanges } from '../studio/tldraw-mission-map/vision-templates.js';

describe('vision templates and run configuration', () => {
  it('creates independent connected blueprints without executable model defaults', () => {
    expect(VISION_TEMPLATES).toHaveLength(6);
    const ids = new Set<string>();
    for (const template of VISION_TEMPLATES) {
      const graph = buildTemplateGraph(template.id, template.id, { x: 100, y: 200 });
      expect(graph.nodes).toHaveLength(6);
      expect(graph.edges).toHaveLength(5);
      for (const node of graph.nodes) {
        expect(ids.has(node.id)).toBe(false);
        ids.add(node.id);
        expect(node.props.state).toBe('Blueprint');
        expect(node.meta.templateId).toBe(template.id);
      }
      graph.edges.forEach((edge: { from: string; to: string }) => {
        expect(graph.nodes.some((node: { id: string }) => node.id === edge.from)).toBe(true);
        expect(graph.nodes.some((node: { id: string }) => node.id === edge.to)).toBe(true);
      });
      expect(graph.nodes.some((node: { props: { role: string } }) => node.props.role === 'review')).toBe(true);
    }
    expect(() => buildTemplateGraph('unknown', 'instance')).toThrow('Unknown vision template');
  });

  it('requires an explicit target and keeps model and workflow requests distinct', () => {
    expect(validateRunConfiguration({ mode: 'model' })).toContain('model ID');
    expect(validateRunConfiguration({ mode: 'model', modelId: 'my-model/3', parametersText: 'invalid hidden workflow configuration' })).toBeNull();
    expect(validateRunConfiguration({ mode: 'workflow', workspace: 'team' })).toContain('Workflow ID');
    expect(validateRunConfiguration({ mode: 'workflow', workspace: 'team', workflowId: 'inspect', parametersText: '[]' })).toContain('JSON object');
    const image = { imageBase64: 'aW1hZ2U=', filename: 'sample.jpg' };
    const workflow = buildRunRequest({ mode: 'workflow', workspace: ' team ', workflowId: ' inspect ', imageInput: 'frame', parametersText: '{"threshold":0.7}' }, image, 'packing-seal');
    expect(workflow).toMatchObject({ imageBase64: image.imageBase64, filename: image.filename, workspace: 'team', workflowId: 'inspect', imageInput: 'frame', parameters: { threshold: 0.7 }, templateId: 'packing-seal' });
    expect(workflow.modelId).toBeUndefined();
    expect(workflow.specification).toBeUndefined();
    const model = buildRunRequest({ mode: 'model', modelId: 'my-model/3', workspace: 'old', workflowId: 'old', sourceId: 'box-1' }, image, 'card-catalog');
    expect(model).toMatchObject({ modelId: 'my-model/3', sourceId: 'box-1' });
    expect(model.workspace).toBeUndefined();
    expect(model.workflowId).toBeUndefined();
    expect(model.apiKey).toBeUndefined();
    expect(() => buildRunRequest({ mode: 'model', modelId: 'my-model/3' }, undefined, 'card-catalog')).toThrow('Choose an image');
  });

  it('does not let plan sync overwrite edited notes or claim unrelated shapes', () => {
    const shapes = [
      { id: 'shape:owned', props: { text: 'operator edits' }, meta: { dispatchId: 'p1', lastSyncedText: 'old synced text' } },
      { id: 'shape:synced', props: { text: 'old synced text' }, meta: { dispatchId: 'p2', lastSyncedText: 'old synced text' } },
      { id: 'shape:unrelated', props: { text: 'keep me' }, meta: { templateId: 'card-catalog' } },
      { id: 'shape:rich', props: { richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'operator rich edit' }] }] } }, meta: { dispatchId: 'p4', lastSyncedRichText: { type: 'doc', content: [] } } },
    ];
    const plans = [{ id: 'p1', lifecycle: 'running' }, { id: 'p2', lifecycle: 'passed' }, { id: 'p3', lifecycle: 'ready' }, { id: 'p4', lifecycle: 'running' }];
    const changes = planSyncChanges(plans, shapes);
    expect(changes).toHaveLength(4);
    expect(changes[3].updateText).toBe(false);
    expect(changes[0].updateText).toBe(false);
    expect(changes[1].updateText).toBe(true);
    expect(changes[2].shape).toBeUndefined();
    expect(JSON.stringify(shapes)).toContain('operator edits');
    expect(changes.some((change: { shape?: { id: string } }) => change.shape?.id === 'shape:unrelated')).toBe(false);
  });
});
