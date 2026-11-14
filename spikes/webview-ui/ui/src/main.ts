// The page: draws 10,000 clips with pan and zoom, shows the engine's playhead and
// meters as they stream in from C++, and runs the benchmark for issue #8.

import { type BenchTarget, type PhasePlan, type Report, runBenchmark, type Transport } from './benchmark';
import { NativeBridge, findJuce } from './bridge';
import { type Capabilities, describeCapabilities, detectCapabilities } from './capabilities';
import { type Bounds, type Camera, initialCamera, pan, rulerHeight, xToTime, zoomTime, zoomTracks } from './camera';
import { generateArrangement, packClips } from './clips';
import { decodeFrame, decodeHostInfo, type Frame, type HostInfo } from './protocol';
import { Canvas2DRenderer, type Renderer, WebGL2Renderer } from './renderers';
import { buildBackground, buildForeground, meterStripWidth, RectList } from './scene';
import { SimulatedHost } from './simulated';
import { PhaseRecorder, RollingWindow } from './stats';

const clipCount = 10_000;
const trackCount = 128;

const el = <T extends HTMLElement>(id: string) => {
  const e = document.getElementById(id);
  if (e === null) throw new Error(`#${id} is missing from index.html`);
  return e as T;
};

const statsEl = el<HTMLPreElement>('stats');
const resultEl = el<HTMLPreElement>('result');
const buttons = {
  play: el<HTMLButtonElement>('play'),
  bench: el<HTMLButtonElement>('bench'),
  renderer: el<HTMLButtonElement>('renderer'),
  transport: el<HTMLButtonElement>('transport'),
  stress: el<HTMLButtonElement>('stress'),
  dirty: el<HTMLButtonElement>('dirty'),
};

const errors: string[] = [];
let bridge: NativeBridge | undefined;

function reportError(message: string): void {
  errors.push(message);
  statsEl.textContent = `Error: ${message}`;
  if (bridge?.has('log')) void bridge.call('log', `page error: ${message}`).catch(() => undefined);
}

window.addEventListener('error', (e) => reportError(`${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => reportError(String(e.reason)));

class App implements BenchTarget {
  private canvas: HTMLCanvasElement;
  private renderer: Renderer;
  private readonly arrangement = generateArrangement(clipCount, trackCount);
  private readonly packed = packClips(this.arrangement.clips);
  private readonly background = new RectList();
  private readonly foreground = new RectList();
  private camera: Camera;
  private cameraDriver: ((elapsedMs: number) => Camera) | undefined;
  private cameraDriverStart = 0;

  private frame: Frame | undefined;
  private transport: Transport = 'push';
  private pulling = false;
  private extraMeters = 0;
  private reupload = false;
  private recorder: PhaseRecorder | undefined;
  private benchmarking = false;
  /** False once WebGL2 has failed here, even if the capability check said it exists. */
  private webgl2Works = true;
  private readonly audibleWaiters: { sec: number; after: number; resolve: (t: number | undefined) => void }[] = [];

  private readonly frameIntervals = new RollingWindow(240);
  private readonly scriptTimes = new RollingWindow(240);
  private readonly dataIntervals = new RollingWindow(240);
  private lastFrameAt = 0;
  private lastDataAt = 0;
  private nextHud = 0;
  private drag: { x: number; y: number } | undefined;

  constructor(
    private readonly bridge: NativeBridge,
    private readonly host: HostInfo,
    private readonly capabilities: Capabilities,
  ) {
    this.canvas = el<HTMLCanvasElement>('timeline');
    this.attachInput(this.canvas);
    this.renderer = this.makeRenderer(capabilities.webgl2.available ? 'webgl2' : 'canvas2d');
    this.camera = initialCamera(this.bounds());

    bridge.on('frame', (payload) => this.receive(payload));
    this.wireButtons();
    requestAnimationFrame((t) => this.tick(t));
  }

  // ---------------------------------------------------------------- engine data

  private receive(payload: unknown): void {
    let frame: Frame;
    try {
      frame = decodeFrame(payload);
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e));
      return;
    }
    const now = performance.now();
    if (this.lastDataAt > 0) this.dataIntervals.push(now - this.lastDataAt);
    this.lastDataAt = now;
    this.frame = frame;
    this.recorder?.data(now);

    for (let i = this.audibleWaiters.length - 1; i >= 0; i--) {
      const w = this.audibleWaiters[i];
      if (w !== undefined && now > w.after && frame.audibleSec >= w.sec - 0.005 && frame.audibleSec < w.sec + 0.5) {
        this.audibleWaiters.splice(i, 1);
        w.resolve(now);
      }
    }
  }

  private pull(): void {
    if (this.pulling) return;
    this.pulling = true;
    this.bridge
      .call('pullFrame')
      .then((f) => this.receive(f))
      .catch((e: unknown) => reportError(`pullFrame: ${String(e)}`))
      .finally(() => (this.pulling = false));
  }

  // ---------------------------------------------------------------- drawing

  private bounds(): Bounds {
    return {
      lengthSec: this.arrangement.lengthSec,
      tracks: this.arrangement.tracks,
      viewWidth: this.canvas.clientWidth || window.innerWidth,
      viewHeight: this.canvas.clientHeight || window.innerHeight,
    };
  }

  private makeRenderer(kind: 'webgl2' | 'canvas2d'): Renderer {
    let r: Renderer | undefined;
    try {
      r = kind === 'webgl2' ? WebGL2Renderer.create(this.canvas) : Canvas2DRenderer.create(this.canvas);
    } catch (e) {
      reportError(`${kind}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (r === undefined && kind === 'webgl2') {
      // A canvas that failed to give WebGL2 can still give 2D only if it never got a context; use a fresh one.
      this.webgl2Works = false;
      const fresh = this.canvas.cloneNode(false) as HTMLCanvasElement;
      this.canvas.replaceWith(fresh);
      this.canvas = fresh;
      this.attachInput(fresh);
      return this.makeRenderer('canvas2d');
    }
    if (r === undefined) throw new Error(`Could not create a ${kind} context`);
    r.setClips(this.packed, this.arrangement.clips.length);
    buttons.renderer.textContent = `Renderer: ${kind === 'webgl2' ? 'WebGL2' : 'Canvas 2D'}`;
    return r;
  }

  /** A canvas keeps the first kind of context it gets, so switching renderer means a new canvas. */
  private switchRenderer(kind: 'webgl2' | 'canvas2d'): void {
    if (this.renderer.name === kind) return;
    if (kind === 'webgl2' && !(this.capabilities.webgl2.available && this.webgl2Works)) return;
    this.renderer.dispose();
    const fresh = this.canvas.cloneNode(false) as HTMLCanvasElement;
    this.canvas.replaceWith(fresh);
    this.canvas = fresh;
    this.attachInput(fresh);
    this.renderer = this.makeRenderer(kind);
  }

  private tick(timestamp: number): void {
    requestAnimationFrame((t) => this.tick(t));
    const start = performance.now();

    if (this.transport === 'pull') this.pull();

    const bounds = this.bounds();
    if (this.cameraDriver !== undefined) this.camera = this.cameraDriver(timestamp - this.cameraDriverStart);

    const f = this.frame;
    const engine = {
      audibleSec: f?.audibleSec ?? 0,
      loopStartSec: f?.loopStartSec ?? 0,
      loopEndSec: f?.loopEndSec ?? 0,
      levelsDb: f?.levelsDb ?? ([-100, -100] as const),
      extraLevelsDb: f?.extraLevelsDb ?? [],
      playing: f?.playing ?? false,
    };
    buildBackground(this.background, this.camera, bounds);
    buildForeground(this.foreground, this.camera, bounds, engine);
    if (this.reupload) this.renderer.reuploadClips();
    this.renderer.draw(this.camera, this.background, this.foreground, {
      width: bounds.viewWidth,
      height: bounds.viewHeight,
      dpr: window.devicePixelRatio || 1,
    });

    const scriptMs = performance.now() - start;
    this.recorder?.frame(timestamp, scriptMs);
    if (this.lastFrameAt > 0) this.frameIntervals.push(timestamp - this.lastFrameAt);
    this.lastFrameAt = timestamp;
    this.scriptTimes.push(scriptMs);

    if (timestamp >= this.nextHud) {
      this.nextHud = timestamp + 250;
      this.updateHud();
    }
  }

  private updateHud(): void {
    const fi = this.frameIntervals.summary();
    const st = this.scriptTimes.summary();
    const di = this.dataIntervals.summary();
    const f = this.frame;
    const fps = fi.mean > 0 ? 1000 / fi.mean : 0;
    const a = this.host.audio;
    statsEl.textContent = [
      `${this.host.webView} on ${this.host.platform}; ${this.renderer.name}; ${clipCount.toLocaleString()} clips on ${trackCount} tracks`,
      describeCapabilities(this.capabilities),
      `Audio: ${a.simulated ? 'simulated sound card' : `${a.type} / ${a.name}`}, ${a.sampleRate} Hz, ${a.blockSize} samples; settled in ${this.host.settle.ms.toFixed(0)} ms after ${this.host.settle.contextChanges} context changes${this.host.settle.timedOut ? ' (TIMED OUT)' : ''}`,
      `Draw: ${fps.toFixed(1)} fps, frame p95 ${fi.p95.toFixed(1)} ms, max ${fi.max.toFixed(1)} ms; script p95 ${st.p95.toFixed(2)} ms`,
      `Data (${this.transport}, ${this.host.emit}): every ${di.p50.toFixed(1)} ms, p95 ${di.p95.toFixed(1)} ms; ${this.extraMeters} extra meters`,
      f === undefined
        ? 'No engine frame yet'
        : `Engine: ${f.playing ? 'playing' : 'stopped'} at ${f.audibleSec.toFixed(2)} s; L ${f.levelsDb[0].toFixed(1)} dB R ${f.levelsDb[1].toFixed(1)} dB; context rebuilds ${f.contextRebuilds}, resumed after unexpected stops ${f.unexpectedStops}, dropouts ${f.xruns < 0 ? 'n/a' : f.xruns}`,
      'Drag to pan, wheel to scroll, Ctrl/Cmd+wheel to zoom time, Alt+wheel to zoom tracks, click the ruler to seek, Space to play/stop, R to reload',
    ].join('\n');
    buttons.play.textContent = f?.playing ? 'Stop' : 'Play';
  }

  // ---------------------------------------------------------------- input

  private attachInput(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (e) => {
      if (e.offsetY < rulerHeight && e.offsetX < this.bounds().viewWidth - meterStripWidth) {
        void this.seek(Math.max(0, xToTime(this.camera, e.offsetX)));
        return;
      }
      this.drag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('dragging');
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.drag === undefined || this.cameraDriver !== undefined) return;
      this.camera = pan(this.camera, e.clientX - this.drag.x, e.clientY - this.drag.y, this.bounds());
      this.drag = { x: e.clientX, y: e.clientY };
    });
    const end = () => {
      this.drag = undefined;
      canvas.classList.remove('dragging');
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (this.cameraDriver !== undefined) return;
        const b = this.bounds();
        const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? b.viewHeight : 1;
        const dx = e.deltaX * scale;
        const dy = e.deltaY * scale;
        if (e.ctrlKey || e.metaKey) this.camera = zoomTime(this.camera, Math.exp(-dy * 0.0025), e.offsetX, b);
        else if (e.altKey) this.camera = zoomTracks(this.camera, Math.exp(-dy * 0.0025), e.offsetY, b);
        else if (e.shiftKey) this.camera = pan(this.camera, -dy, 0, b);
        else this.camera = pan(this.camera, -dx, -dy, b);
      },
      { passive: false },
    );
  }

  private wireButtons(): void {
    buttons.play.onclick = () => void this.setPlaying(!(this.frame?.playing ?? false));
    buttons.bench.onclick = () => void this.benchmark('full');
    buttons.renderer.onclick = () => this.switchRenderer(this.renderer.name === 'webgl2' ? 'canvas2d' : 'webgl2');
    buttons.transport.onclick = () => void this.setTransport(this.transport === 'push' ? 'pull' : 'push');
    buttons.stress.onclick = () => void this.setExtraMeters(this.extraMeters === 0 ? 256 : this.extraMeters === 256 ? 2048 : 0);
    buttons.dirty.onclick = () => {
      this.reupload = !this.reupload;
      buttons.dirty.textContent = `Re-upload clips: ${this.reupload ? 'on' : 'off'}`;
    };
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLButtonElement && e.key === ' ') return;
      if (e.key === ' ') {
        e.preventDefault();
        void this.setPlaying(!(this.frame?.playing ?? false));
      } else if (e.key === 'r' || e.key === 'R') location.reload();
    });
  }

  private async setTransport(mode: Transport): Promise<void> {
    this.transport = mode;
    buttons.transport.textContent = `Data: ${mode}`;
    await this.bridge.call('configure', { push: mode === 'push', extraMeters: this.extraMeters });
  }

  private async setExtraMeters(n: number): Promise<void> {
    this.extraMeters = n;
    buttons.stress.textContent = `Extra meters: ${n}`;
    await this.bridge.call('configure', { push: this.transport === 'push', extraMeters: n });
  }

  // ---------------------------------------------------------------- BenchTarget

  now(): number {
    return performance.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async configure(plan: PhasePlan): Promise<void> {
    this.switchRenderer(plan.renderer);
    this.reupload = plan.reuploadClips;
    buttons.dirty.textContent = `Re-upload clips: ${this.reupload ? 'on' : 'off'}`;
    this.extraMeters = plan.extraMeters;
    buttons.stress.textContent = `Extra meters: ${plan.extraMeters}`;
    await this.setTransport(plan.transport);
  }

  startRecording(name: string): void {
    this.recorder = new PhaseRecorder(name, performance.now());
  }

  finishRecording() {
    const r = this.recorder;
    this.recorder = undefined;
    if (r === undefined) throw new Error('finishRecording without startRecording');
    return r.finish(performance.now());
  }

  driveCamera(path: ((elapsedMs: number) => Camera) | undefined): void {
    this.cameraDriver = path;
    this.cameraDriverStart = performance.now();
    if (path === undefined) this.camera = initialCamera(this.bounds());
  }

  async setPlaying(playing: boolean): Promise<void> {
    await this.bridge.call('setPlaying', playing);
  }

  ping(value: number): Promise<unknown> {
    return this.bridge.call('ping', value);
  }

  async seek(sec: number): Promise<void> {
    await this.bridge.call('seek', sec);
  }

  waitForAudible(sec: number, sentAt: number, timeoutMs: number): Promise<number | undefined> {
    return new Promise((resolve) => {
      const waiter = { sec, after: sentAt, resolve };
      this.audibleWaiters.push(waiter);
      setTimeout(() => {
        const i = this.audibleWaiters.indexOf(waiter);
        if (i >= 0) {
          this.audibleWaiters.splice(i, 1);
          resolve(undefined);
        }
      }, timeoutMs);
    });
  }

  audibleSec(): number {
    return this.frame?.audibleSec ?? 0;
  }

  progress(message: string): void {
    resultEl.hidden = false;
    resultEl.textContent = `Benchmark running. Leave the window in front and do not touch it.\n${message}`;
  }

  // ---------------------------------------------------------------- benchmark

  async benchmark(mode: 'full' | 'quick'): Promise<void> {
    if (this.benchmarking) return;
    this.benchmarking = true;
    Object.values(buttons).forEach((b) => (b.disabled = true));
    try {
      const bounds = this.bounds();
      const report: Report = await runBenchmark(this, {
        mode,
        host: this.host,
        capabilities: this.webgl2Works
          ? this.capabilities
          : { ...this.capabilities, webgl2: { ...this.capabilities.webgl2, available: false } },
        scene: {
          clips: clipCount,
          tracks: trackCount,
          viewport: { width: bounds.viewWidth, height: bounds.viewHeight, dpr: window.devicePixelRatio || 1 },
        },
        lengthSec: this.arrangement.lengthSec,
        unexpectedStops: () => this.frame?.unexpectedStops ?? 0,
      });
      report.errors.push(...errors);
      const saved = (await this.bridge.call('saveReport', JSON.stringify(report, null, 2))) as { path?: string } | undefined;
      resultEl.hidden = false;
      resultEl.textContent = [
        report.verdict.summary,
        '',
        ...report.phases.map(
          (p) =>
            `${p.name.padEnd(14)} ${p.fps.toFixed(1).padStart(6)} fps  p95 ${p.frameIntervalMs.p95.toFixed(1).padStart(5)} ms  >25ms ${String(p.longFrames).padStart(3)}  script p95 ${p.scriptMsPerFrame.p95.toFixed(2)} ms  data every ${p.dataIntervalMs.p50.toFixed(1)} ms  ${p.holds60 ? 'OK' : 'BELOW 60'}`,
        ),
        '',
        `Ping: median ${report.roundTrip.pingMs.p50} ms, p95 ${report.roundTrip.pingMs.p95} ms, max ${report.roundTrip.pingMs.max} ms`,
        `Seek acknowledged: median ${report.roundTrip.seekAckMs.p50} ms; heard: median ${report.roundTrip.seekAudibleMs.p50} ms, p95 ${report.roundTrip.seekAudibleMs.p95} ms`,
        report.errors.length > 0 ? `Errors: ${report.errors.join('; ')}` : 'No errors',
        `Report saved to ${saved?.path ?? '(not saved)'}`,
      ].join('\n');
    } catch (e) {
      reportError(`benchmark: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.benchmarking = false;
      Object.values(buttons).forEach((b) => (b.disabled = false));
    }
  }
}

async function start(): Promise<void> {
  const juce = findJuce(window as unknown as { __JUCE__?: unknown });
  const simulated = juce === undefined ? new SimulatedHost() : undefined;
  const backend = juce?.backend ?? simulated;
  if (backend === undefined) throw new Error('no backend');
  const functions = juce?.initialisationData.__juce__functions ?? simulated?.functions ?? [];
  bridge = new NativeBridge(backend, functions);

  const host = decodeHostInfo(await bridge.call('hello'));
  const capabilities = await detectCapabilities();
  const app = new App(bridge, host, capabilities);
  if (bridge.has('log')) void bridge.call('log', `page started: ${describeCapabilities(capabilities).replace('\n', '; ')}`);

  if (host.autorun === 'full' || host.autorun === 'quick') {
    const mode = host.autorun;
    setTimeout(() => void app.benchmark(mode), 1500);
  }
}

start().catch((e: unknown) => {
  reportError(`start-up: ${e instanceof Error ? e.message : String(e)}`);
  // Save what went wrong as the report, so a run started with --exit-after-benchmark ends now, failed.
  if (bridge?.has('saveReport')) void bridge.call('saveReport', JSON.stringify({ v: 1, errors }, null, 2));
});
