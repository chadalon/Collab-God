// Spike for issue #8. Throwaway code: product code never includes this.

#pragma once

#include <JuceHeader.h>
#include <atomic>

namespace spike
{
namespace te = tracktion;

/** What the page needs to know about the audio side, once. */
struct AudioInfo
{
    bool simulated = false;
    juce::String type, name;
    double sampleRate = 0.0;
    int blockSize = 0;
};

/** How long the engine took to settle after start-up (engine-toolchain finding 8). */
struct SettleInfo
{
    double ms = 0.0;
    int contextChanges = 0;
    int deviceChanges = 0;
    bool timedOut = false;
};

/** The engine's state at one moment, read on the message thread. */
struct Snapshot
{
    bool playing = false;
    double positionSec = 0.0;
    double audibleSec = 0.0;
    double loopStartSec = 0.0, loopEndSec = 0.0;
    float levelDb[2] { -100.0f, -100.0f };
    int unexpectedStops = 0;
    int contextRebuilds = 0;
    int xruns = -1;
};

/**
    Owns a Tracktion Engine and an edit that loops eight seconds of two tone
    generators, panned apart with their levels automated so the meters move.

    Everything here runs on the message thread. The audio thread is Tracktion's
    (a real device), or, with a simulated sound card, a thread of our own that
    only calls processBlock on preallocated buffers.

    Two lessons from spikes/engine-toolchain are built in:
    - Finding 8: a play pressed before the engine settles is lost. Play requests
      wait until the playback context has been created, the engine's first MIDI
      device scan has reported, and both have then been left alone for a while, judged by
      TransportControl::Listener::playbackContextChanged and the device manager's
      change messages. (The engine's own MIDI scans run on a message-thread timer and
      can land after the context exists: on the macOS CI runner one stopped the
      transport just after play.)
    - Finding 10 (#101): a change in the MIDI device list stops the transport.
      If the transport stops while the user wants it playing, the host presses
      play again at the same position and counts it.
*/
class EngineHost : private te::TransportControl::Listener,
                   private juce::ChangeListener
{
public:
    enum class Audio
    {
        device,            ///< the system's default output; falls back to simulatedRealtime if none opens
        simulatedRealtime, ///< a simulated sound card driven in real time by a thread of ours
        simulatedManual    ///< a simulated sound card the caller drives with processBlock (self-test)
    };

    explicit EngineHost (Audio);
    ~EngineHost() override;

    /** Call regularly on the message thread (every display frame). Completes settling,
        applies a waiting play request, and resumes after an unexpected stop. */
    void tick();

    bool isSettled() const noexcept                 { return settled; }
    SettleInfo getSettleInfo() const noexcept       { return settleInfo; }
    AudioInfo getAudioInfo() const                  { return audioInfo; }

    /** Plays or stops. A play before the engine has settled is held until it has. */
    void setPlaying (bool);
    bool wantsToPlay() const noexcept               { return wantPlaying; }

    /** Moves the transport. The audio thread follows within a block or two. */
    void seek (double seconds);

    /** Reads the state now. The levels are the peaks since the previous call. */
    Snapshot snapshot();

    /** For the self-test with Audio::simulatedManual: renders one block, as a sound card's callback would. */
    void processBlock (juce::AudioBuffer<float>&);

    te::Engine& getEngine()                         { return *engine; }
    te::Edit& getEdit()                             { return *edit; }

    static constexpr double loopSeconds = 8.0;
    static constexpr double simulatedSampleRate = 44100.0;
    static constexpr int simulatedBlockSize = 441;   // what Chad's Windows Audio device used (engine-toolchain finding 8)

private:
    void playbackContextChanged() override;
    void changeListenerCallback (juce::ChangeBroadcaster*) override;
    void createEngine (bool simulated);
    void buildEdit();
    void startSettling();
    void resumeIfStoppedUnexpectedly (double now);

    class SimulatedSoundCard;

    std::unique_ptr<te::Engine> engine;
    std::unique_ptr<te::Edit> edit;
    std::unique_ptr<SimulatedSoundCard> soundCard;
    juce::MidiBuffer emptyMidi;
    AudioInfo audioInfo;

    // Settling (finding 8)
    double settleStart = 0.0, lastContextChange = 0.0, lastDeviceChange = 0.0;
    double quietSince = -1.0;   // first tick since the last change at which we were ready, or -1
    double firstTick = -1.0;    // when tick() first ran, or -1
    bool settled = false;
    SettleInfo settleInfo;
    int contextRebuilds = 0;

    // Playing and resuming (finding 10)
    bool wantPlaying = false;
    double stoppedSince = -1.0;   // when the transport was first seen stopped, or -1
    double lastPlayingPosition = 0.0;
    int unexpectedStops = 0;

    // Master levels: Tracktion's own measurer on the playback context, which is
    // replaced whenever the context is rebuilt, so the client is re-attached.
    te::LevelMeasurer::Client levelClient;
    juce::WeakReference<te::LevelMeasurer> attachedMeasurer;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (EngineHost)
};

} // namespace spike
