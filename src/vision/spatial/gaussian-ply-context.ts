import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { validateSpatialModelContext, type SpatialContextFact, type SpatialContextValue } from './model-context.js';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_VERTICES = 100_000;
const SAMPLE_COUNT = 4;
const CORE = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

export class GaussianPlyError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'GaussianPlyError'; }
}
function refuse(code: string, message: string): never { throw new GaussianPlyError(code, message); }

/** Read one bounded file snapshot. No native fitting, model calls, or receipt writes. */
export function buildGaussianPlyContext(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > MAX_BYTES) refuse('gaussian_ply_size', 'Gaussian PLY must be a regular file of at most 8 MiB.');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) refuse('gaussian_ply_changed', 'Gaussian PLY changed during inspection.');
    bytes = buffer.subarray(0, length);
  } finally { closeSync(fd); }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const text = bytes.toString('latin1');
  const headerEnd = /(?:^|\n)end_header\r?\n/u.exec(text);
  if (!headerEnd || headerEnd.index + headerEnd[0].length > 64 * 1024) refuse('gaussian_ply_header', 'Missing or oversized PLY header.');
  const bodyStart = headerEnd.index + headerEnd[0].length;
  const header = text.slice(0, bodyStart).split(/\r?\n/u);
  if (header[0] !== 'ply' || header[1] !== 'format ascii 1.0') refuse('gaussian_ply_format', 'Only ASCII PLY 1.0 is supported; binary PLY requires a separate decoder.');
  if (/[^\x09\x0a\x0d\x20-\x7e]/u.test(text)) refuse('gaussian_ply_encoding', 'ASCII PLY contains unsupported bytes.');
  let declaredCount: number | undefined;
  const properties: { name: string; type: string }[] = [];
  for (const line of header.slice(2, -1)) {
    if (line === 'end_header' || /^comment(?: |$)/u.test(line)) continue;
    const element = /^element vertex (0|[1-9]\d*)$/u.exec(line);
    if (element) {
      if (declaredCount !== undefined || properties.length) refuse('gaussian_ply_schema', 'Exactly one vertex element is supported.');
      declaredCount = Number(element[1]);
      if (!Number.isSafeInteger(declaredCount) || declaredCount < 1 || declaredCount > MAX_VERTICES) refuse('gaussian_ply_count', 'Gaussian PLY requires 1 to 100000 vertices.');
      continue;
    }
    const property = /^property (float|double|float32|float64) ([a-z][a-z0-9_]*)$/u.exec(line);
    if (!property || declaredCount === undefined || properties.length >= 64 || properties.some(p => p.name === property[2])) refuse('gaussian_ply_schema', 'Unsupported or duplicate PLY element/property. Only Gaussian vertex scalars are supported.');
    properties.push({ name: property[2], type: property[1] });
  }
  if (declaredCount === undefined || CORE.some(name => !properties.some(p => p.name === name))) refuse('gaussian_ply_schema', 'Required Gaussian vertex properties are missing; a generic point cloud or mesh is not a Gaussian PLY.');
  const names = properties.map(p => p.name);
  const rest = names.filter(name => /^f_rest_\d+$/u.test(name));
  const normalCount = names.filter(name => ['nx', 'ny', 'nz'].includes(name)).length;
  if (![0, 3].includes(normalCount) || ![0, 9, 24, 45].includes(rest.length) || rest.some((_, i) => !names.includes(`f_rest_${i}`)) || names.some(name => !CORE.includes(name) && !['nx', 'ny', 'nz'].includes(name) && !rest.includes(name))) refuse('gaussian_ply_schema', 'Unsupported Gaussian property layout.');
  const coreIndices = CORE.map(name => names.indexOf(name));
  const sampleIndices = new Set(Array.from({ length: Math.min(SAMPLE_COUNT, declaredCount) }, (_, i) => Math.floor(i * (declaredCount - 1) / Math.max(1, Math.min(SAMPLE_COUNT, declaredCount) - 1))));
  const samples: { rowIndex: number; values: number[] }[] = [];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let rowCount = 0;
  // Match one row at a time so a malformed many-line file does not allocate a giant line array.
  const rows = /[^\r\n]+/gu;
  rows.lastIndex = bodyStart;
  let match: RegExpExecArray | null;
  while ((match = rows.exec(text))) {
    const row = match[0].trim();
    if (!row) continue;
    if (rowCount >= declaredCount) refuse('gaussian_ply_count_mismatch', 'PLY contains more rows than declared.');
    const tokens = row.split(/\s+/u);
    if (tokens.length !== properties.length) refuse('gaussian_ply_row', 'PLY vertex row does not match its scalar schema.');
    const values = tokens.map((token, i) => {
      const value = Number(token);
      if (!NUMBER.test(token) || !Number.isFinite(value) || (['float', 'float32'].includes(properties[i].type) && Math.abs(value) > 3.4028234663852886e38)) refuse('gaussian_ply_number', 'PLY scalar must be a finite decimal in its declared range.');
      return value;
    });
    for (let axis = 0; axis < 3; axis++) {
      const value = values[coreIndices[axis]];
      min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
    }
    if (sampleIndices.has(rowCount)) samples.push({ rowIndex: rowCount, values: coreIndices.map(index => values[index]) });
    rowCount++;
  }
  if (rowCount !== declaredCount) refuse('gaussian_ply_count_mismatch', 'PLY contains fewer rows than declared.');
  const facts: SpatialContextFact[] = [];
  const add = (key: string, value: SpatialContextValue, epistemic: SpatialContextFact['epistemic'], method: string) => facts.push({ id: `splats.${key}`, entityId: 'splats', key, value, epistemic, source: { sha256, artifact: 'gaussian-ply', method } });
  add('vertexCount', rowCount, 'computed', 'validated-full-file-row-count');
  add('centerBounds', { min, max }, 'computed', 'coordinate-extrema-over-every-vertex-not-gaussian-support');
  add('sampleFields', CORE, 'declared', 'validated-raw-ply-property-names');
  add('rawSamples', samples, 'declared', 'at-most-four-evenly-spaced-zero-based-rows-no-decoding');
  add('omittedAppearancePropertiesPerRow', rest.length + normalCount, 'computed', 'validated-schema-count-not-forwarded-in-samples');
  for (const key of ['physicalUnits', 'referenceFrame', 'handedness', 'parameterEncoding', 'solidFill', 'occupancyProbability', 'intrinsicDensityKgM3', 'physicalMaterial', 'interiorGeometry']) add(key, null, 'unknown', 'not-established-by-raw-ply-inspection');
  return validateSpatialModelContext({ schema: 'timmy.spatial-model-context/1', source: { kind: 'gaussian-splats', id: `gaussian-ply-${sha256.slice(0, 16)}`, sha256 }, frame: { id: 'unregistered-ply-coordinates', units: 'scene-unit' }, entities: [{ id: 'splats', kind: 'gaussian-splats', label: 'Inspected Gaussian parameter rows' }], facts, limitations: [
    'Read-only ASCII PLY inspection; no reconstruction, renderer, native application, model, or receipt writer ran.',
    'The count and center AABB scan every row. Raw attribute samples cover at most four rows and cannot describe every Gaussian.',
    'Center bounds are not Gaussian support bounds, mesh bounds, a closed surface, or an occupied volume.',
    'scene-unit means raw file coordinates only. Physical scale, world frame, handedness, and orientation remain unknown; header comments are not interpreted.',
    'Opacity, scale, rotation and appearance values are raw parameters. Their logit/log/quaternion/SH encoding is not authenticated or decoded.',
    'Gaussian opacity is not solid fill, occupancy probability, humidity, or mass density. Hidden interiors and space between centers remain unknown.',
    'Property layout identifies an accepted parameter schema, not the producer, reconstruction quality, source images, or physical truth.',
    'Original PLY bytes remain the source; optional higher-order appearance and normal fields are validated but omitted from the bounded samples.',
    'Fact IDs are source-bound inspection identifiers, not successful model cite calls. Model review and context.pack export are not enabled for this source kind.',
  ] });
}
