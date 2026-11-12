// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Messages between a client and the relay, sent as JSON text frames.
 *
 * The operation shapes are the session-model spike's `Envelope` and `Sequenced`.
 * The relay never looks inside `op`: it checks the frame, stamps the sender and
 * a sequence number, and passes `op` on byte for byte as JSON.
 */

/**
 * An operation after the relay has ordered it, as it travels. The same fields as
 * the session-model spike's `Sequenced`, with `op` left opaque: the relay and
 * this client carry any JSON value, and only the session model gives it meaning.
 */
export interface WireSequenced {
  readonly seq: number;
  readonly opId: string;
  readonly clientId: string;
  readonly op: unknown;
}

/** Client to relay. */
export type ClientMessage =
  /** Open a new lobby. The sender becomes its first member. */
  | { readonly type: 'create' }
  /** Join a lobby by invite code. Case, spaces and dashes in the code are ignored. */
  | { readonly type: 'join'; readonly code: string }
  /**
   * An operation to be ordered. `clientId` is not sent: the relay stamps the
   * id it gave this connection, so nobody can send an operation as someone else.
   */
  | { readonly type: 'op'; readonly opId: string; readonly op: unknown }
  /** Answered at once with `pong`, outside the ordered log. For measuring latency to the relay. */
  | { readonly type: 'ping'; readonly t: number };

/** Relay to client. */
export type ServerMessage =
  /**
   * Sent once, after `create` or `join` succeeds. `log` is every operation the
   * lobby has ordered so far; a late joiner replays it to catch up. Every `op`
   * message that follows continues from `log`'s last sequence number.
   */
  | {
      readonly type: 'welcome';
      readonly code: string;
      readonly clientId: string;
      readonly peers: readonly string[];
      readonly log: readonly WireSequenced[];
    }
  /** The next operation in the lobby's order, sent to every member including its sender. */
  | ({ readonly type: 'op' } & WireSequenced)
  | { readonly type: 'peer-joined'; readonly clientId: string }
  | { readonly type: 'peer-left'; readonly clientId: string }
  | { readonly type: 'pong'; readonly t: number }
  | { readonly type: 'error'; readonly code: ErrorCode; readonly message: string };

export type ErrorCode =
  /** The frame was not JSON, or not a message this relay knows. */
  | 'bad-message'
  /** No lobby has this invite code, or it expired. */
  | 'unknown-room'
  /** Two people are already connected to this lobby. */
  | 'room-full'
  /** `create` or `join` sent by a connection that is already in a lobby. */
  | 'already-joined'
  /** `op` sent before `create` or `join`. */
  | 'not-joined'
  /** An operation with this id has already been ordered in this lobby. It was not ordered again. */
  | 'duplicate-op';

/** Lobbies cap at two people in v1 (LOB-2). */
export const ROOM_CAPACITY = 2;

/** Longest accepted operation id. Ids are short strings such as `p1:42`. */
export const MAX_OP_ID_LENGTH = 128;

/** Invite codes use letters and digits that are hard to confuse when read aloud or typed: no 0/O, 1/I/L or U. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const CODE_LENGTH = 6;

/** Normalise what a person typed: `k7m-qx4` and `K7M QX4` both become `K7MQX4`. */
export function normaliseCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

/** Show a code in two halves, `K7M-QX4`, which is easier to read out. */
export function formatCode(code: string): string {
  return code.length === CODE_LENGTH ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parse and check a client frame. Returns undefined for anything the relay does not accept. */
export function parseClientMessage(text: string): ClientMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  switch (value['type']) {
    case 'create':
      return { type: 'create' };
    case 'join':
      return typeof value['code'] === 'string' ? { type: 'join', code: value['code'] } : undefined;
    case 'op': {
      const opId = value['opId'];
      if (typeof opId !== 'string' || opId.length === 0 || opId.length > MAX_OP_ID_LENGTH) return undefined;
      if (!('op' in value)) return undefined;
      return { type: 'op', opId, op: value['op'] };
    }
    case 'ping':
      return typeof value['t'] === 'number' && Number.isFinite(value['t']) ? { type: 'ping', t: value['t'] } : undefined;
    default:
      return undefined;
  }
}
