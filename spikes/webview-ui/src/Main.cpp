// Spike for issue #8: a TypeScript page in JUCE's web view, driven by Tracktion
// Engine at the display's frame rate. Throwaway code: product code never includes this.
//
//   webview_spike [options]          Open the window. See usage() or README.md for options.
//   webview_spike selftest           Check the bridge and engine host without a window; ctest runs this.

#include <JuceHeader.h>

#include "Bridge.h"
#include "EngineHost.h"
#include "Log.h"
#include "SelfTest.h"
#include "WebUi.h"

namespace
{
juce::String usage()
{
    return "Usage:\n"
           "  webview_spike [options]\n"
           "    --simulated-audio          Use a simulated sound card instead of the default output device\n"
           "    --emit-hz <n>              Send frames at a fixed rate instead of on every display refresh\n"
           "    --benchmark [full|quick]   Run the benchmark as soon as the page loads (default full)\n"
           "    --exit-after-benchmark     Quit when the report is saved: exit code 0 if it reported no errors\n"
           "    --ui-dir <folder>          Serve the page from here (default: ui/dist in the source tree)\n"
           "    --report-dir <folder>      Write reports and the log here (default: Documents/CollabGod/webview-spike)\n"
           "  webview_spike selftest [--contract-dir <folder>]\n";
}

juce::String valueAfter (const juce::StringArray& args, const juce::String& flag)
{
    const auto i = args.indexOf (flag);
    return i >= 0 && i + 1 < args.size() && ! args[i + 1].startsWith ("--") ? args[i + 1] : juce::String();
}

juce::File folderArg (const juce::StringArray& args, const juce::String& flag, const juce::File& fallback)
{
    const auto value = valueAfter (args, flag);
    return value.isEmpty() ? fallback : juce::File::getCurrentWorkingDirectory().getChildFile (value);
}

class MainWindow : public juce::DocumentWindow
{
public:
    MainWindow (spike::EngineHost& engine, spike::Settings settings)
        : DocumentWindow ("CollabGod web view spike (#8)", juce::Colour (0xff0b0d12), DocumentWindow::allButtons)
    {
        setUsingNativeTitleBar (true);
        setContentOwned (new spike::WebUi (engine, std::move (settings)), false);
        setResizable (true, true);
        centreWithSize (1400, 860);
        setVisible (true);
    }

    void closeButtonPressed() override
    {
        juce::JUCEApplication::getInstance()->systemRequestedQuit();
    }
};

class Application : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override       { return "CollabGod web view spike"; }
    const juce::String getApplicationVersion() override    { return "0.0.1"; }
    bool moreThanOneInstanceAllowed() override             { return true; }

    void initialise (const juce::String& commandLine) override
    {
        const auto args = juce::StringArray::fromTokens (commandLine, true);
        const auto unquoted = [&]
        {
            juce::StringArray a;
            for (const auto& s : args)
                a.add (s.unquoted());
            return a;
        }();

        if (unquoted.contains ("--help") || unquoted.contains ("-h"))
        {
            std::cout << usage();
            quit();
            return;
        }

        if (unquoted[0] == "selftest")
        {
            const auto contractDir = folderArg (unquoted, "--contract-dir", juce::File (WEBVIEW_SPIKE_CONTRACT_DIR));
            setApplicationReturnValue (spike::runSelfTest (contractDir));
            quit();
            return;
        }

        spike::Settings settings;
        settings.uiDir = folderArg (unquoted, "--ui-dir", juce::File (WEBVIEW_SPIKE_UI_DIR));
        settings.reportDir = folderArg (unquoted, "--report-dir",
                                        juce::File::getSpecialLocation (juce::File::userDocumentsDirectory)
                                            .getChildFile ("CollabGod").getChildFile ("webview-spike"));
        settings.emitHz = juce::jlimit (0, 1000, valueAfter (unquoted, "--emit-hz").getIntValue());
        settings.exitAfterBenchmark = unquoted.contains ("--exit-after-benchmark");

        if (unquoted.contains ("--benchmark"))
            settings.autorun = valueAfter (unquoted, "--benchmark") == "quick" ? "quick" : "full";

        settings.audio = unquoted.contains ("--simulated-audio") ? spike::EngineHost::Audio::simulatedRealtime
                                                                  : spike::EngineHost::Audio::device;

        spike::setLogFile (settings.reportDir.getChildFile ("webview-spike.log"));
        spike::log ("CollabGod web view spike, " + juce::SystemStats::getJUCEVersion() + " on "
                    + juce::SystemStats::getOperatingSystemName() + ", " + spike::webViewName());
        spike::log ("Serving the page from " + settings.uiDir.getFullPathName());

        engine = std::make_unique<spike::EngineHost> (settings.audio);
        engine->setPlaying (true);
        window = std::make_unique<MainWindow> (*engine, std::move (settings));
    }

    void shutdown() override
    {
        window.reset();
        engine.reset();
    }

    void systemRequestedQuit() override
    {
        quit();
    }

private:
    std::unique_ptr<spike::EngineHost> engine;
    std::unique_ptr<MainWindow> window;
};
} // namespace

START_JUCE_APPLICATION (Application)
