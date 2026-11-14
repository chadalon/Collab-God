// SPDX-License-Identifier: GPL-3.0-or-later

import { performance } from 'node:perf_hooks';
import type { ContentId } from './protocol';

export type TransferState =
  /** Asking a member for the sample, or waiting for one who has it. */
  | 'waiting'
  /** Bytes are arriving (or, on the sending side, leaving). */
  | 'transferring'
  /** Every byte is on disk and its hash is being checked. */
  | 'verifying'
  /** The file is in place and its content id matched. */
  | 'done'
  /** Stopped. `error` says why. A partial file stays on disk for a later resume unless it failed verification. */
  | 'failed';

/** What a clip needs to draw a transfer: how far along, and what is happening. */
export interface ProgressEvent {
  readonly id: ContentId;
  readonly state: TransferState;
  /** Bytes on disk (receiving) or acknowledged by the receiver (sending). */
  readonly bytes: number;
  /** Total size, once the sender has said. */
  readonly size: number | undefined;
  /** Average over the last second or so, for an "x MB/s" or time-left label. */
  readonly bytesPerSecond: number;
  readonly error?: string;
}

/**
 * Turns a stream of byte counts into progress events at a bounded rate. A count
 * goes out at once if `intervalMs` has passed since the last event; otherwise it
 * is held and goes out when the interval ends, so the last count of a burst is
 * never lost. A change of state always goes out at once, so `done` and `failed`
 * are never delayed or merged away.
 */
export class ProgressReporter {
  private lastEmitAt = -Infinity;
  private lastEmitted: ProgressEvent | undefined;
  private pending: ProgressEvent | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly rateSamples: { t: number; bytes: number }[] = [];

  constructor(
    private readonly emit: (event: ProgressEvent) => void,
    private readonly intervalMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  update(id: ContentId, state: TransferState, bytes: number, size: number | undefined, error?: string): void {
    const t = this.now();
    this.rateSamples.push({ t, bytes });
    while (this.rateSamples.length > 2 && (this.rateSamples[0]?.t ?? t) < t - 1_000) this.rateSamples.shift();
    const first = this.rateSamples[0];
    const elapsed = first === undefined ? 0 : t - first.t;
    const bytesPerSecond = first === undefined || elapsed <= 0 ? 0 : ((bytes - first.bytes) * 1_000) / elapsed;
    const event: ProgressEvent = { id, state, bytes, size, bytesPerSecond: Math.max(0, bytesPerSecond), ...(error === undefined ? {} : { error }) };

    const stateChanged = this.lastEmitted?.state !== state;
    if (stateChanged || t - this.lastEmitAt >= this.intervalMs) {
      this.flush(event, t);
      return;
    }
    this.pending = event;
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.pending !== undefined) this.flush(this.pending, this.now());
      }, this.intervalMs - (t - this.lastEmitAt));
    }
  }

  /** Stop any held event from going out later. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  private flush(event: ProgressEvent, t: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.lastEmitAt = t;
    this.lastEmitted = event;
    this.emit(event);
  }
}
