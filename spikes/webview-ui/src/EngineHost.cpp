// Spike for issue #8. Throwaway code: product code never includes this.

#include "EngineHost.h"
#include "Log.h"

namespace spike
{

namespace
{
/** Settled once the playback context has been left alone this long... */
constexpr double settleQuietMs = 300.0;
/** ...or, if it never changes, after this long, reported as timed out. */
constexpr double settleMaxMs = 3000.0;
/** A transport stopped this long while the user wants it playing is resumed (finding 10). */
constexpr double resumeAfterMs = 150.0;

struct HeadlessBehaviour : te::EngineBehaviour
{
    bool autoInitialiseDeviceManager() override { return false; }
};

} // namespace

/** Stands in for a sound card: calls the engine's hosted device one block at a time,
    paced to real time. This thread is the audio thread, so its loop does nothing but
    render into preallocated buffers: no locks, allocation, logging or I/O of ours. */
class EngineHost::SimulatedSoundCard : public juce::Thread
{
public:
    explicit SimulatedSoundCard (te::HostedAudioDeviceInterface& h)
        : juce::Thread ("Simulated sound card"), hosted (h), buffer (2, simulatedBlockSize)
    {
        midi.ensureSize (1024);
    }

    ~SimulatedSoundCard() override { stopThread (2000); }

    void run() override
    {
        const double blockMs = 1000.0 * simulatedBlockSize / simulatedSampleRate;
        double next = juce::Time::getMillisecondCounterHiRes();

        while (! threadShouldExit())
        {
            buffer.clear();
            midi.clear();
            hosted.processBlock (buffer, midi);

            next += blockMs;
            const double wait = next - juce::Time::getMillisecondCounterHiRes();

            if (wait >= 1.0)
                juce::Thread::sleep (static_cast<int> (wait));
            else if (wait < -100.0)
                next = juce::Time::getMillisecondCounterHiRes(); // fell far behind: do not try to catch up
        }
    }

private:
    te::HostedAudioDeviceInterface& hosted;
    juce::AudioBuffer<float> buffer;
    juce::MidiBuffer midi;
};

EngineHost::EngineHost (Audio audio)
{
    hostTimeMs(); // start the clock

    if (audio == Audio::device)
    {
        createEngine (false);

        if (auto* device = engine->getDeviceManager().deviceManager.getCurrentAudioDevice())
        {
            audioInfo = { false, device->getTypeName(), device->getName(),
                          device->getCurrentSampleRate(), device->getCurrentBufferSizeSamples() };
        }
        else
        {
            log ("No audio output device opened; using a simulated sound card instead");
            engine.reset();
            audio = Audio::simulatedRealtime;
        }
    }

    if (audio != Audio::device)
    {
        createEngine (true);
        audioInfo = { true, "simulated", audio == Audio::simulatedRealtime ? "real-time thread" : "driven by the caller",
                      simulatedSampleRate, simulatedBlockSize };
    }

    buildEdit();
    edit->getTransport().addListener (this);
    startSettling();

    if (audio == Audio::simulatedRealtime)
    {
        soundCard = std::make_unique<SimulatedSoundCard> (engine->getDeviceManager().getHostedAudioDeviceInterface());
        soundCard->startThread (juce::Thread::Priority::highest);
    }

    log ("Audio: " + audioInfo.type + " / " + audioInfo.name + ", " + juce::String (audioInfo.sampleRate)
         + " Hz, " + juce::String (audioInfo.blockSize) + " samples per block");
}

EngineHost::~EngineHost()
{
    soundCard.reset();

    if (auto m = attachedMeasurer.get())
        m->removeClient (levelClient);

    edit->getTransport().removeListener (this);
    edit->getTransport().stop (false, false);
    edit.reset();
    engine.reset();
}

void EngineHost::createEngine (bool simulated)
{
    if (simulated)
    {
        engine = std::make_unique<te::Engine> ("CollabGodWebViewSpike", nullptr, std::make_unique<HeadlessBehaviour>());

        te::HostedAudioDeviceInterface::Parameters params;
        params.sampleRate = simulatedSampleRate;
        params.blockSize = simulatedBlockSize;
        params.inputChannels = 0;
        params.outputChannels = 2;

        auto& hosted = engine->getDeviceManager().getHostedAudioDeviceInterface();
        hosted.initialise (params);
        hosted.prepareToPlay (simulatedSampleRate, simulatedBlockSize);
        engine->getDeviceManager().dispatchPendingUpdates();
    }
    else
    {
        engine = std::make_unique<te::Engine> ("CollabGodWebViewSpike");
    }

    // The Tone Generator ships with Tracktion Engine but is not registered by default
    // (engine-toolchain finding 5).
    engine->getPluginManager().createBuiltInType<te::ToneGeneratorPlugin>();
}

void EngineHost::buildEdit()
{
    edit = te::Edit::createSingleTrackEdit (*engine, te::Edit::forEditing);
    edit->ensureNumberOfAudioTracks (2);
    edit->getMasterVolumePlugin()->setVolumeDb (0.0f);

    struct Voice { double hz; float pan; double offset; };
    const Voice voices[] { { 220.0, -0.7f, 0.0 }, { 330.0, 0.7f, 0.25 } };
    auto tracks = te::getAudioTracks (*edit);

    for (size_t i = 0; i < 2; ++i)
    {
        auto& track = *tracks[static_cast<int> (i)];
        const auto& voice = voices[i];

        auto plugin = edit->getPluginCache().createNewPlugin (te::ToneGeneratorPlugin::xmlTypeName, {});
        auto tone = dynamic_cast<te::ToneGeneratorPlugin*> (plugin.get());
        jassert (tone != nullptr);
        track.pluginList.insertPlugin (plugin, 0, nullptr);

        // Through the parameters: assigning the CachedValues does not change what plays (finding 5).
        tone->oscTypeParam->setParameter (static_cast<float> (te::ToneGeneratorPlugin::OscType::sin), juce::sendNotificationSync);
        tone->frequencyParam->setParameter (static_cast<float> (voice.hz), juce::sendNotificationSync);

        // A note every half second that decays, offset between the two tracks, so the
        // meters move and the left and right channels differ.
        constexpr float loud = 0.18f, quiet = 0.01f;
        auto& curve = tone->levelParam->getCurve();
        for (double t = voice.offset; t < loopSeconds; t += 0.5)
        {
            curve.addPoint (te::TimePosition::fromSeconds (t), quiet, 0.0f, nullptr);
            curve.addPoint (te::TimePosition::fromSeconds (t + 0.01), loud, 0.0f, nullptr);
            curve.addPoint (te::TimePosition::fromSeconds (t + 0.4), quiet, 0.0f, nullptr);
        }

        if (auto vol = track.getVolumePlugin())
            vol->setPan (voice.pan);
    }

    auto& transport = edit->getTransport();
    transport.setLoopRange ({ te::TimePosition(), te::TimePosition::fromSeconds (loopSeconds) });
    transport.looping = true;
}

void EngineHost::startSettling()
{
    // Scan MIDI devices now: the engine's own first scan comes 4 s after start, and if
    // it finds devices it rebuilds every playing edit's device list, which stops the
    // transport (finding 10). Then allocate the playback context and wait for it.
    settleStart = juce::Time::getMillisecondCounterHiRes();
    engine->getDeviceManager().rescanMidiDeviceList();
    edit->dispatchPendingUpdatesSynchronously();
    edit->getTransport().ensureContextAllocated();
}

void EngineHost::playbackContextChanged()
{
    ++contextRebuilds;
    lastContextChange = juce::Time::getMillisecondCounterHiRes();

    if (! settled)
        ++settleInfo.contextChanges;

    log ("Playback context " + juce::String (edit->getTransport().isPlayContextActive() ? "created" : "destroyed")
         + " (" + juce::String (contextRebuilds) + " so far)");
}

void EngineHost::tick()
{
    const double now = juce::Time::getMillisecondCounterHiRes();
    auto& transport = edit->getTransport();

    if (! settled)
    {
        const bool quiet = settleInfo.contextChanges > 0 && transport.isPlayContextActive()
                           && now - lastContextChange >= settleQuietMs;
        const bool tooLong = now - settleStart >= settleMaxMs;

        if (quiet || tooLong)
        {
            settled = true;
            settleInfo.ms = now - settleStart;
            settleInfo.timedOut = ! quiet;
            log ("Engine settled after " + juce::String (settleInfo.ms, 0) + " ms and "
                 + juce::String (settleInfo.contextChanges) + " context changes"
                 + (settleInfo.timedOut ? " (timed out waiting for a quiet context)" : ""));

            if (wantPlaying)
            {
                transport.ensureContextAllocated();
                transport.play (false);
            }
        }

        return;
    }

    resumeIfStoppedUnexpectedly (now);
}

void EngineHost::resumeIfStoppedUnexpectedly (double now)
{
    auto& transport = edit->getTransport();

    if (transport.isPlaying())
    {
        // Where the audio thread is: TransportControl::getPosition is only refreshed on a timer.
        auto* ctx = transport.getCurrentPlaybackContext();
        stoppedSince = -1.0;
        lastPlayingPosition = ctx != nullptr ? ctx->getAudibleTimelineTime().inSeconds() : transport.getPosition().inSeconds();
        return;
    }

    if (! wantPlaying)
        return;

    if (stoppedSince < 0.0)
    {
        stoppedSince = now;
        return;
    }

    if (now - stoppedSince < resumeAfterMs)
        return;

    ++unexpectedStops;
    stoppedSince = now;
    log ("Transport stopped without being asked at " + juce::String (lastPlayingPosition, 3)
         + " s; pressing play again (" + juce::String (unexpectedStops) + " so far, see #101)");
    transport.ensureContextAllocated();
    transport.setPosition (te::TimePosition::fromSeconds (lastPlayingPosition));
    transport.play (false);
}

void EngineHost::setPlaying (bool shouldPlay)
{
    wantPlaying = shouldPlay;
    stoppedSince = -1.0;
    auto& transport = edit->getTransport();

    if (! shouldPlay)
    {
        transport.stop (false, false);
        return;
    }

    if (settled && ! transport.isPlaying())
    {
        transport.ensureContextAllocated();
        transport.play (false);
    }
}

void EngineHost::seek (double seconds)
{
    const auto clamped = juce::jlimit (0.0, loopSeconds, seconds);
    edit->getTransport().setPosition (te::TimePosition::fromSeconds (clamped));
    lastPlayingPosition = clamped;
}

Snapshot EngineHost::snapshot()
{
    auto& transport = edit->getTransport();
    auto* ctx = transport.getCurrentPlaybackContext();

    if (ctx == nullptr)
    {
        if (auto m = attachedMeasurer.get())
            m->removeClient (levelClient);
        attachedMeasurer = nullptr;
    }
    else if (&ctx->masterLevels != attachedMeasurer.get())
    {
        if (auto m = attachedMeasurer.get())
            m->removeClient (levelClient);
        attachedMeasurer = &ctx->masterLevels;
        ctx->masterLevels.addClient (levelClient);
    }

    Snapshot s;
    s.playing = transport.isPlaying();
    s.positionSec = transport.getPosition().inSeconds();
    s.audibleSec = ctx != nullptr ? ctx->getAudibleTimelineTime().inSeconds() : s.positionSec;
    const auto loop = transport.getLoopRange();
    s.loopStartSec = loop.getStart().inSeconds();
    s.loopEndSec = loop.getEnd().inSeconds();

    if (attachedMeasurer != nullptr)
    {
        const int channels = levelClient.getNumChannelsUsed();
        const float left = channels > 0 ? levelClient.getAndClearAudioLevel (0).dB : -100.0f;
        const float right = channels > 1 ? levelClient.getAndClearAudioLevel (1).dB : left;
        s.levelDb[0] = juce::jlimit (-100.0f, 24.0f, left);
        s.levelDb[1] = juce::jlimit (-100.0f, 24.0f, right);
    }

    s.unexpectedStops = unexpectedStops;
    s.contextRebuilds = contextRebuilds;

    if (! audioInfo.simulated)
        if (auto* device = engine->getDeviceManager().deviceManager.getCurrentAudioDevice())
            s.xruns = device->getXRunCount();

    return s;
}

void EngineHost::processBlock (juce::AudioBuffer<float>& buffer)
{
    jassert (soundCard == nullptr && audioInfo.simulated);
    emptyMidi.clear();
    engine->getDeviceManager().getHostedAudioDeviceInterface().processBlock (buffer, emptyMidi);
}

} // namespace spike
