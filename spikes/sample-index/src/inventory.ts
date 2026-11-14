import { basename } from 'node:path';
import type { HashMode } from './hash.js';
import { HASH_ALGORITHM } from './hash.js';
import { NearMatcher, type NearRule } from './match.js';
import type { SampleIndex } from './scan.js';

/**
 * What one person shares so the other can measure overlap: hashes, sizes, file names and
 * lengths. No folders and no paths, in keeping with the rule that local paths never leave a machine.
 */
export interface Inventory {
  format: 'collabgod-sample-inventory';
  version: 1;
  hashAlgorithm: typeof HASH_ALGORITHM;
  hashMode: HashMode;
  items: InventoryItem[];
}

export interface InventoryItem {
  /** File name only, e.g. "Kick 01.wav". */
  name: string;
  size: number;
  fileHash?: string;
  audioHash?: string;
  /** Seconds, for PCM files. */
  durationSec?: number;
}

export function toInventory(index: SampleIndex): Inventory {
  const items: InventoryItem[] = [];
  for (const e of index.entries) {
    if (e.error !== undefined) continue;
    const item: InventoryItem = { name: basename(e.path.replaceAll('\\', '/')), size: e.size };
    if (e.fileHash !== undefined) item.fileHash = e.fileHash;
    if (e.audio) {
      item.audioHash = e.audio.hash;
      item.durationSec = e.audio.frames / e.audio.sampleRate;
    }
    items.push(item);
  }
  // Sorted by hash so the file says nothing about folder layout or scan order.
  items.sort((a, b) => ((a.fileHash ?? a.name) < (b.fileHash ?? b.name) ? -1 : 1));
  return { format: 'collabgod-sample-inventory', version: 1, hashAlgorithm: HASH_ALGORITHM, hashMode: index.hashMode, items };
}

export type MatchKind = 'same-file' | 'same-audio' | NearRule | 'missing';
export const MATCH_KINDS: readonly MatchKind[] = ['same-file', 'same-audio', 'same-name', 'copy-number', 'other-format', 'missing'];

export interface Tally {
  files: number;
  bytes: number;
  /** Distinct contents (by file hash, else name and size). */
  unique: number;
}

export interface OverlapReport {
  /** How many of A's samples B has, by the strongest rule that finds one. */
  aInB: Record<MatchKind, Tally>;
  bInA: Record<MatchKind, Tally>;
  aTotal: Tally;
  bTotal: Tally;
}

function contentKey(i: InventoryItem): string {
  return i.fileHash ?? `${i.name}\0${i.size}`;
}

function emptyTallies(): Record<MatchKind, Tally> {
  return Object.fromEntries(MATCH_KINDS.map((k) => [k, { files: 0, bytes: 0, unique: 0 }])) as Record<MatchKind, Tally>;
}

/** Classifies one item against the other person's inventory: exact file, same audio, a name rule, or missing. */
export function classify(item: InventoryItem, files: ReadonlySet<string>, audio: ReadonlySet<string>, names: NearMatcher<InventoryItem>): MatchKind {
  if (item.fileHash !== undefined && files.has(item.fileHash)) return 'same-file';
  if (item.audioHash !== undefined && audio.has(item.audioHash)) return 'same-audio';
  return names.find(item)[0]?.rule ?? 'missing';
}

function oneWay(from: Inventory, to: Inventory): { tallies: Record<MatchKind, Tally>; total: Tally } {
  const files = new Set(to.items.flatMap((i) => (i.fileHash ? [i.fileHash] : [])));
  const audio = new Set(to.items.flatMap((i) => (i.audioHash ? [i.audioHash] : [])));
  const names = new NearMatcher(to.items);
  const tallies = emptyTallies();
  const total: Tally = { files: 0, bytes: 0, unique: 0 };
  const seen = new Set<string>();
  for (const item of from.items) {
    const kind = classify(item, files, audio, names);
    const t = tallies[kind];
    t.files++;
    t.bytes += item.size;
    total.files++;
    total.bytes += item.size;
    const key = contentKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      t.unique++;
      total.unique++;
    }
  }
  return { tallies, total };
}

export function compareInventories(a: Inventory, b: Inventory): OverlapReport {
  if (a.hashAlgorithm !== b.hashAlgorithm) throw new Error('inventories use different hash algorithms');
  const ab = oneWay(a, b);
  const ba = oneWay(b, a);
  return { aInB: ab.tallies, bInA: ba.tallies, aTotal: ab.total, bTotal: ba.total };
}
