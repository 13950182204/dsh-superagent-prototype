import { defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests, and bound the number of forked test processes: the suite
// drives real timers, SQLite and child processes, and timing-based tests miss their waits when many run at once, so the
// per-test deadline allows for a loaded machine, and a test whose wait a loaded machine undercuts is retried once.
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: { include: ['tests/**/*.spec.{ts,tsx}'], maxWorkers: 3, testTimeout: 20_000, retry: 1 },
})
