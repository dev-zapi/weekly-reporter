'use client'
import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import type { SentenceSnippet } from '@/lib/db/schema'

interface AddSnippetDialogProps {
  open: boolean
  onClose: () => void
  onAdd: (snippet: SentenceSnippet) => void
}

const PRESET_CATEGORIES = [
  'General',
  'Achievements',
  'Problem solving',
  'Teamwork',
  'Learning',
  'Project progress',
  'Technical breakthroughs',
  'Other',
]

export function AddSnippetDialog({ open, onClose, onAdd }: AddSnippetDialogProps) {
  const [category, setCategory] = useState('General')
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Validation
    if (!content.trim()) {
      toast.error('Please enter snippet content')
      return
    }

    if (content.length > 500) {
      toast.error('Content must be 500 characters or fewer')
      return
    }

    setSubmitting(true)

    try {
      const response = await apiFetch('/api/snippets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: content.trim(),
          category,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error((error.error || 'Add failed') + traceSuffix(response))
      }

      const data = await response.json()
      onAdd(data.snippet)
      toast.success('Snippet added')
      
      // Reset form
      setContent('')
      setCategory('General')
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Add failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleClose = () => {
    setContent('')
    setCategory('General')
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Add snippet</DialogTitle>
        </DialogHeader>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="category">Category</Label>
            <Select value={category} onValueChange={(value) => setCategory(value as string)}>
              <SelectTrigger id="category">
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                {PRESET_CATEGORIES.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="content">Content</Label>
              <span className={`text-xs ${content.length > 500 ? 'text-destructive' : 'text-muted-foreground'}`}>
                {content.length}/500
              </span>
            </div>
            <textarea
              id="content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Enter a snippet to save..."
              className="w-full min-h-[120px] px-3 py-2 text-sm border border-input rounded-lg bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 transition-all"
              rows={5}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Adding...' : 'Add'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
