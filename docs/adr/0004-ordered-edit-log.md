# ADR-0004: One ordered edit log through the relay

- **Status:** Proposed
- **Date:** 2026-11-11
- **Deciders:** Chad

## Context

Two people edit the same session at once. Both machines must end in the same state, a local edit must feel instant, and undo must reverse only the edits of the person who pressed it.

A lobby always has a relay server in the middle, because home routers block most direct connections.

## Decision

Every edit is an operation. The relay assigns each operation a sequence number, and every client applies operations in sequence order. A client applies its own operations immediately, then, when the relay's order arrives, rewinds any unconfirmed local operations, applies the confirmed ones, and reapplies its own.

Undo is per person: it issues a new operation that inverts that person's most recent operation that is still in effect. "Still in effect" is decided by revisions, not values: every editable field records the operation that last wrote it, an undo applies only while each field it would write was last written by the edit it reverses, and applying it restores the previous revision.

## Alternatives considered

- **CRDTs.** Converge without a central order and work peer to peer. They make intent-preserving operations such as "move this clip" and per-person undo harder to reason about, and the relay already exists.
- **Operational transformation.** Needs a transform function for every pair of operation types, a cost that grows with every new edit type.
- **Locking.** One person edits an object at a time. Simple, and contrary to the point of the product.

## Consequences

- The relay is required for collaboration. Solo work has no relay and uses a local sequence.
- Every operation must be deterministic and must define what happens when its target no longer exists.
- Offline edits (LOB-6) replay against the confirmed order on reconnect and may be rejected; the interface needs a way to show that.
- Convergence can be tested exhaustively with randomized operation sequences and delivery orders (ENG-2).

## How we will know

The Phase 0 session-model spike runs randomized two-client tests. Any divergence overturns this record.

## Findings from the session-model spike (issue #9)

Code and full write-up: [`spikes/session-model`](../../spikes/session-model).

- **Convergence held.** Random interleavings of edits, undo, redo and delivery, with two and with three clients, always ended in the state of the relay's log.
- **Value-based undo guards were wrong.** Comparing the target's current values with the values the original edit left failed in two ways under property testing: the other person changing a clip and putting it back, and an older undo firing because the other person happened to set the same value. Revision guards, as now described under Decision, fixed both. The cost is one operation id per editable field.
- **Guards work per field.** Undoing a move keeps a length change the other person made to the same clip.
- **Stale edits are dropped silently by the model.** The interface must tell the user when one of their edits had no effect.
- **A whole-state copy per operation is too slow.** On a 5,000-clip session, receiving one remote edit with 20 unconfirmed local edits took 41 ms. The Phase 1 model needs structural sharing, or one mutable state rolled back with inverses.

Over a real network (issue #10, `spikes/relay`): through a relay on a cloud server with TLS, between two machines on different networks, a late joiner caught up on all earlier operations, 200 of 200 operations were ordered and answered, and the estimated one-way edit delay was 28 ms at the median and 54 ms at the 95th percentile (NFR-1 allows 150 ms). That was one run, with one of the two machines on a slow laptop. The convergence tests of two replicas editing at once ran over real sockets on one machine, not between two locations.

Still to confirm before this record is accepted: de-duplication of operations resent after a reconnect, and, if wanted, the convergence test between two locations.
