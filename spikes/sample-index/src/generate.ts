/**
 * A synthetic sample library, for measuring the indexer when no real library is at hand and for
 * checking the overlap report against a known answer. Two libraries made with the same seed and
 * different offsets share contents, with the kinds of differences real libraries have.
 */
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { infoChunk, makeAiff, makeWav, type PcmSpec } from './writers.js';

export interface GenerateOptions {
  count: number;
  /** Library B: use contents [offset, offset + count) instead of [0, count). */
  offset?: number;
  /** Apply the differences a second person's copy would have to shared contents. */
  variants?: boolean;
  seed?: number;
  onProgress?: (written: number) => void;
}

export interface GenerateSummary {
  files: number;
  bytes: number;
  /** What was done to each shared content, when variants are on. */
  variants: Record<string, number>;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PACKS = ['Deep House', 'Trap Lab', 'Future Bass', 'Techno Tools', 'Lofi Dust', 'DnB Rollers', 'Garage Cuts', 'Synthwave'];
const KINDS = ['Kick', 'Snare', 'Clap', 'Hat', 'Perc', 'Bass', 'Pad', 'Lead', 'Vox', 'FX', 'Loop'];
const PER_FOLDER = 100;

interface Content {
  id: number;
  folder: string;
  name: string;
  kind: 'wav16' | 'wav24' | 'aiff16' | 'mp3';
  spec?: PcmSpec;
  blob?: Buffer;
}

function content(id: number, seed: number, rerender = false): Content {
  const rnd = mulberry32(seed * 1_000_003 + id);
  const pack = PACKS[Math.floor(id / PER_FOLDER) % PACKS.length]!;
  const kindName = KINDS[Math.floor(rnd() * KINDS.length)]!;
  const folder = `${pack} Vol ${Math.floor(id / (PER_FOLDER * PACKS.length)) + 1}/${kindName}s`;
  const r = rnd();
  const kind: Content['kind'] = r < 0.7 ? 'wav16' : r < 0.8 ? 'wav24' : r < 0.9 ? 'aiff16' : 'mp3';
  const frames = 2000 + Math.floor(rnd() * 18000);
  const ext = kind === 'mp3' ? '.mp3' : kind === 'aiff16' ? '.aif' : '.wav';
  const name = `${pack} ${kindName} ${String(id).padStart(5, '0')}${ext}`;
  const noise = mulberry32(id * 7919 + (rerender ? 1 : 0));
  if (kind === 'mp3') {
    const blob = Buffer.alloc(frames * 2);
    for (let i = 0; i < blob.length; i++) blob[i] = Math.floor(noise() * 256);
    blob.write('ID3', 0, 'latin1');
    return { id, folder, name, kind, blob };
  }
  const bits = kind === 'wav24' ? 24 : 16;
  const channels = kind === 'wav24' ? 1 : 2;
  const samples = Buffer.alloc(frames * channels * (bits / 8));
  for (let i = 0; i < samples.length; i += 4) {
    const x = Math.floor(noise() * 2 ** 32);
    for (let j = 0; j < 4 && i + j < samples.length; j++) samples[i + j] = (x >>> (8 * j)) & 0xff;
  }
  const spec: PcmSpec = { encoding: 'int', bits, channels, sampleRate: kind === 'wav24' ? 48000 : 44100, samples };
  return { id, folder, name, kind, spec };
}

function encode(c: Content, as: 'native' | 'wav' | 'aiff', tagged: boolean): Buffer {
  if (c.blob) return c.blob;
  const extra = tagged ? [infoChunk('Tagged by a sample store')] : [];
  const fmt = as === 'native' ? (c.kind === 'aiff16' ? 'aiff' : 'wav') : as;
  return fmt === 'aiff' ? makeAiff(c.spec!, extra) : makeWav(c.spec!, extra);
}

/**
 * Writes `count` files under `dir`. With `variants`, each content gets one of: identical copy,
 * renamed, moved, retagged (same audio, different bytes), converted between WAV and AIFF, or
 * re-rendered (same name, different audio). Variants are picked by content id, so library A
 * (variants off) and library B (variants on) agree on what each content is.
 */
export async function generateLibrary(dir: string, options: GenerateOptions): Promise<GenerateSummary> {
  const seed = options.seed ?? 1;
  const offset = options.offset ?? 0;
  const summary: GenerateSummary = { files: 0, bytes: 0, variants: {} };
  const past = (Date.now() - 24 * 3600_000) / 1000;
  const made = new Set<string>();
  for (let n = 0; n < options.count; n++) {
    const id = offset + n;
    let c = content(id, seed);
    let name = c.name;
    let folder = c.folder;
    let as: 'native' | 'wav' | 'aiff' = 'native';
    let tagged = false;
    if (options.variants) {
      const v = mulberry32(seed + id * 31)();
      let variant: string;
      if (v < 0.55) variant = 'identical';
      else if (v < 0.65) { variant = 'renamed'; name = name.replace(/ (\d+)\./, ' $1 v2.'); }
      else if (v < 0.72) { variant = 'moved'; folder = 'My Favourites'; }
      else if (v < 0.8) { variant = 'retagged'; tagged = true; }
      else if (v < 0.87) {
        variant = c.kind === 'mp3' ? 'identical' : 'converted';
        if (c.kind !== 'mp3') {
          as = c.kind === 'aiff16' ? 'wav' : 'aiff';
          name = name.replace(/\.(wav|aif)$/, as === 'aiff' ? '.aif' : '.wav');
        }
      } else if (v < 0.93) { variant = 'copy-numbered'; name = name.replace(/\.(\w+)$/, ' (1).$1'); tagged = true; }
      else { variant = 're-rendered'; c = content(id, seed, true); }
      summary.variants[variant] = (summary.variants[variant] ?? 0) + 1;
    }
    const folderPath = join(dir, ...folder.split('/'));
    if (!made.has(folderPath)) {
      await mkdir(folderPath, { recursive: true });
      made.add(folderPath);
    }
    const data = encode(c, as, tagged);
    const path = join(folderPath, name);
    await writeFile(path, data);
    // Backdate so a scan straight after generation does not treat the files as racily clean.
    await utimes(path, past, past);
    summary.files++;
    summary.bytes += data.length;
    if (summary.files % 1000 === 0) options.onProgress?.(summary.files);
  }
  return summary;
}
