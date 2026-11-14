import { describe, expect, it } from 'vitest';
import { floatsPerRect, generateArrangement, packClips, seededRandom } from '../src/clips';

describe('generateArrangement', () => {
  it('makes 10,000 clips over 128 tracks, the same every time', () => {
    const a = generateArrangement(10_000, 128);
    const b = generateArrangement(10_000, 128);
    expect(a.clips).toHaveLength(10_000);
    expect(a.clips).toEqual(b.clips);
    expect(new Set(a.clips.map((c) => c.track)).size).toBe(128);
  });

  it('never overlaps clips on a track', () => {
    const { clips, tracks } = generateArrangement(5000, 37, 3);
    for (let t = 0; t < tracks; t++) {
      const onTrack = clips.filter((c) => c.track === t).sort((x, y) => x.startSec - y.startSec);
      for (let i = 1; i < onTrack.length; i++) {
        const prev = onTrack[i - 1]!;
        expect(onTrack[i]!.startSec).toBeGreaterThanOrEqual(prev.startSec + prev.lengthSec);
      }
    }
  });

  it('reports the end of the last clip as the length', () => {
    const { clips, lengthSec } = generateArrangement(300, 4);
    expect(lengthSec).toBeCloseTo(Math.max(...clips.map((c) => c.startSec + c.lengthSec)));
  });

  it('rejects nonsense sizes', () => {
    expect(() => generateArrangement(-1, 4)).toThrow(RangeError);
    expect(() => generateArrangement(10, 0)).toThrow(RangeError);
  });
});

describe('packClips', () => {
  it('writes start, track, length, height and colour for each clip', () => {
    const { clips } = generateArrangement(3, 2);
    const packed = packClips(clips);
    expect(packed).toHaveLength(3 * floatsPerRect);
    const second = clips[1]!;
    expect(Array.from(packed.slice(floatsPerRect, floatsPerRect + 4))).toEqual([
      Math.fround(second.startSec),
      second.track,
      Math.fround(second.lengthSec),
      1,
    ]);
  });

  it('refuses a buffer that is too small', () => {
    expect(() => packClips(generateArrangement(2, 1).clips, new Float32Array(8))).toThrow(RangeError);
  });
});

describe('seededRandom', () => {
  it('stays in [0, 1)', () => {
    const r = seededRandom(42);
    for (let i = 0; i < 10_000; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
