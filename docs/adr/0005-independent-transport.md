# ADR-0005: Each person has their own transport

- **Status:** Accepted
- **Date:** 2026-11-11
- **Deciders:** Chad

## Context

Two people work in one session at the same time. When one presses play, either both machines play, or only theirs does.

A shared transport is what a single-user DAW would suggest, and it is simpler to explain. It also means one person cannot audition a section while the other listens to a different one, and starting playback together across a network needs clock synchronisation and latency compensation between the two machines.

## Decision

- **Each person has their own transport.** Play, stop and playhead position belong to the person, not to the session.
- **Everyone's playhead is always visible to everyone**, in that person's colour.
- **A follow mode is optional.** Turning it on locks your playhead to the other person's. Turning it off gives it back.

## Alternatives considered

- **One shared transport.** Rejected: it stops two people working on different sections at once, which is the point of the product, and it needs synchronised playback across the network.
- **Shared transport with a "solo listen" escape.** The same synchronisation cost, with a mode switch on top.

## Consequences

- Transport state is presence, not an edit. It never enters the ordered edit log (ADR-0004) and is never undoable.
- No synchronised playback is needed. Each machine plays its own audio at its own position, so there is no shared clock to maintain.
- Follow mode is approximate. A follower trails by the network delay, so two people in follow mode do not hear the same moment at exactly the same instant. That is acceptable for people in different rooms and should be stated in the interface.
- Tempo and time signature stay part of the session, because they change what the project is.
- The engine must accept edits from the other person while playing locally without a dropout (NFR-4).
- The interface must make it obvious which playhead is yours.

## Still to settle

These follow from the decision and are not decided here:

- Whether the loop range is personal or shared.
- Whether solo is personal, for auditioning, while mute stays part of the shared mix.
- Whether the metronome is personal.

## How we will know

The Phase 2 gate: two people arrange audio clips together in one session. If working on different sections at once feels natural and follow mode is good enough for "listen to this", the decision stands.
