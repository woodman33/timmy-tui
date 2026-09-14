# ORDER blank-slate-v1k9 — the tree carries no one

Identity leaves the public tree; the first run is blank; a release gate proves both from a
fresh clone in a clean container. Stacked on ORDER privacy-d5n9 (#40) and ORDER hosts-j4t1 (#44).

## What changed

| Area | Before | Now |
|---|---|---|
| pattern set | identity literals (email, handle, login, hostnames) in `lanes/privacy/patterns.json` | `hashed_terms`: sha256 of the lowercased term only; `timmy privacy hash-term <term> --add` adds one and keeps the literal in `.timmy/private/identity-terms.json` |
| scanner | regex only | every line is also tokenized (emails whole, words split on dots) and each token's hash is looked up; `identity.*` findings are high |
| `package.json` author, `LICENSE` | a person | `The TIMMY authors (https://github.com/woodman33/timmy-tui)` |
| attribution strings, operator defaults | a person, in 21 files | the project; operator read from `TIMMY_OPERATOR_LABEL` / the overlay (`operator_label`) |
| worker host defaults | a personal `*.workers.dev` literal in 31 files | `src/`: ORDER hosts-j4t1 (`edge-host.ts`); lanes/scripts/boards: `edgeUrlOrInert()` in `lanes/privacy/overlay.mjs` — overlay → `TIMMY_EDGE_HOST` → inert `<hostname>` |
| `orders.log` | tracked ledger with hosts, paths and people | `.timmy/private/orders.log` (operator-private); `docs/JOURNAL.md` is generated and sanitized by `lanes/privacy/journal.mjs` (`--check` fails when stale or unclean; `--seed-from <ref>` restores a ledger from git) |
| `.timmy/store-pin` | tracked, an absolute Mac path | untracked and never committed; `timmy init` generates it on the first run (`ensureStorePin`, which nothing called before) — the one write outside `.timmy/private/`, inside the gitignored `.timmy/` |
| first run | help / the TUI | `timmy init` (operator, seed identity, providers, first project) — writes only to `~/timmy/` and `.timmy/private/`; `timmy`, `npm start` and `timmy <nothing>` show the wizard until it has run |
| release gate | none | `timmy release check` — see below |

## Where the operator's email appears today

Measured on this branch (`git grep`, `git log --all`, `git for-each-ref`):

| Place | Count |
|---|---|
| tracked files in the tree | 0 |
| commits authored with it (all refs) | 279 |
| commits committed with it (all refs) | 248 |
| tags whose tagger carries it | 13 of 27 |
| commit messages that contain it (all refs) | 2 |
| GitHub's own copies (PR heads, commit pages, the Cursor bot's co-author lines) | server-side, mirrors the above |

The login name (`/Users/<login>` and the login as a word) remains in `studio/**/*.cast`
(138 high findings) until the merge train's step 0 applies Codex's sanitized casts; the
tree scan reports it truthfully until then. The GitHub login `woodman33` stays in repository
URLs: it is the repository's address, and only an organization transfer changes it.

## `timmy init` — the first run is blank

Four questions; answers can also be flags (`--yes` makes it non-interactive):

| Question | Flag | Written to |
|---|---|---|
| operator name | `--operator` | `~/timmy/identity.json`, `.timmy/private/config.json` (`operator_label`) |
| seed identity: generate an ed25519 seed, or import a PEM / 64-hex seed | `--seed generate\|<pem\|hex>` | `~/timmy/identity.seed` (0600), public key + `operator_id` in `identity.json` |
| providers: OpenRouter key, Anthropic key, Ollama host | `--openrouter --anthropic --ollama` | `~/timmy/providers.json` (0600); `loadConfig()` reads the OpenRouter key from it when env and local config are silent |
| first project | `--project` | `~/timmy/projects/<name>/`, `.timmy/private/projects.json` |

`applyInit` asserts every path it writes sits under `TIMMY_HOME` or `TIMMY_PRIVATE_DIR`
(both overridable, which is how the release check and the tests keep a container's home blank).
Without a TTY and without `--yes` the wizard prints its questions and writes nothing.

## `timmy release check`

```
timmy release check [--ref <branch>] [--image node:24-bookworm] [--local] [--seal] [--json out.json]
```

1. `git bundle` of the committed ref (never the working tree, never `.timmy/`).
2. `docker run node:24-bookworm` (or `--local`: a temp dir with a blank `HOME`) → `git clone` from the bundle → `npm ci`.
3. Inside the clone (`lanes/release/inside.mjs`):
   - zero personal matches in the tree: `pii.*` and `identity.*` at any severity;
   - no `.timmy/receipts`, `.timmy/store-pin`, `.timmy/private`, `orders.log`;
   - first screen of both entry points (`timmy.ts` and `src/cli.ts`, no TTY, blank home): the wizard is shown, zero personal matches in the output, nothing written to the home, no receipts created;
   - §12 negative control: a planted file with a home path, an email, the synthetic hashed term and — when `.timmy/private/identity-terms.json` exists — the operator's first real identity literal MUST raise findings; the tree is unchanged afterwards.
4. Exit 0 only when every assertion holds; `--seal` records a `release.check` receipt through the canonical CLI.

## Family names

Names are never typed into the tree or a transcript. The operator runs, once per name:

```
timmy privacy hash-term "<name>" --add --id identity.family --severity high
```

which stores the sha256 in `patterns.json` and the literal only in `.timmy/private/identity-terms.json`;
the release check then plants that literal in its negative control.

## Proposed (NOT run): the history rewrite

The tree is clean; the history is not (279 + 248 commits, 13 tags, 2 messages). Rewriting is a
one-time, operator-run, force-pushing operation and is outside every agent's rules, so it is
proposed here and left for the operator, **after** the merge train and this PR have landed
and **before** the repository is announced as public.

Files kept privately (never committed — the mailmap must contain the real address to work):

```
# .timmy/private/mailmap
<Public Name> <woodman33@users.noreply.github.com> <personal-email>
woodman33 <woodman33@users.noreply.github.com> <personal-email>

# .timmy/private/replace-messages.txt
<personal-email>==><redacted-email>
```

The rewrite, on a fresh mirror clone (`git filter-repo` refuses to touch a non-fresh clone):

```
git clone --mirror https://github.com/woodman33/timmy-tui.git rewrite.git && cd rewrite.git
git filter-repo --mailmap ../.timmy/private/mailmap --replace-message ../.timmy/private/replace-messages.txt
# verify: git log --all --format='%an <%ae> %cn <%ce>' | sort -u ; git for-each-ref --format='%(taggeremail)' refs/tags | sort -u
# then, deliberately: git push --mirror --force   (rewrites every branch and tag on GitHub)
```

Consequences to accept first:

- every commit SHA changes, tags included; `filter-repo` writes `commit-map` — keep it privately, because receipts and ledger lines cite pre-rewrite SHAs;
- every open PR (#33–#46) and every worktree must be recreated from the rewritten refs (their heads are old objects);
- GitHub keeps the old objects reachable (cached PR refs, forks) until support is asked to purge them;
- the two commit messages get `<redacted-email>`; `Co-Authored-By` trailers are untouched.
