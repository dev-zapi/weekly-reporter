import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'
import { nextWebServerCommand, webServerTimeout } from './next-server'
import {
  AUTH_E2E_BASE_URL,
  AUTH_E2E_PORT,
  AUTH_XDG_CONFIG_HOME,
  AUTH_XDG_DATA_HOME,
  resetAuthE2eRoot,
  preparePassword,
} from './auth-env'

// 在 runner 进程中跑一次（早于 webServer 插件启动）。清理旧的 XDG 目录，
// 然后预生成一份启动密码。降级到 dev + webpack 时 instrumentation.register()
// 实测不会在 Playwright 启动的 server 中触发，故由测试侧按 password.ts 同样
// 的算法写 auth.json。服务端 `ensureStartupPassword` 启动后读到已有密码会
// 直接返回，行为与原生流程一致（默认的生产模式同样如此）。
resetAuthE2eRoot()
preparePassword()

// 这个配置文件位于 e2e/ 子目录，Playwright 会把 webServer 的默认 cwd 设为
// configDir（即 e2e/），导致 Next 找不到 src/app。显式指回项目根目录。
const PROJECT_ROOT = path.resolve(__dirname, '..')

export default defineConfig({
  testDir: '.',
  testMatch: '**/auth.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',

  use: {
    baseURL: AUTH_E2E_BASE_URL,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: nextWebServerCommand(AUTH_E2E_PORT),
    url: AUTH_E2E_BASE_URL,
    reuseExistingServer: false,
    timeout: webServerTimeout(),
    cwd: PROJECT_ROOT,
    env: {
      // 与默认配置不同的 XDG 目录：隔离 auth 套件的数据与密码文件
      XDG_DATA_HOME: AUTH_XDG_DATA_HOME,
      XDG_CONFIG_HOME: AUTH_XDG_CONFIG_HOME,
      E2E_FIXTURES: '1',
      // 与默认套件同样的 Next server 堆上限（见 playwright.config.ts / README）。
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--max-old-space-size=${process.env.E2E_DEV_MEM ?? 4096}`]
        .filter(Boolean)
        .join(' '),
      // 注意：刻意不设置 WR_AUTH_DISABLED——认证开启模式
    },
  },
})
