# Spike for issue #7: build JUCE and Tracktion Engine on Windows and macOS.
# Throwaway code. See README.md for the findings and how to build it.

cmake_minimum_required(VERSION 3.22)

project(CollabGodEngineSpike VERSION 0.0.1 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(APPLE AND NOT CMAKE_OSX_DEPLOYMENT_TARGET)
    set(CMAKE_OSX_DEPLOYMENT_TARGET "12.0" CACHE STRING "Oldest macOS the spike runs on")
endif()

if(MSVC)
    # Static runtime, as Tracktion Engine's own examples use.
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

# ---------------------------------------------------------------------------
# Dependencies. Both are pinned to a full commit hash; see README.md.
#
# JUCE is pinned to the exact commit Tracktion Engine's own `modules/juce`
# submodule points at, so we build the pair Tracktion tests together. When you
# move Tracktion Engine, move JUCE to its new submodule commit in the same change:
#   git ls-tree <tracktion-commit> modules/juce
#
# To build against a local checkout instead (to debug or patch a dependency),
# configure with -DFETCHCONTENT_SOURCE_DIR_JUCE=/path/to/JUCE or
# -DFETCHCONTENT_SOURCE_DIR_TRACKTION=/path/to/tracktion_engine.
# ---------------------------------------------------------------------------

set(COLLABGOD_TRACKTION_COMMIT a5e44996f5f08dfa6af5f5d02d900fb3cfa37422) # 3.5.0 on develop, 2026-10-24
set(COLLABGOD_JUCE_COMMIT      7ff644f65d7daa1428c34b9738ebb5c449dc9172) # JUCE 9.0.5 + develop, 2026-10-16

include(FetchContent)

# Declares a dependency fetched at one commit with no history. See
# cmake/ShallowFetchCommit.cmake for why GIT_TAG + GIT_SHALLOW is not used.
function(collabgod_declare_pinned name repo commit)
    FetchContent_Declare(${name}
        DOWNLOAD_COMMAND
            ${CMAKE_COMMAND}
                -DREPO=${repo}
                -DCOMMIT=${commit}
                -DDEST=<SOURCE_DIR>
                -P ${CMAKE_CURRENT_LIST_DIR}/cmake/ShallowFetchCommit.cmake
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

# Apple clang 15 (Xcode 15, macOS 13/14) lacks C++20 parenthesised aggregate
# initialisation, which tracktion_Archive.cpp relies on. Brace-init is the same
# thing and builds everywhere. Remove once Tracktion fixes it or we require Xcode 16.
if(APPLE)
    set(_archive_cpp "${tracktion_SOURCE_DIR}/modules/tracktion_engine/model/export/tracktion_Archive.cpp")
    file(READ "${_archive_cpp}" _archive_src)
    string(REPLACE
        "ExportableUpdate (f.oldRef, destItem->getProjectItemRef())"
        "ExportableUpdate { f.oldRef, destItem->getProjectItemRef() }"
        _archive_src "${_archive_src}")
    file(WRITE "${_archive_cpp}" "${_archive_src}")

    # Same cause: emplace_back (a, b) on the aggregate ChannelMap::Entry. A
    # constructor makes it work without parenthesised aggregate init.
    set(_cmap_h "${tracktion_SOURCE_DIR}/modules/tracktion_engine/utilities/tracktion_ChannelMap.h")
    file(READ "${_cmap_h}" _cmap_src)
    if(NOT _cmap_src MATCHES "Entry \\(int s, int d")
        string(REPLACE
            "        float gain = 1.0f;\n    };"
            "        float gain = 1.0f;\n\n        Entry() = default;\n        Entry (int s, int d, float g = 1.0f) : source (s), dest (d), gain (g) {}\n    };"
            _cmap_src "${_cmap_src}")
        file(WRITE "${_cmap_h}" "${_cmap_src}")
    endif()
endif()

add_subdirectory(${tracktion_SOURCE_DIR}/modules ${CMAKE_BINARY_DIR}/tracktion_modules)

# ---------------------------------------------------------------------------
# The spike itself: a console app.
# ---------------------------------------------------------------------------

juce_add_console_app(engine_spike
    PRODUCT_NAME "CollabGod Engine Spike"
    NEEDS_CURL FALSE
    NEEDS_WEB_BROWSER FALSE)

juce_generate_juce_header(engine_spike)

target_sources(engine_spike PRIVATE
    src/Main.cpp
    src/SpikeEdit.cpp
    src/SpikeEdit.h
    src/ToneCheck.cpp
    src/ToneCheck.h)

target_compile_definitions(engine_spike PRIVATE
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_STRICT_REFCOUNTEDPOINTER=1
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_PLUGINHOST_VST3=1
    TRACKTION_ENABLE_TIMESTRETCH_SOUNDTOUCH=1
    TRACKTION_LOG_DEVICES=0)

target_link_libraries(engine_spike
    PRIVATE
        tracktion::tracktion_core
        tracktion::tracktion_engine
        tracktion::tracktion_graph
        juce::juce_audio_devices
        juce::juce_audio_processors
        juce::juce_audio_utils
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    target_link_libraries(engine_spike PRIVATE atomic)
endif()

if(APPLE)
    # Tracktion Engine's examples need this with Apple clang.
    target_compile_options(engine_spike PRIVATE -fno-aligned-allocation)
endif()

# ---------------------------------------------------------------------------
# Test: render the spike edit offline and check what came out.
# Needs no audio device, so it runs on CI runners.
# ---------------------------------------------------------------------------

enable_testing()
add_test(NAME render_and_check
    COMMAND engine_spike check --out ${CMAKE_BINARY_DIR}/render-check)

# Test: play the same edit through a simulated sound card, driving the transport
# as `play` does, and check what came out. Catches a transport that never starts
# or never reaches the end, which an offline render cannot.
add_test(NAME live_play_and_check
    COMMAND engine_spike live-check --out ${CMAKE_BINARY_DIR}/live-check)
set_tests_properties(live_play_and_check PROPERTIES TIMEOUT 60)

# Characterisation test for #101: adding a MIDI device while playing stops the
# transport in this Tracktion Engine version. WILL_FAIL marks that as expected, so
# this test starts failing, and tells us, if an update changes the behaviour.
add_test(NAME midi_device_change_stops_transport
    COMMAND engine_spike live-check --change-midi-devices --out ${CMAKE_BINARY_DIR}/midi-change-check)
set_tests_properties(midi_device_change_stops_transport PROPERTIES TIMEOUT 60 WILL_FAIL TRUE)
