// SPDX-License-Identifier: GPL-3.0-or-later

import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { type FileHandle, mkdir, open, rename, stat, truncate, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { RelayClient } from '../../relay/src/client';
import { ProgressReporter, type ProgressEvent } from './progress';
import {
  type ContentId,
  contentIdOfFile,
  decodeChunk,
  DEFAULT_PROGRESS_INTERVAL_MS,
  isContentId,
  parseTransferMessage,
  type TransferMessage,
} from './protocol';

export type TransferErrorCode =
  /** The member asked does not have the sample. */
  | 'missing'
  /** The member sending it left the lobby. The partial file is kept. */
  | 'source-left'
  /** This connection closed. The partial file is kept. */
  | 'connection-closed'
  /** Every byte arrived but the hash did not match. The partial file is deleted. */
  | 'hash-mismatch'
  /** The sender sent more bytes than it said the file has. The partial file is deleted. */
  | 'too-large'
  /** This machine is already fetching the same sample into the same folder. */
  | 'busy';

export class TransferError extends Error {
  constructor(
    readonly code: TransferErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface FetchOptions {
  readonly id: ContentId;
  /** Client id of the member to ask. */
  readonly from: string;
  /**
   * Folder that holds received samples, one file per content id (SMP-6: stored
   * with the project, not in the user's library). A partial file sits next to
   * it as `<id>.part` and is where a resume starts from.
   */
  readonly dir: string;
  readonly onProgress?: (event: ProgressEvent) => void;
  readonly progressIntervalMs?: number;
  /** Ask again from the last byte received if nothing arrives for this long. Covers dropped frames. Default 5 seconds. */
  readonly stallMs?: number;
}

export interface FetchResult {
  readonly path: string;
  readonly size: number;
  /** Bytes already on disk when this fetch started. */
  readonly resumedFrom: number;
  /** Bytes that came over the network in this fetch. */
  readonly received: number;
  /** Times this fetch asked again after a gap or a stall. */
  readonly rerequests: number;
}

const active = new Set<string>();

/**
 * Fetch one sample from one member, resuming from whatever partial file is on
 * disk. All resume state is that file: if the connection drops, the process
 * stops, or the sender leaves, calling this again, on any connection and from
 * any member who has the sample, carries on from where the file ends.
 *
 * The content hash is computed as the bytes arrive, so checking it at the end
 * costs nothing. Only a resume rereads the bytes already on disk.
 */
export async function fetchSample(client: RelayClient, options: FetchOptions): Promise<FetchResult> {
  const { id, dir } = options;
  if (!isContentId(id)) throw new Error(`not a content id: ${id}`);
  const final = join(dir, id);
  const part = `${final}.part`;
  if (active.has(final)) throw new TransferError('busy', `already fetching ${id} into ${dir}`);
  active.add(final);

  const progress = new ProgressReporter((event) => options.onProgress?.(event), options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS);
  try {
    await mkdir(dir, { recursive: true });

    // Already here and intact: nothing to do.
    const existing = await stat(final).catch(() => undefined);
    if (existing !== undefined) {
      if ((await contentIdOfFile(final)) === id) {
        progress.update(id, 'done', existing.size, existing.size);
        return { path: final, size: existing.size, resumedFrom: existing.size, received: 0, rerequests: 0 };
      }
      await unlink(final);
    }

    const resumedFrom = (await stat(part).catch(() => undefined))?.size ?? 0;
    const hash = createHash('sha256');
    if (resumedFrom > 0) for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
    const file = await open(part, 'a');
    return await receive(client, options, { file, hash, part, final, resumedFrom, progress });
  } catch (error) {
    if (error instanceof TransferError) throw error;
    progress.update(id, 'failed', 0, undefined, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    progress.dispose();
    active.delete(final);
  }
}

interface ReceiveState {
  readonly file: FileHandle;
  hash: Hash;
  readonly part: string;
  readonly final: string;
  readonly resumedFrom: number;
  readonly progress: ProgressReporter;
}

function receive(client: RelayClient, options: FetchOptions, state: ReceiveState): Promise<FetchResult> {
  const { id, from } = options;
  const stallMs = options.stallMs ?? 5_000;
  const { file, part, final, progress } = state;

  let gen = 0;
  let size: number | undefined;
  /** Next byte this fetch will accept. Ahead of `written` while writes are queued. */
  let expected = state.resumedFrom;
  /** Bytes in the partial file. */
  let written = state.resumedFrom;
  let received = 0;
  let rerequests = 0;
  let lastArrival = Date.now();
  let writes: Promise<void> = Promise.resolve();
  let finished = false;

  return new Promise<FetchResult>((resolve, reject) => {
    const stops: (() => void)[] = [];
    const cleanup = async () => {
      finished = true;
      for (const stop of stops) stop();
      await writes.catch(() => {});
      await file.close().catch(() => {});
    };

    const fail = async (code: TransferErrorCode, message: string, discard: boolean) => {
      if (finished) return;
      await cleanup();
      if (client.open) client.sendDirect(from, { t: 'cancel', id } satisfies TransferMessage);
      if (discard) await unlink(part).catch(() => {});
      progress.update(id, 'failed', discard ? 0 : written, size, message);
      reject(new TransferError(code, message));
    };

    const succeed = async () => {
      if (finished) return;
      await cleanup();
      progress.update(id, 'verifying', written, size);
      const actual = state.hash.digest('hex');
      if (actual !== id) {
        await unlink(part).catch(() => {});
        progress.update(id, 'failed', 0, size, `content hash ${actual} does not match ${id}`);
        reject(new TransferError('hash-mismatch', `received ${written} bytes hashing to ${actual}, expected ${id}`));
        return;
      }
      await rename(part, final);
      progress.update(id, 'done', written, size);
      resolve({ path: final, size: written, resumedFrom: state.resumedFrom, received, rerequests });
    };

    const ask = (offset: number) => {
      gen += 1;
      lastArrival = Date.now();
      client.sendDirect(from, { t: 'want', id, offset, gen } satisfies TransferMessage);
    };

    /** Start again from nothing: the partial file was longer than the sample. */
    const restart = async () => {
      writes = writes.then(async () => {
        await truncate(part, 0);
      });
      await writes;
      state.hash = createHash('sha256');
      expected = 0;
      written = 0;
      ask(0);
    };

    stops.push(
      client.onMessage((message) => {
        if (message.type === 'peer-left' && message.clientId === from) {
          void fail('source-left', `${from} left before the transfer finished`, false);
          return;
        }
        if (message.type !== 'direct' || message.from !== from) return;
        const parsed = parseTransferMessage(message.data);
        if (parsed === undefined || parsed.id !== id) return;
        if (parsed.t === 'missing' && parsed.gen === gen) {
          void fail('missing', `${from} does not have ${id}`, false);
        } else if (parsed.t === 'have' && parsed.gen === gen) {
          size = parsed.size;
          if (written > size) {
            void restart();
          } else if (written === size) {
            void succeed();
          } else {
            progress.update(id, 'transferring', written, size);
          }
        }
      }),
      client.onBinary((sender, payload) => {
        if (sender !== from || finished) return;
        const chunk = decodeChunk(payload);
        if (chunk === undefined || chunk.id !== id || chunk.gen !== gen || size === undefined) return;
        if (chunk.offset !== expected) {
          // A frame was lost (the relay drops frames for a member it holds too
          // much for). Everything after it in this generation is useless: ask
          // again from the first missing byte.
          rerequests += 1;
          ask(expected);
          return;
        }
        if (expected + chunk.bytes.length > size) {
          void fail('too-large', `${from} sent past the ${size} bytes it announced`, true);
          return;
        }
        lastArrival = Date.now();
        state.hash.update(chunk.bytes);
        expected += chunk.bytes.length;
        received += chunk.bytes.length;
        const bytes = chunk.bytes;
        writes = writes.then(async () => {
          if (finished) return;
          await file.write(bytes);
          written += bytes.length;
          client.sendDirect(from, { t: 'ack', id, received: written } satisfies TransferMessage);
          progress.update(id, 'transferring', written, size);
          if (written === size) void succeed();
        });
        writes.catch((error: unknown) => void fail('connection-closed', `could not write ${part}: ${String(error)}`, false));
      }),
      client.onClose(() => void fail('connection-closed', 'the connection to the relay closed', false)),
    );

    const watchdog = setInterval(() => {
      if (!finished && Date.now() - lastArrival > stallMs) {
        rerequests += 1;
        ask(expected);
      }
    }, Math.max(10, Math.floor(stallMs / 4)));
    stops.push(() => clearInterval(watchdog));

    if (!client.open) {
      void fail('connection-closed', 'the connection to the relay is not open', false);
      return;
    }
    progress.update(id, 'waiting', written, undefined);
    ask(written);
  });
}
