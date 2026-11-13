// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The session-model spike proved convergence with a simulated network. This
 * runs the same `Replica` over real WebSockets through the real relay, with two
 * people editing at once and a third joining late.
 */

import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonical, fold } from '../../session-model/src';
import type { Replica } from '../../session-model/src/replica';
import type { Sequenced } from '../../session-model/src/relay';
import { type Dice, idSource, randomOp, runs, SEED } from '../../session-model/test/sim';
import { linkReplica, RelayClient, type RelayServer, startRelayServer } from '../src';
import { until } from './helpers';

let server: RelayServer;
beforeAll(async () => {
  server = await startRelayServer({ port: 0, host: '127.0.0.1', emptyRoomTtlMs: 1_000 });
});
afterAll(() => server.close());

const connect = () => RelayClient.connect(server.url, { allowInsecure: true });

/** One step a person takes: an edit, an undo or a redo, then a pause of a random kind. */
const step = fc.record({
  action: fc.constantFrom('edit', 'edit', 'edit', 'edit', 'undo', 'redo'),
  dice: fc.tuple(fc.nat(), fc.nat(), fc.nat(), fc.nat()),
  pause: fc.constantFrom('none', 'microtask', 'immediate', 'timer'),
});
type Step = typeof step extends fc.Arbitrary<infer T> ? T : never;

const pause = (kind: Step['pause']): Promise<void> | undefined => {
  switch (kind) {
    case 'none':
      return undefined;
    case 'microtask':
      return Promise.resolve();
    case 'immediate':
      return new Promise((resolve) => setImmediate(resolve));
    case 'timer':
      return new Promise((resolve) => setTimeout(resolve, 1));
  }
};

/** A person working through their steps, each against whatever their own view shows at that moment. */
async function work(replica: Replica, steps: readonly Step[], freshId: () => string): Promise<void> {
  for (const { action, dice, pause: kind } of steps) {
    if (action === 'undo') replica.undo();
    else if (action === 'redo') replica.redo();
    else {
      const op = randomOp(replica.view, dice as Dice, freshId);
      if (op !== undefined) replica.edit(op);
    }
    await pause(kind);
  }
}

const settled = (replicas: readonly Replica[]) => () =>
  replicas.every((r) => r.unconfirmed.length === 0 && r.seq === replicas[0]?.seq);

describe('two people editing at once over real sockets', () => {
  it('end in the same state as the relay’s log, and so does someone who joins afterwards', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(step, { maxLength: 40 }),
        fc.array(step, { maxLength: 40 }),
        fc.nat({ max: SEED.length }),
        async (stepsA, stepsB, seededBeforeJoin) => {
          const hostClient = await connect();
          const { code } = await hostClient.create();
          const a = linkReplica(hostClient);

          // A builds part of the session before B arrives, so B starts by catching up.
          SEED.slice(0, seededBeforeJoin).forEach((op) => a.edit(op));
          const guestClient = await connect();
          await guestClient.join(code);
          const b = linkReplica(guestClient);
          SEED.slice(seededBeforeJoin).forEach((op) => a.edit(op));

          await Promise.all([work(a, stepsA, idSource('a')), work(b, stepsB, idSource('b'))]);
          await until(settled([a, b]), 'both replicas are settled');

          const log = hostClient.log as readonly Sequenced[];
          expect(guestClient.log).toEqual(log);
          expect(canonical(a.view)).toBe(canonical(fold(log)));
          expect(canonical(b.view)).toBe(canonical(a.view));

          await guestClient.close();
          const lateClient = await connect();
          await lateClient.join(code);
          const late = linkReplica(lateClient);
          expect(late.seq).toBe(a.seq);
          expect(canonical(late.view)).toBe(canonical(a.view));

          await Promise.all([hostClient.close(), lateClient.close()]);
        },
      ),
      { numRuns: runs(30) },
    );
  });
});
