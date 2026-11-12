// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { canonical, fold, Replica } from '../src';
import { SEED, Sim } from './sim';

/** Two people, A and B, in one lobby that starts from the seed session. */
const lobby = () => {
  const sim = new Sim(2, SEED);
  return { sim, a: sim.client(0), b: sim.client(1) };
};

describe('optimistic editing', () => {
  it('shows a local edit at once, before the relay has seen it', () => {
    const { a, b } = lobby();
    expect(a.edit({ type: 'clip.move', id: 'k1', trackId: 't1', start: 24 })).toBe(true);
    expect(a.view.clips['k1']?.start).toBe(24);
    expect(a.confirmed.clips['k1']?.start).toBe(0);
    expect(b.view.clips['k1']?.start).toBe(0);
    expect(a.unconfirmed).toHaveLength(1);
  });

  it('reaches the other person once delivered, and both end up equal', () => {
    const { sim, a, b } = lobby();
    a.edit({ type: 'clip.move', id: 'k1', trackId: 't1', start: 24 });
    sim.drain();
    expect(b.view.clips['k1']?.start).toBe(24);
    expect(a.unconfirmed).toHaveLength(0);
    expect(canonical(a.view)).toBe(canonical(b.view));
  });

  it('keeps showing my unconfirmed edit while the other person edits something else', () => {
    const { sim, a, b } = lobby();
    a.edit({ type: 'clip.move', id: 'k1', trackId: 't1', start: 24 });
    b.edit({ type: 'track.rename', id: 't2', name: 'Sub' });
    sim.deliverUp(1); // B's rename reaches the relay first
    sim.deliverDown(0); // and reaches A while A's move is still unconfirmed
    expect(a.view.tracks['t2']?.name).toBe('Sub');
    expect(a.view.clips['k1']?.start).toBe(24);
    expect(a.unconfirmed).toHaveLength(1);
  });
});

describe('conflicting edits', () => {
  it('when both move the same clip, the move the relay orders last wins on both machines', () => {
    const { sim, a, b } = lobby();
    a.edit({ type: 'clip.move', id: 'k1', trackId: 't1', start: 10 });
    b.edit({ type: 'clip.move', id: 'k1', trackId: 't2', start: 30 });
    sim.deliverUp(1); // B first
    sim.deliverUp(0); // then A
    sim.drain();
    expect(a.view.clips['k1']).toMatchObject({ trackId: 't1', start: 10 });
    expect(canonical(a.view)).toBe(canonical(b.view));
  });

  it('drops my edit to a clip the other person deleted first, and rolls my view back', () => {
    const { sim, a, b } = lobby();
    b.edit({ type: 'clip.remove', id: 'k1' });
    a.edit({ type: 'clip.resize', id: 'k1', start: 0, length: 12 });
    expect(a.view.clips['k1']?.length).toBe(12);
    sim.deliverUp(1); // the delete is ordered first
    sim.drain();
    expect(a.view.clips['k1']).toBeUndefined();
    expect(a.rejected).toBe(1);
    expect(a.canUndo).toBe(false); // an edit that never took effect is not undoable
    expect(canonical(a.view)).toBe(canonical(b.view));
  });

  it('drops a clip added to a track the other person deleted first', () => {
    const { sim, a, b } = lobby();
    b.edit({ type: 'track.remove', id: 't2' });
    a.edit({ type: 'clip.add', clip: { id: 'a-1', trackId: 't2', start: 0, length: 4, sampleHash: 'x' } });
    sim.deliverUp(1);
    sim.drain();
    expect(a.view.clips['a-1']).toBeUndefined();
    expect(a.rejected).toBe(1);
    expect(canonical(a.view)).toBe(canonical(b.view));
  });

  it('is unaffected by the other person deleting a different track', () => {
    const { sim, a, b } = lobby();
    b.edit({ type: 'track.remove', id: 't2' });
    a.edit({ type: 'clip.add', clip: { id: 'a-1', trackId: 't1', start: 0, length: 4, sampleHash: 'x' } });
    sim.drain();
    expect(b.view.clips['a-1']?.trackId).toBe('t1');
    expect(a.rejected).toBe(0);
  });
});

describe('per-person undo', () => {
  it('undoes my edit and redoes it', () => {
    const { sim, a, b } = lobby();
    a.edit({ type: 'clip.move', id: 'k1', trackId: 't2', start: 24 });
    sim.drain();
    expect(a.undo()).toBe(true);
    sim.drain();
    expect(b.view.clips['k1']).toMatchObject({ trackId: 't1', start: 0 });
    expect(a.redo()).toBe(true);
    sim.drain();
    expect(b.view.clips['k1']).toMatchObject({ trackId: 't2', start: 24 });
  });

  it('undoes only my edits, leaving the other person’s in place', () => {
    const { sim, a, b } = lobby();
    a.edit({ type: 'clip.move', id: 'k1', trackId: 't1', start: 24 });
    b.edit({ type: 'clip.move', id: 'k2', trackId: 't1', start: 40 });
    sim.drain();
    a.undo();
    sim.drain();
    expect(a.view.clips['k1']?.start).toBe(0);
    expect(a.view.clips['k2']?.start).toBe(40);
  });

  it('skips my edit when the other person has since changed the same thing', () => {
    const { sim, a, b } = lobby();
    a.edit({ type: 'clip.move', id: 'k1', trackId: 't1', start: 24 });
    sim.drain();
    b.edit({ type: 'clip.move', id: 'k1', trackId: 't1', start: 48 });
    sim.drain();
    expect(a.undo()).toBe(false);
    sim.drain();
    expect(a.view.clips['k1']?.start).toBe(48);
  });

  it('falls through to an older edit of mine that is still in effect', () => {
    const { sim, a, b } = lobby();
    a.edit({ type: 'track.rename', id: 't2', name: 'Sub' });
    a.edit({ type: 'clip.move', id: 'k1', trackId: 't1', start: 24 });
    sim.drain();
    b.edit({ type: 'clip.move', id: 'k1', trackId: 't1', start: 48 });
    sim.drain();
    expect(a.undo()).toBe(true); // the move is skipped, the rename is undone
    sim.drain();
    expect(b.view.tracks['t2']?.name).toBe('Bass');
    expect(b.view.clips['k1']?.start).toBe(48);
  });

  it('undoing my move keeps a length change the other person made to the same clip', () => {
    const { sim, a, b } = lobby();
    a.edit({ type: 'clip.move', id: 'k1', trackId: 't1', start: 24 });
    sim.drain();
    b.edit({ type: 'clip.resize', id: 'k1', start: 24, length: 9 });
    sim.drain();
    expect(a.undo()).toBe(true);
    sim.drain();
    expect(b.view.clips['k1']).toMatchObject({ start: 0, length: 9 });
  });

  it('skips my edit even if the other person changed my clip and then put it back exactly', () => {
    // Guards compare who last wrote each field, not the values. A value that only looks
    // untouched is still protected.
    const { sim, a, b } = lobby();
    a.edit({ type: 'clip.add', clip: { id: 'a-1', trackId: 't2', start: 32, length: 4, sampleHash: 'x' } });
    sim.drain();
    b.edit({ type: 'clip.move', id: 'a-1', trackId: 't1', start: 0 });
    b.edit({ type: 'clip.move', id: 'a-1', trackId: 't2', start: 32 });
    sim.drain();
    expect(a.undo()).toBe(false);
    sim.drain();
    expect(b.view.clips['a-1']).toMatchObject({ trackId: 't2', start: 32 });
  });

  it('does not let an older undo of mine fire because the other person landed on the same value', () => {
    // Found by the property tests. I move a clip to 35 and back to 0; the other person then
    // trims it so it starts at 35. Neither of my undos may touch it now.
    const { sim, a, b } = lobby();
    a.edit({ type: 'clip.move', id: 'k1', trackId: 't1', start: 35 });
    a.edit({ type: 'clip.move', id: 'k1', trackId: 't1', start: 0 });
    sim.drain();
    b.edit({ type: 'clip.resize', id: 'k1', start: 35, length: 1 });
    sim.drain();
    expect(a.undo()).toBe(false);
    sim.drain();
    expect(b.view.clips['k1']).toMatchObject({ start: 35, length: 1 });
  });

  it('restores a clip I deleted, exactly as it was', () => {
    const { sim, a, b } = lobby();
    const original = a.view.clips['k3'];
    a.edit({ type: 'clip.remove', id: 'k3' });
    sim.drain();
    a.undo();
    sim.drain();
    expect(b.view.clips['k3']).toEqual(original);
  });

  it('restores a track I deleted, including the other person’s clips on it', () => {
    const { sim, a, b } = lobby();
    b.edit({ type: 'clip.add', clip: { id: 'b-1', trackId: 't1', start: 16, length: 4, sampleHash: 'hat' } });
    sim.drain();
    a.edit({ type: 'track.remove', id: 't1' });
    sim.drain();
    expect(b.view.clips['b-1']).toBeUndefined();
    a.undo();
    sim.drain();
    expect(b.view.trackOrder).toEqual(['t1', 't2']);
    expect(b.view.clips['b-1']?.start).toBe(16);
    expect(b.view.clips['k1']?.start).toBe(0);
  });

  it('can undo an edit before the relay has confirmed it', () => {
    const { sim, a, b } = lobby();
    a.edit({ type: 'clip.move', id: 'k1', trackId: 't1', start: 24 });
    expect(a.undo()).toBe(true);
    expect(a.view.clips['k1']?.start).toBe(0);
    sim.drain();
    expect(b.view.clips['k1']?.start).toBe(0);
    expect(canonical(a.view)).toBe(canonical(b.view));
  });

  it('a new edit clears redo', () => {
    const { a } = lobby();
    a.edit({ type: 'clip.move', id: 'k1', trackId: 't1', start: 24 });
    a.undo();
    expect(a.canRedo).toBe(true);
    a.edit({ type: 'track.rename', id: 't1', name: 'Kit' });
    expect(a.canRedo).toBe(false);
  });

  it('reports nothing to undo on a fresh replica', () => {
    const { a } = lobby();
    expect(a.undo()).toBe(false);
    expect(a.redo()).toBe(false);
  });
});

describe('joining and ordering', () => {
  it('a late joiner replaying the log ends in the same state', () => {
    const { sim, a, b } = lobby();
    a.edit({ type: 'clip.move', id: 'k1', trackId: 't2', start: 24 });
    b.edit({ type: 'track.add', track: { id: 'b-1', name: 'Lead' }, index: 0 });
    a.edit({ type: 'clip.remove', id: 'k2' });
    sim.drain();
    const late = new Replica('late', () => undefined);
    for (const entry of sim.relay.log) late.receive(entry);
    expect(canonical(late.view)).toBe(canonical(a.view));
    expect(canonical(late.view)).toBe(canonical(fold(sim.relay.log)));
  });

  it('refuses a message that arrives out of sequence', () => {
    const replica = new Replica('x', () => undefined);
    expect(() =>
      replica.receive({ seq: 2, opId: 'y:1', clientId: 'y', op: { type: 'track.add', track: { id: 't', name: 'T' }, index: 0 } }),
    ).toThrow(/expected seq 1/);
  });
});
