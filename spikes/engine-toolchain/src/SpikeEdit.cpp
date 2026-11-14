// Spike for issue #7. Throwaway code: product code never includes this.

#include "SpikeEdit.h"

namespace spike
{

void registerSpikePlugins (te::Engine& engine)
{
    // The Tone Generator ships with Tracktion Engine but is not in the default
    // list of built-in plugins, so it has to be registered before use.
    engine.getPluginManager().createBuiltInType<te::ToneGeneratorPlugin>();
}

std::unique_ptr<te::Edit> createSpikeEdit (te::Engine& engine, const EditPlan& plan,
                                           te::Edit::EditRole role, juce::String& error)
{
    te::AudioFile audioFile (engine, plan.audioFile);

    if (! audioFile.isValid())
    {
        error = "Cannot read audio file: " + plan.audioFile.getFullPathName();
        return {};
    }

    auto edit = te::Edit::createSingleTrackEdit (engine, role);
    edit->ensureNumberOfAudioTracks (2);
    edit->getMasterVolumePlugin()->setVolumeDb (0.0f);

    auto tracks = te::getAudioTracks (*edit);
    auto& toneTrack = *tracks[0];
    auto& fileTrack = *tracks[1];

    // Track 1: the sine tone.
    auto plugin = edit->getPluginCache().createNewPlugin (te::ToneGeneratorPlugin::xmlTypeName, {});
    auto tone = dynamic_cast<te::ToneGeneratorPlugin*> (plugin.get());

    if (tone == nullptr)
    {
        error = "Could not create the Tone Generator plugin";
        return {};
    }

    toneTrack.pluginList.insertPlugin (plugin, 0, nullptr);

    // Set values through the parameters. Assigning the plugin's CachedValues
    // (tone->frequency = ...) changes the saved state but not what the plugin
    // plays: it renders the defaults, 220 Hz at full scale.
    tone->oscTypeParam->setParameter (static_cast<float> (te::ToneGeneratorPlugin::OscType::sin), juce::sendNotificationSync);
    tone->frequencyParam->setParameter (static_cast<float> (plan.toneHz), juce::sendNotificationSync);
    tone->levelParam->setParameter (plan.toneLevel, juce::sendNotificationSync);

    // Silence the tone where the file starts, with a 5 ms ramp so it does not click.
    const auto toneEnd = te::TimePosition::fromSeconds (plan.toneSeconds);
    const auto rampStart = te::TimePosition::fromSeconds (plan.toneSeconds - 0.005);
    const float silent = tone->levelParam->getValueRange().getStart();
    auto& curve = tone->levelParam->getCurve();
    curve.addPoint (te::TimePosition(), plan.toneLevel, 0.0f, nullptr);
    curve.addPoint (rampStart, plan.toneLevel, 0.0f, nullptr);
    curve.addPoint (toneEnd, silent, 0.0f, nullptr);

    // Track 2: the audio file, starting where the tone stops.
    const auto fileLength = te::TimeDuration::fromSeconds (audioFile.getLength());
    auto clip = fileTrack.insertWaveClip (plan.audioFile.getFileNameWithoutExtension(), plan.audioFile,
                                          { { toneEnd, fileLength }, {} }, false);

    if (clip == nullptr)
    {
        error = "Could not insert the audio clip";
        return {};
    }

    return edit;
}

bool writeSineWav (const juce::File& file, double hz, float amplitude, double seconds, double sampleRate)
{
    const auto numSamples = static_cast<int> (seconds * sampleRate);
    juce::AudioBuffer<float> buffer (1, numSamples);

    for (int i = 0; i < numSamples; ++i)
        buffer.setSample (0, i, amplitude * static_cast<float> (std::sin (juce::MathConstants<double>::twoPi * hz * i / sampleRate)));

    file.deleteFile();
    std::unique_ptr<juce::OutputStream> stream = std::make_unique<juce::FileOutputStream> (file);

    juce::WavAudioFormat wav;
    auto writer = wav.createWriterFor (stream, juce::AudioFormatWriterOptions{}
                                                   .withSampleRate (sampleRate)
                                                   .withNumChannels (1)
                                                   .withBitsPerSample (16));

    return writer != nullptr && writer->writeFromAudioSampleBuffer (buffer, 0, numSamples);
}

bool writeWav (const juce::File& file, const juce::AudioBuffer<float>& buffer, double sampleRate)
{
    file.deleteFile();
    std::unique_ptr<juce::OutputStream> stream = std::make_unique<juce::FileOutputStream> (file);

    juce::WavAudioFormat wav;
    auto writer = wav.createWriterFor (stream, juce::AudioFormatWriterOptions{}
                                                   .withSampleRate (sampleRate)
                                                   .withNumChannels (buffer.getNumChannels())
                                                   .withBitsPerSample (24));

    return writer != nullptr && writer->writeFromAudioSampleBuffer (buffer, 0, buffer.getNumSamples());
}

} // namespace spike
