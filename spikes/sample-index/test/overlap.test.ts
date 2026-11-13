import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateLibrary } from '../src/generate.js';
import { compareInventories, toInventory } from '../src/inventory.js';
import { scan } from '../src/scan.js';
import { withTempDir } from './helpers.js';

describe('overlap between two generated libraries', () => {
  it('finds every shared content and nothing else, by the rule the variant calls for', async () => {
    await withTempDir(async (dir) => {
      const a = join(dir, 'a');
      const b = join(dir, 'b');
      await generateLibrary(a, { count: 300 });
      // B holds contents 100..399: 200 shared with A, each changed the way a second copy might be.
      const gen = await generateLibrary(b, { count: 300, offset: 100, variants: true });
      const [ia, ib] = await Promise.all([scan([a]), scan([b])]);
      const r = compareInventories(toInventory(ia.index), toInventory(ib.index));

      expect(r.aTotal.files).toBe(300);
      expect(r.aInB.missing.files).toBe(100);
      const found = r.aInB['same-file'].files + r.aInB['same-audio'].files + r.aInB['same-name'].files;
      expect(found).toBe(200);
      // Only re-rendered contents (same name, different audio) need the name rules.
      expect(r.aInB['same-name'].files).toBeGreaterThan(0);
      expect(r.aInB['same-name'].files).toBeLessThanOrEqual(gen.variants['re-rendered'] ?? 0);
      // Retagged, converted and copy-numbered contents are caught by the audio hash, not by name.
      expect(r.aInB['same-audio'].files).toBeGreaterThan(0);
      expect(r.aInB['copy-number'].files + r.aInB['other-format'].files).toBe(0);
    });
  });
});
