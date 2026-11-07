import { defineConfig, devices } from '@playwright/test'
import { goWebServerCommand, goWebServerTimeout } from './go-server'
import {
  AUTH_E2E_BASE_URL,
  AUTH_E2E_PORT,
  AUTH_XDG_CONFIG_HOME,
  AUTH_XDG_DATA_HOME,
  resetAuthE2eRoot,
  preparePassword,
} from './auth-env'

// 在 runner 进程中跑一次（早于 webServer 插件启动）。清理旧的 XDG 目录，
// 然后预生成一份启动密码。测试侧按 password.ts 同样的算法写 auth.json；
// 服务端 `ensureStartupPassword` 启动后读到已有密码会直接返回，行为与
// 原生流程一致（Go 侧 auth.Options{PasswordPath} 读同一 XDG 语义）。
resetAuthE2eRoot()
preparePassword()

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
    // cutover 后唯一实现：Go 单二进制。命令与 cwd 无关（make -C 绝对根），
    // 不再需要 Next 时代的 cwd=PROJECT_ROOT 补偿。
    command: goWebServerCommand(AUTH_E2E_PORT),
    url: AUTH_E2E_BASE_URL,
    reuseExistingServer: false,
    timeout: goWebServerTimeout(),
    env: {
      // 与默认配置不同的 XDG 目录：隔离 auth 套件的数据与密码文件
      XDG_DATA_HOME: AUTH_XDG_DATA_HOME,
      XDG_CONFIG_HOME: AUTH_XDG_CONFIG_HOME,
      E2E_FIXTURES: '1',
      // 注意：刻意不设置 WR_AUTH_DISABLED——认证开启模式
    },
  },
})
