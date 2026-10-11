/**
 * Round R4 (helper H90): everything that reaches an ssh, ssh-keyscan or ssh-keygen argument list is checked here first.
 * Each check returns null when the value may be used, or the words that say why not. Nothing reaches a shell on this
 * side: Timmy runs every program with an argument array.
 */

/** A device's id: a slug (lowercase letters, digits and dashes), at most 32 characters. */
export const DEVICE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A remote job's id: "r" and 8 hex digits (the job readers' own ids are "j" and 6). */
export const REMOTE_JOB_ID = /^r[0-9a-f]{8}$/;
/** A host key's SHA256 fingerprint as OpenSSH writes it: unpadded base64 of 32 bytes (43 characters). */
export const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
/** The name a device's confirmed key is kept under in Timmy's known_hosts (ssh -o HostKeyAlias): its own, per device. */
export const hostAlias = (id: string): string => `timmy-${id}`;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function checkId(id: string): string | null {
  return DEVICE_ID.test(id) ? null : `the id ${JSON.stringify(id)} is not a slug: lowercase letters, digits and dashes, starting with a letter or digit, at most 32`;
}

export function checkName(name: string): string | null {
  if (CONTROL.test(name)) return 'the name holds a control character';
  if (name.length > 64) return 'the name is longer than 64 characters';
  return null;
}

/**
 * A hostname, a tailnet name or an IP address: letters, digits, dots, dashes, underscores and colons (IPv6), not
 * starting with "-" (ssh would read it as an option) or "."; no whitespace, control character, "@" (the user goes
 * apart), "%" or brackets.
 */
export function checkAddress(address: string): string | null {
  if (!address) return 'the address is empty';
  if (address.startsWith('-')) return `the address ${JSON.stringify(address)} starts with "-", which ssh would read as an option`;
  if (/\s/.test(address) || CONTROL.test(address)) return 'the address holds whitespace or a control character';
  if (address.length > 253) return 'the address is longer than 253 characters';
  if (!/^[A-Za-z0-9_:][A-Za-z0-9._:-]*$/.test(address)) return `the address ${JSON.stringify(address)} is not a hostname or an IP address (letters, digits, ".", "-", "_" and ":" only)`;
  return null;
}

/** A login name: no leading "-", no whitespace or control characters; letters, digits, ".", "_", "-", "@" and "\\" (a Windows domain). */
export function checkUser(user: string): string | null {
  if (!user) return 'the user is empty';
  if (user.startsWith('-')) return `the user ${JSON.stringify(user)} starts with "-", which ssh would read as an option`;
  if (/\s/.test(user) || CONTROL.test(user)) return 'the user holds whitespace or a control character';
  if (user.length > 64) return 'the user is longer than 64 characters';
  if (!/^[A-Za-z0-9._@\\-]+$/.test(user)) return `the user ${JSON.stringify(user)} holds a character a login name does not (letters, digits, ".", "_", "-", "@" and "\\" only)`;
  return null;
}

export function checkPort(port: number): string | null {
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? null : `the port ${String(port)} is not a whole number from 1 to 65535`;
}

/** "agent", or a key file's path: absolute or from ~, with nothing ssh would expand in it (%, ${) and no quote or control character. */
export function checkIdentity(identity: string): string | null {
  if (identity === 'agent') return null;
  if (!identity) return 'the key file is empty';
  if (!(identity.startsWith('/') || identity.startsWith('~/'))) return `the key file ${JSON.stringify(identity)} is not an absolute path or one from ~`;
  if (CONTROL.test(identity)) return 'the key file\'s path holds a control character';
  if (/[%"]|\$\{/.test(identity)) return 'the key file\'s path holds "%", "${" or a quote, which ssh would expand or misread';
  if (identity.endsWith('.pub')) return 'that is a public key (.pub): name the private key\'s file; Timmy passes its name to ssh and never reads it';
  return null;
}

/**
 * The remote folder for Timmy's job records: relative to the remote home (the default ".timmy-connect/jobs"), or absolute
 * ("/…" or "C:/…"); letters, digits, ".", "_", "-" and "/" only; no ".." part and no empty part.
 */
export function checkRemoteDir(dir: string): string | null {
  if (!dir) return 'the remote folder is empty';
  const body = /^[A-Za-z]:\//.test(dir) ? dir.slice(3) : dir.startsWith('/') ? dir.slice(1) : dir;
  if (!/^[A-Za-z0-9._/-]+$/.test(body) || body.startsWith('-')) return `the remote folder ${JSON.stringify(dir)} holds a character other than letters, digits, ".", "_", "-" and "/"`;
  const parts = body.split('/');
  if (parts.some((s) => s === '' || s === '..' || s === '.')) return `the remote folder ${JSON.stringify(dir)} has an empty, "." or ".." part`;
  return null;
}

/**
 * A path inside a job's folder, for fetch: relative, with "/" between parts, no "..", "." or empty part, no backslash and no
 * control character. Symbolic links are refused on the device itself, at every part of the path.
 */
export function checkJobPath(rel: string): string | null {
  if (!rel) return 'the path is empty';
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.startsWith('~')) return `${JSON.stringify(rel)} is absolute: give a path inside the job's folder`;
  if (rel.includes('\\')) return `${JSON.stringify(rel)} holds a backslash: write the path with "/"`;
  if (CONTROL.test(rel)) return 'the path holds a control character';
  const parts = rel.split('/');
  if (parts.some((s) => s === '..')) return `${JSON.stringify(rel)} has a ".." part: only paths inside the job's folder can be fetched`;
  if (parts.some((s) => s === '' || s === '.')) return `${JSON.stringify(rel)} has an empty or "." part`;
  if (rel.length > 1024) return 'the path is longer than 1024 characters';
  return null;
}
