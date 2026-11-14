# Working on CollabGod

This file is for anyone starting cold: an AI agent in a new session, a different model, or a new human contributor. It tells you where the context lives, how to pick work, and which rules are easy to break. Keep it short and current. If you add a package, a command or a rule, update this file in the same pull request.

## Read these first

1. [`README.md`](README.md): what the product is and how a lobby works.
2. [`docs/requirements.md`](docs/requirements.md): the v1 requirements. Issues refer to their IDs.
3. [`docs/roadmap.md`](docs/roadmap.md): the six phases and the gate at the end of each.
4. [`docs/adr`](docs/adr): why things are the way they are. A record marked Proposed is not settled.
5. [`CONTRIBUTING.md`](CONTRIBUTING.md): workflow, issue types and the definition of done.

Do not rely on anything outside this repository. If you learned something a later contributor will need, put it in the repo: a finding on the issue, an ADR, or a doc.

## Where the project stands

The current phase is the earliest [milestone](../../milestones) that still has open issues. Its epic issue lists the work in order. Phases 0 and 1 are specified in detail. Later phases are deliberately coarse and get refined when they start, so do not build ahead of the current phase.

## Picking work

- Take one open issue from the current milestone. One issue, one pull request.
- Before starting, check that no open pull request or branch already covers it, then comment on the issue that you are starting.
- `type: decision` issues belong to the maintainer. Prepare the options if asked. Do not decide.
- `needs: local machine` means the work depends on the maintainers' real hardware, plugins or sample libraries. From a cloud session you can write the code and the steps to run it, but you cannot finish the issue. Say so in the pull request.
- `idea` issues are parked. Do not design or build them.
- If an issue is unclear, ask on the issue instead of guessing.

## Rules that are easy to break

- **The session model is pure.** No dependency on the interface, the audio engine or Node-only APIs. It must run in a test, in the app, in the relay and in a browser.
- **Every change to a session is an operation.** There is no other way to mutate state. Operations are deterministic and define what happens when their target is gone.
- **Undo is guarded by revisions, not values.** See ADR-0004 and `spikes/session-model`. Comparing values was tried and was wrong.
- **The audio thread never blocks.** No locks, allocation, file or network calls, or logging on it.
- **A member is not a connection.** A person is a member saved in the project, with an opaque id the app makes. A dropped connection ends their presence, never their membership. Nothing in the protocol, the session format or the model may assume two people; the limit is a relay setting. See ADR-0006.
- **Samples are identified by content hash.** A local file path never goes into a session or over the network. Plugin files never leave a machine.
- **Spikes are throwaway.** Code under `spikes/` answers a question. Product code never imports from it.
- **Licensing.** The project is GPL-3.0-or-later. Do not copy code from other DAWs. A new dependency must be GPLv3-compatible and listed in `THIRD_PARTY.md` once that file exists.
- **Decisions with lasting consequences get an ADR**, opened as Proposed.

## Commands

| Where | Command | What it does |
| --- | --- | --- |
| `spikes/session-model` | `npm ci` | Install pinned dependencies (Node 22 or newer) |
| `spikes/session-model` | `npm test` | Unit, scenario and property tests |
| `spikes/session-model` | `npm run typecheck` | Strict TypeScript check |
| `spikes/session-model` | `FC_SCALE=40 npm test` | Property tests with 40 times as many random cases |
| `spikes/relay` | `npm ci` | Install pinned dependencies (Node 22 or newer) |
| `spikes/relay` | `npm test` | Relay tests over real sockets on this machine, including TLS where `openssl` is installed |
| `spikes/relay` | `npm run typecheck` | Strict TypeScript check |
| `spikes/relay` | `npm run relay -- serve` | Run a relay; `host` and `join` run the test between two locations (see its README) |
| `spikes/sample-index` | `npm ci` | Install pinned dependencies (Node 22 or newer) |
| `spikes/sample-index` | `npm test` | Hashing, scanning, rescans, near matches and overlap on generated files |
| `spikes/sample-index` | `npm run typecheck` | Strict TypeScript check |
| `spikes/sample-index` | `npm run samples -- scan <folder> --index <file>` | Index sample folders; `export`, `compare`, `near` and `generate` are in its README |

A new package or spike with tests gets its own job in `.github/workflows/ci.yml`, added to the `needs` list of the `CI passed` job, and its commands get rows in this table. Code that CI does not run is not protected by the required check.

There is no application to build or run yet. That starts in Phase 1.

## Git and pull requests

- Never push to `main`. Branch as `feat/123-name`, `fix/123-name`, `spike/123-name`, `docs/123-name` or `chore/123-name`.
- Stage files by name. Do not use `git add -A` or `git add .`; that is how a generated test report was once committed by mistake.
- Never commit generated output, dependencies, secrets or local paths.
- Do not rewrite history on a branch someone else may have pulled.
- Commit and pull request titles follow Conventional Commits: `feat(sync): order edits through the relay`.
- Write `Closes #123` only if every acceptance criterion on the issue is met. Otherwise write `Refs #123` and list what is left.
- Use the pull request template. Under "How it was tested", say exactly what you ran and what you could not check. Do not claim a check you did not run.
- Do not merge. A maintainer reads and merges every pull request.
- Do not change repository settings, milestones or label meanings, and do not close an issue whose acceptance criteria are not all met.

## What an agent cannot verify

You cannot hear audio, see the interface on a real display, or run third-party plugins. For any change that affects sound, visuals or plugin behaviour, list the manual checks a person should do in the pull request, and do not describe the change as verified.

## Definition of done

See [`CONTRIBUTING.md`](CONTRIBUTING.md#definition-of-done). In short: acceptance criteria met and shown, tests with the change, CI green, no new warnings, docs and ADRs updated.
