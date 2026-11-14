import { describe, expect, it } from 'vitest';
import { type BenchTarget, cameraPath, type PhasePlan, planPhases, runBenchmark } from '../src/benchmark';
import type { Capabilities } from '../src/capabilities';
import type { Camera } from '../src/camera';
import hostInfoExample from '../../contract/host-info.example.json';
import { decodeHostInfo } from '../src/protocol';
import { PhaseRecorder } from '../src/stats';

const host = decodeHostInfo(hostInfoExample);

const capabilities = (webgl2: boolean): Capabilities => ({
  userAgent: 'test',
  devicePixelRatio: 2,
  hardwareConcurrency: 4,
  webgl2: { available: webgl2 },
  webgl1: { available: true },
  webgpu: { api: false, adapter: false },
  offscreenCanvas: true,
  offscreenWebGL2InWorker: 'not tested',
  crossOriginIsolated: false,
  sharedArrayBuffer: false,
});

/** A page on a virtual clock that draws at `frameMs` and receives engine frames every 16.7 ms. */
class FakeTarget implements BenchTarget {
  clock = 0;
  audible = 0;
  configured: PhasePlan[] = [];
  driven: (((t: number) => Camera) | undefined)[] = [];
  pings = 0;
  seeks: number[] = [];
  private recorder: PhaseRecorder | undefined;

  constructor(private readonly frameMs: (plan: PhasePlan | undefined) => number) {}

  now() {
    return this.clock;
  }
  async sleep(ms: number) {
    const end = this.clock + ms;
    const step = this.frameMs(this.configured.at(-1));
    let nextData = this.clock;
    while (this.clock + step <= end) {
      this.clock += step;
      while (nextData <= this.clock) {
        this.recorder?.data(nextData);
        nextData += 16.667;
      }
      this.recorder?.frame(this.clock, 1.5);
      this.audible = (this.audible + step / 1000) % 8;
    }
    this.clock = end;
  }
  async configure(plan: PhasePlan) {
    this.configured.push(plan);
  }
  startRecording(name: string) {
    this.recorder = new PhaseRecorder(name, this.clock);
  }
  finishRecording() {
    const s = this.recorder!.finish(this.clock);
    this.recorder = undefined;
    return s;
  }
  driveCamera(path: ((t: number) => Camera) | undefined) {
    this.driven.push(path);
  }
  async setPlaying() {}
  async ping(v: number) {
    this.pings++;
    this.clock += 0.8;
    return v;
  }
  async seek(sec: number) {
    this.seeks.push(sec);
    this.clock += 1;
    this.audible = sec;
  }
  async waitForAudible(_sec: number, sentAt: number) {
    this.clock = sentAt + 30;
    return this.clock;
  }
  audibleSec() {
    return this.audible;
  }
  progress() {}
}

const context = (webgl2 = true) => ({
  mode: 'quick' as const,
  host,
  capabilities: capabilities(webgl2),
  scene: { clips: 10_000, tracks: 128, viewport: { width: 1200, height: 800, dpr: 2 } },
  lengthSec: 400,
  unexpectedStops: () => 0,
});

describe('planPhases', () => {
  it('covers push, pull, stress, re-upload and a Canvas 2D comparison', () => {
    const names = planPhases('full', true).map((p) => p.name);
    expect(names).toEqual(['idle', 'pan-zoom', 'pan-zoom-pull', 'meters-256', 'reupload', 'canvas2d']);
    expect(planPhases('full', true).reduce((s, p) => s + p.durationMs, 0)).toBeLessThanOrEqual(40_000);
  });

  it('falls back to Canvas 2D everywhere when WebGL2 is missing', () => {
    const plans = planPhases('quick', false);
    expect(plans.every((p) => p.renderer === 'canvas2d')).toBe(true);
    expect(plans.some((p) => p.reuploadClips)).toBe(false);
  });
});

describe('cameraPath', () => {
  it('starts zoomed in at the beginning and reaches the whole arrangement halfway', () => {
    const view = { width: 1000, height: 800 };
    const start = cameraPath(0, 8000, 400, 128, view);
    const middle = cameraPath(4000, 8000, 400, 128, view);
    expect(start.originSec).toBe(0);
    expect(start.secPerPx * view.width).toBeCloseTo(20);
    expect(middle.secPerPx * view.width).toBeCloseTo(400);
    expect(middle.scrollY).toBeCloseTo(128 * 28 - 800);
  });
});

describe('runBenchmark', () => {
  it('reports every phase and the round trips, and passes at a steady 60 fps', async () => {
    const target = new FakeTarget(() => 16.667);
    const report = await runBenchmark(target, context());
    expect(report.phases.map((p) => p.name)).toEqual(planPhases('quick', true).map((p) => p.name));
    expect(report.phases.every((p) => p.holds60)).toBe(true);
    expect(report.verdict.holds60WithStreaming).toBe(true);
    expect(report.roundTrip.pingMs.count).toBe(30);
    expect(report.roundTrip.pingMs.p50).toBeCloseTo(0.8);
    expect(report.roundTrip.seekAudibleMs.p50).toBe(30);
    expect(report.roundTrip.seekTimeouts).toBe(0);
    expect(report.errors).toEqual([]);
    expect(target.driven.filter((d) => d !== undefined)).toHaveLength(5);
  });

  it('always seeks at least two seconds away from the playhead', async () => {
    const target = new FakeTarget(() => 16.667);
    await runBenchmark(target, context());
    expect(target.seeks.length).toBe(5);
    expect(new Set(target.seeks)).toEqual(new Set([6, 1.5]));
  });

  it('fails the verdict when a streaming phase drops to 30 fps, but not for Canvas 2D alone', async () => {
    const slowPull = new FakeTarget((plan) => (plan?.transport === 'pull' ? 33.3 : 16.667));
    const report = await runBenchmark(slowPull, context());
    expect(report.verdict.holds60WithStreaming).toBe(false);
    expect(report.verdict.summary).toContain('pan-zoom-pull');

    const slow2d = new FakeTarget((plan) => (plan?.renderer === 'canvas2d' ? 33.3 : 16.667));
    expect((await runBenchmark(slow2d, context())).verdict.holds60WithStreaming).toBe(true);
  });
});
