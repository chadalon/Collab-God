// SPDX-License-Identifier: GPL-3.0-or-later

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayClient } from '../../relay/src/client';
import { type RelayServer, type RelayServerOptions, startRelayServer } from '../../relay/src/server';
import { type ContentId, contentIdOfFile } from '../src';

export { RelayClient };

/** Poll until a condition holds, or fail with a description of what never happened. */
export async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A relay on this machine, two people in one lobby, and scratch folders, all cleaned up by `dispose`. */
export async function setup(options: RelayServerOptions = {}) {
  const server: RelayServer = await startRelayServer({ port: 0, host: '127.0.0.1', ...options });
  const root = mkdtempSync(join(tmpdir(), 'sample-transfer-'));
  const connect = () => RelayClient.connect(server.url, { allowInsecure: true });
  const sender = await connect();
  const { code } = await sender.create();
  const receiver = await connect();
  await receiver.join(code);
  const library = join(root, 'library');
  const project = join(root, 'project');

  /** Write a file of random bytes into the sender's library. */
  const sample = async (name: string, bytes: number): Promise<{ path: string; id: ContentId; data: Buffer }> => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(library, { recursive: true });
    const path = join(library, name);
    const data = randomBytes(bytes);
    writeFileSync(path, data);
    return { path, id: await contentIdOfFile(path), data };
  };

  const dispose = async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { server, code, connect, sender, receiver, library, project, sample, dispose };
}
