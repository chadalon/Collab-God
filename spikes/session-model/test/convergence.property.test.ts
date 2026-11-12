// SPDX-License-Identifier: GPL-3.0-or-later

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonical, checkInvariants, type NewClip, type NewTrack, fold, Replica, type SessionState } from '../src';
import { type Dice, idSource, randomOp, runs, SEED, SEED_LOG, Sim } from './sim';

const dice = fc.tuple(fc.nat(999), fc.nat(999), fc.nat(999), fc.nat(999));

type Step =
  | { kind: 'edit'; who: number; dice: Dice }
  | { kind: 'undo'; who: number }
  | { kind: 'redo'; who: number }
  | { kind: 'up'; who: number }
  | { kind: 'down'; who: number };

const who = fc.nat(5);
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ kind: fc.constant('edit' as const), who, dice }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('undo' as const), who }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('redo' as const), who }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('up' as const), who }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('down' as const), who }) },
);

/** Run a random interleaving of edits, undos and message deliveries. */
function run(clientCount: number, steps: readonly Step[], afterEachStep?: (sim: Sim) => void): Sim {
  const sim = new Sim(clientCount, SEED);
  const ids = sim.clients.map((client) => idSource(client.clientId));
  for (const s of steps) {
    const index = s.who % clientCount;
    const client = sim.client(index);
    if (s.kind === 'edit') {
      const freshId = ids[index];
      const op = freshId && randomOp(client.view, s.dice, freshId);
      if (op) client.edit(op);
    } else if (s.kind === 'undo') client.undo();
    else if (s.kind === 'redo') client.redo();
    else if (s.kind === 'up') sim.deliverUp(index);
    else sim.deliverDown(index);
    afterEachStep?.(sim);
  }
  return sim;
}

function expectConverged(sim: Sim): void {
  const truth = canonical(fold(sim.relay.log));
  for (const client of sim.clients) {
    expect(client.unconfirmed).toHaveLength(0);
    expect(canonical(client.confirmed)).toBe(truth);
    expect(canonical(client.view)).toBe(truth);
  }
}

describe('convergence', () => {
  it('two clients always end in the same state, whatever the delivery order', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 80 }), (steps) => {
        const sim = run(2, steps);
        sim.drain();
        expectConverged(sim);
      }),
      { numRuns: runs(500) },
    );
  });

  it('three clients also converge, so the design does not depend on there being two', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 80 }), (steps) => {
        const sim = run(3, steps);
        sim.drain();
        expectConverged(sim);
      }),
      { numRuns: runs(300) },
    );
  });

  it('every state a client ever shows is structurally valid', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        run(2, steps, (sim) => {
          for (const client of sim.clients) {
            expect(checkInvariants(client.view)).toEqual([]);
            expect(checkInvariants(client.confirmed)).toEqual([]);
          }
        });
      }),
      { numRuns: runs(300) },
    );
  });

  it('a client’s confirmed state is always the fold of the log prefix it has received', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        run(2, steps, (sim) => {
          for (const client of sim.clients) {
            expect(canonical(client.confirmed)).toBe(canonical(fold(sim.relay.log.slice(0, client.seq))));
          }
        });
      }),
      { numRuns: runs(200) },
    );
  });

  it('a client’s view is always its confirmed state plus its own unconfirmed operations', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        run(2, steps, (sim) => {
          for (const client of sim.clients) {
            expect(canonical(client.view)).toBe(canonical(fold(client.unconfirmed, client.confirmed)));
          }
        });
      }),
      { numRuns: runs(300) },
    );
  });

  it('a late joiner replaying the log matches everyone else', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        const sim = run(2, steps);
        sim.drain();
        const late = new Replica('late', () => undefined);
        for (const entry of sim.relay.log) late.receive(entry);
        expect(canonical(late.view)).toBe(canonical(sim.client(0).view));
      }),
      { numRuns: runs(200) },
    );
  });
});

describe('undo and redo, one person', () => {
  const edits = fc.array(dice, { maxLength: 40 });

  const soloRun = (rolls: readonly Dice[], deliverAsYouGo: boolean) => {
    const sim = new Sim(1, SEED);
    const me = sim.client(0);
    const freshId = idSource('me');
    let applied = 0;
    for (const roll of rolls) {
      const op = randomOp(me.view, roll, freshId);
      if (op && me.edit(op)) applied += 1;
      if (deliverAsYouGo) sim.drain();
    }
    return { sim, me, applied };
  };

  it.each([
    ['with every edit confirmed first', true],
    ['with nothing confirmed yet', false],
  ])('undoing everything returns to the start, and redoing everything returns to the end, %s', (_name, deliver) => {
    fc.assert(
      fc.property(edits, (rolls) => {
        const { sim, me, applied } = soloRun(rolls, deliver);
        const start = canonical(fold(SEED_LOG));
        const end = canonical(me.view);

        let undone = 0;
        while (me.undo()) undone += 1;
        expect(undone).toBe(applied);
        expect(canonical(me.view)).toBe(start);

        let redone = 0;
        while (me.redo()) redone += 1;
        expect(redone).toBe(applied);
        expect(canonical(me.view)).toBe(end);

        sim.drain();
        expect(canonical(me.view)).toBe(end);
        expect(me.rejected).toBe(0);
      }),
      { numRuns: runs(300) },
    );
  });
});

/** Every field one person's edits wrote, so a test can check that nobody else's undo disturbed it. */
interface Footprint {
  clips: Map<string, 'absent' | Set<keyof NewClip>>;
  tracks: Map<string, 'absent' | Set<keyof NewTrack>>;
}

const CLIP_KEYS: readonly (keyof NewClip)[] = ['trackId', 'start', 'length', 'sampleHash'];
const TRACK_KEYS: readonly (keyof NewTrack)[] = ['name'];

function recordChanges(footprint: Footprint, before: SessionState, after: SessionState): void {
  const diff = <T extends object>(
    seen: Map<string, 'absent' | Set<keyof T>>,
    keys: readonly (keyof T)[],
    was: Readonly<Record<string, T>>,
    now: Readonly<Record<string, T>>,
  ) => {
    for (const id of new Set([...Object.keys(was), ...Object.keys(now)])) {
      const a = was[id];
      const b = now[id];
      if (b === undefined) {
        if (a !== undefined) seen.set(id, 'absent');
        continue;
      }
      const changed = a === undefined ? keys : keys.filter((key) => a[key] !== b[key]);
      if (changed.length === 0) continue;
      const previous = seen.get(id);
      const fields = previous instanceof Set ? previous : new Set<keyof T>();
      for (const key of changed) fields.add(key);
      seen.set(id, fields);
    }
  };
  diff<NewClip>(footprint.clips, CLIP_KEYS, before.clips, after.clips);
  diff<NewTrack>(footprint.tracks, TRACK_KEYS, before.tracks, after.tracks);
}

describe('undo and redo, two people', () => {
  it('my undo never disturbs anything the other person wrote after me', () => {
    fc.assert(
      fc.property(fc.array(dice, { maxLength: 25 }), fc.array(dice, { maxLength: 25 }), (mine, theirs) => {
        const sim = new Sim(2, SEED);
        const a = sim.client(0);
        const b = sim.client(1);
        const aIds = idSource('a');
        const bIds = idSource('b');

        for (const roll of mine) {
          const op = randomOp(a.view, roll, aIds);
          if (op) a.edit(op);
          sim.drain();
        }

        // Every field the other person writes, step by step, including changes they later reverse.
        const footprint: Footprint = { clips: new Map(), tracks: new Map() };
        for (const roll of theirs) {
          const before = b.view;
          const op = randomOp(b.view, roll, bIds);
          if (op) b.edit(op);
          sim.drain();
          recordChanges(footprint, before, b.view);
        }
        const afterTheirs = b.view;

        while (a.undo()) sim.drain();
        sim.drain();
        const final = b.view;
        expect(canonical(a.view)).toBe(canonical(final));

        const check = <T extends object>(
          seen: Map<string, 'absent' | Set<keyof T>>,
          expected: Readonly<Record<string, T>>,
          actual: Readonly<Record<string, T>>,
        ) => {
          for (const [id, fields] of seen) {
            if (fields === 'absent') {
              expect(actual[id]).toBeUndefined();
              continue;
            }
            const want = expected[id];
            const got = actual[id];
            expect(got).toBeDefined();
            if (want === undefined || got === undefined) continue;
            for (const key of fields) expect(got[key]).toBe(want[key]);
          }
        };
        check<NewClip>(footprint.clips, afterTheirs.clips, final.clips);
        check<NewTrack>(footprint.tracks, afterTheirs.tracks, final.tracks);
      }),
      { numRuns: runs(500) },
    );
  });
});
