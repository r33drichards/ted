import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000, // Temporal test env can be slow to boot
    hookTimeout: 30_000,
  },
});
