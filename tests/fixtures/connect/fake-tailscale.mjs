#!/usr/bin/env node
/**
 * FAKE tailscale, for Timmy Connect's tests only (round R4, helper H90): `tailscale status --json` answers the JSON in the
 * file $TIMMY_FAKE_TAILSCALE_JSON (written by the test at run time); anything else is refused. No tailnet is read.
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
if (process.env.TIMMY_FAKE_SSH_LOG) fs.appendFileSync(process.env.TIMMY_FAKE_SSH_LOG, `${JSON.stringify({ prog: 'tailscale', pid: process.pid, argv })}\n`);
if (argv.join(' ') !== 'status --json') { process.stderr.write('FAKE tailscale: only "status --json" is part of this stand-in\n'); process.exit(1); }
process.stdout.write(fs.readFileSync(process.env.TIMMY_FAKE_TAILSCALE_JSON, 'utf8'));
