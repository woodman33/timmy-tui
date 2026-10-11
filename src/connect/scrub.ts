/**
 * Round R4 (helper H90): what a device sends back (a job's output lines, ssh's own words) is scrubbed before Timmy stores
 * or prints it: private-key blocks and the token shapes src/utils/redact.ts redactString knows, and more (GitHub, Hugging
 * Face, Anthropic, AWS, Tailscale, Slack, JWT). A fetched file is the one exception: it is kept byte for byte, since its
 * sha256 is checked against the device's.
 */
import { scrubHomes } from '../utils/home-scrub.js';
import { redactString } from '../utils/redact.js';

/** A whole private-key block, or one cut off at the end of the text (an output tail can end inside one). */
const KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
/** A block's end whose beginning was cut off before the text began, with the key lines just above it. */
const KEY_END = /(?:^[A-Za-z0-9+/=]{16,}\r?\n)*^-----END [A-Z0-9 ]*PRIVATE KEY-----/gm;
/** A line that is only base64 of a key line's length, in mixed case (a key block's middle, seen alone in a tail). */
const KEY_LINE = /^(?=[A-Za-z0-9+/=]*[A-Z])(?=[A-Za-z0-9+/=]*[a-z])[A-Za-z0-9+/=]{60,76}$/gm;
const TOKENS: Array<[RegExp, string]> = [
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bhf_[A-Za-z0-9]{20,}\b/g, '[REDACTED_HF_TOKEN]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED_ANTHROPIC_KEY]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\btskey-[A-Za-z0-9-]{10,}/g, '[REDACTED_TAILSCALE_KEY]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED_SLACK_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
];

/**
 * Text from a device with private-key blocks and token shapes taken out: a whole block, a block cut off at either end of
 * the text, and a lone line that looks like a key block's middle (a tail of output can start or end inside a block).
 */
export function scrubRemote(text: string): string {
  if (!text) return text;
  let out = text.replace(KEY_BLOCK, '[REDACTED_PRIVATE_KEY]').replace(KEY_END, '[REDACTED_PRIVATE_KEY]').replace(KEY_LINE, '[REDACTED_KEY_LINE]');
  for (const [rx, word] of TOKENS) out = out.replace(rx, word);
  return redactString(out);
}

/**
 * Text Timmy prints or stores: scrubbed as above, and every path under this account's home written from "~" (as the rest
 * of Timmy writes it).
 */
export function scrubShown(text: string): string {
  return scrubHomes(scrubRemote(text));
}
