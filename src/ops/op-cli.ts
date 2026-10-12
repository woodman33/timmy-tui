/**
 * `timmy op <operation id>`: one operation's run detail (src/contracts/run-detail.ts), made by src/ops/run-detail.ts. R4:
 * being built this round; until it is, the verb says so and exits 69 (unavailable). Today: /op <id> in the REPL, or
 * timmy act '/op <id>'.
 */
export const OP_USAGE = 'timmy op <operation id> [--json] [--summary] [--project <dir>]';

const NOT_BUILT = 'timmy op is not built in this revision yet (round R4 is making it); today: /op <id> in the REPL, or timmy act \'/op <id>\'';

export async function opMain(argv: string[], o: { json?: boolean } = {}): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${OP_USAGE}\n  ${NOT_BUILT}.\n`);
    return 0;
  }
  if (o.json || argv.includes('--json')) process.stdout.write(`${JSON.stringify({ built: false, why: NOT_BUILT })}\n`);
  else process.stderr.write(`Error: ${NOT_BUILT}.\n`);
  return 69;
}
