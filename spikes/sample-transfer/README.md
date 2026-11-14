# Spike: chunked, resumable sample transfer with progress

Phase 0 spike for [issue #16](https://github.com/chadalon/collabgod/issues/16) (SMP-4, SMP-5). When a clip uses a sample the other person does not have, the file has to arrive by itself, in chunks, survive a dropped connection, and show its progress on the clip.

It is throwaway code. It runs over the [relay spike](../relay), which gained two things for it: `direct` messages and binary frames that go to one member and never enter the ordered log.

**A sample is named by its file hash**, the SHA-256 of its bytes in lowercase hex, as [ADR-0008](../../docs/adr/0008-sample-identity.md) (Proposed) has it. That is the same hash [`../sample-index`](../sample-index) computes as `fileHash`. A transfer is always asked for and checked by this hash, never by the audio hash: the receiver can only check the bytes it wrote.

So a member serves a sample only under the file hash of the file it actually sends. A local file that matches a clip only by its audio hash has different bytes; it can play the clip, but it is not a source for that clip's file hash. It could be offered under its own file hash instead, which ADR-0008's consequences also say.

## Run it

Node 22 or newer. This spike imports the relay spike, so install both:

```sh
cd spikes/relay && npm ci
cd ../sample-transfer && npm ci
npm test              # 28 tests: 11 unit tests, and 17 transfers over real sockets on this machine, about 3 seconds
npm run typecheck
```

## What is here

| File | What it holds |
| --- | --- |
| `src/protocol.ts` | Content ids, the control messages, the binary chunk layout, defaults |
| `src/sender.ts` | `SampleServer`: answers requests for samples this machine has, one windowed stream per request |
| `src/receiver.ts` | `fetchSample`: fetches one sample into a folder, resuming from the partial file, and verifies it |
| `src/window.ts` | How much a stream may have in flight: fixed, or delay-based (LEDBAT, RFC 6817) |
| `src/progress.ts` | Turns byte counts into progress events at a bounded rate |
| `src/cli.ts` | `share` and `fetch`, the measurement between two locations |
| `bench/throttle.ts` | A TCP proxy that imitates a slow, distant home connection on one machine |
| `test/transfer.test.ts` | Transfers, resuming after either side drops, lost frames, verification, progress |
| `test/units.test.ts` | Chunk frames, message parsing, the progress reporter, the window |

## How a transfer works

The receiver drives it, and the only state that survives a drop is the partial file on the receiver's disk.

1. The receiver sends `want {id, offset, gen}` to a member who has the sample. `offset` is the size of `<project>/<id>.part`, or 0.
2. The sender looks the id up in its own index. It never receives a path, and sends none: only the content id goes over the network. It answers `have {size}` (or `missing`) and starts sending chunks from `offset`.
3. Each chunk is one binary frame: 32 bytes of content id, a 4-byte generation, an 8-byte offset and up to 64 KiB of file. The receiver hashes and appends each chunk in order, and acknowledges what it has written with `ack {received}`.
4. The sender keeps at most a window of unacknowledged bytes in flight (see the findings for how big). So the relay and the receiver never hold more than one window, whatever the file size.
5. When every byte is written, the hash computed along the way is compared with the id. On a match, `<id>.part` is renamed to `<id>`. On a mismatch it is deleted.

Resuming needs nothing from the sender: a receiver that comes back, on a new connection with a new client id, asks again from the end of its `.part`, from whoever has the sample. Only the bytes already on disk are read again, to restore the running hash.

A chunk whose offset is not the next expected byte means a frame was lost; the relay drops frames when it already holds 16 MiB for a member. The receiver then asks again from the first missing byte with a new generation, and ignores what is left of the old one. If nothing arrives for 5 seconds, it asks again the same way, which covers a lost last frame.

Progress events carry the state (`waiting`, `transferring`, `verifying`, `done`, `failed`), bytes, size and a rate over about the last second. They go out at most 20 times a second; a change of state always goes out at once. The sender reports its side too, by acknowledged bytes.

## Test between two homes

This is the part of issue #16 a cloud session cannot do. It uses the same relay setup as the relay spike's test; see [`../relay/README.md`](../relay/README.md#test-between-two-homes).

**The relay must run this branch**, because it needs the new direct messages and binary frames. On the relay machine, stop the relay, then:

```sh
cd collabgod
git fetch origin
git checkout spike/16-sample-transfer   # or main, once this is merged
cd spikes/relay
npm ci
npm run relay -- serve --host 127.0.0.1 --port 8080
```

Then, on each person's computer, on their own home network:

```sh
git clone https://github.com/chadalon/collabgod   # or git fetch and check out the branch above
cd collabgod/spikes/relay && npm ci
cd ../sample-transfer && npm ci
```

Person A (shares a file):

```sh
npm run transfer -- share wss://relay.collabgod.com --size-mb 200 --where "your town"
```

`--size-mb` makes a file of random bytes and deletes it afterwards. To send a real sample instead, use `--file path/to/sample.wav`. A prints an invite code.

Person B (fetches it):

```sh
npm run transfer -- fetch wss://relay.collabgod.com K7M-QX4 --where "your town"
npm run transfer -- fetch wss://relay.collabgod.com K7M-QX4 --drop-at-mb 50 --where "your town"
```

Run `share` once for each `fetch`. The second `fetch` cuts its own connection after 50 MB, reconnects and resumes: that is the resume check across the real network. B measures its idle connection for 3 seconds, fetches with a progress bar, checks the hash, then both print one report. The received file goes to the system's temporary folder and is deleted afterwards unless you add `--keep`.

On Windows PowerShell, run `npx tsx src/cli.ts share ...` and `npx tsx src/cli.ts fetch ...` instead, for the reason given in the relay README.

### Check and record

Both reports must show `TLS: TLSv1.2` or `TLSv1.3` and `verified`, and B's must say `Verified against its content hash: yes`. Paste both reports into a comment on issue #16. Please try:

1. Both directions, because home upload is usually much slower than download, and the slower upload decides the speed.
2. One run with `--drop-at-mb 50`.
3. If there is time, one run with `--window-kib 2048` on the sharer, to compare a fixed window with the default on a real connection.

### What the numbers mean

- **Throughput** is the file size over the time from the first request to the verified file, not counting time spent reconnecting. Compare it with each person's measured upload and download speed.
- **Ping during the transfer** travels on the same connection as the chunks, so its increase over the ping before is how long an edit sent at that moment would wait behind sample data. NFR-1 allows 150 ms for an edit to reach the other person, so this added delay has to stay well under that.
- **Progress events** per second should be about 20.

## Findings so far

From this cloud session, on one machine: real sockets through a real relay, and for the network numbers, the `bench/throttle.ts` proxy imitating a slow, distant connection on the fetcher's side. The proxy queues without limit, as a home router with a deep buffer does. The real connections between the two homes decide the rest.

1. **Chunked, resumable, verified transfer through the relay works**, and the relay change it needed was small: a `direct` message and a binary frame for one member, with the sender stamped by the relay, never stored and never ordered. Transfers stay out of the edit log entirely, as ADR-0005 has it for presence.
2. **The partial file is all the resume state there is.** Neither the relay nor the sender remembers a transfer. A receiver that reconnects with a new client id, or whose sender came back with a new one, asks again from the end of its `.part`. A test cuts the receiver's connection after every 700 KiB of a 6 MiB file and still ends with an identical file. This sidesteps the relay spike's open question of rejoining as the same person (LOB-6): transfers do not need it.
3. **Verifying costs nothing extra.** The hash is computed as chunks arrive, so the check at the end is a comparison. Only a resume reads the bytes already on disk again. Damage to the partial file between attempts is caught at the end, the partial file is deleted, and the next attempt starts clean. Hashing here ran at about 580 to 750 MB/s.
4. **On one machine, with no network in between, a transfer runs at about 120 MB/s** (965 Mbit/s) through the relay, so the relay and the protocol are not the limit for any home connection.
5. **A fixed window is wrong for every connection.** Everything in flight beyond what the slowest link carries in one round trip waits in a queue, and edits on the same connection wait behind it. The table shows the fetcher's ping to the relay through the throttling proxy (one transfer of 20 to 100 MB per row):

   | Imitated connection | Window | Throughput | Ping before | Ping during, median | Added |
   | --- | --- | --- | --- | --- | --- |
   | 20 Mbit/s, 62 ms round trip | 512 KiB fixed | 19.8 Mbit/s | 62 ms | 196 ms | +134 ms |
   | | 2 MiB fixed | 19.8 Mbit/s | 62 ms | 826 ms | +764 ms |
   | | delay-based | 18.8 Mbit/s | 62 ms | 103 ms | **+41 ms** |
   | 40 Mbit/s, 32 ms round trip | 512 KiB fixed | 39.8 Mbit/s | 32 ms | 92 ms | +60 ms |
   | | 2 MiB fixed | 39.8 Mbit/s | 32 ms | 418 ms | +386 ms |
   | | delay-based | 38.6 Mbit/s | 32 ms | 61 ms | **+29 ms** |
   | 100 Mbit/s, 82 ms round trip | 512 KiB fixed | **46.9 Mbit/s** | 82 ms | 83 ms | +1 ms |
   | | 2 MiB fixed | 98.8 Mbit/s | 82 ms | 164 ms | +82 ms |
   | | delay-based | 92.3 Mbit/s | 82 ms | 106 ms | **+24 ms** |

   A 2 MiB window adds 400 to 800 ms to every edit on a slow connection, which breaks NFR-1 for as long as a sample is moving. A 512 KiB window still adds over 100 ms there, and halves throughput on a fast, far connection. No fixed size suits both.

6. **A delay-based window fixes this**, with 93 to 97 per cent of the throughput. `src/window.ts` follows LEDBAT (RFC 6817), the algorithm made for background transfers that should get out of the way: the shortest acknowledgement time seen is the empty-queue baseline, and the window grows while the extra delay is under 25 ms and shrinks when it is over. It settled at about 230 KiB, 305 KiB and 1.3 MiB on the three connections above without being told anything about them. It is the default.
7. **What is left of the added delay is mostly one chunk.** An edit cannot overtake a frame already being sent, and a 64 KiB chunk takes 26 ms to cross a 20 Mbit/s link. That is why chunks are 64 KiB, not larger; the 44-byte header is still only 0.07 per cent.
8. **Progress at 20 events a second is enough and cheap.** It is smooth enough for a bar on a clip when the interface eases between values at its own frame rate, and transfers here produced 20 to 22 a second. The last count of a burst is never lost, and `done` and `failed` are never delayed.

## Questions for the maintainers

- **Is 25 ms of added delay during a transfer acceptable?** It is the target for the delay-based window, and the measured cost was 24 to 41 ms. A lower target protects edits more and slows transfers on connections with a jittery baseline. RFC 6817 allows up to 100 ms, which would leave too little of NFR-1's 150 ms.
- **Should edits and sample data share one connection?** Here they do, and the delay-based window keeps the cost small. A second WebSocket for bulk data would not help by itself: both connections pass through the same home router, and its queue is where the delay comes from. A direct connection between the two machines (the issue's "later optimisation") would take the relay out of the path and halve the distance for people near each other, but would need NAT traversal and a fallback to the relay for when it fails. It is not needed to meet SMP-4.
- **Should a transfer be offered under the audio hash?** When neither person has a sample's exact file, but one has the same audio in another container or with other metadata (ADR-0008), sending that file would still give the clip its sound. The receiver would then verify against the sender's file hash and match the clip by its audio hash. The protocol allows it unchanged, but the spike does not do it.
- **Who is asked for a sample in a lobby of more than two?** The spike asks one named member. With more members, the receiver could ask everyone and take the first `have`, or ask several for different ranges. The protocol already allows any member who has the bytes to serve any range.

## Not covered

- Throughput and resuming between the two real locations. That needs the test above.
- Several transfers at once. Each stream has its own window, so two streams to one person would each aim for 25 ms of delay. A real client should share one window per connection, or send one file at a time.
- Choosing which member to ask, and asking another when one leaves. The caller does that here.
- Storage. Received files are named by content id in a folder the caller chooses (SMP-6). Keeping the file extension, and cleaning up `.part` files nobody will finish, are for the product.
- Partial files damaged by a power cut. Nothing is synced to disk before it is acknowledged, so a crash can leave a partial file with damaged bytes at its end. That is caught by the hash at the end and costs one full transfer. Verifying per chunk, or syncing before acknowledging, would make it cheaper.
- Limits on who may ask for what. Any member can ask for any content id the sender has indexed; NFR-6 only needs samples to go to members of the lobby, which the relay already guarantees.
- Direct connections between the two machines.
