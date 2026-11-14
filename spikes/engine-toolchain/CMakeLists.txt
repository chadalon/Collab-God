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
# Dependencies: JUCE and Tracktion Engine, each pinned to a full commit hash,
# plus the Apple clang 15 patch. The pins and the fetch live in
# cmake/EngineDependencies.cmake, shared with spikes/webview-ui; see README.md.
# ---------------------------------------------------------------------------

include(cmake/EngineDependencies.cmake)

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
