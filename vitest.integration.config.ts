import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test/integration/**/*.test.ts'],
    globals: true,
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 30000,
    pool: 'forks',
  },
});
