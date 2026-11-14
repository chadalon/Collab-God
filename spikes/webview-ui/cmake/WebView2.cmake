# Microsoft's WebView2 SDK, which JUCE needs on Windows to use the Edge (Chromium)
# web view instead of Internet Explorer.
#
# JUCE's FindWebView2.cmake looks for the NuGet package in the user's NuGet folder and
# asks for it to be installed by hand with PowerShell. Instead this downloads the
# package at configure time, checks it against the SHA-512 that nuget.org publishes
# for it, and points JUCE at it. NuGet packages are immutable once published, so the
# hash cannot change under us. The loader is linked statically, so there is no DLL to
# ship; the WebView2 runtime itself comes with Windows 10 and 11.
#
# To use a package you already have, configure with
#   -DJUCE_WEBVIEW2_PACKAGE_LOCATION=<folder containing Microsoft.Web.WebView2.*>

include_guard(GLOBAL)

set(COLLABGOD_WEBVIEW2_VERSION 1.0.3485.44) # the version JUCE 9's FindWebView2.cmake suggests
set(COLLABGOD_WEBVIEW2_SHA512
    d01a59afdbda1da11d640db98934ffed12c0f813551b75f97e052673d12e3238f88f29f4c24ac56a9313f5cd3f022a1e8d40e103a3798aa4d42d1322ddb342de)

if(NOT JUCE_WEBVIEW2_PACKAGE_LOCATION)
    set(_wv2_root "${CMAKE_BINARY_DIR}/_deps/webview2")
    set(_wv2_dir "${_wv2_root}/Microsoft.Web.WebView2.${COLLABGOD_WEBVIEW2_VERSION}")
    set(_wv2_nupkg "${_wv2_root}/microsoft.web.webview2.${COLLABGOD_WEBVIEW2_VERSION}.nupkg")

    if(NOT EXISTS "${_wv2_dir}/build/native/include/WebView2.h")
        message(STATUS "Downloading the WebView2 SDK ${COLLABGOD_WEBVIEW2_VERSION} from nuget.org")
        file(DOWNLOAD
            "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${COLLABGOD_WEBVIEW2_VERSION}/microsoft.web.webview2.${COLLABGOD_WEBVIEW2_VERSION}.nupkg"
            "${_wv2_nupkg}"
            EXPECTED_HASH SHA512=${COLLABGOD_WEBVIEW2_SHA512}
            STATUS _wv2_status)
        list(GET _wv2_status 0 _wv2_code)
        if(NOT _wv2_code EQUAL 0)
            message(FATAL_ERROR "Could not download the WebView2 SDK: ${_wv2_status}")
        endif()
        file(ARCHIVE_EXTRACT INPUT "${_wv2_nupkg}" DESTINATION "${_wv2_dir}")
    endif()

    set(JUCE_WEBVIEW2_PACKAGE_LOCATION "${_wv2_root}" CACHE PATH "Folder containing the Microsoft.Web.WebView2 NuGet package" FORCE)
endif()
