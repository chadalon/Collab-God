// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { apply, canonical, checkInvariants, emptyState, fold, type Op, type SessionState } from '../src';
import { SEED_LOG } from './sim';

const seeded = (): SessionState => fold(SEED_LOG);

const mustApply = (state: SessionState, op: Op, opId: string) => {
  const result = apply(state, op, opId);
  if (!result.applied) throw new Error(`expected ${op.type} to apply, got ${result.reason}`);
  return result;
};

const reasonFor = (state: SessionState, op: Op, opId = 'x:1') => {
  const result = apply(state, op, opId);
  return result.applied ? 'applied' : result.reason;
};

describe('apply', () => {
  it('builds the seed session and keeps it valid', () => {
    const state = seeded();
    expect(state.trackOrder).toEqual(['t1', 't2']);
    expect(Object.keys(state.clips).sort()).toEqual(['k1', 'k2', 'k3']);
    expect(checkInvariants(state)).toEqual([]);
  });

  it('never mutates the state it is given', () => {
    const before = seeded();
    const snapshot = canonical(before);
    apply(before, { type: 'clip.move', id: 'k1', trackId: 't2', start: 32 }, 'a:1');
    apply(before, { type: 'track.remove', id: 't1' }, 'a:2');
    expect(canonical(before)).toBe(snapshot);
  });

  it('inserts a track at the requested index and clamps an index past the end', () => {
    const state = seeded();
    const first = mustApply(state, { type: 'track.add', track: { id: 't0', name: 'FX' }, index: 0 }, 'a:1').state;
    expect(first.trackOrder).toEqual(['t0', 't1', 't2']);
    const last = mustApply(state, { type: 'track.add', track: { id: 't9', name: 'FX' }, index: 99 }, 'a:1').state;
    expect(last.trackOrder).toEqual(['t1', 't2', 't9']);
  });

  it('removes a track together with the clips on it', () => {
    const state = mustApply(seeded(), { type: 'track.remove', id: 't1' }, 'a:1').state;
    expect(state.trackOrder).toEqual(['t2']);
    expect(Object.keys(state.clips)).toEqual(['k3']);
    expect(checkInvariants(state)).toEqual([]);
  });

  it('stamps only the fields an edit actually changes', () => {
    const before = seeded();
    const slid = mustApply(before, { type: 'clip.move', id: 'k1', trackId: 't1', start: 20 }, 'a:1').state;
    expect(slid.clips['k1']?.rev).toEqual({ ...before.clips['k1']?.rev, start: 'a:1' });
    const grown = mustApply(slid, { type: 'clip.resize', id: 'k1', start: 20, length: 9 }, 'b:1').state;
    expect(grown.clips['k1']?.rev).toEqual({ ...before.clips['k1']?.rev, start: 'a:1', length: 'b:1' });
  });

  it.each<[string, Op, string]>([
    ['a clip that is gone', { type: 'clip.move', id: 'nope', trackId: 't1', start: 0 }, 'target-missing'],
    ['a move to a track that is gone', { type: 'clip.move', id: 'k1', trackId: 'nope', start: 0 }, 'track-missing'],
    ['a clip added to a track that is gone', { type: 'clip.add', clip: { id: 'x', trackId: 'nope', start: 0, length: 1, sampleHash: 'h' } }, 'track-missing'],
    ['a clip id that is taken', { type: 'clip.add', clip: { id: 'k1', trackId: 't1', start: 0, length: 1, sampleHash: 'h' } }, 'id-exists'],
    ['a track id that is taken', { type: 'track.add', track: { id: 't1', name: 'Again' }, index: 0 }, 'id-exists'],
    ['a negative start', { type: 'clip.move', id: 'k1', trackId: 't1', start: -1 }, 'invalid'],
    ['a fractional start', { type: 'clip.move', id: 'k1', trackId: 't1', start: 1.5 }, 'invalid'],
    ['a zero length', { type: 'clip.resize', id: 'k1', start: 0, length: 0 }, 'invalid'],
    ['a patch that sets nothing', { type: 'clip.patch', id: 'k1', set: {}, expect: {}, restore: {} }, 'invalid'],
    ['a patch without a guard for a field it sets', { type: 'clip.patch', id: 'k1', set: { start: 4 }, expect: {}, restore: {} }, 'invalid'],
    ['a move to where the clip already is', { type: 'clip.move', id: 'k1', trackId: 't1', start: 0 }, 'no-change'],
    ['a rename to the same name', { type: 'track.rename', id: 't1', name: 'Drums' }, 'no-change'],
    ['a rename of a track that is gone', { type: 'track.rename', id: 'nope', name: 'X' }, 'target-missing'],
    ['a removal of a track that is gone', { type: 'track.remove', id: 'nope' }, 'target-missing'],
    ['a removal of a clip that is gone', { type: 'clip.remove', id: 'nope' }, 'target-missing'],
  ])('rejects %s and leaves the state untouched', (_name, op, reason) => {
    const state = seeded();
    expect(reasonFor(state, op)).toBe(reason);
    expect(apply(state, op, 'x:1').state).toBe(state);
  });
});

describe('inverses', () => {
  const ops: Op[] = [
    { type: 'track.add', track: { id: 't3', name: 'Lead' }, index: 1 },
    { type: 'track.remove', id: 't1' },
    { type: 'track.rename', id: 't2', name: 'Sub bass' },
    { type: 'clip.add', clip: { id: 'k9', trackId: 't2', start: 16, length: 8, sampleHash: 'pad' } },
    { type: 'clip.move', id: 'k1', trackId: 't2', start: 12 },
    { type: 'clip.move', id: 'k1', trackId: 't1', start: 12 },
    { type: 'clip.resize', id: 'k3', start: 4, length: 2 },
    { type: 'clip.resize', id: 'k3', start: 0, length: 2 },
    { type: 'clip.remove', id: 'k2' },
  ];
  const cases = ops.map((op, i) => [`${op.type} #${i}`, op] as const);

  it.each(cases)('%s followed by its inverse restores the state, revisions included', (_name, op) => {
    const before = seeded();
    const forward = mustApply(before, op, 'a:1');
    const back = mustApply(forward.state, forward.inverse, 'a:2');
    expect(canonical(back.state)).toBe(canonical(before));
  });

  it.each(cases)('the inverse of the inverse of %s redoes it, revisions included', (_name, op) => {
    const forward = mustApply(seeded(), op, 'a:1');
    const back = mustApply(forward.state, forward.inverse, 'a:2');
    const again = mustApply(back.state, back.inverse, 'a:3');
    expect(canonical(again.state)).toBe(canonical(forward.state));
  });

  it('restores a removed track at its old position with every clip it held', () => {
    const before = seeded();
    const removed = mustApply(before, { type: 'track.remove', id: 't1' }, 'a:1');
    const restored = mustApply(removed.state, removed.inverse, 'a:2').state;
    expect(restored.trackOrder).toEqual(['t1', 't2']);
    expect(restored.clips['k1']).toEqual(before.clips['k1']);
    expect(restored.clips['k2']).toEqual(before.clips['k2']);
  });

  it('undoing two edits to one clip in reverse order works, because each undo re-arms the one before', () => {
    const before = seeded();
    const first = mustApply(before, { type: 'clip.move', id: 'k1', trackId: 't1', start: 20 }, 'a:1');
    const second = mustApply(first.state, { type: 'clip.move', id: 'k1', trackId: 't1', start: 40 }, 'a:2');
    const undoSecond = mustApply(second.state, second.inverse, 'a:3');
    const undoFirst = mustApply(undoSecond.state, first.inverse, 'a:4');
    expect(canonical(undoFirst.state)).toBe(canonical(before));
  });
});

describe('guards', () => {
  const moved = () => mustApply(seeded(), { type: 'clip.move', id: 'k1', trackId: 't1', start: 20 }, 'a:1');

  it('an inverse move does not apply once someone else has moved the clip again', () => {
    const { state, inverse } = moved();
    const theirs = mustApply(state, { type: 'clip.move', id: 'k1', trackId: 't2', start: 40 }, 'b:1').state;
    expect(reasonFor(theirs, inverse)).toBe('guard-failed');
  });

  it('an inverse move does not apply even if someone else moved the clip away and back', () => {
    const { state, inverse } = moved();
    const away = mustApply(state, { type: 'clip.move', id: 'k1', trackId: 't1', start: 50 }, 'b:1').state;
    const back = mustApply(away, { type: 'clip.move', id: 'k1', trackId: 't1', start: 20 }, 'b:2').state;
    expect(back.clips['k1']?.start).toBe(20);
    expect(reasonFor(back, inverse)).toBe('guard-failed');
  });

  it('an inverse move still applies when someone changed only the length', () => {
    const { state, inverse } = moved();
    const theirs = mustApply(state, { type: 'clip.resize', id: 'k1', start: 20, length: 9 }, 'b:1').state;
    const undone = mustApply(theirs, inverse, 'a:2').state;
    expect(undone.clips['k1']).toMatchObject({ trackId: 't1', start: 0, length: 9 });
    expect(undone.clips['k1']?.rev.length).toBe('b:1');
  });

  it('an inverse add does not remove a clip someone else has changed', () => {
    const added = mustApply(
      seeded(),
      { type: 'clip.add', clip: { id: 'k9', trackId: 't2', start: 16, length: 8, sampleHash: 'pad' } },
      'a:1',
    );
    const theirs = mustApply(added.state, { type: 'clip.resize', id: 'k9', start: 16, length: 3 }, 'b:1').state;
    expect(reasonFor(theirs, added.inverse)).toBe('guard-failed');
  });

  it('an inverse track add does not remove a track someone else has put a clip on', () => {
    const added = mustApply(seeded(), { type: 'track.add', track: { id: 't3', name: 'Lead' }, index: 2 }, 'a:1');
    const theirs = mustApply(
      added.state,
      { type: 'clip.add', clip: { id: 'k9', trackId: 't3', start: 0, length: 4, sampleHash: 'lead' } },
      'b:1',
    ).state;
    expect(reasonFor(theirs, added.inverse)).toBe('guard-failed');
  });

  it('an inverse track add does not remove a track someone else has renamed', () => {
    const added = mustApply(seeded(), { type: 'track.add', track: { id: 't3', name: 'Lead' }, index: 2 }, 'a:1');
    const theirs = mustApply(added.state, { type: 'track.rename', id: 't3', name: 'Their lead' }, 'b:1').state;
    expect(reasonFor(theirs, added.inverse)).toBe('guard-failed');
  });

  it('an inverse rename does not apply once someone else has renamed the track', () => {
    const renamed = mustApply(seeded(), { type: 'track.rename', id: 't1', name: 'Kit' }, 'a:1');
    const theirs = mustApply(renamed.state, { type: 'track.rename', id: 't1', name: 'Percussion' }, 'b:1').state;
    expect(reasonFor(theirs, renamed.inverse)).toBe('guard-failed');
  });
});

describe('canonical', () => {
  it('is the same for equal states built in a different order', () => {
    const [t1, t2, k1, k2, k3] = SEED_LOG;
    const reordered = [t1, t2, k3, k2, k1].filter((entry) => entry !== undefined);
    expect(canonical(fold(reordered))).toBe(canonical(fold(SEED_LOG)));
  });

  it('differs when only a revision differs', () => {
    const a = mustApply(seeded(), { type: 'clip.move', id: 'k1', trackId: 't1', start: 20 }, 'a:1').state;
    const b = mustApply(seeded(), { type: 'clip.move', id: 'k1', trackId: 't1', start: 20 }, 'b:1').state;
    expect(canonical(a)).not.toBe(canonical(b));
    expect(canonical(emptyState)).toBe(canonical(fold([])));
  });
});
