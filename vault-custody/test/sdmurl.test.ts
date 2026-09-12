// The offsets round trip. This is the test that stands in for a tag.
//
// The programmer computes a URL template and the byte offsets the chip writes
// its mirrors into. Here we act as the chip — fill those offsets with the
// values a real read would produce — and then act as the edge, pushing the
// filled URL through the same verifier the Pages Function runs. If an offset is
// off by one, this fails. Without it, an off-by-one would first surface on a
// bench full of programmed stickers.
import { describe, it, expect } from 'vitest';
import { buildUrlTemplate, PICC_HEX_LEN, MAC_HEX_LEN } from '../src/lib/sdmurl.js';
import { fillTemplate, simulateTapUrl, type SimTag } from '../src/lib/sunsim.js';
import { deriveTagKeys } from '../src/lib/divkey.js';
import { verifyTap } from '../src/lib/url.js';
import { hex } from '../src/lib/sun.js';

const BASE = 'https://preview.vault-custody.pages.dev';
const MASTER = {
  masterMetaReadKey: '000102030405060708090a0b0c0d0e0f',
  masterFileReadKey: 'f0e0d0c0b0a090807060504030201000',
  batch: 'paradise-001',
};
const UID = '04de5f1eacc040';

async function tagFor(counter: number, tamper?: string): Promise<SimTag> {
  const keys = await deriveTagKeys(MASTER, UID);
  return { uid: UID, counter, metaReadKey: keys.metaReadKey, fileReadKey: keys.fileReadKey, tagTamper: tamper };
}

describe('URL template', () => {
  it('places the mirrors where the placeholders are, not where anyone counted', () => {
    const t = buildUrlTemplate({ base: BASE, tagTamper: true });
    expect(t.template.slice(t.offsets.piccDataOffset, t.offsets.piccDataOffset + PICC_HEX_LEN)).toBe('0'.repeat(PICC_HEX_LEN));
    expect(t.template.slice(t.offsets.macOffset, t.offsets.macOffset + MAC_HEX_LEN)).toBe('0'.repeat(MAC_HEX_LEN));
    expect(t.template.slice(t.offsets.tagTamperOffset as number, (t.offsets.tagTamperOffset as number) + 2)).toBe('00');
  });

  it('has no MAC input offset of its own while no file data is mirrored', () => {
    const t = buildUrlTemplate({ base: BASE, tagTamper: true });
    expect(t.offsets.macInputOffset).toBe(t.offsets.macOffset);
  });

  it('mirrors no tamper status on a plain 424, and shifts nothing else', () => {
    const tt = buildUrlTemplate({ base: BASE, tagTamper: true });
    const plain = buildUrlTemplate({ base: BASE, tagTamper: false });
    expect(plain.template).not.toContain('tt=');
    expect(plain.offsets.tagTamperOffset).toBeUndefined();
    expect(plain.offsets.piccDataOffset).toBe(tt.offsets.piccDataOffset);
    expect(plain.offsets.macOffset).toBe(tt.offsets.macOffset);
    expect(plain.bytes).toBeLessThan(tt.bytes);
  });

  it('stays ASCII, so byte offsets equal character offsets', () => {
    const t = buildUrlTemplate({ base: BASE, tagTamper: true });
    expect(t.bytes).toBe(t.template.length);
  });
});

describe('a simulated tag verifies through the real verifier', () => {
  it('round-trips the template: fill the mirrors, verify the URL', async () => {
    const t = buildUrlTemplate({ base: BASE, tagTamper: true });
    const tag = await tagFor(61, 'CC');
    const url = await fillTemplate(t.template, t.offsets, tag);

    const keys = await deriveTagKeys(MASTER, UID);
    const r = await verifyTap(new URL(url).searchParams, keys);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.uid).toBe(UID);
    expect(r.readCounter).toBe(61);
    expect(r.tagTamper?.current).toBe('closed');
  });

  it('agrees with the direct URL builder', async () => {
    const t = buildUrlTemplate({ base: BASE, tagTamper: true });
    const tag = await tagFor(7, 'CC');
    const filled = new URL(await fillTemplate(t.template, t.offsets, tag));
    const direct = new URL(await simulateTapUrl(BASE, tag));
    expect(filled.searchParams.get('e')).toBe(direct.searchParams.get('e'));
    expect(filled.searchParams.get('c')).toBe(direct.searchParams.get('c'));
  });

  it('fails when the PICC mirror is one byte off, which is the whole point', async () => {
    const t = buildUrlTemplate({ base: BASE, tagTamper: true });
    const tag = await tagFor(61, 'CC');
    const bad = { ...t.offsets, piccDataOffset: t.offsets.piccDataOffset + 1 };
    const url = await fillTemplate(t.template, bad, tag);
    const keys = await deriveTagKeys(MASTER, UID);
    const r = await verifyTap(new URL(url).searchParams, keys);
    expect(r.ok).toBe(false);
  });

  it('fails when the MAC mirror is one byte off', async () => {
    const t = buildUrlTemplate({ base: BASE, tagTamper: true });
    const tag = await tagFor(61, 'CC');
    const bad = { ...t.offsets, macOffset: t.offsets.macOffset - 1 };
    const url = await fillTemplate(t.template, bad, tag);
    const keys = await deriveTagKeys(MASTER, UID);
    const r = await verifyTap(new URL(url).searchParams, keys);
    expect(r.ok).toBe(false);
  });

  it('refuses another tag in the same batch, because the file key is per tag', async () => {
    const t = buildUrlTemplate({ base: BASE, tagTamper: true });
    const tag = await tagFor(61, 'CC');
    const url = await fillTemplate(t.template, t.offsets, tag);
    const otherKeys = await deriveTagKeys(MASTER, '04958caa5c5e80');
    const r = await verifyTap(new URL(url).searchParams, { metaReadKey: otherKeys.metaReadKey, fileReadKey: otherKeys.fileReadKey });
    // Same batch, so the meta key decrypts the UID; the per-tag CMAC does not check out.
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('bad_cmac');
  });

  it('refuses a tag from another batch outright', async () => {
    const t = buildUrlTemplate({ base: BASE, tagTamper: true });
    const tag = await tagFor(61, 'CC');
    const url = await fillTemplate(t.template, t.offsets, tag);
    const otherBatch = await deriveTagKeys({ ...MASTER, batch: 'paradise-002' }, UID);
    const r = await verifyTap(new URL(url).searchParams, otherBatch);
    expect(r.ok).toBe(false);
  });

  it('carries a broken tamper loop through to the verifier', async () => {
    const t = buildUrlTemplate({ base: BASE, tagTamper: true });
    const tag = await tagFor(62, 'OC');
    const url = await fillTemplate(t.template, t.offsets, tag);
    const r = await verifyTap(new URL(url).searchParams, await deriveTagKeys(MASTER, UID));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tagTamper?.permanent).toBe('open');
  });

  it('moves the counter, so replay protection has something to compare', async () => {
    const a = new URL(await simulateTapUrl(BASE, await tagFor(61, 'CC')));
    const b = new URL(await simulateTapUrl(BASE, await tagFor(62, 'CC')));
    expect(a.searchParams.get('e')).not.toBe(b.searchParams.get('e'));
    expect(a.searchParams.get('c')).not.toBe(b.searchParams.get('c'));
    const r = await verifyTap(b.searchParams, await deriveTagKeys(MASTER, UID));
    expect(r.ok && r.readCounter).toBe(62);
  });

  it('keeps the UID out of the URL: the encrypted mirror is opaque', async () => {
    const url = await simulateTapUrl(BASE, await tagFor(61, 'CC'));
    expect(url.toLowerCase()).not.toContain(UID);
    expect(hex.from(new URL(url).searchParams.get('e') as string)).toHaveLength(16);
  });
});
