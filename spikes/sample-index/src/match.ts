/**
 * Name-based near matches (SMP-7), offered as suggestions and never applied on their own.
 *
 * The first two rules are the ones Studio-One-File-Finder uses to relink missing samples:
 * the same file name, then the same name without a trailing copy number such as "(1)".
 * The third is new here: the same name in another audio format, which is how SMP-7
 * describes a near match. Length breaks ties when both sides know it.
 */
import { SAMPLE_EXTENSIONS } from './scan.js';

export type NearRule = 'same-name' | 'copy-number' | 'other-format';
const RULE_RANK: Record<NearRule, number> = { 'same-name': 0, 'copy-number': 1, 'other-format': 2 };

/** Lengths closer than this are treated as the same. */
export const DURATION_TOLERANCE = 0.01;

export interface Named {
  name: string;
  durationSec?: number;
}

export interface NearMatch<T extends Named> {
  item: T;
  rule: NearRule;
  /** True or false when both lengths are known; undefined otherwise. */
  durationAgrees?: boolean;
}

export interface NameParts {
  /** Lower-case, NFC, with the extension. */
  full: string;
  /** Lower-case, NFC, without extension or trailing copy number. */
  base: string;
  /** Lower-case extension with the dot, or "". */
  ext: string;
}

/**
 * The copy number some tools add to duplicates: "Kick (1).wav", "Kick(2).wav".
 * Studio-One-File-Finder removes `\(\d+\)` right before the extension; this also removes the
 * space in front, so "Kick (1).wav" becomes "kick.wav" and not "kick .wav".
 */
const COPY_NUMBER = /\s*\(\d+\)$/;

const sampleExt = new Set(SAMPLE_EXTENSIONS);

export function nameParts(name: string): NameParts {
  // macOS often stores names decomposed (NFD), Windows composed (NFC): "é" must match "é".
  // Windows and macOS default to case-insensitive file names, so case is ignored too.
  const full = name.normalize('NFC').toLowerCase();
  const dot = full.lastIndexOf('.');
  const ext = dot > 0 ? full.slice(dot) : '';
  const stem = dot > 0 ? full.slice(0, dot) : full;
  return { full, base: stem.replace(COPY_NUMBER, '').trimEnd(), ext };
}

export class NearMatcher<T extends Named> {
  private readonly byBase = new Map<string, Array<{ item: T; parts: NameParts }>>();

  constructor(items: Iterable<T>) {
    for (const item of items) {
      const parts = nameParts(item.name);
      let list = this.byBase.get(parts.base);
      if (!list) this.byBase.set(parts.base, (list = []));
      list.push({ item, parts });
    }
  }

  /** Candidates for `target`, best first. */
  find(target: Named, limit = 5): Array<NearMatch<T>> {
    const t = nameParts(target.name);
    const out: Array<NearMatch<T> & { rank: number }> = [];
    for (const c of this.byBase.get(t.base) ?? []) {
      let rule: NearRule;
      if (c.parts.full === t.full) rule = 'same-name';
      else if (c.parts.ext === t.ext) rule = 'copy-number';
      else if (sampleExt.has(c.parts.ext) && sampleExt.has(t.ext)) rule = 'other-format';
      else continue;
      const m: NearMatch<T> & { rank: number } = { item: c.item, rule, rank: RULE_RANK[rule] };
      if (target.durationSec !== undefined && c.item.durationSec !== undefined) {
        const longer = Math.max(target.durationSec, c.item.durationSec);
        m.durationAgrees = longer === 0 || Math.abs(target.durationSec - c.item.durationSec) / longer <= DURATION_TOLERANCE;
      }
      out.push(m);
    }
    const durationRank = (m: NearMatch<T>) => (m.durationAgrees === true ? 0 : m.durationAgrees === undefined ? 1 : 2);
    out.sort((a, b) => a.rank - b.rank || durationRank(a) - durationRank(b));
    return out.slice(0, limit).map(({ rank: _rank, ...m }) => m);
  }
}
