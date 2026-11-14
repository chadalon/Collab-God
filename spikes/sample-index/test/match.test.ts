import { describe, expect, it } from 'vitest';
import { compareInventories, toInventory, type Inventory, type InventoryItem } from '../src/inventory.js';
import { NearMatcher, nameParts } from '../src/match.js';
import type { SampleIndex } from '../src/scan.js';

describe('nameParts', () => {
  it.each([
    ['Kick 01.wav', 'kick 01', '.wav'],
    ['Kick 01 (1).wav', 'kick 01', '.wav'],
    ['Kick 01(12).WAV', 'kick 01', '.wav'],
    ['Kick (1) Loud.wav', 'kick (1) loud', '.wav'], // only a trailing copy number counts
    ['.hidden', '.hidden', ''],
    ['no extension', 'no extension', ''],
    ['Caf\u0065\u0301 Snare.wav', 'caf\u00e9 snare', '.wav'], // NFD from macOS becomes NFC
  ])('%s', (name, base, ext) => {
    expect(nameParts(name)).toMatchObject({ base, ext });
  });
});

describe('NearMatcher', () => {
  const lib = [
    { name: 'Kick 01.wav', durationSec: 0.5 },
    { name: 'kick 01.WAV', durationSec: 0.9 },
    { name: 'Kick 01 (1).wav', durationSec: 0.5 },
    { name: 'Kick 01.flac' },
    { name: 'Kick 01.txt' },
    { name: 'Kick 02.wav', durationSec: 0.5 },
  ];
  const m = new NearMatcher(lib);

  it('ranks same name, then copy number, then another format, using length to break ties', () => {
    expect(m.find({ name: 'Kick 01.wav', durationSec: 0.5 }).map((r) => [r.item.name, r.rule, r.durationAgrees])).toEqual([
      ['Kick 01.wav', 'same-name', true],
      ['kick 01.WAV', 'same-name', false],
      ['Kick 01 (1).wav', 'copy-number', true],
      ['Kick 01.flac', 'other-format', undefined],
    ]);
  });

  it('strips the copy number from the target as Studio-One-File-Finder does', () => {
    expect(m.find({ name: 'Kick 02 (3).wav' }).map((r) => [r.item.name, r.rule])).toEqual([['Kick 02.wav', 'copy-number']]);
  });

  it('finds nothing for an unrelated name and ignores non-audio extensions', () => {
    expect(m.find({ name: 'Snare.wav' })).toEqual([]);
    expect(m.find({ name: 'Kick 01.txt' }).map((r) => r.item.name)).toEqual(['Kick 01.txt']);
    expect(m.find({ name: 'Kick 01.aif' }).every((r) => r.item.name !== 'Kick 01.txt')).toBe(true);
  });
});

function item(name: string, size: number, fileHash?: string, audioHash?: string): InventoryItem {
  const i: InventoryItem = { name, size };
  if (fileHash) i.fileHash = fileHash;
  if (audioHash) i.audioHash = audioHash;
  return i;
}

const inv = (items: InventoryItem[]): Inventory => ({ format: 'collabgod-sample-inventory', version: 1, hashAlgorithm: 'sha256', hashMode: 'both', items });

describe('compareInventories', () => {
  it('counts each sample once, by the strongest rule that finds it', () => {
    const a = inv([
      item('Kick.wav', 100, 'f1', 'a1'),
      item('Kick copy.wav', 100, 'f1', 'a1'), // a duplicate of the same content
      item('Pad.wav', 200, 'f2', 'a2'),
      item('Snare (1).wav', 300, 'f3', 'a3'),
      item('Hat.wav', 400, 'f4', 'a4'),
      item('Vox.mp3', 500, 'f5'),
      item('Lonely.wav', 600, 'f6', 'a6'),
    ]);
    const b = inv([
      item('Renamed kick.wav', 100, 'f1', 'a1'),
      item('Pad retagged.wav', 210, 'f2x', 'a2'),
      item('Snare.wav', 300, 'f3x', 'a3x'),
      item('Hat.aif', 410, 'f4x', 'a4x'),
      item('vox.mp3', 500, 'f5x'),
    ]);
    const r = compareInventories(a, b);
    expect(r.aTotal).toEqual({ files: 7, bytes: 2200, unique: 6 });
    expect(r.aInB['same-file']).toEqual({ files: 2, bytes: 200, unique: 1 });
    expect(r.aInB['same-audio']).toEqual({ files: 1, bytes: 200, unique: 1 });
    expect(r.aInB['copy-number'].files).toBe(1);
    expect(r.aInB['other-format'].files).toBe(1);
    expect(r.aInB['same-name'].files).toBe(1);
    expect(r.aInB['missing']).toEqual({ files: 1, bytes: 600, unique: 1 });
    expect(r.bInA['same-file'].files).toBe(1);
    expect(r.bTotal.files).toBe(5);
  });
});

describe('toInventory', () => {
  it('keeps file names and hashes but no folders, and skips unreadable files', () => {
    const index: SampleIndex = {
      format: 'collabgod-sample-index',
      version: 1,
      hashAlgorithm: 'sha256',
      hashMode: 'both',
      roots: ['C:\\Samples'],
      scannedAt: 0,
      entries: [
        { path: 'C:\\Samples\\Secret Folder\\Kick.wav', size: 10, mtimeMs: 1, fileHash: 'bb', audio: { hash: 'a', encoding: 'int', bits: 16, channels: 1, sampleRate: 1000, frames: 500 } },
        { path: '/Users/me/Samples/Vox.mp3', size: 20, mtimeMs: 1, fileHash: 'aa', audioSkipped: 'not wav or aiff' },
        { path: '/Users/me/Samples/Locked.wav', size: 30, mtimeMs: 1, error: 'EACCES' },
      ],
    };
    const out = toInventory(index);
    expect(out.items).toEqual([
      { name: 'Vox.mp3', size: 20, fileHash: 'aa' },
      { name: 'Kick.wav', size: 10, fileHash: 'bb', audioHash: 'a', durationSec: 0.5 },
    ]);
    const text = JSON.stringify(out);
    expect(text).not.toContain('Samples');
    expect(text).not.toContain('Secret');
  });
});
