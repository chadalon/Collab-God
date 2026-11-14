import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { INDEX_FORMAT, INDEX_VERSION, type SampleIndex } from './scan.js';

/**
 * Loads an index. Returns undefined when there is none or it is from another format version,
 * in which case the caller does a full scan.
 */
export async function loadIndex(path: string): Promise<SampleIndex | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return undefined;
    throw err;
  }
  const data = JSON.parse(text) as Partial<SampleIndex>;
  if (data.format !== INDEX_FORMAT || data.version !== INDEX_VERSION || !Array.isArray(data.entries)) return undefined;
  return data as SampleIndex;
}

/** Writes to a temporary file and renames it over the old one, so a crash never leaves half an index. */
export async function saveIndex(path: string, index: SampleIndex): Promise<number> {
  const text = JSON.stringify(index);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return Buffer.byteLength(text);
}
