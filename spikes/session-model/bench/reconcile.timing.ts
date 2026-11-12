// SPDX-License-Identifier: GPL-3.0-or-later

import { it } from 'vitest';

declare const console: { log(message: string): void };
import { apply, fold, type Op, Replica, type SessionState } from '../src';

/**
 * Rough timings for the naive implementation, to decide whether the production
 * model needs structural sharing. Run with `npm run timing`. Not part of `npm test`.
 */

/** A session the size of a busy real project: 50 tracks, 5,000 clips. */
function bigSession(): SessionState {
  const ops: Op[] = [];
  for (let t = 0; t < 50; t += 1) {
    ops.push({ type: 'track.add', track: { id: `t${t}`, name: `Track ${t}` }, index: t });
  }
  for (let c = 0; c < 5000; c += 1) {
    ops.push({
      type: 'clip.add',
      clip: { id: `c${c}`, trackId: `t${c % 50}`, start: c * 4, length: 4, sampleHash: `h${c % 200}` },
    });
  }
  return fold(ops.map((op, i) => ({ opId: `seed:${i}`, op })));
}

const move = (n: number): Op => ({ type: 'clip.move', id: `c${n % 5000}`, trackId: `t${n % 50}`, start: 100_000 + n });

function time(label: string, iterations: number, body: (i: number) => void): void {
  for (let i = 0; i < Math.min(iterations, 50); i += 1) body(i); // warm up
  const started = Date.now();
  for (let i = 0; i < iterations; i += 1) body(i);
  const perCall = (Date.now() - started) / iterations;
  console.log(`${label}: ${perCall.toFixed(3)} ms per call (${iterations} calls)`);
}

it('timings on 5,000 clips across 50 tracks', () => {
  const big = bigSession();

  time('apply one clip move', 2000, (i) => {
    apply(big, move(i), `x:${i}`);
  });

  const replica = new Replica('me', () => undefined, big);
  for (let i = 0; i < 20; i += 1) replica.edit(move(i));
  time('receive one remote edit with 20 local edits unconfirmed', 500, (i) => {
    replica.receive({ seq: replica.seq + 1, opId: `them:${replica.seq}`, clientId: 'them', op: move(4000 + i) });
  });

  time('remove and restore a track holding 100 clips', 500, () => {
    const removed = apply(big, { type: 'track.remove', id: 't7' }, 'x:1');
    if (removed.applied) apply(removed.state, removed.inverse, 'x:2');
  });
});
