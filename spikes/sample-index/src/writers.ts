/**
 * Minimal WAV and AIFF writers, for tests and for the synthetic library generator.
 * Samples are given in the canonical layout: little-endian, signed for integers.
 */
import { writeExtended } from './pcm.js';

export interface PcmSpec {
  encoding: 'int' | 'float';
  bits: 8 | 16 | 24 | 32 | 64;
  channels: number;
  sampleRate: number;
  /** Canonical sample bytes. */
  samples: Buffer;
}

export interface ExtraChunk {
  id: string;
  body: Buffer;
  /** Place the chunk after the sample data instead of before it. */
  after?: boolean;
}

function riffChunk(id: string, body: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.write(id, 0, 4, 'latin1');
  h.writeUInt32LE(body.length, 4);
  return Buffer.concat([h, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function iffChunk(id: string, body: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.write(id, 0, 4, 'latin1');
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function swapEach(samples: Buffer, bytes: number): Buffer {
  const out = Buffer.alloc(samples.length);
  for (let i = 0; i + bytes <= samples.length; i += bytes) {
    for (let j = 0; j < bytes; j++) out[i + j] = samples[i + bytes - 1 - j]!;
  }
  return out;
}

export function makeWav(spec: PcmSpec, extra: ExtraChunk[] = [], options: { extensible?: boolean } = {}): Buffer {
  const bytes = spec.bits / 8;
  const blockAlign = bytes * spec.channels;
  const tag = spec.encoding === 'float' ? 3 : 1;
  let fmt: Buffer;
  if (options.extensible) {
    fmt = Buffer.alloc(40);
    fmt.writeUInt16LE(0xfffe, 0);
    fmt.writeUInt16LE(22, 16); // cbSize
    fmt.writeUInt16LE(spec.bits, 18); // valid bits
    fmt.writeUInt32LE(0, 20); // channel mask
    fmt.writeUInt16LE(tag, 24); // first two bytes of the sub-format GUID
    Buffer.from('000000001000800000aa00389b71', 'hex').copy(fmt, 26);
  } else {
    fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(tag, 0);
  }
  fmt.writeUInt16LE(spec.channels, 2);
  fmt.writeUInt32LE(spec.sampleRate, 4);
  fmt.writeUInt32LE(spec.sampleRate * blockAlign, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(spec.bits, 14);
  let data = spec.samples;
  if (spec.encoding === 'int' && spec.bits === 8) data = Buffer.from(data.map((b) => b ^ 0x80));
  const before = extra.filter((c) => !c.after).map((c) => riffChunk(c.id, c.body));
  const after = extra.filter((c) => c.after).map((c) => riffChunk(c.id, c.body));
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), riffChunk('fmt ', fmt), ...before, riffChunk('data', data), ...after]);
  return riffChunk('RIFF', body);
}

export type AifcKind = 'NONE' | 'twos' | 'sowt' | 'fl32' | 'fl64';

export function makeAiff(
  spec: PcmSpec,
  extra: ExtraChunk[] = [],
  options: { aifc?: AifcKind; commAfterSound?: boolean } = {},
): Buffer {
  const bytes = spec.bits / 8;
  const frames = Math.floor(spec.samples.length / (bytes * spec.channels));
  const aifc = options.aifc;
  if (spec.encoding === 'float' && aifc !== 'fl32' && aifc !== 'fl64') throw new Error('float needs AIFF-C fl32 or fl64');
  const comm = Buffer.alloc(aifc ? 22 : 18);
  comm.writeInt16BE(spec.channels, 0);
  comm.writeUInt32BE(frames, 2);
  comm.writeInt16BE(spec.bits, 6);
  writeExtended(spec.sampleRate).copy(comm, 8);
  if (aifc) comm.write(aifc, 18, 4, 'latin1');
  const stored = aifc === 'sowt' ? spec.samples : swapEach(spec.samples, bytes);
  const ssnd = Buffer.concat([Buffer.alloc(8), stored]);
  const before = extra.filter((c) => !c.after).map((c) => iffChunk(c.id, c.body));
  const after = extra.filter((c) => c.after).map((c) => iffChunk(c.id, c.body));
  const commChunk = iffChunk('COMM', comm);
  const soundChunk = iffChunk('SSND', ssnd);
  const fver = aifc ? [iffChunk('FVER', Buffer.from([0xa2, 0x80, 0x51, 0x40]))] : [];
  const middle = options.commAfterSound ? [soundChunk, commChunk] : [commChunk, soundChunk];
  const body = Buffer.concat([Buffer.from(aifc ? 'AIFC' : 'AIFF', 'latin1'), ...fver, ...before, ...middle, ...after]);
  return iffChunk('FORM', body);
}

/** A LIST/INFO chunk such as DAWs and sample stores add, holding a comment. */
export function infoChunk(comment: string): ExtraChunk {
  const text = Buffer.from(comment + '\0', 'latin1');
  const icmt = riffChunk('ICMT', text);
  return { id: 'LIST', body: Buffer.concat([Buffer.from('INFO', 'latin1'), icmt]) };
}
