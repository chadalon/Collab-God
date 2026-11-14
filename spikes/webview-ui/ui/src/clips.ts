// The test arrangement: many clips on many tracks, laid out the same way every
// run so two machines draw exactly the same thing.

export interface Clip {
  track: number;
  startSec: number;
  lengthSec: number;
  colour: number;
}

export interface Arrangement {
  clips: Clip[];
  tracks: number;
  lengthSec: number;
}

/** A small, fast, seedable PRNG (mulberry32). Returns numbers in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Clip colours, as 0..1 RGB. Index 0..7. */
export const palette: readonly (readonly [number, number, number])[] = [
  [0.36, 0.55, 0.98],
  [0.64, 0.42, 0.98],
  [0.95, 0.38, 0.62],
  [0.98, 0.58, 0.29],
  [0.96, 0.81, 0.3],
  [0.38, 0.84, 0.55],
  [0.27, 0.78, 0.86],
  [0.78, 0.82, 0.9],
];

/**
 * Lays out `count` clips over `tracks` tracks. Clips on one track never overlap;
 * lengths are 0.5 to 8 seconds with gaps of 0 to 2 seconds, roughly like a busy arrangement.
 */
export function generateArrangement(count: number, tracks: number, seed = 8): Arrangement {
  if (!Number.isInteger(count) || count < 0) throw new RangeError('count must be a whole number, 0 or more');
  if (!Number.isInteger(tracks) || tracks < 1) throw new RangeError('tracks must be a whole number, 1 or more');

  const random = seededRandom(seed);
  const ends = new Array<number>(tracks).fill(0);
  const trackColour = Array.from({ length: tracks }, (_, t) => t % palette.length);
  const clips: Clip[] = [];

  for (let i = 0; i < count; i++) {
    const track = i % tracks;
    const gap = random() < 0.3 ? 0 : random() * 2;
    const lengthSec = 0.5 + random() * 7.5;
    const startSec = (ends[track] ?? 0) + gap;
    ends[track] = startSec + lengthSec;
    clips.push({ track, startSec, lengthSec, colour: trackColour[track] ?? 0 });
  }

  return { clips, tracks, lengthSec: Math.max(0, ...ends) };
}

/** Floats per rectangle instance: x, y, width, height, then r, g, b, a. */
export const floatsPerRect = 8;

/** Packs clips into the instance layout the WebGL renderer uploads, in world units (seconds, tracks). */
export function packClips(clips: readonly Clip[], out = new Float32Array(clips.length * floatsPerRect)): Float32Array {
  if (out.length < clips.length * floatsPerRect) throw new RangeError('output buffer is too small');
  clips.forEach((clip, i) => {
    const [r, g, b] = palette[clip.colour] ?? [1, 1, 1];
    out.set([clip.startSec, clip.track, clip.lengthSec, 1, r, g, b, 0.92], i * floatsPerRect);
  });
  return out;
}
