import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['integration/**/*.browser.test.ts'],
    environment: 'node',
    testTimeout: 45000,
    hookTimeout: 10000,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
