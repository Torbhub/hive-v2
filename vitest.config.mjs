import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'web') } },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    maxWorkers: 2,
    environmentMatchGlobs: [[
      'test/{branches-ui,decision-card,dictation,logview-ui,media-recorder,webapp,worktree}.test.tsx',
      'jsdom',
    ]],
  },
});
