import { describe, expect, it } from 'vitest';
import { holds60, percentile, PhaseRecorder, RollingWindow, summarize } from '../src/stats';

describe('percentile and summarize', () => {
  it('uses nearest rank', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile([], 50)).toBe(0);
  });

  it('summarizes unsorted input', () => {
    const s = summarize([3, 1, 2]);
    expect(s).toMatchObject({ count: 3, mean: 2, p50: 2, max: 3 });
  });
});

describe('PhaseRecorder', () => {
  it('measures a steady 60 Hz run as holding 60 fps', () => {
    const r = new PhaseRecorder('steady', 0);
    for (let i = 0; i <= 120; i++) {
      r.data(i * 16.667 - 2);
      r.frame(i * 16.667, 1);
    }
    const s = r.finish(2000);
    expect(s.fps).toBeCloseTo(60, 0);
    expect(s.longFrames).toBe(0);
    expect(s.framesWithoutNewData).toBe(0);
    expect(s.holds60).toBe(true);
  });

  it('counts long frames, stalls and frames drawn with stale data', () => {
    const r = new PhaseRecorder('janky', 0);
    const times = [0, 16, 33, 70, 87, 150, 166];
    times.forEach((t, i) => {
      if (i % 2 === 0) r.data(t - 1);
      r.frame(t, 2);
    });
    const s = r.finish(200);
    expect(s.longFrames).toBe(2); // 37 ms and 63 ms
    expect(s.stalls).toBe(1); // 63 ms
    expect(s.framesWithoutNewData).toBe(3);
    expect(s.holds60).toBe(false);
  });

  it('does not call a phase with no frames a pass', () => {
    expect(new PhaseRecorder('empty', 0).finish(1000).holds60).toBe(false);
    expect(holds60(60, 0, 0)).toBe(false);
  });
});

describe('RollingWindow', () => {
  it('keeps only the newest values', () => {
    const w = new RollingWindow(3);
    [1, 2, 3, 100].forEach((x) => w.push(x));
    expect(w.summary()).toMatchObject({ count: 3, max: 100, p50: 3 });
  });
});
