# Contributing

This project is run in short iterations with a small backlog that is kept honest. The rules below exist so that the code stays clean while the product changes shape.

## Workflow

1. **Every change starts as an issue.** Pick one from the current milestone, or open one using a template.
2. **Branch from `main`**: `feat/123-short-name`, `fix/123-short-name`, `spike/123-short-name`, `docs/123-short-name`.
3. **Keep pull requests small.** One issue, one concern. A PR that needs a long description is usually two PRs.
4. **Open the PR early** as a draft. Link the issue with `Closes #123`.
5. **CI must pass** and the PR needs one review before merge.
6. **Squash merge.** The squash title follows [Conventional Commits](https://www.conventionalcommits.org): `feat(sync): order edits through the relay`.

## Issue types

| Label | Meaning |
| --- | --- |
| `type: epic` | A phase or theme. Holds a checklist of child issues. |
| `type: spike` | Time-boxed throwaway work that answers a question. The deliverable is a written finding, not shippable code. |
| `type: feature` | User-visible behaviour, tied to one or more requirement IDs. |
| `type: chore` | Tooling, CI, refactoring, dependencies. |
| `type: decision` | A choice that needs an answer and usually an ADR. |
| `type: research` | Reading, testing other products, legal or licensing checks. |
| `type: bug` | Something that worked and no longer does, or never matched its acceptance criteria. |
| `idea` | Parked. Not designed, not estimated, not scheduled. |

Priority labels match [`docs/requirements.md`](docs/requirements.md): `priority: must`, `priority: should`, `priority: later`.

## Definition of done

A feature issue is done when:

- [ ] Its acceptance criteria are met and demonstrated in the PR.
- [ ] New logic has unit tests. Sync logic also has a property-based test for convergence.
- [ ] CI is green on Windows and macOS.
- [ ] No new warnings from the linters or static analysis.
- [ ] User-visible behaviour is documented where a user would look for it.
- [ ] Any decision with lasting consequences has an ADR.

A spike is done when its question is answered in writing in the issue, with numbers where the question was about performance, and the related ADR is updated.

## Engineering rules

These are enforced in review and, where possible, in CI.

- **The session model has no dependencies on the interface or the audio engine.** It is a pure library that can run in a test, in the app, in the relay and in a browser.
- **Every edit is an operation.** State changes only by applying operations. There is no other way to mutate the session.
- **The audio thread never blocks.** No locks, no allocation, no file or network calls, no logging on the audio thread. Cross-thread communication uses lock-free queues.
- **A remote edit must never cause a dropout.**
- **Tests come with the change**, not after it.
- **Record decisions.** If a reviewer would ask "why is it like this?", the answer belongs in an ADR in `docs/adr`.
- **No copied code from other DAWs** unless its license is compatible and the origin is credited in the file and in `THIRD_PARTY.md`.

## Sprints

Work is planned in two-week sprints. Phase milestones hold the scope; a sprint is the subset of the current phase the team commits to. Sprint planning picks issues, sprint review demonstrates them, and the retro produces at most three changes to how the team works.

## Architecture decision records

Copy `docs/adr/0000-template.md`, number it, and open a PR. Status moves from **Proposed** to **Accepted**, **Rejected** or **Superseded**. Accepted records are not edited afterwards; a new record supersedes them.
