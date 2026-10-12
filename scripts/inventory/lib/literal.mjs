// Timmy's inventory: reads a registry written as a TypeScript object or array literal, without running the module.
// Strings, numbers, booleans, null, objects and arrays become values; anything else (a call, a variable, a template with
// ${…}) is kept as { expr: '<its source text>' }. A spread or a method is skipped. Comments are skipped.

function tokenize(src, start) {
  const toks = [];
  let i = start;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1; let s = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') { const e = src[j + 1]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e; j += 2; continue; }
        s += src[j]; j++;
      }
      toks.push({ t: 'str', v: s, s: i, e: j + 1 }); i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1; let s = ''; let interp = false; let depth = 0;
      while (j < n) {
        if (src[j] === '\\') { s += src[j + 1]; j += 2; continue; }
        if (depth === 0 && src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') { interp = true; depth++; j += 2; continue; }
        if (depth > 0 && src[j] === '}') { depth--; j++; continue; }
        if (depth === 0) s += src[j];
        j++;
      }
      toks.push({ t: interp ? 'tpl' : 'str', v: s, s: i, e: j + 1 }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1; while (j < n && /[0-9._xXa-fA-FeE+-]/.test(src[j])) j++;
      toks.push({ t: 'num', v: Number(src.slice(i, j).replace(/_/g, '')), s: i, e: j }); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1; while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j), s: i, e: j }); i = j; continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') { toks.push({ t: 'p', v: '...', s: i, e: i + 3 }); i += 3; continue; }
    toks.push({ t: 'p', v: c, s: i, e: i + 1 }); i++;
  }
  return toks;
}

const OPEN = { '{': '}', '[': ']', '(': ')' };

/**
 * Reads the literal that begins at `start` (an index of "{" or "["). Returns { value, end } or throws with the reason.
 * Tokens are produced lazily over the rest of the file; parsing stops at the literal's closing bracket.
 */
export function readLiteral(src, start) {
  const toks = tokenize(src, start);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const fail = (why) => { throw new Error(`${why} at character ${toks[p]?.s ?? src.length}`); };

  // Skips an expression up to a "," or a closing bracket at depth 0, and returns its source text.
  const skipExpr = () => {
    const first = peek();
    if (!first) fail('the literal ends early');
    let depth = 0;
    let last = first;
    while (p < toks.length) {
      const t = peek();
      if (t.t === 'p' && depth === 0 && (t.v === ',' || t.v === '}' || t.v === ']' || t.v === ')')) break;
      if (t.t === 'p' && OPEN[t.v]) depth++;
      if (t.t === 'p' && (t.v === '}' || t.v === ']' || t.v === ')')) depth--;
      last = next();
    }
    return src.slice(first.s, last.e).trim();
  };

  const value = () => {
    const t = peek();
    if (!t) fail('the literal ends early');
    let v;
    if (t.t === 'p' && t.v === '{') v = object();
    else if (t.t === 'p' && t.v === '[') v = array();
    else if (t.t === 'str') { next(); v = t.v; }
    else if (t.t === 'num') { next(); v = t.v; }
    else if (t.t === 'id' && (t.v === 'true' || t.v === 'false')) { next(); v = t.v === 'true'; }
    else if (t.t === 'id' && t.v === 'null') { next(); v = null; }
    else return { expr: skipExpr() };
    // `as const`, `satisfies T`, a call on a literal: whatever follows the value up to the next "," is not part of it.
    const after = peek();
    if (after && !(after.t === 'p' && (after.v === ',' || after.v === '}' || after.v === ']' || after.v === ')'))) skipExpr();
    return v;
  };

  const object = () => {
    next(); // {
    const out = {};
    for (;;) {
      const t = peek();
      if (!t) fail('an object is not closed');
      if (t.t === 'p' && t.v === '}') { next(); return out; }
      if (t.t === 'p' && t.v === ',') { next(); continue; }
      if (t.t === 'p' && t.v === '...') { next(); skipExpr(); continue; }
      let key;
      if (t.t === 'id' || t.t === 'str' || t.t === 'num') { next(); key = String(t.v); }
      else if (t.t === 'p' && t.v === '[') { skipExpr(); continue; }
      else fail(`an unexpected "${t.v}" in an object`);
      const sep = peek();
      if (sep && sep.t === 'p' && sep.v === ':') { next(); out[key] = value(); continue; }
      if (sep && sep.t === 'p' && (sep.v === ',' || sep.v === '}')) { out[key] = { expr: key }; continue; }
      skipExpr(); // a method or a getter
    }
  };

  const array = () => {
    next(); // [
    const out = [];
    for (;;) {
      const t = peek();
      if (!t) fail('an array is not closed');
      if (t.t === 'p' && t.v === ']') { next(); return out; }
      if (t.t === 'p' && t.v === ',') { next(); continue; }
      if (t.t === 'p' && t.v === '...') { next(); skipExpr(); continue; }
      out.push(value());
    }
  };

  const first = peek();
  if (!first || first.t !== 'p' || (first.v !== '{' && first.v !== '[')) fail('no object or array literal starts here');
  const v = value();
  return { value: v, end: toks[p - 1]?.e ?? src.length };
}

/**
 * The literal assigned to `export const <name>` (or `const <name>`) in a source file: { ok: true, value } or
 * { ok: false, why }.
 */
export function constLiteral(src, name) {
  const re = new RegExp(`(?:export\\s+)?const\\s+${name.replace(/[$]/g, '\\$')}\\b[^=]*=\\s*`, 'm');
  const m = re.exec(src);
  if (!m) return { ok: false, why: `no const ${name} in the file` };
  let i = m.index + m[0].length;
  while (i < src.length && src[i] !== '{' && src[i] !== '[') {
    if (!/\s|[A-Za-z(<>.]/.test(src[i])) break;
    i++;
  }
  if (src[i] !== '{' && src[i] !== '[') return { ok: false, why: `const ${name} is not assigned an object or array literal` };
  try { return { ok: true, value: readLiteral(src, i).value }; } catch (e) { return { ok: false, why: `const ${name} could not be read: ${e instanceof Error ? e.message : String(e)}` }; }
}

/** The first array or object literal returned by `function <name>`: { ok: true, value } or { ok: false, why }. */
export function returnedLiteral(src, fnName) {
  const at = src.search(new RegExp(`function\\s+${fnName}\\b`));
  if (at < 0) return { ok: false, why: `no function ${fnName} in the file` };
  const r = /return\s*([[{])/g;
  r.lastIndex = at;
  const m = r.exec(src);
  if (!m) return { ok: false, why: `function ${fnName} returns no literal` };
  try { return { ok: true, value: readLiteral(src, m.index + m[0].length - 1).value }; } catch (e) { return { ok: false, why: `function ${fnName}'s literal could not be read: ${e instanceof Error ? e.message : String(e)}` }; }
}
