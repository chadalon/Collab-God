// Spike for issue #8. Throwaway code: product code never includes this.
//
// What crosses the web view bridge, built on the C++ side. The contract is
// ../contract/README.md; the page decodes the same example files.

#pragma once

#include <JuceHeader.h>
#include "EngineHost.h"

namespace spike
{
constexpr int contractVersion = 1;

/** A JSON object as a var, fields in the order given. */
juce::var makeObject (std::initializer_list<std::pair<const char*, juce::var>> fields);

/** The `frame` event payload. `extraMeters` copies of the master levels are appended as stress payload. */
juce::var buildFrame (const Snapshot&, juce::int64 seq, double hostMs, int extraMeters);

struct HostDescription
{
    juce::String webView;
    juce::String emit;
    juce::String autorun;
};

/** The answer to the page's `hello` call. */
juce::var buildHostInfo (const AudioInfo&, const SettleInfo&, const HostDescription&);

/** The name of the web view this platform uses. */
juce::String webViewName();

/** Checks that `actual` has exactly the fields of `example`, with the same JSON types,
    recursively for objects. Fills `error` and returns false at the first difference. */
bool matchesContract (const juce::var& actual, const juce::var& example, juce::String& error, const juce::String& path = "");

/** Serves the built page from a folder: "/" is index.html, anything outside the
    folder or missing gives nothing. */
std::optional<juce::WebBrowserComponent::Resource> serveUiFile (const juce::File& folder, const juce::String& path);

/** The MIME type for a file served to the web view. */
juce::String mimeTypeFor (const juce::File&);

/** A page explaining that the UI has not been built, served in its place. */
juce::WebBrowserComponent::Resource missingUiPage (const juce::File& folder);
} // namespace spike
