import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { expandInputPath } from '@/lib/collect/paths'
import { getDb } from '@/lib/db'
import { collectSources } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { getCurrentBranch } from '@/lib/collect/adapters/local-git-adapter'

const execFileAsync = promisify(execFile)

export const GET = withAuth(async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const type = searchParams.get('type') || ''
    const path = searchParams.get('path') ? expandInputPath(searchParams.get('path')!) : ''
    const owner = searchParams.get('owner') || ''
    const repo = searchParams.get('repo') || ''
    const token = searchParams.get('token') || ''
    const baseUrl = searchParams.get('baseUrl') || ''
    const sourceId = Number(searchParams.get('sourceId') || '')

    let branches: string[] = []
    let currentBranch = ''

    if (Number.isInteger(sourceId) && sourceId > 0) {
      const db = getDb()
      const source = await db.query.collectSources.findFirst({ where: eq(collectSources.id, sourceId) })
      if (source) {
        if (!token && source.config.token) {
          // Existing edit forms never receive the stored token; use it only server-side.
          searchParams.set('token', source.config.token)
        }
      }
    }

    const effectiveToken = searchParams.get('token') || token

    if (type === 'git-local' && path) {
      branches = await getLocalBranches(path)
      currentBranch = await getCurrentBranch(path)
    } else if (type === 'git-remote-github' && owner && repo && effectiveToken) {
      branches = await getGitHubBranches(owner, repo, effectiveToken)
    } else if (type === 'git-remote-gitlab' && owner && repo && effectiveToken) {
      branches = await getGitLabBranches(owner, repo, effectiveToken, baseUrl)
    } else if (type === 'git-remote-gitee' && owner && repo && effectiveToken) {
      branches = await getGiteeBranches(owner, repo, effectiveToken)
    }

    return NextResponse.json({ branches, currentBranch })
  } catch {
    return NextResponse.json({ branches: [] })
  }
})

async function getLocalBranches(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '-a', '--format=%(refname:short)'], {
      cwd: repoPath,
      maxBuffer: 1024 * 1024,
    })
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(b => b.replace(/^origin\//, ''))
      .filter((b, i, arr) => arr.indexOf(b) === i) // dedupe
      .sort()
  } catch {
    return []
  }
}

async function getGitHubBranches(owner: string, repo: string, token: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    )
    if (!res.ok) return []
    const data = (await res.json()) as Array<{ name: string }>
    return data.map(b => b.name).sort()
  } catch {
    return []
  }
}

async function getGitLabBranches(owner: string, repo: string, token: string, baseUrl?: string): Promise<string[]> {
  const host = baseUrl || 'https://gitlab.com'
  const projectPath = encodeURIComponent(`${owner}/${repo}`)
  try {
    const res = await fetch(
      `${host}/api/v4/projects/${projectPath}/repository/branches?per_page=100`,
      { headers: { 'PRIVATE-TOKEN': token } }
    )
    if (!res.ok) return []
    const data = (await res.json()) as Array<{ name: string }>
    return data.map(b => b.name).sort()
  } catch {
    return []
  }
}

async function getGiteeBranches(owner: string, repo: string, token: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://gitee.com/api/v5/repos/${owner}/${repo}/branches?per_page=100&access_token=${token}`,
      {
        headers: { Accept: 'application/json' },
      }
    )
    if (!res.ok) return []
    const data = (await res.json()) as Array<{ name: string }>
    return data.map(b => b.name).sort()
  } catch {
    return []
  }
}
