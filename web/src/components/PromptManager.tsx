
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Pencil, Plus, RotateCcw, Star, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { apiFetch, traceSuffix } from '@/lib/api-client'
import type { AIStyleRow, SystemPromptRow } from '@/lib/db/schema'
import { useAIStyles } from './useAIStyles'
import type { StyleFormData } from './useAIStyles'
import styles from './library-configuration.module.css'

const RANDOM_WORDS = [
  'nova', 'apex', 'zen', 'flux', 'core', 'sage', 'echo', 'pulse',
  'spark', 'wave', 'beam', 'dash', 'glow', 'prism', 'forge', 'rift',
  'swift', 'crisp', 'pure', 'bold', 'keen', 'vivid', 'calm', 'dusk',
]

const DEFAULT_CHECK = `You are a weekly report writing assistant. Analyze the content below and provide improvement suggestions.

Content:
{{content}}

{{#section}}Current section: {{section}}{{/section}}

Analyze these aspects:
1. Specific data and details
2. Clear results and value
3. Clear and concise wording
4. Better ways to express the content

Give specific, concise suggestions (no more than 20 words each).
If the content is already strong, return an empty array [].`

const DEFAULT_GENERATE = `你是周报终版生成助手。请严格依据原稿中的事实，按照模板要求输出 Markdown 周报。

规则：
- 只处理当前受众版本提供的原稿，不得引入其他版本的信息。
- 可以重组、合并、概括和补全表达，但不得虚构项目、数字、结果、时间或计划。
- 模板是格式规范，不要输出模板占位符、解释文字或代码围栏。
- 原稿没有事实支撑的章节请省略，或明确写出暂无内容。
- 只返回终版 Markdown 正文。`

const SYSTEM_PROMPTS = [
  {
    key: 'check',
    title: 'Writing suggestions prompt',
    description: 'Checks report content in real time and provides suggestions.',
    variables: ['{{content}}', '{{section}}'],
    defaultText: DEFAULT_CHECK,
  },
  {
    key: 'generate',
    title: 'Final report generation prompt',
    description: 'Generates the final report from the selected source draft, template, and AI style.',
    variables: [],
    defaultText: DEFAULT_GENERATE,
  },
] as const

function randomWord(): string {
  return RANDOM_WORDS[Math.floor(Math.random() * RANDOM_WORDS.length)]
}

function emptyStyleForm(key = ''): StyleFormData {
  return {
    key,
    label: '',
    systemPrompt: '',
    temperature: 0.3,
    detailLevel: 'medium',
    resultOriented: 'medium',
    isDefault: false,
  }
}

function regenerateKey(form: StyleFormData, setForm: (form: StyleFormData) => void) {
  setForm({ ...form, key: randomWord() })
}

export function PromptManager() {
  const [activeTab, setActiveTab] = useState<'styles' | 'system'>('styles')

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as 'styles' | 'system')}
      className={styles.tabs}
    >
      <TabsList className={styles.tabsList} aria-label="Prompt configuration">
        <TabsTrigger value="styles" className={styles.tabTrigger}>Style management</TabsTrigger>
        <TabsTrigger value="system" className={styles.tabTrigger}>System prompts</TabsTrigger>
      </TabsList>
      <TabsContent value="styles" className={styles.tabContent}>
        <StyleTab />
      </TabsContent>
      <TabsContent value="system" className={styles.tabContent}>
        <SystemPromptTab />
      </TabsContent>
    </Tabs>
  )
}

function StyleTab() {
  const { styles: aiStyles, loading, error, retry, create, update, remove, setDefault } = useAIStyles()
  const [editing, setEditing] = useState<AIStyleRow | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  // Random keys are generated only after the create dialog opens in the browser.
  const [form, setForm] = useState<StyleFormData>(() => emptyStyleForm())
  const [showAdvanced, setShowAdvanced] = useState(false)

  function openCreate() {
    setEditing(null)
    setForm(emptyStyleForm(randomWord()))
    setShowAdvanced(false)
    setDialogOpen(true)
  }

  function openEdit(style: AIStyleRow) {
    setEditing(style)
    setForm({
      key: style.key,
      label: style.label,
      systemPrompt: style.systemPrompt,
      temperature: parseFloat(style.temperature),
      detailLevel: style.detailLevel ?? 'medium',
      resultOriented: style.resultOriented ?? 'medium',
      isDefault: style.isDefault,
    })
    setShowAdvanced(false)
    setDialogOpen(true)
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const payload = {
      ...form,
      detailLevel: form.detailLevel || undefined,
      resultOriented: form.resultOriented || undefined,
    } as StyleFormData

    setSaving(true)
    try {
      const ok = editing ? await update(editing.id, payload) : await create(payload)
      if (ok) setDialogOpen(false)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(style: AIStyleRow) {
    if (!confirm(`Delete style “${style.label}”?`)) return
    await remove(style.id)
  }

  if (loading) {
    return (
      <div className={styles.loadingState} role="status">
        <span className={styles.loadingLine} aria-hidden="true" />
        <strong>Loading AI styles…</strong>
      </div>
    )
  }

  return (
    <div>
      <div className={styles.indexBar}>
        <div className={styles.indexTitle}>
          <h2>AI style index</h2>
          <span className={styles.count}>{aiStyles.length} styles</span>
        </div>
        <button type="button" className={styles.primaryButton} onClick={openCreate}>
          <Plus size={15} aria-hidden="true" />
          New style
        </button>
      </div>

      {error ? (
        <div className={styles.errorState} role="alert">
          <strong>AI styles could not be loaded</strong>
          <p>{error}</p>
          <button type="button" className={styles.stateAction} onClick={() => void retry()}>
            Retry loading styles
          </button>
        </div>
      ) : aiStyles.length === 0 ? (
        <div className={styles.emptyState}>
          <strong>No styles yet</strong>
          <p>Create an AI style to define the voice and generation parameters available for reports.</p>
          <button type="button" className={styles.secondaryButton} onClick={openCreate}>
            <Plus size={15} aria-hidden="true" />
            New style
          </button>
        </div>
      ) : (
        <div className={styles.recordList}>
          {aiStyles.map((style) => (
            <article key={style.id} className={styles.recordRow}>
              <span className={styles.recordId}>S{style.id}</span>
              <div className={styles.recordBody}>
                <div className={styles.recordTitleLine}>
                  <h3 className={styles.recordTitle}>{style.label}</h3>
                  {style.isDefault && <span className={`${styles.badge} ${styles.defaultBadge}`}>Default</span>}
                </div>
                <div className={styles.recordMeta}>
                  <span>Key: {style.key}</span>
                  <span>Temperature: {style.temperature}</span>
                </div>
                <p className={styles.recordDescription}>{style.systemPrompt.slice(0, 100)}...</p>
              </div>
              <div className={styles.recordActions} role="group" aria-label={`Actions for ${style.label}`}>
                {!style.isDefault && (
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label={`Set ${style.label} as default`}
                    title="Set as default"
                    onClick={() => void setDefault(style.id)}
                  >
                    <Star size={15} aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={`Edit style ${style.label}`}
                  title="Edit style"
                  onClick={() => openEdit(style)}
                >
                  <Pencil size={15} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={`${styles.iconButton} ${styles.dangerButton}`}
                  aria-label={`Delete style ${style.label}`}
                  title="Delete style"
                  onClick={() => void handleDelete(style)}
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className={styles.dialogContent}>
          <DialogHeader>
            <div className={styles.dialogTitleRow}>
              <DialogTitle className={styles.dialogTitle}>{editing ? 'Edit style' : 'New style'}</DialogTitle>
              {editing && <span className={styles.recordRef}>S{editing.id}</span>}
            </div>
          </DialogHeader>
          <form onSubmit={handleSubmit} className={styles.dialogBody}>
            <div className={styles.fieldGrid}>
              <div className={styles.field}>
                <Label htmlFor="skey" className={styles.fieldLabel}>Identifier (key)</Label>
                <div className={styles.keyField}>
                  <input
                    id="skey"
                    className={styles.input}
                    value={form.key}
                    onChange={(event) => setForm({ ...form, key: event.target.value })}
                    pattern="^[a-z][a-z0-9_\-]*$"
                    required
                  />
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label="Generate random style identifier"
                    title="Generate randomly"
                    onClick={() => regenerateKey(form, setForm)}
                  >
                    <RotateCcw size={15} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className={styles.field}>
                <Label htmlFor="slabel" className={styles.fieldLabel}>Name</Label>
                <input
                  id="slabel"
                  className={styles.input}
                  value={form.label}
                  onChange={(event) => setForm({ ...form, label: event.target.value })}
                  required
                  maxLength={50}
                />
              </div>
            </div>

            <div className={styles.field}>
              <Label htmlFor="sprompt" className={styles.fieldLabel}>System Prompt</Label>
              <textarea
                id="sprompt"
                className={styles.textarea}
                value={form.systemPrompt}
                onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })}
                required
                maxLength={5000}
              />
            </div>

            <div className={styles.checkboxRow}>
              <Checkbox
                id="style-default"
                checked={form.isDefault}
                onCheckedChange={(checked) => setForm({ ...form, isDefault: checked })}
              />
              <Label htmlFor="style-default" className={styles.fieldLabel}>Set as default style</Label>
            </div>

            <div className={styles.advanced}>
              <button
                type="button"
                className={styles.advancedTrigger}
                aria-expanded={showAdvanced}
                aria-controls="style-advanced-parameters"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                {showAdvanced ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                Advanced parameters
              </button>
              {showAdvanced && (
                <div id="style-advanced-parameters" className={styles.advancedPanel}>
                  <div className={styles.field}>
                    <Label htmlFor="style-temperature" className={styles.fieldLabel}>
                      Temperature ({form.temperature})
                    </Label>
                    <input
                      id="style-temperature"
                      type="range"
                      min="0"
                      max="2"
                      step="0.1"
                      value={form.temperature}
                      onChange={(event) => setForm({ ...form, temperature: parseFloat(event.target.value) })}
                      className={styles.range}
                    />
                  </div>

                  <div className={styles.fieldGrid}>
                    <div className={styles.field}>
                      <span className={styles.fieldLabel}>Detail level</span>
                      <Select
                        value={form.detailLevel || 'medium'}
                        onValueChange={(value) => setForm({ ...form, detailLevel: value as string })}
                      >
                        <SelectTrigger className={styles.selectTrigger} aria-label="Detail level">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className={styles.selectContent}>
                          <SelectItem value="low" className={styles.selectItem}>Concise</SelectItem>
                          <SelectItem value="medium" className={styles.selectItem}>Balanced</SelectItem>
                          <SelectItem value="high" className={styles.selectItem}>Detailed</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className={styles.field}>
                      <span className={styles.fieldLabel}>Result orientation</span>
                      <Select
                        value={form.resultOriented || 'medium'}
                        onValueChange={(value) => setForm({ ...form, resultOriented: value as string })}
                      >
                        <SelectTrigger className={styles.selectTrigger} aria-label="Result orientation">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className={styles.selectContent}>
                          <SelectItem value="low" className={styles.selectItem}>Low</SelectItem>
                          <SelectItem value="medium" className={styles.selectItem}>Medium</SelectItem>
                          <SelectItem value="high" className={styles.selectItem}>High</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <DialogFooter className={styles.dialogFooter}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setDialogOpen(false)}
                disabled={saving}
              >
                Cancel
              </button>
              <button type="submit" className={styles.primaryButton} disabled={saving}>
                {saving ? 'Saving…' : editing ? 'Save' : 'Create'}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SystemPromptTab() {
  const [prompts, setPrompts] = useState<SystemPromptRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const response = await apiFetch('/api/prompts/system')
        if (!response.ok) throw new Error('Failed to load system prompts')
        const data = await response.json()
        if (!cancelled) setPrompts(data.prompts || [])
      } catch {
        if (cancelled) return
        setLoadError('System prompts could not be loaded. Retry to refresh the prompt records.')
        toast.error('Failed to load system prompts')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [reloadToken])

  function startEdit(key: string, currentText: string) {
    setEditingKey(key)
    setEditText(currentText)
  }

  function cancelEdit() {
    setEditingKey(null)
    setEditText('')
  }

  async function saveEdit(key: string) {
    if (savingKey) return
    setSavingKey(key)
    try {
      const response = await apiFetch('/api/prompts/system', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, promptText: editText }),
      })
      if (response.ok) {
        toast.success('Prompt updated')
        setEditingKey(null)
        setLoading(true)
        setLoadError(null)
        setReloadToken((token) => token + 1)
      } else {
        const error = await response.json()
        toast.error((error.error || 'Update failed') + traceSuffix(response))
      }
    } catch {
      toast.error('Update failed')
    } finally {
      setSavingKey(null)
    }
  }

  if (loading) {
    return (
      <div className={styles.loadingState} role="status">
        <span className={styles.loadingLine} aria-hidden="true" />
        <strong>Loading system prompts…</strong>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className={styles.errorState} role="alert">
        <strong>System prompts could not be loaded</strong>
        <p>{loadError}</p>
        <button
          type="button"
          className={styles.stateAction}
          onClick={() => {
            setLoading(true)
            setLoadError(null)
            setReloadToken((token) => token + 1)
          }}
        >
          Retry loading prompts
        </button>
      </div>
    )
  }

  return (
    <div className={styles.systemList}>
      {SYSTEM_PROMPTS.map((prompt) => {
        const savedPrompt = prompts.find((item) => item.key === prompt.key)
        const isEditing = editingKey === prompt.key

        return (
          <section key={prompt.key} className={styles.systemPanel} aria-labelledby={`prompt-${prompt.key}`}>
            <div className={styles.systemHeader}>
              <span className={styles.recordId}>{prompt.key}</span>
              <div className={styles.systemHeading}>
                <h2 id={`prompt-${prompt.key}`}>{prompt.title}</h2>
                <p>
                  {prompt.description}
                  {prompt.variables.length > 0 && (
                    <>
                      {' '}Variables:
                      <span className={styles.variables}>
                        {prompt.variables.map((variable) => <code key={variable}>{variable}</code>)}
                      </span>
                    </>
                  )}
                </p>
              </div>
              {!isEditing && (
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => startEdit(prompt.key, savedPrompt?.promptText || prompt.defaultText)}
                >
                  <Pencil size={14} aria-hidden="true" />
                  Edit
                </button>
              )}
            </div>

            {isEditing ? (
              <div className={styles.dialogBody}>
                <div>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => setEditText(prompt.defaultText)}
                    disabled={savingKey === prompt.key}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    Reset to default
                  </button>
                </div>
                <div className={styles.field}>
                  <Label htmlFor={`prompt-text-${prompt.key}`} className={styles.fieldLabel}>
                    {prompt.title} text
                  </Label>
                  <textarea
                    id={`prompt-text-${prompt.key}`}
                    className={`${styles.textarea} ${styles.promptEditor}`}
                    value={editText}
                    onChange={(event) => setEditText(event.target.value)}
                    maxLength={10000}
                    disabled={savingKey === prompt.key}
                  />
                </div>
                <div className={styles.formActions}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={cancelEdit}
                    disabled={savingKey === prompt.key}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={() => void saveEdit(prompt.key)}
                    disabled={savingKey === prompt.key}
                  >
                    {savingKey === prompt.key ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            ) : (
              <pre
                className={styles.promptPreview}
                tabIndex={0}
                role="region"
                aria-label={`${prompt.title} preview`}
              >
                {savedPrompt?.promptText || 'No saved prompt. Select Edit to start from the default.'}
              </pre>
            )}
          </section>
        )
      })}
    </div>
  )
}
