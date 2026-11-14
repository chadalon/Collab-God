# Spike for issue #8: a TypeScript page in JUCE's web view, driven by Tracktion
# Engine at the display's frame rate. Throwaway code. See README.md.

cmake_minimum_required(VERSION 3.22)

project(CollabGodWebViewSpike VERSION 0.0.1 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(APPLE AND NOT CMAKE_OSX_DEPLOYMENT_TARGET)
    set(CMAKE_OSX_DEPLOYMENT_TARGET "12.0" CACHE STRING "Oldest macOS the spike runs on")
endif()

if(MSVC)
    # Static runtime, as Tracktion Engine's own examples use.
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

# The same pinned JUCE 9 and Tracktion Engine as spikes/engine-toolchain, with its
# Apple clang 15 patch (ADR-0009, engine-toolchain README finding 11).
include(../engine-toolchain/cmake/EngineDependencies.cmake)

if(WIN32)
    include(cmake/WebView2.cmake)
endif()

# The page is built separately with npm (see README.md) and served from this folder
# at run time, so a change to the page needs no C++ rebuild: press R in the window.
set(WEBVIEW_SPIKE_UI_DIR "${CMAKE_CURRENT_SOURCE_DIR}/ui/dist" CACHE PATH "Folder the app serves the page from")

if(NOT EXISTS "${WEBVIEW_SPIKE_UI_DIR}/index.html")
    message(WARNING "The page is not built yet. In spikes/webview-ui/ui run `npm ci` and `npm run build`; "
                    "the app shows instructions until you do.")
endif()

juce_add_gui_app(webview_spike
    PRODUCT_NAME "CollabGod WebView Spike"
    COMPANY_NAME "CollabGod"
    BUNDLE_ID "dev.collabgod.webviewspike"
    NEEDS_CURL FALSE
    NEEDS_WEB_BROWSER TRUE
    NEEDS_WEBVIEW2 TRUE
    MICROPHONE_PERMISSION_ENABLED TRUE
    MICROPHONE_PERMISSION_TEXT "The spike opens the default audio device, which may include inputs. It records nothing.")

juce_generate_juce_header(webview_spike)

target_sources(webview_spike PRIVATE
    src/Bridge.cpp
    src/Bridge.h
    src/EngineHost.cpp
    src/EngineHost.h
    src/Log.cpp
    src/Log.h
    src/Main.cpp
    src/SelfTest.cpp
    src/SelfTest.h
    src/WebUi.cpp
    src/WebUi.h)

target_compile_definitions(webview_spike PRIVATE
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=1
    JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
    JUCE_STRICT_REFCOUNTEDPOINTER=1
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_PLUGINHOST_VST3=0
    JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:webview_spike,JUCE_PRODUCT_NAME>"
    JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:webview_spike,JUCE_VERSION>"
    TRACKTION_ENABLE_TIMESTRETCH_SOUNDTOUCH=1
    TRACKTION_LOG_DEVICES=0
    WEBVIEW_SPIKE_UI_DIR="${WEBVIEW_SPIKE_UI_DIR}"
    WEBVIEW_SPIKE_CONTRACT_DIR="${CMAKE_CURRENT_SOURCE_DIR}/contract")

target_link_libraries(webview_spike
    PRIVATE
        tracktion::tracktion_core
        tracktion::tracktion_engine
        tracktion::tracktion_graph
        juce::juce_audio_devices
        juce::juce_audio_processors
        juce::juce_audio_utils
        juce::juce_gui_extra
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_warning_flags)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    target_link_libraries(webview_spike PRIVATE atomic)
endif()

if(APPLE)
    # Tracktion Engine's examples need this with Apple clang.
    target_compile_options(webview_spike PRIVATE -fno-aligned-allocation)
endif()

# ---------------------------------------------------------------------------
# Tests. Neither needs an audio device.
# ---------------------------------------------------------------------------

enable_testing()

# The C++ side of the bridge and the engine host, without a window.
add_test(NAME bridge_and_engine_selftest COMMAND webview_spike selftest)
set_tests_properties(bridge_and_engine_selftest PROPERTIES TIMEOUT 120)

# The whole thing: open the window, load the page, run a short benchmark with a
# simulated sound card, save the report and quit. Needs a display and a web view, so
# it is off by default; on Linux run it under xvfb-run. Its numbers mean nothing on a
# machine without a GPU, only that every piece talks to every other.
option(WEBVIEW_SPIKE_END_TO_END_TEST "Add the end-to-end test, which opens a window" OFF)
if(WEBVIEW_SPIKE_END_TO_END_TEST)
    add_test(NAME end_to_end_quick_benchmark
        COMMAND webview_spike --simulated-audio --benchmark quick --exit-after-benchmark
                              --report-dir ${CMAKE_BINARY_DIR}/end-to-end)
    set_tests_properties(end_to_end_quick_benchmark PROPERTIES TIMEOUT 240)
endif()
