// Spike for issue #7. Throwaway code: product code never includes this.

#pragma once

#include <JuceHeader.h>

namespace spike
{
namespace te = tracktion; // engine and core are inline namespaces of tracktion

/** What the spike plays: a sine tone, then an audio file, one after the other. */
struct EditPlan
{
    double toneHz = 440.0;
    float toneLevel = 0.25f;      // linear gain of the tone generator
    double toneSeconds = 1.0;     // the tone plays from 0 to here
    juce::File audioFile;         // starts where the tone stops
};

/** Registers the plugin types the spike uses that the engine does not register itself. */
void registerSpikePlugins (te::Engine&);

/** Builds an edit with two audio tracks:
    1. a Tone Generator whose level is automated to silence at toneSeconds;
    2. the audio file as a clip starting at toneSeconds.
    Returns nullptr and fills `error` if the file cannot be read. */
std::unique_ptr<te::Edit> createSpikeEdit (te::Engine&, const EditPlan&, te::Edit::EditRole, juce::String& error);

/** Writes a mono 16-bit WAV containing a sine wave. Used to make the test file. */
/** Writes a 24-bit WAV of the buffer. */
bool writeWav (const juce::File&, const juce::AudioBuffer<float>&, double sampleRate);

bool writeSineWav (const juce::File&, double hz, float amplitude, double seconds, double sampleRate);

} // namespace spike
