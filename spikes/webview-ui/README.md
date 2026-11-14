# Spike: web view interface driven by the C++ engine at 60 fps

Phase 0 spike for [issue #8](https://github.com/chadalon/collabgod/issues/8). ADR-0002 bets that a TypeScript interface in JUCE's web view stays smooth while the engine streams playhead and meter data. This spike is the smallest app that tests that bet: a page that draws 10,000 clips on the GPU with pan and zoom, fed by Tracktion Engine on every display refresh, and a benchmark that measures it and saves the numbers to a file.

It is throwaway code. Product code never includes it.

## What it does

`webview_spike` opens one window holding JUCE's web view: WebView2 (Edge) on Windows, WKWebView on macOS, WebKitGTK on Linux. The page is TypeScript, built with esbuild, served to the web view by the C++ app from `ui/dist`.

- **The timeline.** 10,000 clips on 128 tracks, laid out the same way every run, drawn with WebGL2 as instanced rectangles in one GPU buffer. Pan and zoom change four numbers sent to the GPU; nothing is re-uploaded. Track lanes, the grid, the loop region, the playhead and the meters are rebuilt every frame in a second, small buffer. Canvas 2D draws the same scene for comparison, and is the fallback if WebGL2 is missing.
- **The engine.** Tracktion Engine loops eight seconds of two tone generators, panned apart, with their levels automated so the meters move. On every display refresh the app reads the transport position, what the audio thread is actually outputting, and the master peak levels since the previous frame, and sends them to the page as one JSON event. The bridge is written up in [`contract/README.md`](contract/README.md); both sides test against its example files.
- **Two lessons from `spikes/engine-toolchain`.** Play waits until the playback context has settled, judged by `playbackContextChanged` rather than a fixed delay (its finding 8). And if the transport stops while it should be playing, as it does when the MIDI device list changes (its finding 10, #101), the app presses play again at the same place and counts it. The page shows both counts.
- **The benchmark.** Press **Run benchmark** and leave the window alone for about 50 seconds. It runs six phases, then times 200 bridge round trips and 20 seeks, and writes `report-<os>-<time>.json` to `Documents/CollabGod/webview-spike/` with a log beside it. The page shows a summary and where the file went.

| Phase | What it shows |
| --- | --- |
| `idle` | Playing, camera still, frames pushed from C++ |
| `pan-zoom` | Playing, a scripted pan and zoom from 20 seconds of timeline out to all of it and back, frames pushed |
| `pan-zoom-pull` | The same, but the page asks C++ for each frame instead (`pullFrame`) |
| `meters-256` | The same, with 256 extra meter levels in every frame |
| `reupload` | The same, re-uploading all 10,000 clips to the GPU every frame: the worst case for edits |
| `canvas2d` | The same, drawn with Canvas 2D, for comparison |

A phase **holds 60 fps** if it averages at least 57 frames a second and fewer than 1% of frames take over 25 ms (a frame shown twice at 60 Hz). The verdict at the top of the report is whether every streaming phase held it; `reupload` and `canvas2d` are there for comparison and do not count. On a 120 Hz display the frame rate can read 120.

Two round trips are measured. **Ping** calls a C++ function that answers at once: the bridge on its own. **Seek** asks the engine to jump at least two seconds away and waits until a frame shows the audio thread playing from there: page to C++, C++ to the audio thread, and back to the page. It cannot be shorter than the time to the next frame, up to 17 ms at 60 Hz.

## Build and run it

### Prerequisites

Everything `spikes/engine-toolchain` needs (Visual Studio 2022 or newer, or Xcode 15 or newer; CMake 3.22 or newer; Git), plus Node 22 or newer for the page. On Windows, CMake also downloads Microsoft's WebView2 SDK during configure (9 MB) and checks it against the hash nuget.org publishes; the WebView2 runtime itself comes with Windows 10 and 11.

### Steps

In a terminal (on Windows, the **Developer PowerShell for VS**):

```sh
cd spikes/webview-ui/ui
npm ci
npm run build
cd ..
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release --parallel 2
ctest --test-dir build -C Release --output-on-failure
```

`--parallel 2` matters on an 8 GB Mac: with four jobs the engine-toolchain build stalled and restarted the machine (its finding 11). On a machine with more memory, drop the number. The first build compiles all of JUCE and Tracktion Engine again, as engine-toolchain did: about 12 minutes on the Intel Mac with two jobs.

Then run it:

| | Command |
| --- | --- |
| Windows | `build\webview_spike_artefacts\Release\CollabGod WebView Spike.exe` |
| macOS | `open "build/webview_spike_artefacts/Release/CollabGod WebView Spike.app"`, or run `".../CollabGod WebView Spike.app/Contents/MacOS/CollabGod WebView Spike"` to see the log in the terminal and pass options |

Options:

| Option | What it does |
| --- | --- |
| `--benchmark [full\|quick]` | Run the benchmark as soon as the page loads. `quick` runs each phase for two seconds |
| `--exit-after-benchmark` | Quit when the report is saved; exit code 0 if the page reported no errors |
| `--simulated-audio` | Use a simulated sound card instead of the default output device |
| `--emit-hz <n>` | Send frames at a fixed rate instead of on every display refresh |
| `--ui-dir <folder>` | Serve the page from another folder |
| `--report-dir <folder>` | Write reports and the log somewhere else |
| `selftest` | Run the C++ checks without a window; `ctest` runs this |

To work on the page, run `node build.mjs --watch` in `ui` and press **R** in the window to reload; the C++ side does not need rebuilding. The page also runs in an ordinary browser with a simulated engine (serve `ui/dist` with any static server), which is handy for layout but measures nothing about the bridge.

### Troubleshooting

- **The window says the page has not been built.** Run `npm ci` and `npm run build` in `ui`, then start the app again.
- **Windows: `Could not download the WebView2 SDK`, or a hash mismatch.** Configure needs to reach nuget.org once. If you already have the package, pass `-DJUCE_WEBVIEW2_PACKAGE_LOCATION=<folder containing Microsoft.Web.WebView2.*>`.
- **macOS, Xcode 15: errors in `tracktion_Archive.cpp` or `ChannelMap`.** The same Apple clang 15 patch as engine-toolchain applies here, from the shared `../engine-toolchain/cmake/EngineDependencies.cmake`. Re-run the configure step.
- **macOS asks for microphone access.** The default device is opened with its inputs. Declining should leave output working; note in the PR if it does not.
- **Linux.** Not a target platform, but it builds and runs; it is how the spike was developed. Install the engine-toolchain Linux packages plus `libwebkit2gtk-4.1-dev` and `libgtk-3-dev`. Without a display, run it under `xvfb-run`; configure with `-DWEBVIEW_SPIKE_END_TO_END_TEST=ON` to add an end-to-end `ctest` that opens the window, runs the quick benchmark and checks it reported no errors.

## Dependencies

| Dependency | Version | License | Where from |
| --- | --- | --- | --- |
| JUCE and Tracktion Engine | As engine-toolchain | AGPLv3 / GPLv3 | `../engine-toolchain/cmake/EngineDependencies.cmake` (ADR-0009) |
| WebView2 SDK (Windows only, build time) | 1.0.3485.44 | Microsoft's BSD-style license in the package's `LICENSE.txt`; read it before this goes into product | nuget.org, SHA-512 checked |
| esbuild, TypeScript, Vitest (page build and tests only) | `ui/package-lock.json` | MIT, Apache-2.0, MIT | npm |

The page has no runtime dependencies. It talks to `window.__JUCE__` through its own 80-line wrapper (`ui/src/bridge.ts`) that speaks the same protocol as JUCE's `@juce-framework/webview` package, so tests and a plain browser can supply a fake host.

## Findings

Numbers marked *Linux* come from a 2-core cloud machine with no GPU, running WebKitGTK under a virtual display with software rendering. Numbers marked *Windows runner* and *macOS runner* come from CI's informational end-to-end step on GitHub's machines, which also have no GPU. They show that every piece talks to every other and how each web view behaves; they say nothing about whether Chad's machines hold 60 fps. Those numbers come from the manual runs below.

1. **The whole path works, on Linux and on Windows.** The window opens, the web view loads the page from the C++ resource provider, the page calls C++ and C++ streams frames to it, the benchmark runs every phase, saves its report and the app exits cleanly: *Linux* with WebKitGTK, and *Windows runner* with WebView2. The self-test passes on Linux and the Windows runner; on the macOS runner it first failed on a timing check, which led to finding 8.
2. **WebKit refuses a shader that Chromium accepts.** The first Linux run failed to link the WebGL program: `Precisions of uniform 'u_world' differ between VERTEX and FRAGMENT shaders`. The fragment shader said `mediump`, the vertex shader defaults to `highp`, and WebKit enforces the rule that a uniform used in both must match. Fixed with `highp` in both. Every shader must be tested in WebKit as well as Chromium; a WebView2-only test would have shipped this to the Mac.
3. **WebGL2 is the floor; WebGPU cannot be relied on.** WKWebView gets WebGPU only on macOS 26, and Chad's Intel Mac is on macOS 13.7, which cannot run 26. *Windows runner*: WebView2 has the WebGPU API but got no adapter, because the runner has no GPU; on a machine with a Direct3D 12 GPU it should. So the interface must draw with WebGL2, and WebGPU could only ever be an extra. *Linux*: WebGL2 yes, no WebGPU API.
4. **WebKit hides the GPU's name; WebView2 does not.** *Linux*: WebKitGTK reported its renderer as `Apple GPU`, vendor `Apple Inc.`, on a machine with no Apple hardware and no GPU: WebKit masks `WEBGL_debug_renderer_info`. *Windows runner*: WebView2 reported the truth, `ANGLE (Microsoft, Microsoft Basic Render Driver ... Direct3D11)`, which is Windows' software renderer. A Mac report cannot say which GPU drew it; a Windows report can, and shows when WebView2 has fallen back to software.
5. **The bridge itself is fast on Windows.** *Windows runner*: a native function call answered straight away came back in 0.3 ms at the median (p95 18 ms), and a seek was heard 15.9 ms after it was sent, about one frame. *Linux*: 21 ms and 19 ms, because JUCE runs WebKitGTK in a separate process and every message crosses a pipe. The Linux numbers do not predict the Mac's.
6. **Frames can arrive in bursts.** *Linux*: frames left C++ about 95 times a second (a virtual display has no real refresh) but reached the page in clumps, several in the same millisecond, with gaps of about 21 ms between. The page always draws the newest frame and counts drawn frames that had no new data; that count was 0. If WebView2 or WKWebView clump the same way, the interface must never animate by counting events, only from the timestamps and positions in them. The manual runs show the arrival pattern on both systems (`dataIntervalMs` in the report).
7. **Pull costs a round trip per frame.** In `pan-zoom-pull` the page waits for C++ to answer before it can ask again, so it gets at most one frame per round trip. *Linux*: one data frame per drawn frame, about 45 a second, against about 95 pushed. Push is the default; pull is there to compare.
8. **Settling needs the device scans as well as the playback context.** Engine-toolchain finding 8 says to wait for `playbackContextChanged` before pressing play. That was not enough. On the *macOS runner* the context was created once and stayed quiet, the host pressed play, and then two of the engine's own MIDI device scans landed. The scans run on a message-thread timer, and on a fresh machine there are two (as far as Tracktion's source shows, the second is because it enables a default MIDI output on first run). They rebuilt the devices and stopped the transport (engine-toolchain finding 10, #101), and no `playbackContextChanged` came with them. The host resumed it, but the first quarter-second was lost. The host now settles only when the context exists, the first device scan has reported (or 1.5 s have passed, for a machine with no MIDI devices), and neither the context nor the device lists have changed for 300 ms of ticks it actually ran. Measuring from the last change alone was fooled when the message thread stalled: opening the window and web view held it for 2.7 s on Linux and about 4 s on the Windows runner, and the first check after the stall settled while a device change was still queued. *Linux*, fresh settings: settled after about 0.52 s, 1 context change and 2 device list changes, no stop afterwards. The report's `host.settle` shows the same for each real machine.
9. **A MIDI device change still stops the transport, and resuming works.** The self-test adds a virtual MIDI device mid-playback; the transport stops, the host sees it stopped for 150 ms and presses play at the last audible position. That is a workaround in the app for #101, not a fix: there is a gap of at least 150 ms of silence, plus whatever the rebuild takes.
10. **WebView2's first start is slow.** *Windows runner*: about 9 s passed between the engine settling and the page's first message, on a runner where WebView2 had never run and had to create its profile folder. If that holds on a real machine on first launch, it eats into UX-4's one minute; later launches should be quicker. The manual run should note how long the window stays blank.
11. **Timings in WebKit are whole milliseconds.** *Linux*: every timing came back as a whole number of milliseconds, because WebKit coarsens `performance.now()`. Frame intervals and round trips are still fine to compare, but sub-millisecond differences in the reports mean nothing. WebView2 reports fractions.

*Linux* quick benchmark, for the shape of the report only:

| Phase | fps | Frame p95 | Over 25 ms |
| --- | --- | --- | --- |
| idle | 46.4 | 24 ms | 2 |
| pan-zoom | 44.3 | 26 ms | 6 |
| pan-zoom-pull | 48.0 | 24 ms | 3 |
| meters-256 | 44.6 | 25 ms | 3 |
| reupload | 43.9 | 26 ms | 8 |
| canvas2d | 62.1 | 17 ms | 0 |

Software WebGL in a virtual display is slower than software Canvas 2D; on a GPU it should be the other way round. On the *Windows runner*, also software, the slowest streaming phase was `pan-zoom` at 62 fps with 4 frames over 25 ms, just failing the 1% rule in a two-second phase.

### Windows and macOS web views

To be filled in from the manual runs. *Runner* rows come from CI's informational end-to-end step, on GitHub's machines without a GPU.

| | WebView2, Windows (Chad) | WKWebView, macOS 13.7 (Chad) | WebView2, CI runner | WKWebView, CI runner |
| --- | --- | --- | --- | --- |
| Web view version (user agent) | | | | |
| WebGL2 | | | yes | |
| GPU reported | | | Microsoft Basic Render Driver (software), through ANGLE on Direct3D 11 | |
| WebGPU API / adapter | | | API, no adapter (no GPU) | |
| Display refresh (fps idle) | | | | |
| Holds 60 fps, every streaming phase | | | | |
| Frame p95, `pan-zoom` | | | | |
| Data arrival (`dataIntervalMs` p50 / p95) | | | | |
| Bridge ping median / p95 | | | 0.3 / 18 ms | |
| Seek to audible median / p95 | | | 15.9 ms median | |
| Engine settle: ms, context and device list changes | | | | |
| Launch to page running | | | about 13 s, first WebView2 start | |
| Pinch and trackpad zoom | | | | |

## What is left (needs the maintainers' machines)

The issue's 60 fps, visual and web view comparison checks can only be done by a person on the two machines. Each run leaves a report file; attach it to the PR or paste its `verdict` and `phases`.

- [ ] Windows: build, `ctest` passes, the window shows the timeline with the playhead moving and both meters dancing, and the tones play through the Focusrite.
- [ ] Windows: **Run benchmark** with the window in front, at its normal size; attach the report.
- [ ] Windows: by eye, pan and zoom with the mouse while it plays. Is it smooth? Any stutter, tearing or blank frames? Does the playhead move steadily or in jumps?
- [ ] Mac: the same three, built with `--parallel 2`.
- [ ] Mac: trackpad pinch and two-finger scroll. Pinch arrives as Ctrl+wheel in WebKit and should zoom time.
- [ ] Both: plug in or unplug a MIDI controller while it plays. Playback should carry on after a short gap, and the page's "resumed after unexpected stops" count should go up by one.
- [ ] Both: resize the window and drag it between displays if there are two. Does the canvas stay sharp (no blur from the pixel ratio)?
- [ ] Both: how long the window stays blank on the first launch and on a second launch (finding 10).
- [ ] Both: anything that looks different between the two web views: fonts, colours, edges of the clips, the meters, scrolling feel.
- [ ] Fill in the table above and record the outcome in ADR-0002.

## Not covered

- Text in the canvas (ruler numbers, clip names). Text is where WebGL is hard; it needs its own look before the timeline is built for real.
- Waveforms, which UX-2 also names. They need sample data in the page, a different kind of load.
- WebGPU rendering. The page only detects it (finding 3).
- Plugin editor windows next to the web view. Issues #12 and #14.
- Input latency: the time from a mouse move to the picture changing. The benchmark measures data and frame timing, not the display pipeline.
