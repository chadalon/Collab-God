// Spike for issue #8. Throwaway code: product code never includes this.

#include "Bridge.h"

namespace spike
{
juce::var makeObject (std::initializer_list<std::pair<const char*, juce::var>> fields)
{
    auto* o = new juce::DynamicObject();
    for (const auto& [key, value] : fields)
        o->setProperty (key, value);
    return juce::var (o);
}

namespace
{
/** Rounds to `digits` decimal places so the JSON stays short. */
double round (double x, int digits)
{
    const double f = std::pow (10.0, digits);
    return std::round (x * f) / f;
}

const char* jsonType (const juce::var& v)
{
    if (v.isBool()) return "boolean";
    if (v.isInt() || v.isInt64() || v.isDouble()) return "number";
    if (v.isString()) return "string";
    if (v.isArray()) return "array";
    if (v.isObject()) return "object";
    return "null";
}

std::vector<std::byte> toBytes (const juce::MemoryBlock& block)
{
    const auto* data = static_cast<const std::byte*> (block.getData());
    return { data, data + block.getSize() };
}
} // namespace

juce::var buildFrame (const Snapshot& s, juce::int64 seq, double hostMs, int extraMeters)
{
    juce::Array<juce::var> levels { round (s.levelDb[0], 2), round (s.levelDb[1], 2) };
    juce::Array<juce::var> extra;
    extra.ensureStorageAllocated (extraMeters);

    for (int i = 0; i < extraMeters; ++i)
        extra.add (round (s.levelDb[i % 2] - static_cast<float> (i % 12), 1));

    return makeObject ({
        { "v", contractVersion },
        { "seq", seq },
        { "hostTimeMs", round (hostMs, 2) },
        { "playing", s.playing },
        { "positionSec", round (s.positionSec, 4) },
        { "audibleSec", round (s.audibleSec, 4) },
        { "loopStartSec", round (s.loopStartSec, 4) },
        { "loopEndSec", round (s.loopEndSec, 4) },
        { "levelsDb", levels },
        { "extraLevelsDb", extra },
        { "unexpectedStops", s.unexpectedStops },
        { "contextRebuilds", s.contextRebuilds },
        { "xruns", s.xruns },
    });
}

juce::String webViewName()
{
   #if JUCE_WINDOWS
    return "WebView2";
   #elif JUCE_MAC
    return "WKWebView";
   #elif JUCE_LINUX
    return "WebKitGTK";
   #else
    return "unknown";
   #endif
}

juce::var buildHostInfo (const AudioInfo& audio, const SettleInfo& settle, const HostDescription& d)
{
    return makeObject ({
        { "v", contractVersion },
        { "platform", juce::SystemStats::getOperatingSystemName() },
        { "webView", d.webView },
        { "juceVersion", juce::SystemStats::getJUCEVersion() },
        { "audio", makeObject ({
              { "simulated", audio.simulated },
              { "type", audio.type },
              { "name", audio.name },
              { "sampleRate", audio.sampleRate },
              { "blockSize", audio.blockSize },
          }) },
        { "settle", makeObject ({
              { "ms", round (settle.ms, 1) },
              { "contextChanges", settle.contextChanges },
              { "deviceChanges", settle.deviceChanges },
              { "timedOut", settle.timedOut },
          }) },
        { "emit", d.emit },
        { "autorun", d.autorun },
    });
}

bool matchesContract (const juce::var& actual, const juce::var& example, juce::String& error, const juce::String& path)
{
    const juce::String where = path.isEmpty() ? "(top level)" : path;

    if (juce::String (jsonType (actual)) != jsonType (example))
    {
        error = where + " is " + jsonType (actual) + ", the contract says " + jsonType (example);
        return false;
    }

    if (! example.isObject() || example.isArray())
        return true;

    const auto& want = example.getDynamicObject()->getProperties();
    const auto& have = actual.getDynamicObject()->getProperties();

    for (const auto& field : want)
    {
        const auto childPath = path.isEmpty() ? field.name.toString() : path + "." + field.name.toString();

        if (! have.contains (field.name))
        {
            error = childPath + " is missing";
            return false;
        }

        if (! matchesContract (have[field.name], field.value, error, childPath))
            return false;
    }

    for (const auto& field : have)
    {
        if (! want.contains (field.name))
        {
            error = (path.isEmpty() ? "" : path + ".") + field.name.toString() + " is not in the contract";
            return false;
        }
    }

    return true;
}

juce::String mimeTypeFor (const juce::File& file)
{
    const auto ext = file.getFileExtension().toLowerCase();
    if (ext == ".html") return "text/html";
    if (ext == ".js" || ext == ".mjs") return "text/javascript";
    if (ext == ".css") return "text/css";
    if (ext == ".json" || ext == ".map") return "application/json";
    if (ext == ".svg") return "image/svg+xml";
    if (ext == ".png") return "image/png";
    if (ext == ".wasm") return "application/wasm";
    return "application/octet-stream";
}

std::optional<juce::WebBrowserComponent::Resource> serveUiFile (const juce::File& folder, const juce::String& path)
{
    auto relative = path.upToFirstOccurrenceOf ("?", false, false)
                        .upToFirstOccurrenceOf ("#", false, false)
                        .trimCharactersAtStart ("/");

    if (relative.isEmpty())
        relative = "index.html";

    // Never serve anything outside the folder.
    if (relative.contains ("..") || relative.contains ("\\") || relative.contains (":"))
        return std::nullopt;

    const auto file = folder.getChildFile (relative);

    if (! file.isAChildOf (folder) || ! file.existsAsFile())
        return std::nullopt;

    juce::MemoryBlock data;
    if (! file.loadFileAsData (data))
        return std::nullopt;

    return juce::WebBrowserComponent::Resource { toBytes (data), mimeTypeFor (file) };
}

juce::WebBrowserComponent::Resource missingUiPage (const juce::File& folder)
{
    const auto html = juce::String (
        "<!doctype html><meta charset=utf-8><body style=\"font:14px system-ui;background:#0b0d12;color:#d8dde8;padding:2em\">"
        "<h1>The page has not been built</h1>"
        "<p>No <code>index.html</code> in <code>")
        + folder.getFullPathName().replace ("&", "&amp;").replace ("<", "&lt;").replace (">", "&gt;")
        + "</code>.</p><p>In <code>spikes/webview-ui/ui</code> run <code>npm ci</code> and then <code>npm run build</code>, "
          "then start the app again. Or pass <code>--ui-dir</code>.</p>";

    juce::MemoryBlock block (html.toRawUTF8(), html.getNumBytesAsUTF8());
    return { toBytes (block), "text/html" };
}
} // namespace spike
