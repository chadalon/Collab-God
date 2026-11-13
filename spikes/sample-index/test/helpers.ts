import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Number of random cases to run. Set FC_SCALE=40 for a longer soak. */
export function fcRuns(base: number): number {
  const scale = Number(process.env['FC_SCALE'] ?? 1);
  return Math.max(1, Math.round(base * (Number.isFinite(scale) && scale > 0 ? scale : 1)));
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'collabgod-samples-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
