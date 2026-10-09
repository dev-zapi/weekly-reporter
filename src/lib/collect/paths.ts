import { isAbsolute, resolve } from 'path'

/**
 * Strip trailing slashes from a path, preserving the root `/`.
 * Used by both the validation transform (落库 owner 不带结尾斜杠) and the
 * lookup route (so `~/repo/` matches a stored `/home/user/repo`).
 */
export function stripTrailingSlash(p: string): string {
  return p.replace(/(.)\/+$/, '$1')
}

/**
 * 路径展开：把用户输入的目录路径解释为绝对路径。规则（见 CONTEXT.md「路径展开」）：
 * - `~` 或 `~/` 开头 → 展开为 $HOME（不支持 ~user 形式）
 * - 相对路径 → 解析到 $HOME 下
 * - 绝对路径 → 原样使用
 * 返回值经 resolve 规范化，但保留用户输入的结尾斜杠——
 * 调用方（如目录补全）用它区分「列出该目录内容」。
 */
export function expandInputPath(input: string): string {
  const home = process.env.HOME || '/home'
  const trimmed = input.trim()
  const expanded =
    trimmed === '~' ? home
    : trimmed.startsWith('~/') ? resolve(home, trimmed.slice(2))
    : isAbsolute(trimmed) ? resolve(trimmed)
    : resolve(home, trimmed)
  return trimmed.endsWith('/') && expanded !== '/' ? expanded + '/' : expanded
}
