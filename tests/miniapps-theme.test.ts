/**
 * The 05:03 order's G4 and the owners' theme contracts v1, as adopted in the 07:37 completion pass: Card Lab 6f166d2d
 * (CARDLAB_TIMMY_PARENT_ORIGIN, server-configured), Film Room adfb7a74 (FILMROOM_THEME_PARENT_ORIGIN), Model Studio 8266c20a
 * (STUDIO_THEME_PARENT_ORIGIN and timmy:theme-ready), Stream Studio 2be70c25 (the launch path's hostOrigin; its trust is
 * any loopback origin, so parity is not claimed). The host side: which apps declare it, how each learns the exact parent
 * origin, and the launch path the page composes. Presentation only: nothing here carries identity, project or receipt authority.
 */
import { describe, expect, it } from 'vitest';
import { miniAppOf } from '../src/companion/miniapps/registry.js';
import { launchTarget } from '../src/companion/miniapps/host.js';
import { themedPath } from '../companion/timmy-app/src/pages/miniapp.jsx';

describe('the theme contract v1, the host side', () => {
  it('the server-derived parent origin reaches Card Lab, Film Room and Model Studio in their environment; Stream Studio reads its path', () => {
    const card = miniAppOf('card-lab')!; const film = miniAppOf('film-room')!; const model = miniAppOf('model-studio')!; const stream = miniAppOf('stream-studio')!;
    expect(card.host!.theme).toEqual({});
    expect(film.host!.theme).toEqual({ ready: true });
    expect(model.host!.theme).toEqual({ ready: true });
    expect(stream.host!.theme).toEqual({ hostOriginParam: 'hostOrigin' });
    const at = { port: 4501, dataDir: '/x', base: { PATH: '/bin' }, parentOrigin: 'http://127.0.0.1:4442' };
    expect(film.host!.env(at).FILMROOM_THEME_PARENT_ORIGIN).toBe('http://127.0.0.1:4442');
    expect(card.host!.env(at).CARDLAB_TIMMY_PARENT_ORIGIN).toBe('http://127.0.0.1:4442');
    expect(model.host!.env(at).STUDIO_THEME_PARENT_ORIGIN).toBe('http://127.0.0.1:4442');
    expect(card.host!.env(at)).not.toHaveProperty('FILMROOM_THEME_PARENT_ORIGIN');
    expect(stream.host!.env(at)).toEqual({ PATH: '/bin', PYTHONDONTWRITEBYTECODE: '1', PORT: '4501', STREAM_DATA_DIR: '/x' });
    // Card Lab's bounded provider limit passes through when this computer names one; nothing else of the base does
    expect(card.host!.env({ ...at, base: { CARDLAB_PROVIDER_TIMEOUT_MS: '240000', OPENROUTER_API_KEY: 'sk-x' } })).toMatchObject({ CARDLAB_PROVIDER_TIMEOUT_MS: '240000' });
    expect(card.host!.env({ ...at, base: { OPENROUTER_API_KEY: 'sk-x' } })).not.toHaveProperty('OPENROUTER_API_KEY');
  });

  it('the launch path: the app\'s own path with ?theme= (and Card Lab\'s exact host origin), accepted by the gateway', () => {
    (globalThis as { location?: unknown }).location = { origin: 'http://127.0.0.1:4442' };
    const card = { theme: { hostOriginParam: 'themeHostOrigin' } };
    const p = themedPath(card, '/?run=card_0f7c3e1a-1111-4222-8333-444455556666', 'glacier')!;
    const u = new URL(p, 'http://x');
    expect(u.searchParams.get('run')).toBe('card_0f7c3e1a-1111-4222-8333-444455556666');
    expect(u.searchParams.get('theme')).toBe('glacier');
    expect(u.searchParams.get('themeHostOrigin')).toBe('http://127.0.0.1:4442');
    expect(launchTarget(p)).toBe(p);
    expect(themedPath({ theme: { ready: true } }, null, 'amber')).toBe('/?theme=amber');
    expect(themedPath({ theme: null }, null, 'amber')).toBeNull();
    expect(themedPath({ theme: { ready: true } }, null, 'purple')).toBe('/?theme=amber');
  });
});
