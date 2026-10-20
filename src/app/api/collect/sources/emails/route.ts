import { withAuth } from '@/lib/auth/guard'
import { NextResponse } from 'next/server'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { expandInputPath } from '@/lib/collect/paths'

const execFileAsync = promisify(execFile)

interface AuthorInfo {
  email: string
  name: string
  count: number
}

export const GET = withAuth(async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const type = searchParams.get('type') || ''
    const path = searchParams.get('path') || ''
    const owner = searchParams.get('owner') || ''
    const repo = searchParams.get('repo') || ''
    const token = searchParams.get('token') || ''
    const baseUrl = searchParams.get('baseUrl') || ''
    const branch = searchParams.get('branch') || ''

    let authors: AuthorInfo[] = []

    if (type === 'git-local' && path) {
      authors = await getLocalAuthors(expandInputPath(path), branch)
    } else if (type === 'git-remote-github' && owner && repo && token) {
      authors = await getGitHubAuthors(owner, repo, token)
    } else if (type === 'git-remote-gitlab' && owner && repo && token) {
      authors = await getGitLabAuthors(owner, repo, token, baseUrl)
    }

    return NextResponse.json({ authors })
  } catch {
    return NextResponse.json({ authors: [] })
  }
})

async function getLocalAuthors(repoPath: string, branch?: string): Promise<AuthorInfo[]> {
  const args = ['log', '--pretty=format:%ae\t%an', '--no-merges', '-300']
  if (branch) args.push(branch)
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoPath,
      maxBuffer: 1024 * 1024,
    })
    const map = new Map<string, { name: string; count: number }>()
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const [email, name] = line.split('\t')
      if (!email) continue
      const existing = map.get(email)
      if (existing) {
        existing.count++
      } else {
        map.set(email, { name: name || email, count: 1 })
      }
    }
    return [...map.entries()]
      .map(([email, { name, count }]) => ({ email, name, count }))
      .sort((a, b) => b.count - a.count)
  } catch {
    return []
  }
}

async function getGitHubAuthors(owner: string, repo: string, token: string): Promise<AuthorInfo[]> {
  const map = new Map<string, { name: string; count: number }>()
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    )
    if (!res.ok) return []
    const commits = (await res.json()) as Array<{
      author?: { email?: string; login?: string }
      commit?: { author?: { email?: string; name?: string } }
    }>
    for (const c of commits) {
      const email = c.author?.email || c.commit?.author?.email
      const name = c.commit?.author?.name || c.author?.login || email || ''
      if (!email) continue
      const existing = map.get(email)
      if (existing) existing.count++
      else map.set(email, { name, count: 1 })
    }
  } catch {
    // ignore
  }
  return [...map.entries()]
    .map(([email, { name, count }]) => ({ email, name, count }))
    .sort((a, b) => b.count - a.count)
}

async function getGitLabAuthors(owner: string, repo: string, token: string, baseUrl?: string): Promise<AuthorInfo[]> {
  const map = new Map<string, { name: string; count: number }>()
  const host = baseUrl || 'https://gitlab.com'
  const projectPath = encodeURIComponent(`${owner}/${repo}`)
  try {
    const res = await fetch(
      `${host}/api/v4/projects/${projectPath}/repository/commits?per_page=100`,
      { headers: { 'PRIVATE-TOKEN': token } }
    )
    if (!res.ok) return []
    const commits = (await res.json()) as Array<{
      author_email?: string
      author_name?: string
    }>
    for (const c of commits) {
      if (!c.author_email) continue
      const existing = map.get(c.author_email)
      if (existing) existing.count++
      else map.set(c.author_email, { name: c.author_name || c.author_email, count: 1 })
    }
  } catch {
    // ignore
  }
  return [...map.entries()]
    .map(([email, { name, count }]) => ({ email, name, count }))
    .sort((a, b) => b.count - a.count)
}
