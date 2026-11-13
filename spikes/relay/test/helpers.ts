// SPDX-License-Identifier: GPL-3.0-or-later

import type { RelayClient } from '../src';
import type { ServerMessage } from '../src';

/** Poll until a condition holds, or fail with a description of what never happened. */
export async function until(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Wait until a client has received this many ordered operations. */
export const untilLog = (client: RelayClient, length: number): Promise<void> =>
  until(() => client.log.length >= length, `the client has ${length} operations`);

export const isType =
  <K extends ServerMessage['type']>(type: K) =>
  (message: ServerMessage): message is Extract<ServerMessage, { type: K }> =>
    message.type === type;
