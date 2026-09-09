import type { Edl } from './edl.js';

// EDL v1 → OpenTimelineIO (T1 amendment, spec §2.9): lossless mapping — same
// clip/track/time-range semantics; timmy-specific fields (env_lock hash,
// signature, model, filters, overlays, transforms) ride in OTIO metadata
// dictionaries, which the format supports natively. Every timmy edit opens
// in Premiere/Resolve/Avid/Nuke; the receipts ride along.
// v0.7.2: explicit timebases on every RationalTime, multi-track audio stems
// (one Audio track per kind), and sanitized path exports (no absolute home
// paths leave the machine unless the caller opts out).

const rt = (seconds: number, rate = 24) => ({
  OTIO_SCHEMA: 'RationalTime.1',
  rate,
  value: Math.round(seconds * rate)
});

export interface OtioExtras {
  env_lock_hash?: string;
  signature?: string;
  model?: string | null;
}

export interface OtioOptions {
  /** rewrite absolute/home media urls to bundle-relative media/<basename> */
  sanitize?: boolean;
  /** override the EDL timebase for the whole timeline */
  timebase?: number;
}

/** Absolute, ~home or <home>-placeholder media urls become bundle-relative;
 *  fragments survive. The <home> token is the privacy gate's placeholder for
 *  the operator home dir (privacy-d5n9), so it sanitizes like a real path. */
export function sanitizeMediaUrl(url: string): string {
  const m = url.match(/^(.+?)(#t=.*)?$/);
  const frag = m?.[2] ?? '';
  const p = m?.[1] ?? url;
  const base = p.split('/').filter(Boolean).pop() ?? p;
  return (p.startsWith('/') || p.startsWith('~') || p.startsWith('<home>/')) ? `media/${base}${frag}` : `${p}${frag}`;
}

export function edlToOtio(edl: Edl, extra: OtioExtras = {}, opts: OtioOptions = {}): Record<string, unknown> {
  const rate = opts.timebase ?? edl.timebase ?? 24;
  const url = (u: string) => (opts.sanitize ? sanitizeMediaUrl(u) : u);

  const videoTrack = {
    OTIO_SCHEMA: 'Track.1',
    kind: 'Video',
    name: 'timmy clips',
    children: edl.clips.map((c, i) => {
      const m = c.src.match(/^(.+)#t=(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/);
      const start = m ? Number(m[2]) : 0;
      const end = m ? Number(m[3]) : start;
      return {
        OTIO_SCHEMA: 'Clip.2',
        name: `clip-${i}`,
        source_range: {
          OTIO_SCHEMA: 'TimeRange.1',
          start_time: rt(start, rate),
          duration: rt(Math.max(0, end - start), rate)
        },
        media_references: {
          DEFAULT_MEDIA: {
            OTIO_SCHEMA: 'ExternalReference.1',
            target_url: url(m ? m[1] : c.src)
          }
        },
        active_media_reference_key: 'DEFAULT_MEDIA',
        metadata: {
          timmy: {
            edl_version: 1,
            filters: c.filters ?? [],
            overlays: c.overlays ?? [],
            transforms: (c as { transforms?: unknown[] }).transforms ?? [],
            ...extra
          }
        }
      };
    })
  };

  // one Audio track per stem kind, stems keep their own fragments/ducking
  const stems = edl.audio_stems ?? [];
  const kinds: Array<'music' | 'vo' | 'sfx'> = ['music', 'vo', 'sfx'];
  const audioTracks = kinds
    .map(kind => ({
      kind,
      children: stems.filter(s => s.kind === kind)
    }))
    .filter(t => t.children.length > 0)
    .map(t => ({
      OTIO_SCHEMA: 'Track.1',
      kind: 'Audio',
      name: `timmy ${t.kind}`,
      children: t.children.map((s, i) => {
        const m = s.src.match(/^(.+)#t=(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/);
        const start = m ? Number(m[2]) : 0;
        const end = m ? Number(m[3]) : start;
        return {
          OTIO_SCHEMA: 'Clip.2',
          name: `${t.kind}-${i}`,
          source_range: {
            OTIO_SCHEMA: 'TimeRange.1',
            start_time: rt(start, rate),
            duration: rt(Math.max(0, end - start), rate)
          },
          media_references: {
            DEFAULT_MEDIA: {
              OTIO_SCHEMA: 'ExternalReference.1',
              target_url: url(m ? m[1] : s.src)
            }
          },
          active_media_reference_key: 'DEFAULT_MEDIA',
          metadata: { timmy: { stem_kind: t.kind, duck_db: s.duck_db ?? 0, ...extra } }
        };
      })
    }));

  return {
    OTIO_SCHEMA: 'Timeline.1',
    name: 'timmy-edl-v1',
    global_start_time: rt(0, rate),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      children: [videoTrack, ...audioTracks]
    }
  };
}
