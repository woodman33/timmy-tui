/**
 * `timmy workbench`: the terminal Workbench, one project in five zones (navigation; project and task; the work; Tools,
 * Inspector and Files; task controls and Activity). R4: being built this round; until it is, the verb says so and exits 69
 * (unavailable), and the REPL (`timmy`) and the monitor (`timmy watch`) are the terminal surfaces.
 */
export const WORKBENCH_USAGE = 'timmy workbench [--json] [--help]';

const NOT_BUILT = 'the terminal Workbench is not built in this revision yet (round R4 is making it); today the terminal surfaces are timmy (the REPL) and timmy watch (the monitor)';

export async function workbenchMain(argv: string[], o: { json?: boolean } = {}): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${WORKBENCH_USAGE}\n  ${NOT_BUILT}.\n`);
    return 0;
  }
  if (o.json || argv.includes('--json')) process.stdout.write(`${JSON.stringify({ built: false, why: NOT_BUILT })}\n`);
  else process.stderr.write(`Error: ${NOT_BUILT}.\n`);
  return 69;
}
