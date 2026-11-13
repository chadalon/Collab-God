# ADR-0006: Lobby members are persistent, connections are not

- **Status:** Proposed
- **Date:** 2026-11-12
- **Deciders:** Chad

## Context

The relay spike (issue #10) held a lobby to two connections. That raised a question the spike could not answer: when one person drops, who owns the free place? In the spike anyone with the code could take it and receive the whole log. The spike also gave a reconnecting person a new id, which loses their undo history and the record of who made what.

Both problems come from treating a person as a connection. The cap is not what the sync design needs: the session-model spike (issue #9) converged with three clients, and the relay orders operations the same way however many people send them (ADR-0004).

People will also leave and come back later, sometimes days later, and expect to be the same person when they do.

## Decision

- **A member is not a connection.** A member is a person in the project: an opaque id, a display name and a colour. A connection comes and goes. When the heartbeat finds a connection dead, the relay drops the connection and that person's presence. Their membership stays.
- **The member list is part of the session and is saved in the project.** Adding a member is an operation like any other edit. Members are marked as removed, never deleted, so the author of an old edit can always be named.
- **No accounts in v1.** A member's identity belongs to one install of the app. The install keeps a secret for each project it is a member of. The project stores only what is needed to check that secret, never the secret itself. The same person on a second computer is a second member.
- **Member ids are made by the app, not the relay.** A solo project has a member and no relay. The id stays an opaque string, and nothing in the session format, the edit log or undo history may assume how it was produced, so it can later be tied to an account (issue #93).
- **The host admits anyone joining for the first time.** A returning member proves who they are and walks in. Knowing the invite code is not enough to receive the session.
- **Nothing in the protocol, the session format or the model assumes two people.** The relay has a setting for how many people may be connected to a lobby at once. It is two in v1, because two is what v1 promises and tests. It counts connections, not members, so a person's second computer never locks them out of their own project.
- **Every operation records the member who made it.** The relay stamps the member id from the connection it has checked and ignores any sender a client claims, as the spike already did.

## Alternatives considered

- **Keep the cap of two and give each place an owner.** This needs the same persistent identity, and adds a rule about places on top of it. It also writes "two" into the protocol, which makes larger lobbies (issue #77) a change of format later.
- **Identity held only by the relay,** as a resume token kept in memory. It covers a dropped connection but not a relay restart, a lobby that has expired, or coming back next week. A solo project would have no members at all, so authorship would mean nothing until a lobby existed.
- **Accounts now.** They need a service, a login and stored personal data, for a product whose first users are two people who know each other. Parked as issue #93.
- **No limit at all.** A public relay needs a bound, and everything beyond two people is untested.
- **Anyone with the code can join.** While a lobby was capped, a full lobby was locked. Without the cap the code would be the only barrier, and six characters can be guessed.

## Consequences

- The project format (issue #25) holds the member list, and the session model (issue #23) gains member operations. Building both in from the start is cheaper than adding them to a format that already has files in the wild.
- Per-person undo (issue #24) is keyed by member id, so it survives a reconnect. Reconnecting (issue #48) becomes: come back as the same member, then resend whatever was unconfirmed. The relay already refuses an operation id it has ordered before.
- The production relay (issue #36) checks returning members, holds first-time joiners until the host admits them, and has a limit setting in place of the cap. The join flow (issue #38) sends nothing from the session until a person is admitted.
- Presence (issue #41) is keyed by member id and must cope with more than one other person, even though only two are tested.
- A new computer or a reinstall makes a new member. v1 has no way to merge two members into one. If that turns out to be annoying, it is the first argument for accounts.
- A project file names its members. Display names are personal data that leave the machine and belong in the privacy review (issue #73).
- Requirements that say "both" or "the other person" describe two people, the tested case. What they mean for three or more is undecided: whether a shared plugin is one that everyone owns, and who sends a missing sample. That stays with issue #77.
- Showing who made each edit becomes possible. It is not a Must for v1 (issue #95).

## Still to settle

These follow from the decision and are not decided here:

- How an install proves it is a returning member: a random token checked against a stored hash, or a key pair. For issue #36.
- Whether any connected member may admit a newcomer when the host is away, and who the host is when a lobby is opened again from a saved project.
- Whether the host can remove or block a member.
- How much history the project keeps: the whole log, or who created and who last changed each object. For issue #25.
- Where a member's display name and colour come from.
- What happens when two members each edit their own saved copy alone and then open a lobby again. That belongs to issue #40.

## How we will know

Phase 1: the project format saves and reloads a member list, and solo undo and authorship use the same member id a lobby will. Phase 2: a test drops a connection, the person returns as the same member, and their undo still reverses only their own edits. If identity tied to one install gets in the way during the v1 acceptance session (issue #67), revisit it with issue #93.
