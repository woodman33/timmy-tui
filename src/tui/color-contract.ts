// TUI REDESIGN (spec §08) — the color contract is a GATE, not a style guide.
// statusColor's doctrine (phosphor = the chain agrees · orange = a human is
// here/needed · red = refused ONLY · dim = absent/off/unverified · white = the
// thing you're looking at) predates the law (lanes/visual/tokens.json, ORDER
// ui-v3-t9r2). Under the law amber means PREDICT and nothing else; 'warn' here
// is a transitional token that C1b re-points by evidence state. The law gate
// itself is the block at the end of this file.
export type Token = 'seal' | 'warn' | 'danger' | 'dim' | 'white';

export function statusColor(status: string): Token {
  const s = status.toLowerCase();
  if (['ok', 'sealed', 'verified', 'connected', 'live', 'passed', 'promoted'].includes(s)) return 'seal';
  if (['running', 'needs-you', 'next', 'insert', 'chat', 'filter', 'queued-human'].includes(s)) return 'warn';
  if (['failed', 'denied', 'refused', 'tamper', 'broken'].includes(s)) return 'danger';
  return 'dim'; // absent, off, unconfigured, unverified, secondary
}

export interface Fixture {
  name: string;
  rows: { status: string; tab: 'HOME' | 'RUN' | 'CHAIN' | 'LIBRARY' }[];
  // FIX C addendum (director): on HOME the orange count is exact, not just
  // ≤1 — 7/7 journey + no pending escrow ⇒ 0 ("nothing needs you"); a pending
  // escrow or a next unsealed step ⇒ exactly 1.
  expectOrange?: number;
}

// Assert the contract over a set of fixture rows: red only on refused/failed,
// orange <=1 outside RUN, phosphor only on chain-confirmed statuses.
export function contractViolations(fx: Fixture): string[] {
  const v: string[] = [];
  for (const r of fx.rows) {
    const t = statusColor(r.status);
    if (t === 'danger' && !['failed', 'denied', 'refused', 'tamper', 'broken'].includes(r.status.toLowerCase())) {
      v.push(`${fx.name}: red on non-refusal status '${r.status}'`);
    }
    if (t === 'seal' && !['ok', 'sealed', 'verified', 'connected', 'live', 'passed', 'promoted'].includes(r.status.toLowerCase())) {
      v.push(`${fx.name}: phosphor on non-chain-confirmed status '${r.status}'`);
    }
  }
  const orange = fx.rows.filter(r => statusColor(r.status) === 'warn').length;
  const outsideRun = fx.rows.filter(r => r.tab !== 'RUN' && statusColor(r.status) === 'warn').length;
  if (outsideRun > 1) v.push(`${fx.name}: ${outsideRun} orange elements outside RUN (max 1)`);
  if (fx.expectOrange !== undefined && orange !== fx.expectOrange) {
    v.push(`${fx.name}: ${orange} orange elements, expected exactly ${fx.expectOrange}`);
  }
  return v;
}

// Negative-control analyzer for raw terminal captures (pre-hotfix view4):
// red spent on valid receipts / off-states is a contract violation.
export function captureViolations(text: string): string[] {
  const v: string[] = [];
  const chainOk = /\[VERIFIED\]|chain ok/i.test(text);
  const failRows = (text.match(/\[FAIL\]/g) ?? []).length;
  if (chainOk && failRows > 0) {
    v.push(`capture: ${failRows} red [FAIL] rows while chain reports verified (red on valid receipts)`);
  }
  if (/DOCKER:\s*DOWN|COMFY:\s*DOWN/i.test(text)) {
    v.push('capture: off-state (DOCKER: DOWN) presented as danger; off is dim, not red');
  }
  return v;
}

// ─── C1a (ORDER ui-v3-t9r2): the law gate ─────────────────────────────────
// lanes/visual/tokens.json is the only source of colour. These checkers are
// pure so tests/design-contract.test.ts can run them over the real theme and
// source tree AND over defective fixtures (§12: a gate is admitted only by
// demonstrating FAIL on a known-bad artifact — tests/fixtures/law-control.defective.tsx).

export interface LawColors { [name: string]: { value: string } }

/** Total binding: every theme token must be bound to a law colour and carry
 *  exactly that value; a token with no binding, or a binding with no token,
 *  is a violation — so a structural token can never quietly take an accent. */
export function lawViolations(themeObj: Record<string, string>, law: LawColors, bindings: Record<string, string>): string[] {
  const v: string[] = [];
  const admitted = new Set(Object.values(law).map(c => c.value.toUpperCase()));
  for (const [token, lawName] of Object.entries(bindings)) {
    const want = law[lawName]?.value?.toUpperCase();
    if (!want) { v.push(`theme.${token} is bound to '${lawName}', which the law does not declare`); continue; }
    if (!(token in themeObj)) { v.push(`theme.${token} is bound but missing from the theme`); continue; }
    const got = String(themeObj[token]).toUpperCase();
    if (got !== want) v.push(`theme.${token} must be law.${lawName} (${want}), got ${themeObj[token]}`);
  }
  for (const [token, val] of Object.entries(themeObj)) {
    if (!(token in bindings)) v.push(`theme.${token} has no binding in the law table`);
    else if (!admitted.has(String(val).toUpperCase())) v.push(`theme.${token} = ${val} is not a colour the law declares`);
  }
  return v;
}

const NAMES = 'black|red|green|yellow|blue|magenta|cyan|white|gray|grey|blackBright|redBright|greenBright|yellowBright|blueBright|magentaBright|cyanBright|whiteBright';
const BG_NAMES = 'bgBlack|bgRed|bgGreen|bgYellow|bgBlue|bgMagenta|bgCyan|bgWhite|bgBlackBright|bgRedBright|bgGreenBright|bgYellowBright|bgBlueBright|bgMagentaBright|bgCyanBright|bgWhiteBright';
const HEX_SRC = '#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\\b'; // exact alternation: a 7-char hash like #c7f08a3 stays clean
const HEX_G = new RegExp(HEX_SRC, 'g');
// an Ink colour prop with any value shape: ="x", ='x', =`x`, ={ … } (braces may span lines)
const INK_PROP_G = /\b(?:color|backgroundColor|borderColor)\s*=\s*(?:\{[^}]*\}|"[^"]*"|'[^']*'|`[^`]*`)/g;
// a colour decision inside that value: a quoted colour name, rgb(/ansi256(, or a hex
const INK_BAD = new RegExp(`(?:["'\`]\\s*(?:${NAMES})\\s*["'\`])|\\brgb\\(|\\bansi256\\(|${HEX_SRC}`);
// an object-literal colour ({ color: 'red' }) — the shape style maps and glyph tables use
const OBJ_PROP_G = /\b(?:color|backgroundColor|borderColor)\s*:\s*(?:"[^"]*"|'[^']*'|`[^`]*`)/g;
// any chalk member chain, in any shape: chalk.red.bold(, chalk.bold.red`…`, chalk['red'], an uncalled reference
const CHALK_CHAIN_G = /\bchalk(?:\.[A-Za-z0-9_$]+|\[\s*["'][A-Za-z0-9_$]+["']\s*\]|\((?:[^()]|\([^()]*\))*\))+/g; // call groups are stepped over so chalk.hex(x).bgRed( is one chain
const CHALK_MEMBER = new RegExp(`^(?:${NAMES}|${BG_NAMES}|rgb|bgRgb|ansi256|bgAnsi256|ansi|bgAnsi)$`);
// chalk bound to another name, or destructured: the chain check would not see it
const CHALK_ALIAS_G = /import\s+(?!chalk\b)[A-Za-z_$][\w$]*\s+from\s+["']chalk["']|import\s*\{[^}]*\}\s*from\s*["']chalk["']|(?:const|let|var)\s*\{[^}]*\}\s*=\s*chalk\b/g;
const OTHER_LIB_G = /from\s+["'](?:kleur|colorette|picocolors|ansi-colors|colors|cli-color|chalk-template|ansi-styles)["']/g;
// a raw COLOUR SGR escape written into source (screen/cursor codes like \x1b[?1049h or \x1b[2J are not colours)
const RAW_SGR_G = /\\(?:x1b|u001b|033)\[(?:[0-9;]*;)?(?:3[0-79]|4[0-79]|9[0-7]|10[0-7]|38|48)(?:;[0-9;]*)?m/g;
// a variable initialised from a colour-name string (const c = 'cyan', later color={c}); a colour
// word used as plain data elsewhere (an option label, an env value) is not a paint
const DECL_NAME_G = new RegExp(`\\b(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*=[^;\\n]*["'](?:${NAMES})["']`, 'g');

const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|[\s])\/\/.*$/gm, (_m, pre) => pre);

/** A source file under the gate may not choose a colour. Scans the whole text
 *  (props may span lines); comments are blanked first. Ink's dimColor,
 *  inverse and bold are SGR modifiers, not hues, and are admitted. */
export function sourceColorViolations(text: string, file: string): string[] {
  const v: string[] = [];
  const src = stripComments(text);
  const lineOf = (idx: number): number => src.slice(0, idx).split('\n').length;
  const each = (re: RegExp, fn: (m: RegExpExecArray) => string | null): void => {
    re.lastIndex = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(src))) { const why = fn(m); if (why) v.push(`${file}:${lineOf(m.index)}: ${why}`); }
  };
  each(HEX_G, () => 'raw hex');
  each(INK_PROP_G, m => (INK_BAD.test(m[0]) ? 'ink colour prop chooses a colour' : null));
  each(OBJ_PROP_G, m => (INK_BAD.test(m[0]) ? 'object-literal colour' : null));
  each(CHALK_CHAIN_G, m => {
    const members = [...m[0].matchAll(/\.([A-Za-z0-9_$]+)|\[\s*["']([A-Za-z0-9_$]+)["']\s*\]/g)].map(x => x[1] ?? x[2]);
    return members.some(x => CHALK_MEMBER.test(x)) ? 'chalk colour member' : null;
  });
  each(CHALK_ALIAS_G, () => 'chalk bound under another name');
  each(OTHER_LIB_G, () => 'another colour library');
  each(RAW_SGR_G, () => 'raw SGR escape');
  if (/\.tsx$/.test(file)) each(DECL_NAME_G, () => 'bare colour-name string in a component');
  return v.sort((a, b) => Number(a.split(':')[1]) - Number(b.split(':')[1]));
}
