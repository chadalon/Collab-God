/**
 * Finding the PCM samples inside WAV, AIFF and AIFF-C files, and turning them into one
 * canonical byte layout so the same audio hashes the same in any of those containers.
 *
 * Only uncompressed PCM is understood. Anything else (MP3, Ogg, FLAC, REX, CAF, ADPCM,
 * RF64) gets a reason instead of a layout; the file still has a file-bytes hash.
 */

/** Reads `length` bytes at `position`. May return fewer at the end of the file. */
export type ReadAt = (position: number, length: number) => Promise<Buffer>;

export type Encoding = 'int' | 'float';

export interface PcmLayout {
  container: 'wav' | 'aiff' | 'aifc';
  encoding: Encoding;
  /** Container bits per sample: 8, 16, 24, 32 or 64. */
  bits: number;
  channels: number;
  sampleRate: number;
  /** Byte order of the samples as stored. */
  byteOrder: 'le' | 'be';
  /** 8-bit WAV is unsigned; everything else here is signed. */
  unsigned8: boolean;
  /** First byte of the first frame. */
  dataOffset: number;
  /** Bytes of whole frames that are actually in the file. */
  dataLength: number;
  frames: number;
}

export type ParseResult = { ok: true; layout: PcmLayout } | { ok: false; reason: string };

const MAX_CHUNKS = 4096;

export async function parsePcmLayout(readAt: ReadAt, fileSize: number): Promise<ParseResult> {
  if (fileSize < 12) return { ok: false, reason: 'too short' };
  const head = await readAt(0, 12);
  if (head.length < 12) return { ok: false, reason: 'too short' };
  const magic = head.toString('latin1', 0, 4);
  const form = head.toString('latin1', 8, 12);
  if (magic === 'RIFF' && form === 'WAVE') return parseWav(readAt, fileSize);
  if (magic === 'FORM' && (form === 'AIFF' || form === 'AIFC')) {
    return parseAiff(readAt, fileSize, form === 'AIFC');
  }
  if (magic === 'RF64' || magic === 'BW64') return { ok: false, reason: 'rf64 not supported' };
  return { ok: false, reason: 'not wav or aiff' };
}

interface ChunkRef {
  id: string;
  /** Position of the chunk body. */
  body: number;
  /** Declared body size. */
  size: number;
}

/** Walks chunk headers without reading chunk bodies. */
async function* walkChunks(
  readAt: ReadAt,
  fileSize: number,
  start: number,
  littleEndian: boolean,
): AsyncGenerator<ChunkRef> {
  let pos = start;
  for (let n = 0; n < MAX_CHUNKS && pos + 8 <= fileSize; n++) {
    const h = await readAt(pos, 8);
    if (h.length < 8) return;
    const id = h.toString('latin1', 0, 4);
    const size = littleEndian ? h.readUInt32LE(4) : h.readUInt32BE(4);
    yield { id, body: pos + 8, size };
    // Chunks are padded to an even length in both RIFF and IFF.
    pos = pos + 8 + size + (size & 1);
  }
}

function frameBytesFor(bits: number, channels: number): number {
  return Math.ceil(bits / 8) * channels;
}

function finish(
  base: Omit<PcmLayout, 'dataLength' | 'frames'>,
  declaredLength: number,
  fileSize: number,
  maxFrames?: number,
): ParseResult {
  if (base.channels < 1 || base.channels > 64) return { ok: false, reason: 'bad channel count' };
  if (!(base.sampleRate > 0) || base.sampleRate > 10_000_000) return { ok: false, reason: 'bad sample rate' };
  const frameBytes = frameBytesFor(base.bits, base.channels);
  const available = Math.max(0, Math.min(declaredLength, fileSize - base.dataOffset));
  let frames = Math.floor(available / frameBytes);
  if (maxFrames !== undefined) frames = Math.min(frames, maxFrames);
  return { ok: true, layout: { ...base, frames, dataLength: frames * frameBytes } };
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

async function parseWav(readAt: ReadAt, fileSize: number): Promise<ParseResult> {
  let fmt: { encoding: Encoding; bits: number; channels: number; sampleRate: number; blockAlign: number } | undefined;
  let unsupported: string | undefined;
  for await (const c of walkChunks(readAt, fileSize, 12, true)) {
    if (c.id === 'fmt ') {
      if (c.size < 16) return { ok: false, reason: 'short fmt chunk' };
      const b = await readAt(c.body, Math.min(c.size, 40));
      if (b.length < 16) return { ok: false, reason: 'short fmt chunk' };
      let tag = b.readUInt16LE(0);
      if (tag === WAVE_FORMAT_EXTENSIBLE) {
        if (b.length < 26) return { ok: false, reason: 'short extensible fmt chunk' };
        // The sub-format GUID starts with the real format tag.
        tag = b.readUInt16LE(24);
      }
      const channels = b.readUInt16LE(2);
      const sampleRate = b.readUInt32LE(4);
      const blockAlign = b.readUInt16LE(12);
      const bits = b.readUInt16LE(14);
      if (tag === WAVE_FORMAT_PCM && [8, 16, 24, 32].includes(bits)) {
        fmt = { encoding: 'int', bits, channels, sampleRate, blockAlign };
      } else if (tag === WAVE_FORMAT_IEEE_FLOAT && (bits === 32 || bits === 64)) {
        fmt = { encoding: 'float', bits, channels, sampleRate, blockAlign };
      } else {
        unsupported = `wav format tag ${tag} with ${bits} bits`;
      }
    } else if (c.id === 'data') {
      if (unsupported) return { ok: false, reason: unsupported };
      if (!fmt) return { ok: false, reason: 'data before fmt' };
      if (fmt.blockAlign !== frameBytesFor(fmt.bits, fmt.channels)) {
        return { ok: false, reason: `unexpected block align ${fmt.blockAlign}` };
      }
      return finish(
        {
          container: 'wav',
          encoding: fmt.encoding,
          bits: fmt.bits,
          channels: fmt.channels,
          sampleRate: fmt.sampleRate,
          byteOrder: 'le',
          unsigned8: fmt.encoding === 'int' && fmt.bits === 8,
          dataOffset: c.body,
        },
        c.size,
        fileSize,
      );
    }
  }
  return { ok: false, reason: unsupported ?? 'no data chunk' };
}

/** IEEE 754 80-bit extended, as AIFF stores the sample rate. */
export function readExtended(b: Buffer, at: number): number {
  const signExp = b.readUInt16BE(at);
  const hi = b.readUInt32BE(at + 2);
  const lo = b.readUInt32BE(at + 6);
  const exp = (signExp & 0x7fff) - 16383 - 63;
  const sign = signExp & 0x8000 ? -1 : 1;
  if (hi === 0 && lo === 0) return 0;
  return sign * (hi * 2 ** 32 + lo) * 2 ** exp;
}

export function writeExtended(value: number): Buffer {
  const b = Buffer.alloc(10);
  if (value === 0) return b;
  let exp = Math.floor(Math.log2(value));
  let mant = value / 2 ** exp; // in [1, 2)
  // Correct for floating error at exact powers of two.
  if (mant >= 2) { mant /= 2; exp += 1; }
  const m = BigInt(Math.round(mant * 2 ** 52)) << 11n;
  b.writeUInt16BE(exp + 16383, 0);
  b.writeUInt32BE(Number(m >> 32n), 2);
  b.writeUInt32BE(Number(m & 0xffffffffn), 6);
  return b;
}

async function parseAiff(readAt: ReadAt, fileSize: number, isAifc: boolean): Promise<ParseResult> {
  let comm:
    | { channels: number; frames: number; bits: number; sampleRate: number; encoding: Encoding; byteOrder: 'le' | 'be' }
    | undefined;
  let ssnd: { dataOffset: number; declared: number } | undefined;
  for await (const c of walkChunks(readAt, fileSize, 12, false)) {
    if (c.id === 'COMM') {
      const b = await readAt(c.body, Math.min(c.size, 22));
      if (b.length < 18) return { ok: false, reason: 'short COMM chunk' };
      const channels = b.readInt16BE(0);
      const frames = b.readUInt32BE(2);
      const sampleSize = b.readInt16BE(6);
      const sampleRate = readExtended(b, 8);
      let encoding: Encoding = 'int';
      let byteOrder: 'le' | 'be' = 'be';
      let bits = Math.ceil(sampleSize / 8) * 8;
      if (isAifc) {
        if (b.length < 22) return { ok: false, reason: 'short AIFC COMM chunk' };
        const kind = b.toString('latin1', 18, 22);
        if (kind === 'NONE' || kind === 'twos') {
          // big-endian signed integers, as in plain AIFF
        } else if (kind === 'sowt') {
          byteOrder = 'le';
        } else if (kind === 'fl32' || kind === 'FL32') {
          encoding = 'float';
          bits = 32;
        } else if (kind === 'fl64' || kind === 'FL64') {
          encoding = 'float';
          bits = 64;
        } else {
          return { ok: false, reason: `aifc compression ${JSON.stringify(kind)}` };
        }
      }
      if (encoding === 'int' && ![8, 16, 24, 32].includes(bits)) {
        return { ok: false, reason: `aiff sample size ${sampleSize}` };
      }
      comm = { channels, frames, bits, sampleRate, encoding, byteOrder };
    } else if (c.id === 'SSND') {
      const b = await readAt(c.body, 8);
      if (b.length < 8) return { ok: false, reason: 'short SSND chunk' };
      const offset = b.readUInt32BE(0);
      ssnd = { dataOffset: c.body + 8 + offset, declared: Math.max(0, c.size - 8 - offset) };
    }
    // COMM may come after SSND in AIFF, so keep walking until both are known.
    if (comm && ssnd) break;
  }
  if (!comm) return { ok: false, reason: 'no COMM chunk' };
  if (!ssnd) return { ok: false, reason: 'no SSND chunk' };
  return finish(
    {
      container: isAifc ? 'aifc' : 'aiff',
      encoding: comm.encoding,
      bits: comm.bits,
      channels: comm.channels,
      sampleRate: comm.sampleRate,
      byteOrder: comm.byteOrder,
      unsigned8: false,
      dataOffset: ssnd.dataOffset,
    },
    ssnd.declared,
    fileSize,
    comm.frames,
  );
}

/**
 * The header hashed before the samples. Two files share an audio hash only if they agree on
 * all of this and on every sample. Container and byte order are deliberately left out.
 */
export function canonicalDescriptor(l: PcmLayout): string {
  return `collabgod-pcm-v1 ${l.encoding} ${l.bits} ${l.channels} ${l.sampleRate}\n`;
}

/**
 * Converts stored sample bytes to the canonical layout: little-endian, signed for integers.
 * Accepts the data in arbitrary pieces; a sample split across two pieces is carried over.
 */
export class PcmNormalizer {
  private readonly bytes: number;
  private readonly swap: boolean;
  private readonly flip8: boolean;
  private carry: Buffer = Buffer.alloc(0);
  private scratch: Buffer = Buffer.alloc(0);

  constructor(layout: PcmLayout) {
    this.bytes = layout.bits / 8;
    this.swap = layout.byteOrder === 'be' && this.bytes > 1;
    this.flip8 = layout.unsigned8;
  }

  /** True when the stored bytes already are canonical, so pieces can be hashed as they are. */
  get passthrough(): boolean {
    return !this.swap && !this.flip8;
  }

  /** Returns canonical bytes for every whole sample seen so far. The result is reused; consume it before the next call. */
  push(piece: Buffer): Buffer {
    if (this.passthrough) return piece;
    let input = piece;
    if (this.carry.length > 0) {
      input = Buffer.concat([this.carry, piece]);
      this.carry = Buffer.alloc(0);
    }
    const whole = input.length - (input.length % this.bytes);
    if (whole < input.length) this.carry = Buffer.from(input.subarray(whole));
    if (this.scratch.length < whole) this.scratch = Buffer.allocUnsafe(Math.max(whole, 64 * 1024));
    const out = this.scratch.subarray(0, whole);
    if (this.flip8) {
      for (let i = 0; i < whole; i++) out[i] = input[i]! ^ 0x80;
      return out;
    }
    const n = this.bytes;
    for (let i = 0; i < whole; i += n) {
      for (let j = 0; j < n; j++) out[i + j] = input[i + n - 1 - j]!;
    }
    return out;
  }
}
