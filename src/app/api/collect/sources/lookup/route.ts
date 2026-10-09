import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { collectSources } from '@/lib/db/schema'
import { expandInputPath, stripTrailingSlash } from '@/lib/collect/paths'
import { tryRealpath } from '@/lib/collect/realpath'

// git-local sources are identified by `config.owner` = normalized local absolute
// path (see CONTEXT.md「本地来源路径查找」). Lookup accepts the same path
// shapes users type into the form and resolves symlinks on both sides when
// they exist on disk.

// Match precedence (accepted interpretation, do not change without spec review):
//   1. Exact normalized-path match across all git-local sources.
//   2. Realpath-equivalence, only attempted when both input and stored owner
//      resolve on disk.
// Within each pass, earliest id wins.

function jsonResponse(source: typeof collectSources.$inferSelect) {
  return NextResponse.json({
    ...source,
    config: {
      ...source.config,
      token: '[ENCRYPTED]',
    },
  })
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const rawType = searchParams.get('type')
    const rawPath = searchParams.get('path')

    // Spec: type MUST be exactly 'git-local'. Anything else → 400 INVALID_TYPE.
    if (rawType !== 'git-local') {
      return NextResponse.json(
        { error: '仅支持本地 Git 来源', code: 'INVALID_TYPE' },
        { status: 400 }
      )
    }

    if (!rawPath || !rawPath.trim()) {
      return NextResponse.json(
        { error: 'path is required', code: 'INVALID_PATH' },
        { status: 400 }
      )
    }

    const db = getDb()

    // Mirror the create-path normalization (expandInputPath + strip trailing
    // slash) so `~/repo/` matches a stored `/home/user/repo`.
    const normalizedPath = stripTrailingSlash(expandInputPath(rawPath))

    // Try realpath on the input — if it doesn't exist on disk we still do a
    // string-only match (sync owns path validation, not lookup).
    const candidateRealpath = await tryRealpath(normalizedPath)

    const localSources = await db.query.collectSources.findMany({
      where: eq(collectSources.type, 'git-local'),
    })

    // Earliest id wins when multiple sources match — sort ascending once.
    const sorted = [...localSources].sort((a, b) => a.id - b.id)

    // Pass 1: exact string match. Cheaper and what the spec prioritizes.
    for (const source of sorted) {
      const owner = (source.config?.owner as string | undefined) || ''
      if (owner === normalizedPath) return jsonResponse(source)
    }

    // Pass 2: realpath-equivalence, only attempted when both sides resolve.
    if (candidateRealpath !== null) {
      for (const source of sorted) {
        const owner = (source.config?.owner as string | undefined) || ''
        if (!owner) continue
        const ownerRealpath = await tryRealpath(owner)
        if (ownerRealpath !== null && ownerRealpath === candidateRealpath) {
          return jsonResponse(source)
        }
      }
    }

    return NextResponse.json(
      { error: '采集源不存在', code: 'NOT_FOUND' },
      { status: 404 }
    )
  } catch (error) {
    console.error('[API] Failed to lookup collect source:', error)
    return NextResponse.json(
      { error: '查询采集源失败', code: 'LOOKUP_ERROR' },
      { status: 500 }
    )
  }
}
