import type { GitAdapter, GitCommit, FetchCommitsOptions, RawEventData } from '../types'
import { outboundTraceHeaders } from '@/lib/trace/context'

export const gitlabAdapter: GitAdapter = {
  platform: 'git-remote-gitlab',
  
  async fetchCommits(options: FetchCommitsOptions): Promise<GitCommit[]> {
    const { config, since, until } = options
    const { baseUrl, owner, repo, token } = config
    
    if (!repo) {
      throw new Error('GitLab 仓库需要指定 repo')
    }
    if (!token) {
      throw new Error('GitLab 仓库需要提供 token')
    }
    
    const apiBase = baseUrl || 'https://gitlab.com/api/v4'
    
    const projectId = encodeURIComponent(`${owner}/${repo}`)
    
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
      params.set('ref_name', config.branch)
    }
    
    const url = `${apiBase}/projects/${projectId}/repository/commits?${params.toString()}`
    
    const res = await fetch(url, {
      headers: {
        'PRIVATE-TOKEN': token,
        'Accept': 'application/json',
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
      throw new Error(`GitLab API 错误: ${res.status}`)
    }
    
    const commits = await res.json() as Array<{
      id: string
      message: string
      authored_date: string
      committed_date: string
      author_email: string
      author_name: string
      web_url: string
    }>

    return commits
      .filter(c => config.authorEmails.includes(c.author_email))
      .map(c => ({
        sha: c.id,
        message: c.message,
        authorDate: new Date(c.authored_date),
        committerDate: new Date(c.committed_date),
        authorEmail: c.author_email,
        authorName: c.author_name,
        url: c.web_url,
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