'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Label } from '@/components/ui/label'
import { TemplateContentEditor } from '@/components/TemplateContentEditor'
import type { Template } from '@/lib/db/schema'
import styles from './library-configuration.module.css'

interface TemplateFormProps {
  template?: Template
  onSave: (data: {
    name: string
    content: string
    description?: string
    tags?: string
  }) => Promise<void>
  onCancel: () => void
}

export function TemplateForm({ template, onSave, onCancel }: TemplateFormProps) {
  const [name, setName] = useState(template?.name || '')
  const [content, setContent] = useState(template?.content || '')
  const [description, setDescription] = useState(template?.description || '')
  const [tags, setTags] = useState(template?.tags || '')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    if (!name.trim() || !content.trim()) {
      toast.error('Please enter a template name and content')
      return
    }

    setSaving(true)

    try {
      await onSave({
        name,
        content,
        description: description.trim() || undefined,
        tags: tags.trim() || undefined,
      })
      toast.success('Template saved')
    } catch {
      toast.error('Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <div className={styles.fieldGrid}>
        <div className={styles.field}>
          <Label htmlFor="name" className={styles.fieldLabel}>Template name</Label>
          <input
            id="name"
            className={styles.input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Development weekly report"
          />
        </div>

        <div className={styles.field}>
          <Label htmlFor="tags" className={styles.fieldLabel}>Tags</Label>
          <input
            id="tags"
            className={styles.input}
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="e.g. development, engineering"
          />
        </div>
      </div>

      <div className={styles.field}>
        <Label htmlFor="description" className={styles.fieldLabel}>Description</Label>
        <input
          id="description"
          className={styles.input}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="e.g. For engineering teams"
        />
      </div>

      <div className={styles.field}>
        <Label className={styles.fieldLabel}>Template content</Label>
        <TemplateContentEditor value={content} onChange={setContent} />
      </div>

      <div className={styles.formActions}>
        <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className={styles.primaryButton} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}
