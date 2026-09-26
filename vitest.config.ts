// eslint-disable-next-line import/no-unresolved -- eslint-plugin-import 的解析器不支持 package.json exports
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      include: ['src/main/env-bundle/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test-helper.ts'],
    },
  },
});
