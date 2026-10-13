/**
 * One test for "is this key set?", shared by the tools, NEEDS YOU and the capability view, so they
 * never disagree about a key (round R1 review). A key that is empty, or still a template's placeholder
 * ("paste_your_key_here", "<your key>", "your-key"), is not set.
 */
const PLACEHOLDER = /paste_your|<your|^your[_-]/i;

export const keyMissing = (value: string | null | undefined): boolean => !value || PLACEHOLDER.test(value);

export const keySet = (value: string | null | undefined): boolean => !keyMissing(value);

/**
 * Environment names that hold a secret, by the words secret-holding names use (round R1 review: PASS,
 * PWD, PAT, SALT and CONN were missing). Wide on purpose: hiding a harmless value costs little.
 */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|PWD|CREDENTIAL|PRIVATE|COOKIE|SESSION|AUTH|DSN|WEBHOOK|SALT|SIGNATURE|CONN|CERT/i;
const PAT_NAME = /(^|_)PAT($|_)/i;

export const secretEnvName = (name: string): boolean => SECRET_NAME.test(name) || PAT_NAME.test(name);

/**
 * Values that are secrets whatever their name: credentials inside a URL (postgres://user:pw@host), a
 * private key block, and the token shapes of the common services. Built from parts, so this file is
 * not itself mistaken for a key by a scanner.
 */
const SECRET_VALUE: RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s@]+@/i,
  new RegExp(['-----BEGIN [A-Z ]*', 'PRIVATE KEY'].join('')),
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

export const secretEnvValue = (value: string): boolean => SECRET_VALUE.some((re) => re.test(value));
