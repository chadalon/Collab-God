// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * TLS on one machine, with a throwaway self-signed certificate made by the
 * openssl command for this run. Skipped where openssl is not available. The
 * test between two real networks is manual; see README.md.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayClient, type RelayServer, startRelayServer } from '../src';
import { untilLog } from './helpers';

function makeCertificate(): { cert: string; key: string } | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'relay-tls-'));
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-nodes', '-days', '1',
        '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
        '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
        '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    return { cert: readFileSync(join(dir, 'cert.pem'), 'utf8'), key: readFileSync(join(dir, 'key.pem'), 'utf8') };
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const certificate = makeCertificate();

describe.skipIf(certificate === undefined)('over TLS', () => {
  let server: RelayServer;
  beforeAll(async () => {
    if (certificate === undefined) return;
    server = await startRelayServer({ port: 0, host: '127.0.0.1', tls: certificate });
  });
  afterAll(() => server?.close());

  const url = () => `wss://localhost:${server.port}`;

  it('orders operations between two people over an encrypted, verified connection', async () => {
    const ca = certificate?.cert;
    const a = await RelayClient.connect(url(), { ...(ca === undefined ? {} : { ca }) });
    const b = await RelayClient.connect(url(), { ...(ca === undefined ? {} : { ca }) });
    const { code } = await a.create();
    await b.join(code);
    a.sendOp('p1:1', 'hello');
    await untilLog(b, 1);

    expect(b.log[0]).toMatchObject({ seq: 1, clientId: 'p1', op: 'hello' });
    expect(a.tls).toMatchObject({ protocol: 'TLSv1.3', authorized: true, subject: 'localhost' });
    await Promise.all([a.close(), b.close()]);
  });

  it('refuses a relay whose certificate is not trusted', async () => {
    await expect(RelayClient.connect(url())).rejects.toThrow(/self[- ]signed/i);
  });
});
