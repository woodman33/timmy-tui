/**
 * R11 round 4 (H173, contract C1): the companion's identity — what the server verifies, and what a user may reach.
 *
 * WHAT IS REAL HERE: the product's verifier (src/companion/identity/session.ts: jose, RS256, the claims), its configuration
 * reader, its scope (the user's own folders) and its middleware over real HTTP on 127.0.0.1 (the companion server).
 * WHAT STANDS IN: the instance's key pair. Clerk signs session tokens with the instance's RSA key, whose PUBLIC half the
 * operator sets as CLERK_JWT_KEY. Here the test makes an RSA pair at run time (generateKeyPairSync), sets ITS public PEM as
 * CLERK_JWT_KEY and mints tokens with its private half in the shape Clerk mints them (sub user_…, sid, exp, nbf, azp,
 * iss). That is the product's verifier being exercised on real RS256 signatures, not a mock login: no Clerk account exists,
 * nothing signs in, no network is used. A real sign-up against a Clerk instance is NOT done here, anywhere.
 * The FAKE publishable key names a host under .invalid, so nothing could reach it; the FAKE JWKS server is on 127.0.0.1.
 */
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectSrcFor, frontendApiOf, IDENTITY_ENV, identityConfig, pageIdentity, pemOf } from '../src/companion/identity/config.js';
import { forgetKeys, OPERATOR_ID, OPERATOR_WORDS, operatorUser, originsOf, SESSION_WORDS, USER_ID, verifySession } from '../src/companion/identity/session.js';
import { verifyHello } from '../src/companion/identity/middleware.js';
import { projectId } from '../src/project/index.js';
import { CLERK_SCRIPT, findClerkDist } from '../src/companion/identity/routes.js';
import { createUserProject, DEFAULT_PROJECT, isOwnedRoot, userEnv, userHome, userProjectFor, userProjects } from '../src/companion/identity/scope.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';

// ── the FAKE instance: a key pair made now; its public PEM is CLERK_JWT_KEY ────────────────────────────────────────────
const HOST = 'fake-identity.clerk.accounts.invalid';
const PK = `pk_test_${Buffer.from(`${HOST}$`).toString('base64')}`;
const FRONTEND = `https://${HOST}`;
const ORIGIN = 'http://127.0.0.1:4494';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const ENV = { [IDENTITY_ENV.publishable]: PK, [IDENTITY_ENV.jwtKey]: PEM };
const USER_A = 'user_2abcDEF0123456789';
const USER_B = 'user_2zyxWVU9876543210';

interface Mint { sub?: string; sid?: string; exp?: number; nbf?: number; azp?: string | null; iss?: string | null; key?: KeyObject; extra?: Record<string, unknown> }
/** A token in the shape Clerk mints a session token (60 s, azp the page's origin, iss the frontend API). */
async function mint(o: Mint = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { ...(o.extra ?? {}) };
  if (o.sub !== undefined) claims.sub = o.sub; else claims.sub = USER_A;
  if (o.sid !== undefined) claims.sid = o.sid; else claims.sid = 'sess_2abcSESSION0123456';
  if (o.azp !== null) claims.azp = o.azp ?? ORIGIN;
  if (o.iss !== null) claims.iss = o.iss ?? FRONTEND;
  const jwt = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'ins_fake_kid' }).setIssuedAt(now).setExpirationTime(o.exp ?? now + 60);
  if (o.nbf !== undefined) jwt.setNotBefore(o.nbf);
  return jwt.sign(o.key ?? pair.privateKey);
}

describe('identityConfig: configured only when the publishable key and one verifier are set (C1)', () => {
  it('names the exact missing env names, and signs nothing in without them', () => {
    const none = identityConfig({});
    expect(none.configured).toBe(false);
    expect(none.verifier).toBe('none');
    expect(none.needs).toEqual([IDENTITY_ENV.publishable, IDENTITY_ENV.jwtKey]);
    expect(none.words).toContain('not configured');
    expect(none.words).toContain(IDENTITY_ENV.publishable);
    expect(none.words).toContain(IDENTITY_ENV.jwtKey);
    expect(none.words).toContain(IDENTITY_ENV.secretKey);
    expect(none.words).toContain('CLERK_PUBLISHABLE_KEY and CLERK_JWT_KEY (or CLERK_SECRET_KEY)');
    expect(none.words).toContain('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is also read');
    const half = identityConfig({ [IDENTITY_ENV.publishable]: PK });
    expect(half.configured).toBe(false);
    expect(half.needs).toEqual([IDENTITY_ENV.jwtKey]);
    expect(half.frontendApi).toBe(FRONTEND);
  });
  it('derives the frontend API from the key\'s shape and never asks anyone', () => {
    expect(frontendApiOf(PK)).toBe(FRONTEND);
    expect(frontendApiOf(`pk_live_${Buffer.from('clerk.example.com$').toString('base64')}`)).toBe('https://clerk.example.com');
    expect(frontendApiOf('pk_test_notbase64!!')).toBeNull();
    expect(frontendApiOf('sk_test_abc')).toBeNull();
    expect(frontendApiOf(`pk_test_${Buffer.from('not a host$').toString('base64')}`)).toBeNull();
    const bad = identityConfig({ [IDENTITY_ENV.publishable]: 'pk_test_??', [IDENTITY_ENV.jwtKey]: PEM });
    expect(bad.configured).toBe(false);
    expect(bad.needs).toEqual([IDENTITY_ENV.publishable]);
    expect(bad.words).toContain('not a Clerk publishable key');
  });
  it('is configured with the PEM (no network), and with the secret key alone it names the JWKS', () => {
    const pem = identityConfig(ENV);
    expect(pem.configured).toBe(true);
    expect(pem.verifier).toBe('pem');
    expect(pem.needs).toEqual([]);
    expect(pem.jwtKey).toContain('BEGIN PUBLIC KEY');
    expect(pem.words).toContain('no network');
    expect(connectSrcFor(pem)).toBe(` ${FRONTEND}`);
    const secret = identityConfig({ [IDENTITY_ENV.publishable]: PK, [IDENTITY_ENV.secretKey]: 'sk_test_FAKE_not_a_real_secret_value' });
    expect(secret.configured).toBe(true);
    expect(secret.verifier).toBe('jwks');
    expect(secret.jwks).toBe(`${FRONTEND}/.well-known/jwks.json`);
    expect(secret.secretKeySet).toBe(true);
    expect(JSON.stringify(secret)).not.toContain('sk_test_FAKE');
    const alt = identityConfig({ [IDENTITY_ENV.publishableAlt]: PK, [IDENTITY_ENV.jwtKey]: PEM.replace(/\n/g, '\\n') });
    expect(alt.configured).toBe(true);
    expect(connectSrcFor(identityConfig({}))).toBe('');
  });
  it('the page is told the public part only: never the PEM, never whether a secret is set', () => {
    const page = pageIdentity(identityConfig(ENV));
    expect(page).toEqual({ configured: true, publishableKey: PK, frontendApi: FRONTEND, needs: [], words: expect.any(String) });
    expect(JSON.stringify(page)).not.toContain('PUBLIC KEY');
    expect(pemOf(PEM.replace(/\n/g, '\\n'))).toBe(PEM.trim());
    expect(pemOf(PEM.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, ''))).toContain('BEGIN PUBLIC KEY');
    expect(pemOf('garbage')).toBeNull();
    expect(pemOf(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string)).toBeNull();
  });
});

describe('verifySession: the product\'s RS256 verifier on tokens minted with the test\'s own pair (C1)', () => {
  const cfg = identityConfig(ENV);
  const origins = [ORIGIN];
  it('a valid token names the user and the session; a template\'s username and email are carried', async () => {
    const r = await verifySession(await mint(), cfg, { origins });
    expect(r).toEqual({ ok: true, user: { id: USER_A, sessionId: 'sess_2abcSESSION0123456' } });
    const named = await verifySession(await mint({ extra: { username: 'ada', email: 'ada@example.com' } }), cfg, { origins });
    expect(named).toEqual({ ok: true, user: { id: USER_A, sessionId: 'sess_2abcSESSION0123456', username: 'ada', email: 'ada@example.com' } });
    expect(USER_ID.test(USER_A)).toBe(true);
  });
  it('expired, not yet valid (beyond 5 s), another key, no sub, a sub that is not user_…, a wrong azp: each refused with words', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verifySession(await mint({ exp: now - 30 }), cfg, { origins })).toEqual({ ok: false, why: SESSION_WORDS.expired });
    expect(await verifySession(await mint({ exp: now - 3 }), cfg, { origins })).toMatchObject({ ok: true }); // within the leeway
    expect(await verifySession(await mint({ nbf: now + 30 }), cfg, { origins })).toEqual({ ok: false, why: SESSION_WORDS.notYet });
    expect(await verifySession(await mint({ nbf: now + 3 }), cfg, { origins })).toMatchObject({ ok: true });
    expect(await verifySession(await mint({ key: other.privateKey }), cfg, { origins })).toEqual({ ok: false, why: SESSION_WORDS.signature });
    expect(await verifySession(await mint({ sub: '' }), cfg, { origins })).toMatchObject({ ok: false, why: expect.stringContaining('Refused') });
    expect(await verifySession(await mint({ sub: 'alice' }), cfg, { origins })).toEqual({ ok: false, why: SESSION_WORDS.badSubject });
    expect(await verifySession(await mint({ sub: 'user_clerk_timmy_33a1' }), cfg, { origins })).toEqual({ ok: false, why: SESSION_WORDS.badSubject });
    expect(await verifySession(await mint({ sid: '' }), cfg, { origins })).toMatchObject({ ok: false, why: expect.stringContaining('Refused') });
    expect(await verifySession(await mint({ azp: 'http://evil.example.com' }), cfg, { origins })).toEqual({ ok: false, why: SESSION_WORDS.badParty });
    expect(await verifySession(await mint({ azp: null }), cfg, { origins })).toMatchObject({ ok: true }); // azp absent: not checked
    expect(await verifySession(await mint({ azp: 'http://localhost:4494' }), cfg, { origins: originsOf('127.0.0.1:4494') })).toMatchObject({ ok: true });
    expect(await verifySession(await mint({ iss: 'https://another.clerk.accounts.invalid' }), cfg, { origins })).toEqual({ ok: false, why: SESSION_WORDS.badIssuer });
  });
  it('nothing but a JWT of the instance\'s is even parsed; not configured, nothing verifies; the token is never in the words', async () => {
    const tok = await mint();
    expect(await verifySession(undefined, cfg)).toEqual({ ok: false, why: SESSION_WORDS.absent });
    expect(await verifySession('', cfg)).toEqual({ ok: false, why: SESSION_WORDS.absent });
    expect(await verifySession(42, cfg)).toEqual({ ok: false, why: SESSION_WORDS.shape });
    expect(await verifySession('not.a.jwt!', cfg)).toEqual({ ok: false, why: SESSION_WORDS.shape });
    expect(await verifySession({ token: tok }, cfg)).toEqual({ ok: false, why: SESSION_WORDS.shape });
    const unsigned = `${tok.split('.')[0]}.${tok.split('.')[1]}.AAAA`;
    const r = await verifySession(unsigned, cfg, { origins });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(tok.split('.')[1]);
    expect(await verifySession(tok, identityConfig({}), { origins })).toEqual({ ok: false, why: SESSION_WORDS.notConfigured });
    // a symmetric signature (HS256) is not how Clerk signs: refused, whatever it says
    const hs = await new SignJWT({ sub: USER_A, sid: 'sess_x1234567890' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode('a-shared-secret-of-32-bytes-or-more'));
    expect((await verifySession(hs, cfg, { origins })).ok).toBe(false);
  });
  it('with only CLERK_SECRET_KEY: the JWKS fetched once from a FAKE on 127.0.0.1 and kept; no network → refused with words', async () => {
    forgetKeys();
    const jwk = await exportJWK(pair.publicKey);
    let fetches = 0;
    const jwks: Server = createServer((_req, res) => { fetches++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ keys: [{ ...jwk, kid: 'ins_fake_kid', use: 'sig', alg: 'RS256' }] })); });
    await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
    const port = (jwks.address() as { port: number }).port;
    const secretCfg = identityConfig({ [IDENTITY_ENV.publishable]: PK, [IDENTITY_ENV.secretKey]: 'sk_test_FAKE_not_a_real_secret_value' });
    const address = `http://127.0.0.1:${port}/.well-known/jwks.json`;
    try {
      expect(await verifySession(await mint(), secretCfg, { origins, jwks: address })).toMatchObject({ ok: true, user: { id: USER_A } });
      expect(await verifySession(await mint(), secretCfg, { origins, jwks: address })).toMatchObject({ ok: true });
      expect(fetches).toBe(1);
      expect(await verifySession(await mint({ key: other.privateKey }), secretCfg, { origins, jwks: address })).toMatchObject({ ok: false });
    } finally { await new Promise<void>((r) => jwks.close(() => r())); }
    // the network is not there: a port nothing listens on
    forgetKeys();
    const gone = await verifySession(await mint(), secretCfg, { origins, jwks: `http://127.0.0.1:${port}/.well-known/jwks.json` });
    expect(gone).toEqual({ ok: false, why: SESSION_WORDS.jwksUnreachable });
    forgetKeys();
  });
});

describe('scope: a user\'s own corner, and nothing outside it (C1)', () => {
  let box = '';
  let base: Record<string, string | undefined>;
  beforeAll(() => {
    box = realpathSync(mkdtempSync(join(tmpdir(), 'h173-scope-')));
    base = { TIMMY_HOME: join(box, 'home'), OPENROUTER_API_KEY: 'FAKE-openrouter-key-of-the-operator', OLLAMA_API_KEY: 'FAKE-ollama-key', TIMMY_REPO: '/somewhere' };
  });
  afterAll(() => { rmSync(box, { recursive: true, force: true }); });
  it('userEnv puts the home, settings, MCP home and private folder under users/<id>, 0700, and drops the operator\'s keys', () => {
    const env = userEnv({ id: USER_A }, base);
    const home = join(box, 'home', 'users', USER_A);
    expect(env.TIMMY_HOME).toBe(home);
    expect(env.TIMMY_SETTINGS_DIR).toBe(join(home, 'settings'));
    expect(env.TIMMY_MCP_HOME).toBe(join(home, 'mcp'));
    expect(env.TIMMY_PRIVATE_DIR).toBe(join(home, 'private'));
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.OLLAMA_API_KEY).toBeUndefined();
    expect(env.TIMMY_REPO).toBe('/somewhere'); // everything else passes through
    expect(userHome({ id: USER_A }, base)).toBe(home);
    for (const d of [home, join(home, 'settings'), join(home, 'mcp'), join(home, 'private'), join(home, 'projects'), join(home, 'state')]) {
      expect(statSync(d).isDirectory()).toBe(true);
      expect(statSync(d).mode & 0o777).toBe(0o700);
    }
    expect(statSync(join(box, 'home', 'users')).mode & 0o777).toBe(0o700);
    // the base is not changed
    expect(base.TIMMY_HOME).toBe(join(box, 'home'));
    expect(base.OPENROUTER_API_KEY).toBeDefined();
  });
  it('refuses any id that is not Clerk\'s user_… shape, and never makes a folder for it', () => {
    for (const bad of ['alice', 'user_clerk_timmy_33a1', '../x', 'user_', '', 'user_../../etc']) {
      expect(() => userEnv({ id: bad }, base)).toThrow(/user_/);
      expect(() => userHome({ id: bad }, base)).toThrow();
    }
    expect(isOwnedRoot({ id: 'alice' }, join(box, 'home', 'users', USER_A, 'projects', 'untitled'), base)).toBe(false);
  });
  it('userProjects: the default made and registered when none; folders under projects/ and registry entries there; a registry entry leading outside ignored', () => {
    const env = userEnv({ id: USER_A }, base);
    const home = env.TIMMY_HOME!;
    const own = userProjects({ id: USER_A }, env);
    expect(own.registry).toBe(join(home, 'projects.json'));
    expect(own.roots).toEqual([realpathSync(join(home, 'projects', DEFAULT_PROJECT.folder))]);
    expect(own.default).toBe(own.roots[0]);
    expect(statSync(own.roots[0]).mode & 0o777).toBe(0o700);
    const reg = JSON.parse(readFileSync(own.registry, 'utf8')) as { projects: { name: string; path: string }[] };
    expect(reg.projects[0]).toMatchObject({ name: DEFAULT_PROJECT.name });
    // another folder by hand, and a registry entry that leads to user B's home: the folder counts, the entry does not
    mkdirSync(join(home, 'projects', 'film'));
    const envB = userEnv({ id: USER_B }, base);
    const bRoot = userProjects({ id: USER_B }, envB).roots[0];
    writeFileSync(own.registry, JSON.stringify({ projects: [...reg.projects, { name: 'theirs', path: bRoot }, { name: 'root', path: '/' }, { name: 'relative', path: 'projects/film' }] }));
    const again = userProjects({ id: USER_A }, env);
    expect(again.roots).toEqual([realpathSync(join(home, 'projects', 'film')), realpathSync(join(home, 'projects', DEFAULT_PROJECT.folder))]);
    expect(again.roots).not.toContain(bRoot);
    // the active project, when it is a root, is the default
    writeFileSync(join(home, 'state', 'active-project.json'), JSON.stringify({ name: 'film', root: join(home, 'projects', 'film') }));
    expect(userProjects({ id: USER_A }, env).default).toBe(realpathSync(join(home, 'projects', 'film')));
    expect(() => userProjects({ id: USER_A }, base)).toThrow(/userEnv/); // the base env is not a user's
  });
  it('isOwnedRoot: a real path under one of the user\'s roots; /, the base home, another user\'s home and a link out refused', () => {
    const env = userEnv({ id: USER_A }, base);
    const home = env.TIMMY_HOME!;
    const film = join(home, 'projects', 'film');
    mkdirSync(join(film, 'shots'), { recursive: true });
    expect(isOwnedRoot({ id: USER_A }, film, env)).toBe(true);
    expect(isOwnedRoot({ id: USER_A }, join(film, 'shots'), env)).toBe(true);
    expect(isOwnedRoot({ id: USER_A }, `${film}/`, env)).toBe(true);
    expect(isOwnedRoot({ id: USER_A }, '/', env)).toBe(false);
    expect(isOwnedRoot({ id: USER_A }, join(box, 'home'), env)).toBe(false);
    expect(isOwnedRoot({ id: USER_A }, home, env)).toBe(false);
    expect(isOwnedRoot({ id: USER_A }, join(home, 'projects'), env)).toBe(false);
    expect(isOwnedRoot({ id: USER_A }, join(box, 'home', 'users', USER_B, 'projects', DEFAULT_PROJECT.folder), env)).toBe(false);
    expect(isOwnedRoot({ id: USER_A }, join(film, 'nowhere'), env)).toBe(false);
    expect(isOwnedRoot({ id: USER_A }, 'projects/film', env)).toBe(false);
    expect(isOwnedRoot({ id: USER_A }, `${film}/../..`, env)).toBe(false);
    // a link inside the user's projects that points out (to the box, outside every user): refused through the link and as a root
    const outside = join(box, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(home, 'projects', 'escape'));
    expect(lstatSync(join(home, 'projects', 'escape')).isSymbolicLink()).toBe(true);
    expect(isOwnedRoot({ id: USER_A }, join(home, 'projects', 'escape'), env)).toBe(false);
    expect(userProjects({ id: USER_A }, env).roots.some((r) => r.endsWith('escape') || r === realpathSync(outside))).toBe(false);
    symlinkSync(outside, join(film, 'link-out'));
    expect(isOwnedRoot({ id: USER_A }, join(film, 'link-out'), env)).toBe(false);
  });
  it('userProjectFor: by id, by an owned path, the default; another user\'s id or an outside path → null; createUserProject under the user', () => {
    const env = userEnv({ id: USER_A }, base);
    const own = userProjects({ id: USER_A }, env);
    const def = userProjectFor({ id: USER_A }, env);
    expect(def).toMatchObject({ root: own.default, chosen: true });
    expect(def!.id).toMatch(/^[0-9a-f]{16}$/);
    expect(userProjectFor({ id: USER_A }, env, def!.id)).toEqual(def);
    expect(userProjectFor({ id: USER_A }, env, own.roots[1])).toMatchObject({ name: DEFAULT_PROJECT.name });
    expect(userProjectFor({ id: USER_A }, env, '/')).toBeNull();
    expect(userProjectFor({ id: USER_A }, env, 'deadbeefdeadbeef')).toBeNull();
    const envB = userEnv({ id: USER_B }, base);
    const bDefault = userProjectFor({ id: USER_B }, envB)!;
    expect(userProjectFor({ id: USER_A }, env, bDefault.id)).toBeNull();
    expect(userProjectFor({ id: USER_A }, env, bDefault.root)).toBeNull();
    const made = createUserProject({ id: USER_A }, env, 'Short Film');
    expect(made).toMatchObject({ name: 'Short Film', root: join(env.TIMMY_HOME!, 'projects', 'short-film') });
    expect(createUserProject({ id: USER_A }, env, 'Short Film')).toEqual({ error: expect.stringContaining('already exists') });
    expect(createUserProject({ id: USER_A }, env, '../../etc')).toEqual({ error: expect.stringContaining('letters') });
    expect(userProjects({ id: USER_A }, env).roots).toContain((made as { root: string }).root);
  });
});

describe('scope: the OPERATOR principal — the companion as it always was (the lead\'s 21:48 ruling)', () => {
  let box = '';
  beforeAll(() => { box = realpathSync(mkdtempSync(join(tmpdir(), 'h173-operator-'))); });
  afterAll(() => { rmSync(box, { recursive: true, force: true }); });
  it('userEnv(operator, base) IS base (keys kept, nothing made); the home is the Timmy home; the projects are the follower\'s: fixed, else active, else here; plus <home>/projects', () => {
    const home = join(box, 'home'); mkdirSync(join(home, 'projects', 'studio'), { recursive: true }); mkdirSync(join(box, 'repo'));
    const op = operatorUser();
    expect(op).toEqual({ id: OPERATOR_ID, operator: true });
    expect(USER_ID.test(OPERATOR_ID)).toBe(false); // no token can name the operator (badSubject)
    const base = { TIMMY_HOME: home, OPENROUTER_API_KEY: 'FAKE-key-of-the-operator', TIMMY_REPO: join(box, 'repo') };
    expect(userEnv(op, base)).toBe(base);
    expect(userHome(op, base)).toBe(home);
    expect(existsSync(join(home, 'users'))).toBe(false);
    // fixed (TIMMY_REPO) first
    const fixed = userProjects(op, base);
    expect(fixed.roots).toEqual([join(box, 'repo'), join(home, 'projects', 'studio')].sort());
    expect(fixed.default).toBe(join(box, 'repo'));
    expect(fixed.registry).toBe(join(home, 'projects.json'));
    expect(userProjectFor(op, base)).toEqual({ id: projectId(join(box, 'repo')), name: 'repo', root: join(box, 'repo'), chosen: true });
    expect(userProjectFor(op, base, projectId(join(home, 'projects', 'studio')))!.root).toBe(join(home, 'projects', 'studio'));
    expect(isOwnedRoot(op, join(box, 'repo', 'deep'), base)).toBe(false); // does not exist
    mkdirSync(join(box, 'repo', 'deep'));
    expect(isOwnedRoot(op, join(box, 'repo', 'deep'), base)).toBe(true);
    expect(isOwnedRoot(op, join(home, 'projects', 'studio'), base)).toBe(true);
    expect(isOwnedRoot(op, home, base)).toBe(false);
    expect(isOwnedRoot(op, box, base)).toBe(false);
    expect(isOwnedRoot(op, '/', base)).toBe(false);
    // the active project when nothing is fixed
    const unfixed = { TIMMY_HOME: home };
    mkdirSync(join(box, 'active')); mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(join(home, 'state', 'active-project.json'), JSON.stringify({ name: 'Active', root: join(box, 'active') }));
    expect(userProjects(op, unfixed).default).toBe(join(box, 'active'));
    expect(userProjects(op, unfixed).roots).toContain(join(box, 'active'));
    // nothing fixed, nothing active: the folder the companion runs in (the follower's rule), and no default project is MADE
    rmSync(join(home, 'state', 'active-project.json'));
    expect(userProjects(op, unfixed).default).toBe(realpathSync(process.cwd()));
    expect(existsSync(join(home, 'projects', DEFAULT_PROJECT.folder))).toBe(false);
    // a project made as the operator: under <home>/projects, in the companion's own registry
    const made = createUserProject(op, base, 'Op Film');
    expect(made).toMatchObject({ name: 'Op Film', root: join(home, 'projects', 'op-film') });
    expect(userProjects(op, base).roots).toContain(join(home, 'projects', 'op-film'));
    expect(JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')).projects[0]).toMatchObject({ name: 'Op Film', path: join(home, 'projects', 'op-film') });
  });
  it('verifyHello: not configured → the operator (as withUser); configured → the token or why not', async () => {
    const none = await verifyHello({ type: 'hello', session: 'anything' }, identityConfig({}), '127.0.0.1:1');
    expect(none).toEqual({ ok: true, user: { id: OPERATOR_ID, operator: true } });
    const cfg = identityConfig(ENV);
    expect(await verifyHello({ type: 'hello' }, cfg, '127.0.0.1:1')).toEqual({ ok: false, why: SESSION_WORDS.absent });
    const good = await verifyHello({ type: 'hello', session: await mint({ azp: 'http://127.0.0.1:1' }) }, cfg, '127.0.0.1:1');
    expect(good.ok && good.user.id).toBe(USER_A);
  });
});

describe('withUser over real HTTP: the companion\'s routes behind the launch token and the session (C1)', () => {
  let box = '';
  let companion: CompanionServer | undefined;
  let base = '';
  let token = '';
  const kept = process.env.TIMMY_REPO;
  const call = async (path: string, o: { session?: string; method?: string; body?: unknown; auth?: boolean } = {}): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = {};
    if (o.auth !== false) headers.Authorization = `Bearer ${token}`;
    if (o.session) headers['X-Timmy-Session'] = o.session;
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(`${base}${path}`, { method: o.method ?? 'GET', headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  beforeAll(async () => {
    box = realpathSync(mkdtempSync(join(tmpdir(), 'h173-http-')));
    const root = join(box, 'project'); mkdirSync(root);
    const env = { TIMMY_HOME: join(box, 'home'), TIMMY_SETTINGS_DIR: join(box, 'settings'), ...ENV };
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { chatEnv: env, workspace: { env }, clientDir: join(box, 'no-client'), identity: { clerkDir: join(box, 'no-clerk') } });
    if (kept === undefined) delete process.env.TIMMY_REPO; else process.env.TIMMY_REPO = kept;
    base = `http://127.0.0.1:${companion.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
  });
  afterAll(async () => { await companion?.shutdown(); rmSync(box, { recursive: true, force: true }); });

  it('GET /api/identity (the launch token) answers the public configuration; Clerk\'s script absent is said in words', async () => {
    expect((await call('/api/identity', { auth: false })).status).toBe(401);
    const r = await call('/api/identity');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, configured: true, publishableKey: PK, frontendApi: FRONTEND, needs: [], clerkScript: null });
    expect(r.body.clerkWords).toContain('not installed');
    expect(JSON.stringify(r.body)).not.toContain('PUBLIC KEY');
    const vendor = await fetch(`${base}/vendor/clerk/${CLERK_SCRIPT}`);
    expect(vendor.status).toBe(404);
    expect(await vendor.text()).toContain('Clerk\'s script is not installed in this build');
  });
  it('GET /vendor/clerk/<file>: the whole dist/ by plain name, .js and .mjs as text/javascript; a path, a link, types, maps, package files → 404; the installed package found', async () => {
    // a FAKE dist of this test's: the module the page loads, a chunk, a map, a types folder, and a link out of the folder
    const dist = join(box, 'fake-clerk-dist'); mkdirSync(join(dist, 'types'), { recursive: true });
    writeFileSync(join(dist, CLERK_SCRIPT), 'export class Clerk {}\n');
    writeFileSync(join(dist, 'vendors_clerk.browser_d0e7c9_6.40.1.js'), '/* FAKE chunk */\n');
    writeFileSync(join(dist, 'clerk.no-rhc.mjs.map'), '{}\n');
    writeFileSync(join(dist, 'types', 'index.d.ts'), 'export {};\n');
    writeFileSync(join(box, 'outside.js'), '/* not Clerk\'s */\n');
    symlinkSync(join(box, 'outside.js'), join(dist, 'link.js'));
    const withDist = await startCompanionServer(0, { chatEnv: { TIMMY_HOME: join(box, 'home2'), ...ENV }, workspace: { env: { TIMMY_HOME: join(box, 'home2'), ...ENV } }, clientDir: join(box, 'no-client'), identity: { clerkDir: dist } });
    try {
      const b = `http://127.0.0.1:${withDist.port}`;
      const t = /#t=([0-9a-f]{64})$/.exec(withDist.url)![1];
      const id = await (await fetch(`${b}/api/identity`, { headers: { Authorization: `Bearer ${t}` } })).json();
      expect(id.clerkScript).toBe(`/vendor/clerk/${CLERK_SCRIPT}`);
      expect(id.clerkWords).toBeUndefined();
      const mod = await fetch(`${b}/vendor/clerk/${CLERK_SCRIPT}`); // no launch token: the module is public, as any script of the page's
      expect(mod.status).toBe(200);
      expect(mod.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
      expect(mod.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await mod.text()).toBe('export class Clerk {}\n');
      const chunk = await fetch(`${b}/vendor/clerk/vendors_clerk.browser_d0e7c9_6.40.1.js`);
      expect(chunk.status).toBe(200);
      expect(chunk.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
      // not JavaScript, not a plain name, not there, a link leading out of dist/, a path: each 404
      for (const name of ['clerk.no-rhc.mjs.map', 'types', '.hidden.js', 'missing.js', 'package.json', 'link.js', 'types/index.d.ts', '../package.json', '..%2Fpackage.json', 'types%2Findex.d.ts']) expect((await fetch(`${b}/vendor/clerk/${name}`)).status, name).toBe(404);
    } finally { await withDist.shutdown(); }
    // the installed package, when this checkout has it: found from this module's folder upward, and it holds the file the page loads
    const installed = findClerkDist();
    if (existsSync(join(process.cwd(), 'node_modules', '@clerk', 'clerk-js', 'dist', CLERK_SCRIPT))) {
      expect(realpathSync(installed!)).toBe(realpathSync(join(process.cwd(), 'node_modules', '@clerk', 'clerk-js', 'dist')));
      expect(statSync(join(installed!, CLERK_SCRIPT)).size).toBeGreaterThan(100_000);
    } else {
      expect(installed).toBeNull();
    }
  });
  it('no session → 401 with words; a body or query clerk_user_id never reaches a user; a forged token → 401', async () => {
    const origin = `http://127.0.0.1:${companion!.port}`;
    const none = await call('/api/projects');
    expect(none.status).toBe(401);
    expect(none.body).toEqual({ ok: false, needs: 'session', error: SESSION_WORDS.absent, words: SESSION_WORDS.absent });
    // configured → NO operator fallback: the launch token alone is 401 { needs: 'session' } on every withUser route
    const me = await call('/api/identity/me');
    expect(me.status).toBe(401);
    expect(me.body.needs).toBe('session');
    expect(JSON.stringify(me.body)).not.toContain(OPERATOR_ID);
    const claimed = await call(`/api/projects?clerk_user_id=${USER_A}`);
    expect(claimed.status).toBe(401);
    const posted = await call('/api/projects', { method: 'POST', body: { clerk_user_id: USER_A, name: 'x' } });
    expect(posted.status).toBe(401);
    const forged = await call('/api/projects', { session: await mint({ key: other.privateKey, azp: origin }) });
    expect(forged.status).toBe(401);
    expect(forged.body.error).toBe(SESSION_WORDS.signature);
    const wrongPage = await call('/api/projects', { session: await mint({ azp: 'http://127.0.0.1:1' }) });
    expect(wrongPage.status).toBe(401);
    expect(wrongPage.body.error).toBe(SESSION_WORDS.badParty);
    // the launch token first: a session alone, without the companion's token, is refused before the session is read
    const noToken = await call('/api/projects', { auth: false, session: await mint({ azp: origin }) });
    expect(noToken.status).toBe(401);
    expect(noToken.body.error).toContain('token');
    // nothing was made for the claimed user
    expect(() => statSync(join(box, 'home', 'users', USER_A))).toThrow();
  });
  it('a verified session: the user\'s projects (the default made under users/<id>/), one made by POST; user B sees none of A\'s', async () => {
    const origin = `http://127.0.0.1:${companion!.port}`;
    const a = await mint({ azp: origin });
    const list = await call('/api/projects', { session: a });
    expect(list.status).toBe(200);
    expect(list.body.projects).toHaveLength(1);
    expect(list.body.projects[0]).toMatchObject({ name: DEFAULT_PROJECT.name, root: realpathSync(join(box, 'home', 'users', USER_A, 'projects', DEFAULT_PROJECT.folder)) });
    expect(list.body.default).toBe(list.body.projects[0].id);
    const made = await call('/api/projects', { session: a, method: 'POST', body: { name: 'Short Film', clerk_user_id: USER_B } });
    expect(made.status).toBe(201);
    // under the user's home ONCE (H172's 20:14 finding: the route's user env fed back into userHome nested it twice), and
    // listed back by the same route from the same registry
    expect(made.body.root).toBe(join(box, 'home', 'users', USER_A, 'projects', 'short-film'));
    expect(statSync(made.body.root).isDirectory()).toBe(true);
    expect(() => statSync(join(box, 'home', 'users', USER_A, 'users'))).toThrow();
    const listed = await call('/api/projects', { session: a });
    expect(listed.body.projects.map((p: { name: string }) => p.name).sort()).toEqual(['Short Film', DEFAULT_PROJECT.name].sort());
    expect(listed.body.projects.find((p: { id: string }) => p.id === made.body.id)).toEqual({ id: made.body.id, name: 'Short Film', root: made.body.root });
    expect(JSON.parse(readFileSync(join(box, 'home', 'users', USER_A, 'projects.json'), 'utf8')).projects.map((p: { path: string }) => p.path).sort()).toEqual([made.body.root, join(box, 'home', 'users', USER_A, 'projects', DEFAULT_PROJECT.folder)].sort());
    const bad = await call('/api/projects', { session: a, method: 'POST', body: { name: '../escape' } });
    expect(bad.status).toBe(400);
    const b = await mint({ sub: USER_B, azp: origin });
    const theirs = await call('/api/projects', { session: b });
    expect(theirs.status).toBe(200);
    expect(theirs.body.projects).toHaveLength(1);
    expect(theirs.body.projects[0].root).toContain(join('users', USER_B, 'projects'));
    expect(theirs.body.projects.map((p: { id: string }) => p.id)).not.toContain(list.body.projects[0].id);
    expect(statSync(join(box, 'home', 'users', USER_B)).mode & 0o777).toBe(0o700);
  });
});

describe('no identity provider configured: the launch token\'s holder is the OPERATOR on every withUser route (the lead\'s 21:48 ruling)', () => {
  let box = '';
  let companion: CompanionServer | undefined;
  let base = '';
  let token = '';
  let root = '';
  const kept = process.env.TIMMY_REPO;
  const call = async (path: string, o: { session?: string; method?: string; body?: unknown; auth?: boolean } = {}): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = {};
    if (o.auth !== false) headers.Authorization = `Bearer ${token}`;
    if (o.session) headers['X-Timmy-Session'] = o.session;
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(`${base}${path}`, { method: o.method ?? 'GET', headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  beforeAll(async () => {
    box = realpathSync(mkdtempSync(join(tmpdir(), 'h173-operator-http-')));
    root = join(box, 'project'); mkdirSync(root);
    const env = { TIMMY_HOME: join(box, 'home'), TIMMY_SETTINGS_DIR: join(box, 'settings'), TIMMY_REPO: root }; // no CLERK_* at all
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { chatEnv: env, workspace: { env }, clientDir: join(box, 'no-client'), identity: { clerkDir: join(box, 'no-clerk') } });
    if (kept === undefined) delete process.env.TIMMY_REPO; else process.env.TIMMY_REPO = kept;
    base = `http://127.0.0.1:${companion.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
  });
  afterAll(async () => { await companion?.shutdown(); rmSync(box, { recursive: true, force: true }); });

  it('GET /api/identity says not configured with the env names; /api/identity/me is the operator, in words; the launch token still rules', async () => {
    const id = await call('/api/identity');
    expect(id.status).toBe(200);
    expect(id.body).toMatchObject({ ok: true, configured: false, needs: [IDENTITY_ENV.publishable, IDENTITY_ENV.jwtKey] });
    const me = await call('/api/identity/me');
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ ok: true, user: { id: OPERATOR_ID, operator: true }, words: OPERATOR_WORDS });
    expect(OPERATOR_WORDS).toBe('This computer\'s operator · no identity provider configured (CLERK_PUBLISHABLE_KEY, CLERK_JWT_KEY)');
    // a session header sent anyway changes nothing (nothing could verify it); a query or body id never does
    expect((await call('/api/identity/me', { session: await mint({ azp: base }) })).body.user).toEqual({ id: OPERATOR_ID, operator: true });
    expect((await call(`/api/identity/me?clerk_user_id=${USER_A}`)).body.user.id).toBe(OPERATOR_ID);
    // never 401 needs:'session' here — but the launch token is still the companion's boundary
    const noToken = await call('/api/identity/me', { auth: false });
    expect(noToken.status).toBe(401);
    expect(noToken.body.needs).toBeUndefined();
    expect(noToken.body.error).toContain('token');
  });
  it('GET /api/projects: the companion\'s own (the fixed project first, as the follower has it), marked operator; POST makes one under <TIMMY_HOME>/projects; no users/ folder ever', async () => {
    const list = await call('/api/projects');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ ok: true, operator: true, words: OPERATOR_WORDS, default: projectId(root) });
    expect(list.body.projects[0]).toEqual({ id: projectId(root), name: 'project', root });
    const made = await call('/api/projects', { method: 'POST', body: { name: 'Op Short' } });
    expect(made.status).toBe(201);
    expect(made.body.root).toBe(join(box, 'home', 'projects', 'op-short'));
    const again = await call('/api/projects');
    expect(again.body.projects.map((p: { name: string }) => p.name).sort()).toEqual(['Op Short', 'project']);
    expect(again.body.default).toBe(projectId(root));
    expect(existsSync(join(box, 'home', 'users'))).toBe(false);
  });
});
