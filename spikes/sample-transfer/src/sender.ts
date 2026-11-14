// SPDX-License-Identifier: GPL-3.0-or-later

import { type FileHandle, open } from 'node:fs/promises';
import type { RelayClient } from '../../relay/src/client';
import { ProgressReporter, type ProgressEvent } from './progress';
import { DelayBasedWindow, FixedWindow, type WindowControl } from './window';
import { performance } from 'node:perf_hooks';
import {
  type ContentId,
  DEFAULT_CHUNK_BYTES,
  DEFAULT_PROGRESS_INTERVAL_MS,
  encodeChunk,
  parseTransferMessage,
  type TransferMessage,
} from './protocol';

export interface SampleServerOptions {
  /** Bytes of file per chunk. Default 128 KiB. */
  readonly chunkBytes?: number;
  /**
   * Most bytes sent and not yet acknowledged, per stream. Leave it out for a
   * delay-based window that keeps queueing delay near `targetDelayMs`, which is
   * what keeps edits quick during a transfer (see `window.ts`).
   */
  readonly windowBytes?: number;
  /** Extra delay the delay-based window aims to add to the connection, in milliseconds. Default 25. */
  readonly targetDelayMs?: number;
  /** Progress of each upload, by acknowledged bytes, at most once per `progressIntervalMs`. */
  readonly onProgress?: (peer: string, event: ProgressEvent) => void;
  readonly progressIntervalMs?: number;
}

interface Stream {
  readonly peer: string;
  readonly id: ContentId;
  readonly gen: number;
  readonly file: FileHandle;
  readonly size: number;
  readonly progress: ProgressReporter;
  readonly window: WindowControl;
  /** Next byte to read and send. */
  next: number;
  /** Everything before this the receiver has written. */
  acked: number;
  pumping: boolean;
  closed: boolean;
  retry: NodeJS.Timeout | undefined;
}

/**
 * Serves samples this machine has to other members who ask for them. It answers
 * only for content ids that `lookup` knows, and reads the file `lookup` names on
 * this machine; the path never goes over the network.
 *
 * Each request is a stream with its own window. A stream ends when the receiver
 * has acknowledged every byte, asks again (a new generation replaces it), cancels,
 * or leaves. Nothing about a stream outlives it: a receiver that comes back
 * simply asks again from the offset it has on disk.
 */
export class SampleServer {
  private readonly streams = new Map<string, Stream>();
  private readonly chunkBytes: number;
  private readonly progressIntervalMs: number;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(
    private readonly client: RelayClient,
    private readonly lookup: (id: ContentId) => string | undefined,
    private readonly options: SampleServerOptions = {},
  ) {
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.unsubscribe.push(
      client.onMessage((message) => {
        if (message.type === 'direct') {
          const parsed = parseTransferMessage(message.data);
          if (parsed !== undefined) void this.handle(message.from, parsed);
        } else if (message.type === 'peer-left') {
          for (const stream of [...this.streams.values()]) if (stream.peer === message.clientId) void this.end(stream, 'failed', 'receiver left');
        }
      }),
      client.onClose(() => this.stop()),
    );
  }

  /** Streams currently sending. */
  get active(): number {
    return this.streams.size;
  }

  /** Window of each stream now, for reports. */
  windows(): { peer: string; id: ContentId; bytes: number; rttMs?: number; queueMs?: number }[] {
    return [...this.streams.values()].map((stream) => ({
      peer: stream.peer,
      id: stream.id,
      bytes: stream.window.bytes,
      ...(stream.window instanceof DelayBasedWindow && stream.window.lastRttMs !== undefined ? { rttMs: stream.window.lastRttMs } : {}),
      ...(stream.window instanceof DelayBasedWindow && stream.window.lastQueueMs !== undefined ? { queueMs: stream.window.lastQueueMs } : {}),
    }));
  }

  /** End every stream and stop listening. */
  stop(): void {
    for (const stream of [...this.streams.values()]) void this.end(stream, 'failed', 'sender stopped');
    for (const stop of this.unsubscribe) stop();
    this.unsubscribe.length = 0;
  }

  private async handle(peer: string, message: TransferMessage): Promise<void> {
    const key = `${peer}/${message.id}`;
    const current = this.streams.get(key);
    switch (message.t) {
      case 'want': {
        if (current !== undefined) await this.end(current, 'failed', 'replaced by a new request');
        const path = this.lookup(message.id);
        if (path === undefined) {
          this.client.sendDirect(peer, { t: 'missing', id: message.id, gen: message.gen } satisfies TransferMessage);
          return;
        }
        let file: FileHandle;
        let size: number;
        try {
          file = await open(path, 'r');
          size = (await file.stat()).size;
        } catch {
          this.client.sendDirect(peer, { t: 'missing', id: message.id, gen: message.gen } satisfies TransferMessage);
          return;
        }
        // Another request for the same id may have arrived while the file was opening.
        const raced = this.streams.get(key);
        if (raced !== undefined) {
          if (raced.gen > message.gen) {
            await file.close();
            return;
          }
          await this.end(raced, 'failed', 'replaced by a new request');
        }
        const offset = Math.min(message.offset, size);
        const stream: Stream = {
          peer,
          id: message.id,
          gen: message.gen,
          file,
          size,
          progress: new ProgressReporter((event) => this.options.onProgress?.(peer, event), this.progressIntervalMs),
          window:
            this.options.windowBytes === undefined
              ? new DelayBasedWindow({
                  chunkBytes: this.chunkBytes,
                  startOffset: offset,
                  ...(this.options.targetDelayMs === undefined ? {} : { targetMs: this.options.targetDelayMs }),
                })
              : new FixedWindow(this.options.windowBytes),
          next: offset,
          acked: offset,
          pumping: false,
          closed: false,
          retry: undefined,
        };
        this.streams.set(key, stream);
        this.client.sendDirect(peer, { t: 'have', id: message.id, size, gen: message.gen } satisfies TransferMessage);
        stream.progress.update(stream.id, 'transferring', stream.acked, size);
        if (offset >= size) {
          await this.end(stream, 'done');
          return;
        }
        void this.pump(stream);
        return;
      }
      case 'ack': {
        if (current === undefined) return;
        current.acked = Math.max(current.acked, Math.min(message.received, current.size));
        current.window.acked(current.acked, performance.now());
        current.progress.update(current.id, 'transferring', current.acked, current.size);
        if (current.acked >= current.size) await this.end(current, 'done');
        else void this.pump(current);
        return;
      }
      case 'cancel':
        if (current !== undefined) await this.end(current, 'failed', 'cancelled by the receiver');
        return;
      default:
        return;
    }
  }

  /** Send chunks while the window and the local socket buffer allow. One pump per stream at a time. */
  private async pump(stream: Stream): Promise<void> {
    if (stream.pumping || stream.closed) return;
    stream.pumping = true;
    try {
      while (!stream.closed && stream.next < stream.size && stream.next - stream.acked < stream.window.bytes) {
        if (!this.client.open) return;
        if (this.client.bufferedAmount >= stream.window.bytes) {
          // The connection to the relay is the bottleneck. Try again shortly rather than queue more in memory.
          stream.retry ??= setTimeout(() => {
            stream.retry = undefined;
            void this.pump(stream);
          }, 5);
          return;
        }
        const length = Math.min(this.chunkBytes, stream.size - stream.next);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await stream.file.read(buffer, 0, length, stream.next);
        if (stream.closed) return;
        if (bytesRead === 0) {
          await this.end(stream, 'failed', 'file got shorter while sending');
          return;
        }
        this.client.sendBinary(stream.peer, encodeChunk(stream.id, stream.gen, stream.next, buffer.subarray(0, bytesRead)));
        stream.next += bytesRead;
        stream.window.sent(stream.next, performance.now());
      }
    } catch (error) {
      await this.end(stream, 'failed', error instanceof Error ? error.message : String(error));
    } finally {
      stream.pumping = false;
    }
  }

  private async end(stream: Stream, state: 'done' | 'failed', error?: string): Promise<void> {
    if (stream.closed) return;
    stream.closed = true;
    if (stream.retry !== undefined) clearTimeout(stream.retry);
    const key = `${stream.peer}/${stream.id}`;
    if (this.streams.get(key) === stream) this.streams.delete(key);
    stream.progress.update(stream.id, state, stream.acked, stream.size, error);
    stream.progress.dispose();
    await stream.file.close().catch(() => {});
  }
}
