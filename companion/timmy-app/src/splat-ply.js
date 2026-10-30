// The spatial tools order (2026-10-28): a Gaussian-splat PLY read for the Workspace's splat viewer. Pure functions (no DOM).
//
// A splat's values are read from the file itself (exact float32), never from the renderer: Spark packs centers at reduced
// precision for drawing (0.4 draws as 0.39990234375), so its readback is display, not data. Spark 2.3 reads binary PLY only;
// an ASCII PLY (KIRI's raw export, a synthetic fixture) is re-encoded for display as binary_little_endian float32. The
// original bytes are never changed or saved back.

const NEED = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const SIZE = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };

/** The PLY's header: its format, its vertex element's properties (in order), whether it is a Gaussian splat, the data offset. */
export function plyHeader(bytes) {
  const u8 = new Uint8Array(bytes);
  const text = new TextDecoder('latin1').decode(u8.subarray(0, Math.min(u8.length, 65536)));
  const end = text.indexOf('end_header');
  if (!text.startsWith('ply') || end < 0) return { ok: false, why: 'not a PLY file' };
  const nl = text.indexOf('\n', end);
  const lines = text.slice(0, end).split(/\r?\n/);
  const format = (/^format (\S+)/m.exec(text) || [])[1] || null;
  let count = 0; let inVertex = false; let otherCounts = 0; let list = false; const props = [];
  const comments = [];
  for (const l of lines) {
    const p = l.trim().split(/\s+/);
    if (p[0] === 'comment') comments.push(l.slice(8));
    else if (p[0] === 'element') { inVertex = p[1] === 'vertex'; if (inVertex) count = Number(p[2]); else otherCounts += Number(p[2]) || 0; }
    else if (p[0] === 'property' && inVertex) { if (p[1] === 'list') list = true; props.push({ type: p[1], name: p[p.length - 1] }); }
  }
  const missing = NEED.filter((n) => !props.some((p) => p.name === n));
  const fixture = comments.some((c) => /SYNTHETIC FIXTURE/.test(c));
  const base = { format, count, props, comments, fixture, offset: nl + 1 };
  if (missing.length) return { ...base, ok: false, gaussian: false, why: `a PLY that is not a Gaussian splat (no ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''})` };
  if (list || otherCounts) return { ...base, ok: false, gaussian: true, why: 'a PLY with faces or lists: not read as a splat here' };
  if (!count) return { ...base, ok: false, gaussian: true, why: 'no vertices' };
  return { ...base, ok: true, gaussian: true };
}

/** Every vertex's values as float64 rows (exactly the file's numbers), columns in the header's order; at most `limit` rows. */
export function plyRows(bytes, header, limit = 2_000_000) {
  const u8 = new Uint8Array(bytes);
  const n = Math.min(header.count, limit);
  const cols = header.props.length;
  const out = new Float64Array(n * cols);
  if (header.format === 'ascii') {
    const body = new TextDecoder('latin1').decode(u8.subarray(header.offset)).trim().split(/\s+/);
    if (body.length < n * cols) throw new Error('the PLY ends before its vertices do');
    for (let i = 0; i < n * cols; i++) out[i] = Number(body[i]);
    return out;
  }
  const little = header.format === 'binary_little_endian';
  if (!little && header.format !== 'binary_big_endian') throw new Error(`unknown PLY format ${header.format}`);
  const view = new DataView(u8.buffer, u8.byteOffset + header.offset);
  const stride = header.props.reduce((a, p) => a + (SIZE[p.type] || 0), 0);
  if (header.props.some((p) => !SIZE[p.type])) throw new Error('a property type this reader does not know');
  if (view.byteLength < n * stride) throw new Error('the PLY ends before its vertices do');
  for (let i = 0; i < n; i++) {
    let at = i * stride;
    for (let c = 0; c < cols; c++) {
      const t = header.props[c].type; let v;
      if (t === 'float' || t === 'float32') v = view.getFloat32(at, little);
      else if (t === 'double' || t === 'float64') v = view.getFloat64(at, little);
      else if (t === 'uchar' || t === 'uint8') v = view.getUint8(at);
      else if (t === 'char' || t === 'int8') v = view.getInt8(at);
      else if (t === 'short' || t === 'int16') v = view.getInt16(at, little);
      else if (t === 'ushort' || t === 'uint16') v = view.getUint16(at, little);
      else if (t === 'int' || t === 'int32') v = view.getInt32(at, little);
      else v = view.getUint32(at, little);
      out[i * cols + c] = v; at += SIZE[t];
    }
  }
  return out;
}

/** The splat's facts from its own values: count, centre bounds (exact), opacity range after the sigmoid, a fixture comment. */
export function splatFacts(bytes, header) {
  const rows = plyRows(bytes, header);
  const cols = header.props.length; const n = rows.length / cols;
  const at = (name) => header.props.findIndex((p) => p.name === name);
  const [ix, iy, iz, io] = ['x', 'y', 'z', 'opacity'].map(at);
  const lo = [Infinity, Infinity, Infinity]; const hi = [-Infinity, -Infinity, -Infinity]; let omin = Infinity; let omax = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = [rows[i * cols + ix], rows[i * cols + iy], rows[i * cols + iz]];
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    const o = 1 / (1 + Math.exp(-rows[i * cols + io])); omin = Math.min(omin, o); omax = Math.max(omax, o);
  }
  return { count: header.count, read: n, bounds: [lo, hi], opacity: [omin, omax], fixture: header.fixture, format: header.format, rows, cols, index: { x: ix, y: iy, z: iz } };
}

/** The columns a renderer is given: the 3DGS Gaussian properties only (centre, SH coefficients, opacity, scale, rotation). */
const DRAWN = /^(x|y|z|f_dc_\d+|f_rest_\d+|opacity|scale_\d+|rot_\d+)$/;

/**
 * The splat re-encoded for display only: binary_little_endian float32 holding just its Gaussian columns. Extra vertex columns
 * are left out of the picture (never out of the file): KIRI 5.1's Blender export adds uchar red/green/blue/alpha and float
 * Col_r..Col_a beside the Gaussian values, and Spark 2.3 takes red/green/blue/alpha over f_dc/opacity, so those 0–255 bytes
 * drew 4 kept Gaussians as 5 lit pixels where the same Gaussians alone draw ~14,500 (the 2026-10-28 Mac run's edited splat).
 * A file that already is exactly the Gaussian columns in binary float is passed through unchanged.
 */
export function forRenderer(bytes, header) {
  const keep = header.props.map((p, i) => (DRAWN.test(p.name) ? i : -1)).filter((i) => i >= 0);
  const clean = keep.length === header.props.length && header.props.every((p) => p.type === 'float' || p.type === 'float32');
  if (header.format === 'binary_little_endian' && clean) return new Uint8Array(bytes);
  const rows = plyRows(bytes, header);
  const n = rows.length / header.props.length;
  const f32 = new Float32Array(n * keep.length);
  for (let i = 0; i < n; i++) for (let k = 0; k < keep.length; k++) f32[i * keep.length + k] = rows[i * header.props.length + keep[k]];
  const head = ['ply', 'format binary_little_endian 1.0', `element vertex ${n}`, ...keep.map((i) => `property float ${header.props[i].name}`), 'end_header', ''].join('\n');
  const hb = new TextEncoder().encode(head);
  const out = new Uint8Array(hb.length + f32.byteLength);
  out.set(hb, 0); out.set(new Uint8Array(f32.buffer), hb.length);
  return out;
}
