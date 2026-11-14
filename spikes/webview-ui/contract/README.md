# Bridge contract

What crosses the web view bridge between the C++ host (`../src`) and the page (`../ui`). Both sides test against the example files here: the page's `test/protocol.test.ts` decodes them, and `webview_spike selftest` checks that the frames and host info it builds have the same fields with the same types.

Change a field in both places and in the example file in the same commit.

## C++ to page

| Event | Payload | When |
| --- | --- | --- |
| `frame` | [`frame.example.json`](frame.example.json) | Once per display refresh (`vblank`, the default) or at a fixed rate (`--emit timer:<hz>`), while the page has asked for push delivery |

| Field | Meaning |
| --- | --- |
| `v` | Contract version, 1 |
| `seq` | Frame counter, increasing by one per frame built, push or pull |
| `hostTimeMs` | Milliseconds since the host started, when the frame was built |
| `playing` | The transport is playing |
| `positionSec` | Transport position |
| `audibleSec` | What the audio thread is outputting now (`EditPlaybackContext::getAudibleTimelineTime`) |
| `loopStartSec`, `loopEndSec` | The loop the edit plays |
| `levelsDb` | Master peak level since the previous frame, left and right, in dB; -100 is silence |
| `extraLevelsDb` | Stress payload: the master levels repeated with small offsets, as many as the page asked for with `configure` |
| `unexpectedStops` | Times the transport stopped without the page asking and the host pressed play again (engine-toolchain finding 10, #101) |
| `contextRebuilds` | Times the engine created or destroyed the playback context since start (`playbackContextChanged`) |
| `xruns` | The audio device's dropout count, or -1 if the device does not report one |

## Page to C++

Native functions, called through JUCE's `__juce__invoke` event. Each returns a promise.

| Function | Arguments | Returns |
| --- | --- | --- |
| `hello` | none | [`host-info.example.json`](host-info.example.json) |
| `ping` | any value | the same value, straight back: the bridge round trip with no engine work |
| `seek` | seconds | `{ "ok": true }` once the transport has been told; the page then watches `audibleSec` to see when the audio thread got there |
| `setPlaying` | boolean | `{ "playing": boolean }` |
| `configure` | `{ "push": boolean, "extraMeters": number }` | `{ "push": boolean, "extraMeters": number }` |
| `pullFrame` | none | a frame, as above |
| `saveReport` | the benchmark report as a JSON string | `{ "path": string }` where it was written |
| `log` | a message | nothing; the host writes it to its log, so page errors show up where a person or CI can read them |
