/**
 * Round R4 (H120): the decision settings ("Use Clef routing", "Allow cloud analysis", "Require review before dispatch",
 * thresholds, timeout) in decision.json beside workbench.json, and Clef's own config (<TIMMY_HOME>/decision/clef.json) with
 * its token kept out of every word. Each test file has its own TIMMY_HOME and TIMMY_SETTINGS_DIR (tests/isolation-setup.ts).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { settingsFile, timmyHome } from '../src/setup/home.js';
import {
  DECISION_SETTINGS_SCHEMA, DEFAULT_DECISION_SETTINGS, decisionSettingsPath, readSettings, saveSettings, SETTING_LABELS,
} from '../src/decision/settings.js';
import { clefConfigPath, readClefConfig, redactSecrets } from '../src/decision/config.js';
import { providerFromConfig } from '../src/decision/provider.js';
import { FAKE_ACCOUNT, FAKE_TOKEN, fakeTokenFile } from './fixtures/clef-omni/fake.js';

const env = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({ ...process.env, ...extra });

afterEach(() => {
  rmSync(decisionSettingsPath(env()), { force: true });
  rmSync(clefConfigPath(env()), { force: true });
});

describe('decision settings', () => {
  it('lives beside workbench.json, in the settings folder this file was given', () => {
    expect(decisionSettingsPath(env())).toBe(join(dirname(settingsFile(env())), 'decision.json'));
    expect(decisionSettingsPath(env()).startsWith(process.env.TIMMY_SETTINGS_DIR!)).toBe(true);
  });

  it('defaults: Clef off, cloud analysis off, review before dispatch on, 0.60/0.15, 8 s', () => {
    const r = readSettings(env());
    expect(r.state).toBe('none yet');
    expect(r.settings).toEqual({ useClef: false, allowCloudAnalysis: false, requireReview: true, thresholds: { minTop: 0.6, minMargin: 0.15 }, timeoutMs: 8000 });
    expect(r.settings).toEqual(DEFAULT_DECISION_SETTINGS);
    expect(r.useClefFrom).toBe('default');
  });

  it('names the three switches in plain words for the surfaces', () => {
    expect(SETTING_LABELS.map((s) => [s.key, s.label])).toEqual([
      ['useClef', 'Use decision-model routing'],
      ['allowCloudAnalysis', 'Allow cloud analysis'],
      ['requireReview', 'Require review before dispatch'],
    ]);
    for (const s of SETTING_LABELS) expect(s.about.length).toBeGreaterThan(10);
  });

  it('saves (0600, renamed into place) and reads back', () => {
    const want = { ...DEFAULT_DECISION_SETTINGS, useClef: true, thresholds: { minTop: 0.7, minMargin: 0.2 }, timeoutMs: 5000 };
    const s = saveSettings(want, env());
    expect(s.ok).toBe(true);
    const file = decisionSettingsPath(env());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(raw.schema).toBe(DECISION_SETTINGS_SCHEMA);
    expect(raw.schema).toBe('timmy.decision-settings/1');
    const r = readSettings(env());
    expect(r.state).toBe('saved');
    expect(r.settings).toEqual(want);
    expect(r.useClefFrom).toBe('saved');
    // the Workbench's own file is never written by this
    expect(existsSync(join(dirname(file), 'workbench.json'))).toBe(false);
  });

  it('TIMMY_CLEF=1|0 overrides "Use Clef routing" only, and never into the saved file', () => {
    saveSettings({ ...DEFAULT_DECISION_SETTINGS, useClef: false, requireReview: false }, env());
    const on = readSettings(env({ TIMMY_CLEF: '1' }));
    expect(on.settings.useClef).toBe(true);
    expect(on.settings.requireReview).toBe(false);
    expect(on.saved.useClef).toBe(false);
    expect(on.useClefFrom).toBe('environment');
    saveSettings({ ...DEFAULT_DECISION_SETTINGS, useClef: true }, env());
    const off = readSettings(env({ TIMMY_CLEF: '0' }));
    expect(off.settings.useClef).toBe(false);
    expect(off.useClefFrom).toBe('environment');
    expect(readSettings(env({ TIMMY_CLEF: 'yes' })).useClefFrom).toBe('saved');
  });

  it('an unreadable file or another schema reads as the defaults, said so', () => {
    const file = decisionSettingsPath(env());
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{ not json');
    const r = readSettings(env());
    expect(r.state).toBe('unreadable');
    expect(r.settings).toEqual(DEFAULT_DECISION_SETTINGS);
    writeFileSync(file, JSON.stringify({ schema: 'timmy.workbench-settings/1', useClef: true }));
    expect(readSettings(env()).state).toBe('unreadable');
    expect(readSettings(env()).settings.useClef).toBe(false);
  });

  it('thresholds or a timeout out of range in the file fall back to the defaults, with the problem named', () => {
    const file = decisionSettingsPath(env());
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ schema: DECISION_SETTINGS_SCHEMA, useClef: true, thresholds: { minTop: 3, minMargin: 0.1 }, timeoutMs: -5 }));
    const r = readSettings(env());
    expect(r.state).toBe('saved');
    expect(r.settings.useClef).toBe(true);
    expect(r.settings.thresholds).toEqual({ minTop: 0.6, minMargin: 0.15 });
    expect(r.settings.timeoutMs).toBe(8000);
    expect(r.problems.join('; ')).toMatch(/minTop must be above 0 and at most 1/);
    expect(r.problems.join('; ')).toMatch(/timeout/);
  });

  it('refuses to save thresholds or a timeout out of range, and leaves the file as it was', () => {
    saveSettings({ ...DEFAULT_DECISION_SETTINGS, useClef: true }, env());
    const before = readFileSync(decisionSettingsPath(env()), 'utf8');
    const bad = saveSettings({ ...DEFAULT_DECISION_SETTINGS, thresholds: { minTop: 0, minMargin: 0.1 } }, env());
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/minTop/);
    const bad2 = saveSettings({ ...DEFAULT_DECISION_SETTINGS, timeoutMs: 0 }, env());
    expect(bad2.ok).toBe(false);
    expect(readFileSync(decisionSettingsPath(env()), 'utf8')).toBe(before);
  });
});

describe('Clef config and its secrets', () => {
  const writeConfig = (body: unknown): void => {
    const file = clefConfigPath(env());
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
  };
  const secretsDir = (): string => mkdtempSync(join(tmpdir(), 'timmy-clef-secret-'));

  it('lives in <TIMMY_HOME>/decision/clef.json; none there means Clef is unavailable', () => {
    expect(clefConfigPath(env())).toBe(join(timmyHome(env()), 'decision', 'clef.json'));
    const r = readClefConfig(env());
    expect(r.state).toBe('none yet');
    const p = providerFromConfig(r);
    const d = p.describe();
    expect(d.available).toBe(false);
    expect(d.reason).toMatch(/clef\.json/);
  });

  it('transport "none" turns Clef off in its config', () => {
    writeConfig({ transport: 'none' });
    const r = readClefConfig(env());
    expect(r.state).toBe('off');
    expect(providerFromConfig(r).describe().available).toBe(false);
  });

  it('refuses a Workers AI config without an account id or token file, or with a relative token path', () => {
    writeConfig({ transport: 'workers-ai', token_file: '/tmp/x' });
    expect(readClefConfig(env())).toMatchObject({ state: 'invalid' });
    writeConfig({ transport: 'workers-ai', account_id: 'has spaces!', token_file: '/tmp/x' });
    expect(readClefConfig(env())).toMatchObject({ state: 'invalid' });
    writeConfig({ transport: 'workers-ai', account_id: FAKE_ACCOUNT });
    expect(readClefConfig(env())).toMatchObject({ state: 'invalid' });
    writeConfig({ transport: 'workers-ai', account_id: FAKE_ACCOUNT, token_file: 'relative/token' });
    expect(readClefConfig(env())).toMatchObject({ state: 'invalid' });
    writeConfig({ transport: 'carrier-pigeon' });
    expect(readClefConfig(env())).toMatchObject({ state: 'invalid' });
    writeFileSync(clefConfigPath(env()), 'nope');
    expect(readClefConfig(env())).toMatchObject({ state: 'unreadable' });
  });

  it('a Workers AI config is the paid, remote transport, and the account id is in no word it says', () => {
    const dir = secretsDir();
    writeConfig({ transport: 'workers-ai', account_id: FAKE_ACCOUNT, token_file: fakeTokenFile(dir) });
    const r = readClefConfig(env());
    expect(r.state).toBe('configured');
    const d = providerFromConfig(r).describe();
    expect(d).toMatchObject({ available: true, transport: 'workers-ai', endpoint: 'workers-ai-rest', model: '@cf/cloudflare/clef-omni', paid: true, local: false });
    expect(JSON.stringify(d)).not.toContain(FAKE_ACCOUNT);
    rmSync(dir, { recursive: true, force: true });
  });

  // R9 (H162): this said "free" for every SystemOne address (the pricing defect); free is now only what clef.json declares
  it('a SystemOne config: http only to this computer, https anywhere; names its model; free only as declared; local only on loopback', () => {
    writeConfig({ transport: 'systemone', systemone_url: 'http://systemone.example.com', model: 'clef-flash:latest' });
    expect(readClefConfig(env())).toMatchObject({ state: 'invalid' });
    writeConfig({ transport: 'systemone', systemone_url: 'https://user:pw@systemone.example.com', model: 'clef-flash:latest' });
    expect(readClefConfig(env())).toMatchObject({ state: 'invalid' });
    writeConfig({ transport: 'systemone', systemone_url: 'http://127.0.0.1:8181' });
    expect(readClefConfig(env())).toMatchObject({ state: 'invalid', why: expect.stringMatching(/systemone needs model/) });
    writeConfig({ transport: 'systemone', systemone_url: 'http://127.0.0.1:8181', model: 'clef-flash:latest' });
    const undeclared = providerFromConfig(readClefConfig(env())).describe();
    expect(undeclared).toMatchObject({ available: true, transport: 'systemone', endpoint: 'systemone-loopback', paid: true, local: true, model: 'clef-flash:latest', pricing: { kind: 'unknown' } });
    writeConfig({ transport: 'systemone', systemone_url: 'http://127.0.0.1:8181', model: 'clef-flash:latest', pricing: { free: 'local' } });
    const local = providerFromConfig(readClefConfig(env())).describe();
    expect(local).toMatchObject({ available: true, transport: 'systemone', endpoint: 'systemone-loopback', paid: false, local: true, model: 'clef-flash:latest', pricing: { kind: 'free-local' } });
    writeConfig({ transport: 'systemone', systemone_url: 'https://systemone.example.com/base/', model: 'd1-ultra' });
    const remote = providerFromConfig(readClefConfig(env())).describe();
    expect(remote).toMatchObject({ available: true, endpoint: 'systemone-remote', paid: true, local: false, pricing: { kind: 'unknown' } });
    expect(JSON.stringify(remote)).not.toContain('systemone.example.com');
  });

  it('redactSecrets takes the token and the account id out in every form', () => {
    const text = `Bearer ${FAKE_TOKEN} for /accounts/${FAKE_ACCOUNT}/ai and ${encodeURIComponent(FAKE_TOKEN)} and ${JSON.stringify(FAKE_ACCOUNT)} ok`;
    const out = redactSecrets(text, { token: FAKE_TOKEN, accountId: FAKE_ACCOUNT });
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).not.toContain(encodeURIComponent(FAKE_TOKEN));
    expect(out).not.toContain(FAKE_ACCOUNT);
    expect(out).toMatch(/ ok$/);
    expect(redactSecrets('nothing secret', {})).toBe('nothing secret');
  });
});
