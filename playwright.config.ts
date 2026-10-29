import { defineConfig, devices } from '@playwright/test'
import path from 'path'
import os from 'os'
import { randomUUID } from 'node:crypto'
import { nextWebServerCommand, webServerTimeout } from './e2e/next-server'

const e2eRunId = randomUUID()

/**
 * Playwright 配置
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './e2e',
  // 认证专项用例在独立的 e2e/auth.config.ts 下跑（认证开启）。这里显式忽略，
  // 避免默认套件（WR_AUTH_DISABLED=1）把它一起跑了导致断言失败。
  testIgnore: /auth\.spec\.ts$/,
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // 默认串行：本机 20 核跑默认并发（~10 worker）时每个 worker 一个 Chromium，
  // 加上 dev server 会把内存打满并触发 OOM（连累无关进程）。需要并发时显式提高。
  workers: process.env.CI ? 1 : Number(process.env.E2E_WORKERS ?? 1),
  reporter: 'html',

  use: {
    baseURL: 'http://127.0.0.1:3100',
    // 固定 locale：specs 断言本地化文案（如报告卡片的 Intl medium 日期
    // 「Jan 8, 2024」）。无头 Chromium 默认就是 en-US，这里显式钉住，
    // 断言不随宿主环境漂移。
    locale: 'en-US',
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: nextWebServerCommand(3100),
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: false,
    timeout: webServerTimeout(),
    env: {
      // 使用临时目录隔离测试数据，避免污染生产数据库
      XDG_DATA_HOME: path.join(os.tmpdir(), `weekly-reporter-e2e-data-${e2eRunId}`),
      XDG_CONFIG_HOME: path.join(os.tmpdir(), `weekly-reporter-e2e-config-${e2eRunId}`),
      E2E_FIXTURES: '1',
      // 默认关闭认证：现有 spec 不受认证改造影响（与 vitest 的 setup.ts 对齐）。
      // 认证开启场景见 e2e/auth.config.ts。
      WR_AUTH_DISABLED: '1',
      // 限制 dev server 的 V8 堆，与 L3 的 cgroup 上限（scripts/run-e2e.mjs）互补：
      // 堆上限让 Node 先自行 GC/崩溃，而不是一路涨到 cgroup 才被 OOM kill。
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--max-old-space-size=${process.env.E2E_DEV_MEM ?? 4096}`]
        .filter(Boolean)
        .join(' '),
    },
  },
})
