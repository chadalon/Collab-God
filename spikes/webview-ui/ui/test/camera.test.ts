import { describe, expect, it } from 'vitest';
import { type Bounds, initialCamera, limits, pan, rulerHeight, timeToX, trackToY, xToTime, zoomTime, zoomTracks } from '../src/camera';

const bounds: Bounds = { lengthSec: 400, tracks: 128, viewWidth: 1200, viewHeight: 800 };

describe('camera', () => {
  it('starts on the first minute at the top', () => {
    const c = initialCamera(bounds);
    expect(c.originSec).toBe(0);
    expect(c.scrollY).toBe(0);
    expect(xToTime(c, bounds.viewWidth)).toBeCloseTo(60);
  });

  it('converts between time and x both ways', () => {
    const c = { originSec: 10, secPerPx: 0.05, scrollY: 0, trackHeight: 28 };
    expect(timeToX(c, 15)).toBeCloseTo(100);
    expect(xToTime(c, timeToX(c, 123.4))).toBeCloseTo(123.4);
    expect(trackToY(c, 2)).toBe(rulerHeight + 56);
  });

  it('keeps the time under the cursor still while zooming', () => {
    const c = { originSec: 30, secPerPx: 0.05, scrollY: 0, trackHeight: 28 };
    for (const factor of [1.5, 0.5, 4]) {
      const z = zoomTime(c, factor, 400, bounds);
      expect(xToTime(z, 400)).toBeCloseTo(xToTime(c, 400), 6);
    }
  });

  it('keeps the track under the cursor still while zooming tracks', () => {
    const c = { originSec: 0, secPerPx: 0.05, scrollY: 200, trackHeight: 28 };
    const z = zoomTracks(c, 1.5, 300, bounds);
    const trackAt = (cam: typeof c, y: number) => (y - rulerHeight + cam.scrollY) / cam.trackHeight;
    expect(trackAt(z, 300)).toBeCloseTo(trackAt(c, 300), 6);
  });

  it('clamps zoom and scroll to the arrangement', () => {
    const c = initialCamera(bounds);
    expect(zoomTime(c, 1e9, 0, bounds).secPerPx).toBe(limits.minSecPerPx);
    expect(zoomTime(c, 1e-9, 0, bounds).secPerPx).toBe(limits.maxSecPerPx);
    expect(pan(c, 0, 1e6, bounds).scrollY).toBe(0);
    expect(pan(c, 0, -1e9, bounds).scrollY).toBeLessThanOrEqual(bounds.tracks * c.trackHeight);
    expect(pan(c, -1e9, 0, bounds).originSec).toBeLessThanOrEqual(bounds.lengthSec);
  });

  it('pans the opposite way to the drag, as grabbing the timeline would', () => {
    const c = { ...initialCamera(bounds), originSec: 100 };
    expect(pan(c, 100, 0, bounds).originSec).toBeLessThan(100);
  });
});
