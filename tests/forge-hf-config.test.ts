import { describe, it, expect } from 'vitest';
import { resolveHfCredentials, hfReadiness, redact } from '../src/forge/higgsfield/config.js';

function withHfEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env.HF_CREDENTIALS;
  try {
    if (value === undefined) delete process.env.HF_CREDENTIALS;
    else process.env.HF_CREDENTIALS = value;
    fn();
  } finally {
    if (prev === undefined) delete process.env.HF_CREDENTIALS;
    else process.env.HF_CREDENTIALS = prev;
  }
}

describe('higgsfield config', () => {
  it('resolves credentials from env only', () => {
    withHfEnv('kid:ksec', () => {
      expect(resolveHfCredentials()).toEqual({ keyId: 'kid', keySecret: 'ksec' });
    });
    withHfEnv(undefined, () => {
      expect(() => resolveHfCredentials()).toThrow(/HF_CREDENTIALS/);
    });
  });

  it('rejects malformed shapes (missing or trailing colon)', () => {
    withHfEnv(undefined, () => {
      expect(() => resolveHfCredentials()).toThrow(/HF_CREDENTIALS/);
    });
    withHfEnv('nocolon', () => {
      expect(() => resolveHfCredentials()).toThrow(/HF_CREDENTIALS/);
    });
    withHfEnv('kidonly:', () => {
      expect(() => resolveHfCredentials()).toThrow(/HF_CREDENTIALS/);
    });
  });

  it('redacts credentials in any stringified output', () => {
    withHfEnv('kid:ksec', () => {
      const r = hfReadiness();
      expect(JSON.stringify(r)).not.toContain('ksec');
      expect(JSON.stringify(r)).not.toContain('kid:ksec');
    });
  });

  it('redact() replaces the full credential and the bare secret', () => {
    withHfEnv('kid:ksec', () => {
      expect(redact('used kid:ksec to auth')).toBe('used [redacted] to auth');
      expect(redact('secret was ksec alone')).toBe('secret was [redacted] alone');
      expect(redact('nothing here')).toBe('nothing here');
    });
  });

  it('redact() is a no-op without env set', () => {
    withHfEnv(undefined, () => {
      expect(redact('ksec stays')).toBe('ksec stays');
    });
  });

  it('parses multi-colon secrets whole (kid:a:b → secret a:b)', () => {
    withHfEnv('kid:a:b', () => {
      expect(resolveHfCredentials()).toEqual({ keyId: 'kid', keySecret: 'a:b' });
    });
  });

  it('rejects a leading colon (empty keyId)', () => {
    withHfEnv(':sec', () => {
      expect(() => resolveHfCredentials()).toThrow(/HF_CREDENTIALS/);
    });
  });

  it('trims surrounding whitespace before parsing', () => {
    withHfEnv('  kid:ksec  ', () => {
      expect(resolveHfCredentials()).toEqual({ keyId: 'kid', keySecret: 'ksec' });
    });
  });

  it('redact() handles regex-special characters in the secret', () => {
    withHfEnv('kid:a.b*c(d', () => {
      const out = redact('token kid:a.b*c(d leaked and bare a.b*c(d too');
      expect(out).not.toContain('a.b*c(d');
      expect(out).toBe('token [redacted] leaked and bare [redacted] too');
    });
  });

  it('redact() removes a bare multi-colon secret fully (regression: no partial [redacted]:b)', () => {
    withHfEnv('kid:a:b', () => {
      const out = redact('used a:b as the secret');
      expect(out).toBe('used [redacted] as the secret');
      expect(out).not.toContain('a:b');
    });
  });

  it('readiness maps malformed shape to misconfigured and unset to needs_key', () => {
    withHfEnv('nocolon', () => {
      const r = hfReadiness();
      expect(r.status).toBe('misconfigured');
      expect(r.detail).toMatch(/HF_CREDENTIALS/);
    });
    withHfEnv(undefined, () => {
      const r = hfReadiness();
      expect(r.status).toBe('needs_key');
    });
  });

  it('readiness fails closed without credentials', () => {
    withHfEnv(undefined, () => {
      const r = hfReadiness();
      expect(r.status).toBe('needs_key');
    });
  });

  it('readiness is ready with credentials and never leaks the secret', () => {
    withHfEnv('kid:ksec', () => {
      const r = hfReadiness();
      expect(r.status).toBe('ready');
      expect(r.detail).not.toContain('ksec');
    });
  });
});


describe('credential boundary regressions', () => {
  it.each(['\r', '\n', '\t', '\x7f', '\x85'])('refuses control %j before readiness', (control) => {
    for (const value of [`kid:sec${control}ret`, `${control}kid:secret`, `kid:secret${control}`]) {
      withHfEnv(value, () => {
        expect(hfReadiness().status).toBe('misconfigured');
        expect(() => resolveHfCredentials()).toThrow(/HF_CREDENTIALS/);
      });
    }
  });

  it('redacts escaped JSON values and the normalized credential', () => {
    const secret = 'fake-"quoted\\secret';
    withHfEnv(`  fake-id:${secret}  `, () => {
      const result = redact(JSON.stringify({ credential: `fake-id:${secret}`, secret }));
      expect(JSON.parse(result)).toEqual({ credential: '[redacted]', secret: '[redacted]' });
    });
  });
});


describe('readiness privacy', () => {
  it('reports presence without publishing credential identifiers or secrets', () => {
    withHfEnv('private-test-key-id:private-test-key-secret', () => {
      const readiness = hfReadiness();
      expect(readiness).toEqual({ status: 'ready', detail: 'credentials resolved from env', endpoints: 0 });
      const serialized = JSON.stringify(readiness);
      expect(serialized).not.toContain('private-test-key-id');
      expect(serialized).not.toContain('private-test-key-secret');
      expect(serialized).not.toContain('priv');
    });
  });
});
