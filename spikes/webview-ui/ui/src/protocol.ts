// What crosses the bridge between the C++ host and this page. The contract is
// written up in ../../contract/README.md, with example payloads both sides test against.

export const contractVersion = 1;

/** One snapshot of the engine, sent once per display refresh. */
export interface Frame {
  v: number;
  seq: number;
  hostTimeMs: number;
  playing: boolean;
  positionSec: number;
  audibleSec: number;
  loopStartSec: number;
  loopEndSec: number;
  levelsDb: [number, number];
  extraLevelsDb: number[];
  unexpectedStops: number;
  contextRebuilds: number;
  xruns: number;
}

export interface AudioInfo {
  simulated: boolean;
  type: string;
  name: string;
  sampleRate: number;
  blockSize: number;
}

export interface HostInfo {
  v: number;
  platform: string;
  webView: string;
  juceVersion: string;
  audio: AudioInfo;
  settle: { ms: number; contextChanges: number; timedOut: boolean };
  emit: string;
  /** "none", "full" or "quick": run the benchmark as soon as the page loads. */
  autorun: string;
}

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
  }
}

type Json = Record<string, unknown>;

function object(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractError(`${what} is not an object`);
  }
  return value as Json;
}

function num(o: Json, key: string, what: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ContractError(`${what}.${key} is not a finite number`);
  return v;
}

function bool(o: Json, key: string, what: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ContractError(`${what}.${key} is not a boolean`);
  return v;
}

function str(o: Json, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new ContractError(`${what}.${key} is not a string`);
  return v;
}

function numbers(o: Json, key: string, what: string): number[] {
  const v = o[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new ContractError(`${what}.${key} is not an array of finite numbers`);
  }
  return v as number[];
}

function version(o: Json, what: string): number {
  const v = num(o, 'v', what);
  if (v !== contractVersion) throw new ContractError(`${what}.v is ${v}; this page speaks version ${contractVersion}`);
  return v;
}

/** Checks a frame from the host. Throws ContractError if it does not match the contract. */
export function decodeFrame(value: unknown): Frame {
  const o = object(value, 'frame');
  const levels = numbers(o, 'levelsDb', 'frame');
  if (levels.length !== 2) throw new ContractError(`frame.levelsDb has ${levels.length} values, not 2`);

  return {
    v: version(o, 'frame'),
    seq: num(o, 'seq', 'frame'),
    hostTimeMs: num(o, 'hostTimeMs', 'frame'),
    playing: bool(o, 'playing', 'frame'),
    positionSec: num(o, 'positionSec', 'frame'),
    audibleSec: num(o, 'audibleSec', 'frame'),
    loopStartSec: num(o, 'loopStartSec', 'frame'),
    loopEndSec: num(o, 'loopEndSec', 'frame'),
    levelsDb: [levels[0] ?? -100, levels[1] ?? -100],
    extraLevelsDb: numbers(o, 'extraLevelsDb', 'frame'),
    unexpectedStops: num(o, 'unexpectedStops', 'frame'),
    contextRebuilds: num(o, 'contextRebuilds', 'frame'),
    xruns: num(o, 'xruns', 'frame'),
  };
}

/** Checks the host description returned by the `hello` native function. */
export function decodeHostInfo(value: unknown): HostInfo {
  const o = object(value, 'hostInfo');
  const audio = object(o['audio'], 'hostInfo.audio');
  const settle = object(o['settle'], 'hostInfo.settle');

  return {
    v: version(o, 'hostInfo'),
    platform: str(o, 'platform', 'hostInfo'),
    webView: str(o, 'webView', 'hostInfo'),
    juceVersion: str(o, 'juceVersion', 'hostInfo'),
    audio: {
      simulated: bool(audio, 'simulated', 'hostInfo.audio'),
      type: str(audio, 'type', 'hostInfo.audio'),
      name: str(audio, 'name', 'hostInfo.audio'),
      sampleRate: num(audio, 'sampleRate', 'hostInfo.audio'),
      blockSize: num(audio, 'blockSize', 'hostInfo.audio'),
    },
    settle: {
      ms: num(settle, 'ms', 'hostInfo.settle'),
      contextChanges: num(settle, 'contextChanges', 'hostInfo.settle'),
      timedOut: bool(settle, 'timedOut', 'hostInfo.settle'),
    },
    emit: str(o, 'emit', 'hostInfo'),
    autorun: str(o, 'autorun', 'hostInfo'),
  };
}

/** Converts a peak level in dB to the 0..1 height of a meter that shows -60 dB to 0 dB. */
export function meterHeight(db: number): number {
  const floor = -60;
  if (!(db > floor)) return 0;
  return Math.min(1, (db - floor) / -floor);
}
