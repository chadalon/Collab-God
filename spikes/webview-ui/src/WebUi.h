// Spike for issue #8. Throwaway code: product code never includes this.

#pragma once

#include <JuceHeader.h>
#include "EngineHost.h"

namespace spike
{
struct Settings
{
    EngineHost::Audio audio = EngineHost::Audio::device;
    /** 0: send a frame on every display refresh (VBlankAttachment). Otherwise a fixed rate in Hz. */
    int emitHz = 0;
    juce::File uiDir;
    juce::File reportDir;
    /** "none", "full" or "quick". */
    juce::String autorun = "none";
    bool exitAfterBenchmark = false;
};

/**
    The window's only child: JUCE's web view showing the page, with the native
    functions the page calls and the frames it receives. See ../contract/README.md.

    Everything here runs on the message thread.
*/
class WebUi : public juce::Component,
              private juce::Timer
{
public:
    WebUi (EngineHost&, Settings);
    ~WebUi() override;

    void resized() override;

private:
    using Completion = juce::WebBrowserComponent::NativeFunctionCompletion;
    using Args = juce::Array<juce::var>;

    juce::WebBrowserComponent::Options makeOptions();
    void displayFrame();
    void timerCallback() override;
    juce::var nextFrame();
    juce::var hostInfo();

    void hello (const Args&, Completion);
    void saveReport (const Args&, Completion);

    EngineHost& engine;
    const Settings settings;
    bool pageReady = false;
    bool push = true;
    int extraMeters = 0;
    juce::int64 seq = 0;
    std::vector<Completion> waitingForSettle;

    std::unique_ptr<juce::WebBrowserComponent> browser;
    std::unique_ptr<juce::VBlankAttachment> vblank;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (WebUi)
};
} // namespace spike
