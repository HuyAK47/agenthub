import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 15000,
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/safety-check.ts'],
    setupFiles: ['./test/test-env.ts'],
  },
});
