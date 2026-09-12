// The NDEF URL template written to a tag, and the SDM mirror offsets that go
// with it.
//
// An NTAG 424 DNA in SDM mode stores one fixed URL and overwrites fixed byte
// ranges inside it at every read: the encrypted PICC data, the CMAC, and (on a
// TagTamper part) the tamper status. The chip is told where to write by byte
// offset. Get an offset wrong and the tag emits a URL that looks right and
// fails every verification, on every sticker in the batch, with no clue beyond
// `bad_cmac`.
//
// So the template and its offsets are computed here, in one place, from the
// placeholder positions themselves — never counted by hand — and the result is
// proved by filling it in like a chip and running it through the verifier
// (see sunsim.fillTemplate and test/sdmurl.test.ts).
import { CMAC_PARAM } from './url.js';
import { type SdmOffsets } from './sunsim.js';

/** 16 bytes of PICCData, mirrored as 32 uppercase hex characters. */
export const PICC_HEX_LEN = 32;
/** 8 bytes of truncated SDMMAC, mirrored as 16 uppercase hex characters. */
export const MAC_HEX_LEN = 16;
/** TagTamper status: two characters, e.g. CC / OC. */
export const TT_LEN = 2;

export interface TemplateOptions {
  /** Origin the tag points at, e.g. https://v.vlt.to or the Pages preview. */
  base: string;
  /**
   * TagTamper part? A plain NTAG 424 DNA has no tamper loop, so it mirrors no
   * status and the URL carries no `tt` — a different template and different
   * offsets. Recorded in the receipt because the two are not interchangeable.
   */
  tagTamper: boolean;
}

export interface UrlTemplate extends TemplateOptions {
  /** The URL as stored on the chip, placeholders and all. */
  template: string;
  offsets: SdmOffsets;
  /** Length in bytes, which is what the chip's offsets are relative to. */
  bytes: number;
}

/**
 * Build the template and derive every offset from where the placeholders
 * actually landed. The placeholder characters are '0', which is also what an
 * un-personalised tag reads back, so a tag that never got its mirrors
 * configured produces an obviously dead URL rather than a plausible one.
 */
export function buildUrlTemplate(o: TemplateOptions): UrlTemplate {
  const origin = o.base.replace(/\/$/, '');
  const picc = '0'.repeat(PICC_HEX_LEN);
  const mac = '0'.repeat(MAC_HEX_LEN);
  const tt = '0'.repeat(TT_LEN);
  const template = o.tagTamper
    ? `${origin}/t?e=${picc}&${CMAC_PARAM}=${mac}&tt=${tt}`
    : `${origin}/t?e=${picc}&${CMAC_PARAM}=${mac}`;

  const bytes = new TextEncoder().encode(template).length;
  if (bytes !== template.length) {
    // Offsets are byte offsets on the chip. Keep the template ASCII so the two
    // can never diverge.
    throw new Error('URL template must be ASCII; a multi-byte character would shift every mirror offset');
  }

  const piccDataOffset = template.indexOf(`?e=${picc}`) + '?e='.length;
  const macOffset = template.indexOf(`&${CMAC_PARAM}=${mac}`) + `&${CMAC_PARAM}=`.length;
  const tagTamperOffset = o.tagTamper ? template.indexOf(`&tt=${tt}`) + '&tt='.length : undefined;
  if (piccDataOffset < 3 || macOffset < 3 || (o.tagTamper && (tagTamperOffset ?? -1) < 3)) {
    throw new Error('could not locate a placeholder in the template');
  }

  return {
    ...o,
    base: origin,
    template,
    bytes,
    offsets: {
      piccDataOffset,
      macOffset,
      // No SDMENCFileData is mirrored, so the MAC covers an empty input and the
      // input offset equals the MAC offset (AN12196 §4.3).
      macInputOffset: macOffset,
      ...(tagTamperOffset != null ? { tagTamperOffset } : {}),
    },
  };
}

/** Stable hash input for the receipt: the template plus the offsets that make it mean anything. */
export function templateFingerprintInput(t: UrlTemplate): string {
  return JSON.stringify({ template: t.template, offsets: t.offsets, tagTamper: t.tagTamper });
}
