# Project folder standard — project-folder/v0

One folder per project under `~/timmy/projects/<name>/`. A harness that is
sent into a project sees this folder and nothing else; what it may load, run,
read, write and spend is decided by the folder, not by the harness.

```
~/timmy/projects/<name>/
├── skills/        SKILL.md folders a harness may load (one folder per skill)
├── plans/         plans and orders: proposals until the controller arms them
├── boards/        Slate boards (mission, story, blueprint) the harness may compile
├── drop/          inputs dropped in for a run (files, photos, exports)
├── out/           everything a run produces; out/menu.json is the harness menu
└── profile.cue    who may work here, budget, models, the receipt store
```

## The profile

`profile.cue` is CUE so it can be vetted (`cue vet profile.cue`) and exported
(`cue export profile.cue -e profile`). The schema `#Profile` pins:

| field | meaning |
|---|---|
| `name`, `owner`, `created` | identity; `name` is the folder name (`^[a-z0-9][a-z0-9._-]{0,39}$`) |
| `standard` | `project-folder/v0` |
| `harnesses.allowed` | which harnesses may hold a run here (jcode, opencode, pi, hermes, minds, openhands, …) |
| `harnesses.preferred` | the default menu |
| `budget.max_spend_usd` | the cap a run may spend (the commander's cap for this project) |
| `models.mind`, `models.actors` | OpenRouter ids the run may use |
| `receipts.store` | the root receipt store, from the repo's committed `.timmy/store-pin`; never a subdirectory |
| `paths.*` | the fixed layout names |
| `tags` | free labels |

When `cue` is not installed the reader (`fleet/harness-menu.mjs`) falls back to
the plain `key: "value"` subset; the template stays inside that subset.

## Commands

```
timmy project new <name> [--owner who] [--harness a,b] [--preferred x] [--budget usd] [--tags a,b]
timmy project menu <name> [--harness x]
timmy project list
timmy project standard
```

`new` creates the layout, writes the profile from
`lanes/project/templates/profile.cue`, vets it, writes the first
`out/menu.json`, and seals `project.new` (name, dir, owner, harnesses, budget,
store, profile sha). It refuses to overwrite an existing folder.

## Harness menus read from it

`fleet/harness-menu.mjs` is the one reader. `harnessMenu(project, harness)`
returns what that harness is offered: `permitted` (is it in
`harnesses.allowed`), the budget, the models, the receipt store, the skills
(with their `SKILL.md` description line), the plans, the boards (with their
`kind`), what is in `drop/`, what is in `out/`, and a `launch` block built
from the lane registry (`src/agent/lanes.ts`): the harness command, the
project dir as cwd, and the env a run carries (`TIMMY_PROJECT`,
`TIMMY_PROJECT_DIR`, `TIMMY_WORKSPACE = out/`). The same menu is written to
`out/menu.json` so a harness that can only read files reads the same thing a
harness that can call the lane reads.

Four rules ride on every menu:

1. read the menu before acting; the folder is the whole world for this run
2. inputs come from `drop/`, outputs go to `out/`, never elsewhere
3. plans in `plans/` are proposals until the controller arms them
4. every receipt seals into `receipts.store` (the root store), never a subdirectory

## Receipts

`project.new` per folder created; `project.standard` once for the standard
itself (this file's sha, the template's sha, the reader's sha, the first
project's path).
