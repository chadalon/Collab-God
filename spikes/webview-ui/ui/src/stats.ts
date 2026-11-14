// Frame timing statistics. Everything is in milliseconds.

export interface Summary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Nearest-rank percentile of an already sorted array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return { count: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, x) => s + x, 0);
  return {
    count: sorted.length,
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/** Rounds every number in a summary to `digits` decimal places, for reports. */
export function rounded(s: Summary, digits = 2): Summary {
  const f = 10 ** digits;
  const r = (x: number) => Math.round(x * f) / f;
  return { count: s.count, mean: r(s.mean), p50: r(s.p50), p95: r(s.p95), p99: r(s.p99), max: r(s.max) };
}

/** Keeps the most recent `capacity` values, for the live readout. */
export class RollingWindow {
  private readonly values: number[] = [];
  constructor(private readonly capacity: number) {}

  push(x: number): void {
    this.values.push(x);
    if (this.values.length > this.capacity) this.values.shift();
  }

  summary(): Summary {
    return summarize(this.values);
  }

  clear(): void {
    this.values.length = 0;
  }
}

/** What a benchmark phase records about the frames the page drew and the data it received. */
export interface PhaseStats {
  name: string;
  durationMs: number;
  /** Frames drawn (requestAnimationFrame callbacks). */
  frames: number;
  fps: number;
  /** Time between consecutive drawn frames. */
  frameIntervalMs: Summary;
  /** Frames that took longer than 25 ms, so the display showed the previous one twice at 60 Hz. */
  longFrames: number;
  /** Frames that took longer than 50 ms: a visible stall. */
  stalls: number;
  /** JavaScript time spent inside each frame callback: input, scene building and draw calls. */
  scriptMsPerFrame: Summary;
  /** Engine frames that arrived from C++. */
  dataFrames: number;
  /** Time between engine frames arriving. */
  dataIntervalMs: Summary;
  /** Drawn frames with no new engine frame since the previous one. */
  framesWithoutNewData: number;
  /** Whether this phase held 60 fps: at least 57 fps and under 1% of frames over 25 ms. */
  holds60: boolean;
}

export const holds60 = (fps: number, frames: number, longFrames: number): boolean =>
  frames > 0 && fps >= 57 && longFrames / frames < 0.01;

/** Collects frame and data timings while a phase runs. */
export class PhaseRecorder {
  private readonly frameTimes: number[] = [];
  private readonly scriptTimes: number[] = [];
  private readonly dataTimes: number[] = [];
  private framesWithoutNewData = 0;
  private dataSinceLastFrame = false;

  constructor(
    readonly name: string,
    private readonly startedAt: number,
  ) {}

  frame(timestamp: number, scriptMs: number): void {
    if (this.frameTimes.length > 0 && !this.dataSinceLastFrame) this.framesWithoutNewData++;
    this.dataSinceLastFrame = false;
    this.frameTimes.push(timestamp);
    this.scriptTimes.push(scriptMs);
  }

  data(arrivedAt: number): void {
    this.dataTimes.push(arrivedAt);
    this.dataSinceLastFrame = true;
  }

  finish(endedAt: number): PhaseStats {
    const intervals = diffs(this.frameTimes);
    const frames = this.frameTimes.length;
    const durationMs = endedAt - this.startedAt;
    const span = frames > 1 ? (this.frameTimes[frames - 1] ?? 0) - (this.frameTimes[0] ?? 0) : 0;
    const fps = span > 0 ? ((frames - 1) * 1000) / span : 0;
    const longFrames = intervals.filter((x) => x > 25).length;
    return {
      name: this.name,
      durationMs: Math.round(durationMs),
      frames,
      fps: Math.round(fps * 10) / 10,
      frameIntervalMs: rounded(summarize(intervals)),
      longFrames,
      stalls: intervals.filter((x) => x > 50).length,
      scriptMsPerFrame: rounded(summarize(this.scriptTimes)),
      dataFrames: this.dataTimes.length,
      dataIntervalMs: rounded(summarize(diffs(this.dataTimes))),
      framesWithoutNewData: this.framesWithoutNewData,
      holds60: holds60(fps, frames, longFrames),
    };
  }
}

function diffs(times: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < times.length; i++) out.push((times[i] ?? 0) - (times[i - 1] ?? 0));
  return out;
}
