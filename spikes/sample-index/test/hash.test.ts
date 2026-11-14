import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bufferSource, hashSource, type HashMode } from '../src/hash.js';
import { readExtended, writeExtended } from '../src/pcm.js';
import { infoChunk, makeAiff, makeWav, type PcmSpec } from '../src/writers.js';
import { fcRuns } from './helpers.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const hash = (b: Buffer, mode: HashMode = 'both', chunkSize?: number) =>
  hashSource(bufferSource(b), chunkSize === undefined ? { mode } : { mode, chunkSize, headBytes: chunkSize });

function spec(bits: PcmSpec['bits'], channels: number, frames: number, seed = 1, encoding: 'int' | 'float' = 'int'): PcmSpec {
  const samples = Buffer.alloc(frames * channels * (bits / 8));
  let x = seed;
  for (let i = 0; i < samples.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    samples[i] = x >> 16;
  }
  return { encoding, bits, channels, sampleRate: 44100, samples };
}

describe('file hash', () => {
  it('is the SHA-256 of every byte', async () => {
    const wav = makeWav(spec(16, 2, 1000));
    expect((await hash(wav, 'file')).fileHash).toBe(sha(wav));
    expect((await hash(wav, 'both', 7)).fileHash).toBe(sha(wav));
  });

  it('exists for files that are not PCM, which get a reason instead of an audio identity', async () => {
    const mp3ish = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00 not really an mp3', 'latin1');
    const r = await hash(mp3ish);
    expect(r.fileHash).toBe(sha(mp3ish));
    expect(r.audio).toBeUndefined();
    expect(r.audioSkipped).toBe('not wav or aiff');
  });
});

describe('audio hash', () => {
  it('ignores metadata chunks that change the file hash', async () => {
    const s = spec(24, 2, 500);
    const plain = makeWav(s);
    const tagged = makeWav(s, [infoChunk('bpm 128, key Am'), { id: 'bext', body: Buffer.alloc(602, 7) }]);
    const trailing = makeWav(s, [{ ...infoChunk('written after the data'), after: true }]);
    const [a, b, c] = await Promise.all([hash(plain), hash(tagged), hash(trailing)]);
    expect(a.fileHash).not.toBe(b.fileHash);
    expect(a.fileHash).not.toBe(c.fileHash);
    expect(b.audio?.hash).toBe(a.audio?.hash);
    expect(c.audio?.hash).toBe(a.audio?.hash);
  });

  it.each([8, 16, 24, 32] as const)('matches across WAV, AIFF and AIFF-C at %i bits', async (bits) => {
    const s = spec(bits, 2, 300, bits);
    const hashes = await Promise.all(
      [
        makeWav(s),
        makeWav(s, [], { extensible: true }),
        makeAiff(s),
        makeAiff(s, [], { aifc: 'NONE' }),
        makeAiff(s, [], { aifc: 'twos' }),
        makeAiff(s, [], { aifc: 'sowt' }),
        makeAiff(s, [], { commAfterSound: true }),
      ].map(async (f) => (await hash(f)).audio?.hash),
    );
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(hashes).size).toBe(1);
  });

  it('matches float WAV and AIFF-C fl32 and fl64', async () => {
    for (const [bits, kind] of [[32, 'fl32'], [64, 'fl64']] as const) {
      const s = spec(bits, 1, 200, 3, 'float');
      const [w, a] = await Promise.all([hash(makeWav(s)), hash(makeAiff(s, [], { aifc: kind }))]);
      expect(w.audio?.encoding).toBe('float');
      expect(a.audio?.hash).toBe(w.audio?.hash);
    }
  });

  it('differs when sample rate, channels, bit depth or one sample differ', async () => {
    const s = spec(16, 2, 400);
    const base = (await hash(makeWav(s))).audio?.hash;
    const changedSample = Buffer.from(s.samples);
    changedSample[123] = changedSample[123]! ^ 1;
    const variants = [
      { ...s, sampleRate: 48000 },
      { ...s, channels: 1 },
      { ...s, channels: 4, samples: s.samples.subarray(0, 1600) },
      { ...s, bits: 8 as const },
      { ...s, samples: changedSample },
    ];
    for (const v of variants) expect((await hash(makeWav(v))).audio?.hash).not.toBe(base);
  });

  it('gives the same result however the reads split samples', async () => {
    const wav = makeWav(spec(24, 2, 777));
    const aiff = makeAiff(spec(24, 2, 777));
    const want = (await hash(wav)).audio?.hash;
    for (const size of [1, 2, 5, 7, 4096]) {
      expect((await hash(wav, 'both', size)).audio?.hash).toBe(want);
      expect((await hash(aiff, 'both', size)).audio?.hash).toBe(want);
    }
  });

  it('audio-only mode gives the same audio hash and reads only headers and samples', async () => {
    const s = spec(16, 2, 1000);
    const wav = makeWav(s, [{ id: 'junk', body: Buffer.alloc(20_000) }]);
    const both = await hash(wav, 'both');
    const audioOnly = await hashSource(bufferSource(wav), { mode: 'audio', headBytes: 64 });
    expect(audioOnly.audio?.hash).toBe(both.audio?.hash);
    expect(audioOnly.fileHash).toBeUndefined();
    expect(audioOnly.bytesRead).toBeLessThan(s.samples.length + 200);
    expect(both.bytesRead).toBe(wav.length);
    // With the default head, a small file is a single read.
    expect((await hash(wav, 'audio')).bytesRead).toBe(wav.length);
  });

  it('ignores a trailing partial frame and a data size larger than the file', async () => {
    const s = spec(16, 2, 100);
    const whole = (await hash(makeWav(s))).audio;
    const ragged = makeWav({ ...s, samples: Buffer.concat([s.samples, Buffer.from([1, 2, 3])]) });
    expect((await hash(ragged)).audio?.hash).toBe(whole?.hash);
    const truncated = makeWav(s).subarray(0, -40); // header still claims the full length
    const t = await hash(truncated);
    expect(t.audio?.frames).toBe(90);
  });

  it('never throws on damaged or unsupported headers', async () => {
    const wav = makeWav(spec(16, 1, 10));
    const adpcm = Buffer.from(wav);
    adpcm.writeUInt16LE(2, 20); // format tag 2: MS ADPCM
    const cases: Array<[Buffer, string]> = [
      [Buffer.alloc(0), 'too short'],
      [wav.subarray(0, 30), 'short fmt chunk'],
      [wav.subarray(0, 36), 'no data chunk'],
      [adpcm, 'wav format tag 2 with 16 bits'],
      [Buffer.from('RF64\0\0\0\0WAVEds64', 'latin1'), 'rf64 not supported'],
      [makeAiff(spec(16, 1, 10)).subarray(0, 20), 'short COMM chunk'],
      [makeAiff(spec(16, 1, 10)).subarray(0, 12), 'no COMM chunk'],
      [makeAiff(spec(16, 1, 10), [], { aifc: 'ulaw' as 'NONE' }), 'aifc compression "ulaw"'],
    ];
    for (const [bytes, reason] of cases) {
      const r = await hash(bytes);
      expect(r.audio).toBeUndefined();
      expect(r.audioSkipped).toBe(reason);
      expect(r.fileHash).toBe(sha(bytes));
    }
  });

  it('reports the format and length', async () => {
    const r = await hash(makeAiff({ ...spec(24, 2, 441), sampleRate: 96000 }));
    expect(r.audio).toMatchObject({ encoding: 'int', bits: 24, channels: 2, sampleRate: 96000, frames: 441 });
  });

  it('property: same audio in any supported container, with any extra chunks, has one audio hash', async () => {
    const pcmSpec = fc
      .record({
        bits: fc.constantFrom(8, 16, 24, 32),
        channels: fc.integer({ min: 1, max: 6 }),
        frames: fc.integer({ min: 0, max: 64 }),
        sampleRate: fc.constantFrom(22050, 44100, 48000, 88200, 96000, 192000),
      })
      .chain((p) =>
        fc.uint8Array({ minLength: (p.bits / 8) * p.channels * p.frames, maxLength: (p.bits / 8) * p.channels * p.frames })
          .map((bytes): PcmSpec => ({ encoding: 'int', bits: p.bits as PcmSpec['bits'], channels: p.channels, sampleRate: p.sampleRate, samples: Buffer.from(bytes) })),
      );
    const extra = fc.array(
      fc.record({
        id: fc.constantFrom('LIST', 'bext', 'acid', 'smpl', 'junk', 'iXML', 'APPL', 'NAME'),
        body: fc.uint8Array({ maxLength: 33 }).map((b) => Buffer.from(b)),
        after: fc.boolean(),
      }),
      { maxLength: 3 },
    );
    const container = fc.constantFrom('wav', 'wavx', 'aiff', 'aiff-late-comm', 'sowt', 'twos');
    await fc.assert(
      fc.asyncProperty(pcmSpec, extra, container, container, fc.integer({ min: 1, max: 97 }), async (s, chunks, c1, c2, chunkSize) => {
        const build = (c: string) => {
          switch (c) {
            case 'wav': return makeWav(s, chunks);
            case 'wavx': return makeWav(s, chunks, { extensible: true });
            case 'aiff': return makeAiff(s, chunks);
            case 'aiff-late-comm': return makeAiff(s, chunks, { commAfterSound: true });
            case 'sowt': return makeAiff(s, chunks, { aifc: 'sowt' });
            default: return makeAiff(s, chunks, { aifc: 'twos' });
          }
        };
        const [a, b] = await Promise.all([hash(build(c1)), hash(build(c2), 'both', chunkSize)]);
        expect(a.audio).toBeDefined();
        expect(b.audio?.hash).toBe(a.audio?.hash);
        expect(a.audio?.frames).toBe(s.samples.length / ((s.bits / 8) * s.channels));
      }),
      { numRuns: fcRuns(200) },
    );
  });
});

describe('80-bit extended sample rate', () => {
  it.each([8000, 11025, 22050, 44100, 48000, 88200, 96000, 176400, 192000, 384000])('round-trips %i', (rate) => {
    expect(readExtended(writeExtended(rate), 0)).toBe(rate);
  });

  it('reads the bytes real AIFF files carry for 44100', () => {
    expect(readExtended(Buffer.from('400eac44000000000000', 'hex'), 0)).toBe(44100);
  });
});
