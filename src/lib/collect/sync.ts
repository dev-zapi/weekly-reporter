import { getDb } from '@/lib/db'
import { eq, sql } from 'drizzle-orm'
import { collectSources, rawEvents } from '@/lib/db/schema'
import type { CollectSource, CollectSourceConfig } from '@/lib/db/schema'
import { getAdapter } from './adapters'
import type { FetchCommitsOptions, RawEventData } from './types'
import { basename } from 'path'
import { getNormalizedRepoName, getCurrentBranch, getLocalBranchNames, pullCurrentBranch, assertLocalGitRepo } from './adapters/local-git-adapter'
import { normalizeRepoName } from '@/lib/utils'
import { withSourceOperationLock } from './source-operation-lock'
import { isEmptyBranchConfig, orderBranchesForAttribution, buildPrunedBranchCursors } from './branches'

export interface BranchSyncResult {
  name: string
  status: 'success' | 'failed'
  commitsCount: number
  error?: string
}

export interface SyncResult {
  sourceId: number
  sourceName: string
  status: 'success' | 'failed'
  commitsCount: number
  eventsCount: number
  error?: string
  autoDisabled?: boolean
  /** 部分采集路径失败时的告警信息（整体仍为 success） */
  warnings?: string[]
  /** 各分支同步结果明细（多分支源） */
  branches?: BranchSyncResult[]
}

// 规范化分支配置：兼容旧格式 string[] 和新格式 { name, lastCommitTime }[]
interface BranchConfig {
  name: string
  lastCommitTime: string | null
}

function normalizeBranches(branches: unknown): BranchConfig[] {
  if (!Array.isArray(branches) || branches.length === 0) {
    return [{ name: '', lastCommitTime: null }]
  }
  return branches.map(b => {
    if (typeof b === 'string') {
      return { name: b, lastCommitTime: null }
    }
    if (typeof b === 'object' && b !== null && 'name' in b) {
      return {
        name: (b as BranchConfig).name,
        lastCommitTime: (b as BranchConfig).lastCommitTime || null,
      }
    }
    return { name: '', lastCommitTime: null }
  })
}

function failedResult(source: CollectSource | null, sourceId: number, error: string, autoDisabled?: boolean): SyncResult {
  return {
    sourceId,
    sourceName: source?.name || '',
    status: 'failed',
    commitsCount: 0,
    eventsCount: 0,
    error,
    autoDisabled,
  }
}

/** 构建仓库显示名：本地取远程 URL 归一化（失败则 basename），远程取 owner/repo 归一化 */
async function resolveRepoName(source: CollectSource): Promise<string> {
  if (source.type === 'git-local') {
    return getNormalizedRepoName(source.config.owner)
  }
  if (source.config.repo) {
    return normalizeRepoName(`${source.config.owner}/${source.config.repo}`)
  }
  return basename(source.config.owner)
}

async function syncSourceUnlocked(sourceId: number, resync?: boolean): Promise<SyncResult> {
  const db = getDb()

  const source = await db.query.collectSources.findFirst({
    where: eq(collectSources.id, sourceId),
  })

  if (!source) {
    return failedResult(null, sourceId, '采集源不存在')
  }

  if (source.status !== 'enabled') {
    return failedResult(source, source.id, source.status === 'disabled' ? '采集源已禁用' : '采集源不可用')
  }

  // 检查邮箱配置：没有邮箱时标记为不可用
  const hasEmails = source.config?.authorEmails && source.config.authorEmails.length > 0
  if (!hasEmails) {
    await db.update(collectSources)
      .set({
        status: 'unavailable',
        updatedAt: new Date(),
      })
      .where(eq(collectSources.id, source.id))

    return failedResult(source, source.id, '未配置邮箱', true)
  }

  const adapter = getAdapter(source.type)
  if (!adapter) {
    return failedResult(source, source.id, '不支持的采集源类型')
  }

  // 迁移旧 paths 模型：有 paths 无 branches 时，从 paths 提取分支名转为 branches
  // config 是 JSON 列，旧数据可能仍有 paths 字段，用 unknown 过渡读取
  const legacyConfig = source.config as CollectSourceConfig & { paths?: Array<{ path: string; lastBranch?: string | null; lastCommitTime?: string | null }> }
  if (source.type === 'git-local' && Array.isArray(legacyConfig.paths) && legacyConfig.paths.length > 0) {
    const branchNames = [...new Set(
      legacyConfig.paths.map(p => p.lastBranch).filter(Boolean) as string[]
    )]
    const { paths: _paths, ...restConfig } = legacyConfig
    const updatedConfig = {
      ...restConfig,
      branches: branchNames.length > 0
        ? branchNames.map(name => ({ name, lastCommitTime: null }))
        : [],
    }
    await db.update(collectSources)
      .set({ config: updatedConfig, updatedAt: new Date() })
      .where(eq(collectSources.id, source.id))
    source.config = updatedConfig
  }

  try {
    const repoName = await resolveRepoName(source)
    const now = new Date()

    type FetchedCommit = Awaited<ReturnType<typeof adapter.fetchCommits>>[number]
    let allCommits: FetchedCommit[] = []
    const branchCommits: Array<{ commit: FetchedCommit; branchName: string }> = []
    const branchMaxCommitterDate: Record<string, Date> = {}
    const branchResults: BranchSyncResult[] = []

    /**
     * Shared per-branch bookkeeping: fetch commits with the branch's cursor,
     * accumulate totals, and record success/failure. Used by both the
     * explicit-branch path and the all-branches path.
     */
    async function collectOneBranch(
      branchName: string,
      cursorTime: string | null | undefined,
      extraOptions: Partial<FetchCommitsOptions> = {},
    ): Promise<void> {
      try {
        const since = resync ? undefined : (cursorTime ? new Date(cursorTime) : undefined)
        const options: FetchCommitsOptions = {
          config: { ...source!.config, branch: branchName || undefined },
          since,
          until: now,
          ...extraOptions,
        }

        const commits = await adapter!.fetchCommits(options)
        allCommits = allCommits.concat(commits)
        for (const c of commits) {
          branchCommits.push({ commit: c, branchName })
        }

        if (commits.length > 0) {
          const maxDate = commits.reduce((max, c) =>
            c.committerDate > max ? c.committerDate : max,
            commits[0].committerDate,
          )
          branchMaxCommitterDate[branchName] = maxDate
        }

        branchResults.push({ name: branchName, status: 'success', commitsCount: commits.length })
      } catch (branchError) {
        const errorMessage = branchError instanceof Error ? branchError.message : '未知错误'
        branchResults.push({ name: branchName, status: 'failed', commitsCount: 0, error: errorMessage })
      }
    }

    // ---- 判定全分支采集模式（git-local 且分支配置为空） ----
    const allBranchesMode = source!.type === 'git-local' && isEmptyBranchConfig(source!.config.branches)

    if (allBranchesMode) {
      const repoPath = source!.config.owner
      // 无效/缺失路径 → 抛出 → 外层 catch 标记 unavailable
      await assertLocalGitRepo(repoPath)
      const localHeads = await getLocalBranchNames(repoPath)
      const currentBranch = await getCurrentBranch(repoPath)
      const orderedBranches = orderBranchesForAttribution(localHeads, currentBranch)

      // 全分支模式下只拉取当前签出分支一次（best-effort），其余分支的本地历史直接读取
      try {
        await pullCurrentBranch(repoPath)
      } catch (pullError) {
        console.warn('全分支采集：pull 当前分支失败，继续使用本地 commit:', pullError)
      }

      const cursorMap = new Map<string, string | null>()
      for (const cursor of source!.config.branchCursors || []) {
        if (!cursorMap.has(cursor.name)) {
          cursorMap.set(cursor.name, cursor.lastCommitTime ?? null)
        }
      }

      for (const branchName of orderedBranches) {
        await collectOneBranch(branchName, cursorMap.get(branchName), { skipPull: true })
      }

      const failedBranches = branchResults.filter(b => b.status === 'failed')
      const allBranchesFailed = orderedBranches.length > 0 && failedBranches.length === orderedBranches.length

      if (allBranchesFailed) {
        const firstError = failedBranches[0]?.error || '未知错误'
        const errorMessage = `全部分支同步失败：${firstError}`
        await db.update(collectSources)
          .set({ lastSyncStatus: 'failed', updatedAt: now })
          .where(eq(collectSources.id, source!.id))
        return failedResult(source, source!.id, errorMessage)
      }

      const baseSourceInfo = {
        repo: repoName,
        branch: '',
        sourceId: source!.id,
        sourceName: source!.name,
      }
      const events = branchCommits.map(({ commit, branchName }) =>
        adapter!.normalizeCommit(commit, source!.type, { ...baseSourceInfo, branch: branchName }),
      )
      const eventsCount = await insertNewEvents(db, source!.id, events, now)

      const newCursors = buildPrunedBranchCursors(
        localHeads,
        branchMaxCommitterDate,
        source!.config.branchCursors || [],
      )

      await db.update(collectSources)
        .set({
          config: { ...source!.config, branchCursors: newCursors },
          lastSyncAt: now,
          lastSyncStatus: 'success',
          updatedAt: now,
        })
        .where(eq(collectSources.id, source!.id))

      return {
        sourceId: source!.id,
        sourceName: source!.name,
        status: 'success',
        commitsCount: allCommits.length,
        eventsCount,
        branches: branchResults,
      }
    }

    // ---- 统一 branches 模型（git-local 显式分支 与远端类型） ----
    const branches = normalizeBranches(source!.config.branches)

    // Sync each branch with per-branch cursor and error handling
    for (const branch of branches) {
      await collectOneBranch(branch.name, branch.lastCommitTime)
    }

    // 判断整体状态
    const failedBranches = branchResults.filter(b => b.status === 'failed')
    const allBranchesFailed = failedBranches.length === branchResults.length

    if (allBranchesFailed) {
      // 全部分支失败
      const firstError = failedBranches[0]?.error || '未知错误'
      const errorMessage = `全部分支同步失败：${firstError}`

      await db.update(collectSources)
        .set({
          lastSyncStatus: 'failed',
          updatedAt: now,
        })
        .where(eq(collectSources.id, source!.id))

      return failedResult(source, source!.id, errorMessage)
    }

    const baseSourceInfo = {
      repo: repoName,
      branch: '',  // will be overridden per commit
      sourceId: source!.id,
      sourceName: source!.name,
    }

    const events = branchCommits.map(({ commit, branchName }) =>
      adapter!.normalizeCommit(commit, source!.type, { ...baseSourceInfo, branch: branchName })
    )
    const eventsCount = await insertNewEvents(db, source!.id, events, now)

    // 更新分支 cursor：只更新本次拉到新 commit 的分支
    const updatedBranches = branches.map(b => {
      const newCursor = branchMaxCommitterDate[b.name]
      if (newCursor) {
        return { name: b.name, lastCommitTime: newCursor.toISOString() }
      }
      return { name: b.name, lastCommitTime: b.lastCommitTime }
    })

    await db.update(collectSources)
      .set({
        config: { ...source!.config, branches: updatedBranches },
        lastSyncAt: now,
        lastSyncStatus: 'success',
        updatedAt: now,
      })
      .where(eq(collectSources.id, source!.id))

    return {
      sourceId: source!.id,
      sourceName: source!.name,
      status: 'success',
      commitsCount: allCommits.length,
      eventsCount,
      branches: branchResults,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '未知错误'

    // Check if the error is due to missing/invalid directory for local git sources
    const isUnavailable = source!.type === 'git-local' && (
      errorMessage.includes('路径不是 Git 仓库') ||
      errorMessage.includes('本地仓库路径不存在') ||
      errorMessage.includes('not a git repository') ||
      errorMessage.includes('no such file or directory') ||
      errorMessage.includes('ENOENT')
    )

    if (isUnavailable) {
      await db.update(collectSources)
        .set({
          status: 'unavailable',
          lastSyncStatus: 'failed',
          updatedAt: new Date(),
        })
        .where(eq(collectSources.id, source!.id))
    } else {
      await db.update(collectSources)
        .set({
          lastSyncStatus: 'failed',
          updatedAt: new Date(),
        })
        .where(eq(collectSources.id, source!.id))
    }

    return failedResult(source, source!.id, errorMessage, isUnavailable)
  }
}

/** 按 sourceId + sha 去重后插入事件，返回实际插入数 */
async function insertNewEvents(
  db: ReturnType<typeof getDb>,
  sourceId: number,
  events: RawEventData[],
  now: Date,
): Promise<number> {
  const existingEvents = await db.query.rawEvents.findMany({
    where: sql`json_extract(${rawEvents.metadata}, '$.sourceId') = ${sourceId}`,
  })
  const existingShaSet = new Set(
    existingEvents
      .filter(e => e.metadata?.sha)
      .map(e => e.metadata?.sha)
  )

  // 本次同步内部（跨路径/跨分支）也可能出现同 sha，先去重再比对存量
  const seen = new Set<string>()
  const newEvents = events.filter(e => {
    const sha = e.metadata?.sha
    if (!sha) return true
    if (seen.has(sha) || existingShaSet.has(sha)) return false
    seen.add(sha)
    return true
  })

  if (newEvents.length > 0) {
    await db.insert(rawEvents).values(
      newEvents.map(e => ({
        ...e,
        createdAt: now,
        updatedAt: now,
      }))
    )
  }

  return newEvents.length
}

export async function syncSource(sourceId: number, resync?: boolean): Promise<SyncResult> {
  return withSourceOperationLock(sourceId, () => syncSourceUnlocked(sourceId, resync))
}

export async function syncAllSources(resync?: boolean): Promise<SyncResult[]> {
  const db = getDb()

  const sources = await db.query.collectSources.findMany({
    where: eq(collectSources.status, 'enabled'),
  })

  // 过滤掉没有配置邮箱的采集源（和单个同步按钮行为一致）
  const eligibleSources = sources.filter(source =>
    source.config?.authorEmails && source.config.authorEmails.length > 0
  )

  const results: SyncResult[] = []

  for (const source of eligibleSources) {
    const result = await syncSource(source.id, resync)
    results.push(result)
  }

  return results
}
