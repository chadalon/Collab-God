// Spike for issue #8. Throwaway code: product code never includes this.

#include "Log.h"
#include <iostream>

namespace spike
{
namespace
{
std::unique_ptr<juce::FileOutputStream> logFile;
}

double hostTimeMs()
{
    static const double start = juce::Time::getMillisecondCounterHiRes();
    return juce::Time::getMillisecondCounterHiRes() - start;
}

void setLogFile (const juce::File& file)
{
    file.getParentDirectory().createDirectory();
    file.deleteFile();
    logFile = std::make_unique<juce::FileOutputStream> (file);

    if (logFile->failedToOpen())
        logFile.reset();
}

void log (const juce::String& message)
{
    const auto line = juce::String (hostTimeMs() / 1000.0, 3) + " s  " + message;
    std::cout << line << std::endl;

    if (logFile != nullptr)
    {
        logFile->writeText (line + "\n", false, false, nullptr);
        logFile->flush();
    }
}
} // namespace spike
