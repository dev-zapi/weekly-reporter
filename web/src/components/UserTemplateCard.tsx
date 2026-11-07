import { Link } from 'react-router'
import { Pencil, Trash2 } from 'lucide-react'
import type { Template } from '@/lib/db/schema'
import styles from './library-configuration.module.css'

interface UserTemplateCardProps {
  template: Template
  onUse?: (template: Template) => void
  onDelete: (id: number) => void
}

export function UserTemplateCard({ template, onUse, onDelete }: UserTemplateCardProps) {
  return (
    <article className={styles.recordRow}>
      <span className={styles.recordId}>T{template.id}</span>
      <div className={styles.recordBody}>
        <div className={styles.recordTitleLine}>
          <h2 className={styles.recordTitle}>{template.name}</h2>
          <span className={styles.badge}>Personal</span>
        </div>
        {template.description && (
          <p className={styles.recordDescription}>{template.description}</p>
        )}
        <div className={styles.recordMeta}>
          {template.tags && <span>Tags: {template.tags}</span>}
          {template.sourceTemplateId && (
            <span>
              Source: {template.sourceTemplateId.startsWith('official-') ? 'Official template' : 'User template'}
            </span>
          )}
        </div>
      </div>
      <div className={styles.recordActions} role="group" aria-label={`Actions for ${template.name}`}>
        {onUse && (
          <button type="button" className={styles.textButton} onClick={() => onUse(template)}>
            Use
          </button>
        )}
        <Link
          to={`/templates/${template.id}`}
          className={styles.iconButton}
          aria-label={`Edit template ${template.name}`}
          title="Edit template"
        >
          <Pencil size={15} aria-hidden="true" />
        </Link>
        <button
          type="button"
          className={`${styles.iconButton} ${styles.dangerButton}`}
          aria-label={`Delete template ${template.name}`}
          title="Delete template"
          onClick={() => onDelete(template.id)}
        >
          <Trash2 size={15} aria-hidden="true" />
        </button>
      </div>
    </article>
  )
}
