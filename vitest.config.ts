import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['node_modules', 'e2e'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // The real `server-only` marker throws on import outside an RSC; tests run
      // in plain node, so alias it to a no-op (production guard is enforced by
      // Next.js at build time).
      'server-only': path.resolve(__dirname, './src/test/server-only-stub.ts'),
    },
  },
})