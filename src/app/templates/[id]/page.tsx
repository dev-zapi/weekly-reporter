'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { StyleSelector } from '@/components/StyleSelector'
import { TemplateForm } from '@/components/TemplateForm'
import { apiFetch, traceSuffix } from '@/lib/api-client'
import type { AIStyle, Template } from '@/lib/db/schema'
import styles from '@/components/library-configuration.module.css'

async function templateError(response: Response, fallback: string) {
  try {
    const data = await response.json()
    return `${data.error || fallback}${traceSuffix(response)}`
  } catch {
    return `${fallback}${traceSuffix(response)}`
  }
}

export default function EditTemplatePage() {
  const router = useRouter()
  const params = useParams()
  const id = params.id as string

  const [template, setTemplate] = useState<Template | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [aiStyle, setAiStyle] = useState<AIStyle>('formal')
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const response = await apiFetch(`/api/templates/${id}`)
        if (!response.ok) {
          throw new Error(await templateError(response, 'Template not found'))
        }
        const data = await response.json()
        if (cancelled) return
        setTemplate(data.template)
        setAiStyle(data.template.aiStyle || 'formal')
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : 'Failed to load template'
        setLoadError(message)
        toast.error(message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [id, reloadToken])

  async function handleStyleChange(style: AIStyle) {
    const previousStyle = aiStyle
    setAiStyle(style)

    try {
      const response = await apiFetch(`/api/templates/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiStyle: style }),
      })

      if (response.ok) {
        toast.success('AI style updated')
      } else {
        const error = await response.json()
        toast.error((error.error || 'Update failed') + traceSuffix(response))
        setAiStyle(previousStyle)
      }
    } catch {
      toast.error('Update failed')
      setAiStyle(previousStyle)
    }
  }

  async function handleSave(data: {
    name: string
    content: string
    description?: string
    tags?: string
  }) {
    const response = await apiFetch(`/api/templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })

    if (response.ok) {
      router.push('/templates')
    } else {
      const error = await response.json()
      toast.error((error.error || 'Update failed') + traceSuffix(response))
      throw new Error('Update failed')
    }
  }

  return (
    <section className={styles.surface} aria-labelledby="edit-template-title">
      <Link href="/templates" className={styles.backLink}>
        <ArrowLeft size={14} aria-hidden="true" />
        Back to templates
      </Link>
      <header className={styles.pageHeading}>
        <div className={styles.headingText}>
          <div className={styles.titleRow}>
            <h1 id="edit-template-title">Edit Template</h1>
            <span className={styles.recordRef}>T{id}</span>
          </div>
          <p className={styles.description}>
            {template ? template.name : 'Update the template record and its report-writing style.'}
          </p>
        </div>
      </header>

      {loading ? (
        <div className={styles.loadingState} role="status">
          <span className={styles.loadingLine} aria-hidden="true" />
          <strong>Loading template…</strong>
        </div>
      ) : loadError ? (
        <div className={styles.errorState} role="alert">
          <strong>Template could not be loaded</strong>
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
            Retry loading template
          </button>
        </div>
      ) : !template ? (
        <div className={styles.emptyState}>
          <strong>Template not found</strong>
          <p>Return to the template index and choose an available personal template.</p>
        </div>
      ) : (
        <div className={styles.editLayout}>
          <div className={styles.editMain}>
            <TemplateForm
              template={template}
              onSave={handleSave}
              onCancel={() => router.push('/templates')}
            />
          </div>
          <aside className={styles.contextRail} aria-labelledby="template-style-title">
            <h2 id="template-style-title">Generation style</h2>
            <p>Select the AI style applied when this template is used for final generation.</p>
            <StyleSelector value={aiStyle} onChange={handleStyleChange} />
          </aside>
        </div>
      )}
    </section>
  )
}
