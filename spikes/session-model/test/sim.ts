// SPDX-License-Identifier: GPL-3.0-or-later

import { type Envelope, type Op, Relay, Replica, type Sequenced, type SessionState } from '../src';

/**
 * An in-memory lobby: one relay, any number of replicas, and a queue in each
 * direction per client. A test decides when each message is delivered, which is
 * how arbitrary network delays are simulated. Each link keeps its own order, as
 * a WebSocket does.
 */
export class Sim {
  readonly relay = new Relay();
  readonly clients: Replica[];
  private readonly up: Envelope[][];
  private readonly down: Sequenced[][];

  constructor(clientCount: number, seed: readonly Op[] = []) {
    this.up = Array.from({ length: clientCount }, () => []);
    this.down = Array.from({ length: clientCount }, () => []);
    this.clients = this.up.map((queue, i) => new Replica(`c${i}`, (envelope) => queue.push(envelope)));
    seed.forEach((op, i) => this.broadcast({ opId: `seed:${i}`, clientId: 'seed', op }));
    this.drain();
  }

  client(i: number): Replica {
    const replica = this.clients[i % this.clients.length];
    if (replica === undefined) throw new Error('no clients');
    return replica;
  }

  /** Deliver one client's oldest unsent operation to the relay. */
  deliverUp(i: number): boolean {
    const envelope = this.up[i % this.up.length]?.shift();
    if (envelope === undefined) return false;
    this.broadcast(envelope);
    return true;
  }

  /** Deliver the oldest undelivered relay message to one client. */
  deliverDown(i: number): boolean {
    const index = i % this.down.length;
    const sequenced = this.down[index]?.shift();
    if (sequenced === undefined) return false;
    this.client(index).receive(sequenced);
    return true;
  }

  /** Deliver everything until the network is quiet. */
  drain(): void {
    let moved = true;
    while (moved) {
      moved = false;
      for (let i = 0; i < this.clients.length; i += 1) {
        while (this.deliverUp(i)) moved = true;
        while (this.deliverDown(i)) moved = true;
      }
    }
  }

  private broadcast(envelope: Envelope): void {
    const sequenced = this.relay.sequence(envelope);
    for (const queue of this.down) queue.push(sequenced);
  }
}

export type Dice = readonly [number, number, number, number];

const KINDS = [
  'clip.add',
  'clip.add',
  'clip.move',
  'clip.move',
  'clip.move',
  'clip.resize',
  'clip.resize',
  'clip.remove',
  'track.add',
  'track.remove',
  'track.rename',
] as const;

const pick = <T>(items: readonly T[], n: number): T | undefined => items[n % Math.max(items.length, 1)];

/**
 * Turn four random numbers into an operation against whatever this client can
 * currently see. Targets come from the client's own view, which may be stale;
 * that is exactly how conflicting edits arise in real use.
 */
export function randomOp(view: SessionState, [a, b, c, d]: Dice, freshId: () => string): Op | undefined {
  const kind = pick(KINDS, a);
  const trackId = pick(view.trackOrder, b);
  const clipId = pick(Object.keys(view.clips).sort(), b);
  const otherTrackId = pick(view.trackOrder, c);
  switch (kind) {
    case 'clip.add':
      return trackId === undefined
        ? undefined
        : {
            type: 'clip.add',
            clip: { id: freshId(), trackId, start: c % 64, length: 1 + (d % 16), sampleHash: `hash-${d % 5}` },
          };
    case 'clip.move':
      return clipId === undefined || otherTrackId === undefined
        ? undefined
        : { type: 'clip.move', id: clipId, trackId: otherTrackId, start: d % 64 };
    case 'clip.resize':
      return clipId === undefined ? undefined : { type: 'clip.resize', id: clipId, start: c % 64, length: 1 + (d % 16) };
    case 'clip.remove':
      return clipId === undefined ? undefined : { type: 'clip.remove', id: clipId };
    case 'track.add':
      return { type: 'track.add', track: { id: freshId(), name: `Track ${c % 10}` }, index: b % (view.trackOrder.length + 1) };
    case 'track.remove':
      return trackId === undefined ? undefined : { type: 'track.remove', id: trackId };
    case 'track.rename':
      return trackId === undefined ? undefined : { type: 'track.rename', id: trackId, name: `Renamed ${c % 10}` };
    default:
      return undefined;
  }
}

/** A small starting session, so the first random operations already have targets to fight over. */
export const SEED: readonly Op[] = [
  { type: 'track.add', track: { id: 't1', name: 'Drums' }, index: 0 },
  { type: 'track.add', track: { id: 't2', name: 'Bass' }, index: 1 },
  { type: 'clip.add', clip: { id: 'k1', trackId: 't1', start: 0, length: 4, sampleHash: 'kick' } },
  { type: 'clip.add', clip: { id: 'k2', trackId: 't1', start: 8, length: 4, sampleHash: 'snare' } },
  { type: 'clip.add', clip: { id: 'k3', trackId: 't2', start: 0, length: 16, sampleHash: 'sub' } },
];

/** The seed as log entries, with the same operation ids the simulated lobby gives them. */
export const SEED_LOG: readonly Envelope[] = SEED.map((op, i) => ({ opId: `seed:${i}`, clientId: 'seed', op }));

/** Deterministic id source for one client. */
export function idSource(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

const scale = Number(
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env['FC_SCALE'] ?? 1,
);

/** Number of random cases to run. Set FC_SCALE=20 for a longer soak. */
export const runs = (n: number): number => Math.max(1, Math.round(n * scale));
