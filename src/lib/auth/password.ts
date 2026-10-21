import 'server-only'
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_DIR, ensureConfigDir } from '@/lib/paths'
import { randomBase62 } from './random'

/**
 * 启动密码（Startup Password）
 *
 * 服务端首次启动时随机生成、写入 `~/.config/weekly-reporter/auth.json`。
 * 明文存盘是刻意的：单用户个人系统，威胁模型是「别人拿到这台机器的磁盘」，
 * 而 PAT 面向会跨机器传递的脚本凭据，故 PAT 存哈希、密码存明文。
 */

const PASSWORD_LENGTH = 48
const AUTH_FILE_NAME = 'auth.json'

export interface MachineCredential {
  baseUrl?: string
  pat?: string
}

export interface AuthConfig {
  password?: string
  machine?: MachineCredential
}

export function getAuthConfigPath(): string {
  return path.join(CONFIG_DIR, AUTH_FILE_NAME)
}

function generatePassword(): string {
  return randomBase62(PASSWORD_LENGTH)
}

function readAuthConfig(): AuthConfig | null {
  try {
    const raw = fs.readFileSync(getAuthConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as AuthConfig
  } catch {
    // 文件不存在 / 损坏 / 读失败都按「没有密码」处理，绝不抛出。
    return null
  }
}

function writeAuthConfig(config: AuthConfig): void {
  ensureConfigDir()
  const target = getAuthConfigPath()
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  // writeFile 的 mode 同样受 umask 影响，显式 chmod 保证 600。
  fs.chmodSync(target, 0o600)
}

/**
 * 读取当前启动密码；文件缺失 / 损坏 / 字段为空时返回 null。
 */
export function readStartupPassword(): string | null {
  const config = readAuthConfig()
  const password = config?.password
  if (typeof password !== 'string' || password.length === 0) return null
  return password
}

/**
 * 确保启动密码存在：仅当文件缺失或 `password` 字段缺失/为空时生成。
 * 已存在则跨重启稳定，重复调用返回同一个密码。
 */
export async function ensureStartupPassword(): Promise<string> {
  const existing = readStartupPassword()
  if (existing) return existing

  const password = generatePassword()
  const config = readAuthConfig() ?? {}
  writeAuthConfig({ ...config, password })
  return password
}

/**
 * 读改写语义地更新机器级凭据，保留同文件的 `password` 字段。
 */
export function updateMachineCredential(update: Partial<MachineCredential>): void {
  const config = readAuthConfig() ?? {}
  writeAuthConfig({ ...config, machine: { ...config.machine, ...update } })
}

export function readMachineCredential(): MachineCredential | null {
  return readAuthConfig()?.machine ?? null
}
