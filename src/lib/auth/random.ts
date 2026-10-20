import crypto from 'node:crypto'

const BASE62_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/**
 * `length` 位 base62 随机串（A–Z a–z 0–9），取自 CSPRNG。
 *
 * 启动密码（password.ts）与 PAT（pat.ts）此前各自抄了一份「randomBytes + 取模」
 * 的实现，e2e 里还有第三份；抽到这里共用，改一处即可。
 *
 * 刻意不加 `server-only`：e2e/auth-env.ts 需要在 Playwright runner（Node）里生成
 * 与 password.ts 完全一致的密码。调用方都在服务端 / Node 环境。
 */
export function randomBase62(length: number): string {
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += BASE62_ALPHABET[bytes[i] % BASE62_ALPHABET.length]
  }
  return out
}
