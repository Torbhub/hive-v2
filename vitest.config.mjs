import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    maxWorkers: 2,
    environmentMatchGlobs: [[
      'test/{branches-ui,decision-card,dictation,logview-ui,media-recorder,webapp,worktree}.test.tsx',
      'jsdom',
    ]],
  },
});
