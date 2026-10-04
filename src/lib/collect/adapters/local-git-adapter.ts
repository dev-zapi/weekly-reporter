import type { GitAdapter, GitCommit, FetchCommitsOptions, RawEventData } from '../types'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { normalizeRepoName } from '@/lib/utils'

const execFileAsync = promisify(execFile)

function getGitErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'stderr' in error) {
    const stderr = (error as { stderr?: unknown }).stderr
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim()
  }
  return error instanceof Error ? error.message : String(error)
}

/** 更新本地仓库的 origin 远端引用，不修改工作树。 */
export async function fetchOrigin(repoPath: string): Promise<void> {
  try {
    await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      maxBuffer: 1024 * 1024,
    })
  } catch (error) {
    const message = getGitErrorMessage(error)
    if (message.includes('not a git repository')) {
      throw new Error(`路径不是 Git 仓库：${repoPath}`)
    }
    if (message.includes('ENOENT') || message.includes('no such file or directory')) {
      throw new Error(`本地仓库路径不存在：${repoPath}`)
    }
    throw new Error('仓库未配置 origin 远端')
  }

  try {
    await execFileAsync('git', ['fetch', 'origin'], {
      cwd: repoPath,
      maxBuffer: 1024 * 1024 * 10,
    })
  } catch (error) {
    const message = getGitErrorMessage(error)
    if (message.includes('not a git repository')) {
      throw new Error(`路径不是 Git 仓库：${repoPath}`)
    }
    throw new Error(`Git Fetch 失败：${message}`)
  }
}

/**
 * 尝试获取本地 git 仓库的远程 URL
 * 如果没有 remote，返回 null
 */
export async function getRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      maxBuffer: 1024 * 1024,
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * 获取本地 git 仓库的规范化仓库名称
 * 优先使用远程 URL，失败则使用目录 basename
 */
export async function getNormalizedRepoName(repoPath: string): Promise<string> {
  const remoteUrl = await getRemoteUrl(repoPath)
  if (remoteUrl) {
    const normalized = normalizeRepoName(remoteUrl)
    if (normalized) {
      return normalized
    }
  }
  // 回退到目录 basename
  const { basename } = await import('path')
  return basename(repoPath)
}

/**
 * 获取仓库当前签出的分支名；detached HEAD 或非仓库时返回空字符串
 */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: repoPath,
      maxBuffer: 1024 * 1024,
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

/**
 * 拉取当前签出分支的最新代码（best-effort）。
 * detached HEAD、无 remote、或非仓库时静默跳过；
 * 冲突或仓库无效时抛出与既有行为一致的明确错误。
 */
export async function pullCurrentBranch(repoPath: string): Promise<void> {
  let hasRemote = false
  try {
    const { stdout: remoteOut } = await execFileAsync('git', ['remote'], {
      cwd: repoPath,
      maxBuffer: 1024 * 1024,
    })
    hasRemote = Boolean(remoteOut.trim())
  } catch (error) {
    const msg = getGitErrorMessage(error)
    if (msg.includes('not a git repository')) {
      throw new Error(`路径不是 Git 仓库：${repoPath}`)
    }
    if (msg.includes('ENOENT') || msg.includes('no such file or directory')) {
      throw new Error(`本地仓库路径不存在：${repoPath}`)
    }
    return
  }

  if (!hasRemote) return

  const currentBranch = await getCurrentBranch(repoPath)
  if (!currentBranch) return

  try {
    await execFileAsync('git', ['pull', '--no-edit', 'origin', currentBranch], {
      cwd: repoPath,
      maxBuffer: 1024 * 1024 * 10,
    })
  } catch (error) {
    const msg = getGitErrorMessage(error)
    if (msg.includes('CONFLICT') || msg.includes('conflict')) {
      throw new Error('Git pull 有冲突，请手动解决后再同步')
    }
    if (msg.includes('not a git repository')) {
      throw new Error(`路径不是 Git 仓库：${repoPath}`)
    }
    console.warn('Git pull 失败，继续同步本地 commit:', msg)
  }
}

/**
 * 返回本地所有 head 分支名（refs/heads），按字母升序。
 * 不包含远端跟踪引用或标签；出错返回 []。
 */
export async function getLocalBranchNames(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
      { cwd: repoPath, maxBuffer: 1024 * 1024 }
    )
    return stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .sort()
  } catch {
    return []
  }
}

/** 校验 repoPath 是有效 git 工作树；无效/不存在时抛出（供同步标记 unavailable）。 */
export async function assertLocalGitRepo(repoPath: string): Promise<void> {
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoPath,
      maxBuffer: 1024 * 1024,
    })
  } catch (error) {
    const message = getGitErrorMessage(error)
    if (message.includes('ENOENT') || message.includes('no such file or directory')) {
      throw new Error(`本地仓库路径不存在：${repoPath}`)
    }
    throw new Error(`路径不是 Git 仓库：${repoPath}`)
  }
}

export const localGitAdapter: GitAdapter = {
  platform: 'git-local',

  async fetchCommits(options: FetchCommitsOptions): Promise<GitCommit[]> {
    const { config, since, until, skipPull } = options
    const { owner, repo, authorEmails, branch } = config

    const repoPath = owner

    // 同步前拉取最新代码（skipPull 模式下由 sync.ts 统一处理）
    if (!skipPull) {
      try {
        const { stdout: remoteOut } = await execFileAsync('git', ['remote'], {
          cwd: repoPath,
          maxBuffer: 1024 * 1024,
        })

        if (remoteOut.trim()) {
          const currentBranch = branch || (await execFileAsync('git', ['branch', '--show-current'], {
            cwd: repoPath,
            maxBuffer: 1024 * 1024,
          })).stdout.trim()

          await execFileAsync('git', ['pull', '--no-edit', 'origin', currentBranch], {
            cwd: repoPath,
            maxBuffer: 1024 * 1024 * 10,
          })
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (msg.includes('CONFLICT') || msg.includes('conflict')) {
          throw new Error('Git pull 有冲突，请手动解决后再同步')
        }
        if (msg.includes('not a git repository')) {
          throw new Error(`路径不是 Git 仓库：${repoPath}`)
        }
        console.warn('Git pull 失败，继续同步本地 commit:', msg)
      }
    }
    
    const args = [
      'log',
      '--pretty=format:%H|%s|%ai|%ci|%ae|%an',
      '--no-merges',
    ]
    
    if (since) {
      args.push(`--since=${since.toISOString()}`)
    }
    if (until) {
      args.push(`--until=${until.toISOString()}`)
    }
    if (branch) {
      args.push(branch)
    }
    
    try {
      const { stdout } = await execFileAsync(
        'git', args,
        { cwd: repoPath, maxBuffer: 1024 * 1024 * 10 }
      )
      
      if (!stdout.trim()) {
        return []
      }
      
      const lines = stdout.trim().split('\n')
      const commits: GitCommit[] = lines.map(line => {
        const [sha, message, authorDateStr, committerDateStr, email, name] = line.split('|')
        return {
          sha,
          message,
          authorDate: new Date(authorDateStr),
          committerDate: new Date(committerDateStr),
          authorEmail: email,
          authorName: name,
          url: '',
        }
      })
      
      return commits.filter(c => authorEmails.includes(c.authorEmail))
    } catch (error) {
      if (error instanceof Error && error.message.includes('not a git repository')) {
        throw new Error(`路径不是 Git 仓库：${repoPath}`)
      }
      throw new Error(`Git 命令执行失败：${error}`)
    }
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
