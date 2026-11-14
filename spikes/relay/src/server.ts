// SPDX-License-Identifier: GPL-3.0-or-later

import { randomInt } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { type Envelope, Relay } from '../../session-model/src/relay';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  decodeBinaryFrame,
  encodeBinaryFrame,
  type ErrorCode,
  normaliseCode,
  parseClientMessage,
  ROOM_CAPACITY,
  type ServerMessage,
} from './protocol';

export interface RelayServerOptions {
  /** Port to listen on. 0 picks a free one. Default 8080. */
  readonly port?: number;
  /** Interface to listen on. Default all of them. */
  readonly host?: string;
  /** Certificate and private key, PEM. With these the relay serves wss:// itself; without, ws:// for a TLS proxy to front. */
  readonly tls?: { readonly cert: string | Buffer; readonly key: string | Buffer };
  /** How long a lobby with nobody connected is kept before its log is dropped. Default 10 minutes. */
  readonly emptyRoomTtlMs?: number;
  /** How often to ping connections and drop ones that did not answer the last ping. Default 30 seconds. */
  readonly heartbeatMs?: number;
  /** Largest frame accepted from a client, in bytes. Default 1 MiB. */
  readonly maxPayload?: number;
  /**
   * Most unsent bytes the relay will hold for one connection before it drops
   * binary frames meant for it and answers the sender `peer-busy`. Bounds the
   * relay's memory if a sender ignores flow control. Default 16 MiB.
   */
  readonly maxBufferedBytes?: number;
  /** Where to write one-line event notes. Never receives operation contents. Default: nowhere. */
  readonly log?: (line: string) => void;
}

export interface RelayServer {
  /** `ws://host:port` or `wss://host:port`, using the port actually bound. */
  readonly url: string;
  readonly port: number;
  /** Lobbies currently held in memory, and how many operations each has ordered. */
  stats(): { rooms: number; members: number; ops: number };
  close(): Promise<void>;
}

interface Member {
  readonly socket: WebSocket;
  readonly clientId: string;
  readonly room: Room;
}

/**
 * One lobby: the session-model spike's `Relay` for ordering, plus who is connected.
 * The log lives only in memory and is gone when the process stops or the lobby expires.
 */
class Room {
  readonly relay = new Relay();
  readonly members = new Map<string, Member>();
  readonly opIds = new Set<string>();
  private nextClient = 1;
  expiry: NodeJS.Timeout | undefined;

  constructor(readonly code: string) {}

  newClientId(): string {
    const id = `p${this.nextClient}`;
    this.nextClient += 1;
    return id;
  }
}

/** Start a relay. Resolves once it is listening. */
export async function startRelayServer(options: RelayServerOptions = {}): Promise<RelayServer> {
  const emptyRoomTtlMs = options.emptyRoomTtlMs ?? 10 * 60_000;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const maxBufferedBytes = options.maxBufferedBytes ?? 16 * 1024 * 1024;
  const log = options.log ?? (() => {});

  const rooms = new Map<string, Room>();
  const members = new WeakMap<WebSocket, Member>();
  const alive = new WeakMap<WebSocket, boolean>();

  const onHttp = (request: IncomingMessage, response: ServerResponse): void => {
    if (request.url === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
      return;
    }
    response.writeHead(426, { 'content-type': 'text/plain' }).end('This is a WebSocket relay.\n');
  };
  const http = options.tls ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, onHttp) : createHttpServer(onHttp);
  const wss = new WebSocketServer({ server: http, maxPayload: options.maxPayload ?? 1024 * 1024 });

  const send = (socket: WebSocket, message: ServerMessage): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const fail = (socket: WebSocket, code: ErrorCode, message: string): void => send(socket, { type: 'error', code, message });

  const newCode = (): string => {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
  };

  /** Add a connection to a lobby and send it the log so far. Synchronous, so no operation can slip in between. */
  const admit = (socket: WebSocket, room: Room): void => {
    if (room.expiry !== undefined) {
      clearTimeout(room.expiry);
      room.expiry = undefined;
    }
    const member: Member = { socket, clientId: room.newClientId(), room };
    const peers = [...room.members.keys()];
    for (const other of room.members.values()) send(other.socket, { type: 'peer-joined', clientId: member.clientId });
    room.members.set(member.clientId, member);
    members.set(socket, member);
    send(socket, { type: 'welcome', code: room.code, clientId: member.clientId, peers, log: room.relay.log });
    log(`room ${room.code}: ${member.clientId} joined (${room.members.size}/${ROOM_CAPACITY}, log ${room.relay.log.length})`);
  };

  const leave = (socket: WebSocket): void => {
    const member = members.get(socket);
    if (member === undefined) return;
    members.delete(socket);
    const { room } = member;
    room.members.delete(member.clientId);
    for (const other of room.members.values()) send(other.socket, { type: 'peer-left', clientId: member.clientId });
    log(`room ${room.code}: ${member.clientId} left (${room.members.size}/${ROOM_CAPACITY})`);
    if (room.members.size === 0) {
      room.expiry = setTimeout(() => {
        rooms.delete(room.code);
        log(`room ${room.code}: expired after ${room.relay.log.length} ops`);
      }, emptyRoomTtlMs);
      room.expiry.unref();
    }
  };

  /**
   * Pass a binary frame to the member it names, with the sender stamped in place
   * of the recipient. Not stored, not ordered. `ws` may hand over a Buffer[] or
   * ArrayBuffer for other binary types; this server uses the default, Buffer.
   */
  const forwardBinary = (socket: WebSocket, data: Buffer): void => {
    const member = members.get(socket);
    if (member === undefined) return fail(socket, 'not-joined', 'Create or join a lobby before sending data.');
    const frame = decodeBinaryFrame(data);
    if (frame === undefined) return fail(socket, 'bad-message', 'Binary frame too short for its client id.');
    const target = member.room.members.get(frame.peer);
    if (target === undefined) return fail(socket, 'unknown-peer', `${frame.peer} is not connected.`);
    if (target.socket.bufferedAmount > maxBufferedBytes) {
      return fail(socket, 'peer-busy', `More than ${maxBufferedBytes} bytes are waiting to go to ${frame.peer}.`);
    }
    if (target.socket.readyState === WebSocket.OPEN) target.socket.send(encodeBinaryFrame(member.clientId, frame.payload));
  };

  wss.on('connection', (socket) => {
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
    socket.on('close', () => leave(socket));
    socket.on('error', () => socket.terminate());

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        forwardBinary(socket, data as Buffer);
        return;
      }
      const message = parseClientMessage(data.toString());
      if (message === undefined) {
        fail(socket, 'bad-message', 'Expected a JSON text frame: create, join, op, ping or direct.');
        return;
      }
      const member = members.get(socket);
      switch (message.type) {
        case 'ping':
          send(socket, { type: 'pong', t: message.t });
          return;
        case 'create': {
          if (member !== undefined) return fail(socket, 'already-joined', `Already in lobby ${member.room.code}.`);
          const room = new Room(newCode());
          rooms.set(room.code, room);
          log(`room ${room.code}: created`);
          admit(socket, room);
          return;
        }
        case 'join': {
          if (member !== undefined) return fail(socket, 'already-joined', `Already in lobby ${member.room.code}.`);
          const room = rooms.get(normaliseCode(message.code));
          if (room === undefined) return fail(socket, 'unknown-room', 'No lobby has that invite code.');
          if (room.members.size >= ROOM_CAPACITY) return fail(socket, 'room-full', 'Two people are already in that lobby.');
          admit(socket, room);
          return;
        }
        case 'direct': {
          if (member === undefined) return fail(socket, 'not-joined', 'Create or join a lobby before sending messages.');
          const target = member.room.members.get(message.to);
          if (target === undefined) return fail(socket, 'unknown-peer', `${message.to} is not connected.`);
          send(target.socket, { type: 'direct', from: member.clientId, data: message.data });
          return;
        }
        case 'op': {
          if (member === undefined) return fail(socket, 'not-joined', 'Create or join a lobby before sending operations.');
          const { room } = member;
          if (room.opIds.has(message.opId)) return fail(socket, 'duplicate-op', `Operation ${message.opId} was already ordered.`);
          room.opIds.add(message.opId);
          // The relay never inspects the operation. The cast only satisfies the
          // session-model type, which names the operations the relay carries.
          const envelope: Envelope = { opId: message.opId, clientId: member.clientId, op: message.op as Envelope['op'] };
          const sequenced = room.relay.sequence(envelope);
          const frame = JSON.stringify({ type: 'op', ...sequenced } satisfies ServerMessage);
          for (const other of room.members.values()) {
            if (other.socket.readyState === WebSocket.OPEN) other.socket.send(frame);
          }
          return;
        }
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 8080, options.host, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const port = (http.address() as AddressInfo).port;
  const displayHost = options.host === undefined || options.host === '0.0.0.0' || options.host === '::' ? 'localhost' : options.host;
  const url = `${options.tls ? 'wss' : 'ws'}://${displayHost}:${port}`;
  log(`relay listening on ${url}`);

  return {
    url,
    port,
    stats: () => {
      let memberCount = 0;
      let ops = 0;
      for (const room of rooms.values()) {
        memberCount += room.members.size;
        ops += room.relay.log.length;
      }
      return { rooms: rooms.size, members: memberCount, ops };
    },
    close: async () => {
      clearInterval(heartbeat);
      for (const room of rooms.values()) if (room.expiry !== undefined) clearTimeout(room.expiry);
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
