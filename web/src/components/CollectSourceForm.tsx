import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useState, useEffect, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { UserCircle, X, GitBranch, RefreshCw, Loader2 } from 'lucide-react'
import { AuthorEmailPicker } from './AuthorEmailPicker'
import { AutoCompleteInput } from './AutoCompleteInput'
import { TagInput } from './TagInput'
import styles from './collection-sources.module.css'

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
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
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
    },
  )

  const [knownEmails, setKnownEmails] = useState<string[]>([])
  const [knownBranches, setKnownBranches] = useState<string[]>([])
  const [currentBranch, setCurrentBranch] = useState('')
  const [branchLoading, setBranchLoading] = useState(false)
  const [branchError, setBranchError] = useState(false)
  const [branchRefreshKey, setBranchRefreshKey] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)

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
    // Use first branch for email fetching
    const firstBranch = formData.config.branches[0]?.name
    if (firstBranch) params.set('branch', firstBranch)

    const timer = setTimeout(() => {
      apiFetch(`/api/collect/sources/emails?${params}`)
        .then(res => res.json())
        .then(data => setKnownEmails((data.authors || []).map((author: { email: string }) => author.email)))
        .catch(() => {})
    }, 500)
    return () => clearTimeout(timer)
  }, [sourceId, formData.type, formData.config.owner, formData.config.repo, formData.config.token, formData.config.baseUrl, formData.config.branches])

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
      apiFetch(`/api/collect/sources/branches?${params}`)
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

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setLoading(true)
    setSubmitError(null)

    const submitData = {
      type: formData.type,
      name: formData.name,
      projectScope: formData.projectScope,
      aliases: formData.aliases,
      config: isLocal(formData.type)
        ? {
          owner: formData.config.owner,
          authorEmails: formData.config.authorEmails.split(',').map(email => email.trim()).filter(Boolean),
          branches: formData.config.branches.length > 0 ? formData.config.branches : undefined,
        }
        : {
          baseUrl: formData.config.baseUrl || undefined,
          owner: formData.config.owner,
          repo: formData.config.repo,
          token: formData.config.token,
          authorEmails: formData.config.authorEmails.split(',').map(email => email.trim()).filter(Boolean),
          branches: formData.config.branches.length > 0 ? formData.config.branches : undefined,
        },
      enabled: formData.enabled,
    }

    try {
      const url = sourceId
        ? `/api/collect/sources/${sourceId}`
        : '/api/collect/sources'
      const method = sourceId ? 'PUT' : 'POST'

      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submitData),
      })

      const data = await res.json()

      if (res.ok) {
        toast.success(sourceId ? 'Updated successfully' : 'Created successfully')
        navigate('/collect')
      } else {
        const issueMessage = data.details?.issues?.[0]?.message
        const message = (issueMessage ? `${data.error}: ${issueMessage}` : data.error || 'Operation failed') +
          traceSuffix(res)
        setSubmitError(message)
        toast.error(message)
      }
    } catch {
      setSubmitError('Operation failed')
      toast.error('Operation failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <form onSubmit={handleSubmit} className={styles.sourceForm} aria-busy={loading}>
        <section className={styles.formSection} aria-labelledby="source-identity-heading">
          <div className={styles.formSectionHeader}>
            <h2 id="source-identity-heading">Source identity</h2>
            <p>Name the record and define how its events are grouped into Leadership and Personal reports.</p>
          </div>
          <div className={styles.fieldsGrid}>
            <div className={styles.field}>
              <label htmlFor="name">Source name</label>
              <input
                id="name"
                type="text"
                value={formData.name}
                onChange={event => handleChange('name', event.target.value)}
                placeholder="e.g. Backend repository"
                className={styles.textInput}
                required
              />
            </div>

            <div className={styles.field}>
              <label htmlFor="type">Source type</label>
              <select
                id="type"
                value={formData.type}
                onChange={event => handleChange('type', event.target.value as FormData['type'])}
                className={styles.selectInput}
              >
                <option value="git-remote-github">GitHub (remote)</option>
                <option value="git-remote-gitlab">GitLab (remote)</option>
                <option value="git-local">Local Git repository</option>
                <option value="git-remote-gitee">Gitee (not supported)</option>
              </select>
            </div>

            <div className={`${styles.field} ${styles.fieldWide}`}>
              <fieldset>
                <legend>Project scope</legend>
                <div className={styles.choiceGroup}>
                  <label className={styles.choiceOption}>
                    <input
                      type="radio"
                      name="projectScope"
                      value="work"
                      checked={formData.projectScope === 'work'}
                      onChange={() => handleChange('projectScope', 'work')}
                    />
                    <span>Work project</span>
                  </label>
                  <label className={styles.choiceOption}>
                    <input
                      type="radio"
                      name="projectScope"
                      value="personal"
                      checked={formData.projectScope === 'personal'}
                      onChange={() => handleChange('projectScope', 'personal')}
                    />
                    <span>Personal project</span>
                  </label>
                </div>
              </fieldset>
              <p className={styles.fieldHelp}>
                Work projects appear in Leadership reports; personal projects appear only in Personal reports.
              </p>
            </div>

            <div className={`${styles.field} ${styles.fieldWide}`} role="group" aria-labelledby="aliases-label">
              <span id="aliases-label" className={styles.fieldLabel}>Aliases</span>
              <TagInput
                value={formData.aliases}
                onChange={handleAliasesChange}
                placeholder="e.g. Backend service, API platform"
                className={styles.tagInput}
              />
              <p className={styles.fieldHelp}>Helps AI identify this project. Aliases appear on events.</p>
            </div>
          </div>
        </section>

        <section className={styles.formSection} aria-labelledby="repository-connection-heading">
          <div className={styles.formSectionHeader}>
            <h2 id="repository-connection-heading">Repository connection</h2>
            <p>Provide the local path or remote coordinates used for branch lookup and commit collection.</p>
          </div>
          <div className={styles.fieldsGrid}>
            {isRemote(formData.type) && formData.type === 'git-remote-gitlab' && (
              <div className={`${styles.field} ${styles.fieldWide}`}>
                <label htmlFor="baseUrl">GitLab URL (for self-hosted instances; leave blank for gitlab.com)</label>
                <input
                  id="baseUrl"
                  type="text"
                  value={formData.config.baseUrl}
                  onChange={event => handleConfigChange('baseUrl', event.target.value)}
                  placeholder="e.g. https://gitlab.example.com"
                  className={styles.textInput}
                />
              </div>
            )}

            <div className={styles.field}>
              <label htmlFor="owner">
                {isLocal(formData.type) ? 'Local repository path' : 'Repository owner or organization'}
              </label>
              <input
                id="owner"
                type="text"
                value={formData.config.owner}
                onChange={event => handleConfigChange('owner', event.target.value)}
                placeholder={isLocal(formData.type) ? 'e.g. /home/user/projects/backend' : 'e.g. my-org'}
                className={styles.textInput}
                required
              />
            </div>

            {isRemote(formData.type) && (
              <div className={styles.field}>
                <label htmlFor="repo">Repository name</label>
                <input
                  id="repo"
                  type="text"
                  value={formData.config.repo}
                  onChange={event => handleConfigChange('repo', event.target.value)}
                  placeholder="e.g. backend-api"
                  className={styles.textInput}
                  required
                />
              </div>
            )}

            {isRemote(formData.type) && (
              <div className={`${styles.field} ${styles.fieldWide}`}>
                <label htmlFor="token">Personal access token</label>
                <input
                  id="token"
                  type="password"
                  value={formData.config.token}
                  onChange={event => handleConfigChange('token', event.target.value)}
                  placeholder={sourceId ? 'Leave blank to keep the existing token' : 'Enter an access token'}
                  className={styles.textInput}
                  required={!sourceId}
                  aria-describedby="token-help"
                />
                <p id="token-help" className={styles.fieldHelp}>
                  {sourceId
                    ? 'Leave blank to keep the existing token; entering a new value replaces it.'
                    : formData.type === 'git-remote-github'
                      ? 'GitHub: Settings → Developer settings → Personal access tokens'
                      : 'GitLab: Settings → Access tokens'}
                </p>
              </div>
            )}
          </div>
        </section>

        <section className={styles.formSection} aria-labelledby="collection-rules-heading">
          <div className={styles.formSectionHeader}>
            <h2 id="collection-rules-heading">Collection rules</h2>
            <p>Limit collection to explicit branches and author emails, or leave branches blank to use the repository default.</p>
          </div>
          <div className={styles.fieldsGrid}>
            <div className={`${styles.field} ${styles.fieldWide}`}>
              <div className={styles.branchHeader}>
                <label htmlFor="branches">Branches</label>
                {isLocal(formData.type) && (
                  <span className={styles.branchStatus} role="status">
                    {branchLoading ? 'Reading current branch…' : currentBranch ? `Checked out: ${currentBranch}` : 'Current branch unavailable'}
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
                onRefresh={() => setBranchRefreshKey(key => key + 1)}
              />
              <p id="branches-help" className={styles.fieldHelp}>
                {isLocal(formData.type)
                  ? 'Leave blank to collect all local branches. You can enter a branch not shown in suggestions.'
                  : 'Leave blank to follow the repository default branch. You can enter a branch not shown in suggestions.'}
              </p>
            </div>

            <div className={`${styles.field} ${styles.fieldWide}`} role="group" aria-labelledby="author-emails-label">
              <div className={styles.fieldActionRow}>
                <span id="author-emails-label" className={styles.fieldLabel}>Author emails (comma-separated)</span>
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className={styles.textButton}
                >
                  <UserCircle size={15} aria-hidden="true" />
                  Select from repository
                </button>
              </div>
              <AutoCompleteInput
                value={formData.config.authorEmails}
                onChange={value => handleConfigChange('authorEmails', value)}
                suggestions={knownEmails}
                placeholder="e.g. user@example.com, work@company.com"
                className={styles.textInput}
                allowCreate
              />
              <p className={styles.fieldHelp}>Only collect commits from these email addresses.</p>
            </div>

            <div className={`${styles.field} ${styles.fieldWide}`}>
              <label className={styles.enableOption} htmlFor="enabled">
                <input
                  id="enabled"
                  type="checkbox"
                  checked={formData.enabled}
                  onChange={event => handleChange('enabled', event.target.checked)}
                />
                <span>Enable this source</span>
              </label>
            </div>
          </div>
        </section>

        {submitError && (
          <div className={`${styles.errorState} ${styles.formError}`} role="alert">
            <strong>Source could not be saved</strong>
            <p>{submitError}</p>
            <p>Review the configuration and try saving again.</p>
          </div>
        )}

        <div className={styles.formActions}>
          <button type="submit" className={styles.primaryButton} disabled={loading}>
            {loading && <Loader2 size={15} className="animate-spin" aria-hidden="true" />}
            {loading ? 'Saving…' : 'Save source'}
          </button>
          <button type="button" className={styles.secondaryButton} onClick={() => navigate('/collect')}>
            Cancel
          </button>
        </div>
      </form>

      <AuthorEmailPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onConfirm={emails => handleConfigChange('authorEmails', emails.join(', '))}
        currentEmails={formData.config.authorEmails.split(',').map(email => email.trim()).filter(Boolean)}
        repoParams={{
          sourceId,
          type: formData.type,
          path: isLocal(formData.type) ? formData.config.owner : undefined,
          owner: formData.config.owner,
          repo: formData.config.repo,
          token: formData.config.token,
          baseUrl: formData.config.baseUrl,
          branch: formData.config.branches[0]?.name || undefined,
        }}
      />
    </>
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
    !existing.has(branch) && branch.toLowerCase().includes(input.trim().toLowerCase()),
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

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      addBranch(input)
    } else if (event.key === 'Backspace' && !input && value.length > 0) {
      removeBranch(value[value.length - 1].name)
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className={styles.branchControl}>
      {value.map(branch => {
        const cursor = branch.lastCommitTime ? new Date(branch.lastCommitTime) : null
        const status = cursor && !Number.isNaN(cursor.getTime())
          ? `Synced through ${cursor.toLocaleString()}`
          : 'Awaiting first sync'
        return (
          <span key={branch.name} className={styles.branchTag}>
            <GitBranch size={12} aria-hidden="true" />
            <span>{branch.name}</span>
            <span className={styles.branchCursor} title={`${status} (committer date)`}>{status}</span>
            <button
              type="button"
              onClick={() => removeBranch(branch.name)}
              className={styles.branchRemove}
              aria-label={`Remove branch ${branch.name}`}
              title={`Remove branch ${branch.name}`}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        )
      })}
      <div className={styles.branchInputWrap}>
        <input
          id="branches"
          value={input}
          onChange={event => { setInput(event.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={handleKeyDown}
          placeholder={currentBranch ? `Current branch ${currentBranch} (leave blank for default)` : 'Leave blank for default branch'}
          aria-describedby="branches-help"
        />
        {open && (filtered.length > 0 || input.trim()) && (
          <div className={styles.suggestionMenu}>
            {filtered.map(branch => (
              <button
                key={branch}
                type="button"
                className={styles.suggestionOption}
                onMouseDown={event => event.preventDefault()}
                onClick={() => addBranch(branch)}
              >
                {branch}
              </button>
            ))}
            {input.trim() && !existing.has(input.trim()) && !suggestions.some(branch => branch.toLowerCase() === input.trim().toLowerCase()) && (
              <button
                type="button"
                className={styles.suggestionOption}
                onMouseDown={event => event.preventDefault()}
                onClick={() => addBranch(input)}
              >
                Add “{input.trim()}”
              </button>
            )}
          </div>
        )}
      </div>
      {showRefresh && isLocalPlaceholder(currentBranch, loading, error) && (
        <button
          type="button"
          className={styles.iconButton}
          onClick={onRefresh}
          title="Reload branches"
          aria-label="Reload branches"
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

function isLocalPlaceholder(currentBranch: string, loading: boolean, error: boolean) {
  return Boolean(loading || error || currentBranch)
}
