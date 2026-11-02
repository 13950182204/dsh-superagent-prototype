import { defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests, and bound the number of forked test processes: the suite
// drives real timers, SQLite and child processes, and timing-based tests miss their waits when many run at once.
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: { include: ['tests/**/*.spec.{ts,tsx}'], poolOptions: { forks: { maxForks: 4 } } },
})
