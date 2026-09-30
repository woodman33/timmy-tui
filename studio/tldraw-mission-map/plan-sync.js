// Plan notes are a projection of dispatch state. Operator drawings are never removed.
const OWNER = 'timmy.dispatch';
const COLORS = { ready: 'grey', armed: 'yellow', running: 'violet', judging: 'blue',
  passed: 'green', failed: 'red', needs_approval: 'yellow', archived: 'grey' };

export function applyPlanSync(editor, plans, { createShapeId, toRichText }) {
  if (!Array.isArray(plans)) throw new Error('Plan response must be an array.');
  const ids = new Set();
  for (const plan of plans) {
    if (!plan || typeof plan.id !== 'string' || !plan.id.trim() || ids.has(plan.id)) {
      throw new Error('Plan response has an invalid or repeated ID.');
    }
    ids.add(plan.id);
    for (const field of ['lifecycle', 'harness', 'plan_hash']) {
      if (plan[field] !== undefined && typeof plan[field] !== 'string') {
        throw new Error('Plan response has an invalid field.');
      }
    }
  }
  const existing = new Map();
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'note' || shape.meta?.owner !== OWNER || !shape.meta.dispatchId) continue;
    if (existing.has(shape.meta.dispatchId)) throw new Error('More than one note owns this plan.');
    existing.set(shape.meta.dispatchId, shape);
  }
  for (const [index, plan] of plans.entries()) {
    const richText = toRichText(`${plan.id}\n${plan.lifecycle || 'unknown'}\n${plan.harness || 'unassigned'}\nhash ${(plan.plan_hash || '').slice(0, 12) || 'unknown'}`);
    const color = Object.hasOwn(COLORS, plan.lifecycle) ? COLORS[plan.lifecycle] : 'grey';
    const shape = existing.get(plan.id);
    if (!shape) {
      editor.createShape({ id: createShapeId(), type: 'note',
        x: 80 + (index % 3) * 320, y: 80 + Math.floor(index / 3) * 260,
        props: { richText, color, size: 'm' },
        meta: { owner: OWNER, dispatchId: plan.id, lastSyncedRichText: richText, lastSyncedColor: color } });
      continue;
    }
    // A missing baseline is not permission to overwrite a note. Preserve edits,
    // formatting, position, selection, and unrelated metadata.
    if (!shape.meta.lastSyncedRichText ||
      JSON.stringify(shape.props.richText) !== JSON.stringify(shape.meta.lastSyncedRichText)) continue;
    const props = { richText };
    if (shape.props.color === shape.meta.lastSyncedColor) props.color = color;
    if (JSON.stringify(shape.props.richText) === JSON.stringify(richText) &&
      (props.color === undefined || props.color === shape.props.color)) continue;
    editor.updateShape({ id: shape.id, type: 'note', props,
      meta: { ...shape.meta, lastSyncedRichText: richText,
        lastSyncedColor: props.color ?? shape.meta.lastSyncedColor } });
  }
  return plans.length;
}

export function createPlanSync(editor, dependencies) {
  let pending = false;
  return async function syncPlans() {
    if (pending) return { state: 'pending' };
    pending = true;
    const pageId = editor.getCurrentPageId();
    try {
      const response = await (dependencies.fetch ?? globalThis.fetch)('/dispatch', {
        signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Plan request failed.');
      const plans = await response.json();
      if (editor.getCurrentPageId() !== pageId) return { state: 'page_changed' };
      let count = 0;
      editor.run(() => { count = applyPlanSync(editor, plans, dependencies); }, { history: 'ignore' });
      return { state: 'synced', count };
    } catch {
      return { state: 'unavailable' };
    } finally {
      pending = false;
    }
  };
}
