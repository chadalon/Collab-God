// Bundles the page into dist/, which the C++ host serves to the web view.
//   node build.mjs           build once
//   node build.mjs --watch   rebuild on change; press R in the app to reload

import { build, context } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';

const dist = new URL('./dist/', import.meta.url);
const watch = process.argv.includes('--watch');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await copyFile(new URL('./index.html', import.meta.url), new URL('index.html', dist));
await copyFile(new URL('./style.css', import.meta.url), new URL('style.css', dist));

const options = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'esm',
  // Safari 16 is the oldest WebKit on macOS 13; WebView2 is current Chromium.
  target: ['safari16', 'chrome120'],
  sourcemap: true,
  outfile: 'dist/app.js',
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
