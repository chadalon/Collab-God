// Spike for issue #7: prove that JUCE and Tracktion Engine build and make sound
// on Windows and macOS. Throwaway code: product code never includes this.
//
//   engine_spike play [audio-file]   Plays a sine tone, then the file, on the default output device.
//   engine_spike check [--out dir]   Renders the same edit offline and checks what came out.

#include <JuceHeader.h>
#include <iostream>

#include "SpikeEdit.h"
#include "ToneCheck.h"

namespace
{
namespace te = tracktion; // engine and core are inline namespaces of tracktion

constexpr double toneHz = 440.0;
constexpr double fileHz = 660.0;
constexpr double toneSeconds = 1.0;
constexpr double fileSeconds = 1.0;

/** For `check`: no audio device, so it runs on CI machines that have none. */
struct HeadlessBehaviour : te::EngineBehaviour
{
    bool autoInitialiseDeviceManager() override { return false; }
};

void print (const juce::String& s)
{
    std::cout << s << std::endl;
}

juce::File makeTestFile (const juce::File& folder)
{
    auto file = folder.getChildFile ("test-660hz.wav");
    folder.createDirectory();
    return spike::writeSineWav (file, fileHz, 0.25f, fileSeconds, 48000.0) ? file : juce::File();
}

int check (const juce::File& outFolder)
{
    te::Engine engine ("CollabGodEngineSpike", nullptr, std::make_unique<HeadlessBehaviour>());
    spike::registerSpikePlugins (engine);

    const auto testFile = makeTestFile (outFolder);

    if (testFile == juce::File())
    {
        print ("FAIL could not write the test audio file in " + outFolder.getFullPathName());
        return 1;
    }

    juce::String error;
    auto edit = spike::createSpikeEdit (engine, { toneHz, 0.25f, toneSeconds, testFile },
                                        te::Edit::forRendering, error);

    if (edit == nullptr)
    {
        print ("FAIL " + error);
        return 1;
    }

    for (auto track : te::getAudioTracks (*edit))
    {
        juce::String line = "Track " + track->getName() + ": " + juce::String (track->getClips().size()) + " clips; plugins:";
        for (auto p : track->pluginList)
            line << " " << p->getName() << (p->isEnabled() ? "" : " (disabled)");
        print (line);
    }

    const auto rendered = outFolder.getChildFile ("render.wav");
    rendered.deleteFile();

    const auto started = juce::Time::getMillisecondCounterHiRes();
    const bool ok = te::Renderer::renderToFile ({}, rendered, *edit,
                                                { te::TimePosition(), edit->getLength() },
                                                te::toBitSet (te::getAllTracks (*edit)),
                                                true, false, {}, false);
    const auto elapsed = juce::Time::getMillisecondCounterHiRes() - started;

    if (! ok || ! rendered.existsAsFile())
    {
        print ("FAIL render did not produce " + rendered.getFullPathName());
        return 1;
    }

    print ("Rendered " + juce::String (edit->getLength().inSeconds(), 3) + " s of audio in "
           + juce::String (elapsed, 0) + " ms");

    // Leave 0.1 s at each edge so the ramp and the clip boundary do not count.
    const std::vector<spike::Window> windows {
        { "tone only", 0.1, toneSeconds - 0.1, toneHz, fileHz },
        { "file only", toneSeconds + 0.1, toneSeconds + fileSeconds - 0.1, fileHz, toneHz },
    };

    juce::String report;
    const bool passed = spike::checkRender (rendered, windows, toneSeconds + fileSeconds, report);
    std::cout << report;
    print (passed ? "PASS" : "FAIL");
    return passed ? 0 : 1;
}

int play (juce::File audioFile)
{
    te::Engine engine ("CollabGodEngineSpike");
    spike::registerSpikePlugins (engine);

    auto& devices = engine.getDeviceManager().deviceManager;

    if (auto* device = devices.getCurrentAudioDevice())
        print ("Output: " + device->getTypeName() + " / " + device->getName() + ", "
               + juce::String (device->getCurrentSampleRate()) + " Hz, "
               + juce::String (device->getCurrentBufferSizeSamples()) + " samples per buffer");
    else
    {
        print ("No audio output device is open. Check that one is connected and enabled.");
        return 1;
    }

    if (audioFile == juce::File())
    {
        audioFile = makeTestFile (engine.getTemporaryFileManager().getTempDirectory());
        print ("No file given; playing a generated 660 Hz test tone as the file");
    }

    juce::String error;
    auto edit = spike::createSpikeEdit (engine, { toneHz, 0.25f, toneSeconds, audioFile },
                                        te::Edit::forEditing, error);

    if (edit == nullptr)
    {
        print (error);
        return 1;
    }

    const auto length = edit->getLength().inSeconds();
    print ("Playing a 440 Hz sine tone for " + juce::String (toneSeconds, 1) + " s, then "
           + audioFile.getFileName() + " (" + juce::String (length - toneSeconds, 1) + " s)");

    auto& transport = edit->getTransport();
    transport.setPosition (te::TimePosition());
    transport.play (false);

    // Run the message loop until playback passes the end of the edit.
    while (transport.getPosition().inSeconds() < length + 0.2)
        juce::MessageManager::getInstance()->runDispatchLoopUntil (50);

    transport.stop (false, false);
    print ("Done");
    return 0;
}

void usage()
{
    print ("Usage:\n"
           "  engine_spike play [audio-file]   Play a sine tone, then the file, on the default output\n"
           "  engine_spike check [--out dir]   Render the same edit offline and check the result");
}

} // namespace

int main (int argc, char* argv[])
{
    const juce::ScopedJuceInitialiser_GUI juce;

    juce::StringArray args;
    for (int i = 1; i < argc; ++i)
        args.add (juce::String::fromUTF8 (argv[i]));

    const auto command = args[0];

    if (command == "check")
    {
        auto out = juce::File::getCurrentWorkingDirectory().getChildFile ("render-check");
        const auto outIndex = args.indexOf ("--out");

        if (outIndex > 0 && outIndex + 1 < args.size())
            out = juce::File::getCurrentWorkingDirectory().getChildFile (args[outIndex + 1]);

        return check (out);
    }

    if (command == "play")
        return play (args.size() > 1 ? juce::File::getCurrentWorkingDirectory().getChildFile (args[1]) : juce::File());

    usage();
    return command.isEmpty() || command == "--help" ? 0 : 2;
}
