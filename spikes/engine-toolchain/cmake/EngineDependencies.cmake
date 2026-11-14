# Pinned JUCE 9 and Tracktion Engine for the engine spikes.
#
#   include(<path>/EngineDependencies.cmake)
#
# Fetches both at configure time, each at one commit with no history (ADR-0009),
# patches Tracktion Engine for Apple clang 15 (README finding 11), and adds the
# Tracktion Engine modules, which also adds JUCE. Afterwards the targets
# tracktion::tracktion_engine, juce::juce_gui_extra and the rest exist.
#
# Shared by spikes/engine-toolchain (#7) and spikes/webview-ui (#8) so the pins live
# in one place. Spike code: the product's own build (#19) carries this forward.
#
# To build against a local checkout instead (to debug or patch a dependency),
# configure with -DFETCHCONTENT_SOURCE_DIR_JUCE=/path/to/JUCE or
# -DFETCHCONTENT_SOURCE_DIR_TRACKTION=/path/to/tracktion_engine.

include_guard(GLOBAL)

# ---------------------------------------------------------------------------
# Pins. JUCE is the exact commit Tracktion Engine's own `modules/juce` submodule
# points at, so we build the pair Tracktion tests together. When you move
# Tracktion Engine, move JUCE to its new submodule commit in the same change:
#   git ls-tree <tracktion-commit> modules/juce
# ---------------------------------------------------------------------------

set(COLLABGOD_TRACKTION_COMMIT a5e44996f5f08dfa6af5f5d02d900fb3cfa37422) # 3.5.0 on develop, 2026-10-24
set(COLLABGOD_JUCE_COMMIT      7ff644f65d7daa1428c34b9738ebb5c449dc9172) # JUCE 9.0.5 + develop, 2026-10-16

include(FetchContent)

set(_collabgod_engine_deps_dir "${CMAKE_CURRENT_LIST_DIR}")

# Declares a dependency fetched at one commit with no history. See
# ShallowFetchCommit.cmake for why GIT_TAG + GIT_SHALLOW is not used.
function(collabgod_declare_pinned name repo commit)
    FetchContent_Declare(${name}
        DOWNLOAD_COMMAND
            ${CMAKE_COMMAND}
                -DREPO=${repo}
                -DCOMMIT=${commit}
                -DDEST=<SOURCE_DIR>
                -P ${_collabgod_engine_deps_dir}/ShallowFetchCommit.cmake
        ${ARGN})
endfunction()

collabgod_declare_pinned(juce
    https://github.com/juce-framework/JUCE.git
    ${COLLABGOD_JUCE_COMMIT})

# Tracktion Engine's top-level CMakeLists builds its examples and adds JUCE from
# its own submodule. We want neither: submodules are never fetched, and
# SOURCE_SUBDIR points at a folder with no CMakeLists.txt, so FetchContent only
# downloads it. The modules folder is added below.
collabgod_declare_pinned(tracktion
    https://github.com/Tracktion/tracktion_engine.git
    ${COLLABGOD_TRACKTION_COMMIT}
    SOURCE_SUBDIR do-not-configure)

FetchContent_MakeAvailable(juce tracktion)

# Apple clang 15 (Xcode 15, macOS 13 and 14) lacks C++20 parenthesised aggregate
# initialisation, which Tracktion Engine uses in two places. Patch the downloaded
# source on Apple (engine-toolchain README finding 11). Remove once Tracktion fixes
# it or we require Xcode 16.
#
# A file is written only when its text changes, so reconfiguring does not touch its
# timestamp and trigger a rebuild. A local checkout given with
# FETCHCONTENT_SOURCE_DIR_TRACKTION is never patched: it is the developer's own tree.
function(collabgod_patch_source file old new)
    file(READ "${file}" text)
    string(FIND "${text}" "${new}" already)
    if(NOT already EQUAL -1)
        return()
    endif()
    string(FIND "${text}" "${old}" found)
    if(found EQUAL -1)
        message(WARNING "Patch for Apple clang 15 no longer matches ${file}; check whether it is still needed")
        return()
    endif()
    string(REPLACE "${old}" "${new}" text "${text}")
    file(WRITE "${file}" "${text}")
    message(STATUS "Patched ${file} for Apple clang 15")
endfunction()

if(APPLE AND NOT FETCHCONTENT_SOURCE_DIR_TRACKTION)
    set(_te "${tracktion_SOURCE_DIR}/modules/tracktion_engine")

    # ExportableUpdate (a, b): brace-init means the same and builds everywhere.
    collabgod_patch_source("${_te}/model/export/tracktion_Archive.cpp"
        "ExportableUpdate (f.oldRef, destItem->getProjectItemRef())"
        "ExportableUpdate { f.oldRef, destItem->getProjectItemRef() }")

    # emplace_back (a, b) on the aggregate ChannelMap::Entry: give it a constructor.
    collabgod_patch_source("${_te}/utilities/tracktion_ChannelMap.h"
        "        float gain = 1.0f;\n    };"
        "        float gain = 1.0f;\n\n        Entry() = default;\n        Entry (int s, int d, float g = 1.0f) : source (s), dest (d), gain (g) {}\n    };")
elseif(APPLE)
    message(STATUS "Using a local Tracktion Engine checkout; not applying the Apple clang 15 patches")
endif()

add_subdirectory(${tracktion_SOURCE_DIR}/modules ${CMAKE_BINARY_DIR}/tracktion_modules)
