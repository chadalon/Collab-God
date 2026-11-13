import { opendir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { HASH_ALGORITHM, hashFile, type AudioIdentity, type HashMode } from './hash.js';

/**
 * Extensions the indexer picks up. The first eight are the ones Studio-One-File-Finder
 * searches; `.aifc` and `.rx2` are the other common spellings of two of them.
 */
export const SAMPLE_EXTENSIONS: readonly string[] = ['.wav', '.aiff', '.aif', '.rex', '.caf', '.ogg', '.flac', '.mp3', '.aifc', '.rx2'];

export const INDEX_FORMAT = 'collabgod-sample-index';
export const INDEX_VERSION = 1;

/**
 * A file modified this close to the end of the scan that hashed it may have changed again
 * within the same timestamp tick (FAT and exFAT store 2-second times). Such entries are hashed
 * again on the next scan, as git does for "racily clean" files.
 */
export const RACY_WINDOW_MS = 2000;

const LOOP_RESOLUTION_MS = 5;
const STAT_BATCH = 64;

export interface IndexEntry {
  /** Absolute local path. Never leaves this machine. */
  path: string;
  size: number;
  mtimeMs: number;
  fileHash?: string;
  audio?: AudioIdentity;
  audioSkipped?: string;
  /** Set when the file could not be read; the entry is retried on the next scan. */
  error?: string;
}

export interface SampleIndex {
  format: typeof INDEX_FORMAT;
  version: typeof INDEX_VERSION;
  hashAlgorithm: typeof HASH_ALGORITHM;
  hashMode: HashMode;
  roots: string[];
  /** When the scan that produced this index started (ms since epoch). */
  scannedAt: number;
  /** Sorted by path. */
  entries: IndexEntry[];
}

export interface ScanProgress {
  phase: 'walk' | 'hash';
  filesFound: number;
  filesHashed: number;
  filesToHash: number;
  bytesRead: number;
}

export interface ScanOptions {
  mode?: HashMode;
  /** Files hashed at once. More helps on SSDs; 1 is kinder to spinning disks. */
  jobs?: number;
  extensions?: readonly string[];
  onProgress?: (p: ScanProgress) => void;
  signal?: AbortSignal;
  /** For tests: the scan's notion of now. */
  now?: () => number;
}

export interface ScanReport {
  filesIndexed: number;
  totalBytes: number;
  /** Files read and hashed in this scan. */
  filesHashed: number;
  /** Files whose size and modified time matched the previous index, so were not read. */
  filesReused: number;
  filesAdded: number;
  filesChanged: number;
  filesRemoved: number;
  /** Bytes actually read from disk while hashing. */
  bytesRead: number;
  /** Paths hashed in this scan, for tests and debugging. */
  hashedPaths: string[];
  errors: Array<{ path: string; message: string }>;
  skipped: { symlinks: number; appleDouble: number; otherExtensions: number };
  walkMs: number;
  wallMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  /** Event loop delay while the scan ran: how long the rest of the app would have waited. */
  eventLoopDelayMs: { p50: number; p99: number; max: number };
}

interface Candidate {
  path: string;
  size: number;
  mtimeMs: number;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.message : String(err);
}

async function walk(
  roots: string[],
  extensions: ReadonlySet<string>,
  report: ScanReport,
  onFound: (n: number) => void,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  const found: Candidate[] = [];
  const stack = [...roots];
  let reported = 0;
  while (stack.length > 0) {
    signal?.throwIfAborted();
    const dir = stack.pop()!;
    const files: string[] = [];
    let handle;
    try {
      handle = await opendir(dir, { bufferSize: 256 });
    } catch (err) {
      report.errors.push({ path: dir, message: errorMessage(err) });
      continue;
    }
    try {
      for await (const d of handle) {
        const path = join(dir, d.name);
        if (d.isSymbolicLink()) {
          // Not followed: links can form loops and can point outside the chosen folders.
          report.skipped.symlinks++;
        } else if (d.isDirectory()) {
          stack.push(path);
        } else if (d.isFile()) {
          if (d.name.startsWith('._')) {
            // macOS AppleDouble files on non-Apple disks: metadata, not audio.
            report.skipped.appleDouble++;
            continue;
          }
          if (!extensions.has(extname(d.name).toLowerCase())) {
            report.skipped.otherExtensions++;
            continue;
          }
          files.push(path);
        }
      }
    } catch (err) {
      report.errors.push({ path: dir, message: errorMessage(err) });
    }
    // Stat a folder's files together; one at a time, the walk is most of a rescan.
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      const batch = files.slice(i, i + STAT_BATCH);
      const stats = await Promise.allSettled(batch.map((f) => stat(f)));
      stats.forEach((r, j) => {
        const path = batch[j]!;
        if (r.status === 'fulfilled') found.push({ path, size: r.value.size, mtimeMs: r.value.mtimeMs });
        else report.errors.push({ path, message: errorMessage(r.reason) });
      });
    }
    if (Math.floor(found.length / 1000) > reported) {
      reported = Math.floor(found.length / 1000);
      onFound(found.length);
    }
  }
  return found;
}

/** Whether a previous entry can be reused without reading the file. */
function reusable(prev: IndexEntry | undefined, c: Candidate, previous: SampleIndex | undefined, mode: HashMode): prev is IndexEntry {
  if (!prev || !previous || previous.hashMode !== mode) return false;
  if (prev.error !== undefined) return false;
  if (prev.size !== c.size || prev.mtimeMs !== c.mtimeMs) return false;
  // Racily clean: modified so close to the last scan that a later change could share its timestamp.
  if (prev.mtimeMs >= previous.scannedAt - RACY_WINDOW_MS) return false;
  return true;
}

/**
 * Scans `roots` and returns a new index. With a previous index, a file is read only if it is
 * new, its size or modified time changed, its last read failed, or it was racily clean.
 */
export async function scan(
  rootsIn: string[],
  previous?: SampleIndex,
  options: ScanOptions = {},
): Promise<{ index: SampleIndex; report: ScanReport }> {
  const mode = options.mode ?? 'both';
  const jobs = Math.max(1, options.jobs ?? 4);
  const extensions = new Set((options.extensions ?? SAMPLE_EXTENSIONS).map((e) => e.toLowerCase()));
  const now = options.now ?? Date.now;
  const roots = [...new Set(rootsIn.map((r) => resolve(r)))];

  const report: ScanReport = {
    filesIndexed: 0,
    totalBytes: 0,
    filesHashed: 0,
    filesReused: 0,
    filesAdded: 0,
    filesChanged: 0,
    filesRemoved: 0,
    bytesRead: 0,
    hashedPaths: [],
    errors: [],
    skipped: { symlinks: 0, appleDouble: 0, otherExtensions: 0 },
    walkMs: 0,
    wallMs: 0,
    cpuUserMs: 0,
    cpuSystemMs: 0,
    eventLoopDelayMs: { p50: 0, p99: 0, max: 0 },
  };

  const scannedAt = now();
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  const loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  loop.enable();
  const progress: ScanProgress = { phase: 'walk', filesFound: 0, filesHashed: 0, filesToHash: 0, bytesRead: 0 };

  try {
    options.onProgress?.(progress);
    const candidates = await walk(roots, extensions, report, (n) => {
      progress.filesFound = n;
      options.onProgress?.(progress);
    }, options.signal);
    report.walkMs = performance.now() - t0;

    const prevByPath = new Map((previous?.entries ?? []).map((e) => [e.path, e]));
    const entries: IndexEntry[] = [];
    const toHash: Candidate[] = [];
    for (const c of candidates) {
      const prev = prevByPath.get(c.path);
      prevByPath.delete(c.path);
      if (reusable(prev, c, previous, mode)) {
        entries.push(prev);
        report.filesReused++;
      } else {
        toHash.push(c);
        if (prev) report.filesChanged++;
        else report.filesAdded++;
      }
    }
    // Whatever is left was in the previous index under one of these roots and is now gone.
    const rootPrefixes = roots.map((r) => (r.endsWith('/') || r.endsWith('\\') ? r : r + (r.includes('\\') ? '\\' : '/')));
    for (const p of prevByPath.keys()) {
      if (rootPrefixes.some((r) => p.startsWith(r))) report.filesRemoved++;
    }

    progress.phase = 'hash';
    progress.filesFound = candidates.length;
    progress.filesToHash = toHash.length;
    options.onProgress?.(progress);

    let next = 0;
    const worker = async () => {
      while (next < toHash.length) {
        options.signal?.throwIfAborted();
        const c = toHash[next++]!;
        const entry: IndexEntry = { path: c.path, size: c.size, mtimeMs: c.mtimeMs };
        try {
          const r = await hashFile(c.path, { mode });
          if (r.fileHash !== undefined) entry.fileHash = r.fileHash;
          if (r.audio) entry.audio = r.audio;
          if (r.audioSkipped !== undefined) entry.audioSkipped = r.audioSkipped;
          report.bytesRead += r.bytesRead;
          progress.bytesRead = report.bytesRead;
        } catch (err) {
          entry.error = errorMessage(err);
          report.errors.push({ path: c.path, message: entry.error });
        }
        entries.push(entry);
        report.filesHashed++;
        report.hashedPaths.push(c.path);
        progress.filesHashed = report.filesHashed;
        if (report.filesHashed % 200 === 0) options.onProgress?.(progress);
      }
    };
    await Promise.all(Array.from({ length: jobs }, worker));
    options.onProgress?.(progress);

    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    report.filesIndexed = entries.length;
    report.totalBytes = entries.reduce((n, e) => n + e.size, 0);

    const index: SampleIndex = {
      format: INDEX_FORMAT,
      version: INDEX_VERSION,
      hashAlgorithm: HASH_ALGORITHM,
      hashMode: mode,
      roots,
      scannedAt,
      entries,
    };
    return { index, report };
  } finally {
    loop.disable();
    const cpu = process.cpuUsage(cpu0);
    report.cpuUserMs = cpu.user / 1000;
    report.cpuSystemMs = cpu.system / 1000;
    report.wallMs = performance.now() - t0;
    // The histogram holds the time between ticks; subtract the tick to get the delay.
    const ms = (ns: number) => (Number.isFinite(ns) ? Math.max(0, Math.round((ns / 1e6 - LOOP_RESOLUTION_MS) * 100) / 100) : 0);
    report.eventLoopDelayMs = { p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max) };
  }
}
