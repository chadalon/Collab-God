// SPDX-License-Identifier: GPL-3.0-or-later

import { apply, emptyState, type Op, type SessionState } from './model';

/** An operation as a client sends it. */
export interface Envelope {
  readonly opId: string;
  readonly clientId: string;
  readonly op: Op;
}

/** An operation after the relay has given it a place in the shared order. */
export interface Sequenced extends Envelope {
  readonly seq: number;
}

/**
 * The whole job of the relay, minus the network: give every operation the next
 * sequence number and remember the log. It never looks inside an operation.
 */
export class Relay {
  private readonly entries: Sequenced[] = [];

  sequence(envelope: Envelope): Sequenced {
    const sequenced: Sequenced = { ...envelope, seq: this.entries.length + 1 };
    this.entries.push(sequenced);
    return sequenced;
  }

  get log(): readonly Sequenced[] {
    return this.entries;
  }
}

/** The state that results from applying a log in order. */
export function fold(
  log: Iterable<{ readonly opId: string; readonly op: Op }>,
  initial: SessionState = emptyState,
): SessionState {
  let state = initial;
  for (const entry of log) state = apply(state, entry.op, entry.opId).state;
  return state;
}
