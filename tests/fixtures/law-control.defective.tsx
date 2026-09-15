// §12 NEGATIVE CONTROL for the visual-law gate (ORDER ui-v3-t9r2, C1a).
// This file is a KNOWN-DEFECTIVE artifact: it chooses colours in every way the
// gate must catch. It lives outside src/tui on purpose (the walk never reaches
// it) and is never imported; tests/design-contract.test.ts runs the checker
// over it and requires violations, and the gate.control seal cites its sha.
import React from 'react';
import { Text, Box } from 'ink';
import chalk from 'chalk';
import kolor from 'chalk';
import { red } from 'chalk';
import pc from 'picocolors';

const oldGreen = '#3BE08C';
const shortHex = '#fff';
const alphaHex = '#37D2FF80';
const styles = { color: 'red', backgroundColor: '#123456' };
const c = 'cyan';
const painted = [pc.green('x'), chalk.red.bold('x'), chalk.bold.red('x'), chalk.bgRed.white('x'), chalk['red']('x'), chalk.rgb(1, 2, 3)('x'), red('x'), kolor.green('x')];
const raw = '\x1b[31mred\x1b[0m';

export function Defective() {
  return (
    <Box borderColor={"cyan"}>
      <Text color="cyan">{oldGreen}</Text>
      <Text color={'magenta'}>{shortHex}</Text>
      <Text color={c ? 'green' : 'red'}>{alphaHex}</Text>
      <Text color={c}>{styles.color}</Text>
      <Text color="rgb(1,2,3)">{painted.join('')}</Text>
      <Text backgroundColor="ansi256(196)">{raw}</Text>
      <Text
        color=
          "yellow"
      >multi-line</Text>
    </Box>
  );
}
