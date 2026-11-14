import { describe, expect, it } from 'vitest';
import { type Bounds, initialCamera } from '../src/camera';
import { floatsPerRect } from '../src/clips';
import { buildBackground, buildForeground, gridStep, meterStripWidth, RectList } from '../src/scene';

const bounds: Bounds = { lengthSec: 400, tracks: 128, viewWidth: 1200, viewHeight: 800 };
const engine = {
  audibleSec: 3,
  loopStartSec: 0,
  loopEndSec: 8,
  levelsDb: [-6, -100] as const,
  extraLevelsDb: [] as number[],
  playing: true,
};

const rects = (list: RectList) =>
  Array.from({ length: list.count }, (_, i) => Array.from(list.data.slice(i * floatsPerRect, i * floatsPerRect + 4)));

describe('gridStep', () => {
  it('picks 1, 2 or 5 times a power of ten, at least the minimum spacing apart', () => {
    expect(gridStep(0.05, 80)).toBe(5);
    expect(gridStep(0.01, 80)).toBe(1);
    expect(gridStep(0.3, 80)).toBe(50);
    for (const spp of [0.0007, 0.013, 0.2, 1.7]) expect(gridStep(spp, 80) / spp).toBeGreaterThanOrEqual(80);
  });
});

describe('RectList', () => {
  it('grows past its first capacity and skips empty rectangles', () => {
    const list = new RectList(2);
    for (let i = 0; i < 10; i++) list.add(i, 0, 1, 1, 1, 1, 1, 1);
    list.add(0, 0, 0, 5, 1, 1, 1, 1);
    expect(list.count).toBe(10);
    expect(list.data[9 * floatsPerRect]).toBe(9);
  });
});

describe('scene', () => {
  it('draws only the visible track lanes', () => {
    const list = new RectList();
    buildBackground(list, initialCamera(bounds), bounds);
    const lanes = rects(list).filter(([, , w]) => w === bounds.viewWidth - meterStripWidth);
    expect(lanes.length).toBeLessThan(40);
    expect(lanes.length).toBeGreaterThan(20);
  });

  it('puts the playhead at the audible position', () => {
    const camera = initialCamera(bounds);
    const list = new RectList();
    buildForeground(list, camera, bounds, engine);
    const x = 3 / camera.secPerPx;
    expect(rects(list).some(([rx, , w, h]) => w === 2 && h === bounds.viewHeight && Math.abs(rx! + 1 - x) < 1e-3)).toBe(true);
  });

  it('draws a full meter for a loud channel and an empty one for silence', () => {
    const list = new RectList();
    buildForeground(list, initialCamera(bounds), bounds, engine);
    const meterX = bounds.viewWidth - meterStripWidth + 8;
    const left = rects(list).filter(([x, , w]) => x === meterX && w === 16);
    expect(left).toHaveLength(2); // track and level
    const right = rects(list).filter(([x, , w]) => x === meterX + 22 && w === 16);
    expect(right).toHaveLength(1); // track only: -100 dB draws nothing
  });

  it('draws one bar per extra meter', () => {
    const list = new RectList();
    const before = new RectList();
    buildForeground(before, initialCamera(bounds), bounds, engine);
    buildForeground(list, initialCamera(bounds), bounds, { ...engine, extraLevelsDb: Array.from({ length: 256 }, () => -10) });
    expect(list.count - before.count).toBe(256);
  });
});
