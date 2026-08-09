import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Offline guarantee: tests must never hit the network. The real Gemini
    // adapter is only constructed when GEMINI_API_KEY is set; tests never set it.
    env: { GEMINI_API_KEY: '' },
    testTimeout: 20_000,
  },
});
