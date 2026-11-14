# ADR-0009: Fetch C++ dependencies at configure time, pinned to a commit

- **Status:** Proposed
- **Date:** 2026-11-12
- **Deciders:** Chad

## Context

The engine needs JUCE and Tracktion Engine (ADR-0002). Issue #7 asks how they get into the build: git submodules, CPM or CMake's FetchContent.

Three facts from the spike in `spikes/engine-toolchain` shape the answer:

- Tracktion Engine has made no tagged release since v3.2.0 in May 2025. Current code, on JUCE 9, is only on its `develop` branch, so we have to pin to a commit, not a tag.
- Tracktion Engine's full git history is 1.7 GB. A single commit is about 40 MB to download.
- FetchContent and CPM can only fetch shallowly when given a branch or a tag. Given a commit hash with `GIT_SHALLOW`, CMake fails unless the commit is a branch tip; without it, CMake clones all history.

JUCE has to match the commit Tracktion Engine was tested with, which Tracktion records in its `modules/juce` submodule.

## Decision

Fetch JUCE and Tracktion Engine with FetchContent at configure time, each pinned to a full commit hash, using a small script (`cmake/ShallowFetchCommit.cmake`) that fetches just that commit with `git fetch --depth 1`. JUCE is pinned to the commit Tracktion Engine's submodule points at, and the two move together. A developer can build against a local checkout with `FETCHCONTENT_SOURCE_DIR_<NAME>`.

## Alternatives considered

- **Git submodules.** Pinned by commit natively, and Dependabot can bump them. But every clone of the repo needs `--recursive`, a plain recursive clone pulls Tracktion Engine's 1.7 GB history unless `.gitmodules` asks for shallow fetches, and contributors who only work on the TypeScript packages carry them too. Configure-time fetching keeps the repo small and the build one command.
- **CPM.** A convenience layer over FetchContent with a shared source cache. It has the same shallow-fetch limit, adds a downloaded script to the repo, and its cache is something we can add later with `FETCHCONTENT_BASE_DIR` if we need it.
- **FetchContent with `GIT_TAG` and `GIT_SHALLOW`.** Works only for tags, and Tracktion Engine has none recent.
- **FetchContent from GitHub tarball URLs with `URL_HASH`.** The smallest download, but GitHub does not promise archive checksums stay the same, and a changed checksum breaks every build at once.
- **Tracktion Engine v3.2.0 on JUCE 8.** Tagged, so the simple FetchContent path works, but 18 months behind and on the older JUCE.

## Consequences

- One `cmake` command fetches everything; a clean configure costs about 250 MB of downloads and a minute.
- Updating a dependency is a one-line change of a hash, plus JUCE's hash from `git ls-tree <tracktion-commit> modules/juce`. Nothing bumps them automatically.
- Builds need network access on first configure. `FETCHCONTENT_FULLY_DISCONNECTED=ON` works offline after that.
- We own a short fetch script. If a later CMake can shallow-fetch a commit, the script goes.
- Building on Tracktion's `develop` means we take whatever is on it. Moving the pin is a deliberate change with CI on both systems, never automatic.
- Issue #19 (monorepo layout and build system) should carry this into the product's CMake and list both dependencies in `THIRD_PARTY.md`.

## How we will know

Issue #7: the spike configures and builds from a clean checkout on GitHub's Windows and macOS runners and on both maintainers' machines. If any of them cannot fetch by commit, or the fetch is slow enough to matter, revisit.
