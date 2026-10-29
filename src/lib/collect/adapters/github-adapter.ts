import type { GitAdapter, GitCommit, FetchCommitsOptions, RawEventData } from '../types'
import { outboundTraceHeaders } from '@/lib/trace/context'

export const githubAdapter: GitAdapter = {
  platform: 'git-remote-github',
  
  async fetchCommits(options: FetchCommitsOptions): Promise<GitCommit[]> {
    const { config, since, until } = options
    const { baseUrl, owner, repo, token } = config
    
    if (!repo) {
      throw new Error('GitHub 仓库需要指定 repo')
    }
    if (!token) {
      throw new Error('GitHub 仓库需要提供 token')
    }
    
    const apiBase = baseUrl || 'https://api.github.com'
    
    const params = new URLSearchParams({
      per_page: '100',
    })
    
    if (since) {
      params.set('since', since.toISOString())
    }
    if (until) {
      params.set('until', until.toISOString())
    }
    if (config.branch) {
      params.set('sha', config.branch)
    }
    
    const url = `${apiBase}/repos/${owner}/${repo}/commits?${params.toString()}`
    
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'WeeklyReporter',
        ...outboundTraceHeaders(),
      },
    })
    
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(`仓库不存在或无权限访问: ${owner}/${repo}`)
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error('令牌无效或权限不足')
      }
      throw new Error(`GitHub API 错误: ${res.status}`)
    }
    
    const commits = await res.json() as Array<{
      sha: string
      commit: {
        message: string
        author: {
          date: string
          email: string
          name: string
        }
        committer: {
          date: string
        }
      }
      html_url: string
      stats?: {
        additions: number
        deletions: number
        total: number
      }
    }>

    return commits
      .filter(c => config.authorEmails.includes(c.commit.author.email))
      .map(c => ({
        sha: c.sha,
        message: c.commit.message,
        authorDate: new Date(c.commit.author.date),
        committerDate: new Date(c.commit.committer.date),
        authorEmail: c.commit.author.email,
        authorName: c.commit.author.name,
        url: c.html_url,
        stats: c.stats,
      }))
  },
  
  normalizeCommit(commit: GitCommit, source: string, sourceInfo?: { repo?: string; branch?: string; sourceId?: number; sourceName?: string }): RawEventData {
    return {
      eventTime: commit.authorDate,
      source,
      content: commit.message.split('\n')[0],
      metadata: {
        sha: commit.sha,
        url: commit.url,
        repo: sourceInfo?.repo || '',
        branch: sourceInfo?.branch || '',
        sourceId: sourceInfo?.sourceId,
        sourceName: sourceInfo?.sourceName,
      },
      category: '核心开发',
    }
  },
}