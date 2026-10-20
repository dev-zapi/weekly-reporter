'use client'
import { apiFetch } from '@/lib/api-client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { CheckSquare, Square, Loader2, UserCircle } from 'lucide-react'

export interface AuthorInfo {
  email: string
  name: string
  count: number
}

interface AuthorEmailPickerProps {
  open: boolean
  onClose: () => void
  onConfirm: (emails: string[]) => void
  currentEmails: string[]
  repoParams: {
    type: string
    path?: string
    owner?: string
    repo?: string
    token?: string
    baseUrl?: string
    branch?: string
  }
}

export function AuthorEmailPicker({
  open,
  onClose,
  onConfirm,
  currentEmails,
  repoParams,
}: AuthorEmailPickerProps) {
  const [authors, setAuthors] = useState<AuthorInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    setSelected(new Set(currentEmails))
    fetchAuthors()
  }, [open])

  async function fetchAuthors() {
    setLoading(true)
    const params = new URLSearchParams({ type: repoParams.type })
    if (repoParams.path) params.set('path', repoParams.path)
    if (repoParams.owner) params.set('owner', repoParams.owner)
    if (repoParams.repo) params.set('repo', repoParams.repo)
    if (repoParams.token) params.set('token', repoParams.token)
    if (repoParams.baseUrl) params.set('baseUrl', repoParams.baseUrl)
    if (repoParams.branch) params.set('branch', repoParams.branch)

    try {
      const res = await apiFetch(`/api/collect/sources/emails?${params}`)
      const data = await res.json()
      setAuthors(data.authors || [])
    } catch {
      setAuthors([])
    } finally {
      setLoading(false)
    }
  }

  function toggleEmail(email: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(email)) next.delete(email)
      else next.add(email)
      return next
    })
  }

  function handleSelectAll() {
    setSelected(new Set(authors.map(a => a.email)))
  }

  function handleDeselectAll() {
    setSelected(new Set())
  }

  function handleConfirm() {
    onConfirm([...selected])
    onClose()
  }

  if (!open) return null

  const allSelected = authors.length > 0 && authors.every(a => selected.has(a.email))
  const someSelected = selected.size > 0 && !allSelected

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card border rounded-xl shadow-xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="text-base font-semibold">Select author emails</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-xl leading-none px-1">
            ✕
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center justify-between px-5 py-2 border-b bg-muted/30 text-xs">
          <div className="flex items-center gap-2">
            <button
              onClick={allSelected ? handleDeselectAll : handleSelectAll}
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              {allSelected ? <CheckSquare className="h-3.5 w-3.5" /> : someSelected ? <Square className="h-3.5 w-3.5 text-primary" /> : <Square className="h-3.5 w-3.5" />}
              {allSelected ? 'Clear all' : 'Select all'}
            </button>
            <span className="text-muted-foreground">
              Selected {selected.size} / {authors.length}
            </span>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Loading authors…
            </div>
          ) : authors.length === 0 ? (
            <div className="text-center py-12 text-sm text-muted-foreground">
              No author information found. Enter a repository path/token first.
            </div>
          ) : (
            <div className="divide-y">
              {authors.map(author => {
                const isChecked = selected.has(author.email)
                return (
                  <button
                    key={author.email}
                    onClick={() => toggleEmail(author.email)}
                    className={`w-full flex items-center gap-3 px-5 py-2.5 text-left hover:bg-muted/50 transition-colors ${isChecked ? 'bg-primary/5' : ''}`}
                  >
                    <div className="shrink-0">
                      {isChecked ? (
                        <CheckSquare className="h-4 w-4 text-primary" />
                      ) : (
                        <Square className="h-4 w-4 text-muted-foreground/50" />
                      )}
                    </div>
                    <UserCircle className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{author.name}</div>
                      <div className="text-xs text-muted-foreground truncate">{author.email}</div>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0 tabular-nums">{author.count}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t bg-muted/30">
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleConfirm} disabled={selected.size === 0}>
            Confirm selection ({selected.size})
          </Button>
        </div>
      </div>
    </div>
  )
}
