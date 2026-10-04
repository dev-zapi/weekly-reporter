'use client'

import { useState, useEffect, type KeyboardEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { UserCircle, X, GitBranch, RefreshCw } from 'lucide-react'
import { AuthorEmailPicker } from './AuthorEmailPicker'
import { AutoCompleteInput } from './AutoCompleteInput'
import { TagInput } from './TagInput'
import { Badge } from './ui/badge'

export interface BranchFormValue {
  name: string
  lastCommitTime?: string | null
}

export interface FormData {
  type: 'git-remote-github' | 'git-remote-gitlab' | 'git-remote-gitee' | 'git-local'
  name: string
  projectScope: 'work' | 'personal'
  aliases: string[]
  config: {
    baseUrl: string
    owner: string
    repo: string
    token: string
    authorEmails: string
    branches: BranchFormValue[]
  }
  enabled: boolean
}

const isLocal = (type: FormData['type']) => type === 'git-local'
const isRemote = (type: FormData['type']) => !isLocal(type)

export function CollectSourceForm({ sourceId, initialData }: { sourceId?: number; initialData?: FormData }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [formData, setFormData] = useState<FormData>(
    initialData || {
      type: 'git-remote-github',
      name: '',
      projectScope: 'personal',
      aliases: [],
      config: {
        baseUrl: '',
        owner: '',
        repo: '',
        token: '',
        authorEmails: '',
        branches: [],
      },
      enabled: true,
    }
  )

  // 邮箱自动补全 — 从当前仓库获取
  const [knownEmails, setKnownEmails] = useState<string[]>([])
  // 分支自动补全 — 从当前仓库获取
  const [knownBranches, setKnownBranches] = useState<string[]>([])
  const [currentBranch, setCurrentBranch] = useState('')
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchError, setBranchError] = useState(false)
  const [branchRefreshKey, setBranchRefreshKey] = useState(0)

  // 邮箱表格选择器
  const [pickerOpen, setPickerOpen] = useState(false)

  // 根据当前表单值获取仓库邮箱（防抖）
  useEffect(() => {
    const params = new URLSearchParams({ type: formData.type })
    if (isLocal(formData.type)) {
      if (!formData.config.owner) return
      params.set('path', formData.config.owner)
    } else {
      if (!formData.config.owner || !formData.config.repo || !formData.config.token) return
      params.set('owner', formData.config.owner)
      params.set('repo', formData.config.repo)
      params.set('token', formData.config.token)
      if (formData.config.baseUrl) params.set('baseUrl', formData.config.baseUrl)
    }
    // Use first branch for email fetching
    const firstBranch = formData.config.branches[0]?.name
    if (firstBranch) params.set('branch', firstBranch)

    const timer = setTimeout(() => {
      fetch(`/api/collect/sources/emails?${params}`)
        .then(res => res.json())
        .then(data => setKnownEmails((data.authors || []).map((a: { email: string }) => a.email)))
        .catch(() => {})
    }, 500)
    return () => clearTimeout(timer)
  }, [formData.type, formData.config.owner, formData.config.repo, formData.config.token, formData.config.baseUrl, formData.config.branches])

  // 根据当前表单值获取仓库分支（防抖）
  useEffect(() => {
    const params = new URLSearchParams({ type: formData.type })
    if (sourceId) params.set('sourceId', String(sourceId))
    if (isLocal(formData.type)) {
      if (!formData.config.owner) return
      params.set('path', formData.config.owner)
    } else {
      if (!formData.config.owner || !formData.config.repo || (!formData.config.token && !sourceId)) return
      params.set('owner', formData.config.owner)
      params.set('repo', formData.config.repo)
      if (formData.config.token) params.set('token', formData.config.token)
      if (formData.config.baseUrl) params.set('baseUrl', formData.config.baseUrl)
    }

    const timer = setTimeout(() => {
      setBranchLoading(true)
      setBranchError(false)
      fetch(`/api/collect/sources/branches?${params}`)
        .then(async res => {
          const data = await res.json()
          if (!res.ok) throw new Error(data.error || 'Failed to load branches')
          setKnownBranches(data.branches || [])
          setCurrentBranch(data.currentBranch || '')
        })
        .catch(() => {
          setKnownBranches([])
          setCurrentBranch('')
          setBranchError(true)
        })
        .finally(() => setBranchLoading(false))
    }, 500)
    return () => clearTimeout(timer)
  }, [sourceId, branchRefreshKey, formData.type, formData.config.owner, formData.config.repo, formData.config.token, formData.config.baseUrl])

  function handleChange(field: keyof FormData, value: string | boolean) {
    setFormData(prev => ({
      ...prev,
      [field]: value,
    }))
  }

  function handleConfigChange(field: keyof FormData['config'], value: string) {
    setFormData(prev => ({
      ...prev,
      config: {
        ...prev.config,
        [field]: value,
      },
    }))
  }

  function handleAliasesChange(aliases: string[]) {
    setFormData(prev => ({ ...prev, aliases }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)

    const submitData = {
      type: formData.type,
      name: formData.name,
      projectScope: formData.projectScope,
      aliases: formData.aliases,
      config: isLocal(formData.type)
        ? {
          owner: formData.config.owner,
          authorEmails: formData.config.authorEmails.split(',').map(e => e.trim()).filter(Boolean),
          branches: formData.config.branches.length > 0 ? formData.config.branches : undefined,
        }
        : {
          baseUrl: formData.config.baseUrl || undefined,
          owner: formData.config.owner,
          repo: formData.config.repo,
          token: formData.config.token,
          authorEmails: formData.config.authorEmails.split(',').map(e => e.trim()).filter(Boolean),
          branches: formData.config.branches.length > 0 ? formData.config.branches : undefined,
        },
      enabled: formData.enabled,
    }

    try {
      const url = sourceId 
        ? `/api/collect/sources/${sourceId}`
        : '/api/collect/sources'
      const method = sourceId ? 'PUT' : 'POST'
      
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submitData),
      })
      
      const data = await res.json()
      
      if (res.ok) {
        toast.success(sourceId ? 'Updated successfully' : 'Created successfully')
        router.push('/collect')
      } else {
        const issueMessage = data.details?.issues?.[0]?.message
        toast.error(issueMessage ? `${data.error}: ${issueMessage}` : data.error || 'Operation failed')
      }
    } catch {
      toast.error('Operation failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="overflow-visible">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Source name</Label>
            <input
              id="name"
              type="text"
              value={formData.name}
              onChange={e => handleChange('name', e.target.value)}
              placeholder="e.g. Backend repository"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              required
            />
          </div>

          <div className="space-y-2">
            <Label>Project scope</Label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="projectScope"
                  value="work"
                  checked={formData.projectScope === 'work'}
                  onChange={() => handleChange('projectScope', 'work')}
                  className="rounded border-input"
                />
                <span className="text-sm">Work project</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="projectScope"
                  value="personal"
                  checked={formData.projectScope === 'personal'}
                  onChange={() => handleChange('projectScope', 'personal')}
                  className="rounded border-input"
                />
                <span className="text-sm">Personal project</span>
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              Work projects appear in Leadership reports; personal projects appear only in Personal reports.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="aliases">Aliases</Label>
            <TagInput
              value={formData.aliases}
              onChange={handleAliasesChange}
              placeholder="e.g. Backend service, API platform"
            />
            <p className="text-xs text-muted-foreground">
              Helps AI identify this project. Aliases appear on events.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="type">Source type</Label>
            <select
              id="type"
              value={formData.type}
              onChange={e => handleChange('type', e.target.value as FormData['type'])}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="git-remote-github">GitHub (remote)</option>
              <option value="git-remote-gitlab">GitLab (remote)</option>
              <option value="git-local">Local Git repository</option>
              <option value="git-remote-gitee">Gitee (not supported)</option>
            </select>
          </div>

          {isRemote(formData.type) && formData.type === 'git-remote-gitlab' && (
            <div className="space-y-2">
              <Label htmlFor="baseUrl">GitLab URL (for self-hosted instances; leave blank for gitlab.com)</Label>
              <input
                id="baseUrl"
                type="text"
                value={formData.config.baseUrl}
                onChange={e => handleConfigChange('baseUrl', e.target.value)}
                placeholder="e.g. https://gitlab.example.com"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="owner">
              {isLocal(formData.type) ? 'Local repository path' : 'Repository owner or organization'}
            </Label>
            <input
              id="owner"
              type="text"
              value={formData.config.owner}
              onChange={e => handleConfigChange('owner', e.target.value)}
              placeholder={isLocal(formData.type) ? 'e.g. /home/user/projects/backend' : 'e.g. my-org'}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              required
            />
          </div>

          {isRemote(formData.type) && (
            <div className="space-y-2">
              <Label htmlFor="repo">Repository name</Label>
              <input
                id="repo"
                type="text"
                value={formData.config.repo}
                onChange={e => handleConfigChange('repo', e.target.value)}
                placeholder="e.g. backend-api"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                required
              />
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="branches">Branches</Label>
              {isLocal(formData.type) && (
                <span className="text-xs text-muted-foreground">
                  {branchLoading ? 'Reading current branch...' : currentBranch ? `Checked out: ${currentBranch}` : 'Current branch unavailable'}
                </span>
              )}
            </div>
            <BranchInput
              value={formData.config.branches}
              onChange={branches => setFormData(prev => ({ ...prev, config: { ...prev.config, branches } }))}
              suggestions={knownBranches}
              currentBranch={isLocal(formData.type) ? currentBranch : ''}
              loading={branchLoading}
              error={branchError}
              showRefresh={isLocal(formData.type)}
              onRefresh={() => {
                setBranchRefreshKey(key => key + 1)
              }}
            />
            <p className="text-xs text-muted-foreground">
              {isLocal(formData.type)
                ? 'Leave blank to collect all local branches. You can enter a branch not shown in suggestions.'
                : 'Leave blank to follow the repository default branch. You can enter a branch not shown in suggestions.'}
            </p>
          </div>

          {isRemote(formData.type) && (
            <div className="space-y-2">
              <Label htmlFor="token">Personal access token</Label>
              <input
                id="token"
                type="password"
              value={formData.config.token}
              onChange={e => handleConfigChange('token', e.target.value)}
              placeholder={sourceId ? 'Leave blank to keep the existing token' : 'Enter an access token'}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              required={!sourceId}
            />
            <p className="text-xs text-muted-foreground">
              {sourceId
                ? 'Leave blank to keep the existing token; entering a new value replaces it.'
                : formData.type === 'git-remote-github'
                ? 'GitHub: Settings → Developer settings → Personal access tokens'
                : 'GitLab: Settings → Access tokens'}
              </p>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="authorEmails">Author emails (comma-separated)</Label>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <UserCircle className="h-3.5 w-3.5" />
                Select from repository
              </button>
            </div>
            <AutoCompleteInput
              value={formData.config.authorEmails}
              onChange={v => handleConfigChange('authorEmails', v)}
              suggestions={knownEmails}
              placeholder="e.g. user@example.com, work@company.com"
              allowCreate
            />
            <p className="text-xs text-muted-foreground">
              Only collect commits from these email addresses.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <input
              id="enabled"
              type="checkbox"
              checked={formData.enabled}
              onChange={e => handleChange('enabled', e.target.checked)}
              className="rounded border-input"
            />
            <Label htmlFor="enabled">Enable this source</Label>
          </div>
        </CardContent>
        <CardFooter className="gap-2">
          <Button type="submit" disabled={loading}>
            {loading ? 'Saving...' : 'Save'}
          </Button>
          <Button type="button" variant="outline" onClick={() => router.push('/collect')}>
            Cancel
          </Button>
        </CardFooter>
      </form>

      <AuthorEmailPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onConfirm={emails => handleConfigChange('authorEmails', emails.join(', '))}
        currentEmails={formData.config.authorEmails.split(',').map(e => e.trim()).filter(Boolean)}
        repoParams={{
          type: formData.type,
          path: isLocal(formData.type) ? formData.config.owner : undefined,
          owner: formData.config.owner,
          repo: formData.config.repo,
          token: formData.config.token,
          baseUrl: formData.config.baseUrl,
          branch: formData.config.branches[0]?.name || undefined,
        }}
      />
    </Card>
  )
}

interface BranchInputProps {
  value: BranchFormValue[]
  onChange: (value: BranchFormValue[]) => void
  suggestions: string[]
  currentBranch: string
  loading: boolean
  error: boolean
  showRefresh: boolean
  onRefresh: () => void
}

function BranchInput({ value, onChange, suggestions, currentBranch, loading, error, showRefresh, onRefresh }: BranchInputProps) {
  const [input, setInput] = useState('')
  const [open, setOpen] = useState(false)
  const existing = new Set(value.map(branch => branch.name))
  const filtered = suggestions.filter(branch =>
    !existing.has(branch) && branch.toLowerCase().includes(input.trim().toLowerCase())
  ).slice(0, 10)

  function addBranch(name: string) {
    const trimmed = name.trim()
    if (!trimmed || existing.has(trimmed)) {
      setInput('')
      return
    }
    onChange([...value, { name: trimmed, lastCommitTime: null }])
    setInput('')
    setOpen(false)
  }

  function removeBranch(name: string) {
    onChange(value.filter(branch => branch.name !== name))
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addBranch(input)
    } else if (e.key === 'Backspace' && !input && value.length > 0) {
      removeBranch(value[value.length - 1].name)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex min-h-10 flex-wrap items-center gap-2 rounded-md border border-input bg-background px-2 py-1.5">
        {value.map(branch => {
          const cursor = branch.lastCommitTime ? new Date(branch.lastCommitTime) : null
          const status = cursor && !Number.isNaN(cursor.getTime())
            ? `Synced through ${cursor.toLocaleString()}`
            : 'Awaiting first sync'
          return (
            <Badge key={branch.name} variant="secondary" className="gap-1 py-1 pr-1">
              <GitBranch className="h-3 w-3" />
              <span>{branch.name}</span>
                <span className="text-[10px] font-normal text-muted-foreground" title={`${status} (committer date)`}>{status}</span>
              <button type="button" onClick={() => removeBranch(branch.name)} className="ml-1 rounded-sm p-0.5 hover:bg-muted" aria-label={`Remove branch ${branch.name}`} title={`Remove branch ${branch.name}`}>
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )
        })}
        <div className="relative min-w-[180px] flex-1">
          <input
            id="branches"
            value={input}
            onChange={e => { setInput(e.target.value); setOpen(true) }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={handleKeyDown}
            placeholder={currentBranch ? `Current branch ${currentBranch} (leave blank for default)` : 'Leave blank for default branch'}
            className="w-full bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground/60"
          />
          {open && (filtered.length > 0 || input.trim()) && (
            <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-md border bg-popover p-1 shadow-md">
              {filtered.map(branch => (
                <button key={branch} type="button" className="block w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted" onMouseDown={e => e.preventDefault()} onClick={() => addBranch(branch)}>
                  {branch}
                </button>
              ))}
              {input.trim() && !existing.has(input.trim()) && !suggestions.some(branch => branch.toLowerCase() === input.trim().toLowerCase()) && (
                <button type="button" className="block w-full rounded-sm px-2 py-1.5 text-left text-sm text-primary hover:bg-muted" onMouseDown={e => e.preventDefault()} onClick={() => addBranch(input)}>
                  Add “{input.trim()}”
                </button>
              )}
            </div>
          )}
        </div>
        {showRefresh && isLocalPlaceholder(currentBranch, loading, error) && (
          <button type="button" className="rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={onRefresh} title="Reload branches" aria-label="Reload branches">
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

function isLocalPlaceholder(currentBranch: string, loading: boolean, error: boolean) {
  return Boolean(loading || error || currentBranch)
}
