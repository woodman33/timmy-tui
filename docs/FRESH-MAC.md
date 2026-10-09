# From a fresh Mac to a working Timmy R1 workspace

The exact steps, from a Mac with nothing installed to a project you build, preview and stop from the
Timmy REPL. What it says about Timmy was read from the code of `feat/ui-workflow-r1` at `2270269`
(`package.json`, `src/cli.ts`, `src/utils/init.ts`, `src/utils/config.ts`, `src/repl/`, `src/project/`,
`src/jobs/`), and the round R2 additions (step 7) at `989d7d5`; the install commands for Apple's tools,
Homebrew, Node and nvm come from those projects.

Each step carries one of three labels:

- **(checked on a Mac)**: run on 2026-10-09 on a Mac (macOS, Node 24.14.1, npm 11.11.0, git 2.54.0)
  in a throwaway home: `HOME`, `TIMMY_HOME` and `TIMMY_STORE` pointed at a new folder and the rest of
  the environment cleared with `env -i`, so no existing Timmy setup was read or changed. The REPL ran in
  a terminal (tmux) with a real model key; its screens were kept as the terminal's own text.
- **(checked on Linux in CI-like container)**: run on 2026-10-09 in a Linux container, from a checkout
  whose `node_modules` came from an existing install, with Node 22.22.0 (the only Node there, below the
  required 24), a throwaway Timmy home, and, for the REPL steps, a placeholder key and no model turn.
- **(to be checked on a Mac)**: not run yet; it needs macOS, Homebrew, the network, a terminal or a
  real model key.

On that Mac, Xcode's tools, Homebrew, Node 24 and upmd were already installed, so step 1 was not run
there; the steps from step 2 on were, except where a step says otherwise.

## 1. Prerequisites

Xcode Command Line Tools, which bring `git` **(to be checked on a Mac)**:

```sh
xcode-select --install
git --version
```

Homebrew, with the command from brew.sh; on Apple silicon, put it on your PATH as its installer's
"Next steps" says **(to be checked on a Mac)**:

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
```

Node 24 (`package.json` asks for `"node": ">=24"`; the operator's Mac runs 24.14.1). Either Homebrew's
`node@24`, which is keg-only and so goes on your PATH by hand **(to be checked on a Mac)**:

```sh
brew install node@24
echo 'export PATH="/opt/homebrew/opt/node@24/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node --version   # v24.x
```

or nvm, installed with its own script from github.com/nvm-sh/nvm (use the version its README names),
then **(to be checked on a Mac)**:

```sh
nvm install 24
nvm use 24
node --version   # v24.x
```

upmd, which runs the workflow blocks behind `/workflows` and `/run` **(to be checked on a Mac)**:

```sh
brew install rezigned/tap/upmd
upmd --version
```

Optional: carbonyl, to see pages inside the terminal instead of a link (`npm install --global carbonyl`,
the step `timmy tools` prints), and zellij or tmux, which carbonyl's pages and the cockpit need. Timmy
works without them.

## 2. Get the code

**(checked on a Mac)**: the clone took 300 s on that network; `npm ci --include=dev` installed 585
packages in 24 s.

```sh
git clone --branch feat/ui-workflow-r1 https://github.com/woodman33/timmy-tui.git
cd timmy-tui
npm ci --include=dev
```

**`--include=dev` matters (checked on a Mac).** Timmy runs from a checkout through `tsx`, a development
package. That Mac's shell sets `NODE_ENV=production`, so a plain `npm ci` installed 343 packages in 7 s,
left the development packages out, and Timmy could not start (`sh: tsx: command not found`, exit 127).
`--include=dev` installs them whatever `NODE_ENV` or npm's `omit=dev` setting says. If you skipped it,
`npm run timmy` now says so, prints `Fix: npm ci --include=dev` and exits 127 (checked on Linux in
CI-like container, with the packages absent).

`npm run timmy -- <command>` runs Timmy from this checkout (`scripts/timmy-dev.mjs`, which starts
`src/cli.ts` through `tsx`). Nothing is installed globally, and an existing global `timmy` is left alone.

## 3. Try it without touching an existing setup (optional)

Timmy keeps its state in a Timmy home (`~/timmy` unless `TIMMY_HOME` says otherwise) and its receipts
in a store `TIMMY_STORE` can name. `timmy init` also writes `.timmy/private/` in the checkout, or in
`TIMMY_PRIVATE_DIR`. To try Timmy beside an existing setup, point all three somewhere new in the shell
you run it from **(checked on Linux in CI-like container)**:

```sh
export TIMMY_HOME="$HOME/timmy-try"
export TIMMY_STORE="$TIMMY_HOME/receipts"
export TIMMY_PRIVATE_DIR="$TIMMY_HOME/private"
```

Unset them (or open a new shell) to go back to the usual home.

## 4. The model key

The REPL talks to models through OpenRouter. It takes the first key it finds, in this order
(`loadConfig` in `src/utils/config.ts`):

1. `OPENROUTER_API_KEY` in the environment; a `.env` file in the folder Timmy starts in is read into the
   environment first, but never over a variable that is already set (with `npm run`, Timmy starts in
   the checkout: npm runs a script from its package's folder);
2. `apiKey` in a `timmy-tui.config.json` in the folder Timmy starts in;
3. a key saved in the settings file (on macOS `~/Library/Preferences/timmy-tui-nodejs/config.json`,
   mode 0600);
4. `openrouter_api_key` in `$TIMMY_HOME/providers.json` (mode 0600), which `timmy init` writes when you
   give it a key.

The simplest is the environment, for this shell **(to be checked on a Mac)**:

```sh
export OPENROUTER_API_KEY=<your key>
```

or let the first-run wizard store it (next step). `npm run timmy -- init --yes --openrouter <key>` stores
it too, but leaves the key in your shell history. `OPENROUTER_MODEL` picks the model. A turn with a
model costs what OpenRouter charges for it; slash commands make no model call.

## 5. First run

On a blank Timmy home (no `identity.json`), a bare `npm run timmy` opens the first-run wizard: your
name, an identity, model keys (blank skips one), and the first project's name (default `first-light`).
It writes `$TIMMY_HOME/identity.json`, `identity.seed` (0600), `providers.json` (0600),
`projects/<name>/README.md`, `.timmy/private/config.json` and `projects.json`, and `.timmy/store-pin` in
the folder it runs in (with `npm run`, the checkout; both `.timmy` paths are gitignored). Without a terminal it shows the questions and writes nothing
**(checked on Linux in CI-like container)**.

```sh
npm run timmy
```

The same without questions **(checked on Linux in CI-like container)**:

```sh
npm run timmy -- init --yes --operator <your name> --project first-light
```

What works on this machine, and the step for each thing that does not **(checked on a Mac, in the
throwaway home with no key: it listed the REPL and OpenRouter as `needs setup  no model key`, Timmy
Canvas as `needs setup  the page is not built`, and the monitor, cockpit, web views, workflows and
receipts as installed)**:

```sh
npm run timmy -- tools
```

Start the REPL. From a checkout, `npm run timmy` with no command prints the help once the wizard has
run (the help's "with no command, opens the REPL" is the installed `timmy`), so name the command
**(checked on Linux in CI-like container, in a pipe; the interactive REPL checked on a Mac, started
from a clone of this branch through the same `tsx src/cli.ts repl` that `npm run timmy -- repl` runs)**:

```sh
npm run timmy -- repl
```

The first lines name the model, the folder Timmy works in, the receipt store and Timmy Canvas's state.
In a terminal the REPL opens even without a key, and a first run suggests `/setup`, which checks the
identity, the model key, the receipts and the palette, and seals the check as a receipt. In a pipe a
missing key ends it at once with exit code 78.

## 6. A first project

Type these at the REPL prompt. Each was run on Linux as a single command in a pipe, with no model turn
**(checked on Linux in CI-like container)**, except where a step says otherwise.

```text
/project new hello-site
```

Makes an empty folder `$TIMMY_HOME/projects/hello-site`, works there, and keeps this project's
conversation in it. `/project list` lists projects; `/project <name>` switches.

Make a workflow document, `BUILD.md`: ask Timmy for it (a model turn), or `/edit BUILD.md`, which opens
`$VISUAL`, else `$EDITOR`, else `vi`, makes the file when you save, and seals the edit as a receipt
**(to be checked on a Mac)**. Each runnable block is a fenced code block with a `name`, and `deps` names
the blocks it needs first:

````markdown
# Build

```bash [name:hello]
echo "hello from upmd"
```

```bash [name:site, deps:hello]
mkdir -p dist
printf '<h1>It works</h1>\n' > dist/index.html
```
````

Then:

```text
/files
/open BUILD.md
/workflows
/run BUILD.md site
/jobs
/preview
/results
/stop all
/exit
```

- `/files` lists the project's files by role (workflows, outputs, other). `/open <file>` shows a file's
  size and hash and its first 30 lines; for a workflow such as `BUILD.md`, its blocks instead.
- `/workflows` lists the workflow documents and their blocks, and says whether upmd is installed.
- `/run BUILD.md site` shows what will run (`hello`, then `site`) and runs it with upmd as a background
  job; `/jobs` lists jobs and `/jobs <id>` shows one. Without upmd it says so and runs nothing
  (checked); the run itself **(to be checked on a Mac)**.
- `/preview` serves a built folder (`dist/`, `build/` or `out/` with an `index.html`) on a free port at
  127.0.0.1 as a job; with none, it runs the project's `dev`, `start` or `preview` script with `PORT`
  set (a page at the root beside such a script is the app's unbuilt source, as in a Vite app); with
  neither, it serves `public/` or the project folder. `/preview <folder>` serves a folder you name, and
  `/preview <command> --url <address>` runs your own server. The address opens in Timmy's Browser when
  the server answers: inside the terminal with carbonyl, otherwise as a link (a built folder checked on
  a Mac in R1; a `dev` script checked on a Mac in R2, after the order above was fixed).
- `/results` shows the project's jobs (each with its receipt), its outputs and what changed.
- `/stop all` stops every job this REPL started; `/exit` quits, and the jobs this REPL started stop with
  it.

## 7. Images, native apps, MCP and the board (round R2)

These work in a project too. Each says what it needs when that is missing; none installs anything.

```text
/add ~/Desktop/card.png
/observe refs/card.png
/observe refs/card.png What is printed on this card?
/board
/mcp
/mcp tools -- node server.mjs
/mcp call --route sdk add '{"a":2,"b":3}' -- node server.mjs
/c4d scene.py
/ae project.aep "Main Comp" out/main.mov
```

- `/add <file…>` copies files into the project's `refs/` (a name already there gets a number) and
  seals the copy as a receipt **(checked on a Mac)**.
- `/observe <image>` measures the image with Timmy's Look worker (OpenCV) as a job: its size, colours,
  sharpness, edges, QR codes and ArUco markers, written to `results/observations/` and labelled
  *deterministic computation* **(checked on a Mac: from a test card it read the QR text and ArUco
  marker 7)**. It needs `python3` with OpenCV: `python3 -m pip install opencv-python-headless numpy`;
  `/tools` says when it is missing.
- `/observe <image> <question>` also asks the model you are using, and keeps the answer apart,
  labelled *model interpretation*: a claim, not a measurement. The image goes only to a model that
  OpenRouter lists as taking images; any other model is refused before anything is sent, with a few that
  do. It costs what OpenRouter charges **(checked on a Mac with `anthropic/claude-haiku-4.5`)**. In a
  conversation the model can run the same measurement itself (`observe_image`, which only reads) and,
  with your approval each time, ask for an interpretation (`describe_image`).
- `/board` writes `.timmy/board/index.html`, a read-only page of the project: its references, workflow
  blocks, this project's jobs, outputs and observations, each card linked to its file and showing the
  command that acts on it (click one to copy it). The page names no absolute path. Open the link it
  prints; inside tmux or zellij with carbonyl Timmy shows the page itself **(checked on a Mac: one
  reference, one workflow, four jobs and three observations, the page photographed with headless
  Chrome; no absolute path in it)**.
- `/mcp` lists Timmy's two ways to reach MCP servers from the command line, MCPorter's CLI (the
  `mcporter` package) and Timmy's own small CLI on the MCP SDK, each usable without the other, then the
  servers MCPorter's configuration names. `/mcp tools` lists a server's tools and `/mcp call` calls one;
  after `--` give any stdio server's command line **(checked on a Mac, both ways, with the test server
  `tests/fixtures/mcp-echo-server.mjs`)**. In a conversation the model can list a configured server's
  tools by itself; listing tools from a command line, or calling any tool, asks your approval each
  time.
- `/c4d <script.py>` runs a Cinema 4D Python script with `c4dpy` as a background job; the script
  writes its result through `workers/c4d/timmy_c4d.py`, and Timmy judges the job by that result and the
  files it names, not by the exit code alone. `templates/c4d-starter/` has a starter scene. On the Mac it
  was run on, Cinema 4D had not been licensed for that user, so `c4dpy` asked how to license it and
  waited; Timmy stopped the job at once and said so **(checked on a Mac; a real Cinema 4D run is still to
  be checked: run Cinema 4D once as that user and choose how to license it)**.
- `/ae <project.aep> <comp> <output>` renders an After Effects composition with `aerender` the same way
  **(to be checked on a Mac: it needs an `.aep` project)**.

Set `TIMMY_C4DPY` or `TIMMY_AERENDER` when the app is not in `/Applications`. If you run Timmy with a
different `HOME` (a throwaway home, as here), set `TIMMY_NATIVE_HOME` to your usual home: Cinema 4D's
license and Python's own packages (OpenCV) live there, and native jobs and the Look worker use it.

## 8. Where things live

| What | Where |
|---|---|
| Timmy home | `$TIMMY_HOME`, default `~/timmy` |
| Identity | `$TIMMY_HOME/identity.json`, `identity.seed` (0600) |
| Keys from `timmy init` | `$TIMMY_HOME/providers.json` (0600) |
| Projects | `$TIMMY_HOME/projects/<name>/`; the active one in `$TIMMY_HOME/state/active-project.json` |
| Jobs | `$TIMMY_HOME/jobs/<id>.json` (the record) and `<id>.log` (its output, stdout and stderr together) |
| Receipts | `$TIMMY_STORE` when set; otherwise the store a `.timmy/store-pin` above the working folder names, then `.timmy/receipts` beside the nearest `package.json`, then `.timmy/receipts` in the working folder. The REPL's first lines name the one in use. |
| Settings | macOS: `~/Library/Preferences/timmy-tui-nodejs/config.json` (0600) |
| Private config | `.timmy/private/` in the checkout, or `$TIMMY_PRIVATE_DIR` |
| In the working folder | `logs/` (Timmy's own logs), `.timmy/keys/` (a signing key), `.timmy/cache/`, the project's conversation, and `.timmy/runs/command-<time>-<random>.log`: the full output of a command too long to show (the first 4 KB and last 12 KB of each stream are shown; checked on a Mac, a 1.99 MB output) |
| In a project (round R2) | `refs/` (files from `/add`), `results/observations/` (what `/observe` measured), `.timmy/board/index.html` (the last `/board`) |

The working-folder files were seen on Linux after the REPL ran in a project
**(checked on Linux in CI-like container)**. Keep `logs/` and `.timmy/` out of a project's version
control.

## 9. Troubleshooting

- **NODE_PATH.** If your shell sets `NODE_PATH`, Node may load packages from outside this checkout. Run
  the test suite with it unset, and try the same when Timmy fails to load a module:

  ```sh
  echo "$NODE_PATH"
  env -u NODE_PATH npm test
  env -u NODE_PATH npm run timmy -- repl
  ```

  The full suite **(to be checked on a Mac)**.
- **A busy port.** `/preview` picks a free port for a folder or a `dev` script. A server you start with
  `/preview <command> --url <address>` chooses its own; if that port is taken, the job fails or never
  answers. See who holds it, then stop Timmy's own jobs with `/stop <job>` or `/stop all`:

  ```sh
  lsof -nP -iTCP:<port> -sTCP:LISTEN
  ```

  The REPL's first lines also say when Timmy Canvas's port is in use by another program.
- **upmd missing.** `/workflows` says `upmd is not installed: brew install rezigned/tap/upmd`, and `/run`
  says the block did not run (checked on Linux). Install it, check `upmd --version`, then `/run` again.
- **carbonyl is optional.** Without it, `/preview` and `/web` give a link to open in your own browser.
  With it (`npm install --global carbonyl`), pages show inside the terminal when Timmy runs inside zellij
  or tmux.
- **The first-run wizard.** A bare `npm run timmy` on a blank Timmy home always opens the wizard. To skip
  the questions, use `npm run timmy -- init --yes ...` with flags, or start with
  `npm run timmy -- repl`, which opens the REPL without the wizard. A different `TIMMY_HOME` is a blank
  home again.
- **No model key.** In a terminal the REPL opens and `/setup` reports `model key none`; in a pipe or a
  script it stops with exit code 78 and `no model key, so Timmy cannot answer` (checked on Linux).
  Set `OPENROUTER_API_KEY` (step 4) and start it again.
- **Timmy Canvas.** `npm run timmy -- tools` reports it needs setup until its page is built:
  `npm run build:canvas` **(to be checked on a Mac)**.
- **`/observe` says OpenCV is not available** although `python3 -c "import cv2"` works in your shell:
  Timmy is running with a different `HOME`, which hides Python's user packages. Set `TIMMY_NATIVE_HOME`
  to your usual home, or `TIMMY_VISION_PYTHON` to a Python that has OpenCV (checked on a Mac).
- **`/c4d` stops at once with "asked how to license it".** Cinema 4D has not been licensed for the user
  (or the `HOME`) the job runs as. Run Cinema 4D once and choose how to license it, or set
  `TIMMY_NATIVE_HOME` to the home that holds the license; Timmy does not answer the license question
  for you (checked on a Mac).
- **A slow machine.** On a Mac under very heavy load (a load average above 400) the REPL took more than
  a minute and a half to start; it is ready when it prints `Type a message to start.`
