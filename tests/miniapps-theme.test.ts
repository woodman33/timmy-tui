/**
 * The 05:03 order's G4 and the owners' theme contracts v1 (Card Lab docs/HOST-THEME.md at 342c0f72, Film Room
 * docs/Theme-Contract.md at 8c3cd19f): the host side — which apps declare it, how each learns the exact parent origin (Card
 * Lab from its launch path's themeHostOrigin, Film Room from FILMROOM_THEME_PARENT_ORIGIN in its environment), and the
 * launch path the page composes. Presentation only: nothing here carries identity, project or receipt authority.
 */
import { describe, expect, it } from 'vitest';
import { miniAppOf } from '../src/companion/miniapps/registry.js';
import { launchTarget } from '../src/companion/miniapps/host.js';
import { themedPath } from '../companion/timmy-app/src/pages/miniapp.jsx';

describe('the theme contract v1, the host side', () => {
  it('Card Lab and Film Room declare it; Film Room is given the exact parent origin, Card Lab is not (it reads its path)', () => {
    const card = miniAppOf('card-lab')!; const film = miniAppOf('film-room')!;
    expect(card.host!.theme).toEqual({ hostOriginParam: 'themeHostOrigin' });
    expect(film.host!.theme).toEqual({ ready: true });
    expect(miniAppOf('model-studio')!.host!.theme).toBeUndefined();
    const at = { port: 4501, dataDir: '/x', base: { PATH: '/bin' }, parentOrigin: 'http://127.0.0.1:4442' };
    expect(film.host!.env(at).FILMROOM_THEME_PARENT_ORIGIN).toBe('http://127.0.0.1:4442');
    expect(card.host!.env(at)).not.toHaveProperty('FILMROOM_THEME_PARENT_ORIGIN');
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
