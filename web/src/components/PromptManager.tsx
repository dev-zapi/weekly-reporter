import { useEffect, useState } from 'react'
import { Pencil, RotateCcw } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { TabsContent } from '@/components/ui/tabs'
import { Label } from '@/components/ui/label'
import { apiFetch, traceSuffix } from '@/lib/api-client'
import type { SystemPromptRow } from '@/lib/db/schema'
import { AIStyleWorkbench } from './AIStyleWorkbench'
import { PromptHeader, PromptTabs, type PromptTab } from './PromptChrome'
import styles from './library-configuration.module.css'

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

export function PromptManager() {
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab: PromptTab = searchParams.get('tab') === 'system' ? 'system' : 'styles'

  function changeTab(tab: PromptTab) {
    const params = new URLSearchParams(searchParams)
    params.set('tab', tab)
    if (tab === 'system') params.delete('style')
    setSearchParams(params)
  }

  if (activeTab === 'styles') {
    return <AIStyleWorkbench activeTab={activeTab} onTabChange={changeTab} />
  }

  return (
    <section className={styles.surface} aria-labelledby="prompt-library-title">
      <PromptHeader />
      <PromptTabs activeTab={activeTab} onChange={changeTab}>
        <TabsContent value="system" className={styles.tabContent}>
          <SystemPromptTab />
        </TabsContent>
      </PromptTabs>
    </section>
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
