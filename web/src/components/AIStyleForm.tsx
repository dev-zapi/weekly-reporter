import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, RotateCcw, X } from 'lucide-react'
import { useBlocker, useNavigate } from 'react-router'
import { toast } from 'sonner'
import type { AIStyleRow } from '@/lib/db/schema'
import {
  aiStyleDraftKey,
  clearAIStyleDraft,
  emptyStyleForm,
  formForAIStyle,
  randomStyleKey,
  readAIStyleDraft,
  writeAIStyleDraft,
  type StyleFormData,
} from '@/lib/ai-style-drafts'
import { WorkbenchLayout } from '@/components/WorkbenchLayout'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { AIStyleRecordDetails, aiStyleParameterLabel } from './AIStyleDetails'
import libraryStyles from './library-configuration.module.css'
import styles from './ai-style-workbench.module.css'

export function AIStyleForm({ style, isNew, onSave }: {
  style?: AIStyleRow
  isNew: boolean
  onSave: (form: StyleFormData) => Promise<number>
}) {
  const navigate = useNavigate()
  const [baseline] = useState<StyleFormData>(() => style ? formForAIStyle(style) : emptyStyleForm(randomStyleKey()))
  const [draftKey] = useState(() => aiStyleDraftKey(isNew ? 'new' : 'edit', style?.id))
  const [initialDraft] = useState(() => readAIStyleDraft(draftKey))
  const [form, setForm] = useState<StyleFormData>(() => initialDraft ?? baseline)
  const [restored, setRestored] = useState(Boolean(initialDraft))
  const [draftStorageAvailable, setDraftStorageAvailable] = useState(true)
  const [saving, setSaving] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const allowNavigation = useRef(false)
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline)
  const blocker = useBlocker(() => dirty && !saving && !allowNavigation.current)

  useEffect(() => {
    if (!dirty) {
      clearAIStyleDraft(draftKey)
      return
    }
    setDraftStorageAvailable(writeAIStyleDraft(draftKey, form))
  }, [dirty, draftKey, form])

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!dirty || allowNavigation.current) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])

  function update(patch: Partial<StyleFormData>) {
    setForm((current) => ({ ...current, ...patch }))
  }

  function discardDraft() {
    clearAIStyleDraft(draftKey)
    setForm(baseline)
    setRestored(false)
  }

  function destinationFor(id?: number) {
    const targetId = id ?? style?.id
    return targetId ? `/prompts?tab=styles&style=${targetId}` : '/prompts?tab=styles'
  }

  function leave(destination: string) {
    allowNavigation.current = true
    navigate(destination)
  }

  function requestCancel() {
    if (!dirty) {
      leave(destinationFor())
      return
    }
    setCancelOpen(true)
  }

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    try {
      const id = await onSave(form)
      clearAIStyleDraft(draftKey)
      toast.success(isNew ? 'Style created' : 'Style updated')
      leave(destinationFor(id))
    } catch {
      // The page owns API error reporting; keep every field and the draft intact.
    } finally {
      setSaving(false)
    }
  }

  return (
    <WorkbenchLayout className={styles.page}>
      <WorkbenchLayout.Primary className={`${libraryStyles.surface} ${styles.editorPrimary}`} aria-label="AI style editor">
        <button type="button" className={libraryStyles.backLink} onClick={requestCancel}>
          <ArrowLeft size={14} aria-hidden="true" /> {isNew ? 'Back to style list' : 'Back to style details'}
        </button>
        {restored && (
          <div className={styles.draftNotice} role="status">
            <RotateCcw size={16} aria-hidden="true" />
            <div>
              <strong>Local draft restored</strong>
              <span>Recovered unsaved input from this browser. Saving or discarding removes the draft.</span>
            </div>
            <button type="button" onClick={discardDraft}>Discard draft</button>
          </div>
        )}
        <header className={styles.editorHeading}>
          <div className={libraryStyles.headingText}>
            <div className={libraryStyles.titleRow}>
              <h1 id="ai-style-editor-title">{isNew ? 'New AI style' : 'Edit AI style'}</h1>
              {style && <span className={styles.recordRef}>S{style.id}</span>}
            </div>
            <p className={libraryStyles.description}>
              {isNew
                ? 'Define a reusable writing instruction and its generation parameters.'
                : `${style?.label} · ${style?.key}`}
            </p>
          </div>
        </header>

        <form className={styles.editorForm} onSubmit={(event) => void submit(event)}>
          <div className={libraryStyles.fieldGrid}>
            <div className={libraryStyles.field}>
              <Label htmlFor="ai-style-key" className={libraryStyles.fieldLabel}>Identifier (key)</Label>
              <div className={libraryStyles.keyField}>
                <input
                  id="ai-style-key"
                  className={libraryStyles.input}
                  value={form.key}
                  onChange={(event) => update({ key: event.target.value })}
                  pattern="^[a-z][a-z0-9_\-]*$"
                  maxLength={50}
                  required
                />
                <button
                  type="button"
                  className={libraryStyles.iconButton}
                  aria-label="Generate random style identifier"
                  title="Generate randomly"
                  onClick={() => update({ key: randomStyleKey() })}
                >
                  <RotateCcw size={15} aria-hidden="true" />
                </button>
              </div>
            </div>
            <div className={libraryStyles.field}>
              <Label htmlFor="ai-style-label" className={libraryStyles.fieldLabel}>Name</Label>
              <input
                id="ai-style-label"
                className={libraryStyles.input}
                value={form.label}
                onChange={(event) => update({ label: event.target.value })}
                maxLength={50}
                required
              />
            </div>
          </div>

          <div className={libraryStyles.field}>
            <Label htmlFor="ai-style-prompt" className={libraryStyles.fieldLabel}>System Prompt</Label>
            <textarea
              id="ai-style-prompt"
              className={`${libraryStyles.textarea} ${styles.promptTextarea}`}
              value={form.systemPrompt}
              onChange={(event) => update({ systemPrompt: event.target.value })}
              maxLength={5000}
              required
            />
            <span className={styles.fieldHint}>{form.systemPrompt.length} / 5000 · unsaved input is stored as a local draft</span>
          </div>

          <div className={styles.editorActions}>
            <span role="status">
              {!draftStorageAvailable && dirty
                ? 'Local draft storage is unavailable; keep this page open while editing.'
                : dirty ? 'Unsaved changes · local draft active' : 'No unsaved changes'}
            </span>
            <button type="button" className={libraryStyles.secondaryButton} onClick={requestCancel} disabled={saving}>
              <X size={14} aria-hidden="true" /> Cancel
            </button>
            <button type="submit" className={libraryStyles.primaryButton} disabled={saving}>
              <Check size={14} aria-hidden="true" /> {saving ? 'Saving…' : isNew ? 'Create style' : 'Save changes'}
            </button>
          </div>
        </form>
      </WorkbenchLayout.Primary>

      <WorkbenchLayout.Rail className={styles.editorRail} label="AI style generation settings">
        <section className={styles.settingsPanel} aria-labelledby="ai-style-settings-title">
          <div className={styles.panelHeader}>
            <div><span className={styles.recordRef}>Generation</span><h2 id="ai-style-settings-title">Style settings</h2></div>
          </div>
          <div className={styles.checkboxField}>
            <Checkbox
              id="ai-style-default"
              checked={form.isDefault}
              onCheckedChange={(checked) => update({ isDefault: checked === true })}
            />
            <Label htmlFor="ai-style-default">Set as default style</Label>
          </div>
          <div className={libraryStyles.field}>
            <Label htmlFor="ai-style-temperature" className={libraryStyles.fieldLabel}>
              Temperature ({form.temperature.toFixed(1)})
            </Label>
            <input
              id="ai-style-temperature"
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={form.temperature}
              onChange={(event) => update({ temperature: Number.parseFloat(event.target.value) })}
              className={libraryStyles.range}
            />
            <span className={styles.fieldHint}>Lower is more deterministic; higher allows more variation.</span>
          </div>
          <div className={libraryStyles.field}>
            <span className={libraryStyles.fieldLabel}>Detail level</span>
            <Select value={form.detailLevel || 'medium'} onValueChange={(value) => update({ detailLevel: value as string })}>
              <SelectTrigger className={libraryStyles.selectTrigger} aria-label="Detail level">
                <SelectValue>{(value: string) => aiStyleParameterLabel(value, 'detail')}</SelectValue>
              </SelectTrigger>
              <SelectContent className={libraryStyles.selectContent}>
                <SelectItem value="low" className={libraryStyles.selectItem}>Concise</SelectItem>
                <SelectItem value="medium" className={libraryStyles.selectItem}>Balanced</SelectItem>
                <SelectItem value="high" className={libraryStyles.selectItem}>Detailed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className={libraryStyles.field}>
            <span className={libraryStyles.fieldLabel}>Result orientation</span>
            <Select value={form.resultOriented || 'medium'} onValueChange={(value) => update({ resultOriented: value as string })}>
              <SelectTrigger className={libraryStyles.selectTrigger} aria-label="Result orientation">
                <SelectValue>{(value: string) => aiStyleParameterLabel(value, 'result')}</SelectValue>
              </SelectTrigger>
              <SelectContent className={libraryStyles.selectContent}>
                <SelectItem value="low" className={libraryStyles.selectItem}>Low</SelectItem>
                <SelectItem value="medium" className={libraryStyles.selectItem}>Medium</SelectItem>
                <SelectItem value="high" className={libraryStyles.selectItem}>High</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </section>

        <section className={styles.settingsPanel} aria-labelledby="ai-style-draft-title">
          <div className={styles.panelHeader}>
            <div><span className={styles.recordRef}>Draft state</span><h2 id="ai-style-draft-title">Local recovery</h2></div>
          </div>
          <p>{dirty
            ? 'This browser keeps a draft. Ordinary navigation preserves it; saving or explicitly discarding clears it.'
            : 'The form matches the saved record.'}</p>
        </section>

        {style && (
          <section className={styles.settingsPanel} aria-labelledby="ai-style-history-title">
            <div className={styles.panelHeader}>
              <div><span className={styles.recordRef}>S{style.id}</span><h2 id="ai-style-history-title">Record history</h2></div>
            </div>
            <AIStyleRecordDetails style={style} />
          </section>
        )}
      </WorkbenchLayout.Rail>

      <Dialog open={blocker.state === 'blocked'} onOpenChange={(open) => {
        if (!open && blocker.state === 'blocked') blocker.reset()
      }}>
        <DialogContent className={libraryStyles.dialogContent}>
          <DialogHeader>
            <DialogTitle>Leave the editor?</DialogTitle>
            <DialogDescription>Your local draft will be kept and restored when you return. You can also discard it before leaving.</DialogDescription>
          </DialogHeader>
          <DialogFooter className={libraryStyles.dialogFooter}>
            <button type="button" className={libraryStyles.secondaryButton} onClick={() => {
              if (blocker.state === 'blocked') blocker.reset()
            }}>Keep editing</button>
            <button type="button" className={`${libraryStyles.secondaryButton} ${libraryStyles.dangerButton}`} onClick={() => {
              clearAIStyleDraft(draftKey)
              allowNavigation.current = true
              if (blocker.state === 'blocked') blocker.proceed()
            }}>Discard and leave</button>
            <button type="button" className={libraryStyles.primaryButton} onClick={() => {
              allowNavigation.current = true
              if (blocker.state === 'blocked') blocker.proceed()
            }}>Leave and keep draft</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className={libraryStyles.dialogContent}>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>Canceling now clears the local draft and returns to the style list.</DialogDescription>
          </DialogHeader>
          <DialogFooter className={libraryStyles.dialogFooter}>
            <button type="button" className={libraryStyles.secondaryButton} onClick={() => setCancelOpen(false)}>Keep editing</button>
            <button type="button" className={`${libraryStyles.secondaryButton} ${libraryStyles.dangerButton}`} onClick={() => {
              clearAIStyleDraft(draftKey)
              setCancelOpen(false)
              leave(destinationFor())
            }}>Discard and leave</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </WorkbenchLayout>
  )
}
