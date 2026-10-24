/**
 * FAKE helpers for the decision tests (tests/decision-*.test.ts): Clef-Omni answers no model made, written in the
 * published answer shape, and a temporary git project to decide in. Test code only; nothing here calls a service.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = dirname(fileURLToPath(import.meta.url));
export const fixture = (name: string): string => join(FIXTURES, name);
export const readFixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(fixture(name), 'utf8')) as Record<string, unknown>;

/** A short FAKE token (never key-shaped) and account id for the Workers AI transport. */
export const FAKE_TOKEN = 'FAKE.token.for.tests~0001';
export const FAKE_ACCOUNT = 'FAKEaccount0000tests';

/** A FAKE answer: one choice question per entry (the highest probability is the choice), plus the human_review noul. */
export function fakeAnswer(
  questions: Record<string, Record<string, number>>,
  o: { humanReview?: number; usage?: { input_tokens: number; output_tokens: number } | null; model?: string } = {},
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [q, probs] of Object.entries(questions)) {
    const [choice, top] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
    answers[q] = { type: 'choice', choice, probabilities: probs, confidence: top };
  }
  answers.human_review = { type: 'noul', noul: o.humanReview ?? 0.1 };
  return { model: o.model ?? 'clef-omni', answers, ...(o.usage === null ? {} : { usage: o.usage ?? { input_tokens: 100, output_tokens: 0 } }) };
}

/** Writes a FAKE body as a file in `dir` and returns its path. */
export function writeFake(dir: string, name: string, body: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return file;
}

/** A token file of the operator's own kind (0600), holding the FAKE token. */
export function fakeTokenFile(dir: string, token = FAKE_TOKEN): string {
  const file = join(dir, 'clef.token');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

const git = (cwd: string, args: string[]): string => {
  const r = spawnSync('git', ['-c', 'user.email=fake@example.com', '-c', 'user.name=FAKE', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A temporary git project with one FAKE commit. `commit()` makes another and returns the new HEAD. */
export function gitProject(prefix = 'timmy-decide-'): { root: string; head: string; commit: (what?: string) => string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  git(root, ['init', '-q']);
  writeFileSync(join(root, 'README.md'), 'FAKE project for decision tests\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-q', '-m', 'FAKE: first']);
  const head = git(root, ['rev-parse', 'HEAD']);
  let n = 0;
  const commit = (what = 'FAKE: more'): string => {
    n += 1;
    writeFileSync(join(root, `note-${n}.txt`), `${what}\n`);
    git(root, ['add', `note-${n}.txt`]);
    git(root, ['commit', '-q', '-m', what]);
    return git(root, ['rev-parse', 'HEAD']);
  };
  return { root, head, commit };
}

/** Every file under `dir` (recursively) with its bytes as text, for "no secret anywhere" checks. */
export function allFiles(dir: string): Array<{ file: string; text: string; mode: number }> {
  const out: Array<{ file: string; text: string; mode: number }> = [];
  const walk = (d: string): void => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push({ file: p, text: readFileSync(p, 'utf8'), mode: st.mode & 0o777 });
    }
  };
  walk(dir);
  return out;
}
