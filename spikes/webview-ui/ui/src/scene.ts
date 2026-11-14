// Everything drawn on top of the clips, rebuilt every frame in screen space (CSS pixels):
// track lanes, the ruler and grid, the loop region, the playhead and the meters.
// The clips themselves stay in a GPU buffer and only the camera changes.

import { type Bounds, type Camera, rulerHeight, timeToX, trackToY } from './camera';
import { floatsPerRect } from './clips';
import { meterHeight } from './protocol';

export interface EngineView {
  audibleSec: number;
  loopStartSec: number;
  loopEndSec: number;
  levelsDb: readonly [number, number];
  extraLevelsDb: readonly number[];
  playing: boolean;
}

export const meterStripWidth = 56;

/** A growable buffer of screen-space rectangles in the same layout as packed clips. */
export class RectList {
  data: Float32Array;
  count = 0;

  constructor(initialCapacity = 512) {
    this.data = new Float32Array(initialCapacity * floatsPerRect);
  }

  clear(): void {
    this.count = 0;
  }

  add(x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number): void {
    if (w <= 0 || h <= 0) return;
    const needed = (this.count + 1) * floatsPerRect;
    if (needed > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const o = this.count * floatsPerRect;
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = w;
    d[o + 3] = h;
    d[o + 4] = r;
    d[o + 5] = g;
    d[o + 6] = b;
    d[o + 7] = a;
    this.count++;
  }
}

/** Picks a grid step in seconds so lines are at least `minPx` apart: 1, 2 or 5 times a power of ten. */
export function gridStep(secPerPx: number, minPx = 80): number {
  const target = secPerPx * minPx;
  const power = 10 ** Math.floor(Math.log10(target));
  for (const m of [1, 2, 5, 10]) if (power * m >= target) return power * m;
  return power * 10;
}

/** Lanes and grid, drawn under the clips. */
export function buildBackground(out: RectList, camera: Camera, bounds: Bounds): void {
  out.clear();
  const width = bounds.viewWidth - meterStripWidth;

  const first = Math.max(0, Math.floor(camera.scrollY / camera.trackHeight));
  const last = Math.min(bounds.tracks - 1, Math.ceil((camera.scrollY + bounds.viewHeight) / camera.trackHeight));
  for (let t = first; t <= last; t++) {
    const shade = t % 2 === 0 ? 0.075 : 0.058;
    out.add(0, trackToY(camera, t), width, camera.trackHeight, shade, shade + 0.005, shade + 0.02, 1);
  }

  const step = gridStep(camera.secPerPx);
  const startSec = Math.floor(camera.originSec / step) * step;
  const endSec = camera.originSec + width * camera.secPerPx;
  for (let s = startSec; s <= endSec; s += step) {
    const x = Math.round(timeToX(camera, s));
    const major = Math.abs(s / (step * 4) - Math.round(s / (step * 4))) < 1e-6;
    out.add(x, 0, 1, bounds.viewHeight, 1, 1, 1, major ? 0.1 : 0.045);
  }
}

/** Ruler, loop region, playhead and meters, drawn over the clips. */
export function buildForeground(out: RectList, camera: Camera, bounds: Bounds, engine: EngineView): void {
  out.clear();
  const width = bounds.viewWidth - meterStripWidth;

  out.add(0, 0, width, rulerHeight, 0.09, 0.1, 0.13, 1);
  const loopX = timeToX(camera, engine.loopStartSec);
  const loopW = timeToX(camera, engine.loopEndSec) - loopX;
  out.add(loopX, 0, loopW, rulerHeight, 0.36, 0.55, 0.98, 0.35);
  out.add(loopX, rulerHeight, loopW, bounds.viewHeight - rulerHeight, 0.36, 0.55, 0.98, 0.06);

  const step = gridStep(camera.secPerPx);
  const startSec = Math.floor(camera.originSec / step) * step;
  const endSec = camera.originSec + width * camera.secPerPx;
  for (let s = startSec; s <= endSec; s += step) {
    out.add(Math.round(timeToX(camera, s)), rulerHeight - 8, 1, 8, 0.8, 0.84, 0.9, 0.6);
  }

  const playX = timeToX(camera, engine.audibleSec);
  if (playX >= -2 && playX <= width + 2) {
    const [r, g, b] = engine.playing ? [1, 0.36, 0.42] : [0.85, 0.85, 0.9];
    out.add(playX - 1, 0, 2, bounds.viewHeight, r, g, b, 0.95);
    out.add(playX - 5, 0, 10, 8, r, g, b, 1);
  }

  // Meter strip on the right: stereo master, then any stress meters as thin bars.
  const stripX = bounds.viewWidth - meterStripWidth;
  out.add(stripX, 0, meterStripWidth, bounds.viewHeight, 0.05, 0.055, 0.07, 1);
  const top = rulerHeight + 8;
  const height = bounds.viewHeight - top - 8;
  engine.levelsDb.forEach((db, i) => addMeter(out, stripX + 8 + i * 22, top, 16, height, db));

  const extra = engine.extraLevelsDb;
  if (extra.length > 0) {
    const thin = Math.max(1, Math.floor((meterStripWidth - 8) / Math.min(extra.length, 48)));
    for (let i = 0; i < extra.length; i++) {
      const column = i % 48;
      const row = Math.floor(i / 48);
      const h = meterHeight(extra[i] ?? -100) * 40;
      out.add(stripX + 4 + column * thin, bounds.viewHeight - 8 - row * 44 - h, Math.max(1, thin - 1), h, 0.38, 0.84, 0.55, 0.7);
    }
  }
}

function addMeter(out: RectList, x: number, y: number, w: number, h: number, db: number): void {
  out.add(x, y, w, h, 0.12, 0.13, 0.17, 1);
  const level = meterHeight(db) * h;
  const hot = db > -6;
  out.add(x, y + h - level, w, level, hot ? 1 : 0.38, hot ? 0.55 : 0.84, hot ? 0.29 : 0.55, 1);
}
