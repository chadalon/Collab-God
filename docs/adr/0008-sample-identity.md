# ADR-0008: Sample identity is the SHA-256 of the file, with a PCM audio hash beside it

- **Status:** Proposed
- **Date:** 2026-11-13
- **Deciders:** Chad

## Context

A clip points at a sample by content, not by path (SMP-2, SMP-3). The same sample must get the same identity on both machines, or the app sends a file the other person already has. The identity also has to be cheap enough to compute for a library of 100,000 files in the background (NFR-5), and it is what a transferred file is checked against (SMP-4, issue #16).

There are two candidates. A hash of the file's bytes is exact, cheap and works for every format, but changes when anything rewrites the file's metadata (tags, BPM, key, loop or broadcast chunks) even though the sound is the same. A hash of the decoded audio survives those edits, but needs a decoder per format, and lossy decoders (MP3, Ogg Vorbis) are not required to produce bit-identical output, so two machines can disagree about the "same" audio.

The spike for issue #15 (`spikes/sample-index`) built both. For uncompressed PCM in WAV, AIFF and AIFF-C, the audio hash is cheap: it reads the chunk headers, converts the samples to one canonical layout (little-endian, signed), and hashes that with the format (encoding, bits, channels, sample rate). The same audio then has one audio hash in any of those containers and with any metadata chunks.

## Decision

- A sample's **identity** is the SHA-256 of the file's bytes. Clips, the project file and the network refer to samples by this hash.
- For PCM WAV, AIFF and AIFF-C the indexer also stores an **audio hash**, computed in the same read. A clip whose file hash is missing locally but whose audio hash matches a local file plays from that file automatically: the samples are identical, so the clip sounds identical. It counts as an exact match under the roadmap's rule, not a fuzzy one.
- Name-based matches (same name, name without a copy number, same name in another format) are only ever suggestions (SMP-7).
- Compressed formats get no audio hash in v1.

## Alternatives considered

- **File hash only.** Simplest and cheapest. Misses every sample whose metadata differs between the two libraries, which then transfers for nothing. Keep this if the real-library measurement shows the audio hash adds little.
- **Audio hash only.** No identity for MP3, Ogg, REX or CAF without a decoder, decoders that may disagree between Windows and macOS for lossy formats, and a transferred file still needs a byte hash to be verified.
- **Hash of the first and last few megabytes plus the size.** Much faster on large files, but two different files can collide, and a wrong match plays the wrong sound silently.
- **BLAKE3 instead of SHA-256.** Faster in software, but SHA-256 runs at about 1 GB/s per core on CPUs with SHA extensions, is in every platform's standard crypto library, and needs no extra dependency.

## Consequences

- The project file stores the file hash and, when known, the audio hash for each sample, plus a last-known name (issue #25).
- The index costs about 145 more bytes per file and, in the spike, 30 to 75 percent more CPU than the file hash alone, because the bytes go through two hashes. The canonical conversion is a byte swap for AIFF and nothing for WAV.
- When the audio hash resolves a clip, the local file is not byte-identical. Anything that needs the exact file, such as sending it on to a third person, must use the file hash of what is actually sent.
- WAV and AIFF metadata that can change playback in a sampler (root note, loop points in `smpl` or `INST`) is ignored by the audio hash. That is fine for timeline audio clips and must be revisited before samples are used inside an instrument.
- FLAC is lossless, so its decoded audio could share the PCM audio hash. It is a candidate to add once a decoder is in the engine.

## How we will know

The `compare` command in `spikes/sample-index` run on both maintainers' real libraries (issue #15). If `same-audio` matches are a negligible share of the overlap, drop the audio hash and keep the file hash only. If many matches are left to the name rules, look at what differs before adding more rules.
