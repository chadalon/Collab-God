# Requirements (v0.2)

Fifty-six requirements across eight areas. Issues refer to these IDs.

Priority:

- **Must**: v1 fails without it.
- **Should**: in v1 if time allows.
- **Later**: recorded so the design does not block it.

Numeric targets are proposals to confirm with measurements in Phase 0.

## v1 scope

v1 is a 2-person lobby on Windows and macOS that can carry one track from an empty session to an exported mix.

**In v1**: desktop app for Windows and macOS; lobbies of two; presence; timeline with audio clips, MIDI clips, piano roll and automation; basic mixer; VST3 plugins that both people own, with live parameter and state sync; sample indexing, content matching and automatic transfer; save, load, per-person undo and stereo export; the core visual identity.

**Not in v1**: plugins only one person owns; lobbies of three or more; first-party instruments and effects; microphone or line-in recording (open question); in-app voice chat; AU, CLAP and Linux; anything in a browser; anything social.

## Lobby and presence

| ID | Requirement | Priority |
| --- | --- | --- |
| LOB-1 | A user can create a lobby and receive an invite code. | Must |
| LOB-2 | A second user can join with the code. Lobbies cap at two people in v1. | Must |
| LOB-3 | A joiner receives the full session and ends in the same state as the host. | Must |
| LOB-4 | Each person sees the other's playhead, pointer, selected tracks and selected clips, colour-coded. | Must |
| LOB-5 | A session opens and works solo, with no lobby and no network. | Must |
| LOB-6 | If the connection drops, both keep working locally and edits merge on reconnect. | Should |

## Sync

| ID | Requirement | Priority |
| --- | --- | --- |
| SYN-1 | Every edit is an operation, and both machines apply operations in the same order. | Must |
| SYN-2 | Local edits apply instantly, then reconcile once the shared order is confirmed. | Must |
| SYN-3 | Creating, moving, resizing and deleting clips, notes and automation points syncs live. | Must |
| SYN-4 | Adding, removing, renaming and reordering tracks syncs live, as do mixer changes. | Must |
| SYN-5 | Undo reverses only your own edits. | Must |
| SYN-6 | Drags and knob turns stream as live previews, then commit as one edit. | Should |
| SYN-7 | Each person has an independent playhead, with a mode to follow the other person's. | Should |

## Plugins

| ID | Requirement | Priority |
| --- | --- | --- |
| PLG-1 | The app scans user-chosen VST3 folders and records each plugin's ID, vendor, name and version. | Must |
| PLG-2 | On join, both sides exchange inventories and work out which plugins are shared. | Must |
| PLG-3 | In a lobby, only shared plugins can be added. Unshared ones are shown but marked. | Must |
| PLG-4 | Adding a plugin on one machine loads the same plugin on the other. | Must |
| PLG-5 | Parameter changes sync both ways and move the controls in the other person's plugin window. | Must |
| PLG-6 | State that is not a parameter, such as a preset load or a wavetable, syncs by sending the plugin's saved state. | Must |
| PLG-7 | A version mismatch between the two installs is detected and shown before the plugin is used. | Should |
| PLG-8 | A plugin crash does not take down the session. | Later |
| PLG-9 | A track using an unshared plugin can be bounced to audio for the other person, and switched back for edits. | Later |

## Samples

| ID | Requirement | Priority |
| --- | --- | --- |
| SMP-1 | The user chooses sample folders, and the app indexes them in the background. | Must |
| SMP-2 | Each file gets a content identity that survives renaming and moving. | Must |
| SMP-3 | A clip added by one person plays from the other person's local copy when identities match. | Must |
| SMP-4 | When there is no match, the file transfers automatically, in chunks, and resumes after a drop. | Must |
| SMP-5 | Transfer progress is drawn on the clip itself. | Must |
| SMP-6 | Transferred files are stored with the project, not mixed into the user's library. | Should |
| SMP-7 | Near matches, such as the same audio in another format, are offered as suggestions and never applied silently. | Should |

## DAW core

| ID | Requirement | Priority |
| --- | --- | --- |
| DAW-1 | Low-latency audio output on Windows and macOS through the standard driver types. | Must |
| DAW-2 | Audio tracks with clips that can be moved, trimmed, split, faded and gained. | Must |
| DAW-3 | Instrument tracks with MIDI clips and a piano roll. | Must |
| DAW-4 | Automation lanes for mixer controls and plugin parameters. | Must |
| DAW-5 | One tempo and one time signature per project. | Must |
| DAW-6 | Projects save and load in a documented, versioned format. | Must |
| DAW-7 | Offline export of the stereo mix to WAV. | Must |
| DAW-8 | Audio clips can be stretched to the project tempo. | Should |
| DAW-9 | MIDI keyboard input and recording. | Should |

## Look and feel

| ID | Requirement | Priority |
| --- | --- | --- |
| UX-1 | A documented design system of the app's own: colour, type, spacing and motion. | Must |
| UX-2 | The timeline, meters and waveforms are drawn on the GPU and hold 60 frames a second. | Must |
| UX-3 | Visual effects respond to audio and to lobby events such as a join or an upload. | Should |
| UX-4 | A first-time user places a sample and hears it within one minute of launch. | Should |

## Efficiency, safety and privacy

| ID | Requirement | Priority |
| --- | --- | --- |
| NFR-1 | An edit appears for the other person within 150 ms on a typical home connection. | Must |
| NFR-2 | An idle lobby uses less than 10 kbps. | Should |
| NFR-3 | The audio thread never waits on the network, the disk or the interface. | Must |
| NFR-4 | A remote edit never causes an audio dropout. | Must |
| NFR-5 | Indexing a 100,000-file library never blocks the app, and later scans only read changed files. | Should |
| NFR-6 | Plugin files never leave a machine. Sample files go only to members of the lobby. | Must |
| NFR-7 | All lobby traffic is encrypted in transit. | Must |

## Engineering practice

| ID | Requirement | Priority |
| --- | --- | --- |
| ENG-1 | The session model and sync logic form a library with no interface or audio dependencies. | Must |
| ENG-2 | That library has unit tests, plus randomized tests proving that concurrent edits always converge. | Must |
| ENG-3 | Every pull request builds and tests on Windows and macOS in CI. | Must |
| ENG-4 | Formatting, linting and static analysis are enforced in CI. | Must |
| ENG-5 | Architecture decisions are recorded as short decision records in the repo. | Must |
| ENG-6 | Work is tracked as GitHub issues, grouped into epics and two-week sprint milestones. | Must |
| ENG-7 | Two-client lobby tests run headless in CI. | Should |
