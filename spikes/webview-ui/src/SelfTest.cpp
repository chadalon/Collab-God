// Spike for issue #8. Throwaway code: product code never includes this.
//
// `webview_spike selftest`: everything on the C++ side of the bridge that can be
// checked without a web view or a sound card. ctest runs it on CI.

#include "SelfTest.h"
#include "Bridge.h"
#include "EngineHost.h"
#include "Log.h"

namespace spike
{
namespace
{
struct Checker
{
    int failures = 0;

    void check (bool ok, const juce::String& what)
    {
        log ((ok ? "ok    " : "FAIL  ") + what);
        if (! ok)
            ++failures;
    }
};

/** Drives the simulated sound card for `seconds` of audio, running the message loop
    and the host's per-frame tick about 60 times a second of audio, as the window would.
    `perFrame` sees each snapshot; return false from it to stop early. */
void play (EngineHost& host, double seconds, const std::function<bool (const Snapshot&)>& perFrame = {})
{
    constexpr int block = EngineHost::simulatedBlockSize;
    const int blocks = static_cast<int> (seconds * EngineHost::simulatedSampleRate / block);
    juce::AudioBuffer<float> buffer (2, block);
    int frame = 0;

    for (int i = 0; i < blocks; ++i)
    {
        buffer.clear();
        host.processBlock (buffer);
        juce::MessageManager::getInstance()->runDispatchLoopUntil (1);

        // A display frame every 1/60 s of audio.
        const auto audioSeconds = static_cast<double> ((i + 1) * block) / EngineHost::simulatedSampleRate;
        if (audioSeconds * 60.0 >= frame + 1)
        {
            ++frame;
            host.tick();
            if (perFrame && ! perFrame (host.snapshot()))
                return;
        }
    }
}

/** Runs the message loop until `done` or `ms` have passed. */
void pumpUntil (const std::function<bool()>& done, double ms)
{
    const auto deadline = juce::Time::getMillisecondCounterHiRes() + ms;
    while (! done() && juce::Time::getMillisecondCounterHiRes() < deadline)
        juce::MessageManager::getInstance()->runDispatchLoopUntil (5);
}

juce::var readJson (const juce::File& file)
{
    return juce::JSON::parse (file.loadFileAsString());
}

void testUiFiles (Checker& c)
{
    juce::TemporaryFile tempFolder;
    const auto folder = tempFolder.getFile();
    folder.createDirectory();
    folder.getChildFile ("index.html").replaceWithText ("<!doctype html><title>t</title>");
    folder.getChildFile ("app.js").replaceWithText ("console.log(1)");
    folder.getParentDirectory().getChildFile ("secret.txt").replaceWithText ("no");

    const auto index = serveUiFile (folder, "/");
    c.check (index.has_value() && index->mimeType == "text/html" && index->data.size() == 31, "serves index.html for /");

    const auto js = serveUiFile (folder, "/app.js?v=2");
    c.check (js.has_value() && js->mimeType == "text/javascript", "serves app.js as JavaScript, ignoring a query string");

    c.check (! serveUiFile (folder, "/missing.css").has_value(), "serves nothing for a missing file");
    c.check (! serveUiFile (folder, "/../secret.txt").has_value(), "serves nothing outside the folder");
    c.check (! serveUiFile (folder.getChildFile ("nowhere"), "/").has_value(), "serves nothing when the folder is missing");

    const auto missing = missingUiPage (folder.getChildFile ("nowhere"));
    c.check (missing.mimeType == "text/html" && ! missing.data.empty(), "has a page explaining how to build the UI");

    folder.deleteRecursively();
    folder.getParentDirectory().getChildFile ("secret.txt").deleteFile();
}

void testContract (Checker& c, const juce::File& contractDir)
{
    const auto frameExample = readJson (contractDir.getChildFile ("frame.example.json"));
    const auto hostExample = readJson (contractDir.getChildFile ("host-info.example.json"));
    c.check (frameExample.isObject() && hostExample.isObject(), "reads the contract examples from " + contractDir.getFullPathName());

    Snapshot s;
    s.playing = true;
    s.levelDb[0] = -6.5f;

    juce::String error;
    const auto frame = buildFrame (s, 1, 12.5, 0);
    c.check (matchesContract (frame, frameExample, error), "a frame matches the contract " + error);

    // The JSON the web view receives, parsed back, must match too: no NaN, no lost fields.
    const auto roundTripped = juce::JSON::parse (juce::JSON::toString (buildFrame (s, 2, 13.0, 3)));
    c.check (matchesContract (roundTripped, frameExample, error), "a frame survives JSON " + error);
    c.check (roundTripped["extraLevelsDb"].size() == 3, "extra meters are added on request");

    const auto info = buildHostInfo ({ true, "simulated", "test", 44100.0, 441 }, { 812.0, 2, 1, false }, { webViewName(), "vblank", "none" });
    c.check (matchesContract (info, hostExample, error), "host info matches the contract " + error);

    // And the checker itself notices a difference.
    auto* extra = frame.getDynamicObject();
    extra->setProperty ("surprise", 1);
    c.check (! matchesContract (frame, frameExample, error) && error.contains ("surprise"), "the contract check catches an extra field");
    extra->removeProperty ("surprise");
    extra->setProperty ("playing", 1);
    c.check (! matchesContract (frame, frameExample, error) && error.contains ("playing"), "the contract check catches a wrong type");
}

void testEngine (Checker& c)
{
    EngineHost host (EngineHost::Audio::simulatedManual);

    // Finding 8: wait for the playback context to settle before playing.
    host.setPlaying (true);
    pumpUntil ([&] { host.tick(); return host.isSettled(); }, 5000.0);
    const auto settle = host.getSettleInfo();
    c.check (host.isSettled(), "the engine settles");
    log ("      settled after " + juce::String (settle.ms, 0) + " ms, " + juce::String (settle.contextChanges)
         + " context changes, " + juce::String (settle.deviceChanges) + " device list changes"
         + (settle.timedOut ? ", TIMED OUT waiting for a quiet context" : ""));
    c.check (! settle.timedOut, "settling saw playbackContextChanged and did not need the time-out");

    // Let start-up finish in wall-clock time, as it would with a window open: the
    // engine's own device scans run on message-thread timers. A stop they cause is
    // resumed by the host; report it, since it means settling was not enough.
    const auto warmUpEnd = juce::Time::getMillisecondCounterHiRes() + 600.0;
    while (juce::Time::getMillisecondCounterHiRes() < warmUpEnd)
        play (host, 0.05);
    const auto start = host.snapshot();
    log ("      unexpected stops during start-up, resumed by the host: " + juce::String (start.unexpectedStops));
    c.check (start.playing, "the play request made before settling took effect afterwards");

    // Play a second: the transport runs and both meters move.
    float maxLeft = -100.0f, maxRight = -100.0f;
    int frames = 0;
    play (host, 1.0, [&] (const Snapshot& s)
    {
        maxLeft = juce::jmax (maxLeft, s.levelDb[0]);
        maxRight = juce::jmax (maxRight, s.levelDb[1]);
        ++frames;
        return true;
    });
    auto s = host.snapshot();
    auto moved = s.audibleSec - start.audibleSec;
    if (moved < 0.0)
        moved += EngineHost::loopSeconds;
    c.check (s.playing && moved > 0.85 && moved < 1.1, "one second of audio moves the audible position about a second (" + juce::String (moved, 3) + " s)");
    c.check (maxLeft > -30.0f && maxRight > -30.0f, "both master meters move (peaks " + juce::String (maxLeft, 1) + " and " + juce::String (maxRight, 1) + " dB)");
    c.check (frames >= 58 && frames <= 61, "the host ticked about 60 times a second of audio (" + juce::String (frames) + ")");

    // A seek reaches the audio thread within a few blocks.
    host.seek (6.0);
    int framesToAudible = -1, frame = 0;
    play (host, 0.5, [&] (const Snapshot& snap)
    {
        ++frame;
        if (snap.audibleSec >= 6.0 && snap.audibleSec < 6.3)
        {
            framesToAudible = frame;
            return false;
        }
        return true;
    });
    c.check (framesToAudible > 0, "a seek reaches the audio thread"
             + (framesToAudible > 0 ? ", seen " + juce::String (framesToAudible) + " display frame(s) later" : juce::String()));

    // The edit loops at eight seconds.
    host.seek (7.5);
    play (host, 1.0);
    s = host.snapshot();
    c.check (s.playing && s.audibleSec < 1.0, "playback loops from 8 s back to the start (at " + juce::String (s.audibleSec, 3) + " s)");

    // Finding 10 (#101): a MIDI device change stops the transport; the host resumes it.
    constexpr auto midiName = "CollabGod web view spike test MIDI";
    auto& dm = host.getEngine().getDeviceManager();
    const auto findDevice = [&]() -> te::VirtualMidiInputDevice*
    {
        for (auto& d : dm.getMidiInDevices())
            if (auto v = dynamic_cast<te::VirtualMidiInputDevice*> (d.get()); v != nullptr && v->getName() == midiName)
                return v;
        return nullptr;
    };

    if (auto leftover = findDevice())
    {
        dm.deleteVirtualMidiDevice (*leftover);
        pumpUntil ([&] { return findDevice() == nullptr; }, 1000.0);
    }

    const int stopsBefore = host.snapshot().unexpectedStops;
    const auto result = dm.createVirtualMidiDevice (midiName);
    c.check (result.wasOk(), "adds a virtual MIDI device during playback" + (result.wasOk() ? juce::String() : ": " + result.getErrorMessage()));
    bool sawStop = false;
    play (host, 2.0, [&] (const Snapshot& snap) { sawStop = sawStop || ! snap.playing; return true; });
    s = host.snapshot();
    log ("      transport " + juce::String (sawStop ? "stopped" : "did not stop") + " after the MIDI change; host resumed it "
         + juce::String (s.unexpectedStops - stopsBefore) + " times");
    c.check (s.playing, "playback continues after the MIDI device change");
    c.check (! sawStop || s.unexpectedStops > stopsBefore, "a stop nobody asked for is counted as resumed");

    if (auto added = findDevice())
    {
        dm.deleteVirtualMidiDevice (*added);
        pumpUntil ([&] { return findDevice() == nullptr; }, 1000.0);
    }

    host.setPlaying (false);
    play (host, 0.3);
    c.check (! host.snapshot().playing && host.snapshot().unexpectedStops == s.unexpectedStops, "a stop the user asks for stays stopped");
}
} // namespace

int runSelfTest (const juce::File& contractDir)
{
    Checker c;
    log ("Self-test: UI files");
    testUiFiles (c);
    log ("Self-test: bridge contract");
    testContract (c, contractDir);
    log ("Self-test: engine");
    testEngine (c);
    log (c.failures == 0 ? "PASS" : "FAIL " + juce::String (c.failures) + " checks failed");
    return c.failures == 0 ? 0 : 1;
}
} // namespace spike
