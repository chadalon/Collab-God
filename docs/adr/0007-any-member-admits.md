# ADR-0007: Any connected member can admit a newcomer

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Chad

## Context

ADR-0006 says the host admits anyone joining a lobby for the first time. It left open whether another member may do so when the host is away, and who the host is when a lobby is opened again from a saved project.

With the host as the only gate, nobody new can join while the person who opened the lobby is offline, even if every other member is connected and wants them in.

## Decision

Any connected member can admit a first-time joiner. This replaces "the host admits" in ADR-0006. Everything else in ADR-0006 stands.

## Alternatives considered

- **Only the host admits.** Simple to explain, but it blocks a lobby whenever the host is away, and it needs a rule for who the host is after a lobby is reopened from a saved project.
- **Other members admit only when the host is away.** The same outcome in the common case, with an extra rule for the relay to track and for people to understand.

## Consequences

- Admission no longer depends on who opened the lobby, so the question of who the host is after reopening a saved project does not need an answer for admission.
- Every member is trusted to let people in. That fits a lobby of people who know each other. It would need revisiting for larger lobbies (issue #77).
- When nobody is connected, a newcomer cannot be admitted and waits.
- The relay (issue #36) sends a request to join to every connected member, and the first answer decides.
- Whether anyone can remove or block a member is still open, and with it whether the person who created the project has any special role.

## How we will know

The Phase 2 gate. If letting any member admit causes surprise or misuse once outside testers use it (Phase 5), tighten it in a new record.
