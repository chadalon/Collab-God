// SPDX-License-Identifier: GPL-3.0-or-later

import { apply, emptyState, type Op, type SessionState } from './model';
import type { Envelope, Sequenced } from './relay';

interface HistoryEntry {
  /** The operation this entry would reverse. */
  readonly opId: string;
  /** The guarded operation that reverses it. */
  inverse: Op;
}

/**
 * One person's copy of the session.
 *
 * It keeps two states:
 *
 * - `confirmed`: every operation the relay has ordered so far, applied in order.
 *   Identical on every machine that has received the same prefix of the log.
 * - `view`: `confirmed` plus this person's own operations that the relay has not
 *   ordered yet. This is what the interface draws, so local edits feel instant.
 *
 * When the relay's order arrives, `confirmed` advances and `view` is rebuilt by
 * replaying the still-unconfirmed local operations on top.
 */
export class Replica {
  private confirmedState: SessionState;
  private confirmedSeq = 0;
  private viewState: SessionState;
  private readonly pending: Envelope[] = [];
  private readonly undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private counter = 0;
  private rejectedCount = 0;

  constructor(
    readonly clientId: string,
    private readonly send: (envelope: Envelope) => void,
    initial: SessionState = emptyState,
  ) {
    this.confirmedState = initial;
    this.viewState = initial;
  }

  /** What the interface should draw. */
  get view(): SessionState {
    return this.viewState;
  }

  get confirmed(): SessionState {
    return this.confirmedState;
  }

  /** Sequence number of the last operation received from the relay. */
  get seq(): number {
    return this.confirmedSeq;
  }

  /** Own operations sent but not yet ordered by the relay. */
  get unconfirmed(): readonly Envelope[] {
    return this.pending;
  }

  /** Own operations that turned out to have no effect once the relay's order was known. */
  get rejected(): number {
    return this.rejectedCount;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Make an edit. Returns false if it does not apply to the current view. */
  edit(op: Op): boolean {
    return this.submit(op, (entry) => {
      this.undoStack.push(entry);
      this.redoStack = [];
    });
  }

  /**
   * Undo this person's most recent edit that is still in effect. Edits whose
   * target someone else has since changed are skipped, never forced.
   */
  undo(): boolean {
    for (;;) {
      const entry = this.undoStack.pop();
      if (entry === undefined) return false;
      if (this.submit(entry.inverse, (redo) => this.redoStack.push(redo))) return true;
    }
  }

  redo(): boolean {
    for (;;) {
      const entry = this.redoStack.pop();
      if (entry === undefined) return false;
      if (this.submit(entry.inverse, (undo) => this.undoStack.push(undo))) return true;
    }
  }

  /** Take the next operation from the relay. Operations must arrive in sequence order. */
  receive(sequenced: Sequenced): void {
    if (sequenced.seq !== this.confirmedSeq + 1) {
      throw new Error(`expected seq ${this.confirmedSeq + 1}, received ${sequenced.seq}`);
    }
    const result = apply(this.confirmedState, sequenced.op, sequenced.opId);
    this.confirmedState = result.state;
    this.confirmedSeq = sequenced.seq;

    if (sequenced.clientId === this.clientId) {
      const head = this.pending.shift();
      if (head === undefined || head.opId !== sequenced.opId) {
        throw new Error(`own operation ${sequenced.opId} was confirmed out of order`);
      }
      if (result.applied) {
        // The inverse taken against the confirmed order is the authoritative one.
        this.setInverse(sequenced.opId, result.inverse);
      } else {
        this.rejectedCount += 1;
        this.forget(sequenced.opId);
      }
    }
    this.rebuildView();
  }

  private submit(op: Op, record: (entry: HistoryEntry) => void): boolean {
    const opId = `${this.clientId}:${this.counter + 1}`;
    const result = apply(this.viewState, op, opId);
    if (!result.applied) return false;
    this.counter += 1;
    const envelope: Envelope = { opId, clientId: this.clientId, op };
    this.pending.push(envelope);
    this.viewState = result.state;
    record({ opId: envelope.opId, inverse: result.inverse });
    this.send(envelope);
    return true;
  }

  private rebuildView(): void {
    let state = this.confirmedState;
    for (const envelope of this.pending) {
      const result = apply(state, envelope.op, envelope.opId);
      if (result.applied) {
        state = result.state;
        this.setInverse(envelope.opId, result.inverse);
      }
    }
    this.viewState = state;
  }

  private setInverse(opId: string, inverse: Op): void {
    const entry = this.findEntry(opId);
    if (entry !== undefined) entry.inverse = inverse;
  }

  private findEntry(opId: string): HistoryEntry | undefined {
    return (
      this.undoStack.find((entry) => entry.opId === opId) ?? this.redoStack.find((entry) => entry.opId === opId)
    );
  }

  private forget(opId: string): void {
    const drop = (stack: HistoryEntry[]): void => {
      const index = stack.findIndex((entry) => entry.opId === opId);
      if (index >= 0) stack.splice(index, 1);
    };
    drop(this.undoStack);
    drop(this.redoStack);
  }
}
