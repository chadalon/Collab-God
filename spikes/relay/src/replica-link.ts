// SPDX-License-Identifier: GPL-3.0-or-later

import type { Sequenced } from '../../session-model/src/relay';
import { Replica } from '../../session-model/src/replica';
import type { RelayClient } from './client';

/**
 * Run a session-model `Replica` over a relay connection that has already joined
 * a lobby. The replica replays the catch-up log, then follows the live order.
 *
 * This is the only place where the relay's opaque operations are read as
 * session operations, and it is on the client, not the relay.
 */
export function linkReplica(client: RelayClient): Replica {
  const clientId = client.clientId;
  if (clientId === undefined) throw new Error('join or create a lobby first');
  const replica = new Replica(clientId, (envelope) => client.sendOp(envelope.opId, envelope.op));
  client.onOp((op) => replica.receive(op as Sequenced));
  return replica;
}
