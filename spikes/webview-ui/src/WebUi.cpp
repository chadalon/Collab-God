// Spike for issue #8. Throwaway code: product code never includes this.

#include "WebUi.h"
#include "Bridge.h"
#include "Log.h"

namespace spike
{
namespace
{
void quitWith (int code)
{
    if (auto* app = juce::JUCEApplicationBase::getInstance())
    {
        app->setApplicationReturnValue (code);
        app->systemRequestedQuit();
    }
}
} // namespace

WebUi::WebUi (EngineHost& e, Settings s) : engine (e), settings (std::move (s))
{
    browser = std::make_unique<juce::WebBrowserComponent> (makeOptions());
    addAndMakeVisible (*browser);
    browser->goToURL (juce::WebBrowserComponent::getResourceProviderRoot());

    // Display refresh drives everything: engine housekeeping and, by default, frames.
    vblank = std::make_unique<juce::VBlankAttachment> (this, [this] { displayFrame(); });

    if (settings.emitHz > 0)
        startTimerHz (settings.emitHz);

    if (settings.autorun != "none")
    {
        // A benchmark that never reports must not hang a test run.
        juce::Timer::callAfterDelay (180000, []
        {
            log ("FAIL no benchmark report after 180 s");
            quitWith (1);
        });
    }
}

WebUi::~WebUi()
{
    stopTimer();
    vblank.reset();
}

void WebUi::resized()
{
    browser->setBounds (getLocalBounds());
}

juce::WebBrowserComponent::Options WebUi::makeOptions()
{
    using Options = juce::WebBrowserComponent::Options;

    const auto uiDir = settings.uiDir;

    return Options {}
        // The default on Windows is still Internet Explorer.
        .withBackend (Options::Backend::webview2)
        .withWinWebView2Options (Options::WinWebView2 {}
                                     .withUserDataFolder (juce::File::getSpecialLocation (juce::File::tempDirectory)
                                                              .getChildFile ("CollabGodWebViewSpike"))
                                     .withBackgroundColour (juce::Colour (0xff0b0d12))
                                     .withStatusBarDisabled())
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withNativeIntegrationEnabled()
        .withResourceProvider ([uiDir] (const juce::String& path) -> std::optional<juce::WebBrowserComponent::Resource>
        {
            if (auto resource = serveUiFile (uiDir, path))
                return resource;

            if (path == "/" || path.startsWith ("/index.html"))
                return missingUiPage (uiDir);

            log ("The page asked for " + path + ", which is not in " + uiDir.getFullPathName());
            return std::nullopt;
        })
        .withNativeFunction ("hello", [this] (const Args& a, Completion done) { hello (a, std::move (done)); })
        .withNativeFunction ("ping", [] (const Args& a, Completion done) { done (a.isEmpty() ? juce::var() : a[0]); })
        .withNativeFunction ("seek", [this] (const Args& a, Completion done)
        {
            engine.seek (a.isEmpty() ? 0.0 : static_cast<double> (a[0]));
            done (makeObject ({ { "ok", true } }));
        })
        .withNativeFunction ("setPlaying", [this] (const Args& a, Completion done)
        {
            engine.setPlaying (! a.isEmpty() && static_cast<bool> (a[0]));
            done (makeObject ({ { "playing", engine.wantsToPlay() } }));
        })
        .withNativeFunction ("configure", [this] (const Args& a, Completion done)
        {
            if (! a.isEmpty() && a[0].isObject())
            {
                const auto& o = a[0];
                if (o.hasProperty ("push"))
                    push = static_cast<bool> (o["push"]);
                if (o.hasProperty ("extraMeters"))
                    extraMeters = juce::jlimit (0, 4096, static_cast<int> (o["extraMeters"]));
            }
            done (makeObject ({ { "push", push }, { "extraMeters", extraMeters } }));
        })
        .withNativeFunction ("pullFrame", [this] (const Args&, Completion done) { done (nextFrame()); })
        .withNativeFunction ("saveReport", [this] (const Args& a, Completion done) { saveReport (a, std::move (done)); })
        .withNativeFunction ("log", [] (const Args& a, Completion done)
        {
            log ("page: " + (a.isEmpty() ? juce::String() : a[0].toString()));
            done (juce::var());
        });
}

juce::var WebUi::hostInfo()
{
    return buildHostInfo (engine.getAudioInfo(), engine.getSettleInfo(),
                          { webViewName(), settings.emitHz > 0 ? "timer:" + juce::String (settings.emitHz) : "vblank",
                            settings.autorun });
}

void WebUi::hello (const Args&, Completion done)
{
    pageReady = true;

    // Answer once the engine has settled, so the page sees how long that took.
    if (engine.isSettled())
        done (hostInfo());
    else
        waitingForSettle.push_back (std::move (done));
}

juce::var WebUi::nextFrame()
{
    return buildFrame (engine.snapshot(), seq++, hostTimeMs(), extraMeters);
}

void WebUi::displayFrame()
{
    engine.tick();

    if (engine.isSettled() && ! waitingForSettle.empty())
    {
        log ("Page connected: " + webViewName());
        for (auto& done : waitingForSettle)
            done (hostInfo());
        waitingForSettle.clear();
    }

    if (settings.emitHz == 0 && pageReady && push)
        browser->emitEventIfBrowserIsVisible ("frame", nextFrame());
}

void WebUi::timerCallback()
{
    if (pageReady && push)
        browser->emitEventIfBrowserIsVisible ("frame", nextFrame());
}

void WebUi::saveReport (const Args& a, Completion done)
{
    const auto text = a.isEmpty() ? juce::String() : a[0].toString();
    const auto stamp = juce::Time::getCurrentTime().formatted ("%Y%m%d-%H%M%S");
    const auto os = juce::SystemStats::getOperatingSystemType() & juce::SystemStats::Windows ? "windows"
                  : juce::SystemStats::getOperatingSystemType() & juce::SystemStats::MacOSX ? "macos" : "linux";
    const auto file = settings.reportDir.getChildFile ("report-" + juce::String (os) + "-" + stamp + ".json");

    settings.reportDir.createDirectory();
    const bool written = file.replaceWithText (text);

    const auto report = juce::JSON::parse (text);
    const auto errors = report["errors"];
    const bool clean = written && report.isObject() && errors.isArray() && errors.getArray()->isEmpty();

    log ((written ? "Report saved to " : "FAIL could not write ") + file.getFullPathName());
    log ("Verdict: " + report["verdict"]["summary"].toString());
    if (errors.isArray())
        for (const auto& e : *errors.getArray())
            log ("Report error: " + e.toString());

    done (makeObject ({ { "path", written ? file.getFullPathName() : juce::String() } }));

    if (settings.exitAfterBenchmark)
    {
        log (clean ? "PASS benchmark ran and reported no errors" : "FAIL benchmark reported errors");
        juce::Timer::callAfterDelay (300, [clean] { quitWith (clean ? 0 : 1); });
    }
}
} // namespace spike
