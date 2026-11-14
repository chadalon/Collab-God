# Spike: sample library index and content identity

Phase 0 spike for [issue #15](https://github.com/chadalon/collabgod/issues/15). A clip plays from each person's own copy of a sample only if the same audio gets the same identity on both machines. This spike indexes sample folders in the background, gives every file a content hash, rescans only what changed, measures how much of one library the other has, and tries name-based near matches.

It is throwaway code. The product indexer will live in the C++ app on a background thread (issue #42); this spike answers what identity to use and what indexing costs. It has no runtime dependencies beyond `tsx` to run the commands.

The proposed decision is in [ADR-0008](../../docs/adr/0008-sample-identity.md).

## Run it

Node 22 or newer.

```sh
cd spikes/sample-index
npm ci
npm test              # 48 tests, about 2 seconds
npm run typecheck
FC_SCALE=40 npm test  # the container property test with 40 times as many random cases
```

## What is here

| File | What it holds |
| --- | --- |
| `src/pcm.ts` | Finds the samples in WAV, AIFF and AIFF-C, and converts them to one canonical layout |
| `src/hash.ts` | One sequential read per file feeding a file-bytes hash, an audio hash, or both |
| `src/scan.ts` | Walks folders, reuses entries whose size and modified time are unchanged, reports cost |
| `src/store.ts` | Saves the index as JSON with an atomic rename |
| `src/inventory.ts` | The shareable inventory (names, sizes, hashes; no folders) and the overlap report |
| `src/match.ts` | Near matches by name: Studio-One-File-Finder's two rules plus another format |
| `src/generate.ts` | A synthetic library, and a second one sharing contents with known differences |
| `src/writers.ts` | Minimal WAV and AIFF writers for tests and the generator |
| `src/cli.ts` | `scan`, `export`, `compare`, `near`, `generate` |
| `test/hash.test.ts` | File and audio hashes, every container and bit depth, damaged headers, and a property test |
| `test/scan.test.ts` | Indexing, incremental rescans, moves, racily clean files, errors, the index file |
| `test/match.test.ts` | Name rules, ranking, the overlap tally, and that inventories hold no folders |
| `test/overlap.test.ts` | Two generated libraries compared end to end against the known answer |

## How it works

**Identity.** Each file gets a SHA-256 of its bytes. For PCM WAV, AIFF and AIFF-C it also gets an *audio hash*: the format (integer or float, bits, channels, sample rate) followed by the samples converted to little-endian signed. The same audio then hashes the same in WAV, AIFF or AIFF-C, before or after a tag edit, and with metadata chunks before or after the samples. The audio hash comes from the same sequential read as the file hash; the headers are walked inside the first 256 KB read, which for most one-shots is the whole file. RF64, compressed AIFF-C, ADPCM and every non-PCM format get a reason instead of an audio hash.

**Rescans.** An entry is reused without reading the file when its size and modified time match the previous index. A file is read again if it is new, changed, failed last time, or was *racily clean*: modified within two seconds of the start of the scan that hashed it, where a later edit could share its timestamp (FAT and exFAT keep 2-second times). Changing the hash mode re-reads everything. Symbolic links are not followed, macOS `._` files are skipped, and unreadable folders are recorded and passed over.

**What is shared.** The index holds local paths and stays on its machine. `export` writes an *inventory* with file names, sizes, hashes and lengths only, which is what the two maintainers swap to measure overlap.

**Near matches.** For a sample not matched by hash, `NearMatcher` looks for, in order:

1. `same-name`: the same file name. Studio-One-File-Finder's first rule.
2. `copy-number`: the same name once a trailing copy number like `(1)` is removed from either side. Studio-One-File-Finder's retry; it removes `(1)` but leaves the space before it, so `Kick (1).wav` became `Kick .wav`. This version removes the space too.
3. `other-format`: the same name with another audio extension, which is SMP-7's example of a near match. Studio-One-File-Finder did not do this.

Names are compared case-insensitively and after Unicode NFC normalization, because macOS file names often arrive decomposed and both systems' default file systems ignore case. When both lengths are known, a candidate whose length is within 1 percent ranks first. Name matches are suggestions; nothing applies them.

## Findings

Measured in a cloud container, not on the maintainers' machines: 2 virtual CPUs with SHA extensions, a virtual disk, Node 22. The library is synthetic: 100,000 files, 4.08 GB, 41 KB on average (70% 16-bit stereo WAV, 10% 24-bit mono WAV, 10% AIFF, 10% stand-in MP3s). "Cold" runs were after dropping the page cache. Real libraries have larger files on average, so per-file overhead will matter less and disk speed more.

| Run, 100,000 files | Wall | Of which walking | CPU | Read rate | Index |
| --- | --- | --- | --- | --- | --- |
| Full scan, file hash only, cold | 20.6 s | 4.8 s | 24.2 s | 259 MB/s | 18.9 MB |
| Full scan, audio hash only, cold | 24.0 s | 5.0 s | 28.9 s | 215 MB/s | 25.6 MB |
| Full scan, both hashes, cold | 26.5 s | 4.9 s | 31.1 s | 189 MB/s | 33.4 MB |
| Full scan, both hashes, one file at a time, warm | 42.0 s | 3.2 s | 39.0 s | 105 MB/s | |
| Rescan, nothing changed, warm | 3.2 s | 3.0 s | 3.7 s | 0 bytes read | |
| Rescan, nothing changed, cold metadata | 4.9 s | 4.7 s | 4.8 s | 0 bytes read | |

On one 200 MB file, warm, hashing costs about 1.1 s of CPU per GB for the file hash, 1.3 s for the WAV audio hash and 1.9 s for both. An AIFF audio hash costs 3.3 s per GB because the byte swap runs in JavaScript; in C++ it would be close to free.

**1. Recommendation: the file hash is the identity, and the PCM audio hash sits beside it.** The file hash is exact, works for every format, needs no decoder, and is what a transfer must be verified against anyway (issue #16). The audio hash alone cannot be the identity: it does not cover compressed formats (MP3, Ogg, REX, CAF, FLAC), and lossy decoders are not bit-exact across platforms, so the two machines could disagree. But the audio hash finds the same sound when only metadata or the container differ, which the file hash misses and which would otherwise mean a pointless transfer. It costs about 30 percent more scan time here and about 145 bytes per index entry. ADR-0008 proposes both, with the audio hash dropped if the real libraries show it rarely adds a match.

**2. Rescans read only what changed.** An unchanged 100,000-file library rescans in 3 to 5 seconds with nothing read, and all of that is walking folders and reading file times. A moved or renamed file keeps its identity but is read again, because a new path cannot be trusted to be the same file without reading it. Matching a new path to a vanished entry by size and modified time would skip that read; it is not done here because a wrong guess gives a clip the wrong sound.

**3. Indexing need not block anything.** Even in single-threaded JavaScript, the event loop waited at most 20 ms (p99 under 5 ms) during a full scan, almost all of it garbage collection. In the product the indexer runs on its own thread, so the open question is disk contention, not CPU: hashing reads every byte once, and on a hard disk or while the engine streams audio from the same drive it should run one file at a time and pause during playback. Here, one file at a time took 42 s even with a warm cache, against 26.5 s cold with four at once.

**4. The index is small enough for JSON in a spike, not in the product.** 334 bytes per file with both hashes, most of it the path. 100,000 files is 33 MB of JSON. The product should use SQLite or a binary format so a rescan does not rewrite the whole file.

**5. The synthetic overlap behaves as designed.** Two generated libraries sharing 1,000 of 2,000 contents, with the second person's copies renamed, moved, retagged, converted between WAV and AIFF, copy-numbered or re-rendered, gave 734 `same-file`, 191 `same-audio`, 75 `same-name` and exactly 1,000 `missing`. Whether real libraries look like this is the measurement below.

## Measure the real libraries

This is the part a cloud session cannot do (`needs: local machine`). Each maintainer runs it on their own computer, then both swap inventories. Allow about an hour, mostly waiting for the first scan.

Keep the index file outside the repository: it holds your folder paths. The inventory file holds sample file names and sizes and no folders; that is what you send.

1. Get the code and install it:

   ```sh
   git clone https://github.com/chadalon/collabgod
   cd collabgod/spikes/sample-index
   npm ci
   ```

2. Run the first scan over every sample folder you use, ideally just after a restart so little is cached. On Windows put each folder in double quotes; on macOS in single or double quotes.

   ```sh
   npm run samples -- scan "D:\Samples" "D:\Splice" --index ~/sample-index.json
   ```

   Copy the whole output. It prints files, time, read rate, CPU, event loop delay, index size, how many files got an audio identity and why the rest did not, and any errors.

3. Run the same command again straight away and copy its output. Nothing changed, so it should read 0 bytes.

4. Rename one sample, edit the tags of another in any tool, add a new one, and delete one. Run the command a third time. It should hash exactly three files and report one removed.

5. Optional, to compare the two hashes on your disk: after a restart, run once each with `--mode file --fresh --index ~/index-file.json` and `--mode audio --fresh --index ~/index-audio.json`.

6. Write and send your inventory:

   ```sh
   npm run samples -- export --index ~/sample-index.json --out ~/chad-inventory.json
   ```

7. With both inventories in hand, either person runs:

   ```sh
   npm run samples -- compare ~/chad-inventory.json ~/brother-inventory.json
   ```

   It shows, for each person, how many of their samples the other has as the same file, the same audio in different bytes, or only by a name rule, and how many are missing. `unique` counts distinct contents, so duplicates inside one library count once.

8. Pick three or four samples the compare shows as found only by a name rule and check them: on the other machine run `npm run samples -- near --index ~/sample-index.json "Name Of Sample.wav"` and listen to both. Note whether the suggestion was the same sound.

9. Paste the outputs of steps 2, 3, 4, 7 and 8 into issue #15, with each machine's operating system, CPU and the kind of disk the samples are on.

## Questions for the maintainers

- Answered on PR #99: an audio-hash match resolves a clip automatically. The audio is identical (same format, channels, sample rate and every sample), so the clip sounds the same; only tags or the container differ.
- Which folders do you keep samples in, and are any on network drives or cloud-synced folders? Cloud-only files on macOS and OneDrive would be downloaded by a full scan.

## Not covered

- FLAC, Ogg, MP3, REX and CAF decoding. They get a file hash only.
- File system watching for live updates; the product's indexer adds it (issue #42).
- Running the scan on its own thread with lowered I/O priority, and pausing it during playback.
- Matching by audio similarity (a fingerprint that survives resampling or re-encoding). Out of scope for v1.
- Real libraries. See above.
