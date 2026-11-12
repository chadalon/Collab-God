# CollabGod

A cross-platform desktop DAW where two producers edit the same session at the same time, each running their own plugins and samples locally.

> **Status: planning.** There is no runnable code yet. Phase 0 is a set of throwaway spikes that test the risky ideas before anything is built on them. See the [milestones](../../milestones) and [issues](../../issues).

## Why

Two producers in different cities cannot both drive the same session today. One shares a screen or a project file and the other waits. Every hand-off means uploading a project, discovering a missing plugin, and re-linking samples both people already own under different paths.

This project removes both problems:

1. **Both people edit at once.** Notes, clips, automation and plugin tweaks appear live, with visible cursors and selections.
2. **No manual file wrangling.** A lobby knows which samples and plugins each person has. It uses local copies where they exist and transfers only what is missing.
3. **Efficient by design.** Each machine renders its own audio. Only edits and missing files cross the network.
4. **A look of its own.** Sleek, fast and visually distinct.

The test for v1: two people finish a full track together without sending a file by hand.

## How a lobby works

Each machine holds the whole session, renders audio with its own plugins and finds samples in its own library. A small relay server puts both people's edits into one order, carries presence, and forwards any sample the other side lacks. The audio engine never touches the network.

The session stores references, not files:

- A clip points at a **content hash**. If your library has that audio, the clip plays from your path. If not, the file transfers once.
- A plugin is stored as its **ID, parameter values and saved state**. Each machine loads its own installed copy.

## Proposed stack

| Part | Choice |
| --- | --- |
| Audio engine, plugin hosting | C++20, [JUCE 8](https://juce.com), [Tracktion Engine](https://github.com/Tracktion/tracktion_engine) |
| Interface | TypeScript in JUCE's web view, timeline on a GPU canvas |
| Session model, sync, relay server | TypeScript, one package shared by app, relay and tests |

These are proposals recorded in [`docs/adr`](docs/adr). Phase 0 confirms or replaces them.

## Documentation

- [Requirements](docs/requirements.md): the v1 requirement set, with IDs that issues refer to
- [Roadmap](docs/roadmap.md): six phases, each ending in something usable
- [Architecture decisions](docs/adr): one short record per decision
- [Ideas](docs/ideas.md): things deliberately not being designed yet
- [Contributing](CONTRIBUTING.md): workflow, definition of done, engineering rules

## License

Copyright (C) 2026 chadalon and contributors.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed without any warranty. See [`LICENSE`](LICENSE) for the full text and [ADR-0003](docs/adr/0003-license.md) for the reasoning.
