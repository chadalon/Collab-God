// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * How many unacknowledged bytes a stream may have in flight.
 *
 * Whatever is in flight beyond what the slowest link can carry in one round
 * trip sits in a queue somewhere, usually the receiver's home router, and every
 * edit and ping on that connection waits behind it. A fixed window is therefore
 * either too small for a fast, far connection or adds hundreds of milliseconds
 * to edits on a slow one (see the README's findings).
 *
 * The delay-based window follows LEDBAT (RFC 6817), the algorithm made for
 * background transfers that should get out of the way: it watches how long
 * acknowledgements take, treats the shortest time seen as the empty-queue
 * baseline, and grows the window while the extra delay is under a target and
 * shrinks it when the delay goes over. Samples are a background job next to
 * the edits that matter more.
 */
export interface WindowControl {
  /** Bytes allowed in flight now. */
  readonly bytes: number;
  /** Bytes before `end` have just been sent, at time `t` in milliseconds. */
  sent(end: number, t: number): void;
  /** Everything before `received` is acknowledged, at time `t`. */
  acked(received: number, t: number): void;
}

export class FixedWindow implements WindowControl {
  constructor(readonly bytes: number) {}
  sent(): void {}
  acked(): void {}
}

export interface DelayBasedWindowOptions {
  readonly chunkBytes: number;
  /** Extra queueing delay to aim for, in milliseconds. RFC 6817 allows up to 100; edits want much less. Default 25. */
  readonly targetMs?: number;
  /** Window at the start, before any measurement. Default 4 chunks. */
  readonly initialBytes?: number;
  /** Smallest window. Default 2 chunks, so a stream never stalls entirely. */
  readonly minBytes?: number;
  /** Largest window. Default 32 MiB. */
  readonly maxBytes?: number;
  /** How fast the window moves. RFC 6817 says at most 1. Default 1. */
  readonly gain?: number;
  /** How long a baseline measurement is trusted, so a route that got slower is noticed. Default 60 s. */
  readonly baseHistoryMs?: number;
  /** Offset the stream starts at. A resumed stream's first acknowledgement must not count the bytes it already had. */
  readonly startOffset?: number;
}

export class DelayBasedWindow implements WindowControl {
  private window: number;
  private readonly chunk: number;
  private readonly target: number;
  private readonly min: number;
  private readonly max: number;
  private readonly gain: number;
  private readonly baseHistoryMs: number;
  /** Send time of each chunk not yet acknowledged, by the offset it ends at. Oldest first. */
  private readonly inFlight: { end: number; t: number }[] = [];
  /** Shortest round trip in each 10-second bucket, oldest first. The baseline is the shortest of these. */
  private readonly baseBuckets: { start: number; min: number }[] = [];
  private lastAcked: number;
  /** Last round trip and queueing delay seen, for reports. */
  lastRttMs: number | undefined;
  lastQueueMs: number | undefined;

  constructor(options: DelayBasedWindowOptions) {
    this.chunk = options.chunkBytes;
    this.target = options.targetMs ?? 25;
    this.min = options.minBytes ?? 2 * this.chunk;
    this.max = options.maxBytes ?? 32 * 1024 * 1024;
    this.gain = options.gain ?? 1;
    this.baseHistoryMs = options.baseHistoryMs ?? 60_000;
    this.window = Math.min(this.max, Math.max(this.min, options.initialBytes ?? 4 * this.chunk));
    this.lastAcked = options.startOffset ?? 0;
  }

  get bytes(): number {
    return this.window;
  }

  /** Shortest round trip seen recently: the delay with an empty queue. */
  get baseMs(): number | undefined {
    if (this.baseBuckets.length === 0) return undefined;
    return Math.min(...this.baseBuckets.map((bucket) => bucket.min));
  }

  sent(end: number, t: number): void {
    this.inFlight.push({ end, t });
  }

  acked(received: number, t: number): void {
    if (received <= this.lastAcked) return;
    const newlyAcked = received - this.lastAcked;
    this.lastAcked = received;
    let sentAt: number | undefined;
    while (this.inFlight.length > 0 && (this.inFlight[0]?.end ?? Infinity) <= received) sentAt = this.inFlight.shift()?.t;
    if (sentAt === undefined) return;

    const rtt = t - sentAt;
    this.recordBase(rtt, t);
    const base = this.baseMs ?? rtt;
    const queue = rtt - base;
    this.lastRttMs = rtt;
    this.lastQueueMs = queue;
    // RFC 6817 section 2.4.2: grow in proportion to how far under target the
    // delay is, by about one chunk per window's worth of acknowledged bytes.
    const offTarget = (this.target - queue) / this.target;
    const change = (this.gain * offTarget * newlyAcked * this.chunk) / this.window;
    this.window = Math.min(this.max, Math.max(this.min, this.window + change));
  }

  private recordBase(rtt: number, t: number): void {
    const last = this.baseBuckets.at(-1);
    if (last === undefined || t - last.start >= 10_000) this.baseBuckets.push({ start: t, min: rtt });
    else last.min = Math.min(last.min, rtt);
    while (this.baseBuckets.length > 1 && t - (this.baseBuckets[0]?.start ?? t) > this.baseHistoryMs) this.baseBuckets.shift();
  }
}
