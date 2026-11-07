
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { OfficialTemplate } from '@/lib/official-templates'
import { TemplateContentEditor } from '@/components/TemplateContentEditor'
import styles from './library-configuration.module.css'

interface ViewTemplateDialogProps {
  template: OfficialTemplate | null
  open: boolean
  onClose: () => void
}

export function ViewTemplateDialog({ template, open, onClose }: ViewTemplateDialogProps) {
  if (!template) return null

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className={styles.dialogContent}>
        <DialogHeader>
          <div className={styles.dialogTitleRow}>
            <DialogTitle className={styles.dialogTitle}>{template.name}</DialogTitle>
            <span className={styles.recordRef}>{template.id}</span>
          </div>
          <DialogDescription className={styles.dialogDescription}>
            {template.description}
          </DialogDescription>
        </DialogHeader>

        <div className={styles.dialogBody}>
          {template.tags.length > 0 && (
            <div className={styles.recordMeta}>Tags: {template.tags.join(', ')}</div>
          )}

          <div className={styles.field}>
            <span className={styles.fieldLabel}>Template content</span>
            <TemplateContentEditor value={template.content} onChange={() => {}} readOnly />
          </div>
        </div>

        <DialogFooter className={styles.dialogFooter}>
          <button type="button" className={styles.secondaryButton} onClick={onClose}>
            Close
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
