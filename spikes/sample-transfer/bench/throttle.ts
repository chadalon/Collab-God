// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A TCP proxy that imitates a slow home connection on one machine: each
 * direction is limited to a bit rate and delayed by a fixed time. It queues
 * without limit, as a home router with a deep buffer does, so whatever the
 * transfer keeps in flight shows up as waiting time for everything behind it.
 *
 *   npx tsx bench/throttle.ts --listen 8100 --to 127.0.0.1:8099 --mbit 40 --delay-ms 15
 *
 * Then point `fetch` at ws://127.0.0.1:8100 instead of the relay.
 */

import { connect, createServer, type Socket } from 'node:net';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    listen: { type: 'string', default: '8100' },
    to: { type: 'string', default: '127.0.0.1:8099' },
    mbit: { type: 'string', default: '40' },
    'delay-ms': { type: 'string', default: '15' },
  },
});

const bytesPerMs = (Number(values.mbit) * 1_000_000) / 8 / 1000;
const delayMs = Number(values['delay-ms']);
const [host = '127.0.0.1', port = '8099'] = values.to.split(':');

/**
 * Copy `from` to `to`, releasing each piece no sooner than the rate and delay
 * allow. One queue and one timer per direction, so pieces leave in the order
 * they came: separate timers can fire out of order when their times round to
 * the same millisecond, which corrupts the stream.
 */
function shape(from: Socket, to: Socket): void {
  const queue: { at: number; data: Buffer }[] = [];
  let lineFreeAt = 0;
  let timer: NodeJS.Timeout | undefined;
  let ended = false;
  const drain = () => {
    timer = undefined;
    const now = performance.now();
    while (queue.length > 0 && (queue[0]?.at ?? Infinity) <= now) to.write(queue.shift()?.data ?? Buffer.alloc(0));
    if (queue.length > 0) timer = setTimeout(drain, Math.max(0, (queue[0]?.at ?? now) - now));
    else if (ended) to.destroy();
  };
  from.on('data', (data: Buffer) => {
    const now = performance.now();
    lineFreeAt = Math.max(now, lineFreeAt) + data.length / bytesPerMs;
    queue.push({ at: lineFreeAt + delayMs, data });
    timer ??= setTimeout(drain, Math.max(0, lineFreeAt + delayMs - now));
  });
  from.on('close', () => {
    ended = true;
    timer ??= setTimeout(drain, 0);
  });
  from.on('error', () => {});
  to.on('error', () => {});
}

createServer((client) => {
  const upstream = connect(Number(port), host);
  shape(client, upstream);
  shape(upstream, client);
}).listen(Number(values.listen), '127.0.0.1', () => {
  console.log(`127.0.0.1:${values.listen} -> ${values.to} at ${values.mbit} Mbit/s, ${delayMs} ms each way`);
});
