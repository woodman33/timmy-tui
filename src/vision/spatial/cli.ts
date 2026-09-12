export async function runSpatialCli(args: string[], out: (s: string) => void = console.log) {
  if (args[0] === 'volume') {
    const { runVolumeCli } = await import('./volume-cli.js');
    return runVolumeCli(args.slice(1), out);
  }
  if (args[0] === 'models') {
    const { runModelCli } = await import('./model-cli.js');
    return runModelCli(args.slice(1), out);
  }
  if (args[0] === 'pack' || args[0] === 'propose') {
    const { runContextOrderCli } = await import('./context-order-cli.js');
    return runContextOrderCli(args, out);
  }
  out('timmy vision spatial [volume inspect|models list|models context|models review|pack|propose] --help');
  return args.length === 0 || args.includes('--help') ? 0 : 2;
}
