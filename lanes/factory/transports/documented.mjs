// lanes/factory/transports/documented.mjs — the Omma agent API, fail-closed (ORDER factory-f1d0 C2a/C2b).
//
// The only documented programmatic surface is the `omma` agent skill named on the API-keys settings
// page (npx skills add https://github.com/splinetool/omma-agent-skills --skill omma) and
// https://omma.build/docs/agents. Neither is published, so there is no contract to admit, `omma.tools`
// is unsealed, and this transport refuses every send. Routes scraped from the web client are not a
// contract and are never replayed. When the skill lands, admit it (omma.tools.json + `omma.tools`
// seal) and implement `send` from that contract only.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'documented';
export const status = 'GENERATED';
export class OmmaContractUnavailable extends Error { constructor() { super('omma.tools unsealed: the documented Omma agent API (skill splinetool/omma-agent-skills, omma.build/docs/agents) is not published; refusing to send'); this.code = 'OMMA_CONTRACT_UNAVAILABLE'; } }

/** True when the operator's key is present; the value is never read into a log or a result. */
export function keyPresent(root) {
  const f = join(root, '.timmy', 'private', 'omma.env');
  return existsSync(f) && /^OMMA_API_KEY=\S+/m.test(readFileSync(f, 'utf8'));
}
export function contractPresent(root) { return existsSync(join(root, 'lanes', 'factory', 'omma.tools.json')); }

// eslint-disable-next-line no-unused-vars
export async function send(_request, { root }) {
  if (!contractPresent(root)) throw new OmmaContractUnavailable();
  throw new Error('omma.tools.json is present but no send is implemented from it yet: admit the contract first (C2a)');
}
