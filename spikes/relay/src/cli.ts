// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Run a relay, or run the two-location test against one.
 *
 *   npm run relay -- serve [--port 8080] [--host 0.0.0.0] [--cert cert.pem --key key.pem]
 *   npm run relay -- host wss://relay.example.com [--probes 200] [--interval-ms 100] [--where "Chapel Hill"]
 *   npm run relay -- join wss://relay.example.com K7M-QX4 [--where "..."]
 *
 * `host` creates a lobby and prints its invite code. `join` joins it. Then the
 * host sends numbered probe operations through the relay, the joiner answers each
 * one with an operation of its own the moment it arrives, and both print the
 * timings. Probes are ordinary operations: the relay cannot tell them from edits.
 */

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { type ConnectOptions, RelayClient, type TlsDetails } from './client';
import { formatCode, type WireSequenced } from './protocol';
import { startRelayServer } from './server';

type TestOp =
  | { readonly kind: 'hello'; readonly n: number }
  | { readonly kind: 'ready'; readonly caughtUp: number }
  | { readonly kind: 'probe'; readonly n: number }
  | { readonly kind: 'reply'; readonly n: number }
  | { readonly kind: 'done'; readonly report: string };

const HELLO_COUNT = 3;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: '8080' },
    host: { type: 'string' },
    cert: { type: 'string' },
    key: { type: 'string' },
    'ttl-minutes': { type: 'string', default: '10' },
    ca: { type: 'string' },
    insecure: { type: 'boolean', default: false },
    probes: { type: 'string', default: '200' },
    'interval-ms': { type: 'string', default: '100' },
    where: { type: 'string' },
  },
});

const [command, ...rest] = positionals;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function connectOptions(): ConnectOptions {
  return {
    allowInsecure: values.insecure,
    ...(values.ca === undefined ? {} : { ca: readFileSync(values.ca) }),
  };
}

function describeTls(tls: TlsDetails | undefined): string {
  if (tls === undefined) return 'NOT ENCRYPTED (plain ws://)';
  return `${tls.protocol ?? '?'}, ${tls.cipher}, certificate for ${tls.subject ?? '?'} ${tls.authorized ? 'verified' : 'NOT verified'}`;
}

interface Summary {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

function summarise(samples: readonly number[]): Summary | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((x, y) => x - y);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
  return { count: sorted.length, min: sorted[0] ?? Number.NaN, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? Number.NaN };
}

const ms = (value: number) => `${value.toFixed(1)} ms`;
const row = (label: string, summary: Summary | undefined, scale = 1) =>
  summary === undefined
    ? `| ${label} | no samples | | | | |`
    : `| ${label} | ${summary.count} | ${ms(summary.min * scale)} | ${ms(summary.p50 * scale)} | ${ms(summary.p95 * scale)} | ${ms(summary.max * scale)} |`;

/** Send operations with ids this client has not used before. */
function opSender(client: RelayClient): (op: TestOp) => string {
  let n = 0;
  return (op) => {
    n += 1;
    const opId = `${client.clientId}:${n}`;
    client.sendOp(opId, op);
    return opId;
  };
}

async function relayPings(client: RelayClient, count: number): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < count; i += 1) {
    samples.push(await client.ping());
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return samples;
}

async function serve(): Promise<void> {
  if ((values.cert === undefined) !== (values.key === undefined)) fail('--cert and --key go together.');
  const server = await startRelayServer({
    port: Number(values.port),
    ...(values.host === undefined ? {} : { host: values.host }),
    ...(values.cert === undefined || values.key === undefined
      ? {}
      : { tls: { cert: readFileSync(values.cert), key: readFileSync(values.key) } }),
    emptyRoomTtlMs: Number(values['ttl-minutes']) * 60_000,
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });
  if (values.cert === undefined) {
    console.log('No --cert given: serving plain ws://. Put a TLS proxy in front of it (see README.md); clients refuse ws://.');
  }
  const stop = () => void server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function host(url: string): Promise<void> {
  const probes = Number(values.probes);
  const interval = Number(values['interval-ms']);
  const client = await RelayClient.connect(url, connectOptions());
  const tls = describeTls(client.tls);
  console.log(`Connected to ${url}\nTLS: ${tls}`);

  const welcome = await client.create();
  const send = opSender(client);
  for (let n = 1; n <= HELLO_COUNT; n += 1) send({ kind: 'hello', n });
  console.log(`\nInvite code: ${formatCode(welcome.code)}\nSend it to the other person and wait for them to join.\n`);

  const sentAt = new Map<number, number>();
  const echo: number[] = [];
  const round: number[] = [];
  let guestCaughtUp: number | undefined;
  let ready: () => void = () => {};
  const guestReady = new Promise<void>((resolve) => (ready = resolve));

  client.onOp((entry: WireSequenced) => {
    const op = entry.op as TestOp;
    const now = performance.now();
    if (op.kind === 'ready' && entry.clientId !== client.clientId) {
      guestCaughtUp = op.caughtUp;
      ready();
    } else if (op.kind === 'probe' && entry.clientId === client.clientId) {
      const t = sentAt.get(op.n);
      if (t !== undefined) echo.push(now - t);
    } else if (op.kind === 'reply') {
      const t = sentAt.get(op.n);
      if (t !== undefined) round.push(now - t);
    }
  });

  await guestReady;
  console.log(`The other person joined and caught up on ${guestCaughtUp} operation(s).`);
  console.log('Measuring round trips to the relay...');
  const pings = await relayPings(client, 20);

  console.log(`Sending ${probes} probes, one every ${interval} ms...`);
  for (let n = 1; n <= probes; n += 1) {
    sentAt.set(n, performance.now());
    send({ kind: 'probe', n });
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  const deadline = Date.now() + 10_000;
  while (round.length < probes && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));

  const roundSummary = summarise(round);
  const verdict =
    roundSummary === undefined
      ? 'no replies arrived'
      : `${roundSummary.p95 / 2 <= 150 ? 'within' : 'OVER'} the 150 ms target of NFR-1 at the 95th percentile`;
  const report = [
    `### Relay test, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `- Relay: ${new URL(url).host}`,
    `- Host${values.where === undefined ? '' : ` (${values.where})`}: TLS ${tls}`,
    `- Late join: the joiner caught up on ${guestCaughtUp} operation(s) sent before it joined (expected ${HELLO_COUNT})`,
    `- Probes: ${probes} sent, ${round.length} answered, ${probes - round.length} lost`,
    '',
    '| Path | Samples | Min | Median | 95th | Max |',
    '| --- | --- | --- | --- | --- | --- |',
    row('Host to relay and back (ping)', summarise(pings)),
    row('Host edit back to host (host → relay → host)', summarise(echo)),
    row('Host to joiner and back (host → relay → joiner → relay → host)', roundSummary),
    row('Estimated edit delay host → joiner (half the line above)', roundSummary, 0.5),
    '',
    `Estimated edit delay is ${verdict}.`,
  ].join('\n');

  send({ kind: 'done', report });
  console.log(`\n${report}\n`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await client.close();
}

async function join(url: string, code: string): Promise<void> {
  const client = await RelayClient.connect(url, connectOptions());
  const tls = describeTls(client.tls);
  console.log(`Connected to ${url}\nTLS: ${tls}`);

  const welcome = await client.join(code);
  const send = opSender(client);
  const hellos = welcome.log.filter((entry) => (entry.op as TestOp).kind === 'hello').length;
  console.log(`Joined lobby ${formatCode(welcome.code)}. Caught up on ${welcome.log.length} operation(s), ${hellos} of them the host's greetings.`);

  const sentAt = new Map<number, number>();
  const echo: number[] = [];
  let finish: (report: string) => void = () => {};
  const finished = new Promise<string>((resolve) => (finish = resolve));

  client.onOp((entry) => {
    const op = entry.op as TestOp;
    const now = performance.now();
    if (entry.clientId === client.clientId) {
      if (op.kind === 'reply') {
        const t = sentAt.get(op.n);
        if (t !== undefined) echo.push(now - t);
      }
      return;
    }
    if (op.kind === 'probe') {
      sentAt.set(op.n, performance.now());
      send({ kind: 'reply', n: op.n });
    } else if (op.kind === 'done') {
      finish(op.report);
    }
  });
  send({ kind: 'ready', caughtUp: hellos });
  console.log('Answering the host’s probes. This takes about half a minute.');

  const pings = await relayPings(client, 20);
  const report = await finished;
  const mine = [
    '',
    `- Joiner${values.where === undefined ? '' : ` (${values.where})`}: TLS ${tls}`,
    '',
    '| Path | Samples | Min | Median | 95th | Max |',
    '| --- | --- | --- | --- | --- | --- |',
    row('Joiner to relay and back (ping)', summarise(pings)),
    row('Joiner edit back to joiner (joiner → relay → joiner)', summarise(echo)),
  ].join('\n');
  console.log(`\n${report}\n${mine}\n`);
  await client.close();
}

const usage = `Usage:
  npm run relay -- serve [--port 8080] [--host 0.0.0.0] [--cert cert.pem --key key.pem] [--ttl-minutes 10]
  npm run relay -- host <wss-url> [--probes 200] [--interval-ms 100] [--where "place"] [--ca ca.pem]
  npm run relay -- join <wss-url> <invite-code> [--where "place"] [--ca ca.pem]
Add --insecure to host or join to allow ws:// for a test on one machine.`;

try {
  if (command === 'serve') await serve();
  else if (command === 'host' && rest[0] !== undefined) await host(rest[0]);
  else if (command === 'join' && rest[0] !== undefined && rest[1] !== undefined) await join(rest[0], rest[1]);
  else fail(usage);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
