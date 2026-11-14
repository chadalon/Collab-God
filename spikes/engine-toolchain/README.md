# Spike: build JUCE and Tracktion Engine on Windows and macOS

Phase 0 spike for [issue #7](https://github.com/chadalon/collabgod/issues/7). Everything else in the app depends on a C++ toolchain that both maintainers' machines and CI can build. This spike is the smallest CMake project that pulls in pinned JUCE and Tracktion Engine, plays a sine tone and then an audio file through Tracktion Engine, and renders the same edit offline so a machine without speakers can check the sound.

It is throwaway code. Product code never includes it.

## What it does

`engine_spike` is a console app with two commands.

| Command | What it does |
| --- | --- |
| `engine_spike play [file]` | Opens the default output device, scans MIDI devices and waits a second (findings 8 and 10), then plays a 440 Hz sine tone for one second and then the file. Prints the transport's state twice a second, and presses play again, up to three times, if it stops before the end. Gives up five seconds after the end if playback stalls. With no file it plays a generated 660 Hz test tone in its place. WAV, AIFF, FLAC and Ogg are safe choices. |
| `engine_spike check [--out dir]` | Opens no device. Builds the same edit, renders it to `render.wav`, and checks it: 440 Hz in the first second and no 660 Hz, 660 Hz in the second and the 440 Hz tone at least 40 dB down, no clipping, two seconds long. Exits 0 on pass. `ctest` runs this. |
| `engine_spike live-check [--out dir]` | Opens no device. Plays the same edit through Tracktion Engine's hosted audio device, which the program drives block by block as a sound card would, using the same transport code as `play`. Checks the result the same way and fails if playback never reaches the end. `ctest` runs this too. |
| `engine_spike live-check --change-midi-devices` | The same, but adds a virtual MIDI device partway through, as plugging in a controller would, and reports whether playback survives. In this Tracktion Engine version it does not (finding 10). `ctest` runs it and expects that failure. |

The edit has two audio tracks. Track 1 holds Tracktion Engine's Tone Generator plugin, with its level automated to silence at one second. Track 2 holds the file as an audio clip starting at one second. So both a generator plugin and a file clip, and one automation curve, go through the engine's real playback graph.

## Build it

### Prerequisites

| | Windows | macOS |
| --- | --- | --- |
| Compiler | Visual Studio 2022 or newer with **Desktop development with C++** | Xcode 15 or newer, or its command line tools (`xcode-select --install`) |
| CMake | 3.22 or newer (Visual Studio's bundled CMake works) | 3.22 or newer (`brew install cmake`) |
| Git | Git for Windows | Comes with the Xcode tools |
| Disk | About 2 GB for sources and a build | Same |

Nothing else is installed by hand: CMake downloads JUCE and Tracktion Engine during configure, about 250 MB on disk together.

### Steps

From a clean checkout, in a terminal (on Windows, the **Developer PowerShell for VS** or any shell with `cmake` and `git` on the path):

```sh
cd spikes/engine-toolchain
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release --parallel
ctest --test-dir build -C Release --output-on-failure
```

The first configure takes about a minute while it downloads; later ones take seconds. The first build compiles all of JUCE and Tracktion Engine, about 5 to 15 minutes depending on the machine; after that, changing a spike file rebuilds in seconds.

Then play it:

| | Command |
| --- | --- |
| Windows | `build\engine_spike_artefacts\Release\engine_spike.exe play` |
| macOS | `build/engine_spike_artefacts/Release/engine_spike play` |

Add a path to any audio file after `play` to hear that file after the tone.

To open the project in an IDE instead, add `-G Xcode` on macOS to the first command; on Windows the default generator already makes a Visual Studio solution in `build`.

### Building against a local JUCE or Tracktion Engine

To debug or patch a dependency, point CMake at your own checkout:

```sh
cmake -S . -B build -DFETCHCONTENT_SOURCE_DIR_JUCE=/path/to/JUCE -DFETCHCONTENT_SOURCE_DIR_TRACKTION=/path/to/tracktion_engine
```

### Troubleshooting

- **The compiler is killed partway through, or the machine stalls.** Some Tracktion Engine files need well over 1 GB of memory each to compile. Lower the parallelism: `cmake --build build --config Release --parallel 2`.
- **`play` says no output device is open.** Check that an output device is connected and enabled in the system sound settings. The spike uses the system default and has no device chooser; that is issue #27.
- **macOS, Xcode 15 or older: `no matching constructor for initialization of 'ExportableUpdate'`, or `no matching function for call to 'construct_at'` for `ChannelMap::Entry`.** Apple clang 15 lacks C++20 parenthesised aggregate initialisation, which Tracktion Engine uses. `CMakeLists.txt` patches the two places in the downloaded source on Apple (finding 11); re-run the configure step if you see it. It is skipped when `FETCHCONTENT_SOURCE_DIR_TRACKTION` points at your own checkout; patch that yourself. It goes away once Xcode 16 is required or Tracktion fixes it.
- **macOS asks for microphone access.** It may, because the default device is opened with its inputs. Declining should leave output working; please note in the PR if it does not.
- **Linux.** Not a target platform, but the spike builds there too; it is how it was developed. Install the JUCE Linux packages first: on Ubuntu, `libasound2-dev libfreetype-dev libfontconfig1-dev libx11-dev libxrandr-dev libxinerama-dev libxcursor-dev libxcomposite-dev libxext-dev libxi-dev libxrender-dev libgl-dev`.

## Dependencies

| Dependency | Version | License | Pinned commit |
| --- | --- | --- | --- |
| [Tracktion Engine](https://github.com/Tracktion/tracktion_engine) | 3.5.0, `develop` of 2026-10-24 | GPLv3 or commercial | `a5e44996f5f08dfa6af5f5d02d900fb3cfa37422` |
| [JUCE](https://github.com/juce-framework/JUCE) | 9.0.5 plus `develop` of 2026-10-16 | AGPLv3 or commercial | `7ff644f65d7daa1428c34b9738ebb5c449dc9172` |

JUCE is the exact commit Tracktion Engine's own `modules/juce` submodule points at, so we build the pair Tracktion tests together. When Tracktion Engine moves, JUCE moves to its new submodule commit in the same change; `git ls-tree <tracktion-commit> modules/juce` prints it.

How they are fetched, and why, is [ADR-0009](../../docs/adr/0009-cpp-dependencies.md).

## Findings

1. **It builds and plays through Tracktion Engine.** On Linux in a cloud session the offline render passes: the tone at -12.0 dBFS in the first second, the file at -12.0 dBFS in the second, and the automated tone 72 dB down once the file starts. The same check passes on GitHub's Windows and macOS runners, below. Chad has heard `play` on Windows (finding 8 and "What is left").
2. **The current pair is JUCE 9, not JUCE 8.** ADR-0002 says JUCE 8. Tracktion Engine's last tag, v3.2.0 (May 2025), is on JUCE 8.0.x and is 18 months old. Its `develop` branch is at 3.5.0 on JUCE 9.0.5, still dual-licensed AGPLv3, and gets fixes weekly. The spike uses `develop` pinned to a commit. Chad chose JUCE 9 on 2026-11-13, and ADR-0002 and the root README now say so.
3. **Tracktion Engine has made no tagged release since v3.2.0.** Pinning to a commit is the only way to use current code, which rules out anything that needs a tag. See ADR-0009.
4. **FetchContent cannot shallow-fetch a commit.** `GIT_SHALLOW` with a commit hash fails unless the commit happens to be a branch tip (`fatal: reference is not a tree`). Without `GIT_SHALLOW`, FetchContent clones all history: 1.7 GB for Tracktion Engine. The spike fetches each pinned commit alone with `git fetch --depth 1` (`cmake/ShallowFetchCommit.cmake`): 112 MB for Tracktion Engine and 130 MB for JUCE once checked out, and configure including both downloads took about 40 seconds on a cloud machine. Tarball URLs would be smaller still, but GitHub does not promise their checksums stay the same.
5. **Two Tracktion Engine API traps.** The Tone Generator is not registered by default and needs `createBuiltInType<ToneGeneratorPlugin>()`. Assigning a plugin's CachedValues (`tone->frequency = 440`) changes the saved state but not what plays: the first render came out as 220 Hz at full scale, the plugin's defaults. Values must be set through the automatable parameters. Worth knowing for the projection spike: the engine's state tree and what the audio thread uses are not the same thing.
6. **Memory, not CPU, limits a parallel build.** On a 2-core, 7 GB machine, four parallel jobs got the compiler killed; two jobs were fine. JUCE's link-time optimisation is off: with it, every rebuild of a one-line change took about 4 minutes to link; without it, 13 seconds.
7. **Build times.** About 3 minutes cold on the Windows runner and 6.5 on the macOS runner, plus a little over a minute of configure and download on each; about 5 minutes on the 2-core Linux machine; 11 min 55 s on Chad's 4-core Intel Mac with `--parallel 2`, plus 2 minutes of configure and download. The table is below.
8. **Play is lost if it comes before the engine settles.** On Chad's Windows machine (Windows Audio, Focusrite USB, 44.1 kHz, 441 samples), pressing play straight after opening the device did nothing: the transport stayed stopped while the tone kept sounding, because Tracktion runs plugins while stopped by default. The log showed why: the engine rebuilt the edit's playback context about 0.24 s after start, after the play request, and the rebuild dropped it. Waiting until that rebuild has happened, here a fixed 1 s, made playback work. A simulated sound card on Linux did not reproduce it, so this depends on a real device. For the app: do not start playback, or anything that assumes a running transport, until the device and playback context have settled. Listen for `TransportControl::Listener::playbackContextChanged` instead of using a fixed delay.
9. **Parameter changes are applied in steps.** The tone's 5 ms fade-out came out as three steps instead of a ramp, with one jump about 4.5 times the steepest slope of the tone itself. That is the click heard where the tone hands over to the file. The file itself starts at zero and does not click. The Tone Generator applies its level once per processing chunk, with no smoothing between. For the app: anything the user or the other person moves live (volume, pan, plugin parameters, PLG-5) needs smoothing on the audio thread, or it will click the same way.
10. **A change in the MIDI device list stops the transport.** On Chad's Windows machine, playback with a 6 s sample stopped at edit position 2.96–2.98 s on every run, always 4.08–4.09 s after the program started, with nothing in the spike calling stop. The cause is Tracktion Engine's MIDI device scan. It runs every 4 seconds (`midiRescanIntervalSeconds = 4` in `DeviceManager`), and the first one found the machine's MIDI ports. When the list changes, the engine releases and rebuilds every playing edit's device list (`clearAllContextDevices`, then `reloadAllContextDevices`). Releasing calls `clearNodes()`, which destroys the playback graph and the playhead that holds the playing state, and the rebuilt graph comes back stopped. The sample itself was ruled out: it is a plain mono 16-bit 44.1 kHz WAV with no extra chunks, and it plays through the simulated device without stopping. Adding a virtual MIDI device during simulated playback stops the transport every time, so the cause is reproduced off the real machine; `ctest` runs that as `midi_device_change_stops_transport`, marked as expected to fail so that it flags a Tracktion update that changes the behaviour. The earlier test-tone runs ended before 4 s, which is why they never hit it. For the app: plugging in or removing a MIDI controller mid-session will stop playback for whoever plugged it in. The app needs to resume playback after a device change, or Tracktion needs fixing upstream. `play` now scans MIDI devices during its startup wait, so the scan should no longer land mid-playback. Followed up in #101.
11. **Apple clang 15 cannot build Tracktion Engine unpatched.** On an Intel MacBook Pro (macOS 13.7, Apple clang 15.0.0, 4 cores, 8 GB) the build failed at 98% in `tracktion_Archive.cpp` (`ExportableUpdate (a, b)`) and then in `tracktion_EditNodeBuilder.cpp` (`emplace_back (a, b)` on `ChannelMap::Entry`). Both need C++20 parenthesised aggregate initialisation, which Apple clang added in version 16 (Xcode 16 needs macOS 14). The spike patches the downloaded source at configure time on Apple: brace-init for the first, a constructor for the second. With the patches, the build and both `ctest` tests pass. The CI runner (AppleClang 21) does not need them. For the app: either require Xcode 16 on macOS or carry these patches, and report both upstream. Building with plain `--parallel` (4 jobs) on 8 GB made the machine stall and restart; `--parallel 2` was fine.

### CI build times

Each CI run writes these to the job summary.

| Runner | Configure, including downloads | Cold build | Render and check |
| --- | --- | --- | --- |
| `windows-latest` (Visual Studio 18 2026, MSVC 19.51) | 80 s | 3 min 12 s | 1 s |
| `macos-latest` (AppleClang 21) | 75 s | 6 min 25 s | 3 s |

From the first CI run on pull request #97, building with `--parallel 4`. The whole job took under 5 minutes on Windows and about 8 on macOS, inside the 15 minutes issue #20 allows. Neither compiler printed a warning, with JUCE's recommended warning flags on the spike's own code.

Nothing is cached yet, so every CI run is a cold build. If the times become a problem, ccache on macOS and a cache of the downloaded sources on both are the first things to try; issue #20 owns that.

## What is left (needs the maintainers' machines)

- [x] Windows (Chad, 2026-11-13): builds, and after the play-timing fix `play` runs to the end. Output: Windows Audio, Focusrite USB, 44.1 kHz, 441 samples per buffer, under 1% CPU. Heard: the tone, then the test tone, with a click at the change (finding 9). The device's dropout counter read 1 from the first status line on every run. The first runs also had a crackle a few seconds in; whether those are the same thing is not known.
- [x] Windows: `ctest --test-dir build -C Release --output-on-failure` passes both tests (render 0.63 s, live 0.69 s).
- [x] Windows: `play` with a real sample from the library. It plays, but the transport stopped about 2 s into the sample, 4 s after start, and the spike had to press play again; the cause is the MIDI device scan (finding 10, #101). Not yet re-run with the MIDI scan moved before play.
- [x] Mac (Chad, 2026-11-13, Intel MacBook Pro, macOS 13.7, Apple clang 15): builds with the patches in finding 11 and `--parallel 2`, and `ctest` passed both tests (render and live play) before the MIDI test from finding 10 was merged; not re-run since. `play` runs to the end on CoreAudio Built-in Output, 44.1 kHz, 512 samples per buffer, CPU 1 to 10.6%. Heard: both sounds, with crackling consistently at the very start of the first sound, and at times later in the run; the later crackle did not repeat when tried again. The start-of-tone crackle is not explained: it is before the hand-over that finding 9 covers. The dropout counter read -1 on every line, which looks like "not available" on this device, so it says nothing either way.
- [ ] Mac: the crackle at the start of the first sound. Moved to #101: the likely cause is the engine rebuilding its playback graph while the tone is already sounding, the same family as finding 10.
- [x] Mac (2026-11-14): timed cold build from an empty build folder on the same Mac, with the steps above and `--parallel 2`: configure and download 2 min, build 11 min 55 s, no warnings. `ctest` passes all three tests (render 7.49 s, live 0.92 s, MIDI device change 1.11 s).

## Not covered

- Choosing a device, sample rate or buffer size; ASIO. That is Phase 1.
- Plugin hosting. JUCE's VST3 host is compiled in but not used here; issues #12 and #14 cover it.
- Code signing, notarisation and installers. Phase 5.
