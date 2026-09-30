/** JSON input boundaries must reject ambiguity before reserialization erases it. */
export class StrictJsonError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message); this.name = 'StrictJsonError';
  }
}

/** Parse bounded JSON while retaining JSON.parse's grammar and value semantics.
 * The caller owns the source bytes; the return value is parsed data, not a raw transcript.
 */
export function parseStrictJson(source: string, options: { maxBytes?: number; maxDepth?: number } = {}): unknown {
  const maxBytes = options.maxBytes ?? 65_536, maxDepth = options.maxDepth ?? 64;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new Error('JSON limits must be positive safe integers.');
  }
  if (Buffer.byteLength(source, 'utf8') > maxBytes) {
    throw new StrictJsonError('json_exceeds_byte_limit', `JSON exceeds ${maxBytes} bytes.`);
  }
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new StrictJsonError('invalid_json', 'Input must be valid JSON.'); }

  // Native parsing validates syntax. This lexical walk preserves object scope and decoded
  // key spelling, which a reviver cannot recover after duplicate keys have been collapsed.
  const stack: { kind: 'object' | 'array'; keys: Set<string>; expectsKey: boolean }[] = [];
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (char === '{' || char === '[') {
      stack.push({ kind: char === '{' ? 'object' : 'array', keys: new Set(), expectsKey: char === '{' });
      if (stack.length > maxDepth) throw new StrictJsonError('json_exceeds_depth_limit', `JSON nesting exceeds ${maxDepth}.`);
      index++; continue;
    }
    if (char === '}' || char === ']') { stack.pop(); index++; continue; }
    if (char === ',') {
      const frame = stack.at(-1);
      if (frame?.kind === 'object') frame.expectsKey = true;
      index++; continue;
    }
    if (char === '"') {
      const start = index++;
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue; }
        if (source[index++] === '"') break;
      }
      const frame = stack.at(-1);
      if (frame?.kind === 'object' && frame.expectsKey) {
        const key = JSON.parse(source.slice(start, index)) as string;
        if (frame.keys.has(key)) throw new StrictJsonError('duplicate_json_key', 'Duplicate JSON object key.');
        frame.keys.add(key); frame.expectsKey = false;
      }
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      const start = index++;
      while (index < source.length && /[0-9.eE+-]/u.test(source[index])) index++;
      if (!Number.isFinite(Number(source.slice(start, index)))) {
        throw new StrictJsonError('nonfinite_json_number', 'JSON numbers must be finite.');
      }
      continue;
    }
    index++;
  }
  return value;
}
