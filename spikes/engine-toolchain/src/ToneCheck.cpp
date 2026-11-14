// Spike for issue #7. Throwaway code: product code never includes this.

#include "ToneCheck.h"

namespace spike
{

double toneAmplitude (const float* samples, int numSamples, double sampleRate, double hz)
{
    if (numSamples < 2)
        return 0.0;

    const double omega = juce::MathConstants<double>::twoPi * hz / sampleRate;
    const double coeff = 2.0 * std::cos (omega);
    double s1 = 0.0, s2 = 0.0, windowSum = 0.0;

    for (int i = 0; i < numSamples; ++i)
    {
        const double w = 0.5 - 0.5 * std::cos (juce::MathConstants<double>::twoPi * i / (numSamples - 1));
        windowSum += w;
        const double s0 = w * samples[i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }

    const double real = s1 - s2 * std::cos (omega);
    const double imag = s2 * std::sin (omega);
    return 2.0 * std::sqrt (real * real + imag * imag) / windowSum;
}

bool checkRender (const juce::File& file, const std::vector<Window>& windows,
                  double expectedLengthSeconds, juce::String& report)
{
    constexpr double minimumAmplitude = 0.02;  // about -34 dBFS
    constexpr double maximumLeakRatio = 0.01;  // 40 dB

    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> reader (formats.createReaderFor (file));

    if (reader == nullptr)
    {
        report << "FAIL cannot read " << file.getFullPathName() << "\n";
        return false;
    }

    const double sampleRate = reader->sampleRate;
    const auto numSamples = static_cast<int> (reader->lengthInSamples);
    const double lengthSeconds = numSamples / sampleRate;

    juce::AudioBuffer<float> buffer (static_cast<int> (reader->numChannels), numSamples);
    reader->read (&buffer, 0, numSamples, 0, true, true);

    bool passed = true;
    report << "Rendered " << file.getFileName() << ": " << static_cast<int> (reader->numChannels) << " channels, "
           << sampleRate << " Hz, " << juce::String (lengthSeconds, 3) << " s\n";

    if (expectedLengthSeconds > 0.0 && std::abs (lengthSeconds - expectedLengthSeconds) > 0.05)
    {
        report << "FAIL length: expected about " << expectedLengthSeconds << " s\n";
        passed = false;
    }

    // A tone stuck at its defaults once rendered at full scale; catch that directly.
    const float peak = buffer.getMagnitude (0, numSamples);
    report << "Peak " << juce::String (juce::Decibels::gainToDecibels (peak), 1) << " dBFS\n";

    if (peak > 0.9f)
    {
        report << "FAIL peak is near full scale; expected about -12 dBFS\n";
        passed = false;
    }

    for (const auto& w : windows)
    {
        const int start = juce::jlimit (0, numSamples, static_cast<int> (w.startSeconds * sampleRate));
        const int end = juce::jlimit (start, numSamples, static_cast<int> (w.endSeconds * sampleRate));

        for (int channel = 0; channel < buffer.getNumChannels(); ++channel)
        {
            const float* data = buffer.getReadPointer (channel, start);
            const double present = toneAmplitude (data, end - start, sampleRate, w.expectedHz);
            const double absent = toneAmplitude (data, end - start, sampleRate, w.absentHz);
            const bool ok = present >= minimumAmplitude && absent <= present * maximumLeakRatio;
            passed = passed && ok;

            report << (ok ? "ok   " : "FAIL ") << w.name << ", channel " << channel << ": "
                   << w.expectedHz << " Hz at " << juce::String (juce::Decibels::gainToDecibels (present), 1) << " dBFS, "
                   << w.absentHz << " Hz at " << juce::String (juce::Decibels::gainToDecibels (absent), 1) << " dBFS\n";
        }
    }

    return passed;
}

} // namespace spike
