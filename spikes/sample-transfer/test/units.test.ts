// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHUNK_HEADER_BYTES,
  decodeChunk,
  DelayBasedWindow,
  encodeChunk,
  parseTransferMessage,
  type ProgressEvent,
  ProgressReporter,
} from '../src';

const id = '0123456789abcdef'.repeat(4);

describe('chunk frames', () => {
  it('round-trip id, generation, offset and bytes', () => {
    const bytes = Buffer.from('hello, sample');
    const frame = encodeChunk(id, 7, 2 ** 40 + 3, bytes);
    expect(frame.length).toBe(CHUNK_HEADER_BYTES + bytes.length);
    expect(decodeChunk(frame)).toEqual({ id, gen: 7, offset: 2 ** 40 + 3, bytes });
  });

  it('refuse frames too short for a header', () => {
    expect(decodeChunk(Buffer.alloc(CHUNK_HEADER_BYTES - 1))).toBeUndefined();
  });
});

describe('control messages', () => {
  it('accept well-formed messages', () => {
    expect(parseTransferMessage({ t: 'want', id, offset: 0, gen: 1 })).toEqual({ t: 'want', id, offset: 0, gen: 1 });
    expect(parseTransferMessage({ t: 'ack', id, received: 5 })).toEqual({ t: 'ack', id, received: 5 });
  });

  it('refuse anything malformed, including ids that are not hashes', () => {
    for (const bad of [
      null,
      'want',
      { t: 'want', id: '../../etc/passwd', offset: 0, gen: 1 },
      { t: 'want', id: id.toUpperCase(), offset: 0, gen: 1 },
      { t: 'want', id, offset: -1, gen: 1 },
      { t: 'want', id, offset: 1.5, gen: 1 },
      { t: 'have', id, gen: 1 },
      { t: 'teleport', id },
    ]) {
      expect(parseTransferMessage(bad)).toBeUndefined();
    }
  });
});

describe('progress reporter', () => {
  afterEach(() => vi.useRealTimers());

  it('emits at most once per interval, keeps the last count of a burst, and sends state changes at once', () => {
    vi.useFakeTimers();
    const events: ProgressEvent[] = [];
    const reporter = new ProgressReporter((event) => events.push(event), 50, () => Date.now());

    reporter.update(id, 'transferring', 0, 1000);
    for (let i = 1; i <= 100; i += 1) {
      vi.advanceTimersByTime(1);
      reporter.update(id, 'transferring', i * 10, 1000);
    }
    // 100 updates over 100 ms: the first at once, then the latest held count every 50 ms.
    expect(events.map((event) => event.bytes)).toEqual([0, 490, 990]);
    vi.advanceTimersByTime(50);
    expect(events.map((event) => event.bytes)).toEqual([0, 490, 990, 1000]);

    reporter.update(id, 'transferring', 1000, 1000);
    reporter.update(id, 'done', 1000, 1000);
    expect(events.at(-1)?.state).toBe('done');
    expect(events.at(-2)?.state).toBe('transferring');
    vi.advanceTimersByTime(1000);
    expect(events.at(-1)?.state).toBe('done');
  });

  it('works out a rate over about the last second', () => {
    vi.useFakeTimers();
    const events: ProgressEvent[] = [];
    const reporter = new ProgressReporter((event) => events.push(event), 0, () => Date.now());
    for (let ms = 0; ms <= 3000; ms += 100) {
      reporter.update(id, 'transferring', ms * 1000, undefined);
      vi.advanceTimersByTime(100);
    }
    expect(events.at(-1)?.bytesPerSecond).toBeCloseTo(1_000_000, -3);
  });
});

describe('delay-based window', () => {
  const chunk = 64 * 1024;

  /** Send and acknowledge whole windows, each acknowledgement taking `rtt(round)` ms. Returns the window after each round. */
  function run(window: DelayBasedWindow, rounds: number, rtt: (round: number) => number): number[] {
    let t = 0;
    let sent = 0;
    const sizes: number[] = [];
    for (let round = 0; round < rounds; round += 1) {
      const start = sent;
      while (sent - start < window.bytes) {
        sent += chunk;
        window.sent(sent, t);
      }
      t += rtt(round);
      for (let end = start + chunk; end <= sent; end += chunk) window.acked(end, t);
      sizes.push(window.bytes);
    }
    return sizes;
  }

  it('grows while acknowledgements come back as fast as the fastest seen', () => {
    const window = new DelayBasedWindow({ chunkBytes: chunk });
    const sizes = run(window, 50, () => 40);
    expect(sizes.at(-1)).toBeGreaterThan(sizes[0] ?? Infinity);
    // About one chunk more per round trip, as RFC 6817 has it.
    expect(sizes.at(-1)).toBeGreaterThan(45 * chunk);
    expect(sizes.at(-1)).toBeLessThan(60 * chunk);
  });

  it('shrinks once the extra delay goes over the target, and settles near it', () => {
    const window = new DelayBasedWindow({ chunkBytes: chunk, targetMs: 25, initialBytes: 64 * chunk });
    // The first round finds the empty-queue time; after that, delay grows with the window, as a queue would.
    const sizes = run(window, 200, (round) => (round === 0 ? 40 : 40 + (window.bytes / (5 * 1024 * 1024)) * 1000));
    // 25 ms of queue at 5 MB/s is about 128 KiB: the window should end up within a few chunks of that.
    expect(sizes.at(-1)).toBeLessThan(64 * chunk);
    expect(Math.abs((window.lastQueueMs ?? Infinity) - 25)).toBeLessThan(10);
  });

  it('does not count the bytes a resumed stream already had as acknowledged', () => {
    const offset = 100 * 1024 * 1024;
    const window = new DelayBasedWindow({ chunkBytes: chunk, startOffset: offset });
    const before = window.bytes;
    window.sent(offset + chunk, 0);
    window.acked(offset + chunk, 40);
    expect(window.bytes - before).toBeLessThanOrEqual(chunk);
  });

  it('stays between its smallest and largest size', () => {
    const tiny = new DelayBasedWindow({ chunkBytes: chunk });
    run(tiny, 30, (round) => (round === 0 ? 10 : 1_000));
    expect(tiny.bytes).toBe(2 * chunk);
    const capped = new DelayBasedWindow({ chunkBytes: chunk, maxBytes: 10 * chunk });
    run(capped, 100, () => 10);
    expect(capped.bytes).toBe(10 * chunk);
  });

  it('forgets an old baseline, so a route that got slower for good is not mistaken for a queue', () => {
    const window = new DelayBasedWindow({ chunkBytes: chunk, baseHistoryMs: 20_000 });
    run(window, 5, () => 20);
    expect(window.baseMs).toBe(20);
    run(window, 1_000, () => 80);
    expect(window.baseMs).toBe(80);
  });
});
