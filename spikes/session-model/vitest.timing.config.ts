import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['bench/**/*.timing.ts'], testTimeout: 120_000 } });
