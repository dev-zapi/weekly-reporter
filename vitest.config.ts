import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    // 默认 2 个 worker：jsdom 进程按核数铺满会把整机吃满（无 CI，测试都在本机跑）。
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 2),
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['node_modules', 'e2e', '.e2e-worker-*'],
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