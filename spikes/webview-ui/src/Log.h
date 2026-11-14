// Spike for issue #8. Throwaway code: product code never includes this.

#pragma once

#include <JuceHeader.h>

namespace spike
{
/** Milliseconds since the program started, from the high-resolution counter. */
double hostTimeMs();

/** Also write log lines to this file. On Windows a GUI app has no console, so this is
    where its output goes. Call once at start-up, on the message thread. */
void setLogFile (const juce::File&);

/** Writes a line, with the time since start, to stdout and the log file.
    Message thread only: never call it from the audio thread. */
void log (const juce::String&);
} // namespace spike
