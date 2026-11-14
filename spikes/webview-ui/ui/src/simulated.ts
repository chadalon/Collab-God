// A stand-in for the C++ host, so the page runs in an ordinary browser
// (open dist/index.html through any static server) and in tests. It answers the
// same native functions and sends the same frames, with a fake transport and
// levels made up from the playhead position. Nothing here measures the real bridge.

import type { JuceBackend } from './bridge';
import { contractVersion, type Frame, type HostInfo } from './protocol';

type Listener = (payload: unknown) => void;

export interface SimulatedOptions {
  now?: () => number;
  /** Delay before a native function answers, in ms. */
  latencyMs?: number;
  /** Start sending frames on a timer. Tests drive frames by hand instead. */
  autoFrames?: boolean;
}

export class SimulatedHost implements JuceBackend {
  readonly functions = ['hello', 'ping', 'seek', 'setPlaying', 'configure', 'pullFrame', 'saveReport'];
  readonly savedReports: string[] = [];

  private readonly listeners = new Map<string, Listener[]>();
  private readonly now: () => number;
  private readonly latencyMs: number;
  private readonly startedAt: number;

  private seq = 0;
  private playing = true;
  private anchorPosition = 0;
  private anchorTime: number;
  private push = true;
  private extraMeters = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  readonly loopStartSec = 0;
  readonly loopEndSec = 8;

  constructor(options: SimulatedOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.latencyMs = options.latencyMs ?? 0;
    this.startedAt = this.now();
    this.anchorTime = this.startedAt;
    if (options.autoFrames ?? true) {
      this.timer = setInterval(() => {
        if (this.push) this.emitFrame();
      }, 1000 / 60);
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  addEventListener(eventId: string, fn: Listener): unknown {
    const list = this.listeners.get(eventId) ?? [];
    list.push(fn);
    this.listeners.set(eventId, list);
    return [eventId, list.length - 1];
  }

  emitEvent(eventId: string, payload: unknown): void {
    if (eventId !== '__juce__invoke') return;
    const { name, params, resultId } = payload as { name: string; params: unknown[]; resultId: number };
    const result = this.invoke(name, params);
    const answer = () => this.dispatch('__juce__complete', { promiseId: resultId, result });
    if (this.latencyMs > 0) setTimeout(answer, this.latencyMs);
    else queueMicrotask(answer);
  }

  /** Sends one frame now, as the host does on each display refresh. */
  emitFrame(): void {
    this.dispatch('frame', this.buildFrame());
  }

  private dispatch(eventId: string, payload: unknown): void {
    // The real bridge serialises every payload to JSON; do the same so tests see what the page would.
    const copy = JSON.parse(JSON.stringify(payload)) as unknown;
    for (const fn of this.listeners.get(eventId) ?? []) fn(copy);
  }

  private position(): number {
    if (!this.playing) return this.anchorPosition;
    const span = this.loopEndSec - this.loopStartSec;
    const raw = this.anchorPosition + (this.now() - this.anchorTime) / 1000;
    return this.loopStartSec + ((((raw - this.loopStartSec) % span) + span) % span);
  }

  buildFrame(): Frame {
    const pos = this.position();
    const beat = (pos * 2) % 1;
    const left = this.playing ? -6 - 30 * beat : -100;
    const right = this.playing ? -9 - 30 * ((beat + 0.5) % 1) : -100;
    return {
      v: contractVersion,
      seq: this.seq++,
      hostTimeMs: this.now() - this.startedAt,
      playing: this.playing,
      positionSec: pos,
      audibleSec: pos,
      loopStartSec: this.loopStartSec,
      loopEndSec: this.loopEndSec,
      levelsDb: [left, right],
      extraLevelsDb: Array.from({ length: this.extraMeters }, (_, i) => left - (i % 12)),
      unexpectedStops: 0,
      contextRebuilds: 1,
      xruns: -1,
    };
  }

  private invoke(name: string, params: unknown[]): unknown {
    switch (name) {
      case 'hello': {
        const info: HostInfo = {
          v: contractVersion,
          platform: 'Browser',
          webView: 'simulated (no C++ host)',
          juceVersion: 'none',
          audio: { simulated: true, type: 'simulated', name: 'none', sampleRate: 44100, blockSize: 441 },
          settle: { ms: 0, contextChanges: 0, deviceChanges: 0, timedOut: false },
          emit: 'timer:60',
          autorun: 'none',
        };
        return info;
      }
      case 'ping':
        return params[0];
      case 'seek': {
        this.anchorPosition = Number(params[0]);
        this.anchorTime = this.now();
        return { ok: true };
      }
      case 'setPlaying': {
        this.anchorPosition = this.position();
        this.anchorTime = this.now();
        this.playing = Boolean(params[0]);
        return { playing: this.playing };
      }
      case 'configure': {
        const o = (params[0] ?? {}) as { push?: unknown; extraMeters?: unknown };
        if (typeof o.push === 'boolean') this.push = o.push;
        if (typeof o.extraMeters === 'number') this.extraMeters = Math.max(0, Math.min(4096, Math.floor(o.extraMeters)));
        return { push: this.push, extraMeters: this.extraMeters };
      }
      case 'pullFrame':
        return this.buildFrame();
      case 'saveReport':
        this.savedReports.push(String(params[0]));
        return { path: `(simulated) report ${this.savedReports.length}` };
      default:
        return undefined;
    }
  }
}
