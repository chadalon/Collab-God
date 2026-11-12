# Spike: session model with an ordered edit log

Phase 0 spike for [issue #9](https://github.com/chadalon/collabgod/issues/9). It tests the claim in [ADR-0004](../../docs/adr/0004-ordered-edit-log.md): if a relay puts everyone's edits into one order and each client applies its own edits optimistically, every client ends in the same state, and undo can be made to reverse only your own edits.

This is throwaway code. It exists to answer the question and to hand a tested design to the real package in Phase 1 (issues #23 and #24). It has no runtime dependencies.

## Run it

```sh
cd spikes/session-model
npm ci
npm test            # 79 tests, about 2 seconds
npm run typecheck
FC_SCALE=40 npm test  # the same property tests with 40 times as many random cases
npm run timing      # rough timings on a 5,000-clip session, about 30 seconds
```

## What is here

| File | What it holds |
| --- | --- |
| `src/model.ts` | State (tracks, clips) and `apply`, a pure function from state and operation to new state plus the inverse operation |
| `src/relay.ts` | The relay's whole job without the network: number each operation and keep the log |
| `src/replica.ts` | One person's copy: confirmed state, optimistic view, unconfirmed edits, undo and redo |
| `test/sim.ts` | An in-memory lobby where the test decides when each message is delivered |
| `test/model.test.ts` | Every operation, every rejection reason, inverses and guards |
| `test/scenarios.test.ts` | Readable two-person stories: conflicting moves, edits to deleted clips, undo |
| `test/convergence.property.test.ts` | Randomized tests: thousands of interleavings of edits, undos and deliveries |
| `bench/reconcile.timing.ts` | Timings for the naive implementation |

## Findings

**1. The ordered log converges.** Across random interleavings of edits, undo, redo and message delivery, two clients, and three, always ended in the same state as the relay's log. At every step each client's confirmed state equalled the fold of the log prefix it had received, and its view equalled that plus its own unconfirmed edits. A late joiner replaying the log matched everyone else.

**2. Undo must be guarded by revisions, not by values.** The first version let an undo apply only if the target still held the values the original edit left. The property tests broke that twice:

- The other person moves my clip away and back. The values match, so my undo deleted a clip they had touched.
- I move a clip to 35 and back to 0. The other person trims it so it starts at 35. My *older* undo saw the value 35 it expected and moved their clip.

The fix: every editable field records the id of the operation that last wrote it. An undo applies only while each field it would write was last written by the edit it reverses, and when it applies it puts the previous revision back, which re-arms the undo before it. The cost is one operation id per editable field.

**3. Guards are per field.** If I move a clip and the other person then changes only its length, my undo still moves it back and their length stays.

**4. An edit to something that is gone is dropped, not an error.** If my edit is ordered after the other person deleted its target, it has no effect on either machine, my optimistic view rolls back, and the edit is removed from my undo history. The replica counts these as `rejected`. The interface will need to show the user when that happens.

**5. The naive implementation is too slow for production.** Copying the whole clip table on every operation costs, on the machine this ran on:

| Case, on 5,000 clips across 50 tracks | Time |
| --- | --- |
| Apply one clip move | 1.8 ms |
| Receive one remote edit with 20 local edits unconfirmed | 41 ms |
| Remove and restore a track holding 100 clips | 5.2 ms |

Forty-one milliseconds is more than two frames at 60 fps. The real model should either share structure between versions or keep one mutable state and roll back unconfirmed edits with their inverses, so that receiving a remote edit costs time in proportion to the number of unconfirmed edits, not the size of the session.

## Not covered

- A real network. That is issue #10.
- Duplicate delivery and resending after a reconnect. Operation ids make de-duplication straightforward, but it is not built.
- Snapshots and log compaction, so a late joiner does not replay the whole history.
- Reordering tracks, MIDI, automation, plugin parameters, presence and live gesture previews.
- Undo while the other person is editing the same thing at the same instant. Undo protection is tested for edits made in turn; for simultaneous edits the relay's order decides and only convergence is tested.
- How often edits are rejected in real use. The random tests provoke conflicts far more often than two people would.
