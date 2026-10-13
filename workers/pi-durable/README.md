# Pi Durable worker packages

The exact versions of the three Pi Durable libraries that Timmy's Pi worker (`src/pi-durable/worker.ts`) loads:

| Package | Pin |
|---|---|
| `@earendil-works/pi-durable` | 1.1.0 |
| `@earendil-works/pi-ai` | 1.1.0 |
| `@earendil-works/chord` | 1.1.0 |

`package-lock.json` pins every transitive version (89 packages, about 111 MB installed, no native binary: storage uses
Node's built-in `node:sqlite`).

- **What it is.** A private package, never published. It holds only the pins. The worker loads the libraries from this
  folder by absolute path, through one adapter (`src/pi-durable/adapter/pi-api.ts`), and refuses to start when an
  installed version differs from its pin (`src/pi-durable/pins.ts`).
- **Installed only on the operator's yes**, into this folder (`npm ci --ignore-scripts --omit=optional`, or
  `--worker-dir` / `TIMMY_PI_WORKER_DIR` for another folder). Its `node_modules/` is never committed.
- **Not part of Timmy's npm package.** This folder is not in the root `package.json` `files`, so the ~111 MB never ships
  with `timmy-tui`, and none of these packages is a Timmy dependency.
- **Experimental upstream.** pi-durable's README says its API changes without notice; 1.0.3, 1.0.4 and 1.1.0 each broke
  something. A version bump is a change of its own: the pins here, in `src/pi-durable/pins.ts` and in the lockfile move
  together, and the fixture tests (`tests/pi-durable-*.test.ts`) run again.
- **No model is configured here.** In slice S1 the worker's only model is pi-ai's scripted faux provider (FAKE: no
  request leaves the machine, no key, no cost).
