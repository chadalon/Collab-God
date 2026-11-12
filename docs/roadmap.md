# Roadmap

Six phases. Each ends in something two people can run, and each has a gate that decides whether the next one starts. There are no dates yet; they depend on weekly capacity and are set at sprint planning.

## Phase 0: decide and spike

Settle the open decisions, then build throwaway proofs of the three novel pieces.

- Two app instances host the same VST3. A knob turned in one moves in the other, and a preset change carries over.
- Two sample libraries are indexed, a shared file matches by content, and a missing file transfers with progress.
- Two clients edit a toy clip list through a relay and always end in the same state.

**Gate:** all three work between two real machines in different cities, and the stack ADR is accepted or replaced.

## Phase 1: walking skeleton

App shell, audio output, one timeline, audio clips, play and stop, save and load. CI green on Windows and macOS. The design system starts here.

**Gate:** place a sample, hear it, save, reopen.

## Phase 2: the lobby

Invite codes, presence, live clip edits, and sample matching and transfer inside the timeline.

**Gate:** two people arrange audio clips together in one session.

## Phase 3: instruments

VST3 hosting, MIDI clips, piano roll, plugin inventory comparison, parameter and state sync.

**Gate:** two people tweak one synth patch and edit its notes live.

## Phase 4: finish a track

Automation, mixer, per-person undo across every edit type, export.

**Gate:** the v1 test. One full track, no files sent by hand.

## Phase 5: identity and alpha

Visual effects, polish, first-run experience, installers, and a small group of outside testers.

**Gate:** outside testers complete a session without help.

## Hard problems to keep in view

| Risk | First move |
| --- | --- |
| Scope: a full DAW is years of work | Spikes first, then a thin DAW built around the lobby. Cut features before cutting quality. |
| Plugin state that is not a parameter | Sync parameters as events; send the state blob when a non-parameter change is detected. |
| Plugin drift between two installs | Detect version mismatches. Accept small audible differences and say so in the app. |
| Concurrent edits and undo | One ordered edit log through the relay, per-person undo, randomized convergence tests from day one. |
| Sample identity | Exact content hash for automatic matches. Anything fuzzy is a suggestion the user confirms. |
| Sharing licensed samples | Licensing review before any public release. |
| Connectivity | Start with a small relay. Add direct peer connections later for file transfer. |
| Real-time safety | Lock-free queues between threads, enforced by review and tests. |
