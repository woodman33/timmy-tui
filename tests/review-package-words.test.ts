// R9 lead, after the R9 independent review of 1fa4020 (its F2 and F3): the review package's README says what is true of the
// revision it was built from. Its branch line was fixed text ("branch `r8/review-build`") in a package built from
// r9/review-build; now the build fills it from the checkout. And a reviewer can see a decision answered: the README says a
// decision binds to a git revision (the demo's tray is not a git repository) and how routing is turned on for one process.
// Static reads of the two files the build fills; nothing is built or run here.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REVIEW = join(__dirname, '..', 'scripts', 'review');
// the README is wrapped at about 120 columns: a sentence is read with its line breaks as spaces
const readme = readFileSync(join(REVIEW, 'README.md'), 'utf8').replace(/\n\s*/g, ' ');
const build = readFileSync(join(REVIEW, 'build-review.sh'), 'utf8');

describe('the review package README (the R9 review)', () => {
  it('names the branch the build ran on, never a fixed round\'s branch (F2)', () => {
    expect(readme).not.toMatch(/branch `r\d+\/review-build`/);
    expect(readme).toMatch(/\| Revision \| `__REV__`, branch `__BRANCH__`/);
    // the build fills it from the checkout, with a delimiter a branch's slash cannot break
    expect(build).toMatch(/branch=\$\(git branch --show-current/);
    expect(build).toMatch(/-e "s\|__BRANCH__\|\$branch\|g"/);
  });
  it('says how to see a decision answered: a git project, routing on for one process, a FAKE or a model of your own (F3)', () => {
    expect(readme).toMatch(/A decision binds to its project's git revision, and the demo's tray is not a git repository/);
    expect(readme).toMatch(/TIMMY_CLEF=1 \.\/review\.sh timmy decide/);
    expect(readme).toMatch(/TIMMY_CLEF and TIMMY_RERUN reach Timmy when you set them/);
  });
});
