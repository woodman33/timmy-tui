import { createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, readFileSync, constants } from 'node:fs';
import { validateSpatialModelContext } from './model-context.js';

/** Projection of an explicitly retained MCP response. It does not imply a fresh native read. */
export function buildNativeModelContext(path: string, kind: 'spline' | 'hana', objectId?: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); let bytes: Buffer;
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size < 1 || stat.size > 2 * 1024 * 1024) throw new Error('Native snapshot must be a bounded JSON file.'); bytes = readFileSync(fd); if (bytes.length !== stat.size) throw new Error('Native snapshot changed during read.'); } finally { closeSync(fd); }
  const hash = createHash('sha256').update(bytes).digest('hex'), envelope = JSON.parse(bytes.toString('utf8'));
  if (!envelope.response || envelope.response.isError || !Array.isArray(envelope.response.content)) throw new Error('Expected a retained successful MCP response.');
  if (envelope.tool !== (kind === 'spline' ? '3d_get_objects' : '2d_get_scene')) throw new Error('Snapshot tool does not match source kind.');
  const block = envelope.response.content.find((x: any) => x.type === 'text');
  const raw = JSON.parse(block?.text), all = kind === 'spline' ? raw : raw.scene?.objects;
  if (!Array.isArray(all) || all.length > 4096) throw new Error('Invalid native object list.');
  const chosen = objectId ? all.filter(o => o.id === objectId) : all.slice(0, 6);
  if (!chosen.length || chosen.length > 6) throw new Error('Object not present in retained snapshot.');
  const facts: any[] = [], entities: any[] = [];
  const add = (id: string, key: string, value: unknown, method = 'retained-MCP-object-property', epistemic = 'declared') => facts.push({ id: `${id}.${key}`, entityId: id, key, value, epistemic, source: { sha256: hash, artifact: 'retained-mcp-response', method } });
  const vector = (v: unknown, length: number) => { if (!Array.isArray(v) || v.length !== length || v.some(n => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('Native coordinates must be finite.'); return v; };
  for (const object of chosen) {
    if (typeof object.id !== 'string' || typeof object.name !== 'string') throw new Error('Object requires source identity.');
    const id = object.id;
    entities.push({ id, kind: kind === 'spline' ? 'mesh' : 'frame', label: object.name.slice(0, 160), sourceObjectId: id });
    add(id, 'size', vector(object.size, kind === 'spline' ? 3 : 2));
    if (kind === 'spline') {
      add(id, 'positionInParent', vector(object.position, 3)); add(id, 'rotationDegrees', vector(object.rotation, 3)); add(id, 'scale', vector(object.scale, 3));
      add(id, 'parentFrameId', typeof object.parentId === 'string' ? object.parentId : 'root');
      if (typeof object.mesh?.vertices === 'number') add(id, 'vertices', object.mesh.vertices);
      if (typeof object.mesh?.triangles === 'number') add(id, 'triangles', object.mesh.triangles);
    } else {
      add(id, 'center', vector(object.center, 2));
      let descendants = 0; const count = (items: any[], depth: number) => { if (depth > 64) throw new Error('Native scene nesting exceeds limit.'); for (const item of items) { if (++descendants > 10000) throw new Error('Native scene exceeds limit.'); if (Array.isArray(item.children)) count(item.children, depth + 1); } };
      count(object.children ?? [], 0); add(id, 'descendantCount', descendants, 'recursive-count-of-retained-MCP-tree', 'computed');
    }
    add(id, 'physicalMaterial', null, 'no-physical-material-evidence', 'unknown'); add(id, 'intrinsicDensityKgM3', null, 'no-density-evidence', 'unknown');
  }
  return validateSpatialModelContext({ schema: 'timmy.spatial-model-context/1', source: { kind, id: `${kind}-snapshot-${hash.slice(0, 16)}`, sha256: hash }, frame: { id: kind === 'spline' ? 'per-object-parent-frames' : 'hana-canvas', units: kind === 'spline' ? 'scene-unit' : 'px' }, entities, facts,
    limitations: ['Retained native MCP snapshot; no live revision or document lease checked during projection.', 'Native property values are source-reported; this packet does not verify mesh topology or physical dimensions.', kind === 'spline' ? 'Positions are in each named parent frame. No world transform was collected. Scene units have no verified physical scale.' : 'Canvas frame sizes are pixels; they are not 3D physical dimensions.', 'Render appearance does not establish physical material or density.', `Capture timestamp (source reported): ${String(envelope.capturedAtUtc ?? 'unknown').slice(0, 80)}`] });
}
