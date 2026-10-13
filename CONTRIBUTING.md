# Contributing to TIMMY

We welcome early open-source contributions to TIMMY! Follow this guide to set up your local development sandbox and help us build the trust layer for autonomous agents.

## Getting Started

1. **Fork and Clone** the repository:
   ```bash
   git clone https://github.com/woodman33/timmy-ai-proxy.git
   cd timmy-ai-proxy
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Verify Existing Tests**:
   Before making modifications, confirm that the test suite passes on your system:
   ```bash
   npm test
   ```

   A test file that keeps running for more than 5 minutes is named in the output, with the processes under vitest
   (`tests/stuck-file-reporter.ts`; `TIMMY_TEST_STUCK_MS` changes the limit). To find tests that block a worker's event
   loop, run with `TIMMY_TEST_HEARTBEAT=/tmp/heartbeat.jsonl`: every stall over 1 s is logged with its file and tests
   (`tests/heartbeat-setup.ts`). A stall of 60 s or more makes vitest report `Timeout calling "onTaskUpdate"`; await a
   child process (`tests/helpers/run-async.ts`) instead of `spawnSync`/`execSync` when it takes more than a moment.

## Development Guidelines

- **Preserve Local-First Design**: Do not add telemetry, remote phone-home hooks, or credentials trackers. All credentials must remain completely local.
- **Maintain TypeScript Parity**: Compile your changes with `npm run build` and resolve any compiler warnings.
- **Add Tests**: If you introduce a new feature or command, add matching tests to `tests/` and verify they run successfully.
- **Format and Lint**: Follow standard clean formatting rules to prevent git-history clutter.

## Submitting Pull Requests

1. Create a logical feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Write clear, granular commits.
3. Push to your fork and submit a Pull Request to our main branch.
4. Ensure the GitHub Actions CI checks pass completely.
