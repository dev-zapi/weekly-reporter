'use client'
import { apiFetch } from '@/lib/api-client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

interface TagWithCount {
  name: string
  count: number
}

interface TagFilterPanelProps {
  selectedTags: string[]
  onTagSelect: (tag: string) => void
  onClearTags: () => void
  onTagsChanged: () => void
  tagsVersion: number
}

export function TagFilterPanel({
  selectedTags,
  onTagSelect,
  onClearTags,
  onTagsChanged,
  tagsVersion,
}: TagFilterPanelProps) {
  const [tags, setTags] = useState<TagWithCount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Rename dialog state
  const [renameTarget, setRenameTarget] = useState<TagWithCount | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameOpen, setRenameOpen] = useState(false)

  // Delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<TagWithCount | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    const fetchTags = async () => {
      try {
        setLoading(true)
        setError(null)
        const res = await apiFetch('/api/tags')
        if (!res.ok) throw new Error('Failed to fetch tags')
        const data = await res.json()
        if (!cancelled) {
          setTags(data.tags ?? [])
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unknown error')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchTags()
    return () => { cancelled = true }
  }, [tagsVersion])

  const handleRenameClick = (tag: TagWithCount, e: React.MouseEvent) => {
    e.stopPropagation()
    setRenameTarget(tag)
    setRenameValue(tag.name)
    setRenameOpen(true)
  }

  const handleRenameConfirm = async () => {
    if (!renameTarget) return
    const trimmed = renameValue.trim()
    if (!trimmed) {
      toast.error('Tag name cannot be empty')
      return
    }
    if (trimmed === renameTarget.name) {
      setRenameOpen(false)
      return
    }
    try {
      const res = await apiFetch('/api/tags/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: renameTarget.name, to: trimmed }),
      })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error ?? 'Failed to rename tag')
      }
      toast.success('Tag renamed')
      setRenameOpen(false)
      onTagsChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to rename tag')
    }
  }

  const handleDeleteClick = (tag: TagWithCount, e: React.MouseEvent) => {
    e.stopPropagation()
    setDeleteTarget(tag)
    setDeleteOpen(true)
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    try {
      const res = await apiFetch(
        `/api/tags?name=${encodeURIComponent(deleteTarget.name)}`,
        { method: 'DELETE' },
      )
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error ?? 'Failed to delete tag')
      }
      toast.success('Tag deleted')
      setDeleteOpen(false)
      onTagsChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete tag')
    }
  }

  return (
    <div className="space-y-4 p-4 border rounded-lg bg-card">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">标签筛选</h3>
        {selectedTags.length > 0 && (
          <Button size="sm" variant="ghost" onClick={onClearTags}>
            Clear
          </Button>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : error ? (
        <div className="text-sm text-destructive">{error}</div>
      ) : tags.length === 0 ? (
        <div className="text-sm text-muted-foreground">暂无标签</div>
      ) : (
        <div className="space-y-2">
          {tags.map((tag) => {
            const checked = selectedTags.includes(tag.name)
            return (
              <div key={tag.name} className="group flex items-center gap-2">
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => onTagSelect(tag.name)}
                />
                <span
                  className={cn(
                    'text-sm flex-1 cursor-pointer',
                    checked ? 'font-medium' : 'text-muted-foreground',
                  )}
                  onClick={() => onTagSelect(tag.name)}
                >
                  #{tag.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  ({tag.count})
                </span>
                <button
                  type="button"
                  onClick={(e) => handleRenameClick(tag, e)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-accent rounded"
                  aria-label="Rename tag"
                >
                  <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
                <button
                  type="button"
                  onClick={(e) => handleDeleteClick(tag, e)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-accent rounded"
                  aria-label="Delete tag"
                >
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename tag</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm text-muted-foreground">
              New name for <span className="font-medium text-foreground">#{renameTarget?.name}</span>
            </label>
            <input
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleRenameConfirm()
                }
              }}
              autoFocus
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="Tag name"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleRenameConfirm}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete tag</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Delete <span className="font-medium text-foreground">#{deleteTarget?.name}</span> from all events?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteConfirm}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
