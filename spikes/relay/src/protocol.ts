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
  | { readonly type: 'ping'; readonly t: number }
  /**
   * Pass `data` to one other member, outside the ordered log. Nothing is stored:
   * if `to` is not connected the relay answers `unknown-peer` and drops it. For
   * traffic that is not an edit, such as sample transfers (issue #16) and presence.
   */
  | { readonly type: 'direct'; readonly to: string; readonly data: unknown };

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
  /** A `direct` message from another member. `from` is stamped by the relay. */
  | { readonly type: 'direct'; readonly from: string; readonly data: unknown }
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
  | 'duplicate-op'
  /** A `direct` message or binary frame named a member who is not connected. It was dropped. */
  | 'unknown-peer'
  /** The relay already holds too much unsent data for that member. The binary frame was dropped. */
  | 'peer-busy';

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

/**
 * Binary frames carry bulk data between two members, outside the ordered log.
 * Layout: one byte giving the length of a client id, that id in ASCII, then the
 * payload. From a client the id names who it is for; the relay rewrites it to
 * name who it came from. The relay never reads the payload.
 */
export function encodeBinaryFrame(peer: string, payload: Uint8Array): Buffer {
  const id = Buffer.from(peer, 'ascii');
  if (id.length === 0 || id.length > 255) throw new Error(`client id must be 1 to 255 bytes, got ${id.length}`);
  const frame = Buffer.allocUnsafe(1 + id.length + payload.length);
  frame[0] = id.length;
  id.copy(frame, 1);
  frame.set(payload, 1 + id.length);
  return frame;
}

/** Split a binary frame into its client id and payload. Undefined if it is too short to hold them. */
export function decodeBinaryFrame(frame: Buffer): { readonly peer: string; readonly payload: Buffer } | undefined {
  const length = frame[0];
  if (length === undefined || length === 0 || frame.length < 1 + length) return undefined;
  return { peer: frame.toString('ascii', 1, 1 + length), payload: frame.subarray(1 + length) };
}

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
    case 'direct': {
      const to = value['to'];
      if (typeof to !== 'string' || to.length === 0 || to.length > 255) return undefined;
      if (!('data' in value)) return undefined;
      return { type: 'direct', to, data: value['data'] };
    }
    default:
      return undefined;
  }
}
