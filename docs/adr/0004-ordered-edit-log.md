# ADR-0004: One ordered edit log through the relay

- **Status:** Proposed
- **Date:** 2026-11-11
- **Deciders:** Chad

## Context

Two people edit the same session at once. Both machines must end in the same state, a local edit must feel instant, and undo must reverse only the edits of the person who pressed it.

A lobby always has a relay server in the middle, because home routers block most direct connections.

## Decision

Every edit is an operation. The relay assigns each operation a sequence number, and every client applies operations in sequence order. A client applies its own operations immediately, then, when the relay's order arrives, rewinds any unconfirmed local operations, applies the confirmed ones, and reapplies its own.

Undo is per person: it issues a new operation that inverts that person's most recent operation that is still in effect.

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
