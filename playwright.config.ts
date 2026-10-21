import { defineConfig, devices } from '@playwright/test'
import path from 'path'
import os from 'os'
import { randomUUID } from 'node:crypto'
import { nextWebServerCommand } from './e2e/next-server'

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
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',

  use: {
    baseURL: 'http://127.0.0.1:3100',
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
    timeout: 120 * 1000,
    env: {
      // 使用临时目录隔离测试数据，避免污染生产数据库
      XDG_DATA_HOME: path.join(os.tmpdir(), `weekly-reporter-e2e-data-${e2eRunId}`),
      XDG_CONFIG_HOME: path.join(os.tmpdir(), `weekly-reporter-e2e-config-${e2eRunId}`),
      E2E_FIXTURES: '1',
      // 默认关闭认证：现有 spec 不受认证改造影响（与 vitest 的 setup.ts 对齐）。
      // 认证开启场景见 e2e/auth.config.ts。
      WR_AUTH_DISABLED: '1',
    },
  },
})
