// Spike for issue #8. Throwaway code: product code never includes this.

#pragma once

#include <JuceHeader.h>

namespace spike
{
/** Checks the C++ side of the bridge and the engine host without a web view or a
    sound card. Returns 0 if every check passed. `contractDir` holds the example payloads. */
int runSelfTest (const juce::File& contractDir);
} // namespace spike
