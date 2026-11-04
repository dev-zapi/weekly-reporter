'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Label } from '@/components/ui/label'
import { TemplateContentEditor } from '@/components/TemplateContentEditor'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { OfficialTemplate } from '@/lib/official-templates'
import type { Template } from '@/lib/db/schema'
import styles from './library-configuration.module.css'

interface CloneTemplateDialogProps {
  template: OfficialTemplate | Template | null
  open: boolean
  onClose: () => void
  onClone: (data: { sourceId: string; name: string; content: string }) => Promise<void>
}

interface CloneTemplateDialogContentProps extends Omit<CloneTemplateDialogProps, 'template'> {
  template: OfficialTemplate | Template
}

export function CloneTemplateDialog(props: CloneTemplateDialogProps) {
  if (!props.template) return null
  return (
    <CloneTemplateDialogContent
      key={`${props.template.id}-${props.open}`}
      {...props}
      template={props.template}
    />
  )
}

function CloneTemplateDialogContent({ template, open, onClose, onClone }: CloneTemplateDialogContentProps) {
  const [name, setName] = useState('')
  const [content, setContent] = useState(template.content)
  const [saving, setSaving] = useState(false)

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim()) {
      toast.error('Please enter a template name')
      return
    }

    if (!content.trim()) {
      toast.error('Please enter template content')
      return
    }

    setSaving(true)

    try {
      const sourceId = typeof template.id === 'string' ? template.id : `user-${template.id}`
      await onClone({ sourceId, name, content })
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className={styles.dialogContent}>
        <DialogHeader>
          <DialogTitle className={styles.dialogTitle}>Save as personal template</DialogTitle>
          <DialogDescription className={styles.dialogDescription}>
            Save “{template.name}” as a new personal template and customize it.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSave} className={styles.dialogBody}>
          <div className={styles.field}>
            <Label htmlFor="clone-name" className={styles.fieldLabel}>Template name</Label>
            <input
              id="clone-name"
              className={styles.input}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. My development report"
            />
          </div>

          <div className={styles.field}>
            <Label className={styles.fieldLabel}>Template content</Label>
            <TemplateContentEditor value={content} onChange={setContent} />
          </div>

          <DialogFooter className={styles.dialogFooter}>
            <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className={styles.primaryButton} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
