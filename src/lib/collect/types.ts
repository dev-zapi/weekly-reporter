import type { RawEventMetadata } from '@/lib/db/schema'

export interface GitCommit {
  sha: string
  message: string
  authorDate: Date
  committerDate: Date
  authorEmail: string
  authorName: string
  url: string
  stats?: {
    additions: number
    deletions: number
    total: number
  }
}

export interface FetchCommitsOptions {
  config: {
    baseUrl?: string
    owner: string
    repo?: string
    token?: string
    authorEmails: string[]
    branch?: string
  }
  since?: Date
  until?: Date
  skipPull?: boolean
}

export interface RawEventData {
  eventTime: Date
  source: string
  content: string
  metadata?: RawEventMetadata
  category?: string
}

export interface GitAdapter {
  platform: string
  fetchCommits(options: FetchCommitsOptions): Promise<GitCommit[]>
  normalizeCommit(commit: GitCommit, source: string, sourceInfo?: { repo?: string; branch?: string; sourceId?: number; sourceName?: string }): RawEventData
}