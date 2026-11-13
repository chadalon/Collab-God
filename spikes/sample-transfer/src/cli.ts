// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Measure a sample transfer between two locations, through a relay.
 *
 *   npm run transfer -- share wss://relay.example.com [--size-mb 200 | --file kick.wav] [--where "Chapel Hill"]
 *   npm run transfer -- fetch wss://relay.example.com K7M-QX4 [--drop-at-mb 50] [--where "Park City"]
 *
 * `share` creates a lobby, prints its invite code and offers one file: a real
 * one with --file, or random bytes with --size-mb. `fetch` joins and fetches it,
 * with a progress bar, then both print one report. With --drop-at-mb the fetcher
 * cuts its own connection part way through, reconnects and resumes, which is the
 * real-network check of resuming.
 *
 * Both sides ping the relay four times a second throughout. Pings travel on the
 * same connection as the chunks, so the pings during the transfer show how much
 * an edit sent at that moment would be held up behind sample data.
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { type ConnectOptions, RelayClient, type TlsDetails } from '../../relay/src/client';
import { formatCode } from '../../relay/src/protocol';
import { type ProgressEvent } from './progress';
import { type ContentId, contentIdOfFile, DEFAULT_CHUNK_BYTES, isContentId } from './protocol';
import { fetchSample, type FetchResult, TransferError } from './receiver';
import { SampleServer } from './sender';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: 'string' },
    'size-mb': { type: 'string', default: '100' },
    'chunk-kib': { type: 'string', default: String(DEFAULT_CHUNK_BYTES / 1024) },
    'window-kib': { type: 'string', default: 'auto' },
    'target-ms': { type: 'string', default: '25' },
    'drop-at-mb': { type: 'string' },
    dir: { type: 'string' },
    keep: { type: 'boolean', default: false },
    where: { type: 'string' },
    ca: { type: 'string' },
    insecure: { type: 'boolean', default: false },
  },
});

const [command, ...rest] = positionals;
const MB = 1_000_000;
const MiB = 1024 * 1024;

/** Messages between the two CLI processes, outside the transfer protocol. */
type CliMessage =
  | { readonly cli: 'offer'; readonly id: ContentId; readonly size: number; readonly chunkBytes: number; readonly window: string } | { readonly cli: 'report'; readonly report: string };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const connectOptions = (): ConnectOptions => ({
  allowInsecure: values.insecure,
  ...(values.ca === undefined ? {} : { ca: readFileSync(values.ca) }),
});

function describeTls(tls: TlsDetails | undefined): string {
  if (tls === undefined) return 'NOT ENCRYPTED (plain ws://)';
  return `${tls.protocol ?? '?'}, ${tls.cipher}, certificate for ${tls.subject ?? '?'} ${tls.authorized ? 'verified' : 'NOT verified'}`;
}

function summarise(samples: readonly number[]): string {
  if (samples.length === 0) return '| no samples | | | |';
  const sorted = [...samples].sort((x, y) => x - y);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
  return `| ${sorted.length} | ${at(0.5).toFixed(1)} ms | ${at(0.95).toFixed(1)} ms | ${(sorted.at(-1) ?? Number.NaN).toFixed(1)} ms |`;
}

const median = (samples: readonly number[]) => [...samples].sort((x, y) => x - y)[Math.floor(samples.length / 2)] ?? Number.NaN;

const rate = (bytes: number, ms: number) => (ms <= 0 ? 'n/a' : `${((bytes / MB) / (ms / 1000)).toFixed(2)} MB/s (${((bytes * 8) / MB / (ms / 1000)).toFixed(1)} Mbit/s)`);

/** Ping the relay every 250 ms, filing each sample under whatever `phase()` says at the time. */
function pinger(client: RelayClient, phase: () => string) {
  const samples = new Map<string, number[]>();
  let stopped = false;
  void (async () => {
    while (!stopped && client.open) {
      const label = phase();
      try {
        const rtt = await client.ping(10_000);
        if (!samples.has(label)) samples.set(label, []);
        samples.get(label)?.push(rtt);
      } catch {
        // A ping lost to a dropped connection is not a sample.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  })();
  return {
    samples,
    stop: () => {
      stopped = true;
    },
  };
}

function bar(event: ProgressEvent): string {
  const size = event.size ?? 0;
  const fraction = size === 0 ? 0 : event.bytes / size;
  const width = 30;
  const filled = Math.round(fraction * width);
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}] ${(fraction * 100).toFixed(1).padStart(5)}%  ${(event.bytes / MiB).toFixed(1)}/${(size / MiB).toFixed(1)} MiB  ${(event.bytesPerSecond / MB).toFixed(2)} MB/s  ${event.state}`;
}

async function makeRandomFile(sizeMb: number): Promise<string> {
  const dir = join(tmpdir(), 'collabgod-transfer');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `random-${sizeMb}mb-${process.pid}.bin`);
  const out = createWriteStream(path);
  let left = Math.round(sizeMb * MB);
  while (left > 0) {
    const n = Math.min(left, 4 * MiB);
    if (!out.write(randomBytes(n))) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
    left -= n;
  }
  await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
  return path;
}

async function share(url: string): Promise<void> {
  const generated = values.file === undefined;
  const path = values.file ?? (await makeRandomFile(Number(values['size-mb'])));
  const size = statSync(path).size;
  const hashStart = performance.now();
  const id = await contentIdOfFile(path);
  const hashMs = performance.now() - hashStart;

  const client = await RelayClient.connect(url, connectOptions());
  const tls = describeTls(client.tls);
  const { code } = await client.create();
  console.log(`Connected to ${url}\nTLS: ${tls}`);
  console.log(`Offering ${(size / MiB).toFixed(1)} MiB, content id ${id.slice(0, 16)}… (hashed in ${hashMs.toFixed(0)} ms, ${rate(size, hashMs)})`);
  console.log(`\nInvite code: ${formatCode(code)}\nOn the other machine: npm run transfer -- fetch ${url} ${formatCode(code)}\n`);

  let uploadStart: number | undefined;
  let uploadEnd: number | undefined;
  const chunkBytes = Number(values['chunk-kib']) * 1024;
  const fixed = values['window-kib'] === 'auto' ? undefined : Number(values['window-kib']) * 1024;
  const window = fixed === undefined ? `a delay-based window aiming at ${values['target-ms']} ms of queueing` : `a fixed window of ${fixed / 1024} KiB`;
  const windowSamples: number[] = [];
  const server = new SampleServer(client, (wanted) => (wanted === id ? path : undefined), {
    chunkBytes,
    ...(fixed === undefined ? { targetDelayMs: Number(values['target-ms']) } : { windowBytes: fixed }),
    onProgress: (_peer, event) => {
      for (const stream of server.windows()) windowSamples.push(stream.bytes);
      if (event.state === 'transferring') uploadStart ??= performance.now();
      if (event.state === 'done') uploadEnd = performance.now();
      process.stderr.write(`\rSending   ${bar(event)}   `);
    },
  });
  const pings = pinger(client, () => (server.active > 0 ? 'during' : uploadStart === undefined ? 'before' : 'after'));

  const report = await new Promise<string>((resolve) => {
    client.onMessage((message) => {
      if (message.type === 'peer-joined') {
        console.log(`${message.clientId} joined.`);
        client.sendDirect(message.clientId, { cli: 'offer', id, size, chunkBytes, window } satisfies CliMessage);
      } else if (message.type === 'peer-left') {
        console.log(`\n${message.clientId} left.`);
      } else if (message.type === 'direct' && (message.data as CliMessage).cli === 'report') {
        resolve((message.data as Extract<CliMessage, { cli: 'report' }>).report);
      }
    });
  });
  pings.stop();
  server.stop();

  const mine = [
    `- Sharer${values.where === undefined ? '' : ` (${values.where})`}: TLS ${tls}`,
    `- Upload, first request to last acknowledgement: ${uploadStart !== undefined && uploadEnd !== undefined ? `${((uploadEnd - uploadStart) / 1000).toFixed(1)} s, ${rate(size, uploadEnd - uploadStart)}` : 'n/a'}`,
    `- Hashing the file here: ${hashMs.toFixed(0)} ms, ${rate(size, hashMs)}`,
    `- Window while sending: ${windowSamples.length === 0 ? 'n/a' : `median ${(median(windowSamples) / 1024).toFixed(0)} KiB, largest ${(Math.max(...windowSamples) / 1024).toFixed(0)} KiB`}`,
    '',
    '| Sharer to relay and back (ping) | Samples | Median | 95th | Max |',
    '| --- | --- | --- | --- | --- |',
    ...['before', 'during', 'after'].map((phase) => `| ${phase} the transfer ${summarise(pings.samples.get(phase) ?? [])}`),
  ].join('\n');
  console.log(`\n\n${report}\n\n${mine}\n`);
  if (generated) rmSync(path, { force: true });
  await client.close();
}

async function fetch(url: string, code: string): Promise<void> {
  const dir = values.dir ?? join(tmpdir(), 'collabgod-received');
  const dropAt = values['drop-at-mb'] === undefined ? undefined : Number(values['drop-at-mb']) * MB;

  let client = await RelayClient.connect(url, connectOptions());
  const tls = describeTls(client.tls);
  console.log(`Connected to ${url}\nTLS: ${tls}`);
  const offered = client.waitFor(
    (message): message is Extract<typeof message, { type: 'direct' }> =>
      message.type === 'direct' && (message.data as CliMessage).cli === 'offer',
    30_000,
  );
  const welcome = await client.join(code);
  const offer = (await offered).data as Extract<CliMessage, { cli: 'offer' }>;
  if (!isContentId(offer.id)) fail('The sharer offered something that is not a content id.');
  let source = (await offered).from;
  console.log(`Joined lobby ${formatCode(welcome.code)}. ${source} offers ${(offer.size / MiB).toFixed(1)} MiB.`);
  console.log('Measuring the idle connection for 3 seconds first.');

  let phase = 'before';
  let pings = pinger(client, () => phase);
  const allPings = new Map<string, number[]>();
  const keepPings = () => {
    for (const [label, samples] of pings.samples) allPings.set(label, [...(allPings.get(label) ?? []), ...samples]);
    pings.stop();
  };
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  let events = 0;
  let firstByteAt: number | undefined;
  const start = performance.now();
  let dropped = false;
  let reconnectMs: number | undefined;
  let result: FetchResult | undefined;
  let attempts = 0;
  const resumes: number[] = [];
  phase = 'during';

  while (result === undefined) {
    attempts += 1;
    const current = client;
    try {
      result = await fetchSample(current, {
        id: offer.id,
        from: source,
        dir,
        onProgress: (event) => {
          events += 1;
          if (event.bytes > 0) firstByteAt ??= performance.now();
          process.stderr.write(`\rReceiving ${bar(event)}   `);
          if (dropAt !== undefined && !dropped && event.bytes >= dropAt) {
            dropped = true;
            process.stderr.write('\nCutting the connection on purpose (--drop-at-mb).\n');
            current.terminate();
          }
        },
      });
      if (result.resumedFrom > 0) resumes.push(result.resumedFrom);
    } catch (error) {
      if (!(error instanceof TransferError) || (error.code !== 'connection-closed' && error.code !== 'source-left') || attempts > 20) throw error;
      process.stderr.write(`\n${error.message}. Reconnecting and resuming.\n`);
      keepPings();
      const reconnectStart = performance.now();
      if (error.code === 'connection-closed') {
        client = await RelayClient.connect(url, connectOptions());
        const rejoined = await client.join(code);
        source = rejoined.peers[0] ?? source;
      } else {
        const joined = await client.waitFor((message): message is Extract<typeof message, { type: 'peer-joined' }> => message.type === 'peer-joined', 120_000);
        source = joined.clientId;
      }
      reconnectMs = (reconnectMs ?? 0) + (performance.now() - reconnectStart);
      pings = pinger(client, () => phase);
    }
  }
  const totalMs = performance.now() - start;
  phase = 'after';
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  keepPings();
  if (!values.keep) rmSync(result.path, { force: true });

  const transferMs = totalMs - (reconnectMs ?? 0);
  const report = [
    `## Sample transfer, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `- Fetcher${values.where === undefined ? '' : ` (${values.where})`}: TLS ${tls}`,
    `- ${(offer.size / MiB).toFixed(1)} MiB in chunks of ${offer.chunkBytes / 1024} KiB with ${offer.window}`,
    `- Verified against its content hash: yes`,
    `- Wall time, request to verified file: ${(totalMs / 1000).toFixed(1)} s. Time to first byte: ${firstByteAt === undefined ? 'n/a' : `${(firstByteAt - start).toFixed(0)} ms`}`,
    `- Throughput, not counting time spent reconnecting: ${rate(offer.size, transferMs)}`,
    dropAt === undefined
      ? '- No deliberate drop (run again with --drop-at-mb to check resuming)'
      : `- Deliberate drop at ${(dropAt / MB).toFixed(0)} MB: ${attempts} attempt(s), reconnect and rejoin took ${reconnectMs?.toFixed(0) ?? 'n/a'} ms, last attempt resumed from ${resumes.length > 0 ? `${((resumes.at(-1) ?? 0) / MiB).toFixed(1)} MiB` : 'nothing'}`,
    `- Re-requests after a gap or stall: ${result.rerequests}`,
    `- Progress events: ${events} over ${(totalMs / 1000).toFixed(1)} s, ${(events / (totalMs / 1000)).toFixed(1)} a second`,
    '',
    '| Fetcher to relay and back (ping) | Samples | Median | 95th | Max |',
    '| --- | --- | --- | --- | --- |',
    ...['before', 'during', 'after'].map((label) => `| ${label} the transfer ${summarise(allPings.get(label) ?? [])}`),
  ].join('\n');
  client.sendDirect(source, { cli: 'report', report } satisfies CliMessage);
  console.log(`\n\n${report}\n`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await client.close();
}

const usage = `Usage:
  npm run transfer -- share <wss-url> [--size-mb 100 | --file path] [--chunk-kib 64] [--window-kib auto | N] [--target-ms 25] [--where "place"]
  npm run transfer -- fetch <wss-url> <invite-code> [--drop-at-mb N] [--dir folder] [--keep] [--where "place"]
Add --insecure to allow ws:// for a test on one machine, or --ca ca.pem to trust a self-signed relay.`;

try {
  if (command === 'share' && rest[0] !== undefined) await share(rest[0]);
  else if (command === 'fetch' && rest[0] !== undefined && rest[1] !== undefined) await fetch(rest[0], rest[1]);
  else fail(usage);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
