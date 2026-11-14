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

- **Audio engine, plugin hosting, file and device access:** C++20 on JUCE 9 and Tracktion Engine. Current Tracktion Engine is built on JUCE 9; its last JUCE 8 release is from May 2025 (issue #7, decided 2026-11-13).
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
- The app must ship under a license compatible with GPLv3 (Tracktion Engine) and AGPLv3 (JUCE 9). See ADR-0003.

## How we will know

Phase 0 spikes answer these before the decision is accepted:

- Does the web view hold 60 frames a second while receiving playhead and meter data from C++?
- Can the TypeScript model drive Tracktion Engine for tracks, clips and plugin parameters without the two drifting?
- Does plugin parameter and state sync work through the bridge for Serum 2 and two or three other plugins?

## Findings so far

**Issue #8, web view at 60 fps** (`spikes/webview-ui`, in progress). The pieces work together: a TypeScript page in JUCE 9's web view draws 10,000 clips with WebGL2, and Tracktion Engine streams the playhead and stereo meters to it on every display refresh, with a contract both sides test against. Whether it holds 60 fps on Windows and macOS is still open: that needs the benchmark run on both maintainers' machines, and this section gets the numbers then. What is already known:

- WebGL2 is the drawing floor. WKWebView gets WebGPU only from macOS 26, and the Intel Mac on macOS 13.7 cannot run it; WebView2 has it on Windows. The interface draws with WebGL2, and anything built on WebGPU needs a WebGL2 path too.
- WebKit is stricter than Chromium about shaders: it refused to link one that Chromium would accept. Every shader is tested in both web views.
- WebKit hides the GPU's name, so a report from a Mac cannot say which GPU drew it.
- The bridge is not the bottleneck on Windows or macOS: on the CI runners a native call came back in under half a millisecond at the median, and a seek was heard about one frame after it was sent.
- Engine frames and drawn frames are not in step: on the macOS runner a quarter of drawn frames had no new engine data. The interface animates the playhead from positions and timestamps, not by counting events, or asks C++ for data as it draws each frame, which kept every frame fresh on both runners.
- The engine's start-up is more than the playback context: its own MIDI device scans can land after the context exists and stop the transport. The host waits for both to go quiet and resumes a transport that stops on its own (#101).
- On Windows the web view must be asked for explicitly: JUCE's default there is still Internet Explorer. The spike links the WebView2 loader statically, from the SDK downloaded at configure time.
