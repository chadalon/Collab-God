/**
 * Commands for measuring the indexer on a real library and comparing two people's libraries.
 * Run with `npm run samples -- <command>`. See README.md.
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { generateLibrary } from './generate.js';
import type { HashMode } from './hash.js';
import { compareInventories, MATCH_KINDS, toInventory, type Inventory, type Tally } from './inventory.js';
import { NearMatcher } from './match.js';
import { scan, type IndexEntry } from './scan.js';
import { loadIndex, saveIndex } from './store.js';

const USAGE = `Usage:
  scan <folder>... --index <file> [--mode both|file|audio] [--jobs N] [--fresh]
  export --index <file> --out <inventory.json>
  compare <mine.json> <theirs.json>
  near --index <file> <file name> [--duration <seconds>]
  generate <folder> --count N [--offset N] [--variants] [--seed N]`;

const mb = (b: number) => (b / 1e6).toFixed(1);
const gb = (b: number) => (b / 1e9).toFixed(2);
const sec = (ms: number) => (ms / 1000).toFixed(1);
const pct = (a: number, b: number) => (b === 0 ? '0.0' : ((100 * a) / b).toFixed(1));

async function cmdScan(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { index: { type: 'string' }, mode: { type: 'string', default: 'both' }, jobs: { type: 'string', default: '4' }, fresh: { type: 'boolean', default: false } },
  });
  if (!values.index || positionals.length === 0) throw new Error(USAGE);
  const mode = values.mode as HashMode;
  if (!['both', 'file', 'audio'].includes(mode)) throw new Error(`unknown mode ${mode}`);
  const previous = values.fresh ? undefined : await loadIndex(values.index);
  console.log(previous ? `Rescanning against ${previous.entries.length} indexed files` : 'Full scan (no previous index)');

  let last = 0;
  const { index, report } = await scan(positionals, previous, {
    mode,
    jobs: Number(values.jobs),
    onProgress: (p) => {
      const now = Date.now();
      if (now - last < 2000) return;
      last = now;
      process.stderr.write(
        p.phase === 'walk' ? `  walking: ${p.filesFound} files\n` : `  hashing: ${p.filesHashed}/${p.filesToHash} files, ${mb(p.bytesRead)} MB\n`,
      );
    },
  });
  const indexBytes = await saveIndex(values.index, index);

  const audio = index.entries.filter((e) => e.audio).length;
  const reasons = new Map<string, number>();
  for (const e of index.entries) if (e.audioSkipped) reasons.set(e.audioSkipped, (reasons.get(e.audioSkipped) ?? 0) + 1);
  const hashMs = report.wallMs - report.walkMs;
  const cpuMs = report.cpuUserMs + report.cpuSystemMs;
  const lines = [
    ['Files indexed', `${report.filesIndexed} (${gb(report.totalBytes)} GB)`],
    ['Hashed / reused', `${report.filesHashed} / ${report.filesReused}  (added ${report.filesAdded}, changed ${report.filesChanged}, removed ${report.filesRemoved})`],
    ['Bytes read', `${mb(report.bytesRead)} MB`],
    ['Wall time', `${sec(report.wallMs)} s  (walk ${sec(report.walkMs)} s, hash ${sec(hashMs)} s)`],
    ['Read rate', hashMs > 0 ? `${mb((report.bytesRead / hashMs) * 1000)} MB/s, ${((report.filesHashed / hashMs) * 1000).toFixed(0)} files/s` : '-'],
    ['CPU', `${sec(cpuMs)} s  (user ${sec(report.cpuUserMs)}, system ${sec(report.cpuSystemMs)}; ${pct(cpuMs, report.wallMs)}% of one core)`],
    ['Event loop delay', `p50 ${report.eventLoopDelayMs.p50} ms, p99 ${report.eventLoopDelayMs.p99} ms, max ${report.eventLoopDelayMs.max} ms`],
    ['Index size', `${mb(indexBytes)} MB (${(indexBytes / Math.max(1, report.filesIndexed)).toFixed(0)} bytes per file)`],
    ['PCM audio identity', `${audio} of ${report.filesIndexed} files (${pct(audio, report.filesIndexed)}%)`],
    ['Skipped', `${report.skipped.otherExtensions} other extensions, ${report.skipped.appleDouble} AppleDouble, ${report.skipped.symlinks} symlinks`],
    ['Errors', String(report.errors.length)],
  ];
  for (const [k, v] of lines) console.log(`${k!.padEnd(20)} ${v}`);
  if (reasons.size > 0) {
    console.log('No audio identity, by reason:');
    for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(8)}  ${r}`);
  }
  for (const e of report.errors.slice(0, 10)) console.log(`  error: ${e.message}  ${e.path}`);
}

async function cmdExport(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { index: { type: 'string' }, out: { type: 'string' } } });
  if (!values.index || !values.out) throw new Error(USAGE);
  const index = await loadIndex(values.index);
  if (!index) throw new Error(`no index at ${values.index}; run scan first`);
  const inv = toInventory(index);
  await writeFile(values.out, JSON.stringify(inv));
  console.log(`Wrote ${inv.items.length} items to ${values.out} (${mb((await stat(values.out)).size)} MB). It holds file names, sizes and hashes, and no folders.`);
}

function printTallies(title: string, t: Record<string, Tally>, total: Tally): void {
  console.log(`\n${title}`);
  console.log(`  ${'match'.padEnd(14)} ${'files'.padStart(9)} ${'%'.padStart(6)} ${'unique'.padStart(9)} ${'GB'.padStart(8)}`);
  for (const k of MATCH_KINDS) {
    const x = t[k]!;
    console.log(`  ${k.padEnd(14)} ${String(x.files).padStart(9)} ${pct(x.files, total.files).padStart(6)} ${String(x.unique).padStart(9)} ${gb(x.bytes).padStart(8)}`);
  }
  console.log(`  ${'total'.padEnd(14)} ${String(total.files).padStart(9)} ${'100.0'.padStart(6)} ${String(total.unique).padStart(9)} ${gb(total.bytes).padStart(8)}`);
}

async function cmdCompare(args: string[]): Promise<void> {
  const [a, b] = args;
  if (!a || !b) throw new Error(USAGE);
  const load = async (p: string) => JSON.parse(await readFile(p, 'utf8')) as Inventory;
  const r = compareInventories(await load(a), await load(b));
  printTallies(`Of ${a}, found in ${b}:`, r.aInB, r.aTotal);
  printTallies(`Of ${b}, found in ${a}:`, r.bInA, r.bTotal);
  console.log('\nsame-file: identical bytes. same-audio: identical PCM, different bytes (tags, container).');
  console.log('same-name, copy-number, other-format: name rules only; suggestions to listen to, not matches.');
}

async function cmdNear(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { index: { type: 'string' }, duration: { type: 'string' } } });
  const name = positionals.join(' ');
  if (!values.index || !name) throw new Error(USAGE);
  const index = await loadIndex(values.index);
  if (!index) throw new Error(`no index at ${values.index}`);
  const items = index.entries.map((e: IndexEntry) => {
    const i: { name: string; durationSec?: number; entry: IndexEntry } = { name: e.path.split(/[\\/]/).pop()!, entry: e };
    if (e.audio) i.durationSec = e.audio.frames / e.audio.sampleRate;
    return i;
  });
  const target: { name: string; durationSec?: number } = { name };
  if (values.duration) target.durationSec = Number(values.duration);
  const found = new NearMatcher(items).find(target, 10);
  if (found.length === 0) console.log('No near matches.');
  for (const m of found) {
    const d = m.item.durationSec === undefined ? '' : ` ${m.item.durationSec.toFixed(3)} s`;
    const agree = m.durationAgrees === undefined ? '' : m.durationAgrees ? ' (length agrees)' : ' (length differs)';
    console.log(`${m.rule.padEnd(13)} ${m.item.entry.path}${d}${agree}`);
  }
}

async function cmdGenerate(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { count: { type: 'string' }, offset: { type: 'string', default: '0' }, variants: { type: 'boolean', default: false }, seed: { type: 'string', default: '1' } },
  });
  const [dir] = positionals;
  if (!dir || !values.count) throw new Error(USAGE);
  const t0 = performance.now();
  const s = await generateLibrary(dir, {
    count: Number(values.count),
    offset: Number(values.offset),
    variants: values.variants,
    seed: Number(values.seed),
    onProgress: (n) => n % 10000 === 0 && process.stderr.write(`  ${n} files\n`),
  });
  console.log(`Wrote ${s.files} files, ${gb(s.bytes)} GB, in ${sec(performance.now() - t0)} s`);
  if (Object.keys(s.variants).length > 0) console.log('Variants:', s.variants);
}

const [command, ...rest] = process.argv.slice(2);
const commands: Record<string, (a: string[]) => Promise<void>> = {
  scan: cmdScan,
  export: cmdExport,
  compare: cmdCompare,
  near: cmdNear,
  generate: cmdGenerate,
};
const run = command ? commands[command] : undefined;
if (!run) {
  console.error(USAGE);
  process.exit(2);
}
run(rest).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
