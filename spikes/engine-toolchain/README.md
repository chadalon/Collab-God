# Spike: build JUCE and Tracktion Engine on Windows and macOS

Phase 0 spike for [issue #7](https://github.com/chadalon/collabgod/issues/7). Everything else in the app depends on a C++ toolchain that both maintainers' machines and CI can build. This spike is the smallest CMake project that pulls in pinned JUCE and Tracktion Engine, plays a sine tone and then an audio file through Tracktion Engine, and renders the same edit offline so a machine without speakers can check the sound.

It is throwaway code. Product code never includes it.

## What it does

`engine_spike` is a console app with two commands.

| Command | What it does |
| --- | --- |
| `engine_spike play [file]` | Opens the default output device and plays a 440 Hz sine tone for one second, then the file, printing the transport's state four times a second. Gives up five seconds after the end if playback stalls. With no file it plays a generated 660 Hz test tone in its place. WAV, AIFF, FLAC and Ogg are safe choices. |
| `engine_spike check [--out dir]` | Opens no device. Builds the same edit, renders it to `render.wav`, and checks it: 440 Hz in the first second and no 660 Hz, 660 Hz in the second and the 440 Hz tone at least 40 dB down, no clipping, two seconds long. Exits 0 on pass. `ctest` runs this. |
| `engine_spike live-check [--out dir]` | Opens no device. Plays the same edit through Tracktion Engine's hosted audio device, which the program drives block by block as a sound card would, using the same transport code as `play`. Checks the result the same way and fails if playback never reaches the end. `ctest` runs this too. |

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
- **macOS asks for microphone access.** It may, because the default device is opened with its inputs. Declining should leave output working; please note in the PR if it does not.
- **Linux.** Not a target platform, but the spike builds there too; it is how it was developed. Install the JUCE Linux packages first: on Ubuntu, `libasound2-dev libfreetype-dev libfontconfig1-dev libx11-dev libxrandr-dev libxinerama-dev libxcursor-dev libxcomposite-dev libxext-dev libxi-dev libxrender-dev libgl-dev`.

## Dependencies

| Dependency | Version | License | Pinned commit |
| --- | --- | --- | --- |
| [Tracktion Engine](https://github.com/Tracktion/tracktion_engine) | 3.5.0, `develop` of 2026-10-24 | GPLv3 or commercial | `a5e44996f5f08dfa6af5f5d02d900fb3cfa37422` |
| [JUCE](https://github.com/juce-framework/JUCE) | 9.0.5 plus `develop` of 2026-10-16 | AGPLv3 or commercial | `7ff644f65d7daa1428c34b9738ebb5c449dc9172` |

JUCE is the exact commit Tracktion Engine's own `modules/juce` submodule points at, so we build the pair Tracktion tests together. When Tracktion Engine moves, JUCE moves to its new submodule commit in the same change; `git ls-tree <tracktion-commit> modules/juce` prints it.

How they are fetched, and why, is [ADR-0007](../../docs/adr/0007-cpp-dependencies.md).

## Findings

1. **It builds and plays through Tracktion Engine.** On Linux in a cloud session the offline render passes: the tone at -12.0 dBFS in the first second, the file at -12.0 dBFS in the second, and the automated tone 72 dB down once the file starts. The same check passes on GitHub's Windows and macOS runners, below. Nobody has heard the `play` command yet; see "What is left".
2. **The current pair is JUCE 9, not JUCE 8.** ADR-0002 says JUCE 8. Tracktion Engine's last tag, v3.2.0 (May 2025), is on JUCE 8.0.x and is 18 months old. Its `develop` branch is at 3.5.0 on JUCE 9.0.5, still dual-licensed AGPLv3, and gets fixes weekly. The spike uses `develop` pinned to a commit. Chad chose JUCE 9 on 2026-11-13, and ADR-0002 and the root README now say so.
3. **Tracktion Engine has made no tagged release since v3.2.0.** Pinning to a commit is the only way to use current code, which rules out anything that needs a tag. See ADR-0007.
4. **FetchContent cannot shallow-fetch a commit.** `GIT_SHALLOW` with a commit hash fails unless the commit happens to be a branch tip (`fatal: reference is not a tree`). Without `GIT_SHALLOW`, FetchContent clones all history: 1.7 GB for Tracktion Engine. The spike fetches each pinned commit alone with `git fetch --depth 1` (`cmake/ShallowFetchCommit.cmake`): 112 MB for Tracktion Engine and 130 MB for JUCE once checked out, and configure including both downloads took about 40 seconds on a cloud machine. Tarball URLs would be smaller still, but GitHub does not promise their checksums stay the same.
5. **Two Tracktion Engine API traps.** The Tone Generator is not registered by default and needs `createBuiltInType<ToneGeneratorPlugin>()`. Assigning a plugin's CachedValues (`tone->frequency = 440`) changes the saved state but not what plays: the first render came out as 220 Hz at full scale, the plugin's defaults. Values must be set through the automatable parameters. Worth knowing for the projection spike: the engine's state tree and what the audio thread uses are not the same thing.
6. **Memory, not CPU, limits a parallel build.** On a 2-core, 7 GB machine, four parallel jobs got the compiler killed; two jobs were fine. JUCE's link-time optimisation is off: with it, every rebuild of a one-line change took about 4 minutes to link; without it, 13 seconds.
7. **Build times.** About 3 minutes cold on the Windows runner and 6.5 on the macOS runner, plus a little over a minute of configure and download on each; about 5 minutes on the 2-core Linux machine. The table is below.

### CI build times

Each CI run writes these to the job summary.

| Runner | Configure, including downloads | Cold build | Render and check |
| --- | --- | --- | --- |
| `windows-latest` (Visual Studio 18 2026, MSVC 19.51) | 80 s | 3 min 12 s | 1 s |
| `macos-latest` (AppleClang 21) | 75 s | 6 min 25 s | 3 s |

From the first CI run on pull request #97, building with `--parallel 4`. The whole job took under 5 minutes on Windows and about 8 on macOS, inside the 15 minutes issue #20 allows. Neither compiler printed a warning, with JUCE's recommended warning flags on the spike's own code.

Nothing is cached yet, so every CI run is a cold build. If the times become a problem, ccache on macOS and a cache of the downloaded sources on both are the first things to try; issue #20 owns that.

## What is left (needs the maintainers' machines)

- [ ] Build from a clean checkout on Chad's Windows machine with the steps above, and note the time and any step that differed.
- [ ] Same on a Mac.
- [ ] Run `engine_spike play` on both and listen: a clean 440 Hz tone for one second, then the 660 Hz test tone, with no click at the change and no crackle. Then `play` with a real sample from your library.
- [ ] Note which audio device type the spike opened on each (it prints it): WASAPI or ASIO on Windows, Core Audio on macOS.

## Not covered

- Choosing a device, sample rate or buffer size; ASIO. That is Phase 1.
- Plugin hosting. JUCE's VST3 host is compiled in but not used here; issues #12 and #14 cover it.
- Code signing, notarisation and installers. Phase 5.
