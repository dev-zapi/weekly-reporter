import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { expandInputPath } from '@/lib/collect/paths'
// Runtime-only fs/path — loaded via eval('require') so NFT static analysis
// cannot trace the dynamic filesystem operations on user-provided paths.
// Type-only imports are erased at compile time and do not affect tracing.
import type {
  readdirSync as readdirSyncType,
  statSync as statSyncType,
  existsSync as existsSyncType,
} from 'fs'
import type {
  resolve as resolveType,
  dirname as dirnameType,
  basename as basenameType,
} from 'path'

// eslint-disable-next-line @typescript-eslint/no-require-imports, no-eval
const fs = eval('require')('fs') as {
  readdirSync: typeof readdirSyncType
  statSync: typeof statSyncType
  existsSync: typeof existsSyncType
}
// eslint-disable-next-line @typescript-eslint/no-require-imports, no-eval
const path = eval('require')('path') as {
  resolve: typeof resolveType
  dirname: typeof dirnameType
  basename: typeof basenameType
}

const ALLOWED_BASE_DIRS = (() => {
  const dirs = new Set([
    process.env.HOME,
    '/home',
    '/opt',
    '/srv',
    '/var',
    '/tmp',
  ])
  dirs.delete(undefined)
  return [...dirs] as string[]
})()

function isPathAllowed(inputPath: string): boolean {
  const resolvedPath = path.resolve(inputPath)
  return ALLOWED_BASE_DIRS.some(baseDir =>
    resolvedPath === baseDir || resolvedPath.startsWith(baseDir + '/')
  )
}

function fuzzyMatch(name: string, query: string): boolean {
  const lowerName = name.toLowerCase()
  const lowerQuery = query.toLowerCase()
  if (lowerName.includes(lowerQuery)) return true
  let qi = 0
  for (let ni = 0; ni < lowerName.length && qi < lowerQuery.length; ni++) {
    if (lowerName[ni] === lowerQuery[qi]) qi++
  }
  return qi === lowerQuery.length
}

function fuzzyScore(name: string, query: string): number {
  const lowerName = name.toLowerCase()
  const lowerQuery = query.toLowerCase()
  if (lowerName === lowerQuery) return 100
  if (lowerName.startsWith(lowerQuery)) return 90
  if (lowerName.includes(lowerQuery)) return 80
  let qi = 0
  let consecutive = 0
  let maxConsecutive = 0
  let lastMatch = -2
  for (let ni = 0; ni < lowerName.length && qi < lowerQuery.length; ni++) {
    if (lowerName[ni] === lowerQuery[qi]) {
      if (ni === lastMatch + 1) { consecutive++; maxConsecutive = Math.max(maxConsecutive, consecutive) }
      else { consecutive = 1 }
      lastMatch = ni
      qi++
    }
  }
  if (qi < lowerQuery.length) return -1
  return maxConsecutive * 10 + (lowerName.length - lowerQuery.length)
}

function findExistingBase(inputPath: string): { basePath: string; query: string } | null {
  let current = inputPath
  const segments: string[] = []
  while (current !== '/' && current !== '') {
    const base = path.basename(current)
    if (base) segments.unshift(base)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  let lastExistingIndex = -1
  let lastExistingPath = ''
  for (let i = 0; i < segments.length; i++) {
    const testPath = i === 0 ? (segments[0].startsWith('/') ? segments[0] : '/' + segments[0]) : path.resolve('/', ...segments.slice(0, i + 1))
    if (fs.existsSync(testPath)) {
      const stats = fs.statSync(testPath)
      if (stats.isDirectory()) {
        lastExistingIndex = i
        lastExistingPath = testPath
      }
    }
  }
  if (lastExistingIndex >= 0) {
    const query = segments.slice(lastExistingIndex + 1).join('/')
    return { basePath: lastExistingPath, query }
  }
  return null
}

function collectDirs(basePath: string, query: string, maxDepth: number = 3, currentDepth: number = 0): { name: string; path: string; score: number }[] {
  if (currentDepth >= maxDepth) return []
  const results: { name: string; path: string; score: number }[] = []
  try {
    const entries = fs.readdirSync(basePath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      const fullPath = path.resolve(basePath, entry.name)
      const score = fuzzyScore(entry.name, query)
      if (score >= 0) {
        results.push({ name: entry.name, path: fullPath, score })
      } else {
        const nested = collectDirs(fullPath, query, maxDepth, currentDepth + 1)
        results.push(...nested)
      }
    }
  } catch { /* skip inaccessible dirs */ }
  return results
}

export const GET = withAuth(async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const raw = searchParams.get('path') || ''
    // 路径展开后必为绝对路径
    let input = expandInputPath(raw)
    // 空输入或裸 ~：视为列出 $HOME 内容（结尾 / 表示「列出该目录内容」）
    if (raw.trim() === '' || raw.trim() === '~') input += '/'

    // 1. 解析输入：最后一个 / 分割为 basePath 和 query
    let basePath: string
    let query: string
    let exists = false

    const lastSlash = input.lastIndexOf('/')
    if (lastSlash === 0) {
      basePath = '/'
      query = input.slice(1)
    } else {
      basePath = input.slice(0, lastSlash) || '/'
      query = input.slice(lastSlash + 1)
    }

    const resolvedBase = path.resolve(basePath)
    if (!isPathAllowed(resolvedBase)) {
      return NextResponse.json(
        { error: '不允许访问此目录', code: 'FORBIDDEN' },
        { status: 403 }
      )
    }

    if (fs.existsSync(resolvedBase) && fs.statSync(resolvedBase).isDirectory()) {
      exists = true
    }

    // 2. basePath 存在：列出子目录，如有 query 则做模糊过滤
    if (exists) {
      const entries = fs.readdirSync(resolvedBase, { withFileTypes: true })
      const allDirs = entries
        .filter(entry => entry.isDirectory())
        .filter(entry => !entry.name.startsWith('.') || entry.name === '.')
        .map(entry => ({
          name: entry.name,
          path: path.resolve(resolvedBase, entry.name),
        }))

      const directories = query
        ? allDirs
            .map(d => ({ ...d, score: fuzzyScore(d.name, query) }))
            .filter(d => d.score >= 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 50)
        : allDirs.slice(0, 50)

      return NextResponse.json({
        directories,
        path: resolvedBase,
        exists: true,
      })
    }

    // 3. basePath 不存在：向上找最近的存在的祖先目录，模糊搜索剩余部分
    const found = findExistingBase(resolvedBase)
    if (!found) {
      return NextResponse.json({ directories: [], path: resolvedBase, exists: false })
    }

    // 将 query 与路径中不存在的部分合并作为模糊搜索词
    const nonExistingTail = resolvedBase.slice(found.basePath.length).replace(/^\//, '')
    const fullQuery = nonExistingTail
      ? [nonExistingTail, query].filter(Boolean).join('/')
      : query

    if (!fullQuery.trim()) {
      return NextResponse.json({ directories: [], path: resolvedBase, exists: false })
    }

    if (!isPathAllowed(found.basePath)) {
      return NextResponse.json(
        { error: '不允许访问此目录', code: 'FORBIDDEN' },
        { status: 403 }
      )
    }

    const matched = collectDirs(found.basePath, fullQuery)
    matched.sort((a, b) => b.score - a.score)
    const directories = matched.slice(0, 50).map(m => ({ name: m.name, path: m.path }))

    return NextResponse.json({
      directories,
      path: resolvedBase,
      exists: false,
      fuzzyQuery: fullQuery,
      fuzzyBase: found.basePath,
    })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EACCES') {
      return NextResponse.json(
        { error: '无权限访问此目录', code: 'ACCESS_DENIED' },
        { status: 403 }
      )
    }
    return NextResponse.json(
      { error: '扫描目录失败', code: 'SCAN_ERROR' },
      { status: 500 }
    )
  }
})