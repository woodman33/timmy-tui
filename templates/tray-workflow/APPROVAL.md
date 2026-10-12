# Approval: see a NEEDS YOU box

Timmy asks you before a workflow runs a block whose command is a destructive shell command, by the same
rule its agent's shell tool is asked by: a command with `rm`, `sudo`, `chmod`, `chown`, `dd` or `mkfs` in
it. This document holds one such block, so you can see that question without writing a document of
your own. Its command is harmless: it makes the folder `scratch` and the empty file `scratch/x` in this
project, then deletes `scratch/x`. Nothing else is touched; the empty `scratch` folder stays.

## Run it

Type `/run APPROVAL.md tidy` in the REPL. Before upmd runs anything, the REPL shows a NEEDS YOU box: the run, the block and its whole command, and
why it asks. Nothing of the run starts, and nothing is sealed, until you answer:

- `y` allows it once: this run, with the command as this document holds it now. The next `/run` asks again.
- `n`, Esc or Enter deny it: nothing runs and nothing is sealed.

Your answer is sealed with the run's prediction, before upmd starts; the block then gets its own
receipt as it ends, and `/op` shows the run. If this document changes while the box waits, the run is
refused, since what you approved is not what upmd would read. While the box waits, the live board's
Control Room lists it under Waiting on you.

## Where it is not asked

The board will not run it: its Run cannot show the box, so it is refused before anything runs, and the
Control Room names the line to type in the REPL instead. `timmy act '/run APPROVAL.md tidy'` refuses it
the same way (exit 2). `timmy md APPROVAL.md tidy` asks in its own terminal, and with no terminal it
refuses (exit 2).

```bash [name:tidy]
mkdir -p scratch && touch scratch/x && rm scratch/x
```
