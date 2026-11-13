// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Transfers through a real relay over real sockets on this machine. The
 * measurement between two homes is manual; see README.md.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ContentId,
  encodeChunk,
  fetchSample,
  type ProgressEvent,
  SampleServer,
  type TransferMessage,
} from '../src';
import { type RelayClient, setup, sleep, until } from './helpers';

type Setup = Awaited<ReturnType<typeof setup>>;
let world: Setup;
afterEach(() => world?.dispose());

/** Serve the given files from the sender's side, by content id. */
const serve = (client: RelayClient, files: Record<ContentId, string>, options: ConstructorParameters<typeof SampleServer>[2] = {}) =>
  new SampleServer(client, (id) => files[id], options);

const small = { chunkBytes: 16 * 1024, windowBytes: 128 * 1024 };

describe('a transfer between two people', () => {
  it('moves a file in chunks through the relay and stores it under its content id', async () => {
    world = await setup();
    const { path, id, data } = await world.sample('kick.wav', 3 * 1024 * 1024 + 123);
    serve(world.sender, { [id]: path }, small);

    const result = await fetchSample(world.receiver, { id, from: 'p1', dir: world.project });

    expect(result).toMatchObject({ path: join(world.project, id), size: data.length, resumedFrom: 0, received: data.length, rerequests: 0 });
    expect(readFileSync(result.path).equals(data)).toBe(true);
    expect(readdirSync(world.project)).toEqual([id]);
  });

  it('moves a file with the default delay-based window', async () => {
    world = await setup();
    const { path, id, data } = await world.sample('snare.wav', 5 * 1024 * 1024);
    serve(world.sender, { [id]: path });
    const result = await fetchSample(world.receiver, { id, from: 'p1', dir: world.project });
    expect(readFileSync(result.path).equals(data)).toBe(true);
  });

  it('moves an empty file, and a file smaller than one chunk', async () => {
    world = await setup();
    const empty = await world.sample('empty.wav', 0);
    const tiny = await world.sample('tiny.wav', 100);
    serve(world.sender, { [empty.id]: empty.path, [tiny.id]: tiny.path }, small);

    await fetchSample(world.receiver, { id: empty.id, from: 'p1', dir: world.project });
    await fetchSample(world.receiver, { id: tiny.id, from: 'p1', dir: world.project });
    expect(statSync(join(world.project, empty.id)).size).toBe(0);
    expect(readFileSync(join(world.project, tiny.id)).equals(tiny.data)).toBe(true);
  });

  it('never sends more than the window ahead of what the receiver has acknowledged', async () => {
    world = await setup();
    const { path, id } = await world.sample('pad.wav', 4 * 1024 * 1024);
    serve(world.sender, { [id]: path }, small);

    // A receiver that asks and then never acknowledges anything.
    let bytes = 0;
    world.receiver.onBinary((_from, payload) => (bytes += payload.length - 44));
    world.receiver.sendDirect('p1', { t: 'want', id, offset: 0, gen: 1 } satisfies TransferMessage);
    await until(() => bytes > 0, 'the first chunk arrived');
    await sleep(300);
    expect(bytes).toBe(small.windowBytes);
  });

  it('sends nothing that names a file on the sender’s machine', async () => {
    world = await setup();
    const { path, id } = await world.sample('secret-folder-name.wav', 200_000);
    serve(world.sender, { [id]: path }, small);
    const seen: string[] = [];
    world.receiver.onMessage((message) => seen.push(JSON.stringify(message)));
    world.receiver.onBinary((_from, payload) => seen.push(payload.subarray(0, 44).toString('latin1')));

    await fetchSample(world.receiver, { id, from: 'p1', dir: world.project });
    expect(seen.length).toBeGreaterThan(0);
    for (const frame of seen) {
      expect(frame).not.toContain('secret-folder-name');
      expect(frame).not.toContain(world.library);
    }
  });

  it('is done at once when the file is already there and intact', async () => {
    world = await setup();
    const { path, id, data } = await world.sample('snare.wav', 50_000);
    serve(world.sender, { [id]: path }, small);
    await fetchSample(world.receiver, { id, from: 'p1', dir: world.project });

    const again = await fetchSample(world.receiver, { id, from: 'p1', dir: world.project });
    expect(again).toMatchObject({ resumedFrom: data.length, received: 0 });
  });
});

describe('resuming', () => {
  it('resumes from the bytes on disk after the receiver’s connection drops', async () => {
    world = await setup();
    const { path, id, data } = await world.sample('loop.wav', 4 * 1024 * 1024);
    serve(world.sender, { [id]: path }, small);

    const first = fetchSample(world.receiver, {
      id,
      from: 'p1',
      dir: world.project,
      progressIntervalMs: 0,
      onProgress: (event) => {
        if (event.bytes > data.length * 0.4) world.receiver.terminate();
      },
    });
    await expect(first).rejects.toMatchObject({ code: 'connection-closed' });
    const kept = statSync(join(world.project, `${id}.part`)).size;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(data.length);

    // Back on a new connection, with a new client id, as a person whose network came back would be.
    await until(() => world.server.stats().members === 1, 'the relay noticed the drop');
    const again = await world.connect();
    await again.join(world.code);
    const result = await fetchSample(again, { id, from: 'p1', dir: world.project });
    expect(result).toMatchObject({ resumedFrom: kept, received: data.length - kept });
    expect(readFileSync(result.path).equals(data)).toBe(true);
    expect(existsSync(join(world.project, `${id}.part`))).toBe(false);
  });

  it('resumes from whoever has the sample after the sender’s connection drops', async () => {
    world = await setup();
    const { path, id, data } = await world.sample('vox.wav', 4 * 1024 * 1024);
    serve(world.sender, { [id]: path }, {
      ...small,
      progressIntervalMs: 0,
      onProgress: (_peer, event) => {
        if (event.bytes > data.length / 2) world.sender.terminate();
      },
    });
    await expect(fetchSample(world.receiver, { id, from: 'p1', dir: world.project })).rejects.toMatchObject({ code: 'source-left' });

    const back = await world.connect();
    const { clientId } = await back.join(world.code);
    serve(back, { [id]: path }, small);
    const result = await fetchSample(world.receiver, { id, from: clientId, dir: world.project });
    expect(result.resumedFrom).toBeGreaterThan(0);
    expect(readFileSync(result.path).equals(data)).toBe(true);
  });

  it('survives being dropped many times in one transfer', async () => {
    world = await setup();
    const { path, id, data } = await world.sample('long.wav', 6 * 1024 * 1024);
    serve(world.sender, { [id]: path }, small);

    let client = world.receiver;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const current = client;
      let startedAt: number | undefined;
      try {
        await fetchSample(current, {
          id,
          from: 'p1',
          dir: world.project,
          progressIntervalMs: 0,
          onProgress: (event) => {
            startedAt ??= event.bytes;
            if (event.bytes - startedAt > 700 * 1024) current.terminate();
          },
        });
        break;
      } catch (error) {
        expect(error).toMatchObject({ code: 'connection-closed' });
      }
      await until(() => world.server.stats().members === 1, 'the relay noticed the drop');
      client = await world.connect();
      await client.join(world.code);
    }
    expect(attempts).toBeGreaterThan(5);
    expect(readFileSync(join(world.project, id)).equals(data)).toBe(true);
  });

  it('starts again from nothing when the partial file is longer than the sample', async () => {
    world = await setup();
    const { path, id, data } = await world.sample('hat.wav', 100_000);
    mkdirSync(world.project, { recursive: true });
    writeFileSync(join(world.project, `${id}.part`), Buffer.alloc(200_000, 7), { flag: 'w' });
    serve(world.sender, { [id]: path }, small);
    const result = await fetchSample(world.receiver, { id, from: 'p1', dir: world.project });
    expect(readFileSync(result.path).equals(data)).toBe(true);
  });

  it('asks again from the first missing byte when frames are lost', async () => {
    world = await setup();
    const { path, id, data } = await world.sample('lossy.wav', 1024 * 1024);
    serve(world.sender, { [id]: path }, small);

    // Lose the 3rd frame and the very last one. The first shows up as a gap; the
    // last leaves no gap behind it, so only the stall timer can notice.
    const lastOffset = data.length - small.chunkBytes;
    let frames = 0;
    let droppedLast = false;
    const lossy: RelayClient = Object.create(world.receiver);
    lossy.onBinary = (listener) =>
      world.receiver.onBinary((from, payload) => {
        frames += 1;
        if (frames === 3) return;
        if (!droppedLast && payload.readBigUInt64BE(36) === BigInt(lastOffset)) {
          droppedLast = true;
          return;
        }
        listener(from, payload);
      });

    const result = await fetchSample(lossy, { id, from: 'p1', dir: world.project, stallMs: 200 });
    expect(droppedLast).toBe(true);
    expect(result.rerequests).toBeGreaterThanOrEqual(2);
    expect(readFileSync(result.path).equals(data)).toBe(true);
  });
});

describe('verification', () => {
  it('rejects a file whose bytes do not match its content id, and keeps nothing', async () => {
    world = await setup();
    const real = await world.sample('real.wav', 300_000);
    const other = await world.sample('other.wav', 300_000);
    // A sender that answers for one id with another file's bytes.
    serve(world.sender, { [real.id]: other.path }, small);

    await expect(fetchSample(world.receiver, { id: real.id, from: 'p1', dir: world.project })).rejects.toMatchObject({ code: 'hash-mismatch' });
    expect(readdirSync(world.project)).toEqual([]);
  });

  it('catches damage to the partial file between attempts', async () => {
    world = await setup();
    const { path, id, data } = await world.sample('bass.wav', 2 * 1024 * 1024);
    serve(world.sender, { [id]: path }, small);
    await expect(
      fetchSample(world.receiver, {
        id,
        from: 'p1',
        dir: world.project,
        progressIntervalMs: 0,
        onProgress: (event) => {
          if (event.bytes > data.length / 2) world.receiver.terminate();
        },
      }),
    ).rejects.toMatchObject({ code: 'connection-closed' });
    const part = join(world.project, `${id}.part`);
    const damaged = readFileSync(part);
    damaged[10] = (damaged[10] ?? 0) ^ 0xff;
    writeFileSync(part, damaged);

    const again = await world.connect();
    await again.join(world.code);
    await expect(fetchSample(again, { id, from: 'p1', dir: world.project })).rejects.toMatchObject({ code: 'hash-mismatch' });
    expect(existsSync(part)).toBe(false);
    // And a clean retry then succeeds.
    const result = await fetchSample(again, { id, from: 'p1', dir: world.project });
    expect(readFileSync(result.path).equals(data)).toBe(true);
  });

  it('refuses a sender that sends more than it announced', async () => {
    world = await setup();
    const id = 'a'.repeat(64);
    world.sender.onMessage((message) => {
      if (message.type !== 'direct') return;
      const want = message.data as { t: string; gen: number };
      if (want.t !== 'want') return;
      world.sender.sendDirect('p2', { t: 'have', id, size: 10, gen: want.gen } satisfies TransferMessage);
      world.sender.sendBinary('p2', encodeChunk(id, want.gen, 0, Buffer.alloc(20)));
    });
    await expect(fetchSample(world.receiver, { id, from: 'p1', dir: world.project })).rejects.toMatchObject({ code: 'too-large' });
  });

  it('says so when the member asked does not have the sample', async () => {
    world = await setup();
    serve(world.sender, {});
    await expect(fetchSample(world.receiver, { id: 'b'.repeat(64), from: 'p1', dir: world.project })).rejects.toMatchObject({ code: 'missing' });
  });
});

describe('progress', () => {
  it('reports waiting, then transferring at a bounded rate, then verifying and done, never going backwards', async () => {
    world = await setup();
    const { path, id, data } = await world.sample('strings.wav', 8 * 1024 * 1024);
    // A small window keeps the transfer slow enough on one machine to see many updates.
    serve(world.sender, { [id]: path }, { chunkBytes: 8 * 1024, windowBytes: 16 * 1024 });

    const events: (ProgressEvent & { at: number })[] = [];
    await fetchSample(world.receiver, {
      id,
      from: 'p1',
      dir: world.project,
      progressIntervalMs: 50,
      onProgress: (event) => events.push({ ...event, at: performance.now() }),
    });

    const states = events.map((event) => event.state).filter((state, i, all) => state !== all[i - 1]);
    expect(states).toEqual(['waiting', 'transferring', 'verifying', 'done']);
    const transferring = events.filter((event) => event.state === 'transferring');
    expect(transferring.length).toBeGreaterThan(3);
    for (let i = 1; i < transferring.length; i += 1) {
      const [before, after] = [transferring[i - 1], transferring[i]];
      if (before === undefined || after === undefined) continue;
      // Node's timers round to whole milliseconds, so allow a little early.
      expect(after.at - before.at).toBeGreaterThanOrEqual(45);
      expect(after.bytes).toBeGreaterThanOrEqual(before.bytes);
    }
    expect(events.at(-1)).toMatchObject({ state: 'done', bytes: data.length, size: data.length });
    expect(transferring.some((event) => event.bytesPerSecond > 0)).toBe(true);
  });

  it('reports the upload side too, by what the receiver has acknowledged', async () => {
    world = await setup();
    const { path, id, data } = await world.sample('upload.wav', 1024 * 1024);
    const events: ProgressEvent[] = [];
    serve(world.sender, { [id]: path }, { ...small, onProgress: (_peer, event) => events.push(event) });
    await fetchSample(world.receiver, { id, from: 'p1', dir: world.project });
    await until(() => events.at(-1)?.state === 'done', 'the upload finished');
    expect(events.at(-1)).toMatchObject({ bytes: data.length, size: data.length });
  });
});
