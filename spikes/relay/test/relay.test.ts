// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET,
  formatCode,
  RelayClient,
  type RelayServer,
  type RelayServerOptions,
  startRelayServer,
} from '../src';
import { isType, until, untilLog } from './helpers';

let server: RelayServer;
const start = async (options: RelayServerOptions = {}) => {
  await server?.close();
  server = await startRelayServer({ port: 0, host: '127.0.0.1', ...options });
};
beforeEach(() => start());
afterEach(() => server.close());

const connect = () => RelayClient.connect(server.url, { allowInsecure: true });

/** A has created a lobby and B has joined it. */
const lobby = async () => {
  const a = await connect();
  const { code } = await a.create();
  const b = await connect();
  await b.join(code);
  return { a, b, code };
};

describe('lobbies and invite codes', () => {
  it('creates a lobby with a six-character invite code and admits its creator', async () => {
    const a = await connect();
    const welcome = await a.create();
    expect(welcome.code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{6}$`));
    expect(welcome).toMatchObject({ clientId: 'p1', peers: [], log: [] });
  });

  it('gives every lobby its own code', async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i += 1) codes.add((await (await connect()).create()).code);
    expect(codes.size).toBe(20);
  });

  it('lets a second person join with the code, however they type it, and tells the first', async () => {
    const a = await connect();
    const { code } = await a.create();
    const joined = a.waitFor(isType('peer-joined'));
    const b = await connect();
    const welcome = await b.join(` ${formatCode(code).toLowerCase()} `);
    expect(welcome).toMatchObject({ code, clientId: 'p2', peers: ['p1'] });
    expect((await joined).clientId).toBe('p2');
  });

  it('turns a third person away while two are connected, and lets them in once someone leaves', async () => {
    const { a, b, code } = await lobby();
    const c = await connect();
    await expect(c.join(code)).rejects.toMatchObject({ code: 'room-full' });

    const left = a.waitFor(isType('peer-left'));
    await b.close();
    expect((await left).clientId).toBe('p2');
    await expect(c.join(code)).resolves.toMatchObject({ clientId: 'p3', peers: ['p1'] });
  });

  it('rejects a code that no lobby has', async () => {
    const a = await connect();
    await expect(a.join('ZZZZZZ')).rejects.toMatchObject({ code: 'unknown-room' });
  });

  it('keeps an empty lobby and its log for a while, then forgets it', async () => {
    await start({ emptyRoomTtlMs: 300 });
    const a = await connect();
    const { code } = await a.create();
    a.sendOp('p1:1', 'kept');
    await untilLog(a, 1);
    await a.close();

    const b = await connect();
    const welcome = await b.join(code);
    expect(welcome.log.map((op) => op.op)).toEqual(['kept']);
    await b.close();

    await new Promise((resolve) => setTimeout(resolve, 450));
    await expect((await connect()).join(code)).rejects.toMatchObject({ code: 'unknown-room' });
    expect(server.stats().rooms).toBe(0);
  });
});

describe('ordering', () => {
  it('orders both people’s operations into one sequence and sends all of it to both, sender included', async () => {
    const { a, b } = await lobby();
    for (let i = 1; i <= 20; i += 1) {
      a.sendOp(`p1:${i}`, { from: 'a', i });
      b.sendOp(`p2:${i}`, { from: 'b', i });
    }
    await untilLog(a, 40);
    await untilLog(b, 40);
    expect(a.log.map((op) => op.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(b.log).toEqual(a.log);
    // Each person's own operations stay in the order they sent them.
    for (const [who, id] of [['a', 'p1'], ['b', 'p2']] as const) {
      const mine = a.log.filter((op) => op.clientId === id).map((op) => (op.op as { from: string; i: number }).i);
      expect(mine).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(a.log.filter((op) => (op.op as { from: string }).from === who).every((op) => op.clientId === id)).toBe(true);
    }
  });

  it('stamps the sender itself, so nobody can send an operation as someone else', async () => {
    const { a, b } = await lobby();
    a.sendRaw(JSON.stringify({ type: 'op', opId: 'forged', clientId: 'p2', seq: 99, op: 1 }));
    await untilLog(b, 1);
    expect(b.log[0]).toEqual({ seq: 1, opId: 'forged', clientId: 'p1', op: 1 });
  });

  it('passes operations through untouched, whatever they contain', async () => {
    const { a, b } = await lobby();
    const ops: unknown[] = [
      { type: 'clip.move', id: 'k1', trackId: 't1', start: 24 },
      { nested: { deeply: [1, 'two', { three: null }] }, unicode: 'Ünïcødé 🎛️' },
      [1, 2, 3],
      'a string',
      42.5,
      null,
      false,
    ];
    ops.forEach((op, i) => a.sendOp(`p1:${i}`, op));
    await untilLog(b, ops.length);
    expect(b.log.map((op) => op.op)).toEqual(ops);
  });

  it('does not order the same operation id twice', async () => {
    const { a, b } = await lobby();
    const refused = a.waitFor(isType('error'));
    a.sendOp('p1:1', 'first');
    a.sendOp('p1:1', 'resent');
    b.sendOp('p1:1', 'from someone else');
    expect((await refused).code).toBe('duplicate-op');
    b.sendOp('p2:1', 'next');
    await untilLog(a, 2);
    expect(a.log.map((op) => op.op)).toEqual(['first', 'next']);
  });
});

describe('catching up', () => {
  it('sends a late joiner the whole log, then carries on from where it ends', async () => {
    const a = await connect();
    const { code } = await a.create();
    for (let i = 1; i <= 50; i += 1) a.sendOp(`p1:${i}`, i);
    await untilLog(a, 50);

    const b = await connect();
    const welcome = await b.join(code);
    expect(welcome.log).toEqual(a.log);

    b.sendOp('p2:1', 'after');
    await untilLog(a, 51);
    expect(b.log).toEqual(a.log);
    expect(a.log[50]).toMatchObject({ seq: 51, clientId: 'p2', op: 'after' });
  });

  it('misses nothing sent while the joiner was being let in', async () => {
    const a = await connect();
    const { code } = await a.create();
    const b = await connect();
    // A keeps sending while B's join is in flight.
    const sending = (async () => {
      for (let i = 1; i <= 200; i += 1) {
        a.sendOp(`p1:${i}`, i);
        if (i % 10 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    await b.join(code);
    await sending;
    await untilLog(a, 200);
    await untilLog(b, 200);
    expect(b.log).toEqual(a.log);
  });
});

describe('direct messages and binary frames', () => {
  it('passes a direct message to one member, stamped with its sender, and keeps it out of the log', async () => {
    const { a, b } = await lobby();
    const arrived = b.waitFor(isType('direct'));
    a.sendRaw(JSON.stringify({ type: 'direct', to: 'p2', from: 'p2', data: { want: 'abc', offset: 7 } }));
    expect(await arrived).toEqual({ type: 'direct', from: 'p1', data: { want: 'abc', offset: 7 } });
    a.sendOp('p1:1', 'edit');
    await untilLog(b, 1);
    expect(b.log.map((op) => op.op)).toEqual(['edit']);
  });

  it('passes binary frames through byte for byte, in order, stamped with their sender', async () => {
    const { a, b } = await lobby();
    const received: Buffer[] = [];
    b.onBinary((from, payload) => {
      expect(from).toBe('p1');
      received.push(Buffer.from(payload));
    });
    const sent = Array.from({ length: 30 }, (_, i) => Buffer.alloc(1_000 + i * 997, i));
    for (const payload of sent) a.sendBinary('p2', payload);
    await until(() => received.length === sent.length, 'every frame arrived');
    expect(received).toEqual(sent);
  });

  it('refuses direct and binary traffic for a member who is not connected, or from someone not in a lobby', async () => {
    const { a, b } = await lobby();
    const errors: string[] = [];
    a.onMessage((message) => {
      if (message.type === 'error') errors.push(message.code);
    });
    a.sendDirect('p9', 'hello');
    a.sendBinary('p9', Buffer.from([1, 2, 3]));
    await until(() => errors.length === 2, 'two errors arrived');
    expect(errors).toEqual(['unknown-peer', 'unknown-peer']);

    const outsider = await connect();
    const refused = outsider.waitFor(isType('error'));
    outsider.sendBinary('p2', Buffer.from([1]));
    expect((await refused).code).toBe('not-joined');
    await b.close();
  });

  it('drops binary frames for a member it already holds too much for, and says so', async () => {
    await start({ maxBufferedBytes: 0 });
    const { a, b } = await lobby();
    // Stop B reading so the relay's buffer towards B fills up.
    const errors: string[] = [];
    a.onMessage((message) => {
      if (message.type === 'error') errors.push(message.code);
    });
    (b as unknown as { socket: { pause(): void } }).socket.pause();
    for (let i = 0; i < 200 && errors.length === 0; i += 1) {
      a.sendBinary('p2', Buffer.alloc(512 * 1024));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await until(() => errors.length > 0, 'the relay refused a frame');
    expect(errors[0]).toBe('peer-busy');
  });
});

describe('robustness', () => {
  it('answers malformed or out-of-turn messages with an error and keeps working', async () => {
    const a = await connect();
    const errors: string[] = [];
    a.onMessage((message) => {
      if (message.type === 'error') errors.push(message.code);
    });
    a.sendRaw('not json');
    a.sendRaw(JSON.stringify({ type: 'teleport' }));
    a.sendRaw(JSON.stringify({ type: 'op', opId: '', op: 1 }));
    a.sendOp('p1:1', 'too early');
    await until(() => errors.length === 4, 'four errors arrived');
    expect(errors).toEqual(['bad-message', 'bad-message', 'bad-message', 'not-joined']);

    await a.create();
    await expect(a.join('ABCDEF')).rejects.toMatchObject({ code: 'already-joined' });
    a.sendOp('p1:1', 'fine now');
    await untilLog(a, 1);
  });

  it('answers ping outside the log', async () => {
    const { a, b } = await lobby();
    const rtt = await a.ping();
    expect(rtt).toBeGreaterThanOrEqual(0);
    expect(rtt).toBeLessThan(1_000);
    expect(b.log).toHaveLength(0);
  });

  it('serves a health check over plain HTTP', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok\n');
  });

  it('refuses an unencrypted URL unless told this is local testing', async () => {
    await expect(RelayClient.connect(server.url)).rejects.toThrow(/refusing unencrypted/);
  });
});
