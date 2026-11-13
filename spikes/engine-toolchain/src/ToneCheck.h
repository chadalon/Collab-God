// Spike for issue #7. Throwaway code: product code never includes this.

#pragma once

#include <JuceHeader.h>
#include <vector>

namespace spike
{

/** Amplitude of one frequency in part of a signal, as a linear peak value.
    Uses the Goertzel algorithm with a Hann window. */
double toneAmplitude (const float* samples, int numSamples, double sampleRate, double hz);

struct Window
{
    juce::String name;
    double startSeconds = 0.0, endSeconds = 0.0;
    double expectedHz = 0.0;  // should be clearly present
    double absentHz = 0.0;    // should be at least 40 dB below expectedHz
};

/** Reads a rendered file and checks each window. Writes a human-readable report.
    Returns true if every window passed. */
bool checkRender (const juce::File&, const std::vector<Window>&, double expectedLengthSeconds, juce::String& report);

} // namespace spike
