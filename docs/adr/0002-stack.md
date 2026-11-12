# ADR-0002: C++ engine, TypeScript interface and session model

- **Status:** Proposed
- **Date:** 2026-11-11
- **Deciders:** Chad

## Context

The product needs four things that pull in different directions:

1. Reliable hosting of third-party VST3 plugins and a low-latency audio graph on Windows and macOS.
2. A session model in which every change is an ordered operation, so two machines converge.
3. A distinctive, GPU-drawn interface that can change quickly.
4. A small team whose strongest language is TypeScript, followed by Rust and C++.

The VST3 SDK, JUCE and Tracktion Engine are C++. Plugin hosting is where years of edge cases live, and it adds nothing to what makes this product different. Rust hosting crates exist but are at 0.x versions.

The parts that are new here, ordering, undo, convergence and presence, are pure logic with no audio dependency.

## Decision

- **Audio engine, plugin hosting, file and device access:** C++20 on JUCE 8 and Tracktion Engine.
- **Interface:** TypeScript, running in JUCE's web view, with the timeline, meters and effects drawn on a GPU canvas.
- **Session model, sync client and relay server:** TypeScript, in one package shared by the app, the relay and the tests.
- **Source of truth:** the TypeScript session model. The C++ engine holds a projection of it and is told what changed.
- **Rust:** not used in v1.

## Alternatives considered

- **Fork Ardour, LMMS or Zrythm.** None was designed around a shared, ordered stream of edits, and each brings an interface toolkit we would discard.
- **All C++, with the engine's project model as the source of truth.** One language and no projection layer, but the novel logic lands in the team's weakest language, is harder to property-test, and cannot be reused by a browser client. This is the fallback if the projection proves too costly.
- **Rust core with a C++ shim for plugins.** Three languages for a team of one or two.
- **From scratch on the VST3 SDK.** Full ownership, and all of the plugin-hosting edge cases.
- **Electron or Tauri shell with a native audio sidecar.** Two processes to ship and keep in step, and plugin windows still need a native host.

## Consequences

- Two languages and a typed bridge between them. The bridge contract needs its own tests.
- The engine and the model can disagree. The projection must be one-way and testable.
- The web view differs between Windows and macOS. GPU canvas support must be checked on both.
- The session package can run headless in CI and, later, in a browser.
- The app must ship under a license compatible with GPLv3 (Tracktion Engine) and AGPLv3 (JUCE 8). See ADR-0003.

## How we will know

Phase 0 spikes answer these before the decision is accepted:

- Does the web view hold 60 frames a second while receiving playhead and meter data from C++?
- Can the TypeScript model drive Tracktion Engine for tracks, clips and plugin parameters without the two drifting?
- Does plugin parameter and state sync work through the bridge for Serum 2 and two or three other plugins?
