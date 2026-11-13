import { mkdir, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scan, type SampleIndex } from '../src/scan.js';
import { loadIndex, saveIndex } from '../src/store.js';
import { infoChunk, makeAiff, makeWav } from '../src/writers.js';
import { withTempDir } from './helpers.js';

const pcm = (seed: number, frames = 200) => {
  const samples = Buffer.alloc(frames * 4);
  for (let i = 0; i < samples.length; i++) samples[i] = (i * 31 + seed * 17) & 0xff;
  return { encoding: 'int' as const, bits: 16 as const, channels: 2, sampleRate: 44100, samples };
};

const HOUR_AGO = (Date.now() - 3600_000) / 1000;

/** Writes a file and backdates it, so it is not racily clean for the next scan. */
async function put(path: string, data: Buffer, mtimeSec = HOUR_AGO): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, data);
  await utimes(path, mtimeSec, mtimeSec);
}

async function library(dir: string): Promise<void> {
  await put(join(dir, 'Drums', 'Kick 01.wav'), makeWav(pcm(1)));
  await put(join(dir, 'Drums', 'Snare.WAV'), makeWav(pcm(2)));
  await put(join(dir, 'Drums', 'Snare (1).wav'), makeWav(pcm(2))); // byte-identical copy
  await put(join(dir, 'Loops', 'Pad.aif'), makeAiff(pcm(3)));
  await put(join(dir, 'Loops', 'Pad tagged.wav'), makeWav(pcm(3), [infoChunk('from a store')]));
  await put(join(dir, 'Loops', 'vocal.mp3'), Buffer.from('ID3 pretend mp3'));
  await put(join(dir, 'Loops', 'readme.txt'), Buffer.from('not audio'));
  await put(join(dir, 'Loops', '._Pad.aif'), Buffer.from('AppleDouble'));
}

const byName = (index: SampleIndex, name: string) => index.entries.find((e) => e.path.endsWith(name));

describe('scan', () => {
  it('indexes sample files with size, modified time and hashes', async () => {
    await withTempDir(async (dir) => {
      await library(dir);
      const { index, report } = await scan([dir]);
      expect(index.entries.map((e) => e.path.slice(dir.length + 1).replaceAll('\\', '/'))).toEqual([
        'Drums/Kick 01.wav',
        'Drums/Snare (1).wav',
        'Drums/Snare.WAV',
        'Loops/Pad tagged.wav',
        'Loops/Pad.aif',
        'Loops/vocal.mp3',
      ]);
      expect(report).toMatchObject({ filesIndexed: 6, filesHashed: 6, filesAdded: 6, filesReused: 0, errors: [] });
      expect(report.skipped).toEqual({ symlinks: 0, appleDouble: 1, otherExtensions: 1 });
      for (const e of index.entries) {
        expect(e.size).toBeGreaterThan(0);
        expect(e.mtimeMs).toBeCloseTo(HOUR_AGO * 1000, -3);
        expect(e.fileHash).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(byName(index, 'Snare (1).wav')?.fileHash).toBe(byName(index, 'Snare.WAV')?.fileHash);
      expect(byName(index, 'Pad.aif')?.fileHash).not.toBe(byName(index, 'Pad tagged.wav')?.fileHash);
      expect(byName(index, 'Pad.aif')?.audio?.hash).toBe(byName(index, 'Pad tagged.wav')?.audio?.hash);
      expect(byName(index, 'vocal.mp3')).toMatchObject({ audioSkipped: 'not wav or aiff' });
    });
  });

  it('rescans read only files that are new or whose size or modified time changed', async () => {
    await withTempDir(async (dir) => {
      await library(dir);
      const first = await scan([dir]);

      const unchanged = await scan([dir], first.index);
      expect(unchanged.report).toMatchObject({ filesHashed: 0, filesReused: 6, bytesRead: 0 });
      expect(unchanged.index.entries).toEqual(first.index.entries);

      await put(join(dir, 'Drums', 'Kick 01.wav'), makeWav(pcm(9, 300))); // new size
      const kick = byName(first.index, 'Kick 01.wav')!;
      await utimes(join(dir, 'Loops', 'Pad.aif'), HOUR_AGO - 60, HOUR_AGO - 60); // touched only
      await put(join(dir, 'Drums', 'Hat.wav'), makeWav(pcm(4))); // added
      await rm(join(dir, 'Loops', 'vocal.mp3')); // removed

      const second = await scan([dir], first.index);
      expect(second.report.hashedPaths.map((p) => p.slice(dir.length + 1).replaceAll('\\', '/')).sort()).toEqual([
        'Drums/Hat.wav',
        'Drums/Kick 01.wav',
        'Loops/Pad.aif',
      ]);
      expect(second.report).toMatchObject({ filesReused: 3, filesAdded: 1, filesChanged: 2, filesRemoved: 1 });
      expect(byName(second.index, 'Kick 01.wav')?.fileHash).not.toBe(kick.fileHash);
      expect(byName(second.index, 'Pad.aif')?.fileHash).toBe(byName(first.index, 'Pad.aif')?.fileHash);
      expect(byName(second.index, 'vocal.mp3')).toBeUndefined();
    });
  });

  it('keeps the same identity when a file is renamed or moved', async () => {
    await withTempDir(async (dir) => {
      await library(dir);
      const first = await scan([dir]);
      await mkdir(join(dir, 'Sorted'));
      await rename(join(dir, 'Drums', 'Kick 01.wav'), join(dir, 'Sorted', 'kick-fat.wav'));
      const second = await scan([dir], first.index);
      expect(byName(second.index, 'kick-fat.wav')?.fileHash).toBe(byName(first.index, 'Kick 01.wav')?.fileHash);
      expect(second.report).toMatchObject({ filesHashed: 1, filesAdded: 1, filesRemoved: 1 });
    });
  });

  it('hashes racily clean files again: modified just before the previous scan started', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'fresh.wav');
      const t = Date.now();
      await put(path, makeWav(pcm(1)), t / 1000);
      const first = await scan([dir], undefined, { now: () => t + 500 });
      const second = await scan([dir], first.index, { now: () => t + 60_000 });
      expect(second.report.filesHashed).toBe(1);
      const third = await scan([dir], second.index);
      expect(third.report.filesHashed).toBe(0);
    });
  });

  it('hashes everything again when the hash mode changes', async () => {
    await withTempDir(async (dir) => {
      await library(dir);
      const fileOnly = await scan([dir], undefined, { mode: 'file' });
      expect(fileOnly.index.entries.every((e) => e.audio === undefined && e.audioSkipped === undefined)).toBe(true);
      const both = await scan([dir], fileOnly.index, { mode: 'both' });
      expect(both.report.filesHashed).toBe(6);
    });
  });

  it('records unreadable folders and keeps going, and does not follow symlinks', async () => {
    await withTempDir(async (dir) => {
      await library(dir);
      let linked = true;
      try {
        await symlink(dir, join(dir, 'Drums', 'loop-to-root'), 'dir');
      } catch {
        linked = false; // Windows without developer mode cannot create symlinks
      }
      const { report } = await scan([dir, join(dir, 'does-not-exist')]);
      expect(report.filesIndexed).toBe(6);
      expect(report.errors).toEqual([{ path: join(dir, 'does-not-exist'), message: 'ENOENT' }]);
      expect(report.skipped.symlinks).toBe(linked ? 1 : 0);
    });
  });

  it('reports progress and can be cancelled', async () => {
    await withTempDir(async (dir) => {
      await library(dir);
      const phases = new Set<string>();
      await scan([dir], undefined, { onProgress: (p) => phases.add(p.phase) });
      expect([...phases]).toEqual(['walk', 'hash']);
      const ac = new AbortController();
      ac.abort();
      await expect(scan([dir], undefined, { signal: ac.signal })).rejects.toThrow();
    });
  });

  it('reports cost: time, CPU and event loop delay', async () => {
    await withTempDir(async (dir) => {
      await library(dir);
      const { report } = await scan([dir]);
      expect(report.wallMs).toBeGreaterThan(0);
      expect(report.cpuUserMs + report.cpuSystemMs).toBeGreaterThan(0);
      expect(report.eventLoopDelayMs.max).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('index store', () => {
  it('round-trips, and ignores a missing file or another version', async () => {
    await withTempDir(async (dir) => {
      await library(dir);
      const { index } = await scan([dir]);
      const path = join(dir, 'index.json');
      expect(await loadIndex(path)).toBeUndefined();
      const bytes = await saveIndex(path, index);
      expect(bytes).toBe((await readFile(path)).length);
      expect(await loadIndex(path)).toEqual(index);
      await writeFile(path, JSON.stringify({ ...index, version: 99 }));
      expect(await loadIndex(path)).toBeUndefined();
    });
  });
});
