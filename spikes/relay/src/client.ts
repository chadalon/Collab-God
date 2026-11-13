// SPDX-License-Identifier: GPL-3.0-or-later

import { performance } from 'node:perf_hooks';
import type { TLSSocket } from 'node:tls';
import { WebSocket } from 'ws';
import type { ClientMessage, ErrorCode, ServerMessage, WireSequenced } from './protocol';

export type Welcome = Extract<ServerMessage, { type: 'welcome' }>;

export class RelayError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface ConnectOptions {
  /** Extra CA certificate to trust, PEM. For a relay with a self-signed certificate. */
  readonly ca?: string | Buffer;
  /** Allow plain ws://. Off by default, because all lobby traffic must be encrypted (NFR-7). */
  readonly allowInsecure?: boolean;
  /** Give up connecting after this long. Default 10 seconds. */
  readonly timeoutMs?: number;
}

export interface TlsDetails {
  readonly protocol: string | null;
  readonly cipher: string;
  /** Whether the certificate chain was verified against a trusted CA. */
  readonly authorized: boolean;
  readonly subject: string | undefined;
}

/**
 * A connection to a relay. It keeps every ordered operation it has received, so
 * a subscriber that starts late, even in the same tick as the welcome, misses
 * nothing: `onOp` replays what came before and then continues live.
 */
export class RelayClient {
  private readonly received: WireSequenced[] = [];
  private readonly opListeners = new Set<(op: WireSequenced) => void>();
  private readonly messageListeners = new Set<(message: ServerMessage) => void>();
  private readonly pings = new Map<number, (rtt: number) => void>();
  private welcomeState: Welcome | undefined;
  private pending: { resolve: (welcome: Welcome) => void; reject: (error: Error) => void } | undefined;
  private tlsSocket: TLSSocket | undefined;
  private pingCounter = 0;

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => this.dispatch(JSON.parse(data.toString()) as ServerMessage));
    socket.on('close', () => {
      this.pending?.reject(new Error('connection closed'));
      this.pending = undefined;
    });
  }

  /** Open a connection. Refuses ws:// unless `allowInsecure` is set. */
  static connect(url: string, options: ConnectOptions = {}): Promise<RelayClient> {
    if (url.startsWith('ws://') && options.allowInsecure !== true) {
      return Promise.reject(new Error(`refusing unencrypted ${url}: use wss:// (or allowInsecure for local testing)`));
    }
    const socket = new WebSocket(url, {
      handshakeTimeout: options.timeoutMs ?? 10_000,
      ...(options.ca === undefined ? {} : { ca: options.ca }),
    });
    const client = new RelayClient(socket);
    socket.on('upgrade', (response) => {
      if ('encrypted' in response.socket) client.tlsSocket = response.socket as TLSSocket;
    });
    return new Promise((resolve, reject) => {
      socket.once('open', () => {
        socket.off('error', reject);
        socket.on('error', () => {});
        resolve(client);
      });
      socket.once('error', reject);
    });
  }

  get welcome(): Welcome | undefined {
    return this.welcomeState;
  }

  get clientId(): string | undefined {
    return this.welcomeState?.clientId;
  }

  /** Every ordered operation received so far, starting with the catch-up log. */
  get log(): readonly WireSequenced[] {
    return this.received;
  }

  /** TLS details of the connection, or undefined for plain ws://. */
  get tls(): TlsDetails | undefined {
    const tls = this.tlsSocket;
    if (tls === undefined) return undefined;
    const subject = tls.getPeerCertificate()?.subject?.CN;
    return {
      protocol: tls.getProtocol(),
      cipher: tls.getCipher().name,
      authorized: tls.authorized,
      subject: Array.isArray(subject) ? subject.join(',') : subject,
    };
  }

  create(): Promise<Welcome> {
    return this.enter({ type: 'create' });
  }

  join(code: string): Promise<Welcome> {
    return this.enter({ type: 'join', code });
  }

  sendOp(opId: string, op: unknown): void {
    this.send({ type: 'op', opId, op });
  }

  /** Round trip to the relay itself, in milliseconds. Does not touch the lobby's log. */
  ping(timeoutMs = 5_000): Promise<number> {
    const id = (this.pingCounter += 1);
    const sent = performance.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pings.delete(id);
        reject(new Error('ping timed out'));
      }, timeoutMs);
      this.pings.set(id, () => {
        clearTimeout(timer);
        resolve(performance.now() - sent);
      });
      this.send({ type: 'ping', t: id });
    });
  }

  /** Receive every ordered operation, past and future, in order. Returns an unsubscribe function. */
  onOp(listener: (op: WireSequenced) => void): () => void {
    for (const op of this.received) listener(op);
    this.opListeners.add(listener);
    return () => this.opListeners.delete(listener);
  }

  /** Receive every message from now on, including peer notices and errors. */
  onMessage(listener: (message: ServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  /** Wait for the first message from now on that matches. */
  waitFor<T extends ServerMessage>(match: (message: ServerMessage) => message is T, timeoutMs = 5_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error('timed out waiting for a message'));
      }, timeoutMs);
      const stop = this.onMessage((message) => {
        if (!match(message)) return;
        clearTimeout(timer);
        stop();
        resolve(message);
      });
    });
  }

  /** Send a raw frame. For tests of malformed input. */
  sendRaw(text: string): void {
    this.socket.send(text);
  }

  close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.socket.once('close', () => resolve());
      this.socket.close();
    });
  }

  private enter(message: ClientMessage): Promise<Welcome> {
    if (this.pending !== undefined) return Promise.reject(new Error('already waiting for a lobby'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.send(message);
    });
  }

  private send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  private dispatch(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        this.welcomeState = message;
        for (const op of message.log) this.deliver(op);
        this.pending?.resolve(message);
        this.pending = undefined;
        break;
      case 'op': {
        const { type: _type, ...op } = message;
        this.deliver(op);
        break;
      }
      case 'pong':
        this.pings.get(message.t)?.(0);
        this.pings.delete(message.t);
        break;
      case 'error':
        if (this.pending !== undefined && message.code !== 'duplicate-op') {
          this.pending.reject(new RelayError(message.code, message.message));
          this.pending = undefined;
        }
        break;
      default:
        break;
    }
    for (const listener of this.messageListeners) listener(message);
  }

  private deliver(op: WireSequenced): void {
    const expected = this.received.length + 1;
    if (op.seq !== expected) throw new Error(`expected seq ${expected} from the relay, received ${op.seq}`);
    this.received.push(op);
    for (const listener of this.opListeners) listener(op);
  }
}
