'use client'
import { apiFetch, traceSuffix } from '@/lib/api-client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Pencil, Trash2, Plus, Star, RotateCcw } from 'lucide-react'
import type { AIStyleRow, SystemPromptRow } from '@/lib/db/schema'
import { useAIStyles } from './useAIStyles'
import type { StyleFormData } from './useAIStyles'

const RANDOM_WORDS = [
  'nova', 'apex', 'zen', 'flux', 'core', 'sage', 'echo', 'pulse',
  'spark', 'wave', 'beam', 'dash', 'glow', 'prism', 'forge', 'rift',
  'swift', 'crisp', 'pure', 'bold', 'keen', 'vivid', 'calm', 'dusk',
]

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

/** 生成新的随机 key */
function regenerateKey(form: StyleFormData, setForm: (f: StyleFormData) => void) {
  setForm({ ...form, key: randomWord() })
}

export function PromptManager() {
  const [activeTab, setActiveTab] = useState<'styles' | 'system'>('styles')

  return (
    <div>
      <div className="flex gap-4 mb-6 border-b">
        <button
          className={`pb-2 px-1 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'styles'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('styles')}
        >
          Style management
        </button>
        <button
          className={`pb-2 px-1 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'system'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setActiveTab('system')}
        >
          System prompts
        </button>
      </div>

      {activeTab === 'styles' ? <StyleTab /> : <SystemPromptTab />}
    </div>
  )
}

/** ==================== 风格管理 Tab ==================== */

function StyleTab() {
  const { styles, loading, create, update, remove, setDefault } = useAIStyles()
  const [editing, setEditing] = useState<AIStyleRow | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  // Keep the server-rendered initial form deterministic. Random keys are only
  // generated after the user opens the create dialog in the browser.
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const payload = {
      ...form,
      detailLevel: form.detailLevel || undefined,
      resultOriented: form.resultOriented || undefined,
    } as StyleFormData

    const ok = editing
      ? await update(editing.id, payload)
      : await create(payload)

    if (ok) {
      setDialogOpen(false)
    }
  }

  async function handleDelete(style: AIStyleRow) {
    if (!confirm(`Delete style “${style.label}”?`)) return
    await remove(style.id)
  }

  async function handleSetDefault(style: AIStyleRow) {
    await setDefault(style.id)
  }

  if (loading) return <div className="text-center py-8 text-muted-foreground">Loading...</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-muted-foreground">
          {styles.length} styles
        </p>
        <Button size="sm" onClick={openCreate}>
          <Plus className="w-4 h-4 mr-1" />
          New style
        </Button>
      </div>

      {styles.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No styles yet. Click the button above to create one.
        </div>
      ) : (
        <div className="space-y-2">
          {styles.map((style) => (
            <div
              key={style.id}
              className="flex items-center justify-between p-4 rounded-lg border bg-card"
            >
              <div className="flex-1 min-w-0 mr-4">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{style.label}</span>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{style.key}</code>
                  {style.isDefault && (
                    <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                      Default
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1 truncate">
                  {style.systemPrompt.slice(0, 60)}...
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!style.isDefault && (
                  <Button size="icon" variant="ghost" title="Set as default" onClick={() => handleSetDefault(style)}>
                    <Star className="w-4 h-4" />
                  </Button>
                )}
                <Button size="icon" variant="ghost" onClick={() => openEdit(style)}>
                  <Pencil className="w-4 h-4" />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => handleDelete(style)}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* New/edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit style' : 'New style'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="skey">Identifier (key)</Label>
                <div className="flex gap-1">
                  <Input
                    id="skey"
                    value={form.key}
                    onChange={(e) => setForm({ ...form, key: e.target.value })}
                    pattern="^[a-z][a-z0-9_\-]*$"
                    required
                    className="font-mono text-sm flex-1"
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    title="Generate randomly"
                    onClick={() => regenerateKey(form, setForm)}
                  >
                    <RotateCcw className="w-4 h-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="slabel">Name</Label>
                <Input
                  id="slabel"
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  required
                  maxLength={50}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="sprompt">System Prompt</Label>
              <Textarea
                id="sprompt"
                value={form.systemPrompt}
                onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                required
                maxLength={5000}
                className="font-mono text-sm min-h-[200px]"
              />
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                checked={form.isDefault}
                onCheckedChange={(v) => setForm({ ...form, isDefault: v })}
              />
              <Label>Set as default style</Label>
            </div>

            {/* Advanced parameters */}
            <div>
              <button
                type="button"
                className="text-sm text-muted-foreground hover:text-foreground"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                {showAdvanced ? '▾' : '▸'} Advanced parameters
              </button>
              {showAdvanced && (
                <div className="mt-3 space-y-4 pl-2 border-l-2 border-muted">
                  <div className="space-y-2">
                    <Label>Temperature ({form.temperature})</Label>
                    <input
                      type="range"
                      min="0"
                      max="2"
                      step="0.1"
                      value={form.temperature}
                      onChange={(e) => setForm({ ...form, temperature: parseFloat(e.target.value) })}
                      className="w-full"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-xs">Detail level</Label>
                      <Select
                        value={form.detailLevel || 'medium'}
                        onValueChange={(v) => setForm({ ...form, detailLevel: v as string })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="low">Concise</SelectItem>
                          <SelectItem value="medium">Balanced</SelectItem>
                          <SelectItem value="high">Detailed</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs">Result orientation</Label>
                      <Select
                        value={form.resultOriented || 'medium'}
                        onValueChange={(v) => setForm({ ...form, resultOriented: v as string })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="low">Low</SelectItem>
                          <SelectItem value="medium">Medium</SelectItem>
                          <SelectItem value="high">High</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">{editing ? 'Save' : 'Create'}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** ==================== 系统提示词 Tab ==================== */

function SystemPromptTab() {
  const [prompts, setPrompts] = useState<SystemPromptRow[]>([])
  const [loading, setLoading] = useState(true)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

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

  const DEFAULT_SCORE = `You are a weekly report scoring expert. Score the report below and provide suggestions.

Report content:
{{content}}

Score these dimensions (0-100):
1. structure: whether all sections are complete
2. content: whether the report includes concrete details and data
3. value: whether results and contributions are emphasized

Return:
1. A score for each dimension
2. Specific improvement suggestions (no more than 30 words each)
3. An optional rewrite example`

  async function fetchPrompts() {
    try {
      const res = await apiFetch('/api/prompts/system')
      const data = await res.json()
      setPrompts(data.prompts || [])
    } catch {
      toast.error('Failed to load system prompts')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchPrompts() }, [])

  function startEdit(key: string, currentText: string) {
    setEditingKey(key)
    setEditText(currentText)
  }

  function cancelEdit() {
    setEditingKey(null)
    setEditText('')
  }

  async function saveEdit(key: string) {
    try {
      const res = await apiFetch('/api/prompts/system', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, promptText: editText }),
      })
      if (res.ok) {
        toast.success('Prompt updated')
        setEditingKey(null)
        fetchPrompts()
      } else {
        const err = await res.json()
        toast.error((err.error || 'Update failed') + traceSuffix(res))
      }
    } catch {
      toast.error('Update failed')
    }
  }

  function resetToDefault(key: string) {
    const def = key === 'check' ? DEFAULT_CHECK : DEFAULT_SCORE
    setEditText(def)
  }

  function getPromptByKey(key: string) {
    return prompts.find((p) => p.key === key)
  }

  if (loading) return <div className="text-center py-8 text-muted-foreground">Loading...</div>

  const checkPrompt = getPromptByKey('check')
  const scorePrompt = getPromptByKey('score')

  return (
    <div className="space-y-6">
      {/* 写作建议 */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-medium">Writing suggestions prompt</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Checks report content in real time and provides suggestions. Variables:
              <code className="bg-muted px-1 rounded">{'{{content}}'}</code>
              <code className="bg-muted px-1 rounded ml-1">{'{{section}}'}</code>
            </p>
          </div>
          {editingKey !== 'check' && (
            <Button size="sm" variant="outline" onClick={() => startEdit('check', checkPrompt?.promptText || DEFAULT_CHECK)}>
              <Pencil className="w-4 h-4 mr-1" />
              Edit
            </Button>
          )}
        </div>

        {editingKey === 'check' ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => resetToDefault('check')}
              >
                <RotateCcw className="w-4 h-4 mr-1" />
                Reset to default
              </Button>
            </div>
            <Textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              maxLength={10000}
              className="font-mono text-sm min-h-[400px]"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={cancelEdit}>Cancel</Button>
              <Button size="sm" onClick={() => saveEdit('check')}>Save</Button>
            </div>
          </div>
        ) : (
          <pre className="text-sm text-muted-foreground whitespace-pre-wrap bg-muted/50 rounded p-3 max-h-48 overflow-y-auto">
            {checkPrompt?.promptText || 'Loading...'}
          </pre>
        )}
      </div>

      {/* 评分提示词 */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-medium">Report scoring prompt</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Scores complete reports across multiple dimensions. Variables:
              <code className="bg-muted px-1 rounded">{'{{content}}'}</code>
            </p>
          </div>
          {editingKey !== 'score' && (
            <Button size="sm" variant="outline" onClick={() => startEdit('score', scorePrompt?.promptText || DEFAULT_SCORE)}>
              <Pencil className="w-4 h-4 mr-1" />
              Edit
            </Button>
          )}
        </div>

        {editingKey === 'score' ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => resetToDefault('score')}
              >
                <RotateCcw className="w-4 h-4 mr-1" />
                Reset to default
              </Button>
            </div>
            <Textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              maxLength={10000}
              className="font-mono text-sm min-h-[350px]"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={cancelEdit}>Cancel</Button>
              <Button size="sm" onClick={() => saveEdit('score')}>Save</Button>
            </div>
          </div>
        ) : (
          <pre className="text-sm text-muted-foreground whitespace-pre-wrap bg-muted/50 rounded p-3 max-h-48 overflow-y-auto">
            {scorePrompt?.promptText || 'Loading...'}
          </pre>
        )}
      </div>
    </div>
  )
}
