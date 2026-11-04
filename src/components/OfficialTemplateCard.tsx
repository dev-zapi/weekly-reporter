'use client'

import { Copy, Eye, FilePlus2 } from 'lucide-react'
import type { OfficialTemplate } from '@/lib/official-templates'
import styles from './library-configuration.module.css'

interface OfficialTemplateCardProps {
  template: OfficialTemplate
  onClone: (templateId: string) => void
  onSaveAs: (templateId: string) => void
  onView: (templateId: string) => void
}

export function OfficialTemplateCard({ template, onClone, onSaveAs, onView }: OfficialTemplateCardProps) {
  return (
    <article className={styles.recordRow}>
      <span className={styles.recordId}>{template.id}</span>
      <div className={styles.recordBody}>
        <div className={styles.recordTitleLine}>
          <h2 className={styles.recordTitle}>{template.name}</h2>
          <span className={styles.badge}>Official</span>
        </div>
        <p className={styles.recordDescription}>{template.description}</p>
        {template.tags.length > 0 && (
          <div className={styles.recordMeta}>
            <span>Tags: {template.tags.join(', ')}</span>
          </div>
        )}
      </div>
      <div className={styles.recordActions} role="group" aria-label={`Actions for ${template.name}`}>
        <button type="button" className={styles.textButton} onClick={() => onView(template.id)}>
          <Eye size={14} aria-hidden="true" />
          View details
        </button>
        <button type="button" className={styles.textButton} onClick={() => onClone(template.id)}>
          <Copy size={14} aria-hidden="true" />
          Quick clone
        </button>
        <button type="button" className={styles.textButton} onClick={() => onSaveAs(template.id)}>
          <FilePlus2 size={14} aria-hidden="true" />
          Save as
        </button>
      </div>
    </article>
  )
}
