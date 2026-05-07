import { defineConfig } from 'vitest/config';

// Most StructX tests parse real TypeScript files end-to-end through ts-morph,
// which on Windows under parallel test load can exceed vitest's 5s default.
// Bumping the per-test timeout to 30s keeps us conservative without enabling
// any slow-test pathology to hide behind it — anything truly stuck still
// fails inside this window.
export default defineConfig({
  test: {
    testTimeout: 30000,
  },
});
