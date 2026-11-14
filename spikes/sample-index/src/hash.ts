import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { canonicalDescriptor, parsePcmLayout, PcmNormalizer, type PcmLayout, type ReadAt } from './pcm.js';

export const HASH_ALGORITHM = 'sha256';

/** Bytes read up front for the header walk. */
export const HEAD_BYTES = 256 * 1024;

/** What to compute. `both` reads the file once and feeds both hashes. */
export type HashMode = 'file' | 'audio' | 'both';

export interface AudioIdentity {
  /** Hash of the canonical PCM descriptor and samples; equal for the same audio in WAV, AIFF or AIFF-C. */
  hash: string;
  encoding: PcmLayout['encoding'];
  bits: number;
  channels: number;
  sampleRate: number;
  frames: number;
}

export interface HashResult {
  /** Hash of every byte of the file. Undefined in `audio` mode. */
  fileHash?: string;
  /** Present when the file is PCM WAV or AIFF and audio hashing was asked for. */
  audio?: AudioIdentity;
  /** Why there is no audio identity, when audio hashing was asked for. */
  audioSkipped?: string;
  /** Bytes read from disk, headers included. */
  bytesRead: number;
}

export interface HashOptions {
  mode?: HashMode;
  /** Read size after the head. Small values exist for tests that split samples across reads. */
  chunkSize?: number;
  /** Size of the first read. Defaults to HEAD_BYTES. */
  headBytes?: number;
}

/** A source of bytes: a file on disk or, in tests, a buffer. */
export interface ByteSource {
  size: number;
  readAt: ReadAt;
  close(): Promise<void>;
}

export async function openFileSource(path: string): Promise<ByteSource> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    return {
      size,
      readAt: async (position, length) => {
        const buf = Buffer.allocUnsafe(length);
        const { bytesRead } = await fh.read(buf, 0, length, position);
        return bytesRead === length ? buf : buf.subarray(0, bytesRead);
      },
      close: () => fh.close(),
    };
  } catch (err) {
    await fh.close();
    throw err;
  }
}

export function bufferSource(data: Buffer): ByteSource {
  return {
    size: data.length,
    readAt: async (position, length) => data.subarray(position, Math.min(data.length, position + length)),
    close: async () => {},
  };
}

export async function hashFile(path: string, options: HashOptions = {}): Promise<HashResult> {
  const src = await openFileSource(path);
  try {
    return await hashSource(src, options);
  } finally {
    await src.close();
  }
}

/**
 * Hashes a source in one sequential pass. Audio hashing first walks the chunk headers with a
 * few small reads, then the samples are taken from the same pass that feeds the file hash.
 */
export async function hashSource(src: ByteSource, options: HashOptions = {}): Promise<HashResult> {
  const mode = options.mode ?? 'both';
  const chunkSize = options.chunkSize ?? 1 << 20;
  // One read of the start of the file serves the header walk and the first piece of the pass.
  // Most sample files fit in it whole, so a typical file costs one read.
  const head = await src.readAt(0, Math.min(src.size, options.headBytes ?? HEAD_BYTES));
  let bytesRead = head.length;
  const countingRead: ReadAt = async (p, l) => {
    // Served from the head when it covers the range, or when the head is the whole file.
    if (p + l <= head.length || head.length >= src.size) return head.subarray(p, p + l);
    const b = await src.readAt(p, l);
    bytesRead += b.length;
    return b;
  };

  let layout: PcmLayout | undefined;
  let audioSkipped: string | undefined;
  if (mode !== 'file') {
    const parsed = await parsePcmLayout(countingRead, src.size);
    if (parsed.ok) layout = parsed.layout;
    else audioSkipped = parsed.reason;
  }

  const fileHasher = mode === 'audio' ? undefined : createHash(HASH_ALGORITHM);
  const audioHasher = layout ? createHash(HASH_ALGORITHM) : undefined;
  const normalizer = layout ? new PcmNormalizer(layout) : undefined;
  if (layout && audioHasher) audioHasher.update(canonicalDescriptor(layout));

  // In audio-only mode read just the samples; otherwise read the whole file.
  const start = fileHasher ? 0 : (layout?.dataOffset ?? 0);
  const end = fileHasher ? src.size : layout ? layout.dataOffset + layout.dataLength : 0;
  const dataStart = layout?.dataOffset ?? 0;
  const dataEnd = layout ? layout.dataOffset + layout.dataLength : 0;

  for (let pos = start; pos < end; ) {
    const want = pos < head.length ? Math.min(head.length, end) - pos : Math.min(chunkSize, end - pos);
    const piece = pos < head.length ? head.subarray(pos, pos + want) : await countingRead(pos, want);
    if (piece.length === 0) break; // the file shrank while we read it
    fileHasher?.update(piece);
    if (audioHasher && normalizer) {
      const from = Math.max(pos, dataStart);
      const to = Math.min(pos + piece.length, dataEnd);
      if (from < to) audioHasher.update(normalizer.push(piece.subarray(from - pos, to - pos)));
    }
    pos += piece.length;
  }

  const result: HashResult = { bytesRead };
  if (fileHasher) result.fileHash = fileHasher.digest('hex');
  if (layout && audioHasher) {
    result.audio = {
      hash: audioHasher.digest('hex'),
      encoding: layout.encoding,
      bits: layout.bits,
      channels: layout.channels,
      sampleRate: layout.sampleRate,
      frames: layout.frames,
    };
  }
  if (audioSkipped !== undefined) result.audioSkipped = audioSkipped;
  return result;
}
