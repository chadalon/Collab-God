// Spike for issue #7: prove that JUCE and Tracktion Engine build and make sound
// on Windows and macOS. Throwaway code: product code never includes this.
//
//   engine_spike play [audio-file]   Plays a sine tone, then the file, on the default output device.
//   engine_spike check [--out dir]   Renders the same edit offline and checks what came out.

#include <JuceHeader.h>
#include <functional>
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

/** Starts the transport at zero and calls `tick` until playback passes the end
    of the edit, a timeout, or `tick` returns false. Returns true only if it
    reached the end. */
bool playToEnd (te::Edit& edit, const std::function<bool()>& tick)
{
    auto& transport = edit.getTransport();
    edit.dispatchPendingUpdatesSynchronously();
    transport.ensureContextAllocated();
    transport.setPosition (te::TimePosition());
    transport.play (false);

    const auto end = edit.getLength().inSeconds() + 0.2;
    const auto deadline = juce::Time::getMillisecondCounterHiRes() + (end + 5.0) * 1000.0;

    while (transport.getPosition().inSeconds() < end)
    {
        if (juce::Time::getMillisecondCounterHiRes() > deadline)
        {
            transport.stop (false, false);
            return false;
        }

        if (! tick())
        {
            transport.stop (false, false);
            return false;
        }
    }

    transport.stop (false, false);
    return true;
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
    auto* device = devices.getCurrentAudioDevice();
    const auto started = juce::Time::getMillisecondCounterHiRes();
    const auto now = [&] { return juce::String ((juce::Time::getMillisecondCounterHiRes() - started) / 1000.0, 2) + " s: "; };
    const auto pump = [] { juce::MessageManager::getInstance()->runDispatchLoopUntil (10); };

    // Log whenever the engine creates or destroys this edit's playback graph.
    struct ContextLogger : te::TransportControl::Listener
    {
        std::function<void()> onChange;
        void playbackContextChanged() override { onChange(); }
    } contextLogger;
    contextLogger.onChange = [&] { print (now() + "engine rebuilt the playback context"); };
    transport.addListener (&contextLogger);

    // Before pressing play, let the engine finish what it does asynchronously after
    // opening the device: on Windows it rebuilt the playback context at 0.24 s and
    // dropped an earlier play. Also scan MIDI devices now: the engine's first scan
    // otherwise comes 4 s after start, and if it finds devices it rebuilds every
    // playing edit's device list, which stops the transport (#101).
    print (now() + "scanning MIDI devices and waiting 1 s before pressing play");
    engine.getDeviceManager().rescanMidiDeviceList();
    edit->dispatchPendingUpdatesSynchronously();
    transport.ensureContextAllocated();
    while (juce::Time::getMillisecondCounterHiRes() - started < 1000.0)
        pump();

    const auto midiCounts = [&engine]
    {
        auto& dm = engine.getDeviceManager();
        return juce::String (dm.getNumMidiInDevices()) + " MIDI in, " + juce::String (dm.getNumMidiOutDevices()) + " MIDI out";
    };

    print (now() + "pressing play (" + midiCounts() + ")");
    transport.setPosition (te::TimePosition());
    transport.play (false);

    const auto end = length + 0.2;
    const auto deadline = juce::Time::getMillisecondCounterHiRes() + (end + 6.0) * 1000.0;
    bool wasPlaying = false;
    int restarts = 0;
    double stoppedSince = -1.0, nextStatus = 0.0;

    while (transport.getPosition().inSeconds() < end && juce::Time::getMillisecondCounterHiRes() < deadline)
    {
        pump();
        const auto t = juce::Time::getMillisecondCounterHiRes();
        const bool playing = transport.isPlaying();

        if (playing != wasPlaying)
        {
            print (now() + (playing ? "transport started" : "transport STOPPED") + " at position "
                   + juce::String (transport.getPosition().inSeconds(), 3) + " s (" + midiCounts() + ")");
            wasPlaying = playing;
            stoppedSince = playing ? -1.0 : t;
        }

        // Stopped for 200 ms before the end: press play again, at most three times.
        if (! playing && stoppedSince > 0.0 && t - stoppedSince > 200.0 && restarts < 3)
        {
            ++restarts;
            print (now() + "pressing play again (" + juce::String (restarts) + " of 3)");
            transport.play (false);
            stoppedSince = t;
        }

        if (t - started >= nextStatus)
        {
            nextStatus = t - started + 500.0;
            print (now() + "position " + juce::String (transport.getPosition().inSeconds(), 3) + " s"
                   + (transport.isPlayContextActive() ? "" : ", no playback context")
                   + ", CPU " + juce::String (engine.getDeviceManager().getCpuUsage() * 100.0f, 1) + "%"
                   + ", dropouts " + juce::String (device != nullptr ? device->getXRunCount() : -1));
        }
    }

    const bool finished = transport.getPosition().inSeconds() >= end;
    transport.stop (false, false);
    transport.removeListener (&contextLogger);
    print (finished ? (restarts == 0 ? "Done" : "Done, but only after pressing play again")
                    : "FAIL the transport did not reach the end of the edit");
    return finished && restarts == 0 ? 0 : 1;
}

/** Plays the edit through a hosted audio device that this function drives itself,
    one block at a time, as a sound card's callback would. Exercises the same
    transport code as `play`, with no sound card, and checks what came out. */
constexpr auto spikeMidiDeviceName = "CollabGod spike test MIDI";

te::VirtualMidiInputDevice* findSpikeMidiDevice (te::Engine& engine)
{
    for (auto& device : engine.getDeviceManager().getMidiInDevices())
        if (auto v = dynamic_cast<te::VirtualMidiInputDevice*> (device.get()))
            if (v->getName() == spikeMidiDeviceName)
                return v;

    return nullptr;
}

/** Runs the message loop until `done` or a second has passed. Device list
    changes are applied by the engine on a timer, not straight away. */
void pumpUntil (const std::function<bool()>& done)
{
    const auto deadline = juce::Time::getMillisecondCounterHiRes() + 1000.0;

    while (! done() && juce::Time::getMillisecondCounterHiRes() < deadline)
        juce::MessageManager::getInstance()->runDispatchLoopUntil (5);
}

/** Removes the virtual MIDI device the MIDI test creates, waiting until the engine
    has applied the change. Virtual devices are saved in the engine's settings, so
    without this the next run would start with the device and see no change. */
void removeSpikeMidiDevice (te::Engine& engine)
{
    pumpUntil ([&] { return findSpikeMidiDevice (engine) != nullptr; });

    if (auto v = findSpikeMidiDevice (engine))
        engine.getDeviceManager().deleteVirtualMidiDevice (*v);

    pumpUntil ([&] { return findSpikeMidiDevice (engine) == nullptr; });
}

/** With changeMidiDevices, adds a virtual MIDI device halfway through playback,
    as plugging in a MIDI controller would, and reports whether the transport kept going. */
int liveCheck (const juce::File& outFolder, bool changeMidiDevices)
{
    constexpr double sampleRate = 44100.0;
    constexpr int blockSize = 441;  // what the Windows Audio device used in the first manual test

    te::Engine engine ("CollabGodEngineSpike", nullptr, std::make_unique<HeadlessBehaviour>());
    spike::registerSpikePlugins (engine);

    te::HostedAudioDeviceInterface::Parameters params;
    params.sampleRate = sampleRate;
    params.blockSize = blockSize;
    params.inputChannels = 0;
    params.outputChannels = 2;

    auto& hosted = engine.getDeviceManager().getHostedAudioDeviceInterface();
    hosted.initialise (params);
    hosted.prepareToPlay (sampleRate, blockSize);
    engine.getDeviceManager().dispatchPendingUpdates();

    const auto testFile = makeTestFile (outFolder);
    juce::String error;
    auto edit = spike::createSpikeEdit (engine, { toneHz, 0.25f, toneSeconds, testFile },
                                        te::Edit::forEditing, error);

    if (edit == nullptr)
    {
        print ("FAIL " + error);
        return 1;
    }

    juce::AudioBuffer<float> block (2, blockSize);
    juce::MidiBuffer midi;
    juce::Array<float> left, right;

    // A device left over from an interrupted run would make our change a removal,
    // and that removal would happen here, before play. Clear it first.
    if (changeMidiDevices)
    {
        const auto until = juce::Time::getMillisecondCounterHiRes() + 200.0;
        pumpUntil ([&] { return juce::Time::getMillisecondCounterHiRes() > until; });

        if (findSpikeMidiDevice (engine) != nullptr)
            removeSpikeMidiDevice (engine);
    }

    bool midiChanged = false, stoppedEarly = false;

    const bool finished = playToEnd (*edit, [&]
    {
        block.clear();
        hosted.processBlock (block, midi);
        left.addArray (block.getReadPointer (0), blockSize);
        right.addArray (block.getReadPointer (1), blockSize);
        juce::MessageManager::getInstance()->runDispatchLoopUntil (1);

        const double played = left.size() / sampleRate;

        if (changeMidiDevices && ! midiChanged && played >= toneSeconds * 1.5)
        {
            midiChanged = true;
            const auto result = engine.getDeviceManager().createVirtualMidiDevice (spikeMidiDeviceName);
            print ("Added a virtual MIDI device after " + juce::String (played, 2) + " s of playback"
                   + (result.wasOk() ? "" : ": " + result.getErrorMessage()));
        }

        // Once playing, a stopped transport will not restart on its own.
        if (played > 0.5 && ! edit->getTransport().isPlaying())
        {
            stoppedEarly = true;
            print ("Transport stopped after " + juce::String (played, 2) + " s of playback");
            return false;
        }

        return true;
    });

    if (changeMidiDevices)
    {
        removeSpikeMidiDevice (engine);
        print (finished ? "PASS the transport kept playing through the MIDI device change"
                        : "FAIL the transport stopped when the MIDI devices changed (see #101)");
        return finished ? 0 : 1;
    }

    if (! finished)
    {
        print (juce::String (stoppedEarly ? "FAIL the transport stopped before" : "FAIL the transport did not reach")
               + " the end of the edit after "
               + juce::String (left.size() / sampleRate, 1) + " s of audio");
        return 1;
    }

    // Find where the transport actually started, then check from there.
    int start = 0;
    while (start < left.size() && std::abs (left[start]) < 0.01f)
        ++start;

    const int numSamples = left.size() - start;
    juce::AudioBuffer<float> recorded (2, numSamples);
    recorded.copyFrom (0, 0, left.getRawDataPointer() + start, numSamples);
    recorded.copyFrom (1, 0, right.getRawDataPointer() + start, numSamples);

    const auto recordedFile = outFolder.getChildFile ("live.wav");
    if (! spike::writeWav (recordedFile, recorded, sampleRate))
    {
        print ("FAIL could not write " + recordedFile.getFullPathName());
        return 1;
    }

    print ("Played " + juce::String (numSamples / sampleRate, 3) + " s after a "
           + juce::String (start / sampleRate * 1000.0, 0) + " ms start");

    const std::vector<spike::Window> windows {
        { "tone only", 0.1, toneSeconds - 0.1, toneHz, fileHz },
        { "file only", toneSeconds + 0.1, toneSeconds + fileSeconds - 0.1, fileHz, toneHz },
    };

    juce::String report;
    // Playback runs on a little past the end, so allow for that in the length.
    const bool passed = spike::checkRender (recordedFile, windows, -1.0, report);
    std::cout << report;
    print (passed ? "PASS" : "FAIL");
    return passed ? 0 : 1;
}

void usage()
{
    print ("Usage:\n"
           "  engine_spike play [audio-file]   Play a sine tone, then the file, on the default output\n"
           "  engine_spike check [--out dir]   Render the same edit offline and check the result\n"
           "  engine_spike live-check [--out dir]   Play it through a simulated sound card and check the result\n"
           "  engine_spike live-check --change-midi-devices   Add a MIDI device halfway through and see if playback survives");
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

    if (command == "live-check")
    {
        auto out = juce::File::getCurrentWorkingDirectory().getChildFile ("live-check");
        const auto outIndex = args.indexOf ("--out");

        if (outIndex > 0 && outIndex + 1 < args.size())
            out = juce::File::getCurrentWorkingDirectory().getChildFile (args[outIndex + 1]);

        out.createDirectory();
        return liveCheck (out, args.contains ("--change-midi-devices"));
    }

    if (command == "play")
        return play (args.size() > 1 ? juce::File::getCurrentWorkingDirectory().getChildFile (args[1]) : juce::File());

    usage();
    return command.isEmpty() || command == "--help" ? 0 : 2;
}
