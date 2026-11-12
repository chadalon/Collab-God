# ADR-0003: License

- **Status:** Accepted
- **Date:** 2026-11-11
- **Deciders:** Chad

## Context

The project is open source. The proposed engine stack (ADR-0002) links Tracktion Engine, which is GPLv3 or commercial, and JUCE 8, which is AGPLv3 or commercial. Using both without paid licenses means the distributed app must be under a compatible copyleft license.

The relay server does not link either library, so it could carry a different license.

This record is not legal advice. Get a licensing review before any commercial step.

## Decision

**GPL-3.0-or-later** for the whole repository. The full text is in [`LICENSE`](../../LICENSE).

## Alternatives considered

- **AGPL-3.0-or-later.** Also compatible. It adds a duty to share source when a modified version is offered over a network, which matters mainly for the relay server.
- **GPL for the app, a permissive license for the session and protocol package.** Makes third-party clients easier and closed forks of the protocol possible.
- **Permissive throughout.** Not available while the app links the GPL and AGPL engines.

## Consequences

- Anyone can use, study, change and redistribute the app, and must share their changes under the same terms.
- A future closed or dual-licensed edition would need commercial JUCE and Tracktion licenses and the agreement of every contributor. If that door should stay open, add a contributor agreement before accepting outside pull requests.
- Third-party code may only be brought in if its license is GPLv3-compatible.

## How we will know

Chad confirmed GPL-3.0-or-later on 2026-11-11. Whether outside contributors sign a contributor agreement is still open and tracked in issue #2.
