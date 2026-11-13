// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The transfer protocol. Control messages travel as the relay's `direct`
 * messages (JSON, one member to another, never in the ordered log). File bytes
 * travel as the relay's binary frames. Nothing here names a file on disk: a
 * sample is asked for and sent by its content id alone.
 *
 * The receiver drives everything. It asks for the bytes from the offset it
 * already has on disk, and acknowledges what it has written. The sender keeps at
 * most a window of unacknowledged bytes in flight, so neither the relay nor the
 * receiver ever holds more than that, whatever the file size.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * A sample's content id: SHA-256 of the file's bytes, as 64 hex characters.
 * A stand-in until issue #15 decides the real identity scheme; this spike only
 * needs something that detects a wrong or damaged file.
 */
export type ContentId = string;

export const CONTENT_ID_BYTES = 32;
const CONTENT_ID_PATTERN = /^[0-9a-f]{64}$/;

export const isContentId = (value: unknown): value is ContentId => typeof value === 'string' && CONTENT_ID_PATTERN.test(value);

/** Hash a whole file, streaming, without holding it in memory. */
export async function contentIdOfFile(path: string): Promise<ContentId> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Control messages, sent as the `data` of a relay `direct` message. */
export type TransferMessage =
  /**
   * Receiver to sender: send `id` from `offset` to the end. Starts a stream, or
   * replaces the one already running for this id with a new generation. Chunks
   * from an older generation are ignored by the receiver, so a restart never
   * mixes two streams.
   */
  | { readonly t: 'want'; readonly id: ContentId; readonly offset: number; readonly gen: number }
  /** Sender to receiver, in answer to `want`: the file's total size. Chunks follow. */
  | { readonly t: 'have'; readonly id: ContentId; readonly size: number; readonly gen: number }
  /** Sender to receiver, in answer to `want`: it does not have that sample. */
  | { readonly t: 'missing'; readonly id: ContentId; readonly gen: number }
  /**
   * Receiver to sender: everything before `received` is written to disk. Opens
   * the window. Carries no generation: bytes on disk are on disk, whichever
   * stream brought them.
   */
  | { readonly t: 'ack'; readonly id: ContentId; readonly received: number }
  /** Receiver to sender: stop sending this id. */
  | { readonly t: 'cancel'; readonly id: ContentId };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Check a control message from another member. Undefined for anything malformed. */
export function parseTransferMessage(value: unknown): TransferMessage | undefined {
  if (!isRecord(value) || !isContentId(value['id'])) return undefined;
  const id = value['id'];
  const gen = value['gen'];
  switch (value['t']) {
    case 'want':
      return isCount(value['offset']) && isCount(gen) ? { t: 'want', id, offset: value['offset'], gen } : undefined;
    case 'have':
      return isCount(value['size']) && isCount(gen) ? { t: 'have', id, size: value['size'], gen } : undefined;
    case 'missing':
      return isCount(gen) ? { t: 'missing', id, gen } : undefined;
    case 'ack':
      return isCount(value['received']) ? { t: 'ack', id, received: value['received'] } : undefined;
    case 'cancel':
      return { t: 'cancel', id };
    default:
      return undefined;
  }
}

/**
 * A chunk as a binary payload: 32 bytes of content id, a 4-byte generation, an
 * 8-byte offset, then the file bytes. 44 bytes of header on a 64 KiB chunk is
 * 0.07 per cent.
 */
export const CHUNK_HEADER_BYTES = CONTENT_ID_BYTES + 4 + 8;

export interface Chunk {
  readonly id: ContentId;
  readonly gen: number;
  readonly offset: number;
  readonly bytes: Buffer;
}

export function encodeChunk(id: ContentId, gen: number, offset: number, bytes: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(CHUNK_HEADER_BYTES + bytes.length);
  frame.write(id, 0, CONTENT_ID_BYTES, 'hex');
  frame.writeUInt32BE(gen, CONTENT_ID_BYTES);
  frame.writeBigUInt64BE(BigInt(offset), CONTENT_ID_BYTES + 4);
  frame.set(bytes, CHUNK_HEADER_BYTES);
  return frame;
}

export function decodeChunk(frame: Buffer): Chunk | undefined {
  if (frame.length < CHUNK_HEADER_BYTES) return undefined;
  const offset = frame.readBigUInt64BE(CONTENT_ID_BYTES + 4);
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return {
    id: frame.toString('hex', 0, CONTENT_ID_BYTES),
    gen: frame.readUInt32BE(CONTENT_ID_BYTES),
    offset: Number(offset),
    bytes: frame.subarray(CHUNK_HEADER_BYTES),
  };
}

/** Defaults, chosen in the README's findings. */
export const DEFAULT_CHUNK_BYTES = 64 * 1024;
/** 20 progress events a second at most: smooth enough for a bar on a clip, which the interface can tween at its frame rate. */
export const DEFAULT_PROGRESS_INTERVAL_MS = 50;
