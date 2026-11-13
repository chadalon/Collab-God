# Spike: minimal relay for a lobby of two

Phase 0 spike for [issue #10](https://github.com/chadalon/collabgod/issues/10). [ADR-0004](../../docs/adr/0004-ordered-edit-log.md) needs something every client can reach that puts everyone's operations into one order. This is that something, as small as it can be: a WebSocket server that holds lobbies of two, gives each operation the next sequence number, sends it to both people, and keeps the log in memory so someone who joins late can catch up.

It is throwaway code. Its ordering is the session-model spike's `Relay` class, used as is; this spike adds the network around it. The relay never reads an operation: it checks the frame, stamps the sender and a sequence number, and passes `op` on unchanged.

## Run it

Node 22 or newer.

```sh
cd spikes/relay
npm ci
npm test              # 19 tests over real sockets on this machine, about 2 seconds
npm run typecheck
FC_SCALE=10 npm test  # the convergence test with 10 times as many random cases
```

## What is here

| File | What it holds |
| --- | --- |
| `src/protocol.ts` | The JSON messages in each direction, error codes, invite code format |
| `src/server.ts` | The relay: lobbies, invite codes, ordering through the session-model `Relay`, catch-up, optional TLS, heartbeat |
| `src/client.ts` | A small client: create or join, send operations, receive them in order, ping, TLS details |
| `src/replica-link.ts` | Runs a session-model `Replica` over a client connection |
| `src/cli.ts` | `serve`, and the `host` and `join` commands for the test between two locations |
| `test/relay.test.ts` | Lobbies, codes, the cap of two, ordering, catch-up, bad input |
| `test/convergence.test.ts` | Two `Replica`s editing at once over real sockets, then a late joiner, all ending in the state of the log |
| `test/tls.test.ts` | The same over TLS with a throwaway certificate, and refusal of an untrusted one |

## Protocol

One WebSocket per person, JSON text frames.

| Direction | Message | Meaning |
| --- | --- | --- |
| client → relay | `{type: "create"}` | Open a lobby and join it |
| client → relay | `{type: "join", code}` | Join by invite code. Case, spaces and dashes are ignored |
| client → relay | `{type: "op", opId, op}` | Order this operation. `op` is any JSON value |
| client → relay | `{type: "ping", t}` | Answered at once with `pong`, outside the log |
| relay → client | `{type: "welcome", code, clientId, peers, log}` | You are in. `log` is everything ordered so far |
| relay → client | `{type: "op", seq, opId, clientId, op}` | The next operation, sent to everyone including its sender |
| relay → client | `{type: "peer-joined" \| "peer-left", clientId}` | The other person arrived or left |
| relay → client | `{type: "error", code, message}` | `bad-message`, `unknown-room`, `room-full`, `already-joined`, `not-joined` or `duplicate-op` |

Invite codes are six characters from an alphabet without 0, O, 1, I, L or U, shown as `K7M-QX4`. The relay assigns each connection an id (`p1`, `p2`, ...) and stamps it on that connection's operations, so nobody can send an operation as someone else.

## Test between two homes

This is the part of issue #10 a cloud session cannot do. It needs both maintainers, each on their own home network, and a relay both can reach over TLS. Allow about 30 minutes the first time.

### 1. Put a relay on the internet with TLS

Pick one option and write down which one you used, because they measure different paths.

**Option A, recommended: a small cloud server.** This is closest to how the product will run.

1. Create the smallest Linux virtual machine your provider offers, in a region roughly between you. Open ports 80 and 443 to the internet.
2. Give it a name. Either point a domain you own at its address, or use `<address-with-dashes>.sslip.io` (for 203.0.113.5, `203-0-113-5.sslip.io`), which resolves to that address with no setup.
3. Install Node 22 or newer, Git and [Caddy](https://caddyserver.com/docs/install). Caddy obtains and renews a certificate by itself and passes WebSocket connections through.
4. Start the relay, listening only on the machine itself:

   ```sh
   git clone https://github.com/chadalon/collabgod
   cd collabgod/spikes/relay
   npm ci
   npm run relay -- serve --host 127.0.0.1 --port 8080
   ```

5. In a second terminal, replace the contents of `/etc/caddy/Caddyfile` with the following, using your name, then run `sudo systemctl reload caddy`:

   ```
   relay.example.com {
     reverse_proxy 127.0.0.1:8080
   }
   ```

6. From your own computer, open `https://relay.example.com/healthz`. It should show `ok`. The relay URL is then `wss://relay.example.com`.

**Option B, no server: a temporary tunnel from one person's computer.** Quicker to set up, but the relay then sits on one home connection, so the numbers include that person's upload twice.

1. On the person hosting the relay's computer, start it: `npm run relay -- serve --port 8080`.
2. Install [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) and run `cloudflared tunnel --url http://localhost:8080`. It prints an `https://<random>.trycloudflare.com` address. The relay URL is the same address with `wss://` in place of `https://`.
3. Cloudflare's page on these tunnels says they are for testing and does not mention WebSockets. If `host` below cannot connect through the tunnel, use option A.

### 2. Run the test

Both people, on their own home networks (not on the same Wi-Fi, and with any VPN off):

```sh
git clone https://github.com/chadalon/collabgod
cd collabgod/spikes/relay
npm ci
```

Person A:

```sh
npm run relay -- host wss://relay.example.com --where "your town"
```

It prints the TLS details and an invite code such as `K7M-QX4`. Send the code to person B.

Person B:

```sh
npm run relay -- join wss://relay.example.com K7M-QX4 --where "your town"
```

The test then runs by itself for about half a minute: person A sends 200 numbered probe operations through the relay, one every 100 ms, and person B's client answers each one the moment it arrives. Both print the same report, and B's adds its own rows. Leave both machines alone while it runs.

**On Windows PowerShell,** `npm run relay -- ...` does not work as written: PowerShell's npm wrapper drops the `--`, so npm swallows options such as `--where` and `--port` and warns `Unknown cli config`, and a quoted `"your town"` is split into two words. Run the CLI directly instead, which behaves the same everywhere:

```sh
npx tsx src/cli.ts host wss://relay.example.com --where "your town"
npx tsx src/cli.ts join wss://relay.example.com K7M-QX4 --where "your town"
npx tsx src/cli.ts serve --port 8080
```

### 3. Check and record

Both reports must show:

- `TLS: TLSv1.2` or `TLSv1.3`, and `certificate ... verified`. If either says `NOT ENCRYPTED` or `NOT verified`, the test does not count for NFR-7.
- `caught up on 3 operation(s) ... (expected 3)`. This is the late-join check across the network.
- `0 lost`, or a handful at most.

Paste both reports into a comment on issue #10, with which relay option you used and the provider and region for option A. Run it two or three times at different times of day if you can, because home connections vary by evening.

### What the numbers mean

The two machines' clocks are not synchronised, so one-way delay cannot be measured directly. The test measures a round trip instead: A sends a probe, the relay orders it and passes it to B, B answers, and the answer comes back to A the same way. That is two passes through the relay, so half of it estimates how long an edit from A takes to appear for B, which is what NFR-1 limits to 150 ms. The estimate is fair when the two directions take about the same time, which is usual. The ping rows show how much of that is each person's own connection to the relay.

## Findings so far

From this cloud session, on one machine. The numbers between two homes come from the test above.

1. **The session-model `Relay` class needed no changes to go on a network.** The server is a thin shell around it: parse a frame, stamp the sender, sequence, send the result to both people. Because the relay never reads an operation, the probes in the test above are just operations it cannot tell from edits.
2. **Convergence held over real sockets.** In the randomized test, two `Replica`s edit, undo and redo at the same time through a real relay, with random pauses so each often edits a view the other has already changed. In a run of 300 cases, 3,516 operations were ordered and 61 edits were dropped because the other person's conflicting edit was ordered first. Every case ended with both people, and a third who joined afterwards, in the state of the relay's log.
3. **Catch-up must be atomic with joining.** The relay adds the newcomer and sends the log in the same step, so no operation can fall between the log and the live stream. A test sends 200 operations while the second person is joining and checks that nothing is missed or repeated.
4. **The client must buffer.** Operations can arrive in the same network read as the welcome, before the code that awaited the welcome has run. The client keeps every operation it has received and replays them to anyone who subscribes later.
5. **The relay must stamp the sender.** If clients said who they were, one person could send operations as the other and break the other's undo history. The relay ignores any sender a client claims.
6. **Operation ids give de-duplication for free.** The relay refuses to order an id it has already ordered in that lobby. That is the relay's half of resending after a reconnect; the client's half is not built.
7. **On one machine, over TLS, an operation reached the other person in about 1 ms.** This shows only that the relay adds almost nothing of its own. The network between two homes decides whether NFR-1 holds.

## Results between two homes

**Run 1, 2026-11-13 00:13 UTC, option B** (relay on the host's PC behind a Cloudflare quick tunnel; joiner on a phone hotspot, on a laptop that was running slowly; both in Chapel Hill). Partial: it shows the path works, not whether NFR-1 holds.

- TLS 1.3 with a verified certificate on both sides. Late join caught up on 3 of 3 operations. 200 of 200 probes answered, 0 lost.
- Estimated edit delay host → joiner: median 18 ms, 95th percentile 148.8 ms, maximum 231 ms. The 95th percentile is 1.2 ms under the NFR-1 limit of 150 ms, on a single 30-second run.
- The host's own path was steady (median 6 ms, maximum 7.3 ms). The spread is on the joiner's side (ping 95th 71 ms, edit round trip 95th 192 ms), which fits a hotspot and a slow laptop. The test cannot separate the two.
- Option B puts the relay on the host's home connection, so these numbers are not the path the product will use. A run against a cloud relay (option A) is still needed.
- The report has no place name for the host because of the PowerShell problem described above.

**Run 2, 2026-11-13 00:52 UTC, option A** (small Google Cloud VM in us-east1 behind Caddy at `relay.collabgod.com`; host on a home connection in Chapel Hill; joiner on the same slow laptop as run 1).

- TLS 1.3 with a verified certificate on both sides. Late join caught up on 3 of 3 operations. 200 of 200 probes answered, 0 lost.
- Estimated edit delay host → joiner: median 27.6 ms, 95th percentile 53.7 ms, maximum 109.5 ms. NFR-1 allows 150 ms, so this holds with about 96 ms of margin at the 95th percentile on this run.
- Host to relay ping: median 22.1 ms, 95th 24.4 ms. Joiner to relay ping: median 37.7 ms, 95th 72.3 ms. The joiner's side is still the noisier one.
- One run, one time of day, one slow laptop. A second run at another time, from a normal home connection, would make this firmer.

**Run 3, 2026-11-13 01:38 UTC, option A** (same relay; host on a home connection in Chapel Hill; joiner on a normal home connection in Park City, with a 79 ms ping to the relay in South Carolina).

- TLS 1.3 with a verified certificate on both sides. Late join caught up on 3 of 3 operations. 200 of 200 probes answered, 0 lost.
- Estimated edit delay host → joiner: median 49.2 ms, 95th percentile 53.8 ms, maximum 147.8 ms. NFR-1 allows 150 ms at the 95th percentile, so it holds with about 96 ms of margin, from a joiner on a healthy machine with a slower path to the relay.
- Host to relay ping: median 21.6 ms. Joiner to relay ping: median 79.3 ms, 95th 89.0 ms. The joiner's one-way leg is about 40 ms and the host's about 11 ms, which adds up to the 49 ms estimate, so the assumption that both directions take about the same time looks reasonable here.
- The delay follows each person's path to the relay, so where a production relay sits will matter. This run had one person near the relay and one with a ping of about 79 ms; two people both far from it would see more.

## Questions for the maintainers

- **What does "a lobby of two" mean when someone leaves?** Here it is two people connected at once: if one disconnects, anyone with the code can take the free place and receives the whole log. Should the second place instead belong to whoever first joined?
- **Is a six-character code enough?** It gives about 729 million codes, and the relay does not limit how fast someone can guess. That is fine for a spike, not for a public relay.

## Not covered

- Rejoining as the same person. A reconnecting person gets a new id, so their unconfirmed operations are lost. LOB-6 needs a resume token and a client that resends.
- Snapshots and log compaction. A late joiner receives the whole log in one message.
- Rate limits, limits on lobbies per address or log length, and authentication beyond knowing the code.
- Persistence. Lobbies live in memory and are gone when the relay restarts, or ten minutes after the last person leaves.
- Presence (playheads, selections). It will not go in the ordered log (ADR-0005) and needs its own unordered message.
- More than one relay process.
