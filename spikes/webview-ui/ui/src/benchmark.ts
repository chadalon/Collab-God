// The scripted run that answers issue #8: several phases of drawing while the engine
// streams, then round-trip timings, all saved to one report. The page implements
// BenchTarget; tests drive this with a fake one.

import type { Capabilities } from './capabilities';
import type { Camera } from './camera';
import type { HostInfo } from './protocol';
import { type PhaseStats, rounded, summarize, type Summary } from './stats';

export type Transport = 'push' | 'pull';

export interface PhasePlan {
  name: string;
  /** What the phase shows. Written into the report so it reads on its own. */
  description: string;
  durationMs: number;
  transport: Transport;
  renderer: 'webgl2' | 'canvas2d';
  extraMeters: number;
  /** Move the camera along a scripted path every frame. */
  panZoom: boolean;
  /** Upload all 10,000 clips to the GPU every frame, as a worst case for edits. */
  reuploadClips: boolean;
}

export interface BenchTarget {
  now(): number;
  sleep(ms: number): Promise<void>;
  configure(plan: PhasePlan): Promise<void>;
  /** Starts recording frame and data timings for a phase; finishRecording returns them. */
  startRecording(name: string): void;
  finishRecording(): PhaseStats;
  /** Sets a function the page calls each frame to place the camera, or undefined to stop. */
  driveCamera(path: ((elapsedMs: number) => Camera) | undefined): void;
  setPlaying(playing: boolean): Promise<void>;
  ping(value: number): Promise<unknown>;
  /** Asks the engine to jump to `sec`; resolves when the host has acknowledged it. */
  seek(sec: number): Promise<void>;
  /** Resolves with the time at which an engine frame first showed the audio thread at `sec`, or undefined on timeout. */
  waitForAudible(sec: number, sentAt: number, timeoutMs: number): Promise<number | undefined>;
  /** The latest audible position the engine reported. */
  audibleSec(): number;
  progress(message: string): void;
}

export interface RoundTrip {
  /** Native function call answered straight away by C++: the bridge alone. */
  pingMs: Summary;
  /** `seek` sent until C++ acknowledged it. */
  seekAckMs: Summary;
  /** `seek` sent until an engine frame showed the audio thread playing from the new position. */
  seekAudibleMs: Summary;
  seekTimeouts: number;
}

export interface Report {
  v: 1;
  createdAt: string;
  mode: 'full' | 'quick';
  host: HostInfo;
  capabilities: Capabilities;
  scene: { clips: number; tracks: number; viewport: { width: number; height: number; dpr: number } };
  phases: (PhaseStats & { description: string })[];
  roundTrip: RoundTrip;
  verdict: { holds60WithStreaming: boolean; summary: string };
  unexpectedStops: number;
  errors: string[];
}

const base = { transport: 'push', renderer: 'webgl2', extraMeters: 0, panZoom: false, reuploadClips: false } as const;

/** The phases of a full run, about 40 seconds. `quick` shortens each to two seconds, for CI and smoke tests. */
export function planPhases(mode: 'full' | 'quick', webgl2: boolean): PhasePlan[] {
  const ms = (full: number) => (mode === 'quick' ? 2000 : full);
  const gpu = webgl2 ? 'webgl2' : 'canvas2d';
  const phases: PhasePlan[] = [
    { ...base, renderer: gpu, name: 'idle', description: 'Playing, camera still, frames pushed from C++', durationMs: ms(4000) },
    { ...base, renderer: gpu, name: 'pan-zoom', description: 'Playing, scripted pan and zoom across all clips, frames pushed', durationMs: ms(8000), panZoom: true },
    { ...base, renderer: gpu, name: 'pan-zoom-pull', description: 'As pan-zoom, but the page asks C++ for each frame (pullFrame)', durationMs: ms(6000), panZoom: true, transport: 'pull' },
    { ...base, renderer: gpu, name: 'meters-256', description: 'As pan-zoom, with 256 extra meter levels in every frame', durationMs: ms(6000), panZoom: true, extraMeters: 256 },
    { ...base, renderer: gpu, name: 'reupload', description: 'As pan-zoom, re-uploading all clips to the GPU every frame', durationMs: ms(6000), panZoom: true, reuploadClips: true },
    { ...base, renderer: 'canvas2d', name: 'canvas2d', description: 'As pan-zoom, drawn with Canvas 2D instead of WebGL2, for comparison', durationMs: ms(6000), panZoom: true },
  ];
  return webgl2 ? phases : phases.filter((p) => p.name !== 'reupload');
}

/**
 * The scripted camera: a slow zoom out from 20 s to the whole arrangement and back,
 * while panning across it and scrolling down the tracks and back. Smooth, so a dropped
 * frame shows as a jump, and it visits every clip.
 */
export function cameraPath(elapsedMs: number, periodMs: number, lengthSec: number, tracks: number, view: { width: number; height: number }): Camera {
  const phase = (elapsedMs % periodMs) / periodMs;
  const wave = 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI); // 0 → 1 → 0
  const visibleSec = 20 * (lengthSec / 20) ** wave; // 20 s up to the whole length
  const secPerPx = visibleSec / Math.max(1, view.width);
  const originSec = Math.max(0, (lengthSec - visibleSec) * phase);
  const trackHeight = 28;
  const scrollY = Math.max(0, tracks * trackHeight - view.height) * wave;
  return { originSec, secPerPx, scrollY, trackHeight };
}

export interface BenchContext {
  mode: 'full' | 'quick';
  host: HostInfo;
  capabilities: Capabilities;
  scene: Report['scene'];
  lengthSec: number;
  unexpectedStops: () => number;
}

export async function runBenchmark(target: BenchTarget, ctx: BenchContext): Promise<Report> {
  const errors: string[] = [];
  const phases: Report['phases'] = [];
  const plans = planPhases(ctx.mode, ctx.capabilities.webgl2.available);
  const stopsBefore = ctx.unexpectedStops();

  await target.setPlaying(true);

  for (const plan of plans) {
    target.progress(`Phase ${phases.length + 1} of ${plans.length}: ${plan.name}`);
    await target.configure(plan);
    target.driveCamera(
      plan.panZoom
        ? (t) => cameraPath(t, Math.min(plan.durationMs, 8000), ctx.lengthSec, ctx.scene.tracks, ctx.scene.viewport)
        : undefined,
    );
    await target.sleep(300); // let a renderer switch or transport change settle before measuring
    target.startRecording(plan.name);
    await target.sleep(plan.durationMs);
    phases.push({ ...target.finishRecording(), description: plan.description });
  }

  target.driveCamera(undefined);
  await target.configure({ ...base, renderer: ctx.capabilities.webgl2.available ? 'webgl2' : 'canvas2d', name: 'round-trip', description: '', durationMs: 0 });

  target.progress('Round trips: ping');
  const pings: number[] = [];
  const pingCount = ctx.mode === 'quick' ? 30 : 200;
  for (let i = 0; i < pingCount; i++) {
    const t0 = target.now();
    try {
      const echo = await target.ping(i);
      if (echo !== i) errors.push(`ping ${i} came back as ${JSON.stringify(echo)}`);
      pings.push(target.now() - t0);
    } catch (e) {
      errors.push(`ping ${i}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  target.progress('Round trips: seek');
  const acks: number[] = [];
  const audible: number[] = [];
  let seekTimeouts = 0;
  const seekCount = ctx.mode === 'quick' ? 5 : 20;
  for (let i = 0; i < seekCount; i++) {
    // Jump at least two seconds away so the new position cannot be mistaken for normal playback.
    const targetSec = target.audibleSec() < 4 ? 6 : 1.5;
    const t0 = target.now();
    try {
      await target.seek(targetSec);
      acks.push(target.now() - t0);
      const at = await target.waitForAudible(targetSec, t0, 2000);
      if (at === undefined) seekTimeouts++;
      else audible.push(at - t0);
    } catch (e) {
      errors.push(`seek ${i}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await target.sleep(250);
  }

  const streaming = phases.filter((p) => p.name !== 'canvas2d' && p.name !== 'reupload');
  const holds = streaming.length > 0 && streaming.every((p) => p.holds60);
  const worst = streaming.reduce<PhaseStats | undefined>((w, p) => (w === undefined || p.fps < w.fps ? p : w), undefined);
  const pingSummary = rounded(summarize(pings));
  const audibleSummary = rounded(summarize(audible));

  return {
    v: 1,
    createdAt: new Date().toISOString(),
    mode: ctx.mode,
    host: ctx.host,
    capabilities: ctx.capabilities,
    scene: ctx.scene,
    phases,
    roundTrip: { pingMs: pingSummary, seekAckMs: rounded(summarize(acks)), seekAudibleMs: audibleSummary, seekTimeouts },
    verdict: {
      holds60WithStreaming: holds,
      summary:
        `${holds ? 'Held' : 'Did NOT hold'} 60 fps in every streaming phase` +
        (worst ? ` (lowest: ${worst.name} at ${worst.fps} fps, ${worst.longFrames} frames over 25 ms)` : '') +
        `. Bridge ping median ${pingSummary.p50} ms, p95 ${pingSummary.p95} ms;` +
        ` seek to audible median ${audibleSummary.p50} ms, p95 ${audibleSummary.p95} ms` +
        (seekTimeouts > 0 ? `, ${seekTimeouts} seeks never reached the audio thread` : '') +
        '.',
    },
    unexpectedStops: ctx.unexpectedStops() - stopsBefore,
    errors,
  };
}
